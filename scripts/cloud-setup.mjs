#!/usr/bin/env node
// Saqme To Do - cloud setup: creates (or reuses) everything in YOUR Cloudflare account and prints the
// pairing link + QR code for the phone. Safe to re-run: existing database, keys and token are reused.
// Called by scripts/setup.ps1 (Windows), scripts/setup.sh (macOS / Linux / WSL) and the apps' updaters; it can
// be run directly:
//
//   node scripts/cloud-setup.mjs --state <file> [--desktop-config <file>] [--worker-name saqme]
//                                [--rotate-token] [--yes] [--device-login] [--update | --login-only]
//
//   --state           where to keep what setup generated (token, push keys, database id, URL); private file
//   --desktop-config  also write the desktop app's sync config there (setup.ps1 and setup.sh pass it)
//   --pair-again      the command that shows the pairing QR code again (setup.sh: saqme pair-phone)
//   --rotate-token    issue a new access token and push keys: the old ones stop working at once (every
//                     phone / PC must pair again; phones paired with the old key get no more notifications)
//   --device-login    log in with a code instead of a browser redirect (SSH, containers)
//   --update          the apps' updater: deploy this version's code and phone app to the existing Worker, and
//                     nothing else (no keys, no new database, no questions, no login: { needsLogin } instead)
//   --login-only      the apps' "Sign in to Cloudflare" (to finish an update): the browser login, nothing else
//   --result FILE     write how it ended there as JSON ({ ok, url } or { ok: false, message, next, needsLogin }),
//                     for the apps
//
// Steps: Node check -> npm ci (worker/) -> wrangler login (the one manual step) -> D1 database ->
// worker/wrangler.toml -> token + VAPID keys -> deploy -> health check -> updating itself (asks) -> desktop config
// -> pairing link + QR.
// The keys (Worker secrets) are sent only with a first setup, a rotation, or to a Worker that has none: they
// stay on the Worker across deploys, so every other deploy is code only. The database's tables are made and
// updated by the Worker itself (worker/src/schema.js), on its first request after a deploy. A Worker that runs a
// newer release than this copy (it updated itself: worker/src/selfupdate.js) keeps its code; only keys go up.
// Updating itself needs a Cloudflare API token, which only you can make: setup asks (in a terminal) and hands it
// to the Worker, or takes it from the environment variable SAQME_UPDATE_TOKEN; the apps offer it later too.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, chmodSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ReadStream } from 'node:tty';

