#!/usr/bin/env node
// End-to-end sync test against the real Worker under `wrangler dev --local` (Miniflare, nothing leaves
// this machine):
//   - two phones = the PWA's own store.js (in memory instead of IndexedDB)
//   - the desktop = the widget's PowerShell sync engine on a real lists folder, when powershell.exe is
//     reachable (Windows, or WSL with interop); otherwise that part is skipped
//   - the Linux/macOS app (local/saqme.mjs): its own lists folder, local store and window, syncing with
//     the same Worker through its cloud engine (the JavaScript port of the desktop engine)
// Clients edit concurrently (same task, same field, deletes vs edits, moves, renames), then sync until
// quiet; every client and the server must end up with exactly the same lists.
//   cd worker && npm run test:e2e        (add --keep to keep the temp folders)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from '../../public/js/store.js';
import { listTree, cleanNotes } from '../../public/js/markdown.js';
import { startApp } from '../../../local/saqme.mjs';
import { generateVapidKeys } from '../../src/push.js';

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = join(workerDir, '..');
const keep = process.argv.includes('--keep');
const wranglerBin = join(workerDir, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const PORT = 8790 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- server
function devVarsToken() {
  const vars = join(workerDir, '.dev.vars');
  if (!existsSync(vars)) return null;
  return /^AUTH_TOKEN=(.*)$/m.exec(readFileSync(vars, 'utf8'))?.[1] ?? null;
}

async function startServer() {
  let token = devVarsToken();
  if (!token) {
    const vapid = await generateVapidKeys();
    token = randomBytes(32).toString('base64url');
    writeFileSync(join(workerDir, '.dev.vars'), `AUTH_TOKEN=${token}\nVAPID_PUBLIC_KEY=${vapid.publicKey}\nVAPID_PRIVATE_KEY=${vapid.privateKey}\n`, { mode: 0o600 });
  }
  const persist = mkdtempSync(join(tmpdir(), 'saqme-e2e-d1-'));
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
  const m = spawnSync(wranglerBin, ['d1', 'migrations', 'apply', 'saqme-dev', '--local', '--persist-to', persist, '-c', 'wrangler.dev.toml'],
    { cwd: workerDir, env, encoding: 'utf8' });
  if (m.status !== 0) throw new Error(`migrations failed:\n${m.stdout}\n${m.stderr}`);
  const srv = spawn(wranglerBin, ['dev', '--local', '-c', 'wrangler.dev.toml', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist],
    { cwd: workerDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(`${base}/api/health`)).ok) return { srv, token, persist }; } catch { /* not yet */ }
  }
  throw new Error(`wrangler dev did not start:\n${log}`);
}

// ---------------------------------------------------------------- desktop (PowerShell engine)
function findPowershell() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Write-Output $env:TEMP'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}
const winPath = (p) => (process.platform === 'win32' ? p : spawnSync('wslpath', ['-w', p], { encoding: 'utf8' }).stdout.trim());
const unixPath = (p) => (process.platform === 'win32' ? p : spawnSync('wslpath', ['-u', p], { encoding: 'utf8' }).stdout.trim());

class Desktop {
  constructor(winTemp, token) {
    this.winDir = `${winTemp}\\saqme-e2e-${randomBytes(4).toString('hex')}`;
    this.dir = unixPath(this.winDir);
    this.lists = join(this.dir, 'lists');
    mkdirSync(join(this.dir, 'sync'), { recursive: true });
    mkdirSync(this.lists, { recursive: true });
    this.token = token;
    this.script = winPath(join(repo, 'desktop', 'tests', 'e2e-desktop.ps1'));
  }
  write(name, text) { writeFileSync(join(this.lists, `${name}.md`), text); }
  read(name) { return readFileSync(join(this.lists, `${name}.md`), 'utf8'); }
  edit(name, fn) { this.write(name, fn(this.read(name))); }
  names() {
    const files = readdirSync(this.lists).filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.slice(0, -3));
    const order = existsSync(join(this.lists, '.order')) ? readFileSync(join(this.lists, '.order'), 'utf8').split(/\r?\n/).filter((n) => files.includes(n)) : [];
    return [...new Set(order), ...files.filter((f) => !order.includes(f)).sort()];
  }
  cycle(n = 1, settleMs = 0) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script,
      '-Url', base.replace('127.0.0.1', 'localhost'), '-Token', this.token, '-DataDir', this.winDir, '-Cycles', String(n), '-SettleMs', String(settleMs)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`desktop cycle failed: ${r.stderr || r.stdout}`);
    const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    for (const run of out.runs) if (run.status !== 'synced') throw new Error(`desktop sync ${run.status}: ${run.message}`);
    return out;
  }
}

