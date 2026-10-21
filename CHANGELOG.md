# Changes

## Unreleased

**Windows: a calmer, grouped look for the list and Settings.**

- **Grouped cards, one line per row**, like the iPhone's Settings: related rows sit together in a rounded card,
  a shade lighter than the window in both themes, with hairlines between them that start where the text starts.
  A row is one line: an optional icon, its name, and on the right a short value ("Off", "10:00", "Synced 2 min
  ago", "1.1.0"), a chevron, a switch or a small button. The explanations that sat under each setting are now a
  short note under the card, the value on the right, or the tooltip (and what a screen reader reads).
- **The list:** each list's tasks are a card; subtasks are indented inside it with their hairlines indented too.
  The deadline, the subtask count and the notes mark are on the right of the task's line (under it in a window
  narrower than 380 px, so the text keeps its line); open notes are quiet text under the task. *Postponed* and
  *Completed* are cards under their headings, and *Completed* opens and closes from its heading. The add line is
  a card of its own at the bottom. Statuses, drag and drop, Alt+Up / Down, editing, Ctrl+Z and the notices work
  as before; selecting with the arrow keys is quicker in long lists.
- **Settings** is two cards of pages (*General*, *Notifications*, *Sync & sharing*, *Your lists*; then *App*:
  *Updates*, *About*), each with an icon and how it stands. On every page actions are rows (*Sync now*, *Set up
  sync*, *Open the lists folder*; *Turn off sync* in red), the link boxes are rows with their button, and
  *Advanced* is a row that opens the rest of its card. *Share*, *Conflicts*, *Recently deleted* (now grouped by
  list), *Pair phone* and *Keyboard shortcuts* look the same way; in *Share*, each person is one row whose menu
  changes their access or revokes it.
- The design tokens have the card colours and sizes (`design/tokens.json`; docs/design.md, "Grouped lists"), and
  the tests check their contrast in both themes. The self-check now also checks the cards (corners, hairlines,
  one line per row), and `scripts/dev/uia-check.ps1` what a screen reader meets in them;
  `scripts/dev/render-widget.ps1 -Open` renders the list as it looks in use (notes open, Completed shown).

**Windows: Settings is easier to read, and the version is easy to find.**

- **Settings is a short list of pages** instead of one long page: *General* (theme, start with Windows,
  keyboard shortcuts), *Notifications* (daily summary, test notification), *Sync & sharing* (set up sync or how
  it stands, pair phone, conflicts, join and leave shared lists), *Your lists* (lists folder, recently deleted),
  *Updates* and *About*. Each row shows how it stands, with a violet dot when something needs a look (an update,
  a conflict, paused deletions). Esc goes back one level; the cloud icon opens Sync & sharing directly.
- **Rare and risky actions moved down:** *Turn off sync* is under **Advanced** at the bottom of Sync & sharing,
  next to how to get a new sync key and (new) a button that opens the sync log. *Deletions paused* shows below
  the everyday rows when it happens.
- **The version** is on a quiet line at the bottom of every Settings page, in *About* (with where the app is
  installed and an *Open folder* for your data), and in the tray icon's tooltip. When an update is available or
  waits for the Cloudflare sign-in, the line gets a dot and says so; click it for Updates.
- Keyboard and screen readers: opening a page puts focus on its title (its Back button), going back returns to
  the row you came from, and a page that refreshes (sync status) keeps focus where it was. *Advanced* reports
  expanded or collapsed to Narrator.
- Nothing was removed and settings are kept as they were (same file, same values). The self-check covers every
  page, every setting on it and the version line; `scripts/dev/uia-check.ps1` walks all pages through UI
  Automation, and `scripts/dev/render-widget.ps1` can render any page, full length (`-Full`) and at its most
  crowded (`-Busy`).

## 1.1.0

**Updates without commands.** From this version on the app updates itself, your Worker and the phone app with
it; you never need to run a command after an update. **Installs from before 1.1.0 need setup run once more**
(the one-liner, `setup.cmd` or `scripts/setup.sh`, as when you installed it) to get the updater; it keeps your
lists, settings and sync.

- The app checks this repository's GitHub Releases when it starts and about once a day. **Settings > Updates**
  shows *Update available* with **Update now**, and **Install updates automatically** (on by default) installs
  it while the app is idle. Linux and macOS: `saqme update` too.
- The download is checked against the release's manifest (size and SHA-256) before anything is installed.
  Each version gets a folder of its own next to the one that runs, has to pass its self-check, and only then
  becomes the current one (one atomic switch). The version before stays: if the new one does not start, the app
  goes back to it by itself and says so. Lists and data are never touched.
- **Your Worker is updated first**, code and phone app only: its keys, database and pairings stay. It uses the
  Cloudflare sign-in setup made and the Node.js and wrangler setup installed (missing ones come back quietly).
  If the sign-in expired, Settings > Updates shows **Sign in to Cloudflare to finish the update**, and the
  update finishes after one click in the browser. If the Worker cannot be updated, the apps update only when
  they work with the Worker that runs; otherwise the whole update waits and says why, so sync never breaks
  halfway.
- **The Worker updates its own database** on the first request after a deploy (no more `wrangler d1
  migrations apply`), also on databases wrangler migrated before; two first requests at once apply a
  migration once.
- **Versions talk.** `/api/config`, `/api/health` and every sync answer say the Worker's version and API
  level, so the apps tell "your sync service is not updated yet" from an error; old and new apps and Workers
  keep syncing with each other. The phone app picks up a new version when it is opened or comes back to the
  foreground, and says *Saqme was updated to …*.
- **Releases:** a `vX.Y.Z` tag builds and publishes them (`.github/workflows/release.yml`); the version is
  written in one place, `worker/package.json`. See CONTRIBUTING.md, "How to ship an update".
