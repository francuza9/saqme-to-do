// The Worker updating itself (worker/src/selfupdate.js; docs/sync.md, "The sync service updates itself"): the
// release's bundle (scripts/build-release.mjs), the rules it shares with the apps' updaters, the token, and a deploy
// through a stand-in of Cloudflare's API that keeps versions, deployments, assets, secrets and schedules the way
// Cloudflare does, with GitHub's releases from memory. The Worker runs on SQLite (local/d1.mjs), as in relay.test.js.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1 } from '../../../local/d1.mjs';
import { buildRelease } from '../../../scripts/build-release.mjs';
import worker from '../../src/index.js';
import { API_VERSION, REPOSITORY, VERSION } from '../../src/version.js';
import {
  afterSchemaFailure, bundleUrl, checkManifest, checkWorkerPart, compareVersions, confirmUpdate, dueNow, loadRun, manifestUrl, readBundle,
  runUpdate, saveToken, scheduledUpdate, selfUpdateDecision, setAuto, startNow, tokenTemplateUrl, updateStatus, versionBindings, CHECK_EVERY, NOW_EVERY,
} from '../../src/selfupdate.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'worker', 'migrations');
const PUBLIC = join(ROOT, 'worker', 'public');
const fx = JSON.parse(readFileSync(join(ROOT, 'shared', 'fixtures', 'update.json'), 'utf8'));
const OWNER_KEY = 'owner-key-0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-token-0123456789abcdefghijklmnopqrstuv';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const NAME = 'saqme';
const DB_ID = '11111111-2222-3333-4444-555555555555';
const { hash: blake3 } = createRequire(join(ROOT, 'worker', 'package.json'))('blake3-wasm');
const wranglerHash = (data, path) => blake3(Buffer.from(data).toString('base64') + extname(path).slice(1)).toString('hex').slice(0, 32);
const HOUR = 3600_000;

