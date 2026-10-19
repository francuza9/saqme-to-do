// Saqme To Do Worker: serves the PWA (static assets) and the single-user sync/push API.
//
//   GET  /api/health              liveness, no auth
//   GET  /api/config              { vapidPublicKey, version }
//   POST /api/sync                { deviceId, cursor, changes[] } -> { cursor, more, changes[], rejected[], serverTime, dbId }
//   POST /api/push/subscribe      { deviceId, subscription }
//   POST /api/push/unsubscribe    { endpoint }
//   POST /api/push/test           { endpoint? }
//   POST /api/pair/code           -> { code, expiresAt }: a one-time pairing code for a new phone (src/pairing.js)
//   POST /api/pair/claim          { code } -> { token }, no auth: what the phone app does with that code
// Every /api call except health and pair/claim needs `Authorization: Bearer <AUTH_TOKEN>`.
// The API answers cross-origin requests too (CORS), so a copy of the app served from elsewhere (a static
// host such as GitHub Pages) can sync with this Worker. That gives other sites nothing: there are no
// cookies, and every call needs the token, which only paired devices have.

import { handleSync, HttpError } from './sync.js';
import { pushToAll, runReminders } from './reminders.js';
import { createPairingCode, claimPairingCode } from './pairing.js';

// The push services browsers use (Chrome and other Chromium browsers, Firefox, Safari, legacy Edge): the
// cron sends requests to subscription endpoints, so a subscription may only point at one of these.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
export function isPushService(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && PUSH_HOSTS.test(u.hostname);
  } catch { return false; }
}

const VERSION = '1.0.0';
const MAX_BODY = 1_000_000;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'access-control-allow-origin': '*',
};
const PREFLIGHT_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/** Constant-time token check (compares digests, so length differences leak nothing either). */
export async function authorized(request, env) {
  const expected = env.AUTH_TOKEN;
  if (!expected || expected.length < 32) return false;
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') || '');
  if (!m) return false;
  const [a, b] = await Promise.all([sha256(m[1]), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'request too large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'request too large');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

async function rememberOrigin(env, origin) {
  // used as the VAPID "sub" claim when the cron job sends pushes (Apple requires a real https/mailto URL)
  await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('origin', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(origin).run();
}

async function handleApi(request, env, url) {
  const route = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;
  if (route === 'GET /api/health') return json({ ok: true, version: VERSION });
  if (route === 'POST /api/pair/claim') {
    const code = (await readJson(request))?.code;
    if (!env.AUTH_TOKEN || env.AUTH_TOKEN.length < 32 || !(await claimPairingCode(env, code))) {
      return json({ error: 'That code is wrong or has expired. Show a new one on the device that already syncs.' }, 400);
    }
    return json({ token: env.AUTH_TOKEN });
  }
  if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

  switch (route) {
    case 'GET /api/config':
      return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY || null, version: VERSION });

    case 'POST /api/sync':
      return json(await handleSync(env, await readJson(request)));

    case 'POST /api/pair/code':
      return json(await createPairingCode(env));

    case 'POST /api/push/subscribe': {
      const body = await readJson(request);
      const s = body.subscription;
      const ok = s && typeof s.endpoint === 'string' && isPushService(s.endpoint) && s.endpoint.length < 2048
        && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
      if (!ok) throw new HttpError(400, 'bad subscription');
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
      await env.DB.prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, device_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device_id = excluded.device_id, failures = 0`,
      ).bind(s.endpoint, s.keys.p256dh, s.keys.auth, deviceId, Date.now()).run();
      await rememberOrigin(env, url.origin);
      return json({ ok: true });
    }

    case 'POST /api/push/unsubscribe': {
      const body = await readJson(request);
      if (typeof body.endpoint !== 'string') throw new HttpError(400, 'missing endpoint');
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(body.endpoint).run();
      return json({ ok: true });
    }

    case 'POST /api/push/test': {
      const body = await readJson(request);
      const only = typeof body.endpoint === 'string' ? body.endpoint : undefined;
      const r = await pushToAll(env, { title: 'Saqme To Do', body: 'Notifications are working.', tag: 'test', url: '/' }, { only });
      return json(r, r.error ? 503 : 200);
    }
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e?.stack || e);
      return json({ error: 'internal error' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runReminders(env, controller.scheduledTime).catch((e) => console.error('reminders failed', e)));
  },
};
