// @ts-check
/** Pure reconciliation rules. No network, database or CRM writes in this module. */
/** @typedef {import('./domain-types').Account} Account */
/** @typedef {import('./domain-types').AccountPatch} AccountPatch */
/** @typedef {import('./domain-types').Contact} Contact */
/** @typedef {import('./domain-types').Facility} Facility */
/** @typedef {import('./domain-types').Candidate} Candidate */
/** @typedef {import('./domain-types').SignalCandidate} SignalCandidate */
/** @typedef {import('./domain-types').Operation} Operation */
/** @typedef {import('./domain-types').ProposalOption} ProposalOption */
/** @typedef {import('./domain-types').ProposalDraft} ProposalDraft */
/** @typedef {import('./domain-types').Proposal} Proposal */
export const ORIGIN = 'https://analyst-assessment-production.up.railway.app';
/** @type {import('./domain-types').ProposalStatus[]} */
export const OPEN_PROPOSAL_STATUSES = ['pending', 'partial', 'applying', 'stale'];
const RULE_VERSION = 'bellhaven-v3';
/** @type {Readonly<Partial<Record<string, import('./domain-types').CareCategory>>>} */
const CARE = {
  'Short-Term Rehabilitation & Nursing': 'Skilled Nursing',
  'Assisted Living': 'Assisted Living',
  'Memory Support': 'Memory Care',
  'Independent Living': 'Independent Living',
};
/** @param {string} offering */
const careCategory = (offering) => Object.hasOwn(CARE, offering) ? CARE[offering] : undefined;
/** @param {unknown} value */
export const norm = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
/** @type {Readonly<Partial<Record<string, string>>>} */
const suffixes = {
  street: 'st',
  road: 'rd',
  avenue: 'ave',
  boulevard: 'blvd',
  drive: 'dr',
  lane: 'ln',
  court: 'ct',
  circle: 'cir',
  parkway: 'pkwy',
  pike: 'pk',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  northwest: 'nw',
  northeast: 'ne',
  southwest: 'sw',
  southeast: 'se',
};
/** @param {unknown} s */
export const streetKey = (s) =>
  norm(s)
    .split(' ')
    .map((t) => Object.hasOwn(suffixes, t) ? suffixes[t] : t)
    .join(' ');
/** @param {unknown} p */
const phoneKey = (p) =>
  String(p ?? '')
    .replace(/\D/g, '')
    .replace(/^1(?=\d{10}$)/, '');
/** @param {Facility} f @param {Account} a */
const sameLocality = (f, a) =>
  norm(f.city) === norm(a.billing_city) && norm(f.state) === norm(a.billing_state);
/** @param {Facility} f @param {Account} a */
const exactAddress = (f, a) =>
  sameLocality(f, a) && streetKey(f.street_address) === streetKey(a.billing_street);
/** @param {unknown} value */
const financialNumber = (value) =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())
      ? Number(value)
      : NaN;
/** @param {Account} a */
const billingKnown = (a) =>
  Number.isFinite(financialNumber(a.lifetime_revenue)) &&
  Number.isFinite(financialNumber(a.outstanding_ar));
/** Credit balances carry billing history too; only CHOW uses the positive-AR SOP.
 * @param {Account} a
 */
const hasBillingActivity = (a) =>
  (Number.isFinite(financialNumber(a.lifetime_revenue)) && Number(a.lifetime_revenue) !== 0) ||
  (Number.isFinite(financialNumber(a.outstanding_ar)) && Number(a.outstanding_ar) !== 0);
/** @param {Account} a @param {string | null | undefined} parent */
export function needsChow(a, parent) {
  if (a.parent_id === parent) return false;
  if (!billingKnown(a))
    throw new Error(
      'Billing fields are missing or invalid. Verify revenue and AR before changing the parent.'
    );
  return Number(a.lifetime_revenue) > 0 && Number(a.outstanding_ar) > 0;
}
/** @param {unknown} x */
export const canonical = (x) => JSON.stringify(sortObject(x));
/** @param {unknown} x @returns {unknown} */
function sortObject(x) {
  if (Array.isArray(x)) return x.map(sortObject);
  if (x && typeof x === 'object')
    return Object.fromEntries(
      Object.entries(x)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([k, value]) => [k, sortObject(value)])
    );
  return x;
}
/** @param {unknown} x */
export async function digest(x) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(x))))
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
/** @param {Account} a */
export function businessAccount(a) {
  const { updated_at, parent_name, created_by_candidate, ...rest } = a;
  return rest;
}
/** @param {Facility} f */
export function facilityMaterial(f) {
  const { retrieved_at_utc, source_file, directory_pages, linked_from_home, html_hash, ...rest } =
    f;
  return rest;
}
/** Older stored approvals remain valid only against their exact original evidence.
 * @param {{version: string, compatibility_version?: string} | null | undefined} proposal
 * @param {string | null | undefined} version
 */
