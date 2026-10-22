// The shared fixtures (shared/fixtures/): the rules that exist both in JavaScript and in the Windows app's
// PowerShell, as input -> expected output. desktop/tests/shared-fixtures.tests.ps1 runs the same files, so
// a rule that changes on one side only fails one of the two suites.
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDue, dueLabel, dueTone } from '../../public/js/dates.js';
import { computeReminders } from '../../src/reminders.js';
import {
  parseItems, formatItems, detectEol, setMissingIds, cleanTime, cleanText, cleanNotes, cleanProjectName, toFileName, isValidDate,
} from '../../public/js/markdown.js';
import * as model from '../../public/js/model.js';
import { parsePairingLink, parseInviteLink, serverLabel } from '../../public/js/pairing.js';
import { checkManifest, compareVersions, updateDecision } from '../../../local/update.mjs';
import { aiPrompt } from '../../../local/ai-prompt.mjs';
import { keyBetween, isValidKey, rekey } from '../../public/js/keys.js';
import { normalizeText, normalizeNotes, isValidDate as serverValidDate } from '../../src/merge.js';
import {
  newState, readLocalLists, addLocalDiff, remotePlan, restorePlan, applyPlanToFolder, rekeyMap, syncCycle, cleanText as engineCleanText,
} from '../../../local/engine.mjs';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'shared', 'fixtures');
const load = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

// ---------------------------------------------------------------- deadlines
describe('dates.json: parseDue, dueLabel, dueTone', () => {
  const fx = load('dates.json');
  const savedTz = process.env.TZ;
  afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });
  /** Runs in `tz`; `now` is a wall-clock time there. */
  const at = (group) => {
    process.env.TZ = group.tz;
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone, 'TZ took effect').toBe(group.tz);
    const [y, mo, d, h, mi] = group.now.split(/[-T:]/).map(Number);
    const now = new Date(y, mo - 1, d, h, mi);
    expect(now.getHours() * 60 + now.getMinutes(), `${group.now} exists in ${group.tz}`).toBe(h * 60 + mi);
    return now;
  };

  for (const g of fx.parse) {
    it(`parse: ${g.about} (${g.now} ${g.tz})`, () => {
      const now = at(g);
      const got = g.cases.map(([input]) => { const r = parseDue(input, now); return [input, r ? r.date : null, r ? r.time : '']; });
      expect(got).toEqual(g.cases);
    });
  }
  for (const g of fx.labels) {
    it(`labels at ${g.now} ${g.tz}`, () => {
      const now = at(g);
      expect(g.cases.map(([d]) => [d, dueLabel(d, now)])).toEqual(g.cases);
    });
  }
  for (const g of fx.tones) {
    it(`tones at ${g.now} ${g.tz}`, () => {
      const now = at(g);
      expect(g.cases.map(([date, time, closed]) => [date, time, closed, dueTone({ date, time }, closed, now)])).toEqual(g.cases);
    });
  }
});

// ---------------------------------------------------------------- reminders
describe('reminders.json: computeReminders', () => {
  for (const c of load('reminders.json').cases) {
    it(c.name, () => {
      const got = computeReminders(c.tasks, { tz: c.tz, notifyAt: c.notifyAt, nowMs: Date.parse(c.now), notified: new Set(c.notified) });
      expect(got.map(({ keys, title, body, sub }) => ({ keys, title, body, sub }))).toEqual(c.expect);
    });
  }
});

// ---------------------------------------------------------------- markdown list format
describe('markdown.json: parseItems, formatItems, setMissingIds', () => {
  const fx = load('markdown.json');
  const file = (name) => readFileSync(join(FIXTURES, 'markdown', name), 'utf8');
  const compact = (it) => (it.kind === 'task' ? ['task', it.level, it.mark, it.text, it.due, it.dueTime, it.id, it.notes] : ['raw', it.raw]);

  for (const c of fx.cases) {
    it(`${c.file}: ${c.about}`, () => {
      const text = file(c.file);
      const items = parseItems(text);
      expect(items.map(compact)).toEqual(c.items);
      const out = formatItems(items, 0, detectEol(text));
      expect(out).toBe(c.roundtrip ? text : file(c.expect));
      expect(formatItems(parseItems(out), 0, detectEol(out))).toBe(out);   // what the apps write reads back the same
    });
  }
  for (const c of fx.stamp) {
    it(`stamp: ${c.about}`, () => {
      const items = parseItems(c.text);
      const changed = setMissingIds(items, new Map(Object.entries(c.known)), new Set(c.taken));
      expect(changed).toBe(c.changed);
      const ids = items.filter((it) => it.kind === 'task').map((it) => it.id);
      expect(ids.map((id, i) => (c.expect[i] === '<new>' ? '<new>' : id))).toEqual(c.expect);
      const fresh = ids.filter((_, i) => c.expect[i] === '<new>');
      for (const id of fresh) expect(id).toMatch(/^[a-z][0-9a-z]{7}$/);
      expect(new Set(ids).size).toBe(ids.length);
      expect(fresh.some((id) => c.taken.includes(id) || Object.values(c.known).includes(id))).toBe(false);
    });
  }
});

