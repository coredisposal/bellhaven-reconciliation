import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../lib/client-request.mjs';

test('browser requests return JSON and surface a useful server error without exposing invalid responses', async (t) => {
  let calls = 0;
  const replies = [
    Response.json({ total: 20 }),
    Response.json({ error: 'The case changed. Refresh its evidence.' }, { status: 409 }),
    new Response('<html>Unavailable</html>', { status: 503 }),
    Response.json({ error: { internal: 'details' } }, { status: 500 }),
    new Response('not JSON'),
  ];
  t.mock.method(globalThis, 'fetch', async () => { calls++; return replies.shift(); });
  assert.deepEqual(await requestJson('/read'), { total: 20 });
  await assert.rejects(requestJson('/decision'), /The case changed\. Refresh its evidence\./);
  for (let i = 0; i < 3; i++)
    await assert.rejects(requestJson('/read', { errorMessage: 'CRM unavailable.' }), /^Error: CRM unavailable\.$/);
  assert.equal(calls, 5, 'Failed requests never retry automatically');
});

test('browser request timeouts cover stalled response bodies and never retry mutations', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    assert.equal(options.method, 'POST');
    return {
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }),
    };
  });
  await assert.rejects(requestJson('/draft', {
    method: 'POST', timeoutMs: 10,
    timeoutMessage: 'The response was interrupted. Check the review queue before saving again.',
  }), /Check the review queue before saving again/);
  assert.equal(calls, 1);
});

test('caller cancellation remains distinct from a timeout and fetch options reach the request', async (t) => {
  const controller = new AbortController();
  let seen;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    seen = options;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Unmounted', 'AbortError')), { once: true });
    });
  });
  const result = requestJson('/read', { signal: controller.signal, headers: { Accept: 'application/json' } });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError', message: 'Unmounted' });
  assert.deepEqual(seen.headers, { Accept: 'application/json' });
  assert.equal(seen.signal.aborted, true);
});
