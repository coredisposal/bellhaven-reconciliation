import test from 'node:test';
import assert from 'node:assert/strict';
import baseline from '../fixtures/baseline.json' with { type: 'json' };
import { reconcile } from '../lib/core.mjs';
import { reviewContext, formatBalance } from '../lib/case-context.mjs';

const cases = await reconcile(structuredClone(baseline));
const named = (name) => {
  const proposal = cases.find((proposal) => proposal.title === name);
  assert(proposal, name);
  return { ...proposal, status: proposal.kind === 'unchanged' ? 'unchanged' : 'pending' };
};
const first = (proposal) => proposal.options[0]?.id ?? '';

test('all 35 facilities and three absences have readable context for every offered resolution without mutations', () => {
  assert.equal(cases.length, 38);
  const before = structuredClone(cases);
  for (const saved of cases) {
    const proposal = { ...saved, status: saved.kind === 'unchanged' ? 'unchanged' : 'pending' };
    for (const id of ['', 'reject', ...proposal.options.map((option) => option.id)]) {
      const context = reviewContext(proposal, id);
      assert.deepEqual(Object.keys(context).sort(), ['attention', 'evidence', 'outcome', 'outcomeLabel', 'reason', 'statusNotice']);
      for (const key of ['reason', 'evidence', 'outcome', 'outcomeLabel']) {
        assert.equal(typeof context[key], 'string');
        assert(context[key].length > 0);
        assert(context[key].length < 750, `${proposal.title}: ${key} became too long`);
        assert(!/undefined|\bNaN\b/.test(context[key]), `${proposal.title}: ${key}`);
      }
    }
  }
  assert.deepEqual(cases, before, 'Display context must not alter proposal options or versions');
});

test('parent correction identifies its exact account, both parents, and chosen optional fields', () => {
  const proposal = named('Bellhaven Meadows of Findlay');
  const baselineContext = reviewContext(proposal, first(proposal));
  assert.match(baselineContext.reason, /not linked/);
  assert.match(baselineContext.outcome, /Assign Bellhaven Meadows of Findlay to Bellhaven Senior Living.*currently has no parent/);
  assert.match(baselineContext.outcome, new RegExp(proposal.candidates[0].account.name));
  assert.match(baselineContext.evidence, /administrator matches an active contact/);
  assert(!/update.*phone/i.test(baselineContext.outcome));
  const selected = proposal.options.find((option) => option.field_choices?.phone?.selected && option.field_choices.care_type?.selected === 'Memory Care');
  assert(selected);
  const context = reviewContext(proposal, selected.id);
  assert.match(context.outcome, /care category/);
  assert.match(context.outcome, /phone/);
  assert.match(context.attention, /Phone differs/);
});

test('CHOW context names the protected source and never describes reparenting it', () => {
  for (const name of ['Bellhaven of Tiffin', 'Bellhaven of Marietta']) {
    const proposal = named(name), context = reviewContext(proposal, first(proposal));
    assert.match(context.reason, /both revenue history and unpaid AR/);
    assert.match(context.outcome, /Create .* under Bellhaven/);
    assert.match(context.outcome, new RegExp(proposal.candidates[0].account.name));
    assert.match(context.outcome, /set only the link.*preserve its parent, balances, and other fields/);
    assert(!context.outcome.includes('Move '));
  }
});

test('format-only address corrections are grouped and supported by normalized matching evidence', () => {
  const proposal = named('Bellhaven Court of Altoona'), context = reviewContext(proposal, first(proposal));
  assert.match(context.evidence, /The street, city, and state match after accounting for spelling and abbreviations/);
  assert.match(context.outcome, /street formatting/);
  assert.equal((context.outcome.match(/street formatting/g) ?? []).length, 1);
  const zip = named('Bellhaven of Portsmouth');
  assert.match(reviewContext(zip, first(zip)).attention, /ZIP differs/);
  assert.match(reviewContext(zip, first(zip)).outcome, /ZIP/);
  assert(!reviewContext(zip, first(zip)).outcome.includes('billing address'));
  assert.match(reviewContext(named('Bellhaven at Sycamore Ridge'), first(named('Bellhaven at Sycamore Ridge'))).outcome, /name/);
});

