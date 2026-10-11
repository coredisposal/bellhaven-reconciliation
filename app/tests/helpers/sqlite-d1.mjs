/** A real SQLite transaction mirrors D1's documented atomic batch behavior. */
export function sqliteD1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          return statement.get(...args) ?? null;
        },
        async all() {
          return { results: statement.all(...args) };
        },
        async run() {
          if (/^\s*SELECT\b/i.test(sql)) return { results: statement.all(...args) };
          return { meta: { changes: Number(statement.run(...args).changes) } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
