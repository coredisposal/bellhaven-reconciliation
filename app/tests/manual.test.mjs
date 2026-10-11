import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Ledger } from '../lib/ledger.mjs';
import { sqliteD1 } from './helpers/sqlite-d1.mjs';
import { stageManual, decideManual } from '../lib/manual.mjs';
import { runPipeline } from '../lib/engine.mjs';
import { businessAccount, digest } from '../lib/core.mjs';
import baseline from '../fixtures/baseline.json' with { type: 'json' };
const identity = { actor: 'test reviewer', session: 'test-manual' },
  clone = (x) => structuredClone(x);
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../drizzle/', import.meta.url)).filter((f) =>
    f.endsWith('.sql')
  ))
    sqlite.exec(readFileSync(new URL('../drizzle/' + f, import.meta.url), 'utf8'));
  const ledger = new Ledger(sqliteD1(sqlite));
  const data = clone(baseline),
    writes = [];
  let failLink = false,
    loseContactResponse = false,
    loseAccountResponse = false,
    failReadCreatedContact = false;
  const client = {
    accounts: async () => clone(data.accounts),
    contacts: async () => clone(data.contacts),
    get: async (id) => clone(data.accounts.find((a) => a.account_id === id)),
    getContact: async (id) => {
      if (failReadCreatedContact && id.startsWith('manual-contact')) throw Error('read timeout');
      return clone(data.contacts.find((c) => c.contact_id === id));
    },
    patch: async (id, fields) => {
      writes.push({ method: 'PATCH', entity: 'accounts', id, fields });
      if (failLink && fields.chow_current_account) throw Error('link timeout');
      Object.assign(
        data.accounts.find((a) => a.account_id === id),
        fields
      );
      return {};
    },
    patchContact: async (id, fields) => {
      writes.push({ method: 'PATCH', entity: 'contacts', id, fields });
      Object.assign(
        data.contacts.find((c) => c.contact_id === id),
        fields
      );
      return {};
    },
    create: async (fields) => {
      writes.push({ method: 'POST', entity: 'accounts', fields });
      const account = {
        ...fields,
        account_id: 'manual-account-' + writes.length,
        chow_current_account: '',
        duplicate_of_account: '',
      };
      data.accounts.push(account);
      if (loseAccountResponse) throw Error('response timeout');
      return { data: clone(account) };
    },
    createContact: async (fields) => {
      writes.push({ method: 'POST', entity: 'contacts', fields });
      const contact = { ...fields, contact_id: 'manual-contact-' + writes.length };
      data.contacts.push(contact);
      if (loseContactResponse) throw Error('response timeout');
      return clone(contact);
    },
  };
  return {
    sqlite,
    ledger,
    client,
    data,
    writes,
    failLink: (v) => (failLink = v),
    loseContactResponse: (v) => (loseContactResponse = v),
    loseAccountResponse: (v) => (loseAccountResponse = v),
    failReadCreatedContact: (v) => (failReadCreatedContact = v),
  };
}
const input = (p, action = 'approve', note = 'Evidence reviewed') => ({
  id: p.id,
  version: p.version,
  optionId: 'manual',
  action,
  note,
});
const stage = (s, entity, recordId, fields) =>
  stageManual(
    s.ledger,
    s.client,
    {
      entity,
      ...(recordId ? { recordId } : {}),
      fields,
      note: 'Explicit user-requested correction',
    },
    identity
  );

