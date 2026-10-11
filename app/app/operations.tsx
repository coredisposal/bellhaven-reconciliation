'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { operationalReport } from '../lib/reporting.mjs';
import { requestJson } from '../lib/client-request.mjs';
type Report = Awaited<ReturnType<typeof operationalReport>> & { error?: string };
const kinds: Record<string, string> = {
  unchanged: 'Unchanged',
  field_correction: 'Field correction',
  parent_correction: 'Parent correction',
  duplicate: 'Duplicate accounts',
  ambiguous: 'Needs judgment',
  chow: 'CHOW required',
  new_account: 'New account',
  absent: 'Website absence',
};
const stamp = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString() : 'No completed snapshot';
export default function Operations({ onReview }: { onReview: () => void }) {
  const [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    requestJson('/api/desk/report', {
      signal: controller.signal,
      errorMessage: 'The operations report could not be loaded. Try again.',
    })
      .then((body: Report) => {
        if (!controller.signal.aborted) setReport(body);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [attempt]);
  if (error)
    return (
      <section className="document">
        <h2>Operations report unavailable</h2>
        <p role="alert">{error}</p>
        <button className="secondary" onClick={() => { setError(''); setAttempt((value) => value + 1); }}>
          <RefreshCw size={16} /> Try again
        </button>
      </section>
    );
  if (!report)
    return (
      <section className="empty" role="status">
        <RefreshCw className="spin" />
        <h2>Reading the decision ledger</h2>
      </section>
    );
  const { source, current, history, recovery } = report,
    latest = source.latest_run;
  const attention =
    source.freshness !== 'fresh' ||
    latest?.status === 'failed' ||
    latest?.coverage_complete === false ||
    recovery.case_count > 0;
  return (
    <article className="document ops-report">
      <div className="section-heading">
        <h2>Operations</h2>
        <button className="secondary" onClick={onReview}>
          Open review queue
        </button>
      </div>
      <p className="ops-intro">
        What needs attention, what has been verified, and how current the evidence is.
      </p>
      <div className={'ops-health ' + (attention ? 'attention' : '')}>
        <AlertTriangle size={18} />
        <div>
          <strong>
            {attention ? 'Review service health' : 'Complete source snapshot available'}
          </strong>
          <p>
            {source.freshness === 'no_snapshot'
              ? 'Refresh sources to collect the first complete snapshot.'
              : `Last complete collection: ${stamp(source.last_complete_run?.finished)}.`}{' '}
            {source.freshness === 'stale' ? 'Evidence is more than 26 hours old.' : ''}{' '}
            {latest?.status === 'failed'
              ? 'The latest run failed; counts retain the last complete snapshot.'
              : ''}{' '}
            {latest?.coverage_complete === false
              ? 'The latest crawl was incomplete; it cannot establish website absences.'
              : ''}{' '}
            {recovery.case_count > 0
              ? 'An approved operation needs recovery before further review.'
              : ''}
          </p>
        </div>
      </div>
      <dl className="ops-summary">
        <div>
          <dt>Awaiting review</dt>
          <dd>{current.review_backlog}</dd>
        </div>
        <div>
          <dt>Needs recovery</dt>
          <dd>{recovery.case_count}</dd>
        </div>
        <div>
          <dt>Verified applied, ever</dt>
          <dd>{history.verified_applied_cases}</dd>
        </div>
        <div>
          <dt>Rejected, current snapshot</dt>
          <dd>{current.rejected}</dd>
        </div>
      </dl>
      <div className="ops-columns">
        <section>
          <h3>Current reconciliation cases</h3>
          <p>
            {current.total} cases from {source.counts.facilities} website facilities, including any
            absent-account cases. A rejected change remains unresolved.
          </p>
          <table>
            <caption>Classification in the last complete source snapshot</caption>
            <thead>
              <tr>
                <th scope="col">Classification</th>
                <th scope="col">Cases</th>
              </tr>
            </thead>
            <tbody>
              {current.by_kind.map((r) => (
                <tr key={r.kind}>
                  <th scope="row">{kinds[r.kind] ?? r.kind}</th>
                  <td>{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {current.total === 0 && <p>No complete source snapshot yet.</p>}
        </section>
        <section>
          <h3>Source and decision checks</h3>
          <dl className="ops-facts">
            <div>
              <dt>CRM accounts read</dt>
              <dd>{source.counts.accounts}</dd>
            </div>
            <div>
              <dt>Contacts read</dt>
              <dd>{source.counts.contacts}</dd>
            </div>
            <div>
              <dt>Unresolved cases</dt>
              <dd>{current.unresolved}</dd>
            </div>
            <div>
              <dt>Failed runs since complete collection</dt>
              <dd>{source.failed_runs_since_complete}</dd>
            </div>
            <div>
              <dt>Missing saved proposal versions</dt>
              <dd>{current.missing_ledger_rows}</dd>
            </div>
            <div>
              <dt>Applied cases requiring verification</dt>
              <dd>{current.verification_required}</dd>
            </div>
            <div>
              <dt>Daily schedule</dt>
              <dd>Inactive</dd>
            </div>
          </dl>
          <p className="evidence-foot">
            Current counts use one case per latest complete snapshot. Verified history counts
            distinct cases with approval, completed checkpoints, and readback audit evidence. Reruns
            do not inflate these totals.
          </p>
        </section>
      </div>
      <section className="ops-recovery">
        <h3>Interrupted work</h3>
        {recovery.cases.length ? (
          recovery.cases.map((r) => (
            <div className="run" key={r.proposal_id}>
              <strong>{r.title}</strong>
              <p>
                {r.state} ·{' '}
                {r.steps.filter((s: { status: string }) => s.status !== 'complete').length}{' '}
                incomplete steps. Open the review queue to inspect saved progress before resuming.
              </p>
            </div>
          ))
        ) : (
          <p>No interrupted applications recorded.</p>
        )}
      </section>
      <details className="ops-definitions">
        <summary>Metric definitions and report data</summary>
        <p>
          These are operational controls, not an accuracy score or a revenue-impact estimate. Source
          freshness uses a 26-hour threshold for the documented daily schedule. Counts retain the
          last complete evidence when a later run fails.
        </p>
        <pre>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </article>
  );
}
