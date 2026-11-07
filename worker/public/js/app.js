// Saqme To Do — iPhone PWA. Mirrors the desktop widget: lists (the title switches them), status chips, collapsible
// tasks, deadlines, notes with links, Postponed section, folded Completed, drag to reorder, move to project.

import { Store, SHARING_API, OLDER_SERVER, SELF_UPDATE_API, CONNECTOR_API } from './store.js';
import { AI_LINKS, aiOptions } from './ai.js';
import {
  STATUSES, statusOf, rank, sections, forToday, kidsInDisplayOrder, progress, linkify, listCounts, subtreeIds, isAncestor,
  cleanText, cleanNotes,   // same cleanup as the server (worker/src/merge.js): saving never changes text by itself
} from './model.js';
import { parseDue, dueTone } from './dates.js';
import { icon, STATUS_GLYPH } from './icons.js';
import { makeZip, readZip } from './zip.js';
import { parsePairingLink, normalizePairingCode, parseInviteLink, serverLabel } from './pairing.js';
import { t, tn, rich, lang, setLang, pickLang, LANGS, LANG_NAMES, dueText, dueLongText, quickDatesText, dateText } from './i18n.js';

const ls = {
  get: (k, d = '') => { try { return localStorage.getItem(`saqme.${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`saqme.${k}`, v); } catch { /* private mode */ } },
};
// The app's language (Settings > General > Language; '' = the device's), before anything is drawn
await setLang(pickLang(ls.get('lang'), navigator.languages));
document.documentElement.lang = lang();

// Inside another site's frame the app does not start: a page could trick taps onto it (clickjacking). The
// Worker forbids framing with a header; a copy on a static host (GitHub Pages) can only do it here.
if (window.top !== window.self) {
  const a = Object.assign(document.createElement('a'), { href: location.href, target: '_blank', rel: 'noopener', textContent: t('app.openOutsideFrame') });
  document.body.replaceChildren(a);
  throw new Error('Saqme To Do does not run inside a frame.');
}

const store = new Store();
const $ = (id) => document.getElementById(id);
const els = {
  strip: $('strip'), switcher: $('switcher'), menuWrap: $('listMenuWrap'), menu: $('listMenu'), scrim: $('listMenuScrim'),
  list: $('list'), logo: $('logo'), sync: $('syncBtn'), conflicts: $('conflictsBadge'),
  addBar: $('addBar'), add: $('addInput'), addGo: $('addGo'), addPlus: $('addPlus'), sheetWrap: $('sheetWrap'), sheet: $('sheet'), backdrop: $('sheetBackdrop'),
  toast: $('toast'), announce: $('announce'), app: $('app'),
};
/** The words of the page itself (index.html): its buttons' names, the add line's placeholder; again after a language switch. */
function applyStaticTexts() {
  els.logo.setAttribute('aria-label', t('nav.settings'));
  els.conflicts.setAttribute('aria-label', t('nav.conflicts'));
  els.sync.setAttribute('aria-label', t('sync.statusLabel'));
  els.menu.setAttribute('aria-label', t('list.menuLabel'));
  els.addPlus.setAttribute('aria-label', t('add.button'));
  els.addGo.setAttribute('aria-label', t('add.button'));
  els.add.placeholder = t('add.placeholder');
  els.add.setAttribute('aria-label', t('add.placeholder'));
  els.toast.setAttribute('aria-label', t('toast.label'));
}
applyStaticTexts();
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const ui = {
  view: 'list',          // list | settings | one of its pages (PAGES) | keys | trash | conflicts
  focusKey: '',          // the control (data-fk) that gets keyboard focus after the next render (a view just opened)
  advancedOpen: false,   // Settings > Sync & sharing > Advanced
  project: ls.get('project'),
  today: ls.get('today') === '1',   // the For Today view (open tasks due soon, from every list) instead of a list
  editing: null,         // { id } or { draft: { projectId, parentId, index, afterId, depth } }
  notesEditing: null,    // task id
  sel: null,
  visible: [],
  pointerDown: false,
  renderPending: false,
  welcomeSkipped: ls.get('localOnly') === '1',
  local: null,           // the Linux/macOS app's info (lists folder, cloud sync) when served by it
  localUnpaired: false,  // served by that app, but not opened through it (no token yet)
};

const MAX_TEXT = 10_000;
const MAX_NOTES = 50_000;

// ---------------------------------------------------------------- DOM helpers
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof el[k] !== 'object') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** A message with <b>…</b> parts (i18n.js rich) as nodes; tags: what to build for a tag instead (e.g. { b: (text) => a button }). */
const richText = (key, vars, tags = {}) => rich(key, vars).map((p) => (typeof p === 'string' ? p : (tags[p.tag] ?? ((x) => h(p.tag, {}, x)))(p.text)));

function chip(mark) {
  const s = statusOf(mark);
  const g = STATUS_GLYPH[mark];
  return h('span', { class: `chip s-${s.key}` }, g ? icon(g) : null);
}

// Status changes made on this device animate once, on the row the next render builds (never sync, never first paint)
const statusAnim = new Map();   // task id -> { from, to, at }
/** Sets a task's status from this device's UI; the row it lands in animates the change. */
function setStatus(id, mark) {
  const from = store.get('task', id)?.fields.status.v;
  // (noted first: the change renders at once)
  if (from != null && from !== mark && !reducedMotion()) {
    statusAnim.set(id, { from, to: mark, at: performance.now() });
    if (rank(mark) !== 2) cancelHold(id);
    else if (rank(from) !== 2) holdRow(id, rank(from));
  }
  if (store.setTask(id, { status: mark })) return true;
  statusAnim.delete(id);
  cancelHold(id);
  return false;
}

// A task closed on this device stays in its place while the strike-through draws (STRIKE_MS) and for a beat, then
// fades out and drops into Completed; the data is written at once, only the row's move waits. Sync never holds.
const STRIKE_MS = 260;
const HOLD_MS = STRIKE_MS + 320;
const holds = new Map();   // task id -> { rank: where it sat, timer }
const heldRank = (n) => holds.get(n.id)?.rank ?? rank(n.task.fields.status.v);
function holdRow(id, was) {
  cancelHold(id);
  holds.set(id, { rank: was, timer: setTimeout(() => {
    const row = els.list.querySelector(`.row[data-id="${id}"]`);
    const fade = row?.closest('.task-item')?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out', fill: 'forwards' });
    const go = () => { if (holds.delete(id)) render(); };
    if (fade) fade.finished.then(go, go); else go();
  }, HOLD_MS) });
}
function cancelHold(id) {
  const hold = holds.get(id);
  if (!hold) return;
  clearTimeout(hold.timer);
  holds.delete(id);
}
/** The row's chip and text play the change that setStatus() left for it (150-300 ms, subtle). */
function playStatusAnim(id, chipEl, textEl) {
  const a = statusAnim.get(id);
  if (!a) return;
  statusAnim.delete(id);
  if (performance.now() - a.at > 1000 || reducedMotion() || !chipEl) return;
  const opt = (ms) => ({ duration: ms, easing: 'cubic-bezier(.33, 1, .68, 1)' });
  chipEl.animate?.([{ transform: 'scale(.6)', opacity: 0.4 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.6 }, { transform: 'none', opacity: 1 }], opt(220));
  chipEl.firstElementChild?.animate?.([{ transform: 'scale(0) rotate(-60deg)' }, { transform: 'none' }], opt(220));
  if (!textEl) return;
  if (rank(a.to) === 2 && rank(a.from) !== 2) {
    // the strike-through line draws across the text: a copy of it, drawn only as its line, uncovered left to right
    textEl.dataset.text = textEl.textContent;
    textEl.classList.add('striking');
    const done = () => textEl.classList.remove('striking');
    const draw = textEl.animate?.([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0)' }], { ...opt(260), pseudoElement: '::after' });
    if (draw) draw.finished.then(done, done); else done();
  } else {
    textEl.animate?.([{ opacity: 0.35 }, { opacity: 1 }], opt(200));
  }
}

let toastTimer;
function toast(text, action) {
  clearTimeout(toastTimer);
  els.toast.replaceChildren(...[h('span', {}, text), action && h('button', { onclick: () => { els.toast.hidden = true; action.run(); } }, action.label)].filter(Boolean));
  els.toast.hidden = false;
  announce(action ? t('toast.withAction', { text, action: action.label }) : text);
  const hide = () => { toastTimer = setTimeout(() => { els.toast.hidden = true; }, action ? 5000 : 2600); };
  // a toast with an action (Undo) stays while it has keyboard focus or the pointer
  els.toast.onfocusin = els.toast.onpointerenter = () => clearTimeout(toastTimer);
  els.toast.onfocusout = els.toast.onpointerleave = () => { clearTimeout(toastTimer); hide(); };
  hide();
}
/** Screen readers: a live region that is always in the page (one that appears with its text is often missed). */
function announce(text) {
  els.announce.textContent = '';
  setTimeout(() => { els.announce.textContent = text; }, 50);
}

// ---------------------------------------------------------------- render scheduling
// Renders wait while a finger/mouse is down, so a tap that blurs an editor still lands on its target.
function requestRender() {
  if (ui.pointerDown) { ui.renderPending = true; return; }
  if (ui.rafQueued) return;
  ui.rafQueued = true;
  requestAnimationFrame(() => { ui.rafQueued = false; render(); });
}
document.addEventListener('pointerdown', () => { ui.pointerDown = true; }, true);
const pointerEnd = () => setTimeout(() => {
  ui.pointerDown = false;
  if (ui.renderPending) { ui.renderPending = false; requestRender(); }
}, 0);
document.addEventListener('pointerup', pointerEnd, true);
document.addEventListener('pointercancel', pointerEnd, true);

// ---------------------------------------------------------------- keyboard focus: a ring for the keyboard only
// The last kind of input is kept on the root (data-input: pointer or keyboard), and app.css draws no focus ring after a
// tap or a click, also where a browser would: a text box, or focus the app moves after a tap (WebKit rings that).
// Focus the app moves itself asks for the ring only after keys (focusVisible, where a browser takes it).
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn']);
const setInput = (kind) => { if (document.documentElement.dataset.input !== kind) document.documentElement.dataset.input = kind; };
const keyboardInput = () => document.documentElement.dataset.input === 'keyboard';
setInput('pointer');   // (until a key is pressed)
document.addEventListener('pointerdown', () => setInput('pointer'), true);
document.addEventListener('keydown', (e) => {
  if (MODIFIER_KEYS.has(e.key)) return;
  // typing in a text box is not moving around (Tab and Esc are)
  if (e.target instanceof Element && e.target.matches('input, textarea, [contenteditable]') && e.key !== 'Tab' && e.key !== 'Escape') return;
  setInput('keyboard');
}, true);
/** Moves keyboard focus to el; the ring shows when the keyboard is in use. */
function focusOn(el) {
  el?.focus({ preventScroll: true, focusVisible: keyboardInput() });
}
// (iOS Safari applies :active, the press feedback, only where touches are listened to)
document.addEventListener('touchstart', () => {}, { passive: true });

function currentProject() {
  const list = store.projects();
  if (!list.length) return null;
  let p = list.find((x) => x.id === ui.project);
  if (!p) { p = list[0]; ui.project = p.id; ls.set('project', p.id); }
  return p;
}

function render() {
  // the DOM is rebuilt on every change: keep keyboard focus on the same control (by its data-fk key)
  const fk = document.activeElement?.dataset?.fk;
  // before the user starts (welcome screen) the header is just the logo, which opens Settings
  els.switcher.hidden = els.sync.hidden = showWelcome();
  // in Settings (any view but the list) it is only ☰, pressed: the rest steps aside (app.css) and is out of reach at once
  const inSettings = ui.view !== 'list';
  els.app.classList.toggle('in-settings', inSettings);
  els.logo.setAttribute('aria-pressed', String(inSettings));
  els.switcher.inert = els.sync.inert = els.conflicts.inert = inSettings;
  if (els.switcher.hidden || inSettings) closeListMenu({ focus: false });
  renderSwitcher();
  renderStatus();
  els.list.classList.toggle('swipeable', ui.view === 'list' && !ui.today && !showWelcome() && store.projects().length > 1);
  if (!(ui.editing || ui.notesEditing || ui.drag)) renderMain();   // never pull the rug while typing / dragging
  if (ui.focusKey) {
    // a view just opened: focus on what go() asked for, else on its Back button (keyboard and screen readers land there)
    const want = ui.focusKey;
    ui.focusKey = '';
    if (!focusKey(want) && ui.view !== 'list') focusKey('back');
  } else if (fk && (document.activeElement === document.body || !document.activeElement?.isConnected)) focusKey(fk);
}

// ---------------------------------------------------------------- shared lists
// A list someone shares with this device ("with me": its binding, from the store or, in the Linux/macOS window,
// from the local app), or one of this device's own lists it shares with others ("by me"). docs/sync.md.
function sharing(projectId) {
  const s = store.shareOf(projectId) ?? ui.local?.shares?.find((x) => x.projectId === projectId);
  if (s) return { withMe: s };
  if (store.sharedByMe(projectId) || ui.local?.sharedByMe?.includes(projectId)) return { byMe: true };
  return null;
}
const readOnly = (projectId) => sharing(projectId)?.withMe?.access === 'view';
const hostOf = (server) => { try { return new URL(server).host; } catch { return server || location.host; } };
/**
 * A list's name as shown: one shared with this device whose name another list here has says whose it is,
 * "Groceries (from nuca)". (In the Linux/macOS window it is the file's name, which already does.)
 */
function listName(p) {
  const name = p.fields.name.v;
  const sh = store.shareOf(p.id);
  if (!sh) return name;
  const lower = name.toLowerCase();
  const clash = store.projects().some((x) => x.id !== p.id && x.fields.name.v.toLowerCase() === lower && (store.shareOf(x.id)?.server ?? '') !== sh.server);
  return clash ? t('list.nameFrom', { name, from: serverLabel(sh.server) }) : name;
}
/** A list used here in the browser from its owner's address (no sync of one's own), not through a sync service. */
const inBrowser = (sh) => !ui.local && sh?.via === 'direct';
/** The two kinds of access to a shared list: name (and in a sentence: lower), help (about them; you: about oneself). */
const ACCESS = () => ({
  edit: { name: t('access.edit'), lower: t('access.editLower'), help: t('access.editHelp'), you: t('access.editHelpYou') },
  view: { name: t('access.view'), lower: t('access.viewLower'), help: t('access.viewHelp'), you: t('access.viewHelpYou') },
});
/** A sharing call's error -> what to say: "not updated yet" when one's own sync service is older than sharing. */
function shareError(e) {
  const older = ui.local ? (ui.local.cloud?.workerApi ?? SHARING_API) < SHARING_API : store.olderServer(SHARING_API);
  return older ? t(OLDER_SERVER) : e.message;
}
const canShare = () => (ui.local ? !!ui.local.cloud : !!store.meta.token);

/** The local app's API for the Linux/macOS window, the phone app's own server otherwise. */
const shareApi = {
  list: (pid) => api(ui.local ? `local/shares?project=${pid}` : `shares?project=${pid}`),
  invite: (pid, alias, access) => api(ui.local ? 'local/shares/invite' : 'shares/invite', { projectId: pid, alias, access }),
  update: (id, access) => api(ui.local ? 'local/shares/update' : 'shares/update', { id, access }),
  revoke: (id) => api(ui.local ? 'local/shares/revoke' : 'shares/revoke', { id }),
};

// ---------------------------------------------------------------- the list switcher: the title and the lists menu
// The header's title is the current list's name: one button that opens the lists menu under it (docs/design.md,
// "The list switcher"). A list's own menu (share, rename, move, delete; leave for one shared with you) opens with a
// long press or a right-click on its row there, or on the title for the current list. A sideways swipe on the list
// goes to the next or previous list, and so do Left / Right on the title.

/** A list shared with this device or by it: what to say about it, and its badge. */
function sharedMark(projectId) {
  const sh = sharing(projectId);
  if (!sh) return null;
  const access = ACCESS()[sh.withMe?.access];
  return {
    about: sh.withMe ? t('list.sharedWithYou', { access: access?.name ?? '' }) : t('list.shared'),
    lower: sh.withMe ? t('list.sharedWithYouLower', { access: access?.lower ?? '' }) : t('list.sharedLower'),
    icon: sh.withMe?.access === 'view' ? 'eye' : 'people',
  };
}
const sharedBadge = (m) => (m ? [h('span', { class: 'shared-badge', 'aria-hidden': 'true' }, icon(m.icon)), h('span', { class: 'sr-only' }, `, ${m.lower}`)] : null);
/** A count in words, "3 open": the number shows, the words around it are for screen readers only. */
function srAroundNumber(words, n) {
  const at = words.indexOf(String(n));
  if (at < 0) return [h('span', { class: 'sr-only' }, words)];
  const before = words.slice(0, at);
  const after = words.slice(at + String(n).length);
  return [before ? h('span', { class: 'sr-only' }, before) : null, String(n), after ? h('span', { class: 'sr-only' }, after) : null];
}

/** A list's row value in the menu: "2 due" (alert when one is overdue, amber when all are due today), else its open count. */
function listValue(c) {
  if (c?.due) {
    const about = c.over === c.due ? tn('list.overdue', c.due) : c.over ? t('list.dueAndOverdue', { due: c.due, over: c.over }) : tn('list.dueToday', c.due);
    return { text: tn('list.due', c.due), tone: c.over ? 'over' : 'soon', about };
  }
  return c?.open ? { text: String(c.open), tone: '', about: tn('list.open', c.open), n: c.open } : null;
}

/** The title: the list's name, its shared badge, ⌄, and a violet dot when another list has something due. */
function renderSwitcher() {
  const cur = currentProject();
  const counts = listCounts(store.tasks());
  const due = ui.today ? [] : store.projects().filter((p) => p.id !== cur?.id && counts.get(p.id)?.due);
  const mark = cur && !ui.today ? sharedMark(cur.id) : null;
  const name = ui.today ? t('today.title') : cur ? listName(cur) : t('list.lists');
  // (the dot has its words in the tooltip and for screen readers; the menu says which list and how many)
  const dueWords = due.length ? t('list.dueIn', { lists: due.map(listName).join(', ') }) : '';
  els.switcher.replaceChildren(...[
    h('span', { class: 'switcher-name' }, name),
    sharedBadge(mark),
    h('span', { class: 'switcher-chev', 'aria-hidden': 'true' }, icon('chevronDown')),
    due.length ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null].flat().filter(Boolean));
  els.switcher.title = [name, mark?.about, dueWords].filter(Boolean).join(' · ');
  els.switcher.setAttribute('aria-description', [t('list.yourLists'), dueWords].filter(Boolean).join('. '));
  if (menuOpen()) renderListMenu(counts);
}

const menuOpen = () => !els.menuWrap.hidden;
const menuItems = () => [...els.menu.querySelectorAll('[role^="menuitem"]')];

/** The lists menu: one row per list in their order (the current one checked), then "New list" in a card of its own. */
function renderListMenu(counts = listCounts(store.tasks())) {
  const cur = currentProject();
  const soon = todayRows();
  const anyOver = soon.some((r) => r.bucket === 'over');
  const todayAbout = soon.length ? tn(anyOver ? 'list.dueSoonOver' : 'list.dueSoon', soon.length) : '';
  const todayRow = h('button', {
    class: 'g-row lm-item', role: 'menuitemradio', 'aria-checked': String(ui.today), tabindex: '-1',
    title: [t('today.title'), t('today.about'), todayAbout].filter(Boolean).join(' · '), dataset: { fk: 'list-today', id: 'today' },
    onclick: () => { if (!els.sheetWrap.hidden) return; closeListMenu(); showToday(); },
  },
  h('span', { class: 'check', 'aria-hidden': 'true' }, ui.today ? icon('check') : null),
  h('span', { class: 'g-label' }, t('today.title')),
  soon.length ? h('span', { class: `g-value${anyOver ? ' lm-over' : ''}` }, h('span', { class: 'sr-only' }, ', '), srAroundNumber(todayAbout, soon.length)) : null);
  const rows = store.projects().map((p) => {
    const isCur = !ui.today && p.id === cur?.id;
    const v = listValue(counts.get(p.id));
    const mark = sharedMark(p.id);
    const row = h('button', {
      class: 'g-row lm-item', role: 'menuitemradio', 'aria-checked': String(isCur), tabindex: '-1',
      title: [listName(p), mark?.about, v?.about].filter(Boolean).join(' · '), dataset: { fk: `list:${p.id}`, id: p.id },
      onclick: () => { if (!els.sheetWrap.hidden) return; closeListMenu(); switchList(p.id); },   // (not the release of a long press)
    },
    h('span', { class: 'check', 'aria-hidden': 'true' }, isCur ? icon('check') : null),
    h('span', { class: 'g-label' }, listName(p)),
    sharedBadge(mark),
    v ? h('span', { class: `g-value${v.tone ? ` lm-${v.tone}` : ''}` }, h('span', { class: 'sr-only' }, ', '), v.tone ? v.text : srAroundNumber(v.about, v.n)) : null);
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); listOptions(p.id, { fromMenu: true }); });
    onLongPress(row, () => listOptions(p.id, { fromMenu: true }));
    return row;
  });
  const add = h('button', {
    class: 'g-row action lm-item lm-new', role: 'menuitem', tabindex: '-1', dataset: { fk: 'list-new' },
    onclick: () => { closeListMenu(); projectNameSheet(null); },
  }, h('span', { class: 'check', 'aria-hidden': 'true' }, icon('plus')), h('span', { class: 'g-label' }, t('list.new')));
  els.menu.replaceChildren(...[rows.length ? h('div', { class: 'group lm-today', role: 'group', 'aria-label': t('list.acrossAll') }, todayRow) : null,
    rows.length ? h('div', { class: 'group lm-lists', role: 'group', 'aria-label': t('list.yourLists') }, rows) : null, h('div', { class: 'group', role: 'group' }, add)].filter(Boolean));
}

/** Opens the lists menu with focus on the current list (focus: 'last' for "New list", or a list:<id> key). */
function openListMenu({ focus = '' } = {}) {
  if (menuOpen() || els.switcher.hidden) return;
  const editing = ui.editing || ui.notesEditing;
  commitAll();
  if (editing) render();   // (the editor goes, also when nothing in it changed)
  renderListMenu();
  els.menuWrap.hidden = false;
  els.switcher.setAttribute('aria-expanded', 'true');
  els.list.inert = els.addBar.inert = true;   // (under the scrim: no tapping or tabbing into it)
  placeListMenu();
  const items = menuItems();
  const to = focus === 'last' ? items[items.length - 1]
    : (focus && els.menu.querySelector(`[data-fk="${CSS.escape(focus)}"]`)) || els.menu.querySelector('[aria-checked="true"]') || items[0];
  focusOn(to);
  to?.scrollIntoView({ block: 'nearest' });
}
/** Closes it; focus goes back to the title (not when a tap elsewhere took it). */
function closeListMenu({ focus = true } = {}) {
  if (!menuOpen()) return;
  els.menuWrap.hidden = true;
  els.switcher.setAttribute('aria-expanded', 'false');
  els.list.inert = els.addBar.inert = false;
  if (focus) focusOn(els.switcher);
}
/** Its scrim from the header down to the window's bottom; the menu under the title, its left edge on the title's, inside the window (an iPhone's safe areas included). */
function placeListMenu() {
  const app = els.app.getBoundingClientRect();
  const strip = els.strip.getBoundingClientRect();
  const title = els.switcher.getBoundingClientRect();
  const right = parseFloat(getComputedStyle(els.strip).paddingRight) || 12;
  els.menuWrap.style.height = `${app.bottom - strip.bottom}px`;
  els.menu.style.setProperty('--menu-top', `${title.bottom - strip.bottom + 6}px`);
  els.menu.style.left = `${Math.max(0, Math.min(title.left - strip.left, strip.width - els.menu.offsetWidth - right))}px`;
}

/** Shows a list (from Settings too); its tasks from the top. */
function switchList(id) {
  if (ui.view === 'list' && !ui.today && ui.project === id) return;
  commitAll();
  ui.view = 'list';
  ui.today = false; ls.set('today', '0');
  ui.project = id; ls.set('project', id); ui.sel = null;
  render();
  els.list.scrollTop = 0;
}
/** The For Today view (from Settings too); its tasks from the top. */
function showToday() {
  if (ui.view === 'list' && ui.today) return;
  commitAll();
  ui.view = 'list';
  ui.today = true; ls.set('today', '1'); ui.sel = null;
  render();
  els.list.scrollTop = 0;
}
/** A task in its own list: the list opens with the task selected (its parents opened) and in view. */
function showInList(id) {
  const t = store.get('task', id);
  if (!t) return;
  commitAll();
  const project = t.fields.place.v.project;
  const node = nodeOf(id)?.node;
  for (let p = node?.parent; p; p = p.parent) setOpen(p.id, true);
  ui.today = false; ls.set('today', '0');
  ui.view = 'list';
  ui.project = project; ls.set('project', project);
  ui.sel = id;
  render();
  const row = els.list.querySelector('.row.sel');
  row?.scrollIntoView({ block: 'center' });
  focusOn(row);
}
const flash = { id: '', until: 0 };   // the task a tapped reminder opened: highlighted for a moment (.row.flash)
let wantedTask = null;                // { id, until }: a reminder's task this phone does not have (yet); sync may still bring it
/**
 * A deadline reminder was tapped (the service worker's message, or #task=<id> when the tap started the app): its
 * task opens in its list, in view and briefly highlighted. A task deleted since opens nothing; one that moved
 * opens where it is now. A task this phone has not got yet is waited for (the next sync) for a while.
 */
function openReminderTask(id) {
  if (!/^[0-9a-z]{8,32}$/.test(id || '')) return;
  const t = store.get('task', id);
  if (!t || t.fields.deleted.v) { wantedTask = { id, until: Date.now() + 20_000 }; return; }
  wantedTask = null;
  closeSheet();
  flash.id = id; flash.until = Date.now() + 2000;
  showInList(id);
  setTimeout(() => { for (const r of els.list.querySelectorAll('.row.flash')) r.classList.remove('flash'); }, 1900);
}
function readTaskLink() {
  const m = /^#task=([0-9a-z]{8,32})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  openReminderTask(m[1]);
}
/** What For Today shows now: [{ task, bucket }], in the order of their deadlines. */
const todayRows = () => forToday(store.tasks(), new Date(), store.projects().map((p) => p.id));

/** The next (1) or previous (-1) list in their order; null past either end (it does not wrap round). */
function neighbourList(dir) {
  if (ui.today) return null;
  const list = store.projects();
  const i = list.findIndex((p) => p.id === currentProject()?.id);
  return i < 0 ? null : list[i + dir] ?? null;
}
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Goes one list on (swipe, Left / Right on the title): the new list slides in from that side, and is announced. */
function stepList(dir) {
  const p = neighbourList(dir);
  if (!p) return false;
  switchList(p.id);
  if (!reducedMotion()) els.list.animate?.([{ transform: `translateX(${dir * 40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  announce(listName(p));
  return true;
}

els.switcher.addEventListener('click', () => {
  if (!els.sheetWrap.hidden) return;   // (the release of a long press that opened the list's own menu)
  if (menuOpen()) closeListMenu(); else openListMenu();
});
els.switcher.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  // Down / Up open the menu (on the current list / on "New list"); Left / Right go to the previous / next list, as
  // on the Windows app's tabs. (Not the list's keys: those would move the task selection.)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') openListMenu({ focus: e.key === 'ArrowUp' ? 'last' : '' });
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stepList(e.key === 'ArrowRight' ? 1 : -1);
  else return;
  e.preventDefault();
  e.stopPropagation();
});
// the current list's own menu: a right-click or a long press on the title, as on its tab before
els.switcher.addEventListener('contextmenu', (e) => { e.preventDefault(); if (currentProject() && !ui.today) listOptions(currentProject().id); });
onLongPress(els.switcher, () => { if (currentProject() && !ui.today) listOptions(currentProject().id); });

const typed = { text: '', at: 0 };
els.menu.addEventListener('keydown', (e) => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  const to = (j) => focusOn(items[(j + items.length) % items.length]);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'm') {
    // a list's own menu, like Ctrl+M on a task (also Shift+F10, the menu key and a right-click: contextmenu)
    if (document.activeElement?.dataset.id) listOptions(document.activeElement.dataset.id, { fromMenu: true });
  } else if (mod || e.altKey) return;
  else if (e.key === 'ArrowDown') to(i + 1);
  else if (e.key === 'ArrowUp') to(i < 0 ? -1 : i - 1);
  else if (e.key === 'Home' || e.key === 'PageUp') to(0);
  else if (e.key === 'End' || e.key === 'PageDown') to(-1);
  else if (e.key === 'Escape') closeListMenu();
  else if (e.key === 'Tab') { closeListMenu(); return; }   // focus is on the title now: Tab goes on from there
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { /* nothing sideways in this menu */ }
  else if (e.key.length === 1 && e.key !== ' ') {
    // type the start of a list's name to get to it (one letter again: the next list with it)
    typed.text = e.timeStamp - typed.at < 700 ? typed.text + e.key.toLowerCase() : e.key.toLowerCase();
    typed.at = e.timeStamp;
    const from = typed.text.length > 1 ? Math.max(i, 0) : i + 1;
    for (let k = 0; k < items.length; k++) {
      const el = items[(from + k) % items.length];
      if (el.querySelector('.g-label')?.textContent.toLowerCase().startsWith(typed.text)) { focusOn(el); break; }
    }
  } else return;
  e.preventDefault();
  e.stopPropagation();
});
els.scrim.addEventListener('click', () => closeListMenu());
// a tap anywhere else (the header's other buttons, outside the window) closes it too, and does what it does
document.addEventListener('pointerdown', (e) => {
  if (menuOpen() && !els.menuWrap.contains(e.target) && !els.switcher.contains(e.target)) closeListMenu({ focus: false });
}, true);
window.addEventListener('resize', () => { if (menuOpen()) placeListMenu(); });

// ---------------------------------------------------------------- swipe between lists
// A sideways swipe on the list goes to the next (to the left) or previous (to the right) list. Only a clearly
// sideways move counts: an up-and-down one is the list's scroll (the browser keeps that: touch-action: pan-y), a
// drag on a task's handle stays a drag, a long press its menu; nothing starts in a text box, while editing, or at
// the screen's edges (the system's own back gesture). With reduce motion the list does not follow the finger.
const SWIPE_SLOP = 10;   // px before a move has a direction
const SWIPE_MIN = 64;    // px that switch the list on release (or a quick flick past 24 px)
let swipe = null;
els.list.addEventListener('pointerdown', (e) => {
  swipe = null;
  if (e.pointerType === 'mouse' || !e.isPrimary || !els.list.classList.contains('swipeable')) return;
  if (ui.editing || ui.notesEditing || ui.drag || !els.sheetWrap.hidden || menuOpen()) return;
  if (e.target.closest('.grip, input, textarea, select') || e.clientX < 16 || e.clientX > innerWidth - 16) return;
  swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, on: false };
});
els.list.addEventListener('pointermove', (e) => {
  const s = swipe;
  if (!s || e.pointerId !== s.id) return;
  const dx = e.clientX - s.x;
  const dy = e.clientY - s.y;
  if (!s.on) {
    if (Math.abs(dy) > SWIPE_SLOP && Math.abs(dy) >= Math.abs(dx)) { swipe = null; return; }   // a scroll
    if (Math.abs(dx) < SWIPE_SLOP || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
    if (ui.drag || ui.editing || !els.sheetWrap.hidden) { swipe = null; return; }   // (a drag or a long press came first)
    s.on = true;
    els.list.classList.add('swiping');
    try { els.list.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
  }
  s.dx = dx;
  if (reducedMotion()) return;
  // the list follows the finger; past the first or the last list it gives only a little
  const shown = neighbourList(dx < 0 ? 1 : -1) ? dx : dx / 4;
  els.list.style.transform = `translateX(${shown}px)`;
  els.list.style.opacity = String(1 - Math.min(Math.abs(shown) / els.list.clientWidth, 1) * 0.6);
});
function endSwipe(e) {
  const s = swipe;
  if (!s || e.pointerId !== s.id) return;
  swipe = null;
  if (!s.on) return;
  els.list.classList.remove('swiping');
  ui.swipedAt = Date.now();   // (the release is not a tap on what is under the finger)
  const from = { transform: els.list.style.transform || 'none', opacity: els.list.style.opacity || '1' };
  els.list.style.transform = els.list.style.opacity = '';
  const flick = Math.abs(s.dx) > 24 && Math.abs(s.dx) / Math.max(1, e.timeStamp - s.t) > 0.5;
  if (e.type === 'pointerup' && (Math.abs(s.dx) >= SWIPE_MIN || flick) && stepList(s.dx < 0 ? 1 : -1)) return;
  if (!reducedMotion()) els.list.animate?.([from, { transform: 'none', opacity: 1 }], { duration: 160, easing: 'ease-out' });
}
els.list.addEventListener('pointerup', endSwipe);
els.list.addEventListener('pointercancel', endSwipe);
els.list.addEventListener('click', (e) => { if (Date.now() - (ui.swipedAt ?? 0) < 400) { e.preventDefault(); e.stopPropagation(); } }, true);

/**
 * A list's own menu: Share, Rename, Move up / down, Delete; for a list shared with you, where it comes from, Move up /
 * down and Leave (its name and its deletion are its owner's). fromMenu: opened from the lists menu, which opens again
 * after a move so the new order shows.
 */
function listOptions(id, { fromMenu = false } = {}) {
  const p = store.get('project', id);
  if (!p) return;
  commitAll();
  const list = store.projects();
  const i = list.findIndex((x) => x.id === id);
  const move = (dir) => () => { store.moveProject(id, dir); if (fromMenu) openListMenu({ focus: `list:${id}` }); };
  const moves = [
    i > 0 && menuItem('up', t('menu.moveUp'), move(-1)),
    i < list.length - 1 && menuItem('down', t('menu.moveDown'), move(1)),
  ];
  const sh = sharing(id)?.withMe;
  if (sh) {
    // someone else's list: its name and its deletion are theirs; leaving takes it off this device only
    const a = ACCESS()[sh.access];
    sheet(listName(p), [
      h('p', { class: 'sheet-note' }, t('share.withYouFrom', { host: hostOf(sh.server), access: a?.name, help: a?.you })),
      ...moves,
      inBrowser(sh) ? menuItem('share', t('share.moveToApp'), () => moveToAppSheet(sh), { keepOpen: true }) : null,
      h('div', { class: 'menu-sep' }),
      menuItem('leave', t('share.leaveList'), () => confirmLeave(id), { danger: true }),
    ]);
    return;
  }
  sheet(p.fields.name.v, [
    canShare() ? menuItem('share', t('share.share'), () => shareSheet(id), { keepOpen: true })
      : menuItem('share', t('share.share'), () => {}, { disabled: true, hint: t('share.needsSyncHint'), title: t('share.needsSync') }),
    menuItem('edit', t('list.rename'), () => projectNameSheet(id)),
    ...moves,
    h('div', { class: 'menu-sep' }),
    menuItem('trash', t('list.delete'), () => confirmDeleteProject(id), { danger: true }),
  ]);
}

function confirmLeave(projectId, share = null) {
  const p = projectId ? store.get('project', projectId) : null;
  const sh = share ?? sharing(projectId)?.withMe;
  if (!sh) return;
  const goes = ui.local ? t('share.leaveGoesComputer') : inBrowser(sh) ? t('share.leaveGoesBrowser') : t('share.leaveGoesApp');
  sheet(t('share.leaveTitle', { name: p ? listName(p) : sh.name }), [
    h('p', {}, goes),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')),
      h('button', { class: 'btn primary', onclick: async () => {
        closeSheet();
        try {
          // (its reminders end with the key, on the owner's server)
          if (ui.local) { await api('local/leave', { id: sh.id }); await loadLocalInfo(); } else store.leaveShare(sh.id);
          toast(t('share.left', { name: p?.fields.name.v ?? sh.name }));
        } catch (e) { toast(t('share.couldNotLeave', { error: e.message })); }
        render();
      } }, t('share.leave'))),
  ]);
}

/** The owner's Share sheet: invite someone (one-time link), see who has it, change or end their access. */
async function shareSheet(projectId) {
  const p = store.get('project', projectId);
  if (!p) return;
  const state = { access: 'edit', invite: null, people: null, error: '', open: null, busy: false };
  const name = h('input', {
    class: 'g-input', placeholder: t('share.namePlaceholder'), maxLength: 60, autocapitalize: 'words', 'aria-label': t('share.nameLabel'),
    'aria-description': t('share.nameHelp'), enterKeyHint: 'done', dataset: { fk: 'share-name' },
  });
  const draw = () => {
    if (els.sheetWrap.hidden && state.drawn) return;   // closed meanwhile
    state.drawn = true;
    const accessPick = h('div', { class: 'segmented share-access', role: 'group', 'aria-label': t('share.access') },
      ...Object.entries(ACCESS()).map(([v, a]) => h('button', {
        class: v === state.access ? 'on' : '', 'aria-pressed': String(v === state.access), title: a.help, dataset: { fk: `access:${v}` },
        onclick: () => { state.access = v; draw(); },
      }, a.name)));
    const create = async () => {
      const alias = name.value.trim();
      if (!alias) { name.classList.add('bad'); name.focus(); return; }
      if (state.busy) return;
      state.busy = true; draw();
      try {
        state.invite = await shareApi.invite(projectId, alias, state.access);
        name.value = '';
        if (ui.local) loadLocalInfo();
        else if (!store.sharedByMe(projectId)) store.setMeta({ shared: [...(store.meta.shared ?? []), projectId] });
        state.busy = false;
        await refresh();
      } catch (e) { state.busy = false; state.error = shareError(e); draw(); }
    };
    name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } };
    name.oninput = () => name.classList.remove('bad');
    // who (a name only you see), what they may do, and the link; then who has it, one row each
    const out = [
      head(t('share.inviteSomeone'), 3),
      card(inputRow(name), infoRow(t('share.access'), '', accessPick),
        actionRow(state.busy ? t('share.creating') : t('share.createLink'), create, { name: t('share.createLink'), fk: 'share-create' })),
      foot(t('share.inviteFoot', { help: ACCESS()[state.access].help })),
      state.error ? foot(state.error, { alert: true }) : null,
    ];
    if (state.invite) out.push(...inviteBlock(state.invite));
    out.push(head(t('share.sharedWith'), 3));
    if (!state.people) out.push(note(t('common.loading')));
    else if (!state.people.length) out.push(note(t('share.nobodyYet')));
    else out.push(card(state.people.map((s) => personRows(s, state, draw, refresh))));
    out.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, t('btn.done'))));
    // (the sheet is rebuilt: keyboard focus stays on the same control)
    const fk = els.sheet.contains(document.activeElement) ? document.activeElement?.dataset?.fk : '';
    sheet(t('share.title', { name: p.fields.name.v }), out);
    if (fk) focusKey(fk);
    if (state.error) announce(state.error);
  };
  const refresh = async () => {
    try { state.people = (await shareApi.list(projectId)).shares; state.error = ''; } catch (e) { state.people = state.people ?? []; state.error = shareError(e); }
    store.sync({ force: true });
    draw();
  };
  draw();
  name.focus();
  await refresh();
}