// markdown -> model, with the reading rules every app shares (markdown.js; shared/fixtures/markdown.json)
function parseList(text) {
  const conv = (n) => ({ text: n.text, status: n.mark, due: n.due, notes: cleanNotes(n.notes), kids: n.kids.map(conv) });
  return listTree(text).map(conv);
}

// ---------------------------------------------------------------- canonical models
function modelFromRows(rows) {
  const projects = rows.filter((r) => r.kind === 'project' && !r.fields.deleted.v)
    .sort((a, b) => (a.fields.pos.v < b.fields.pos.v ? -1 : a.fields.pos.v > b.fields.pos.v ? 1 : a.id < b.id ? -1 : 1));
  const tasks = rows.filter((r) => r.kind === 'task' && !r.fields.deleted.v);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = {};
  for (const p of projects) {
    const mine = tasks.filter((t) => t.fields.place.v.project === p.id);
    const kids = new Map();
    const roots = [];
    for (const t of mine) {
      const parent = t.fields.place.v.parent;
      if (parent && byId.has(parent) && byId.get(parent).fields.place.v.project === p.id) (kids.get(parent) ?? kids.set(parent, []).get(parent)).push(t);
      else roots.push(t);
    }
    const sort = (list) => list.sort((a, b) => {
      const pa = a.fields.place.v.pos; const pb = b.fields.place.v.pos;
      return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : 1;
    });
    const build = (t) => ({ text: t.fields.text.v, status: t.fields.status.v, due: t.fields.due.v ? { date: t.fields.due.v.date, time: t.fields.due.v.time } : null,
      notes: t.fields.notes.v, kids: sort(kids.get(t.id) ?? []).map(build) });
    out[p.fields.name.v] = sort(roots).map(build);
  }
  return out;
}
const storeModel = (s) => modelFromRows([...s.rows.values()]);
function desktopModel(d) {
  const out = {};
  for (const n of d.names()) out[n] = parseList(d.read(n));
  return out;
}
async function serverRows(token) {
  const rows = new Map();
  let cursor = 0;
  for (;;) {
    const r = await (await fetch(`${base}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'e2e-observer', cursor, changes: [] }) })).json();
    for (const row of r.changes) rows.set(`${row.kind}:${row.id}`, row);
    cursor = r.cursor;
    if (!r.more) break;
  }
  return [...rows.values()];
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function diffModels(a, b) {
  const sa = JSON.stringify(a, null, 1).split('\n');
  const sb = JSON.stringify(b, null, 1).split('\n');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) if (sa[i] !== sb[i]) return `line ${i}: ${sa[i]} <> ${sb[i]}`;
  return '';
}

// ---------------------------------------------------------------- helpers to edit through the stores
const findTask = (s, text) => s.tasks().find((t) => t.fields.text.v === text && !t.fields.deleted.v);
const findProject = (s, name) => s.projects().find((p) => p.fields.name.v === name);

async function settle(clients, desktop) {
  for (let round = 0; round < 6; round++) {
    for (const c of clients) await c.sync({ force: true });
    if (desktop) desktop.cycle(2);
    for (const c of clients) await c.sync({ force: true });
    const models = clients.map(storeModel);
    if (desktop) models.push(desktopModel(desktop));
    if (models.every((m) => same(m, models[0])) && clients.every((c) => c.pendingCount() === 0)) return round;
  }
  return -1;
}

// ---------------------------------------------------------------- the Linux/macOS app
const hubs = [];
class LocalApp {
  static async start(token, lists) {
    const h = new LocalApp();
    h.dir = mkdtempSync(join(tmpdir(), 'saqme-e2e-app-'));
    h.lists = join(h.dir, 'lists');
    mkdirSync(h.lists, { recursive: true });
    mkdirSync(join(h.dir, 'sync'), { recursive: true });
    for (const [n, t] of Object.entries(lists)) writeFileSync(join(h.lists, `${n}.md`), t);
    writeFileSync(join(h.dir, 'sync', 'config.json'), JSON.stringify({ url: base, token, deviceId: 'mac-e2e', enabled: true }));
    h.app = await startApp({ dataDir: h.dir, port: 0, interval: 250, cloudInterval: 250, settleMs: 0, reminders: false });
    h.window = new Store({ base: h.app.url, autoSync: false });
    await h.window.open();
    h.window.setMeta({ token: h.app.token });
    return h;
  }
  names() { return Desktop.prototype.names.call(this); }
  read(name) { return readFileSync(join(this.lists, `${name}.md`), 'utf8'); }
  edit(name, fn) { writeFileSync(join(this.lists, `${name}.md`), fn(this.read(name))); }
  model() { const out = {}; for (const n of this.names()) out[n] = parseList(this.read(n)); return out; }
  quiet() { const { files, cloud } = this.app; return !files.state?.Outbox.length && !cloud.state?.Outbox.length; }
  async stop() { await this.app.stop(); if (!keep) rmSync(this.dir, { recursive: true, force: true }); }
}

/** Like settle(), with the app's engines running on their own: poll until every copy agrees. */
async function settleHub(clients, desktop, hub) {
  for (let round = 0; round < 30; round++) {
    for (const c of clients) await c.sync({ force: true });
    if (desktop && round % 3 === 0) desktop.cycle(1);
    await hub.window.sync({ force: true });
    await sleep(400);
    const srv = modelFromRows(await serverRows(clients[0].meta.token));
    const models = [...clients.map(storeModel), storeModel(hub.window), hub.model(), srv];
    if (desktop) models.push(desktopModel(desktop));
    if (models.every((m) => same(m, srv)) && hub.quiet() && clients.every((c) => c.pendingCount() === 0) && hub.window.pendingCount() === 0) return round;
  }
  return -1;
}

async function main() {
  const { srv, token, persist } = await startServer();
  const winTemp = process.argv.includes('--no-desktop') ? null : findPowershell();
  const desktop = winTemp ? new Desktop(winTemp, token) : null;
  console.log(`server on ${base}${desktop ? `, desktop lists in ${desktop.winDir}` : ' (no powershell.exe: desktop part skipped)'}`);
  const phoneA = new Store({ base, autoSync: false });
  const phoneB = new Store({ base, autoSync: false });
  await phoneA.open(); await phoneB.open();
  phoneA.setMeta({ token }); phoneB.setMeta({ token });
  const phones = [phoneA, phoneB];

  try {
    // ---------------------------------------------------------- 1. an existing desktop install (no ids yet) goes online
    console.log('1. first sync of existing lists');
    if (desktop) {
      desktop.write('Work', '# Work\nThings for the job.\n\n- [/] Ship roadmap due:2026-10-25T14:00\n  - [x] Collect feedback\n  - [ ] Write migration notes\n    > see https://example.com/doc\n- [ ] Call plumber\n- [!] Waiting on legal\n- [ ] Old task to delete\n\n## Later\n- [>] Clean dashboards\n');
      desktop.write('Home', '- [ ] Groceries\n  > milk, eggs\n- [ ] Fix bike\n');
      writeFileSync(join(desktop.lists, '.order'), 'Work\nHome\n');
      desktop.cycle(3);
      check(/\^[0-9a-z]{8}/.test(desktop.read('Work')), 'ids were written into the markdown');
      check(desktop.read('Work').includes('# Work\nThings for the job.\n'), 'headings and prose kept');
    } else {
      const w = phoneA.addProject('Work');
      const r = phoneA.addTask(w, { text: 'Ship roadmap', status: '/' });
      phoneA.addTask(w, { parentId: r, text: 'Collect feedback', status: 'x' });
      phoneA.addTask(w, { text: 'Call plumber' });
      phoneA.addTask(w, { text: 'Old task to delete' });
      phoneA.addTask(w, { text: 'Clean dashboards', status: '>' });
      const h = phoneA.addProject('Home');
      phoneA.addTask(h, { text: 'Groceries' });
      phoneA.addTask(h, { text: 'Fix bike' });
    }
    let r = await settle(phones, desktop);
    check(r >= 0, `everyone converged after the first sync (round ${r})`);
    const srvModel = modelFromRows(await serverRows(token));
    check(same(storeModel(phoneA), srvModel), 'phone matches the server');
    if (desktop) check(same(desktopModel(desktop), srvModel), `desktop files match the server ${diffModels(desktopModel(desktop), srvModel)}`);
    check(Object.keys(srvModel).join(',') === 'Work,Home', 'projects in tab order');

    // ---------------------------------------------------------- 2. concurrent edits
    console.log('2. concurrent edits on three devices');
    phoneA.setTask(findTask(phoneA, 'Ship roadmap').id, { text: 'Ship roadmap v2' });
    const sub = phoneA.addTask(findProject(phoneA, 'Work').id, { parentId: findTask(phoneA, 'Ship roadmap v2').id, text: 'Added on phone A' });
    phoneA.setTask(findTask(phoneA, 'Fix bike').id, { due: { date: '2026-11-02', time: '9:30' } });
    phoneB.setTask(findTask(phoneB, 'Ship roadmap').id, { status: 'x' });                    // other field: no conflict
    await sleep(5);
    if (desktop) {
      // file edits are timestamped by the file's last write, so do all desktop edits first ...
      desktop.edit('Work', (t) => t.replace(/Call plumber( \^\w+)/, 'Call the plumber today$1')     // same field as phone B
        .replace(/(- \[!\] Waiting on legal[^\n]*\n)/, '$1  > pinged them on Monday\n')
        .replace(/(\n## Later\n)/, '\n- [ ] Typed by hand without id\n$1'));
      await sleep(50);
      phoneB.setTask(findTask(phoneB, 'Call plumber').id, { text: 'Call plumber (urgent)' });        // ... then the newer phone edit
    } else {
      phoneA.setTask(findTask(phoneA, 'Call plumber').id, { text: 'Call the plumber today' });
      await sleep(20);
      phoneB.setTask(findTask(phoneB, 'Call plumber').id, { text: 'Call plumber (urgent)' });
    }
    await phoneA.sync({ force: true });
    if (desktop) desktop.cycle(2);
    await phoneB.sync({ force: true });
    r = await settle(phones, desktop);
    check(r >= 0, `converged after concurrent edits (round ${r})`);
    const t1 = findTask(phoneB, 'Ship roadmap v2');
    check(t1 && t1.fields.status.v === 'x', `edits to different fields of one task both survive (${t1?.fields.status.v}; ${JSON.stringify(phoneB.tasks().map((t) => [t.fields.text.v, t.fields.status.v]))})`);
    const plumber = phoneA.tasks().find((t) => /plumber/.test(t.fields.text.v));
    check(!!findTask(phoneA, 'Call plumber (urgent)'), `newest edit of the same field wins (${plumber?.fields.text.v} @${plumber?.fields.text.ts}; lost: ${JSON.stringify(phoneA.conflicts().map((c) => [c.value, c.valueTs, c.other]))})`);
    const conflictsA = phoneA.conflicts();
    check(conflictsA.length === 1 && conflictsA[0].field === 'text', `the losing value is kept as a conflict (${conflictsA.length})`);
    check(phoneB.conflicts().length === 1, 'conflict visible on the other phone too');
    if (desktop) {
      check(!!findTask(phoneA, 'Typed by hand without id'), 'hand-typed line synced');
      check(findTask(phoneA, 'Waiting on legal')?.fields.notes.v === 'pinged them on Monday', 'note added in the file synced');
      check(desktop.read('Work').includes('Added on phone A'), 'phone task landed in the markdown');
    }

    // ---------------------------------------------------------- 3. deletes vs edits, moves, renames
    console.log('3. delete vs edit, moves, project changes');
    const old = findTask(phoneA, 'Old task to delete');
    phoneA.deleteTask(old.id);
    await phoneA.sync({ force: true });
    await sleep(20);
    if (desktop) desktop.edit('Work', (t) => t.replace('Old task to delete', 'Old task, still needed'));   // newer edit -> resurrects
    else { phoneB.setTask(old.id, { text: 'Old task, still needed' }); }
    phoneB.moveTask(findTask(phoneB, 'Groceries').id, { projectId: findProject(phoneB, 'Work').id, parentId: null, index: 0 });
    const trip = phoneA.addProject('Trip');
    const pack = phoneA.addTask(trip, { text: 'Pack bags' });
    phoneA.addTask(trip, { parentId: pack, text: 'Charger' });
    if (desktop) {
      renameSync(join(desktop.lists, 'Home.md'), join(desktop.lists, 'House.md'));
      writeFileSync(join(desktop.lists, '.order'), 'Work\nHouse\n');
      desktop.edit('Work', (t) => t.replace(/- \[>\] Clean dashboards[^\n]*\n/, ''));                  // deleted on the desktop
    } else {
      phoneB.renameProject(findProject(phoneB, 'Home').id, 'House');
      phoneB.deleteTask(findTask(phoneB, 'Clean dashboards').id);
    }
    if (desktop) desktop.cycle(2);
    r = await settle(phones, desktop);
    check(r >= 0, `converged after deletes and moves (round ${r})`);
    check(!!findTask(phoneA, 'Old task, still needed'), 'edit newer than the delete brought the task back');
    check(phoneA.conflicts().some((c) => c.field === 'deleted'), 'and the delete is surfaced as a conflict');
    check(!findTask(phoneB, 'Clean dashboards'), 'desktop delete reached the phones');
    check(phoneA.trash().some((t) => t.fields?.text?.v === 'Clean dashboards'), 'deleted task is in Recently deleted');
    check(!!findProject(phoneA, 'House') && !findProject(phoneA, 'Home'), 'project rename synced');
    check(findTask(phoneA, 'Groceries')?.fields.place.v.project === findProject(phoneA, 'Work').id, 'task moved to another project');
    if (desktop) {
      check(desktop.read('Trip').includes('Pack bags') && /\n  - \[ \] Charger/.test(desktop.read('Trip')), 'new phone project became a list file with subtasks');
      check(desktop.read('Work').includes('Groceries'), 'moved task is in the other file now');
    }

    // ---------------------------------------------------------- 4. resolving a conflict + deleting a project
    console.log('4. resolve a conflict, delete a project');
    const c = phoneB.conflicts().find((x) => x.field === 'text');
    phoneB.resolveConflict(c.id, true);                     // keep the losing text after all
    phoneA.deleteProject(findProject(phoneA, 'Trip').id);
    r = await settle(phones, desktop);
    check(r >= 0, `converged (round ${r})`);
    check(!!findTask(phoneA, c.value), `"${c.value}" restored from the conflict everywhere`);
    check(phoneA.conflicts().filter((x) => x.field === 'text').length === 0, 'conflict resolved on the other phone too');
    if (desktop) {
      check(!desktop.names().includes('Trip'), 'deleted project left the lists folder');
      check(readdirSync(join(desktop.lists, '.trash')).some((f) => f.startsWith('Trip-')), '... into lists\\.trash, not erased');
    }

    // ---------------------------------------------------------- 5. random concurrent edits
    console.log('5. random concurrent edits (fuzz)');
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const rounds = desktop ? 6 : 12;
    for (let round = 0; round < rounds; round++) {
      for (const s of phones) {
        for (let k = 0; k < 6; k++) {
          const projs = s.projects();
          const proj = pick(projs);
          const tree = s.tree(proj.id);
          const nodes = [...tree.byId.values()];
          const op = rnd();
          if (op < 0.3 || !nodes.length) s.addTask(proj.id, { text: `${pick(words)} ${Math.floor(rnd() * 1000)}`, parentId: nodes.length && rnd() < 0.3 ? pick(nodes).id : null, index: 0 });
          else if (op < 0.45) s.setTask(pick(nodes).id, { text: `${pick(words)} edited ${Math.floor(rnd() * 100)}` });
          else if (op < 0.6) s.setTask(pick(nodes).id, { status: pick([' ', '/', 'x', '>', '!', '-', '~']) });
          else if (op < 0.7) s.setTask(pick(nodes).id, { due: rnd() < 0.5 ? null : { date: `2026-11-${10 + Math.floor(rnd() * 18)}`, time: rnd() < 0.5 ? '' : `${Math.floor(rnd() * 24)}:15` } });
          else if (op < 0.78) s.setTask(pick(nodes).id, { notes: rnd() < 0.3 ? '' : `note ${pick(words)}\nhttps://x.example/${Math.floor(rnd() * 99)}` });
          else if (op < 0.86) { const n = pick(nodes); const target = pick(nodes); if (target !== n) s.moveTask(n.id, { projectId: proj.id, parentId: rnd() < 0.5 ? null : target.id, index: 0 }); }
          else if (op < 0.92) s.moveTask(pick(nodes).id, { projectId: pick(projs).id, parentId: null });
          else s.deleteTask(pick(nodes).id);
        }
        if (rnd() < 0.6) await s.sync({ force: true });
      }
      if (desktop && rnd() < 0.8) {
        // the desktop edits its files like a person would: retext, re-status, reorder, add, delete lines
        const name = pick(desktop.names());
        desktop.edit(name, (t) => {
          const lines = t.split('\n');
          const taskLines = lines.map((l, i) => [l, i]).filter(([l]) => /^\s*- \[.\]/.test(l));
          if (!taskLines.length) return `${t}- [ ] desktop ${pick(words)} ${round}\n`;
          const [l, i] = pick(taskLines);
          const op = rnd();
          if (op < 0.3) lines[i] = l.replace(/\] (.*?)( due:| \^)/, `] $1 (pc ${round})$2`);
          else if (op < 0.5) lines[i] = l.replace(/\[.\]/, `[${pick([' ', '/', 'x', '>', '!'])}]`);
          else if (op < 0.7) lines.splice(i + 1, 0, `${l.match(/^\s*/)[0]}- [ ] desktop ${pick(words)} ${round}`);
          else if (op < 0.85 && i > 0 && /^- \[/.test(l)) { lines.splice(i, 1); lines.splice(0, 0, l); }
          else lines.splice(i, 1);
          return lines.join('\n');
        });
        desktop.cycle(1);
      }
    }
    r = await settle(phones, desktop);
    check(r >= 0, `converged after random edits (round ${r})`);
    const finalSrv = modelFromRows(await serverRows(token));
    for (const [i, s] of phones.entries()) check(same(storeModel(s), finalSrv), `phone ${i ? 'B' : 'A'} identical to the server ${diffModels(storeModel(s), finalSrv)}`);
    if (desktop) check(same(desktopModel(desktop), finalSrv), `desktop files identical to the server ${diffModels(desktopModel(desktop), finalSrv)}`);
    const counted = Object.values(finalSrv).flat().length;
    check(counted > 10, `lists are not empty (${counted} top-level tasks)`);

    // ---------------------------------------------------------- 6. a phone used offline first, paired later
    console.log('6. phone used without sync first, paired later');
    const phoneC = new Store({ base, autoSync: false });
    await phoneC.open();
    const workC = phoneC.addProject('Work');
    phoneC.addTask(workC, { text: 'Typed on the phone before pairing' });
    const ownC = phoneC.addProject('Phone only');
    phoneC.addTask(ownC, { text: 'Brand new list' });
    phoneC.setMeta({ token });
    await phoneC.sync({ force: true });
    await phoneC.sync({ force: true });
    const names = phoneC.projects().map((p) => p.fields.name.v);
    check(names.filter((n) => n === 'Work').length === 1, `same-name list merged, not duplicated (${names.join(', ')})`);
    check(names.includes('Phone only'), 'phone-only list uploaded');
    r = await settle([phoneA, phoneB, phoneC], desktop);
    check(r >= 0, `converged (round ${r})`);
    check(!!findTask(phoneA, 'Typed on the phone before pairing') && findTask(phoneA, 'Typed on the phone before pairing').fields.place.v.project === findProject(phoneA, 'Work').id, 'its task is in the shared Work list');
    if (desktop) check(desktop.read('Work').includes('Typed on the phone before pairing') && desktop.names().includes('Phone only'), 'and on the desktop');

    // ---------------------------------------------------------- 7. an editor left open while a newer edit arrives
    console.log('7. stale editor on the phone');
    const target = findTask(phoneA, 'Typed on the phone before pairing');
    const opened = { v: target.fields.text.v, ts: target.fields.text.ts };   // what the editor showed
    await sleep(5);
    phoneB.setTask(target.id, { text: 'Edited on phone B meanwhile' });
    await phoneB.sync({ force: true });
    await phoneA.sync({ force: true });                                      // arrives while phone A is "typing"
    await sleep(5);
    phoneA.setTask(target.id, { text: 'Phone A typed this' }, { base: opened.ts });
    r = await settle([phoneA, phoneB, phoneC], desktop);
    check(r >= 0, `converged (round ${r})`);
    check(phoneB.conflicts().some((x) => x.task === target.id && x.value === 'Edited on phone B meanwhile'), 'the overwritten edit is kept as a conflict, not lost');

    // ---------------------------------------------------------- 8. the Linux/macOS app joins with lists of its own
    console.log('8. the Linux/macOS app joins (lists folder + window + cloud)');
    const hub = await LocalApp.start(token, { Work: '- [ ] Typed on the Mac\n', Garden: '- [ ] Plant tulips\n  - [ ] Buy bulbs\n' });
    hubs.push(hub);
    const all = [phoneA, phoneB, phoneC];
    r = await settleHub(all, desktop, hub);
    check(r >= 0, `converged with the app (round ${r})`);
    const names9 = hub.names();
    check(names9.filter((n) => n === 'Work').length === 1 && names9.includes('Garden'), `same-name list adopted, its own list uploaded (${names9.join(', ')})`);
    check(!!findTask(phoneA, 'Typed on the Mac') && !!findTask(phoneA, 'Buy bulbs'), 'its tasks reached the phones');
    const srvWork = modelFromRows(await serverRows(token)).Work;
    check(srvWork.length > 2 && same(hub.model().Work, srvWork), `the shared Work list arrived in its folder (${srvWork.length} top-level tasks)`);
    // the window edits, a phone edits, and an AI assistant edits the folder, all at once
    hub.window.setTask(findTask(hub.window, 'Plant tulips').id, { status: '/' });
    phoneB.setTask(findTask(phoneB, 'Buy bulbs').id, { due: { date: '2026-11-05', time: '' } });
    hub.edit('Work', (t) => `${t}- [ ] Added by an assistant in the folder\n`);
    r = await settleHub(all, desktop, hub);
    check(r >= 0, `converged (round ${r})`);
    check(findTask(phoneA, 'Plant tulips')?.fields.status.v === '/', 'window edit reached the phones (through the folder)');
    check(/- \[ \] Buy bulbs due:2026-11-05/.test(hub.read('Garden')), 'phone edit reached the folder');
    check(!!findTask(hub.window, 'Added by an assistant in the folder'), 'folder edit reached the window');
    if (desktop) check(desktop.read('Work').includes('Added by an assistant in the folder'), 'and the Windows desktop');
    // random edits from the window too
    for (let round = 0; round < 4; round++) {
      for (const s of [phoneA, hub.window]) {
        const proj = pick(s.projects());
        const nodes = [...s.tree(proj.id).byId.values()];
        if (!nodes.length || rnd() < 0.4) s.addTask(proj.id, { text: `${pick(words)} hub ${round}` });
        else if (rnd() < 0.5) s.setTask(pick(nodes).id, { text: `${pick(words)} hub edit ${round}` });
        else if (rnd() < 0.7) s.setTask(pick(nodes).id, { status: pick([' ', '/', 'x']) });
        else s.deleteTask(pick(nodes).id);
        await s.sync({ force: true });
      }
      await sleep(300);
    }
    r = await settleHub(all, desktop, hub);
    check(r >= 0, `converged after random edits with the app (round ${r})`);
    const final9 = modelFromRows(await serverRows(token));
    check(same(hub.model(), final9), `app folder identical to the server ${diffModels(hub.model(), final9)}`);
    check(same(storeModel(hub.window), final9), `app window identical to the server ${diffModels(storeModel(hub.window), final9)}`);

    if (desktop) {
      // ---------------------------------------------------------- 9. a list saved a moment ago is never rewritten
      console.log('9. remote change arrives right after a local save');
      const yId = phoneA.addTask(findProject(phoneA, 'Work').id, { text: 'Buy bread' });
      await settle([phoneA, phoneB, phoneC], desktop);
      phoneA.setTask(yId, { status: 'x' });
      await phoneA.sync({ force: true });
      desktop.edit('Work', (t) => t.replace(/Buy bread( \^\w+)/, 'Buy bread and coffee$1'));
      desktop.cycle(1, 60_000);                                    // the file counts as "just written"
      check(desktop.read('Work').includes('- [ ] Buy bread and coffee'), 'the fresh local edit is untouched by that cycle');
      desktop.cycle(2);
      r = await settle([phoneA, phoneB, phoneC], desktop);
      const g = findTask(phoneA, 'Buy bread and coffee');
      check(r >= 0 && g && g.fields.status.v === 'x', 'then both edits merge (desktop text + phone status)');
      check(desktop.read('Work').includes('- [x] Buy bread and coffee'), 'and the file shows both');
    }
  } finally {
    for (const h of hubs) await h.stop();
    try { process.kill(-srv.pid); } catch { srv.kill(); }
    if (!keep) {
      rmSync(persist, { recursive: true, force: true });
      if (desktop) rmSync(desktop.dir, { recursive: true, force: true });
    }
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall end-to-end checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
