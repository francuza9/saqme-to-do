#!/usr/bin/env node
// Saqme To Do for Linux and macOS (also runs on Windows, for development).
//
//   saqme open             start the app if needed and open its window
//   saqme serve            run the app in the foreground (what the login item / service runs)
//   saqme status           where the lists are, whether it runs, cloud sync state
//   saqme stop             stop the running app
//   saqme allow-deletes    confirm a paused mass delete in the lists folder
//   saqme pair-phone       the QR code and link that connect your phone (once cloud sync is set up)
//   saqme connect LINK     sync with the cloud using a pairing link from a device that already syncs
//   options: --data DIR (default: see local/paths.mjs, or $SAQME_DATA)   --port N (default 47613)
//
// The app is one process: a local server for the window (the phone app's own files and sync API, on
// 127.0.0.1) and the lists folder kept in step with it, so AI assistants and editors can change the
// markdown files directly. If cloud sync is set up (sync/config.json, written by `setup.sh --cloud`), the
// same folder is also synced with your Cloudflare Worker, exactly like the Windows app does.
//
//   window (phone app) <-> local store <-> [files engine] <-> lists/*.md <-> [cloud engine] <-> your Worker
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1 } from './d1.mjs';
import { startServer } from './server.mjs';
import { notify, openWindow } from './desktop.mjs';
import { APP_DIR, DEFAULT_PORT, appPaths, cloudSetupStatePath, dataPaths, defaultDataDir } from './paths.mjs';
import { applyPlanToFolder, openConflicts, readState, syncCycle } from './engine.mjs';
import { handleSync, HttpError } from '../worker/src/sync.js';
import { computeReminders, localClock } from '../worker/src/reminders.js';
import { parsePairingLink } from '../worker/public/js/pairing.js';

export const VERSION = '1.0.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- small helpers
function readJsonFile(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function writePrivate(path, text) { writeFileSync(path, text, { mode: 0o600 }); try { chmodSync(path, 0o600); } catch { /* Windows */ } }

function logger(path) {
  return (msg) => {
    try {
      if (existsSync(path) && statSync(path).size > 256 * 1024) renameSync(path, `${path}.old`);
      appendFileSync(path, `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${msg}\n`);
    } catch { /* logging must never break the app */ }
  };
}

export function readOrCreateToken(path) {
  try { const t = readFileSync(path, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* first run */ }
  const t = randomBytes(32).toString('base64url');
  writePrivate(path, `${t}\n`);
  return t;
}

function portSetting(p, override) {
  if (override) return Number(override);
  return Number(readJsonFile(`${p.local}/settings.json`)?.port) || DEFAULT_PORT;
}

/** Is our server answering on this port? */
async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json()).local === true;
  } catch { return false; }
}

// ---------------------------------------------------------------- engine loop (like desktop/sync-worker.ps1)
export class EngineLoop {
  /** target() -> { transport, deviceId, label } or null (off); onSetting(value) for a synced notifyAt from the server */
  constructor({ name, statePath, listsDir, target, notifyAt = () => '', onSetting = () => {}, onApplied = () => {}, interval, log, settleMs = 1500 }) {
    Object.assign(this, { name, statePath, listsDir, target, notifyAt, onSetting, onApplied, interval, log, settleMs });
    this.status = { state: 'off', message: '', lastSync: 0, guarded: 0, conflicts: 0, pending: 0, label: '' };
    this.state = null;
    this.allowMassDelete = false;
    this.stopped = false;
    this.wakeTimer = null;
  }

  wake() { this.woken = true; this.resolveWait?.(); }

  wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.resolveWait = done;
    });
  }

  /** One cycle (exported for tests: they drive engines step by step). */
  async step() {
    const tgt = this.target();
    if (!tgt) { this.status = { ...this.status, state: 'off', message: '', label: '' }; this.state = null; return { status: 'off' }; }
    this.status.label = tgt.label ?? '';
    this.state ??= readState(this.statePath);
    const allow = this.allowMassDelete;
    const res = await syncCycle({
      state: this.state, statePath: this.statePath, listsDir: this.listsDir, transport: tgt.transport, deviceId: tgt.deviceId,
      notifyAt: this.notifyAt(), allowMassDelete: allow, settleMs: this.settleMs,
      applyPlan: (plan) => {
        const ok = applyPlanToFolder(plan, this.listsDir);
        if (ok && plan.setting != null) this.onSetting(plan.setting);
        if (ok && plan.ops.length) this.onApplied();
        return ok;
      },
    });
    if (allow) this.allowMassDelete = false;
    this.status.guarded = res.guarded;
    this.status.conflicts = openConflicts(this.state).length;
    this.status.pending = this.state.Outbox.length;
    return res;
  }

  async run() {
    let failures = 0;
    let retryMs = 0;
    this.woken = true;   // first cycle right away
    while (!this.stopped) {
      if (!this.woken) await this.wait(retryMs || this.interval);
      if (this.stopped) break;
      if (this.woken) { this.woken = false; await sleep(this.settleMs ? 1600 : 0); }   // let a burst of edits settle
      try {
        if (this.status.state !== 'synced') this.status.state = 'syncing';
        const res = await this.step();
        if (res.status === 'off') { retryMs = 0; continue; }
        switch (res.status) {
          case 'synced':
            failures = 0;
            this.status.lastSync = Date.now();
            if (res.refused.length) this.log(`${this.name}: refused by the server: ${res.refused.join('; ')}`);
            if (res.guarded) this.setStatus('error', `${res.guarded} tasks disappeared from the lists folder at once. Deleting them everywhere is paused until you confirm.`);
            else if (res.refused.length) this.setStatus('error', `The server refused a change (${res.refused[0]}).`);
            else this.setStatus('synced', '');
            retryMs = res.retry ? 2500 : 0;
            if (res.sent || res.received) this.log(`${this.name}: synced, sent ${res.sent}, received ${res.received}`);
            break;
          case 'offline': failures++; this.setStatus('offline', `Offline - changes are kept and sent later (${res.message})`); retryMs = Math.min(60_000, 5000 * failures); break;
          case 'auth': failures++; this.setStatus('error', res.message); retryMs = 60_000; this.log(`${this.name}: ${res.message}`); break;
          default: failures++; this.setStatus('error', res.message); retryMs = Math.min(120_000, 10_000 * failures); this.log(`${this.name}: error: ${res.message}`);
        }
      } catch (e) {
        failures++;
        this.setStatus('error', `Sync failed: ${e?.message ?? e}`);
        this.log(`${this.name}: exception: ${e?.stack ?? e}`);
        this.state = null;   // reload from disk next time
        retryMs = Math.min(120_000, 10_000 * failures);
      }
    }
  }

  setStatus(state, message) { this.status.state = state; this.status.message = message; }
  stop() { this.stopped = true; this.resolveWait?.(); }
}

// ---------------------------------------------------------------- the app
/** Transport for an engine talking to the local store in-process. */
export function localTransport(env) {
  return async (body) => {
    try { return { status: 200, data: await handleSync(env, body) }; } catch (e) {
      if (e instanceof HttpError) return { status: e.status, data: { error: e.message } };
      throw e;
    }
  };
}

/** Transport for an engine talking to a Worker over HTTPS. */
export function httpTransport(url, token) {
  return async (body) => {
    let r;
    try {
      r = await fetch(`${url.replace(/\/+$/, '')}/api/sync`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(25_000),
      });
    } catch (e) { throw new Error(e?.cause?.message ?? e?.message ?? 'no connection'); }
    let data = null;
    try { data = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, data };
  };
}

/** Pairing link (https://<worker>/#pair=<token>) -> sync/config.json, keeping this computer's device id. */
export function connectCloud(path, link) {
  const p = parsePairingLink(link);   // https only (plain http just to this computer), no user name in the address
  if (!p?.server) throw new Error('That is not a pairing link (it looks like https://saqme.<name>.workers.dev/#pair=...).');
  const prev = readJsonFile(path) ?? {};
  mkdirSync(dirname(path), { recursive: true });
  writePrivate(path, JSON.stringify({ url: p.server, token: p.key, deviceId: prev.deviceId, enabled: true }, null, 2));
  return p.server;
}

