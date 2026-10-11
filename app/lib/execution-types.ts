import type { Account, AccountPatch, Contact, ContactPatch, DecisionAction, Facility, ProposalOption, ProposalStatus } from './domain-types';

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
export type SqlStatement = [sql: string, ...values: SqlValue[]];
export interface ProposalRow {
  id: string;
  case_key: string;
  version: string;
  status: ProposalStatus;
  data: string;
  created: string;
}
export interface PriorProposalRow extends Pick<ProposalRow, 'id' | 'case_key' | 'status' | 'created'> {
  evidence_version: string;
  resolution_evidence_version: string | null;
  approval_order: number;
  rejection_order: number;
}
export type CheckpointStatus = 'create_intent' | 'created' | 'link_intent' | 'patch_intent' | 'complete';
export interface OperationRow {
  id: string;
  proposal_id: string;
  step: number;
  status: CheckpointStatus;
  data: string;
}
export interface Checkpoint {
  replacement?: string;
  created?: Account;
  after?: Account;
  before?: Account;
  fields?: AccountPatch;
  marker?: string;
}
export interface DecisionInput {
  id: string;
  version: string;
  action: DecisionAction;
  optionId?: string;
  note?: string;
}
export interface ReviewerIdentity { actor: string; session: string }
/** Fields required to execute a persisted reconciliation proposal. Display-only
 * metadata is retained in the JSON object but never trusted for CRM writes. */
export interface ExecutionProposal {
  id: string;
  key: string;
  version: string;
  kind: string;
  evidence_version?: string;
  compatibility_version?: string;
  material?: unknown;
  parent: Account;
  facility: Facility | null;
  candidates: { account: Account }[];
  options: ProposalOption[];
}
export interface AccountClient {
  get(id: string): Promise<Account>;
  accounts(): Promise<Account[]>;
  create(fields: AccountPatch): Promise<{ account_id: string } | { data: { account_id: string } }>;
  patch(id: string, fields: AccountPatch): Promise<unknown>;
}
export interface CrmClient extends AccountClient {
  contacts(): Promise<Contact[]>;
  getContact(id: string): Promise<Contact>;
  createContact(fields: ContactPatch): Promise<{ contact_id: string } | { data: { contact_id: string } }>;
  patchContact(id: string, fields: ContactPatch): Promise<unknown>;
}
