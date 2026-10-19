// Web Push sender: message encryption (RFC 8291 / RFC 8188 "aes128gcm") and VAPID (RFC 8292).
// WebCrypto only (globalThis.crypto.subtle), so it runs unchanged in Cloudflare Workers and Node >= 20.

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

const RECORD_SIZE = 4096;
const HEADER_LEN = 16 + 4 + 1 + 65; // salt || rs || idlen || keyid (as_public)
// Push services accept at most 4096 body bytes: minus header, 16-byte GCM tag and 1-byte padding delimiter.
export const MAX_PAYLOAD_BYTES = 4096 - HEADER_LEN - 16 - 1; // 3993
const URGENCIES = ['very-low', 'low', 'normal', 'high'];

// ---------- byte helpers ----------

const toBytes = (b) => (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function b64urlEncode(bytes) {
  const u8 = toBytes(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Accepts base64url or standard base64, with or without padding.
export function b64urlDecode(str) {
  const b64 = String(str).replace(/[\s=]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---------- crypto helpers ----------

async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

// HKDF-Expand (RFC 5869) for L <= 32: a single block T(1) = HMAC(PRK, info || 0x01).
const hkdfExpand = async (prk, info, len) => (await hmac(prk, concat(info, [1]))).slice(0, len);

// JWK for a P-256 private key given base64url raw public point (0x04 || x || y) and scalar d.
function p256Jwk(publicKey, privateKey) {
  const pub = b64urlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('Invalid P-256 public key (expected 65-byte uncompressed point)');
  const d = b64urlDecode(privateKey);
  if (d.length !== 32) throw new Error('Invalid P-256 private key (expected 32 bytes)');
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.subarray(1, 33)), y: b64urlEncode(pub.subarray(33)), d: b64urlEncode(d) };
}

// ---------- VAPID (RFC 8292) ----------

export async function generateVapidKeys() {
  const kp = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const pub = await subtle.exportKey('raw', kp.publicKey);
  const { d } = await subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64urlEncode(pub), privateKey: d };
}

// Imported signing keys, cached per key pair (a Worker isolate normally only ever sees one).
const vapidKeyCache = new Map();

function vapidSigningKey(publicKey, privateKey) {
  const id = `${publicKey}|${privateKey}`;
  let entry = vapidKeyCache.get(id);
  if (!entry) {
    if (vapidKeyCache.size >= 8) vapidKeyCache.clear();
    entry = (async () => ({
      key: await subtle.importKey('jwk', p256Jwk(publicKey, privateKey), ECDSA, false, ['sign']),
      k: b64urlEncode(b64urlDecode(publicKey)), // normalized (unpadded base64url)
    }))();
    vapidKeyCache.set(id, entry);
    entry.catch(() => vapidKeyCache.delete(id)); // don't cache failures
  }
  return entry;
}

// Returns the Authorization header value: "vapid t=<JWT>, k=<publicKey>".
export async function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, nowSec = Math.floor(Date.now() / 1000)) {
  const part = (obj) => b64urlEncode(utf8.encode(JSON.stringify(obj)));
  const claims = { aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject };
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`;
  const { key, k } = await vapidSigningKey(publicKey, privateKey);
  // WebCrypto ECDSA already yields the raw r||s (64 bytes) form that JWS ES256 requires.
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(unsigned));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${k}`;
}

// ---------- Message encryption (RFC 8291 + RFC 8188) ----------

// Returns the complete aes128gcm request body (header + single encrypted record).
// `salt` (16 bytes, base64url or bytes) and `serverKeys` ({publicKey, privateKey} base64url raw) are for tests only.
export async function encryptPayload(payload, { p256dh, auth }, { salt, serverKeys } = {}) {
  const plaintext = typeof payload === 'string' ? utf8.encode(payload) : toBytes(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error(`Push payload too large: ${plaintext.length} > ${MAX_PAYLOAD_BYTES} bytes`);

  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (authSecret.length !== 16) throw new Error('Invalid subscription auth secret (expected 16 bytes)');
  salt = salt == null ? crypto.getRandomValues(new Uint8Array(16)) : typeof salt === 'string' ? b64urlDecode(salt) : toBytes(salt);
  if (salt.length !== 16) throw new Error('Salt must be 16 bytes');

  // Application server key pair: fresh ephemeral one per message unless fixed for tests.
  let asPrivate, asPublic;
  if (serverKeys) {
    asPrivate = await subtle.importKey('jwk', p256Jwk(serverKeys.publicKey, serverKeys.privateKey), ECDH, false, ['deriveBits']);
    asPublic = b64urlDecode(serverKeys.publicKey);
  } else {
    const kp = await subtle.generateKey(ECDH, false, ['deriveBits']);
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  }

  const uaKey = await subtle.importKey('raw', uaPublic, ECDH, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  // RFC 8291 section 3.4: mix the auth secret and both public keys into the IKM.
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(utf8.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188 section 2.2/2.3: content encryption key and nonce.
  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, utf8.encode('Content-Encoding: nonce\0'), 12);

  // Single (last) record: plaintext || 0x02 delimiter, no extra padding.
  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(plaintext, [2])));

  const header = new Uint8Array(HEADER_LEN);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length; // idlen = 65
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// ---------- Sending (RFC 8030) ----------

// subscription = { endpoint, keys: { p256dh, auth } }; vapid = { publicKey, privateKey, subject }.
// Resolves to { ok, status, gone, text }; HTTP errors never throw (network errors may).
// gone === true means the subscription is dead (404/410) and should be deleted.
export async function sendPush(subscription, payload, vapid, { ttl = 86400, urgency = 'high', topic, fetchImpl = fetch, nowSec } = {}) {
  if (!URGENCIES.includes(urgency)) throw new Error(`Invalid urgency: ${urgency}`);
  const { endpoint, keys } = subscription;
  const body = await encryptPayload(payload, keys);
  const headers = {
    Authorization: await vapidAuthorization(endpoint, vapid, nowSec),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.floor(Number(ttl) || 0))),
    Urgency: urgency,
  };
  // Topic: at most 32 chars of the base64url alphabet (RFC 8030 section 5.4).
  const cleanTopic = topic == null ? '' : String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  if (cleanTopic) headers.Topic = cleanTopic;

  const res = await fetchImpl(endpoint, { method: 'POST', headers, body });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, text };
}
