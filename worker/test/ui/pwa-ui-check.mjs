#!/usr/bin/env node
// Scripted interaction pass over the phone app at iPhone size (touch emulation) against `npm run dev`.
// Optional QA tool: Playwright is a devDependency of worker/ (`npm install`), its browser is not.
//   cd worker && npm install && npx playwright install chromium     (once)
//   npm run dev                                                                       (another terminal)
//   node test/ui/pwa-ui-check.mjs
// Uses the dev server's database: run it on a fresh one (delete worker/.wrangler/state, then npm run dev).
let chromium, devices;
try { ({ chromium, devices } = await import('playwright')); } catch {
  console.error('Playwright is not installed. In worker/: npm install && npx playwright install chromium');
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
// the lists: the title says the current one; it opens the lists menu, which switches (and Esc closes)
const title = (pg) => pg.textContent('#switcher .switcher-name');
async function listNames(pg) {
  await pg.tap('#switcher');
  await pg.waitForSelector('#listMenu [role="menuitemradio"]');
  const names = await pg.$$eval('#listMenu [role="menuitemradio"] .g-label', (e) => e.map((x) => x.textContent));
  await pg.keyboard.press('Escape');
  return names;
}
async function openList(pg, name) {
  await pg.tap('#switcher');
  await pg.tap(`#listMenu [role="menuitemradio"]:has-text("${name}")`);
  await pg.waitForTimeout(100);
}
// real touches (Playwright's own touchscreen only taps): a swipe, a long press
const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
async function swipe([x0, y0], [x1, y1]) {
  await touch('touchStart', x0, y0);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * i / 10); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await page.waitForTimeout(350);
}
async function longPress(selector) {
  const b = await (await page.$(selector)).boundingBox();
  await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(650);
  await touch('touchEnd');
  await page.waitForTimeout(150);
}

// welcome -> local use -> pair later
await page.goto(base + '/');
await page.waitForSelector('.welcome');
check(await page.isVisible('text=Use it on this device'), 'welcome screen when not paired');
// no dead controls before starting: the header is only the logo, and it opens Settings (BUGS #2)
check(!(await page.isVisible('#switcher')) && !(await page.isVisible('#syncBtn')), 'welcome: no list title or sync button yet');
await page.click('#logo');
await page.waitForSelector('.view-header');
check(await page.isVisible('.view-header h1:has-text("Settings")') && await page.isVisible('[data-fk="open:general"]'), 'welcome: the logo opens Settings');
await page.click('#logo');
await page.waitForSelector('.welcome');
await page.click('text=Use it on this device');
await page.waitForSelector('#addInput');
check(await title(page) === 'General', 'local General list: the title says its name');
check(await page.isVisible('#switcher') && await page.isVisible('#syncBtn'), 'after starting: the title and the sync button are back');

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
check(await page.isVisible('.g-head:has-text("Postponed") + .tasks .row:has-text("Inserted after")'), 'postponed task goes to the card under the Postponed heading');
// the grouped list: each section a card, subtasks indented inside it, their hairlines starting at their text
const layout = await page.evaluate(() => {
  const text = (t) => [...document.querySelectorAll('.row .text')].find((e) => e.textContent === t);
  const x = (t) => text(t).getBoundingClientRect().left;
  const item = text('Find sources').closest('.task-item');
  return {
    cards: document.querySelectorAll('#list > .tasks.group').length,
    sub: x('Find sources') - x('Write the report'),
    subLine: item.getBoundingClientRect().left + parseFloat(getComputedStyle(item, '::before').left) - x('Find sources'),
    add: getComputedStyle(document.querySelector('.add-card')).borderRadius,
  };
});
check(layout.cards === 2 && layout.sub === 20 && Math.abs(layout.subLine) <= 1 && layout.add === '12px', `cards, indented subtasks and their hairlines, the add line a card (${JSON.stringify(layout)})`);

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
await page.tap('.notes .notes-done');
await page.waitForTimeout(100);
check(await page.isVisible('.notes a[href="https://example.com/shop"]'), 'notes render links');

