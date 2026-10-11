import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceMatches, reconcile, streetKey } from '../lib/core.mjs';

const copy = (value) => structuredClone(value);
function sample() {
  const facility = {
    name: 'Example Manor', street_address: '100 N Main Street', city: 'Example',
    state: 'OH', postal_code: '44000', care_offerings: ['Assisted Living'],
    phone_raw: '(216) 555-0100', administrator: 'Taylor Example',
    source_url: 'https://example.test/communities/example',
  };
  const parent = {
    account_id: 'parent', name: 'Bellhaven Senior Living (Parent Account)', parent_id: '',
    billing_street: '', billing_city: '', billing_state: '', billing_zip: '',
    phone: '', status: 'Active', lifetime_revenue: 0, outstanding_ar: 0,
    duplicate_of_account: '', chow_current_account: '',
  };
  const account = {
    ...parent, account_id: 'facility', name: facility.name, parent_id: 'legacy',
    billing_street: '100 North Main St', billing_city: facility.city,
    billing_state: facility.state, billing_zip: facility.postal_code,
    care_type: 'Assisted Living', phone: facility.phone_raw, note: '',
  };
  const contact = {
    contact_id: 'contact', account_id: account.account_id, name: facility.administrator,
    title: 'Administrator', is_active: true,
  };
  return {
    facilities: [facility], accounts: [parent, account], contacts: [contact],
    coverage: { complete: true, expected: 1, found: 1, urls: [facility.source_url] },
  };
}
async function caseFor(data, index = 0) {
  const row = (await reconcile(data)).find((p) => p.key === data.facilities[index].source_url);
  assert(row);
  return row;
}
function held(p, reason) {
  assert.equal(p.kind, 'ambiguous');
  assert(p.options.every((o) => o.resolution), 'Identity choices must be explicit reviewer resolutions');
  assert(p.matching_conflicts.some((conflict) => conflict.kind === reason));
}

test('matching: different current parents do not prevent physical matches or alter the CHOW billing rule', async () => {
  for (const [revenue, ar, expected] of [[0, 0, 'patch'], [100, 0, 'patch'], [0, 100, 'patch'], [100, 100, 'chow']]) {
    const data = sample();
    Object.assign(data.accounts[1], { lifetime_revenue: revenue, outstanding_ar: ar });
    const before = copy(data);
    const p = await caseFor(data);
    assert.equal(p.kind, expected === 'chow' ? 'chow' : 'parent_correction');
    const op = p.options[0].operations[0];
    assert.equal(op.type, expected);
    assert.equal(op.account_id, 'facility');
    assert.equal(op.fields.parent_id, 'parent');
    if (expected === 'chow') {
      assert.equal(op.before.parent_id, 'legacy');
      assert.equal(op.before.lifetime_revenue, revenue);
      assert.equal(op.before.outstanding_ar, ar);
      assert.equal(op.fields.lifetime_revenue, 0);
      assert.equal(op.fields.outstanding_ar, 0);
    }
    assert.deepEqual(data, before, 'Matching is pure and cannot modify source records');
  }
});

test('matching: an inactive or historical Bellhaven parent cannot receive facility accounts', async () => {
  for (const changes of [
    { status: 'Inactive' },
    { chow_current_account: 'replacement-parent' },
    { duplicate_of_account: 'current-parent' },
  ]) {
    const data = sample();
    Object.assign(data.accounts[0], changes);
    await assert.rejects(reconcile(data), /Bellhaven parent is inactive or historical/);
  }
});

test('matching: exact-name collisions across states require identity review regardless of current parent', async () => {
  for (const parent of ['parent', 'legacy']) {
    const data = sample();
    Object.assign(data.accounts[1], {
      parent_id: parent, billing_street: '999 Different Road', billing_city: 'Distant',
      billing_state: 'CO', billing_zip: '80903', phone: '(719) 555-0123',
    });
    data.contacts[0].name = 'Different Administrator';
    const p = await caseFor(data);
    held(p, 'name_collision');
    assert.equal(p.candidates.length, 0);
    assert.equal(p.alternatives[0].account.account_id, 'facility');
    assert(p.alternatives[0].reasons.includes('Same normalized name'));
    assert(p.alternatives[0].conflicts.includes('Different city or state'));
    assert(p.options.some((o) => o.resolution === 'separate'));
    assert(p.options.some((o) => o.resolution === 'existing' && o.account_id === 'facility'));
  }
});

