// Reminders of shared lists' deadlines on phones (worker/src/reminders.js, remotes.js). Someone with a Worker of
// their own: its cron reads the lists their phones joined from the owners' Workers and reminds them like of their
// own tasks, at their own summary time and in their time zone. Someone using a list in the browser from its
// owner's address (no Worker): the owner's Worker reminds them of that list only, through a push subscription made
// with the list's key, at their time and in their time zone. Never both: once the key is used through the person's
// own Worker, the owner's stops. Real Workers on SQLite, a fake push service that decrypts what it gets.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1 } from '../../../local/d1.mjs';
import worker from '../../src/index.js';
import { runReminders } from '../../src/reminders.js';
import { generateVapidKeys } from '../../src/push.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const OWNER = 'https://owner.test';
const MINE = 'https://mine.test';
const OWNER_KEY = 'owner-key-0123456789abcdef0123456789abcdef';
const MY_KEY = 'my-key-0123456789abcdef0123456789abcdef0123';
const subtle = globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const fromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const toB64u = (b) => Buffer.from(b).toString('base64url');
const text = (s) => new TextEncoder().encode(s);

let dir;
let servers;
let pushed;   // [{ endpoint, payload }] what the push services received, decrypted
let subscribers;   // endpoint -> the browser's keys

async function hkdf(ikm, salt, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
/** The browser's side of RFC 8291 (as in push.test.js): the payload a push carried. */
async function decrypt(body, { uaPublic, uaPrivate, auth }) {
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const salt = body.subarray(0, 16);
  const ua = fromB64u(uaPublic);
  const priv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: toB64u(ua.subarray(1, 33)), y: toB64u(ua.subarray(33)), d: uaPrivate }, ECDH, false, ['deriveBits']);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', asPublic, ECDH, false, []) }, priv, 256));
  const ikm = await hkdf(ecdh, fromB64u(auth), new Uint8Array([...text('WebPush: info\0'), ...ua, ...asPublic]), 32);
  const cek = await hkdf(ikm, salt, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, text('Content-Encoding: nonce\0'), 12);
  const padded = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), record));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  return JSON.parse(new TextDecoder().decode(padded.subarray(0, end)));
}
/** A browser's push subscription (its keys stay here, to read what it gets). */
async function browser(name) {
  const kp = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const uaPublic = toB64u(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const { d: uaPrivate } = await subtle.exportKey('jwk', kp.privateKey);
  const auth = toB64u(crypto.getRandomValues(new Uint8Array(16)));
  const endpoint = `https://fcm.googleapis.com/fcm/send/${name}`;
  subscribers.set(endpoint, { uaPublic, uaPrivate, auth });
  return { endpoint, keys: { p256dh: uaPublic, auth } };
}
async function server(origin, token) {
  const db = new D1(join(dir, `${new URL(origin).host}.db`));
  db.migrate(MIGRATIONS);
  const vapid = await generateVapidKeys();
  servers.set(origin, { env: { DB: db, AUTH_TOKEN: token, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }, db });
}
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (subscribers.has(String(url))) {
    pushed.push({ endpoint: String(url), payload: await decrypt(new Uint8Array(init.body), subscribers.get(String(url))) });
    return new Response('', { status: 201 });
  }
  const s = servers.get(u.origin);
  if (!s) throw new TypeError('fetch failed');
  return worker.fetch(new Request(u, { method: init.method ?? 'GET', headers: init.headers, body: init.body }), s.env);
}
async function api(origin, path, { token, body, method = 'POST' } = {}) {
  const res = await fakeFetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const f = (v, ts, base) => (base === undefined ? { v, ts } : { v, ts, base });
const project = (id, name) => ({ kind: 'project', id, fields: { name: f(name, 1000), pos: f('a0', 1000) } });
const task = (id, projectId, text, due = null) => ({ kind: 'task', id, fields: { place: f({ project: projectId, parent: null, pos: 'a0' }, 1000), text: f(text, 1000), status: f(' ', 1000), notes: f('', 1000), due: f(due, 1000) } });
const setting = (id, v) => ({ kind: 'setting', id, fields: { value: f(v, 1000) } });
const sync = (origin, key, changes) => api(origin, '/api/sync', { token: key, body: { deviceId: 'pc', cursor: 0, changes } });
const invite = async (projectId = 'groceri1') => (await api(OWNER, '/api/shares/invite', { token: OWNER_KEY, body: { projectId, alias: 'Nuca', access: 'edit' } })).data;
const cron = (origin, at) => runReminders(servers.get(origin).env, Date.parse(at));
const to = (endpoint) => pushed.filter((p) => p.endpoint === endpoint).map((p) => p.payload);
const db = (origin) => servers.get(origin).db.db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'saqme-remind-'));
  servers = new Map();
  pushed = [];
  subscribers = new Map();
  await server(OWNER, OWNER_KEY);
  await server(MINE, MY_KEY);
  vi.stubGlobal('fetch', fakeFetch);
  // the owner: a shared list and a private one, in UTC, summary at 6:00
  await sync(OWNER, OWNER_KEY, [project('groceri1', 'Groceries'), project('diary001', 'Diary'), setting('tz', 'UTC'), setting('notifyAt', '6:00'),
    task('eggs0001', 'groceri1', 'buy eggs', { date: '2026-10-25', time: '14:00' }), task('milk0001', 'groceri1', 'milk', { date: '2026-10-25', time: '' }),
    task('secret01', 'diary001', 'secret thing', { date: '2026-10-25', time: '' })]);
  // the person: in Tbilisi (UTC+4), summary at 9:00, a list of their own
  await sync(MINE, MY_KEY, [project('home0001', 'Home'), setting('tz', 'Asia/Tbilisi'), setting('notifyAt', '9:00'),
    task('plants01', 'home0001', 'water plants', { date: '2026-10-25', time: '' })]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of servers.values()) s.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('someone with a Worker of their own', () => {
  async function joined() {
    const phone = await browser('my-phone');
    expect((await api(MINE, '/api/push/subscribe', { token: MY_KEY, body: { deviceId: 'phone1', subscription: phone } })).status).toBe(200);
    const { remote } = (await api(MINE, '/api/remotes/join', { token: MY_KEY, body: { link: (await invite()).link } })).data;
    return { phone, remote };
  }

  it('is reminded of a shared list\'s deadlines by their own Worker, in their own time zone, once', async () => {
    const { phone } = await joined();
    const timed = () => to(phone.endpoint).filter((p) => p.tag !== 'digest');
    await cron(MINE, '2026-10-25T09:40:00Z');   // 13:40 in Tbilisi
    expect(timed()).toEqual([]);
    await cron(MINE, '2026-10-25T09:50:00Z');   // 13:50: the 14:00 deadline is 10 minutes away
    expect(timed()).toEqual([expect.objectContaining({ title: 'In 10 min', body: 'buy eggs', sub: 'Groceries · 14:00', tag: 'due-eggs0001' })]);
    await cron(MINE, '2026-10-25T09:55:00Z');
    expect(timed()).toHaveLength(1);   // not again
    await cron(MINE, '2026-10-25T10:00:00Z');
    expect(timed().map((p) => p.title)).toEqual(['In 10 min', 'Due now']);
    expect(to(phone.endpoint).filter((p) => p.tag === 'digest')).toHaveLength(1);   // and the day's summary, once
  });

  it('the daily summary at their own time has their tasks and the shared list\'s, nothing of the owner\'s other lists', async () => {
    const { phone } = await joined();
    await cron(MINE, '2026-10-25T04:55:00Z');   // 8:55 in Tbilisi
    expect(to(phone.endpoint).filter((p) => p.tag === 'digest')).toEqual([]);
    await cron(MINE, '2026-10-25T05:00:00Z');   // 9:00
    const digest = to(phone.endpoint).filter((p) => p.tag === 'digest');
    expect(digest).toHaveLength(1);
    expect(digest[0].title).toBe('2 due today');
    expect(digest[0].body.split('\n').sort()).toEqual(['milk', 'water plants']);
    expect(JSON.stringify(pushed)).not.toContain('secret');
  });

  it('a task moved out of the list, a list deleted or no longer shared: no reminders of it', async () => {
    const { phone, remote } = await joined();
    await cron(MINE, '2026-10-25T04:00:00Z');   // read the list once
    expect(db(MINE).prepare('SELECT id FROM remote_tasks ORDER BY id').all().map((r) => r.id)).toEqual(['eggs0001', 'milk0001']);
    const eggs = db(OWNER).prepare('SELECT place_ts FROM tasks WHERE id = ?').get('eggs0001');
    await sync(OWNER, OWNER_KEY, [{ kind: 'task', id: 'eggs0001', fields: { place: f({ project: 'diary001', parent: null, pos: 'a5' }, 5000, eggs.place_ts) } }]);
    db(MINE).prepare('UPDATE remotes SET polled_at = 0').run();
    await cron(MINE, '2026-10-25T09:50:00Z');
    expect(to(phone.endpoint).filter((p) => p.body === 'buy eggs')).toEqual([]);
    expect(db(MINE).prepare('SELECT id FROM remote_tasks').all().map((r) => r.id)).toEqual(['milk0001']);
    // the owner stops sharing it: this Worker ends it and forgets its tasks (the next day's summary: one's own only)
    const people = (await api(OWNER, '/api/shares?project=groceri1', { token: OWNER_KEY, method: 'GET' })).data.shares;
    await api(OWNER, '/api/shares/revoke', { token: OWNER_KEY, body: { id: people[0].id } });
    await cron(MINE, '2026-10-26T05:00:00Z');
    expect(db(MINE).prepare('SELECT state FROM remotes WHERE id = ?').get(remote.id).state).toBe('revoked');
    expect(db(MINE).prepare('SELECT count(*) AS n FROM remote_tasks').get().n).toBe(0);
    expect(to(phone.endpoint).filter((p) => p.tag === 'digest').at(-1)).toMatchObject({ title: 'Overdue', body: 'water plants' });
  });

  it('the cron reads the lists with a budget: one run never makes more requests than the plan allows', async () => {
    await joined();
    let calls = 0;
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (url, init) => { calls++; return real(url, init); });
    await cron(MINE, '2026-10-25T09:50:00Z');
    expect(calls).toBeLessThanOrEqual(40);
    expect(db(MINE).prepare('SELECT polled_at FROM remotes').get().polled_at).toBe(Date.parse('2026-10-25T09:50:00Z'));
  });
});

