import { describe, it, expect } from 'vitest';
import {
  parseItems, formatItems, splitTaskText, setMissingIds, toFileName, listTree, treeToMarkdown, newTaskId, removeItemKeepChildren, findItem,
} from '../../public/js/markdown.js';
import { makeZip, readZip, crc32 } from '../../public/js/zip.js';

const LIST = [
  '# Sprint',
  '- [ ] Ship the roadmap due:2026-10-25T14:00 ^k3j9x2ab',
  '  - [x] Collect feedback ^aa11bb22',
  '    > a note with https://example.com',
  '    > second line',
  '  - [/] Write the migration section ^cc33dd44',
  '- [>] Clean up dashboards ^ee55ff66',
  '- [!] Legal sign-off due:2026-11-02 ^gg77hh88',
  '- [-] Try the new CI ^ii99jj00',
  '- [~] Old idea ^kk11ll22',
  '- [ ] ბიუჯეტის განხილვა ნინოსთან ^mm33nn44',
  '',
  'Some prose stays as it is.',
  '',
].join('\n');

describe('markdown list format (same rules as desktop/sync-core.ps1)', () => {
  it('round-trips a list byte for byte', () => {
    expect(formatItems(parseItems(LIST))).toBe(LIST);
  });

  it('reads every part of a task line', () => {
    const items = parseItems(LIST);
    expect(items[0]).toMatchObject({ kind: 'raw', raw: '# Sprint' });
    expect(items[1]).toMatchObject({ kind: 'task', level: 0, mark: ' ', text: 'Ship the roadmap', due: '2026-10-25', dueTime: '14:00', id: 'k3j9x2ab' });
    expect(items[2]).toMatchObject({ level: 1, mark: 'x', notes: 'a note with https://example.com\nsecond line' });
    expect(items.filter((i) => i.kind === 'task').map((i) => i.mark).join('')).toBe(' x/>!-~ ');
  });

  it('accepts what editors and AI assistants write', () => {
    const items = parseItems('﻿* [X] Done thing\r\n\t- plain bullet\r\n- [?] odd mark ^abcdefgh due:2026-01-05t9:05\r\n');
    expect(items.map((i) => [i.level, i.mark, i.text, i.id, i.due, i.dueTime])).toEqual([
      [0, 'x', 'Done thing', '', '', ''],
      [1, ' ', 'plain bullet', '', '', ''],
      [0, ' ', 'odd mark', 'abcdefgh', '2026-01-05', '9:05'],
    ]);
    // an unknown status counts as to do, and stays as written
    expect(formatItems(items)).toBe('- [x] Done thing\n  - [ ] plain bullet\n- [?] odd mark due:2026-01-05T9:05 ^abcdefgh\n');
  });

  it('id and deadline in either order; invalid times are dropped', () => {
    expect(splitTaskText('Call ^abc12345 due:2026-10-25')).toEqual({ text: 'Call', due: '2026-10-25', dueTime: '', id: 'abc12345' });
    expect(splitTaskText('Call due:2026-10-25T25:00')).toEqual({ text: 'Call', due: '2026-10-25', dueTime: '', id: '' });
    expect(splitTaskText('Price ^ is high')).toEqual({ text: 'Price ^ is high', due: '', dueTime: '', id: '' });
  });

  it('gives missing ids, re-attaching ones an editor dropped (by text)', () => {
    const items = parseItems('- [ ] Kept ^keptid01\n- [ ] Lost marker\n- [ ] Brand new\n- [ ] Dup ^keptid01\n');
    const changed = setMissingIds(items, new Map([['Lost marker', 'lostid01']]), new Set());
    expect(changed).toBe(true);
    const ids = items.map((i) => i.id);
    expect(ids[0]).toBe('keptid01');
    expect(ids[1]).toBe('lostid01');
    expect(ids[2]).toMatch(/^[a-z][0-9a-z]{7}$/);
    expect(ids[3]).not.toBe('keptid01');   // a duplicate gets a fresh id
    expect(new Set(ids).size).toBe(4);
  });

  it('removing a task keeps its subtasks (one level up)', () => {
    const items = parseItems('- [ ] A ^aaaaaaaa\n  - [ ] B ^bbbbbbbb\n    - [ ] C ^cccccccc\n');
    removeItemKeepChildren(items, findItem(items, 'aaaaaaaa'));
    expect(formatItems(items)).toBe('- [ ] B ^bbbbbbbb\n  - [ ] C ^cccccccc\n');
  });

  it('file names that work on every system', () => {
    expect(toFileName('Work / Q4: plan?')).toBe('Work  Q4 plan');
    expect(toFileName('con')).toBe('Project con');
    expect(toFileName('Trailing dots...')).toBe('Trailing dots');
    expect(toFileName('')).toBe('Project');
  });

  it('task trees: headings end nesting, and trees write back as lists', () => {
    const tree = listTree('- [ ] A ^aaaaaaaa\n  - [x] B ^bbbbbbbb\n## Later\n  - [ ] C ^cccccccc\n');
    expect(tree.map((n) => [n.text, n.kids.map((k) => k.text)])).toEqual([['A', ['B']], ['C', []]]);
    expect(treeToMarkdown(tree)).toBe('- [ ] A ^aaaaaaaa\n  - [x] B ^bbbbbbbb\n- [ ] C ^cccccccc\n');
    expect(newTaskId()).toMatch(/^[a-z][0-9a-z]{7}$/);
  });
});

describe('zip (export / import)', () => {
  it('writes and reads back UTF-8 names and text', async () => {
    const files = [
      { name: 'Work.md', text: `${LIST}${'x'.repeat(500)}\n` },
      { name: 'სახლი.md', text: '- [ ] ბიუჯეტი\n' },
      { name: '.order', text: 'Work\nსახლი\n' },
    ];
    const zip = await makeZip(files);
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(await readZip(zip)).toEqual(files);
  });
  it('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
  it('refuses something that is not a zip', async () => {
    await expect(readZip(new TextEncoder().encode('hello'))).rejects.toThrow(/not a zip/);
  });
});