test('matching: missing or conflicting addresses with multiple identity signals require verification instead of creation', async () => {
  for (const address of ['', '101 North Main St']) {
    for (const support of ['name-phone', 'name-administrator', 'phone-administrator']) {
      const data = sample();
      data.accounts[1].billing_street = address;
      data.accounts[1].parent_id = 'parent';
      if (support === 'name-phone') data.contacts = [];
      if (support === 'name-administrator') data.accounts[1].phone = '(216) 555-0999';
      if (support === 'phone-administrator') data.accounts[1].name = 'Prior Facility Name';
      const rows = await reconcile(data);
      const p = rows.find((row) => row.key === data.facilities[0].source_url);
      held(p, 'address_conflict');
      assert.deepEqual(p.matching_conflicts.map((conflict) => conflict.kind), ['address_conflict']);
      assert.equal(p.alternatives[0].account.account_id, 'facility');
      assert(!rows.some((row) => row.key === 'absent:facility'), 'One identity conflict must not also become an absence update');
    }
  }
});

test('matching: same street/name/phone with conflicting locality is held without overwriting locality', async () => {
  const data = sample();
  data.accounts[1].billing_city = 'Outdated Locality';
  data.accounts[1].billing_state = 'PA';
  const p = await caseFor(data);
  held(p, 'address_conflict');
  assert(p.alternatives[0].conflicts.includes('Different city or state'));
});

test('matching: common city, a shared phone alone, empty administrator or invalid short phone cannot authorize a match', async () => {
  for (const [weak, parent] of ['same-name', 'shared-phone', 'empty-administrator', 'short-phone']
    .flatMap((weak) => ['parent', 'legacy'].map((parent) => [weak, parent]))) {
    const data = sample();
    data.accounts[1].parent_id = parent;
    data.accounts[1].billing_street = '999 Other Road';
    data.contacts = [];
    if (weak === 'same-name') data.accounts[1].phone = '(216) 555-0999';
    if (weak === 'shared-phone') data.accounts[1].name = 'Unrelated Company Facility';
    if (weak === 'empty-administrator') {
      data.facilities[0].administrator = '';
      data.accounts[1].phone = '(216) 555-0999';
      data.contacts = [{ contact_id: 'blank', account_id: 'facility', name: '', is_active: true }];
    }
    if (weak === 'short-phone') {
      data.facilities[0].phone_raw = '1234';
      data.accounts[1].phone = '1234';
    }
    const p = await caseFor(data);
    if (weak === 'shared-phone') assert.equal(p.kind, 'new_account');
    else held(p, 'name_collision');
    assert.equal(p.candidates.length, 0);
    if (weak === 'empty-administrator') assert.equal(p.alternatives[0].administrator, false);
    if (weak === 'short-phone') assert.equal(p.alternatives[0].phone, false);
  }
});

test('matching: an exact-name collision elsewhere cannot displace a verified physical match', async () => {
  const data = sample();
  data.accounts.push({
    ...data.accounts[1], account_id: 'unrelated-same-name', parent_id: 'other-parent',
    billing_street: '999 Other Road', billing_city: 'Distant', billing_state: 'CO',
    billing_zip: '80903', phone: '(719) 555-0123',
  });
  const p = await caseFor(data);
  assert.equal(p.kind, 'parent_correction');
  assert.equal(p.options[0].id, 'facility');
  assert.deepEqual(p.candidates.map((c) => c.account.account_id), ['facility']);
  assert.equal(p.alternatives[0].account.account_id, 'unrelated-same-name');
  assert(!p.matching_conflicts?.some((c) => c.kind === 'name_collision'));
});

test('matching: administrator evidence is retrieved but inactive contacts never corroborate identity', async () => {
  const data = sample();
  Object.assign(data.accounts[1], {
    name: 'Previous Facility Name', billing_street: '999 Other Road', billing_city: 'Elsewhere',
    phone: '(216) 555-0999',
  });
  const p = await caseFor(data);
  assert.equal(p.kind, 'new_account');
  assert.equal(p.alternatives.length, 1);
  assert.equal(p.alternatives[0].administrator, true);
  data.contacts[0].is_active = false;
  assert.equal((await caseFor(data)).alternatives.length, 0);
});

test('matching: an inactive physical match with no current-account link blocks accidental recreation', async () => {
  const data = sample();
  data.accounts[1].status = 'Inactive';
  const p = await caseFor(data);
  held(p, 'inactive_account');
  assert.equal(p.alternatives[0].account.status, 'Inactive');
});