/** The invite just made: its link with Copy (and a QR code on larger screens), and what it does. */
function inviteBlock(inv) {
  const box = h('input', { class: 'g-input', value: inv.link, readOnly: true, 'aria-label': t('share.inviteLink'), onfocus: (e) => e.target.select(), dataset: { fk: 'invite-link' } });
  const out = [
    head(t('share.inviteLink'), 3),
    h('div', { class: 'group invite' }, inputRow(box, textButton(t('btn.copy'), () => copyText(inv.link, t('share.inviteCopied')), { name: t('share.copyInvite'), fk: 'invite-copy' }))),
    foot(t('share.inviteMade', { alias: inv.share.alias, access: ACCESS()[inv.share.access].lower, until: dateText(inv.expiresAt, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })),
  ];
  if (matchMedia('(min-width: 560px) and (pointer: fine)').matches) {
    const img = h('img', { class: 'qr in-group', alt: t('share.inviteQr'), hidden: true });
    import('./qr.js').then(({ qrMatrix, qrToSvg }) => {
      const svg = qrToSvg(qrMatrix(inv.link, 'M'), { margin: 4, scale: 5 });
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      img.hidden = false;
    }).catch(() => {});
    out.push(img);
  }
  return out;
}

/**
 * One person a list is shared with: a row (their name, their access or "Invited") that opens the rows under it: when
 * they joined or were invited, the access choices, and revoke / cancel the invite / remove it.
 */
function personRows(s, state, draw, refresh) {
  const when = (ms) => dateText(ms, { day: 'numeric', month: 'short' });
  const stand = s.state === 'joined' ? t('share.joinedOn', { date: when(s.joinedAt) }) : s.state === 'pending' ? t('share.invitedOn', { date: when(s.createdAt) }) : t('share.inviteExpired');
  const access = ACCESS()[s.access]?.name ?? s.access;
  const value = s.state === 'joined' ? access : s.state === 'pending' ? t('share.invited') : t('share.expired');
  const open = state.open === s.id;
  const act = async (fn, done) => { try { await fn(); toast(done); } catch (e) { toast(e.message); } await refresh(); };
  const rows = [h('button', {
    class: 'g-row link person', 'aria-expanded': String(open), 'aria-description': t('share.personAbout', { stand }), title: stand, dataset: { fk: `person:${s.id}` },
    onclick: () => { state.open = open ? null : s.id; draw(); },
  }, rowParts(s.alias, { value, trailing: chevron() }))];
  if (!open) return rows;
  rows.push(h('div', { class: 'g-row sub info' }, h('span', { class: 'g-label' }, stand)));
  if (s.state !== 'expired') {
    for (const [v, a] of Object.entries(ACCESS())) {
      const cur = v === s.access;
      rows.push(h('button', {
        class: 'g-row sub choice', 'aria-pressed': String(cur), 'aria-label': t('share.accessFor', { access: a.name, alias: s.alias }), title: a.help, 'aria-description': a.help,
        dataset: { fk: `access:${s.id}:${v}` }, onclick: () => { if (!cur) act(() => shareApi.update(s.id, v), t('share.accessChanged', { alias: s.alias, access: a.lower })); },
      }, h('span', { class: 'g-label' }, a.name), cur ? h('span', { class: 'check', 'aria-hidden': 'true' }, icon('check')) : null));
    }
  }
  const [label, danger, help, done] = s.state === 'joined'
    ? [t('share.revoke'), true, t('share.revokeHelp'), t('share.revoked', { alias: s.alias })]
    : s.state === 'pending' ? [t('share.cancelInvite'), false, '', t('share.inviteCancelled')] : [t('btn.remove'), false, '', t('share.removed')];
  rows.push(actionRow(label, () => act(() => shareApi.revoke(s.id), done), { danger, help, name: t('share.endFor', { action: label, alias: s.alias }), fk: `end:${s.id}`, cls: 'sub' }));
  return rows;
}

/** Join a list someone shares: the invite link pasted (or found on the clipboard). */
function joinSheet(prefill = '') {
  const input = h('input', { class: 'field', value: prefill, placeholder: 'https://…/join#code=…', 'aria-label': t('share.inviteLink'), autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  const go = () => {
    const inv = parseInviteLink(input.value);
    if (!inv) { input.classList.add('bad'); toast(t('share.notInviteLink')); return; }
    confirmJoin(input.value.trim(), inv);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  input.addEventListener('input', () => input.classList.remove('bad'));
  const paste = navigator.clipboard?.readText ? h('button', { class: 'btn', onclick: async () => {
    try { input.value = (await navigator.clipboard.readText()).trim(); input.classList.remove('bad'); } catch { toast(t('common.pasteIntoField')); }
  } }, t('btn.paste')) : null;
  sheet(t('shareJoin.title'), [
    h('p', { class: 'sheet-note' }, ui.local || store.meta.token ? t('shareJoin.paste') : t('shareJoin.pasteNoSync')),
    h('div', { class: 'field-row' }, input, paste),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')), h('button', { class: 'btn primary', onclick: go }, t('shareJoin.join'))),
  ]);
  if (!prefill) input.focus();
}

/** Says whose server the list comes from before the one-time code is used up. */
function confirmJoin(link, inv) {
  const host = hostOf(inv.server);
  if (!ui.local && !store.meta.token && inv.server !== location.origin) {
    // no sync of its own: this app reaches its own address only (its security policy), so the list opens there
    sheet(t('shareJoin.openInsteadTitle'), [
      h('p', {}, t('shareJoin.openInstead', { host })),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: closeSheet }, t('btn.notNow')),
        h('a', { class: 'btn primary', href: `${inv.server}/join#code=${inv.code}`, rel: 'noreferrer' }, t('shareJoin.openInvite'))),
    ]);
    return;
  }
  const how = ui.local ? t('shareJoin.howComputer')
    : store.meta.token ? t('shareJoin.howSync', { host: hostOf(store.meta.server || location.origin) })
      : t('shareJoin.howBrowser');
  sheet(t('shareJoin.confirmTitle'), [
    h('p', {}, t('shareJoin.confirm', { host, how })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, t('btn.notNow')),
      h('button', { class: 'btn primary', onclick: async (e) => {
        e.target.disabled = true;
        try {
          if (ui.local) {
            const r = await api('local/join', { link });
            closeSheet();
            const box = document.querySelector('[data-fk="join-input"]');   // (Settings stays open here: empty its box)
            if (box) box.value = '';
            toast(t('shareJoin.joinedSoon', { name: r.name }));
            setTimeout(loadLocalInfo, 2500);
          } else {
            const s = await store.joinShare(link);
            closeSheet();
            ui.view = 'list'; ui.today = false; ls.set('today', '0'); ui.project = s.projectId; ls.set('project', s.projectId);
            toast(t('shareJoin.joined', { name: s.name }));
            syncSharePush();
          }
          render();
        } catch (err) { e.target.disabled = false; toast(err.message); }
      } }, t('shareJoin.join'))),
  ]);
}

/**
 * "Move to my Saqme app" (a list used here in the browser): a one-time link for the same share. Another app of this
 * person opens it like an invite and takes the list over (no new invite); this browser then stops syncing it.
 */
async function moveToAppSheet(sh) {
  const p = store.get('project', sh.projectId);
  const title = t('move.title', { name: p ? listName(p) : sh.name });
  sheet(title, [h('p', { class: 'sheet-note', role: 'status' }, t('move.gettingLink'))]);
  let m;
  try {
    await store.sync({ force: true });   // (what was changed here goes first)
    m = await store.transferShare(sh.id);
  } catch (e) {
    if (e.ended) { closeSheet(); return; }   // (the store says what happened)
    sheet(title, [h('p', {}, t('move.couldNotGetLink', { error: e.message })), h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: closeSheet }, t('btn.ok')))]);
    return;
  }
  const inv = parseInviteLink(m.link);
  const box = h('input', { class: 'field', value: m.link, readOnly: true, 'aria-label': t('move.link'), onfocus: (e) => e.target.select() });
  const block = h('div', { class: 'invite' }, h('div', { class: 'field-row' }, box, h('button', { class: 'btn primary', onclick: () => copyText(m.link, t('common.linkCopied')) }, t('btn.copy'))));
  const computer = matchMedia('(pointer: fine)').matches;
  if (computer) {
    import('./qr.js').then(({ qrMatrix, qrToSvg }) => {
      const svg = qrToSvg(qrMatrix(m.link, 'M'), { margin: 4, scale: 5 });
      block.append(h('img', { class: 'qr', alt: t('move.qr'), src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }));
    }).catch(() => {});
  }
  sheet(title, [
    h('p', {}, t('move.what')),
    h('ol', { class: 'steps' },
      h('li', {}, richText('move.stepComputer')),
      h('li', {}, richText('move.stepPhone')),
      h('li', {}, richText('move.stepOther'))),
    block,
    h('p', { class: 'sheet-note' }, t('move.worksOnce', { until: dateText(m.expiresAt, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })),
    h('div', { class: 'btn-row' },
      inv && computer ? h('a', { class: 'btn', href: `saqme://join?server=${encodeURIComponent(inv.server)}&code=${inv.code}` }, t('move.openInApp')) : null,
      h('button', { class: 'btn primary', onclick: closeSheet }, t('btn.done'))),
  ]);
}

