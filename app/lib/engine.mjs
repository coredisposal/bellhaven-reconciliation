// @ts-check
/** @typedef {import('./ledger.mjs').Ledger} Ledger */
/** @typedef {import('./domain-types').Account} Account */
/** @typedef {import('./domain-types').AccountPatch} AccountPatch */
/** @typedef {import('./domain-types').Snapshot} Snapshot */
/** @typedef {import('./domain-types').Proposal} Proposal */
/** @typedef {import('./domain-types').ProposalOption} ProposalOption */
/** @typedef {import('./execution-types').ExecutionProposal} ExecutionProposal */
/** @typedef {import('./execution-types').Checkpoint} Checkpoint */
/** @typedef {import('./execution-types').DecisionInput} DecisionInput */
/** @typedef {import('./execution-types').ReviewerIdentity} ReviewerIdentity */
/** @typedef {import('./execution-types').SqlStatement} SqlStatement */
import {
  canonical,
  businessAccount,
  facilityMaterial,
  digest,
  needsChow,
  OPEN_PROPOSAL_STATUSES,
  evidenceMatches,
} from './core.mjs';
import { reconcile } from './reconciliation.mjs';
import { assertNoInterruptedOverlap } from './recovery-conflicts.mjs';
import { isRecord, isAccount, isFacility } from './contracts.mjs';
const now = () => new Date().toISOString();
/** @param {unknown} a @param {unknown} b */
const same = (a, b) => canonical(a) === canonical(b);
/** @param {Account} actual @param {AccountPatch} fields */
function appliedFields(actual, fields) {
  return Object.entries(fields).every(([k, v]) => same(Reflect.get(actual, k), v));
}
/** @param {unknown} error */
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

