import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectedOption,
  draftDestination,
  clearFinishedReview,
  reviewAccount,
  reviewOperation,
  resolutionOptions,
  selectFieldChoice,
  reviewAccountImpact,
  reviewOptionLabel,
  reviewOptionSummary,
  reviewEvidenceCaption,
  applyAcknowledgedDecision,
  historicalAccount,
} from '../lib/review-selection.mjs';

test('field controls preserve the other selection and only select offered server variants', () => {
  const options = [false, true].flatMap((phone) => [null, 'Assisted Living', 'Memory Care'].map((care) => ({
    id: `${phone}:${care}`, base_option_id: 'account',
    field_choices: {
      phone: { current: '111', proposed: '222', selected: phone },
      care_type: { current: 'Assisted Living', values: ['Assisted Living', 'Memory Care'], selected: care },
    }, operations: [],
  })));
  const proposal = { options };
  assert.equal(resolutionOptions(proposal).length, 1);
  const care = selectFieldChoice(proposal, 'false:null', 'care_type', 'Memory Care');
  assert.equal(care, 'false:Memory Care');
  const phone = selectFieldChoice(proposal, care, 'phone', true);
  assert.equal(phone, 'true:Memory Care');
  assert.equal(selectFieldChoice(proposal, phone, 'care_type', null), 'true:null');
  assert.equal(selectFieldChoice(proposal, phone, 'care_type', 'Unsupported'), phone);
  assert.equal(selectFieldChoice(proposal, phone, 'parent_id', 'arbitrary'), phone);
});

test('variant history displays the saved choice and duplicate-only survivor', () => {
  const option = { id: 'survivor:variant', base_option_id: 'survivor', operations: [
    { type: 'duplicate', account_id: 'loser', fields: { duplicate_of_account: 'survivor' } },
  ] };
  const proposal = { id: 'p', status: 'applied', options: [option], candidates: [
    { account: { account_id: 'loser' } }, { account: { account_id: 'survivor' } },
  ] };
  assert.equal(selectedOption(proposal, [{ proposal_id: 'p', action: 'approve', option_id: option.id, created: '2026-10-11' }], 'anything'), option.id);
  assert.equal(reviewAccount(proposal, option.id).account_id, 'survivor');
});

test('duplicate comparison names every account, its balances and exact destination for either route', () => {
  const survivor = { account_id: 'one', name: 'Erie', lifetime_revenue: 42000, outstanding_ar: 700 };
  const loser = { account_id: 'two', name: 'Erie copy', lifetime_revenue: 0, outstanding_ar: 0 };
  const proposal = { candidates: [{ account: survivor }, { account: loser }], options: [
    { id: 'one', operations: [{ type: 'duplicate', account_id: 'two', before: loser, fields: { duplicate_of_account: 'one', status: 'Inactive' } }] },
    { id: 'existing:one', account_id: 'one', operations: [{ type: 'patch', account_id: 'one', before: survivor, fields: { name: 'Erie' } }] },
  ] };
  assert.deepEqual(reviewAccountImpact(proposal, 'one'), [
    { account: survivor, action: 'Keep as survivor', link: null },
    { account: loser, action: 'Set Inactive', link: 'Erie · one' },
  ]);
  assert.deepEqual(reviewAccountImpact(proposal, 'existing:one').map((row) => row.action), ['Update this account', 'Keep unchanged']);
  assert(reviewAccountImpact(proposal, '').every((row) => row.action === 'Choose a resolution'));
  assert(reviewAccountImpact(proposal, 'reject').every((row) => row.action === 'Keep unchanged'));
});

