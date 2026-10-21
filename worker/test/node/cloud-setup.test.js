// scripts/cloud-setup.mjs end to end against a fake wrangler (no Cloudflare involved).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(root, 'scripts', 'cloud-setup.mjs');
const fake = join(root, 'worker', 'test', 'setup', 'fake-wrangler.mjs');

function setupDirs() {
  const dir = mkdtempSync(join(tmpdir(), 'saqme-setup-test-'));
  const worker = join(dir, 'worker');
  spawnSync('mkdir', ['-p', worker]);
  copyFileSync(join(root, 'worker', 'wrangler.toml.template'), join(worker, 'wrangler.toml.template'));
  copyFileSync(join(root, 'worker', 'package.json'), join(worker, 'package.json'));   // (the version an update deploys)
  return { dir, worker, state: join(dir, 'cloud.json'), desktop: join(dir, 'data', 'sync', 'config.json'), fakeState: join(dir, 'fake.json') };
}
function runSetup(d, extra = [], fakeInit) {
  if (fakeInit) writeFileSync(d.fakeState, JSON.stringify({ loggedIn: false, dbs: [], deploys: [], subdomain: true, calls: [], ...fakeInit }));
  // setup as run on someone's own computer: a CI=true from the test runner would reach the wrangler setup runs
  // interactively, and wrangler (the fake too) never asks anything under CI
  const r = spawnSync(process.execPath, [script, '--state', d.state, '--desktop-config', d.desktop, '--worker-dir', d.worker, '--skip-install', '--yes', ...extra], {
    encoding: 'utf8', env: setupEnv(d),
  });
  return { ...r, fakeState: JSON.parse(readFileSync(d.fakeState, 'utf8')) };
}
function setupEnv(d, extra = {}) {
  const env = { ...process.env, SAQME_WRANGLER_JS: fake, FAKE_WRANGLER_STATE: d.fakeState, SAQME_VERIFY_ATTEMPTS: '1', SAQME_HEALTH_TIMEOUT_MS: '1500', NO_COLOR: '1', ...extra };
  delete env.CI;
  delete env.SAQME_UPDATE_TOKEN;
  return { ...env, ...extra };
}
/** The same, while this process answers as the Worker (a stand-in on 127.0.0.1): it must not block on the setup. */
function runSetupAsync(d, extra = [], env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, '--state', d.state, '--desktop-config', d.desktop, '--worker-dir', d.worker, '--skip-install', '--yes', ...extra], { env: setupEnv(d, env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolveRun({ status, stdout, stderr, fakeState: JSON.parse(readFileSync(d.fakeState, 'utf8')) }));
  });
}
/** A Worker on 127.0.0.1 that says it runs `version`; it records what it was asked. */
async function standInWorker(version, { token = 'k'.repeat(43), selfUpdate = { knowsItself: true, token: false, tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens?x' } } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      const owner = req.headers.authorization === `Bearer ${token}`;
      if (req.url === '/api/health') return send(200, { ok: true, version, api: 4 });
      if (!owner) return send(401, { error: 'unauthorized' });
      if (req.url === '/api/config') return send(200, { version, api: 4 });
      if (req.url === '/api/update' && req.method === 'GET') return send(200, selfUpdate);
      if (req.url === '/api/update/token') return JSON.parse(body).token === 'good-token-0123456789abcdef' ? send(200, { ...selfUpdate, token: true }) : send(400, { error: 'Cloudflare does not know this token.' });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

describe('cloud setup', () => {
  let d;
  let first;
  beforeAll(() => {
    d = setupDirs();
    first = runSetup(d, [], {});
  });

  it('logs in, creates the database, writes the config and deploys code + secrets together', () => {
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.fakeState.calls).toContain('login');
    expect(first.fakeState.dbs).toEqual([{ name: 'saqme', uuid: 'uuid-1-0000-0000-000000000000' }]);
    const toml = readFileSync(join(d.worker, 'wrangler.toml'), 'utf8');
    expect(toml).toMatch(/name = "saqme"/);
    expect(toml).toMatch(/database_id = "uuid-1-0000-0000-000000000000"/);
    expect(toml).toMatch(/account_id = "0123456789abcdef0123456789abcdef"/);
    const st = json(d.state);
    expect(st.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(st.url).toBe('https://saqme.my-sub.workers.dev');
    expect(first.fakeState.deploys[0].secrets).toEqual({ AUTH_TOKEN: st.token, VAPID_PUBLIC_KEY: st.vapidPublicKey, VAPID_PRIVATE_KEY: st.vapidPrivateKey });
    const cfg = json(d.desktop);
    expect(cfg).toMatchObject({ url: st.url, token: st.token, enabled: true });
    expect(cfg.deviceId).toMatch(/^pc-/);
    expect(first.stdout).toContain(`${st.url}/#pair=${st.token}`);
    expect(first.stdout).toMatch(/[█▀▄]/);   // the terminal QR code
    // the Worker makes its own tables (worker/src/schema.js): no wrangler migrations any more
    expect(first.fakeState.calls.some((c) => c.startsWith('d1 migrations'))).toBe(false);
  });

  it('is idempotent: second run reuses database, token, keys and device id, and deploys code only', () => {
    const before = json(d.state);
    const deviceId = json(d.desktop).deviceId;
    const again = runSetup(d);
    expect(again.status).toBe(0);
    expect(again.fakeState.calls.filter((c) => c.startsWith('d1 create'))).toHaveLength(1);
    expect(again.fakeState.calls.filter((c) => c === 'login')).toHaveLength(1);
    expect(again.stdout).toMatch(/already exists - reusing/);
    const after = json(d.state);
    expect(after.token).toBe(before.token);
    expect(after.vapidPrivateKey).toBe(before.vapidPrivateKey);
    expect(json(d.desktop).deviceId).toBe(deviceId);
    expect(again.fakeState.deploys.at(-1).secrets).toBeNull();   // the Worker keeps the keys it has
    expect(again.stdout).toMatch(/keys on your Worker stay as they are/);
  });

  it('--rotate-token revokes the old key: new token and push keys everywhere, old subscriptions gone', () => {
    const before = json(d.state);
    const r = runSetup(d, ['--rotate-token']);
    expect(r.status).toBe(0);
    const after = json(d.state);
    expect(after.token).not.toBe(before.token);
    expect(after.vapidPrivateKey).not.toBe(before.vapidPrivateKey);
    expect(json(d.desktop).token).toBe(after.token);
    expect(r.fakeState.deploys.at(-1).secrets).toEqual({ AUTH_TOKEN: after.token, VAPID_PUBLIC_KEY: after.vapidPublicKey, VAPID_PRIVATE_KEY: after.vapidPrivateKey });
    expect(r.fakeState.executed).toEqual(['DELETE FROM push_subscriptions']);
    expect(r.stdout).toMatch(/old key is revoked/);
    expect(r.stdout).toMatch(/Pair your phone .* again/);
  });

  it('--result tells the apps how it ended', () => {
    const ok = runSetup(d, ['--result', join(d.dir, 'result-ok.json')]);
    expect(ok.status).toBe(0);
    expect(json(join(d.dir, 'result-ok.json'))).toEqual({ ok: true, url: 'https://saqme.my-sub.workers.dev' });
    const d6 = setupDirs();
    writeFileSync(join(d6.worker, 'wrangler.toml.template'), 'name = "__WORKER_NAME__"\n');   // deploy will refuse this
    const bad = runSetup(d6, ['--result', join(d6.dir, 'result.json')], { loggedIn: true });
    expect(bad.status).toBe(1);
    expect(json(join(d6.dir, 'result.json'))).toMatchObject({ ok: false, message: 'Deploying the Worker failed.' });
  });

  it('walks the user through registering a workers.dev subdomain', () => {
    const d2 = setupDirs();
    const r = runSetup(d2, [], { loggedIn: true, subdomain: false });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/needs a free workers\.dev subdomain/);
    expect(r.fakeState.deploys.some((x) => x.interactive)).toBe(true);
    expect(json(d2.state).url).toBe('https://saqme.my-sub.workers.dev');
  });

  it('--device-login says what to do with the code, and shows the address and the code where they stand out', () => {
    const dd = setupDirs();
    const r = runSetup(dd, ['--device-login'], {});
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.fakeState.calls).toContain('login --device');
    expect(r.stdout).not.toMatch(/a browser window opens/);
    expect(r.stdout).toMatch(/Open the address on any device/);
    expect(r.stdout).toMatch(/^ {6}Open {3}https:\/\/dash\.cloudflare\.com\/oauth2\/device$/m);
    expect(r.stdout).toMatch(/^ {6}Code {3}WXYZ-2345$/m);
  });

  it('asks which account to use when there are several (and remembers it)', () => {
    const d3 = setupDirs();
    const accounts = [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Work' }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Personal' }];
    const r = runSetup(d3, [], { loggedIn: true, accounts });
    expect(r.status).toBe(0);
    expect(json(d3.state).accountId).toBe(accounts[0].id);   // --yes picks the first
    expect(r.stdout).toMatch(/Several Cloudflare accounts/);
    expect(r.stdout).toMatch(/account: Work \(a{32}\)/);   // always says which one it used
  });

  it('refuses to replace the token of a setup made on another computer', () => {
    const d5 = setupDirs();
    // the database exists already, but this machine has no saved state (no token)
    const r = runSetup(d5, [], { loggedIn: true, dbs: [{ name: 'saqme', uuid: 'uuid-9-0000-0000-000000000000' }] });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already set up in this Cloudflare account/);
    expect(r.stderr).toMatch(/Pair phone > Copy link/);
    expect(r.fakeState.deploys).toHaveLength(0);
    // deliberately starting over works
    const again = runSetup(d5, ['--rotate-token']);
    expect(again.status).toBe(0);
    expect(json(d5.state).databaseId).toBe('uuid-9-0000-0000-000000000000');
  });

  it('a setup made on another computer, with this computer\'s app already paired: its key is reused, the Worker\'s keys stay', () => {
    const d7 = setupDirs();
    const key = 'k'.repeat(43);
    spawnSync('mkdir', ['-p', join(d7.dir, 'data', 'sync')]);
    writeFileSync(d7.desktop, JSON.stringify({ url: 'https://saqme.my-sub.workers.dev', token: key, deviceId: 'pc-kept', enabled: true }));
    const r = runSetup(d7, [], { loggedIn: true, dbs: [{ name: 'saqme', uuid: 'uuid-7-0000-0000-000000000000' }], worker: { secrets: ['AUTH_TOKEN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/reusing the access key this computer's app already syncs with/);
    expect(r.fakeState.deploys).toEqual([{ secrets: null, interactive: false }]);   // code only: the push keys could not be read back
    expect(json(d7.state).token).toBe(key);
    expect(json(d7.state).vapidPrivateKey).toBeUndefined();
    expect(json(d7.desktop)).toMatchObject({ token: key, deviceId: 'pc-kept' });
  });

  describe('--update (the apps\' updater)', () => {
    let u;
    beforeAll(() => {
      u = setupDirs();
      expect(runSetup(u, [], {}).status).toBe(0);   // a first setup on this computer
    });

    it('deploys the code and phone app only: no keys, no new database, no migrations, no questions', () => {
      const before = runSetup(u).fakeState.calls.length;   // (a second setup, so the fake has a Worker with keys)
      const r = runSetup(u, ['--update', '--result', join(u.dir, 'update.json')]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const calls = r.fakeState.calls.slice(before);
      expect(calls).not.toContain('login');
      expect(calls.some((c) => c.startsWith('d1 create') || c.startsWith('d1 migrations'))).toBe(false);
      expect(r.fakeState.deploys.at(-1)).toEqual({ secrets: null, interactive: false });
      expect(json(join(u.dir, 'update.json'))).toMatchObject({ ok: true, url: 'https://saqme.my-sub.workers.dev', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    });

    it('signed out: says so (needsLogin) and changes nothing; --login-only signs in', () => {
      const fake = JSON.parse(readFileSync(u.fakeState, 'utf8'));
      writeFileSync(u.fakeState, JSON.stringify({ ...fake, loggedIn: false }));
      const deploys = fake.deploys.length;
      const r = runSetup(u, ['--update', '--result', join(u.dir, 'out.json')]);
      expect(r.status).toBe(1);
      expect(json(join(u.dir, 'out.json'))).toMatchObject({ ok: false, needsLogin: true, message: 'Sign in to Cloudflare to finish the update.' });
      expect(r.fakeState.deploys).toHaveLength(deploys);
      expect(r.fakeState.calls.at(-1)).toBe('whoami --json');   // and no login started by itself
      const l = runSetup(u, ['--login-only', '--result', join(u.dir, 'login.json')]);
      expect(l.status, l.stdout + l.stderr).toBe(0);
      expect(l.fakeState.calls).toContain('login');
      expect(json(join(u.dir, 'login.json'))).toEqual({ ok: true });
    });

    it('a computer without setup state (connected with a pairing link) finds the Worker from its address', () => {
      const v = setupDirs();
      spawnSync('mkdir', ['-p', join(v.dir, 'data', 'sync')]);
      writeFileSync(v.desktop, JSON.stringify({ url: 'https://notes.my-sub.workers.dev', token: 'k'.repeat(43), enabled: true }));
      const accounts = [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Work' }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Personal' }];
      const r = runSetup(v, ['--update'], { loggedIn: true, accounts, dbs: [{ name: 'notes', uuid: 'uuid-3-0000-0000-000000000000' }], worker: { secrets: ['AUTH_TOKEN'] } });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const toml = readFileSync(join(v.worker, 'wrangler.toml'), 'utf8');
      expect(toml).toMatch(/name = "notes"/);
      expect(toml).toMatch(/database_id = "uuid-3-0000-0000-000000000000"/);
      expect(json(v.state)).toMatchObject({ workerName: 'notes', databaseName: 'notes' });
    });

    it('refuses what an update must not do: make a database, or deploy to a Worker without keys', () => {
      const w = setupDirs();
      const noDb = runSetup(w, ['--update', '--result', join(w.dir, 'r1.json')], { loggedIn: true, dbs: [] });
      expect(noDb.status).toBe(1);
      expect(json(join(w.dir, 'r1.json')).message).toMatch(/no Saqme database/);
      expect(noDb.fakeState.calls.some((c) => c.startsWith('d1 create'))).toBe(false);
      const noKeys = runSetup(w, ['--update', '--result', join(w.dir, 'r2.json')], { loggedIn: true, dbs: [{ name: 'saqme', uuid: 'uuid-1-0000-0000-000000000000' }], worker: { secrets: [] } });
      expect(noKeys.status).toBe(1);
      expect(json(join(w.dir, 'r2.json')).message).toMatch(/no access key/);
      expect(noKeys.fakeState.deploys).toHaveLength(0);
      const noWorker = runSetup(w, ['--update', '--result', join(w.dir, 'r3.json')], { loggedIn: true, dbs: [{ name: 'saqme', uuid: 'uuid-1-0000-0000-000000000000' }] });
      expect(noWorker.status).toBe(1);
      expect(json(join(w.dir, 'r3.json')).message).toMatch(/no sync service called "saqme"/);
      expect(noWorker.fakeState.deploys).toHaveLength(0);
    });
  });

  describe('a Worker that updated itself (it runs a newer release than this copy)', () => {
    let w;
    let worker;
    beforeAll(async () => {
      w = setupDirs();
      expect(runSetup(w, [], {}).status).toBe(0);
      worker = await standInWorker('99.0.0', { token: json(w.state).token });
      writeFileSync(w.state, JSON.stringify({ ...json(w.state), url: worker.url }));
    });
    afterAll(() => worker.close());

    it('keeps its code: setup run again from this copy does not deploy over it', async () => {
      const deploys = json(w.fakeState).deploys.length;
      const r = await runSetupAsync(w);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/runs 99\.0\.0, newer than this copy .*: its code stays as it is/);
      expect(r.fakeState.deploys).toHaveLength(deploys);
      // (and where updating itself is set up, since this one has no token yet: under --yes it only says so)
      expect(r.stdout).toMatch(/can also update itself, even when this computer is off: Settings > Updates/);
    });

    it('the apps\' updater leaves it as it is too', async () => {
      const deploys = json(w.fakeState).deploys.length;
      const r = await runSetupAsync(w, ['--update', '--result', join(w.dir, 'upd.json')]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.fakeState.deploys).toHaveLength(deploys);
      expect(json(join(w.dir, 'upd.json'))).toMatchObject({ ok: true, version: '99.0.0' });
    });

    it('a token for updating itself goes to the Worker, which checks it; one it refuses is said so', async () => {
      let r = await runSetupAsync(w, [], { SAQME_UPDATE_TOKEN: 'good-token-0123456789abcdef' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const post = worker.seen.filter((s) => s.path === '/api/update/token').at(-1);
      expect(JSON.parse(post.body)).toEqual({ token: 'good-token-0123456789abcdef' });
      expect(post.auth).toBe(`Bearer ${json(w.state).token}`);
      expect(r.stdout).toMatch(/updates itself from now on/);
      expect(json(w.state)).not.toHaveProperty('updateToken');   // (kept by the Worker only)
      expect(readFileSync(w.state, 'utf8')).not.toContain('good-token');
      r = await runSetupAsync(w, [], { SAQME_UPDATE_TOKEN: 'bad-token-0123456789abcdef0' });
      expect(r.stdout).toMatch(/The token was not taken: Cloudflare does not know this token/);
    });

    it('new keys go up on their own (a rotation): still no deploy of the older code', async () => {
      const deploys = json(w.fakeState).deploys.length;
      const r = await runSetupAsync(w, ['--rotate-token']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.fakeState.deploys).toHaveLength(deploys);
      expect(r.fakeState.bulk.at(-1).AUTH_TOKEN).toBe(json(w.state).token);
    });
  });

  it('stops with a clear next step when something fails', () => {
    const d4 = setupDirs();
    writeFileSync(join(d4.worker, 'wrangler.toml.template'), 'name = "__WORKER_NAME__"\n');   // deploy will refuse this
    const r = runSetup(d4, [], { loggedIn: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Setup stopped: Deploying the Worker failed/);
    expect(r.stderr).toMatch(/Re-running setup is safe/);
    expect(existsSync(d4.state)).toBe(true);   // keys were saved before deploying
    expect(json(d4.state).token).toBeTruthy();
  });
});
