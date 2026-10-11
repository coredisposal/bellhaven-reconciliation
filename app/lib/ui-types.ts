/** Shapes returned by the review API. CRM field values remain lossless scalars. */
import type { DecisionAction, ProposalKind, ProposalStatus } from './domain-types';
export type FieldValue = string | number | boolean | null | undefined;
export type CrmFields = Record<string, FieldValue>;
export interface CrmRecord extends CrmFields {
  name: string;
  account_id?: string;
  contact_id?: string;
  title?: string;
  billing_street?: string;
  billing_city?: string;
  billing_state?: string;
  billing_zip?: string;
  parent_name?: string;
}
export interface Account extends CrmRecord {
  account_id: string;
  billing_street: string;
  billing_city: string;
  billing_state: string;
  billing_zip: string;
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
  retrieved_at_utc: string;
}
export interface Candidate {
  account: Account;
  contacts: CrmRecord[];
  reasons: string[];
  conflicts: string[];
}
export type Operation =
  | { type: 'create'; account_id?: never; before?: CrmRecord | null; fields: CrmFields }
  | { type: 'chow_link'; account_id: string; before: CrmRecord; fields: CrmFields & { chow_current_account: string }; dependencies: CrmRecord[] }
  | { type: 'patch' | 'chow' | 'duplicate'; account_id: string; before: CrmRecord; fields: CrmFields }
  | { type: 'update'; account_id?: string; before: CrmRecord; fields: CrmFields };
export interface ReviewOption {
  id: string;
  base_option_id?: string;
  field_choices?: {
    phone?: { current: string | null; proposed: string; selected: boolean };
    care_type?: { current: string | null; values: string[]; selected: string | null };
  };
  label: string;
  reason?: string;
  resolution?: 'separate' | 'existing';
  account_id?: string;
  operations: Operation[];
}
export interface Proposal {
  quality?: {
    category: string;
    title: string;
    detail: string;
    guidance: string;
    contacts: import('./domain-types').Contact[];
  };
  id: string;
  version: string;
  key: string;
  title: string;
  city: string;
  state: string;
  kind: ProposalKind | 'manual_account' | 'manual_contact';
  status: ProposalStatus;
  current?: boolean;
  summary: string;
  options: ReviewOption[];
  candidates: Candidate[];
  alternatives: Candidate[];
  facility: Facility | null;
  parent?: Account;
  manual?: boolean;
  relationship?: { type: 'chow' | 'duplicate'; target_id: string };
  entity?: string;
  before?: CrmRecord;
  fields?: CrmFields;
  note?: string;
  reviewer_note?: string;
  dependencies?: CrmRecord[];
  linked_accounts?: (Candidate & { route?: { current: string | null; reason: string; status: string } })[];
  matching_conflicts?: {
    kind: string;
    account_id: string;
    message: string;
    facilities?: Facility[];
  }[];
}
export interface Decision {
  id: string;
  proposal_id: string;
  action: DecisionAction;
  option_id: string | null;
  created: string;
  actor: string;
  note: string;
}
export interface RunCounts {
  accounts: number;
  contacts: number;
  facilities: number;
  new_proposals: number;
  open_proposals?: number;
}
export interface Run {
  id: string;
  status: 'running' | 'complete' | 'failed';
  started: string;
  finished: string;
  data: { counts?: RunCounts; coverage?: unknown; error?: string };
}
export interface DeskState {
  website?: WebsiteSnapshot | null;
  proposals: Proposal[];
  runs: Run[];
  decisions: Decision[];
  audits: unknown[];
  error?: string;
}
export interface WebsiteSnapshot {
  run_id: string;
  collected_at: string;
  coverage: { complete: boolean; expected: number | null; found: number };
  facilities: Facility[];
}
export interface ApiResult {
  error?: string;
  status?: ProposalStatus;
  new_proposals?: number;
  open_proposals?: number;
  id: string;
  csrf: string;
}
