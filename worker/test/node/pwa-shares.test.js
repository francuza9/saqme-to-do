// The phone app's store with shared lists (worker/public/js/store.js): one session per list, rows of a shared
// list only ever from (and to) its owner's server, view-only lists that refuse edits, leaving, and the end of a
// share. A paired app reaches the lists through its own Worker (the relay, worker/src/remotes.js); without a sync
// of its own it reaches only lists of the address it runs at (the owner's, in the browser). Real Workers
// (worker/src on SQLite, like the Linux/macOS app) stand in for the owners' and the person's own sync services.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1 } from '../../../local/d1.mjs';
import worker from '../../src/index.js';
import { Store } from '../../public/js/store.js';

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const OWNER = 'https://owner.test';
const OTHER = 'https://other.test';
const MINE = 'https://mine.test';
const OWNER_KEY = 'owner-key-0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'other-key-0123456789abcdef0123456789abcdef';
const MY_KEY = 'my-key-0123456789abcdef0123456789abcdef0123';

let dir;
let servers;
function server(origin, token) {
  const db = new D1(join(dir, `${new URL(origin).host}.db`));
  db.migrate(MIGRATIONS);
  servers.set(origin, { env: { DB: db, AUTH_TOKEN: token }, db });
}
/** fetch for the stores and the Workers: requests go to the Worker for their origin, in-process. */
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const s = servers.get(u.origin);
  if (!s) throw new TypeError('fetch failed');
  return worker.fetch(new Request(u, { method: init.method ?? 'GET', headers: init.headers, body: init.body }), s.env);
}
async function api(origin, path, { token, body, method = 'POST' } = {}) {
  const res = await fakeFetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const ownerSync = async (changes = [], deviceId = 'owner-pc') => (await api(OWNER, '/api/sync', { token: OWNER_KEY, body: { deviceId, cursor: 0, changes } })).data;
const f = (v, ts, base) => (base === undefined ? { v, ts } : { v, ts, base });
const task = (id, project, text, ts = 1000, parent = null) => ({ kind: 'task', id, fields: { place: f({ project, parent, pos: 'a0' }, ts), text: f(text, ts), status: f(' ', ts), notes: f('', ts), due: f(null, ts) } });
const live = (s, projectId) => s.tasks().filter((t) => !t.fields.deleted.v && t.fields.place.v.project === projectId).map((t) => t.fields.text.v).sort();
const names = (s) => s.projects().map((p) => p.fields.name.v);
const rowsOn = (origin, projectId) => servers.get(origin).db.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projectId);
const allRows = (origin, table) => servers.get(origin).db.db.prepare(`SELECT * FROM ${table}`).all();

