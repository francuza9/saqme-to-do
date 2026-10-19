// Pairing codes (src/pairing.js): how the app on an iPhone's Home Screen gets the key (BUGS #1).
import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index.js';
import { createPairingCode, claimPairingCode, CODE_TTL } from '../../src/pairing.js';
import { normalizePairingCode, CODE_ALPHABET } from '../../public/js/pairing.js';

const TOKEN = env.AUTH_TOKEN;

async function call(path, { body = {}, token = TOKEN, origin } = {}) {
  const ctx = createExecutionContext();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const res = await worker.fetch(new Request(`https://saqme.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const newCode = async () => (await (await call('/api/pair/code')).json()).code;
const claim = (code, origin) => call('/api/pair/claim', { body: { code }, token: null, origin });
const writesFor = async (fn) => {
  const before = (await env.DB.prepare(`SELECT value FROM meta WHERE key = 'pair_codes'`).first())?.value ?? null;
  await fn();
  const after = (await env.DB.prepare(`SELECT value FROM meta WHERE key = 'pair_codes'`).first())?.value ?? null;
  return before !== after;
};

beforeEach(async () => { await env.DB.prepare(`DELETE FROM meta WHERE key = 'pair_codes'`).run(); });

describe('pairing codes', () => {
  it('only a device with the key can make one; it looks like ABCD-EFGH without look-alike characters', async () => {
    expect((await call('/api/pair/code', { token: null })).status).toBe(401);
    expect((await call('/api/pair/code', { token: 'wrong' })).status).toBe(401);
    const res = await call('/api/pair/code');
    expect(res.status).toBe(200);
    const { code, expiresAt } = await res.json();
    expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{4}-[${CODE_ALPHABET}]{4}$`));
    expect(code).not.toMatch(/[01OIL]/);
    expect(expiresAt - Date.now()).toBeGreaterThan(CODE_TTL - 5000);
  });

  it('trades a code for the key once, across origins, however it was typed', async () => {
    const code = await newCode();
    const res = await claim(` ${code.toLowerCase().replace('-', ' ')} `, 'https://someone.github.io');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ token: TOKEN });
    const again = await claim(code);
    expect(again.status).toBe(400);
    expect((await again.json()).token).toBeUndefined();
  });

  it('a wrong or expired code gets nothing', async () => {
    const now = Date.now();
    const { code } = await createPairingCode(env, now);
    expect(await claimPairingCode(env, 'ABCD-EFGH', now)).toBe(false);
    expect(await claimPairingCode(env, code, now + CODE_TTL + 1)).toBe(false);
    for (const bad of [undefined, null, 42, '', 'ABCD-EFG', 'ABCD-EFGHJ', 'ABCD-EFG0']) expect(normalizePairingCode(bad)).toBeNull();
    expect((await call('/api/pair/claim', { body: null, token: null })).status).toBe(400);
  });

  it('several open codes work side by side (the computer and Safari can each show one), at most 5', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await newCode());
    expect((await claim(codes[0])).status).toBe(400);   // the oldest made room
    for (const c of codes.slice(1).reverse()) expect((await claim(c)).status).toBe(200);
  });

  it('ten wrong guesses drop every open code', async () => {
    const code = await newCode();
    for (let i = 0; i < 9; i++) expect((await claim('ZZZZ-ZZZZ')).status).toBe(400);
    expect((await claim(code)).status).toBe(200);   // a success in between is fine
    const next = await newCode();
    for (let i = 0; i < 10; i++) await claim('ZZZZ-ZZZZ');
    expect((await claim(next)).status).toBe(400);
  });

  it('with no code open, a claim writes nothing (strangers cannot run up the database)', async () => {
    expect(await writesFor(() => claim('ABCD-EFGH'))).toBe(false);
    await newCode();
    expect(await writesFor(() => claim('ABCD-EFGH'))).toBe(true);
  });
});
