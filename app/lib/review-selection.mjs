/** Recover exactly the option that was approved when displaying decision history. */
export function selectedOption(proposal, decisions, requested = '') {
  if (!proposal) return '';
  if (proposal.status === 'rejected') return 'reject';
  if (['applied', 'partial', 'applying'].includes(proposal.status)) {
    const approval = decisions
      .filter((d) => d.proposal_id === proposal.id && d.action === 'approve')
      .sort((a, b) => b.created.localeCompare(a.created))[0];
    return proposal.options.some((o) => o.id === approval?.option_id) ? approval.option_id : '';
  }
  if (requested === 'reject' && proposal.status === 'pending') return 'reject';
  if (proposal.options.some((o) => o.id === requested)) return requested;
  return proposal.kind === 'ambiguous' ? '' : (proposal.options[0]?.id ?? '');
}

/** A repeated manual draft keeps its original decision; open the view containing it. */
export function draftDestination(status = 'pending') {
  if (status === 'applied')
    return {
      view: 'history',
      message: 'This proposal was already applied. The saved decision is shown below.',
    };
  if (status === 'rejected')
    return {
      view: 'history',
      message: 'This proposal was already rejected. Review the saved decision before reopening it.',
    };
  if (['partial', 'applying'].includes(status))
    return {
      view: 'queue',
      message:
        'This approved proposal has unfinished work. Inspect its saved progress before resuming.',
    };
  if (status === 'stale')
    return {
      view: 'queue',
      message: 'This proposal is stale. Refresh the evidence before approving changes.',
    };
  return { view: 'queue', message: 'Proposal saved. Review the exact changes before approving.' };
}

/** A completed request must not erase notes typed for another case while it ran. */
export function clearFinishedReview(input, proposalId) {
  return input.proposalId === proposalId ? { proposalId: '', option: '', note: '' } : input;
}

/** Display the account selected for this resolution, never an unrelated candidate. */
export function reviewAccount(proposal, optionId) {
  if (!proposal) return undefined;
  if (optionId === 'reject' && !['ambiguous', 'new_account'].includes(proposal.kind) && proposal.candidates.length === 1)
    return proposal.candidates[0].account;
  if (!optionId && proposal.kind === 'unchanged' && proposal.status === 'unchanged' &&
      proposal.options.length === 0 && proposal.candidates.length === 1)
    return proposal.candidates[0].account;
  const option = proposal.options.find((o) => o.id === optionId);
  if (!option) return undefined;
  const primary = option.operations?.find((o) => ['patch', 'chow', 'create'].includes(o.type));
  if (option.resolution === 'separate' || primary?.type === 'create') return undefined;
  const accountId = option.account_id ?? primary?.account_id ?? primary?.before?.account_id ?? option.base_option_id ?? option.id;
  return [...proposal.candidates, ...(proposal.alternatives ?? [])]
    .find((c) => c.account.account_id === accountId)?.account ??
    (primary?.before?.account_id === accountId ? primary.before : undefined);
}

/** Approval consequences come from the selected operations, including ambiguous cases. */
export function reviewOperation(option) {
  const operation = option?.operations.find((o) => ['patch', 'chow', 'create'].includes(o.type));
  return {
    fields: operation?.fields ?? {},
    isChow: operation?.type === 'chow',
    isNewAccount: operation?.type === 'create',
    changesParent: operation?.type === 'patch' && Object.hasOwn(operation.fields, 'parent_id'),
  };
}

