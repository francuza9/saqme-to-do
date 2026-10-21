// scripts/setup.sh's Node.js: which build it downloads where none is installed (the official one; Node.js 22 on
// macOS 11-13.4; the glibc-2.17 build on older x64 Linux), checked against its checksums, and where it stops with
// advice instead. Runs the real setup.sh in a temp HOME, with fake ldd / uname / sw_vers and Node.js "downloads"
// from file:// mirrors whose node is a stand-in for the one running this test. On WSL, setup without options
// points at the Windows app and installs nothing. (Real old systems in Docker: scripts/dev/test-setup-linux.sh.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'worker', 'package.json'), 'utf8')).version;
const linux = process.platform === 'linux';
// tools setup.sh must not reach from a test: the real Node.js (it would be used instead of a download), the
// user's own services and desktop (systemctl --user stop would stop their running Saqme), and WSL's
const HIDDEN = new Set(['node', 'nodejs', 'npm', 'npx', 'corepack', 'ldd', 'uname', 'sw_vers', 'wslpath', 'cmd.exe', 'powershell.exe',
  'systemctl', 'launchctl', 'xdg-mime', 'xdg-open', 'update-desktop-database', 'notify-send', 'osacompile', 'codesign']);

let dir, bin, mirrors;
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A Node.js release folder: <root>/<ver>/{SHASUMS256.txt, node-<ver>-<build>.tar.gz} whose bin/node runs this Node.js. */
function nodeRelease(root, ver, build, { badSum = false } = {}) {
  const name = `node-${ver}-${build}`;
  const work = mkdtempSync(join(dir, 'pack-'));
  mkdirSync(join(work, name, 'bin'), { recursive: true });
  writeFileSync(join(work, name, 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(work, name, 'bin', 'node'), 0o755);
  const out = join(root, ver);
  mkdirSync(out, { recursive: true });
  const tar = spawnSync('tar', ['-czf', join(out, `${name}.tar.gz`), '-C', work, name]);
  if (tar.status !== 0) throw new Error(String(tar.stderr));
  const sum = badSum ? '0'.repeat(64) : sha(readFileSync(join(out, `${name}.tar.gz`)));
  writeFileSync(join(out, 'SHASUMS256.txt'), `${'1'.repeat(64)}  node-${ver}-headers.tar.gz\n${sum}  ${name}.tar.gz\n`);
  return out;
}
/** nodejs.org's latest-vNN.x/SHASUMS256.txt for ver (only the file name is read from it). */
function latest(root, major, ver, build) {
  mkdirSync(join(root, `latest-v${major}.x`), { recursive: true });
  writeFileSync(join(root, `latest-v${major}.x`, 'SHASUMS256.txt'), `${'2'.repeat(64)}  node-${ver}-${build}.tar.gz\n`);
}
/** index.json as nodejs.org writes it: one release per line, newest first. */
function index(root, releases) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.json'), `[\n${releases.map(([version, files]) => JSON.stringify({ version, date: '2026-10-01', files, lts: false, security: false })).join(',\n')}\n]\n`);
}

beforeAll(() => {
  if (!linux) return;
  dir = mkdtempSync(join(tmpdir(), 'saqme-setup-node-'));
  // PATH: everything in /usr/bin and /bin but HIDDEN, plus the fakes
  bin = join(dir, 'bin');
  mkdirSync(bin);
  const linked = new Set();
  for (const d of ['/usr/bin', '/bin']) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) if (!HIDDEN.has(n) && !linked.has(n)) { linked.add(n); symlinkSync(join(d, n), join(bin, n)); }
  }
  const realUname = existsSync('/usr/bin/uname') ? '/usr/bin/uname' : '/bin/uname';
  const fake = (n, body) => { writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, n), 0o755); };
  fake('ldd', 'echo "ldd (GNU libc) $FAKE_GLIBC"');
  fake('uname', `case "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; *) exec ${realUname} "$@" ;; esac`);
  fake('sw_vers', 'echo "$FAKE_MACOS"');

  mirrors = { official: join(dir, 'official'), old: join(dir, 'glibc217'), old22: join(dir, 'glibc217-22only'), bad: join(dir, 'glibc217-bad') };
  latest(mirrors.official, 24, 'v24.98.0', 'linux-x64');
  nodeRelease(mirrors.official, 'v24.98.0', 'linux-x64');
  latest(mirrors.official, 22, 'v22.98.0', 'darwin-x64');
  nodeRelease(mirrors.official, 'v22.98.0', 'darwin-x64');
  // the newest release with a glibc-2.17 build: v25 is not a major setup asks for, v24.99.2 has no such build
  index(mirrors.old, [['v25.0.0', ['linux-x64-glibc-217']], ['v24.99.2', ['headers', 'linux-x64-musl']], ['v24.99.1', ['headers', 'linux-x64-glibc-217', 'linux-x64-musl']], ['v22.99.0', ['linux-x64-glibc-217']]]);
  nodeRelease(mirrors.old, 'v24.99.1', 'linux-x64-glibc-217');
  index(mirrors.old22, [['v24.99.2', ['linux-x64-musl']], ['v22.99.0', ['headers', 'linux-x64-glibc-217']], ['v22.98.0', ['linux-x64-glibc-217']]]);
  nodeRelease(mirrors.old22, 'v22.99.0', 'linux-x64-glibc-217');
  index(mirrors.bad, [['v24.99.1', ['linux-x64-glibc-217']]]);
  nodeRelease(mirrors.bad, 'v24.99.1', 'linux-x64-glibc-217', { badSum: true });
}, 60_000);
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** Runs setup.sh from this repository in a fresh HOME -> { status, out, home }. */
function setup({ os = 'Linux', arch = 'x86_64', glibc = '2.35', macos = '15.1', old = mirrors.old, official = mirrors.official, env = {}, args = ['--no-start', '--no-autostart'] } = {}) {
  const home = mkdtempSync(join(dir, 'home-'));
  const r = spawnSync('bash', [join(ROOT, 'scripts', 'setup.sh'), ...args], {
    cwd: home, encoding: 'utf8', timeout: 90_000,
    env: {
      PATH: bin, HOME: home, LANG: 'C.UTF-8', NO_COLOR: '1', TMPDIR: dir,
      FAKE_OS: os, FAKE_ARCH: arch, FAKE_GLIBC: glibc, FAKE_MACOS: macos,
      SAQME_NODE_DIST: `file://${official}`, SAQME_NODE_DIST_GLIBC217: `file://${old}`, ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, home };
}
const launcher = (home) => join(home, '.local', 'bin', 'saqme');
const launcherNode = (home) => /^exec "([^"]+)"/m.exec(readFileSync(launcher(home), 'utf8'))?.[1];
const runLauncher = (home, ...args) => spawnSync(launcher(home), args, { encoding: 'utf8', env: { PATH: bin, HOME: home } });

