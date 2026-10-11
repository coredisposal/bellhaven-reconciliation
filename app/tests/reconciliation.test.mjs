import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { reconcile, streetKey, needsChow, businessAccount } from '../lib/core.mjs';
import { crawl, paginate } from '../lib/sources.mjs';
import { Ledger } from '../lib/ledger.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';
import { decide, runPipeline } from '../lib/engine.mjs';
import { operationalReport } from '../lib/reporting.mjs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };

const copy = (x) => structuredClone(x);
function database() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) =>
    f.endsWith('.sql')
  ))
    db.exec(readFileSync(new URL('../drizzle/' + f, import.meta.url), 'utf8'));
  return { db, ledger: new Ledger(sqliteD1(db)) };
}
function setup() {
  const { db, ledger } = database();
  const data = copy(baseline);
  let creates = 0,
    patches = 0,
    failLink = false,
    failDuplicate = false,
    timeoutCreate = false,
    dropCreate = false;
  const client = {
    accounts: async () => copy(data.accounts),
    contacts: async () => copy(data.contacts),
    get: async (id) => copy(data.accounts.find((a) => a.account_id === id)),
    patch: async (id, fields) => {
      patches++;
      if (
        (failLink && fields.chow_current_account) ||
        (failDuplicate && fields.duplicate_of_account)
      )
        throw Error('timeout');
      Object.assign(
        data.accounts.find((a) => a.account_id === id),
        fields
      );
      return copy(data.accounts.find((a) => a.account_id === id));
    },
    create: async (fields) => {
      creates++;
      if (dropCreate) throw Error('timeout');
      const a = {
        ...fields,
        account_id: 'created-' + creates,
        chow_current_account: '',
        duplicate_of_account: '',
        parent_name: 'Bellhaven Senior Living (Parent Account)',
      };
      data.accounts.push(a);
      if (timeoutCreate) throw Error('lost response');
      return copy(a);
    },
  };
  return {
    db,
    ledger,
    data,
    client,
    getSnapshot: async () => copy(data),
    counts: () => ({ creates, patches }),
    failLink: (v) => (failLink = v),
    failDuplicate: (v) => (failDuplicate = v),
    timeoutCreate: (v) => (timeoutCreate = v),
    dropCreate: (v) => (dropCreate = v),
  };
}
const identity = { actor: 'test reviewer', session: 'test-session' };
async function proposal(s, title) {
  await runPipeline(s.ledger, s.getSnapshot);
  return (await reconcile(s.data)).find((p) => p.title.includes(title));
}
const input = (p, action = 'approve', note = 'Evidence reviewed') => ({
  id: p.id,
  version: p.version,
  action,
  optionId: p.options[0]?.id,
  note,
});

test('persisted approval data with an invalid operation is refused before recording approval or writing', async () => {
  const s = setup();
  try {
    const p = await proposal(s, 'Tiffin');
    const row = s.db.prepare('SELECT data FROM proposals WHERE id=?').get(p.id);
    const stored = JSON.parse(row.data);
    stored.options[0].operations[0].before.account_id = 'different-account';
    s.db.prepare('UPDATE proposals SET data=? WHERE id=?').run(JSON.stringify(stored), p.id);
    await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), /Stored proposal is invalid/);
    assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS total FROM decisions').get().total, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS total FROM locks').get().total, 0);
  } finally { s.db.close(); }
});

test('valid-shaped stored operation changes cannot reuse the original proposal version', async () => {
  const s = setup();
  try {
    const p = await proposal(s, 'Portsmouth');
    const stored = copy(p);
    stored.options[0].operations[0].fields.phone = '555-777-9999';
    await s.ledger.run('UPDATE proposals SET data=? WHERE id=?', JSON.stringify(stored), p.id);
    await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), /Evidence changed/);
    assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS total FROM decisions').get().total, 0);
    assert.equal(s.db.prepare('SELECT status FROM proposals WHERE id=?').get(p.id).status, 'stale');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS total FROM locks').get().total, 0);
  } finally { s.db.close(); }
});

test('an interrupted patch cannot resume with changed fields under its original approval', async () => {
  const s = setup();
  try {
    const p = await proposal(s, 'Portsmouth');
    const patch = s.client.patch;
    s.client.patch = async () => { throw new Error('Injected patch timeout'); };
    await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), /Patch not verified/);
    const stored = copy(p);
    stored.options[0].operations[0].fields.phone = '555-777-9999';
    await s.ledger.run('UPDATE proposals SET data=? WHERE id=?', JSON.stringify(stored), p.id);
    s.client.patch = patch;
    await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity), /Decision evidence changed/);
    assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS total FROM decisions').get().total, 1);
    assert.equal(s.db.prepare('SELECT status FROM proposals WHERE id=?').get(p.id).status, 'partial');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS total FROM locks').get().total, 0);
  } finally { s.db.close(); }
});

test('an explicitly reopened unchanged rejection remains approvable after operation integrity checks', async () => {
  const s = setup();
  try {
    const p = await proposal(s, 'Portsmouth');
    await decide(s.ledger, s.client, s.getSnapshot, input(p, 'reject', 'Confirm the current name first'), identity);
    await decide(s.ledger, s.client, s.getSnapshot, input(p, 'reopen', 'Current source independently confirmed'), identity);
    await decide(s.ledger, s.client, s.getSnapshot, input(p), identity);
    assert.deepEqual(s.counts(), { creates: 0, patches: 1 });
    assert.equal(s.db.prepare('SELECT status FROM proposals WHERE id=?').get(p.id).status, 'applied');
  } finally { s.db.close(); }
});

