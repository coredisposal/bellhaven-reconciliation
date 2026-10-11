import test from 'node:test';
import assert from 'node:assert/strict';
import { crmQuality } from '../lib/crm-quality.mjs';

const parent = { account_id: 'bellhaven', name: 'Bellhaven Senior Living (Parent Account)', status: 'Active', lifetime_revenue: 0, outstanding_ar: 0 };
const legacy = { ...parent, account_id: 'legacy', name: 'Legacy (Parent Account)' };
const account = (account_id, changes = {}) => ({
  account_id, name: 'Example Manor', parent_id: 'legacy', status: 'Active',
  billing_street: '100 North Main Street', billing_city: 'Example', billing_state: 'OH', billing_zip: '44000',
  phone: '(216) 555-0100', care_type: 'Assisted Living', lifetime_revenue: 0, outstanding_ar: 0, note: '',
  ...changes,
});
const person = (contact_id, account_id, changes = {}) => ({ contact_id, account_id, name: 'Taylor Example', email: 'taylor@example.test', is_active: true, ...changes });
const snapshot = (accounts = [], contacts = []) => ({ accounts: [parent, legacy, ...accounts], contacts, facilities: [], coverage: { complete: true, expected: 0, found: 0, urls: [] } });
const category = (proposals, value) => proposals.filter((p) => p.quality.category === value);
const duplicate = (proposals) => proposals.find((p) => p.quality.category === 'duplicate');

test('quality checks cover all parents and retain the uniquely billed survivor', async () => {
  const input = snapshot([account('a'), account('b', { lifetime_revenue: 1200, outstanding_ar: 80 })]);
  const before = structuredClone(input);
  const p = duplicate(await crmQuality(input));
  assert(p);
  const option = p.options.find((o) => o.id === 'consolidate:b');
  assert.deepEqual(option.operations.map((o) => [o.account_id, o.type, o.fields]), [['a', 'duplicate', { status: 'Inactive', duplicate_of_account: 'b' }]]);
  assert.match(option.label, /b.*a/);
  assert.deepEqual(input, before, 'Detection must not mutate CRM source data');
});

test('quality offers a conditional CHOW link to the existing unbilled successor without inferring ownership', async () => {
  const old = account('old', { lifetime_revenue: 130000, outstanding_ar: 5200, status: 'Needs Review' });
  const next = account('next', { name: 'Other Operator Facility', parent_id: parent.account_id });
  const input = snapshot([old, next]), before = structuredClone(input);
  const p = category(await crmQuality(input), 'account_overlap')[0];
  const choice = p.options.find((o) => o.id === 'chow-link:old:next');
  assert(choice);
  assert.match(choice.label, /If ownership is confirmed/);
  assert.equal(choice.operations.length, 1);
  assert.deepEqual(choice.operations[0].fields, { chow_current_account: 'next' });
  assert.equal(choice.operations[0].type, 'chow_link');
  assert.deepEqual(choice.operations[0].dependencies.map((a) => a.account_id).sort(), ['bellhaven', 'legacy', 'next']);
  assert(p.options.some((o) => o.id === 'flag'));
  assert(p.options.some((o) => o.id === 'acknowledge'));
  assert.deepEqual(input, before);
  const reordered = structuredClone(input);
  reordered.accounts.reverse().forEach((a) => { a.updated_at = 'later'; a.parent_name = 'Cache only'; });
  assert.equal(category(await crmQuality(reordered), 'account_overlap')[0].version, p.version);
  input.accounts.find((a) => a.account_id === 'legacy').name = 'Verified different parent identity';
  assert.notEqual(category(await crmQuality(input), 'account_overlap')[0].version, p.version, 'Parent evidence is bound into the immutable choice');
});

