// @ts-check
/** Runtime checks at external-data boundaries. Preserve values; never coerce unknown billing to zero. */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @returns {value is string} */
const identifier = (value) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
/** @param {Record<string, unknown>} value @param {string[]} keys */
const nullableText = (value, keys) => keys.every((key) => value[key] == null || typeof value[key] === 'string');
/** @param {unknown} value */
const billing = (value) => value == null || typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value));

/** @param {unknown} value @returns {value is import('./domain-types').Account} */
export function isAccount(value) {
  return isRecord(value) && identifier(value.account_id) && typeof value.name === 'string' &&
    value.name.trim().length > 0 && nullableText(value, [
      'parent_id', 'parent_name', 'billing_street', 'billing_city', 'billing_state', 'billing_zip',
      'care_type', 'status', 'phone', 'chow_current_account', 'duplicate_of_account', 'note', 'updated_at',
    ]) && billing(value.lifetime_revenue) && billing(value.outstanding_ar) &&
    (value.created_by_candidate == null || typeof value.created_by_candidate === 'boolean');
}

/** @param {unknown} value @returns {asserts value is import('./domain-types').Account} */
export function assertAccount(value) {
  if (!isAccount(value)) throw new Error('CRM account response has missing identity or invalid field types. Refresh after the source record is corrected.');
}

/** @param {unknown} value @returns {value is import('./domain-types').Contact} */
export function isContact(value) {
  return isRecord(value) && identifier(value.contact_id) && identifier(value.account_id) &&
    typeof value.name === 'string' && value.name.trim().length > 0 &&
    nullableText(value, ['title', 'email', 'phone', 'updated_at']) &&
    (value.is_active == null || typeof value.is_active === 'boolean') &&
    (value.created_by_candidate == null || typeof value.created_by_candidate === 'boolean');
}

/** @param {unknown} value @returns {asserts value is import('./domain-types').Contact} */
export function assertContact(value) {
  if (!isContact(value)) throw new Error('CRM contact response has missing identity or invalid field types. Refresh after the source record is corrected.');
}

/** @param {unknown} value @returns {value is import('./domain-types').Facility} */
export function isFacility(value) {
  return isRecord(value) && ['name', 'city', 'state', 'street_address', 'postal_code', 'source_url']
    .every((key) => typeof value[key] === 'string' && value[key].trim().length > 0) &&
    typeof value.phone_raw === 'string' && Array.isArray(value.care_offerings) &&
    value.care_offerings.length > 0 && value.care_offerings.every((v) => typeof v === 'string' && !!v.trim()) &&
    ['administrator', 'retrieved_at_utc', 'source_file', 'html_hash']
      .every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    (value.linked_from_home === undefined || typeof value.linked_from_home === 'boolean') &&
    (value.directory_pages === undefined || (Array.isArray(value.directory_pages) &&
      value.directory_pages.every((v) => typeof v === 'string')));
}