// ---------------------------------------------------------------- order keys
describe('keys.json: keyBetween, isValidKey, rekey', () => {
  const fx = load('keys.json');
  it('between', () => {
    const got = fx.between.map(([a, b]) => { try { return [a, b, keyBetween(a, b)]; } catch { return [a, b, null]; } });
    expect(got).toEqual(fx.between);
  });
  it('valid', () => {
    expect(fx.valid.map(([k]) => [k, isValidKey(k)])).toEqual(fx.valid);
  });
  for (const c of fx.rekey) {
    it(`rekey ${JSON.stringify(c.keys).slice(0, 60)}`, () => {
      expect(Object.fromEntries(rekeyMap(c.keys))).toEqual(c.expect);   // the engine (lists folder)
      if (!c.reset) expect(Object.fromEntries(rekey(c.keys))).toEqual(c.expect);   // the phone app
    });
  }
  it(`walk of ${fx.walk.steps} inserts`, () => {
    let s = fx.walk.seed;
    const keys = ['a0'];
    for (let i = 0; i < fx.walk.steps; i++) {
      s = (s * 1664525 + 1013904223) % 4294967296;
      const k = Math.floor((s / 4294967296) * (keys.length + 1));
      keys.splice(k, 0, keyBetween(keys[k - 1] ?? null, keys[k] ?? null));
    }
    expect(keys).toEqual(fx.walk.expect);
  });
});

// ---------------------------------------------------------------- value rules
describe('text.json: value rules (every JavaScript copy)', () => {
  const fx = load('text.json');
  const val = (v) => (Array.isArray(v) ? v.map(val).join('') : v && typeof v === 'object' && 'repeat' in v ? v.repeat[0].repeat(v.repeat[1]) : v);
  const cases = (name) => fx[name].map((c) => (Array.isArray(c) ? { in: c[0], out: c[1] } : c)).map((c) => ({ ...c, in: val(c.in), out: val(c.out) }));
  const check = (name, impls) => {
    for (const [label, fn] of Object.entries(impls)) {
      it(`${name}: ${label}`, () => {
        const list = cases(name).filter((c) => !(c.cut && label === 'merge.normalizeText'));
        expect(list.map((c) => fn(c.in))).toEqual(list.map((c) => c.out));
      });
    }
  };
  const cutText = (s) => { const t = cleanText(s); return t.length > 10000 ? t.slice(0, 10000).trim() : t; };
  check('cleanText', { 'engine.cleanText': (s) => engineCleanText(s), 'markdown.cleanText + cut': cutText, 'model.cleanText + cut': (s) => { const t = model.cleanText(s); return t.length > 10000 ? t.slice(0, 10000).trim() : t; }, 'merge.normalizeText': normalizeText });
  check('cleanNotes', { 'markdown.cleanNotes': cleanNotes, 'model.cleanNotes': model.cleanNotes, 'merge.normalizeNotes': normalizeNotes });
  check('cleanTime', { 'markdown.cleanTime': cleanTime });
  check('validDate', { 'markdown.isValidDate': isValidDate, 'merge.isValidDate': serverValidDate });
  check('projectName', { 'markdown.cleanProjectName': cleanProjectName, 'model.cleanProjectName': model.cleanProjectName });
  check('fileName', { 'markdown.toFileName': toFileName });
  check('pairingLink', { 'pairing.parsePairingLink': (s) => parsePairingLink(s) });
  check('inviteLink', { 'pairing.parseInviteLink': (s) => parseInviteLink(s) });
  check('serverLabel', { 'pairing.serverLabel': (s) => serverLabel(s) });
});

