import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fakeToken, cronSecret } from './harness.mjs';

const secrets = [fakeToken, cronSecret, 'test-only-proxy-key', 'test-only-service-token'];
const echo = `Ordinary review text: ${secrets.join(' / ')}`;
function assertRedacted(response) {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const body = JSON.stringify(response.value);
  for (const secret of secrets) assert(!body.includes(secret), `Public response leaked ${secret}`);
  assert(body.includes('Ordinary review text'), 'Useful nonsecret evidence should remain visible');
  assert(body.includes('[redacted]'), 'The output should show that a credential was removed');
}

test('public CRM reads redact every configured credential echoed in account and contact fields', async (t) => {
  const s = await setup(t);
  const account = s.data.accounts.find((a) => a.name.includes('Portsmouth'));
  account.note = echo;
  const contact = s.data.contacts[0];
  contact.name = echo;
  for (const [entity, id] of [
    ['accounts', account.account_id],
    ['contacts', contact.contact_id],
  ]) {
    assertRedacted(await s.call(`crm?entity=${entity}&id=${id}`));
    assertRedacted(await s.call(`crm?entity=${entity}&page=1&page_size=100`));
  }
  assert.equal(s.writes.length, 0);
});

test('public manual draft responses redact credentials while staging without CRM writes', async (t) => {
  const s = await setup(t);
  const account = s.data.accounts.find((a) => a.name.includes('Portsmouth'));
  assertRedacted(
    await s.call('draft', {
      ...(await s.reviewer()),
      body: {
        entity: 'accounts',
        recordId: account.account_id,
        fields: { note: echo },
        note: 'Verify new note',
      },
    })
  );
  assert.equal(s.writes.length, 0);
});

test('public recovery reporting redacts upstream credentials embedded in the saved case title', async (t) => {
  const s = await setup(t);
  const absent = s.data.accounts.find((a) => a.name.includes('Sandusky'));
  absent.name = echo;
  assert.equal((await s.pipeline()).status, 200);
  const state = (await s.call('state')).value;
  const p = state.proposals.find((p) => p.key === `absent:${absent.account_id}`);
  assert(p);
  // Reproduce an interrupted saved case without authorizing a CRM change.
  await s.db.prepare("UPDATE proposals SET status='partial' WHERE id=?").bind(p.id).run();
  assertRedacted(await s.call('report'));
  assert.equal(s.writes.length, 0);
});
