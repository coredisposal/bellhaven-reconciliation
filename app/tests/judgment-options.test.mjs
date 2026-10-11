import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../lib/core.mjs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };

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
    billing_street: '999 Different Road', billing_city: 'Distant',
    billing_state: 'CO', billing_zip: '80903', care_type: 'Assisted Living',
    phone: '(719) 555-0199', note: 'Existing billing instructions.',
  };
  return {
    facilities: [facility], accounts: [parent, account], contacts: [{
      contact_id: 'contact', account_id: account.account_id, name: 'Other Person',
      is_active: true,
    }],
    coverage: { complete: true, expected: 1, found: 1, urls: [facility.source_url] },
  };
}
async function caseFor(data, index = 0) {
  const result = (await reconcile(data)).find((p) => p.key === data.facilities[index].source_url);
  assert(result);
  return result;
}
const existing = (p, id = 'facility') => p.options.find((o) => o.account_id === id);
const separate = (p) => p.options.find((o) => o.resolution === 'separate');
const baseOptions = (p) => p.options.filter((option) => !option.base_option_id || option.id === option.base_option_id);
function assertJudgment(p) {
  assert.equal(p.kind, 'ambiguous');
  assert(!Object.hasOwn(p, 'selected_option'), 'Rules never make the reviewer choice');
  const records = new Set([...p.candidates, ...p.alternatives].map((c) => c.account.account_id));
  assert.equal(new Set(p.options.map((o) => o.id)).size, p.options.length);
  for (const o of p.options) {
    assert(['separate', 'existing'].includes(o.resolution));
    assert.match(o.reason, /verif/i);
    assert(o.operations.length, 'Every choice contains a concrete reviewable operation');
    if (o.resolution === 'existing') assert(records.has(o.account_id), 'No orphan account options');
    assert(!o.operations.some((op) => op.type === 'duplicate'), 'Judgment never silently retires another account');
  }
}

test('judgment: Amberly offers explicit separate or Juniper identity choices without deciding for the reviewer', async () => {
  const data = structuredClone(baseline);
  const before = structuredClone(data);
  const p = (await reconcile(data)).find((row) => row.title === 'Amberly Manor');
  assertJudgment(p);
  assert.equal(baseOptions(p).length, 2);
  const reuse = p.options.find((o) => o.resolution === 'existing');
  assert.match(reuse.label, /Use existing account: Amberly Manor.*Colorado Springs, CO/);
  assert.match(reuse.label, new RegExp(reuse.account_id));
  assert.equal(separate(p).label, 'Create a separate facility account');
  assert.deepEqual(data, before, 'Reconciliation is pure; creating options never mutates CRM input');
});

test('judgment: separate facility creation preserves every existing record and starts clean billing', async () => {
  const data = sample();
  const p = await caseFor(data);
  assertJudgment(p);
  const choice = separate(p);
  assert.deepEqual(choice.operations.map((op) => op.type), ['create']);
  assert(!choice.operations[0].account_id);
  assert.equal(choice.operations[0].fields.parent_id, 'parent');
  assert.equal(choice.operations[0].fields.lifetime_revenue, 0);
  assert.equal(choice.operations[0].fields.outstanding_ar, 0);
  assert(!Object.hasOwn(choice.operations[0].fields, 'duplicate_of_account'));
});

test('judgment: confirmed reuse corrects physical locality and records previous values without changing phones or balances', async () => {
  const data = sample();
  Object.assign(data.accounts[1], { lifetime_revenue: 500, outstanding_ar: 0 });
  const p = await caseFor(data);
  const choice = existing(p);
  assertJudgment(p);
  assert.equal(choice.resolution, 'existing');
  const op = choice.operations[0];
  assert.equal(op.type, 'patch');
  assert.equal(op.account_id, 'facility');
  assert.deepEqual(Object.fromEntries(['billing_street', 'billing_city', 'billing_state', 'billing_zip']
    .map((field) => [field, op.fields[field]])), {
    billing_street: '100 N Main Street', billing_city: 'Example', billing_state: 'OH', billing_zip: '44000',
  });
  assert.match(op.fields.note, /^Existing billing instructions\./);
  assert.match(op.fields.note, /Prior observed CRM billing address.*999 Different Road, Distant, CO 80903/);
  for (const field of ['phone', 'lifetime_revenue', 'outstanding_ar', 'duplicate_of_account', 'chow_current_account'])
    assert(!Object.hasOwn(op.fields, field));
  assert.deepEqual(op.before, data.accounts[1]);
});

test('judgment: old names are retained with qualified provenance after verified address conflicts', async () => {
  const data = sample();
  Object.assign(data.accounts[1], {
    name: 'Former Care Center', billing_city: 'Example', billing_state: 'OH',
    phone: data.facilities[0].phone_raw,
  });
  data.contacts[0].name = data.facilities[0].administrator;
  const p = await caseFor(data);
  assertJudgment(p);
  const fields = existing(p).operations[0].fields;
  assert.equal(fields.name, 'Example Manor');
  assert.match(fields.note, /Prior observed CRM name \(not a verified official alias\): Former Care Center/);
});

