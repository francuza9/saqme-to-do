// The Worker updates itself (docs/sync.md, "The sync service updates itself"): with a Cloudflare API token its owner
// gave it (the Worker secret UPDATE_TOKEN; "Workers Scripts: Edit" on their account, nothing else), its cron looks at
// this repository's newest GitHub release now and then, and deploys the new version of itself, code and phone app,
// through Cloudflare's API. The same rules as the apps' updaters (local/update.mjs, desktop/update-core.ps1;
// shared/fixtures/update.json): the release manifest at releases/latest, nothing taken from anywhere but this
// repository's releases, SHA-256 checked, never an older version, never a release whose API is lower than this one's.
//
// A deploy cannot leave the Worker half updated: the phone app's files and the code go up as a new VERSION of the
// Worker, which serves nothing until one deployment switches code and files together (and Cloudflare refuses a
// version whose code does not start). The version before stays on Cloudflare; its id is kept here. The new version
// checks itself on its first run (its database update must work) and, if that fails, switches back to the version
// before by itself. Every step is logged (meta 'update', shown in Settings, and the Worker's logs). This is how
// `wrangler deploy` itself deploys (a version, then a deployment of it), with the bindings it would send.
//
//   GET  /api/update              how it stands (updateStatus)
//   POST /api/update/token        { token }: check it and keep it as the Worker secret; { token: '' } removes it
//   POST /api/update/auto         { on }: update by itself (on by default once there is a token)
//   POST /api/update/now          look for a new release now, and install it (at most every 10 minutes)
// The owner's key only (a shared list's key gets 403, like every route but its own).
import { API_VERSION, REPOSITORY, VERSION } from './version.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const CHECK_EVERY = 6 * HOUR;       // the cron looks at GitHub this often
export const NOW_EVERY = 10 * MINUTE;      // "Update now" at most this often
const LOCK_MS = 10 * MINUTE;               // one run at a time (a run that died is taken over after this)
const CONFIRM_WITHIN = 24 * HOUR;          // a new version that cannot update its database goes back, within a day
const LOG_KEEP = 30;
export const TOKEN_SECRET = 'UPDATE_TOKEN';
export const MANIFEST_NAME = 'saqme-release.json';
export const BUNDLE_MAGIC = 'saqme-worker 1';
export const CF_API = 'https://api.cloudflare.com/client/v4';
const MAX_BUNDLE = 50_000_000;

export class UpdateError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- rules (the same as local/update.mjs)
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

const MAX_ASSET = 100_000_000;
/** The release manifest -> what the updaters use of it, or null (local/update.mjs checkManifest, line for line). */
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

/** The manifest's Worker bundle (scripts/build-release.mjs) -> { asset, size, sha256, headerSha256 }, or null. */
export function checkWorkerPart(m, checked = checkManifest(m)) {
  const w = m?.worker;
  if (!checked || !w || typeof w !== 'object' || Array.isArray(w) || w.asset !== `saqme-worker-${checked.version}.bundle`) return null;
  if (!Number.isInteger(w.size) || w.size < 1 || w.size > MAX_BUNDLE) return null;
  const hex = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
  if (!hex(w.sha256) || !hex(w.headerSha256)) return null;
  return { asset: w.asset, size: w.size, sha256: w.sha256.toLowerCase(), headerSha256: w.headerSha256.toLowerCase() };
}

/**
 * Whether this Worker updates itself to a release: { update: true } or { update: false, why }, why one of
 * 'none' (no release) | 'current' (not newer) | 'no-bundle' (the release cannot do it) | 'api' (it would offer less
 * than this one) | 'skipped' (it went back from that version before: only Update now tries it again).
 */
export function selfUpdateDecision({ manifest, worker, version = VERSION, api = API_VERSION, skip = '', manual = false }) {
  if (!manifest) return { update: false, why: 'none' };
  const cmp = compareVersions(manifest.version, version);
  if (cmp === null || cmp <= 0) return { update: false, why: 'current' };
  if (!worker) return { update: false, why: 'no-bundle' };
  if (manifest.api < api) return { update: false, why: 'api' };
  if (!manual && skip && compareVersions(skip, manifest.version) === 0) return { update: false, why: 'skipped' };
  return { update: true };
}

