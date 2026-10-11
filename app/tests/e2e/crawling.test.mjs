import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

const directives = 'noindex, nofollow, noarchive';

test('public crawler controls: HTML, robots, APIs and errors discourage indexing without restricting reviewers', async (t) => {
  const harness = await createHarness({ assets: true });
  t.after(harness.close);
  const origin = await harness.url;

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), directives);
  const html = await page.text();
  assert.match(html, /<meta\s+name="robots"\s+content="noindex, nofollow, noarchive"\s*\/?\s*>/);
  assert.match(html, /Bellhaven/);

  for (const method of ['GET', 'HEAD']) {
    const robots = await fetch(new URL('/robots.txt', origin), { method });
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/);
    assert.equal(robots.headers.get('x-robots-tag'), directives);
    assert.equal(await robots.text(), method === 'GET' ? 'User-agent: *\nDisallow: /\n' : '');
  }

  const state = await fetch(new URL('/api/desk/state', origin));
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('x-robots-tag'), directives);
  assert.deepEqual((await state.json()).proposals, []);

  for (const route of ['/missing-page', '/api/desk/missing-action']) {
    const missing = await fetch(new URL(route, origin));
    assert.equal(missing.status, 404, route);
    assert.equal(missing.headers.get('x-robots-tag'), directives, route);
    await missing.arrayBuffer();
  }
  assert.equal(harness.writes.length, 0);
});

test('indexing headers preserve reviewer sessions, CSRF errors and read-only refresh access', async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const session = await harness.dispatch(new Request('http://desk.test/api/desk/session'));
  assert.equal(session.status, 200);
  assert.equal(session.headers.get('x-robots-tag'), directives);
  const cookie = session.headers.get('set-cookie');
  assert(cookie?.includes('HttpOnly'));
  assert((await session.json()).csrf);

  const denied = await harness.dispatch(new Request('http://desk.test/api/desk/pipeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://desk.test' },
    body: '{}',
  }));
  assert.equal(denied.status, 409);
  assert.equal(denied.headers.get('x-robots-tag'), directives);
  assert((await denied.json()).error);

  const run = await harness.call('pipeline', { ...(await harness.reviewer()), body: {} });
  assert.equal(run.status, 200);
  assert.equal(harness.writes.length, 0);
});
