// The relay on a person's own Worker (worker/src/remotes.js): the phone app talks to its own Worker only, which
// claims, syncs and leaves the lists others share with them, server to server. Not an open proxy: only its own
// key, only three routes of an owner's Worker, only https addresses with a name on the default port, no
// redirects, a timeout and a size cap; the owner's status comes back as it is (401: revoked, or moved). Real
// Workers (worker/src on SQLite, like the Linux/macOS app) stand in for the owners' and the person's own.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1 } from '../../../local/d1.mjs';
import worker from '../../src/index.js';
import { relayOrigin, callOwner, MAX_RELAY_ANSWER } from '../../src/remotes.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const OWNER = 'https://owner.test';
const OTHER = 'https://other.test';   // someone else who shares a list with the same name
const MINE = 'https://mine.test';
const OWNER_KEY = 'owner-key-0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'other-key-0123456789abcdef0123456789abcdef';
const MY_KEY = 'my-key-0123456789abcdef0123456789abcdef0123';
const PATHS = ['/api/shares/claim', '/api/sync', '/api/shares/leave'];

let dir;
let servers;
let fakes;      // origin -> (url, init) => Response: servers that misbehave
let outbound;   // every request a Worker made
function server(origin, token) {
  const db = new D1(join(dir, `${new URL(origin).host}.db`));
  db.migrate(MIGRATIONS);
  servers.set(origin, { env: { DB: db, AUTH_TOKEN: token }, db });
}
/** The network the Workers see: requests go to the Worker for their origin, in-process. */
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  outbound.push({ origin: u.origin, path: u.pathname, init });
  if (fakes.has(u.origin)) return fakes.get(u.origin)(u, init);
  const s = servers.get(u.origin);
  if (!s) throw new TypeError('fetch failed');
  return worker.fetch(new Request(u, { method: init.method ?? 'GET', headers: init.headers, body: init.body }), s.env);
}
/** A request to one Worker, as an app makes it (not counted as the Workers' own). */
async function api(origin, path, { token, body, method = 'POST' } = {}) {
  const res = await worker.fetch(new Request(`${origin}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  }), servers.get(origin).env);
  return { status: res.status, data: await res.json() };
}
const f = (v, ts, base) => (base === undefined ? { v, ts } : { v, ts, base });
const project = (id, name) => ({ kind: 'project', id, fields: { name: f(name, 1000), pos: f('a0', 1000) } });
const task = (id, projectId, text) => ({ kind: 'task', id, fields: { place: f({ project: projectId, parent: null, pos: 'a0' }, 1000), text: f(text, 1000), status: f(' ', 1000), notes: f('', 1000), due: f(null, 1000) } });
const seed = (origin, key, changes) => api(origin, '/api/sync', { token: key, body: { deviceId: 'owner-pc', cursor: 0, changes } });
const invite = async (origin = OWNER, key = OWNER_KEY, projectId = 'groceri1', access = 'edit') => (await api(origin, '/api/shares/invite', { token: key, body: { projectId, alias: 'Nuca', access } })).data;
const relayJoin = (link) => api(MINE, '/api/remotes/join', { token: MY_KEY, body: { link } });
const relaySync = (id, body = {}) => api(MINE, `/api/remotes/${id}/sync`, { token: MY_KEY, body: { deviceId: 'phone1', cursor: 0, changes: [], ...body } });
const db = (origin) => servers.get(origin).db.db;
const toOwners = () => outbound.filter((o) => o.origin !== MINE);
const texts = (data) => data.changes.filter((c) => c.kind === 'task').map((c) => c.fields.text.v).sort();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'saqme-relay-'));
  servers = new Map();
  fakes = new Map();
  outbound = [];
  server(OWNER, OWNER_KEY);
  server(OTHER, OTHER_KEY);
  server(MINE, MY_KEY);
  vi.stubGlobal('fetch', fakeFetch);
  await seed(OWNER, OWNER_KEY, [project('groceri1', 'Groceries'), project('diary001', 'Diary'), task('milk0001', 'groceri1', 'milk'), task('bread001', 'groceri1', 'bread'), task('secret01', 'diary001', 'secret')]);
  await seed(OTHER, OTHER_KEY, [project('groceri2', 'Groceries'), task('apples01', 'groceri2', 'apples')]);
  await seed(MINE, MY_KEY, [project('home0001', 'Home'), task('plants01', 'home0001', 'water plants')]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of servers.values()) s.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('which addresses it talks to', () => {
  it('the phone app itself connects to its own address only: the relay is its way to other Workers', () => {
    const policy = readFileSync(fileURLToPath(new URL('../../public/_headers', import.meta.url)), 'utf8');
    expect(/connect-src ([^;]+);/.exec(policy)[1].trim()).toBe("'self'");
    const join = readFileSync(fileURLToPath(new URL('../../public/join.html', import.meta.url)), 'utf8');
    expect(/connect-src ([^;"]+)/.exec(join)[1].trim()).toBe("'self'");
  });

  it('https with a host name, the default port, nothing else in the address', () => {
    expect(relayOrigin('https://saqme.nuca.workers.dev')).toBe('https://saqme.nuca.workers.dev');
    expect(relayOrigin('https://saqme.nuca.workers.dev/')).toBe('https://saqme.nuca.workers.dev');
    expect(relayOrigin('https://Todo.Example.com:443')).toBe('https://todo.example.com');
    for (const bad of [
      'http://saqme.nuca.workers.dev', 'ftp://saqme.nuca.workers.dev', 'https://saqme.nuca.workers.dev:8443', 'https://user@saqme.nuca.workers.dev',
      'https://user:pw@saqme.nuca.workers.dev', 'https://saqme.nuca.workers.dev@evil.example', 'https://127.0.0.1', 'https://10.0.0.8', 'https://2130706433',
      'https://0x7f.1', 'https://[::1]', 'https://[fd00::1]', 'https://localhost', 'https://api.localhost', 'https://printer.local', 'https://db.internal',
      'https://router.home.arpa', 'https://intranet', 'https://saqme.nuca.workers.dev/api', 'https://saqme.nuca.workers.dev/?x=1', 'https://saqme.nuca.workers.dev/#x',
      '', null, 'not a link',
    ]) expect(relayOrigin(bad), String(bad)).toBeNull();
  });

  it('calls three routes of an origin, nothing else', async () => {
    for (const path of ['/api/shares/invite', '/api/pair/claim', '/api/remotes/join', '/api/push/test', '/', '/api/sync/../pair/code']) {
      await expect(callOwner(OWNER, path)).rejects.toMatchObject({ status: 400 });
    }
    for (const s of ['https://owner.test/', 'http://owner.test', 'https://owner.test:8443', 'https://127.0.0.1', '']) {
      await expect(callOwner(s, '/api/sync')).rejects.toMatchObject({ status: 400 });
    }
    expect(outbound).toEqual([]);
  });

  it('follows no redirect, gives up after a timeout, reads at most a few MB, and wants JSON', async () => {
    fakes.set('https://moved.test', () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
    fakes.set('https://big.test', () => new Response('x'.repeat(MAX_RELAY_ANSWER + 1)));
    fakes.set('https://huge.test', () => new Response('{}', { headers: { 'content-length': String(MAX_RELAY_ANSWER + 1) } }));
    fakes.set('https://html.test', () => new Response('<html>hello</html>'));
    fakes.set('https://slow.test', () => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    for (const [s, msg] of [['https://moved.test', /redirect/], ['https://big.test', /too much/], ['https://huge.test', /too much/], ['https://html.test', /did not answer like/],
      ['https://slow.test', /Could not reach/], ['https://nobody.test', /Could not reach/]]) {
      const r = await callOwner(s, '/api/sync', { token: 'k'.repeat(43) });
      expect(r.status, s).toBe(502);
      expect(r.data.error, s).toMatch(msg);
    }
    expect(outbound.map((o) => o.origin)).not.toContain('http://169.254.169.254');
    for (const o of outbound) {
      expect(o.init.redirect).toBe('manual');
      expect(o.init.signal).toBeInstanceOf(AbortSignal);
      expect(o.init.method).toBe('POST');
    }
  });

  it('passes the owner\'s status and answer through', async () => {
    fakes.set('https://busy.test', () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 }));
    fakes.set('https://gone.test', () => new Response(JSON.stringify({ error: 'revoked' }), { status: 401 }));
    expect(await callOwner('https://busy.test', '/api/sync')).toEqual({ status: 503, data: { error: 'busy' } });
    expect(await callOwner('https://gone.test', '/api/sync')).toEqual({ status: 401, data: { error: 'revoked' } });
  });
});

describe('the relay routes', () => {
  it('answer this Worker\'s own key only', async () => {
    const mineInvite = await invite(MINE, MY_KEY, 'home0001');
    const shareKey = (await api(MINE, '/api/shares/claim', { body: { code: mineInvite.code } })).data.token;
    const inv = await invite();
    for (const token of [undefined, 'wrong-key-0123456789abcdef0123456789abcdef', OWNER_KEY]) {
      expect((await api(MINE, '/api/remotes/join', { token, body: { link: inv.link } })).status).toBe(401);
      expect((await api(MINE, '/api/remotes', { token, method: 'GET' })).status).toBe(401);
      expect((await api(MINE, '/api/remotes/r000000000000000/sync', { token, body: {} })).status).toBe(401);
    }
    // the key of a list this Worker shares with someone: not for relaying
    for (const [path, method] of [['/api/remotes/join', 'POST'], ['/api/remotes/adopt', 'POST'], ['/api/remotes', 'GET'], ['/api/remotes/r000000000000000/sync', 'POST'], ['/api/remotes/r000000000000000/leave', 'POST']]) {
      expect((await api(MINE, path, { token: shareKey, method, body: method === 'POST' ? { link: inv.link } : undefined })).status, path).toBe(403);
    }
    expect(toOwners()).toEqual([]);
    expect((await api(OWNER, '/api/shares/claim', { body: { code: inv.code } })).status).toBe(200);   // the invite was not used up
  });

  it('join lists from an https address with a name only', async () => {
    const code = 'c'.repeat(22);
    for (const link of [`http://localhost:8787/join#code=${code}`, `https://127.0.0.1/join#code=${code}`, `https://[::1]/join#code=${code}`, `https://owner.test:8443/join#code=${code}`,
      `https://localhost/join#code=${code}`, `https://printer.local/join#code=${code}`, `https://2130706433/join#code=${code}`, `saqme://join?server=http%3A%2F%2F127.0.0.1%3A8787&code=${code}`,
      `https://user@owner.test/join#code=${code}`, 'https://owner.test/#pair=kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk', '']) {
      const r = await relayJoin(link);
      expect(r.status, link).toBe(400);
    }
    expect(toOwners()).toEqual([]);
  });

  it('joins, syncs through the owner and leaves; the key stays on this Worker', async () => {
    const inv = await invite();
    const j = await relayJoin(inv.link);
    expect(j.status).toBe(200);
    expect(j.data).toEqual({ kind: 'join', remote: { id: expect.stringMatching(/^r[0-9a-z]{15}$/), server: OWNER, projectId: 'groceri1', name: 'Groceries', access: 'edit', state: 'active', converted: false } });
    const id = j.data.remote.id;
    const key = db(MINE).prepare('SELECT token FROM remotes WHERE id = ?').get(id).token;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // this Worker's other phones learn about it from their own sync (never the key)
    const own = await api(MINE, '/api/sync', { token: MY_KEY, body: { deviceId: 'phone2', cursor: 0, changes: [] } });
    expect(own.data.remotes).toEqual([j.data.remote]);
    expect(JSON.stringify(own.data)).not.toContain(key);
    expect(JSON.stringify((await api(MINE, '/api/remotes', { token: MY_KEY, method: 'GET' })).data)).not.toContain(key);
    // the owner's list, and nothing else of theirs
    const s = await relaySync(id);
    expect(s.status).toBe(200);
    expect(texts(s.data)).toEqual(['bread', 'milk']);
    expect(s.data.share).toEqual({ projectId: 'groceri1', access: 'edit' });
    const milk = s.data.changes.find((c) => c.id === 'milk0001');
    const e = await relaySync(id, { cursor: s.data.cursor, changes: [{ kind: 'task', id: 'milk0001', fields: { status: f('x', 5000, milk.fields.status.ts) } }] });
    expect(e.data.rejected).toEqual([]);
    expect(db(OWNER).prepare('SELECT status FROM tasks WHERE id = ?').get('milk0001').status).toBe('x');
    // nothing of the owner's list on this Worker's own tables
    expect(db(MINE).prepare('SELECT text FROM tasks').all().map((r) => r.text)).toEqual(['water plants']);
    // it told the owner's Worker it relays (that one stops sending this list's browser reminders)
    expect(db(OWNER).prepare('SELECT relayed_at FROM shares').get().relayed_at).toBeGreaterThan(0);
    // only the three routes, with the list's key (never this Worker's own), marked as relayed
    expect(toOwners().length).toBeGreaterThan(0);
    for (const o of toOwners()) {
      expect(PATHS).toContain(o.path);
      expect(o.init.headers.authorization ?? '').not.toContain(MY_KEY);
      expect(o.init.headers['x-saqme-relay']).toBe('1');
      expect(o.init.headers.cookie).toBeUndefined();
    }
    // leave: the key ends at the owner's, and here
    expect((await api(MINE, `/api/remotes/${id}/leave`, { token: MY_KEY })).data).toEqual({ ok: true });
    expect((await api(OWNER, '/api/sync', { token: key, body: { deviceId: 'x', cursor: 0, changes: [] } })).status).toBe(401);
    expect(await relaySync(id)).toEqual({ status: 401, data: { error: 'left', convert: false } });
    expect(db(MINE).prepare('SELECT state, token FROM remotes WHERE id = ?').get(id)).toEqual({ state: 'left', token: '' });
    expect(db(OWNER).prepare('SELECT count(*) AS n FROM tasks WHERE project_id = ?').get('groceri1').n).toBe(2);
  });

  it('passes the owner\'s refusals and errors through; a revoked list ends here, and one app keeps it', async () => {
    const inv = await invite(OWNER, OWNER_KEY, 'groceri1', 'view');
    const { id } = (await relayJoin(inv.link)).data.remote;
    const s = await relaySync(id);
    const milk = s.data.changes.find((c) => c.id === 'milk0001');
    const r = await relaySync(id, { cursor: s.data.cursor, changes: [{ kind: 'task', id: 'milk0001', fields: { text: f('cream', 5000, milk.fields.text.ts) } }] });
    expect(r.status).toBe(200);
    expect(r.data.rejected[0].reason).toBe('this shared list is view-only');
    expect(db(OWNER).prepare('SELECT text FROM tasks WHERE id = ?').get('milk0001').text).toBe('milk');
    // revoked: 401, and only the first app to ask keeps a copy (the others get it through this Worker's own sync)
    await api(OWNER, '/api/shares/revoke', { token: OWNER_KEY, body: { id: inv.share.id } });
    expect(await relaySync(id)).toEqual({ status: 401, data: { error: 'revoked', convert: true } });
    expect(await relaySync(id)).toEqual({ status: 401, data: { error: 'revoked', convert: false } });
    expect(db(MINE).prepare('SELECT state, token FROM remotes WHERE id = ?').get(id)).toEqual({ state: 'revoked', token: '' });
    // other answers come back as they are; a 404 of the owner's is not "no such list here"
    fakes.set('https://busy.test', () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 }));
    fakes.set('https://lost.test', () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    const ins = db(MINE).prepare(`INSERT INTO remotes (id, server, token, project_id, name, access, state, created_at, updated_at) VALUES (?, ?, ?, 'groceri9', 'X', 'edit', 'active', 1, 1)`);
    ins.run('rbusy0000000000a', 'https://busy.test', 'k'.repeat(43));
    ins.run('rlost0000000000a', 'https://lost.test', 'k'.repeat(43));
    expect(await relaySync('rbusy0000000000a')).toEqual({ status: 503, data: { error: 'busy' } });
    expect((await relaySync('rlost0000000000a')).status).toBe(502);
    expect(await relaySync('r000000000000000')).toEqual({ status: 404, data: { error: 'no such shared list' } });
    expect((await relaySync('Rbusy0000000000a')).status).toBe(404);
  });

  it('one key per list: a second invite to it is given back; its own lists are not joined', async () => {
    await relayJoin((await invite()).link);
    const again = await relayJoin((await invite()).link);
    expect(again.status).toBe(409);
    expect(again.data.error).toMatch(/already here/);
    expect(db(OWNER).prepare('SELECT count(*) AS n FROM shares WHERE revoked_at IS NULL AND token_hash IS NOT NULL').get().n).toBe(1);
    outbound = [];
    const own = await relayJoin((await invite(MINE, MY_KEY, 'home0001')).link);
    expect(own.status).toBe(409);
    expect(toOwners()).toEqual([]);
  });

  it('adopts a key the app had on its own; a revoked or moved one comes back as such', async () => {
    const claim = (await api(OWNER, '/api/shares/claim', { body: { code: (await invite()).code } })).data;
    const a = await api(MINE, '/api/remotes/adopt', { token: MY_KEY, body: { server: OWNER, token: claim.token, name: 'Groceries' } });
    expect(a.data.remote).toMatchObject({ server: OWNER, projectId: 'groceri1', access: 'edit', state: 'active' });
    expect(texts((await relaySync(a.data.remote.id)).data)).toEqual(['bread', 'milk']);
    for (const body of [{ server: 'http://owner.test', token: claim.token }, { server: 'https://127.0.0.1', token: claim.token }, { server: OWNER, token: 'short' }, {}]) {
      expect((await api(MINE, '/api/remotes/adopt', { token: MY_KEY, body })).status).toBe(400);
    }
    const other = (await api(OWNER, '/api/shares/claim', { body: { code: (await invite(OWNER, OWNER_KEY, 'diary001')).code } })).data;
    await api(OWNER, '/api/shares/leave', { token: other.token, body: {} });
    expect(await api(MINE, '/api/remotes/adopt', { token: MY_KEY, body: { server: OWNER, token: other.token } })).toEqual({ status: 401, data: { error: 'revoked' } });
  });

  it('a list used in the browser moves here: the same share, a new key; the old one is told it moved', async () => {
    const inv = await invite();
    const browser = (await api(OWNER, '/api/shares/claim', { body: { code: inv.code } })).data;
    const move = await api(OWNER, '/api/shares/transfer', { token: browser.token, body: {} });
    expect(move.data.link).toMatch(/^https:\/\/owner\.test\/join#code=[A-Za-z0-9_-]{22}$/);
    const j = await relayJoin(move.data.link);
    expect(j.data.kind).toBe('move');
    expect((await api(OWNER, '/api/sync', { token: browser.token, body: { deviceId: 'web', cursor: 0, changes: [] } }))).toMatchObject({ status: 401, data: { error: 'transferred' } });
    expect(texts((await relaySync(j.data.remote.id)).data)).toEqual(['bread', 'milk']);
    const people = (await api(OWNER, '/api/shares?project=groceri1', { token: OWNER_KEY, method: 'GET' })).data.shares;
    expect(people).toEqual([expect.objectContaining({ id: inv.share.id, alias: 'Nuca', state: 'joined' })]);   // still one person
    expect((await api(OWNER, '/api/shares/claim', { body: { code: move.data.link.split('code=')[1] } })).status).toBe(400);   // once
  });

  it('lists from several owners at once, also with the same name, each from its own owner only', async () => {
    const a = (await relayJoin((await invite()).link)).data.remote;
    const b = (await relayJoin((await invite(OTHER, OTHER_KEY, 'groceri2', 'view')).link)).data.remote;
    expect([a.name, b.name]).toEqual(['Groceries', 'Groceries']);
    expect([a.server, b.server]).toEqual([OWNER, OTHER]);
    expect(texts((await relaySync(a.id)).data)).toEqual(['bread', 'milk']);
    expect(texts((await relaySync(b.id)).data)).toEqual(['apples']);
    expect((await api(MINE, '/api/sync', { token: MY_KEY, body: { deviceId: 'phone2', cursor: 0, changes: [] } })).data.remotes.map((r) => r.server)).toEqual([OWNER, OTHER]);
    // and this Worker's own list shared out at the same time: both kinds side by side
    await invite(MINE, MY_KEY, 'home0001', 'view');
    const own = (await api(MINE, '/api/sync', { token: MY_KEY, body: { deviceId: 'phone2', cursor: 0, changes: [] } })).data;
    expect(own.shared).toEqual(['home0001']);
    expect(own.remotes).toHaveLength(2);
  });
});
