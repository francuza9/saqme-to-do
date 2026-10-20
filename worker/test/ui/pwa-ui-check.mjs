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
// no dead controls before starting: the header is only the logo, and it opens Settings (BUGS #2)
check(!(await page.isVisible('#tabAdd')) && !(await page.isVisible('#syncBtn')), 'welcome: no "+" or sync button yet');
await page.click('#logo');
await page.waitForSelector('.view-header');
check(await page.isVisible('text=Theme'), 'welcome: the logo opens Settings');
await page.click('#logo');
await page.waitForSelector('.welcome');
await page.click('text=Use it on this device');
await page.waitForSelector('#addInput');
check((await page.$$eval('.tab .name', (e) => e.map((x) => x.textContent))).join() === 'General', 'local General project');
check(await page.isVisible('#tabAdd') && await page.isVisible('#syncBtn'), 'after starting: "+" and the sync button are back');

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
// iPhone Safari: the Home Screen app will start unpaired with storage of its own, so Safari hands over a code
const CODE = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
const codeIn = async (pg) => (await pg.textContent('#sheet .pair-code .code').catch(() => ''))?.trim();
await page.waitForSelector('#sheet:has-text("Now the Home Screen app")');
const step = await page.textContent('#sheet');
check(/Add to Home Screen/.test(step) && CODE.test(await codeIn(page)), `Safari, once paired, shows the Home Screen step with a code (${await codeIn(page)})`);
await page.tap('#sheet .btn.primary');
await page.screenshot({ path: '/tmp/saqme-qa/ui-settings-paired.png' });

// Settings > Sync > Pair a phone: the QR code and a fresh one-time code
await page.tap('.setting:has-text("Pair a phone") button');
await page.waitForSelector('#sheet img.qr');
const shown = await codeIn(page);
check(CODE.test(shown), `Pair a phone shows the QR code and a code (${shown})`);
await page.tap('#sheet .btn.primary');

// the app on the Home Screen (standalone, storage of its own): welcome, then the code pairs it (BUGS #1)
{
  const home = await browser.newContext({ ...devices['iPhone 14'], colorScheme: 'dark' });
  await home.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const hp = await home.newPage();
  hp.on('pageerror', (e) => errors.push(e.message));
  await hp.goto(base + '/');
  await hp.waitForSelector('.welcome');
  await hp.fill('.welcome .field-row input', 'ZZZZ-ZZZZ');
  await hp.tap('.welcome .field-row .btn.primary');
  await hp.waitForSelector('#toast:has-text("wrong or has expired")');
  check(await hp.$eval('.welcome .field-row input', (el) => el.classList.contains('bad')), 'Home Screen app: a wrong code is refused, saying why');
  await hp.fill('.welcome .field-row input', shown.toLowerCase().replace('-', ' '));
  await hp.tap('.welcome .field-row .btn.primary');
  await hp.waitForSelector('.tab', { timeout: 8000 });
  await hp.waitForSelector('.row:has-text("Find sources")', { timeout: 8000 }).catch(() => {});
  check(await hp.isVisible('.row:has-text("Find sources")'), 'Home Screen app: the code pairs it and the lists arrive');
  check(await hp.isHidden('#sheetWrap'), 'Home Screen app: no Add to Home Screen step there');
  await home.close();
}

// opening the pairing link in iPhone Safari: paired, the key leaves the address bar, and the code step shows
{
  const safari = await browser.newContext({ ...devices['iPhone 14'], colorScheme: 'dark' });
  const sp = await safari.newPage();
  sp.on('pageerror', (e) => errors.push(e.message));
  await sp.goto(`${base}/#pair=${token}`);
  await sp.waitForSelector('#sheet:has-text("Now the Home Screen app")');
  check(CODE.test(await codeIn(sp)) && !(await sp.evaluate(() => location.href)).includes(token), 'link in Safari: the code step shows, and the key is gone from the address bar');
  await safari.close();
}