test('operation integrity compares business fields without treating retrieval timestamps as changed approval', async () => {
  const s = setup();
  try {
    const p = await proposal(s, 'Portsmouth');
    const account = s.data.accounts.find((value) => value.account_id === p.options[0].operations[0].account_id);
    account.updated_at = '2030-01-01T00:00:00Z';
    await decide(s.ledger, s.client, s.getSnapshot, input(p), identity);
    assert.deepEqual(s.counts(), { creates: 0, patches: 1 });
  } finally { s.db.close(); }
});

test('a malformed persisted CHOW checkpoint refuses resume without losing the existing replacement', async () => {
  const s = setup();
  try {
    const p = await proposal(s, 'Tiffin');
    s.failLink(true);
    await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), /CHOW link not verified/);
    const before = copy(s.data.accounts), counts = s.counts();
    const row = s.db.prepare('SELECT id,data FROM operations WHERE proposal_id=?').get(p.id);
    const stored = JSON.parse(row.data);
    stored.replacement = { account_id: stored.replacement };
    s.db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(stored), row.id);
    s.failLink(false);
    await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity), /Stored operation checkpoint is invalid/);
    assert.deepEqual(s.counts(), counts);
    assert.deepEqual(s.data.accounts, before);
    assert.equal(s.db.prepare('SELECT status FROM proposals WHERE id=?').get(p.id).status, 'partial');
  } finally { s.db.close(); }
});

test('an ID-only create acknowledgement is verified with a complete account readback', async () => {
  const s = setup();
  try {
    const p = await proposal(s, 'Tiffin');
    const create = s.client.create;
    s.client.create = async (fields) => ({ data: { account_id: (await create(fields)).account_id } });
    assert.deepEqual(await decide(s.ledger, s.client, s.getSnapshot, input(p), identity), { status: 'applied' });
    assert.deepEqual(s.counts(), { creates: 1, patches: 1 });
  } finally { s.db.close(); }
});

