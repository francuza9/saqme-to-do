#!/usr/bin/env node
// Builds a release's assets (the release workflow runs it on a v* tag; CONTRIBUTING.md, "How to ship an update"):
//   dist/saqme-X.Y.Z.zip      the app as setup installs it: setup.cmd, desktop/, local/, scripts/, worker/ (no tests,
//                             no dev tools, no node_modules, nothing per user), in a folder saqme-X.Y.Z/
//   dist/saqme-release.json   the manifest the apps' updaters read (local/update.mjs checkManifest): version, API
//                             versions, the zip's size and SHA-256
//   dist/SHA256SUMS           the same checksum, for people
//   dist/notes.md             this version's section of CHANGELOG.md
// The version is worker/package.json's. The zip is the same for the same files (sorted, fixed times).
//   node scripts/build-release.mjs [--out dist] [--notes URL]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

/** What goes into a release, relative to the repository (folders recursively, minus EXCLUDE). */
export const INCLUDE = [
  'setup.cmd', 'LICENSE', 'README.md', 'CHANGELOG.md',
  'desktop', 'local',
  'scripts/setup.ps1', 'scripts/setup.sh', 'scripts/cloud-setup.mjs',
  'worker/src', 'worker/public', 'worker/migrations', 'worker/package.json', 'worker/package-lock.json', 'worker/wrangler.toml.template',
];
const EXCLUDE = [/(^|\/)tests?(\/|$)/, /(^|\/)node_modules(\/|$)/, /^desktop\/cache(\/|$)/, /(^|\/)\.(dev\.vars|DS_Store|wrangler)/, /(^|\/)Thumbs\.db$/, /\.log$/];

function walk(root, rel, out) {
  const full = join(root, rel);
  if (!existsSync(full)) throw new Error(`${rel} is missing`);
  if (statSync(full).isDirectory()) {
    for (const n of readdirSync(full)) walk(root, rel ? `${rel}/${n}` : n, out);
  } else if (!EXCLUDE.some((re) => re.test(rel))) out.push(rel);
  return out;
}

/** A zip of [{ name, data }], deflated where that helps, with fixed times (1980-01-01): the same bytes every time. */
export function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = deflateRawSync(f.data, { level: 9 });
    const [method, body] = deflated.length < f.data.length ? [8, deflated] : [0, f.data];
    const crc = crc32(f.data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(33, 12);   // 00:00, 1980-01-01
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE((3 << 8) | 20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(33, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);   // a regular file, rw-r--r--
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += head.length + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** CHANGELOG.md's section for a version ("## 1.2.0 ..." up to the next "## "), or ''. */
export function changelogSection(text, version) {
  const lines = String(text).split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l));
  if (at < 0) return '';
  let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(at + 1, end).join('\n').trim();
}

/**
 * Builds the assets into `out` -> { version, zip, manifest }. version: tests build a release of another version
 * (worker/package.json in the zip says it); published: the manifest's time.
 */
export function buildRelease({ root = REPO_ROOT, out = join(REPO_ROOT, 'dist'), version, notes = '', published = new Date().toISOString() } = {}) {
  const pkgPath = join(root, 'worker', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const v = version ?? pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`"${v}" is not a version (X.Y.Z)`);
  const top = `saqme-${v}`;
  const rels = [...new Set(INCLUDE.flatMap((p) => walk(root, p, [])))].sort();
  const files = rels.map((rel) => {
    let data = readFileSync(join(root, ...rel.split('/')));
    if (rel === 'worker/package.json' && v !== pkg.version) data = Buffer.from(`${JSON.stringify({ ...pkg, version: v }, null, 2)}\n`);
    return { name: `${top}/${rel}`, data };
  });
  const zip = makeZip(files);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const { API_VERSION, MIN_WORKER_API } = readApiVersions(root);
  const manifest = {
    schema: 1, name: 'saqme-to-do', version: v, tag: `v${v}`, published, api: API_VERSION, minWorkerApi: MIN_WORKER_API,
    asset: { name: `${top}.zip`, size: zip.length, sha256 },
    ...(notes ? { notes } : {}),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${top}.zip`), zip);
  writeFileSync(join(out, 'saqme-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'SHA256SUMS'), `${sha256}  ${top}.zip\n`);
  const section = existsSync(join(root, 'CHANGELOG.md')) ? changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), v) : '';
  writeFileSync(join(out, 'notes.md'), `${section || `Saqme To Do ${v}.`}\n\nInstalled apps update themselves (Settings > Updates). New installs: see the README.\n`);
  return { version: v, zip: join(out, `${top}.zip`), manifest, files: rels };
}

/** API_VERSION and MIN_WORKER_API from worker/src/version.js (read as text: it imports package.json). */
function readApiVersions(root) {
  const src = readFileSync(join(root, 'worker', 'src', 'version.js'), 'utf8');
  const num = (name) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(src)?.[1]);
  const API_VERSION = num('API_VERSION');
  const MIN_WORKER_API = num('MIN_WORKER_API');
  if (!(API_VERSION >= 1) || !(MIN_WORKER_API >= 1)) throw new Error('worker/src/version.js has no API_VERSION / MIN_WORKER_API');
  return { API_VERSION, MIN_WORKER_API };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const out = resolve(opt('--out') ?? join(REPO_ROOT, 'dist'));
  const r = buildRelease({ out, notes: opt('--notes') ?? '' });
  console.log(`saqme ${r.version}: ${r.files.length} files -> ${relative(process.cwd(), r.zip).split(sep).join('/')} (${r.manifest.asset.size} bytes, sha256 ${r.manifest.asset.sha256})`);
}
