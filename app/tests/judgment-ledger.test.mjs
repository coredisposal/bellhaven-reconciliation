import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };
import { reconcile } from '../lib/core.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { runPipeline, decide } from '../lib/engine.mjs';
import { operationalReport } from '../lib/reporting.mjs';
import { reviewState } from '../lib/state.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';

const copy = (value) => structuredClone(value);
const identity = { actor: 'test reviewer', session: 'judgment-ledger' };
const input = (p, option, action = 'approve') => ({
  id: p.id, version: p.version, action, optionId: option?.id,
  note: 'Verified the physical facility and reviewed the selected identity resolution.',
});

function setup(t, billing = false) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) => f.endsWith('.sql')))
    db.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const d1 = sqliteD1(db), ledger = new Ledger(d1);
  const facility = copy(baseline.facilities.find((f) => f.name === 'Amberly Manor'));
  const original = copy(baseline.accounts.find((a) => a.name === 'Amberly Manor'));
  // Keep corroborating identity evidence and a conflicting street, even after
  // a reviewer deliberately creates a separate facility account.
  Object.assign(original, {
    billing_city: facility.city, billing_state: facility.state, phone: facility.phone_raw,
    lifetime_revenue: billing ? 1000 : 0, outstanding_ar: billing ? 50 : 0,
  });
  const parents = baseline.accounts.filter((a) =>
    a.account_id === original.parent_id || /^Bellhaven Senior Living \(Parent Account\)$/i.test(a.name));
  const data = {
    ...copy(baseline),
    accounts: [...copy(parents), original],
    contacts: copy(baseline.contacts.filter((c) => c.account_id === original.account_id)),
    facilities: [facility],
    coverage: { ...copy(baseline.coverage), expected: 1, found: 1 },
  };
  const writes = [];
  const client = {
    accounts: async () => copy(data.accounts),
    get: async (id) => copy(data.accounts.find((a) => a.account_id === id)),
    patch: async (id, fields) => {
      writes.push({ type: 'patch', id, fields: copy(fields) });
      const a = data.accounts.find((row) => row.account_id === id);
      Object.assign(a, fields);
      return copy(a);
    },
    create: async (fields) => {
      const account = {
        ...copy(fields), account_id: `created-${data.accounts.length}`,
        chow_current_account: '', duplicate_of_account: '',
      };
      writes.push({ type: 'create', id: account.account_id, fields: copy(fields) });
      data.accounts.push(account);
      return copy(account);
    },
  };
  return { db, d1, ledger, data, writes, client, original, getSnapshot: async () => copy(data) };
}
const row = async (s) => (await reconcile(s.data)).find((p) => p.title === 'Amberly Manor');
const saved = (s, id) => {
  const result = s.db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
  return { ...result, data: JSON.parse(result.data) };
};
async function approve(s, p, choice) {
  assert(choice, 'Expected a stored reviewer resolution');
  return decide(s.ledger, s.client, s.getSnapshot, input(p, choice), identity);
}
async function assertChowContactFollowupClosed(s, p) {
  const key = `quality:retired-contacts:${s.original.account_id}`;
  const beforeContacts = copy(s.data.contacts), beforeWrites = copy(s.writes);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 1);
  const state = await reviewState(s.ledger, 'live');
  const original = state.proposals.find((proposal) => proposal.id === p.id);
  assert.equal(original.status, 'applied');
  assert.equal(original.current, true, 'The original CHOW decision remains closed');
  assert.deepEqual(state.proposals.filter((proposal) => proposal.current && proposal.status === 'pending').map((proposal) => proposal.key), [key]);
  const followup = state.proposals.find((proposal) => proposal.key === key);
  assert.equal(followup.kind, 'crm_quality');
  assert.equal(followup.quality.category, 'retired_contact');
  assert.deepEqual(followup.quality.contacts.filter((c) => c.account_id === s.original.account_id).map((c) => c.contact_id), beforeContacts.filter((c) => c.account_id === s.original.account_id).map((c) => c.contact_id));
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0, 'The follow-up is offered once');
  const acknowledge = followup.options.find((option) => option.id === 'acknowledge');
  assert.deepEqual(acknowledge.operations, []);
  await approve(s, followup, acknowledge);
  s.ledger = new Ledger(s.d1);
  for (let i = 0; i < 2; i++) assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  const after = await reviewState(s.ledger, 'live');
  for (const id of [p.id, followup.id]) {
    const proposal = after.proposals.find((item) => item.id === id);
    assert.equal(proposal.status, 'applied');
    assert.equal(proposal.current, true);
  }
  assert.deepEqual(s.writes, beforeWrites, 'Acknowledgement makes no CRM writes');
  assert.deepEqual(s.data.contacts, beforeContacts, 'Contact migration remains outside CHOW approval');
}