test('manual approval refuses valid-shaped fields or material changed after drafting', async (t) => {
  for (const altered of ['fields', 'material', 'before', 'reviewer_note']) {
    const s = setup();
    t.after(() => s.sqlite.close());
    const source = s.data.accounts.find((a) => a.name.includes('Tiffin') && Number(a.lifetime_revenue) > 0);
    const parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
    const p = await stage(s, 'accounts', source.account_id, { phone: '555-123-4567' });
    const stored = JSON.parse((await s.ledger.one('SELECT data FROM proposals WHERE id=?', p.id)).data);
    if (altered === 'fields' || altered === 'material') {
      stored.fields.parent_id = parent.account_id;
      stored.options[0].operations[0].fields.parent_id = parent.account_id;
      if (altered === 'material') stored.material.fields.parent_id = parent.account_id;
    } else if (altered === 'before') {
      stored.before.outstanding_ar = 0;
      stored.options[0].operations[0].before.outstanding_ar = 0;
    } else stored.reviewer_note = 'Changed explanation after reviewer viewed the draft';
    await s.ledger.run('UPDATE proposals SET data=? WHERE id=?', JSON.stringify(stored), p.id);
    await assert.rejects(decideManual(s.ledger, s.client, input(p), identity), /integrity check failed/);
    assert.equal(s.writes.length, 0);
    assert.equal((await s.ledger.one('SELECT COUNT(*) AS total FROM decisions')).total, 0);
    assert.equal((await s.ledger.one('SELECT COUNT(*) AS total FROM locks')).total, 0);
  }
});

test('a self-consistent direct parent draft still cannot bypass the fresh CHOW billing guard', async (t) => {
  const s = setup();
  t.after(() => s.sqlite.close());
  const source = s.data.accounts.find((a) => a.name.includes('Tiffin') && Number(a.lifetime_revenue) > 0);
  const parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
  const p = await stage(s, 'accounts', source.account_id, { phone: '555-123-4567' });
  const stored = JSON.parse((await s.ledger.one('SELECT data FROM proposals WHERE id=?', p.id)).data);
  // Represents an incorrectly generated draft from an older implementation:
  // its hash is consistent, but the direct operation violates today's SOP.
  stored.fields.parent_id = parent.account_id;
  stored.options[0].operations[0].fields.parent_id = parent.account_id;
  stored.material.fields.parent_id = parent.account_id;
  stored.dependencies = [clone(parent)];
  stored.material.seed = await digest({
    rule: 'manual-v1', entity: stored.entity, recordId: stored.recordId,
    before: businessAccount(stored.before), fields: stored.fields,
    dependencies: stored.dependencies.map(businessAccount), reviewer_note: stored.reviewer_note,
  });
  stored.id = stored.version = stored.evidence_version = await digest(stored.material);
  await s.ledger.run('UPDATE proposals SET id=?,version=?,data=? WHERE id=?',
    stored.id, stored.version, JSON.stringify(stored), p.id);
  await assert.rejects(decideManual(s.ledger, s.client, input(stored), identity), /direct parent patch is not allowed/);
  assert.equal(s.writes.length, 0);
  assert.equal((await s.ledger.one('SELECT COUNT(*) AS total FROM decisions')).total, 0);
  assert.equal((await s.ledger.one('SELECT status FROM proposals WHERE id=?', stored.id)).status, 'stale');
});

