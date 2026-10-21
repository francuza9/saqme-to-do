// One version number for the whole app: "version" in worker/package.json. The Worker, the Linux/macOS app, the
// Windows app (desktop/update-core.ps1 Get-AppRelease; setup.ps1 writes it to release.json), setup and the release
// workflow read it from there; nothing else spells it out (CONTRIBUTING.md, "How to ship an update").
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION as appVersion } from '../../../local/saqme.mjs';
import { VERSION as workerVersion } from '../../src/version.js';
import { releaseInfo } from '../../../local/update.mjs';

const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

describe('version', () => {
  const pkg = JSON.parse(read('worker/package.json')).version;

  it('is worker/package.json\'s everywhere', () => {
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
    expect(workerVersion).toBe(pkg);
    expect(appVersion).toBe(pkg);
    expect(releaseInfo().version).toBe(pkg);
    const lock = JSON.parse(read('worker/package-lock.json'));
    expect([lock.version, lock.packages[''].version]).toEqual([pkg, pkg]);   // (npm version keeps them together)
  });

  it('is not written anywhere else', () => {
    for (const f of ['worker/src/index.js', 'local/saqme.mjs', 'local/server.mjs', 'scripts/setup.sh', 'scripts/setup.ps1', 'desktop/widget.ps1', 'desktop/update.ps1']) {
      expect(read(f), f).not.toMatch(new RegExp(`['"]${pkg.replace(/\./g, '\\.')}['"]`));
    }
    expect(read('scripts/setup.sh')).toMatch(/worker\/package\.json/);
    expect(read('.github/workflows/release.yml')).toMatch(/require\('\.\/worker\/package\.json'\)\.version/);
  });
});
