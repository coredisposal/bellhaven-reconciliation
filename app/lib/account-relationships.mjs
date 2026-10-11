// @ts-check
import { needsChow, norm, streetKey } from './core.mjs';
import { isAccount } from './contracts.mjs';

/** @param {unknown} value */
function billingNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value)))
    return Number(value);
  return NaN;
}

/** Address overlap alone does not establish ownership. This guard checks the
 * permitted operation; the reviewer still confirms the relationship evidence.
 * @param {import('./domain-types').Account} source
 * @param {import('./domain-types').Account} target
 * @param {import('./domain-types').Account[]} accounts
 * @param {'chow'|'duplicate'} type
 */
export function assertRelationship(source, target, accounts, type) {
  if (!isAccount(source) || !isAccount(target)) throw new Error('Both facility accounts must exist.');
  if (source.account_id === target.account_id) throw new Error('Choose a different target account; an account cannot link to itself.');
  if ([source, target].some((record) => accounts.filter((a) => a.account_id === record.account_id).length !== 1))
    throw new Error('Both facility accounts must appear exactly once in the complete CRM inventory.');
  if (accounts.some((a) => a.parent_id === source.account_id || a.parent_id === target.account_id) ||
    [source, target].some((a) => /\(parent account\)\s*$/i.test(a.name)))
    throw new Error('Parent accounts cannot be linked as facilities.');
  if (source.chow_current_account || source.duplicate_of_account ||
      target.chow_current_account || target.duplicate_of_account)
    throw new Error('Historical or already linked records cannot be used for a new relationship.');
  if (!['Active', 'Needs Review'].includes(source.status ?? '') || target.status !== 'Active')
    throw new Error('Select an active current target and an active or Needs Review source.');
  if (!source.parent_id || !target.parent_id)
    throw new Error('Both facilities require an explicit parent before linking.');
  if (!(billingNumber(target.lifetime_revenue) >= 0) || !Number.isFinite(billingNumber(target.outstanding_ar)))
    throw new Error('The target requires verified billing values before linking; negative lifetime revenue needs investigation.');
  if (type === 'chow') {
    if (source.parent_id === target.parent_id)
      throw new Error('A CHOW successor requires a different parent.');
    if (!needsChow(source, target.parent_id))
      throw new Error('CHOW linking requires positive lifetime revenue and outstanding AR on the original account.');
  } else {
    if (source.parent_id !== target.parent_id)
      throw new Error('Duplicate links require the same parent. Confirm ownership before consolidating.');
    if (billingNumber(source.lifetime_revenue) !== 0 || billingNumber(source.outstanding_ar) !== 0)
      throw new Error('A duplicate can be retired only when lifetime revenue and outstanding AR are both verified zero.');
    if (accounts.some((a) => a.chow_current_account === source.account_id || a.duplicate_of_account === source.account_id))
      throw new Error('This account already receives historical or duplicate links. Resolve those relationships before retiring it.');
  }
  if ([source, target].some((a) => !/^\d+\S*\s+\S/.test(streetKey(a.billing_street)) ||
      !norm(a.billing_city) || !norm(a.billing_state) || !/^\d{5}(?:-\d{4})?$/.test(a.billing_zip ?? '')) ||
      streetKey(source.billing_street) !== streetKey(target.billing_street) ||
      norm(source.billing_city) !== norm(target.billing_city) || norm(source.billing_state) !== norm(target.billing_state) ||
      source.billing_zip?.slice(0, 5) !== target.billing_zip?.slice(0, 5))
    throw new Error('Linking requires matching physical street, city, state and ZIP evidence. PO boxes or incomplete/conflicting addresses need verification first.');
}
