// The AI connector end to end: what an AI does through the MCP endpoint (src/mcp.js) reaches a computer's lists
// folder through the desktop engine's normal sync (local/engine.mjs, the port of the Windows engine), with the
// same ids, and the AI sees what was typed into a file. The Worker's own code on SQLite (local/d1.mjs), in process.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1 } from '../../../local/d1.mjs';
import { newState, syncCycle, applyPlanToFolder } from '../../../local/engine.mjs';
import worker from '../../src/index.js';

const migrations = join(import.meta.dirname, '..', '..', 'migrations');
const ORIGIN = 'https://saqme.test';
const KEY = 'owner-key-0123456789abcdef0123456789abcdef';
let dir;
let env;
let d1;
let lists;
let state;
let mcp;
let n = 0;

const req = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
const transport = async (body) => {
  const r = await req('/api/sync', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const cycle = () => syncCycle({ state, statePath: join(dir, 'state.json'), listsDir: lists, transport, deviceId: 'pc-1', settleMs: 0, applyPlan: (plan) => applyPlanToFolder(plan, lists) });
async function tool(name, args = {}) {
  const r = await req(mcp, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) });
  const data = await r.json();
  if (data.result?.isError) throw new Error(data.result.content[0].text);
  return data.result.structuredContent;
}
const write = (name, text) => {
  const p = join(lists, `${name}.md`);
  writeFileSync(p, text);
  const t = new Date(Date.now() - 10_000);
  utimesSync(p, t, t);
};
const read = (name) => readFileSync(join(lists, `${name}.md`), 'utf8');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'saqme-connector-'));
  d1 = new D1(join(dir, 'worker.db'));
  d1.migrate(migrations);
  env = { DB: d1, AUTH_TOKEN: KEY };
  lists = join(dir, 'lists');
  mkdirSync(lists);
  state = newState();
  const r = await req('/api/connector', { headers: { authorization: `Bearer ${KEY}` } });
  mcp = new URL((await r.json()).url).pathname;
});
afterEach(() => { d1.close(); rmSync(dir, { recursive: true, force: true }); });