test('quality CHOW suggestions withhold ambiguous history, bad parents and billing or address conflicts', async () => {
  const old = account('old', { lifetime_revenue: 130000, outstanding_ar: 5200 });
  const next = account('next', { parent_id: parent.account_id });
  for (const change of [
    (s) => { s.accounts.find((a) => a.account_id === 'next').lifetime_revenue = 1; },
    (s) => { s.accounts.find((a) => a.account_id === 'next').outstanding_ar = -1; },
    (s) => { s.accounts.find((a) => a.account_id === 'next').outstanding_ar = null; },
    (s) => { s.accounts.find((a) => a.account_id === 'old').outstanding_ar = 0; },
    (s) => { s.accounts.find((a) => a.account_id === 'next').billing_zip = '44001'; },
    (s) => { s.accounts.find((a) => a.account_id === 'next').status = 'Needs Review'; },
    (s) => { s.accounts.find((a) => a.account_id === 'legacy').status = 'Needs Review'; },
    (s) => { s.accounts.find((a) => a.account_id === 'legacy').parent_id = 'old'; },
    (s) => { s.accounts.find((a) => a.account_id === 'legacy').parent_id = 'missing'; },
    (s) => { s.accounts.push(account('third')); },
    (s) => { s.accounts.push(account('history', { chow_current_account: 'next', billing_street: '200 Main St' })); },
  ]) {
    const input = snapshot(structuredClone([old, next]));
    input.accounts = structuredClone(input.accounts);
    change(input);
    assert(!(await crmQuality(input)).some((p) => p.options.some((o) => o.operations.some((op) => op.type === 'chow_link'))));
  }
});

test('quality duplicates require affirmative corroboration and safe losing records', async () => {
  for (const change of [
    { name: 'Another Facility' }, { parent_id: 'bellhaven' }, { billing_zip: '44001' },
    { phone: '(216) 555-0101' }, { care_type: 'Memory Care' }, { phone: '' },
    { lifetime_revenue: null }, { outstanding_ar: -1 }, { lifetime_revenue: -1 },
    { parent_id: 'missing' }, { parent_id: '' }, { status: 'Needs Review' },
  ]) {
    const input = snapshot([account('a'), account('b', change)]);
    const p = category(await crmQuality(input), 'account_overlap')[0];
    assert(p, JSON.stringify(change));
    assert(!p.options.some((o) => o.operations.some((operation) => operation.type === 'duplicate')));
    const flag = p.options.find((o) => o.id === 'flag');
    assert(flag.operations.every((o) => Object.keys(o.fields).every((key) => ['status', 'note'].includes(key))));
  }
});

test('quality duplicates preserve CHOW history, incoming links, billing on both copies and contacts', async () => {
  const cases = [
    snapshot([account('a', { lifetime_revenue: 10 }), account('b', { lifetime_revenue: 20 })]),
    snapshot([account('a'), account('b')], [person('c1', 'a'), person('c2', 'b')]),
    snapshot([account('a'), account('b'), account('old', { chow_current_account: 'b', billing_street: '200 Main St' })]),
    snapshot([account('a'), account('b'), account('old', { duplicate_of_account: 'b', status: 'Inactive' })]),
  ];
  for (const input of cases) assert.equal(duplicate(await crmQuality(input)), undefined);
  const p = duplicate(await crmQuality(snapshot([account('a'), account('b')], [person('c1', 'b')])));
  assert.equal(p.options[0].id, 'consolidate:b', 'The sole contact-bearing account can be kept without moving contacts');
});

test('quality does not group blank, PO box or parent records and does not repeat facility duplicate reviews', async () => {
  for (const street of ['', 'PO Box 51', 'P.O. Box 51']) {
    const proposals = await crmQuality(snapshot([account('a', { billing_street: street }), account('b', { billing_street: street })]));
    assert.equal(proposals.length, 0);
  }
  const input = snapshot([account('a'), account('b')]);
  const existing = [{ kind: 'duplicate', parent, candidates: input.accounts.slice(2).map((a) => ({ account: a, contacts: [] })) }];
  assert.equal((await crmQuality(input, existing)).length, 0);
  const withExtra = snapshot([...input.accounts.slice(2), account('c')]);
  assert(duplicate(await crmQuality(withExtra, existing)), 'New group member must not be hidden by older facility case');
});

test('quality evidence is stable under ordering and timestamps; contacts and billing are material', async () => {
  const input = snapshot([account('a'), account('b')], [person('c1', 'a')]);
  const p = duplicate(await crmQuality(input));
  const reordered = structuredClone(input);
  reordered.accounts.reverse().forEach((a) => { a.updated_at = 'later'; a.parent_name = 'rendering cache'; });
  reordered.contacts.reverse().forEach((c) => { c.updated_at = 'later'; c.created_by_candidate = true; });
  assert.equal(duplicate(await crmQuality(reordered)).version, p.version);
  reordered.contacts[0].title = 'New title';
  assert.notEqual(duplicate(await crmQuality(reordered)).version, p.version);
  const changed = structuredClone(input);
  changed.accounts.find((a) => a.account_id === 'a').outstanding_ar = 10;
  assert.notEqual(duplicate(await crmQuality(changed)).version, p.version);
});