test('historical CRM records stay read-only even while the original CHOW account remains Active', () => {
  const old = { account_id: 'old', status: 'Active', chow_current_account: 'current' };
  assert.deepEqual(historicalAccount(old), {
    target: 'current',
    description: 'Historical CHOW account · read-only. Its original billing history is preserved.',
  });
  assert.equal(
    historicalAccount({ account_id: 'old', duplicate_of_account: 'survivor' }).target,
    'survivor'
  );
  assert.equal(historicalAccount({ account_id: 'current', status: 'Active' }), null);
  assert.equal(historicalAccount(old, 'contacts'), null);
  assert.equal(historicalAccount(null), null);
});

test('account context includes conflicting identities, absence alternatives and preserved history without choosing them', () => {
  const candidate = { account: { account_id: 'current', name: 'Current account' } };
  const other = { account: { account_id: 'other', name: 'Other company' } };
  const historical = {
    account: { account_id: 'old', name: 'Historical', chow_current_account: 'current' },
    route: { status: 'resolved', current: 'current' },
  };
  const proposal = { kind: 'absent', candidates: [candidate], alternatives: [other], linked_accounts: [historical], options: [
    { id: 'review', operations: [{ type: 'patch', account_id: 'current', before: candidate.account, fields: { status: 'Needs Review' } }] },
  ] };
  assert.deepEqual(reviewAccountImpact(proposal, 'review').map(({ account, action, link }) => [account.account_id, action, link]), [
    ['current', 'Update this account', null], ['other', 'Keep unchanged', null], ['old', 'Preserve historical account', 'Current account · current'],
  ]);
  const conflict = { ...proposal, kind: 'ambiguous', candidates: [], linked_accounts: [], options: [] };
  assert.deepEqual(reviewAccountImpact(conflict, '').map((row) => row.action), ['No change available']);
  assert.equal(reviewAccount(conflict, ''), undefined);
  assert.equal(reviewAccount({ ...proposal, status: 'rejected' }, 'reject'), candidate.account);
});

test('history comparison only names a current account after a resolved route is verified', () => {
  const account = { account_id: 'old', name: 'Historical', chow_current_account: 'middle' };
  const proposal = { candidates: [], alternatives: [], options: [], linked_accounts: [{ account }] };
  const impact = (route, overrides = {}) => reviewAccountImpact({
    ...proposal, linked_accounts: [{ account, route }], ...overrides,
  }, '')[0];
  assert.equal(impact({ status: 'resolved', current: 'current' }).link,
    'Current account · current (via middle)');
  for (const route of [undefined,
    { status: 'conflict', current: null, reason: 'Account link points to a missing record.' },
    { status: 'conflict', current: null, reason: 'Account links form a cycle.' },
    { status: 'unresolved', current: null },
  ]) {
    assert.equal(impact(route).action, 'Preserve historical account');
    assert.equal(impact(route).link, 'Recorded history link · middle (needs verification)');
  }
  assert.equal(impact({ status: 'resolved', current: 'elsewhere' }, {
    link_conflicts: [{ account, conflicts: ['Linked account does not match this facility.'] }],
  }).link, 'Recorded history link · middle (needs verification)');
});

test('history comparison retains differing pointers and never resolves a self-reference', () => {
  for (const account of [
    { account_id: 'old', chow_current_account: 'one', duplicate_of_account: 'two' },
    { account_id: 'old', chow_current_account: 'old' },
  ]) {
    const proposal = { candidates: [], alternatives: [], options: [], linked_accounts: [{
      account, route: { status: 'resolved', current: 'one' },
    }] };
    const row = reviewAccountImpact(proposal, '')[0];
    assert.equal(row.action, 'Preserve historical account');
    assert.match(row.link, /needs verification/);
    assert(!row.link.startsWith('Current account'));
    if (account.duplicate_of_account)
      assert.equal(row.link, 'Recorded history link · CHOW one; duplicate two (needs verification)');
    else assert.equal(row.link, 'Recorded history link · old (needs verification)');
  }
});

