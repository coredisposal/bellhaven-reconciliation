import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, fakeToken, cronSecret } from './harness.mjs';

// Exercise the actual local and hosted bundles together. Only the CRM and
// public website are simulated; the proxy, HTTP handlers, sessions, D1 ledger,
// reconciliation and approval executors are the compiled production code.
async function setup(t) {
  const hosted = await createHarness();
  let local;
  t.after(async () => {
    try {
      await local?.close();
    } finally {
      await hosted.close();
    }
  });
  local = await createHarness({ mode: 'proxy', backend: hosted });
  return { hosted, local };
}

function ok(response) {
  assert.equal(response.status, 200, JSON.stringify(response.value));
  return response.value;
}
const get = async (app, route) => ok(await app.call(route));
const post = async (app, route, body) => app.call(route, { ...(await app.reviewer()), body });
const decide = (app, p, action = 'approve', note = 'Verified source and billing evidence') =>
  post(app, 'decision', {
    id: p.id,
    version: p.version,
    optionId: p.options[0]?.id,
    action,
    note,
  });
async function proposal(app, title) {
  const p = (await get(app, 'state')).proposals.find((row) => row.title.includes(title));
  assert(p, `Missing proposal for ${title}`);
  return p;
}

test('local to hosted: all nine CRM operations use one ledger with approved writes and API readback', async (t) => {
  const { hosted, local } = await setup(t);
  const catalog = await get(local, 'api-catalog');
  assert.equal(catalog.operations.length, 9);
  assert.equal((await get(local, 'crm?entity=me')).name, 'Test reviewer');
  const accounts = await get(local, 'crm?entity=accounts&page=2&page_size=50');
  assert.equal(accounts.page, 2);
  assert.equal(accounts.data.length, 50);
  assert.equal(accounts.total, 121);
  const contacts = await get(local, 'crm?entity=contacts&page=2&page_size=50');
  assert.equal(contacts.data.length, 17);
  assert.equal(contacts.total, 67);
  const account = hosted.data.accounts.find((a) => a.name.includes('Portsmouth'));
  const contact = hosted.data.contacts[0];
  for (const [entity, row, key] of [
    ['accounts', account, 'account_id'],
    ['contacts', contact, 'contact_id'],
  ]) {
    assert.deepEqual(await get(local, `crm?entity=${entity}&id=${row[key]}`), row);
  }
  const filtered = await get(local, 'crm?entity=accounts&q=Portsmouth&state=OH');
  assert(filtered.data.length > 0);
  assert(filtered.data.every((a) => a.name.includes('Portsmouth') && a.billing_state === 'OH'));
  const linked = await get(local, `crm?entity=contacts&account_id=${contact.account_id}`);
  assert(linked.data.every((c) => c.account_id === contact.account_id));

  const drafts = [
    {
      entity: 'accounts',
      recordId: account.account_id,
      fields: { phone: '555-010-9999' },
      note: 'Verified office phone',
    },
    {
      entity: 'accounts',
      fields: {
        name: 'Isolated account',
        billing_street: '9 Test Road',
        billing_city: 'Test City',
        billing_state: 'OH',
      },
      note: 'Reviewed new facility evidence',
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
        name: 'Isolated contact',
        email: 'isolated@example.test',
      },
      note: 'Verified contact association',
    },
  ];
  for (const draft of drafts) {
    const before = hosted.writes.length;
    const staged = ok(await post(local, 'draft', draft));
    assert.equal(hosted.writes.length, before, 'Staging may not write to CRM');
    assert((await get(hosted, 'state')).proposals.some((p) => p.id === staged.id));
    const applied = ok(await decide(local, staged));
    assert.equal(applied.status, 'applied');
    assert.equal(hosted.writes.length, before + 1);
    const readback = await get(local, `crm?entity=${draft.entity}&id=${applied.recordId}`);
    for (const [field, value] of Object.entries(draft.fields))
      assert.equal(readback[field], value, `Readback mismatch for ${draft.entity}.${field}`);
    const duplicate = await decide(hosted, staged);
    assert.equal(duplicate.status, 409, 'Hosted view cannot apply the same local approval again');
    assert.equal(hosted.writes.length, before + 1);
  }
  const observed = new Set(
    hosted.requests
      .filter((r) => new URL(r.url).pathname.startsWith('/api/v1/'))
      .map((r) => {
        const pathname = new URL(r.url).pathname.replace(
          /\/(accounts|contacts)\/[^/]+$/,
          '/$1/{id}'
        );
        return `${r.method} ${pathname}`;
      })
  );
  assert.deepEqual(
    observed,
    new Set(catalog.operations.map((op) => `${op.method} ${op.path.replace(/\{[^}]+\}/g, '{id}')}`))
  );
  assert.equal((await local.db.prepare('SELECT COUNT(*) AS n FROM proposals').first()).n, 0);
  assert.deepEqual(await get(local, 'state'), await get(hosted, 'state'));
  assert.equal(local.writes.length, 0, 'Local process must never contact the CRM directly');
  assert(local.requests.every((r) => new URL(r.url).origin === 'https://e2e-backend.chatgpt.site'));
  const state = await get(local, 'state');
  assert(state.decisions.every((d) => d.actor === 'anonymous (local proxy)'));
  const exported = await get(local, 'export');
  assert.equal(exported.operations.length, 4);
  assert(exported.operations.every((op) => op.status === 'complete' && op.data.after));
  for (const secret of [fakeToken, cronSecret, 'test-only-proxy-key', 'test-only-service-token'])
    assert(!JSON.stringify({ state, exported, catalog }).includes(secret));
});

