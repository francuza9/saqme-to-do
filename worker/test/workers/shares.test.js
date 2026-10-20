// Shared lists (src/shares.js, the scope in src/sync.js): the security boundary. A shared list's key reaches its
// one project and nothing else, a view key changes nothing, and a revoked key stops working at once.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index.js';
import { INVITE_TTL, claimInvite, createInvite, digestHex } from '../../src/shares.js';
import { scopeChanges, loadState } from '../../src/sync.js';

const OWNER = env.AUTH_TOKEN;
const SHARED = 'shared01';
const PRIVATE = 'private1';
const ORIGIN = 'https://saqme.test';

async function call(path, { method = 'POST', body, token = OWNER, origin } = {}) {
  const ctx = createExecutionContext();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function ok(path, opts) {
  const res = await call(path, opts);
  const data = await res.json();
  expect(res.status, JSON.stringify(data)).toBe(200);
  return data;
}
const sync = (token, changes = [], cursor = 0, deviceId = 'dev1') => ok('/api/sync', { body: { deviceId, cursor, changes }, token });
const f = (v, ts, base) => (base === undefined ? { v, ts } : { v, ts, base });
const project = (id, name, ts = 1000) => ({ kind: 'project', id, fields: { name: f(name, ts), pos: f('a0', ts) } });
const task = (id, projectId, { ts = 1000, text = `task ${id}`, parent = null, pos = 'a0' } = {}) => ({
  kind: 'task', id, fields: { place: f({ project: projectId, parent, pos }, ts), text: f(text, ts), status: f(' ', ts), notes: f('', ts), due: f(null, ts) },
});
const ids = (out, kind) => out.changes.filter((c) => c.kind === kind).map((c) => c.id).sort();
const seqNow = async () => Number(await env.DB.prepare(`SELECT value FROM meta WHERE key = 'seq'`).first('value'));
const row = (id) => env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first();

/** The owner's lists: a shared one and a private one, a setting, and a conflict in each project. */
async function ownerData() {
  await sync(OWNER, [project(SHARED, 'Groceries'), project(PRIVATE, 'Diary'),
    task('sharedt1', SHARED), task('sharedt2', SHARED, { parent: 'sharedt1' }), task('privatt1', PRIVATE, { text: 'secret' }),
    { kind: 'setting', id: 'notifyAt', fields: { value: f('9:00', 1000) } }], 0, 'owner-pc');
  // concurrent edits from two of the owner's devices: one conflict per project
  await sync(OWNER, [{ kind: 'task', id: 'sharedt1', fields: { text: f('milk', 3000, 1000) } }, { kind: 'task', id: 'privatt1', fields: { text: f('secret 2', 3000, 1000) } }], 0, 'owner-phone');
  await sync(OWNER, [{ kind: 'task', id: 'sharedt1', fields: { text: f('oat milk', 2000, 1000) } }, { kind: 'task', id: 'privatt1', fields: { text: f('secret 3', 2000, 1000) } }], 0, 'owner-pc');
}
async function invite(access = 'edit', alias = 'Nuca', projectId = SHARED) {
  return ok('/api/shares/invite', { body: { projectId, alias, access } });
}
async function join(access = 'edit') {
  const inv = await invite(access);
  const claimed = await ok('/api/shares/claim', { body: { code: inv.code }, token: null });
  return { ...claimed, shareId: inv.share.id, code: inv.code };
}

beforeEach(async () => {
  await env.DB.batch(['tasks', 'projects', 'settings', 'conflicts', 'push_subscriptions', 'notified', 'shares', 'moved_out', 'share_push', 'remotes', 'remote_tasks']
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`))
    .concat(env.DB.prepare(`UPDATE meta SET value = '0' WHERE key = 'seq'`)));
  await ownerData();
});

describe('invites (the owner)', () => {
  it('only the owner can invite, and only to a list that is on the server', async () => {
    expect((await call('/api/shares/invite', { body: { projectId: SHARED, alias: 'Nuca', access: 'edit' }, token: null })).status).toBe(401);
    expect((await call('/api/shares/invite', { body: { projectId: SHARED, alias: 'Nuca', access: 'edit' }, token: 'wrong-key-0123456789abcdef0123456789' })).status).toBe(401);
    expect((await call('/api/shares/invite', { body: { projectId: 'nosuchp1', alias: 'Nuca', access: 'edit' } })).status).toBe(404);
    expect((await call('/api/shares/invite', { body: { projectId: SHARED, alias: '  ', access: 'edit' } })).status).toBe(400);
    expect((await call('/api/shares/invite', { body: { projectId: SHARED, alias: 'Nuca', access: 'admin' } })).status).toBe(400);
    expect((await call('/api/shares/invite', { body: { projectId: SHARED, alias: 'x'.repeat(61), access: 'view' } })).status).toBe(400);
    const inv = await invite('view', ' Nuca\n');
    expect(inv.share).toMatchObject({ projectId: SHARED, alias: 'Nuca', access: 'view', state: 'pending', joinedAt: null });
    expect(inv.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(inv.link).toBe(`${ORIGIN}/join#code=${inv.code}`);   // the code after '#': never in a server log
    expect(inv.expiresAt - Date.now()).toBeGreaterThan(INVITE_TTL - 10_000);
  });

  it('stores only digests of invite codes and keys', async () => {
    const j = await join();
    const r = await env.DB.prepare('SELECT * FROM shares WHERE id = ?1').bind(j.shareId).first();
    expect(r.token_hash).toBe(await digestHex(j.token));
    expect(r.invite_code_hash).toBeNull();
    const all = JSON.stringify((await env.DB.prepare('SELECT * FROM shares').all()).results);
    expect(all).not.toContain(j.token);
    expect(all).not.toContain(j.code);
  });

  it('lists who a list is shared with; changes access; revokes; cancels invites', async () => {
    const a = await join('edit');
    const pending = await invite('view', 'Dato');
    const other = await invite('view', 'Someone', PRIVATE);
    let { shares } = await ok(`/api/shares?project=${SHARED}`, { method: 'GET' });
    expect(shares.map((s) => [s.alias, s.access, s.state])).toEqual([['Nuca', 'edit', 'joined'], ['Dato', 'view', 'pending']]);
    expect(shares[0].joinedAt).toBeGreaterThan(0);
    expect((await ok('/api/shares', { method: 'GET' })).shares).toHaveLength(3);
    expect((await call(`/api/shares?project=${SHARED}`, { method: 'GET', token: a.token })).status).toBe(403);

    expect((await ok('/api/shares/update', { body: { id: a.shareId, access: 'view' } })).share.access).toBe('view');
    expect((await call('/api/shares/update', { body: { id: a.shareId, access: 'owner' } })).status).toBe(400);
    await ok('/api/shares/revoke', { body: { id: pending.share.id } });   // cancel an invite
    expect((await call('/api/shares/claim', { body: { code: pending.code }, token: null })).status).toBe(400);
    expect((await call('/api/shares/revoke', { body: { id: pending.share.id } })).status).toBe(404);
    ({ shares } = await ok(`/api/shares?project=${SHARED}`, { method: 'GET' }));
    expect(shares.map((s) => s.alias)).toEqual(['Nuca']);
    expect(other.share.projectId).toBe(PRIVATE);
  });

  it('the owner\'s sync says which lists are shared (joined or with an open invite)', async () => {
    expect((await sync(OWNER)).shared).toEqual([]);
    const j = await join();
    expect((await sync(OWNER)).shared).toEqual([SHARED]);
    await ok('/api/shares/revoke', { body: { id: j.shareId } });
    expect((await sync(OWNER)).shared).toEqual([]);
    await invite('view');
    expect((await sync(OWNER)).shared).toEqual([SHARED]);
  });
});