test('manual recovery refuses an altered approved CHOW plan before another write', async (t) => {
  const s = setup();
  t.after(() => s.sqlite.close());
  const source = s.data.accounts.find((a) => a.name.includes('Tiffin') && Number(a.lifetime_revenue) > 0);
  const parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
  const p = await stage(s, 'accounts', source.account_id, { parent_id: parent.account_id });
  s.failLink(true);
  await assert.rejects(decideManual(s.ledger, s.client, input(p), identity), /CHOW link not verified/);
  const writes = s.writes.length;
  const stored = JSON.parse((await s.ledger.one('SELECT data FROM proposals WHERE id=?', p.id)).data);
  stored.fields.phone = '555-123-4567';
  stored.options[0].operations[0].fields.phone = stored.fields.phone;
  await s.ledger.run('UPDATE proposals SET data=? WHERE id=?', JSON.stringify(stored), p.id);
  s.failLink(false);
  await assert.rejects(decideManual(s.ledger, s.client, input(p, 'resume'), identity), /integrity check failed/);
  assert.equal(s.writes.length, writes);
  assert.equal((await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status, 'partial');
});

test('billing: manual CHOW refuses an existing renamed replacement both at drafting and just before approval', async () => {
  for (const when of ['draft', 'approval']) {
    const s = setup(),
      source = s.data.accounts.find(
        (a) => a.name.includes('Tiffin') && Number(a.lifetime_revenue) > 0
      ),
      parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
    let p;
    if (when === 'approval')
      p = await stage(s, 'accounts', source.account_id, { parent_id: parent.account_id });
    s.data.accounts.push({
      ...source,
      account_id: 'existing-replacement',
      name: 'Current renamed facility',
      parent_id: parent.account_id,
      lifetime_revenue: 0,
      outstanding_ar: 0,
    });
    if (when === 'draft')
      await assert.rejects(
        stage(s, 'accounts', source.account_id, { parent_id: parent.account_id }),
        /existing record/
      );
    else
      await assert.rejects(
        decideManual(s.ledger, s.client, input(p), identity),
        /Matching record now exists/
      );
    assert.equal(s.writes.length, 0);
    assert(!source.chow_current_account);
  }
});

test('operator: failed manual draft publication retains the prior draft', async () => {
  const s = setup(),
    contact = s.data.contacts[0],
    p = await stage(s, 'contacts', contact.contact_id, { title: 'Reviewed administrator' });
  s.sqlite.exec(
    "CREATE TRIGGER fail_draft_audit BEFORE INSERT ON audits WHEN NEW.event='manual_proposal_staged' BEGIN SELECT RAISE(ABORT,'simulated D1 failure'); END"
  );
  await assert.rejects(
    stage(s, 'contacts', contact.contact_id, { title: 'Second proposed title' }),
    /simulated D1 failure/
  );
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
    'pending'
  );
  assert.equal((await s.ledger.one('SELECT COUNT(*) AS count FROM proposals')).count, 1);
  assert.equal(s.writes.length, 0);
});

test('auditor: a manual verification audit failure resumes without duplicating a contact update', async () => {
  const s = setup(),
    contact = s.data.contacts[0],
    p = await stage(s, 'contacts', contact.contact_id, { title: 'Reviewed administrator' });
  s.sqlite.exec(
    "CREATE TRIGGER fail_verification_audit BEFORE INSERT ON audits WHEN NEW.event='operation_verified' BEGIN SELECT RAISE(ABORT,'simulated D1 failure'); END"
  );
  await assert.rejects(
    decideManual(s.ledger, s.client, input(p), identity),
    /simulated D1 failure/
  );
  assert.equal(s.writes.length, 1);
  assert.equal(
    (await s.ledger.one("SELECT COUNT(*) AS count FROM operations WHERE status='complete'")).count,
    0
  );
  s.sqlite.exec('DROP TRIGGER fail_verification_audit');
  await decideManual(s.ledger, s.client, input(p, 'resume'), identity);
  assert.equal(s.writes.length, 1);
  assert.equal(
    (await s.ledger.one("SELECT COUNT(*) AS count FROM audits WHERE event='operation_verified'"))
      .count,
    1
  );
});

test('billing: manual parent edits reject missing balances rather than interpreting them as zero', async () => {
  const s = setup(),
    source = s.data.accounts.find(
      (a) => a.name.includes('Tiffin') && Number(a.lifetime_revenue) > 0
    ),
    parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
  source.outstanding_ar = null;
  await assert.rejects(
    stage(s, 'accounts', source.account_id, { parent_id: parent.account_id }),
    /Billing fields/
  );
  assert.equal(s.writes.length, 0);
});

