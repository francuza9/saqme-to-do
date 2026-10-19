// Deadline parsing and labels. The Windows widget has the same rules in desktop/rules.ps1; both are checked
// against shared/fixtures/dates.json. Dates are local calendar dates as 'YYYY-MM-DD' strings; times are 'H:MM'.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n) => String(n).padStart(2, '0');
export const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function toDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const today = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a, b) => Math.round((b - a) / 86_400_000);
/** 'YYYY-MM-DDTHH:MM:SS' of a moment on the local wall clock (compares as a string). */
const wall = (d) => `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
/** Is date + h:mm earlier than now, on the wall clock? (Not as instants: a time inside a DST gap, such as
 *  2:30 on the night clocks go forward, is still 2:30 - as on the desktop.) */
const wallPassed = (dateStr, h, mi, now) => `${dateStr}T${pad(h)}:${pad(mi)}:00` < wall(now);

function validYmd(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/** A weekday: a prefix of its name of at least 3 letters ("fri", "frid", "friday"), or "weds". */
function weekdayIndex(word) {
  if (!/^[a-z]{3,9}$/.test(word)) return -1;
  const i = DAY_NAMES.findIndex((n) => n.toLowerCase().startsWith(word));
  return i >= 0 ? i : word === 'weds' ? 3 : -1;
}

function monthIndex(word) {
  if (!/^[a-z]{3,9}$/.test(word)) return -1;
  const i = MONTHS.indexOf(word.slice(0, 3));
  if (i < 0) return -1;
  const full = MONTH_NAMES[i].toLowerCase();
  return word.length === 3 || full === word || (i === 8 && word === 'sept') ? i : -1;
}

/** "today", "tmr", "+3", "+2w", "fri", "25 oct", "oct 25", "25.10", "25/10/2027", "2026-10-25" -> Date | null */
export function parseDueDate(input, now = new Date()) {
  const s = input.trim().toLowerCase();
  const t = today(now);
  if (!s) return null;
  if (s === 'today' || s === 'tod') return t;
  if (s === 'tomorrow' || s === 'tmr' || s === 'tom') return addDays(t, 1);
  let m;
  if ((m = /^\+(\d+)d?$/.exec(s))) return addDays(t, +m[1]);
  if ((m = /^\+(\d+)w$/.exec(s))) return addDays(t, 7 * +m[1]);
  const wd = weekdayIndex(s);
  if (wd >= 0) {
    let d = addDays(t, 1);   // strictly after today
    while (d.getDay() !== wd) d = addDays(d, 1);
    return d;
  }
  let y = null;
  let mo = null;
  let day = null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) [y, mo, day] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?$/.exec(s)) && monthIndex(m[2]) >= 0) [day, mo, y] = [+m[1], monthIndex(m[2]) + 1, m[3] ? +m[3] : null];
  else if ((m = /^([a-z]{3,9})\s+(\d{1,2})$/.exec(s)) && monthIndex(m[1]) >= 0) [mo, day] = [monthIndex(m[1]) + 1, +m[2]];
  else if ((m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/.exec(s))) [day, mo, y] = [+m[1], +m[2], m[3] ? +m[3] : null];
  else return null;
  const explicitYear = y !== null;
  const d = validYmd(explicitYear ? y : t.getFullYear(), mo, day);
  if (!d) return null;
  if (!explicitYear && d < addDays(t, -30)) return validYmd(d.getFullYear() + 1, mo, day);
  return d;
}

/** Accepts everything parseDueDate does plus a time: "fri 14:00", "25 oct 9:30", "3pm", "14:00".
 *  Returns { date: 'YYYY-MM-DD', time: 'H:MM' | '' } or null. */
export function parseDue(input, now = new Date()) {
  let s = input.trim().toLowerCase();
  const t = today(now);
  let time = '';
  if (!s) return null;
  const m = /^(.*?)\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(s) || /^(.*?)\s*(?:at\s*)?(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    let h = +m[2];
    const mi = m[3] ? +m[3] : 0;
    if (m[4] === 'pm' && h < 12) h += 12;
    if (m[4] === 'am' && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    time = `${h}:${pad(mi)}`;
    s = m[1].trim();
    if (!s) return { date: fmtDate(wallPassed(fmtDate(t), h, mi, now) ? addDays(t, 1) : t), time };   // passed: tomorrow
  }
  const d = parseDueDate(s, now);
  return d ? { date: fmtDate(d), time } : null;
}

export function dueLabel(dateStr, now = new Date()) {
  const d = toDate(dateStr);
  const t = today(now);
  const diff = daysBetween(t, d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return DAY_NAMES[d.getDay()].slice(0, 3);
  const base = `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
  return d.getFullYear() === t.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export function dueLong(due) {
  const d = toDate(due.date);
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}${due.time ? `, ${due.time}` : ''}`;
}

/** 'over' | 'soon' | 'later' | 'closed' — drives the pill colour like the desktop. */
export function dueTone(due, closed, now = new Date()) {
  if (closed) return 'closed';
  const diff = daysBetween(today(now), toDate(due.date));
  let over = diff < 0;
  if (due.time) {
    const [h, mi] = due.time.split(':').map(Number);
    over = wallPassed(due.date, h, mi, now);
  }
  if (over) return 'over';
  return diff <= 1 ? 'soon' : 'later';
}

/** Quick picks shown in the deadline sheet (same as the desktop popup). */
export function quickDates(now = new Date()) {
  const t = today(now);
  let mon = addDays(t, 1);
  while (mon.getDay() !== 1) mon = addDays(mon, 1);
  const short = (d) => `${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
  return [['Today', t], ['Tomorrow', addDays(t, 1)], ['Next Monday', mon], ['In a week', addDays(t, 7)]]
    .map(([label, d]) => ({ label, hint: short(d), date: fmtDate(d) }));
}