// ---------------------------------------------------------------- the lists-folder engine
describe('engine.json: remotePlan, addLocalDiff (local/engine.mjs)', () => {
  const fx = load('engine.json');
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const row = (r, ts) => {
    const f = (v) => ({ v, ts });
    if (r.p) return { kind: 'project', id: r.p, fields: { name: f(r.name), pos: f(r.pos), deleted: f(r.deleted ?? false) } };
    return {
      kind: 'task', id: r.t, fields: {
        place: f({ project: r.in, parent: r.parent ?? null, pos: r.pos }), text: f(r.text), status: f(r.status ?? ' '),
        due: f(r.due ?? null), notes: f(r.notes ?? ''), deleted: f(r.deleted ?? false),
      },
    };
  };
  const rows = (list, ts) => Object.fromEntries(list.map((r) => row(r, ts)).map((r) => [`${r.kind}:${r.id}`, r]));
  function folder(c) {
    const dir = mkdtempSync(join(tmpdir(), 'saqme-fx-'));
    dirs.push(dir);
    const lists = join(dir, 'lists');
    mkdirSync(lists);
    const old = new Date(Date.now() - 10_000);
    for (const [name, text] of Object.entries(c.lists)) {
      mkdirSync(dirname(join(lists, name)), { recursive: true });   // ".trash/..."
      writeFileSync(join(lists, name), text);
      if (!c.busy?.includes(name)) utimesSync(join(lists, name), old, old);
    }
    return lists;
  }
  const folderFiles = (lists) => Object.fromEntries(readdirSync(lists).filter((n) => n !== '.trash').sort().map((n) => [n, readFileSync(join(lists, n), 'utf8')]));
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? sorted(x) : x));

  for (const c of fx.plan) {
    it(`plan: ${c.name}`, () => {
      const lists = folder(c);
      const st = newState();
      st.S = rows(c.S, 100); st.R = rows(c.R, 200); st.Files = { ...c.files }; st.cursor = 5;
      const plan = remotePlan(st, readLocalLists(lists), lists);
      expect(plan).not.toBeNull();
      expect(applyPlanToFolder(plan, lists)).toBe(true);
      expect(folderFiles(lists)).toEqual(sorted(c.after));
      const trash = existsSync(join(lists, '.trash')) ? readdirSync(join(lists, '.trash')) : [];
      expect(trash.length).toBe((c.trash ?? []).length);
      for (const prefix of c.trash ?? []) expect(trash.some((n) => n.startsWith(prefix))).toBe(true);
      if (c.filesAfter) {
        const files = { ...st.Files };
        for (const [k, v] of Object.entries(plan.files)) { if (v == null) delete files[k]; else files[k] = v; }
        expect(sorted(files)).toEqual(sorted(c.filesAfter));
      }
    });
  }
  for (const c of fx.diff) {
    it(`diff: ${c.name}`, () => {
      const lists = folder(c);
      const st = newState();
      st.S = rows(c.S, 100); st.R = rows(c.S, 100); st.Files = { ...c.files }; st.cursor = 5;
      const clock = Date.now();
      for (const [id, p] of Object.entries(c.planned ?? {})) {
        const fields = Object.fromEntries(Object.entries(p.fields).map(([n, [v, ts]]) => [n, { v, ts }]));
        st.Planned[`task:${id}`] = { at: clock - p.age * 1000, added: Boolean(p.added), addedTs: p.addedTs ?? 0, fields };
      }
      for (const [id, sec] of Object.entries(c.missing ?? {})) st.Missing[id] = clock - sec * 1000;
      st.Guard = c.guard ? { ids: c.guard } : null;
      const out = addLocalDiff(st, readLocalLists(lists), '', Boolean(c.allow), clock, { expected: c.expected ? new Set(c.expected) : null });
      const got = st.Outbox.flatMap((e) => Object.entries(e.fields).map(([name, f]) => ({ key: canon([e.kind, e.id, name, f.v]), base: f.base, ts: f.ts })));
      expect(got.map((g) => g.key).sort()).toEqual(c.changes.map((ch) => canon(ch.slice(0, 4))).sort());
      for (const ch of c.changes.filter((x) => x[4])) {
        const g = got.find((x) => x.key === canon(ch.slice(0, 4)));
        if ('base' in ch[4]) expect(g.base, `base of ${g.key}`).toBe(ch[4].base);
        if ('ts' in ch[4]) expect(g.ts, `ts of ${g.key}`).toBe(ch[4].ts);
      }
      expect(out.guarded).toBe(c.guarded ?? 0);
      expect(out.skipped || Object.values(readLocalLists(lists).files).some((f) => f.status !== 'ok')).toBe(Boolean(c.skipped));
      if (c.guardAfter) expect([...(st.Guard?.ids ?? [])].sort()).toEqual([...c.guardAfter].sort());
    });
  }
  for (const c of fx.restore) {
    it(`restore: ${c.name}`, () => {
      const lists = folder(c);
      const st = newState();
      st.S = rows(c.S, 100); st.R = rows(c.S, 100); st.Files = { ...c.files }; st.cursor = 5;
      st.Guard = { ids: c.guard };
      const r = restorePlan(st, readLocalLists(lists), lists, c.keys ?? null);
      expect(r.plan).not.toBeNull();
      expect(r.count).toBe(c.count);
      expect(applyPlanToFolder(r.plan, lists)).toBe(true);
      expect(folderFiles(lists)).toEqual(sorted(c.after));
      if (c.filesAfter) expect(sorted({ ...st.Files, ...r.plan.files })).toEqual(sorted(c.filesAfter));
    });
  }
  for (const c of fx.replay) {
    it(`replay: ${c.name}`, async () => {
      const lists = folder(c);
      const st = newState();
      st.S = rows(c.S, 100); st.R = rows(c.S, 100); st.Files = { ...c.files }; st.cursor = 5; st.dbId = 'db1'; st.Shared = c.shared ?? [];
      const sent = [];
      // a server that has everything (S) and answers with nothing new
      const transport = async (body) => {
        sent.push(...body.changes);
        return { status: 200, data: { cursor: 5, more: false, changes: [], rejected: [], serverTime: Date.now(), dbId: 'db1' } };
      };
      const start = Date.now();
      const rewritten = [];
      for (const sec of c.cycles) {
        const res = await syncCycle({
          state: st, statePath: join(lists, '..', 'state.json'), listsDir: lists, transport, deviceId: 'replay', settleMs: 0,
          clock: () => start + sec * 1000, applyPlan: (plan) => applyPlanToFolder(plan, lists),
        });
        expect(res.status).toBe('synced');
        for (const x of res.rewritten ?? []) rewritten.push(`${x.name} ${x.count}`);
      }
      expect(folderFiles(lists)).toEqual(sorted(c.after));
      expect(st.Guard).toBeNull();
      expect(sent.filter((e) => e.fields.deleted?.v === true).map((e) => `${e.kind}:${e.id}`)).toEqual([]);
      expect(rewritten.sort()).toEqual(c.rewritten.map(([n, k]) => `${n} ${k}`).sort());
    });
  }
});

