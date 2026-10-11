import { createHarness } from './harness.mjs';

// Run only for browser QA. The app's production Worker and client assets are
// unchanged; synthetic upstream responses and a new temporary D1 live here.
const harness = await createHarness({
  assets: true,
  onWrite: ({ method, entity, id, fields }) =>
    console.log(
      'ISOLATED TEST WRITE',
      method,
      entity,
      id ?? '(new record)',
      Object.keys(fields).join(', ')
    ),
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  let exitCode = 0;
  try {
    const { value } = await harness.call('state');
    console.log(
      'ISOLATED TEST RESULTS',
      JSON.stringify({
        decisions: value.decisions?.map((d) => ({ action: d.action, proposal_id: d.proposal_id })),
        attempted_mock_writes: harness.writes.length,
        applied: value.proposals?.filter((p) => p.status === 'applied').map((p) => p.title),
        rejected: value.proposals?.filter((p) => p.status === 'rejected').map((p) => p.title),
      })
    );
  } catch (error) {
    console.error(error.message);
    exitCode = 1;
  } finally {
    try {
      await harness.close();
      console.log('Temporary test database removed.');
    } catch (error) {
      console.error(error.message);
      exitCode = 1;
    }
    process.exit(exitCode);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (value) => {
  if (value.trim() === 'quit') void shutdown();
});
try {
  const result = await harness.pipeline();
  if (result.status !== 200) throw new Error(result.value.error ?? 'Test pipeline failed');
  console.log('ISOLATED BROWSER QA — synthetic CRM only; no exercise credentials or live network.');
  console.log('BROWSER_URL=' + (await harness.url).href);
  console.log(
    `Seeded ${result.value.facilities} facilities. Type quit to print results and remove the temporary database (or Ctrl+C).`
  );
} catch (error) {
  await harness.close();
  console.error(error.message);
  process.exit(1);
}
