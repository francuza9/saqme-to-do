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
