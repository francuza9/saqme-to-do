// Shared lists: one project of this Worker's owner that other people sync too, each with a key of their own
// that reaches that one project and nothing else (see docs/sync.md, "Shared lists").
//
//   the owner (Authorization: Bearer <AUTH_TOKEN>)
//     POST /api/shares/invite   { projectId, alias, access } -> { share, code, link, expiresAt }
//     GET  /api/shares          ?project=<id> -> { shares: [...] }  (every project without ?project)
//     POST /api/shares/update   { id, access } -> { share }
//     POST /api/shares/revoke   { id } -> { ok }   (an invite nobody claimed yet: cancels it)
//   the person invited, without a key
//     POST /api/shares/claim    { code } -> { token, projectId, projectName, access, ownerUrl, kind }
//   with the key it got (Authorization: Bearer <share token>): POST /api/sync for that project only, and
//     POST /api/shares/leave     ends that key (the person left the list on their device)
//     POST /api/shares/transfer  -> { link, expiresAt }: a one-time move code for the same share ("Move to my
//                                Saqme app"); claiming it gives a new key (kind 'move') and the old one ends
//     GET  /api/config, POST /api/push/subscribe | unsubscribe | test: reminders of that one list (share_push)
//
// An invite is a one-time code in a link, https://<this Worker>/join#code=<code>: after the '#', so it never
// reaches a server log. The code is 128 random bits; it works once, for INVITE_TTL, until the owner cancels it.
// Claiming is one UPDATE that only matches an open invite, so two claims cannot both win, and a wrong code
// writes nothing (strangers cannot run up the database's write quota, and there is nothing to guess). Only
// SHA-256 digests of codes and keys are stored. Revoking sets revoked_at, and the key stops working at once:
// every request looks it up. A key a move replaced answers 401 'transferred', so its app knows the list
// moved (and does not take it for revoked).
import { cleanText } from '../public/js/markdown.js';
import { normalizeTime, isValidTimeZone } from './merge.js';

export const INVITE_TTL = 24 * 3600_000;
export const MAX_SHARES_PER_PROJECT = 50;
export const MAX_ALIAS = 60;
export const ACCESS = ['edit', 'view'];
const ID_RE = /^[0-9a-z]{8,32}$/;
const SHARE_ID_RE = /^s[0-9a-z]{15}$/;
const CODE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export class ShareError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomB64 = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
function randomShareId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = 's';
  for (const b of crypto.getRandomValues(new Uint8Array(15))) out += alphabet[b % 36];   // 36 * 7 = 252: tiny bias, fine for an id
  return out;
}

export async function digestHex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the owner's apps see of a share. */
export function shareView(r, now = Date.now()) {
  let state = 'pending';
  if (r.claimed_at) state = 'joined';
  else if (r.invite_expires_at <= now) state = 'expired';
  return {
    id: r.id, projectId: r.project_id, alias: r.alias, access: r.access, state,
    createdAt: r.created_at, joinedAt: r.claimed_at ?? null, expiresAt: r.claimed_at ? null : r.invite_expires_at,
  };
}

function cleanAlias(v) {
  const a = typeof v === 'string' ? cleanText(v) : '';
  if (!a) throw new ShareError(400, 'Give the person a name, so you can recognise them later.');
  if (a.length > MAX_ALIAS) throw new ShareError(400, `The name can have at most ${MAX_ALIAS} characters.`);
  return a;
}
function checkAccess(v) {
  if (!ACCESS.includes(v)) throw new ShareError(400, "access must be 'edit' or 'view'");
  return v;
}

/** POST /api/shares/invite */
export async function createInvite(env, body, origin, now = Date.now()) {
  const projectId = body?.projectId;
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) throw new ShareError(400, 'bad projectId');
  const alias = cleanAlias(body.alias);
  const access = checkAccess(body.access);
  const [project, count] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, deleted FROM projects WHERE id = ?1').bind(projectId),
    env.DB.prepare('SELECT count(*) AS n FROM shares WHERE project_id = ?1 AND revoked_at IS NULL').bind(projectId),
  ]);
  const p = project.results[0];
  if (!p || p.deleted) throw new ShareError(404, 'This list is not on the sync service yet. Sync, then try again.');
  if (count.results[0].n >= MAX_SHARES_PER_PROJECT) throw new ShareError(409, `A list can be shared with at most ${MAX_SHARES_PER_PROJECT} people.`);
  const code = randomB64(16);
  const id = randomShareId();
  const row = {
    id, project_id: projectId, alias, access, token_hash: null, invite_code_hash: await digestHex(code),
    invite_expires_at: now + INVITE_TTL, claimed_at: null, revoked_at: null, created_at: now,
  };
  await env.DB.prepare(`INSERT INTO shares (id, project_id, alias, access, invite_code_hash, invite_expires_at, created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(row.id, row.project_id, row.alias, row.access, row.invite_code_hash, row.invite_expires_at, row.created_at).run();
  return { share: shareView(row, now), code, link: `${origin}/join#code=${code}`, expiresAt: row.invite_expires_at };
}

