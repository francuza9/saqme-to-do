// Dependency-free QR Code encoder (ISO/IEC 18004, model 2): byte mode, UTF-8 input, EC levels L/M/Q/H.
// desktop/qr.ps1 is a port that must produce the IDENTICAL matrix (same version choice, same mask
// penalty and tie-breaks), so keep any algorithm change in sync there. Layout and tables follow the
// well-known structure of Nayuki's "QR Code generator" (MIT); the mask penalty follows ZXing's rules.

const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT = [1, 0, 3, 2]; // 2-bit EC level code in the format info, indexed like ECL_INDEX

// Per EC level, indexed by version (index 0 unused): EC codewords per block, and number of blocks.
const EC_PER_BLOCK = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// GF(256) with primitive polynomial 0x11D: EXP is doubled so EXP[LOG[a] + LOG[b]] needs no modulo.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++, x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)) { EXP[i] = x; LOG[x] = i; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

// Mask predicates: x = column, y = row; true = flip the module.
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Modules available for data + EC codewords (everything except function patterns and format/version info).
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver, e) => (rawDataModules(ver) >> 3) - EC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];

// Centre coordinates of the alignment patterns (same list for rows and columns).
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const pos = [6];
  for (let p = ver * 4 + 10; pos.length < count; p -= step) pos.splice(1, 0, p);
  return pos;
}

// Reed-Solomon generator polynomial prod(x - a^i), i < degree; coefficients high to low, leading 1 omitted.
function rsGenerator(degree) {
  const g = new Uint8Array(degree);
  g[degree - 1] = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) g[j] = (g[j] ? EXP[LOG[g[j]] + i] : 0) ^ (j + 1 < degree ? g[j + 1] : 0);
  }
  return g;
}

// EC codewords = remainder of data(x) * x^degree divided by the generator (polynomial long division).
function rsRemainder(data, gen) {
  const r = new Uint8Array(gen.length);
  for (const b of data) {
    const f = b ^ r[0];
    r.copyWithin(0, 1);
    r[r.length - 1] = 0;
    if (f) for (let i = 0; i < r.length; i++) if (gen[i]) r[i] ^= EXP[LOG[gen[i]] + LOG[f]];
  }
  return r;
}

// Split data into blocks, append each block's EC codewords, interleave column-wise.
function interleave(data, ver, e) {
  const nb = NUM_BLOCKS[e][ver], ecLen = EC_PER_BLOCK[e][ver], raw = rawDataModules(ver) >> 3;
  const numShort = nb - (raw % nb), shortLen = Math.floor(raw / nb) - ecLen; // data codewords in a short block
  const gen = rsGenerator(ecLen), blocks = [], ecs = [];
  for (let b = 0, k = 0; b < nb; b++) {
    const len = shortLen + (b < numShort ? 0 : 1);
    blocks.push(data.subarray(k, k + len));
    ecs.push(rsRemainder(data.subarray(k, k + len), gen));
    k += len;
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) for (const blk of blocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < ecLen; i++) for (const ec of ecs) out.push(ec[i]);
  return out;
}

// 15-bit format info (EC level + mask, BCH(15,5), XOR 0x5412) in both copies, plus the dark module.
function drawFormat(set, size, e, mask) {
  const data = (ECL_FORMAT[e] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const b = (bits >>> i) & 1;
    if (i < 6) set(8, i, b); else if (i < 8) set(8, i + 1, b); else if (i === 8) set(7, 8, b); else set(14 - i, 8, b);
    if (i < 8) set(size - 1 - i, 8, b); else set(8, size - 15 + i, b);
  }
  set(8, size - 8, 1);
}

