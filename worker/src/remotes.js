// Lists others share with you, kept by your own Worker (docs/sync.md, "Shared lists"). The phone app talks to
// its own Worker only (its security policy allows no other address), so this Worker talks to the owners'
// Workers for it, server to server, with the share keys it keeps (table remotes). Its cron reads those lists'
// deadlines too (remote_tasks), so they remind you like your own tasks do.
//
//   your own key (Authorization: Bearer <AUTH_TOKEN>):
//     POST /api/remotes/join          { link } -> { remote, kind }: claims the invite at its owner's Worker
//     POST /api/remotes/adopt         { server, token, name } -> { remote }: a list the app joined on its own
//                                      (in the browser, before it was paired) moves here
//     GET  /api/remotes               -> { remotes }   (also in every /api/sync answer, for your other phones)
//     POST /api/remotes/<id>/sync     a sync body -> the owner's answer, with its status
//     POST /api/remotes/<id>/leave    -> { ok }
//
// Not an open relay: only your own key can use it, and it only ever calls /api/shares/claim, /api/sync and
// /api/shares/leave, on an https origin checked when the list was joined (no user name, no port, no IP address
// or local name), with a timeout, size limits and no redirects. The owner's status comes back as it is; a 401
// (revoked, or moved to another of your apps) also ends the list here. Keys never leave this Worker.
import { HttpError } from './sync.js';
import { parseInviteLink } from '../public/js/pairing.js';
import { isValidDate, normalizeTime, STATUSES, MAX_TEXT } from './merge.js';
import { cleanText } from '../public/js/markdown.js';

export const RELAY_TIMEOUT = 20_000;
export const MAX_RELAY_ANSWER = 4_000_000;
const RELAY_PATHS = new Set(['/api/shares/claim', '/api/sync', '/api/shares/leave']);
const ID_RE = /^[0-9a-z]{8,32}$/;
const REMOTE_ID_RE = /^r[0-9a-z]{15}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * An address this Worker may talk to for you -> its origin, or null: https, a host name with a dot (no IP
 * address, no localhost / .local / .internal / .home.arpa), the default port, no user name, nothing after it.
 */
