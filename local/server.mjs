// The Linux/macOS app's local server, on 127.0.0.1 only: serves the phone app (worker/public, same files as
// on Cloudflare) and the sync API, run by the Worker's own code (worker/src) on a local SQLite database.
// Plus a few local-only routes:
//   GET  /api/health              public; says "local" so an unpaired window knows where it is
//   GET  /api/config              the Worker's answer plus `local` (lists folder, cloud sync status)
//   POST /api/local/code          one-time code for opening a window (`saqme open`), needs the token
//   POST /api/local/claim         { code } -> { token }: how a window started by `saqme open` pairs itself
//   GET  /api/local/pairing       { link, code } that pair a phone with the cloud sync (when set up); code is a
//                                  one-time pairing code from the cloud service (null when it can't be reached)
//   POST /api/local/connect       { link }: start cloud sync with a pairing link from another device
//   POST /api/local/cloud-setup   Settings > Sync & sharing > Set up sync: run the cloud setup (GET: its progress;
//                                  POST /api/local/cloud-setup/cancel stops it)
//   POST /api/local/disconnect    Settings > Sync & sharing > Advanced > Turn off sync (the lists stay)
//   POST /api/local/allow-deletes confirm a paused mass delete in the lists folder
//   POST /api/local/restore-deletes put the tasks of a paused mass delete back into their lists instead
//   POST /api/local/stop          shut down (used by setup when updating)
// Updates (local/updater.mjs), for Settings > Updates and `saqme update`:
//   GET  /api/local/update        what it knows: this version, the newest one, what an update is doing, how it ended
//   POST /api/local/update/check  look now;  POST /api/local/update/now  install the newest one now
//   POST /api/local/update/auto   { on }: "Install updates automatically"
//   POST /api/local/update/login  sign in to Cloudflare (to finish updating the Worker); /update/worker tries that again
//   GET  /api/local/worker-update, POST .../token | auto | now: the sync service updating itself, passed on to the
//                                  Worker's own /api/update routes with this computer's key (worker/src/selfupdate.js)
// Shared lists (local/shares.mjs, docs/sync.md "Shared lists"):
//   POST /api/local/join          { link }: join a list from its invite link -> { id, name }
//   POST /api/local/leave         { id }: leave one (its file goes to lists/.trash)
//   POST /api/local/notices/dismiss { id }: forget a change a shared list's server did not take
//   POST /api/local/invite        { link }: an invite handed over by `saqme invite` (a saqme:// link): the window asks
//   POST /api/local/invite/decline
//   GET  /api/local/shares?project=<id>, POST /api/local/shares/invite | update | revoke: sharing one of this
//                                  computer's lists, through its cloud sync (the window's project ids)
// /api/shares* and /api/remotes* of the Worker code are not served here: lists are shared from one's cloud sync
// service only, and lists shared with this computer are synced by the app itself.
// Requests for any other host name are refused (DNS rebinding), and nothing sends CORS headers, so other
// web sites cannot use this server even though it listens on the same machine.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import worker, { authorized } from '../worker/src/index.js';
import { API_VERSION } from '../worker/src/version.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 2_000_000;
const CODE_TTL = 120_000;

/** worker/public/_headers (Cloudflare's format): path pattern lines, then indented "Name: value" lines. */
function readHeaderRules(publicDir) {
  const rules = [];
  let cur = null;
  let text = '';
  try { text = readFileSync(join(publicDir, '_headers'), 'utf8'); } catch { return rules; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: {} }; rules.push(cur); continue; }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (m && cur) cur.headers[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return rules;
}
function headersFor(rules, path) {
  const out = {};
  for (const r of rules) {
    const hit = r.pattern.endsWith('*') ? path.startsWith(r.pattern.slice(0, -1)) : path === r.pattern;
    if (hit) Object.assign(out, r.headers);
  }
  return out;
}

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * opts = { port, token, d1, publicDir, info() -> object for `local`, onSync() (a client sent changes),
 *          onAllowDeletes(), onRestoreDeletes(), onStop(), version }
 * Resolves to { server, port, url, close() } once listening.
 */
