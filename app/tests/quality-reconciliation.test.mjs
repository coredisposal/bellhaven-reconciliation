import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { reconcile as facilityReconciliation } from '../lib/core.mjs';
import { reconcile } from '../lib/reconciliation.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { decide, runPipeline } from '../lib/engine.mjs';
import { reviewState } from '../lib/state.mjs';
import { operationalReport } from '../lib/reporting.mjs';
import { selectedOption } from '../lib/review-selection.mjs';

const parent = { account_id: 'parent', name: 'Bellhaven Senior Living (Parent Account)', status: 'Active', lifetime_revenue: 0, outstanding_ar: 0 };
const account = (id, changes = {}) => ({ account_id: id, name: 'Example Manor', parent_id: parent.account_id, status: 'Active', billing_street: '100 N Main St', billing_city: 'Example', billing_state: 'OH', billing_zip: '44000', phone: '(216) 555-0100', care_type: 'Assisted Living', lifetime_revenue: 0, outstanding_ar: 0, ...changes });
function setup(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  for (const filename of readdirSync(new URL('../drizzle/', import.meta.url)).filter((file) => file.endsWith('.sql'))) sql.exec(readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), 'utf8'));
  const facility = { name: 'Example Manor', street_address: '100 N Main St', city: 'Example', state: 'OH', postal_code: '44000', phone_raw: '(216) 555-0200', care_offerings: ['Assisted Living'], source_url: 'https://example.test/facility' };
  const snapshot = { accounts: [parent, account('current')], contacts: [], facilities: [facility], coverage: { complete: true, expected: 1, found: 1, urls: [facility.source_url] } };
  return { sql, db: sqliteD1(sql), snapshot, facility };
}
function store(s, proposal, status = 'applied', choice = proposal.options[0]) {
  s.sql.prepare('INSERT INTO proposals(id,case_key,version,run_id,status,data,created) VALUES(?,?,?,?,?,?,?)').run(proposal.id, proposal.key, proposal.version, 'test-run', status, JSON.stringify(proposal), '2026-10-11T00:00:00Z');
  if (status === 'applied') s.sql.prepare('INSERT INTO decisions(id,proposal_id,action,option_id,actor,session_id,note,created) VALUES(?,?,?,?,?,?,?,?)').run(`decision:${proposal.id}`, proposal.id, 'approve', choice.id, 'reviewer', 'test', 'Source reviewed', '2026-10-11T00:00:00Z');
}
async function prior(s, id = 'prior', choices = { phone: { current: '(216) 555-0100', proposed: '(216) 555-0200', selected: false } }) {
  const row = (await facilityReconciliation(s.snapshot))[0];
  return { ...row, id, version: id, kind: 'field_correction', options: [{ id: 'current', account_id: 'current', field_choices: choices, operations: [] }] };
}
const websiteFields = (proposals) => proposals.filter((p) => p.kind === 'crm_quality' && p.quality.category === 'website_fields');

test('quality reconciliation keeps a reviewed phone until either CRM or website evidence changes', async (t) => {
  const s = setup(t);
  store(s, await prior(s));
  assert.equal(websiteFields(await reconcile(s.snapshot, s.db)).length, 0);
  s.snapshot.accounts[1].updated_at = 'later';
  s.facility.retrieved_at_utc = 'later';
  assert.equal(websiteFields(await reconcile(s.snapshot, s.db)).length, 0);
  s.snapshot.accounts[1].phone = '(216) 555-0300';
  assert.equal(websiteFields(await reconcile(s.snapshot, s.db)).length, 1, 'CRM phone drift requires new review');
  s.snapshot.accounts[1].phone = '(216) 555-0100';
  s.facility.phone_raw = '(216) 555-0400';
  assert.equal(websiteFields(await reconcile(s.snapshot, s.db)).length, 1, 'Website phone drift requires new review');
});

test('quality reconciliation uses the latest decision instead of an older matching retained value', async (t) => {
  const s = setup(t);
  store(s, await prior(s, 'first'));
  store(s, await prior(s, 'latest', { phone: { current: '(216) 555-0100', proposed: '(216) 555-0200', selected: true } }));
  assert.equal(websiteFields(await reconcile(s.snapshot, s.db)).length, 1, 'Rollback cannot reuse an earlier keep-current decision');
});

test('quality reconciliation requires the approved account identity to retain a field', async (t) => {
  const s = setup(t);
  store(s, await prior(s));
  s.snapshot.accounts[1].account_id = 'different-current-account';
  assert.equal(websiteFields(await reconcile(s.snapshot, s.db)).length, 1);
});

