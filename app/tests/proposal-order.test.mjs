import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };
import { reconcile } from '../lib/core.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { runPipeline, decide } from '../lib/engine.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';

const copy = (value) => structuredClone(value);
const reversed = (snapshot) => ({
  ...copy(snapshot),
  accounts: copy(snapshot.accounts).reverse(),
  contacts: copy(snapshot.contacts).reverse(),
});
const versions = (rows) => Object.fromEntries(rows.map((p) => [p.key, p.version]));
const identity = { actor: 'test reviewer', session: 'permutation-test' };
const input = (p, action) => ({
  id: p.id,
  version: p.version,
  action,
  optionId: p.options[0]?.id,
  note: 'Reviewed the saved location and account evidence.',
});

function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) =>
    f.endsWith('.sql')
  ))
    db.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const ledger = new Ledger(sqliteD1(db));
  const data = copy(baseline),
    writes = [];
  const client = {
    accounts: async () => copy(data.accounts),
    contacts: async () => copy(data.contacts),
    get: async (id) => copy(data.accounts.find((a) => a.account_id === id)),
    patch: async (id, fields) => {
      writes.push({ id, fields: copy(fields) });
      const record = data.accounts.find((a) => a.account_id === id);
      Object.assign(record, fields);
      return copy(record);
    },
    create: async () => {
      throw Error('This journey must not create an account');
    },
  };
  return { db, ledger, data, writes, client, getSnapshot: async () => copy(data) };
}

function addContacts(data, title) {
  const account = data.accounts.find((a) => a.name.includes(title));
  for (let i = 0; i < 2; i++)
    data.contacts.push({
      contact_id: `order-${title}-${i}`,
      account_id: account.account_id,
      name: `Contact ${i}`,
      title: 'Administrator',
      is_active: true,
    });
}

test('reconciliation identity is unchanged by account/contact response order', async () => {
  const data = copy(baseline);
  addContacts(data, 'Portsmouth');
  assert.deepEqual(versions(await reconcile(reversed(data))), versions(await reconcile(data)));
});

test('equal-priority alternatives have stable membership at the eight-record display boundary', async () => {
  const data = copy(baseline);
  const facility = data.facilities.find((f) => f.name.includes('Portsmouth'));
  const current = data.accounts.find((a) => a.name.includes('Portsmouth'));
  for (let i = 0; i < 12; i++)
    data.accounts.push({
      ...copy(current),
      account_id: `alternative-${String(i).padStart(2, '0')}`,
      name: 'Unconfirmed nearby facility',
      billing_street: `${800 + i} Other Road`,
      parent_id: '',
      parent_name: '',
      phone: '',
      lifetime_revenue: 0,
      outstanding_ar: 0,
    });
  const original = (await reconcile(data)).find((p) => p.key === facility.source_url);
  const reordered = (await reconcile(reversed(data))).find((p) => p.key === facility.source_url);
  assert.equal(original.alternatives.length, 8);
  assert.deepEqual(
    reordered.alternatives.map((c) => c.account.account_id),
    original.alternatives.map((c) => c.account.account_id)
  );
  assert.equal(reordered.version, original.version);
});

test('historical link evidence remains stable when account rows arrive in a different order', async () => {
  const data = copy(baseline);
  const current = data.accounts.find((a) => a.name.includes('Portsmouth'));
  for (let i = 0; i < 2; i++)
    data.accounts.push({
      ...copy(current),
      account_id: `historical-${i}`,
      name: `Historical Portsmouth ${i}`,
      chow_current_account: current.account_id,
    });
  const before = (await reconcile(data)).find((p) => p.title.includes('Portsmouth'));
  const after = (await reconcile(reversed(data))).find((p) => p.title.includes('Portsmouth'));
  assert.equal(before.linked_accounts.length, 2);
  assert.deepEqual(after.material.linked_accounts, before.material.linked_accounts);
  assert.equal(after.version, before.version);
});

