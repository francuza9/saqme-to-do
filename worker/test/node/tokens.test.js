// The design tokens are the single source of truth for both platforms (docs/design.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { build, paths, palette, contrast } from '../../../scripts/build-tokens.mjs';

const { css, ps1, tokens } = build();

describe('design tokens', () => {
  it('generated CSS and PowerShell files are up to date', () => {
    expect(readFileSync(paths.css, 'utf8')).toBe(css);
    expect(readFileSync(paths.ps1, 'utf8')).toBe(ps1);
  });

  for (const [name, theme] of Object.entries(tokens.themes)) {
    const p = palette(theme);
    it(`${name}: text colours meet WCAG AA (4.5:1)`, () => {
      for (const k of ['ink', 'smoke', 'violet', 'amber', 'alert', 'closed']) {
        expect(contrast(p[k], p.surface), `${k} on surface`).toBeGreaterThanOrEqual(4.5);
      }
      for (const k of ['ink', 'smoke']) expect(contrast(p[k], p.frame), `${k} on frame`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.alert, p.alertWash), 'overdue pill').toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.amber, p.amberWash), 'due-soon pill').toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.noteInk, p.noteBg), 'notes').toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.smoke, p.hover), 'meta on a hovered row').toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.ink, p.selected), 'text on the selected row').toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.onViolet, p.violet), 'primary button label').toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.onDanger, p.danger), 'close button glyph on its red hover').toBeGreaterThanOrEqual(3);
      expect(contrast(p.onViolet, p.violet), 'the knob of a switch that is on').toBeGreaterThanOrEqual(3);
    });
    it(`${name}: status chips and their glyphs meet WCAG 1.4.11 (3:1), also on hovered and selected rows`, () => {
      const p = palette(theme);
      for (const k of ['Todo', 'Prog', 'Done', 'Post', 'Block', 'Rej', 'Aband']) {
        for (const bg of ['surface', 'hover', 'selected']) expect(contrast(p[`status${k}`], p[bg]), `${k} chip on ${bg}`).toBeGreaterThanOrEqual(3);
        if (p[`status${k}Glyph`]) expect(contrast(p[`status${k}Glyph`], p[`status${k}`]), `${k} glyph`).toBeGreaterThanOrEqual(3);
      }
      // the focus ring and the selected row's edge are violet: visible against the list and the row tint
      expect(contrast(p.violet, p.surface), 'focus ring on surface').toBeGreaterThanOrEqual(3);
      expect(contrast(p.violet, p.selected), 'focus ring on the selected row').toBeGreaterThanOrEqual(3);
    });
  }

  // Colours copied out of the tokens, and colours written by hand, are where the platforms drift apart.
  const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
  const dark = palette(tokens.themes.dark);
  const light = palette(tokens.themes.light);

  it('the browser and install colours are the tokens\' frame and surface', () => {
    const html = read('worker/public/index.html');
    const meta = (scheme) => new RegExp(`<meta name="theme-color" content="([^"]+)" media="\\(prefers-color-scheme: ${scheme}\\)">`).exec(html)?.[1];
    expect(meta('dark')).toBe(dark.frame);
    expect(meta('light')).toBe(light.frame);
    const manifest = JSON.parse(read('worker/public/manifest.webmanifest'));
    expect(manifest.theme_color).toBe(dark.frame);
    expect(manifest.background_color).toBe(dark.surface);
  });

  it('app.css takes every colour from the tokens (black only in masks and shadows)', () => {
    const css = read('worker/public/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const stray = [];
    for (const [, prop, value] of css.matchAll(/([-a-z]+)\s*:\s*([^;{}]+)/g)) {
      for (const [c] of value.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|\b(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver)\b/gi)) {
        const ok = (/mask-image$/.test(prop) && c === '#000') || (prop === 'box-shadow' && /^rgba\(0, 0, 0, \.\d+\)$/.test(c));
        if (!ok) stray.push(`${prop}: ${c}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it('the widget takes every colour from tokens.ps1 (transparent and mask black aside)', () => {
    for (const file of ['desktop/widget.ps1', 'desktop/qr.ps1', 'desktop/sync-worker.ps1']) {
      const ps = read(file).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      const stray = [
        ...[...ps.matchAll(/'#[0-9A-Fa-f]{6,8}'/g)].map((m) => m[0]).filter((c) => c !== "'#00000000'"),
        ...[...ps.matchAll(/\[(?:System\.Windows\.Media\.)?(?:Colors|Brushes)\]::(\w+)/g)].map((m) => m[1]).filter((n) => !['Transparent', 'Black'].includes(n)),
        ...[...ps.matchAll(/FromA?Rgb\(/g)].map((m) => m[0]),
        ...[...ps.matchAll(/(?:Foreground|Background|Fill|Stroke|BorderBrush|Color)="(?!\{)(?!Transparent")([^"]+)"/g)].map((m) => m[0]),
      ];
      expect(stray, file).toEqual([]);
    }
    // every brush the widget uses is one Set-Palette defines (a missing one draws nothing, silently)
    const ps = read('desktop/widget.ps1');
    const defined = new Set([...ps.matchAll(/@\('(\w+)',\s*'\w+'\)/g)].map((m) => m[1]));
    const tokenBrushes = /\$(Paper|White|Black|CloseGlyph|CloseHover|OnAccent|Accent|Card|StripBg|Edge|Hover|TabHover|TabInk|Ink|Faint|Line|NoteBg|NoteInk|MenuBg|MenuHover|Red|RedSoft|Amber|AmberSoft|Selected|ButtonBg|Closed)\b/g;
    const used = new Set([...ps.matchAll(tokenBrushes)].map((m) => m[1]));
    expect([...used].filter((n) => !defined.has(n)), 'brushes used but never defined').toEqual([]);
    // Colors.Black appears only as the opaque part of an opacity mask
    for (const line of read('desktop/widget.ps1').split('\n').filter((l) => /Colors\]::Black/.test(l))) expect(line).toMatch(/GradientStop/);
  });

  it('every bundled font file exists and is a TrueType font', () => {
    for (const f of tokens.font.files) {
      const head = readFileSync(new URL(`../../public/fonts/${f.file}`, import.meta.url)).subarray(0, 4);
      expect([...head]).toEqual([0, 1, 0, 0]);
    }
  });
});
