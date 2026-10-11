import type { Proposal } from '../lib/ui-types';
import { reviewContext } from '../lib/case-context.mjs';
import { reviewAccount, reviewAccountImpact } from '../lib/review-selection.mjs';

/** Keep evidence and consequences visible without expanding implementation details. */
export default function MatchContext({ proposal, optionId, showIdentity = true }: { proposal: Proposal; optionId: string; showIdentity?: boolean }) {
  const context = reviewContext(proposal, optionId);
  const account = reviewAccount(proposal, optionId);
  const visibleIds = new Set(reviewAccountImpact(proposal, optionId).map((row) => row.account.account_id));
  const otherRecords = proposal.alternatives.filter((candidate) => !visibleIds.has(candidate.account.account_id));
  return (
    <div className="review-context">
      <p className="case-summary">{context.reason}</p>
      {context.statusNotice && <p className="review-status-note">{context.statusNotice}</p>}
      <dl>
        {showIdentity && account && proposal.candidates.length <= 1 && (
          <div><dt>CRM record</dt><dd>{account.name} · {account.account_id}<span>{account.parent_name || account.parent_id || 'No parent assigned'}</span></dd></div>
        )}
        {proposal.kind === 'ambiguous' && proposal.facility && (
          <div><dt>Website</dt><dd>{proposal.facility.street_address}, {proposal.facility.city}, {proposal.facility.state} {proposal.facility.postal_code}</dd></div>
        )}
        <div><dt>Evidence</dt><dd>{context.evidence}</dd></div>
        {context.attention && <div className="review-attention"><dt>Check</dt><dd>{context.attention}</dd></div>}
        {otherRecords.length > 0 && <div><dt>Other records</dt><dd>{otherRecords.length} other {otherRecords.length === 1 ? 'record was' : 'records were'} checked and left unchanged. See Supporting evidence for the conflicting details.</dd></div>}
        <div><dt>{context.outcomeLabel}</dt><dd>{context.outcome}</dd></div>
      </dl>
    </div>
  );
}
