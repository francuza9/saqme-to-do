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
};

const metaMap = (rows) => Object.fromEntries(rows.map((r) => [r.key, r.value]));

export async function loadState(db, changes) {
  const taskIds = new Set();
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
  await db.batch(stmts);
  return seq;
}

export async function loadChangesSince(db, cursor) {
  const q = (table) => db.prepare(`SELECT * FROM ${table} WHERE seq > ?1 ORDER BY seq LIMIT ?2`).bind(cursor, PAGE + 1);
  const [t, p, s, c, meta] = await db.batch([
    q('tasks'), q('projects'), q('settings'), q('conflicts'),
    db.prepare(`SELECT key, value FROM meta WHERE key IN ('seq', 'db_id')`),
  ]);
  const m = metaMap(meta.results);
  let upTo = Number(m.seq ?? 0);
  let more = false;
  for (const res of [t, p, s, c]) {
    if (res.results.length > PAGE) { more = true; upTo = Math.min(upTo, res.results[PAGE].seq - 1); }
  }
  // keep responses small (CPU and memory on the free plan): stop after ~1.5 MB, at a seq boundary, but
  // always deliver at least the first seq so paging makes progress
  const sizes = new Map();
  for (const res of [t, p, s, c]) {
    for (const r of res.results) if (r.seq <= upTo) sizes.set(r.seq, (sizes.get(r.seq) ?? 0) + JSON.stringify(r).length);
  }
  let total = 0;
  for (const seqNo of [...sizes.keys()].sort((a, b) => a - b)) {
    total += sizes.get(seqNo);
    if (total > 1_500_000 && seqNo > Math.min(...sizes.keys())) { upTo = seqNo - 1; more = true; break; }
  }
  const pick = (res, fn) => res.results.filter((r) => r.seq <= upTo).map((r) => R.publicRow(fn(r)));
  const changes = [
    ...pick(p, R.projectFromDb), ...pick(s, R.settingFromDb), ...pick(t, R.taskFromDb), ...pick(c, R.conflictFromDb),
  ];
  return { cursor: Math.max(upTo, 0), more, changes, dbId: m.db_id ?? '' };
}

const isStale = (e) => /UNIQUE constraint failed: meta\.key/i.test(String(e?.message ?? e));

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function handleSync(env, body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
  const { deviceId } = body;
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(deviceId)) throw new HttpError(400, 'bad deviceId');
  const cursor = Number.isSafeInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
  const changes = body.changes ?? [];
  if (!Array.isArray(changes)) throw new HttpError(400, 'changes must be an array');
  if (changes.length > MAX_CHANGES) throw new HttpError(413, `at most ${MAX_CHANGES} changes per request`);

  let rejected = [];
  let seqBefore = null;
  if (changes.length) {
    for (let attempt = 0; ; attempt++) {
      const st = await loadState(env.DB, changes);
      seqBefore ??= Number(st.seq);
      const res = applyChanges(st.state, changes, { now, deviceId });
      rejected = res.rejected;
      if (!res.touched.size && !res.conflicts.length) break;
      try {
        await writeState(env.DB, st.seq, res, now);
        break;
      } catch (e) {
        if (!isStale(e) || attempt + 1 >= MAX_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
      }
    }
  }
  const out = await loadChangesSince(env.DB, cursor);
  // a device that has seen more than this database holds: it was restored from a backup (D1 Time Travel).
  // Devices then start over from the server's state instead of skipping what was written since the restore
  const restored = seqBefore !== null ? cursor > seqBefore : out.cursor < cursor;
  return { ...out, rejected, serverTime: now, ...(restored ? { restored: true } : {}) };
}
