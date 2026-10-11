import { sanitize } from './export.mjs';
import { currentCaseRows } from './reporting.mjs';

/** Public review data. Session cookies/identifiers stay in the private ledger. */
export async function reviewState(db, mode, credentialValues = []) {
  const proposals = await db.all(
    "SELECT * FROM proposals WHERE status!='superseded' ORDER BY created DESC,rowid DESC"
  );
  const runs = await db.all('SELECT * FROM runs ORDER BY started DESC,rowid DESC LIMIT 20');
  // Read the scraper's saved output directly, independent of proposal history
  // and the recent-runs limit. Failed refreshes must not erase collected rows.
  const [collected] = await db.all(
    `SELECT id,finished,data FROM runs WHERE status='complete'
     AND json_type(data,'$.snapshot.facilities')='array'
     ORDER BY started DESC,rowid DESC LIMIT 1`
  );
  const snapshot = collected ? JSON.parse(collected.data).snapshot : null;
  const currentIds = new Set(proposals.length && snapshot
    ? (await currentCaseRows(db.db, snapshot)).map((row) => row.proposal_id).filter(Boolean)
    : []);
  // Bound general activity, but keep the decisions required to interpret every
  // visible case. An old approved survivor must never disappear after 500 events.
  const decisions = await db.all(`SELECT d.* FROM decisions d WHERE
    d.id IN (SELECT id FROM decisions ORDER BY rowid DESC LIMIT 500)
    OR d.id IN (SELECT (
      SELECT latest.id FROM decisions latest WHERE latest.proposal_id=p.id
      ORDER BY latest.rowid DESC LIMIT 1
    ) FROM proposals p WHERE p.status!='superseded')
    OR d.id IN (SELECT (
      SELECT approval.id FROM decisions approval
      WHERE approval.proposal_id=p.id AND approval.action='approve'
      ORDER BY approval.rowid DESC LIMIT 1
    ) FROM proposals p WHERE p.status IN ('applied','partial','applying'))
    ORDER BY d.rowid DESC`);
  const audits = (await db.all('SELECT * FROM audits ORDER BY created DESC LIMIT 1000')).map(
    (row) => ({ ...row, data: JSON.parse(row.data) })
  );
  const privateValues = [
    ...new Set(
      [
        ...credentialValues,
        ...decisions.map((row) => row.session_id),
        ...audits.map((row) => row.data?.session),
      ].filter((value) => typeof value === 'string' && value)
    ),
  ];
  return sanitize(
    {
      mode,
      website: snapshot
        ? {
            run_id: collected.id,
            collected_at: snapshot.retrieved_at ?? collected.finished,
            coverage: {
              complete: !!snapshot.coverage?.complete,
              expected: snapshot.coverage?.expected ?? null,
              found: snapshot.facilities.length,
            },
            facilities: snapshot.facilities,
          }
        : null,
      proposals: proposals.map((row) => ({
        ...JSON.parse(row.data),
        status: row.status,
        created: row.created,
        current: currentIds.has(row.id),
      })),
      runs: runs.map((row) => {
        const saved = JSON.parse(row.data);
        return {
          ...row,
          data: { counts: saved.counts, coverage: saved.snapshot?.coverage, error: saved.error },
        };
      }),
      decisions,
      audits,
    },
    privateValues
  );
}
