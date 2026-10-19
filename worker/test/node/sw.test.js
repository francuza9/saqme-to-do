// The service worker's app shell must hold every file the app loads, or the app does not start offline.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const pub = new URL('../../public/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, pub), 'utf8');

describe('service worker', () => {
  it('caches every module the app imports, and the stylesheets and fonts index.html uses', () => {
    const shell = new Set([...read('sw.js').matchAll(/'([^']+\.(?:js|css|ttf|png|webmanifest|html))'/g)].map((m) => m[1]));
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const [, dep] of read(file).matchAll(/^import [^'"]*['"]\.\/([^'"]+)['"]/gm)) walk(`js/${dep}`);
    };
    walk('js/app.js');
    for (const f of seen) expect(shell.has(f), `${f} in sw.js`).toBe(true);
    for (const [, href] of read('index.html').matchAll(/(?:href|src)="([^"#:]+\.(?:css|js))"/g)) expect(shell.has(href.replace(/^\.\//, '')), `${href} in sw.js`).toBe(true);
    expect(readdirSync(new URL('js/', pub)).filter((f) => f.endsWith('.js')).every((f) => shell.has(`js/${f}`))).toBe(true);
  });
});
