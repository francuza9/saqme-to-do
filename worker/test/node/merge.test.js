import { describe, it, expect } from 'vitest';
import { applyChanges, mergeField, normalizeChange, conflictId } from '../../src/merge.js';

const P = 'proj0001';
const NOW = 1_800_000_000_000;

function newState(rows = []) {
  const state = { rows: new Map(), parents: new Map() };
  for (const r of rows) {
    state.rows.set(`${r.kind}:${r.id}`, r);
    if (r.kind === 'task') state.parents.set(r.id, r.fields.place.v.parent);
  }
  return state;
}
const f = (v, ts, base) => (base === undefined ? { v, ts } : { v, ts, base });
const project = (id = P, ts = 1) => ({ kind: 'project', id, fields: { name: f('Work', ts), pos: f('a0', ts) } });
const task = (id, ts, extra = {}) => ({
  kind: 'task', id,
  fields: { place: f({ project: P, parent: null, pos: 'a0' }, ts), text: f(`task ${id}`, ts), status: f(' ', ts), ...extra },
});
/** state after applying `changes` from scratch */
function seeded(changes) {
  const s = newState();
  const out = applyChanges(s, changes, { now: NOW, deviceId: 'seed' });
  expect(out.rejected).toEqual([]);
  return s;
}
const get = (s, id, kind = 'task') => s.rows.get(`${kind}:${id}`);

describe('mergeField', () => {
  it('takes the first value', () => {
    expect(mergeField({ v: '', ts: 0 }, { v: 'x', ts: 5, base: -1 })).toMatchObject({ take: true, ts: 5, conflict: null });
  });
  it('applies a successor edit even with a lagging clock', () => {
    expect(mergeField({ v: 'a', ts: 100 }, { v: 'b', ts: 50, base: 100 })).toMatchObject({ take: true, ts: 101, conflict: null });
  });
  it('newest wins on concurrent edits and reports the loser', () => {
    const r = mergeField({ v: 'a', ts: 100 }, { v: 'b', ts: 120, base: 90 });
    expect(r.take).toBe(true);
    expect(r.conflict.loser).toMatchObject({ v: 'a', ts: 100 });
    const r2 = mergeField({ v: 'a', ts: 100 }, { v: 'b', ts: 80, base: 90 });
    expect(r2.take).toBe(false);
    expect(r2.conflict.loser).toMatchObject({ v: 'b', ts: 80 });
  });
  it('identical concurrent values are not a conflict', () => {
    expect(mergeField({ v: 'a', ts: 100 }, { v: 'a', ts: 120, base: 90 }).conflict).toBeNull();
  });
  it('breaks exact timestamp ties deterministically', () => {
    const a = mergeField({ v: 'a', ts: 100 }, { v: 'b', ts: 100, base: 1 });
    const b = mergeField({ v: 'b', ts: 100 }, { v: 'a', ts: 100, base: 1 });
    expect(a.take).toBe(true);
    expect(b.take).toBe(false);
  });
});

describe('normalizeChange', () => {
  it('normalizes values and clamps future timestamps', () => {
    const c = normalizeChange({ kind: 'task', id: 'abcd1234', fields: {
      status: f('X', NOW + 99999), due: f({ date: '2026-10-25', time: '09:05' }, 1), text: f(' a\nb ', 1),
      notes: f('\r\n line  \n\n', 1) } }, NOW);
    expect(c.fields.status).toEqual({ v: 'x', ts: NOW, base: -1 });
    expect(c.fields.due.v).toEqual({ date: '2026-10-25', time: '9:05' });
    expect(c.fields.text.v).toBe('a b');
    expect(c.fields.notes.v).toBe(' line');   // inner indentation is kept, blank edges dropped
  });
  it('rejects malformed input', () => {
    expect(normalizeChange({ kind: 'task', id: 'SHOUTING1', fields: { text: f('a', 1) } }, NOW).error).toBeTruthy();
    expect(normalizeChange({ kind: 'task', id: 'abcd1234', fields: { due: f({ date: '2026-02-30' }, 1) } }, NOW).error).toBeTruthy();
    expect(normalizeChange({ kind: 'task', id: 'abcd1234', fields: { status: f('?', 1) } }, NOW).error).toBeTruthy();
    expect(normalizeChange({ kind: 'task', id: 'abcd1234', fields: { place: f({ project: P, parent: null, pos: 'a00' }, 1) } }, NOW).error).toBeTruthy();
    expect(normalizeChange({ kind: 'setting', id: 'tz', fields: { value: f('Mars/Base', 1) } }, NOW).error).toBeTruthy();
    expect(normalizeChange({ kind: 'setting', id: 'notifyAt', fields: { value: f('25:00', 1) } }, NOW).error).toBeTruthy();
    expect(normalizeChange({ kind: 'setting', id: 'other', fields: { value: f('x', 1) } }, NOW).error).toBeTruthy();
  });
});

