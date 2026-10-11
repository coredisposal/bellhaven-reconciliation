import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

const PREFIX = 'quality-e2e-';
const parent = (id = 'parent') => ({
  account_id: PREFIX + id,
  name: `Test ${id} (Parent Account)`,
  parent_id: '',
  status: 'Active',
  lifetime_revenue: 0,
  outstanding_ar: 0,
});
const account = (id, fields = {}) => ({
  account_id: PREFIX + id,
  name: 'Test Harbor Nursing Center',
  parent_id: PREFIX + 'parent',
  parent_name: 'Test parent (Parent Account)',
  billing_street: '7100 Test Harbor Road',
  billing_city: 'Test Harbor',
  billing_state: 'VA',
  billing_zip: '22000',
  care_type: 'Skilled Nursing',
  phone: '(703) 555-0130',
  status: 'Active',
  lifetime_revenue: 0,
  outstanding_ar: 0,
  chow_current_account: '',
  duplicate_of_account: '',
  note: '',
  ...fields,
});
const contact = (id, accountId, fields = {}) => ({
  contact_id: PREFIX + id,
  account_id: PREFIX + accountId,
  name: `Test ${id}`,
  title: 'Administrator',
  email: `${id}@quality.example.test`,
  phone: '(703) 555-0131',
  is_active: true,
  ...fields,
});
const ok = (reply) => {
  assert.equal(reply.status, 200, JSON.stringify(reply.value));
  return reply.value;
};
const read = async (app, path = 'state') => ok(await app.call(path));
const decide = async (app, proposal, option, action = 'approve', note = 'Reviewed the listed records and confirmed this limited resolution.') =>
  app.call('decision', {
    ...(await app.reviewer()),
    body: {
      id: proposal.id,
      version: proposal.version,
      optionId: option?.id,
      action,
      note,
    },
  });
const qualityCase = (state, category, accountId) => {
  const found = state.proposals.find((p) => p.current && p.kind === 'crm_quality' &&
    p.quality.category === category && (!accountId || p.candidates.some((c) => c.account.account_id === PREFIX + accountId)));
  assert(found, `Missing current CRM quality case: ${category}/${accountId ?? 'any'}`);
  return found;
};

async function setup(t, onWrite) {
  const hosted = await createHarness({ privateSite: false, onWrite });
  let local;
  t.after(async () => {
    try { await local?.close(); } finally { await hosted.close(); }
  });
  local = await createHarness({ mode: 'proxy', backend: hosted, privateSite: false });
  hosted.data.accounts.push(parent());
  return { hosted, local };
}

function seedDuplicates(hosted) {
  const rows = [
    account('survivor', { lifetime_revenue: 32000, outstanding_ar: 1400 }),
    account('copy-a'),
    account('copy-b'),
  ];
  hosted.data.accounts.push(...rows);
  hosted.data.contacts.push(contact('survivor-admin', 'survivor'));
  return rows;
}

test('CRM quality: public and local review share all-CRM findings; refresh performs no writes', async (t) => {
  const { hosted, local } = await setup(t);
  const rows = [account('shared-a'), account('shared-b', { billing_street: '8000 Other Lane' })];
  hosted.data.accounts.push(...rows);
  hosted.data.contacts.push(
    contact('person-a', 'shared-a', { email: 'shared@quality.example.test' }),
    contact('person-b', 'shared-b', { email: 'shared@quality.example.test' }),
  );
  const before = structuredClone(hosted.data);
  const run = ok(await hosted.pipeline());
  const state = await read(local);
  const p = qualityCase(state, 'shared_email', 'shared-a');
  assert.equal(p.quality.contacts.length, 2);
  assert(p.options.every((option) => option.operations.length === 0), 'Shared email is not proof of a contact correction');
  assert.equal(state.website.facilities.length, 35);
  assert.equal(state.runs[0].data.counts.accounts, before.accounts.length);
  assert.equal(run.open_proposals, state.proposals.filter((p) => ['pending', 'stale', 'partial', 'applying'].includes(p.status)).length);
  assert.deepEqual(await read(hosted), state, 'The local proxy exposes the same durable ledger');
  assert.equal((await local.db.prepare('SELECT COUNT(*) AS n FROM proposals').first()).n, 0);
  assert.equal(hosted.writes.length, 0);
  assert.deepEqual(hosted.data, before);
});