// ---------------------------------------------------------------- the bundle (scripts/build-release.mjs buildWorkerBundle)
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (bytes) => hexOf(await crypto.subtle.digest('SHA-256', bytes));

/**
 * The bundle's bytes -> { header, body }, checked against the manifest's part and release: its size, the SHA-256 of
 * its first two lines, what it says it is, and that every part lies inside it. The parts themselves are checked as
 * they are used (partOf): that is all a deploy reads, and costs a Worker less time than hashing all of it.
 */
export async function readBundle(bytes, part, manifest) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length !== part.size) throw new UpdateError(`The download has ${b.length} bytes; the release says ${part.size}.`);
  const nl1 = b.indexOf(10);
  const nl2 = nl1 < 0 ? -1 : b.indexOf(10, nl1 + 1);
  if (nl2 < 0 || new TextDecoder().decode(b.subarray(0, nl1)) !== BUNDLE_MAGIC) throw new UpdateError('The download is not a Saqme sync service.');
  if ((await sha256Hex(b.subarray(0, nl2 + 1))) !== part.headerSha256) throw new UpdateError('The download does not match the checksum of the release.');
  let header;
  try { header = JSON.parse(new TextDecoder().decode(b.subarray(nl1 + 1, nl2))); } catch { header = null; }
  const body = b.subarray(nl2 + 1);
  const ok = header && header.schema === 1 && header.version === manifest.version && header.api === manifest.api && header.body === body.length
    && typeof header.main === 'string' && typeof header.compatibilityDate === 'string' && Array.isArray(header.modules) && header.modules.length > 0
    && Array.isArray(header.files) && header.assets?.binding && Array.isArray(header.requires)
    && [...header.modules, ...header.files].every((p) => Number.isInteger(p.offset) && Number.isInteger(p.size) && p.offset >= 0 && p.size >= 0
      && p.offset + p.size <= body.length && /^[0-9a-f]{64}$/.test(p.sha256 ?? ''))
    && header.modules.some((m) => m.name === header.main)
    && header.files.every((f) => typeof f.path === 'string' && f.path.startsWith('/') && /^[0-9a-f]{32}$/.test(f.hash ?? '') && typeof f.type === 'string');
  if (!ok) throw new UpdateError(`The release's sync service (${manifest.version}) is not one this version can install.`);
  return { header, body };
}

/** One part of the bundle, after its SHA-256 matched the header's. */
export async function partOf(bundle, p) {
  const bytes = bundle.body.subarray(p.offset, p.offset + p.size);
  if ((await sha256Hex(bytes)) !== p.sha256) throw new UpdateError('The download does not match the checksum of the release.');
  return bytes;
}