test('normalization retains street numbers and directions, and maps suffixes', () => {
  assert.equal(streetKey('1250 Northwest Franklin Street'), '1250 nw franklin st');
  assert.equal(streetKey('3313 Wilmington Pike'), streetKey('3313 Wilmington Pk'));
  assert.notEqual(streetKey('1250 N Main St'), streetKey('1250 S Main St'));
  assert.notEqual(streetKey('1250 Main St'), streetKey('1251 Main St'));
});
test('complete pagination reads all pages and rejects duplicates or shifting totals', async () => {
  const pages = [
    { data: [{ account_id: '1' }], total: 2, page: 1 },
    { data: [{ account_id: '2' }], total: 2, page: 2 },
  ];
  let i = 0;
  assert.equal((await paginate(async () => pages[i++], 'accounts')).length, 2);
  i = 0;
  await assert.rejects(
    paginate(async () => ({ ...pages[i++], data: [{ account_id: '1' }] }), 'accounts'),
    /Duplicate/
  );
  i = 0;
  await assert.rejects(
    paginate(async () => ({ ...pages[i], total: ++i === 1 ? 2 : 3 }), 'accounts'),
    /changed/
  );
});
test('crawler includes homepage-only Findlay and 3 directory pages', async () => {
  const pages = JSON.parse(
    readFileSync(new URL('../fixtures/public-pages.json', import.meta.url), 'utf8')
  );
  const result = await crawl(async (url) => {
    const html = pages[url];
    return { ok: !!html, status: html ? 200 : 404, text: async () => html };
  });
  assert.equal(result.facilities.length, 35);
  assert(result.coverage.complete);
  assert(result.facilities.some((f) => f.name.includes('Findlay')));
  assert(result.coverage.directory_pages.some((u) => u.includes('page=3')));
});
test('crawler refuses a collection when any facility has an empty care offering', async () => {
  const pages = JSON.parse(
    readFileSync(new URL('../fixtures/public-pages.json', import.meta.url), 'utf8')
  );
  const detailUrl = baseline.facilities.find((facility) => facility.name.includes('Findlay'))
    .source_url;
  const careField = /(<dt\b[^>]*>Care Offerings<\/dt>\s*<dd\b[^>]*>)[\s\S]*?(<\/dd>)/i;
  assert.match(pages[detailUrl], careField);
  for (const offerings of [
    '<span></span>',
    '<span> \n &nbsp; </span>',
    '<span>Assisted Living</span><span> </span>',
  ]) {
    const malformed = pages[detailUrl].replace(careField, `$1${offerings}$2`);
    await assert.rejects(
      crawl(async (url) => ({
        ok: !!pages[url],
        status: pages[url] ? 200 : 404,
        text: async () => (url === detailUrl ? malformed : pages[url]),
      })),
      /Facility markup incomplete: \/communities\/bellhaven-meadows-of-findlay/
    );
  }
});
test('source failures stop the crawl instead of yielding absence proposals', async () => {
  await assert.rejects(
    crawl(async () => ({ ok: false, status: 503 })),
    /503/
  );
  const data = copy(baseline);
  data.coverage.complete = false;
  assert(!(await reconcile(data)).some((p) => p.kind === 'absent'));
});
test('Amberly exact-name collision requires review while Union Square remains a distinct-address proposal', async () => {
  const rows = await reconcile(baseline);
  const amber = rows.find((p) => p.title === 'Amberly Manor'),
    union = rows.find((p) => p.title.includes('Union Square'));
  assert.equal(amber.kind, 'ambiguous');
  assert.deepEqual([...new Set(amber.options.map((o) => o.resolution))].sort(), ['existing', 'separate']);
  assert(amber.matching_conflicts.some((c) => c.kind === 'name_collision'));
  assert.equal(amber.alternatives[0].account.billing_state, 'CO');
  assert.equal(union.kind, 'new_account');
  assert.equal(union.alternatives[0].account.billing_street, '240 Market St');
});
test('renames, ZIP corrections, PO boxes, and full care offerings', async () => {
  const rows = await reconcile(baseline),
    find = (s) => rows.find((p) => p.title.includes(s));
  assert.equal(find('Ashtabula').kind, 'unchanged');
  assert.equal(find('Toledo').kind, 'field_correction');
  assert.equal(find('Portsmouth').options[0].operations[0].fields.billing_zip, '45662');
  assert.equal(find('Ashland').kind, 'field_correction');
  assert(find('Findlay').options[0].operations[0].fields.note.includes('Assisted Living'));
  assert.equal(find('Findlay').facility.care_offerings.length, 2);
});
test('duplicates favor current affiliation and administrator contacts; Kettering stays ambiguous', async () => {
  const rows = await reconcile(baseline),
    find = (s) => rows.find((p) => p.title.includes(s));
  assert.equal(find('Monroe').options[0].id, '001U1750VLVJAGG1S5');
  assert.equal(find('Owosso').options[0].id, '001EGU7BMJ942ZTRE6');
  assert.equal(find('Kettering').kind, 'ambiguous');
  assert.equal(new Set(find('Kettering').options.map((o) => o.base_option_id ?? o.id)).size, 6);
  assert.equal(
    find('Kettering').options[0].operations.filter((o) => o.type === 'duplicate').length,
    2
  );
});
test('CHOW requires both positive revenue and AR', async () => {
  const rows = await reconcile(baseline);
  assert.equal(rows.filter((p) => p.kind === 'chow').length, 2);
  assert(rows.filter((p) => p.kind === 'chow').every((p) => /Tiffin|Marietta/.test(p.title)));
  assert(!needsChow({ parent_id: 'old', lifetime_revenue: 0, outstanding_ar: 10 }, 'new'));
  assert(!needsChow({ parent_id: 'old', lifetime_revenue: 1, outstanding_ar: 0 }, 'new'));
});
test('refresh never writes; a rejected proposal stays rejected across reruns', async () => {
  const s = setup(),
    p = await proposal(s, 'Union Square');
  assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
  await decide(
    s.ledger,
    s.client,
    s.getSnapshot,
    input(p, 'reject', 'Address conflict needs independent verification'),
    identity
  );
  await runPipeline(s.ledger, s.getSnapshot);
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
    'rejected'
  );
  assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
});
test('a changed billing condition invalidates a displayed proposal without writes', async () => {
  const s = setup(),
    p = await proposal(s, 'Crossings of Lima');
  s.data.accounts.find((a) => a.account_id === p.candidates[0].account.account_id).outstanding_ar =
    12;
  await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), /stale/);
  assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
});

