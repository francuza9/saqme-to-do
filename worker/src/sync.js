// POST /api/sync: apply a client's changes to D1 and return everything changed since its cursor.
//
// Concurrency: D1 has no interactive transactions, so this is optimistic. We read the current `seq`
// together with the affected rows (one batch = one consistent snapshot), merge in JS, then write in one
// batch that first re-inserts meta 'lock' if `seq` moved in the meantime. That violates the primary key,
// D1 rolls the whole batch back, and we retry with fresh rows. Nothing is ever half-applied.

import { applyChanges } from './merge.js';
import * as R from './rows.js';

// Small enough for the Workers free plan (10 ms CPU, 50 D1 queries per request); clients send at most
// MAX_CHANGES per request. PAGE must exceed the rows one batch can touch, so paging always progresses.
export const MAX_CHANGES = 100;
export const PAGE = 600;
const MAX_ATTEMPTS = 3;

const TASK_COLS = ['id', 'project_id', 'parent_id', 'position', 'place_ts', 'text', 'text_ts', 'status', 'status_ts',
  'due', 'due_time', 'due_ts', 'notes', 'notes_ts', 'deleted', 'deleted_ts', 'devs', 'created_at', 'updated_at', 'seq'];
const PROJECT_COLS = ['id', 'name', 'name_ts', 'position', 'position_ts', 'deleted', 'deleted_ts', 'created_at', 'seq'];
const SETTING_COLS = ['key', 'value', 'ts', 'seq'];
const CONFLICT_COLS = ['id', 'task_id', 'field', 'value', 'value_ts', 'other', 'device_id', 'created_at', 'resolved',
  'resolved_ts', 'seq'];

function upsertSql(table, cols, key, { ignore = false } = {}) {
  const sel = cols.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  const head = `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${sel} FROM json_each(?1) WHERE true`;
  if (ignore) return `${head} ON CONFLICT(${key}) DO NOTHING`;
  const upd = cols.filter((c) => c !== key && c !== 'created_at').map((c) => `${c} = excluded.${c}`).join(', ');
  return `${head} ON CONFLICT(${key}) DO UPDATE SET ${upd}`;
}
const SQL = {
  tasks: upsertSql('tasks', TASK_COLS, 'id'),
  projects: upsertSql('projects', PROJECT_COLS, 'id'),
  settings: upsertSql('settings', SETTING_COLS, 'key'),
  conflictsNew: upsertSql('conflicts', CONFLICT_COLS, 'id', { ignore: true }),
  conflictsUpd: upsertSql('conflicts', CONFLICT_COLS, 'id'),
  movedOut: `INSERT INTO moved_out (project_id, task_id, seq) SELECT json_extract(value, '$.project_id'), json_extract(value, '$.task_id'),
    json_extract(value, '$.seq') FROM json_each(?1) WHERE true ON CONFLICT(project_id, task_id) DO UPDATE SET seq = excluded.seq`,
};

const metaMap = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.value]));

