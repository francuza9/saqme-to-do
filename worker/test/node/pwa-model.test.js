import { describe, it, expect } from 'vitest';
import { parseDue, parseDueDate, dueLabel, dueTone, fmtDate, quickDates } from '../../public/js/dates.js';
import { buildTree, sections, kidsInDisplayOrder, positionAt, linkify, cleanProjectName, openCount, newId, rank } from '../../public/js/model.js';

// Wednesday 2026-10-21 15:30 local
const NOW = new Date(2026, 9, 21, 15, 30);
const d = (s) => (s ? fmtDate(s) : s);

describe('deadline parsing (same rules as the desktop widget)', () => {
  it('relative words and offsets', () => {
    expect(d(parseDueDate('today', NOW))).toBe('2026-10-21');
    expect(d(parseDueDate('tmr', NOW))).toBe('2026-10-22');
    expect(d(parseDueDate('+3', NOW))).toBe('2026-10-24');
    expect(d(parseDueDate('+2w', NOW))).toBe('2026-11-04');
    expect(d(parseDueDate('fri', NOW))).toBe('2026-10-23');
    expect(d(parseDueDate('wednesday', NOW))).toBe('2026-10-28');   // strictly after today
  });
  it('calendar formats, rolling past dates into next year', () => {
    expect(d(parseDueDate('25 oct', NOW))).toBe('2026-10-25');
    expect(d(parseDueDate('Oct 25', NOW))).toBe('2026-10-25');
    expect(d(parseDueDate('25 October 2027', NOW))).toBe('2027-10-25');
    expect(d(parseDueDate('25.10', NOW))).toBe('2026-10-25');
    expect(d(parseDueDate('3/1', NOW))).toBe('2027-01-03');           // >30 days ago -> next year
    expect(d(parseDueDate('2026-02-01', NOW))).toBe('2026-02-01');    // explicit year stays
    expect(parseDueDate('31.02', NOW)).toBeNull();
    expect(parseDueDate('someday', NOW)).toBeNull();
  });
  it('times', () => {
    expect(parseDue('fri 14:00', NOW)).toEqual({ date: '2026-10-23', time: '14:00' });
    expect(parseDue('25 oct 9:30', NOW)).toEqual({ date: '2026-10-25', time: '9:30' });
    expect(parseDue('3pm', NOW)).toEqual({ date: '2026-10-22', time: '15:00' });   // already past today
    expect(parseDue('16:00', NOW)).toEqual({ date: '2026-10-21', time: '16:00' });
    expect(parseDue('tomorrow at 12am', NOW)).toEqual({ date: '2026-10-22', time: '0:00' });
    expect(parseDue('fri 25:00', NOW)).toBeNull();
    expect(parseDue('+3', NOW)).toEqual({ date: '2026-10-24', time: '' });
  });
  it('labels and tones', () => {
    expect(dueLabel('2026-10-21', NOW)).toBe('Today');
    expect(dueLabel('2026-10-22', NOW)).toBe('Tomorrow');
    expect(dueLabel('2026-10-20', NOW)).toBe('Yesterday');
    expect(dueLabel('2026-10-24', NOW)).toBe('Sat');
    expect(dueLabel('2026-12-24', NOW)).toBe('24 Dec');
    expect(dueLabel('2027-01-02', NOW)).toBe('2 Jan 2027');
    expect(dueTone({ date: '2026-10-21', time: '15:00' }, false, NOW)).toBe('over');
    expect(dueTone({ date: '2026-10-21', time: '' }, false, NOW)).toBe('soon');
    expect(dueTone({ date: '2026-10-30', time: '' }, false, NOW)).toBe('later');
    expect(dueTone({ date: '2026-10-01', time: '' }, true, NOW)).toBe('closed');
    expect(quickDates(NOW).map((q) => q.date)).toEqual(['2026-10-21', '2026-10-22', '2026-10-26', '2026-10-28']);
  });
});

const T = (id, { parent = null, pos = 'a0', status = ' ', project = 'p1', deleted = false, text = id } = {}) => ({
  id, fields: { place: { v: { project, parent, pos } }, text: { v: text }, status: { v: status }, deleted: { v: deleted }, due: { v: null }, notes: { v: '' } },
});