test('local to hosted: reject, audited reopen, approval and daily rerun remain consistent after restart', async (t) => {
  const { hosted, local } = await setup(t);
  const first = ok(await post(local, 'pipeline', {}));
  assert.equal(first.facilities, 35);
  const p = await proposal(local, 'Portsmouth');
  ok(await decide(local, p, 'reject', 'Awaiting verification of the postal code'));
  assert.equal((await proposal(hosted, 'Portsmouth')).status, 'rejected');
  assert.equal(hosted.writes.length, 0);
  await local.restart();
  await hosted.restart();
  assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0);
  assert.equal((await proposal(local, 'Portsmouth')).status, 'rejected');
  assert.equal((await decide(local, p, 'reopen', '')).status, 409);
  ok(
    await decide(
      local,
      p,
      'reopen',
      'Postal evidence is now verified; review the unchanged proposal'
    )
  );
  assert.equal((await proposal(hosted, 'Portsmouth')).status, 'pending');
  ok(await decide(local, p));
  assert.equal(hosted.writes.length, 1);
  assert.equal(hosted.writes[0].fields.billing_zip, '45662');
  ok(await post(local, 'pipeline', {}));
  assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0);
  const state = await get(local, 'state');
  assert(!state.proposals.some((row) => row.title === p.title && row.status === 'pending'));
  assert(state.audits.some((a) => a.proposal_id === p.id && a.event === 'case_reopened'));
  const exported = await get(local, 'export');
  assert.deepEqual(
    exported.decisions.filter((d) => d.proposal_id === p.id).map((d) => d.action),
    ['reject', 'reopen', 'approve']
  );
  assert(
    exported.operations.some((o) => o.proposal_id === p.id && o.data.after.billing_zip === '45662')
  );
  const localReport = await get(local, 'report');
  const hostedReport = await get(hosted, 'report');
  assert.deepEqual(localReport.current, hostedReport.current);
  assert.deepEqual(localReport.history, hostedReport.history);
  assert.equal(localReport.history.verified_applied_cases, 1);
  assert.equal(localReport.history.rejected_cases, 1);
  assert.equal(localReport.source.counts.facilities, 35);
  assert.equal(localReport.recovery.case_count, 0);
});

test('local to hosted: interrupted CHOW resumes in the other view without re-creation or billing changes', async (t) => {
  const { hosted, local } = await setup(t);
  ok(await post(local, 'pipeline', {}));
  const p = await proposal(local, 'Tiffin');
  const op = p.options[0].operations.find((o) => o.type === 'chow');
  const before = structuredClone(hosted.data.accounts.find((a) => a.account_id === op.account_id));
  hosted.failLink(true);
  assert.equal((await decide(local, p)).status, 409);
  assert.equal((await proposal(hosted, 'Tiffin')).status, 'partial');
  assert.equal((await get(local, 'report')).recovery.case_count, 1);
  assert.equal(hosted.writes.filter((w) => w.method === 'POST').length, 1);
  await hosted.restart();
  await local.restart();
  hosted.failLink(false);
  ok(await decide(hosted, p, 'resume'));
  const after = await get(local, `crm?entity=accounts&id=${before.account_id}`);
  assert(after.chow_current_account);
  assert.deepEqual(after, { ...before, chow_current_account: after.chow_current_account });
  const replacement = await get(local, `crm?entity=accounts&id=${after.chow_current_account}`);
  assert.equal(replacement.parent_id, p.parent.account_id);
  assert.equal(replacement.lifetime_revenue, 0);
  assert.equal(replacement.outstanding_ar, 0);
  assert.equal(hosted.writes.filter((w) => w.method === 'POST').length, 1);
  assert.equal((await get(local, 'report')).recovery.case_count, 0);
  assert.equal((await proposal(local, 'Tiffin')).status, 'applied');
  assert.equal(
    (await get(local, 'state')).decisions.filter(
      (d) => d.proposal_id === p.id && d.action === 'approve'
    ).length,
    1
  );
});

