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
  view: 'list',          // list | settings | trash | conflicts
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
  if (fk && (document.activeElement === document.body || !document.activeElement?.isConnected)) focusKey(fk);
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
const SHARE_NEEDS_SYNC = 'Sharing needs sync with your own Cloudflare account (Settings, Sync): a shared list lives on your sync service, where the people you share it with sync it from.';
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
  const state = { access: 'edit', invite: null, people: null, error: '' };
  const name = h('input', { class: 'field', placeholder: 'Their name, e.g. Nuca', maxLength: 60, autocapitalize: 'words', 'aria-label': 'Their name (only you see it)', enterKeyHint: 'done' });
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
      try {
        state.invite = await shareApi.invite(projectId, alias, state.access);
        name.value = '';
        if (ui.local) loadLocalInfo();
        else if (!store.sharedByMe(projectId)) store.setMeta({ shared: [...(store.meta.shared ?? []), projectId] });
        await refresh();
      } catch (e) { state.error = shareError(e); draw(); }
    };
    name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } };
    name.oninput = () => name.classList.remove('bad');
    const out = [
      h('p', { class: 'sheet-note' }, 'They get a link that works once, for 24 hours. The list stays on your sync service; they sync it from there with a key that reaches this list only.'),
      h('div', { class: 'field-row' }, name),
      h('div', { class: 'field-row' }, accessPick),
      h('p', { class: 'sheet-note' }, ACCESS[state.access].help),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: create }, 'Create invite link')),
      state.error ? h('div', { class: 'callout', role: 'alert' }, state.error) : null,
    ];
    if (state.invite) out.push(inviteBlock(state.invite));
    out.push(h('h3', { class: 'sheet-label' }, 'Shared with'));
    if (!state.people) out.push(h('p', { class: 'sheet-note' }, 'Loading…'));
    else if (!state.people.length) out.push(h('p', { class: 'sheet-note' }, 'Nobody yet.'));
    for (const s of state.people ?? []) out.push(personRow(s, refresh));
    out.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeSheet }, 'Done')));
    const focusName = document.activeElement === name;
    sheet(`Share “${p.fields.name.v}”`, out);
    if (focusName) name.focus();
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

/** The invite just made: its link (copy, QR on larger screens), and what it does. */
function inviteBlock(inv) {
  const box = h('input', { class: 'field', value: inv.link, readOnly: true, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() });
  const block = h('div', { class: 'invite' },
    h('p', { class: 'sheet-note' }, h('b', {}, `Invite for ${inv.share.alias}`), ` · ${ACCESS[inv.share.access].name} · works once, until ${new Date(inv.expiresAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`),
    h('div', { class: 'field-row' }, box, h('button', { class: 'btn primary', onclick: () => copyText(inv.link, 'Invite link copied') }, 'Copy')),
    h('p', { class: 'sheet-note' }, 'Send it to them yourself (a message, an email). Whoever opens it first joins, so send it to them only.'));
  if (matchMedia('(min-width: 560px) and (pointer: fine)').matches) {
    import('./qr.js').then(({ qrMatrix, qrToSvg }) => {
      const svg = qrToSvg(qrMatrix(inv.link, 'M'), { margin: 4, scale: 5 });
      block.append(h('img', { class: 'qr', alt: 'QR code with the invite link', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }));
    }).catch(() => {});
  }
  return block;
}

