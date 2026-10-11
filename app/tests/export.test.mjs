import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { exportEvidence } from '../lib/export.mjs';

const AT = '2026-10-10T12:00:00.000Z';
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) =>
    f.endsWith('.sql')
  ))
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const readTables = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /^SELECT /);
      readTables.push(sql);
      const statement = sqlite.prepare(sql);
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: statement.all() };
        },
      };
    },
  };
  return { sqlite, db, readTables };
}

test('exports source-backed proposals, decisions and before/after checkpoints without raw HTML or sessions', async () => {
  const s = setup();
  const before = {
    account_id: 'old',
    name: 'Original',
    lifetime_revenue: 84000,
    outstanding_ar: 12400,
    parent_id: 'legacy',
  };
  const after = { ...before, chow_current_account: 'replacement' };
  const facility = {
    name: 'Current',
    source_url: 'https://example.invalid/communities/current',
    street_address: '1 Main St',
    retrieved_at_utc: AT,
  };
  s.sqlite.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(
    'run',
    'complete',
    AT,
    AT,
    JSON.stringify({
      counts: { accounts: 1, contacts: 1, facilities: 1 },
      snapshot: {
        retrieved_at: AT,
        accounts: [before],
        contacts: [{ contact_id: 'contact', account_id: 'old', name: 'Example Contact' }],
        facilities: [facility],
        coverage: { complete: true, expected: 1, found: 1, urls: [facility.source_url] },
        pages: [
          {
            url: facility.source_url,
            retrieved_at_utc: AT,
            hash: 'saved-source-hash',
            html: '<secret>This large HTML is deliberately omitted.</secret>',
          },
        ],
      },
    })
  );
  s.sqlite.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(
    'proposal',
    'case',
    'version',
    'run',
    'applied',
    JSON.stringify({
      title: 'Current',
      facility,
      candidates: [{ account: before }],
      options: [{ operations: [{ before, fields: { chow_current_account: 'replacement' } }] }],
    }),
    AT
  );
  s.sqlite
    .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?)')
    .run(
      'decision',
      'proposal',
      'approve',
      'old',
      'anonymous',
      'private-session-uuid',
      'Billing preserved',
      AT
    );
  s.sqlite
    .prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)')
    .run(
      'operation',
      'proposal',
      0,
      'complete',
      JSON.stringify({ before, after, replacement: 'replacement' }),
      AT
    );
  s.sqlite
    .prepare('INSERT INTO audits VALUES(?,?,?,?,?)')
    .run(
      'audit',
      'proposal',
      'operation_verified',
      JSON.stringify({ before, after, session: 'private-session-uuid' }),
      AT
    );
  const result = await exportEvidence(s.db, 'live');
  assert.equal(result.contract_version, 1);
  assert.equal(result.mode, 'live');
  assert.deepEqual(result.operations[0].data.after, after);
  assert.deepEqual(result.proposals[0].data.candidates[0].account, before);
  assert.deepEqual(result.runs[0].source_index, [
    { url: facility.source_url, retrieved_at_utc: AT, hash: 'saved-source-hash' },
  ]);
  assert.equal(result.runs[0].snapshot.contacts[0].name, 'Example Contact');
  const serialized = JSON.stringify(result);
  assert(!serialized.includes('large HTML'));
  assert(!serialized.includes('private-session-uuid'));
  assert(!serialized.includes('session_id'));
  assert.equal(result.decisions[0].actor, 'anonymous');
  assert(s.readTables.every((sql) => !sql.includes('FROM sessions')));
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS n FROM audits').get().n, 1);
});

