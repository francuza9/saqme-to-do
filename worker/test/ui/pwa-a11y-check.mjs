#!/usr/bin/env node
// Accessibility check of the phone app (docs/accessibility.md): axe-core on every main view in both themes,
// plus what axe cannot see: keyboard focus in and out of sheets, focus kept across re-renders, rows
// announced as they are selected, status in words, reduced motion, and reflow at 200% zoom / 320 px.
// Optional QA tool like pwa-ui-check.mjs (Playwright and axe-core are not dependencies of this repo):
//   cd worker && npm i --no-save playwright@1 axe-core@4 && npx playwright install chromium     (once)
//   npm run dev                                                                                  (another terminal, fresh database)
//   node test/ui/pwa-a11y-check.mjs
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  console.error('Playwright is not installed. In worker/: npm i --no-save playwright@1 axe-core@4 && npx playwright install chromium');
  process.exit(2);
}
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '../../../scripts/dev/screenshots.mjs';

let axeSource;
try { axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'); } catch {
  console.error('axe-core is not installed. In worker/: npm i --no-save axe-core@4');
  process.exit(2);
}
const token = /^AUTH_TOKEN=(.*)$/m.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.dev.vars'), 'utf8'))[1];
const base = process.env.SAQME_BASE || 'http://localhost:8787';
let fails = 0;
const check = (c, m) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`); if (!c) fails++; };
const projects = await seed(base, token);

const browser = await chromium.launch();
// bypassCSP only so axe can be injected into the page; the app runs with its policy otherwise unchanged
const phone = (scheme, extra = {}) => browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme, bypassCSP: true, locale: 'en-GB', ...extra,
});
async function open(ctx, projectId) {
  await ctx.addInitScript(([pid]) => { localStorage.setItem('saqme.installHint', 'off'); localStorage.setItem('saqme.project', pid); }, [projectId]);
  const page = await ctx.newPage();
  await page.goto(`${base}/#pair=${token}`);
  await page.waitForSelector('.row');
  await page.waitForTimeout(800);
  return page;
}

// ---------------------------------------------------------------- 1. axe on every view, both themes
const serious = [];
async function axe(page, where) {
  if (!(await page.evaluate(() => typeof window.axe === 'object'))) await page.addScriptTag({ content: axeSource });
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
  for (const v of r.violations) {
    const line = `${where}: ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`;
    if (v.impact === 'serious' || v.impact === 'critical') serious.push(line); else console.log(`  note ${line}`);
  }
}
console.log('1. axe-core (WCAG 2.2 A/AA + best practices)');
for (const scheme of ['dark', 'light']) {
  const ctx = await phone(scheme);
  const page = await open(ctx, projects.Work);
  await axe(page, `${scheme} list`);
  await page.click('.completed-toggle'); await page.waitForTimeout(200); await axe(page, `${scheme} list with completed`);
  await page.click('.row .more >> nth=0'); await page.waitForTimeout(200); await axe(page, `${scheme} task menu`);
  await page.keyboard.press('Escape');
  await page.click('.row .chip-btn >> nth=0'); await page.waitForTimeout(200); await axe(page, `${scheme} status sheet`);
  await page.keyboard.press('Escape');
  await page.click('.row .pill >> nth=0'); await page.waitForTimeout(200); await axe(page, `${scheme} deadline sheet`);
  await page.keyboard.press('Escape');
  await page.click('#logo'); await page.waitForTimeout(200); await axe(page, `${scheme} settings`);
  await page.click('text=Recently deleted'); await page.waitForTimeout(200); await axe(page, `${scheme} recently deleted`);
  await ctx.close();
}
{
  const ctx = await phone('dark');
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector('.welcome');
  await axe(page, 'welcome');
  await ctx.close();
}
check(serious.length === 0, `no serious or critical axe findings${serious.length ? `:\n         ${serious.join('\n         ')}` : ''}`);