test('judgment: use-existing obeys every revenue and AR branch and never consolidates other billing accounts', async () => {
  for (const [revenue, ar, type] of [[0, 0, 'patch'], [100, 0, 'patch'], [0, 100, 'patch'], [100, 100, 'chow']]) {
    const data = sample();
    Object.assign(data.accounts[1], { lifetime_revenue: revenue, outstanding_ar: ar });
    const before = structuredClone(data.accounts[1]);
    const choice = existing(await caseFor(data));
    assert.equal(choice.operations.length, 1);
    const op = choice.operations[0];
    assert.equal(op.type, type);
    assert.equal(op.account_id, before.account_id);
    assert.deepEqual(op.before, before);
    if (type === 'chow') {
      assert.equal(op.fields.parent_id, 'parent');
      assert.equal(op.fields.lifetime_revenue, 0);
      assert.equal(op.fields.outstanding_ar, 0);
      assert.equal(op.before.parent_id, 'legacy');
      assert.equal(op.before.note, 'Existing billing instructions.');
      assert.match(choice.reason, /old account receives only the CHOW link/);
    } else {
      assert(!Object.hasOwn(op.fields, 'lifetime_revenue'));
      assert(!Object.hasOwn(op.fields, 'outstanding_ar'));
    }
  }
});

test('judgment: a legitimate PO box remains intact even when verified reuse resolves a city or state conflict', async () => {
  const data = sample();
  data.accounts[1].billing_street = 'P.O. Box 171';
  const p = await caseFor(data);
  assertJudgment(p);
  const fields = existing(p).operations[0].fields;
  assert.equal(fields.parent_id, 'parent');
  for (const field of ['billing_street', 'billing_city', 'billing_state', 'billing_zip'])
    assert(!Object.hasOwn(fields, field), 'The complete mailing address remains unchanged');
});

test('judgment: an inactive unlinked identity offers an explicitly labeled reactivation', async () => {
  const data = sample();
  data.accounts[1].status = 'Inactive';
  const p = await caseFor(data);
  assertJudgment(p);
  const choice = existing(p);
  assert.match(choice.label, /Reactivate/);
  assert.equal(choice.operations[0].fields.status, 'Active');
  assert.equal(choice.operations[0].before.status, 'Inactive');
  Object.assign(data.accounts[1], { lifetime_revenue: 500, outstanding_ar: 20 });
  const chow = existing(await caseFor(data));
  assert.equal(chow.operations[0].type, 'chow');
  assert.equal(chow.operations[0].before.status, 'Inactive');
  assert.match(chow.label, /Preserve inactive history with CHOW/);
  assert(!/Reactivate/.test(chow.label));
});

test('judgment: missing or malformed billing is a global hold that separate creation cannot bypass', async () => {
  for (const field of ['lifetime_revenue', 'outstanding_ar'])
    for (const value of [undefined, null, '', 'unknown', Number.NaN]) {
      const data = sample();
      data.accounts[1][field] = value;
      const p = await caseFor(data);
      assert.equal(p.kind, 'ambiguous');
      assert.deepEqual(p.options, []);
      assert.match(p.summary, /Billing fields are missing or invalid/);
    }
});

test('judgment: a broken historical exact-name link cannot be bypassed with a separate account', async () => {
  for (const field of ['chow_current_account', 'duplicate_of_account']) {
    const data = sample();
    data.accounts[1][field] = 'missing-current-record';
    const p = await caseFor(data);
    assert.equal(p.kind, 'ambiguous');
    assert.deepEqual(p.options, []);
    assert.equal(p.link_conflicts.length, 1);
    assert.match(p.summary, /historical account/);
  }
});

test('judgment: multiple billing accounts offer isolated reuse choices without retiring any other record', async () => {
  const data = sample();
  const f = data.facilities[0];
  Object.assign(data.accounts[1], {
    billing_street: f.street_address, billing_city: f.city, billing_state: f.state,
    billing_zip: f.postal_code, lifetime_revenue: 100, outstanding_ar: 20,
  });
  data.accounts.push({ ...data.accounts[1], account_id: 'second', outstanding_ar: 0 });
  const p = await caseFor(data);
  assertJudgment(p);
  assert.equal(baseOptions(p).length, 3);
  for (const choice of p.options.filter((o) => o.resolution === 'existing')) {
    assert.equal(choice.operations.length, 1);
    assert.equal(choice.operations[0].account_id, choice.account_id);
    assert.match(choice.reason, /Other accounts remain unchanged/);
  }
});

test('judgment: a shared candidate cannot be assigned to one location and options contain no orphan account', async () => {
  const data = sample();
  const f = data.facilities[0];
  Object.assign(data.accounts[1], {
    billing_street: 'PO Box 17', billing_city: f.city, billing_state: f.state, phone: f.phone_raw,
  });
  data.facilities.push({ ...f, street_address: '500 South Road', source_url: f.source_url + '-second' });
  for (const index of [0, 1]) {
    const p = await caseFor(data, index);
    assertJudgment(p);
    assert.deepEqual(p.options.map((o) => o.resolution), ['separate']);
    assert(p.matching_conflicts.some((c) => c.kind === 'shared_account'));
  }
});