test('CRM quality: acknowledgment and rejection survive restart and repeat refresh; new evidence reopens review', async (t) => {
  const { hosted, local } = await setup(t);
  hosted.data.accounts.push(account('shared-a'), account('shared-b', { billing_street: '8000 Other Lane' }));
  const person = contact('person-a', 'shared-a', { email: 'shared@quality.example.test' });
  const orphan = contact('orphan', 'missing');
  hosted.data.contacts.push(person, contact('person-b', 'shared-b', { email: person.email }), orphan);
  ok(await hosted.pipeline());
  const state = await read(local);
  const shared = qualityCase(state, 'shared_email', 'shared-a');
  const missing = state.proposals.find((p) => p.current && p.key === `quality:orphan-contacts:${PREFIX}missing`);
  assert(missing);
  const option = shared.options.find((o) => o.id === 'acknowledge');
  assert.equal((await decide(local, shared, option, 'approve', '')).status, 409, 'A judgment decision needs a rationale');
  ok(await decide(local, shared, option));
  ok(await decide(local, missing, undefined, 'reject', 'The account owner must confirm the intended contact account.'));
  const before = structuredClone(hosted.data);
  await hosted.restart();
  await local.restart();
  for (let pass = 0; pass < 2; pass++) assert.equal(ok(await hosted.pipeline()).new_proposals, 0);
  const retained = await read(local);
  assert.equal(retained.proposals.find((p) => p.id === shared.id).status, 'applied');
  assert.equal(retained.proposals.find((p) => p.id === missing.id).status, 'rejected');
  assert(!retained.proposals.some((p) => [shared.key, missing.key].includes(p.key) && p.status === 'pending'));
  const report = await read(local, 'report');
  assert.equal(report.history.verified_applied_cases, 1, 'A zero-write acknowledgment is a verified recorded decision');
  assert.equal(report.recovery.case_count, 0);
  assert.equal((await decide(hosted, shared, option)).status, 409, 'A second reviewer cannot repeat the decision');
  assert.equal(hosted.writes.length, 0);
  assert.deepEqual(hosted.data, before);

  person.name = 'Changed contact identity';
  orphan.name = 'Changed orphan identity';
  assert.equal(ok(await hosted.pipeline()).new_proposals, 2);
  const changed = await read(local);
  for (const old of [shared, missing]) {
    const fresh = changed.proposals.find((p) => p.key === old.key && p.current);
    assert.equal(fresh.status, 'pending');
    assert.notEqual(fresh.id, old.id);
    assert(changed.decisions.some((d) => d.proposal_id === old.id), 'Prior decisions stay in history');
  }
  assert.equal(hosted.writes.length, 0);
});

