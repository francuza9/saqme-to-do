#!/usr/bin/env node
// Saqme To Do - cloud setup: creates (or reuses) everything in YOUR Cloudflare account and prints the
// pairing link + QR code for the phone. Safe to re-run: existing database, keys and token are reused.
// Called by scripts/setup.ps1 (Windows) and scripts/setup.sh (macOS / Linux / WSL); it can be run directly:
//
//   node scripts/cloud-setup.mjs --state <file> [--desktop-config <file>] [--worker-name saqme]
//                                [--rotate-token] [--yes] [--device-login]
//
//   --state           where to keep what setup generated (token, push keys, database id, URL); private file
//   --desktop-config  also write the desktop app's sync config there (setup.ps1 and setup.sh pass it)
//   --pair-again      the command that shows the pairing QR code again (setup.sh: saqme pair-phone)
//   --rotate-token    issue a new access token and push keys: the old ones stop working at once (every
//                     phone / PC must pair again; phones paired with the old key get no more notifications)
//   --device-login    log in with a code instead of a browser redirect (SSH, containers)
//   --result FILE     write how it ended there as JSON ({ ok, url } or { ok: false, message, next }), for the
//                     apps' Settings > Sync > Set up sync
//
// Steps: Node check -> npm ci (worker/) -> wrangler login (the one manual step) -> D1 database ->
// worker/wrangler.toml -> migrations -> token + VAPID keys -> deploy (code + secrets together) -> health
// check -> desktop config -> pairing link + QR.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, chmodSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ReadStream } from 'node:tty';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { workerName: 'saqme', yes: false, rotateToken: false, deviceLogin: false, skipInstall: false };
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
  constructor(message, next) { super(message); this.next = next; }
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

