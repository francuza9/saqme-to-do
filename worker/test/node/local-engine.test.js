// The Linux/macOS app's lists-folder engine (local/engine.mjs, a port of desktop/sync-core.ps1) against
// the Worker's own sync code running on node:sqlite (local/d1.mjs), the way the app runs it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, renameSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1 } from '../../../local/d1.mjs';
import {
  newState, syncCycle, applyPlanToFolder, rekeyMap, readLocalLists, newBackup, listBackups, backupRestorePlan,
} from '../../../local/engine.mjs';
import { localTransport, EngineLoop } from '../../../local/saqme.mjs';
import { handleSync } from '../../src/sync.js';

const migrations = join(import.meta.dirname, '..', '..', 'migrations');
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'saqme-store-'));
  dirs.push(dir);
  const d1 = new D1(join(dir, 'store.db'));
  d1.migrate(migrations);
  const env = { DB: d1, AUTH_TOKEN: 'x'.repeat(40) };
  return { env, dir, d1, transport: localTransport(env) };
}

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'saqme-lists-'));
  dirs.push(dir);
  const lists = join(dir, 'lists');
  mkdirSync(lists);
  return {
    lists,
    write(name, text) { writeFileSync(join(lists, `${name}.md`), text); },
    read(name) { return readFileSync(join(lists, `${name}.md`), 'utf8'); },
    exists(name) { return existsSync(join(lists, `${name}.md`)); },
    names() { return readdirSync(lists).filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.slice(0, -3)).sort(); },
    path: (name) => join(lists, `${name}.md`),
  };
}

function engine(f, s, deviceId = 'files') {
  const state = newState();
  const statePath = join(f.lists, '..', `state-${deviceId}.json`);
  return {
    state,
    async cycle(n = 1, opts = {}) {
      let res;
      for (let i = 0; i < n; i++) {
        res = await syncCycle({
          state, statePath, listsDir: f.lists, transport: s.transport, deviceId, settleMs: 0,
          applyPlan: (plan) => applyPlanToFolder(plan, f.lists), ...opts,
        });
        if (res.status !== 'synced') throw new Error(`${res.status}: ${res.message}`);
      }
      return res;
    },
  };
}

/** Another device (a phone) talking to the same store. */
function phone(s, deviceId = 'phone1') {
  let cursor = 0;
  const rows = new Map();
  return {
    rows,
    async sync(changes = []) {
      const r = await handleSync(s.env, { deviceId, cursor, changes });
      cursor = r.cursor;
      for (const row of r.changes) rows.set(`${row.kind}:${row.id}`, row);
      return r;
    },
    task(text) { return [...rows.values()].find((r) => r.kind === 'task' && r.fields.text.v === text && !r.fields.deleted.v); },
    project(name) { return [...rows.values()].find((r) => r.kind === 'project' && r.fields.name.v === name); },
    liveTexts(projectName) {
      const p = this.project(projectName);
      return [...rows.values()].filter((r) => r.kind === 'task' && !r.fields.deleted.v && r.fields.place.v.project === p?.id).map((r) => r.fields.text.v).sort();
    },
  };
}
const edit = (row, fields, ts = Date.now() + 5) => ({
  kind: row.kind, id: row.id, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { v, ts, base: row.fields[k]?.ts ?? -1 }])),
});

