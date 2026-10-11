import { canonical, OPEN_PROPOSAL_STATUSES } from './core.mjs';

/** @typedef {import('./ui-types').DeskState} DeskState */
/** @typedef {{view:string,filter:string,search:string,selected:string}} ReviewPosition */
export const NO_SELECTED_CASE = 'no-selected-case';

/** @param {DeskState} data @param {ReviewPosition} position */
export function reviewRows(data, { view, filter, search }) {
  if (!['queue', 'facilities', 'history'].includes(view)) return [];
  const rows = data.proposals.filter((p, index, all) =>
    view === 'history'
      ? ['applied', 'rejected'].includes(p.status)
      : view === 'facilities'
        ? p.facility && (p.current === true ||
          (p.current === undefined && all.findIndex((row) => row.key === p.key) === index))
        : OPEN_PROPOSAL_STATUSES.includes(p.status)
  );
  return rows.filter((p) =>
    (filter === 'all' || p.kind === filter) &&
    `${p.title} ${p.city} ${p.state}`.toLowerCase().includes(search.toLowerCase())
  );
}

/** @param {DeskState} data @param {ReviewPosition} position */
export function activeReview(data, position) {
  if (position.selected === NO_SELECTED_CASE) return undefined;
  const rows = reviewRows(data, position);
  return rows.find((p) => p.id === position.selected) ?? rows[0];
}

function evidence(data, proposal) {
  return canonical({
    proposal,
    decisions: data.decisions.filter((d) => d.proposal_id === proposal.id),
  });
}

/** A background read may refresh metadata, but never replace the case under review.
 * @param {DeskState} current @param {DeskState} incoming @param {ReviewPosition} position
 */
export function planBackgroundRefresh(current, incoming, position) {
  const active = activeReview(current, position);
  if (!active) return { hold: false, selected: position.selected };
  const next = reviewRows(incoming, position).find((p) => p.id === active.id);
  return {
    hold: !next || evidence(current, active) !== evidence(incoming, next),
    // Pin the visible fallback case before a newly inserted row changes ordering.
    selected: active.id,
  };
}

/** Explicit loading follows the same case, including a completed decision.
 * @param {DeskState} current @param {DeskState} incoming @param {ReviewPosition} position
 * @param {{proposalId:string,note:string,option:string}} input
 */
export function adoptPendingRefresh(current, incoming, position, input) {
  const active = activeReview(current, position);
  if (!active) return { ...position, input, missing: false };
  const replacement = incoming.proposals.find((p) => p.key === active.key && p.current) ??
    incoming.proposals.find((p) => p.key === active.key);
  if (!replacement)
    return { ...position, selected: NO_SELECTED_CASE, input, missing: true };
  const inView = reviewRows(incoming, position).some((p) => p.id === replacement.id);
  const changed = evidence(current, active) !== evidence(incoming, replacement);
  return {
    ...position,
    ...(inView ? {} : {
      view: replacement.facility
        ? 'facilities'
        : ['applied', 'rejected'].includes(replacement.status) ? 'history' : 'queue',
      filter: 'all',
      search: '',
    }),
    selected: replacement.id,
    input: input.proposalId === active.id
      ? { proposalId: replacement.id, note: input.note, option: changed ? '' : input.option }
      : input,
    missing: false,
  };
}

/** Invalidate reports after outside decisions, recovery progress, or elapsed freshness.
 * @param {DeskState} data
 */
export function reportRevision(data, at = Date.now()) {
  const complete = data.runs.find((run) => {
    const coverage = run.data?.coverage;
    return run.status === 'complete' && coverage && typeof coverage === 'object' &&
      'complete' in coverage && coverage.complete === true;
  });
  const evidenceTime = data.website?.coverage.complete
    ? data.website.collected_at
    : complete?.started;
  const age = evidenceTime ? Math.floor((at - Date.parse(evidenceTime)) / 1000) : null;
  return canonical({
    stale: age === null ? null : age > 26 * 60 * 60,
    runs: data.runs.map((r) => [r.id, r.status, r.finished]),
    proposals: data.proposals.map((p) => [p.id, p.status]),
    decisions: data.decisions.map((d) => d.id),
    audits: data.audits.map((a) => a?.id),
  });
}

/** A delayed GET from before a mutation must never replace its acknowledged result. */
export function createRefreshGate() {
  let generation = 0;
  let sequence = 0;
  let mutations = 0;
  return {
    get mutating() {
      return mutations > 0;
    },
    read() {
      return { generation, sequence: ++sequence };
    },
    current(ticket) {
      return ticket.generation === generation && ticket.sequence === sequence;
    },
    beginMutation() {
      generation++;
      mutations++;
    },
    endMutation() {
      generation++;
      mutations = Math.max(0, mutations - 1);
    },
  };
}
