// Saqme To Do — iPhone PWA. Mirrors the desktop widget: project tabs, status chips, collapsible tasks,
// deadlines, notes with links, Postponed section, folded Completed, drag to reorder, move to project.

import { Store, SHARING_API, OLDER_SERVER } from './store.js';
import {
  STATUSES, statusOf, rank, sections, kidsInDisplayOrder, progress, linkify, openCount, subtreeIds, isAncestor,
  cleanText, cleanNotes,   // same cleanup as the server (worker/src/merge.js): saving never changes text by itself
} from './model.js';
import { parseDue, dueLabel, dueLong, dueTone, quickDates } from './dates.js';
import { icon, STATUS_GLYPH } from './icons.js';
import { makeZip, readZip } from './zip.js';
import { parsePairingLink, normalizePairingCode, parseInviteLink, serverLabel } from './pairing.js';

// Inside another site's frame the app does not start: a page could trick taps onto it (clickjacking). The
// Worker forbids framing with a header; a copy on a static host (GitHub Pages) can only do it here.
if (window.top !== window.self) {
  const a = Object.assign(document.createElement('a'), { href: location.href, target: '_blank', rel: 'noopener', textContent: 'Open Saqme To Do' });
  document.body.replaceChildren(a);
  throw new Error('Saqme To Do does not run inside a frame.');
}

const store = new Store();
const $ = (id) => document.getElementById(id);
const els = {
  tabs: $('tabs'), tabAdd: $('tabAdd'), list: $('list'), logo: $('logo'), sync: $('syncBtn'), conflicts: $('conflictsBadge'),
  addBar: $('addBar'), add: $('addInput'), sheetWrap: $('sheetWrap'), sheet: $('sheet'), backdrop: $('sheetBackdrop'),
  toast: $('toast'), announce: $('announce'), app: $('app'),
};
const ls = {
  get: (k, d = '') => { try { return localStorage.getItem(`saqme.${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`saqme.${k}`, v); } catch { /* private mode */ } },
};
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const ui = {
  view: 'list',          // list | settings | one of its pages (PAGES) | keys | trash | conflicts
  focusKey: '',          // the control (data-fk) that gets keyboard focus after the next render (a view just opened)
  advancedOpen: false,   // Settings > Sync & sharing > Advanced
  project: ls.get('project'),
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

function chip(mark) {
  const s = statusOf(mark);
  const g = STATUS_GLYPH[mark];
  return h('span', { class: `chip s-${s.key}` }, g ? icon(g) : null);
}

let toastTimer;
function toast(text, action) {
  clearTimeout(toastTimer);
  els.toast.replaceChildren(...[h('span', {}, text), action && h('button', { onclick: () => { els.toast.hidden = true; action.run(); } }, action.label)].filter(Boolean));
  els.toast.hidden = false;
  announce(action ? `${text}. ${action.label} is available.` : text);
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
  els.tabAdd.hidden = els.sync.hidden = showWelcome();
  renderTabs();
  renderStatus();
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
  return clash ? `${name} (from ${serverLabel(sh.server)})` : name;
}
/** A list used here in the browser from its owner's address (no sync of one's own), not through a sync service. */
const inBrowser = (sh) => !ui.local && sh?.via === 'direct';
const ACCESS = {
  edit: { name: 'Can edit', help: 'They can add, change, check off and delete tasks in this list.' },
  view: { name: 'Can view', help: 'They see the list and its updates, but can\'t change anything.' },
};
const SHARE_NEEDS_SYNC = 'Sharing needs sync with your own Cloudflare account (Settings › Sync & sharing): a shared list lives on your sync service, where the people you share it with sync it from.';
/** A sharing call's error -> what to say: "not updated yet" when one's own sync service is older than sharing. */
function shareError(e) {
  const older = ui.local ? (ui.local.cloud?.workerApi ?? SHARING_API) < SHARING_API : store.olderServer(SHARING_API);
  return older ? OLDER_SERVER : e.message;
}
const canShare = () => (ui.local ? !!ui.local.cloud : !!store.meta.token);

/** The local app's API for the Linux/macOS window, the phone app's own server otherwise. */
const shareApi = {
  list: (pid) => api(ui.local ? `local/shares?project=${pid}` : `shares?project=${pid}`),
  invite: (pid, alias, access) => api(ui.local ? 'local/shares/invite' : 'shares/invite', { projectId: pid, alias, access }),
  update: (id, access) => api(ui.local ? 'local/shares/update' : 'shares/update', { id, access }),
  revoke: (id) => api(ui.local ? 'local/shares/revoke' : 'shares/revoke', { id }),
};

// ---------------------------------------------------------------- tabs
function renderTabs() {
  const cur = currentProject();
  const tasks = store.tasks();
  const tabs = store.projects().map((p) => {
    const n = openCount(tasks, p.id);
    const isCur = cur && p.id === cur.id;
    const sh = sharing(p.id);
    const shTitle = sh?.withMe ? `Shared with you · ${ACCESS[sh.withMe.access]?.name ?? ''}` : sh ? 'Shared' : '';
    const t = h('button', { class: `tab${isCur ? ' active' : ''}`, dataset: { id: p.id, fk: `tab:${p.id}` }, 'aria-current': isCur ? 'page' : null, title: shTitle || null },
      h('span', { class: 'name' }, listName(p)),
      sh ? h('span', { class: 'shared-badge', 'aria-hidden': 'true' }, icon(sh.withMe?.access === 'view' ? 'eye' : 'people')) : null,
      sh ? h('span', { class: 'sr-only' }, `, ${shTitle.toLowerCase()}`) : null,
      n ? h('span', { class: 'count' }, n, h('span', { class: 'sr-only' }, ' open')) : null);
    t.addEventListener('click', () => {
      if (ui.view === 'list' && ui.project === p.id) return;
      ui.view = 'list';
      commitAll();
      ui.project = p.id; ls.set('project', p.id); ui.sel = null;
      render();
      els.list.scrollTop = 0;
    });
    t.addEventListener('dblclick', () => tabMenu(p.id));
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); commitAll(); tabMenu(p.id); });
    onLongPress(t, () => tabMenu(p.id));
    return t;
  });
  els.tabs.replaceChildren(...tabs);
  const active = els.tabs.querySelector('.tab.active');
  if (active && ui.lastActiveTab !== ui.project) {
    ui.lastActiveTab = ui.project;
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function tabMenu(id) {
  const p = store.get('project', id);
  if (!p) return;
  const list = store.projects();
  const i = list.findIndex((x) => x.id === id);
  const moves = [
    i > 0 && menuItem('back', 'Move left', () => store.moveProject(id, -1)),
    i < list.length - 1 && menuItem('chevron', 'Move right', () => store.moveProject(id, 1)),
  ];
  const sh = sharing(id)?.withMe;
  if (sh) {
    // someone else's list: its name and its deletion are theirs; leaving takes it off this device only
    sheet(listName(p), [
      h('p', { class: 'sheet-note' }, `Shared with you from ${hostOf(sh.server)} · ${ACCESS[sh.access]?.name}. ${ACCESS[sh.access]?.help.replace('They', 'You').replace('they', 'you')}`),
      ...moves,
      inBrowser(sh) ? menuItem('share', 'Move to my Saqme app', () => moveToAppSheet(sh), { keepOpen: true }) : null,
      h('div', { class: 'menu-sep' }),
      menuItem('leave', 'Leave this list', () => confirmLeave(id), { danger: true }),
    ]);
    return;
  }
  sheet(p.fields.name.v, [
    canShare() ? menuItem('share', 'Share…', () => shareSheet(id), { keepOpen: true })
      : menuItem('share', 'Share…', () => {}, { disabled: true, hint: 'needs sync', title: SHARE_NEEDS_SYNC }),
    menuItem('edit', 'Rename', () => projectNameSheet(id)),
    ...moves,
    h('div', { class: 'menu-sep' }),
    menuItem('trash', 'Delete project', () => confirmDeleteProject(id), { danger: true }),
  ]);
}

function confirmLeave(projectId, share = null) {
  const p = projectId ? store.get('project', projectId) : null;
  const sh = share ?? sharing(projectId)?.withMe;
  if (!sh) return;
  const where = ui.local ? 'this computer' : inBrowser(sh) ? 'this browser' : 'this app (and your other phones paired with your sync)';
  sheet(`Leave “${p ? listName(p) : sh.name}”?`, [
    h('p', {}, `It goes from ${where}. Nothing changes in the owner's list. To see it here again, you need a new invite.`),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        closeSheet();
        try {
          // (its reminders end with the key, on the owner's server)
          if (ui.local) { await api('local/leave', { id: sh.id }); await loadLocalInfo(); } else store.leaveShare(sh.id);
          toast(`Left “${p?.fields.name.v ?? sh.name}”`);
        } catch (e) { toast(`Could not leave: ${e.message}`); }
        render();
      } }, 'Leave')),
  ]);
}