// new list (the lists menu's "New list") + move task there
await page.tap('#switcher');
await page.waitForTimeout(250);   // (the chevron's turn)
const opened = await page.evaluate(() => ({
  expanded: document.getElementById('switcher').getAttribute('aria-expanded'),
  rows: [...document.querySelectorAll('#listMenu [role="menuitemradio"]')].map((r) => `${r.querySelector('.g-label').textContent}:${r.getAttribute('aria-checked')}`).join(),
  chevron: getComputedStyle(document.querySelector('#switcher .switcher-chev svg')).transform,
}));
check(opened.expanded === 'true' && opened.rows === 'General:true' && /^matrix\(-1, /.test(opened.chevron),`the title opens the lists menu, its chevron turned (${JSON.stringify(opened)})`);
await page.tap('#listMenu [data-fk="list-new"]');
await page.fill('.sheet input.field', 'Errands');
await page.press('.sheet input.field', 'Enter');
await page.waitForTimeout(100);
check(await title(page) === 'Errands' && (await listNames(page)).join() === 'General,Errands', 'list created and opened');
await openList(page, 'General');
check(await title(page) === 'General' && await page.isHidden('#listMenuWrap') && (await page.getAttribute('#switcher', 'aria-expanded')) === 'false', 'choosing a list in the menu switches to it and closes the menu');
await page.tap('.row:has-text("Buy milk") .more');
await page.tap('.menu-item:has-text("Move to list")');
await page.tap('.menu-item:has-text("Errands")');
await page.waitForTimeout(100);
check(!(await rows()).includes('Buy milk'), 'task left General');
await openList(page, 'Errands');
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
await openList(page, 'General');
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

// the list switcher: a list with something overdue says "1 due" in the menu, and elsewhere the title has a dot
{
  const pad = (n) => String(n).padStart(2, '0');
  const y = new Date(Date.now() - 86400000);
  await openList(page, 'Errands');
  await page.fill('#addInput', 'Pay the bill'); await page.press('#addInput', 'Enter'); await page.waitForTimeout(150);
  await page.tap('.row:has-text("Pay the bill") .more');
  await page.tap('.menu-item:has-text("Deadline")');
  await page.fill('.sheet input.field:not([type])', `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`);
  await page.press('.sheet input.field:not([type])', 'Enter');
  await page.waitForTimeout(100);
  check(await page.isHidden('#switcher .dot'), 'no dot while the list with something due is the one shown');
  await openList(page, 'General');
  check(await page.isVisible('#switcher .dot') && /Due in Errands/.test(await page.getAttribute('#switcher', 'aria-description')), 'another list has something due: a violet dot after the chevron, in words for screen readers');
  const toggle = await (await page.$('.completed-toggle')).boundingBox();
  const shown = await page.getAttribute('.completed-toggle', 'aria-expanded');
  await page.tap('#switcher');
  const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  const errands = await page.$eval('#listMenu [role="menuitemradio"]:has-text("Errands") .g-value', (e) => ({ text: e.textContent, colour: getComputedStyle(e).color, alert: getComputedStyle(e).getPropertyValue('--alert').trim() }));
  const general = await page.textContent('#listMenu [role="menuitemradio"]:has-text("General") .g-value');
  check(errands.text === ', 1 due' && errands.colour === rgb(errands.alert) && general === ', 3 open', `the menu: open tasks per list, "1 due" in the alert colour (${JSON.stringify(errands)}, ${general})`);
  // a tap outside closes it, and does nothing else (here: over Completed, which stays as it was)
  await page.tap('#listMenuScrim', { position: { x: toggle.x + toggle.width / 2, y: toggle.y + toggle.height / 2 } });
  check(await page.isHidden('#listMenuWrap') && (await page.getAttribute('.completed-toggle', 'aria-expanded')) === shown, 'a tap outside the menu closes it, and goes no further');

  // swipes on the list: to the left the next list, to the right back; past the last one nothing; up and down is a scroll
  const lb = await (await page.$('#list')).boundingBox();
  const midY = lb.y + lb.height / 2;
  await swipe([lb.x + lb.width - 40, midY], [lb.x + 60, midY + 6]);
  check(await title(page) === 'Errands', `a swipe to the left goes to the next list (${await title(page)})`);
  await swipe([lb.x + lb.width - 40, midY], [lb.x + 60, midY]);
  check(await title(page) === 'Errands', 'past the last list a swipe changes nothing');
  await swipe([lb.x + 60, midY], [lb.x + lb.width - 40, midY]);
  check(await title(page) === 'General', 'a swipe to the right goes back');
  await swipe([lb.x + lb.width / 2, midY + 100], [lb.x + lb.width / 2 + 30, midY - 150]);
  check(await title(page) === 'General', 'an up-and-down move is a scroll, not a switch');
  const g = await (await page.$('.row:has-text("Last one") .grip')).boundingBox();
  await swipe([g.x + g.width / 2, g.y + g.height / 2], [g.x + 220, g.y + g.height / 2]);
  check(await title(page) === 'General' && (await rows()).includes('Last one'), 'a sideways move that starts on a task\'s handle is not a switch');
  check(!(await page.isVisible('.editor')) && await page.isHidden('#sheetWrap'), 'swiping opened no task and no menu');

  // a long press on a list in the menu: its own menu; a move there opens the lists menu again, in the new order
  await page.tap('#switcher');
  await longPress('#listMenu [role="menuitemradio"]:has-text("Errands")');
  await page.waitForSelector('#sheet .menu-item:has-text("Move up")');
  const opts = (await page.$$eval('#sheet .menu-item', (e) => e.map((x) => x.textContent))).join('|');
  check(/^Share…needs sync\|Rename\|Move up\|Delete list$/.test(opts), `a long press on a list in the menu: share, rename, move, delete (${opts})`);
  await page.tap('#sheet .menu-item:has-text("Move up")');
  await page.waitForSelector('#listMenu [role="menuitemradio"]');
  await page.waitForTimeout(400);   // (the menu grows into place; a long press needs it still)
  const moved =await page.$$eval('#listMenu [role="menuitemradio"] .g-label', (e) => e.map((x) => x.textContent));
  check(moved.join() === 'Errands,General' && (await page.evaluate(() => document.activeElement?.dataset.fk ?? '')).startsWith('list:'), `Move up: the menu opens again in the new order (${moved.join()})`);
  await longPress('#listMenu [role="menuitemradio"]:has-text("Errands")');
  await page.tap('#sheet .menu-item:has-text("Move down")');
  await page.waitForSelector('#listMenu [role="menuitemradio"]');
  check((await page.$$eval('#listMenu [role="menuitemradio"] .g-label', (e) => e.map((x) => x.textContent))).join() === 'General,Errands', 'Move down puts it back');
  await page.keyboard.press('Escape');

  // a long Georgian name ends in "…" in the title and pushes nothing off the screen; rename and delete
  await page.tap('#switcher');
  await page.tap('#listMenu [data-fk="list-new"]');
  await page.fill('.sheet input.field', 'Temp');
  await page.press('.sheet input.field', 'Enter');
  await page.waitForTimeout(100);
  await longPress('#switcher');   // (the current list's own menu, from the title)
  await page.tap('#sheet .menu-item:has-text("Rename")');
  const long = 'ყოველკვირეული საოჯახო საქმეები და საყიდლები';
  await page.fill('.sheet input.field', long);
  await page.press('.sheet input.field', 'Enter');
  await page.waitForTimeout(150);
  const fit = await page.evaluate(() => {
    const n = document.querySelector('#switcher .switcher-name');
    return { text: n.textContent, cut: n.scrollWidth > n.clientWidth, ellipsis: getComputedStyle(n).textOverflow, sync: document.getElementById('syncBtn').getBoundingClientRect().right <= innerWidth, page: document.documentElement.scrollWidth <= innerWidth };
  });
  check(fit.text === long && fit.cut && fit.ellipsis === 'ellipsis' && fit.sync && fit.page, `a long Georgian name ends in "…" in the title, the buttons stay on screen (${JSON.stringify(fit)})`);
  await page.screenshot({ path: '/tmp/saqme-qa/ui-long-title.png' });
  await page.tap('#switcher');
  const whole = await page.$eval('#listMenu [role="menuitemradio"]:has-text("ყოველკვირეული") .g-label', (e) => ({ text: e.textContent, cut: e.scrollWidth > e.clientWidth, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) }));
  check(whole.text === long && !whole.cut && whole.lines > 1, `the lists menu shows the long name whole: it wraps (${JSON.stringify(whole)})`);
  await longPress('#listMenu [role="menuitemradio"]:has-text("ყოველკვირეული")');
  await page.tap('#sheet .menu-item:has-text("Delete list")');
  await page.tap('#sheet .btn.primary:has-text("Delete")');
  await page.waitForTimeout(150);
  check(/List deleted/.test(await page.textContent('#toast')) && (await listNames(page)).join() === 'General,Errands' && await title(page) === 'General', 'Delete list (from the menu) takes it away, with Undo');
}