/** #join=<code>: the join page's "Open in browser" (this copy of the app is served by the owner's server). */
function readJoinLink() {
  const m = /^#join=([A-Za-z0-9_-]{22,64})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  const link = `${location.origin}/#join=${m[1]}`;
  const inv = parseInviteLink(link);   // (null for a copy served over plain http from elsewhere)
  if (inv) confirmJoin(link, inv);
}

/**
 * On open and when the app comes back: an invite link on the clipboard -> "Join shared list?". Only where the
 * browser lets a page read the clipboard without asking (permission granted); elsewhere (iPhone) it is the
 * Paste button in Settings › Sync & sharing › Shared lists.
 */
async function checkClipboardForInvite() {
  if (ui.local || !navigator.clipboard?.readText || !els.sheetWrap.hidden) return;
  try {
    const perm = await navigator.permissions?.query({ name: 'clipboard-read' });
    if (perm?.state !== 'granted') return;
    const text = (await navigator.clipboard.readText()).trim();
    const inv = parseInviteLink(text);
    if (!inv || ls.get(`invite.${inv.code.slice(0, 12)}`)) return;
    ls.set(`invite.${inv.code.slice(0, 12)}`, 'offered');
    confirmJoin(text, inv);
  } catch { /* not allowed here */ }
}

function projectNameSheet(id) {
  const p = id ? store.get('project', id) : null;
  const input = h('input', { class: 'field', value: p ? p.fields.name.v : '', placeholder: t('list.namePlaceholder'), 'aria-label': t('list.namePlaceholder'), maxLength: 100, enterKeyHint: 'done', autocapitalize: 'words' });
  const save = () => {
    const name = input.value.trim();
    if (!name) { input.classList.add('bad'); return; }
    const clash = store.projects().find((x) => x.id !== id && x.fields.name.v.toLowerCase() === name.toLowerCase());
    if (clash) { input.classList.add('bad'); toast(t('list.nameTaken')); return; }
    if (id) store.renameProject(id, name);
    else { const nid = store.addProject(name); if (nid) { ui.project = nid; ls.set('project', nid); ui.today = false; ls.set('today', '0'); ui.view = 'list'; } }
    closeSheet();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  sheet(id ? t('list.renameTitle') : t('list.new'), [
    h('div', { class: 'field-row' }, input),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')), h('button', { class: 'btn primary', onclick: save }, id ? t('list.rename') : t('btn.create'))),
  ]);
  input.focus();
  input.select();
}

function confirmDeleteProject(id) {
  const p = store.get('project', id);
  sheet(t('list.deleteTitle', { name: p.fields.name.v }), [
    h('p', {}, t('list.deleteWhat')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')),
      h('button', { class: 'btn primary', onclick: () => {
        store.deleteProject(id); closeSheet();
        toast(t('list.deleted'), { label: t('btn.undo'), run: () => store.restoreProject(id) });
      } }, t('btn.delete'))),
  ]);
}

// ---------------------------------------------------------------- sync status + conflicts badge
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return t('ago.now');
  if (s < 60) return tn('ago.s', s);
  if (s < 3600) return tn('ago.min', Math.round(s / 60));
  if (s < 86400) return tn('ago.h', Math.round(s / 3600));
  return dateText(ms, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });   // (short: it is a row's value)
}

function statusText() {
  const st = store.status;
  const pending = store.pendingCount();
  switch (st.state) {
    case 'unpaired': return browserShares().length ? t('sync.unpairedShared') : t('sync.unpaired');
    case 'syncing': return t('sync.syncing');
    case 'offline': return pending ? tn('sync.offlineWaiting', pending) : t('sync.offline');
    case 'error': return t('sync.error', { error: st.message });
    default: return store.meta.lastSync ? t('sync.syncedAgo', { ago: ago(store.meta.lastSync) }) : t('sync.synced');
  }
}

function renderStatus() {
  const st = store.status.state;
  const name = { idle: 'cloudOk', syncing: 'cloudSync', offline: 'cloudOff', error: 'cloudErr', unpaired: 'cloud' }[st];
  els.sync.className = `sync state-${st}`;
  els.sync.replaceChildren(icon(name));
  els.sync.title = statusText();
  els.sync.setAttribute('aria-label', statusText());
  const n = store.conflicts().length + allNotices().length;
  els.conflicts.hidden = n === 0;
  els.conflicts.replaceChildren(icon('conflict'), h('span', {}, n));
  els.conflicts.title = tn('sync.conflictsBadge', n);
}

// ---------------------------------------------------------------- main view
function renderMain() {
  // another view than the one on screen: that one leaves (moving between views, below)
  const from = ui.shownView;
  const leaving = from && from !== ui.view ? leaveView() : null;
  const showAdd = ui.view === 'list' && !ui.today && !!currentProject() && !showWelcome() && !readOnly(currentProject().id);
  els.addBar.hidden = !showAdd;
  els.app.classList.toggle('no-add', !showAdd);
  if (ui.view === 'list' && showWelcome()) renderWelcome();
  else if (ui.view !== 'list') renderSettingsView();
  else renderTasks();
  ui.shownView = ui.view;
  if (leaving) moveIn(leaving, from, ui.view);
}

// ---------------------------------------------------------------- moving between views
// Settings moves as on an iPhone: a page that opens slides in from the right over the one it came from, which moves a
// little to the left and dims; Back does the reverse. Opening Settings from the list, and going back to it, is a quick
// fade. The view left behind is its own nodes, moved into a copy of the list's box (the ghost) that takes no taps, focus
// or screen reader and goes when its animation ends; the new view takes taps and keys at once, focus included. A move
// while one runs ends that one first, so quick taps never leave two views or one half moved. Reduce motion: no moves.
const MOVE_MS = 280;   // a page of Settings
// Settings from the list and back: the view left behind fades out in 90 ms, the new one in from 60 ms on, in 160 ms (a
// fade through, so the two never show at once)
const FADE_OUT_MS = 90;
const FADE_DELAY_MS = 60;
const FADE_MS = 160;
const EASE_OUT = 'cubic-bezier(.33, 1, .68, 1)';   // ease-out cubic: the Windows app's CubicEase
const depthOf = (v) => (v === 'list' ? 0 : 1 + depthOf(parentOf(v)));
let viewMove = null;   // the move that runs: { ghost, anims }
/** The view on screen leaves: its nodes go to the ghost, where they are, scrolled as they were. Null: no move. */
function leaveView() {
  ui.movedAt = performance.now();
  endMove();
  if (reducedMotion() || document.visibilityState !== 'visible' || !els.list.firstChild) return null;
  const ghost = els.list.cloneNode(false);   // (the same classes: the same padding, so the same layout)
  ghost.removeAttribute('id');
  ghost.removeAttribute('tabindex');
  ghost.classList.add('ghost');
  ghost.classList.remove('swipeable', 'swiping');
  ghost.inert = true;
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, { left: `${els.list.offsetLeft}px`, top: `${els.list.offsetTop}px`, width: `${els.list.offsetWidth}px`, height: `${els.list.offsetHeight}px`, transform: '', opacity: '' });
  const top = els.list.scrollTop;
  ghost.append(...[...els.list.childNodes].filter((n) => n !== els.addBar));   // (the add line stays in the list)
  // (focus keys and ids stay the new view's alone)
  for (const n of ghost.querySelectorAll('[data-fk], [id]')) { n.removeAttribute('data-fk'); n.removeAttribute('id'); }
  els.list.after(ghost);
  ghost.scrollTop = top;
  return ghost;
}
/** The new view comes in over (a page opening) or under (Back) the ghost, or fades in. */
function moveIn(ghost, from, to) {
  const kind = from === 'list' || to === 'list' ? 'fade' : depthOf(to) < depthOf(from) ? 'back' : 'push';
  const timing = (ms, fill = 'none') => ({ duration: ms, easing: EASE_OUT, fill });
  let anims;
  if (kind === 'push') {
    els.list.style.zIndex = '2';
    anims = [
      ghost.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(-30%)', opacity: 0.5 }], timing(MOVE_MS, 'forwards')),
      els.list.animate([{ transform: 'translateX(100%)' }, { transform: 'none' }], timing(MOVE_MS)),
    ];
  } else if (kind === 'back') {
    ghost.style.zIndex = '2';
    anims = [
      ghost.animate([{ transform: 'none' }, { transform: 'translateX(100%)' }], timing(MOVE_MS, 'forwards')),
      els.list.animate([{ transform: 'translateX(-30%)', opacity: 0.5 }, { transform: 'none', opacity: 1 }], timing(MOVE_MS)),
    ];
  } else {
    anims = [
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], timing(FADE_OUT_MS, 'forwards')),
      els.list.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { ...timing(FADE_MS, 'backwards'), delay: FADE_DELAY_MS }),
    ];
  }
  els.app.dataset.move = kind;
  viewMove = { ghost, anims };
  Promise.all(anims.map((a) => a.finished)).then(() => { if (viewMove?.ghost === ghost) endMove(); }, () => { /* ended early */ });
}
/** The move that runs ends now: the ghost goes, the new view is where it belongs. */
function endMove() {
  if (!viewMove) return;
  const { ghost, anims } = viewMove;
  viewMove = null;
  for (const a of anims) a.cancel();
  ghost.remove();
  els.list.style.zIndex = '';
  delete els.app.dataset.move;
}
// a double click whose first click opened a view is one click: its second click, landing on that view, does nothing
let lastClickAt = -Infinity;
document.addEventListener('click', (e) => {
  const now = performance.now();
  const moved = ui.movedAt ?? -Infinity;
  const second = e.detail > 1 && moved > lastClickAt && now - moved < 500;
  lastClickAt = now;
  if (second) { e.preventDefault(); e.stopPropagation(); }
}, true);

function isOpen(node) {
  const v = ls.get(`open.${node.id}`);
  if (v) return v === '1';
  return node.kids.length > 0;
}
function setOpen(id, open) { ls.set(`open.${id}`, open ? '1' : '0'); }

/** Puts these in the list, above the add line: that one node stays (keeps focus, and what is typed in it) and is always last. */
function setListContent(nodes) {
  for (const n of [...els.list.childNodes]) if (n !== els.addBar) n.remove();
  els.addBar.before(...nodes);
}

function renderTasks() {
  if (ui.today && !showWelcome() && currentProject()) { renderToday(); return; }
  const frag = [];
  ui.visible = [];
  const proj = currentProject();
  if (!proj) {
    frag.push(h('div', { class: 'welcome' },
      h('p', {}, t('list.noLists')),
      h('button', { class: 'btn primary', onclick: () => projectNameSheet(null) }, icon('plus'), t('list.new'))));
    setListContent(frag);
    return;
  }
  if (store.saveError) frag.push(saveWarning());
  if (isIOS() && !isStandalone() && ls.get('installHint') !== 'off') frag.push(installHint());
  const shared = sharing(proj.id)?.withMe;
  if (shared) {
    const st = store.shareStatus.get(shared.id) ?? shared.status;
    const trouble = st?.state === 'paused' ? t('shared.paused')
      : st && (st.state === 'offline' || st.state === 'error') ? t('shared.notSynced', { error: localText(st.message) || st.state }) : '';
    if (shared.access === 'view' || trouble) {
      // (a line above the cards, like the Windows app's; in ink when something is wrong)
      const from = t(shared.access === 'view' ? 'shared.fromViewOnly' : 'shared.from', { host: hostOf(shared.server) });
      frag.push(h('p', { class: `shared-note${trouble ? ' trouble' : ''}`, role: trouble ? 'status' : null },
        shared.access === 'view' ? [h('b', {}, t('shared.viewOnly')), ' '] : null,
        trouble ? `${from} ${trouble}` : from));
    }
  }
  const tree = store.tree(proj.id);
  const { active, postponed, closed } = sections(tree, heldRank);
  const draft = ui.editing?.draft;
  const name = listName(proj);
  frag.push(h('h1', { class: 'sr-only' }, name));
  // each section is a card of its tasks (docs/design.md, "Grouped lists"); Postponed and Completed under headings
  const list = (label, items) => (items.length ? h('div', { class: 'tasks group', role: 'list', 'aria-label': label }, items) : null);
  const activeItems = [];
  for (const n of active) renderNode(activeItems, n, 'active');
  if (draft && !draft.parentId && !draft.afterId) activeItems.push(listItem(0, taskRow(null, 'active', draft)));
  frag.push(list(name, activeItems));
  if (postponed.length) {
    frag.push(h('h2', { class: 'g-head list-head' }, t('status.post')));
    const items = [];
    for (const n of postponed) renderNode(items, n, 'postponed');
    frag.push(list(t('status.post'), items));
  }
  if (closed.length) {
    const show = ls.get('showCompleted') === '1';
    frag.push(h('h2', { class: 'completed-heading' }, h('button', {
      class: `completed-toggle${show ? ' open' : ''}`, 'aria-expanded': String(show), dataset: { fk: 'completed' },
      'aria-label': tn('list.completedTasks', closed.length),
      onclick: () => { ls.set('showCompleted', show ? '0' : '1'); commitAll(); render(); },
    }, h('span', {}, t('list.completed')), h('span', { class: 'count' }, ` · ${closed.length}`), icon('chevron'))));
    if (show) { const items = []; for (const n of closed) renderNode(items, n, 'closed'); frag.push(list(t('list.completed'), items)); }
  }
  if (!ui.visible.length && !draft) {
    frag.push(h('div', { class: 'empty-state' }, readOnly(proj.id) ? t('list.emptyReadOnly') : t('list.empty')));
  }
  setListContent(frag.filter(Boolean));
  if (ui.sel && !ui.visible.includes(ui.sel)) ui.sel = null;
}

const TODAY_HEADS = { over: 'today.over', today: 'today.today', soon: 'today.soon' };
/** For Today: the open tasks due soon from every list, in the order of their deadlines, under Overdue / Today / Next 3 days. */
function renderToday() {
  const frag = [];
  ui.visible = [];
  if (store.saveError) frag.push(saveWarning());
  frag.push(h('h1', { class: 'sr-only' }, t('today.title')));
  const rows = todayRows();
  for (const bucket of ['over', 'today', 'soon']) {
    const items = [];
    for (const { task } of rows.filter((r) => r.bucket === bucket)) {
      const ctx = nodeOf(task.id);
      if (!ctx?.node) continue;
      // (a flat list: the task by itself, at the left edge; its subtasks are in its own list)
      const node = { ...ctx.node, depth: 0, kids: [] };
      ui.visible.push(node.id);
      const open = ui.notesEditing === node.id || (isOpen(node) && !!node.task.fields.notes.v);
      items.push(listItem(0, taskRow(node, 'today'), open ? notesBlock(node) : null));
    }
    if (!items.length) continue;
    frag.push(h('h2', { class: 'g-head list-head' }, t(TODAY_HEADS[bucket])));
    frag.push(h('div', { class: 'tasks group', role: 'list', 'aria-label': t(TODAY_HEADS[bucket]) }, items));
  }
  if (!ui.visible.length) frag.push(h('div', { class: 'empty-state' }, t('today.empty')));
  setListContent(frag.filter(Boolean));
  if (ui.sel && !ui.visible.includes(ui.sel)) ui.sel = null;
}

// one list item per task (its row + notes); nesting is flat in the page and told by aria-level. Its depth also
// places the hairline above it, from where its text starts
const listItem = (depth, ...children) => h('div', { class: 'task-item', role: 'listitem', 'aria-level': String(depth + 1), style: { '--depth': String(depth) } }, ...children);
function renderNode(frag, node, section) {
  const draft = ui.editing?.draft;
  ui.visible.push(node.id);
  const open = isOpen(node) || ui.notesEditing === node.id || (draft && draft.parentId === node.id && draft.index === 0);
  frag.push(listItem(node.depth, taskRow(node, section), open && (node.task.fields.notes.v || ui.notesEditing === node.id) ? notesBlock(node) : null));
  if (open) {
    if (draft && draft.parentId === node.id && draft.index === 0) frag.push(listItem(draft.depth, taskRow(null, section, draft)));
    for (const k of kidsInDisplayOrder(node, heldRank)) renderNode(frag, k, section);
  }
  if (draft && draft.afterId === node.id) frag.push(listItem(draft.depth, taskRow(null, section, draft)));
}
/** One phrase for a task row: what it says, its status, its deadline (read when the row gets focus). */
function rowSummary(node, st) {
  const task = node.task;
  const due = task.fields.due.v;
  const parts = [task.fields.text.v || t('task.untitled'), t(`status.${st.key}`)];
  if (ui.today) parts.push(t('task.inList', { list: projectName(task) }));
  if (due) parts.push(t(dueTone(due, rank(task.fields.status.v) === 2) === 'over' ? 'task.deadlineOverdue' : 'task.deadline', { date: dueLongText(due) }));
  if (node.kids.length) { const p = progress(node); parts.push(tn('task.subtasksClosed', p.total, { done: p.done })); }
  return parts.join(', ');
}

function installHint() {
  return h('div', { class: 'callout install' },
    h('div', {}, richText('install.hint')),
    // Safari keeps a tab's data apart from the Home Screen app's, and may clear it after a week without a visit
    store.meta.token ? null : h('div', {}, t('install.safariTab')),
    h('div', { class: 'btn-row' }, h('button', { class: 'g-btn', onclick: () => { ls.set('installHint', 'off'); render(); } }, t('btn.gotIt'))));
}

/** Shown while edits cannot be written to the phone's storage (they are kept in memory and retried). */
function saveWarning() {
  return h('div', { class: 'callout', role: 'alert' },
    h('b', {}, t('save.notSaved')), ' ',
    `${store.saveError} ${t(store.meta.token ? 'save.stay' : 'save.stayExport')}`);
}

const projectName = (t) => { const p = store.projects().find((x) => x.id === t.fields.place.v.project); return p ? listName(p) : ''; };

function taskRow(node, section, draft = null) {
  const task = node?.task;
  const id = node?.id ?? null;
  const mark = task ? task.fields.status.v : ' ';
  const st = statusOf(mark);
  const hasKids = !!node?.kids.length;
  const notes = task?.fields.notes.v ?? '';
  const open = node ? isOpen(node) : false;
  const depth = node ? node.depth : draft.depth;
  const ro = !!task && readOnly(task.fields.place.v.project);   // a view-only shared list: read, never change
  // the row takes keyboard focus as one unit (arrow keys move it), and says what it is in one phrase
  const notesBelow = !!node && (open || ui.notesEditing === id) && (!!notes || ui.notesEditing === id);
  const row = h('div', {
    class: `row${id && ui.sel === id ? ' sel' : ''}${notesBelow ? ' with-notes' : ''}${id && flash.id === id && Date.now() < flash.until ? ' flash' : ''}`, dataset: { id: id ?? '', fk: id ? `row:${id}` : '' }, style: { '--depth': String(depth) },
    role: node ? 'group' : null, tabindex: node ? (ui.sel === id ? '0' : '-1') : null, 'aria-label': node ? rowSummary(node, st) : null,
  });
  if (node) {
    row.addEventListener('focus', (e) => {
      if (e.target !== row || ui.sel === id) return;
      ui.sel = id;
      for (const r of els.list.querySelectorAll('.row.sel')) { r.classList.remove('sel'); r.tabIndex = -1; }
      row.classList.add('sel'); row.tabIndex = 0;
    });
  }

  // grip: only for manually ordered (active) tasks, like the desktop; pointer only (the task menu moves tasks)
  const grip = h('span', { class: 'grip', 'aria-hidden': 'true' });
  if (node && section === 'active' && rank(mark) === 0 && !ro) {
    grip.append(icon('grip'));
    grip.addEventListener('pointerdown', (e) => startDrag(e, id, row));
  }
  row.append(grip);

  const chev = h('button', { class: `chev${open ? ' open' : ''}`, 'aria-label': t('task.subtasksAndNotes'), 'aria-expanded': String(open), dataset: { fk: id ? `chev:${id}` : '' } });
  if (hasKids || notes) {
    chev.append(icon('chevron'));
    chev.addEventListener('click', () => { commitAll(); setOpen(id, !open); render(); });
  } else { chev.disabled = true; chev.setAttribute('aria-hidden', 'true'); chev.removeAttribute('aria-expanded'); }
  row.append(chev);

  const statusName = t('task.statusLabel', { status: t(`status.${st.key}`) });
  const chipBtn = ro
    ? h('span', { class: 'chip-btn', role: 'img', 'aria-label': statusName }, chip(mark))
    : h('button', { class: 'chip-btn', 'aria-label': statusName, 'aria-haspopup': 'dialog', dataset: { fk: id ? `chip:${id}` : '' } }, chip(mark));
  if (node && !ro) chipBtn.addEventListener('click', () => { commitAll(); statusSheet(id); });
  row.append(chipBtn);
  let textEl = null;

  // text and its meta line share one column, so long titles get the full width (docs/design.md)
  const main = h('div', { class: 'main' });
  const editingThis = draft || (ui.editing && ui.editing.id === id);
  if (editingThis) main.append(editor(node, draft));
  else if (ro) main.append(textEl = h('span', { class: `text t-${st.key}${task.fields.text.v ? '' : ' empty'}` }, task.fields.text.v || t('task.untitled')));
  else {
    // a button: tapping it (or Enter / Space on it) edits the text
    const text = h('button', { class: `text t-${st.key}${task.fields.text.v ? '' : ' empty'}`, dataset: { fk: `text:${id}` } }, task.fields.text.v || t('task.untitled'));
    text.addEventListener('click', () => beginEdit(id));
    main.append(textEl = text);
  }
  if (node && statusAnim.has(id)) queueMicrotask(() => playStatusAnim(id, chipBtn.firstElementChild, textEl));   // (once the row is in the page)
  if (node) {
    const meta = [];
    const due = task.fields.due.v;
    if (due) {
      // a pill only when it matters (overdue / today / tomorrow); later deadlines are plain text
      const tone = dueTone(due, rank(mark) === 2);
      const urgent = tone === 'over' || tone === 'soon';
      const shown = dueText(due.date) + (due.time ? ` ${due.time}` : '');
      const b = h(ro ? 'span' : 'button', {
        class: `m-due ${urgent ? `pill ${tone}` : 'due'}`, title: t('task.deadlineLabel', { date: dueLongText(due) }), dataset: { fk: ro ? '' : `due:${id}` }, 'aria-haspopup': ro ? null : 'dialog',
        'aria-label': t(tone === 'over' ? 'task.deadlineLabelOverdue' : 'task.deadlineLabel', { date: shown }),   // the state in words, not only in colour
      }, shown);
      if (!ro) b.addEventListener('click', () => { commitAll(); dueSheet(id); });
      meta.push(b);
    }
    if (section === 'today') {
      // which list it is in; a tap opens the task there
      const name = projectName(task);
      meta.push(h('button', { class: 'item m-list', title: t('task.showIn', { list: name }), 'aria-label': t('task.showIn', { list: name }), dataset: { fk: `showlist:${id}` }, onclick: () => showInList(id) }, name));
    }
    if (hasKids) {
      const p = progress(node);
      const closedWords = tn('task.subtasksClosed', p.total, { done: p.done });
      meta.push(h('span', { class: 'item m-progress', title: closedWords }, h('span', { 'aria-hidden': 'true' }, `${p.done}/${p.total}`), h('span', { class: 'sr-only' }, closedWords)));
    }
    if (notes && !open) meta.push(h('span', { class: 'item m-notes', title: t('task.hasNotesOrLinks') }, icon('link'), h('span', { class: 'sr-only' }, t('task.hasNotes'))));
    if (meta.length) main.append(h('div', { class: 'meta' }, meta));
  }
  row.append(main);

  const more = ro ? h('span', { class: 'more', 'aria-hidden': 'true' }) : h('button', { class: 'more', 'aria-label': t('task.menu'), 'aria-haspopup': 'dialog', dataset: { fk: id ? `more:${id}` : '' } });
  if (node && !ro) { more.append(icon('more')); more.addEventListener('click', () => { commitAll(); rowMenu(id); }); }
  row.append(more);

  if (node && !ro) {
    onLongPress(row, () => { commitAll(); rowMenu(id); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); commitAll(); rowMenu(id); });
  }
  return row;
}