test('CRM quality: a saved no-write review reopens through the public/local API and stays pending until a fresh decision', async (t) => {
  const { hosted, local } = await setup(t);
  hosted.data.accounts.push(parent('other-parent'));
  const rows = [account('follow-up-a', { lifetime_revenue: 130000, outstanding_ar: 5200 }),
    account('follow-up-b', { parent_id: PREFIX + 'other-parent', parent_name: 'Test other-parent (Parent Account)' })];
  hosted.data.accounts.push(...rows);
  const before = structuredClone(hosted.data);
  ok(await hosted.pipeline());
  const proposal = qualityCase(await read(local), 'account_overlap', 'follow-up-a');
  const acknowledge = proposal.options.find((option) => option.id === 'acknowledge');
  const flag = proposal.options.find((option) => option.id === 'flag');
  ok(await decide(local, proposal, acknowledge));
  assert.equal((await decide(hosted, proposal, acknowledge, 'reopen', '')).status, 409);
  assert.equal((await decide(local, proposal, flag, 'reopen')).status, 409, 'An unapproved client choice cannot authorize reopening');
  assert.equal(ok(await decide(hosted, proposal, undefined, 'reopen', 'Keep the possible ownership relationship open until the account owner confirms it.')).status, 'pending');
  assert.equal((await decide(local, proposal, acknowledge, 'reopen')).status, 409, 'Repeated clicks cannot record another reopening');
  await hosted.restart();
  await local.restart();
  for (let pass = 0; pass < 2; pass++) {
    assert.equal(ok(await hosted.pipeline()).new_proposals, 0);
    const state = await read(local);
    const current = qualityCase(state, 'account_overlap', 'follow-up-a');
    assert.equal(current.id, proposal.id);
    assert.equal(current.status, 'pending');
    assert.deepEqual(state.decisions.filter((d) => d.proposal_id === proposal.id).map((d) => d.action), ['reopen', 'approve']);
    assert.equal(state.audits.filter((a) => a.proposal_id === proposal.id && a.event === 'case_reopened').length, 1);
    assert.equal((await read(local, 'report')).recovery.case_count, 0);
  }
  assert.equal(hosted.writes.length, 0);
  assert.deepEqual(hosted.data, before, 'Reopening changes the review ledger only');
  assert.equal((await hosted.db.prepare('SELECT COUNT(*) AS n FROM operations WHERE proposal_id=?').bind(proposal.id).first()).n, 0);
  ok(await decide(local, proposal, flag));
  assert.equal(hosted.writes.length, 2);
  assert(rows.every((row) => row.status === 'Needs Review'));
  for (const row of rows) {
    const original = before.accounts.find((a) => a.account_id === row.account_id);
    assert.deepEqual({ ...row, note: original.note, status: original.status }, original);
  }
  const saved = await read(hosted);
  assert.equal(saved.decisions.find((d) => d.proposal_id === proposal.id && d.action === 'approve').option_id, flag.id);
  assert.equal((await read(local, 'report')).history.verified_applied_cases, 1);
  assert.equal((await decide(local, proposal, acknowledge, 'reopen')).status, 409, 'A former no-write option cannot undo the later actual-write approval');
  assert.equal(ok(await hosted.pipeline()).new_proposals, 0);
  assert.equal((await read(local)).proposals.find((p) => p.id === proposal.id).status, 'applied');
  assert.equal(hosted.writes.length, 2);
});

test('CRM quality: approved unrelated duplicates retire only empty copies and preserve survivor history', async (t) => {
  const { hosted, local } = await setup(t);
  const rows = seedDuplicates(hosted);
  const before = structuredClone(hosted.data);
  ok(await hosted.pipeline());
  const p = qualityCase(await read(local), 'duplicate', 'survivor');
  const option = p.options.find((o) => o.id === `consolidate:${PREFIX}survivor`);
  assert(option);
  assert.equal(option.operations.length, 2);
  const result = ok(await decide(local, p, option));
  assert.equal(result.status, 'applied');
  assert.equal(hosted.writes.length, 2);
  assert(hosted.writes.every((write) => write.method === 'PATCH' && write.entity === 'accounts'));
  assert.deepEqual(rows[0], before.accounts.find((a) => a.account_id === rows[0].account_id));
  for (const copy of rows.slice(1)) {
    const prior = before.accounts.find((a) => a.account_id === copy.account_id);
    assert.deepEqual(copy, { ...prior, status: 'Inactive', duplicate_of_account: rows[0].account_id });
    assert.deepEqual(await read(local, `crm?entity=accounts&id=${copy.account_id}`), copy);
  }
  assert.deepEqual(hosted.data.contacts, before.contacts);
  assert.deepEqual(hosted.data.accounts.filter((a) => !rows.some((row) => row.account_id === a.account_id)),
    before.accounts.filter((a) => !rows.some((row) => row.account_id === a.account_id)));
  assert.equal((await decide(hosted, p, option)).status, 409);
  await hosted.restart();
  await local.restart();
  for (let pass = 0; pass < 2; pass++) assert.equal(ok(await hosted.pipeline()).new_proposals, 0);
  assert.equal(hosted.writes.length, 2);
  assert.equal((await read(local)).proposals.find((row) => row.id === p.id).status, 'applied');
});

