import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, cronSecret } from './harness.mjs';
import { reviewRows } from '../../lib/live-refresh.mjs';

const openCount = (state) => reviewRows(state, { view: 'queue', filter: 'all', search: '' }).length;

async function schedule(app, { route = 'pipeline', token = cronSecret, body = {} } = {}) {
  // A scheduler has no browser Origin, session cookie or CSRF token.
  const response = await app.dispatch(new Request(`http://desk.test/api/desk/${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }));
  return { status: response.status, value: await response.json() };
}

function ok(response) {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
}

test('scheduler: cron bearer authorizes only collection and never authorizes a draft or approval', async (t) => {
  const hosted = await createHarness();
  t.after(hosted.close);
  for (const token of ['', 'incorrect-cron-secret'])
    assert.equal((await schedule(hosted, { token })).status, 409);
  assert.equal(hosted.requests.length, 0);
  assert.equal((await hosted.db.prepare('SELECT COUNT(*) AS n FROM runs').first()).n, 0);

  const completed = ok(await schedule(hosted));
  assert.equal(completed.facilities, 35);
  assert.equal(completed.coverage.complete, true);
  const state = ok(await hosted.call('state'));
  assert.equal(completed.open_proposals, openCount(state));
  const proposal = state.proposals.find((p) => p.title.includes('Portsmouth'));
  const approval = {
    id: proposal.id,
    version: proposal.version,
    optionId: proposal.options[0].id,
    action: 'approve',
    note: 'Attempted scheduler approval must be refused',
  };
  assert.equal((await schedule(hosted, { route: 'decision', body: approval })).status, 409);
  assert.equal((await schedule(hosted, {
    route: 'draft',
    body: { entity: 'accounts', fields: { name: 'Unreviewed scheduler draft' }, note: 'Refuse' },
  })).status, 409);
  assert.equal((await hosted.db.prepare('SELECT COUNT(*) AS n FROM decisions').first()).n, 0);
  assert.equal((await hosted.db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 0);
  assert.equal(hosted.writes.length, 0);
  assert.equal((await hosted.call('state')).value.proposals.find((p) => p.id === proposal.id).status, 'pending');
});

test('scheduler: scheduled refresh appears in the shared local/hosted ledger and keeps reviewed decisions closed', async (t) => {
  const hosted = await createHarness();
  let local;
  t.after(async () => {
    try { await local?.close(); } finally { await hosted.close(); }
  });
  local = await createHarness({ mode: 'proxy', backend: hosted });
  const initial = ok(await schedule(hosted));
  const state = ok(await local.call('state'));
  assert.equal(state.website.run_id, initial.id);
  assert.equal(state.runs[0].id, initial.id);
  assert.equal(state.runs[0].status, 'complete');
  assert.equal(state.runs[0].data.counts.facilities, 35);
  assert.equal(initial.open_proposals, openCount(state));
  assert.equal(state.runs[0].data.counts.open_proposals, initial.open_proposals);
  assert.equal(hosted.writes.length, 0);

  for (const [title, action] of [['Kettering', 'reject'], ['Portsmouth', 'approve']]) {
    const p = state.proposals.find((row) => row.title.includes(title));
    ok(await local.call('decision', {
      ...(await local.reviewer()),
      body: {
        id: p.id, version: p.version, optionId: p.options[0].id, action,
        note: action === 'reject' ? 'Equal candidates require further evidence' : 'Postal code verified',
      },
    }));
  }
  const writes = hosted.writes.length;
  assert.equal(writes, 1);
  await hosted.restart();
  await local.restart();
  ok(await schedule(hosted));
  const repeat = ok(await schedule(hosted));
  assert.equal(repeat.new_proposals, 0);
  assert.equal(hosted.writes.length, writes, 'Scheduled reruns cannot perform CRM writes');
  const after = ok(await local.call('state'));
  assert.equal(repeat.open_proposals, initial.open_proposals - 2);
  assert.equal(repeat.open_proposals, openCount(after));
  assert.equal(after.runs[0].data.counts.open_proposals, repeat.open_proposals);
  assert.equal(after.runs.find((run) => run.id === initial.id).data.counts.open_proposals, initial.open_proposals);
  assert.equal(after.website.run_id, repeat.id);
  assert.deepEqual(after, ok(await hosted.call('state')));
  assert(after.proposals.some((p) => p.title.includes('Kettering') && p.status === 'rejected'));
  for (const title of ['Kettering', 'Portsmouth'])
    assert(!after.proposals.some((p) => p.title.includes(title) && p.status === 'pending'));
  assert.equal(after.decisions.length, 2);
  assert(after.audits.some((a) => a.event === 'pipeline_complete' && a.data.run_id === repeat.id && a.data.open_proposals === repeat.open_proposals));
  const report = ok(await local.call('report'));
  assert.equal(report.source.latest_run.id, repeat.id);
  assert.equal(report.history.approval_decisions, 1);
  assert.equal(report.history.rejection_decisions, 1);
  assert.equal((await local.db.prepare('SELECT COUNT(*) AS n FROM runs').first()).n, 0);
});
