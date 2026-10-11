// @ts-check
import { ORIGIN, digest } from './core.mjs';
import { isRecord as record, assertAccount, assertContact } from './contracts.mjs';

/** @typedef {{q?:string,city?:string,state?:string,zip?:string,street?:string,parent_id?:string,page?:number,page_size?:number}} AccountFilters */
/** @typedef {{account_id?:string,q?:string,page?:number,page_size?:number}} ContactFilters */
/** @typedef {import('./domain-types').AccountPatch} AccountFields */
/** @typedef {import('./domain-types').ContactPatch} ContactFields */
/** @typedef {import('./domain-types').Account} Account */
/** @typedef {import('./domain-types').Contact} Contact */
/** @template T @typedef {{data:T[], page:number, page_size?:number, total:number}} CrmPage */

const ACCOUNT_FILTERS = ['q', 'city', 'state', 'zip', 'street', 'parent_id'];
const CONTACT_FILTERS = ['account_id', 'q'];
const ACCOUNT_FIELDS = {
  name: 'string',
  parent_id: 'string',
  billing_street: 'string',
  billing_city: 'string',
  billing_state: 'string',
  billing_zip: 'string',
  care_type: 'string',
  status: 'string',
  phone: 'string',
  lifetime_revenue: 'number',
  outstanding_ar: 'number',
  chow_current_account: 'string',
  duplicate_of_account: 'string',
  note: 'string',
};
const CONTACT_FIELDS = {
  account_id: 'string',
  name: 'string',
  title: 'string',
  email: 'string',
  phone: 'string',
  is_active: 'boolean',
};
const PAGE_LIMIT = 100;

// Describes observed public endpoints/fields, not an inferred upstream body schema.
// The schema publishes integer defaults but no minimum/maximum; bounds are ours.
export const API_CATALOG = Object.freeze({
  schema_url: ORIGIN + '/api/openapi.json',
  observed_on: '2026-10-10',
  authentication: 'server-side Bearer token',
  body_schema_documented: false,
  deletion_supported: false,
  pagination: {
    default_page: 1,
    default_page_size: 50,
    application_min_page: 1,
    application_max_page: PAGE_LIMIT,
    application_min_page_size: 1,
    application_max_page_size: 100,
    upstream_bounds_documented: false,
  },
  account_filters: Object.freeze([...ACCOUNT_FILTERS, 'page', 'page_size']),
  contact_filters: Object.freeze([...CONTACT_FILTERS, 'page', 'page_size']),
  account_fields: Object.freeze({ ...ACCOUNT_FIELDS }),
  contact_fields: Object.freeze({ ...CONTACT_FIELDS }),
  account_read_only_fields: Object.freeze([
    'account_id',
    'parent_name',
    'created_by_candidate',
    'updated_at',
  ]),
  contact_read_only_fields: Object.freeze(['contact_id', 'created_by_candidate', 'updated_at']),
  operations: Object.freeze(
    [
      { helper: 'listAccounts', method: 'GET', path: '/api/v1/accounts' },
      { helper: 'getAccount', method: 'GET', path: '/api/v1/accounts/{account_id}' },
      { helper: 'createAccount', method: 'POST', path: '/api/v1/accounts' },
      { helper: 'patchAccount', method: 'PATCH', path: '/api/v1/accounts/{account_id}' },
      { helper: 'listContacts', method: 'GET', path: '/api/v1/contacts' },
      { helper: 'getContact', method: 'GET', path: '/api/v1/contacts/{contact_id}' },
      { helper: 'createContact', method: 'POST', path: '/api/v1/contacts' },
      { helper: 'patchContact', method: 'PATCH', path: '/api/v1/contacts/{contact_id}' },
      { helper: 'me', method: 'GET', path: '/api/v1/me' },
    ].map(Object.freeze)
  ),
});