export function relayOrigin(text) {
  let u;
  try { u = new URL(String(text ?? '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || /@/.test(String(text))) return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || h.startsWith('[') || h.includes(':') || /^[0-9.]+$/.test(h)) return null;   // IP addresses
  if (/(^|\.)(localhost|local|internal|home\.arpa)$/.test(h)) return null;
  return u.origin;
}

/** Reads at most `max` bytes of a response; null when it is longer. */
async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) return null;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* gone */ } return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

/** One call to an owner's Worker: one of the three share routes, nowhere else. -> { status, data } */
export async function callOwner(server, path, { token = '', body = {} } = {}) {
  if (!RELAY_PATHS.has(path) || !server || relayOrigin(server) !== server) throw new HttpError(400, 'not a sync service this Worker talks to');
  const host = new URL(server).host;
  let res;
  try {
    res = await fetch(`${server}${path}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(RELAY_TIMEOUT), body: JSON.stringify(body ?? {}),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-saqme-relay': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  } catch { return { status: 502, data: { error: `Could not reach ${host}. Try again in a moment.` } }; }
  if (res.status >= 300 && res.status < 400) return { status: 502, data: { error: `${host} answered with a redirect, not like a Saqme sync service.` } };
  const text = await readCapped(res, MAX_RELAY_ANSWER);
  if (text == null) return { status: 502, data: { error: `${host} answered with too much data.` } };
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 502, data: { error: `${host} did not answer like a Saqme sync service.` } };
  return { status: res.status, data };
}

/** What the apps see of a remote (never its key). */
export function remoteView(r) {
  return { id: r.id, server: r.server, projectId: r.project_id, name: r.name, access: r.access, state: r.state, converted: !!r.converted };
}
export const remotesQuery = (db) => db.prepare('SELECT * FROM remotes ORDER BY created_at, rowid');

function randomRemoteId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = 'r';
  for (const b of crypto.getRandomValues(new Uint8Array(15))) out += alphabet[b % 36];
  return out;
}
const accessOf = (v) => (v === 'edit' ? 'edit' : 'view');
const nameOf = (v) => (typeof v === 'string' ? cleanText(v).slice(0, 120) : '');

async function insertRemote(env, { server, token, projectId, name, access }, now) {
  const row = { id: randomRemoteId(), server, token, project_id: projectId, name, access, state: 'active', converted: 0, cursor: 0, polled_at: 0, created_at: now, updated_at: now };
  await env.DB.prepare(`INSERT INTO remotes (id, server, token, project_id, name, access, state, created_at, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)`).bind(row.id, server, token, projectId, name, access, now).run();
  return row;
}

/** POST /api/remotes/join. self: this Worker's own origin (its own lists are not joined). */
export async function joinRemote(env, body, { self = '', now = Date.now() } = {}) {
  const inv = parseInviteLink(body?.link);
  if (!inv) throw new HttpError(400, 'That is not an invite link (it looks like https://…/join#code=…).');
  const server = relayOrigin(inv.server);
  if (!server) throw new HttpError(400, 'Your sync service only joins lists from an https address with a name (like https://saqme.<name>.workers.dev).');
  if (server === self) throw new HttpError(409, 'That invite is for one of your own lists.');
  const r = await callOwner(server, '/api/shares/claim', { body: { code: inv.code } });
  const d = r.data;
  if (r.status !== 200) throw new HttpError(r.status === 400 ? 400 : 502, d.error || `The invite did not work (${r.status}).`);
  if (typeof d.token !== 'string' || !TOKEN_RE.test(d.token) || !ID_RE.test(d.projectId ?? '')) throw new HttpError(502, `${new URL(server).host} did not answer like a Saqme sync service.`);
  const [own, existing] = await env.DB.batch([
    env.DB.prepare('SELECT id FROM projects WHERE id = ?1').bind(d.projectId),
    env.DB.prepare(`SELECT * FROM remotes WHERE server = ?1 AND project_id = ?2 AND state = 'active'`).bind(server, d.projectId),
  ]);
  const ex = existing.results[0];
  const name = nameOf(d.projectName) || 'Shared list';
  if (ex && d.kind === 'move') {
    // moved here from another app (the key it had there ends) onto the list your phones have: one key for it
    if (ex.token !== d.token) await callOwner(server, '/api/shares/leave', { token: ex.token });
    await env.DB.prepare('UPDATE remotes SET token = ?2, access = ?3, name = ?4, updated_at = ?5 WHERE id = ?1').bind(ex.id, d.token, accessOf(d.access), name, now).run();
    return { remote: remoteView({ ...ex, token: d.token, access: accessOf(d.access), name }), kind: 'move' };
  }
  if (ex || own.results.length) {
    await callOwner(server, '/api/shares/leave', { token: d.token });   // a second key for the same list: give it back
    throw new HttpError(409, own.results.length ? `“${name}” is one of your own lists.` : `“${name}” is already here.`);
  }
  const row = await insertRemote(env, { server, token: d.token, projectId: d.projectId, name, access: accessOf(d.access) }, now);
  return { remote: remoteView(row), kind: d.kind === 'move' ? 'move' : 'join' };
}

/** POST /api/remotes/adopt — a share key the app had on its own (joined before it was paired) comes here. */
export async function adoptRemote(env, body, now = Date.now()) {
  const server = relayOrigin(body?.server);
  const token = body?.token;
  if (!server || typeof token !== 'string' || !TOKEN_RE.test(token)) throw new HttpError(400, 'bad server or key');
  // (a cursor past everything: just "who am I", no rows)
  const r = await callOwner(server, '/api/sync', { token, body: { deviceId: 'relay-adopt', cursor: Number.MAX_SAFE_INTEGER, changes: [] } });
  // 401: revoked or moved (an unknown key too: it was left); the app ends it. Never this Worker's own 401.
  if (r.status === 401) return { status: 401, data: { error: r.data.error === 'transferred' ? 'transferred' : 'revoked' } };
  if (r.status !== 200) return { status: r.status === 400 ? 400 : 502, data: { error: r.data.error || `${new URL(server).host} answered ${r.status}.` } };
  const projectId = r.data.share?.projectId;
  if (!ID_RE.test(projectId ?? '')) throw new HttpError(502, `${new URL(server).host} did not answer like a Saqme sync service.`);
  const existing = await env.DB.prepare(`SELECT * FROM remotes WHERE server = ?1 AND project_id = ?2 AND state = 'active'`).bind(server, projectId).first();
  if (existing) {
    if (existing.token !== token) await callOwner(server, '/api/shares/leave', { token });   // already here with another key
    return { status: 200, data: { remote: remoteView(existing) } };
  }
  const row = await insertRemote(env, { server, token, projectId, name: nameOf(body.name) || 'Shared list', access: accessOf(r.data.share?.access) }, now);
  return { status: 200, data: { remote: remoteView(row) } };
}

async function loadRemote(env, id) {
  if (typeof id !== 'string' || !REMOTE_ID_RE.test(id)) throw new HttpError(404, 'no such shared list');
  const r = await env.DB.prepare('SELECT * FROM remotes WHERE id = ?1').bind(id).first();
  if (!r) throw new HttpError(404, 'no such shared list');
  return r;
}

/** Ends a remote here (its owner revoked it, it moved to another app, or it was left): its key is forgotten. */
function endStatements(env, id, state, now) {
  return [
    env.DB.prepare(`UPDATE remotes SET state = ?2, token = '', updated_at = ?3 WHERE id = ?1 AND state = 'active'`).bind(id, state, now),
    env.DB.prepare('DELETE FROM remote_tasks WHERE remote_id = ?1').bind(id),
  ];
}

/**
 * The answer for a list that ended: 401 { error: its state, convert }. After a revoke one app (the first to ask)
 * keeps it as an own list; the others just drop their copy (that list reaches them through your own sync).
 */
async function endedAnswer(env, id, state) {
  let convert = false;
  if (state === 'revoked') convert = !!(await env.DB.prepare(`UPDATE remotes SET converted = 1 WHERE id = ?1 AND converted = 0 RETURNING id`).bind(id).first());
  return { status: 401, data: { error: state, convert } };
}

/** POST /api/remotes/<id>/sync */
export async function relaySync(env, id, body, now = Date.now()) {
  const rem = await loadRemote(env, id);
  if (rem.state !== 'active') return endedAnswer(env, rem.id, rem.state);
  const r = await callOwner(rem.server, '/api/sync', { token: rem.token, body });
  if (r.status === 401) {
    const state = r.data.error === 'transferred' ? 'transferred' : 'revoked';
    await env.DB.batch(endStatements(env, rem.id, state, now));
    return endedAnswer(env, rem.id, state);
  }
  // (a 404 here means "no such shared list on your Worker": the owner's never comes back as one)
  if (r.status === 404) return { status: 502, data: { error: r.data.error || `${new URL(rem.server).host} answered 404.` } };
  const access = r.data.share?.access;
  if (r.status === 200 && (access === 'edit' || access === 'view') && access !== rem.access) {
    await env.DB.prepare('UPDATE remotes SET access = ?2, updated_at = ?3 WHERE id = ?1').bind(rem.id, access, now).run();
  }
  return r;
}

/** POST /api/remotes/<id>/leave: its key ends at the owner's (nothing else changes there) and here. */
export async function leaveRemote(env, id, now = Date.now()) {
  const rem = await loadRemote(env, id);
  if (rem.state === 'active') {
    await callOwner(rem.server, '/api/shares/leave', { token: rem.token });   // (best effort: the key is forgotten either way)
    await env.DB.batch(endStatements(env, rem.id, 'left', now));
  }
  return { ok: true };
}

// ---------------------------------------------------------------- reminders: the lists' deadlines
/**
 * Brings remote_tasks up to date for the (at most 3) lists polled longest ago (the cron, before it computes
 * reminders; the rest follow in the next runs, 5 minutes apart). budget = { left }: requests this run may still
 * make (the free plan allows 50 subrequests and 50 D1 queries per invocation).
 */
export async function pollRemotes(env, nowMs = Date.now(), budget = { left: 6 }) {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT * FROM remotes WHERE state = 'active' ORDER BY polled_at LIMIT ?1`).bind(Math.max(0, Math.min(3, budget.left))).all();
  for (const rem of results) {
    let cursor = rem.cursor;
    let name = rem.name;
    let deleted = null;
    const writes = [];
    for (let page = 0; page < 3 && budget.left > 0; page++) {
      budget.left--;
      const r = await callOwner(rem.server, '/api/sync', { token: rem.token, body: { deviceId: 'relay-reminders', cursor, changes: [] } });
      if (r.status === 401) { writes.push(...endStatements(env, rem.id, r.data.error === 'transferred' ? 'transferred' : 'revoked', nowMs)); break; }
      if (r.status !== 200) break;
      const d = r.data;
      if (d.restored || Number(d.cursor) < cursor) {
        // the owner's database went back in time: read the list again from the start
        writes.push(db.prepare('DELETE FROM remote_tasks WHERE remote_id = ?1').bind(rem.id));
        cursor = 0;
        continue;
      }
      const rows = [];
      const gone = [];
      for (const c of Array.isArray(d.changes) ? d.changes : []) {
        if (!c || typeof c.id !== 'string') continue;
        if (c.kind === 'task' && c.gone) { gone.push(c.id); continue; }
        if (c.kind === 'project' && c.id === rem.project_id) {
          name = nameOf(c.fields?.name?.v) || name;
          deleted = c.fields?.deleted?.v === true;
          continue;
        }
        if (c.kind !== 'task' || !ID_RE.test(c.id)) continue;
        const f = c.fields ?? {};
        if (f.place?.v?.project !== rem.project_id) { gone.push(c.id); continue; }
        const due = f.due?.v && isValidDate(f.due.v.date) ? f.due.v : null;
        rows.push({
          remote_id: rem.id, id: c.id, text: String(f.text?.v ?? '').slice(0, MAX_TEXT), status: STATUSES.includes(f.status?.v) ? f.status.v : ' ',
          due: due ? due.date : null, due_time: due ? normalizeTime(due.time) ?? '' : '', deleted: f.deleted?.v ? 1 : 0,
        });
      }
      if (rows.length) {
        writes.push(db.prepare(`INSERT INTO remote_tasks (remote_id, id, text, status, due, due_time, deleted)
          SELECT json_extract(value, '$.remote_id'), json_extract(value, '$.id'), json_extract(value, '$.text'), json_extract(value, '$.status'),
                 json_extract(value, '$.due'), json_extract(value, '$.due_time'), json_extract(value, '$.deleted') FROM json_each(?1) WHERE true
          ON CONFLICT(remote_id, id) DO UPDATE SET text = excluded.text, status = excluded.status, due = excluded.due,
            due_time = excluded.due_time, deleted = excluded.deleted`).bind(JSON.stringify(rows)));
      }
      if (gone.length) writes.push(db.prepare('DELETE FROM remote_tasks WHERE remote_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(rem.id, JSON.stringify(gone)));
      cursor = Number(d.cursor) || 0;
      if (!d.more) break;
    }
    writes.push(db.prepare(`UPDATE remotes SET cursor = ?2, polled_at = ?3, name = ?4, project_deleted = COALESCE(?5, project_deleted) WHERE id = ?1`)
      .bind(rem.id, cursor, nowMs, name, deleted === null ? null : (deleted ? 1 : 0)));
    await db.batch(writes);
  }
}

/** The deadlines of shared lists, for computeReminders (src/reminders.js). */
export async function remoteDueTasks(env, horizon) {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.text, t.status, t.due, t.due_time, r.name AS project FROM remote_tasks t JOIN remotes r ON r.id = t.remote_id
      WHERE r.state = 'active' AND r.project_deleted = 0 AND t.deleted = 0 AND t.due IS NOT NULL AND t.status IN (' ', '/', '!') AND t.due <= ?1`,
  ).bind(horizon).all();
  return results.map((r) => ({ id: r.id, text: r.text, status: r.status, due: r.due, dueTime: r.due_time, project: r.project }));
}

/** Ended remotes are kept 30 days (so your other phones learn about it), then forgotten. */
export const pruneRemotes = (db, nowMs) => db.prepare(`DELETE FROM remotes WHERE state != 'active' AND updated_at < ?1`).bind(nowMs - 30 * 86_400_000);
