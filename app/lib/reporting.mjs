import { reconcile } from './core.mjs';

// Reporting is read-only. Keep the accounting grain explicit: current cases are
// reconstructed from one complete snapshot, not counted across proposal history.
const STALE_AFTER_SECONDS = 26 * 60 * 60;
const VERIFIED = `
  p.status = 'applied'
  AND EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id=p.id AND d.action='approve')
  AND ((SELECT COUNT(*) FROM operations o WHERE o.proposal_id=p.id) > 0
    OR EXISTS (SELECT 1 FROM audits a WHERE a.proposal_id=p.id
      AND a.event IN ('field_selection_verified','identity_resolution_verified')
      AND json_type(a.data,'$.field_choices')='object'))
  AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.proposal_id=p.id AND o.status!='complete')
  AND (SELECT COUNT(*) FROM operations o WHERE o.proposal_id=p.id) = (
    SELECT json_array_length(opt.value, '$.operations')
    FROM json_each(p.data, '$.options') opt
    WHERE json_extract(opt.value, '$.id') = (
      SELECT d.option_id FROM decisions d WHERE d.proposal_id=p.id AND d.action='approve'
      ORDER BY d.created DESC, d.id DESC LIMIT 1
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM operations o WHERE o.proposal_id=p.id
    AND NOT EXISTS (
      SELECT 1 FROM audits a WHERE a.proposal_id=p.id AND a.event='operation_verified'
      AND json_extract(a.data, '$.operation_id')=o.id
    )
  )`;

const CURRENT = `SELECT * FROM (WITH current_input AS (
  SELECT json_extract(value,'$.id') AS id,
         json_extract(value,'$.compatibility_version') AS compatibility_version,
         json_extract(value,'$.key') AS case_key,
         json_extract(value,'$.kind') AS kind
  FROM json_each(?)
), current_cases AS (
  SELECT c.case_key, p.id AS proposal_id,
    CASE WHEN p.status IN ('partial','applying') THEN json_extract(p.data,'$.kind') ELSE c.kind END AS kind,
    CASE
      WHEN p.id IS NULL THEN 'missing_ledger'
      WHEN p.status='applied' AND NOT (${VERIFIED}) THEN 'verification_required'
      ELSE p.status
    END AS state,
    ROW_NUMBER() OVER (PARTITION BY c.case_key ORDER BY
      CASE WHEN p.status IN ('partial','applying') THEN 0 ELSE 1 END,
      CASE WHEN p.status='applied' AND json_extract(p.data,'$.resolution_evidence_version') IN (c.id,c.compatibility_version)
        THEN 0 ELSE 1 END,
      CASE WHEN p.status='superseded' THEN 1 ELSE 0 END,
      p.created DESC,p.rowid DESC) AS position
  FROM current_input c
  LEFT JOIN proposals p ON p.case_key=c.case_key AND (
        p.id=c.id OR COALESCE(json_extract(p.data,'$.evidence_version'),p.version) IN (c.id,c.compatibility_version)
        OR p.status IN ('partial','applying')
        OR (p.status='applied' AND json_extract(p.data,'$.resolution_evidence_version') IN (c.id,c.compatibility_version)
          AND p.id=(SELECT resolved.id FROM proposals resolved
            WHERE resolved.case_key=c.case_key AND resolved.status='applied'
            ORDER BY COALESCE((SELECT MAX(d.rowid) FROM decisions d
              WHERE d.proposal_id=resolved.id AND d.action='approve'),0) DESC,
              resolved.created DESC, resolved.id DESC LIMIT 1))
  )
)
SELECT case_key,proposal_id,kind,state FROM current_cases WHERE position=1)`;

/** Resolve the saved row for each current source case consistently across UI and reporting. */
export async function currentCaseRows(db, snapshot) {
  if (!snapshot) return [];
  const cases = await reconcile(snapshot);
  return (await db.prepare(CURRENT)
    .bind(JSON.stringify(cases.map(({ id, key, kind, compatibility_version }) => ({ id, key, kind, compatibility_version }))))
    .all()).results;
}

const asRun = (row) =>
  row
    ? {
        id: row.id,
        status: row.status,
        started: row.started,
        finished: row.finished,
        coverage_complete: JSON.parse(row.data).snapshot?.coverage?.complete ?? null,
      }
    : null;

/**
 * SQL-backed metrics from the saved ledger. No network calls, mutations, actor
 * details, account balances, or raw source data leave this function.
 * Metric definitions are shown alongside the Operations report.
 */