// ---------------------------------------------------------------- releases, built from this repository
let tmp;
const releases = {};
/** A release of `version` (its bundle's code says that version), built once. */
function release(version) {
  if (!releases[version]) {
    const r = buildRelease({ root: ROOT, out: join(tmp, `dist-${version}`), version, published: '2026-10-22T00:00:00.000Z' });
    releases[version] = { ...r, bytes: readFileSync(r.bundle) };
  }
  return releases[version];
}
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'saqme-selfupdate-')); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------- the stand-ins
const ok = (result, status = 200) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status, headers: { 'content-type': 'application/json' } });
const fail = (status, code, message) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }), { status });
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** Cloudflare's API for one account with one Worker, in memory. */
class FakeCloudflare {
  constructor() {
    this.tokens = new Map([[TOKEN, { kind: 'user', access: 'edit', account: ACCOUNT }]]);
    this.assets = new Map();         // hash -> { type, bytes } (what the account has already)
    this.versions = [{ id: 'v-old', bindings: this.startBindings(), secrets: { AUTH_TOKEN: OWNER_KEY, UPDATE_TOKEN: TOKEN }, code: 'old' }];
    this.deployments = [{ id: 'd-1', versions: [{ version_id: 'v-old', percentage: 100 }] }];
    this.schedules = ['*/5 * * * *'];
    this.calls = [];
    this.sessions = new Map();       // session jwt -> { need: Set }
    this.singleUploads = false;
    this.breakOn = null;             // 'version' | 'deploy' | 'session'
    this.n = 0;
  }
  startBindings() {
    return [
      { type: 'd1', name: 'DB', id: DB_ID },
      { type: 'plain_text', name: 'SAQME_ACCOUNT_ID', text: ACCOUNT },
      { type: 'plain_text', name: 'SAQME_WORKER_NAME', text: NAME },
      { type: 'secret_text', name: 'AUTH_TOKEN' }, { type: 'secret_text', name: 'UPDATE_TOKEN' },
      { type: 'assets', name: 'ASSETS' },
    ];
  }
  get latest() { return this.versions.at(-1); }
  get live() { const id = this.deployments[0].versions[0].version_id; return this.versions.find((v) => v.id === id); }
  async handle(url, init) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = u.pathname.replace('/client/v4', '');
    this.calls.push(`${method} ${path}${u.search}`);
    const auth = /^Bearer (.+)$/.exec(init.headers?.authorization ?? '')?.[1];
    // the uploads of the phone app's files go with the session's token
    const up = /^\/accounts\/([^/]+)\/workers\/assets\/upload(?:\/([0-9a-f]{32}))?$/.exec(path);
    if (up) return this.upload(auth, up[2], u, init);
    if (path === '/user/tokens/verify') {
      const t = this.tokens.get(auth);
      return t?.kind === 'user' ? ok({ id: 'tok1', status: 'active' }) : fail(401, 1000, 'Invalid API Token');
    }
    const t = this.tokens.get(auth);
    const acc = /^\/accounts\/([^/]+)(\/.*)$/.exec(path);
    if (!acc) return fail(404, 7000, 'No route');
    if (acc[2] === '/tokens/verify') return t?.kind === 'account' && t.account === acc[1] ? ok({ id: 'tok2', status: 'active' }) : fail(401, 1000, 'Invalid API Token');
    if (!t) return fail(401, 10000, 'Authentication error');
    if (t.account !== acc[1] || t.access === 'none') return fail(403, 10000, 'Authentication error');
    const s = /^\/workers\/scripts\/([^/]+)(\/.*)$/.exec(acc[2]);
    if (!s || s[1] !== NAME) return fail(404, 10007, 'This Worker does not exist on your account.');
    const write = method !== 'GET';
    if (write && t.access !== 'edit') return fail(403, 10000, 'Authentication error');
    const route = `${method} ${s[2]}`;
    if (route === 'GET /settings') return ok({ bindings: this.latest.bindings, compatibility_date: '2026-10-01' });
    if (route === 'GET /deployments') return ok({ deployments: this.deployments });
    if (route === 'GET /schedules') return ok({ schedules: this.schedules.map((cron) => ({ cron })) });
    if (route === 'PUT /schedules') { this.schedules = JSON.parse(init.body).map((x) => x.cron); return ok({ schedules: this.schedules.map((cron) => ({ cron })) }); }
    if (route === 'PUT /secrets') {
      if (this.latest !== this.live) return fail(400, 10215, 'latest version is not deployed');
      const b = JSON.parse(init.body);
      this.newVersion({ ...this.latest, secrets: { ...this.latest.secrets, [b.name]: b.text }, bindings: this.withSecret(this.latest.bindings, b.name) }, true);
      return ok({ name: b.name, type: 'secret_text' });
    }
    const del = /^DELETE \/secrets\/([^/?]+)$/.exec(route);
    if (del) {
      const name = decodeURIComponent(del[1]);
      const { [name]: _gone, ...rest } = this.latest.secrets;
      this.newVersion({ ...this.latest, secrets: rest, bindings: this.latest.bindings.filter((b) => b.name !== name) }, true);
      return ok(null);
    }
    if (route === 'POST /assets-upload-session') return this.session(JSON.parse(init.body).manifest);
    if (route === 'POST /versions') return this.version(init.body, u);
    if (route === 'POST /deployments') {
      if (this.breakOn === 'deploy') return fail(500, 10013, 'deployment failed');
      const b = JSON.parse(init.body);
      if (b.strategy !== 'percentage' || b.versions.length !== 1 || b.versions[0].percentage !== 100) return fail(400, 10021, 'bad deployment');
      if (!this.versions.some((v) => v.id === b.versions[0].version_id)) return fail(404, 10007, 'no such version');
      this.deployments.unshift({ id: `d-${++this.n}`, versions: b.versions, message: b.annotations?.['workers/message'] });
      return ok({ id: this.deployments[0].id });
    }
    return fail(404, 7000, `No route for ${route}`);
  }
  withSecret(bindings, name) { return bindings.some((b) => b.name === name) ? bindings : [...bindings, { type: 'secret_text', name }]; }
  newVersion(v, deploy) {
    const id = `v-${++this.n}`;
    this.versions.push({ ...v, id });
    if (deploy) this.deployments.unshift({ id: `d-${++this.n}`, versions: [{ version_id: id, percentage: 100 }] });
    return id;
  }
  session(manifest) {
    if (this.breakOn === 'session') return fail(500, 10000, 'upstream');
    const need = Object.values(manifest).map((m) => m.hash).filter((h) => !this.assets.has(h));
    const token = jwt({ s: ++this.n, ...(this.singleUploads ? { wrangler_single_asset_uploads: true } : {}) });
    this.sessions.set(token, { manifest, need: new Set(need), done: jwt({ done: this.n }) });
    if (!need.length) { this.sessions.get(token).complete = true; return ok({ jwt: token, buckets: [] }); }
    const buckets = [];
    for (let i = 0; i < need.length; i += 5) buckets.push(need.slice(i, i + 5));
    return ok({ jwt: token, buckets });
  }
  async upload(auth, single, u, init) {
    const s = this.sessions.get(auth);
    if (!s) return fail(401, 10000, 'bad upload token');
    const pathOf = (hash) => Object.entries(s.manifest).find(([, m]) => m.hash === hash)?.[0];
    const store = (hash, bytes, type) => {
      if (wranglerHash(bytes, pathOf(hash)) !== hash) throw new Error(`content of ${pathOf(hash)} does not match its hash`);
      this.assets.set(hash, { bytes, type });
      s.need.delete(hash);
    };
    if (single) {
      if (!this.singleUploads) return fail(400, 10000, 'bulk uploads only');
      store(single, Buffer.from(init.body), init.headers['content-type']);
    } else {
      if (u.searchParams.get('base64') !== 'true' || this.singleUploads) return fail(400, 10000, 'bad upload');
      for (const [hash, file] of init.body.entries()) store(hash, Buffer.from(await file.text(), 'base64'), file.type);
    }
    return s.need.size ? ok({}, 202) : ok({ jwt: s.done }, 201);
  }
  async version(form, u) {
    if (this.breakOn === 'version') return fail(400, 10021, 'Uncaught Error: no startup');
    if (u.searchParams.get('bindings_inherit') !== 'strict') return fail(400, 10021, 'expected strict');
    const meta = JSON.parse(form.get('metadata'));
    const session = [...this.sessions].find(([token, x]) => x.done === meta.assets?.jwt || (x.complete && token === meta.assets?.jwt))?.[1];
    if (!session) return fail(400, 10021, 'assets: not a completion token');
    const code = await form.get(meta.main_module).text();
    const keep = new Set(meta.keep_bindings ?? []);
    const bindings = [];
    for (const b of meta.bindings) {
      if (b.type === 'inherit') {
        const was = this.latest.bindings.find((x) => x.name === b.name);
        if (!was) return fail(400, 10057, `inherit binding '${b.name}' is invalid`);
        bindings.push(was);
      } else bindings.push(b);
    }
    for (const b of this.latest.bindings) if (keep.has(b.type) && !bindings.some((x) => x.name === b.name)) bindings.push(b);
    const id = this.newVersion({ bindings, secrets: this.latest.secrets, code, meta, files: session.manifest });
    this.lastForm = form;
    return ok({ id, startup_time_ms: 5, metadata: { has_preview: false } });
  }
}