/** @param {Ledger} ledger @param {() => Promise<Snapshot>} getSnapshot */
export async function runPipeline(ledger, getSnapshot) {
  const id = crypto.randomUUID();
  await ledger.lock(id);
  try {
    await ledger.run(
      'INSERT INTO runs(id,status,started,data) VALUES(?,?,?,?)',
      id,
      'running',
      now(),
      '{}'
    );
    const snapshot = await getSnapshot();
    const proposals = await reconcile(snapshot, ledger.db);
    // Publish the replacement queue, completed run, and audit as one D1 transaction.
    // A failed publication must leave the last successful queue intact.
    /** @type {import('./execution-types').PriorProposalRow[]} */
    const prior = await ledger.all(`SELECT p.id,p.case_key,p.status,p.created,
      COALESCE(json_extract(p.data,'$.evidence_version'),p.version) AS evidence_version,
      json_extract(p.data,'$.resolution_evidence_version') AS resolution_evidence_version,
      COALESCE((SELECT MAX(d.rowid) FROM decisions d
        WHERE d.proposal_id=p.id AND d.action='approve'),0) AS approval_order,
      COALESCE((SELECT MAX(d.rowid) FROM decisions d
        WHERE d.proposal_id=p.id AND d.action='reject'),0) AS rejection_order
      FROM proposals p`);
    const priorById = new Map(prior.map((row) => [row.id, row]));
    const appliedEvidence = new Set();
    /** @type {Map<string, import('./execution-types').PriorProposalRow>} */
    const latestAppliedByKey = new Map();
    for (const row of prior.filter((row) => row.status === 'applied')) {
      appliedEvidence.add(canonical([row.case_key, row.evidence_version]));
      const latest = latestAppliedByKey.get(row.case_key);
      // Decision row order disambiguates approvals even when timestamps coincide.
      if (
        !latest ||
        row.approval_order > latest.approval_order ||
        (row.approval_order === latest.approval_order &&
          `${row.created}:${row.id}` > `${latest.created}:${latest.id}`)
      )
        latestAppliedByKey.set(row.case_key, row);
    }
    const interruptedKeys = new Set(
      prior.filter((row) => ['partial', 'applying'].includes(row.status)).map((row) => row.case_key)
    );
    /** @type {SqlStatement[]} */
    const publication = [
      [
        "UPDATE proposals SET status='superseded' WHERE status IN ('pending','unchanged') AND case_key NOT LIKE 'manual:%'",
      ],
    ];
    let added = 0;
    for (const evidence of proposals) {
      if (interruptedKeys.has(evidence.key)) continue;
      const resolved = latestAppliedByKey.get(evidence.key);
      if (resolved?.resolution_evidence_version && evidenceMatches(evidence, resolved.resolution_evidence_version)) {
        // The reviewer resolved this exact post-application evidence. Keep the
        // approved route visible instead of asking the same identity question
        // again. Any changed evidence falls through to normal fresh review.
        publication.push(['UPDATE proposals SET run_id=? WHERE id=?', id, resolved.id]);
        publication.push([
          "UPDATE proposals SET status='superseded' WHERE case_key=? AND status='stale' AND id<>?",
          evidence.key,
          resolved.id,
        ]);
        continue;
      }
      const rejected = prior.find((row) => row.case_key === evidence.key && row.status === 'rejected' &&
        row.rejection_order > (resolved?.approval_order ?? 0) && evidenceMatches(evidence, row.evidence_version));
      if (rejected) {
        publication.push(['UPDATE proposals SET run_id=? WHERE id=?', id, rejected.id]);
        continue;
      }
      /** @type {Proposal} */
      let p = { ...evidence, evidence_version: evidence.version };
      if (p.kind !== 'unchanged' && [p.evidence_version, p.compatibility_version]
        .filter(Boolean).some((version) => appliedEvidence.has(canonical([p.key, version])))) {
        // The CRM has returned to evidence that was already corrected. Preserve
        // that decision and its checkpoints; a fresh approval needs fresh IDs.
        const revisionOf = latestAppliedByKey.get(p.key)?.id;
        if (!revisionOf) throw new Error('Applied proposal history is incomplete.');
        const version = await digest({
          rule: 'reapplied-evidence-v1',
          evidence_version: p.evidence_version,
          after_applied_id: revisionOf,
        });
        p = { ...p, id: version, version, revision_of: revisionOf };
      }
      const existing = priorById.get(p.id);
      if (existing) {
        if (['superseded', 'pending', 'unchanged'].includes(existing.status))
          publication.push([
            'UPDATE proposals SET status=?,run_id=? WHERE id=?',
            p.kind === 'unchanged' ? 'unchanged' : 'pending',
            id,
            p.id,
          ]);
      } else {
        publication.push([
          'INSERT INTO proposals(id,case_key,version,run_id,status,data,created) VALUES(?,?,?,?,?,?,?)',
          p.id,
          p.key,
          p.version,
          id,
          p.kind === 'unchanged' ? 'unchanged' : 'pending',
          JSON.stringify(p),
          now(),
        ]);
        if (p.kind !== 'unchanged') added++;
      }
      // A replacement is now stored. Retain the old evidence/audit, but avoid
      // asking reviewers to reopen an invalid version beside its fresh case.
      publication.push([
        "UPDATE proposals SET status='superseded' WHERE case_key=? AND status='stale' AND id<>?",
        p.key,
        p.id,
      ]);
    }
    const data = {
      snapshot,
      counts: {
        accounts: snapshot.accounts.length,
        contacts: snapshot.contacts.length,
        facilities: snapshot.facilities.length,
        new_proposals: added,
        classifications: proposals.reduce((o, p) => ((o[p.kind] = (o[p.kind] ?? 0) + 1), o), /** @type {Record<string, number>} */ ({})),
      },
    };
    publication.push([
      `UPDATE runs SET status=?,finished=?,data=json_set(?, '$.counts.open_proposals',
        (SELECT COUNT(*) FROM proposals WHERE status IN (${OPEN_PROPOSAL_STATUSES.map(() => '?').join(',')}))) WHERE id=?`,
      'complete',
      now(),
      JSON.stringify(data),
      ...OPEN_PROPOSAL_STATUSES,
      id,
    ]);
    // Count the resulting queue inside the same transaction as publication.
    // The audit copies that saved count; later decisions cannot rewrite history.
    publication.push([
      `INSERT INTO audits(id,proposal_id,event,data,created)
       SELECT ?,NULL,'pipeline_complete',json_set(?, '$.open_proposals',
         json_extract(data,'$.counts.open_proposals')),? FROM runs WHERE id=?`,
      crypto.randomUUID(),
      JSON.stringify({ run_id: id, ...data.counts, coverage: snapshot.coverage }),
      now(),
      id,
    ]);
    publication.push(['SELECT data FROM runs WHERE id=?', id]);
    await ledger.fence(id);
    /** @type {D1Result<{data: string}>[]} */
    const committed = await ledger.batch(publication);
    const saved = committed.at(-1)?.results[0];
    if (!saved) throw new Error('Pipeline publication did not return its saved run.');
    const run = parseObject(saved.data, 'Pipeline run');
    if (!isRecord(run.counts) || typeof run.counts.open_proposals !== 'number')
      throw new Error('Pipeline publication returned invalid counts.');
    return { id, ...data.counts, open_proposals: run.counts.open_proposals, coverage: snapshot.coverage };
  } catch (error) {
    await ledger.run(
      'UPDATE runs SET status=?,finished=?,data=? WHERE id=?',
      'failed',
      now(),
      JSON.stringify({ error: errorMessage(error) }),
      id
    );
    throw error;
  } finally {
    await ledger.unlock(id);
  }
}
/** @param {Ledger} ledger @param {import('./execution-types').AccountClient} client @param {() => Promise<Snapshot>} getSnapshot @param {DecisionInput} input @param {ReviewerIdentity} identity */
export async function decide(ledger, client, getSnapshot, input, identity) {
  const { id, version, action, optionId, note } = input;
  const lock = crypto.randomUUID();
  await ledger.lock(lock);
  try {
    /** @type {import('./execution-types').ProposalRow | null} */
    const row = await ledger.one('SELECT * FROM proposals WHERE id=?', id);
    if (!row || row.version !== version)
      throw new Error('This proposal version is no longer available. Refresh the queue.');
    const p = parseProposal(row.data);
    if (p.id !== row.id || p.version !== row.version)
      throw new Error('Stored proposal identity does not match its ledger version. Operator review is required.');
    if (action === 'reopen') {
      if (!['rejected', 'stale'].includes(row.status))
        throw new Error('Only rejected or stale cases can be reopened.');
      if (!note?.trim()) throw new Error('Explain why the decision is being reopened.');
      await ledger.batch([
        decisionStatement(input, identity),
        ["UPDATE proposals SET status='pending' WHERE id=?", id],
        ledger.auditStatement('case_reopened', { note, actor: identity.actor }, id),
      ]);
      return { status: 'pending' };
    }
    if (action === 'reject') {
      if (row.status !== 'pending') throw new Error('This case has already been decided.');
      if (!note?.trim()) throw new Error('Give a reason for rejecting the proposal.');
      await ledger.batch([
        decisionStatement(input, identity),
        ["UPDATE proposals SET status='rejected' WHERE id=?", id],
        ledger.auditStatement('proposal_rejected', { note, actor: identity.actor }, id),
      ]);
      return { status: 'rejected' };
    }
    if (action !== 'approve' && action !== 'resume') throw new Error('Unsupported decision');
    let option;
    if (action === 'resume') {
      if (!['partial', 'applying'].includes(row.status))
        throw new Error('Only interrupted approved operations can resume.');
      /** @type {{option_id: string} | null} */
      const approval = await ledger.one(
        "SELECT * FROM decisions WHERE proposal_id=? AND action='approve' ORDER BY created DESC LIMIT 1",
        id
      );
      if (!approval) throw new Error('No persisted approval to resume.');
      option = p.options.find((o) => o.id === approval.option_id);
      if (!option) throw new Error('Stored approval refers to a missing option');
      await assertNoInterruptedOverlap(ledger, p, option);
      const currentSnapshot = await getSnapshot();
      const source = currentSnapshot.facilities.find(
        (f) => f.source_url === p.facility?.source_url
      );
      if (p.facility && (!source || !same(facilityMaterial(source), facilityMaterial(p.facility))))
        throw new Error(
          'Website evidence changed during interrupted work. Operator review is required before resuming.'
        );
      if (!p.facility && !currentSnapshot.coverage.complete)
        throw new Error('Cannot resume an absence decision without complete source coverage.');
      try {
        await validateResume(ledger, p, option, currentSnapshot);
      } catch (error) {
        await ledger.audit('resume_withheld', { actor: identity.actor, reason: errorMessage(error) }, id);
        throw error;
      }
      await ledger.audit('application_resumed', { actor: identity.actor }, id);
    } else {
      if (row.status !== 'pending') throw new Error('This case has already been decided.');
      option = p.options.find((o) => o.id === optionId);
      if (!option || (!option.operations.length && !option.field_choices))
        throw new Error('Select an available server-stored operation.');
      if ((p.kind === 'ambiguous' || p.kind === 'crm_quality' || option.resolution) && !note?.trim())
        throw new Error('Explain your resolution choice before approval.');
      await assertNoInterruptedOverlap(ledger, p, option);
      const snapshot = await getSnapshot();
      const fresh = (await reconcile(snapshot, ledger.db)).find((x) => x.key === p.key);
      if (!evidenceMatches(fresh, p.evidence_version ?? p.version) ||
          !fresh || !(await sameApprovedOption(p, option, fresh))) {
        await ledger.run("UPDATE proposals SET status='stale' WHERE id=?", id);
        await ledger.audit(
          'proposal_invalidated',
          {
            reason:
              'Website, candidate accounts, contacts, billing conditions or proposed operations changed.',
          },
          id
        );
        throw new Error(
          'Evidence changed. This proposal is stale; run the pipeline and review the fresh version.'
        );
      }
      await ledger.batch([
        decisionStatement(input, identity),
        ["UPDATE proposals SET status='applying' WHERE id=?", id],
        ledger.auditStatement(
          'proposal_approved',
          { actor: identity.actor, session: identity.session, option: optionId, note, version },
          id
        ),
      ]);
    }
    if (!option) throw new Error('Stored approval refers to a missing option');
    if (action === 'resume')
      await ledger.run("UPDATE proposals SET status='applying' WHERE id=?", id);
    try {
      /** @type {string | undefined} */
      let replacement;
      const verifiedAccounts = new Map(p.candidates.map((c) => [c.account.account_id, c.account]));
      for (let i = 0; i < option.operations.length; i++) {
        await ledger.fence(lock);
        const op = option.operations[i],
          operationId = await digest({ proposal: id, option: option.id, step: i });
        /** @type {import('./execution-types').OperationRow | null} */
        const saved = await ledger.one('SELECT * FROM operations WHERE id=?', operationId);
        const checkpoint = saved ? parseCheckpoint(saved.data) : {};
        if (saved?.status === 'complete') {
          if (checkpoint.replacement) replacement = checkpoint.replacement;
          if (checkpoint.after) verifiedAccounts.set(checkpoint.after.account_id, checkpoint.after);
          if (checkpoint.created)
            verifiedAccounts.set(checkpoint.created.account_id, checkpoint.created);
          continue;
        }
        const fields = { ...op.fields };
        if (fields.duplicate_of_account === '$replacement') {
          if (!replacement) throw new Error('CHOW replacement missing');
          fields.duplicate_of_account = replacement;
        }
        /** @param {import('./execution-types').CheckpointStatus} status @param {Checkpoint} data */
        const save = (status, data) =>
          ledger.checkpoint(operationId, id, i, status, { ...checkpoint, ...data });
        if (op.type === 'create' || op.type === 'chow') {
          let current;
          if (op.type === 'chow') {
            current = await client.get(op.account_id);
            const expected = {
              ...op.before,
              ...(checkpoint.replacement && current.chow_current_account === checkpoint.replacement
                ? { chow_current_account: checkpoint.replacement }
                : {}),
            };
            if (!same(businessAccount(current), businessAccount(expected)))
              throw new Error(
                'CHOW source changed after approval. Preserve the old account and request fresh review.'
              );
            if (!needsChow(op.before, p.parent.account_id))
              throw new Error('CHOW billing condition is no longer valid');
          }
          const marker = `[bellhaven-op:${operationId}]`;
          const createFields = {
            ...fields,
            note: [fields.note, marker].filter(Boolean).join('\n'),
          };
          let target = checkpoint.replacement ? await client.get(checkpoint.replacement) : null;
          if (!target) {
            const matches = (await client.accounts()).filter((a) =>
              (a.note ?? '').includes(marker)
            );
            if (matches.length > 1)
              throw new Error('Multiple operation markers found. Manual recovery required.');
            target = matches[0];
            if (!target && saved)
              throw new Error(
                'Creation outcome is uncertain. No matching marker is visible. The operation will not retry creation; use documented operator recovery.'
              );
            if (!target) {
              await save('create_intent', { marker, fields: createFields });
              await ledger.fence(lock);
              // Never retry POST. On any uncertain response, reconcile the marker using read-only GETs.
              try {
                const created = await client.create(createFields);
                const a = 'data' in created ? created.data : created;
                if (a.account_id) target = await client.get(a.account_id);
              } catch {
                /* readback below owns recovery */
              }
              if (!target) {
                const found = (await client.accounts()).filter((a) =>
                  (a.note ?? '').includes(marker)
                );
                if (found.length === 1) target = found[0];
              }
              if (!target)
                throw new Error(
                  'Creation outcome uncertain. It will not be retried automatically.'
                );
            }
          }
          if (
            !appliedFields(target, createFields) ||
            target.chow_current_account ||
            target.duplicate_of_account ||
            (checkpoint.created &&
              !same(businessAccount(target), businessAccount(checkpoint.created)))
          )
            throw new Error(
              'Created-account readback differs from approved fields. Manual recovery required.'
            );
          replacement = target.account_id;
          await save('created', { replacement, created: target, marker });
          if (op.type === 'chow') {
            current = await client.get(op.account_id);
            if (current.chow_current_account !== replacement) {
              if (!same(businessAccount(current), businessAccount(op.before)))
                throw new Error('Old CHOW account changed before linking; replacement preserved.');
              await save('link_intent', { replacement, created: target, marker });
              await ledger.fence(lock);
              try {
                await client.patch(op.account_id, { chow_current_account: replacement });
              } catch {
                /* idempotent readback */
              }
              current = await client.get(op.account_id);
            }
            if (
              !same(
                businessAccount(current),
                businessAccount({ ...op.before, chow_current_account: replacement })
              )
            )
              throw new Error('CHOW link not verified. Resume uses the existing replacement.');
          }
          await ledger.verified(
            operationId,
            id,
            i,
            { ...checkpoint, replacement, created: target, after: current ?? target, marker },
            {
              operation_id: operationId,
              type: op.type,
              before: op.before ?? null,
              after: current ?? target,
              replacement: target,
            }
          );
          verifiedAccounts.set(target.account_id, target);
          if (current) verifiedAccounts.set(current.account_id, current);
        } else {
          let current = await client.get(op.account_id);
          const expected = { ...op.before, ...fields };
          if (op.type === 'duplicate') {
            if (!fields.duplicate_of_account) throw new Error('Duplicate operation has no survivor.');
            const survivor = await client.get(fields.duplicate_of_account),
              verified = verifiedAccounts.get(fields.duplicate_of_account);
            if (!verified || !same(businessAccount(survivor), businessAccount(verified)))
              throw new Error(
                'Surviving account changed after approval; duplicate retirement withheld.'
              );
          }
          if (!same(businessAccount(current), businessAccount(expected))) {
            if (!same(businessAccount(current), businessAccount(op.before)))
              throw new Error('Account changed after approval; patch withheld.');
            await save('patch_intent', { before: op.before, fields });
            await ledger.fence(lock);
            try {
              await client.patch(op.account_id, fields);
            } catch {
              /* safe readback */
            }
            current = await client.get(op.account_id);
          }
          if (!same(businessAccount(current), businessAccount(expected)))
            throw new Error('Patch not verified. Resume will re-read before any retry.');
          await ledger.verified(
            operationId,
            id,
            i,
            { ...checkpoint, before: op.before, fields, after: current },
            { operation_id: operationId, type: op.type, before: op.before, after: current }
          );
          verifiedAccounts.set(current.account_id, current);
        }
      }
      const verifiedSnapshot = await getSnapshot();
      await validateResume(ledger, p, option, verifiedSnapshot);
      if (option.resolution === 'separate' || option.resolution === 'existing' || option.field_choices) {
        const resolved = (await reconcile(verifiedSnapshot, ledger.db)).find((row) => row.key === p.key);
        if (!resolved && p.kind !== 'crm_quality') throw new Error('Resolved location is missing from verified evidence.');
        await ledger.fence(lock);
        await ledger.batch([
          [
            "UPDATE proposals SET status='applied',data=? WHERE id=?",
            JSON.stringify({ ...p, ...(resolved ? { resolution_evidence_version: resolved.version } : {}) }),
            id,
          ],
          ledger.auditStatement(option.resolution ? 'identity_resolution_verified' : 'field_selection_verified', {
            option: option.id,
            resolution: option.resolution,
            ...(option.field_choices ? { field_choices: option.field_choices } : {}),
            evidence_version: resolved?.version ?? null,
          }, id),
        ]);
      } else await ledger.run("UPDATE proposals SET status='applied' WHERE id=?", id);
      return { status: 'applied' };
    } catch (error) {
      await ledger.run("UPDATE proposals SET status='partial' WHERE id=?", id);
      await ledger.audit('application_interrupted', { error: errorMessage(error) }, id);
      throw error;
    }
  } finally {
    await ledger.unlock(lock);
  }
}
/** Bind executable stored fields to the freshly reconstructed proposal, not
 * just its claimed version. Capture timestamps do not change business evidence.
 * Legacy options can match an equivalent field variant from their base option;
 * this preserves the exact old approval without adding new selected fields.
 * @param {ExecutionProposal} proposal @param {ProposalOption} selected @param {Proposal} fresh
 */