/** GET /api/shares[?project=] — everyone a list is shared with, and the invites still open or expired. */
export async function listShares(env, projectId, now = Date.now()) {
  if (projectId != null && !ID_RE.test(projectId)) throw new ShareError(400, 'bad project');
  // (oldest first; rowid keeps invites made in the same millisecond in the order they were made)
  const stmt = projectId
    ? env.DB.prepare('SELECT * FROM shares WHERE project_id = ?1 AND revoked_at IS NULL ORDER BY created_at, rowid').bind(projectId)
    : env.DB.prepare('SELECT * FROM shares WHERE revoked_at IS NULL ORDER BY created_at, rowid');
  const { results } = await stmt.all();
  return { shares: results.map((r) => shareView(r, now)) };
}

/** POST /api/shares/update — the person's access, taking effect with their next sync. */
export async function updateShare(env, body, now = Date.now()) {
  if (typeof body?.id !== 'string' || !SHARE_ID_RE.test(body.id)) throw new ShareError(400, 'bad id');
  const access = checkAccess(body.access);
  const r = await env.DB.prepare('UPDATE shares SET access = ?2 WHERE id = ?1 AND revoked_at IS NULL RETURNING *').bind(body.id, access).first();
  if (!r) throw new ShareError(404, 'not shared with that person any more');
  return { share: shareView(r, now) };
}

/** POST /api/shares/revoke — their key stops working now; an open invite can no longer be claimed. */
export async function revokeShare(env, body, now = Date.now()) {
  if (typeof body?.id !== 'string' || !SHARE_ID_RE.test(body.id)) throw new ShareError(400, 'bad id');
  const r = await env.DB.prepare('UPDATE shares SET revoked_at = ?2, invite_code_hash = NULL WHERE id = ?1 AND revoked_at IS NULL RETURNING id')
    .bind(body.id, now).first();
  if (!r) throw new ShareError(404, 'not shared with that person any more');
  await env.DB.prepare('DELETE FROM share_push WHERE share_id = ?1').bind(body.id).run();
  return { ok: true };
}

/** POST /api/shares/leave, with the person's own key: they left the list, so the key ends (nothing else changes). */
export async function leaveShare(env, shareId, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare('UPDATE shares SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL').bind(shareId, now),
    env.DB.prepare('DELETE FROM share_push WHERE share_id = ?1').bind(shareId),
  ]);
  return { ok: true };
}

/**
 * POST /api/shares/claim — the invite code for a key of the person's own (once). A move code (from
 * /api/shares/transfer) gives the same share a new key instead: kind 'move'; the old key then answers 401
 * 'transferred', the share's browser reminders go (their new app reminds them), and it counts as not relayed.
 */
export async function claimInvite(env, body, origin, now = Date.now()) {
  const code = body?.code;
  const bad = new ShareError(400, 'This invite was already used, has expired or was cancelled. Ask for a new one.');
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw bad;
  const token = randomB64(32);
  // (old_token_hash, transferred_at, relayed_at on the right are the values before this UPDATE)
  const claimed = await env.DB.prepare(
    `UPDATE shares SET claimed_at = COALESCE(claimed_at, ?3), token_hash = ?2, invite_code_hash = NULL,
            old_token_hash = CASE WHEN token_hash IS NULL THEN old_token_hash ELSE token_hash END,
            transferred_at = CASE WHEN token_hash IS NULL THEN transferred_at ELSE ?3 END,
            relayed_at = CASE WHEN token_hash IS NULL THEN relayed_at ELSE NULL END
      WHERE invite_code_hash = ?1 AND revoked_at IS NULL AND invite_expires_at > ?3
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = shares.project_id AND p.deleted = 0)
      RETURNING id, project_id, access, transferred_at`,
  ).bind(await digestHex(code), await digestHex(token), now).first();
  if (!claimed) throw bad;
  const moved = claimed.transferred_at === now;
  const [name] = await env.DB.batch([
    env.DB.prepare('SELECT name FROM projects WHERE id = ?1').bind(claimed.project_id),
    ...(moved ? [env.DB.prepare('DELETE FROM share_push WHERE share_id = ?1').bind(claimed.id)] : []),
  ]);
  return {
    token, projectId: claimed.project_id, projectName: name.results[0]?.name ?? '', access: claimed.access, ownerUrl: origin,
    kind: moved ? 'move' : 'join',
  };
}

