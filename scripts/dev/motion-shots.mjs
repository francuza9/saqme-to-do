#!/usr/bin/env node
// Phone screenshots of how Settings moves (docs/design.md, "Motion"), against a local `npm run dev` (fresh database
// recommended): the list, Settings, Settings > General at rest, and frames of the moves between them, taken with the
// app's own animations paused at a given time. Dark theme by default. From worker/ (Playwright is installed there):
//   node ../scripts/dev/motion-shots.mjs --out ~/shots [--base http://localhost:8787] [--scheme light] [--at 70,140,210] [--fade-at 40,90,140]
// Writes phone-list, phone-settings, phone-general, phone-open-<ms>ms (list to Settings), phone-push-<ms>ms (Settings to
// General) and phone-back-<ms>ms (General back to Settings), each -<scheme>.png.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, devToken, launch, loadPlaywright, phonePage, seed } from './screenshots.mjs';

const out = resolve(arg('out', '.'));
const base = arg('base', 'http://localhost:8787');
const scheme = arg('scheme', 'dark');
const at = arg('at', '70,140,210').split(',').map(Number);   // (a page: 280 ms)
const fadeAt = arg('fade-at', '40,90,140').split(',').map(Number);   // (Settings from the list: out by 90 ms, in from 60 to 220)
mkdirSync(out, { recursive: true });
const token = devToken();
const projectIds = await seed(base, token);
const browser = await launch(loadPlaywright());
const { ctx, page } = await phonePage(browser, { base, token, projectId: projectIds.Work, scheme, standalone: true });
const shot = (name) => page.screenshot({ path: join(out, `phone-${name}-${scheme}.png`) });
// the click, then every animation of the move paused at ms (the syncing cloud's endless pulse aside)
const moveAt = (selector, ms) => page.evaluate(([sel, t]) => {
  document.querySelector(sel).click();
  for (const a of document.getAnimations()) if (a.effect?.getTiming().iterations !== Infinity) { a.pause(); a.currentTime = t; }
}, [selector, ms]);
const finish = () => page.evaluate(() => { for (const a of document.getAnimations()) if (a.effect?.getTiming().iterations !== Infinity) a.finish(); });
const settle = async () => { await finish(); await page.waitForTimeout(50); };

await shot('list');
for (const ms of fadeAt) {
  await moveAt('#logo', ms); await shot(`open-${ms}ms`);
  await settle(); await page.click('#logo'); await settle();   // (back to the list for the next frame)
}
await page.click('#logo'); await settle();
await shot('settings');
for (const ms of at) {
  await moveAt('[data-fk="open:general"]', ms); await shot(`push-${ms}ms`);
  await settle();
  if (ms === at[at.length - 1]) await shot('general');
  await moveAt('#list .view-header .back', ms); await shot(`back-${ms}ms`);
  await settle();
}
await ctx.close();
await browser.close();
console.log(`saved phone-*-${scheme}.png to ${out}`);