test('parent retirement blocks a fresh pipeline, prior approval and interrupted CHOW recovery without further writes', async (t) => {
  for (const interrupted of [false, true]) {
    const s = setup();
    t.after(() => s.db.close());
    const p = await proposal(s, interrupted ? 'Tiffin' : 'Findlay');
    if (interrupted) {
      s.failLink(true);
      await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), /CHOW link not verified/);
      s.failLink(false);
    }
    const before = s.counts();
    s.data.accounts.find((account) => account.account_id === p.parent.account_id).status = 'Inactive';
    await assert.rejects(runPipeline(s.ledger, s.getSnapshot), /Bellhaven parent is inactive or historical/);
    await assert.rejects(
      decide(s.ledger, s.client, s.getSnapshot, input(p, interrupted ? 'resume' : 'approve'), identity),
      /Bellhaven parent is inactive or historical/
    );
    assert.deepEqual(s.counts(), before);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM locks').get().n, 0);
    assert.equal(s.db.prepare('SELECT status FROM proposals WHERE id=?').get(p.id).status, interrupted ? 'partial' : 'pending');
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='failed'").get().n, 1);
  }
});
test('a fresh proposal supersedes the older stale queue item while preserving its evidence and invalidation audit', async () => {
  const s = setup(),
    p = await proposal(s, 'Crossings of Lima');
  s.data.accounts.find((a) => a.account_id === p.candidates[0].account.account_id).outstanding_ar =
    12;
  await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), /stale/);
  await assert.rejects(
    runPipeline(s.ledger, async () => {
      throw Error('source unavailable');
    }),
    /source unavailable/
  );
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
    'stale'
  );
  await runPipeline(s.ledger, s.getSnapshot);
  const prior = await s.ledger.one('SELECT * FROM proposals WHERE id=?', p.id);
  assert.equal(prior.status, 'superseded');
  assert.equal(JSON.parse(prior.data).version, p.version);
  const current = await s.ledger.all(
    "SELECT * FROM proposals WHERE case_key=? AND status IN ('pending','stale')",
    p.key
  );
  assert.equal(current.length, 1);
  assert.equal(current[0].status, 'pending');
  assert.notEqual(current[0].id, p.id);
  assert(
    await s.ledger.one(
      "SELECT id FROM audits WHERE proposal_id=? AND event='proposal_invalidated'",
      p.id
    )
  );
  assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
  await assert.rejects(
    decide(
      s.ledger,
      s.client,
      s.getSnapshot,
      input(p, 'reopen', 'Old version should stay retired'),
      identity
    ),
    /Only rejected or stale/
  );
});
test('concurrent approval applies once; second pipeline has no repeated corrective operation', async () => {
  const s = setup(),
    p = await proposal(s, 'Portsmouth');
  const results = await Promise.allSettled([
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(s.counts().patches, 1);
  await runPipeline(s.ledger, s.getSnapshot);
  const rows = await s.ledger.all("SELECT data FROM proposals WHERE status='pending'");
  assert(!rows.some((r) => JSON.parse(r.data).title.includes('Portsmouth')));
});
test('interrupted CHOW resumes the existing replacement and preserves every original business field', async () => {
  const s = setup(),
    p = await proposal(s, 'Tiffin'),
    before = copy(p.candidates[0].account);
  s.failLink(true);
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    /CHOW link not verified/
  );
  assert.equal(s.counts().creates, 1);
  s.failLink(false);
  await decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity);
  assert.equal(s.counts().creates, 1);
  const after = await s.client.get(before.account_id);
  assert(after.chow_current_account);
  assert.deepEqual(
    businessAccount(after),
    businessAccount({ ...before, chow_current_account: after.chow_current_account })
  );
  const again = await reconcile(s.data);
  assert.equal(again.find((r) => r.title === p.title).kind, 'unchanged');
});
test('lost successful POST response is reconciled by its marker with one creation', async () => {
  const s = setup(),
    p = await proposal(s, 'Batavia');
  s.timeoutCreate(true);
  await decide(s.ledger, s.client, s.getSnapshot, input(p), identity);
  assert.equal(s.counts().creates, 1);
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
    'applied'
  );
});
test('unknown unsuccessful creation never blindly retries', async () => {
  const s = setup(),
    p = await proposal(s, 'Carlisle');
  s.dropCreate(true);
  await assert.rejects(decide(s.ledger, s.client, s.getSnapshot, input(p), identity), /uncertain/);
  s.dropCreate(false);
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity),
    /uncertain/
  );
  assert.equal(s.counts().creates, 1);
});
test('forged option is rejected and ordinary historical CHOW records are excluded from duplicates', async () => {
  const s = setup(),
    p = await proposal(s, 'Monroe');
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, { ...input(p), optionId: 'forged' }, identity),
    /server-stored/
  );
  const source = s.data.accounts.find((a) => a.account_id === '0011AB44D05WLA9HTX');
  source.chow_current_account = '001U1750VLVJAGG1S5';
  const row = (await reconcile(s.data)).find((p) => p.title.includes('Monroe'));
  assert(!row.options[0].operations.some((o) => o.account_id === source.account_id));
});
test('no implicit ownership change on website absence', async () => {
  const rows = (await reconcile(baseline)).filter((p) => p.kind === 'absent');
  assert.equal(rows.length, 3);
  assert(
    rows.every((p) =>
      p.options[0].operations.every(
        (o) => !Object.hasOwn(o.fields, 'parent_id') && o.fields.status === 'Needs Review'
      )
    )
  );
});

test('resuming a duplicate decision refuses drift in its completed survivor before retiring other accounts', async () => {
  const s = setup(),
    p = await proposal(s, 'Kettering');
  s.failDuplicate(true);
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    /Patch not verified/
  );
  const survivor = s.data.accounts.find((a) => a.account_id === p.options[0].id);
  survivor.parent_id = 'external-change';
  s.failDuplicate(false);
  const before = s.counts();
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity),
    /changed after approval/
  );
  assert.deepEqual(s.counts(), before);
  assert(!s.data.accounts.some((a) => a.duplicate_of_account === survivor.account_id));
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
    'partial'
  );
});

test('resuming duplicate work permits its own completed changes and does not repeat the survivor patch', async () => {
  const s = setup(),
    p = await proposal(s, 'Kettering');
  s.failDuplicate(true);
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    /Patch not verified/
  );
  s.failDuplicate(false);
  await decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity);
  assert.equal(s.counts().patches, 4);
  assert.equal(s.data.accounts.filter((a) => a.duplicate_of_account === p.options[0].id).length, 2);
});

test('duplicate retirement rereads its survivor during a single application', async () => {
  const s = setup(),
    p = await proposal(s, 'Kettering'),
    get = s.client.get;
  let survivorReads = 0;
  s.client.get = async (id) => {
    const result = await get(id);
    if (id === p.options[0].id && ++survivorReads === 2)
      s.data.accounts.find((a) => a.account_id === id).parent_id = 'concurrent-external-change';
    return result;
  };
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    /Surviving account changed/
  );
  assert.equal(s.counts().patches, 1);
  assert(!s.data.accounts.some((a) => a.duplicate_of_account === p.options[0].id));
});