export function startServer(opts) {
  const { token, d1, publicDir } = opts;
  const env = { DB: d1, AUTH_TOKEN: token };
  const rules = readHeaderRules(publicDir);
  const codes = new Map();   // code -> expiry
  const allowedHosts = (port) => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  let hosts = null;

  const toRequest = (req, body) => new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method, headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    body: body && body.length && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
  });

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
    const body = req.method === 'POST' ? await readBody(req) : null;
    const request = toRequest(req, body);
    if (route === 'GET /api/health') return json(res, 200, { ok: true, version: opts.version, api: API_VERSION, local: true });
    if (route === 'POST /api/local/claim') {
      let code = '';
      try { code = String(JSON.parse(body.toString('utf8')).code ?? ''); } catch { /* bad JSON */ }
      const exp = codes.get(code);
      codes.delete(code);
      if (!exp || exp < Date.now()) return json(res, 403, { error: 'this link has expired - open Saqme again' });
      return json(res, 200, { token });
    }
    if (!(await authorized(request, env))) return json(res, 401, { error: 'unauthorized' });
    switch (route) {
      case 'GET /api/config': return json(res, 200, { vapidPublicKey: null, version: opts.version, api: API_VERSION, local: opts.info() });
      case 'GET /api/local': return json(res, 200, opts.info());
      case 'POST /api/local/code': {
        const now = Date.now();
        for (const [c, exp] of codes) if (exp < now) codes.delete(c);
        const code = randomBytes(16).toString('base64url');
        codes.set(code, now + CODE_TTL);
        return json(res, 200, { code });
      }
      case 'GET /api/local/pairing': {
        const link = opts.pairingLink?.() ?? null;
        return json(res, 200, { link, code: link ? (await opts.pairingCode?.()) ?? null : null });
      }
      case 'POST /api/local/connect': {
        let link = '';
        try { link = String(JSON.parse(body.toString('utf8')).link ?? ''); } catch { /* bad JSON */ }
        try { return json(res, 200, { url: opts.connect(link) }); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      case 'POST /api/local/allow-deletes': opts.onAllowDeletes?.(); return json(res, 200, { ok: true });
      case 'POST /api/local/restore-deletes': opts.onRestoreDeletes?.(); return json(res, 200, { ok: true });
      case 'GET /api/local/cloud-setup': return json(res, 200, opts.cloudSetup.status());
      case 'POST /api/local/cloud-setup':
        try { return json(res, 200, opts.cloudSetup.start()); } catch (e) { return json(res, 400, { error: e.message }); }
      case 'POST /api/local/cloud-setup/cancel': opts.cloudSetup.cancel(); return json(res, 200, opts.cloudSetup.status());
      case 'POST /api/local/disconnect': opts.disconnect(); return json(res, 200, { ok: true });
      case 'POST /api/local/stop': json(res, 200, { ok: true }); setTimeout(() => opts.onStop?.(), 50); return undefined;
    }
    if (opts.updates && (route === 'GET /api/local/update' || route.startsWith('POST /api/local/update/'))) {
      let b = {};
      try { b = body?.length ? JSON.parse(body.toString('utf8')) : {}; } catch { /* bad JSON: empty */ }
      const u = opts.updates;
      const run = {
        'GET /api/local/update': () => u.status(),
        'POST /api/local/update/check': () => u.check(),
        'POST /api/local/update/now': () => u.now(),
        'POST /api/local/update/auto': () => u.auto(b.on !== false),
        'POST /api/local/update/login': () => u.login(),
        'POST /api/local/update/worker': () => u.worker(),
      }[route];
      if (run) {
        try { return json(res, 200, await run()); } catch (e) { return json(res, 500, { error: e.message }); }
      }
    }
    if (opts.workerUpdate && (route === 'GET /api/local/worker-update' || route.startsWith('POST /api/local/worker-update/'))) {
      let b = {};
      try { b = body?.length ? JSON.parse(body.toString('utf8')) : {}; } catch { /* bad JSON: empty */ }
      const w = opts.workerUpdate;
      const run = {
        'GET /api/local/worker-update': () => w.status(),
        'POST /api/local/worker-update/token': () => w.token(String(b.token ?? '')),
        'POST /api/local/worker-update/auto': () => w.auto(b.on !== false),
        'POST /api/local/worker-update/now': () => w.now(),
      }[route];
      if (run) {
        try { return json(res, 200, await run()); } catch (e) { return json(res, e.status ?? 500, { error: e.message }); }
      }
    }
    if (opts.sharing && (route.startsWith('POST /api/local/') || route === 'GET /api/local/shares')) {
      let b = {};
      try { b = body?.length ? JSON.parse(body.toString('utf8')) : {}; } catch { /* bad JSON: empty */ }
      const s = opts.sharing;
      const run = {
        'POST /api/local/join': () => s.join(String(b.link ?? '')),
        'POST /api/local/leave': () => s.leave(String(b.id ?? '')),
        'POST /api/local/notices/dismiss': () => s.dismiss(String(b.id ?? '')),
        'POST /api/local/invite': () => s.offer(String(b.link ?? '')),
        'POST /api/local/invite/decline': () => s.decline(),
        'GET /api/local/shares': () => s.list(url.searchParams.get('project') ?? ''),
        'POST /api/local/shares/invite': () => s.invite({ projectId: String(b.projectId ?? ''), alias: b.alias, access: b.access }),
        'POST /api/local/shares/update': () => s.update({ id: b.id, access: b.access }),
        'POST /api/local/shares/revoke': () => s.revoke({ id: b.id }),
      }[route];
      if (run) {
        try { return json(res, 200, await run()); } catch (e) { return json(res, e.status ?? 400, { error: e.message }); }
      }
    }
    if (url.pathname.startsWith('/api/shares')) return json(res, 404, { error: 'lists are shared through your cloud sync (Settings, Sync & sharing)' });
    // (lists others share with this computer are synced by the app itself, local/shares.mjs, not relayed)
    if (url.pathname.startsWith('/api/remotes')) return json(res, 404, { error: 'shared lists are joined in the window\'s Settings, Sync & sharing (or saqme join)' });
    if (url.pathname.startsWith('/api/push/')) return json(res, 404, { error: 'push is not used by the desktop app; reminders show as desktop notifications' });
    if (url.pathname.startsWith('/api/pair/')) return json(res, 404, { error: 'pairing codes come from the cloud sync service (Settings > Sync & sharing > Pair a phone)' });
    if (req.method === 'OPTIONS') { res.writeHead(405); res.end(); return undefined; }   // no CORS: this server is for its own window only
    const response = await worker.fetch(request, env);
    if (route === 'POST /api/sync' && response.ok) {
      try { if (JSON.parse(body.toString('utf8')).changes?.length) opts.onSync?.(); } catch { /* not JSON: the Worker said so */ }
    }
    res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([k]) => !k.startsWith('access-control-'))));
    res.end(Buffer.from(await response.arrayBuffer()));
    return undefined;
  }

  function file(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const full = normalize(join(publicDir, path));
    if (!full.startsWith(publicDir + sep) || path.split('/').some((p) => p.startsWith('.') || p === '_headers')) { res.writeHead(404); res.end(); return; }
    let data;
    try { if (!statSync(full).isFile()) throw new Error('not a file'); data = readFileSync(full); } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const headers = { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...headersFor(rules, path === '/index.html' ? '/index.html' : path) };
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = createServer(async (req, res) => {
    if (!hosts?.has(req.headers.host ?? '')) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden host'); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else file(req, res, url);
    } catch (e) {
      if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) console.error(e?.stack ?? e);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      hosts = allowedHosts(port);
      resolve({ server, port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