/** One person a list is shared with: name, access (changeable), joined or invited, and revoke / cancel. */
function personRow(s, refresh) {
  const when = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const state = s.state === 'joined' ? `joined ${when(s.joinedAt)}` : s.state === 'pending' ? `invited ${when(s.createdAt)}, not joined yet` : 'invite expired';
  const act = async (fn, done) => { try { await fn(); toast(done); } catch (e) { toast(e.message); } await refresh(); };
  const access = h('div', { class: 'segmented small', role: 'group', 'aria-label': `Access for ${s.alias}` },
    ...Object.entries(ACCESS).map(([v, a]) => h('button', {
      class: v === s.access ? 'on' : '', 'aria-pressed': String(v === s.access), title: a.help,
      onclick: () => { if (v !== s.access) act(() => shareApi.update(s.id, v), `${s.alias}: ${a.name.toLowerCase()}`); },
    }, a.name)));
  const end = s.state === 'joined'
    ? h('button', { class: 'btn danger', title: 'Their key stops working now; the list stays on their device as their own copy.', onclick: () => act(() => shareApi.revoke(s.id), `${s.alias} no longer has the list`) }, 'Revoke')
    : h('button', { class: 'btn', onclick: () => act(() => shareApi.revoke(s.id), s.state === 'pending' ? 'Invite cancelled' : 'Removed') }, s.state === 'pending' ? 'Cancel invite' : 'Remove');
  return h('div', { class: 'person' },
    h('div', { class: 'who' }, h('div', { class: 'what' }, s.alias), h('div', { class: 'sub' }, state)),
    h('div', { class: 'btn-row' }, access, end));
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
      h('p', {}, `This list is on ${host}. Without a sync of your own, open the invite link itself: its page has “Use it in this browser”, with nothing to install and no account. Or pair this app with your own sync first (Settings, Sync), then join here.`),
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
      h('li', {}, h('b', {}, 'The phone app: '), 'copy the link, then in Saqme: Settings › Sync › Join a shared list.'),
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
 * Paste button in Settings › Sync › Join a shared list.
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
    h('p', {}, 'Its tasks move to Recently deleted (Settings), nothing is erased. You can restore the project from there.'),
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
  return new Date(ms).toLocaleString();
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
  if (ui.view === 'list' && showWelcome()) return renderWelcome();
  if (ui.view === 'settings') return renderSettings();
  if (ui.view === 'trash') return renderTrash();
  if (ui.view === 'conflicts') return renderConflicts();
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
    const trouble = st?.state === 'paused' ? ' Not synced while this app is not paired: your sync service keeps it in step. Pair it again in Settings, Sync; what you change meanwhile waits here.'
      : st && (st.state === 'offline' || st.state === 'error') ? ` Not synced right now: ${st.message || st.state}.` : '';
    if (shared.access === 'view' || trouble) {
      frag.push(h('div', { class: 'callout shared-note', role: trouble ? 'status' : null },
        shared.access === 'view' ? h('b', {}, 'View only. ') : null,
        `Shared with you from ${hostOf(shared.server)}.${shared.access === 'view' ? ' You see the changes as they are made, but can\'t change it.' : ''}${trouble}`));
    }
  }
  const tree = store.tree(proj.id);
  const { active, postponed, closed } = sections(tree);
  const draft = ui.editing?.draft;
  const name = listName(proj);
  frag.push(h('h1', { class: 'sr-only' }, name));
  const list = (label, items) => (items.length ? h('div', { class: 'tasks', role: 'list', 'aria-label': label }, items) : null);
  const activeItems = [];
  for (const n of active) renderNode(activeItems, n, 'active');
  if (draft && !draft.parentId && !draft.afterId) activeItems.push(listItem(0, taskRow(null, 'active', draft)));
  frag.push(list(name, activeItems));
  if (postponed.length) {
    frag.push(h('h2', { class: 'section-label' }, h('span', {}, 'Postponed')));
    const items = [];
    for (const n of postponed) renderNode(items, n, 'postponed');
    frag.push(list('Postponed', items));
  }
  if (closed.length) {
    const show = ls.get('showCompleted') === '1';
    frag.push(h('h2', { class: 'completed-heading' }, h('button', {
      class: `completed-toggle${show ? ' open' : ''}`, 'aria-expanded': String(show), dataset: { fk: 'completed' },
      onclick: () => { ls.set('showCompleted', show ? '0' : '1'); commitAll(); render(); },
    }, icon('chevron'), h('span', {}, 'Completed ', h('span', { class: 'count' }, `· ${closed.length}`)))));
    if (show) { const items = []; for (const n of closed) renderNode(items, n, 'closed'); frag.push(list('Completed', items)); }
  }
  if (!ui.visible.length && !draft) {
    frag.push(h('div', { class: 'empty-state' }, readOnly(proj.id) ? 'No tasks here yet.' : 'No tasks here yet. Add one below.'));
  }
  els.list.replaceChildren(...frag.filter(Boolean));
  if (ui.sel && !ui.visible.includes(ui.sel)) ui.sel = null;
}

