// Local-first data store for the PWA: everything lives in memory + IndexedDB and every edit is applied
// locally at once. Changes queue in an outbox (coalesced per field) and a background sync sends them to
// the Worker, then folds the server's canonical rows back in (keeping edits made while a request was in
// flight). Protocol: docs/sync.md.
//
// Shared lists (docs/sync.md, "Shared lists"): a list someone shares with this device lives on their sync
// server. meta.shares holds one binding per list, { id, via, remote, server, token, access, projectId, name, pos,
// cursor, dbId, clockOffset, lastSync, joinedAt }. The app talks to its own origin only (its security policy),
// so a paired app reaches the list through its own Worker (via 'relay', remote: the list's id there, which keeps
// the key; worker/src/remotes.js). Without a sync of its own the app reaches only lists of the address it runs
// at (via 'direct', with the key, kept on this device): someone using the list in the browser from its owner's
// address. Its rows sit in the same maps as everything else: which server a row belongs to follows from its
// project. Each sync runs one session per list, and a shared list's server can only ever change rows of its
// own list here.

import { buildTree, positionAt, subtreeIds, newId, cleanProjectName } from './model.js';
import { keyBetween, cmpPos } from './keys.js';
import { listTree, treeToMarkdown, toFileName, MARKS, isValidDate as validDate } from './markdown.js';
import { parseInviteLink } from './pairing.js';

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
    // shares: lists shared with this device; shared: ids of this device's own lists shared with others (from the
    // own server); notices: changes a shared list's server refused (shown with the conflicts)
    // leaving: ids (on this device's own Worker) of lists left here, until it confirms
    this.meta = { deviceId: '', cursor: 0, dbId: '', token: '', server: '', clockOffset: 0, lastSync: 0, shares: [], shared: [], notices: [], leaving: [] };
    this.status = { state: 'unpaired', message: '' };
    this.shareStatus = new Map();   // share id -> { state, message } of its last sync
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

  /** Server-corrected (offset: of the server the change goes to), strictly increasing millisecond clock. */
  now(offset = this.meta.clockOffset) {
    const t = Math.max(Math.round(Date.now() + (offset || 0)), this.lastTs + 1);
    this.lastTs = t;
    return t;
  }

  // ---------------------------------------------------------------- shared lists: which server a row is on
  shares() { return this.meta.shares ?? []; }
  /** The binding of a list shared with this device, or null (the list is this device's own). */
  shareOf(projectId) { return (projectId && this.shares().find((s) => s.projectId === projectId)) || null; }
  shareOfRow(row) {
    if (!row) return null;
    if (row.kind === 'project') return this.shareOf(row.id);
    if (row.kind === 'task') return this.shareOf(row.fields.place.v?.project);
    if (row.kind === 'conflict') return this.shareOfRow(this.get('task', row.task));
    return null;
  }
  shareOfKey(key) { return this.shareOfRow(this.rows.get(key)); }
  /** A list someone shares with this device with view access only. */
  isReadOnly(projectId) { const s = this.shareOf(projectId); return !!s && s.access !== 'edit'; }
  /** One of this device's own lists that it shares with others (the badge on its tab). */
  sharedByMe(projectId) { return (this.meta.shared ?? []).includes(projectId); }
  notices() { return [...(this.meta.notices ?? [])].sort((a, b) => b.at - a.at); }

  /**
   * The share a change goes to (null: this device's own server), or false when it may not be made: a shared list
   * itself (its name, order or deletion belong to its owner), anything in a view-only list, and a task moving
   * between servers (moveTask copies it instead).
   */
  targetOf(kind, row, values) {
    if (kind === 'setting') return null;
    if (kind === 'project') return this.shareOf(row.id) ? false : null;
    if (kind === 'conflict') { const s = this.shareOfRow(row); return s && s.access !== 'edit' ? false : s; }
    const cur = row.fields.place.v?.project;
    const next = values.place ? values.place.project : cur;
    const a = cur ? this.shareOf(cur) : null;
    const b = this.shareOf(next);
    if (cur && (a?.id ?? '') !== (b?.id ?? '')) return false;
    if (b && b.access !== 'edit') return false;
    return b;
  }

  // ---------------------------------------------------------------- reads
  get(kind, id) { return this.rows.get(`${kind}:${id}`); }
  list(kind) {
    const out = [];
    for (const r of this.rows.values()) if (r.kind === kind) out.push(r);
    return out;
  }
  tasks() { return this.list('task'); }
  /** A tab's place: its own order key, or for a list shared with this device the one kept here (not synced). */
  projectPos(p) { return this.shareOf(p.id)?.pos ?? p.fields.pos.v; }
  projects() {
    return this.list('project').filter((p) => !p.fields.deleted.v && p.fields.name.v)
      .sort((a, b) => cmpPos(this.projectPos(a), a.id, this.projectPos(b), b.id));
  }
  setting(key, fallback = '') { return this.get('setting', key)?.fields.value.v || fallback; }
  tree(projectId) { return buildTree(this.tasks(), projectId); }
  conflicts() {
    // (a view-only list's conflicts are its owner's to resolve)
    return this.list('conflict').filter((c) => !c.fields.resolved.v && this.get('task', c.task) && this.shareOfRow(c)?.access !== 'view')
      .sort((a, b) => b.at - a.at);
  }
  trash() {
    // a shared list itself is its owner's to restore, a view-only list's tasks too
    const projects = this.list('project').filter((p) => p.fields.deleted.v && p.fields.name.v && !this.shareOf(p.id));
    const deadProjects = new Set(projects.map((p) => p.id));
    const tasks = this.tasks().filter((t) => {
      if (!t.fields.deleted.v || deadProjects.has(t.fields.place.v?.project)) return false;
      const pid = t.fields.place.v?.project;
      if (this.shareOf(pid) && (this.isReadOnly(pid) || this.get('project', pid)?.fields.deleted.v)) return false;
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
      if (!create) return false;
      row = emptyRow(kind, id);
    }
    const target = this.targetOf(kind, row, values);
    if (target === false) { this.dispatchEvent(new Event('readonly')); return false; }
    const ts = this.now(target ? target.clockOffset : this.meta.clockOffset);
    const ob = this.outbox.get(key) ?? { kind, id, fields: {} };
    for (const [f, v] of Object.entries(values)) {
      if (!create && same(row.fields[f]?.v, v) && !ob.fields[f]) continue;
      if (!ob.fields[f]) ob.fields[f] = { base: create ? -1 : base ?? row.fields[f]?.ts ?? -1 };
      ob.fields[f].v = v;
      ob.fields[f].ts = ts;
      row.fields[f] = { v, ts };
    }
    if (!Object.keys(ob.fields).length) return true;
    this.rows.set(key, row);
    this.outbox.set(key, ob);
    this.dirty.add(key);
    this.scheduleSave();
    this.emit();
    this.scheduleSync(EDIT_DELAY_MS);
    return true;
  }

  // projects
  addProject(name) {
    const clean = cleanProjectName(name);
    if (!clean) return null;
    const list = this.projects();
    const last = list.length ? this.projectPos(list[list.length - 1]) : null;
    const id = newId();
    this.change('project', id, { name: clean, pos: keyBetween(last, null), deleted: false }, { create: true });
    return id;
  }
  /** A tab's order key; a shared list's is kept on this device only. */
  setProjectPos(id, pos) {
    const s = this.shareOf(id);
    if (!s) { this.change('project', id, { pos }); return; }
    s.pos = pos;
    this.setMeta({ shares: this.shares() });
    this.emit();
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
    const nodes = others.map((p) => ({ id: p.id, task: { fields: { place: { v: { pos: this.projectPos(p) } } } } }));
    const { pos, rekeys } = positionAt(nodes, at);
    for (const [rid, k] of rekeys) this.setProjectPos(rid, k);
    this.setProjectPos(id, pos);
  }

  // tasks
  addTask(projectId, { parentId = null, index = null, text = '', status = ' ' } = {}) {
    const tree = this.tree(projectId);
    const siblings = parentId ? tree.byId.get(parentId)?.kids ?? [] : tree.roots;
    const { pos, rekeys } = positionAt(siblings, index ?? siblings.length);
    for (const [rid, k] of rekeys) this.change('task', rid, { place: { ...this.get('task', rid).fields.place.v, pos: k } });
    const id = newId();
    const ok = this.change('task', id, {
      place: { project: projectId, parent: parentId, pos }, text, status, due: null, notes: '', deleted: false,
    }, { create: true });
    return ok ? id : null;   // (null: a view-only list)
  }

  setTask(id, values, opts = {}) { return this.change('task', id, values, opts); }   // false: not allowed (a view-only list)

  /** Moves a task with its subtree: new parent + index among that parent's children, maybe another project. */
  moveTask(id, { projectId, parentId = null, index = null }) {
    const t = this.get('task', id);
    if (!t) return;
    const from = t.fields.place.v.project;
    if ((this.shareOf(from)?.id ?? '') !== (this.shareOf(projectId)?.id ?? '')) return this.moveAcross(id, { projectId, parentId, index });
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

  /**
   * Moving a task between lists that live on different servers (this device's own and a shared one): a copy with
   * new ids goes to the other list, and the task (with its subtasks) is deleted here, restorable as usual. Neither
   * server could do it as a move: the shared list's server refuses tasks moving in or out. Returns the new id.
   */
  moveAcross(id, { projectId, parentId = null, index = null }) {
    const t = this.get('task', id);
    const from = t.fields.place.v.project;
    if (this.isReadOnly(from) || this.isReadOnly(projectId)) { this.dispatchEvent(new Event('readonly')); return null; }
    const node = this.tree(from).byId.get(id);
    if (!node) return null;
    const tree = this.tree(projectId);
    const siblings = parentId ? tree.byId.get(parentId)?.kids ?? [] : tree.roots;
    const { pos, rekeys } = positionAt(siblings, index ?? siblings.length);
    for (const [rid, k] of rekeys) this.change('task', rid, { place: { ...this.get('task', rid).fields.place.v, pos: k } });
    const copy = (n, parent, p) => {
      const nid = newId();
      const f = n.task.fields;
      this.change('task', nid, { place: { project: projectId, parent, pos: p }, text: f.text.v, status: f.status.v, due: f.due.v, notes: f.notes.v, deleted: false }, { create: true });
      for (const k of n.kids) copy(k, nid, k.task.fields.place.v.pos);
      return nid;
    };
    const nid = copy(node, parentId, pos);
    this.deleteTask(id);
    return nid;
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

  /** The outbox entries that go to one server (share: a shared list's binding; null: this device's own). */
  pendingFor(share) {
    const id = share?.id ?? '';
    return [...this.outbox.values()].filter((e) => (this.shareOfKey(`${e.kind}:${e.id}`)?.id ?? '') === id);
  }

  takeBatch(share = null) {
    const out = [];
    let bytes = 0;
    for (const e of this.pendingFor(share)) {
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
    if (!this.meta.token && !this.shares().some((s) => s.via === 'direct')) { this.setStatus('unpaired'); this.pauseRelayed(); return Promise.resolve(); }
    if (this.syncing) { this.again = true; return this.syncing; }
    if (!force && Date.now() < this.nextAllowed) return Promise.resolve();
    this.syncing = this.runSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  /** Lists reached through this device's own Worker wait while it is not paired (kept, with their edits). */
  pauseRelayed() {
    for (const s of this.shares()) if (s.via !== 'direct') this.shareStatus.set(s.id, { state: 'paused', message: 'Waits until this app is paired again' });
  }

  /** This device's own server first, then each list shared with it, each from its own cursor. */
  async runSync() {
    if (this.meta.token) this.setStatus('syncing');
    let failed = null;
    if (this.meta.token) {
      try { await this.syncSession(null); } catch (e) { failed = e; }
    }
    if (!this.meta.token) this.pauseRelayed();
    for (const share of [...this.shares()]) {
      if (share.via !== 'direct' && !this.meta.token) continue;
      if (share.via !== 'direct' && failed?.auth) { this.shareStatus.set(share.id, { state: 'error', message: failed.message }); continue; }
      this.shareStatus.set(share.id, { state: 'syncing', message: '' });
      try {
        // paired now, with a list this app reached on its own before: it goes to this device's own Worker
        if (share.via === 'direct' && this.meta.token && !failed) await this.adoptDirect(share);
        if (!this.shares().includes(share)) continue;
        await this.syncSession(share);
        this.shareStatus.set(share.id, { state: 'idle', message: '' });
      } catch (e) {
        if (e.ended) { this.shareEnded(share, e); continue; }
        const offline = !e.auth && (e instanceof TypeError || globalThis.navigator?.onLine === false);
        this.shareStatus.set(share.id, { state: offline ? 'offline' : 'error', message: offline ? 'No connection' : e.message });
        failed ??= e.auth ? e : Object.assign(e, { share: true });
      }
    }
    if (!failed) { this.failures = 0; this.nextAllowed = 0; }
    else {
      this.failures++;
      this.nextAllowed = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5));
    }
    if (!this.meta.token) { this.setStatus('unpaired'); this.emit(); return; }
    if (!failed || failed.share) { this.setStatus('idle'); return; }
    const offline = !failed.auth && (failed instanceof TypeError || globalThis.navigator?.onLine === false);
    this.setStatus(offline ? 'offline' : 'error', offline ? 'No connection — changes are saved on this phone.' : failed.message);
  }

  /**
   * A shared list's call ('sync', 'leave'): through this device's own Worker (with its own key), or for a list
   * of the address the app runs at, there (with the list's key). null: this device's own sync.
   */
  shareRequest(share, what = 'sync') {
    if (!share) return { url: this.apiUrl('sync'), token: this.meta.token };
    if (share.via === 'direct') return { url: `${share.server}/api/${what === 'sync' ? 'sync' : `shares/${what}`}`, token: share.token };
    return { url: this.apiUrl(`remotes/${share.remote}/${what}`), token: this.meta.token };
  }

  /** The origin this app runs at (tests: base): the one server it reaches without a sync of its own. */
  hereOrigin() { return (this.base || globalThis.location?.origin || '').replace(/\/+$/, ''); }
  /** The origin of this device's own Worker. */
  ownOrigin() { return (this.base || this.meta.server || globalThis.location?.origin || '').replace(/\/+$/, ''); }

  /**
   * How a shared list's server said no (401, 404): { ended: 'revoked' | 'transferred' | 'left' | 'gone', convert }
   * when the list ended here, or { auth } when this device's own key was refused.
   */
  async shareRefusal(share, res) {
    const data = await res.json().catch(() => ({}));
    if (share.via === 'direct') {
      if (data.error === 'transferred') return { ended: 'transferred' };
      return { ended: 'revoked', convert: true };
    }
    if (res.status === 404) return data.error === 'no such shared list' ? { ended: 'gone', convert: true } : {};   // not on this device's own Worker (any more)
    if (['revoked', 'transferred', 'left'].includes(data.error)) return { ended: data.error, convert: !!data.convert };
    return { auth: true };
  }

  /** Sends one server what is pending for it and takes in what changed there (share: a shared list's binding). */
  async syncSession(share) {
    const m = share ?? this.meta;   // cursor, dbId, clockOffset, lastSync of that server
    // first contact with a server: pull everything before pushing, so lists made before pairing can join
    // the server's lists of the same name instead of showing up twice (kept across pages and restarts)
    if (!share && !this.meta.dbId && !this.meta.cursor && this.meta.adoptPending === undefined) this.setMeta({ adoptPending: true });
    for (let round = 0; round < 50; round++) {
      this.again = false;
      const firstContact = !share && this.meta.adoptPending === true;
      const batch = firstContact ? [] : this.takeBatch(share);
      const sentAt = Date.now();
      const { url, token } = this.shareRequest(share);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceId: this.meta.deviceId, cursor: m.cursor ?? 0, changes: batch }),
        cache: 'no-store',
      });
      const refusal = share && (res.status === 401 || (res.status === 404 && share.via !== 'direct')) ? await this.shareRefusal(share, res) : null;
      if (refusal?.ended) throw Object.assign(new Error('This list is not shared with this app any more.'), refusal);
      if (res.status === 401) {
        throw Object.assign(new Error('This device is no longer paired (token rejected). Pair it again from the desktop app.'), { auth: true });
      }
      if (!res.ok) throw new Error((share && res.status === 502 && (await res.json().catch(() => ({}))).error) || `Server error ${res.status}`);   // (the relay's: why the owner's was not reached)
      const data = await res.json();
      const recvAt = Date.now();
      m.clockOffset = Math.round(data.serverTime - (sentAt + recvAt) / 2);
      if (m.dbId && data.dbId && data.dbId !== m.dbId) {
        this.resetForNewServer(data.dbId, share);
        continue;
      }
      if (data.restored || (m.cursor && data.cursor < m.cursor)) {
        this.resetForRestore(share);
        continue;
      }
      this.ack(batch, data.changes);
      this.applyRemote(data.changes, share);
      this.handleRejected(data.rejected || [], share, batch);
      if (share && ['edit', 'view'].includes(data.share?.access)) share.access = data.share.access;   // the owner changed it
      if (!share && Array.isArray(data.shared)) this.meta.shared = data.shared.filter((x) => typeof x === 'string');
      if (!share && Array.isArray(data.remotes)) this.reconcileRemotes(data.remotes);
      if (firstContact && !data.more) { this.adoptServerProjects(); this.meta.adoptPending = false; }
      Object.assign(m, { cursor: data.cursor, dbId: data.dbId, lastSync: Date.now() });
      this.setMeta(share ? { shares: this.shares() } : { cursor: data.cursor, dbId: data.dbId, lastSync: m.lastSync, clockOffset: m.clockOffset, adoptPending: this.meta.adoptPending, shared: this.meta.shared });
      if (firstContact) continue;
      await this.save();
      this.emit();
      const unsent = this.pendingFor(share).some((e) => !batch.some((b) => b.kind === e.kind && b.id === e.id));
      if (!data.more && !unsent && !this.again) break;
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
      if (!p.fields.deleted.v && !this.isLocalOnly(p) && !this.shareOf(p.id)) server.set(p.fields.name.v.toLowerCase(), p.id);
    }
    for (const p of this.list('project')) {
      if (!this.isLocalOnly(p) || this.shareOf(p.id)) continue;
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

  /**
   * Whether a row from a server may land here. A shared list's server: only its own list, its tasks (not one of
   * this device's own with the same id) and their conflicts. This device's own server: never a shared list's.
   */
  accepts(r, share) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') return false;
    const cur = this.rows.get(`${r.kind}:${r.id}`);
    const curShare = cur ? (this.shareOfRow(cur)?.id ?? '') : null;
    const sid = share?.id ?? '';
    if (r.gone) return !!share && r.kind === 'task' && curShare === sid;
    if (!r.fields || typeof r.fields !== 'object') return false;
    if (r.kind === 'project') return share ? r.id === share.projectId : !this.shareOf(r.id);
    if (r.kind === 'task') {
      const into = this.shareOf(r.fields.place?.v?.project)?.id ?? '';
      if (share ? r.fields.place?.v?.project !== share.projectId : into !== '') return false;
      return curShare === null || curShare === sid;
    }
    if (r.kind === 'conflict') {
      const t = this.get('task', r.task);
      return share ? !!t && (this.shareOfRow(t)?.id ?? '') === sid : !t || !this.shareOfRow(t);
    }
    return !share;   // settings: this device's own server only
  }

  applyRemote(changes, share = null) {
    for (const r of changes) {
      if (!this.accepts(r, share)) continue;
      const key = `${r.kind}:${r.id}`;
      if (r.gone) {
        // moved by its owner into a list this device does not share: it leaves here, without a trace
        this.rows.delete(key);
        this.outbox.delete(key);
        this.dirty.add(key);
        continue;
      }
      const row = structuredClone(r);
      const pending = this.outbox.get(key);
      if (pending) for (const [f, p] of Object.entries(pending.fields)) row.fields[f] = { v: p.v, ts: p.ts };
      this.rows.set(key, row);
      this.dirty.add(key);
    }
  }

  /** batch: what was sent; a shared list's refusals are kept as notices with the value that was not saved. */
  handleRejected(rejected, share = null, batch = []) {
    const shown = [];
    for (const r of rejected) {
      if (r.reason === 'unknown task' || r.reason === 'unknown project') { if (!share || r.kind === 'task') this.requeueFull(`${r.kind}:${r.id}`); }
      else { console.warn('sync rejected', r); shown.push(r); }
    }
    if (share && shown.length) {
      const notices = this.meta.notices ?? [];
      for (const r of shown) {
        const sent = batch.find((b) => b.kind === r.kind && b.id === r.id);
        const t = r.kind === 'task' ? this.get('task', r.id) : null;
        for (const field of r.field ? [r.field] : Object.keys(sent?.fields ?? {})) {
          if (field === 'place' || field === 'resolved') continue;
          const value = sent?.fields[field]?.v;
          notices.push({
            id: newId(10), share: share.id, projectId: share.projectId, task: r.id, field, value, reason: r.reason, at: Date.now(),
            text: (field === 'text' ? sent?.fields.text?.v : t?.fields.text.v) ?? sent?.fields.text?.v ?? '',
          });
        }
      }
      this.setMeta({ notices: notices.slice(-100) });
    }
    // the server sent its own version of those rows back; tell the user what could not be saved
    if (shown.length) this.dispatchEvent(Object.assign(new Event('rejected'), { detail: shown }));
  }

  dismissNotice(id) {
    this.setMeta({ notices: (this.meta.notices ?? []).filter((n) => n.id !== id) });
    this.emit();
  }

  /** Queues a whole row as a fresh create (server lost it, or we moved to a new server). */
  requeueFull(key) {
    const row = this.rows.get(key);
    if (!row || row.kind === 'conflict') return;
    if (row.kind === 'project' && this.shareOf(row.id)) return;   // its owner's
    if (row.kind === 'task') {
      const proj = this.rows.get(`project:${row.fields.place.v?.project}`);
      if (proj && !this.outbox.has(`project:${proj.id}`) && !this.shareOf(proj.id)) this.requeueFull(`project:${proj.id}`);
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
      // (into this device's own lists: a list shared with it is not the one in the file)
      const existing = this.projects().find((p) => p.fields.name.v.toLowerCase() === name.toLowerCase() && !this.shareOf(p.id));
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

  /** The rows that live on one server (share: a shared list's binding; null: this device's own). */
  rowsOf(share) {
    const id = share?.id ?? '';
    return [...this.rows].filter(([, row]) => (this.shareOfRow(row)?.id ?? '') === id);
  }

  resetForNewServer(dbId, share = null) {
    // the server database was recreated (or we were paired with another one): push everything we have
    const mine = this.rowsOf(share);
    for (const [key, row] of mine) {
      if (row.kind === 'conflict') { this.rows.delete(key); this.dirty.add(key); continue; }
      this.outbox.delete(key);
    }
    if (!share || share.access === 'edit') {
      for (const kind of ['project', 'setting', 'task']) {
        for (const [key, row] of mine) if (row.kind === kind && this.rows.has(key)) this.requeueFull(key);
      }
    }
    if (share) { Object.assign(share, { cursor: 0, dbId }); this.setMeta({ shares: this.shares() }); } else this.setMeta({ cursor: 0, dbId });
  }

  /**
   * The server went back in time (restored from a backup): take everything again from the start, and send
   * back what this device has that it lost, except deletes. Sending the deletes too would undo what a restore
   * after an accidental delete is meant to bring back; a task deleted here comes back with the restore.
   */
  resetForRestore(share = null) {
    const mine = this.rowsOf(share);
    for (const [key, row] of mine) {
      if (row.kind === 'conflict') { this.rows.delete(key); this.dirty.add(key); continue; }
      this.outbox.delete(key);
      this.dirty.add(key);
    }
    if (!share || share.access === 'edit') {
      for (const kind of ['project', 'setting', 'task']) {
        for (const [key, row] of mine) if (row.kind === kind && this.rows.has(key) && !row.fields.deleted?.v) this.requeueFull(key);
      }
    }
    if (share) { share.cursor = 0; this.setMeta({ shares: this.shares() }); } else this.setMeta({ cursor: 0 });
  }

  // ---------------------------------------------------------------- shared lists: join, leave, end
  /** A POST to this device's own Worker with its key -> { status, data }. */
  async ownCall(path, body = {}, fetchImpl = fetch) {
    const res = await fetchImpl(this.apiUrl(path), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.meta.token}` }, body: JSON.stringify(body), cache: 'no-store',
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  /** A call with a direct list's key to its owner's Worker (this app's own address): 'shares/transfer', 'push/…'. */
  async shareCall(share, path, body) {
    const res = await fetch(`${share.server}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${share.token}` },
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
    });
    if (res.status === 401) {
      const refusal = await this.shareRefusal(share, res);   // (a direct list's 401 always ends it)
      this.shareEnded(share, refusal);
      throw Object.assign(new Error('This list is not shared with you any more.'), refusal);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  }

  /** A new binding at the end of the tabs. */
  addBinding(fields) {
    const list = this.projects();
    const share = {
      id: newId(10), access: 'view', name: 'Shared list', pos: keyBetween(list.length ? this.projectPos(list[list.length - 1]) : null, null),
      cursor: 0, dbId: '', clockOffset: 0, lastSync: 0, joinedAt: Date.now(), ...fields,
    };
    this.setMeta({ shares: [...this.shares(), share] });
    return share;
  }

  /** A list of this device's own Worker (remoteView in worker/src/remotes.js) -> its binding here. */
  bindRemote(remote) {
    const fields = { via: 'relay', remote: remote.id, server: remote.server, access: remote.access === 'edit' ? 'edit' : 'view', name: String(remote.name || 'Shared list') };
    const known = this.shares().find((s) => s.remote === remote.id) ?? this.shareOf(remote.projectId);
    if (!known) return this.addBinding({ ...fields, projectId: remote.projectId });
    // the same list (moved here from the browser, say): its rows stay, from now on through this Worker
    Object.assign(known, fields);
    delete known.token;
    this.setMeta({ shares: this.shares() });
    return known;
  }

  /**
   * Joins a list someone shares, from their invite link (pairing.js parseInviteLink), then syncs it. Paired: this
   * device's own Worker claims the invite and keeps the key (worker/src/remotes.js). Not paired: only a list of the
   * address this app runs at (its owner's), with the key kept here. Resolves to the binding; throws with a message
   * to show (needsPairing: the invite is for another address). fetchImpl: tests.
   */
  async joinShare(link, { fetchImpl = fetch } = {}) {
    const inv = parseInviteLink(link);
    if (!inv) throw new Error('That is not an invite link (it looks like https://…/join#code=…).');
    let share;
    if (this.meta.token) {
      if (inv.server === this.ownOrigin()) throw new Error('That invite is for one of your own lists.');
      let r;
      try { r = await this.ownCall('remotes/join', { link }, fetchImpl); } catch { throw new Error('No connection. Try again when you are online.'); }
      if (r.status === 401) throw new Error('This device is no longer paired (token rejected). Pair it again from the desktop app.');
      if (r.status !== 200 || !validId(r.data.remote?.projectId)) throw new Error(r.data.error || `The invite did not work (${r.status}).`);
      if (this.get('project', r.data.remote.projectId) && !this.shareOf(r.data.remote.projectId)) throw new Error(`“${r.data.remote.name}” is one of your own lists.`);
      this.setMeta({ leaving: (this.meta.leaving ?? []).filter((id) => id !== r.data.remote.id) });
      share = this.bindRemote(r.data.remote);
    } else {
      if (inv.server !== this.hereOrigin()) {
        throw Object.assign(new Error('This app has no sync of its own, so it opens shared lists from their owner\'s address only. Open the invite link itself and choose “Use it in this browser”, or pair this app with your own sync first.'), { needsPairing: true, server: inv.server });
      }
      let res;
      try {
        res = await fetchImpl(`${inv.server}/api/shares/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.code }) });
      } catch { throw new Error('No connection. Try again when you are online.'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.token !== 'string' || !validId(data.projectId)) throw new Error(data.error || `The invite did not work (${res.status}).`);
      const access = data.access === 'edit' ? 'edit' : 'view';
      const leaveAgain = () => fetchImpl(`${inv.server}/api/shares/leave`, { method: 'POST', headers: { authorization: `Bearer ${data.token}` } }).catch(() => {});
      const known = this.shareOf(data.projectId);
      if (known && data.kind === 'move' && known.via === 'direct') {
        Object.assign(known, { token: data.token, access });   // moved back here: the new key
        this.setMeta({ shares: this.shares() });
        share = known;
      } else {
        if (known) { leaveAgain(); throw new Error(`“${data.projectName}” is already here.`); }
        if (this.get('project', data.projectId)) { leaveAgain(); throw new Error(`“${data.projectName}” is one of your own lists.`); }
        share = this.addBinding({ via: 'direct', server: inv.server, token: data.token, access, projectId: data.projectId, name: String(data.projectName || 'Shared list') });
      }
    }
    await this.save();
    this.emit();
    this.sync({ force: true });
    return share;
  }

  /**
   * The lists this device's own Worker keeps for its phones (every /api/sync answer): one joined on another phone
   * shows up here too. Ending ones are left to their own session (it learns how they ended, and whether this app
   * keeps a copy); ones left here are left again if that did not get through.
   */
  reconcileRemotes(remotes) {
    const leaving = new Set(this.meta.leaving ?? []);
    const active = remotes.filter((r) => r && r.state === 'active' && typeof r.id === 'string' && validId(r.projectId) && typeof r.server === 'string');
    let changed = false;
    for (const r of active) {
      if (leaving.has(r.id)) { this.ownCall(`remotes/${r.id}/leave`).catch(() => {}); continue; }
      if (this.shares().some((s) => s.remote === r.id) || this.shareOf(r.projectId) || this.get('project', r.projectId)) continue;
      this.bindRemote(r);
      changed = true;
    }
    const still = [...leaving].filter((id) => active.some((r) => r.id === id));
    if (changed || still.length !== leaving.size) this.setMeta({ shares: this.shares(), leaving: still });
  }

  /**
   * Paired now, with a list this app reached on its own before (in the browser, from its owner's address): its key
   * goes to this device's own Worker, which syncs it (and reminds of it) from then on.
   */
  async adoptDirect(share) {
    if (share.server === this.ownOrigin()) {
      // its owner's Worker is this app's own now: the list is one of its own lists
      fetch(`${share.server}/api/shares/leave`, { method: 'POST', headers: { authorization: `Bearer ${share.token}` } }).catch(() => {});
      this.dropShare(share);
      this.emit();
      return;
    }
    const r = await this.ownCall('remotes/adopt', { server: share.server, token: share.token, name: share.name });
    if (r.status === 401 && ['revoked', 'transferred'].includes(r.data.error)) {
      throw Object.assign(new Error('This list is not shared with you any more.'), { ended: r.data.error, convert: r.data.error === 'revoked' });
    }
    if (r.status === 401) throw Object.assign(new Error('This device is no longer paired (token rejected). Pair it again from the desktop app.'), { auth: true });
    if (r.status !== 200 || typeof r.data.remote?.id !== 'string') throw new Error(r.data.error || `Server error ${r.status}`);
    if (share.push) fetch(`${share.server}/api/push/unsubscribe`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${share.token}` }, body: JSON.stringify({ endpoint: share.push.endpoint }) }).catch(() => {});
    Object.assign(share, { via: 'relay', remote: r.data.remote.id });
    delete share.token;
    delete share.push;
    this.setMeta({ shares: this.shares() });
  }

  /**
   * "Move to my Saqme app" (a list used in the browser from its owner's address): a one-time code for the same share
   * that another app of this person claims like an invite. When it does, this copy stops syncing (and goes).
   */
  async transferShare(shareId) {
    const share = this.shares().find((s) => s.id === shareId);
    if (!share || share.via !== 'direct') throw new Error('Only a list used in the browser moves to an app.');
    return this.shareCall(share, 'shares/transfer', {});
  }

  /** Takes a shared list's rows (its list, tasks, conflicts) and binding off this device. */
  dropShare(share) {
    for (const [key] of this.rowsOf(share)) { this.rows.delete(key); this.outbox.delete(key); this.dirty.add(key); }
    this.shareStatus.delete(share.id);
    this.setMeta({ shares: this.shares().filter((s) => s.id !== share.id), notices: (this.meta.notices ?? []).filter((n) => n.share !== share.id) });
  }

  /**
   * Leave: the list goes from this device (and the person's other phones: one key for all of them); nothing changes
   * on its owner's server, except that the key ends.
   */
  leaveShare(shareId, { fetchImpl = fetch } = {}) {
    const share = this.shares().find((s) => s.id === shareId);
    if (!share) return;
    this.dropShare(share);
    if (share.via !== 'direct') this.setMeta({ leaving: [...(this.meta.leaving ?? []), share.remote] });
    const { url, token } = this.shareRequest(share, 'leave');
    if (token) fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
    this.emit();
  }

  /**
   * A list's session learned that it ended ({ ended, convert } from shareRefusal). convert: this app keeps it as an
   * own list (endShare). Otherwise it just goes: moved to another app of this person ('sharemoved'), left on
   * another phone, or revoked and kept by another phone (that copy comes through this device's own sync).
   */
  shareEnded(share, { ended, convert } = {}) {
    if (!this.shares().includes(share)) return;
    if (convert) { this.endShare(share, ended); return; }
    const name = cleanProjectName(this.get('project', share.projectId)?.fields.name.v || share.name) || 'Shared list';
    this.dropShare(share);
    this.emit();
    if (ended === 'transferred') this.dispatchEvent(Object.assign(new Event('sharemoved'), { detail: { name } }));
    else if (ended === 'revoked') this.dispatchEvent(Object.assign(new Event('shareended'), { detail: { name, kept: true, elsewhere: true } }));
  }

  /**
   * Its owner stopped sharing it (the key got 401), or this device's own Worker no longer has it ('gone'): the list
   * stays here as one of this device's own, with new ids (so the owner's copy and this one never get mixed up,
   * should it be shared again), and the app says so.
   */
  endShare(share, reason = 'revoked') {
    const p = this.get('project', share.projectId);
    const name = cleanProjectName(p?.fields.name.v || share.name) || 'Shared list';
    const pos = this.projectPos(p ?? { id: share.projectId, fields: { pos: { v: share.pos } } });
    const tree = this.tree(share.projectId);
    const deleted = !!p?.fields.deleted.v;
    this.dropShare(share);
    if (!deleted) {
      const pid = newId();
      this.change('project', pid, { name, pos: pos || 'a0', deleted: false }, { create: true });
      const copy = (n, parent) => {
        const nid = newId();
        const f = n.task.fields;
        this.change('task', nid, { place: { project: pid, parent, pos: f.place.v.pos }, text: f.text.v, status: f.status.v, due: f.due.v, notes: f.notes.v, deleted: false }, { create: true });
        for (const k of n.kids) copy(k, nid);
      };
      for (const r of tree.roots) copy(r, null);
    }
    this.emit();
    this.dispatchEvent(Object.assign(new Event('shareended'), { detail: { name, kept: !deleted, ...(reason === 'gone' ? { gone: true } : {}) } }));
  }
}
