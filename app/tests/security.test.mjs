import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { Ledger } from '../lib/ledger.mjs';
import { reviewState } from '../lib/state.mjs';
import { crmClient } from '../lib/sources.mjs';
import { selectedOption } from '../lib/review-selection.mjs';
import { parseRequestObject } from '../lib/request.mjs';

const AT = '2026-10-10T12:00:00.000Z';
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) =>
    f.endsWith('.sql')
  ))
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const ledger = new Ledger({
    prepare(sql) {
      assert.match(sql, /^SELECT /, 'Public state must only read the ledger');
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
  return { sqlite, ledger };
}

test('public state preserves review evidence without exposing reusable sessions, secrets or raw snapshots', async () => {
  const { sqlite, ledger } = setup();
  const decisionSession = 'e32d0000-1234-4567-8901-000000000001',
    stagingSession = 'e32d0000-1234-4567-8901-000000000002';
  const credential = 'synthetic-configured-secret',
    csrf = 'synthetic-csrf-private';
  sqlite.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(decisionSession, csrf, AT, 0);
  sqlite
    .prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)')
    .run(
      'case',
      'facility',
      'v1',
      'run',
      'pending',
      JSON.stringify({
        id: 'case',
        title: 'Review facility',
        options: [
          { id: 'account', operations: [{ type: 'patch', fields: { name: 'Current facility' } }] },
        ],
        reviewer_note: `Accidental pasted value ${credential}`,
      }),
      AT
    );
  sqlite
    .prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)')
    .run('old', 'facility', 'old', 'run', 'superseded', '{}', AT);
  sqlite
    .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?)')
    .run(
      'decision',
      'case',
      'approve',
      'account',
      'anonymous',
      decisionSession,
      `Review rationale ${decisionSession}`,
      AT
    );
  sqlite
    .prepare('INSERT INTO audits VALUES(?,?,?,?,?)')
    .run(
      'audit',
      'case',
      'manual_proposal_staged',
      JSON.stringify({
        actor: 'anonymous',
        session: stagingSession,
        note: `Accidental pasted session ${stagingSession}`,
        before: { name: 'Old' },
        after: { name: 'Current' },
      }),
      AT
    );
  sqlite
    .prepare('INSERT INTO runs VALUES(?,?,?,?,?)')
    .run(
      'run',
      'complete',
      AT,
      AT,
      JSON.stringify({
        counts: { accounts: 1 },
        snapshot: {
          coverage: { complete: true },
          pages: [{ html: 'DO NOT EXPOSE HTML' }],
          accounts: [{ name: 'DO NOT EXPOSE SNAPSHOT' }],
        },
      })
    );

  const result = await reviewState(ledger, 'live', [credential]),
    serialized = JSON.stringify(result);
  for (const secret of [
    decisionSession,
    stagingSession,
    credential,
    csrf,
    'DO NOT EXPOSE HTML',
    'DO NOT EXPOSE SNAPSHOT',
  ])
    assert(!serialized.includes(secret), `Public state leaked ${secret}`);
  assert(!('session_id' in result.decisions[0]));
  assert(!('session' in result.audits[0].data));
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].title, 'Review facility');
  assert.deepEqual(result.proposals[0].options[0].operations[0].fields, {
    name: 'Current facility',
  });
  assert.equal(result.decisions[0].actor, 'anonymous');
  assert.equal(result.decisions[0].action, 'approve');
  assert.deepEqual(result.audits[0].data.before, { name: 'Old' });
  assert.deepEqual(result.runs[0].data.coverage, { complete: true });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  sqlite.close();
});

test('authenticated CRM fetch refuses an HTTP redirect without following it or retrying a write', async () => {
  const received = [];
  const destination = createServer((request, response) => {
    received.push(request.headers);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = (server) =>
    new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await listen(destination);
  const source = createServer((_request, response) => {
    response.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/steal` });
    response.end();
  });
  await listen(source);
  let calls = 0;
  try {
    const client = crmClient('synthetic-client-credential', (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return fetch(`http://127.0.0.1:${source.address().port}/accounts`, options);
    });
    await assert.rejects(
      client.createAccount({ name: 'Review facility' }),
      /No automatic write retry|no automatic write retry/
    );
    assert.equal(calls, 1);
    assert.equal(
      received.length,
      0,
      'Redirect destination must receive neither credentials nor a write'
    );
  } finally {
    await close(source);
    await close(destination);
  }
});

test('an older approved survivor and rejection remain available after more than 500 newer decisions', async () => {
  const { sqlite, ledger } = setup();
  const options = [
    { id: 'first-candidate', operations: [] },
    { id: 'approved-survivor', operations: [] },
  ];
  const insertProposal = sqlite.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)');
  const insertDecision = sqlite.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?)');
  for (const [id, status, action] of [
    ['old-applied', 'applied', 'approve'],
    ['old-partial', 'partial', 'approve'],
    ['old-rejected', 'rejected', 'reject'],
    ['old-hidden', 'superseded', 'reject'],
  ]) {
    insertProposal.run(
      id,
      id,
      id,
      'run',
      status,
      JSON.stringify({ id, kind: 'ambiguous', options }),
      AT
    );
    insertDecision.run(
      'decision-' + id,
      id,
      action,
      action === 'approve' ? 'approved-survivor' : null,
      'anonymous',
      'private-session-' + id,
      'Original review rationale',
      AT
    );
  }
  for (let i = 0; i < 550; i++)
    insertDecision.run(
      'recent-' + i,
      'other-case',
      'reject',
      null,
      'anonymous',
      'private-recent-session',
      'Activity',
      new Date(Date.parse(AT) + 1000 * (i + 1)).toISOString()
    );
  const result = await reviewState(ledger, 'live');
  assert.equal(
    result.decisions.length,
    503,
    'General history stays bounded with only required older case decisions added'
  );
  for (const id of ['old-applied', 'old-partial']) {
    const proposal = result.proposals.find((p) => p.id === id);
    assert.equal(selectedOption(proposal, result.decisions), 'approved-survivor');
  }
  assert.equal(
    result.decisions.find((d) => d.proposal_id === 'old-rejected').note,
    'Original review rationale'
  );
  assert(!result.decisions.some((d) => d.proposal_id === 'old-hidden'));
  assert(!JSON.stringify(result).includes('private-session'));
  assert(!JSON.stringify(result).includes('private-recent-session'));
  sqlite.close();
});

test('request JSON requires an object and malformed bodies never echo submitted credentials', () => {
  for (const body of ['null', '[]', '[{}]', 'true', 'false', '42', '"a value"'])
    assert.throws(() => parseRequestObject(body), /^Error: Request body must be a JSON object\.$/);
  assert.throws(
    () => parseRequestObject('{"secret":"synthetic-do-not-echo"'),
    (error) => error.message === 'Request body must contain valid JSON.'
  );
  assert.deepEqual(parseRequestObject('{"action":"reject"}'), { action: 'reject' });
  assert.deepEqual(parseRequestObject(''), {});
});