/** Field combinations share one visible resolution, with one immutable payload per choice. */
export function resolutionOptions(proposal) {
  const seen = new Set();
  return (proposal?.options ?? []).filter((option) => {
    const id = option.base_option_id ?? option.id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Resolve controls to an offered server option; never construct a CRM patch in the browser. */
export function selectFieldChoice(proposal, optionId, field, value) {
  const current = proposal?.options.find((option) => option.id === optionId);
  if (!current?.field_choices?.[field]) return optionId;
  const selected = Object.fromEntries(Object.entries(current.field_choices)
    .map(([key, choice]) => [key, key === field ? value : choice.selected]));
  return proposal.options.find((option) =>
    (option.base_option_id ?? option.id) === (current.base_option_id ?? current.id) &&
    Object.entries(selected).every(([key, value]) => option.field_choices?.[key]?.selected === value)
  )?.id ?? optionId;
}

function historyLink(proposal, account) {
  const chow = account.chow_current_account, duplicate = account.duplicate_of_account;
  if (!chow && !duplicate) return null;
  const route = proposal.linked_accounts?.find((item) => item.account.account_id === account.account_id)?.route;
  const conflicting = (chow && duplicate && chow !== duplicate) ||
    chow === account.account_id || duplicate === account.account_id ||
    proposal.link_conflicts?.some((item) => item.account.account_id === account.account_id);
  const recorded = chow || duplicate;
  if (!conflicting && route?.status === 'resolved' && route.current && route.current !== account.account_id)
    return `Current account · ${route.current}${route.current === recorded ? '' : ` (via ${recorded})`}`;
  const pointers = chow && duplicate && chow !== duplicate
    ? `CHOW ${chow}; duplicate ${duplicate}` : recorded;
  return `Recorded history link · ${pointers} (needs verification)`;
}

/** Relevant account identities and exact selected consequences, including protected history. */
export function reviewAccountImpact(proposal, optionId) {
  if (!proposal) return [];
  const options = proposal.options;
  const selected = options.find((option) => option.id === optionId);
  const accounts = new Map(proposal.candidates.map((candidate) => [candidate.account.account_id, candidate.account]));
  const related = new Set((proposal.matching_conflicts ?? []).map((item) => item.account_id));
  for (const candidate of proposal.alternatives ?? [])
    if (!proposal.candidates.length || related.has(candidate.account.account_id) || proposal.kind === 'absent')
      accounts.set(candidate.account.account_id, candidate.account);
  for (const candidate of proposal.linked_accounts ?? [])
    accounts.set(candidate.account.account_id, candidate.account);
  for (const option of options)
    for (const operation of option.operations)
      if (operation.before?.account_id) accounts.set(operation.before.account_id, operation.before);
  const survivor = selected ? reviewAccount(proposal, selected.id)?.account_id : undefined;
  return [...accounts.values()].map((account) => {
    const operation = selected?.operations.find((op) => op.account_id === account.account_id);
    const targetId = operation?.type === 'duplicate' ? operation.fields.duplicate_of_account : undefined;
    return {
      account,
      action: account.chow_current_account || account.duplicate_of_account ? 'Preserve historical account'
        : optionId === 'reject' || proposal.status === 'rejected' ? 'Keep unchanged'
        : proposal.status === 'unchanged' ? 'No change needed'
        : !selected ? options.length ? 'Choose a resolution' : 'No change available'
        : operation?.type === 'duplicate' ? 'Set Inactive'
        : operation?.type === 'chow' ? 'Preserve original; link replacement'
        : selected.operations.some((op) => op.type === 'create') ? 'Keep unchanged'
        : account.account_id === survivor
          ? selected.operations.some((op) => op.type === 'duplicate')
            ? operation?.type === 'patch' ? 'Keep as survivor; update fields' : 'Keep as survivor'
            : operation?.type === 'patch' ? 'Update this account' : 'Keep unchanged'
          : 'Keep unchanged',
      link: account.chow_current_account || account.duplicate_of_account
        ? historyLink(proposal, account)
        : targetId === '$replacement' ? 'New replacement account'
        : targetId ? `${accounts.get(targetId)?.name ?? 'Account'} · ${targetId}` : null,
    };
  });
}

/** Older survivor options need location/ID context; resolution labels already include it. */
export function reviewOptionLabel(proposal, option) {
  if (option.resolution) return option.label;
  const account = reviewAccount(proposal, option.id);
  return account
    ? [option.label, [account.billing_city, account.billing_state].filter(Boolean).join(', '), account.account_id].filter(Boolean).join(' · ')
    : option.label;
}

const comparedFields = new Set(['name', 'parent_id', 'billing_street', 'billing_city',
  'billing_state', 'billing_zip', 'care_type', 'phone', 'status']);

/** Describe highlights only when the comparison actually contains a changed field. */
export function reviewEvidenceCaption(option) {
  if (!option) return 'Evidence only · no changes selected';
  const operations = option.operations ?? [];
  if (!operations.length) return 'Keep current values · no CRM changes';
  if (operations.some((operation) => ['create', 'chow'].includes(operation.type)))
    return 'Values for the new account';
  const fields = operations.find((operation) => operation.type === 'patch')?.fields ?? {};
  if (Object.keys(fields).some((key) => comparedFields.has(key)))
    return 'Highlighted values will change';
  const note = Object.hasOwn(fields, 'note');
  const duplicates = operations.some((operation) => operation.type === 'duplicate');
  return note && duplicates ? 'CRM note + account actions'
    : note ? 'CRM note only'
    : 'Account actions shown above';
}

/** Plain-language consequences follow the selected stored variant, including optional fields. */
export function reviewOptionSummary(option) {
  const operations = option.operations ?? [];
  if (!operations.length) return 'Save this reviewed choice without changing any CRM fields.';
  const primary = operations.find((operation) => ['chow', 'create', 'patch'].includes(operation.type));
  const duplicateCount = operations.filter((operation) => operation.type === 'duplicate').length;
  let action;
  if (primary?.type === 'chow')
    action = 'Create a replacement under Bellhaven; preserve the original account and billing history.';
  else if (primary?.type === 'create')
    action = 'Create the website facility under Bellhaven. Existing accounts stay unchanged.';
  else if (primary?.type === 'patch') {
    const fields = primary.fields ?? {}, changes = [];
    if (Object.hasOwn(fields, 'name')) changes.push('name');
    if (Object.hasOwn(fields, 'parent_id')) changes.push('parent');
    const address = Object.keys(fields).filter((key) => key.startsWith('billing_'));
    if (address.length) changes.push(address.length === 1 && address[0] === 'billing_zip' ? 'ZIP' : 'billing address');
    if (Object.hasOwn(fields, 'phone')) changes.push('phone');
    if (Object.hasOwn(fields, 'status')) changes.push('status');
    if (Object.hasOwn(fields, 'note')) changes.push('CRM note');
    const parts = [];
    const joinedChanges = changes.length < 3 ? changes.join(' and ')
      : `${changes.slice(0, -1).join(', ')}, and ${changes.at(-1)}`;
    if (changes.length) parts.push(`Update this account’s ${joinedChanges}.`);
    if (Object.hasOwn(fields, 'care_type')) parts.push(`Set its care category to ${fields.care_type || 'blank'}.`);
    action = parts.join(' ') || 'Apply the stored fields to this account.';
  } else action = `Keep ${option.label || 'the selected account'} active.`;
  return action + (duplicateCount
    ? ` Mark ${duplicateCount} other ${duplicateCount === 1 ? 'copy' : 'copies'} Inactive and link to ${primary?.type === 'chow' ? 'the replacement' : 'this account'}.`
    : option.resolution === 'existing' ? ' Other accounts stay unchanged.' : '');
}

/** Reflect a server acknowledgement even if the following ledger read fails. */
export function applyAcknowledgedDecision(proposals, id, status) {
  if (!['applied', 'rejected', 'pending'].includes(status)) return proposals;
  return proposals.map((proposal) => (proposal.id === id ? { ...proposal, status } : proposal));
}

/** History pointers protect the source account regardless of its Active status. */
export function historicalAccount(record, entity = 'accounts') {
  if (
    entity !== 'accounts' ||
    !record ||
    (!record.chow_current_account && !record.duplicate_of_account)
  )
    return null;
  const chow = record.chow_current_account,
    duplicate = record.duplicate_of_account,
    id = chow || duplicate;
  const conflicting = Boolean(chow && duplicate && chow !== duplicate) || id === record.account_id;
  const target =
    !conflicting && typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null;
  return {
    target,
    description: conflicting
      ? 'Conflicting history links · read-only. Inspect the relationship before making changes.'
      : chow
        ? 'Historical CHOW account · read-only. Its original billing history is preserved.'
        : 'Duplicate account · read-only. Its record history is preserved.',
  };
}