/** The owner's Share sheet: invite someone (one-time link), see who has it, change or end their access. */
async function shareSheet(projectId) {
  const p = store.get('project', projectId);
  if (!p) return;
  const state = { access: 'edit', invite: null, people: null, error: '', open: null, busy: false };
  const name = h('input', {
    class: 'g-input', placeholder: 'Their name, e.g. Nuca', maxLength: 60, autocapitalize: 'words', 'aria-label': 'Their name',
    'aria-description': 'Only you see it: it is how you recognise them in this list later', enterKeyHint: 'done', dataset: { fk: 'share-name' },
  });
  const draw = () => {
    if (els.sheetWrap.hidden && state.drawn) return;   // closed meanwhile
    state.drawn = true;
    const accessPick = h('div', { class: 'segmented share-access', role: 'group', 'aria-label': 'Access' },
      ...Object.entries(ACCESS).map(([v, a]) => h('button', {
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
      head('Invite someone', 3),
      card(inputRow(name), infoRow('Access', '', accessPick),
        actionRow(state.busy ? 'Creating…' : 'Create invite link', create, { name: 'Create invite link', fk: 'share-create' })),
      foot(`Only you see their name. ${ACCESS[state.access].help} They get a link that works once, for 24 hours; the list stays on your sync service, and they sync it from there with a key that reaches this list only.`),
      state.error ? foot(state.error, { alert: true }) : null,
    ];
    if (state.invite) out.push(...inviteBlock(state.invite));
    out.push(head('Shared with', 3));
    if (!state.people) out.push(note('Loading…'));
    else if (!state.people.length) out.push(note('Nobody yet.'));
    else out.push(card(state.people.map((s) => personRows(s, state, draw, refresh))));
    out.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, 'Done')));
    // (the sheet is rebuilt: keyboard focus stays on the same control)
    const fk = els.sheet.contains(document.activeElement) ? document.activeElement?.dataset?.fk : '';
    sheet(`Share “${p.fields.name.v}”`, out);
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
  const box = h('input', { class: 'g-input', value: inv.link, readOnly: true, 'aria-label': 'Invite link', onfocus: (e) => e.target.select(), dataset: { fk: 'invite-link' } });
  const out = [
    head('Invite link', 3),
    h('div', { class: 'group invite' }, inputRow(box, textButton('Copy', () => copyText(inv.link, 'Invite link copied'), { name: 'Copy the invite link', fk: 'invite-copy' }))),
    foot(`For ${inv.share.alias}, ${ACCESS[inv.share.access].name.toLowerCase()}. It works once, until ${new Date(inv.expiresAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Send it to them yourself (a message, an email): whoever opens it first joins, so send it to them only.`),
  ];
  if (matchMedia('(min-width: 560px) and (pointer: fine)').matches) {
    const img = h('img', { class: 'qr in-group', alt: 'QR code with the invite link', hidden: true });
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
  const when = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const stand = s.state === 'joined' ? `Joined ${when(s.joinedAt)}` : s.state === 'pending' ? `Invited ${when(s.createdAt)}, not joined yet` : 'Invite expired, never used';
  const access = ACCESS[s.access]?.name ?? s.access;
  const value = s.state === 'joined' ? access : s.state === 'pending' ? 'Invited' : 'Expired';
  const open = state.open === s.id;
  const act = async (fn, done) => { try { await fn(); toast(done); } catch (e) { toast(e.message); } await refresh(); };
  const rows = [h('button', {
    class: 'g-row link person', 'aria-expanded': String(open), 'aria-description': `${stand}. Opens their access, and revoke`, title: stand, dataset: { fk: `person:${s.id}` },
    onclick: () => { state.open = open ? null : s.id; draw(); },
  }, rowParts(s.alias, { value, trailing: chevron() }))];
  if (!open) return rows;
  rows.push(h('div', { class: 'g-row sub info' }, h('span', { class: 'g-label' }, stand)));
  if (s.state !== 'expired') {
    for (const [v, a] of Object.entries(ACCESS)) {
      const cur = v === s.access;
      rows.push(h('button', {
        class: 'g-row sub choice', 'aria-pressed': String(cur), 'aria-label': `${a.name} for ${s.alias}`, title: a.help, 'aria-description': a.help,
        dataset: { fk: `access:${s.id}:${v}` }, onclick: () => { if (!cur) act(() => shareApi.update(s.id, v), `${s.alias}: ${a.name.toLowerCase()}`); },
      }, h('span', { class: 'g-label' }, a.name), cur ? h('span', { class: 'check', 'aria-hidden': 'true' }, icon('check')) : null));
    }
  }
  const [label, danger, help, done] = s.state === 'joined'
    ? ['Revoke', true, 'Their key stops working now; the list stays on their device as their own copy.', `${s.alias} no longer has the list`]
    : s.state === 'pending' ? ['Cancel invite', false, '', 'Invite cancelled'] : ['Remove', false, '', 'Removed'];
  rows.push(actionRow(label, () => act(() => shareApi.revoke(s.id), done), { danger, help, name: `${label}: ${s.alias}`, fk: `end:${s.id}`, cls: 'sub' }));
  return rows;
}

/** Join a list someone shares: the invite link pasted (or found on the clipboard). */
function joinSheet(prefill = '') {
  const input = h('input', { class: 'field', value: prefill, placeholder: 'https://…/join#code=…', 'aria-label': 'Invite link', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
  const go = () => {
    const inv = parseInviteLink(input.value);
    if (!inv) { input.classList.add('bad'); toast('That is not an invite link (it looks like https://…/join#code=…).'); return; }
    confirmJoin(input.value.trim(), inv);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  input.addEventListener('input', () => input.classList.remove('bad'));
  const paste = navigator.clipboard?.readText ? h('button', { class: 'btn', onclick: async () => {
    try { input.value = (await navigator.clipboard.readText()).trim(); input.classList.remove('bad'); } catch { toast('Paste it into the field instead.'); }
  } }, 'Paste') : null;
  sheet('Join a shared list', [
    h('p', { class: 'sheet-note' }, ui.local || store.meta.token
      ? 'Paste the invite link someone sent you. The list then shows here as a tab and stays in step with theirs.'
      : 'Paste the invite link someone sent you. Without a sync of your own, this app opens lists of this address only; for any other, open the invite link itself and choose “Use it in this browser” there.'),
    h('div', { class: 'field-row' }, input, paste),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, 'Join')),
  ]);
  if (!prefill) input.focus();
}

/** Says whose server the list comes from before the one-time code is used up. */
function confirmJoin(link, inv) {
  const host = hostOf(inv.server);
  if (!ui.local && !store.meta.token && inv.server !== location.origin) {
    // no sync of its own: this app reaches its own address only (its security policy), so the list opens there
    sheet('Open the invite link instead', [
      h('p', {}, `This list is on ${host}. Without a sync of your own, open the invite link itself: its page has “Use it in this browser”, with nothing to install and no account. Or pair this app with your own sync first (Settings › Sync & sharing), then join here.`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: closeSheet }, 'Not now'),
        h('a', { class: 'btn primary', href: `${inv.server}/join#code=${inv.code}`, rel: 'noreferrer' }, 'Open the invite')),
    ]);
    return;
  }
  const how = ui.local ? 'This computer syncs it with them directly.'
    : store.meta.token ? `Your sync service (${hostOf(store.meta.server || location.origin)}) keeps it in step with theirs for this app and your other phones, and reminds you of its deadlines.`
      : 'It stays in this browser: no account and no sync of your own needed. Later, the list\'s menu can move it to your Saqme app.';
  sheet('Join shared list?', [
    h('p', {}, `A list shared from ${host} shows here as a new tab. ${how} What you change in it goes to ${host}, which belongs to the person who shared it: they (and only they) can see your changes.`),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, 'Not now'),
      h('button', { class: 'btn primary', onclick: async (e) => {
        e.target.disabled = true;
        try {
          if (ui.local) {
            const r = await api('local/join', { link });
            closeSheet();
            const box = document.querySelector('[data-fk="join-input"]');   // (Settings stays open here: empty its box)
            if (box) box.value = '';
            toast(`Joined “${r.name}”. It shows up in a few seconds.`);
            setTimeout(loadLocalInfo, 2500);
          } else {
            const s = await store.joinShare(link);
            closeSheet();
            ui.view = 'list'; ui.project = s.projectId; ls.set('project', s.projectId);
            toast(`Joined “${s.name}”`);
            syncSharePush();
          }
          render();
        } catch (err) { e.target.disabled = false; toast(err.message); }
      } }, 'Join')),
  ]);
}

/**
 * "Move to my Saqme app" (a list used here in the browser): a one-time link for the same share. Another app of this
 * person opens it like an invite and takes the list over (no new invite); this browser then stops syncing it.
 */
async function moveToAppSheet(sh) {
  const p = store.get('project', sh.projectId);
  const title = `Move “${p ? listName(p) : sh.name}” to your Saqme app`;
  sheet(title, [h('p', { class: 'sheet-note', role: 'status' }, 'Getting a link…')]);
  let m;
  try {
    await store.sync({ force: true });   // (what was changed here goes first)
    m = await store.transferShare(sh.id);
  } catch (e) {
    if (e.ended) { closeSheet(); return; }   // (the store says what happened)
    sheet(title, [h('p', {}, `Could not get a link: ${e.message}`), h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: closeSheet }, 'OK'))]);
    return;
  }
  const inv = parseInviteLink(m.link);
  const box = h('input', { class: 'field', value: m.link, readOnly: true, 'aria-label': 'Move link', onfocus: (e) => e.target.select() });
  const block = h('div', { class: 'invite' }, h('div', { class: 'field-row' }, box, h('button', { class: 'btn primary', onclick: () => copyText(m.link, 'Link copied') }, 'Copy')));
  const computer = matchMedia('(pointer: fine)').matches;
  if (computer) {
    import('./qr.js').then(({ qrMatrix, qrToSvg }) => {
      const svg = qrToSvg(qrMatrix(m.link, 'M'), { margin: 4, scale: 5 });
      block.append(h('img', { class: 'qr', alt: 'QR code with the move link', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }));
    }).catch(() => {});
  }
  sheet(title, [
    h('p', {}, 'Your Saqme app takes this list over, with its tasks and your access: no new invite needed. This browser stops syncing it then, and it goes from here.'),
    h('ol', { class: 'steps' },
      h('li', {}, h('b', {}, 'Saqme on this computer: '), 'Open in Saqme To Do (it asks first).'),
      h('li', {}, h('b', {}, 'The phone app: '), 'copy the link, then in Saqme: Settings › Sync & sharing, and paste it under Shared lists.'),
      h('li', {}, h('b', {}, 'Another computer: '), 'send yourself the link and open it there.')),
    block,
    h('p', { class: 'sheet-note' }, `The link works once, until ${new Date(m.expiresAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`),
    h('div', { class: 'btn-row' },
      inv && computer ? h('a', { class: 'btn', href: `saqme://join?server=${encodeURIComponent(inv.server)}&code=${inv.code}` }, 'Open in Saqme To Do') : null,
      h('button', { class: 'btn primary', onclick: closeSheet }, 'Done')),
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
  const input = h('input', { class: 'field', value: p ? p.fields.name.v : '', placeholder: 'Project name', maxLength: 100, enterKeyHint: 'done', autocapitalize: 'words' });
  const save = () => {
    const name = input.value.trim();
    if (!name) { input.classList.add('bad'); return; }
    const clash = store.projects().find((x) => x.id !== id && x.fields.name.v.toLowerCase() === name.toLowerCase());
    if (clash) { input.classList.add('bad'); toast('A project with that name already exists'); return; }
    if (id) store.renameProject(id, name);
    else { const nid = store.addProject(name); if (nid) { ui.project = nid; ls.set('project', nid); ui.view = 'list'; } }
    closeSheet();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  sheet(id ? 'Rename project' : 'New project', [
    h('div', { class: 'field-row' }, input),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, id ? 'Rename' : 'Create')),
  ]);
  input.focus();
  input.select();
}

function confirmDeleteProject(id) {
  const p = store.get('project', id);
  sheet(`Delete “${p.fields.name.v}”?`, [
    h('p', {}, 'Its tasks move to Recently deleted (Settings › Your lists), nothing is erased. You can restore the project from there.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => {
        store.deleteProject(id); closeSheet();
        toast('Project deleted', { label: 'Undo', run: () => store.restoreProject(id) });
      } }, 'Delete')),
  ]);
}

// ---------------------------------------------------------------- sync status + conflicts badge
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });   // (short: it is a row's value)
}