async function sameApprovedOption(proposal, selected, fresh) {
  const evidenceVersion = proposal.evidence_version ?? proposal.version;
  const legacy = evidenceVersion === fresh.compatibility_version && !selected.field_choices;
  if (legacy) {
    // The compatibility digest binds old approvals to their original operation
    // fields. Matching any new variant alone could add a newly offered choice.
    const material = proposal.material;
    if (!isRecord(material) || await digest(material) !== evidenceVersion ||
        !Array.isArray(material.options)) return false;
    const original = material.options.find((value) => isRecord(value) && value.id === selected.id);
    if (!isRecord(original) || !same(original, {
      id: selected.id,
      ...(selected.resolution ? { resolution: selected.resolution, account_id: selected.account_id } : {}),
      operations: selected.operations.map(({ before, ...operation }) => operation),
    })) return false;
  }
  /** @param {ProposalOption} option */
  const executable = (option) => ({
    resolution: option.resolution,
    account_id: option.account_id,
    operations: option.operations.map((operation) => ({
      type: operation.type,
      account_id: operation.account_id,
      fields: operation.fields,
      before: operation.before ? businessAccount(operation.before) : undefined,
    })),
  });
  return fresh.options.some((option) =>
    (option.id === selected.id || (legacy && option.base_option_id === selected.id)) &&
    same(executable(option), executable(selected)) &&
    (legacy || same(option.field_choices, selected.field_choices)));
}
/** @param {DecisionInput} input @param {ReviewerIdentity} identity @returns {SqlStatement} */
function decisionStatement(input, identity) {
  return [
    'INSERT INTO decisions(id,proposal_id,action,option_id,actor,session_id,note,created) VALUES(?,?,?,?,?,?,?,?)',
    crypto.randomUUID(),
    input.id,
    input.action,
    input.optionId ?? null,
    identity.actor,
    identity.session,
    input.note ?? '',
    now(),
  ];
}

