'use client';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { DecisionAction } from '../lib/domain-types';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import type { DeskState, ApiResult, ReviewOption } from '../lib/ui-types';
import Operations from './operations';
import Locations from './locations';
import MatchContext from './match-context';
import AccountImpact from './account-impact';
import QualityCase from './quality-case';
import Crm, { ManualCase } from './crm';
import {
  selectedOption,
  draftDestination,
  clearFinishedReview,
  reviewAccount,
  reviewOperation,
  resolutionOptions,
  selectFieldChoice,
  reviewOptionLabel,
  reviewOptionSummary,
  reviewEvidenceCaption,
  applyAcknowledgedDecision,
  reviewAccountImpact,
} from '../lib/review-selection.mjs';
import { formatBalance } from '../lib/case-context.mjs';
import { requestJson } from '../lib/client-request.mjs';
import { streetKey, OPEN_PROPOSAL_STATUSES } from '../lib/core.mjs';
import {
  activeReview,
  reviewRows,
  planBackgroundRefresh,
  adoptPendingRefresh,
  reportRevision,
  createRefreshGate,
  NO_SELECTED_CASE,
} from '../lib/live-refresh.mjs';
import {
  ArrowUpRight,
  Check,
  Search,
  RefreshCw,
  ShieldCheck,
  History,
  Building2,
  ListChecks,
  ArrowRight,
  AlertTriangle,
  Download,
} from 'lucide-react';

const labels: Record<string, string> = {
  field_correction: 'Field correction',
  parent_correction: 'Parent correction',
  chow: 'CHOW required',
  new_account: 'New account',
  duplicate: 'Duplicate accounts',
  ambiguous: 'Needs judgment',
  absent: 'Website absence',
  unchanged: 'Unchanged',
  manual_account: 'Account edit',
  manual_contact: 'Contact edit',
  crm_quality: 'CRM quality',
};
const money = formatBalance;
const date = (v: string) =>
  v
    ? new Date(v).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      })
    : '—';