function statusText() {
  const st = store.status;
  const pending = store.pendingCount();
  switch (st.state) {
    case 'unpaired': return browserShares().length ? 'Not paired — the lists shared with you here sync with their owner, your own lists stay on this device' : 'Not paired — changes stay on this device';
    case 'syncing': return 'Syncing…';
    case 'offline': return `Offline${pending ? ` · ${pending} change${pending > 1 ? 's' : ''} waiting` : ''}`;
    case 'error': return `Sync error: ${st.message}`;
    default: return store.meta.lastSync ? `Synced ${ago(store.meta.lastSync)}` : 'Synced';
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
  els.conflicts.title = `${n} sync conflict${n === 1 ? '' : 's'} or change${n === 1 ? '' : 's'} not saved`;
}

// ---------------------------------------------------------------- main view
function renderMain() {
  const showAdd = ui.view === 'list' && !!currentProject() && !showWelcome() && !readOnly(currentProject().id);
  els.addBar.hidden = !showAdd;
  els.app.classList.toggle('no-add', !showAdd);
  if (ui.view === 'list' && showWelcome()) return renderWelcome();
  if (ui.view !== 'list') return renderSettingsView();
  renderTasks();
}

function isOpen(node) {
  const v = ls.get(`open.${node.id}`);
  if (v) return v === '1';
  return node.kids.length > 0;
}
function setOpen(id, open) { ls.set(`open.${id}`, open ? '1' : '0'); }

function renderTasks() {
  const frag = [];
  ui.visible = [];
  const proj = currentProject();
  if (!proj) {
    frag.push(h('div', { class: 'welcome' },
      h('p', {}, 'No projects yet.'),
      h('button', { class: 'btn primary', onclick: () => projectNameSheet(null) }, icon('plus'), 'New project')));
    els.list.replaceChildren(...frag);
    return;
  }
  if (store.saveError) frag.push(saveWarning());
  if (isIOS() && !isStandalone() && ls.get('installHint') !== 'off') frag.push(installHint());
  const shared = sharing(proj.id)?.withMe;
  if (shared) {
    const st = store.shareStatus.get(shared.id) ?? shared.status;
    const trouble = st?.state === 'paused' ? ' Not synced while this app is not paired: your sync service keeps it in step. Pair it again in Settings › Sync & sharing; what you change meanwhile waits here.'
      : st && (st.state === 'offline' || st.state === 'error') ? ` Not synced right now: ${st.message || st.state}.` : '';
    if (shared.access === 'view' || trouble) {
      // (a line above the cards, like the Windows app's; in ink when something is wrong)
      frag.push(h('p', { class: `shared-note${trouble ? ' trouble' : ''}`, role: trouble ? 'status' : null },
        shared.access === 'view' ? h('b', {}, 'View only. ') : null,
        `Shared with you from ${hostOf(shared.server)}.${shared.access === 'view' ? ' You see the changes as they are made, but can\'t change it.' : ''}${trouble}`));
    }
  }
  const tree = store.tree(proj.id);
  const { active, postponed, closed } = sections(tree);
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
    frag.push(h('h2', { class: 'g-head list-head' }, 'Postponed'));
    const items = [];
    for (const n of postponed) renderNode(items, n, 'postponed');
    frag.push(list('Postponed', items));
  }
  if (closed.length) {
    const show = ls.get('showCompleted') === '1';
    frag.push(h('h2', { class: 'completed-heading' }, h('button', {
      class: `completed-toggle${show ? ' open' : ''}`, 'aria-expanded': String(show), dataset: { fk: 'completed' },
      'aria-label': `Completed, ${closed.length} ${closed.length === 1 ? 'task' : 'tasks'}`,
      onclick: () => { ls.set('showCompleted', show ? '0' : '1'); commitAll(); render(); },
    }, h('span', {}, 'Completed'), h('span', { class: 'count' }, ` · ${closed.length}`), icon('chevron'))));
    if (show) { const items = []; for (const n of closed) renderNode(items, n, 'closed'); frag.push(list('Completed', items)); }
  }
  if (!ui.visible.length && !draft) {
    frag.push(h('div', { class: 'empty-state' }, readOnly(proj.id) ? 'No tasks here yet.' : 'No tasks here yet. Add one below.'));
  }
  els.list.replaceChildren(...frag.filter(Boolean));
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
    for (const k of kidsInDisplayOrder(node)) renderNode(frag, k, section);
  }
  if (draft && draft.afterId === node.id) frag.push(listItem(draft.depth, taskRow(null, section, draft)));
}
/** One phrase for a task row: what it says, its status, its deadline (read when the row gets focus). */
function rowSummary(node, st) {
  const t = node.task;
  const due = t.fields.due.v;
  const parts = [t.fields.text.v || 'Untitled', st.name];
  if (due) parts.push(`deadline ${dueLong(due)}${dueTone(due, rank(t.fields.status.v) === 2) === 'over' ? ', overdue' : ''}`);
  if (node.kids.length) { const p = progress(node); parts.push(`${p.done} of ${p.total} subtasks closed`); }
  return parts.join(', ');
}

function installHint() {
  return h('div', { class: 'callout install' },
    h('div', {}, h('b', {}, 'Install the app: '), 'tap ', h('b', {}, 'Share'), ' then ', h('b', {}, 'Add to Home Screen'),
      ', and open Saqme from the Home Screen for notifications and full screen.'),
    // Safari keeps a tab's data apart from the Home Screen app's, and may clear it after a week without a visit
    store.meta.token ? null : h('div', {}, 'Lists you make in this Safari tab stay in this tab: the Home Screen app starts empty, and Safari may clear them after a week without opening them. Install first, or export them (Settings › Your lists) and import them in the app.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'g-btn', onclick: () => { ls.set('installHint', 'off'); render(); } }, 'Got it')));
}

/** Shown while edits cannot be written to the phone's storage (they are kept in memory and retried). */
function saveWarning() {
  return h('div', { class: 'callout', role: 'alert' },
    h('b', {}, 'Changes are not saved on this phone right now. '),
    `${store.saveError} They stay while the app is open and are saved as soon as it works again.${store.meta.token ? '' : ' Export your lists (Settings › Your lists) to be safe.'}`);
}

function taskRow(node, section, draft = null) {
  const t = node?.task;
  const id = node?.id ?? null;
  const mark = t ? t.fields.status.v : ' ';
  const st = statusOf(mark);
  const hasKids = !!node?.kids.length;
  const notes = t?.fields.notes.v ?? '';
  const open = node ? isOpen(node) : false;
  const depth = node ? node.depth : draft.depth;
  const ro = !!t && readOnly(t.fields.place.v.project);   // a view-only shared list: read, never change
  // the row takes keyboard focus as one unit (arrow keys move it), and says what it is in one phrase
  const notesBelow = !!node && (open || ui.notesEditing === id) && (!!notes || ui.notesEditing === id);
  const row = h('div', {
    class: `row${id && ui.sel === id ? ' sel' : ''}${notesBelow ? ' with-notes' : ''}`, dataset: { id: id ?? '', fk: id ? `row:${id}` : '' }, style: { '--depth': String(depth) },
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

  const chev = h('button', { class: `chev${open ? ' open' : ''}`, 'aria-label': 'Subtasks and notes', 'aria-expanded': String(open), dataset: { fk: id ? `chev:${id}` : '' } });
  if (hasKids || notes) {
    chev.append(icon('chevron'));
    chev.addEventListener('click', () => { commitAll(); setOpen(id, !open); render(); });
  } else { chev.disabled = true; chev.setAttribute('aria-hidden', 'true'); chev.removeAttribute('aria-expanded'); }
  row.append(chev);

  const chipBtn = ro
    ? h('span', { class: 'chip-btn', role: 'img', 'aria-label': `Status: ${st.name}` }, chip(mark))
    : h('button', { class: 'chip-btn', 'aria-label': `Status: ${st.name}`, 'aria-haspopup': 'dialog', dataset: { fk: id ? `chip:${id}` : '' } }, chip(mark));
  if (node && !ro) chipBtn.addEventListener('click', () => { commitAll(); statusSheet(id); });
  row.append(chipBtn);

  // text and its meta line share one column, so long titles get the full width (docs/design.md)
  const main = h('div', { class: 'main' });
  const editingThis = draft || (ui.editing && ui.editing.id === id);
  if (editingThis) main.append(editor(node, draft));
  else if (ro) main.append(h('span', { class: `text t-${st.key}${t.fields.text.v ? '' : ' empty'}` }, t.fields.text.v || 'Untitled'));
  else {
    // a button: tapping it (or Enter / Space on it) edits the text
    const text = h('button', { class: `text t-${st.key}${t.fields.text.v ? '' : ' empty'}`, dataset: { fk: `text:${id}` } }, t.fields.text.v || 'Untitled');
    text.addEventListener('click', () => beginEdit(id));
    main.append(text);
  }
  if (node) {
    const meta = [];
    const due = t.fields.due.v;
    if (due) {
      // a pill only when it matters (overdue / today / tomorrow); later deadlines are plain text
      const tone = dueTone(due, rank(mark) === 2);
      const urgent = tone === 'over' || tone === 'soon';
      const shown = dueLabel(due.date) + (due.time ? ` ${due.time}` : '');
      const b = h(ro ? 'span' : 'button', {
        class: `m-due ${urgent ? `pill ${tone}` : 'due'}`, title: `Deadline: ${dueLong(due)}`, dataset: { fk: ro ? '' : `due:${id}` }, 'aria-haspopup': ro ? null : 'dialog',
        'aria-label': `Deadline: ${shown}${tone === 'over' ? ', overdue' : ''}`,   // the state in words, not only in colour
      }, shown);
      if (!ro) b.addEventListener('click', () => { commitAll(); dueSheet(id); });
      meta.push(b);
    }
    if (hasKids) {
      const p = progress(node);
      meta.push(h('span', { class: 'item m-progress', title: `${p.done} of ${p.total} subtasks closed` }, h('span', { 'aria-hidden': 'true' }, `${p.done}/${p.total}`), h('span', { class: 'sr-only' }, `${p.done} of ${p.total} subtasks closed`)));
    }
    if (notes && !open) meta.push(h('span', { class: 'item m-notes', title: 'Has notes or links' }, icon('link'), h('span', { class: 'sr-only' }, 'Has notes')));
    if (meta.length) main.append(h('div', { class: 'meta' }, meta));
  }
  row.append(main);

  const more = ro ? h('span', { class: 'more', 'aria-hidden': 'true' }) : h('button', { class: 'more', 'aria-label': 'Task menu', 'aria-haspopup': 'dialog', dataset: { fk: id ? `more:${id}` : '' } });
  if (node && !ro) { more.append(icon('more')); more.addEventListener('click', () => { commitAll(); rowMenu(id); }); }
  row.append(more);

  if (node && !ro) {
    onLongPress(row, () => { commitAll(); rowMenu(id); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); commitAll(); rowMenu(id); });
  }
  return row;
}

/** Touch long-press -> fn; the click that follows the release is swallowed. */
function onLongPress(el, fn) {
  let timer = null;
  let start = null;
  let firedAt = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('.grip, textarea, input')) return;
    start = [e.clientX, e.clientY];
    timer = setTimeout(() => { timer = null; firedAt = Date.now(); navigator.vibrate?.(8); fn(); }, 480);
  });
  el.addEventListener('click', (e) => {
    if (Date.now() - firedAt < 800) { e.stopPropagation(); e.preventDefault(); firedAt = 0; }
  }, true);
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
    const ta = h('textarea', { rows: 2, placeholder: 'Links, notes, context…', value: node.task.fields.notes.v, maxLength: MAX_NOTES });
    const done = () => commitNotes(ta.value);
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); ui.notesEditing = null; requestRender(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); }
    });
    ta.addEventListener('blur', () => { if (ui.notesEditing === id) done(); });
    wrap.append(ta, h('div', { class: 'notes-actions' }, h('button', { class: 'g-btn notes-done', onpointerdown: (e) => e.preventDefault(), onclick: done }, 'Done')));
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
  const t = store.get('task', e.id);
  if (!t) return null;
  const orig = e.orig ?? { v: t.fields.text.v, ts: t.fields.text.ts };
  if (text === orig.v) return e.id;   // unchanged: never rewrite (it could be a newer version by now)
  if (!text) {
    if (t.fields.text.v) { store.deleteTask(e.id); toast('Task deleted', { label: 'Undo', run: () => store.restoreTask(e.id) }); }
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
  toast('Task deleted', { label: 'Undo', run: () => store.restoreTask(id) });
}