test('judgment: a separate-account decision stays closed across reruns and is visible in the shared state and report', async (t) => {
  const s = setup(t), before = copy(s.original);
  await runPipeline(s.ledger, s.getSnapshot);
  const p = await row(s);
  await approve(s, p, p.options.find((o) => o.resolution === 'separate'));
  assert.deepEqual(s.original, before, 'Separate means every existing field stays unchanged');
  assert.equal(s.writes.length, 1);
  const current = await row(s);
  assert.equal(current.kind, 'ambiguous', 'The source conflict still needs a durable reviewer resolution');
  assert.notEqual(current.version, p.version);
  assert.equal(saved(s, p.id).data.resolution_evidence_version, current.version);
  s.ledger = new Ledger(s.d1);
  s.data.accounts.reverse();
  s.data.contacts.reverse();
  for (let i = 0; i < 2; i++) {
    const run = await runPipeline(s.ledger, s.getSnapshot);
    assert.equal(run.new_proposals, 0);
    assert.equal(saved(s, p.id).run_id, run.id);
  }
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.proposals.length, 1);
  assert.equal(state.proposals[0].id, p.id);
  assert.equal(state.proposals[0].status, 'applied');
  assert.equal(state.website.facilities[0].source_url, state.proposals[0].key);
  const report = await operationalReport(s.d1);
  assert.equal(report.current.missing_ledger_rows, 0);
  assert.equal(report.current.applied, 1);
  assert.equal(report.history.verified_applied_cases, 1);
  assert.equal(s.writes.length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audits WHERE event='identity_resolution_verified'").get().n, 1);
});

test('judgment: material changes reopen review and only the latest approved resolution can suppress it', async (t) => {
  const s = setup(t);
  await runPipeline(s.ledger, s.getSnapshot);
  const first = await row(s);
  await approve(s, first, first.options.find((o) => o.resolution === 'separate'));
  const firstAfter = copy(s.data), firstHash = (await row(s)).version;
  s.data.facilities[0].postal_code = '44237';
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 1);
  const second = await row(s);
  assert.notEqual(second.version, firstHash);
  const created = s.data.accounts.find((a) => a.account_id.startsWith('created-'));
  await approve(s, second, second.options.find((o) => o.account_id === created.account_id));
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  // A rollback to an older accepted state is still a change since the most
  // recent decision. An older matching hash must never hide that change.
  Object.assign(s.data, firstAfter);
  assert.equal((await row(s)).version, firstHash);
  const reverted = await runPipeline(s.ledger, s.getSnapshot);
  assert.equal(reverted.new_proposals, 1);
  const pending = s.db.prepare("SELECT * FROM proposals WHERE case_key=? AND status='pending'").all(first.key);
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].id, first.id);
  assert.notEqual(pending[0].id, second.id);
  assert.equal(saved(s, first.id).status, 'applied');
  assert.equal(saved(s, second.id).status, 'applied');
});

test('judgment: selecting an existing account applies its exact correction and preserves revenue and contacts', async (t) => {
  const s = setup(t), contacts = copy(s.data.contacts);
  await runPipeline(s.ledger, s.getSnapshot);
  const p = await row(s), choice = p.options.find((o) => o.resolution === 'existing');
  await approve(s, p, choice);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].type, 'patch');
  assert.equal(s.original.account_id, choice.account_id);
  assert.equal(s.original.parent_id, p.parent.account_id);
  assert.equal(s.original.billing_street, p.facility.street_address);
  assert.equal(s.original.lifetime_revenue, 0);
  assert.equal(s.original.outstanding_ar, 0);
  assert.deepEqual(s.data.contacts, contacts);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  assert.equal((await operationalReport(s.d1)).current.applied, 1);
});

test('judgment: existing-account resolution with revenue and AR uses CHOW and preserves the old account', async (t) => {
  const s = setup(t, true), before = copy(s.original), contacts = copy(s.data.contacts);
  await runPipeline(s.ledger, s.getSnapshot);
  const p = await row(s), choice = p.options.find((o) => o.resolution === 'existing');
  assert.equal(choice.operations[0].type, 'chow');
  await approve(s, p, choice);
  const target = s.data.accounts.find((a) => a.account_id === s.original.chow_current_account);
  assert(target);
  assert.deepEqual(s.original, { ...before, chow_current_account: target.account_id });
  assert.equal(target.parent_id, p.parent.account_id);
  assert.equal(target.lifetime_revenue, 0);
  assert.equal(target.outstanding_ar, 0);
  assert.deepEqual(s.data.contacts, contacts);
  assert.equal(s.writes.length, 2);
  assert.deepEqual(s.writes[1].fields, { chow_current_account: target.account_id });
  await assertChowContactFollowupClosed(s, p);
  assert.equal(s.writes.length, 2);
});

