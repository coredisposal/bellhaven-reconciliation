import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { reconcile as facilityReconciliation } from '../lib/core.mjs';
import { reconcile } from '../lib/reconciliation.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';

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
