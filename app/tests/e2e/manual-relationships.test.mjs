import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, createHarness } from './harness.mjs';

function pair(s, type = 'chow') {
  const source = s.data.accounts.find((a) => a.name === 'Bellhaven of Sandusky');
  const target = s.data.accounts.find((a) => a.name === 'Millstone Care of Sandusky');
  if (type === 'duplicate') Object.assign(source, {
    parent_id: target.parent_id, lifetime_revenue: 0, outstanding_ar: 0,
  });
  return { source, target, body: {
    entity: 'accounts', recordId: source.account_id, fields: {},
    relationship: { type, target_id: target.account_id },
    note: 'Relationship confirmed with the account owner; the address is supporting evidence.',
  } };
}
const decide = async (s, p, action = 'approve') => s.call('decision', {
  ...(await s.reviewer()), body: { id: p.id, version: p.version,
    optionId: 'manual', action, note: 'Reviewed both accounts and confirmation.' },
});
async function draft(s, body) {
  const response = await s.call('draft', { ...(await s.reviewer()), body });
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
}

test('compiled manual relationship API requires approval, preserves historical billing, and rejects repeated application', async (t) => {
  const s = await setup(t);
  const { source, target, body } = pair(s);
  Object.assign(target, { lifetime_revenue: 2600, outstanding_ar: 300 });
  const before = structuredClone(source), survivor = structuredClone(target), contacts = structuredClone(s.data.contacts);
  const p = await draft(s, body);
  assert.equal(s.writes.length, 0);
  assert.deepEqual(p.fields, { chow_current_account: target.account_id });
  const results = await Promise.all([decide(s, p), decide(s, p)]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.deepEqual(source, { ...before, chow_current_account: target.account_id });
  assert.deepEqual(target, survivor);
  assert.deepEqual(s.data.contacts, contacts);
  assert.equal(s.writes.length, 1);
  await s.restart();
  assert.equal((await decide(s, p)).status, 409);
  assert.equal((await s.call('state')).value.proposals.find((row) => row.id === p.id).status, 'applied');
  assert.equal((await s.pipeline()).status, 200);
  assert.equal((await s.pipeline()).value.new_proposals, 0);
  assert.equal(s.writes.length, 1);
});

test('compiled relationship staging rejects cross-parent/billed duplicates, self-links, parents and arbitrary pointers', async (t) => {
  const s = await setup(t), { source, target, body } = pair(s);
  const parent = s.data.accounts.find((a) => a.account_id === source.parent_id);
  for (const input of [
    { ...body, relationship: { type: 'duplicate', target_id: target.account_id } },
    { ...body, relationship: { type: 'chow', target_id: source.account_id } },
    { ...body, relationship: { type: 'chow', target_id: parent.account_id } },
    { ...body, relationship: undefined, fields: { chow_current_account: target.account_id } },
    { ...body, fields: { phone: '555-9999' } },
  ]) {
    const result = await s.call('draft', { ...(await s.reviewer()), body: input });
    assert.equal(result.status, 409, JSON.stringify(result.value));
  }
  source.parent_id = target.parent_id;
  const billed = await s.call('draft', { ...(await s.reviewer()), body: {
    ...body, relationship: { type: 'duplicate', target_id: target.account_id },
  } });
  assert.equal(billed.status, 409);
  assert.match(billed.value.error, /verified zero/);
  assert.equal(s.writes.length, 0);
});

test('compiled relationship revalidates stale source, target and parents without writes', async (t) => {
  const s = await setup(t), { source, target, body } = pair(s);
  for (const account of [source, target, s.data.accounts.find((a) => a.account_id === source.parent_id),
    s.data.accounts.find((a) => a.account_id === target.parent_id)]) {
    const p = await draft(s, { ...body, note: `Verified relationship before checking ${account.account_id}` });
    account.note = `${account.note ?? ''}\nExternal update`;
    const result = await decide(s, p);
    assert.equal(result.status, 409, JSON.stringify(result.value));
    assert.match(result.value.error, /changed/);
  }
  assert.equal(s.writes.length, 0);
});

test('compiled CHOW link failure resumes the existing successor after restart and verifies both records', async (t) => {
  const s = await setup(t), { source, target, body } = pair(s);
  const p = await draft(s, body), before = structuredClone(source);
  s.failLink(true);
  assert.equal((await decide(s, p)).status, 409);
  assert.equal(s.writes.length, 1);
  assert.equal((await s.call('state')).value.proposals.find((row) => row.id === p.id).status, 'partial');
  await s.restart();
  s.failLink(false);
  const result = await decide(s, p, 'resume');
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(s.writes.length, 2);
  assert(s.writes.every((write) => write.method === 'PATCH' && write.id === source.account_id));
  assert.deepEqual(source, { ...before, chow_current_account: target.account_id });
});

test('compiled duplicate write recovery survives a failed audit without replaying the successful PATCH', async (t) => {
  const s = await setup(t), { source, target, body } = pair(s, 'duplicate');
  const p = await draft(s, body), before = structuredClone(source), survivor = structuredClone(target);
  await s.db.prepare("CREATE TRIGGER fail_relationship_audit BEFORE INSERT ON audits WHEN NEW.event='operation_verified' BEGIN SELECT RAISE(ABORT,'temporary audit failure'); END").run();
  assert.equal((await decide(s, p)).status, 409);
  assert.equal(s.writes.length, 1);
  await s.db.prepare('DROP TRIGGER fail_relationship_audit').run();
  await s.restart();
  const result = await decide(s, p, 'resume');
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.deepEqual(source, { ...before, status: 'Inactive', duplicate_of_account: target.account_id });
  assert.deepEqual(target, survivor);
  assert.equal(s.writes.length, 1);
});

test('local proxy stages and approves relationships through the shared hosted ledger', async (t) => {
  const backend = await createHarness();
  t.after(backend.close);
  const proxy = await createHarness({ mode: 'proxy', backend, privateSite: false });
  t.after(proxy.close);
  const { source, target, body } = pair(backend);
  const p = await draft(proxy, body);
  assert.equal(backend.writes.length, 0);
  assert.equal((await backend.call('state')).value.proposals.find((row) => row.id === p.id).status, 'pending');
  const result = await decide(proxy, p);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(source.chow_current_account, target.account_id);
  assert.equal(backend.writes.length, 1);
  assert.equal(proxy.writes.length, 0);
});
