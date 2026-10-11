import test from 'node:test';
import assert from 'node:assert/strict';
import { crmClient, API_CATALOG } from '../lib/sources.mjs';
import { ORIGIN } from '../lib/core.mjs';

const TOKEN = 'synthetic-api-client-token';
const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});
function recorder(responses = []) {
  const calls = [];
  const client = crmClient(TOKEN, async (url, options) => {
    calls.push({ url, options });
    return responses.shift() ?? json({ data: { account_id: 'result' } });
  });
  return { client, calls };
}

test('catalog covers exactly the nine documented methods, observed fields, and explicit application bounds', () => {
  assert.equal(API_CATALOG.operations.length, 9);
  assert.equal(new Set(API_CATALOG.operations.map((o) => o.method + ' ' + o.path)).size, 9);
  assert.equal(API_CATALOG.deletion_supported, false);
  assert.equal(API_CATALOG.body_schema_documented, false);
  assert.equal(API_CATALOG.pagination.upstream_bounds_documented, false);
  assert.equal(API_CATALOG.contact_fields.is_active, 'boolean');
  assert.equal(API_CATALOG.account_fields.outstanding_ar, 'number');
  assert(!('note' in API_CATALOG.contact_fields));
  assert(!JSON.stringify(API_CATALOG).includes(TOKEN));
});

test('account and contact list filters use exact documented names, string values and URL encoding', async () => {
  const response = { data: [], page: 2, page_size: 10, total: 0 },
    s = recorder([json(response), json({ data: [], page: 1, page_size: 50, total: 0 })]);
  assert.deepEqual(
    await s.client.listAccounts({
      q: 'Bellhaven & Care',
      city: 'New York',
      state: 'NY',
      zip: '01234',
      street: '1 N Main St',
      parent_id: 'p/1',
      page: 2,
      page_size: 10,
    }),
    response
  );
  await s.client.listContacts({ account_id: 'a/1', q: 'Alex & Kim' });
  assert.equal(
    s.calls[0].url,
    ORIGIN +
      '/api/v1/accounts?q=Bellhaven+%26+Care&city=New+York&state=NY&zip=01234&street=1+N+Main+St&parent_id=p%2F1&page=2&page_size=10'
  );
  assert.equal(
    s.calls[1].url,
    ORIGIN + '/api/v1/contacts?account_id=a%2F1&q=Alex+%26+Kim&page=1&page_size=50'
  );
  for (const call of s.calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(call.options.redirect, 'manual');
    assert(call.options.signal instanceof AbortSignal);
    assert(!call.url.includes(TOKEN));
  }
});

test('all single-record and write helpers use exact paths and bodies; legacy account aliases remain identical', async () => {
  const s = recorder([
    json({ data: { account_id: 'a/1?x', name: 'Existing account' } }),
    json({ contact_id: 'c/1?x', account_id: 'a', name: 'Existing contact' }),
    json({ data: { account_id: 'new' } }),
    json({ data: { account_id: 'a' } }),
    json({ data: { contact_id: 'new-contact' } }),
    json({ data: { contact_id: 'c' } }),
    json({ name: 'Example workspace' }),
  ]);
  assert.equal(s.client.get, s.client.getAccount);
  assert.equal(s.client.create, s.client.createAccount);
  assert.equal(s.client.patch, s.client.patchAccount);
  assert.deepEqual(await s.client.getAccount('a/1?x'), { account_id: 'a/1?x', name: 'Existing account' });
  assert.deepEqual(await s.client.getContact('c/1?x'), { contact_id: 'c/1?x', account_id: 'a', name: 'Existing contact' });
  const account = {
    name: 'New account',
    parent_id: 'parent',
    billing_zip: '01234',
    lifetime_revenue: 0,
    outstanding_ar: 0,
  };
  const contact = {
    account_id: 'a',
    name: 'New contact',
    title: 'Administrator',
    email: 'person@example.invalid',
    phone: '555-0100',
    is_active: false,
  };
  await s.client.createAccount(account);
  await s.client.patchAccount('a', { name: 'Renamed', note: 'Prior value retained' });
  await s.client.createContact(contact);
  await s.client.patchContact('c', { is_active: true });
  assert.deepEqual(await s.client.me(), { name: 'Example workspace' });
  assert.deepEqual(
    s.calls.map((c) => [c.options.method, c.url.replace(ORIGIN + '/api/v1', '')]),
    [
      ['GET', '/accounts/a%2F1%3Fx'],
      ['GET', '/contacts/c%2F1%3Fx'],
      ['POST', '/accounts'],
      ['PATCH', '/accounts/a'],
      ['POST', '/contacts'],
      ['PATCH', '/contacts/c'],
      ['GET', '/me'],
    ]
  );
  assert.deepEqual(JSON.parse(s.calls[2].options.body), account);
  assert.deepEqual(JSON.parse(s.calls[4].options.body), contact);
  assert.equal(s.calls.filter((c) => c.options.method === 'POST').length, 2);
});

