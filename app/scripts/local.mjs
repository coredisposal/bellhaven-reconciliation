/** Portable helper, including this Windows ARM machine's verified x64 runtime. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const embedded = path.join(root, '.sites-runtime/node-v22.13.1-win-x64/node.exe');
const node = process.platform === 'win32' && existsSync(embedded) ? embedded : process.execPath;
const env = { ...process.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH };
const command = process.argv[2] ?? 'dev';
function run(args) {
  const r = spawnSync(node, args, { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (command === 'migrate') {
  const record = path.join(root, '.sites-runtime/local-migrations.json');
  let applied = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : [];
  for (const file of readdirSync(path.join(root, 'drizzle'))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (applied.includes(file)) continue;
    run([
      '--import',
      './scripts/sites-env.mjs',
      './node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'DB',
      '--local',
      '--config',
      'dist/server/wrangler.json',
      '--persist-to',
      '.wrangler/state',
      '--file',
      'drizzle/' + file,
    ]);
    applied.push(file);
    writeFileSync(record, JSON.stringify(applied));
  }
} else if (command === 'dev' || command === 'build')
  run([
    'scripts/run-framework.mjs',
    command,
    ...(command === 'dev' ? ['--hostname', '127.0.0.1'] : []),
  ]);
else if (command === 'e2e')
  run([
    '--import',
    './scripts/sites-env.mjs',
    '--test',
    ...readdirSync(path.join(root, 'tests/e2e'))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => 'tests/e2e/' + f),
  ]);
else if (command === 'install') {
  const npm = path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js');
  if (!existsSync(npm)) throw Error('Use npm ci on this system.');
  run([npm, 'run', 'install:ci']);
} else if (command === 'test')
  run([
    '--experimental-sqlite',
    '--test',
    ...readdirSync(path.join(root, 'tests'))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => 'tests/' + f),
  ]);
else throw Error('Usage: node scripts/local.mjs install|build|migrate|dev|test|e2e');
