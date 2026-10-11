import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

// These journeys run the production bundles and D1 migrations against isolated
// upstream services. The 35-location fixture is never sent to the real CRM.
const ok = ({ status, value }) => {
  assert.equal(status, 200, JSON.stringify(value));
  return value;
};
const get = async (app, route) => ok(await app.call(route));
const post = async (app, route, body) => app.call(route, { ...(await app.reviewer()), body });
const approve = (app, proposal, choice) => post(app, 'decision', {
  id: proposal.id,
  version: proposal.version,
  optionId: choice.id,
  action: 'approve',
  note: 'Reviewed the source, conflicting records and billing. This isolated scenario confirms the selected identity.',
});
const byId = (rows) => new Map(rows.map((a) => [a.account_id, a]));

async function setup(t) {
  const hosted = await createHarness({ privateSite: false });
  let local;
  t.after(async () => {
    try { await local?.close(); } finally { await hosted.close(); }
  });
  local = await createHarness({ mode: 'proxy', backend: hosted, privateSite: false });
  return { hosted, local };
}

function currentProposal(state, key) {
  const matches = state.proposals.filter((p) => p.key === key && p.current);
  assert.equal(matches.length, 1, `Expected one current case for ${key}`);
  return matches[0];
}

async function verifyEffects(hosted, local, proposal, choice, before, writesBefore) {
  const recordsBefore = byId(before);
  const recordsAfter = byId(hosted.data.accounts);
  const created = hosted.data.accounts.filter((a) => !recordsBefore.has(a.account_id));
  const creates = choice.operations.filter((op) => ['create', 'chow'].includes(op.type));
  assert.equal(created.length, creates.length, `${proposal.title}: only the approved creates`);
  assert(creates.length <= 1, 'A facility choice has at most one replacement');
  const replacement = created[0];
  const expected = new Map(before.map((a) => [a.account_id, structuredClone(a)]));
  const touched = new Set();
  for (const op of choice.operations) {
    const fields = { ...op.fields };
    if (fields.duplicate_of_account === '$replacement')
      fields.duplicate_of_account = replacement.account_id;
    if (op.type === 'create' || op.type === 'chow') {
      assert(replacement);
      const f = proposal.facility;
      for (const [field, value] of Object.entries({
        name: f.name,
        parent_id: proposal.parent.account_id,
        billing_street: f.street_address,
        billing_city: f.city,
        billing_state: f.state,
        billing_zip: f.postal_code,
        phone: f.phone_raw,
        status: 'Active',
        lifetime_revenue: 0,
        outstanding_ar: 0,
        chow_current_account: '',
        duplicate_of_account: '',
      })) assert.equal(replacement[field], value, `${proposal.title}: new ${field}`);
      for (const care of f.care_offerings)
        assert(replacement.note.includes(care), `${proposal.title}: full care list retained`);
      assert.match(replacement.note, /\[bellhaven-op:[a-f0-9]{64}\]/);
      touched.add(replacement.account_id);
    }
    if (op.type === 'chow') {
      const old = recordsBefore.get(op.account_id);
      assert(old.lifetime_revenue > 0 && old.outstanding_ar > 0);
      assert.notEqual(old.parent_id, proposal.parent.account_id);
      expected.get(op.account_id).chow_current_account = replacement.account_id;
      assert.deepEqual(
        hosted.writes.slice(writesBefore).filter((w) => w.id === op.account_id),
        [{ method: 'PATCH', entity: 'accounts', id: op.account_id,
          fields: { chow_current_account: replacement.account_id } }],
        `${proposal.title}: the old billing account receives only its CHOW link`
      );
    } else if (op.account_id) {
      const old = recordsBefore.get(op.account_id);
      assert(!Object.hasOwn(fields, 'lifetime_revenue'));
      assert(!Object.hasOwn(fields, 'outstanding_ar'));
      if (Object.hasOwn(fields, 'parent_id') && fields.parent_id !== old.parent_id)
        assert(!(old.lifetime_revenue > 0 && old.outstanding_ar > 0),
          `${proposal.title}: direct re-parenting must pass the billing SOP`);
      if (op.type === 'duplicate') {
        assert.equal(Number(old.lifetime_revenue), 0);
        assert.equal(Number(old.outstanding_ar), 0);
        assert.equal(old.chow_current_account, '');
        assert.equal(fields.status, 'Inactive');
        assert(recordsAfter.has(fields.duplicate_of_account));
      }
      Object.assign(expected.get(op.account_id), fields);
      if (Object.hasOwn(fields, 'parent_id'))
        expected.get(op.account_id).parent_name = recordsAfter.get(fields.parent_id).name;
    }
    if (op.account_id) touched.add(op.account_id);
  }
  for (const [id, originalWithApprovedFields] of expected)
    assert.deepEqual(recordsAfter.get(id), originalWithApprovedFields,
      `${proposal.title}: unapproved fields and unrelated accounts are preserved (${id})`);
  for (const id of touched)
    assert.deepEqual(await get(local, `crm?entity=accounts&id=${id}`), recordsAfter.get(id),
      `${proposal.title}: readback through the local proxy agrees with the upstream record`);
}

