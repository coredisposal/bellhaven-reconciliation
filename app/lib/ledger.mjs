// @ts-check
/** @typedef {import('./execution-types').SqlValue} SqlValue */
/** @typedef {import('./execution-types').SqlStatement} SqlStatement */

export class Ledger {
  /** @param {D1Database} db */
  constructor(db) {
    this.db = db;
  }
  /** @template [T=Record<string, unknown>] @param {string} sql @param {...SqlValue} args @returns {Promise<T | null>} */
  async one(sql, ...args) {
    return this.db
      .prepare(sql)
      .bind(...args)
      .first();
  }
  /** @template [T=Record<string, unknown>] @param {string} sql @param {...SqlValue} args @returns {Promise<T[]>} */
  async all(sql, ...args) {
    /** @type {D1Result<T>} */
    const result = await this.db.prepare(sql).bind(...args).all();
    return result.results;
  }
  /** @param {string} sql @param {...SqlValue} args */
  async run(sql, ...args) {
    return this.db
      .prepare(sql)
      .bind(...args)
      .run();
  }
  // D1 batch is transactional: local state and its audit either commit together
  // or both roll back. Never mix a CRM network write into this transaction.
  /** @template [T=Record<string, unknown>] @param {SqlStatement[]} statements @returns {Promise<D1Result<T>[]>} */
  async batch(statements) {
    return this.db.batch(statements.map(([sql, ...args]) => this.db.prepare(sql).bind(...args)));
  }
  /** @param {string} event @param {unknown} data @param {string | null} [proposalId] @returns {SqlStatement} */
  auditStatement(event, data, proposalId = null) {
    return [
      'INSERT INTO audits(id,proposal_id,event,data,created) VALUES(?,?,?,?,?)',
      crypto.randomUUID(),
      proposalId,
      event,
      JSON.stringify(data),
      new Date().toISOString(),
    ];
  }
  /** @param {string} event @param {unknown} data @param {string | null} [proposalId] */
  async audit(event, data, proposalId = null) {
    await this.run(
      'INSERT INTO audits(id,proposal_id,event,data,created) VALUES(?,?,?,?,?)',
      crypto.randomUUID(),
      proposalId,
      event,
      JSON.stringify(data),
      new Date().toISOString()
    );
  }
  /** @param {string} owner */
  async lock(owner) {
    const r = await this.run(
      'INSERT OR IGNORE INTO locks(id,owner,started) VALUES(?,?,?)',
      'global',
      owner,
      new Date().toISOString()
    );
    if (!r.meta.changes)
      throw new Error(
        'Another pipeline or application is running. A crashed lock requires the documented operator recovery.'
      );
  }
  /** @param {string} owner */
  async unlock(owner) {
    await this.run('DELETE FROM locks WHERE id=? AND owner=?', 'global', owner);
  }
  /** @param {string} owner */
  async fence(owner) {
    if (!(await this.one('SELECT owner FROM locks WHERE id=? AND owner=?', 'global', owner)))
      throw new Error('Operation lock lost; stopping.');
  }
  /** @param {string} id @param {string} proposalId @param {number} step @param {string} status @param {unknown} data */
  async checkpoint(id, proposalId, step, status, data) {
    await this.run(
      'INSERT INTO operations(id,proposal_id,step,status,data,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated=excluded.updated',
      id,
      proposalId,
      step,
      status,
      JSON.stringify(data),
      new Date().toISOString()
    );
  }
  /** @param {string} id @param {string} proposalId @param {number} step @param {unknown} data @param {unknown} audit */
  async verified(id, proposalId, step, data, audit) {
    await this.batch([
      [
        'INSERT INTO operations(id,proposal_id,step,status,data,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated=excluded.updated',
        id,
        proposalId,
        step,
        'complete',
        JSON.stringify(data),
        new Date().toISOString(),
      ],
      this.auditStatement('operation_verified', audit, proposalId),
    ]);
  }
}
