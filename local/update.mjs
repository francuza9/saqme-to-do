#!/usr/bin/env node
// The app updater for Linux and macOS (docs/setup.md, "Updating"). On Windows: desktop/update.ps1, which hands a
// verified release to scripts/setup.ps1 -Update.
//
// Install layout (setup.sh writes it, this keeps it):
//   <root>/versions/<X.Y.Z>/   one folder per version: local/, worker/ (src, public, migrations, package*.json),
//                              scripts/; never changed once there
//   <root>/current, previous   the version that runs, and the one before it (one line each; the launcher
//                              ~/.local/bin/saqme reads `current`). Switching is one atomic rename of `current`.
//   <root>/cloud/              where the user's own Worker is deployed from (wrangler and its node_modules stay
//                              there between updates)
//   <root>/update/             downloads, the state the window shows, how the last update ended
//   <root>/node/               Node.js, when setup downloaded it
// Lists and data (the data folder) are never touched.
//
// An update: the running app checks the release manifest on GitHub (start, then about once a day), downloads the
// release's zip, checks its size and SHA-256 against the manifest, unpacks it, and starts the NEW release's
// `update.mjs apply` outside its own process (it restarts the app). apply: copies the version folder, runs the new
// version's self-check, updates the user's own Worker (code and phone app; its keys stay), decides with
// updateDecision whether the apps may switch, switches `current`, restarts the app and waits for it; if the new
// version does not come up, it switches back and restarts the old one. How it ended: <root>/update/result.json.
//
//   node update.mjs stage  --source DIR --root DIR                  copy a release tree into versions/ (setup.sh)
//   node update.mjs switch --root DIR --version X.Y.Z               make it the current version (setup.sh)
//   node update.mjs workspace --source DIR --root DIR               refresh <root>/cloud from a release tree (setup.sh --cloud)
//   node update.mjs apply  --source DIR --root DIR --data DIR [--port N] [--min-worker-api N]
//                          [--restart systemd|launchd|spawn|none] [--launcher PATH] [--no-worker] [--result FILE]
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** This release's package.json: the version, and the repository it is published from (the single source). */
export function releaseInfo(appDir = resolve(here, '..')) {
  const pkg = readJson(join(appDir, 'worker', 'package.json')) ?? {};
  const m = /github\.com\/([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? '');
  return { version: String(pkg.version ?? '0.0.0'), repo: m ? m[1] : '' };   // ("repository" is the one place it is written)
}

// ---------------------------------------------------------------- rules (shared/fixtures/update.json; desktop/update-core.ps1)
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** -1 | 0 | 1, or null when one of them is not X.Y.Z. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export const MAX_ASSET = 100_000_000;
export const MANIFEST_NAME = 'saqme-release.json';
/** The release manifest (scripts/build-release.mjs writes it) -> what the updater uses of it, or null. */
export function checkManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.schema !== 1) return null;
  const v = parseVersion(m.version);
  if (!v) return null;
  const version = v.join('.');
  if (m.tag !== `v${version}`) return null;
  const { api, minWorkerApi } = m;
  if (!Number.isInteger(api) || api < 1 || !Number.isInteger(minWorkerApi) || minWorkerApi < 1 || minWorkerApi > api) return null;
  const a = m.asset;
  if (!a || typeof a !== 'object' || a.name !== `saqme-${version}.zip`) return null;
  if (!Number.isInteger(a.size) || a.size < 1 || a.size > MAX_ASSET) return null;
  if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(a.sha256)) return null;
  return { version, tag: m.tag, api, minWorkerApi, asset: a.name, size: a.size, sha256: a.sha256.toLowerCase() };
}

/**
 * Whether the apps may switch to the new release, given how updating the user's own Worker went:
 * 'apply' | 'apply-pending' (the apps switch; the Worker is tried again later) | 'hold' (nothing changes).
 */
export function updateDecision({ deploy, workerApi = null, minWorkerApi = 1 }) {
  if (deploy === 'none' || deploy === 'ok') return 'apply';
  const api = Number.isInteger(workerApi) ? workerApi : 1;
  return api >= minWorkerApi ? 'apply-pending' : 'hold';
}

// ---------------------------------------------------------------- downloads (github.com only, https only)
const releases = (repo) => `https://github.com/${repo}/releases`;
export const manifestUrl = (repo) => `${releases(repo)}/latest/download/${MANIFEST_NAME}`;
/** Where a release's zip is: built from the repository and the checked manifest, never taken from it. */
export const assetUrl = (repo, m) => `${releases(repo)}/download/${m.tag}/${m.asset}`;