test('complete review: all 35 website locations and three absent records work through the public backend and local proxy', async (t) => {
  const { hosted, local } = await setup(t);
  const originalAccounts = structuredClone(hosted.data.accounts);
  const originalContacts = structuredClone(hosted.data.contacts);
  const firstRun = ok(await post(local, 'pipeline', {}));
  assert.equal(firstRun.facilities, 35);
  assert.equal(firstRun.coverage.complete, true);
  let state = await get(local, 'state');
  const website = state.website.facilities;
  assert.equal(website.length, 35);
  assert.equal(website.flatMap((f) => f.care_offerings).length, 37);
  assert(website.some((f) => f.name === 'Bellhaven Meadows of Findlay'));
  assert.equal(hosted.writes.length, 0, 'Discovery and classification are read-only');
  const currentCases = state.proposals.filter((p) => p.current);
  const initialQuality = currentCases.filter((p) => p.kind === 'crm_quality');
  const initialCases = currentCases.filter((p) => p.kind !== 'crm_quality');
  assert.equal(currentCases.length, 42);
  assert.equal(initialCases.length, 38);
  assert.equal(initialCases.filter((p) => p.kind === 'absent').length, 3);
  assert.deepEqual(initialQuality.map((p) => p.quality.category).sort(),
    ['account_overlap', 'retired_contact', 'retired_contact', 'shared_email']);
  assert(initialQuality.every((p) => p.key.startsWith('quality:') && p.facility === null));
  assert.equal(new Set(currentCases.map((p) => p.key)).size, currentCases.length,
    'CRM-wide follow-ups use distinct cases instead of replacing facility reviews');
  const approved = [];
  const unchanged = [];
  // Refresh between reviews just as a reviewer can do after another decision:
  // candidates and alternatives may now contain freshly corrected CRM fields.
  for (const initial of initialCases.sort((a, b) => a.key.localeCompare(b.key))) {
    ok(await post(local, 'pipeline', {}));
    state = await get(local, 'state');
    const p = currentProposal(state, initial.key);
    assert.equal(p.facility?.source_url ?? null, initial.facility?.source_url ?? null);
    if (p.kind === 'unchanged') {
      assert.equal(p.title, 'Bellhaven of Ashtabula');
      assert.equal(p.status, 'unchanged');
      assert(p.options.every((o) => !o.operations.length));
      const count = hosted.writes.length;
      assert.equal((await approve(local, p, p.options[0])).status, 409);
      assert.equal(hosted.writes.length, count);
      unchanged.push(p.key);
      continue;
    }
    assert.equal(p.status, 'pending', p.title);
    assert(p.options.some((o) => o.operations.length), `${p.title}: available reviewed operation`);
    if (p.kind === 'ambiguous') assert(new Set(p.options.map((o) => o.base_option_id ?? o.id)).size >= 2,
      `${p.title}: explicit logical alternatives`);
    const selected = p.title === 'Amberly Manor'
      ? p.options.find((o) => o.resolution === 'separate')
      : p.options[0];
    assert(selected, `${p.title}: selectable resolution`);
    const before = structuredClone(hosted.data.accounts);
    const writesBefore = hosted.writes.length;
    const response = ok(await approve(local, p, selected));
    assert.equal(response.status, 'applied', p.title);
    await verifyEffects(hosted, local, p, selected, before, writesBefore);
    if (p.kind === 'absent') {
      assert.equal(selected.operations.length, 1);
      assert.deepEqual(Object.keys(selected.operations[0].fields).sort(), ['note', 'status']);
      assert.equal(selected.operations[0].fields.status, 'Needs Review');
      assert.match(selected.operations[0].fields.note, /no new owner or closure inferred/i);
    }
    assert.deepEqual(hosted.data.contacts, originalContacts, `${p.title}: contacts stay on their original accounts`);
    approved.push(p.id);
    const count = hosted.writes.length;
    assert.equal((await approve(hosted, p, selected)).status, 409,
      `${p.title}: another reviewer cannot apply the same decision twice`);
    assert.equal(hosted.writes.length, count);
  }
  assert.equal(approved.length, 37);
  assert.equal(unchanged.length, 1);
  const bellhaven = originalAccounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
  const careTypes = {
    'Short-Term Rehabilitation & Nursing': 'Skilled Nursing',
    'Assisted Living': 'Assisted Living',
    'Memory Support': 'Memory Care',
  };
  for (const f of website) {
    const active = hosted.data.accounts.filter((a) => a.parent_id === bellhaven.account_id &&
      a.name === f.name && a.status === 'Active' && !a.duplicate_of_account && !a.chow_current_account);
    assert.equal(active.length, 1, `${f.name}: one current Bellhaven facility after the complete review`);
    const account = active[0];
    if (f.name !== 'Bellhaven of Ashtabula') {
      assert.equal(account.billing_street, f.street_address, f.name);
      assert.equal(account.billing_city, f.city, f.name);
      assert.equal(account.billing_state, f.state, f.name);
      assert.equal(account.billing_zip, f.postal_code, f.name);
    }
    if (f.care_offerings.length === 1)
      assert.equal(account.care_type, careTypes[f.care_offerings[0]], f.name);
    else for (const offering of f.care_offerings)
      assert(account.note.includes(offering), `${f.name}: all care offerings survive reconciliation`);
  }
  // The broader CRM audit discovers follow-ups separate from account correction.
  // Independently identify the current evidence, then record a no-write review:
  // a shared inbox or contact on retired history is not authority to move it.
  ok(await post(local, 'pipeline', {}));
  state = await get(local, 'state');
  const qualityCases = state.proposals.filter((p) => p.current && p.kind === 'crm_quality');
  const accountMap = byId(hosted.data.accounts);
  const retiredWithContacts = hosted.data.accounts.filter((a) =>
    (a.status === 'Inactive' || a.chow_current_account || a.duplicate_of_account) &&
    hosted.data.contacts.some((c) => c.account_id === a.account_id && c.is_active !== false));
  const expectedQualityKeys = [
    ...retiredWithContacts.map((a) => `quality:retired-contacts:${a.account_id}`),
    initialQuality.find((p) => p.quality.category === 'account_overlap').key,
    initialQuality.find((p) => p.quality.category === 'shared_email').key,
  ].sort();
  assert.deepEqual(qualityCases.map((p) => p.key).sort(), expectedQualityKeys,
    'Only independently identified contact and Sandusky ownership follow-ups remain');
  const writesBeforeFollowups = hosted.writes.length;
  const accountsBeforeFollowups = structuredClone(hosted.data.accounts);
  for (const p of qualityCases) {
    assert.equal(p.status, 'pending', p.title);
    assert.equal(p.facility, null, 'No previously decided website-field choice is re-proposed');
    if (p.quality.category === 'retired_contact') {
      const old = accountMap.get(p.candidates[0].account.account_id);
      assert(old.status === 'Inactive' || old.chow_current_account || old.duplicate_of_account);
      assert(p.quality.contacts.some((c) => c.account_id === old.account_id && c.is_active !== false));
      assert(p.options.every((o) => o.operations.length === 0), 'Contact follow-up cannot migrate contacts');
    } else if (p.quality.category === 'shared_email') {
      const people = p.quality.contacts.filter((c) => c.email?.toLowerCase() === 'dnovak@bellhavenliving.com');
      assert.equal(people.length, 2);
      assert.equal(new Set(people.map((c) => c.name)).size, 2);
      assert(p.options.every((o) => o.operations.length === 0), 'A shared inbox does not identify a correction');
    } else {
      assert.equal(p.quality.category, 'account_overlap');
      assert.deepEqual(p.candidates.map((c) => c.account.name).sort(),
        ['Bellhaven of Sandusky', 'Millstone Care of Sandusky']);
      assert.equal(new Set(p.candidates.map((c) => c.account.parent_id)).size, 2);
      assert(!p.options.some((o) => o.operations.some((op) => ['chow', 'create', 'duplicate'].includes(op.type))),
        'Sandusky has no evidence authorizing an ownership transfer or consolidation');
    }
    const choice = p.options.find((o) => o.id === 'acknowledge');
    assert(choice && choice.operations.length === 0);
    assert.equal(ok(await post(local, 'decision', {
      id: p.id, version: p.version, optionId: choice.id, action: 'approve',
      note: p.quality.category === 'account_overlap'
        ? 'Address overlap does not confirm ownership. Keep these accounts separate pending owner verification.'
        : p.quality.category === 'shared_email'
          ? 'The email may be a shared inbox. Confirm details with the owner before making any contact correction.'
          : 'Account history stays intact. Confirm where this contact belongs before a separately reviewed contact edit.',
    })).status, 'applied');
    approved.push(p.id);
  }
  assert.equal(hosted.writes.length, writesBeforeFollowups, 'Acknowledging an unresolved follow-up cannot write to CRM');
  assert.deepEqual(hosted.data.accounts, accountsBeforeFollowups);
  assert.deepEqual(hosted.data.contacts, originalContacts);
  const writesAfterReview = hosted.writes.length;
  const contactsAfterReview = structuredClone(hosted.data.contacts);
  const accountsAfterReview = structuredClone(hosted.data.accounts);
  await hosted.restart();
  await local.restart();
  for (let i = 0; i < 2; i++) {
    assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0);
    state = await get(local, 'state');
    assert.equal(state.website.facilities.length, 35);
    for (const id of approved) {
      assert.equal(state.proposals.find((p) => p.id === id)?.status, 'applied');
      assert.equal(state.decisions.filter((d) => d.proposal_id === id && d.action === 'approve').length, 1);
    }
    assert(!state.proposals.some((p) => ['pending', 'stale', 'partial', 'applying'].includes(p.status)));
    for (const f of website) {
      const p = currentProposal(state, f.source_url);
      assert(['applied', 'unchanged'].includes(p.status), f.name);
    }
  }
  assert.equal(hosted.writes.length, writesAfterReview);
  assert.deepEqual(hosted.data.accounts, accountsAfterReview);
  assert.deepEqual(hosted.data.contacts, contactsAfterReview);
  assert.deepEqual(state, await get(hosted, 'state'), 'Local and public review history share the same ledger');
  assert.equal(local.writes.length, 0);
  assert.equal((await local.db.prepare('SELECT COUNT(*) AS n FROM proposals').first()).n, 0);
  const report = await get(local, 'report');
  assert.equal(report.current.missing_ledger_rows, 0);
  const exported = await get(local, 'export');
  assert(exported.operations.length > 37);
  assert(exported.operations.every((o) => o.status === 'complete' && o.data.after));
  // Address normalization must not overwrite legitimate mailing addresses.
  const box = originalAccounts.find((a) => a.name === 'Bellhaven of Ashtabula');
  assert.deepEqual(hosted.data.accounts.find((a) => a.account_id === box.account_id), box);
  // Selecting a separate Amberly does not move Juniper's existing facility.
  const unrelatedAmberly = originalAccounts.find((a) => a.name === 'Amberly Manor');
  assert.deepEqual(hosted.data.accounts.find((a) => a.account_id === unrelatedAmberly.account_id), unrelatedAmberly);
});

