// The apps' words (worker/public/js/lang/*.js, docs/architecture.md "Languages"): every language has exactly
// English's keys, the same {placeholders} and <b> parts; the files stay plain JSON inside (the Windows app reads them
// with ConvertFrom-Json); every key the code asks for exists; and the main UI files have no English left in them.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { LANGS, LANG_NAMES, pickLang, translator, setLang, t, dueText, quickDatesText } from '../../public/js/i18n.js';
import { textsFor } from '../../src/texts.js';
import en from '../../public/js/lang/en.js';

const root = new URL('../../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const LANG_DIR = 'worker/public/js/lang/';
const files = readdirSync(new URL(LANG_DIR, root)).filter((f) => f.endsWith('.js')).sort();

/** A language file as the Windows app reads it: the JSON after `export default`. */
function body(code) {
  const src = read(`${LANG_DIR}${code}.js`);
  expect(src, `${code}.js: header comments, then export default {...};`).toMatch(/^(\/\/[^\n]*\n)*export default \{\n[\s\S]*\n\};\n$/);
  return JSON.parse(src.slice(src.indexOf('{', src.indexOf('export default')), src.lastIndexOf('}') + 1));
}
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...s.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort();

describe('the language files', () => {
  it('are the five languages the apps offer, each named in itself', () => {
    expect(files).toEqual(LANGS.map((c) => `${c}.js`).sort());
    for (const code of LANGS) expect(body(code)['lang.name'], code).toBe(LANG_NAMES[code]);
  });

  it('are plain JSON inside, with keys PowerShell can tell apart (no two differ only in case)', () => {
    for (const code of LANGS) {
      const d = body(code);
      const lower = new Set();
      for (const [k, v] of Object.entries(d)) {
        expect(k, `${code}: ${k}`).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
        expect(lower.has(k.toLowerCase()), `${code}: ${k} twice (ignoring case)`).toBe(false);
        lower.add(k.toLowerCase());
        expect(typeof v === 'string' && v.trim().length > 0, `${code}: ${k} is empty`).toBe(true);
      }
    }
  });

  it('have exactly the keys of English, in its order', () => {
    const keys = Object.keys(en);
    for (const code of LANGS.filter((c) => c !== 'en')) {
      const d = body(code);
      expect(keys.filter((k) => !(k in d)), `${code}: missing`).toEqual([]);
      expect(Object.keys(d).filter((k) => !(k in en)), `${code}: not in English`).toEqual([]);
      expect(Object.keys(d), `${code}: order`).toEqual(keys);
    }
  });

  it('keep every {placeholder} and <b> part of the English', () => {
    for (const code of LANGS.filter((c) => c !== 'en')) {
      const d = body(code);
      for (const [k, v] of Object.entries(en)) {
        if (!(k in d)) continue;
        expect(vars(d[k]), `${code}: ${k}`).toEqual(vars(v));
        expect(tags(d[k]), `${code}: ${k}`).toEqual(tags(v));
      }
    }
  });

  it('have both forms of every count', () => {
    for (const k of Object.keys(en)) {
      if (k.endsWith('.one')) expect(`${k.slice(0, -4)}.other` in en, k).toBe(true);
      if (k.endsWith('.other')) expect(`${k.slice(0, -6)}.one` in en, k).toBe(true);
    }
  });
});

describe('picking and using a language', () => {
  it('the choice in Settings, else the first of the device languages the app has, else English', () => {
    expect(pickLang('ka', ['de-DE'])).toBe('ka');
    expect(pickLang('', ['pt-BR', 'fr-CA', 'de'])).toBe('fr');
    expect(pickLang('', ['ka_GE'])).toBe('ka');
    expect(pickLang('xx', ['pt'])).toBe('en');
    expect(pickLang(undefined, undefined)).toBe('en');
  });

  it('fills placeholders, picks a count form, falls back to English and then to the key', () => {
    const tr = translator('fr', { 'x.n.one': '{n} tâche', 'x.n.other': '{n} tâches' });
    expect(tr.tn('x.n', 0)).toBe('0 tâche');   // (French: 0 and 1 are "one")
    expect(tr.tn('x.n', 2)).toBe('2 tâches');
    expect(tr.t('date.today')).toBe('Today');
    expect(tr.t('no.such.key')).toBe('no.such.key');
    expect(translator('en').t('remind.overdueSince', { time: '9:30' })).toBe('Overdue since 9:30');
    expect(translator('en').rich('join.app.text')[0]).toEqual({ tag: 'b', text: 'On a computer' });
  });

  it("the Worker's words: any code it is given, English for the ones the apps do not have", () => {
    expect(textsFor('ka').t('date.today')).toBe(body('ka')['date.today']);
    expect(textsFor('de-AT').lang).toBe('de');
    expect(textsFor('').t('remind.test')).toBe('Notifications are working.');
    expect(textsFor(undefined).lang).toBe('en');
  });

  it("dates: English keeps the app's forms; the others use their own weekday and month names", async () => {
    const now = new Date(2026, 9, 14, 9, 0);
    await setLang('en');
    expect([dueText('2026-10-14', now), dueText('2026-10-16', now), dueText('2026-11-20', now)]).toEqual(['Today', 'Fri', '20 Nov']);
    expect(quickDatesText(now).map((q) => q.hint)).toEqual(['Wed 14 Oct', 'Thu 15 Oct', 'Mon 19 Oct', 'Wed 21 Oct']);
    await setLang('ka');
    expect(dueText('2026-10-14', now)).toBe(body('ka')['date.today']);
    expect(dueText('2026-10-16', now)).toBe('პარ');
    expect(t('status.done')).toBe(body('ka')['status.done']);
    await setLang('de');
    expect(dueText('2026-11-20', now)).toBe('20. Nov.');
    await setLang('en');
  });

  it("a browser without the language's date data gets the names from the language file", async () => {
    for (const code of LANGS) {
      const d = body(code);
      expect(d['date.wdShort'].split(','), code).toHaveLength(7);
      expect(d['date.wdLong'].split(','), code).toHaveLength(7);
      expect(d['date.monShort'].split(','), code).toHaveLength(12);
      expect(d['date.monLong'].split(','), code).toHaveLength(12);
    }
    const real = Intl.DateTimeFormat.supportedLocalesOf;
    Intl.DateTimeFormat.supportedLocalesOf = () => [];
    try {
      const now = new Date(2026, 9, 14, 9, 0);
      await setLang('ka');
      expect(dueText('2026-10-16', now)).toBe('პარ');
      expect(dueText('2026-11-20', now)).toBe('20 ნოე');
      expect(dueText('2027-01-02', now)).toBe('2 იან 2027');
      expect(quickDatesText(now)[2].hint).toBe('ორშ, 19 ოქტ');
    } finally {
      Intl.DateTimeFormat.supportedLocalesOf = real;
      await setLang('en');
    }
  });
});

// ---------------------------------------------------------------- the code asks only for keys that exist
const JS_FILES = ['worker/public/js/app.js', 'worker/public/js/store.js', 'worker/public/js/join.js', 'worker/src/reminders.js', 'worker/src/index.js', 'local/saqme.mjs'];
const PS_FILES = ['desktop/widget.ps1', 'desktop/rules.ps1', 'desktop/i18n.ps1'];

describe('the keys the code uses', () => {
  it('exist in English (keys written out in full; built ones are checked by their prefix)', () => {
    const missing = [];
    const known = (k) => k in en || `${k}.one` in en;
    for (const f of JS_FILES) {
      for (const [, k] of read(f).matchAll(/\b(?:t|tn|rich)\(\s*'([a-z][\w.]*)'/g)) if (!known(k)) missing.push(`${f}: ${k}`);
      for (const [, prefix] of read(f).matchAll(/\b(?:t|tn|rich)\(\s*`([a-z][\w.]*\.)\$\{/g)) {
        if (!Object.keys(en).some((k) => k.startsWith(prefix))) missing.push(`${f}: ${prefix}*`);
      }
    }
    for (const f of PS_FILES) {
      const code = read(f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // (not the examples in comments)
      for (const [, k] of code.matchAll(/\b(?:T|TN)\s+'([a-z][\w.]*)'/g)) if (!known(k)) missing.push(`${f}: ${k}`);
    }
    for (const [, k] of read('worker/public/join.html').matchAll(/data-t(?:-rich)?="([^"]+)"/g)) if (!known(k)) missing.push(`join.html: ${k}`);
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------- no English left in the main UI files
// A text a person reads: a capitalised word followed by more words ("Pair phone", "No connection."), or a lone
// capitalised word handed to a label, button, tooltip or screen-reader name. Not: code, selectors, paths, log lines.
const PROSE = /^[A-Z][a-z’']+(?:[ ,.:;!?…/-]+[A-Za-z’'()…]+)+[.!?…:]?$/;
const LABEL_PROPS = /(?:'aria-label'|'aria-description'|title|placeholder|alt|label|Text|Content|ToolTip|Header|Name|Help)\s*[:=]\s*$/;
const NOT_UI = /console\.|log\(|Write-(?:Output|Host|Verbose)|throw |new Error\(|HttpError\(|SMOKE|Check |Fail |Assert|\bdescribe\(|querySelector|waitFor/;

function literals(src, { ps }) {
  const out = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const code = ps ? line.replace(/(^|\s)#(?![^'"]*['"][^'"]*$).*$/, '$1') : line.replace(/(^|[^:'"`])\/\/.*$/, '$1');
    if (/^\s*(\*|\/\*|#|<#)/.test(code) || NOT_UI.test(code)) return;
    for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const s = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}|\$\([^)]*\)|\$\w+/g, 'X').trim();
      const before = code.slice(0, m.index);
      if (PROSE.test(s) || (/^[A-Z][a-z]{2,}$/.test(s) && LABEL_PROPS.test(before))) out.push(`${i + 1}: ${m[0].slice(0, 100)}`);
    }
  });
  return out;
}

// Literals that look like English but are not words for people (each with its reason). Keep this short.
const ALLOWED = [
  /^[`'"]Saqme To Do/,                         // the product's name (and its version line)
  /^'(Claude|ChatGPT|Claude Desktop)'$/,       // product names
  /^`Bearer \$\{/,                             // an HTTP header
  /^[`']Enter \/ (Space'|\$\{down\}`)$/,       // keys as printed on the keyboard
  /^'((Up|Down|Left|Right|Home|End)( \/ )?)+'$/,   // the same (widget.ps1 turns the arrows' names into its words)
  /^'(Saqme\.ToDo|Saqme\.AccessibleBorder|General\.md|Saqme To Do\.lnk|Segoe UI|Manual|Height)'$/,   // an id, a type, files, a font, WPF values
  /^"Saqme To Do \$\(/,                         // the version line
];
// widget.ps1's self-check (the end of the file, -SmokeTest) finds controls by their English names: not words for people
const uiPart = (f, src) => (f.endsWith('widget.ps1') ? src.slice(0, src.search(/^if \(\$SmokeTest\) \{$/m)) : src);

describe('no English left in the main UI files', () => {
  for (const f of ['worker/public/js/app.js', 'worker/public/js/store.js', 'worker/public/js/join.js', 'desktop/widget.ps1']) {
    it(f, () => {
      const left = literals(uiPart(f, read(f)), { ps: f.endsWith('.ps1') }).filter((l) => !ALLOWED.some((re) => re.test(l.replace(/^\d+: /, ''))));
      expect(left).toEqual([]);
    });
  }

  it('index.html: no labels of its own (the app sets them in its language)', () => {
    const html = read('worker/public/index.html');
    expect([...html.matchAll(/(?:aria-label|placeholder|title)="([^"]+)"/g)].map((m) => m[1]).filter((s) => /[a-z]{3}/.test(s))).toEqual([]);
  });

  it("join.html: every text has a key, and its English is the key's (what shows without JavaScript)", () => {
    const html = read('worker/public/join.html');
    const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    for (const [, tag, key, text] of html.matchAll(/<(\w+)[^>]*\bdata-t(?:-rich)?="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
      expect(decode(text), `${tag} ${key}`).toBe(decode(translator('en').t(key, { move: t('share.moveToApp') })));
    }
    // what is left outside the keyed elements: the install commands and the product's name only
    const rest = html.replace(/<head>[\s\S]*<\/head>/, '').replace(/<(\w+)[^>]*\bdata-t(?:-rich)?="[^"]+"[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
    expect(decode(rest)).toBe('');
  });
});

describe('the PowerShell files', () => {
  it('stay ASCII outside comments (Windows PowerShell reads them in the ANSI code page)', () => {
    for (const f of [...PS_FILES, 'desktop/sync-core.ps1', 'desktop/sync-worker.ps1']) {
      const bad = read(f).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /[^\x00-\x7f]/.test(l) && !/^\s*#/.test(l));
      expect(bad.map(([n]) => `${f}:${n}`)).toEqual([]);
    }
  });
});