async function inviteAt(origin, key, projectId, access = 'edit', alias = 'Nuca') {
  return (await api(origin, '/api/shares/invite', { token: key, body: { projectId, alias, access } })).data;
}
const invite = (access = 'edit', alias = 'Nuca') => inviteAt(OWNER, OWNER_KEY, 'groceri1', access, alias);
/** paired: this device's own sync (MINE); base: the address the app runs at. */
async function newStore({ paired = true, base = MINE } = {}) {
  const s = new Store({ base, autoSync: false });
  await s.open();
  if (paired) s.setMeta({ token: MY_KEY });
  return s;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'saqme-shares-'));
  servers = new Map();
  server(OWNER, OWNER_KEY);
  server(OTHER, OTHER_KEY);
  server(MINE, MY_KEY);
  vi.stubGlobal('fetch', fakeFetch);
  await ownerSync([
    { kind: 'project', id: 'groceri1', fields: { name: f('Groceries', 1000), pos: f('a0', 1000) } },
    { kind: 'project', id: 'diary001', fields: { name: f('Diary', 1000), pos: f('a1', 1000) } },
    task('milk0001', 'groceri1', 'milk'), task('bread001', 'groceri1', 'bread'), task('secret01', 'diary001', 'secret'),
    { kind: 'setting', id: 'notifyAt', fields: { value: f('6:00', 1000) } },
  ]);
  await api(OTHER, '/api/sync', { token: OTHER_KEY, body: { deviceId: 'other-pc', cursor: 0, changes: [
    { kind: 'project', id: 'groceri2', fields: { name: f('Groceries', 1000), pos: f('a0', 1000) } }, task('apples01', 'groceri2', 'apples')] } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of servers.values()) s.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a list shared with this device', () => {
  it('joins through its own sync service, which keeps the key; the list never mixes with its own', async () => {
    const me = await newStore();
    me.addProject('Home');
    await me.sync();
    const share = await me.joinShare((await invite('edit')).link);
    expect(share).toMatchObject({ via: 'relay', remote: expect.stringMatching(/^r/), server: OWNER, projectId: 'groceri1', access: 'edit', name: 'Groceries' });
    expect(share.token).toBeUndefined();
    await me.sync();
    expect(names(me)).toEqual(['Home', 'Groceries']);
    expect(live(me, 'groceri1')).toEqual(['bread', 'milk']);
    expect(me.get('task', 'secret01')).toBeUndefined();
    expect(me.setting('notifyAt')).toBe('');   // the owner's settings stay theirs

    me.addTask('groceri1', { text: 'eggs' });
    me.addTask(me.projects()[0].id, { text: 'water plants' });
    await me.sync();
    expect(rowsOn(OWNER, 'groceri1').map((r) => r.text).sort()).toEqual(['bread', 'eggs', 'milk']);
    // nothing of the shared list in this device's own lists, and nothing of its own on the owner's
    expect(allRows(MINE, 'tasks').map((r) => r.text)).toEqual(['water plants']);
    expect(allRows(MINE, 'projects').map((r) => r.name)).toEqual(['Home']);
    expect(allRows(OWNER, 'tasks').map((r) => r.text)).not.toContain('water plants');
    // the key is on this device's own Worker only: not in the app, not in its lists
    const key = allRows(MINE, 'remotes')[0].token;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(me.meta)).not.toContain(key);
    expect(JSON.stringify([allRows(MINE, 'tasks'), allRows(MINE, 'projects'), allRows(MINE, 'settings')])).not.toContain(key);
  });

  it('without a sync of its own: lists of the address it runs at only (the owner\'s, in the browser)', async () => {
    const away = await newStore({ paired: false });   // its own address, not the list's
    const first = await invite('edit');
    await expect(away.joinShare(first.link)).rejects.toMatchObject({ needsPairing: true, server: OWNER });
    expect(allRows(OWNER, 'shares').filter((s) => s.claimed_at)).toEqual([]);   // the invite is not used up
    const web = await newStore({ paired: false, base: OWNER });
    const s = await web.joinShare(first.link);
    expect(s).toMatchObject({ via: 'direct', server: OWNER, projectId: 'groceri1' });
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await web.sync();
    expect(live(web, 'groceri1')).toEqual(['bread', 'milk']);
    expect(web.status.state).toBe('unpaired');
    web.setTask('milk0001', { status: 'x' });
    await web.sync();
    expect(rowsOn(OWNER, 'groceri1').find((r) => r.id === 'milk0001').status).toBe('x');
  });

  it('a view-only list refuses edits here, and none reach any server', async () => {
    const me = await newStore();
    await me.joinShare((await invite('view')).link);
    await me.sync();
    const refused = vi.fn();
    me.addEventListener('readonly', refused);
    expect(me.setTask('milk0001', { text: 'cream' })).toBe(false);
    expect(me.addTask('groceri1', { text: 'eggs' })).toBeNull();
    me.deleteTask('bread001');
    me.renameProject('groceri1', 'Mine now');
    expect(refused).toHaveBeenCalled();
    expect(me.outbox.size).toBe(0);
    expect(live(me, 'groceri1')).toEqual(['bread', 'milk']);
    expect(me.isReadOnly('groceri1')).toBe(true);
    await me.sync();
    expect(rowsOn(OWNER, 'groceri1').map((r) => r.text).sort()).toEqual(['bread', 'milk']);
  });

  it('follows the owner: their edits, a task moved out of the list (gone without a trace), a change of access', async () => {
    const me = await newStore();
    const inv = await invite('edit');
    await me.joinShare(inv.link);
    await me.sync();
    const milk = rowsOn(OWNER, 'groceri1').find((r) => r.id === 'milk0001');
    await ownerSync([{ kind: 'task', id: 'milk0001', fields: { text: f('oat milk', 5000, milk.text_ts) } },
      { kind: 'task', id: 'bread001', fields: { place: f({ project: 'diary001', parent: null, pos: 'a5' }, 5000, 1000) } }]);
    await me.sync();
    expect(live(me, 'groceri1')).toEqual(['oat milk']);
    expect(me.get('task', 'bread001')).toBeUndefined();
    await api(OWNER, '/api/shares/update', { token: OWNER_KEY, body: { id: inv.share.id, access: 'view' } });
    await me.sync();
    expect(me.isReadOnly('groceri1')).toBe(true);
    expect(allRows(MINE, 'remotes')[0].access).toBe('view');   // its own Worker knows too (its other phones)
  });

  it('keeps what the owner\'s server refused as a notice (the list became view-only meanwhile)', async () => {
    const me = await newStore();
    const inv = await invite('edit');
    await me.joinShare(inv.link);
    await me.sync();
    me.setTask('milk0001', { text: 'my milk' });
    await api(OWNER, '/api/shares/update', { token: OWNER_KEY, body: { id: inv.share.id, access: 'view' } });
    await me.sync();
    expect(me.get('task', 'milk0001').fields.text.v).toBe('milk');   // the owner's version stays
    expect(me.notices()).toEqual([expect.objectContaining({ task: 'milk0001', field: 'text', value: 'my milk', reason: 'this shared list is view-only' })]);
    me.dismissNotice(me.notices()[0].id);
    expect(me.notices()).toEqual([]);
  });

  it('takes from a shared list\'s server only rows of that list', async () => {
    const me = await newStore();
    const home = me.addProject('Home');
    const mine = me.addTask(home, { text: 'mine' });
    await me.sync();
    await me.joinShare((await invite('edit')).link);
    await me.sync();
    const share = me.shareOf('groceri1');
    const evil = [
      { kind: 'project', id: home, seq: 99, fields: { name: { v: 'pwned', ts: 9e12 }, pos: { v: 'a0', ts: 9e12 }, deleted: { v: true, ts: 9e12 } } },
      { kind: 'task', id: mine, seq: 99, fields: { place: { v: { project: 'groceri1', parent: null, pos: 'a0' }, ts: 9e12 }, text: { v: 'pwned', ts: 9e12 }, status: { v: 'x', ts: 9e12 }, due: { v: null, ts: 0 }, notes: { v: '', ts: 0 }, deleted: { v: false, ts: 0 } } },
      { kind: 'task', id: 'other001', seq: 99, fields: { place: { v: { project: home, parent: null, pos: 'a0' }, ts: 1 }, text: { v: 'injected', ts: 1 }, status: { v: ' ', ts: 1 }, due: { v: null, ts: 0 }, notes: { v: '', ts: 0 }, deleted: { v: false, ts: 0 } } },
      { kind: 'task', id: mine, seq: 99, gone: true },
      { kind: 'setting', id: 'notifyAt', seq: 99, fields: { value: { v: '3:00', ts: 9e12 } } },
      { kind: 'project', id: 'newproj1', seq: 99, fields: { name: { v: 'Spam', ts: 1 }, pos: { v: 'a0', ts: 1 }, deleted: { v: false, ts: 0 } } },
    ];
    me.applyRemote(evil, share);
    expect(me.get('project', home).fields.name.v).toBe('Home');
    expect(me.get('task', mine).fields.text.v).toBe('mine');
    expect(me.get('task', 'other001')).toBeUndefined();
    expect(me.get('project', 'newproj1')).toBeUndefined();
    expect(me.setting('notifyAt')).toBe('');
    // and this device's own server cannot touch the shared list either
    me.applyRemote([{ kind: 'task', id: 'milk0001', seq: 5, fields: { place: { v: { project: home, parent: null, pos: 'a0' }, ts: 9e12 }, text: { v: 'stolen', ts: 9e12 }, status: { v: ' ', ts: 1 }, due: { v: null, ts: 0 }, notes: { v: '', ts: 0 }, deleted: { v: false, ts: 0 } } }], null);
    expect(me.get('task', 'milk0001').fields.text.v).toBe('milk');
  });

  it('moving a task between this device\'s lists and a shared one is a copy there and a delete here', async () => {
    const me = await newStore();
    const home = me.addProject('Home');
    const t = me.addTask(home, { text: 'buy lamp' });
    me.addTask(home, { parentId: t, text: 'measure' });
    await me.sync();
    await me.joinShare((await invite('edit')).link);
    await me.sync();
    const nid = me.moveTask(t, { projectId: 'groceri1', parentId: null });
    expect(nid).toBeTruthy();
    expect(nid).not.toBe(t);
    expect(live(me, 'groceri1')).toEqual(['bread', 'buy lamp', 'measure', 'milk']);
    expect(live(me, home)).toEqual([]);
    await me.sync();
    expect(rowsOn(OWNER, 'groceri1').map((r) => r.text).sort()).toEqual(['bread', 'buy lamp', 'measure', 'milk']);
    expect(allRows(MINE, 'tasks').every((r) => r.deleted === 1)).toBe(true);   // restorable here, not moved
  });

  it('reaches the person\'s other phones through their own sync; leaving takes it off all of them', async () => {
    const me = await newStore();
    const other = await newStore();
    const share = await me.joinShare((await invite('edit')).link);
    await me.sync();
    await other.sync();
    expect(other.shares()).toEqual([expect.objectContaining({ via: 'relay', remote: share.remote, projectId: 'groceri1' })]);
    expect(live(other, 'groceri1')).toEqual(['bread', 'milk']);
    const key = allRows(MINE, 'remotes')[0].token;
    me.leaveShare(share.id);
    expect(me.get('project', 'groceri1')).toBeUndefined();
    expect(me.tasks()).toEqual([]);
    expect(me.shares()).toEqual([]);
    await vi.waitFor(() => expect(allRows(MINE, 'remotes')[0].state).toBe('left'));
    expect((await api(OWNER, '/api/sync', { token: key, body: { deviceId: 'x', cursor: 0, changes: [] } })).status).toBe(401);
    expect(rowsOn(OWNER, 'groceri1')).toHaveLength(2);   // the owner's list stays
    await me.sync();
    expect(me.shares()).toEqual([]);   // not brought back by its own sync
    expect(me.meta.leaving).toEqual([]);
    await other.sync();
    expect(other.shares()).toEqual([]);
    expect(other.get('project', 'groceri1')).toBeUndefined();
    expect(allRows(MINE, 'tasks')).toEqual([]);
  });

  it('when the owner stops sharing it, one phone keeps it as an own list (new ids), the others get that copy', async () => {
    const me = await newStore();
    const other = await newStore();
    const inv = await invite('view');
    await me.joinShare(inv.link);
    await me.sync();
    await other.sync();
    const ended = vi.fn();
    const endedThere = vi.fn();
    me.addEventListener('shareended', (e) => ended(e.detail));
    other.addEventListener('shareended', (e) => endedThere(e.detail));
    await api(OWNER, '/api/shares/revoke', { token: OWNER_KEY, body: { id: inv.share.id } });
    await me.sync();
    expect(ended).toHaveBeenCalledWith({ name: 'Groceries', kept: true });
    expect(me.shares()).toEqual([]);
    const p = me.projects().find((x) => x.fields.name.v === 'Groceries');
    expect(p.id).not.toBe('groceri1');
    expect(live(me, p.id)).toEqual(['bread', 'milk']);
    expect(me.get('task', 'milk0001')).toBeUndefined();
    expect(me.setTask(me.tasks().find((x) => x.fields.text.v === 'milk').id, { status: 'x' })).toBe(true);   // editable now
    await me.sync();
    expect(allRows(MINE, 'tasks').map((r) => r.text).sort()).toEqual(['bread', 'milk']);   // now synced with its own server
    await other.sync();
    expect(endedThere).toHaveBeenCalledWith({ name: 'Groceries', kept: true, elsewhere: true });
    expect(other.shares()).toEqual([]);
    expect(names(other)).toEqual(['Groceries']);   // the copy, once
    expect(live(other, other.projects()[0].id)).toEqual(['bread', 'milk']);
  });

  it('refuses to join a list it already has, or one of its own', async () => {
    const me = await newStore();
    const home = me.addProject('Home');
    await me.sync();
    await me.joinShare((await invite('edit')).link);
    await me.sync();
    await expect(me.joinShare((await invite('edit', 'Nuca again')).link)).rejects.toThrow(/already here/);
    await expect(me.joinShare((await invite('edit')).link.replace(/code=.*/, 'code=AAAAAAAAAAAAAAAAAAAAAA'))).rejects.toThrow(/already used|expired|cancelled/);
    await expect(me.joinShare('https://owner.test/#pair=kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk')).rejects.toThrow(/not an invite link/);
    await expect(me.joinShare((await inviteAt(MINE, MY_KEY, home)).link)).rejects.toThrow(/one of your own lists/);
    expect(me.shares()).toHaveLength(1);
  });

  it('keeps a shared tab\'s place on this device only', async () => {
    const me = await newStore();
    const a = me.addProject('A');
    me.addProject('B');
    await me.sync();
    await me.joinShare((await invite('edit')).link);
    await me.sync();
    expect(names(me)).toEqual(['A', 'B', 'Groceries']);
    me.moveProject('groceri1', -1);
    me.moveProject('groceri1', -1);
    expect(names(me)).toEqual(['Groceries', 'A', 'B']);
    me.moveProject(a, 1);
    await me.sync();
    expect(names(me)).toEqual(['Groceries', 'B', 'A']);
    expect(servers.get(OWNER).db.db.prepare('SELECT position FROM projects WHERE id = ?').get('groceri1').position).toBe('a0');
  });

  it('the owner\'s device learns which of its lists are shared', async () => {
    const owner = new Store({ base: OWNER, autoSync: false });
    await owner.open();
    owner.setMeta({ token: OWNER_KEY });
    await owner.sync();
    expect(owner.sharedByMe('groceri1')).toBe(false);
    await invite('view');
    await owner.sync();
    expect(owner.sharedByMe('groceri1')).toBe(true);
    expect(owner.sharedByMe('diary001')).toBe(false);
  });
});

