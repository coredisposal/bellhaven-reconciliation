import { env } from 'cloudflare:workers';
import { Ledger } from './ledger.mjs';
import { crmClient, snapshot, API_CATALOG } from './sources.mjs';
import { runPipeline, decide } from './engine.mjs';
import { operationalReport } from './reporting.mjs';
import { exportEvidence, sanitize } from './export.mjs';
import { stageManual, decideManual } from './manual.mjs';
import { reviewState } from './state.mjs';
import { parseRequestObject } from './request.mjs';
import { isRecord } from './contracts.mjs';
import type { DecisionInput } from './execution-types';

const settings = () => env as unknown as Record<string, string | D1Database>;
function config(key: string) {
  const value = settings()[key];
  return typeof value === 'string' ? value : (process.env[key] ?? '');
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
const credentialValues = () =>
  ['CRM_TOKEN', 'PROXY_KEY', 'CRON_SECRET', 'SITES_SERVICE_TOKEN'].map(config);
// Every operational response can contain upstream or reviewer text. Apply the
// same redaction boundary to records, drafts and reports as to state/exports.
// Session bootstrap remains separate because it must return the CSRF token.
const publicJson = (data: unknown, status = 200) =>
  json(sanitize(data, credentialValues()), status);
function ledger() {
  if (!env.DB) throw new Error('D1 is unavailable. Apply the documented local migrations.');
  return new Ledger(env.DB);
}
async function context() {
  if (!config('CRM_TOKEN'))
    throw new Error('Configure the server CRM token before refreshing or reviewing the exercise.');
  const client = crmClient(config('CRM_TOKEN'));
  return { client, getSnapshot: () => snapshot(client) };
}
function cookie(request: Request) {
  return request.headers.get('cookie')?.match(/(?:^|; )bh_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
}
interface SessionRow { id: string; csrf: string; created: string }
async function session(db: Ledger, request: Request, create: true): Promise<SessionRow>;
async function session(db: Ledger, request: Request, create?: false): Promise<SessionRow | null>;
async function session(db: Ledger, request: Request, create = false) {
  const id = cookie(request);
  let s = id ? await db.one<SessionRow>('SELECT * FROM sessions WHERE id=?', id) : null;
  if (s && Date.now() - Date.parse(s.created) > 86400000) s = null;
  if (!s && create) {
    s = { id: crypto.randomUUID(), csrf: crypto.randomUUID(), created: new Date().toISOString() };
    await db.run('INSERT INTO sessions(id,csrf,created) VALUES(?,?,?)', s.id, s.csrf, s.created);
  }
  return s;
}
async function secure(db: Ledger, request: Request) {
  const host = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin !== host.origin) throw new Error('Same-origin request required. Refresh this page.');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none')
    throw new Error('Cross-site decision requests are refused.');
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new Error('JSON request required.');
  const s = await session(db, request);
  if (!s || request.headers.get('x-csrf-token') !== s.csrf)
    throw new Error('Review session expired. Refresh the page.');
  const r = await db.run(
    'UPDATE sessions SET last_request=? WHERE id=? AND last_request<?',
    Date.now(),
    s.id,
    Date.now() - 1000
  );
  if (!r.meta.changes) throw new Error('Please wait a moment before the next request.');
  // Public reviewers are deliberately anonymous. A caller-supplied identity
  // header is not verified authentication and must not become an audit claim.
  return { session: s.id, actor: 'anonymous' };
}
async function readBody(request: Request) {
  if (Number(request.headers.get('content-length')) > 8192)
    throw new Error('Request exceeds 8 KB.');
  const reader = request.body?.getReader();
  let bytes = 0;
  const chunks = [];
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 8192) {
        await reader.cancel();
        throw new Error('Request exceeds 8 KB.');
      }
      chunks.push(value);
    }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return parseRequestObject(new TextDecoder().decode(buffer));
}
async function proxy(path: string, body?: Record<string,unknown>, identity?: { session: string; actor: string }) {
  const url = new URL(config('LIVE_BACKEND_URL'));
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.chatgpt.site'))
    throw new Error('Live proxy must target the deployed HTTPS Sites backend.');
  const key = config('PROXY_KEY');
  if (!key) throw new Error('Configure the same PROXY_KEY on the local and hosted servers.');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Bellhaven-Proxy': key,
  };
  if (config('SITES_SERVICE_TOKEN'))
    headers['OAI-Sites-Authorization'] = 'Bearer ' + config('SITES_SERVICE_TOKEN');
  // Workerd supports manual/follow, but not redirect:error. Handle 3xx here
  // before reading the body so proxy/service credentials never follow a hop.
  const response = await fetch(new URL('/api/desk/' + path, url), {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify({ ...body, proxyIdentity: identity }) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(180000),
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error('Live backend redirect refused. Check the configured Site origin.');
  return publicJson(await response.json(), response.status);
}
export async function handler(request: Request, path: string) {
  try {
    const db = ledger(),
      mode = config('APP_MODE') || 'live';
    if (!['live', 'proxy'].includes(mode))
      throw new Error(
        'Configure APP_MODE=proxy for local review or APP_MODE=live for the hosted exercise. Test mode is not available in the app.'
      );
    if (request.method === 'GET' && path === 'session') {
      const s = await session(db, request, true);
      const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
      return json({ csrf: s.csrf, mode }, 200, {
        'Set-Cookie': `bh_session=${s.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`,
      });
    }
    if (request.method === 'GET') {
      if (mode === 'proxy') return await proxy(path + new URL(request.url).search);
      if (path === 'report') return publicJson(await operationalReport(env.DB));
      if (path === 'api-catalog') return publicJson(API_CATALOG);
      if (path === 'crm') {
        const { client } = await context(),
          params = new URL(request.url).searchParams;
        const entity = params.get('entity'),
          id = params.get('id');
        if (entity === 'me') return publicJson(await client.me());
        if (!['accounts', 'contacts'].includes(entity ?? ''))
          throw new Error('Choose accounts or contacts.');
        const filters = Object.fromEntries(
          [...params]
            .filter(([k]) => !['entity', 'id'].includes(k))
            .map(([k, v]) => [k, ['page', 'page_size'].includes(k) ? Number(v) : v])
        );
        const data = id
          ? entity === 'accounts'
            ? await client.get(id)
            : await client.getContact(id)
          : entity === 'accounts'
            ? await client.listAccounts(filters)
            : await client.listContacts(filters);
        return publicJson(data);
      }
      if (path === 'state') {
        return json(
          await reviewState(
            db,
            mode,
            ['CRM_TOKEN', 'PROXY_KEY', 'CRON_SECRET', 'SITES_SERVICE_TOKEN'].map(config)
          )
        );
      }
      if (path === 'export')
        return json(
          await exportEvidence(
            env.DB,
            mode,
            ['CRM_TOKEN', 'PROXY_KEY', 'CRON_SECRET', 'SITES_SERVICE_TOKEN'].map(config)
          )
        );
      return json({ error: 'Not found' }, 404);
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await readBody(request);
    const proxyKey = config('PROXY_KEY'),
      cronKey = config('CRON_SECRET');
    const trustedProxy = proxyKey && request.headers.get('x-bellhaven-proxy') === proxyKey;
    const trustedCron =
      path === 'pipeline' &&
      cronKey &&
      request.headers.get('authorization') === `Bearer ${cronKey}`;
    let identity;
    if (trustedProxy) {
      const s = isRecord(body.proxyIdentity) ? body.proxyIdentity.session : undefined;
      identity = {
        session: typeof s === 'string' ? s.slice(0, 64) : 'local-proxy',
        actor: 'anonymous (local proxy)',
      };
    } else if (trustedCron) identity = { session: 'scheduled', actor: 'scheduled pipeline' };
    else identity = await secure(db, request);
    if (mode === 'proxy') return await proxy(path, body, identity);
    const { client, getSnapshot } = await context();
    if (path === 'draft') {
      const draft = Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== 'proxyIdentity')
      );
      return publicJson(await stageManual(db, client, draft, identity));
    }
    if (path === 'pipeline') return publicJson(await runPipeline(db, getSnapshot));
    if (path === 'decision') {
      const keys = ['id', 'version', 'action', 'optionId', 'note', 'proxyIdentity'];
      if (Object.keys(body).some((k) => !keys.includes(k)))
        throw new Error(
          'Only a stored proposal decision is accepted. Arbitrary CRM fields are refused.'
        );
      if (
        typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.id) ||
        body.version !== body.id ||
        (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) ||
        (body.optionId !== undefined && (typeof body.optionId !== 'string' || body.optionId.length > 512)) ||
        (body.action !== 'approve' && body.action !== 'reject' && body.action !== 'resume' && body.action !== 'reopen')
      )
        throw new Error('Invalid proposal decision.');
      const decision: DecisionInput = { id: body.id, version: body.version, action: body.action,
        ...(typeof body.optionId === 'string' ? { optionId: body.optionId } : {}),
        ...(typeof body.note === 'string' ? { note: body.note } : {}) };
      const stored = await db.one<{data:string}>('SELECT data FROM proposals WHERE id=?', body.id);
      const proposal: unknown = stored ? JSON.parse(stored.data) : null;
      if (isRecord(proposal) && proposal.manual === true)
        return publicJson(await decideManual(db, client, decision, identity));
      return publicJson(await decide(db, client, getSnapshot, decision, identity));
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    // Never return upstream bodies, credentials, request headers or token-bearing links.
    let message = error instanceof Error ? error.message : 'Request failed';
    for (const key of ['CRM_TOKEN', 'PROXY_KEY', 'CRON_SECRET', 'SITES_SERVICE_TOKEN']) {
      const value = config(key);
      if (value) message = message.replaceAll(value, '[redacted]');
    }
    return json({ error: message.slice(0, 500) }, 409);
  }
}
