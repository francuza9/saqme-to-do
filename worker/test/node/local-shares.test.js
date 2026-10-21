// Lists shared with a computer, in the lists-folder engine (local/engine.mjs with a scope) and in the Linux/macOS
// app (local/shares.mjs, startApp): the shared list is a plain file, synced with its owner's server only, the
// engine for one's own server leaves it out, a view-only file goes back to the owner's version (with notices),
// and leaving or the end of the share leave the right things behind. The owner's server is the Worker's own code
// on SQLite, reached through a stubbed fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1 } from '../../../local/d1.mjs';
import { newState, syncCycle, applyPlanToFolder, readLocalLists } from '../../../local/engine.mjs';
import { Shares } from '../../../local/shares.mjs';
import { startApp } from '../../../local/saqme.mjs';
import worker from '../../src/index.js';
import { serverLabel } from '../../public/js/pairing.js';

const migrations = join(import.meta.dirname, '..', '..', 'migrations');
const OWNER = 'https://owner.test';
const OWNER_KEY = 'owner-key-0123456789abcdef0123456789abcdef';
const realFetch = globalThis.fetch;
let dir;
let owner;   // { env, d1 }

const f = (v, ts, base) => (base === undefined ? { v, ts } : { v, ts, base });
const task = (id, project, text, pos = 'a0', ts = 1000) => ({ kind: 'task', id, fields: { place: f({ project, parent: null, pos }, ts), text: f(text, ts), status: f(' ', ts), notes: f('', ts), due: f(null, ts) } });
async function ownerFetch(url, init = {}) {
  const u = new URL(url);
  if (u.origin !== OWNER) return realFetch(url, init);
  return worker.fetch(new Request(u, { method: init.method ?? 'GET', headers: init.headers, body: init.body }), owner.env);
}
async function ownerApi(path, body, token = OWNER_KEY) {
  const r = await ownerFetch(`${OWNER}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
const ownerSync = (changes) => ownerApi('/api/sync', { deviceId: 'owner-pc', cursor: 0, changes });
const ownerRow = (id) => owner.d1.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const seq = () => Number(owner.d1.db.prepare(`SELECT value FROM meta WHERE key = 'seq'`).get().value);
const invite = async (access) => (await ownerApi('/api/shares/invite', { projectId: 'groceri1', alias: 'Me', access })).data;
const httpTo = (token) => async (body) => {
  const r = await ownerFetch(`${OWNER}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const age = (path) => { const t = new Date(Date.now() - 10_000); utimesSync(path, t, t); };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'saqme-shared-'));
  const d1 = new D1(join(dir, 'owner.db'));
  d1.migrate(migrations);
  owner = { env: { DB: d1, AUTH_TOKEN: OWNER_KEY }, d1 };
  await ownerSync([
    { kind: 'project', id: 'groceri1', fields: { name: f('Groceries', 1000), pos: f('a0', 1000) } },
    { kind: 'project', id: 'diary001', fields: { name: f('Diary', 1000), pos: f('a1', 1000) } },
    task('milk0001', 'groceri1', 'milk', 'a0'), task('bread001', 'groceri1', 'bread', 'a1'), task('secret01', 'diary001', 'secret'),
  ]);
});
afterEach(() => { vi.unstubAllGlobals(); owner.d1.close(); rmSync(dir, { recursive: true, force: true }); });

/** A shared list's engine on a lists folder, with the key from a fresh invite. */
async function sharedEngine(access, lists) {
  const inv = await invite(access);
  const claim = await ownerApi('/api/shares/claim', { code: inv.code }, '');
  const state = newState();
  const scope = { project: 'groceri1', file: 'Groceries', readOnly: access !== 'edit' };
  return {
    state, share: inv.share, token: claim.data.token, scope,
    cycle: async (extra = {}) => syncCycle({
      state, statePath: join(dir, `share-${access}.json`), listsDir: lists, transport: httpTo(claim.data.token), deviceId: 'pc-share', settleMs: 0,
      applyPlan: (plan) => applyPlanToFolder(plan, lists), view: { only: scope.file }, scope, ...extra,
    }),
  };
}
function listsFolder() {
  const lists = join(dir, 'lists');
  mkdirSync(lists, { recursive: true });
  const write = (name, text) => { writeFileSync(join(lists, `${name}.md`), text); age(join(lists, `${name}.md`)); };
  const read = (name) => readFileSync(join(lists, `${name}.md`), 'utf8');
  return { lists, write, read };
}