/**
 * Touch long-press -> fn. The click that may follow the release is swallowed wherever it lands: on the element, or
 * on what fn just put under the finger (a sheet's backdrop, which would close the sheet at once).
 */
function onLongPress(el, fn) {
  let timer = null;
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('.grip, textarea, input')) return;
    start = [e.clientX, e.clientY];
    timer = setTimeout(() => {
      timer = null;
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      const stop = () => document.removeEventListener('click', swallow, true);
      document.addEventListener('click', swallow, true);
      // (until the click this release may make: 350 ms after it, or at once when the next touch starts)
      const release = () => setTimeout(stop, 350);
      document.addEventListener('pointerup', release, { capture: true, once: true });
      document.addEventListener('pointercancel', release, { capture: true, once: true });
      document.addEventListener('pointerdown', stop, { capture: true, once: true });
      navigator.vibrate?.(8);
      fn();
    }, 480);
  });
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8) cancel(); });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
}

// ---------------------------------------------------------------- notes
function notesBlock(node) {
  const id = node.id;
  const wrap = h('div', { class: 'notes', style: { '--depth': String(node.depth) } });
  if (ui.notesEditing === id) {
    const ta = h('textarea', { rows: 2, placeholder: t('notes.placeholder'), value: node.task.fields.notes.v, maxLength: MAX_NOTES });
    const done = () => commitNotes(ta.value);
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); ui.notesEditing = null; requestRender(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); }
    });
    ta.addEventListener('blur', () => { if (ui.notesEditing === id) done(); });
    wrap.append(ta, h('div', { class: 'notes-actions' }, h('button', { class: 'g-btn notes-done', onpointerdown: (e) => e.preventDefault(), onclick: done }, t('btn.done'))));
    queueMicrotask(() => { ta.focus(); autosize(ta); ta.setSelectionRange(ta.value.length, ta.value.length); });
  } else {
    const lines = node.task.fields.notes.v.split('\n');
    lines.forEach((line, i) => {
      for (const part of linkify(line)) {
        wrap.append(part.url ? h('a', { href: part.url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, part.text) : part.text);
      }
      if (i < lines.length - 1) wrap.append('\n');
    });
    wrap.addEventListener('click', () => beginNotes(id));
  }
  return wrap;
}

/** A task of a view-only shared list: nothing about it can be changed here. */
const roTask = (id) => { const t = store.get('task', id); return !!t && readOnly(t.fields.place.v.project); };

function beginNotes(id) {
  if (roTask(id)) return;
  commitAll();
  setOpen(id, true);
  const t = store.get('task', id);
  ui.notesEditing = id;
  ui.notesOrig = t ? { v: t.fields.notes.v, ts: t.fields.notes.ts } : null;
  renderMain();
}

function commitNotes(value) {
  const id = ui.notesEditing;
  if (!id) return;
  ui.notesEditing = null;
  const notes = cleanNotes(value);
  const orig = ui.notesOrig;
  if (!orig || notes !== orig.v) store.setTask(id, { notes }, orig ? { base: orig.ts } : {});
  requestRender();
}

// ---------------------------------------------------------------- inline task editor
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function editor(node, draft) {
  const ta = h('textarea', { class: 'editor', rows: 1, value: node ? node.task.fields.text.v : '', enterKeyHint: 'next', autocapitalize: 'sentences', spellcheck: true, maxLength: MAX_TEXT });
  if (node && ui.editing && !ui.editing.draft && !ui.editing.orig) ui.editing.orig = { v: node.task.fields.text.v, ts: node.task.fields.text.ts };
  ta.addEventListener('input', () => { if (ta.value.includes('\n')) ta.value = ta.value.replace(/\n/g, ' '); autosize(ta); });
  ta.addEventListener('keydown', (e) => editorKey(e, ta));
  ta.addEventListener('blur', () => { if (ui.editing && !ui.transitioning) commitEdit(ta.value); });
  ui.editorEl = ta;
  return ta;
}

function focusEditor() {
  const ta = ui.editorEl;
  if (!ta || !ta.isConnected) return;
  ta.focus({ preventScroll: true });
  autosize(ta);
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.closest('.row')?.scrollIntoView({ block: 'nearest' });
}

/** Re-render the list with an editor and focus it in the same tick (keeps the iOS keyboard up). */
function showEditor(editing) {
  ui.transitioning = true;
  ui.editing = editing;
  ui.notesEditing = null;
  renderMain();
  focusEditor();
  ui.transitioning = false;
}

function beginEdit(id) {
  if ((ui.editing && ui.editing.id === id) || roTask(id)) return;
  commitAll();
  ui.sel = id;
  showEditor({ id });
}

function nodeOf(id) {
  const t = store.get('task', id);
  if (!t) return null;
  const tree = store.tree(t.fields.place.v.project);
  return { tree, node: tree.byId.get(id) };
}

/** Saves the editor's text. Returns the id of the saved task (or null for an empty draft). */
function saveEditing(value) {
  const e = ui.editing;
  if (!e) return null;
  ui.editing = null;
  const text = cleanText(value);
  if (e.draft) {
    if (!text) return null;
    const d = e.draft;
    return store.addTask(d.projectId, { parentId: d.parentId, index: d.index, text });
  }
  const task = store.get('task', e.id);
  if (!task) return null;
  const orig = e.orig ?? { v: task.fields.text.v, ts: task.fields.text.ts };
  if (text === orig.v) return e.id;   // unchanged: never rewrite (it could be a newer version by now)
  if (!text) {
    if (task.fields.text.v) { store.deleteTask(e.id); toast(t('task.deleted'), { label: t('btn.undo'), run: () => store.restoreTask(e.id) }); }
    return null;
  }
  store.setTask(e.id, { text }, { base: orig.ts });
  return e.id;
}

function commitEdit(value) {
  saveEditing(value);
  ui.editorEl = null;
  requestRender();   // deferred while a finger is down, so the tap that caused the blur still lands
}

function commitAll() {
  if (ui.editing && ui.editorEl) { ui.transitioning = true; saveEditing(ui.editorEl.value); ui.transitioning = false; ui.editorEl = null; }
  else ui.editing = null;
  if (ui.notesEditing) {
    const ta = els.list.querySelector('.notes textarea');
    if (ta) commitNotes(ta.value); else ui.notesEditing = null;
  }
}

/** Index of `node` among its siblings in position order. */
function indexIn(tree, node) {
  const sibs = node.parent ? node.parent.kids : tree.roots;
  return sibs.indexOf(node);
}

function editorKey(e, ta) {
  const editing = ui.editing;
  if (!editing) return;
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) { ui.transitioning = true; commitEdit(''); ui.transitioning = false; return; }
    ui.transitioning = true;
    const savedId = saveEditing(ta.value);
    const ctx = savedId && nodeOf(savedId);
    if (!ctx?.node) { ui.transitioning = false; render(); return; }
    const { tree, node } = ctx;
    const projectId = ctx.node.task.fields.place.v.project;
    if (e.shiftKey) {
      setOpen(savedId, true);
      showEditor({ draft: { projectId, parentId: savedId, index: 0, afterId: null, depth: node.depth + 1 } });
    } else {
      showEditor({ draft: { projectId, parentId: node.parent?.id ?? null, index: indexIn(tree, node) + 1, afterId: savedId, depth: node.depth } });
    }
    ui.transitioning = false;
  } else if (e.key === 'Escape') {
    e.preventDefault();
    ui.transitioning = true;
    ui.editing = null; ui.editorEl = null;
    ui.transitioning = false;
    render();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    ui.transitioning = true;
    const id = saveEditing(ta.value);
    if (id) { shiftLevel(id, e.shiftKey ? -1 : 1); showEditor({ id }); }
    else render();
    ui.transitioning = false;
  } else if ((e.key === 'ArrowUp' && ta.selectionStart === 0) || (e.key === 'ArrowDown' && ta.selectionEnd === ta.value.length)) {
    const cur = editing.id ?? editing.draft?.afterId;
    const i = ui.visible.indexOf(cur);
    const next = ui.visible[e.key === 'ArrowUp' ? i - 1 : i + 1];
    e.preventDefault();
    ui.transitioning = true;
    saveEditing(ta.value);
    if (next && store.get('task', next)) { ui.sel = next; showEditor({ id: next }); }
    else { ui.editorEl = null; render(); if (e.key === 'ArrowDown') els.add.focus(); }
    ui.transitioning = false;
  }
}

// ---------------------------------------------------------------- task operations
function shiftLevel(id, delta) {
  const ctx = nodeOf(id);
  if (!ctx?.node) return;
  const { tree, node } = ctx;
  const projectId = node.task.fields.place.v.project;
  const sibs = node.parent ? node.parent.kids : tree.roots;
  if (delta > 0) {
    const i = sibs.indexOf(node);
    if (i <= 0) return;
    const prev = sibs[i - 1];
    store.moveTask(id, { projectId, parentId: prev.id, index: prev.kids.length });
    setOpen(prev.id, true);
  } else {
    if (!node.parent) return;
    const parent = node.parent;
    const gp = parent.parent;
    const gsibs = gp ? gp.kids : tree.roots;
    store.moveTask(id, { projectId, parentId: gp?.id ?? null, index: gsibs.indexOf(parent) + 1 });
  }
}

function nudge(id, dir) {
  const ctx = nodeOf(id);
  if (!ctx?.node) return;
  const { tree, node } = ctx;
  const sibs = (node.parent ? node.parent.kids : tree.roots);
  const i = sibs.indexOf(node);
  const j = i + dir;
  if (j < 0 || j >= sibs.length) return;
  // index among the siblings without the moved task
  store.moveTask(id, { projectId: node.task.fields.place.v.project, parentId: node.parent?.id ?? null, index: dir < 0 ? j : j });
  ui.sel = id;
}

function deleteWithUndo(id) {
  store.deleteTask(id);
  toast(t('task.deleted'), { label: t('btn.undo'), run: () => store.restoreTask(id) });
}

function addSubtask(id) {
  const ctx = nodeOf(id);
  if (!ctx?.node) return;
  setOpen(id, true);
  showEditor({ draft: { projectId: ctx.node.task.fields.place.v.project, parentId: id, index: 0, afterId: null, depth: ctx.node.depth + 1 } });
}

// ---------------------------------------------------------------- sheets
function sheet(title, children) {
  closeListMenu();   // (its row had focus: the title gets it, and the sheet gives it back there)
  if (els.sheetWrap.hidden) ui.sheetOpener = document.activeElement?.dataset?.fk || null;
  els.sheet.replaceChildren(h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }), title ? h('h2', { id: 'sheetTitle' }, title) : null, ...children.filter(Boolean));
  if (title) { els.sheet.setAttribute('aria-labelledby', 'sheetTitle'); els.sheet.removeAttribute('aria-label'); }
  else { els.sheet.removeAttribute('aria-labelledby'); els.sheet.setAttribute('aria-label', t('sheet.options')); }
  els.sheetWrap.hidden = false;
  els.app.inert = true;   // modal: Tab and screen readers stay in the sheet
  els.sheet.scrollTop = 0;
  // focus the current choice, or the first control, unless an input already took it
  queueMicrotask(() => {
    if (els.sheet.contains(document.activeElement)) return;
    focusOn(els.sheet.querySelector('[aria-current="true"]') ?? els.sheet.querySelector('input, textarea, button, a[href]') ?? els.sheet);
  });
}
function closeSheet() {
  if (els.sheetWrap.hidden) return;
  els.sheetWrap.hidden = true;
  els.sheet.replaceChildren();
  els.app.inert = false;
  const fk = ui.sheetOpener;
  ui.sheetOpener = null;
  // back to the control that opened it (found again by its key after a re-render)
  requestAnimationFrame(() => { if (fk && (document.activeElement === document.body || !document.activeElement)) focusKey(fk); });
}
/** Focuses the control with this data-fk key; false when there is none. */
function focusKey(fk) {
  const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
  focusOn(el);
  return !!el;
}
els.backdrop.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (els.sheetWrap.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  // keep Tab inside the open sheet: from its last control back to its first, and the other way round
  const items = [...els.sheet.querySelectorAll('button, a[href], input, textarea, select, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !els.sheet.contains(document.activeElement))) { e.preventDefault(); focusOn(last); }
  else if (!e.shiftKey && (document.activeElement === last || !els.sheet.contains(document.activeElement))) { e.preventDefault(); focusOn(first); }
});

/** disabled + title: shown, but explains (in its tooltip and to screen readers) why it does nothing here. */
function menuItem(iconName, label, fn, { danger = false, hint = '', current = false, keepOpen = false, disabled = false, title = '' } = {}) {
  return h('button', {
    class: `menu-item${danger ? ' danger' : ''}${current ? ' current' : ''}`, 'aria-current': current ? 'true' : null,
    disabled, title: title || null, 'aria-description': title || null,
    onclick: () => { if (!keepOpen) closeSheet(); fn(); },
  }, typeof iconName === 'string' ? icon(iconName) : iconName, h('span', {}, label), hint ? h('span', { class: 'hint' }, hint) : null);
}

function statusSheet(id) {
  const task = store.get('task', id);
  if (!task || roTask(id)) return;
  sheet(task.fields.text.v, STATUSES.map((s) => menuItem(chip(s.mark), t(`status.${s.key}`), () => setStatus(id, s.mark), { current: s.mark === task.fields.status.v })));
}

function dueSheet(id) {
  const task = store.get('task', id);
  if (!task || roTask(id)) return;
  const due = task.fields.due.v;
  const set = (v) => { store.setTask(id, { due: v }); closeSheet(); };
  const keepTime = (date) => ({ date, time: due?.time ?? '' });
  const input = h('input', { class: 'field', placeholder: t('due.typeHint'), enterKeyHint: 'done', autocapitalize: 'off', autocomplete: 'off' });
  const apply = () => {
    const d = parseDue(input.value);
    if (d) set(d); else input.classList.add('bad');
  };
  input.addEventListener('input', () => input.classList.remove('bad'));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
  const date = h('input', { class: 'field', type: 'date', value: due?.date ?? '', 'aria-label': t('due.date') });
  const time = h('input', { class: 'field', type: 'time', value: due?.time ? due.time.padStart(5, '0') : '', 'aria-label': t('due.time') });
  const pick = () => {
    if (!date.value) return;
    const tm = time.value ? `${+time.value.slice(0, 2)}:${time.value.slice(3, 5)}` : '';
    store.setTask(id, { due: { date: date.value, time: tm } });
  };
  date.addEventListener('change', pick);
  time.addEventListener('change', pick);
  sheet(due ? t('due.titleWith', { date: dueLongText(due) }) : t('due.title'), [
    ...quickDatesText().map((q) => menuItem('calendar', q.label, () => set(keepTime(q.date)), { hint: q.hint })),
    h('div', { class: 'field-row' }, input, h('button', { class: 'btn primary', onclick: apply }, t('due.set'))),
    h('div', { class: 'field-row' }, date, time),
    due && h('div', { class: 'menu-sep' }),
    due && menuItem('cross', t('due.remove'), () => store.setTask(id, { due: null }), { danger: true }),
  ]);
}

function rowMenu(id) {
  const task = store.get('task', id);
  if (!task || roTask(id)) return;
  ui.sel = id;
  const ctx = nodeOf(id);
  const node = ctx?.node;
  const sibs = node ? (node.parent ? node.parent.kids : ctx.tree.roots) : [];
  const i = sibs.indexOf(node);
  const projectId = task.fields.place.v.project;
  const others = store.projects().filter((p) => p.id !== projectId && !readOnly(p.id) && !(ui.local && sharing(p.id)?.withMe));
  const flat = ui.today;   // (For Today has no order of its own to change: that is done in the task's list)
  sheet(task.fields.text.v, [
    flat && menuItem('lists', t('task.showIn', { list: projectName(task) }), () => showInList(id)),
    menuItem('edit', t('menu.edit'), () => beginEdit(id)),
    menuItem('calendar', t('menu.deadline'), () => dueSheet(id), { keepOpen: true }),
    menuItem('note', t('menu.notes'), () => beginNotes(id)),
    !flat && menuItem('sub', t('menu.addSubtask'), () => addSubtask(id)),
    h('div', { class: 'menu-sep' }),
    !flat && i > 0 && menuItem('up', t('menu.moveUp'), () => nudge(id, -1)),
    !flat && i >= 0 && i < sibs.length - 1 && menuItem('down', t('menu.moveDown'), () => nudge(id, 1)),
    !flat && i > 0 && menuItem('indent', t('menu.indent'), () => shiftLevel(id, 1)),
    !flat && node?.parent && menuItem('outdent', t('menu.outdent'), () => shiftLevel(id, -1)),
    others.length && menuItem('move', t('menu.moveToList'), () => moveSheet(id), { keepOpen: true }),
    h('div', { class: 'menu-sep' }),
    menuItem('trash', node?.kids.length ? t('menu.deleteWithSubtasks') : t('btn.delete'), () => deleteWithUndo(id), { danger: true }),
  ]);
}

function moveSheet(id) {
  const task = store.get('task', id);
  // (the Linux/macOS window moves tasks between its lists files; a shared one is synced by its own engine there,
  // so a move into or out of one is a copy plus a delete, like here, but done by the lists folder: not offered)
  const others = store.projects().filter((p) => p.id !== task.fields.place.v.project && !readOnly(p.id) && !(ui.local && sharing(p.id)?.withMe));
  sheet(t('menu.moveToListTitle'), others.map((p) => menuItem('move', listName(p), () => {
    store.moveTask(id, { projectId: p.id, parentId: null });
    toast(t('task.movedTo', { list: listName(p) }));
  }, { hint: sharing(p.id)?.withMe ? t('list.sharedLower') : '' })));
}

// ---------------------------------------------------------------- drag to reorder (grip handle)
function startDrag(e, id, row) {
  if (e.button > 0) return;
  e.preventDefault();
  commitAll();
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);
  const ctx = nodeOf(id);
  if (!ctx?.node) return;
  const line = h('div', { class: 'drop-line', hidden: true, 'aria-hidden': 'true' });
  els.list.append(line);
  ui.drag = { id, row, line, node: ctx.node, tree: ctx.tree, startY: e.clientY, moved: false, target: null, atEnd: false };
  const move = (ev) => dragMove(ev);
  const up = (ev) => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    endDrag(ev.type === 'pointerup');
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}

function dragMove(e) {
  const d = ui.drag;
  if (!d) return;
  if (!d.moved && Math.abs(e.clientY - d.startY) < 4) return;
  if (!d.moved) { d.moved = true; d.row.classList.add('dragging'); }
  // auto-scroll near the edges
  const r = els.list.getBoundingClientRect();
  if (e.clientY < r.top + 40) els.list.scrollTop -= 12;
  else if (e.clientY > r.bottom - 40) els.list.scrollTop += 12;
  const rows = [...els.list.querySelectorAll('.row')].filter((x) => x.querySelector('.grip svg') && x.dataset.id);
  let target = null;
  for (const x of rows) {
    const b = x.getBoundingClientRect();
    if (e.clientY < b.top + b.height / 2) { target = x; break; }
  }
  d.line.remove();
  if (target) {
    (target.closest(".task-item") ?? target).before(d.line);
    d.target = target.dataset.id;
    d.atEnd = false;
    d.line.style.setProperty('--depth', target.style.getPropertyValue('--depth') || '0');
  } else if (rows.length) {
    let last = rows[rows.length - 1];
    // after the last active row's open subtree
    let next = last.nextElementSibling;
    while (next && (next.classList.contains('notes') || (next.classList.contains('row') && +next.style.getPropertyValue('--depth') > +last.style.getPropertyValue('--depth')))) { last = next; next = next.nextElementSibling; }
    (last.closest(".task-item") ?? last).after(d.line);
    d.target = null;
    d.atEnd = true;
    d.line.style.setProperty('--depth', '0');
  }
  d.line.hidden = false;
}

function endDrag(apply) {
  const d = ui.drag;
  ui.drag = null;
  if (!d) return;
  d.line.remove();
  d.row.classList.remove('dragging');
  if (apply && d.moved && (d.target || d.atEnd) && d.target !== d.id) {
    const projectId = d.node.task.fields.place.v.project;
    if (d.atEnd) {
      store.moveTask(d.id, { projectId, parentId: null });
    } else {
      const target = d.tree.byId.get(d.target);
      if (target && target !== d.node && !isAncestor(d.node, target)) {
        const sibs = (target.parent ? target.parent.kids : d.tree.roots).filter((n) => n.id !== d.id);
        store.moveTask(d.id, { projectId, parentId: target.parent?.id ?? null, index: sibs.indexOf(target) });
      }
    }
    ui.sel = d.id;
  }
  render();
}

// ---------------------------------------------------------------- add bar
// Return on the keyboard, the "+", the tick and a form submit all add the task; the input keeps focus for the next one.
function addTypedTask() {
  const text = cleanText(els.add.value);
  const proj = currentProject();
  if (!text || !proj) return;
  store.addTask(proj.id, { text });
  els.add.value = '';
  syncAddGo();
  revealAdd();
}
/** The add line is the last thing in the list: keep it in view (under the keyboard too). */
function revealAdd() {
  requestAnimationFrame(() => els.addBar.scrollIntoView({ block: 'end' }));
}
const syncAddGo = () => { els.addGo.hidden = !cleanText(els.add.value); };
els.add.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTypedTask(); }
  else if (e.key === 'Escape') { els.add.value = ''; syncAddGo(); els.add.blur(); }
  else if (e.key === 'ArrowUp' && ui.visible.length && !els.add.value) { e.preventDefault(); beginEdit(ui.visible[ui.visible.length - 1]); }
});
els.addBar.addEventListener('submit', (e) => { e.preventDefault(); addTypedTask(); });
els.add.addEventListener('input', syncAddGo);
// (pointerdown/mousedown kept from stealing focus, so the keyboard stays up after a tap on "+" or the tick)
for (const b of [els.addPlus, els.addGo]) b.addEventListener('mousedown', (e) => e.preventDefault());
els.addPlus.addEventListener('click', () => { if (cleanText(els.add.value)) addTypedTask(); else els.add.focus(); });
els.add.addEventListener('focus', revealAdd);
// iOS does not shrink the page when the keyboard opens, it covers it: size the window to what is visible instead
if (window.visualViewport) {
  const fit = () => {
    const vv = window.visualViewport;
    const covered = Math.round(window.innerHeight - vv.height - vv.offsetTop);
    els.app.style.bottom = covered > 80 ? `${covered}px` : '';
    if (covered > 80 && document.activeElement === els.add) revealAdd();
  };
  window.visualViewport.addEventListener('resize', fit);
  window.visualViewport.addEventListener('scroll', fit);
}
els.add.addEventListener('focus', () => { if (ui.editing || ui.notesEditing) { commitAll(); render(); } });

