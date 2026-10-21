// The database updates itself (worker/src/schema.js): fresh databases, ones migrated by wrangler or by the
// Linux/macOS app, ones made by hand, half-updated ones, two first requests at once, a migration that fails.
// The Worker's own SQLite stand-in (local/d1.mjs) plays D1.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1 } from '../../../local/d1.mjs';
import { MIGRATIONS } from '../../src/migrations.js';
import { ensureSchema, footprint, migrate, SCHEMA_VERSION, statements } from '../../src/schema.js';
import worker from '../../src/index.js';

const DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const WRANGLER_TABLE = 'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';

let dir;
const open = (name = 'db.sqlite') => new D1(join(dir, name));
const tables = (db) => db.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((r) => r.name);
const names = (db) => db.db.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map((r) => r.name);
const version = (db) => db.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value ?? null;
const columns = (db, t) => db.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t).map((r) => r.name);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'saqme-schema-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the migrations the Worker carries', () => {
  it('are worker/migrations/*.sql, file by file and statement by statement', () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files);
    for (const m of MIGRATIONS) expect(statements(m.sql), m.name).toEqual(statements(readFileSync(join(DIR, m.name), 'utf8')));
    expect(SCHEMA_VERSION).toBe(files.length);
  });

  it('splits SQL into statements: comments go, strings stay as they are', () => {
    expect(statements("-- a 'comment';\nCREATE TABLE a (x TEXT DEFAULT ';  ''x''');  /* b; */ INSERT INTO a VALUES ('--');\n\n"))
      .toEqual(["CREATE TABLE a (x TEXT DEFAULT ';  ''x''')", "INSERT INTO a VALUES ('--')"]);
    expect(footprint(MIGRATIONS[2].sql)).toEqual({
      creates: ['share_push', 'remotes', 'remote_tasks'],
      adds: [['shares', 'old_token_hash'], ['shares', 'transferred_at'], ['shares', 'relayed_at']],
    });
  });
});

describe('migrate', () => {
  it('a new database gets everything, recorded like wrangler records it; the next run does nothing', async () => {
    const db = open();
    expect(await migrate(db)).toEqual(files);
    expect(names(db)).toEqual(files);
    expect(version(db)).toBe(String(files.length));
    expect(tables(db)).toEqual(expect.arrayContaining(['meta', 'tasks', 'projects', 'shares', 'remotes', 'remote_tasks', 'd1_migrations']));
    expect(columns(db, 'shares')).toContain('relayed_at');
    expect(await migrate(db)).toEqual([]);
    db.close();
  });

  it('a database the Linux/macOS app migrated (local/d1.mjs) is taken as it is', async () => {
    const db = open();
    db.migrate(DIR);
    const before = db.db.prepare(`SELECT value FROM meta WHERE key = 'db_id'`).get().value;
    expect(await migrate(db)).toEqual([]);
    expect(version(db)).toBe(String(files.length));
    expect(db.db.prepare(`SELECT value FROM meta WHERE key = 'db_id'`).get().value).toBe(before);
    db.close();
  });

  it('a database wrangler migrated up to an older release gets just the newer migrations, data kept', async () => {
    const db = open();
    db.db.exec(WRANGLER_TABLE);
    for (const f of files.slice(0, 2)) {
      db.db.exec(readFileSync(join(DIR, f), 'utf8'));
      db.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
    }
    db.db.prepare(`INSERT INTO shares (id, project_id, alias, access, created_at) VALUES ('s1', 'p1', 'Nuca', 'edit', 1)`).run();
    expect(await migrate(db)).toEqual([files[2]]);
    expect(names(db)).toEqual(files);
    expect(db.db.prepare('SELECT alias, relayed_at FROM shares').get()).toEqual({ alias: 'Nuca', relayed_at: null });
    db.close();
  });

  it('a database made by hand from the .sql files (no records): what is there is recognized, the rest applied', async () => {
    const db = open();
    for (const f of files.slice(0, 2)) db.db.exec(readFileSync(join(DIR, f), 'utf8'));
    expect(await migrate(db)).toEqual([files[2]]);
    expect(names(db)).toEqual(files);
    db.close();
  });

  it('two first requests at once (two connections): each migration runs once, both succeed', async () => {
    const a = open('shared.sqlite');
    const b = open('shared.sqlite');
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    expect([...ra, ...rb].sort()).toEqual(files);
    expect(names(a)).toEqual(files);
    expect(a.db.prepare('SELECT count(*) AS n FROM d1_migrations').get().n).toBe(files.length);
    a.close(); b.close();
  });

  it('a migration that fails changes nothing of its own, says which one, and is tried again next time', async () => {
    const db = open();
    const bad = [...MIGRATIONS, { name: '0099_bad.sql', sql: 'CREATE TABLE half_done (a TEXT);\nINSERT INTO no_such_table VALUES (1);\n' }];
    await expect(migrate(db, bad)).rejects.toThrow(/0099_bad\.sql/);
    expect(tables(db)).not.toContain('half_done');
    expect(names(db)).toEqual(files);   // the ones before it stay
    expect(version(db)).toBeNull();     // not "up to date"
    await expect(migrate(db, bad)).rejects.toThrow(/0099_bad\.sql/);
    expect(await migrate(db)).toEqual([]);
    db.close();
  });

  it('a newer Worker ran here before (a higher schema version): nothing is undone', async () => {
    const db = open();
    await migrate(db);
    db.db.prepare(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`).run();
    expect(await migrate(db)).toEqual([]);
    expect(version(db)).toBe('99');
    db.close();
  });
});

describe('the Worker', () => {
  it('updates a new database on its first request, then answers as usual', async () => {
    const db = open();
    const env = { DB: db, AUTH_TOKEN: 'token-0123456789abcdef0123456789abcdef0123' };
    const health = await worker.fetch(new Request('https://saqme.test/api/health'), env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, api: expect.any(Number), version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(names(db)).toEqual(files);
    const sync = await worker.fetch(new Request('https://saqme.test/api/sync', {
      method: 'POST', headers: { authorization: `Bearer ${env.AUTH_TOKEN}` }, body: JSON.stringify({ deviceId: 'pc', cursor: 0, changes: [] }),
    }), env);
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ cursor: 0, changes: [], api: expect.any(Number) });
    db.close();
  });

  it('a database it cannot update: 503 with a plain message, and it tries again', async () => {
    const db = open();
    db.db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY)');   // the wrong shape: the first migration cannot insert into it
    const env = { DB: db, AUTH_TOKEN: 'token-0123456789abcdef0123456789abcdef0123' };
    const r = await worker.fetch(new Request('https://saqme.test/api/health'), env);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: 'schema', error: expect.stringMatching(/could not update its database/) });
    await expect(ensureSchema(db)).rejects.toThrow(/0001_init\.sql/);
    db.close();
  });
});