test('conflicting, self-referencing or invalid history links offer no target action', () => {
  for (const record of [
    { account_id: 'old', chow_current_account: 'one', duplicate_of_account: 'two' },
    { account_id: 'old', chow_current_account: 'old' },
    { account_id: 'old', chow_current_account: 'https://example.com' },
  ])
    assert.equal(historicalAccount(record).target, null);
});
const p = {
  id: 'case',
  kind: 'ambiguous',
  status: 'pending',
  options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
};
const decisions = [
  { proposal_id: 'case', action: 'approve', option_id: 'c', created: '2026-10-10T20:00:00Z' },
];
test('ambiguous pending cases have no automatic choice', () =>
  assert.equal(selectedOption(p, decisions), ''));

test('leave unchanged is selectable but never replaces a saved approval', () => {
  assert.equal(selectedOption(p, [], 'reject'), 'reject');
  assert.equal(selectedOption({ ...p, status: 'applied' }, decisions, 'reject'), 'c');
  assert.equal(selectedOption({ ...p, status: 'rejected' }, [], 'a'), 'reject');
});

test('resolution summaries describe actual changes and duplicate consequences', () => {
  assert.match(reviewOptionSummary({ operations: [{ type: 'chow' }] }), /preserve the original/);
  assert.match(reviewOptionSummary({ operations: [{ type: 'create' }] }), /Existing accounts stay unchanged/);
  assert.match(reviewOptionSummary({ resolution: 'existing', operations: [{ type: 'patch' }] }), /Other accounts stay unchanged/);
  assert.match(reviewOptionSummary({ operations: [{ type: 'patch' }, { type: 'duplicate' }, { type: 'duplicate' }] }), /2 other copies Inactive/);
});

test('note-only and duplicate-only plans never promise highlighted field corrections', () => {
  const note = { type: 'patch', fields: { note: 'Care offerings: Assisted Living; Memory Support.' } };
  const duplicate = { type: 'duplicate', fields: { status: 'Inactive', duplicate_of_account: 'erie' } };
  const noteOnly = { resolution: 'existing', operations: [note] };
  assert.equal(reviewEvidenceCaption(noteOnly), 'CRM note only');
  assert.equal(reviewOptionSummary(noteOnly), 'Update this account’s CRM note. Other accounts stay unchanged.');
  assert.equal(reviewEvidenceCaption({ operations: [note, duplicate] }), 'CRM note + account actions');
  const cleanup = { label: 'Bellhaven of Owosso', operations: [duplicate] };
  assert.equal(reviewEvidenceCaption(cleanup), 'Account actions shown above');
  assert.equal(reviewOptionSummary(cleanup), 'Keep Bellhaven of Owosso active. Mark 1 other copy Inactive and link to this account.');
  const keep = { resolution: 'existing', field_choices: { care_type: { selected: null } }, operations: [] };
  assert.equal(reviewEvidenceCaption(keep), 'Keep current values · no CRM changes');
  assert.equal(reviewOptionSummary(keep), 'Save this reviewed choice without changing any CRM fields.');
});

