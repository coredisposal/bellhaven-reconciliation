/** Domain contracts shared by matching, execution, and review presentation. */
export type BillingValue = number | string | null;
export type CareCategory = 'Skilled Nursing' | 'Assisted Living' | 'Memory Care' | 'Independent Living';
export type ProposalKind = 'unchanged' | 'field_correction' | 'parent_correction' | 'chow' | 'new_account' | 'duplicate' | 'ambiguous' | 'absent' | 'manual' | 'crm_quality';
export type ProposalStatus = 'pending' | 'partial' | 'applying' | 'stale' | 'unchanged' | 'superseded' | 'applied' | 'rejected';
export type DecisionAction = 'approve' | 'reject' | 'resume' | 'reopen';

/** Upstream evidence is deliberately nullable: missing billing is not zero. */
export interface Account {
  account_id: string;
  name: string;
  parent_id?: string | null;
  parent_name?: string | null;
  billing_street?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
  care_type?: string | null;
  status?: string | null;
  phone?: string | null;
  lifetime_revenue?: BillingValue;
  outstanding_ar?: BillingValue;
  chow_current_account?: string | null;
  duplicate_of_account?: string | null;
  note?: string | null;
  updated_at?: string | null;
  created_by_candidate?: boolean | null;
}

export interface Contact {
  contact_id: string;
  account_id: string;
  name: string;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  is_active?: boolean | null;
  updated_at?: string | null;
  created_by_candidate?: boolean | null;
}

/** Only fields accepted by the observed CRM write API. */
export interface AccountPatch {
  name?: string;
  parent_id?: string;
  billing_street?: string;
  billing_city?: string;
  billing_state?: string;
  billing_zip?: string;
  care_type?: string;
  status?: string;
  phone?: string;
  lifetime_revenue?: number;
  outstanding_ar?: number;
  chow_current_account?: string;
  duplicate_of_account?: string;
  note?: string;
}
export interface ContactPatch {
  account_id?: string;
  name?: string;
  title?: string;
  email?: string;
  phone?: string;
  is_active?: boolean;
}

export interface Facility {
  name: string;
  city: string;
  state: string;
  street_address: string;
  postal_code: string;
  phone_raw: string;
  care_offerings: string[];
  source_url: string;
  administrator?: string;
  retrieved_at_utc?: string;
  source_file?: string;
  directory_pages?: string[];
  linked_from_home?: boolean;
  html_hash?: string;
}
export interface Coverage {
  complete: boolean;
  expected: number | null;
  found: number;
  urls: string[];
  directory_pages?: string[];
  warning?: string | null;
}
export interface SourcePage {
  url: string;
  retrieved_at_utc: string;
  hash: string;
  html: string;
}
export interface Snapshot {
  accounts: Account[];
  contacts: Contact[];
  facilities: Facility[];
  coverage: Coverage;
  pages?: SourcePage[];
  retrieved_at?: string;
}

export interface AccountRoute {
  status: 'resolved' | 'conflict' | 'unresolved';
  current: string | null;
  reason: string;
  chain: Pick<Account, 'account_id' | 'name' | 'parent_name' | 'status' | 'lifetime_revenue' | 'outstanding_ar'>[];
}
export interface Candidate {
  account: Account;
  contacts: Contact[];
  reasons: string[];
  conflicts: string[];
  route?: AccountRoute;
}
export interface SignalCandidate extends Candidate {
  priority: number;
  address: boolean;
  locality: boolean;
  name: boolean;
  phone: boolean;
  administrator: boolean;
  poBox: boolean;
  eligible: boolean;
  identityConflict: boolean;
}

export type Operation =
  | { type: 'create'; fields: AccountPatch; before?: never; account_id?: never }
  | { type: 'chow'; account_id: string; before: Account; fields: AccountPatch }
  | { type: 'patch'; account_id: string; before: Account; fields: AccountPatch }
  | { type: 'duplicate'; account_id: string; before: Account; fields: AccountPatch };

export interface FieldChoices {
  phone?: { current: string | null; proposed: string; selected: boolean };
  care_type?: { current: string | null; values: string[]; selected: string | null };
}
export interface ProposalOption {
  id: string;
  label: string;
  reason?: string;
  resolution?: 'separate' | 'existing';
  account_id?: string;
  base_option_id?: string;
  field_choices?: FieldChoices;
  operations: Operation[];
}
export interface MatchingConflict {
  kind: 'address_conflict' | 'name_collision' | 'inactive_account' | 'shared_account';
  account_id: string;
  message: string;
  facilities?: Facility[];
}
export interface ProposalDraft {
  quality?: {
    category: 'account_overlap' | 'duplicate' | 'relationship' | 'billing' | 'shared_email' | 'retired_contact' | 'orphan_contact' | 'website_fields';
    title: string;
    detail: string;
    guidance: string;
    contacts: Contact[];
  };
  key: string;
  title: string;
  city?: string | null;
  state?: string | null;
  kind: ProposalKind;
  summary: string;
  facility: Facility | null;
  candidates: Candidate[];
  alternatives: Candidate[];
  linked_accounts?: (Candidate & { route: AccountRoute })[];
  link_conflicts?: (Candidate & { route: AccountRoute })[];
  matching_conflicts?: MatchingConflict[];
  options: ProposalOption[];
  parent: Account;
  coverage?: Pick<Coverage, 'urls' | 'expected' | 'found'>;
}
export interface Proposal extends ProposalDraft {
  id: string;
  version: string;
  compatibility_version?: string;
  material: unknown;
  status?: ProposalStatus;
  current?: boolean;
  evidence_version?: string;
  resolution_evidence_version?: string;
  revision_of?: string;
}
