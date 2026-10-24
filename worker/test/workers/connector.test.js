// The AI connector (src/connector.js: its address and key; src/mcp.js: the MCP server and its tools). The key in the
// address is the only credential: the owner's sync key, a shared list's key or a wrong one never reach the tools.
// Every write goes through the sync path, so devices get it with their next sync, ids and all.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index.js';
import { RATE_LIMIT, DELETE_LIMIT, connectorKey } from '../../src/connector.js';
import { AI_DEVICE, PROTOCOL_VERSIONS, TOOLS, todayInfo } from '../../src/mcp.js';

const OWNER = env.AUTH_TOKEN;
const ORIGIN = 'https://saqme.test';
const WORK = 'workproj';
const HOME = 'homeproj';

async function call(path, { method = 'POST', body, token = OWNER, headers = {}, raw } = {}) {
  const ctx = createExecutionContext();
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, {
    method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
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
const f = (v, ts, base) => (base === undefined ? { v, ts } : { v, ts, base });
const project = (id, name, pos = 'a0', ts = 1000) => ({ kind: 'project', id, fields: { name: f(name, ts), pos: f(pos, ts) } });
const task = (id, projectId, { ts = 1000, text = `task ${id}`, parent = null, pos = 'a0', status = ' ', due = null, notes = '' } = {}) => ({
  kind: 'task', id, fields: { place: f({ project: projectId, parent, pos }, ts), text: f(text, ts), status: f(status, ts), notes: f(notes, ts), due: f(due, ts) },
});
const sync = (changes = [], cursor = 0, deviceId = 'pc-1', token = OWNER) => ok('/api/sync', { body: { deviceId, cursor, changes }, token });
const row = (id) => env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first();

/** The connector's address now, from the owner's route. */
const status = () => ok('/api/connector', { method: 'GET' });
const mcpPath = async () => new URL((await status()).url).pathname;

let path;
let nextId = 1;
/** One JSON-RPC request to the connector -> its parsed answer. */
async function rpc(method, params, { p = path, headers } = {}) {
  const res = await call(p, { body: { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }, token: null, headers });
  expect(res.status).toBe(200);
  return res.json();
}
/** A tool call -> its structured result (throws with the message when the tool said isError). */
async function tool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  if (r.result.isError) throw new Error(r.result.content[0].text);
  expect(JSON.parse(r.result.content[0].text)).toEqual(r.result.structuredContent);
  return r.result.structuredContent;
}
const toolError = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  expect(r.result?.isError, JSON.stringify(r)).toBe(true);
  return r.result.content[0].text;
};

beforeEach(async () => {
  await env.DB.batch(['tasks', 'projects', 'settings', 'conflicts', 'shares', 'moved_out', 'share_push', 'remotes', 'remote_tasks']
    .map((t) => env.DB.prepare(`DELETE FROM ${t}`))
    .concat(env.DB.prepare(`UPDATE meta SET value = '0' WHERE key = 'seq'`),
      env.DB.prepare(`UPDATE connector SET enabled = 1, window_calls = 0, window_start = 0, delete_count = 0, delete_start = 0`)));
  // a computer's lists: Work (a task with two subtasks, one with a deadline), Home
  await sync([
    project(WORK, 'Work', 'a0'), project(HOME, 'Home', 'a1'),
    task('plan0001', WORK, { text: 'Plan the launch', pos: 'a0' }),
    task('plan0002', WORK, { text: 'Write the brief', parent: 'plan0001', pos: 'a0', due: { date: '2099-10-27', time: '' } }),
    task('plan0003', WORK, { text: 'Book the room', parent: 'plan0001', pos: 'a1', status: 'x' }),
    task('mail0001', WORK, { text: 'Answer Nino', pos: 'a1', due: { date: '2020-10-20', time: '14:00' }, notes: 'about the invoice' }),
    task('home0001', HOME, { text: 'Call the plumber', pos: 'a0', status: '>' }),
    { kind: 'setting', id: 'tz', fields: { value: f('Asia/Tbilisi', 1000) } },
  ]);
  path = await mcpPath();
});