test('quality flag annotations produce fresh immutable evidence and remain stable after their first application', async () => {
  const input = snapshot([account('a', { name: 'First', status: 'Needs Review', note: 'Human note' }), account('b', { name: 'Second', status: 'Needs Review' })]);
  const p = category(await crmQuality(input), 'account_overlap')[0];
  const applied = structuredClone(input);
  for (const op of p.options.find((o) => o.id === 'flag').operations) Object.assign(applied.accounts.find((a) => a.account_id === op.account_id), op.fields);
  const fresh = category(await crmQuality(applied), 'account_overlap')[0];
  assert.notEqual(fresh.version, p.version, 'The engine records this postresolution version; another pending proposal must see the changed immutable note');
  for (const op of fresh.options.find((o) => o.id === 'flag').operations) Object.assign(applied.accounts.find((a) => a.account_id === op.account_id), op.fields);
  assert.equal(category(await crmQuality(applied), 'account_overlap')[0].version, fresh.version);
  assert.equal(fresh.options.find((o) => o.id === 'flag').operations[0].fields.note.split('[crm-quality:').length, 2, 'Annotation is not appended repeatedly');
  applied.accounts.find((a) => a.account_id === 'a').note += '\nNew verified ownership evidence';
  assert.notEqual(category(await crmQuality(applied), 'account_overlap')[0].version, p.version);
});

test('quality note updates preserve annotations from other independent reviews', async () => {
  const input = snapshot([account('a', { name: 'First', note: 'Human note\n[crm-quality:another-case] Earlier reviewed issue' }), account('b', { name: 'Second' })]);
  const p = category(await crmQuality(input), 'account_overlap')[0];
  const note = p.options.find((o) => o.id === 'flag').operations.find((o) => o.account_id === 'a').fields.note;
  assert.match(note, /Human note/);
  assert.match(note, /\[crm-quality:another-case\] Earlier reviewed issue/);
});

test('quality relationship checks detect dangling links, parent and mixed-history cycles', async () => {
  const input = snapshot([
    account('a', { parent_id: 'b', billing_street: '' }), account('b', { parent_id: 'a', billing_street: '' }),
    account('c', { chow_current_account: 'd', billing_street: '' }), account('d', { duplicate_of_account: 'c', billing_street: '' }),
    account('e', { parent_id: 'missing', chow_current_account: 'gone', billing_street: '' }),
  ]);
  const checks = category(await crmQuality(input), 'relationship');
  assert.equal(checks.filter((p) => p.key.includes('parent-cycle')).length, 1);
  assert.equal(checks.filter((p) => p.key.includes('history-cycle')).length, 1);
  assert(checks.some((p) => p.key.includes('missing-parent_id')));
  assert(checks.some((p) => p.key.includes('missing-chow_current_account')));
  assert(checks.every((p) => p.options.every((o) => !o.operations.length)), 'Unverified relationship corrections must never be invented');
});

test('quality relationship checks include contradictory targets and inactive chain terminals', async () => {
  const input = snapshot([
    account('a', { chow_current_account: 'b', duplicate_of_account: 'c', billing_street: '' }),
    account('b', { status: 'Inactive', billing_street: '' }), account('c', { billing_street: '' }),
  ]);
  const checks = category(await crmQuality(input), 'relationship');
  assert(checks.some((p) => p.key.includes('conflicting-history')));
  assert(checks.some((p) => p.key.includes('inactive-target')));
});

test('quality treats unknown/invalid billing as a review issue and preserves valid credit balances', async () => {
  for (const [value, expected] of [[null, 1], ['', 1], ['oops', 1], [-10, 1], ['0', 0], [0, 0]]) {
    const proposals = await crmQuality(snapshot([account('a', { lifetime_revenue: value })]));
    assert.equal(category(proposals, 'billing').length, expected);
  }
  assert.equal(category(await crmQuality(snapshot([account('a', { outstanding_ar: -10 })])), 'billing').length, 0);
});

test('quality shared email check distinguishes people and captures full supporting contacts', async () => {
  const input = snapshot([account('a'), account('b', { billing_street: '200 Main St' })], [
    person('one', 'a', { email: ' INBOX@EXAMPLE.TEST ' }),
    person('two', 'b', { name: 'Morgan Example', email: 'inbox@example.test' }),
    person('three', 'a', { email: 'other@example.test' }),
  ]);
  const p = category(await crmQuality(input), 'shared_email')[0];
  assert.equal(p.quality.contacts.length, 3);
  assert.equal(p.options[0].operations.length, 0);
  input.contacts[1].name = input.contacts[0].name;
  assert.equal(category(await crmQuality(input), 'shared_email').length, 0, 'Same person across accounts is not an identity conflict');
});