describe('claiming an invite', () => {
  it('trades the code for a key once, across origins, and says what list it is', async () => {
    const inv = await invite('view');
    const res = await call('/api/shares/claim', { body: { code: inv.code }, token: null, origin: 'https://someone-else.workers.dev' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const data = await res.json();
    expect(data).toMatchObject({ projectId: SHARED, projectName: 'Groceries', access: 'view', ownerUrl: ORIGIN });
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(data.token).not.toBe(OWNER);
    const again = await call('/api/shares/claim', { body: { code: inv.code }, token: null });
    expect(again.status).toBe(400);
    expect((await again.json()).token).toBeUndefined();
  });

  it('two claims of one code at the same moment: one wins', async () => {
    const inv = await invite();
    const results = await Promise.all(Array.from({ length: 6 }, () => claimInvite(env, { code: inv.code }, ORIGIN).then((r) => r, () => null)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('an expired, cancelled or wrong code gets nothing, and a wrong one writes nothing', async () => {
    const now = Date.now();
    const old = await createInvite(env, { projectId: SHARED, alias: 'Late', access: 'edit' }, ORIGIN, now - INVITE_TTL - 1);
    expect((await call('/api/shares/claim', { body: { code: old.code }, token: null })).status).toBe(400);
    for (const code of [undefined, null, 42, '', 'short', 'x'.repeat(65), `${old.code}x`, 'AAAAAAAAAAAAAAAAAAAAAA']) {
      expect((await call('/api/shares/claim', { body: { code }, token: null })).status).toBe(400);
    }
    expect((await call('/api/shares/claim', { body: null, token: null })).status).toBe(400);
    const before = await seqNow();
    const snapshot = JSON.stringify((await env.DB.prepare('SELECT * FROM shares').all()).results);
    await call('/api/shares/claim', { body: { code: 'BBBBBBBBBBBBBBBBBBBBBB' }, token: null });
    expect(JSON.stringify((await env.DB.prepare('SELECT * FROM shares').all()).results)).toBe(snapshot);
    expect(await seqNow()).toBe(before);
    const list = (await ok('/api/shares', { method: 'GET' })).shares;
    expect(list.find((s) => s.alias === 'Late').state).toBe('expired');
  });

  it('cannot join a list the owner deleted', async () => {
    const inv = await invite();
    await sync(OWNER, [{ kind: 'project', id: SHARED, fields: { deleted: f(true, 5000, 0) } }], 0, 'owner-pc');
    expect((await call('/api/shares/claim', { body: { code: inv.code }, token: null })).status).toBe(400);
  });
});

describe('a shared list\'s key', () => {
  it('sees its project, the project\'s tasks and their conflicts, nothing else', async () => {
    const { token } = await join('view');
    const out = await sync(token);
    expect(ids(out, 'project')).toEqual([SHARED]);
    expect(ids(out, 'task')).toEqual(['sharedt1', 'sharedt2']);
    expect(ids(out, 'setting')).toEqual([]);
    const conflicts = out.changes.filter((c) => c.kind === 'conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ task: 'sharedt1', device: '' });   // not which of the owner's devices
    expect(JSON.stringify(out)).not.toMatch(/secret|Diary|private1|privatt1|9:00/);
    expect(out.share).toEqual({ projectId: SHARED, access: 'view' });
    expect(out.shared).toBeUndefined();
    expect(out.remotes).toBeUndefined();   // (nor the lists others share with the owner)
    // and only what changed in it since: the owner's edits elsewhere move the cursor, but send nothing
    await sync(OWNER, [{ kind: 'task', id: 'privatt1', fields: { notes: f('more secret', 9000, 1000) } }], 0, 'owner-pc');
    const next = await sync(token, [], out.cursor);
    expect(next.changes).toEqual([]);
    expect(next.cursor).toBeGreaterThan(out.cursor);
  });

  it('with edit access: adds, changes, checks off, reorders, nests and deletes tasks of the list', async () => {
    const { token } = await join('edit');
    const t1 = await row('sharedt1');
    const out = await sync(token, [
      task('newtask1', SHARED, { ts: 4000, text: 'bread', pos: 'a1' }),
      task('newtask2', SHARED, { ts: 4000, text: 'butter', parent: 'newtask1' }),
      { kind: 'task', id: 'sharedt1', fields: { status: f('x', 4000, t1.status_ts), text: f('soy milk', 4000, t1.text_ts) } },
      { kind: 'task', id: 'sharedt2', fields: { place: f({ project: SHARED, parent: null, pos: 'a2' }, 4000, 1000) } },
    ]);
    expect(out.rejected).toEqual([]);
    expect((await row('newtask2')).parent_id).toBe('newtask1');
    expect(await row('sharedt1')).toMatchObject({ status: 'x', text: 'soy milk' });
    expect((await row('sharedt2')).parent_id).toBeNull();
    await sync(token, [{ kind: 'task', id: 'newtask1', fields: { deleted: f(true, 5000, 4000) } }], out.cursor);
    expect((await row('newtask1')).deleted).toBe(1);
    // the owner sees it all
    const owner = await sync(OWNER, [], 0, 'owner-pc');
    expect(owner.changes.find((c) => c.id === 'newtask2').fields.text.v).toBe('butter');
  });

  it('can resolve conflicts of the list, not of the owner\'s other lists', async () => {
    const { token } = await join('edit');
    const all = (await sync(OWNER, [], 0, 'owner-pc')).changes.filter((c) => c.kind === 'conflict');
    const mine = all.find((c) => c.task === 'sharedt1');
    const theirs = all.find((c) => c.task === 'privatt1');
    const out = await sync(token, [
      { kind: 'conflict', id: mine.id, fields: { resolved: f(true, 6000, mine.fields.resolved.ts) } },
      { kind: 'conflict', id: theirs.id, fields: { resolved: f(true, 6000, theirs.fields.resolved.ts) } },
    ]);
    expect(out.rejected).toEqual([{ kind: 'conflict', id: theirs.id, reason: 'not in this shared list' }]);
    const resolved = (await env.DB.prepare('SELECT id, resolved FROM conflicts').all()).results;
    expect(resolved.find((c) => c.id === mine.id).resolved).toBe(1);
    expect(resolved.find((c) => c.id === theirs.id).resolved).toBe(0);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('refuses every change outside the list, and never sends back what is outside', async () => {
    const { token } = await join('edit');
    const before = await seqNow();
    const priv = await row('privatt1');
    const out = await sync(token, [
      task('newtask3', PRIVATE, { ts: 4000 }),                                                                      // a task in another list
      { kind: 'task', id: 'privatt1', fields: { text: f('hacked', 4000, priv.text_ts) } },                            // edit one of the owner's other tasks
      { kind: 'task', id: 'privatt1', fields: { deleted: f(true, 4000, priv.deleted_ts) } },                          // delete it
      { kind: 'task', id: 'privatt1', fields: { place: f({ project: SHARED, parent: null, pos: 'a5' }, 4000, priv.place_ts) } },   // move it in
      task('privatt1', SHARED, { ts: 4000 }),                                                                         // "create" it in the list
      task('newtask4', SHARED, { ts: 4000, parent: 'privatt1' }),                                                     // under one of the owner's other tasks
      { kind: 'project', id: PRIVATE, fields: { name: f('mine now', 4000, 1000) } },
      { kind: 'project', id: 'newproj1', fields: { name: f('new list', 4000), pos: f('a9', 4000) } },
      { kind: 'setting', id: 'notifyAt', fields: { value: f('6:00', 4000, 1000) } },
      { kind: 'setting', id: 'tz', fields: { value: f('Asia/Tbilisi', 4000) } },
    ]);
    expect(out.rejected.map((r) => [r.id, r.reason])).toEqual([
      ['newtask3', 'not in this shared list'], ['privatt1', 'not in this shared list'], ['privatt1', 'not in this shared list'],
      ['privatt1', 'not in this shared list'], ['privatt1', 'not in this shared list'], ['newtask4', 'not in this shared list'],
      ['private1', 'only the owner can change the list itself'], ['newproj1', 'only the owner can change the list itself'],
      ['notifyAt', 'only the owner can change the list itself'], ['tz', 'only the owner can change the list itself'],
    ]);
    expect(await seqNow()).toBe(before);   // nothing written
    expect(await row('privatt1')).toMatchObject({ project_id: PRIVATE, text: 'secret 2', deleted: 0 });
    expect(await row('newtask3')).toBeNull();
    expect(JSON.stringify(out.changes)).not.toMatch(/secret|Diary|private1|privatt1/);
  });

  it('refuses moving a task out of the list, the list\'s rename, reorder and delete; its copy reverts', async () => {
    const { token } = await join('edit');
    const t1 = await row('sharedt1');
    const out = await sync(token, [
      { kind: 'task', id: 'sharedt1', fields: { place: f({ project: PRIVATE, parent: null, pos: 'a0' }, 4000, t1.place_ts), text: f('moved', 4000, t1.text_ts) } },
      { kind: 'project', id: SHARED, fields: { name: f('Renamed', 4000, 1000), pos: f('a5', 4000, 1000), deleted: f(true, 4000, 0) } },
    ], await seqNow());
    expect(out.rejected).toEqual([
      { kind: 'task', id: 'sharedt1', field: 'place', reason: 'tasks cannot move out of a shared list' },
      { kind: 'project', id: SHARED, reason: 'only the owner can change the list itself' },
    ]);
    expect(await row('sharedt1')).toMatchObject({ project_id: SHARED, text: 'milk' });
    // the device gets the list's rows back as they are (its copy reverts)
    expect(out.changes.find((c) => c.id === 'sharedt1').fields.text.v).toBe('milk');
    expect(out.changes.find((c) => c.id === SHARED).fields.name.v).toBe('Groceries');
    expect((await env.DB.prepare('SELECT name, deleted FROM projects WHERE id = ?1').bind(SHARED).first())).toEqual({ name: 'Groceries', deleted: 0 });
  });

  it('with view access: every change is refused, nothing is written, the rows come back unchanged', async () => {
    const { token } = await join('view');
    const before = await seqNow();
    const t1 = await row('sharedt1');
    const all = (await sync(OWNER, [], 0, 'owner-pc')).changes.filter((c) => c.kind === 'conflict');
    const c1 = all.find((c) => c.task === 'sharedt1');
    const out = await sync(token, [
      { kind: 'task', id: 'sharedt1', fields: { status: f('x', 4000, t1.status_ts) } },
      { kind: 'task', id: 'sharedt2', fields: { deleted: f(true, 4000, 1000) } },
      task('newtask5', SHARED, { ts: 4000 }),
      { kind: 'conflict', id: c1.id, fields: { resolved: f(true, 4000, c1.fields.resolved.ts) } },
    ], before);
    expect(out.rejected.map((r) => r.reason)).toEqual(Array(4).fill('this shared list is view-only'));
    expect(await seqNow()).toBe(before);
    expect(await row('sharedt1')).toMatchObject({ status: ' ' });
    expect(await row('newtask5')).toBeNull();
    expect(ids(out, 'task')).toEqual(['sharedt1', 'sharedt2']);
    expect(out.changes.find((c) => c.id === 'sharedt2').fields.deleted.v).toBe(false);
  });

  it('a change of access applies from the next sync', async () => {
    const j = await join('edit');
    await ok('/api/shares/update', { body: { id: j.shareId, access: 'view' } });
    const out = await sync(j.token, [task('newtask6', SHARED, { ts: 4000 })]);
    expect(out.share.access).toBe('view');
    expect(out.rejected[0].reason).toBe('this shared list is view-only');
    await ok('/api/shares/update', { body: { id: j.shareId, access: 'edit' } });
    expect((await sync(j.token, [task('newtask6', SHARED, { ts: 4000 })])).rejected).toEqual([]);
  });

  it('once revoked it gets 401 at once, everywhere', async () => {
    const j = await join('edit');
    expect((await sync(j.token)).changes.length).toBeGreaterThan(0);
    await ok('/api/shares/revoke', { body: { id: j.shareId } });
    for (const [path, method, body] of [['/api/sync', 'POST', { deviceId: 'dev1', cursor: 0, changes: [] }], ['/api/config', 'GET'], ['/api/push/subscribe', 'POST', {}]]) {
      const res = await call(path, { method, body, token: j.token });
      expect(res.status, path).toBe(401);
      expect((await res.json()).error).toBe('revoked');
    }
    // revoking one person leaves the others
    const k = await join('view');
    expect((await sync(k.token)).share.access).toBe('view');
  });

  it('can end itself (the person left the list on their device); the list stays as it is', async () => {
    const j = await join('edit');
    const before = await seqNow();
    await ok('/api/shares/leave', { token: j.token, body: {} });
    expect((await call('/api/sync', { body: { deviceId: 'dev1', cursor: 0, changes: [] }, token: j.token })).status).toBe(401);
    expect(await seqNow()).toBe(before);
    expect((await ok(`/api/shares?project=${SHARED}`, { method: 'GET' })).shares).toEqual([]);
    expect((await env.DB.prepare('SELECT deleted FROM projects WHERE id = ?1').bind(SHARED).first('deleted'))).toBe(0);
    expect((await call('/api/shares/leave', { token: OWNER, body: {} })).status).toBe(404);   // the owner's key has no share to leave
  });

  it('works for its sync, its own reminders and its move, nothing else', async () => {
    const { token } = await join('edit');
    const routes = [['/api/pair/code', 'POST', {}], ['/api/shares', 'GET'], ['/api/shares/invite', 'POST', { projectId: SHARED, alias: 'Me again', access: 'edit' }],
      ['/api/shares/update', 'POST', { id: 'sxxxxxxxxxxxxxxx', access: 'edit' }], ['/api/shares/revoke', 'POST', { id: 'sxxxxxxxxxxxxxxx' }],
      ['/api/remotes/join', 'POST', { link: 'https://other.test/join#code=cccccccccccccccccccccc' }], ['/api/remotes/adopt', 'POST', {}], ['/api/remotes', 'GET'],
      ['/api/remotes/r000000000000000/sync', 'POST', {}], ['/api/remotes/r000000000000000/leave', 'POST', {}], ['/api/nope', 'GET']];
    for (const [path, method, body] of routes) {
      const res = await call(path, { method, body, token });
      expect(res.status, path).toBe(403);
    }
    // its reminders (someone using the list in the browser from here): subscriptions of its own, not the owner's
    expect((await ok('/api/config', { method: 'GET', token })).vapidPublicKey).toBeDefined();
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'a', auth: 'b' } };
    expect((await call('/api/push/subscribe', { body: { subscription: { ...subscription, endpoint: 'https://evil.example/x' } }, token })).status).toBe(400);
    await ok('/api/push/subscribe', { body: { subscription, tz: 'Europe/Berlin', notifyAt: '7:30' }, token });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM push_subscriptions').first('n'))).toBe(0);
    expect((await env.DB.prepare('SELECT tz, notify_at FROM share_push').first())).toEqual({ tz: 'Europe/Berlin', notify_at: '7:30' });
    await ok('/api/push/unsubscribe', { body: { endpoint: subscription.endpoint }, token });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM share_push').first('n'))).toBe(0);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM shares').first('n'))).toBe(1);
  });

  it('moves to another of its person\'s apps: a one-time code for the same share, and the old key is told', async () => {
    const j = await join('view');
    await ok('/api/push/subscribe', { body: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'a', auth: 'b' } } }, token: j.token });
    const move = await ok('/api/shares/transfer', { token: j.token, body: {} });
    expect(move.link).toBe(`${ORIGIN}/join#code=${move.code}`);
    expect((await ok(`/api/shares?project=${SHARED}`, { method: 'GET' })).shares).toEqual([expect.objectContaining({ id: j.shareId, state: 'joined' })]);
    const moved = await ok('/api/shares/claim', { body: { code: move.code }, token: null });
    expect(moved).toMatchObject({ kind: 'move', projectId: SHARED, access: 'view' });
    expect(moved.token).not.toBe(j.token);
    const old = await call('/api/sync', { body: { deviceId: 'dev1', cursor: 0, changes: [] }, token: j.token });
    expect(old.status).toBe(401);
    expect((await old.json()).error).toBe('transferred');
    expect((await sync(moved.token)).share).toEqual({ projectId: SHARED, access: 'view' });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM share_push').first('n'))).toBe(0);   // its new app reminds them
    expect((await call('/api/shares/claim', { body: { code: move.code }, token: null })).status).toBe(400);   // once
    expect((await ok(`/api/shares?project=${SHARED}`, { method: 'GET' })).shares).toHaveLength(1);
    // a revoked share has no move
    await ok('/api/shares/revoke', { body: { id: j.shareId } });
    expect((await call('/api/shares/transfer', { token: moved.token, body: {} })).status).toBe(401);
  });

  it('remembers when it is used through its person\'s own Worker (that one reminds them then)', async () => {
    const j = await join('edit');
    await sync(j.token);
    expect((await env.DB.prepare('SELECT relayed_at FROM shares').first('relayed_at'))).toBeNull();
    const ctx = createExecutionContext();
    await worker.fetch(new Request(`${ORIGIN}/api/sync`, {
      method: 'POST', headers: { authorization: `Bearer ${j.token}`, 'content-type': 'application/json', 'x-saqme-relay': '1' }, body: JSON.stringify({ deviceId: 'phone', cursor: 0, changes: [] }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare('SELECT relayed_at FROM shares').first('relayed_at'))).toBeGreaterThan(0);
  });

  it('is told when the owner moves a task out of the list or deletes one, without what became of it', async () => {
    const { token } = await join('view');
    const first = await sync(token);
    const t2 = await row('sharedt2');
    await sync(OWNER, [{ kind: 'task', id: 'sharedt2', fields: { place: f({ project: PRIVATE, parent: null, pos: 'a3' }, 5000, t2.place_ts), text: f('now private', 5000, t2.text_ts) } }], 0, 'owner-pc');
    const out = await sync(token, [], first.cursor);
    expect(out.changes).toEqual([{ kind: 'task', id: 'sharedt2', seq: expect.any(Number), gone: true }]);
    // and again when it comes back, then leaves again
    const t2b = await row('sharedt2');
    await sync(OWNER, [{ kind: 'task', id: 'sharedt2', fields: { place: f({ project: SHARED, parent: null, pos: 'a3' }, 6000, t2b.place_ts) } }], 0, 'owner-pc');
    const back = await sync(token, [], out.cursor);
    expect(back.changes.map((c) => [c.id, c.gone ?? false])).toEqual([['sharedt2', false]]);
    const t2c = await row('sharedt2');
    await sync(OWNER, [{ kind: 'task', id: 'sharedt2', fields: { place: f({ project: PRIVATE, parent: null, pos: 'a3' }, 7000, t2c.place_ts) } }], 0, 'owner-pc');
    expect((await sync(token, [], back.cursor)).changes.map((c) => c.gone)).toEqual([true]);
    // a fresh device never hears of it at all
    expect(ids(await sync(token, [], 0, 'dev2'), 'task')).toEqual(['sharedt1']);
  });

  it('cannot change anything after the owner deleted the list', async () => {
    const { token } = await join('edit');
    await sync(OWNER, [{ kind: 'project', id: SHARED, fields: { deleted: f(true, 5000, 0) } }], 0, 'owner-pc');
    const t1 = await row('sharedt1');
    const out = await sync(token, [{ kind: 'task', id: 'sharedt1', fields: { text: f('back', 9000, t1.text_ts) } }]);
    expect(out.rejected[0].reason).toBe('the owner deleted this list');
    expect(out.changes.find((c) => c.id === SHARED).fields.deleted.v).toBe(true);
    expect((await env.DB.prepare('SELECT deleted FROM projects WHERE id = ?1').bind(SHARED).first('deleted'))).toBe(1);
  });

  it('pages a long list like any other sync', async () => {
    const { token } = await join('view');
    const many = Array.from({ length: 1300 }, (_, i) => task(`bulk${String(i).padStart(4, '0')}`, i % 2 ? SHARED : PRIVATE, { ts: 2000 + i }));
    for (let i = 0; i < many.length; i += 100) await sync(OWNER, many.slice(i, i + 100), 0, 'owner-pc');
    const seen = new Set();
    let cursor = 0;
    let out;
    let pages = 0;
    do {
      out = await sync(token, [], cursor);
      pages++;
      for (const c of out.changes) { expect(c.kind === 'project' || c.kind === 'conflict' || c.fields?.place?.v?.project === SHARED).toBe(true); seen.add(c.id); }
      cursor = out.cursor;
    } while (out.more);
    expect([...seen].filter((id) => id.startsWith('bulk'))).toHaveLength(650);
    expect(pages).toBeGreaterThan(1);
  });

  it('the scope check works on the merge\'s own snapshot', async () => {
    // a task the owner moved out of the list between two requests is outside it for the next one
    const changes = [{ kind: 'task', id: 'sharedt1', fields: { text: f('x', 9000, 0) } }];
    let st = await loadState(env.DB, changes);
    expect(scopeChanges(st.state, changes, { projectId: SHARED, access: 'edit' }).allowed).toHaveLength(1);
    const t1 = await row('sharedt1');
    await sync(OWNER, [{ kind: 'task', id: 'sharedt1', fields: { place: f({ project: PRIVATE, parent: null, pos: 'a0' }, 9000, t1.place_ts) } }], 0, 'owner-pc');
    st = await loadState(env.DB, changes);
    const res = scopeChanges(st.state, changes, { projectId: SHARED, access: 'edit' });
    expect(res.allowed).toEqual([]);
    expect(res.canonical.size).toBe(0);   // and it is not sent back either
  });
});
