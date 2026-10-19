// The markdown list format (docs/file-format.md), in JavaScript. Same reading and writing rules as
// desktop/sync-core.ps1 (Read-Items / ConvertTo-MarkdownText), so a list round-trips the same way through
// the Windows app, the Linux/macOS app (local/engine.mjs) and the phone app's export / import.
//
//   - [ ] Call the plumber due:2026-10-25T14:00 ^k3j9x2ab
//     > a note line under it
//
// An item is a task { kind: 'task', level, mark, text, due, dueTime, notes, id } or any other line
// { kind: 'raw', raw } kept verbatim (headings, blank lines, prose, front matter, code blocks). A status
// character the apps do not know (Obsidian's [?], [<] ...) counts as "to do" and stays as written (markRaw)
// while the task is to do.

export const MARKS = [' ', '/', 'x', '>', '!', '-', '~'];
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

// ---------------------------------------------------------------- value rules
// The same in every app and on the server (desktop/sync-core.ps1 has the PowerShell twins); checked against
// shared/fixtures/text.json by both test suites.

/** Task text: line breaks and tabs become spaces, no control characters, trimmed. */
export const cleanText = (s) => String(s).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();

/** Notes: no CR, no trailing spaces per line, no empty lines at the start or end. */
export function cleanNotes(s) {
  const lines = String(s).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** 'H:MM' from 'H:MM' / 'HH:MM', or '' when it is not a valid time. */
export function cleanTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? '');
  return m && +m[1] < 24 && +m[2] < 60 ? `${+m[1]}:${m[2]}` : '';
}

/** Trailing " ^id" and " due:YYYY-MM-DD[THH:MM]", in either order. */
export function splitTaskText(text) {
  let id = '';
  let due = '';
  let time = '';
  for (let pass = 0; pass < 2; pass++) {
    let m;
    if (!id && (m = /^(.*?)\s+\^([0-9a-z]{8,32})\s*$/s.exec(text))) { text = m[1]; id = m[2]; continue; }
    if (!due && (m = /^(.*?)\s+due:(\d{4}-\d{2}-\d{2})(?:T(\d{1,2}:\d{2}))?\s*$/is.exec(text))) {
      text = m[1]; due = m[2]; if (m[3]) time = cleanTime(m[3]); continue;
    }
    break;
  }
  return { text: text.trim(), due, dueTime: time, id };
}

function taskItem(ws, mark, text, markRaw = '') {
  const indent = ws.replace(/\t/g, '  ').length;
  return { kind: 'task', level: Math.floor(indent / 2), indent, mark, markRaw, ...splitTaskText(text), notes: '', raw: '' };
}
const rawItem = (raw) => ({ kind: 'raw', level: 0, mark: '', text: '', due: '', dueTime: '', notes: '', raw, id: '' });

/**
 * Lines that are never tasks or notes, whatever they look like: YAML front matter (--- at the very top up
 * to a closing --- or ...), fenced code blocks (``` or ~~~, only when closed) and thematic breaks (* * *).
 */
function verbatimLines(lines) {
  const out = new Set();
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((l, j) => j > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) { for (let j = 0; j <= end; j++) out.add(j); i = end + 1; }
  }
  for (; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (open) {
      const fence = open[1];
      const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) if (close.test(lines[j])) { end = j; break; }
      if (end > 0) { for (let j = i; j <= end; j++) out.add(j); i = end; continue; }
    }
    if (/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(lines[i])) out.add(i);
  }
  return out;
}

/**
 * Text of a list file -> items. A trailing newline does not make an extra blank item. Lines break at LF only
 * (s flags: a stray CR or U+2028 inside a task line does not turn the task into prose).
 */
export function parseItems(text) {
  const items = [];
  if (text == null) return items;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const verbatim = verbatimLines(lines);
  let last = null;
  lines.forEach((raw, i) => {
    let m;
    if (verbatim.has(i)) {
      last = null;
      items.push(rawItem(raw));
    } else if ((m = /^(\s*)[-*]\s+\[(.)\]\s?(.*)$/s.exec(raw))) {
      const mark = m[2] === 'X' ? 'x' : m[2];
      last = MARKS.includes(mark) ? taskItem(m[1], mark, m[3]) : taskItem(m[1], ' ', m[3], m[2]);
      items.push(last);
    } else if ((m = /^(\s*)[-*]\s+(.*)$/s.exec(raw))) {
      last = taskItem(m[1], ' ', m[2]);
      items.push(last);
    } else if (last && (m = /^(\s*)>\s?(.*)$/s.exec(raw)) && m[1].replace(/\t/g, '  ').length > last.indent) {
      // a note is indented deeper than its task; a quote at the task's own depth is a paragraph
      last.notes = last.notes === '' ? m[2] : `${last.notes}\n${m[2]}`;
    } else {
      last = null;
      items.push(rawItem(raw));
    }
  });
  return items;
}

export function formatTaskLine(it, level) {
  const mark = it.mark === ' ' && it.markRaw ? it.markRaw : it.mark;
  let line = `${'  '.repeat(level)}- [${mark}] ${it.text}`;
  if (it.due) { line += ` due:${it.due}`; if (it.dueTime) line += `T${it.dueTime}`; }
  if (it.id) line += ` ^${it.id}`;
  return line;
}

