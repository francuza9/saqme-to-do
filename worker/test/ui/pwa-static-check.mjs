#!/usr/bin/env node
// The phone app served as plain static files from a sub-folder, as GitHub Pages does (.github/workflows/pages.yml):
// local-only use, export / import as markdown, offline start, and pairing with a Worker on another origin.
// Optional QA tool like pwa-ui-check.mjs (Playwright is not a dependency):
//   cd worker && npm i --no-save playwright@1 && npx playwright install chromium     (once)
//   npm run dev                                                                       (another terminal; for the pairing step)
//   node test/ui/pwa-static-check.mjs
let chromium, devices;
try { ({ chromium, devices } = await import('playwright')); } catch {
  console.error('Playwright is not installed. In worker/: npm i --no-save playwright@1 && npx playwright install chromium');
  process.exit(2);
}
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../../public/js/zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', '..', 'public');
const token = /^AUTH_TOKEN=(.*)$/m.exec(readFileSync(join(here, '..', '..', '.dev.vars'), 'utf8'))[1];
const worker = process.env.SAQME_BASE || 'http://localhost:8787';
let fails = 0;
const check = (c, m) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${m}`); if (!c) fails++; };

// ---- a static host: /saqme/* -> worker/public, no API, no special headers (like GitHub Pages)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
let offline = false;
const host = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (offline || !path.startsWith('/saqme/')) { res.writeHead(404); res.end('not found'); return; }
  const file = normalize(join(publicDir, path.slice('/saqme/'.length) || 'index.html'));
  try { if (!file.startsWith(publicDir) || !statSync(file).isFile()) throw new Error(); } catch { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${host.address().port}/saqme/`;

const browser = await chromium.launch();
const phone = { ...devices['Pixel 7'], colorScheme: 'dark', acceptDownloads: true };
const errors = [];
const watch = (page) => { page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); }); };
const texts = (page) => page.$$eval('.row .text', (els) => els.map((e) => e.textContent));

// ---- 1. local-only use from the static copy
let ctx = await browser.newContext(phone);
let page = await ctx.newPage();
watch(page);
await page.goto(site);
await page.waitForSelector('.welcome');
check(await page.isVisible('text=Use it on this device'), 'welcome offers local use first');
await page.click('text=Use it on this device');
for (const t of ['Water the plants', 'Call Anna']) { await page.fill('#addInput', t); await page.press('#addInput', 'Enter'); }
await page.waitForTimeout(300);
check((await texts(page)).join('|') === 'Water the plants|Call Anna', 'tasks added and kept on the device');
const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
check(scope === site, `service worker scoped to the sub-folder (${scope})`);

// ---- 2. export -> zip in the desktop format (Settings > Your lists)
await page.click('#logo');
await page.click('[data-fk="open:lists"]');
const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-fk="do:Export lists"]')]);
const zipPath = join(mkdtempSync(join(tmpdir(), 'saqme-static-')), download.suggestedFilename());
await download.saveAs(zipPath);
const entries = await readZip(new Uint8Array(readFileSync(zipPath)));
const general = entries.find((e) => e.name === 'General.md');
check(/^saqme-lists-\d{4}-\d{2}-\d{2}\.zip$/.test(download.suggestedFilename()), `export file name (${download.suggestedFilename()})`);
check(!!general && /^- \[ \] Water the plants \^[0-9a-z]{8}\n- \[ \] Call Anna \^[0-9a-z]{8}\n$/.test(general.text), 'export holds the list as markdown with ids');
check(entries.some((e) => e.name === '.order'), 'export keeps the tab order');

// ---- 3. offline start
await page.click('#logo');
offline = true;
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('.row .text');
check((await texts(page)).length === 2, 'opens offline with its data');
await ctx.setOffline(false);
offline = false;
await ctx.close();

