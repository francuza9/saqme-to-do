import { describe, it, expect } from 'vitest';
import { keyBetween, keysBetween, isValidKey, rekey } from '../../public/js/keys.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('fractional keys', () => {
  it('starts in the middle and appends with slowly growing keys', () => {
    expect(keyBetween(null, null)).toBe('a0');
    let k = 'a0';
    for (let i = 0; i < 5000; i++) {
      const n = keyBetween(k, null);
      expect(n > k).toBe(true);
      k = n;
    }
    expect(k.length).toBeLessThanOrEqual(4);
  });

  it('prepends below the first key', () => {
    let k = 'a0';
    for (let i = 0; i < 2000; i++) {
      const n = keyBetween(null, k);
      expect(n < k).toBe(true);
      expect(isValidKey(n)).toBe(true);
      k = n;
    }
  });

  it('keeps order under random insertions', () => {
    const r = rng(42);
    const keys = [keyBetween(null, null)];
    for (let i = 0; i < 3000; i++) {
      const at = Math.floor(r() * (keys.length + 1));
      const k = keyBetween(at > 0 ? keys[at - 1] : null, at < keys.length ? keys[at] : null);
      expect(isValidKey(k)).toBe(true);
      keys.splice(at, 0, k);
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow();
    expect(() => keyBetween('a1', 'a1')).toThrow();
    expect(isValidKey('a00')).toBe(false);   // trailing zero in the fraction
    expect(isValidKey('b0')).toBe(false);    // integer part too short
    expect(isValidKey('a0!')).toBe(false);
    expect(isValidKey('')).toBe(false);
  });

  it('generates n keys between two keys', () => {
    const ks = keysBetween('a0', 'a1', 10);
    expect(ks).toHaveLength(10);
    expect(['a0', ...ks, 'a1'].every((k, i, a) => i === 0 || a[i - 1] < k)).toBe(true);
  });
});

describe('rekey (minimal re-keying of a reordered sibling list)', () => {
  it('re-keys only the moved item', () => {
    const keys = ['a0', 'a1', 'a2', 'a3', 'a4'];
    // move 'a4' to the front
    const moved = ['a4', 'a0', 'a1', 'a2', 'a3'];
    const out = rekey(moved);
    expect([...out.keys()]).toEqual([0]);
    expect(out.get(0) < 'a0').toBe(true);
  });

  it('fills missing and invalid keys and keeps the result strictly increasing', () => {
    const r = rng(7);
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(r() * 12);
      const keys = Array.from({ length: n }, () => {
        const x = r();
        if (x < 0.2) return null;
        if (x < 0.25) return 'bad!';
        return keysBetween(null, null, 1)[0].slice(0, 1) + 'abcdefghijk'[Math.floor(r() * 11)];
      });
      const out = rekey(keys);
      const final = keys.map((k, i) => (out.has(i) ? out.get(i) : k));
      for (let i = 1; i < final.length; i++) expect(final[i - 1] < final[i]).toBe(true);
      expect(final.every(isValidKey)).toBe(true);
    }
  });

  it('handles duplicate keys', () => {
    const out = rekey(['a1', 'a1', 'a1']);
    expect(out.size).toBe(2);
  });
});