- Setup: from a WSL folder on Windows (`\\wsl.localhost\...`) it works now (it used PowerShell's own form of
  the path, which Node.js and cmd.exe cannot open). Run from the web, it installs the newest release, checked
  against its checksum. On Windows the cloud part downloads Node.js just for Saqme when there is none (no
  winget, no administrator prompt).
- Setup's cloud part on an account that already has Saqme's database but no saved state (a new computer, a
  reinstall) reuses the access key of the desktop app instead of stopping with "already set up in this
  Cloudflare account", and leaves the Worker's keys as they are unless it is a first setup or a new key
  (`-RotateToken`). An update never touches them.
- A setup or an update that stops halfway always starts the app again if it was running.

**Shared lists.** Share a list with someone: right-click its tab (long-press on the phone) and choose
**Share…**, give the person a name only you see, pick *Can edit* or *Can view*, and send them the invite
link. It works once, for 24 hours. The list stays on your own sync service; they sync that one list from
there with a key of their own (no Cloudflare account needed on their side, and not even Saqme), next to
their own sync or without one. The Share view lists everyone who has the list, with their access, when they
joined, and **Revoke** (their key stops working at once) or **Cancel invite**. Shared tabs show a small badge.

- **The invite page** offers three ways in: use the list right now in the browser (nothing to install, no
  account, no sync), open it in Saqme To Do (setup now registers `saqme://` links on Windows, Linux and
  macOS; the app always asks first), or install Saqme (the one-line installers are on the page). Anywhere,
  pasting the link into **Settings > Sync > Join a shared list** works too (`saqme join LINK` on Linux and
  macOS). The phone app also offers to join when the link is on the clipboard, where the browser lets it look
  (on iPhone use Paste in that setting).
- **Started in the browser?** The list's menu there has **Move to my Saqme app**: a one-time link (and QR
  code) that your app opens to take the list over, with no new invite; the browser copy then stops.
- **Phones talk to their own sync service only.** A phone app paired with your sync reaches the lists
  shared with you through it: your Worker joins, syncs and leaves them for the phone, server to server
  (only those three steps, only with an https address, never as an open proxy), and keeps their keys, so
  every phone of yours gets the list from one invite. Leaving on one phone leaves on all of them. The phone
  app's security policy is back to its own address only.
- **Reminders for shared lists on phones:** your own Worker reads the deadlines of the lists shared with you
  and reminds you of them like of your own, at your summary time and in your time zone. In the browser
  (no sync of your own), **Settings > Notifications** asks the list's owner's service to remind you, of that
  list only, at your time. Never both at once.
- On a computer the shared list is a markdown file like the others, so editors and AI assistants keep
  working on it; its changes go to its owner's service only (`lists/.remotes.json` says which file is
  whose; the keys are in `sync/remotes.json`). A name you already have becomes "Groceries (from nuca)"; the
  phone app shows its tab that way too.
- Your own sync, several lists from different people, and your own lists shared out all work side by side.
  Turning your own sync off keeps the shared lists (on a phone they wait until it is paired again).
- A view-only list cannot be changed in the apps. Edited in its file anyway, it goes back to the owner's
  version, and what was typed is kept under **Conflicts** as *Not saved*, to copy.
- **Leave** replaces Delete on a shared tab: the list goes from your device, nothing changes on the owner's.
  If the owner stops sharing it, it stays with you as your own list, and the app says so.
- Moving a task between your own list and a shared one copies it there and deletes it here (restorable).
- The Worker's new database tables come with the update by themselves (see above), on both sides if both
  have sync. A manual test plan: `docs/testing-shared-lists.md`.

Fixes from testing on a real iPhone, a real Windows install and a real Cloudflare deploy.

- **Windows: dragging a task (or Alt+Up / Alt+Down) deleted it.** Every drag removed the dragged task and its
  subtasks from the list, and sync then deleted them on every device. Moves now never drop a task (a drop
  that cannot be done changes nothing), and every save is checked: a change that would remove tasks nobody
  deleted is not saved. New on Windows: Ctrl+Z undoes the last change, and *Settings > Data > Recently
  deleted* restores deleted tasks for 30 days (with sync, also those deleted on other devices).

- iPhone: the app on the Home Screen pairs with a short one-time code (shown under every QR code, and in
  Safari right after the link pairs it). iOS starts Home Screen apps unpaired, so the link alone never
  reached them. Pasting the link still works; the key now leaves the address bar at once.
- Windows: the tab strip ends before the buttons on its right; projects that don't fit fade out and are
  listed under a "more" button, the current one is always scrolled into view, "+" stays visible, and long
  names end in "…". Rows waste less space on the left (phone rows a little too).
- Windows: the switch knob, the QR code's white frame and the close button's hover glyph are drawn again.
- Phone: before you start, the header is just the logo, and it opens Settings.
- Setup: with `-DeviceLogin` it says to open the address and enter the code (shown where they stand out);
  it stops with an explanation when run from inside another app's package (a Store app's or an AI
  assistant's shell), where Windows would keep what it installs out of the app's sight. The installer test
  no longer leaves a copy of the app running under the real app's name.

## 1.0.0

The first public version.

- Markdown to-do lists as files, edited in the apps, in any editor or by an AI assistant: a desktop widget on
  Windows, an app window on Linux and macOS, and the phone app (iPhone, Android, any browser).
- Works on one device without an account. Optional sync through your own free Cloudflare account, set up
  from the app's Settings > Sync, merging per task and per field, with conflicts and deletes kept for review.
- Subtasks, seven statuses, deadlines with times, notes with links, reminders, keyboard use and screen
  reader support throughout.