test('resume checks changed contact evidence and a replacement account before writing a CHOW link', async () => {
  for (const drift of ['contact', 'replacement']) {
    const s = setup(),
      p = await proposal(s, 'Tiffin');
    s.failLink(true);
    await assert.rejects(
      decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
      /CHOW link not verified/
    );
    s.failLink(false);
    if (drift === 'contact')
      s.data.contacts.push({
        contact_id: 'new-contact',
        account_id: p.candidates[0].account.account_id,
        name: 'New administrator',
        is_active: true,
      });
    else s.data.accounts.find((a) => a.account_id === 'created-1').outstanding_ar = 100;
    const before = s.counts();
    await assert.rejects(
      decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity),
      /changed/
    );
    assert.deepEqual(s.counts(), before);
    assert(
      !s.data.accounts.find((a) => a.account_id === p.candidates[0].account.account_id)
        .chow_current_account
    );
  }
});

test('historical graph faults block new accounts and consolidation at the affected location', async () => {
  for (const fault of ['missing', 'cycle', 'conflicting', 'misplaced']) {
    const data = copy(baseline),
      original = (await reconcile(data)).find((p) => p.title.includes('Ashtabula')),
      account = data.accounts.find(
        (a) => a.account_id === original.candidates[0].account.account_id
      );
    account.chow_current_account =
      fault === 'cycle'
        ? account.account_id
        : fault === 'misplaced'
          ? original.parent.account_id
          : 'missing';
    if (fault === 'conflicting') account.duplicate_of_account = original.parent.account_id;
    const p = (await reconcile(data)).find((p) => p.title.includes('Ashtabula'));
    assert.equal(p.kind, 'ambiguous');
    assert.equal(p.options.length, 0);
    assert.equal(p.link_conflicts.length, 1);
    assert(p.alternatives.some((c) => c.account.account_id === account.account_id));
  }
});

test('removed listings do not retain stale unchanged proposals', async () => {
  const s = setup();
  await runPipeline(s.ledger, s.getSnapshot);
  const facility = s.data.facilities.find((f) => f.name.includes('Ashtabula'));
  s.data.facilities = s.data.facilities.filter((f) => f !== facility);
  s.data.coverage.expected--;
  s.data.coverage.found--;
  await runPipeline(s.ledger, s.getSnapshot);
  const rows = await s.ledger.all("SELECT data FROM proposals WHERE status='unchanged'");
  assert(!rows.some((r) => JSON.parse(r.data).key === facility.source_url));
});

test('an interrupted absence flag cannot resume after the facility reappears', async () => {
  const s = setup();
  await runPipeline(s.ledger, s.getSnapshot);
  const p = (await reconcile(s.data)).find((p) => p.kind === 'absent'),
    a = p.candidates[0].account,
    patch = s.client.patch;
  s.client.patch = async () => {
    throw Error('timeout');
  };
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
    /Patch not verified/
  );
  s.client.patch = patch;
  s.data.facilities.push({
    ...s.data.facilities[0],
    name: a.name,
    street_address: a.billing_street,
    city: a.billing_city,
    state: a.billing_state,
    postal_code: a.billing_zip,
    phone_raw: a.phone,
    source_url:
      'https://analyst-assessment-production.up.railway.app/communities/returned-facility',
  });
  s.data.coverage.expected++;
  s.data.coverage.found++;
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity),
    /evidence changed/
  );
  assert.equal(s.counts().patches, 0);
});

test('name and equivalent-address spelling changes persist with prior values only after approval and stay stable on rerun', async () => {
  const s = setup(),
    p = await proposal(s, 'Chesterton'),
    op = p.options[0].operations.find((o) => o.type === 'patch'),
    before = copy(op.before);
  assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
  assert.deepEqual(await s.client.get(before.account_id), before);
  assert.equal(op.fields.name, p.facility.name);
  assert.equal(op.fields.billing_street, p.facility.street_address);
  assert(
    op.fields.note.includes(
      `Prior observed CRM name (not a verified official alias): ${before.name}`
    )
  );
  assert(
    op.fields.note.includes(
      `Prior observed CRM billing address (not a verified official alias): ${before.billing_street}`
    )
  );
  await decide(s.ledger, s.client, s.getSnapshot, input(p), identity);
  const after = await s.client.get(before.account_id);
  assert.equal(after.name, p.facility.name);
  assert.equal(after.billing_street, p.facility.street_address);
  assert.equal(after.note, op.fields.note);
  await runPipeline(s.ledger, s.getSnapshot);
  assert.equal((await reconcile(s.data)).find((r) => r.key === p.key).kind, 'unchanged');
  assert.equal(s.counts().patches, 1);
});