test('CRM quality: interrupted duplicate cleanup resumes only unfinished writes with saved approval', async (t) => {
  let failCopy = true;
  const { hosted, local } = await setup(t, (write) => {
    if (failCopy && write.id === PREFIX + 'copy-b') throw Error('Simulated upstream patch interruption');
  });
  const rows = seedDuplicates(hosted);
  const before = structuredClone(hosted.data);
  ok(await hosted.pipeline());
  const p = qualityCase(await read(local), 'duplicate', 'survivor');
  const option = p.options.find((o) => o.id.startsWith('consolidate:'));
  assert.equal((await decide(local, p, option)).status, 409);
  assert.equal((await read(local)).proposals.find((row) => row.id === p.id).status, 'partial');
  assert.equal(rows[1].duplicate_of_account, rows[0].account_id);
  assert.equal(rows[2].duplicate_of_account, '');
  const persisted = await hosted.db.prepare('SELECT step,status FROM operations WHERE proposal_id=? ORDER BY step').bind(p.id).all();
  assert.deepEqual(persisted.results.map((row) => row.status), ['complete', 'patch_intent']);
  await hosted.restart();
  await local.restart();
  failCopy = false;
  assert.equal(ok(await decide(local, p, undefined, 'resume')).status, 'applied');
  assert.equal(hosted.writes.filter((write) => write.id === PREFIX + 'copy-a').length, 1, 'Completed retirement is never repeated');
  assert.equal(hosted.writes.filter((write) => write.id === PREFIX + 'copy-b').length, 2, 'Only failed patch is retried after readback');
  assert(rows.slice(1).every((row) => row.status === 'Inactive' && row.duplicate_of_account === rows[0].account_id));
  assert.deepEqual(rows[0], before.accounts.find((row) => row.account_id === rows[0].account_id));
  assert.deepEqual(hosted.data.contacts, before.contacts);
  const final = await read(local);
  assert.equal(final.decisions.filter((d) => d.proposal_id === p.id && d.action === 'approve').length, 1);
  assert(final.audits.some((a) => a.proposal_id === p.id && a.event === 'application_resumed'));
  assert.equal(ok(await hosted.pipeline()).new_proposals, 0);
});

test('CRM quality: stale related-account, contact and billing evidence blocks approval before every write', async (t) => {
  const changes = [
    ['related account', ({ rows }) => { rows[0].phone = '(703) 555-0199'; }],
    ['contact', ({ hosted }) => { hosted.data.contacts.find((c) => c.contact_id === PREFIX + 'survivor-admin').email = 'changed@quality.example.test'; }],
    ['billing', ({ rows }) => { rows[1].outstanding_ar = 125; }],
    ['review annotation', ({ rows }) => { rows[0].note = '[crm-quality:another-case] Confirm the billing owner before cleanup.'; }],
  ];
  for (const [name, change] of changes) await t.test(name, async (t) => {
    const { hosted, local } = await setup(t);
    const rows = seedDuplicates(hosted);
    ok(await hosted.pipeline());
    const p = qualityCase(await read(local), 'duplicate', 'survivor');
    const option = p.options.find((o) => o.id.startsWith('consolidate:'));
    change({ hosted, rows });
    const result = await decide(local, p, option);
    assert.equal(result.status, 409);
    assert.match(result.value.error, /stale|changed/i);
    assert.equal(hosted.writes.length, 0);
    const state = await read(local);
    assert.equal(state.proposals.find((row) => row.id === p.id).status, 'stale');
    assert(!state.decisions.some((d) => d.proposal_id === p.id && d.action === 'approve'));
    ok(await hosted.pipeline());
    const fresh = (await read(local)).proposals.find((row) => row.key === p.key && row.current);
    assert(fresh, 'A source refresh supplies a reviewable replacement');
    assert.notEqual(fresh.id, p.id, 'Executable changes must receive a new immutable proposal version');
    assert.equal(fresh.status, 'pending');
  });
});