test('judgment alternatives: each Kettering survivor works without moving contacts or rewriting billing history', async (t) => {
  const candidates = ['Kettering Nursing & Rehabilitation', 'Kettering Senior Campus', 'Kettering Care Centre'];
  for (const name of candidates) await t.test(name, async (t) => {
    const { hosted, local } = await setup(t);
    const contacts = structuredClone(hosted.data.contacts);
    ok(await post(local, 'pipeline', {}));
    const p = (await get(local, 'state')).proposals.find((p) => p.title === 'Bellhaven of Kettering' && p.current);
    assert.equal(p.kind, 'ambiguous');
    assert.equal(new Set(p.options.map((o) => o.base_option_id ?? o.id)).size, 6);
    const survivor = p.candidates.find((c) => c.account.name === name).account;
    const selected = p.options.find((o) => o.id === survivor.account_id);
    const before = structuredClone(hosted.data.accounts);
    ok(await approve(local, p, selected));
    await verifyEffects(hosted, local, p, selected, before, 0);
    const after = hosted.data.accounts.find((a) => a.account_id === survivor.account_id);
    assert.equal(after.name, 'Bellhaven of Kettering');
    assert.equal(after.parent_id, p.parent.account_id);
    assert.equal(after.billing_street, '3313 Wilmington Pike');
    assert.equal(after.status, 'Active');
    for (const candidate of p.candidates.filter((c) => c.account.account_id !== survivor.account_id)) {
      const loser = hosted.data.accounts.find((a) => a.account_id === candidate.account.account_id);
      assert.equal(loser.status, 'Inactive');
      assert.equal(loser.duplicate_of_account, survivor.account_id);
    }
    assert.deepEqual(hosted.data.contacts, contacts);
    assert.equal(hosted.writes.filter((w) => w.method === 'POST').length, 0);
    const writeCount = hosted.writes.length;
    await hosted.restart();
    for (let i = 0; i < 2; i++) assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0);
    const retained = currentProposal(await get(local, 'state'), p.key);
    assert.equal(retained.id, p.id, 'The approved optional phone choice remains the current decision');
    assert.equal(retained.status, 'applied');
    assert.equal(hosted.writes.length, writeCount);
  });
});