describe('someone using the list in the browser (no Worker of their own)', () => {
  async function inBrowser() {
    const claim = (await api(OWNER, '/api/shares/claim', { body: { code: (await invite()).code } })).data;
    const phone = await browser('browser-phone');
    return { key: claim.token, phone };
  }

  it('subscribes with the list\'s key: that list only, their time zone and summary time', async () => {
    const { key, phone } = await inBrowser();
    for (const endpoint of ['https://push.example.test/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x']) {
      expect((await api(OWNER, '/api/push/subscribe', { token: key, body: { subscription: { ...phone, endpoint }, tz: 'America/New_York', notifyAt: '8:00' } })).status, endpoint).toBe(400);
    }
    expect((await api(OWNER, '/api/config', { token: key, method: 'GET' })).data.vapidPublicKey).toBe(servers.get(OWNER).env.VAPID_PUBLIC_KEY);
    expect((await api(OWNER, '/api/push/subscribe', { token: key, body: { subscription: phone, tz: 'America/New_York', notifyAt: '8:00' } })).status).toBe(200);
    expect(db(OWNER).prepare('SELECT tz, notify_at FROM share_push').all()).toEqual([{ tz: 'America/New_York', notify_at: '8:00' }]);
    expect(db(OWNER).prepare('SELECT count(*) AS n FROM push_subscriptions').get().n).toBe(0);   // not the owner's own reminders
    // a time zone or time that makes no sense falls back to the defaults
    await api(OWNER, '/api/push/subscribe', { token: key, body: { subscription: phone, tz: 'Mars/Olympus', notifyAt: '25:99' } });
    expect(db(OWNER).prepare('SELECT tz, notify_at FROM share_push').all()).toEqual([{ tz: 'UTC', notify_at: '10:00' }]);
  });

  it('the owner\'s Worker reminds them of that list only, at their time; the owner gets their own reminders', async () => {
    const { key, phone } = await inBrowser();
    await api(OWNER, '/api/push/subscribe', { token: key, body: { subscription: phone, tz: 'America/New_York', notifyAt: '8:00' } });
    const ownerPhone = await browser('owner-phone');
    await api(OWNER, '/api/push/subscribe', { token: OWNER_KEY, body: { deviceId: 'owner-phone', subscription: ownerPhone } });
    await cron(OWNER, '2026-10-25T11:55:00Z');   // 7:55 in New York: not yet theirs; 11:55 UTC: the owner's (6:00) is due
    expect(to(phone.endpoint)).toEqual([]);
    const own = to(ownerPhone.endpoint).find((p) => p.tag === 'digest');
    expect(own.body.split('\n').sort()).toEqual(['milk', 'secret thing']);
    await cron(OWNER, '2026-10-25T12:00:00Z');   // 8:00 in New York
    const theirs = to(phone.endpoint).filter((p) => p.tag === 'digest');
    expect(theirs).toEqual([expect.objectContaining({ title: 'Due today', body: 'milk', sub: 'Groceries' })]);
    await cron(OWNER, '2026-10-25T12:05:00Z');
    expect(to(phone.endpoint).filter((p) => p.tag === 'digest')).toHaveLength(1);
    // its timed deadline by their clock: 14:00 in New York is 18:00 UTC
    await cron(OWNER, '2026-10-25T13:50:00Z');
    expect(to(phone.endpoint).map((p) => p.body)).not.toContain('buy eggs');
    await cron(OWNER, '2026-10-25T17:50:00Z');
    expect(to(phone.endpoint).filter((p) => p.body === 'buy eggs')).toEqual([expect.objectContaining({ title: 'In 10 min', sub: 'Groceries · 14:00' })]);
    expect(JSON.stringify(to(phone.endpoint))).not.toContain('secret');
  });

  it('its test push and unsubscribe reach only that list\'s subscriptions', async () => {
    const { key, phone } = await inBrowser();
    const other = (await api(OWNER, '/api/shares/claim', { body: { code: (await invite()).code } })).data.token;
    const ownerPhone = await browser('owner-phone');
    await api(OWNER, '/api/push/subscribe', { token: OWNER_KEY, body: { deviceId: 'owner-phone', subscription: ownerPhone } });
    await api(OWNER, '/api/push/subscribe', { token: key, body: { subscription: phone, tz: 'UTC', notifyAt: '8:00' } });
    expect((await api(OWNER, '/api/push/test', { token: other, body: {} })).data.sent).toBe(0);
    expect((await api(OWNER, '/api/push/test', { token: key, body: {} })).data.sent).toBe(1);
    expect(pushed.map((p) => p.endpoint)).toEqual([phone.endpoint]);
    await api(OWNER, '/api/push/unsubscribe', { token: other, body: { endpoint: phone.endpoint } });
    expect(db(OWNER).prepare('SELECT count(*) AS n FROM share_push').get().n).toBe(1);   // another key's: untouched
    await api(OWNER, '/api/push/unsubscribe', { token: key, body: { endpoint: phone.endpoint } });
    expect(db(OWNER).prepare('SELECT count(*) AS n FROM share_push').get().n).toBe(0);
    expect(db(OWNER).prepare('SELECT count(*) AS n FROM push_subscriptions').get().n).toBe(1);
  });

  it('leaving, or the owner stopping the share, ends those reminders', async () => {
    const { key, phone } = await inBrowser();
    await api(OWNER, '/api/push/subscribe', { token: key, body: { subscription: phone, tz: 'UTC', notifyAt: '8:00' } });
    await api(OWNER, '/api/shares/leave', { token: key, body: {} });
    expect(db(OWNER).prepare('SELECT count(*) AS n FROM share_push').get().n).toBe(0);
    await cron(OWNER, '2026-10-25T12:00:00Z');
    expect(pushed).toEqual([]);
  });
});