/** GitHub's releases: the newest one's manifest (or none), its bundle; everything else 404. */
function github(state) {
  return async (url) => {
    state.calls.push(String(url));
    if (url === manifestUrl(REPOSITORY)) {
      if (!state.manifest) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(state.manifest), { status: 200 });
    }
    const m = checkManifest(state.manifest);
    const w = m && checkWorkerPart(state.manifest, m);
    if (w && url === bundleUrl(REPOSITORY, m, w)) return new Response(state.bundle, { status: 200 });
    return new Response('Not Found', { status: 404 });
  };
}

let dir;
let db;
let env;
let cf;
let gh;
let fetchImpl;
let outbound;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saqme-su-'));
  db = new D1(join(dir, 'w.db'));
  db.migrate(MIGRATIONS);
  env = { DB: db, AUTH_TOKEN: OWNER_KEY, UPDATE_TOKEN: TOKEN, SAQME_ACCOUNT_ID: ACCOUNT, SAQME_WORKER_NAME: NAME };
  cf = new FakeCloudflare();
  gh = { manifest: null, bundle: null, calls: [] };
  outbound = [];
  const toGithub = github(gh);
  fetchImpl = async (url, init = {}) => {
    outbound.push(String(url));
    if (String(url).startsWith('https://api.cloudflare.com/client/v4/')) return cf.handle(url, init);
    if (String(url).startsWith('https://github.com/')) return toGithub(url, init);
    throw new TypeError('fetch failed');
  };
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/** Publishes a release of `version` as the newest (its manifest edited by `edit`, its bundle by `bytes`). */
function publish(version, { edit = (m) => m, bytes = null } = {}) {
  const r = release(version);
  gh.manifest = edit(structuredClone(r.manifest));
  gh.bundle = bytes ?? r.bytes;
  return r;
}
const run = (opts = {}) => runUpdate(env, { fetchImpl, now: opts.now ?? Date.now(), ...opts });
const ctxStub = () => { const w = []; return { waitUntil: (p) => w.push(p), done: () => Promise.all(w) }; };

describe('the rules, the same as the apps\' updaters', () => {
  it('versions and manifests: shared/fixtures/update.json', () => {
    for (const [a, b, want] of fx.compareVersions) expect(compareVersions(a, b), `${a} ${b}`).toBe(want);
    for (const c of fx.manifest) expect(checkManifest(c.in)).toEqual(c.out);
  });

  it('updates only to a newer release that has the bundle and offers at least this API; a version that went back waits for Update now', () => {
    for (const c of fx.selfUpdate) {
      const manifest = c.release ? { version: c.release.version, api: c.release.api } : null;
      const d = selfUpdateDecision({ manifest, worker: c.bundle ? {} : null, version: c.running.version, api: c.running.api, skip: c.skip, manual: c.manual });
      expect(d.update ? 'update' : d.why, JSON.stringify(c)).toBe(c.out);
    }
  });

  it('the bundle\'s part of the manifest: the name its version fixes, a size, two checksums', () => {
    const m = structuredClone(release('9.9.9').manifest);
    expect(checkWorkerPart(m)).toMatchObject({ asset: 'saqme-worker-9.9.9.bundle', size: release('9.9.9').bytes.length });
    for (const bad of [{ asset: '../x.bundle' }, { asset: 'saqme-worker-9.9.8.bundle' }, { size: 0 }, { size: 1e9 }, { sha256: 'x' }, { headerSha256: undefined }]) {
      expect(checkWorkerPart({ ...m, worker: { ...m.worker, ...bad } }), JSON.stringify(bad)).toBeNull();
    }
    expect(checkWorkerPart({ ...m, worker: undefined })).toBeNull();
  });
});

