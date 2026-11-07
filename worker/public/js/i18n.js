// The app's words in its languages. One file per language in js/lang/ (a module whose body is plain JSON, so the
// Windows app reads the same files: desktop/i18n.ps1); English is the fallback for anything missing, and every file
// has exactly the keys of en.js (worker/test/node/i18n.test.js). No DOM here: the Worker uses it too.
//   t('key', { name })        a message; {name} in it is filled in
//   tn('key', n, { ... })     a count: 'key.one' or 'key.other' (by Intl.PluralRules; {n} is filled in)
//   rich('key', { ... })      a message with <b>…</b> parts: [string | { tag, text }] for the caller to build
// Never translated: the user's own text (tasks, list names), the list format, the AI connector's tools.

import en from './lang/en.js';
import { dueLabel, dueLong, quickDates, today, toDate } from './dates.js';

export const LANGS = ['en', 'ka', 'fr', 'es', 'de'];
/** Each language by its own name (the picker shows them so: whoever needs one can read it). */
export const LANG_NAMES = { en: 'English', ka: 'ქართული', fr: 'Français', es: 'Español', de: 'Deutsch' };
const LOAD = {
  ka: () => import('./lang/ka.js'), fr: () => import('./lang/fr.js'), es: () => import('./lang/es.js'), de: () => import('./lang/de.js'),
};

/** The language to use: the one chosen in Settings, else the first of the device's that the app has, else English. */
export function pickLang(choice, preferred = []) {
  if (LANGS.includes(choice)) return choice;
  for (const p of [].concat(preferred ?? [])) {
    const code = String(p ?? '').toLowerCase().split(/[-_]/)[0];
    if (LANGS.includes(code)) return code;
  }
  return 'en';
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s);

/** A translator for one language: { lang, t, tn, rich }. table: that language's file (missing keys: English). */
export function translator(code, table = en) {
  const lang = LANGS.includes(code) ? code : 'en';
  const plural = new Intl.PluralRules(lang);
  const get = (key) => table[key] ?? en[key] ?? key;
  const t = (key, vars) => fill(get(key), vars);
  const tn = (key, n, vars) => {
    const cat = plural.select(n);
    const k = table[`${key}.${cat}`] != null || en[`${key}.${cat}`] != null ? `${key}.${cat}` : `${key}.other`;
    return fill(get(k), { n, ...vars });
  };
  const rich = (key, vars) => {
    const out = [];
    const re = /<(b|i|kbd)>(.*?)<\/\1>/g;
    const s = t(key, vars);
    let at = 0;
    for (let m; (m = re.exec(s));) {
      if (m.index > at) out.push(s.slice(at, m.index));
      out.push({ tag: m[1], text: m[2] });
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push(s.slice(at));
    return out;
  };
  return { lang, t, tn, rich };
}

// ---------------------------------------------------------------- the app's current language (phone app, join page)
let cur = translator('en', en);
export const lang = () => cur.lang;
export const t = (key, vars) => cur.t(key, vars);
export const tn = (key, n, vars) => cur.tn(key, n, vars);
export const rich = (key, vars) => cur.rich(key, vars);
/** Switches the app to a language (loading its file the first time; English if that fails, e.g. offline and never loaded). */
export async function setLang(code) {
  const lang = pickLang(code);
  let table = en;
  if (lang !== 'en') {
    try { table = (await LOAD[lang]()).default; } catch { return cur.lang; }
  }
  cur = translator(lang, table);
  return lang;
}

// ---------------------------------------------------------------- dates in the current language
// English keeps the app's own forms ("Fri", "17 Oct": dates.js, shared with the Windows app's fixtures); the other
// languages use Intl, which knows their weekday and month names.
/** The locale for Intl: the device's own when it is a variant of the app's language ("en-GB", "fr-CA"), else the language. */
export function locale() {
  const own = [].concat(globalThis.navigator?.languages ?? globalThis.navigator?.language ?? []);
  return own.find((l) => String(l).toLowerCase().split(/[-_]/)[0] === cur.lang) ?? cur.lang;
}
// A browser without the language's date data (Intl falls back to its own language: some WebViews and headless
// builds have no Georgian) gets the names from the language file instead: date.wdShort, date.monLong, …
const intlHas = (l) => { try { return Intl.DateTimeFormat.supportedLocalesOf([l]).length > 0; } catch { return false; } };
const names = (key, i) => t(key).split(',')[i] ?? '';
const pad2 = (n) => String(n).padStart(2, '0');
/** What Intl would say with these options, from the language file's names (the options the apps use). */
function ownFormat(opts, d) {
  if (opts.dateStyle) return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}${opts.timeStyle ? ` ${d.getHours()}:${pad2(d.getMinutes())}` : ''}`;
  const parts = [];
  if (opts.weekday) parts.push(names(opts.weekday === 'long' ? 'date.wdLong' : 'date.wdShort', d.getDay()));
  const day = [opts.day ? d.getDate() : '', opts.month ? names(opts.month === 'long' ? 'date.monLong' : 'date.monShort', d.getMonth()) : '', opts.year ? d.getFullYear() : '']
    .filter((x) => x !== '').join(' ');
  if (day) parts.push(day);
  if (opts.hour) parts.push(`${d.getHours()}:${pad2(d.getMinutes())}`);
  return parts.join(', ');
}
const fmt = (opts, d) => (intlHas(cur.lang) ? new Intl.DateTimeFormat(locale(), opts).format(d) : ownFormat(opts, d));

/** A deadline's short label: "Today", "Tomorrow", "Yesterday", a weekday within the week, else a date. */
export function dueText(dateStr, now = new Date()) {
  if (cur.lang === 'en') return dueLabel(dateStr, now);
  const d = toDate(dateStr);
  const diff = Math.round((d - today(now)) / 86_400_000);
  if (diff === 0) return t('date.today');
  if (diff === 1) return t('date.tomorrow');
  if (diff === -1) return t('date.yesterday');
  if (diff > 1 && diff < 7) return fmt({ weekday: 'short' }, d);
  return fmt(d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }, d);
}

/** A deadline in full: "Friday, 17 October 2026, 14:00". due: { date, time }. */
export function dueLongText(due) {
  if (cur.lang === 'en') return dueLong(due);
  const s = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, toDate(due.date));
  return due.time ? `${s}, ${due.time}` : s;
}

/** The deadline sheet's quick picks (as dates.js quickDates): [{ label, hint, date }]. */
const QUICK = ['date.today', 'date.tomorrow', 'date.nextMonday', 'date.inAWeek'];
export function quickDatesText(now = new Date()) {
  return quickDates(now).map((q, i) => ({
    label: t(QUICK[i]), date: q.date, hint: cur.lang === 'en' ? q.hint : fmt({ weekday: 'short', day: 'numeric', month: 'short' }, toDate(q.date)),
  }));
}

/** A moment (ms or Date) in the current language, with Intl options (e.g. { day: 'numeric', month: 'short' }). */
export const dateText = (at, opts) => fmt(opts, at instanceof Date ? at : new Date(at));