async function readCapped(res, max) {
  if (Number(res.headers.get('content-length') || 0) > max) throw new Error('the download is larger than the release says');
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.byteLength;
    if (size > max) throw new Error('the download is larger than the release says');
    chunks.push(c);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
function checkFinalUrl(res) {
  if (res.url && !res.url.startsWith('https://')) throw new Error('the download left https');
}

/** The newest published release -> its checked manifest, or null when none is published yet. */
export async function fetchManifest({ repo, fetchImpl = fetch, timeoutMs = 20_000 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('This copy does not say where it is published (worker/package.json, "repository").');
  let res;
  try {
    res = await fetchImpl(manifestUrl(repo), { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  } catch (e) { throw new Error(`Could not reach GitHub (${e?.cause?.code ?? e?.message ?? e}).`); }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  checkFinalUrl(res);
  let m;
  try { m = checkManifest(JSON.parse((await readCapped(res, 64 * 1024)).toString('utf8'))); } catch { m = null; }
  if (!m) throw new Error('The release on GitHub has no valid manifest.');
  return m;
}

/** Size and SHA-256 must be the manifest's. */
export function verifyAsset(bytes, m) {
  if (bytes.length !== m.size) throw new Error(`The download has ${bytes.length} bytes; the release says ${m.size}.`);
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== m.sha256) throw new Error('The download does not match the checksum of the release.');
}

export async function downloadAsset(m, { repo, fetchImpl = fetch, timeoutMs = 600_000 }) {
  let res;
  try {
    res = await fetchImpl(assetUrl(repo, m), { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new Error(`Could not download the update (${e?.cause?.code ?? e?.message ?? e}).`); }
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${m.asset}.`);
  checkFinalUrl(res);
  const bytes = await readCapped(res, m.size);
  verifyAsset(bytes, m);
  return bytes;
}

// ---------------------------------------------------------------- zip (the release asset; deflate or stored)
/** A zip -> [{ name, data }] (files only). Throws on anything it does not understand. */
export function readZip(buf) {
  const b = Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip file');
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const usize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged zip file');
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`${name}: unsupported compression`);
    if (data.length !== usize) throw new Error(`${name}: damaged`);
    out.push({ name, data });
  }
  return out;
}

/** A relative path inside the archive: no absolute path, no drive, no "..", no backslash. */
export function safeEntry(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes(':') || name.includes('\0')) return false;
  return name.split('/').every((s) => s && s !== '.' && s !== '..');
}

/** Unpacks a release zip into dest -> the release tree (dest/saqme-X.Y.Z). */
export function extractRelease(buf, dest, version) {
  const top = `saqme-${version}/`;
  const entries = readZip(buf);
  if (!entries.length) throw new Error('the update is empty');
  for (const e of entries) if (!safeEntry(e.name) || !e.name.startsWith(top)) throw new Error(`unexpected file in the update: ${e.name}`);
  rmSync(dest, { recursive: true, force: true });
  for (const e of entries) {
    const path = join(dest, ...e.name.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, e.data);
  }
  const tree = join(dest, top.slice(0, -1));
  for (const f of ['local/saqme.mjs', 'local/update.mjs', 'worker/package.json', 'scripts/cloud-setup.mjs']) {
    if (!existsSync(join(tree, f))) throw new Error(`the update has no ${f}`);
  }
  if (releaseInfo(tree).version !== version) throw new Error('the update says it is another version');
  return tree;
}

// ---------------------------------------------------------------- install layout
/** The install root when this app runs from <root>/versions/<v>, else null (a source folder: no updates). */
export function installRoot(appDir = resolve(here, '..')) {
  return basename(dirname(appDir)) === 'versions' ? dirname(dirname(appDir)) : null;
}
const readLine = (path) => { try { return readFileSync(path, 'utf8').trim(); } catch { return ''; } };
export const currentVersion = (root) => readLine(join(root, 'current'));
export const previousVersion = (root) => readLine(join(root, 'previous'));
function writeAtomic(path, text) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** What a version folder holds, copied from a release tree (or a clone of the repository). */
const APP_PARTS = ['local', 'worker/src', 'worker/public', 'worker/migrations', 'worker/package.json', 'worker/package-lock.json', 'worker/wrangler.toml.template', 'scripts/cloud-setup.mjs', 'scripts/setup.sh', 'LICENSE'];
const WORKER_PARTS = ['worker/src', 'worker/public', 'worker/migrations', 'worker/package.json', 'worker/package-lock.json', 'worker/wrangler.toml.template', 'scripts/cloud-setup.mjs'];

function copyParts(source, dest, parts) {
  for (const part of parts) {
    const from = join(source, part);
    if (!existsSync(from)) { if (part === 'LICENSE') continue; throw new Error(`${part} is missing in ${source}`); }
    const to = join(dest, part);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, filter: (p) => !p.split(sep).includes('node_modules') && !/[\\/]test[\\/]/.test(p.slice(from.length)) });
  }
}

/** Copies a release tree to <root>/versions/<v> (replacing a folder of that version) -> { version, dir }. */
export function stageVersion(source, root) {
  const { version } = releaseInfo(source);
  if (!parseVersion(version)) throw new Error(`${source} has no version`);
  const versions = join(root, 'versions');
  const dir = join(versions, version);
  const tmp = join(versions, `.staging-${version}-${randomBytes(3).toString('hex')}`);
  mkdirSync(versions, { recursive: true });
  try {
    copyParts(source, tmp, APP_PARTS);
    if (existsSync(dir)) {
      const old = join(versions, `.old-${version}-${randomBytes(3).toString('hex')}`);
      renameSync(dir, old);
      renameSync(tmp, dir);
      rmSync(old, { recursive: true, force: true });
    } else renameSync(tmp, dir);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { version, dir };
}

/** The Worker's deploy folder (<root>/cloud), refreshed from a version folder; wrangler's node_modules stay. */
export function prepareWorkspace(root, versionDir) {
  const ws = join(root, 'cloud');
  for (const part of ['worker/src', 'worker/public', 'worker/migrations']) rmSync(join(ws, part), { recursive: true, force: true });
  copyParts(versionDir, ws, WORKER_PARTS);
  return ws;
}

/** Makes `version` the current one -> { from, to }; the one before becomes `previous`. */
export function switchVersion(root, version) {
  if (!existsSync(join(root, 'versions', version, 'local', 'saqme.mjs'))) throw new Error(`version ${version} is not installed`);
  const from = currentVersion(root);
  if (from && from !== version) writeAtomic(join(root, 'previous'), `${from}\n`);
  writeAtomic(join(root, 'current'), `${version}\n`);
  return { from, to: version };
}

/** Removes version folders other than the current and the previous one (and staging left by a crash). */
export function cleanVersions(root) {
  const keep = new Set([currentVersion(root), previousVersion(root)].filter(Boolean));
  let names = [];
  try { names = readdirSync(join(root, 'versions')); } catch { return; }
  for (const n of names) if (!keep.has(n)) rmSync(join(root, 'versions', n), { recursive: true, force: true });
}

// ---------------------------------------------------------------- the user's own Worker
/** GET /api/health of a Worker -> { version, api } (api 1 for Workers that do not say), or null if unreachable. */
export async function workerRelease(url, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    if (!res.ok) return null;
    const d = await res.json();
    return { version: String(d.version ?? ''), api: Number.isInteger(d.api) ? d.api : 1 };
  } catch { return null; }
}

/**
 * Updates the user's own Worker to what is in <root>/cloud (cloud-setup.mjs --update: code and phone app, the
 * keys stay) -> { deploy: 'none'|'ok'|'needs-login'|'failed', workerApi, message }.
 */
export async function deployWorker({ root, versionDir, version, cloudConfig, cloudState, node = process.execPath, fetchImpl = fetch, log = () => {} }) {
  const c = readJson(cloudConfig);
  if (!c?.url || !c?.token || c.enabled === false) return { deploy: 'none', workerApi: null, message: '' };
  const before = await workerRelease(c.url, { fetchImpl });
  if (before && compareVersions(before.version, version) >= 0) return { deploy: 'ok', workerApi: before.api, message: '' };   // (another computer did it)
  const ws = prepareWorkspace(root, versionDir);
  const result = join(root, 'update', `worker-${randomBytes(4).toString('hex')}.json`);
  mkdirSync(dirname(result), { recursive: true });
  const env = { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? ''}`, NO_COLOR: '1' };
  const script = process.env.SAQME_CLOUD_SETUP_JS || join(ws, 'scripts', 'cloud-setup.mjs');   // env: tests
  const r = spawnSync(node, [script, '--update', '--state', cloudState, '--desktop-config', cloudConfig, '--yes', '--result', result],
    { cwd: ws, env, encoding: 'utf8', timeout: 15 * 60_000 });
  log(`worker update: exit ${r.status}`);
  const res = readJson(result) ?? { ok: false, message: (r.stderr || r.stdout || 'The update of your sync service did not finish.').trim().split('\n').slice(-3).join(' ') };
  rmSync(result, { force: true });
  if (res.ok) return { deploy: 'ok', workerApi: before?.api ?? null, message: '' };
  return { deploy: res.needsLogin ? 'needs-login' : 'failed', workerApi: before?.api ?? null, message: String(res.message ?? ''), next: String(res.next ?? '') };
}

// ---------------------------------------------------------------- restart
async function pingVersion(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const d = await r.json();
    return r.ok && d.local === true ? String(d.version ?? '') : null;
  } catch { return null; }
}
async function stopRunning(data, port) {
  const token = readLine(join(data, 'local', 'token'));
  try { await fetch(`http://127.0.0.1:${port}/api/local/stop`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }); } catch { /* gone already */ }
  for (let i = 0; i < 40 && (await pingVersion(port)) !== null; i++) await sleep(250);
}

/** Restarts the app the way it runs: its service (systemd, launchd), or started by hand (spawn); none: it was not running. */
export async function restartApp({ mode, data, port, launcher, root }) {
  if (mode === 'none') return;
  if (mode === 'systemd') { spawnSync('systemctl', ['--user', 'restart', 'saqme-todo.service'], { stdio: 'ignore', timeout: 30_000 }); return; }
  if (mode === 'launchd') { spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.saqme.todo`], { stdio: 'ignore', timeout: 30_000 }); return; }
  await stopRunning(data, port);
  const v = currentVersion(root);
  const [cmd, args] = launcher && existsSync(launcher) ? [launcher, ['serve']]
    : [process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'versions', v, 'local', 'saqme.mjs'), 'serve', '--data', data, '--port', String(port)]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, SAQME_DATA: data } });
  child.unref();
}

async function waitForVersion(port, version, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if ((await pingVersion(port)) === version) return true;
  return false;
}

// ---------------------------------------------------------------- apply (runs from the NEW release, outside the app)
function writeResult(path, data) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify({ ...data, at: Date.now() }, null, 2)}\n`);
}

/**
 * Installs the release tree `source` and switches to it (see the top of this file) -> the result it wrote.
 * opts: { source, root, data, port, minWorkerApi, restart, launcher, worker (false: leave the Worker), result,
 *         cloudConfig, cloudState, selftest (false: tests), startTimeoutMs, fetchImpl, log }
 */
export async function applyRelease(opts) {
  const { source, root, data, port = 47613, minWorkerApi = 1, restart = 'none', launcher = '', result, log = () => {}, startTimeoutMs = 60_000 } = opts;
  const status = (state, extra = {}) => writeResult(join(root, 'update', 'status.json'), { state, ...extra });
  const { version } = releaseInfo(source);
  const from = currentVersion(root);
  const done = (r) => { writeResult(result, r); status('idle'); return r; };
  status('installing', { version });
  let staged;
  try { staged = stageVersion(source, root); } catch (e) {
    return done({ ok: false, version, from, message: `The update to ${version} could not be copied: ${e.message}`, next: 'It is tried again later; nothing changed.' });
  }
  if (opts.selftest !== false) {
    const t = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(staged.dir, 'local', 'saqme.mjs'), 'selftest'], { encoding: 'utf8', timeout: 120_000 });
    if (!/SELFTEST OK/.test(t.stdout ?? '')) {
      if (staged.version !== from) rmSync(staged.dir, { recursive: true, force: true });
      log(`self-check of ${version} failed: ${t.stdout}${t.stderr}`);
      return done({ ok: false, version, from, message: `Version ${version} did not pass its self-check, so it was not installed.`, next: `Saqme ${from || 'as it was'} keeps running. Please report it (the log is in the data folder: local/saqme.log).` });
    }
  }
  let w = { deploy: 'none', workerApi: null, message: '' };
  if (opts.worker !== false) {
    status('worker', { version });
    try {
      w = await deployWorker({ root, versionDir: staged.dir, version, cloudConfig: opts.cloudConfig ?? join(data, 'sync', 'config.json'), cloudState: opts.cloudState, fetchImpl: opts.fetchImpl, log });
    } catch (e) { w = { deploy: 'failed', workerApi: null, message: e.message }; }
  }
  const decision = updateDecision({ deploy: w.deploy, workerApi: w.workerApi, minWorkerApi });
  const worker = w.deploy === 'none' ? 'none' : w.deploy === 'ok' ? 'ok' : 'pending';
  if (decision === 'hold') {
    return done({
      ok: false, held: true, version, from, worker, needsLogin: w.deploy === 'needs-login',
      message: w.deploy === 'needs-login' ? `Sign in to Cloudflare to finish the update to ${version}: it needs your sync service updated first.`
        : `The update to ${version} is waiting: it needs your sync service updated first, and that did not work (${w.message || 'no reason given'}).`,
      next: 'Nothing changed. It is tried again later, or now with Try again.',
    });
  }
  status('restarting', { version });
  const prevBefore = previousVersion(root);
  switchVersion(root, version);
  await restartApp({ mode: restart, data, port, launcher, root });
  if (restart !== 'none' && !(await waitForVersion(port, version, startTimeoutMs))) {
    log(`${version} did not start; going back to ${from}`);
    if (from) {
      switchVersion(root, from);
      // (the pointers as they were: the version that did not start is nothing to go back to)
      if (prevBefore && prevBefore !== from) writeAtomic(join(root, 'previous'), `${prevBefore}\n`);
      else if (!prevBefore) rmSync(join(root, 'previous'), { force: true });
      await restartApp({ mode: restart, data, port, launcher, root });
      await waitForVersion(port, from, startTimeoutMs);
    }
    return done({ ok: false, version, from, message: `Version ${version} did not start, so Saqme went back to ${from || 'the version before'}.`, next: 'Please report it; the log is in the data folder (local/saqme.log).' });
  }
  cleanVersions(root);
  return done({
    ok: true, version, from, worker, needsLogin: w.deploy === 'needs-login',
    message: worker === 'pending' ? (w.deploy === 'needs-login' ? `Updated to ${version}. Sign in to Cloudflare to finish: your sync service still runs the version before.` : `Updated to ${version}. Your sync service could not be updated yet (${w.message || 'no reason given'}); it is tried again later.`) : `Updated to ${version}.`,
  });
}

