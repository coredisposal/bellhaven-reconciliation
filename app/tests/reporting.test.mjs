import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { reconcile } from '../lib/reconciliation.mjs';
import { operationalReport } from '../lib/reporting.mjs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };

const AT = '2026-10-10T12:00:00.000Z';
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) =>
    f.endsWith('.sql')
  ))
    sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  // There is intentionally no run() method in the reporter's D1 adapter.
  const db = {
    prepare(sql) {
      assert.match(sql.trim(), /^(SELECT|WITH)\b/, 'Reporting must use only read statements');
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          return statement.get(...args) ?? null;
        },
        async all() {
          return { results: statement.all(...args) };
        },
      };
    },
  };
  const insertRun = (id, snapshot, { started = AT, status = 'complete' } = {}) =>
    sqlite
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?)')
      .run(
        id,
        status,
        started,
        status === 'running' ? null : started,
        JSON.stringify(snapshot ? { snapshot } : { error: 'source unavailable' })
      );
  const insertProposals = async (snapshot, runId, created = AT) => {
    const rows = await reconcile(snapshot, db);
    for (const p of rows)
      sqlite
        .prepare('INSERT OR IGNORE INTO proposals VALUES(?,?,?,?,?,?,?)')
        .run(
          p.id,
          p.key,
          p.version,
          runId,
          p.kind === 'unchanged' ? 'unchanged' : 'pending',
          JSON.stringify(p),
          created
        );
    return rows;
  };
  const approveAndVerify = (p) => {
    sqlite
      .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?)')
      .run('approve-' + p.id, p.id, 'approve', p.options[0].id, 'test', 'test', 'Reviewed', AT);
    for (const [i, op] of p.options[0].operations.entries()) {
      const id = p.id + '-' + i;
      sqlite
        .prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)')
        .run(id, p.id, i, 'complete', JSON.stringify({ after: op.fields }), AT);
      sqlite
        .prepare('INSERT INTO audits VALUES(?,?,?,?,?)')
        .run('audit-' + id, p.id, 'operation_verified', JSON.stringify({ operation_id: id }), AT);
    }
    sqlite.prepare("UPDATE proposals SET status='applied' WHERE id=?").run(p.id);
  };
  return { sqlite, db, insertRun, insertProposals, approveAndVerify };
}
function snapshot({ legacy = true, absent = false, complete = true } = {}) {
  const facility = {
    name: 'Bellhaven Example',
    street_address: '100 Main Street',
    city: 'Example',
    state: 'OH',
    postal_code: '12345',
    care_offerings: ['Assisted Living'],
    administrator: 'Alex Example',
    phone_raw: '216-555-0100',
    source_url: 'https://example.invalid/communities/example',
  };
  const parent = {
    account_id: 'parent',
    name: 'Bellhaven Senior Living (Parent Account)',
    parent_id: '',
    lifetime_revenue: 0,
    outstanding_ar: 0,
  };
  const account = {
    account_id: 'account',
    name: legacy ? 'Legacy Example' : facility.name,
    parent_id: parent.account_id,
    billing_street: '100 Main St',
    billing_city: facility.city,
    billing_state: facility.state,
    billing_zip: facility.postal_code,
    care_type: 'Assisted Living',
    phone: facility.phone_raw,
    status: 'Active',
    lifetime_revenue: 0,
    outstanding_ar: 0,
  };
  return {
    accounts: [
      parent,
      account,
      ...(absent
        ? [{ ...account, account_id: 'absent', name: 'Unlisted', billing_street: '999 Other St' }]
        : []),
    ],
    contacts: [],
    facilities: [facility],
    coverage: { complete, expected: 1, found: 1, urls: [facility.source_url] },
    retrieved_at: AT,
  };
}

test('empty ledger has explicit missing snapshot and zero counts, without percentage denominators', async () => {
  const s = setup(),
    r = await operationalReport(s.db, AT);
  assert.equal(r.source.freshness, 'no_snapshot');
  assert.equal(r.source.age_seconds, null);
  assert.equal(r.current.total, 0);
  assert.equal(r.source.coverage.expected, null);
  assert.equal(r.history.verified_applied_cases, 0);
  assert.equal(r.recovery.case_count, 0);
  assert.deepEqual(r.current.by_state, []);
});

test('run failure counts use insertion order when completion and failure timestamps tie', async (t) => {
  const s = setup();
  t.after(() => s.sqlite.close());
  s.insertRun('earlier-failure', null, { status: 'failed' });
  s.insertRun('saved', snapshot());
  s.insertRun('later-failure', null, { status: 'failed' });
  const report = await operationalReport(s.db, AT);
  assert.equal(report.source.latest_run.id, 'later-failure');
  assert.equal(report.source.last_complete_run.id, 'saved');
  assert.equal(report.source.failed_runs_since_complete, 1);
  s.insertRun('recovered', snapshot());
  const recovered = await operationalReport(s.db, AT);
  assert.equal(recovered.source.latest_run.id, 'recovered');
  assert.equal(recovered.source.last_complete_run.id, 'recovered');
  assert.equal(recovered.source.failed_runs_since_complete, 0);
});