/** @param {unknown} filters @param {string[]} allowed @param {string} entity */
function query(filters, allowed, entity) {
  if (!record(filters)) throw new TypeError(`CRM ${entity} filters must be an object.`);
  if (
    Object.keys(filters).some(
      (key) => !allowed.includes(key) && key !== 'page' && key !== 'page_size'
    )
  )
    throw new TypeError(`Unknown CRM ${entity} filter.`);
  const params = new URLSearchParams();
  for (const key of allowed)
    if (filters[key] !== undefined) {
      if (typeof filters[key] !== 'string' || filters[key].length > 2000)
        throw new TypeError(
          `CRM ${entity} text filters must be strings of at most 2,000 characters.`
        );
      params.set(key, filters[key]);
    }
  /** @type {[string, number, number][]} */
  const bounds = [
    ['page', 1, PAGE_LIMIT],
    ['page_size', 50, 100],
  ];
  for (const [key, fallback, max] of bounds) {
    const value = filters[key] ?? fallback;
    if (
      (filters[key] !== undefined && filters[key] === null) ||
      typeof value !== 'number' || !Number.isSafeInteger(value) ||
      value < 1 ||
      value > max
    )
      throw new TypeError(`CRM ${key} must be an integer from 1 to ${max}.`);
    params.set(key, String(value));
  }
  return params.toString();
}
/** @param {unknown} id */
function identifier(id) {
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    id.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(id) ||
    id === '.' ||
    id === '..'
  )
    throw new TypeError('CRM record ID must be a nonempty identifier of at most 256 characters.');
  return encodeURIComponent(id);
}
/** @param {unknown} body @param {Record<string,string>} allowed @param {string} entity */
function fields(body, allowed, entity) {
  if (!record(body) || !Object.keys(body).length)
    throw new TypeError(`CRM ${entity} fields must be a nonempty object.`);
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(allowed, key))
      throw new TypeError(`Unknown or read-only CRM ${entity} field.`);
    if (typeof value !== allowed[key] || (typeof value === 'number' && !Number.isFinite(value)))
      throw new TypeError(`CRM ${entity} field has an invalid value type.`);
  }
  return body;
}
/** @param {unknown} value @param {string} token @returns {unknown} */
function withoutCredential(value, token) {
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]');
  if (Array.isArray(value)) return value.map((item) => withoutCredential(item, token));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/(?:token|secret|password|authorization|cookie|csrf)/i.test(key))
        .map(([key, item]) => [key, withoutCredential(item, token)])
    );
  return value;
}
/** @param {string} s */
const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
/** @param {string} s */
const text = (s) =>
  decode(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
/** @param {string} html @param {string} base */
function links(html, base) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)]
    .map((m) => new URL(decode(m[1]), base))
    .filter((u) => u.origin === ORIGIN);
}
/** @param {string} html @param {string} url @param {string} [retrieved] @returns {import('./domain-types').Facility} */
function parseFacility(html, url, retrieved = new Date().toISOString()) {
  const name = text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const fields = Object.fromEntries(
    [...html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)].map((m) => [
      text(m[1]),
      m[2],
    ])
  );
  const address = (fields.Address ?? '').split(/<br\s*\/?\s*>/i).map(text);
  const locality = address[1]?.match(/^(.+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  const care = [
    ...(fields['Care Offerings'] ?? '').matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi),
  ].map((m) => text(m[1]));
  if (!name || !address[0] || !locality || !care.length || care.some((offering) => !offering))
    throw new Error(`Facility markup incomplete: ${new URL(url).pathname}`);
  return {
    name,
    street_address: address[0],
    city: locality[1],
    state: locality[2],
    postal_code: locality[3],
    care_offerings: care,
    administrator: text(fields.Administrator ?? ''),
    phone_raw: text(fields.Phone ?? ''),
    source_url: url,
    retrieved_at_utc: retrieved,
  };
}
/** @param {typeof fetch} [fetcher] */
export async function crawl(fetcher = fetch) {
  /** @type {import('./domain-types').SourcePage[]} */
  const pages = [];
  const
    queue = [ORIGIN + '/', ORIGIN + '/communities'],
    seen = new Set(),
    detail = new Set();
  let expected = null;
  /** @param {string} url */
  async function get(url) {
    const r = await fetcher(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Source HTTP ${r.status} at ${new URL(url).pathname}`);
    const html = await r.text();
    pages.push({ url, retrieved_at_utc: new Date().toISOString(), hash: await digest(html), html });
    return html;
  }
  while (queue.length) {
    const url = queue.shift();
    if (!url) break;
    if (seen.has(url)) continue;
    if (seen.size > 20) throw new Error('Directory pagination exceeds safe bound');
    seen.add(url);
    const html = await get(url);
    if (url === ORIGIN + '/')
      expected =
        Number(text(html).match(/\b(\d+)\s+(?:communities|facilities|locations)\b/i)?.[1] ?? 0) ||
        null;
    for (const u of links(html, url)) {
      if (/^\/communities\/[^/]+$/.test(u.pathname)) detail.add(u.origin + u.pathname);
      else if (u.pathname === '/communities' && /^(?:\?page=\d+)?$/.test(u.search))
        queue.push(u.href);
    }
  }
  if (!detail.size) throw new Error('No facility links discovered');
  const facilities = [];
  const urls = [...detail].sort();
  // Bounded concurrency avoids holding dozens of sockets or overwhelming the source.
  for (let i = 0; i < urls.length; i += 5)
    facilities.push(
      ...(await Promise.all(
        urls.slice(i, i + 5).map(async (url) => parseFacility(await get(url), url))
      ))
    );
  const identities = new Set(facilities.map((f) => `${f.street_address}|${f.city}|${f.state}`));
  const complete =
    expected !== null && facilities.length === expected && identities.size === facilities.length;
  return {
    facilities,
    pages,
    coverage: {
      complete,
      expected,
      found: facilities.length,
      urls: pages.map((p) => p.url).sort(),
      directory_pages: [...seen].sort(),
      warning: complete ? null : 'Completeness unproven; website-absence proposals are disabled.',
    },
  };
}
/** @param {(path:string) => Promise<unknown>} request @param {'accounts'|'contacts'} entity */
export async function paginate(request, entity) {
  if (!['accounts', 'contacts'].includes(entity))
    throw new TypeError('Unsupported CRM pagination entity.');
  const rows = [],
    ids = new Set();
  let total;
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const data = await request(`/${entity}?page=${page}&page_size=50`);
    if (
      !record(data) || !Array.isArray(data.data) ||
      typeof data.total !== 'number' ||
      !Number.isInteger(data.total) ||
      data.total < 0 ||
      data.page !== page
    )
      throw new Error(`Invalid ${entity} pagination`);
    if (total !== undefined && data.total !== total)
      throw new Error('CRM changed during pagination; retry snapshot');
    total = data.total;
    for (const row of data.data) {
      const id = record(row) ? row[`${entity.slice(0, -1)}_id`] : undefined;
      if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new Error('Duplicate or missing CRM ID during pagination');
      ids.add(id);
      rows.push(row);
    }
    if (rows.length === total) return rows;
    if (rows.length > total || !data.data.length) throw new Error('Incomplete CRM pagination');
  }
  throw new Error('CRM pagination limit exceeded');
}
/** @template {'account_id'|'contact_id'} K @param {unknown} value @param {K} key @returns {Record<K,string>} */
function acknowledgement(value, key) {
  const data = record(value) && value.data != null ? value.data : value;
  if (!record(data) || typeof data[key] !== 'string' || !data[key].trim())
    throw new Error('CRM creation response has no record ID. Outcome may be uncertain; no automatic write retry.');
  // The only retained property has just been validated; a create acknowledgement
  // is not treated as a complete account. The execution layer reads it back.
  return /** @type {Record<K,string>} */ ({ [key]: data[key] });
}
/** @overload @param {unknown} value @param {'accounts'} entity @param {number} page @returns {CrmPage<Account>} */
/** @overload @param {unknown} value @param {'contacts'} entity @param {number} page @returns {CrmPage<Contact>} */
/** @param {unknown} value @param {'accounts'|'contacts'} entity @param {number} page @returns {CrmPage<Account|Contact>} */
function readPage(value, entity, page) {
  if (!record(value) || !Array.isArray(value.data) || typeof value.total !== 'number' ||
      !Number.isSafeInteger(value.total) || value.total < 0 || typeof value.page !== 'number' ||
      !Number.isSafeInteger(value.page) || value.page !== page || value.data.length > value.total ||
      (value.page_size !== undefined && (typeof value.page_size !== 'number' ||
        !Number.isSafeInteger(value.page_size) || value.page_size < 1)))
    throw new Error('CRM list response has invalid pagination.');
  const ids = new Set();
  const data = value.data.map((row) => {
    let id;
    if (entity === 'accounts') { assertAccount(row); id = row.account_id; }
    else { assertContact(row); id = row.contact_id; }
    if (ids.has(id)) throw new Error('CRM list response contains a duplicate record ID.');
    ids.add(id);
    return row;
  });
  return { data, page: value.page, total: value.total,
    ...(typeof value.page_size === 'number' ? { page_size: value.page_size } : {}) };
}
/** @param {string} token @param {typeof fetch} [fetcher] */
export function crmClient(token, fetcher = fetch) {
  if (typeof window !== 'undefined') throw new Error('CRM client is available only on the server.');
  if (typeof token !== 'string' || !token.trim())
    throw new Error('CRM_TOKEN is not configured on the server.');
  /** @param {string} path @param {string} [method] @param {unknown} [body] @returns {Promise<unknown>} */
  const request = async (path, method = 'GET', body) => {
    // Keep even the low-level compatibility helper on the fixed documented API.
    const isCollection = /^\/(accounts|contacts)(?:\?[^#]*)?$/.test(path),
      isRecord = /^\/(accounts|contacts)\/[^/?#\\]+$/.test(path);
    if (!(
      (method === 'GET' && (isCollection || isRecord || path === '/me')) ||
      (method === 'POST' && /^\/(accounts|contacts)$/.test(path)) ||
      (method === 'PATCH' && isRecord)
    ))
      throw new Error('Unsupported CRM operation.');
    if (new URL(ORIGIN + '/api/v1' + path).pathname !== '/api/v1' + path.split('?')[0])
      throw new Error('Unsupported CRM operation.');
    let response;
    try {
      // Workerd requires manual redirects. The non-2xx check below rejects
      // every redirect without forwarding credentials or repeating a write.
      response = await fetcher(ORIGIN + '/api/v1' + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(
        `CRM ${method} request did not complete. ${method === 'GET' ? 'Retry a read when available.' : 'Outcome may be uncertain; no automatic write retry.'}`
      );
    }
    if (!response.ok)
      throw new Error(`CRM ${method} returned HTTP ${response.status}. No automatic write retry.`);
    try {
      return withoutCredential(await response.json(), token);
    } catch {
      throw new Error(
        `CRM ${method} returned invalid JSON. ${method === 'GET' ? 'Retry a read when available.' : 'Outcome may be uncertain; no automatic write retry.'}`
      );
    }
  };
  /** @param {AccountFilters} [filters] */
  const listAccounts = async (filters = {}) =>
    readPage(await request('/accounts?' + query(filters, ACCOUNT_FILTERS, 'account')), 'accounts', filters.page ?? 1);
  /** @param {ContactFilters} [filters] */
  const listContacts = async (filters = {}) =>
    readPage(await request('/contacts?' + query(filters, CONTACT_FILTERS, 'contact')), 'contacts', filters.page ?? 1);
  /** @param {string} id */
  const getAccount = async (id) => {
    const a = await request('/accounts/' + identifier(id));
    const account = record(a) && a.data != null ? a.data : a;
    assertAccount(account);
    if (account.account_id !== id) throw new Error('CRM account response does not match the requested record ID.');
    return account;
  };
  /** @param {string} id */
  const getContact = async (id) => {
    const c = await request('/contacts/' + identifier(id));
    const contact = record(c) && c.data != null ? c.data : c;
    assertContact(contact);
    if (contact.contact_id !== id) throw new Error('CRM contact response does not match the requested record ID.');
    return contact;
  };
  /** @param {AccountFields} values */
  const createAccount = async (values) =>
    acknowledgement(await request('/accounts', 'POST', fields(values, ACCOUNT_FIELDS, 'account')), 'account_id');
  /** @param {string} id @param {AccountFields} values */
  const patchAccount = async (id, values) =>
    request('/accounts/' + identifier(id), 'PATCH', fields(values, ACCOUNT_FIELDS, 'account'));
  /** @param {ContactFields} values */
  const createContact = async (values) =>
    acknowledgement(await request('/contacts', 'POST', fields(values, CONTACT_FIELDS, 'contact')), 'contact_id');
  /** @param {string} id @param {ContactFields} values */
  const patchContact = async (id, values) =>
    request('/contacts/' + identifier(id), 'PATCH', fields(values, CONTACT_FIELDS, 'contact'));
  return {
    request,
    listAccounts,
    getAccount,
    createAccount,
    patchAccount,
    listContacts,
    getContact,
    createContact,
    patchContact,
    me: () => request('/me'),
    accounts: async () => (await paginate(request, 'accounts')).map((row) => { assertAccount(row); return row; }),
    contacts: async () => (await paginate(request, 'contacts')).map((row) => { assertContact(row); return row; }),
    get: getAccount,
    patch: patchAccount,
    create: createAccount,
  };
}
/** @param {Pick<import('./execution-types').CrmClient,'accounts'|'contacts'>} client @returns {Promise<import('./domain-types').Snapshot>} */
export async function snapshot(client) {
  const [web, accounts, contacts] = await Promise.all([
    crawl(),
    client.accounts(),
    client.contacts(),
  ]);
  return { ...web, accounts, contacts, retrieved_at: new Date().toISOString() };
}