test('recursively redacts unexpected credentials, credential URLs, bearer text, and configuration assignments', async () => {
  const s = setup(),
    token = 'bh_' + 'synthetic_export_credential';
  const secrets = {
    apiToken: 'random-secret-value',
    nested: {
      PROXY_KEY: 'proxy-private-value',
      csrf: 'csrf-private-value',
      sessionId: 'session-private-value',
    },
    note: `Unexpected ${token}; Bearer secret-bearer-value; CRM_TOKEN=random-env-value`,
    links: [
      `https://example.invalid/crm?token=${token}&page=2`,
      'https://username:password@example.invalid/crm?api_key=random-query-value&page=3',
      'https://example.invalid/crm#access_token=fragment-secret',
      'https://example.invalid/crm?name=bh%5Fencoded-secret',
      'https://example.invalid/crm/%62%68%5Fencoded-path-secret',
    ],
    safe: {
      account_id: 'account-123',
      duplicate_of_account: 'survivor',
      note: 'No private data',
      source_url: 'https://example.invalid/communities?page=2',
    },
  };
  s.sqlite
    .prepare('INSERT INTO audits VALUES(?,?,?,?,?)')
    .run('audit', null, 'export-test', JSON.stringify(secrets), AT);
  const result = await exportEvidence(s.db, 'fixture'),
    serialized = JSON.stringify(result),
    data = result.audits[0].data;
  for (const secret of [
    token,
    'random-secret-value',
    'proxy-private-value',
    'csrf-private-value',
    'session-private-value',
    'secret-bearer-value',
    'random-env-value',
    'random-query-value',
    'fragment-secret',
    'encoded-secret',
    'encoded-path-secret',
    'username:password',
  ])
    assert(!serialized.includes(secret), `Export leaked ${secret}`);
  assert(!('apiToken' in data));
  assert.deepEqual(data.nested, {});
  assert.equal(data.links[0], 'https://example.invalid/crm?page=2');
  assert.equal(data.links[1], 'https://example.invalid/crm?page=3');
  assert.deepEqual(data.safe, secrets.safe);
});

test('failed runs remain inspectable with sanitized errors and no fabricated source coverage', async () => {
  const s = setup(),
    token = 'bh_' + 'synthetic_failed_run_secret';
  s.sqlite
    .prepare('INSERT INTO runs VALUES(?,?,?,?,?)')
    .run(
      'failed',
      'failed',
      AT,
      AT,
      JSON.stringify({ error: `Request failed for https://example.invalid/crm?token=${token}` })
    );
  const result = await exportEvidence(s.db, 'live');
  assert.equal(result.runs[0].status, 'failed');
  assert.equal(result.runs[0].snapshot, null);
  assert.equal(result.runs[0].coverage, null);
  assert.deepEqual(result.runs[0].source_index, []);
  assert(!JSON.stringify(result).includes(token));
});

test('empty ledger produces a complete empty bundle without accessing secret tables', async () => {
  const s = setup(),
    result = await exportEvidence(s.db, 'live');
  for (const field of ['proposals', 'decisions', 'operations', 'runs', 'audits'])
    assert.deepEqual(result[field], []);
  assert.equal(s.readTables.length, 5);
});

test('export redacts configured secrets and draft-only sessions echoed in ordinary notes', async () => {
  const s = setup();
  const secret = 'synthetic-unlabelled-service-credential';
  const session = 'private-draft-without-decision';
  s.sqlite.prepare('INSERT INTO audits VALUES(?,?,?,?,?)').run(
    'draft',
    null,
    'manual_draft',
    JSON.stringify({
      session,
      note: `Diagnostic ${secret}; reviewed by ${session}`,
      title: 'Facility',
    }),
    AT
  );
  const result = await exportEvidence(s.db, 'live', [secret]);
  const serialized = JSON.stringify(result);
  assert(!serialized.includes(secret));
  assert(!serialized.includes(session));
  assert.equal(result.audits[0].data.title, 'Facility');
  assert.equal(result.audits[0].data.note, 'Diagnostic [redacted]; reviewed by [redacted]');
  assert(s.readTables.every((sql) => !sql.includes('FROM sessions')));
  s.sqlite.close();
});