/** extraTaskIds: rows a shared list's request is checked against (parents, the tasks of conflicts). */
export async function loadState(db, changes, extraTaskIds = []) {
  const taskIds = new Set(extraTaskIds);
  const parentIds = new Set();
  const conflictIds = new Set();
  for (const c of changes) {
    if (!c || typeof c.id !== 'string') continue;
    if (c.kind === 'task') {
      taskIds.add(c.id);
      const p = c.fields?.place?.v?.parent;
      if (typeof p === 'string') parentIds.add(p);
    } else if (c.kind === 'conflict') conflictIds.add(c.id);
  }
  const [meta, tasks, anc, projects, settings, conflicts] = await db.batch([
    db.prepare(`SELECT key, value FROM meta WHERE key IN ('seq', 'db_id')`),
    db.prepare('SELECT * FROM tasks WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...taskIds])),
    db.prepare(`WITH RECURSIVE anc(id, parent_id) AS (
        SELECT id, parent_id FROM tasks WHERE id IN (SELECT value FROM json_each(?1))
        UNION SELECT t.id, t.parent_id FROM tasks t JOIN anc ON t.id = anc.parent_id)
      SELECT id, parent_id FROM anc`).bind(JSON.stringify([...parentIds, ...taskIds])),
    db.prepare('SELECT * FROM projects'),
    db.prepare('SELECT * FROM settings'),
    db.prepare('SELECT * FROM conflicts WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify([...conflictIds])),
  ]);
  const m = metaMap(meta.results);
  const rows = new Map();
  for (const r of tasks.results) rows.set(`task:${r.id}`, R.taskFromDb(r));
  for (const r of projects.results) rows.set(`project:${r.id}`, R.projectFromDb(r));
  for (const r of settings.results) rows.set(`setting:${r.key}`, R.settingFromDb(r));
  for (const r of conflicts.results) rows.set(`conflict:${r.id}`, R.conflictFromDb(r));
  const parents = new Map(anc.results.map((r) => [r.id, r.parent_id ?? null]));
  return { seq: m.seq ?? '0', dbId: m.db_id ?? '', state: { rows, parents } };
}

export async function writeState(db, expectedSeq, result, now) {
  const seq = Number(expectedSeq) + 1;
  const lists = { tasks: [], projects: [], settings: [], conflictsUpd: [] };
  for (const row of result.touched.values()) {
    if (row.kind === 'task') lists.tasks.push(R.taskToDb(row, seq, now));
    else if (row.kind === 'project') lists.projects.push(R.projectToDb(row, seq, now));
    else if (row.kind === 'setting') lists.settings.push(R.settingToDb(row, seq));
    else if (row.kind === 'conflict') lists.conflictsUpd.push(R.conflictToDb(row, seq));
  }
  const conflictsNew = result.conflicts.map((c) => R.conflictToDb(c, seq));
  const movedOut = (result.movedOut ?? []).map((m) => ({ project_id: m.project, task_id: m.task, seq }));
  const stmts = [
    db.prepare(`INSERT INTO meta (key, value) SELECT 'lock', '1' WHERE (SELECT value FROM meta WHERE key = 'seq') IS NOT ?1`)
      .bind(String(expectedSeq)),
    db.prepare(`UPDATE meta SET value = ?1 WHERE key = 'seq'`).bind(String(seq)),
  ];
  // one statement per ~800 kB of JSON (D1 caps a bound string at 2 MB)
  const push = (sql, list) => {
    let chunk = [];
    let size = 0;
    for (const row of list) {
      const n = JSON.stringify(row).length;
      if (chunk.length && size + n > 800_000) { stmts.push(db.prepare(sql).bind(JSON.stringify(chunk))); chunk = []; size = 0; }
      chunk.push(row); size += n;
    }
    if (chunk.length) stmts.push(db.prepare(sql).bind(JSON.stringify(chunk)));
  };
  for (const [name, list] of Object.entries(lists)) push(SQL[name], list);
  push(SQL.conflictsNew, conflictsNew);
  push(SQL.movedOut, movedOut);
  await db.batch(stmts);
  return seq;
}

/**
 * Every row changed since `cursor`, in pages. scope = { projectId } (a shared list's key): only that project,
 * its tasks and their conflicts, no settings, and for tasks that moved to another project just { gone: true }.
 * extra: statements to run in the same batch; their results come back as `extra`.
 */
export async function loadChangesSince(db, cursor, { scope = null, extra = [] } = {}) {
  const q = (table) => db.prepare(`SELECT * FROM ${table} WHERE seq > ?1 ORDER BY seq LIMIT ?2`).bind(cursor, PAGE + 1);
  const none = db.prepare('SELECT 1 AS seq WHERE 0');
  const queries = scope ? [
    db.prepare('SELECT * FROM tasks WHERE project_id = ?3 AND seq > ?1 ORDER BY seq LIMIT ?2').bind(cursor, PAGE + 1, scope.projectId),
    db.prepare('SELECT * FROM projects WHERE id = ?3 AND seq > ?1 ORDER BY seq LIMIT ?2').bind(cursor, PAGE + 1, scope.projectId),
    none,
    db.prepare(`SELECT c.* FROM conflicts c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ?3 AND c.seq > ?1
                 ORDER BY c.seq LIMIT ?2`).bind(cursor, PAGE + 1, scope.projectId),
    // (a device starting from 0 has nothing to forget)
    db.prepare(`SELECT m.task_id AS id, m.seq FROM moved_out m WHERE m.project_id = ?3 AND m.seq > ?1 AND ?1 > 0
                   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = m.task_id AND t.project_id = ?3)
                 ORDER BY m.seq LIMIT ?2`).bind(cursor, PAGE + 1, scope.projectId),
  ] : [q('tasks'), q('projects'), q('settings'), q('conflicts'), none];
  const [t, p, s, c, g, meta, ...extraResults] = await db.batch([
    ...queries, db.prepare(`SELECT key, value FROM meta WHERE key IN ('seq', 'db_id')`), ...extra,
  ]);
  const m = metaMap(meta.results);
  let upTo = Number(m.seq ?? 0);
  let more = false;
  for (const res of [t, p, s, c, g]) {
    if (res.results.length > PAGE) { more = true; upTo = Math.min(upTo, res.results[PAGE].seq - 1); }
  }
  // keep responses small (CPU and memory on the free plan): stop after ~1.5 MB, at a seq boundary, but
  // always deliver at least the first seq so paging makes progress
  const sizes = new Map();
  for (const res of [t, p, s, c, g]) {
    for (const r of res.results) if (r.seq <= upTo) sizes.set(r.seq, (sizes.get(r.seq) ?? 0) + JSON.stringify(r).length);
  }
  let total = 0;
  for (const seqNo of [...sizes.keys()].sort((a, b) => a - b)) {
    total += sizes.get(seqNo);
    if (total > 1_500_000 && seqNo > Math.min(...sizes.keys())) { upTo = seqNo - 1; more = true; break; }
  }
  const pick = (res, fn) => res.results.filter((r) => r.seq <= upTo).map((r) => R.publicRow(fn(r)));
  // a shared list's people don't learn which of the owner's devices recorded a conflict
  const conflict = scope ? (r) => ({ ...R.conflictFromDb(r), device: '' }) : R.conflictFromDb;
  const changes = [
    ...pick(p, R.projectFromDb), ...pick(s, R.settingFromDb), ...pick(t, R.taskFromDb), ...pick(c, conflict),
    ...g.results.filter((r) => r.seq <= upTo).map((r) => ({ kind: 'task', id: r.id, seq: r.seq, gone: true })),
  ];
  return { cursor: Math.max(upTo, 0), more, changes, dbId: m.db_id ?? '', extra: extraResults };
}

const isStale = (e) => /UNIQUE constraint failed: meta\.key/i.test(String(e?.message ?? e));

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- shared lists
// A request made with a shared list's key (src/shares.js) may only change tasks of that one project, and their
// conflicts: never settings, the project itself (name, order, delete), or a task outside it. Moving a task in
// or out is refused too: in would hand one of the owner's other tasks to the person, out would take a task
// from the list into a project they cannot see. A key with view access changes nothing. Checked against the
// same snapshot the merge uses, so a task the owner moves out meanwhile cannot slip through.
const READ_ONLY = 'this shared list is view-only';
const OUTSIDE = 'not in this shared list';
const OWNER_ONLY = 'only the owner can change the list itself';

/** The tasks a shared list's request must be checked against besides its own: parents, tasks of conflicts. */
async function scopeExtraIds(db, changes) {
  const ids = new Set();
  const conflictIds = [];
  for (const c of changes) {
    if (c?.kind === 'task' && typeof c.fields?.place?.v?.parent === 'string') ids.add(c.fields.place.v.parent);
    if (c?.kind === 'conflict' && typeof c.id === 'string') conflictIds.push(c.id);
  }
  if (conflictIds.length) {
    const { results } = await db.prepare('SELECT task_id FROM conflicts WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(conflictIds)).all();
    for (const r of results) ids.add(r.task_id);
  }
  return [...ids];
}

/**
 * Splits a shared list's changes into what may be applied and what is refused. Refused rows that belong to the
 * list go back to the device as they are (its copy reverts); nothing outside the list is ever sent back.
 */
export function scopeChanges(state, changes, scope) {
  const allowed = [];
  const rejected = [];
  const canonical = new Map();
  const inScope = (row) => row?.kind === 'task' && row.fields.place.v?.project === scope.projectId;
  const project = state.rows.get(`project:${scope.projectId}`);
  const refuse = (c, reason, field) => {
    rejected.push({ kind: c?.kind, id: c?.id, ...(field ? { field } : {}), reason });
    const key = `${c?.kind}:${c?.id}`;
    const row = state.rows.get(key);
    if (c?.kind === 'task' && inScope(row)) canonical.set(key, row);
    if (c?.kind === 'project' && c.id === scope.projectId && project) canonical.set(key, project);
    if (c?.kind === 'conflict' && row && inScope(state.rows.get(`task:${row.task}`))) canonical.set(key, row);
  };
  for (const c of changes) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string') { allowed.push(c); continue; }   // normalizeChange says why
    if (c.kind === 'setting' || c.kind === 'project') { refuse(c, scope.access === 'edit' ? OWNER_ONLY : READ_ONLY); continue; }
    if (scope.access !== 'edit') { refuse(c, READ_ONLY); continue; }
    if (!project || project.fields.deleted.v) { refuse(c, 'the owner deleted this list'); continue; }
    if (c.kind === 'conflict') {
      const row = state.rows.get(`conflict:${c.id}`);
      if (row && !inScope(state.rows.get(`task:${row.task}`))) { refuse(c, OUTSIDE); continue; }
      allowed.push(c);
      continue;
    }
    if (c.kind !== 'task') { allowed.push(c); continue; }
    const existing = state.rows.get(`task:${c.id}`);
    if (existing && !inScope(existing)) { refuse(c, OUTSIDE); continue; }
    const place = c.fields?.place;
    if (place) {
      const p = place.v;
      if (!p || typeof p !== 'object' || p.project !== scope.projectId) { refuse(c, existing ? 'tasks cannot move out of a shared list' : OUTSIDE, 'place'); continue; }
      const parent = p.parent ?? null;
      if (parent !== null) {
        const pr = state.rows.get(`task:${parent}`);
        if (pr && !inScope(pr)) { refuse(c, OUTSIDE, 'place'); continue; }   // (a parent made in this batch is not loaded: fine)
      }
    }
    allowed.push(c);
  }
  return { allowed, rejected, canonical };
}

/**
 * Merges changes into D1 and writes them (optimistic, retried; see the top of this file): the one write path of
 * /api/sync, also used by the AI connector (src/mcp.js) for its edits. -> { rejected, canonical, seqBefore, seq }
 * (seq: the seq written, or null when nothing changed).
 */
export async function applyAndWrite(env, changes, { now = Date.now(), deviceId = '', scope = null } = {}) {
  let rejected = [];
  let seqBefore = null;
  let canonical = new Map();
  let seq = null;
  if (!changes.length) return { rejected, canonical, seqBefore, seq };
  const extraIds = scope ? await scopeExtraIds(env.DB, changes) : [];
  for (let attempt = 0; ; attempt++) {
    const st = await loadState(env.DB, changes, extraIds);
    seqBefore ??= Number(st.seq);
    let todo = changes;
    let refused = [];
    if (scope) ({ allowed: todo, rejected: refused, canonical } = scopeChanges(st.state, changes, scope));
    const res = todo.length ? applyChanges(st.state, todo, { now, deviceId }) : { touched: new Map(), conflicts: [], rejected: [], movedOut: [] };
    rejected = [...refused, ...res.rejected];
    if (scope) {
      // the scope check above makes this impossible; never write outside the list even if it were not
      for (const [key, row] of res.touched) {
        if (row.kind !== 'conflict' && !(row.kind === 'task' && row.fields.place.v?.project === scope.projectId)) res.touched.delete(key);
      }
    }
    if (!res.touched.size && !res.conflicts.length) break;
    try {
      seq = await writeState(env.DB, st.seq, res, now);
      break;
    } catch (e) {
      if (!isStale(e) || attempt + 1 >= MAX_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
    }
  }
  return { rejected, canonical, seqBefore, seq };
}

/**
 * scope: { projectId, access } when the request was made with a shared list's key (src/shares.js).
 * extra: statements read in the same batch as the changes; annotate(results) -> fields to add to the response.
 */
export async function handleSync(env, body, { now = Date.now(), scope = null, extra = [], annotate = null } = {}) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
  const { deviceId } = body;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(deviceId)) throw new HttpError(400, 'bad deviceId');
  const cursor = Number.isSafeInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
  const changes = body.changes ?? [];
  if (!Array.isArray(changes)) throw new HttpError(400, 'changes must be an array');
  if (changes.length > MAX_CHANGES) throw new HttpError(413, `at most ${MAX_CHANGES} changes per request`);

  const { rejected, canonical, seqBefore } = await applyAndWrite(env, changes, { now, deviceId, scope });
  const { extra: extraResults, ...out } = await loadChangesSince(env.DB, cursor, { scope, extra });
  // refused rows of the list come back as they are, so the device drops what it could not save
  const sent = new Set(out.changes.map((r) => `${r.kind}:${r.id}`));
  for (const [key, row] of canonical) if (!sent.has(key)) out.changes.push(row.kind === 'conflict' ? { ...row, device: '' } : R.publicRow(row));
  // a device that has seen more than this database holds: it was restored from a backup (D1 Time Travel).
  // Devices then start over from the server's state instead of skipping what was written since the restore
  const restored = seqBefore !== null ? cursor > seqBefore : out.cursor < cursor;
  return { ...out, rejected, serverTime: now, ...(restored ? { restored: true } : {}), ...(annotate ? annotate(extraResults) : {}) };
}
