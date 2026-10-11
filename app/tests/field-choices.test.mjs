import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };
import { reconcile, digest } from '../lib/core.mjs';
import { runPipeline, decide } from '../lib/engine.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { operationalReport } from '../lib/reporting.mjs';
import { reviewState } from '../lib/state.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';

const clone = structuredClone;
const identity = { actor: 'test reviewer', session: 'field-choice-review' };
function setup(t, title = 'Findlay') {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((name) => name.endsWith('.sql')))
    db.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const data = clone(baseline);
  data.facilities = data.facilities.filter((facility) => facility.name.includes(title));
  const facility = data.facilities[0];
  data.accounts = data.accounts.filter((account) => account.name.includes(title) || /\(Parent Account\)$/.test(account.name));
  data.contacts = data.contacts.filter((contact) => data.accounts.some((account) => account.account_id === contact.account_id));
  data.coverage = { complete: true, expected: 1, found: 1, urls: [facility.source_url] };
  const writes = [];
  const client = {
    accounts: async () => clone(data.accounts),
    get: async (id) => clone(data.accounts.find((account) => account.account_id === id)),
    patch: async (id, fields) => {
      writes.push({ id, fields: clone(fields) });
      Object.assign(data.accounts.find((account) => account.account_id === id), fields);
      return client.get(id);
    },
    create: async (fields) => {
      const account = { ...clone(fields), account_id: 'created-account', chow_current_account: '', duplicate_of_account: '' };
      data.accounts.push(account);
      writes.push({ create: clone(account) });
      return clone(account);
    },
  };
  const d1 = sqliteD1(db);
  return { db, d1, ledger: new Ledger(d1), data, writes, client, snapshot: async () => clone(data) };
}
const current = async (s) => (await reconcile(s.data))[0];
const input = (p, option, action = 'approve') => ({
  id: p.id, version: p.version, action, optionId: option.id, note: 'Reviewed the source and selected field values.',
});
async function apply(s, p, choice) {
  return decide(s.ledger, s.client, s.snapshot, input(p, choice), identity);
}
async function assertClosed(s, p) {
  s.ledger = new Ledger(s.d1);
  for (let i = 0; i < 2; i++) assert.equal((await runPipeline(s.ledger, s.snapshot)).new_proposals, 0);
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.proposals.find((row) => row.id === p.id).current, true);
  const report = await operationalReport(s.d1);
  assert.equal(report.current.missing_ledger_rows, 0);
  assert.equal(report.current.applied, 1);
}

test('field choices: Findlay offers only mapped scalar categories and exact phone choices without changing mandatory parent', async (t) => {
  const s = setup(t), p = await current(s);
  const a = p.candidates[0].account;
  assert(p.compatibility_version);
  assert.deepEqual(p.options[0].field_choices.care_type, {
    current: 'Assisted Living', values: ['Assisted Living', 'Memory Care'], selected: null,
  });
  assert.equal(p.options[0].field_choices.phone.selected, false);
  for (const option of p.options) {
    const fields = option.operations[0].fields;
    assert.equal(fields.parent_id, p.parent.account_id);
    assert.match(fields.note, /Assisted Living; Memory Support/);
    if (option.field_choices.phone.selected) assert.equal(fields.phone, p.facility.phone_raw);
    else assert(!Object.hasOwn(fields, 'phone'));
    if (option.field_choices.care_type.selected === 'Memory Care') assert.equal(fields.care_type, 'Memory Care');
    else assert(!Object.hasOwn(fields, 'care_type'));
    assert.equal(option.operations[0].before.phone, a.phone);
    assert(!Object.hasOwn(fields, 'lifetime_revenue'));
  }
  assert.equal(new Set(p.options.map((option) => option.id)).size, p.options.length);
  assert(!p.options.some((option) => option.operations.some((op) => Array.isArray(op.fields.care_type))));
});

