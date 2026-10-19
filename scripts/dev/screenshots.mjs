#!/usr/bin/env node
// Phone screenshots of the PWA (390x844 @3x, dark + light) with the sample lists from scripts/dev/sample,
// against a local `npm run dev` server (fresh database recommended). Playwright is not a dependency of this
// repo: run this from a folder where it is installed, e.g.
//   mkdir /tmp/pw && cd /tmp/pw && npm i playwright@1 && npx playwright install chromium
//   node <repo>/scripts/dev/screenshots.mjs --out ~/shots [--prefix phone] [--base http://localhost:8787]
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };

export function loadPlaywright() {
  try { return createRequire(join(process.cwd(), 'x.js'))('playwright'); } catch {
    console.error('Playwright not found in the current folder (npm i playwright@1 && npx playwright install chromium).');
    process.exit(2);
  }
}
// en_GB: 24-hour time fields, as on most phones outside the US (the context locale alone does not change them)
export const launch = (playwright) => playwright.chromium.launch({ env: { ...process.env, LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8' } });
export const devToken = () => /^AUTH_TOKEN=(.*)$/m.exec(readFileSync(join(repo, 'worker', '.dev.vars'), 'utf8'))[1];

// ---------------------------------------------------------------- sample lists -> sync changes
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const idFor = (s) => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return `s${(h >>> 0).toString(36).padStart(7, '0').slice(-7)}`; };

function parseSample(name, text, projectId) {
  const tasks = [];
  const stack = [];
  let last = null;
  let n = 0;
  for (const raw of text.replace(/due:\{([+-]?\d+)\}/g, (_, d) => `due:${inDays(+d)}`).split('\n')) {
    const m = /^(\s*)- \[(.)\] (.*?)(?: due:(\d{4}-\d{2}-\d{2})(?:T(\d{1,2}:\d{2}))?)?$/.exec(raw);
    if (m) {
      const level = m[1].length / 2;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const id = idFor(`${name}/${m[3]}`);
      last = { id, level, parent: stack.length ? stack[stack.length - 1].id : null, status: m[2], text: m[3],
        due: m[4] ? { date: m[4], time: m[5] || '' } : null, notes: '', pos: `a${(n++).toString(36)}` };
      tasks.push(last); stack.push(last);
    } else if (last && /^\s*> ?/.test(raw)) last.notes += (last.notes ? '\n' : '') + raw.replace(/^\s*> ?/, '');
  }
  const ts = Date.now();
  const f = (v) => ({ v, ts });
  return tasks.map((t) => ({ kind: 'task', id: t.id, fields: {
    place: f({ project: projectId, parent: t.parent, pos: t.pos }), text: f(t.text), status: f(t.status), due: f(t.due), notes: f(t.notes) } }));
}

/** Uploads the sample lists (deterministic ids, so running it twice changes nothing). Returns project name -> id. */
export async function seed(base, token) {
  const sampleDir = join(repo, 'scripts', 'dev', 'sample');
  const order = readFileSync(join(sampleDir, '.order'), 'utf8').split('\n').filter(Boolean);
  const changes = [];
  const projectIds = {};
  order.forEach((name, i) => {
    const id = idFor(`project/${name}`);
    projectIds[name] = id;
    changes.push({ kind: 'project', id, fields: { name: { v: name, ts: Date.now() }, pos: { v: `a${i}`, ts: Date.now() } } });
  });
  for (const file of readdirSync(sampleDir).filter((f) => f.endsWith('.md'))) {
    const name = file.slice(0, -3);
    changes.push(...parseSample(name, readFileSync(join(sampleDir, file), 'utf8'), projectIds[name]));
  }
  const res = await fetch(`${base}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'screenshots', cursor: 0, changes }) });
  if (!res.ok) throw new Error(`seeding failed: ${res.status} ${await res.text()}`);
  return projectIds;
}

/** A paired iPhone-sized page on `project`, synced and settled. `standalone` emulates the Home Screen app. */
export async function phonePage(browser, { base, token, projectId, scheme, height = 844, scale = 3, standalone = false, contextOptions = {} }) {
  const ctx = await browser.newContext({
    ...contextOptions,
    viewport: { width: 390, height }, deviceScaleFactor: scale, isMobile: true, hasTouch: true, colorScheme: scheme,
    locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await ctx.addInitScript(([pid, sa]) => {
    localStorage.setItem('saqme.installHint', 'off');
    localStorage.setItem('saqme.project', pid);
    if (sa) {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      // headless Chromium reports notifications as blocked; a freshly installed app has not asked yet
      if (window.Notification) Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    }
  }, [projectId, standalone]);
  const page = await ctx.newPage();
  await page.goto(`${base}/#pair=${token}`);
  await page.waitForTimeout(3400);   // first sync + let the "Paired" toast fade
  await page.evaluate(() => document.fonts?.ready);
  return { ctx, page };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = resolve(arg('out', '.'));
  const prefix = arg('prefix', 'phone');
  const base = arg('base', 'http://localhost:8787');
  const project = arg('project', 'Work');
  mkdirSync(out, { recursive: true });
  const playwright = loadPlaywright();
  const token = devToken();
  const projectIds = await seed(base, token);
  const browser = await launch(playwright);
  for (const scheme of ['dark', 'light']) {
    const { ctx, page } = await phonePage(browser, { base, token, projectId: projectIds[project], scheme });
    await page.screenshot({ path: join(out, `${prefix}-${scheme}.png`) });
    await ctx.close();
  }
  await browser.close();
  console.log(`saved ${prefix}-dark.png and ${prefix}-light.png to ${out}`);
}