test('legacy all-pages helpers read every page and keep single-page list results separate', async () => {
  const s = recorder([
    json({ data: [{ account_id: 'a', name: 'A' }], page: 1, page_size: 50, total: 2 }),
    json({ data: [{ account_id: 'b', name: 'B' }], page: 2, page_size: 50, total: 2 }),
    json({ data: [{ contact_id: 'c', account_id: 'a', name: 'C' }], page: 1, page_size: 50, total: 2 }),
    json({ data: [{ contact_id: 'd', account_id: 'b', name: 'D' }], page: 2, page_size: 50, total: 2 }),
  ]);
  assert.deepEqual(await s.client.accounts(), [{ account_id: 'a', name: 'A' }, { account_id: 'b', name: 'B' }]);
  assert.deepEqual(await s.client.contacts(), [{ contact_id: 'c', account_id: 'a', name: 'C' }, { contact_id: 'd', account_id: 'b', name: 'D' }]);
  assert.deepEqual(
    s.calls.map((c) => c.url.replace(ORIGIN + '/api/v1', '')),
    [
      '/accounts?page=1&page_size=50',
      '/accounts?page=2&page_size=50',
      '/contacts?page=1&page_size=50',
      '/contacts?page=2&page_size=50',
    ]
  );
});

test('unknown filters, unsupported types, and pagination outside application bounds fail before network access', async () => {
  const s = recorder([json({ data: [], page: 100, page_size: 100, total: 0 })]);
  for (const filters of [
    { unknown: 'x' },
    { q: 7 },
    { zip: 12345 },
    { q: null },
    { page: '2' },
    { page: 0 },
    { page: 101 },
    { page: 1.5 },
    { page: null },
    { page_size: 0 },
    { page_size: 101 },
    { page_size: Infinity },
    [],
    null,
  ])
    await assert.rejects(s.client.listAccounts(filters), /CRM/);
  await assert.rejects(s.client.listContacts({ city: 'Example' }), /Unknown/);
  await assert.rejects(s.client.listContacts({ account_id: 123 }), /strings/);
  assert.equal(s.calls.length, 0);
  await s.client.listAccounts({ page: 100, page_size: 100 });
  assert.match(s.calls[0].url, /page=100&page_size=100$/);
});

test('read-only or unknown body fields, wrong field types and invalid identifiers are rejected without writes', async () => {
  const s = recorder();
  await assert.rejects(
    s.client.createContact({ name: 'Example', note: 'Not an observed contact field' }),
    /Unknown or read-only/
  );
  await assert.rejects(s.client.patchContact('c', { is_active: 'false' }), /value type/);
  await assert.rejects(s.client.createAccount({ account_id: 'forged' }), /Unknown or read-only/);
  await assert.rejects(s.client.patchAccount('a', { outstanding_ar: NaN }), /value type/);
  await assert.rejects(s.client.patchAccount('a', {}), /nonempty object/);
  await assert.rejects(s.client.createContact(null), /nonempty object/);
  for (const id of ['', null, '..', '\n', 9])
    await assert.rejects(s.client.getContact(id), /record ID/);
  await assert.rejects(s.client.request('/contacts/c', 'DELETE'), /Unsupported/);
  await assert.rejects(
    s.client.request('/accounts/%2e%2e', 'PATCH', { name: 'unsafe' }),
    /Unsupported/
  );
  assert.equal(s.calls.length, 0);
});

test('HTTP failures, network failures and malformed JSON do not leak credentials or retry a write', async () => {
  for (const fetcher of [
    async () => ({ ok: false, status: 500, json: async () => ({ error: TOKEN }) }),
    async () => {
      throw new Error('Authorization Bearer ' + TOKEN);
    },
    async () => ({
      ok: true,
      status: 201,
      json: async () => {
        throw new Error('Response ' + TOKEN);
      },
    }),
  ]) {
    let attempts = 0;
    const client = crmClient(TOKEN, async (...args) => {
      attempts++;
      return fetcher(...args);
    });
    await assert.rejects(client.createContact({ name: 'Example', account_id: 'a' }), (error) => {
      assert(!error.message.includes(TOKEN));
      assert.match(error.message, /retry/);
      return true;
    });
    assert.equal(attempts, 1);
  }
});

test('unknown identity payload cannot echo the configured token or credential fields', async () => {
  const s = recorder([
    json({
      name: 'Workspace',
      api_token: TOKEN,
      nested: { authorization: 'Bearer ' + TOKEN },
      note: 'Unexpected ' + TOKEN,
    }),
  ]);
  const me = await s.client.me();
  assert.deepEqual(me, { name: 'Workspace', nested: {}, note: 'Unexpected [redacted]' });
});

test('CRM client refuses browser construction and requires a nonempty server token', () => {
  assert.throws(() => crmClient(''), /not configured/);
  const prior = globalThis.window;
  try {
    globalThis.window = {};
    assert.throws(() => crmClient(TOKEN), /only on the server/);
  } finally {
    if (prior === undefined) delete globalThis.window;
    else globalThis.window = prior;
  }
});