test('quality reconciliation does not transfer a retained field to a different current account while the old account remains', async (t) => {
  const s = setup(t);
  store(s, await prior(s));
  s.snapshot.accounts[1].status = 'Inactive';
  s.snapshot.accounts[1].duplicate_of_account = 'new-current';
  s.snapshot.accounts.push(account('new-current', { phone: '(216) 555-0300' }));
  const proposals = websiteFields(await reconcile(s.snapshot, s.db));
  assert.equal(proposals.length, 1, 'Retained phone on historical A must not suppress the different phone on current B');
  assert.equal(proposals[0].candidates[0].account.account_id, 'new-current');
  assert.equal(proposals[0].options.find((option) => option.field_choices.phone.selected).operations[0].account_id, 'new-current');
});

test('quality reconciliation preserves legacy omitted fields but does not suppress changed CRM values', async (t) => {
  const s = setup(t), p = await prior(s);
  p.options = [{ id: 'current', operations: [{ type: 'patch', account_id: 'current', before: structuredClone(s.snapshot.accounts[1]), fields: { note: 'Verified source' } }] }];
  store(s, p);
  assert.equal(websiteFields(await reconcile(s.snapshot, s.db)).length, 0);
  s.snapshot.accounts[1].phone = '(216) 555-0300';
  assert.equal(websiteFields(await reconcile(s.snapshot, s.db)).length, 1);
});

for (const type of ['manual', 'pipeline']) {
  test(`quality reconciliation holds overlapping ${type} interrupted candidates and checkpoint replacements only`, async (t) => {
    const s = setup(t);
    s.snapshot.facilities = [];
    s.snapshot.coverage = { complete: true, expected: 0, found: 0, urls: [] };
    const outside = { ...parent, account_id: 'outside', name: 'Outside Operator (Parent Account)' };
    const a = account('a', { parent_id: outside.account_id });
    const b = account('b', { parent_id: outside.account_id });
    s.snapshot.accounts = [parent, outside, a, b, account('unrelated-a', { parent_id: outside.account_id, billing_street: '200 Second St' }), account('unrelated-b', { parent_id: outside.account_id, billing_street: '200 Second St' })];
    const p = { id: 'partial', version: 'partial', key: type === 'manual' ? 'manual:accounts:a' : s.facility.source_url, kind: type === 'manual' ? 'manual_account' : 'chow', candidates: [{ account: a, contacts: [] }], options: [] };
    store(s, p, 'partial');
    s.sql.prepare('INSERT INTO operations(id,proposal_id,step,status,data,updated) VALUES(?,?,?,?,?,?)').run('operation', p.id, 0, 'created', JSON.stringify(type === 'manual' ? { recordId: b.account_id, created: b } : { replacement: b.account_id, created: b }), '2026-10-11T00:00:00Z');
    let quality = (await reconcile(s.snapshot, s.db)).filter((p) => p.kind === 'crm_quality');
    assert.deepEqual(quality.map((p) => p.key), ['quality:account-overlap:unrelated-a:unrelated-b']);
    s.sql.prepare("UPDATE proposals SET status='applied' WHERE id=?").run(p.id);
    quality = (await reconcile(s.snapshot, s.db)).filter((p) => p.kind === 'crm_quality');
    assert.deepEqual(quality.map((p) => p.key), ['quality:account-overlap:a:b', 'quality:account-overlap:unrelated-a:unrelated-b']);
  });
}

test('quality reconciliation holds interrupted manual operation accounts when candidates and checkpoints are absent', async (t) => {
  const s = setup(t);
  s.snapshot.facilities = [];
  s.snapshot.coverage = { complete: true, expected: 0, found: 0, urls: [] };
  const outside = { ...parent, account_id: 'outside', name: 'Outside Operator (Parent Account)' };
  const a = account('a', { parent_id: outside.account_id });
  s.snapshot.accounts = [parent, outside, a, account('b', { parent_id: outside.account_id })];
  const p = {
    id: 'manual-partial', version: 'manual-partial', key: 'manual:accounts:a', kind: 'manual_account',
    manual: true, origin: 'manual', entity: 'accounts', recordId: a.account_id,
    candidates: [], options: [{ id: 'manual', operations: [{ type: 'patch', entity: 'accounts', account_id: a.account_id, record_id: a.account_id, before: a, fields: { note: 'Partial manual review' } }] }],
  };
  store(s, p, 'partial');
  assert.equal((await reconcile(s.snapshot, s.db)).filter((p) => p.kind === 'crm_quality').length, 0, 'Operation account IDs must protect interrupted manual work before a checkpoint exists');
});

