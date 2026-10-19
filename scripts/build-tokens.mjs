#!/usr/bin/env node
// Generates the platform files from design/tokens.json (the single source of truth, see docs/design.md):
//   worker/public/css/tokens.css   CSS custom properties + @font-face for the phone app
//   desktop/tokens.ps1             $Tokens and $Themes for the desktop widget (WPF ARGB colours)
//   node scripts/build-tokens.mjs           write both
//   node scripts/build-tokens.mjs --check   exit 1 if they are out of date (also enforced by the tests)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
export const paths = {
  tokens: join(repo, 'design', 'tokens.json'),
  css: join(repo, 'worker', 'public', 'css', 'tokens.css'),
  ps1: join(repo, 'desktop', 'tokens.ps1'),
};

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
/** t of `a` over `b` (sRGB). */
export const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v * t + rgb(b)[i] * (1 - t)));
function luminance(h) {
  return rgb(h).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Every colour both platforms use, derived from the six named ones. */
export function palette(theme) {
  const { surface, frame, ink, smoke, violet, amber } = theme.named;
  const s = theme.status;
  return {
    surface, frame, ink, smoke, violet, amber,
    alert: theme.alert,
    closed: theme.closed,
    line: mix(ink, surface, 0.12),
    hover: mix(ink, surface, 0.05),
    selected: mix(violet, surface, 0.14),
    noteBg: mix(ink, surface, 0.045),
    noteInk: mix(ink, surface, 0.8),
    edge: mix(ink, frame, 0.13),
    tabHover: mix(ink, frame, 0.06),
    menuHover: mix(ink, frame, 0.08),
    buttonBg: mix(ink, surface, 0.07),
    alertWash: mix(theme.alert, surface, theme.wash),
    amberWash: mix(amber, surface, theme.wash),
    danger: '#D94B45',
    // text on violet (primary buttons, selected segment): whichever reads better
    onViolet: contrast('#FFFFFF', violet) >= contrast(frame, violet) ? '#FFFFFF' : frame,
    statusTodo: s.todo, statusProg: s.prog, statusDone: s.done, statusPost: s.post,
    statusBlock: s.block, statusRej: s.rej, statusAband: s.aband,
    // the check, clock, !, x and dash drawn on filled chips: white unless that falls below 3:1 (WCAG 1.4.11)
    ...Object.fromEntries(['Done', 'Post', 'Block', 'Rej', 'Aband'].map((k) => {
      const c = s[k.toLowerCase()];
      return [`status${k}Glyph`, contrast('#FFFFFF', c) >= 3 ? '#FFFFFF' : frame];
    })),
  };
}

const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const argb = (hex, alpha = 'FF') => `#${alpha}${hex.slice(1).toUpperCase()}`;

export function buildCss(t) {
  const out = ['/* Generated from design/tokens.json by scripts/build-tokens.mjs - do not edit by hand. */'];
  for (const f of t.font.files) {
    out.push(`@font-face { font-family: '${t.font.family}'; src: url('../fonts/${f.file}') format('truetype'); font-weight: ${f.weight}; font-style: ${f.style}; font-display: swap; }`);
  }
  out.push(':root {');
  out.push(`  --font: '${t.font.family}', ${t.font.webFallback};`);
  for (const [name, v] of Object.entries(t.type)) {
    out.push(`  --t-${name}-size: ${v.size}px; --t-${name}-line: ${v.line}px; --t-${name}-weight: ${v.weight};`);
  }
  out.push(`  ${t.space.map((v, i) => `--space-${i + 1}: ${v}px;`).join(' ')}`);
  out.push(`  ${Object.entries(t.radius).map(([k, v]) => `--r-${k}: ${v}px;`).join(' ')}`);
  out.push(`  ${Object.entries(t.row).map(([k, v]) => `--row-${kebab(k)}: ${v}px;`).join(' ')}`);
  out.push(`  --grad-a: ${t.gradient[0]}; --grad-b: ${t.gradient[1]};`);
  out.push('}');
  for (const [name, theme] of Object.entries(t.themes)) {
    const p = palette(theme);
    out.push(`:root[data-theme='${name}'] {`);
    out.push(`  color-scheme: ${name};`);
    for (const [k, v] of Object.entries(p)) out.push(`  --${kebab(k)}: ${v};`);
    out.push(`  --thumb: ${name === 'dark' ? 'rgba(255, 255, 255, .25)' : 'rgba(0, 0, 0, .2)'};`);
    out.push(`  --backdrop: ${name === 'dark' ? 'rgba(8, 6, 10, .55)' : 'rgba(38, 36, 31, .35)'};`);
    out.push('}');
  }
  return `${out.join('\n')}\n`;
}

export function buildPs1(t) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const out = [
    '# Generated from design/tokens.json by scripts/build-tokens.mjs - do not edit by hand.',
    '# Dot-sourced by widget.ps1. Colours are WPF ARGB strings.',
    '$Tokens = @{',
    `  Font = @{ Family = ${q(t.font.family)}; Fallback = ${q(t.font.desktopFallback)}; Files = @(${t.font.files.map((f) => q(f.file)).join(', ')}) }`,
    `  Type = @{ ${Object.entries(t.type).map(([k, v]) => `${k} = @{ Size = ${v.size}; Line = ${v.line}; Weight = ${v.weight} }`).join('; ')} }`,
    `  Space = @(${t.space.join(', ')})`,
    `  Radius = @{ ${Object.entries(t.radius).map(([k, v]) => `${k} = ${v}`).join('; ')} }`,
    `  Row = @{ ${Object.entries(t.row).map(([k, v]) => `${k} = ${v}`).join('; ')} }`,
    '}',
    '$Themes = @{',
  ];
  for (const [name, theme] of Object.entries(t.themes)) {
    const p = palette(theme);
    // keys the widget has always used, mapped onto the shared palette
    const keys = {
      Card: p.surface, Strip: p.frame, Edge: p.edge, Hover: p.hover, TabHover: p.tabHover, TabInk: p.smoke,
      Ink: p.ink, Faint: p.smoke, Line: p.line, Accent: p.violet, Amber: p.amber, NoteBg: p.noteBg, NoteInk: p.noteInk,
      MenuBg: p.frame, MenuHover: p.menuHover, Selected: p.selected, ButtonBg: p.buttonBg, OnAccent: p.onViolet,
      Red: p.alert, RedSoft: p.alertWash, AmberSoft: p.amberWash, CloseHover: p.danger, Closed: p.closed,
      GradA: t.gradient[0], GradB: t.gradient[1],
      S_todo_edge: p.statusTodo, S_todo_text: p.ink,
      S_prog_chip: p.statusProg, S_prog_text: p.ink,
      S_done_chip: p.statusDone, S_done_text: p.closed, S_done_glyph: p.statusDoneGlyph,
      S_post_chip: p.statusPost, S_post_text: p.smoke, S_post_glyph: p.statusPostGlyph,
      S_block_chip: p.statusBlock, S_block_text: p.ink, S_block_glyph: p.statusBlockGlyph,
      S_rej_chip: p.statusRej, S_rej_text: p.closed, S_rej_glyph: p.statusRejGlyph,
      S_aband_chip: p.statusAband, S_aband_text: p.closed, S_aband_glyph: p.statusAbandGlyph,
    };
    out.push(`  ${name} = @{`);
    for (const [k, v] of Object.entries(keys)) out.push(`    ${k} = ${q(argb(v))}`);
    out.push(`    TipBg = ${q(argb(p.ink, 'F0'))}; TipFg = ${q(argb(p.surface))}; Thumb = ${q(name === 'dark' ? '#40FFFFFF' : '#33000000')}`);
    out.push('  }');
  }
  out.push('}');
  return `${out.join('\n')}\n`;
}

export function build() {
  const t = JSON.parse(readFileSync(paths.tokens, 'utf8'));
  return { css: buildCss(t), ps1: buildPs1(t), tokens: t };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { css, ps1 } = build();
  if (process.argv.includes('--check')) {
    const stale = [[paths.css, css], [paths.ps1, ps1]].filter(([p, s]) => { try { return readFileSync(p, 'utf8') !== s; } catch { return true; } });
    for (const [p] of stale) console.error(`out of date: ${p} (run node scripts/build-tokens.mjs)`);
    process.exit(stale.length ? 1 : 0);
  }
  writeFileSync(paths.css, css);
  writeFileSync(paths.ps1, ps1);
  console.log(`wrote ${paths.css}\nwrote ${paths.ps1}`);
}