test('CRM quality: changed contact evidence also blocks interrupted duplicate recovery', async (t) => {
  let failCopy = true;
  const { hosted, local } = await setup(t, (write) => {
    if (failCopy && write.id === PREFIX + 'copy-b') throw Error('Simulated upstream interruption');
  });
  seedDuplicates(hosted);
  ok(await hosted.pipeline());
  const p = qualityCase(await read(local), 'duplicate', 'survivor');
  assert.equal((await decide(local, p, p.options.find((o) => o.id.startsWith('consolidate:')))).status, 409);
  const count = hosted.writes.length;
  hosted.data.contacts.push(contact('new-admin', 'copy-b'));
  await hosted.restart();
  failCopy = false;
  const result = await decide(local, p, undefined, 'resume');
  assert.equal(result.status, 409);
  assert.match(result.value.error, /evidence changed|review/i);
  assert.equal(hosted.writes.length, count, 'New contact ownership must be reviewed before the remaining retirement');
  assert.equal(hosted.data.accounts.find((row) => row.account_id === PREFIX + 'copy-b').status, 'Active');
});

test('CRM quality: shared-address different-parent accounts can be flagged but never inferred to be a transfer', async (t) => {
  const { hosted, local } = await setup(t);
  hosted.data.accounts.push(parent('other-parent'));
  const rows = [account('overlap-a'), account('overlap-b', { parent_id: PREFIX + 'other-parent', parent_name: 'Test other-parent (Parent Account)' })];
  hosted.data.accounts.push(...rows);
  ok(await hosted.pipeline());
  const p = qualityCase(await read(local), 'account_overlap', 'overlap-a');
  assert(!p.options.some((o) => o.operations.some((operation) => ['create', 'chow', 'duplicate'].includes(operation.type))));
  assert(p.options.every((o) => o.operations.every((operation) => Object.keys(operation.fields).every((key) => ['status', 'note'].includes(key)))));
  const before = structuredClone(hosted.data);
  ok(await decide(local, p, p.options.find((o) => o.id === 'flag')));
  assert.equal(hosted.writes.length, 2);
  for (const row of rows) {
    const prior = before.accounts.find((a) => a.account_id === row.account_id);
    assert.deepEqual({ ...row, status: prior.status, note: prior.note }, prior);
    assert.equal(row.status, 'Needs Review');
    assert.match(row.note, /address alone does not establish a duplicate or ownership transfer/i);
  }
  assert.deepEqual(hosted.data.contacts, before.contacts);
  await hosted.restart();
  for (let pass = 0; pass < 2; pass++) assert.equal(ok(await hosted.pipeline()).new_proposals, 0);
  const state = await read(local);
  assert(!state.proposals.some((row) => row.key === p.key && row.status === 'pending'));
  assert.equal(state.proposals.find((row) => row.id === p.id).status, 'applied');
  assert.equal(hosted.writes.length, 2);
});

test('CRM quality: daily discovery offers a guarded existing-successor CHOW choice with approval-only linking', async (t) => {
  const { hosted, local } = await setup(t);
  hosted.data.accounts.push(parent('other-parent'));
  const old = account('chow-old', { lifetime_revenue: 130000, outstanding_ar: 5200, status: 'Needs Review' });
  const next = account('chow-next', { name: 'New Operator Manor', parent_id: PREFIX + 'other-parent' });
  hosted.data.accounts.push(old, next);
  const before = structuredClone(hosted.data);
  ok(await hosted.pipeline());
  const p = qualityCase(await read(local), 'account_overlap', 'chow-old');
  const choice = p.options.find((o) => o.operations.some((op) => op.type === 'chow_link'));
  assert(choice);
  assert.match(choice.label, /If ownership is confirmed/);
  assert.deepEqual(choice.operations.map((op) => ({ type: op.type, account_id: op.account_id, fields: op.fields })),
    [{ type: 'chow_link', account_id: old.account_id, fields: { chow_current_account: next.account_id } }]);
  assert.equal(hosted.writes.length, 0);
  assert.equal((await decide(local, p, choice, 'approve', '')).status, 409);
  ok(await decide(local, p, choice, 'approve', 'The account owner confirmed the new operator and existing successor account. Preserve the old billing record.'));
  assert.equal(hosted.writes.length, 1);
  assert.deepEqual(hosted.data, { ...before, accounts: before.accounts.map((a) => a.account_id === old.account_id ? { ...a, chow_current_account: next.account_id } : a) });
  assert.equal((await decide(hosted, p, choice, 'reopen')).status, 409);
  await hosted.restart();
  await local.restart();
  for (let pass = 0; pass < 2; pass++) assert.equal(ok(await hosted.pipeline()).new_proposals, 0);
  const state = await read(local);
  assert(!state.proposals.some((row) => row.key === p.key && row.status === 'pending'));
  assert.equal((await read(local, 'report')).history.verified_applied_cases, 1);
  assert.equal(hosted.writes.length, 1);
});