describe('applyChanges', () => {
  it('creates projects before tasks regardless of order', () => {
    const s = newState();
    const out = applyChanges(s, [task('t0000001', 10), project()], { now: NOW });
    expect(out.rejected).toEqual([]);
    expect(get(s, 't0000001').fields.text.v).toBe('task t0000001');
  });

  it('rejects tasks in unknown projects and unknown partial tasks', () => {
    const s = newState();
    const out = applyChanges(s, [task('t0000001', 10), { kind: 'task', id: 't0000002', fields: { text: f('x', 1) } }], { now: NOW });
    expect(out.rejected.map((r) => r.reason)).toEqual(['unknown project', 'unknown task']);
    expect(s.rows.size).toBe(0);
  });

  it('merges edits to different fields of the same task without conflicts', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    const out = applyChanges(s, [
      { kind: 'task', id: 't0000001', fields: { text: f('renamed', 20, 10) } },
      { kind: 'task', id: 't0000001', fields: { status: f('x', 21, 10) } },
    ], { now: NOW });
    expect(out.conflicts).toEqual([]);
    expect(get(s, 't0000001').fields.text.v).toBe('renamed');
    expect(get(s, 't0000001').fields.status.v).toBe('x');
  });

  it('keeps the newest of two concurrent edits and records the other', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('phone', 30, 10) } }], { now: NOW, deviceId: 'phone' });
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('desktop', 20, 10) } }], { now: NOW, deviceId: 'pc' });
    expect(get(s, 't0000001').fields.text).toMatchObject({ v: 'phone', ts: 30 });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ task: 't0000001', field: 'text', value: 'desktop', other: 'phone', device: 'pc' });
    // a resend of the same losing change produces the same conflict id (deduped by the database)
    const again = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('desktop', 20, 10) } }], { now: NOW + 5 });
    expect(again.conflicts[0].id).toBe(out.conflicts[0].id);
    expect(out.conflicts[0].id).toBe(conflictId('t0000001', 'text', 20, 'desktop'));
    expect(conflictId('t0000001', 'text', 20, 'other value')).not.toBe(out.conflicts[0].id);
  });

  it('newer concurrent edit replaces the older one and keeps the old value as the conflict', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { notes: f('old', 20, 10) } }], { now: NOW });
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { notes: f('new', 30, 10) } }], { now: NOW });
    expect(get(s, 't0000001').fields.notes.v).toBe('new');
    expect(out.conflicts[0]).toMatchObject({ field: 'notes', value: 'old', other: 'new' });
  });

  it('delete newer than the last edit wins', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('edited', 20, 10) } }], { now: NOW });
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { deleted: f(true, 30, 0) } }], { now: NOW });
    expect(get(s, 't0000001').fields.deleted.v).toBe(true);
    expect(out.conflicts).toEqual([]);
  });

  it('delete older than an edit loses (task stays, conflict recorded)', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('edited later', 40, 10) } }], { now: NOW });
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { deleted: f(true, 30, 0) } }], { now: NOW, deviceId: 'pc' });
    expect(get(s, 't0000001').fields.deleted.v).toBe(false);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ field: 'deleted', value: true, other: false });
  });

  it('edit newer than a delete brings the task back', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { deleted: f(true, 30, 0) } }], { now: NOW });
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { status: f('/', 50, 10) } }], { now: NOW });
    const t = get(s, 't0000001');
    expect(t.fields.deleted).toMatchObject({ v: false, ts: 50 });
    expect(t.fields.status.v).toBe('/');
    expect(out.conflicts.map((c) => c.field)).toEqual(['deleted']);
  });

  it('old edit arriving after a newer delete stays deleted but keeps the content', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { deleted: f(true, 30, 0) } }], { now: NOW });
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('offline edit', 20, 10) } }], { now: NOW });
    const t = get(s, 't0000001');
    expect(t.fields.deleted.v).toBe(true);
    expect(t.fields.text.v).toBe('offline edit');
  });

  it('never creates cycles', () => {
    const place = (parent, ts) => f({ project: P, parent, pos: 'a0' }, ts);
    const s = seeded([project(),
      task('aaaaaaaa', 10), task('bbbbbbbb', 10, { place: place('aaaaaaaa', 10) }), task('cccccccc', 10, { place: place('bbbbbbbb', 10) })]);
    const out = applyChanges(s, [{ kind: 'task', id: 'aaaaaaaa', fields: { place: place('cccccccc', 20) } }], { now: NOW });
    expect(out.rejected).toEqual([{ kind: 'task', id: 'aaaaaaaa', field: 'place', reason: 'move would create a cycle' }]);
    expect(get(s, 'aaaaaaaa').fields.place.v.parent).toBeNull();
    // self-parenting too
    const out2 = applyChanges(s, [{ kind: 'task', id: 'bbbbbbbb', fields: { place: place('bbbbbbbb', 20) } }], { now: NOW });
    expect(out2.rejected).toHaveLength(1);
    // and two moves in one batch that would only form a cycle together
    const out3 = applyChanges(s, [
      { kind: 'task', id: 'aaaaaaaa', fields: { place: place('dddddddd', 30) } },
      task('dddddddd', 30),
      { kind: 'task', id: 'dddddddd', fields: { place: place('aaaaaaaa', 31, 30) } },
    ], { now: NOW });
    expect(out3.rejected.map((r) => r.reason)).toEqual(['move would create a cycle']);
  });

  it('moves a task between projects', () => {
    const s = seeded([project(), project('proj0002'), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { place: f({ project: 'proj0002', parent: null, pos: 'a5' }, 20, 10) } }], { now: NOW });
    expect(get(s, 't0000001').fields.place.v).toEqual({ project: 'proj0002', parent: null, pos: 'a5' });
  });

  it('a newer task edit restores its deleted project', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'project', id: P, fields: { deleted: f(true, 30, 0) } }], { now: NOW });
    expect(get(s, P, 'project').fields.deleted.v).toBe(true);
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('still needed', 40, 10) } }], { now: NOW });
    expect(get(s, P, 'project').fields.deleted.v).toBe(false);
    expect(out.touched.has(`project:${P}`)).toBe(true);
    // ... but an older one does not
    applyChanges(s, [{ kind: 'project', id: P, fields: { deleted: f(true, 50, 0) } }], { now: NOW });
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { status: f('x', 45, 10) } }], { now: NOW });
    expect(get(s, P, 'project').fields.deleted.v).toBe(true);
  });

  it('settings and conflict resolution are last-writer-wins', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    applyChanges(s, [{ kind: 'setting', id: 'notifyAt', fields: { value: f('08:30', 10) } }], { now: NOW });
    applyChanges(s, [{ kind: 'setting', id: 'notifyAt', fields: { value: f('9:00', 5) } }], { now: NOW });
    expect(get(s, 'notifyAt', 'setting').fields.value.v).toBe('8:30');
    const c = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('x', 20, 1) } }], { now: NOW }).conflicts[0];
    s.rows.set(`conflict:${c.id}`, c);
    applyChanges(s, [{ kind: 'conflict', id: c.id, fields: { resolved: f(true, NOW, c.fields.resolved.ts) } }], { now: NOW });
    expect(get(s, c.id, 'conflict').fields.resolved.v).toBe(true);
  });
});