describe('own sync on and off, moving in from the browser', () => {
  it('unpaired, its shared lists wait (kept, with their edits); paired again, they go on', async () => {
    const me = await newStore();
    await me.joinShare((await invite('edit')).link);
    await me.sync();
    me.unpair();
    me.setTask('milk0001', { status: 'x' });
    await me.sync();
    expect(me.shareStatus.get(me.shares()[0].id).state).toBe('paused');
    expect(rowsOn(OWNER, 'groceri1').find((r) => r.id === 'milk0001').status).toBe(' ');
    expect(live(me, 'groceri1')).toEqual(['bread', 'milk']);
    me.pair(MY_KEY);
    await me.sync();
    expect(me.shares()).toHaveLength(1);
    expect(rowsOn(OWNER, 'groceri1').find((r) => r.id === 'milk0001').status).toBe('x');
  });

  it('"Move to my Saqme app": the paired app takes the list over, the browser copy stops and goes', async () => {
    const web = await newStore({ paired: false, base: OWNER });
    await web.joinShare((await invite('edit')).link);
    await web.sync();
    web.setTask('milk0001', { text: 'oat milk' });
    await web.sync();
    const moved = vi.fn();
    web.addEventListener('sharemoved', (e) => moved(e.detail));
    const m = await web.transferShare(web.shares()[0].id);
    expect(m.link).toMatch(/^https:\/\/owner\.test\/join#code=/);
    const me = await newStore();
    const s = await me.joinShare(m.link);
    expect(s).toMatchObject({ via: 'relay', projectId: 'groceri1', access: 'edit' });
    await me.sync();
    expect(live(me, 'groceri1')).toEqual(['bread', 'oat milk']);
    await web.sync();
    expect(moved).toHaveBeenCalledWith({ name: 'Groceries' });
    expect(web.shares()).toEqual([]);
    expect(web.get('project', 'groceri1')).toBeUndefined();
    expect((await api(OWNER, '/api/shares?project=groceri1', { token: OWNER_KEY, method: 'GET' })).data.shares).toHaveLength(1);   // the same person
  });

  it('paired after using a list in the browser: its key goes to its own Worker, which syncs it from then on', async () => {
    vi.stubGlobal('location', { origin: OWNER });   // the app served by the owner's Worker, then paired with one's own
    const web = new Store({ autoSync: false });
    await web.open();
    await web.joinShare((await invite('edit')).link);
    await web.sync();
    expect(web.shares()[0].via).toBe('direct');
    web.setMeta({ token: MY_KEY, server: MINE });
    await web.sync();
    expect(web.shares()[0]).toMatchObject({ via: 'relay', server: OWNER, projectId: 'groceri1' });
    expect(web.shares()[0].token).toBeUndefined();
    expect(allRows(MINE, 'remotes')).toHaveLength(1);
    web.setTask('milk0001', { status: 'x' });
    await web.sync();
    expect(rowsOn(OWNER, 'groceri1').find((r) => r.id === 'milk0001').status).toBe('x');
  });
});

describe('everything at once', () => {
  it('its own sync, lists from two owners, one of its own shared out; lists of the same name stay apart', async () => {
    const me = await newStore();
    const home = me.addProject('Groceries');   // its own list of that name
    me.addTask(home, { text: 'my bread' });
    await me.sync();
    await me.joinShare((await invite('edit')).link);
    await me.sync();
    await me.joinShare((await inviteAt(OTHER, OTHER_KEY, 'groceri2', 'edit')).link);
    await inviteAt(MINE, MY_KEY, home, 'view', 'Lia');   // and shares its own
    await me.sync();   // (the run the join started)
    await me.sync();
    expect(names(me)).toEqual(['Groceries', 'Groceries', 'Groceries']);
    expect(me.shares().map((s) => s.server)).toEqual([OWNER, OTHER]);
    expect(live(me, home)).toEqual(['my bread']);
    expect(live(me, 'groceri1')).toEqual(['bread', 'milk']);
    expect(live(me, 'groceri2')).toEqual(['apples']);
    expect(me.sharedByMe(home)).toBe(true);
    expect(me.sharedByMe('groceri1')).toBe(false);
    // each change goes to the server its list is on, and only there
    me.addTask('groceri2', { text: 'pears' });
    me.addTask('groceri1', { text: 'eggs' });
    me.addTask(home, { text: 'jam' });
    await me.sync();
    expect(rowsOn(OTHER, 'groceri2').map((r) => r.text).sort()).toEqual(['apples', 'pears']);
    expect(rowsOn(OWNER, 'groceri1').map((r) => r.text).sort()).toEqual(['bread', 'eggs', 'milk']);
    expect(allRows(MINE, 'tasks').map((r) => r.text).sort()).toEqual(['jam', 'my bread']);
    expect(allRows(OWNER, 'tasks').map((r) => r.text)).not.toContain('pears');
    expect(allRows(OTHER, 'tasks').map((r) => r.text)).not.toContain('eggs');
    // another phone of the same person gets both shared lists through its own sync
    const other = await newStore();
    await other.sync();
    expect(other.shares().map((s) => s.server).sort()).toEqual([OTHER, OWNER]);
    expect(live(other, 'groceri2')).toEqual(['apples', 'pears']);
  });
});
