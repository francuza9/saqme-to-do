import { describe, it, expect, vi } from 'vitest';
import {
  b64urlEncode,
  b64urlDecode,
  generateVapidKeys,
  vapidAuthorization,
  encryptPayload,
  sendPush,
} from '../../src/push.js';

const subtle = globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

// Independent helpers (Node Buffer + WebCrypto's own HKDF) so the receiver side does not share code with src/push.js.
const fromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const toB64u = (b) => Buffer.from(b).toString('base64url');
const text = (s) => new TextEncoder().encode(s);

async function hkdf(ikm, salt, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// User-agent side of RFC 8291: decrypt an aes128gcm body with the subscription's private key + auth secret.
async function decryptPushBody(body, { uaPublic, uaPrivate, auth }) {
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);

  const ua = fromB64u(uaPublic);
  const privKey = await subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: toB64u(ua.subarray(1, 33)), y: toB64u(ua.subarray(33)), d: uaPrivate },
    ECDH,
    false,
    ['deriveBits'],
  );
  const asKey = await subtle.importKey('raw', asPublic, ECDH, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, privKey, 256));

  const keyInfo = new Uint8Array([...text('WebPush: info\0'), ...ua, ...asPublic]);
  const ikm = await hkdf(ecdh, fromB64u(auth), keyInfo, 32);
  const cek = await hkdf(ikm, salt, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, text('Content-Encoding: nonce\0'), 12);

  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, record));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--; // strip zero padding
  expect(padded[end]).toBe(2); // last-record delimiter
  return padded.subarray(0, end);
}

async function makeSubscriber() {
  const kp = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const uaPublic = toB64u(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const { d: uaPrivate } = await subtle.exportKey('jwk', kp.privateKey);
  const auth = toB64u(crypto.getRandomValues(new Uint8Array(16)));
  return { uaPublic, uaPrivate, auth, keys: { p256dh: uaPublic, auth } };
}

function parseVapid(header) {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  expect(m).not.toBeNull();
  const [, h, c, s, k] = m;
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(c, 'base64url').toString()),
    signingInput: text(`${h}.${c}`),
    sig: fromB64u(s),
    k,
  };
}

async function verifyEs256(publicKeyB64u, sig, data) {
  const key = await subtle.importKey('raw', fromB64u(publicKeyB64u), ECDSA, false, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
}

describe('base64url', () => {
  it('round-trips bytes without padding and tolerates padding / standard alphabet', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      const s = b64urlEncode(bytes);
      expect(s).toBe(toB64u(bytes));
      expect(s).not.toMatch(/[+/=]/);
      expect(b64urlDecode(s)).toEqual(bytes);
      expect(b64urlDecode(Buffer.from(bytes).toString('base64'))).toEqual(bytes); // padded, +/
    }
    expect(b64urlEncode(new Uint8Array([0xfb, 0xff]).buffer)).toBe('-_8');
    expect(b64urlEncode(new Uint8Array(100000).fill(7))).toBe(toB64u(new Uint8Array(100000).fill(7)));
  });
});

describe('RFC 8291 Appendix A test vector', () => {
  const V = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    body:
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };

  it('expected body decrypts to the plaintext with an independent receiver', async () => {
    const plain = await decryptPushBody(fromB64u(V.body), V);
    expect(new TextDecoder().decode(plain)).toBe(V.plaintext);
  });

  it('encryptPayload reproduces the expected body byte-for-byte', async () => {
    const body = await encryptPayload(
      V.plaintext,
      { p256dh: V.uaPublic, auth: V.auth },
      { salt: V.salt, serverKeys: { publicKey: V.asPublic, privateKey: V.asPrivate } },
    );
    expect(toB64u(body)).toBe(V.body);
  });
});

