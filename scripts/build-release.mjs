#!/usr/bin/env node
// Builds a release's assets (the release workflow runs it on a v* tag; CONTRIBUTING.md, "How to ship an update"):
//   dist/saqme-X.Y.Z.zip      the app as setup installs it: setup.cmd, desktop/, local/, scripts/, worker/ (no tests,
//                             no dev tools, no node_modules, nothing per user), in a folder saqme-X.Y.Z/
//   dist/saqme-release.json   the manifest the apps' updaters read (local/update.mjs checkManifest): version, API
//                             versions, the zip's size and SHA-256
//   dist/saqme-worker-X.Y.Z.bundle  the user's Worker as it updates ITSELF (worker/src/selfupdate.js): its code
//                             bundled the way wrangler bundles it, and the phone app's files with the hashes wrangler
//                             gives them (buildWorkerBundle below); size and SHA-256 in the manifest too
//   dist/SHA256SUMS           the same checksums, for people
//   dist/notes.md             this version's section of CHANGELOG.md
// The version is worker/package.json's. The zip is the same for the same files (sorted, fixed times), and so is
// the bundle. It needs worker/node_modules (npm ci there): esbuild and blake3-wasm, which wrangler uses too.
//   node scripts/build-release.mjs [--out dist] [--notes URL]
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
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
  const { bytes: bundle, headerSha256 } = buildWorkerBundle({ root, version: v, api: API_VERSION });
  const bundleName = `saqme-worker-${v}.bundle`;
  const bundleSha = createHash('sha256').update(bundle).digest('hex');
  const manifest = {
    schema: 1, name: 'saqme-to-do', version: v, tag: `v${v}`, published, api: API_VERSION, minWorkerApi: MIN_WORKER_API,
    asset: { name: `${top}.zip`, size: zip.length, sha256 },
    // the Worker's own updater (updaters before 1.2.0 do not know it and leave it alone). It checks the header's
    // SHA-256, and through it every part it uses, rather than all of the file: less CPU time than a Worker has
    worker: { asset: bundleName, size: bundle.length, sha256: bundleSha, headerSha256 },
    ...(notes ? { notes } : {}),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${top}.zip`), zip);
  writeFileSync(join(out, bundleName), bundle);
  writeFileSync(join(out, 'saqme-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'SHA256SUMS'), `${sha256}  ${top}.zip\n${bundleSha}  ${bundleName}\n`);
  const section = existsSync(join(root, 'CHANGELOG.md')) ? changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), v) : '';
  writeFileSync(join(out, 'notes.md'), `${section || `Saqme To Do ${v}.`}\n\nInstalled apps update themselves (Settings > Updates). New installs: see the README.\n`);
  return { version: v, zip: join(out, `${top}.zip`), bundle: join(out, bundleName), manifest, files: rels };
}

// ---------------------------------------------------------------- the Worker's bundle (its own updater deploys it)
// One file, read by worker/src/selfupdate.js (readBundle) with as little work as possible (the free plan gives a
// Worker 10 ms of CPU): a first line, a header line of JSON, then the bytes of every part one after another.
//   saqme-worker 1
//   { schema, version, api, main, compatibilityDate, compatibilityFlags, crons, requires, assets: { binding, config },
//     modules: [{ name, type, offset, size, sha256 }], files: [{ path, hash, size, type, offset, sha256 }], body }
//   <bytes>   (offsets count from here; body: their total size)
// The manifest has the SHA-256 of the first two lines (headerSha256); the header has each part's.
// The code is bundled with esbuild as wrangler does it; the phone app's files carry wrangler's own asset hash and
// content type, so files that a deploy from a computer uploaded already are not uploaded again, and the other way
// round. _headers goes into the assets' config, as wrangler sends it. Everything else comes from
// wrangler.toml.template, the same settings a computer deploys with.
export const BUNDLE_MAGIC = 'saqme-worker 1';
const TYPES = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', webmanifest: 'application/manifest+json',
  txt: 'text/plain', png: 'image/png', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon', ttf: 'font/ttf', woff2: 'font/woff2', webp: 'image/webp',
};
/** The content type wrangler gives an asset (its mime table, text with a charset); a file it would not know stops the build. */
export function assetType(path) {
  const t = TYPES[extname(path).slice(1).toLowerCase()];
  if (!t) throw new Error(`${path}: no content type known for it (scripts/build-release.mjs TYPES)`);
  return t.startsWith('text/') ? `${t}; charset=utf-8` : t;
}
/** wrangler's asset hash: BLAKE3 of the base64 of the file and its extension, 32 hex digits. */
export function assetHash(data, path, root = REPO_ROOT) {
  const { hash } = workerRequire(root)('blake3-wasm');
  return hash(Buffer.from(data).toString('base64') + extname(path).slice(1)).toString('hex').slice(0, 32);
}
const workerRequire = (root) => createRequire(join(root, 'worker', 'package.json'));

/** The settings of wrangler.toml.template the bundle needs (a few keys of a file this repository writes). */
export function templateSettings(text) {
  // the top (before the first [section]) and each section by its name
  const sections = { '': '' };
  let at = '';
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\[\[?([\w.]+)\]\]?\s*$/.exec(line);
    if (m) { at = m[1]; sections[at] = `${sections[at] ?? ''}\n`; } else sections[at] += `${line}\n`;
  }
  const str = (sec, key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(sections[sec] ?? '')?.[1];
  const list = (sec, key) => { const m = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(sections[sec] ?? ''); return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : []; };
  const names = (sec, re) => [...(sections[sec] ?? '').matchAll(re)].map((x) => x[1]);
  return {
    main: str('', 'main'), compatibilityDate: str('', 'compatibility_date'), compatibilityFlags: list('', 'compatibility_flags'), crons: list('triggers', 'crons'),
    assetsDir: str('assets', 'directory'), assetsBinding: str('assets', 'binding'), runWorkerFirst: list('assets', 'run_worker_first'),
    // what the code needs from the Worker it replaces: its bindings and variables (the secrets come from setup)
    requires: [
      ...Object.keys(sections).filter((s) => s && s !== 'assets').flatMap((s) => names(s, /^binding\s*=\s*"([^"]+)"/gm)),
      ...names('vars', /^([A-Za-z_]\w*)\s*=/gm),
    ],
  };
}

/** The Worker's code as one module, bundled by esbuild like wrangler does (no source map); its package.json says `version`. */
function bundleCode(root, main, version) {
  const workerDir = join(root, 'worker');
  const pkg = JSON.parse(readFileSync(join(workerDir, 'package.json'), 'utf8'));
  let dir = workerDir;
  let tmp = null;
  if (pkg.version !== version) {
    // (tests build releases of other versions: the code reads its version from package.json)
    tmp = mkdtempSync(join(tmpdir(), 'saqme-bundle-'));
    dir = join(tmp, 'worker');
    for (const part of ['src', 'public/js']) cpSync(join(workerDir, part), join(dir, part), { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  }
  try {
    const r = workerRequire(root)('esbuild').buildSync({
      entryPoints: [join(dir, main)], absWorkingDir: dir, bundle: true, write: false, format: 'esm', target: 'es2024',
      conditions: ['workerd', 'worker', 'browser'], platform: 'neutral', sourcemap: false, minify: false, logLevel: 'silent',
      external: ['cloudflare:*', 'node:*'],
    });
    return Buffer.from(r.outputFiles[0].contents);
  } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}

/** The bundle for `version` (see above) -> its bytes. */
export function buildWorkerBundle({ root = REPO_ROOT, version, api }) {
  const t = templateSettings(readFileSync(join(root, 'worker', 'wrangler.toml.template'), 'utf8'));
  if (!t.main || !t.compatibilityDate || !t.assetsDir || !t.assetsBinding) throw new Error('worker/wrangler.toml.template: main, compatibility_date or [assets] missing');
  const parts = [];
  let offset = 0;
  const add = (data) => { parts.push(data); const at = offset; offset += data.length; return { offset: at, sha256: createHash('sha256').update(data).digest('hex') }; };
  const code = bundleCode(root, t.main, version);
  const modules = [{ name: 'index.js', type: 'application/javascript+module', size: code.length, ...add(code) }];
  const pub = join(root, 'worker', t.assetsDir.replace(/^\.\//, ''));
  const rels = walk(pub, '', []).sort();
  const files = [];
  let headers = '';
  for (const rel of rels) {
    const data = readFileSync(join(pub, ...rel.split('/')));
    if (rel === '_headers') { headers = data.toString('utf8'); continue; }
    if (rel === '_redirects' || rel === '.assetsignore') throw new Error(`worker/public/${rel}: not handled by the bundle`);
    if (data.length > 25 * 1024 * 1024) throw new Error(`worker/public/${rel}: larger than an asset may be (25 MiB)`);
    files.push({ path: `/${rel}`, hash: assetHash(data, rel, root), size: data.length, type: assetType(rel), ...add(data) });
  }
  const header = {
    schema: 1, version, api, main: 'index.js', compatibilityDate: t.compatibilityDate, compatibilityFlags: t.compatibilityFlags, crons: t.crons,
    requires: t.requires,
    assets: { binding: t.assetsBinding, config: { run_worker_first: t.runWorkerFirst, ...(headers ? { _headers: headers } : {}) } },
    modules, files, body: offset,
  };
  const head = Buffer.from(`${BUNDLE_MAGIC}\n${JSON.stringify(header)}\n`);
  return { bytes: Buffer.concat([head, ...parts]), headerSha256: createHash('sha256').update(head).digest('hex') };
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