test('manual contact and account updates are drafts until exact-version approval and survive automated refresh', async () => {
  const s = setup(),
    contact = s.data.contacts[0],
    account = s.data.accounts.find((a) => a.account_id === contact.account_id);
  const cp = await stage(s, 'contacts', contact.contact_id, {
    title: 'Administrator',
    email: 'reviewed@example.test',
  });
  const ap = await stage(s, 'accounts', account.account_id, { phone: '(555) 123-4567' });
  assert.equal(s.writes.length, 0);
  assert.equal(cp.origin, 'manual');
  assert.equal(cp.kind, 'manual_contact');
  await runPipeline(s.ledger, async () => clone(s.data));
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', cp.id)).status,
    'pending'
  );
  await decideManual(s.ledger, s.client, input(cp), identity);
  await decideManual(s.ledger, s.client, input(ap), identity);
  assert.equal(s.writes.length, 2);
  assert.equal((await s.client.getContact(contact.contact_id)).email, 'reviewed@example.test');
  assert.equal((await s.client.get(account.account_id)).phone, '(555) 123-4567');
});

test('manual inputs reject financial/system fields, unobserved contact fields, and arbitrary approval patches', async () => {
  const s = setup(),
    account = s.data.accounts.find((a) => a.billing_street),
    contact = s.data.contacts[0];
  for (const field of [
    'lifetime_revenue',
    'outstanding_ar',
    'chow_current_account',
    'duplicate_of_account',
    'updated_at',
  ])
    await assert.rejects(stage(s, 'accounts', account.account_id, { [field]: 0 }), /not editable/);
  await assert.rejects(
    stage(s, 'contacts', contact.contact_id, { note: 'unsupported' }),
    /not editable/
  );
  const p = await stage(s, 'contacts', contact.contact_id, { title: 'Administrator' });
  await assert.rejects(
    decideManual(s.ledger, s.client, { ...input(p), fields: { title: 'forged' } }, identity),
    /stored proposal/
  );
  assert.equal(s.writes.length, 0);
});

