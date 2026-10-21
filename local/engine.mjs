// Lists folder <-> sync server: the desktop sync engine of desktop/sync-core.ps1, ported to JavaScript for
// the Linux/macOS app. Same state, same rules, same plan format (see docs/sync.md, "Desktop engine"):
//
//   R       server rows as last received ("task:<id>" -> { kind, id, fields: { name: { v, ts } } })
//   S       base: what the files reflected at the last reconcile, plus local changes already queued
//   Outbox  local changes not yet acknowledged (resent unchanged after a crash)
//   Files   project id -> file base name;  Stamped: path -> { text, ts } for lists we only rewrote to add ids
//   Planned "task:<id>" -> what the lists held before the last plans changed that task (see notePlanned)
//   Missing project id -> when its list was first seen missing;  Guard: { ids } of the deletes held back
//
// A cycle: read the lists -> queue Diff(lists, S) -> send through `transport` -> fold rows into R -> if no
// list changed meanwhile, rewrite the lists so they match R (one all-or-nothing plan) -> S := R.
// `transport(body)` is the server: HTTP to a Worker, or the local store in-process (local/server.mjs).
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  parseItems, formatItems, detectEol, subtreeEnd, findItem, removeItemKeepChildren, setMissingIds, newTaskId, toFileName, cleanTime,
  cleanNotes, cleanText as cleanLine, isValidDate,
} from '../worker/public/js/markdown.js';
import { keyBetween, rekey } from '../worker/public/js/keys.js';

// ================================================================ files
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
/**
 * File bytes -> text (byte order marks dropped). UTF-8, or UTF-16 with its byte order mark; a file that is
 * not valid UTF-8 was saved in a legacy code page (Windows-1252 here; the Windows app uses the system's),
 * and is read that way instead of turning its accents into U+FFFD for good on the next write.
 */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try { return strictUtf8.decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
export function readText(path) {
  try {
    if (!existsSync(path)) return null;
    return decodeText(readFileSync(path));
  } catch { return null; }
}

// temp file + rename, so a crash never leaves a half-written list; split in two so a plan can stage first.
// Flushed to disk before the rename: after a power cut the list is the old one or the new one, not empty.
function writeTemp(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  return tmp;
}
const completeTemp = (tmp, path) => renameSync(tmp, path);
export function writeAtomic(path, text) { completeTemp(writeTemp(path, text), path); }

// ================================================================ rows
const getField = (row, name) => row?.fields?.[name] ?? null;
const placeOf = (row) => getField(row, 'place')?.v ?? null;

function valueKey(field, v) {
  if (v == null) return '<null>';
  switch (field) {
    case 'place': return `${v.project ?? ''}\t${v.parent ?? ''}\t${v.pos ?? ''}`;
    case 'due': return `${v.date ?? ''}\t${v.time ?? ''}`;
    case 'deleted': case 'resolved': return String(Boolean(v));
    default: return String(v);
  }
}
const sameValue = (field, a, b) => valueKey(field, a) === valueKey(field, b);
const copyValue = (v) => (v && typeof v === 'object' ? { ...v } : v);

export function copyRow(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) if (k !== 'fields') out[k] = v;
  out.fields = {};
  for (const [name, f] of Object.entries(row.fields ?? {})) out.fields[name] = { v: copyValue(f.v), ts: Number(f.ts) };
  return out;
}

function emptyRow(kind, id) {
  const f = {};
  if (kind === 'task') for (const [n, v] of [['place', null], ['text', ''], ['status', ' '], ['due', null], ['notes', ''], ['deleted', false]]) f[n] = { v, ts: 0 };
  else if (kind === 'project') { f.name = { v: '', ts: 0 }; f.pos = { v: 'a0', ts: 0 }; f.deleted = { v: false, ts: 0 }; }
  else if (kind === 'setting') f.value = { v: '', ts: 0 };
  return { kind, id, fields: f };
}

export function cleanText(s, max = 10_000) {
  let t = cleanLine(s);
  if (t.length > max) t = t.slice(0, max).trim();   // the server's limits: longer text stays local only
  return t;
}

/** Sibling keys -> Map(index -> new key) for the entries that must change (keeps the longest increasing run). */
export function rekeyMap(keys) {
  let out = rekey(keys);
  // keys grow when lines keep being inserted at the same spot: past 48 characters, start the list over
  if ([...out.values()].some((k) => k.length > 48)) {
    out = new Map();
    let lo = null;
    for (let i = 0; i < keys.length; i++) { lo = keyBetween(lo, null); out.set(i, lo); }
  }
  return out;
}

// ================================================================ sync state
// Notices: what a shared list's server did not take (view-only list), shown with the conflicts;
// Shared: ids of the projects one's own server says are shared with others (their tabs get a badge)
export function newState() {
  return {
    version: 1, cursor: 0, dbId: '', clockOffset: 0, lastTs: 0, R: {}, S: {}, Outbox: [], Files: {}, Stamped: {},
    Planned: {}, Missing: {}, Guard: null, Notices: [], Shared: [],
  };
}
export function readState(path) {
  const st = newState();
  const t = readText(path);
  if (!t) return st;
  const o = JSON.parse(t);
  for (const k of ['cursor', 'dbId', 'clockOffset', 'lastTs']) if (k in o) st[k] = o[k];
  for (const m of ['R', 'S', 'Files', 'Stamped', 'Planned', 'Missing']) if (o[m]) Object.assign(st[m], o[m]);
  if (Array.isArray(o.Outbox)) st.Outbox.push(...o.Outbox);
  if (o.Guard && Array.isArray(o.Guard.ids)) st.Guard = { ids: o.Guard.ids };
  if (Array.isArray(o.Notices)) st.Notices.push(...o.Notices);
  if (Array.isArray(o.Shared)) st.Shared = o.Shared;
  return st;
}
export function saveState(st, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, JSON.stringify(st));
}

/** Server-corrected ms clock, strictly increasing. */
export function syncNow(st) {
  let t = Date.now() + Number(st.clockOffset);
  if (t <= st.lastTs) t = st.lastTs + 1;
  st.lastTs = t;
  return t;
}

/**
 * Adds a change to the outbox (coalescing per row + field, keeping the first base) and folds it into S.
 * over: { base: { field: ts }, ts: { field: ts } } replaces the base / time of single fields (stale saves).
 */
function addLocalChange(st, kind, id, values, ts, create = false, over = {}) {
  const key = `${kind}:${id}`;
  let srow = st.S[key];
  if (!srow) { srow = emptyRow(kind, id); st.S[key] = srow; }
  let entry = st.Outbox.find((e) => e.kind === kind && e.id === id);
  if (!entry) { entry = { kind, id, fields: {} }; st.Outbox.push(entry); }
  for (const [name, v] of Object.entries(values)) {
    if (!entry.fields[name]) entry.fields[name] = { base: create ? -1 : (srow.fields[name] ? Number(srow.fields[name].ts) : -1) };
    if (over.base && name in over.base) entry.fields[name].base = over.base[name];
    const t = over.ts && name in over.ts ? over.ts[name] : ts;
    entry.fields[name].v = v;
    entry.fields[name].ts = t;
    srow.fields[name] = { v: copyValue(v), ts: t };
  }
}

