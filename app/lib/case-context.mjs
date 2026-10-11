import { reviewAccount } from './review-selection.mjs';
import { streetKey } from './core.mjs';

const wholeMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const centsMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numeric = (value) => typeof value === 'number' ? value
  : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;

/** Missing billing evidence is never presented as a zero balance. */
export function formatBalance(value) {
  const amount = numeric(value);
  return Number.isFinite(amount) ? (Number.isInteger(amount) ? wholeMoney : centsMoney).format(amount) : 'Not verified';
}

const joined = (values) => values.length < 3 ? values.join(' and ')
  : `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
const sentence = (value) => value ? `${value[0].toUpperCase()}${value.slice(1).replace(/[.!?]+$/, '')}.` : '';
const accountName = (account) => account?.name || account?.account_id || 'the selected account';
const recordCandidates = (proposal) => [...(proposal.candidates ?? []), ...(proposal.alternatives ?? [])];
const candidateFor = (proposal, account) => recordCandidates(proposal)
  .find((candidate) => candidate.account.account_id === account?.account_id);
const parentName = (proposal, id) => {
  if (!id) return 'no parent';
  if (proposal.parent?.account_id === id) return proposal.parent.name;
  const dependency = (proposal.dependencies ?? []).find((account) => account.account_id === id);
  if (dependency?.name) return dependency.name;
  const account = recordCandidates(proposal).map((candidate) => candidate.account)
    .find((account) => account.parent_id === id && account.parent_name);
  return account?.parent_name || `parent ${id}`;
};

function fieldNames(fields, before) {
  const labels = [], keys = Object.keys(fields ?? {});
  const previousNote = String(before?.note ?? ''), nextNote = String(fields?.note ?? '');
  const addedNote = nextNote.startsWith(previousNote) ? nextNote.slice(previousNote.length) : nextNote;
  const addressKeys = keys.filter((field) => field.startsWith('billing_'));
  for (const key of keys) {
    if (['parent_id', 'duplicate_of_account', 'chow_current_account', 'name', 'status', 'note'].includes(key)) continue;
    const label = key.startsWith('billing_') ? addressKeys.length > 1 ? 'billing address'
      : key === 'billing_zip' ? 'ZIP'
        : key === 'billing_street' ? before?.billing_street && streetKey(before.billing_street) === streetKey(fields.billing_street)
          ? 'street formatting' : 'street address'
          : ({ billing_city: 'city', billing_state: 'state' })[key] ?? 'billing address'
      : ({ phone: 'phone', care_type: 'care category',
        lifetime_revenue: 'lifetime revenue', outstanding_ar: 'outstanding AR' })[key]
        ?? key.replaceAll('_', ' ');
    if (!labels.includes(label)) labels.push(label);
  }
  const offeringsNote = /Care offerings:/.test(addedNote);
  if (Object.hasOwn(fields, 'note') && !offeringsNote) labels.push('CRM note');
  return { labels: joined(labels), offeringsNote };
}

function patchSummary(proposal, operation, account) {
  const fields = operation.fields ?? {}, before = operation.before ?? account;
  const target = accountName(account ?? before), parts = [];
  const { labels, offeringsNote } = fieldNames(fields, before);
  if (Object.hasOwn(fields, 'parent_id')) {
    const from = before?.parent_id, to = fields.parent_id;
    parts.push(to ? from
      ? `Move ${target} from ${parentName(proposal, from)} to ${parentName(proposal, to)}.`
      : `Assign ${target} to ${parentName(proposal, to)}; it currently has no parent.`
      : `Remove the parent assignment from ${target}.`);
  }
  if (Object.hasOwn(fields, 'name'))
    parts.push(`Change ${parts.length ? 'the account name' : `the name on ${target}`} to “${fields.name}”.`);
  if (Object.hasOwn(fields, 'status'))
    parts.push(`Set ${parts.length ? 'its' : `${target}’s`} status to ${fields.status}.`);
  if (labels) parts.push(`Update ${parts.length ? 'its' : `${target}’s`} ${labels}.`);
  if (Object.hasOwn(fields, 'note') && offeringsNote)
    parts.push(`Save the website offerings in ${parts.length ? 'its' : `${target}’s`} CRM note.`);
  return parts.join(' ');
}

function reasonFor(proposal) {
  if (proposal.manual) return 'A reviewer prepared these specific CRM changes.';
  switch (proposal.kind) {
    case 'parent_correction': return 'The matched facility is not linked to the website operator in the CRM.';
    case 'field_correction': return 'The location matches, but some CRM values differ from the website.';
    case 'chow': return 'The parent differs, and both revenue history and unpaid AR require preserving the original account.';
    case 'duplicate': return 'Several active CRM accounts describe this location.';
    case 'new_account': return 'No existing account has enough matching evidence for this website location.';
    case 'absent': return 'This Bellhaven account was not found in the complete website crawl.';
    case 'unchanged': return 'No required correction was found for this matched location.';
    case 'ambiguous': {
      if (proposal.link_conflicts?.length) return 'A historical account link is broken, conflicting, or points to a different location.';
      if (!proposal.options?.length && recordCandidates(proposal).some(({ account }) =>
        !Number.isFinite(numeric(account.lifetime_revenue)) || !Number.isFinite(numeric(account.outstanding_ar))))
        return 'Billing evidence is incomplete, so an account resolution cannot be approved yet.';
      const kinds = new Set((proposal.matching_conflicts ?? []).map((conflict) => conflict.kind));
      if (kinds.has('shared_account')) return 'One CRM account matches more than one website location; their identities need review.';
      if (kinds.has('inactive_account')) return 'An inactive CRM account may represent this facility; its identity and history need review.';
      if (kinds.has('name_collision')) return 'The same name exists in the CRM, but the address conflicts or is missing.';
      if (kinds.has('address_conflict')) return 'Some identity evidence overlaps, but the physical address conflicts or is missing.';
      const billing = (proposal.candidates ?? []).filter(({ account }) =>
        [numeric(account.lifetime_revenue), numeric(account.outstanding_ar)]
          .some((value) => Number.isFinite(value) && value !== 0));
      if (billing.length > 1)
        return 'Several matching accounts carry billing history; choosing one does not justify retiring the others.';
      return proposal.candidates?.length > 1
        ? 'Several accounts match the location without enough evidence to choose a unique survivor.'
        : 'The stored evidence does not establish a safe account resolution.';
    }
    default: return proposal.summary || 'Review the stored evidence and the proposed changes.';
  }
}

function evidenceFor(proposal, account, option) {
  if (proposal.manual) return 'The saved draft and before-values are the evidence for this request.';
  if (proposal.kind === 'absent')
    return `The account is linked to ${parentName(proposal, account?.parent_id ?? proposal.parent?.account_id)}. Website absence does not establish a sale or closure.`;
  if (proposal.status === 'rejected') return 'The saved website and CRM comparison remains available; no account resolution was approved.';
  if (!option && ['applied', 'partial', 'applying'].includes(proposal.status))
    return 'The original comparison is retained below; the approved account cannot be identified without its saved option.';
  const candidate = candidateFor(proposal, account);
  if (candidate) {
    const labels = (candidate.reasons ?? []).map((reason) => ({
      'Same normalized street and locality': 'The street, city, and state match after accounting for spelling and abbreviations',
      'Same facility phone': 'the phone matches',
      'Website administrator matches an active contact': 'the website administrator matches an active contact',
      'Same normalized name': 'the name matches',
      'CRM contains a billing PO box': 'the CRM uses a billing PO box',
    })[reason] ?? reason);
    return labels.length ? sentence(labels.join('; ')) : 'No additional matching signals are recorded for this account.';
  }
  if (proposal.kind === 'ambiguous') {
    if (option?.resolution === 'separate')
      return 'Creating separately treats the website facility as distinct; the conflicting CRM records do not establish that on their own.';
    if ((proposal.candidates ?? []).length > 1)
      return `${proposal.candidates.length} location candidates have recorded address, billing, and contact evidence below.`;
    if (proposal.candidates?.length === 1) return proposal.options?.length
      ? 'One location candidate is recorded, but conflicting evidence still requires an explicit resolution.'
      : 'One location candidate is recorded. Approval is blocked by the unresolved evidence described above.';
    return 'No account is confirmed as the website facility. Compare the conflicting record before choosing a resolution.';
  }
  if (proposal.kind === 'new_account') return proposal.alternatives?.length
    ? 'Related CRM records are shown below, but their address or identity evidence does not establish a match.'
    : 'The collected website location has no supported candidate in the saved CRM snapshot.';
  return 'Choose a resolution to see the evidence for its exact account.';
}

function attentionFor(proposal, account, option) {
  if (proposal.link_conflicts?.length) return 'Repair the existing history link before resolving this case.';
  if (proposal.kind === 'ambiguous' && !proposal.options?.length)
    return 'Resolve the missing evidence and refresh before approval.';
  const candidate = candidateFor(proposal, account);
  const conflicts = (candidate?.conflicts ?? []).filter(Boolean);
  const notes = [];
  if (!proposal.manual && account?.status === 'Needs Review' && proposal.kind !== 'absent')
    notes.push('The existing Needs Review status stays in place; clearing it requires a separate reviewed status change.');
  if (proposal.kind === 'absent' && proposal.alternatives?.length)
    notes.push('Other accounts share this address; that does not verify current ownership.');
  if (proposal.kind === 'ambiguous' && option && (!proposal.status || proposal.status === 'pending'))
    notes.push('Confirm the identity choice and explain it in the reviewer note.');
  if (conflicts.length) notes.push(sentence(conflicts.map((conflict, index) =>
    index && conflict !== 'ZIP differs' ? conflict[0].toLowerCase() + conflict.slice(1) : conflict).join('; ')));
  if ((candidate?.reasons ?? []).includes('CRM contains a billing PO box'))
    notes.push('Keep the billing PO box; the website shows the physical address.');
  if ((proposal.linked_accounts ?? []).some((linked) => linked.route?.status === 'resolved' && linked.route.current === account?.account_id))
    notes.push('A historical account links to this current record; its billing history remains separate.');
  return notes.join(' ') || null;
}

function outcomeFor(proposal, optionId, option, account) {
  if (proposal.status === 'rejected') return 'No CRM records were changed by this rejection.';
  if (optionId === 'reject') return 'Keep all CRM records unchanged; record this rejection.';
  if (proposal.kind === 'unchanged') return 'Keep the CRM account unchanged.';
  if (!option && ['applied', 'partial', 'applying'].includes(proposal.status))
    return 'The approved option is unavailable in this view. Check the saved decision and operation history.';
  if (!option) return proposal.options?.length
    ? 'Choose a resolution to see exactly which account and fields it changes.'
    : 'No CRM change is available from this case.';
  const operations = option.operations ?? [], primary = operations.find((op) => ['patch', 'chow', 'create'].includes(op.type));
  const duplicates = operations.filter((op) => op.type === 'duplicate');
  const parts = [];
  if (proposal.manual && primary?.type === 'create')
    return `Create ${proposal.entity === 'contacts' ? 'contact' : 'account'} ${primary.fields.name || proposal.title} with the displayed fields.`;
  if (primary?.type === 'chow') {
    parts.push(`Create a replacement for ${primary.fields.name || proposal.title} under ${parentName(proposal, primary.fields.parent_id)}. On the original ${accountName(account ?? primary.before)}, set only the link to that replacement; preserve its parent, balances, and other fields.`);
  } else if (primary?.type === 'create') {
    parts.push(`Create ${primary.fields.name || proposal.title} under ${parentName(proposal, primary.fields.parent_id)} with the displayed website values. Existing accounts stay unchanged.`);
  } else if (primary?.type === 'patch') {
    parts.push(patchSummary(proposal, primary, account));
    if (proposal.kind === 'absent') parts.push('Keep its parent and billing history.');
  }
  if (duplicates.length)
    parts.push(`Keep ${primary?.type === 'chow' ? 'the new replacement' : primary ? 'this account' : accountName(account)} as the survivor. Mark ${duplicates.length} ${duplicates.length === 1 ? 'other copy' : 'other copies'} Inactive and link ${duplicates.length === 1 ? 'it' : 'them'} to the survivor, as shown below.`);
  else if (!operations.length) parts.push(`Save the reviewed choice; ${accountName(account)} stays unchanged.`);
  else if (option.resolution === 'existing' && primary?.type !== 'chow') parts.push('Other accounts stay unchanged.');
  return parts.join(' ') || 'Apply only the stored changes shown below.';
}

/** Compact context derived from the selected immutable proposal, never a new match or patch. */
export function reviewContext(proposal, optionId = '') {
  const safe = { candidates: [], alternatives: [], options: [], ...proposal };
  const option = safe.options.find((option) => option.id === optionId);
  const account = reviewAccount(safe, optionId);
  const historical = ['applied', 'rejected', 'partial', 'applying', 'stale', 'superseded'].includes(safe.status);
  const notices = {
    applied: 'This is the saved approval and its evidence at review time, not a fresh read of the CRM.',
    rejected: 'This rejection is saved. The evidence below is the snapshot reviewed at that time.',
    partial: 'The approved plan did not finish. Check the saved operation progress before resuming; these values are the original evidence.',
    applying: 'Completion is not verified. Resume the saved operation to check its progress; these values are the original evidence.',
    stale: 'The evidence changed after this proposal was created. Refresh and review the current case before approving.',
    superseded: 'A newer proposal replaced this version. These are historical values and cannot be approved.',
  };
  return {
    reason: reasonFor(safe), evidence: evidenceFor(safe, account, option),
    attention: attentionFor(safe, account, option), outcome: outcomeFor(safe, optionId, option, account),
    outcomeLabel: safe.status === 'rejected' ? 'Decision'
      : ['partial', 'applying'].includes(safe.status) ? 'Approved plan · incomplete'
      : safe.status === 'applied' ? 'Approved changes'
      : ['stale', 'superseded'].includes(safe.status) ? 'Previous proposal'
      : safe.kind === 'unchanged' ? 'Result' : optionId === 'reject' ? 'On rejection' : 'On approval',
    statusNotice: notices[safe.status] ?? (!safe.current && safe.current !== undefined && !historical
      ? 'This is a previous evidence snapshot. Review the current case before making a decision.' : null),
  };
}
