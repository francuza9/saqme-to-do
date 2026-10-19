// Pure merge rules for the sync protocol (no I/O). See docs/sync.md.
//
// Rows travel as { kind, id, seq, fields: { <name>: { v, ts } } }. Clients send changes as
// { kind, id, fields: { <name>: { v, ts, base } } } where `base` is the ts of the version they edited.
//  - base === current ts      -> sequential edit, the change simply applies
//  - otherwise (concurrent)   -> newest ts wins; for content fields the loser is kept as a conflict
//  - edit vs delete           -> the newer action wins (a newer edit resurrects, an older one stays deleted)
//  - moves (place)            -> refused if they would make a task its own ancestor

import { isValidKey } from '../public/js/keys.js';
import { cleanText as normalizeText, cleanNotes as normalizeNotes, isValidDate } from '../public/js/markdown.js';

export const STATUSES = [' ', '/', 'x', '>', '!', '-', '~'];
export const CONTENT_FIELDS = ['text', 'status', 'due', 'notes'];
export const SETTING_KEYS = ['notifyAt', 'tz'];
export const MAX_TEXT = 10_000;
export const MAX_NOTES = 50_000;
export const MAX_NAME = 120;
export const MAX_CONFLICTS_PER_BATCH = 500;   // < sync PAGE; one per conflicting field at most

const ID_RE = /^[0-9a-z]{8,32}$/;
const CONFLICT_ID_RE = /^c[0-9a-z]{8,32}-[a-z]+-[0-9a-z]{1,12}(-[0-9a-z]{1,8})?$/;
const KIND_ORDER = { project: 0, setting: 1, task: 2, conflict: 3 };

const FIELDS = {
  task: ['place', 'text', 'status', 'due', 'notes', 'deleted'],
  project: ['name', 'pos', 'deleted'],
  setting: ['value'],
  conflict: ['resolved'],
};

export function emptyRow(kind, id) {
  const f = (v) => ({ v, ts: 0 });
  if (kind === 'task') {
    return { kind, id, seq: 0, fields: {
      place: f(null), text: f(''), status: f(' '), due: f(null), notes: f(''), deleted: f(false) } };
  }
  if (kind === 'project') return { kind, id, seq: 0, fields: { name: f(''), pos: f('a0'), deleted: f(false) } };
  if (kind === 'setting') return { kind, id, seq: 0, fields: { value: f('') } };
  return { kind, id, seq: 0, fields: { resolved: f(false) } };
}

