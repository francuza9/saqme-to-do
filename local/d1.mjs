// The slice of Cloudflare's D1 API that worker/src uses, on Node's built-in SQLite (node:sqlite, Node 22.13+),
// so the Linux/macOS app runs the very same sync and merge code as the Worker.
//   prepare(sql).bind(...).all() / .first(col?) / .run() / .raw(),  batch([stmts]) (one transaction),  exec(sql)
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  stmt() { return this.db.prepare(this.sql); }
  async all() { return this.allSync(); }
  allSync() {
    const st = this.stmt();
    // statements without a result (INSERT ... without RETURNING, UPDATE) report changes like D1's meta
    if (st.columns().length === 0) {
      const r = st.run(...this.params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    return { success: true, results: st.all(...this.params).map((r) => ({ ...r })), meta: {} };
  }
  async first(col) {
    const row = this.stmt().get(...this.params);
    if (!row) return null;
    return col === undefined ? { ...row } : (row[col] ?? null);
  }
  async run() { return this.allSync(); }
  async raw() { return this.stmt().all(...this.params).map((r) => Object.values(r)); }
}

export class D1 {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
  }
  prepare(sql) { return new Statement(this.db, sql); }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
  /** Like D1: all statements in one transaction; any error rolls the whole batch back. */
  async batch(stmts) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = stmts.map((s) => s.allSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }
  /** Applies the worker/migrations/*.sql not applied yet, in name order (like `wrangler d1 migrations apply`). */
  migrate(dir) {
    this.db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = new Set(this.db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(readFileSync(join(dir, f), 'utf8'));
        this.db.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?1, ?2)').run(f, Date.now());
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  close() { this.db.close(); }
}