// pair now -> everything uploads (Settings > Sync & sharing)
await page.tap('#logo');
check(await page.textContent('[data-fk="open:sync"]') === 'Sync & sharingOff', `Settings: Sync & sharing says it is off (${await page.textContent('[data-fk="open:sync"]')})`);
// in Settings the header is only ☰, pressed (docs/design.md, "Motion"); after taps no focus ring anywhere
await page.waitForFunction(() => !document.querySelector('.list.ghost'));
await page.waitForTimeout(250);   // (the header's fade)
const head = await page.evaluate(() => ({ pressed: document.getElementById('logo').getAttribute('aria-pressed'), title: getComputedStyle(document.getElementById('switcher')).visibility, sync: getComputedStyle(document.getElementById('syncBtn')).visibility }));
check(head.pressed === 'true' && head.title === 'hidden' && head.sync === 'hidden', `Settings: the header is only ☰, pressed (${JSON.stringify(head)})`);
await page.tap('[data-fk="open:sync"]');
await page.waitForSelector('.view-header h1:has-text("Sync & sharing")');
await page.waitForFunction(() => !document.querySelector('.list.ghost'));
const tapRing = async (sel) => { await page.tap(sel); return page.evaluate((s) => { const a = document.activeElement; return { on: a === document.querySelector(s), input: document.documentElement.dataset.input, ring: getComputedStyle(a.closest('.g-row.input') ?? a).outlineStyle }; }, sel); };
const tapped = await tapRing('[data-fk="pair-input"]');
check(tapped.on && tapped.input === 'pointer' && tapped.ring === 'none', `a text box tapped: no focus ring (${JSON.stringify(tapped)})`);
// a link whose address hides another server behind a user name is refused
await page.fill('[data-fk="pair-input"]', `${base.replace('//', '//saqme.example.workers.dev@')}/#pair=${token}`);
await page.tap('[data-fk="pair-go"]');
check(await page.$eval('[data-fk="pair-input"]', (el) => el.classList.contains('bad')) && await page.isHidden('#sheetWrap'), 'a link with a user name in the address is refused');
// the real one: asks first, saying where the lists go and how many
await page.fill('[data-fk="pair-input"]', `${base}/#pair=${token}`);
await page.tap('[data-fk="pair-go"]');
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