for (const selected of [null, 'Assisted Living', 'Memory Care']) {
  test(`field choices: ${selected ?? 'keep current'} and phone persist as one approval across restart and two refreshes`, async (t) => {
    const s = setup(t);
    await runPipeline(s.ledger, s.snapshot);
    const p = await current(s);
    const choice = p.options.find((option) => option.field_choices.phone.selected && option.field_choices.care_type.selected === selected);
    await apply(s, p, choice);
    const updated = s.data.accounts.find((account) => account.account_id === p.candidates[0].account.account_id);
    assert.equal(updated.phone, p.facility.phone_raw);
    assert.equal(updated.care_type, selected ?? 'Assisted Living');
    assert.equal(s.writes.length, 1);
    await assertClosed(s, p);
    assert.equal(s.writes.length, 1);
    assert.equal(s.db.prepare('SELECT option_id FROM decisions').get().option_id, choice.id);
  });
}

test('field choices: unchanged phone and care stay untouched while mandatory parent correction is applied', async (t) => {
  const s = setup(t), before = clone(s.data.accounts.find((account) => account.name.includes('Findlay')));
  await runPipeline(s.ledger, s.snapshot);
  const p = await current(s);
  await apply(s, p, p.options[0]);
  const after = s.data.accounts.find((account) => account.account_id === before.account_id);
  assert.equal(after.phone, before.phone);
  assert.equal(after.care_type, before.care_type);
  assert.equal(after.parent_id, p.parent.account_id);
  await assertClosed(s, p);
});