describe('the lists-folder engine with a shared list', () => {
  it('creates the file on the first sync and keeps every other list\'s place in the tab order', async () => {
    const { lists, write, read } = listsFolder();
    write('Work', '- [ ] A ^aaaaaaaa\n'); write('Home', '- [ ] B ^bbbbbbbb\n');
    writeFileSync(join(lists, '.order'), 'Work\nHome\n');
    const e = await sharedEngine('edit', lists);
    const res = await e.cycle();
    expect(res.status).toBe('synced');
    expect(res.access).toBe('edit');
    expect(read('Groceries')).toBe('- [ ] milk ^milk0001\n- [ ] bread ^bread001\n');
    expect(readFileSync(join(lists, '.order'), 'utf8')).toBe('Work\nHome\nGroceries\n');
    expect(read('Work')).toBe('- [ ] A ^aaaaaaaa\n');
    expect(readdirSync(lists).filter((n) => n.endsWith('.md')).sort()).toEqual(['Groceries.md', 'Home.md', 'Work.md']);
  });

  it('sends edits of its file to the owner, and only tasks: the list itself stays the owner\'s', async () => {
    const { lists, write, read } = listsFolder();
    const e = await sharedEngine('edit', lists);
    await e.cycle();
    write('Groceries', '- [x] milk ^milk0001\n- [ ] bread ^bread001\n- [ ] eggs ^eggs0001\n');
    await e.cycle();
    expect(ownerRow('milk0001').status).toBe('x');
    expect(ownerRow('eggs0001')).toMatchObject({ project_id: 'groceri1', text: 'eggs' });
    // the owner's edit comes back into the file
    const b = ownerRow('bread001');
    await ownerSync([{ kind: 'task', id: 'bread001', fields: { text: f('rye bread', Date.now(), b.text_ts) } }]);
    await e.cycle();
    expect(read('Groceries')).toBe('- [x] milk ^milk0001\n- [ ] rye bread ^bread001\n- [ ] eggs ^eggs0001\n');
    // the file removed by hand comes back (to leave, the app's Leave), nothing is deleted at the owner's
    rmSync(join(lists, 'Groceries.md'));
    for (let i = 0; i < 3; i++) await e.cycle({ clock: () => Date.now() + 60_000 * (i + 1) });
    expect(read('Groceries')).toContain('rye bread');
    expect(owner.d1.db.prepare('SELECT deleted FROM projects WHERE id = ?').get('groceri1').deleted).toBe(0);
    expect(owner.d1.db.prepare('SELECT count(*) AS n FROM tasks WHERE deleted = 1').get().n).toBe(0);
  });

  it('a view-only file: nothing reaches the owner, the file goes back to the owner\'s version, the edits are kept as notices', async () => {
    const { lists, write, read } = listsFolder();
    const e = await sharedEngine('view', lists);
    await e.cycle();
    const before = seq();
    write('Groceries', '# my heading\n- [x] oat milk ^milk0001\n- [ ] my own idea ^idea0001\n');
    await e.cycle();
    expect(seq()).toBe(before);
    expect(read('Groceries')).toBe('# my heading\n- [ ] milk ^milk0001\n- [ ] bread ^bread001\n');
    expect(e.state.Notices.map((n) => `${n.task} ${n.field} ${n.value}`).sort()).toEqual(['bread001 deleted true', 'idea0001 new my own idea', 'milk0001 status x', 'milk0001 text oat milk']);
    await e.cycle();
    expect(e.state.Notices).toHaveLength(4);
    expect(seq()).toBe(before);
  });

  it('a change the owner\'s server refuses (the list became view-only meanwhile) is kept as a notice', async () => {
    const { lists, write } = listsFolder();
    const e = await sharedEngine('edit', lists);
    await e.cycle();
    await ownerApi('/api/shares/update', { id: e.share.id, access: 'view' });
    write('Groceries', '- [ ] my milk ^milk0001\n- [ ] bread ^bread001\n');
    const res = await e.cycle();
    expect(res.refused.some((r) => /milk0001: this shared list is view-only/.test(r))).toBe(true);
    expect(e.state.Notices.map((n) => `${n.task} ${n.field} ${n.value}`)).toEqual(['milk0001 text my milk']);
    expect(ownerRow('milk0001').text).toBe('milk');
  });

  it('the engine for one\'s own server leaves the shared file out', async () => {
    const { lists, write } = listsFolder();
    const e = await sharedEngine('edit', lists);
    await e.cycle();
    write('Work', '- [ ] mine ^mine0001\n');
    // "own" server: another Worker database
    const d1 = new D1(join(dir, 'mine.db'));
    d1.migrate(migrations);
    const mine = { DB: d1, AUTH_TOKEN: 'mine-key-0123456789abcdef0123456789abcdef' };
    const transport = async (body) => {
      const r = await worker.fetch(new Request('https://mine.test/api/sync', { method: 'POST', headers: { authorization: `Bearer ${mine.AUTH_TOKEN}` }, body: JSON.stringify(body) }), mine);
      return { status: r.status, data: await r.json() };
    };
    const own = newState();
    for (let i = 0; i < 3; i++) {
      await syncCycle({ state: own, statePath: join(dir, 'own.json'), listsDir: lists, transport, deviceId: 'pc-own', settleMs: 0,
        applyPlan: (plan) => applyPlanToFolder(plan, lists), view: { exclude: new Set(['Groceries']) } });
    }
    expect(d1.db.prepare('SELECT text FROM tasks').all().map((r) => r.text)).toEqual(['mine']);
    expect(d1.db.prepare('SELECT name FROM projects').all().map((r) => r.name)).toEqual(['Work']);
    expect(ownerRow('mine0001')).toBeUndefined();
    d1.close();
  });

  it('follows the owner\'s rename, a task moved out of the list, and ends with 401 when revoked', async () => {
    const { lists, read } = listsFolder();
    const e = await sharedEngine('edit', lists);
    await e.cycle();
    const p = owner.d1.db.prepare('SELECT name_ts FROM projects WHERE id = ?').get('groceri1');
    await ownerSync([{ kind: 'project', id: 'groceri1', fields: { name: f('Shopping', Date.now(), p.name_ts) } },
      { kind: 'task', id: 'bread001', fields: { place: f({ project: 'diary001', parent: null, pos: 'a5' }, Date.now(), 1000) } }]);
    let planned = null;
    await e.cycle({ applyPlan: (plan) => { planned = plan; return applyPlanToFolder(plan, lists); } });
    expect(planned.files.groceri1).toBe('Shopping');   // (the app moves the binding along: shares.mjs)
    e.scope.file = 'Shopping';
    await e.cycle({ view: { only: 'Shopping' } });
    expect(read('Shopping')).toBe('- [ ] milk ^milk0001\n');
    expect(existsSync(join(lists, 'Groceries.md'))).toBe(false);
    await ownerApi('/api/shares/revoke', { id: e.share.id });
    expect((await e.cycle({ view: { only: 'Shopping' } })).status).toBe('auth');
  });

  it('the owner renaming it onto a name another list has: the file says whose it is', async () => {
    const { lists, write, read } = listsFolder();
    write('Shopping', '- [ ] mine ^mine0001\n');
    const e = await sharedEngine('edit', lists);
    e.scope.label = 'nuca';
    await e.cycle();
    const p = owner.d1.db.prepare('SELECT name_ts FROM projects WHERE id = ?').get('groceri1');
    await ownerSync([{ kind: 'project', id: 'groceri1', fields: { name: f('Shopping', Date.now(), p.name_ts) } }]);
    let planned = null;
    await e.cycle({ applyPlan: (plan) => { planned = plan; return applyPlanToFolder(plan, lists); } });
    expect(planned.files.groceri1).toBe('Shopping (from nuca)');
    expect(read('Shopping')).toBe('- [ ] mine ^mine0001\n');
    expect(read('Shopping (from nuca)')).toBe('- [ ] milk ^milk0001\n- [ ] bread ^bread001\n');
  });

  it('a view of the folder: only one list, or all but some', () => {
    const { lists, write } = listsFolder();
    write('Work', '- [ ] A ^aaaaaaaa\n'); write('Groceries', '- [ ] milk ^milk0001\n');
    expect(readLocalLists(lists, 0, { only: 'Groceries' }).names).toEqual(['Groceries']);
    expect(readLocalLists(lists, 0, { exclude: new Set(['Groceries']) }).names).toEqual(['Work']);
    expect(readLocalLists(lists, 0, { only: 'Groceries' }).all).toEqual(['Groceries', 'Work']);
    // a line copied out of a shared list: the copy gets the new id, the shared list keeps its own
    write('Work', '- [ ] A ^aaaaaaaa\n- [ ] milk ^milk0001\n');
    const both = readLocalLists(lists, 0, { first: new Set(['Groceries']) });
    expect(both.files.Groceries.status).toBe('ok');
    expect(both.files.Work.status).toBe('unstamped');
  });
});