test('selected optional fields determine the summary without implying a combined care category', () => {
  const base = { operations: [{ type: 'patch', fields: { parent_id: 'bellhaven', note: 'Complete website care list.' } }] };
  const selected = { operations: [{ type: 'patch', fields: { ...base.operations[0].fields, phone: '(555) 010-9999', care_type: 'Memory Care' } }] };
  assert.equal(reviewEvidenceCaption(base), 'Highlighted values will change');
  assert(!reviewOptionSummary(base).includes('phone'));
  assert(!reviewOptionSummary(base).includes('care category'));
  assert.match(reviewOptionSummary(selected), /parent, phone, and CRM note/);
  assert.match(reviewOptionSummary(selected), /care category to Memory Care/);
  assert(!reviewOptionSummary(selected).includes('Assisted Living'));
  assert.equal(reviewEvidenceCaption({ operations: [{ type: 'create', fields: {} }] }), 'Values for the new account');
  assert.equal(reviewEvidenceCaption({ operations: [{ type: 'chow', fields: {} }] }), 'Values for the new account');
  assert.equal(reviewEvidenceCaption(undefined), 'Evidence only · no changes selected');
  assert.match(reviewOptionSummary({ operations: [{ type: 'patch', fields: { billing_zip: '45662' } }] }), /ZIP/);
});
test('history and resumed decisions display the exact saved survivor', () => {
  for (const status of ['applied', 'partial', 'applying'])
    assert.equal(selectedOption({ ...p, status }, decisions, 'a'), 'c');
  assert.equal(selectedOption({ ...p, status: 'applied' }, [], 'a'), '');
});
test('repeated decided manual drafts open saved history instead of an unrelated pending case', () => {
  for (const status of ['applied', 'rejected'])
    assert.equal(draftDestination(status).view, 'history');
  for (const status of ['pending', 'stale', 'partial', 'applying'])
    assert.equal(draftDestination(status).view, 'queue');
  assert.match(draftDestination('rejected').message, /already rejected/);
  assert.match(draftDestination('partial').message, /unfinished work/);
});
test('a request finishing for the previous case preserves the newly selected case draft', () => {
  const next = {
    proposalId: 'next-version',
    note: 'Keep these accounts separate.',
    option: 'survivor-b',
  };
  assert.equal(clearFinishedReview(next, 'previous-version'), next);
  assert.deepEqual(clearFinishedReview(next, 'next-version'), {
    proposalId: '',
    option: '',
    note: '',
  });
});
test('billing and CRM preview never silently choose the first ambiguous or missing-history account', () => {
  const proposal = {
    ...p,
    candidates: [
      { account: { account_id: 'a', lifetime_revenue: 0 } },
      { account: { account_id: 'b', lifetime_revenue: 100 } },
    ],
  };
  assert.equal(reviewAccount(proposal, ''), undefined);
  assert.equal(reviewAccount(proposal, 'b').account_id, 'b');
  assert.equal(reviewAccount(proposal, 'unknown'), undefined);
  for (const status of ['applied', 'partial', 'applying'])
    assert.equal(reviewAccount({ ...proposal, kind: 'duplicate', status }, ''), undefined);
  const absent = {
    ...proposal, kind: 'absent',
    options: [{ id: 'review', operations: [{ type: 'patch', account_id: 'a', fields: { status: 'Needs Review' } }] }],
  };
  assert.equal(reviewAccount(absent, 'review').account_id, 'a');
});

test('identity resolutions preview the selected alternative or an independent new account', () => {
  const account = { account_id: 'existing', name: 'Manor', billing_city: 'Hudson', billing_state: 'OH', lifetime_revenue: 1800, outstanding_ar: 300 };
  const existing = {
    id: 'existing:existing', resolution: 'existing', account_id: account.account_id,
    label: 'Use Manor · Hudson, OH · existing',
    operations: [{ type: 'chow', account_id: account.account_id, before: account, fields: { parent_id: 'bellhaven', name: 'Manor' } }],
  };
  const separate = {
    id: 'separate', resolution: 'separate', label: 'Create a separate facility',
    operations: [{ type: 'create', fields: { parent_id: 'bellhaven', name: 'Manor' } }],
  };
  const proposal = { ...p, candidates: [], alternatives: [{ account }], options: [existing, separate] };
  assert.equal(selectedOption(proposal, []), '');
  assert.equal(reviewAccount(proposal, existing.id), account);
  assert.equal(reviewAccount(proposal, separate.id), undefined);
  assert.equal(reviewAccount(proposal, 'unknown'), undefined);
  assert.equal(reviewOptionLabel(proposal, existing), existing.label);
  assert.equal(reviewOptionLabel(proposal, separate), separate.label);
  assert.deepEqual(reviewOperation(existing), {
    fields: existing.operations[0].fields, isChow: true, isNewAccount: false, changesParent: false,
  });
  assert.deepEqual(reviewOperation(separate), {
    fields: separate.operations[0].fields, isChow: false, isNewAccount: true, changesParent: false,
  });
  assert.deepEqual(reviewOperation(undefined), { fields: {}, isChow: false, isNewAccount: false, changesParent: false });
  const direct = { ...existing, operations: [{ ...existing.operations[0], type: 'patch' }] };
  assert.equal(reviewOperation(direct).changesParent, true);
  assert.equal(reviewOperation(direct).isChow, false);
  assert.equal(reviewAccount({ ...proposal, alternatives: [], options: [direct] }, direct.id), account);
  const beforeOnly = { id: 'review', operations: [{ type: 'patch', before: account, fields: { status: 'Needs Review' } }] };
  assert.equal(reviewAccount({ ...proposal, alternatives: [], options: [beforeOnly] }, beforeOnly.id), account);
});