test('field choices: a care-only keep-current decision is durable and audited without any CRM call', async (t) => {
  const s = setup(t);
  const a = s.data.accounts.find((account) => account.name.includes('Findlay'));
  const parent = s.data.accounts.find((account) => /^Bellhaven Senior Living/.test(account.name));
  const f = s.data.facilities[0];
  Object.assign(a, { parent_id: parent.account_id, phone: f.phone_raw, care_type: 'Skilled Nursing' });
  f.care_offerings = ['Assisted Living'];
  await runPipeline(s.ledger, s.snapshot);
  const p = await current(s), keep = p.options[0];
  assert.equal(p.kind, 'field_correction');
  assert.deepEqual(keep.operations, []);
  assert.equal(keep.field_choices.care_type.selected, null);
  await apply(s, p, keep);
  assert.deepEqual(s.writes, []);
  assert.equal(a.care_type, 'Skilled Nursing');
  await assertClosed(s, p);
  assert.equal((await operationalReport(s.d1)).history.verified_applied_cases, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audits WHERE event='field_selection_verified'").get().n, 1);
});

test('field choices: source drift invalidates a selected variant and fabricated categories are unavailable', async (t) => {
  const s = setup(t);
  await runPipeline(s.ledger, s.snapshot);
  const p = await current(s);
  await assert.rejects(decide(s.ledger, s.client, s.snapshot, { ...input(p, p.options[0]), optionId: 'arbitrary-fields' }, identity), /server-stored/);
  s.data.facilities[0].phone_raw = '(216) 555-0144';
  await assert.rejects(apply(s, p, p.options.at(-1)), /stale/);
  assert.deepEqual(s.writes, []);
});

async function legacyFindlay(s) {
  const p = await current(s);
  const options = p.options.filter((option) => option.id === option.base_option_id).map((choice) => {
    const option = clone(choice);
    delete option.base_option_id;
    delete option.field_choices;
    return option;
  });
  const material = clone(p.material);
  delete material.field_choice_rule;
  material.options = options.map(({ id, operations }) => ({ id, operations: operations.map((operation) => {
    const op = clone(operation);
    delete op.before;
    return op;
  }) }));
  assert.equal(await digest(material), p.compatibility_version);
  const { compatibility_version, ...legacy } = p;
  return { ...legacy, id: compatibility_version, version: compatibility_version, options, material };
}
async function storeLegacy(s, p, status = 'pending') {
  await s.ledger.run('INSERT INTO runs(id,status,started,data) VALUES(?,?,?,?)', 'legacy-run', 'complete', '2026-10-10T23:00:00Z', JSON.stringify({ snapshot: s.data }));
  await s.ledger.run('INSERT INTO proposals(id,case_key,version,run_id,status,data,created) VALUES(?,?,?,?,?,?,?)',
    p.id, p.key, p.version, 'legacy-run', status, JSON.stringify(p), '2026-10-10T23:00:00Z');
}

test('field choices: pre-feature rejections remain closed, current and reportable after upgrade', async (t) => {
  const s = setup(t), p = await legacyFindlay(s);
  await storeLegacy(s, p);
  await decide(s.ledger, s.client, s.snapshot, input(p, p.options[0], 'reject'), identity);
  for (let i = 0; i < 2; i++) assert.equal((await runPipeline(s.ledger, s.snapshot)).new_proposals, 0);
  const report = await operationalReport(s.d1);
  assert.equal(report.current.rejected, 1);
  assert.equal(report.current.missing_ledger_rows, 0);
  assert.equal((await reviewState(s.ledger, 'live')).proposals.find((row) => row.id === p.id).current, true);
  assert.deepEqual(s.writes, []);
});

test('field choices: a pre-feature stored approval can finish its original exact option after upgrade', async (t) => {
  const s = setup(t), p = await legacyFindlay(s);
  await storeLegacy(s, p);
  await apply(s, p, p.options[0]);
  assert.equal(s.writes.length, 1);
  assert(!Object.hasOwn(s.writes[0].fields, 'phone'));
  for (let i = 0; i < 2; i++) assert.equal((await runPipeline(s.ledger, s.snapshot)).new_proposals, 0);
  assert.equal((await operationalReport(s.d1)).current.missing_ledger_rows, 0);
});

test('field choices: a legacy version cannot silently add a newly available phone selection', async (t) => {
  const s = setup(t), p = await legacyFindlay(s);
  p.options[0].operations[0].fields.phone = p.facility.phone_raw;
  await storeLegacy(s, p);
  await assert.rejects(apply(s, p, p.options[0]), /Evidence changed/);
  assert.deepEqual(s.writes, []);
  assert.equal((await s.ledger.all('SELECT * FROM decisions')).length, 0);
});

test('field choices: a legacy interrupted CHOW resumes its stored original fields after upgrade', async (t) => {
  const s = setup(t, 'Tiffin'), p = await legacyFindlay(s);
  const before = clone(p.candidates[0].account);
  await storeLegacy(s, p);
  const patch = s.client.patch;
  s.client.patch = async () => { throw new Error('Injected link timeout'); };
  await assert.rejects(apply(s, p, p.options[0]), /CHOW link not verified/);
  assert.equal(s.writes.length, 1);
  assert.equal((await runPipeline(s.ledger, s.snapshot)).new_proposals, 0);
  s.client.patch = patch;
  s.ledger = new Ledger(s.d1);
  await decide(s.ledger, s.client, s.snapshot, input(p, p.options[0], 'resume'), identity);
  const original = s.data.accounts.find((account) => account.account_id === before.account_id);
  assert.deepEqual(original, { ...before, chow_current_account: 'created-account' });
  assert.equal(s.writes.filter((write) => write.create).length, 1);
  for (let i = 0; i < 2; i++) assert.equal((await runPipeline(s.ledger, s.snapshot)).new_proposals, 0);
});

test('field choices: interrupted CHOW remembers selected care and phone only on the replacement', async (t) => {
  const s = setup(t, 'Tiffin');
  s.data.facilities[0].care_offerings.push('Memory Support');
  await runPipeline(s.ledger, s.snapshot);
  const p = await current(s), before = clone(p.candidates[0].account);
  const choice = p.options.find((option) => option.field_choices.care_type?.selected === 'Memory Care' && option.field_choices.phone?.selected === false);
  assert(choice);
  const patch = s.client.patch;
  s.client.patch = async () => { throw new Error('Injected link timeout'); };
  await assert.rejects(apply(s, p, choice), /CHOW link not verified/);
  assert.equal(s.writes.length, 1);
  const replacement = s.data.accounts.find((account) => account.account_id === 'created-account');
  assert.equal(replacement.phone, before.phone);
  assert.equal(replacement.care_type, 'Memory Care');
  assert.equal(replacement.lifetime_revenue, 0);
  assert.equal(replacement.outstanding_ar, 0);
  assert.deepEqual(s.data.accounts.find((account) => account.account_id === before.account_id), before);
  s.client.patch = patch;
  await decide(s.ledger, s.client, s.snapshot, input(p, p.options[0], 'resume'), identity);
  assert.deepEqual(s.data.accounts.find((account) => account.account_id === before.account_id), { ...before, chow_current_account: replacement.account_id });
  assert.deepEqual(s.writes[1].fields, { chow_current_account: replacement.account_id });
  assert.equal(s.writes.filter((write) => write.create).length, 1);
  await assertClosed(s, p);
});

test('field choices: duplicate-only survivor gains its selected patch before retirement, without editing loser identity', async (t) => {
  const s = setup(t), a = s.data.accounts.find((account) => account.name.includes('Findlay'));
  const parent = s.data.accounts.find((account) => /^Bellhaven Senior Living/.test(account.name));
  s.data.facilities[0].care_offerings = ['Assisted Living'];
  a.parent_id = parent.account_id;
  s.data.accounts.push({ ...clone(a), account_id: 'unbilled-copy', lifetime_revenue: 0, outstanding_ar: 0 });
  await runPipeline(s.ledger, s.snapshot);
  const p = await current(s), choice = p.options.find((option) => !option.resolution && option.field_choices.phone?.selected);
  assert.equal(choice.operations[0].type, 'patch');
  assert.equal(choice.operations[0].account_id, a.account_id);
  assert.deepEqual(choice.operations[0].fields, { phone: p.facility.phone_raw });
  assert.equal(choice.operations[1].type, 'duplicate');
  await apply(s, p, choice);
  assert.equal(a.phone, p.facility.phone_raw);
  assert.equal(s.data.accounts.find((account) => account.account_id === 'unbilled-copy').duplicate_of_account, a.account_id);
  await assertClosed(s, p);
});

test('field choices: update-only duplicate Keep current may be a verified zero-write identity choice', async (t) => {
  const s = setup(t), a = s.data.accounts.find((account) => account.name.includes('Findlay'));
  const parent = s.data.accounts.find((account) => /^Bellhaven Senior Living/.test(account.name));
  const f = s.data.facilities[0];
  f.care_offerings = ['Assisted Living'];
  Object.assign(a, { parent_id: parent.account_id, phone: f.phone_raw, care_type: 'Skilled Nursing' });
  s.data.accounts.push({ ...clone(a), account_id: 'unbilled-copy', lifetime_revenue: 0, outstanding_ar: 0 });
  await runPipeline(s.ledger, s.snapshot);
  const p = await current(s), choice = p.options.find((option) => option.resolution === 'existing' && option.field_choices.care_type.selected === null);
  assert.deepEqual(choice.operations, []);
  await apply(s, p, choice);
  assert.deepEqual(s.writes, []);
  await assertClosed(s, p);
  assert.equal((await operationalReport(s.d1)).current.verification_required, 0);
});

test('field choices: creation maps the first supported care offering and preserves unknown offerings in notes', async (t) => {
  const s = setup(t, 'Batavia');
  s.data.facilities[0].care_offerings = ['Hospice coordination', 'Assisted Living'];
  const p = await current(s), fields = p.options[0].operations[0].fields;
  assert.equal(p.kind, 'new_account');
  assert.equal(fields.care_type, 'Assisted Living');
  assert.match(fields.note, /Hospice coordination; Assisted Living/);
});