describe('the release\'s bundle', () => {
  it('has the code bundled into one module and every file of the phone app with wrangler\'s hash and type', async () => {
    const r = release('9.9.9');
    const m = checkManifest(r.manifest);
    const b = await readBundle(r.bytes, checkWorkerPart(r.manifest, m), m);
    expect(b.header).toMatchObject({ version: '9.9.9', api: API_VERSION, main: 'index.js', compatibilityDate: '2026-10-01', crons: ['*/5 * * * *'], requires: ['DB', 'SAQME_ACCOUNT_ID', 'SAQME_WORKER_NAME'] });
    expect(b.header.assets.config.run_worker_first).toEqual(['/api/*']);
    expect(b.header.assets.config._headers).toBe(readFileSync(join(PUBLIC, '_headers'), 'utf8'));
    const files = [];
    const walk = (rel) => { for (const n of readdirSync(join(PUBLIC, rel))) { const p = rel ? `${rel}/${n}` : n; if (statSync(join(PUBLIC, p)).isDirectory()) walk(p); else files.push(p); } };
    walk('');
    expect(b.header.files.map((f) => f.path).sort()).toEqual(files.filter((f) => f !== '_headers').map((f) => `/${f}`).sort());
    for (const f of b.header.files) {
      const data = readFileSync(join(PUBLIC, f.path.slice(1)));
      expect(f.hash, f.path).toBe(wranglerHash(data, f.path));
      expect(Buffer.from(b.body.subarray(f.offset, f.offset + f.size)).equals(data), f.path).toBe(true);
    }
    expect(b.header.files.find((f) => f.path === '/index.html').type).toBe('text/html; charset=utf-8');
    expect(b.header.files.find((f) => f.path === '/fonts/FiraGO-Regular.ttf').type).toBe('font/ttf');
  });

  it('its code runs on its own: it is that version and answers like the Worker', async () => {
    const r = release('9.9.9');
    const m = checkManifest(r.manifest);
    const b = await readBundle(r.bytes, checkWorkerPart(r.manifest, m), m);
    const code = Buffer.from(b.body.subarray(b.header.modules[0].offset, b.header.modules[0].offset + b.header.modules[0].size)).toString('utf8');
    expect(code).not.toMatch(/^\s*import\s/m);   // one module, nothing to resolve
    const file = join(dir, 'bundled.mjs');
    writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)).default;
    expect(typeof mod.scheduled).toBe('function');
    const res = await mod.fetch(new Request('https://saqme.test/api/health'), { DB: db, AUTH_TOKEN: OWNER_KEY }, ctxStub());
    expect(await res.json()).toMatchObject({ ok: true, version: '9.9.9', api: API_VERSION });
  });

  it('is the same for the same files; a changed byte, size or header is refused', async () => {
    const r = release('9.9.9');
    const m = checkManifest(r.manifest);
    const w = checkWorkerPart(r.manifest, m);
    expect(buildRelease({ root: ROOT, out: join(dir, 'again'), version: '9.9.9' }).manifest.worker).toEqual(r.manifest.worker);
    const head = r.bytes.indexOf(10, r.bytes.indexOf(10) + 1) + 1;
    const flip = (at) => { const c = Buffer.from(r.bytes); c[at] ^= 1; return c; };
    await expect(readBundle(flip(20), w, m)).rejects.toThrow(/checksum/);
    await expect(readBundle(r.bytes.subarray(0, r.bytes.length - 1), w, m)).rejects.toThrow(/bytes/);
    await expect(readBundle(r.bytes, w, { ...m, version: '9.9.8' })).rejects.toThrow(/not one this version can install/);
    // a changed byte of a part passes the header, and is refused where it is used (a deploy: below)
    const { partOf } = await import('../../src/selfupdate.js');
    const b = await readBundle(flip(head + 10), w, m);
    await expect(partOf(b, b.header.modules[0])).rejects.toThrow(/checksum/);
  });
});

