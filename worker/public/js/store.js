// Local-first data store for the PWA: everything lives in memory + IndexedDB and every edit is applied
// locally at once. Changes queue in an outbox (coalesced per field) and a background sync sends them to
// the Worker, then folds the server's canonical rows back in (keeping edits made while a request was in
// flight). Protocol: docs/sync.md.

import { buildTree, positionAt, subtreeIds, newId, cleanProjectName } from './model.js';
import { keyBetween, cmpPos } from './keys.js';
import { listTree, treeToMarkdown, toFileName, MARKS, isValidDate as validDate } from './markdown.js';

const DB_NAME = 'saqme';
const MAX_BATCH = 100;
const MAX_BATCH_BYTES = 400_000;
const POLL_MS = 10_000;
const EDIT_DELAY_MS = 1_000;

// ---------------------------------------------------------------- IndexedDB
function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function openDb() {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => {
    for (const s of ['rows', 'outbox', 'meta']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
  };
  return req(r);
}
async function readAll(db, store) {
  const tx = db.transaction(store, 'readonly');
  const [keys, values] = await Promise.all([req(tx.objectStore(store).getAllKeys()), req(tx.objectStore(store).getAll())]);
  return keys.map((k, i) => [k, values[i]]);
}

function emptyRow(kind, id) {
  const f = (v) => ({ v, ts: 0 });
  if (kind === 'task') return { kind, id, seq: 0, fields: { place: f(null), text: f(''), status: f(' '), due: f(null), notes: f(''), deleted: f(false) } };
  if (kind === 'project') return { kind, id, seq: 0, fields: { name: f(''), pos: f('a0'), deleted: f(false) } };
  if (kind === 'setting') return { kind, id, seq: 0, fields: { value: f('') } };
  return { kind, id, seq: 0, fields: { resolved: f(false) } };
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const validId = (id) => typeof id === 'string' && /^[0-9a-z]{8,32}$/.test(id);

export class Store extends EventTarget {
  /**
   * base: API origin for tests (http://127.0.0.1:port). Without it the app talks to its own origin, or to
   * meta.server when it was paired with a Worker elsewhere (the app hosted as a static site, e.g. GitHub Pages).
   */
  constructor({ base = '', autoSync = true } = {}) {
    super();
    this.base = base;
    this.autoSync = autoSync;
    this.rows = new Map();     // 'kind:id' -> row (server state with pending local edits on top)
    this.outbox = new Map();   // 'kind:id' -> { kind, id, fields: { name: { v, ts, base } } }
    this.meta = { deviceId: '', cursor: 0, dbId: '', token: '', server: '', clockOffset: 0, lastSync: 0 };
    this.status = { state: 'unpaired', message: '' };
    this.dirty = new Set();
    this.metaDirty = false;
    this.lastTs = 0;
    this.syncing = null;
    this.again = false;
    this.failures = 0;
    this.nextAllowed = 0;
    this.saving = Promise.resolve();
    this.saveError = null;   // why the last write to IndexedDB failed (the app shows it until one succeeds)
  }

  // ---------------------------------------------------------------- persistence
  async open() {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB here');
      this.db = await openDb();
      for (const [k, v] of await readAll(this.db, 'rows')) this.rows.set(k, v);
      for (const [k, v] of await readAll(this.db, 'outbox')) this.outbox.set(k, v);
      for (const [k, v] of await readAll(this.db, 'meta')) this.meta[k] = v;
    } catch (e) {
      if (typeof indexedDB !== 'undefined') console.warn('IndexedDB unavailable, running in memory only', e);
      this.db = null;
    }
    if (!this.meta.deviceId) { this.meta.deviceId = `web-${newId(10)}`; this.metaDirty = true; }
    this.status.state = this.meta.token ? 'idle' : 'unpaired';
    await this.save();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 30);
  }

  /**
   * Writes what changed to IndexedDB. One write at a time, each holding every changed row and the sync cursor
   * together, so the cursor is never stored ahead of the rows it covers. A write that fails (storage full, or
   * iOS closed the database while the app was in the background) puts everything back to be written again,
   * reopens the database if needed, and raises 'savefailed' until a write succeeds ('saved').
   */
  save() {
    this.saving = this.saving.then(() => this.saveNow());
    return this.saving;
  }

  async saveNow() {
    if (!this.db || (!this.dirty.size && !this.metaDirty)) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    const meta = this.metaDirty ? { ...this.meta } : null;
    this.metaDirty = false;
    let error = null;
    try {
      const tx = this.db.transaction(['rows', 'outbox', 'meta'], 'readwrite');
      for (const k of keys) {
        const row = this.rows.get(k);
        if (row) tx.objectStore('rows').put(row, k); else tx.objectStore('rows').delete(k);
        const ob = this.outbox.get(k);
        if (ob) tx.objectStore('outbox').put(ob, k); else tx.objectStore('outbox').delete(k);
      }
      if (meta) for (const [k, v] of Object.entries(meta)) tx.objectStore('meta').put(v, k);
      await new Promise((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => { error = tx.error ?? new Error('write failed'); resolve(); };
        tx.onabort = () => { error ??= tx.error ?? new Error('write aborted'); resolve(); };
      });
    } catch (e) { error = e; }
    if (!error) {
      if (this.saveError) { this.saveError = null; this.dispatchEvent(new Event('saved')); }
      return;
    }
    for (const k of keys) this.dirty.add(k);
    if (meta) this.metaDirty = true;
    const first = !this.saveError;
    this.saveError = error.name === 'QuotaExceededError' ? 'This phone is out of storage for the app.' : (error.message || String(error));
    if (first) this.dispatchEvent(new Event('savefailed'));
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      if (error.name === 'InvalidStateError') { try { this.db = await openDb(); } catch { /* try again next time */ } }
      this.save();
    }, 3000);
  }

  setMeta(values) {
    Object.assign(this.meta, values);
    this.metaDirty = true;
    this.scheduleSave();
  }

  emit() {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => { this.emitQueued = false; this.dispatchEvent(new Event('change')); });
  }

  setStatus(state, message = '') {
    this.status = { state, message };
    this.dispatchEvent(new Event('status'));
  }

  /** Server-corrected, strictly increasing millisecond clock for field timestamps. */
  now() {
    const t = Math.max(Math.round(Date.now() + (this.meta.clockOffset || 0)), this.lastTs + 1);
    this.lastTs = t;
    return t;
  }

  // ---------------------------------------------------------------- reads
  get(kind, id) { return this.rows.get(`${kind}:${id}`); }
  list(kind) {
    const out = [];
    for (const r of this.rows.values()) if (r.kind === kind) out.push(r);
    return out;
  }
  tasks() { return this.list('task'); }
  projects() {
    return this.list('project').filter((p) => !p.fields.deleted.v && p.fields.name.v)
      .sort((a, b) => cmpPos(a.fields.pos.v, a.id, b.fields.pos.v, b.id));
  }
  setting(key, fallback = '') { return this.get('setting', key)?.fields.value.v || fallback; }
  tree(projectId) { return buildTree(this.tasks(), projectId); }
  conflicts() {
    return this.list('conflict').filter((c) => !c.fields.resolved.v && this.get('task', c.task))
      .sort((a, b) => b.at - a.at);
  }
  trash() {
    const projects = this.list('project').filter((p) => p.fields.deleted.v && p.fields.name.v);
    const deadProjects = new Set(projects.map((p) => p.id));
    const tasks = this.tasks().filter((t) => {
      if (!t.fields.deleted.v || deadProjects.has(t.fields.place.v?.project)) return false;
      const parent = t.fields.place.v.parent && this.get('task', t.fields.place.v.parent);
      return !(parent && parent.fields.deleted.v);   // show only the top of a deleted subtree
    });
    const when = (r) => r.fields.deleted.ts;
    return [...projects, ...tasks].sort((a, b) => when(b) - when(a)).slice(0, 200);
  }
  pendingCount() { return this.outbox.size; }

  // ---------------------------------------------------------------- local writes
  /**
   * Applies field values locally and queues them for sync. `base` = the ts of the version the user was
   * looking at when they started editing (an editor that stayed open while a newer version arrived must
   * not silently overwrite it: the server then records a conflict instead).
   */
  change(kind, id, values, { create = false, base } = {}) {
    const key = `${kind}:${id}`;
    let row = this.rows.get(key);
    if (!row) {
      if (!create) return;
      row = emptyRow(kind, id);
    }
    const ts = this.now();
    const ob = this.outbox.get(key) ?? { kind, id, fields: {} };
    for (const [f, v] of Object.entries(values)) {
      if (!create && same(row.fields[f]?.v, v) && !ob.fields[f]) continue;
      if (!ob.fields[f]) ob.fields[f] = { base: create ? -1 : base ?? row.fields[f]?.ts ?? -1 };
      ob.fields[f].v = v;
      ob.fields[f].ts = ts;
      row.fields[f] = { v, ts };
    }
    if (!Object.keys(ob.fields).length) return;
    this.rows.set(key, row);
    this.outbox.set(key, ob);
    this.dirty.add(key);
    this.scheduleSave();
    this.emit();
    this.scheduleSync(EDIT_DELAY_MS);
  }

  // projects
  addProject(name) {
    const clean = cleanProjectName(name);
    if (!clean) return null;
    const list = this.projects();
    const last = list.length ? list[list.length - 1].fields.pos.v : null;
    const id = newId();
    this.change('project', id, { name: clean, pos: keyBetween(last, null), deleted: false }, { create: true });
    return id;
  }
  renameProject(id, name) {
    const clean = cleanProjectName(name);
    if (clean) this.change('project', id, { name: clean });
  }
  deleteProject(id) { this.change('project', id, { deleted: true }); }
  restoreProject(id) { this.change('project', id, { deleted: false }); }
  moveProject(id, dir) {
    const list = this.projects();
    const i = list.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const others = list.filter((p) => p.id !== id);
    const at = dir < 0 ? j : j;   // index among the others
    const nodes = others.map((p) => ({ id: p.id, task: { fields: { place: { v: { pos: p.fields.pos.v } } } } }));
    const { pos, rekeys } = positionAt(nodes, at);
    for (const [rid, k] of rekeys) this.change('project', rid, { pos: k });
    this.change('project', id, { pos });
  }

  // tasks
  addTask(projectId, { parentId = null, index = null, text = '', status = ' ' } = {}) {
    const tree = this.tree(projectId);
    const siblings = parentId ? tree.byId.get(parentId)?.kids ?? [] : tree.roots;
    const { pos, rekeys } = positionAt(siblings, index ?? siblings.length);
    for (const [rid, k] of rekeys) this.change('task', rid, { place: { ...this.get('task', rid).fields.place.v, pos: k } });
    const id = newId();
    this.change('task', id, {
      place: { project: projectId, parent: parentId, pos }, text, status, due: null, notes: '', deleted: false,
    }, { create: true });
    return id;
  }

  setTask(id, values, opts = {}) { this.change('task', id, values, opts); }

  /** Moves a task with its subtree: new parent + index among that parent's children, maybe another project. */
  moveTask(id, { projectId, parentId = null, index = null }) {
    const t = this.get('task', id);
    if (!t) return;
    const from = t.fields.place.v.project;
    const tree = this.tree(projectId);
    if (parentId && from === projectId) {
      const node = tree.byId.get(id);
      const target = tree.byId.get(parentId);
      for (let p = target; p; p = p.parent) if (p === node) return;   // not into its own subtree
    }
    // its subtasks, found while it is still in its old list
    const old = from !== projectId ? this.tree(from).byId.get(id) : null;
    const kids = old ? subtreeIds(old).slice(1) : [];
    const siblings = parentId ? tree.byId.get(parentId)?.kids ?? [] : tree.roots;
    const { pos, rekeys } = positionAt(siblings, index ?? siblings.length, id);
    for (const [rid, k] of rekeys) this.change('task', rid, { place: { ...this.get('task', rid).fields.place.v, pos: k } });
    this.change('task', id, { place: { project: projectId, parent: parentId, pos } });
    for (const d of kids) this.change('task', d, { place: { ...this.get('task', d).fields.place.v, project: projectId } });
  }

  deleteTask(id) {
    const t = this.get('task', id);
    if (!t) return;
    const node = this.tree(t.fields.place.v.project).byId.get(id);
    for (const d of node ? subtreeIds(node) : [id]) this.change('task', d, { deleted: true });
  }

  restoreTask(id) {
    const t = this.get('task', id);
    if (!t) return;
    const at = t.fields.deleted.ts;
    const kids = new Map();
    for (const x of this.tasks()) {
      const p = x.fields.place.v?.parent;
      if (p) (kids.get(p) ?? kids.set(p, []).get(p)).push(x);
    }
    const walk = (x) => {
      this.change('task', x.id, { deleted: false });
      for (const k of kids.get(x.id) ?? []) if (k.fields.deleted.v && Math.abs(k.fields.deleted.ts - at) < 5_000) walk(k);
    };
    walk(t);
    const proj = this.get('project', t.fields.place.v.project);
    if (proj?.fields.deleted.v) this.restoreProject(proj.id);
  }

  setSetting(key, value) { this.change('setting', key, { value }, { create: true }); }

  resolveConflict(id, keepOther) {
    const c = this.get('conflict', id);
    if (!c) return;
    if (keepOther) {
      if (c.field === 'deleted') { if (c.value === true) this.deleteTask(c.task); else this.restoreTask(c.task); }
      else this.setTask(c.task, { [c.field]: c.value });
    }
    this.change('conflict', id, { resolved: true });
  }

  /** URL of an API route ('sync', 'config', ...) on the server this device syncs with. */
  apiUrl(path) {
    const origin = this.base || this.meta.server;
    return origin ? `${origin.replace(/\/+$/, '')}/api/${path}` : `api/${path}`;
  }

  // ---------------------------------------------------------------- pairing
  /** server: origin of the Worker when it is not this page's own origin ('' = same origin). */
  pair(token, server = '') {
    this.setMeta({ token, server });
    this.setStatus('idle');
    this.sync({ force: true });
  }
  unpair() {
    this.setMeta({ token: '' });
    this.setStatus('unpaired');
  }

  // ---------------------------------------------------------------- sync
  scheduleSync(ms) {
    if (!this.autoSync) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync({ force: true }), ms);
  }

  startAuto() {
    const visible = () => document.visibilityState === 'visible';
    document.addEventListener('visibilitychange', () => { if (visible()) this.sync({ force: true }); });
    window.addEventListener('online', () => this.sync({ force: true }));
    window.addEventListener('pageshow', () => this.sync({ force: true }));
    setInterval(() => { if (visible()) this.sync(); }, POLL_MS);
    this.sync({ force: true });
  }

  takeBatch() {
    const out = [];
    let bytes = 0;
    for (const e of this.outbox.values()) {
      const copy = structuredClone(e);
      const size = JSON.stringify(copy).length;
      if (out.length && (out.length >= MAX_BATCH || bytes + size > MAX_BATCH_BYTES)) break;
      out.push(copy);
      bytes += size;
    }
    return out;
  }

  /** One sync run (several requests if needed). Concurrent callers share the running one. */
  sync({ force = false } = {}) {
    if (!this.meta.token) { this.setStatus('unpaired'); return Promise.resolve(); }
    if (this.syncing) { this.again = true; return this.syncing; }
    if (!force && Date.now() < this.nextAllowed) return Promise.resolve();
    this.syncing = this.runSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async runSync() {
    this.setStatus('syncing');
    try {
      // first contact with a server: pull everything before pushing, so lists made before pairing can join
      // the server's lists of the same name instead of showing up twice (kept across pages and restarts)
      if (!this.meta.dbId && !this.meta.cursor && this.meta.adoptPending === undefined) this.setMeta({ adoptPending: true });
      for (let round = 0; round < 50; round++) {
        this.again = false;
        const firstContact = this.meta.adoptPending === true;
        const batch = firstContact ? [] : this.takeBatch();
        const sentAt = Date.now();
        const res = await fetch(this.apiUrl('sync'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.meta.token}` },
          body: JSON.stringify({ deviceId: this.meta.deviceId, cursor: this.meta.cursor, changes: batch }),
          cache: 'no-store',
        });
        if (res.status === 401) throw Object.assign(new Error('This device is no longer paired (token rejected). Pair it again from the desktop app.'), { auth: true });
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        const data = await res.json();
        const recvAt = Date.now();
        this.meta.clockOffset = Math.round(data.serverTime - (sentAt + recvAt) / 2);
        if (this.meta.dbId && data.dbId && data.dbId !== this.meta.dbId) {
          this.resetForNewServer(data.dbId);
          continue;
        }
        if (data.restored || (this.meta.cursor && data.cursor < this.meta.cursor)) {
          this.resetForRestore();
          continue;
        }
        this.ack(batch, data.changes);
        this.applyRemote(data.changes);
        this.handleRejected(data.rejected || []);
        if (firstContact && !data.more) { this.adoptServerProjects(); this.meta.adoptPending = false; }
        this.setMeta({ cursor: data.cursor, dbId: data.dbId, lastSync: Date.now(), clockOffset: this.meta.clockOffset, adoptPending: this.meta.adoptPending });
        if (firstContact) continue;
        await this.save();
        this.emit();
        const unsent = [...this.outbox.values()].some((e) => !batch.some((b) => b.kind === e.kind && b.id === e.id));
        if (!data.more && !unsent && !this.again) break;
      }
      this.failures = 0;
      this.nextAllowed = 0;
      this.setStatus('idle');
    } catch (e) {
      this.failures++;
      this.nextAllowed = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5));
      const offline = !e.auth && (e instanceof TypeError || navigator.onLine === false);
      this.setStatus(offline ? 'offline' : 'error', offline ? 'No connection — changes are saved on this phone.' : e.message);
    }
  }

  /** A project created here and never acknowledged by a server. */
  isLocalOnly(row) {
    return this.outbox.get(`${row.kind}:${row.id}`)?.fields.name?.base === -1;
  }

  /** Moves tasks of never-synced local projects into the server's project with the same name. */
  adoptServerProjects() {
    const server = new Map();
    for (const p of this.list('project')) {
      if (!p.fields.deleted.v && !this.isLocalOnly(p)) server.set(p.fields.name.v.toLowerCase(), p.id);
    }
    for (const p of this.list('project')) {
      if (!this.isLocalOnly(p)) continue;
      const target = server.get(p.fields.name.v.toLowerCase());
      if (!target) continue;
      for (const t of this.tasks()) {
        if (t.fields.place.v?.project === p.id) this.change('task', t.id, { place: { ...t.fields.place.v, project: target } });
      }
      const key = `project:${p.id}`;
      this.rows.delete(key);
      this.outbox.delete(key);
      this.dirty.add(key);
    }
  }

  /** Drops outbox fields the server has now seen (unless they were edited again meanwhile). */
  ack(batch, changes) {
    const server = new Map(changes.map((r) => [`${r.kind}:${r.id}`, r]));
    for (const sent of batch) {
      const key = `${sent.kind}:${sent.id}`;
      const cur = this.outbox.get(key);
      if (!cur) continue;
      for (const [f, s] of Object.entries(sent.fields)) {
        const c = cur.fields[f];
        if (!c) continue;
        if (c.ts === s.ts) delete cur.fields[f];
        else {
          // edited again while in flight: it now follows whatever the server holds, if that is our value
          const sv = server.get(key)?.fields[f];
          if (sv && same(sv.v, s.v)) c.base = sv.ts;
        }
      }
      if (!Object.keys(cur.fields).length) this.outbox.delete(key);
      this.dirty.add(key);
    }
  }

  applyRemote(changes) {
    for (const r of changes) {
      const key = `${r.kind}:${r.id}`;
      const row = structuredClone(r);
      const pending = this.outbox.get(key);
      if (pending) for (const [f, p] of Object.entries(pending.fields)) row.fields[f] = { v: p.v, ts: p.ts };
      this.rows.set(key, row);
      this.dirty.add(key);
    }
  }

  handleRejected(rejected) {
    const shown = [];
    for (const r of rejected) {
      if (r.reason === 'unknown task' || r.reason === 'unknown project') this.requeueFull(`${r.kind}:${r.id}`);
      else { console.warn('sync rejected', r); shown.push(r); }
    }
    // the server sent its own version of those rows back; tell the user what could not be saved
    if (shown.length) this.dispatchEvent(Object.assign(new Event('rejected'), { detail: shown }));
  }

  /** Queues a whole row as a fresh create (server lost it, or we moved to a new server). */
  requeueFull(key) {
    const row = this.rows.get(key);
    if (!row || row.kind === 'conflict') return;
    if (row.kind === 'task') {
      const proj = this.rows.get(`project:${row.fields.place.v?.project}`);
      if (proj && !this.outbox.has(`project:${proj.id}`)) this.requeueFull(`project:${proj.id}`);
    }
    const fields = {};
    for (const [f, x] of Object.entries(row.fields)) fields[f] = { v: x.v, ts: x.ts || this.now(), base: -1 };
    // projects before tasks: re-insert at the front for projects
    if (row.kind === 'project') {
      const rest = [...this.outbox.entries()].filter(([k]) => k !== key);
      this.outbox = new Map([[key, { kind: row.kind, id: row.id, fields }], ...rest]);
    } else this.outbox.set(key, { kind: row.kind, id: row.id, fields });
    this.dirty.add(key);
  }

  // ---------------------------------------------------------------- export / import (markdown)
  /** Every project as a list file in the desktop format: { files: [{ name, text }], order: [names] }. */
  exportLists() {
    const files = [];
    const used = new Set();
    for (const p of this.projects()) {
      let name = toFileName(p.fields.name.v);
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${toFileName(p.fields.name.v)} (${i})`;
      used.add(name.toLowerCase());
      const toNode = (n) => ({
        text: n.task.fields.text.v, mark: n.task.fields.status.v, due: n.task.fields.due.v, notes: n.task.fields.notes.v, id: n.id,
        kids: n.kids.map(toNode),
      });
      files.push({ name: `${name}.md`, text: treeToMarkdown(this.tree(p.id).roots.map(toNode)) });
    }
    return { files, order: files.map((f) => f.name.slice(0, -3)) };
  }

  /**
   * Adds the tasks of list files ([{ name: 'Work.md', text }]) to the project with the same name (made if
   * missing). Tasks already here (same ^id) are left as they are; nothing is ever deleted. New tasks keep
   * their ids, so importing the same file again adds nothing.
   */
  importLists(files) {
    const res = { added: 0, skipped: 0, projects: 0 };
    const madeNow = new Set();   // ids this import created: a line repeating one is a copy, not "already here"
    for (const f of files) {
      const name = cleanProjectName(f.name.replace(/\.(md|markdown|txt)$/i, ''));
      if (!name) continue;
      const existing = this.projects().find((p) => p.fields.name.v.toLowerCase() === name.toLowerCase());
      let pid = existing?.id;
      if (!pid) { pid = this.addProject(name); res.projects++; }
      const lastKey = (projectId, parentId) => {
        const t = this.tree(projectId);
        const sibs = parentId ? t.byId.get(parentId)?.kids ?? [] : t.roots;
        return sibs.length ? sibs[sibs.length - 1].task.fields.place.v.pos : null;
      };
      const walk = (nodes, projectId, parentId) => {
        let prev = lastKey(projectId, parentId);
        for (const n of nodes) {
          const have = validId(n.id) && !madeNow.has(n.id) ? this.get('task', n.id) : null;
          if (have) {
            res.skipped++;
            // its new subtasks still go under it, wherever it is now
            const pl = have.fields.place.v;
            if (pl && !have.fields.deleted.v) walk(n.kids, pl.project, n.id);
            continue;
          }
          const id = validId(n.id) && !madeNow.has(n.id) ? n.id : newId();
          madeNow.add(id);
          const pos = keyBetween(prev, null);
          prev = pos;
          const due = n.due && validDate(n.due.date) ? { date: n.due.date, time: n.due.time || '' } : null;
          this.change('task', id, {
            place: { project: projectId, parent: parentId, pos }, text: String(n.text).slice(0, 10_000), status: MARKS.includes(n.mark) ? n.mark : ' ',
            due, notes: String(n.notes ?? '').slice(0, 50_000), deleted: false,
          }, { create: true });
          res.added++;
          walk(n.kids, projectId, id);
        }
      };
      walk(listTree(f.text), pid, null);
    }
    return res;
  }

  resetForNewServer(dbId) {
    // the server database was recreated (or we were paired with another one): push everything we have
    for (const [key, row] of [...this.rows]) {
      if (row.kind === 'conflict') { this.rows.delete(key); this.dirty.add(key); continue; }
      this.outbox.delete(key);
    }
    for (const kind of ['project', 'setting', 'task']) {
      for (const [key, row] of this.rows) if (row.kind === kind) this.requeueFull(key);
    }
    this.setMeta({ cursor: 0, dbId });
  }

  /**
   * The server went back in time (restored from a backup): take everything again from the start, and send
   * back what this device has that it lost, except deletes. Sending the deletes too would undo what a restore
   * after an accidental delete is meant to bring back; a task deleted here comes back with the restore.
   */
  resetForRestore() {
    for (const [key, row] of [...this.rows]) {
      if (row.kind === 'conflict') { this.rows.delete(key); this.dirty.add(key); continue; }
      this.outbox.delete(key);
      this.dirty.add(key);
    }
    for (const kind of ['project', 'setting', 'task']) {
      for (const [key, row] of this.rows) if (row.kind === kind && !row.fields.deleted?.v) this.requeueFull(key);
    }
    this.setMeta({ cursor: 0 });
  }
}