test('matching: parent entities are excluded even when their mailing data exactly resembles a facility', async () => {
  const data = sample();
  const parentLike = { ...data.accounts[1], account_id: 'parent-like', parent_id: '' };
  data.accounts = [data.accounts[0], parentLike];
  parentLike.name = 'Other Company (Parent Account)';
  data.facilities[0].name = parentLike.name;
  assert.equal((await caseFor(data)).candidates.length, 0);
  parentLike.name = data.facilities[0].name = 'Company Without Type Suffix';
  data.accounts.push({ ...data.accounts[0], account_id: 'child', name: 'Unrelated', parent_id: parentLike.account_id });
  const p = await caseFor(data);
  assert.equal(p.kind, 'new_account');
  assert.equal(p.candidates.length, 0);
  assert(!p.alternatives.some((a) => a.account.account_id === parentLike.account_id));
});

test('matching: one billing account cannot silently serve multiple separate website locations', async () => {
  const data = sample();
  data.accounts[1].billing_street = 'PO Box 17';
  data.facilities.push({
    ...data.facilities[0], street_address: '500 South Main Road',
    source_url: 'https://example.test/communities/second',
  });
  data.coverage.expected = data.coverage.found = 2;
  const rows = await reconcile(data);
  for (const p of rows) {
    held(p, 'shared_account');
    assert.equal(p.matching_conflicts.find((c) => c.kind === 'shared_account').facilities.length, 2);
  }
  const reordered = copy(data);
  reordered.facilities.reverse();
  reordered.accounts.reverse();
  reordered.contacts.reverse();
  assert.deepEqual(
    Object.fromEntries((await reconcile(reordered)).map((p) => [p.key, p.version])),
    Object.fromEntries(rows.map((p) => [p.key, p.version]))
  );
  data.facilities[1].street_address = '600 South Main Road';
  assert.notEqual((await caseFor(data)).version, rows[0].version, 'Related location evidence is material to shared-account decisions');
});

test('matching: important identity conflicts remain visible beyond the nearby-alternative cutoff', async () => {
  const data = sample();
  data.accounts[1].billing_street = '';
  for (let i = 0; i < 12; i++)
    data.accounts.push({
      ...data.accounts[1], account_id: `nearby-${i}`, name: `Different facility ${i}`,
      billing_street: `${800 + i} Other Road`, phone: '', lifetime_revenue: 1000,
    });
  const p = await caseFor(data);
  held(p, 'address_conflict');
  assert.equal(p.alternatives[0].account.account_id, 'facility');
  assert.equal(p.alternatives.length, 9);
});

test('billing: credit balances keep their account ahead of unbilled duplicate copies', async () => {
  for (const credit of [-250, '-250.00']) {
    const data = sample();
    const credited = data.accounts[1];
    credited.outstanding_ar = credit;
    data.accounts.push({
      ...credited, account_id: 'unbilled', parent_id: 'parent',
      outstanding_ar: 0, lifetime_revenue: 0,
    });
    const proposal = await caseFor(data);
    assert.equal(proposal.kind, 'duplicate');
    assert.equal(proposal.candidates[0].account.account_id, credited.account_id);
    for (const option of proposal.options) {
      assert(!option.operations.some((operation) =>
        operation.type === 'duplicate' && operation.account_id === credited.account_id));
      assert(!option.operations.some((operation) => operation.type === 'chow'),
        'Credit AR does not meet the positive-AR CHOW condition');
    }
    const retirement = proposal.options[0].operations.find((operation) => operation.type === 'duplicate');
    assert.equal(retirement.account_id, 'unbilled');
    assert.equal(retirement.fields.duplicate_of_account, credited.account_id);
    assert.equal(credited.outstanding_ar, credit, 'Matching leaves the credit untouched');
  }
});

test('billing: negative balances do not broaden the exact positive-revenue and positive-AR CHOW rule', async () => {
  for (const [revenue, ar] of [[-100, 50], [100, -50], [-100, -50]]) {
    const data = sample();
    Object.assign(data.accounts[1], { lifetime_revenue: revenue, outstanding_ar: ar });
    const proposal = await caseFor(data);
    assert.equal(proposal.kind, 'parent_correction');
    assert(proposal.options.every((option) => option.operations.every((operation) => operation.type === 'patch')));
    const update = proposal.options[0].operations[0];
    assert.equal(update.fields.parent_id, 'parent');
    assert(!Object.hasOwn(update.fields, 'lifetime_revenue'));
    assert(!Object.hasOwn(update.fields, 'outstanding_ar'));
  }
});

