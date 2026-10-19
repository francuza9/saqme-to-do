#!/usr/bin/env node
// Rebuilds worker/public/fonts from the FiraGO release (SIL OFL 1.1, no Reserved Font Name, so a subset may
// keep its name). Keeps Latin, Cyrillic, Georgian (incl. Mtavruli), punctuation, currency (₾) and every
// OpenType feature (tabular figures etc.). Dev tool only; subset-font is not a project dependency:
//   npm i --no-save subset-font@2
//   node scripts/dev/subset-fonts.mjs <folder with FiraGO-Regular/-Italic/-Medium/-SemiBold.ttf>
// Source: https://github.com/bBoxType/FiraGO (Fonts/FiraGO_TTF_1001)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/dev/subset-fonts.mjs <FiraGO ttf folder>'); process.exit(2); }
const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'worker', 'public', 'fonts');
const ranges = [
  [0x20, 0x7e], [0xa0, 0xff], [0x100, 0x24f], [0x300, 0x36f],   // Latin + diacritics
  [0x400, 0x4ff],                                                  // Cyrillic
  [0x10a0, 0x10ff], [0x1c90, 0x1cbf], [0x2d00, 0x2d2f],           // Georgian, Mtavruli, Nuskhuri
  [0x2000, 0x206f], [0x20a0, 0x20cf], [0x2100, 0x214f],           // punctuation, currency, letterlike
  [0x2190, 0x21ff], [0x2212, 0x2212], [0x2713, 0x2713],           // arrows, minus, check
];
let text = '';
for (const [a, b] of ranges) for (let c = a; c <= b; c++) text += String.fromCodePoint(c);
for (const name of ['FiraGO-Regular', 'FiraGO-Italic', 'FiraGO-Medium', 'FiraGO-SemiBold']) {
  const buf = await subsetFont(readFileSync(join(src, `${name}.ttf`)), text, { targetFormat: 'truetype', preserveNameIds: [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17, 21, 22] });
  writeFileSync(join(out, `${name}.ttf`), buf);
  console.log(`${name}.ttf  ${(buf.length / 1024).toFixed(0)} kB`);
}