describe('same-device writes', () => {
  it('a device never conflicts with its own earlier write (lost response + resend)', () => {
    const s = seeded([project()]);
    applyChanges(s, [task('t0000001', 10)], { now: NOW, deviceId: 'phone' });
    // response was lost: the phone still has base -1 and edits again before resending
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('typed more', 20) } }], { now: NOW, deviceId: 'phone' });
    expect(out.conflicts).toEqual([]);
    expect(get(s, 't0000001').fields.text.v).toBe('typed more');
    // a stale resend from the same device does not roll the field back
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('task t0000001', 10) } }], { now: NOW, deviceId: 'phone' });
    expect(get(s, 't0000001').fields.text.v).toBe('typed more');
  });

  it('a device deleting after its own edit is not a conflict', () => {
    const s = seeded([project()]);
    applyChanges(s, [task('t0000001', 10)], { now: NOW, deviceId: 'pc' });
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('x', 40) } }], { now: NOW, deviceId: 'pc' });
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { deleted: f(true, 30) } }], { now: NOW, deviceId: 'pc' });
    expect(out.conflicts).toEqual([]);
    expect(get(s, 't0000001').fields.deleted.v).toBe(true);
  });
});

describe('edge cases: bad fields, invalid places, lagging clocks', () => {
  it('a bad field is dropped on its own; the rest of the change applies and the row is sent back', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { status: f('/', 20, 10), notes: f('x'.repeat(60_000), 20, 10) } }], { now: NOW });
    expect(get(s, 't0000001').fields.status.v).toBe('/');
    expect(get(s, 't0000001').fields.notes.v).toBe('');
    expect(out.rejected).toEqual([{ kind: 'task', id: 't0000001', field: 'notes', reason: 'notes: notes too long' }]);
    expect(out.touched.has('task:t0000001')).toBe(true);
  });
  it('a change with only bad fields still sends the canonical row back', () => {
    const s = seeded([project(), task('t0000001', 10)]);
    const out = applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { status: f('?', 20, 10) } }], { now: NOW });
    expect(out.rejected).toHaveLength(1);
    expect(out.touched.has('task:t0000001')).toBe(true);
  });
  it('a new task with an invalid place is rejected for that reason, not as unknown', () => {
    const s = seeded([project()]);
    const out = applyChanges(s, [{ kind: 'task', id: 't0000009', fields: { place: f({ project: P, parent: null, pos: 'a' + 'V'.repeat(200) }, 10), text: f('x', 10) } }], { now: NOW });
    expect(out.rejected.map((r) => r.reason)).toEqual(['place: bad position key']);
  });
  it('a sequential edit from a device with a lagging clock is never dropped', () => {
    const s = seeded([project()]);
    applyChanges(s, [task('t0000001', 1000)], { now: NOW, deviceId: 'phone' });
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('B', 900, 1000) } }], { now: NOW, deviceId: 'phone' });
    const ts = get(s, 't0000001').fields.text.ts;
    expect(ts).toBe(1001);
    applyChanges(s, [{ kind: 'task', id: 't0000001', fields: { text: f('C', 950, ts) } }], { now: NOW, deviceId: 'phone' });
    expect(get(s, 't0000001').fields.text.v).toBe('C');
  });
});
