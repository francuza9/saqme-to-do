// Saqme To Do Worker: serves the PWA (static assets) and the single-user sync/push API.
//
//   GET  /api/health              { ok, version, api }: liveness and which release this is, no auth
//   GET  /api/config              { vapidPublicKey, version, api }
//   POST /api/sync                { deviceId, cursor, changes[] } -> { cursor, more, changes[], rejected[], serverTime, dbId, api, version }
//   POST /api/push/subscribe      { deviceId, subscription }
//   POST /api/push/unsubscribe    { endpoint }
//   POST /api/push/test           { endpoint? }
//   POST /api/pair/code           -> { code, expiresAt }: a one-time pairing code for a new phone (src/pairing.js)
//   POST /api/pair/claim          { code } -> { token }, no auth: what the phone app does with that code
//   POST /api/shares/invite       { projectId, alias, access } -> { share, code, link, expiresAt } (src/shares.js)
//   GET  /api/shares              ?project=<id> -> { shares }
//   POST /api/shares/update       { id, access };  POST /api/shares/revoke { id }
//   POST /api/shares/claim        { code } -> { token, projectId, projectName, access, ownerUrl, kind }, no auth
//   with a shared list's key (src/shares.js): POST /api/sync (that project only), /api/shares/leave,
//     /api/shares/transfer, GET /api/config, POST /api/push/subscribe | unsubscribe | test (that list's reminders)
//   POST /api/remotes/join | adopt, GET /api/remotes, POST /api/remotes/<id>/sync | leave: lists others share
//     with you, which this Worker syncs for your phone app (src/remotes.js)
//   GET  /api/update, POST /api/update/token | auto | now: the Worker updating itself (src/selfupdate.js)
//   GET  /api/connector, POST /api/connector/rotate | disconnect: the AI connector's address (src/connector.js)
//   POST /api/mcp/<key>           the AI connector itself, an MCP server (src/mcp.js): the key in the address is
//                                 its only credential (no Authorization header counts there, a shared list's key least of all)
// Every /api call except health, the two claims and /api/mcp needs `Authorization: Bearer <AUTH_TOKEN>`. A shared
// list's key works for the routes above only, and only for its one project; once revoked it gets 401 like a
// wrong key, and one replaced by a move gets 401 'transferred'.
// The API answers cross-origin requests too (CORS), so a copy of the app served from elsewhere (a static
// host such as GitHub Pages) can sync with this Worker. That gives other sites nothing: there are no
// cookies, and every call needs a key.
// `api` (src/version.js) lets apps that are older or newer than this Worker tell "not updated yet" from an
// error. The database updates itself on the first request or cron run after a deploy (src/schema.js).

import { handleSync, HttpError } from './sync.js';
import { VERSION, API_VERSION } from './version.js';
import { ensureSchema } from './schema.js';
import { pushToAll, pushToShare, runReminders } from './reminders.js';
import { createPairingCode, claimPairingCode } from './pairing.js';
import {
  claimInvite, createInvite, createMoveCode, leaveShare, listShares, markRelayed, revokeShare, shareForToken, sharedProjectsQuery,
  subscribeSharePush, unsubscribeSharePush, updateShare, ShareError,
} from './shares.js';
import { adoptRemote, joinRemote, leaveRemote, relaySync, remotesQuery, remoteView } from './remotes.js';
import { afterSchemaFailure, confirmUpdate, saveToken, scheduledUpdate, setAuto, startNow, updateStatus, UpdateError } from './selfupdate.js';
import { connectorAuthorized, connectorRateOk, connectorStatus, disconnectConnector, rotateConnector, RATE_LIMIT } from './connector.js';
import { handleMcp } from './mcp.js';

// The push services browsers use (Chrome and other Chromium browsers, Firefox, Safari, legacy Edge): the
// cron sends requests to subscription endpoints, so a subscription may only point at one of these.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
export function isPushService(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && PUSH_HOSTS.test(u.hostname);
  } catch { return false; }
}

const MAX_BODY = 1_000_000;
const RELEASE = { version: VERSION, api: API_VERSION };

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
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
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

