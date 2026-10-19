import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext, createScheduledController } from 'cloudflare:test';
import worker from '../../src/index.js';
import { loadState, writeState, handleSync, PAGE } from '../../src/sync.js';
import { applyChanges } from '../../src/merge.js';
import { generateVapidKeys } from '../../src/push.js';

const TOKEN = env.AUTH_TOKEN;
const P = 'proj0001';

async function call(path, { method = 'POST', body, token = TOKEN } = {}) {
  const ctx = createExecutionContext();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await worker.fetch(new Request(`https://saqme.test${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function sync(deviceId, cursor, changes = []) {
  const res = await call('/api/sync', { body: { deviceId, cursor, changes } });
  expect(res.status).toBe(200);
  return res.json();
}
const f = (v, ts, base) => (base === undefined ? { v, ts } : { v, ts, base });
const projectChange = (id = P, name = 'Work', ts = 1000) => ({ kind: 'project', id, fields: { name: f(name, ts), pos: f('a0', ts) } });
const taskChange = (id, ts, { text = `task ${id}`, parent = null, pos = 'a0', project = P } = {}) => ({
  kind: 'task', id, fields: { place: f({ project, parent, pos }, ts), text: f(text, ts), status: f(' ', ts), notes: f('', ts), due: f(null, ts) },
});

// storage persists across tests in a file, so start every test from an empty database
beforeEach(async () => {
  await env.DB.batch(['tasks', 'projects', 'settings', 'conflicts', 'push_subscriptions', 'notified']
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`))
    .concat(env.DB.prepare(`UPDATE meta SET value = '0' WHERE key = 'seq'`)));
});

/** A tiny in-memory client: keeps the server rows it has seen. */
class Client {
  constructor(id) { this.id = id; this.cursor = 0; this.rows = new Map(); }
  async sync(changes = []) {
    let out;
    let first = true;
    do {
      out = await sync(this.id, this.cursor, first ? changes : []);
      first = false;
      for (const r of out.changes) this.rows.set(`${r.kind}:${r.id}`, r);
      this.cursor = out.cursor;
    } while (out.more);
    return out;
  }
  task(id) { return this.rows.get(`task:${id}`); }
}