function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function jwtClaims(jwt) {
  try { return JSON.parse(atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}

// ---------------------------------------------------------------- GitHub (this repository's releases, https only)
const releases = (repo) => `https://github.com/${repo}/releases`;
export const manifestUrl = (repo) => `${releases(repo)}/latest/download/${MANIFEST_NAME}`;
/** Built from the repository and the checked manifest, never taken from it. */
export const bundleUrl = (repo, m, w) => `${releases(repo)}/download/${m.tag}/${w.asset}`;

async function readCapped(res, max) {
  if (Number(res.headers.get('content-length') || 0) > max) throw new UpdateError('The download is larger than the release says.');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > max) throw new UpdateError('The download is larger than the release says.');
  return buf;
}
function checkFinalUrl(res) {
  if (res.url && !res.url.startsWith('https://')) throw new UpdateError('The download left https.');
}

/** The newest release -> { manifest, worker } (checked), or null when none is published yet. */
export async function fetchRelease({ repo = REPOSITORY, fetchImpl = fetch } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new UpdateError('This sync service does not say where it is published.');
  let res;
  try { res = await fetchImpl(manifestUrl(repo), { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', 'user-agent': `saqme-worker/${VERSION}` } }); }
  catch (e) { throw new UpdateError(`Could not reach GitHub (${e?.message ?? e}).`, 502); }
  if (res.status === 404) return null;
  if (!res.ok) throw new UpdateError(`GitHub answered ${res.status}.`, 502);
  checkFinalUrl(res);
  let raw = null;
  try { raw = JSON.parse(new TextDecoder().decode(await readCapped(res, 64 * 1024))); } catch { raw = null; }
  const manifest = checkManifest(raw);
  if (!manifest) throw new UpdateError('The release on GitHub has no valid manifest.', 502);
  return { manifest, worker: checkWorkerPart(raw, manifest) };
}

export async function downloadBundle(manifest, worker, { repo = REPOSITORY, fetchImpl = fetch } = {}) {
  let res;
  try { res = await fetchImpl(bundleUrl(repo, manifest, worker), { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': `saqme-worker/${VERSION}` } }); }
  catch (e) { throw new UpdateError(`Could not download the update (${e?.message ?? e}).`, 502); }
  if (!res.ok) throw new UpdateError(`GitHub answered ${res.status} for ${worker.asset}.`, 502);
  checkFinalUrl(res);
  return readBundle(await readCapped(res, worker.size), worker, manifest);
}

// ---------------------------------------------------------------- Cloudflare's API
/** What Cloudflare said, in plain words (its error codes and messages are kept for the log). */
function cloudflareMessage(status, errors) {
  const codes = (errors ?? []).map((e) => e.code);
  const text = (errors ?? []).map((e) => `${e.message ?? ''}${e.code ? ` (${e.code})` : ''}`).filter(Boolean).join('; ');
  if (status === 401 || status === 403 || codes.some((c) => [9106, 9109, 10000, 10001].includes(c))) {
    return `Cloudflare did not accept the update token${text ? `: ${text}` : ''}. It may have expired or been deleted, or lack "Workers Scripts: Edit" for this account: give your sync service a new one.`;
  }
  if (codes.some((c) => c === 10214 || c === 10215)) {
    // (a secret changes the version that runs; Cloudflare refuses while a newer one waits undeployed)
    return 'Cloudflare has a newer version of your sync service that is not deployed (an update that stopped halfway). Update it once from the Saqme app on your computer, then try again.';
  }
  return `Cloudflare answered ${status}${text ? `: ${text}` : ''}.`;
}

/** Cloudflare's API for this Worker, with the update token (or another one: checking a new token). */
export function cloudflare(env, { token = env[TOKEN_SECRET], fetchImpl = fetch } = {}) {
  const account = env.SAQME_ACCOUNT_ID;
  const name = env.SAQME_WORKER_NAME;
  const acc = `${CF_API}/accounts/${encodeURIComponent(account)}`;
  const script = `${acc}/workers/scripts/${encodeURIComponent(name)}`;
  async function call(method, url, { json, body, auth = token, type } = {}) {
    const headers = { authorization: `Bearer ${auth}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    else if (type) headers['content-type'] = type;
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : body, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    } catch (e) { throw new UpdateError(`Could not reach Cloudflare (${e?.message ?? e}).`, 502); }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new UpdateError(cloudflareMessage(res.status, data?.errors), res.status === 401 || res.status === 403 ? 403 : 502);
    return data.result;
  }
  return {
    account, name, call,
    /** active for an account-owned token or a user token, else an error */
    async verifyToken() {
      for (const url of [`${acc}/tokens/verify`, `${CF_API}/user/tokens/verify`]) {
        try { const r = await call('GET', url); if (r?.status === 'active') return r; } catch { /* the other kind */ }
      }
      throw new UpdateError('Cloudflare does not know this token, or it is not active. Copy it again from the page Cloudflare showed after creating it.', 400);
    },
    settings: () => call('GET', `${script}/settings`),
    deployments: () => call('GET', `${script}/deployments`),
    deploy: (versionId, message) => call('POST', `${script}/deployments`, { json: { strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }], annotations: { 'workers/message': message } } }),
    schedules: () => call('GET', `${script}/schedules`),
    setSchedules: (crons) => call('PUT', `${script}/schedules`, { json: crons.map((cron) => ({ cron })) }),
    putSecret: (secretName, text) => call('PUT', `${script}/secrets`, { json: { name: secretName, text, type: 'secret_text' } }),
    deleteSecret: (secretName) => call('DELETE', `${script}/secrets/${encodeURIComponent(secretName)}?url_encoded=true`),
    uploadSession: (manifest) => call('POST', `${script}/assets-upload-session`, { json: { manifest } }),
    uploadAssets: (jwt, form) => call('POST', `${acc}/workers/assets/upload?base64=true`, { auth: jwt, body: form }),
    uploadAsset: (jwt, hash, bytes, type) => call('POST', `${acc}/workers/assets/upload/${hash}`, { auth: jwt, body: bytes, type }),
    uploadVersion: (form) => call('POST', `${script}/versions?bindings_inherit=strict`, { body: form }),
  };
}

/** The phone app's files to Cloudflare (only those it does not have yet) -> the assets' completion token. */
export async function uploadAssets(cf, bundle) {
  const files = bundle.header.files;
  const session = await cf.uploadSession(Object.fromEntries(files.map((f) => [f.path, { hash: f.hash, size: f.size }])));
  const buckets = (session?.buckets ?? []).filter((b) => b.length);
  if (!buckets.length) {
    if (!session?.jwt) throw new UpdateError('Cloudflare did not start the upload of the phone app.', 502);
    return { jwt: session.jwt, uploaded: 0 };
  }
  const byHash = new Map(files.map((f) => [f.hash, f]));
  const fileOf = (hash) => { const f = byHash.get(hash); if (!f) throw new UpdateError('Cloudflare asked for a file the update does not have.', 502); return f; };
  // (Cloudflare may ask for one file per request instead of buckets, as it does of wrangler)
  const single = jwtClaims(session.jwt).wrangler_single_asset_uploads === true;
  let done = '';
  let uploaded = 0;
  for (const bucket of single ? buckets.flat().map((h) => [h]) : buckets) {
    let r;
    if (single) {
      const f = fileOf(bucket[0]);
      r = await cf.uploadAsset(session.jwt, f.hash, await partOf(bundle, f), f.type);
    } else {
      const form = new FormData();
      for (const hash of bucket) {
        const f = fileOf(hash);
        form.append(hash, new File([toBase64(await partOf(bundle, f))], hash, { type: f.type }));
      }
      r = await cf.uploadAssets(session.jwt, form);
    }
    uploaded += bucket.length;
    done = r?.jwt || done;
  }
  if (!done) throw new UpdateError('Cloudflare did not finish the upload of the phone app.', 502);
  return { jwt: done, uploaded };
}

/**
 * The bindings of the new version, from the Worker's settings: as `wrangler deploy` sends them (D1 with its id,
 * variables with their values, the assets binding), the secrets kept by keep_bindings, anything else inherited.
 */
export function versionBindings(current, assetsBinding) {
  const out = [];
  for (const b of current ?? []) {
    if (!b?.name || b.type === 'assets' || b.type === 'secret_text' || b.type === 'secret_key') continue;
    if (b.type === 'd1' && (b.id || b.database_id)) out.push({ type: 'd1', name: b.name, id: b.id || b.database_id });
    else if (b.type === 'plain_text' && typeof b.text === 'string') out.push({ type: 'plain_text', name: b.name, text: b.text });
    else if (b.type === 'json' && 'json' in b) out.push({ type: 'json', name: b.name, json: b.json });
    else out.push({ type: 'inherit', name: b.name });
  }
  out.push({ type: 'assets', name: assetsBinding });
  return out;
}

/** The new version (not deployed): this bundle's code and settings, every binding of the Worker it replaces kept. */
export async function uploadVersion(cf, bundle, { jwt, bindings }) {
  const h = bundle.header;
  const metadata = {
    main_module: h.main,
    compatibility_date: h.compatibilityDate,
    compatibility_flags: h.compatibilityFlags ?? [],
    bindings: versionBindings(bindings, h.assets.binding),
    keep_bindings: ['secret_text', 'secret_key'],
    assets: { jwt, config: h.assets.config },
    annotations: { 'workers/message': `Saqme ${h.version} (the sync service updated itself)`, 'workers/tag': `v${h.version}` },
  };
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  for (const m of h.modules) form.append(m.name, new File([await partOf(bundle, m)], m.name, { type: m.type }));
  const r = await cf.uploadVersion(form);
  if (!r?.id) throw new UpdateError('Cloudflare did not say which version it made.', 502);
  return r.id;
}

// ---------------------------------------------------------------- state (meta)
// 'update_settings'  what the owner chose: { auto, token: 'saved' | 'removed', tokenAt, nowAt (the last Update now) }
// 'update'           what the runs did: { checkedAt, latest, last: { ok, at, version, message }, running, finishedAt,
//                    deployed: { version, versionId, previous, from, at, switched }, skip, log: [{ at, text, error }] }
// 'update_lock'      the time the running run started
// Each is written by its own side only, so a run and a tap in Settings never write over each other.
async function readMeta(db, key) {
  try { return JSON.parse((await db.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first('value')) ?? 'null'); } catch { return null; }
}
const writeMeta = (db, key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  .bind(key, JSON.stringify(value)).run();

export const loadSettings = async (env) => ({ auto: true, ...(await readMeta(env.DB, 'update_settings')) });
async function saveSettings(env, patch) {
  const s = { ...(await loadSettings(env)), ...patch };
  await writeMeta(env.DB, 'update_settings', s);
  return s;
}

/** A run's state, kept in memory and written as it goes (one D1 write a step: a run has 50 queries at most). */
class Run {
  constructor(state, now) { this.s = { log: [], ...state }; this.now = now; }
  static async load(env, now = Date.now()) { const r = new Run(await readMeta(env.DB, 'update') ?? {}, now); r.env = env; return r; }
  set(patch) { Object.assign(this.s, patch); return this; }
  /** One line in the update log (the newest last), and in the Worker's own logs. */
  log(text, { error = false } = {}) {
    (error ? console.error : console.log)(`self-update: ${text}`);
    this.s.log = [...(this.s.log ?? []), { at: this.now, text: String(text).slice(0, 500), ...(error ? { error: true } : {}) }].slice(-LOG_KEEP);
    return this;
  }
  save() { return writeMeta(this.env.DB, 'update', this.s); }
}
export const loadRun = (env) => Run.load(env);

/** Takes the run lock (false: another run holds it). */
async function lock(env, now) {
  const r = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('update_lock', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value
     WHERE CAST(meta.value AS INTEGER) < ?2`,
  ).bind(String(now), now - LOCK_MS).run();
  return (r.meta?.changes ?? 0) > 0;
}
const unlock = (env) => env.DB.prepare(`DELETE FROM meta WHERE key = 'update_lock'`).run();
const lockedAt = async (env) => Number(await env.DB.prepare(`SELECT value FROM meta WHERE key = 'update_lock'`).first('value') ?? 0);

/**
 * Where to make the token: Cloudflare's "Create API token" page as a template, filled in with the one permission
 * it needs (Workers Scripts: Edit) on this account only.
 */
export function tokenTemplateUrl(accountId) {
  const q = new URLSearchParams({
    permissionGroupKeys: JSON.stringify([{ key: 'workers_scripts', type: 'edit' }]),
    name: 'Saqme sync service updates',
    accountId: accountId || '*',
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${q}`;
}

/** Account and name known (vars from wrangler.toml.template); a token there. */
const knowsItself = (env) => !!(env.SAQME_ACCOUNT_ID && env.SAQME_WORKER_NAME);
const hasToken = (env) => typeof env[TOKEN_SECRET] === 'string' && env[TOKEN_SECRET].length >= 20;

/** GET /api/update: how it stands, for Settings. */
export async function updateStatus(env, { now = Date.now() } = {}) {
  const [set, run, at] = await Promise.all([loadSettings(env), Run.load(env, now), lockedAt(env)]);
  const r = run.s;
  // a token given or removed a moment ago: the Worker takes it up within seconds (a new isolate), say it as it will be
  const recent = set.tokenAt && now - set.tokenAt < 10 * MINUTE;
  return {
    version: VERSION, api: API_VERSION,
    // false: deployed by a setup before 1.2.0, so it does not know its account yet (the computer's next update fixes it)
    knowsItself: knowsItself(env),
    token: recent ? set.token === 'saved' : hasToken(env),
    auto: set.auto !== false,
    running: at && now - at < LOCK_MS ? (r.running || 'checking') : null,
    latest: r.latest ?? null, checkedAt: r.checkedAt ?? 0,
    last: r.last ?? null,
    nextNowAt: set.nowAt ? set.nowAt + NOW_EVERY : 0,
    tokenUrl: tokenTemplateUrl(env.SAQME_ACCOUNT_ID),
    account: env.SAQME_ACCOUNT_ID ?? '', worker: env.SAQME_WORKER_NAME ?? '',
    log: (r.log ?? []).slice(-12),
  };
}

export async function setAuto(env, on, { now = Date.now() } = {}) {
  await saveSettings(env, { auto: !!on });
  console.log(`self-update: updating by itself ${on ? 'on' : 'off'}`);
  return updateStatus(env, { now });
}

/**
 * POST /api/update/token: checks a token (Cloudflare knows it, it is active, it opens this Worker) and keeps it as
 * the Worker secret UPDATE_TOKEN, written with that token itself (which shows it may change this Worker). An empty
 * token removes the secret. The token is never stored anywhere else, and never sent back.
 */
export async function saveToken(env, token, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!knowsItself(env)) throw new UpdateError('Your sync service does not know its Cloudflare account yet. Update it once from the Saqme app on your computer (Settings > Updates), then try again.', 409);
  const t = String(token ?? '').trim();
  if (!t) {
    if (hasToken(env)) {
      try { await cloudflare(env, { fetchImpl }).deleteSecret(TOKEN_SECRET); } catch (e) { throw new UpdateError(`The token could not be removed: ${e.message}`, e.status ?? 502); }
    }
    await saveSettings(env, { token: 'removed', tokenAt: now });
    console.log('self-update: the update token was removed');
    return updateStatus(env, { now });
  }
  if (!/^[\w.-]{20,400}$/.test(t)) throw new UpdateError('That is not a Cloudflare API token (one long word of letters and digits). Copy it again from the page Cloudflare showed after creating it.');
  const cf = cloudflare(env, { token: t, fetchImpl });
  await cf.verifyToken();
  try { await cf.settings(); } catch (e) {
    throw new UpdateError(e.status === 403 ? `This token cannot reach your sync service ("${cf.name}"). Make it with "Workers Scripts: Edit" for the account your sync service is in.` : e.message, e.status ?? 502);
  }
  try { await cf.putSecret(TOKEN_SECRET, t); } catch (e) {
    throw new UpdateError(e.status === 403 ? 'This token can look at your sync service but not change it. Make it with "Workers Scripts: Edit" (not Read).' : e.message, e.status ?? 502);
  }
  await saveSettings(env, { token: 'saved', tokenAt: now, auto: true });
  console.log('self-update: an update token was saved');
  return updateStatus(env, { now });
}

/** Plain words for a decision not to update. */
function whyNot(why, m) {
  return {
    none: 'No release is published yet.',
    current: `Up to date (${VERSION}).`,
    'no-bundle': `${m?.version} is out, but it cannot update a sync service by itself: the Saqme app on your computer updates it.`,
    api: `${m?.version} is out, but it would offer less than this version, so it is not installed.`,
    skipped: `${m?.version} went back by itself the last time; it is tried again only with Update now.`,
  }[why] ?? 'Nothing to do.';
}

/** Whether the cron runs an update check now: by itself when it is time, or an Update now that did not finish. */
export function dueNow({ settings, run, now }) {
  if ((settings.nowAt ?? 0) > (run.finishedAt ?? 0) && now - settings.nowAt >= LOCK_MS) return true;
  return settings.auto !== false && now - (run.checkedAt ?? 0) >= CHECK_EVERY;
}

/**
 * One run: look at the newest release and, when it is newer, deploy it (see the top of the file). From the cron
 * (when due) or Update now (manual). -> the run's state.
 */
export async function runUpdate(env, { manual = false, now = Date.now(), fetchImpl = fetch } = {}) {
  const run = await Run.load(env, now);
  if (!knowsItself(env) || !hasToken(env) || !(await lock(env, now))) return run.s;
  const r = run.s;
  try {
    await run.set({ running: 'checking' }).save();
    const rel = await fetchRelease({ fetchImpl });
    run.set({ checkedAt: now, latest: rel?.manifest.version ?? null });
    const d = selfUpdateDecision({ manifest: rel?.manifest, worker: rel?.worker, skip: r.skip, manual });
    if (!d.update) {
      const text = whyNot(d.why, rel?.manifest);
      if (d.why !== 'current' && d.why !== 'none') run.log(text);
      run.set({ last: { ok: d.why === 'current' || d.why === 'none', at: now, message: text, version: rel?.manifest.version ?? '' } });
      return r;
    }
    const { manifest, worker } = rel;
    await run.log(`${manifest.version} is out; installing it (${manual ? 'Update now' : 'by itself'})`).set({ running: 'downloading' }).save();
    const bundle = await downloadBundle(manifest, worker, { fetchImpl });
    const cf = cloudflare(env, { fetchImpl });
    const bindings = (await cf.settings())?.bindings ?? [];
    const missing = [...bundle.header.requires, 'AUTH_TOKEN'].filter((n) => !bindings.some((b) => b.name === n));
    if (missing.length) throw new UpdateError(`${manifest.version} needs settings this sync service does not have yet (${missing.join(', ')}): the Saqme app on your computer updates it.`, 409);
    const current = (await cf.deployments())?.deployments?.[0];
    const previous = [...(current?.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0]?.version_id ?? null;
    await run.set({ running: 'uploading' }).save();
    const assets = await uploadAssets(cf, bundle);
    const versionId = await uploadVersion(cf, bundle, { jwt: assets.jwt, bindings });
    // from here on the new version may answer: what it needs to check itself, and to go back
    const deployed = { version: manifest.version, versionId, previous, from: VERSION, at: now, switched: false };
    await run.log(`${manifest.version} is on Cloudflare (${assets.uploaded} new files of the phone app); switching to it`).set({ running: 'switching', deployed }).save();
    await cf.deploy(versionId, `Saqme ${manifest.version} (the sync service updated itself)`);
    run.set({ deployed: { ...deployed, switched: true }, skip: '', last: { ok: true, at: now, version: manifest.version, message: `Updated to ${manifest.version}.` } });
    await run.log(`switched: ${manifest.version} runs now (it was ${VERSION})`).save();
    // the schedule is not part of a version: only when the release changed it
    try {
      const have = ((await cf.schedules())?.schedules ?? []).map((x) => x.cron).sort();
      const want = [...(bundle.header.crons ?? [])].sort();
      if (want.length && JSON.stringify(have) !== JSON.stringify(want)) { await cf.setSchedules(want); run.log(`schedule: ${want.join(', ')}`); }
    } catch (e) { run.log(`the schedule could not be checked: ${e.message}`, { error: true }); }
    return r;
  } catch (e) {
    const message = e instanceof UpdateError ? e.message : `The update did not finish: ${e?.message ?? e}`;
    run.log(message, { error: true }).set({ last: { ok: false, at: now, message, version: r.latest ?? '' } });
    return r;
  } finally {
    run.set({ running: null, finishedAt: now });
    await run.save().catch((e) => console.error('self-update: state not saved', e));
    await unlock(env).catch(() => {});
  }
}

async function rollBack(env, run, reason, { fetchImpl = fetch } = {}) {
  const d = run.s.deployed;
  try {
    await cloudflare(env, { fetchImpl }).deploy(d.previous, `Saqme: back to the version before (${reason})`);
  } catch (e) {
    await run.log(`could not go back after ${reason}: ${e.message}`, { error: true }).save();
    return false;
  }
  const back = d.from || 'the version before';
  await run.log(`went back to ${back}: ${reason}`, { error: true }).set({
    skip: d.version, deployed: null,
    last: { ok: false, at: run.now, version: d.version, message: `The update to ${d.version} went back to ${back} by itself: ${reason}. It is tried again only with Update now.` },
  }).save();
  return true;
}

/**
 * The first run of a new version (the cron, or Settings asking how it stands): the update that made it is done.
 * When another version runs although an update switched to this one, someone went back (the dashboard): that
 * version is not tried again by itself. An update that never switched is just forgotten.
 */
export async function confirmUpdate(env, { now = Date.now() } = {}) {
  const run = await Run.load(env, now);
  const d = run.s.deployed;
  if (!d) return;
  if (d.version === VERSION) {
    await run.log(`${VERSION} started, and its database is up to date`).set({ deployed: null, confirmed: { version: VERSION, at: now } }).save();
  } else if (now - d.at > 30 * MINUTE && !(await lockedAt(env))) {
    if (d.switched) run.log(`${d.version} does not run (${VERSION} does): it was switched back; it is tried again only with Update now`, { error: true }).set({ skip: d.version });
    await run.set({ deployed: null }).save();
  }
}

/** The new version could not update its database: back to the version before (whose database is as it was). */
export async function afterSchemaFailure(env, error, { now = Date.now(), fetchImpl = fetch } = {}) {
  let run;
  try { run = await Run.load(env, now); } catch { return false; }
  const d = run.s.deployed;
  if (!d || d.version !== VERSION || !d.previous || now - d.at > CONFIRM_WITHIN || !hasToken(env) || !knowsItself(env)) return false;
  return rollBack(env, run, `its database update failed (${String(error?.message ?? error).slice(0, 200)})`, { fetchImpl });
}

/**
 * The cron's part. -> true when this run was the update's (the reminders wait for the next run then: each run has
 * 50 subrequests and 50 D1 queries, and an update may need most of them).
 */
export async function scheduledUpdate(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  await confirmUpdate(env, { now });
  if (!knowsItself(env) || !hasToken(env)) return false;
  const [settings, run] = await Promise.all([loadSettings(env), Run.load(env, now)]);
  if (!dueNow({ settings, run: run.s, now })) return false;
  const s = await runUpdate(env, { now, fetchImpl });
  return compareVersions(s.latest, VERSION) > 0;   // (only looking costs little: the reminders run as well)
}

/** POST /api/update/now: once every 10 minutes; the run goes on after the answer (ctx.waitUntil), the cron finishes one that stops. */
export async function startNow(env, ctx, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!knowsItself(env)) throw new UpdateError('Your sync service does not know its Cloudflare account yet. Update it once from the Saqme app on your computer (Settings > Updates).', 409);
  if (!hasToken(env)) throw new UpdateError('Your sync service has no update token yet: give it one first.', 409);
  const settings = await loadSettings(env);
  if (settings.nowAt && now - settings.nowAt < NOW_EVERY) {
    const min = Math.ceil((settings.nowAt + NOW_EVERY - now) / MINUTE);
    throw new UpdateError(`It looked a moment ago. Try again in ${min} minute${min === 1 ? '' : 's'}.`, 429);
  }
  const at = await lockedAt(env);
  if (at && now - at < LOCK_MS) throw new UpdateError('An update is under way.', 409);
  await saveSettings(env, { nowAt: now });
  ctx.waitUntil(runUpdate(env, { manual: true, now, fetchImpl }).catch((e) => console.error('self-update', e)));
  return { ...(await updateStatus(env, { now })), running: 'checking' };
}
