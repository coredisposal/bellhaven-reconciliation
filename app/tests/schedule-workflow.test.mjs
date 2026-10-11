import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(new URL('../../.github/workflows/daily-reconciliation.yml', import.meta.url), 'utf8');
const script = workflow.split(/        run: \|\r?\n/)[1]
  ?.split(/\r?\n/).map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
assert(script, 'The scheduled HTTP step must remain executable in this regression test');
const valid = {
  id: 'run-verified', accounts: 121, contacts: 67, facilities: 35, new_proposals: 0, open_proposals: 35,
  coverage: { complete: true },
};
const env = {
  BELLHAVEN_SITE_URL: 'https://test-backend.chatgpt.site',
  BELLHAVEN_CRON_SECRET: 'synthetic-cron-secret',
  BELLHAVEN_SITES_SERVICE_TOKEN: 'synthetic-service-secret',
};
const python = (process.platform === 'win32'
  ? [['python', []], ['py', ['-3']], ['python3', []]]
  : [['python3', []], ['python', []]])
  .find(([command, args]) => {
    const probe = spawnSync(command, [...args, '-c', 'import sys; print(sys.version_info.major)'], {
      encoding: 'utf8', timeout: 3000,
    });
    return probe.status === 0 && probe.stdout.trim() === '3';
  });
function execute(options = {}) {
  assert(python,
    'Python 3 is required to test the scheduled workflow. Install Python 3 and expose python3, python, or py -3 on PATH; the app itself does not require Python.');
  const result = spawnSync(python[0], [...python[1],
    fileURLToPath(new URL('./helpers/workflow-runner.py', import.meta.url)),
  ], {
    input: JSON.stringify({ script, env, response: JSON.stringify(valid), ...options }),
    encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('schedule workflow executes its actual HTTP step with private Site auth and aggregate-only output', () => {
  const result = execute();
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 1);
  const request = result.calls[0];
  assert.equal(request.url, env.BELLHAVEN_SITE_URL + '/api/desk/pipeline');
  assert.equal(request.method, 'POST');
  assert.equal(request.body, '{}');
  assert.equal(request.timeout, 180);
  assert.equal(request.headers.Authorization, 'Bearer synthetic-cron-secret');
  assert.equal(request.headers['User-agent'], 'BellhavenReviewDesk/1.0');
  assert.equal(request.headers['Oai-sites-authorization'], 'Bearer synthetic-service-secret');
  assert.match(result.output, /Completed proposal refresh/);
  assert.match(result.summary, /CRM changes require separate reviewer approval/);
  assert.match(result.output, /New proposals this run: 0, Open proposals after refresh: 35/);
  assert.match(result.summary, /\| New proposals this run \| 0 \|/);
  assert.match(result.summary, /\| Open proposals after refresh \| 35 \|/);
  assert(result.summary.includes(`[Open the review desk](${env.BELLHAVEN_SITE_URL})`));
  for (const secret of [env.BELLHAVEN_CRON_SECRET, env.BELLHAVEN_SITES_SERVICE_TOKEN]) {
    assert(!result.output.includes(secret));
    assert(!result.summary.includes(secret));
  }
  const publicSite = execute({ env: { ...env, BELLHAVEN_SITES_SERVICE_TOKEN: '' } });
  assert.equal(publicSite.code, 0);
  assert(!Object.hasOwn(publicSite.calls[0].headers, 'Oai-sites-authorization'));
});

test('schedule workflow refuses malformed/incomplete replies and never reports an unverified refresh as successful', () => {
  for (const response of [
    'not JSON', '[]', '{}',
    JSON.stringify({ ...valid, coverage: { complete: false } }),
    JSON.stringify({ ...valid, facilities: -1 }),
    JSON.stringify({ ...valid, new_proposals: true }),
    JSON.stringify({ ...valid, open_proposals: undefined }),
    JSON.stringify({ ...valid, open_proposals: -1 }),
    JSON.stringify({ ...valid, open_proposals: true }),
    JSON.stringify({ ...valid, open_proposals: '35' }),
    JSON.stringify({ ...valid, id: '' }),
    'x'.repeat(65538),
  ]) {
    const result = execute({ response });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.match(result.output, /::error::/);
    assert(!result.output.includes('Completed proposal refresh'));
    assert.equal(result.summary, '');
  }
});

test('schedule workflow does not retry redirects, HTTP errors or uncertain timeouts and keeps diagnostics private', () => {
  for (const scenario of ['redirect', 'http', 'timeout']) {
    const result = execute({ scenario });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert(!result.output.includes('Private'));
    assert.match(result.output, /Inspect/);
    assert.equal(result.summary, '');
  }
});

test('schedule workflow rejects unsafe origins or missing configuration before any HTTP request', () => {
  for (const site of [
    'http://test-backend.chatgpt.site', 'https://untrusted.invalid',
    'https://test-backend.chatgpt.site/extra', 'https://test-backend.chatgpt.site?secret=value',
    'https://user:password@test-backend.chatgpt.site', 'https://test-backend.chatgpt.site:8443',
  ]) {
    const result = execute({ env: { ...env, BELLHAVEN_SITE_URL: site } });
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
  }
  const missing = execute({ env: { ...env, BELLHAVEN_CRON_SECRET: '' } });
  assert.equal(missing.code, 1);
  assert.equal(missing.calls.length, 0);
});