describe('HTTP surface', () => {
  it('health is public, everything else needs the token', async () => {
    expect((await call('/api/health', { method: 'GET', token: null })).status).toBe(200);
    expect((await call('/api/sync', { body: {}, token: null })).status).toBe(401);
    expect((await call('/api/sync', { body: {}, token: 'wrong' })).status).toBe(401);
    expect((await call('/api/config', { method: 'GET' })).status).toBe(200);
    expect((await call('/api/nope', { method: 'GET' })).status).toBe(404);
  });

  it('answers cross-origin calls (a copy of the app hosted elsewhere), still only with the token', async () => {
    const ctx = createExecutionContext();
    const pre = await worker.fetch(new Request('https://saqme.test/api/sync', {
      method: 'OPTIONS', headers: { origin: 'https://someone.github.io', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/authorization/);
    const ok = await call('/api/sync', { body: { deviceId: 'web-x', cursor: 0, changes: [] } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    expect((await call('/api/sync', { body: { deviceId: 'web-x', cursor: 0 }, token: null })).status).toBe(401);
  });

  it('validates the sync body', async () => {
    expect((await call('/api/sync', { body: { cursor: 0 } })).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => taskChange(`t${String(i).padStart(7, '0')}`, 1));
    expect((await call('/api/sync', { body: { deviceId: 'd1', cursor: 0, changes: many } })).status).toBe(413);
    const res = await call('/api/sync', { body: { deviceId: 'd1', cursor: 0, changes: [{ kind: 'task', id: 'BAD', fields: {} }] } });
    expect(res.status).toBe(200);
    expect((await res.json()).rejected).toHaveLength(1);
  });
});

describe('sync protocol', () => {
  it('propagates creates and edits between two devices via cursors', async () => {
    const pc = new Client('pc');
    const phone = new Client('phone');
    const r1 = await pc.sync([projectChange(), taskChange('aaaaaaaa', 1000), taskChange('bbbbbbbb', 1000, { parent: 'aaaaaaaa' })]);
    expect(r1.rejected).toEqual([]);
    expect(r1.dbId).toMatch(/^[0-9a-f]{16}$/);
    await phone.sync();
    expect(phone.task('bbbbbbbb').fields.place.v.parent).toBe('aaaaaaaa');
    expect(phone.rows.get(`project:${P}`).fields.name.v).toBe('Work');

    const base = phone.task('aaaaaaaa').fields.status.ts;
    await phone.sync([{ kind: 'task', id: 'aaaaaaaa', fields: { status: f('x', 2000, base) } }]);
    const before = pc.cursor;
    const r = await pc.sync();
    expect(r.changes.map((c) => c.id)).toEqual(['aaaaaaaa']);
    expect(pc.task('aaaaaaaa').fields.status.v).toBe('x');
    expect(pc.cursor).toBeGreaterThan(before);
    // nothing new -> empty response
    expect((await pc.sync()).changes).toEqual([]);
  });

  it('records concurrent edits as conflicts visible to both devices', async () => {
    const pc = new Client('pc');
    const phone = new Client('phone');
    await pc.sync([projectChange(), taskChange('aaaaaaaa', 1000)]);
    await phone.sync();
    const base = pc.task('aaaaaaaa').fields.text.ts;
    await phone.sync([{ kind: 'task', id: 'aaaaaaaa', fields: { text: f('from phone', 3000, base) } }]);
    await pc.sync([{ kind: 'task', id: 'aaaaaaaa', fields: { text: f('from pc', 2000, base) } }]);
    await phone.sync();
    for (const c of [pc, phone]) {
      expect(c.task('aaaaaaaa').fields.text.v).toBe('from phone');
      const conflicts = [...c.rows.values()].filter((r) => r.kind === 'conflict');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ task: 'aaaaaaaa', field: 'text', value: 'from pc', other: 'from phone' });
    }
    // resolve on the phone by keeping the pc value
    const c = [...phone.rows.values()].find((r) => r.kind === 'conflict');
    await phone.sync([
      { kind: 'task', id: 'aaaaaaaa', fields: { text: f(c.value, 4000, phone.task('aaaaaaaa').fields.text.ts) } },
      { kind: 'conflict', id: c.id, fields: { resolved: f(true, 4000, c.fields.resolved.ts) } },
    ]);
    await pc.sync();
    expect(pc.task('aaaaaaaa').fields.text.v).toBe('from pc');
    expect(pc.rows.get(`conflict:${c.id}`).fields.resolved.v).toBe(true);
  });

  it('is idempotent when a client resends a batch after a lost response', async () => {
    const pc = new Client('pc');
    const batch = [projectChange(), taskChange('aaaaaaaa', 1000)];
    await pc.sync(batch);
    await pc.sync([{ kind: 'task', id: 'aaaaaaaa', fields: { text: f('edit', 2000, 1000) } }]);
    await pc.sync([{ kind: 'task', id: 'aaaaaaaa', fields: { text: f('edit', 2000, 1000) } }]);
    await pc.sync(batch);   // the original create again
    const t = pc.task('aaaaaaaa');
    expect(t.fields.text).toEqual({ v: 'edit', ts: 2000 });
    const { results } = await env.DB.prepare('SELECT count(*) AS n FROM conflicts').all();
    expect(results[0].n).toBe(0);
  });

  it('pages large histories and never loses rows', async () => {
    const pc = new Client('pc');
    await pc.sync([projectChange()]);
    const total = PAGE + 450;
    for (let i = 0; i < total; i += 100) {
      const n = Math.min(100, total - i);
      await pc.sync(Array.from({ length: n }, (_, k) => taskChange(`t${String(i + k).padStart(7, '0')}`, 1000 + i + k)));
    }
    const fresh = new Client('fresh');
    let pages = 0;
    let out;
    do { out = await sync('fresh', fresh.cursor, []); pages++; for (const r of out.changes) fresh.rows.set(`${r.kind}:${r.id}`, r); fresh.cursor = out.cursor; } while (out.more);
    expect(pages).toBeGreaterThan(1);
    expect([...fresh.rows.values()].filter((r) => r.kind === 'task')).toHaveLength(total);
  });

  it('rejects a write based on a stale snapshot (optimistic concurrency guard)', async () => {
    await new Client('pc').sync([projectChange(), taskChange('aaaaaaaa', 1000)]);
    const changes = [{ kind: 'task', id: 'aaaaaaaa', fields: { text: f('A', 2000, 1000) } }];
    const st = await loadState(env.DB, changes);
    const res = applyChanges(st.state, changes, { now: Date.now(), deviceId: 'x' });
    // someone else writes in between
    await new Client('other').sync([{ kind: 'task', id: 'aaaaaaaa', fields: { notes: f('B', 2000, 1000) } }]);
    await expect(writeState(env.DB, st.seq, res, Date.now())).rejects.toThrow(/UNIQUE/);
    // nothing from the stale batch landed
    const row = await env.DB.prepare('SELECT text, notes FROM tasks WHERE id = ?1').bind('aaaaaaaa').first();
    expect(row).toEqual({ text: 'task aaaaaaaa', notes: 'B' });
  });

  it('concurrent requests all land (no lost updates)', async () => {
    await new Client('pc').sync([projectChange()]);
    const reqs = Array.from({ length: 12 }, (_, i) => handleSync(env, {
      deviceId: `dev${i}`, cursor: 0, changes: [taskChange(`c${String(i).padStart(7, '0')}`, 1000 + i)],
    }));
    await Promise.all(reqs);
    const { results } = await env.DB.prepare('SELECT count(*) AS n FROM tasks').all();
    expect(results[0].n).toBe(12);
    const seq = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'seq'`).first('value');
    expect(Number(seq)).toBe(13);
  });

  it('tells a device when the database went back in time (restored from a backup)', async () => {
    const a = await sync('pc', 0, [projectChange(), taskChange('aaaaaaaa', 1000), taskChange('bbbbbbbb', 1000)]);
    expect(a.restored).toBeUndefined();
    const ahead = a.cursor + 5;   // a cursor this database never handed out
    expect((await sync('pc', ahead)).restored).toBe(true);
    expect((await sync('pc', ahead, [taskChange('cccccccc', 2000)])).restored).toBe(true);
    expect((await sync('pc', a.cursor)).restored).toBeUndefined();
  });

  it('refuses moves that would create a cycle and tells the client', async () => {
    const pc = new Client('pc');
    await pc.sync([projectChange(), taskChange('aaaaaaaa', 1000), taskChange('bbbbbbbb', 1000, { parent: 'aaaaaaaa' })]);
    const out = await pc.sync([{ kind: 'task', id: 'aaaaaaaa', fields: { place: f({ project: P, parent: 'bbbbbbbb', pos: 'a0' }, 2000, 1000) } }]);
    expect(out.rejected[0]).toMatchObject({ id: 'aaaaaaaa', field: 'place' });
    expect(pc.task('aaaaaaaa').fields.place.v.parent).toBeNull();   // canonical row came back
  });
});

describe('push + reminders', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stores subscriptions and sends due reminders once from the cron trigger', async () => {
    const vapid = await generateVapidKeys();
    const e2 = { ...env, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const b64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) } };

    // only the push services browsers use: the Worker must not be made to send requests anywhere else
    for (const endpoint of ['https://push.example.test/abc', 'https://fcm.googleapis.com.evil.example/x', 'http://fcm.googleapis.com/x', 'https://u@fcm.googleapis.com/x']) {
      const c = createExecutionContext();
      const r = await worker.fetch(new Request('https://saqme.test/api/push/subscribe', {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ deviceId: 'phone', subscription: { ...subscription, endpoint } }),
      }), e2, c);
      expect(r.status, endpoint).toBe(400);
    }

    const ctx0 = createExecutionContext();
    const sub = await worker.fetch(new Request('https://saqme.test/api/push/subscribe', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ deviceId: 'phone', subscription }),
    }), e2, ctx0);
    expect(sub.status).toBe(200);

    const now = Date.parse('2026-10-25T13:50:00Z');
    await new Client('pc').sync([projectChange(),
      { ...taskChange('aaaaaaaa', 1000), fields: { ...taskChange('aaaaaaaa', 1000).fields, due: f({ date: '2026-10-25', time: '14:00' }, 1000) } },
      { kind: 'setting', id: 'tz', fields: { value: f('UTC', 1000) } }]);

    const sent = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { sent.push({ url, init }); return new Response('', { status: 201 }); });
    for (let i = 0; i < 2; i++) {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: now, cron: '*/5 * * * *' }), e2, ctx);
      await waitOnExecutionContext(ctx);
    }
    expect(sent).toHaveLength(1);   // second run is deduped
    expect(sent[0].url).toBe(subscription.endpoint);
    expect(sent[0].init.headers.Authorization ?? sent[0].init.headers.authorization).toMatch(/^vapid t=/);

    // a gone subscription is dropped
    globalThis.fetch.mockImplementation(async () => new Response('', { status: 410 }));
    const ctx = createExecutionContext();
    const test = await worker.fetch(new Request('https://saqme.test/api/push/test', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' }), e2, ctx);
    expect((await test.json()).failed).toBe(1);
    const n = await env.DB.prepare('SELECT count(*) AS n FROM push_subscriptions').first('n');
    expect(n).toBe(0);
  });
});