describe('the Linux/macOS app with a shared list', () => {
  let app;
  let data;
  beforeEach(async () => {
    vi.stubGlobal('fetch', ownerFetch);
    data = join(dir, 'app');
    mkdirSync(join(data, 'lists'), { recursive: true });
    writeFileSync(join(data, 'lists', 'Work.md'), '- [ ] write report ^work0001\n');
    app = await startApp({ dataDir: data, port: 0, interval: 150, cloudInterval: 150, settleMs: 0, reminders: false, watchFiles: false });
  });
  afterEach(async () => { await app.stop(); });
  const until = async (fn, ms = 10_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) { const v = await fn(); if (v) return v; } return fn(); };
  const localApi = async (path, body) => {
    const r = await realFetch(`${app.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };

  it('joins from the invite link, shows the list in the window as shared, and leaves it', async () => {
    const inv = await invite('view');
    const j = await localApi('local/join', { link: inv.link });
    expect(j).toMatchObject({ status: 200, data: { name: 'Groceries' } });
    await until(() => existsSync(join(data, 'lists', 'Groceries.md')));
    // the key is kept privately, not in the lists folder
    const bindings = readFileSync(join(data, 'lists', '.remotes.json'), 'utf8');
    const keys = readFileSync(join(data, 'sync', 'remotes.json'), 'utf8');
    expect(JSON.parse(bindings).remotes[0]).toMatchObject({ file: 'Groceries', server: OWNER, project: 'groceri1', access: 'view' });
    expect(bindings).not.toContain(JSON.parse(keys).tokens[JSON.parse(bindings).remotes[0].id]);
    // the window's store has it (through the lists folder), and knows it is shared and view-only
    const info = await until(async () => { const i = (await localApi('config')).data.local; return i.shares[0]?.projectId ? i : null; });
    expect(info.shares[0]).toMatchObject({ name: 'Groceries', access: 'view', server: OWNER });
    const rows = (await localApi('sync', { deviceId: 'web-test', cursor: 0, changes: [] })).data.changes;
    expect(rows.filter((r) => r.kind === 'task' && r.fields.place.v.project === info.shares[0].projectId).map((r) => r.fields.text.v).sort()).toEqual(['bread', 'milk']);
    // leave: the file goes to .trash, the binding and the key go, the owner's list is untouched
    const id = info.shares[0].id;
    expect((await localApi('local/leave', { id })).status).toBe(200);
    expect(existsSync(join(data, 'lists', 'Groceries.md'))).toBe(false);
    expect(readdirSync(join(data, 'lists', '.trash')).some((n) => n.startsWith('Groceries-'))).toBe(true);
    expect(JSON.parse(readFileSync(join(data, 'lists', '.remotes.json'), 'utf8')).remotes).toEqual([]);
    expect(JSON.parse(readFileSync(join(data, 'sync', 'remotes.json'), 'utf8')).tokens[id]).toBeUndefined();
    expect(owner.d1.db.prepare('SELECT count(*) AS n FROM tasks WHERE project_id = ? AND deleted = 0').get('groceri1').n).toBe(2);
    await until(async () => (await ownerApi('/api/shares', {}, OWNER_KEY)) && owner.d1.db.prepare('SELECT revoked_at FROM shares WHERE id = ?').get(inv.share.id).revoked_at);
  });

  it('when the owner stops sharing it, the file stays as an own list with new ids, and the window is told', async () => {
    const inv = await invite('edit');
    await localApi('local/join', { link: inv.link });
    await until(() => existsSync(join(data, 'lists', 'Groceries.md')));
    await ownerApi('/api/shares/revoke', { id: inv.share.id });
    const info = await until(async () => { const i = (await localApi('config')).data.local; return i.ended.length ? i : null; });
    expect(info.ended[0]).toMatchObject({ name: 'Groceries', kept: true });
    expect(info.shares).toEqual([]);
    const text = readFileSync(join(data, 'lists', 'Groceries.md'), 'utf8');
    expect(text).toMatch(/^- \[ \] milk \^[0-9a-z]{8}\n- \[ \] bread \^[0-9a-z]{8}\n$/);
    expect(text).not.toMatch(/milk0001|bread001/);
    // the window's store follows without holding it back as a mass delete
    await until(async () => {
      const rows = (await localApi('sync', { deviceId: 'web-test', cursor: 0, changes: [] })).data.changes;
      return !rows.some((r) => r.id === 'milk0001' && !r.fields.deleted.v);
    });
    expect(app.files.status.guarded).toBe(0);
  });

  it('shares need cloud sync; the store\'s own sharing routes are not there', async () => {
    const r = await localApi('local/shares/invite', { projectId: 'whatever', alias: 'X', access: 'edit' });
    expect(r.status).toBe(404);   // (not synced to a cloud: there is none)
    expect((await localApi('shares/invite', { projectId: 'x', alias: 'X', access: 'edit' })).status).toBe(404);
    expect((await localApi('local/join', { link: 'https://nope.example/join#code=short' })).status).toBe(400);
    const s = new Shares({ lists: join(data, 'lists'), sync: join(data, 'sync') });
    expect(s.freeName('Work')).toBe('Work (2)');
    expect(s.freeName('Work', 'https://saqme.nuca.workers.dev')).toBe('Work (from nuca)');
  });
});

describe('several owners, this computer\'s own cloud, the same names, moves', () => {
  const OTHER = 'https://other.test';
  const MINE = 'https://mine.test';
  const OTHER_KEY = 'other-key-0123456789abcdef0123456789abcdef';
  const MY_KEY = 'my-key-0123456789abcdef0123456789abcdef0123';
  let other;
  let mine;
  let app = null;   // an app a test started: stopped (its engines finished) before the Workers' databases close
  async function net(url, init = {}) {
    const u = new URL(url);
    const env = { [OWNER]: owner.env, [OTHER]: other.env, [MINE]: mine.env }[u.origin];
    if (!env) return realFetch(url, init);
    return worker.fetch(new Request(u, { method: init.method ?? 'GET', headers: init.headers, body: init.body }), env);
  }
  const call = async (origin, path, body, token) => {
    const r = await net(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const transportTo = (origin, token) => (body) => call(origin, '/api/sync', body, token);
  const until = async (fn, ms = 10_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) { const v = await fn(); if (v) return v; } return fn(); };
  beforeEach(async () => {
    const make = (name, key) => { const d1 = new D1(join(dir, `${name}.db`)); d1.migrate(migrations); return { env: { DB: d1, AUTH_TOKEN: key }, d1 }; };
    other = make('other', OTHER_KEY);
    mine = make('mine', MY_KEY);
    await call(OTHER, '/api/sync', { deviceId: 'other-pc', cursor: 0, changes: [
      { kind: 'project', id: 'groceri2', fields: { name: f('Groceries', 1000), pos: f('a0', 1000) } }, task('apples01', 'groceri2', 'apples')] }, OTHER_KEY);
    vi.stubGlobal('fetch', net);
  });
  afterEach(async () => {
    if (app) { await app.stop(); app = null; }
    other.d1.close(); mine.d1.close();
  });

  it('a list whose name another list has says whose it is; lists of two owners side by side', async () => {
    const { lists, write, read } = listsFolder();
    write('Groceries', '- [ ] my bread ^mybread1\n');
    const shares = new Shares({ lists, sync: join(dir, 'sync'), fetchImpl: net });
    const a = await shares.join((await invite('edit')).link);
    const b = await shares.join((await call(OTHER, '/api/shares/invite', { projectId: 'groceri2', alias: 'Me', access: 'view' }, OTHER_KEY)).data.link);
    expect([a.file, b.file]).toEqual(['Groceries (from owner.test)', 'Groceries (from other.test)']);
    for (const s of [a, b]) {
      await syncCycle({
        state: newState(), statePath: join(dir, `${s.id}.json`), listsDir: lists, transport: transportTo(s.server, shares.token(s.id)), deviceId: shares.deviceId(), settleMs: 0,
        applyPlan: (plan) => applyPlanToFolder(plan, lists), view: { only: s.file }, scope: { project: s.project, file: s.file, readOnly: s.access !== 'edit', label: serverLabel(s.server) },
      });
    }
    expect(read('Groceries (from owner.test)')).toBe('- [ ] milk ^milk0001\n- [ ] bread ^bread001\n');
    expect(read('Groceries (from other.test)')).toBe('- [ ] apples ^apples01\n');
    expect(read('Groceries')).toBe('- [ ] my bread ^mybread1\n');
    expect(shares.freeName('Groceries', OWNER)).toBe('Groceries (from owner.test) (2)');
  });

  it('a list moved here from the browser: the same share with a new key, also onto one this computer has', async () => {
    const { lists } = listsFolder();
    const shares = new Shares({ lists, sync: join(dir, 'sync'), fetchImpl: net });
    const web = (await call(OWNER, '/api/shares/claim', { code: (await invite('edit')).code }, '')).data.token;
    const b = await shares.join((await call(OWNER, '/api/shares/transfer', {}, web)).data.link);
    expect(b).toMatchObject({ file: 'Groceries', project: 'groceri1', access: 'edit' });
    expect((await transportTo(OWNER, web)({ deviceId: 'web', cursor: 0, changes: [] })).data.error).toBe('transferred');
    expect((await transportTo(OWNER, shares.token(b.id))({ deviceId: 'pc', cursor: 0, changes: [] })).status).toBe(200);
    // another browser copy moved onto it: one binding, the newest key, the older one given back
    const web2 = (await call(OWNER, '/api/shares/claim', { code: (await invite('view')).code }, '')).data.token;
    const first = shares.token(b.id);
    const b2 = await shares.join((await call(OWNER, '/api/shares/transfer', {}, web2)).data.link);
    expect(b2.id).toBe(b.id);
    expect(shares.all()).toHaveLength(1);
    expect(shares.token(b.id)).not.toBe(first);
    expect(shares.get(b.id).access).toBe('view');
    await vi.waitFor(async () => expect((await transportTo(OWNER, first)({ deviceId: 'pc', cursor: 0, changes: [] })).status).toBe(401));
  });

  it('Settings > Updates asks this computer\'s own sync service how updating itself stands, through the local server', async () => {
    const data = join(dir, 'app-updates');
    mkdirSync(join(data, 'lists'), { recursive: true });
    app = await startApp({ dataDir: data, port: 0, interval: 150, cloudInterval: 150, settleMs: 0, reminders: false, watchFiles: false });
    const localApi = async (path, body) => {
      const r = await realFetch(`${app.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    };
    expect(await localApi('local/worker-update')).toMatchObject({ status: 409, data: { error: expect.stringMatching(/once sync is set up/) } });
    mkdirSync(join(data, 'sync'), { recursive: true });
    writeFileSync(join(data, 'sync', 'config.json'), JSON.stringify({ url: MINE, token: MY_KEY }));
    Object.assign(mine.env, { SAQME_ACCOUNT_ID: 'acc', SAQME_WORKER_NAME: 'mine' });
    expect(await localApi('local/worker-update')).toMatchObject({ status: 200, data: { knowsItself: true, token: false, auto: true } });
    expect((await localApi('local/worker-update/auto', { on: false })).data.auto).toBe(false);
    expect(await localApi('local/worker-update/now', {})).toMatchObject({ status: 409, data: { error: expect.stringMatching(/no update token/) } });
    expect((await localApi('local/worker-update/token', { token: 'nope' })).status).toBe(400);
    expect((await localApi('local/worker-update', undefined)).data).not.toHaveProperty('error');
  });

  it('with cloud sync: the shared file stays out of it; turning cloud sync off and on keeps the share', async () => {
    const data = join(dir, 'app-cloud');
    mkdirSync(join(data, 'lists'), { recursive: true });
    mkdirSync(join(data, 'sync'), { recursive: true });
    writeFileSync(join(data, 'lists', 'Work.md'), '- [ ] write report ^work0001\n');
    writeFileSync(join(data, 'sync', 'config.json'), JSON.stringify({ url: MINE, token: MY_KEY }));
    app = await startApp({ dataDir: data, port: 0, interval: 150, cloudInterval: 150, settleMs: 0, reminders: false, watchFiles: false });
    const localApi = async (path, body) => {
      const r = await realFetch(`${app.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    };
    const mineTexts = () => mine.d1.db.prepare('SELECT text FROM tasks WHERE deleted = 0').all().map((r) => r.text).sort();
    expect((await localApi('local/join', { link: (await invite('edit')).link })).status).toBe(200);
    await until(() => existsSync(join(data, 'lists', 'Groceries.md')));
    await until(() => mineTexts().length > 0);
    for (let i = 0; i < 2; i++) {   // two more cloud rounds, the shared file there all along
      const since = Date.now();
      await until(() => app.cloud.status.lastSync > since);
    }
    expect(mineTexts()).toEqual(['write report']);
    expect(mine.d1.db.prepare('SELECT name FROM projects').all().map((r) => r.name)).toEqual(['Work']);
    // off: the shared list keeps syncing with its owner
    expect((await localApi('local/disconnect', {})).status).toBe(200);
    const path = join(data, 'lists', 'Groceries.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}- [ ] eggs ^eggs0001\n`);
    age(path);
    await until(() => ownerRow('eggs0001'));
    expect(ownerRow('eggs0001')).toMatchObject({ project_id: 'groceri1', text: 'eggs' });
    expect(JSON.parse(readFileSync(join(data, 'lists', '.remotes.json'), 'utf8')).remotes).toHaveLength(1);
    // on again: one's own lists go on, the shared one still stays out
    writeFileSync(join(data, 'sync', 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(data, 'sync', 'config.json'), 'utf8')), enabled: true }));
    const work = join(data, 'lists', 'Work.md');
    writeFileSync(work, '- [ ] write report ^work0001\n- [ ] call the bank\n');
    age(work);
    await until(() => mineTexts().includes('call the bank'));
    expect(mineTexts()).toEqual(['call the bank', 'write report']);
    expect(JSON.stringify(mine.d1.db.prepare('SELECT * FROM tasks').all())).not.toMatch(/milk|eggs/);
  });
});