test('stale contacts or their linked account invalidate manual approval without writes', async () => {
  for (const changed of ['contact', 'account']) {
    const s = setup(),
      contact = s.data.contacts[0],
      p = await stage(s, 'contacts', contact.contact_id, { title: 'Administrator' });
    if (changed === 'contact') contact.email = 'external@example.test';
    else s.data.accounts.find((a) => a.account_id === contact.account_id).status = 'Inactive';
    await assert.rejects(decideManual(s.ledger, s.client, input(p), identity), /changed/);
    assert.equal(s.writes.length, 0);
    assert.equal(
      (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
      'stale'
    );
  }
});

test('manual rejection persists on identical restaging and explicit reopening is audited', async () => {
  const s = setup(),
    contact = s.data.contacts[0],
    p = await stage(s, 'contacts', contact.contact_id, { title: 'Administrator' });
  await decideManual(
    s.ledger,
    s.client,
    input(p, 'reject', 'No reliable source for title'),
    identity
  );
  assert.equal(
    (await stage(s, 'contacts', contact.contact_id, { title: 'Administrator' })).status,
    'rejected'
  );
  await decideManual(s.ledger, s.client, input(p, 'reopen', 'New evidence supplied'), identity);
  assert.equal(
    (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
    'pending'
  );
  assert.equal(s.writes.length, 0);
});

test('explicitly restaging a superseded manual draft restores one reviewable version without losing history', async (t) => {
  const s = setup();
  t.after(() => s.sqlite.close());
  const contact = s.data.contacts[0];
  const first = await stage(s, 'contacts', contact.contact_id, { title: 'Verified administrator' });
  const second = await stage(s, 'contacts', contact.contact_id, { title: 'Regional administrator' });
  const originalData = (await s.ledger.one('SELECT data FROM proposals WHERE id=?', first.id)).data;
  assert.equal((await s.ledger.one('SELECT status FROM proposals WHERE id=?', first.id)).status, 'superseded');
  s.sqlite.exec("CREATE TRIGGER fail_restore_audit BEFORE INSERT ON audits WHEN NEW.event='manual_proposal_staged' BEGIN SELECT RAISE(ABORT,'simulated D1 failure'); END");
  await assert.rejects(stage(s, 'contacts', contact.contact_id, { title: 'Verified administrator' }), /simulated D1 failure/);
  assert.equal((await s.ledger.one('SELECT status FROM proposals WHERE id=?', first.id)).status, 'superseded');
  assert.equal((await s.ledger.one('SELECT status FROM proposals WHERE id=?', second.id)).status, 'pending');
  s.sqlite.exec('DROP TRIGGER fail_restore_audit');
  const restored = await stage(s, 'contacts', contact.contact_id, { title: 'Verified administrator' });
  assert.equal(restored.id, first.id);
  assert.equal(restored.status, 'pending');
  assert.equal((await s.ledger.one('SELECT data FROM proposals WHERE id=?', first.id)).data, originalData);
  assert.equal((await s.ledger.one('SELECT status FROM proposals WHERE id=?', second.id)).status, 'superseded');
  assert.equal((await s.ledger.all("SELECT id FROM proposals WHERE status='pending'")).length, 1);
  assert.equal((await s.ledger.all("SELECT id FROM audits WHERE event='manual_proposal_staged'")).length, 3);
  assert.equal(s.writes.length, 0);
  await decideManual(s.ledger, s.client, input(restored), identity);
  assert.equal(contact.title, 'Verified administrator');
  assert.equal(s.writes.length, 1);
});

test('concurrent manual approvals apply one patch', async () => {
  const s = setup(),
    p = await stage(s, 'contacts', s.data.contacts[0].contact_id, { title: 'Administrator' });
  const results = await Promise.allSettled([
    decideManual(s.ledger, s.client, input(p), identity),
    decideManual(s.ledger, s.client, input(p), identity),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(s.writes.length, 1);
});

test('manual CHOW creates zero-balance replacement and resumes one interrupted pointer update preserving source', async () => {
  const s = setup(),
    source = s.data.accounts.find((a) => a.account_id === '001U6RW32TY0WSXZZB'),
    before = clone(source),
    parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
  const p = await stage(s, 'accounts', source.account_id, {
    parent_id: parent.account_id,
    name: 'Reviewed Tiffin name',
  });
  assert.equal(p.type, 'chow');
  assert.equal(p.fields.lifetime_revenue, 0);
  assert.equal(p.fields.outstanding_ar, 0);
  assert.equal(s.writes.length, 0);
  s.failLink(true);
  await assert.rejects(
    decideManual(s.ledger, s.client, input(p), identity),
    /CHOW link not verified/
  );
  s.failLink(false);
  await decideManual(s.ledger, s.client, input(p, 'resume'), identity);
  assert.equal(s.writes.filter((w) => w.method === 'POST').length, 1);
  assert.deepEqual(
    businessAccount(source),
    businessAccount({ ...before, chow_current_account: source.chow_current_account })
  );
  assert.equal(
    s.data.accounts.find((a) => a.account_id === source.chow_current_account).name,
    'Reviewed Tiffin name'
  );
});

test('manual account create recovers a lost response by deterministic approved note marker', async () => {
  const s = setup(),
    p = await stage(s, 'accounts', undefined, {
      name: 'Reviewed New Facility',
      billing_street: '123 Example Rd',
      billing_city: 'Example',
      billing_state: 'OH',
    });
  s.loseAccountResponse(true);
  await decideManual(s.ledger, s.client, input(p), identity);
  assert.equal(s.writes.length, 1);
  assert.equal(p.fields.lifetime_revenue, 0);
  assert(p.fields.note.includes('[bellhaven-manual:'));
  assert.equal(
    (
      await stage(s, 'accounts', undefined, {
        name: 'Reviewed New Facility',
        billing_street: '123 Example Rd',
        billing_city: 'Example',
        billing_state: 'OH',
      })
    ).status,
    'applied'
  );
  assert.equal(s.writes.length, 1);
});

test('contact creation persists its returned ID before readback and resumes without a second POST', async () => {
  const s = setup(),
    p = await stage(s, 'contacts', undefined, {
      account_id: s.data.contacts[0].account_id,
      name: 'Review Contact',
      email: 'person@example.test',
    });
  s.failReadCreatedContact(true);
  await assert.rejects(decideManual(s.ledger, s.client, input(p), identity), /uncertain/);
  s.failReadCreatedContact(false);
  await decideManual(s.ledger, s.client, input(p, 'resume'), identity);
  assert.equal(s.writes.length, 1);
});

test('a lost contact creation response never retries or guesses an identity', async () => {
  const s = setup(),
    p = await stage(s, 'contacts', undefined, {
      account_id: s.data.contacts[0].account_id,
      name: 'Review Contact',
      email: 'person@example.test',
    });
  s.loseContactResponse(true);
  await assert.rejects(decideManual(s.ledger, s.client, input(p), identity), /uncertain/);
  s.loseContactResponse(false);
  await assert.rejects(
    decideManual(s.ledger, s.client, input(p, 'resume'), identity),
    /Matching record|uncertain/
  );
  assert.equal(s.writes.length, 1);
  assert(!Object.hasOwn(s.writes[0].fields, 'note'));
});

test('parent cycles and nonexistent contact targets cannot be staged', async () => {
  const s = setup(),
    account = s.data.accounts.find((a) => a.billing_street);
  await assert.rejects(
    stage(s, 'accounts', account.account_id, { parent_id: account.account_id }),
    /own parent/
  );
  await assert.rejects(
    stage(s, 'contacts', undefined, { account_id: 'missing', name: 'Review Contact' }),
    /does not exist/
  );
  assert.equal(s.writes.length, 0);
});

test('ordinary manual parent changes use one PATCH when only one billing condition is positive', async () => {
  const s = setup(),
    source = s.data.accounts.find((a) => a.account_id === '001U6RW32TY0WSXZZB'),
    parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)');
  source.outstanding_ar = 0;
  const p = await stage(s, 'accounts', source.account_id, { parent_id: parent.account_id });
  assert.equal(p.type, 'patch');
  await decideManual(s.ledger, s.client, input(p), identity);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].method, 'PATCH');
  assert.equal(source.lifetime_revenue, 84000);
  assert.equal(source.outstanding_ar, 0);
});

test('manual CHOW resume refuses a changed replacement or changed source billing without more writes', async () => {
  for (const changed of ['replacement', 'source']) {
    const s = setup(),
      source = s.data.accounts.find((a) => a.account_id === '001U6RW32TY0WSXZZB'),
      parent = s.data.accounts.find((a) => a.name === 'Bellhaven Senior Living (Parent Account)'),
      p = await stage(s, 'accounts', source.account_id, { parent_id: parent.account_id });
    s.failLink(true);
    await assert.rejects(
      decideManual(s.ledger, s.client, input(p), identity),
      /CHOW link not verified/
    );
    s.failLink(false);
    if (changed === 'source') source.outstanding_ar = 1;
    else
      s.data.accounts.find((a) => a.account_id.startsWith('manual-account')).lifetime_revenue = 10;
    const writes = s.writes.length;
    await assert.rejects(
      decideManual(s.ledger, s.client, input(p, 'resume'), identity),
      /changed|differs/
    );
    assert.equal(s.writes.length, writes);
  }
});

test('manual CHOW recovery refuses duplicate operation markers even with a checkpointed replacement ID', async (t) => {
  const s = setup();
  t.after(() => s.sqlite.close());
  const source = s.data.accounts.find((account) => account.name.includes('Tiffin') && Number(account.outstanding_ar) > 0);
  const parent = s.data.accounts.find((account) => account.name === 'Bellhaven Senior Living (Parent Account)');
  const p = await stage(s, 'accounts', source.account_id, { parent_id: parent.account_id });
  s.failLink(true);
  await assert.rejects(decideManual(s.ledger, s.client, input(p), identity), /CHOW link not verified/);
  s.failLink(false);
  const replacement = s.data.accounts.find((account) => (account.note ?? '').includes(p.marker));
  s.data.accounts.push({ ...clone(replacement), account_id: 'conflicting-marker-copy' });
  const before = s.writes.length;
  await assert.rejects(decideManual(s.ledger, s.client, input(p, 'resume'), identity), /Multiple operation markers/);
  assert.equal(s.writes.length, before, 'Ambiguous creation history must withhold the source link');
  assert(!source.chow_current_account);
  assert.equal((await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status, 'partial');
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) AS n FROM locks').get().n, 0);
  s.data.accounts = s.data.accounts.filter((account) => account.account_id !== 'conflicting-marker-copy');
  await decideManual(s.ledger, s.client, input(p, 'resume'), identity);
  assert.equal(source.chow_current_account, replacement.account_id);
  assert.equal(s.writes.filter((write) => write.method === 'POST').length, 1);
});

test('manual CHOW withholds the original link when the newly created replacement is already historical', async () => {
  for (const pointer of ['chow_current_account', 'duplicate_of_account']) {
    const s = setup();
    const source = s.data.accounts.find((a) => a.account_id === '001U6RW32TY0WSXZZB');
    const parent = s.data.accounts.find(
      (a) => a.name === 'Bellhaven Senior Living (Parent Account)'
    );
    const p = await stage(s, 'accounts', source.account_id, { parent_id: parent.account_id });
    const create = s.client.create;
    s.client.create = async (fields) => {
      const result = await create(fields);
      s.data.accounts.find((a) => a.account_id === result.data.account_id)[pointer] =
        'another-current-account';
      return result;
    };
    await assert.rejects(
      decideManual(s.ledger, s.client, input(p), identity),
      /Created record differs/
    );
    assert.equal(s.writes.length, 1);
    assert(!source.chow_current_account);
    assert.equal(
      (await s.ledger.one('SELECT status FROM proposals WHERE id=?', p.id)).status,
      'partial'
    );
  }
});

function manualPatchSubject(s, entity) {
  const record =
    entity === 'contacts'
      ? s.data.contacts[0]
      : s.data.accounts.find(
          (a) => a.billing_street && !a.chow_current_account && !a.duplicate_of_account
        );
  const idField = entity === 'contacts' ? 'contact_id' : 'account_id';
  const before = clone(record);
  return {
    id: record[idField],
    fields: { phone: '555-010-4242' },
    rollback() {
      s.data[entity] = s.data[entity].map((value) =>
        value[idField] === before[idField] ? clone(before) : value
      );
    },
    current() {
      return s.data[entity].find((value) => value[idField] === before[idField]);
    },
  };
}

test('explicit account and contact patch restaging after rollback creates one fresh review and preserves its rejection', async () => {
  for (const entity of ['accounts', 'contacts']) {
    const s = setup();
    const subject = manualPatchSubject(s, entity);
    const original = await stage(s, entity, subject.id, subject.fields);
    const originalData = (await s.ledger.one('SELECT data FROM proposals WHERE id=?', original.id))
      .data;
    await decideManual(s.ledger, s.client, input(original), identity);
    await assert.rejects(stage(s, entity, subject.id, subject.fields), /already match/);
    subject.rollback();
    const revision = await stage(s, entity, subject.id, subject.fields);
    assert.notEqual(revision.id, original.id);
    assert.equal(revision.evidence_version, original.version);
    assert.equal(revision.revision_of, original.id);
    assert.equal((await stage(s, entity, subject.id, subject.fields)).id, revision.id);
    assert.equal(revision.status, 'pending');
    await decideManual(
      s.ledger,
      s.client,
      input(revision, 'reject', 'Investigate external rollback before correcting again'),
      identity
    );
    const again = await stage(s, entity, subject.id, subject.fields);
    assert.equal(again.id, revision.id);
    assert.equal(again.status, 'rejected');
    assert.equal(s.writes.length, 1);
    assert.equal(
      (await s.ledger.one('SELECT status FROM proposals WHERE id=?', original.id)).status,
      'applied'
    );
    assert.equal(
      (await s.ledger.one('SELECT data FROM proposals WHERE id=?', original.id)).data,
      originalData
    );
  }
});

test('successive manual patch rollbacks receive independent approvals and operation checkpoints', async () => {
  for (const entity of ['accounts', 'contacts']) {
    const s = setup();
    const subject = manualPatchSubject(s, entity);
    let prior;
    const versions = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const p = await stage(s, entity, subject.id, subject.fields);
      if (prior) assert.equal(p.revision_of, prior.id);
      versions.push(p.id);
      await decideManual(s.ledger, s.client, input(p), identity);
      await s.ledger.run('UPDATE decisions SET created=?', '2026-10-10T00:00:00.000Z');
      await s.ledger.run(
        'UPDATE proposals SET created=? WHERE case_key=?',
        '2026-10-10T00:00:00.000Z',
        p.key
      );
      prior = p;
      if (cycle < 2) subject.rollback();
    }
    assert.equal(new Set(versions).size, 3);
    assert.equal(s.writes.length, 3);
    const operations = await s.ledger.all('SELECT id,proposal_id,status FROM operations');
    assert.equal(new Set(operations.map((op) => op.id)).size, 3);
    assert(operations.every((op) => versions.includes(op.proposal_id) && op.status === 'complete'));
  }
});

