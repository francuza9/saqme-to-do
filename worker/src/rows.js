// D1 row <-> wire row conversion.

const bool = (x) => x === 1 || x === true || x === '1';

export function taskFromDb(r) {
  const devs = parseJson(r.devs) || {};
  const row = {
    kind: 'task', id: r.id, seq: r.seq, createdAt: r.created_at,
    fields: {
      place: { v: { project: r.project_id, parent: r.parent_id ?? null, pos: r.position }, ts: r.place_ts },
      text: { v: r.text, ts: r.text_ts },
      status: { v: r.status, ts: r.status_ts },
      due: { v: r.due ? { date: r.due, time: r.due_time || '' } : null, ts: r.due_ts },
      notes: { v: r.notes, ts: r.notes_ts },
      deleted: { v: bool(r.deleted), ts: r.deleted_ts },
    },
  };
  for (const [k, d] of Object.entries(devs)) if (row.fields[k]) row.fields[k].dev = d;
  return row;
}

/** Wire form for clients: field values and timestamps only. */
export function publicRow(row) {
  if (row.kind !== 'task') return row;
  const fields = {};
  for (const [k, f] of Object.entries(row.fields)) fields[k] = { v: f.v, ts: f.ts };
  return { ...row, fields };
}

export function taskToDb(t, seq, now) {
  const f = t.fields;
  const place = f.place.v;
  return {
    id: t.id, project_id: place.project, parent_id: place.parent, position: place.pos, place_ts: f.place.ts,
    text: f.text.v, text_ts: f.text.ts, status: f.status.v, status_ts: f.status.ts,
    due: f.due.v ? f.due.v.date : null, due_time: f.due.v ? f.due.v.time : '', due_ts: f.due.ts,
    notes: f.notes.v, notes_ts: f.notes.ts, deleted: f.deleted.v ? 1 : 0, deleted_ts: f.deleted.ts,
    devs: JSON.stringify(Object.fromEntries(Object.entries(f).filter(([, x]) => x.dev).map(([k, x]) => [k, x.dev]))),
    created_at: t.createdAt ?? now,
    updated_at: Math.max(...Object.values(f).map((x) => x.ts)),
    seq,
  };
}

export function projectFromDb(r) {
  return {
    kind: 'project', id: r.id, seq: r.seq, createdAt: r.created_at,
    fields: {
      name: { v: r.name, ts: r.name_ts },
      pos: { v: r.position, ts: r.position_ts },
      deleted: { v: bool(r.deleted), ts: r.deleted_ts },
    },
  };
}

export function projectToDb(p, seq, now) {
  const f = p.fields;
  return {
    id: p.id, name: f.name.v, name_ts: f.name.ts, position: f.pos.v, position_ts: f.pos.ts,
    deleted: f.deleted.v ? 1 : 0, deleted_ts: f.deleted.ts, created_at: p.createdAt ?? now, seq,
  };
}

export function settingFromDb(r) {
  return { kind: 'setting', id: r.key, seq: r.seq, fields: { value: { v: r.value, ts: r.ts } } };
}

export function settingToDb(s, seq) {
  return { key: s.id, value: s.fields.value.v, ts: s.fields.value.ts, seq };
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function conflictFromDb(r) {
  return {
    kind: 'conflict', id: r.id, seq: r.seq,
    task: r.task_id, field: r.field, value: parseJson(r.value), valueTs: r.value_ts,
    other: parseJson(r.other), device: r.device_id, at: r.created_at,
    fields: { resolved: { v: bool(r.resolved), ts: r.resolved_ts } },
  };
}

export function conflictToDb(c, seq) {
  return {
    id: c.id, task_id: c.task, field: c.field, value: JSON.stringify(c.value ?? null), value_ts: c.valueTs,
    other: JSON.stringify(c.other ?? null), device_id: c.device ?? '', created_at: c.at,
    resolved: c.fields.resolved.v ? 1 : 0, resolved_ts: c.fields.resolved.ts, seq,
  };
}
