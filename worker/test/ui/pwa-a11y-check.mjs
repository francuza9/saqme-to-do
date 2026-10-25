#!/usr/bin/env node
// Accessibility check of the phone app (docs/accessibility.md): axe-core on every main view in both themes,
// plus what axe cannot see: keyboard focus in and out of sheets, focus kept across re-renders, rows
// announced as they are selected, status in words, reduced motion, and reflow at 200% zoom / 320 px.
// Optional QA tool like pwa-ui-check.mjs (Playwright and axe-core are devDependencies of worker/, so `npm install` has them):
//   cd worker && npm install && npx playwright install chromium     (once)
//   npm run dev                                                                                  (another terminal, fresh database)
//   node test/ui/pwa-a11y-check.mjs
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  console.error('Playwright is not installed. In worker/: npm install && npx playwright install chromium');
  process.exit(2);
}
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '../../../scripts/dev/screenshots.mjs';

let axeSource;
try { axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'); } catch {
  console.error('axe-core is not installed. In worker/: npm install');
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

// a view that moves in (Settings, docs/design.md "Motion") and the header that fades with it have arrived: no view on
// its way out, nothing animating but what never ends (the syncing cloud)
const settled = (page) => page.waitForFunction(() => !document.querySelector('.list.ghost') && !document.getElementById('app').dataset.move
  && document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity));