// ---------------------------------------------------------------- "Use with AI"
describe('ai-prompt.json: aiPrompt (local/ai-prompt.mjs; desktop/rules.ps1 Get-AiPrompt runs the same cases)', () => {
  const fx = load('ai-prompt.json');
  const expected = (name) => readFileSync(join(FIXTURES, 'ai-prompt', name), 'utf8');
  const dirOf = (name) => fx.cases.find((c) => c.file === name).dir;
  for (const c of fx.cases) {
    it(`${c.about}`, () => { expect(aiPrompt(c.dir)).toBe(expected(c.file)); });
  }
  for (const c of fx.same) {
    it(`the same text for ${c.dir}`, () => {
      expect(aiPrompt(c.dir)).toBe(expected(c.as).replace(dirOf(c.as), () => c.dir));
    });
  }
  it('says what an assistant needs to know', () => {
    const t = aiPrompt('/x/lists');
    for (const s of ['[ ]', '[/]', '[x]', '[>]', '[!]', '[-]', '[~]', 'due:YYYY-MM-DDTHH:MM', '`> `', '^xxxxxxxx', '.order', 'Never delete', 'Never rewrite a whole file']) {
      expect(t, s).toContain(s);
    }
    expect(t.endsWith('\n') && !t.includes('\r') && !t.startsWith('﻿')).toBe(true);
  });
});

// ---------------------------------------------------------------- the app updater
describe('update.json: the updater\'s rules (local/update.mjs; desktop/update-core.ps1 runs the same cases)', () => {
  const fx = load('update.json');
  it('compareVersions', () => {
    expect(fx.compareVersions.map(([a, b]) => compareVersions(a, b))).toEqual(fx.compareVersions.map((c) => c[2]));
  });
  it('checkManifest', () => {
    for (const c of fx.manifest) expect(checkManifest(c.in), JSON.stringify(c.in)).toEqual(c.out);
  });
  it('updateDecision', () => {
    for (const c of fx.decision) expect(updateDecision(c), JSON.stringify(c)).toBe(c.out);
  });
});