// ================================================================ local snapshot
const nameCollator = new Intl.Collator(undefined, { sensitivity: 'accent' });
const sameName = (a, b) => nameCollator.compare(a, b) === 0;

/** List names in tab order: lists/.order first, then the rest alphabetically. */
export function projectFileNames(listsDir) {
  let files = [];
  try { files = readdirSync(listsDir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.slice(0, -3)); } catch { /* none */ }
  const result = [];
  const t = readText(join(listsDir, '.order'));
  if (t) for (const n of t.split(/\r?\n/)) if (n && files.includes(n) && !result.includes(n)) result.push(n);
  const rest = files.filter((n) => !result.includes(n)).sort(nameCollator.compare);
  return [...result, ...rest];
}

/**
 * Reads every list; a list is usable ('ok') only if readable, not written in the last moment, all ids unique,
 * and free of NUL characters (what a power cut can leave in a file that was being written).
 * view: which lists this engine syncs (shared lists, docs/sync.md): { only: name } (a shared list's engine),
 * { exclude: Set } (the lists shared with this computer, which an engine for one's own server leaves out), and
 * { first: Set } (their ids are checked first, so a line copied out of one gets the new id). `all`: every list.
 */
export function readLocalLists(listsDir, settleMs = 1500, view = null) {
  const res = { ok: true, dir: listsDir, names: [], all: [], files: {} };
  if (!existsSync(listsDir)) { res.ok = false; return res; }
  res.all = projectFileNames(listsDir);
  res.names = view?.only != null ? res.all.filter((n) => n === view.only) : view?.exclude ? res.all.filter((n) => !view.exclude.has(n)) : res.all;
  const now = Date.now();
  const allIds = new Set();
  const first = view?.first;
  for (const name of first ? [...res.names.filter((n) => first.has(n)), ...res.names.filter((n) => !first.has(n))] : res.names) {
    const path = join(listsDir, `${name}.md`);
    const f = { name, path, text: null, items: null, status: 'ok', mtime: 0 };
    let lw = now;
    try { lw = statSync(path).mtimeMs; } catch { /* vanished */ }
    f.mtime = Math.floor(lw);
    f.text = readText(path);
    if (f.text == null || f.text.includes('\u0000')) f.status = 'error';
    else if (now - lw >= 0 && now - lw < settleMs) f.status = 'busy';
    else {
      f.items = parseItems(f.text);
      for (const it of f.items) {
        if (it.kind !== 'task' || it.text === '') continue;
        if (!it.id || allIds.has(it.id)) f.status = 'unstamped'; else allIds.add(it.id);
      }
    }
    res.files[name] = f;
  }
  return res;
}

// ================================================================ diff: files -> outgoing changes
const PLANNED_KEEP = 30 * 60_000;   // how long after a plan a save can still be from a copy older than it
const MISSING_GRACE = 10_000;       // a list gone this long (and for two cycles) deletes its project

// A plan rewrote lists with what came from other devices; S then takes the server's rows. Before that, keep
// what the lists held, for each task field the plan changed and each task it brought into a list (added),
// so that a list saved later from an older copy (an editor or an AI that read it before the plan) is told
// apart from an edit (see staleSave). Entries last PLANNED_KEEP; each field is used once.
function notePlanned(st, waiting, clock) {
  for (const [key, r] of Object.entries(st.R)) {
    if (r.kind !== 'task' || waiting.has(key) || !rowPending(st, key)) continue;
    const s = st.S[key];
    const p = st.Planned[key] ?? { at: clock, added: false, fields: {} };
    p.at = clock;
    const shown = (row) => row && !getField(row, 'deleted')?.v;
    if (shown(r) && (!shown(s) || placeOf(s)?.project !== placeOf(r)?.project) && !p.added) {
      p.added = true;
      p.addedTs = Math.max(0, Math.min(...Object.values(r.fields).map((f) => Number(f.ts))) - 1);
    }
    if (s) {
      for (const [name, f] of Object.entries(r.fields)) {
        if (name in p.fields || sameValue(name, f.v, getField(s, name)?.v)) continue;
        p.fields[name] = { v: copyValue(getField(s, name)?.v ?? null), ts: Number(getField(s, name)?.ts ?? 0) };
      }
    }
    if (p.added || Object.keys(p.fields).length) st.Planned[key] = p;
  }
}

// back to how it was before the plan (a place: back under the parent / in the list it had, when the plan moved it)
function isRevert(field, pre, now, post) {
  if (field !== 'place') return sameValue(field, pre, now);
  const where = (v) => `${v?.project ?? ''}\t${v?.parent ?? ''}`;
  return where(pre) === where(now) && where(pre) !== where(post);
}

/**
 * The base / time to send a task's changed fields with, when a recent plan changed them. A field back to its
 * value from before the plan is sent as of then: the other device's newer value stays and this one is kept
 * as a conflict. Any other change counts as made alongside the other device's (newest wins, the other one
 * is kept as a conflict). Nothing is lost either way, where a plain edit would silently undo the other device.
 */