describe('the token', () => {
  beforeEach(() => {
    delete env.UPDATE_TOKEN;
    cf.versions[0].bindings = cf.versions[0].bindings.filter((b) => b.name !== 'UPDATE_TOKEN');
    delete cf.versions[0].secrets.UPDATE_TOKEN;
  });

  it('is checked with Cloudflare and kept as the Worker secret, written with itself; it is never sent back', async () => {
    const s = await saveToken(env, ` ${TOKEN} `, { fetchImpl });
    expect(s).toMatchObject({ token: true, auto: true });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(cf.live.secrets.UPDATE_TOKEN).toBe(TOKEN);
    expect(cf.calls).toEqual(expect.arrayContaining([`GET /accounts/${ACCOUNT}/workers/scripts/${NAME}/settings`, `PUT /accounts/${ACCOUNT}/workers/scripts/${NAME}/secrets`]));
    expect(JSON.stringify(await db.prepare('SELECT * FROM meta').all())).not.toContain(TOKEN);
  });

  it('an account-owned token works too', async () => {
    cf.tokens.set('acct-token-0123456789abcdefghijklmnop', { kind: 'account', access: 'edit', account: ACCOUNT });
    await saveToken(env, 'acct-token-0123456789abcdefghijklmnop', { fetchImpl });
    expect(cf.live.secrets.UPDATE_TOKEN).toBe('acct-token-0123456789abcdefghijklmnop');
  });

  it('says in plain words what is wrong with one that will not do', async () => {
    cf.tokens.set('read-token-0123456789abcdefghijklmnop', { kind: 'user', access: 'read', account: ACCOUNT });
    cf.tokens.set('other-token-0123456789abcdefghijklmno', { kind: 'user', access: 'edit', account: 'another-account' });
    await expect(saveToken(env, 'not a token', { fetchImpl })).rejects.toThrow(/not a Cloudflare API token/);
    await expect(saveToken(env, 'unknown-token-0123456789abcdefghijklm', { fetchImpl })).rejects.toThrow(/does not know this token/);
    await expect(saveToken(env, 'read-token-0123456789abcdefghijklmnop', { fetchImpl })).rejects.toThrow(/not change it/);
    await expect(saveToken(env, 'other-token-0123456789abcdefghijklmno', { fetchImpl })).rejects.toThrow(/cannot reach your sync service/);
    expect(cf.live.secrets.UPDATE_TOKEN).toBeUndefined();
    const old = { ...env, SAQME_ACCOUNT_ID: undefined };
    await expect(saveToken(old, TOKEN, { fetchImpl })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Update it once from the Saqme app/) });
  });

  it('removing it deletes the secret: no more updates', async () => {
    await saveToken(env, TOKEN, { fetchImpl });
    env.UPDATE_TOKEN = TOKEN;
    const s = await saveToken(env, '', { fetchImpl });
    expect(s.token).toBe(false);
    expect(cf.live.secrets.UPDATE_TOKEN).toBeUndefined();
    expect(cf.calls.at(-1)).toBe(`DELETE /accounts/${ACCOUNT}/workers/scripts/${NAME}/secrets/UPDATE_TOKEN?url_encoded=true`);
  });

  it('the page to make it asks for Workers Scripts: Edit on this account only', () => {
    const u = new URL(tokenTemplateUrl(ACCOUNT));
    expect(u.origin + u.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens');
    expect(JSON.parse(u.searchParams.get('permissionGroupKeys'))).toEqual([{ key: 'workers_scripts', type: 'edit' }]);
    expect(u.searchParams.get('accountId')).toBe(ACCOUNT);
  });
});