function addSubtask(id) {
  const ctx = nodeOf(id);
  if (!ctx?.node) return;
  setOpen(id, true);
  showEditor({ draft: { projectId: ctx.node.task.fields.place.v.project, parentId: id, index: 0, afterId: null, depth: ctx.node.depth + 1 } });
}

// ---------------------------------------------------------------- sheets
function sheet(title, children) {
  if (els.sheetWrap.hidden) ui.sheetOpener = document.activeElement?.dataset?.fk || null;
  els.sheet.replaceChildren(h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }), title ? h('h2', { id: 'sheetTitle' }, title) : null, ...children.filter(Boolean));
  if (title) { els.sheet.setAttribute('aria-labelledby', 'sheetTitle'); els.sheet.removeAttribute('aria-label'); }
  else { els.sheet.removeAttribute('aria-labelledby'); els.sheet.setAttribute('aria-label', 'Options'); }
  els.sheetWrap.hidden = false;
  els.app.inert = true;   // modal: Tab and screen readers stay in the sheet
  els.sheet.scrollTop = 0;
  // focus the current choice, or the first control, unless an input already took it
  queueMicrotask(() => {
    if (els.sheet.contains(document.activeElement)) return;
    (els.sheet.querySelector('[aria-current="true"]') ?? els.sheet.querySelector('input, textarea, button, a[href]') ?? els.sheet).focus({ preventScroll: true });
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
  el?.focus({ preventScroll: true });
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
  if (e.shiftKey && (document.activeElement === first || !els.sheet.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !els.sheet.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
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
  const t = store.get('task', id);
  if (!t || roTask(id)) return;
  sheet(t.fields.text.v, STATUSES.map((s) => menuItem(chip(s.mark), s.name, () => store.setTask(id, { status: s.mark }), { current: s.mark === t.fields.status.v })));
}

function dueSheet(id) {
  const t = store.get('task', id);
  if (!t || roTask(id)) return;
  const due = t.fields.due.v;
  const set = (v) => { store.setTask(id, { due: v }); closeSheet(); };
  const keepTime = (date) => ({ date, time: due?.time ?? '' });
  const input = h('input', { class: 'field', placeholder: 'Type: fri 14:00, 25 oct, +3, 9:30', enterKeyHint: 'done', autocapitalize: 'off', autocomplete: 'off' });
  const apply = () => {
    const d = parseDue(input.value);
    if (d) set(d); else input.classList.add('bad');
  };
  input.addEventListener('input', () => input.classList.remove('bad'));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
  const date = h('input', { class: 'field', type: 'date', value: due?.date ?? '', 'aria-label': 'Date' });
  const time = h('input', { class: 'field', type: 'time', value: due?.time ? due.time.padStart(5, '0') : '', 'aria-label': 'Time' });
  const pick = () => {
    if (!date.value) return;
    const tm = time.value ? `${+time.value.slice(0, 2)}:${time.value.slice(3, 5)}` : '';
    store.setTask(id, { due: { date: date.value, time: tm } });
  };
  date.addEventListener('change', pick);
  time.addEventListener('change', pick);
  sheet(due ? `Deadline · ${dueLong(due)}` : 'Deadline', [
    ...quickDates().map((q) => menuItem('calendar', q.label, () => set(keepTime(q.date)), { hint: q.hint })),
    h('div', { class: 'field-row' }, input, h('button', { class: 'btn primary', onclick: apply }, 'Set')),
    h('div', { class: 'field-row' }, date, time),
    due && h('div', { class: 'menu-sep' }),
    due && menuItem('cross', 'Remove deadline', () => store.setTask(id, { due: null }), { danger: true }),
  ]);
}

function rowMenu(id) {
  const t = store.get('task', id);
  if (!t || roTask(id)) return;
  ui.sel = id;
  const ctx = nodeOf(id);
  const node = ctx?.node;
  const sibs = node ? (node.parent ? node.parent.kids : ctx.tree.roots) : [];
  const i = sibs.indexOf(node);
  const projectId = t.fields.place.v.project;
  const others = store.projects().filter((p) => p.id !== projectId && !readOnly(p.id) && !(ui.local && sharing(p.id)?.withMe));
  sheet(t.fields.text.v, [
    menuItem('edit', 'Edit', () => beginEdit(id)),
    menuItem('calendar', 'Deadline…', () => dueSheet(id), { keepOpen: true }),
    menuItem('note', 'Notes / links', () => beginNotes(id)),
    menuItem('sub', 'Add subtask', () => addSubtask(id)),
    h('div', { class: 'menu-sep' }),
    i > 0 && menuItem('up', 'Move up', () => nudge(id, -1)),
    i >= 0 && i < sibs.length - 1 && menuItem('down', 'Move down', () => nudge(id, 1)),
    i > 0 && menuItem('indent', 'Make subtask of the task above', () => shiftLevel(id, 1)),
    node?.parent && menuItem('outdent', 'Move out one level', () => shiftLevel(id, -1)),
    others.length && menuItem('move', 'Move to project…', () => moveSheet(id), { keepOpen: true }),
    h('div', { class: 'menu-sep' }),
    menuItem('trash', node?.kids.length ? 'Delete (with subtasks)' : 'Delete', () => deleteWithUndo(id), { danger: true }),
  ]);
}

function moveSheet(id) {
  const t = store.get('task', id);
  // (the Linux/macOS window moves tasks between its lists files; a shared one is synced by its own engine there,
  // so a move into or out of one is a copy plus a delete, like here, but done by the lists folder: not offered)
  const others = store.projects().filter((p) => p.id !== t.fields.place.v.project && !readOnly(p.id) && !(ui.local && sharing(p.id)?.withMe));
  sheet('Move to project', others.map((p) => menuItem('move', listName(p), () => {
    store.moveTask(id, { projectId: p.id, parentId: null });
    toast(`Moved to ${listName(p)}`);
  }, { hint: sharing(p.id)?.withMe ? 'shared' : '' })));
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
els.add.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    const text = cleanText(els.add.value);
    const proj = currentProject();
    if (!text || !proj) return;
    store.addTask(proj.id, { text });
    els.add.value = '';
    requestAnimationFrame(() => { els.list.scrollTop = els.list.scrollHeight; });
  } else if (e.key === 'Escape') { els.add.value = ''; els.add.blur(); }
  else if (e.key === 'ArrowUp' && ui.visible.length && !els.add.value) { e.preventDefault(); beginEdit(ui.visible[ui.visible.length - 1]); }
});
els.add.addEventListener('focus', () => { if (ui.editing || ui.notesEditing) { commitAll(); render(); } });

// ---------------------------------------------------------------- keyboard (hardware keyboards / desktop browsers)
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || !els.sheetWrap.hidden || ui.view !== 'list') return;
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
    case ' ': if (edit) { e.preventDefault(); store.setTask(edit.id, { status: rank(edit.fields.status.v) === 2 ? ' ' : 'x' }); } return;
    case 'ArrowRight': if (sel) { setOpen(sel.id, true); } break;
    case 'ArrowLeft': if (sel) { setOpen(sel.id, false); } break;
    case 'Escape': ui.sel = null; break;
    default: return;
  }
  render();
  const row = els.list.querySelector('.row.sel');
  row?.scrollIntoView({ block: 'nearest' });
  if (row && e.key.startsWith('Arrow')) row.focus({ preventScroll: true });   // screen readers announce the task
});

// Settings: Esc goes back one level (a page to Settings, Settings to the list), unless a sheet or an editor used it
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || ui.view === 'list' || !els.sheetWrap.hidden) return;
  e.preventDefault();
  goBack();
});

// ---------------------------------------------------------------- Settings and the views it opens
// Settings is a short list of pages, as in the Windows app: General, Notifications, Sync & sharing, Your lists; then
// App: Updates (the Linux/macOS window only: the phone app updates with its sync service) and About. Every view is a
// grouped list (docs/design.md, "Grouped lists"): cards of one-line rows, where places to go have a chevron, actions are
// violet rows (red when risky) and what needs explaining is a footnote under the card. Rare and risky actions sit at the
// bottom of their page, under Advanced. A quiet line at the bottom of every view says the version.
const PAGES = { general: 'General', notifications: 'Notifications', sync: 'Sync & sharing', lists: 'Your lists', updates: 'Updates', about: 'About' };
const VIEW_TITLES = { list: 'the list', settings: 'Settings', ...PAGES, keys: 'Keyboard shortcuts', trash: 'Recently deleted', conflicts: 'Conflicts' };
// where Back (the header, Esc) goes from each view; a page's is Settings
const VIEW_PARENT = { settings: 'list', keys: 'general', trash: 'lists', conflicts: 'sync' };
const parentOf = (view) => VIEW_PARENT[view] ?? 'settings';

/** Opens a view. Keyboard focus goes to the control with the data-fk key `focus`, else to the new view's Back button. */
function go(view, focus = '') {
  commitAll();
  const fromList = ui.view === 'list';
  ui.view = view;
  ui.focusKey = focus || (view === 'list' ? '' : 'back');
  render();
  els.list.scrollTop = 0;
  if (fromList && view !== 'list') loadLocalInfo();
}
/** Back: one level up, with focus on the row that opened the view just left (in the list: the task, or Settings). */
function goBack() {
  const from = ui.view;
  if (from === 'list') return;
  const to = parentOf(from);
  go(to, to !== 'list' ? `open:${from}` : ui.sel ? `row:${ui.sel}` : 'logo');
}

function viewHeader(title) {
  const back = `Back to ${VIEW_TITLES[parentOf(ui.view)]}`;
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
  settings: settingsHome, general: generalPage, notifications: notificationsPage, sync: syncPage, lists: listsPage,
  updates: updatesPage, about: aboutPage, keys: keysPage, trash: trashPage, conflicts: conflictsPage,
};
/** Every view but the list: its header (Back, title), its cards, and the version line at the bottom. */
function renderSettingsView() {
  if (!VIEWS[ui.view] || (ui.view === 'updates' && !ui.local)) ui.view = 'settings';
  // a view rebuilt in place (sync status, the Linux/macOS app's news) keeps what was typed in its boxes
  const typed = new Map([...els.list.querySelectorAll('input.g-input[data-fk]')].map((i) => [i.dataset.fk, [i.value, i.selectionStart, i.selectionEnd]]));
  els.list.replaceChildren(viewHeader(VIEW_TITLES[ui.view]), ...VIEWS[ui.view]().filter(Boolean), versionLine());
  for (const i of els.list.querySelectorAll('input.g-input[data-fk]')) {
    const t = typed.get(i.dataset.fk);
    if (t && !i.readOnly) { i.value = t[0]; try { i.setSelectionRange(t[1], t[2]); } catch { /* not a text box */ } }
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
    return h('button', { class: 'version-line', 'aria-description': 'Opens Settings, Updates', dataset: { fk: 'version' }, onclick: () => go('updates') },
      h('span', {}, text), h('span', { class: 'upd' }, badge.dot ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null, badge.text));
  }
  return h('p', { class: 'version-line' }, h('span', {}, text), badge ? h('span', {}, badge.text) : null);
}

