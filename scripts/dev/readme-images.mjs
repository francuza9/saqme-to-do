#!/usr/bin/env node
// Builds the README images in docs/images from the real apps and the sample lists:
//   logo.png                         the app icon at 2x for a ~120 px header
//   hero-dark.png / hero-light.png   desktop widget + phone side by side (dark UI; transparent for GitHub's
//                                    dark mode, on a plum panel for light mode)
//   phone-settings-dark/-light.png   small phone Settings shot for the setup steps
// Needs a local `npm run dev` server and the desktop render first:
//   powershell -File scripts\dev\render-widget.ps1 -Out <shots>          (writes <shots>\desktop-dark.png)
//   cd <folder with playwright> && node <repo>/scripts/dev/readme-images.mjs --shots <shots>
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, loadPlaywright, launch, devToken, seed, phonePage } from './screenshots.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = resolve(arg('shots', '.'));
const out = resolve(arg('out', join(repo, 'docs', 'images')));
const base = arg('base', 'http://localhost:8787');
mkdirSync(out, { recursive: true });

const dataUrl = (file) => `data:${file.endsWith('.ttf') ? 'font/ttf' : 'image/png'};base64,${readFileSync(file).toString('base64')}`;
const font = `@font-face { font-family: FiraGO; font-weight: 600; src: url(${dataUrl(join(repo, 'worker', 'public', 'fonts', 'FiraGO-SemiBold.ttf'))}); }`;

const playwright = loadPlaywright();
const token = devToken();
const projectIds = await seed(base, token);
const browser = await launch(playwright);

// ---------------------------------------------------------------- phone captures
// hero: as on an iPhone 14 in standalone mode - status bar (47) and home indicator (34) are drawn by the frame
let { ctx, page } = await phonePage(browser, { base, token, projectId: projectIds.Work, scheme: 'dark', height: 844 - 47 - 34, standalone: true });
const phoneList = await page.screenshot({ type: 'png' });
await ctx.close();
const settings = {};
for (const scheme of ['dark', 'light']) {
  ({ ctx, page } = await phonePage(browser, { base, token, projectId: projectIds.Work, scheme, scale: 2, standalone: true }));
  await page.click('#logo');
  await page.waitForTimeout(400);
  settings[scheme] = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 390, height: 470 } });
  await ctx.close();
}

// ---------------------------------------------------------------- compositions
const compose = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1000, height: 800 } });
async function shoot(html, selector, file) {
  await compose.setContent(`<!doctype html><style>${font} html, body { margin: 0; background: transparent; }</style>${html}`);
  await compose.evaluate(() => document.fonts.ready);
  await compose.locator(selector).screenshot({ path: join(out, file), omitBackground: true });
}
const b64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

await shoot(`<img id="logo" src="${dataUrl(join(repo, 'desktop', 'assets', 'saqme.png'))}" style="display:block;width:120px;height:120px">`, '#logo', 'logo.png');

const scale = 646 / 868;   // the phone as tall as the desktop window
const phone = `
  <div style="width:${414 * scale}px;height:${868 * scale}px;flex:none">
    <div style="width:414px;height:868px;transform:scale(${scale});transform-origin:0 0;box-sizing:border-box;
                border-radius:62px;padding:12px;background:#050407;box-shadow:0 0 0 2px #4A4352, 0 24px 60px rgba(0,0,0,.45)">
      <div style="width:390px;height:844px;border-radius:50px;overflow:hidden;background:#1E1A23;display:flex;flex-direction:column">
        <div style="height:47px;flex:none;background:#15121A;position:relative;font:600 16px FiraGO;color:#EFEAF4">
          <span style="position:absolute;left:46px;top:15px">9:41</span>
          <span style="position:absolute;left:135px;top:11px;width:120px;height:35px;border-radius:18px;background:#000"></span>
          <span style="position:absolute;right:30px;top:17px;width:24px;height:12px;border:1.5px solid rgba(239,234,244,.5);border-radius:4px;box-sizing:border-box;padding:1.5px">
            <span style="display:block;height:100%;width:80%;background:#EFEAF4;border-radius:1.5px"></span></span>
        </div>
        <img src="${b64(phoneList)}" style="display:block;width:390px;height:${844 - 47 - 34}px">
        <div style="height:34px;flex:none;position:relative">
          <span style="position:absolute;left:128px;bottom:8px;width:134px;height:5px;border-radius:3px;background:#EFEAF4"></span>
        </div>
      </div>
    </div>
  </div>`;
const desktop = `<img src="${dataUrl(join(shots, 'desktop-dark.png'))}" style="display:block;width:440px;height:660px;flex:none">`;
const stage = (bg) => `<div id="hero" style="width:920px;height:740px;display:flex;align-items:center;justify-content:center;gap:48px;
  background:${bg};border-radius:28px">${desktop}${phone}</div>`;
await shoot(stage('transparent'), '#hero', 'hero-dark.png');
await shoot(stage('#261F2C'), '#hero', 'hero-light.png');

for (const scheme of ['dark', 'light']) {
  const edge = scheme === 'dark' ? 'rgba(239,234,244,.16)' : 'rgba(37,33,28,.16)';
  await shoot(`<div id="s" style="display:inline-block;padding:2px"><img src="${b64(settings[scheme])}"
    style="display:block;width:390px;height:470px;border-radius:28px;box-shadow:0 0 0 1px ${edge}"></div>`, '#s', `phone-settings-${scheme}.png`);
}
await browser.close();
console.log(`wrote logo.png, hero-dark.png, hero-light.png, phone-settings-dark.png, phone-settings-light.png to ${out}`);