describe('never twice', () => {
  it('moved to their Saqme app: the owner\'s Worker stops, their own reminds them, once', async () => {
    const claim = (await api(OWNER, '/api/shares/claim', { body: { code: (await invite()).code } })).data;
    const web = await browser('browser-phone');
    await api(OWNER, '/api/push/subscribe', { token: claim.token, body: { subscription: web, tz: 'Asia/Tbilisi', notifyAt: '9:00' } });
    const phone = await browser('my-phone');
    await api(MINE, '/api/push/subscribe', { token: MY_KEY, body: { deviceId: 'phone1', subscription: phone } });
    // "Move to my Saqme app": a move code, claimed through the person's own Worker
    const move = (await api(OWNER, '/api/shares/transfer', { token: claim.token, body: {} })).data;
    expect((await api(MINE, '/api/remotes/join', { token: MY_KEY, body: { link: move.link } })).data.kind).toBe('move');
    expect(db(OWNER).prepare('SELECT count(*) AS n FROM share_push').get().n).toBe(0);
    for (const at of ['2026-10-25T09:50:00Z', '2026-10-25T09:55:00Z']) { await cron(OWNER, at); await cron(MINE, at); }
    expect(to(web.endpoint)).toEqual([]);
    expect(to(phone.endpoint).filter((p) => p.body === 'buy eggs')).toHaveLength(1);
  });

  it('a key used through the person\'s own Worker (adopted after pairing): the owner\'s browser reminders stop', async () => {
    const claim = (await api(OWNER, '/api/shares/claim', { body: { code: (await invite()).code } })).data;
    const web = await browser('browser-phone');
    await api(OWNER, '/api/push/subscribe', { token: claim.token, body: { subscription: web, tz: 'UTC', notifyAt: '8:00' } });
    await api(MINE, '/api/remotes/adopt', { token: MY_KEY, body: { server: OWNER, token: claim.token, name: 'Groceries' } });
    expect(db(OWNER).prepare('SELECT relayed_at FROM shares').get().relayed_at).toBeGreaterThan(0);
    await cron(OWNER, '2026-10-25T12:00:00Z');
    expect(to(web.endpoint)).toEqual([]);
  });
});
