import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeReview,
  planBackgroundRefresh,
  adoptPendingRefresh,
  reportRevision,
  createRefreshGate,
  NO_SELECTED_CASE,
  reviewRows,
} from '../lib/live-refresh.mjs';

const proposal = (id, extra = {}) => ({
  id, key: id, version: id, title: id, city: 'Example', state: 'OH',
  kind: 'ambiguous', status: 'pending', facility: { source_url: id },
  options: [{ id: 'one' }, { id: 'two' }], ...extra,
});
const state = (proposals, extra = {}) => ({
  proposals, runs: [], decisions: [], audits: [], ...extra,
});
const position = { view: 'queue', filter: 'all', search: '', selected: '' };

test('latest resolved case is selected for facilities and incoming review while full decision history stays ordered', () => {
  const rejected = proposal('newer-rejection', { key: 'same', current: false, status: 'rejected' });
  const applied = proposal('older-approved-later', { key: 'same', current: true, status: 'applied' });
  const incoming = state([rejected, applied]);
  assert.deepEqual(reviewRows(incoming, { ...position, view: 'facilities' }), [applied]);
  assert.deepEqual(reviewRows(incoming, { ...position, view: 'history' }), [rejected, applied]);
  const before = state([{ ...applied, status: 'pending' }]);
  const next = adoptPendingRefresh(before, incoming, position, { proposalId: applied.id, note: 'Keep my note', option: 'one' });
  assert.equal(next.selected, applied.id);
  assert.equal(next.input.note, 'Keep my note');
});

test('new outside proposals and runs refresh without moving the visible fallback case or changing its draft', () => {
  const current = state([proposal('active')]);
  const incoming = state([proposal('new-first'), ...current.proposals], {
    runs: [{ id: 'daily', status: 'complete' }],
  });
  const input = { proposalId: 'active', note: 'Verify the street number', option: 'two' };
  const plan = planBackgroundRefresh(current, incoming, position);
  assert.deepEqual(plan, { hold: false, selected: 'active' });
  assert.equal(activeReview(incoming, { ...position, selected: plan.selected }).id, 'active');
  assert.deepEqual(adoptPendingRefresh(current, incoming, position, input).input, input);
});

test('material changes and outside decisions hold the displayed case until explicitly loaded', () => {
  const current = state([proposal('active'), proposal('other')]);
  const original = structuredClone(current);
  for (const incoming of [
    state([proposal('replacement', { key: 'active' }), proposal('other')]),
    state([proposal('active', { status: 'applied' }), proposal('other')]),
    state([proposal('active', { options: [{ id: 'changed' }] }), proposal('other')]),
    state(current.proposals, { decisions: [{ id: 'new', proposal_id: 'active' }] }),
  ]) {
    assert.equal(planBackgroundRefresh(current, incoming, position).hold, true);
    assert.equal(activeReview(current, position).id, 'active');
  }
  assert.deepEqual(current, original, 'Planning cannot mutate displayed evidence or notes');
});

test('loading a revised case preserves typed rationale but requires a fresh survivor selection', () => {
  const current = state([proposal('old')]);
  const incoming = state([proposal('new', { key: 'old' })]);
  const input = { proposalId: 'old', note: 'The billing team confirmed this location.', option: 'two' };
  const result = adoptPendingRefresh(current, incoming, position, input);
  assert.equal(result.selected, 'new');
  assert.equal(result.view, 'queue');
  assert.deepEqual(result.input, { ...input, proposalId: 'new', option: '' });
  assert.equal(input.option, 'two', 'The held draft remains untouched until adoption');
});

test('an outside completed decision follows the same website or manual case rather than the next queue item', () => {
  for (const manual of [false, true]) {
    const current = state([proposal('active', { manual, facility: manual ? null : {} }), proposal('other')]);
    const incoming = state(current.proposals.map((p) => p.id === 'active' ? { ...p, status: 'applied' } : p));
    const next = adoptPendingRefresh(current, incoming, position, { proposalId: 'active', note: 'My note', option: 'one' });
    assert.equal(next.selected, 'active');
    assert.equal(next.view, manual ? 'history' : 'facilities');
    assert.equal(activeReview(incoming, next).id, 'active');
    assert.equal(next.input.note, 'My note');
  }
});

test('a removed case stays unselected after loading, instead of silently selecting another approval', () => {
  const current = state([proposal('gone'), proposal('other')]);
  const incoming = state([proposal('other')]);
  assert.equal(planBackgroundRefresh(current, incoming, position).hold, true);
  const next = adoptPendingRefresh(current, incoming, position, { proposalId: 'gone', note: 'Preserved text', option: '' });
  assert.equal(next.selected, NO_SELECTED_CASE);
  assert.equal(next.missing, true);
  assert.equal(next.input.note, 'Preserved text');
  assert.equal(activeReview(incoming, next), undefined);
  assert.equal(activeReview(incoming, { ...next, selected: 'other' }).id, 'other');
});

test('read-only views adopt external source results without inventing an active review', () => {
  for (const view of ['locations', 'crm', 'operations', 'runs', 'method']) {
    const current = state([proposal('old')]);
    const incoming = state([proposal('new')]);
    const viewPosition = { ...position, view, selected: 'old' };
    assert.equal(planBackgroundRefresh(current, incoming, viewPosition).hold, false);
    assert.equal(activeReview(current, viewPosition), undefined);
  }
});

test('reports invalidate for outside decisions and operation progress even without a new source run', () => {
  const current = state([proposal('active')], { runs: [{ id: 'run', status: 'complete' }] });
  const revision = reportRevision(current, 60000);
  assert.equal(reportRevision(structuredClone(current), 65000), revision);
  for (const incoming of [
    { ...current, decisions: [{ id: 'decided' }] },
    { ...current, audits: [{ id: 'operation-verified' }] },
    { ...current, proposals: [proposal('active', { status: 'partial' })] },
  ]) assert.notEqual(reportRevision(incoming, 60000), revision);
  assert.equal(reportRevision(current, 120000), revision);
  const captured = Date.parse('2026-10-10T12:00:00Z');
  const saved = { ...current, website: {
    collected_at: new Date(captured).toISOString(), coverage: { complete: true },
  } };
  const fresh = reportRevision(saved, captured);
  assert.equal(reportRevision(saved, captured + 25 * 60 * 60 * 1000), fresh);
  assert.equal(reportRevision(saved, captured + 26 * 60 * 60 * 1000), fresh);
  assert.notEqual(reportRevision(saved, captured + (26 * 60 * 60 + 1) * 1000), fresh);
});

test('delayed background reads cannot overwrite mutation acknowledgements or a newer read', () => {
  const gate = createRefreshGate();
  const before = gate.read();
  assert(gate.current(before));
  gate.beginMutation();
  assert(gate.mutating);
  assert(!gate.current(before));
  const ownRead = gate.read();
  assert(gate.current(ownRead));
  gate.endMutation();
  assert(!gate.mutating);
  assert(!gate.current(before));
  assert(!gate.current(ownRead));
  const older = gate.read();
  const newer = gate.read();
  assert(!gate.current(older));
  assert(gate.current(newer));
  gate.beginMutation();
  gate.beginMutation();
  gate.endMutation();
  assert(gate.mutating, 'A second request finishing cannot release an earlier mutation');
  gate.endMutation();
  assert(!gate.mutating);
});
