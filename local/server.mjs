// The Linux/macOS app's local server, on 127.0.0.1 only: serves the phone app (worker/public, same files as
// on Cloudflare) and the sync API, run by the Worker's own code (worker/src) on a local SQLite database.
// Plus a few local-only routes:
//   GET  /api/health              public; says "local" so an unpaired window knows where it is
//   GET  /api/config              the Worker's answer plus `local` (lists folder, cloud sync status)
//   POST /api/local/code          one-time code for opening a window (`saqme open`), needs the token
//   POST /api/local/claim         { code } -> { token }: how a window started by `saqme open` pairs itself
//   GET  /api/local/pairing       { link } that pairs a phone with the cloud sync (when set up)
//   POST /api/local/connect       { link }: start cloud sync with a pairing link from another device
//   POST /api/local/cloud-setup   Settings > Sync > Set up sync: run the cloud setup (GET: its progress;
//                                  POST /api/local/cloud-setup/cancel stops it)
//   POST /api/local/disconnect    Settings > Sync > Turn off sync (the lists stay)
//   POST /api/local/allow-deletes confirm a paused mass delete in the lists folder
//   POST /api/local/stop          shut down (used by setup when updating)
// Requests for any other host name are refused (DNS rebinding), and nothing sends CORS headers, so other
// web sites cannot use this server even though it listens on the same machine.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import worker, { authorized } from '../worker/src/index.js';

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
 *          onAllowDeletes(), onStop(), version }
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
    if (route === 'GET /api/health') return json(res, 200, { ok: true, version: opts.version, local: true });
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
      case 'GET /api/config': return json(res, 200, { vapidPublicKey: null, version: opts.version, local: opts.info() });
      case 'GET /api/local': return json(res, 200, opts.info());
      case 'POST /api/local/code': {
        const now = Date.now();
        for (const [c, exp] of codes) if (exp < now) codes.delete(c);
        const code = randomBytes(16).toString('base64url');
        codes.set(code, now + CODE_TTL);
        return json(res, 200, { code });
      }
      case 'GET /api/local/pairing': return json(res, 200, { link: opts.pairingLink?.() ?? null });
      case 'POST /api/local/connect': {
        let link = '';
        try { link = String(JSON.parse(body.toString('utf8')).link ?? ''); } catch { /* bad JSON */ }
        try { return json(res, 200, { url: opts.connect(link) }); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      case 'POST /api/local/allow-deletes': opts.onAllowDeletes?.(); return json(res, 200, { ok: true });
      case 'GET /api/local/cloud-setup': return json(res, 200, opts.cloudSetup.status());
      case 'POST /api/local/cloud-setup':
        try { return json(res, 200, opts.cloudSetup.start()); } catch (e) { return json(res, 400, { error: e.message }); }
      case 'POST /api/local/cloud-setup/cancel': opts.cloudSetup.cancel(); return json(res, 200, opts.cloudSetup.status());
      case 'POST /api/local/disconnect': opts.disconnect(); return json(res, 200, { ok: true });
      case 'POST /api/local/stop': json(res, 200, { ok: true }); setTimeout(() => opts.onStop?.(), 50); return undefined;
    }
    if (url.pathname.startsWith('/api/push/')) return json(res, 404, { error: 'push is not used by the desktop app; reminders show as desktop notifications' });
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
