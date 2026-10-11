import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

// Both application Workers are the compiled release. Only the website and CRM
// upstreams are isolated, so these requests can never alter exercise records.
const title = 'Bellhaven Meadows of Findlay';
const ok = ({ status, value }) => {
  assert.equal(status, 200, JSON.stringify(value));
  return value;
};
const get = async (app, route) => ok(await app.call(route));
const post = async (app, route, body) => app.call(route, { ...(await app.reviewer()), body });
const approval = (p, choice) => ({
  id: p.id,
  version: p.version,
  optionId: choice.id,
  action: 'approve',
  note: 'Reviewed the website offerings, account category, phone and billing evidence.',
});

async function setup(t) {
  const hosted = await createHarness({ privateSite: false });
  let local;
  t.after(async () => {
    try { await local?.close(); } finally { await hosted.close(); }
  });
  local = await createHarness({ mode: 'proxy', backend: hosted, privateSite: false });
  return { hosted, local };
}

async function proposal(app, name = title) {
  const matches = (await get(app, 'state')).proposals.filter((p) => p.title === name && p.current);
  assert.equal(matches.length, 1, `${name} has exactly one current review case`);
  return matches[0];
}

function choice(p, care, phone) {
  const base = p.options[0].base_option_id;
  assert(base, 'The server identifies the underlying account resolution');
  const matches = p.options.filter((o) => o.base_option_id === base &&
    o.field_choices?.care_type?.selected === care && o.field_choices?.phone?.selected === phone);
  assert.equal(matches.length, 1, `One stored option for care=${care}, phone=${phone}`);
  return matches[0];
}

async function assertDurable(hosted, local, p, selected) {
  const writes = hosted.writes.length;
  const accounts = structuredClone(hosted.data.accounts);
  await hosted.restart();
  await local.restart();
  for (let i = 0; i < 2; i++) {
    const run = ok(await post(local, 'pipeline', {}));
    assert.equal(run.new_proposals, 0, 'Unchanged evidence does not re-propose a decided field choice');
    const saved = await proposal(local, p.title);
    assert.equal(saved.id, p.id, 'The original approved case remains current');
    assert.equal(saved.status, 'applied');
    const state = await get(local, 'state');
    const approvals = state.decisions.filter((d) => d.proposal_id === p.id && d.action === 'approve');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].option_id, selected.id, 'History identifies the exact approved field variant');
    const report = await get(local, 'report');
    assert.equal(report.current.missing_ledger_rows, 0, 'The operational report resolves the approved case');
    assert.equal(report.current.verification_required, 0, 'Saved field choices remain verified, including approvals with no CRM write');
  }
  assert.equal(hosted.writes.length, writes, 'Restarts and reruns never apply another CRM change');
  assert.deepEqual(hosted.data.accounts, accounts);
  assert.deepEqual(await get(local, 'state'), await get(hosted, 'state'), 'Local and public views share decisions');
  assert.equal(local.writes.length, 0, 'The local proxy never maintains its own CRM writes');
}

