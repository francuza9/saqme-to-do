// Connect Claude Desktop on Linux and macOS (local/claude-desktop.mjs, `saqme mcp`, POST /api/local/mcp): Saqme's entry
// in Claude Desktop's settings file (the shared cases in shared/fixtures/claude-config.json, which the Windows app's
// desktop/claude-desktop.ps1 runs too), and the local tools Claude Desktop then gets: the Worker's own, on the app's
// store, written to the list files with their ids; deletes into Recently deleted; no list file ever removed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addServer, removeServer, serverState, ClaudeDesktop, ConfigError, claudeConfigDir, claudeInstalled, claudeEntry, BACKUP_SUFFIX,
} from '../../../local/claude-desktop.mjs';
import { startApp, cmdMcp } from '../../../local/saqme.mjs';
import { LOCAL_INSTRUCTIONS, LOCAL_TOOLS, TOOLS } from '../../src/mcp.js';
import { AI_LINKS, aiOptions } from '../../public/js/ai.js';
import { build as buildMcpTools, path as mcpToolsPath } from '../../../scripts/build-mcp-tools.mjs';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'shared', 'fixtures');
const fx = JSON.parse(readFileSync(join(FIXTURES, 'claude-config.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; }
  return fn();
}
const dirs = [];
const tempDir = (name) => { const d = mkdtempSync(join(tmpdir(), name)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('claude-config.json: Saqme\'s entry in Claude Desktop\'s settings file', () => {
  for (const c of fx.cases) {
    it(c.name, () => {
      const run = () => (c.op === 'add' ? addServer(c.before, fx.entry) : c.op === 'remove' ? removeServer(c.before) : serverState(c.before, fx.entry));
      if (c.error) { expect(run).toThrow(ConfigError); return; }
      const r = run();
      if (c.op === 'state') { expect(r).toBe(c.state); return; }
      expect(r.changed).toBe(c.changed);
      if (!c.changed) { expect(r.text).toBe(c.before); return; }
      expect(JSON.stringify(JSON.parse(r.text))).toBe(JSON.stringify(c.after));   // (key order too)
      expect(Object.keys(JSON.parse(r.text).mcpServers)).toEqual(c.mcpServers);
    });
  }
  it('keeps the file\'s indent and line endings', () => {
    const four = '{\r\n    "mcpServers": {\r\n        "a": { "command": "a" }\r\n    }\r\n}\r\n';
    const out = addServer(four, fx.entry).text;
    expect(out).toMatch(/^\{\r\n {4}"mcpServers": \{\r\n {8}"a": \{/);
    expect(out.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });
});

describe('Settings > Use with AI: the best way first, and where the buttons go', () => {
  it('with sync the link (web and phone), without it Claude Desktop on the computer; the phone has only the link', () => {
    expect(aiOptions({ sync: true, local: true })).toEqual(['link', 'desktop', 'files']);
    expect(aiOptions({ sync: false, local: true })).toEqual(['desktop', 'link', 'files']);
    expect(aiOptions({ sync: true, local: false })).toEqual(['link']);
    expect(aiOptions({ sync: false, local: false })).toEqual(['link']);
  });
  it('the Windows app opens the same pages and has the same rule', () => {
    const widget = readFileSync(join(import.meta.dirname, '..', '..', '..', 'desktop', 'widget.ps1'), 'utf8');
    expect(widget).toContain(`Claude = '${AI_LINKS.claude}'`);
    expect(widget).toContain(`ChatGPT = '${AI_LINKS.chatgpt}'`);
    const ps = readFileSync(join(import.meta.dirname, '..', '..', '..', 'desktop', 'claude-desktop.ps1'), 'utf8');
    expect(ps).toContain(`$script:ClaudeDownload = '${AI_LINKS.claudeDesktop}'`);
    expect(ps).toMatch(/if \(\$Sync\) \{ return @\('link', 'desktop', 'files'\) \}\s+return @\('desktop', 'link', 'files'\)/);
  });
  it('desktop/mcp-tools.json (the Windows server\'s tools) is made from the Worker\'s, and is up to date', () => {
    expect(readFileSync(mcpToolsPath, 'utf8')).toBe(buildMcpTools());
    expect(JSON.parse(buildMcpTools()).tools).toEqual(LOCAL_TOOLS);
  });
});

describe('where Claude Desktop is, and what it runs', () => {
  it('its settings folder on macOS, Linux (XDG) and Windows', () => {
    expect(claudeConfigDir({ platform: 'darwin', home: '/Users/n', env: {} })).toBe('/Users/n/Library/Application Support/Claude');
    expect(claudeConfigDir({ platform: 'linux', home: '/home/n', env: {} })).toBe('/home/n/.config/Claude');
    expect(claudeConfigDir({ platform: 'linux', home: '/home/n', env: { XDG_CONFIG_HOME: '/x' } })).toBe('/x/Claude');
  });
  it('installed: the app on macOS, claude-desktop on PATH or its settings on Linux', () => {
    const has = (set) => (p) => set.includes(p);
    expect(claudeInstalled({ platform: 'darwin', home: '/Users/n', env: {}, exists: has(['/Applications/Claude.app']) })).toBe(true);
    expect(claudeInstalled({ platform: 'darwin', home: '/Users/n', env: {}, exists: has(['/Users/n/Applications/Claude.app']) })).toBe(true);
    expect(claudeInstalled({ platform: 'darwin', home: '/Users/n', env: {}, exists: has([]) })).toBe(false);
    expect(claudeInstalled({ platform: 'linux', home: '/home/n', env: { PATH: '/usr/bin:/opt/c' }, exists: has(['/opt/c/claude-desktop']) })).toBe(true);
    expect(claudeInstalled({ platform: 'linux', home: '/home/n', env: { PATH: '/usr/bin' }, exists: has(['/home/n/.config/Claude/claude_desktop_config.json']) })).toBe(true);
    expect(claudeInstalled({ platform: 'linux', home: '/home/n', env: { PATH: '/usr/bin' }, exists: has([]) })).toBe(false);
  });
  it('the launcher setup.sh wrote (it follows updates), else this copy\'s Node and script; the data folder named', () => {
    expect(claudeEntry({ dataDir: '/d', launcher: '/home/n/.local/bin/saqme' })).toEqual({ command: '/home/n/.local/bin/saqme', args: ['mcp', '--data', '/d'] });
    const e = claudeEntry({ dataDir: '/d', launcher: '', execPath: '/usr/bin/node', appDir: '/src/saqme' });
    expect(e).toEqual({ command: '/usr/bin/node', args: ['--disable-warning=ExperimentalWarning', '/src/saqme/local/saqme.mjs', 'mcp', '--data', '/d'] });
  });
});

describe('Connect Claude Desktop on disk', () => {
  const entry = { command: '/bin/saqme', args: ['mcp', '--data', '/d'] };
  it('not installed: nothing written, it says so', () => {
    const dir = join(tempDir('saqme-claude-'), 'Claude');
    const c = new ClaudeDesktop({ entry, configDir: dir, installed: () => false });
    expect(c.status()).toMatchObject({ installed: false, state: 'none', download: 'https://claude.ai/download' });
    expect(() => c.connect()).toThrow(/not installed/);
    expect(existsSync(dir)).toBe(false);
  });
  it('connect: merged, a backup of the file as it was, the same again changes nothing; disconnect removes only Saqme', () => {
    const dir = join(tempDir('saqme-claude-'), 'Claude');
    mkdirSync(dir);
    const path = join(dir, 'claude_desktop_config.json');
    const mine = '{\n  "mcpServers": {\n    "files": { "command": "npx" }\n  },\n  "preferences": { "a": 1 }\n}\n';
    writeFileSync(path, mine);
    const c = new ClaudeDesktop({ entry, configDir: dir, installed: () => true });
    expect(c.status().state).toBe('none');
    expect(c.connect()).toMatchObject({ state: 'connected', changed: true });
    expect(readFileSync(path + BACKUP_SUFFIX, 'utf8')).toBe(mine);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after).toEqual({ mcpServers: { files: { command: 'npx' }, saqme: entry }, preferences: { a: 1 } });
    const once = readFileSync(path, 'utf8');
    expect(c.connect()).toMatchObject({ state: 'connected', changed: false });
    expect(readFileSync(path, 'utf8')).toBe(once);
    expect(readFileSync(path + BACKUP_SUFFIX, 'utf8')).toBe(mine);   // (nothing changed: no new backup)
    expect(readdirSync(dir).sort()).toEqual(['claude_desktop_config.json', `claude_desktop_config.json${BACKUP_SUFFIX}`]);   // (no temp files left)
    expect(c.disconnect()).toMatchObject({ state: 'none', changed: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { files: { command: 'npx' } }, preferences: { a: 1 } });
    expect(c.disconnect()).toMatchObject({ changed: false });
  });
  it('no settings file yet: one is made; a file that is not plain JSON is left alone', () => {
    const dir = join(tempDir('saqme-claude-'), 'Claude');
    const c = new ClaudeDesktop({ entry, configDir: dir, installed: () => true });
    c.connect();
    expect(JSON.parse(readFileSync(c.configPath, 'utf8'))).toEqual({ mcpServers: { saqme: entry } });
    expect(existsSync(c.configPath + BACKUP_SUFFIX)).toBe(false);
    const odd = '{ // mine\n "mcpServers": {} }';
    writeFileSync(c.configPath, odd);
    expect(c.status()).toMatchObject({ state: 'unreadable' });
    expect(() => c.connect()).toThrow(/not plain JSON/);
    expect(() => c.disconnect()).toThrow(/not plain JSON/);
    expect(readFileSync(c.configPath, 'utf8')).toBe(odd);
  });
});

describe('the local tools Claude Desktop gets (POST /api/local/mcp, saqme mcp)', () => {
  let app;
  let dir;
  let rpcId = 0;
  const rpc = async (method, params, token) => {
    const r = await fetch(`${app.url}/api/local/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token ?? app.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    return r.status === 200 ? r.json() : { status: r.status };
  };
  const call = async (name, args = {}) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    if (r.isError) return { error: r.content[0].text };
    return r.structuredContent;
  };
  const file = (name) => readFileSync(join(dir, 'lists', `${name}.md`), 'utf8');

  beforeAll(async () => {
    dir = tempDir('saqme-mcp-');
    mkdirSync(join(dir, 'lists'));
    writeFileSync(join(dir, 'lists', 'Work.md'), '# Work\nNotes for the list stay.\n- [ ] Write the report\n  - [ ] Charts\n- [ ] Call Anna\n');
    writeFileSync(join(dir, 'lists', 'Home.md'), '# Home\n- [ ] Milk\n');
    writeFileSync(join(dir, 'lists', 'Groceries.md'), '# Groceries\n- [ ] Bread\n');
    // a list someone shares with this computer, view only (no key here, so its own engine stays off)
    writeFileSync(join(dir, 'lists', '.remotes.json'), JSON.stringify({ version: 1, remotes: [{ id: 'r1', file: 'Groceries', server: 'https://saqme.nuca.workers.dev', project: 'p1', access: 'view', name: 'Groceries' }] }));
    app = await startApp({ dataDir: dir, port: 0, interval: 200, cloudInterval: 60_000, settleMs: 0, reminders: false, updates: false });
    await until(() => /\^[0-9a-z]{8}/.test(file('Work')) && /\^[0-9a-z]{8}/.test(file('Groceries')));
    await until(async () => (await call('get_lists')).lists.length === 3);
  });
  afterAll(async () => { await app?.stop(); });

  it('needs the app\'s key; says it is on this computer; the Worker\'s tool shapes', async () => {
    expect(await rpc('ping', {}, 'wrong')).toEqual({ status: 401 });
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result;
    expect(init.instructions).toBe(LOCAL_INSTRUCTIONS);
    expect(init.instructions).toMatch(/on this computer/);
    const tools = (await rpc('tools/list')).result.tools;
    expect(tools).toEqual(LOCAL_TOOLS);
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.map((t) => t.inputSchema)).toEqual(TOOLS.map((t) => t.inputSchema));
  });

  it('get_lists: the lists, and the shared one says whose and that it is view only', async () => {
    const r = await call('get_lists');
    expect(r.lists.map((l) => l.name).sort()).toEqual(['Groceries', 'Home', 'Work']);
    expect(r.lists.find((l) => l.name === 'Groceries')).toMatchObject({ shared_from: 'nuca', can_edit: false });
    expect(r.lists.find((l) => l.name === 'Work').shared_from).toBeUndefined();
    expect(r.today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('add_tasks: into the file, with ids, the rest of the file kept', async () => {
    const r = await call('add_tasks', { list: 'Work', tasks: [{ text: 'Book the room', due: '2026-11-03T9:30', subtasks: [{ text: 'Ask for a projector' }] }] });
    expect(r.added).toBe(2);
    const { id } = r.tasks[0];
    const sub = r.tasks[0].subtasks[0].id;
    await until(() => file('Work').includes(`^${sub}`));
    const text = file('Work');
    expect(text).toMatch(new RegExp(`- \\[ \\] Book the room due:2026-11-03T9:30 \\^${id}\\n  - \\[ \\] Ask for a projector \\^${sub}`));
    expect(text).toMatch(/^# Work\nNotes for the list stay\.\n- \[ \] Write the report \^[0-9a-z]{8}\n  - \[ \] Charts/);
  });

  it('update_task and move_task (the whole block, to another list, ids kept)', async () => {
    const report = (await call('list_tasks', { list: 'Work', query: 'report' })).tasks[0];
    await call('update_task', { id: report.id, status: 'in_progress' });
    await until(() => file('Work').includes(`- [/] Write the report ^${report.id}`));
    expect((await call('move_task', { id: report.id, list: 'Home' })).moved).toBe(2);
    await until(() => file('Home').includes(`^${report.id}`) && !file('Work').includes(`^${report.id}`));
    expect(file('Home')).toMatch(new RegExp(`- \\[/\\] Write the report \\^${report.id}\\n  - \\[ \\] Charts \\^[0-9a-z]{8}`));
  });

  it('delete_task: out of the file, into Recently deleted; restore_task brings it back; no list file goes', async () => {
    const anna = (await call('list_tasks', { list: 'Work', query: 'Anna' })).tasks[0];
    expect(await call('delete_task', { id: anna.id })).toMatchObject({ deleted: 1 });
    await until(() => !file('Work').includes(`^${anna.id}`));
    expect((await call('list_tasks', { status: 'deleted' })).tasks.map((t) => t.id)).toContain(anna.id);
    expect(await call('restore_task', { id: anna.id })).toMatchObject({ restored: 1 });
    await until(() => file('Work').includes(`- [ ] Call Anna ^${anna.id}`));
    expect(readdirSync(join(dir, 'lists')).filter((n) => n.endsWith('.md')).sort()).toEqual(['Groceries.md', 'Home.md', 'Work.md']);
    expect(TOOLS.map((t) => t.name).some((n) => /delete_list|remove_list/.test(n))).toBe(false);
  });

  it('a view-only shared list is not changed', async () => {
    const bread = (await call('list_tasks', { list: 'Groceries' })).tasks[0];
    const before = file('Groceries');
    for (const [name, args] of [['update_task', { id: bread.id, status: 'done' }], ['delete_task', { id: bread.id }], ['add_tasks', { list: 'Groceries', tasks: [{ text: 'Eggs' }] }], ['move_task', { id: bread.id, list: 'Home' }]]) {
      expect((await call(name, args)).error, name).toMatch(/viewing only/);
    }
    await sleep(500);
    expect(file('Groceries')).toBe(before);
  });

  it('create_list: a new file, at the end', async () => {
    expect((await call('create_list', { name: 'Trip: Berlin' })).list.name).toBe('Trip Berlin');
    await until(() => existsSync(join(dir, 'lists', 'Trip Berlin.md')));
    expect((await call('create_list', { name: 'trip berlin' })).error).toMatch(/already/);
  });

  it('saqme mcp: stdio lines through to the app, one answer per line, nothing else on stdout', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c) => { out += c; });
    const done = cmdMcp({ data: dir, port: String(app.port), dataGiven: true, args: [] }, { input, output, start: false });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_lists', arguments: {} } })}\n`);
    input.end();
    await done;
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[0].result.instructions).toBe(LOCAL_INSTRUCTIONS);
    expect(lines[1].result.structuredContent.lists.length).toBe(4);
  });

  it('saqme mcp with the app not running: the tools are there, each call says to open Saqme', async () => {
    const empty = tempDir('saqme-mcp-off-');
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c) => { out += c; });
    const done = cmdMcp({ data: empty, port: '1', dataGiven: true, args: [] }, { input, output, start: false });
    for (const [id, method, params] of [[1, 'initialize', {}], [2, 'tools/list', {}], [3, 'tools/call', { name: 'get_lists', arguments: {} }]]) input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    input.end();
    await done;
    const [init, list, called] = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(init.result.instructions).toBe(LOCAL_INSTRUCTIONS);
    expect(list.result.tools).toEqual(LOCAL_TOOLS);
    expect(called.result).toMatchObject({ isError: true });
    expect(called.result.content[0].text).toMatch(/open Saqme To Do/);
  });
});
