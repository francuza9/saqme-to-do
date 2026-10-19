// Pure task-tree helpers shared by the PWA UI and its tests (no DOM, no storage).
// A task row: { id, fields: { place: { v: { project, parent, pos } }, text, status, due, notes, deleted } }.

import { cmpPos, keyBetween, rekey } from './keys.js';

export const STATUSES = [
  { mark: ' ', name: 'To do', key: 'todo' },
  { mark: '/', name: 'In progress', key: 'prog' },
  { mark: 'x', name: 'Done', key: 'done' },
  { mark: '>', name: 'Postponed', key: 'post' },
  { mark: '!', name: 'Blocked / waiting', key: 'block' },
  { mark: '-', name: 'Failed / rejected', key: 'rej' },
  { mark: '~', name: 'Abandoned', key: 'aband' },
];
export const statusOf = (mark) => STATUSES.find((s) => s.mark === mark) ?? STATUSES[0];

/** 0 = active (manual order), 1 = postponed (listed at the bottom), 2 = closed (folded into Completed). */
export function rank(mark) {
  if (mark === 'x' || mark === '-' || mark === '~') return 2;
  return mark === '>' ? 1 : 0;
}
export const isOpenStatus = (mark) => mark === ' ' || mark === '/' || mark === '!';

const place = (t) => t.fields.place.v;
const live = (t) => t && !t.fields.deleted.v;

/**
 * Builds the visible tree of one project. A task whose parent is gone (deleted, moved to another
 * project, unknown) hangs under its nearest live ancestor in the project, or at the root.
 * Returns { roots, byId } with nodes { task, id, parent, kids, depth }.
 */
export function buildTree(tasks, projectId) {
  const all = new Map();
  for (const t of tasks) all.set(t.id, t);
  const byId = new Map();
  for (const t of all.values()) {
    if (live(t) && place(t).project === projectId) byId.set(t.id, { task: t, id: t.id, parent: null, kids: [], depth: 0 });
  }
  const eff = new Map();   // id -> effective parent id
  for (const node of byId.values()) {
    let p = place(node.task).parent;
    const seen = new Set([node.id]);
    while (p && !byId.has(p)) {
      const pt = all.get(p);
      if (!pt || seen.has(p) || place(pt).project !== projectId) { p = null; break; }
      seen.add(p);
      p = place(pt).parent;
    }
    eff.set(node.id, p ?? null);
  }
  // break cycles (the server refuses them, this only guards against corrupt data)
  for (const id of eff.keys()) {
    const path = new Set([id]);
    for (let prev = id, q = eff.get(id); q; prev = q, q = eff.get(q)) {
      if (path.has(q)) { eff.set(prev, null); break; }
      path.add(q);
    }
  }
  const roots = [];
  for (const node of byId.values()) {
    const p = eff.get(node.id);
    if (p) { node.parent = byId.get(p); node.parent.kids.push(node); } else roots.push(node);
  }
  const byPos = (a, b) => cmpPos(place(a.task).pos, a.id, place(b.task).pos, b.id);
  const sortRec = (list, depth) => {
    list.sort(byPos);
    for (const n of list) { n.depth = depth; sortRec(n.kids, depth + 1); }
  };
  sortRec(roots, 0);
  return { roots, byId };
}

export function subtreeIds(node) {
  const out = [node.id];
  for (const k of node.kids) out.push(...subtreeIds(k));
  return out;
}

export function isAncestor(maybeAncestor, node) {
  for (let p = node.parent; p; p = p.parent) if (p === maybeAncestor) return true;
  return false;
}

/** Siblings list (ordered) of a node, given the tree. */
export const siblingsOf = (tree, node) => (node.parent ? node.parent.kids : tree.roots);

/**
 * Position for inserting into `siblings` (ordered nodes) at index `at` (0..length).
 * Returns { pos, rekeys: [[id, pos], ...] } — rekeys only when neighbours share a key.
 */
export function positionAt(siblings, at, excludeId = null) {
  const list = siblings.filter((n) => n.id !== excludeId);
  at = Math.max(0, Math.min(at, list.length));
  const lo = at > 0 ? place(list[at - 1].task).pos : null;
  const hi = at < list.length ? place(list[at].task).pos : null;
  try {
    const pos = keyBetween(lo, hi);
    if (pos.length <= 48) return { pos, rekeys: [] };
    // keys grow when you keep inserting at the same spot: start this sibling list over with short keys
    let k = null;
    const rekeys = [];
    let fresh = null;
    for (let i = 0; i <= list.length; i++) {
      k = keyBetween(k, null);
      if (i === at) fresh = k;
      else rekeys.push([list[i < at ? i : i - 1].id, k]);
    }
    return { pos: fresh, rekeys };
  } catch {
    // equal or invalid neighbour keys: re-key the whole sibling list with the new slot in place
    const keys = list.map((n) => place(n.task).pos);
    keys.splice(at, 0, null);
    const fresh = rekey(keys);
    const ids = list.map((n) => n.id);
    ids.splice(at, 0, null);
    const rekeys = [];
    let pos = null;
    for (const [i, k] of fresh) {
      if (ids[i] === null) pos = k; else rekeys.push([ids[i], k]);
    }
    return { pos, rekeys };
  }
}

/** Visible order of one project like the desktop renders it: active roots, Postponed, Completed. */
export function sections(tree) {
  const active = [];
  const postponed = [];
  const closed = [];
  for (const n of tree.roots) {
    const r = rank(n.task.fields.status.v);
    (r === 0 ? active : r === 1 ? postponed : closed).push(n);
  }
  return { active, postponed, closed };
}

/** Children in display order: active first, then postponed, then closed (stable within each). */
export function kidsInDisplayOrder(node) {
  return [0, 1, 2].flatMap((r) => node.kids.filter((k) => rank(k.task.fields.status.v) === r));
}

export function progress(node) {
  const done = node.kids.filter((k) => rank(k.task.fields.status.v) === 2).length;
  return { done, total: node.kids.length };
}

export function openCount(tasks, projectId) {
  let n = 0;
  for (const t of tasks) if (live(t) && place(t).project === projectId && t.fields.text.v && isOpenStatus(t.fields.status.v)) n++;
  return n;
}

const LINK_RE = /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/g;
/** Splits note text into [{ text } | { url, text }] parts, like the desktop's clickable links. */
export function linkify(s) {
  const out = [];
  let pos = 0;
  for (const m of s.matchAll(LINK_RE)) {
    if (m.index > pos) out.push({ text: s.slice(pos, m.index) });
    out.push({ url: /^https?:\/\//.test(m[0]) ? m[0] : `https://${m[0]}`, text: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < s.length) out.push({ text: s.slice(pos) });
  return out;
}

// value rules shared with the server and the desktop (markdown.js; shared/fixtures/text.json)
export { cleanProjectName, cleanText, cleanNotes } from './markdown.js';

export function newId(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36];
  return /^[0-9]/.test(s) ? `t${s.slice(1)}` : s;
}
