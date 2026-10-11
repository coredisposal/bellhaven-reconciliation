// @ts-check
import { canonical, digest, businessAccount, needsChow, norm, streetKey } from './core.mjs';
import { assertNoInterruptedOverlap } from './recovery-conflicts.mjs';
import { isRecord, isAccount, isContact } from './contracts.mjs';
import { assertRelationship } from './account-relationships.mjs';

/** @typedef {import('./domain-types').Account} Account */
/** @typedef {import('./domain-types').Contact} Contact */
/** @typedef {import('./domain-types').AccountPatch & import('./domain-types').ContactPatch} ManualFields */
/** @typedef {Account & Partial<Contact>} ManualRecord */
/** @typedef {'accounts' | 'contacts'} Entity */
/** @typedef {'patch' | 'create' | 'chow'} ManualType */
/** @typedef {{type:'chow'|'duplicate', target_id:string}} ManualRelationship */
/** @typedef {{actor: string, session: string}} Identity */
/** @typedef {import('./ledger.mjs').Ledger} Ledger */
/** @typedef {import('./execution-types').CrmClient} CrmClient */
/** @typedef {{account_id?:string,contact_id?:string}} CreatedIdentity */
/** @typedef {{get:(id:string)=>Promise<ManualRecord>, all:()=>Promise<ManualRecord[]>, patch:(id:string,fields:ManualFields)=>Promise<unknown>, create:(fields:ManualFields)=>Promise<CreatedIdentity | {data:CreatedIdentity}>, id:'account_id'|'contact_id'}} ManualAdapter */
/** @typedef {{type:ManualType, entity:Entity, record_id?:string, account_id?:string, before:ManualRecord|null, fields:ManualFields}} ManualOperation */
/** @typedef {{id:string, label:string, operations:ManualOperation[]}} ManualOption */
/** @typedef {{id:string, version:string, key:string, manual:true, origin:'manual', entity:Entity, kind:'manual_account'|'manual_contact', type:ManualType, title:string, city:string, state:string, summary:string, before:ManualRecord|null, fields:ManualFields, proposed:ManualFields, recordId:string|null, reviewer_note:string, dependencies:Account[], relationship?:ManualRelationship, marker:string|null, create_identity:string|null, facility:null, candidates:{account:ManualRecord, contacts:Contact[], reasons:string[], conflicts:string[]}[], alternatives:never[], options:ManualOption[], material:unknown, evidence_version?:string, revision_of?:string}} ManualProposal */
/** @typedef {{recordId?:string, created?:ManualRecord, before?:ManualRecord|null, fields?:ManualFields, marker?:string|null}} ManualCheckpoint */
/** @typedef {Pick<ManualProposal,'id'|'key'|'version'|'manual'|'origin'|'entity'|'type'|'before'|'fields'|'recordId'|'dependencies'|'relationship'|'marker'|'create_identity'|'options'|'material'|'reviewer_note'|'evidence_version'|'revision_of'>} ManualExecutionProposal */
/** @typedef {'create_intent'|'created_response'|'created'|'link_intent'|'patch_intent'|'complete'} ManualCheckpointStatus */

/** @type {(keyof import('./domain-types').AccountPatch)[]} */
const ACCOUNT_FIELDS = [
  'name',
  'parent_id',
  'billing_street',
  'billing_city',
  'billing_state',
  'billing_zip',
  'phone',
  'care_type',
  'status',
  'note',
];
const CONTACT_FIELDS = ['account_id', 'name', 'title', 'email', 'phone', 'is_active'];

/** Check stored drafts/checkpoints before they can drive network writes.
 * @param {unknown} value @param {Entity} entity @returns {value is ManualRecord}
 */