export function evidenceMatches(proposal, version) {
  return !!proposal && typeof version === 'string' && version.length > 0 &&
    (proposal.version === version || proposal.compatibility_version === version);
}
/** @param {Account} a */
const active = (a) => !a.duplicate_of_account && !a.chow_current_account && a.status !== 'Inactive';
/** @param {Account[]} accounts @param {string} start @returns {import('./domain-types').AccountRoute} */
function followAccount(accounts, start) {
  const index = new Map(accounts.map((a) => [a.account_id, a]));
  /** @type {import('./domain-types').AccountRoute['chain']} */
  const chain = [];
  const seen = new Set();
  let id = start;
  while (id) {
    if (seen.has(id))
      return { status: 'conflict', reason: 'Account links form a cycle.', chain, current: null };
    seen.add(id);
    const a = index.get(id);
    if (!a)
      return {
        status: 'conflict',
        reason: 'Account link points to a missing record.',
        chain,
        current: null,
      };
    chain.push({
      account_id: a.account_id,
      name: a.name,
      parent_name: a.parent_name,
      status: a.status,
      lifetime_revenue: a.lifetime_revenue,
      outstanding_ar: a.outstanding_ar,
    });
    if (
      a.duplicate_of_account &&
      a.chow_current_account &&
      a.duplicate_of_account !== a.chow_current_account
    )
      return {
        status: 'conflict',
        reason: 'Duplicate and CHOW links disagree.',
        chain,
        current: null,
      };
    const next = a.chow_current_account || a.duplicate_of_account;
    if (!next)
      return a.status === 'Inactive'
        ? {
            status: 'conflict',
            reason: 'Account link ends at an inactive record without a current account.',
            chain,
            current: null,
          }
        : {
            status: 'resolved',
            current: a.account_id,
            chain,
            reason:
              chain.length > 1
                ? 'Explicit CRM links lead to the current account.'
                : 'Current account.',
          };
    id = next;
  }
  return { status: 'unresolved', current: null, chain, reason: 'No account selected.' };
}
/** @param {Facility} f @param {Account} a @param {Contact[]} contacts @param {string} parentId @returns {SignalCandidate} */
function signal(f, a, contacts, parentId) {
  const people = contacts.filter((c) => c.account_id === a.account_id && c.is_active);
  const sourcePhone = phoneKey(f.phone_raw),
    sourceAdministrator = norm(f.administrator);
  const address = exactAddress(f, a),
    locality = sameLocality(f, a),
    name = norm(f.name) === norm(a.name),
    phone = /^\d{10}$/.test(sourcePhone) && sourcePhone === phoneKey(a.phone);
  const administrator = !!sourceAdministrator && people.some(
    (c) => norm(c.name) === sourceAdministrator
  );
  const poBox = /^p\s*o\s*box\b/.test(norm(a.billing_street));
  const eligible = address || (poBox && locality && name && (phone || administrator));
  // Corroborated identity with a missing or conflicting address is a review
  // hold, never permission to copy a different street or create a second copy.
  const identityConflict = !eligible && (
    (locality && ((name && (phone || administrator)) || (phone && administrator))) ||
    (name && phone && !!streetKey(f.street_address) &&
      streetKey(f.street_address) === streetKey(a.billing_street))
  );
  // These are explicit evidence priorities, not probabilities.
  const priority =
    (hasBillingActivity(a) ? 100 : 0) +
    (a.parent_id === parentId ? 30 : 0) +
    (phone ? 12 : 0) +
    (administrator ? 10 : 0) +
    (name ? 5 : 0) +
    Math.min(people.length, 3);
  const reasons = [
    address ? 'Same normalized street and locality' : null,
    phone ? 'Same facility phone' : null,
    administrator ? 'Website administrator matches an active contact' : null,
    name ? 'Same normalized name' : null,
    poBox ? 'CRM contains a billing PO box' : null,
  ].filter((value) => value !== null);
  const conflicts = [
    !locality ? 'Different city or state' : null,
    !address && !poBox ? 'Different street address' : null,
    a.billing_zip !== f.postal_code ? 'ZIP differs' : null,
    !phone ? 'Phone differs' : null,
    !name ? 'Name differs' : null,
  ].filter((value) => value !== null);
  return {
    account: a,
    contacts: people,
    reasons,
    conflicts,
    priority,
    address,
    locality,
    name,
    phone,
    administrator,
    poBox,
    eligible,
    identityConflict,
  };
}
/** @param {Account | null | undefined} a @param {string} text */
function note(a, text) {
  return [a?.note, text].filter(Boolean).join('\n');
}
/** @param {Facility} f @param {string} parent @returns {AccountPatch} */
function createFields(f, parent) {
  return {
    name: f.name,
    parent_id: parent,
    billing_street: f.street_address,
    billing_city: f.city,
    billing_state: f.state,
    billing_zip: f.postal_code,
    care_type: f.care_offerings.map(careCategory).find(Boolean) ?? '',
    phone: f.phone_raw,
    status: 'Active',
    lifetime_revenue: 0,
    outstanding_ar: 0,
    note: `Website: ${f.source_url}. Care offerings: ${f.care_offerings.join('; ')}.`,
  };
}
/** @param {Facility} f @param {Account} a @param {string} parent @param {boolean} verifiedIdentity @returns {AccountPatch} */
function changes(f, a, parent, verifiedIdentity = false) {
  /** @type {AccountPatch} */
  const patch = {};
  const poBox = /^p\s*o\s*box\b/.test(norm(a.billing_street));
  if (a.name !== f.name) patch.name = f.name;
  if (a.parent_id !== parent) patch.parent_id = parent;
  // Spelling changes remain visible API proposals. Normalization only proves
  // formatting equivalence; it never authorizes replacing a PO box or guessing
  // a different physical location.
  if (verifiedIdentity && !poBox) {
    const addressFields = {
      billing_street: f.street_address,
      billing_city: f.city,
      billing_state: f.state,
      billing_zip: f.postal_code,
    };
    for (const field of /** @type {const} */ (['billing_street', 'billing_city', 'billing_state', 'billing_zip']))
      if (a[field] !== addressFields[field]) patch[field] = addressFields[field];
  } else if (
    exactAddress(f, a) &&
    a.billing_street !== f.street_address &&
    !poBox
  )
    patch.billing_street = f.street_address;
  if (!poBox && a.billing_zip !== f.postal_code)
    patch.billing_zip = f.postal_code;
  const categories = f.care_offerings.map(careCategory).filter((category) => category !== undefined);
  if (categories.length === 1 && !categories.some((category) => category === a.care_type)) patch.care_type = categories[0];
  const multi = `Care offerings: ${f.care_offerings.join('; ')}.`;
  const additions = [];
  if (
    (f.care_offerings.length > 1 || categories.length !== f.care_offerings.length) &&
    !(a.note ?? '').includes(multi)
  )
    additions.push(`${multi} Website: ${f.source_url}`);
  if (Object.hasOwn(patch, 'name'))
    additions.push(`Prior observed CRM name (not a verified official alias): ${a.name}`);
  if (Object.hasOwn(patch, 'billing_street') ||
      (verifiedIdentity && ['billing_city', 'billing_state', 'billing_zip'].some((key) =>
        Object.hasOwn(patch, key))))
    additions.push(
      `Prior observed CRM billing address (not a verified official alias): ${a.billing_street}, ${a.billing_city}, ${a.billing_state} ${a.billing_zip}`
    );
  if (additions.length) patch.note = note(a, additions.join('\n'));
  // A website match establishes identity, not the reason for a review hold.
  // Keep Needs Review until a separate reviewed status change clears it, even
  // if freeform notes also contain an earlier website-absence observation.
  if (verifiedIdentity && a.status === 'Inactive') patch.status = 'Active';
  if (verifiedIdentity && !Object.keys(patch).length)
    patch.note = note(a, `Facility identity confirmed through approved review. Website: ${f.source_url}. Conflicting CRM evidence is retained in the decision history; other accounts were not consolidated.`);
  return patch;
}
/** @param {Facility} f @param {Candidate} survivor @param {Candidate[]} candidates @param {string} parent @param {boolean} verifiedIdentity @returns {ProposalOption} */
function option(f, survivor, candidates, parent, verifiedIdentity = false) {
  const a = survivor.account;
  /** @type {Operation[]} */
  const ops = [];
  const patch = changes(f, a, parent, verifiedIdentity),
    chow = needsChow(a, parent);
  if (chow)
    ops.push({
      type: 'chow',
      account_id: a.account_id,
      before: a,
      fields: createFields(f, parent),
    });
  else if (Object.keys(patch).length)
    ops.push({ type: 'patch', account_id: a.account_id, before: a, fields: patch });
  for (const candidate of candidates.filter((c) => c.account.account_id !== a.account_id)) {
    const loser = candidate.account;
    // Billing-bearing accounts cannot safely be collapsed based only on a shared address.
    if (
      !billingKnown(loser) ||
      hasBillingActivity(loser)
    )
      continue;
    ops.push({
      type: 'duplicate',
      account_id: loser.account_id,
      before: loser,
      fields: {
        status: 'Inactive',
        duplicate_of_account: chow ? '$replacement' : a.account_id,
        note: note(
          loser,
          `Duplicate at ${f.street_address}, ${f.city}. Survivor selected using billing history, Bellhaven affiliation, phone, administrator and contacts. Website: ${f.source_url}`
        ),
      },
    });
  }
  return {
    id: a.account_id,
    label: a.name,
    reason: `${survivor.reasons.join('; ')}. ${survivor.contacts.length} active contact(s). ${a.parent_id === parent ? 'Already linked to Bellhaven.' : ''} Revenue ${a.lifetime_revenue}; AR ${a.outstanding_ar}.`,
    operations: ops,
  };
}
/** @param {Facility} f @param {Candidate[]} candidates @param {string} parent @param {Set<string>} sharedIds @returns {ProposalOption[]} */
function judgmentOptions(f, candidates, parent, sharedIds) {
  return [
    {
      id: 'separate',
      resolution: 'separate',
      label: 'Create a separate facility account',
      reason: 'Choose only after verifying this website location is a separate facility. Every existing account, parent, balance and contact stays unchanged.',
      operations: [{ type: 'create', fields: createFields(f, parent) }],
    },
    ...candidates.filter((c) => !sharedIds.has(c.account.account_id)).map(/** @returns {ProposalOption} */ (c) => {
      const choice = option(f, c, [c], parent, true);
      const a = c.account;
      const chow = choice.operations.some((op) => op.type === 'chow');
      const inactive = a.status === 'Inactive'
        ? chow ? ' · Preserve inactive history with CHOW' : ' · Reactivate'
        : '';
      return {
        ...choice,
        id: `existing:${a.account_id}`,
        resolution: 'existing',
        account_id: a.account_id,
        label: `Use existing account: ${a.name} · ${[a.billing_city, a.billing_state].filter(Boolean).join(', ') || 'Locality missing'} · ${a.account_id}${inactive}`,
        reason: `Choose only after verifying this record is the same facility despite the conflicting evidence. ${chow ? 'Billing history and unpaid AR require a replacement; the old account receives only the CHOW link.' : 'Apply the displayed identity and parent corrections; preserve billing PO boxes, balances and contacts.'} Other accounts remain unchanged. ${choice.reason}`,
      };
    }),
  ];
}
/** @param {import('./domain-types').Snapshot} snapshot @returns {Promise<Proposal[]>} */
export async function reconcile(snapshot) {
  const { facilities, coverage } = snapshot;
  // Pagination order is transport detail, not new evidence. Sort only record
  // sets: operation sequences and account-link chains retain their meaning.
  // Sorting before ranking also makes a tied alternatives cutoff deterministic.
  const accounts = [...snapshot.accounts].sort((a, b) => a.account_id.localeCompare(b.account_id));
  const contacts = [...snapshot.contacts].sort((a, b) => a.contact_id.localeCompare(b.contact_id));
  const parents = accounts.filter(
    (a) => /^bellhaven senior living \(parent account\)$/i.test(a.name) && !a.parent_id
  );
  if (parents.length !== 1) throw new Error('Expected one unambiguous Bellhaven parent account.');
  if (!active(parents[0]))
    throw new Error('Bellhaven parent is inactive or historical. Verify its current account before refreshing or approving facility changes.');
  const parent = parents[0];
  /** @type {Proposal[]} */
  const cases = [];
  const touched = new Set();
  // Parent entities are never facility candidates, even if they contain a
  // mailing address or a phone shared with a facility.
  const parentIds = new Set(accounts.map((a) => a.parent_id).filter(Boolean));
  for (const a of accounts)
    if (/\(parent account\)\s*$/i.test(a.name)) parentIds.add(a.account_id);
  const locationEvidence = facilities.map((facility) => ({
    facility,
    evidence: accounts
      .filter((a) => !parentIds.has(a.account_id))
      .map((a) => signal(facility, a, contacts, parent.account_id)),
  }));
  /** @type {Map<string, Map<string, Facility>>} */
  const accountLocations = new Map();
  for (const { facility, evidence } of locationEvidence)
    for (const s of evidence.filter((s) =>
      !s.account.chow_current_account && !s.account.duplicate_of_account &&
      (s.eligible || s.identityConflict))) {
      const locations = accountLocations.get(s.account.account_id) ?? new Map();
      locations.set(facility.source_url, facility);
      accountLocations.set(s.account.account_id, locations);
    }
  for (const { facility: f, evidence: allEvidence } of locationEvidence) {
    const evidence = allEvidence.filter((s) => active(s.account));
    const candidates = evidence
      .filter((s) => s.eligible)
      .sort(
        (a, b) =>
          b.priority - a.priority || a.account.account_id.localeCompare(b.account.account_id)
      );
    // Historical links are evidence too. A broken link must not make a known location look new.
    const linkedAccounts = allEvidence
      .filter(
        (s) => (s.eligible || s.identityConflict || (!candidates.length && s.name)) &&
          (s.account.chow_current_account || s.account.duplicate_of_account)
      )
      .map((s) => ({ ...s, route: followAccount(accounts, s.account.account_id) }));
    const linkConflicts = linkedAccounts
      .filter(
        (s) =>
          s.route.status !== 'resolved' ||
          !candidates.some((c) => c.account.account_id === s.route.current)
      )
      .map((s) => ({
        ...s,
        conflicts: [
          ...s.conflicts,
          s.route.status === 'resolved'
            ? 'Linked account does not resolve to an active candidate at this facility.'
            : s.route.reason,
        ],
      }));
    const addressConflicts = evidence.filter((s) => s.identityConflict);
    // An exact name elsewhere may be a separate business or an outdated
    // address. With no physical match, require identity review before creating
    // another account. It must not displace an independently verified match.
    const nameConflicts = candidates.length
      ? []
      : evidence.filter((s) => s.name && !s.eligible && !s.identityConflict);
    const inactiveMatches = allEvidence.filter((s) =>
      s.account.status === 'Inactive' && !s.account.chow_current_account &&
      !s.account.duplicate_of_account &&
      (s.eligible || s.identityConflict || (!candidates.length && s.name))
    );
    const judgmentCandidates = [...new Map([
      ...candidates, ...addressConflicts, ...nameConflicts, ...inactiveMatches,
    ].map((s) => [s.account.account_id, s])).values()]
      .sort((a, b) => a.account.account_id.localeCompare(b.account.account_id));
    const sharedMatches = judgmentCandidates.filter((s) =>
      [...(accountLocations.get(s.account.account_id)?.keys() ?? [])]
        .some((url) => url !== f.source_url)
    );
    /** @type {import('./domain-types').MatchingConflict[]} */
    const matchingConflicts = [
      ...addressConflicts.map(/** @returns {import('./domain-types').MatchingConflict} */ (s) => ({
        kind: 'address_conflict', account_id: s.account.account_id,
        message: 'Name, phone or administrator evidence overlaps, but the physical address needs verification.',
      })),
      ...nameConflicts.map(/** @returns {import('./domain-types').MatchingConflict} */ (s) => ({
        kind: 'name_collision', account_id: s.account.account_id,
        message: 'An existing account has the exact same name but a conflicting or missing address. Verify whether these are separate facilities before creating or re-parenting an account.',
      })),
      ...inactiveMatches.map(/** @returns {import('./domain-types').MatchingConflict} */ (s) => ({
        kind: 'inactive_account', account_id: s.account.account_id,
        message: 'An inactive account matches this location but has no verified current-account link.',
      })),
      ...sharedMatches.map(/** @returns {import('./domain-types').MatchingConflict} */ (s) => ({
        kind: 'shared_account', account_id: s.account.account_id,
        message: 'This CRM account also matches another website location.',
        facilities: [...(accountLocations.get(s.account.account_id)?.values() ?? [])]
          .sort((a, b) => a.source_url.localeCompare(b.source_url)).map(facilityMaterial),
      })),
    ];
    const importantAlternatives = [
      ...linkConflicts, ...addressConflicts, ...nameConflicts, ...inactiveMatches,
    ];
    const importantIds = new Set(importantAlternatives.map((s) => s.account.account_id));
    const alternatives = [
      ...new Map(importantAlternatives.map((s) => [s.account.account_id, s])).values(),
      ...evidence
        .filter((s) => !s.eligible && !importantIds.has(s.account.account_id) &&
          (s.locality || s.name || s.phone || s.administrator))
        .sort(
          (a, b) =>
            b.priority - a.priority || a.account.account_id.localeCompare(b.account.account_id)
        )
        .slice(0, 8),
    ];
    candidates.forEach((c) => touched.add(c.account.account_id));
    // A credible identity conflict is not website absence. Keep one unresolved
    // case instead of also proposing that the same account be marked absent.
    addressConflicts.forEach((c) => touched.add(c.account.account_id));
    nameConflicts.forEach((c) => touched.add(c.account.account_id));
    /** @type {import('./domain-types').ProposalKind} */
    let kind = 'unchanged';
    let summary = 'Website and CRM agree on the fields in scope.';
    /** @type {ProposalOption[]} */
    let options = [];
    if (linkConflicts.length) {
      kind = 'ambiguous';
      summary =
        'A related historical account has a broken, conflicting, or misplaced current-account link. Repair and verify the link before creating an account or consolidating records.';
    } else if (
      judgmentCandidates.some((c) => !billingKnown(c.account)) &&
      (matchingConflicts.length || candidates.length > 1 ||
        candidates.some((c) => c.account.parent_id !== parent.account_id))
    ) {
      kind = 'ambiguous';
      summary =
        'Billing fields are missing or invalid. Verify lifetime revenue and outstanding AR before resolving this account identity or creating a separate account.';
    } else if (matchingConflicts.length) {
      kind = 'ambiguous';
      summary = sharedMatches.length
        ? 'A CRM account matches multiple website locations. Verify separate facility identities before changing or creating an account.'
        : inactiveMatches.length
          ? 'An inactive account already matches this location. Verify its history before restoring it or creating another account.'
          : addressConflicts.length
            ? 'Other identity evidence points to an existing account, but its address conflicts or is missing. Verify the physical location before changing or creating an account.'
            : 'An account with the exact same name exists at a conflicting or missing address. Verify whether these are separate facilities before creating or re-parenting an account.';
      options = judgmentOptions(f, judgmentCandidates, parent.account_id,
        new Set(sharedMatches.map((s) => s.account.account_id)));
    } else if (!candidates.length) {
      kind = 'new_account';
      summary =
        'No account matches this physical location. Similar names and conflicting addresses remain separate.';
      options = [
        {
          id: 'create',
          label: 'Create facility account',
          operations: [{ type: 'create', fields: createFields(f, parent.account_id) }],
        },
      ];
    } else {
      const tied = candidates.length > 1 && candidates[0].priority === candidates[1].priority;
      const billingConflict =
        candidates.filter(
          (c) => hasBillingActivity(c.account)
        ).length > 1;
      options = (tied ? candidates : [candidates[0]]).map((c) =>
        option(f, c, candidates, parent.account_id)
      );
      const ops = options[0].operations;
      if (tied || billingConflict) {
        kind = 'ambiguous';
        summary = billingConflict
          ? 'Multiple accounts carry billing history. Verify which record represents this facility, or whether a separate account is needed. Other billing accounts will remain unchanged.'
          : 'Several accounts share the location without enough corroboration to choose a unique survivor. Reviewer selection and rationale are required.';
        if (billingConflict)
          options = judgmentOptions(f, judgmentCandidates, parent.account_id, new Set());
      } else if (ops.some((o) => o.type === 'chow')) {
        kind = 'chow';
        summary =
          'Revenue history and unpaid AR require a replacement account. The old parent and balances stay intact.';
      } else if (candidates.length > 1) {
        kind = 'duplicate';
        summary =
          'Several active CRM accounts describe the same location. Keep the strongest supported account and retire the duplicate copies.';
      } else if (ops.some((o) => o.fields.parent_id)) {
        kind = 'parent_correction';
        summary =
          'The physical location matches. The parent can be updated directly because the CHOW billing condition is not met.';
      } else if (ops.length) {
        kind = 'field_correction';
        summary =
          'The location is matched; update the highlighted fields to the current website evidence.';
      }
      if (candidates.length > 1 && !billingConflict) {
        // A supported survivor need not establish that every colocated account
        // is a duplicate. Let the reviewer update that account independently.
        const survivors = tied ? candidates : [candidates[0]];
        options.push(...survivors.map(/** @returns {ProposalOption} */ (candidate) => {
          const choice = option(f, candidate, [candidate], parent.account_id, true);
          const account = candidate.account;
          const chow = choice.operations.some((op) => op.type === 'chow');
          return {
            ...choice,
            id: `existing:${account.account_id}`,
            resolution: 'existing',
            account_id: account.account_id,
            label: `Update ${account.name} only; keep other accounts · ${account.account_id}`,
            reason: `Choose when this account represents the facility but retiring the other copies is not justified. ${chow ? 'Billing history and unpaid AR require a replacement; only the CHOW link changes on this original account.' : 'Apply only the displayed corrections to this account.'} Other accounts, their balances and contacts remain unchanged. Explain why the other copies should remain.`,
          };
        }));
      }
    }
    /** @type {ProposalDraft} */
    const row = {
      key: f.source_url,
      title: f.name,
      city: f.city,
      state: f.state,
      kind,
      summary,
      facility: f,
      candidates,
      alternatives,
      linked_accounts: linkedAccounts,
      link_conflicts: linkConflicts,
      ...(matchingConflicts.length ? { matching_conflicts: matchingConflicts } : {}),
      options,
      parent,
    };
    cases.push(await finalize(row));
  }
  if (coverage.complete)
    for (const a of accounts.filter(
      (a) => !parentIds.has(a.account_id) && a.parent_id === parent.account_id &&
        active(a) && !touched.has(a.account_id)
    )) {
      if (a.status === 'Needs Review' && (a.note ?? '').includes('[website-absence]')) continue;
      cases.push(
        await finalize({
          key: `absent:${a.account_id}`,
          title: a.name,
          city: a.billing_city,
          state: a.billing_state,
          kind: 'absent',
          summary:
            'Not found in the complete current website crawl. Absence alone does not establish a sale or closure.',
          facility: null,
          candidates: [
            {
              account: a,
              contacts: contacts.filter((c) => c.account_id === a.account_id),
              reasons: [],
              conflicts: [],
            },
          ],
          alternatives: accounts
            .filter(
              (b) =>
                b.account_id !== a.account_id &&
                streetKey(b.billing_street) === streetKey(a.billing_street) &&
                norm(b.billing_city) === norm(a.billing_city) &&
                b.billing_state === a.billing_state
            )
            .map((account) => ({
              account,
              contacts: [],
              reasons: ['Same address, ownership unverified'],
              conflicts: [],
            })),
          options: [
            {
              id: 'review',
              label: 'Flag for verification',
              operations: [
                {
                  type: 'patch',
                  account_id: a.account_id,
                  before: a,
                  fields: {
                    status: 'Needs Review',
                    note: note(
                      a,
                      '[website-absence] Not listed in the complete Bellhaven website crawl. Verify current affiliation; no new owner or closure inferred.'
                    ),
                  },
                },
              ],
            },
          ],
          parent,
          coverage: { urls: coverage.urls, expected: coverage.expected, found: coverage.found },
        })
      );
    }
  return cases;
}
/** @param {ProposalDraft} row @returns {Promise<Proposal>} */
async function finalize(row) {
  const material = {
    rule: RULE_VERSION,
    key: row.key,
    kind: row.kind,
    facility: row.facility ? facilityMaterial(row.facility) : null,
    candidates: row.candidates.map((c) => ({
      account: businessAccount(c.account),
      contacts: c.contacts.map(({ updated_at, ...c }) => c),
    })),
    alternatives: row.alternatives.map((c) => businessAccount(c.account)),
    linked_accounts: (row.linked_accounts ?? []).map((c) => ({
      account: businessAccount(c.account),
      route: c.route,
    })),
    options: row.options.map((o) => ({
      id: o.id,
      ...(o.resolution ? { resolution: o.resolution, account_id: o.account_id } : {}),
      operations: o.operations.map(({ before, ...op }) => op),
    })),
    parent: businessAccount(row.parent),
    ...(row.matching_conflicts?.length ? {
      matching_conflicts: row.matching_conflicts,
      alternative_contacts: row.alternatives.map((c) => ({
        account_id: c.account.account_id,
        contacts: c.contacts.map(({ updated_at, ...contact }) => contact),
      })),
    } : {}),
  };
  const compatibilityVersion = await digest(material);
  const options = row.kind === 'unchanged' ? row.options : fieldOptions(row);
  if (!options.some((choice) => choice.field_choices))
    return { ...row, id: compatibilityVersion, version: compatibilityVersion, material };
  const enrichedMaterial = {
    ...material,
    field_choice_rule: 'website-field-choices-v1',
    options: options.map(({ id, base_option_id, field_choices, resolution, account_id, operations }) => ({
      id, base_option_id, field_choices,
      ...(resolution ? { resolution, account_id } : {}),
      operations: operations.map(({ before, ...operation }) => operation),
    })),
  };
  const version = await digest(enrichedMaterial);
  return { ...row, options, id: version, version, compatibility_version: compatibilityVersion, material: enrichedMaterial };
}

