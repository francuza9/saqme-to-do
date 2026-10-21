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
//   saqme join LINK        join a list someone shares with you, from their invite link (.../join#code=...)
//   saqme invite LINK      what saqme:// links run: shows the invite in the window, which asks before joining
//   saqme update           install the newest release now (the app also does it by itself; local/updater.mjs)
//   saqme version          which version this is
//   options: --data DIR (default: see local/paths.mjs, or $SAQME_DATA)   --port N (default 47613)
//
// The app is one process: a local server for the window (the phone app's own files and sync API, on
// 127.0.0.1) and the lists folder kept in step with it, so AI assistants and editors can change the
// markdown files directly. If cloud sync is set up (sync/config.json, written by `setup.sh --cloud`), the
// same folder is also synced with your Cloudflare Worker, exactly like the Windows app does.
//
//   window (phone app) <-> local store <-> [files engine] <-> lists/*.md <-> [cloud engine] <-> your Worker
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1 } from './d1.mjs';
import { startServer } from './server.mjs';
import { notify, openWindow } from './desktop.mjs';
import { APP_DIR, DEFAULT_PORT, appPaths, cloudSetupStatePath, dataPaths, defaultDataDir } from './paths.mjs';
import { applyPlanToFolder, openConflicts, readState, saveState, syncCycle } from './engine.mjs';
import { Shares } from './shares.mjs';
import { handleSync, HttpError } from '../worker/src/sync.js';
import { computeReminders, localClock } from '../worker/src/reminders.js';
import { parseInviteLink, parsePairingLink, serverLabel } from '../worker/public/js/pairing.js';
import { VERSION } from '../worker/src/version.js';
import { installRoot, prepareWorkspace } from './update.mjs';
import { Updater, settingsFile } from './updater.mjs';