const isManualRecord = (value, entity) => entity === 'accounts' ? isAccount(value) : isContact(value);
/** @param {unknown} value @param {Entity} entity @returns {value is ManualFields} */
function isStoredFields(value, entity) {
  if (!isRecord(value)) return false;
  const allowed = entity === 'accounts'
    ? [...ACCOUNT_FIELDS, 'lifetime_revenue', 'outstanding_ar', 'chow_current_account', 'duplicate_of_account']
    : CONTACT_FIELDS;
  return Object.entries(value).every(([key, item]) => allowed.includes(key) &&
    (key === 'is_active' ? typeof item === 'boolean'
      : key === 'lifetime_revenue' || key === 'outstanding_ar'
        ? typeof item === 'number' && Number.isFinite(item)
        : typeof item === 'string'));
}
/** @param {unknown} value @param {Entity} entity @returns {value is ManualOperation} */
function isStoredOperation(value, entity) {
  return isRecord(value) && value.entity === entity &&
    (value.type === 'create' || value.type === 'patch' || (entity === 'accounts' && value.type === 'chow')) &&
    (value.record_id === undefined || typeof value.record_id === 'string') &&
    (value.account_id === undefined || typeof value.account_id === 'string') &&
    (value.before === null || isManualRecord(value.before, entity)) && isStoredFields(value.fields, entity);
}
/** @param {unknown} value @returns {value is ManualExecutionProposal} */
function isStoredProposal(value) {
  if (!isRecord(value) || value.manual !== true || value.origin !== 'manual' ||
    (value.entity !== 'accounts' && value.entity !== 'contacts')) return false;
  const entity = value.entity;
  return ['id', 'key', 'version'].every((key) => typeof value[key] === 'string' && !!value[key]) &&
    typeof value.reviewer_note === 'string' &&
    (value.relationship === undefined || (entity === 'accounts' && value.type === 'patch' && isRelationship(value.relationship))) &&
    ['evidence_version', 'revision_of'].every((key) => value[key] === undefined ||
      (typeof value[key] === 'string' && !!value[key])) &&
    (value.type === 'create' || value.type === 'patch' || (entity === 'accounts' && value.type === 'chow')) &&
    (value.before === null || isManualRecord(value.before, entity)) &&
    isStoredFields(value.fields, entity) && (value.recordId === null || typeof value.recordId === 'string') &&
    (value.type === 'create' ? value.before === null && value.recordId === null
      : isManualRecord(value.before, entity) &&
        value.before[entity === 'accounts' ? 'account_id' : 'contact_id'] === value.recordId) &&
    (value.marker === null || typeof value.marker === 'string') &&
    (value.create_identity === null || typeof value.create_identity === 'string') &&
    Array.isArray(value.dependencies) && value.dependencies.every(isAccount) &&
    Array.isArray(value.options) && value.options.length === 1 && value.options.every((option) =>
      isRecord(option) && option.id === 'manual' && typeof option.label === 'string' &&
      Array.isArray(option.operations) && option.operations.length === 1 &&
      option.operations.every((operation) => isStoredOperation(operation, entity) &&
        operation.type === value.type && same(operation.before, value.before) &&
        same(operation.fields, value.fields) && (operation.record_id ?? null) === value.recordId &&
        operation.account_id === (entity === 'accounts' ? value.recordId ?? undefined : undefined)));
}
/** @param {unknown} value @param {Entity} entity @returns {value is ManualCheckpoint} */
function isStoredCheckpoint(value, entity) {
  return isRecord(value) && (value.recordId === undefined || typeof value.recordId === 'string') &&
    (value.created === undefined || isManualRecord(value.created, entity)) &&
    (value.before == null || isManualRecord(value.before, entity)) &&
    (value.fields === undefined || isStoredFields(value.fields, entity)) &&
    (value.marker == null || typeof value.marker === 'string');
}
const now = () => new Date().toISOString();
/** @param {unknown} a @param {unknown} b */
const same = (a, b) => canonical(a) === canonical(b);
/** @param {ManualRecord} value */
const clean = (value) => {
  const { updated_at, created_by_candidate, parent_name, ...rest } = value;
  return rest;
};
/** @param {ManualRecord|null|undefined} a @param {ManualRecord|null|undefined} b */
const recordSame = (a, b) => !!a && !!b && same(clean(a), clean(b));
/** @param {ManualRecord|null|undefined} actual @param {ManualFields} fields */
const hasFields = (actual, fields) =>
  !!actual && Object.entries(fields).every(([key, value]) => same(readField(actual, key), value));
/** Scalar field access after the entity-specific editable-key validation.
 * @param {ManualRecord} value @param {string} key
 */
function readField(value, key) {
  return value[/** @type {keyof ManualRecord} */ (key)];
}
/** @param {CrmClient} client @param {Entity} entity @returns {ManualAdapter} */
function adapter(client, entity) {
  return entity === 'accounts'
    ? {
        get: (id) => client.get(id),
        all: () => client.accounts(),
        patch: (id, fields) => client.patch(id, fields),
        create: (fields) => client.create(fields),
        id: 'account_id',
      }
    : {
        get: (id) => client.getContact(id),
        all: () => client.contacts(),
        patch: (id, fields) => client.patchContact(id, fields),
        create: (fields) => client.createContact(fields),
        id: 'contact_id',
      };
}
/** @param {Entity} entity @param {unknown} input @param {boolean} creating @returns {ManualFields} */
function validFields(entity, input, creating) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Provide a fields object.');
  const allowed = entity === 'accounts' ? ACCOUNT_FIELDS : CONTACT_FIELDS;
  /** @type {Record<string, string|boolean>} */
  const validated = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (input))) {
    if (!allowed.includes(key))
      throw new Error(
        `Field ${key} is not editable. Billing balances, relationship pointers and system fields are protected.`
      );
    if (key === 'is_active') {
      if (typeof value !== 'boolean') throw new Error('is_active must be true or false.');
    } else if (typeof value !== 'string' || value.length > (key === 'note' ? 4000 : 300))
      throw new Error(`Invalid ${key}; supply bounded text.`);
    if ((key === 'name' || key === 'account_id') && typeof value === 'string' && !value.trim())
      throw new Error(`${key} cannot be empty.`);
    if (key === 'status' && (typeof value !== 'string' || !['Active', 'Inactive', 'Needs Review'].includes(value)))
      throw new Error('Unsupported account status.');
    if (
      key === 'care_type' &&
      (typeof value !== 'string' || !['', 'Skilled Nursing', 'Assisted Living', 'Memory Care', 'Independent Living'].includes(value))
    )
      throw new Error('Unsupported CRM care category.');
    validated[key] = value;
  }
  // Every key and value above is checked against the editable CRM field contract.
  const fields = /** @type {ManualFields} */ (validated);
  if (!Object.keys(fields).length) throw new Error('Enter at least one proposed change.');
  if (creating && !fields.name?.trim()) throw new Error('A new record requires a name.');
  if (creating && entity === 'contacts' && !fields.account_id)
    throw new Error('A new contact requires an existing account.');
  return fields;
}
/** @param {Entity} entity @param {ManualFields|ManualRecord} a */
function identityKey(entity, a) {
  return entity === 'accounts'
    ? canonical([
        norm(a.name),
        a.parent_id ?? '',
        streetKey(a.billing_street),
        norm(a.billing_city),
        norm(a.billing_state),
      ])
    : canonical([
        a.account_id,
        norm(a.name),
        norm(a.email),
        String(a.phone ?? '').replace(/\D/g, ''),
      ]);
}

