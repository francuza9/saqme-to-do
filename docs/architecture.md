# Architecture

```
 Windows PC                                   Your Cloudflare account (free plan)          iPhone
┌───────────────────────────────┐            ┌───────────────────────────────────┐       ┌──────────────────────┐
│ widget.ps1  (WPF, UI thread)  │            │ Worker "saqme"                    │       │ PWA (Safari / Home   │
│   reads/writes lists\*.md     │            │  /api/sync   merge + cursors      │◄─────►│  Screen app)         │
│   applies sync plans between  │            │  /api/push/* Web Push subscribe   │ HTTPS │  store.js: memory +  │
│   edits                       │            │  static assets = the PWA          │       │  IndexedDB + outbox  │
│ sync-worker.ps1 (runspace)    │◄──────────►│  cron */5: reminders -> Web Push  │       │  sw.js: offline +    │
│   sync-core.ps1: diff, plans, │   HTTPS    │ D1 "saqme": tasks, projects,      │       │  notifications       │
│   HTTP, state.json            │            │  settings, conflicts, push subs   │       └──────────────────────┘
└───────────────────────────────┘            └───────────────────────────────────┘
```

## Components

| Path | What |
|---|---|
| `desktop/widget.ps1` | The Windows app: PowerShell 5.1 + WPF, tray icon, Windows toasts. Reads and writes the markdown lists. |
| `desktop/sync-core.ps1` | Shared by the UI and the sync loop: markdown ↔ items (incl. `^id` markers), fractional order keys, the value rules, the sync engine (diff, outbox, remote plans), HTTP. |
| `desktop/rules.ps1` | The widget's deadline and reminder rules (parsing "fri 14:00", labels, pill colours, which notifications are due). |
| `desktop/sync-worker.ps1` | The background sync loop, run in its own PowerShell runspace. |
| `desktop/qr.ps1` | QR encoder for *Pair phone* (byte-identical to `worker/public/js/qr.js`). |
| `worker/src/index.js` | Worker entry: routing, bearer auth, cron handler. |
| `worker/src/pairing.js` | One-time pairing codes for phones (the app on an iPhone's Home Screen). |
| `worker/src/merge.js` | Pure merge rules (per field, conflicts, edit vs delete, cycle checks). |
| `worker/src/sync.js` | D1 access for `/api/sync`: optimistic batches, paging. |
| `worker/src/push.js`, `reminders.js` | Web Push (VAPID + RFC 8291 encryption, WebCrypto only) and the reminder rules. |
| `worker/public/` | The PWA: `index.html`, `js/app.js` (UI), `js/store.js` (data + sync), `js/model.js`, `js/dates.js`, `js/keys.js`, `js/markdown.js` (list format, shared with the Linux/macOS app), `js/zip.js` (export / import), `sw.js`. |
| `local/` | The Linux/macOS app (Node.js 22.13+, no dependencies): `saqme.mjs` (commands, the app process), `server.mjs` (local server), `d1.mjs` (D1 API on `node:sqlite`), `engine.mjs` (lists folder engine, a port of `sync-core.ps1`), `desktop.mjs` (notifications, app window), `paths.mjs`, `icns.mjs`. |
| `worker/migrations/` | D1 schema. |
| `scripts/` | `setup.ps1` (Windows), `setup.sh` (Linux, macOS, WSL), `cloud-setup.mjs` (provisioning), dev helpers. |
| `shared/fixtures/` | Input → expected output for every rule that exists in both languages; see below. |
| `.github/workflows/pages.yml` | Publishes `worker/public` as a static site (GitHub Pages) for using the phone app without a Cloudflare account. |

## Desktop: threads and files

- **UI thread** (WPF dispatcher): everything visible. Every edit is written to the list file at once
  (atomically: temp file + replace; merged by task id if someone else changed the file meanwhile).
  The UI never waits for the network.
- **Sync loop** (separate runspace, `sync-worker.ps1`): wakes every ~12 s, ~1.6 s after a local edit,
  when the window is shown, or on *Sync now*. It reads the lists, diffs them against the last synced base,
  talks to the Worker and computes a **plan** of file changes for whatever arrived from other devices.
  It never writes list files itself.
- **Hand-over:** the loop puts the plan in a shared, synchronized hashtable; the UI's 800 ms timer picks it
  up **only when you are not typing, editing notes, renaming a tab or dragging**, re-checks that every file
  still has exactly the content the plan was computed from, writes them all, reloads the open list and
  repaints. If anything changed meanwhile, the plan is dropped and recomputed in the next cycle — files are
  never overwritten with stale content.
- Status (synced / syncing / offline / error), conflicts and the "deletions paused" guard flow back the same
  way and show up as the small cloud glyph and badge in the tab strip.

Data folder (`%APPDATA%\SaqmeToDo`, see [file-format.md](file-format.md)):
`lists\*.md` (your lists), `.widget-settings`, `.widget-pos`, `sync\config.json` (server URL + token +
device id), `sync\state.json` (sync engine state), `sync\sync.log`, `cloud.json` (what setup generated).

## Linux and macOS app

```
 your computer (one Node.js process, `saqme serve`)
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ app window (the PWA, in a Chromium --app window or any browser)                                 │
│     ▲ http://127.0.0.1:47613 (own key, one-time code from `saqme open`)                        │
│ server.mjs: PWA files + /api via worker/src on d1.mjs (node:sqlite, local/store.db)            │
│     ▲ in-process                                                                               │
│ engine.mjs "files" ◄──► lists/*.md ◄──► engine.mjs "cloud" ◄──── HTTPS ────► your Worker (opt.) │
│ reminders: worker/src/reminders.js rules -> notify-send / Notification Center                   │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **The window is the phone app.** Same files, same look, served by the local server; it syncs with the
  local store exactly as it would with a Worker. The local store runs the Worker's own code
  (`worker/src`) through a small D1 adapter, so merging, conflicts and *Recently deleted* behave the same.
- **The lists folder stays the source of truth on disk.** The `files` engine keeps it in step with the local
  store (ids, line-preserving plans, the mass-delete guard: everything from the Windows engine). With cloud
  sync on, a second engine syncs the same folder with your Worker; see [sync.md](sync.md#linux-and-macos-one-folder-two-engines).
- **Settings > Sync > Set up sync** runs `scripts/cloud-setup.mjs` (installed with the app; it fetches the
  Cloudflare tools on first use) from the local server and streams its output to the window; it writes
  `sync/config.json` when it succeeds and the cloud engine starts. On Windows the widget runs
  `setup.ps1 -FromApp` in a console window of its own and reads the result file it leaves.
- **Process and start:** `setup.sh` installs the files to `~/.local/lib/saqme` (macOS: `~/Library/Application
  Support/Saqme To Do/app`), a launcher `~/.local/bin/saqme`, a menu entry or `~/Applications/Saqme To
  Do.app`, and starts `saqme serve` at login (systemd user service, desktop autostart entry, or LaunchAgent).
  `saqme open` starts it if needed and opens the window.
- **Runtime:** Node.js 22.13+ (for `node:sqlite`). Setup uses an installed one or downloads the official
  Node.js 24 build into the app folder (glibc 2.28+, macOS 13.5+). No compiled code of our own and no npm
  dependencies at run time.

## Phone (PWA)

- `store.js` keeps every row in memory and in IndexedDB; edits apply locally at once and go into an
  **outbox** coalesced per field. Sync runs when the app opens or comes to the foreground, every 10 s while
  visible and 1 s after an edit; offline it backs off and retries.
- `sw.js` caches the app shell (network first with a short timeout, so updates arrive by themselves) and
  shows push notifications; tapping one focuses or opens the app.
- iOS gives Home Screen apps their own storage and starts them at the manifest's `start_url`, so neither the
  pairing link's `#pair=` part nor Safari's pairing reaches the installed app. It pairs with a **pairing
  code** instead (`worker/src/pairing.js`): a device that has the key asks the Worker for one
  (`POST /api/pair/code`); the welcome screen trades it for the key (`POST /api/pair/claim`). Safari, once
  paired by the link, shows a code with the *Add to Home Screen* steps; every *Pair phone* screen shows one
  under the QR code. The link's key leaves the address bar as soon as the app reads it.

## Worker and D1

- One Worker serves the PWA as **static assets** (free, not counted as requests) and `/api/*`
  (`run_worker_first`). The app it serves talks to the API on its own origin, and the service worker can
  cache everything; copies of the app hosted elsewhere reach the API across origins (see CORS below).
- **Auth:** single user. `AUTH_TOKEN` (256-bit, base64url) is a Worker secret; each API call needs
  `Authorization: Bearer <token>`, compared via SHA-256 digests in constant time. `/api/health` is public,
  and so is `/api/pair/claim`, which answers only for an open pairing code.
- **D1 tables:** `tasks`, `projects`, `settings`, `conflicts` (all with per-field timestamps and a change
  `seq`), `push_subscriptions`, `notified` (reminder dedupe), `meta` (`seq`, `db_id`, `lock`, `origin`).
  Rows are never hard-deleted: deletes are tombstones, so *Recently deleted* can restore them.
- **Cron** (`*/5 * * * *`): reads open tasks with deadlines up to tomorrow, evaluates the reminder rules
  in the time zone the phone reported, claims dedupe keys first (`INSERT … ON CONFLICT DO NOTHING RETURNING`)
  and sends Web Push. Subscriptions the push service reports as gone are removed.

## Rules that exist twice

The Windows app is PowerShell and everything else is JavaScript, so some rules are written twice. Each
has one set of cases in `shared/fixtures/` (JSON, plus sample `.md` files for the list format) that both
test suites load: `worker/test/node/shared-fixtures.test.js` (Vitest) and
`desktop/tests/shared-fixtures.tests.ps1`. A rule changed on one side only fails the other side's suite.

| Rule | PowerShell (Windows) | JavaScript | Fixtures |
|---|---|---|---|
| Deadline input: "today", "fri 14:00", "3pm", "+3", "25 oct" | `rules.ps1` `Parse-Due` | `public/js/dates.js` `parseDue` | `dates.json` (parse) |
| Deadline labels ("Today", "Fri", "17 Oct") and pill colours | `rules.ps1` `Due-Label`, `Get-DueTone` | `dates.js` `dueLabel`, `dueTone` | `dates.json` (labels, tones) |
| Reminders: 15 min before, at the time, the daily summary | `rules.ps1` `Get-Reminders` | `src/reminders.js` `computeReminders` (Worker cron and the Linux/macOS app) | `reminders.json` |
| The list format: reading, writing, line endings, ids for id-less lines | `sync-core.ps1` `Read-Items`, `ConvertTo-MarkdownText`, `Get-TextEol`, `Set-MissingIds` | `public/js/markdown.js` `parseItems`, `formatItems`, `detectEol`, `setMissingIds` | `markdown.json`, `markdown/*.md` |
| Fractional order keys | `sync-core.ps1` `Get-KeyBetween`, `Test-OrderKey`, `Get-RekeyMap` | `public/js/keys.js`, `local/engine.mjs` `rekeyMap` | `keys.json` |
| Value rules: task text, notes, times, dates, project and file names | `sync-core.ps1` `ConvertTo-CleanText`, `ConvertTo-CleanNotes`, `ConvertTo-CleanTime`, `Test-ValidDate`, `ConvertTo-ProjectName`, `ConvertTo-FileName` | `markdown.js` `cleanText`, `cleanNotes`, `cleanTime`, `isValidDate`, `cleanProjectName`, `toFileName` (used by the server, the phone app and the engine) | `text.json` |
| The lists-folder engine: files → changes, server rows → file plans | `sync-core.ps1` `Add-LocalDiff`, `Get-RemotePlan`, `Invoke-PlanOps` | `local/engine.mjs` (a port) | `engine.json`; the end-to-end test also runs both engines against one Worker |
| QR codes for pairing | `desktop/qr.ps1` | `public/js/qr.js` | `qr.test.js` checks that both build the same matrix (when `powershell.exe` is there) |
| Colours, type, spacing | `desktop/tokens.ps1` | `public/css/tokens.css` | both generated from `design/tokens.json`; `tokens.test.js` fails if they are stale or a colour is written anywhere else |

Decisions the fixtures pin down, where the two languages behave differently by default:

- **Times are wall-clock times** in the device's time zone, compared to the second; across a DST change
  "+1" is the next calendar day and a time alone ("2:30") means tomorrow once the clock has passed it.
  PowerShell's `DateTime` has no time zone, so its rules take "now" as the wall clock; the Vitest suite runs
  each case group with `TZ` set to the group's zone.
- **White space and digits are JavaScript's**: `trim()` and `\s` include U+FEFF but not U+0085, and `\d` is
  0-9 only. The PowerShell side trims `$script:JsSpace` and builds its list-format patterns with
  `Get-JsPattern` instead of using .NET's defaults.
- **Text matches are exact**: re-attaching an id to a line that lost it needs the same text in the same
  letter case (PowerShell hashtables ignore case, so `New-TextMap` is used there).

To run only these: `cd worker && npx vitest run test/node/shared-fixtures.test.js` and
`powershell -NoProfile -ExecutionPolicy Bypass -File desktop\tests\shared-fixtures.tests.ps1`. When they
disagree, decide which side is right, fix the other one and keep the case in the fixture.

## Security notes

- No secrets in the repository. `worker/wrangler.toml`, `.dev.vars`, `cloud.json` and the sync config are
  generated per user and git-ignored or outside the repo.
- The pairing link puts the token after `#`; browsers never send that part of a URL to a server, so it
  does not appear in request logs. The PWA stores it in IndexedDB; the desktop in `sync\config.json`
  (your profile folder). Anyone with the token can read and change your lists: `-RotateToken` replaces it.
- Strict Content-Security-Policy for the PWA: scripts and styles from the app's own origin only, no inline
  scripts, no third-party requests. The Worker sends it as a header (`worker/public/_headers`, with
  `frame-ancestors 'none'` and `X-Frame-Options: DENY`); `index.html` repeats it as a meta tag for static
  hosts, there also allowing `connect-src https:` (to reach your Worker from elsewhere). A meta tag cannot
  forbid framing, so the app itself refuses to run inside another site's frame. Where both apply, the
  stricter one wins (`connect-src 'self'`).
- **Pairing codes** (`worker/src/pairing.js`): 8 characters out of 31 (about 40 bits), made only for a caller
  with the token, usable once, for 10 minutes, at most 5 open; 10 wrong guesses drop every open code, so a
  guess has about 10 in 8·10¹¹ chances per code. Stored as SHA-256 digests in D1's `meta` table. With no
  code open a claim writes nothing, so strangers cannot run up the database's write quota.
- **CORS:** the Worker's API answers cross-origin requests, so a copy of the app on a static host can pair
  with it. That gives other sites nothing: there are no cookies, and every call needs the token (the
  pairing code claim needs an open code).
- **The Linux/macOS local server** listens on 127.0.0.1 only, refuses any other `Host` header (DNS
  rebinding), sends no CORS headers, and needs its own 256-bit key (`local/token`, mode 0600) for every API
  call. `saqme open` hands the key to the window through a one-time code (`#claim=`, valid two minutes,
  usable once), and the code through a private page (`local/open.html`, mode 0600) that the browser opens:
  neither appears on a command line, where other users of the computer could read it. The app's files
  (lists, database, logs) are readable by its user only.
- Push subscriptions are accepted only for the push services browsers use (Google, Mozilla, Apple,
  Microsoft), so a token holder cannot make the Worker send requests anywhere else.
- Web Push payloads are end-to-end encrypted to the phone (RFC 8291); Apple/Google relay them without being
  able to read them.

## Free plan budget

| Limit (free) | Typical use |
|---|---|
| 100,000 Worker requests / day | desktop ~7,200 if running 24 h (one request per ~12 s), phone ~6 per minute while open, cron 288 |
| 10 ms CPU per request | sync requests are capped at 100 changes and 600 rows per page |
| 5 M D1 rows read / day | an idle sync reads a few rows; the cron reads open tasks with deadlines |
| 100,000 D1 rows written / day | only real changes write |
| 5 GB D1 storage | text lists: kilobytes to a few MB |