test('a persisted rejection stays closed after account/contact pagination order changes', async (t) => {
  const s = setup(t);
  addContacts(s.data, 'Portsmouth');
  await runPipeline(s.ledger, s.getSnapshot);
  const p = (await reconcile(s.data)).find((p) => p.title.includes('Portsmouth'));
  await decide(s.ledger, s.client, s.getSnapshot, input(p, 'reject'), identity);
  s.data.accounts.reverse();
  s.data.contacts.reverse();
  const repeat = await runPipeline(s.ledger, s.getSnapshot);
  assert.equal(repeat.new_proposals, 0);
  assert.deepEqual(
    s.db
      .prepare('SELECT id,status FROM proposals WHERE case_key=?')
      .all(p.key)
      .map((row) => ({ ...row })),
    [{ id: p.id, status: 'rejected' }]
  );
  assert.equal(s.writes.length, 0);
});

test('a pending approval remains valid when only the API response ordering changes', async (t) => {
  const s = setup(t);
  addContacts(s.data, 'Portsmouth');
  await runPipeline(s.ledger, s.getSnapshot);
  const p = (await reconcile(s.data)).find((p) => p.title.includes('Portsmouth'));
  s.data.accounts.reverse();
  s.data.contacts.reverse();
  await decide(s.ledger, s.client, s.getSnapshot, input(p, 'approve'), identity);
  assert.equal(s.db.prepare('SELECT status FROM proposals WHERE id=?').get(p.id).status, 'applied');
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].fields.billing_zip, '45662');
});

test('an exact-name identity conflict requires a supported resolution and rejection persists across identical reruns', async (t) => {
  const s = setup(t);
  await runPipeline(s.ledger, s.getSnapshot);
  const p = (await reconcile(s.data)).find((row) => row.title === 'Amberly Manor');
  assert.equal(p.kind, 'ambiguous');
  assert(p.options.some((o) => o.resolution === 'separate'));
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, {...input(p, 'approve'), optionId: 'unreviewed'}, identity),
    /available server-stored operation/i
  );
  assert.equal(s.writes.length, 0);
  await decide(s.ledger, s.client, s.getSnapshot, input(p, 'reject'), identity);
  s.data.accounts.reverse();
  s.data.contacts.reverse();
  const repeat = await runPipeline(s.ledger, s.getSnapshot);
  assert.equal(repeat.new_proposals, 0);
  assert.deepEqual(
    s.db.prepare('SELECT id,status FROM proposals WHERE case_key=?').all(p.key)
      .map((row) => ({ ...row })),
    [{ id: p.id, status: 'rejected' }]
  );
  assert.equal(s.writes.length, 0);
});

test('a corroborated address conflict keeps one reason and remains rejected on rerun', async (t) => {
  const s = setup(t);
  const account = s.data.accounts.find((row) => row.name.includes('New Carlisle'));
  account.billing_street = '';
  await runPipeline(s.ledger, s.getSnapshot);
  const p = (await reconcile(s.data)).find((row) => row.title.includes('New Carlisle'));
  assert.equal(p.kind, 'ambiguous');
  assert(p.options.some((o) => o.resolution === 'existing'));
  assert.deepEqual(p.matching_conflicts.map((conflict) => conflict.kind), ['address_conflict']);
  await decide(s.ledger, s.client, s.getSnapshot, input(p, 'reject'), identity);
  s.data.accounts.reverse();
  s.data.contacts.reverse();
  const current = (await reconcile(s.data)).find((row) => row.key === p.key);
  assert.equal(current.version, p.version);
  const repeat = await runPipeline(s.ledger, s.getSnapshot);
  assert.equal(repeat.new_proposals, 0);
  assert.deepEqual(
    s.db.prepare('SELECT id,status FROM proposals WHERE case_key=?').all(p.key)
      .map((row) => ({ ...row })),
    [{ id: p.id, status: 'rejected' }]
  );
  assert.equal(s.writes.length, 0);
});