describe('task tree', () => {
  it('nests, sorts by position and splits sections like the desktop', () => {
    const tasks = [T('b', { pos: 'a2' }), T('a', { pos: 'a1' }), T('c', { pos: 'a3', status: '>' }), T('d', { pos: 'a4', status: 'x' }),
      T('a2', { parent: 'a', pos: 'a2', status: 'x' }), T('a1', { parent: 'a', pos: 'a1', status: '>' }), T('a3', { parent: 'a', pos: 'a3' }),
      T('other', { project: 'p2' })];
    const tree = buildTree(tasks, 'p1');
    const s = sections(tree);
    expect(s.active.map((n) => n.id)).toEqual(['a', 'b']);
    expect(s.postponed.map((n) => n.id)).toEqual(['c']);
    expect(s.closed.map((n) => n.id)).toEqual(['d']);
    expect(kidsInDisplayOrder(tree.byId.get('a')).map((n) => n.id)).toEqual(['a3', 'a1', 'a2']);
    expect(tree.byId.get('a3').depth).toBe(1);
    expect(openCount(tasks, 'p1')).toBe(3);
  });

  it('re-homes orphans under the nearest live ancestor', () => {
    const tasks = [T('g'), T('p', { parent: 'g', deleted: true }), T('c', { parent: 'p' }), T('x', { parent: 'elsewhere' }),
      T('y', { parent: 'z' }), T('z', { project: 'p2' })];
    const tree = buildTree(tasks, 'p1');
    expect(tree.byId.get('c').parent.id).toBe('g');
    expect(tree.roots.map((n) => n.id).sort()).toEqual(['g', 'x', 'y']);
  });

  it('survives corrupt cycles', () => {
    const tree = buildTree([T('a', { parent: 'b' }), T('b', { parent: 'a' }), T('c', { parent: 'a' })], 'p1');
    expect(tree.byId.size).toBe(3);
    expect(tree.roots).toHaveLength(1);
  });

  it('computes insert positions, re-keying only on ties', () => {
    const tree = buildTree([T('a', { pos: 'a1' }), T('b', { pos: 'a2' }), T('c', { pos: 'a2' })], 'p1');
    const end = positionAt(tree.roots, 3);
    expect(end.pos > 'a2').toBe(true);
    expect(end.rekeys).toEqual([]);
    const mid = positionAt(tree.roots, 2);   // between two equal keys
    expect(mid.rekeys.length).toBeGreaterThan(0);
    // "to the end" of the list the task is already in (index counted before excluding it)
    const self = positionAt(tree.roots, 3, 'a');
    expect(self.pos > 'a2').toBe(true);
  });
});

describe('key rebalancing', () => {
  it('keeps keys short when inserting at the same spot hundreds of times', () => {
    let tasks = [T('first', { pos: 'a0' }), T('last', { pos: 'a1' })];
    let maxLen = 0;
    for (let i = 0; i < 800; i++) {
      const tree = buildTree(tasks, 'p1');
      const { pos, rekeys } = positionAt(tree.roots, 1);   // always right after "first"
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const [id, k] of rekeys) byId.get(id).fields.place.v.pos = k;
      tasks.push(T(`n${i}`, { pos }));
      maxLen = Math.max(maxLen, pos.length, ...rekeys.map(([, k]) => k.length));
    }
    expect(maxLen).toBeLessThanOrEqual(48);
    const order = buildTree(tasks, 'p1').roots.map((n) => n.id);
    expect(order[0]).toBe('first');
    expect(order[1]).toBe('n799');
    expect(order[order.length - 1]).toBe('last');
  });
});

describe('misc helpers', () => {
  it('linkify', () => {
    expect(linkify('see https://a.b/c and www.x.org.')).toEqual([
      { text: 'see ' }, { url: 'https://a.b/c', text: 'https://a.b/c' }, { text: ' and ' },
      { url: 'https://www.x.org.', text: 'www.x.org.' }]);
  });
  it('project names are file-safe', () => {
    expect(cleanProjectName(' Work/Home: "Q4"?.. ')).toBe('WorkHome Q4');
  });
  it('ids are 8 base36 chars starting with a letter', () => {
    for (let i = 0; i < 200; i++) expect(newId()).toMatch(/^[a-z][0-9a-z]{7}$/);
  });
  it('rank', () => {
    expect([' ', '/', '!', '>', 'x', '-', '~'].map(rank)).toEqual([0, 0, 0, 1, 2, 2, 2]);
  });
});