export async function operationalReport(db, now = new Date()) {
  const clock = new Date(now);
  if (!Number.isFinite(clock.getTime())) throw new TypeError('Reporting time must be a valid date');
  const first = (sql, ...args) =>
    db
      .prepare(sql)
      .bind(...args)
      .first();
  const all = async (sql, ...args) =>
    (
      await db
        .prepare(sql)
        .bind(...args)
        .all()
    ).results;
  const latest = await first('SELECT * FROM runs ORDER BY started DESC, rowid DESC LIMIT 1');
  const complete = await first(`SELECT *,rowid AS run_order FROM runs
    WHERE status='complete' AND json_extract(data,'$.snapshot.coverage.complete')=1
    ORDER BY started DESC, rowid DESC LIMIT 1`);
  const snapshot = complete ? JSON.parse(complete.data).snapshot : null;
  const current = await currentCaseRows(db, snapshot);
  const groups = new Map();
  for (const row of current) {
    const key = JSON.stringify([row.kind, row.state]);
    const group = groups.get(key) ?? { kind: row.kind, state: row.state, total: 0 };
    group.total++;
    groups.set(key, group);
  }
  const grouped = [...groups.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.state.localeCompare(b.state));
  const byKind = new Map(),
    byState = new Map();
  for (const row of grouped) {
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + row.total);
    byState.set(row.state, (byState.get(row.state) ?? 0) + row.total);
  }
  const stateCount = (...states) =>
    states.reduce((sum, state) => sum + (byState.get(state) ?? 0), 0);
  const history = await first(`SELECT
    (SELECT COUNT(DISTINCT p.case_key) FROM proposals p WHERE ${VERIFIED}) AS verified_applied_cases,
    (SELECT COUNT(DISTINCT p.case_key) FROM decisions d JOIN proposals p ON p.id=d.proposal_id WHERE d.action='reject') AS rejected_cases,
    (SELECT COUNT(*) FROM decisions WHERE action='approve') AS approval_decisions,
    (SELECT COUNT(*) FROM decisions WHERE action='reject') AS rejection_decisions`);
  const recoveryRows =
    await all(`SELECT p.id AS proposal_id, json_extract(p.data,'$.title') AS title,
    p.status AS state, o.id AS operation_id, o.step, o.status AS operation_status, o.updated
    FROM proposals p LEFT JOIN operations o ON o.proposal_id=p.id
    WHERE p.status IN ('partial','applying') OR (p.status='applied' AND NOT (${VERIFIED}))
      OR EXISTS (SELECT 1 FROM operations incomplete WHERE incomplete.proposal_id=p.id AND incomplete.status!='complete')
    ORDER BY p.created, p.id, o.step`);
  const recoveryCases = new Map();
  let incompleteOperations = 0;
  for (const row of recoveryRows) {
    if (!recoveryCases.has(row.proposal_id))
      recoveryCases.set(row.proposal_id, {
        proposal_id: row.proposal_id,
        title: row.title,
        state: row.state,
        steps: [],
      });
    if (row.operation_id) {
      recoveryCases
        .get(row.proposal_id)
        .steps.push({ step: row.step, status: row.operation_status, updated: row.updated });
      if (row.operation_status !== 'complete') incompleteOperations++;
    }
  }
  const failed = await first(
    `SELECT COUNT(*) AS total FROM runs WHERE status='failed'
    AND (? IS NULL OR started>? OR (started=? AND rowid>?))`,
    complete?.started ?? null,
    complete?.started ?? null,
    complete?.started ?? null,
    complete?.run_order ?? 0
  );
  // Use collection time where available, rather than making slow processing look
  // like more recent source evidence. Freshness is not an accuracy score.
  const evidenceTime = snapshot?.retrieved_at ?? complete?.started;
  const ageSeconds = evidenceTime
    ? Math.max(0, Math.floor((clock.getTime() - Date.parse(evidenceTime)) / 1000))
    : null;
  const total = grouped.reduce((sum, row) => sum + row.total, 0);
  return {
    contract_version: 1,
    generated_at: clock.toISOString(),
    source: {
      latest_run: asRun(latest),
      last_complete_run: asRun(complete),
      freshness: !complete ? 'no_snapshot' : ageSeconds > STALE_AFTER_SECONDS ? 'stale' : 'fresh',
      age_seconds: ageSeconds,
      stale_after_seconds: STALE_AFTER_SECONDS,
      failed_runs_since_complete: failed.total,
      counts: {
        accounts: snapshot?.accounts.length ?? 0,
        contacts: snapshot?.contacts.length ?? 0,
        facilities: snapshot?.facilities.length ?? 0,
      },
      coverage: {
        complete: !!snapshot?.coverage.complete,
        expected: snapshot?.coverage.expected ?? null,
        found: snapshot?.coverage.found ?? 0,
      },
    },
    current: {
      total,
      review_backlog: stateCount('pending', 'stale', 'missing_ledger', 'superseded'),
      unresolved: total - stateCount('applied', 'unchanged'),
      applied: stateCount('applied'),
      rejected: stateCount('rejected'),
      unchanged: stateCount('unchanged'),
      missing_ledger_rows: stateCount('missing_ledger'),
      verification_required: stateCount('verification_required'),
      by_kind: [...byKind].map(([kind, total]) => ({ kind, total })),
      by_state: [...byState]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([state, total]) => ({ state, total })),
    },
    history,
    recovery: {
      case_count: recoveryCases.size,
      operation_count: incompleteOperations,
      cases: [...recoveryCases.values()],
    },
  };
}