/** { owner: true } for the owner's key, { share } for a shared list's key, { revoked: true }, or null. */
async function authenticate(request, env) {
  if (await authorized(request, env)) return { owner: true };
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') || '');
  return m ? shareForToken(env, m[1]) : null;
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

async function handleApi(request, env, url, ctx) {
  const route = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;
  if (route === 'GET /api/health') return json({ ok: true, ...RELEASE });
  if (route === 'POST /api/pair/claim') {
    const code = (await readJson(request))?.code;
    if (!env.AUTH_TOKEN || env.AUTH_TOKEN.length < 32 || !(await claimPairingCode(env, code))) {
      return json({ error: 'That code is wrong or has expired. Show a new one on the device that already syncs.' }, 400);
    }
    return json({ token: env.AUTH_TOKEN });
  }
  if (route === 'POST /api/shares/claim') return json(await claimInvite(env, await readJson(request), url.origin));
  // the AI connector: the key in the address is its credential; no Authorization header (owner's or a shared list's) counts
  const mcp = /^\/api\/mcp\/([^/]*)\/?$/.exec(url.pathname);
  if (mcp || url.pathname === '/api/mcp') {
    if (!mcp || !(await connectorAuthorized(env, mcp[1]))) {
      return json({ error: 'This Saqme connector address does not work (any more). Copy the current one from Saqme: Settings > Use with AI.' }, 404);
    }
    if (!(await connectorRateOk(env))) return json({ error: `Too many requests: at most ${RATE_LIMIT} a minute.` }, 429);
    return handleMcp(request, env);
  }
  const auth = await authenticate(request, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  if (auth.revoked) return json({ error: 'revoked', message: 'The owner stopped sharing this list with you.' }, 401);
  if (auth.transferred) return json({ error: 'transferred', message: 'This list moved to another of your apps.' }, 401);
  if (auth.share) return shareApi(request, env, url, route, auth.share);

  // lists others share with you, synced through this Worker for your phone app (src/remotes.js)
  const rm = /^POST \/api\/remotes\/([a-z0-9]+)\/(sync|leave)$/.exec(route);
  if (rm) {
    if (rm[2] === 'leave') return json(await leaveRemote(env, rm[1]));
    const r = await relaySync(env, rm[1], await readJson(request));
    return json(r.data, r.status);
  }

  switch (route) {
    case 'GET /api/config':
      return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY || null, ...RELEASE });

    case 'POST /api/sync': {
      // the owner's apps also learn which of their lists are shared (a badge on them), and their phone apps which
      // lists others share with them (kept here, src/remotes.js)
      const now = Date.now();
      return json(await handleSync(env, await readJson(request), {
        now, extra: [sharedProjectsQuery(env.DB, now), remotesQuery(env.DB)],
        annotate: ([s, r]) => ({ shared: s.results.map((x) => x.project_id), remotes: r.results.map(remoteView), ...RELEASE }),
      }));
    }

    case 'POST /api/remotes/join':
      return json(await joinRemote(env, await readJson(request), { self: url.origin }));
    case 'POST /api/remotes/adopt': {
      const r = await adoptRemote(env, await readJson(request));
      return json(r.data, r.status);
    }
    case 'GET /api/remotes':
      return json({ remotes: (await remotesQuery(env.DB).all()).results.map(remoteView) });

    case 'POST /api/shares/invite':
      return json(await createInvite(env, await readJson(request), url.origin));
    case 'GET /api/shares':
      return json(await listShares(env, url.searchParams.get('project')));
    case 'POST /api/shares/update':
      return json(await updateShare(env, await readJson(request)));
    case 'POST /api/shares/revoke':
      return json(await revokeShare(env, await readJson(request)));

    case 'POST /api/pair/code':
      return json(await createPairingCode(env));

    case 'GET /api/connector':
      return json(await connectorStatus(env, url.origin));
    case 'POST /api/connector/rotate':
      return json(await rotateConnector(env, url.origin));
    case 'POST /api/connector/disconnect':
      return json(await disconnectConnector(env, url.origin));

    case 'GET /api/update':
      await confirmUpdate(env);
      return json(await updateStatus(env));
    case 'POST /api/update/token':
      return json(await saveToken(env, (await readJson(request)).token));
    case 'POST /api/update/auto':
      return json(await setAuto(env, (await readJson(request)).on !== false));
    case 'POST /api/update/now':
      return json(await startNow(env, ctx));

    case 'POST /api/push/subscribe': {
      const body = await readJson(request);
      const s = checkSubscription(body);
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

/** A push subscription only for the push services browsers use, so the cron cannot be made to call elsewhere. */
function checkSubscription(body) {
  const s = body?.subscription;
  const ok = s && typeof s.endpoint === 'string' && isPushService(s.endpoint) && s.endpoint.length < 2048
    && typeof s.keys?.p256dh === 'string' && s.keys.p256dh.length < 200 && typeof s.keys?.auth === 'string' && s.keys.auth.length < 100;
  if (!ok) throw new HttpError(400, 'bad subscription');
  return s;
}

/**
 * A shared list's key: its project's sync and nothing more; the reminders of that list for someone using it
 * in the browser from this address (no Worker of their own); a move code for another of their apps; leaving.
 * No settings, no other list, no pairing or sharing: everything else answers 403.
 */
async function shareApi(request, env, url, route, share) {
  switch (route) {
    case 'POST /api/sync': {
      // used through its person's own Worker: that one reminds them of this list from now on (shares.js)
      if (request.headers.get('x-saqme-relay') === '1') await markRelayed(env, share);
      return json(await handleSync(env, await readJson(request), {
        scope: share, annotate: () => ({ share: { projectId: share.projectId, access: share.access }, ...RELEASE }),
      }));
    }
    case 'POST /api/shares/leave':
      return json(await leaveShare(env, share.id));
    case 'POST /api/shares/transfer':
      return json(await createMoveCode(env, share, url.origin));
    case 'GET /api/config':
      return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY || null, ...RELEASE });
    case 'POST /api/push/subscribe': {
      const body = await readJson(request);
      checkSubscription(body);
      await rememberOrigin(env, url.origin);
      return json(await subscribeSharePush(env, share, body));
    }
    case 'POST /api/push/unsubscribe':
      return json(await unsubscribeSharePush(env, share, (await readJson(request)).endpoint));
    case 'POST /api/push/test': {
      const body = await readJson(request);
      const only = typeof body.endpoint === 'string' ? body.endpoint : undefined;
      const r = await pushToShare(env, share.id, { title: 'Saqme To Do', body: 'Notifications are working.', tag: 'test', url: '/' }, { only });
      return json(r, r.error ? 503 : 200);
    }
  }
  return json({ error: 'not available with the key of a shared list' }, 403);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
    try {
      await ensureSchema(env.DB);
    } catch (e) {
      console.error('database update failed', e?.stack || e);
      // (a version that just updated itself goes back to the one before, whose database is as it was)
      ctx?.waitUntil?.(afterSchemaFailure(env, e).catch(() => {}));
      return json({
        error: 'Your sync service could not update its database. It tries again with the next request; if this stays, see Troubleshooting in docs/setup.md.',
        code: 'schema', detail: String(e?.message ?? e).slice(0, 300), ...RELEASE,
      }, 503);
    }
    try {
      return await handleApi(request, env, url, ctx);
    } catch (e) {
      if (e instanceof HttpError || e instanceof ShareError || e instanceof UpdateError) return json({ error: e.message }, e.status);
      console.error(e?.stack || e);
      return json({ error: 'internal error' }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    // a run that updates the Worker leaves the reminders to the next one (5 minutes later; late ones are still sent)
    const now = controller.scheduledTime;
    ctx.waitUntil(ensureSchema(env.DB)
      .catch(async (e) => { await afterSchemaFailure(env, e).catch(() => {}); throw e; })
      .then(async () => {
        const updated = await scheduledUpdate(env, { now }).catch((e) => { console.error('self-update failed', e); return false; });
        if (!updated) await runReminders(env, now);
      })
      .catch((e) => console.error('reminders failed', e)));
  },
};