// ---- 4. import into another device (a fresh browser profile). This one also pairs with the dev Worker in
// step 5, which is plain http: the app's policy only lets it connect to https origins (as real Workers are),
// so CSP is bypassed for this profile; steps 1-3 ran with it enforced.
ctx = await browser.newContext({ ...phone, bypassCSP: true });
page = await ctx.newPage();
watch(page);
await page.goto(site);
await page.click('text=Use it on this device');
await page.click('#logo');
// (a static host has no version to tell: the line under Settings says the app's name only)
check((await page.textContent('#list .version-line')) === 'Saqme To Do', `static host: the version line without a version (${await page.textContent('#list .version-line')})`);
await page.click('[data-fk="open:lists"]');
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-fk="do:Import lists"]')]);
const extra = join(dirname(zipPath), 'Errands.md');
writeFileSync(extra, '- [ ] Post office\n  - [x] Stamps\n');
await chooser.setFiles([zipPath, extra]);
await page.waitForSelector('.toast:has-text("Imported")');
check(/Imported 4 tasks and 1 new list/.test(await page.textContent('.toast')), `import message (${await page.textContent('.toast')})`);
await page.click('#logo');
check((await texts(page)).join('|') === 'Water the plants|Call Anna', 'imported list shows its tasks');
const [again] = await Promise.all([page.waitForEvent('filechooser'), (async () => { await page.click('#logo'); await page.click('[data-fk="open:lists"]'); await page.click('[data-fk="do:Import lists"]'); })()]);
await again.setFiles([zipPath]);
await page.waitForSelector('.toast:has-text("already here")');
check(/Imported 0 tasks \(2 already here\)/.test(await page.textContent('.toast')), 'importing again adds nothing');

// ---- 5. pair this static copy with a Worker on another origin
let workerUp = false;
try { workerUp = (await fetch(`${worker}/api/health`)).ok; } catch { /* not running */ }
if (!workerUp) console.log(`  --   pairing skipped: no Worker at ${worker} (npm run dev)`);
else {
  // not paired, a list shared from elsewhere: this copy sends them to the invite's own page, and uses nothing up
  const projects = (await (await fetch(`${worker}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'static-check', cursor: 0, changes: [{ kind: 'project', id: 'staticp1', fields: { name: { v: 'Static check', ts: Date.now(), base: -1 }, pos: { v: 'z0', ts: Date.now(), base: -1 } } }] }) })).json());
  check(!!projects.cursor, 'a list on the Worker to share');
  const inv = await (await fetch(`${worker}/api/shares/invite`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'staticp1', alias: 'Static', access: 'view' }) })).json();
  await page.click('#logo');   // (Your lists -> the list -> Settings > Sync & sharing)
  await page.click('#logo');
  await page.click('[data-fk="open:sync"]');
  await page.fill('[data-fk="join-input"]', inv.link);
  await page.click('[data-fk="join-go"]');
  await page.waitForSelector('#sheet:has-text("Open the invite link instead")');
  check(await page.isVisible(`#sheet a[href="${inv.link}"]`), 'not paired: a list from another address opens from its invite page');
  await page.click('#sheet .btn:has-text("Not now")');
  const claim = await fetch(`${worker}/api/shares/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inv.code }) });
  check(claim.ok, 'and the invite was not used up');
  await page.fill('[data-fk="pair-input"]', `${worker}/#pair=${token}`);
  await page.click('[data-fk="pair-go"]');
  await page.waitForSelector('#sheet:has-text("Sync with")');
  check((await page.textContent('#sheet')).includes(new URL(worker).host), 'pairing with another server says which one first');
  await page.click('#sheet .btn.primary');
  let uploaded = [];
  for (let i = 0; i < 40 && !uploaded.includes('Post office'); i++) {
    await page.waitForTimeout(250);
    const r = await (await fetch(`${worker}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'static-check', cursor: 0, changes: [] }) })).json();
    uploaded = r.changes.filter((c) => c.kind === 'task' && !c.fields.deleted.v).map((c) => c.fields.text.v);
  }
  check(uploaded.includes('Post office') && uploaded.includes('Water the plants'), 'lists uploaded to the Worker across origins (CORS)');
  check(await page.isVisible(`text=${new URL(worker).host}`), 'settings show the Worker it syncs with');
}
check(errors.length === 0, `no page errors (${errors.join('; ')})`);
await browser.close();
host.close();
console.log(fails ? `${fails} check(s) failed` : 'static pass ok');
process.exit(fails ? 1 : 0);
