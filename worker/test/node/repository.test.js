// Every place that names this project's GitHub repository agrees with worker/package.json ("repository"):
// a fork or a rename changes it with scripts/dev/set-repository.mjs, which updates them all.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { FILES, references, repoOf } from '../../../scripts/dev/set-repository.mjs';

const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

describe('repository name', () => {
  const { owner, name } = repoOf(JSON.parse(read('worker/package.json')));
  it('is the one in package.json everywhere', () => {
    let n = 0;
    for (const f of FILES) {
      for (const r of references(read(f))) {
        n++;
        expect(r.repo, `${f}: ${r.form}`).toBe(r.form === 'pages' ? `${owner.toLowerCase()}/${name}` : `${owner}/${name}`);
      }
    }
    expect(n).toBeGreaterThan(8);   // the one-liners, the setup scripts, the Pages address
  });
  it('the setup scripts download from it', () => {
    expect(read('scripts/setup.ps1')).toContain(`$Repo = '${owner}/${name}'`);
    expect(read('scripts/setup.sh')).toContain(`REPO="\${SAQME_REPO:-${owner}/${name}}"`);
  });
});

describe('README images', () => {
  const readme = read('README.md');
  it('are plain <img> tags: the GitHub mobile app shows <picture> / srcset as a broken image', () => {
    expect(readme).not.toMatch(/<picture|<source|srcset=/i);
  });
  it('all exist', () => {
    const srcs = [...readme.matchAll(/<img\s[^>]*src="([^"]+)"/g), ...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
    expect(srcs.length).toBeGreaterThan(2);
    for (const src of srcs) expect(existsSync(new URL(`../../../${src}`, import.meta.url)), src).toBe(true);
  });
});