describe('AI connector <-> a computer\'s lists folder', () => {
  it('edits made through the connector land in the markdown files with their ids, and file edits reach the AI', async () => {
    write('Work', '- [ ] Plan the launch ^plan0001\n  - [ ] Write the brief ^plan0002\n- [ ] Answer Nino ^mail0001\n');
    await cycle();   // (first contact: pulls first)
    expect((await cycle()).status).toBe('synced');
    const lists0 = await tool('get_lists');
    expect(lists0.lists.map((l) => [l.name, l.open])).toEqual([['Work', 3]]);

    // the AI adds, changes, moves and deletes
    const added = await tool('add_tasks', { list: 'Work', after_id: 'plan0002', tasks: [{ text: 'Book the room', due: '2026-11-02T10:00', notes: 'the big one' }] });
    const id = added.tasks[0].id;
    await tool('update_task', { id: 'mail0001', status: 'in_progress', due: '2026-10-30' });
    await tool('create_list', { name: 'Travel' });
    await tool('add_tasks', { list: 'Travel', tasks: [{ text: 'Train to Berlin' }] });
    await tool('move_task', { id: 'plan0002', list: 'Travel' });
    const res = await cycle();
    expect(res.status).toBe('synced');
    expect(read('Work')).toBe(`- [ ] Plan the launch ^plan0001\n  - [ ] Book the room due:2026-11-02T10:00 ^${id}\n    > the big one\n- [/] Answer Nino due:2026-10-30 ^mail0001\n`);
    expect(read('Travel')).toMatch(/^- \[ \] Train to Berlin \^[0-9a-z]{8}\n- \[ \] Write the brief \^plan0002\n$/);

    // a delete through the connector is a delete like one from another device: the line goes, nothing is held back
    await tool('delete_task', { id: 'mail0001' });
    const r2 = await cycle();
    expect(r2.guarded).toBe(0);
    expect(read('Work')).not.toContain('mail0001');
    expect(d1.db.prepare('SELECT deleted FROM tasks WHERE id = ?').get('mail0001').deleted).toBe(1);

    // and what is typed into a file (by hand, or by a local AI agent) is what the connector sees next
    write('Work', `- [x] Plan the launch ^plan0001\n  - [ ] Book the room due:2026-11-02T10:00 ^${id}\n    > the big one\n- [ ] Written by hand\n`);
    await cycle();
    await cycle();
    const t = await tool('list_tasks', { list: 'Work', status: 'all' });
    expect(t.tasks.map((x) => [x.text, x.status])).toEqual([['Plan the launch', 'done'], ['Book the room', 'todo'], ['Written by hand', 'todo']]);
    expect(t.tasks[1].id).toBe(id);
  });

  it('lists renamed, moved, deleted and restored through the connector: the files, .order and lists/.trash follow', async () => {
    const groceries = '# Groceries\nFor the weekend.\n- [ ] Milk ^milk0001\n- [x] Bread ^bread001\n  - [ ] Rye ^rye00001\n';
    write('Work', '- [ ] Plan the launch ^plan0001\n');
    write('Groceries', groceries);
    write('Home', '- [ ] Call the plumber ^home0001\n');
    writeFileSync(join(lists, '.order'), 'Work\nGroceries\nHome\n');
    await cycle();
    expect((await cycle()).status).toBe('synced');
    const order = () => readFileSync(join(lists, '.order'), 'utf8');
    const files = () => readdirSync(lists).filter((f) => f.endsWith('.md')).sort();
    const trash = () => (existsSync(join(lists, '.trash')) ? readdirSync(join(lists, '.trash')).sort() : []);

    // renamed: the same file (its heading and prose too) under the new name, in the same place
    await tool('update_list', { list: 'Groceries', name: 'Shopping' });
    await cycle();
    expect(files()).toEqual(['Home.md', 'Shopping.md', 'Work.md']);
    expect(read('Shopping')).toBe(groceries);
    expect(order()).toBe('Work\nShopping\nHome\n');
    // moved: .order follows
    await tool('update_list', { list: 'Shopping', position: 'top' });
    await cycle();
    expect(order()).toBe('Shopping\nWork\nHome\n');

    // deleted: the file goes to lists/.trash, no task is deleted, nothing is held back
    await tool('delete_list', { list: 'Shopping' });
    const del = await cycle();
    expect(del.guarded).toBe(0);
    expect(files()).toEqual(['Home.md', 'Work.md']);
    expect(trash()).toEqual([expect.stringMatching(/^Shopping-\d{8}-\d{6}\.md$/)]);
    expect(order()).toBe('Work\nHome\n');
    expect(d1.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE deleted = 1').get().n).toBe(0);
    await cycle();
    expect(files()).toEqual(['Home.md', 'Work.md']);   // (and it stays gone)

    // restored: the file as it was, back in its place; its copy in lists/.trash is marked restored
    await tool('restore_list', { list: 'Shopping' });
    await cycle();
    expect(read('Shopping')).toBe(groceries);
    expect(order()).toBe('Shopping\nWork\nHome\n');
    expect(trash()).toEqual([expect.stringMatching(/^Shopping-\d{8}-\d{6}\.restored$/)]);
    expect((await cycle()).status).toBe('synced');
    expect((await tool('get_lists')).lists.map((l) => [l.name, l.open])).toEqual([['Shopping', 2], ['Work', 1], ['Home', 1]]);
    // the restored file vanishing now (not through the apps) is held back and written again, not deleted
    rmSync(join(lists, 'Shopping.md'));
    await cycle();
    state.Missing = Object.fromEntries(Object.keys(state.Missing).map((k) => [k, Date.now() - 60_000]));
    await cycle();
    expect(read('Shopping')).toContain('- [ ] Milk ^milk0001');
    expect(d1.db.prepare('SELECT deleted FROM projects WHERE name = ?').get('Shopping').deleted).toBe(0);
  });
});