test('revised manual account and contact patches reject stale records before writing', async () => {
  for (const entity of ['accounts', 'contacts']) {
    const s = setup();
    const subject = manualPatchSubject(s, entity);
    const original = await stage(s, entity, subject.id, subject.fields);
    await decideManual(s.ledger, s.client, input(original), identity);
    subject.rollback();
    const revision = await stage(s, entity, subject.id, subject.fields);
    subject.current().phone = '555-010-9999';
    await assert.rejects(
      decideManual(s.ledger, s.client, input(revision), identity),
      /Record changed/
    );
    assert.equal(s.writes.length, 1);
    assert.equal(
      (await s.ledger.one('SELECT status FROM proposals WHERE id=?', revision.id)).status,
      'stale'
    );
  }
});

test('malformed stored manual proposals cannot drive approval or create CRM writes', async () => {
  for (const entity of ['accounts', 'contacts']) {
    const s = setup();
    const subject = manualPatchSubject(s, entity);
    const p = await stage(s, entity, subject.id, subject.fields);
    const malformed = clone(p);
    malformed.fields.phone = { unexpected: 'nested value' };
    malformed.options[0].operations[0].fields.phone = malformed.fields.phone;
    await s.ledger.run('UPDATE proposals SET data=? WHERE id=?', JSON.stringify(malformed), p.id);
    await assert.rejects(
      decideManual(s.ledger, s.client, input(p), identity),
      /Stored manual proposal is invalid/
    );
    assert.equal(s.writes.length, 0);
    assert.equal((await s.ledger.all('SELECT * FROM decisions')).length, 0);
    assert.equal((await s.ledger.all('SELECT * FROM locks')).length, 0);
  }
});

test('malformed manual recovery checkpoints stop before another CRM write', async () => {
  const s = setup();
  const subject = manualPatchSubject(s, 'contacts');
  const p = await stage(s, 'contacts', subject.id, subject.fields);
  await decideManual(s.ledger, s.client, input(p), identity);
  await s.ledger.run("UPDATE proposals SET status='partial' WHERE id=?", p.id);
  await s.ledger.run(
    'UPDATE operations SET data=? WHERE proposal_id=?',
    JSON.stringify({ recordId: { unexpected: 'object instead of ID' } }),
    p.id
  );
  await assert.rejects(
    decideManual(s.ledger, s.client, input(p, 'resume'), identity),
    /Stored operation checkpoint is invalid/
  );
  assert.equal(s.writes.length, 1);
  assert.equal((await s.ledger.all('SELECT * FROM decisions')).length, 1);
  assert.equal((await s.ledger.all('SELECT * FROM locks')).length, 0);
});