async function reviewSetup(t) {
  const s = setup(t), ledger = new Ledger(s.db), writes = [];
  const getSnapshot = async () => structuredClone(s.snapshot);
  const client = {
    accounts: async () => structuredClone(s.snapshot.accounts),
    contacts: async () => structuredClone(s.snapshot.contacts),
    get: async (id) => structuredClone(s.snapshot.accounts.find((a) => a.account_id === id)),
    patch: async (id, fields) => {
      writes.push({ id, fields });
      const row = s.snapshot.accounts.find((a) => a.account_id === id);
      Object.assign(row, fields);
      return structuredClone(row);
    },
    create: async () => { throw new Error('Creation is outside this review'); },
  };
  const decision = (p, action, option, note = 'Keep this unanswered verification task available for follow-up.') =>
    decide(ledger, client, getSnapshot, { id: p.id, version: p.version, action, optionId: option?.id, note }, { actor: 'reviewer', session: 'review-session' });
  await runPipeline(ledger, getSnapshot);
  const p = websiteFields(await reconcile(s.snapshot, s.db))[0];
  const keep = p.options.find((option) => !option.operations.length);
  const update = p.options.find((option) => option.operations.length);
  return { ...s, ledger, client, writes, getSnapshot, decision, p, keep, update };
}

async function chowLinkSetup(t) {
  const s = await reviewSetup(t);
  s.snapshot.accounts = [{ ...parent },
    { ...parent, account_id: 'other-parent', name: 'Other Operator (Parent Account)' },
    account('old', { lifetime_revenue: 130000, outstanding_ar: 5200, status: 'Needs Review' }),
    account('successor', { name: 'Successor Manor', parent_id: 'other-parent' }),
  ];
  s.snapshot.facilities = [];
  s.snapshot.coverage = { complete: true, expected: 0, found: 0, urls: [] };
  await runPipeline(s.ledger, s.getSnapshot);
  const p = (await reconcile(s.snapshot, s.db)).find((p) => p.kind === 'crm_quality' && p.quality.category === 'account_overlap');
  const link = p.options.find((o) => o.operations.some((op) => op.type === 'chow_link'));
  assert(link);
  return { ...s, p, link };
}

test('automatic CHOW successor link preserves all original fields and repeat runs never recreate the overlap', async (t) => {
  const s = await chowLinkSetup(t), before = structuredClone(s.snapshot);
  await assert.rejects(s.decision(s.p, 'approve', s.link, ''), /Explain your resolution/);
  assert.deepEqual(await s.decision(s.p, 'approve', s.link), { status: 'applied' });
  assert.deepEqual(s.writes, [{ id: 'old', fields: { chow_current_account: 'successor' } }]);
  assert.deepEqual(s.snapshot.accounts, before.accounts.map((a) => a.account_id === 'old' ? { ...a, chow_current_account: 'successor' } : a));
  await assert.rejects(s.decision(s.p, 'reopen', s.link), /Only rejected/);
  for (let i = 0; i < 2; i++) {
    assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
    assert(!(await reviewState(s.ledger, 'live')).proposals.some((p) => p.key === s.p.key && p.status === 'pending'));
  }
  assert.equal(s.writes.length, 1);
});

test('automatic CHOW link invalidates on changed source, successor or parent evidence before writing', async (t) => {
  for (const [id, fields] of [['old', { outstanding_ar: 0 }], ['successor', { phone: 'changed' }], ['other-parent', { name: 'Changed owner' }], ['parent', { status: 'Inactive' }]]) await t.test(id, async (t) => {
    const s = await chowLinkSetup(t);
    Object.assign(s.snapshot.accounts.find((a) => a.account_id === id), fields);
    await assert.rejects(s.decision(s.p, 'approve', s.link), /Evidence changed|parent/i);
    assert.equal(s.writes.length, 0);
  });
});

test('automatic CHOW link checks dependencies again immediately before its patch', async (t) => {
  const s = await chowLinkSetup(t), get = s.client.get;
  s.client.get = async (id) => {
    if (id === 'successor') s.snapshot.accounts.find((a) => a.account_id === id).phone = 'Changed after approval';
    return get(id);
  };
  await assert.rejects(s.decision(s.p, 'approve', s.link), /successor or parent evidence changed/);
  assert.equal(s.writes.length, 0);
  assert.equal(s.sql.prepare('SELECT status FROM proposals WHERE id=?').get(s.p.id).status, 'partial');
});

