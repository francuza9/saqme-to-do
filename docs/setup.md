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
(**Set up sync** in **Settings > Sync & sharing**, on Windows and in the Linux/macOS window) or with the same
setup command; it runs in your own free Cloudflare account.

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
| Cloudflare database, Worker, keys, deploy | **Set up sync** in the app's Settings (Windows: Sync & sharing; Linux, macOS: Sync), or setup with `-Cloud` / `--cloud` | sign in to Cloudflare and click **Allow** (once); pick a workers.dev name (first time only) |
| Connecting the desktop app to sync | yes | — |
| Phone | — | scan the QR code, add to Home Screen, type the pairing code (iPhone), enable notifications |
| The phone app without a cloud account | published on GitHub Pages ([section 7](#7-phones-and-browsers-without-a-cloud-account)) | open its address |
| `saqme://` links (invites to shared lists open the app) | setup registers them on Windows, Linux and macOS (there with a small helper app, `~/Applications/Saqme To Do Invites.app`) | allow the browser to open Saqme To Do the first time |
| Sharing a list with someone | everything but sending the link | send the invite link yourself; they open it ([section 9](#9-sharing-a-list-with-someone)) |

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

Run setup from File Explorer or a normal PowerShell / Terminal window. A shell that belongs to a Store
(MSIX-packaged) app, such as the one an AI assistant in a desktop app uses, sees a private copy of `AppData`
and the registry: anything installed from there would be invisible to Saqme started from the Start menu. Setup
notices this, stops before changing anything and prints the command to run in a normal window instead (the
app's **Set up sync** does the same when Saqme itself was started from such a shell).

What setup does on Windows (no administrator rights needed, everything is per user):

| Step | Where |
|---|---|
| Copies the app (PowerShell scripts, icons, fonts) and runs a self-check | `%LOCALAPPDATA%\Programs\SaqmeToDo\versions\<version>` (one folder per version, see [Updating](#updating)) |
| Creates your data folder (lists, settings, sync state) | `%APPDATA%\SaqmeToDo` |
| Registers the notification identity "Saqme To Do" and allows its banners | `HKCU\Software\Classes\AppUserModelId\Saqme.ToDo` |
| Registers the `saqme:` link that notifications use to open the app | `HKCU\Software\Classes\saqme` |
| Start menu shortcut, start with Windows, entry in Settings > Apps | your Start menu / Startup folder |
| With `-Cloud`: the cloud part ([section 3](#3-cloud-sync-cloudflare-account-and-login)); then starts the app | |

Without options nothing is sent anywhere: the lists stay on this PC. Add sync any time later from the app:
**Settings > Sync & sharing > Set up sync** ([section 3](#3-cloud-sync-cloudflare-account-and-login)), or paste
a pairing link from a device that already syncs there. `setup.cmd -Cloud` does the same from the command line.
`-CloudOnly` redoes only the cloud part.

**Settings in the Windows app** (the logo at the top left, *Options > Settings*, or Ctrl+,) is a short list of
pages in two groups; each row shows how it stands on the right (the theme, the time, *Synced 2 min ago*, the
version). Esc (or the title) goes back one level.

| Page | What is on it |
|---|---|
| **General** | Theme (Dark / Light / Auto), *Start with Windows*, *Keyboard shortcuts* |
| **Notifications** | *Daily summary* time (shared with your phone), *Send a test notification* |
| **Sync & sharing** | *Set up sync* or how sync stands, *Sync now*, *Pair phone*, conflicts; a pairing link from another device; joining a shared list (paste its invite link) and the lists shared with this PC (*Leave*); *Deletions paused* when that happens; under **Advanced**: *Turn off sync*, the sync log (and how to get a new sync key) |
| **Your lists** | *Open the lists folder*, *Recently deleted* |
| **Updates** (under *App*) | the version, *Check now* / *Update now* / *Sign in to Cloudflare*, *Install updates automatically*; with sync, *Your sync service*: its version and [updating itself](#your-sync-service-can-update-itself) |
| **About** (under *App*) | the version, *Open the data folder*, where the app and your data are |

The line at the bottom of every Settings page says *Saqme To Do* and its version. When an update is available,
or one waits for you to sign in to Cloudflare, it adds a violet dot and says so; click it to open **Updates**.
Hovering the tray icon shows the version too.

## 2. Install on Linux or macOS

One command in a terminal (no administrator rights needed, everything is per user):

```bash
curl -fsSL https://raw.githubusercontent.com/francuza9/saqme-to-do/main/scripts/setup.sh | bash
```

From a clone: `scripts/setup.sh`. Options go after the script (`... | bash -s -- --cloud` from the web).
Without `--cloud` nothing is sent anywhere: the lists stay on this computer. Add sync any time later from the
window: **Settings > Sync & sharing > Set up sync** ([section 3](#3-cloud-sync-cloudflare-account-and-login)), or with
`scripts/setup.sh --cloud`.

The app is the same phone app, served by a small local program on `127.0.0.1` and shown in its own window,
plus your lists as markdown files that it keeps in step with the window: change them in any editor or let an
AI assistant do it, and the window shows it within a few seconds (and the other way round). Headings and
notes you write between tasks stay where they are.

What setup does:

| | Linux | macOS |
|---|---|---|
| App files (one folder per version in `versions/`, and Node.js if it had to download it) | `~/.local/lib/saqme` | `~/Library/Application Support/Saqme To Do/app` |
| Your lists and settings | `~/.local/share/saqme` (`$XDG_DATA_HOME`) | `~/Library/Application Support/Saqme To Do` |
| Command | `~/.local/bin/saqme` | `~/.local/bin/saqme` |
| Opening it | menu entry *Saqme To Do* | *Saqme To Do* in `~/Applications` (Launchpad, Spotlight) |
| Starting at login | systemd user service `saqme-todo` (or a desktop autostart entry where there is no systemd) | LaunchAgent `com.saqme.todo` |
| Reminders | desktop notifications (`notify-send`, or the notification service directly) | Notification Center (through `osascript`) |

**The window** opens in Chrome, Chromium, Edge, Brave or Vivaldi as a plain app window when one of them is
installed; otherwise in your default browser (Safari: **File > Add to Dock** makes it an app; Firefox shows it
as a normal tab). Set `SAQME_BROWSER` to the browser command you prefer.

**Commands:** `saqme open` (the window), `saqme status` (where the lists are, sync state), `saqme stop`,
`saqme serve` (run in the foreground), `saqme allow-deletes` / `saqme restore-deletes` (confirm a paused mass delete, or put the tasks back),
`saqme pair-phone` (the QR code for your phone, once sync is set up), `saqme connect '<pairing link>'`
(sync with a Worker another device already uses), `saqme update` (install the newest release now, the same as
**Update now** in the window), `saqme version`.

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

**From the app:** **Set up sync**, in **Settings > Sync & sharing** (on Windows and in the Linux/macOS window).
It creates your own free sync service in your Cloudflare account; your lists stay on this
computer and are uploaded there, nothing is deleted. You need a free Cloudflare account and one sign-in in the
browser.

- **Windows:** a setup window opens next to the app, which keeps running. Node.js, the Cloudflare sign-in and
  any questions happen in that window. When it is done the app starts syncing and shows the QR code for your
  phone. If it stops (or you close the window), the app says so and nothing on this PC has changed; run it
  again any time.
- **Linux and macOS:** the window shows the steps as they run, with the sign-in link (the browser opens by
  itself where it can). When it is done the window shows the QR code for your phone; if it stops, it says why.

**With setup:** `setup.cmd -Cloud` (Windows) or `scripts/setup.sh --cloud` does the same from the command
line, and also updates the cloud part of an existing setup.

Sync runs in your own Cloudflare account on the free plan. On Windows, setup needs **Node.js 22 or newer**
for this part only (the Cloudflare tools refuse older versions). It uses the one you have; if there is none, it
downloads the official Node.js 24 just for Saqme (checksum-verified, about 30 MB, into the app's folder, no
administrator rights; removed again with the app). On Linux and macOS the Node.js from
[section 2](#2-install-on-linux-or-macos) is used. The app's updater uses the same one to update your Worker.

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
answers, connects the desktop app on this computer and shows the pairing QR code. In a terminal it also offers to
let your sync service [update itself](#your-sync-service-can-update-itself) (no is the default; the apps offer it
later too).

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
   again under **Settings > Sync & sharing > Pair phone** (Linux and macOS: **Pair a phone**, or
   `saqme pair-phone` in a terminal).
2. **Install.** In Safari tap the **Share** button (square with an arrow), scroll, **Add to Home Screen**,
   **Add**.
3. **Open Saqme from the Home Screen and type the pairing code.** iOS starts a Home Screen app at its own
   address, with storage of its own, so neither the link nor Safari's pairing reaches it: it opens on the
   welcome screen. Type the 8-character code that Safari showed after step 1, or the one under the QR code on
   the computer (**Pair phone**), into *Pairing code or link* and tap **Pair**. A code works once and for 10
   minutes; **Pair phone** shows a new one each time. Pasting the whole pairing link works too.
4. **Turn on notifications:** tap the logo (top left), then **Notifications**, switch **Notifications** on and
   tap **Allow**. **Send a test notification** should show one within seconds (only the Home Screen app may send
   them, not Safari).

Reminders on the phone come from the Worker's schedule (every 5 minutes) in the phone's time zone:
15 minutes before a timed deadline, again at the time (or late, if it was missed), and one daily summary
at the time set in *Daily summary* (Settings > Notifications; shared with the desktop).

Turned notifications off by mistake? iPhone **Settings > Notifications > Saqme > Allow Notifications**.

## 6. Android

1. Scan the pairing QR code with the camera (or Google Lens) and open the link in **Chrome**.
2. Chrome offers **Install app** (or menu ⋮ > **Add to Home screen** > **Install**). The installed app shares
   Chrome's storage, so it is already paired. (If it shows the welcome screen, type the code from **Pair
   phone** there, as on iPhone.)
3. Open Saqme from the app drawer, then **Settings > Notifications**: switch **Notifications** on, **Allow**.

Push notifications work on Android the same way as on iPhone. The app is tuned and tested for iPhone, but
everything it does uses standard web features that Chrome on Android supports.

## 7. Phones and browsers without a cloud account

The phone app works entirely on the device: open it, tap **Use it on this device**, and the lists live in
the browser's storage on that phone (offline, nothing is sent anywhere). Install it to the Home Screen as
above so the system keeps that storage.

- **Back up and move lists:** **Settings > Your lists > Export lists** saves a zip of markdown files in the same
  format as the desktop apps (one file per list, plus the lists' order). Unzipped into a desktop lists folder,
  they just appear. **Import lists** takes such a zip or `.md` files; tasks that are already there (same
  `^id`) are skipped, nothing is deleted, so importing twice is harmless.
- **Add sync later:** set up the cloud part from a computer, then paste the pairing link into
  **Settings > Sync & sharing** of this copy of the app (pairing codes only work in the copy your sync service serves,
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
`https` addresses. Lists others share with you reach a paired app through your own Worker; an app without sync
uses them from the invite's own page instead (*Use it in this browser*), at their owner's address.

## 8. More devices

- **Another iPhone / iPad / Android phone:** same as above. A phone that already syncs can pair the next
  one too: its **Settings > Sync & sharing > Pair a phone** shows the QR code and a code.
- **Another Windows PC:** install with `setup.cmd`, then in the app **Settings > Sync & sharing** paste
  the pairing link (from a device that already syncs: its **Pair phone** page, **Copy link**; on Windows that is
  **Settings > Sync & sharing > Pair phone**) into the box and click **Connect**. Lists with the same name are merged. (**Set up sync** on the second PC would
  need the key that only the first one has; it stops and explains this instead of replacing it.)
- **Another Linux or macOS computer:** install with `scripts/setup.sh`, then paste the pairing link into the
  window's **Settings > Sync & sharing** and click **Connect** (or run `saqme connect '<link>'`). It starts syncing within
  a few seconds; same-name lists are merged.

## 9. Sharing a list with someone

A shared list stays on **your** sync service; the other person syncs that one list from there, with a key of
their own that reaches nothing else. They need no Cloudflare account, and not even Saqme: the list works in
their browser too. (Sharing needs a Worker from 1.1.0 on: the app's updater brings yours there by itself,
database included. If the other person has sync of their own, theirs needs it as well: their phone reaches
your list through their Worker.)

**You (the owner):**

1. Right-click (on a phone long-press) the list's name at the top, or the list in the lists menu that name opens.
   Choose **Share…**. Without sync of your own, Share is greyed out: a shared list
   needs your sync service to live on (**Set up sync**, in Settings > Sync & sharing).
2. Type a **name** for the person (only you see it, to recognise them later) and pick **Can edit** or **Can
   view**, then **Create invite link**. The link is copied (the desktop also shows it as a QR code).
3. Send it to them yourself, in a message or an email. It works **once, for 24 hours**: whoever opens it first
   joins, so send it to that person only. One invite covers all their phones that sync with their own
   Worker; each of their computers needs an invite of its own.
4. The same **Share** view lists everyone the list is shared with, one row each (tap a person for their
   access). Change their access there, **Revoke** them (their key stops working at once; they keep the list as
   their own unshared copy), or **Cancel** an invite nobody used yet. A shared list shows a small people badge
   after its name (in the title and the lists menu).

**The other person:**

- **No Saqme (any phone or computer):** tap **Use it in this browser** on the page. The list works right away
  in the browser, from the owner's address: nothing to install, no account, no sync. To keep it on a phone,
  add that page to the Home Screen; switching on **Settings > Notifications** there reminds you of its deadlines
  (sent by the owner's sync service, at your summary time and in your time zone). The page also has the
  one-line installers, for later.
- **Windows, macOS or Linux with Saqme installed:** open the link. The page asks the browser to open Saqme To
  Do (allow it); the app asks *Join shared list?* and the list appears among your lists (a list whose name you
  already have says whose it is: "Groceries (from nuca)"). If nothing opens, copy the link (**Copy invite** on
  that page) and paste it into **Settings > Sync & sharing**, under *Shared lists* (Linux/macOS: or run
  `saqme join '<link>'`). This works without sync of your own.
- **The phone app, paired with your own sync:** a link from another site cannot open it. Tap **Copy invite**
  on the page, open Saqme, then **Settings > Sync & sharing**, under *Shared lists* **Paste**, **Join**. Your sync service
  keeps the list for all your phones and reminds you of its deadlines like of your own.
- **Started in the browser, installed Saqme later:** in the browser, the list's menu (long-press its name at the
  top) has **Move to my Saqme app**: open the link it shows in your Saqme (or scan its QR code). The list moves
  over with no new invite, and the browser copy stops.
- **Leave** a list from its menu (the list's name's, at the top or in the lists menu; Leave replaces Delete there): it
  goes from your device (to `lists/.trash`
  on a computer; from all your paired phones at once); the owner's list is not touched.
- A **view-only** list cannot be changed in the apps. Edited in its file anyway (an editor, an AI
  assistant), it goes back to the owner's version, and what was typed is kept under **Conflicts** as *Not
  saved*.

Turning your own sync off (Settings > Sync & sharing > Advanced) keeps the
lists shared with you on computers; on a phone they wait
until it is paired again. Something to try with a second person: [testing-shared-lists.md](testing-shared-lists.md).

## Windows notifications

The app uses normal Windows notifications. If none appear (try **Settings > Notifications > Send test** in the
app):

- **Do Not Disturb / Focus** is on: click the clock in the taskbar and turn it off, or
- add Saqme as a **priority app**: Windows Settings > System > Notifications > *Set priority notifications* >
  **Add apps** > *Saqme To Do*.
- Windows Settings > System > Notifications: *Notifications* must be on, and *Saqme To Do* must be allowed.

## Updating

**No commands any more.** The app updates itself, your Worker and the phone app with it:

- It checks for a new release on GitHub when it starts and about once a day. **Settings > Updates** says
  *Update available* with **Update now** (on Windows the version line at the bottom of every Settings page and
  the Updates row get a violet dot then; clicking the line opens Updates). With **Install updates automatically** (on unless you switch it off)
  it installs it by itself while the app is idle: the window hidden, or nobody at the keyboard for ten
  minutes, and never while you are typing in it. Saqme restarts and is back within a minute.
- It downloads the release's zip from GitHub, checks it against the release's manifest (size and SHA-256), puts
  the new version in a folder of its own next to the one that runs (`versions\<version>`), checks that it
  starts, and only then switches over. The version before stays, to go back to: if the new one does not come
  up, Saqme goes back to it by itself and says so in Settings > Updates. Your lists and data are never touched.
- **Your Worker** (if you set up sync) is updated first, with the code and phone app files of the new release;
  its keys, database and pairings stay as they are. This uses the Cloudflare sign-in setup made, and the
  Node.js and wrangler setup installed (missing ones are installed again, quietly). If Cloudflare's sign-in
  expired, Settings > Updates says **Sign in to Cloudflare to finish the update** with a button that opens
  the browser; the update finishes by itself afterwards. If the Worker cannot be updated, the apps still
  update when they work with the Worker that runs, and the Worker is tried again later; when they need the
  newer Worker, the whole update waits (and says so), so sync never breaks halfway.
- **The database** updates itself: the new Worker applies what it needs on its first request.
- **The phone app** loads the new version the next time it is opened (or comes back to the foreground) with a
  connection, and says *Saqme was updated to …*.
- Linux and macOS: `saqme update` does the same from a terminal.
- A sync service that already runs the new version (it [updated itself](#your-sync-service-can-update-itself), or
  another computer updated it) is left as it is. Running an older copy of setup never puts an older version on it.

### Your sync service can update itself

Without this, your Worker (and the phone app it serves) is updated only by the app on a computer: while that
computer is off or away, your phones stay on the old version. With it, the Worker looks for a new release every 6
hours and installs it by itself, from this project's GitHub releases with the same checks as the apps.

It needs a **Cloudflare API token** that only you can make, once (about two minutes):

1. **Settings > Updates** (phone: on a paired phone; Windows, Linux, macOS: under *Your sync service*), then
   *Let it update itself…* / *Open Cloudflare's token page*. Setup offers the same in a terminal.
2. Cloudflare's *Create API token* page opens, filled in: the permission **Account · Workers Scripts · Edit**, on
   your account only. Sign in, click **Continue to summary**, then **Create Token**, and copy the token.
   (If the page shows no permission: *Create Custom Token*; Permissions *Account*, *Workers Scripts*, *Edit*;
   Account Resources *Include*, your account.)
3. Paste it into the app and **Save**. Your sync service checks it with Cloudflare and keeps it as one of its own
   secrets (`UPDATE_TOKEN`); none of your devices keeps it.

Then Settings > Updates shows its version, *Update now*, **Update by itself** (switch it off to update only with
Update now), how the last update went in plain words, and what it did. *Remove the token* stops it; so does deleting
the token in the Cloudflare dashboard (My Profile > API Tokens). A sync service set up before 1.2.0 can do this
after its next update from a computer.

What the token allows: changing the Workers of that Cloudflare account (upload, deploy, roll back, their secrets
and schedules), nothing else: not your other accounts, not DNS, not the database directly. It installs only
releases of this repository, checked by SHA-256, never an older one. An update never leaves your sync service half
updated: the new version takes over in one step, and if it cannot update its database it goes back to the version
before by itself. To go back by hand: the dashboard's Workers & Pages > saqme > Deployments, or
`npx wrangler rollback`. Details and the trust model: [sync.md](sync.md#the-sync-service-updates-itself).

Installs from before 1.1.0 have no updater yet: **run setup once more** (the one-liner, `setup.cmd` or
`scripts/setup.sh`, as when you installed it) to get it; it keeps your lists, settings and sync. Running setup
again is still safe at any time, and a copy of the repository (`setup.cmd` from a clone, or `local/saqme.mjs`
run from it) does not update itself: `git pull` and run setup.

## Troubleshooting

| Problem | Fix |
|---|---|
| Sync icon shows a red warning | Hover it for the reason. *Token rejected*: run setup's cloud part again (or pair again). *Server error*: wait a minute; it retries on its own. |
| "N tasks vanished from the lists folder … deletions paused" | A list file was emptied or replaced in one go. **Settings > Sync & sharing > Deletions paused > Restore them** puts the tasks back into their lists as they last synced (tasks added since stay); if it was on purpose, **Delete them** confirms it (Linux/macOS: or `saqme restore-deletes` / `saqme allow-deletes`). |
| Phone shows the welcome screen after installing | Expected on iPhone: type the pairing code (**Pair phone** on the computer, or the one Safari showed) into the field on that screen. *Wrong or expired*: show a new one; a code works once, for 10 minutes. Pasting the pairing link works too. |
| Setup stops: "running inside another app's package" | It was started from a shell that belongs to a Store app (for example an AI assistant in a desktop app); Windows would keep what it installs in that app's private copy of `AppData`. Run the command it prints from File Explorer (double-click `setup.cmd`) or Win+R. In the app: quit Saqme from the tray icon, start it from the Start menu, then **Set up sync**. |
| Linux/macOS window says it is "not connected" | It was opened from a bookmark. Open Saqme from the menu (or `saqme open`); that hands the window its key. |
| Linux/macOS: "Port 47613 is used by another program" | Run setup again with `--port 47700` (any free port). |
| Linux: no reminders | Install `libnotify-bin` (Debian/Ubuntu) or `libnotify` (Fedora) for `notify-send`, and check that `saqme status` says it is running. |
| `npm` fails during setup | Usually network/proxy. Check that `https://registry.npmjs.org` opens in a browser, then re-run. |
| Setup cannot create the database | The free plan allows 10 D1 databases; delete unused ones in the dashboard (Storage & Databases > D1) or use another Worker name. |
| Push test says "not subscribed" | Settings > Notifications: switch Notifications off, then on again (subscriptions can expire). |
| Invite: "already used, has expired or was cancelled" | An invite works once, for 24 hours. Ask the owner for a new one (Share > Create invite link). |
| Share says "this list is not on your sync service yet" | The list was made a moment ago: wait until it synced (the cloud icon), then open Share again. |
| A shared list vanished | Its owner deleted the list (it comes back if they restore it), or you left it (on a phone: maybe on another of your phones). If its owner stopped sharing it, it stays as your own list and the app says so. In the browser: it was moved to your Saqme app. |
| Joining says "Open the invite link instead" | This copy of the app has no sync of its own and the list is on another address. Open the invite link itself and choose **Use it in this browser**, or pair the app first. |
| A shared list says "Not synced while this app is not paired" | The phone was unpaired; its shared lists wait (with your changes) and go on once it is paired with the same sync service again. |
| A shared list on a phone says the owner's Worker "could not be reached" | Your own sync service talks to theirs for your phone: check that their address still works in a browser. If it says "redirect" or "too much data", it is not a Saqme sync service. |
| Settings > Updates: "Sign in to Cloudflare to finish the update" | Cloudflare's sign-in from setup expired. Click **Sign in**, allow it in the browser; the update finishes by itself. |
| Settings > Updates: "The update to … is waiting" | The new apps need your Worker updated first, and that did not work (the reason is shown). Nothing changed; **Try again**, or wait: it is tried again later. |
| Settings > Updates: "did not start, so Saqme went back" | The new version did not come up on this computer; the one before runs again. Please report it with the log (below). |
| "Your sync service could not update its database" | The Worker's own database update failed; it tries again with the next request. If it keeps saying so, the reason is in the message; please report it. |
| Settings > Updates: "Cloudflare did not accept the update token" | The token expired, was deleted, or lacks *Workers Scripts: Edit* for the account your sync service is in. Make a new one (Settings > Updates > Remove the token, then *Let it update itself…*). |
| Settings > Updates: "an update that stopped halfway" | Cloudflare holds a newer version of your sync service that is not deployed. Update it once from the app on your computer (or deploy that version, or another, in the dashboard), then try again. |
| Settings > Updates: "…went back to … by itself" | The new version could not update its database, so the version before runs again; the reason is shown. It is tried again only with Update now; please report it. |
| Sharing says the sync service "runs an older version" | Your Worker is not updated yet: Settings > Updates on the computer (it updates the Worker too). |
| Logs | Windows: `%APPDATA%\SaqmeToDo\sync\sync.log` (Settings > Sync & sharing > Advanced > *Sync log* opens it), updates in `%LOCALAPPDATA%\Programs\SaqmeToDo\update\result.json`. Linux/macOS: `local/saqme.log` in the data folder. |

Re-running setup is always safe: finished steps are skipped and existing keys, database and lists are reused.

## Removing everything

- **Windows app:** Windows Settings > Apps > *Saqme To Do* > Uninstall, or `setup.cmd -Uninstall`.
  Your lists stay in `%APPDATA%\SaqmeToDo`; add `-PurgeData` to delete them and the sync keys too.
- **Linux / macOS app:** `scripts/setup.sh --uninstall` (or the one-line command with `--uninstall` after
  `bash -s --`; on macOS it also removes the `saqme://` helper app). The lists stay; add `--purge-data` to
  delete them and setup's folder with the sync keys
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
