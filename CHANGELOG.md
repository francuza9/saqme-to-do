# Changes

## Unreleased

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
