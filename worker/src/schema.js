// The database updates itself (docs/sync.md, "Updates"): the first request or cron run after a deploy applies
// the migrations (src/migrations.js) the database does not have yet, so updating never needs
// `wrangler d1 migrations apply`. Each one is recorded where wrangler records its own, by file name (table
// d1_migrations), so a database migrated with wrangler, by the Linux/macOS app (local/d1.mjs) or by the test
// runner is recognized as it is. Once it is up to date, meta 'schema_version' says so: one read per Worker
// instance from then on.
//
// Concurrent first requests: each migration runs as one batch (one transaction) whose first write records it,
// so a second runner's batch fails on that record and is rolled back whole; it then sees the record and goes on.
import { MIGRATIONS } from './migrations.js';

export const SCHEMA_VERSION = MIGRATIONS.length;
const TRACK = 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
const RECORD = 'INSERT INTO d1_migrations (name, applied_at) VALUES (?1, CURRENT_TIMESTAMP)';

/** SQL text -> its statements, without comments, white space collapsed outside string literals. */
export function statements(sql) {
  const out = [];
  let cur = '';
  const space = () => { if (cur && !cur.endsWith(' ')) cur += ' '; };
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; space(); continue; }
    if (ch === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; space(); continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (; j < sql.length; j++) { if (sql[j] === ch) { if (sql[j + 1] === ch) j++; else break; } }
      cur += sql.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === ';') { out.push(cur); cur = ''; continue; }
    if (/\s/.test(ch)) { space(); continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** What a migration leaves behind (to recognize one applied without a record): its tables, and columns it adds. */
export function footprint(sql) {
  const creates = [];
  const adds = [];
  for (const s of statements(sql)) {
    let m = /^CREATE TABLE (?:IF NOT EXISTS )?["`]?(\w+)/i.exec(s);
    if (m) creates.push(m[1]);
    m = /^ALTER TABLE ["`]?(\w+)["`]? ADD (?:COLUMN )?["`]?(\w+)/i.exec(s);
    if (m) adds.push([m[1], m[2]]);
  }
  return { creates, adds };
}

const checked = new WeakMap();

/** Resolves once the database has every migration: one run per database binding; concurrent callers wait for it. */
export function ensureSchema(db) {
  let p = checked.get(db);
  if (!p) {
    p = migrate(db).catch((e) => { checked.delete(db); throw e; });   // (tried again by the next request)
    checked.set(db, p);
  }
  return p;
}

async function schemaVersion(db) {
  try {
    const v = await db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first('value');
    return v == null ? null : Number(v);
  } catch { return null; }   // no meta table yet: a new database
}

async function recorded(db) {
  try { return new Set((await db.prepare('SELECT name FROM d1_migrations').all()).results.map((r) => r.name)); } catch { return null; }
}

/** Without any record (a database made by hand from the .sql files): the leading migrations whose tables and columns are there. */
async function present(db, migrations) {
  let tables;
  try {
    tables = new Map((await db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`).all()).results.map((r) => [r.name, r.sql ?? '']));
  } catch { return new Set(); }
  const out = new Set();
  for (const m of migrations) {
    const { creates, adds } = footprint(m.sql);
    if (!creates.length && !adds.length) break;
    const there = creates.every((t) => tables.has(t)) && adds.every(([t, c]) => new RegExp(`\\b${c}\\b`, 'i').test(tables.get(t) ?? ''));
    if (!there) break;   // (they are applied in order)
    out.add(m.name);
  }
  return out;
}

/** Applies what is missing, in order. -> the names it applied (another runner's work does not count). */
export async function migrate(db, migrations = MIGRATIONS) {
  const v = await schemaVersion(db);
  if (v !== null && v >= migrations.length) return [];   // (a higher number: a newer Worker ran here; nothing to undo)
  let done = await recorded(db);
  if (!done) {
    done = await present(db, migrations);
    if (done.size) await db.batch([db.prepare(TRACK), ...[...done].map((n) => db.prepare('INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES (?1, CURRENT_TIMESTAMP)').bind(n))]);
  }
  const applied = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    try {
      await db.batch([db.prepare(TRACK), db.prepare(RECORD).bind(m.name), ...statements(m.sql).map((s) => db.prepare(s))]);
      applied.push(m.name);
    } catch (e) {
      // another request applied it meanwhile: its record is there now. Anything else is a real failure.
      if (!(await recorded(db))?.has(m.name)) throw new Error(`the database update ${m.name} failed: ${e?.message ?? e}`);
    }
    done.add(m.name);
  }
  await db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(String(migrations.length)).run();
  return applied;
}