describe('lists folder <-> local store (local/engine.mjs)', () => {
  it('first sync uploads every list, stamps ids, keeps headings and prose; a quiet folder then sends nothing', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '# Sprint\n- [ ] Ship it due:2026-10-25T14:00\n  - [x] Feedback\n    > see https://example.com\n- [/] Docs\n\nProse stays.\n');
    f.write('Home', '- [ ] Groceries\n');
    const e = engine(f, s);
    await e.cycle(3);
    const work = f.read('Work');
    expect(work).toMatch(/^# Sprint\n- \[ \] Ship it due:2026-10-25T14:00 \^[0-9a-z]{8}\n {2}- \[x\] Feedback \^[0-9a-z]{8}\n {4}> see https:\/\/example.com\n- \[\/\] Docs \^[0-9a-z]{8}\n\nProse stays.\n$/);
    const p = phone(s);
    await p.sync();
    expect(p.liveTexts('Work')).toEqual(['Docs', 'Feedback', 'Ship it']);
    expect(p.liveTexts('Home')).toEqual(['Groceries']);
    expect(p.task('Feedback').fields.place.v.parent).toBe(p.task('Ship it').id);
    expect(p.task('Ship it').fields.due.v).toEqual({ date: '2026-10-25', time: '14:00' });
    expect(p.task('Feedback').fields.notes.v).toBe('see https://example.com');
    const quiet = await e.cycle();
    expect(quiet.sent).toBe(0);
    expect(f.read('Work')).toBe(work);
  });

  it('changes from another device land in place, without touching the rest of the file', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '# Sprint\n- [ ] A\n- [ ] B\n  - [ ] B1\n\nnotes paragraph\n');
    f.write('Home', '- [ ] H\n');
    const e = engine(f, s);
    await e.cycle(3);
    const p = phone(s);
    await p.sync();
    const [a, b, b1, h] = ['A', 'B', 'B1', 'H'].map((t) => p.task(t));
    const ts = Date.now() + 10;
    await p.sync([
      edit(a, { text: 'A renamed', status: 'x' }, ts),
      edit(b1, { deleted: true }, ts),
      edit(h, { place: { project: p.project('Work').id, parent: b.id, pos: 'a5' } }, ts),
      edit(p.project('Home'), { name: 'Household' }, ts),
      { kind: 'task', id: 'newtask01', fields: { place: { v: { project: p.project('Work').id, parent: null, pos: 'a0V' }, ts, base: -1 }, text: { v: 'Between A and B', ts, base: -1 }, status: { v: '/', ts, base: -1 }, due: { v: null, ts, base: -1 }, notes: { v: '', ts, base: -1 }, deleted: { v: false, ts, base: -1 } } },
    ]);
    await e.cycle(2);
    const id = (t) => p.task(t)?.id ?? p.rows.get(`task:${t}`)?.id;
    expect(f.read('Work')).toBe(`# Sprint\n- [x] A renamed ^${a.id}\n- [/] Between A and B ^newtask01\n- [ ] B ^${b.id}\n  - [ ] H ^${h.id}\n\nnotes paragraph\n`);
    expect(f.names()).toEqual(['Household', 'Work']);
    expect(f.read('Household')).toBe('');
    expect(id('A renamed')).toBe(a.id);
  });

  it('hand edits become changes: text, order, nesting, new and removed lines, renamed and deleted files', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '- [ ] A\n- [ ] B\n- [ ] C\n');
    f.write('Old', '- [ ] Old task\n');
    f.write('Gone', '- [ ] Will vanish\n');
    const e = engine(f, s);
    await e.cycle(3);
    const p = phone(s);
    await p.sync();
    const ids = Object.fromEntries(['A', 'B', 'C', 'Old task'].map((t) => [t, p.task(t).id]));
    const oldProject = p.project('Old').id;
    // an AI assistant rewrites the list: C first, B nested under C with new text, A done, a new line
    f.write('Work', `- [ ] C ^${ids.C}\n  - [ ] B edited ^${ids.B}\n- [x] A ^${ids.A}\n- [ ] Brand new\n`);
    renameSync(f.path('Old'), f.path('Renamed'));
    unlinkSync(f.path('Gone'));
    await e.cycle(3);
    await p.sync();
    expect(p.project('Gone').fields.deleted.v).toBe(false);   // a list gone for a moment is no delete yet...
    const back = await e.cycle(1, { clock: () => Date.now() + 11_000 });
    await e.cycle(1, { clock: () => Date.now() + 12_000 });
    await p.sync();                                           // ...nor one gone for good (only lists/.trash deletes):
    expect(back.rewritten).toEqual([{ name: 'Gone', count: 1 }]);   // it is written again from the last sync
    expect(f.read('Gone')).toMatch(/^- \[ \] Will vanish \^[0-9a-z]{8}\n$/);
    expect(p.rows.get(`task:${ids.B}`).fields.text.v).toBe('B edited');
    expect(p.rows.get(`task:${ids.B}`).fields.place.v.parent).toBe(ids.C);
    expect(p.rows.get(`task:${ids.A}`).fields.status.v).toBe('x');
    const top = ['C', 'A', 'Brand new'].map((t) => (t === 'C' || t === 'A' ? p.rows.get(`task:${ids[t]}`) : p.task(t)).fields.place.v.pos);
    expect([...top].sort()).toEqual(top);   // file order = position order
    expect(p.project('Renamed').id).toBe(oldProject);   // a renamed file keeps its project (and tasks)
    expect(p.liveTexts('Renamed')).toEqual(['Old task']);
    expect(p.project('Gone').fields.deleted.v).toBe(false);
    expect(p.liveTexts('Gone')).toEqual(['Will vanish']);
    expect(f.read('Work')).toMatch(/- \[ \] Brand new \^[0-9a-z]{8}\n$/);   // got its id
  });

  it('pauses deleting when most tasks vanish at once, until confirmed', async () => {
    const f = folder();
    const s = store();
    f.write('Big', Array.from({ length: 30 }, (_, i) => `- [ ] Task ${i}`).join('\n') + '\n');
    const e = engine(f, s);
    await e.cycle(3);
    f.write('Big', '- [ ] Task 0\n');   // no id: the first cycle only re-attaches it (by text), the next one decides
    await e.cycle();
    expect(f.read('Big')).toMatch(/^- \[ \] Task 0 \^[0-9a-z]{8}\n$/);
    const r = await e.cycle();
    expect(r.guarded).toBe(29);
    const p = phone(s);
    await p.sync();
    expect(p.liveTexts('Big')).toHaveLength(30);
    await e.cycle(1, { allowMassDelete: true });
    await p.sync();
    expect(p.liveTexts('Big')).toEqual(['Task 0']);
  });

  it('Restore them: a list overwritten by another program gets its held-back tasks back, merged with what it holds now', async () => {
    const f = folder();
    const s = store();
    const many = Array.from({ length: 22 }, (_, i) => `- [ ] Task ${i}`).join('\n');
    f.write('General', `- [/] Plan due:2026-10-25T14:00\n  - [x] Step one\n    > see https://example.com\n${many}\n`);
    const e = engine(f, s);
    await e.cycle(3);
    const before = f.read('General');
    const p = phone(s);
    await p.sync();
    expect(p.liveTexts('General')).toHaveLength(24);
    // what the self-check did to a real data folder (1.2.0): the list replaced by its own tasks, two of them synced
    f.write('General', '- [ ] smoke task one\n  - [ ] smoke subtask\n');
    await e.cycle();                    // ids for the new lines
    expect((await e.cycle()).guarded).toBe(24);
    const smoke = f.read('General');
    // a list being edited refuses the plan: nothing changes, the guard and the request stay
    const busy = await e.cycle(1, { restore: true, applyPlan: () => false });
    expect(busy.restorePending).toBe(true);
    expect(busy.guarded).toBe(24);
    expect(f.read('General')).toBe(smoke);
    const r = await e.cycle(1, { restore: true });
    expect(r.restored).toBe(24);
    expect(r.restorePending).toBeFalsy();
    expect(e.state.Guard).toBeNull();
    const after = f.read('General');
    for (const line of before.split('\n').filter(Boolean)) expect(after).toContain(line);   // every line as it was, ids too
    for (const line of smoke.split('\n').filter(Boolean)) expect(after).toContain(line);    // and the new tasks stay
    // (the smoke task took key a0 like Plan: which of the two comes first is up to their random ids)
    expect(after).toMatch(/^- \[\/\] Plan due:2026-10-25T14:00 \^[0-9a-z]{8}\n {2}- \[x\] Step one \^[0-9a-z]{8}\n {4}> see https:\/\/example.com\n/m);
    const quiet = await e.cycle(2);
    expect(quiet.guarded).toBe(0);
    await p.sync();
    expect(p.liveTexts('General')).toHaveLength(26);   // nothing deleted anywhere; the two new tasks arrived
    expect(f.read('General')).toBe(after);
  });

  it('a list file gone for good is written again by itself, in its place, and its project is never deleted', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '- [ ] W\n');
    f.write('Old', `${Array.from({ length: 3 }, (_, i) => `- [ ] Old ${i}`).join('\n')}\n`);
    f.write('Home', '- [ ] H\n');
    writeFileSync(join(f.lists, '.order'), 'Work\nOld\nHome\n');
    const e = engine(f, s);
    await e.cycle(3);
    const old = f.read('Old');
    unlinkSync(f.path('Old'));   // another program, a sync client, another app's private copy of the folder...
    expect((await e.cycle(1)).rewritten).toBeUndefined();   // (gone for a moment: nothing decided yet)
    const r = await e.cycle(1, { clock: () => Date.now() + 11_000 });
    expect(r.rewritten).toEqual([{ name: 'Old', count: 3 }]);
    expect(r.guarded).toBe(0);
    expect(f.read('Old')).toBe(old);   // the same lines and ids
    expect(readFileSync(join(f.lists, '.order'), 'utf8')).toBe('Work\nOld\nHome\n');
    expect(e.state.Guard).toBeNull();
    expect((await e.cycle(2, { clock: () => Date.now() + 22_000 })).guarded).toBe(0);
    const p = phone(s);
    await p.sync();
    expect(p.project('Old').fields.deleted.v).toBe(false);
    expect(p.liveTexts('Old')).toHaveLength(3);
  });

  it('Restore them: a vanished list that could not be written again yet stays held, then comes back', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '- [ ] W\n');
    f.write('Old', `${Array.from({ length: 6 }, (_, i) => `- [ ] Old ${i}`).join('\n')}\n`);
    const e = engine(f, s);
    await e.cycle(3);
    const old = f.read('Old');
    unlinkSync(f.path('Old'));
    await e.cycle(1);
    // the app was busy (a list being edited): nothing is written, the delete stays held back
    const busy = await e.cycle(1, { clock: () => Date.now() + 11_000, applyPlan: () => false });
    expect(busy.guarded).toBe(6);
    expect(busy.rewritten).toBeUndefined();
    expect(f.exists('Old')).toBe(false);
    expect((await e.cycle(1, { restore: true })).restored).toBe(6);
    expect(f.read('Old')).toBe(old);
    expect((await e.cycle(2, { clock: () => Date.now() + 22_000 })).guarded).toBe(0);
    const p = phone(s);
    await p.sync();
    expect(p.project('Old').fields.deleted.v).toBe(false);
    expect(p.liveTexts('Old')).toHaveLength(6);
  });

  it('a list being written right now is left alone, and no deletes are decided meanwhile', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '- [ ] Keep me\n');
    const e = engine(f, s);
    await e.cycle(3);
    f.write('Work', '');   // half-written by an editor...
    const r = await e.cycle(1, { settleMs: 60_000 });   // ...and still "busy"
    expect(r.retry).toBe(true);
    const p = phone(s);
    await p.sync();
    expect(p.liveTexts('Work')).toEqual(['Keep me']);
  });

  it('a list written earlier in the current millisecond is busy too (mtimes have sub-ms precision, Date.now() has not)', () => {
    const f = folder();
    f.write('Work', '- [ ] Keep me\n');
    const now = Date.now();
    utimesSync(f.path('Work'), (now + 0.5) / 1000, (now + 0.5) / 1000);   // written 0.5 ms into this millisecond (fine-grained mtimes)
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(readLocalLists(f.lists, 60_000).files.Work.status).toBe('busy');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('two engines on one folder: a list emptied through one of them (the window, a phone) is a delete for the other, not held back', async () => {
    const f = folder();
    const local = store();
    const cloud = store();
    f.write('Work', '- [ ] Keep\n');
    f.write('Errand', '- [ ] Only task\n');
    // the app's wiring (local/saqme.mjs startApp): what one engine takes out of a file is expected by the other
    const loop = (name, s, deviceId) => new EngineLoop({
      name, statePath: join(f.lists, '..', `${deviceId}.json`), listsDir: f.lists, interval: 50, settleMs: 0, log: () => {},
      target: () => ({ transport: s.transport, deviceId, label: name }),
    });
    const a = loop('files', local, 'files');
    const b = loop('cloud', cloud, 'pc-cloud');
    a.onRemoved = (keys) => b.expect(keys);
    b.onRemoved = (keys) => a.expect(keys);
    const run = async () => { for (let i = 0; i < 4; i++) { await a.step(); await b.step(); bumpMtimes(f); } };
    await run();
    const win = phone(local, 'web-window');
    await win.sync();
    await win.sync([edit(win.task('Only task'), { deleted: true })]);   // deleted in the window
    await run();
    expect(f.read('Errand')).toBe('');
    expect(b.status.guarded).toBe(0);
    expect(a.status.guarded).toBe(0);
    const mobile = phone(cloud, 'web-phone');
    await mobile.sync();
    expect(mobile.liveTexts('Errand')).toEqual([]);   // the cloud has it deleted too
    expect(mobile.liveTexts('Work')).toEqual(['Keep']);
  });

  it('backups: one when the lists changed, none while they did not; old ones pruned; bringing one back adds only what is missing', () => {
    const f = folder();
    const data = join(f.lists, '..');
    expect(newBackup(data, 'start', new Date(2026, 9, 22, 6, 0, 0))).toBeNull();   // no lists yet
    f.write('Work', '- [ ] A ^aaaaaaaa\n  - [x] A1 ^aaaaaaa1\n');
    f.write('Home', '- [ ] H ^hhhhhhhh\n');
    expect(newBackup(data, 'start', new Date(2026, 9, 22, 6, 0, 0))).toBe('20261022-060000-start');
    expect(newBackup(data, 'daily', new Date(2026, 9, 22, 7, 0, 0))).toBeNull();   // nothing changed
    f.write('Work', '- [x] A edited ^aaaaaaaa\n');   // A1 gone
    unlinkSync(f.path('Home'));                         // Home gone
    expect(newBackup(data, 'daily', new Date(2026, 9, 22, 8, 0, 0))).toBe('20261022-080000-daily');
    const all = listBackups(data);
    expect(all.map((x) => [x.name, x.reason, x.lists])).toEqual([['20261022-080000-daily', 'daily', 1], ['20261022-060000-start', 'start', 2]]);
    const r = backupRestorePlan(readLocalLists(f.lists, 0), all[1].path, f.lists);
    expect([r.lists, r.tasks]).toEqual([['Home'], 2]);
    expect(applyPlanToFolder(r.plan, f.lists)).toBe(true);
    expect(f.read('Work')).toBe('- [x] A edited ^aaaaaaaa\n  - [x] A1 ^aaaaaaa1\n');   // the edit stays, the lost subtask is back
    expect(f.read('Home')).toBe('- [ ] H ^hhhhhhhh\n');
    // twelve more days of changes: the ten newest stay, and the newest of each day for 30 days
    for (let d = 0; d < 12; d++) { f.write('Work', `- [ ] day ${d} ^aaaaaaaa\n`); newBackup(data, 'daily', new Date(2026, 9, 23 + d, 9, 0, 0)); }
    const names = listBackups(data).map((x) => x.name);
    expect(names.length).toBe(13);   // 12 newest-of-their-day + Oct 22's newest (08:00); Oct 22 06:00 went
    expect(names).not.toContain('20261022-060000-start');
    expect(readdirSync(join(data, 'backups')).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('two engines on one folder (this computer + the cloud) carry edits both ways and converge', async () => {
    const f = folder();
    const local = store();
    const cloud = store();
    f.write('Work', '- [ ] Shared\n');
    const a = engine(f, local, 'files');
    const b = engine(f, cloud, 'pc-cloud');
    const run = async () => { for (let i = 0; i < 4; i++) { await a.cycle(); await b.cycle(); bumpMtimes(f); } };
    await run();
    const win = phone(local, 'web-window');
    const mobile = phone(cloud, 'web-phone');
    await win.sync(); await mobile.sync();
    expect(win.liveTexts('Work')).toEqual(['Shared']);
    expect(mobile.liveTexts('Work')).toEqual(['Shared']);
    // the window edits one task, the phone adds another; both reach the other side through the folder
    const shared = win.task('Shared');
    await win.sync([edit(shared, { status: '/' })]);
    await mobile.sync([{ kind: 'task', id: 'fromphone1', fields: Object.fromEntries(Object.entries({ place: { project: mobile.project('Work').id, parent: null, pos: 'a5' }, text: 'From the phone', status: ' ', due: null, notes: '', deleted: false }).map(([k, v]) => [k, { v, ts: Date.now(), base: -1 }])) }]);
    await run();
    await win.sync(); await mobile.sync();
    expect(win.liveTexts('Work')).toEqual(['From the phone', 'Shared']);
    expect(mobile.task('Shared').fields.status.v).toBe('/');
    expect(f.read('Work')).toBe(`- [/] Shared ^${shared.id}\n- [ ] From the phone ^fromphone1\n`);
  });

  // ---- from the release review: saves from old copies, lists gone for a moment, restores, encodings
  const conflictsOf = (p) => [...p.rows.values()].filter((r) => r.kind === 'conflict').map((c) => `${c.field}:${JSON.stringify(c.value)}`).sort();
  const lineIds = (text) => Object.fromEntries([...text.matchAll(/- \[.\] (.*?) \^([0-9a-z]+)/g)].map((m) => [m[1], m[2]]));

  it('a save from a copy older than the last plan keeps the other device\'s edits (as conflicts, nothing lost)', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '# Work\n- [ ] Pay rent ^aaaaaaa1\n- [ ] Call bank ^aaaaaaa2\n');
    const e = engine(f, s);
    await e.cycle(3);
    const p = phone(s);
    await p.sync();
    const editorBuffer = f.read('Work');   // an editor (or an AI) reads the file now...
    const rent = p.task('Pay rent');
    const now = Date.now();
    await p.sync([edit(rent, { status: 'x', notes: 'paid via transfer' }), {
      kind: 'task', id: 'bbbbbbb1', fields: Object.fromEntries(Object.entries({
        place: { project: p.project('Work').id, parent: null, pos: 'a5' }, text: 'Added on the phone', status: ' ', due: null, notes: '', deleted: false,
      }).map(([k, v]) => [k, { v, ts: now, base: -1 }])),
    }]);
    await e.cycle(2);   // ...the app writes the phone's changes into the file...
    expect(f.read('Work')).toMatch(/- \[x\] Pay rent \^aaaaaaa1\n {2}> paid via transfer\n/);
    f.write('Work', editorBuffer.replace('Call bank', 'Call bank today'));   // ...and the editor saves its old copy
    await e.cycle(3);
    await p.sync();
    expect(p.rows.get('task:aaaaaaa1').fields.status.v).toBe('x');                   // the phone's edits stay
    expect(p.rows.get('task:aaaaaaa1').fields.notes.v).toBe('paid via transfer');
    expect(p.rows.get('task:bbbbbbb1').fields.deleted.v).toBe(false);                  // its task too
    expect(p.rows.get('task:aaaaaaa2').fields.text.v).toBe('Call bank today');          // the editor's own edit lands
    expect(conflictsOf(p)).toEqual(['deleted:true', 'notes:""', 'status:" "']);       // what the old copy said is kept
    expect(f.read('Work')).toBe('# Work\n- [x] Pay rent ^aaaaaaa1\n  > paid via transfer\n- [ ] Call bank today ^aaaaaaa2\n- [ ] Added on the phone ^bbbbbbb1\n');
  });

  it('a list gone for a moment is no delete; gone for good, it is written again, never deleted', async () => {
    const f = folder();
    const s = store();
    f.write('Work', `# Work\nSome prose.\n${Array.from({ length: 60 }, (_, i) => `- [ ] task ${i}\n`).join('')}`);
    f.write('Home', '- [ ] H\n');
    const e = engine(f, s);
    await e.cycle(3);
    const away = join(f.lists, '..', 'Work.md');
    renameSync(f.path('Work'), away);   // a sync client re-downloading the folder, a git checkout...
    await e.cycle(1);
    renameSync(away, f.path('Work'));
    await e.cycle(2, { clock: () => Date.now() + 11_000 });
    const p = phone(s);
    await p.sync();
    expect(p.project('Work').fields.deleted.v).toBe(false);
    expect(p.liveTexts('Work')).toHaveLength(60);
    renameSync(f.path('Work'), away);   // gone for good: held back, and written again from the last sync
    await e.cycle(1);
    const r = await e.cycle(1, { clock: () => Date.now() + 11_000 });
    expect(r.rewritten).toEqual([{ name: 'Work', count: 60 }]);
    expect(f.read('Work')).toMatch(/^- \[ \] task 0 \^[0-9a-z]{8}\n/);   // (its prose was never synced: only tasks come back)
    await e.cycle(1, { clock: () => Date.now() + 12_000, allowMassDelete: true });   // nothing is held: nothing to confirm
    await p.sync();
    expect(p.project('Work').fields.deleted.v).toBe(false);
    expect(p.liveTexts('Work')).toHaveLength(60);
  });

  it('a list moved to lists/.trash (how the apps delete one) deletes its project at once', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '- [ ] W\n');
    f.write('Old', Array.from({ length: 8 }, (_, i) => `- [ ] old ${i}\n`).join(''));
    const e = engine(f, s);
    await e.cycle(3);
    mkdirSync(join(f.lists, '.trash'));
    renameSync(f.path('Old'), join(f.lists, '.trash', 'Old-20261019-120000.md'));
    expect((await e.cycle(1)).guarded).toBe(0);
    const p = phone(s);
    await p.sync();
    expect(p.project('Old').fields.deleted.v).toBe(true);
  });

  it('pauses when most of one list vanishes; confirming deletes what was shown, not what vanished since', async () => {
    const f = folder();
    const s = store();
    f.write('Big', Array.from({ length: 100 }, (_, i) => `- [ ] big ${i}\n`).join(''));
    f.write('Small', Array.from({ length: 8 }, (_, i) => `- [ ] small ${i}\n`).join(''));
    f.write('Other', Array.from({ length: 6 }, (_, i) => `- [ ] other ${i}\n`).join(''));
    const e = engine(f, s);
    await e.cycle(3);
    f.write('Small', f.read('Small').split('\n')[0] + '\n');   // 7 of 8 gone: well under 25 overall, most of one list
    expect((await e.cycle(1)).guarded).toBe(7);
    const p = phone(s);
    await p.sync();
    expect(p.liveTexts('Small')).toHaveLength(8);
    f.write('Other', '');   // emptied after the warning was shown
    const r = await e.cycle(1, { allowMassDelete: true });
    expect(r.guarded).toBe(6);
    await p.sync();
    expect(p.liveTexts('Small')).toEqual(['small 0']);
    expect(p.liveTexts('Other')).toHaveLength(6);
  });

  it('a server restored from a backup: devices start over instead of skipping what came after', async () => {
    const f = folder();
    const s = store();
    const desk = engine(f, s, 'pc-1');
    f.write('Work', '- [ ] A ^aaaaaaa1\n');
    await desk.cycle(3);
    s.d1.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const backup = join(s.dir, 'backup.db');
    copyFileSync(join(s.dir, 'store.db'), backup);
    f.write('Work', '- [ ] A ^aaaaaaa1\n- [ ] B added later ^aaaaaaa2\n- [ ] C added later ^aaaaaaa3\n');
    await desk.cycle(3);
    for (let i = 0; i < 5; i++) { f.write('Work', f.read('Work').replace(/A( \d)*/, `A ${i}`)); await desk.cycle(2); }
    s.d1.close();
    copyFileSync(backup, join(s.dir, 'store.db'));   // the restore: same database id, lower sequence number
    s.env.DB = new D1(join(s.dir, 'store.db'));
    const p = phone(s, 'phone2');
    await p.sync();
    await p.sync([edit(p.task('A'), { text: 'A edited on the phone after the restore', status: 'x' })]);
    bumpMtimes(f);
    await desk.cycle(4);
    expect(f.read('Work')).toMatch(/^- \[x\] A edited on the phone after the restore \^aaaaaaa1\n/);
    const fresh = phone(s, 'phone3');
    await fresh.sync();
    expect(fresh.liveTexts('Work')).toEqual(['A edited on the phone after the restore', 'B added later', 'C added later']);
  });

  it('a list saved in a legacy code page keeps its accents', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '- [ ] seed ^aaaaaaa1\n');
    const e = engine(f, s);
    await e.cycle(3);
    writeFileSync(f.path('Work'), Buffer.from('# Caf\xe9 notes\n- [ ] seed ^aaaaaaa1\n- [ ] R\xe9sum\xe9 senden\n', 'latin1'));
    await e.cycle(3);
    expect(f.read('Work')).toMatch(/^# Café notes\n- \[ \] seed \^aaaaaaa1\n- \[ \] Résumé senden \^[0-9a-z]{8}\n$/);   // now UTF-8
    const p = phone(s);
    await p.sync();
    expect(p.liveTexts('Work')).toEqual(['Résumé senden', 'seed']);
  });

  it('an empty lists folder receives the lists on first contact', async () => {
    const s = store();
    const f1 = folder();
    f1.write('Work', '- [ ] A ^aaaaaaa1\n');
    await engine(f1, s, 'pc-1').cycle(3);
    const f2 = folder();
    await engine(f2, s, 'pc-2').cycle(2);
    expect(f2.names()).toEqual(['Work']);
    expect(f2.read('Work')).toBe('- [ ] A ^aaaaaaa1\n');
  });

  it('a list deleted elsewhere is not moved to .trash when it changed while the plan waited', async () => {
    const f = folder();
    const s = store();
    f.write('Work', '- [ ] W\n');
    f.write('Old', '- [ ] O\n');
    const e = engine(f, s);
    await e.cycle(3);
    const p = phone(s);
    await p.sync();
    await p.sync([edit(p.project('Old'), { deleted: true })]);
    let typed = false;
    await e.cycle(1, {
      applyPlan: (plan) => {
        if (!typed && plan.ops.some((o) => o.type === 'trash')) { f.write('Old', `${f.read('Old')}- [ ] typed meanwhile\n`); typed = true; }
        return applyPlanToFolder(plan, f.lists);
      },
    });
    expect(typed).toBe(true);
    expect(f.read('Old')).toMatch(/typed meanwhile/);
    expect(existsSync(join(f.lists, '.trash'))).toBe(false);
  });

  it('order keys start over when they grow too long', () => {
    const long = `a0${'V'.repeat(60)}`;
    const m = rekeyMap([long, null]);
    expect(Math.max(...[...m.values()].map((k) => k.length))).toBeLessThanOrEqual(3);
  });
});

/** The engine treats a list written in the last moment as busy only with settleMs > 0; these tests use 0,
 *  but each engine's own writes must still look older than the other engine's next edit time. */
function bumpMtimes(f) {
  const past = new Date(Date.now() - 2000);
  for (const n of f.names()) { if (existsSync(f.path(n))) utimesSync(f.path(n), past, past); }
}
