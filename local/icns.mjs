#!/usr/bin/env node
// Wraps a 512x512 PNG into a macOS .icns file (used by setup.sh for the "Saqme To Do.app" icon; macOS
// scales it for the smaller sizes). The format is a header plus typed chunks; 'ic09' holds a 512 px PNG.
//   node icns.mjs icon-512.png AppIcon.icns
import { readFileSync, writeFileSync } from 'node:fs';

export function pngToIcns(png) {
  const chunk = Buffer.alloc(8);
  chunk.write('ic09', 0, 'ascii');
  chunk.writeUInt32BE(8 + png.length, 4);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(16 + png.length, 4);
  return Buffer.concat([head, chunk, png]);
}

if (process.argv[1]?.endsWith('icns.mjs')) {
  const [src, dest] = process.argv.slice(2);
  const png = readFileSync(src);
  if (png.readUInt32BE(16) !== 512 || png.readUInt32BE(20) !== 512) throw new Error(`${src} must be a 512x512 PNG`);
  writeFileSync(dest, pngToIcns(png));
}