test('Ashtabula keeps the PO box without calling the physical and billing addresses equivalent', () => {
  const proposal = named('Bellhaven of Ashtabula'), context = reviewContext(proposal, first(proposal));
  assert.match(context.evidence, /CRM uses a billing PO box/);
  assert.match(context.evidence, /phone matches/);
  assert.match(context.attention, /Keep the billing PO box/);
  assert.match(context.outcome, /unchanged/);
  assert(!context.evidence.includes('street, city, and state match'));
});

test('review context explains preserved holds and credit-bearing account conflicts', async () => {
  const data = structuredClone(baseline);
  const findlay = data.accounts.find((account) => account.name === 'Bellhaven Meadows of Findlay');
  findlay.status = 'Needs Review';
  findlay.note = 'Collections review remains open.';
  let proposal = (await reconcile(data)).find((row) => row.title === findlay.name);
  let context = reviewContext(proposal, first(proposal));
  assert.match(context.attention, /Needs Review status stays in place/);
  assert(!context.outcome.includes('status to Active'));
  data.accounts.push({ ...findlay, account_id: 'credit-copy', lifetime_revenue: 0, outstanding_ar: -50 });
  proposal = (await reconcile(data)).find((row) => row.title === findlay.name);
  assert.equal(proposal.kind, 'ambiguous');
  context = reviewContext(proposal);
  assert.match(context.reason, /Several matching accounts carry billing history/);
});

test('Amberly offers conditional identity context and evidence follows the selected record', () => {
  const proposal = named('Amberly Manor');
  const pending = reviewContext(proposal);
  assert.match(pending.reason, /same name.*address conflicts/);
  assert.match(pending.evidence, /No account is confirmed/);
  assert.match(pending.outcome, /Choose a resolution/);
  const separate = proposal.options.find((option) => option.resolution === 'separate');
  const newContext = reviewContext(proposal, separate.id);
  assert.match(newContext.evidence, /do not establish that on their own/);
  assert.match(newContext.outcome, /Existing accounts stay unchanged/);
  const existing = proposal.options.find((option) => option.resolution === 'existing');
  const existingContext = reviewContext(proposal, existing.id);
  assert.match(existingContext.evidence, /name matches/);
  assert(!existingContext.evidence.includes('street, city, and state match'));
  assert.match(existingContext.attention, /Different city or state/);
  assert.match(existingContext.outcome, /Juniper Point Healthcare/);
  assert.match(existingContext.outcome, /Move Amberly Manor/);
  assert.match(existingContext.attention, /Confirm the identity choice/);
});

test('no selection borrows neither a survivor nor its matching reasons for Kettering', () => {
  const proposal = named('Bellhaven of Kettering');
  const unselected = reviewContext(proposal);
  assert.match(unselected.evidence, /3 location candidates/);
  assert(!unselected.evidence.includes('phone matches'));
  const option = proposal.options.find((option) => option.resolution === 'existing');
  const chosen = reviewContext(proposal, option.id);
  assert.match(chosen.outcome, new RegExp(proposal.candidates.find((candidate) => candidate.account.account_id === option.account_id).account.name));
  assert.match(chosen.outcome, /Other accounts stay unchanged/);
  assert(!chosen.outcome.includes('Inactive'));
});

test('duplicate cleanup and update-only outcomes reflect the exact chosen operations for every group', () => {
  for (const saved of cases.filter((proposal) => proposal.kind === 'duplicate')) {
    const proposal = { ...saved, status: 'pending' };
    const cleanup = proposal.options.find((option) => option.operations.some((op) => op.type === 'duplicate'));
    const count = cleanup.operations.filter((op) => op.type === 'duplicate').length;
    const context = reviewContext(proposal, cleanup.id);
    assert.match(context.outcome, new RegExp(`Mark ${count} other cop`));
    assert.match(context.outcome, /Inactive and link (it|them) to the survivor/);
    assert.match(context.outcome, new RegExp(proposal.candidates[0].account.name));
    const only = proposal.options.find((option) => option.resolution === 'existing');
    const onlyContext = reviewContext(proposal, only.id);
    assert(!onlyContext.outcome.includes('Inactive'));
    assert.match(onlyContext.outcome, /Other accounts stay unchanged/);
  }
});

test('new-account alternatives do not acquire matching claims from unrelated records', () => {
  const proposal = named('Bellhaven at Union Square'), context = reviewContext(proposal, first(proposal));
  assert.match(context.evidence, /does not establish a match/);
  assert.match(context.outcome, /Create Bellhaven at Union Square under Bellhaven/);
  assert(!context.evidence.includes('phone matches'));
  assert.equal(context.attention, null);
});

