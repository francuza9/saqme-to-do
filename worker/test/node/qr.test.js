import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qrMatrix, qrToTerminal, qrToSvg } from '../../public/js/qr.js';

const TOKEN = 'q3Zx-7_bN0aR5tYc2LwPfE9kHuJ1mVoDsG8iT4yQ6Xe'; // 43 base64url chars (32-byte key)
const PAIR_URL = 'https://saqme.example-sub.workers.dev/#pair=' + TOKEN;
const LONG_URL = 'https://saqme.a-rather-long-account-name.workers.dev/#pair=' + TOKEN + '&d=desk1';
const UTF8_TEXT = 'საქმე ✓ — to do';
const TEXT_300 = Array.from({ length: 300 }, (_, i) => String.fromCharCode(33 + ((i * 37) % 94))).join('');

const versionOf = (m) => (m.length - 17) / 4;
const toText = (m) => m.map((row) => row.map((c) => (c ? '1' : '0')).join('')).join('\n');

// Rasterise (scale 4, quiet zone 4, dark = black on white) and decode with jsQR.
function decode(matrix, scale = 4, quiet = 4) {
  const px = (matrix.length + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const o = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
      }
    }
  }));
  return jsQR(rgba, px, px, { inversionAttempts: 'dontInvert' });
}

describe('qrMatrix', () => {
  it('uses a real 43-char pairing token', () => {
    expect(TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(PAIR_URL).toHaveLength(87);
    expect(LONG_URL).toHaveLength(110);
  });

  it.each([
    ['"A"', 1, 'A'],
    ['"HELLO WORLD"', 1, 'HELLO WORLD'],
    ['the pairing URL', 6, PAIR_URL], // 87 bytes: v5-M holds 84 bytes, v6-M holds 106
    ['a 300-char string', 13, TEXT_300], // v12-M holds 287 bytes, v13-M 331
    ['a UTF-8 string', 3, UTF8_TEXT], // 29 UTF-8 bytes: v2-M holds 26, v3-M 42
    ['a 110-char URL', 7, LONG_URL], // v6-M holds 106 bytes, v7-M 122 (first version with version info)
  ])('encodes %s at EC level M as version %i and round-trips it through jsQR', (_label, version, text) => {
    const m = qrMatrix(text);
    expect(m.length).toBe(version * 4 + 17);
    expect(m.every((row) => row.length === m.length && row.every((c) => typeof c === 'boolean'))).toBe(true);
    expect(versionOf(m)).toBe(version);
    expect(decode(m)?.data).toBe(text);
  });

  // Byte-mode capacity of the pairing URL (87 bytes): L v5 = 106; M v6 = 106 (v5 84);
  // Q v8 = 108 (v7 86); H v9 = 98 (v8 84).
  it.each([['L', 5], ['M', 6], ['Q', 8], ['H', 9]])('encodes the pairing URL at EC level %s as version %i', (ecl, version) => {
    const m = qrMatrix(PAIR_URL, ecl);
    expect(versionOf(m)).toBe(version);
    expect(decode(m)?.data).toBe(PAIR_URL);
  });

  it('is deterministic and accepts lower-case EC levels', () => {
    expect(toText(qrMatrix(PAIR_URL, 'q'))).toBe(toText(qrMatrix(PAIR_URL, 'Q')));
  });

  it('throws clear errors for oversized data and bad EC levels', () => {
    expect(() => qrMatrix('x'.repeat(2953), 'L')).not.toThrow(); // exact version-40-L capacity
    expect(() => qrMatrix('x'.repeat(2954), 'L')).toThrow(/2954 bytes do not fit.*max 2953/);
    expect(() => qrMatrix('A', 'X')).toThrow(/invalid error correction level/);
  });
});

describe('renderers', () => {
  const m = qrMatrix(PAIR_URL);
  const n = m.length;

  it('qrToTerminal: dark-background default lights the quiet zone and light modules', () => {
    const margin = 2, total = n + margin * 2;
    const lines = qrToTerminal(m).split('\n');
    expect(lines).toHaveLength(Math.ceil(total / 2));
    expect(lines.every((l) => l.length === total && /^[█▀▄ ]+$/.test(l))).toBe(true);
    expect(lines[0]).toBe('█'.repeat(total));
    // decode the half blocks back into module rows: printed = light
    const lit = { '█': [1, 1], '▀': [1, 0], '▄': [0, 1], ' ': [0, 0] };
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const row = y + margin, ch = lines[row >> 1][x + margin];
        expect(lit[ch][row & 1] === 1).toBe(!m[y][x]);
      }
    }
  });

  it('qrToTerminal: invert prints dark modules and leaves the quiet zone blank', () => {
    const lines = qrToTerminal(m, { invert: true, margin: 1 }).split('\n');
    expect(lines).toHaveLength(Math.ceil((n + 2) / 2));
    expect(lines[0][0]).toBe(' ');
    expect(lines[0][1]).toBe('▄'); // row 1 = top row of the finder pattern
  });

  it('qrToSvg: one path covering exactly the dark modules', () => {
    const svg = qrToSvg(m, { scale: 5 });
    const total = n + 8;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${total} ${total}"`);
    expect(svg).toContain(`width="${total * 5}"`);
    expect(svg).toContain('crispEdges');
    expect(svg.match(/<path /g)).toHaveLength(1);
    const covered = [...svg.matchAll(/h(\d+)v1/g)].reduce((s, r) => s + Number(r[1]), 0);
    expect(covered).toBe(m.flat().filter(Boolean).length);
  });
});