// (worker/src is imported when needed: an old Node.js gets checkNode's message instead of a syntax error)
const compareVersions = async (a, b) => (await import('../worker/src/selfupdate.js')).compareVersions(a, b);

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { workerName: 'saqme', yes: false, rotateToken: false, deviceLogin: false, skipInstall: false, update: false, loginOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--state') out.state = next();
    else if (a === '--desktop-config') out.desktopConfig = next();
    else if (a === '--worker-name') out.workerName = next();
    else if (a === '--worker-dir') out.workerDir = next();          // tests
    else if (a === '--pair-again') out.pairAgain = next();          // how to show the QR code again later
    else if (a === '--rotate-token') out.rotateToken = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--device-login') out.deviceLogin = true;
    else if (a === '--skip-install') out.skipInstall = true;
    else if (a === '--update') out.update = true;
    else if (a === '--login-only') out.loginOnly = true;
    else if (a === '--result') out.result = next();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------- console
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = {
  step: (n, total, text) => console.log(`\n${c('35;1', `[${n}/${total}]`)} ${c('1', text)}`),
  ok: (text) => console.log(`      ${c('32', 'ok')}  ${text}`),
  info: (text) => console.log(`          ${text}`),
  warn: (text) => console.log(`      ${c('33', '!!')}  ${text}`),
};
class SetupError extends Error {
  constructor(message, next, extra = {}) { super(message); this.next = next; Object.assign(this, extra); }
}

// the terminal, also under `curl ... | bash` (stdin is the script there); null when there is none
function terminalInput() {
  if (process.stdin.isTTY) return { input: process.stdin, close() {} };
  if (process.platform === 'win32') return null;
  try {
    const s = new ReadStream(openSync('/dev/tty', 'r'));
    return { input: s, close: () => s.destroy() };
  } catch { return null; }
}

async function ask(question, { yes, fallback = '', secret = false } = {}) {
  const term = yes ? null : terminalInput();
  if (!term) return fallback;
  const rl = createInterface({ input: term.input, output: process.stdout, terminal: secret ? true : undefined });
  // a secret: what is typed (pasted) is not shown; the question goes out, then nothing until Enter
  let muted = false;
  const write = rl._writeToOutput?.bind(rl);
  if (secret && write) rl._writeToOutput = (s) => { if (!muted) write(s); };
  const answer = await new Promise((r) => { rl.question(`      ${question} `, r); muted = secret; });
  if (secret) process.stdout.write('\n');
  rl.close();
  term.close();
  return answer.trim() || fallback;
}

// ---------------------------------------------------------------- processes
function wranglerCommand(workerDir) {
  // a fake can be injected for tests; otherwise wrangler's own JS entry, run with this node (no shell)
  const js = process.env.SAQME_WRANGLER_JS || join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return [process.execPath, [js]];
}

function run(workerDir, args, { interactive = false, env = {}, input } = {}) {
  const [cmd, pre] = wranglerCommand(workerDir);
  const fullEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', ...env };
  if (!interactive) fullEnv.CI = '1';   // no prompts: wrangler takes the safe defaults
  return new Promise((resolveRun) => {
    const child = spawn(cmd, [...pre, ...args], {
      cwd: workerDir, env: fullEnv, stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    if (!interactive) {
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    }
    child.on('error', (e) => resolveRun({ code: -1, out: String(e) }));
    child.on('close', (code) => resolveRun({ code, out }));
  });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * `wrangler login --device`: its output passes through as it comes, and once it has printed the sign-in
 * address and the code, both are repeated on their own lines where they stand out (and where the
 * Linux/macOS window's setup log makes the address a link).
 */
function runDeviceLogin(workerDir) {
  const [cmd, pre] = wranglerCommand(workerDir);
  return new Promise((resolveRun) => {
    const child = spawn(cmd, [...pre, 'login', '--device'], {
      cwd: workerDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['inherit', 'pipe', 'pipe'],
    });
    let out = '';
    let shown = false;
    const pass = (stream) => (d) => {
      stream.write(d);
      out += d;
      if (shown) return;
      const plain = stripAnsi(out);
      const url = /please visit:\s+(https:\/\/\S+)/i.exec(plain)?.[1];
      const code = /enter the code:\s+(\S+)/i.exec(plain)?.[1];
      if (!url || !code) return;
      shown = true;
      console.log(`\n      ${c('1', 'Open')}   ${url}\n      ${c('1', 'Code')}   ${c('1;35', code)}\n`);
      say.info('Open the address on any device (this computer or your phone), sign in, enter the code and approve.');
      say.info('Setup goes on by itself once you have.');
    };
    child.stdout.on('data', pass(process.stdout));
    child.stderr.on('data', pass(process.stderr));
    child.on('error', (e) => resolveRun({ code: -1, out: String(e) }));
    child.on('close', (code) => resolveRun({ code, out }));
  });
}
function lastLines(text, n = 12) {
  return stripAnsi(text).trim().split(/\r?\n/).filter((l) => l.trim()).slice(-n).map((l) => `          ${l}`).join('\n');
}

// ---------------------------------------------------------------- state files
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function writePrivateJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows: the profile folder is private already */ }
}

// ---------------------------------------------------------------- steps
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  // wrangler needs 22 (and refuses older versions with a message that looks like a failed login)
  if (major < 22) throw new SetupError(`Node.js ${process.versions.node} is too old (22 or newer needed).`, 'Install the current LTS from https://nodejs.org and run setup again.');
  say.ok(`Node.js ${process.versions.node}`);
}

/** npm: the one that comes with this Node.js (a Node.js setup downloaded is not on PATH), else the one on PATH. */
function npmCommand() {
  const dir = dirname(process.execPath);
  for (const cli of [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(cli)) return { cmd: process.execPath, pre: [cli], shell: false };
  }
  return { cmd: 'npm', pre: [], shell: process.platform === 'win32' };
}

function installDeps(workerDir, skip, quiet = false) {
  if (skip) { say.ok('tools: skipped'); return; }
  const marker = join(workerDir, 'node_modules', '.saqme-lock');
  const lock = readFileSync(join(workerDir, 'package-lock.json'), 'utf8');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === lock) { say.ok('tools already installed'); return; }
  say.info('installing the Cloudflare tools (wrangler) - about a minute the first time...');
  const npm = npmCommand();
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` };
  const r = spawnSync(npm.cmd, [...npm.pre, 'ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: workerDir, env, stdio: quiet ? 'pipe' : 'inherit', shell: npm.shell, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new SetupError('npm could not install the tools.', `Check the internet connection (and proxy settings), then run setup again.${quiet ? `\n${lastLines(`${r.stdout ?? ''}${r.stderr ?? ''}`, 6)}` : ''}`);
  }
  writeFileSync(marker, lock);
  say.ok('tools installed');
}

async function whoami(workerDir) {
  const r = await run(workerDir, ['whoami', '--json']);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return null; }
}

async function ensureLogin(workerDir, opts, state) {
  let me = await whoami(workerDir);
  if (!me) {
    if (opts.deviceLogin) say.info('Log in to Cloudflare with a code: Cloudflare shows a sign-in address and a code below. Open the address on any device, sign in (or create a free account) and enter the code.');
    else say.info('Log in to Cloudflare: a browser window opens - sign in (or create a free account) and click "Allow".');
    say.info('This is the only step setup cannot do for you.');
    const r = opts.deviceLogin ? await runDeviceLogin(workerDir) : await run(workerDir, ['login'], { interactive: true });
    if (r.code !== 0) {
      throw new SetupError('Cloudflare login did not finish.', opts.deviceLogin
        ? 'Run setup again and enter the new code before it expires (the time is shown with it).'
        : 'Run setup again; if no browser opens, add --device-login (setup.ps1: -DeviceLogin) to log in with a code.');
    }
    me = await whoami(workerDir);
    if (!me) throw new SetupError('Still not logged in to Cloudflare.', `Run setup again and approve the login${opts.deviceLogin ? ' with the code' : ' in the browser'}.`);
  }
  const accounts = (me.accounts || []).map((a) => ({ id: a.id, name: a.name }));
  say.ok(`logged in${me.email ? ` as ${me.email}` : ''}`);
  if (!accounts.length) throw new SetupError('This Cloudflare login has no account.', 'Open https://dash.cloudflare.com once to finish creating your account, then run setup again.');
  if (accounts.length === 1) return accounts[0];
  const known = accounts.find((a) => a.id === process.env.CLOUDFLARE_ACCOUNT_ID) ?? accounts.find((a) => a.id === state.accountId);
  if (known) { say.ok(`account: ${known.name} (${known.id})`); return known; }
  console.log('      Several Cloudflare accounts are available:');
  accounts.forEach((a, i) => console.log(`        ${i + 1}) ${a.name}  (${a.id})`));
  const pick = Number(await ask('Which one should hold Saqme? [1]', { yes: opts.yes, fallback: '1' }));
  const acc = accounts[pick - 1];
  if (!acc) throw new SetupError('No valid account chosen.', 'Run setup again and type the number of the account.');
  say.ok(`account: ${acc.name} (${acc.id})`);
  say.info('(to use another one later, run setup with the environment variable CLOUDFLARE_ACCOUNT_ID set to its id)');
  return acc;
}

async function listDatabases(workerDir, accountEnv) {
  const r = await run(workerDir, ['d1', 'list', '--json'], { env: accountEnv });
  if (r.code !== 0) throw new SetupError('Could not list your D1 databases.', `Wrangler said:\n${lastLines(r.out)}`);
  try { return JSON.parse(r.out.slice(r.out.indexOf('['))); } catch { throw new SetupError('Unexpected answer from "wrangler d1 list".', lastLines(r.out)); }
}

async function ensureDatabase(workerDir, name, accountEnv) {
  const list = () => listDatabases(workerDir, accountEnv);
  let db = (await list()).find((d) => d.name === name);
  if (db) { say.ok(`database "${name}" already exists - reusing it`); return { name, id: db.uuid || db.id, existed: true }; }
  const r = await run(workerDir, ['d1', 'create', name], { env: accountEnv });
  if (r.code !== 0) {
    throw new SetupError(`Could not create the D1 database "${name}".`,
      `Wrangler said:\n${lastLines(r.out)}\n          (The free plan allows 10 databases; delete unused ones in the dashboard, or pass a different -WorkerName.)`);
  }
  db = (await list()).find((d) => d.name === name);
  if (!db) throw new SetupError('The database was created but cannot be found.', 'Run setup again in a minute.');
  say.ok(`database "${name}" created`);
  return { name, id: db.uuid || db.id };
}

function writeWranglerToml(workerDir, { workerName, accountId, db }) {
  const tpl = readFileSync(join(workerDir, 'wrangler.toml.template'), 'utf8');
  const toml = tpl
    .replaceAll('__WORKER_NAME__', workerName)
    .replaceAll('__ACCOUNT_ID__', accountId)
    .replaceAll('__DATABASE_NAME__', db.name)
    .replaceAll('__DATABASE_ID__', db.id);
  writeFileSync(join(workerDir, 'wrangler.toml'), toml);
  say.ok('worker/wrangler.toml written');
}

/** vapid: false when the push keys are on the Worker but not known here (setup made on another computer). */
async function loadOrCreateSecrets(state, rotate, { vapid = true } = {}) {
  const out = { token: state.token, vapidPublicKey: state.vapidPublicKey, vapidPrivateKey: state.vapidPrivateKey };
  if (!out.token || rotate) { out.token = randomBytes(32).toString('base64url'); say.ok(rotate ? 'new access token issued' : 'access token generated'); }
  else say.ok('reusing your access token');
  if (!vapid && !rotate) return out;
  if (!out.vapidPublicKey || !out.vapidPrivateKey || rotate) await newPushKeys(out, rotate);
  else say.ok('reusing your push notification keys');
  return out;
}
async function newPushKeys(out, rotate = false) {
  // new push keys on a rotation too: notifications to phones subscribed with the old ones stop
  const { generateVapidKeys } = await import('../worker/src/push.js');
  const k = await generateVapidKeys();
  out.vapidPublicKey = k.publicKey; out.vapidPrivateKey = k.privateKey;
  say.ok(rotate ? 'new push notification keys issued' : 'push notification keys generated');
}

/**
 * The names of the Worker's secrets -> a Set, 'missing' when there is no such Worker (yet), or null when wrangler
 * could not tell. Secrets stay on a Worker across deploys; this says whether they must be sent.
 */
async function workerSecrets(workerDir, accountEnv) {
  const r = await run(workerDir, ['secret', 'list', '--format', 'json'], { env: accountEnv });
  const text = stripAnsi(r.out);
  if (r.code !== 0) return /does not exist|not found|10007/i.test(text) ? 'missing' : null;
  try { return new Set(JSON.parse(text.slice(text.indexOf('['))).map((s) => s.name)); } catch { return null; }
}

/** Does this token open the Worker? true / false (401) / null (cannot tell: not reachable). */
async function tokenWorks(url, token) {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/api/config`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 401) return false;
    return r.ok ? true : null;
  } catch { return null; }
}

