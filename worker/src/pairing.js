// Pairing codes: a short code typed into the phone app instead of opening the pairing link in it.
//
// Why: an app added to an iPhone's Home Screen starts at the manifest's start_url, with storage of its own.
// Neither the link's #pair=<key> nor the pairing Safari did reaches it, so it needs a way in that survives
// being typed. A device that already syncs asks for a code (POST /api/pair/code, with the key); the phone
// trades it for the key (POST /api/pair/claim, without one).
//
// A code is 8 characters out of 31 (about 40 bits). It works once, for 10 minutes; at most 5 are open at a
// time, and after 10 wrong guesses every open code is dropped, so guessing has no real chance (10 tries
// against 8 * 10^11). With no code open, a claim touches nothing (no writes for strangers to run up). The
// codes are kept as SHA-256 digests in the meta table.
import { CODE_ALPHABET, normalizePairingCode, formatPairingCode } from '../public/js/pairing.js';

export const CODE_TTL = 10 * 60_000;
const MAX_OPEN = 5;
const MAX_FAILS = 10;

function randomCode() {
  let out = '';
  const limit = 256 - (256 % CODE_ALPHABET.length);   // no modulo bias
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < 8) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

async function digest(code) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function load(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'pair_codes'`).first();
  let s = null;
  try { s = JSON.parse(row?.value ?? 'null'); } catch { /* start over */ }
  return { codes: Array.isArray(s?.codes) ? s.codes : [], fails: Number(s?.fails) || 0 };
}

async function save(env, s) {
  await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('pair_codes', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(JSON.stringify(s)).run();
}

/** A new code -> { code: 'ABCD-EFGH', expiresAt } */
export async function createPairingCode(env, now = Date.now()) {
  const code = randomCode();
  const s = await load(env);
  s.codes = s.codes.filter((c) => c.exp > now).slice(-(MAX_OPEN - 1));
  s.codes.push({ h: await digest(code), exp: now + CODE_TTL });
  s.fails = 0;
  await save(env, s);
  return { code: formatPairingCode(code), expiresAt: now + CODE_TTL };
}

/** true when `text` is an open code (which is then used up) */
export async function claimPairingCode(env, text, now = Date.now()) {
  const s = await load(env);
  const open = s.codes.filter((c) => c.exp > now);
  if (!open.length) return false;
  const code = normalizePairingCode(text);
  const h = code && await digest(code);
  const hit = h ? open.find((c) => c.h === h) : null;
  if (hit) {
    await save(env, { codes: open.filter((c) => c !== hit), fails: s.fails });
    return true;
  }
  const fails = s.fails + 1;
  await save(env, fails >= MAX_FAILS ? { codes: [], fails: 0 } : { codes: open, fails });
  return false;
}
