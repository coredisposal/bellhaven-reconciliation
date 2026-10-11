import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import baseline from '../../fixtures/baseline.json' with { type: 'json' };

// Test infrastructure only. This loads the compiled production Worker without
// Wrangler configuration, .dev.vars, inherited credentials, or a fixture mode.
// Every outbound fetch terminates in the synthetic service below.
const root = path.resolve(import.meta.dirname, '../..');
const pages = JSON.parse(readFileSync(path.join(root, 'fixtures/public-pages.json'), 'utf8'));
const origin = 'http://desk.test';
export const fakeToken = 'test-only-crm-credential';
export const cronSecret = 'test-only-cron-credential';
const json = (value, status = 200) => WorkerResponse.json(value, { status });

export async function createHarness({
  mode = 'live',
  assets = false,
  onWrite = () => {},
  backend,
  privateSite = true,
} = {}) {
  assert(['live', 'proxy'].includes(mode));
  assert(!backend || mode === 'proxy', 'A downstream Worker is only valid for proxy tests');
  const data = structuredClone(baseline),
    writes = [],
    requests = [],
    forwarded = [],
    outboundViolations = [];
  let failLink = false,
    loseCreateResponse = false,
    failSource = false,
    proxyRedirect = false;
  function assertBoundary(condition, message) {
    if (!condition) outboundViolations.push(message);
    assert(condition, message);
  }
  const upstream = async (request) => {
    const url = new URL(request.url);
    requests.push({ url: request.url, method: request.method });
    if (mode === 'proxy' && url.origin === 'https://e2e-backend.chatgpt.site') {
      assertBoundary(
        request.headers.get('x-bellhaven-proxy') === 'test-only-proxy-key',
        'Unexpected proxy credential'
      );
      assertBoundary(request.headers.get('authorization') === null, 'CRM credential sent to proxy');
      if (proxyRedirect)
        return new WorkerResponse(null, {
          status: 307,
          headers: { Location: 'https://untrusted.invalid/collect' },
        });
      if (request.method === 'POST') forwarded.push(await request.clone().json());
      if (backend) {
        assertBoundary(
          request.headers.get('oai-sites-authorization') === (privateSite ? 'Bearer test-only-service-token' : null),
          'Unexpected Site service authorization'
        );
        const response = await backend.dispatch(request);
        return new WorkerResponse(await response.arrayBuffer(), {
          status: response.status,
          headers: response.headers,
        });
      }
      return json({ forwarded: true });
    }
    assertBoundary(
      url.origin === 'https://analyst-assessment-production.up.railway.app',
      `Unrecognized outbound host: ${url.origin}`
    );
    if (!url.pathname.startsWith('/api/v1/')) {
      if (failSource) return new WorkerResponse('Unavailable', { status: 503 });
      assertBoundary(Boolean(pages[request.url]), `Unexpected source path: ${url.pathname}`);
      assertBoundary(
        request.headers.get('authorization') === null,
        'CRM credential sent to public source'
      );
      return new WorkerResponse(pages[request.url], { headers: { 'content-type': 'text/html' } });
    }
    assertBoundary(
      request.headers.get('authorization') === `Bearer ${fakeToken}`,
      'Unexpected CRM credential'
    );
    if (url.pathname === '/api/v1/me') return json({ name: 'Test reviewer', api_token: fakeToken });
    const [, entity, encodedId] =
      url.pathname.match(/^\/api\/v1\/(accounts|contacts)(?:\/([^/]+))?$/) ?? [];
    assertBoundary(Boolean(entity), `Unexpected API route: ${url.pathname}`);
    const id = encodedId ? decodeURIComponent(encodedId) : undefined;
    const key = entity === 'accounts' ? 'account_id' : 'contact_id';
    if (request.method === 'GET') {
      if (id) {
        const record = data[entity].find((row) => row[key] === id);
        return json(record ? { data: record } : { error: 'Not found' }, record ? 200 : 404);
      }
      const page = Number(url.searchParams.get('page') ?? 1),
        size = Number(url.searchParams.get('page_size') ?? 50);
      let rows = data[entity];
      const accountFilters = {
        parent_id: 'parent_id',
        city: 'billing_city',
        state: 'billing_state',
        zip: 'billing_zip',
        street: 'billing_street',
      };
      for (const [field, value] of url.searchParams) {
        if (field === 'account_id' && entity === 'contacts')
          rows = rows.filter((row) => row.account_id === value);
        if (entity === 'accounts' && Object.hasOwn(accountFilters, field))
          rows = rows.filter(
            (row) => String(row[accountFilters[field]] ?? '').toLowerCase() === value.toLowerCase()
          );
        if (field === 'q' && value)
          rows = rows.filter((row) =>
            [row.name, row.billing_street, row.billing_city, row.email, row.title]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(value.toLowerCase())
          );
      }
      return json({
        data: rows.slice((page - 1) * size, page * size),
        page,
        total: rows.length,
        page_size: size,
      });
    }
    assertBoundary(
      ['POST', 'PATCH'].includes(request.method),
      `Unexpected write method: ${request.method}`
    );
    const fields = await request.json();
    const write = { method: request.method, entity, id, fields };
    writes.push(write);
    onWrite(write);
    if (request.method === 'POST') {
      const record = { ...fields, [key]: `test-created-${writes.length}` };
      if (entity === 'accounts')
        Object.assign(record, {
          chow_current_account: '',
          duplicate_of_account: '',
          parent_name: data.accounts.find((a) => a.account_id === fields.parent_id)?.name ?? '',
        });
      data[entity].push(record);
      if (loseCreateResponse) return new WorkerResponse('Response lost', { status: 504 });
      return json({ data: record }, 201);
    }
    if (failLink && fields.chow_current_account) return json({ error: 'Link unavailable' }, 503);
    const record = data[entity].find((row) => row[key] === id);
    if (!record) return json({ error: 'Not found' }, 404);
    Object.assign(record, fields);
    if (entity === 'accounts' && Object.hasOwn(fields, 'parent_id'))
      record.parent_name = data.accounts.find((a) => a.account_id === fields.parent_id)?.name ?? '';
    return json({ data: record });
  };
  const buildRoot = path.join(root, 'dist/server');
  const moduleNames = readdirSync(buildRoot, { recursive: true }).filter((name) =>
    /\.m?js$/.test(name)
  );
  const clientRoot = path.join(root, 'dist/client');
  const assetFiles = new Map(
    assets
      ? readdirSync(clientRoot, { recursive: true })
          .filter(
            (name) =>
              !name.split(/[\\/]/).some((part) => part.startsWith('.')) &&
              /\.(?:m?js|css|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|json)$/.test(name)
          )
          .map((name) => ['/' + name.replaceAll('\\', '/'), path.join(clientRoot, name)])
      : []
  );
  const assetTypes = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  const serveAsset = (request) => {
    const file = assetFiles.get(new URL(request.url).pathname);
    if (!file) return new WorkerResponse('Not found', { status: 404 });
    return new WorkerResponse(request.method === 'HEAD' ? null : readFileSync(file), {
      headers: {
        'Content-Type': assetTypes[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  };
  const runtimeRoot = path.join(root, '.sites-runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const persist = mkdtempSync(path.join(runtimeRoot, 'e2e-'));
  const options = {
    name: 'bellhaven-e2e',
    host: '127.0.0.1',
    port: 0,
    modules: ['index.js', ...moduleNames.filter((name) => name !== 'index.js')].map((name) => ({
      type: 'ESModule',
      path: path.join(buildRoot, name),
    })),
    modulesRoot: buildRoot,
    compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      APP_MODE: mode,
      CRM_TOKEN: fakeToken,
      CRON_SECRET: cronSecret,
      PROXY_KEY: 'test-only-proxy-key',
      ...(privateSite ? { SITES_SERVICE_TOKEN: 'test-only-service-token' } : {}),
      LIVE_BACKEND_URL: 'https://e2e-backend.chatgpt.site',
    },
    d1Databases: { DB: 'bellhaven-e2e' },
    d1Persist: persist,
    outboundService: upstream,
    // A local service binding avoids the native asset-worker socket issue on
    // Windows. Only allowlisted compiled/public files can be served; no path
    // concatenation or credentials/configuration are exposed to the browser.
    ...(assets ? { serviceBindings: { ASSETS: serveAsset } } : {}),
  };
  let mf = new Miniflare(options),
    db,
    closed = false,
    browserServer,
    browserUrl;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (browserServer) {
        const stopped = new Promise((resolve, reject) =>
          browserServer.close((error) => (error ? reject(error) : resolve()))
        );
        browserServer.closeAllConnections();
        await stopped;
      }
      await mf.dispose();
    } finally {
      const absolute = realpathSync(persist),
        parent = realpathSync(runtimeRoot);
      assert(
        path.dirname(absolute) === parent && path.basename(absolute).startsWith('e2e-'),
        'Refuse deletion outside the temporary E2E directory'
      );
      rmSync(absolute, { recursive: true, force: true });
    }
    assert.deepEqual(
      outboundViolations,
      [],
      'Mock boundary violations must fail the test even when the application catches the fetch error'
    );
  }
  try {
    db = await mf.getD1Database('DB');
    for (const file of readdirSync(path.join(root, 'drizzle'))
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = readFileSync(path.join(root, 'drizzle', file), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
    }
  } catch (error) {
    await close();
    throw error;
  }
  async function call(route, { body, headers = {}, cookie } = {}) {
    const response = await mf.dispatchFetch(origin + '/api/desk/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw Error(`Non-JSON response (${response.status}): ${text.slice(0, 250)}`);
    }
    return {
      status: response.status,
      value,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }
  async function reviewer() {
    const s = await call('session');
    assert.equal(s.status, 200);
    return { cookie: s.cookie, headers: { 'x-csrf-token': s.value.csrf } };
  }
  if (assets) {
    // Sites serves static assets before invoking the user Worker. Reproduce
    // that edge boundary here; the production Worker itself receives every
    // application/API request, without a test branch or modified bundle.
    browserServer = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, browserUrl);
        const file = assetFiles.get(url.pathname);
        if (file && ['GET', 'HEAD'].includes(request.method)) {
          response.writeHead(200, {
            'Content-Type': assetTypes[path.extname(file)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          response.end(request.method === 'HEAD' ? undefined : readFileSync(file));
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1048576) {
            response.writeHead(413);
            response.end();
            return;
          }
          chunks.push(chunk);
        }
        const result = await mf.dispatchFetch(url.href, {
          method: request.method,
          headers: request.headers,
          ...(!['GET', 'HEAD'].includes(request.method) ? { body: Buffer.concat(chunks) } : {}),
        });
        for (const [key, value] of result.headers)
          if (key !== 'set-cookie') response.setHeader(key, value);
        const cookies = result.headers.getSetCookie();
        if (cookies.length) response.setHeader('set-cookie', cookies);
        response.writeHead(result.status);
        response.end(
          request.method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer())
        );
      } catch {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Isolated browser harness request failed.' }));
      }
    });
    await new Promise((resolve, reject) => {
      browserServer.once('error', reject);
      browserServer.listen(0, '127.0.0.1', resolve);
    });
    browserUrl = new URL(`http://127.0.0.1:${browserServer.address().port}/`);
  }
  const pipeline = () =>
    call('pipeline', { body: {}, headers: { authorization: `Bearer ${cronSecret}` } });
  return {
    get db() {
      return db;
    },
    data,
    writes,
    requests,
    forwarded,
    call,
    reviewer,
    pipeline,
    close,
    dispatch: async (request) =>
      mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}),
      }),
    get url() {
      return browserUrl ? Promise.resolve(browserUrl) : mf.ready;
    },
    restart: async () => {
      await mf.dispose();
      mf = new Miniflare(options);
      await mf.ready;
      db = await mf.getD1Database('DB');
    },
    failLink: (v) => (failLink = v),
    loseCreateResponse: (v) => (loseCreateResponse = v),
    failSource: (v) => (failSource = v),
    proxyRedirect: (v) => (proxyRedirect = v),
  };
}

export async function setup(t, mode = 'live') {
  const harness = await createHarness({ mode });
  t.after(harness.close);
  return harness;
}