// one list item per task (its row + notes); nesting is flat in the page and told by aria-level
const listItem = (depth, ...children) => h('div', { class: 'task-item', role: 'listitem', 'aria-level': String(depth + 1) }, ...children);
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
    store.meta.token ? null : h('div', {}, 'Lists you make in this Safari tab stay in this tab: the Home Screen app starts empty, and Safari may clear them after a week without opening them. Install first, or export them (Settings, Data) and import them in the app.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => { ls.set('installHint', 'off'); render(); } }, 'Got it')));
}

/** Shown while edits cannot be written to the phone's storage (they are kept in memory and retried). */
function saveWarning() {
  return h('div', { class: 'callout', role: 'alert' },
    h('b', {}, 'Changes are not saved on this phone right now. '),
    `${store.saveError} They stay while the app is open and are saved as soon as it works again.${store.meta.token ? '' : ' Export your lists (Settings, Data) to be safe.'}`);
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
  const row = h('div', {
    class: `row${id && ui.sel === id ? ' sel' : ''}`, dataset: { id: id ?? '', fk: id ? `row:${id}` : '' }, style: { '--depth': String(depth) },
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
        class: urgent ? `pill ${tone}` : 'due', title: `Deadline: ${dueLong(due)}`, dataset: { fk: ro ? '' : `due:${id}` }, 'aria-haspopup': ro ? null : 'dialog',
        'aria-label': `Deadline: ${shown}${tone === 'over' ? ', overdue' : ''}`,   // the state in words, not only in colour
      }, shown);
      if (!ro) b.addEventListener('click', () => { commitAll(); dueSheet(id); });
      meta.push(b);
    }
    if (hasKids) {
      const p = progress(node);
      meta.push(h('span', { class: 'item', title: `${p.done} of ${p.total} subtasks closed` }, h('span', { 'aria-hidden': 'true' }, `${p.done}/${p.total}`), h('span', { class: 'sr-only' }, `${p.done} of ${p.total} subtasks closed`)));
    }
    if (notes && !open) meta.push(h('span', { class: 'item', title: 'Has notes or links' }, icon('link'), h('span', { class: 'sr-only' }, 'Has notes')));
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
    wrap.append(ta, h('div', { class: 'notes-actions' }, h('button', { class: 'btn primary', onpointerdown: (e) => e.preventDefault(), onclick: done }, 'Done')));
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
function focusKey(fk) { document.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true }); }
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