// Cross-language check: desktop/qr.ps1 (Windows PowerShell 5.1) must build the identical matrix.
const which = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const hasPowershell = which('powershell.exe') && which('wslpath');

describe('desktop/qr.ps1 parity', () => {
  it.skipIf(!hasPowershell)('produces the same matrices as qr.js', () => {
    const cases = [
      [LONG_URL, 'M'], // first: its timing includes PowerShell warm-up
      [PAIR_URL, 'M'],
      [PAIR_URL, 'H'],
      [UTF8_TEXT, 'Q'],
      [TEXT_300, 'L'],
      ['HELLO WORLD', 'm'],
    ];
    const ps1 = execFileSync('wslpath', ['-w', fileURLToPath(new URL('../../../desktop/qr.ps1', import.meta.url))], { encoding: 'utf8' }).trim();
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `. '${ps1.replace(/'/g, "''")}'`,
      `foreach ($job in @(${cases.map(([t, e]) => `@('${b64(t)}', '${e}')`).join(', ')})) {`,
      '  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($job[0]))',
      '  $sw = [Diagnostics.Stopwatch]::StartNew()',
      '  $m = Get-QrMatrix -Text $text -Ecl $job[1]',
      '  $sw.Stop()',
      '  "# $($sw.ElapsedMilliseconds)"',
      '  ConvertTo-QrText $m',
      "  '--'",
      '}',
      "try { $null = Get-QrMatrix ('x' * 2954) 'L'; 'no error' } catch { $_.Exception.Message }",
    ].join('\n');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }); // stderr: PS progress noise

    const chunks = out.replace(/\r/g, '').trim().split('\n--\n');
    expect(chunks).toHaveLength(cases.length + 1);
    cases.forEach(([text, ecl], i) => {
      const [timing, ...rows] = chunks[i].split('\n');
      const ms = Number(timing.slice(2));
      console.log(`qr.ps1: ${text.length} chars @${ecl} -> v${versionOf(qrMatrix(text, ecl))} in ${ms} ms`);
      expect(rows.join('\n'), `${JSON.stringify(text)} @${ecl}`).toBe(toText(qrMatrix(text, ecl)));
      if (text === LONG_URL) expect(ms).toBeLessThan(1500);
    });
    expect(chunks[cases.length]).toMatch(/2954 bytes do not fit.*max 2953/);
  }, 60_000);
});