// ---------------------------------------------------------------- keyboard (hardware keyboards / desktop browsers)
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || !els.sheetWrap.hidden || menuOpen() || ui.view !== 'list') return;
  if ((e.key === 'Enter' || e.key === ' ') && t.closest?.('button, a[href], select, summary')) return;   // the control's own action
  const vis = ui.visible;
  const i = ui.sel ? vis.indexOf(ui.sel) : -1;
  const sel = ui.sel && store.get('task', ui.sel);
  // (a view-only list: arrows and opening / closing work, changes do not)
  const edit = sel && !roTask(sel.id) ? sel : null;
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && edit) { e.preventDefault(); nudge(edit.id, e.key === 'ArrowUp' ? -1 : 1); return; }
  if (mod && e.key.toLowerCase() === 'd' && edit) { e.preventDefault(); dueSheet(edit.id); return; }
  if (mod && e.key.toLowerCase() === 'i' && edit) { e.preventDefault(); beginNotes(edit.id); return; }
  if (mod && e.key.toLowerCase() === 'm' && edit) { e.preventDefault(); rowMenu(edit.id); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); els.add.focus(); return; }
  if (mod) return;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); if (vis.length) ui.sel = vis[Math.min(i + 1, vis.length - 1)]; break;
    case 'ArrowUp': e.preventDefault(); if (vis.length) ui.sel = vis[Math.max(i - 1, 0)]; break;
    case 'Enter': if (edit) { e.preventDefault(); beginEdit(edit.id); } return;
    case ' ': if (edit) { e.preventDefault(); setStatus(edit.id, rank(edit.fields.status.v) === 2 ? ' ' : 'x'); } return;
    case 'ArrowRight': if (sel) { setOpen(sel.id, true); } break;
    case 'ArrowLeft': if (sel) { setOpen(sel.id, false); } break;
    case 'Escape': ui.sel = null; break;
    default: return;
  }
  render();
  const row = els.list.querySelector('.row.sel');
  row?.scrollIntoView({ block: 'nearest' });
  if (row && e.key.startsWith('Arrow')) focusOn(row);   // screen readers announce the task
});

// Settings: Esc goes back one level (a page to Settings, Settings to the list), unless a sheet or an editor used it
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || ui.view === 'list' || !els.sheetWrap.hidden) return;
  e.preventDefault();
  goBack();
});

// ---------------------------------------------------------------- Settings and the views it opens
// Settings is a short list of pages, as in the Windows app: General, Notifications, Sync & sharing, Your lists, Use with AI; then
// App: Updates (the Linux/macOS window: the app and the sync service; a paired phone: the sync service, which the
// phone app updates with) and About. Every view is a
// grouped list (docs/design.md, "Grouped lists"): cards of one-line rows, where places to go have a chevron, actions are
// violet rows (red when risky) and what needs explaining is a footnote under the card. Rare and risky actions sit at the
// bottom of their page, under Advanced. A quiet line at the bottom of every view says the version.
// (their keys in the language files: the words are looked up when a view is drawn, so a language switch shows at once)
const PAGES = { general: 'page.general', notifications: 'page.notifications', sync: 'page.sync', lists: 'page.lists', ai: 'page.ai', updates: 'page.updates', about: 'page.about' };
const VIEW_TITLES = { settings: 'nav.settings', ...PAGES, keys: 'page.keys', trash: 'page.trash', backups: 'page.backups', conflicts: 'nav.conflicts' };
// where Back (the header, Esc) goes from each view; a page's is Settings
const VIEW_PARENT = { settings: 'list', keys: 'general', trash: 'lists', backups: 'lists', conflicts: 'sync' };
const parentOf = (view) => VIEW_PARENT[view] ?? 'settings';

/** Opens a view. Keyboard focus goes to the control with the data-fk key `focus`, else to the new view's Back button. */
function go(view, focus = '') {
  commitAll();
  if (view === 'backups') ui.backups = null;   // (read again each time the page opens)
  const fromList = ui.view === 'list';
  ui.view = view;
  ui.focusKey = focus || (view === 'list' ? '' : 'back');
  render();
  els.list.scrollTop = 0;
  if (fromList && view !== 'list') { loadLocalInfo(); loadServiceUpdate(); }
  else if (view === 'updates') loadServiceUpdate();
  if (view === 'ai' || view === 'settings') loadConnector();
}
/** Back: one level up, with focus on the row that opened the view just left (in the list: the task, or Settings). */
function goBack() {
  const from = ui.view;
  if (from === 'list') return;
  const to = parentOf(from);
  go(to, to !== 'list' ? `open:${from}` : ui.sel ? `row:${ui.sel}` : 'logo');
}

function viewHeader(title) {
  const to = parentOf(ui.view);
  const back = to === 'list' ? t('nav.backToList') : t('nav.backTo', { view: t(VIEW_TITLES[to]) });
  return h('div', { class: 'view-header', onclick: goBack },
    h('button', { class: 'back', 'aria-label': back, title: back, dataset: { fk: 'back' }, onclick: (e) => { e.stopPropagation(); goBack(); } }, icon('back')),
    h('h1', {}, title));
}

// ---- the parts of a grouped list
/** A heading over the next card (level 3 inside a sheet, whose title is the h2). */
const head = (text, level = 2) => h(`h${level}`, { class: 'g-head' }, text);
/**
 * The footnote under a card: what its rows mean, when that is not obvious. alert: something went wrong (in the alert
 * colour; not a live region, since a view is rebuilt as its status changes: what happens is announced where it happens).
 */
const foot = (content, { alert = false } = {}) => (content && (!Array.isArray(content) || content.some(Boolean)) ? h('p', { class: `g-foot${alert ? ' alert' : ''}` }, content) : null);
/** A quiet paragraph of its own, between cards. */
const note = (...content) => h('p', { class: 'g-note' }, ...content);
/** A card of rows; null when there are none. */
function card(...rows) {
  const r = rows.flat().filter(Boolean);
  return r.length ? h('div', { class: 'group' }, r) : null;
}
/** A row's content, all on one line: [icon] label ...... [dot] value [trailing]. */
function rowParts(label, { value = '', dot = false, ic = '', trailing = null } = {}) {
  return [
    ic ? h('span', { class: 'g-icon', 'aria-hidden': 'true' }, icon(ic)) : null,
    h('span', { class: 'g-label' }, label),
    value || dot ? h('span', { class: 'g-value' }, dot ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null, value ? h('span', { class: 'g-vtext' }, value) : null) : null,
    trailing,
  ];
}
const rowClass = (kind, { ic = '', long = false, cls = '' } = {}) => ['g-row', kind, ic ? 'icon' : '', long ? 'long' : '', cls].filter(Boolean).join(' ');
const chevron = () => h('span', { class: 'g-chev', 'aria-hidden': 'true' }, icon('chevron'));
/** A row that does nothing by itself: a value (long: the value may be long, and is the one cut short), or a control at its end. */
function infoRow(label, value = '', trailing = null, { dot = false, ic = '', title = '', long = false } = {}) {
  return h('div', { class: rowClass('', { ic, long }), title: title || null }, rowParts(label, { value, dot, ic, trailing }));
}
/**
 * A row that opens a view: label, value, chevron. Its name is what it shows (a screen reader reads both); help says
 * the rest (how it stands in full, what is on the view) as its description and tooltip. Its key is open:<view>, so
 * Back puts focus on it again.
 */
function linkRow(label, value, view, { dot = false, ic = '', help = '' } = {}) {
  return h('button', {
    class: rowClass('link', { ic }), title: help || null, 'aria-description': help || null,
    dataset: { fk: `open:${view}` }, onclick: () => go(view),
  }, rowParts(label, { value, dot, ic, trailing: chevron() }));
}
/**
 * A row that does something: its label violet, red when it is risky. name: a fuller name for screen readers, which
 * starts with the label (it is what a voice-control user says); help: what it does, if that is not obvious.
 */