// ---------------------------------------------------------------- secondary views
function viewHeader(title, back = 'list') {
  const go = () => { ui.view = back; render(); els.list.scrollTop = 0; };
  return h('div', { class: 'view-header', onclick: go },
    h('button', { class: 'back', 'aria-label': back === 'list' ? 'Back to the list' : 'Back to settings', dataset: { fk: `back:${title}` }, onclick: (e) => { e.stopPropagation(); go(); } }, icon('back')),
    h('h1', {}, title));
}
const label = (text) => h('h2', { class: 'section-label flush' }, h('span', {}, text));   // settings: in line with the rows
function setting(title, sub, control) {
  return h('div', { class: 'setting' }, h('div', { class: 'label' }, h('div', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), control);
}
function linkRow(title, sub, fn) {
  return h('button', { class: 'setting link', onclick: fn }, h('div', { class: 'label' }, h('div', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), icon('chevron'));
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

function renderSettings() {
  const out = [viewHeader('Settings')];
  out.push(label('Appearance'));
  out.push(setting('Theme', 'Auto follows the light / dark setting of this device',
    segmented([['dark', 'Dark'], ['light', 'Light'], ['auto', 'Auto']], ls.get('theme', 'auto'), (v) => { ls.set('theme', v); applyTheme(); render(); }, 'Theme')));

  out.push(label('Reminders'));
  const at = h('input', { class: 'time-input', type: 'time', value: store.setting('notifyAt', '10:00').padStart(5, '0'), 'aria-label': 'Daily summary time' });
  at.addEventListener('change', () => { if (at.value) { store.setSetting('notifyAt', `${+at.value.slice(0, 2)}:${at.value.slice(3, 5)}`); syncSharePush(); } });
  out.push(setting('Daily summary at', 'Tasks due today or overdue, one notification (shared with the desktop)', at));
  out.push(...notificationSettings());

  out.push(label('Sync'));
  if (ui.local) out.push(...localSyncSettings());
  else {
    out.push(setting(statusText(), store.meta.token ? `This device: ${store.meta.deviceId}`
      : 'Sync is set up from a computer: in the Saqme app there, Settings, Sync, Set up sync. Then type the code its Pair phone shows here, or scan its QR code.',
      store.meta.token ? h('button', { class: 'btn', onclick: () => store.sync({ force: true }) }, 'Sync now') : null));
    if (store.meta.token) {
      out.push(setting('Pair a phone', 'A one-time code (and the QR code) for the app on another phone, or on this phone\'s Home Screen', h('button', { class: 'btn', onclick: showPairing }, 'Show')));
      out.push(setting('Server', store.meta.server ? new URL(store.meta.server).host : location.host, h('button', { class: 'btn danger', title: turnOffHelp('device'), onclick: confirmUnpair }, 'Unpair')));
    } else out.push(pairingField());
  }
  out.push(...sharedListSettings());
  if (ui.local) out.push(...localUpdateSettings());

  out.push(label('Data'));
  if (store.saveError) out.push(saveWarning());
  out.push(setting('Export lists', 'Markdown files in a zip, the same format as the desktop app', h('button', { class: 'btn', onclick: exportLists }, 'Export')));
  out.push(setting('Import lists', 'Markdown files or a zip of them. Tasks already here are skipped.', h('button', { class: 'btn', onclick: importLists }, 'Import')));
  const n = store.conflicts().length;
  const nn = allNotices().length;
  out.push(linkRow('Conflicts', [n ? `${n} change${n > 1 ? 's' : ''} made on two devices at once` : '', nn ? `${nn} not saved in a shared list` : ''].filter(Boolean).join(', ') || 'None', () => { ui.view = 'conflicts'; render(); }));
  out.push(linkRow('Recently deleted', 'Restore deleted tasks and projects', () => { ui.view = 'trash'; render(); }));

  out.push(label('About'));
  out.push(h('div', { class: 'callout' }, ui.local
    ? 'Saqme To Do. Your lists are the markdown files in the lists folder above; this window, AI assistants and any editor can change them.'
    : store.meta.token
      ? 'Saqme To Do. Your lists live in your own Cloudflare account; this device keeps a full offline copy and syncs in the background.'
      : 'Saqme To Do. Your lists are stored on this device only. Export them now and then, or pair with your own sync to keep a copy elsewhere.'));
  if (!ui.local && bootVersion) {
    out.push(setting(`Version ${bootVersion}`, 'It updates by itself with your sync service (the computer that set it up updates it).', null));
  }
  els.list.replaceChildren(...out);
}

/** Settings › Sync: join a list someone shares, and the lists shared with this device (each can be left). */
function sharedListSettings() {
  const out = [label('Shared lists')];
  out.push(setting('Join a shared list', ui.local ? 'Paste the invite link someone sent you (or run saqme join LINK). Works without cloud sync too.'
    : store.meta.token ? 'Paste the invite link someone sent you. Your sync service keeps the list for this app and your other phones.'
      : 'Paste the invite link someone sent you. No sync of your own needed: open the invite link itself, and its page opens the list in this browser.',
  h('button', { class: 'btn', onclick: () => joinSheet() }, 'Join…')));
  const mine = ui.local ? (ui.local.shares ?? []) : store.shares();
  for (const s of mine) {
    const p = store.get('project', s.projectId);
    const st = store.shareStatus.get(s.id) ?? s.status;
    const status = st?.state === 'offline' || st?.state === 'error' || st?.state === 'paused' ? ` · ${st.message || st.state}` : '';
    const where = inBrowser(s) ? ' · in this browser' : '';
    const leave = h('button', { class: 'btn danger', onclick: () => confirmLeave(s.projectId, s) }, 'Leave');
    out.push(setting(p && !ui.local ? listName(p) : (p?.fields.name.v ?? s.name), `From ${hostOf(s.server)} · ${ACCESS[s.access]?.name ?? s.access}${where}${status}`,
      inBrowser(s) ? h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => moveToAppSheet(s) }, 'Move to my Saqme app'), leave) : leave));
  }
  return out;
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

/** Settings > Sync > Set up sync: the local server runs the cloud setup; follow it until it ends. */
async function startCloudSetup() {
  try { ui.cloudSetup = await api('local/cloud-setup', {}); } catch (e) { toast(e.message); return; }
  render();
  while (ui.cloudSetup?.running) {
    await new Promise((r) => setTimeout(r, 1000));
    try { ui.cloudSetup = await api('local/cloud-setup'); } catch { break; }
    if (ui.view === 'settings' && !ui.editing) render();
  }
  if (ui.cloudSetup?.result?.ok) {
    announce('Sync is set up.');
    await loadLocalInfo();
    render();
    showPairing();   // what comes next: the phone
  } else render();
}

function localSyncSettings() {
  const l = ui.local;
  const out = [setting('Lists folder', l.lists, h('button', { class: 'btn', onclick: () => copyText(l.lists, 'Folder path copied') }, 'Copy path'))];
  const c = l.cloud;
  const run = ui.cloudSetup;
  if (!c && run?.running) {
    out.push(h('div', { class: 'callout', role: 'status' },
      h('div', {}, h('b', {}, 'Setting up sync. '), 'Sign in to Cloudflare in the browser (or create a free account) and click Allow. No browser opened? Use the sign-in link below.'),
      setupOutput(run.lines),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: async () => { ui.cloudSetup = await api('local/cloud-setup/cancel', {}).catch(() => ui.cloudSetup); render(); } }, 'Cancel'))));
    return out;
  }
  if (!c) {
    out.push(setting('Sync with your phone', `Off for now. ${SETUP_HELP}`,
      h('button', { class: 'btn primary', title: SETUP_HELP, onclick: startCloudSetup }, 'Set up sync')));
    if (run?.result && !run.result.ok) {
      out.push(h('div', { class: 'callout', role: 'alert' }, h('div', {}, h('b', {}, 'Sync was not set up. '), `${run.result.message} ${run.result.next || ''} Nothing changed on this computer.`), run.lines.length ? setupOutput(run.lines) : null));
    }
  } else {
    const cloudText = c.state === 'synced' ? `On, with ${c.label}${c.lastSync ? ` · synced ${ago(c.lastSync)}` : ''}${c.conflicts ? ` · ${c.conflicts} conflicts to look at on your phone` : ''}`
      : `${c.label}: ${c.message || c.state}`;
    out.push(setting('Cloud sync', cloudText, null));
  }
  if (!c) {
    // like the Windows app: a pairing link from a device that already syncs connects this computer too
    out.push(setting('Already syncing elsewhere?', 'Paste the pairing link from a device that already syncs (its Settings, Sync, Pair phone).', null));
    const input = h('input', { class: 'field', placeholder: 'Paste a pairing link to sync', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
    const go = () => {
      const p = parsePairingLink(input.value);
      if (!p?.server) { input.classList.add('bad'); toast('That is not a pairing link (https://saqme.<name>.workers.dev/#pair=...).'); return; }
      confirmSyncWith(p.server, async () => {
        try { await api('local/connect', { link: input.value.trim() }); toast('Connected. Syncing starts in a few seconds.'); setTimeout(loadLocalInfo, 2500); }
        catch (e) { input.classList.add('bad'); toast(e.message); }
      });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    out.push(h('div', { class: 'field-row' }, input, h('button', { class: 'btn primary', onclick: go }, 'Connect')));
  }
  if (c) {
    out.push(setting('Pair phone', 'The QR code and a one-time code that connect your phone to the same lists', h('button', { class: 'btn', onclick: showPairing }, 'Show')));
    out.push(setting('Turn off sync', turnOffHelp('computer'), h('button', { class: 'btn danger', title: turnOffHelp('computer'), onclick: () => {
      sheet('Turn off sync?', [h('p', {}, turnOffHelp('computer')), h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => { closeSheet(); try { await api('local/disconnect', {}); await loadLocalInfo(); render(); } catch (e) { toast(e.message); } } }, 'Turn off'))]);
    } }, 'Turn off')));
  }
  if (l.guarded) {
    out.push(h('div', { class: 'callout' },
      `${l.guarded} tasks disappeared from the lists folder at once, so deleting them everywhere is paused. If you removed them on purpose, confirm it.`,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onclick: async () => {
        try { await api('local/allow-deletes', {}); toast('Confirmed. They will be deleted everywhere.'); } catch (e) { toast(`Could not confirm: ${e.message}`); }
      } }, 'Delete them'))));
  }
  return out;
}