test('automatic CHOW link withholds new incoming relationships discovered at the write boundary', async (t) => {
  for (const relationship of ['parent_id', 'chow_current_account']) await t.test(relationship, async (t) => {
    const s = await chowLinkSetup(t), get = s.client.get;
    s.client.get = async (id) => {
      if (id === 'successor') s.snapshot.accounts.push(account('new-related', { billing_street: '200 Other St', [relationship]: 'successor' }));
      return get(id);
    };
    await assert.rejects(s.decision(s.p, 'approve', s.link), /Parent accounts|historical links/);
    assert.equal(s.writes.length, 0);
  });
});

test('automatic CHOW link withholds billing drift between individual reads and final inventory', async (t) => {
  const s = await chowLinkSetup(t), accounts = s.client.accounts;
  s.client.accounts = async () => {
    s.snapshot.accounts.find((a) => a.account_id === 'old').outstanding_ar = 0;
    return accounts();
  };
  await assert.rejects(s.decision(s.p, 'approve', s.link), /write boundary/);
  assert.equal(s.writes.length, 0);
});

test('automatic CHOW link resumes after interrupted patch and reconciles a lost successful response', async (t) => {
  for (const lostResponse of [false, true]) await t.test(lostResponse ? 'lost successful response' : 'interrupted patch', async (t) => {
    const s = await chowLinkSetup(t), patch = s.client.patch;
    let attempts = 0;
    s.client.patch = async (id, fields) => {
      attempts++;
      if (lostResponse) await patch(id, fields);
      throw new Error('Simulated upstream timeout');
    };
    if (lostResponse) assert.deepEqual(await s.decision(s.p, 'approve', s.link), { status: 'applied' });
    else {
      await assert.rejects(s.decision(s.p, 'approve', s.link), /Patch not verified/);
      s.client.patch = async (...args) => { attempts++; return patch(...args); };
      assert.deepEqual(await s.decision(s.p, 'resume', undefined), { status: 'applied' });
    }
    assert.equal(attempts, lostResponse ? 1 : 2);
    assert.equal(s.writes.length, 1);
    assert.equal(s.snapshot.accounts.find((a) => a.account_id === 'old').chow_current_account, 'successor');
  });
});

test('automatic CHOW link refuses interrupted recovery with changed successor evidence', async (t) => {
  const s = await chowLinkSetup(t), patch = s.client.patch;
  s.client.patch = async () => { throw new Error('Simulated timeout'); };
  await assert.rejects(s.decision(s.p, 'approve', s.link), /Patch not verified/);
  s.client.patch = patch;
  s.snapshot.accounts.find((a) => a.account_id === 'successor').outstanding_ar = 10;
  await assert.rejects(s.decision(s.p, 'resume', undefined), /evidence changed/i);
  assert.equal(s.writes.length, 0);
});

test('quality review acknowledgment can reopen with audit, survive reruns, and approve a different stored choice', async (t) => {
  const s = await reviewSetup(t), before = structuredClone(s.snapshot);
  await s.decision(s.p, 'approve', s.keep);
  const firstDecision = s.sql.prepare("SELECT id FROM decisions WHERE action='approve'").get();
  await assert.rejects(s.decision(s.p, 'reopen', s.keep, ' '), /Explain why/);
  await assert.rejects(s.decision(s.p, 'reopen', s.update), /does not match the saved review/);
  assert.equal(s.sql.prepare('SELECT COUNT(*) AS n FROM decisions').get().n, 1);
  assert.deepEqual(await s.decision(s.p, 'reopen', undefined), { status: 'pending' });
  assert.deepEqual(s.snapshot, before);
  assert.equal(s.writes.length, 0);
  assert.equal(s.sql.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 0);
  for (let pass = 0; pass < 2; pass++) {
    assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
    const state = await reviewState(s.ledger, 'live');
    assert.equal(state.proposals.find((p) => p.id === s.p.id && p.current)?.status, 'pending');
    const report = await operationalReport(s.db);
    assert.equal(report.current.review_backlog, 1);
    assert.equal(report.current.verification_required, 0);
  }
  await assert.rejects(s.decision(s.p, 'reopen', s.keep), /Only rejected/);
  await s.decision(s.p, 'approve', s.update);
  assert.equal(s.writes.length, 1, 'Only the newly approved correction writes to CRM');
  // Force timestamps and UUID ordering to disagree with insertion order.
  s.sql.prepare("UPDATE decisions SET created='2026-10-11T10:00:00.000Z'").run();
  s.sql.prepare("UPDATE decisions SET id='zz-old-approval' WHERE id=?").run(firstDecision.id);
  const second = s.sql.prepare("SELECT id FROM decisions WHERE action='approve' ORDER BY rowid DESC LIMIT 1").get();
  s.sql.prepare("UPDATE decisions SET id='aa-new-approval' WHERE id=?").run(second.id);
  const state = await reviewState(s.ledger, 'live');
  assert.equal(selectedOption(state.proposals.find((p) => p.id === s.p.id), state.decisions), s.update.id);
  assert.equal((await operationalReport(s.db)).history.verified_applied_cases, 1);
  assert.deepEqual(state.decisions.filter((d) => d.proposal_id === s.p.id).map((d) => d.action), ['approve', 'reopen', 'approve']);
  const audit = state.audits.find((a) => a.proposal_id === s.p.id && a.event === 'case_reopened');
  assert.equal(audit.data.previous_status, 'applied');
  assert.equal(audit.data.previous_option, s.keep.id);
  assert.equal(audit.data.crm_writes, 0);
  await assert.rejects(s.decision(s.p, 'reopen', s.keep), /Only rejected/);
  assert.equal(s.writes.length, 1);
});