test('all absent cases explain the limited evidence and preserve the parent', () => {
  for (const saved of cases.filter((proposal) => proposal.kind === 'absent')) {
    const proposal = { ...saved, status: 'pending' }, context = reviewContext(proposal, first(proposal));
    assert.match(context.reason, /complete website crawl/);
    assert.match(context.evidence, /does not establish a sale or closure/);
    assert.match(context.outcome, /Needs Review/);
    assert.match(context.outcome, /Keep its parent and billing history/);
    assert(!context.outcome.includes('Move '));
  }
});

test('history and partial plans never present snapshots as fresh CRM state or full completion', () => {
  const proposal = named('Bellhaven of Tiffin');
  for (const status of ['applied', 'rejected', 'partial', 'applying', 'stale', 'superseded']) {
    const context = reviewContext({ ...proposal, status }, first(proposal));
    assert(context.statusNotice, status);
    assert.notEqual(context.outcomeLabel, 'On approval');
    if (status === 'partial') {
      assert.match(context.statusNotice, /did not finish/);
      assert.match(context.outcomeLabel, /incomplete/);
    }
    if (status === 'applied') assert.match(context.statusNotice, /not a fresh read/);
    if (status === 'rejected') assert.equal(context.outcome, 'No CRM records were changed by this rejection.');
    if (status === 'superseded') assert.match(context.statusNotice, /cannot be approved/);
  }
});

test('missing billing and broken links are explicit blocks instead of unsubstantiated resolutions', () => {
  const proposal = named('Bellhaven of Kettering');
  const missing = structuredClone(proposal);
  missing.options = [];
  missing.candidates[0].account.outstanding_ar = null;
  assert.match(reviewContext(missing).reason, /Billing evidence is incomplete/);
  assert.match(reviewContext(missing).attention, /Resolve the missing evidence/);
  const broken = { ...proposal, options: [], link_conflicts: [{ conflicts: ['Account links form a cycle.'] }] };
  assert.match(reviewContext(broken).reason, /historical account link/);
  assert.match(reviewContext(broken).attention, /Repair the existing history link/);
});

test('unknown balances are never displayed as zero and real cents remain visible', () => {
  for (const value of [undefined, null, '', ' ', NaN, Infinity, false, 'not a number', [], {}])
    assert.equal(formatBalance(value), 'Not verified');
  assert.equal(formatBalance(0), '$0');
  assert.equal(formatBalance('0'), '$0');
  assert.equal(formatBalance(0.01), '$0.01');
  assert.equal(formatBalance(1.2), '$1.20');
  assert.equal(formatBalance('42000.05'), '$42,000.05');
});

test('material address fixes stay distinct from spelling fixes and name changes use observed values', () => {
  const proposal = named('Amberly Manor');
  const selected = proposal.options.find((option) => option.resolution === 'existing');
  const context = reviewContext(proposal, selected.id);
  assert.match(context.outcome, /billing address/);
  assert(!context.outcome.includes('street formatting'));
  const rename = named('Bellhaven at Sycamore Ridge');
  assert.match(reviewContext(rename, first(rename)).outcome, /Change the name on Bellhaven of Sycamore Ridge to “Bellhaven at Sycamore Ridge”/);
  const erie = named('Bellhaven Shores of Erie');
  assert.match(reviewContext(erie, first(erie)).outcome, /Save the website offerings in Bellhaven Shores of Erie’s CRM note/);
});

test('same-address alternatives do not imply ownership and historical links do not imply duplicates', () => {
  const absent = named('Bellhaven of Sandusky');
  assert.match(reviewContext(absent, first(absent)).attention, /does not verify current ownership/);
  const proposal = named('Bellhaven Meadows of Findlay');
  proposal.linked_accounts = [{ route: { status: 'resolved', current: proposal.candidates[0].account.account_id } }];
  assert.match(reviewContext(proposal, first(proposal)).attention, /historical account links.*billing history remains separate/);
});