describe.skipIf(!linux)('setup.sh: Node.js for the app', () => {
  it('x64 Linux with glibc 2.17: the newest Node.js 24 glibc-2.17 build, and the app runs on it', () => {
    const r = setup({ glibc: '2.17' });
    expect(r.out).toContain('downloading Node.js v24.99.1 for older Linux systems (glibc 2.17');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('Saqme To Do is ready.');
    expect(launcherNode(r.home)).toBe(join(r.home, '.local', 'lib', 'saqme', 'node', 'bin', 'node'));
    expect(runLauncher(r.home, 'version').stdout.trim()).toBe(VERSION);
    // run again: the Node.js it downloaded is used, not downloaded again
    const again = spawnSync('bash', [join(ROOT, 'scripts', 'setup.sh'), '--no-start', '--no-autostart'], { encoding: 'utf8', env: { PATH: bin, HOME: r.home, NO_COLOR: '1', TMPDIR: dir, FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64', FAKE_GLIBC: '2.17', SAQME_NODE_DIST_GLIBC217: 'file:///nonexistent' } });
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain('downloading Node.js');
  }, 120_000);

  it('glibc 2.27 (Ubuntu 18.04) where there is no Node.js 24 build for it: Node.js 22', () => {
    const r = setup({ glibc: '2.27', old: mirrors.old22 });
    expect(r.out).toContain('downloading Node.js v22.99.0 for older Linux systems (glibc 2.27');
    expect(r.status, r.out).toBe(0);
    expect(existsSync(launcher(r.home))).toBe(true);
  }, 120_000);

  it('glibc 2.28 and newer: the official build', () => {
    const r = setup({ glibc: '2.28' });
    expect(r.out).toContain('downloading Node.js v24.98.0 for linux-x64');
    expect(r.status, r.out).toBe(0);
  }, 120_000);

  it('macOS 11-13.4: the official Node.js 22', () => {
    const r = setup({ os: 'Darwin', macos: '12.7.6' });
    expect(r.out).toContain('downloading Node.js v22.98.0 for darwin-x64');
    expect(r.status, r.out).toBe(0);
    expect(launcherNode(r.home)).toBe(join(r.home, 'Library', 'Application Support', 'Saqme To Do', 'app', 'node', 'bin', 'node'));
  }, 120_000);

  for (const [what, opts, says] of [
    ['arm64 with glibc older than 2.28', { arch: 'aarch64', glibc: '2.27' }, 'older than the Node.js builds for aarch64 need (2.28)'],
    ['glibc older than 2.17', { glibc: '2.12' }, 'older than the Node.js builds for x86_64 need (2.28, or 2.17 for the older-system build)'],
    ['macOS older than 11', { os: 'Darwin', macos: '10.15.7' }, 'needs macOS 11 (Big Sur) or newer'],
    ['a glibc-2.17 download that does not match its checksum', { glibc: '2.17', oldMirror: 'bad' }, 'checksum mismatch'],
    ['the glibc-2.17 builds cannot be reached', { glibc: '2.17', old: '/nonexistent' }, 'could not reach unofficial-builds.nodejs.org'],
  ]) {
    it(`stops with advice, nothing installed: ${what}`, () => {
      const { oldMirror, ...rest } = opts;
      const r = setup({ ...rest, ...(oldMirror ? { old: mirrors[oldMirror] } : {}) });
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain(says);
      expect(r.out).toContain('What to do:');
      expect(existsSync(launcher(r.home))).toBe(false);
    }, 60_000);
  }

  it('a mirror that lists only other majors: says there is no build yet', () => {
    const only25 = join(dir, 'glibc217-25');
    index(only25, [['v25.1.0', ['linux-x64-glibc-217']], ['v20.19.0', ['linux-x64-glibc-217']]]);
    const r = setup({ glibc: '2.17', old: only25 });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('there is no Node.js 22.13.0+ build for glibc 2.17 yet');
  }, 60_000);

  it('WSL without options: points at the Windows app, no Cloudflare, nothing installed', () => {
    const r = setup({ env: { WSL_DISTRO_NAME: 'Ubuntu' }, official: '/nonexistent', old: '/nonexistent', args: [] });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('This is WSL, on Windows.');
    expect(r.out).toContain('scripts/setup.ps1 | iex');
    expect(r.out).not.toMatch(/Cloudflare account\)|Checking tools/);
    expect(existsSync(launcher(r.home))).toBe(false);
    expect(readdirSync(r.home)).toEqual([]);
  }, 60_000);
});