describe('an update', () => {
  it('uploads the phone app\'s new files and the code as a new version, then switches to it; bindings and secrets stay', async () => {
    publish('9.9.9');
    const s = await run({ manual: true });
    expect(s.last).toMatchObject({ ok: true, version: '9.9.9' });
    expect(cf.live.id).not.toBe('v-old');
    expect(cf.live.code).toContain('"9.9.9"');
    expect(cf.live.meta).toMatchObject({ main_module: 'index.js', compatibility_date: '2026-10-01', keep_bindings: ['secret_text', 'secret_key'] });
    expect(cf.live.meta.annotations['workers/tag']).toBe('v9.9.9');
    // the same bindings, as wrangler deploy sends them, and the secrets kept
    expect(cf.live.bindings.find((b) => b.name === 'DB')).toEqual({ type: 'd1', name: 'DB', id: DB_ID });
    expect(cf.live.bindings.find((b) => b.name === 'SAQME_ACCOUNT_ID')).toEqual({ type: 'plain_text', name: 'SAQME_ACCOUNT_ID', text: ACCOUNT });
    expect(cf.live.bindings.map((b) => b.name).sort()).toEqual(['ASSETS', 'AUTH_TOKEN', 'DB', 'SAQME_ACCOUNT_ID', 'SAQME_WORKER_NAME', 'UPDATE_TOKEN']);
    expect(cf.live.secrets).toEqual({ AUTH_TOKEN: OWNER_KEY, UPDATE_TOKEN: TOKEN });
    // every file of the phone app is on Cloudflare with its content type
    const files = Object.keys(cf.live.files);
    expect(files).toContain('/index.html');
    for (const [path, m] of Object.entries(cf.live.files)) expect(cf.assets.has(m.hash), path).toBe(true);
    expect(cf.assets.get(cf.live.files['/js/app.js'].hash).type).toBe('text/javascript; charset=utf-8');
    // what it needs to check itself and to go back, and what it says
    const r = (await loadRun(env)).s;
    expect(r.deployed).toMatchObject({ version: '9.9.9', previous: 'v-old', from: VERSION, switched: true });
    expect(r.log.map((l) => l.text).join('\n')).toMatch(/9\.9\.9 is out[\s\S]*switched: 9\.9\.9 runs now/);
    expect(cf.schedules).toEqual(['*/5 * * * *']);
    expect(cf.calls.filter((c) => c.startsWith('PUT /accounts') && c.endsWith('/schedules'))).toEqual([]);
  });

  it('sends only what Cloudflare does not have: files a deploy from a computer uploaded are not sent again', async () => {
    publish('9.9.9');
    // (as if wrangler had deployed this phone app already: the same hashes)
    for (const f of (await readBundle(release('9.9.9').bytes, checkWorkerPart(gh.manifest), checkManifest(gh.manifest))).header.files) cf.assets.set(f.hash, { bytes: Buffer.alloc(0), type: f.type });
    const s = await run({ manual: true });
    expect(s.last.ok).toBe(true);
    expect(cf.calls.filter((c) => c.includes('/workers/assets/upload'))).toEqual([]);
    expect(s.log.map((l) => l.text).join('\n')).toMatch(/0 new files of the phone app/);
  });

  it('one file per request when Cloudflare asks so', async () => {
    cf.singleUploads = true;
    publish('9.9.9');
    const s = await run({ manual: true });
    expect(s.last.ok).toBe(true);
    expect(cf.calls.filter((c) => /assets\/upload\/[0-9a-f]{32}$/.test(c)).length).toBe(Object.keys(cf.live.files).length);
  });

  it('a release that changed the schedule sets it', async () => {
    cf.schedules = ['0 * * * *'];
    publish('9.9.9');
    await run({ manual: true });
    expect(cf.schedules).toEqual(['*/5 * * * *']);
  });

  it('talks to this repository\'s releases and Cloudflare\'s API only', async () => {
    publish('9.9.9', { edit: (m) => ({ ...m, url: 'https://evil.example/x.bundle', worker: { ...m.worker, url: 'https://evil.example/y' } }) });
    expect((await run({ manual: true })).last.ok).toBe(true);
    expect(outbound.filter((u) => !u.startsWith(`https://github.com/${REPOSITORY}/releases/`) && !u.startsWith('https://api.cloudflare.com/client/v4/'))).toEqual([]);
    expect(outbound.filter((u) => u.startsWith('https://github.com/'))).toEqual([manifestUrl(REPOSITORY), `https://github.com/${REPOSITORY}/releases/download/v9.9.9/saqme-worker-9.9.9.bundle`]);
  });

  it('nothing to do: up to date, an older release, none yet, one without the bundle or with a lower API', async () => {
    for (const [what, prep, text] of [
      ['same', () => publish(VERSION), /Up to date/],
      ['older', () => publish('0.0.1'), /Up to date/],
      ['none', () => { gh.manifest = null; }, /No release/],
      ['no bundle', () => publish('9.9.9', { edit: (m) => { delete m.worker; return m; } }), /cannot update a sync service by itself/],
      ['lower api', () => publish('9.9.9', { edit: (m) => ({ ...m, api: API_VERSION - 1, minWorkerApi: 1 }) }), /offer less/],
    ]) {
      prep();
      const s = await run({ manual: true });
      expect(s.last.message, what).toMatch(text);
      expect(cf.versions.length, what).toBe(1);
    }
  });

  it('a download that does not match the release changes nothing', async () => {
    const r = release('9.9.9');
    const head = r.bytes.indexOf(10, r.bytes.indexOf(10) + 1) + 1;
    for (const [what, bytes] of [['header', (() => { const c = Buffer.from(r.bytes); c[30] ^= 1; return c; })()], ['code', (() => { const c = Buffer.from(r.bytes); c[head + 100] ^= 1; return c; })()],
      ['a file', (() => { const c = Buffer.from(r.bytes); c[c.length - 10] ^= 1; return c; })()], ['short', r.bytes.subarray(0, r.bytes.length - 3)]]) {
      cf = new FakeCloudflare();   // (a file Cloudflare has already is its own copy, checked when it was sent: not read again)
      publish('9.9.9', { bytes });
      const s = await run({ manual: true });
      expect(s.last.ok, what).toBe(false);
      expect(s.last.message, what).toMatch(/checksum|bytes/);
      expect(cf.live.id, what).toBe('v-old');
      expect(cf.versions.filter((v) => v.code !== 'old').length, what).toBe(0);
    }
  });

  it('Cloudflare refusing the new version, or the switch, leaves the version that runs as it is; the next try works', async () => {
    publish('9.9.9');
    cf.breakOn = 'version';
    let s = await run({ manual: true });
    expect(s.last).toMatchObject({ ok: false, message: expect.stringMatching(/no startup/) });
    expect(cf.live.id).toBe('v-old');
    cf.breakOn = 'deploy';
    s = await run({ manual: true });
    expect(s.last.ok).toBe(false);
    expect(cf.live.id).toBe('v-old');
    expect(s.deployed).toMatchObject({ version: '9.9.9', switched: false });
    // (an update that never switched is forgotten, not taken for one that went back)
    await confirmUpdate(env, { now: Date.now() + HOUR });
    expect((await loadRun(env)).s.deployed).toBeNull();
    expect((await loadRun(env)).s.skip).toBeFalsy();
    cf.breakOn = null;
    s = await run({ manual: true });
    expect(s.last.ok).toBe(true);
    expect(cf.live.code).toContain('"9.9.9"');
  });

  it('a release that needs a binding this Worker does not have is left to the computer', async () => {
    cf.versions[0].bindings = cf.versions[0].bindings.filter((b) => b.name !== 'SAQME_WORKER_NAME');
    publish('9.9.9');
    const s = await run({ manual: true });
    expect(s.last.message).toMatch(/needs settings this sync service does not have yet \(SAQME_WORKER_NAME\)/);
    expect(cf.versions.length).toBe(1);
  });

  it('a token Cloudflare no longer accepts says so', async () => {
    cf.tokens.delete(TOKEN);
    publish('9.9.9');
    const s = await run({ manual: true });
    expect(s.last.message).toMatch(/did not accept the update token/);
  });

  it('one run at a time', async () => {
    publish('9.9.9');
    const [a, b] = await Promise.all([run({ manual: true }), run({ manual: true })]);
    expect(cf.versions.filter((v) => v.code !== 'old').length).toBe(1);
    expect([a.last?.ok, b.last?.ok]).toContain(true);
  });

  it('without a token, or a Worker that does not know its account, nothing happens', async () => {
    publish('9.9.9');
    await runUpdate({ ...env, UPDATE_TOKEN: undefined }, { fetchImpl, manual: true });
    await runUpdate({ ...env, SAQME_WORKER_NAME: undefined }, { fetchImpl, manual: true });
    expect(outbound).toEqual([]);
  });
});