const THEMES = { dark: 'Dark', light: 'Light', auto: 'Auto' };
/** Settings: two cards of pages (the app's own things last), each row with how it stands on the right. */
function settingsHome() {
  const sentence = (t) => (t ? `${t[0].toUpperCase()}${t.slice(1)}. ` : '');
  const page = (id, s, help, ic) => linkRow(PAGES[id], s.short, id, { ic, dot: !!s.dot, help: `${sentence(s.text)}${help}` });
  const theme = THEMES[ls.get('theme', 'auto')] ?? 'Auto';
  const v = appVersion();
  return [
    card(
      page('general', { short: theme, text: `${theme.toLowerCase()} theme` }, showKeys() ? 'Theme, keyboard shortcuts' : 'Theme', 'gear'),
      page('notifications', notificationSummary(), ui.local ? 'Daily summary' : 'Daily summary, notifications on this device', 'bell'),
      page('sync', syncSummary(), `${ui.local ? 'Set up sync or how it stands' : 'Pairing or how sync stands'}, pair a phone, conflicts, shared lists`, 'cloud'),
      page('lists', listsSummary(), `${ui.local ? 'Lists folder, ' : ''}export, import, recently deleted`, 'lists'),
    ),
    head('App'),
    card(
      ui.local ? page('updates', updateBadge() ?? updateSummary(), 'The version, checking and installing updates', 'update') : null,
      page('about', { short: v ?? '', text: v ? `version ${v}` : 'Saqme To Do' }, 'Version, where your lists are', 'info'),
    ),
  ];
}

/** The keyboard shortcuts page is offered where there is a keyboard to use them: the desktop window, a mouse or trackpad. */
const showKeys = () => !!ui.local || matchMedia('(any-pointer: fine)').matches;
function generalPage() {
  const theme = segmented([['dark', 'Dark'], ['light', 'Light'], ['auto', 'Auto']], ls.get('theme', 'auto'), (v) => { ls.set('theme', v); applyTheme(); render(); }, 'Theme');
  return [
    card(infoRow('Theme', '', theme)),
    foot('Auto follows the light or dark setting of this device.'),
    showKeys() ? card(linkRow('Keyboard shortcuts', '', 'keys', { help: 'Everything you can do with the keyboard' })) : null,
  ];
}

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
/** What the keyboard does (the list's handler, the editors' and the sheets'): what on the left, its keys on the right. */
function keysPage() {
  const mod = IS_MAC ? 'Cmd' : 'Ctrl';
  const alt = IS_MAC ? 'Option' : 'Alt';
  const sections = [
    ['Tasks', [
      ['Up / Down', 'Previous / next task'], ['Enter', 'Edit the task'], ['Space', 'Done / not done'], ['Right / Left', 'Open / close a task'],
      [`${alt}+Up / ${alt}+Down`, 'Move the task'], [`${mod}+D`, 'Deadline'], [`${mod}+I`, 'Notes / links'], [`${mod}+M`, 'Task menu'],
      [`${mod}+N`, 'New task'], ['Esc', 'Clear the selection'],
    ], 'A screen reader reads the selected task. The task menu has the deadline, notes, subtasks, moves and delete; a right-click (or a long press) on a task opens it too.'],
    ['While editing a task', [
      ['Enter', 'Save, new task below'], ['Shift+Enter', 'Save, new subtask'], ['Enter', 'Stop (on an empty line)'], ['Up / Down', 'Edit the previous / next'],
      ['Tab / Shift+Tab', 'Subtask / back out'], ['Esc', 'Cancel'], [`${mod}+Enter`, 'Save the notes'],
    ]],
    ['Everywhere', [
      ['Tab / Shift+Tab', 'Move around the window'], ['Enter / Space', 'Use the focused button'], ['Esc', 'Close a menu, back one level'],
    ], 'Esc goes from a Settings page to Settings, and from Settings to the list.'],
  ];
  const out = [];
  for (const [title, rows, footnote] of sections) {
    out.push(head(title), card(rows.map(([keys, what]) => infoRow(what, '', h('span', { class: 'keys' },
      h('span', { class: 'sr-only' }, ': '), keys.split(' / ').map((k, i) => [i ? h('span', { class: 'sr-only' }, ' or ') : null, h('kbd', {}, k)])), { title: `${what}: ${keys}` }))));
    if (footnote) out.push(foot(footnote));
  }
  return out;
}

function notificationSummary() {
  const at = store.setting('notifyAt', '10:00');
  if (ui.local) return { short: at, text: `daily summary at ${at}` };
  const p = pushState();
  return p.state === 'on' ? { short: at, text: `on, daily summary at ${at}` } : { short: p.short, text: p.short.toLowerCase() };
}
function notificationsPage() {
  const at = h('input', { class: 'time-input', type: 'time', value: store.setting('notifyAt', '10:00').padStart(5, '0'), 'aria-label': 'Daily summary time', dataset: { fk: 'notifyAt' } });
  at.addEventListener('change', () => { if (at.value) { store.setSetting('notifyAt', `${+at.value.slice(0, 2)}:${at.value.slice(3, 5)}`); syncSharePush(); } });
  const out = [
    card(infoRow('Daily summary', '', at)),
    foot('One notification with what is due today or overdue, at this time (the same on your devices that sync). A task with a deadline time also reminds you 15 minutes before it and at the time.'),
  ];
  if (ui.local) {
    out.push(card(infoRow('Notifications', 'On this computer')), foot('Shown by your computer while Saqme runs (it starts when you log in).'));
    return out;
  }
  const p = pushState();
  if (p.state === 'on' || p.state === 'off') {
    out.push(card(
      switchRow('Notifications', p.state === 'on', async (on) => { if (on) await enablePush(); else { await disablePush(); render(); } }, { help: p.help, fk: 'push' }),
      p.state === 'on' ? actionRow('Send a test notification', testPush) : null));
  } else out.push(card(infoRow('Notifications', p.short)));
  out.push(foot(p.help));
  return out;
}

/** How sync stands, in a few words: the value of a row ('' when this device has no sync of its own). */
function syncShort() {
  if (ui.local) {
    const c = ui.local.cloud;
    if (!c) return ui.cloudSetup?.running ? 'Setting up…' : '';
    return { synced: c.lastSync ? `Synced ${ago(c.lastSync)}` : 'Synced', syncing: 'Syncing…', offline: 'Offline' }[c.state] ?? 'Sync error';
  }
  if (!store.meta.token) return '';
  const st = store.status.state;
  if (st === 'idle') return store.meta.lastSync ? `Synced ${ago(store.meta.lastSync)}` : 'Synced';
  if (st === 'offline') { const n = store.pendingCount(); return n ? `Offline, ${n} waiting` : 'Offline'; }
  return { syncing: 'Syncing…', error: 'Sync error' }[st] ?? '';
}
/** The Sync & sharing row: own sync, conflicts, shared lists, paused deletes. text says all of it; short is what needs a look first. */
function syncSummary() {
  const n = store.conflicts().length + allNotices().length;
  const nc = n === 1 ? '1 conflict' : `${n} conflicts`;
  const sh = (ui.local ? ui.local.shares ?? [] : store.shares()).length;
  const ns = sh === 1 ? '1 shared list' : `${sh} shared lists`;
  const guarded = !!ui.local?.guarded;
  const own = syncShort();
  return {
    text: [own || 'sync is off', n ? nc : '', sh ? ns : '', guarded ? 'deletions paused' : ''].filter(Boolean).join(', '),
    short: n ? nc : guarded ? 'Deletions paused' : own || (sh ? ns : 'Off'),
    dot: !!(n || guarded),
  };
}
function syncPage() {
  return [
    ...(ui.local ? localSyncSettings() : phoneSyncSettings()),
    ...sharedListSettings(),
    ...(ui.local?.guarded ? guardedSettings() : []),
    ...advancedSettings(),
  ];
}
/** The row to Conflicts, when there are some (also what a shared list's server did not take). */
function conflictsRow() {
  const n = store.conflicts().length + allNotices().length;
  return n ? linkRow('Conflicts', String(n), 'conflicts', { dot: true, help:'Changed on two devices at once, or not saved in a shared list: pick what to keep' }) : null;
}
/** The phone app's own sync: pair it (a code or a link), or how it stands. */
function phoneSyncSettings() {
  const out = [head('Sync')];
  if (!store.meta.token) {
    out.push(card(infoRow('This device', 'Not paired'), pairingRow(), conflictsRow()));
    out.push(foot('Sync is set up from a computer: in the Saqme app there, Settings › Sync & sharing › Set up sync. Then type the code its Pair phone shows here, paste its pairing link, or scan its QR code with the camera.'));
    return out;
  }
  const st = store.status;
  out.push(card(
    infoRow('Status', syncShort(), null, { title: statusText() }),
    actionRow('Sync now', () => store.sync({ force: true })),
    actionRow('Pair a phone', showPairing, { help: 'A one-time code and the QR code, for the app on another phone or on this phone\'s Home Screen' }),
    conflictsRow(),
  ));
  if (st.state === 'error') out.push(foot(`Sync error: ${st.message}`, { alert: true }));
  out.push(foot(`Your sync service: ${hostOf(store.meta.server || location.origin)}${store.meta.serverVersion ? `, version ${store.meta.serverVersion}` : ''}. This device: ${store.meta.deviceId}.`));
  return out;
}
/** Sync & sharing > Advanced: turning sync off (a row that opens the rest of its card). */
function advancedSettings() {
  if (!(ui.local ? ui.local.cloud : store.meta.token)) return [];
  const open = ui.advancedOpen;
  const what = ui.local ? 'Turn off sync' : 'Unpair this device';
  const help = ui.local ? turnOffHelp('computer') : `${turnOffHelp('device')} Changes not yet synced stay queued until you pair again.`;
  return [
    card(
      h('button', {
        class: 'g-row link', 'aria-expanded': String(open), 'aria-description': what, dataset: { fk: 'advanced' },
        onclick: () => { ui.advancedOpen = !open; render(); },
      }, rowParts('Advanced', { trailing: chevron() })),
      open ? actionRow(what, ui.local ? confirmTurnOff : confirmUnpair, { danger: true, help }) : null),
    open ? foot(help) : null,
  ];
}
function confirmTurnOff() {
  sheet('Turn off sync?', [h('p', {}, turnOffHelp('computer')), h('div', { class: 'btn-row' },
    h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => { closeSheet(); try { await api('local/disconnect', {}); ui.advancedOpen = false; await loadLocalInfo(); render(); } catch (e) { toast(e.message); } } }, 'Turn off'))]);
}

function listsSummary() {
  const n = store.projects().length;
  const nl = n === 1 ? '1 list' : `${n} lists`;
  return store.saveError ? { short: 'Not saved', text: `${nl}, changes not saved`, dot: true } : { short: nl, text: nl };
}
function listsPage() {
  const l = ui.local;
  return [
    store.saveError ? saveWarning() : null,
    card(
      l ? actionRow('Copy the lists folder path', () => copyText(l.lists, 'Folder path copied'), { help: l.lists }) : null,
      actionRow('Export lists', exportLists, { help: 'Markdown files in a zip, the same format as the desktop app' }),
      actionRow('Import lists', importLists, { help: 'Markdown files or a zip of them. Tasks already here are skipped.' }),
      linkRow('Recently deleted', '', 'trash', { help: 'Restore deleted tasks and lists' }),
    ),
    foot(l ? `Plain markdown files, one per list, in ${l.lists}: this window, AI assistants and any editor can change them. Export saves them in a zip; Import adds lists from such files (tasks already here are skipped).`
      : 'Export saves your lists as markdown files in a zip, the same format as the desktop app. Import takes such files or a zip of them; tasks already here are skipped.'),
  ];
}