/**
 * The line ending a list file uses (its first line break): a file saved with CRLF stays CRLF when the apps
 * write it, so editing a task does not rewrite every line (git diffs, editors). New files get LF.
 */
export function detectEol(text) {
  const i = text?.indexOf('\n') ?? -1;
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/** Items -> file text (line ending `eol`, one trailing line break). Tasks without text are dropped. */
export function formatItems(items, baseLevel = 0, eol = '\n') {
  let out = '';
  for (const it of items) {
    if (it.kind !== 'task') { out += `${it.raw}${eol}`; continue; }
    if (it.text === '') continue;
    const lv = Math.max(0, it.level - baseLevel);
    out += `${formatTaskLine(it, lv)}${eol}`;
    if (it.notes) {
      const ind = '  '.repeat(lv + 1);
      for (const nl of it.notes.split('\n')) out += `${`${ind}> ${nl}`.replace(/\s+$/, '')}${eol}`;
    }
  }
  return out;
}

/** Index after the subtree of items[i] (its deeper task lines). */
export function subtreeEnd(items, i) {
  const lv = items[i].level;
  let j = i + 1;
  while (j < items.length && items[j].kind === 'task' && items[j].level > lv) j++;
  return j;
}

export function findItem(items, id) {
  return items.findIndex((it) => it.kind === 'task' && it.id === id);
}

/** Drops one task; its subtasks move up a level. */
export function removeItemKeepChildren(items, i) {
  const end = subtreeEnd(items, i);
  for (let k = i + 1; k < end; k++) items[k].level -= 1;
  items.splice(i, 1);
}

/** A new task id: 8 characters of [0-9a-z], starting with a letter (like the desktop's New-SaqmeId). */
export function newTaskId(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = ID_ALPHABET[10 + (bytes[0] % 26)];
  for (let i = 1; i < len; i++) s += ID_ALPHABET[bytes[i] % 36];
  return s;
}

/**
 * Gives every task an id; id-less lines get back an id that vanished from this list when the text matches
 * (an editor that dropped the markers must not turn edits into delete + create). Returns true if changed.
 *   known: Map text -> id the list had before;  taken: Set of ids already used elsewhere.
 */
export function setMissingIds(items, known, taken) {
  let changed = false;
  const present = new Set(items.filter((it) => it.kind === 'task' && it.id).map((it) => it.id));
  const seen = new Set();
  for (const it of items) {
    if (it.kind !== 'task') continue;
    if (it.id && !seen.has(it.id) && !taken?.has(it.id)) { seen.add(it.id); continue; }
    let reuse = null;
    if (!it.id && known?.has(it.text)) {
      const cand = known.get(it.text);
      if (!present.has(cand) && !seen.has(cand) && !taken?.has(cand)) reuse = cand;
    }
    it.id = reuse ?? newTaskId();
    seen.add(it.id);
    changed = true;
  }
  return changed;
}

/**
 * A project (tab) name that is also a usable file name everywhere: no characters Windows forbids, no control
 * characters, no trailing dots or spaces, at most 100 characters. '' = not a usable name.
 * (Same rule: ConvertTo-ProjectName in desktop/sync-core.ps1; shared/fixtures/text.json.)
 */
export function cleanProjectName(name) {
  const tidy = (s) => s.trim().replace(/[. ]+$/, '').trim();
  let n = tidy(String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ''));
  if (n.length > 100) n = tidy(n.slice(0, 100));
  return n;
}

/** Project name -> its list file name; reserved device names (con, nul, lpt1...) and empty names get "Project ". */
export function toFileName(name) {
  const n = cleanProjectName(name);
  return !n || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n) ? `Project ${n}`.trim() : n;
}

/** A YYYY-MM-DD date that exists (years 1 to 9999). */
export function isValidDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d.startsWith('0000')) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

// ---------------------------------------------------------------- whole lists <-> task trees
/**
 * Tasks of one list as a tree in file order: [{ text, mark, due: { date, time } | null, notes, id, kids }].
 * Headings and prose are not tasks; a heading ends the nesting above it, as in the apps.
 */
export function listTree(text) {
  const roots = [];
  const stack = [];
  for (const it of parseItems(text)) {
    if (it.kind !== 'task') { stack.length = 0; continue; }
    if (!it.text) continue;
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
    const node = {
      level: it.level, text: it.text, mark: it.mark, id: it.id, notes: it.notes,
      due: it.due ? { date: it.due, time: it.dueTime } : null, kids: [],
    };
    (stack.length ? stack[stack.length - 1].kids : roots).push(node);
    stack.push(node);
  }
  return roots;
}

/** Task tree (as from listTree, or built from the app's rows) -> list file text. */
export function treeToMarkdown(roots) {
  const items = [];
  const walk = (nodes, level) => {
    for (const n of nodes) {
      items.push({ kind: 'task', level, mark: n.mark, text: n.text || '(untitled)', due: n.due?.date ?? '', dueTime: n.due?.time ?? '', notes: n.notes ?? '', id: n.id ?? '' });
      walk(n.kids ?? [], level + 1);
    }
  };
  walk(roots, 0);
  return formatItems(items);
}