/** @param {unknown} value @returns {value is ManualRelationship} */
function isRelationship(value) {
  return isRecord(value) && Object.keys(value).length === 2 &&
    (value.type === 'chow' || value.type === 'duplicate') &&
    typeof value.target_id === 'string' && !!value.target_id.trim() && value.target_id.length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(value.target_id);
}
/** Only the server derives protected relationship patches.
 * @param {ManualRelationship} relationship @returns {ManualFields}
 */
function relationshipFields(relationship) {
  return relationship.type === 'chow'
    ? { chow_current_account: relationship.target_id }
    : { status: 'Inactive', duplicate_of_account: relationship.target_id };
}
/** An address establishes physical overlap, not ownership. The reviewer's
 * required confirmation note supplies the basis for the selected relationship.
 * @param {CrmClient} client @param {Account} source @param {ManualRelationship} relationship
 * @returns {Promise<Account[]>}
 */
async function relationshipDependencies(client, source, relationship) {
  const target = await client.get(relationship.target_id);
  if (!target || target.account_id !== relationship.target_id)
    throw new Error('The selected target does not match the CRM response.');
  assertRelationship(source, target, await client.accounts(), relationship.type);
  const refs = [target];
  for (const account of [source, target]) {
    const parents = await dependencies(client, 'accounts', { parent_id: account.parent_id ?? '' }, account);
    if (parents.some((parent) => parent.account_id === source.account_id || parent.account_id === target.account_id || parent.status !== 'Active'))
      throw new Error('The facility parent relationship is invalid, cyclic or not active.');
    refs.push(...parents);
  }
  return [...new Map(refs.map((account) => [account.account_id, account])).values()];
}

/** Recheck the relationship at each write boundary and on resume. A completed
 * source patch is permitted only as the exact after-image of this approval.
 * @param {CrmClient} client @param {ManualExecutionProposal} p
 */
async function verifyRelationship(client, p) {
  if (!p.relationship) return;
  if (!p.before || !p.recordId || !same(p.fields, relationshipFields(p.relationship)))
    throw new Error('Stored relationship fields are invalid. Stage a fresh proposal.');
  const current = await client.get(p.recordId);
  if (!recordSame(current, p.before) && !recordSame(current, { ...p.before, ...p.fields }))
    throw new Error('Relationship source changed. Stage a fresh proposal before approving.');
  const refs = await relationshipDependencies(client, p.before, p.relationship);
  if (!same(refs.map(clean), p.dependencies.map(clean)))
    throw new Error('Linked account or parent changed. Stage a fresh proposal before approving.');
}

/** Stored JSON must still describe the exact draft bound to the displayed
 * version. Shape checks alone cannot catch an added, otherwise valid field.
 * @param {ManualExecutionProposal} p
 */