function actionRow(label, fn, { danger = false, name = '', help = '', value = '', dot = false, fk = '', cls = '' } = {}) {
  return h('button', {
    class: rowClass(`action${danger ? ' danger' : ''}`, { cls }), 'aria-label': name || null, title: help || null, 'aria-description': help || null,
    dataset: { fk: fk || `do:${label}` }, onclick: () => fn(),
  }, rowParts(label, { value, dot }));
}
/** A switch: the whole row is the switch, and flips it. */
function switchRow(label, on, onToggle, { help = '', fk = '' } = {}) {
  return h('button', {
    class: rowClass('switch-row'), role: 'switch', 'aria-checked': String(on), title: help || null, 'aria-description': help || null,
    dataset: { fk: fk || `switch:${label}` }, onclick: () => onToggle(!on),
  }, rowParts(label, { trailing: h('span', { class: `switch${on ? ' on' : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'knob' })) }));
}
/** A text box that is a row, with its buttons at the end. */
const inputRow = (input, ...buttons) => h('div', { class: 'g-row input' }, input, ...buttons);
/** The box of an input row. Its key keeps what was typed when the view is rebuilt (renderSettingsView). */
function rowInput(fk, placeholder, label, { help = '', autocapitalize = 'off' } = {}) {
  return h('input', {
    class: 'g-input', placeholder, 'aria-label': label, 'aria-description': help || null, title: help || null,
    autocapitalize, autocomplete: 'off', spellcheck: false, enterKeyHint: 'go', dataset: { fk },
  });
}
/** A small button at the end of a row (Join, Leave, Restore): text only, violet or red. */
function textButton(text, fn, { danger = false, name = '', help = '', fk = '' } = {}) {
  return h('button', {
    class: `g-btn${danger ? ' danger' : ''}`, 'aria-label': name || null, title: help || null, 'aria-description': help || null,
    dataset: fk ? { fk } : null, onclick: (e) => { e.stopPropagation(); fn(); },
  }, text);
}
function segmented(options, current, onPick, label = '') {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label || null },
    options.map(([v, text]) => h('button', { class: v === current ? 'on' : '', 'aria-pressed': String(v === current), dataset: { fk: `seg:${label}:${v}` }, onclick: () => onPick(v) }, text)));
}

function applyTheme() {
  const p = ls.get('theme', 'auto');
  const dark = p === 'dark' || (p === 'auto' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

const VIEWS = {
  settings: settingsHome, general: generalPage, notifications: notificationsPage, sync: syncPage, lists: listsPage, ai: aiPage,
  updates: updatesPage, about: aboutPage, keys: keysPage, trash: trashPage, backups: backupsPage, conflicts: conflictsPage,
};
/** Every view but the list: its header (Back, title), its cards, and the version line at the bottom. */
function renderSettingsView() {
  if (!VIEWS[ui.view] || (ui.view === 'updates' && !ui.local && !store.meta.token)) ui.view = 'settings';
  // a view rebuilt in place (sync status, the Linux/macOS app's news) keeps what was typed in its boxes
  const typed = new Map([...els.list.querySelectorAll('input.g-input[data-fk]')].map((i) => [i.dataset.fk, [i.value, i.selectionStart, i.selectionEnd]]));
  setListContent([viewHeader(t(VIEW_TITLES[ui.view])), ...VIEWS[ui.view]().filter(Boolean), versionLine()]);
  for (const i of els.list.querySelectorAll('input.g-input[data-fk]')) {
    const was = typed.get(i.dataset.fk);
    if (was && !i.readOnly) { i.value = was[0]; try { i.setSelectionRange(was[1], was[2]); } catch { /* not a text box */ } }
  }
}

/** The version this window runs: the Linux/macOS app's, or the one the server that serves the phone app says. */
const appVersion = () => ui.local?.version ?? bootVersion;
/** The quiet line at the bottom of every Settings view. When an update needs a look (Linux, macOS), it says so and opens Updates. */
function versionLine() {
  const v = appVersion();
  const text = v ? `Saqme To Do ${v}` : 'Saqme To Do';
  const badge = updateBadge();
  if (badge && ui.view !== 'updates') {
    return h('button', { class: 'version-line', 'aria-description': t('settings.opensUpdates'), dataset: { fk: 'version' }, onclick: () => go('updates') },
      h('span', {}, text), h('span', { class: 'upd' }, badge.dot ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null, badge.text));
  }
  return h('p', { class: 'version-line' }, h('span', {}, text), badge ? h('span', {}, badge.text) : null);
}

const THEMES = ['dark', 'light', 'auto'];
/** Settings: two cards of pages (the app's own things last), each row with how it stands on the right. */
function settingsHome() {
  // (how a page stands, as the start of its help: a capital first, where the language has capitals)
  const sentence = (s) => (s ? `${lang() === 'ka' ? s : `${s[0].toUpperCase()}${s.slice(1)}`}. ` : '');
  const page = (id, s, help, ic) => linkRow(t(PAGES[id]), s.short, id, { ic, dot: !!s.dot, help: `${sentence(s.text)}${help}` });
  const theme = THEMES.includes(ls.get('theme', 'auto')) ? ls.get('theme', 'auto') : 'auto';
  const v = appVersion();
  return [
    card(
      page('general', { short: t(`theme.${theme}`), text: t(`theme.${theme}Text`) }, showKeys() ? t('settings.generalHelpKeys') : t('settings.generalHelp'), 'gear'),
      page('notifications', notificationSummary(), ui.local ? t('settings.notificationsHelpLocal') : t('settings.notificationsHelp'), 'bell'),
      page('sync', syncSummary(), ui.local ? t('settings.syncHelpLocal') : t('settings.syncHelp'), 'cloud'),
      page('lists', listsSummary(), ui.local ? t('settings.listsHelpLocal') : t('settings.listsHelp'), 'lists'),
      page('ai', aiSummary(), t('settings.aiHelp'), 'chat'),
    ),
    head(t('settings.app')),
    card(
      ui.local ? page('updates', updateBadge() ?? updateSummary(), t('settings.updatesHelpLocal'), 'update')
        : store.meta.token ? page('updates', serviceSummary(), t('settings.updatesHelp'), 'update') : null,
      page('about', { short: v ?? '', text: v ? t('settings.aboutVersion', { version: v }) : 'Saqme To Do' }, t('settings.aboutHelp'), 'info'),
    ),
  ];
}

/** The keyboard shortcuts page is offered where there is a keyboard to use them: the desktop window, a mouse or trackpad. */
const showKeys = () => !!ui.local || matchMedia('(any-pointer: fine)').matches;
function generalPage() {
  const theme = segmented(THEMES.map((v) => [v, t(`theme.${v}`)]), ls.get('theme', 'auto'), (v) => { ls.set('theme', v); applyTheme(); render(); }, t('theme.title'));
  return [
    card(infoRow(t('theme.title'), '', theme)),
    foot(t('theme.help')),
    card(languageRow()),
    foot(t('language.help')),
    showKeys() ? card(linkRow(t('page.keys'), '', 'keys', { help: t('settings.keysHelp') })) : null,
  ];
}

// ---- the app's language: System (the device's, when the app has it) or one of LANGS, each by its own name
/** The language System stands for on this device. */
const systemLang = () => pickLang('', navigator.languages);
/** Settings > General > Language: the row (its value: the choice now), which opens the choices in a sheet. */
function languageRow() {
  const choice = LANGS.includes(ls.get('lang')) ? ls.get('lang') : '';
  const value = choice ? h('span', { lang: choice }, LANG_NAMES[choice]) : t('language.system', { name: LANG_NAMES[systemLang()] });
  return h('button', {
    class: rowClass('link'), 'aria-haspopup': 'dialog', dataset: { fk: 'language' }, onclick: languageSheet,
  }, rowParts(t('language.title'), { value, trailing: chevron() }));
}
/** The choices, the current one checked (and focused); picking one switches the app at once. */
function languageSheet() {
  const choice = LANGS.includes(ls.get('lang')) ? ls.get('lang') : '';
  const option = (code, label, own) => {
    const cur = code === choice;
    const b = menuItem(h('span', { class: 'check', 'aria-hidden': 'true' }, cur ? icon('check') : null), label, () => switchLanguage(code), { current: cur });
    if (own) b.lang = own;
    return b;
  };
  sheet(t('language.title'), [
    option('', t('language.system', { name: LANG_NAMES[systemLang()] }), ''),
    ...LANGS.map((code) => option(code, LANG_NAMES[code], code)),
    h('p', { class: 'sheet-note' }, t('language.help')),
  ]);
}
/** Switches the app to a language ('' = System) without a reload: every view is drawn again in it. */
async function switchLanguage(code) {
  ls.set('lang', code);
  await setLang(pickLang(code, navigator.languages));
  document.documentElement.lang = lang();
  applyStaticTexts();
  reportLanguage();
  render();
  announce(t('language.switched', { name: LANG_NAMES[lang()] }));
}

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
/** What the keyboard does (the list's handler, the editors' and the sheets'): what on the left, its keys on the right. */
function keysPage() {
  const mod = IS_MAC ? 'Cmd' : 'Ctrl';
  const alt = IS_MAC ? 'Option' : 'Alt';
  // (key names as printed on the keys stay as they are; the arrows' names are words)
  const up = t('keys.up');
  const down = t('keys.down');
  const left = t('keys.left');
  const right = t('keys.right');
  const sections = [
    [t('keys.tasks'), [
      [`${up} / ${down}`, t('keys.prevNextTask')], ['Enter', t('keys.editTask')], ['Space', t('keys.doneNotDone')], [`${right} / ${left}`, t('keys.openClose')],
      [`${alt}+${up} / ${alt}+${down}`, t('keys.moveTask')], [`${mod}+D`, t('due.title')], [`${mod}+I`, t('menu.notes')], [`${mod}+M`, t('task.menu')],
      [`${mod}+N`, t('keys.newTask')], ['Esc', t('keys.clearSelection')],
    ], t('keys.tasksFoot')],
    [t('list.menuLabel'), [
      [`${left} / ${right}`, t('keys.prevNextList')], [`Enter / ${down}`, t('keys.allLists')], [`${up} / ${down}`, t('keys.chooseList')], ['Enter', t('keys.switchToIt')],
      [`${mod}+M`, t('keys.itsMenu')], ['Esc', t('keys.closeListsMenu')],
    ], t('keys.listsFoot')],
    [t('keys.editing'), [
      ['Enter', t('keys.saveNewBelow')], ['Shift+Enter', t('keys.saveNewSubtask')], ['Enter', t('keys.stopEmpty')], [`${up} / ${down}`, t('keys.editPrevNext')],
      ['Tab / Shift+Tab', t('keys.subtaskBackOut')], ['Esc', t('btn.cancel')], [`${mod}+Enter`, t('keys.saveNotes')],
    ]],
    [t('keys.everywhere'), [
      ['Tab / Shift+Tab', t('keys.moveAround')], ['Enter / Space', t('keys.useFocused')], ['Esc', t('keys.closeBack')],
    ], t('keys.everywhereFoot')],
  ];
  const out = [];
  const or = ` ${t('keys.or')} `;
  for (const [title, rows, footnote] of sections) {
    out.push(head(title), card(rows.map(([keys, what]) => infoRow(what, '', h('span', { class: 'keys' },
      h('span', { class: 'sr-only' }, ': '), keys.split(' / ').map((k, i) => [i ? h('span', { class: 'sr-only' }, or) : null, h('kbd', {}, k)])), { title: `${what}: ${keys}` }))));
    if (footnote) out.push(foot(footnote));
  }
  return out;
}

function notificationSummary() {
  const at = store.setting('notifyAt', '10:00');
  if (ui.local) return { short: at, text: t('notif.summaryAt', { time: at }) };
  const p = pushState();
  return p.state === 'on' ? { short: at, text: t('notif.onSummaryAt', { time: at }) } : { short: p.short, text: p.text };
}
function notificationsPage() {
  const at = h('input', { class: 'time-input', type: 'time', value: store.setting('notifyAt', '10:00').padStart(5, '0'), 'aria-label': t('notif.summaryTime'), dataset: { fk: 'notifyAt' } });
  at.addEventListener('change', () => { if (at.value) { store.setSetting('notifyAt', `${+at.value.slice(0, 2)}:${at.value.slice(3, 5)}`); syncSharePush(); } });
  const out = [
    card(infoRow(t('notif.summary'), '', at)),
    foot(t('notif.summaryHelp')),
  ];
  if (ui.local) {
    out.push(card(infoRow(t('page.notifications'), t('notif.onComputer'))), foot(t('notif.computerHelp')));
    return out;
  }
  const p = pushState();
  if (p.state === 'unpaired') {
    // used without sync: say what reminders need before offering a time for them
    return [
      card(infoRow(t('page.notifications'), p.short), linkRow(t('page.sync'), t('sync.notPaired'), 'sync', { help: t('notif.pairHelp') })),
      foot(p.help),
      card(infoRow(t('notif.summary'), '', at)),
      foot(t('notif.summaryHelpUnpaired')),
    ];
  }
  if (p.state === 'on' || p.state === 'off') {
    out.push(card(
      switchRow(t('page.notifications'), p.state === 'on', async (on) => { if (on) await enablePush(); else { await disablePush(); render(); } }, { help: p.help, fk: 'push' }),
      p.state === 'on' ? actionRow(t('notif.sendTest'), testPush) : null));
  } else out.push(card(infoRow(t('page.notifications'), p.short)));
  out.push(foot(p.help));
  return out;
}

/** How sync stands, in a few words: the value of a row ('' when this device has no sync of its own). */
function syncShort() {
  if (ui.local) {
    const c = ui.local.cloud;
    if (!c) return ui.cloudSetup?.running ? t('sync.settingUp') : '';
    return { synced: c.lastSync ? t('sync.syncedAgo', { ago: ago(c.lastSync) }) : t('sync.synced'), syncing: t('sync.syncing'), offline: t('sync.offline') }[c.state] ?? t('sync.errorShort');
  }
  if (!store.meta.token) return '';
  const st = store.status.state;
  if (st === 'idle') return store.meta.lastSync ? t('sync.syncedAgo', { ago: ago(store.meta.lastSync) }) : t('sync.synced');
  if (st === 'offline') { const n = store.pendingCount(); return n ? tn('sync.offlineN', n) : t('sync.offline'); }
  return { syncing: t('sync.syncing'), error: t('sync.errorShort') }[st] ?? '';
}
/** The Sync & sharing row: own sync, conflicts, shared lists, paused deletes. text says all of it; short is what needs a look first. */
function syncSummary() {
  const n = store.conflicts().length + allNotices().length;
  const nc = tn('sync.nConflicts', n);
  const sh = (ui.local ? ui.local.shares ?? [] : store.shares()).length;
  const ns = tn('sync.nSharedLists', sh);
  const guarded = !!ui.local?.guarded;
  const own = syncShort();
  return {
    text: [own || t('sync.isOff'), n ? nc : '', sh ? ns : '', guarded ? t('sync.deletionsPausedLower') : ''].filter(Boolean).join(', '),
    short: n ? nc : guarded ? t('sync.deletionsPaused') : own || (sh ? ns : t('common.off')),
    dot: !!(n || guarded),
  };
}
function syncPage() {
  return [
    ...(ui.local ? localSyncSettings() : phoneSyncSettings()),
    ...sharedListSettings(),
    ...(ui.local?.guarded ? guardedSettings() : []),
    ...(ui.local?.rewritten?.length ? rewrittenSettings() : []),
    ...advancedSettings(),
  ];
}
/** The row to Conflicts, when there are some (also what a shared list's server did not take). */
function conflictsRow() {
  const n = store.conflicts().length + allNotices().length;
  return n ? linkRow(t('nav.conflicts'), String(n), 'conflicts', { dot: true, help: t('sync.conflictsHelp') }) : null;
}
/** The phone app's own sync: pair it (a code or a link), or how it stands. */
function phoneSyncSettings() {
  const out = [head(t('sync.head'))];
  if (!store.meta.token) {
    out.push(card(infoRow(t('sync.thisDevice'), t('sync.notPaired')), pairingRow(), conflictsRow()));
    out.push(foot(t('sync.setUpFromComputer')));
    return out;
  }
  const st = store.status;
  out.push(card(
    infoRow(t('sync.status'), syncShort(), null, { title: statusText() }),
    actionRow(t('sync.now'), () => store.sync({ force: true })),
    actionRow(t('pair.title'), showPairing, { help: t('pair.helpPhone') }),
    conflictsRow(),
  ));
  if (st.state === 'error') out.push(foot(t('sync.error', { error: st.message }), { alert: true }));
  const service = { host: hostOf(store.meta.server || location.origin), version: store.meta.serverVersion, device: store.meta.deviceId };
  out.push(foot(t(store.meta.serverVersion ? 'sync.serviceAboutVersion' : 'sync.serviceAbout', service)));
  return out;
}
/** Sync & sharing > Advanced: turning sync off (a row that opens the rest of its card). */
function advancedSettings() {
  if (!(ui.local ? ui.local.cloud : store.meta.token)) return [];
  const open = ui.advancedOpen;
  const what = ui.local ? t('sync.turnOff') : t('sync.unpair');
  const help = ui.local ? t('sync.turnOffHelp') : t('sync.unpairHelp');
  return [
    card(
      h('button', {
        class: 'g-row link', 'aria-expanded': String(open), 'aria-description': what, dataset: { fk: 'advanced' },
        onclick: () => { ui.advancedOpen = !open; render(); },
      }, rowParts(t('settings.advanced'), { trailing: chevron() })),
      open ? actionRow(what, ui.local ? confirmTurnOff : confirmUnpair, { danger: true, help }) : null),
    open ? foot(help) : null,
  ];
}
function confirmTurnOff() {
  sheet(t('sync.turnOffTitle'), [h('p', {}, t('sync.turnOffHelp')), h('div', { class: 'btn-row' },
    h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')),
    h('button', { class: 'btn primary', onclick: async () => { closeSheet(); try { await api('local/disconnect', {}); ui.advancedOpen = false; await loadLocalInfo(); render(); } catch (e) { toast(e.message); } } }, t('sync.turnOffButton')))]);
}

function listsSummary() {
  const n = store.projects().length;
  const nl = tn('lists.n', n);
  return store.saveError ? { short: t('lists.notSaved'), text: tn('lists.nNotSaved', n), dot: true } : { short: nl, text: nl };
}
function listsPage() {
  const l = ui.local;
  return [
    store.saveError ? saveWarning() : null,
    card(
      l ? actionRow(t('lists.copyFolder'), () => copyText(l.lists, t('lists.folderCopied')), { help: l.lists }) : null,
      actionRow(t('lists.export'), exportLists, { help: t('lists.exportHelp') }),
      actionRow(t('lists.import'), importLists, { help: t('lists.importHelp') }),
      linkRow(t('page.trash'), '', 'trash', { help: t('lists.trashHelp') }),
      l ? linkRow(t('page.backups'), '', 'backups', { help: t('lists.backupsHelp') }) : null,
    ),
    foot(l ? t('lists.footLocal', { folder: l.lists }) : t('lists.foot')),
  ];
}

// ---- Use with AI: the ways to connect an AI app, best first (ai.js aiOptions): the link from the sync service (worker/src/
// connector.js, an MCP server: Claude and ChatGPT on the web and the phone), Claude Desktop on this computer (the
// Linux/macOS window: local/claude-desktop.mjs, no sync needed), and the instructions for an AI app that edits the files.
// Plain words only: the people who need this most have never heard of MCP.
const hasOwnSync = () => !!(ui.local ? ui.local.cloud : store.meta.token);
function connectorTooOld() {
  const a = ui.local ? ui.local.cloud?.workerApi : store.meta.serverApi;
  return Number.isInteger(a) && a < CONNECTOR_API;
}
async function loadConnector() {
  if (ui.local) loadClaudeDesktop();
  if (!hasOwnSync() || connectorTooOld()) return;
  try { ui.connector = await api(ui.local ? 'local/connector' : 'connector'); ui.connectorError = ''; } catch (e) { ui.connectorError = e.message; }
  if ((ui.view === 'ai' || ui.view === 'settings') && !ui.editing && els.sheetWrap.hidden) requestRender();
}
async function connectorAction(kind, done) {
  try {
    ui.connector = await api(ui.local ? `local/connector/${kind}` : `connector/${kind}`, {});
    ui.connectorError = '';
    if (done) toast(done);
  } catch (e) { toast(e.message); }
  render();
}
function aiSummary() {
  const desktop = ui.claudeDesktop?.state === 'connected';
  if (!hasOwnSync()) {
    if (ui.local) return desktop ? { short: t('common.on'), text: t('ai.desktopHasLists') } : { short: '', text: t('ai.summaryDesktop') };
    return { short: t('ai.needsSync'), text: t('ai.summaryNeedsSync') };
  }
  const c = ui.connector;
  if (!c || connectorTooOld()) return { short: '', text: t('ai.summaryConnect') };
  return c.enabled || desktop ? { short: t('common.on'), text: c.enabled ? (c.lastUsedAt ? t('ai.linkOnUsed', { ago: ago(c.lastUsedAt) }) : t('ai.linkOn')) : t('ai.desktopHasLists') }
    : { short: t('common.off'), text: t('ai.linkOff') };
}
// What to do in the page the Connect button opened, in the same words as docs/ai.md ("Connect Claude", "Connect ChatGPT").
// (each step a message with the words to click in bold; the AI apps' own labels stay as those apps show them)
const ASSISTANTS = {
  claude: ['Claude', ['ai.claude.step1', 'ai.claude.step2', 'ai.claude.step3'], 'ai.claude.note'],
  chatgpt: ['ChatGPT', ['ai.chatgpt.step1', 'ai.chatgpt.step2', 'ai.chatgpt.step3', 'ai.chatgpt.step4'], 'ai.chatgpt.note'],
};
/** Connect Claude / Connect ChatGPT: copies the link and opens the place to paste it, then says what to click there. */
function connectAssistant(id) {
  const url = ui.connector?.url;
  if (!url) return;
  // (the copy starts while this window still has the focus; the new tab takes it)
  const copied = navigator.clipboard?.writeText(url).then(() => true, () => false) ?? Promise.resolve(false);
  window.open(AI_LINKS[id], '_blank', 'noopener');
  const [name, steps, note] = ASSISTANTS[id];
  const status = h('p', { class: 'sheet-lead', role: 'status' }, t('ai.copying'));
  copied.then((ok) => { status.textContent = ok ? t('ai.copiedPaste') : t('ai.copyThenPaste'); });
  sheet(t('ai.connectName', { name }), [
    status,
    h('ol', { class: 'steps' }, steps.map((s) => h('li', {}, richText(s)))),
    h('p', { class: 'sheet-note' }, t(note)),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => copyText(url, t('ai.copiedPaste')) }, t('ai.copyLink')),
      h('button', { class: 'btn', onclick: () => window.open(AI_LINKS[id], '_blank', 'noopener') }, t('ai.openName', { name })),
      h('button', { class: 'btn primary', onclick: closeSheet }, t('btn.done'))),
  ]);
}
function confirmConnector(kind) {
  const rotate = kind === 'rotate';
  sheet(rotate ? t('ai.rotateTitle') : t('ai.disconnectTitle'), [
    h('p', {}, rotate ? t('ai.rotateWhat') : t('ai.disconnectWhat')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')),
      h('button', { class: 'btn primary', onclick: () => { closeSheet(); connectorAction(kind, rotate ? t('ai.rotated') : t('ai.disconnected')); } }, rotate ? t('ai.rotate') : t('ai.disconnect'))),
  ]);
}

// Claude Desktop on this computer (the Linux/macOS window): Saqme in its settings, so it has the lists in every chat
async function loadClaudeDesktop() {
  try { ui.claudeDesktop = await api('local/claude-desktop'); } catch (e) { ui.claudeDesktop = { error: e.message }; }
  if ((ui.view === 'ai' || ui.view === 'settings') && !ui.editing && els.sheetWrap.hidden) requestRender();
}
async function claudeDesktopAction(kind) {
  try {
    ui.claudeDesktop = await api(`local/claude-desktop/${kind}`, {});
    if (kind === 'connect') claudeDesktopSteps();
    else toast(ui.claudeDesktop.changed ? t('ai.desktopRemoved') : t('ai.desktopHadNot'));
  } catch (e) { toast(e.message); }
  render();
}
function claudeDesktopSteps() {
  sheet(t('ai.desktopConnectedTitle'), [
    h('p', { class: 'sheet-lead', role: 'status' }, t('ai.desktopOneMore')),
    h('ol', { class: 'steps' },
      h('li', {}, richText('ai.desktop.step1')),
      h('li', {}, t('ai.desktop.step2')),
      h('li', {}, richText('ai.desktop.step3'))),
    h('p', { class: 'sheet-note' }, t('ai.desktop.note')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: closeSheet }, t('btn.done'))),
  ]);
}
function desktopSection(first) {
  const out = [head(t('ai.desktopHead'))];
  const d = ui.claudeDesktop;
  if (!d) return [...out, card(infoRow('Claude Desktop', t('common.checking')))];
  if (d.error) return [...out, card(infoRow('Claude Desktop', t('common.notReachable'))), foot(d.error, { alert: true })];
  if (!d.installed) {
    return [...out, card(actionRow(t('ai.desktopInstall'), () => window.open(AI_LINKS.claudeDesktop, '_blank', 'noopener'), { help: t('ai.desktopInstallHelp'), fk: 'ai-desktop-install' })),
      foot(first ? t('ai.desktopInstallFootFirst') : t('ai.desktopInstallFoot'))];
  }
  if (d.state === 'connected') {
    return [...out, card(infoRow('Claude Desktop', t('ai.connected')), actionRow(t('ai.desktopDisconnect'), () => claudeDesktopAction('disconnect'), { danger: true, help: t('ai.desktopDisconnectHelp'), fk: 'ai-desktop-disconnect' })),
      foot(t('ai.desktopConnectedFoot'))];
  }
  if (d.state === 'unreadable') return [...out, card(infoRow('Claude Desktop', t('ai.notConnected'))), foot(d.error, { alert: true })];
  return [...out, card(actionRow(t('ai.desktopConnect'), () => claudeDesktopAction('connect'), { help: t('ai.desktopConnectHelp'), fk: 'ai-desktop' })),
    foot(t('ai.desktopConnectFoot'))];
}
function linkSection() {
  const out = [head(t('ai.connectYourAi'))];
  if (!hasOwnSync()) {
    out.push(card(infoRow(t('ai.connectYourAi'), t('ai.needsSync')), linkRow(t('page.sync'), ui.local ? t('common.off') : t('sync.notPaired'), 'sync', { help: ui.local ? t('ai.setUpSync') : t('ai.pairDevice') })));
    out.push(foot(ui.local ? t('ai.needsSyncFootLocal') : t('ai.needsSyncFoot')));
  } else if (connectorTooOld()) {
    out.push(card(infoRow(t('ai.connectYourAi'), t('ai.notYet'))), foot(ui.local ? t('ai.tooOldLocal') : t('ai.tooOld')));
  } else if (!ui.connector) {
    out.push(card(infoRow(t('ai.connectYourAi'), ui.connectorError ? t('common.notReachable') : t('common.checking'))), ui.connectorError ? foot(t('ai.couldNotReach', { error: ui.connectorError }), { alert: true }) : null);
  } else if (!ui.connector.enabled) {
    out.push(card(actionRow(t('ai.connectYourAi'), () => connectorAction('rotate', t('ai.connectedNow')), { help: t('ai.connectHelp'), fk: 'ai-connect' })));
    out.push(foot(t('ai.offFoot')));
  } else {
    const c = ui.connector;
    out.push(card(
      actionRow(t('ai.connectName', { name: 'Claude' }), () => connectAssistant('claude'), { help: t('ai.connectNameHelp', { name: 'Claude' }), fk: 'ai-claude' }),
      actionRow(t('ai.connectName', { name: 'ChatGPT' }), () => connectAssistant('chatgpt'), { help: t('ai.connectNameHelp', { name: 'ChatGPT' }), fk: 'ai-chatgpt' }),
      actionRow(t('ai.copyLink'), () => copyText(c.url, t('ai.copiedPasteApp')), { name: t('ai.copyLinkName'), help: t('ai.copyLinkHelp'), fk: 'ai-copy' }),
    ));
    out.push(foot(c.lastUsedAt ? `${t('ai.onFoot')} ${t('ai.lastUsed', { ago: ago(c.lastUsedAt) })}` : t('ai.onFoot')));
    out.push(head(t('ai.yourLink')), card(
      actionRow(t('ai.rotate'), () => confirmConnector('rotate'), { help: t('ai.rotateHelp'), fk: 'ai-rotate' }),
      actionRow(t('ai.disconnect'), () => confirmConnector('disconnect'), { danger: true, name: t('ai.disconnectName'), help: t('ai.disconnectHelp'), fk: 'ai-disconnect' }),
    ));
    out.push(foot(t('ai.keepPrivate')));
  }
  return out;
}
function filesSection() {
  return [head(t('ai.otherWays')), card(
    actionRow(t('ai.copyInstructions'), () => aiInstructions(false), { help: t('ai.copyInstructionsHelp') }),
    actionRow(t('ai.saveInstructions'), () => aiInstructions(true), { name: t('ai.saveInstructionsName'), help: t('ai.saveInstructionsHelp') }),
  ), foot(t('ai.filesFoot'))];
}
function aiPage() {
  const order = aiOptions({ sync: hasOwnSync(), local: !!ui.local });
  return order.flatMap((o, i) => (o === 'link' ? linkSection() : o === 'desktop' ? desktopSection(i === 0) : filesSection()));
}

/** "Use with AI": the instructions the local app wrote for this lists folder (local/ai-prompt.mjs), copied or saved as SAQME.md. */
async function aiInstructions(save) {
  try {
    const { text } = await api('local/ai-prompt');
    if (!save) { await navigator.clipboard.writeText(text); toast(t('ai.instructionsCopied')); return; }
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: 'SAQME.md' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    toast(t('common.savedFile', { name: 'SAQME.md' }));
  } catch (e) { toast(t(save ? 'ai.couldNotSave' : 'ai.couldNotCopy', { error: e.message })); }
}

function aboutPage() {
  const v = appVersion();
  const badge = updateBadge();
  const where = ui.local ? t('about.whereLocal') : store.meta.token ? t('about.whereSync') : t('about.whereDevice');
  const svc = !ui.local && store.meta.token ? serviceSummary() : null;
  return [
    card(
      v ? infoRow(t('about.version'), v) : null,
      badge ? linkRow(t('page.updates'), badge.short, 'updates', { dot: badge.dot, help: badge.text })
        : svc ? linkRow(t('page.updates'), svc.short, 'updates', { dot: !!svc.dot, help: t('settings.updatesHelp') }) : null,
    ),
    foot(ui.local ? (ui.local.update?.supported ? t('about.updatesItself') : t('about.sourceFolder'))
      : svc ? t('about.updatesWithService') : v ? t('about.updatesWithServer') : t('about.updatesWithSite')),
    note(`${where} ${t('about.openSource')}`),
  ];
}

/** Sync & sharing > Shared lists: join one (paste its invite link), and the lists shared with this device, each with Leave. */
function sharedListSettings() {
  const input = rowInput('join-input', t('shared.pastePlaceholder'), t('share.inviteLink'), { help: t('shared.pasteHelp') });
  const submit = () => {
    const inv = parseInviteLink(input.value);
    if (!inv) { input.classList.add('bad'); toast(t('share.notInviteLink')); return; }
    confirmJoin(input.value.trim(), inv);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => input.classList.remove('bad'));
  // (on an iPhone the clipboard is read only on a tap like this one)
  const paste = navigator.clipboard?.readText ? textButton(t('btn.paste'), async () => {
    try { input.value = (await navigator.clipboard.readText()).trim(); input.classList.remove('bad'); input.focus(); } catch { toast(t('common.pasteIntoBox')); }
  }, { name: t('shared.pasteName'), fk: 'join-paste' }) : null;
  const rows = [inputRow(input, paste, textButton(t('shareJoin.join'), submit, { name: t('shared.joinName'), fk: 'join-go' }))];
  for (const s of ui.local ? (ui.local.shares ?? []) : store.shares()) {
    const p = store.get('project', s.projectId);
    const name = p && !ui.local ? listName(p) : (p?.fields.name.v ?? s.name);
    const st = store.shareStatus.get(s.id) ?? s.status;
    const trouble = st?.state === 'offline' || st?.state === 'error' || st?.state === 'paused';
    const a = ACCESS()[s.access];
    const access = a?.name ?? s.access;
    const aboutKey = `shared.about${inBrowser(s) ? 'Browser' : ''}${trouble ? 'Trouble' : ''}`;
    const about = t(aboutKey, { host: hostOf(s.server), access: a?.lower ?? s.access, error: trouble ? localText(st.message) || st.state : '' });
    // a list used here in the browser can also move to one's Saqme app: its own small menu
    const end = inBrowser(s)
      ? textButton(t('shared.options'), () => sharedListMenu(s, name), { name: t('shared.optionsFor', { name }), help: t('shared.optionsHelp', { about }), fk: `share-opts:${s.id}` })
      : textButton(t('share.leave'), () => confirmLeave(s.projectId, s), { danger: true, name: t('shared.leaveName', { name }), help: t(ui.local ? 'shared.leaveHelpComputer' : 'shared.leaveHelpDevice', { about }), fk: `leave:${s.id}` });
    rows.push(infoRow(name, trouble ? t('shared.notSyncedShort') : access, end, { dot: trouble, title: about }));
  }
  return [
    head(t('shared.head')),
    card(rows),
    foot(ui.local ? t('shared.footLocal') : store.meta.token ? t('shared.footSync') : t('shared.footBrowser')),
  ];
}
function sharedListMenu(s, name) {
  sheet(name, [
    h('p', { class: 'sheet-note' }, t('shared.inBrowserNote', { host: hostOf(s.server), access: ACCESS()[s.access]?.name })),
    menuItem('share', t('share.moveToApp'), () => moveToAppSheet(s), { keepOpen: true }),
    h('div', { class: 'menu-sep' }),
    menuItem('leave', t('share.leaveList'), () => confirmLeave(s.projectId, s), { danger: true }),
  ]);
}

// ---------------------------------------------------------------- the Linux/macOS app (local server)
/** The last lines of the cloud setup's output, links clickable (the Cloudflare sign-in link among them). */
function setupOutput(lines) {
  const pre = h('pre', { class: 'setup-log', 'aria-label': t('local.setupOutput') });
  for (const line of lines.slice(-14)) {
    for (const part of linkify(line)) pre.append(part.url ? h('a', { href: part.url, target: '_blank', rel: 'noopener noreferrer' }, part.text) : part.text);
    pre.append('\n');
  }
  return pre;
}

/** Settings > Sync & sharing > Set up sync: the local server runs the cloud setup; follow it until it ends. */
async function startCloudSetup() {
  try { ui.cloudSetup = await api('local/cloud-setup', {}); } catch (e) { toast(e.message); return; }
  render();
  while (ui.cloudSetup?.running) {
    await new Promise((r) => setTimeout(r, 1000));
    try { ui.cloudSetup = await api('local/cloud-setup'); } catch { break; }
    if (ui.view !== 'list' && !ui.editing) render();
  }
  if (ui.cloudSetup?.result?.ok) {
    announce(t('local.setUp'));
    await loadLocalInfo();
    render();
    showPairing();   // what comes next: the phone
  } else {
    if (ui.cloudSetup?.result && !ui.cloudSetup.result.ok) announce(t('local.setupFailed', { message: ui.cloudSetup.result.message }));
    render();
  }
}

/** The Linux/macOS window's cloud sync: set it up (or connect with a pairing link), or how it stands. */
function localSyncSettings() {
  const c = ui.local.cloud;
  const run = ui.cloudSetup;
  const out = [head(t('sync.head'))];
  if (!c && run?.running) {
    out.push(
      card(infoRow(t('local.syncWithPhone'), t('sync.settingUp')),
        actionRow(t('btn.cancel'), async () => { ui.cloudSetup = await api('local/cloud-setup/cancel', {}).catch(() => ui.cloudSetup); render(); }, { name: t('local.cancelSetup') })),
      foot(t('local.signInHelp')),
      setupOutput(run.lines));
    return out;
  }
  if (!c) {
    out.push(card(infoRow(t('local.syncWithPhone'), t('common.off')), actionRow(t('ai.setUpSync'), startCloudSetup, { help: t('local.setupHelp') }), conflictsRow()), foot(t('local.setupHelp')));
    if (run?.result && !run.result.ok) {
      out.push(foot(t('local.setupFailedFoot', { message: run.result.message, next: run.result.next || '' }).replace(/ {2,}/g, ' '), { alert: true }));
      if (run.lines.length) out.push(setupOutput(run.lines));
    }
    // like the Windows app: a pairing link from a device that already syncs connects this computer too
    const input = rowInput('connect-input', t('local.pastePairing'), t('local.pairingLink'), { help: t('local.pairingLinkHelp') });
    const submit = () => {
      const p = parsePairingLink(input.value);
      if (!p?.server) { input.classList.add('bad'); toast(t('local.notPairingLink')); return; }
      const link = input.value.trim();
      confirmSyncWith(p.server, async () => {
        // (the page may have been rebuilt meanwhile: its box now is the one with the same key)
        const box = () => document.querySelector('[data-fk="connect-input"]');
        try { await api('local/connect', { link }); if (box()) box().value = ''; toast(t('local.connected')); setTimeout(loadLocalInfo, 2500); }
        catch (e) { box()?.classList.add('bad'); toast(e.message); }
      });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    input.addEventListener('input', () => input.classList.remove('bad'));
    out.push(head(t('local.alreadySyncing')),
      card(inputRow(input, textButton(t('local.connect'), submit, { name: t('local.connectName'), fk: 'connect-go' }))),
      foot(t('local.alreadySyncingFoot')));
    return out;
  }
  const short = syncShort();
  out.push(card(
    infoRow(t('sync.status'), short, null, { title: localText(c.message) || short }),
    actionRow(t('pair.title'), showPairing, { help: t('pair.helpLocal') }),
    conflictsRow(),
  ));
  if (c.message && c.state !== 'synced' && c.state !== 'syncing') out.push(foot(localText(c.message), { alert: c.state === 'error' }));
  const service = t(c.workerVersion ? 'local.serviceVersion' : 'local.service', { label: c.label, version: c.workerVersion });
  out.push(foot(c.conflicts ? `${service} ${tn('local.conflictsOnPhone', c.conflicts)}` : service));
  return out;
}
/** Tasks that vanished from the lists folder at once: deleting them everywhere waits for a yes (shown while it does). */
function guardedSettings() {
  const g = ui.local.guarded;
  const msg = tn('local.guardedMsg', g);
  return [
    head(t('sync.deletionsPaused')),
    card(
      infoRow(t('local.waitingForYou'), tn('local.guardedTasks', g), null, { dot: true, title: msg }),
      actionRow(t('local.restoreThem'), async () => {
        try { await api('local/restore-deletes', {}); toast(t('local.restored')); } catch (e) { toast(t('local.couldNotRestore', { error: e.message })); }
      }, { help: t('local.restoreThemHelp') }),
      actionRow(t('local.deleteThem'), async () => {
        try { await api('local/allow-deletes', {}); toast(t('local.deletesConfirmed')); } catch (e) { toast(t('local.couldNotConfirm', { error: e.message })); }
      }, { danger: true, help: t('local.deleteThemHelp') })),
    foot(msg),
  ];
}

/** Lists whose file vanished without being deleted in an app: the local app wrote them again from the last sync (docs/sync.md). */
function rewrittenSettings() {
  const time = (at) => dateText(at, { hour: '2-digit', minute: '2-digit' });
  return [
    head(t('local.rewrittenHead')),
    card(...ui.local.rewritten.map((x) => infoRow(x.name, tn('local.rewrittenRow', x.count, { time: time(x.at) })))),
    foot(t('local.rewrittenFoot')),
  ];
}

/** When an update needs a look (the version line's news, the Updates row's value), else null. dot: something to do. */
function updateBadge() {
  const u = ui.local?.update;
  if (!u?.supported) return null;
  if (u.running) return { text: t('upd.updatingTo', { version: u.running.version }), short: t('upd.updating'), dot: false };
  if (u.worker?.pending && u.worker.needsLogin) return { text: t('upd.signInToFinish'), short: t('upd.signInNeeded'), dot: true };
  if (u.available) return { text: t('upd.available', { version: u.latest }), short: t('upd.availableShort', { version: u.latest }), dot: true };
  if (u.result && !u.result.ok) return { text: u.result.version ? t('upd.waitingTo', { version: u.result.version }) : t('upd.lastDidNotInstall'), short: t('upd.waiting'), dot: true };
  return null;
}
/** The Updates row when there is no news: in words (text) and as the row's value (short). */
function updateSummary() {
  const u = ui.local?.update;
  if (!u?.supported) return { text: t('upd.noSelfUpdate'), short: t('common.off') };
  if (u.checking) return { text: t('upd.checkingText'), short: t('common.checking') };
  if (u.error) return { text: t('upd.couldNotCheckText'), short: t('upd.couldNotCheck') };
  if (u.checkedAt) return { text: t('upd.upToDateText'), short: t('upd.upToDate') };
  return u.auto ? { text: t('upd.autoText'), short: t('upd.automatic') } : { text: t('upd.manualText'), short: t('upd.manual') };
}
/**
 * Settings > Updates in the Linux/macOS window (local/updater.mjs): this version, the newest one with Update now,
 * what an update is doing, how the last one ended, the Cloudflare sign-in that finishes a Worker update, and
 * "Install updates automatically". The window refreshes it with the rest of ui.local while Settings are open.
 */
function updatesPage() {
  if (!ui.local) return serviceUpdateSettings();   // (a paired phone: its app is the sync service's)
  const u = ui.local?.update;
  const version = infoRow(t('about.version'), u?.current ?? appVersion() ?? '');
  if (!u?.supported) return [card(version), foot(t('upd.sourceFolder')), ...(ui.local.cloud ? serviceUpdateSettings() : [])];
  const out = [];
  const run = u.running;
  if (run) {
    const steps = { checking: t('common.checking'), downloading: t('upd.downloading', { version: run.version }), installing: t('upd.installing', { version: run.version }), worker: t('upd.updatingService'), restarting: t('upd.restarting') };
    const what = steps[run.state] ?? t('upd.updatingTo', { version: run.version });
    out.push(card(version, infoRow(t('sync.status'), what, null, { long: true, title: what })),
      foot(t('upd.restartsWhenDone')));
  } else if (u.available) {
    out.push(card(version, infoRow(t('upd.availableLabel'), u.latest, null, { dot: true }),
      actionRow(t('upd.now'), () => updateAction('now'), { name: t('upd.nowTo', { version: u.latest }), help: t('upd.nowHelp') })),
    foot(t('upd.youHave', { version: u.current })));
  } else {
    out.push(card(version, infoRow(t('sync.status'), u.checking ? t('common.checking') : u.error ? t('upd.couldNotCheck') : u.checkedAt ? t('upd.upToDate') : t('upd.notChecked')),
      actionRow(t('upd.checkNow'), () => updateAction('check'), { help: t('upd.checkNowHelp') })),
    u.error ? foot(t('upd.couldNotCheckError', { error: u.error }), { alert: true })
      : foot(u.checkedAt ? t('upd.checkedAgo', { ago: ago(u.checkedAt) }) : t('upd.checkedSoon')));
  }
  // how the last one ended, when there is something to do about it
  const signIn = () => actionRow(t('upd.signIn'), () => updateAction('login'), { help: t('upd.signInHelp') });
  if (u.login?.running) {
    out.push(card(infoRow(t('upd.signingIn'))), foot([t('upd.signInBrowser'),
      u.login.url ? [` ${t('upd.noBrowser')} `, h('a', { href: u.login.url, target: '_blank', rel: 'noopener noreferrer' }, t('upd.openSignIn'))] : null]));
  } else if (u.worker?.pending) {
    out.push(card(u.worker.needsLogin ? signIn()
      : [infoRow(t('upd.yourService'), t('upd.notUpdatedYet')), actionRow(t('upd.tryAgain'), () => updateAction('worker'), { help: t('upd.tryAgainServiceHelp') })]),
    foot(localText(u.worker.message)));
  }
  if (u.login?.message && !u.login.running) out.push(foot(localText(u.login.message), { alert: true }));
  if (u.result && !u.result.ok && !run) {
    out.push(card(infoRow(u.result.version ? t('upd.updateTo', { version: u.result.version }) : t('upd.theLast'), u.result.held ? t('upd.waiting') : t('upd.didNotInstall'), null, { dot: true }),
      u.result.needsLogin ? signIn() : actionRow(t('upd.tryAgain'), () => updateAction('now'), { help: t('upd.tryAgainHelp') })),
    foot([u.result.message, u.result.next].filter(Boolean).map(localText).join(' '), { alert: true }));
  }
  out.push(card(switchRow(t('upd.auto'), !!u.auto, (on) => updateAction('auto', { on }), { help: t('upd.autoHelp') })), foot(t('upd.autoHelp')));
  if (ui.local.cloud) out.push(...serviceUpdateSettings());
  return out;
}
async function updateAction(kind, body = {}) {
  try { ui.local.update = await api(`local/update/${kind}`, body); } catch (e) { toast(e.message); }
  render();
}

// ---- the sync service updating itself (worker/src/selfupdate.js): on the phone through its own Worker, in the
// Linux/macOS window through the local server (which calls the Worker with this computer's key)
const svcApi = (path, body) => api(ui.local ? `local/worker-update${path}` : `update${path}`, body);
/** Whether the sync service is new enough to update itself (an older one gets it with its next update from a computer). */
function serviceCanSelfUpdate() {
  const a = ui.local ? ui.local.cloud?.workerApi : store.meta.serverApi;
  return !Number.isInteger(a) || a >= SELF_UPDATE_API;
}
async function loadServiceUpdate() {
  if (!(ui.local ? ui.local.cloud : store.meta.token) || !serviceCanSelfUpdate()) return;
  try { ui.svc = await svcApi(''); ui.svcError = ''; } catch (e) { ui.svcError = e.message; }
  if (ui.view !== 'list' && !ui.editing && els.sheetWrap.hidden) requestRender();
  // follow a run until it ends
  clearTimeout(ui.svcTimer);
  if (ui.svc?.running && ui.view === 'updates') ui.svcTimer = setTimeout(loadServiceUpdate, 3000);
}
const SVC_STEPS = { checking: 'common.checking', downloading: 'svc.downloading', uploading: 'svc.uploading', switching: 'svc.switching' };
/** How the sync service's updates stand: the Updates row's value (short) and in words (text). */
function serviceSummary() {
  const s = ui.svc;
  const v = s?.version ?? store.meta.serverVersion ?? '';
  if (!serviceCanSelfUpdate() || !s) return { short: v, text: v ? t('svc.runs', { version: v }) : t('svc.yourService') };
  if (s.running) return { short: t('upd.updating'), text: t('svc.updatingText') };
  if (s.last && !s.last.ok) return { short: t('svc.didNotUpdate'), text: t('svc.lastDidNotFinish'), dot: true };
  if (!s.token) return { short: v, text: t('svc.runsFromComputer', { version: v }) };
  return { short: s.auto ? t('upd.automatic') : t('upd.manual'), text: t(s.auto ? 'svc.runsAuto' : 'svc.runs', { version: v }) };
}
/** Updates > Your sync service: its version; giving it a token, or how updating itself stands, Update now, its log. */
function serviceUpdateSettings() {
  const out = [head(ui.local ? t('upd.yourService') : t('svc.head'))];
  const s = ui.svc;
  if (!serviceCanSelfUpdate()) {
    const v = ui.local ? ui.local.cloud?.workerVersion : store.meta.serverVersion;
    out.push(card(infoRow(t('about.version'), v || t('svc.anOlderOne'))), foot(t('svc.tooOld')));
    return out;
  }
  if (!s) {
    out.push(card(infoRow(t('about.version'), store.meta.serverVersion || '')), ui.svcError ? foot(t('svc.couldNotAsk', { error: ui.svcError }), { alert: true }) : null);
    return out;
  }
  const version = infoRow(t('about.version'), s.version);
  if (!s.knowsItself) {
    out.push(card(version), foot(t('svc.notKnowsItself')));
    return out;
  }
  if (!s.token) {
    out.push(card(version, actionRow(t('svc.letItUpdate'), () => tokenSheet(s), { help: t('svc.help'), fk: 'svc-token' })), foot(ui.local ? t('svc.noTokenFootLocal') : t('svc.noTokenFoot')));
    return out;
  }
  const newer = s.latest && s.latest !== s.version && !s.running ? s.latest : '';
  const state = s.running ? (SVC_STEPS[s.running] ? t(SVC_STEPS[s.running]) : t('upd.updating')) : newer ? t('upd.availableShort', { version: newer }) : s.checkedAt ? t('upd.upToDate') : t('upd.notChecked');
  out.push(card(
    version,
    infoRow(t('sync.status'), state, null, { dot: !!newer, long: true, title: state }),
    actionRow(t('upd.now'), serviceUpdateNow, { help: t('svc.nowHelp'), fk: 'svc-now' }),
    switchRow(t('svc.auto'), s.auto, async (on) => { try { ui.svc = await svcApi('/auto', { on }); } catch (e) { toast(e.message); } render(); },
      { help: t('svc.autoHelp'), fk: 'svc-auto' }),
  ));
  const last = s.last && !s.running ? s.last : null;
  const looks = s.checkedAt ? t(s.auto ? 'svc.checkedAuto' : 'svc.checkedManual', { ago: ago(s.checkedAt) }) : t(s.auto ? 'svc.looksAuto' : 'svc.looksManual');
  out.push(foot(last && !last.ok ? last.message : last ? `${last.message} ${looks}` : looks, { alert: !!(last && !last.ok) }));
  // what it did, and the token, under Advanced
  const open = ui.svcOpen;
  out.push(card(
    h('button', { class: 'g-row link', 'aria-expanded': String(!!open), dataset: { fk: 'svc-advanced' }, onclick: () => { ui.svcOpen = !open; render(); } }, rowParts(t('svc.advanced'), { trailing: chevron() })),
    open ? actionRow(t('svc.removeToken'), confirmRemoveToken, { danger: true, help: t('svc.removeTokenHelp') }) : null,
  ));
  if (open) {
    const lines = (s.log ?? []).map((l) => `${dateText(l.at, { dateStyle: 'short', timeStyle: 'short' })}  ${l.text}`);
    out.push(lines.length ? h('pre', { class: 'setup-log', 'aria-label': t('svc.log') }, lines.join('\n')) : foot(t('svc.nothingYet')));
    out.push(foot(t(ui.local ? 'svc.tokenFootComputer' : 'svc.tokenFootDevice', { worker: s.worker || t('svc.yourWorker') })));
  }
  return out;
}
async function serviceUpdateNow() {
  try {
    ui.svc = await svcApi('/now', {});
    announce(t('svc.looking'));
  } catch (e) { toast(e.message); }
  render();
  clearTimeout(ui.svcTimer);
  ui.svcTimer = setTimeout(loadServiceUpdate, 3000);
}
function confirmRemoveToken() {
  sheet(t('svc.removeTitle'), [
    h('p', {}, t('svc.removeWhat')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')),
      h('button', { class: 'btn primary', onclick: async () => {
        closeSheet();
        try { ui.svc = await svcApi('/token', { token: '' }); toast(t('svc.removed')); } catch (e) { toast(e.message); }
        render();
      } }, t('btn.remove'))),
  ]);
}
/** Making the token on Cloudflare's page (prefilled) and pasting it here; the sync service checks it before it keeps it. */
function tokenSheet(s) {
  const input = h('input', {
    class: 'field', type: 'password', placeholder: t('token.placeholder'), 'aria-label': t('token.label'), autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterKeyHint: 'done',
  });
  const msg = h('p', { class: 'g-foot alert', role: 'status' });
  const save = async () => {
    const token = input.value.trim();
    if (!token) { input.focus(); return; }
    btn.disabled = true;
    msg.textContent = t('token.checking');
    try {
      ui.svc = await svcApi('/token', { token });
      closeSheet();
      toast(t('token.saved'));
      render();
    } catch (e) { msg.textContent = e.message; btn.disabled = false; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  const btn = h('button', { class: 'btn primary', onclick: save }, t('btn.save'));
  const paste = navigator.clipboard?.readText ? h('button', { class: 'btn', onclick: async () => { try { input.value = (await navigator.clipboard.readText()).trim(); } catch { toast(t('common.pasteIntoBox')); } } }, t('btn.paste')) : null;
  sheet(t('token.title'), [
    h('p', {}, t('token.what')),
    h('ol', { class: 'steps' },
      h('li', {}, `${t('token.step1')} `, h('a', { href: s.tokenUrl, target: '_blank', rel: 'noopener noreferrer' }, t('token.openCloudflare'))),
      h('li', {}, t('token.step2')),
      h('li', {}, t('token.step3'))),
    h('div', { class: 'field-row' }, input, paste),
    msg,
    h('p', { class: 'sheet-note' }, t('token.noPermission')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')), btn),
  ]);
}

/** The pairing link and a fresh one-time code: from the local app (Linux/macOS window) or this device's own key. */
async function pairingInfo() {
  if (ui.local) return api('local/pairing');
  const server = store.meta.server || location.origin;
  let code = null;
  try { code = (await api('pair/code', {})).code; } catch { /* offline, or a sync service from before codes */ }
  return { link: `${server.replace(/\/+$/, '')}/#pair=${store.meta.token}`, code };
}

/** "ABCD-EFGH, works once, for 10 minutes" in large type */
const codeBlock = (code) => h('div', { class: 'pair-code' },
  h('span', { class: 'code', 'aria-hidden': 'true' }, code),
  h('span', { class: 'sr-only' }, t('pair.codeSr', { code: code.replace('-', '').split('').join(' ') })),
  h('span', { class: 'hint' }, t('pair.codeHint')));

async function showPairing() {
  try {
    const { link, code } = await pairingInfo();
    if (!link) { toast(t('pair.notSetUp')); return; }
    const { qrMatrix, qrToSvg } = await import('./qr.js');
    const svg = qrToSvg(qrMatrix(link, 'M'), { margin: 4, scale: 6 });
    sheet(t('pair.title'), [
      h('img', { class: 'qr', alt: t('pair.qr'), src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }),
      h('p', {}, t('pair.scan')),
      code ? h('p', {}, t('pair.iphoneCode')) : null,
      code ? codeBlock(code) : null,
      h('p', {}, t('pair.keepPrivate')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => copyText(link, t('common.linkCopied')) }, t('ai.copyLink')),
        h('button', { class: 'btn primary', onclick: closeSheet }, t('btn.done'))),
    ]);
  } catch (e) { toast(t('pair.couldNotShow', { error: e.message })); }
}

/** iPhone Safari, just paired by the link: the Home Screen app has storage of its own, so hand it a code. */
async function showHomeScreenStep() {
  const { link, code } = await pairingInfo();
  sheet(t('pair.homeTitle'), [
    h('ol', { class: 'steps' },
      h('li', {}, richText('pair.homeStep1')),
      h('li', {}, code ? t('pair.homeStep2Code') : t('pair.homeStep2Link'))),
    code ? codeBlock(code) : null,
    h('p', {}, code ? t('pair.expired') : t('pair.keepPrivate')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => copyText(link, t('common.linkCopied')) }, t('ai.copyLink')),
      h('button', { class: 'btn primary', onclick: closeSheet }, t('btn.done'))),
  ]);
}

async function loadLocalInfo() {
  if (!store.meta.token) return;
  try {
    const cfg = await api('config');
    const was = JSON.stringify(ui.local);
    const sharesWere = JSON.stringify([ui.local?.shares, ui.local?.sharedByMe, ui.local?.notices]);
    ui.local = cfg.local ?? null;
    if (ui.local) reportLanguage();   // (the Linux/macOS app's notifications are in this window's language)
    if (JSON.stringify(ui.local) !== was && ui.view !== 'list' && !ui.editing) requestRender();
    // lists shared with this computer (and by it) change the lists, their badges and what can be edited: everywhere
    else if (JSON.stringify([ui.local?.shares, ui.local?.sharedByMe, ui.local?.notices]) !== sharesWere) requestRender();
    for (const x of ui.local?.rewritten ?? []) {
      if (ls.get(`rewritten.${x.name}.${x.at}`)) continue;
      ls.set(`rewritten.${x.name}.${x.at}`, '1');
      toast(t('local.rewrittenToast', { name: x.name }));
    }
    for (const ended of ui.local?.ended ?? []) {
      if (ls.get(`ended.${ended.id}`)) continue;
      ls.set(`ended.${ended.id}`, '1');
      store.dispatchEvent(Object.assign(new Event('shareended'), { detail: ended }));
    }
    // a saqme://join link this computer was asked to open (`saqme invite`): ask here, once
    const inv = ui.local?.invite && parseInviteLink(ui.local.invite.link);
    if (inv && !ls.get(`invite.${inv.code.slice(0, 12)}`) && els.sheetWrap.hidden) {
      ls.set(`invite.${inv.code.slice(0, 12)}`, 'offered');
      api('local/invite/decline', {}).catch(() => {});
      confirmJoin(ui.local.invite.link, inv);
    }
  } catch { /* offline or not ours: keep what we had */ }
}

/** #claim=<code> from `saqme open`: the local app hands this window its key once. */
async function readClaimLink() {
  const m = /^#claim=([A-Za-z0-9_-]{16,})(?:&task=([0-9a-z]{8,32}))?$/.exec(location.hash);   // (&task: a tapped reminder opened this window)
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  try {
    const res = await fetch('api/local/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: m[1] }) });
    const data = await res.json();
    if (!res.ok) throw new Error(serverMessage(data, res.status));
    if (data.token !== store.meta.token) { store.pair(data.token); ui.welcomeSkipped = true; }
    if (m[2]) openReminderTask(m[2]);
  } catch (e) { toast(t('local.couldNotConnect', { error: e.message })); }
}

function copyText(text, done) {
  navigator.clipboard?.writeText(text).then(() => toast(done), () => toast(text));
}

// ---------------------------------------------------------------- export / import
async function exportLists() {
  const { files, order } = store.exportLists();
  if (!files.length) { toast(t('lists.nothingToExport')); return; }
  const zip = await makeZip([...files, { name: '.order', text: `${order.join('\n')}\n` }]);
  const name = `saqme-lists-${new Date().toISOString().slice(0, 10)}.zip`;
  const file = new File([zip], name, { type: 'application/zip' });
  // phones: the share sheet (Save to Files, send to a computer); elsewhere: a download
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  toast(t('common.savedFile', { name }));
}

function importLists() {
  const input = h('input', { type: 'file', multiple: true, accept: '.md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip' });
  input.addEventListener('change', async () => {
    try {
      const lists = [];
      let order = [];
      for (const f of input.files) {
        if (/\.zip$/i.test(f.name) || f.type === 'application/zip') {
          for (const e of await readZip(new Uint8Array(await f.arrayBuffer()))) {
            if (e.name === '.order') order = e.text.split(/\r?\n/).filter(Boolean);
            else if (/\.(md|markdown)$/i.test(e.name) && !e.name.startsWith('.')) lists.push(e);
          }
        } else if (!f.name.startsWith('.')) lists.push({ name: f.name, text: await f.text() });
      }
      if (!lists.length) { toast(t('lists.noneFound')); return; }
      const rank = (n) => { const i = order.indexOf(n.replace(/\.(md|markdown)$/i, '')); return i < 0 ? order.length : i; };
      lists.sort((a, b) => rank(a.name) - rank(b.name));
      const r = store.importLists(lists);
      const done = t(r.projects ? 'import.tasksAndLists' : 'import.tasks', { tasks: tn('import.nTasks', r.added), lists: tn('import.nNewLists', r.projects) });
      toast(r.skipped ? `${done} ${tn('import.skipped', r.skipped)}` : done);
      render();
    } catch (e) { toast(t('import.failed', { error: e.message })); }
  });
  input.click();
}

function confirmUnpair() {
  sheet(t('sync.unpairTitle'), [
    h('p', {}, t('sync.unpairHelp')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')),
      h('button', { class: 'btn primary', onclick: async () => { closeSheet(); await disablePush(); store.unpair(); store.setMeta({ server: '' }); render(); } }, t('sync.unpairButton'))),
  ]);
}

function localCounts() {
  return { lists: store.projects().length, tasks: store.tasks().filter((t) => !t.fields.deleted.v).length };
}

/** Pairing uploads everything on this device to the server in the link: say where, and what, first. */
function confirmSyncWith(server, onYes) {
  const host = new URL(server).host;
  const { lists, tasks } = localCounts();
  const what = t('syncWith.what', { lists: tn('syncWith.yourLists', lists), tasks: tn('import.nTasks', tasks) });
  sheet(t('syncWith.title', { host }), [
    h('p', {}, tasks ? t('syncWith.uploads', { what, host }) : t('syncWith.shows', { host })),
    h('p', {}, t('syncWith.ownOnly')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')),
      h('button', { class: 'btn primary', onclick: () => { closeSheet(); onYes(); } }, t('syncWith.sync'))),
  ]);
}

/** A pairing code -> the key, from the sync service that served this copy of the app. */
async function claimCode(code, input) {
  let res = null;
  let data = null;
  try {
    res = await fetch('api/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    data = await res.json();
  } catch { /* offline, or no sync service here */ }
  if (!res) { toast(t('common.noConnection')); return; }
  if (!data || !(data.token || data.error)) { input.classList.add('bad'); toast(t('pair.codesHereOnly')); return; }
  // (the sync service's own words, in this app's language: a wrong or used-up code is a 400)
  if (!res.ok) { input.classList.add('bad'); toast(res.status === 400 ? t('server.pairCodeBad') : serverMessage(data, res.status)); return; }
  pair(data.token);
}

/** The pairing code (or link) box and what pairs with it: on the welcome screen, and in Settings > Sync & sharing. */
function pairingControls(cls) {
  const input = h('input', { class: cls, placeholder: t('pair.inputLabel'), 'aria-label': t('pair.inputLabel'), autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, enterKeyHint: 'go', dataset: { fk: 'pair-input' } });
  const submit = () => {
    const code = normalizePairingCode(input.value);
    if (code) {
      if (localCounts().tasks) confirmSyncWith(location.origin, () => claimCode(code, input)); else claimCode(code, input);
      return;
    }
    // a link to the Worker's own address pairs this copy of the app with it, wherever this copy is served from
    const p = parsePairingLink(input.value, location.origin);
    if (!p) { input.classList.add('bad'); toast(t('pair.badInput')); return; }
    if (!p.server && !localCounts().tasks) { pair(p.key); return; }   // this app's own server, nothing to upload yet
    confirmSyncWith(p.server || location.origin, () => pair(p.key, p.server));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => input.classList.remove('bad'));
  return { input, submit };
}
function pairingField() {
  const { input, submit } = pairingControls('field');
  return h('div', { class: 'field-row' }, input, h('button', { class: 'btn primary', onclick: submit }, t('pair.pair')));
}
/** The same, as a row of a card. */
function pairingRow() {
  const { input, submit } = pairingControls('g-input');
  return inputRow(input, textButton(t('pair.pair'), submit, { name: t('ai.pairDevice'), fk: 'pair-go' }));
}

// ---------------------------------------------------------------- notifications (Web Push)
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * Where this device stands with notifications, for Settings > Notifications: state (unsupported, install, unpaired,
 * blocked, on, off), short (the row's value) and help (the footnote: what to do, or what it means).
 */
function pushState() {
  // (text: how it stands, inside a sentence: the Settings row's help)
  if (!pushSupported()) {
    return { state: 'unsupported', short: t('notif.notAvailable'), text: t('notif.notAvailableLower'), help: isIOS() && !isStandalone() ? t('notif.iphoneInstalledOnly') : t('notif.unsupported') };
  }
  const browserOnly = !store.meta.token && browserShares().length > 0;   // reminders from the lists' owner's server
  if (!store.meta.token && !browserOnly) {
    return { state: 'unpaired', short: t('notif.needSync'), text: t('notif.needSyncLower'), help: t('notif.unpairedHelp') };
  }
  if (Notification.permission === 'denied') return { state: 'blocked', short: t('notif.blocked'), text: t('notif.blockedLower'), help: t('notif.blockedHelp') };
  if (Notification.permission === 'granted' && ls.get('push') === '1') {
    return { state: 'on', short: t('common.on'), text: t('common.onLower'), help: browserOnly ? t('notif.onShared') : t('notif.onDevice') };
  }
  if (isIOS() && !isStandalone()) return { state: 'install', short: t('common.off'), text: t('common.offLower'), help: t('notif.installFirst') };
  return { state: 'off', short: t('common.off'), text: t('common.offLower'), help: browserOnly ? t('notif.offShared') : t('notif.offHelp') };
}

/** The lists used here in the browser from their owner's address (no sync of one's own). */
const browserShares = () => (ui.local ? [] : store.shares().filter((s) => s.via === 'direct'));

/**
 * Reminders for those lists come from their owner's server: a push subscription made with each list's key, with this
 * phone's time zone and summary time (sent again when either changes). Only while this app has no sync of its own:
 * paired, its own server reminds of them (worker/src/remotes.js).
 */
async function syncSharePush({ quiet = true } = {}) {
  if (store.meta.token || ls.get('push') !== '1' || !pushSupported() || Notification.permission !== 'granted') return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const notifyAt = store.setting('notifyAt', '10:00');
  const language = lang();   // (the reminders' language)
  for (const s of browserShares()) {
    if (s.push?.endpoint && s.push.tz === tz && s.push.notifyAt === notifyAt && s.push.lang === language) continue;
    try {
      const reg = await navigator.serviceWorker.ready;
      const cfg = await store.shareCall(s, 'config');
      if (!cfg.vapidPublicKey) throw new Error(t('notif.shareNoKeys'));
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
      await store.shareCall(s, 'push/subscribe', { subscription: sub.toJSON(), tz, notifyAt, lang: language });
      s.push = { endpoint: sub.endpoint, tz, notifyAt, lang: language };
      store.setMeta({ shares: store.shares() });
    } catch (e) { if (!quiet && !e.ended) throw e; }
  }
}

function b64ToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function api(path, body) {
  path = store.apiUrl(path.replace(/^\/?api\//, ''));
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${store.meta.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverMessage(data, res.status));
  return data;
}

/** A server's error in this app's language when it is one the app knows (worker/src/index.js), else its own words. */
function serverMessage(data, status) {
  if (data?.error === 'revoked') return t('server.revoked');
  if (data?.error === 'transferred') return t('server.transferred');
  if (data?.code === 'schema') return t('server.schema');
  if (data?.error === 'this link has expired - open Saqme again') return t('server.claimExpired');   // (local/server.mjs)
  return localText(data?.message || data?.error) || `HTTP ${status}`;
}

// The Linux/macOS app's own messages (local/saqme.mjs, updater.mjs, claude-desktop.mjs) come in English, as they also go
// to its command line and log: the ones this window shows are said in its language here; anything else as it came.
const LOCAL_MESSAGES = [
  [/^(?<n>\d+) tasks disappeared from the lists folder at once\. Deleting them everywhere is paused: restore them, or delete them \(Settings > Sync & sharing\)\.$/, 'local.msg.guarded'],
  [/^The server refused a change \((?<why>.*)\)\.$/, 'local.msg.refused'],
  [/^Offline - changes are kept and sent later \((?<why>.*)\)$/, 'local.msg.offline'],
  [/^Sync failed: (?<why>.*)$/, 'local.msg.failed'],
  [/^The update to (?<version>\S+) did not install: (?<why>.*)$/, 'local.msg.notInstalled'],
  [/^Saqme (?<version>\S+) keeps running\. It is tried again later\.$/, 'local.msg.keepsRunning'],
  [/^The sign-in did not finish\.$/, 'local.msg.signInUnfinished'],
  [/^Updated to (?<version>\S+), your sync service too\.$/, 'local.msg.updated'],
  [/^Sign in to Cloudflare to finish the update of your sync service\.$/, 'local.msg.signIn'],
  [/^Your sync service could not be updated yet \((?<why>.*)\)\.$/, 'local.msg.serviceNotYet'],
  [/^Sharing needs cloud sync \(Settings, Sync & sharing, Set up sync\)\.$/, 'local.msg.needsCloud'],
  [/^This list is not on your sync service yet\. Wait a moment for it to sync, then try again\.$/, 'local.msg.notOnService'],
  [/^Your sync service can update itself once sync is set up \(Settings, Sync & sharing\)\.$/, 'local.msg.selfUpdateNeedsSync'],
  [/^Connecting an AI app needs sync \(Settings, Sync & sharing\)\.$/, 'local.msg.aiNeedsSync'],
  [/^There is no such backup\.$/, 'local.msg.noBackup'],
  [/^Claude Desktop's settings file is not plain JSON \(it may have a comment or a typo in it\), so Saqme left it alone\.$/, 'local.msg.claudeNotJson'],
  [/^Claude Desktop's settings file does not look as expected, so Saqme left it alone\.$/, 'local.msg.claudeOdd'],
  [/^Claude Desktop's settings file has an unexpected "mcpServers" part, so Saqme left it alone\.$/, 'local.msg.claudeMcp'],
  [/^Claude Desktop is not installed on this computer\.$/, 'local.msg.claudeMissing'],
];
function localText(msg) {
  if (!msg || lang() === 'en') return msg;
  for (const [re, key] of LOCAL_MESSAGES) {
    const m = re.exec(msg);
    if (m) return t(key, { ...m.groups, why: m.groups?.why && localText(m.groups.why) });
  }
  return msg;
}

async function enablePush() {
  // must be the first await-free call inside the tap handler, or iOS refuses to ask
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { toast(t('notif.notAllowed')); render(); return; }
  if (!store.meta.token) {
    try {
      ls.set('push', '1');
      await syncSharePush({ quiet: false });
      toast(t('notif.turnedOn'));
    } catch (e) { ls.set('push', '0'); toast(t('notif.couldNotEnable', { error: e.message })); }
    render();
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const cfg = await api('/api/config');
    if (!cfg.vapidPublicKey) throw new Error(t('notif.serverNoKeys'));
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
    await api('/api/push/subscribe', { deviceId: store.meta.deviceId, subscription: sub.toJSON(), lang: lang() });
    ls.set('push', '1');
    syncTimeZone();
    toast(t('notif.turnedOn'));
  } catch (e) {
    toast(t('notif.couldNotEnable', { error: e.message }));
  }
  render();
}

async function disablePush() {
  ls.set('push', '0');
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      if (store.meta.token) await api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      for (const s of browserShares().filter((x) => x.push)) {
        await store.shareCall(s, 'push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        delete s.push;
      }
      store.setMeta({ shares: store.shares() });
      await sub.unsubscribe();
    }
  } catch { /* already gone */ }
}

async function testPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const viaShare = !store.meta.token && browserShares().find((s) => s.push);
    const r = viaShare ? await store.shareCall(viaShare, 'push/test', { endpoint: sub?.endpoint, lang: lang() }) : await api('/api/push/test', { endpoint: sub?.endpoint, lang: lang() });
    toast(r.sent ? t('notif.testSent') : t('notif.testNotSubscribed'));
  } catch (e) { toast(t('notif.testFailed', { error: e.message })); }
}

/** The phone's time zone drives the server's reminder clock (only when this device gets the pushes). */
function syncTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && ls.get('push') === '1' && store.setting('tz') !== tz) store.setSetting('tz', tz);
  reportLanguage();
}

/**
 * The language of the reminders (the synced setting lang: the Worker's cron, the Linux/macOS app's notifications) is
 * the one of the device that gets them. Written when this device's language changes (or the setting is empty), not
 * whenever it differs: two devices in different languages would take turns overwriting it with every sync.
 */
function reportLanguage() {
  if (!ui.local && !(store.meta.token && ls.get('push') === '1')) return;
  if (ls.get('langReported') === lang() && store.setting('lang')) return;
  store.setSetting('lang', lang());
  ls.set('langReported', lang());
}

// ---------------------------------------------------------------- trash + conflicts
/** Recently deleted: lists first, then the tasks under the name of the list they were in; each row with Restore. */
function trashPage() {
  const items = store.trash();
  if (!items.length) return [note(t('trash.empty'))];
  const row = (r, label) => {
    const project = r.kind === 'project';
    const when = ago(r.fields.deleted.ts);
    const from = project ? t('trash.aList') : t('trash.from', { list: store.get('project', r.fields.place.v.project)?.fields.name.v ?? t('trash.goneList') });
    const restore = textButton(t('trash.restore'), () => { if (project) store.restoreProject(r.id); else store.restoreTask(r.id); toast(t('trash.restored')); },
      { name: t('trash.restoreName', { label }), help: t('trash.fromDeleted', { from, when }), fk: `restore:${r.id}` });
    return infoRow(label, when, restore, { title: t('trash.rowTitle', { label, from, when }) });
  };
  const out = [];
  const lists = items.filter((r) => r.kind === 'project');
  if (lists.length) out.push(head(t('list.lists')), card(lists.map((r) => row(r, r.fields.name.v))));
  const byList = new Map();
  for (const r of items.filter((x) => x.kind !== 'project')) {
    const pid = r.fields.place.v.project;
    if (!byList.has(pid)) byList.set(pid, []);
    byList.get(pid).push(r);
  }
  for (const [pid, tasks] of byList) out.push(head(store.get('project', pid)?.fields.name.v ?? t('trash.otherLists')), card(tasks.map((r) => row(r, r.fields.text.v || t('task.untitled')))));
  out.push(foot(t('trash.foot')));
  return out;
}

// ---------------------------------------------------------------- Settings > Your lists > Backups (the Linux/macOS window)
// Copies of the lists the app makes by itself (local/engine.mjs newBackup, docs/sync.md "Backups"); bringing one back
// only adds what is missing now (backupRestorePlan) and changes nothing else. The Windows app has the same page.
const BACKUP_REASONS = ['start', 'daily', 'update', 'delete', 'restore'];
const backupReason = (r) => (BACKUP_REASONS.includes(r) ? t(`backup.reason.${r}`) : r);
const backupTime = (at) => dateText(at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
async function loadBackups() {
  try { ui.backups = await api('local/backups'); } catch (e) { ui.backups = { dir: '', backups: [] }; toast(t('backup.couldNotRead', { error: e.message })); }
  if (ui.view === 'backups') requestRender();
}
function backupsPage() {
  if (!ui.local) return [note(t('backup.desktopOnly'))];
  if (!ui.backups) { loadBackups(); return [note(t('backup.reading'))]; }
  const about = t('backup.about');
  const all = ui.backups.backups.slice(0, 20);
  if (!all.length) return [note(t('backup.none')), foot(about)];
  return [
    head(t('backup.head')),
    card(all.map((b) => actionRow(backupTime(b.at), () => restoreBackup(b), {
      value: t('backup.value', { lists: tn('backup.nLists', b.lists), reason: backupReason(b.reason) }), name: t('backup.restoreName', { time: backupTime(b.at) }), fk: `backup:${b.name}`,
    }))),
    foot(`${about} ${t('backup.where', { dir: ui.backups.dir })}`),
  ];
}
async function restoreBackup(b) {
  let r;
  try { r = await api('local/backups/restore', { name: b.name, dryRun: true }); } catch (e) { toast(t('backup.couldNotReadOne', { error: e.message })); return; }
  if (r.busy) { toast(t('backup.busy')); return; }
  if (!r.tasks && !r.lists.length) { toast(t('backup.nothingMissing')); return; }
  const what = [r.lists.length ? tn('backup.whatLists', r.lists.length, { names: r.lists.join(', ') }) : '', tn('backup.whatTasks', r.tasks)].filter(Boolean).join(', ');
  sheet(t('backup.confirmTitle', { time: backupTime(b.at) }), [
    h('p', {}, t('backup.confirmText', { what })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, t('btn.cancel')),
      h('button', { class: 'btn primary', onclick: async () => {
        closeSheet();
        try { const done = await api('local/backups/restore', { name: b.name }); toast(done.busy ? t('backup.changed') : t('backup.done', { what })); } catch (e) { toast(t('backup.failed', { error: e.message })); }
        ui.backups = null;
        if (ui.view === 'backups') requestRender();
      } }, t('backup.bringBack'))),
  ]);
}

function describe(field, v) {
  if (field === 'status') return t(`status.${statusOf(v).key}`);
  if (field === 'due') return v ? dueLongText(v) : t('conflict.noDeadline');
  if (field === 'deleted') return v ? t('conflict.deleted') : t('conflict.kept');
  return v || t('conflict.empty');
}

const FIELDS = ['text', 'status', 'due', 'notes', 'deleted', 'new'];
/** Changes a shared list's server did not take (the list became view-only, or its owner deleted it). */
function allNotices() { return [...store.notices(), ...(ui.local?.notices ?? [])]; }

/** A version of a task in Conflicts: your own words, so it wraps instead of being cut (a phone has no tooltips). */
const versionRow = (label, value) => h('div', { class: 'g-row version' }, h('span', { class: 'g-lead' }, label), h('span', { class: 'g-text' }, value));

/**
 * Conflicts: one card per task, under its text. What a shared list's server did not take (your version, Copy, Dismiss),
 * then what was changed on two devices at once (now, the other version, Keep now / Use other).
 */
function conflictsPage() {
  const list = store.conflicts();
  const notices = allNotices();
  if (!list.length && !notices.length) return [note(t('conflict.none'))];
  const out = [];
  for (const n of notices) {
    const p = store.get('project', n.projectId);
    const what = FIELDS.includes(n.field) ? t(`conflict.fieldLower.${n.field}`) : n.field;
    const value = n.field === 'deleted' ? t('conflict.deleted') : describe(n.field, n.value);
    const why = n.reason === 'this shared list is view-only' ? t('conflict.viewOnly') : t('conflict.refused', { reason: n.reason });
    out.push(head(n.text || t('task.untitled')), card(
      versionRow(t('conflict.yourVersion'), value),
      actionRow(t('btn.copy'), () => copyText(String(n.field === 'deleted' ? n.text : value), t('conflict.copied')), { name: t('conflict.copyName'), fk: `copy:${n.id}` }),
      actionRow(t('conflict.dismiss'), async () => {
        if (n.local) { try { await api('local/notices/dismiss', { id: n.id }); await loadLocalInfo(); } catch (e) { toast(e.message); } } else store.dismissNotice(n.id);
        render();
      }, { name: t('conflict.dismissName'), fk: `dismiss:${n.id}` })),
    foot(t('conflict.notSaved', { what, list: p?.fields.name.v ?? n.list ?? t('conflict.aSharedList'), when: ago(n.at), why })));
  }
  for (const c of list) {
    const task = store.get('task', c.task);
    const cur = c.field === 'deleted' ? task.fields.deleted.v : task.fields[c.field]?.v;
    const what = FIELDS.includes(c.field) ? t(`conflict.field.${c.field}`) : c.field;
    const use = c.field === 'deleted' ? (c.value ? t('conflict.deleteIt') : t('conflict.restoreIt')) : t('conflict.useOther');
    out.push(head(task.fields.text.v || t('task.untitled')), card(
      versionRow(t('conflict.now'), describe(c.field, cur)),
      versionRow(t('conflict.otherVersion'), describe(c.field, c.value)),
      actionRow(t('conflict.keepNow'), () => store.resolveConflict(c.id, false), { help: t('conflict.keepNowHelp'), fk: `keep:${c.id}` }),
      actionRow(use, () => store.resolveConflict(c.id, true), { help: c.field === 'deleted' ? '' : t('conflict.useOtherHelp'), fk: `use:${c.id}` })),
    foot(c.field === 'deleted' ? t('conflict.deletedEdited', { when: ago(c.at) }) : t('conflict.changedTwice', { what, when: ago(c.at) })));
  }
  return out;
}

// ---------------------------------------------------------------- welcome / pairing
function showWelcome() {
  return !store.meta.token && !ui.welcomeSkipped && store.projects().length === 0;
}

function renderWelcome() {
  els.addBar.hidden = true;
  const logo = h('img', { src: 'icons/apple-touch-icon.png', alt: '' });
  if (ui.localUnpaired) {
    setListContent([h('div', { class: 'welcome' }, logo, h('h1', {}, 'Saqme To Do'),
      h('p', {}, richText('welcome.localUnpaired')))]);
    return;
  }
  setListContent([h('div', { class: 'welcome' }, logo,
    h('h1', {}, 'Saqme To Do'),
    h('p', {}, t('welcome.intro')),
    h('button', { class: 'btn primary', onclick: () => { ui.welcomeSkipped = true; ls.set('localOnly', '1'); store.addProject('General'); render(); } }, t('welcome.useHere')),
    h('ol', { class: 'steps' },
      h('li', {}, richText('welcome.step1')),
      // (in the installed app the camera would open the link in the browser, not here)
      h('li', {}, isStandalone() ? t('welcome.step2Installed') : t('welcome.step2')),
      isIOS() && !isStandalone() ? h('li', {}, richText('welcome.step3')) : null),
    pairingField(),
    h('p', {}, t('welcome.invite'), ' ', h('button', { class: 'linkish', onclick: () => joinSheet() }, t('welcome.joinIt')), '.'))]);
}

function pair(token, server = '') {
  store.pair(token, server);
  ui.welcomeSkipped = true;
  closeSheet();
  render();
  if (isIOS() && !isStandalone()) showHomeScreenStep(); else toast(t('pair.pairedSyncing'));
}

/** #pair=<token> from the QR link. The fragment never reaches the server. */
function linkId(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function readPairingLink() {
  const m = /^#pair=([A-Za-z0-9_-]{32,})$/.exec(location.hash);
  if (!m) return;
  const token = m[1];
  // out of the address bar (and this history entry) at once. Keeping it there would not help an iPhone either:
  // the Home Screen app starts at the manifest's start_url, so it is paired with a code (showHomeScreenStep).
  history.replaceState(null, '', location.pathname);
  if (token === store.meta.token) return;
  const seen = ls.get(`link.${linkId(token)}`);
  if (!store.meta.token && !seen) {
    ls.set(`link.${linkId(token)}`, 'used');
    if (localCounts().tasks) confirmSyncWith(location.origin, () => pair(token)); else pair(token);
    return;
  }
  if (seen) return;   // a link already used or declined (e.g. an old one after -RotateToken) never re-pairs by itself
  sheet(t('pair.useLinkTitle'), [
    h('p', {}, t('pair.useLinkText')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { ls.set(`link.${linkId(token)}`, 'declined'); closeSheet(); } }, t('pair.keepCurrent')),
      h('button', { class: 'btn primary', onclick: () => { ls.set(`link.${linkId(token)}`, 'used'); pair(token); } }, t('pair.useLink'))),
  ]);
}

// ---------------------------------------------------------------- boot
// the logo opens Settings, and from any Settings view goes back to the list
els.logo.addEventListener('click', () => go(ui.view === 'list' ? 'settings' : 'list'));
els.sync.addEventListener('click', () => {
  commitAll();
  if (store.meta.token && store.status.state !== 'syncing') store.sync({ force: true });
  toast(statusText());
});
els.conflicts.addEventListener('click', () => go('conflicts'));
store.addEventListener('change', () => {
  if (wantedTask) { if (Date.now() > wantedTask.until) wantedTask = null; else openReminderTask(wantedTask.id); }
  requestRender();
});
store.addEventListener('rejected', (e) => {
  const r = e.detail[0];
  const task = r.kind === 'task' ? store.get('task', r.id) : null;
  toast(task ? t('rejected.task', { text: task.fields.text.v.slice(0, 40), reason: r.reason }) : t('rejected.plain', { reason: r.reason }));
});
store.addEventListener('status', () => { renderStatus(); if (ui.view !== 'list' && !ui.editing) requestRender(); });
store.addEventListener('readonly', () => toast(t('share.viewOnlyToast')));
store.addEventListener('shareended', (e) => {
  const { name, kept, elsewhere, gone } = e.detail;
  sheet(t('share.endedTitle', { name }), [
    h('p', {}, t(gone ? 'share.endedGone' : elsewhere ? 'share.endedElsewhere' : kept ? 'share.endedKept' : 'share.endedDeleted')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: closeSheet }, t('btn.ok'))),
  ]);
  render();
});
store.addEventListener('sharemoved', (e) => {
  sheet(t('share.movedTitle', { name: e.detail.name }), [
    h('p', {}, t('share.movedText')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: closeSheet }, t('btn.ok'))),
  ]);
  render();
});
store.addEventListener('savefailed', () => { requestRender(); announce(t('store.saveFailedNow')); });
store.addEventListener('saved', requestRender);
window.addEventListener('hashchange', () => { readPairingLink(); readClaimLink(); readJoinLink(); readTaskLink(); });
// a tap on a deadline reminder while the app is open (sw.js focuses the window and says which task)
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'open-task') openReminderTask(String(e.data.id)); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkClipboardForInvite(); });
window.addEventListener('focus', () => checkClipboardForInvite());
setInterval(() => { if (document.visibilityState === 'visible' && !ui.editing) requestRender(); }, 60_000);   // relative dates

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // (a new sw.js is looked for on every launch; an app left open looks when it comes back)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('service worker', e));
}

