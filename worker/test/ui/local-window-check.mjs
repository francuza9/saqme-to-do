// The Linux/macOS app's window (the phone app served by local/saqme.mjs), Settings > Sync: Set up sync with a
// stand-in for scripts/cloud-setup.mjs, its progress and sign-in link, the QR code afterwards, Turn off sync.
// Needs Playwright (see pwa-ui-check.mjs):
//   node test/ui/local-window-check.mjs
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'saqme-window-'));
mkdirSync(join(dir, 'lists'));
writeFileSync(join(dir, 'lists', 'Work.md'), '- [ ] Write the report\n');
const fake = join(dir, 'fake-cloud-setup.mjs');
writeFileSync(fake, `
  import { writeFileSync, mkdirSync } from 'node:fs';
  import { dirname } from 'node:path';
  const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
  console.log('[2/7] Cloudflare account');
  console.log('          Log in to Cloudflare: a browser window opens - sign in and click "Allow".');
  console.log('Please visit https://dash.cloudflare.com/oauth2/auth?response_type=code to sign in');
  await new Promise((r) => setTimeout(r, 2500));
  mkdirSync(dirname(arg('--desktop-config')), { recursive: true });
  writeFileSync(arg('--desktop-config'), JSON.stringify({ url: 'https://saqme.invalid', token: '${'k'.repeat(43)}', deviceId: 'pc-x', enabled: true }));
  writeFileSync(arg('--result'), JSON.stringify({ ok: true, url: 'https://saqme.invalid' }));
`);
process.env.SAQME_CLOUD_SETUP_JS = fake;
process.env.SAQME_CLOUD_STATE = join(dir, 'setup', 'cloud.json');
const { startApp } = await import('../../../local/saqme.mjs');
const app = await startApp({ dataDir: dir, port: 0, interval: 500, cloudInterval: 60_000, settleMs: 0, reminders: false });

let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  const { code } = await (await fetch(`${app.url}/api/local/code`, { method: 'POST', headers: { authorization: `Bearer ${app.token}` } })).json();
  await page.goto(`${app.url}/#claim=${code}`);
  await page.waitForSelector('#switcher:has-text("Work")');
  await page.click('#switcher');
  check((await page.$$eval('#listMenu [role="menuitemradio"] .g-label', (e) => e.map((x) => x.textContent))).join() === 'Work', 'the title opens the lists menu: the lists folder\'s lists');
  await page.keyboard.press('Escape');
  await page.click('#logo');
  // the window's own pages: Updates, and the lists folder under Your lists
  await page.waitForSelector('[data-fk="open:updates"]');
  check(await page.isVisible('[data-fk="open:updates"]') && /Saqme To Do \d+\.\d+\.\d+/.test(await page.textContent('#list .version-line')), 'Settings has Updates (the window updates itself) and the version line');
  await page.click('[data-fk="open:lists"]');
  check((await page.textContent('#list')).includes(join(dir, 'lists')), 'Your lists says where the lists folder is');
  await page.keyboard.press('Escape');
  await page.click('[data-fk="open:sync"]');
  await page.waitForSelector('button:has-text("Set up sync")');
  const text = await page.textContent('#list');
  check(/your own free sync service in your Cloudflare account/.test(text) && /nothing is deleted/.test(text) && /one sign-in in the browser/.test(text), 'Set up sync explains itself in plain words (the footnote under it)');
  check((await page.getAttribute('button:has-text("Set up sync")', 'title'))?.includes('nothing is deleted'), '... also as a tooltip');
  await page.click('button:has-text("Set up sync")');
  await page.waitForSelector('.g-row:has-text("Setting up…")');
  await page.waitForSelector('.setup-log a[href^="https://dash.cloudflare.com/oauth2/auth"]');
  check(true, 'progress shows, with the sign-in link clickable');
  await page.screenshot({ path: join(tmpdir(), 'saqme-window-setup-running.png') });
  await page.waitForSelector('#sheet:has-text("Pair a phone")', { timeout: 15000 });
  check(await page.isVisible('#sheet img.qr'), 'when it is done, the QR code for the phone');
  await page.screenshot({ path: join(tmpdir(), 'saqme-window-setup-done.png') });
  await page.keyboard.press('Escape');
  check(await page.isVisible('.view-header h1:has-text("Sync & sharing")'), 'Esc closes the sheet only (the page stays)');
  // Turn off sync is under Advanced, at the bottom of the page
  check(!(await page.isVisible('button:has-text("Turn off sync")')), 'Turn off sync is not among the everyday rows');
  await page.click('[data-fk="advanced"]');
  await page.waitForSelector('button:has-text("Turn off sync")');
  const off = await page.textContent('#list');
  check(/stops syncing/.test(off) && /lists stay on this computer/.test(off) && /kept until you delete it there/.test(off), 'Turn off sync (under Advanced) says what stays');
  check(errors.length === 0, `no page errors (${errors.join('; ')})`);
} finally {
  await browser.close();
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `${fails} check(s) failed` : 'local window pass ok');
process.exit(fails ? 1 : 0);
