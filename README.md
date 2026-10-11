# Bellhaven Review Desk

Facility reconciliation with evidence review and approval-based CRM updates. The pipeline reads the operator website and CRM, proposes corrections, and writes only after a reviewer approves the stored proposal.

Open the public [Bellhaven Review Desk](https://bellhaven-review-desk.swiftsandisp-8895.chatgpt.site) without signing in, or [run it locally](#run-locally) with server credentials supplied by the owner. Review actions affect the exercise CRM.

## Where to find each exercise requirement

The first three requirements are built into the app. The daily schedule is a separate workflow file that calls the same pipeline.

| Requirement | Where to go and what to do | Implementation |
| --- | --- | --- |
| **1. Scraper: every Bellhaven location** | Click **Refresh sources**, then **Review → Website locations**. See the entire saved collection with name, street address, city, state, ZIP, and every care offering. Search any of those fields. Each row includes its source and capture time. The collection includes homepage-only Findlay as well as all directory pages. | [Scraper and paginated CRM client](app/lib/sources.mjs); [locations view](app/app/locations.tsx) |
| **2. Matching and classification** | Open **Review → Proposed changes**. Use **Records → All website facilities** to include unchanged matches. Select a location to compare website evidence with CRM records; use **Change** to filter corrections, new accounts, duplicates, ambiguous matches, or website absence. **Website locations → Review match** opens that location's case directly. | [Matching rules](app/lib/core.mjs); [pipeline and decision handling](app/lib/engine.mjs) |
| **3. Review app and approved API updates** | Select a case in **Review → Proposed changes**, inspect the evidence and billing panel, then choose **Approve and apply** or enter a reason and **Reject proposal**. Approved writes are read back through the CRM API. Inspect saved outcomes in **Activity → Decisions**; inspect the resulting record in **CRM records**. Refreshing, matching, and rejection never write to the CRM. | [Review UI](app/app/page.tsx); [server API](app/lib/server.ts); [application and CHOW safeguards](app/lib/engine.mjs) |
| **4. Daily schedule and safe reruns** | Open [`.github/workflows/daily-reconciliation.yml`](.github/workflows/daily-reconciliation.yml). It includes a manual run and a commented daily cron. Configure the variables/secrets under **Hosting and scheduling** below before running it. In the app, **Refresh sources** runs the same pipeline; **Activity → Source refreshes** shows each result. Unchanged approved/rejected evidence is not re-proposed; material changes require fresh review. | [Workflow](.github/workflows/daily-reconciliation.yml); [durable ledger](app/lib/ledger.mjs); [rerun and recovery tests](app/tests/e2e/proxy-backend.test.mjs) |

To inspect the work without changing CRM data: browse **Website locations**, open a **Review match**, and inspect **Activity**. Approval is a real write to the exercise CRM, so use it only for a change you intend to apply. Automated tests exercise approval and recovery against an isolated CRM service.

## Run locally

Install Node.js 22.13 or newer (Node 24 recommended) and npm. Intel/AMD computers use x64 Node; Windows ARM uses x64 Node for the local Worker runtime. Install dependencies on each machine rather than copying `node_modules`. Windows ARM with x64 Node and Linux x64 are verified; macOS is untested.

```sh
cd app
npm ci
```

From the `app/` directory, copy `.env.example` to `.dev.vars`. Configure:

| Variable | Local value |
| --- | --- |
| `APP_MODE` | `proxy` |
| `LIVE_BACKEND_URL` | The deployed HTTPS Site origin |
| `PROXY_KEY` | The server-only proxy key supplied by the deployment owner |
| `SITES_SERVICE_TOKEN` | Leave unset for this public Site; only needed if hosting is later made private |

The local app shares the hosted decision ledger. Credentials are required for local live operations and must remain in the ignored configuration file. The hosted app needs no local installation.

From `app/`:

```sh
node scripts/local.mjs build
node scripts/local.mjs migrate
node scripts/local.mjs dev
```

Open `http://127.0.0.1:5173`. Select **Refresh sources**, inspect a case, and approve or reject it. Refreshing and matching do not write to the CRM. Approvals affect the actual exercise CRM. Keep the local server on loopback.

The helper tracks local migrations under `.sites-runtime/`; preserve it with `.wrangler/state`. On Windows ARM, `python scripts/bootstrap_node.py` from the repository root installs a checksum-verified local x64 runtime; `node scripts/local.mjs install` from `app/` then installs dependencies through that runtime.

## Review workflow

- **Review:** browse the scraper's full output in **Website locations**, or compare evidence and act in **Proposed changes**.
- **CRM records:** search accounts and contacts, inspect details, and stage a manual create or edit for approval.
- **Activity:** inspect decisions, source runs, operational counts, and the reconciliation method. Export the audit trail for source evidence, decisions, and verified results.

Every pipeline review starts with a short explanation of **why it appears**, the relevant **CRM record and matching evidence**, anything to **check**, and **what approval will do**. The explanation follows the selected resolution and field choices. Name, ZIP, parent, new-account, CHOW, duplicate, and missing-listing cases describe their own consequences. Related accounts and protected history appear together when they matter. Saved decisions explicitly label their original evidence; interrupted approvals explain how to resume the existing work.

Matching uses normalized address and locality, supported by names, phone numbers, and contacts. Street numbers and directions remain significant. Equivalent address spellings can produce explicit proposed corrections; matching itself never changes or reroutes a record. Legitimate billing PO boxes are preserved. Complete care offerings remain in evidence and notes alongside the supported single CRM category.

In **Compare the evidence**, the **CRM care category** selector lets you keep the current category or choose one of the website's supported categories. For example, Findlay offers Assisted Living or Memory Care (the CRM name for Memory Support). **Use website phone** is an optional checkbox. These controls belong to the selected correction and show exactly what will be included in **Approve and apply**; parent corrections and CHOW safeguards remain required. New accounts use a mapped website category when available; CHOW field selections affect only the replacement. When keeping current values is the only remaining action, **Save choice** records that decision without a CRM write.

The selected fields and deliberately retained values are saved in the decision history. Refreshes and daily runs do not repeat the same unchanged suggestion; material source changes require a fresh review. The complete website offering list stays in evidence and the approved account note even though the CRM has one category. Existing completed decisions stay closed when optional controls are introduced.

The pipeline searches facilities across every parent company, identifies the facility, then checks its affiliation. A shared parent or name alone is not a match: the Ohio Amberly Manor listing conflicts with the same-name Colorado account under Juniper Point. That unresolved identity requires judgment before creating an account or changing a parent. Strong contact evidence with a conflicting address, and inactive records at the same location, also require verification. One account cannot silently represent distinct website locations. The review shows conflicting existing records beside website evidence before approval.

| Case | Approved behavior |
| --- | --- |
| Field correction | Apply the displayed fields; retain prior observed names/addresses in notes |
| Parent correction | Re-parent the existing account if the CHOW condition is absent |
| CHOW | When lifetime revenue and outstanding AR are both positive, create the replacement and set only the old account's `chow_current_account` |
| Duplicate | Keep the reviewed survivor; mark the losing account `Inactive` and set `duplicate_of_account` |
| New location | Create a supported account under the resolved parent |
| Missing website listing | Set `Needs Review`; do not infer closure or a new owner |
| Ambiguous match | Verify the conflict, then choose a supported resolution and explain why: update the existing account, preserve billing history through CHOW, or create a separate facility. Missing or invalid billing values and broken history links remain blocked until repaired. |

Historical CHOW accounts are preserved. Contacts support matching; the pipeline does not migrate them. All nine documented CRM methods are supported: workspace identity, account/contact lists and details, creates, and updates. Manual edits are proposals until approved; no delete or merge endpoint is assumed.

Accounts with credit balances are protected from duplicate retirement just like accounts with revenue or unpaid AR. The CHOW condition remains strictly positive lifetime revenue **and** positive outstanding AR. Routine reconciliation preserves an existing **Needs Review** status, even if a previously absent facility returns to the website; use a separate reviewed status edit in **CRM records** after resolving the reason for that hold.

Duplicate proposals show **Accounts in this review** beside the resolution: every candidate's name, ID, parent, lifetime revenue, outstanding AR, linked active contacts, and selected action. Switching between duplicate cleanup and updating only one account changes those action labels immediately. An inactive copy names the exact survivor it will link to; retained copies explicitly say **Keep unchanged**. Contacts remain on their original accounts. Note-only and duplicate-only resolutions identify those actions explicitly; a selected care-category highlight applies to the single CRM category, while the complete website offering list remains source evidence.

For **Needs judgment** cases, **Choose a resolution** shows each available outcome directly. Amberly offers creating the Ohio facility separately or correcting the existing Juniper account after confirming its identity. Kettering offers a survivor with duplicate cleanup, or updating one account while retaining the other copies. Duplicate cases also offer that limited update. Each choice previews its exact CRM changes and billing treatment; add a reviewer note, then **Approve and apply**. **Leave CRM unchanged → Reject proposal** saves a no-change decision. Clear matches retain a straightforward approval path, and unchanged accounts need no approval. Missing billing data and broken history links cannot be bypassed by choosing a different route.

## Verification

The verification scripts also need Python 3.10 or newer. No live CRM credentials are needed for tests.

From `app/`:

```sh
npm test
npm run check
npm run lint
node scripts/local.mjs build
node scripts/local.mjs e2e
```

From the repository root:

```sh
python scripts/secret_scan.py
```

Tests cover source pagination, matching edge cases, billing preservation, stale evidence, competing approvals, interrupted operations, repeat runs, API validation, and credential redaction. The E2E suite runs compiled production Workers with local D1 and an isolated upstream service. It also exercises a local proxy Worker connected to a hosted-mode Worker. Test writes never reach the exercise CRM. The verification workflow repeats the checks on Linux x64 without live credentials.

Shared domain contracts cover CRM records, source evidence, proposal options, and operation checkpoints. The matching, API client, approval, manual-edit, and ledger modules use strict TypeScript checking through JSDoc. Runtime checks also validate external CRM responses, request bodies, and persisted operations before they are used; missing billing data is never treated as zero.

## Hosting and scheduling

The app uses Vinext, React, TypeScript, and Cloudflare D1. `app/.openai/hosting.json` declares the Site identity and D1 binding; `app/drizzle/` holds schema migrations. Preserve the Sites build integration when deploying. On the hosted service set `APP_MODE=live` and configure server-only secrets `CRM_TOKEN`, `PROXY_KEY`, and `CRON_SECRET`. Never place secrets in frontend variables, Git, logs, or URLs.

[The daily workflow](.github/workflows/daily-reconciliation.yml) includes manual dispatch and a commented, inactive schedule at 07:00 UTC. It calls the hosted proposal pipeline and never approves changes. Set repository variable `BELLHAVEN_SITE_URL` and secret `BELLHAVEN_CRON_SECRET` (the hosted `CRON_SECRET`). This public Site needs no Sites authentication token. The optional `BELLHAVEN_SITES_SERVICE_TOKEN` is only for hosting that is later made private. Scheduling remains inactive until explicitly enabled.

To demonstrate it, open **GitHub → Actions → Daily Bellhaven reconciliation → Run workflow** and choose `main`. After the run succeeds, open **Activity → Source refreshes** in the app. The workflow saves results directly to the hosted ledger; no code push or site redeployment is needed. The local app reads the same results. Run it again to verify that unchanged decided cases stay closed. To enable daily runs later, uncomment the workflow's `schedule` and `cron` lines.

Each GitHub run summary separates **New proposals this run** from **Open proposals after refresh** and links to the review desk. New means newly added actionable evidence, including new locations or material website/CRM changes. Open is the total queue at completion, including existing proposals, manual drafts, stale cases, and interrupted work; applied, rejected, unchanged, and superseded cases are excluded. A repeat run can correctly show **0 new** and **35 open**. The same saved count appears in **Activity → Source refreshes**; older runs without this metric omit it. Later decisions change the current queue, not a past run's snapshot.

Results appear automatically within about 30 seconds while the app is open, or when you return to its tab. If the case you are reviewing changed, choose **Load latest** before deciding; your review note is preserved.

An in-progress refresh shows a collection message until its counts are ready. Failed refreshes remain visible without replacing the last complete snapshot. A retired or historical Bellhaven parent blocks new proposals and approvals until its CRM record is resolved.

## Recovery and boundaries

Requests have bounded waits and readable connection errors. Use **Retry connection** if the review session cannot open, **Retry saved results** if the ledger cannot be loaded, or **Try again** in an unavailable Operations report. An interrupted approval may still finish on the server; decisions remain disabled until saved results can be checked. The browser never automatically retries a CRM write. Refreshing sources preserves your draft choices and note when the evidence is unchanged; changed evidence requires **Load latest**.

The public Site requests no crawling or indexing: `/robots.txt` disallows every crawler, HTML includes `noindex, nofollow, noarchive`, and application responses include an `X-Robots-Tag` header. These directives rely on crawler compliance and do not restrict human access. A crawler blocked by robots.txt may never read the noindex directive, so externally linked or previously indexed URLs can still appear in search results; existing listings may require removal through the search engine. Static assets are served by the hosting edge; application headers cover the Worker routes, including API responses. See [Google's crawler guidance](https://developers.google.com/search/docs/crawling-indexing/robots/intro).

Rejections persist across restarts and repeat runs. Reopening requires a reason and preserves the earlier decision. Applied changes have no universal undo: ordinary fields can receive a new reviewed correction, while CHOW and duplicate relationships need case-specific recovery. The API cannot delete created accounts.

Approvals re-read source evidence and affected records. Changed evidence blocks the old proposal. Interrupted work reserves its records across manual and pipeline flows; **Resume approved operation** uses the saved approval and checkpoints. An uncertain account creation is reconciled by its operation marker, never blindly retried. Contact creation without an acknowledged ID requires investigation.

The global lock does not expire automatically. After a worker failure, restrict access, verify the old worker has stopped, read CRM/checkpoint state, back up the affected ledger, and record the recovery before releasing only the inspected lock owner. Never erase operation intent to force a new creation. The sanitized audit export is evidence, not a complete database backup.

Public review deliberately uses anonymous attribution for the fictional CRM. Organizational deployment requires authenticated reviewer permissions, alert ownership, and tested backups/retention. The upstream API lacks conditional updates and creation-idempotency keys, so an external writer can still race an app read/write. Runtime dependency auditing is enforced in CI; development/build dependencies require separate review. The website supports affiliation evidence, not legal ownership or acquisition dates.