test('judgment: original ordinary-correction rollback semantics still require a fresh approval', async (t) => {
  const s = setup(t);
  Object.assign(s.original, {
    parent_id: s.data.accounts.find((a) => /^Bellhaven Senior Living/.test(a.name)).account_id,
    billing_street: s.data.facilities[0].street_address,
    billing_zip: '99999',
  });
  await runPipeline(s.ledger, s.getSnapshot);
  const p = await row(s);
  assert.notEqual(p.kind, 'ambiguous');
  assert(!p.options[0].resolution);
  const before = copy(s.original);
  await approve(s, p, p.options[0]);
  assert(!saved(s, p.id).data.resolution_evidence_version);
  Object.assign(s.original, before);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 1);
  const pending = s.db.prepare("SELECT data FROM proposals WHERE status='pending' AND case_key=?").get(p.key);
  assert(pending);
  const revision = JSON.parse(pending.data);
  assert.equal(revision.revision_of, p.id);
  assert.notEqual(revision.id, p.id);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
});

test('judgment: a failed resolution publication resumes the existing verified operation without another creation', async (t) => {
  const s = setup(t);
  await runPipeline(s.ledger, s.getSnapshot);
  const p = await row(s), choice = p.options.find((o) => o.resolution === 'separate');
  const batch = s.ledger.batch.bind(s.ledger);
  let fail = true;
  s.ledger.batch = async (statements) => {
    if (fail && statements.some((statement) => statement.includes('identity_resolution_verified'))) {
      fail = false;
      throw new Error('Injected resolution publication failure');
    }
    return batch(statements);
  };
  await assert.rejects(approve(s, p, choice), /resolution publication failure/);
  assert.equal(saved(s, p.id).status, 'partial');
  assert(!saved(s, p.id).data.resolution_evidence_version);
  assert.equal(s.writes.length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audits WHERE event='identity_resolution_verified'").get().n, 0);
  s.ledger = new Ledger(s.d1);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  await decide(s.ledger, s.client, s.getSnapshot, input(p, choice, 'resume'), identity);
  assert.equal(saved(s, p.id).status, 'applied');
  assert.equal(saved(s, p.id).data.resolution_evidence_version, (await row(s)).version);
  assert.equal(s.writes.length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE action='approve'").get().n, 1);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
});

function duplicateSetup(t, billing = false) {
  const s = setup(t, billing);
  const f = s.data.facilities[0];
  const parent = s.data.accounts.find((a) => /^Bellhaven Senior Living/.test(a.name));
  Object.assign(s.original, {
    billing_street: f.street_address, billing_city: f.city, billing_state: f.state,
    billing_zip: f.postal_code, care_type: 'Assisted Living',
    ...(billing ? {} : { parent_id: parent.account_id }),
  });
  s.data.accounts.push({
    ...copy(s.original), account_id: 'other-copy', name: 'Former Care Campus',
    parent_id: parent.account_id, lifetime_revenue: 0, outstanding_ar: 0,
  });
  return s;
}

test('judgment: update-only duplicate choice requires a note, preserves other copies, and stays decided on reruns', async (t) => {
  const s = duplicateSetup(t);
  const other = copy(s.data.accounts.find((a) => a.account_id === 'other-copy'));
  const contacts = copy(s.data.contacts);
  await runPipeline(s.ledger, s.getSnapshot);
  const p = await row(s);
  assert.equal(p.kind, 'duplicate');
  const choice = p.options.find((o) => o.resolution === 'existing');
  assert(choice);
  assert.equal(choice.operations.length, 1);
  assert.equal(choice.operations[0].type, 'patch');
  await assert.rejects(decide(s.ledger, s.client, s.getSnapshot,
    { ...input(p, choice), note: '' }, identity), /Explain your resolution choice/);
  assert.equal(saved(s, p.id).status, 'pending');
  assert.equal(s.writes.length, 0);
  await approve(s, p, choice);
  assert.equal(s.writes.length, 1);
  assert.deepEqual(s.data.accounts.find((a) => a.account_id === 'other-copy'), other);
  assert.deepEqual(s.data.contacts, contacts);
  assert.equal(saved(s, p.id).data.resolution_evidence_version, (await row(s)).version);
  s.ledger = new Ledger(s.d1);
  for (let i = 0; i < 2; i++)
    assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  assert.equal((await operationalReport(s.d1)).current.applied, 1);
  s.data.facilities[0].postal_code = '44237';
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 1);
  assert.equal(saved(s, p.id).status, 'applied', 'Old decision stays in history');
});

test('judgment: update-only option for a billing survivor follows CHOW and never retires the other copy', async (t) => {
  const s = duplicateSetup(t, true);
  const original = copy(s.original);
  const other = copy(s.data.accounts.find((a) => a.account_id === 'other-copy'));
  await runPipeline(s.ledger, s.getSnapshot);
  const p = await row(s);
  assert.equal(p.kind, 'chow');
  const choice = p.options.find((o) => o.resolution === 'existing');
  assert(choice);
  assert.equal(choice.operations.length, 1);
  assert.equal(choice.operations[0].type, 'chow');
  await approve(s, p, choice);
  assert.equal(s.writes.length, 2);
  assert.deepEqual(s.original, { ...original, chow_current_account: s.writes[0].id });
  assert.deepEqual(s.writes[1].fields, { chow_current_account: s.writes[0].id });
  assert.deepEqual(s.data.accounts.find((a) => a.account_id === 'other-copy'), other);
  await assertChowContactFollowupClosed(s, p);
});