// ---------------------------------------------------------------- 2. keyboard and screen reader behaviour
console.log('2. keyboard, focus and announcements');
{
  const ctx = await phone('dark', { isMobile: false, hasTouch: false, viewport: { width: 900, height: 900 } });
  const page = await open(ctx, projects.Work);
  const focused = () => page.evaluate(() => { const a = document.activeElement; return { fk: a?.dataset?.fk ?? '', inSheet: !!a?.closest('#sheet'), label: a?.getAttribute('aria-label') ?? a?.textContent ?? '' }; });

  // a sheet takes focus, keeps it, gives it back
  await page.focus('.row .chip-btn >> nth=0');
  const opener = (await focused()).fk;
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check((await focused()).inSheet, 'opening a sheet moves focus into it');
  check(await page.evaluate(() => document.getElementById('sheet').getAttribute('aria-labelledby') === 'sheetTitle'), 'the sheet is a dialog named by its title');
  let stays = true;
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); if (!(await focused()).inSheet) stays = false; }
  check(stays, 'Tab stays inside the open sheet (the rest of the app is inert)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check((await focused()).fk === opener, `Escape closes it and focus returns to the opener (${opener})`);

  // focus survives a re-render (opening subtasks rebuilds the list)
  await page.focus('.row .chev:not([disabled]) >> nth=0');
  const chev = (await focused()).fk;
  const expanded = () => page.evaluate((k) => document.querySelector(`[data-fk="${k}"]`).getAttribute('aria-expanded'), chev);
  const before = await expanded();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check((await focused()).fk === chev, 'focus stays on the same control after the list re-renders');
  check(before !== (await expanded()) && ['true', 'false'].includes(before), `the subtasks button tells its state (${before} -> ${await expanded()})`);

  // arrow keys select and focus whole rows, which say their status in words
  await page.click('.add', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const row = await focused();
  check(row.fk.startsWith('row:') && /, (To do|In progress|Done|Postponed|Blocked|Failed|Abandoned)/i.test(row.label), `arrow keys move focus to a row that reads as "${row.label}"`);

  // Enter on a focused button is that button's, not a shortcut for the selected task
  await page.focus('#logo');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(await page.isVisible('.view-header h1:has-text("Settings")'), 'Enter on a focused button activates it (Settings opened, no task edited)');

  // toasts reach screen readers through a live region that is always in the page
  await page.click('.view-header .back');
  await page.click('.row .more >> nth=0');
  await page.click('.menu-item.danger');
  await page.waitForTimeout(200);
  const said = await page.textContent('#announce');
  check(/Deleted.*Undo is available/i.test(said), `deleting is announced ("${said}")`);
  await ctx.close();
}

// ---------------------------------------------------------------- 3. motion and zoom
console.log('3. reduced motion and zoom');
{
  const ctx = await phone('dark', { reducedMotion: 'reduce' });
  const page = await open(ctx, projects.Work);
  const t = await page.evaluate(() => getComputedStyle(document.querySelector('.chev svg')).transitionDuration);
  check(/^0s/.test(t), `no transitions with prefers-reduced-motion (${t})`);
  await ctx.close();
}
for (const [w, label] of [[195, '200% zoom on a 390 px phone'], [320, '320 px wide']]) {
  const ctx = await phone('light', { viewport: { width: w, height: 700 } });
  const page = await open(ctx, projects.Work);
  const over = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    list: document.getElementById('list').scrollWidth - document.getElementById('list').clientWidth,
    clipped: [...document.querySelectorAll('.row .text')].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
  }));
  check(over.page <= 0 && over.list <= 0 && over.clipped === 0, `${label}: no sideways scrolling or cut text (${JSON.stringify(over)})`);
  await page.screenshot({ path: join(process.env.SAQME_SHOTS || '/tmp', `a11y-reflow-${w}.png`) });
  await page.click('#logo');
  const overSettings = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overSettings <= 0, `${label}: settings fit too (${overSettings})`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} check(s) failed` : 'a11y pass ok');
process.exit(fails ? 1 : 0);