// Settings > Sync & sharing > Pair a phone: the QR code and a fresh one-time code
check(await page.isVisible('.g-row:has-text("Status") .g-value:has-text("Synced")'), 'Sync & sharing: paired, it says how sync stands');
await page.tap('.g-row:has-text("Pair a phone")');
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
  await hp.waitForSelector('#switcher:has-text("General")', { timeout: 8000 });
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
  await openList(page, 'Errands');
  await page.dispatchEvent('#switcher', 'contextmenu');   // (a right-click on the title: the current list's own menu)
  await page.waitForSelector('#sheet .menu-item:has-text("Share")');
  await page.tap('#sheet .menu-item:has-text("Share")');
  await page.waitForSelector('#sheet:has-text("Shared with")');
  await page.fill('#sheet input.g-input', 'Nuca');
  await page.tap('#sheet [data-fk="access:view"]');
  await page.tap('#sheet [data-fk="share-create"]');
  await page.waitForSelector('#sheet .invite input');
  const link = await page.inputValue('#sheet .invite input');
  check(/\/join#code=[A-Za-z0-9_-]{22}$/.test(link), `Share: a one-time invite link (${link})`);
  await page.waitForSelector('#sheet .person:has-text("Invited")');
  check(await page.isVisible('#sheet .person:has-text("Nuca")'), 'Share: the person is listed, invited');
  await page.tap('#sheet .person:has-text("Nuca")');
  check(await page.isVisible('#sheet .g-row:has-text("not joined yet")') && await page.isVisible('#sheet .g-row.action:has-text("Cancel invite")')
    && (await page.getAttribute('#sheet .person:has-text("Nuca")', 'aria-expanded')) === 'true', 'Share: a person\'s row opens their state, access and Cancel invite');
  await page.tap('#sheet .btn:has-text("Done")');
  await page.waitForTimeout(1500);   // (a sync brings the "shared" badge)
  await page.tap('#switcher');
  check(await page.isVisible('#switcher .shared-badge') && await page.isVisible('#listMenu [role="menuitemradio"]:has-text("Errands") .shared-badge')
    && !(await page.isVisible('#listMenu [role="menuitemradio"]:has-text("General") .shared-badge')), 'the shared list has a badge after its name, in the title and in the lists menu');
  await page.keyboard.press('Escape');

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
  await gp.waitForSelector('#switcher:has-text("Errands")');
  await gp.waitForSelector('.row', { timeout: 8000 }).catch(() => {});
  check(await gp.isVisible('.shared-note:has-text("View only")') && await gp.isHidden('#addBar'), 'a view-only list: says so, and no add bar');
  check(await gp.isVisible('#switcher .shared-badge'), 'the person sees the badge too');
  await gp.dispatchEvent('#switcher', 'contextmenu');
  await gp.waitForSelector('#sheet .menu-item:has-text("Leave this list")');
  check(!(await gp.isVisible('#sheet .menu-item:has-text("Delete")')) && !(await gp.isVisible('#sheet .menu-item:has-text("Rename")')), 'its menu: Leave instead of Delete, no Rename');
  await gp.tap('#sheet .menu-item:has-text("Move to my Saqme app")');
  await gp.waitForSelector('#sheet:has-text("works once")');
  check(/\/join#code=/.test(await gp.inputValue('#sheet .invite input')), 'Move to my Saqme app: a one-time link for the same list');
  await gp.tap('#sheet .btn.primary:has-text("Done")');
  await gp.screenshot({ path: '/tmp/saqme-qa/ui-shared-guest.png' });

  await page.dispatchEvent('#switcher', 'contextmenu');
  await page.tap('#sheet .menu-item:has-text("Share")');
  await page.waitForSelector('#sheet .person:has-text("Can view")');
  check(true, 'the owner sees them as joined (their access instead of "Invited")');
  await page.tap('#sheet .btn:has-text("Done")');

  await gp.dispatchEvent('#switcher', 'contextmenu');
  await gp.tap('#sheet .menu-item:has-text("Leave this list")');
  await gp.tap('#sheet .btn.primary:has-text("Leave")');
  await gp.waitForTimeout(300);
  check(!(await gp.isVisible('#switcher:has-text("Errands")')), 'leaving takes the list off the browser');
  await guest.close();
  await page.tap('#logo');   // back to Settings for what follows
  await page.waitForSelector('.view-header');
}

// theme switch (Settings > General)
await page.tap('[data-fk="open:general"]');
await page.tap('.segmented button:has-text("Light")');
check((await page.getAttribute('html', 'data-theme')) === 'light', 'theme switch');
await page.tap('.segmented button:has-text("Auto")');
await page.tap('.view-header .back');

// Settings: a short list of pages, each with how it stands; the version under every view
const pages = await page.$$eval('#list .group .g-row.link .g-label', (els) => els.map((e) => e.textContent));
// (a paired phone has Updates too: its sync service's version, and its updating itself)
check(pages.join() === 'General,Notifications,Sync & sharing,Your lists,Use with AI,Updates,About', `Settings: the pages, in two cards (${pages.join()})`);
check(/Saqme To Do \d+\.\d+\.\d+/.test(await page.textContent('#list .version-line')), `the version under Settings (${await page.textContent('#list .version-line')})`);
await page.tap('[data-fk="open:updates"]');
await page.waitForSelector('.view-header h1:has-text("Updates")');
check(await page.isVisible('#list .g-head:has-text("Sync service")') && await page.isVisible('#list .g-row:has-text("Version")'), 'Settings > Updates on a paired phone: the sync service and its version');
await page.tap('.view-header .back');

// Use with AI on a paired phone: the connector's URL (made by the Worker when its database was set up) and the steps
await page.tap('[data-fk="open:ai"]');
await page.waitForSelector('[data-fk="ai-copy"]');
check(await page.isVisible('[data-fk="ai-rotate"]') && await page.isVisible('[data-fk="ai-disconnect"]') && !(await page.isVisible('[data-fk="do:Copy instructions for your AI"]')),
  'Use with AI: Copy connector URL, New connector URL, Disconnect (no files option on a phone)');
await page.tap('[data-fk="ai-claude"]');
await page.waitForSelector('#sheet:has-text("Add custom connector")');
check(await page.isVisible('#sheet button:has-text("Copy connector URL")'), 'Use with AI: the Claude steps, with the URL to copy');
await page.keyboard.press('Escape');
await page.tap('.view-header .back');

// trash view (Settings > Your lists > Recently deleted), and back one level at a time
await page.tap('[data-fk="open:lists"]');
await page.tap('[data-fk="open:trash"]');
check(await page.isVisible('.view-header:has-text("Recently deleted")') && await page.isVisible('#list .version-line'), 'trash view opens, with the version line');
await page.tap('.view-header .back');
check(await page.isVisible('.view-header h1:has-text("Your lists")'), 'Back goes one level up (Recently deleted to Your lists)');

// offline reload still works (service worker)
await page.goto(base + '/');
await page.waitForTimeout(1500);
await ctx.setOffline(true);
await page.reload();
await page.waitForTimeout(1500);
check((await listNames(page)).length === 2, 'app opens offline with its data');
await ctx.setOffline(false);
const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e));   // expected while deliberately offline
check(real.length === 0, `no page errors (${real.join(' | ')})`);
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ui pass ok');