test('CRM quality: billing, history and contact exceptions cannot offer unsupported consolidation', async (t) => {
  const { hosted, local } = await setup(t);
  const rows = [
    account('historical', { chow_current_account: PREFIX + 'current', lifetime_revenue: 5000, outstanding_ar: 300 }),
    account('current'),
    account('unlinked-copy'),
    account('credit', { billing_street: '7200 Credit Lane', outstanding_ar: -25 }),
    account('credit-copy', { billing_street: '7200 Credit Lane' }),
    account('unknown', { billing_street: '7300 Unknown Lane', lifetime_revenue: null }),
    account('unknown-copy', { billing_street: '7300 Unknown Lane' }),
  ];
  hosted.data.accounts.push(...rows);
  hosted.data.contacts.push(contact('old-admin', 'historical'));
  const before = structuredClone(hosted.data);
  ok(await hosted.pipeline());
  const state = await read(local);
  for (const id of ['current', 'credit', 'unknown']) {
    const p = qualityCase(state, 'account_overlap', id);
    assert(!p.options.some((o) => o.id.startsWith('consolidate:')));
  }
  const retired = qualityCase(state, 'retired_contact', 'historical');
  assert(retired.alternatives.some((c) => c.account.account_id === PREFIX + 'current'));
  assert(retired.options.every((o) => !o.operations.length));
  qualityCase(state, 'billing', 'unknown');
  assert(!state.proposals.some((p) => p.quality?.category === 'billing' && p.candidates.some((c) => c.account.account_id === PREFIX + 'credit')),
    'A legitimate AR credit is not missing or invalid billing');
  assert.equal(hosted.writes.length, 0);
  assert.deepEqual(hosted.data, before);
});

test('CRM quality: optional website phone drift can be retained or corrected without touching the billing address', async (t) => {
  for (const useWebsite of [false, true]) await t.test(useWebsite ? 'use website phone' : 'keep current phone', async (t) => {
    const { hosted, local } = await setup(t);
    const row = hosted.data.accounts.find((a) => a.name === 'Bellhaven of Ashtabula');
    assert.match(row.billing_street, /box/i, 'Use a legitimate PO box as the protected address');
    row.phone = '(440) 555-0199';
    const before = structuredClone(row);
    ok(await hosted.pipeline());
    const p = (await read(local)).proposals.find((p) => p.current && p.quality?.category === 'website_fields' &&
      p.candidates.some((c) => c.account.account_id === row.account_id));
    assert(p);
    const option = p.options.find((o) => o.field_choices.phone?.selected === useWebsite);
    assert(option);
    assert.equal(option.operations.length, useWebsite ? 1 : 0);
    ok(await decide(local, p, option));
    assert.deepEqual(row, { ...before, phone: useWebsite ? p.facility.phone_raw : before.phone });
    assert.equal(hosted.writes.length, useWebsite ? 1 : 0);
    await hosted.restart();
    await local.restart();
    for (let pass = 0; pass < 2; pass++) assert.equal(ok(await hosted.pipeline()).new_proposals, 0);
    assert(!(await read(local)).proposals.some((candidate) => candidate.key === p.key && candidate.status === 'pending'));
    const report = await read(local, 'report');
    assert.equal(report.history.verified_applied_cases, 1);
    assert.equal(report.recovery.case_count, 0);
    if (!useWebsite) {
      row.phone = '(440) 555-0188';
      assert.equal(ok(await hosted.pipeline()).new_proposals, 1);
      const fresh = (await read(local)).proposals.find((candidate) => candidate.current && candidate.key === p.key);
      assert.equal(fresh.status, 'pending');
      assert.notEqual(fresh.id, p.id);
      assert.equal(hosted.writes.length, 0);
    }
  });
});