test('unknown approval selection cannot present a new resolution or a full completion', () => {
  const proposal = named('Bellhaven of Tiffin');
  for (const status of ['partial', 'applying', 'applied']) {
    const context = reviewContext({ ...proposal, status }, 'missing');
    assert.match(context.outcome, /approved option is unavailable/);
    assert(!context.outcome.includes('Choose a resolution'));
  }
  assert.match(reviewContext({ ...proposal, status: 'applying' }, first(proposal)).statusNotice,
    /Completion is not verified.*Resume the saved operation/);
});

test('empty reviewed choices are audit-only and rejected context never implies another action is needed', () => {
  const account = { account_id: 'test-account', name: 'Test account' };
  const proposal = {
    status: 'pending', kind: 'field_correction', candidates: [{ account, reasons: [], conflicts: [] }],
    options: [{ id: 'test-account', operations: [] }],
  };
  assert.match(reviewContext(proposal, 'test-account').outcome, /Save the reviewed choice; Test account stays unchanged/);
  const rejected = reviewContext({ ...proposal, status: 'rejected' }, 'reject');
  assert.match(rejected.evidence, /no account resolution was approved/);
  assert.equal(rejected.outcomeLabel, 'Decision');
});

test('one eligible candidate blocked by missing billing is not described as an absent or conflicting identity', () => {
  const proposal = named('Bellhaven Meadows of Findlay');
  proposal.kind = 'ambiguous';
  proposal.options = [];
  proposal.candidates = structuredClone(proposal.candidates);
  proposal.candidates[0].account.outstanding_ar = null;
  const context = reviewContext(proposal);
  assert.match(context.reason, /Billing evidence is incomplete/);
  assert.match(context.evidence, /One location candidate is recorded/);
  assert(!context.evidence.includes('No account is confirmed'));
  assert.match(context.outcome, /No CRM change is available/);
});

test('saved judgment plans do not ask the reviewer to confirm an already-approved identity again', () => {
  const proposal = named('Amberly Manor');
  const selected = proposal.options.find((option) => option.resolution === 'existing');
  for (const status of ['applied', 'partial', 'applying', 'stale', 'superseded']) {
    const context = reviewContext({ ...proposal, status }, selected.id);
    assert(!context.attention.includes('Confirm the identity choice'));
    assert.match(context.attention, /Different city or state/);
  }
});

test('a carried-forward care note is not misdescribed as a new website-offering update', () => {
  const proposal = named('Bellhaven at Sycamore Ridge');
  const option = structuredClone(proposal.options[0]);
  option.operations[0].before.note = 'Care offerings: Assisted Living.';
  option.operations[0].fields.note = 'Care offerings: Assisted Living.\nPrior observed name: Sycamore.';
  const context = reviewContext({ ...proposal, options: [option] }, option.id);
  assert.match(context.outcome, /CRM note/);
  assert(!context.outcome.includes('website offerings'));
});

test('manual records use entity-neutral rejection wording and stored parent names', () => {
  const manual = {
    manual: true, entity: 'contacts', status: 'rejected', candidates: [], options: [],
  };
  assert.equal(reviewContext(manual).outcome, 'No CRM records were changed by this rejection.');
  const chow = named('Bellhaven of Tiffin');
  const parent = chow.parent;
  chow.manual = true;
  chow.parent = undefined;
  chow.dependencies = [parent];
  assert.match(reviewContext(chow, first(chow)).outcome, /under Bellhaven Senior Living/);
});

test('all generated case copy starts naturally and avoids misleading label fragments', () => {
  for (const proposal of cases) {
    for (const option of proposal.options) {
      const context = reviewContext({ ...proposal, status: 'pending' }, option.id);
      assert.match(context.evidence, /^[A-Z]/, proposal.title);
      assert(!context.outcome.includes('from no parent'), proposal.title);
      assert(!/Update [^.]+:/.test(context.outcome), proposal.title);
      assert(!context.outcome.includes('note (Needs Review)'), proposal.title);
    }
  }
  const absent = named('Bellhaven of Sandusky');
  assert.match(reviewContext(absent, first(absent)).outcome, /Set Bellhaven of Sandusky’s status to Needs Review\. Update its CRM note/);
  const single = named('Bellhaven of Owosso');
  assert.match(reviewContext(single, first(single)).outcome, /Mark 1 other copy Inactive and link it to the survivor/);
  const multiple = named('Bellhaven Gardens of Monroe');
  assert.match(reviewContext(multiple, first(multiple)).outcome, /Mark 2 other copies Inactive and link them to the survivor/);
});
