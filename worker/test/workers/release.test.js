// Which release a Worker is, for apps older or newer than it (src/version.js), and the database updating itself
// on real D1 (src/schema.js; test/node/schema.test.js has the cases on SQLite): the test runner migrates the way
// wrangler does, into d1_migrations, and the Worker must take that as it is.
import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index.js';
import { migrate, SCHEMA_VERSION } from '../../src/schema.js';
import { MIGRATIONS } from '../../src/migrations.js';
import { API_VERSION, VERSION } from '../../src/version.js';

async function call(path, { method = 'GET', body, token = env.AUTH_TOKEN } = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://saqme.test${path}`, {
    method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, data: await res.json() };
}

describe('release and API version', () => {
  it('are in the health check, the config and every sync answer', async () => {
    const pkg = await import('../../package.json');
    expect(VERSION).toBe(pkg.default.version);
    for (const [path, opts] of [['/api/health', { token: null }], ['/api/config', {}], ['/api/sync', { method: 'POST', body: { deviceId: 'pc', cursor: 0, changes: [] } }]]) {
      const r = await call(path, opts);
      expect(r.status, path).toBe(200);
      expect(r.data, path).toMatchObject({ version: VERSION, api: API_VERSION });
    }
  });
});

describe('the database updates itself on D1', () => {
  it('a database migrated the way wrangler does is up to date as it is', async () => {
    expect(await migrate(env.DB)).toEqual([]);
    expect(await env.DB.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).first('value')).toBe(String(SCHEMA_VERSION));
  });

  it('two runs at once apply a new migration once; a failing one is rolled back whole', async () => {
    const extra = [...MIGRATIONS, { name: '9998_release_test.sql', sql: 'CREATE TABLE IF NOT EXISTS release_test (a TEXT);\nINSERT INTO release_test VALUES (\'once\');\n' }];
    try {
      const [a, b] = await Promise.all([migrate(env.DB, extra), migrate(env.DB, extra)]);
      expect([...a, ...b]).toEqual(['9998_release_test.sql']);
      expect((await env.DB.prepare('SELECT count(*) AS n FROM release_test').first('n'))).toBe(1);
      const bad = [...extra, { name: '9999_release_bad.sql', sql: 'CREATE TABLE release_bad (a TEXT);\nINSERT INTO no_such_table VALUES (1);\n' }];
      await expect(migrate(env.DB, bad)).rejects.toThrow(/9999_release_bad\.sql/);
      expect(await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name = 'release_bad'`).first()).toBeNull();
    } finally {
      await env.DB.batch([
        env.DB.prepare('DROP TABLE IF EXISTS release_test'),
        env.DB.prepare(`DELETE FROM d1_migrations WHERE name LIKE '999%'`),
        env.DB.prepare(`UPDATE meta SET value = ?1 WHERE key = 'schema_version'`).bind(String(SCHEMA_VERSION)),
      ]);
    }
  });
});
