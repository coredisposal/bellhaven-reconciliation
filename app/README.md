# Bellhaven Review Desk application

Vinext, React, TypeScript, and Cloudflare D1. The [repository README](https://github.com/coredisposal/bellhaven-reconciliation#readme) explains the four exercise requirements, setup, review workflow, scheduling, and recovery.

## Local startup

Use Node.js 22.13 or newer and npm. Install dependencies on each machine; do not copy `node_modules` between architectures. Windows ARM uses x64 Node for the local Worker runtime.

From this directory:

```sh
npm ci
```

Copy `.env.example` to `.dev.vars`. Set `APP_MODE=proxy`, the deployed `LIVE_BACKEND_URL`, and the owner's server-only `PROXY_KEY`. Leave `SITES_SERVICE_TOKEN` unset for this public Site.

```sh
node scripts/local.mjs build
node scripts/local.mjs migrate
node scripts/local.mjs dev
```

Open `http://127.0.0.1:5173`. **Review → Website locations** shows the full saved scrape. **Review → Proposed changes** opens the approval queue. Local review shares the hosted ledger and actual exercise CRM. Refreshing only reads sources; approving a proposal writes its displayed changes.

## Maintenance

With Python 3.10 or newer also installed, run `npm test`, `npm run check`, `npm run lint`, then build and run `node scripts/local.mjs e2e`. Tests use isolated upstream data and never load live credentials.

`db/schema.ts` defines the ledger; `drizzle/` contains migrations. Preserve the local migration record under `.sites-runtime/` with `.wrangler/state`. `.openai/hosting.json` declares the existing Site and D1 binding. Keep the Sites build integration and license in `build/`.

The hosted service uses `APP_MODE=live` and server-only CRM/pipeline/proxy secrets. Exclude `.dev.vars`, build output, installed dependencies, and runtime state from Git. For environments that restrict native file watching, set `CHOKIDAR_USEPOLLING=true` before starting development.
