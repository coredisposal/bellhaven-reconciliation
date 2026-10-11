import type { Account, Proposal } from '../lib/ui-types';
import { reviewAccountImpact } from '../lib/review-selection.mjs';
import { formatBalance } from '../lib/case-context.mjs';

/** Keep the accounts and billing consequences visible beside the resolution. */
export default function AccountImpact({ proposal, optionId }: { proposal: Proposal; optionId: string }) {
  const rows: { account: Account; action: string; link: string | null }[] = reviewAccountImpact(proposal, optionId);
  const contactsByAccount = new Map([...proposal.candidates, ...proposal.alternatives, ...(proposal.linked_accounts ?? [])]
    .map((candidate) => [candidate.account.account_id, candidate.contacts.filter((contact) => contact.is_active)]));
  if (!rows.length) return null;
  return (
    <section className="account-impact" aria-label="Accounts in this review">
      <h3>Accounts in this review <span>{rows.length}</span></h3>
      <table>
        <thead><tr><th scope="col">CRM account</th><th scope="col">Lifetime revenue</th><th scope="col">Outstanding AR</th><th scope="col">{['applied', 'partial', 'applying'].includes(proposal.status) ? 'Approved action' : proposal.status === 'rejected' ? 'Saved decision' : ['stale', 'superseded'].includes(proposal.status) ? 'Previous proposed action' : 'Selected action'}</th></tr></thead>
        <tbody>{rows.map(({ account, action, link }) => (
          <tr key={account.account_id}>
            <th scope="row">
              <strong>{account.name}</strong>
              <span>{account.account_id} · {account.status}</span>
              <span>{account.parent_name || account.parent_id || 'No parent'}</span>
              {(proposal.kind === 'ambiguous' || proposal.kind === 'absent' || !proposal.candidates.length) && <span>{account.billing_street || 'Street missing'}, {account.billing_city}, {account.billing_state} {account.billing_zip}</span>}
              {!!contactsByAccount.get(account.account_id)?.length && <span>{contactsByAccount.get(account.account_id)!.length} active {contactsByAccount.get(account.account_id)!.length === 1 ? 'contact' : 'contacts'} · kept on this account</span>}
            </th>
            <td className="impact-balance"><span>Lifetime revenue</span>{formatBalance(account.lifetime_revenue)}</td>
            <td className="impact-balance"><span>Outstanding AR</span>{formatBalance(account.outstanding_ar)}</td>
            <td className="impact-action"><strong>{action}</strong>{link && <span>{account.chow_current_account || account.duplicate_of_account ? link : `Link to ${link}`}</span>}</td>
          </tr>
        ))}</tbody>
      </table>
      {proposal.options.some((option) => option.operations.some((op) => op.type === 'duplicate')) &&
        <p>Balances and contacts stay with their original accounts. An account with revenue or unpaid AR is never retired as a duplicate.</p>}
    </section>
  );
}
