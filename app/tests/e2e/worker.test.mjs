import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fakeToken, cronSecret } from './harness.mjs';

test('operator: compiled Worker crawls all pages, persists proposals, and scheduling never writes', async (t) => {
  const s = await setup(t);
  const result = await s.pipeline();
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.facilities, 35);
  assert.equal(result.value.accounts, 121);
  assert.equal(result.value.contacts, 67);
  assert.equal(result.value.coverage.complete, true);
  assert.equal(s.writes.length, 0);
  const state = await s.call('state');
  assert.equal(state.status, 200);
  assert(state.value.proposals.some((p) => p.title.includes('Findlay')));
  assert(s.requests.some((r) => r.url.includes('/accounts?page=3')));
  assert(s.requests.some((r) => r.url.includes('/contacts?page=2')));
  const repeat = await s.pipeline();
  assert.equal(repeat.value.new_proposals, 0);
  assert.equal(s.writes.length, 0);
});

test('local reviewer: proxy keeps one hosted ledger, verifies browser session, and refuses credential redirects', async (t) => {
  const s = await setup(t, 'proxy');
  assert.deepEqual((await s.call('state')).value, { forwarded: true });
  const before = s.requests.length;
  assert.equal((await s.call('decision', { body: { id: 'forged' } })).status, 409);
  assert.equal(s.requests.length, before);
  const session = await s.reviewer();
  const result = await s.call('decision', {
    ...session,
    body: { id: 'stored-proposal', action: 'reject' },
  });
  assert.equal(result.status, 200);
  assert.equal(s.forwarded[0].proxyIdentity.session, session.cookie.split('=')[1]);
  assert.equal(s.forwarded[0].proxyIdentity.actor, 'anonymous');
  s.proxyRedirect(true);
  const redirected = await s.call('state');
  assert.equal(redirected.status, 409);
  assert.match(redirected.value.error, /redirect/i);
  assert(s.requests.every((r) => new URL(r.url).origin === 'https://e2e-backend.chatgpt.site'));
  assert.equal(s.writes.length, 0);
});

async function proposal(s, title) {
  const state = await s.call('state');
  const p = state.value.proposals.find((row) => row.title.includes(title));
  assert(p, `Missing ${title}`);
  return p;
}
const decision = (p, action = 'approve') => ({
  id: p.id,
  version: p.version,
  optionId: p.options[0]?.id,
  action,
  note: 'Reviewed source and billing evidence',
});
async function decide(s, p, action = 'approve') {
  return s.call('decision', { ...(await s.reviewer()), body: decision(p, action) });
}

test('billing: compiled approval preserves review holds and negative AR through restart and rerun', async (t) => {
  const s = await setup(t);
  const account = s.data.accounts.find((row) => row.name === 'Bellhaven Meadows of Findlay');
  Object.assign(account, { status: 'Needs Review', outstanding_ar: -75,
    note: '[website-absence] Previously unlisted. Collections team review is still open.' });
  const before = structuredClone(account);
  assert.equal((await s.pipeline()).status, 200);
  const p = await proposal(s, 'Findlay');
  const result = await decide(s, p);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(account.status, 'Needs Review');
  assert.equal(account.outstanding_ar, -75);
  assert.equal(account.lifetime_revenue, before.lifetime_revenue);
  assert.equal(account.parent_id, p.parent.account_id);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].method, 'PATCH');
  assert(!Object.hasOwn(s.writes[0].fields, 'status'));
  await s.restart();
  assert.equal((await s.pipeline()).value.new_proposals, 0);
  assert.equal((await s.pipeline()).value.new_proposals, 0);
  assert.equal(s.writes.length, 1);
});