test('billing: a credit account beside a revenue account requires judgment without retiring either', async () => {
  const data = sample();
  data.accounts[1].lifetime_revenue = 500;
  const credit = {
    ...data.accounts[1], account_id: 'credited-copy', parent_id: 'parent',
    lifetime_revenue: 0, outstanding_ar: -75,
  };
  data.accounts.push(credit);
  const proposal = await caseFor(data);
  assert.equal(proposal.kind, 'ambiguous');
  assert(proposal.options.some((option) => option.resolution === 'separate'));
  assert.deepEqual(
    proposal.options.filter((option) => option.resolution === 'existing').map((option) => option.account_id).sort(),
    ['credited-copy', 'facility']
  );
  assert(proposal.options.every((option) => option.operations.every((operation) => operation.type !== 'duplicate')));
});

test('matching: inherited object keys remain ordinary address text and unsupported care evidence', async () => {
  assert.equal(streetKey('100 Constructor Street'), '100 constructor st');
  const data = sample();
  data.facilities[0].care_offerings = ['constructor', 'toString', '__proto__'];
  data.accounts[1].care_type = 'Memory Care';
  let proposal = await caseFor(data);
  assert(proposal.options.every((option) => !option.field_choices?.care_type));
  assert(proposal.options.every((option) => option.operations.every((operation) =>
    !Object.hasOwn(operation.fields, 'care_type'))));
  assert.match(proposal.options[0].operations[0].fields.note, /constructor; toString; __proto__/);
  data.accounts = data.accounts.slice(0, 1);
  data.contacts = [];
  proposal = await caseFor(data);
  assert.equal(proposal.kind, 'new_account');
  const creation = proposal.options[0].operations[0];
  assert.equal(creation.fields.care_type, '');
  assert.match(creation.fields.note, /constructor; toString; __proto__/);
});

test('review evidence: missing versions never match an absent compatibility version', () => {
  const current = { version: 'current' };
  for (const missing of [undefined, null, ''])
    assert.equal(evidenceMatches(current, missing), false);
  assert.equal(evidenceMatches(current, 'current'), true);
  assert.equal(evidenceMatches(current, 'other'), false);
  assert.equal(evidenceMatches({ ...current, compatibility_version: 'legacy' }, 'legacy'), true);
  assert.equal(evidenceMatches(null, 'current'), false);
});

test('matching: routine parent and field corrections preserve an existing review hold', async () => {
  for (const parentId of ['legacy', 'parent']) {
    const data = sample();
    const heldAccount = data.accounts[1];
    Object.assign(heldAccount, {
      parent_id: parentId,
      status: 'Needs Review',
      note: 'Collections team: confirm invoice allocation before clearing this hold.',
    });
    const before = copy(heldAccount);
    const proposal = await caseFor(data);
    assert.equal(proposal.kind, parentId === 'legacy' ? 'parent_correction' : 'field_correction');
    for (const option of proposal.options) {
      const update = option.operations.find((operation) => operation.account_id === heldAccount.account_id);
      assert(update, 'Expected an ordinary correction for the held account');
      assert.equal(update.type, 'patch');
      assert.equal(update.fields.billing_street, data.facilities[0].street_address);
      assert(!Object.hasOwn(update.fields, 'status'), 'Identity corrections do not clear a review hold');
      if (update.fields.note) assert(update.fields.note.startsWith(before.note));
    }
    assert.deepEqual(heldAccount, before);
  }
});

test('matching: a returned website listing does not clear a review hold from freeform absence notes', async () => {
  const data = sample();
  Object.assign(data.accounts[1], {
    parent_id: 'parent',
    billing_street: data.facilities[0].street_address,
    status: 'Needs Review',
    note: '[website-absence] Not listed in an earlier crawl. Collections review also remains open.',
  });
  const proposal = await caseFor(data);
  assert.equal(proposal.kind, 'unchanged');
  assert(proposal.options.every((option) => option.operations.length === 0));
  assert.equal(proposal.candidates[0].account.status, 'Needs Review');
  assert.equal((await reconcile(data)).filter((row) => row.kind === 'absent').length, 0);
});

test('matching: verified identity choices preserve Needs Review while explicit inactive reactivation remains available', async () => {
  for (const status of ['Needs Review', 'Inactive']) {
    const data = sample();
    Object.assign(data.accounts[1], {
      billing_street: '999 Other Road',
      status,
      note: 'Existing operational status requires separate review.',
    });
    const proposal = await caseFor(data);
    assert.equal(proposal.kind, 'ambiguous');
    const choices = proposal.options.filter((option) => option.resolution === 'existing');
    assert(choices.length);
    for (const choice of choices) {
      const update = choice.operations.find((operation) => operation.account_id === 'facility');
      assert.equal(update.type, 'patch');
      assert.equal(update.fields.billing_street, data.facilities[0].street_address);
      if (status === 'Inactive') assert.equal(update.fields.status, 'Active');
      else assert(!Object.hasOwn(update.fields, 'status'));
    }
  }
});
