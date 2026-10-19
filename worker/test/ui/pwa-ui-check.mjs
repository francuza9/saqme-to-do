#!/usr/bin/env node
// Scripted interaction pass over the phone app at iPhone size (touch emulation) against `npm run dev`.
// Optional QA tool: Playwright is deliberately not a dependency of this repo.
//   cd worker && npm i --no-save playwright@1 && npx playwright install chromium     (once)
//   npm run dev                                                                       (another terminal)
//   node test/ui/pwa-ui-check.mjs
// Uses the dev server's database: run it on a fresh one (delete worker/.wrangler/state, then npm run dev).
let chromium, devices;
try { ({ chromium, devices } = await import('playwright')); } catch {
  console.error('Playwright is not installed. In worker/: npm i --no-save playwright@1 && npx playwright install chromium');
  process.exit(2);
}
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const token = /^AUTH_TOKEN=(.*)$/m.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.dev.vars'), 'utf8'))[1];
const base = process.env.SAQME_BASE || 'http://localhost:8787';
let fails = 0;
const check = (c, m) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`); if (!c) fails++; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 14'], colorScheme: 'dark' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const rows = () => page.$$eval('.row .text', (els) => els.map((e) => e.textContent));

// welcome -> local use -> pair later
await page.goto(base + '/');
await page.waitForSelector('.welcome');
check(await page.isVisible('text=Use it on this device'), 'welcome screen when not paired');
await page.click('text=Use it on this device');
await page.waitForSelector('#addInput');
check((await page.$$eval('.tab .name', (e) => e.map((x) => x.textContent))).join() === 'General', 'local General project');

// add tasks with the add bar
for (const t of ['Buy milk', 'Write report', 'Call Anna']) { await page.fill('#addInput', t); await page.press('#addInput', 'Enter'); }
await page.waitForTimeout(150);
check((await rows()).join('|') === 'Buy milk|Write report|Call Anna', `add bar adds at the end (${(await rows()).join('|')})`);

// inline edit: Enter saves + opens a new task below, typing there adds it
await page.tap('.row:has-text("Write report") .text');
await page.waitForSelector('.editor');
await page.fill('.editor', 'Write the report');
await page.press('.editor', 'Enter');
await page.waitForSelector('.editor');
await page.fill('.editor', 'Inserted after');
await page.press('.editor', 'Enter');
await page.press('.editor', 'Enter');   // empty -> stop editing
await page.waitForTimeout(150);
check((await rows()).join('|') === 'Buy milk|Write the report|Inserted after|Call Anna', `Enter edits and inserts below (${(await rows()).join('|')})`);

// Shift+Enter makes a subtask
await page.tap('.row:has-text("Write the report") .text');
await page.press('.editor', 'Shift+Enter');
await page.fill('.editor', 'Find sources');
await page.press('.editor', 'Enter');
await page.press('.editor', 'Enter');
await page.waitForTimeout(150);
const depth = await page.$eval('.row:has-text("Find sources")', (r) => r.style.getPropertyValue('--depth'));
check(depth === '1', 'Shift+Enter creates a subtask');

// status sheet
await page.tap('.row:has-text("Buy milk") .chip-btn');
await page.tap('.menu-item:has-text("In progress")');
await page.waitForTimeout(100);
check(await page.isVisible('.row:has-text("Buy milk") .chip.s-prog'), 'status changed to in progress');
await page.tap('.row:has-text("Call Anna") .chip-btn');
await page.tap('.menu-item:has-text("Done")');
await page.waitForTimeout(100);
check(await page.isVisible('.completed-toggle'), 'done task folds into Completed');
await page.tap('.row:has-text("Inserted after") .chip-btn');
await page.tap('.menu-item:has-text("Postponed")');
await page.waitForTimeout(100);
check(await page.isVisible('.section-label:has-text("Postponed")'), 'postponed section appears');

// deadline via free text
await page.tap('.row:has-text("Write the report") .more');
await page.tap('.menu-item:has-text("Deadline")');
await page.fill('.sheet input.field:not([type])', 'tomorrow 14:00');
await page.press('.sheet input.field:not([type])', 'Enter');
await page.waitForTimeout(100);
check((await page.textContent('.row:has-text("Write the report") .pill')).trim() === 'Tomorrow 14:00', 'deadline parsed from "tomorrow 14:00"');

// notes with a link
await page.tap('.row:has-text("Buy milk") .more');
await page.tap('.menu-item:has-text("Notes")');
await page.fill('.notes textarea', 'oat milk https://example.com/shop');
await page.tap('.notes .btn');
await page.waitForTimeout(100);
check(await page.isVisible('.notes a[href="https://example.com/shop"]'), 'notes render links');

// new project + move task there
await page.tap('.tab-add');
await page.fill('.sheet input.field', 'Errands');
await page.press('.sheet input.field', 'Enter');
await page.waitForTimeout(100);
check((await page.$$eval('.tab .name', (e) => e.map((x) => x.textContent))).join() === 'General,Errands', 'project created and opened');
await page.tap('.tab:has-text("General")');
await page.tap('.row:has-text("Buy milk") .more');
await page.tap('.menu-item:has-text("Move to project")');
await page.tap('.menu-item:has-text("Errands")');
await page.waitForTimeout(100);
check(!(await rows()).includes('Buy milk'), 'task left General');
await page.tap('.tab:has-text("Errands")');
check((await rows()).includes('Buy milk'), 'task arrived in Errands');

// delete + undo
await page.tap('.row:has-text("Buy milk") .more');
await page.tap('.menu-item.danger');
await page.waitForTimeout(150);
check(!(await rows()).includes('Buy milk'), 'deleted');
await page.tap('#toast button');
await page.waitForTimeout(100);
check((await rows()).includes('Buy milk'), 'undo restores it');

// drag reorder in General (touch on the grip)
await page.tap('.tab:has-text("General")');
await page.fill('#addInput', 'Last one'); await page.press('#addInput', 'Enter'); await page.waitForTimeout(150);
const grip = await page.$('.row:has-text("Last one") .grip');
const target = await page.$('.row:has-text("Write the report")');
const gb = await grip.boundingBox(); const tb = await target.boundingBox();
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(gb.x + 4, gb.y + (tb.y + 4 - gb.y) * i / 8);
await page.mouse.up();
await page.waitForTimeout(150);
const order = (await rows()).filter((t) => ['Last one', 'Write the report'].includes(t));
check(order.join('|') === 'Last one|Write the report', `drag moved the task above (${(await rows()).join('|')})`);

// pair now -> everything uploads
await page.tap('#logo');
// a link whose address hides another server behind a user name is refused
await page.fill('.setting + .field-row input, .field-row input', `${base.replace('//', '//saqme.example.workers.dev@')}/#pair=${token}`);
await page.tap('.field-row .btn.primary');
check(await page.$eval('.field-row input', (el) => el.classList.contains('bad')) && await page.isHidden('#sheetWrap'), 'a link with a user name in the address is refused');
// the real one: asks first, saying where the lists go and how many
await page.fill('.setting + .field-row input, .field-row input', `${base}/#pair=${token}`);
await page.tap('.field-row .btn.primary');
await page.waitForSelector('#sheet:has-text("Sync with")');
const ask = await page.textContent('#sheet');
check(ask.includes(new URL(base).host) && /This uploads your \d+ lists \(\d+ tasks\)/.test(ask), `pairing asks first, naming the server and what goes there (${ask.slice(0, 120)})`);
await page.tap('#sheet .btn.primary');
await page.waitForTimeout(2500);
const srv = await (await fetch(base + '/api/sync', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'probe', cursor: 0, changes: [] }) })).json();
const texts = srv.changes.filter((c) => c.kind === 'task' && !c.fields.deleted.v).map((c) => c.fields.text.v);
check(texts.includes('Find sources') && texts.includes('Buy milk'), `pairing uploaded the local lists (${texts.length} tasks)`);
await page.screenshot({ path: '/tmp/saqme-qa/ui-settings-paired.png' });

// theme switch
await page.tap('.segmented button:has-text("Light")');
check((await page.getAttribute('html', 'data-theme')) === 'light', 'theme switch');
await page.tap('.segmented button:has-text("Auto")');

// trash view
await page.tap('text=Recently deleted');
check(await page.isVisible('.view-header:has-text("Recently deleted")'), 'trash view opens');

// offline reload still works (service worker)
await page.goto(base + '/');
await page.waitForTimeout(1500);
await ctx.setOffline(true);
await page.reload();
await page.waitForTimeout(1500);
check((await page.$$eval('.tab .name', (e) => e.length)) === 2, 'app opens offline with its data');
await ctx.setOffline(false);
const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e));   // expected while deliberately offline
check(real.length === 0, `no page errors (${real.join(' | ')})`);
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ui pass ok');
