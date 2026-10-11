// @ts-check
/** Read-only checks across the complete CRM snapshot. Every write is an explicit option. */
import { businessAccount, canonical, digest, facilityMaterial, norm, streetKey } from './core.mjs';

/** @typedef {import('./domain-types').Account} Account */
/** @typedef {import('./domain-types').Contact} Contact */
/** @typedef {import('./domain-types').Proposal} Proposal */
/** @typedef {import('./domain-types').ProposalOption} ProposalOption */
/** @typedef {import('./domain-types').Operation} Operation */
/** @typedef {import('./domain-types').Snapshot} Snapshot */
/** @typedef {'account_overlap'|'duplicate'|'relationship'|'billing'|'shared_email'|'retired_contact'|'orphan_contact'|'website_fields'} QualityCategory */
/** @typedef {{category:QualityCategory,title:string,detail:string,guidance:string,contacts:Contact[]}} QualityEvidence */
/** @typedef {Omit<Proposal, 'kind'> & {kind:'crm_quality',quality:QualityEvidence}} QualityProposal */
const RULE = 'crm-quality-v1';
const CARE = new Map([
  ['Short-Term Rehabilitation & Nursing', 'Skilled Nursing'],
  ['Assisted Living', 'Assisted Living'], ['Memory Support', 'Memory Care'],
  ['Independent Living', 'Independent Living'],
]);
/** @param {unknown} value */
const phoneKey = (value) => String(value ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
/** @param {unknown} value */
const number = (value) => typeof value === 'number' ? value :
  typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;
/** @param {Account} a */
const validBilling = (a) => Number.isFinite(number(a.lifetime_revenue)) && number(a.lifetime_revenue) >= 0 && Number.isFinite(number(a.outstanding_ar));
/** @param {Account} a */
const current = (a) => a.status !== 'Inactive' && !a.chow_current_account && !a.duplicate_of_account;
/** @param {Account} a */
const historical = (a) => !!(a.chow_current_account || a.duplicate_of_account);
/** @param {Account} a */
const physicalKey = (a) => {
  const street = streetKey(a.billing_street), city = norm(a.billing_city), state = norm(a.billing_state);
  return street && /\d/.test(street) && !/^p\s*o\s*box\b/.test(street) && city && state
    ? canonical([street, city, state]) : null;
};
/** Preserve earlier review annotations when adding or replacing this case's note.
 * @param {unknown} note @param {string} key @param {string} detail
 */
const annotatedNote = (note, key, detail) => [
  ...String(note ?? '').split('\n').filter((line) => !line.startsWith(`[crm-quality:${key}]`)),
  `[crm-quality:${key}] ${detail}`,
].filter(Boolean).join('\n');
/** @param {Account} a */
const accountMaterial = (a) => businessAccount(a);
/** @param {Contact} c */
const contactMaterial = ({ updated_at, created_by_candidate, ...c }) => c;
/** @template {{account_id:string}} T @param {T[]} records */
const sortAccounts = (records) => [...records].sort((a, b) => a.account_id.localeCompare(b.account_id));
/** @param {Contact[]} records */
const sortContacts = (records) => [...records].sort((a, b) => a.contact_id.localeCompare(b.contact_id));
/** @param {Account[]} accounts */
const ids = (accounts) => sortAccounts(accounts).map((a) => a.account_id).join(':');
/** @param {string} label @returns {ProposalOption} */
const acknowledge = (label = 'Record review; leave CRM unchanged') => ({
  id: 'acknowledge', label, reason: 'Save this decision against the current evidence. New material evidence will create a fresh review.',
  operations: [], field_choices: {},
});

/** Builds immutable proposals; does not fetch data, modify the snapshot, or write to CRM.
 * @param {Snapshot} snapshot
 * @param {Proposal[]} facilityProposals Current Bellhaven reconciliation, used to avoid duplicate cases.
 * @param {Map<string, Set<'phone'|'care_type'>>} reviewedFields Previously approved unchanged field selections.
 * @returns {Promise<QualityProposal[]>}
 */
export async function crmQuality(snapshot, facilityProposals = [], reviewedFields = new Map()) {
  const accounts = sortAccounts(snapshot.accounts), contacts = sortContacts(snapshot.contacts);
  const byId = new Map(accounts.map((a) => [a.account_id, a]));
  const parent = facilityProposals[0]?.parent ?? accounts.find((a) => /^bellhaven senior living \(parent account\)$/i.test(a.name) && !a.parent_id);
  if (!parent) throw new Error('CRM quality checks require the resolved Bellhaven parent account.');
  /** @type {QualityProposal[]} */
  const result = [];
  const parentIds = new Set(accounts.map((a) => a.parent_id).filter(Boolean));
  for (const a of accounts) if (/\(parent account\)\s*$/i.test(a.name)) parentIds.add(a.account_id);
  const protectedIds = new Set(accounts.flatMap((a) => [a.chow_current_account, a.duplicate_of_account]).filter(Boolean));
  /** @param {Account[]} affected */
  const relevantContacts = (affected) => contacts.filter((c) => affected.some((a) => a.account_id === c.account_id));
  /** @param {Account} account */
  const candidate = (account) => ({ account, contacts: relevantContacts([account]), reasons: [], conflicts: [] });
  /** @param {{key:string,category:QualityCategory,title:string,detail:string,guidance:string,accounts:Account[],contacts?:Contact[],alternatives?:Account[],options?:ProposalOption[],facility?:import('./domain-types').Facility}} input */
  async function add(input) {
    const affected = sortAccounts(input.accounts), alternatives = sortAccounts(input.alternatives ?? []);
    const people = sortContacts([...new Map([...relevantContacts([...affected, ...alternatives]), ...(input.contacts ?? [])].map((c) => [c.contact_id, c])).values()]);
    /** @type {ProposalOption[]} */
    const options = input.options ?? [acknowledge()];
    const quality = { category: input.category, title: input.title, detail: input.detail, guidance: input.guidance, contacts: people };
    // A phone or billing correction does not change a contact-link review.
    // Executable account proposals retain the complete immutable before-image.
    /** @param {Account} account */
    function materialAccount(account) {
      if (!['shared_email', 'retired_contact', 'orphan_contact'].includes(input.category)) return accountMaterial(account);
      const { account_id, name, parent_id, status, chow_current_account, duplicate_of_account } = account;
      return { account_id, name, parent_id, status, chow_current_account, duplicate_of_account };
    }
    const material = {
      rule: RULE, key: input.key, category: input.category,
      accounts: affected.map(materialAccount), alternatives: alternatives.map(materialAccount),
      contacts: people.map(contactMaterial),
      facility: input.facility ? facilityMaterial(input.facility) : null,
      options: options.map(({ id, field_choices, operations }) => ({ id, field_choices, operations: operations.map(({ before, ...operation }) => operation) })),
    };
    const version = await digest(material);
    result.push({
      key: input.key, title: input.title, kind: 'crm_quality', summary: input.detail,
      city: affected[0]?.billing_city, state: affected[0]?.billing_state,
      facility: input.facility ?? null, parent: /** @type {Account} */ (parent),
      candidates: affected.map(candidate), alternatives: alternatives.map(candidate),
      options, quality, material, id: version, version,
    });
  }
  /** @param {Account[]} affected @param {string} key @param {string} detail @returns {ProposalOption[]} */
  function flagOptions(affected, key, detail) {
    const editable = affected.filter((a) => !historical(a) && a.status !== 'Inactive' && !parentIds.has(a.account_id));
    /** @type {Operation[]} */
    const operations = editable.map((a) => ({
      type: 'patch', account_id: a.account_id, before: a,
      fields: { status: 'Needs Review', note: annotatedNote(a.note, key, detail) },
    }));
    return [
      ...(operations.length ? [{ id: 'flag', label: `Flag ${operations.length === 1 ? `${editable[0].name} (${editable[0].account_id})` : `${operations.length} accounts`} for review`, reason: 'Add a factual review note and set Needs Review. Keep ownership, addresses, billing and contacts unchanged.', operations, field_choices: {} }] : []),
      acknowledge(),
    ];
  }

  const locationGroups = new Map();
  for (const a of accounts.filter((a) => current(a) && !parentIds.has(a.account_id))) {
    const key = physicalKey(a);
    if (key) locationGroups.set(key, [...(locationGroups.get(key) ?? []), a]);
  }
  /** @param {Account} account */
  function validParentChain(account) {
    const seen = new Set([account.account_id]);
    let target = account.parent_id;
    while (target) {
      const record = byId.get(target);
      if (!record || seen.has(target) || !current(record)) return false;
      seen.add(target);
      target = record.parent_id;
    }
    return true;
  }
  for (const group of /** @type {Account[][]} */ ([...locationGroups.values()])) {
    if (group.length < 2) continue;
    const covered = facilityProposals.some((p) => ['duplicate', 'ambiguous'].includes(p.kind) && group.every((a) => p.candidates.some((c) => c.account.account_id === a.account_id)));
    if (covered) continue;
    /** @param {Account} a */
    const exact = (a) => canonical([norm(a.name), physicalKey(a), norm(a.billing_zip), phoneKey(a.phone), a.parent_id ?? '', norm(a.care_type)]);
    const exactGroup = group.every((a) => exact(a) === exact(group[0])) &&
      !!norm(group[0].name) && /^\d{5}(?:[- ]?\d{4})?$/.test(String(group[0].billing_zip ?? '')) && /^\d{10}$/.test(phoneKey(group[0].phone)) &&
      group.every((a) => a.status === 'Active' && !!a.parent_id && validBilling(a) && number(a.outstanding_ar) >= 0 && !protectedIds.has(a.account_id) && validParentChain(a));
    const billed = group.filter((a) => number(a.lifetime_revenue) !== 0 || number(a.outstanding_ar) !== 0);
    const contactBearing = group.filter((a) => relevantContacts([a]).length > 0);
    const survivor = billed.length === 1 ? billed[0] : contactBearing.length === 1 ? contactBearing[0] : group[0];
    const losers = group.filter((a) => a.account_id !== survivor.account_id);
    const safeDuplicate = exactGroup && billed.length <= 1 && losers.every((a) => number(a.lifetime_revenue) === 0 && number(a.outstanding_ar) === 0 && relevantContacts([a]).length === 0);
    const key = `quality:account-overlap:${ids(group)}`;
    const sameParent = new Set(group.map((a) => a.parent_id ?? '')).size === 1;
    const detail = safeDuplicate
      ? 'These current accounts have the same normalized name, full address, phone, care category and parent. The proposed retired copies have no billing balances or contacts.'
      : `These current accounts share a physical address${sameParent ? '' : ' but have different parents'}. An address alone does not establish a duplicate or ownership transfer.`;
    const options = flagOptions(group, key, detail);
    options[options.length - 1] = acknowledge('Keep these accounts separate');
    if (safeDuplicate) options.unshift({
      id: `consolidate:${survivor.account_id}`,
      label: `Keep ${survivor.name} (${survivor.account_id}); retire ${losers.map((a) => a.account_id).join(', ')}`,
      reason: `${billed.length ? 'Keep the account with billing history.' : contactBearing.length ? 'Keep the account with contacts.' : 'Evidence is equal; the stable account ID breaks the tie.'} Retired copies keep their original data and link to this survivor.`,
      operations: losers.map((a) => ({ type: 'duplicate', account_id: a.account_id, before: a, fields: { status: 'Inactive', duplicate_of_account: survivor.account_id } })),
    });
    await add({ key, category: safeDuplicate ? 'duplicate' : 'account_overlap', title: `${group[0].billing_city}: ${group.length} accounts at one address`, detail, guidance: safeDuplicate ? 'Confirm the account IDs before consolidating. No balances or contacts move.' : 'Confirm facility identity and ownership before changing relationships. You can flag the accounts or retain them as separate records.', accounts: group, options });
  }

  /** @type {Set<string>} */
  const seenRelationships = new Set();
  /** @param {string} code @param {Account[]} affected @param {string} detail */
  async function relationship(code, affected, detail) {
    const key = `quality:relationship:${code}:${ids(affected)}`;
    if (seenRelationships.has(key)) return;
    seenRelationships.add(key);
    await add({ key, category: 'relationship', title: 'Account relationship needs verification', detail, guidance: 'Confirm the intended account relationship with the owner. No parent or historical link is changed by this review.', accounts: affected, options: [acknowledge()] });
  }
  for (const a of accounts) {
    for (const field of /** @type {const} */ (['parent_id', 'chow_current_account', 'duplicate_of_account'])) {
      const target = a[field];
      if (target && !byId.has(target)) await relationship(`missing-${field}`, [a], `${a.name} (${a.account_id}) has ${field} pointing to missing account ${target}.`);
    }
    if (a.chow_current_account && a.duplicate_of_account && a.chow_current_account !== a.duplicate_of_account) {
      await relationship('conflicting-history', [a, ...accounts.filter((x) => x.account_id === a.chow_current_account || x.account_id === a.duplicate_of_account)], `${a.name} (${a.account_id}) has different CHOW and duplicate targets. Confirm which account is current.`);
    }
    for (const mode of /** @type {const} */ (['parent', 'history'])) {
      /** @type {Account[]} */
      const path = [];
      /** @type {Account | undefined} */
      let next = a;
      while (next) {
        const index = path.findIndex((x) => x.account_id === next?.account_id);
        if (index >= 0) {
          const cycle = path.slice(index);
          await relationship(`${mode}-cycle`, cycle, `${mode === 'parent' ? 'Parent' : 'CHOW/duplicate'} links form a cycle between ${sortAccounts(cycle).map((x) => `${x.name} (${x.account_id})`).join(', ')}.`);
          break;
        }
        path.push(next);
        const target = mode === 'parent' ? next.parent_id : next.chow_current_account || next.duplicate_of_account;
        if (!target) {
          if (mode === 'history' && path.length > 1 && next.status === 'Inactive') await relationship('inactive-target', path, `${a.name} (${a.account_id}) links to inactive ${next.name} (${next.account_id}) without a current replacement.`);
          break;
        }
        next = byId.get(target);
      }
    }
    if (!validBilling(a)) {
      const key = `quality:billing:${a.account_id}`;
      await add({ key, category: 'billing', title: `${a.name}: verify billing values`, detail: `Revenue or AR on ${a.account_id} is missing, invalid, or has negative lifetime revenue. Missing billing must not be treated as zero.`, guidance: 'Have billing verify the source values before any parent change or consolidation. A negative AR credit balance by itself is valid and is preserved.', accounts: [a], options: [acknowledge()] });
    }
  }

  /** @type {Map<string, Contact[]>} */
  const emailGroups = new Map(), retiredGroups = new Map(), orphanGroups = new Map();
  for (const c of contacts) {
    const a = byId.get(c.account_id);
    if (!a) orphanGroups.set(c.account_id || '(missing account)', [...(orphanGroups.get(c.account_id || '(missing account)') ?? []), c]);
    if (c.is_active !== false && a && (a.status === 'Inactive' || historical(a))) retiredGroups.set(a.account_id, [...(retiredGroups.get(a.account_id) ?? []), c]);
    const email = String(c.email ?? '').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) emailGroups.set(email, [...(emailGroups.get(email) ?? []), c]);
  }
  for (const [email, people] of emailGroups) {
    if (people.length < 2 || new Set(people.map((c) => norm(c.name)).filter(Boolean)).size < 2) continue;
    const affected = accounts.filter((a) => people.some((c) => c.account_id === a.account_id));
    await add({ key: `quality:shared-email:${email}`, category: 'shared_email', title: 'Different contacts share an email', detail: `${people.map((c) => `${c.name} (${c.contact_id})`).join(', ')} share ${email}. It may be a shared inbox or an incorrect contact field.`, guidance: 'Confirm the contact details with the account owner. This review does not edit, merge, or move contacts.', accounts: affected, contacts: people, options: [acknowledge()] });
  }
  for (const [accountId, people] of retiredGroups) {
    const a = /** @type {Account} */ (byId.get(accountId));
    /** @type {Account[]} */
    const linked = [];
    const seen = new Set([a.account_id]);
    let target = a.chow_current_account || a.duplicate_of_account;
    while (target && !seen.has(target)) {
      seen.add(target);
      const record = byId.get(target);
      if (!record) break;
      linked.push(record);
      target = record.chow_current_account || record.duplicate_of_account;
    }
    await add({ key: `quality:retired-contacts:${accountId}`, category: 'retired_contact', title: `${a.name}: contacts remain on an old account`, detail: `${people.length} contact${people.length === 1 ? '' : 's'} not marked inactive remain linked to ${accountId}, which is inactive or has a current-account link.`, guidance: 'Confirm where these people belong. Contact migration is a separate follow-up; account cleanup never moves contacts automatically.', accounts: [a], alternatives: linked, contacts: people, options: [acknowledge()] });
  }
  for (const [accountId, people] of orphanGroups) {
    await add({ key: `quality:orphan-contacts:${accountId}`, category: 'orphan_contact', title: 'Contacts point to a missing account', detail: `${people.length} contact${people.length === 1 ? '' : 's'} reference ${accountId}, which is absent from the complete CRM snapshot.`, guidance: 'Confirm the intended account before relinking contacts. No account is created and no contact is moved by this review.', accounts: [], contacts: people, options: [acknowledge()] });
  }

  for (const p of facilityProposals.filter((p) => p.kind === 'unchanged' && p.facility && p.candidates.length === 1)) {
    const f = /** @type {import('./domain-types').Facility} */ (p.facility), a = p.candidates[0].account;
    if (!current(a)) continue;
    const reviewed = reviewedFields.get(f.source_url);
    const phone = phoneKey(f.phone_raw), phoneDiff = !reviewed?.has('phone') && /^\d{10}$/.test(phone) && phone !== phoneKey(a.phone);
    const categories = [...new Set(f.care_offerings.map((offering) => CARE.get(offering)).filter((category) => category !== undefined))];
    const careDiff = !reviewed?.has('care_type') && categories.length > 0 && !categories.includes(a.care_type ?? '');
    if (!phoneDiff && !careDiff) continue;
    /** @type {ProposalOption[]} */
    const options = [];
    for (const care of [null, ...(careDiff ? categories : [])]) for (const selectPhone of phoneDiff ? [false, true] : [false]) {
      const fields = {
        ...(selectPhone ? { phone: f.phone_raw } : {}),
        ...(care ? { care_type: care, note: annotatedNote(a.note, 'website-care', `Website care offerings: ${f.care_offerings.join('; ')}. Source: ${f.source_url}`) } : {}),
      };
      const labels = [selectPhone ? 'Use website phone' : '', care ? `Set care category to ${care}` : ''].filter(Boolean);
      options.push({
        id: `website:phone-${selectPhone ? 'use' : 'keep'}:care-${care ?? 'keep'}`,
        label: labels.join(' and ') || 'Keep the current phone and care category',
        reason: care ? 'The CRM accepts one care category. Preserve the complete website list in the account note.' : selectPhone ? 'Use the phone published for this matched physical facility.' : 'Record this field selection so unchanged evidence is not proposed again.',
        field_choices: {
          ...(phoneDiff ? { phone: { current: a.phone ?? null, proposed: f.phone_raw, selected: selectPhone } } : {}),
          ...(careDiff ? { care_type: { current: a.care_type ?? null, values: categories, selected: care } } : {}),
        },
        operations: Object.keys(fields).length ? [{ type: 'patch', account_id: a.account_id, before: a, fields }] : [],
      });
    }
    await add({ key: `quality:website-fields:${f.source_url}`, category: 'website_fields', title: `${f.name}: website contact and care fields`, detail: 'This facility is already matched to the correct current account. The website differs on optional phone or supported care-category fields.', guidance: 'Choose the fields to update or retain the current values. Parent, address, billing and contacts remain unchanged.', accounts: [a], facility: f, options });
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}
