// Inline SVG icons (vector stand-ins for the Segoe MDL2 glyphs the desktop widget uses).

const S = (body, vb = '0 0 16 16') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  chevron: S('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  chevronDown: S('<path d="M3.5 6 8 10.5 12.5 6"/>'),
  back: S('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
  plus: S('<path d="M8 2.5v11M2.5 8h11"/>'),
  check: S('<path d="m3.2 8.4 3 3 6.6-7"/>', '0 0 16 16').replace('stroke-width="1.6"', 'stroke-width="2.4"'),
  clock: S('<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/>').replace('stroke-width="1.6"', 'stroke-width="2"'),
  bang: S('<path d="M8 3v6.2"/><circle cx="8" cy="12.6" r=".6" fill="currentColor"/>').replace('stroke-width="1.6"', 'stroke-width="2.4"'),
  cross: S('<path d="m4 4 8 8M12 4l-8 8"/>').replace('stroke-width="1.6"', 'stroke-width="2.4"'),
  minus: S('<path d="M3.5 8h9"/>').replace('stroke-width="1.6"', 'stroke-width="2.4"'),
  link: S('<path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>'),
  calendar: S('<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.8h11M5.5 2v3M10.5 2v3"/>'),
  note: S('<path d="M11.2 2.8 13.2 4.8 6 12l-2.8.8L4 10z"/>'),
  sub: S('<path d="M4 3v5.5a2 2 0 0 0 2 2h7"/><path d="m10.5 8 2.5 2.5-2.5 2.5"/>'),
  trash: S('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2"/>'),
  more: S('<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>'),
  grip: '<svg viewBox="0 0 8 13" aria-hidden="true" fill="currentColor"><circle cx="1.6" cy="1.6" r="1.3"/><circle cx="6.4" cy="1.6" r="1.3"/><circle cx="1.6" cy="6.5" r="1.3"/><circle cx="6.4" cy="6.5" r="1.3"/><circle cx="1.6" cy="11.4" r="1.3"/><circle cx="6.4" cy="11.4" r="1.3"/></svg>',
  indent: S('<path d="M2.5 3.5h11M7 8h6.5M7 12.5h6.5M2.5 6.5 5 8.5l-2.5 2"/>'),
  outdent: S('<path d="M2.5 3.5h11M7 8h6.5M7 12.5h6.5M5 6.5 2.5 8.5l2.5 2"/>'),
  up: S('<path d="M8 13V3M3.8 7.2 8 3l4.2 4.2"/>'),
  down: S('<path d="M8 3v10M3.8 8.8 8 13l4.2-4.2"/>'),
  move: S('<path d="M2.5 5V4a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9"/><path d="M1.5 9h6M5.5 7l2 2-2 2"/>'),
  edit: S('<path d="M2.5 13.5h11M4 10.5l7-7 2 2-7 7H4z"/>'),
  restore: S('<path d="M3 8a5 5 0 1 0 1.5-3.6"/><path d="M3 2.8v2.6h2.6"/>'),
  bell: S('<path d="M4 11.5V7.3a4 4 0 0 1 8 0v4.2l1 1.2H3z"/><path d="M6.6 14a1.5 1.5 0 0 0 2.8 0"/>'),
  cloud: S('<path d="M4.6 12.5h7a2.9 2.9 0 0 0 .4-5.8A4 4 0 0 0 4.3 7a2.8 2.8 0 0 0 .3 5.5z"/>'),
  cloudOk: S('<path d="M4.6 12.5h7a2.9 2.9 0 0 0 .4-5.8A4 4 0 0 0 4.3 7a2.8 2.8 0 0 0 .3 5.5z"/><path d="m6.3 9.4 1.3 1.3 2.4-2.6"/>'),
  cloudSync: S('<path d="M4.6 12.5h7a2.9 2.9 0 0 0 .4-5.8A4 4 0 0 0 4.3 7a2.8 2.8 0 0 0 .3 5.5z"/><path d="M6.4 9.6a1.7 1.7 0 0 1 3-1.2M9.6 9.3a1.7 1.7 0 0 1-3 1.2"/>'),
  cloudOff: S('<path d="M6 4.1A4 4 0 0 1 12 6.7a2.9 2.9 0 0 1 1.6 5M11.5 12.5H4.6A2.8 2.8 0 0 1 4.3 7"/><path d="m2.5 2.5 11 11"/>'),
  cloudErr: S('<path d="M4.6 12.5h7a2.9 2.9 0 0 0 .4-5.8A4 4 0 0 0 4.3 7a2.8 2.8 0 0 0 .3 5.5z"/><path d="M8 7.3v2"/><circle cx="8" cy="11" r=".5" fill="currentColor"/>'),
  conflict: S('<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.3" r=".5" fill="currentColor"/>'),
  phone: S('<rect x="4.5" y="1.5" width="7" height="13" rx="1.8"/><path d="M7.2 12.3h1.6"/>'),
  people: S('<circle cx="6" cy="5.6" r="2.2"/><path d="M2 13c.3-2.3 1.9-3.7 4-3.7s3.7 1.4 4 3.7"/><path d="M10.4 3.6a2.1 2.1 0 1 1 .5 4.1M11.6 9.5c1.3.4 2.2 1.6 2.4 3.5"/>'),
  share: S('<circle cx="11.8" cy="3.8" r="1.8"/><circle cx="4.2" cy="8" r="1.8"/><circle cx="11.8" cy="12.2" r="1.8"/><path d="m5.8 7.1 4.4-2.4M5.8 8.9l4.4 2.4"/>'),
  leave: S('<path d="M6.5 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/><path d="M10 5l3 3-3 3M13 8H6"/>'),
  eye: S('<path d="M1.8 8s2.3-4.3 6.2-4.3S14.2 8 14.2 8s-2.3 4.3-6.2 4.3S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>'),
  // the pages of Settings (General, Your lists, Updates, About)
  gear: S('<circle cx="8" cy="8" r="5.6" stroke-width="2.2" stroke-dasharray="2.2 2.2" stroke-linecap="butt"/><circle cx="8" cy="8" r="4.2"/><circle cx="8" cy="8" r="1.6"/>'),
  lists: S('<path d="M6 4h7.5M6 8h7.5M6 12h7.5"/><circle cx="2.9" cy="4" r=".9" fill="currentColor"/><circle cx="2.9" cy="8" r=".9" fill="currentColor"/><circle cx="2.9" cy="12" r=".9" fill="currentColor"/>'),
  update: S('<path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7"/><path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11"/>'),
  info: S('<circle cx="8" cy="8" r="5.9"/><path d="M8 7.3v4"/><circle cx="8" cy="4.9" r=".6" fill="currentColor"/>'),
};

const cache = new Map();

/** Returns a fresh SVG element for `name`. */
export function icon(name) {
  let tpl = cache.get(name);
  if (!tpl) {
    tpl = document.createElement('template');
    tpl.innerHTML = ICONS[name] ?? ICONS.more;
    cache.set(name, tpl);
  }
  return tpl.content.firstElementChild.cloneNode(true);
}

/** Glyph inside a status chip, same as the desktop chips. */
export const STATUS_GLYPH = { ' ': null, '/': null, x: 'check', '>': 'clock', '!': 'bang', '-': 'cross', '~': 'minus' };
