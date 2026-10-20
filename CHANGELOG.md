# Changes

## Unreleased

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
- The Worker needs new database tables: after updating, run setup's cloud part once (`-Cloud` / `--cloud`),
  on both sides if both have sync. A manual test plan: `docs/testing-shared-lists.md`.

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
