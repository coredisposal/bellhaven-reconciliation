import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };
import { reconcile } from '../lib/core.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { runPipeline, decide } from '../lib/engine.mjs';
import { operationalReport, currentCaseRows } from '../lib/reporting.mjs';
import { reviewState } from '../lib/state.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';

const copy = structuredClone;
function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) => f.endsWith('.sql')))
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const d1 = sqliteD1(sqlite), ledger = new Ledger(d1);
  const facility = copy(baseline.facilities.find((f) => f.name === 'Amberly Manor'));
  const data = {
    accounts: copy(baseline.accounts.filter((a) => a.name === facility.name || a.name.includes('(Parent Account)'))),
    contacts: [], facilities: [facility], coverage: { complete: true, found: 1, expected: 1 },
  };
  const client = {
    accounts: async () => copy(data.accounts),
    get: async (id) => copy(data.accounts.find((a) => a.account_id === id)),
    create: async (fields) => {
      const account = { ...copy(fields), account_id: 'created-example', chow_current_account: '', duplicate_of_account: '' };
      data.accounts.push(account);
      return copy(account);
    },
    patch: async (id, fields) => {
      const account = data.accounts.find((a) => a.account_id === id);
      Object.assign(account, fields);
      return copy(account);
    },
  };
  return { sqlite, d1, ledger, data, client, getSnapshot: async () => copy(data) };
}
const row = async (s) => (await reconcile(s.data)).find((p) => p.title === 'Amberly Manor');
const decision = (s, p, action, optionId = 'separate') => decide(s.ledger, s.client, s.getSnapshot, {
  id: p.id, version: p.version, action, optionId,
  note: 'Verified independent facility identity and the displayed changes.',
}, { actor: 'test reviewer', session: 'test-current-case' });

test('current case: approving an older reopened proposal keeps newer rejected history without selecting it as current', async (t) => {
  const s = setup(t);
  await runPipeline(s.ledger, s.getSnapshot);
  const first = await row(s);
  await decision(s, first, 'reject');
  const initialZip = s.data.facilities[0].postal_code;
  s.data.facilities[0].postal_code = '44444';
  await runPipeline(s.ledger, s.getSnapshot);
  const newer = await row(s);
  await decision(s, newer, 'reject');
  s.data.facilities[0].postal_code = initialZip;
  await runPipeline(s.ledger, s.getSnapshot);
  await decision(s, first, 'reopen');
  await decision(s, first, 'approve');
  await runPipeline(s.ledger, s.getSnapshot);
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.proposals.length, 2, 'Both decisions remain visible in history');
  assert.equal(state.proposals[0].id, newer.id, 'History retains original chronology');
  assert.equal(state.proposals[0].current, false);
  const current = state.proposals.filter((p) => p.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].id, first.id);
  assert.equal(current[0].status, 'applied');
  const report = await operationalReport(s.d1);
  assert.equal(report.current.applied, 1);
  assert.equal(report.current.rejected, 0);
  assert.equal(report.current.review_backlog, 0);
});

test('current case: materially changed pending evidence outranks old accepted identity resolution', async (t) => {
  const s = setup(t);
  await runPipeline(s.ledger, s.getSnapshot);
  const first = await row(s);
  await decision(s, first, 'approve');
  await runPipeline(s.ledger, s.getSnapshot);
  s.data.facilities[0].postal_code = '44444';
  await runPipeline(s.ledger, s.getSnapshot);
  const changed = await row(s);
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.proposals.find((p) => p.id === first.id).current, false);
  assert.equal(state.proposals.find((p) => p.id === changed.id).current, true);
  assert.equal(state.proposals.filter((p) => p.current).length, 1);
  const report = await operationalReport(s.d1);
  assert.equal(report.current.applied, 0);
  assert.equal(report.current.review_backlog, 1);
  assert.equal(report.current.missing_ledger_rows, 0);
});

test('current case: only the latest approval can match its accepted outcome, with interrupted work taking priority', async (t) => {
  const s = setup(t);
  await runPipeline(s.ledger, s.getSnapshot);
  const first = await row(s);
  await decision(s, first, 'approve');
  await runPipeline(s.ledger, s.getSnapshot);
  const accepted = await row(s);
  // A retained direct-evidence row must not shadow the later approved decision
  // which explicitly resolved this same outcome.
  s.sqlite.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(
    accepted.id, accepted.key, accepted.version, 'older-run', 'rejected',
    JSON.stringify(accepted), '2099-01-01T00:00:00.000Z');
  assert.equal((await currentCaseRows(s.d1, s.data))[0].proposal_id, first.id);
  assert.equal((await operationalReport(s.d1)).current.applied, 1);
  s.sqlite.prepare("UPDATE proposals SET status='partial' WHERE id=?").run(accepted.id);
  assert.equal((await currentCaseRows(s.d1, s.data))[0].proposal_id, accepted.id);
  assert.equal((await operationalReport(s.d1)).current.by_state.find((s) => s.state === 'partial').total, 1);
});