test('approval integrity: a valid-shaped changed stored patch cannot reuse the displayed version', async (t) => {
  const s = await setup(t);
  assert.equal((await s.pipeline()).status, 200);
  const p = await proposal(s, 'Portsmouth');
  const stored = await s.db.prepare('SELECT data FROM proposals WHERE id=?').bind(p.id).first();
  const changed = JSON.parse(stored.data);
  changed.options[0].operations[0].fields.phone = '(555) 555-0199';
  await s.db.prepare('UPDATE proposals SET data=? WHERE id=?').bind(JSON.stringify(changed), p.id).run();
  const result = await decide(s, p);
  assert.equal(result.status, 409);
  assert.equal(s.writes.length, 0);
  const state = (await s.call('state')).value;
  assert(!state.decisions.some((entry) => entry.proposal_id === p.id && entry.action === 'approve'));
  assert.equal((await s.pipeline()).status, 200, 'Failed integrity check releases its lock');
});

test('reviewer: rejection survives Worker restart and a second crawl without writes', async (t) => {
  const s = await setup(t);
  assert.equal((await s.pipeline()).status, 200);
  const p = await proposal(s, 'Kettering');
  assert.equal(p.kind, 'ambiguous');
  const result = await decide(s, p, 'reject');
  assert.equal(result.status, 200, JSON.stringify(result.value));
  await s.restart();
  assert.equal((await s.pipeline()).status, 200);
  assert.equal((await proposal(s, 'Kettering')).status, 'rejected');
  assert.equal(s.writes.length, 0);
  const state = (await s.call('state')).value;
  assert(state.decisions.some((d) => d.proposal_id === p.id && d.action === 'reject'));
});

test('billing: interrupted CHOW resumes the existing replacement and preserves all original business fields', async (t) => {
  const s = await setup(t);
  await s.pipeline();
  const p = await proposal(s, 'Tiffin');
  const op = p.options[0].operations.find((op) => op.type === 'chow');
  assert(op);
  const before = structuredClone(s.data.accounts.find((a) => a.account_id === op.account_id));
  s.failLink(true);
  assert.equal((await decide(s, p)).status, 409);
  assert.equal((await proposal(s, 'Tiffin')).status, 'partial');
  assert.equal(s.writes.filter((w) => w.method === 'POST').length, 1);
  await s.restart();
  s.failLink(false);
  const resumed = await decide(s, p, 'resume');
  assert.equal(resumed.status, 200, JSON.stringify(resumed.value));
  const after = s.data.accounts.find((a) => a.account_id === op.account_id);
  assert(after.chow_current_account);
  assert.deepEqual(after, { ...before, chow_current_account: after.chow_current_account });
  const replacement = s.data.accounts.find((a) => a.account_id === after.chow_current_account);
  assert.equal(replacement.parent_id, p.parent.account_id);
  assert.equal(replacement.lifetime_revenue, 0);
  assert.equal(replacement.outstanding_ar, 0);
  assert.equal(s.writes.filter((w) => w.method === 'POST').length, 1);
  await s.pipeline();
  assert(
    !(await s.call('state')).value.proposals.some(
      (row) => row.title === p.title && row.status === 'pending'
    )
  );
});