describe('when it runs', () => {
  it('the cron looks every 6 hours while it is on; Update now at most every 10 minutes, also when it is off', async () => {
    publish(VERSION);
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    expect(await scheduledUpdate(env, { now: t0, fetchImpl })).toBe(false);   // (only looked: the reminders run too)
    expect(gh.calls.length).toBe(1);
    await scheduledUpdate(env, { now: t0 + CHECK_EVERY - 1, fetchImpl });
    expect(gh.calls.length).toBe(1);
    await scheduledUpdate(env, { now: t0 + CHECK_EVERY, fetchImpl });
    expect(gh.calls.length).toBe(2);
    await setAuto(env, false);
    await scheduledUpdate(env, { now: t0 + 3 * CHECK_EVERY, fetchImpl });
    expect(gh.calls.length).toBe(2);
    const ctx = ctxStub();
    expect((await startNow(env, ctx, { now: t0 + 3 * CHECK_EVERY, fetchImpl })).running).toBe('checking');
    await ctx.done();
    expect(gh.calls.length).toBe(3);
    await expect(startNow(env, ctxStub(), { now: t0 + 3 * CHECK_EVERY + NOW_EVERY - 60_000, fetchImpl })).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/Try again in 1 minute/) });
  });

  it('a run that installs leaves the reminders to the next cron run', async () => {
    publish('9.9.9');
    expect(await scheduledUpdate(env, { now: Date.now(), fetchImpl })).toBe(true);
  });

  it('an Update now that did not finish (the 30 s after the answer ran out) is finished by the cron', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const settings = { auto: false, nowAt: now - 11 * 60_000 };
    expect(dueNow({ settings, run: { checkedAt: now - 11 * 60_000, finishedAt: now - 3 * HOUR }, now })).toBe(true);
    expect(dueNow({ settings, run: { checkedAt: now - 11 * 60_000, finishedAt: now - 10 * 60_000 }, now })).toBe(false);
    expect(dueNow({ settings: { auto: true }, run: { checkedAt: now - 7 * HOUR }, now })).toBe(true);
  });
});