// Rewind only verified effects of this approval in an in-memory snapshot, then
// re-run the original evidence check. This permits recovery without accepting
// unrelated edits to a survivor, completed target, contact, or website listing.
/** @param {Ledger} ledger @param {ExecutionProposal} p @param {ProposalOption} option @param {Snapshot} snapshot */
async function validateResume(ledger, p, option, snapshot) {
  const beforeSnapshot = structuredClone(snapshot);
  /** @type {string | undefined} */
  let replacement;
  /** @param {Account | null | undefined} actual @param {Account | null | undefined} expected */
  const accountSame = (actual, expected) =>
    actual && expected && same(businessAccount(actual), businessAccount(expected));
  for (let i = 0; i < option.operations.length; i++) {
    const op = option.operations[i],
      operationId = await digest({ proposal: p.id, option: option.id, step: i });
    /** @type {import('./execution-types').OperationRow | null} */
    const saved = await ledger.one('SELECT * FROM operations WHERE id=?', operationId);
    const checkpoint = saved ? parseCheckpoint(saved.data) : {};
    const fields = { ...op.fields };
    if (fields.duplicate_of_account === '$replacement') {
      if (!replacement)
        throw new Error(
          'Approved replacement cannot be verified. Operator review is required before resuming.'
        );
      fields.duplicate_of_account = replacement;
    }
    if (op.type === 'create' || op.type === 'chow') {
      const marker = `[bellhaven-op:${operationId}]`;
      const matches = snapshot.accounts.filter((a) => (a.note ?? '').includes(marker));
      if (matches.length > 1)
        throw new Error('Multiple operation markers found. Manual recovery required.');
      const target = checkpoint.replacement
        ? snapshot.accounts.find((a) => a.account_id === checkpoint.replacement)
        : matches[0];
      if (checkpoint.replacement && !target)
        throw new Error(
          'Approved replacement is missing. Operator review is required before resuming.'
        );
      if (target) {
        const approvedFields = {
          ...fields,
          note: [fields.note, marker].filter(Boolean).join('\n'),
        };
        if (
          !saved ||
          !appliedFields(target, approvedFields) ||
          target.chow_current_account ||
          target.duplicate_of_account ||
          (checkpoint.created && !accountSame(target, checkpoint.created))
        )
          throw new Error(
            'Created account changed after approval. Operator review is required before resuming.'
          );
        if (snapshot.contacts.some((c) => c.account_id === target.account_id))
          throw new Error(
            'Contacts were added to the replacement during interrupted work. Review before resuming.'
          );
        replacement = target.account_id;
        beforeSnapshot.accounts = beforeSnapshot.accounts.filter(
          (a) => a.account_id !== target.account_id
        );
      }
      if (op.type === 'chow') {
        const current = snapshot.accounts.find((a) => a.account_id === op.account_id);
        const linked = replacement ? { ...op.before, chow_current_account: replacement } : null;
        const valid =
          saved?.status === 'complete'
            ? accountSame(current, linked)
            : accountSame(current, op.before) || (saved && accountSame(current, linked));
        if (!valid)
          throw new Error(
            'CHOW source changed after approval. Operator review is required before resuming.'
          );
        beforeSnapshot.accounts = beforeSnapshot.accounts.map((a) =>
          a.account_id === op.account_id ? structuredClone(op.before) : a
        );
      }
    } else {
      const current = snapshot.accounts.find((a) => a.account_id === op.account_id),
        expected = { ...op.before, ...fields };
      const valid =
        saved?.status === 'complete'
          ? accountSame(current, expected)
          : accountSame(current, op.before) || (saved && accountSame(current, expected));
      if (!valid)
        throw new Error(
          'Affected account changed after approval. Operator review is required before resuming.'
        );
      beforeSnapshot.accounts = beforeSnapshot.accounts.map((a) =>
        a.account_id === op.account_id ? structuredClone(op.before) : a
      );
    }
  }
  const original = (await reconcile(beforeSnapshot, ledger.db)).find((row) => row.key === p.key);
  if (!evidenceMatches(original, p.evidence_version ?? p.version) ||
      !original || !(await sameApprovedOption(p, option, original)))
    throw new Error(
      'Decision evidence changed during interrupted work. Operator review is required before resuming.'
    );
}

