import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { businessAccount } from '../../lib/core.mjs';

const ok = ({ status, value }) => {
  assert.equal(status, 200, JSON.stringify(value));
  return value;
};
const post = async (app, route, body) => app.call(route, { ...(await app.reviewer()), body });
const current = async (app) => ok(await app.call('state'));
const amberly = async (app) => (await current(app)).proposals.find((p) => p.title === 'Amberly Manor' && p.status === 'pending');
const approve = (app, p, selected, note = 'Verified facility identity against the conflicting record and supporting evidence.') =>
  post(app, 'decision', { id: p.id, version: p.version, optionId: selected?.id, action: 'approve', note });

async function setup(t) {
  const hosted = await createHarness({ privateSite: false });
  let local;
  t.after(async () => { try { await local?.close(); } finally { await hosted.close(); } });
  local = await createHarness({ mode: 'proxy', backend: hosted, privateSite: false });
  return { hosted, local };
}

test('judgment: public hosted and local views apply a separate-facility choice once and preserve the conflicting account', async (t) => {
  const { hosted, local } = await setup(t);
  ok(await post(local, 'pipeline', {}));
  const p = await amberly(local);
  assert.equal(p.kind, 'ambiguous');
  const separate = p.options.find((o) => o.resolution === 'separate');
  const existing = p.options.find((o) => o.resolution === 'existing');
  assert(separate && existing);
  const before = structuredClone(hosted.data.accounts);
  const contacts = structuredClone(hosted.data.contacts);
  assert.equal((await approve(local, p, undefined)).status, 409);
  assert.equal((await approve(local, p, separate, '')).status, 409);
  assert.equal(hosted.writes.length, 0);
  ok(await approve(local, p, separate));
  assert.equal(hosted.writes.length, 1);
  assert.equal(hosted.writes[0].method, 'POST');
  for (const original of before)
    assert.deepEqual(hosted.data.accounts.find((a) => a.account_id === original.account_id), original);
  assert.deepEqual(hosted.data.contacts, contacts);
  const created = hosted.data.accounts.find((a) => !before.some((old) => old.account_id === a.account_id));
  assert.equal(created.parent_id, p.parent.account_id);
  assert.equal(created.billing_street, p.facility.street_address);
  assert.equal(created.lifetime_revenue, 0);
  assert.equal(created.outstanding_ar, 0);
  await hosted.restart();
  await local.restart();
  for (let i = 0; i < 2; i++) assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0);
  assert.equal(await amberly(local), undefined);
  const state = await current(local);
  assert.equal(state.proposals.find((row) => row.id === p.id).status, 'applied');
  assert.equal(state.decisions.filter((d) => d.proposal_id === p.id && d.action === 'approve').length, 1);
  assert.equal(ok(await local.call('report')).current.missing_ledger_rows, 0);
  assert.equal(hosted.writes.length, 1);
  assert.deepEqual(state.website, (await current(hosted)).website);
});

test('judgment: confirmed existing identity corrects its address and follows every CHOW billing branch', async (t) => {
  for (const [revenue, ar, isChow] of [[0, 0, false], [100, 0, false], [0, 10, false], [100, 10, true]]) {
    await t.test(`revenue ${revenue}, AR ${ar}`, async (t) => {
      const { hosted, local } = await setup(t);
      const original = hosted.data.accounts.find((a) => a.name === 'Amberly Manor');
      Object.assign(original, { lifetime_revenue: revenue, outstanding_ar: ar });
      const before = structuredClone(original);
      const contacts = structuredClone(hosted.data.contacts);
      ok(await post(local, 'pipeline', {}));
      const p = await amberly(local);
      const selected = p.options.find((o) => o.resolution === 'existing');
      assert.equal(selected.account_id, before.account_id);
      assert.equal(selected.operations[0].type, isChow ? 'chow' : 'patch');
      if (isChow) hosted.failLink(true);
      const response = await approve(local, p, selected);
      if (isChow) {
        assert.equal(response.status, 409);
        const replacement = hosted.data.accounts.find((a) => a.account_id.startsWith('test-created-'));
        assert(replacement);
        assert.deepEqual(original, before);
        hosted.failLink(false);
        await hosted.restart();
        ok(await post(local, 'decision', { id: p.id, version: p.version, action: 'resume', note: 'Resume the saved replacement link.' }));
        assert.equal(hosted.writes.filter((w) => w.method === 'POST').length, 1);
        assert.deepEqual(businessAccount(original), businessAccount({ ...before, chow_current_account: replacement.account_id }));
        assert.equal(replacement.parent_id, p.parent.account_id);
      } else {
        ok(response);
        assert.equal(hosted.writes.length, 1);
        assert.equal(original.parent_id, p.parent.account_id);
        assert.equal(original.billing_street, p.facility.street_address);
        assert.equal(original.billing_city, p.facility.city);
        assert.equal(original.billing_state, p.facility.state);
        assert.equal(original.billing_zip, p.facility.postal_code);
        assert.equal(original.lifetime_revenue, revenue);
        assert.equal(original.outstanding_ar, ar);
        assert.equal(original.phone, before.phone);
      }
      assert.deepEqual(hosted.data.contacts, contacts);
      const writes = hosted.writes.length;
      assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0);
      assert.equal(await amberly(local), undefined);
      assert.equal(hosted.writes.length, writes);
    });
  }
});

test('judgment: stale candidate evidence and forged choices cannot alter the CRM', async (t) => {
  const { hosted, local } = await setup(t);
  ok(await post(local, 'pipeline', {}));
  const p = await amberly(local);
  const choice = p.options.find((o) => o.resolution === 'existing');
  const forged = await post(local, 'decision', {
    id: p.id, version: p.version, optionId: choice.id, action: 'approve',
    note: 'Verified', fields: { parent_id: 'arbitrary' },
  });
  assert.equal(forged.status, 409);
  hosted.data.accounts.find((a) => a.account_id === choice.account_id).outstanding_ar = 99;
  assert.equal((await approve(local, p, choice)).status, 409);
  assert.equal(hosted.writes.length, 0);
  assert.equal((await current(local)).proposals.find((row) => row.id === p.id).status, 'stale');
});
