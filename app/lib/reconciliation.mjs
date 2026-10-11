// @ts-check
import { reconcile as facilityReconciliation, canonical, facilityMaterial } from './core.mjs';
import { crmQuality } from './crm-quality.mjs';
import { isRecord, isFacility } from './contracts.mjs';

/** Keep explicit field choices from existing approvals across the feature upgrade.
 * Only identical website evidence and the deliberately retained CRM value qualify.
 * @param {import('./domain-types').Snapshot} snapshot
 * @param {D1Database | undefined} db
 * @param {import('./domain-types').Proposal[]} facilities
 */
async function retainedFields(snapshot, db, facilities) {
  /** @type {Map<string, Set<'phone'|'care_type'>>} */
  const retained = new Map();
  if (!db) return retained;
  const rows = await db.prepare(`SELECT p.data,d.option_id FROM decisions d
    JOIN proposals p ON p.id=d.proposal_id WHERE d.action='approve' AND p.status='applied'
    AND json_extract(p.data,'$.facility.source_url') IS NOT NULL
    ORDER BY d.rowid DESC`).all();
  const seen = new Set();
  for (const row of rows.results) {
    if (typeof row.data !== 'string') continue;
    /** @type {unknown} */
    const p = JSON.parse(row.data);
    if (!isRecord(p) || p.kind === 'crm_quality' || !isFacility(p.facility) || !Array.isArray(p.options)) continue;
    const url = p.facility.source_url;
    if (seen.has(url)) continue;
    seen.add(url);
    const facility = snapshot.facilities.find((f) => f.source_url === url);
    if (!facility || canonical(facilityMaterial(facility)) !== canonical(facilityMaterial(p.facility))) continue;
    const option = p.options.find((o) => isRecord(o) && o.id === row.option_id);
    if (!isRecord(option) || !Array.isArray(option.operations)) continue;
    const primary = option.operations.find((o) => isRecord(o) && ['patch','chow','create'].includes(String(o.type)));
    const candidate = Array.isArray(p.candidates) ? p.candidates.find((c) => isRecord(c) && isRecord(c.account) &&
      c.account.account_id === (option.account_id ?? option.id)) : undefined;
    let id = isRecord(primary) && ['patch','chow'].includes(String(primary.type)) ? primary.account_id :
      isRecord(candidate) && isRecord(candidate.account) ? candidate.account.account_id : null;
    if (isRecord(primary) && primary.type === 'chow')
      id = snapshot.accounts.find((a) => a.account_id === id)?.chow_current_account;
    const account = snapshot.accounts.find((a) => a.account_id === id);
    if (!account) continue;
    const current = facilities.find((p) => p.facility?.source_url === url);
    if (current?.candidates.length !== 1 || current.candidates[0].account.account_id !== id) continue;
    const choices = isRecord(option.field_choices) ? option.field_choices : null;
    /** @type {Set<'phone'|'care_type'>} */
    const fields = new Set();
    if (choices && isRecord(choices.phone) && choices.phone.selected === false &&
      choices.phone.current === (account.phone ?? null) && choices.phone.proposed === facility.phone_raw) fields.add('phone');
    if (choices && isRecord(choices.care_type) && choices.care_type.selected === null &&
      choices.care_type.current === (account.care_type ?? null)) fields.add('care_type');
    // Earlier approvals predate optional selectors. Their stored patch still
    // records the values intentionally left alone; do not reopen that choice.
    if (!choices && isRecord(primary) && primary.type === 'patch' &&
        isRecord(primary.fields) && isRecord(primary.before)) {
      for (const field of /** @type {const} */ (['phone', 'care_type']))
        if (!(field in primary.fields) && primary.before[field] === (account[field] ?? null)) fields.add(field);
    }
    if (!choices && isRecord(primary) && primary.type === 'chow' && isRecord(primary.fields)) {
      for (const field of /** @type {const} */ (['phone', 'care_type']))
        if (primary.fields[field] === (account[field] ?? null)) fields.add(field);
    }
    if (fields.size) retained.set(url, fields);
  }
  return retained;
}

/** One read-only pipeline for website reconciliation and CRM-wide quality.
 * @param {import('./domain-types').Snapshot} snapshot
 * @param {D1Database} [db]
 */
export async function reconcile(snapshot, db) {
  const facilities = await facilityReconciliation(snapshot);
  const quality = await crmQuality(snapshot, facilities, await retainedFields(snapshot, db, facilities));
  if (!db) return [...facilities, ...quality];
  // A partially executed approval is an intermediate state, not fresh evidence
  // for an overlapping cleanup. Keep its own case available for safe resume.
  const rows = await db.prepare(`SELECT p.data,o.data AS checkpoint FROM proposals p
    LEFT JOIN operations o ON o.proposal_id=p.id WHERE p.status IN ('partial','applying')`).all();
  const heldKeys = new Set(), heldAccounts = new Set();
  for (const row of rows.results) {
    if (typeof row.data !== 'string') continue;
    const p = JSON.parse(row.data);
    if (!isRecord(p)) continue;
    heldKeys.add(p.key);
    if (Array.isArray(p.candidates)) for (const c of p.candidates)
      if (isRecord(c) && isRecord(c.account)) heldAccounts.add(c.account.account_id);
    if (Array.isArray(p.options)) for (const option of p.options)
      if (isRecord(option) && Array.isArray(option.operations)) for (const op of option.operations)
        if (isRecord(op) && (op.entity ?? p.entity ?? 'accounts') === 'accounts') {
          heldAccounts.add(op.account_id);
          heldAccounts.add(op.record_id);
        }
    if (typeof row.checkpoint === 'string') {
      const checkpoint = JSON.parse(row.checkpoint);
      if (isRecord(checkpoint)) {
        heldAccounts.add(checkpoint.replacement);
        heldAccounts.add(checkpoint.recordId);
        for (const field of ['created','after','before']) {
          const value = checkpoint[field];
          if (isRecord(value)) heldAccounts.add(value.account_id);
        }
      }
    }
  }
  return [...facilities, ...quality.filter((p) => heldKeys.has(p.key) ||
    !p.candidates.some((c) => heldAccounts.has(c.account.account_id)))];
}