/** Decode stored JSON as unknown before trusting any approval or checkpoint. */
/** @param {string} json @param {string} label @returns {Record<string, unknown>} */
function parseObject(json, label) {
  /** @type {unknown} */
  const value = JSON.parse(json);
  if (!isRecord(value)) throw new Error(`${label} is not a saved object.`);
  return value;
}

/** @param {unknown} value @returns {value is AccountPatch} */
function isAccountPatch(value) {
  if (!isRecord(value)) return false;
  const textFields = ['name', 'parent_id', 'billing_street', 'billing_city', 'billing_state',
    'billing_zip', 'care_type', 'status', 'phone', 'chow_current_account',
    'duplicate_of_account', 'note'];
  return Object.entries(value).every(([key, field]) =>
    textFields.includes(key) ? typeof field === 'string' :
      ['lifetime_revenue', 'outstanding_ar'].includes(key) && typeof field === 'number' && Number.isFinite(field));
}

/** @param {unknown} value @returns {value is import('./domain-types').Operation} */
function isOperation(value) {
  if (!isRecord(value) || !isAccountPatch(value.fields)) return false;
  if (value.type === 'create') return value.before === undefined && value.account_id === undefined;
  return ['chow', 'patch', 'duplicate'].includes(String(value.type)) &&
    typeof value.account_id === 'string' && !!value.account_id && isAccount(value.before) &&
    value.before.account_id === value.account_id &&
    (value.type !== 'duplicate' || typeof value.fields.duplicate_of_account === 'string');
}

