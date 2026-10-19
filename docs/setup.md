# Setup, step by step

Everything that can be automated is done by `setup.cmd` (Windows) or `scripts/setup.sh` (Linux, macOS, WSL).
This page lists every step, including the few clicks only you can do, and what to do when something goes wrong.

- [Which setup is for you](#which-setup-is-for-you)
- [1. Install on Windows](#1-install-on-windows)
- [2. Install on Linux or macOS](#2-install-on-linux-or-macos)
- [3. Cloud sync: Cloudflare account and login](#3-cloud-sync-cloudflare-account-and-login)
- [4. The workers.dev subdomain (first time only)](#4-the-workersdev-subdomain-first-time-only)
- [5. iPhone](#5-iphone) · [6. Android](#6-android)
- [7. Phones and browsers without a cloud account](#7-phones-and-browsers-without-a-cloud-account)
- [8. More devices](#8-more-devices)
- [Windows notifications](#windows-notifications)
- [Updating](#updating) · [Troubleshooting](#troubleshooting) · [Removing everything](#removing-everything)

## Which setup is for you

Every platform works without any account. Sync is an extra you can add at any time from the app
(**Settings > Sync > Set up sync**) or with the same setup command; it runs in your own free Cloudflare
account.

| Platform | On its own (no account) | With sync | How |
|---|---|---|---|
| **Windows** | Desktop widget; lists are markdown files in `%APPDATA%\SaqmeToDo\lists` | Same lists on your phones and other computers | `setup.cmd`; sync from the app's Settings |
| **Linux** | App window + lists as markdown files in `~/.local/share/saqme/lists`; starts at login, desktop reminders | Same lists on your phones and other computers | `scripts/setup.sh`; sync from the app's Settings |
| **macOS** | Same, lists in `~/Library/Application Support/Saqme To Do/lists` | Same | `scripts/setup.sh`; sync from the app's Settings |
| **iPhone** | The phone app with the lists on the phone; export / import as markdown | Paired with your sync: lists everywhere, push reminders | Safari, then *Add to Home Screen* ([section 5](#5-iphone), [7](#7-phones-and-browsers-without-a-cloud-account)) |
| **Android** | Same as iPhone | Same | Chrome, then *Install app* ([section 6](#6-android)) |
| **Any browser** | Same (desktop browsers can install it as an app too) | Same | Open the app's address |

What is automated and what you do yourself:

| Step | Done by setup | Left to you |
|---|---|---|
| Install / update the app, start at login, menu entry | Windows, Linux, macOS | run one command |
| Node.js (Linux, macOS) | uses yours if it is 22.13 or newer, otherwise downloads Node.js 24 just for Saqme | very old or unusual systems: install Node.js 22.13+ yourself ([details](#requirements-linux-and-macos)) |
| Cloudflare database, Worker, keys, deploy | Settings > Sync > **Set up sync** in the app (or setup with `-Cloud` / `--cloud`) | sign in to Cloudflare and click **Allow** (once); pick a workers.dev name (first time only) |
| Connecting the desktop app to sync | yes | — |
| Phone | — | scan the QR code, add to Home Screen, type the pairing code (iPhone), enable notifications |
| The phone app without a cloud account | published on GitHub Pages ([section 7](#7-phones-and-browsers-without-a-cloud-account)) | open its address |

## 1. Install on Windows

**Option A — zip (no tools needed):** on the GitHub page click **Code**, then **Download ZIP**, extract it
anywhere (e.g. *Downloads*), open the extracted folder and double-click **`setup.cmd`**.
If Windows shows "Windows protected your PC" (SmartScreen), click **More info**, then **Run anyway**: the file
is a plain text script you can read first.

**Option B — one line in PowerShell:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/francuza9/saqme-to-do/main/scripts/setup.ps1 | iex"
```

With options, for example the app and cloud sync:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/francuza9/saqme-to-do/main/scripts/setup.ps1))) -Cloud"
```

**Option C — from a clone:** `git clone https://github.com/francuza9/saqme-to-do.git`, then `setup.cmd` in the
repository folder.

What setup does on Windows (no administrator rights needed, everything is per user):

| Step | Where |
|---|---|
| Copies the app (PowerShell scripts, icons, fonts) and runs a self-check | `%LOCALAPPDATA%\Programs\SaqmeToDo` |
| Creates your data folder (lists, settings, sync state) | `%APPDATA%\SaqmeToDo` |
| Registers the notification identity "Saqme To Do" and allows its banners | `HKCU\Software\Classes\AppUserModelId\Saqme.ToDo` |
| Registers the `saqme:` link that notifications use to open the app | `HKCU\Software\Classes\saqme` |
| Start menu shortcut, start with Windows, entry in Settings > Apps | your Start menu / Startup folder |
| With `-Cloud`: the cloud part ([section 3](#3-cloud-sync-cloudflare-account-and-login)); then starts the app | |

Without options nothing is sent anywhere: the lists stay on this PC. Add sync any time later from the app:
**Settings > Sync > Set up sync** ([section 3](#3-cloud-sync-cloudflare-account-and-login)), or paste a pairing
link from a device that already syncs there. `setup.cmd -Cloud` does the same from the command line.
`-CloudOnly` redoes only the cloud part.

## 2. Install on Linux or macOS

One command in a terminal (no administrator rights needed, everything is per user):

```bash
curl -fsSL https://raw.githubusercontent.com/francuza9/saqme-to-do/main/scripts/setup.sh | bash
```

From a clone: `scripts/setup.sh`. Options go after the script (`... | bash -s -- --cloud` from the web).
Without `--cloud` nothing is sent anywhere: the lists stay on this computer. Add sync any time later from the
window: **Settings > Sync > Set up sync** ([section 3](#3-cloud-sync-cloudflare-account-and-login)), or with
`scripts/setup.sh --cloud`.

The app is the same phone app, served by a small local program on `127.0.0.1` and shown in its own window,
plus your lists as markdown files that it keeps in step with the window: change them in any editor or let an
AI assistant do it, and the window shows it within a few seconds (and the other way round). Headings and
notes you write between tasks stay where they are.

What setup does:

| | Linux | macOS |
|---|---|---|
| App files (and Node.js, if it had to download it) | `~/.local/lib/saqme` | `~/Library/Application Support/Saqme To Do/app` |
| Your lists and settings | `~/.local/share/saqme` (`$XDG_DATA_HOME`) | `~/Library/Application Support/Saqme To Do` |
| Command | `~/.local/bin/saqme` | `~/.local/bin/saqme` |
| Opening it | menu entry *Saqme To Do* | *Saqme To Do* in `~/Applications` (Launchpad, Spotlight) |
| Starting at login | systemd user service `saqme-todo` (or a desktop autostart entry where there is no systemd) | LaunchAgent `com.saqme.todo` |
| Reminders | desktop notifications (`notify-send`, or the notification service directly) | Notification Center (through `osascript`) |

**The window** opens in Chrome, Chromium, Edge, Brave or Vivaldi as a plain app window when one of them is
installed; otherwise in your default browser (Safari: **File > Add to Dock** makes it an app; Firefox shows it
as a normal tab). Set `SAQME_BROWSER` to the browser command you prefer.

**Commands:** `saqme open` (the window), `saqme status` (where the lists are, sync state), `saqme stop`,
`saqme serve` (run in the foreground), `saqme allow-deletes` (confirm a paused mass delete),
`saqme pair-phone` (the QR code for your phone, once sync is set up), `saqme connect '<pairing link>'`
(sync with a Worker another device already uses).

| Option | What it does |
|---|---|
| `--cloud` | also set up sync in your Cloudflare account, or update it |
| `--cloud-only` | only the Cloudflare part (for example on a server, or from WSL for the Windows app) |
| `--data DIR` | keep the lists somewhere else (a synced folder, for example) |
| `--port N` | local port of the window (default 47613; the address must stay the same, as the window's data belongs to it) |
| `--no-start`, `--no-autostart` | don't start now / don't start at login |
| `--uninstall [--purge-data]` | remove the app (your lists stay unless you add `--purge-data`) |
| `--rotate-token`, `--device-login`, `--worker-name NAME`, `--yes` | for the Cloudflare part, as on Windows |

On **WSL**, `setup.sh` sets up the cloud part for the Windows app (and connects it if it is installed); add
`--app` to install the Linux app inside WSL as well.

### Requirements (Linux and macOS)

Setup uses the Node.js you have if it is **22.13 or newer**; otherwise it downloads the official Node.js 24
(checksum-verified, about 50 MB, used only by Saqme). That download needs:

- **Linux:** x64 or arm64 with **glibc 2.28 or newer** and kernel 4.18+: Debian 10, Ubuntu 20.04, RHEL /
  Rocky / Alma 8, Fedora 29 and anything newer. Tested in containers on Debian 10, Ubuntu 20.04 and
  Fedora 41.
- **macOS:** 13.5 (Ventura) or newer, Intel or Apple silicon.

Older systems and musl-based ones (Alpine) stop with a clear message: install Node.js 22.13+ another way
(your distribution, `nvm`, Homebrew `node@22` for macOS 11–13.4, an unofficial glibc 2.17 build), run setup
again, and it uses that one. (Tested on Alpine 3.22 with its own `nodejs` package.)

## 3. Cloud sync: Cloudflare account and login

**From the app:** **Settings > Sync > Set up sync.** It creates your own free sync service in your Cloudflare
account; your lists stay on this computer and are uploaded there, nothing is deleted. You need a free
Cloudflare account and one sign-in in the browser.

- **Windows:** a setup window opens next to the app, which keeps running. Node.js, the Cloudflare sign-in and
  any questions happen in that window. When it is done the app starts syncing and shows the QR code for your
  phone. If it stops (or you close the window), the app says so and nothing on this PC has changed; run it
  again any time.
- **Linux and macOS:** the window shows the steps as they run, with the sign-in link (the browser opens by
  itself where it can). When it is done the window shows the QR code for your phone; if it stops, it says why.

**With setup:** `setup.cmd -Cloud` (Windows) or `scripts/setup.sh --cloud` does the same from the command
line, and also updates the cloud part of an existing setup.

Sync runs in your own Cloudflare account on the free plan. On Windows, setup needs **Node.js 22 or newer**
for this part only (the Cloudflare tools refuse older versions); if it is missing, setup offers to install
the LTS version with `winget` (answer **Y**; winget installs it for all users, so Windows may ask for
administrator approval). Without winget, install it from <https://nodejs.org> and run `setup.cmd -CloudOnly`. On Linux and macOS the Node.js
from [section 2](#2-install-on-linux-or-macos) is used.

Then setup starts the Cloudflare login — **the one step you have to do yourself**:

1. A browser window opens on dash.cloudflare.com.
   - No account yet? Click **Sign up**, enter e-mail + password, confirm the e-mail. The free plan is enough;
     no payment details are needed.
2. Sign in. Cloudflare shows **"Wrangler is requesting access"** (Wrangler is Cloudflare's own command-line tool).
3. Click **Allow**. The page says you can close it; go back to the setup window, it continues on its own.

No browser opens (remote desktop, SSH, WSL without a browser)? Run setup with **`-DeviceLogin`**
(`scripts/setup.sh --device-login`): instead of a browser window it shows a sign-in address and a short code
(on their own lines, marked **Open** and **Code**). Open the address on any device (this computer or your
phone), sign in, enter the code and approve; setup goes on by itself. The code expires after the time shown
with it; if it does, run setup again for a new one.

If your login can see several Cloudflare accounts, setup asks which one to use (from the Linux/macOS window,
which cannot ask, it takes the first) and says which one it used. To pick another later, run setup with the
environment variable `CLOUDFLARE_ACCOUNT_ID` set to that account's id.

Setup then creates (or, when run again, reuses) a D1 database called `saqme`, deploys the Worker `saqme`
(sync service + phone app), generates your access key and push-notification keys, checks that everything
answers, connects the desktop app on this computer and shows the pairing QR code.

## 4. The workers.dev subdomain (first time only)

A brand-new Cloudflare account has no `workers.dev` subdomain yet, so there is no address to deploy to.
Setup notices this and lets Cloudflare's tool ask you for one:

```
Would you like to register a workers.dev subdomain now? › yes
What would you like your workers.dev subdomain to be? › pick-any-name
```

Type **y**, then any name you like (letters, digits, dashes). Your app will live at
`https://saqme.<that-name>.workers.dev`. If you prefer the dashboard: **dash.cloudflare.com > Workers & Pages**
asks for the subdomain on first visit; set it there and press Enter in the setup window. (From the Linux/macOS
window there is nobody to ask: set the subdomain in the dashboard, then choose **Set up sync** again.)

## 5. iPhone

Needs iOS 16.4 or later for notifications (everything else works on older versions too).

1. **Open the pairing link.** Scan the QR code the computer app showed after setting up sync with the
   **Camera** app and tap the banner. It opens in **Safari**, which shows your lists. The apps show the QR code
   again under **Settings > Sync > Pair phone** (or `saqme pair-phone` in a terminal on Linux and macOS).
2. **Install.** In Safari tap the **Share** button (square with an arrow), scroll, **Add to Home Screen**,
   **Add**.
3. **Open Saqme from the Home Screen and type the pairing code.** iOS starts a Home Screen app at its own
   address, with storage of its own, so neither the link nor Safari's pairing reaches it: it opens on the
   welcome screen. Type the 8-character code that Safari showed after step 1, or the one under the QR code on
   the computer (**Pair phone**), into *Pairing code or link* and tap **Pair**. A code works once and for 10
   minutes; **Pair phone** shows a new one each time. Pasting the whole pairing link works too.
4. **Enable notifications:** tap the logo (top left), then **Settings > Notifications > Enable**, **Allow**.
   **Send test** should show a notification within seconds (only the Home Screen app may send them, not Safari).

Reminders on the phone come from the Worker's schedule (every 5 minutes) in the phone's time zone:
15 minutes before a timed deadline, again at the time (or late, if it was missed), and one daily summary
at the time set in *Daily summary at* (shared with the desktop).

Turned notifications off by mistake? iPhone **Settings > Notifications > Saqme > Allow Notifications**.

## 6. Android

1. Scan the pairing QR code with the camera (or Google Lens) and open the link in **Chrome**.
2. Chrome offers **Install app** (or menu ⋮ > **Add to Home screen** > **Install**). The installed app shares
   Chrome's storage, so it is already paired. (If it shows the welcome screen, type the code from **Pair
   phone** there, as on iPhone.)
3. Open Saqme from the app drawer, then **Settings > Notifications > Enable**, **Allow**.

Push notifications work on Android the same way as on iPhone. The app is tuned and tested for iPhone, but
everything it does uses standard web features that Chrome on Android supports.

## 7. Phones and browsers without a cloud account

The phone app works entirely on the device: open it, tap **Use it on this device**, and the lists live in
the browser's storage on that phone (offline, nothing is sent anywhere). Install it to the Home Screen as
above so the system keeps that storage.

- **Back up and move lists:** **Settings > Data > Export lists** saves a zip of markdown files in the same
  format as the desktop apps (one file per list, plus the tab order). Unzipped into a desktop lists folder,
  they just appear. **Import lists** takes such a zip or `.md` files; tasks that are already there (same
  `^id`) are skipped, nothing is deleted, so importing twice is harmless.
- **Add sync later:** set up the cloud part from a computer, then paste the pairing link into
  **Settings > Sync** of this copy of the app (pairing codes only work in the copy your sync service serves,
  the one the QR code opens). Your lists are merged with the synced ones (same-name lists
  are combined, not duplicated).

**Where it comes from.** The app has to be served from some web address once, so the phone can install it.
Without your own Cloudflare Worker, that is a static copy of `worker/public`:

- **This project's copy on GitHub Pages:** <https://francuza9.github.io/saqme-to-do/>, published from `main`
  (see CONTRIBUTING.md). The page only serves the app's files; your lists never leave your device unless
  you pair it with your own sync. It is shared: everyone who opens it runs the code published there, and a
  change to `main` reaches them at once. If you would rather not depend on that, use the copy your own sync
  service serves (with sync, the QR code from setup opens exactly that), or host your own (fork the
  repository and enable Pages, or copy `worker/public` to any static host, also in a sub-folder).
- On Linux and macOS, the local app from [section 2](#2-install-on-linux-or-macos) serves its own copy, for
  the browsers on that computer only (it answers on 127.0.0.1).

A copy served from elsewhere talks to your Worker across origins once paired; the Worker allows that for
its API (every call still needs your key), and the app's own security policy only lets it connect to
`https` addresses.

## 8. More devices

- **Another iPhone / iPad / Android phone:** same as above. A phone that already syncs can pair the next
  one too: its **Settings > Sync > Pair a phone** shows the QR code and a code.
- **Another Windows PC:** install with `setup.cmd`, then in the app **Settings > Sync** paste
  the pairing link (from a device that already syncs: **Settings > Sync > Pair phone > Copy link**) into
  the box and click **Connect**. Lists with the same name are merged. (**Set up sync** on the second PC would
  need the key that only the first one has; it stops and explains this instead of replacing it.)
- **Another Linux or macOS computer:** install with `scripts/setup.sh`, then paste the pairing link into the
  window's **Settings > Sync** and click **Connect** (or run `saqme connect '<link>'`). It starts syncing within
  a few seconds; same-name lists are merged.

## Windows notifications

The app uses normal Windows notifications. If none appear (try **Settings > Send test** in the app):

- **Do Not Disturb / Focus** is on: click the clock in the taskbar and turn it off, or
- add Saqme as a **priority app**: Windows Settings > System > Notifications > *Set priority notifications* >
  **Add apps** > *Saqme To Do*.
- Windows Settings > System > Notifications: *Notifications* must be on, and *Saqme To Do* must be allowed.

## Updating

Run setup again (`setup.cmd`, `scripts/setup.sh`, or the one-liners). It replaces the app files, keeps your
data and keeps sync as it is. To update the Worker as well, add `-Cloud` (Windows) or `--cloud` (Linux, macOS);
it reuses the existing setup (no new login unless Cloudflare's session expired). The phone app updates itself
the next time it is opened with a connection.

## Troubleshooting

| Problem | Fix |
|---|---|
| Sync icon shows a red warning | Hover it for the reason. *Token rejected*: run setup's cloud part again (or pair again). *Server error*: wait a minute; it retries on its own. |
| "N tasks vanished from the lists folder … deletions paused" | A list file was emptied or replaced in one go. Restore it (Recycle Bin, Trash, `lists/.trash`) — or, if it was on purpose, confirm: Windows **Settings > Sync > Delete them**; Linux/macOS **Delete them** in the window's settings, or `saqme allow-deletes`. |
| Phone shows the welcome screen after installing | Expected on iPhone: type the pairing code (**Pair phone** on the computer, or the one Safari showed) into the field on that screen. *Wrong or expired*: show a new one; a code works once, for 10 minutes. Pasting the pairing link works too. |
| Linux/macOS window says it is "not connected" | It was opened from a bookmark. Open Saqme from the menu (or `saqme open`); that hands the window its key. |
| Linux/macOS: "Port 47613 is used by another program" | Run setup again with `--port 47700` (any free port). |
| Linux: no reminders | Install `libnotify-bin` (Debian/Ubuntu) or `libnotify` (Fedora) for `notify-send`, and check that `saqme status` says it is running. |
| `npm` fails during setup | Usually network/proxy. Check that `https://registry.npmjs.org` opens in a browser, then re-run. |
| Setup cannot create the database | The free plan allows 10 D1 databases; delete unused ones in the dashboard (Storage & Databases > D1) or use another Worker name. |
| Push test says "not subscribed" | Settings > Notifications > Turn off, then Enable again (subscriptions can expire). |
| Logs | Windows: `%APPDATA%\SaqmeToDo\sync\sync.log`. Linux/macOS: `local/saqme.log` in the data folder. |

Re-running setup is always safe: finished steps are skipped and existing keys, database and lists are reused.

## Removing everything

- **Windows app:** Windows Settings > Apps > *Saqme To Do* > Uninstall, or `setup.cmd -Uninstall`.
  Your lists stay in `%APPDATA%\SaqmeToDo`; add `-PurgeData` to delete them and the sync keys too.
- **Linux / macOS app:** `scripts/setup.sh --uninstall` (or the one-line command with `--uninstall` after
  `bash -s --`). The lists stay; add `--purge-data` to delete them and setup's folder with the sync keys
  (`~/.config/saqme`, on macOS `~/Library/Application Support/Saqme To Do/setup`). It finds a folder chosen
  with `--data` by itself, and deletes only what Saqme created there (`lists/`, `local/`, `sync/`), never
  other files in it and never your home folder.
- **Cloud part:** everything sync needs is one Worker and one D1 database in your Cloudflare account, both
  named `saqme` (unless you chose another `-WorkerName`). Delete them in the dashboard
  (<https://dash.cloudflare.com>: **Workers & Pages** and **Storage & Databases > D1**), or from any terminal
  with Node.js 22+: `npx wrangler@4 delete --name saqme` and `npx wrangler@4 d1 delete saqme` (the
  database holds all synced data). Then `npx wrangler@4 logout` ends the login setup made on that computer.
- **Setup's saved keys,** if you keep the app: `%APPDATA%\SaqmeToDo\cloud.json` (Windows),
  `~/.config/saqme/cloud.json` (Linux), `~/Library/Application Support/Saqme To Do/setup/cloud.json`
  (macOS). Lost them? Running setup with `-RotateToken` / `--rotate-token` issues new ones and revokes the
  old key (then pair every device again and turn notifications on again on phones).
- **Phone:** long-press the icon, Remove App. Its lists go with it (export them first if you want to keep them).