// ---------------------------------------------------------------- value normalization
export function normalizeTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${+m[1]}:${m[2]}`;
}

// dates, task text and notes: the rules every app applies (public/js/markdown.js, shared/fixtures/text.json)
export { isValidDate, normalizeText, normalizeNotes };

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Returns { v } with the normalized value, or { error }. */
export function normalizeValue(kind, field, v) {
  if (kind === 'task') {
    switch (field) {
      case 'place': {
        if (!v || typeof v !== 'object') return { error: 'place must be an object' };
        const parent = v.parent ?? null;
        if (!ID_RE.test(v.project ?? '')) return { error: 'bad project id' };
        if (parent !== null && !ID_RE.test(parent)) return { error: 'bad parent id' };
        if (!isValidKey(v.pos)) return { error: 'bad position key' };
        return { v: { project: v.project, parent, pos: v.pos } };
      }
      case 'text': {
        if (typeof v !== 'string') return { error: 'text must be a string' };
        const t = normalizeText(v);
        return t.length > MAX_TEXT ? { error: 'text too long' } : { v: t };
      }
      case 'status': {
        const s = v === 'X' ? 'x' : v;
        return STATUSES.includes(s) ? { v: s } : { error: 'bad status' };
      }
      case 'due': {
        if (v === null || v === undefined || v === '') return { v: null };
        if (typeof v !== 'object' || !isValidDate(v.date)) return { error: 'bad due date' };
        const time = v.time ? normalizeTime(v.time) : '';
        if (time === null) return { error: 'bad due time' };
        return { v: { date: v.date, time } };
      }
      case 'notes': {
        if (typeof v !== 'string') return { error: 'notes must be a string' };
        const n = normalizeNotes(v);
        return n.length > MAX_NOTES ? { error: 'notes too long' } : { v: n };
      }
      case 'deleted':
        return typeof v === 'boolean' ? { v } : { error: 'deleted must be boolean' };
    }
  } else if (kind === 'project') {
    switch (field) {
      case 'name': {
        if (typeof v !== 'string') return { error: 'name must be a string' };
        const n = normalizeText(v);
        if (!n) return { error: 'empty name' };
        return n.length > MAX_NAME ? { error: 'name too long' } : { v: n };
      }
      case 'pos':
        return isValidKey(v) ? { v } : { error: 'bad position key' };
      case 'deleted':
        return typeof v === 'boolean' ? { v } : { error: 'deleted must be boolean' };
    }
  } else if (kind === 'setting') {
    if (typeof v !== 'string' || v.length > 200) return { error: 'bad setting value' };
    return { v };
  } else if (kind === 'conflict') {
    return typeof v === 'boolean' ? { v } : { error: 'resolved must be boolean' };
  }
  return { error: `unknown field ${kind}.${field}` };
}

function validId(kind, id) {
  if (typeof id !== 'string') return false;
  if (kind === 'setting') return SETTING_KEYS.includes(id);
  if (kind === 'conflict') return CONFLICT_ID_RE.test(id);
  return ID_RE.test(id);
}

/**
 * Validates and normalizes one client change; clamps timestamps to `now`. A bad field is dropped on its
 * own (listed in fieldErrors) so the valid fields of the same change still apply.
 */
export function normalizeChange(raw, now) {
  if (!raw || typeof raw !== 'object') return { error: 'change must be an object' };
  const { kind, id } = raw;
  if (!FIELDS[kind]) return { error: 'unknown kind' };
  if (!validId(kind, id)) return { error: 'bad id' };
  if (!raw.fields || typeof raw.fields !== 'object') return { error: 'missing fields' };
  const fields = {};
  const fieldErrors = [];
  for (const [name, f] of Object.entries(raw.fields)) {
    let err = null;
    if (!FIELDS[kind].includes(name)) err = 'unknown field';
    else if (!f || typeof f !== 'object' || !Number.isSafeInteger(f.ts) || f.ts < 0) err = 'bad ts';
    let nv = err ? null : normalizeValue(kind, name, f.v);
    if (nv?.error) err = nv.error;
    else if (!err && kind === 'setting' && id === 'notifyAt' && normalizeTime(nv.v) === null) err = 'notifyAt must be H:MM';
    else if (!err && kind === 'setting' && id === 'tz' && !isValidTimeZone(nv.v)) err = 'unknown time zone';
    if (err) { fieldErrors.push({ field: name, reason: `${name}: ${err}` }); continue; }
    const base = Number.isSafeInteger(f.base) ? f.base : -1;
    fields[name] = { v: kind === 'setting' && id === 'notifyAt' ? normalizeTime(nv.v) : nv.v, ts: Math.min(f.ts, now), base };
  }
  if (!Object.keys(fields).length) return { error: fieldErrors[0]?.reason ?? 'no fields', fieldErrors };
  return { kind, id, fields, fieldErrors };
}

// ---------------------------------------------------------------- field merge
export function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * cur = { v, ts, dev? } (ts 0 = never set; dev = device that wrote it), inc = { v, ts, base }.
 * Returns { take, ts, conflict: null | { loser, winner } }.
 */
export function mergeField(cur, inc, deviceId) {
  if (!cur || cur.ts === 0) return { take: true, ts: Math.max(inc.ts, 1), conflict: null };
  if (inc.base === cur.ts) {
    // the client edited exactly what we have: a plain successor, even if its clock lags
    return { take: true, ts: Math.max(inc.ts, cur.ts + 1), conflict: null };
  }
  if (deviceId && cur.dev === deviceId) {
    // nobody else wrote this field since this device did (e.g. a resend after a lost response):
    // plain last-writer-wins, never a conflict with yourself
    return { take: inc.ts >= cur.ts, ts: inc.ts, conflict: null };
  }
  if (sameValue(cur.v, inc.v)) return { take: inc.ts > cur.ts, ts: Math.max(inc.ts, cur.ts), conflict: null };
  const incWins = inc.ts > cur.ts || (inc.ts === cur.ts && JSON.stringify(inc.v) > JSON.stringify(cur.v));
  if (incWins) return { take: true, ts: inc.ts, conflict: { loser: cur, winner: inc } };
  return { take: false, ts: cur.ts, conflict: { loser: inc, winner: cur } };
}

function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Same losing edit -> same id (a resend is deduplicated); a different losing value never collides. */
export function conflictId(taskId, field, loserTs, loserValue) {
  return `c${taskId}-${field}-${Math.max(0, loserTs).toString(36)}-${shortHash(JSON.stringify(loserValue ?? null))}`;
}

function makeConflict(taskId, field, loser, winner, deviceId, now) {
  return {
    kind: 'conflict', id: conflictId(taskId, field, loser.ts, loser.v), seq: 0,
    task: taskId, field, value: loser.v, valueTs: loser.ts, other: winner.v, device: deviceId, at: now,
    fields: { resolved: { v: false, ts: now } },
  };
}

// ---------------------------------------------------------------- batch apply
/**
 * state = { rows: Map('kind:id' -> row), parents: Map(taskId -> parentId|null) }
 * (rows must contain every row referenced by the changes plus all projects; parents must contain
 * the ancestor chains of every parent referenced by a place change).
 * Mutates state, returns { touched: Map(key -> row), conflicts: [], rejected: [] }.
 */
export function applyChanges(state, changes, { now, deviceId = '' }) {
  const out = { touched: new Map(), conflicts: [], rejected: [] };
  const ordered = changes
    .map((c, i) => ({ c, i, k: KIND_ORDER[c?.kind] ?? 9 }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.c);
  for (const raw of ordered) {
    const ch = normalizeChange(raw, now);
    const key = `${raw?.kind}:${raw?.id}`;
    if (ch.error || ch.fieldErrors?.length) {
      for (const fe of ch.fieldErrors ?? []) out.rejected.push({ kind: raw?.kind, id: raw?.id, field: fe.field, reason: fe.reason });
      if (!ch.fieldErrors?.length) out.rejected.push({ kind: raw?.kind, id: raw?.id, reason: ch.error });
      // send the canonical row back, so the device drops the value it could not save
      if (state.rows.has(key)) out.touched.set(key, state.rows.get(key));
      if (ch.error) continue;
    }
    const existing = state.rows.get(key);
    const row = existing ? structuredClone(existing) : emptyRow(ch.kind, ch.id);
    const isNew = !existing;
    if (isNew && ch.kind === 'task' && !ch.fields.place) {
      // a create whose place was invalid stays rejected for that reason (resending it would not help)
      if (!ch.fieldErrors.some((f) => f.field === 'place')) out.rejected.push({ kind: ch.kind, id: ch.id, reason: 'unknown task' });
      continue;
    }
    if (isNew && ch.kind === 'project' && !ch.fields.name) { out.rejected.push({ kind: ch.kind, id: ch.id, reason: 'unknown project' }); continue; }
    if (isNew && ch.kind === 'conflict') { out.rejected.push({ kind: ch.kind, id: ch.id, reason: 'unknown conflict' }); continue; }
    if (isNew) row.createdAt = now;

    if (ch.kind === 'task') {
      const res = applyTask(state, row, ch, isNew, out, deviceId, now);
      if (res === 'reject') continue;
    } else {
      for (const [name, inc] of Object.entries(ch.fields)) {
        const r = mergeField(row.fields[name], inc);
        if (r.take) row.fields[name] = { v: inc.v, ts: r.ts };
      }
    }
    state.rows.set(key, row);
    out.touched.set(key, row);
  }
  return out;
}

function wouldCycle(state, id, parent) {
  const seen = new Set();
  for (let cur = parent; cur; cur = state.parents.get(cur) ?? null) {
    if (cur === id || seen.has(cur)) return true;
    seen.add(cur);
  }
  return false;
}

function applyTask(state, row, ch, isNew, out, deviceId, now) {
  const f = ch.fields;
  let incActionTs = 0;

  if (f.place) {
    const p = f.place.v;
    const project = state.rows.get(`project:${p.project}`);
    let reason = null;
    if (!project) reason = 'unknown project';
    else if (p.parent === row.id || wouldCycle(state, row.id, p.parent)) reason = 'move would create a cycle';
    if (reason) {
      if (isNew) { out.rejected.push({ kind: 'task', id: row.id, reason }); return 'reject'; }
      out.rejected.push({ kind: 'task', id: row.id, field: 'place', reason });
    } else {
      const r = mergeField(row.fields.place, f.place, deviceId);
      if (r.take) {
        row.fields.place = { v: p, ts: r.ts, dev: deviceId };
        state.parents.set(row.id, p.parent);
      }
      incActionTs = Math.max(incActionTs, f.place.ts);
    }
  }

  for (const name of CONTENT_FIELDS) {
    const inc = f[name];
    if (!inc) continue;
    const r = mergeField(row.fields[name], inc, deviceId);
    if (r.take) row.fields[name] = { v: inc.v, ts: r.ts, dev: deviceId };
    if (r.conflict && !isNew && out.conflicts.length < MAX_CONFLICTS_PER_BATCH) out.conflicts.push(makeConflict(row.id, name, r.conflict.loser, r.conflict.winner, deviceId, now));
    incActionTs = Math.max(incActionTs, inc.ts);
  }

  const del = row.fields.deleted;
  if (f.deleted) {
    const inc = f.deleted;
    const lastByOthers = Math.max(0, ...['place', ...CONTENT_FIELDS]
      .filter((n) => !deviceId || row.fields[n].dev !== deviceId).map((n) => row.fields[n].ts));
    if (inc.v === true && !isNew && lastByOthers > inc.ts && !del.v) {
      // someone acted on the task after this delete was issued: the newer action wins
      out.conflicts.push(makeConflict(row.id, 'deleted', { v: true, ts: inc.ts }, { v: false, ts: lastByOthers }, deviceId, now));
    } else {
      const r = mergeField(del, inc, deviceId);
      if (r.take) row.fields.deleted = { v: inc.v, ts: r.ts, dev: deviceId };
    }
  } else if (del.v && incActionTs > del.ts) {
    // an edit newer than the delete brings the task back
    out.conflicts.push(makeConflict(row.id, 'deleted', { v: true, ts: del.ts }, { v: false, ts: incActionTs }, deviceId, now));
    row.fields.deleted = { v: false, ts: incActionTs, dev: deviceId };
  }

  // same rule one level up: acting on a task in a deleted project after the delete restores the project
  const projKey = `project:${row.fields.place.v?.project}`;
  const proj = state.rows.get(projKey);
  if (proj && proj.fields.deleted.v && !row.fields.deleted.v && incActionTs > proj.fields.deleted.ts) {
    const p2 = structuredClone(proj);
    p2.fields.deleted = { v: false, ts: incActionTs };
    state.rows.set(projKey, p2);
    out.touched.set(projKey, p2);
  }
  return 'ok';
}