/** @param {unknown} value @returns {value is import('./domain-types').FieldChoices} */
function isFieldChoices(value) {
  if (!isRecord(value)) return false;
  const phone = value.phone, care = value.care_type;
  return (phone === undefined || (isRecord(phone) &&
    (phone.current === null || typeof phone.current === 'string') &&
    typeof phone.proposed === 'string' && typeof phone.selected === 'boolean')) &&
    (care === undefined || (isRecord(care) &&
      (care.current === null || typeof care.current === 'string') &&
      (care.selected === null || typeof care.selected === 'string') &&
      Array.isArray(care.values) && care.values.every((item) => typeof item === 'string')));
}

/** @param {unknown} value @returns {value is ProposalOption} */
function isOption(value) {
  return isRecord(value) && typeof value.id === 'string' && !!value.id && typeof value.label === 'string' &&
    ['reason', 'account_id', 'base_option_id'].every((key) => value[key] === undefined || typeof value[key] === 'string') &&
    Array.isArray(value.operations) && value.operations.every(isOperation) &&
    (value.resolution === undefined || value.resolution === 'separate' || value.resolution === 'existing') &&
    (value.field_choices === undefined || isFieldChoices(value.field_choices));
}

/** @param {unknown} value @returns {value is ExecutionProposal} */
function isExecutionProposal(value) {
  return isRecord(value) && ['id', 'key', 'version', 'kind'].every((key) => typeof value[key] === 'string' && !!value[key]) &&
    ['evidence_version', 'compatibility_version'].every((key) => value[key] === undefined || (typeof value[key] === 'string' && !!value[key])) &&
    isAccount(value.parent) && (value.facility === null || isFacility(value.facility)) &&
    Array.isArray(value.candidates) && value.candidates.every((candidate) => isRecord(candidate) && isAccount(candidate.account)) &&
    Array.isArray(value.options) && value.options.every(isOption) &&
    new Set(value.options.map((option) => option.id)).size === value.options.length;
}

/** @param {string} json @returns {ExecutionProposal} */
function parseProposal(json) {
  const value = parseObject(json, 'Proposal');
  if (!isExecutionProposal(value)) throw new Error('Stored proposal is invalid. Run the pipeline and review a fresh version.');
  return value;
}

/** @param {unknown} value @returns {value is Checkpoint} */
function isCheckpoint(value) {
  return isRecord(value) &&
    ['replacement', 'marker'].every((key) => value[key] === undefined || (typeof value[key] === 'string' && !!value[key])) &&
    ['created', 'after', 'before'].every((key) => value[key] === undefined || isAccount(value[key])) &&
    (value.fields === undefined || isAccountPatch(value.fields));
}

/** @param {string} json @returns {Checkpoint} */
function parseCheckpoint(json) {
  const value = parseObject(json, 'Operation checkpoint');
  if (!isCheckpoint(value)) throw new Error('Stored operation checkpoint is invalid. Operator recovery is required.');
  return value;
}