describe('the address and its key', () => {
  it('is there as soon as sync is (no setup step), only for the owner, and is not the sync key', async () => {
    const s = await status();
    expect(s.enabled).toBe(true);
    expect(s.url).toMatch(/^https:\/\/saqme\.test\/api\/mcp\/[A-Za-z0-9_-]{43}$/);
    expect(s.url).not.toContain(OWNER);
    // D1 keeps a nonce only: neither the key nor a digest of it
    const r = await env.DB.prepare(`SELECT * FROM connector`).first();
    expect(JSON.stringify(r)).not.toContain(s.url.split('/').pop());
    expect(s.url.split('/').pop()).toBe(await connectorKey(OWNER, r.nonce));
    expect((await call('/api/connector', { method: 'GET', token: null })).status).toBe(401);
    expect((await call('/api/connector/rotate', { token: 'wrong-key-0123456789abcdef0123456789' })).status).toBe(401);
  });

  it('a shared list\'s key gets nothing: not the address, not the tools', async () => {
    const inv = await ok('/api/shares/invite', { body: { projectId: WORK, alias: 'Nuca', access: 'edit' } });
    const { token: shareKey } = await ok('/api/shares/claim', { body: { code: inv.code }, token: null });
    for (const r of ['GET /api/connector', 'POST /api/connector/rotate', 'POST /api/connector/disconnect']) {
      const [method, p] = r.split(' ');
      expect((await call(p, { method, token: shareKey })).status).toBe(403);
    }
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSIONS[0] } };
    // the share key as the address's key, or as a bearer token with a wrong address: 404 either way
    expect((await call(`/api/mcp/${shareKey}`, { body: initialize, token: null })).status).toBe(404);
    expect((await call(`/api/mcp/${'x'.repeat(43)}`, { body: initialize, token: shareKey })).status).toBe(404);
    expect((await call('/api/mcp', { body: initialize, token: shareKey })).status).toBe(404);
    // and the sync key is no connector key either
    expect((await call(`/api/mcp/${OWNER}`, { body: initialize, token: null })).status).toBe(404);
    expect((await call(`/api/mcp/${'A'.repeat(43)}`, { body: initialize, token: OWNER })).status).toBe(404);
  });

  it('a wrong key is refused without writing anything', async () => {
    const before = await env.DB.prepare('SELECT * FROM connector').first();
    const res = await call(`/api/mcp/${'B'.repeat(43)}`, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, token: null });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/Settings > Use with AI/);
    expect(await env.DB.prepare('SELECT * FROM connector').first()).toEqual(before);
  });

  it('rotate: a new address, the old one stops at once; disconnect: none works until the next connect', async () => {
    const old = path;
    expect((await rpc('ping')).result).toEqual({});
    const rotated = await ok('/api/connector/rotate', {});
    expect(rotated.enabled).toBe(true);
    const fresh = new URL(rotated.url).pathname;
    expect(fresh).not.toBe(old);
    expect((await call(old, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, token: null })).status).toBe(404);
    expect((await rpc('ping', null, { p: fresh })).result).toEqual({});

    const off = await ok('/api/connector/disconnect', {});
    expect(off).toMatchObject({ enabled: false, url: null });
    expect((await call(fresh, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, token: null })).status).toBe(404);
    expect((await status()).enabled).toBe(false);
    const again = await ok('/api/connector/rotate', {});
    expect(again.enabled).toBe(true);
    expect(new URL(again.url).pathname).not.toBe(fresh);   // never an old address back
    expect(new URL(again.url).pathname).not.toBe(old);
  });

  it('rate limited per minute', async () => {
    expect((await call(path, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, token: null })).status).toBe(200);
    await env.DB.prepare('UPDATE connector SET window_calls = ?1, window_start = ?2').bind(RATE_LIMIT, Date.now()).run();
    expect((await call(path, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, token: null })).status).toBe(429);
    await env.DB.prepare('UPDATE connector SET window_start = ?1').bind(Date.now() - 61_000).run();
    expect((await call(path, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, token: null })).status).toBe(200);
    expect((await status()).lastUsedAt).toBeGreaterThan(Date.now() - 10_000);
  });
});