// ---------------------------------------------------------------- updates of the app itself
// Its files come from the server that serves it (your Worker, or the Linux/macOS app), and sw.js fetches them
// network-first, so an update there reaches the next launch. A page that stays open (a Home Screen app iOS keeps
// in memory, the desktop window) notices too: when the server says another version than the one this page
// started with, it reloads at the next quiet moment, and then says "Updated". (A copy on a static host has no
// such server: it updates with its next launch.)
let bootVersion = null;
async function watchVersion() {
  let v = null;
  try {
    const r = await fetch('api/health', { cache: 'no-store' });
    if (r.ok) v = (await r.json()).version ?? null;
  } catch { /* offline, or a static host */ }
  if (!v) return;
  if (bootVersion === null) {
    bootVersion = v;
    if (ui.view !== 'list') requestRender();   // (the version line under Settings)
    const was = ls.get('appVersion');
    ls.set('appVersion', v);
    if (was && was !== v) toast(t('app.updatedTo', { version: v }));
    return;
  }
  if (v !== bootVersion && !ui.editing && els.sheetWrap.hidden && document.visibilityState === 'visible') location.reload();   // (it says so after)
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') watchVersion(); });
setInterval(() => { if (document.visibilityState === 'visible') watchVersion(); }, 30 * 60_000);

els.addPlus.append(icon('plus'));
els.addGo.append(icon('check'));
await store.open();
// ask the browser not to clear the lists when space runs low (granted to installed apps, mostly)
navigator.storage?.persist?.().catch(() => {});
readPairingLink();
await readClaimLink();
readJoinLink();
if (!store.meta.token && !store.projects().length) {
  // served by the Linux/macOS app but opened by hand (a bookmark): say how to connect instead of offering sync
  try { ui.localUnpaired = (await (await fetch('api/health', { cache: 'no-store' })).json()).local === true; } catch { /* static host: no API */ }
}
render();
readTaskLink();   // (the app was started by a tap on a deadline reminder)
loadLocalInfo();
checkClipboardForInvite();
// the local app's sync status, while Settings are on screen (a Worker's answer never changes: no polling there)
setInterval(() => { if (ui.local && document.visibilityState === 'visible' && ui.view !== 'list') loadLocalInfo(); }, 5000);
// (and its shared lists, less often, anywhere: access can change, a share can end, an invite link can come in)
setInterval(() => { if (ui.local && document.visibilityState === 'visible' && ui.view === 'list') loadLocalInfo(); }, 3000);
store.startAuto();
syncTimeZone();
syncSharePush();
watchVersion();
