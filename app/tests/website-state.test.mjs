import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Ledger } from '../lib/ledger.mjs';
import { reviewState } from '../lib/state.mjs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };

const AT = '2026-10-10T12:00:00.000Z';
function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) =>
    f.endsWith('.sql')
  ))
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const ledger = new Ledger({
    prepare(sql) {
      assert.match(sql, /^SELECT /, 'Locations response may only read the ledger');
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async all() {
          return { results: statement.all(...args) };
        },
      };
    },
  });
  const insertRun = (id, data, { started = AT, status = 'complete' } = {}) =>
    sqlite
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?)')
      .run(id, status, started, status === 'running' ? null : started, JSON.stringify(data));
  return { sqlite, ledger, insertRun };
}

test('website state is explicitly empty before collection, independent of proposal-derived facilities', async (t) => {
  const s = setup(t);
  s.sqlite.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(
    'proposal',
    'case',
    'version',
    'unknown-run',
    'pending',
    JSON.stringify({ title: 'Proposal-only facility', facility: baseline.facilities[0] }),
    AT
  );
  s.insertRun('failed', { error: 'Unavailable', snapshot: baseline }, { status: 'failed' });
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.website, null);
  assert.equal(state.proposals.length, 1);
});

test('website state skips legacy completed runs without a valid facilities array', async (t) => {
  const s = setup(t);
  s.insertRun('legacy-only', { snapshot: { coverage: { complete: true } } });
  assert.equal((await reviewState(s.ledger, 'live')).website, null);
  s.insertRun('collected', { snapshot: baseline }, { started: '2026-10-11T12:00:00.000Z' });
  s.insertRun(
    'invalid-newer',
    { snapshot: { facilities: {}, coverage: { complete: true } } },
    { started: '2026-10-12T12:00:00.000Z' }
  );
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.website.run_id, 'collected');
  assert.deepEqual(state.website.facilities, baseline.facilities);
});

test('website state returns all 35 saved rows and mandatory fields, preserving complete multi-care evidence', async (t) => {
  const s = setup(t);
  s.insertRun('collected', { snapshot: baseline });
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.website.run_id, 'collected');
  assert.equal(state.website.collected_at, AT, 'Legacy snapshots use persisted completion time');
  assert.deepEqual(state.website.coverage, { complete: true, expected: 35, found: 35 });
  assert.deepEqual(state.website.facilities, baseline.facilities);
  assert.deepEqual(state.proposals, []);
  for (const facility of state.website.facilities) {
    for (const key of [
      'name', 'street_address', 'city', 'state', 'postal_code',
      'administrator', 'phone_raw', 'source_url', 'retrieved_at_utc',
    ]) {
      assert.equal(typeof facility[key], 'string', `${facility.name}: ${key}`);
      assert(facility[key].trim(), `${facility.name}: missing ${key}`);
    }
    assert(facility.care_offerings.length > 0);
  }
  for (const city of ['Findlay', 'Erie'])
    assert.deepEqual(
      state.website.facilities.find((f) => f.city === city).care_offerings,
      ['Assisted Living', 'Memory Support']
    );
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS n FROM decisions').get().n, 0);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 0);
});

test('website state survives more than 20 failed refreshes and decided or superseded proposal history', async (t) => {
  const s = setup(t);
  s.insertRun('saved', { snapshot: baseline });
  for (let i = 1; i <= 25; i++)
    s.insertRun(
      `failed-${i}`,
      { error: 'Source unavailable' },
      { started: new Date(Date.parse(AT) + i * 60000).toISOString(), status: 'failed' }
    );
  for (const [i, status] of ['applied', 'rejected', 'superseded'].entries()) {
    s.sqlite.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(
      `proposal-${i}`,
      `case-${i}`,
      `version-${i}`,
      'saved',
      status,
      JSON.stringify({ title: 'Altered proposal display', facility: { name: 'Not scraper output' } }),
      AT
    );
    s.sqlite.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?)').run(
      `decision-${i}`,
      `proposal-${i}`,
      status === 'applied' ? 'approve' : 'reject',
      null,
      'anonymous',
      'private-session',
      'Reviewed',
      AT
    );
  }
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.runs.length, 20);
  assert(!state.runs.some((r) => r.id === 'saved'));
  assert.equal(state.website.run_id, 'saved');
  assert.deepEqual(state.website.facilities, baseline.facilities);
  assert.equal(state.proposals.length, 2);
  assert.equal(state.decisions.length, 3);
});

test('website state replaces collection on successful refresh and does not claim incomplete coverage is complete', async (t) => {
  const s = setup(t);
  s.insertRun('original', { snapshot: baseline });
  const next = structuredClone(baseline);
  next.facilities[0].administrator = 'Updated administrator';
  next.facilities.pop();
  next.coverage.complete = false;
  next.retrieved_at = '2026-10-11T12:00:00.000Z';
  s.insertRun('latest', { snapshot: next }, { started: next.retrieved_at });
  const state = await reviewState(s.ledger, 'live');
  assert.equal(state.website.run_id, 'latest');
  assert.equal(state.website.collected_at, next.retrieved_at);
  assert.deepEqual(state.website.coverage, { complete: false, expected: 35, found: 34 });
  assert.equal(state.website.facilities[0].administrator, 'Updated administrator');
});

test('a later failed refresh remains first when run timestamps tie, without replacing saved locations', async (t) => {
  const s = setup(t);
  s.insertRun('saved', { snapshot: baseline });
  s.insertRun('failed', { error: 'Source unavailable' }, { status: 'failed' });
  const state = await reviewState(s.ledger, 'live');
  assert.deepEqual(state.runs.map((run) => run.id), ['failed', 'saved']);
  assert.equal(state.runs[0].status, 'failed');
  assert.equal(state.website.run_id, 'saved');
  assert.deepEqual(state.website.facilities, baseline.facilities);
});

test('website state redacts accidental configured secrets without disclosing raw CRM snapshots or HTML', async (t) => {
  const s = setup(t);
  const secret = 'synthetic-location-secret';
  const snapshot = structuredClone(baseline);
  snapshot.facilities[0].administrator = `Office ${secret}`;
  snapshot.facilities[0].api_token = secret;
  snapshot.facilities[0].html = '<private>Do not expose</private>';
  snapshot.accounts = [{ name: 'PRIVATE CRM SNAPSHOT' }];
  snapshot.contacts = [{ name: 'PRIVATE CONTACT SNAPSHOT' }];
  s.insertRun('saved', { snapshot });
  const state = await reviewState(s.ledger, 'live', [secret]);
  const response = JSON.stringify(state);
  for (const privateValue of [secret, 'PRIVATE CRM SNAPSHOT', 'PRIVATE CONTACT SNAPSHOT', '<private>'])
    assert(!response.includes(privateValue));
  assert.equal(state.website.facilities[0].administrator, 'Office [redacted]');
  assert(!Object.hasOwn(state.website.facilities[0], 'api_token'));
  assert.equal(state.website.facilities.length, 35);
});