describe('the MCP protocol (Streamable HTTP, stateless)', () => {
  it('initialize: the version the client asks for when known, else the newest; instructions; tools only', async () => {
    for (const v of PROTOCOL_VERSIONS) {
      const r = await rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(r.result.protocolVersion).toBe(v);
    }
    const r = await rpc('initialize', { protocolVersion: '2023-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.result).toMatchObject({ protocolVersion: PROTOCOL_VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'saqme' } });
    expect(r.result.instructions).toMatch(/get_lists/);
    expect(r.result.capabilities.resources).toBeUndefined();
  });

  it('notifications get 202 without a body; GET 405; bad JSON, unknown methods and versions are errors', async () => {
    const n = await call(path, { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, token: null });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe('');
    expect((await call(path, { method: 'GET', token: null })).status).toBe(405);
    expect((await call(path, { raw: '{nope', token: null })).status).toBe(400);
    expect((await rpc('no/such')).error.code).toBe(-32601);
    expect((await call(path, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, token: null, headers: { 'mcp-protocol-version': '1999-01-01' } })).status).toBe(400);
    expect((await rpc('ping', null, { headers: { 'mcp-protocol-version': PROTOCOL_VERSIONS[1] } })).result).toEqual({});
    // a batch
    const b = await call(path, { body: [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }], token: null });
    const out = await b.json();
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('tools/list: the tools, each saying what it does; nothing deletes a list', async () => {
    const { result } = await rpc('tools/list');
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(['today', 'get_lists', 'list_tasks', 'add_tasks', 'update_task', 'move_task', 'delete_task', 'restore_task', 'create_list']);
    expect(result.tools).toEqual(TOOLS);
    expect(names.filter((n) => /list/.test(n) && /delete|remove/.test(n))).toEqual([]);
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(40);
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
    }
    const d = (n) => result.tools.find((t) => t.name === n).description;
    expect(d('update_task')).toMatch(/in_progress.*postponed.*blocked/);
    expect(JSON.stringify(result.tools)).toMatch(/YYYY-MM-DDTHH:MM/);
    expect((await rpc('tools/call', { name: 'delete_list', arguments: { list: 'Work' } })).error.code).toBe(-32602);
  });
});

describe('the tools', () => {
  it('today: the date in the user\'s time zone', async () => {
    const t = await tool('today');
    expect(t).toEqual(todayInfo('Asia/Tbilisi'));
    expect(t.timezone).toBe('Asia/Tbilisi');
    expect(todayInfo('UTC', Date.parse('2026-10-25T10:00:00Z'))).toMatchObject({ date: '2026-10-25', weekday: 'Sunday', week_start: '2026-10-19', week_end: '2026-10-25', yesterday: '2026-10-24' });
    expect(todayInfo('Pacific/Kiritimati', Date.parse('2026-10-25T23:00:00Z')).date).toBe('2026-10-26');
  });

  it('get_lists: the lists in order with their counts, which are shared, and lists shared with the user by name', async () => {
    await ok('/api/shares/invite', { body: { projectId: HOME, alias: 'Nuca', access: 'view' } });
    await env.DB.prepare(`INSERT INTO remotes (id, server, token, project_id, name, access, created_at, updated_at) VALUES ('r1', 'https://saqme.nuca.workers.dev', 'secret-share-key', 'p9', 'Groceries', 'edit', 1, 1)`).run();
    const out = await tool('get_lists');
    expect(out.today.timezone).toBe('Asia/Tbilisi');
    expect(out.lists).toEqual([
      { id: WORK, name: 'Work', open: 3, due_today_or_earlier: 1, overdue: 1, shared_by_you: false },
      { id: HOME, name: 'Home', open: 0, due_today_or_earlier: 0, overdue: 0, shared_by_you: true },
    ]);
    expect(out.shared_with_you).toEqual([{ name: 'Groceries', from: 'saqme.nuca.workers.dev', access: 'can edit', reachable_here: false }]);
    expect(JSON.stringify(out)).not.toContain('secret-share-key');
  });

  it('list_tasks: list order with subtasks after their parent, and every filter', async () => {
    const all = await tool('list_tasks');
    expect(all.tasks.map((t) => [t.id, t.depth, t.parent_id])).toEqual([
      ['plan0001', 0, null], ['plan0002', 1, 'plan0001'], ['mail0001', 0, null], ['home0001', 0, null],
    ]);
    expect(all.tasks[2]).toMatchObject({ list: 'Work', list_id: WORK, status: 'todo', text: 'Answer Nino', due: '2020-10-20T14:00', notes: 'about the invoice' });
    expect(all.tasks[0].subtasks).toBe(2);
    expect((await tool('list_tasks', { status: 'all', list: 'work' })).tasks.map((t) => t.id)).toEqual(['plan0001', 'plan0002', 'plan0003', 'mail0001']);
    expect((await tool('list_tasks', { status: 'done' })).tasks.map((t) => t.id)).toEqual(['plan0003']);
    expect((await tool('list_tasks', { status: ['postponed', 'done'] })).tasks.map((t) => t.id)).toEqual(['plan0003', 'home0001']);
    expect((await tool('list_tasks', { status: 'open' })).tasks.map((t) => t.id)).toEqual(['plan0001', 'plan0002', 'mail0001']);
    expect((await tool('list_tasks', { due_from: '2099-10-21', due_to: '2099-10-31' })).tasks.map((t) => t.id)).toEqual(['plan0002']);
    expect((await tool('list_tasks', { due_to: '2021-01-01' })).tasks.map((t) => t.id)).toEqual(['mail0001']);
    expect((await tool('list_tasks', { query: 'INVOICE' })).tasks.map((t) => t.id)).toEqual(['mail0001']);
    expect(await toolError('list_tasks', { list: 'Nope' })).toMatch(/no list "Nope".*Work, Home/);
    expect(await toolError('list_tasks', { status: 'sleeping' })).toMatch(/not a status/);
    expect(await toolError('list_tasks', { due_to: 'friday' })).toMatch(/YYYY-MM-DD/);
  });

  it('add_tasks: tasks and subtasks in place; their ids are what every device gets', async () => {
    const before = await sync([], 0, 'phone-1');
    const out = await tool('add_tasks', {
      list: 'Work', after_id: 'plan0001',
      tasks: [{ text: 'Sign the contract', due: '2026-10-30T09:30', notes: 'two copies\nblue pen' }, { text: 'Send it', status: 'in_progress', subtasks: [{ text: 'Find the address' }] }],
    });
    expect(out.added).toBe(3);
    const [a, b] = out.tasks;
    expect(a).toMatchObject({ list: 'Work', parent_id: null, text: 'Sign the contract', due: '2026-10-30T09:30', notes: 'two copies\nblue pen', status: 'todo' });
    expect(b.subtasks[0]).toMatchObject({ parent_id: b.id, text: 'Find the address' });
    expect((await tool('list_tasks', { list: 'Work' })).tasks.map((t) => t.id)).toEqual(['plan0001', 'plan0002', a.id, b.id, b.subtasks[0].id, 'mail0001']);
    // a device that synced before gets exactly these rows, with these ids, from its cursor
    const next = await sync([], before.cursor, 'phone-1');
    const got = next.changes.filter((c) => c.kind === 'task');
    expect(got.map((c) => c.id).sort()).toEqual([a.id, b.id, b.subtasks[0].id].sort());
    const ga = got.find((c) => c.id === a.id);
    expect(ga.fields.due.v).toEqual({ date: '2026-10-30', time: '9:30' });
    expect(ga.fields.place.v).toMatchObject({ project: WORK, parent: null });
    expect(ga.fields.deleted.v).toBe(false);
    expect(JSON.parse((await row(a.id)).devs).text).toBe(AI_DEVICE);
    // at the top, and as subtasks of a task
    const top = await tool('add_tasks', { list: HOME, position: 'top', tasks: [{ text: 'First thing' }] });
    expect((await tool('list_tasks', { list: 'Home', status: 'all' })).tasks[0].id).toBe(top.tasks[0].id);
    const sub = await tool('add_tasks', { parent_id: 'plan0001', position: 'top', tasks: [{ text: 'Budget' }] });
    expect((await tool('list_tasks', { list: 'Work', status: 'all' })).tasks[1]).toMatchObject({ id: sub.tasks[0].id, parent_id: 'plan0001', depth: 1 });
  });

  it('add_tasks refuses what it cannot save, and saves nothing then', async () => {
    const seq = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'seq'`).first('value');
    expect(await toolError('add_tasks', { list: 'Work', tasks: [{ text: 'ok' }, { text: '   ' }] })).toMatch(/empty/);
    expect(await toolError('add_tasks', { list: 'Work', tasks: [{ text: 'ok', due: 'next friday' }] })).toMatch(/not a deadline/);
    expect(await toolError('add_tasks', { list: 'Work', tasks: [{ text: 'ok', due: '2026-02-30' }] })).toMatch(/not a deadline/);
    expect(await toolError('add_tasks', { list: 'Work', tasks: Array.from({ length: 51 }, (_, i) => ({ text: `t${i}` })) })).toMatch(/At most 50/);
    expect(await toolError('add_tasks', { parent_id: 'nosuch01', tasks: [{ text: 'x' }] })).toMatch(/no parent task/);
    expect(await toolError('add_tasks', { list: 'Home', parent_id: 'plan0001', tasks: [{ text: 'x' }] })).toMatch(/in the list "Work"/);
    expect(await toolError('add_tasks', { list: 'Work', after_id: 'home0001', tasks: [{ text: 'x' }] })).toMatch(/after_id/);
    expect(await env.DB.prepare(`SELECT value FROM meta WHERE key = 'seq'`).first('value')).toBe(seq);
  });

  it('update_task: only the fields given; a device\'s concurrent edit is merged, the other kept as a conflict', async () => {
    const base = await sync([], 0, 'phone-1');
    const out = await tool('update_task', { id: 'mail0001', status: 'done', due: null });
    expect(out.task).toMatchObject({ id: 'mail0001', status: 'done', due: null, text: 'Answer Nino', notes: 'about the invoice' });
    const r = await row('mail0001');
    expect([r.status, r.due, r.text]).toEqual(['x', null, 'Answer Nino']);
    expect(await toolError('update_task', { id: 'mail0001' })).toMatch(/Nothing to change/);
    expect(await toolError('update_task', { id: 'mail0001', status: 'finished' })).toMatch(/not a status/);
    // the phone edited the old version's status meanwhile: newest wins, the loser is a conflict every device sees
    const old = base.changes.find((c) => c.id === 'mail0001').fields.status.ts;
    const res = await sync([{ kind: 'task', id: 'mail0001', fields: { status: f('/', Date.now() - 60_000, old) } }], base.cursor, 'phone-1');
    expect((await row('mail0001')).status).toBe('x');
    expect(res.changes.filter((c) => c.kind === 'conflict').map((c) => [c.field, c.value, c.other])).toEqual([['status', '/', 'x']]);
  });

  it('move_task: the whole block, to another list or under another task, never into itself', async () => {
    const before = await sync([], 0, 'phone-1');
    const m = await tool('move_task', { id: 'plan0001', list: 'Home' });
    expect(m.moved).toBe(3);
    for (const id of ['plan0001', 'plan0002', 'plan0003']) expect((await row(id)).project_id).toBe(HOME);
    expect((await row('plan0002')).parent_id).toBe('plan0001');
    expect((await tool('list_tasks', { list: 'Home', status: 'all' })).tasks.map((t) => t.id)).toEqual(['home0001', 'plan0001', 'plan0002', 'plan0003']);
    const next = await sync([], before.cursor, 'phone-1');
    expect(next.changes.filter((c) => c.kind === 'task').map((c) => c.id).sort()).toEqual(['plan0001', 'plan0002', 'plan0003']);
    // under another task, at the top; then out to the top level after a given task
    await tool('move_task', { id: 'home0001', parent_id: 'plan0001', position: 'top' });
    expect((await tool('list_tasks', { list: 'Home', status: 'all' })).tasks.map((t) => [t.id, t.depth])).toEqual([['plan0001', 0], ['home0001', 1], ['plan0002', 1], ['plan0003', 1]]);
    await tool('move_task', { id: 'plan0003', after_id: 'plan0001' });
    expect((await tool('list_tasks', { list: 'Home', status: 'all' })).tasks.map((t) => [t.id, t.depth])).toEqual([['plan0001', 0], ['home0001', 1], ['plan0002', 1], ['plan0003', 0]]);
    expect(await toolError('move_task', { id: 'plan0001', parent_id: 'plan0002' })).toMatch(/under itself/);
    expect(await toolError('move_task', { id: 'plan0001', parent_id: 'plan0001' })).toMatch(/under itself/);
    expect(await toolError('move_task', { id: 'plan0001', list: 'Work', parent_id: 'home0001' })).toMatch(/different lists/);
  });

  it('a move out of a list the owner shares reaches its people as gone; an add as a new task', async () => {
    const inv = await ok('/api/shares/invite', { body: { projectId: WORK, alias: 'Nuca', access: 'edit' } });
    const { token } = await ok('/api/shares/claim', { body: { code: inv.code }, token: null });
    const theirs = await sync([], 0, 'nuca-1', token);
    expect(theirs.changes.filter((c) => c.kind === 'task').map((c) => c.id).sort()).toEqual(['mail0001', 'plan0001', 'plan0002', 'plan0003']);
    const added = await tool('add_tasks', { list: 'Work', tasks: [{ text: 'For both of us' }] });
    await tool('move_task', { id: 'mail0001', list: 'Home' });
    const next = await sync([], theirs.cursor, 'nuca-1', token);
    expect(next.changes.filter((c) => c.kind === 'task').map((c) => [c.id, !!c.gone]).sort()).toEqual([[added.tasks[0].id, false], ['mail0001', true]].sort());
    expect(JSON.stringify(next)).not.toContain('Home');
  });

  it('delete_task: tombstones for the task and its subtasks (Recently deleted), restore_task brings them back', async () => {
    const before = await sync([], 0, 'phone-1');
    const d = await tool('delete_task', { id: 'plan0001' });
    expect(d).toMatchObject({ deleted: 3, list: 'Work', text: 'Plan the launch' });
    expect(d.ids.sort()).toEqual(['plan0001', 'plan0002', 'plan0003']);
    for (const id of d.ids) expect((await row(id)).deleted).toBe(1);   // never removed from the database
    const next = await sync([], before.cursor, 'phone-1');
    expect(next.changes.filter((c) => c.kind === 'task').map((c) => [c.id, c.fields.deleted.v]).sort()).toEqual([['plan0001', true], ['plan0002', true], ['plan0003', true]]);
    expect((await tool('list_tasks', { status: 'all' })).tasks.map((t) => t.id)).toEqual(['mail0001', 'home0001']);
    const trash = await tool('list_tasks', { status: 'deleted' });
    expect(trash.tasks.map((t) => [t.id, t.status, t.was])).toEqual([['plan0001', 'deleted', 'todo']]);
    expect(await toolError('update_task', { id: 'plan0001', text: 'x' })).toMatch(/is deleted.*restore_task/);
    const r = await tool('restore_task', { id: 'plan0001' });
    expect(r.restored).toBe(3);
    expect((await tool('list_tasks', { status: 'all', list: 'Work' })).tasks.map((t) => t.id)).toEqual(['plan0001', 'plan0002', 'plan0003', 'mail0001']);
    expect(await toolError('restore_task', { id: 'plan0001' })).toMatch(/not deleted/);
  });

  it('deletes have an hourly budget, as the apps hold back mass deletes', async () => {
    const many = Array.from({ length: DELETE_LIMIT }, (_, i) => ({ text: `sub ${i}` }));
    const big = await tool('add_tasks', { list: 'Home', tasks: [{ text: 'Big', subtasks: many }] });
    expect(await toolError('delete_task', { id: big.tasks[0].id })).toMatch(/Not deleted.*in the Saqme app/);
    expect((await row(big.tasks[0].id)).deleted).toBe(0);
    // one by one, up to the budget
    const ids = big.tasks[0].subtasks.map((t) => t.id);
    for (const id of ids.slice(0, DELETE_LIMIT)) await tool('delete_task', { id });
    expect(await toolError('delete_task', { id: 'home0001' })).toMatch(/Not deleted/);
    await env.DB.prepare('UPDATE connector SET delete_start = ?1').bind(Date.now() - 3601_000).run();
    expect((await tool('delete_task', { id: 'home0001' })).deleted).toBe(1);
  });

  it('create_list: a new list at the end, once; then usable at once', async () => {
    const before = await sync([], 0, 'pc-2');
    const c = await tool('create_list', { name: '  Trip: Berlin?  ' });
    expect(c.list.name).toBe('Trip Berlin');
    expect(await toolError('create_list', { name: 'trip berlin' })).toMatch(/already/);
    expect(await toolError('create_list', { name: ' :? ' })).toMatch(/name/);
    expect((await tool('get_lists')).lists.map((l) => l.name)).toEqual(['Work', 'Home', 'Trip Berlin']);
    await tool('add_tasks', { list: 'Trip Berlin', tasks: [{ text: 'Train tickets' }] });
    const next = await sync([], before.cursor, 'pc-2');
    const p = next.changes.find((x) => x.kind === 'project');
    expect(p).toMatchObject({ id: c.list.id, fields: { name: { v: 'Trip Berlin' }, deleted: { v: false } } });
    expect(p.fields.pos.v > 'a1').toBe(true);
  });
});