test('field choices: keep the category or choose either supported offering, then retain the decision across both runtimes', async (t) => {
  for (const [care, phone] of [[null, false], ['Assisted Living', false], ['Memory Care', true]]) {
    await t.test(`care ${care ?? 'kept'}, website phone ${phone}`, async (t) => {
      const { hosted, local } = await setup(t);
      const original = hosted.data.accounts.find((a) => a.name === title);
      const before = structuredClone(hosted.data.accounts);
      const contacts = structuredClone(hosted.data.contacts);
      ok(await post(local, 'pipeline', {}));
      const p = await proposal(local);
      assert.equal(p.kind, 'parent_correction');
      const selected = choice(p, care, phone);
      assert.deepEqual(selected.field_choices.care_type.values, ['Assisted Living', 'Memory Care']);
      assert.equal(selected.field_choices.care_type.current, 'Assisted Living');
      assert.equal(selected.field_choices.phone.current, original.phone);
      assert.equal(selected.field_choices.phone.proposed, p.facility.phone_raw);
      assert.equal(hosted.writes.length, 0, 'Discovery and selecting an option are read-only');

      ok(await post(local, 'decision', approval(p, selected)));
      assert.equal(hosted.writes.length, 1);
      const write = hosted.writes[0];
      assert.equal(write.method, 'PATCH');
      assert.equal(write.entity, 'accounts');
      assert.equal(write.id, original.account_id);
      const old = before.find((a) => a.account_id === original.account_id);
      const expectedKeys = ['note', 'parent_id'];
      if (phone) expectedKeys.push('phone');
      if (care && care !== old.care_type) expectedKeys.push('care_type');
      assert.deepEqual(Object.keys(write.fields).sort(), expectedKeys.sort(), 'Only the displayed selected changes are sent');
      assert.equal(original.parent_id, p.parent.account_id);
      assert.equal(original.care_type, care ?? old.care_type);
      assert.equal(original.phone, phone ? p.facility.phone_raw : old.phone);
      assert.equal(original.lifetime_revenue, old.lifetime_revenue);
      assert.equal(original.outstanding_ar, old.outstanding_ar);
      assert.match(original.note, /Care offerings: Assisted Living; Memory Support\./);
      assert(original.note.includes(p.facility.source_url), 'The full website list retains its source');
      assert.deepEqual(await get(local, `crm?entity=accounts&id=${original.account_id}`), original);
      for (const untouched of before.filter((a) => a.account_id !== original.account_id))
        assert.deepEqual(hosted.data.accounts.find((a) => a.account_id === untouched.account_id), untouched);
      assert.deepEqual(hosted.data.contacts, contacts);
      assert.equal((await post(hosted, 'decision', approval(p, selected))).status, 409,
        'A second reviewer cannot replay the same choice');
      await assertDurable(hosted, local, p, selected);
    });
  }
});

test('field choices: forged fields, unsupported categories and stale evidence are refused before any write', async (t) => {
  const { hosted, local } = await setup(t);
  ok(await post(local, 'pipeline', {}));
  const p = await proposal(local), selected = choice(p, 'Memory Care', true);
  for (const body of [
    { ...approval(p, selected), optionId: `${selected.id}-unsupported` },
    { ...approval(p, selected), fields: { care_type: 'Assisted Living; Memory Care' } },
    { ...approval(p, selected), field_choices: { care_type: { selected: 'Unsupported category' } } },
  ]) {
    assert.equal((await post(local, 'decision', body)).status, 409);
    assert.equal(hosted.writes.length, 0);
  }
  const account = hosted.data.accounts.find((a) => a.name === title);
  account.phone = '(555) 010-1234';
  assert.equal((await post(local, 'decision', approval(p, selected))).status, 409);
  assert.equal(hosted.writes.length, 0, 'A changed phone requires fresh review instead of applying an obsolete choice');
});

test('field choices: keeping current values can record a decision without a CRM patch and survives reruns', async (t) => {
  const { hosted, local } = await setup(t);
  const account = hosted.data.accounts.find((a) => a.name === 'Bellhaven of Portsmouth');
  account.billing_zip = '45662';
  account.care_type = 'Independent Living';
  // With the address fixed, care category is the only discrepancy. Keeping its
  // existing value records a choice without needing a CRM write as a side effect.
  ok(await post(local, 'pipeline', {}));
  const p = await proposal(local, account.name);
  const selected = p.options.find((o) => o.field_choices?.care_type?.selected === null);
  assert(selected);
  assert.equal(selected.field_choices.care_type.current, 'Independent Living');
  assert.equal(selected.operations.length, 0);
  const before = structuredClone(account);
  ok(await post(local, 'decision', approval(p, selected)));
  assert.deepEqual(account, before);
  assert.equal(hosted.writes.length, 0);
  await assertDurable(hosted, local, p, selected);
});