test('duplicate alternatives: update one record without consolidating any other account, then retain that decision on reruns', async (t) => {
  const scenarios = [
    ['Bellhaven of Kettering', 'Kettering Nursing & Rehabilitation'],
    ['Bellhaven of Kettering', 'Kettering Senior Campus'],
    ['Bellhaven of Kettering', 'Kettering Care Centre'],
    ['Bellhaven Gardens of Monroe', 'Bellhaven Gardens of Monroe'],
    ['Bellhaven of Owosso', 'Bellhaven of Owosso'],
    ['Bellhaven of Port Clinton', 'Bellhaven of Port Clinton'],
    ['Bellhaven Shores of Erie', 'Bellhaven Shores of Erie'],
  ];
  for (const [title, name] of scenarios) await t.test(`${title}: ${name}`, async (t) => {
    const { hosted, local } = await setup(t);
    const contacts = structuredClone(hosted.data.contacts);
    ok(await post(local, 'pipeline', {}));
    const p = (await get(local, 'state')).proposals.find((p) => p.title === title && p.current);
    const selected = p.options.find((o) => o.resolution === 'existing' &&
      p.candidates.find((c) => c.account.account_id === o.account_id)?.account.name === name);
    assert(selected, `${title}: non-consolidating route exists`);
    assert.equal(selected.operations.length, 1);
    assert.equal(selected.operations[0].type, 'patch');
    assert.equal(selected.operations[0].account_id, selected.account_id);
    const before = structuredClone(hosted.data.accounts);
    const withoutRationale = await post(local, 'decision', {
      id: p.id, version: p.version, optionId: selected.id, action: 'approve', note: '',
    });
    assert.equal(withoutRationale.status, 409, 'Leaving possible duplicates active needs a recorded rationale');
    assert.equal(hosted.writes.length, 0);
    ok(await approve(local, p, selected));
    await verifyEffects(hosted, local, p, selected, before, 0);
    assert.equal(hosted.writes.length, 1);
    for (const candidate of p.candidates.filter((c) => c.account.account_id !== selected.account_id))
      assert.deepEqual(hosted.data.accounts.find((a) => a.account_id === candidate.account.account_id),
        before.find((a) => a.account_id === candidate.account.account_id));
    assert.deepEqual(hosted.data.contacts, contacts);
    await hosted.restart();
    await local.restart();
    for (let i = 0; i < 2; i++) {
      assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0);
      const saved = currentProposal(await get(local, 'state'), p.key);
      assert.equal(saved.id, p.id);
      assert.equal(saved.status, 'applied');
      assert.equal(hosted.writes.length, 1);
    }
  });
});