export { VERSION };
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
  /**
   * target() -> { transport, deviceId, label } or null (off); onSetting(value) for a synced notifyAt from the server.
   * Shared lists (local/shares.mjs): view() -> which lists it syncs (engine.mjs readLocalLists), scope() -> the one
   * shared list it syncs, afterPlan(plan) right after a plan was applied (before any other engine runs: renames
   * follow into lists/.remotes.json), onResult(res) after each cycle. expected = { keys, until }: task keys whose
   * disappearance is not held back as a mass delete, until then. quiet: refusals are expected (notices), not an error.
   */
  constructor({
    name, statePath, listsDir, target, notifyAt = () => '', onSetting = () => {}, onApplied = () => {}, interval, log, settleMs = 1500,
    view = () => null, scope = () => null, afterPlan = () => {}, onResult = () => {}, quiet = false,
  }) {
    Object.assign(this, { name, statePath, listsDir, target, notifyAt, onSetting, onApplied, interval, log, settleMs, view, scope, afterPlan, onResult, quiet });
    this.status = { state: 'off', message: '', lastSync: 0, guarded: 0, conflicts: 0, pending: 0, label: '' };
    this.state = null;
    this.allowMassDelete = false;
    this.expected = null;
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
    const expected = this.expected && this.expected.until > Date.now() ? this.expected.keys : null;
    const scope = this.scope();
    const res = await syncCycle({
      state: this.state, statePath: this.statePath, listsDir: this.listsDir, transport: tgt.transport, deviceId: tgt.deviceId,
      notifyAt: scope ? '' : this.notifyAt(), allowMassDelete: allow, settleMs: this.settleMs, view: this.view(), scope, expected,
      applyPlan: (plan) => {
        const ok = applyPlanToFolder(plan, this.listsDir);
        if (ok) this.afterPlan(plan);
        if (ok && plan.setting != null) this.onSetting(plan.setting);
        if (ok && plan.ops.length) this.onApplied();
        return ok;
      },
    });
    if (allow) this.allowMassDelete = false;
    if (res.api) { this.status.workerApi = res.api; this.status.workerVersion = res.workerVersion; }   // (the server it syncs with: older or newer than this app)
    this.status.guarded = res.guarded;
    this.status.conflicts = openConflicts(this.state).length;
    this.status.pending = this.state.Outbox.length;
    this.onResult(res);
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
            else if (res.refused.length && !this.quiet) this.setStatus('error', `The server refused a change (${res.refused[0]}).`);
            else this.setStatus('synced', '');
            // a cycle that asks to run again (first contact, ids written, a list mid-edit) waits for edits to
            // settle like a wake-up does; without settling (settleMs 0, tests) the next round comes at once
            retryMs = res.retry ? (this.settleMs ? 2500 : Math.min(this.interval, 150)) : 0;
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
 * Settings > Sync & sharing > Set up sync: runs scripts/cloud-setup.mjs (what setup.sh --cloud runs) from this server and
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
      // an installed app deploys from its install's cloud folder, where wrangler stays between updates
      const root = installRoot(APP_DIR);
      const script = process.env.SAQME_CLOUD_SETUP_JS || !root ? appPaths.cloudSetup : join(prepareWorkspace(root, APP_DIR), 'scripts', 'cloud-setup.mjs');
      if (!existsSync(script)) throw new Error('The cloud setup is not installed with this app. Run setup.sh --cloud instead.');
      const resultFile = join(p.local, 'setup-result.json');
      try { unlinkSync(resultFile); } catch { /* none */ }
      // npm (for the Cloudflare tools) sits next to this Node.js; --yes: no questions, nobody is at a terminal
      const env = { ...process.env, NO_COLOR: '1', PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
      const args = [script, '--state', cloudSetupStatePath(), '--desktop-config', p.cloudConfig,
        '--pair-again', 'Settings > Sync & sharing > Pair a phone', '--yes', '--result', resultFile];
      const child = spawn(process.execPath, args, { cwd: dirname(dirname(script)), env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** Settings > Sync & sharing > Advanced > Turn off sync: this computer stops syncing; the lists and the cloud copy stay. */
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
 * Starts everything; resolves to { url, port, token, files, cloud, d1, updater, stop() }. Options:
 *   dataDir, port, interval (files engine), cloudInterval, settleMs, reminders (false in tests), watchFiles,
 *   updates (false: no update checks; an app run from a source folder never updates itself anyway)
 */
export async function startApp({ dataDir = defaultDataDir(), port, interval = 10_000, cloudInterval = 12_000, settleMs = 1500, reminders = true, watchFiles = true, updates = true } = {}) {
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

  const shares = new Shares({ lists: p.lists, sync: p.sync, log });
  const files = new EngineLoop({
    name: 'files', statePath: p.filesState, listsDir: p.lists, interval, log, settleMs,
    target: () => ({ transport: local, deviceId: 'files', label: 'this computer' }),
    view: () => ({ first: shares.names() }),   // a line copied out of a shared list gets the new id, not the original
  });
  const cloud = new EngineLoop({
    name: 'cloud', statePath: p.cloudState, listsDir: p.lists, interval: cloudInterval, log, settleMs,
    view: () => ({ exclude: shares.names() }),   // lists shared with this computer live on their owners' servers
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
  files.onApplied = () => { cloud.wake(); for (const s of shareLoops.values()) s.loop.wake(); };
  cloud.onApplied = () => files.wake();

  // ---- lists shared with this computer: one engine each, against its owner's server (local/shares.mjs)
  const shareLoops = new Map();   // binding id -> { loop, done }
  function startShare(b) {
    if (shareLoops.has(b.id)) return;
    const cur = () => shares.get(b.id);
    const loop = new EngineLoop({
      name: `shared ${b.file}`, statePath: shares.statePath(b.id), listsDir: p.lists, interval: cloudInterval, log, settleMs, quiet: true,
      target: () => {
        const s = cur();
        const token = s && !s.left ? shares.token(s.id) : null;
        return token ? { transport: httpTransport(s.server, token), deviceId: shares.deviceId(), label: new URL(s.server).host } : null;
      },
      view: () => ({ only: cur()?.file ?? b.file }),
      scope: () => { const s = cur() ?? b; return { project: s.project, file: s.file, readOnly: s.access !== 'edit', label: serverLabel(s.server) }; },
      // the owner renamed the list: the binding follows at once, before another engine could take the file
      afterPlan: (plan) => { const n = plan.files[b.project]; if (n && n !== cur()?.file) shares.update(b.id, { file: n }); },
      onApplied: () => files.wake(),
      onResult: (res) => {
        if (res.access && res.access !== cur()?.access) { shares.update(b.id, { access: res.access }); log(`shares: ${cur()?.file} is now ${res.access === 'edit' ? 'editable' : 'view-only'}`); }
        if (res.status !== 'auth' || !cur()) return;
        // the owner stopped sharing it: it stays as one of this computer's own lists, with new ids; the window's
        // store sees its old tasks go (expected, so not held back as a mass delete) and the new ones come
        const old = shares.end(b.id);
        files.expected = { keys: new Set(old.map((id) => `task:${id}`)), until: Date.now() + 5 * 60_000 };
        stopShare(b.id);
        files.wake(); cloud.wake();
      },
    });
    shareLoops.set(b.id, { loop, done: loop.run() });
  }
  function stopShare(id) {
    const s = shareLoops.get(id);
    if (!s) return;
    s.loop.stop();
    shareLoops.delete(id);
  }
  for (const b of shares.all()) {
    if (b.left) shares.forget(b.id);   // left while the app was stopping
    else startShare(b);
  }
  const localIdOf = (file) => (file ? Object.keys(files.state?.Files ?? {}).find((k) => files.state.Files[k] === file) ?? null : null);
  const cloudIdOf = (localId) => {
    const file = files.state?.Files?.[localId];
    return file ? Object.keys(cloud.state?.Files ?? {}).find((k) => cloud.state.Files[k] === file) ?? null : null;
  };
  let pendingInvite = null;   // a saqme://join link handed over by `saqme invite` (the window asks first)
  const shareInfo = () => ({
    shares: shares.all().filter((b) => !b.left).map((b) => {
      const l = shareLoops.get(b.id)?.loop;
      return { id: b.id, projectId: localIdOf(b.file), name: b.name, file: b.file, server: b.server, access: b.access, status: l ? { state: l.status.state, message: l.status.message } : null };
    }),
    sharedByMe: (cloud.state?.Shared ?? []).map((pid) => localIdOf(cloud.state.Files?.[pid])).filter(Boolean),
    notices: [...shareLoops].flatMap(([id, { loop }]) => (loop.state?.Notices ?? []).map((n) => ({
      ...n, id: `${id}:${n.id}`, local: true, projectId: localIdOf(shares.get(id)?.file), list: n.list,
    }))),
    ended: shares.ended,
    invite: pendingInvite,
  });
  /** The owner's side, for the window: the cloud Worker's share routes, with the window's project ids. */
  async function ownerApi(method, path, body, { need = 'Sharing needs cloud sync (Settings, Sync & sharing, Set up sync).', timeoutMs = 15_000 } = {}) {
    const c = readCloudConfig(p.cloudConfig);
    if (!c) throw Object.assign(new Error(need), { status: 409 });
    let r;
    try {
      r = await fetch(`${c.url.replace(/\/+$/, '')}/api/${path}`, {
        method, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw Object.assign(new Error(`Could not reach ${new URL(c.url).host}. Are you online?`), { status: 503 }); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  }
  const notSynced = () => Object.assign(new Error('This list is not on your sync service yet. Wait a moment for it to sync, then try again.'), { status: 404 });
  const sharing = {
    async list(localId) {
      const pid = cloudIdOf(localId);
      if (!pid) throw notSynced();
      return { shares: (await ownerApi('GET', `shares?project=${pid}`)).shares.map((s) => ({ ...s, projectId: localId })) };
    },
    async invite({ projectId, alias, access }) {
      const pid = cloudIdOf(projectId);
      if (!pid) throw notSynced();
      const d = await ownerApi('POST', 'shares/invite', { projectId: pid, alias, access });
      cloud.wake();
      return { ...d, share: { ...d.share, projectId } };
    },
    update: ({ id, access }) => ownerApi('POST', 'shares/update', { id, access }),
    async revoke({ id }) { const d = await ownerApi('POST', 'shares/revoke', { id }); cloud.wake(); return d; },
    async join(link) {
      const b = await shares.join(link);
      startShare(b);
      if (pendingInvite?.link === link) pendingInvite = null;
      return { id: b.id, name: b.file };
    },
    leave(id) { stopShare(id); const b = shares.leave(id); files.wake(); return { ok: true, name: b.file }; },
    dismiss(id) {
      const [sid, nid] = String(id).split(/:(.*)/s);
      const l = shareLoops.get(sid)?.loop;
      if (l?.state) { l.state.Notices = (l.state.Notices ?? []).filter((n) => n.id !== nid); saveState(l.state, l.statePath); }
      return { ok: true };
    },
    offer(link) { if (!parseInviteLink(link)) throw Object.assign(new Error('not an invite link'), { status: 400 }); pendingInvite = { link, at: Date.now() }; return { ok: true }; },
    decline() { pendingInvite = null; return { ok: true }; },
  };

  // the sync service updating itself (worker/src/selfupdate.js), for Settings > Updates: the Worker's own routes
  const noSync = { need: 'Your sync service can update itself once sync is set up (Settings, Sync & sharing).' };
  const workerUpdate = {
    status: () => ownerApi('GET', 'update', undefined, noSync),
    token: (token) => ownerApi('POST', 'update/token', { token }, { ...noSync, timeoutMs: 60_000 }),   // (Cloudflare checks it)
    auto: (on) => ownerApi('POST', 'update/auto', { on }, noSync),
    now: () => ownerApi('POST', 'update/now', {}, noSync),
  };

  let updater = null;   // (created once the port is known)
  const info = () => ({
    lists: p.lists,
    version: VERSION,
    files: files.status,
    cloud: cloud.status.state === 'off' ? null : cloud.status,
    guarded: Math.max(files.status.guarded, cloud.status.guarded, ...[...shareLoops.values()].map((s) => s.loop.status.guarded)),
    update: updater?.status() ?? null,
    ...shareInfo(),
  });
  // (installing and the Worker's retry go on in the background: the window and `saqme update` follow the status)
  const updateRoutes = {
    status: () => updater?.status() ?? { supported: false },
    check: () => updater?.check() ?? { supported: false },
    now: async () => {
      if (!updater) return { supported: false };
      await updater.check();
      if (updater.available) updater.start().catch((e) => log(`update: ${e?.message ?? e}`));
      return updater.status();
    },
    auto: (on) => { updater?.setAuto(on); return updater?.status() ?? { supported: false }; },
    login: () => updater?.startLogin() ?? { supported: false },
    worker: () => { if (!updater) return { supported: false }; updater.retryWorker().catch((e) => log(`update: ${e?.message ?? e}`)); return updater.status(); },
  };
  const srv = await startServer({
    port: port ?? portSetting(p), token, d1, publicDir: appPaths.public, version: VERSION, info, updates: updateRoutes, workerUpdate,
    onSync: () => { files.wake(); updater?.touch(); },
    onAllowDeletes: () => {
      for (const l of [files, cloud, ...[...shareLoops.values()].map((s) => s.loop)]) { l.allowMassDelete = true; l.wake(); }
    },
    connect: (link) => { const url = connectCloud(p.cloudConfig, link); cloud.wake(); log(`cloud: connected to ${url}`); return url; },
    cloudSetup: cloudSetupRunner(p, { log, onDone: () => cloud.wake() }),
    disconnect: () => { disconnectCloud(p.cloudConfig); cloud.wake(); log('cloud: turned off in Settings'); },
    pairingLink: () => { const c = readCloudConfig(p.cloudConfig); return c ? `${c.url.replace(/\/+$/, '')}/#pair=${c.token}` : null; },
    pairingCode: () => { const c = readCloudConfig(p.cloudConfig); return c ? cloudPairingCode(c) : null; },
    sharing,
    onStop: () => app.stop().then(() => process.exit(0)),
  });
  writeFileSync(p.server, JSON.stringify({ port: srv.port, pid: process.pid, version: VERSION }));

  let watcher = null;
  if (watchFiles) {
    try {
      watcher = watch(p.lists, (ev, name) => {
        if (!name || name.endsWith('.tmp') || name.includes('.renaming')) return;
        files.wake(); cloud.wake();
        for (const s of shareLoops.values()) s.loop.wake();
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

  // updates (local/updater.mjs): checked shortly after the start, then about once a day; installed by itself
  // when the window has not changed anything for a while (unless switched off in Settings > Updates)
  let updateTimer = null;
  if (updates) {
    updater = new Updater({
      appDir: APP_DIR, data: p.data, port: srv.port, settings: settingsFile(join(p.local, 'settings.json')), cloudConfig: p.cloudConfig, cloudState: cloudSetupStatePath(), log,
    });
    if (updater.supported) {
      const tick = () => updater.tick().catch((e) => log(`updates: ${e?.message ?? e}`));
      setTimeout(() => updater.check().catch(() => {}), 30_000).unref?.();
      updateTimer = setInterval(tick, 60_000);
    }
  }

  const app = {
    url: srv.url, port: srv.port, token, files, cloud, d1, paths: p, shares, shareLoops, sharing, updater,
    async stop() {
      const running = [...shareLoops.values()];
      files.stop(); cloud.stop();
      for (const s of running) s.loop.stop();
      clearInterval(reminderTimer);
      clearInterval(updateTimer);
      watcher?.close();
      await Promise.all([...loops, ...running.map((s) => s.done)]);
      await srv.close();
      d1.close();
      try { if (readJsonFile(p.server)?.pid === process.pid) unlinkSync(p.server); } catch { /* gone */ }
      log('stopped');
    },
  };
  return app;
}

// ---------------------------------------------------------------- commands
async function api(p, port, path, method = 'GET', body = undefined) {
  const token = readFileSync(p.token, 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `${path}: ${r.status}`);
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
  for (const s of i.shares ?? []) {
    console.log(`Shared with you: ${s.file} from ${new URL(s.server).host} (${s.access === 'edit' ? 'can edit' : 'view only'}): ${s.status?.state ?? 'starting'}${s.status?.message ? ` - ${s.status.message}` : ''}`);
  }
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
  console.log(`  ${code ? 4 : 3}. Open Saqme from the Home Screen, then Settings > Notifications: switch Notifications on.\n`);
}

async function cmdConnect(opts) {
  const p = dataPaths(opts.data);
  const url = connectCloud(p.cloudConfig, opts.args[0] ?? '');
  console.log(`Connected to ${new URL(url).host}. Lists with the same name are merged; syncing starts within a few seconds.`);
}

/** saqme join LINK: through the running app, or straight into the data folder (the app syncs it when it starts). */
async function cmdJoin(opts) {
  const p = dataPaths(opts.data);
  const link = opts.args[0] ?? '';
  const inv = parseInviteLink(link);
  if (!inv) throw new Error('That is not an invite link (it looks like https://saqme.<name>.workers.dev/join#code=...).');
  const port = runningPort(p, opts.port);
  let name;
  if (await ping(port)) name = (await api(p, port, '/api/local/join', 'POST', { link })).name;
  else {
    for (const d of [p.lists, p.sync]) mkdirSync(d, { recursive: true });
    name = (await new Shares({ lists: p.lists, sync: p.sync }).join(link)).file;
  }
  console.log(`Joined "${name}", shared from ${new URL(inv.server).host}. It is the list ${name}.md in ${p.lists}; what you change there goes to its owner's server.`);
}

/** saqme invite LINK (a saqme:// link from a shared list's invite page): the window shows it and asks first. */
async function cmdInvite(opts) {
  const p = dataPaths(opts.data);
  const link = opts.args[0] ?? '';
  if (!parseInviteLink(link)) throw new Error('That is not an invite link.');
  await cmdOpen(opts);
  const port = runningPort(p, opts.port);
  await api(p, port, '/api/local/invite', 'POST', { link });
}

/** saqme selftest: what an update runs on a new version before it switches to it (local/update.mjs apply). */
async function cmdSelftest() {
  const dir = mkdtempSync(join(tmpdir(), 'saqme-selftest-'));
  try {
    const app = await startApp({ dataDir: dir, port: 0, interval: 60_000, cloudInterval: 60_000, settleMs: 0, reminders: false, watchFiles: false, updates: false });
    try {
      const h = await (await fetch(`${app.url}/api/health`)).json();
      if (!h.ok || h.version !== VERSION) throw new Error(`health check: ${JSON.stringify(h)}`);
      const r = await fetch(`${app.url}/api/sync`, {
        method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'selftest', cursor: 0, changes: [] }),
      });
      if (!r.ok) throw new Error(`sync: ${r.status}`);
      const page = await fetch(`${app.url}/`);
      if (!page.ok || !/<script/.test(await page.text())) throw new Error('the app window does not load');
    } finally { await app.stop(); }
    console.log(`SELFTEST OK ${VERSION}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** saqme update: through the running app (it restarts itself), or right here when it is not running. */
async function cmdUpdate(opts) {
  const p = dataPaths(opts.data);
  if (!installRoot(APP_DIR)) {
    console.log(`This copy runs from a source folder (${APP_DIR}): update it with git pull, then run scripts/setup.sh.`);
    process.exit(1);
  }
  const port = runningPort(p, opts.port);
  if (await ping(port)) {
    console.log('Checking for a newer version...');
    const s = await api(p, port, '/api/local/update/now', 'POST');
    if (!s.running && !s.available) {
      console.log(s.error ? `Could not check for updates: ${s.error}` : `Saqme To Do ${s.current} is up to date.`);
      if (s.result && !s.result.ok) console.log(`${s.result.message} ${s.result.next ?? ''}`.trim());
      return;
    }
    console.log(`Updating to ${s.latest ?? s.running?.version} (the app restarts by itself; your lists are not touched)...`);
    const started = Date.now();
    for (let i = 0; i < 300; i++) {
      await sleep(2000);
      let st;
      try { st = await api(p, port, '/api/local/update'); } catch { continue; }   // (restarting)
      if (st.result && st.result.at > started) {
        console.log(`${st.result.message}${st.result.next ? `\n${st.result.next}` : ''}`);
        process.exit(st.result.ok ? 0 : 1);
      }
      if (!st.running && !st.available && st.current !== s.current) { console.log(`Updated to ${st.current}.`); return; }
    }
    console.log('Still updating; see Settings > Updates in the window.');
    return;
  }
  // not running: install here (it stays stopped, as it was)
  const updater = new Updater({
    appDir: APP_DIR, data: p.data, port: portSetting(p, opts.port), settings: settingsFile(join(p.local, 'settings.json')), cloudConfig: p.cloudConfig, cloudState: cloudSetupStatePath(),
    log: logger(p.log), restartMode: 'none',
    spawnApply: (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { stdio: 'inherit' }),
  });
  const started = Date.now();
  const s = await updater.start({ manual: true });
  const r = updater.result();
  if (r && r.at >= started) { console.log(`${r.message}${r.next ? `\n${r.next}` : ''}`); process.exit(r.ok ? 0 : 1); }
  if (s.error) { console.log(`Could not update: ${s.error}`); process.exit(1); }
  console.log(`Saqme To Do ${VERSION} is up to date.`);
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
    join: () => cmdJoin(opts),
    invite: () => cmdInvite(opts),
    update: () => cmdUpdate(opts),
    selftest: () => cmdSelftest(),
    version: () => console.log(VERSION),
  };
  const run = commands[opts.cmd];
  if (!run) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(opts.cmd === 'help' || opts.cmd === '--help' ? 0 : 2);
  }
  run().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