function aboutPage() {
  const v = appVersion();
  const badge = updateBadge();
  const where = ui.local ? 'Your lists are the markdown files in the lists folder (Your lists): this window, AI assistants and any editor can change them.'
    : store.meta.token ? 'Your lists live in your own Cloudflare account; this device keeps a full offline copy and syncs in the background.'
      : 'Your lists are stored on this device only. Export them now and then (Your lists), or pair with your own sync to keep a copy elsewhere.';
  return [
    card(
      v ? infoRow('Version', v) : null,
      badge ? linkRow('Updates', badge.short, 'updates', { dot: badge.dot, help: badge.text }) : null,
    ),
    foot(ui.local ? (ui.local.update?.supported ? 'It updates itself, and your sync service with it (Updates).' : 'This copy runs from a source folder and does not update itself.')
      : v ? 'It updates by itself with your sync service (the computer that set it up updates it).' : 'This copy updates with the site that serves it.'),
    note(`${where} Saqme To Do is free and open source (MIT license).`),
  ];
}

/** Sync & sharing > Shared lists: join one (paste its invite link), and the lists shared with this device, each with Leave. */
function sharedListSettings() {
  const input = rowInput('join-input', 'Paste an invite link to join', 'Invite link', { help: 'From the person who shares the list with you' });
  const submit = () => {
    const inv = parseInviteLink(input.value);
    if (!inv) { input.classList.add('bad'); toast('That is not an invite link (it looks like https://…/join#code=…).'); return; }
    confirmJoin(input.value.trim(), inv);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => input.classList.remove('bad'));
  // (on an iPhone the clipboard is read only on a tap like this one)
  const paste = navigator.clipboard?.readText ? textButton('Paste', async () => {
    try { input.value = (await navigator.clipboard.readText()).trim(); input.classList.remove('bad'); input.focus(); } catch { toast('Paste it into the box instead.'); }
  }, { name: 'Paste the invite link', fk: 'join-paste' }) : null;
  const rows = [inputRow(input, paste, textButton('Join', submit, { name: 'Join the shared list', fk: 'join-go' }))];
  const here = ui.local ? 'computer' : 'device';
  for (const s of ui.local ? (ui.local.shares ?? []) : store.shares()) {
    const p = store.get('project', s.projectId);
    const name = p && !ui.local ? listName(p) : (p?.fields.name.v ?? s.name);
    const st = store.shareStatus.get(s.id) ?? s.status;
    const trouble = st?.state === 'offline' || st?.state === 'error' || st?.state === 'paused';
    const access = ACCESS[s.access]?.name ?? s.access;
    const about = `From ${hostOf(s.server)}, ${access.toLowerCase()}${inBrowser(s) ? ', in this browser' : ''}${trouble ? `, not synced: ${st.message || st.state}` : ''}`;
    // a list used here in the browser can also move to one's Saqme app: its own small menu
    const end = inBrowser(s)
      ? textButton('Options', () => sharedListMenu(s, name), { name: `Options for ${name}`, help: `${about}. Move it to your Saqme app, or leave it.`, fk: `share-opts:${s.id}` })
      : textButton('Leave', () => confirmLeave(s.projectId, s), { danger: true, name: `Leave ${name}`, help: `${about}. It goes from this ${here}; nothing changes in the owner's list.`, fk: `leave:${s.id}` });
    rows.push(infoRow(name, trouble ? 'Not synced' : access, end, { dot: trouble, title: about }));
  }
  return [
    head('Shared lists'),
    card(rows),
    foot(ui.local ? 'Someone shared a list with you? Paste the invite link they sent (or run saqme join LINK); it works without cloud sync too. To share one of your own lists, right-click its tab and choose Share.'
      : store.meta.token ? 'Someone shared a list with you? Paste the invite link they sent: your sync service keeps the list for this app and your other phones. To share one of your own lists, long-press its tab and choose Share.'
        : 'Someone shared a list with you? No sync of your own needed: open the invite link itself, and its page opens the list in this browser.'),
  ];
}
function sharedListMenu(s, name) {
  sheet(name, [
    h('p', { class: 'sheet-note' }, `Shared with you from ${hostOf(s.server)} · ${ACCESS[s.access]?.name}. You use it here in this browser.`),
    menuItem('share', 'Move to my Saqme app', () => moveToAppSheet(s), { keepOpen: true }),
    h('div', { class: 'menu-sep' }),
    menuItem('leave', 'Leave this list', () => confirmLeave(s.projectId, s), { danger: true }),
  ]);
}

// ---------------------------------------------------------------- the Linux/macOS app (local server)
const SETUP_HELP = 'Creates your own free sync service in your Cloudflare account. Your lists stay on this computer and are uploaded there; nothing is deleted. You need a free Cloudflare account and one sign-in in the browser.';
const turnOffHelp = (here) => `This ${here} stops syncing. Your lists stay on this ${here}. The copy in your Cloudflare account is kept until you delete it there.`;

/** The last lines of the cloud setup's output, links clickable (the Cloudflare sign-in link among them). */
function setupOutput(lines) {
  const pre = h('pre', { class: 'setup-log', 'aria-label': 'Setup output' });
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
    announce('Sync is set up.');
    await loadLocalInfo();
    render();
    showPairing();   // what comes next: the phone
  } else {
    if (ui.cloudSetup?.result && !ui.cloudSetup.result.ok) announce(`Sync was not set up. ${ui.cloudSetup.result.message}`);
    render();
  }
}