describe('after the switch', () => {
  /** The state a switch to `version` left, seen by the version that runs now. */
  async function switched(version, previous = 'v-old', at = Date.now()) {
    await db.prepare(`INSERT INTO meta (key, value) VALUES ('update', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(JSON.stringify({ deployed: { version, versionId: 'v-new', previous, from: '1.0.0', at, switched: true }, log: [] })).run();
    cf.versions.push({ id: 'v-new', bindings: cf.versions[0].bindings, secrets: cf.versions[0].secrets, code: 'new' });
    cf.deployments.unshift({ id: 'd-new', versions: [{ version_id: 'v-new', percentage: 100 }] });
  }

  it('the new version confirms itself on its first run', async () => {
    await switched(VERSION);
    await confirmUpdate(env);
    const r = (await loadRun(env)).s;
    expect(r.deployed).toBeNull();
    expect(r.confirmed.version).toBe(VERSION);
  });

  it('a new version whose database update fails goes back to the version before by itself, and is not tried again by the cron', async () => {
    await switched(VERSION);
    expect(await afterSchemaFailure(env, new Error('the database update 0009_x.sql failed'), { fetchImpl })).toBe(true);
    expect(cf.live.id).toBe('v-old');
    expect(cf.deployments[0].message).toMatch(/back to the version before/);
    const r = (await loadRun(env)).s;
    expect(r).toMatchObject({ skip: VERSION, deployed: null, last: { ok: false } });
    expect(r.last.message).toMatch(/went back to 1\.0\.0 by itself: its database update failed/);
    // (an old update, or one without a version to go back to, is left alone)
    await switched(VERSION, 'v-old', Date.now() - 2 * 24 * HOUR);
    expect(await afterSchemaFailure(env, new Error('x'), { fetchImpl })).toBe(false);
  });

  it('switched back by hand (the dashboard): that version waits for Update now', async () => {
    await switched('9.9.9', 'v-old', Date.now() - HOUR);
    await confirmUpdate(env);
    expect((await loadRun(env)).s).toMatchObject({ deployed: null, skip: '9.9.9' });
    publish('9.9.9');
    expect((await run()).last.message).toMatch(/went back by itself the last time/);
    expect((await run({ manual: true })).last.ok).toBe(true);
  });

  it('keeps the bindings the way they are, whatever else the Worker has', () => {
    expect(versionBindings([{ type: 'kv_namespace', name: 'KV', namespace_id: 'x' }, { type: 'secret_text', name: 'S' }, { type: 'd1', name: 'DB', database_id: 'id1' }, { type: 'assets', name: 'ASSETS' }], 'ASSETS'))
      .toEqual([{ type: 'inherit', name: 'KV' }, { type: 'd1', name: 'DB', id: 'id1' }, { type: 'assets', name: 'ASSETS' }]);
  });
});

describe('the routes', () => {
  const call = async (path, { method = 'GET', body, token = OWNER_KEY, e = env } = {}) => {
    const ctx = ctxStub();
    const res = await worker.fetch(new Request(`https://saqme.example${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    }), e, ctx);
    await ctx.done();
    return { status: res.status, data: await res.json() };
  };

  it('need the owner\'s key; status says how it stands without the token', async () => {
    expect((await call('/api/update', { token: null })).status).toBe(401);
    const r = await call('/api/update');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ version: VERSION, api: API_VERSION, knowsItself: true, token: true, auto: true, running: null });
    expect(r.data.tokenUrl).toBe(tokenTemplateUrl(ACCOUNT));
    expect(JSON.stringify(r.data)).not.toContain(TOKEN);
    expect((await call('/api/update/auto', { method: 'POST', body: { on: false } })).data.auto).toBe(false);
    expect((await call('/api/update/token', { method: 'POST', body: { token: 'short' } })).status).toBe(400);
  });

  it('a shared list\'s key gets nothing', async () => {
    // (a share key: made the way the owner's app makes one, then claimed)
    await call('/api/sync', { method: 'POST', body: { deviceId: 'pc', cursor: 0, changes: [{ kind: 'project', id: 'groceri1', fields: { name: { v: 'Groceries', ts: 1000 }, pos: { v: 'a0', ts: 1000 } } }] } });
    const inv = await call('/api/shares/invite', { method: 'POST', body: { projectId: 'groceri1', alias: 'Nuca', access: 'edit' } });
    const claim = await call('/api/shares/claim', { method: 'POST', token: null, body: { code: inv.data.code } });
    for (const [path, method] of [['/api/update', 'GET'], ['/api/update/now', 'POST'], ['/api/update/token', 'POST'], ['/api/update/auto', 'POST']]) {
      expect((await call(path, { method, token: claim.data.token, body: method === 'POST' ? {} : undefined })).status, path).toBe(403);
    }
  });

  it('Update now without a token says what to do', async () => {
    const r = await call('/api/update/now', { method: 'POST', body: {}, e: { ...env, UPDATE_TOKEN: undefined } });
    expect(r).toMatchObject({ status: 409, data: { error: expect.stringMatching(/no update token/) } });
  });

  it('the status of a Worker set up before 1.2.0 says it needs one update from the computer first', async () => {
    const r = await call('/api/update', { e: { DB: db, AUTH_TOKEN: OWNER_KEY } });
    expect(r.data).toMatchObject({ knowsItself: false, token: false });
  });

  it('the status counts its ten-minute wait, and shows the last lines of the log', async () => {
    publish(VERSION);
    const now = Date.now();
    await startNow(env, { waitUntil: () => {} }, { now, fetchImpl });
    const s = await updateStatus(env, { now });
    expect(s.nextNowAt).toBe(now + NOW_EVERY);
  });
});
