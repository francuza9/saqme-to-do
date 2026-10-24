// The AI connector: one address an AI assistant (claude.ai, ChatGPT, any client of remote MCP servers) is given
// as a "custom connector", to read and manage the owner's lists through the tools of src/mcp.js (docs/ai.md).
//
//   GET  /api/connector             { enabled, url, createdAt, lastUsedAt }  (the owner's key)
//   POST /api/connector/rotate      a new address (the old one stops working at once); also turns it on
//   POST /api/connector/disconnect  no address works any more, until rotate
//   POST /api/mcp/<key>             the MCP endpoint (Streamable HTTP, JSON answers), no Authorization header:
//                                   the key in the address is the credential (a "capability URL")
//
// The key is HMAC-SHA-256(AUTH_TOKEN, 'saqme-connector:' + nonce), base64url (43 characters), with a random nonce
// kept in D1 (migration 0004_connector.sql makes one for every database, so an address is ready as soon as sync
// is). So D1 holds neither the key nor a digest of it, the sync key cannot be worked out from the address, and
// any app with the sync key can show the address again. Rotating is a new nonce; disconnecting is enabled = 0
// plus a new nonce (a later Connect never brings an old address back). A new sync key (setup -RotateToken)
// also changes the address.
//
// The endpoint never looks at an Authorization header: neither the owner's key nor a shared list's key reaches it
// (only the key in the address does, compared as SHA-256 digests in constant time). A wrong or switched-off key
// costs one D1 read and writes nothing; it answers 404 (no OAuth challenge, which would send clients looking for a
// sign-in this server does not have). A valid key is rate limited (RATE_LIMIT calls a minute).

export const RATE_LIMIT = 120;
const WINDOW = 60_000;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const enc = (s) => new TextEncoder().encode(s);
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomNonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class ConnectorError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The connector key for this sync key and nonce. */
export async function connectorKey(authToken, nonce) {
  const k = await crypto.subtle.importKey('raw', enc(authToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc(`saqme-connector:${nonce}`))));
}

async function row(env) {
  let r = await env.DB.prepare(`SELECT * FROM connector WHERE id = 'main'`).first();
  if (!r) {
    // (the migration makes it; this covers a row removed by hand)
    await env.DB.prepare(`INSERT OR IGNORE INTO connector (id, nonce, created_at) VALUES ('main', ?1, ?2)`).bind(randomNonce(), Date.now()).run();
    r = await env.DB.prepare(`SELECT * FROM connector WHERE id = 'main'`).first();
  }
  return r;
}

async function view(env, r, origin) {
  const on = !!r.enabled;
  return {
    enabled: on,
    url: on ? `${origin}/api/mcp/${await connectorKey(env.AUTH_TOKEN, r.nonce)}` : null,
    createdAt: r.created_at || null,
    lastUsedAt: r.last_used_at || null,
  };
}

/** GET /api/connector */
export async function connectorStatus(env, origin) {
  return view(env, await row(env), origin);
}

/** POST /api/connector/rotate: a new address, on. */
export async function rotateConnector(env, origin, now = Date.now()) {
  await row(env);
  const r = await env.DB.prepare(`UPDATE connector SET nonce = ?1, enabled = 1, created_at = ?2, last_used_at = 0, window_start = 0, window_calls = 0
                                   WHERE id = 'main' RETURNING *`).bind(randomNonce(), now).first();
  return view(env, r, origin);
}

/** POST /api/connector/disconnect: off, and the address it had is gone for good. */
export async function disconnectConnector(env, origin) {
  await row(env);
  const r = await env.DB.prepare(`UPDATE connector SET nonce = ?1, enabled = 0 WHERE id = 'main' RETURNING *`).bind(randomNonce()).first();
  return view(env, r, origin);
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc(s)));
}

/**
 * The key in /api/mcp/<key>: true when it is this Worker's connector key and the connector is on. Reads one row and
 * writes nothing.
 */
export async function connectorAuthorized(env, key) {
  if (!env.AUTH_TOKEN || env.AUTH_TOKEN.length < 32 || typeof key !== 'string' || !KEY_RE.test(key)) return false;
  const r = await env.DB.prepare(`SELECT nonce, enabled FROM connector WHERE id = 'main'`).first();
  if (!r || !r.enabled) return false;
  const [a, b] = await Promise.all([sha256(key), sha256(await connectorKey(env.AUTH_TOKEN, r.nonce))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Counts a call; false when this minute's RATE_LIMIT is used up. */
export async function connectorRateOk(env, now = Date.now()) {
  const n = await env.DB.prepare(
    `UPDATE connector SET last_used_at = ?1,
            window_calls = CASE WHEN window_start > ?1 - ?2 THEN window_calls + 1 ELSE 1 END,
            window_start = CASE WHEN window_start > ?1 - ?2 THEN window_start ELSE ?1 END
      WHERE id = 'main' RETURNING window_calls`,
  ).bind(now, WINDOW).first('window_calls');
  return n != null && n <= RATE_LIMIT;
}

// Deletes through the connector have a budget, as a mass delete in the lists folder is held back by the apps
// ("Deletions paused", docs/sync.md): at most DELETE_LIMIT tasks (subtasks count) an hour. More is left to the user,
// in the app.
export const DELETE_LIMIT = 25;
const DELETE_WINDOW = 3600_000;

/** Takes n deletes from this hour's budget: false (and nothing taken) when they do not fit. */
export async function takeDeleteBudget(env, n, now = Date.now()) {
  const r = await env.DB.prepare(
    `UPDATE connector SET
            delete_count = CASE WHEN delete_start > ?1 - ?3 THEN delete_count + ?2 ELSE ?2 END,
            delete_start = CASE WHEN delete_start > ?1 - ?3 THEN delete_start ELSE ?1 END
      WHERE id = 'main' AND (CASE WHEN delete_start > ?1 - ?3 THEN delete_count + ?2 ELSE ?2 END) <= ?4
      RETURNING delete_count`,
  ).bind(now, n, DELETE_WINDOW, DELETE_LIMIT).first('delete_count');
  return r != null;
}
