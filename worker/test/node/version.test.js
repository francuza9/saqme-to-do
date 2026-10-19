// One version number for the whole app: the Worker, the Linux/macOS app and package.json say the same.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION as appVersion } from '../../../local/saqme.mjs';

const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

describe('version', () => {
  it('is the same everywhere', () => {
    const pkg = JSON.parse(read('worker/package.json')).version;
    expect(/const VERSION = '([^']+)'/.exec(read('worker/src/index.js'))[1]).toBe(pkg);
    expect(appVersion).toBe(pkg);
    expect(/version 2>\/dev\/null \|\| echo ([0-9.]+)\)/.exec(read('scripts/setup.sh'))[1]).toBe(pkg);
  });
});