/** What the Worker at url runs -> { version, api }, or null (not reachable: a new Worker, offline). */
async function workerRelease(url) {
  if (!url) return null;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(Number(process.env.SAQME_HEALTH_TIMEOUT_MS || 8000)) });
    const d = await r.json();
    return typeof d.version === 'string' ? { version: d.version, api: Number.isInteger(d.api) ? d.api : 1 } : null;
  } catch { return null; }
}

/** wrangler secret bulk: the keys only, on the code that runs (a Worker newer than this copy keeps its code). */
async function putSecrets(workerDir, secrets, accountEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'saqme-'));
  const file = join(dir, 'secrets.json');
  try {
    writeFileSync(file, JSON.stringify({ AUTH_TOKEN: secrets.token, VAPID_PUBLIC_KEY: secrets.vapidPublicKey, VAPID_PRIVATE_KEY: secrets.vapidPrivateKey }), { mode: 0o600 });
    const r = await run(workerDir, ['secret', 'bulk', file], { env: accountEnv });
    if (r.code !== 0) throw new SetupError('The new keys could not be sent to your sync service.', `Wrangler said:\n${lastLines(r.out)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Updating itself (worker/src/selfupdate.js): offered when the Worker can and has no token yet. The token comes from
 * Cloudflare's token page (prefilled; only the user can create it), pasted here, or from SAQME_UPDATE_TOKEN; the
 * Worker checks it and keeps it as its secret (POST /api/update/token). Under --yes, or without a terminal, it only
 * says where the apps offer it.
 */
async function offerSelfUpdate(url, token, opts) {
  let status = null;
  try {
    const r = await fetch(`${url}/api/update`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) status = await r.json();
  } catch { /* not reachable yet: the apps offer it later */ }
  if (!status?.knowsItself || status.token) return;
  let t = process.env.SAQME_UPDATE_TOKEN?.trim() ?? '';
  if (!t) {
    const later = 'Your sync service can also update itself, even when this computer is off: Settings > Updates in the app sets it up.';
    if (opts.yes || !terminalInput()) { say.info(later); return; }
    say.info('Your sync service can update itself when a new version is out, even when this computer is off.');
    say.info('It needs a Cloudflare API token that may change the Workers of this account, and nothing else.');
    if (!/^y/i.test(await ask('Set that up now? [y/N]', { fallback: 'n' }))) { say.info(later); return; }
    say.info('1. Open this page (signed in to Cloudflare): it is filled in already.');
    console.log(`\n      ${status.tokenUrl}\n`);
    say.info('2. Click "Continue to summary", then "Create Token", and copy the token it shows.');
    say.info('   (If the page shows no permission: Create Custom Token; Permissions: Account, Workers Scripts, Edit;');
    say.info('   Account Resources: Include, your account.)');
    t = await ask('3. Paste the token here (it is not shown), then press Enter:', { secret: true });
    if (!t) { say.info(later); return; }
  }
  try {
    const r = await fetch(`${url}/api/update/token`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ token: t }), signal: AbortSignal.timeout(60_000),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) say.ok('your sync service updates itself from now on (Settings > Updates in the app can turn it off)');
    else say.warn(`The token was not taken: ${d.error || `HTTP ${r.status}`} Settings > Updates in the app can try again.`);
  } catch (e) { say.warn(`Could not give the token to your sync service (${e.cause?.code || e.message}); Settings > Updates in the app can do it later.`); }
}

/** saqme.<subdomain>.workers.dev -> saqme (the Worker's name), else ''. */
function workerNameOf(url) {
  try {
    const h = new URL(url).hostname.split('.');
    return h.length >= 4 && h.slice(-2).join('.') === 'workers.dev' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(h[0]) ? h[0] : '';
  } catch { return ''; }
}

// after a rotation: the phones that subscribed with the old key get nothing more (a lost phone included)
async function forgetPushSubscriptions(workerDir, db, accountEnv) {
  const r = await run(workerDir, ['d1', 'execute', db.name, '--remote', '--command', 'DELETE FROM push_subscriptions'], { env: accountEnv });
  if (r.code === 0) { say.ok('notification subscriptions of the old key removed'); return; }
  say.warn('Could not remove the old notification subscriptions; they no longer work with the new push keys anyway.');
  say.info(lastLines(r.out, 4).trim());
}

const SUBDOMAIN_HINT = /workers\.dev subdomain|register a workers\.dev|no workers\.dev subdomain|subdomain/i;

/** secrets: null for a code-only deploy (the Worker keeps the secrets it has). */
async function deploy(workerDir, secrets, accountEnv, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'saqme-'));
  const file = join(dir, 'secrets.json');
  const args = ['deploy'];
  if (secrets) {
    writeFileSync(file, JSON.stringify({ AUTH_TOKEN: secrets.token, VAPID_PUBLIC_KEY: secrets.vapidPublicKey, VAPID_PRIVATE_KEY: secrets.vapidPrivateKey }), { mode: 0o600 });
    args.push('--secrets-file', file);   // code and secrets go up together, so the Worker never runs without its token
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await run(workerDir, args, { env: accountEnv });
      const text = stripAnsi(r.out);
      const url = (text.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i) || [])[0];
      if (r.code === 0 && url) { say.ok(`deployed to ${url}`); return url.replace(/\/$/, ''); }
      if (r.code === 0 && opts.knownUrl) { say.ok(`deployed (${opts.knownUrl})`); return opts.knownUrl.replace(/\/$/, ''); }
      if (r.code === 0) {
        say.warn('Deployed, but wrangler did not print the address.');
        const pasted = await ask('Paste the https://...workers.dev address shown in the Cloudflare dashboard (Workers & Pages):', { yes: opts.yes });
        if (/^https:\/\/\S+$/.test(pasted)) return pasted.replace(/\/$/, '');
        throw new SetupError('No Worker address.', 'Open https://dash.cloudflare.com -> Workers & Pages -> saqme to see it, then run setup again.');
      }
      if (SUBDOMAIN_HINT.test(text) && attempt < 2 && !opts.update) {
        say.warn('Your Cloudflare account needs a free workers.dev subdomain first (one time only).');
        say.info('Wrangler will now ask you to pick one (any name, e.g. your nickname).');
        say.info('If it does not ask: open https://dash.cloudflare.com -> Workers & Pages, pick a subdomain there, then come back.');
        const ri = await run(workerDir, args, { env: accountEnv, interactive: true });
        if (ri.code !== 0) await ask('Press Enter once the subdomain is set up...', { yes: opts.yes });
        continue;
      }
      throw new SetupError('Deploying the Worker failed.', `Wrangler said:\n${lastLines(r.out)}`);
    }
    throw new SetupError('Deploying the Worker failed (workers.dev subdomain missing).', 'Pick a subdomain at https://dash.cloudflare.com -> Workers & Pages, then run setup again.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function verify(url, token) {
  // a fresh workers.dev name can take a moment to resolve everywhere
  let lastError = '';
  const attempts = Number(process.env.SAQME_VERIFY_ATTEMPTS || 20);
  for (let i = 0; i < attempts; i++) {
    try {
      const h = await fetch(`${url}/api/health`, { cache: 'no-store' });
      if (h.ok) {
        const c2 = await fetch(`${url}/api/config`, { headers: { authorization: `Bearer ${token}` } });
        if (c2.ok) { say.ok('the Worker answers and accepts your token'); return true; }
        lastError = `config: HTTP ${c2.status}`;
      } else lastError = `health: HTTP ${h.status}`;
    } catch (e) { lastError = e.cause?.code || e.message; }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 3000));
  }
  say.warn(`Could not reach ${url} yet (${lastError}). New workers.dev addresses can take a few minutes;`);
  say.info('everything is saved - the apps will connect once it is reachable.');
  return false;
}

function writeDesktopConfig(path, url, token) {
  const prev = readJson(path) || {};
  writePrivateJson(path, { url, token, deviceId: prev.deviceId || `pc-${randomBytes(6).toString('hex')}`, enabled: true });
  say.ok('desktop app connected (it starts syncing within a few seconds)');
}

/** A one-time pairing code for the app on an iPhone's Home Screen (worker/src/pairing.js), or null. */
async function pairingCode(url, token) {
  try {
    const res = await fetch(`${url}/api/pair/code`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    return res.ok ? (await res.json()).code ?? null : null;
  } catch { return null; }
}

async function printPairing(url, token, pairAgain, reachable) {
  const { qrMatrix, qrToTerminal } = await import('../worker/public/js/qr.js');
  const link = `${url}/#pair=${token}`;
  const code = reachable ? await pairingCode(url, token) : null;
  console.log(`\n${c('1', 'Your phone')}  (the link is your key - keep it private)\n`);
  console.log(qrToTerminal(qrMatrix(link, 'M'), { margin: 2 }));
  console.log(`\n  ${link}\n`);
  console.log('  1. Scan the QR code with the iPhone camera and open the link in Safari.');
  console.log('  2. Tap Share, then "Add to Home Screen".');
  console.log(code ? `  3. Open Saqme from the Home Screen and type the code ${c('1', code)} (works once, for 10 minutes).`
    : '  3. Open Saqme from the Home Screen and type the code Safari shows after step 1.');
  console.log('  4. In Saqme, Settings > Notifications: switch Notifications on.');
  console.log(pairAgain ? `  (Show this code again any time with: ${pairAgain})\n` : '  (The desktop app shows this QR code again: Settings > Sync & sharing > Pair phone.)\n');
}

// ---------------------------------------------------------------- main
function writeResult(path, result) {
  if (!path) return;
  try { writePrivateJson(path, result); } catch { /* the caller then sees no result: "did not finish" */ }
}

/**
 * After an update's deploy: the Worker answers with the new version (a few tries: it takes effect within
 * seconds). -> { reachable, version, schema: the database update's error, if any }
 */
async function verifyVersion(url, version) {
  const attempts = Number(process.env.SAQME_VERIFY_ATTEMPTS || 20);
  let last = { reachable: false, version: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const h = await fetch(`${url}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      const d = await h.json().catch(() => ({}));
      last = { reachable: true, version: String(d.version ?? ''), schema: d.code === 'schema' ? String(d.detail ?? d.error ?? '') : '' };
      if (h.ok && last.version === version) { say.ok(`your sync service runs ${version}`); return last; }
      if (last.schema) return last;
    } catch { /* not reachable (yet) */ }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 3000));
  }
  if (last.reachable) say.warn(`Your sync service still answers as ${last.version || 'an older version'}; Cloudflare may take a minute.`);
  else say.warn(`Could not reach ${url} to check it; the apps keep trying.`);
  return last;
}

/** The account and database of an existing setup (the updater: nothing is asked or created). */
async function findDeployment(workerDir, accounts, state, dbName) {
  if (!accounts.length) throw new SetupError('This Cloudflare login has no account.', 'Sign in with the Cloudflare account you set up sync with.');
  const prefer = [state.accountId, process.env.CLOUDFLARE_ACCOUNT_ID].filter(Boolean);
  const order = [...accounts.filter((a) => prefer.includes(a.id)), ...accounts.filter((a) => !prefer.includes(a.id))];
  for (const account of order) {
    const db = (await listDatabases(workerDir, { CLOUDFLARE_ACCOUNT_ID: account.id })).find((d) => d.name === dbName);
    if (db) { say.ok(`account: ${account.name} (${account.id}), database "${dbName}"`); return { account, db: { name: dbName, id: db.uuid || db.id } }; }
  }
  throw new SetupError(`There is no Saqme database ("${dbName}") in ${accounts.length === 1 ? 'this Cloudflare account' : 'these Cloudflare accounts'}.`,
    'This computer is signed in to a different Cloudflare account than the one sync was set up with, or sync was set up under another name. Nothing was changed; the other computer can update it.');
}

/** --update: this version's code and phone app to the existing Worker. Nothing else changes; no questions. */
async function updateMain(opts, workerDir) {
  const state = readJson(opts.state) || {};
  const desktop = opts.desktopConfig ? readJson(opts.desktopConfig) : null;
  const workerName = state.workerName || workerNameOf(state.url || desktop?.url || '') || opts.workerName;
  const version = readJson(join(workerDir, 'package.json'))?.version ?? '';
  const total = 4;

  say.step(1, total, 'Checking tools');
  checkNode();
  installDeps(workerDir, opts.skipInstall, true);

  say.step(2, total, 'Cloudflare account');
  const me = await whoami(workerDir);
  if (!me) {
    throw new SetupError('Sign in to Cloudflare to finish the update.', 'The app shows a Sign in button (Settings > Updates). Your lists and sync keep working meanwhile.', { needsLogin: true });
  }
  const accounts = (me.accounts || []).map((a) => ({ id: a.id, name: a.name }));
  const { account, db } = await findDeployment(workerDir, accounts, state, state.databaseName || workerName);
  const accountEnv = { CLOUDFLARE_ACCOUNT_ID: account.id };
  writeWranglerToml(workerDir, { workerName, accountId: account.id, db });

  say.step(3, total, `Updating your sync service to ${version}`);
  const secrets = await workerSecrets(workerDir, accountEnv);
  if (secrets === 'missing') throw new SetupError(`There is no sync service called "${workerName}" in this Cloudflare account.`, 'Set up sync again (Settings > Sync & sharing) to make it. Nothing was changed.');
  if (secrets && !secrets.has('AUTH_TOKEN')) throw new SetupError('Your sync service has no access key on Cloudflare, so updating it would leave it locked.', 'Set up sync again (Settings > Sync & sharing). Nothing was changed.');
  const knownUrl = state.url || desktop?.url || '';
  const running = await workerRelease(knownUrl);
  if (running && (await compareVersions(running.version, version)) >= 0) {
    // (it updated itself, or another computer did: never back to an older version)
    say.ok(`your sync service runs ${running.version} already; left as it is`);
    writeResult(opts.result, { ok: true, url: knownUrl, version: running.version, reachable: true });
    return;
  }
  const url = await deploy(workerDir, null, accountEnv, { ...opts, knownUrl });
  say.ok('code and phone app updated; your keys and lists stay as they are');
  Object.assign(state, { accountId: account.id, workerName, databaseName: db.name, databaseId: db.id, url, updatedAt: new Date().toISOString() });
  writePrivateJson(opts.state, state);

  say.step(4, total, 'Checking it works');
  const v = await verifyVersion(url, version);
  if (v.schema) {
    throw new SetupError(`Your sync service runs ${version} but could not update its database: ${v.schema}`,
      'It tries again with every request. If this stays, open an issue with this message.');
  }
  writeResult(opts.result, { ok: true, url, version, reachable: v.reachable });
}

/** --login-only: the browser sign-in an update needs, and nothing else. */
async function loginMain(opts, workerDir) {
  checkNode();
  installDeps(workerDir, opts.skipInstall, true);
  if (!(await whoami(workerDir))) {
    say.info('Sign in to Cloudflare in the browser window that opens (or open the address below), then click Allow.');
    const r = opts.deviceLogin ? await runDeviceLogin(workerDir) : await run(workerDir, ['login'], { interactive: true });
    if (r.code !== 0 || !(await whoami(workerDir))) throw new SetupError('The Cloudflare sign-in did not finish.', 'Try again; if no browser opened, open the address the app shows.');
  }
  say.ok('signed in to Cloudflare');
  writeResult(opts.result, { ok: true });
}

async function main(opts) {
  if (opts.help || (!opts.state && !opts.loginOnly)) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 22).map((l) => l.slice(3)).join('\n'));
    process.exit(opts.help ? 0 : 2);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(opts.workerName)) throw new SetupError(`"${opts.workerName}" is not a valid Worker name.`, 'Use lowercase letters, digits and dashes.');
  const workerDir = resolve(opts.workerDir || join(repo, 'worker'));
  if (opts.loginOnly) return loginMain(opts, workerDir);
  if (opts.update) return updateMain(opts, workerDir);
  const state = readJson(opts.state) || {};
  const total = 7;

  say.step(1, total, 'Checking tools');
  checkNode();
  installDeps(workerDir, opts.skipInstall);

  say.step(2, total, 'Cloudflare account');
  const account = await ensureLogin(workerDir, opts, state);
  const accountEnv = { CLOUDFLARE_ACCOUNT_ID: account.id };
  Object.assign(state, { accountId: account.id, workerName: opts.workerName });
  writePrivateJson(opts.state, state);

  say.step(3, total, 'Database (Cloudflare D1, free tier)');
  const db = await ensureDatabase(workerDir, opts.workerName, accountEnv);
  Object.assign(state, { databaseName: db.name, databaseId: db.id });
  writePrivateJson(opts.state, state);
  writeWranglerToml(workerDir, { workerName: opts.workerName, accountId: account.id, db });
  // (its tables: the Worker makes and updates them itself on its first request, worker/src/schema.js)

  say.step(4, total, 'Keys');
  let takenOver = false;
  if (db.existed && !state.token && !opts.rotateToken) {
    // set up from another machine: its token cannot be read back, and a new one would unpair every device. This
    // computer's app may have it already (connected with a pairing link): then that one is the key
    const d = opts.desktopConfig ? readJson(opts.desktopConfig) : null;
    if (d?.url && d?.token && (await tokenWorks(d.url, d.token)) !== false) {
      Object.assign(state, { token: d.token, url: state.url || d.url });
      takenOver = true;
      say.ok('reusing the access key this computer\'s app already syncs with (sync was set up on another computer)');
    } else {
      throw new SetupError('Saqme is already set up in this Cloudflare account (from another computer).',
        'To connect this PC, copy the pairing link on a device that already syncs (Windows: Settings > Sync & sharing >\n'
        + '          Pair phone > Copy link) and paste it into this PC\'s Settings > Sync & sharing.\n'
        + '          To start over with a new key instead (all devices pair again, phones re-enable notifications), run setup\n'
        + '          with -RotateToken (setup.sh: --rotate-token).');
    }
  }
  const newToken = !state.token || opts.rotateToken;
  const secrets = await loadOrCreateSecrets(state, opts.rotateToken, { vapid: !takenOver });
  Object.assign(state, secrets);
  writePrivateJson(opts.state, state);   // saved before deploying, so a failure never loses them

  say.step(5, total, 'Deploying the sync service + phone app');
  // the keys go up only for a new setup, a rotation, or a Worker without them; otherwise the ones it has stay
  let send = !!(newToken || opts.rotateToken);
  if (!send) {
    const names = await workerSecrets(workerDir, accountEnv);
    send = names === 'missing' || (names instanceof Set && !names.has('AUTH_TOKEN'));
  }
  if (send && !(secrets.vapidPublicKey && secrets.vapidPrivateKey)) { await newPushKeys(secrets); Object.assign(state, secrets); writePrivateJson(opts.state, state); }
  // a Worker that runs a newer release than this copy (it updated itself) keeps its code: never back to an older one
  const version = readJson(join(workerDir, 'package.json'))?.version ?? '';
  const knownUrl = state.url || (opts.desktopConfig ? readJson(opts.desktopConfig)?.url : '') || '';
  const running = db.existed ? await workerRelease(knownUrl) : null;
  let url;
  if (running && (await compareVersions(running.version, version)) > 0) {
    say.ok(`your sync service runs ${running.version}, newer than this copy (${version}): its code stays as it is`);
    if (send) await putSecrets(workerDir, secrets, accountEnv);
    url = knownUrl.replace(/\/+$/, '');
  } else url = await deploy(workerDir, send ? secrets : null, accountEnv, opts);
  say.ok(send ? 'the keys went up with it' : 'the keys on your Worker stay as they are');
  Object.assign(state, { url, updatedAt: new Date().toISOString() });
  writePrivateJson(opts.state, state);

  say.step(6, total, 'Checking it works');
  const reachable = await verify(url, secrets.token);
  if (reachable) await offerSelfUpdate(url, secrets.token, opts);
  if (opts.desktopConfig) writeDesktopConfig(opts.desktopConfig, url, secrets.token);
  else say.info('(no desktop app on this machine - on Windows, paste the link below into Settings > Sync & sharing)');
  if (opts.rotateToken) await forgetPushSubscriptions(workerDir, db, accountEnv);

  say.step(7, total, 'Done');
  say.info(`Settings and keys are saved in ${opts.state}`);
  if (opts.rotateToken) {
    say.warn('The old key is revoked: links and devices paired with it no longer work, and its phones get no more notifications.');
    say.info('Pair your phone (and other computers) again with the new link below, then turn notifications on again.');
  }
  await printPairing(url, secrets.token, opts.pairAgain, reachable);
  writeResult(opts.result, { ok: true, url });
}

let opts = {};
try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
main(opts).catch((e) => {
  writeResult(opts.result, e instanceof SetupError ? { ok: false, message: e.message, next: e.next ?? '', ...(e.needsLogin ? { needsLogin: true } : {}) }
    : { ok: false, message: `Setup failed unexpectedly: ${e.message ?? e}`, next: 'Running setup again is safe.' });
  if (e instanceof SetupError) {
    console.error(`\n${c('31;1', 'Setup stopped:')} ${e.message}`);
    if (e.next) console.error(`${c('1', 'What to do:')} ${e.next}`);
    console.error('Re-running setup is safe: finished steps are skipped.');
  } else {
    console.error(`\n${c('31;1', 'Setup failed unexpectedly:')} ${e.stack || e}`);
    console.error('Re-running setup is safe. If it keeps failing, please open an issue with the message above (remove any tokens).');
  }
  process.exit(1);
});
