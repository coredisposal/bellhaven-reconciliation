import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './harness.mjs';

const decision = (p, action = 'approve') => ({
  id: p.id,
  version: p.version,
  optionId: p.options[0].id,
  action,
  note: 'Reviewed the source account and CHOW billing evidence',
});
const decide = async (s, p, action) =>
  s.call('decision', {
    ...(await s.reviewer()),
    body: decision(p, action),
  });

test('billing: compiled Worker reserves interrupted manual CHOW across pipeline approval and restarts', async (t) => {
  const s = await setup(t),
    before = structuredClone(s.data.accounts.find((a) => a.name.includes('Tiffin'))),
    parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
  const draft = await s.call('draft', {
    ...(await s.reviewer()),
    body: {
      entity: 'accounts',
      recordId: before.account_id,
      fields: { parent_id: parent.account_id },
      note: 'Reviewed the correct affiliation and preserve historical billing',
    },
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.value));
  const manual = draft.value;
  assert.equal(manual.type, 'chow');
  s.failLink(true);
  const interrupted = await decide(s, manual);
  assert.equal(interrupted.status, 409);
  assert.match(interrupted.value.error, /CHOW link not verified/);
  assert.equal(s.writes.filter((w) => w.method === 'POST').length, 1);
  await s.restart();
  assert.equal((await s.pipeline()).status, 200);
  const state = (await s.call('state')).value,
    pipeline = state.proposals.find(
      (p) => !p.manual && p.title.includes('Tiffin') && p.status === 'pending'
    );
  assert.equal(pipeline.kind, 'chow');
  assert.equal(state.proposals.find((p) => p.id === manual.id).status, 'partial');
  const count = s.writes.length,
    blocked = await decide(s, pipeline);
  assert.equal(blocked.status, 409);
  assert.match(blocked.value.error, /interrupted approved work/);
  assert.equal(s.writes.length, count);
  s.failLink(false);
  const resumed = await decide(s, manual, 'resume');
  assert.equal(resumed.status, 200, JSON.stringify(resumed.value));
  assert.equal(s.writes.filter((w) => w.method === 'POST').length, 1);
  const after = s.data.accounts.find((a) => a.account_id === before.account_id);
  assert.deepEqual(after, { ...before, chow_current_account: 'test-created-1' });
  const replacement = s.data.accounts.find((a) => a.account_id === after.chow_current_account);
  assert.equal(replacement.parent_id, parent.account_id);
  assert.equal(replacement.lifetime_revenue, 0);
  assert.equal(replacement.outstanding_ar, 0);
  assert.equal(replacement.duplicate_of_account, '');
  const verified = (await s.call('state')).value;
  assert.equal(verified.proposals.find((p) => p.id === manual.id).status, 'applied');
  assert.equal(
    verified.decisions.filter((d) => d.action === 'approve' && d.proposal_id === manual.id).length,
    1
  );
  assert.equal(
    verified.decisions.filter((d) => d.action === 'approve' && d.proposal_id === pipeline.id)
      .length,
    0
  );
});