describe('encryptPayload round trip', () => {
  const payloads = [
    '',
    'x',
    JSON.stringify({ title: 'Saqme', body: 'Buy milk', tag: 'task-42' }),
    'Grüße, ქართული ენა 🍉 — ok',
    'a'.repeat(1000),
    'é'.repeat(1996) + 'z', // 3993 bytes in UTF-8 (max)
  ];

  it.each(payloads.map((p) => [text(p).length, p]))('payload of %i bytes', async (_n, payload) => {
    const sub = await makeSubscriber();
    const body = await encryptPayload(payload, sub.keys);
    expect(body.length).toBe(86 + text(payload).length + 1 + 16);
    expect(new TextDecoder().decode(await decryptPushBody(body, sub))).toBe(payload);
  });

  it('accepts Uint8Array payloads and uses a fresh salt + server key each time', async () => {
    const sub = await makeSubscriber();
    const bytes = crypto.getRandomValues(new Uint8Array(300));
    const a = await encryptPayload(bytes, sub.keys);
    const b = await encryptPayload(bytes, sub.keys);
    expect(await decryptPushBody(a, sub)).toEqual(bytes);
    expect(toB64u(a.subarray(0, 16))).not.toBe(toB64u(b.subarray(0, 16)));
    expect(toB64u(a.subarray(21, 86))).not.toBe(toB64u(b.subarray(21, 86)));
  });

  it('rejects payloads larger than 3993 bytes (counted in UTF-8 bytes)', async () => {
    const sub = await makeSubscriber();
    await expect(encryptPayload('a'.repeat(3994), sub.keys)).rejects.toThrow(/too large/);
    await expect(encryptPayload('🍉'.repeat(1000), sub.keys)).rejects.toThrow(/too large/); // 4000 bytes
  });

  it('rejects a malformed auth secret', async () => {
    const sub = await makeSubscriber();
    await expect(encryptPayload('hi', { p256dh: sub.uaPublic, auth: 'AAAA' })).rejects.toThrow(/auth/);
  });
});

describe('generateVapidKeys', () => {
  it('returns a 65-byte uncompressed public point and a 32-byte private scalar that sign/verify', async () => {
    const { publicKey, privateKey } = await generateVapidKeys();
    const pub = b64urlDecode(publicKey);
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    expect(b64urlDecode(privateKey).length).toBe(32);
    expect(publicKey).toMatch(/^[\w-]+$/);
    expect(privateKey).toMatch(/^[\w-]+$/);

    const jwk = { kty: 'EC', crv: 'P-256', x: toB64u(pub.subarray(1, 33)), y: toB64u(pub.subarray(33)), d: privateKey };
    const signKey = await subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);
    const data = text('hello');
    const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, data));
    expect(sig.length).toBe(64);
    expect(await verifyEs256(publicKey, sig, data)).toBe(true);
  });
});

describe('vapidAuthorization', () => {
  it('produces a valid ES256 JWT with the right header, claims and k=', async () => {
    const vapid = { ...(await generateVapidKeys()), subject: 'mailto:admin@example.com' };
    const now = 1_760_000_000;
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123?x=1';

    for (let i = 0; i < 2; i++) {
      // second iteration exercises the cached imported key
      const jwt = parseVapid(await vapidAuthorization(endpoint, vapid, now));
      expect(jwt.header).toEqual({ typ: 'JWT', alg: 'ES256' });
      expect(jwt.claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now + 12 * 3600, sub: vapid.subject });
      expect(jwt.k).toBe(vapid.publicKey);
      expect(jwt.sig.length).toBe(64);
      expect(await verifyEs256(vapid.publicKey, jwt.sig, jwt.signingInput)).toBe(true);
      // Tampered claims must not verify.
      const tampered = jwt.signingInput.slice();
      tampered[tampered.length - 1] ^= 1;
      expect(await verifyEs256(vapid.publicKey, jwt.sig, tampered)).toBe(false);
    }
  });

  it('defaults exp to now + 12h and keeps the port in aud', async () => {
    const vapid = { ...(await generateVapidKeys()), subject: 'https://saqme.example' };
    const before = Math.floor(Date.now() / 1000);
    const { claims } = parseVapid(await vapidAuthorization('https://push.example:8443/p/1', vapid));
    expect(claims.aud).toBe('https://push.example:8443');
    expect(claims.exp - 12 * 3600).toBeGreaterThanOrEqual(before);
    expect(claims.exp - 12 * 3600).toBeLessThanOrEqual(before + 5);
  });

  it('rejects a malformed key pair', async () => {
    await expect(vapidAuthorization('https://a.example/', { publicKey: 'AAAA', privateKey: 'AAAA', subject: 'mailto:a@b.c' })).rejects.toThrow();
  });
});