/**
 * Settings > Sync > Set up sync: runs scripts/cloud-setup.mjs (what setup.sh --cloud runs) from this server and
 * keeps its output for the window. The Cloudflare sign-in opens in the browser (its link is in the output too).
 * It writes sync/config.json when it succeeds; onDone() then wakes the cloud engine.
 */
export function cloudSetupRunner(p, { log = () => {}, onDone = () => {} } = {}) {
  let run = null;
  const status = () => (run ? { running: !run.done, lines: run.lines.slice(-200), result: run.result } : { running: false, lines: [], result: null });
  return {
    status,
    start() {
      if (run && !run.done) return status();
      if (!existsSync(appPaths.cloudSetup)) throw new Error('The cloud setup is not installed with this app. Run setup.sh --cloud instead.');
      const resultFile = join(p.local, 'setup-result.json');
      try { unlinkSync(resultFile); } catch { /* none */ }
      // npm (for the Cloudflare tools) sits next to this Node.js; --yes: no questions, nobody is at a terminal
      const env = { ...process.env, NO_COLOR: '1', PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
      const args = [appPaths.cloudSetup, '--state', cloudSetupStatePath(), '--desktop-config', p.cloudConfig,
        '--pair-again', 'Settings > Sync > Pair phone', '--yes', '--result', resultFile];
      const child = spawn(process.execPath, args, { cwd: dirname(dirname(appPaths.cloudSetup)), env, stdio: ['ignore', 'pipe', 'pipe'] });
      const r = { child, lines: [], result: null, done: false };
      run = r;
      const add = (chunk) => {
        for (const l of String(chunk).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
          if (l.trim() && !/^[\s█▀▄]+$/.test(l)) r.lines.push(l.trim());   // the terminal QR code: the window shows its own
        }
        if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 400);
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const finish = (code) => {
        if (r.done) return;
        r.done = true;
        r.result = readJsonFile(resultFile) ?? { ok: false, message: code == null ? 'Stopped.' : 'The cloud setup did not finish.', next: 'Running it again is safe.' };
        log(`cloud setup: ${r.result.ok ? `done, ${r.result.url}` : r.result.message}`);
        if (r.result.ok) onDone();
      };
      child.on('error', (e) => { add(`Could not run the cloud setup: ${e.message}`); finish(1); });
      child.on('close', finish);
      log('cloud setup: started from Settings');
      return status();
    },
    cancel() { if (run && !run.done) run.child.kill(); },
  };
}

/** Settings > Sync > Turn off sync: this computer stops syncing; the lists and the cloud copy stay. */
export function disconnectCloud(path) {
  const c = readJsonFile(path);
  if (c) writePrivate(path, JSON.stringify({ ...c, enabled: false }, null, 2));
}

function readCloudConfig(path) {
  const c = readJsonFile(path);
  if (!c || !c.url || !c.token || c.enabled === false) return null;
  if (!c.deviceId) {
    c.deviceId = `${process.platform === 'darwin' ? 'mac' : 'pc'}-${randomBytes(8).toString('hex').slice(0, 10)}`;
    try { writePrivate(path, JSON.stringify(c, null, 2)); } catch { /* read-only: a fresh id next time is harmless */ }
  }
  return c;
}

/** A one-time pairing code from the cloud sync service (for the app on an iPhone's Home Screen), or null. */
async function cloudPairingCode(c) {
  try {
    const res = await fetch(`${c.url.replace(/\/+$/, '')}/api/pair/code`, {
      method: 'POST', headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(8000),
    });
    return res.ok ? (await res.json()).code ?? null : null;
  } catch { return null; }   // offline, or a sync service from before codes: the link still works
}

async function localReminders(d1, notifyFn, nowMs = Date.now()) {
  const settings = Object.fromEntries((await d1.prepare('SELECT key, value FROM settings').all()).results.map((r) => [r.key, r.value]));
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';   // notifications show on this computer
  const today = localClock(tz, nowMs).date;
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const { results } = await d1.prepare(
    `SELECT t.id, t.text, t.status, t.due, t.due_time, p.name AS project
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.due IS NOT NULL AND t.deleted = 0 AND p.deleted = 0 AND t.status IN (' ', '/', '!') AND t.due <= ?1`,
  ).bind(horizon).all();
  const notified = new Set((await d1.prepare('SELECT key FROM notified WHERE at > ?1').bind(nowMs - 8 * 86_400_000).all()).results.map((r) => r.key));
  const tasks = results.map((r) => ({ id: r.id, text: r.text, status: r.status, due: r.due, dueTime: r.due_time, project: r.project }));
  let shown = 0;
  for (const r of computeReminders(tasks, { tz, notifyAt: settings.notifyAt || '10:00', nowMs, notified }).slice(0, 8)) {
    const claimed = await d1.prepare(`INSERT INTO notified (key, at) SELECT value, ?2 FROM json_each(?1) WHERE true ON CONFLICT(key) DO NOTHING RETURNING key`)
      .bind(JSON.stringify(r.keys), nowMs).all();
    if (!claimed.results.some((x) => x.key === r.keys[0])) continue;
    notifyFn(r);
    shown++;
  }
  await d1.prepare('DELETE FROM notified WHERE at < ?1').bind(nowMs - 8 * 86_400_000).run();
  return shown;
}

/**
 * Starts everything; resolves to { url, port, token, files, cloud, d1, stop() }. Options:
 *   dataDir, port, interval (files engine), cloudInterval, settleMs, reminders (false in tests), quiet
 */
export async function startApp({ dataDir = defaultDataDir(), port, interval = 10_000, cloudInterval = 12_000, settleMs = 1500, reminders = true, watchFiles = true } = {}) {
  const p = dataPaths(dataDir);
  for (const d of [p.lists, p.local, p.sync]) {
    mkdirSync(d, { recursive: true });
    try { chmodSync(d, 0o700); } catch { /* not ours to change */ }   // the lists are private, like the keys
  }
  const log = logger(p.log);
  const token = readOrCreateToken(p.token);
  const d1 = new D1(p.db);
  d1.migrate(appPaths.migrations);
  const env = { DB: d1, AUTH_TOKEN: token };
  const local = localTransport(env);

  const files = new EngineLoop({
    name: 'files', statePath: p.filesState, listsDir: p.lists, interval, log, settleMs,
    target: () => ({ transport: local, deviceId: 'files', label: 'this computer' }),
  });
  const cloud = new EngineLoop({
    name: 'cloud', statePath: p.cloudState, listsDir: p.lists, interval: cloudInterval, log, settleMs,
    target: () => {
      const c = readCloudConfig(p.cloudConfig);
      return c ? { transport: httpTransport(c.url, c.token), deviceId: c.deviceId, label: new URL(c.url).host } : null;
    },
    notifyAt: () => d1.db.prepare(`SELECT value FROM settings WHERE key = 'notifyAt'`).get()?.value ?? '',
    onSetting: (v) => {
      local({ deviceId: 'files', cursor: Number.MAX_SAFE_INTEGER, changes: [{ kind: 'setting', id: 'notifyAt', fields: { value: { v, ts: Date.now(), base: -1 } } }] })
        .catch((e) => log(`cloud: could not store notifyAt: ${e?.message ?? e}`));
    },
  });
  // each engine's writes are the other one's news (the folder watcher catches them too)
  files.onApplied = () => cloud.wake();
  cloud.onApplied = () => files.wake();

  const info = () => ({
    lists: p.lists,
    files: files.status,
    cloud: cloud.status.state === 'off' ? null : cloud.status,
    guarded: Math.max(files.status.guarded, cloud.status.guarded),
  });
  const srv = await startServer({
    port: port ?? portSetting(p), token, d1, publicDir: appPaths.public, version: VERSION, info,
    onSync: () => files.wake(),
    onAllowDeletes: () => { files.allowMassDelete = true; cloud.allowMassDelete = true; files.wake(); cloud.wake(); },
    connect: (link) => { const url = connectCloud(p.cloudConfig, link); cloud.wake(); log(`cloud: connected to ${url}`); return url; },
    cloudSetup: cloudSetupRunner(p, { log, onDone: () => cloud.wake() }),
    disconnect: () => { disconnectCloud(p.cloudConfig); cloud.wake(); log('cloud: turned off in Settings'); },
    pairingLink: () => { const c = readCloudConfig(p.cloudConfig); return c ? `${c.url.replace(/\/+$/, '')}/#pair=${c.token}` : null; },
    pairingCode: () => { const c = readCloudConfig(p.cloudConfig); return c ? cloudPairingCode(c) : null; },
    onStop: () => app.stop().then(() => process.exit(0)),
  });
  writeFileSync(p.server, JSON.stringify({ port: srv.port, pid: process.pid, version: VERSION }));

  let watcher = null;
  if (watchFiles) {
    try {
      watcher = watch(p.lists, (ev, name) => {
        if (!name || name.endsWith('.tmp') || name.includes('.renaming')) return;
        files.wake(); cloud.wake();
      });
    } catch (e) { log(`folder watch unavailable (${e.message}); checking every ${interval / 1000} s`); }
  }
  const loops = [files.run(), cloud.run()];
  let reminderTimer = null;
  if (reminders) {
    const tick = () => localReminders(d1, (r) => notify(r, { icon: appPaths.icon })).catch((e) => log(`reminders: ${e?.message ?? e}`));
    setTimeout(tick, 5000);
    reminderTimer = setInterval(tick, 60_000);
  }
  log(`started ${VERSION} on ${srv.url}, lists in ${p.lists}`);

  const app = {
    url: srv.url, port: srv.port, token, files, cloud, d1, paths: p,
    async stop() {
      files.stop(); cloud.stop();
      clearInterval(reminderTimer);
      watcher?.close();
      await Promise.all(loops);
      await srv.close();
      d1.close();
      try { if (readJsonFile(p.server)?.pid === process.pid) unlinkSync(p.server); } catch { /* gone */ }
      log('stopped');
    },
  };
  return app;
}

// ---------------------------------------------------------------- commands
async function api(p, port, path, method = 'GET') {
  const token = readFileSync(p.token, 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function runningPort(p, override) {
  return override ? Number(override) : (readJsonFile(p.server)?.port ?? portSetting(p));
}

async function cmdServe(opts) {
  const p = dataPaths(opts.data);
  const port = portSetting(p, opts.port);
  if (await ping(port)) { console.log(`Saqme To Do is already running on http://127.0.0.1:${port}`); return; }
  let app;
  try { app = await startApp({ dataDir: p.data, port }); } catch (e) {
    if (e.code === 'EADDRINUSE') { console.error(`Port ${port} is used by another program. Choose another one: setup.sh --port N (or saqme serve --port N).`); process.exit(1); }
    throw e;
  }
  console.log(`Saqme To Do is running on ${app.url}\nLists: ${p.lists}`);
  const quit = () => app.stop().then(() => process.exit(0));
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
}

async function cmdOpen(opts) {
  const p = dataPaths(opts.data);
  let port = runningPort(p, opts.port);
  if (!(await ping(port))) {
    port = portSetting(p, opts.port);
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'serve', '--data', p.data, '--port', String(port)],
      { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 40 && !(await ping(port)); i++) await sleep(250);
    if (!(await ping(port))) { console.error(`Saqme To Do did not start. See ${p.log}`); process.exit(1); }
  }
  const { code } = await api(p, port, '/api/local/code', 'POST');
  const used = openWindow(launchPage(p, `http://127.0.0.1:${port}/#claim=${code}`));
  if (!used) console.log(`Open http://127.0.0.1:${port} in a browser.`);
}

/**
 * The window opens a private page (0600, in the data folder) that forwards to the app with the one-time code:
 * a URL with the code on the browser's command line could be read by other users of this computer and used
 * first. The code is single-use and expires in two minutes, so the page can stay.
 */
function launchPage(p, url) {
  const file = join(p.local, 'open.html');
  mkdirSync(p.local, { recursive: true });
  writePrivate(file, `<!doctype html><meta charset="utf-8"><title>Saqme To Do</title>\n<meta http-equiv="refresh" content="0;url=${url}">\n<script>location.replace(${JSON.stringify(url)})</script>\n`);
  return pathToFileURL(file).href;
}

async function cmdStatus(opts) {
  const p = dataPaths(opts.data);
  const port = runningPort(p, opts.port);
  console.log(`Saqme To Do ${VERSION}\nLists folder: ${p.lists}\nApp files:    ${APP_DIR}`);
  if (!(await ping(port))) { console.log('Not running (start it with: saqme open)'); return; }
  const i = await api(p, port, '/api/local');
  console.log(`Running on http://127.0.0.1:${port}`);
  console.log(`Lists folder sync: ${i.files.state}${i.files.message ? ` - ${i.files.message}` : ''}`);
  console.log(i.cloud ? `Cloud sync (${i.cloud.label}): ${i.cloud.state}${i.cloud.message ? ` - ${i.cloud.message}` : ''}${i.cloud.conflicts ? `, ${i.cloud.conflicts} conflicts to look at on your phone` : ''}`
    : 'Cloud sync: off (add it with: setup.sh --cloud)');
  if (i.guarded) console.log(`${i.guarded} tasks vanished from the lists folder at once; deleting them is paused. Confirm with: saqme allow-deletes`);
}

async function cmdPairPhone(opts) {
  const p = dataPaths(opts.data);
  const c = readCloudConfig(p.cloudConfig);
  if (!c) { console.log('Cloud sync is not set up on this computer yet. Run setup.sh --cloud first.'); process.exit(1); }
  const { qrMatrix, qrToTerminal } = await import('../worker/public/js/qr.js');
  const link = `${c.url.replace(/\/+$/, '')}/#pair=${c.token}`;
  const code = await cloudPairingCode(c);
  console.log(`\nYour phone (the link is your key - keep it private)\n\n${qrToTerminal(qrMatrix(link, 'M'), { margin: 2 })}\n\n  ${link}\n`);
  console.log('  1. Scan the QR code with the phone camera and open the link (Safari on iPhone, Chrome on Android).');
  console.log('  2. Add it to the Home Screen (iPhone: Share > Add to Home Screen; Android: menu > Install app).');
  if (code) console.log(`  3. iPhone: open Saqme from the Home Screen and type the code ${code} (works once, for 10 minutes).`);
  console.log(`  ${code ? 4 : 3}. Open Saqme from the Home Screen, then Settings > Notifications > Enable.\n`);
}

async function cmdConnect(opts) {
  const p = dataPaths(opts.data);
  const url = connectCloud(p.cloudConfig, opts.args[0] ?? '');
  console.log(`Connected to ${new URL(url).host}. Lists with the same name are merged; syncing starts within a few seconds.`);
}

async function cmdSimple(opts, path, done) {
  const p = dataPaths(opts.data);
  const port = runningPort(p, opts.port);
  if (!(await ping(port))) { console.log('Saqme To Do is not running.'); return; }
  await api(p, port, path, 'POST');
  console.log(done);
}

function parseArgs(argv) {
  const opts = { cmd: argv[0] ?? 'help', args: [] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--data') opts.data = argv[++i];
    else if (argv[i] === '--port') opts.port = argv[++i];
    else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
    else opts.args.push(argv[i]);
  }
  opts.data = opts.data ?? defaultDataDir();
  return opts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.umask(0o077);   // lists, database, logs: readable by this user only
  const opts = parseArgs(process.argv.slice(2));
  const commands = {
    serve: () => cmdServe(opts),
    open: () => cmdOpen(opts),
    status: () => cmdStatus(opts),
    stop: () => cmdSimple(opts, '/api/local/stop', 'Stopped.'),
    'allow-deletes': () => cmdSimple(opts, '/api/local/allow-deletes', 'Confirmed: the vanished tasks will be deleted everywhere.'),
    'pair-phone': () => cmdPairPhone(opts),
    connect: () => cmdConnect(opts),
    version: () => console.log(VERSION),
  };
  const run = commands[opts.cmd];
  if (!run) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(opts.cmd === 'help' || opts.cmd === '--help' ? 0 : 2);
  }
  run().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