// ---------------------------------------------------------------- 1. axe on every view, both themes
const serious = [];
async function axe(page, where) {
  await settled(page);
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
  await page.click('#switcher'); await page.waitForTimeout(200); await axe(page, `${scheme} lists menu`);
  await page.dispatchEvent('#listMenu [role="menuitemradio"] >> nth=0', 'contextmenu'); await page.waitForTimeout(200); await axe(page, `${scheme} a list's own menu`);
  await page.keyboard.press('Escape');
  await page.click('.completed-toggle'); await page.waitForTimeout(200); await axe(page, `${scheme} list with completed`);
  await page.click('.row .more >> nth=0'); await page.waitForTimeout(200); await axe(page, `${scheme} task menu`);
  await page.keyboard.press('Escape');
  await page.click('.row .chip-btn >> nth=0'); await page.waitForTimeout(200); await axe(page, `${scheme} status sheet`);
  await page.keyboard.press('Escape');
  await page.click('.row .pill >> nth=0'); await page.waitForTimeout(200); await axe(page, `${scheme} deadline sheet`);
  await page.keyboard.press('Escape');
  await page.click('#logo'); await page.waitForTimeout(200); await axe(page, `${scheme} settings`);
  // every page of Settings (Sync & sharing with Advanced open too), and the views they open
  for (const p of ['general', 'notifications', 'sync', 'lists', 'ai', 'updates', 'about']) {
    await page.click(`[data-fk="open:${p}"]`); await page.waitForTimeout(p === 'updates' ? 600 : 150); await axe(page, `${scheme} settings ${p}`);
    // (the sheet that takes the token for the sync service's own updates: with a dev Worker that knows its account,
    // npm run dev -- --var SAQME_ACCOUNT_ID:x --var SAQME_WORKER_NAME:y)
    if (p === 'updates' && await page.$('[data-fk="svc-token"]')) { await page.click('[data-fk="svc-token"]'); await page.waitForTimeout(200); await axe(page, `${scheme} token sheet`); await page.keyboard.press('Escape'); }
    if (p === 'ai' && await page.$('[data-fk="ai-chatgpt"]')) {
      // (Connect ChatGPT also opens ChatGPT's settings: a stand-in page here, closed again)
      await page.context().route(/^https:\/\/chatgpt\.com\//, (r) => r.fulfill({ contentType: 'text/html', body: '<title>stand-in</title>' }));
      page.context().once('page', (popup) => popup.close().catch(() => {}));
      await page.click('[data-fk="ai-chatgpt"]'); await page.waitForTimeout(200); await axe(page, `${scheme} connect ChatGPT sheet`); await page.keyboard.press('Escape'); }
    if (p === 'sync') { await page.click('[data-fk="advanced"]'); await page.waitForTimeout(150); await axe(page, `${scheme} settings sync, advanced`); }
    if (p === 'lists') { await page.click('[data-fk="open:trash"]'); await page.waitForTimeout(150); await axe(page, `${scheme} recently deleted`); await page.click('.view-header .back'); }
    await page.click('.view-header .back');
  }
  await page.click('#logo'); await page.waitForSelector('.row');
  await page.dispatchEvent('#switcher', 'contextmenu');
  await page.click('#sheet .menu-item:has-text("Share")');
  await page.waitForSelector('#sheet:has-text("Shared with")'); await page.waitForTimeout(300);
  await axe(page, `${scheme} share sheet`);
  await page.keyboard.press('Escape');
  await ctx.close();
}
// shared lists, for someone without Saqme: the invite page, joining in the browser, a view-only list
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
for (const scheme of ['dark', 'light']) {
  const inv = await (await fetch(`${base}/api/shares/invite`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: projects.Work, alias: `a11y ${scheme}`, access: 'view' }),
  })).json();
  const ctx = await phone(scheme, { userAgent: IPHONE_UA });
  const page = await ctx.newPage();
  await page.goto(inv.link);
  await page.waitForSelector('#ways:not([hidden])');
  await axe(page, `${scheme} invite page`);
  await page.click('#openBrowser');
  await page.waitForSelector('#sheet:has-text("Join shared list?")');
  await axe(page, `${scheme} join sheet`);
  await page.click('#sheet .btn.primary');
  await page.waitForSelector('.row');
  await page.waitForTimeout(300);
  await axe(page, `${scheme} view-only shared list`);
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
  // headless Chromium reports notifications as blocked; on a device that has not asked yet, Notifications is a switch
  await ctx.addInitScript(() => { if (window.Notification) Object.defineProperty(Notification, 'permission', { get: () => 'default' }); });
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

  // Settings: a view opens with focus on its Back button; Esc goes back one level, to the row that opened it
  check((await focused()).fk === 'back', `opening Settings puts focus on its Back button (${(await focused()).fk})`);
  const sync = await page.$eval('[data-fk="open:sync"]', (el) => `${el.textContent} | ${el.getAttribute('aria-description')}`);
  check(/^Sync & sharingSynced .+ \| Synced .+\. Pairing/.test(sync), `a page's row says how it stands, and what is on the page ("${sync}")`);
  await page.focus('[data-fk="open:sync"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check(await page.isVisible('.view-header h1:has-text("Sync & sharing")') && (await focused()).fk === 'back', 'a page opens with focus on its Back button');
  const adv = () => page.getAttribute('[data-fk="advanced"]', 'aria-expanded');
  const before2 = await adv();
  await page.focus('[data-fk="advanced"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check(before2 === 'false' && (await adv()) === 'true' && (await focused()).fk === 'advanced' && await page.isVisible('.g-row.danger:has-text("Unpair this device")'),
    'Advanced is a disclosure: it reports expanded, keeps focus, and shows Unpair under it');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(await page.isVisible('.view-header h1:has-text("Settings")') && (await focused()).fk === 'open:sync', `Esc goes back to Settings, focus on the page's row (${(await focused()).fk})`);
  await page.click('[data-fk="open:notifications"]');
  await page.waitForTimeout(150);
  const sw = await page.$eval('[role="switch"]', (el) => ({ checked: el.getAttribute('aria-checked'), name: el.textContent })).catch(() => null);
  check(sw?.checked === 'false' && /Notifications/.test(sw.name), `Notifications on / off is a switch with its state (${JSON.stringify(sw)})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(await page.isVisible('.row') && (await focused()).fk.startsWith('row:'), `Esc from Settings goes back to the list, focus on the selected task (${(await focused()).fk})`);

  // toasts reach screen readers through a live region that is always in the page
  await page.click('.row .more >> nth=0');
  await page.click('.menu-item.danger');
  await page.waitForTimeout(200);
  const said = await page.textContent('#announce');
  check(/Deleted.*Undo is available/i.test(said), `deleting is announced ("${said}")`);

  // the list switcher: the title is a menu button, its menu a real menu (arrows, Home / End, a letter, Enter, Esc, Tab)
  const title = await page.evaluate(() => { const b = document.getElementById('switcher'); return { name: b.textContent, popup: b.getAttribute('aria-haspopup'), expanded: b.getAttribute('aria-expanded') }; });
  check(title.name.startsWith('Work') && title.popup === 'menu' && title.expanded === 'false', `the title is a menu button named by its list (${JSON.stringify(title)})`);
  const inMenu = () => page.evaluate(() => { const a = document.activeElement; return { role: a?.getAttribute('role') ?? '', checked: a?.getAttribute('aria-checked') ?? '', name: a?.querySelector('.g-label')?.textContent ?? '' }; });
  const selBefore = await page.evaluate(() => document.querySelector('.row.sel')?.dataset.id ?? '');
  await page.focus('#switcher');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  let m = await inMenu();
  const selAfter = await page.evaluate(() => document.querySelector('.row.sel')?.dataset.id ?? '');
  check(m.role === 'menuitemradio' && m.checked === 'true' && m.name === 'Work' && (await page.getAttribute('#switcher', 'aria-expanded')) === 'true' && selAfter === selBefore,
    `Down on the title opens the lists menu on the current list, and moves no task selection (${JSON.stringify(m)})`);
  await page.keyboard.press('End'); const end = (await inMenu()).name;
  await page.keyboard.press('Home'); const first = (await inMenu()).name;
  await page.keyboard.press('ArrowUp'); m = await inMenu();
  check(end === 'New list' && first === 'General' && m.name === 'New list', `End, Home, and Up from the first goes round to the last (${end}, ${first}, ${m.name})`);
  await page.keyboard.press('h'); m = await inMenu();
  check(m.name === 'Home', `a typed letter goes to the list that starts with it (${m.name})`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check((await focused()).fk === 'switcher' && await page.isHidden('#listMenuWrap') && (await page.textContent('#switcher .switcher-name')) === 'Home', 'Enter switches to it and closes the menu, focus back on the title');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  check((await page.textContent('#switcher .switcher-name')) === 'Work' && /Work/.test(await page.textContent('#announce')), 'Left / Right on the title go to the previous / next list, and say which');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check((await focused()).fk === 'switcher' && await page.isHidden('#listMenuWrap') && await page.isVisible('.row'), 'Esc closes the menu (only the menu), focus on the title');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+m');
  await page.waitForTimeout(200);
  check((await focused()).inSheet && await page.isVisible('#sheet .menu-item:has-text("Rename")') && await page.isVisible('#sheet .menu-item:has-text("Move up")'), 'Ctrl+M on a list in the menu opens its own menu (rename, move, delete)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check((await focused()).fk === 'switcher', `closing that returns focus to the title (${(await focused()).fk})`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  const next = await page.evaluate(() => document.activeElement?.id ?? '');
  check(await page.isHidden('#listMenuWrap') && ['conflictsBadge', 'syncBtn'].includes(next), `Tab closes the menu and goes on from the title (${next})`);

  // the focus ring is for the keyboard: none after a click, also on focus that the app moves itself (Back puts it on
  // the row that opened the page) and in a text box, which the browser itself rings; Tab brings it back
  const ring = () => page.evaluate(() => {
    const a = document.activeElement;
    const s = getComputedStyle(a?.closest('.g-row.input') ?? a);
    return { fk: a?.dataset?.fk ?? '', input: document.documentElement.dataset.input, style: s.outlineStyle, width: s.outlineWidth, fv: !!a?.matches(':focus-visible') };
  });
  await page.click('#logo');
  await page.click('[data-fk="open:general"]');
  await page.click('.view-header .back');
  let r = await ring();
  check(r.fk === 'open:general' && r.input === 'pointer' && r.style === 'none', `after a click no ring, also where the app moved focus (${JSON.stringify(r)})`);
  await page.keyboard.press('Tab');
  r = await ring();
  check(r.fk === 'open:notifications' && r.input === 'keyboard' && r.style === 'solid' && r.width === '2px', `Tab: the ring shows (${JSON.stringify(r)})`);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');   // (General by the keyboard: its Back gets focus, ringed)
  await settled(page);
  r = await ring();
  check(r.fk === 'back' && r.style === 'solid', `a page opened with the keyboard: focus on Back, ringed (${JSON.stringify(r)})`);
  await page.keyboard.press('Escape');
  await page.click('[data-fk="open:sync"]');
  await page.click('[data-fk="join-input"]');
  r = await ring();
  check(r.fk === 'join-input' && r.fv && r.style === 'none', `a text box clicked: no ring round its row, though the browser counts it focus-visible (${JSON.stringify(r)})`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await settled(page);

  // in Settings the header is only ☰, pressed; the list's name and sync step aside (out of reach, unseen) and come back
  const header = () => page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return getComputedStyle(el).visibility === 'visible' && !el.inert && !el.closest('[inert]'); };
    const logo = document.getElementById('logo');
    return {
      settings: !!document.querySelector('#list .view-header'), pressed: logo.getAttribute('aria-pressed'), title: vis('switcher'), sync: vis('syncBtn'),
      tint: getComputedStyle(logo).backgroundColor === getComputedStyle(document.documentElement).getPropertyValue('--selected').trim().replace(/^#(..)(..)(..)$/, (m, a, b, c) => `rgb(${parseInt(a, 16)}, ${parseInt(b, 16)}, ${parseInt(c, 16)})`),
    };
  });
  let hd = await header();
  check(!hd.settings && hd.pressed === 'false' && hd.title && hd.sync && !hd.tint, `the list: the whole header, ☰ not pressed (${JSON.stringify(hd)})`);
  await page.click('#logo');
  await settled(page);
  hd = await header();
  check(hd.settings && hd.pressed === 'true' && !hd.title && !hd.sync && hd.tint, `Settings: only ☰, pressed and tinted (${JSON.stringify(hd)})`);
  await page.click('#logo');
  await settled(page);
  hd = await header();
  check(!hd.settings && hd.pressed === 'false' && hd.title && hd.sync, `☰ again: back to the list, the header with it (${JSON.stringify(hd)})`);

  // quick clicks and keys never leave two views or one half moved: ☰ five times; a double click is one click; a page
  // opened and closed by the keyboard faster than it moves
  const oneView = () => page.evaluate(() => {
    const list = document.getElementById('list');
    return {
      views: document.querySelectorAll('.list').length, settings: !!list.querySelector('.view-header'), pressed: document.getElementById('logo').getAttribute('aria-pressed'),
      title: getComputedStyle(document.getElementById('switcher')).visibility, moved: list.getAnimations().length + (list.style.transform || list.style.opacity || list.style.zIndex ? 1 : 0),
      h1: list.querySelector('.view-header h1')?.textContent ?? '',
    };
  });
  const consistent = (v) => v.views === 1 && v.moved === 0 && v.pressed === String(v.settings) && v.title === (v.settings ? 'hidden' : 'visible');
  const lb = await page.locator('#logo').boundingBox();   // (clicks where it is, not waiting for it to be still)
  for (let i = 0; i < 5; i++) await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await settled(page);
  let v = await oneView();
  check(consistent(v) && v.settings && v.h1 === 'Settings', `☰ five times quickly: Settings, as one view (${JSON.stringify(v)})`);
  await page.dblclick('#logo');
  await settled(page);
  v = await oneView();
  check(consistent(v) && !v.settings, `a double click on ☰ is one click: the list (${JSON.stringify(v)})`);
  await page.click('#logo');
  await page.focus('[data-fk="open:general"]');
  for (const k of ['Enter', 'Escape', 'Enter', 'Escape', 'Enter']) await page.keyboard.press(k);
  await settled(page);
  v = await oneView();
  check(consistent(v) && v.h1 === 'General' && (await focused()).fk === 'back', `General opened and closed five times by the keyboard: General, as one view, focus on Back (${JSON.stringify(v)})`);
  await page.click('#logo');
  await ctx.close();
}

// ---------------------------------------------------------------- 3. motion and zoom
console.log('3. reduced motion and zoom');
{
  const ctx = await phone('dark', { reducedMotion: 'reduce' });
  const page = await open(ctx, projects.Work);
  const t = await page.evaluate(() => [getComputedStyle(document.querySelector('.chev svg')).transitionDuration, getComputedStyle(document.querySelector('.switcher-chev svg')).transitionDuration, getComputedStyle(document.querySelector('.logo')).transitionDuration]);
  check(t.every((d) => /^0s/.test(d)), `no transitions with prefers-reduced-motion (${t})`);
  // Settings opens without moving: no view on its way out, the header at once; a press only tints (no shrinking)
  await page.click('#logo');
  const still = await page.evaluate(() => ({
    ghost: !!document.querySelector('.list.ghost'), anims: document.getElementById('list').getAnimations().length, title: getComputedStyle(document.getElementById('switcher')).visibility,
    shrink: getComputedStyle(document.documentElement).getPropertyValue('--press-icon').trim(),
  }));
  check(!still.ghost && !still.anims && still.title === 'hidden' && still.shrink === '1', `with reduce motion Settings opens without moving (${JSON.stringify(still)})`);
  await page.click('#logo');
  // a swipe still goes to the next list, but the list does not follow the finger or slide
  const cdp = await ctx.newCDPSession(page);
  const lb = await (await page.$('#list')).boundingBox();
  const y = lb.y + lb.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: lb.x + lb.width - 40, y }] });
  let followed = false;
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: lb.x + lb.width - 40 - i * 25, y }] });
    if (await page.evaluate(() => document.getElementById('list').style.transform || document.getElementById('list').getAnimations().length)) followed = true;
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  const moved = await page.evaluate(() => document.getElementById('list').getAnimations().length);
  check(!followed && !moved && (await page.textContent('#switcher .switcher-name')) === 'Home', 'with reduce motion a swipe switches lists without the list moving');
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
  await page.click('#switcher');
  const menu = await page.evaluate(() => { const r = document.getElementById('listMenu').getBoundingClientRect(); return { left: r.left, right: r.right, page: document.documentElement.scrollWidth - innerWidth }; });
  check(menu.left >= 0 && menu.right <= w && menu.page <= 0, `${label}: the lists menu fits (${JSON.stringify(menu)})`);
  await page.keyboard.press('Escape');
  await page.click('#logo');
  const fits = () => page.evaluate(() => Math.max(document.documentElement.scrollWidth - window.innerWidth, document.getElementById('list').scrollWidth - document.getElementById('list').clientWidth));
  const overSettings = await fits();
  await page.click('[data-fk="open:sync"]');
  const overSync = await fits();
  check(overSettings <= 0 && overSync <= 0, `${label}: settings fit too (${overSettings}, Sync & sharing ${overSync})`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `${fails} check(s) failed` : 'a11y pass ok');
process.exit(fails ? 1 : 0);