test('current grain counts one website case plus an absent account, separate from facility denominator', async () => {
  const s = setup(),
    data = snapshot({ absent: true });
  s.insertRun('run', data);
  await s.insertProposals(data, 'run');
  const r = await operationalReport(s.db, AT);
  assert.equal(r.current.total, 2);
  assert.equal(r.source.counts.facilities, 1);
  assert.equal(r.source.counts.accounts, 3);
  assert.equal(r.current.review_backlog, 2);
  assert.equal(r.current.unresolved, 2);
  assert.deepEqual(r.current.by_kind, [
    { kind: 'absent', total: 1 },
    { kind: 'field_correction', total: 1 },
  ]);
});

test('exercise baseline reports 38 facility cases plus four CRM-quality cases without changing the facility denominator', async () => {
  const s = setup();
  s.insertRun('baseline', baseline);
  const cases = await s.insertProposals(baseline, 'baseline');
  assert.equal(cases.filter((p) => p.kind !== 'crm_quality').length, 38);
  assert.deepEqual(cases.filter((p) => p.kind === 'crm_quality').map((p) => p.quality.category).sort(), [
    'account_overlap', 'retired_contact', 'retired_contact', 'shared_email',
  ]);
  const r = await operationalReport(s.db, AT);
  assert.equal(r.current.total, 42);
  assert.equal(r.source.counts.facilities, 35);
  assert.equal(r.source.counts.accounts, 121);
  assert.equal(r.source.counts.contacts, 67);
  assert.equal(r.current.review_backlog, 41);
  assert.equal(r.current.unchanged, 1);
  assert.deepEqual(r.current.by_kind.find((row) => row.kind === 'crm_quality'), { kind: 'crm_quality', total: 4 });
  assert.equal(r.current.missing_ledger_rows, 0);
});

test('CRM-quality acknowledgement needs a verified no-write audit and stays closed across report reruns', async (t) => {
  const s = setup(), data = snapshot({ legacy: false });
  t.after(() => s.sqlite.close());
  data.accounts[1].billing_street = data.facilities[0].street_address;
  data.contacts = [
    { contact_id: 'one', account_id: 'account', name: 'Alex Example', email: 'shared@example.invalid', is_active: true },
    { contact_id: 'two', account_id: 'account', name: 'Jordan Example', email: 'shared@example.invalid', is_active: true },
  ];
  s.insertRun('first', data);
  const cases = await s.insertProposals(data, 'first'), quality = cases.find((p) => p.kind === 'crm_quality');
  assert.equal(cases.length, 2);
  assert.equal(quality.quality.category, 'shared_email');
  assert.deepEqual(quality.options[0].operations, []);
  s.approveAndVerify(quality);
  let report = await operationalReport(s.db, AT);
  assert.equal(report.current.verification_required, 1, 'Applied status and approval alone do not verify a no-write review');
  assert.equal(report.history.verified_applied_cases, 0);
  s.sqlite.prepare('INSERT INTO audits VALUES(?,?,?,?,?)').run(
    'review-verified', quality.id, 'field_selection_verified', JSON.stringify({ field_choices: {} }), AT
  );
  const repeated = { ...data, retrieved_at: '2026-10-10T13:00:00.000Z' };
  s.insertRun('second', repeated, { started: repeated.retrieved_at });
  await s.insertProposals(repeated, 'second', repeated.retrieved_at);
  report = await operationalReport(s.db, repeated.retrieved_at);
  assert.equal(report.current.total, 2);
  assert.deepEqual(report.current.by_kind, [{ kind: 'crm_quality', total: 1 }, { kind: 'unchanged', total: 1 }]);
  assert.equal(report.source.counts.facilities, 1);
  assert.equal(report.source.counts.contacts, 2);
  assert.equal(report.current.applied, 1);
  assert.equal(report.current.unchanged, 1);
  assert.equal(report.current.review_backlog, 0);
  assert.equal(report.current.missing_ledger_rows, 0);
  assert.equal(report.history.verified_applied_cases, 1);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS total FROM operations').get().total, 0);
});

test('unchanged reruns and persisted rejection count one case even though proposal belongs to original run', async () => {
  const s = setup(),
    data = snapshot();
  s.insertRun('first', data);
  const [p] = await s.insertProposals(data, 'first');
  s.sqlite.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(p.id);
  for (let i = 0; i < 2; i++)
    s.sqlite
      .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?)')
      .run('reject-' + i, p.id, 'reject', null, 'test', 'test', 'Not sufficient evidence', AT);
  s.insertRun(
    'second',
    { ...data, retrieved_at: '2026-10-10T13:00:00.000Z' },
    { started: '2026-10-10T13:00:00.000Z' }
  );
  const r = await operationalReport(s.db, '2026-10-10T14:00:00.000Z');
  assert.equal(r.current.total, 1);
  assert.equal(r.current.rejected, 1);
  assert.equal(r.current.unresolved, 1);
  assert.equal(r.current.review_backlog, 0);
  assert.equal(r.history.rejected_cases, 1);
  assert.equal(r.history.rejection_decisions, 2);
  assert.equal(r.source.age_seconds, 3600);
});

