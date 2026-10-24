# Saqme without an account

Every Saqme app works with no Cloudflare account and no sync: the lists stay on that device, and nothing is
sent anywhere. Sync is something you can add later ([setup.md, section 3](setup.md#3-cloud-sync-cloudflare-account-and-login)).
This page lists what you get on each platform, how to start, and what only works with sync.

| Platform | Works without an account? | How to start | What needs sync, or is missing |
|---|---|---|---|
| **Windows** | Yes, by default | the PowerShell one-liner or `setup.cmd` ([setup.md, 1](setup.md#1-install-on-windows)) | lists on phones and other computers; sharing a list; connecting Claude or ChatGPT (the AI connector) |
| **Linux** | Yes, by default | `curl -fsSL …/scripts/setup.sh \| bash` ([setup.md, 2](setup.md#2-install-on-linux-or-macos)) | the same. Needs Node.js 22.13+; setup downloads one. It runs on x64 with glibc 2.17+ (Ubuntu 18.04, CentOS 7 and newer) and on arm64 with glibc 2.28+; musl (Alpine) needs your own Node.js |
| **macOS** | Yes, by default | the same command | the same. macOS 11 or newer (setup downloads Node.js 22 on 11–13.4, 24 on 13.5+) |
| **Android** | Yes | open <https://francuza9.github.io/saqme-to-do/> in Chrome, **Use it on this device**, then **Install app** | **reminders** (push notifications come from your sync service); lists on other devices. Back up with **Export lists** |
| **iPhone** | Yes | the same address in Safari, **Use it on this device**, then **Share > Add to Home Screen** and use it from there | the same as Android |
| **WSL** | (use the Windows app) | the Linux command prints the Windows one-liner; `--app` installs the Linux app inside WSL | — |

## What "without an account" means on each

- **Windows, Linux, macOS:** the full app. Your lists are markdown files in a folder (`%APPDATA%\SaqmeToDo\lists`,
  `~/.local/share/saqme/lists`, `~/Library/Application Support/Saqme To Do/lists`). An AI assistant on the computer
  can edit them ([ai.md, With the files](ai.md#with-the-files)); connecting Claude or ChatGPT by URL needs sync. Reminders come from the computer itself (Windows notifications, `notify-send`, Notification
  Center), and the app updates itself from GitHub releases. **Settings > Sync & sharing** shows *Set up sync*,
  and nothing happens there until you choose it.
- **Linux and macOS: what has to match the system.** The app is JavaScript run by Node.js (it uses the built-in
  `node:sqlite`). There is no compiled code of Saqme's own, so the only binary is Node.js. Setup uses yours when
  it is 22.13 or newer. Otherwise it downloads the official build, or on x64 Linux with glibc 2.17–2.27 the
  Node.js project's glibc-2.17 build from unofficial-builds.nodejs.org (checksum-checked; see
  [setup.md](setup.md#requirements-linux-and-macos)).
- **Phones (and any browser):** the phone app from the project's GitHub Pages, a static copy of `worker/public`.
  The lists live in the browser's storage on that phone (IndexedDB), and the app works offline once it has loaded.
  Install it to the Home Screen: then the system keeps that storage, and on iPhone the Home Screen app has storage
  of its own. **Settings > Your lists > Export lists** saves a zip of markdown files in the desktop format, and
  **Import lists** reads one back; importing twice adds nothing.
- **Reminders on phones need sync.** A web app cannot schedule a notification for later or wake itself up at a
  deadline, so on iPhone and Android the reminders are Web Push messages that your sync service sends. Without
  sync, **Settings > Notifications** says *Need sync* and links to Sync & sharing. The daily summary time you set
  there is used once the phone is paired.

## How this is checked

| What | Where | Result (2026-10-22) |
|---|---|---|
| Linux app on a scratch folder: self-check, `serve`, `status` says *Cloud sync: off* | `node local/saqme.mjs selftest`, `serve --data <temp>` (WSL, Node.js 24) | passed |
| setup.sh picks the right Node.js, or stops with advice: glibc 2.17 / 2.27 / 2.28+, arm64, macOS 10.15 / 12 / 13.5+, bad checksum, WSL | `worker/test/node/setup-node.test.js` (the real setup.sh against stand-in downloads, temp HOMEs) | 11 passed |
| setup.sh in real containers, CentOS 7 (glibc 2.17) included | `scripts/dev/test-setup-linux.sh` (Docker) | to run by hand |
| The GitHub Pages copy with no server: local use, Chrome's installability check from the sub-folder, Notifications without sync (axe), export / import, offline start | `worker/test/ui/pwa-static-check.mjs` | passed |
| A real Android phone and iPhone; a Mac | — | by hand: see below |

## To try by hand

- **Linux containers:** `scripts/dev/test-setup-linux.sh` (Debian 10, Ubuntu 20.04, Fedora 41, CentOS 7), and
  `scripts/dev/test-setup-linux.sh ubuntu:18.04`. CentOS 7 and Ubuntu 18.04 should now install (*Node.js v24…
  for older Linux systems*) instead of stopping.
- **Android (Chrome):** open the Pages address, **Use it on this device**, add a task, menu **Install app**. Open
  it from the app drawer: the task is there. Airplane mode, then reopen it: it still opens. Check that
  **Settings > Notifications** says *Need sync*.
- **iPhone (Safari):** the same, with **Share > Add to Home Screen**. Lists made in Safari do not carry over
  to the Home Screen app (iOS gives it storage of its own); export and import them if you need to.
- **macOS 12 or 13.0–13.4** (if you have one): the setup one-liner should download *Node.js v22…* and finish.
  On any Mac, a deadline reminder should show in Notification Center. They are shown through AppleScript, so
  if none appears, allow **Script Editor** in System Settings > Notifications.
- **GitHub Pages:** the hosted copy exists only once the repository is public and **Settings > Pages > Source:
  GitHub Actions** is set (`.github/workflows/pages.yml` skips while it is private).
