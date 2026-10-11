import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Ledger } from '../lib/ledger.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';
import { decide, runPipeline } from '../lib/engine.mjs';
import { stageManual, decideManual } from '../lib/manual.mjs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };

const identity = { actor: 'isolated test reviewer', session: 'cross-origin-test' };
const clone = (value) => structuredClone(value);
const input = (p, action = 'approve') => ({
  id: p.id,
  version: p.version,
  action,
  optionId: p.options[0].id,
  note: 'Review complete',
});
function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((file) =>
    file.endsWith('.sql')
  ))
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const ledger = new Ledger(sqliteD1(sqlite)),
    data = clone(baseline),
    writes = [];
  let failLink = true,
    loseCreate = false;
  const client = {
    accounts: async () => clone(data.accounts),
    contacts: async () => clone(data.contacts),
    get: async (id) => clone(data.accounts.find((account) => account.account_id === id)),
    getContact: async (id) => clone(data.contacts.find((contact) => contact.contact_id === id)),
    patch: async (id, fields) => {
      writes.push({ method: 'PATCH', id, fields: clone(fields) });
      if (failLink && fields.chow_current_account) throw new Error('simulated link timeout');
      Object.assign(
        data.accounts.find((account) => account.account_id === id),
        fields
      );
      return {};
    },
    create: async (fields) => {
      writes.push({ method: 'POST', fields: clone(fields) });
      if (loseCreate) throw new Error('uncertain create');
      const account = {
        ...fields,
        account_id: 'replacement-' + writes.length,
        chow_current_account: '',
        duplicate_of_account: '',
      };
      data.accounts.push(account);
      return clone(account);
    },
  };
  return {
    ledger,
    data,
    client,
    writes,
    getSnapshot: async () => clone(data),
    source: data.accounts.find((account) => account.name.includes('Tiffin')),
    parent: data.accounts.find(
      (account) => account.name === 'Bellhaven Senior Living (Parent Account)'
    ),
    failLink: (value) => (failLink = value),
    loseCreate: (value) => (loseCreate = value),
  };
}
async function pipelineTiffin(s) {
  await runPipeline(s.ledger, s.getSnapshot);
  const rows = await s.ledger.all("SELECT data FROM proposals WHERE status='pending'");
  return rows
    .map((row) => JSON.parse(row.data))
    .find((p) => !p.manual && p.title.includes('Tiffin'));
}
const stage = (s, fields, recordId = s.source.account_id, entity = 'accounts') =>
  stageManual(
    s.ledger,
    s.client,
    { entity, ...(recordId ? { recordId } : {}), fields, note: 'Explicit reviewed correction' },
    identity
  );
const overlap = /interrupted approved work/;

test('billing: interrupted manual CHOW blocks a pipeline replacement and resumes the first account', async (t) => {
  const s = setup(t),
    manual = await stage(s, { parent_id: s.parent.account_id });
  await assert.rejects(
    decideManual(s.ledger, s.client, input(manual), identity),
    /CHOW link not verified/
  );
  const p = await pipelineTiffin(s),
    count = s.writes.length;
  assert.equal(p.kind, 'chow');
  await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), overlap);
  assert.equal(s.writes.length, count);
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', manual.id)).status,
    'partial'
  );
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
    'pending'
  );
  s.failLink(false);
  await decideManual(s.ledger, s.client, input(manual, 'resume'), identity);
  assert.equal(s.writes.filter((write) => write.method === 'POST').length, 1);
  assert.equal(s.source.chow_current_account, 'replacement-1');
});

test('reviewer: pipeline CHOW reserves its source, replacement, contacts and physical location from manual staging', async (t) => {
  const s = setup(t),
    p = await pipelineTiffin(s);
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    /CHOW link not verified/
  );
  const count = s.writes.length;
  await assert.rejects(stage(s, { name: 'Updated source name' }), overlap);
  await assert.rejects(stage(s, { name: 'Updated replacement' }, 'replacement-1'), overlap);
  await assert.rejects(
    stage(s, { name: 'New administrator', account_id: s.source.account_id }, null, 'contacts'),
    overlap
  );
  await assert.rejects(
    stage(
      s,
      {
        name: 'Renamed replacement',
        parent_id: s.source.parent_id,
        billing_street: p.facility.street_address,
        billing_city: p.facility.city,
        billing_state: p.facility.state,
      },
      null
    ),
    overlap
  );
  assert.equal(s.writes.length, count);
  s.failLink(false);
  await decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity);
  assert.equal(s.writes.filter((write) => write.method === 'POST').length, 1);
});

test('reviewer: a manual draft staged before a pipeline interruption cannot bypass its reservation', async (t) => {
  const s = setup(t),
    manual = await stage(s, { name: 'Reviewer-proposed Tiffin name' }),
    p = await pipelineTiffin(s);
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    /CHOW link not verified/
  );
  const count = s.writes.length;
  await assert.rejects(decideManual(s.ledger, s.client, input(manual), identity), overlap);
  assert.equal(s.writes.length, count);
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', manual.id)).status,
    'pending'
  );
});

test('operator: an uncertain manual creation reserves its physical identity before any returned ID exists', async (t) => {
  const s = setup(t),
    facility = s.data.facilities.find((f) => f.name.includes('Tiffin')),
    manual = await stage(
      s,
      {
        name: facility.name,
        parent_id: s.parent.account_id,
        billing_street: facility.street_address,
        billing_city: facility.city,
        billing_state: facility.state,
      },
      null
    );
  s.loseCreate(true);
  await assert.rejects(
    decideManual(s.ledger, s.client, input(manual), identity),
    /Creation outcome is uncertain/
  );
  const p = await pipelineTiffin(s),
    count = s.writes.length;
  await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), overlap);
  assert.equal(s.writes.length, count);
  assert.equal(s.writes.filter((write) => write.method === 'POST').length, 1);
});

test('operator: an interrupted facility does not block unrelated reviewed work under the same parent', async (t) => {
  const s = setup(t),
    p = await pipelineTiffin(s);
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    /CHOW link not verified/
  );
  const unrelated = s.data.accounts.find(
      (a) =>
        a.parent_id === s.parent.account_id &&
        !a.chow_current_account &&
        !a.duplicate_of_account &&
        a.account_id !== s.source.account_id
    ),
    manual = await stage(s, { note: 'Independent account review' }, unrelated.account_id);
  await decideManual(s.ledger, s.client, input(manual), identity);
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', manual.id)).status,
    'applied'
  );
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
    'partial'
  );
});