// ---------------------------------------------------------------- command line
function parseArgs(argv) {
  const o = { cmd: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--source') o.source = resolve(val());
    else if (a === '--root') o.root = resolve(val());
    else if (a === '--data') o.data = resolve(val());
    else if (a === '--port') o.port = Number(val());
    else if (a === '--version') o.version = val();
    else if (a === '--min-worker-api') o.minWorkerApi = Number(val());
    else if (a === '--restart') o.restart = val();
    else if (a === '--launcher') o.launcher = val();
    else if (a === '--result') o.result = resolve(val());
    else if (a === '--cloud-state') o.cloudState = resolve(val());
    else if (a === '--no-worker') o.worker = false;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const o = parseArgs(process.argv.slice(2));
  const fail = (msg) => { console.error(msg); process.exit(2); };
  const run = {
    stage: () => { if (!o.source || !o.root) fail('usage: update.mjs stage --source DIR --root DIR'); console.log(stageVersion(o.source, o.root).version); },
    switch: () => { if (!o.root || !o.version) fail('usage: update.mjs switch --root DIR --version X.Y.Z'); const r = switchVersion(o.root, o.version); cleanVersions(o.root); console.log(`${r.from || '-'} -> ${r.to}`); },
    workspace: () => { if (!o.source || !o.root) fail('usage: update.mjs workspace --source DIR --root DIR'); console.log(prepareWorkspace(o.root, o.source)); },
    apply: async () => {
      if (!o.source || !o.root || !o.data) fail('usage: update.mjs apply --source DIR --root DIR --data DIR');
      const { cloudSetupStatePath } = await import('./paths.mjs');
      const log = (m) => { try { writeFileSync(join(o.data, 'local', 'saqme.log'), `${new Date().toISOString().replace('T', ' ').slice(0, 19)} update: ${m}\n`, { flag: 'a' }); } catch { /* no log */ } };
      const r = await applyRelease({ ...o, cloudState: o.cloudState ?? cloudSetupStatePath(), result: o.result ?? join(o.root, 'update', 'result.json'), log });
      console.log(r.message);
      process.exit(r.ok ? 0 : 1);
    },
  }[o.cmd];
  if (!run) fail('usage: update.mjs stage | switch | workspace | apply (see the top of the file)');
  Promise.resolve(run()).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