/** The Linux/macOS window's cloud sync: set it up (or connect with a pairing link), or how it stands. */
function localSyncSettings() {
  const c = ui.local.cloud;
  const run = ui.cloudSetup;
  const out = [head('Sync')];
  if (!c && run?.running) {
    out.push(
      card(infoRow('Sync with your phone', 'Setting up…'),
        actionRow('Cancel', async () => { ui.cloudSetup = await api('local/cloud-setup/cancel', {}).catch(() => ui.cloudSetup); render(); }, { name: 'Cancel setting up sync' })),
      foot('Sign in to Cloudflare in the browser (or create a free account) and click Allow. No browser opened? Use the sign-in link below.'),
      setupOutput(run.lines));
    return out;
  }
  if (!c) {
    out.push(card(infoRow('Sync with your phone', 'Off'), actionRow('Set up sync', startCloudSetup, { help: SETUP_HELP }), conflictsRow()), foot(SETUP_HELP));
    if (run?.result && !run.result.ok) {
      out.push(foot(`Sync was not set up. ${run.result.message} ${run.result.next || ''} Nothing changed on this computer.`.replace(/ {2,}/g, ' '), { alert: true }));
      if (run.lines.length) out.push(setupOutput(run.lines));
    }
    // like the Windows app: a pairing link from a device that already syncs connects this computer too
    const input = rowInput('connect-input', 'Paste its pairing link', 'Pairing link', { help: 'From a device that already syncs: Settings › Sync & sharing › Pair a phone, Copy link' });
    const submit = () => {
      const p = parsePairingLink(input.value);
      if (!p?.server) { input.classList.add('bad'); toast('That is not a pairing link (https://saqme.<name>.workers.dev/#pair=...).'); return; }
      const link = input.value.trim();
      confirmSyncWith(p.server, async () => {
        // (the page may have been rebuilt meanwhile: its box now is the one with the same key)
        const box = () => document.querySelector('[data-fk="connect-input"]');
        try { await api('local/connect', { link }); if (box()) box().value = ''; toast('Connected. Syncing starts in a few seconds.'); setTimeout(loadLocalInfo, 2500); }
        catch (e) { box()?.classList.add('bad'); toast(e.message); }
      });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    input.addEventListener('input', () => input.classList.remove('bad'));
    out.push(head('Already syncing on another device?'),
      card(inputRow(input, textButton('Connect', submit, { name: 'Connect with this pairing link', fk: 'connect-go' }))),
      foot('There: Settings › Sync & sharing › Pair a phone › Copy link. It looks like https://saqme.<name>.workers.dev/#pair=…'));
    return out;
  }
  const short = syncShort();
  out.push(card(
    infoRow('Status', short, null, { title: c.message || short }),
    actionRow('Pair a phone', showPairing, { help: 'The QR code and a one-time code that connect your phone to the same lists' }),
    conflictsRow(),
  ));
  if (c.message && c.state !== 'synced' && c.state !== 'syncing') out.push(foot(c.message, { alert: c.state === 'error' }));
  out.push(foot(`Your sync service: ${c.label}${c.workerVersion ? `, version ${c.workerVersion}` : ''}.${c.conflicts ? ` ${c.conflicts} ${c.conflicts === 1 ? 'conflict' : 'conflicts'} to look at on your phone.` : ''}`));
  return out;
}
/** Tasks that vanished from the lists folder at once: deleting them everywhere waits for a yes (shown while it does). */
function guardedSettings() {
  const g = ui.local.guarded;
  const msg = `${g} tasks disappeared from the lists folder at once, so deleting them everywhere is paused in case that was an accident. Restore the file, or, if you removed them on purpose, confirm it.`;
  return [
    head('Deletions paused'),
    card(
      infoRow('Waiting for you', `${g} tasks`, null, { dot: true, title: msg }),
      actionRow('Delete them', async () => {
        try { await api('local/allow-deletes', {}); toast('Confirmed. They will be deleted everywhere.'); } catch (e) { toast(`Could not confirm: ${e.message}`); }
      }, { danger: true, help: 'Confirms the paused deletions: the tasks are deleted everywhere' })),
    foot(msg),
  ];
}

/** When an update needs a look (the version line's news, the Updates row's value), else null. dot: something to do. */
function updateBadge() {
  const u = ui.local?.update;
  if (!u?.supported) return null;
  if (u.running) return { text: `Updating to ${u.running.version}…`, short: 'Updating…', dot: false };
  if (u.worker?.pending && u.worker.needsLogin) return { text: 'Sign in to Cloudflare to finish the update', short: 'Sign in needed', dot: true };
  if (u.available) return { text: `Update available: ${u.latest}`, short: `${u.latest} available`, dot: true };
  if (u.result && !u.result.ok) return { text: u.result.version ? `The update to ${u.result.version} is waiting` : 'The last update did not install', short: 'Waiting', dot: true };
  return null;
}
/** The Updates row when there is no news: in words (text) and as the row's value (short). */
function updateSummary() {
  const u = ui.local?.update;
  if (!u?.supported) return { text: 'this copy does not update itself', short: 'Off' };
  if (u.checking) return { text: 'checking for updates', short: 'Checking…' };
  if (u.error) return { text: 'could not check for updates', short: 'Couldn\'t check' };
  if (u.checkedAt) return { text: 'up to date', short: 'Up to date' };
  return u.auto ? { text: 'checked once a day, installed by itself', short: 'Automatic' } : { text: 'checked once a day', short: 'Manual' };
}
const AUTO_HELP = 'When the app has not been used for a while, with your sync service. Off: only with Update now.';
/**
 * Settings > Updates in the Linux/macOS window (local/updater.mjs): this version, the newest one with Update now,
 * what an update is doing, how the last one ended, the Cloudflare sign-in that finishes a Worker update, and
 * "Install updates automatically". The window refreshes it with the rest of ui.local while Settings are open.
 */
function updatesPage() {
  const u = ui.local?.update;
  const version = infoRow('Version', u?.current ?? appVersion() ?? '');
  if (!u?.supported) return [card(version), foot('This copy runs from a source folder, so it does not update itself: update it with git pull, then run scripts/setup.sh.')];
  const out = [];
  const run = u.running;
  if (run) {
    const what = { checking: 'Checking…', downloading: `Downloading ${run.version}…`, installing: `Installing ${run.version}…`, worker: 'Updating your sync service…', restarting: 'Restarting…' }[run.state] ?? `Updating to ${run.version}…`;
    out.push(card(version, infoRow('Status', what, null, { long: true, title: what })),
      foot('The app restarts by itself when it is done; your lists are not touched.'));
  } else if (u.available) {
    out.push(card(version, infoRow('Available', u.latest, null, { dot: true }),
      actionRow('Update now', () => updateAction('now'), { name: `Update now to ${u.latest}`, help: 'The app restarts by itself; your lists are not touched' })),
    foot(`You have ${u.current}. It installs in the background, your sync service too, and the app restarts; your lists are not touched.`));
  } else {
    out.push(card(version, infoRow('Status', u.checking ? 'Checking…' : u.error ? 'Couldn\'t check' : u.checkedAt ? 'Up to date' : 'Not checked yet'),
      actionRow('Check now', () => updateAction('check'), { help: 'Looks for a new version now' })),
    u.error ? foot(`Could not check for updates: ${u.error}`, { alert: true })
      : foot(u.checkedAt ? `Checked ${ago(u.checkedAt)}, then again about once a day.` : 'Checked shortly after the app starts, then about once a day.'));
  }
  // how the last one ended, when there is something to do about it
  const signIn = () => actionRow('Sign in to Cloudflare', () => updateAction('login'), { help: 'Opens the browser; the update finishes by itself afterwards' });
  if (u.login?.running) {
    out.push(card(infoRow('Signing in to Cloudflare…')), foot(['Sign in in the browser and click Allow; the update finishes by itself afterwards.',
      u.login.url ? [' No browser opened? ', h('a', { href: u.login.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the sign-in page')] : null]));
  } else if (u.worker?.pending) {
    out.push(card(u.worker.needsLogin ? signIn()
      : [infoRow('Your sync service', 'Not updated yet'), actionRow('Try again', () => updateAction('worker'), { help: 'Updates your sync service again' })]),
    foot(u.worker.message));
  }
  if (u.login?.message && !u.login.running) out.push(foot(u.login.message, { alert: true }));
  if (u.result && !u.result.ok && !run) {
    out.push(card(infoRow(u.result.version ? `Update to ${u.result.version}` : 'The last update', u.result.held ? 'Waiting' : 'Didn\'t install', null, { dot: true }),
      u.result.needsLogin ? signIn() : actionRow('Try again', () => updateAction('now'), { help: 'Tries the update again' })),
    foot([u.result.message, u.result.next].filter(Boolean).join(' '), { alert: true }));
  }
  out.push(card(switchRow('Install updates automatically', !!u.auto, (on) => updateAction('auto', { on }), { help: AUTO_HELP })), foot(AUTO_HELP));
  return out;
}
async function updateAction(kind, body = {}) {
  try { ui.local.update = await api(`local/update/${kind}`, body); } catch (e) { toast(e.message); }
  render();
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
  h('span', { class: 'sr-only' }, `Pairing code: ${code.replace('-', '').split('').join(' ')}.`),
  h('span', { class: 'hint' }, 'works once, for 10 minutes'));

async function showPairing() {
  try {
    const { link, code } = await pairingInfo();
    if (!link) { toast('Cloud sync is not set up yet'); return; }
    const { qrMatrix, qrToSvg } = await import('./qr.js');
    const svg = qrToSvg(qrMatrix(link, 'M'), { margin: 4, scale: 6 });
    sheet('Pair a phone', [
      h('img', { class: 'qr', alt: 'QR code with the pairing link', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }),
      h('p', {}, 'Scan it with the phone camera and open the link, then add Saqme to the Home Screen.'),
      code ? h('p', {}, 'On iPhone, the app on the Home Screen starts unpaired: open it and type this code.') : null,
      code ? codeBlock(code) : null,
      h('p', {}, 'The link is the key to your lists: keep it private.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => copyText(link, 'Link copied') }, 'Copy link'),
        h('button', { class: 'btn primary', onclick: closeSheet }, 'Done')),
    ]);
  } catch (e) { toast(`Could not show it: ${e.message}`); }
}

/** iPhone Safari, just paired by the link: the Home Screen app has storage of its own, so hand it a code. */
async function showHomeScreenStep() {
  const { link, code } = await pairingInfo();
  sheet('Paired. Now the Home Screen app', [
    h('ol', { class: 'steps' },
      h('li', {}, 'Tap ', h('b', {}, 'Share'), ', then ', h('b', {}, 'Add to Home Screen'), '.'),
      h('li', {}, 'Open Saqme from the Home Screen and ', code ? 'type this code:' : 'paste the pairing link (Copy link below).')),
    code ? codeBlock(code) : null,
    h('p', {}, code ? 'Expired? Settings › Sync & sharing › Pair a phone, here or on your computer, shows a new one.' : 'The link is the key to your lists: keep it private.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => copyText(link, 'Link copied') }, 'Copy link'),
      h('button', { class: 'btn primary', onclick: closeSheet }, 'Done')),
  ]);
}

async function loadLocalInfo() {
  if (!store.meta.token) return;
  try {
    const cfg = await api('config');
    const was = JSON.stringify(ui.local);
    const sharesWere = JSON.stringify([ui.local?.shares, ui.local?.sharedByMe, ui.local?.notices]);
    ui.local = cfg.local ?? null;
    if (JSON.stringify(ui.local) !== was && ui.view !== 'list' && !ui.editing) requestRender();
    // lists shared with this computer (and by it) change tabs, badges and what can be edited: everywhere
    else if (JSON.stringify([ui.local?.shares, ui.local?.sharedByMe, ui.local?.notices]) !== sharesWere) requestRender();
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
  const m = /^#claim=([A-Za-z0-9_-]{16,})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  try {
    const res = await fetch('api/local/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: m[1] }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.token !== store.meta.token) { store.pair(data.token); ui.welcomeSkipped = true; }
  } catch (e) { toast(`Could not connect to the app: ${e.message}`); }
}

function copyText(text, done) {
  navigator.clipboard?.writeText(text).then(() => toast(done), () => toast(text));
}

// ---------------------------------------------------------------- export / import
async function exportLists() {
  const { files, order } = store.exportLists();
  if (!files.length) { toast('Nothing to export yet'); return; }
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
  toast(`Saved ${name}`);
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
      if (!lists.length) { toast('No markdown lists found in that selection'); return; }
      const rank = (n) => { const i = order.indexOf(n.replace(/\.(md|markdown)$/i, '')); return i < 0 ? order.length : i; };
      lists.sort((a, b) => rank(a.name) - rank(b.name));
      const r = store.importLists(lists);
      toast(`Imported ${r.added} task${r.added === 1 ? '' : 's'}${r.projects ? ` and ${r.projects} new list${r.projects === 1 ? '' : 's'}` : ''}${r.skipped ? ` (${r.skipped} already here)` : ''}`);
      render();
    } catch (e) { toast(`Could not import: ${e.message}`); }
  });
  input.click();
}

function confirmUnpair() {
  sheet('Unpair this device?', [
    h('p', {}, `${turnOffHelp('device')} Changes not yet synced stay queued until you pair again.`),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => { closeSheet(); await disablePush(); store.unpair(); store.setMeta({ server: '' }); render(); } }, 'Unpair')),
  ]);
}

function localCounts() {
  return { lists: store.projects().length, tasks: store.tasks().filter((t) => !t.fields.deleted.v).length };
}

/** Pairing uploads everything on this device to the server in the link: say where, and what, first. */
function confirmSyncWith(server, onYes) {
  const host = new URL(server).host;
  const { lists, tasks } = localCounts();
  const what = `${lists === 1 ? 'your list' : `your ${lists} lists`} (${tasks} ${tasks === 1 ? 'task' : 'tasks'})`;
  sheet(`Sync with ${host}?`, [
    h('p', {}, tasks ? `This uploads ${what} to ${host} and keeps them in step with it.` : `This device then shows and syncs the lists kept at ${host}.`),
    h('p', {}, 'Only use a pairing link from your own devices: whoever runs that server can read your lists.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => { closeSheet(); onYes(); } }, 'Sync')),
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
  if (!res) { toast('No connection. Try again when you are online.'); return; }
  if (!data || !(data.token || data.error)) { input.classList.add('bad'); toast('Codes work in the app opened from your sync service\'s address. Here, paste the pairing link instead.'); return; }
  if (!res.ok) { input.classList.add('bad'); toast(data.error); return; }
  pair(data.token);
}

/** The pairing code (or link) box and what pairs with it: on the welcome screen, and in Settings > Sync & sharing. */
function pairingControls(cls) {
  const input = h('input', { class: cls, placeholder: 'Pairing code or link', 'aria-label': 'Pairing code or link', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, enterKeyHint: 'go', dataset: { fk: 'pair-input' } });
  const submit = () => {
    const code = normalizePairingCode(input.value);
    if (code) {
      if (localCounts().tasks) confirmSyncWith(location.origin, () => claimCode(code, input)); else claimCode(code, input);
      return;
    }
    // a link to the Worker's own address pairs this copy of the app with it, wherever this copy is served from
    const p = parsePairingLink(input.value, location.origin);
    if (!p) { input.classList.add('bad'); toast('Type the 8-character code, or paste the whole pairing link.'); return; }
    if (!p.server && !localCounts().tasks) { pair(p.key); return; }   // this app's own server, nothing to upload yet
    confirmSyncWith(p.server || location.origin, () => pair(p.key, p.server));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => input.classList.remove('bad'));
  return { input, submit };
}
function pairingField() {
  const { input, submit } = pairingControls('field');
  return h('div', { class: 'field-row' }, input, h('button', { class: 'btn primary', onclick: submit }, 'Pair'));
}
/** The same, as a row of a card. */
function pairingRow() {
  const { input, submit } = pairingControls('g-input');
  return inputRow(input, textButton('Pair', submit, { name: 'Pair this device', fk: 'pair-go' }));
}

// ---------------------------------------------------------------- notifications (Web Push)
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * Where this device stands with notifications, for Settings > Notifications: state (unsupported, install, unpaired,
 * blocked, on, off), short (the row's value) and help (the footnote: what to do, or what it means).
 */
function pushState() {
  if (!pushSupported()) {
    return { state: 'unsupported', short: 'Not available', help: isIOS() && !isStandalone()
      ? 'On iPhone, notifications work only in the installed app (iOS 16.4 or later): Share › Add to Home Screen, then open Saqme from the Home Screen.'
      : 'This browser does not support web push notifications.' };
  }
  const browserOnly = !store.meta.token && browserShares().length > 0;   // reminders from the lists' owner's server
  if (!store.meta.token && !browserOnly) return { state: 'unpaired', short: 'Off', help: 'Pair this device first (Sync & sharing): your sync service sends them.' };
  if (Notification.permission === 'denied') return { state: 'blocked', short: 'Blocked', help: 'Allow them in iPhone Settings › Notifications › Saqme.' };
  if (Notification.permission === 'granted' && ls.get('push') === '1') {
    return { state: 'on', short: 'On', help: browserOnly ? 'On for the lists shared with you here; their owner\'s sync service sends them.' : 'On for this device.' };
  }
  if (isIOS() && !isStandalone()) return { state: 'install', short: 'Off', help: 'Install the app to the Home Screen first (Share › Add to Home Screen).' };
  return { state: 'off', short: 'Off', help: browserOnly
    ? 'Reminders for the lists shared with you here: 15 minutes before timed deadlines, and a daily summary at your time. Their owner\'s sync service sends them; it learns this browser\'s push address and time zone.'
    : 'Reminders 15 minutes before timed deadlines and at the time, and the daily summary.' };
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
  for (const s of browserShares()) {
    if (s.push?.endpoint && s.push.tz === tz && s.push.notifyAt === notifyAt) continue;
    try {
      const reg = await navigator.serviceWorker.ready;
      const cfg = await store.shareCall(s, 'config');
      if (!cfg.vapidPublicKey) throw new Error('the list\'s sync service has no push keys');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
      await store.shareCall(s, 'push/subscribe', { subscription: sub.toJSON(), tz, notifyAt });
      s.push = { endpoint: sub.endpoint, tz, notifyAt };
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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function enablePush() {
  // must be the first await-free call inside the tap handler, or iOS refuses to ask
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { toast('Notifications were not allowed'); render(); return; }
  if (!store.meta.token) {
    try {
      ls.set('push', '1');
      await syncSharePush({ quiet: false });
      toast('Notifications are on');
    } catch (e) { ls.set('push', '0'); toast(`Could not enable notifications: ${e.message}`); }
    render();
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const cfg = await api('/api/config');
    if (!cfg.vapidPublicKey) throw new Error('the server has no push keys (re-run setup)');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
    await api('/api/push/subscribe', { deviceId: store.meta.deviceId, subscription: sub.toJSON() });
    ls.set('push', '1');
    syncTimeZone();
    toast('Notifications are on');
  } catch (e) {
    toast(`Could not enable notifications: ${e.message}`);
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
    const r = viaShare ? await store.shareCall(viaShare, 'push/test', { endpoint: sub?.endpoint }) : await api('/api/push/test', { endpoint: sub?.endpoint });
    toast(r.sent ? 'Test sent — it should arrive in a few seconds' : 'Nothing sent: this device is not subscribed any more');
  } catch (e) { toast(`Test failed: ${e.message}`); }
}

/** The phone's time zone drives the server's reminder clock (only when this device gets the pushes). */
function syncTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && ls.get('push') === '1' && store.setting('tz') !== tz) store.setSetting('tz', tz);
}

// ---------------------------------------------------------------- trash + conflicts
/** Recently deleted: lists first, then the tasks under the name of the list they were in; each row with Restore. */
function trashPage() {
  const items = store.trash();
  if (!items.length) return [note('Nothing deleted.')];
  const row = (r, label) => {
    const project = r.kind === 'project';
    const when = ago(r.fields.deleted.ts);
    const from = project ? 'A list' : `From ${store.get('project', r.fields.place.v.project)?.fields.name.v ?? 'a list that is gone'}`;
    const restore = textButton('Restore', () => { if (project) store.restoreProject(r.id); else store.restoreTask(r.id); toast('Restored'); },
      { name: `Restore ${label}`, help: `${from}, deleted ${when}`, fk: `restore:${r.id}` });
    return infoRow(label, when, restore, { title: `${label}. ${from}, deleted ${when}` });
  };
  const out = [];
  const lists = items.filter((r) => r.kind === 'project');
  if (lists.length) out.push(head('Lists'), card(lists.map((r) => row(r, r.fields.name.v))));
  const byList = new Map();
  for (const r of items.filter((x) => x.kind !== 'project')) {
    const pid = r.fields.place.v.project;
    if (!byList.has(pid)) byList.set(pid, []);
    byList.get(pid).push(r);
  }
  for (const [pid, tasks] of byList) out.push(head(store.get('project', pid)?.fields.name.v ?? 'Other lists'), card(tasks.map((r) => row(r, r.fields.text.v || 'Untitled'))));
  out.push(foot('Newest first. Right after a delete, Undo in its message brings it back too.'));
  return out;
}

function describe(field, v) {
  if (field === 'status') return statusOf(v).name;
  if (field === 'due') return v ? dueLong(v) : 'No deadline';
  if (field === 'deleted') return v ? 'Deleted' : 'Kept';
  return v || '(empty)';
}

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
  if (!list.length && !notices.length) return [note('No conflicts. When the same thing is changed on two devices before they sync, the newest change wins and the other one is kept here for you to pick.')];
  const out = [];
  for (const n of notices) {
    const p = store.get('project', n.projectId);
    const what = { text: 'Text', status: 'Status', due: 'Deadline', notes: 'Notes', deleted: 'Delete', new: 'New task' }[n.field] ?? n.field;
    const value = n.field === 'deleted' ? 'Deleted' : describe(n.field, n.value);
    const why = n.reason === 'this shared list is view-only' ? 'The list is view-only for you, so the owner\'s version stays.' : `The owner's server did not take it: ${n.reason}.`;
    out.push(head(n.text || 'Untitled'), card(
      versionRow('Your version', value),
      actionRow('Copy', () => copyText(String(n.field === 'deleted' ? n.text : value), 'Copied'), { name: 'Copy your version', fk: `copy:${n.id}` }),
      actionRow('Dismiss', async () => {
        if (n.local) { try { await api('local/notices/dismiss', { id: n.id }); await loadLocalInfo(); } catch (e) { toast(e.message); } } else store.dismissNotice(n.id);
        render();
      }, { name: 'Dismiss: keep the owner\'s version', fk: `dismiss:${n.id}` })),
    foot(`Not saved: ${what.toLowerCase()} in “${p?.fields.name.v ?? n.list ?? 'a shared list'}”, ${ago(n.at)}. ${why}`));
  }
  for (const c of list) {
    const t = store.get('task', c.task);
    const cur = c.field === 'deleted' ? t.fields.deleted.v : t.fields[c.field]?.v;
    const what = { text: 'Text', status: 'Status', due: 'Deadline', notes: 'Notes' }[c.field] ?? c.field;
    const use = c.field === 'deleted' ? (c.value ? 'Delete it' : 'Restore it') : 'Use other';
    out.push(head(t.fields.text.v || 'Untitled'), card(
      versionRow('Now', describe(c.field, cur)),
      versionRow('Other version', describe(c.field, c.value)),
      actionRow('Keep now', () => store.resolveConflict(c.id, false), { help: 'Keeps the version you have now', fk: `keep:${c.id}` }),
      actionRow(use, () => store.resolveConflict(c.id, true), { help: c.field === 'deleted' ? '' : 'Uses the other version instead', fk: `use:${c.id}` })),
    foot(c.field === 'deleted' ? `Deleted on one device and edited on another, ${ago(c.at)}.`
      : `${what} changed on two devices at once, ${ago(c.at)}. The newest change won: it is the one you have now.`));
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
    els.list.replaceChildren(h('div', { class: 'welcome' }, logo, h('h1', {}, 'Saqme To Do'),
      h('p', {}, 'This window is not connected to Saqme on this computer yet. Open Saqme To Do from your applications, or run ', h('b', {}, 'saqme open'), ' in a terminal.')));
    return;
  }
  els.list.replaceChildren(h('div', { class: 'welcome' }, logo,
    h('h1', {}, 'Saqme To Do'),
    h('p', {}, 'To-do lists in plain markdown. Start on this device right away; sync with your computer through your own Cloudflare account now or later.'),
    h('button', { class: 'btn primary', onclick: () => { ui.welcomeSkipped = true; ls.set('localOnly', '1'); store.addProject('General'); render(); } }, 'Use it on this device'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Already syncing on your computer? Open ', h('b', {}, 'Pair phone'), ' in its settings (Settings › Sync & sharing).'),
      // (in the installed app the camera would open the link in the browser, not here)
      h('li', {}, isStandalone() ? 'Type the code it shows below.' : 'Type the code it shows below, or scan its QR code with the camera.'),
      isIOS() && !isStandalone() ? h('li', {}, 'On iPhone, add Saqme to the Home Screen first (', h('b', {}, 'Share'), ' › ', h('b', {}, 'Add to Home Screen'), '), open it from there and type the code in it.') : null),
    pairingField(),
    h('p', {}, 'Someone sent you an invite to a shared list? ', h('button', { class: 'linkish', onclick: () => joinSheet() }, 'Join it'), '.')));
}

function pair(token, server = '') {
  store.pair(token, server);
  ui.welcomeSkipped = true;
  closeSheet();
  render();
  if (isIOS() && !isStandalone()) showHomeScreenStep(); else toast('Paired — syncing…');
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
  sheet('Use this pairing link?', [
    h('p', {}, 'This device is already paired with a different key. Use the key from this link instead (for example after a new key was issued)?'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { ls.set(`link.${linkId(token)}`, 'declined'); closeSheet(); } }, 'Keep current'),
      h('button', { class: 'btn primary', onclick: () => { ls.set(`link.${linkId(token)}`, 'used'); pair(token); } }, 'Use this link')),
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
store.addEventListener('change', requestRender);
store.addEventListener('rejected', (e) => {
  const r = e.detail[0];
  const t = r.kind === 'task' ? store.get('task', r.id) : null;
  toast(`Not saved${t ? ` (“${t.fields.text.v.slice(0, 40)}”)` : ''}: ${r.reason}`);
});
store.addEventListener('status', () => { renderStatus(); if (ui.view !== 'list' && !ui.editing) requestRender(); });
store.addEventListener('readonly', () => toast('This list is view-only: only its owner can change it.'));
store.addEventListener('shareended', (e) => {
  const { name, kept, elsewhere, gone } = e.detail;
  sheet(`“${name}” is no longer shared with you`, [
    h('p', {}, gone ? 'Your sync service does not have it any more (it was set up again, or this app was paired with another one). It stays here as your own list; ask its owner for a new invite to share it again.'
      : elsewhere ? 'Its owner stopped sharing it. Your other phone kept it as your own list, and it comes here with your sync: changes no longer go to them.'
        : kept ? 'Its owner stopped sharing it. It stays here as your own list: changes no longer go to them, and theirs no longer come here.'
          : 'Its owner stopped sharing it, and had deleted it.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: closeSheet }, 'OK')),
  ]);
  render();
});
store.addEventListener('sharemoved', (e) => {
  sheet(`“${e.detail.name}” moved to your Saqme app`, [
    h('p', {}, 'Your Saqme app took this list over, so this browser no longer syncs it, and it is gone from here. Open it in Saqme from now on.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: closeSheet }, 'OK')),
  ]);
  render();
});
store.addEventListener('savefailed', () => { requestRender(); announce('Changes are not saved on this phone right now.'); });
store.addEventListener('saved', requestRender);
window.addEventListener('hashchange', () => { readPairingLink(); readClaimLink(); readJoinLink(); });
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
    if (was && was !== v) toast(`Saqme was updated to ${v}`);
    return;
  }
  if (v !== bootVersion && !ui.editing && els.sheetWrap.hidden && document.visibilityState === 'visible') location.reload();   // (it says so after)
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') watchVersion(); });
setInterval(() => { if (document.visibilityState === 'visible') watchVersion(); }, 30 * 60_000);

els.addBar.querySelector('.add-plus').append(icon('plus'));
els.tabAdd.append(icon('plus'));
els.tabAdd.addEventListener('click', () => { commitAll(); projectNameSheet(null); });
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
