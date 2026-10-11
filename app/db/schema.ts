import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  started: text('started').notNull(),
  finished: text('finished'),
  data: text('data').notNull(),
});
export const proposals = sqliteTable('proposals', {
  id: text('id').primaryKey(),
  caseKey: text('case_key').notNull(),
  version: text('version').notNull(),
  runId: text('run_id').notNull(),
  status: text('status').notNull(),
  data: text('data').notNull(),
  created: text('created').notNull(),
});
export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    proposalId: text('proposal_id').notNull(),
    action: text('action').notNull(),
    optionId: text('option_id'),
    actor: text('actor').notNull(),
    sessionId: text('session_id').notNull(),
    note: text('note').notNull(),
    created: text('created').notNull(),
  },
  (table) => [
    index('decisions_created_idx').on(table.created, table.id),
    index('decisions_proposal_created_idx').on(table.proposalId, table.created, table.id),
    index('decisions_proposal_action_created_idx').on(
      table.proposalId,
      table.action,
      table.created,
      table.id
    ),
  ]
);
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id').notNull(),
  step: integer('step').notNull(),
  status: text('status').notNull(),
  data: text('data').notNull(),
  updated: text('updated').notNull(),
});
export const audits = sqliteTable('audits', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id'),
  event: text('event').notNull(),
  data: text('data').notNull(),
  created: text('created').notNull(),
});
export const locks = sqliteTable('locks', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  started: text('started').notNull(),
});
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  csrf: text('csrf').notNull(),
  created: text('created').notNull(),
  lastRequest: integer('last_request').notNull().default(0),
});
export const fixtures = sqliteTable('fixtures', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
});
export const facilityRoutes = sqliteTable('facility_routes', {
  id: text('id').primaryKey(),
  sourceUrl: text('source_url').notNull(),
  canonicalAccountId: text('canonical_account_id'),
  status: text('status').notNull(),
  data: text('data').notNull(),
  updated: text('updated').notNull(),
});