async function verifyDraftIntegrity(p) {
  const material = p.material;
  if (!isRecord(material) || typeof material.seed !== 'string')
    throw new Error('Stored manual proposal integrity check failed. Stage a fresh proposal.');
  const expectedMarker = p.entity === 'accounts' && p.type !== 'patch'
    ? `[bellhaven-manual:${material.seed}]` : null;
  const expectedKey = `manual:${p.entity}:${p.recordId ?? (await digest({ entity: p.entity, identity: identityKey(p.entity, p.fields) }))}`;
  if (p.marker !== expectedMarker || p.key !== expectedKey ||
    p.create_identity !== (p.type === 'patch' ? null : identityKey(p.entity, p.fields)) ||
    !same(material, { seed: material.seed, key: p.key, entity: p.entity, type: p.type, fields: p.fields, marker: p.marker,
      ...(p.relationship ? { relationship: p.relationship } : {}) }))
    throw new Error('Stored manual proposal integrity check failed. Stage a fresh proposal.');

  // The marker was appended after the seed was computed. Older saved drafts
  // can start with no note or an empty note; verify both lossless possibilities.
  const seedFields = { ...p.fields };
  /** @type {ManualFields[]} */
  const originals = [seedFields];
  if (p.marker) {
    if (seedFields.note === p.marker) {
      seedFields.note = '';
      const withoutNote = { ...seedFields };
      delete withoutNote.note;
      originals.push(withoutNote);
    } else if (seedFields.note?.endsWith('\n' + p.marker)) {
      seedFields.note = seedFields.note.slice(0, -('\n' + p.marker).length);
    } else throw new Error('Stored manual proposal marker differs from its fields. Stage a fresh proposal.');
  }
  const seeds = await Promise.all(originals.map((fields) => digest({
    rule: 'manual-v1', entity: p.entity, recordId: p.recordId,
    before: p.before ? clean(p.before) : null, fields,
    dependencies: p.dependencies.map(clean), reviewer_note: p.reviewer_note,
    ...(p.relationship ? { relationship: p.relationship } : {}),
  })));
  const evidenceVersion = await digest(material);
  const expectedVersion = p.revision_of && p.type === 'patch'
    ? await digest({ rule: 'manual-reapplied-evidence-v1', evidence_version: evidenceVersion, after_applied_id: p.revision_of })
    : evidenceVersion;
  if (!seeds.includes(material.seed) ||
    (p.evidence_version !== undefined && p.evidence_version !== evidenceVersion) ||
    (p.revision_of !== undefined && (p.type !== 'patch' || p.evidence_version === undefined)) ||
    p.version !== expectedVersion)
    throw new Error('Stored manual proposal integrity check failed. Stage a fresh proposal.');
}

/** Always enforce the billing SOP again at the actual direct-write boundary.
 * @param {ManualExecutionProposal} p @param {ManualRecord} current
 */
function verifyDirectParentPatch(p, current) {
  if (p.entity === 'accounts' && p.type === 'patch' && !p.relationship &&
    Object.keys(p.fields).some((field) => !ACCOUNT_FIELDS.includes(/** @type {keyof import('./domain-types').AccountPatch} */ (field))))
    throw new Error('Protected relationship and billing fields require a dedicated reviewed operation.');
  if (p.entity === 'accounts' && p.type === 'patch' && Object.hasOwn(p.fields, 'parent_id') &&
    needsChow(current, p.fields.parent_id))
    throw new Error('Revenue history and outstanding AR require CHOW. A direct parent patch is not allowed. Stage a fresh proposal.');
}
/** @param {CrmClient} client @param {Entity} entity @param {ManualFields} fields @param {ManualRecord|null} before @returns {Promise<Account[]>} */
async function dependencies(client, entity, fields, before) {
  const id = entity === 'contacts' ? (fields.account_id ?? before?.account_id) : fields.parent_id;
  if (!id) return [];
  if (entity === 'accounts' && id === before?.account_id)
    throw new Error('An account cannot be its own parent.');
  const output = [],
    seen = new Set(entity === 'accounts' && before ? [before.account_id] : []);
  /** @type {string|null|undefined} */
  let cursor = id;
  while (cursor) {
    if (seen.has(cursor)) throw new Error('The proposed parent relationship forms a cycle.');
    seen.add(cursor);
    const account = await client.get(cursor);
    if (!account?.account_id || account.account_id !== cursor) throw new Error('The linked account does not exist or differs from the requested ID.');
    if (
      account.status === 'Inactive' ||
      account.duplicate_of_account ||
      account.chow_current_account
    )
      throw new Error('Select an active current account, not a retired or historical record.');
    output.push(account);
    cursor = entity === 'accounts' ? account.parent_id : null;
  }
  return output;
}
/** @param {CrmClient} client @param {ManualExecutionProposal} p */
async function verifyDependencies(client, p) {
  for (const before of p.dependencies)
    if (!recordSame(await client.get(before.account_id), before))
      throw new Error('Linked account changed. Stage a fresh proposal before approving.');
}
/** @param {ManualAdapter} api @param {ManualExecutionProposal} p @param {string} [knownId] */
async function duplicateCreate(api, p, knownId) {
  const records = await api.all();
  const marker = p.marker;
  if (marker && records.filter((record) => (record.note ?? '').includes(marker)).length > 1)
    throw new Error('Multiple operation markers found. Manual recovery required.');
  /** @param {ManualRecord} a */
  const sameLocation = (a) =>
    p.entity === 'accounts' &&
    streetKey(p.fields.billing_street) &&
    norm(p.fields.billing_city) &&
    norm(p.fields.billing_state) &&
    a.parent_id === p.fields.parent_id &&
    streetKey(a.billing_street) === streetKey(p.fields.billing_street) &&
    norm(a.billing_city) === norm(p.fields.billing_city) &&
    norm(a.billing_state) === norm(p.fields.billing_state);
  return records.filter(
    (a) =>
      a[api.id] !== knownId &&
      (identityKey(p.entity, a) === p.create_identity || sameLocation(a)) &&
      !(p.marker && (a.note ?? '').includes(p.marker))
  );
}

