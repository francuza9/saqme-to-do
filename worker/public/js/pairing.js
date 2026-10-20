// Pairing links: https://<sync server>/#pair=<key>. The same rule in the phone app, the Linux/macOS app and
// (desktop/sync-core.ps1 Get-PairingLink) the Windows app; checked against shared/fixtures/text.json.

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * A pairing link or a bare key -> { key, server } or null. server is the link's origin ('' for a bare key, or
 * when it is `ownOrigin`, the address this copy of the app came from). Only https servers (plain http just on
 * this computer, for testing), and no user name in the address: https://my.worker.dev@evil.example would
 * send everything to evil.example.
 */
export function parsePairingLink(text, ownOrigin = '') {
  const v = String(text ?? '').trim();
  let m = /^([A-Za-z0-9_-]{32,})$/.exec(v);
  if (m) return { key: m[1], server: '' };
  m = /^(https?:\/\/[^/#?\s]+)\/?(?:\?[^#]*)?#pair=([A-Za-z0-9_-]{32,})$/.exec(v);
  if (!m) return null;
  let u;
  try { u = new URL(m[1]); } catch { return null; }
  if (u.username || u.password || /@/.test(m[1])) return null;
  if (u.protocol !== 'https:' && !LOOPBACK.includes(u.hostname)) return null;
  return { key: m[2], server: u.origin === ownOrigin ? '' : u.origin };
}

/** An address that may be a sync server: https (plain http just on this computer), no user name. -> origin or null */
function serverOrigin(s) {
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password || /@/.test(s)) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.includes(u.hostname))) return null;
  return u.origin;
}

// Invite links for shared lists (worker/src/shares.js): https://<owner's sync server>/join#code=<one-time code>,
// that server's app with #join=<code> (what the join page's "Open in browser" opens), or what the join page hands
// an installed app: saqme://join?server=<that origin, URL-encoded>&code=<code>. The same rule as
// desktop/sync-core.ps1 Get-InviteLink; checked against shared/fixtures/text.json.
const INVITE_CODE = /^[A-Za-z0-9_-]{22,64}$/;

/** An invite link -> { server, code } (server: the owner's sync server, an origin) or null. */
export function parseInviteLink(text) {
  const v = String(text ?? '').trim();
  let server = null;
  let code = null;
  let m = /^saqme:\/\/join\/?\?([^#\s]*)$/.exec(v);
  if (m) {
    const q = new URLSearchParams(m[1]);
    const s = q.get('server') ?? '';
    code = q.get('code') ?? '';
    if (!/^https?:\/\/[^/#?\s]+\/?$/.test(s)) return null;
    server = serverOrigin(s.replace(/\/$/, ''));
  } else {
    m = /^(https?:\/\/[^/#?\s]+)(?:\/join\/?(?:\?[^#]*)?#code=|\/?(?:\?[^#]*)?#join=)([^&\s]+)$/.exec(v);
    if (!m) return null;
    server = serverOrigin(m[1]);
    code = m[2];
  }
  if (!server || !INVITE_CODE.test(code)) return null;
  return { server, code };
}

/**
 * A sync server's short name, for a shared list whose name another list here has ("Groceries (from nuca)"): the
 * account part of a workers.dev address, else the host without www. or saqme. The same as desktop/sync-core.ps1
 * Get-ServerLabel; checked against shared/fixtures/text.json.
 */
export function serverLabel(server) {
  const v = String(server ?? '').trim();
  let u;
  try { u = new URL(v); } catch { return v; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return v;
  const host = u.host.toLowerCase();
  const m = /^(?:[^.]+\.)?([^.]+)\.workers\.dev$/.exec(host);
  return m ? m[1] : host.replace(/^(www|saqme)\./, '');
}

// Pairing codes: the short, one-time alternative to the link, typed into the phone app (see worker/src/pairing.js).
// Eight characters without look-alikes (no 0/O, 1/I/L), shown as two groups of four.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{8}$`);

/** What someone typed -> the 8-character code, or null. Case, spaces and dashes don't matter. */
export function normalizePairingCode(text) {
  const v = String(text ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return CODE_RE.test(v) ? v : null;
}

/** ABCDEFGH -> ABCD-EFGH */
export const formatPairingCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
