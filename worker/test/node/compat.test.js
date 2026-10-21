// Apps and Workers of different versions while an update is under way (worker/src/version.js): a Worker from
// before 1.1.0 says no API version (it is 1), a newer one may send fields an app does not know. Apps tell
// "your sync service is not updated yet" from an error, and keep syncing either way.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, OLDER_SERVER, SHARING_API } from '../../public/js/store.js';
import { SHARING_API as WORKER_SHARING_API, API_VERSION, MIN_WORKER_API } from '../../src/version.js';
import { newState, syncCycle } from '../../../local/engine.mjs';

/** A sync service that answers every sync with `extra` on top of an empty answer, and 404 to anything else. */
function server(extra) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/sync')) return new Response(JSON.stringify({ cursor: 0, more: false, changes: [], rejected: [], serverTime: Date.now(), dbId: 'db1', ...extra }), { status: 200 });
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };
  return { fetchImpl, calls };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('API versions', () => {
  it('the phone app\'s and the Windows app\'s idea of what sharing needs is the Worker\'s', () => {
    expect(SHARING_API).toBe(WORKER_SHARING_API);
    const widget = readFileSync(new URL('../../../desktop/widget.ps1', import.meta.url), 'utf8');
    expect(Number(widget.match(/^\$script:SharingApi = (\d+)/m)?.[1])).toBe(WORKER_SHARING_API);
    expect(MIN_WORKER_API).toBeLessThanOrEqual(API_VERSION);
  });

  it('a Worker from before 1.1.0 (no api in its answers): the phone app syncs, and joining a list says the Worker is not updated yet', async () => {
    const s = server({});
    const store = new Store({ base: 'https://old.test', autoSync: false });
    await store.open();
    store.setMeta({ token: 'k'.repeat(43) });
    vi.stubGlobal('fetch', s.fetchImpl);
    await store.sync();
    expect(store.status.state).toBe('idle');
    expect(store.meta.serverApi).toBe(1);
    await expect(store.joinShare('https://owner.test/join#code=cccccccccccccccccccccc', { fetchImpl: s.fetchImpl })).rejects.toThrow(OLDER_SERVER);
    expect(s.calls.some((u) => u.includes('/api/remotes/'))).toBe(false);
  });

  it('a newer Worker (a higher api, fields this app does not know): the phone app syncs as usual', async () => {
    const s = server({ api: 99, version: '99.0.0', somethingNew: { a: 1 } });
    const store = new Store({ base: 'https://new.test', autoSync: false });
    await store.open();
    store.setMeta({ token: 'k'.repeat(43) });
    vi.stubGlobal('fetch', s.fetchImpl);
    await store.sync();
    expect(store.status.state).toBe('idle');
    expect(store.meta).toMatchObject({ serverApi: 99, serverVersion: '99.0.0' });
    expect(store.olderServer(SHARING_API)).toBe(false);
  });

  it('the desktop engine reads the Worker\'s release from its answers (none: 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saqme-compat-'));
    mkdirSync(join(dir, 'lists'));
    try {
      for (const [extra, api, version] of [[{}, 1, ''], [{ api: 3, version: '1.1.0' }, 3, '1.1.0']]) {
        const transport = async () => ({ status: 200, data: { cursor: 0, more: false, changes: [], rejected: [], serverTime: Date.now(), dbId: 'db1', ...extra } });
        const res = await syncCycle({ state: newState(), statePath: join(dir, 'state.json'), listsDir: join(dir, 'lists'), transport, deviceId: 'pc', settleMs: 0, applyPlan: () => true });
        expect(res).toMatchObject({ status: 'synced', api, workerVersion: version });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
