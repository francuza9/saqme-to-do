// The updater inside the running Linux/macOS app (local/update.mjs has the steps and the install layout): it
// checks GitHub for a newer release on start and about once a day, says so in the window (Settings > Updates),
// and installs it on "Update now", or by itself when the app is idle ("Install updates automatically", on by
// default). Installing: download, checksum, unpack, then the new release's `update.mjs apply` runs outside this
// process (it restarts the app). Also the Cloudflare sign-in that finishes a Worker update, and its retry.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  compareVersions, currentVersion, deployWorker, downloadAsset, extractRelease, fetchManifest, installRoot, prepareWorkspace, releaseInfo,
} from './update.mjs';

const DAY = 24 * 3600_000;
const IDLE_MS = 10 * 60_000;
const RETRY_FAILED_MS = 12 * 3600_000;
const RETRY_HELD_MS = 6 * 3600_000;
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const writeJson = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`); };

/**
 * How this app runs, for the restart: its systemd or launchd service (setup.sh's), or started by hand. (By the
 * service's own cgroup: INVOCATION_ID alone is also set in terminals that a systemd service started.)
 */
export function supervisor(env = process.env, cgroup = readCgroup()) {
  if (/saqme-todo\.service/.test(cgroup)) return 'systemd';
  if (env.XPC_SERVICE_NAME === 'com.saqme.todo') return 'launchd';
  return 'spawn';
}
function readCgroup() { try { return readFileSync('/proc/self/cgroup', 'utf8'); } catch { return ''; } }

export class Updater {
  /**
   * appDir: this version's folder; data/port: the app's; settings: { get() -> { autoUpdate }, set(values) };
   * cloudConfig/cloudState: sync/config.json and setup's cloud.json; log; fetchImpl, now: tests.
   */
  constructor({ appDir, data, port, settings, cloudConfig, cloudState, log = () => {}, fetchImpl = fetch, now = Date.now, spawnApply = null, restartMode = null }) {
    Object.assign(this, { appDir, data, port, settings, cloudConfig, cloudState, log, fetchImpl, now });
    this.restartMode = restartMode ?? supervisor();
    this.root = installRoot(appDir);
    const info = releaseInfo(appDir);
    this.version = info.version;
    this.repo = info.repo;
    this.spawnApply = spawnApply ?? ((args) => this.defaultSpawn(args));
    this.latest = null;        // the checked manifest of the newest release
    this.checking = false;
    this.error = '';
    this.busy = null;          // { state, version } while this process downloads and unpacks
    this.login = null;         // { running, url, message } of the Cloudflare sign-in
    this.lastTouch = now();    // the window's last change (local/server.mjs onSync)
    this.state = this.root ? (readJson(this.path('state.json')) ?? {}) : {};
    if (this.state.latest?.version && compareVersions(this.state.latest.version, this.version) > 0) this.latest = this.state.latest;
  }

  path(name) { return join(this.root, 'update', name); }
  get supported() { return !!this.root; }
  get auto() { return this.settings.get().autoUpdate !== false; }
  setAuto(on) { this.settings.set({ autoUpdate: !!on }); }
  touch() { this.lastTouch = this.now(); }
  get available() { return !!this.latest && compareVersions(this.latest.version, this.version) > 0; }
  saveState() { if (this.root) writeJson(this.path('state.json'), this.state); }

  /** The last update's outcome (written by update.mjs apply), and what apply is doing right now. */
  result() { return this.root ? readJson(this.path('result.json')) : null; }
  applying() {
    const s = this.root ? readJson(this.path('status.json')) : null;
    return s && s.state !== 'idle' && this.now() - (s.at ?? 0) < 20 * 60_000 ? s : null;
  }

  status() {
    const result = this.result();
    const pending = !!result && result.worker === 'pending' && compareVersions(result.version, this.version) === 0;
    // (news: the update that made this version, or one to a newer version that did not go through)
    const cmp = result ? compareVersions(result.version, this.version) : null;
    const shown = result && ((result.ok && cmp === 0) || (!result.ok && cmp > 0)) ? result : null;
    return {
      supported: this.supported, current: this.version, latest: this.latest?.version ?? null, available: this.available,
      auto: this.auto, checking: this.checking, checkedAt: this.state.checkedAt ?? 0, error: this.error,
      running: this.busy ?? this.applying(),
      result: shown,
      worker: pending ? { pending: true, needsLogin: !!result.needsLogin, message: result.message } : null,
      login: this.login,
    };
  }

  async check() {
    if (!this.supported || this.checking) return this.status();
    this.checking = true;
    try {
      const m = await fetchManifest({ repo: this.repo, fetchImpl: this.fetchImpl });
      this.latest = m && compareVersions(m.version, this.version) > 0 ? m : null;
      this.error = '';
      this.state.checkedAt = this.now();
      this.state.latest = this.latest;
      this.saveState();
    } catch (e) {
      this.error = e.message;
      this.log(`update check: ${e.message}`);
    } finally { this.checking = false; }
    return this.status();
  }

  /** Downloads, checks and unpacks the newest release, then starts its apply. */
  async start({ manual = false } = {}) {
    if (!this.supported || this.busy || this.applying()) return this.status();
    if (manual || !this.latest) await this.check();
    const m = this.latest;
    if (!m) return this.status();
    this.busy = { state: 'downloading', version: m.version };
    try {
      const bytes = await downloadAsset(m, { repo: this.repo, fetchImpl: this.fetchImpl });
      this.busy = { state: 'installing', version: m.version };
      const dest = this.path(`src-${m.version}`);
      const tree = extractRelease(bytes, dest, m.version);
      this.log(`update: ${m.version} downloaded and checked; installing`);
      writeJson(this.path('status.json'), { state: 'installing', version: m.version, at: this.now() });
      this.spawnApply([join(tree, 'local', 'update.mjs'), 'apply', '--source', tree, '--root', this.root, '--data', this.data, '--port', String(this.port),
        '--min-worker-api', String(m.minWorkerApi), '--restart', this.restartMode, '--launcher', process.env.SAQME_LAUNCHER ?? '',
        '--cloud-state', this.cloudState, '--result', this.path('result.json')]);
    } catch (e) {
      this.error = e.message;
      this.state.failed = { version: m.version, at: this.now() };
      this.saveState();
      writeJson(this.path('result.json'), { ok: false, version: m.version, from: this.version, message: `The update to ${m.version} did not install: ${e.message}`, next: `Saqme ${this.version} keeps running. It is tried again later.`, at: this.now() });
      this.log(`update: ${e.message}`);
    } finally { this.busy = null; }
    return this.status();
  }

  /** Outside this process, so the restart cannot stop it (a systemd service's restart ends its whole group). */
  defaultSpawn(args) {
    const opts = { detached: true, stdio: 'ignore' };
    if (this.restartMode === 'systemd') {
      const r = spawnSync('systemd-run', ['--user', '--collect', '--quiet', `--unit=saqme-update-${this.now()}`, process.execPath, ...args], { stdio: 'ignore', timeout: 20_000 });
      if (r.status === 0) return;
    }
    spawn(process.execPath, args, opts).unref();
  }

  /** Every minute: the daily check, and an automatic update once the app has been idle a while. */
  async tick() {
    if (!this.supported) return;
    const now = this.now();
    if (now - (this.state.checkedAt ?? 0) > DAY) await this.check();
    if (!this.auto || !this.available || this.busy || this.applying() || now - this.lastTouch < IDLE_MS) return;
    const r = this.result();
    if (r && r.version === this.latest.version && !r.ok && now - (r.at ?? 0) < (r.held ? RETRY_HELD_MS : RETRY_FAILED_MS)) return;
    if (this.state.failed?.version === this.latest.version && now - this.state.failed.at < RETRY_FAILED_MS) return;
    await this.start();
  }

  versionDir() { return join(this.root, 'versions', currentVersion(this.root) || this.version); }

  /** "Sign in to Cloudflare": wrangler's browser login (its address shown too, in case no browser opens); then the Worker again. */
  startLogin() {
    if (!this.supported || this.login?.running) return this.status();
    const ws = prepareWorkspace(this.root, this.versionDir());
    const result = this.path('login.json');
    rmSync(result, { force: true });
    this.login = { running: true, url: '', message: '' };
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, NO_COLOR: '1' };
    const child = spawn(process.execPath, [join(ws, 'scripts', 'cloud-setup.mjs'), '--login-only', '--result', result], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const seen = (d) => {
      out += d;
      const url = /https:\/\/dash\.cloudflare\.com\/oauth2\/\S+/.exec(out)?.[0];
      if (url && this.login) this.login.url = url;
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('close', () => {
      const r = readJson(result);
      this.login = r?.ok ? null : { running: false, url: '', message: r?.message ?? 'The sign-in did not finish.' };
      if (r?.ok) this.retryWorker();
    });
    child.on('error', (e) => { this.login = { running: false, url: '', message: e.message }; });
    return this.status();
  }

  /** The Worker part of an update that was applied without it (sign-in missing, or its deploy failed). */
  async retryWorker() {
    if (!this.supported || this.busy) return this.status();
    const r = this.result();
    this.busy = { state: 'worker', version: this.version };
    try {
      const w = await deployWorker({ root: this.root, versionDir: this.versionDir(), version: this.version, cloudConfig: this.cloudConfig, cloudState: this.cloudState, fetchImpl: this.fetchImpl, log: this.log });
      const ok = w.deploy === 'ok' || w.deploy === 'none';
      writeJson(this.path('result.json'), {
        ...(r ?? { version: this.version }), ok: true, version: this.version, worker: ok ? (w.deploy === 'none' ? 'none' : 'ok') : 'pending', needsLogin: w.deploy === 'needs-login',
        message: ok ? `Updated to ${this.version}, your sync service too.` : w.deploy === 'needs-login' ? 'Sign in to Cloudflare to finish the update of your sync service.' : `Your sync service could not be updated yet (${w.message}).`,
        at: this.now(),
      });
    } finally { this.busy = null; }
    return this.status();
  }
}

/** The app's update settings live in local/settings.json next to the port. */
export function settingsFile(path) {
  return {
    get: () => readJson(path) ?? {},
    set: (values) => writeJson(path, { ...(readJson(path) ?? {}), ...values }),
  };
}