function staleSave(st, tid, vals, clock) {
  const key = `task:${tid}`;
  const p = st.Planned[key];
  const over = { base: {}, ts: {} };
  if (!p) return over;
  for (const fn of Object.keys(vals)) {
    const pre = p.fields[fn];
    if (!pre) continue;
    over.base[fn] = pre.ts;
    if (isRevert(fn, pre.v, vals[fn], getField(st.S[key], fn)?.v)) over.ts[fn] = pre.ts;
    delete p.fields[fn];
  }
  if (!Object.keys(p.fields).length && !p.added) delete st.Planned[key];
  return over;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** lists/.trash holds a copy of list `name` with one of `ids` in it (any copy, if the list had no tasks). */
function trashedCopy(listsDir, name, ids) {
  let files = [];
  try { files = readdirSync(join(listsDir, '.trash')); } catch { return false; }
  const re = new RegExp(`^${escapeRe(name)}-\\d{8}-\\d{6}\\.md$`, 'i');
  for (const f of files) {
    if (!re.test(f)) continue;
    if (!ids.length) return true;
    const t = readText(join(listsDir, '.trash', f));
    if (t && parseItems(t).some((it) => it.kind === 'task' && ids.includes(it.id))) return true;
  }
  return false;
}
const liveTaskIds = (base, projId) => Object.values(base)
  .filter((r) => r.kind === 'task' && !getField(r, 'deleted')?.v && placeOf(r)?.project === projId).map((r) => r.id);

/**
 * Returns { count, deletes, guarded, skipped, empty, stamp: [ops for lists that need ids] }; mutates st.
 * clock: this computer's time in ms (tests move it on).
 * opts.scope = { project, file }: the engine of a list shared with this computer, whose one file is that project.
 * The list itself (its name, order, deletion) is its owner's: nothing about it is sent, only its tasks.
 * opts.expected: keys of tasks whose disappearance is expected (a share that ended got new ids), never held back.
 */
export function addLocalDiff(st, local, notifyAt, allowMassDelete = false, clock = Date.now(), { scope = null, expected = null } = {}) {
  const out = { count: 0, deletes: 0, guarded: 0, stamp: [], skipped: false, empty: false };
  if (!local.ok || local.names.length === 0) { out.skipped = true; out.empty = local.ok; return out; }
  const now = syncNow(st);
  for (const [k, p] of Object.entries(st.Planned)) if (!(clock - p.at < PLANNED_KEEP)) delete st.Planned[k];
  // an edit counts from when its list was saved, not from when this cycle noticed it ("newest wins" stays
  // fair); a list we only rewrote to add ids keeps the time of the edit before that
  const editTs = {};
  for (const name of local.names) {
    const f = local.files[name];
    const t = f.mtime + Number(st.clockOffset);
    editTs[name] = t > 0 && t < now ? t : now;
    const mark = st.Stamped[f.path];
    if (mark) {
      if (f.text === mark.text) editTs[name] = Number(mark.ts);
      else if (f.status === 'ok') delete st.Stamped[f.path];
    }
  }
  const base = st.S;
  const srv = st.R;

  // ---- lists that need ids first (no changes are sent for them this cycle)
  const taken = new Set();
  for (const name of local.names) {
    const f = local.files[name];
    if (f.status === 'ok') for (const it of f.items) if (it.kind === 'task' && it.id) taken.add(it.id);
  }
  for (const name of local.names) {
    const f = local.files[name];
    if (f.status !== 'unstamped') continue;
    const items = parseItems(f.text);
    const pid0 = Object.keys(st.Files).find((k) => st.Files[k] === name) ?? null;
    const known = new Map();
    if (pid0) {
      for (const r of Object.values(base)) {
        if (r.kind !== 'task') continue;
        const pl = placeOf(r);
        if (pl && pl.project === pid0 && !taken.has(r.id)) known.set(String(getField(r, 'text')?.v ?? ''), r.id);
      }
    }
    setMissingIds(items, known, taken);
    for (const it of items) if (it.kind === 'task' && it.id) taken.add(it.id);
    const stampedText = formatItems(items, 0, detectEol(f.text));
    out.stamp.push({ type: 'write', path: f.path, expected: f.text, text: stampedText });
    st.Stamped[f.path] = { text: stampedText, ts: editTs[name] };
  }
  for (const name of local.names) if (local.files[name].status !== 'ok') out.skipped = true;

  // ---- projects: file name -> project id
  const nameToId = {};
  const projectDeletes = [];
  if (scope) {
    for (const name of local.names) { nameToId[name] = scope.project; st.Files[scope.project] = name; }
  } else mapProjects(st, local, out, now, clock, nameToId, projectDeletes);

  // ---- tasks
  diffTasks(st, local, out, now, clock, nameToId, projectDeletes, editTs, allowMassDelete, expected);
  // ---- synced settings
  if (notifyAt) {
    let sr = base['setting:notifyAt'];
    const rr = srv['setting:notifyAt'];
    if (!sr && rr) {
      // first contact with a server that already has one: the server's value wins (applied by the next plan)
      sr = copyRow(rr); sr.fields.value.v = notifyAt; base['setting:notifyAt'] = sr;
    } else if (!sr) {
      addLocalChange(st, 'setting', 'notifyAt', { value: notifyAt }, now, true); out.count++;
    } else if (String(getField(sr, 'value')?.v ?? '') !== notifyAt) {
      addLocalChange(st, 'setting', 'notifyAt', { value: notifyAt }, now); out.count++;
    }
  }
  return out;
}

/** File names -> project ids (new lists, renamed ones, adopted ones), names and order; lists that are gone. */
function mapProjects(st, local, out, now, clock, nameToId, projectDeletes) {
  const base = st.S;
  const srv = st.R;
  const mapped = {};
  for (const pid of Object.keys(st.Files)) mapped[st.Files[pid]] = pid;
  const unmatched = [];
  for (const name of local.names) {
    if (Object.hasOwn(mapped, name)) {
      const mid = mapped[name];
      if (!base[`project:${mid}`]) {
        // the server did not know this project (it said "unknown project"): create it again, same id
        addLocalChange(st, 'project', mid, { name: cleanText(name, 120), pos: 'a0', deleted: false }, now, true);
        out.count++;
      }
      nameToId[name] = mid;
      continue;
    }
    unmatched.push(name);
  }
  const usedIds = new Set(Object.values(nameToId));
  const missing = [];   // live base projects without a file
  for (const r of Object.values(base)) {
    if (r.kind !== 'project' || usedIds.has(r.id) || getField(r, 'deleted')?.v) continue;
    missing.push(r.id);
  }
  const newNames = [];
  for (const name of unmatched) {
    let hit = null;
    // same name as a known project whose file mapping got lost (or a project restored by hand)
    for (const r of Object.values(base)) {
      if (r.kind === 'project' && !usedIds.has(r.id) && sameName(String(getField(r, 'name')?.v ?? ''), name)) { hit = r.id; break; }
    }
    // a project the server already has (first sync of this computer): adopt its id instead of duplicating it
    if (!hit) {
      for (const [key, r] of Object.entries(srv)) {
        if (r.kind === 'project' && !usedIds.has(r.id) && !getField(r, 'deleted')?.v && sameName(String(getField(r, 'name')?.v ?? ''), name) && !base[key]) {
          hit = r.id; base[key] = copyRow(r); break;
        }
      }
    }
    if (hit) { nameToId[name] = hit; usedIds.add(hit); const i = missing.indexOf(hit); if (i >= 0) missing.splice(i, 1); } else newNames.push(name);
  }
  // renamed files: a new file holding most of a vanished project's tasks (or the only new + only vanished one)
  for (const name of [...newNames]) {
    const f = local.files[name];
    let best = null;
    let bestHits = 0;
    if (f.status === 'ok') {
      const ids = new Set(f.items.filter((it) => it.kind === 'task' && it.id).map((it) => it.id));
      for (const cand of missing) {
        let hits = 0;
        for (const tid of ids) { const sr = base[`task:${tid}`]; if (sr && placeOf(sr)?.project === cand) hits++; }
        if (hits > bestHits) { best = cand; bestHits = hits; }
      }
      if (bestHits < Math.max(1, Math.ceil(ids.size / 2))) best = null;
    }
    if (!best && newNames.length === 1 && missing.length === 1 && f.status === 'ok') best = missing[0];
    if (best) {
      nameToId[name] = best; usedIds.add(best);
      missing.splice(missing.indexOf(best), 1);
      newNames.splice(newNames.indexOf(name), 1);
    }
  }
  for (const name of newNames) {
    const id = newTaskId();
    nameToId[name] = id;
    addLocalChange(st, 'project', id, { name: cleanText(name, 120), pos: 'a0', deleted: false }, now, true);
    out.count++;
  }
  // names, restores, order
  const orderKeys = [];
  for (const name of local.names) {
    const id = nameToId[name];
    const sr = base[`project:${id}`];
    const vals = {};
    if (st.Files[id] !== name && String(getField(sr, 'name')?.v ?? '') !== cleanText(name, 120)) vals.name = cleanText(name, 120);
    if (getField(sr, 'deleted')?.v) vals.deleted = false;
    if (Object.keys(vals).length) { addLocalChange(st, 'project', id, vals, now); out.count++; }
    st.Files[id] = name;
    orderKeys.push(String(getField(base[`project:${id}`], 'pos')?.v ?? ''));
  }
  for (const [i, key] of rekeyMap(orderKeys)) { addLocalChange(st, 'project', nameToId[local.names[i]], { pos: key }, now); out.count++; }
  // projects whose list is gone. Moved to lists/.trash (how the apps delete a list): deleted below. Gone some
  // other way (moved out and back, a sync client re-downloading the folder, git checkout): nothing is decided
  // until it has been gone for two cycles and 10 seconds, and then the delete guard below weighs it like its tasks
  for (const id of missing) {
    const ids = liveTaskIds(base, id);
    if (st.Files[id] != null && trashedCopy(local.dir, st.Files[id], ids)) { projectDeletes.push({ id, ids, trashed: true }); continue; }
    if (!(id in st.Missing)) st.Missing[id] = clock;
    if (clock - st.Missing[id] < MISSING_GRACE) { out.skipped = true; continue; }
    projectDeletes.push({ id, ids, trashed: false });
  }
  for (const id of Object.keys(st.Missing)) if (!missing.includes(id)) delete st.Missing[id];
}

/** Task changes from the lists, and the deletes (held back when a large share vanishes at once). */
function diffTasks(st, local, out, now, clock, nameToId, projectDeletes, editTs, allowMassDelete, expected) {
  const base = st.S;
  const localTasks = new Map();
  const order = [];
  for (const name of local.names) {
    const f = local.files[name];
    if (f.status !== 'ok') continue;
    const projId = nameToId[name];
    const groups = new Map();
    const stack = [];
    for (const it of f.items) {
      if (it.kind !== 'task') { stack.length = 0; continue; }
      if (it.text === '') continue;
      while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].id : null;
      stack.push(it);
      const due = it.due && isValidDate(it.due) ? { date: it.due, time: cleanTime(it.dueTime) } : null;
      let notes = cleanNotes(it.notes);
      if (notes.length > 50_000) notes = cleanNotes(notes.slice(0, 50_000));
      localTasks.set(it.id, { project: projId, parent, pos: null, text: cleanText(it.text), status: it.mark, due, notes, ts: editTs[name] });
      order.push(it.id);
      const gk = `${projId}|${parent ?? ''}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(it.id);
    }
    for (const ids of groups.values()) {
      const keys = ids.map((tid) => {
        const sr = base[`task:${tid}`];
        const sp = placeOf(sr);
        const l = localTasks.get(tid);
        return sp && !getField(sr, 'deleted')?.v && sp.project === l.project && `${sp.parent ?? ''}` === `${l.parent ?? ''}` ? String(sp.pos) : null;
      });
      const rk = rekeyMap(keys);
      ids.forEach((tid, i) => { localTasks.get(tid).pos = rk.has(i) ? rk.get(i) : keys[i]; });
    }
  }
  for (const tid of order) {
    const l = localTasks.get(tid);
    const place = { project: l.project, parent: l.parent, pos: l.pos };
    const sr = base[`task:${tid}`];
    if (!sr) {
      addLocalChange(st, 'task', tid, { place, text: l.text, status: l.status, due: l.due, notes: l.notes, deleted: false }, l.ts, true);
      out.count++;
      continue;
    }
    const vals = {};
    if (!sameValue('place', placeOf(sr), place)) vals.place = place;
    for (const fn of ['text', 'status', 'due', 'notes']) if (!sameValue(fn, getField(sr, fn)?.v, l[fn])) vals[fn] = l[fn];
    if (getField(sr, 'deleted')?.v) vals.deleted = false;
    if (Object.keys(vals).length) { addLocalChange(st, 'task', tid, vals, l.ts, false, staleSave(st, tid, vals, clock)); out.count++; }
  }
  // deletes: tasks gone from every list while their project's list is here, and projects whose list is gone.
  // Never decided while any list was unusable (it may just have moved there). Held back when a large share
  // vanishes at once: 5+ tasks and over half of one list, or 25+ tasks and over half of all of them.
  // Confirming deletes exactly what was held back; whatever vanished since is weighed again.
  if (!out.skipped) {
    const liveProjects = new Set(Object.values(nameToId));
    const tsOfProject = {};
    for (const name of local.names) tsOfProject[nameToId[name]] = editTs[name];
    const sizeOf = new Map();
    const cands = [];   // { key, id, list, weight, project }
    let total = 0;
    for (const r of Object.values(base)) {
      if (r.kind !== 'task' || getField(r, 'deleted')?.v) continue;
      const pl = placeOf(r);
      if (!pl || !liveProjects.has(pl.project)) continue;
      total++;
      sizeOf.set(pl.project, (sizeOf.get(pl.project) ?? 0) + 1);
      if (localTasks.has(r.id)) continue;
      const p = st.Planned[`task:${r.id}`];
      if (p?.added) {
        // the last plan brought it into this list and a save from an older copy dropped it: not a delete
        // but a conflict (dated before the task arrived, so the server keeps it and the next plan puts it back)
        addLocalChange(st, 'task', r.id, { deleted: true }, p.addedTs);
        delete st.Planned[`task:${r.id}`];
        out.count++;
        continue;
      }
      cands.push({ key: `task:${r.id}`, id: r.id, list: pl.project, weight: 1, project: false });
    }
    for (const pd of projectDeletes) {
      if (pd.trashed) continue;
      total += pd.ids.length;
      sizeOf.set(pd.id, pd.ids.length);
      cands.push({ key: `project:${pd.id}`, id: pd.id, list: pd.id, weight: pd.ids.length, project: true });
    }
    const alarming = (cs) => {
      const per = new Map();
      let n = 0;
      for (const c of cs) { per.set(c.list, (per.get(c.list) ?? 0) + c.weight); n += c.weight; }
      for (const [list, k] of per) if (k >= 5 && k > sizeOf.get(list) / 2) return true;
      return n >= 25 && n > total / 2;
    };
    const confirmed = new Set([...(allowMassDelete ? st.Guard?.ids ?? [] : []), ...(expected ?? [])]);
    const fresh = cands.filter((c) => !confirmed.has(c.key));
    let send = cands;
    if (fresh.length && alarming(fresh)) {
      send = cands.filter((c) => confirmed.has(c.key));
      out.guarded = fresh.reduce((n, c) => n + c.weight, 0);
      st.Guard = { ids: fresh.map((c) => c.key) };
    } else st.Guard = null;
    for (const c of [...send, ...projectDeletes.filter((pd) => pd.trashed).map((pd) => ({ id: pd.id, project: true }))]) {
      if (c.project) {
        addLocalChange(st, 'project', c.id, { deleted: true }, now);
        delete st.Files[c.id]; delete st.Missing[c.id];
      } else {
        addLocalChange(st, 'task', c.id, { deleted: true }, tsOfProject[c.list] ?? now);
        out.deletes++;
      }
      out.count++;
    }
  }
}

// ================================================================ remote -> files
function rowPending(st, key) {
  const r = st.R[key];
  const s = st.S[key];
  if (!r) return false;
  if (!s) return true;
  return Object.keys(r.fields).some((name) => !sameValue(name, r.fields[name].v, getField(s, name)?.v));
}

function itemFromRow(row, level) {
  const due = getField(row, 'due')?.v;
  const text = String(getField(row, 'text')?.v ?? '');
  return {
    kind: 'task', level, mark: String(getField(row, 'status')?.v ?? ' '), text: text || '(untitled)',
    due: due ? String(due.date) : '', dueTime: due ? String(due.time ?? '') : '', notes: String(getField(row, 'notes')?.v ?? ''), raw: '', id: String(row.id),
  };
}

// copies onto a line only the fields the server changed (R differs from the base), nothing else
function setItemFromRemote(it, row, baseRow) {
  const n = itemFromRow(row, it.level);
  const map = { text: ['text'], status: ['mark'], due: ['due', 'dueTime'], notes: ['notes'] };
  for (const [field, props] of Object.entries(map)) {
    if (baseRow && sameValue(field, getField(row, field)?.v, getField(baseRow, field)?.v)) continue;
    for (const p of props) it[p] = n[p];
  }
}

const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const comparePosition = (k1, id1, k2, id2) => ordinal(k1, k2) || ordinal(id1, id2);

// id -> order key (server first, then base) for placing tasks among their siblings
function positionMap(st) {
  const m = new Map();
  for (const src of [st.S, st.R]) for (const r of Object.values(src)) if (r.kind === 'task') { const pl = placeOf(r); if (pl) m.set(r.id, String(pl.pos)); }
  return m;
}

// Inserts block (item + its subtree, levels relative to its first item) under parentId by order key.
// unsettled: ids that are still going to move; they sit at stale spots, so they are no anchors
function addBlockByPosition(items, block, parentId, pos, posOf, selfId = '', unsettled = null) {
  let pi = -1;
  let plevel = -1;
  if (parentId) { pi = findItem(items, parentId); if (pi >= 0) plevel = items[pi].level; }
  // direct children of the parent (or roots of the list)
  const sibs = [];
  if (pi >= 0) {
    const end = subtreeEnd(items, pi);
    for (let i = pi + 1; i < end; i = subtreeEnd(items, i)) sibs.push(i);
  } else {
    // top-level tasks: nothing shallower before them since the last non-task line
    let runMin = Infinity;
    items.forEach((it, i) => {
      if (it.kind !== 'task') { runMin = Infinity; return; }
      if (it.level <= runMin) { sibs.push(i); runMin = it.level; }
    });
  }
  let at = -1;
  let level = pi >= 0 ? plevel + 1 : 0;
  // after the sibling with the largest smaller (key, id); else before the smallest larger one
  let after = null; let afterKey = null; let afterId = '';
  let before = null; let beforeKey = null; let beforeId = '';
  const settled = sibs.filter((si) => !unsettled?.has(items[si].id));
  for (const si of settled) {
    const sid = items[si].id;
    const k = posOf.get(sid);
    if (!k) continue;
    if (comparePosition(k, sid, pos, selfId) < 0) {
      if (afterKey == null || comparePosition(k, sid, afterKey, afterId) > 0) { after = si; afterKey = k; afterId = sid; }
    } else if (beforeKey == null || comparePosition(k, sid, beforeKey, beforeId) < 0) { before = si; beforeKey = k; beforeId = sid; }
  }
  if (after != null) { at = subtreeEnd(items, after); level = items[after].level; }
  else if (before != null) { at = before; level = items[before].level; }
  else if (settled.length) { const last = settled[settled.length - 1]; at = subtreeEnd(items, last); level = items[last].level; }
  else if (sibs.length) { at = sibs[0]; level = items[sibs[0]].level; }
  else if (pi >= 0) at = pi + 1;
  else {
    // after the last task, before trailing blank lines
    at = items.length;
    for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === 'task') { at = k + 1; break; }
    if (at === items.length) while (at > 0 && items[at - 1].kind === 'raw' && /^\s*$/.test(items[at - 1].raw)) at--;
  }
  const delta = level - block[0].level;
  for (const b of block) b.level += delta;
  items.splice(at, 0, ...block);
}

function rowDepthMap(st) {
  const depth = new Map();
  for (const r of Object.values(st.R)) {
    if (r.kind !== 'task') continue;
    let d = 0;
    let p = placeOf(r)?.parent;
    for (let guard = 0; p && guard < 200; guard++) { const pr = st.R[`task:${p}`]; if (!pr) break; d++; p = placeOf(pr)?.parent; }
    depth.set(r.id, d);
  }
  return depth;
}
const placeOrder = (depth) => (x) => `${String(depth.get(x.id) ?? 0).padStart(4, '0')} ${placeOf(x).pos} ${x.id}`;
function sortOrdinal(arr, key) {
  return arr.map((x, i) => [key(x), i, x]).sort((a, b) => ordinal(a[0], b[0]) || a[1] - b[1]).map((e) => e[2]);
}

// New items for one list so it matches the server, given that the file currently equals S.
function updateListFromRemote(st, items, projId, depth) {
  const srv = st.R;
  const base = st.S;
  const posOf = positionMap(st);
  const remove = [];
  const place = [];   // rows to (re)place: moved here, moved within, arriving
  for (const it of [...items]) {
    if (it.kind !== 'task' || !it.id) continue;
    const key = `task:${it.id}`;
    if (!base[key] || !rowPending(st, key)) continue;
    const r = srv[key];
    const s = base[key];
    if (getField(r, 'deleted')?.v || placeOf(r)?.project !== projId) { remove.push(it.id); continue; }
    setItemFromRemote(it, r, s);
    if (!sameValue('place', placeOf(r), placeOf(s))) place.push(r);
  }
  for (const id of remove) { const i = findItem(items, id); if (i >= 0) removeItemKeepChildren(items, i); }
  // tasks the server brought into this list (new, moved in, restored)
  const present = new Set(items.filter((it) => it.kind === 'task' && it.id).map((it) => it.id));
  for (const [key, r] of Object.entries(srv)) {
    if (r.kind !== 'task' || getField(r, 'deleted')?.v || present.has(r.id)) continue;
    const pl = placeOf(r);
    if (!pl || pl.project !== projId) continue;
    const s = base[key];
    if (!s || getField(s, 'deleted')?.v || placeOf(s)?.project !== projId) place.push(r);
  }
  // parents before children, so every task finds its (possibly just placed) parent; siblings by key,
  // anchored only on siblings that are already where they belong
  const unsettled = new Set(place.map((r) => String(r.id)));
  for (const r of sortOrdinal(place, placeOrder(depth))) {
    const id = String(r.id);
    const i = findItem(items, id);
    let block;
    if (i >= 0) block = items.splice(i, subtreeEnd(items, i) - i);
    else block = [itemFromRow(r, 0)];
    const pl = placeOf(r);
    addBlockByPosition(items, block, pl.parent, String(pl.pos), posOf, id, unsettled);
    unsettled.delete(id);
  }
  return items;
}

function newListFromRows(st, projId, depth) {
  const items = [];
  const rows = Object.values(st.R).filter((r) => r.kind === 'task' && !getField(r, 'deleted')?.v && placeOf(r)?.project === projId);
  const posOf = positionMap(st);
  for (const r of sortOrdinal(rows, placeOrder(depth))) {
    const pl = placeOf(r);
    addBlockByPosition(items, [itemFromRow(r, 0)], pl.parent, String(pl.pos), posOf, String(r.id));
  }
  return formatItems(items);
}

// `self`: the list being renamed, which may hold the name already (a case-only rename on macOS). `from`: for a list
// shared with this computer, its server's short name (pairing.js serverLabel): a name another list has becomes
// "Groceries (from nuca)" before it gets a number.
export function uniqueFileName(listsDir, name, reserved, self = '', from = '') {
  const taken = (x) => reserved.has(x.toLowerCase()) || (x.toLowerCase() !== self.toLowerCase() && existsSync(join(listsDir, `${x}.md`)));
  let base = toFileName(name);
  if (from && taken(base)) base = toFileName(`${name} (from ${from})`);
  let n = base;
  for (let i = 2; taken(n); i++) n = `${base} (${i})`;
  reserved.add(n.toLowerCase());
  return n;
}
const stem = (p) => basename(p).replace(/\.md$/, '');

/** A view-only shared list (strict): task lines that are not live tasks of it on the server go. */
function dropUnknownTasks(items, srv, projId) {
  for (const it of [...items]) {
    if (it.kind !== 'task' || !it.id) continue;
    const r = srv[`task:${it.id}`];
    if (r && !getField(r, 'deleted')?.v && placeOf(r)?.project === projId) continue;
    const i = findItem(items, it.id);
    if (i >= 0) removeItemKeepChildren(items, i);
  }
}

/**
 * The plan that makes the lists match R; null when some list is not usable right now (retry later).
 * scope = { project, file, readOnly, label } (a shared list's engine): only that list; its file comes back if it is
 * gone while the list is shared, and a view-only list's file is made to match the server exactly (task lines).
 * label: its server's short name, for a rename onto a name another list has.
 */
export function remotePlan(st, local, listsDir, scope = null) {
  const plan = { ops: [], files: {}, setting: null };
  if (!local.ok) return null;
  if (local.names.some((n) => local.files[n].status !== 'ok')) return null;
  const srv = st.R;
  const base = st.S;
  const fileOf = { ...st.Files };
  // (every list in the folder, also those of other engines: a new or renamed file never takes one of their names)
  const reserved = new Set((local.all ?? local.names).map((n) => n.toLowerCase()));
  const creates = [];
  const writes = [];
  const after = [];
  let depthCache = null;
  const depth = () => (depthCache ??= rowDepthMap(st));

  // ---- projects
  let orderChanged = false;
  for (const [key, r] of Object.entries(srv)) {
    if (r.kind !== 'project' || (scope && r.id !== scope.project)) continue;
    const recreate = scope && !getField(r, 'deleted')?.v && !Object.hasOwn(local.files, fileOf[r.id] ?? scope.file);
    if (!rowPending(st, key) && !recreate) continue;
    if (!scope) orderChanged = true;
    const s = base[key];
    const id = r.id;
    const live = !getField(r, 'deleted')?.v;
    const wasLive = s && !getField(s, 'deleted')?.v;
    const file = fileOf[id];
    const exists = file && Object.hasOwn(local.files, file);
    if (live && !exists) {
      const n = scope ? (file ?? scope.file) : uniqueFileName(listsDir, String(getField(r, 'name')?.v ?? ''), reserved);
      creates.push({ type: 'create', path: join(listsDir, `${n}.md`), text: newListFromRows(st, id, depth()) });
      fileOf[id] = n; plan.files[id] = n;
      if (scope) orderChanged = true;
    } else if (!live && exists && wasLive) {
      // only the list as it is now: anything typed into it meanwhile stops the plan instead of going to .trash
      after.push({ type: 'trash', path: join(listsDir, `${file}.md`), name: file, expected: local.files[file].text });
      plan.files[id] = null; delete fileOf[id];
    } else if (live && exists && s && String(getField(r, 'name')?.v ?? '') !== String(getField(s, 'name')?.v ?? '')) {
      const target = toFileName(String(getField(r, 'name')?.v ?? ''));
      if (target !== file) {
        reserved.delete(file.toLowerCase());
        const n = uniqueFileName(listsDir, target, reserved, file, scope?.label ?? '');
        after.push({ type: 'rename', from: join(listsDir, `${file}.md`), to: join(listsDir, `${n}.md`) });
        fileOf[id] = n; plan.files[id] = n;
        if (scope) orderChanged = true;   // (the tab keeps its place under its new name)
      }
    }
  }

  // ---- tasks, list by list (only lists that exist now; created ones were generated whole above)
  const needs = new Set();
  for (const [key, r] of Object.entries(srv)) {
    if (r.kind !== 'task' || !rowPending(st, key)) continue;
    for (const row of [r, base[key]]) { const p = placeOf(row); if (p) needs.add(p.project); }
  }
  for (const name of local.names) {
    const projId = Object.keys(st.Files).find((k) => st.Files[k] === name);
    const strict = !!scope?.readOnly && projId === scope.project;
    if (!projId || (!needs.has(projId) && !strict)) continue;
    if (Object.hasOwn(plan.files, projId) && plan.files[projId] == null) continue;   // being trashed
    const f = local.files[name];
    const lines = parseItems(f.text);
    if (strict) dropUnknownTasks(lines, srv, projId);
    const items = updateListFromRemote(st, lines, projId, depth());
    const text = formatItems(items, 0, detectEol(f.text));
    if (text !== f.text) {
      // lists that gain tasks are written before lists that lose them: an interrupted plan can then
      // only leave a duplicate behind, never lose a task
      const op = { type: 'write', path: f.path, expected: f.text, text };
      const had = new Set(parseItems(f.text).filter((it) => it.kind === 'task' && it.id).map((it) => it.id));
      if (items.some((it) => it.kind === 'task' && it.id && !had.has(it.id))) writes.unshift(op); else writes.push(op);
    }
  }

  plan.ops.push(...creates, ...writes, ...after);
  if (orderChanged) {
    // list names after this plan; the server's order for projects it knows, local-only lists keep their slots
    const gone = new Set(after.filter((o) => o.type === 'trash').map((o) => o.name));
    const renamed = new Map(after.filter((o) => o.type === 'rename').map((o) => [stem(o.from), stem(o.to)]));
    // every list keeps its slot, also those another engine syncs (only this engine's own are put in order)
    const names = (local.all ?? local.names).filter((n) => !gone.has(n)).map((n) => renamed.get(n) ?? n);
    for (const o of creates) if (!names.includes(stem(o.path))) names.push(stem(o.path));
    const idOfName = new Map(Object.entries(fileOf).map(([k, v]) => [v, k]));
    const known = [];
    names.forEach((n, i) => {
      const pid = idOfName.get(n);
      if (pid && srv[`project:${pid}`]) known.push({ slot: i, name: n, key: String(getField(srv[`project:${pid}`], 'pos')?.v ?? ''), id: pid });
    });
    const sorted = sortOrdinal(known, (x) => `${x.key} ${x.id}`);   // space sorts below every key character
    known.forEach((k, i) => { names[k.slot] = sorted[i].name; });
    plan.ops.push({ type: 'order', path: join(listsDir, '.order'), names });
  }
  if (rowPending(st, 'setting:notifyAt') && !scope) plan.setting = String(getField(srv['setting:notifyAt'], 'value')?.v ?? '');
  return plan;
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Executes plan ops in order after checking every precondition (all or nothing). Returns ops done, -1 if stale. */
export function invokePlanOps(ops, listsDir) {
  for (const o of ops) {
    if (o.type === 'write' && readText(o.path) !== o.expected) return -1;
    if (o.type === 'create' && existsSync(o.path)) return -1;
    if (o.type === 'rename' && (!existsSync(o.from) || (existsSync(o.to) && o.from.toLowerCase() !== o.to.toLowerCase()))) return -1;
    if (o.type === 'trash' && (!existsSync(o.path) || (o.expected != null && readText(o.path) !== o.expected))) return -1;
  }
  // stage every new file content first; if that fails nothing has changed yet
  const staged = new Map();
  try {
    for (const o of ops) if (o.type === 'write' || o.type === 'create') staged.set(o.path, writeTemp(o.path, o.text));
  } catch {
    for (const t of staged.values()) try { unlinkSync(t); } catch { /* gone */ }
    return 0;
  }
  let done = 0;
  for (const o of ops) {
    try {
      if (o.type === 'write' || o.type === 'create') { completeTemp(staged.get(o.path), o.path); staged.delete(o.path); }
      else if (o.type === 'rename') {
        if (o.from.toLowerCase() === o.to.toLowerCase()) {
          // case-only rename (macOS file systems ignore case): go through a temporary name
          const mid = `${o.to}.renaming`; renameSync(o.from, mid); renameSync(mid, o.to);
        } else renameSync(o.from, o.to);
      } else if (o.type === 'trash') {
        const trash = join(listsDir, '.trash');
        mkdirSync(trash, { recursive: true });
        renameSync(o.path, join(trash, `${o.name}-${stamp()}.md`));
      } else if (o.type === 'order') writeAtomic(o.path, `${o.names.join('\n')}\n`);
      done++;
    } catch {
      for (const t of staged.values()) try { unlinkSync(t); } catch { /* gone */ }
      return done;
    }
  }
  return done;
}

// ================================================================ one sync cycle
/** Forget everything synced: the next cycle is a first sync (pull all, then merge the lists in again). */
function startOver(st) {
  st.R = {}; st.S = {}; st.cursor = 0; st.Outbox.length = 0; st.Planned = {}; st.Missing = {}; st.Guard = null;
}

// ---------------------------------------------------------------- shared lists: what was not saved
const NOTICE_FIELDS = ['text', 'status', 'due', 'notes'];
function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
/** Keeps a change the server of a shared list will not take (st.Notices), once per task, field and value. */
function addNotice(st, file, entry, field, value, reason) {
  st.Notices ??= [];
  const text = String(entry.fields.text?.v ?? getField(st.R[`task:${entry.id}`], 'text')?.v ?? getField(st.S[`task:${entry.id}`], 'text')?.v ?? '');
  const id = `${entry.id}-${field}-${shortHash(JSON.stringify(value ?? null))}`;
  if (st.Notices.some((n) => n.id === id)) return;
  st.Notices.push({ id, task: entry.id, list: file, field, value: copyValue(value ?? null), text, reason, at: Date.now() });
  if (st.Notices.length > 100) st.Notices.splice(0, st.Notices.length - 100);
}
/** One outbox entry -> the notices that keep what it would have changed (moves keep nothing worth showing). */
function noticesFor(st, file, e, reason) {
  if (e.kind !== 'task') return;
  const f = e.fields;
  if (f.place && f.place.base === -1) { addNotice(st, file, e, 'new', f.text?.v ?? '', reason); return; }
  if (f.deleted?.v === true) { addNotice(st, file, e, 'deleted', true, reason); return; }
  for (const name of NOTICE_FIELDS) if (f[name]) addNotice(st, file, e, name, f[name].v, reason);
}
/**
 * A view-only shared list: nothing local is sent. What the lists changed becomes notices, the base forgets tasks
 * the server never had, and the plan that follows puts the file back as the server has it.
 */
function holdReadOnly(st, scope) {
  const reason = 'this shared list is view-only';
  for (const e of st.Outbox) {
    if (e.kind !== 'task') continue;
    // only what differs from the server's copy (after a restart or a restore every line is "new" to the base)
    const r = st.R[`task:${e.id}`];
    const live = r && !getField(r, 'deleted')?.v && placeOf(r)?.project === scope.project;
    if (!live) { if (e.fields.deleted?.v !== true) addNotice(st, scope.file, e, 'new', e.fields.text?.v ?? '', reason); continue; }
    if (e.fields.deleted?.v === true) { addNotice(st, scope.file, e, 'deleted', true, reason); continue; }
    for (const name of NOTICE_FIELDS) if (e.fields[name] && !sameValue(name, e.fields[name].v, getField(r, name)?.v)) addNotice(st, scope.file, e, name, e.fields[name].v, reason);
  }
  st.Outbox.length = 0;
  for (const key of Object.keys(st.S)) if (!st.R[key]) delete st.S[key];
}

/** Whether a row from the server may land in R: a shared list's server can only send rows of that list. */
function acceptRow(st, row, scope) {
  if (typeof row.id !== 'string') return false;
  if (!scope) return !row.gone;
  if (row.gone) return row.kind === 'task';
  if (!row.fields || typeof row.fields !== 'object') return false;
  if (row.kind === 'project') return row.id === scope.project;
  if (row.kind === 'task') return placeOf(row)?.project === scope.project;
  if (row.kind === 'conflict') return placeOf(st.R[`task:${row.task}`])?.project === scope.project;
  return false;
}

/** A list's text with every task given a new id (a shared list that became one's own: never mixed up with the owner's). */
export function withNewIds(text) {
  const items = parseItems(text);
  for (const it of items) if (it.kind === 'task' && it.id) it.id = newTaskId();
  return formatItems(items, 0, detectEol(text));
}

/**
 * ctx = { state, statePath, listsDir, transport(body) -> { status, data }, deviceId, notifyAt, allowMassDelete,
 *         settleMs, applyPlan(plan) -> true when the whole plan was applied, clock() -> ms (tests),
 *         view (readLocalLists), scope = { project, file, readOnly } (a shared list's engine), expected (Set) }
 * Returns { status: 'synced'|'offline'|'error'|'auth', message, guarded, retry, sent, received, refused, access,
 * api, workerVersion } (the last two: of one's own server, not a shared list's).
 */
export async function syncCycle(ctx) {
  const st = ctx.state;
  const clock = ctx.clock ?? Date.now;
  const scope = ctx.scope ?? null;
  const res = { status: 'synced', message: '', guarded: 0, retry: false, sent: 0, received: 0, refused: [], access: null };
  const local = readLocalLists(ctx.listsDir, ctx.settleMs ?? 1500, ctx.view ?? null);
  if (scope) st.Files[scope.project] = scope.file;
  const firstSync = Object.keys(st.S).length === 0;   // nothing reconciled yet: pull everything first
  const opts = { scope, expected: ctx.expected ?? null };
  let diff = null;
  if (!firstSync) {
    diff = addLocalDiff(st, local, ctx.notifyAt, ctx.allowMassDelete, clock(), opts);
    if (scope?.readOnly) holdReadOnly(st, scope);
    res.guarded = diff.guarded;
    if (diff.stamp.length) { ctx.applyPlan({ ops: diff.stamp, files: {}, setting: null, stamp: true }); res.retry = true; }
    if (diff.skipped) res.retry = true;
    saveState(st, ctx.statePath);
  }
  // send the outbox (in chunks) and pull everything new
  for (let round = 0; round < 40; round++) {
    // (server limit per request; copies: the acknowledgement below edits the outbox entries, not what was sent,
    // which the answer's refusals are read from: notices, a lost project)
    const batch = st.Outbox.slice(0, 100).map((e) => structuredClone(e));
    const sentAt = Date.now();
    let r;
    try {
      r = await ctx.transport({ deviceId: ctx.deviceId, cursor: Number(st.cursor), changes: batch });
    } catch (e) {
      res.status = 'offline'; res.message = String(e?.message ?? e);
      return res;
    }
    if (r.status === 401) {
      res.status = 'auth';
      res.message = scope ? 'The owner stopped sharing this list.' : 'The server rejected the sync token. Pair this computer again.';
      return res;
    }
    if (r.status !== 200 || !r.data) { res.status = 'error'; res.message = `Server error ${r.status}`; return res; }
    const d = r.data;
    // which release the server is (Workers before 1.1.0 do not say: API 1), for "your sync service is not updated yet"
    if (!scope) { res.api = Number.isInteger(d.api) ? d.api : 1; res.workerVersion = typeof d.version === 'string' ? d.version : ''; }
    if (scope && ['edit', 'view'].includes(d.share?.access)) res.access = d.share.access;
    if (!scope && Array.isArray(d.shared)) st.Shared = d.shared.filter((x) => typeof x === 'string');   // this computer's lists others have
    st.clockOffset = Math.round(Number(d.serverTime) - (sentAt + Date.now()) / 2);
    if (d.restored || Number(d.cursor) < Number(st.cursor)) {
      // the server went back in time (restored from a backup): start over like a first sync. The lists keep
      // their content and are merged in again; resending the old base would undo what the restore brought back
      startOver(st);
      saveState(st, ctx.statePath);
      res.retry = true;
      return res;
    }
    if (st.dbId && d.dbId && d.dbId !== st.dbId) {
      // the server database was recreated (or this computer moved to another server): push everything again
      st.Outbox.length = 0; st.R = {}; st.cursor = 0;
      for (const row of Object.values(st.S)) {
        if (row.kind === 'conflict') continue;
        const fields = {};
        for (const [n, f] of Object.entries(row.fields)) fields[n] = { v: f.v, ts: Number(f.ts), base: -1 };
        const e = { kind: row.kind, id: row.id, fields };
        if (row.kind === 'project') st.Outbox.unshift(e); else st.Outbox.push(e);
      }
      st.dbId = d.dbId;
      continue;
    }
    st.dbId = d.dbId;
    // acknowledge what was sent (unless it changed again since)
    for (const sent of batch) {
      const cur = st.Outbox.find((e) => e.kind === sent.kind && e.id === sent.id);
      if (!cur) continue;
      for (const n of Object.keys(sent.fields)) if (cur.fields[n] && Number(cur.fields[n].ts) === Number(sent.fields[n].ts)) delete cur.fields[n];
      if (!Object.keys(cur.fields).length) st.Outbox.splice(st.Outbox.indexOf(cur), 1);
    }
    for (const row of d.changes ?? []) {
      if (!row || !acceptRow(st, row, scope)) continue;
      const key = `${row.kind}:${row.id}`;
      if (row.gone) {
        // the owner moved it into a list this computer does not share: it leaves this one like a delete
        const s = st.S[key] ?? st.R[key];
        if (s) { const g = copyRow(s); g.fields.deleted = { v: true, ts: Number(getField(s, 'deleted')?.ts ?? 0) + 1 }; st.R[key] = g; }
      } else st.R[key] = row;
      res.received++;
    }
    for (const rej of d.rejected ?? []) {
      if (!rej) continue;
      if (scope && rej.reason !== 'unknown task') {
        // a shared list's server refused it (view-only by now, or the owner deleted the list): kept as a notice
        const e = batch.find((b) => b.kind === rej.kind && b.id === rej.id);
        if (e) noticesFor(st, scope.file, rej.field ? { ...e, fields: { [rej.field]: e.fields[rej.field] } } : e, rej.reason);
        res.refused.push(`${rej.kind} ${rej.id}: ${rej.reason}`);
        continue;
      }
      if (rej.reason === 'unknown task' || rej.reason === 'unknown project') {
        // the server lost it: forget the base so the next diff sends it again as a fresh create (a project
        // keeps its id through the file mapping)
        delete st.S[`${rej.kind}:${rej.id}`];
        if (rej.kind === 'task' && rej.reason === 'unknown project') {
          for (const e of batch) {
            if (e.kind === 'task' && e.id === rej.id && e.fields.place) {
              const pr = e.fields.place.v?.project;
              if (pr && !st.R[`project:${pr}`]) delete st.S[`project:${pr}`];
            }
          }
        }
        res.retry = true;
      } else res.refused.push(`${rej.kind} ${rej.id}: ${rej.reason}`);
    }
    res.sent += batch.length;
    st.cursor = Number(d.cursor);
    saveState(st, ctx.statePath);
    if (!d.more && st.Outbox.length === 0) break;
  }
  if (firstSync && !(local.ok && local.names.length === 0)) {
    // first contact: pulled the server's lists first, now merge ours in (adopting its projects by name)
    const d2 = addLocalDiff(st, local, ctx.notifyAt, ctx.allowMassDelete, clock(), opts);
    if (scope?.readOnly) holdReadOnly(st, scope);
    if (d2.stamp.length) ctx.applyPlan({ ops: d2.stamp, files: {}, setting: null, stamp: true });
    saveState(st, ctx.statePath);
    res.retry = true;
    return res;
  }
  // (an empty folder on first contact gets the server's lists right away, below)

  // remote -> files: never in a cycle that left a list out (its local edits are not in the base yet, so
  // the plan would treat them as already synced), and only if no list changed since we read them. A folder
  // without lists sends nothing (it may be one that is not there right now), but does receive.
  if (diff?.skipped && !diff.empty) { res.retry = true; return res; }
  const fresh = readLocalLists(ctx.listsDir, 0, ctx.view ?? null);
  if (fresh.names.length !== local.names.length || fresh.names.some((n) => !local.files[n] || local.files[n].text !== fresh.files[n].text)) {
    res.retry = true; return res;
  }
  const plan = remotePlan(st, fresh, ctx.listsDir, scope);
  if (!plan) { res.retry = true; return res; }
  if (plan.ops.length || plan.setting != null) {
    if (!ctx.applyPlan(plan)) { res.retry = true; return res; }
    for (const [k, v] of Object.entries(plan.files)) { if (v == null) delete st.Files[k]; else st.Files[k] = v; }
  }
  // the lists now reflect R
  const waiting = new Set(st.Outbox.map((e) => `${e.kind}:${e.id}`));
  if (plan.ops.length) notePlanned(st, waiting, clock());
  for (const [key, r] of Object.entries(st.R)) {
    if (r.kind === 'conflict' || waiting.has(key)) continue;
    st.S[key] = copyRow(r);
  }
  saveState(st, ctx.statePath);
  return res;
}

/** Applies a plan to the folder: true when every op was done. */
export function applyPlanToFolder(plan, listsDir) {
  return invokePlanOps(plan.ops, listsDir) === plan.ops.length;
}

export function openConflicts(st) {
  return Object.values(st.R).filter((c) => c.kind === 'conflict' && !getField(c, 'resolved')?.v && st.R[`task:${c.task}`]);
}
