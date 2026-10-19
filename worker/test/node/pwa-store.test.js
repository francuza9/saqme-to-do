// The phone app's store (worker/public/js/store.js) in Node: no IndexedDB here, so it runs in memory, and a
// stand-in database checks what happens when writes to it fail.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store } from '../../public/js/store.js';

async function newStore() {
  const s = new Store({ autoSync: false });
  await s.open();
  return s;
}
const taskTexts = (s, projectId) => s.tasks().filter((t) => !t.fields.deleted.v && t.fields.place.v.project === projectId).map((t) => t.fields.text.v).sort();

/** A database whose writes fail until `heal()`; then it records what was written. */
function flakyDb() {
  const db = {
    failing: true, closed: false, written: [],
    heal() { this.failing = false; this.closed = false; this.written = []; },   // from here on: what was really written
    transaction() {
      if (db.closed) throw Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' });
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
      const store = (name) => ({ put: (v, k) => db.written.push([name, k]), delete: (k) => db.written.push([name, k, 'delete']) });
      tx.objectStore = store;
      setTimeout(() => {
        if (db.failing) { tx.error = Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); tx.onerror?.(); tx.onabort?.(); } else tx.oncomplete?.();
      }, 1);
      return tx;
    },
  };
  return db;
}

afterEach(() => { vi.useRealTimers(); });

describe('phone app store', () => {
  it('moving a task to another project takes its subtasks along', async () => {
    const s = await newStore();
    const home = s.addProject('Home');
    const work = s.addProject('Work');
    const trip = s.addTask(home, { text: 'Plan trip' });
    s.addTask(home, { parentId: trip, text: 'Book flights' });
    s.addTask(home, { parentId: trip, text: 'Book hotel' });
    s.moveTask(trip, { projectId: work, parentId: null });
    expect(taskTexts(s, work)).toEqual(['Book flights', 'Book hotel', 'Plan trip']);
    expect(taskTexts(s, home)).toEqual([]);
    const flights = s.tasks().find((t) => t.fields.text.v === 'Book flights');
    expect(flights.fields.place.v.parent).toBe(trip);   // still under it
  });

  it('many random moves (touch drag, move to project) keep every task: never deleted, each in its tree once', async () => {
    const s = await newStore();
    const projects = [s.addProject('Home'), s.addProject('Work')];
    const ids = [];
    for (let i = 0; i < 18; i++) {
      const project = projects[i % 2];
      const parents = ids.filter((id) => s.get('task', id).fields.place.v.project === project);
      const parentId = i % 3 && parents.length ? parents[(i * 7) % parents.length] : null;
      ids.push(s.addTask(project, { parentId, text: `task ${i}` }));
    }
    let seed = 20261019;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 600; k++) {
      const id = ids[rnd(ids.length)];
      const projectId = projects[rnd(2)];
      const inProject = s.tasks().filter((t) => !t.fields.deleted.v && t.fields.place.v.project === projectId).map((t) => t.id);
      const parentId = rnd(3) ? null : inProject[rnd(inProject.length || 1)] ?? null;
      s.moveTask(id, { projectId, parentId: parentId === id ? null : parentId, index: rnd(6) });
      const live = s.tasks().filter((t) => !t.fields.deleted.v);
      expect(live.length, `after move ${k}`).toBe(ids.length);
      expect(projects.reduce((n, p) => n + s.tree(p).byId.size, 0), `every task in one tree, after move ${k}`).toBe(ids.length);
    }
    for (const ob of s.outbox.values()) expect(ob.fields.deleted?.v ?? false).toBe(false);
  });

  it('a write to the database that fails is kept, retried and reported until it works', async () => {
    vi.useFakeTimers();
    const s = await newStore();
    const db = flakyDb();
    s.db = db;
    const events = [];
    s.addEventListener('savefailed', () => events.push('failed'));
    s.addEventListener('saved', () => events.push('saved'));
    const p = s.addProject('Work');
    s.addTask(p, { text: 'Kept while storage is full' });
    s.setMeta({ cursor: 42 });
    const save = s.save();
    await vi.advanceTimersByTimeAsync(5);
    await save;
    expect(events).toEqual(['failed']);
    expect(s.saveError).toMatch(/out of storage/);
    expect(s.dirty.size).toBeGreaterThan(0);   // nothing was dropped as if it had been written
    expect(s.metaDirty).toBe(true);
    db.heal();
    await vi.advanceTimersByTimeAsync(3100);   // the retry
    await s.saving;
    expect(events).toEqual(['failed', 'saved']);
    expect(s.saveError).toBeNull();
    expect(s.dirty.size).toBe(0);
    const written = db.written.map(([store, k]) => `${store}:${k}`);
    expect(written).toContain('meta:cursor');
    expect(written.filter((w) => w.startsWith('rows:task:'))).toHaveLength(1);   // the rows and the cursor in one write
  });

  it('a database iOS closed in the background is opened again', async () => {
    vi.useFakeTimers();
    const s = await newStore();
    const db = flakyDb();
    db.closed = true;
    s.db = db;
    s.addProject('Work');
    await vi.advanceTimersByTimeAsync(50);
    await s.saving;
    expect(s.saveError).toMatch(/closing/);
    expect(s.dirty.size).toBeGreaterThan(0);
  });

  it('importing a list with a copied line keeps both copies (the copy gets a new id)', async () => {
    const s = await newStore();
    const r = s.importLists([{ name: 'Work.md', text: '- [ ] Call Anna ^aaaaaaa1\n- [ ] Call Anna ^aaaaaaa1\n- [ ] Other ^aaaaaaa2\n' }]);
    expect(r).toMatchObject({ added: 3, skipped: 0 });
    expect(s.tasks().filter((t) => t.fields.text.v === 'Call Anna').map((t) => t.id)).toHaveLength(2);
    expect(s.importLists([{ name: 'Work.md', text: '- [ ] Call Anna ^aaaaaaa1\n' }])).toMatchObject({ added: 0, skipped: 1 });   // a second import adds nothing
  });

  it('a server restored from a backup: everything is taken again, this device sends back what it has except deletes', async () => {
    const s = await newStore();
    const p = s.addProject('Work');
    const keep = s.addTask(p, { text: 'Made after the backup' });
    const gone = s.addTask(p, { text: 'Deleted after the backup' });
    s.deleteTask(gone);
    s.outbox.clear();   // all of it synced long ago
    s.setMeta({ cursor: 500, dbId: 'db1' });
    s.resetForRestore();
    expect(s.meta.cursor).toBe(0);
    expect(s.outbox.has(`task:${keep}`)).toBe(true);
    expect(s.outbox.has(`project:${p}`)).toBe(true);
    expect(s.outbox.has(`task:${gone}`)).toBe(false);   // its delete is not re-sent: the restore brings it back
    expect(Object.values(s.outbox.get(`task:${keep}`).fields).every((f) => f.base === -1)).toBe(true);
  });

  it('sync starts over when the server says it was restored', async () => {
    const s = await newStore();
    s.setMeta({ token: 'x'.repeat(43), cursor: 500, dbId: 'db1', deviceId: 'web-test' });
    const seen = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.cursor);
      const restored = body.cursor === 500;
      return { ok: true, status: 200, json: async () => ({ cursor: restored ? 120 : 120, more: false, changes: [], rejected: [], dbId: 'db1', serverTime: Date.now(), ...(restored ? { restored: true } : {}) }) };
    });
    try {
      await s.sync({ force: true });
    } finally { delete globalThis.fetch; }
    expect(seen).toEqual([500, 0]);   // told it was restored, it asked again from the start
    expect(s.meta.cursor).toBe(120);
  });
});
