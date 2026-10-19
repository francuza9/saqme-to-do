// Fractional order keys ("a0" < "a0V" < "a1" ...), compared as plain ordinal strings.
// Algorithm from David Greenspan's "Implementing Fractional Indexing" (rocicorp/fractional-indexing, CC0):
// an integer part whose first character encodes its length, then a fractional part without trailing zeros.
// Appending at the end only grows keys logarithmically. desktop/sync-core.ps1 has a line-by-line port.

export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST_INT = 'A' + '0'.repeat(26);

function midpoint(a, b) {
  if (b != null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === '0' || (b && b.slice(-1) === '0')) throw new Error('trailing zero');
  if (b) {
    // strip the common prefix (a is padded with zeros while walking it)
    let n = 0;
    while ((a[n] || '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b != null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function integerLength(head) {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key) {
  const n = integerLength(key[0]);
  if (n > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, n);
}

export function isValidKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 128) return false;
  if (!/^[0-9A-Za-z]+$/.test(key) || key === SMALLEST_INT) return false;
  try {
    const i = integerPart(key);
    return key.slice(i.length).slice(-1) !== '0';
  } catch {
    return false;
  }
}

function incrementInteger(x) {
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) digs[i] = '0';
    else { digs[i] = DIGITS[d]; carry = false; }
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a0';
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') digs.push('0'); else digs.pop();
  return h + digs.join('');
}

function decrementInteger(x) {
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = 'z';
    else { digs[i] = DIGITS[d]; borrow = false; }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + 'z';
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') digs.push('z'); else digs.pop();
  return h + digs.join('');
}

/** A key strictly between a and b (either may be null = open end). */
export function keyBetween(a, b) {
  if (a != null && !isValidKey(a)) throw new Error(`invalid order key: ${a}`);
  if (b != null && !isValidKey(b)) throw new Error(`invalid order key: ${b}`);
  if (a != null && b != null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a == null) {
    if (b == null) return 'a0';
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INT) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res == null) throw new Error('cannot decrement any more');
    return res;
  }
  if (b == null) {
    const ia = integerPart(a);
    const i = incrementInteger(ia);
    return i == null ? ia + midpoint(a.slice(ia.length), null) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  if (ia === ib) return ia + midpoint(fa, b.slice(ib.length));
  const i = incrementInteger(ia);
  if (i == null) throw new Error('cannot increment any more');
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/** n increasing keys strictly between a and b. */
export function keysBetween(a, b, n) {
  const out = [];
  let lo = a;
  for (let k = 0; k < n; k++) { lo = keyBetween(lo, b); out.push(lo); }
  return out;
}

/** Ordinal comparison used everywhere for (position, id) sibling order. */
export function cmpPos(pa, ida, pb, idb) {
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (ida === idb) return 0;
  return ida < idb ? -1 : 1;
}

/**
 * Given siblings in their desired order with their current keys (null = none yet), returns the
 * keys to (re)assign as Map(index -> key). Keeps the longest strictly increasing run of valid
 * existing keys so a single move only re-keys the moved item.
 */
export function rekey(keys) {
  const n = keys.length;
  const valid = keys.map((k) => k != null && isValidKey(k));
  // longest strictly increasing subsequence over valid keys (O(n^2), sibling lists are small)
  const len = new Array(n).fill(0);
  const prev = new Array(n).fill(-1);
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    len[i] = 1;
    for (let j = 0; j < i; j++) {
      if (valid[j] && keys[j] < keys[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);
  const out = new Map();
  let i = 0;
  while (i < n) {
    if (keep.has(i)) { i++; continue; }
    let j = i;
    while (j < n && !keep.has(j)) j++;
    const lo = i > 0 ? keys[i - 1] : null;  // previous index is kept (or none)
    const hi = j < n ? keys[j] : null;
    const fresh = keysBetween(lo, hi, j - i);
    for (let k = i; k < j; k++) out.set(k, fresh[k - i]);
    i = j;
  }
  return out;
}
