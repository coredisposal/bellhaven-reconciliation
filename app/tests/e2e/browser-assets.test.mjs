import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

test('browser delivery: compiled HTML, client JS/CSS and real Worker APIs share one isolated origin', async (t) => {
  const harness = await createHarness({ assets: true });
  t.after(harness.close);
  const origin = await harness.url;
  assert.equal(origin.hostname, '127.0.0.1');
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Bellhaven/);
  const assets = [
    ...new Set(
      [...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)].map((match) => match[1])
    ),
  ];
  assert(assets.length > 1, 'SSR must reference the real built JS and stylesheet');
  for (const asset of assets) {
    const response = await fetch(new URL(asset, origin));
    assert.equal(response.status, 200, asset);
    assert.match(
      response.headers.get('content-type') ?? '',
      asset.endsWith('.css') ? /^text\/css/ : /^text\/javascript/
    );
    assert((await response.text()).length > 0);
  }
  const state = await fetch(new URL('/api/desk/state', origin));
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).proposals, []);
  for (const privatePath of ['/.dev.vars', '/wrangler.json', '/.vite/manifest.json']) {
    const response = await fetch(new URL(privatePath, origin));
    assert.equal(response.status, 404, privatePath);
    await response.arrayBuffer();
  }
  assert.equal(harness.writes.length, 0);
});