test('quality retired and orphan contact checks never migrate contacts or edit historical accounts', async () => {
  const input = snapshot([account('old', { chow_current_account: 'new' }), account('new')], [
    person('one', 'old'), person('two', 'missing', { is_active: false }),
  ]);
  const proposals = await crmQuality(input);
  const retired = category(proposals, 'retired_contact')[0], orphan = category(proposals, 'orphan_contact')[0];
  assert.equal(retired.alternatives[0].account.account_id, 'new');
  assert.equal(orphan.candidates.length, 0);
  assert.equal(orphan.quality.contacts[0].contact_id, 'two');
  assert(proposals.every((p) => p.options.every((o) => !o.operations.length)));
  input.contacts[0].is_active = false;
  assert.equal(category(await crmQuality(input), 'retired_contact').length, 0);
});

test('quality contact-link decisions are not reopened by unrelated account fields', async () => {
  const input = snapshot([account('old', { duplicate_of_account: 'new', status: 'Inactive' }), account('new')], [person('one', 'old')]);
  const before = category(await crmQuality(input), 'retired_contact')[0];
  input.accounts.find((a) => a.account_id === 'new').phone = '(216) 555-0300';
  input.accounts.find((a) => a.account_id === 'old').note = 'Updated billing annotation';
  input.accounts.find((a) => a.account_id === 'old').outstanding_ar = 20;
  assert.equal(category(await crmQuality(input), 'retired_contact')[0].version, before.version);
  input.contacts[0].name = 'Updated contact identity';
  assert.notEqual(category(await crmQuality(input), 'retired_contact')[0].version, before.version);
});

function websiteInput(changes = {}) {
  const a = account('a', { parent_id: parent.account_id, ...changes });
  const facility = { name: a.name, street_address: a.billing_street, city: a.billing_city, state: a.billing_state, postal_code: a.billing_zip, phone_raw: '(216) 555-0200', care_offerings: ['Assisted Living', 'Memory Support'], source_url: 'https://example.test/facility' };
  const input = snapshot([a]);
  input.facilities = [facility];
  return { input, proposals: [{ kind: 'unchanged', parent, key: facility.source_url, facility, candidates: [{ account: a, contacts: [] }] }], facility };
}

test('quality website fields catch a phone-only difference on an otherwise unchanged case', async () => {
  const { input, proposals } = websiteInput();
  const p = category(await crmQuality(input, proposals), 'website_fields')[0];
  assert.equal(p.options.length, 2);
  assert.equal(p.options[0].operations.length, 0);
  const update = p.options.find((o) => o.field_choices.phone.selected);
  assert.deepEqual(update.operations[0].fields, { phone: '(216) 555-0200' });
  assert(!update.field_choices.care_type, 'A supported current scalar care category is preserved');
  proposals[0].kind = 'parent_correction';
  assert.equal(category(await crmQuality(input, proposals), 'website_fields').length, 0, 'Existing actionable cases already contain these controls');
});

test('quality website fields offer supported scalar categories and preserve full website care list in notes', async () => {
  const { input, proposals } = websiteInput({ care_type: 'Independent Living' });
  const p = category(await crmQuality(input, proposals), 'website_fields')[0];
  assert.equal(p.options.length, 6);
  for (const option of p.options.filter((o) => o.field_choices.care_type.selected)) {
    const fields = option.operations[0].fields;
    assert(['Assisted Living', 'Memory Care'].includes(fields.care_type));
    assert.match(fields.note, /Assisted Living; Memory Support/);
    assert(!Object.hasOwn(fields, 'care_offerings'));
  }
});

test('quality respects previously reviewed optional fields individually', async () => {
  const { input, proposals, facility } = websiteInput({ care_type: 'Independent Living' });
  const reviewed = new Map([[facility.source_url, new Set(['phone'])]]);
  const p = category(await crmQuality(input, proposals, reviewed), 'website_fields')[0];
  assert.equal(p.options.length, 3);
  assert(p.options.every((o) => !o.field_choices.phone));
  reviewed.get(facility.source_url).add('care_type');
  assert.equal(category(await crmQuality(input, proposals, reviewed), 'website_fields').length, 0);
});