test('judgment: a name-only conflict cannot steal the unique account of another website location', async () => {
  const data = sample();
  const a = data.accounts[1];
  data.facilities.push({
    ...data.facilities[0], street_address: a.billing_street, city: a.billing_city,
    state: a.billing_state, postal_code: a.billing_zip,
    source_url: data.facilities[0].source_url + '-elsewhere',
  });
  const p = await caseFor(data);
  assertJudgment(p);
  assert.deepEqual(p.options.map((o) => o.resolution), ['separate']);
  assert.equal(p.matching_conflicts.find((c) => c.kind === 'shared_account').account_id, a.account_id);
  const physical = await caseFor(data, 1);
  assert.equal(physical.kind, 'parent_correction');
  assert.equal(physical.options[0].id, a.account_id);
});

test('judgment: billing-conflict records needing no correction receive a reviewable identity note, not an empty operation', async () => {
  const data = sample();
  const f = data.facilities[0];
  Object.assign(data.accounts[1], {
    parent_id: 'parent', billing_street: f.street_address, billing_city: f.city,
    billing_state: f.state, billing_zip: f.postal_code, phone: f.phone_raw,
    lifetime_revenue: 100,
  });
  data.contacts = [];
  data.accounts.push({ ...data.accounts[1], account_id: 'second' });
  const p = await caseFor(data);
  assertJudgment(p);
  for (const choice of p.options.filter((o) => o.resolution === 'existing')) {
    assert.deepEqual(Object.keys(choice.operations[0].fields), ['note']);
    assert.match(choice.operations[0].fields.note, /identity confirmed through approved review/);
  }
});

test('judgment: existing physical-match tie choices retain explicit survivor and duplicate retirement semantics', async () => {
  const p = (await reconcile(structuredClone(baseline))).find((row) => row.title.includes('Kettering'));
  assert.equal(p.kind, 'ambiguous');
  assert.equal(baseOptions(p).length, 6);
  const consolidation = baseOptions(p).filter((o) => !o.resolution);
  assert.equal(consolidation.length, 3);
  assert(consolidation.every((o) => p.candidates.some((c) => c.account.account_id === o.id)));
  for (const choice of consolidation) {
    const retired = choice.operations.filter((op) => op.type === 'duplicate');
    assert.equal(retired.length, 2);
    assert(retired.every((op) => op.fields.duplicate_of_account === choice.id));
    assert(retired.every((op) => op.before.lifetime_revenue === 0 && op.before.outstanding_ar === 0));
  }
});

test('judgment: duplicate alternatives update only supported survivors without changing other copies', async () => {
  const cases = await reconcile(structuredClone(baseline));
  const duplicates = cases.filter((p) => p.kind === 'duplicate' || p.title.includes('Kettering'));
  assert.equal(duplicates.length, 5);
  for (const p of duplicates) {
    const normal = baseOptions(p).filter((o) => !o.resolution);
    const isolated = baseOptions(p).filter((o) => o.resolution === 'existing');
    assert.deepEqual(isolated.map((o) => o.account_id), normal.map((o) => o.id));
    assert.equal(new Set(p.options.map((o) => o.id)).size, p.options.length);
    assert(!p.options.some((o) => o.resolution === 'separate'));
    for (const choice of isolated) {
      assert.match(choice.label, /only; keep other accounts/);
      assert.match(choice.reason, /Other accounts, their balances and contacts remain unchanged/);
      assert.equal(choice.operations.length, 1);
      const op = choice.operations[0];
      assert(['patch', 'chow'].includes(op.type));
      assert.equal(op.account_id, choice.account_id);
      assert(!Object.hasOwn(op.fields, 'duplicate_of_account'));
    }
  }
  for (const p of cases.filter((p) => !duplicates.includes(p) && p.kind !== 'ambiguous'))
    assert(!p.options.some((o) => o.resolution), `${p.title} retains its ordinary proposal`);
});

test('judgment: options deduplicate overlapping evidence and versions are stable across response ordering', async () => {
  const data = sample();
  Object.assign(data.accounts[1], {
    billing_city: data.facilities[0].city, billing_state: data.facilities[0].state,
    phone: data.facilities[0].phone_raw,
  });
  data.accounts.push({ ...data.accounts[1], account_id: 'second', status: 'Inactive' });
  const p = await caseFor(data);
  assertJudgment(p);
  assert.deepEqual(p.options.map((o) => o.id), ['separate', 'existing:facility', 'existing:second']);
  data.accounts.reverse();
  data.contacts.reverse();
  const reordered = await caseFor(data);
  assert.equal(reordered.version, p.version);
  assert.deepEqual(reordered.options, p.options);
});