test('sales operations: simultaneous approvals apply the stored correction once; stale evidence blocks writes', async (t) => {
  const s = await setup(t);
  await s.pipeline();
  const p = await proposal(s, 'Portsmouth');
  const [first, second] = await Promise.all([s.reviewer(), s.reviewer()]);
  const results = await Promise.all([
    s.call('decision', { ...first, body: decision(p) }),
    s.call('decision', { ...second, body: decision(p) }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].fields.billing_zip, '45662');
  const stale = await proposal(s, 'Crossings of Lima');
  s.data.accounts.find(
    (a) => a.account_id === stale.candidates[0].account.account_id
  ).outstanding_ar = 123;
  const failed = await decide(s, stale);
  assert.equal(failed.status, 409);
  assert.match(failed.value.error, /stale/);
  assert.equal(s.writes.length, 1);
  assert.equal((await proposal(s, 'Crossings of Lima')).status, 'stale');
});

test('reliability: successful create with lost response is reconciled without a second POST', async (t) => {
  const s = await setup(t);
  await s.pipeline();
  const p = await proposal(s, 'Batavia');
  s.loseCreateResponse(true);
  const result = await decide(s, p);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(s.writes.filter((w) => w.method === 'POST').length, 1);
  assert.equal((await proposal(s, 'Batavia')).status, 'applied');
  await s.pipeline();
  assert(
    !(await s.call('state')).value.proposals.some(
      (row) => row.title === p.title && row.status === 'pending'
    )
  );
});

test('security: CSRF, same-origin, bounded bodies and immutable decisions protect the HTTP boundary', async (t) => {
  const s = await setup(t);
  await s.pipeline();
  const p = await proposal(s, 'Portsmouth');
  assert.equal((await s.call('decision', { body: decision(p) })).status, 409);
  const cross = await s.reviewer();
  assert.equal(
    (
      await s.call('decision', {
        ...cross,
        headers: { ...cross.headers, origin: 'https://attacker.test' },
        body: decision(p),
      })
    ).status,
    409
  );
  const arbitrary = await s.reviewer();
  assert.equal(
    (
      await s.call('decision', {
        ...arbitrary,
        body: { ...decision(p), patch: { name: 'Forged' } },
      })
    ).status,
    409
  );
  const oversize = await s.reviewer();
  assert.equal(
    (await s.call('decision', { ...oversize, body: { ...decision(p), note: 'x'.repeat(9000) } }))
      .status,
    409
  );
  assert.equal((await s.call('decision', { body: null })).status, 409);
  assert.equal(
    (await s.call('decision', { body: [], headers: { authorization: `Bearer ${cronSecret}` } }))
      .status,
    409
  );
  assert.equal(
    (
      await s.call('decision', {
        body: decision(p),
        headers: { authorization: `Bearer ${cronSecret}` },
      })
    ).status,
    409
  );
  assert.equal(s.writes.length, 0);
  const valid = await s.reviewer();
  const result = await s.call('decision', {
    ...valid,
    headers: { ...valid.headers, 'oai-authenticated-user-id': 'forged-admin' },
    body: decision(p, 'reject'),
  });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const state = (await s.call('state')).value,
    serialized = JSON.stringify(state);
  assert.equal(state.decisions.find((d) => d.proposal_id === p.id).actor, 'anonymous');
  for (const secret of [
    fakeToken,
    cronSecret,
    valid.cookie.split('=')[1],
    valid.headers['x-csrf-token'],
  ])
    assert(!serialized.includes(secret));
  assert(!serialized.includes('session_id'));
  assert(!JSON.stringify((await s.call('export')).value).includes(fakeToken));
});

test('operator: failed source refresh leaves the last successful review queue intact', async (t) => {
  const s = await setup(t);
  const first = await s.pipeline();
  assert.equal(first.status, 200, JSON.stringify(first.value));
  const before = (await s.call('state')).value.proposals.map((p) => [p.id, p.status]);
  assert(before.length > 0);
  s.failSource(true);
  assert.equal((await s.pipeline()).status, 409);
  const state = (await s.call('state')).value;
  assert.deepEqual(
    state.proposals.map((p) => [p.id, p.status]),
    before
  );
  assert(state.runs.some((r) => r.status === 'failed'));
  assert.equal(s.writes.length, 0);
});

test('CRM operator: documented read methods and manual account/contact drafts stay approval-only', async (t) => {
  const s = await setup(t);
  for (const entity of ['me', 'accounts', 'contacts'])
    assert.equal((await s.call(`crm?entity=${entity}`)).status, 200);
  const account = s.data.accounts.find((a) => a.name.includes('Portsmouth'));
  const contact = s.data.contacts[0];
  for (const [entity, id] of [
    ['accounts', account.account_id],
    ['contacts', contact.contact_id],
  ])
    assert.equal((await s.call(`crm?entity=${entity}&id=${id}`)).status, 200);
  const drafts = [
    {
      entity: 'accounts',
      recordId: account.account_id,
      fields: { phone: '555-010-9999' },
      note: 'Verified updated office phone',
    },
    {
      entity: 'accounts',
      fields: {
        name: 'Isolated test account',
        billing_street: '9 Test Road',
        billing_city: 'Test City',
        billing_state: 'OH',
      },
      note: 'Reviewed new account evidence',
    },
    {
      entity: 'contacts',
      recordId: contact.contact_id,
      fields: { title: 'Administrator' },
      note: 'Verified contact title',
    },
    {
      entity: 'contacts',
      fields: {
        account_id: account.account_id,
        name: 'Isolated test contact',
        email: 'isolated@example.test',
      },
      note: 'Reviewed contact evidence',
    },
  ];
  for (const draft of drafts) {
    const writesBefore = s.writes.length;
    const staged = await s.call('draft', { ...(await s.reviewer()), body: draft });
    assert.equal(staged.status, 200, JSON.stringify(staged.value));
    assert.equal(s.writes.length, writesBefore, 'draft must not write');
    const approved = await decide(s, staged.value);
    assert.equal(approved.status, 200, JSON.stringify(approved.value));
    assert.equal(s.writes.length, writesBefore + 1);
  }
  assert.deepEqual(
    new Set(s.writes.map((w) => `${w.method} ${w.entity}`)),
    new Set(['PATCH accounts', 'POST accounts', 'PATCH contacts', 'POST contacts'])
  );
});

test('CRM operator: returning to an earlier draft restores its exact reviewable version and applies once', async (t) => {
  const s = await setup(t), contact = s.data.contacts[0];
  const stage = async (title) => {
    const result = await s.call('draft', {
      ...(await s.reviewer()),
      body: { entity: 'contacts', recordId: contact.contact_id, fields: { title }, note: 'Verified contact title' },
    });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  };
  const first = await stage('Verified administrator');
  const second = await stage('Regional administrator');
  const restored = await stage('Verified administrator');
  assert.equal(restored.id, first.id);
  assert.equal(restored.status, 'pending');
  const state = (await s.call('state')).value;
  assert(state.proposals.some((p) => p.id === first.id && p.status === 'pending'));
  assert(!state.proposals.some((p) => p.id === second.id));
  assert.equal(s.writes.length, 0);
  const applied = await decide(s, restored);
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(contact.title, 'Verified administrator');
  assert.equal(s.writes.length, 1);
});

test('billing: manual CHOW resume refuses ambiguous creation markers after Worker restart', async (t) => {
  const s = await setup(t);
  const source = s.data.accounts.find((a) => a.name.includes('Tiffin') && Number(a.outstanding_ar) > 0);
  const parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
  const draft = await s.call('draft', {
    ...(await s.reviewer()),
    body: { entity: 'accounts', recordId: source.account_id, fields: { parent_id: parent.account_id }, note: 'Verified current parent' },
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.value));
  s.failLink(true);
  assert.equal((await decide(s, draft.value)).status, 409);
  const replacement = s.data.accounts.find((a) => (a.note ?? '').includes(draft.value.marker));
  assert(replacement);
  s.data.accounts.push({ ...structuredClone(replacement), account_id: 'ambiguous-marker-copy' });
  await s.restart();
  s.failLink(false);
  const before = s.writes.length;
  const withheld = await decide(s, draft.value, 'resume');
  assert.equal(withheld.status, 409);
  assert.match(withheld.value.error, /Multiple operation markers/);
  assert.equal(s.writes.length, before);
  assert(!source.chow_current_account);
  s.data.accounts.splice(s.data.accounts.findIndex((a) => a.account_id === 'ambiguous-marker-copy'), 1);
  const resumed = await decide(s, draft.value, 'resume');
  assert.equal(resumed.status, 200, JSON.stringify(resumed.value));
  assert.equal(source.chow_current_account, replacement.account_id);
  assert.equal(s.writes.filter((w) => w.method === 'POST').length, 1);
});
