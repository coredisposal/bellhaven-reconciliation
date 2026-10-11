'use client';
import { useEffect, useRef, useState } from 'react';
import type { CrmRecord, CrmFields, Proposal, Decision, ApiResult } from '../lib/ui-types';
import type { DecisionAction } from '../lib/domain-types';
import { historicalAccount } from '../lib/review-selection.mjs';
import { formatBalance, reviewContext } from '../lib/case-context.mjs';
import { requestJson } from '../lib/client-request.mjs';
import { Search, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
type CrmResults = { data: CrmRecord[]; total: number; error?: string };
type AccountTask = 'edit' | 'chow' | 'duplicate';
const accountFields = [
  'name',
  'parent_id',
  'billing_street',
  'billing_city',
  'billing_state',
  'billing_zip',
  'care_type',
  'phone',
  'status',
  'note',
];
const contactFields = ['name', 'account_id', 'title', 'email', 'phone', 'is_active'];
const careCategories = ['', 'Skilled Nursing', 'Assisted Living', 'Memory Care', 'Independent Living'];
const labels: Record<string, string> = {
  parent_id: 'Parent account ID',
  account_id: 'Linked account ID',
  billing_street: 'Billing street',
  billing_city: 'Billing city',
  billing_state: 'Billing state',
  billing_zip: 'Billing ZIP',
  care_type: 'Care category',
  is_active: 'Active contact',
  name: 'Name',
  phone: 'Phone',
  status: 'Status',
  note: 'CRM note',
  title: 'Title',
  email: 'Email',
  chow_current_account: 'Current account (CHOW)',
  duplicate_of_account: 'Duplicate of account',
};

function RelationshipAccounts({ source, target, type }: {
  source: CrmRecord; target: CrmRecord; type: Exclude<AccountTask, 'edit'>;
}) {
  return <div className="crm-relationship-accounts" role="group" aria-label="Accounts in this relationship">
    {[
      { record: source, label: type === 'chow' ? 'Original · link only' : 'Duplicate · set Inactive' },
      { record: target, label: type === 'chow' ? 'Existing successor · unchanged' : 'Survivor · unchanged' },
    ].map(({ record, label }) => <section key={record.account_id}>
      <h4>{label}</h4>
      <strong>{record.name}</strong>
      <span className="crm-record-id">{record.account_id}</span>
      <p>Parent: {record.parent_name || record.parent_id || 'None'}<br />
        {[record.billing_street, record.billing_city, record.billing_state, record.billing_zip].filter(Boolean).join(', ') || 'Address not recorded'}</p>
      <dl>
        <div><dt>Lifetime revenue</dt><dd>{formatBalance(record.lifetime_revenue)}</dd></div>
        <div><dt>Outstanding AR</dt><dd>{formatBalance(record.outstanding_ar)}</dd></div>
        <div><dt>Status</dt><dd>{record.status || 'Not recorded'}</dd></div>
      </dl>
    </section>)}
  </div>;
}
export default function Crm({
  csrf,
  onDraft,
}: {
  csrf: string;
  onDraft: (draft: { id: string; status?: string }) => Promise<void> | void;
}) {
  const [entity, setEntity] = useState('accounts'),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [results, setResults] = useState<CrmResults>({ data: [], total: 0 }),
    [record, setRecord] = useState<CrmRecord | null>(null),
    [form, setForm] = useState<CrmFields>({}),
    [creating, setCreating] = useState(false),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [filters, setFilters] = useState<Record<string, string>>({}),
    [searched, setSearched] = useState(false),
    [submittedSearch, setSubmittedSearch] = useState({ query: '', filters: {} as Record<string, string> }),
    [task, setTask] = useState<AccountTask>('edit'),
    [targetQuery, setTargetQuery] = useState(''),
    [targetSearch, setTargetSearch] = useState(''),
    [targetPage, setTargetPage] = useState(1),
    [targetResults, setTargetResults] = useState<CrmResults | null>(null),
    [target, setTarget] = useState<CrmRecord | null>(null),
    [meta, setMeta] = useState<unknown>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const fields = entity === 'accounts' ? accountFields : contactFields;
  const history = historicalAccount(record, entity);
  const hasChanges = task === 'edit'
    ? fields.some((key) => Object.hasOwn(form, key) && (creating || form[key] !== record?.[key]))
    : !!target;
  function resetRelationship(next: AccountTask = 'edit') {
    setTask(next);
    setTarget(null);
    setTargetQuery('');
    setTargetSearch('');
    setTargetPage(1);
    setTargetResults(null);
  }
  function begin(message: string) {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = controller;
    setBusy(message);
    setError('');
    return controller;
  }
  function finish(controller: AbortController) {
    if (request.current === controller) {
      request.current = null;
      if (!controller.signal.aborted) setBusy('');
    }
  }
  async function search(next = 1, paginate = false) {
    const controller = begin('Reading CRM…');
    if (!controller) return;
    const criteria = paginate ? submittedSearch : { query, filters };
    try {
      const params = new URLSearchParams({
        entity,
        q: criteria.query,
        page: String(next),
        page_size: '20',
        ...Object.fromEntries(Object.entries(criteria.filters).filter(([, v]) => v !== '')),
      });
      const d = await requestJson('/api/desk/crm?' + params, {
        signal: controller.signal, errorMessage: 'CRM records could not be loaded. Try again.',
      }) as CrmResults;
      if (controller.signal.aborted) return;
      setResults(d);
      setPage(next);
      setSearched(true);
      setSubmittedSearch(criteria);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      finish(controller);
    }
  }
  function changeEntity(value: string) {
    setEntity(value);
    setRecord(null);
    setCreating(false);
    setForm({});
    setResults({ data: [], total: 0 });
    setPage(1);
    setFilters({});
    setQuery('');
    setSearched(false);
    setSubmittedSearch({ query: '', filters: {} });
    setReason('');
    setError('');
    setMeta(null);
    resetRelationship();
  }
  async function loadRecord(id: string) {
    const controller = begin('Reading record…');
    if (!controller) return;
    try {
      const d = await readRecord(entity, id, controller.signal);
      if (controller.signal.aborted) return;
      setRecord(d);
      setForm(d);
      setCreating(false);
      setReason('');
      resetRelationship();
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      finish(controller);
    }
  }
  function create() {
    setRecord(null);
    setForm(entity === 'accounts' ? { status: 'Active' } : { is_active: true });
    setCreating(true);
    setReason('');
    setError('');
    resetRelationship();
  }
  async function readRecord(recordEntity: string, id: string, signal: AbortSignal) {
    return await requestJson('/api/desk/crm?' + new URLSearchParams({ entity: recordEntity, id }), {
      signal, errorMessage: 'The CRM record could not be loaded. Try again.',
    }) as CrmRecord;
  }
  async function searchTargets(next = 1, paginate = false) {
    const controller = begin('Finding related accounts…');
    if (!controller) return;
    const q = paginate ? targetSearch : targetQuery.trim();
    try {
      const d = await requestJson('/api/desk/crm?' + new URLSearchParams({
        entity: 'accounts', q, page: String(next), page_size: '20',
      }), { signal: controller.signal, errorMessage: 'Related accounts could not be loaded. Try again.' }) as CrmResults;
      if (controller.signal.aborted) return;
      setTargetResults(d);
      setTargetPage(next);
      setTargetSearch(q);
      setTarget(null);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally { finish(controller); }
  }
  async function selectTarget(id: string) {
    const controller = begin('Reading related account…');
    if (!controller) return;
    setTarget(null);
    try {
      const d = await readRecord('accounts', id, controller.signal);
      if (!controller.signal.aborted) setTarget(d);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally { finish(controller); }
  }
  async function stage() {
    if (history || !hasChanges || !reason.trim() || !csrf) return;
    const controller = begin('Saving proposal…');
    if (!controller) return;
    try {
      const changes = task !== 'edit' ? {} : Object.fromEntries(
        fields
          .filter((k) => Object.hasOwn(form, k) && (creating || form[k] !== record?.[k]))
          .map((k) => [k, form[k]])
      );
      const d = await requestJson('/api/desk/draft', {
        method: 'POST',
        signal: controller.signal,
        timeoutMs: 60000,
        errorMessage: 'The proposal response was interrupted. Check the review queue before saving again.',
        timeoutMessage: 'Saving took longer than expected. Check the review queue before saving again.',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
          entity,
          recordId: record?.[entity === 'accounts' ? 'account_id' : 'contact_id'],
          fields: changes,
          note: reason,
          ...(task !== 'edit' && target ? { relationship: { type: task, target_id: target.account_id } } : {}),
        }),
      }) as ApiResult;
      if (controller.signal.aborted) return;
      await onDraft({ id: d.id, status: d.status });
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      finish(controller);
    }
  }
  async function connection() {
    const controller = begin('Checking connection…');
    if (!controller) return;
    try {
      const d = await requestJson('/api/desk/crm?entity=me', {
        signal: controller.signal, errorMessage: 'The API connection could not be verified. Try again.',
      });
      if (controller.signal.aborted) return;
      setMeta(d);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      finish(controller);
    }
  }
  return (
    <article className="document crm-browser">
      <div className="section-heading">
        <h2>CRM records</h2>
        <button className="secondary" disabled={!!busy} onClick={connection}>
          Check API connection
        </button>
      </div>
      <p className="ops-intro">
        Search the actual CRM. Save edits as a proposal, then approve the exact changes in the
        review queue.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="working">
          {busy}
        </p>
      )}
      <form
        className="crm-search"
        onSubmit={(e) => {
          e.preventDefault();
          search(1);
        }}
      >
        <label>
          Record type
          <select value={entity} onChange={(e) => changeEntity(e.target.value)} disabled={!!busy}>
            <option value="accounts">Accounts</option>
            <option value="contacts">Contacts</option>
          </select>
        </label>
        <label className="crm-query">
          Search
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or search term"
            maxLength={200}
          />
        </label>
        <button className="secondary" disabled={!!busy}>
          <Search size={16} />
          Search CRM
        </button>
        <button type="button" className="secondary" onClick={create} disabled={!!busy}>
          <Plus size={16} />
          New {entity === 'accounts' ? 'account' : 'contact'}
        </button>
      </form>
      <details className="crm-filters">
        <summary>More search filters</summary>
        <div className="crm-fields">
          {(entity === 'accounts'
            ? ['city', 'state', 'zip', 'street', 'parent_id']
            : ['account_id']
          ).map((k) => (
            <label key={k}>
              {labels[k] ?? k}
              <input
                value={filters[k] ?? ''}
                onChange={(e) => setFilters({ ...filters, [k]: e.target.value })}
                maxLength={200}
              />
            </label>
          ))}
        </div>
      </details>
      <div className="crm-columns">
        <section>
          <div className="section-heading">
            <h3>{searched ? `${results.total} records found` : 'Search CRM records'}</h3>
            {searched && results.total > 0 && <span>Page {page} of {Math.ceil(results.total / 20)}</span>}
          </div>
          <div className="crm-record-list">
            {results.data.map((item) => (
              <button
                className={
                  'case-row ' +
                  (record?.[entity === 'accounts' ? 'account_id' : 'contact_id'] ===
                  item[entity === 'accounts' ? 'account_id' : 'contact_id']
                    ? 'selected'
                    : '')
                }
                key={item[entity === 'accounts' ? 'account_id' : 'contact_id']}
                onClick={() =>
                  loadRecord(item[entity === 'accounts' ? 'account_id' : 'contact_id'] ?? '')
                }
                disabled={!!busy}
              >
                <span className="case-title">{item.name}</span>
                <span className="case-locality">
                  {entity === 'accounts'
                    ? `${item.billing_city || '—'}, ${item.billing_state || '—'}`
                    : item.title || 'No title'}
                </span>
                <span className="crm-record-id">
                  {item[entity === 'accounts' ? 'account_id' : 'contact_id']}
                </span>
              </button>
            ))}
          </div>
          <div className="crm-pagination">
            <button
              className="secondary"
              disabled={!!busy || page <= 1}
              onClick={() => search(page - 1, true)}
            >
              <ChevronLeft size={15} />
              Previous
            </button>
            <button
              className="secondary"
              disabled={!!busy || page * 20 >= results.total}
              onClick={() => search(page + 1, true)}
            >
              Next
              <ChevronRight size={15} />
            </button>
          </div>
          {results.total === 0 && (
            <p className="evidence-foot">
              {searched ? 'No records match this search. Try another name or clear the search filters.' :
                'Search to read current records, or prepare a new record proposal.'}
            </p>
          )}
        </section>
        <section>
          {record || creating ? (
            <>
              <h3>
                {creating
                  ? 'Propose a new record'
                  : `${history ? 'Historical record' : 'Edit proposal'}: ${record?.name}`}
              </h3>
              <p className="evidence-foot">
                Save a proposal, then review and approve it. Billing balances remain protected.
              </p>
              {record && entity === 'accounts' && !history && (
                <label className="crm-task">
                  Proposed action
                  <select value={task} disabled={!!busy} onChange={(e) => {
                    resetRelationship(e.target.value as AccountTask);
                    setForm(record);
                    setReason('');
                    setError('');
                  }}>
                    <option value="edit">Edit account</option>
                    <option value="chow">Link existing successor (CHOW)</option>
                    <option value="duplicate">Mark as duplicate of another account</option>
                  </select>
                </label>
              )}
              {record && entity === 'accounts' && (
                <p className="crm-billing">
                  Revenue:{' '}
                  {formatBalance(record.lifetime_revenue)}{' '}
                  · AR:{' '}
                  {formatBalance(record.outstanding_ar)}
                  {history ? (
                    <>
                      . {history.description}{' '}
                      {record.chow_current_account && (
                        <>
                          CHOW current account:{' '}
                          <strong>{String(record.chow_current_account)}</strong>.{' '}
                        </>
                      )}
                      {record.duplicate_of_account && (
                        <>
                          Duplicate of: <strong>{String(record.duplicate_of_account)}</strong>.{' '}
                        </>
                      )}
                      {history.target && (
                        <button
                          className="secondary"
                          disabled={!!busy}
                          onClick={() => loadRecord(history.target!)}
                        >
                          View current account
                        </button>
                      )}
                    </>
                  ) : task === 'edit' ? (
                    '. A parent change with both positive requires a new account and CHOW link.'
                  ) : '.'}
                </p>
              )}
              {task !== 'edit' && record && !history ? (
                <div className="crm-relationship">
                  <p className="evidence-foot" id="relationship-help">
                    {task === 'chow'
                      ? 'Use an existing successor after confirming an ownership transfer. Only the original’s CHOW link changes; both accounts keep their parents, fields, and billing history.'
                      : 'Choose the active survivor for a confirmed duplicate under the same parent. This account becomes Inactive and links to the survivor. Both accounts keep their billing history and contacts.'}
                  </p>
                  <form className="crm-search" onSubmit={(e) => { e.preventDefault(); searchTargets(); }}>
                    <label className="crm-query">
                      {task === 'chow' ? 'Find existing successor' : 'Find survivor account'}
                      <input value={targetQuery} onChange={(e) => {
                        setTargetQuery(e.target.value);
                        setTarget(null);
                        setTargetResults(null);
                      }} placeholder="Search by account name" maxLength={200} disabled={!!busy} aria-describedby="relationship-help" />
                    </label>
                    <button className="secondary" disabled={!!busy || !targetQuery.trim()}><Search size={16} />Find account</button>
                  </form>
                  {targetResults && <>
                    <div className="crm-target-results" role="group" aria-label="Related account search results">
                      {targetResults.data.filter((candidate) => candidate.account_id !== record.account_id).map((candidate) => {
                        const candidateHistory = historicalAccount(candidate);
                        return <button key={candidate.account_id} className={'case-row ' + (target?.account_id === candidate.account_id ? 'selected' : '')}
                          type="button" disabled={!!busy || !!candidateHistory}
                          aria-pressed={target?.account_id === candidate.account_id}
                          onClick={() => selectTarget(candidate.account_id ?? '')}>
                          <span className="case-title">{candidate.name}</span>
                          <span className="case-locality">{[candidate.billing_street, candidate.billing_city, candidate.billing_state].filter(Boolean).join(', ') || 'Address not recorded'}</span>
                          <span className="crm-record-id">{candidate.account_id} · {candidate.status || 'Status not recorded'}{candidateHistory ? ' · Historical account' : ''}</span>
                        </button>;
                      })}
                    </div>
                    {targetResults.data.every((candidate) => candidate.account_id === record.account_id) &&
                      <p className="evidence-foot" role="status">No other accounts on this page. Try another name{targetResults.total > 20 ? ' or the next page' : ''}.</p>}
                    {targetResults.total > 20 && <div className="crm-pagination">
                      <button type="button" className="secondary" disabled={!!busy || targetPage <= 1} onClick={() => searchTargets(targetPage - 1, true)}>Previous accounts</button>
                      <span className="evidence-foot">Page {targetPage} of {Math.ceil(targetResults.total / 20)}</span>
                      <button type="button" className="secondary" disabled={!!busy || targetPage * 20 >= targetResults.total} onClick={() => searchTargets(targetPage + 1, true)}>Next accounts</button>
                    </div>}
                  </>}
                  {target && <RelationshipAccounts source={record} target={target} type={task} />}
                  <p className="evidence-foot">
                    {task === 'chow'
                      ? 'Requires matching street and locality, different parents, and positive revenue and AR on the original. A shared address alone does not prove a transfer.'
                      : 'Requires matching street and locality, the same parent, and zero revenue and AR on the account being retired.'}
                  </p>
                </div>
              ) : <div className="crm-fields">
                {fields.map((k) => (
                  <label key={k}>
                    {labels[k]}
                    {k === 'is_active' ? (
                      <select
                        disabled={!!busy || !!history}
                        value={String(form[k] ?? true)}
                        onChange={(e) => setForm({ ...form, [k]: e.target.value === 'true' })}
                      >
                        <option value="true">Active</option>
                        <option value="false">Inactive</option>
                      </select>
                    ) : k === 'status' ? (
                      <select
                        disabled={!!busy || !!history}
                        value={String(form[k] ?? 'Active')}
                        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                      >
                        {['Active', 'Inactive', 'Needs Review'].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    ) : k === 'care_type' ? (
                      <select
                        disabled={!!busy || !!history}
                        value={String(form[k] ?? '')}
                        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                      >
                        {form[k] && !careCategories.includes(String(form[k])) && (
                          <option value={String(form[k])}>{String(form[k])} (current)</option>
                        )}
                        {careCategories.map((value) => (
                          <option key={value} value={value}>{value || 'Not set'}</option>
                        ))}
                      </select>
                    ) : k === 'note' ? (
                      <textarea
                        disabled={!!busy || !!history}
                        rows={3}
                        value={String(form[k] ?? '')}
                        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                        maxLength={2000}
                      />
                    ) : (
                      <input
                        disabled={!!busy || !!history}
                        value={String(form[k] ?? '')}
                        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                        maxLength={300}
                      />
                    )}
                  </label>
                ))}
              </div>}
              <label className="crm-reason">
                Evidence and reason for this proposal
                <textarea
                  disabled={!!busy || !!history}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={2000}
                  placeholder={task === 'chow' ? 'Cite the transfer evidence, effective date if known, and why this account is the successor.'
                    : task === 'duplicate' ? 'Cite the evidence that these records represent the same account and explain the survivor choice.'
                    : 'Explain the correction and cite the source you checked.'}
                />
              </label>
              <button
                className="primary"
                disabled={!!busy || !!history || !hasChanges || !reason.trim() || !csrf}
                onClick={stage}
              >
                Save proposal for review
              </button>
            </>
          ) : (
            <div className="crm-placeholder">
              <h3>Select a record to inspect it</h3>
              <p>
                Searches and record views are read-only. Every create or update goes through the
                review queue.
              </p>
            </div>
          )}
        </section>
      </div>
      {meta !== null && (
        <details open className="ops-definitions">
          <summary>Authenticated API connection</summary>
          <pre>{JSON.stringify(meta, null, 2)}</pre>
        </details>
      )}
    </article>
  );
}