/** Draft an immutable reviewable operation. This function never writes to CRM.
 * @param {Ledger} ledger @param {CrmClient} client @param {Record<string,unknown>} input @param {Identity} identity
 */
export async function stageManual(ledger, client, input, identity) {
  if (!input || (input.entity !== 'accounts' && input.entity !== 'contacts'))
    throw new Error('Choose accounts or contacts.');
  if (Object.keys(input).some((k) => !['entity', 'recordId', 'fields', 'note', 'relationship'].includes(k)))
    throw new Error('Unexpected manual draft field.');
  const { entity, recordId } = input;
  if (
    recordId !== undefined &&
    (typeof recordId !== 'string' || !recordId.trim() || recordId.length > 100)
  )
    throw new Error('Invalid record ID.');
  if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000)
    throw new Error('Explain the purpose of this manual change (up to 2,000 characters).');
  if (input.relationship !== undefined &&
    (entity !== 'accounts' || !recordId || !isRelationship(input.relationship) ||
      !isRecord(input.fields) || Object.keys(input.fields).length !== 0))
    throw new Error('A relationship proposal requires an existing account, a supported target relationship and no additional fields.');
  const relationship = /** @type {ManualRelationship|undefined} */ (input.relationship);
  const lock = crypto.randomUUID();
  await ledger.lock(lock);
  try {
    const api = adapter(client, entity),
      before = recordId ? await api.get(recordId) : null;
    if (recordId && !before?.[api.id]) throw new Error('Record does not exist.');
    if (
      entity === 'accounts' &&
      before &&
      (before.chow_current_account || before.duplicate_of_account)
    )
      throw new Error('Historical accounts are protected. Review the current account instead.');
    const requested = relationship ? relationshipFields(relationship) : validFields(entity, input.fields, !recordId);
    /** @type {ManualFields} */
    let fields = Object.fromEntries(
      Object.entries(requested).filter(([key, value]) => !before || !same(readField(before, key), value))
    );
    if (!Object.keys(fields).length) throw new Error('These values already match the CRM.');
    /** @type {ManualType} */
    let type = recordId ? 'patch' : 'create';
    const refs = relationship && before
      ? await relationshipDependencies(client, before, relationship)
      : await dependencies(client, entity, fields, before);
    if (entity === 'accounts' && !relationship) {
      if (before) {
        const prior = [];
        if (Object.hasOwn(fields, 'name'))
          prior.push(`Prior observed CRM name (not a verified official alias): ${before.name}`);
        if (Object.hasOwn(fields, 'billing_street'))
          prior.push(
            `Prior observed CRM billing address (not a verified official alias): ${before.billing_street}, ${before.billing_city}, ${before.billing_state} ${before.billing_zip}`
          );
        if (prior.length)
          fields.note = [fields.note ?? before.note, ...prior].filter(Boolean).join('\n');
        if (Object.hasOwn(fields, 'parent_id') && needsChow(before, fields.parent_id)) {
          if (!fields.parent_id)
            throw new Error('A CHOW replacement requires an explicit current parent.');
          type = 'chow';
          fields = {
            ...Object.fromEntries(ACCOUNT_FIELDS.map((k) => [k, before[k] ?? ''])),
            ...fields,
            lifetime_revenue: 0,
            outstanding_ar: 0,
          };
        }
      } else fields = { status: 'Active', ...fields, lifetime_revenue: 0, outstanding_ar: 0 };
    } else if (!before) fields = { title: '', email: '', phone: '', is_active: true, ...fields };
    const seed = await digest({
      rule: 'manual-v1',
      entity,
      recordId: recordId ?? null,
      before: before ? clean(before) : null,
      fields,
      dependencies: refs.map(clean),
      reviewer_note: input.note,
      ...(relationship ? { relationship } : {}),
    });
    const marker = entity === 'accounts' && type !== 'patch' ? `[bellhaven-manual:${seed}]` : null;
    if (marker) fields.note = [fields.note, marker].filter(Boolean).join('\n');
    const key = `manual:${entity}:${recordId ?? (await digest({ entity, identity: identityKey(entity, fields) }))}`;
    const material = { seed, key, entity, type, fields, marker, ...(relationship ? { relationship } : {}) };
    let version = await digest(material);
    /** @type {ManualOperation} */
    const operation = {
      type,
      entity,
      ...(recordId
        ? { record_id: recordId, account_id: entity === 'accounts' ? recordId : undefined }
        : {}),
      before,
      fields,
    };
    /** @type {ManualProposal} */
    const p = {
      id: version,
      version,
      key,
      manual: true,
      origin: 'manual',
      entity,
      kind: entity === 'accounts' ? 'manual_account' : 'manual_contact',
      type,
      title: fields.name ?? before?.name ?? '',
      city: fields.billing_city ?? before?.billing_city ?? '',
      state: fields.billing_state ?? before?.billing_state ?? '',
      summary:
        relationship?.type === 'chow'
          ? `Link the original account to existing successor ${refs[0].name}. Preserve the original parent, billing and other fields; the successor stays unchanged.`
          : relationship?.type === 'duplicate'
          ? `Mark this zero-balance copy inactive and link it to ${refs[0].name}. Preserve both accounts' balances and contacts; the survivor stays unchanged.`
          : type === 'chow'
          ? 'Manual parent change requires a zero-balance replacement; only the CHOW pointer will change on the original.'
          : 'Explicit manual API change. Review the stored fields and explanation before approval.',
      before,
      fields,
      proposed: fields,
      recordId: recordId ?? null,
      reviewer_note: input.note,
      dependencies: refs,
      ...(relationship ? { relationship } : {}),
      marker,
      create_identity: type !== 'patch' ? identityKey(entity, fields) : null,
      facility: null,
      candidates:
        entity === 'accounts' && before
          ? [
              {
                account: before,
                contacts: [],
                reasons: ['Explicitly selected by reviewer'],
                conflicts: [],
              },
            ]
          : [],
      alternatives: [],
      options: [
        {
          id: 'manual',
          label:
            relationship?.type === 'chow'
              ? `Link to existing successor: ${refs[0].name}`
              : relationship?.type === 'duplicate'
              ? `Retire duplicate; keep ${refs[0].name}`
              : type === 'chow'
              ? 'Create replacement and preserve original'
              : type === 'create'
                ? 'Create record'
                : 'Update record',
          operations: [operation],
        },
      ],
      material,
    };
    if (type === 'patch') {
      p.evidence_version = version;
      /** @type {import('./execution-types').PriorProposalRow[]} */
      const applied = await ledger.all(
        `SELECT p.id,COALESCE(json_extract(p.data,'$.evidence_version'),p.version) AS evidence_version,
          COALESCE((SELECT MAX(d.rowid) FROM decisions d
            WHERE d.proposal_id=p.id AND d.action='approve'),0) AS approval_order
         FROM proposals p WHERE p.case_key=? AND p.status='applied'
         ORDER BY approval_order DESC,p.created DESC,p.rowid DESC`,
        key
      );
      if (applied.some((row) => row.evidence_version === p.evidence_version)) {
        // An explicit patch draft after an external rollback needs a new
        // approval and checkpoints. Creation/CHOW recovery remains unchanged.
        version = await digest({
          rule: 'manual-reapplied-evidence-v1',
          evidence_version: p.evidence_version,
          after_applied_id: applied[0].id,
        });
        p.id = version;
        p.version = version;
        p.revision_of = applied[0].id;
      }
    }
    await assertNoInterruptedOverlap(ledger, p);
    if (type !== 'patch' && (await duplicateCreate(api, p)).length)
      throw new Error(
        'An existing record has the same identifying values. Review that record instead of creating another.'
      );
    /** @type {Pick<import('./execution-types').ProposalRow,'status'>|null} */
    const existing = await ledger.one('SELECT status FROM proposals WHERE id=?', version);
    if (existing && existing.status !== 'superseded') return { ...p, status: existing.status };
    if (
      await ledger.one(
        "SELECT id FROM proposals WHERE case_key=? AND status IN ('partial','applying')",
        key
      )
    )
      throw new Error(
        'This record has interrupted approved work. Resolve it before staging another change.'
      );
    await ledger.batch([
      [
        "UPDATE proposals SET status='superseded' WHERE case_key=? AND status IN ('pending','stale')",
        key,
      ],
      existing ? ["UPDATE proposals SET status='pending' WHERE id=?", version] : [
        'INSERT INTO proposals(id,case_key,version,run_id,status,data,created) VALUES(?,?,?,?,?,?,?)',
        version,
        key,
        version,
        'manual',
        'pending',
        JSON.stringify(p),
        now(),
      ],
      ledger.auditStatement(
        'manual_proposal_staged',
        {
          actor: identity.actor,
          session: identity.session,
          entity,
          record_id: recordId ?? null,
          note: input.note,
          version,
        },
        version
      ),
    ]);
    return { ...p, status: 'pending' };
  } finally {
    await ledger.unlock(lock);
  }
}