test('malformed account evidence is rejected by detail, filtered lists and complete snapshots', async () => {
  const valid = { account_id: 'a', name: 'Example facility' };
  for (const invalid of [
    null,
    [],
    { ...valid, account_id: '' },
    { ...valid, name: '   ' },
    { ...valid, parent_id: 42 },
    { ...valid, billing_zip: 12345 },
    { ...valid, lifetime_revenue: false },
    { ...valid, outstanding_ar: { balance: 100 } },
    { ...valid, phone: ['555-0100'] },
    { ...valid, created_by_candidate: 'false' },
  ]) {
    for (const method of ['getAccount', 'listAccounts', 'accounts']) {
      const response = method === 'getAccount'
        ? { data: invalid }
        : { data: [invalid], page: 1, page_size: 50, total: 1 };
      const s = recorder([json(response)]);
      await assert.rejects(s.client[method](...(method === 'getAccount' ? ['a'] : [])), /CRM/);
      assert.equal(s.calls.length, 1);
      assert.equal(s.calls[0].options.method, 'GET');
    }
  }
});

test('malformed contact evidence cannot enter review through detail, filtered lists or snapshots', async () => {
  const valid = { contact_id: 'c', account_id: 'a', name: 'Example administrator' };
  for (const invalid of [
    { ...valid, contact_id: ' ' },
    { ...valid, account_id: null },
    { ...valid, name: [] },
    { ...valid, email: { address: 'example@example.invalid' } },
    { ...valid, is_active: 'false' },
    { ...valid, phone: 5550100 },
    { ...valid, updated_at: false },
  ]) {
    for (const method of ['getContact', 'listContacts', 'contacts']) {
      const response = method === 'getContact'
        ? invalid
        : { data: [invalid], page: 1, page_size: 50, total: 1 };
      const s = recorder([json(response)]);
      await assert.rejects(s.client[method](...(method === 'getContact' ? ['c'] : [])), /CRM/);
      assert.equal(s.calls.length, 1);
    }
  }
});

test('valid nullable evidence remains lossless and missing balances are never filled with zero', async () => {
  const account = {
    account_id: 'a', name: 'Example facility', parent_id: null,
    billing_zip: '01234', lifetime_revenue: '100.00', outstanding_ar: null,
    phone: null, care_type: null, created_by_candidate: false,
  };
  const contact = {
    contact_id: 'c', account_id: 'a', name: 'Example administrator',
    email: null, title: null, phone: null, is_active: false,
  };
  const s = recorder([
    json({ data: account }), json(contact),
    json({ data: [{ account_id: 'b', name: 'Missing billing' }], page: 1, total: 1 }),
  ]);
  assert.deepEqual(await s.client.getAccount('a'), account);
  assert.deepEqual(await s.client.getContact('c'), contact);
  const page = await s.client.listAccounts();
  assert.equal(Object.hasOwn(page.data[0], 'lifetime_revenue'), false);
  assert.equal(Object.hasOwn(page.data[0], 'outstanding_ar'), false);
});

test('single-page API lists reject invalid pagination metadata before displaying a result', async () => {
  const valid = { data: [], page: 1, page_size: 50, total: 0 };
  for (const invalid of [
    [], null, { ...valid, data: {} },
    { ...valid, total: '0' }, { ...valid, total: -1 },
    { ...valid, total: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, page: 0 }, { ...valid, page: 1.5 },
    { ...valid, page_size: 0 }, { ...valid, page_size: '50' },
  ]) {
    for (const method of ['listAccounts', 'listContacts']) {
      const s = recorder([json(invalid)]);
      await assert.rejects(s.client[method](), /invalid pagination/);
      assert.equal(s.calls.length, 1);
    }
  }
});

test('single-record reads reject a well-formed response for a different requested CRM ID', async () => {
  for (const [method, record] of [
    ['getAccount', { account_id: 'wrong-account', name: 'Different facility' }],
    ['getContact', { contact_id: 'wrong-contact', account_id: 'a', name: 'Different person' }],
  ]) {
    for (const response of [record, { data: record }]) {
      const s = recorder([json(response)]);
      await assert.rejects(s.client[method]('requested-record'), /(?:requested|match|identity)/i);
      assert.equal(s.calls.length, 1);
      assert.equal(s.calls[0].options.method, 'GET');
    }
  }
});

test('filtered list pages reject duplicate IDs, impossible counts and the wrong requested page', async () => {
  for (const [method, record] of [
    ['listAccounts', { account_id: 'a', name: 'Example facility' }],
    ['listContacts', { contact_id: 'c', account_id: 'a', name: 'Example person' }],
  ]) {
    for (const response of [
      { data: [record, { ...record }], page: 2, page_size: 50, total: 2 },
      { data: [record], page: 2, page_size: 50, total: 0 },
      { data: [record], page: 1, page_size: 50, total: 1 },
    ]) {
      const s = recorder([json(response)]);
      await assert.rejects(s.client[method]({ page: 2 }), /(?:pagination|duplicate|page|count)/i);
      assert.equal(s.calls.length, 1);
      assert.equal(s.calls[0].options.method, 'GET');
    }
  }
});