test('billing PO boxes and substantive street conflicts never receive a spelling patch; CHOW keeps source raw values', async () => {
  const rows = await reconcile(baseline),
    ashtabula = rows.find((p) => p.title.includes('Ashtabula')),
    union = rows.find((p) => p.title.includes('Union Square')),
    marietta = rows.find((p) => p.title.includes('Marietta'));
  assert(
    ashtabula.options.every((o) =>
      o.operations.every((op) => !Object.hasOwn(op.fields, 'billing_street'))
    )
  );
  assert(union.options.every((o) => o.operations.every((op) => op.type === 'create')));
  assert.equal(marietta.options[0].operations[0].type, 'chow');
  const s = setup(),
    p = await proposal(s, 'Marietta'),
    before = copy(p.candidates[0].account);
  await decide(s.ledger, s.client, s.getSnapshot, input(p), identity);
  const after = await s.client.get(before.account_id);
  assert.deepEqual(
    businessAccount(after),
    businessAccount({ ...before, chow_current_account: after.chow_current_account })
  );
  assert.equal(after.billing_street, '805 Colegate Drive');
});

test('operator: open totals retain outstanding work while new counts measure only the refresh', async () => {
  const s = setup();
  try {
    const first = await runPipeline(s.ledger, s.getSnapshot);
    assert(first.open_proposals > 0);
    const repeat = await runPipeline(s.ledger, s.getSnapshot);
    assert.equal(repeat.new_proposals, 0);
    assert.equal(repeat.open_proposals, first.open_proposals);
    // Manual drafts and interrupted/stale cases share the queue; closed and
    // superseded historical versions must not inflate its count.
    for (const status of ['pending', 'partial', 'applying', 'stale', 'applied', 'rejected', 'unchanged', 'superseded']) {
      await s.ledger.run('INSERT INTO proposals(id,case_key,version,run_id,status,data,created) VALUES(?,?,?,?,?,?,?)',
        `manual-${status}`, `manual:${status}`, status, first.id, status, '{}', new Date().toISOString());
    }
    const backlog = await runPipeline(s.ledger, s.getSnapshot);
    assert.equal(backlog.new_proposals, 0);
    assert.equal(backlog.open_proposals, first.open_proposals + 4);
    const saved = JSON.parse((await s.ledger.one('SELECT data FROM runs WHERE id=?', backlog.id)).data);
    assert.equal(saved.counts.open_proposals, backlog.open_proposals);
    const audits = await s.ledger.all("SELECT data FROM audits WHERE event='pipeline_complete'");
    assert.equal(audits.map((row) => JSON.parse(row.data)).find((row) => row.run_id === backlog.id).open_proposals, backlog.open_proposals);
    const p = (await reconcile(s.data)).find((row) => row.title.includes('Portsmouth'));
    await decide(s.ledger, s.client, s.getSnapshot, input(p, 'reject'), identity);
    s.data.facilities.find((f) => f.name.includes('Tiffin')).name += ' Updated';
    const changed = await runPipeline(s.ledger, s.getSnapshot);
    assert.equal(changed.new_proposals, 1);
    assert.equal(changed.open_proposals, backlog.open_proposals - 1, 'A replacement version counts once; rejection removes one open case');
    assert.equal(JSON.parse((await s.ledger.one('SELECT data FROM runs WHERE id=?', backlog.id)).data).counts.open_proposals,
      backlog.open_proposals, 'Later decisions do not rewrite a historical count');
    assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
  } finally { s.db.close(); }
});

test('operator: a failed transactional publication preserves the entire last successful queue', async () => {
  const s = setup();
  await runPipeline(s.ledger, s.getSnapshot);
  const before = await s.ledger.all('SELECT id,status FROM proposals ORDER BY id');
  s.data.facilities[0].name += ' Updated';
  s.db.exec(
    "CREATE TRIGGER reject_run_audit BEFORE INSERT ON audits WHEN NEW.event='pipeline_complete' BEGIN SELECT RAISE(ABORT,'simulated D1 failure'); END"
  );
  await assert.rejects(runPipeline(s.ledger, s.getSnapshot), /simulated D1 failure/);
  assert.deepEqual(await s.ledger.all('SELECT id,status FROM proposals ORDER BY id'), before);
  assert.equal(
    (await s.ledger.one("SELECT COUNT(*) AS count FROM runs WHERE status='failed'")).count,
    1
  );
  assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
  s.db.exec('DROP TRIGGER reject_run_audit');
  await runPipeline(s.ledger, s.getSnapshot);
  assert.notDeepEqual(await s.ledger.all('SELECT id,status FROM proposals ORDER BY id'), before);
});