test('applied old version becomes unchanged current case after refreshed snapshot, retaining verified history', async () => {
  const s = setup(),
    before = snapshot();
  s.insertRun('before', before);
  const [p] = await s.insertProposals(before, 'before');
  s.approveAndVerify(p);
  const beforeReport = await operationalReport(s.db, AT);
  assert.equal(beforeReport.current.applied, 1);
  assert.equal(beforeReport.history.verified_applied_cases, 1);
  const after = snapshot({ legacy: false });
  Object.assign(after.accounts[1], p.options[0].operations[0].fields);
  s.insertRun('after', after, { started: '2026-10-10T13:00:00.000Z' });
  await s.insertProposals(after, 'after', '2026-10-10T13:00:00.000Z');
  const r = await operationalReport(s.db, '2026-10-10T13:00:00.000Z');
  assert.equal(r.current.total, 1);
  assert.equal(r.current.unchanged, 1);
  assert.equal(r.current.applied, 0);
  assert.equal(r.current.unresolved, 0);
  assert.equal(r.history.verified_applied_cases, 1);
  assert.equal(r.history.approval_decisions, 1);
});

test('failed and incomplete later runs do not replace last complete evidence or reset freshness', async () => {
  const s = setup(),
    data = snapshot();
  s.insertRun('good', data);
  await s.insertProposals(data, 'good');
  s.insertRun('partial', snapshot({ complete: false }), { started: '2026-10-11T13:00:00.000Z' });
  s.insertRun('failed', null, { started: '2026-10-11T15:00:00.000Z', status: 'failed' });
  const r = await operationalReport(s.db, '2026-10-11T16:00:00.000Z');
  assert.equal(r.source.last_complete_run.id, 'good');
  assert.equal(r.source.latest_run.id, 'failed');
  assert.equal(r.source.freshness, 'stale');
  assert.equal(r.source.age_seconds, 28 * 3600);
  assert.equal(r.source.failed_runs_since_complete, 1);
  assert.equal(r.current.total, 1);
});

test('partial crawl without complete history is not reported as full coverage', async () => {
  const s = setup();
  s.insertRun('partial', snapshot({ complete: false }));
  const r = await operationalReport(s.db, AT);
  assert.equal(r.source.latest_run.coverage_complete, false);
  assert.equal(r.source.last_complete_run, null);
  assert.equal(r.source.freshness, 'no_snapshot');
  assert.equal(r.current.total, 0);
});

test('interrupted version occupies its current case and exposes exact incomplete checkpoints', async () => {
  const s = setup(),
    before = snapshot();
  s.insertRun('before', before);
  const [p] = await s.insertProposals(before, 'before');
  s.sqlite.prepare("UPDATE proposals SET status='partial' WHERE id=?").run(p.id);
  s.sqlite
    .prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)')
    .run('checkpoint', p.id, 0, 'link_intent', '{}', AT);
  const after = snapshot({ legacy: false });
  s.insertRun('after', after, { started: '2026-10-10T13:00:00.000Z' });
  // Pipeline deliberately withholds new proposals for an interrupted case.
  const r = await operationalReport(s.db, '2026-10-10T13:00:00.000Z');
  assert.equal(r.current.total, 1);
  assert.deepEqual(r.current.by_state, [{ state: 'partial', total: 1 }]);
  assert.deepEqual(r.current.by_kind, [{ kind: 'field_correction', total: 1 }]);
  assert.equal(r.current.unresolved, 1);
  assert.equal(r.current.missing_ledger_rows, 0);
  assert.equal(r.recovery.case_count, 1);
  assert.equal(r.recovery.operation_count, 1);
  assert.deepEqual(r.recovery.cases[0].steps, [{ step: 0, status: 'link_intent', updated: AT }]);
});

test('missing ledger case is explicit, and applied status alone is not proof of verification', async () => {
  const s = setup(),
    data = snapshot();
  s.insertRun('run', data);
  let r = await operationalReport(s.db, AT);
  assert.equal(r.current.missing_ledger_rows, 1);
  assert.equal(r.current.review_backlog, 1);
  const [p] = await s.insertProposals(data, 'run');
  s.sqlite.prepare("UPDATE proposals SET status='applied' WHERE id=?").run(p.id);
  r = await operationalReport(s.db, AT);
  assert.equal(r.current.verification_required, 1);
  assert.equal(r.current.applied, 0);
  assert.equal(r.current.unresolved, 1);
  assert.equal(r.history.verified_applied_cases, 0);
  assert.equal(r.recovery.case_count, 1);
  assert.equal(r.recovery.operation_count, 0);
  s.approveAndVerify(p);
  s.sqlite.prepare("DELETE FROM audits WHERE event='operation_verified'").run();
  r = await operationalReport(s.db, AT);
  assert.equal(r.current.verification_required, 1);
  assert.equal(r.history.verified_applied_cases, 0);
});