// Expand only existing actionable cases. Every checkbox combination is an
// immutable server proposal, so approval and recovery keep using an option ID.
/** @param {ProposalDraft} row @returns {ProposalOption[]} */
function fieldOptions(row) {
  if (!row.facility) return row.options;
  const facility = row.facility;
  const categories = [...new Set(facility.care_offerings.map(careCategory).filter((category) => category !== undefined))];
  return row.options.flatMap((base) => {
    if (!base.operations.length) return [base];
    const primary = base.operations.find((operation) => ['patch', 'chow', 'create'].includes(operation.type));
    const before = primary?.before ?? [...row.candidates, ...row.alternatives]
      .find((candidate) => candidate.account.account_id === (base.account_id ?? base.id))?.account;
    const creating = primary?.type === 'create' || primary?.type === 'chow';
    if (!primary && !before) return [base];
    const phoneAvailable = /^\d{10}$/.test(phoneKey(facility.phone_raw)) &&
      !!before && phoneKey(before.phone) !== phoneKey(facility.phone_raw);
    const careAvailable = categories.length > 0 &&
      (categories.length > 1 || (!!before && !categories.some((category) => category === before.care_type)));
    if (!phoneAvailable && !careAvailable) return [base];
    const defaultPhone = !!creating;
    const defaultCare = creating ? (categories[0] ?? null) : null;
    const phones = phoneAvailable ? [defaultPhone, !defaultPhone] : [defaultPhone];
    const careValues = careAvailable
      ? [...new Set([defaultCare, ...(before ? [null] : []), ...categories])]
      : [defaultCare];
    return phones.flatMap((phone) => careValues.map((care) => {
      const operations = structuredClone(base.operations);
      let target = operations.find((operation) => ['patch', 'chow', 'create'].includes(operation.type));
      /** @type {AccountPatch} */
      const changedFields = {};
      if (phoneAvailable && phone) changedFields.phone = facility.phone_raw;
      if (careAvailable && care !== null && care !== before?.care_type) changedFields.care_type = care;
      if (!target && before && Object.keys(changedFields).length) {
        target = { type: 'patch', account_id: before.account_id, before, fields: {} };
        operations.unshift(target);
      }
      if (target) {
        if (phoneAvailable) {
          if (phone) target.fields.phone = facility.phone_raw;
          else if (creating) target.fields.phone = before?.phone ?? '';
          else delete target.fields.phone;
        }
        if (careAvailable) {
          if (creating) target.fields.care_type = care ?? before?.care_type ?? '';
          else if (care !== null && care !== before?.care_type) target.fields.care_type = care;
          else delete target.fields.care_type;
        }
      }
      const choices = {
        ...(phoneAvailable ? { phone: { current: before?.phone ?? null, proposed: facility.phone_raw, selected: phone } } : {}),
        ...(careAvailable ? { care_type: { current: before ? (before.care_type ?? '') : null, values: categories, selected: care } } : {}),
      };
      const isDefault = phone === defaultPhone && care === defaultCare;
      return {
        ...base,
        id: isDefault ? base.id : `${base.id}:fields:${phone ? 'website-phone' : 'keep-phone'}:${care === null ? 'keep-care' : encodeURIComponent(care)}`,
        base_option_id: base.id,
        field_choices: choices,
        operations: operations.filter((operation) => operation.type !== 'patch' || Object.keys(operation.fields).length > 0),
      };
    }));
  });
}