test('reviewer: a failed approval or rejection audit cannot persist a contradictory decision', async () => {
  for (const action of ['approve', 'reject']) {
    const s = setup(),
      p = await proposal(s, 'Portsmouth');
    s.db.exec(
      `CREATE TRIGGER reject_decision_audit BEFORE INSERT ON audits WHEN NEW.event='proposal_${action === 'approve' ? 'approved' : 'rejected'}' BEGIN SELECT RAISE(ABORT,'simulated D1 failure'); END`
    );
    await assert.rejects(
      decide(s.ledger, s.client, s.getSnapshot, input(p, action), identity),
      /simulated D1 failure/
    );
    assert.equal(
      (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
      'pending'
    );
    assert.equal(
      (await s.ledger.one('SELECT COUNT(*) AS count FROM decisions WHERE proposal_id=?', p.id))
        .count,
      0
    );
    assert.deepEqual(s.counts(), { creates: 0, patches: 0 });
  }
});

test('auditor: checkpoint and verification audit recover together after a database failure, without repeating CRM writes', async () => {
  for (const title of ['Portsmouth', 'Tiffin']) {
    const s = setup(),
      p = await proposal(s, title);
    s.db.exec(
      "CREATE TRIGGER reject_verification_audit BEFORE INSERT ON audits WHEN NEW.event='operation_verified' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END"
    );
    await assert.rejects(
      decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
      /simulated audit failure/
    );
    const writes = s.counts();
    assert.equal(
      (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
      'partial'
    );
    assert.equal(
      (
        await s.ledger.one(
          "SELECT COUNT(*) AS count FROM operations WHERE proposal_id=? AND status='complete'",
          p.id
        )
      ).count,
      0
    );
    s.db.exec('DROP TRIGGER reject_verification_audit');
    await decide(s.ledger, s.client, s.getSnapshot, input(p, 'resume'), identity);
    assert.deepEqual(s.counts(), writes);
    assert.equal(
      (
        await s.ledger.one(
          "SELECT COUNT(*) AS count FROM audits WHERE proposal_id=? AND event='operation_verified'",
          p.id
        )
      ).count,
      1
    );
    assert.equal(
      (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
      'applied'
    );
  }
});

test('billing: unknown balances block ownership changes and duplicate retirement; numeric strings remain supported', async () => {
  for (const missing of [undefined, null, '', 'not-a-number', 'NaN', Infinity]) {
    assert.throws(
      () =>
        needsChow(
          { parent_id: 'legacy', lifetime_revenue: missing, outstanding_ar: 10 },
          'current'
        ),
      /Billing fields/
    );
    assert.throws(
      () =>
        needsChow(
          { parent_id: 'legacy', lifetime_revenue: 10, outstanding_ar: missing },
          'current'
        ),
      /Billing fields/
    );
  }
  assert(
    needsChow(
      { parent_id: 'legacy', lifetime_revenue: '84000.00', outstanding_ar: '12400.00' },
      'current'
    )
  );
  const s = setup(),
    p = await proposal(s, 'Tiffin');
  s.data.accounts.find(
    (a) => a.account_id === p.candidates[0].account.account_id
  ).lifetime_revenue = null;
  const next = (await reconcile(s.data)).find((row) => row.key === p.key);
  assert.equal(next.kind, 'ambiguous');
  assert.equal(next.options.length, 0);
  const dup = (await reconcile(s.data)).find((row) => row.title.includes('Monroe'));
  s.data.accounts.find(
    (a) => a.account_id === dup.candidates[1].account.account_id
  ).outstanding_ar = 'unknown';
  const uncertain = (await reconcile(s.data)).find((row) => row.key === dup.key);
  assert.equal(uncertain.kind, 'ambiguous');
  assert.equal(uncertain.options.length, 0);
});

test('billing: an AR-only account outranks an unbilled copy and is reparented directly', async () => {
  const s = setup(),
    p = await proposal(s, 'Monroe'),
    chosen = p.candidates[1].account.account_id;
  for (const candidate of p.candidates) {
    const a = s.data.accounts.find((a) => a.account_id === candidate.account.account_id);
    a.lifetime_revenue = 0;
    a.outstanding_ar = a.account_id === chosen ? 25 : 0;
  }
  const next = (await reconcile(s.data)).find((row) => row.key === p.key);
  assert.equal(next.options[0].id, chosen);
  assert(!next.options[0].operations.some((op) => op.type === 'chow'));
  assert(
    next.options[0].operations.some((op) => op.type === 'duplicate' && op.account_id !== chosen)
  );
});

test('data steward: every extra care offering survives in notes even without a supported CRM category', async () => {
  const data = copy(baseline),
    facility = data.facilities.find((f) => f.name.includes('Ashtabula'));
  facility.care_offerings.push('Hospice coordination');
  const p = (await reconcile(data)).find((row) => row.key === facility.source_url),
    patch = p.options[0].operations.find((op) => op.type === 'patch');
  assert(patch.fields.note.includes('Hospice coordination'));
  assert(patch.fields.note.includes(facility.care_offerings[0]));
  assert(!Object.hasOwn(patch.fields, 'care_types'));
});

test('CHOW withholds the original link when the newly created replacement is already historical', async () => {
  for (const pointer of ['chow_current_account', 'duplicate_of_account']) {
    const s = setup();
    const p = await proposal(s, 'Tiffin');
    const create = s.client.create;
    s.client.create = async (fields) => {
      const result = await create(fields);
      s.data.accounts.find((a) => a.account_id === result.account_id)[pointer] =
        'another-current-account';
      return result;
    };
    await assert.rejects(
      decide(s.ledger, s.client, s.getSnapshot, input(p), identity),
      /Created.account/
    );
    assert.deepEqual(s.counts(), { creates: 1, patches: 0 });
    assert(!(await s.client.get(p.candidates[0].account.account_id)).chow_current_account);
  }
});

async function pendingCase(s, key) {
  const rows = await s.ledger.all(
    "SELECT data FROM proposals WHERE case_key=? AND status='pending'",
    key
  );
  assert.equal(rows.length, 1);
  return JSON.parse(rows[0].data);
}

test('a reverted correction receives one fresh revision and its rejection stays decided on reruns', async () => {
  const s = setup();
  const original = await proposal(s, 'Portsmouth');
  const before = copy(original.options[0].operations[0].before);
  const savedOriginal = await s.ledger.one('SELECT data FROM proposals WHERE id=?', original.id);
  await decide(s.ledger, s.client, s.getSnapshot, input(original), identity);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  assert.equal(
    (
      await s.ledger.all(
        "SELECT id FROM proposals WHERE case_key=? AND status='pending'",
        original.key
      )
    ).length,
    0
  );

  s.data.accounts = s.data.accounts.map((a) =>
    a.account_id === before.account_id ? copy(before) : a
  );
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 1);
  const revision = await pendingCase(s, original.key);
  assert.notEqual(revision.id, original.id);
  assert.equal(revision.version, revision.id);
  assert.equal(revision.evidence_version, original.version);
  assert.equal(revision.revision_of, original.id);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  assert.equal((await pendingCase(s, original.key)).id, revision.id);

  await decide(
    s.ledger,
    s.client,
    s.getSnapshot,
    input(revision, 'reject', 'External rollback needs independent investigation'),
    identity
  );
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', revision.id)).status,
    'rejected'
  );
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', original.id)).status,
    'applied'
  );
  assert.equal(
    (await s.ledger.one('SELECT data FROM proposals WHERE id=?', original.id)).data,
    savedOriginal.data
  );
  assert.equal(s.counts().patches, 1);

  // Equal display timestamps cannot make the applied original hide the newer rejection.
  await s.ledger.run(
    'UPDATE proposals SET created=? WHERE case_key=?',
    '2026-10-10T00:00:00.000Z',
    original.key
  );
  const report = await operationalReport(s.ledger.db);
  assert.equal(report.current.by_state.find((row) => row.state === 'rejected')?.total, 1);
});

