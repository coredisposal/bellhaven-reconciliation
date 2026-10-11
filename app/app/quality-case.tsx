import { ArrowUpRight, Check } from 'lucide-react';
import type { DecisionAction } from '../lib/domain-types';
import type { Decision, Proposal } from '../lib/ui-types';
import { formatBalance } from '../lib/case-context.mjs';

const fieldLabels: Record<string, string> = {
  name: 'Name', parent_id: 'Parent account', status: 'Status', phone: 'Phone',
  care_type: 'Care category', billing_street: 'Street', billing_city: 'City',
  billing_state: 'State', billing_zip: 'ZIP', duplicate_of_account: 'Duplicate of',
  chow_current_account: 'Current CHOW account', note: 'CRM note',
};
const value = (field: unknown) => field === undefined || field === null || field === '' ? '—' : String(field);
const date = (time: string) => new Date(time).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/** CRM-wide findings share the existing immutable proposal and decision workflow. */
export default function QualityCase({
  proposal, decisions, optionId, setOption, note, setNote, busy, mutationBusy, onDecision,
}: {
  proposal: Proposal;
  decisions: Decision[];
  optionId: string;
  setOption: (id: string) => void;
  note: string;
  setNote: (note: string) => void;
  busy: string;
  mutationBusy: boolean;
  onDecision: (action: DecisionAction) => void;
}) {
  const quality = proposal.quality;
  const option = proposal.options.find((item) => item.id === optionId);
  const historical = proposal.status !== 'pending';
  const savedPlan = ['applied', 'applying', 'partial'].includes(proposal.status);
  const noWrites = !!option && option.operations.length === 0 && !!option.field_choices;
  const linksSuccessor = !!option?.operations.some((operation) => Object.hasOwn(operation.fields, 'chow_current_account'));
  const reopening = ['stale', 'rejected'].includes(proposal.status) || (proposal.status === 'applied' && noWrites);
  const noteRequired = proposal.status === 'pending' || reopening;
  const accounts = [...new Map([...proposal.candidates, ...proposal.alternatives]
    .map((candidate) => [candidate.account.account_id, candidate.account])).values()];
  const contacts = quality?.contacts ?? [];
  const accountName = (id: unknown) => {
    const account = accounts.find((item) => item.account_id === id);
    return account ? `${account.name} · ${account.account_id}` : value(id);
  };
  const displayField = (key: string, field: unknown) =>
    ['parent_id', 'duplicate_of_account', 'chow_current_account'].includes(key) && field
      ? accountName(field) : value(field);
  return (
    <section id="selected-case" tabIndex={-1} className="case-detail quality-case" aria-label={`Evidence for ${proposal.title}`}>
      <div className="case-header">
        <div className="case-status">
          <span className="badge crm_quality">CRM quality</span>
          <span>{proposal.status === 'pending' ? 'Awaiting decision' : proposal.status === 'applied' && noWrites ? 'Review saved' : proposal.status}</span>
        </div>
        <h2>{proposal.title}</h2>
        {proposal.facility && <p><a href={proposal.facility.source_url} target="_blank" rel="noreferrer">Website evidence <ArrowUpRight size={13} /></a></p>}
      </div>
      <div className="review-context">
        <p className="case-summary">{quality?.detail || proposal.summary}</p>
        {quality?.guidance && <p>{quality.guidance}</p>}
        {historical && <p className="review-status-note">{savedPlan
          ? 'Evidence and choices below belong to the saved approval.'
          : 'Showing the saved evidence. Reopen with a reason to request a fresh review.'}</p>}
        {savedPlan && !option && <p className="error" role="alert">The saved approval choice could not be loaded. Reload the page before continuing.</p>}
      </div>

      {!!accounts.length && <section className="account-impact" aria-label="Accounts in this review">
        <h3>Accounts in this review <span>{accounts.length}</span></h3>
        <table aria-label="Account identities and billing evidence">
          <thead><tr><th scope="col">CRM account</th><th scope="col">Lifetime revenue</th><th scope="col">Outstanding AR</th><th scope="col">{historical ? 'Saved account details' : 'Account details'}</th></tr></thead>
          <tbody>{accounts.map((account) => <tr key={account.account_id}>
            <th scope="row">
              <strong>{account.name}</strong>
              <span>{account.account_id} · {value(account.status)}</span>
              <span>{account.parent_name || account.parent_id || 'No parent'}</span>
              <span>{[account.billing_street, account.billing_city, account.billing_state, account.billing_zip].filter(Boolean).join(', ') || 'No address recorded'}</span>
            </th>
            <td className="impact-balance"><span>Lifetime revenue</span>{formatBalance(account.lifetime_revenue)}</td>
            <td className="impact-balance"><span>Outstanding AR</span>{formatBalance(account.outstanding_ar)}</td>
            <td className="impact-action">
              <span>Phone: {value(account.phone)}</span>
              <span>Care: {value(account.care_type)}</span>
              {account.chow_current_account && <span>CHOW link: {accountName(account.chow_current_account)}</span>}
              {account.duplicate_of_account && <span>Duplicate of: {accountName(account.duplicate_of_account)}</span>}
            </td>
          </tr>)}</tbody>
        </table>
      </section>}

      {!!contacts.length && <section className="quality-contacts" aria-label="Contacts in this review">
        <h3>Contacts in this review <span>{contacts.length}</span></h3>
        <ul>{contacts.map((contact) => <li key={contact.contact_id}>
          <strong>{contact.name}</strong><span>{contact.contact_id} · {contact.is_active === false ? 'Inactive' : contact.is_active === true ? 'Active' : 'Activity not recorded'}</span>
          <span>{[contact.title, contact.email, contact.phone].filter(Boolean).join(' · ') || 'No contact details recorded'}</span>
          <span>Account: {accountName(contact.account_id)}</span>
        </li>)}</ul>
        <p className="evidence-foot">Contacts stay on their current accounts. A contact correction requires its own reviewed proposal in CRM records.</p>
      </section>}

      {proposal.facility && <div className="review-context quality-source">
        <h3>Website evidence</h3>
        <dl>
          <div><dt>Phone</dt><dd>{value(proposal.facility.phone_raw)}</dd></div>
          <div><dt>Care offerings</dt><dd>{proposal.facility.care_offerings.join('; ')}</dd></div>
        </dl>
        <p className="evidence-foot">The CRM stores one care category. The complete website list stays in the evidence.{proposal.facility.retrieved_at_utc ? ` Retrieved ${date(proposal.facility.retrieved_at_utc)}.` : ''}</p>
      </div>}

      <fieldset className="choice" disabled={historical || !!busy}>
        <legend>{historical ? 'Saved choices' : 'Choose a resolution'}</legend>
        <p>{proposal.status === 'rejected' ? 'These were the available choices. None was applied.' : historical ? 'The saved choices remain available for inspection.' : 'Choose what this review should do. The exact changes appear below.'}</p>
        {proposal.options.map((item) => <label className="resolution-option" key={item.id}>
          <input type="radio" name={`quality-resolution-${proposal.id}`} value={item.id} checked={optionId === item.id} onChange={() => setOption(item.id)} />
          <span><strong>{item.label}</strong>{item.reason && <span>{item.reason}</span>}</span>
        </label>)}
      </fieldset>

      <section className="quality-preview" aria-label="Selected resolution changes" aria-live="polite">
        <h3>{savedPlan ? noWrites ? 'Saved review' : 'Approved changes' : historical ? 'Saved proposed changes' : 'Changes in this choice'}</h3>
        {linksSuccessor && <p className="evidence-foot">Links to the existing successor. Both parents, billing balances, other business fields, and contacts stay unchanged. No new account is created.</p>}
        {!option ? <p>{proposal.status === 'rejected' ? 'This proposal was rejected. No CRM changes were approved.' : 'Select a resolution to preview it.'}</p>
          : noWrites ? <p>{proposal.status === 'applied' ? 'Review recorded. No CRM fields changed.' : 'Records this review without changing any CRM fields.'} The same finding stays closed on reruns unless its evidence changes. This does not confirm an unresolved fact has been corrected.</p>
          : option.operations.map((operation, index) => <div key={`${operation.account_id || 'new'}-${index}`} className="quality-operation">
            <p><strong>{accountName(operation.account_id)}</strong></p>
            <div className="comparison" role="table" aria-label={`Changes for ${accountName(operation.account_id)}`}>
              <div className="comparison-head" role="row"><span role="columnheader">Field</span><span role="columnheader">{historical ? 'Saved before value' : 'Current CRM'}</span><span role="columnheader">{savedPlan ? 'Approved value' : 'After approval'}</span></div>
              {Object.entries(operation.fields).filter(([key]) => key !== 'note').map(([key, field]) => <div className="comparison-row changed" role="row" key={key}>
                <span role="rowheader">{fieldLabels[key] || key}</span><span role="cell">{displayField(key, operation.before?.[key])}</span><span role="cell">{displayField(key, field)}</span>
              </div>)}
            </div>
            {Object.hasOwn(operation.fields, 'note') && <details className="quality-note"><summary>{savedPlan ? 'Approved CRM note' : 'CRM note included in this choice'}</summary><p>{value(operation.fields.note)}</p></details>}
          </div>)}
      </section>

      <div className="decision-panel">
        <div className="decision-context"><h3>{['applied', 'rejected'].includes(proposal.status) ? 'Decision saved' : ['partial', 'applying'].includes(proposal.status) ? 'Finish approved work' : 'Your decision'}</h3></div>
        {decisions.filter((item) => item.proposal_id === proposal.id).map((item) => <p key={item.id} className="saved-decision"><strong>{item.action}</strong> · {date(item.created)} · {item.actor}<br />{item.note || 'No additional reviewer note.'}</p>)}
        {(proposal.status !== 'applied' || reopening) && <>
          <label htmlFor="quality-reviewer-note">Reviewer note{noteRequired ? ' (required)' : ''}</label>
          <textarea id="quality-reviewer-note" rows={3} maxLength={2000} value={note} required={noteRequired} aria-describedby="quality-decision-help" disabled={mutationBusy} onChange={(event) => setNote(event.target.value)} placeholder={reopening ? 'Explain what still needs verification.' : ['partial', 'applying'].includes(proposal.status) ? 'Optional note for resuming the saved approval.' : linksSuccessor ? 'Cite evidence confirming the ownership transfer and successor. A shared address alone is not enough.' : 'Explain the evidence behind your decision.'} />
          <div className="decision-actions">
            {proposal.status === 'pending' ? <>
              <button className="secondary" disabled={!!busy || !note.trim()} onClick={() => onDecision('reject')}>Reject proposal</button>
              <button className="primary" disabled={!!busy || !note.trim() || !option || (!option.operations.length && !option.field_choices)} onClick={() => onDecision('approve')}><Check size={16} />{noWrites ? 'Save review' : 'Approve and apply'}</button>
            </> : ['partial', 'applying'].includes(proposal.status) ? <button className="primary" disabled={!!busy || !option} onClick={() => onDecision('resume')}>Resume approved operation</button>
              : reopening ? <button className="secondary" disabled={!!busy || !note.trim()} onClick={() => onDecision('reopen')}>Reopen for review</button> : null}
          </div>
          <p className="decision-foot" id="quality-decision-help">{['partial', 'applying'].includes(proposal.status) ? 'Resume checks completed steps and continues the saved approval.'
            : reopening ? 'Returns this finding to the queue and keeps the earlier decision in history. No CRM fields change.'
            : !option ? 'Select a resolution and add a note to save this review, or reject it with a reason.'
            : !note.trim() ? 'Add a note explaining your decision before saving or applying this review.'
            : noWrites ? 'Saves this review to the decision ledger. No CRM API writes are included.'
            : 'Approval applies only this stored choice after a fresh evidence check.'}</p>
        </>}
      </div>
      <details className="supporting-details"><summary>Supporting evidence</summary>
        <p className="evidence-foot">Proposal version {proposal.version.slice(0, 10)}. Account and contact values are preserved as observed in the saved snapshot.</p>
        {option && <details className="operations"><summary>Exact API changes</summary>{option.operations.length ? <pre>{JSON.stringify(option.operations.map(({ type, account_id, fields }) => ({ type, account_id, fields })), null, 2)}</pre> : <p>No CRM API writes are included in this choice.</p>}</details>}
      </details>
    </section>
  );
}