// shared lists: the owner shares Errands view-only; someone without Saqme opens the invite in their browser
{
  if (await page.isVisible('.view-header')) await page.tap('#logo');   // (from Settings back to the lists)
  await page.tap('.tab:has-text("Errands")');
  await page.dispatchEvent('.tab:has-text("Errands")', 'contextmenu');
  await page.waitForSelector('#sheet .menu-item:has-text("Share")');
  await page.tap('#sheet .menu-item:has-text("Share")');
  await page.waitForSelector('#sheet:has-text("Shared with")');
  await page.fill('#sheet input.field', 'Nuca');
  await page.tap('#sheet [data-fk="access:view"]');
  await page.tap('#sheet .btn.primary:has-text("Create invite link")');
  await page.waitForSelector('#sheet .invite input');
  const link = await page.inputValue('#sheet .invite input');
  check(/\/join#code=[A-Za-z0-9_-]{22}$/.test(link), `Share: a one-time invite link (${link})`);
  await page.waitForSelector('#sheet .person:has-text("not joined yet")');
  check(await page.isVisible('#sheet .person:has-text("Nuca")'), 'Share: the person is listed, invited');
  await page.tap('#sheet .btn:has-text("Done")');
  await page.waitForTimeout(1500);   // (a sync brings the "shared" badge)
  check(await page.isVisible('.tab:has-text("Errands") .shared-badge'), 'the shared list has a badge on its tab');

  const guest = await browser.newContext({ ...devices['iPhone 14'], colorScheme: 'dark' });
  const gp = await guest.newPage();
  gp.on('pageerror', (e) => errors.push(e.message));
  await gp.goto(link);
  await gp.waitForSelector('#ways:not([hidden])');
  const ways = await gp.textContent('#ways');
  check(/Use it now, in this browser/.test(ways) && /no account/i.test(ways) && /Install Saqme To Do/.test(ways) && /curl -fsSL/.test(ways), 'join page: use it in the browser, open it in Saqme, or install Saqme');
  await gp.tap('#openBrowser');
  await gp.waitForSelector('#sheet:has-text("Join shared list?")');
  check(/no account and no sync of your own/.test(await gp.textContent('#sheet')), 'in the browser: joining needs no account and no sync');
  await gp.tap('#sheet .btn.primary:has-text("Join")');
  await gp.waitForSelector('.tab:has-text("Errands")');
  await gp.waitForSelector('.row', { timeout: 8000 }).catch(() => {});
  check(await gp.isVisible('.callout.shared-note:has-text("View only")') && await gp.isHidden('#addBar'), 'a view-only list: says so, and no add bar');
  check(await gp.isVisible('.tab:has-text("Errands") .shared-badge'), 'the person sees the badge too');
  await gp.dispatchEvent('.tab:has-text("Errands")', 'contextmenu');
  await gp.waitForSelector('#sheet .menu-item:has-text("Leave this list")');
  check(!(await gp.isVisible('#sheet .menu-item:has-text("Delete")')) && !(await gp.isVisible('#sheet .menu-item:has-text("Rename")')), 'its menu: Leave instead of Delete, no Rename');
  await gp.tap('#sheet .menu-item:has-text("Move to my Saqme app")');
  await gp.waitForSelector('#sheet:has-text("works once")');
  check(/\/join#code=/.test(await gp.inputValue('#sheet .invite input')), 'Move to my Saqme app: a one-time link for the same list');
  await gp.tap('#sheet .btn.primary:has-text("Done")');
  await gp.screenshot({ path: '/tmp/saqme-qa/ui-shared-guest.png' });

  await page.dispatchEvent('.tab:has-text("Errands")', 'contextmenu');
  await page.tap('#sheet .menu-item:has-text("Share")');
  await page.waitForSelector('#sheet .person:has-text("joined")');
  check(true, 'the owner sees them as joined');
  await page.tap('#sheet .btn:has-text("Done")');

  await gp.dispatchEvent('.tab:has-text("Errands")', 'contextmenu');
  await gp.tap('#sheet .menu-item:has-text("Leave this list")');
  await gp.tap('#sheet .btn.primary:has-text("Leave")');
  await gp.waitForTimeout(300);
  check((await gp.$$('.tab')).length === 0, 'leaving takes the list off the browser');
  await guest.close();
  await page.tap('#logo');   // back to Settings for what follows
  await page.waitForSelector('.view-header');
}

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