test('successive applied-to-rollback cycles create distinct operation IDs and retain earlier history', async () => {
  const s = setup();
  const original = await proposal(s, 'Portsmouth');
  const before = copy(original.options[0].operations[0].before);
  let current = original;
  const versions = [original.id];
  for (let cycle = 0; cycle < 3; cycle++) {
    await decide(s.ledger, s.client, s.getSnapshot, input(current), identity);
    assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
    if (cycle === 2) break;
    await s.ledger.run('UPDATE decisions SET created=?', '2026-10-10T00:00:00.000Z');
    await s.ledger.run(
      'UPDATE proposals SET created=? WHERE case_key=?',
      '2026-10-10T00:00:00.000Z',
      original.key
    );
    s.data.accounts = s.data.accounts.map((a) =>
      a.account_id === before.account_id ? copy(before) : a
    );
    assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 1);
    const next = await pendingCase(s, original.key);
    assert.equal(next.revision_of, current.id);
    assert.equal(next.evidence_version, original.version);
    versions.push(next.id);
    current = next;
  }
  assert.equal(new Set(versions).size, 3);
  assert.equal(s.counts().patches, 3);
  const operations = await s.ledger.all('SELECT id,proposal_id,status FROM operations');
  assert.equal(new Set(operations.map((op) => op.id)).size, 3);
  assert(operations.every((op) => versions.includes(op.proposal_id) && op.status === 'complete'));
  for (const version of versions)
    assert.equal(
      (await s.ledger.one('SELECT status FROM proposals WHERE id=?', version)).status,
      'applied'
    );
});

test('revised proposals still invalidate on changed base evidence before any second write', async () => {
  const s = setup();
  const original = await proposal(s, 'Portsmouth');
  const before = copy(original.options[0].operations[0].before);
  await decide(s.ledger, s.client, s.getSnapshot, input(original), identity);
  s.data.accounts = s.data.accounts.map((a) =>
    a.account_id === before.account_id ? copy(before) : a
  );
  await runPipeline(s.ledger, s.getSnapshot);
  const revision = await pendingCase(s, original.key);
  s.data.accounts.find((a) => a.account_id === before.account_id).phone = '555-010-9999';
  await assert.rejects(
    decide(s.ledger, s.client, s.getSnapshot, input(revision), identity),
    /stale/
  );
  assert.equal(s.counts().patches, 1);
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', revision.id)).status,
    'stale'
  );
});

test('recreating an externally removed approved account uses a fresh marker and never reuses old checkpoints', async () => {
  const s = setup();
  const original = await proposal(s, 'Batavia');
  await decide(s.ledger, s.client, s.getSnapshot, input(original), identity);
  const first = copy(s.data.accounts.find((a) => a.account_id === 'created-1'));
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
  s.data.accounts = s.data.accounts.filter((a) => a.account_id !== first.account_id);
  await runPipeline(s.ledger, s.getSnapshot);
  const revision = await pendingCase(s, original.key);
  s.timeoutCreate(true);
  await decide(s.ledger, s.client, s.getSnapshot, input(revision), identity);
  const second = s.data.accounts.find((a) => a.account_id === 'created-2');
  assert(second);
  assert.notEqual(second.note, first.note);
  assert.equal(s.counts().creates, 2);
  assert.equal((await s.ledger.all("SELECT id FROM operations WHERE status='complete'")).length, 2);
  assert.equal((await runPipeline(s.ledger, s.getSnapshot)).new_proposals, 0);
});