const display = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));
export default function Desk() {
  const focusCase = useRef(false);
  const [refreshGate] = useState(createRefreshGate);
  const [data, setData] = useState<DeskState>({
      proposals: [],
      runs: [],
      decisions: [],
      audits: [],
    }),
    [csrf, setCsrf] = useState(''),
    [view, setView] = useState('queue'),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [selected, setSelected] = useState(''),
    [reviewInput, setReviewInput] = useState({ proposalId: '', option: '', note: '' }),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [loading, setLoading] = useState(true),
    [hasSnapshot, setHasSnapshot] = useState(false),
    [awaitingConfirmation, setAwaitingConfirmation] = useState(false),
    [sessionAttempt, setSessionAttempt] = useState(0),
    [pendingUpdate, setPendingUpdate] = useState<DeskState | null>(null),
    [syncError, setSyncError] = useState('');
  const reviewPosition = useRef({ data, view, filter, search, selected });
  useEffect(() => {
    reviewPosition.current = { data, view, filter, search, selected };
  }, [data, view, filter, search, selected]);
  useEffect(() => {
    if (!focusCase.current || view !== 'facilities') return;
    focusCase.current = false;
    const detail = document.getElementById('selected-case');
    detail?.focus({ preventScroll: true });
    detail?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [view, selected]);
  const refresh = useCallback(async (preserveReview = false) => {
    const ticket = refreshGate.read();
    const d = await requestJson('/api/desk/state', {
      timeoutMs: 15000, errorMessage: 'Saved results could not be loaded.',
    }) as DeskState;
    if (!refreshGate.current(ticket)) return;
    const current = reviewPosition.current;
    const plan = preserveReview ? planBackgroundRefresh(current.data, d, current) : null;
    if (plan?.hold) setPendingUpdate(d);
    else {
      setData(d);
      setPendingUpdate(null);
      if (plan) setSelected(plan.selected);
    }
    setHasSnapshot(true);
    setAwaitingConfirmation(false);
    setSyncError('');
  }, [refreshGate]);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const s = await requestJson('/api/desk/session', {
          signal: controller.signal, timeoutMs: 15000,
          errorMessage: 'The review session could not be opened.',
        }) as ApiResult;
        if (controller.signal.aborted) return;
        setCsrf(s.csrf);
        await refresh();
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refresh, sessionAttempt]);
  const receiveBackground = useEffectEvent((incoming: DeskState) => {
    setSyncError('');
    setHasSnapshot(true);
    setAwaitingConfirmation(false);
    if (pendingUpdate) {
      setPendingUpdate(incoming);
      return;
    }
    const plan = planBackgroundRefresh(data, incoming, { view, filter, search, selected });
    if (plan.hold) setPendingUpdate(incoming);
    else {
      setData(incoming);
      setSelected(plan.selected);
    }
  });
  useEffect(() => {
    if (loading) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    function schedule() {
      clearTimeout(timer);
      if (!stopped && document.visibilityState === 'visible')
        timer = setTimeout(() => void check(), 30000);
    }
    async function check() {
      if (stopped || document.visibilityState !== 'visible' || request) return;
      if (refreshGate.mutating) {
        schedule();
        return;
      }
      const controller = new AbortController();
      request = controller;
      const ticket = refreshGate.read();
      try {
        const response = await fetch('/api/desk/state', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const incoming = (await response.json()) as DeskState;
        if (!response.ok) throw new Error('Saved results could not be checked.');
        if (!stopped && document.visibilityState === 'visible' &&
            !refreshGate.mutating && refreshGate.current(ticket))
          receiveBackground(incoming);
      } catch {
        if (!stopped && !controller.signal.aborted && !refreshGate.mutating &&
            refreshGate.current(ticket))
          setSyncError('Connection interrupted. Showing saved results; retrying automatically.');
      } finally {
        if (request === controller) request = undefined;
        schedule();
      }
    }
    function visible() {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        request?.abort();
      } else {
        void check();
        schedule();
      }
    }
    function focused() {
      void check();
      schedule();
    }
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', focused);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', focused);
    };
  }, [loading, refreshGate]);
  const cases = data.proposals,
    pending = cases.filter((p) => OPEN_PROPOSAL_STATUSES.includes(p.status));
  const currentFacilities = reviewRows(data, { view: 'facilities', filter: 'all', search: '', selected: '' });
  const position = { view, filter, search, selected };
  const filtered = reviewRows(data, position);
  const p = activeReview(data, position);
  const proposalId = p?.id ?? '';
  const note = reviewInput.proposalId === proposalId ? reviewInput.note : '';
  const option = reviewInput.proposalId === proposalId ? reviewInput.option : '';
  function setNote(value: string) {
    setReviewInput((previous) => ({
      proposalId,
      note: value,
      option: previous.proposalId === proposalId ? previous.option : '',
    }));
  }
  function setOption(value: string) {
    setReviewInput((previous) => ({
      proposalId,
      option: value,
      note: previous.proposalId === proposalId ? previous.note : '',
    }));
  }
  const effectiveOption = selectedOption(p, data.decisions, option);
  const chosen = p?.options.find((o) => o.id === effectiveOption),
    mainAccount = reviewAccount(p, effectiveOption);
  const resolutions: ReviewOption[] = resolutionOptions(p);
  const accountCount = p ? reviewAccountImpact(p, effectiveOption).length : 0;
  const hasAccountComparison = accountCount > 1 || (!!p && accountCount > 0 &&
    ['ambiguous', 'new_account'].includes(p.kind));
  const savedPlan = p && ['applied', 'partial', 'applying'].includes(p.status);
  const historical = !!p && !['pending', 'unchanged'].includes(p.status);
  const { fields, isChow, isNewAccount, changesParent } = reviewOperation(chosen);
  const rejectSelected = effectiveOption === 'reject';
  const requiresNote = p?.kind === 'ambiguous' || !!chosen?.resolution || rejectSelected;
  async function post(path: string, body: Record<string, unknown>, label: string) {
    if (refreshGate.mutating || (path === 'decision' && pendingUpdate)) return;
    refreshGate.beginMutation();
    setBusy(label);
    setAwaitingConfirmation(true);
    setError('');
    setMessage('');
    try {
      const result = await requestJson('/api/desk/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(body),
        timeoutMs: 120000,
        errorMessage: 'The response could not be confirmed. Check the saved results before trying again; the operation may still finish.',
        timeoutMessage: 'The response timed out. Check the saved results before trying again; the operation may still finish.',
      }) as ApiResult;
      if (path === 'decision')
        setData((previous) => ({
          ...previous,
          proposals: applyAcknowledgedDecision(previous.proposals, body.id, result.status),
        }));
      setMessage(
        path === 'pipeline'
          ? `Snapshot complete. ${result.new_proposals} new proposals.${result.open_proposals === undefined ? '' : ` ${result.open_proposals} open after refresh.`}`
          : result.status === 'applied'
            ? chosen?.field_choices && !chosen.operations.length
              ? p?.kind === 'crm_quality' ? 'Review saved. No CRM fields changed.' : 'Your choice to keep current values is saved. No CRM fields changed.'
              : 'Approved changes were read back and verified.'
            : result.status === 'rejected'
              ? 'Proposal rejected. Your decision is saved.'
              : 'Case reopened for fresh review.'
      );
      if (path === 'decision') setReviewInput((previous) => clearFinishedReview(previous, proposalId));
      try {
        await refresh(path === 'pipeline');
      } catch {
        setError(
          `${path === 'pipeline' ? 'The snapshot completed' : 'Your decision was saved'}, but the updated ledger could not be loaded. Reload this page to inspect the saved result.`
        );
      }
    } catch (e) {
      setError((e as Error).message);
      await refresh(path === 'pipeline').catch(() => {});
    } finally {
      refreshGate.endMutation();
      setBusy('');
    }
  }
  function decision(action: DecisionAction) {
    if (p && !pendingUpdate)
      return post(
        'decision',
        { id: p.id, version: p.version, action, optionId: effectiveOption, note },
        action === 'approve'
          ? p.kind === 'crm_quality' && chosen?.field_choices && !chosen.operations.length ? 'Verifying and saving review…' : 'Verifying and applying…'
          : action === 'resume'
            ? 'Reconciling operation…'
            : 'Saving decision…'
      );
  }
  function select(id: string) {
    if (id === p?.id) return;
    setSelected(id);
    setNote('');
    setOption('');
    setError('');
    setMessage('');
  }
  function loadLatest() {
    if (!pendingUpdate || refreshGate.mutating) return;
    const next = adoptPendingRefresh(data, pendingUpdate, position, reviewInput);
    setData(pendingUpdate);
    setView(next.view);
    setFilter(next.filter);
    setSearch(next.search);
    setSelected(next.selected);
    setReviewInput(next.input);
    setPendingUpdate(null);
    setMessage(next.missing
      ? 'This case is no longer in the latest results. Choose another case.'
      : 'Latest results loaded. Review the evidence before continuing.');
  }
  async function retryConnection() {
    setError('');
    if (!csrf) {
      setLoading(true);
      setSessionAttempt((value) => value + 1);
      return;
    }
    setBusy('Checking saved results…');
    try {
      await refresh(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const needsConnection = !csrf || !hasSnapshot || awaitingConfirmation;
  const decisionBusy = busy || (needsConnection ? 'Confirm saved results before deciding.' : pendingUpdate ? 'Load latest results before deciding.' : '');
  const latest = data.runs.find((r) => r.status === 'complete');
  return (
    <div className="desk">
      <a className="skip" href="#main">
        Skip to workspace
      </a>
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brandmark">
            <Building2 size={20} />
          </span>
          <span>
            Bellhaven <b>Review Desk</b>
          </span>
        </Link>
        <div className="top-meta">
          <span className="mode">
            <i />
            Exercise CRM · live
          </span>
        </div>
      </header>
      <div className="notice">
        <ShieldCheck size={16} />
        <span>Live exercise CRM · Anyone with access can approve changes.</span>
      </div>
      <div className="workspace-heading">
        <div>
          <h1>Account review</h1>
          <p>Review proposed changes and keep the billing history intact.</p>
        </div>
        <button
          className="secondary"
          disabled={!!busy || needsConnection}
          onClick={() => post('pipeline', {}, 'Refreshing sources…')}
        >
          <RefreshCw size={16} className={busy === 'Refreshing sources…' ? 'spin' : ''} />
          {busy === 'Refreshing sources…' ? 'Refreshing sources…' : 'Refresh sources'}
        </button>
      </div>
      <div className="workspace-bar">
        <nav aria-label="Workspace">
          {(
            [
              ['queue', 'Review', ListChecks, pending.length],
              ['crm', 'CRM records', Building2, null],
              ['activity', 'Activity', History, null],
            ] satisfies [string, string, LucideIcon, number | null][]
          ).map(([key, label, Icon, count]) => (
            <button
              key={key}
              aria-current={
                (
                  key === 'queue'
                    ? ['queue', 'facilities', 'locations'].includes(view)
                    : key === 'activity'
                      ? ['history', 'runs', 'operations', 'method'].includes(view)
                      : view === key
                )
                  ? 'page'
                  : undefined
              }
              className={
                (
                  key === 'queue'
                    ? ['queue', 'facilities', 'locations'].includes(view)
                    : key === 'activity'
                      ? ['history', 'runs', 'operations', 'method'].includes(view)
                      : view === key
                )
                  ? 'current'
                  : ''
              }
              onClick={() => {
                setView(key === 'activity' ? 'history' : key);
                setFilter('all');
                setSearch('');
              }}
            >
              <Icon size={16} />
              {label}
              {count !== null && <span>{count}</span>}
            </button>
          ))}
        </nav>
        <span className="updated">
          {latest ? `Updated ${date(latest.finished)}` : 'No completed snapshot yet'}
        </span>
      </div>
      {['queue', 'facilities', 'locations'].includes(view) && (
        <nav className="review-views" aria-label="Review views">
          <button
            aria-current={view !== 'locations' ? 'page' : undefined}
            onClick={() => setView('queue')}
          >
            Proposed changes
          </button>
          <button
            aria-current={view === 'locations' ? 'page' : undefined}
            onClick={() => setView('locations')}
          >
            Website locations
            {data.website && <span>{data.website.facilities.length}</span>}
          </button>
        </nav>
      )}
      {['history', 'runs', 'operations', 'method'].includes(view) && (
        <div className="activity-select">
          <label>
            Activity view
            <select value={view} onChange={(e) => setView(e.target.value)}>
              <option value="history">Decisions</option>
              <option value="operations">Operations report</option>
              <option value="runs">Source refreshes</option>
              <option value="method">Method & results</option>
            </select>
          </label>
        </div>
      )}
      <div className="announcements" aria-live="polite">
        {!loading && !busy && needsConnection && (
          <div className="working" role="status">
            <span>{!csrf ? 'A review session is required to make changes.' : awaitingConfirmation
              ? 'Confirm the saved result before making another decision.'
              : 'Saved results have not loaded yet.'}</span>
            <button className="secondary" onClick={retryConnection}>
              {!csrf ? 'Retry connection' : 'Retry saved results'}
            </button>
          </div>
        )}
        {pendingUpdate && (
          <div className="working" role="status">
            <span>New results available. Load them before deciding.</span>
            <button className="secondary" disabled={!!busy} onClick={loadLatest}>
              Load latest
            </button>
          </div>
        )}
        {syncError && <div className="working" role="status">{syncError}</div>}
        {error && (
          <div role="alert" className="error">
            <AlertTriangle size={18} />
            <span>{error}</span>
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        {message && (
          <div className="success">
            <Check size={17} />
            {message}
          </div>
        )}
        {busy && (
          <div className="working">
            {busy} Keep this page open; decisions and operation progress are saved.
          </div>
        )}
      </div>
      <main id="main">
        {loading || !hasSnapshot ? (
          <div className="empty" role="status">
            <RefreshCw className={loading ? 'spin' : ''} />
            <h2>{loading ? 'Opening the review desk' : 'Saved results unavailable'}</h2>
            <p>{loading ? 'Loading saved evidence and decisions…' : 'Reconnect above to load the existing queue.'}</p>
          </div>
        ) : view === 'locations' ? (
          <Locations
            snapshot={data.website}
            latestRun={data.runs[0]}
            onReview={(sourceUrl) => {
              const match = currentFacilities.find((item) => item.key === sourceUrl);
              if (!match) return;
              focusCase.current = true;
              setFilter('all');
              setSearch('');
              setView('facilities');
              setSelected(match.id);
              setReviewInput({ proposalId: '', option: '', note: '' });
            }}
          />
        ) : view === 'crm' ? (
          <Crm
            csrf={csrf}
            onDraft={async (draft) => {
              refreshGate.beginMutation();
              try {
                await refresh();
              } finally {
                refreshGate.endMutation();
              }
              const destination = draftDestination(draft.status);
              setSelected(draft.id);
              setView(destination.view);
              setFilter('all');
              setSearch('');
              setReviewInput({ proposalId: '', option: '', note: '' });
              setMessage(destination.message);
            }}
          />
        ) : view === 'operations' ? (
          <Operations
            key={reportRevision(data)}
            onReview={() => setView('queue')}
          />
        ) : view === 'method' ? (
          <Method data={data} />
        ) : view === 'runs' ? (
          <div className="document">
            <div className="section-heading">
              <h2>Pipeline runs</h2>
              <span>Reads and proposals only · scheduling inactive</span>
            </div>
            {data.runs.length === 0 ? (
              <p>Refresh sources to collect the first snapshot.</p>
            ) : (
              data.runs.map((r) => (
                <article className="run" key={r.id}>
                  <span className={'badge ' + r.status}>{r.status}</span>
                  <h3>{date(r.started)}</h3>
                  <p>
                    {r.data.error ?? (r.status === 'running'
                      ? 'Collecting website and CRM evidence… Counts appear when the refresh completes.'
                      : `${r.data.counts?.accounts ?? '—'} accounts · ${r.data.counts?.contacts ?? '—'} contacts · ${r.data.counts?.facilities ?? '—'} locations · ${r.data.counts?.new_proposals ?? '—'} new proposals${r.data.counts?.open_proposals === undefined ? '' : ` · ${r.data.counts.open_proposals} open after refresh`}`)}
                  </p>
                  <details>
                    <summary>Coverage and classifications</summary>
                    <pre>{JSON.stringify(r.data, null, 2)}</pre>
                  </details>
                </article>
              ))
            )}
          </div>
        ) : (
          <div className="workbench">
            <aside className="queue" aria-label="Proposal queue">
              <div className="queue-tools">
                <h2>
                  {view === 'history'
                    ? 'Decision history'
                    : view === 'facilities'
                      ? 'Website facilities'
                      : 'Ready for review'}
                  <span>{filtered.length}</span>
                </h2>
                <label className="search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search accounts or contacts"
                    aria-label="Search accounts or contacts"
                  />
                </label>
                {['queue', 'facilities'].includes(view) && (
                  <label className="filter">
                    Records
                    <select
                      aria-label="Review scope"
                      value={view}
                      onChange={(e) => {
                        setView(e.target.value);
                        setFilter('all');
                        setSearch('');
                      }}
                    >
                      <option value="queue">Awaiting review</option>
                      <option value="facilities">All website facilities</option>
                    </select>
                  </label>
                )}
                <label className="filter">
                  Change
                  <select
                    aria-label="Filter by classification"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All classifications</option>
                    {Object.entries(labels).map(([k, v]) => (
                      <option key={k} value={k}>
                        {String(v)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="queue-list">
                {filtered.length ? (
                  filtered.map((item) => (
                    <button
                      key={item.id}
                      className={'case-row ' + (item.id === p?.id ? 'selected' : '')}
                      aria-current={item.id === p?.id ? 'true' : undefined}
                      onClick={() => select(item.id)}
                    >
                      <span className="case-title">{item.title}</span>
                      <span className="case-locality">
                        {[item.city, item.state].filter(Boolean).join(', ') || (item.kind === 'crm_quality' ? 'CRM-wide check' : 'CRM record')}
                        <ArrowRight size={14} />
                      </span>
                      <span className="case-bottom">
                        <span className={'classification ' + item.kind}>{labels[item.kind]}</span>
                        {['applied', 'rejected', 'partial', 'stale'].includes(item.status) && (
                          <span className="small-status">{item.kind === 'crm_quality' && item.status === 'applied' && item.options.find((option) => option.id === selectedOption(item, data.decisions))?.operations.length === 0 ? 'Reviewed' : item.status}</span>
                        )}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="queue-empty">
                    <Check size={24} />
                    <h3>
                      {search || filter !== 'all' ? 'No matching cases' : 'Nothing waiting here'}
                    </h3>
                    <p>
                      {cases.length
                        ? 'Saved decisions stay closed until material evidence changes.'
                        : 'Refresh sources to build the first queue.'}
                    </p>
                  </div>
                )}
              </div>
              <div className="queue-footer">
                <ShieldCheck size={14} />
                <span>No CRM writes during refresh</span>
                {p && (
                  <a className="mobile-case-jump" href="#selected-case">
                    View {p.title} <ArrowRight size={13} />
                  </a>
                )}
              </div>
            </aside>
            {p?.kind === 'crm_quality' ? (
              <QualityCase
                proposal={p}
                decisions={data.decisions}
                optionId={effectiveOption}
                setOption={setOption}
                note={note}
                setNote={setNote}
                busy={decisionBusy}
                mutationBusy={!!busy}
                onDecision={decision}
              />
            ) : p?.manual ? (
              <ManualCase
                proposal={p}
                decisions={data.decisions}
                note={note}
                setNote={setNote}
                busy={decisionBusy}
                mutationBusy={!!busy}
                onDecision={decision}
              />
            ) : p ? (
              <section
                id="selected-case"
                tabIndex={-1}
                className="case-detail"
                aria-label={'Evidence for ' + p.title}
              >
                <div className="case-header">
                  <div className="case-status">
                    <span className={'badge ' + p.kind}>{labels[p.kind]}</span>
                    <span>{p.status === 'pending' ? 'Awaiting decision' : p.status}</span>
                  </div>
                  <h2>{p.title}</h2>
                  <p>
                    {p.city}, {p.state}
                    {p.facility && (
                      <>
                        {' '}
                        ·{' '}
                        <a href={p.facility.source_url} target="_blank" rel="noreferrer">
                          Website evidence <ArrowUpRight size={13} />
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <MatchContext proposal={p} optionId={effectiveOption} showIdentity={!hasAccountComparison} />
                {['applied', 'partial', 'applying'].includes(p.status) && !chosen && (
                  <p role="alert" className="error">
                    The saved approval option is missing from the loaded history. Reload the page
                    before inspecting or resuming this case.
                  </p>
                )}
                {(p.kind === 'ambiguous' || resolutions.length > 1) && p.status !== 'unchanged' && (
                  <fieldset className="choice" disabled={!!decisionBusy || p.status !== 'pending'}>
                    <legend>{historical ? 'Resolutions at review time' : 'Choose a resolution'}</legend>
                    <p id="resolution-help">{historical ? 'These choices belong to the saved proposal.' : 'Select the outcome supported by your review. Compare the changes below before applying.'}</p>
                    {resolutions.map((o) => (
                      <label className="resolution-option" key={o.id}>
                        <input type="radio" name="resolution" value={o.id}
                          checked={(chosen?.base_option_id ?? effectiveOption) === (o.base_option_id ?? o.id)}
                          onChange={() => setOption(o.id)} aria-describedby="resolution-help" />
                        <span>
                          <strong>{reviewOptionLabel(p, o)}</strong>
                          <span>{reviewOptionSummary(chosen && (chosen.base_option_id ?? chosen.id) === (o.base_option_id ?? o.id) ? chosen : o)}</span>
                        </span>
                      </label>
                    ))}
                    <label className="resolution-option">
                      <input type="radio" name="resolution" value="reject"
                        checked={rejectSelected}
                        onChange={() => setOption('reject')} />
                      <span><strong>Leave CRM unchanged</strong><span>Reject this proposal with a reason. Unchanged evidence will not reopen it.</span></span>
                    </label>
                    {!p.options.length && <p>No CRM change is prepared for this saved case. Refresh sources to check for updated evidence and choices.</p>}
                  </fieldset>
                )}

                {hasAccountComparison && <AccountImpact proposal={p} optionId={effectiveOption} />}
                {((!hasAccountComparison && mainAccount) || isChow || changesParent) && <div className={'billing ' + (isChow ? 'protected' : '')}>
                  <div className="billing-title">
                    <ShieldCheck size={19} />
                    <h3>
                      {savedPlan ? 'Billing at approval'
                        : historical ? 'Billing at review time'
                        : isChow
                        ? 'Protect the original billing account'
                        : 'Billing checkpoint'}
                    </h3>
                  </div>
                  <div className="billing-values">
                    <div>
                      <span>Lifetime revenue</span>
                      <strong>
                        {mainAccount
                          ? money(mainAccount.lifetime_revenue)
                          : isNewAccount
                            ? 'New account'
                            : 'Not verified'}
                      </strong>
                    </div>
                    <div>
                      <span>Outstanding AR</span>
                      <strong>
                        {mainAccount
                          ? money(mainAccount.outstanding_ar)
                          : isNewAccount
                            ? '$0'
                            : 'Not verified'}
                      </strong>
                    </div>
                    <div className="billing-rule">
                      <strong>
                        {isChow
                          ? 'Create, then link.'
                          : changesParent
                            ? 'Direct parent update permitted.'
                            : p.kind === 'absent'
                              ? 'Affiliation stays unchanged.'
                              : 'Preserve existing history.'}
                      </strong>
                      <span>
                        {isChow
                          ? 'Keep the original account intact and link it to the replacement.'
                          : changesParent
                            ? 'Revenue and unpaid AR are not both positive.'
                            : 'No transfer of revenue, receivables, or contacts is proposed.'}
                      </span>
                    </div>
                  </div>
                </div>}
                <section className="evidence">
                  <div className="section-heading">
                    <h3>Compare the evidence</h3>
                    <span>
                      {savedPlan ? 'Saved approval · original evidence'
                        : historical ? 'Saved proposal · original evidence'
                        : chosen
                          ? reviewEvidenceCaption(chosen)
                          : p.options.some((o) => o.operations.length) && !rejectSelected
                            ? 'Choose a resolution to preview changes'
                            : 'Evidence only · no changes selected'}
                    </span>
                  </div>
                  <div className="comparison" role="table" aria-label="CRM and website evidence">
                    <div className="comparison-head" role="row">
                      <span role="columnheader">Field</span>
                      <span role="columnheader">
                        {savedPlan ? 'CRM before approval' : historical ? 'CRM at review time' : isChow ? 'Original account · retained' : 'CRM account'}
                      </span>
                      <span role="columnheader">
                        {savedPlan ? 'Approved values / source evidence'
                          : historical ? 'Saved proposed values / source evidence'
                          : !p.facility ? 'Proposed value / retained'
                          : isChow || isNewAccount
                          ? 'New account under Bellhaven'
                          : chosen?.operations.length
                            ? 'Website / proposed value'
                            : 'Website evidence'}
                      </span>
                    </div>
                    {(
                      [
                        ['Name', 'name', p.facility?.name],
                        ['Parent', 'parent_id', p.facility ? p.parent?.name : mainAccount?.parent_name || mainAccount?.parent_id],
                        ['Street', 'billing_street', p.facility?.street_address],
                        [
                          'City / state',
                          'billing_city',
                          p.facility ? `${p.facility.city}, ${p.facility.state}` : null,
                        ],
                        ['ZIP', 'billing_zip', p.facility?.postal_code],
                        ['Care offerings', 'care_type', p.facility?.care_offerings.join('; ')],
                        ['Phone', 'phone', p.facility?.phone_raw],
                        ['Status', 'status', fields.status ?? mainAccount?.status],
                      ] satisfies [string, string, unknown][]
                    ).map(([label, key, value]) => {
                      const changed = Object.hasOwn(fields, key) ||
                        (key === 'billing_city' && Object.hasOwn(fields, 'billing_state'));
                      const careChoice = key === 'care_type' ? chosen?.field_choices?.care_type : undefined;
                      const phoneChoice = key === 'phone' ? chosen?.field_choices?.phone : undefined;
                      const optional = !!careChoice || !!phoneChoice;
                      return (
                      <div
                        className={
                          'comparison-row ' + (changed && !careChoice ? 'changed' : '') + (optional ? ' optional-field' : '')
                        }
                        key={key}
                        role="row"
                      >
                        <span role="rowheader">{label}</span>
                        <span role="cell">
                          {key === 'parent_id'
                            ? display(mainAccount?.parent_name || mainAccount?.parent_id || (mainAccount ? 'No parent assigned' : null))
                            : key === 'billing_city' && mainAccount
                              ? `${mainAccount.billing_city}, ${mainAccount.billing_state}`
                              : display(mainAccount?.[key!])}
                        </span>
                        <span role="cell">
                          <span className="proposed-field-value">
                          {careChoice ? `Website: ${display(value)}` : display(
                            !careChoice && Object.hasOwn(fields, key!) &&
                              key !== 'parent_id' &&
                              key !== 'billing_city'
                              ? fields[key!]
                              : !p.facility && mainAccount ? key === 'billing_city' ? `${mainAccount.billing_city}, ${mainAccount.billing_state}` : key === 'parent_id' ? value : mainAccount[key]
                              : value
                          )}
                          {changed && !careChoice && <Check size={13} />}
                          </span>
                          {careChoice && (
                            <label className={'field-control' + (changed ? ' selected-field-change' : '')}>
                              <span className="field-control-heading">CRM care category {changed && <Check size={13} aria-label="Included in this approval" />}</span>
                              <select aria-label="CRM care category" value={careChoice.selected ?? ''}
                                disabled={!!decisionBusy || p.status !== 'pending'}
                                onChange={(event) => setOption(selectFieldChoice(p, effectiveOption, 'care_type', event.target.value || null))}>
                                {careChoice.current !== null && <option value="">Keep current{careChoice.current ? `: ${careChoice.current}` : ' (blank)'}</option>}
                                {careChoice.values.map((category) => <option key={category} value={category}>{category}</option>)}
                              </select>
                            </label>
                          )}
                          {phoneChoice && (
                            <label className="field-control phone-control">
                              <input type="checkbox" checked={phoneChoice.selected}
                                disabled={!!decisionBusy || p.status !== 'pending'}
                                onChange={(event) => setOption(selectFieldChoice(p, effectiveOption, 'phone', event.target.checked))} />
                              <span>Use website phone</span>
                            </label>
                          )}
                        </span>
                      </div>
                      );
                    })}
                  </div>
                  {p.facility && (Object.hasOwn(fields, 'care_type') || chosen?.field_choices?.care_type) && (
                    <p className="evidence-foot">
                      The CRM stores one care category. Memory Support maps to Memory Care; Short-Term Rehabilitation &amp; Nursing maps to Skilled Nursing. The complete website list stays in the evidence
                      {p.facility.care_offerings.length > 1 ? ' and approved account note' : ''}.
                    </p>
                  )}
                  <p className="evidence-foot">
                    {p.facility
                      ? `Retrieved ${date(p.facility.retrieved_at_utc)}.${chosen?.field_choices && p.status === 'pending' ? ' Your field choices are saved when you approve; unchanged evidence will not suggest them again.' : ''}`
                      : 'Complete directory and homepage crawl. Absence does not prove a sale or closure.'}
                  </p>
                </section>

                {p.status !== 'unchanged' && (
                  <div className="decision-panel">
                    <div className="decision-context">
                      <h3>
                        {['partial', 'applying'].includes(p.status) ? 'Finish approved work'
                          : ['applied', 'rejected'].includes(p.status)
                          ? 'Decision saved'
                          : 'Your decision'}
                      </h3>
                    </div>
                    {data.decisions
                      .filter((d) => d.proposal_id === p.id)
                      .map((d) => (
                        <p key={d.id} className="saved-decision">
                          <strong>{d.action}</strong> · {date(d.created)} · {d.actor}
                          <br />
                          {d.note || 'No additional reviewer note.'}
                        </p>
                      ))}
                    {p.status !== 'applied' && (
                      <>
                        {Object.hasOwn(fields, 'note') && (
                          <div className="approval-summary">
                              <details>
                                <summary>{savedPlan ? 'CRM note in the saved approval' : historical ? 'CRM note in the saved proposal' : 'CRM note included in this approval'}</summary>
                                <p>{fields.note}</p>
                              </details>
                          </div>
                        )}
                        <label htmlFor="reviewer-note">Reviewer note</label>
                        <textarea
                          id="reviewer-note"
                          rows={3}
                          maxLength={2000}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder={
                            ['stale', 'rejected'].includes(p.status)
                              ? 'Explain why this case should be reopened.'
                              : ['partial', 'applying'].includes(p.status)
                              ? 'Optional note for resuming the saved approval.'
                              : requiresNote
                              ? 'Explain your choice, or why you are rejecting it.'
                              : 'Optional for approval; required for rejection.'
                          }
                          disabled={!!busy}
                        />
                        <div className="decision-actions">
                          {p.status === 'pending' ? (
                            <>
                              <button
                                className="secondary"
                                disabled={!!decisionBusy || !note.trim()}
                                onClick={() => decision('reject')}
                              >
                                Reject proposal
                              </button>
                              {!rejectSelected && <button
                                className="primary"
                                disabled={
                                  !!decisionBusy ||
                                  (!chosen?.operations.length && !chosen?.field_choices) ||
                                  (requiresNote && !note.trim())
                                }
                                onClick={() => decision('approve')}
                              >
                                <Check size={16} />
                                {chosen?.field_choices && !chosen.operations.length ? 'Save choice' : 'Approve and apply'}
                              </button>}
                            </>
                          ) : ['partial', 'applying'].includes(p.status) ? (
                            <button
                              className="primary"
                              disabled={!!decisionBusy || !chosen}
                              onClick={() => decision('resume')}
                            >
                              Resume approved operation
                            </button>
                          ) : ['stale', 'rejected'].includes(p.status) ? (
                            <button
                              className="secondary"
                              disabled={!!decisionBusy || !note.trim()}
                              onClick={() => decision('reopen')}
                            >
                              Reopen for review
                            </button>
                          ) : null}
                        </div>
                        <p className="decision-foot">
                          {['partial', 'applying'].includes(p.status) ? 'Resume uses the saved approval and checks completed steps before continuing.'
                            : p.status === 'stale' ? 'Refresh sources and review the current evidence before a new approval.'
                            : p.status === 'rejected' ? 'Reopening requires a reason and retains this saved rejection.'
                            : rejectSelected ? 'Rejection saves your reason without changing any CRM record.'
                            : p.kind === 'ambiguous' && !chosen ? p.options.length ? 'Choose a resolution above to preview the exact changes.' : 'Resolve the evidence issue and refresh sources, or reject with a reason.'
                            : requiresNote && !note.trim() ? 'Add a reviewer note explaining your choice to enable approval.'
                            : chosen?.field_choices && !chosen.operations.length ? 'Saves your choice to keep current values. No CRM fields will change.'
                            : 'Approval applies these changes after a fresh evidence check.'}
                        </p>
                      </>
                    )}
                  </div>
                )}
                <details className="supporting-details">
                  <summary>Supporting evidence</summary>
                  <p className="evidence-foot">Proposal version {p.version.slice(0, 10)}</p>{' '}
                  {p.facility && (
                    <details className="match-evidence">
                      <summary>How this location was matched</summary>
                      <p>
                        {p.candidates.length === 1
                          ? 'One candidate matches this location.'
                          : p.candidates.length > 1
                            ? `${p.candidates.length} candidate accounts match this location; the reviewer must resolve any tie.`
                            : 'No supported current account match found.'}{' '}
                        Matching does not change CRM fields.
                      </p>
                      <dl>
                        <div>
                          <dt>Website address</dt>
                          <dd>
                            {p.facility.street_address}, {p.facility.city}, {p.facility.state}
                          </dd>
                        </div>
                        <div>
                          <dt>Comparison key</dt>
                          <dd>
                            {streetKey(p.facility.street_address)} · {p.facility.city.toLowerCase()}{' '}
                            · {p.facility.state.toLowerCase()}
                          </dd>
                        </div>
                      </dl>
                      <p className="evidence-foot">
                        Pike/Pk and directional abbreviations compare consistently. Original values
                        stay in the saved evidence. Account changes, notes and duplicate links
                        require approval.
                      </p>
                    </details>
                  )}{' '}
                  <details className="candidate-section" open={p.kind === 'ambiguous' || undefined}>
                    <summary>
                      Accounts considered ({p.candidates.length + p.alternatives.length})
                    </summary>
                    {[...p.candidates, ...p.alternatives].map((c, i) => (
                      <details
                        key={c.account.account_id}
                        open={p.kind === 'ambiguous' || undefined}
                      >
                        <summary>
                          <div>
                            <strong>{c.account.name}</strong>
                            <span>
                              {c.account.account_id} · {c.account.billing_city},{' '}
                              {c.account.billing_state}
                            </span>
                          </div>
                          <span className="candidate-label">
                            {i < p.candidates.length ? 'Location match' : 'Conflicting evidence'}
                          </span>
                        </summary>
                        <div className="candidate-body">
                          <p>
                            {c.account.billing_street}, {c.account.billing_city},{' '}
                            {c.account.billing_state} {c.account.billing_zip}
                          </p>
                          <p>
                            {c.account.parent_name || 'No parent'} ·{' '}
                            {money(c.account.lifetime_revenue)} revenue ·{' '}
                            {money(c.account.outstanding_ar)} AR
                          </p>
                          <p>{c.reasons?.join(' · ') || 'No corroborating identity evidence.'}</p>
                          {c.conflicts?.length > 0 && (
                            <p className="conflicts">Differences: {c.conflicts.join('; ')}</p>
                          )}
                          <p>
                            Active contacts:{' '}
                            {c.contacts?.filter((contact) => contact.is_active).map((x) => `${x.name} (${x.title})`).join('; ') || 'None linked in this snapshot'}
                          </p>
                        </div>
                      </details>
                    ))}
                    {chosen?.reason && (
                      <p className="explanation">Resolution rationale: {chosen.reason}</p>
                    )}
                  </details>
                  <details className="operations">
                    <summary>Exact API changes</summary>
                    {chosen?.operations.some((o) => ['create', 'chow'].includes(o.type)) && (
                      <p className="evidence-foot">
                        Creation also appends a recovery marker to the account note, derived from
                        this approved version.
                        {chosen.operations.some((o) => o.type === 'chow')
                          ? ' The only patch to the original account sets chow_current_account to the new CRM ID.'
                          : ''}
                      </p>
                    )}
                    {chosen?.operations.length ? (
                      chosen.operations.map((o, i) => (
                        <details key={i}>
                          <summary>
                            <span>
                              {o.type === 'chow'
                                ? 'Create replacement and link original'
                                : o.type === 'create'
                                  ? 'Create facility under Bellhaven'
                                  : o.type === 'duplicate'
                                    ? 'Mark losing copy Inactive'
                                    : 'Update existing account'}
                            </span>
                            <span>{o.account_id ?? 'New ID assigned by CRM'}</span>
                          </summary>
                          <pre>{JSON.stringify(o.fields, null, 2)}</pre>
                        </details>
                      ))
                    ) : (
                      <p>
                        {p.kind === 'unchanged'
                          ? 'No CRM changes needed.'
                          : chosen?.field_choices && !chosen.operations.length
                            ? 'The choice to keep current values is recorded in decision history. No CRM API writes are included.'
                          : rejectSelected ? 'No CRM writes. The rejection and reason are saved in decision history.'
                          : !p.options.length ? 'No CRM write is prepared until the evidence issue is resolved.'
                          : 'Choose a supported option or reject the proposal.'}
                      </p>
                    )}
                  </details>
                </details>
              </section>
            ) : (
              <section className="empty">
                <ShieldCheck size={36} />
                <h2>{selected === NO_SELECTED_CASE ? 'Choose another case' : cases.length ? 'All clear in this view' : 'Start with a fresh snapshot'}</h2>
                <p>
                  {selected === NO_SELECTED_CASE
                    ? 'The previously selected case is no longer in the latest results.'
                    : cases.length
                    ? 'Choose another view to inspect facilities and saved decisions.'
                    : 'Refresh sources to read every website location, CRM account, and contact.'}
                </p>
              </section>
            )}
          </div>
        )}
      </main>
      <footer className="page-footer">
        <span>Bellhaven Review Desk · Fictional CRM assessment</span>
        <a href="/api/desk/export" target="_blank" rel="noreferrer">
          <Download size={14} />
          Export audit trail
        </a>
      </footer>
    </div>
  );
}
function Method({ data }: { data: DeskState }) {
  const latest = data.runs.find((r) => r.status === 'complete');
  return (
    <article className="document method">
      <div className="section-heading">
        <h2>Method & results</h2>
        <span>Saved ledger history</span>
      </div>
      <p className="lead">
        Facilities are matched by physical location, then checked against CRM account evidence.
        Ownership corrections preserve billing history and require explicit approval.
      </p>
      <div className="result-line">
        <span>
          <strong>{latest?.data.counts?.facilities ?? '—'}</strong> website locations
        </span>
        {['applied', 'rejected', 'partial'].map((s) => (
          <span key={s}>
            <strong>
              {new Set(data.proposals.filter((p) => p.status === s).map((p) => p.key)).size}
            </strong>{' '}
            distinct {s} cases in history
          </span>
        ))}
      </div>
      <h3>Collect the whole picture</h3>
      <p>
        The scraper follows directory pagination and homepage facility links. That includes Findlay,
        which is missing from the directory. Accounts and contacts are paginated separately. Each
        run saves source pages, original values, timestamps, and coverage checks. A failed crawl
        never becomes evidence that a facility disappeared.
      </p>
      <h3>Match the location, then assess the account</h3>
      <p>
        Street normalization retains house numbers and directions. City and state must agree. Names,
        phone numbers, and active administrator contacts support the match. An exact name with a
        conflicting address needs identity verification when no physical match is established.
        Conflicting records stay visible beside the website evidence.
      </p>
      <p>
        Website care lists remain complete. Short-Term Rehabilitation & Nursing maps to Skilled
        Nursing, and Memory Support maps to Memory Care. Reviewers can keep the current category or choose a supported website category; the full list remains in notes because
        the API exposes one care category. Phone replacement is optional within a proposed correction. Billing PO boxes are preserved. Equivalent street
        spellings can be proposed as explicit address changes; prior names and addresses are
        retained in the same approved CRM note.
      </p>
      <h3>Keep billing history where it belongs</h3>
      <p>
        When a parent change involves both positive lifetime revenue and outstanding AR, the app
        creates a replacement under Bellhaven and sets only the original account’s CHOW link.
        Otherwise, it proposes a direct parent update. Duplicate choices prioritize billing history,
        current affiliation, corroborating evidence, and contacts. Ties require a choice and
        explanation.
      </p>
      <h3>Make the decision durable</h3>
      <p>
        Source refreshes never write to the CRM. Decisions reference immutable proposal versions.
        Before applying, the service rechecks evidence and affected records. Approval and operation
        checkpoints persist before changes begin, and every change is read back. Uncertain account
        creation is reconciled using a deterministic marker. Contact creation uses its acknowledged
        ID; an uncertain response without an ID requires recovery and is never blindly retried.
      </p>
      <h3>Evidence boundaries</h3>
      <p>
        CRM quality checks inspect all accounts and contacts for overlapping records, broken account
        links, invalid billing values, shared contact emails, and contacts on retired or missing
        accounts. They also catch optional website field differences on already matched facilities.
        Each finding presents its evidence and explicit choices. Recording a review can leave CRM
        data unchanged; a saved acknowledgment does not prove an unresolved fact has been corrected.
      </p>
      <p>
        The website supports operator affiliation in this fictional exercise; it does not establish
        legal ownership or acquisition dates. Contacts inform automated matching. Any separate
        contact edit must be explicitly prepared and approved in CRM records. Phone differences
        remain visible. Missing listings receive a review flag without an invented new owner.
      </p>
      <h3>Reporting and operational ownership</h3>
      <p>
        The Operations view uses SQL against the saved ledger to separate current review work from
        historical decisions. Failed or incomplete runs retain the last complete source snapshot. An
        approval alone is not counted as a verified application. Interrupted operations retain
        checkpoints so recovery can reuse existing accounts without repeating completed work.
      </p>
      <h3>Daily operation</h3>
      <p>
        The repository includes an inactive daily workflow that refreshes proposals only. Decisions
        survive reruns, and local review uses the hosted ledger. The CRM API exposes neither
        conditional updates nor creation idempotency keys, so uncertain creations require
        investigation before another write.
      </p>
    </article>
  );
}