/** Apply only the server-stored draft version, with the same durable global lock.
 * @param {Ledger} ledger @param {CrmClient} client @param {import('./execution-types').DecisionInput} input @param {Identity} identity
 */
export async function decideManual(ledger, client, input, identity) {
  if (
    Object.keys(input).some(
      (k) => !['id', 'version', 'action', 'optionId', 'note', 'proxyIdentity'].includes(k)
    )
  )
    throw new Error('Only a stored proposal decision is accepted.');
  if (typeof (input.note ?? '') !== 'string' || (input.note?.length ?? 0) > 2000)
    throw new Error('Invalid reviewer note.');
  const lock = crypto.randomUUID();
  await ledger.lock(lock);
  try {
    /** @type {import('./execution-types').ProposalRow|null} */
    const row = await ledger.one('SELECT * FROM proposals WHERE id=?', input.id);
    if (!row || row.version !== input.version) throw new Error('Proposal version unavailable.');
    /** @type {unknown} */
    const p = JSON.parse(row.data);
    if (!isStoredProposal(p)) throw new Error('Stored manual proposal is invalid. Stage a fresh proposal.');
    if (p.id !== row.id || p.version !== row.version)
      throw new Error('Stored manual proposal identity differs from its ledger version. Operator review is required.');
    if (p.type !== 'create' && (!p.recordId || !p.before))
      throw new Error('Stored manual update is missing its original record.');
    const { action } = input;
    /** @returns {import('./execution-types').SqlStatement} */
    const decision = () => [
      'INSERT INTO decisions(id,proposal_id,action,option_id,actor,session_id,note,created) VALUES(?,?,?,?,?,?,?,?)',
      crypto.randomUUID(),
      p.id,
      action,
      'manual',
      identity.actor,
      identity.session,
      input.note ?? '',
      now(),
    ];
    if (action === 'reject' || action === 'reopen') {
      if (
        action === 'reject' ? row.status !== 'pending' : !['rejected', 'stale'].includes(row.status)
      )
        throw new Error('This decision is not available in the current state.');
      if (!input.note?.trim()) throw new Error('Explain this decision.');
      const status = action === 'reject' ? 'rejected' : 'pending';
      await ledger.batch([
        decision(),
        ['UPDATE proposals SET status=? WHERE id=?', status, p.id],
        ledger.auditStatement(
          action === 'reject' ? 'proposal_rejected' : 'case_reopened',
          { actor: identity.actor, note: input.note },
          p.id
        ),
      ]);
      return { status };
    }
    if (!['approve', 'resume'].includes(action)) throw new Error('Unsupported decision.');
    if (action === 'approve' && (row.status !== 'pending' || input.optionId !== 'manual'))
      throw new Error('Choose the available server-stored manual operation.');
    if (action === 'resume' && !['partial', 'applying'].includes(row.status))
      throw new Error('Only interrupted approved work can resume.');
    if (
      action === 'resume' &&
      !(await ledger.one("SELECT id FROM decisions WHERE proposal_id=? AND action='approve'", p.id))
    )
      throw new Error('No persisted approval to resume.');
    await verifyDraftIntegrity(p);
    const api = adapter(client, p.entity),
      operationId = await digest({ proposal: p.id, option: 'manual', step: 0 });
    await assertNoInterruptedOverlap(ledger, p, p.options[0]);
    /** @type {{status:ManualCheckpointStatus, data?:string}|null} */
    let saved = await ledger.one('SELECT * FROM operations WHERE id=?', operationId);
    /** @type {unknown} */
    const storedCheckpoint = saved?.data ? JSON.parse(saved.data) : {};
    if (!isStoredCheckpoint(storedCheckpoint, p.entity))
      throw new Error('Stored operation checkpoint is invalid. Operator review is required.');
    let checkpoint = storedCheckpoint;
    /** @param {ManualCheckpointStatus} status @param {ManualCheckpoint} data */
    const save = async (status, data) => {
      checkpoint = { ...checkpoint, ...data };
      await ledger.checkpoint(operationId, p.id, 0, status, checkpoint);
      saved = { status };
    };
    try {
      await verifyDependencies(client, p);
      await verifyRelationship(client, p);
      if (action === 'approve' && p.before && p.recordId) {
        const current = await api.get(p.recordId);
        if (!recordSame(current, p.before))
          throw new Error('Record changed. Stage a fresh proposal before approving.');
        verifyDirectParentPatch(p, current);
      }
      if (p.type !== 'patch' && (await duplicateCreate(api, p, checkpoint.recordId)).length)
        throw new Error('Matching record now exists. Review it before creating another.');
    } catch (error) {
      if (action === 'approve')
        await ledger.run("UPDATE proposals SET status='stale' WHERE id=?", p.id);
      await ledger.audit(
        'proposal_invalidated',
        { reason: error instanceof Error ? error.message : String(error), actor: identity.actor },
        p.id
      );
      throw error;
    }
    if (action === 'approve') {
      await ledger.batch([
        decision(),
        ["UPDATE proposals SET status='applying' WHERE id=?", p.id],
        ledger.auditStatement(
          'proposal_approved',
          {
            actor: identity.actor,
            session: identity.session,
            option: 'manual',
            note: input.note,
            version: p.version,
          },
          p.id
        ),
      ]);
    } else await ledger.audit('application_resumed', { actor: identity.actor }, p.id);
    if (action === 'resume')
      await ledger.run("UPDATE proposals SET status='applying' WHERE id=?", p.id);
    try {
      /** @type {ManualRecord} */
      let after;
      /** @type {ManualRecord|undefined} */
      let created;
      if (p.type === 'patch') {
        if (!p.recordId || !p.before) throw new Error('Stored patch has no original record.');
        const expected = { ...p.before, ...p.fields };
        after = await api.get(p.recordId);
        if (saved?.status === 'complete' && !recordSame(after, expected))
          throw new Error('Completed record changed after approval. Operator review is required.');
        if (!recordSame(after, expected)) {
          if (!recordSame(after, p.before))
            throw new Error('Record changed after approval; patch withheld.');
          verifyDirectParentPatch(p, after);
          await save('patch_intent', { before: p.before, fields: p.fields });
          await ledger.fence(lock);
          await verifyRelationship(client, p);
          try {
            await api.patch(p.recordId, p.fields);
          } catch {
            /* Readback determines the result. */
          }
          after = await api.get(p.recordId);
        }
        if (!recordSame(after, expected))
          throw new Error('Patch not verified. Resume rechecks before retrying.');
        await verifyRelationship(client, p);
      } else {
        if (p.type === 'chow') {
          if (!p.recordId || !p.before) throw new Error('Stored CHOW has no original record.');
          const current = await api.get(p.recordId),
            expected = {
              ...p.before,
              ...(checkpoint.recordId ? { chow_current_account: checkpoint.recordId } : {}),
            };
          if (saved?.status === 'complete' && !recordSame(current, expected))
            throw new Error('Completed CHOW source changed. Operator review is required.');
          if (!recordSame(current, p.before) && !recordSame(current, expected))
            throw new Error('CHOW source changed; replacement creation or link withheld.');
        }
        if (checkpoint.recordId) created = await api.get(checkpoint.recordId);
        else if (p.marker) {
          const marker = p.marker;
          const matches = (await api.all()).filter((a) => (a.note ?? '').includes(marker));
          if (matches.length > 1)
            throw new Error('Multiple operation markers found. Manual recovery required.');
          created = matches[0];
        }
        if (!created) {
          if (saved)
            throw new Error(
              'Creation outcome is uncertain. Creation will not be repeated; operator recovery is required.'
            );
          await save('create_intent', { fields: p.fields, marker: p.marker });
          await ledger.fence(lock);
          try {
            const response = await api.create(p.fields),
              result = 'data' in response ? response.data : response,
              recordId = result[api.id];
            if (recordId) {
              await save('created_response', { recordId });
              created = await api.get(recordId);
            }
          } catch {
            /* An ID or account marker is required to recover, never a guessed contact identity. */
          }
          if (!created && p.marker) {
            const marker = p.marker;
            const matches = (await api.all()).filter((a) => (a.note ?? '').includes(marker));
            if (matches.length === 1) created = matches[0];
          }
          if (!created)
            throw new Error(
              'Creation outcome is uncertain. Creation will not be repeated; operator recovery is required.'
            );
        }
        if (
          !hasFields(created, p.fields) ||
          (p.entity === 'accounts' &&
            (created.chow_current_account || created.duplicate_of_account)) ||
          (checkpoint.created && !recordSame(created, checkpoint.created))
        )
          throw new Error(
            'Created record differs from the approved values. Operator review is required.'
          );
        await save('created', { recordId: created[api.id], created });
        if (p.type === 'chow') {
          if (!p.recordId || !p.before) throw new Error('Stored CHOW has no original record.');
          after = await api.get(p.recordId);
          const expected = { ...p.before, chow_current_account: created.account_id };
          if (!recordSame(after, expected)) {
            if (!recordSame(after, p.before))
              throw new Error('CHOW source changed before linking; existing replacement retained.');
            await save('link_intent', { recordId: created.account_id, created });
            await ledger.fence(lock);
            try {
              await api.patch(p.recordId, { chow_current_account: created.account_id });
            } catch {
              /* Verify exact source preservation below. */
            }
            after = await api.get(p.recordId);
          }
          if (!same(businessAccount(after), businessAccount(expected)))
            throw new Error('CHOW link not verified. Resume uses the existing replacement.');
        } else after = created;
      }
      await ledger.verified(
        operationId,
        p.id,
        0,
        {
          ...checkpoint,
          before: p.before,
          fields: p.fields,
          after,
          ...(created ? { created, recordId: created[api.id] } : {}),
        },
        {
          operation_id: operationId,
          type: p.type,
          entity: p.entity,
          before: p.before,
          after,
          ...(created ? { replacement: created } : {}),
        }
      );
      await ledger.run("UPDATE proposals SET status='applied' WHERE id=?", p.id);
      return { status: 'applied', recordId: created?.[api.id] ?? p.recordId };
    } catch (error) {
      await ledger.run("UPDATE proposals SET status='partial' WHERE id=?", p.id);
      await ledger.audit(
        'application_interrupted',
        { error: error instanceof Error ? error.message : String(error), entity: p.entity },
        p.id
      );
      throw error;
    }
  } finally {
    await ledger.unlock(lock);
  }
}