/**
 * Settings > Updates in the Linux/macOS window (local/updater.mjs): this version, the newest one with Update now,
 * what an update is doing, how the last one ended, the Cloudflare sign-in that finishes a Worker update, and
 * "Install updates automatically". The window refreshes it with the rest of ui.local while Settings are open.
 */
function localUpdateSettings() {
  const u = ui.local?.update;
  const out = [label('Updates')];
  if (!u?.supported) {
    out.push(setting(`Version ${ui.local?.version ?? ''}`.trim(), 'This copy runs from a source folder: update it with git pull, then run scripts/setup.sh.', null));
    return out;
  }
  const run = u.running;
  const steps = { downloading: 'Downloading it and checking it against the release.', installing: 'Installing. The app restarts by itself in a moment; your lists are not touched.', worker: 'Updating your sync service.', restarting: 'Restarting the app.' };
  if (run) out.push(setting(`Updating to ${run.version}…`, steps[run.state] ?? 'Working on it.', null));
  else if (u.available) {
    out.push(setting(`Update available: ${u.latest}`, `You have ${u.current}. It installs in the background, your sync service too, and the app restarts; your lists are not touched.`,
      h('button', { class: 'btn primary', onclick: () => updateAction('now') }, 'Update now')));
  } else {
    out.push(setting(`Version ${u.current}`, u.checking ? 'Checking for updates…' : u.error ? `Could not check for updates: ${u.error}` : `Up to date${u.checkedAt ? ` · checked ${ago(u.checkedAt)}` : ''}`,
      h('button', { class: 'btn', onclick: () => updateAction('check') }, 'Check now')));
  }
  const signIn = () => h('button', { class: 'btn primary', onclick: () => updateAction('login') }, 'Sign in');
  if (u.login?.running) {
    out.push(h('div', { class: 'callout', role: 'status' }, h('b', {}, 'Signing in to Cloudflare. '), 'Sign in in the browser and click Allow.',
      u.login.url ? h('div', {}, 'No browser opened? ', h('a', { href: u.login.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the sign-in page')) : null));
  } else if (u.worker?.pending) {
    out.push(setting(u.worker.needsLogin ? 'Sign in to Cloudflare to finish the update' : 'Your sync service is not updated yet', u.worker.message,
      u.worker.needsLogin ? signIn() : h('button', { class: 'btn', onclick: () => updateAction('worker') }, 'Try again')));
  }
  if (u.login?.message && !u.login.running) out.push(h('div', { class: 'callout', role: 'alert' }, u.login.message));
  if (u.result && !u.result.ok && !run) {
    out.push(h('div', { class: 'callout', role: 'alert' }, h('div', {}, h('b', {}, `${u.result.message} `), u.result.next ?? ''),
      h('div', { class: 'btn-row' }, u.result.needsLogin ? signIn() : h('button', { class: 'btn', onclick: () => updateAction('now') }, 'Try again'))));
  }
  out.push(setting('Install updates automatically', 'When the app has not been used for a while, with your sync service. Off: only with Update now.',
    segmented([['on', 'On'], ['off', 'Off']], u.auto ? 'on' : 'off', (v) => updateAction('auto', { on: v === 'on' }), 'Install updates automatically')));
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
    h('p', {}, code ? 'Expired? Settings › Sync › Pair a phone, here or on your computer, shows a new one.' : 'The link is the key to your lists: keep it private.'),
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
    if (JSON.stringify(ui.local) !== was && ui.view === 'settings' && !ui.editing) requestRender();
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

function pairingField() {
  const input = h('input', { class: 'field', placeholder: 'Pairing code or link', 'aria-label': 'Pairing code or link', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false });
  const go = () => {
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
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return h('div', { class: 'field-row' }, input, h('button', { class: 'btn primary', onclick: go }, 'Pair'));
}

// ---------------------------------------------------------------- notifications (Web Push)
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function notificationSettings() {
  const out = [];
  if (ui.local) {
    out.push(setting('Notifications', 'Shown by your computer while Saqme runs (it starts when you log in)', null));
    return out;
  }
  if (!pushSupported()) {
    out.push(setting('Notifications', isIOS() && !isStandalone()
      ? 'On iPhone, notifications work only in the installed app (iOS 16.4 or later): Share → Add to Home Screen, then open Saqme from the Home Screen.'
      : 'This browser does not support web push notifications.', null));
    return out;
  }
  const perm = Notification.permission;
  const on = perm === 'granted' && ls.get('push') === '1';
  const browserOnly = !store.meta.token && browserShares().length > 0;   // reminders from the lists' owner's server
  if (!store.meta.token && !browserOnly) {
    out.push(setting('Notifications', 'Pair this device first.', null));
  } else if (perm === 'denied') {
    out.push(setting('Notifications', 'Blocked. Allow them in iPhone Settings → Notifications → Saqme.', null));
  } else if (on) {
    out.push(setting('Notifications', browserOnly ? 'On for the lists shared with you here' : 'On for this device', h('button', { class: 'btn', onclick: testPush }, 'Send test')));
    out.push(setting('', '', h('button', { class: 'btn danger', onclick: async () => { await disablePush(); render(); } }, 'Turn off')));
  } else {
    out.push(setting('Notifications', isIOS() && !isStandalone() ? 'Install the app to the Home Screen first (Share → Add to Home Screen).'
      : browserOnly ? 'Reminders for the lists shared with you here: 15 minutes before timed deadlines, and a daily summary at your time. Their owner\'s sync service sends them; it learns this browser\'s push address and time zone.'
        : 'Reminders 15 minutes before timed deadlines, and a daily summary.',
    h('button', { class: 'btn primary', onclick: enablePush }, 'Enable')));
  }
  return out;
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
function renderTrash() {
  const out = [viewHeader('Recently deleted', 'settings')];
  const items = store.trash();
  if (!items.length) out.push(h('div', { class: 'empty-state' }, 'Nothing deleted.'));
  for (const r of items) {
    const isProject = r.kind === 'project';
    const proj = isProject ? null : store.get('project', r.fields.place.v.project);
    out.push(h('div', { class: 'trash-item' },
      h('div', { class: 'what' }, isProject ? `Project “${r.fields.name.v}”` : (r.fields.text.v || 'Untitled')),
      h('div', { class: 'sub' }, `${isProject ? 'Project' : `in ${proj?.fields.name.v ?? '?'}`} · deleted ${ago(r.fields.deleted.ts)}`),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => {
        if (isProject) store.restoreProject(r.id); else store.restoreTask(r.id);
        toast('Restored');
      } }, icon('restore'), 'Restore'))));
  }
  els.list.replaceChildren(...out);
}

function describe(field, v) {
  if (field === 'status') return statusOf(v).name;
  if (field === 'due') return v ? dueLong(v) : 'No deadline';
  if (field === 'deleted') return v ? 'Deleted' : 'Kept';
  return v || '(empty)';
}

/** Changes a shared list's server did not take (the list became view-only, or its owner deleted it). */
function allNotices() { return [...store.notices(), ...(ui.local?.notices ?? [])]; }

function renderNotices(out) {
  for (const n of allNotices()) {
    const p = store.get('project', n.projectId);
    const what = { text: 'Text', status: 'Status', due: 'Deadline', notes: 'Notes', deleted: 'Delete', new: 'New task' }[n.field] ?? n.field;
    const value = n.field === 'deleted' ? 'Deleted' : describe(n.field, n.value);
    out.push(h('div', { class: 'conflict-item' },
      h('div', { class: 'what' }, n.text || 'Untitled'),
      h('div', { class: 'sub' }, `Not saved · ${what} · in “${p?.fields.name.v ?? n.list ?? 'a shared list'}” · ${ago(n.at)}`),
      h('div', { class: 'choice' }, h('div', { class: 'who' }, 'Your version, not saved'), value),
      h('p', { class: 'sheet-note' }, n.reason === 'this shared list is view-only' ? 'The list is view-only for you, so the owner\'s version stays.' : `The owner's server did not take it: ${n.reason}.`),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => copyText(String(n.field === 'deleted' ? n.text : value), 'Copied') }, 'Copy'),
        h('button', { class: 'btn primary', onclick: async () => {
          if (n.local) { try { await api('local/notices/dismiss', { id: n.id }); await loadLocalInfo(); } catch (e) { toast(e.message); } } else store.dismissNotice(n.id);
          render();
        } }, 'Dismiss'))));
  }
}

function renderConflicts() {
  const out = [viewHeader('Conflicts', 'settings')];
  const list = store.conflicts();
  const notices = allNotices();
  if (!list.length && !notices.length) out.push(h('div', { class: 'empty-state' }, 'No conflicts. Edits made on two devices at the same time show up here.'));
  else if (list.length) out.push(h('div', { class: 'callout' }, 'The same thing was changed on two devices before they synced. The newest change won; the other one is kept here so you can pick it instead.'));
  renderNotices(out);
  for (const c of list) {
    const t = store.get('task', c.task);
    const cur = c.field === 'deleted' ? t.fields.deleted.v : t.fields[c.field]?.v;
    const what = { text: 'Text', status: 'Status', due: 'Deadline', notes: 'Notes', deleted: 'Deleted vs. edited' }[c.field] ?? c.field;
    out.push(h('div', { class: 'conflict-item' },
      h('div', { class: 'what' }, t.fields.text.v || 'Untitled'),
      h('div', { class: 'sub' }, `${what} · ${ago(c.at)}`),
      h('div', { class: 'choice' }, h('div', { class: 'who' }, 'Now'), describe(c.field, cur)),
      h('div', { class: 'choice' }, h('div', { class: 'who' }, 'Other version'), describe(c.field, c.value)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => store.resolveConflict(c.id, false) }, 'Keep now'),
        h('button', { class: 'btn primary', onclick: () => store.resolveConflict(c.id, true) }, c.field === 'deleted' ? (c.value ? 'Delete it' : 'Restore it') : 'Use other'))));
  }
  els.list.replaceChildren(...out);
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
      h('li', {}, 'Already syncing on your computer? Open ', h('b', {}, 'Pair phone'), ' in its settings (Settings › Sync).'),
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
els.logo.addEventListener('click', () => {
  commitAll(); ui.view = ui.view === 'list' ? 'settings' : 'list'; render(); els.list.scrollTop = 0;
  if (ui.view === 'settings') loadLocalInfo();
});
els.sync.addEventListener('click', () => {
  commitAll();
  if (store.meta.token && store.status.state !== 'syncing') store.sync({ force: true });
  toast(statusText());
});
els.conflicts.addEventListener('click', () => { commitAll(); ui.view = 'conflicts'; render(); });
store.addEventListener('change', requestRender);
store.addEventListener('rejected', (e) => {
  const r = e.detail[0];
  const t = r.kind === 'task' ? store.get('task', r.id) : null;
  toast(`Not saved${t ? ` (“${t.fields.text.v.slice(0, 40)}”)` : ''}: ${r.reason}`);
});
store.addEventListener('status', () => { renderStatus(); if (ui.view === 'settings' && !ui.editing) requestRender(); });
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
// the local app's sync status, while its settings are on screen (a Worker's answer never changes: no polling there)
setInterval(() => { if (ui.local && document.visibilityState === 'visible' && ui.view === 'settings') loadLocalInfo(); }, 5000);
// (and its shared lists, less often, anywhere: access can change, a share can end, an invite link can come in)
setInterval(() => { if (ui.local && document.visibilityState === 'visible' && ui.view !== 'settings') loadLocalInfo(); }, 3000);
store.startAuto();
syncTimeZone();
syncSharePush();
watchVersion();