export function ManualCase({
  proposal,
  decisions,
  note,
  setNote,
  busy,
  mutationBusy,
  onDecision,
}: {
  proposal: Proposal;
  decisions: Decision[];
  note: string;
  setNote: (s: string) => void;
  busy: string;
  mutationBusy: boolean;
  onDecision: (s: DecisionAction) => void;
}) {
  const option = proposal.options[0],
    op = option?.operations[0];
  const before: CrmFields = proposal.before ?? op?.before ?? {},
    fields = op?.fields ?? proposal.fields ?? {};
  const context = reviewContext(proposal, option?.id);
  const savedPlan = ['applied', 'partial', 'applying'].includes(proposal.status);
  const historical = proposal.status !== 'pending';
  const linkedId = proposal.entity === 'contacts' ? fields.account_id ?? before.account_id : fields.parent_id ?? before.parent_id;
  const linkedRecord = proposal.dependencies?.find((record) => record.account_id === linkedId);
  const relationship = proposal.relationship;
  const relationshipTarget = relationship && proposal.dependencies?.find((record) => record.account_id === relationship.target_id);
  const sourceParent = proposal.dependencies?.find((record) => record.account_id === before.parent_id);
  const targetParent = proposal.dependencies?.find((record) => record.account_id === relationshipTarget?.parent_id);
  return (
    <section id="selected-case" tabIndex={-1} className="case-detail">
      <div className="case-status">
        <span className="badge">
          {proposal.entity === 'contacts' ? 'Contact' : 'Account'} proposal
        </span>
        <span>{proposal.status}</span>
      </div>
      <h2>{proposal.title}</h2>
      <p className="case-summary">{proposal.summary ?? proposal.note}</p>
      <p className="evidence-foot"><strong>{proposal.entity === 'contacts' ? 'Contact' : 'Account'}:</strong>{' '}
        {String(before.name || fields.name || proposal.title)} · {String((proposal.entity === 'contacts' ? before.contact_id : before.account_id) || 'New ID assigned on creation')}
        {linkedId && <><br />{proposal.entity === 'contacts' ? 'Linked account' : relationship ? 'Existing parent' : 'Proposed parent'}: {linkedRecord?.name ? `${linkedRecord.name} · ` : ''}{String(linkedId)}</>}
      </p>
      {context.statusNotice && <p className="review-status-note">{context.statusNotice}</p>}
      <p className="manual-reason">
        <strong>Reason supplied:</strong> {proposal.reviewer_note}
      </p>
      <p className="evidence-foot">
        {historical ? 'Prepared from an explicit edit; shown with its saved evidence.' : 'Prepared from an explicit edit. Verify the supplied evidence before approving.'}
      </p>
      {op?.type === 'chow' && (
        <div className="ops-health attention">
          <strong>
            CHOW required. Create a replacement under the selected parent; preserve every old
            business field and set only its CHOW link.
          </strong>
        </div>
      )}
      {relationship && relationshipTarget && proposal.before && <>
        <RelationshipAccounts type={relationship.type}
          source={{ ...proposal.before, parent_name: sourceParent?.name ?? proposal.before.parent_name }}
          target={{ ...relationshipTarget, parent_name: targetParent?.name ?? relationshipTarget.parent_name }} />
        <p className="crm-billing">{relationship.type === 'chow'
          ? 'Link the original to this existing successor. No new account is created. Both parents, billing balances, other business fields, and contacts remain unchanged.'
          : 'Set only the duplicate’s status to Inactive and link it to this survivor. The survivor, both billing histories, and contacts remain unchanged.'}</p>
      </>}
      {!relationship && proposal.entity === 'accounts' && proposal.before && (
        <p className="crm-billing">
          Existing lifetime revenue:{' '}
          {formatBalance(before.lifetime_revenue)}{' '}
          · Outstanding AR:{' '}
          {formatBalance(before.outstanding_ar)}
        </p>
      )}
      <h3 className="manual-comparison-title">{savedPlan ? 'Exact approved changes' : 'Exact proposed changes'}</h3>
      <div className="comparison" role="table" aria-label="Manual proposal changes">
        <div className="comparison-head" role="row">
          <span role="columnheader">Field</span>
          <span role="columnheader">{savedPlan ? 'CRM before approval' : historical ? 'CRM at review time' : 'Current CRM'}</span>
          <span role="columnheader">
            {savedPlan ? op?.type === 'chow' ? 'Approved replacement' : 'Approved values' : historical ? 'Saved proposed values' : op?.type === 'chow' ? 'New replacement' : 'After approval'}
          </span>
        </div>
        {Object.entries(fields).map(([key, value]) => (
          <div className="comparison-row changed" key={key} role="row">
            <span role="rowheader">{labels[key] ?? key}</span>
            <span role="cell">{String(before[key] ?? '—')}</span>
            <span role="cell">{relationshipTarget && ['chow_current_account', 'duplicate_of_account'].includes(key)
              ? `${relationshipTarget.name} · ${String(value)}` : String(value)}</span>
          </div>
        ))}
      </div>
      <div className="decision-panel">
        <h3>{['applied', 'rejected'].includes(proposal.status) ? 'Decision saved' : ['partial', 'applying'].includes(proposal.status) ? 'Finish approved work' : 'Your decision'}</h3>
        {decisions
          .filter((d) => d.proposal_id === proposal.id)
          .map((d) => (
            <p className="saved-decision" key={d.id}>
              {d.action}: {d.note}
            </p>
          ))}
        {proposal.status !== 'applied' && (
          <>
            <label htmlFor="manual-note">Reviewer note</label>
            <textarea
              id="manual-note"
              disabled={mutationBusy}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
            />
            <div className="decision-actions">
              {proposal.status === 'pending' ? (
                <>
                  <button
                    className="secondary"
                    disabled={!!busy || !note.trim()}
                    onClick={() => onDecision('reject')}
                  >
                    Reject proposal
                  </button>
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() => onDecision('approve')}
                  >
                    Approve and apply
                  </button>
                </>
              ) : ['partial', 'applying'].includes(proposal.status) ? (
                <button className="primary" disabled={!!busy} onClick={() => onDecision('resume')}>
                  Resume approved operation
                </button>
              ) : ['stale', 'rejected'].includes(proposal.status) ? (
                <button
                  className="secondary"
                  disabled={!!busy || !note.trim()}
                  onClick={() => onDecision('reopen')}
                >
                  Reopen for review
                </button>
              ) : null}
            </div>
            <p className="decision-foot">
              {['partial', 'applying'].includes(proposal.status)
                ? 'Resume checks completed steps and continues the saved approval.'
                : proposal.status === 'stale' ? 'Read the current CRM record and prepare a new draft with fresh evidence.'
                : proposal.status === 'rejected' ? 'Reopening requires a reason and retains this saved rejection.'
                : 'Approval writes only this stored proposal version to the actual exercise CRM.'}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