/** POST /api/shares/transfer, with the person's key: a one-time move code for their share (the same TTL). */
export async function createMoveCode(env, share, origin, now = Date.now()) {
  const code = randomB64(16);
  const r = await env.DB.prepare('UPDATE shares SET invite_code_hash = ?2, invite_expires_at = ?3 WHERE id = ?1 AND revoked_at IS NULL RETURNING id')
    .bind(share.id, await digestHex(code), now + INVITE_TTL).first();
  if (!r) throw new ShareError(404, 'not shared any more');
  return { code, link: `${origin}/join#code=${code}`, expiresAt: now + INVITE_TTL };
}

/**
 * The share a bearer token belongs to: { share } (its row), { revoked: true } for a key that was revoked,
 * { transferred: true } for one a move replaced, or null when it is no share key at all.
 */
export async function shareForToken(env, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const h = await digestHex(token);
  const [cur, old] = await env.DB.batch([
    env.DB.prepare('SELECT id, project_id, access, revoked_at, relayed_at FROM shares WHERE token_hash = ?1').bind(h),
    env.DB.prepare('SELECT id FROM shares WHERE old_token_hash = ?1').bind(h),
  ]);
  const r = cur.results[0];
  if (!r) return old.results.length ? { transferred: true } : null;
  if (r.revoked_at) return { revoked: true };
  return { share: { id: r.id, projectId: r.project_id, access: r.access, relayedAt: r.relayed_at ?? 0 } };
}

/**
 * The key was used through its person's own Worker (header x-saqme-relay): that Worker reminds them, so this one
 * stops sending this share's pushes. Written at most once an hour.
 */
export async function markRelayed(env, share, now = Date.now()) {
  if (share.relayedAt > now - 3600_000) return;
  await env.DB.prepare('UPDATE shares SET relayed_at = ?2 WHERE id = ?1').bind(share.id, now).run();
}

// ---------------------------------------------------------------- reminders for someone without a Worker
/**
 * POST /api/push/subscribe with a share's key: { subscription, tz, notifyAt } -> reminders of that one list, in
 * the person's own time zone and at their own summary time. The caller checked the endpoint (isPushService).
 */
export async function subscribeSharePush(env, share, body, now = Date.now()) {
  const s = body.subscription;
  const tz = isValidTimeZone(body.tz) ? body.tz : 'UTC';
  const notifyAt = normalizeTime(body.notifyAt) ?? '10:00';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO share_push (share_id, endpoint, p256dh, auth, tz, notify_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(share_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz,
        notify_at = excluded.notify_at, failures = 0`).bind(share.id, s.endpoint, s.keys.p256dh, s.keys.auth, tz, notifyAt, now),
    // at most 10 browsers per share (a key cannot fill the table)
    env.DB.prepare('DELETE FROM share_push WHERE share_id = ?1 AND rowid NOT IN (SELECT rowid FROM share_push WHERE share_id = ?1 ORDER BY created_at DESC LIMIT 10)').bind(share.id),
  ]);
  return { ok: true };
}
export async function unsubscribeSharePush(env, share, endpoint) {
  await env.DB.prepare('DELETE FROM share_push WHERE share_id = ?1 AND endpoint = ?2').bind(share.id, String(endpoint ?? '')).run();
  return { ok: true };
}

/** Projects with a share that is in use or still open: the owner's apps show a "shared" badge on them. */
export function sharedProjectsQuery(db, now) {
  return db.prepare('SELECT DISTINCT project_id FROM shares WHERE revoked_at IS NULL AND (claimed_at IS NOT NULL OR invite_expires_at > ?1)').bind(now);
}