describe('sendPush', () => {
  const endpoint = 'https://web.push.apple.com/QGuQyavXutnMH7YfC2wFWl1nEAAA';

  async function setup(status, responseBody = '') {
    const sub = await makeSubscriber();
    const vapid = { ...(await generateVapidKeys()), subject: 'mailto:admin@example.com' };
    const fetchImpl = vi.fn(async () => new Response(responseBody || null, { status }));
    return { sub, vapid, fetchImpl, subscription: { endpoint, keys: sub.keys } };
  }

  it('POSTs an encrypted aes128gcm body with VAPID and Web Push headers (201 → ok)', async () => {
    const { sub, vapid, fetchImpl, subscription } = await setup(201);
    const payload = JSON.stringify({ title: 'Saqme', body: 'Due today: გადახდა 💸' });
    const res = await sendPush(subscription, payload, vapid, { fetchImpl, nowSec: 1_760_000_000, topic: 'task-42' });

    expect(res).toEqual({ ok: true, status: 201, gone: false, text: '' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init.method).toBe('POST');

    const h = new Headers(init.headers);
    expect(h.get('content-encoding')).toBe('aes128gcm');
    expect(h.get('content-type')).toBe('application/octet-stream');
    expect(h.get('ttl')).toBe('86400');
    expect(h.get('urgency')).toBe('high');
    expect(h.get('topic')).toBe('task-42');

    const jwt = parseVapid(h.get('authorization'));
    expect(jwt.claims).toEqual({ aud: 'https://web.push.apple.com', exp: 1_760_000_000 + 43200, sub: vapid.subject });
    expect(jwt.k).toBe(vapid.publicKey);
    expect(await verifyEs256(vapid.publicKey, jwt.sig, jwt.signingInput)).toBe(true);

    const plain = await decryptPushBody(new Uint8Array(init.body), sub);
    expect(new TextDecoder().decode(plain)).toBe(payload);
  });

  it('honours ttl/urgency, sanitizes the topic and omits it when absent', async () => {
    const { vapid, fetchImpl, subscription } = await setup(201);
    await sendPush(subscription, 'a', vapid, { fetchImpl, ttl: 60, urgency: 'low', topic: 'saqme: list/123 + some very long suffix that keeps going!!' });
    await sendPush(subscription, 'b', vapid, { fetchImpl });
    const h1 = new Headers(fetchImpl.mock.calls[0][1].headers);
    expect(h1.get('ttl')).toBe('60');
    expect(h1.get('urgency')).toBe('low');
    expect(h1.get('topic')).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(h1.get('topic')).toBe('saqmelist123someverylongsuffixth'); // stripped + truncated to 32
    expect(new Headers(fetchImpl.mock.calls[1][1].headers).has('topic')).toBe(false);
    await expect(sendPush(subscription, 'c', vapid, { fetchImpl, urgency: 'urgent' })).rejects.toThrow(/urgency/);
  });

  it('410 → gone, not ok, and does not throw', async () => {
    const { vapid, fetchImpl, subscription } = await setup(410, 'push subscription has unsubscribed or expired.');
    const res = await sendPush(subscription, 'hi', vapid, { fetchImpl });
    expect(res).toEqual({ ok: false, status: 410, gone: true, text: 'push subscription has unsubscribed or expired.' });
  });

  it('404 → gone; 5xx/429 → not ok but not gone', async () => {
    for (const [status, gone] of [[404, true], [429, false], [500, false], [400, false]]) {
      const { vapid, fetchImpl, subscription } = await setup(status, 'err');
      const res = await sendPush(subscription, 'hi', vapid, { fetchImpl });
      expect(res).toEqual({ ok: false, status, gone, text: 'err' });
    }
  });

  it('propagates network errors from fetch', async () => {
    const { vapid, subscription } = await setup(201);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down');
    });
    await expect(sendPush(subscription, 'hi', vapid, { fetchImpl })).rejects.toThrow('network down');
  });
});