test('an unchanged sole match keeps its CRM values visible without inventing an approval choice', () => {
  const account = { account_id: 'unchanged', billing_street: '100 Main St', lifetime_revenue: 2400, outstanding_ar: 0 };
  const proposal = { ...p, kind: 'unchanged', status: 'unchanged', options: [], candidates: [{ account }], alternatives: [] };
  assert.equal(reviewAccount(proposal, ''), account);
  assert.equal(reviewAccount(proposal, 'unknown'), undefined);
  assert.equal(reviewAccount({ ...proposal, candidates: [] }, ''), undefined);
  assert.equal(reviewAccount({ ...proposal, candidates: [{ account }, { account: { account_id: 'other' } }] }, ''), undefined);
  assert.equal(reviewAccount({ ...proposal, kind: 'ambiguous' }, ''), undefined);
  for (const status of ['pending', 'applied', 'partial', 'applying', 'rejected'])
    assert.equal(reviewAccount({ ...proposal, status }, ''), undefined);
});

test('saved resolution history cannot switch to a different outcome or account', () => {
  const account = { account_id: 'existing', lifetime_revenue: 90, outstanding_ar: 0 };
  const options = [
    { id: 'same', resolution: 'existing', account_id: 'existing', operations: [{ type: 'patch', account_id: 'existing', before: account, fields: { parent_id: 'bellhaven' } }] },
    { id: 'separate', resolution: 'separate', operations: [{ type: 'create', fields: { name: 'Manor' } }] },
  ];
  for (const option of options) {
    const proposal = { ...p, status: 'applied', candidates: [], alternatives: [{ account }], options };
    const saved = [{ proposal_id: p.id, action: 'approve', option_id: option.id, created: '2026-10-11T03:00:00Z' }];
    const id = selectedOption(proposal, saved, option.id === 'same' ? 'separate' : 'same');
    assert.equal(id, option.id);
    assert.equal(reviewAccount(proposal, id), option.resolution === 'existing' ? account : undefined);
  }
});

test('older tied-survivor choices remain identifiable without defaulting to an account', () => {
  const account = { account_id: 'one', name: 'Manor', billing_city: 'Kettering', billing_state: 'OH' };
  const option = { id: 'one', label: 'Manor', operations: [] };
  const proposal = { ...p, candidates: [{ account }], alternatives: [], options: [option] };
  assert.equal(reviewOptionLabel(proposal, option), 'Manor · Kettering, OH · one');
  assert.equal(reviewAccount(proposal, ''), undefined);
});
test('acknowledged decisions leave the pending queue even when the subsequent ledger read fails', () => {
  const rows = [
    { id: 'chosen', status: 'pending' },
    { id: 'other', status: 'pending' },
  ];
  assert.deepEqual(applyAcknowledgedDecision(rows, 'chosen', 'applied'), [
    { id: 'chosen', status: 'applied' },
    { id: 'other', status: 'pending' },
  ]);
  assert.equal(applyAcknowledgedDecision(rows, 'chosen', undefined), rows);
  assert.equal(rows[0].status, 'pending');
});
