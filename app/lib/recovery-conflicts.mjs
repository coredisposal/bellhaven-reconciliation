import { canonical, norm, streetKey } from './core.mjs';

const realId = (id) => typeof id === 'string' && id && id !== '$replacement';
const intersects = (left, right) => [...left].some((key) => right.has(key));

// Case keys describe the review's origin, not the CRM records it can change.
// Reserve records and physical identities across manual and pipeline cases.
function footprint(proposal, options, checkpoints = []) {
  const records = new Set(),
    references = new Set(),
    identities = new Set();
  const record = (entity, id) => {
    if (realId(id)) records.add(`${entity}:${id}`);
  };
  const reference = (id) => {
    if (realId(id)) references.add(`accounts:${id}`);
  };
  const values = (entity, value) => {
    if (!value) return;
    if (entity === 'accounts') {
      record(entity, value.account_id);
      reference(value.parent_id);
      reference(value.chow_current_account);
      reference(value.duplicate_of_account);
      const street = streetKey(value.billing_street),
        city = norm(value.billing_city),
        state = norm(value.billing_state);
      if (street && city && state)
        identities.add(canonical(['account-location', street, city, state]));
      if (norm(value.name))
        identities.add(
          canonical([
            'account-identity',
            norm(value.name),
            value.parent_id ?? '',
            street,
            city,
            state,
          ])
        );
    } else {
      record(entity, value.contact_id);
      reference(value.account_id);
      if (realId(value.account_id) && norm(value.name))
        identities.add(
          canonical([
            'contact-identity',
            value.account_id,
            norm(value.name),
            norm(value.email),
            String(value.phone ?? '').replace(/\D/g, ''),
          ])
        );
    }
  };
  const operations = options.flatMap((option) => option.operations);
  for (const operation of operations) {
    const entity = operation.entity ?? proposal.entity ?? 'accounts';
    record(entity, operation.record_id ?? operation.account_id);
    values(entity, operation.before);
    values(entity, { ...operation.before, ...operation.fields });
    if (operation.type === 'chow_link')
      for (const dependency of operation.dependencies) reference(dependency.account_id);
  }
  if (proposal.manual && proposal.relationship)
    for (const dependency of proposal.dependencies ?? []) reference(dependency.account_id);
  for (const checkpoint of checkpoints) {
    const operation = operations[checkpoint.step],
      entity = operation?.entity ?? proposal.entity ?? 'accounts';
    record(entity, checkpoint.data.recordId);
    record('accounts', checkpoint.data.replacement);
    values(entity, checkpoint.data.created);
    values(entity, checkpoint.data.after);
  }
  return { records, references, identities };
}

/** Call while holding the ledger lock, before staging or applying CRM work. */
export async function assertNoInterruptedOverlap(ledger, proposal, option) {
  const interrupted = await ledger.all(
    "SELECT id,data FROM proposals WHERE status IN ('partial','applying') AND id<>?",
    proposal.id
  );
  if (!interrupted.length) return;
  const candidate = footprint(proposal, option ? [option] : proposal.options);
  for (const row of interrupted) {
    const existing = JSON.parse(row.data),
      approval = await ledger.one(
        "SELECT option_id FROM decisions WHERE proposal_id=? AND action='approve' ORDER BY rowid DESC LIMIT 1",
        row.id
      ),
      approvedOption = existing.options.find((item) => item.id === approval?.option_id),
      checkpoints = (
        await ledger.all('SELECT step,data FROM operations WHERE proposal_id=?', row.id)
      ).map((item) => ({ ...item, data: JSON.parse(item.data) })),
      reserved = footprint(
        existing,
        approvedOption ? [approvedOption] : existing.options,
        checkpoints
      );
    if (
      intersects(candidate.records, reserved.records) ||
      intersects(candidate.references, reserved.records) ||
      intersects(candidate.records, reserved.references) ||
      intersects(candidate.identities, reserved.identities)
    )
      throw new Error(
        'Related accounts or records have interrupted approved work. Resume that saved operation before staging or approving another change.'
      );
  }
}
