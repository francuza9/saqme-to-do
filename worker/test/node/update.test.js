// The app updater on Linux and macOS (local/update.mjs, local/updater.mjs) and the release it installs
// (scripts/build-release.mjs): the release zip and its manifest, downloads only from the repository's GitHub
// releases and only with the manifest's size and checksum, the version folders and the switch between them,
// the user's own Worker deciding whether the apps may switch, the rollback when a new version does not start,
// and the automatic update when the app is idle. Lists are never touched. (Windows: scripts/dev/test-setup.ps1.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease, changelogSection } from '../../../scripts/build-release.mjs';
import {
  applyRelease, assetUrl, checkManifest, cleanVersions, currentVersion, downloadAsset, extractRelease, fetchManifest, installRoot, manifestUrl,
  previousVersion, readZip, releaseInfo, safeEntry, stageVersion, switchVersion, verifyAsset,
} from '../../../local/update.mjs';
import { Updater } from '../../../local/updater.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const { version: VERSION, repo: REPO } = releaseInfo(ROOT);
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'saqme-update-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.SAQME_CLOUD_SETUP_JS; });

/** A release of `version` built from this repository. */
function release(version = '9.9.9') {
  const r = buildRelease({ root: ROOT, out: join(dir, `dist-${version}`), version, published: '2026-10-22T00:00:00.000Z' });
  return { ...r, bytes: readFileSync(r.zip) };
}
/** GitHub's release downloads, from memory; health: what a Worker's /api/health answers (or nothing). */
function github(rel, { manifest = rel.manifest, zip = rel.bytes, health = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (url === manifestUrl(REPO)) return new Response(JSON.stringify(manifest), { status: 200 });
    const m = checkManifest(manifest);
    if (m && url === assetUrl(REPO, m)) return new Response(zip, { status: 200 });
    if (health && String(url).endsWith('/api/health')) return new Response(JSON.stringify(health), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}
/** An install of this repository's version, and a data folder with a list. */
function install() {
  const root = join(dir, 'app');
  const { version } = stageVersion(ROOT, root);
  switchVersion(root, version);
  const data = join(dir, 'data');
  mkdirSync(join(data, 'lists'), { recursive: true });
  writeFileSync(join(data, 'lists', 'Work.md'), '- [ ] keep me ^keep0001\n');
  return { root, data, appDir: join(root, 'versions', version) };
}
const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** update.mjs apply's arguments -> applyRelease's options. */
function applyOpts(args) {
  const o = {};
  for (let i = 2; i < args.length; i += 2) o[args[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = args[i + 1];
  return { ...o, port: Number(o.port), minWorkerApi: Number(o.minWorkerApi) };
}
function updater(inst, gh, extra = {}) {
  const settings = { values: {}, get() { return this.values; }, set(v) { Object.assign(this.values, v); } };
  const applied = [];
  const u = new Updater({
    appDir: inst.appDir, data: inst.data, port: 1, settings, cloudConfig: join(inst.data, 'sync', 'config.json'), cloudState: join(dir, 'cloud.json'),
    fetchImpl: gh.fetchImpl, restartMode: 'none', spawnApply: (args) => applied.push(args), ...extra,
  });
  return { u, applied, settings };
}

describe('the release', () => {
  it('a zip of the app as setup installs it, nothing per user or for development; its manifest checks out', () => {
    const r = release('9.9.9');
    const names = readZip(r.bytes).map((e) => e.name);
    expect(names.every((n) => n.startsWith('saqme-9.9.9/'))).toBe(true);
    for (const f of ['setup.cmd', 'desktop/widget.ps1', 'desktop/update.ps1', 'desktop/update-core.ps1', 'desktop/start-widget.vbs', 'local/update.mjs', 'local/saqme.mjs',
      'scripts/setup.ps1', 'scripts/setup.sh', 'scripts/cloud-setup.mjs', 'worker/src/index.js', 'worker/migrations/0003_remotes.sql', 'worker/public/index.html', 'worker/package-lock.json']) {
      expect(names, f).toContain(`saqme-9.9.9/${f}`);
    }
    expect(names.filter((n) => /\/tests?\/|node_modules|\/wrangler\.toml$|\.dev\.vars|scripts\/dev\/|desktop\/cache/.test(n))).toEqual([]);
    const pkg = JSON.parse(readZip(r.bytes).find((e) => e.name === 'saqme-9.9.9/worker/package.json').data.toString('utf8'));
    expect(pkg.version).toBe('9.9.9');
    const m = checkManifest(r.manifest);
    expect(m).toMatchObject({ version: '9.9.9', tag: 'v9.9.9', asset: 'saqme-9.9.9.zip', size: r.bytes.length });
    expect(m.sha256).toBe(createHash('sha256').update(r.bytes).digest('hex'));
    const bundleSum = createHash('sha256').update(readFileSync(r.bundle)).digest('hex');
    expect(readFileSync(join(dir, 'dist-9.9.9', 'SHA256SUMS'), 'utf8')).toBe(`${m.sha256}  saqme-9.9.9.zip\n${bundleSum}  saqme-worker-9.9.9.bundle\n`);
    // the Worker's bundle (worker/test/node/self-update.test.js has the rest); the apps' updaters leave it alone
    expect(r.manifest.worker).toMatchObject({ asset: 'saqme-worker-9.9.9.bundle', size: readFileSync(r.bundle).length, sha256: bundleSum });
    expect(release('9.9.9').manifest.asset.sha256).toBe(m.sha256);   // the same files, the same zip
  });

  it('takes its notes from that version\'s section of the changelog', () => {
    const text = '# Changes\n\n## 1.2.0\n\n- New thing\n- Fix\n\n## 1.1.0\n\n- Old\n';
    expect(changelogSection(text, '1.2.0')).toBe('- New thing\n- Fix');
    expect(changelogSection(text, '1.1.0')).toBe('- Old');
    expect(changelogSection(text, '1.3.0')).toBe('');
  });
});

describe('downloads', () => {
  it('come from the repository\'s releases only, with the manifest\'s size and checksum', async () => {
    const rel = release('9.9.9');
    const gh = github(rel, { manifest: { ...rel.manifest, url: 'https://evil.example/x.zip' } });
    const m = await fetchManifest({ repo: REPO, fetchImpl: gh.fetchImpl });
    expect(m.version).toBe('9.9.9');
    const bytes = await downloadAsset(m, { repo: REPO, fetchImpl: gh.fetchImpl });
    expect(bytes.length).toBe(m.size);
    expect(gh.calls).toEqual([`https://github.com/${REPO}/releases/latest/download/saqme-release.json`, `https://github.com/${REPO}/releases/download/v9.9.9/saqme-9.9.9.zip`]);
    const flipped = Buffer.from(rel.bytes); flipped[100] ^= 1;
    expect(() => verifyAsset(flipped, m)).toThrow(/checksum/);
    expect(() => verifyAsset(rel.bytes.subarray(1), m)).toThrow(/bytes/);
    await expect(downloadAsset(m, { repo: REPO, fetchImpl: github(rel, { zip: flipped }).fetchImpl })).rejects.toThrow(/checksum/);
  });

  it('no release yet: nothing to do; a bad manifest: a plain error', async () => {
    expect(await fetchManifest({ repo: REPO, fetchImpl: async () => new Response('', { status: 404 }) })).toBeNull();
    await expect(fetchManifest({ repo: REPO, fetchImpl: async () => new Response('{"version":"1.0"}', { status: 200 }) })).rejects.toThrow(/no valid manifest/);
    await expect(fetchManifest({ repo: REPO, fetchImpl: async () => { throw new TypeError('fetch failed'); } })).rejects.toThrow(/Could not reach GitHub/);
  });

  it('unpacks only into its own folder', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\\b', 'C:/x', 'a//b', '']) expect(safeEntry(bad), bad).toBe(false);
    expect(safeEntry('saqme-1.0.0/local/saqme.mjs')).toBe(true);
    const rel = release('9.9.9');
    const tree = extractRelease(rel.bytes, join(dir, 'x'), '9.9.9');
    expect(releaseInfo(tree).version).toBe('9.9.9');
    expect(() => extractRelease(rel.bytes, join(dir, 'y'), '9.9.8')).toThrow(/unexpected file/);
  });
});

describe('the install', () => {
  it('one folder per version; switching keeps the one before; old ones go', () => {
    const inst = install();
    expect(installRoot(inst.appDir)).toBe(inst.root);
    expect(installRoot(ROOT)).toBeNull();   // a clone does not update itself
    expect(currentVersion(inst.root)).toBe(VERSION);
    for (const v of ['9.9.9', '9.9.10']) {
      const tree = extractRelease(release(v).bytes, join(dir, `src-${v}`), v);
      stageVersion(tree, inst.root);
      switchVersion(inst.root, v);
      cleanVersions(inst.root);
    }
    expect(currentVersion(inst.root)).toBe('9.9.10');
    expect(previousVersion(inst.root)).toBe('9.9.9');
    expect(existsSync(join(inst.root, 'versions', VERSION))).toBe(false);
    expect(existsSync(join(inst.root, 'versions', '9.9.9', 'local', 'saqme.mjs'))).toBe(true);
    expect(() => switchVersion(inst.root, '7.7.7')).toThrow(/not installed/);
  });
});

describe('an update', () => {
  it('checks, downloads, installs and switches; the new version passes its self-check; the lists stay as they are', async () => {
    const inst = install();
    const before = hashOf(join(inst.data, 'lists', 'Work.md'));
    const rel = release('9.9.9');
    const { u, applied } = updater(inst, github(rel));
    expect((await u.check()).available).toBe(true);
    await u.start();
    expect(applied).toHaveLength(1);
    const r = await applyRelease({ ...applyOpts(applied[0]), restart: 'none' });
    expect(r).toMatchObject({ ok: true, version: '9.9.9', from: VERSION, worker: 'none' });
    expect(currentVersion(inst.root)).toBe('9.9.9');
    expect(previousVersion(inst.root)).toBe(VERSION);
    expect(JSON.parse(readFileSync(join(inst.root, 'update', 'result.json'), 'utf8'))).toMatchObject({ ok: true, version: '9.9.9' });
    expect(hashOf(join(inst.data, 'lists', 'Work.md'))).toBe(before);
  }, 60_000);

  it('a download that does not match the release changes nothing', async () => {
    const inst = install();
    const rel = release('9.9.9');
    const flipped = Buffer.from(rel.bytes); flipped[200] ^= 1;
    const { u, applied } = updater(inst, github(rel, { zip: flipped }));
    const s = await u.start({ manual: true });
    expect(applied).toEqual([]);
    expect(s.error).toMatch(/checksum/);
    expect(u.result()).toMatchObject({ ok: false, version: '9.9.9', message: expect.stringMatching(/did not install/) });
    expect(currentVersion(inst.root)).toBe(VERSION);
    expect(existsSync(join(inst.root, 'versions', '9.9.9'))).toBe(false);
  });

  describe('with sync of one\'s own: the Worker first', () => {
    function signedOut() {
      const stub = join(dir, 'cloud-setup-stub.mjs');
      writeFileSync(stub, "import { writeFileSync } from 'node:fs';\nconst i = process.argv.indexOf('--result');\nwriteFileSync(process.argv[i + 1], JSON.stringify({ ok: false, needsLogin: true, message: 'Sign in to Cloudflare to finish the update.' }));\nprocess.exit(1);\n");
      process.env.SAQME_CLOUD_SETUP_JS = stub;
    }
    async function prepared(minWorkerApi, health) {
      const inst = install();
      mkdirSync(join(inst.data, 'sync'), { recursive: true });
      writeFileSync(join(inst.data, 'sync', 'config.json'), JSON.stringify({ url: 'https://saqme.me.workers.dev', token: 'k'.repeat(43), enabled: true }));
      const rel = release('9.9.9');
      const gh = github(rel, { health });
      const tree = extractRelease(rel.bytes, join(dir, 'src'), '9.9.9');
      const opts = { source: tree, root: inst.root, data: inst.data, port: 1, minWorkerApi, restart: 'none', selftest: false, cloudState: join(dir, 'cloud.json'), result: join(inst.root, 'update', 'result.json'), fetchImpl: gh.fetchImpl };
      return { inst, opts };
    }

    it('it cannot be updated (signed out), and the new apps need a newer one: the whole update waits', async () => {
      signedOut();
      const { inst, opts } = await prepared(2, null);
      const r = await applyRelease(opts);
      expect(r).toMatchObject({ ok: false, held: true, needsLogin: true, message: expect.stringMatching(/Sign in to Cloudflare to finish the update to 9\.9\.9/) });
      expect(currentVersion(inst.root)).toBe(VERSION);
    });

    it('it cannot be updated, but the new apps work with the one it runs: they update, the Worker is tried again', async () => {
      signedOut();
      const { inst, opts } = await prepared(1, { ok: true, version: VERSION, api: 3 });
      const r = await applyRelease(opts);
      expect(r).toMatchObject({ ok: true, worker: 'pending', needsLogin: true });
      expect(currentVersion(inst.root)).toBe('9.9.9');
      expect(existsSync(join(inst.root, 'cloud', 'scripts', 'cloud-setup.mjs'))).toBe(true);   // (its deploy folder, kept for the retry)
    });

    it('another computer updated it already: nothing to deploy', async () => {
      process.env.SAQME_CLOUD_SETUP_JS = join(dir, 'never-run.mjs');
      const { inst, opts } = await prepared(3, { ok: true, version: '9.9.9', api: 3 });
      const r = await applyRelease(opts);
      expect(r).toMatchObject({ ok: true, worker: 'ok' });
      expect(currentVersion(inst.root)).toBe('9.9.9');
    });
  });

  it('a new version that does not start: back to the one before, which is started again', async () => {
    const inst = install();
    const launcher = join(dir, 'launcher.sh');
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n');
    chmodSync(launcher, 0o755);
    const tree = extractRelease(release('9.9.9').bytes, join(dir, 'src'), '9.9.9');
    const r = await applyRelease({ source: tree, root: inst.root, data: inst.data, port: 1, restart: 'spawn', launcher, selftest: false, worker: false, startTimeoutMs: 800, result: join(inst.root, 'update', 'result.json') });
    expect(r).toMatchObject({ ok: false, version: '9.9.9', from: VERSION, message: expect.stringMatching(/did not start/) });
    expect(currentVersion(inst.root)).toBe(VERSION);
    expect(previousVersion(inst.root)).not.toBe('9.9.9');   // (the broken one is not what "back" means later)
  }, 20_000);

  it('by itself only when the app has been idle a while, and not again right after a failure', async () => {
    const inst = install();
    let t = 1_000_000;
    const rel = release('9.9.9');
    const { u, applied, settings } = updater(inst, github(rel), { now: () => t });
    await u.check();
    u.touch();
    t += 60_000;
    await u.tick();
    expect(applied).toHaveLength(0);   // in use a minute ago
    settings.set({ autoUpdate: false });
    t += 3600_000;
    await u.tick();
    expect(applied).toHaveLength(0);   // switched off
    settings.set({ autoUpdate: true });
    writeFileSync(join(inst.root, 'update', 'result.json'), JSON.stringify({ ok: false, version: '9.9.9', at: t - 60_000 }));
    await u.tick();
    expect(applied).toHaveLength(0);   // it failed an hour ago: later
    t += 13 * 3600_000;
    await u.tick();
    expect(applied).toHaveLength(1);
  });
});