test('local to hosted: both HTTP boundaries enforce stored proposals, stale checks and concurrent decisions', async (t) => {
  const { hosted, local } = await setup(t);
  ok(await post(local, 'pipeline', {}));
  const p = await proposal(local, 'Portsmouth');
  const payload = { id: p.id, version: p.version, optionId: p.options[0].id, action: 'approve' };
  const count = local.requests.length;
  assert.equal((await local.call('decision', { body: payload })).status, 409);
  assert.equal(local.requests.length, count, 'Invalid local CSRF must not reach hosted backend');
  const arbitrary = await post(local, 'decision', { ...payload, patch: { name: 'Unreviewed' } });
  assert.equal(arbitrary.status, 409);
  assert.match(arbitrary.value.error, /Arbitrary CRM fields/);
  const forged = await hosted.call('decision', {
    body: payload,
    headers: { 'x-bellhaven-proxy': 'incorrect-proxy-key' },
  });
  assert.equal(forged.status, 409);
  assert.equal(hosted.writes.length, 0);
  const results = await Promise.all([decide(local, p), decide(hosted, p)]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(hosted.writes.length, 1);
  const stale = await proposal(local, 'Crossings of Lima');
  hosted.data.accounts.find(
    (a) => a.account_id === stale.candidates[0].account.account_id
  ).outstanding_ar = 456;
  const refused = await decide(local, stale);
  assert.equal(refused.status, 409);
  assert.match(refused.value.error, /stale/);
  assert.equal((await proposal(hosted, 'Crossings of Lima')).status, 'stale');
  assert.equal(hosted.writes.length, 1);
});

test('local to hosted: ordinary parent, duplicate, absence, address and uncertain creation workflows preserve unrelated records', async (t) => {
  const { hosted, local } = await setup(t);
  ok(await post(local, 'pipeline', {}));
  const contactsBefore = structuredClone(hosted.data.contacts);
  const ashtabula = structuredClone(hosted.data.accounts.find((a) => a.name.includes('Ashtabula')));
  assert.equal((await proposal(local, 'Ashtabula')).kind, 'unchanged');
  const cases = [
    ['Crossings of Lima', 'parent_correction'],
    ['Owosso', 'duplicate'],
    ['Alliance', 'absent'],
    ['Chesterton', 'field_correction'],
    ['Kettering', 'ambiguous'],
    ['Amberly Manor', 'ambiguous'],
    ['Union Square', 'new_account'],
    ['Batavia', 'new_account'],
  ];
  for (const [title, kind] of cases) {
    const p = await proposal(local, title);
    assert.equal(p.kind, kind);
    if (title === 'Amberly Manor') {
      const writes = hosted.writes.length;
      assert(p.matching_conflicts.some((conflict) => conflict.kind === 'name_collision'));
      assert(p.options.some((option) => option.resolution === 'existing'));
      assert(p.options.some((option) => option.resolution === 'separate'));
      ok(await decide(local, p, 'reject', 'Verify whether the same-name accounts represent separate facilities'));
      assert.equal(hosted.writes.length, writes);
      continue;
    }
    const operations = p.options[0].operations;
    const before = new Map(
      operations
        .filter((o) => o.account_id)
        .map((o) => [
          o.account_id,
          structuredClone(hosted.data.accounts.find((a) => a.account_id === o.account_id)),
        ])
    );
    const writeCount = hosted.writes.length;
    if (title === 'Batavia') hosted.loseCreateResponse(true);
    ok(
      await decide(
        local,
        p,
        'approve',
        kind === 'ambiguous'
          ? 'Selected the recommended current facility account after reviewing equal-address alternatives'
          : 'Verified the source, identity and proposed fields'
      )
    );
    assert.equal(hosted.writes.length, writeCount + operations.length);
    assert.equal((await proposal(hosted, title)).status, 'applied');
    for (const op of operations) {
      if (!op.account_id) continue;
      const original = before.get(op.account_id);
      const after = await get(local, `crm?entity=accounts&id=${op.account_id}`);
      for (const [field, value] of Object.entries(op.fields)) assert.equal(after[field], value);
      assert.equal(after.lifetime_revenue, original.lifetime_revenue);
      assert.equal(after.outstanding_ar, original.outstanding_ar);
      if (op.type === 'duplicate') {
        assert.equal(after.parent_id, original.parent_id);
        assert.equal(after.status, 'Inactive');
        assert(after.duplicate_of_account);
      }
      if (kind === 'absent') {
        assert.equal(after.status, 'Needs Review');
        assert.equal(after.parent_id, original.parent_id);
        assert.match(after.note, /no new owner or closure inferred/);
      }
    }
  }
  assert.deepEqual(await get(local, `crm?entity=accounts&id=${ashtabula.account_id}`), ashtabula);
  assert.deepEqual(hosted.data.contacts, contactsBefore);
  assert.equal(hosted.writes.filter((w) => w.method === 'POST').length, 2);
  const writes = hosted.writes.length;
  ok(await post(local, 'pipeline', {}));
  assert.equal(ok(await post(local, 'pipeline', {})).new_proposals, 0);
  assert.equal(hosted.writes.length, writes);
  const state = await get(local, 'state');
  for (const [title] of cases)
    assert(!state.proposals.some((p) => p.title.includes(title) && p.status === 'pending'), title);
});

test('local to hosted: Locations exposes complete saved scraper output independently of review decisions and recent run limits', async (t) => {
  const { hosted, local } = await setup(t);
  assert.equal((await get(local, 'state')).website, null);
  ok(await post(local, 'pipeline', {}));
  const saved = (await get(local, 'state')).website;
  assert.equal(saved.facilities.length, 35);
  assert.deepEqual(saved.coverage, { complete: true, expected: 35, found: 35 });
  assert(saved.run_id);
  assert(saved.collected_at);
  assert.deepEqual(saved, (await get(hosted, 'state')).website);
  for (const facility of saved.facilities) {
    for (const key of ['name', 'street_address', 'city', 'state', 'postal_code',
      'administrator', 'phone_raw', 'source_url', 'retrieved_at_utc'])
      assert(facility[key]?.trim(), `${facility.name}: missing ${key}`);
    assert(facility.care_offerings.length > 0);
  }
  for (const city of ['Findlay', 'Erie'])
    assert.deepEqual(saved.facilities.find((f) => f.city === city).care_offerings,
      ['Assisted Living', 'Memory Support']);
  const reads = hosted.requests.length;
  await get(local, 'state');
  await get(hosted, 'state');
  assert.equal(hosted.requests.length, reads, 'Locations reads saved data without refetching upstream');
  assert.equal(hosted.writes.length, 0);
  ok(await decide(local, await proposal(local, 'Kettering'), 'reject',
    'Equal candidate evidence needs an operator decision'));
  ok(await decide(local, await proposal(local, 'Portsmouth')));
  assert.deepEqual((await get(local, 'state')).website, saved,
    'Approving or rejecting proposals cannot change saved scraper rows');
  const writes = hosted.writes.length;
  hosted.failSource(true);
  assert.equal((await post(local, 'pipeline', {})).status, 409);
  assert.deepEqual((await get(local, 'state')).website, saved);
  // Seed additional failed-run metadata to verify the independent snapshot
  // query, without repeating the same upstream outage 25 times.
  for (let i = 1; i <= 25; i++) {
    const at = new Date(Date.now() + i * 60000).toISOString();
    await hosted.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').bind(
      `later-failure-${i}`, 'failed', at, at, JSON.stringify({ error: 'Source unavailable' })
    ).run();
  }
  await hosted.restart();
  await local.restart();
  const state = await get(local, 'state');
  assert.equal(state.runs.length, 20);
  assert(!state.runs.some((r) => r.id === saved.run_id));
  assert.deepEqual(state.website, saved);
  assert.deepEqual(state.website, (await get(hosted, 'state')).website);
  assert.equal(hosted.writes.length, writes);
});