async function ask(question, { yes, fallback = '' } = {}) {
  const term = yes ? null : terminalInput();
  if (!term) return fallback;
  const rl = createInterface({ input: term.input, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`      ${question} `, r));
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

function installDeps(workerDir, skip) {
  if (skip) { say.ok('tools: skipped'); return; }
  const marker = join(workerDir, 'node_modules', '.saqme-lock');
  const lock = readFileSync(join(workerDir, 'package-lock.json'), 'utf8');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === lock) { say.ok('tools already installed'); return; }
  say.info('installing the Cloudflare tools (wrangler) - about a minute the first time...');
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: workerDir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new SetupError('npm could not install the tools.', 'Check the internet connection (and proxy settings), then run setup again.');
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
    say.info('Log in to Cloudflare: a browser window opens - sign in (or create a free account) and click "Allow".');
    say.info('This is the only step setup cannot do for you.');
    const args = ['login'];
    if (opts.deviceLogin) args.push('--device');
    const r = await run(workerDir, args, { interactive: true });
    if (r.code !== 0) throw new SetupError('Cloudflare login did not finish.', 'Run setup again; if no browser opens, add --device-login (setup.ps1: -DeviceLogin) to log in with a code.');
    me = await whoami(workerDir);
    if (!me) throw new SetupError('Still not logged in to Cloudflare.', 'Run setup again and approve the login in the browser.');
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

async function ensureDatabase(workerDir, name, accountEnv) {
  const list = async () => {
    const r = await run(workerDir, ['d1', 'list', '--json'], { env: accountEnv });
    if (r.code !== 0) throw new SetupError('Could not list your D1 databases.', `Wrangler said:\n${lastLines(r.out)}`);
    try { return JSON.parse(r.out.slice(r.out.indexOf('['))); } catch { throw new SetupError('Unexpected answer from "wrangler d1 list".', lastLines(r.out)); }
  };
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

async function applyMigrations(workerDir, db, accountEnv) {
  const r = await run(workerDir, ['d1', 'migrations', 'apply', db.name, '--remote'], { env: accountEnv });
  if (r.code !== 0) throw new SetupError('Could not set up the database tables.', `Wrangler said:\n${lastLines(r.out)}`);
  say.ok(/No migrations to apply/i.test(r.out) ? 'database tables up to date' : 'database tables created');
}

async function loadOrCreateSecrets(state, rotate) {
  const out = { token: state.token, vapidPublicKey: state.vapidPublicKey, vapidPrivateKey: state.vapidPrivateKey };
  if (!out.token || rotate) { out.token = randomBytes(32).toString('base64url'); say.ok(rotate ? 'new access token issued' : 'access token generated'); }
  else say.ok('reusing your access token');
  if (!out.vapidPublicKey || !out.vapidPrivateKey || rotate) {
    // new push keys on a rotation too: notifications to phones subscribed with the old ones stop
    const { generateVapidKeys } = await import('../worker/src/push.js');
    const k = await generateVapidKeys();
    out.vapidPublicKey = k.publicKey; out.vapidPrivateKey = k.privateKey;
    say.ok(rotate ? 'new push notification keys issued' : 'push notification keys generated');
  } else say.ok('reusing your push notification keys');
  return out;
}

// after a rotation: the phones that subscribed with the old key get nothing more (a lost phone included)
async function forgetPushSubscriptions(workerDir, db, accountEnv) {
  const r = await run(workerDir, ['d1', 'execute', db.name, '--remote', '--command', 'DELETE FROM push_subscriptions'], { env: accountEnv });
  if (r.code === 0) { say.ok('notification subscriptions of the old key removed'); return; }
  say.warn('Could not remove the old notification subscriptions; they no longer work with the new push keys anyway.');
  say.info(lastLines(r.out, 4).trim());
}

const SUBDOMAIN_HINT = /workers\.dev subdomain|register a workers\.dev|no workers\.dev subdomain|subdomain/i;

async function deploy(workerDir, secrets, accountEnv, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'saqme-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify({ AUTH_TOKEN: secrets.token, VAPID_PUBLIC_KEY: secrets.vapidPublicKey, VAPID_PRIVATE_KEY: secrets.vapidPrivateKey }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // code and secrets go up together, so the Worker never runs without its token
      const r = await run(workerDir, ['deploy', '--secrets-file', file], { env: accountEnv });
      const text = stripAnsi(r.out);
      const url = (text.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i) || [])[0];
      if (r.code === 0 && url) { say.ok(`deployed to ${url}`); return url.replace(/\/$/, ''); }
      if (r.code === 0) {
        say.warn('Deployed, but wrangler did not print the address.');
        const pasted = await ask('Paste the https://...workers.dev address shown in the Cloudflare dashboard (Workers & Pages):', { yes: opts.yes });
        if (/^https:\/\/\S+$/.test(pasted)) return pasted.replace(/\/$/, '');
        throw new SetupError('No Worker address.', 'Open https://dash.cloudflare.com -> Workers & Pages -> saqme to see it, then run setup again.');
      }
      if (SUBDOMAIN_HINT.test(text) && attempt < 2) {
        say.warn('Your Cloudflare account needs a free workers.dev subdomain first (one time only).');
        say.info('Wrangler will now ask you to pick one (any name, e.g. your nickname).');
        say.info('If it does not ask: open https://dash.cloudflare.com -> Workers & Pages, pick a subdomain there, then come back.');
        const ri = await run(workerDir, ['deploy', '--secrets-file', file], { env: accountEnv, interactive: true });
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
  console.log('  4. In Saqme, Settings > Notifications > Enable.');
  console.log(pairAgain ? `  (Show this code again any time with: ${pairAgain})\n` : '  (The desktop app shows this QR code again under Settings > Sync > Pair phone.)\n');
}

// ---------------------------------------------------------------- main
function writeResult(path, result) {
  if (!path) return;
  try { writePrivateJson(path, result); } catch { /* the caller then sees no result: "did not finish" */ }
}

async function main(opts) {
  if (opts.help || !opts.state) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 16).map((l) => l.slice(3)).join('\n'));
    process.exit(opts.help ? 0 : 2);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(opts.workerName)) throw new SetupError(`"${opts.workerName}" is not a valid Worker name.`, 'Use lowercase letters, digits and dashes.');
  const workerDir = resolve(opts.workerDir || join(repo, 'worker'));
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
  await applyMigrations(workerDir, db, accountEnv);

  say.step(4, total, 'Keys');
  if (db.existed && !state.token && !opts.rotateToken) {
    // set up from another machine: its token cannot be read back, and a new one would unpair every device
    throw new SetupError('Saqme is already set up in this Cloudflare account (from another computer).',
      'To connect this PC, copy the pairing link on a device that already syncs (desktop: Settings > Sync > Pair phone > Copy link)\n'
      + '          and paste it into this PC\'s Settings > Sync. To start over with a new key instead (all devices pair again,\n'
      + '          phones re-enable notifications), run setup with -RotateToken (setup.sh: --rotate-token).');
  }
  const secrets = await loadOrCreateSecrets(state, opts.rotateToken);
  Object.assign(state, secrets);
  writePrivateJson(opts.state, state);   // saved before deploying, so a failure never loses them

  say.step(5, total, 'Deploying the sync service + phone app');
  const url = await deploy(workerDir, secrets, accountEnv, opts);
  Object.assign(state, { url, updatedAt: new Date().toISOString() });
  writePrivateJson(opts.state, state);

  say.step(6, total, 'Checking it works');
  const reachable = await verify(url, secrets.token);
  if (opts.desktopConfig) writeDesktopConfig(opts.desktopConfig, url, secrets.token);
  else say.info('(no desktop app on this machine - on Windows, paste the link below into Settings > Sync)');
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
  writeResult(opts.result, e instanceof SetupError ? { ok: false, message: e.message, next: e.next ?? '' } : { ok: false, message: `Setup failed unexpectedly: ${e.message ?? e}`, next: 'Running setup again is safe.' });
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