// Penalty (ZXing flavour): N1 runs of >= 5 equal modules (3 + extra), N2 2x2 equal blocks (3 each),
// N3 1:1:3:1:1 finder-like runs with 4 light modules on either side, outside counts as light (40 each),
// N4 dark ratio deviation from 50% in whole 5% steps (10 each).
function penalty(m) {
  const size = m.length;
  let p = 0, dark = 0;
  const lines = [];
  for (let a = 0; a < size; a++) { lines.push(m[a].join('')); lines.push(m.map((row) => row[a]).join('')); }
  for (const s of lines) {
    for (const run of s.match(/0{5,}|1{5,}/g) || []) p += run.length - 2;
    const t = '0000' + s + '0000'; // outside the symbol counts as light
    for (let i = t.indexOf('1011101'); i >= 0; i = t.indexOf('1011101', i + 1)) {
      if (t.startsWith('0000', i - 4) || t.startsWith('0000', i + 7)) p += 40;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = m[y][x];
      dark += c;
      if (x < size - 1 && y < size - 1 && c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
  }
  return p + Math.floor((Math.abs(dark * 2 - size * size) * 10) / (size * size)) * 10;
}

/** Encode text (UTF-8, byte mode) into a QR matrix without quiet zone: rows of booleans, true = dark. */
export function qrMatrix(text, ecl = 'M') {
  const e = ECL_INDEX[String(ecl).toUpperCase()];
  if (e === undefined) throw new Error(`qrMatrix: invalid error correction level "${ecl}" (use L, M, Q or H)`);
  const bytes = new TextEncoder().encode(String(text));

  // 1. smallest version whose capacity fits mode (4 bits) + length (8 or 16 bits) + data
  let ver = 1;
  while (ver <= 40 && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver, e) * 8) ver++;
  if (ver > 40) {
    const max = (dataCodewords(40, e) * 8 - 20) >> 3;
    throw new Error(`qrMatrix: ${bytes.length} bytes do not fit in a QR code at EC level ${'LMQH'[e]} (max ${max})`);
  }

  // 2. data codewords: mode 0100, count, bytes. The header is 12 or 20 bits, so the 4-bit terminator
  //    ends on a byte boundary; the rest is alternating pad bytes 0xEC 0x11.
  const dataLen = dataCodewords(ver, e), data = new Uint8Array(dataLen);
  let bl = 0;
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--, bl++) data[bl >> 3] |= ((val >>> i) & 1) << (7 - (bl & 7)); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  for (let i = (bl + 4) >> 3, k = 0; i < dataLen; i++, k++) data[i] = k % 2 ? 0x11 : 0xec;
  const codewords = interleave(data, ver, e);

  // 3. function patterns: timing, finders (with separators), alignment, reserved format area, version info
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(0));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark ? 1 : 0; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = alignmentPositions(ver), last = al.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue; // finder corners
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(set, size, e, 0);
  if (ver >= 7) { // 18-bit version info, BCH(18,6), in two 6x3 blocks
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = (bits >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, b);
      set(c, a, b);
    }
  }

  // 4. codeword bits in the zigzag: 2-module-wide columns from the right, alternating up/down, skipping
  //    column 6 (timing). Remainder bits stay light.
  for (let right = size - 1, i = 0; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fn[y][x] || i >= codewords.length * 8) continue;
        mod[y][x] = (codewords[i >> 3] >>> (7 - (i & 7))) & 1;
        i++;
      }
    }
  }

  // 5. try all 8 masks, keep the lowest penalty (first one wins ties)
  let best = null, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = mod.map((row, y) => row.map((c, x) => (!fn[y][x] && MASKS[mask](x, y) ? c ^ 1 : c)));
    drawFormat((x, y, dark) => { m[y][x] = dark ? 1 : 0; }, size, e, mask);
    const p = penalty(m);
    if (p < bestPenalty) { best = m; bestPenalty = p; }
  }
  return best.map((row) => row.map((c) => c === 1));
}

/**
 * Render with Unicode half blocks, two module rows per text line. By default for a DARK terminal:
 * light modules and the quiet zone are printed as blocks, dark modules as spaces; `invert` flips that.
 */
export function qrToTerminal(matrix, { margin = 2, invert = false } = {}) {
  const n = matrix.length, total = n + margin * 2;
  const lit = (x, y) => {
    if (y >= total) return false; // half line below the last row: terminal background
    const inside = x >= margin && x < margin + n && y >= margin && y < margin + n;
    const dark = inside && matrix[y - margin][x - margin];
    return invert ? dark : !dark;
  };
  const lines = [];
  for (let y = 0; y < total; y += 2) {
    let line = '';
    for (let x = 0; x < total; x++) {
      const top = lit(x, y), bottom = lit(x, y + 1);
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Render as an SVG string: light background rect + one <path> for all dark modules (row runs merged). */
export function qrToSvg(matrix, { margin = 4, scale = 8, dark = '#000', light = '#fff' } = {}) {
  const total = matrix.length + margin * 2, px = total * scale;
  let d = '';
  matrix.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      d += `M${x + margin},${y + margin}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