test('quality review reopen requires its persisted zero-write approval and no operation checkpoints', async (t) => {
  for (const corrupt of ['missing approval', 'non-quality case', 'checkpoint', 'missing choice']) await t.test(corrupt, async (t) => {
    const s = await reviewSetup(t);
    await s.decision(s.p, 'approve', s.keep);
    if (corrupt === 'missing approval') s.sql.prepare('DELETE FROM decisions').run();
    if (corrupt === 'non-quality case') {
      const row = JSON.parse(s.sql.prepare('SELECT data FROM proposals WHERE id=?').get(s.p.id).data);
      row.kind = 'field_correction';
      s.sql.prepare('UPDATE proposals SET data=? WHERE id=?').run(JSON.stringify(row), s.p.id);
    }
    if (corrupt === 'missing choice') s.sql.prepare("UPDATE decisions SET option_id='unknown-choice'").run();
    if (corrupt === 'checkpoint') s.sql.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run('operation', s.p.id, 0, 'complete', '{}', '2026-10-11');
    const before = s.sql.prepare('SELECT COUNT(*) AS n FROM decisions').get().n;
    await assert.rejects(s.decision(s.p, 'reopen', s.keep), /Only rejected/);
    assert.equal(s.sql.prepare('SELECT status FROM proposals WHERE id=?').get(s.p.id).status, 'applied');
    assert.equal(s.sql.prepare('SELECT COUNT(*) AS n FROM decisions').get().n, before);
    assert.equal(s.writes.length, 0);
    assert.equal(s.sql.prepare('SELECT COUNT(*) AS n FROM locks').get().n, 0);
  });
});

test('quality review concurrent reopen requests record exactly one audited transition', async (t) => {
  const s = await reviewSetup(t);
  await s.decision(s.p, 'approve', s.keep);
  const results = await Promise.allSettled([s.decision(s.p, 'reopen', s.keep), s.decision(s.p, 'reopen', s.keep)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM decisions WHERE action='reopen'").get().n, 1);
  assert.equal(s.sql.prepare("SELECT COUNT(*) AS n FROM audits WHERE event='case_reopened'").get().n, 1);
  assert.equal(s.writes.length, 0);
});

test('a reopened quality review resumes its new interrupted approval instead of the older acknowledgment', async (t) => {
  const s = await reviewSetup(t);
  await s.decision(s.p, 'approve', s.keep);
  await s.decision(s.p, 'reopen', s.keep);
  const patch = s.client.patch;
  s.client.patch = async () => { throw new Error('Simulated upstream patch interruption'); };
  await assert.rejects(s.decision(s.p, 'approve', s.update), /Patch not verified/);
  s.sql.prepare("UPDATE decisions SET created='2026-10-11T10:00:00.000Z'").run();
  s.client.patch = patch;
  assert.deepEqual(await s.decision(s.p, 'resume', undefined), { status: 'applied' });
  assert.equal(s.writes.length, 1);
  assert.equal(s.snapshot.accounts[1].phone, s.facility.phone_raw);
  assert.equal((await operationalReport(s.db)).history.verified_applied_cases, 1);
});