test('field choices: a later CRM care-category rollback requires a new approval without replacing the original decision', async (t) => {
  const { hosted, local } = await setup(t);
  const account = hosted.data.accounts.find((a) => a.name === 'Bellhaven of Portsmouth');
  account.billing_zip = '45662';
  account.care_type = 'Independent Living';
  ok(await post(local, 'pipeline', {}));
  const p = await proposal(local, account.name);
  const selected = p.options.find((o) => o.field_choices?.care_type?.selected === 'Skilled Nursing');
  assert(selected);
  ok(await post(local, 'decision', approval(p, selected)));
  assert.equal(account.care_type, 'Skilled Nursing');
  await assertDurable(hosted, local, p, selected);
  const writes = hosted.writes.length;

  account.care_type = 'Independent Living';
  assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 1);
  const fresh = await proposal(local, account.name);
  assert.notEqual(fresh.id, p.id);
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.revision_of, p.id);
  assert(fresh.options.some((o) => o.field_choices?.care_type?.current === 'Independent Living' &&
    o.field_choices.care_type.selected === 'Skilled Nursing'));
  const state = await get(local, 'state');
  assert.equal(state.proposals.find((row) => row.id === p.id).status, 'applied');
  assert.equal(state.decisions.filter((d) => d.proposal_id === p.id && d.action === 'approve').length, 1);
  assert.equal(hosted.writes.length, writes, 'A new mismatch is proposed without replaying the old approval');
  assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0,
    'An unresolved new version is not duplicated on another run');
});

test('field choices: interrupted CHOW keeps the approved replacement category and phone while preserving the old account', async (t) => {
  const { hosted, local } = await setup(t);
  const old = hosted.data.accounts.find((a) => a.name === title);
  old.outstanding_ar = 750;
  const before = structuredClone(old);
  const contacts = structuredClone(hosted.data.contacts);
  ok(await post(local, 'pipeline', {}));
  const p = await proposal(local);
  assert.equal(p.kind, 'chow');
  const selected = choice(p, 'Memory Care', true);
  hosted.failLink(true);
  assert.equal((await post(local, 'decision', approval(p, selected))).status, 409);
  assert.equal((await proposal(local)).status, 'partial');
  assert.deepEqual(old, before, 'Even optional selected fields leave the billing account untouched');
  const created = hosted.data.accounts.filter((a) => a.account_id.startsWith('test-created-'));
  assert.equal(created.length, 1);
  const replacement = created[0];
  assert.equal(replacement.care_type, 'Memory Care');
  assert.equal(replacement.phone, p.facility.phone_raw);
  assert.equal(replacement.parent_id, p.parent.account_id);
  assert.equal(replacement.lifetime_revenue, 0);
  assert.equal(replacement.outstanding_ar, 0);
  assert.match(replacement.note, /Care offerings: Assisted Living; Memory Support\./);

  await hosted.restart();
  await local.restart();
  hosted.failLink(false);
  ok(await post(local, 'decision', {
    id: p.id, version: p.version, action: 'resume', note: 'Resume the saved approved replacement link.',
  }));
  assert.deepEqual(old, { ...before, chow_current_account: replacement.account_id });
  assert.equal(hosted.writes.filter((w) => w.method === 'POST').length, 1,
    'Resuming does not create a second replacement');
  for (const write of hosted.writes.filter((w) => w.id === old.account_id))
    assert.deepEqual(write.fields, { chow_current_account: replacement.account_id });
  assert.deepEqual(hosted.data.contacts, contacts);
  const writes = hosted.writes.length;
  const oldContacts = contacts.filter((c) => c.account_id === old.account_id && c.is_active !== false);
  assert(oldContacts.length > 0, 'This Findlay scenario includes contacts on the preserved account');
  assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 1,
    'Preserved contacts produce one distinct follow-up, not a new field-choice decision');
  const followups = (await get(local, 'state')).proposals.filter((row) => row.current &&
    row.key === `quality:retired-contacts:${old.account_id}`);
  assert.equal(followups.length, 1);
  const followup = followups[0];
  assert.equal(followup.kind, 'crm_quality');
  assert.equal(followup.quality.category, 'retired_contact');
  assert.deepEqual(followup.quality.contacts.filter((c) => c.account_id === old.account_id && c.is_active !== false)
    .map((c) => c.contact_id).sort(), oldContacts.map((c) => c.contact_id).sort());
  assert(followup.options.every((o) => o.operations.length === 0));
  const acknowledge = followup.options.find((o) => o.id === 'acknowledge');
  assert(acknowledge);
  ok(await post(local, 'decision', { ...approval(followup, acknowledge),
    note: 'Keep contacts on the historical account pending separately verified contact reassignment.' }));
  assert.equal(hosted.writes.length, writes, 'Recording contact follow-up does not alter CRM records');
  assert.deepEqual(hosted.data.contacts, contacts);
  await assertDurable(hosted, local, p, selected);
});
