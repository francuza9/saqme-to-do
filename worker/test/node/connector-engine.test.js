// The AI connector end to end: what an AI does through the MCP endpoint (src/mcp.js) reaches a computer's lists
// folder through the desktop engine's normal sync (local/engine.mjs, the port of the Windows engine), with the
// same ids, and the AI sees what was typed into a file. The Worker's own code on SQLite (local/d1.mjs), in process.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
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
});
