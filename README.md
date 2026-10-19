<p align="center">
  <img src="docs/images/logo.png" width="112" height="112" alt="Saqme To Do icon">
</p>

<h1 align="center">Saqme To Do</h1>

<p align="center">
  Markdown to-do lists you and your AI can edit, on desktop and phone, with optional sync in your own Cloudflare account.
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/hero-light.png">
    <img src="docs/images/hero-light.png" width="860" alt="The desktop widget and the iPhone app side by side, showing the same Work list with subtasks, deadlines and a Georgian task">
  </picture>
</p>

## Features

- **Your lists are files.** One markdown file per project (`lists/Work.md`). Edit them in any editor, script
  them, or let an AI assistant rewrite them; the app picks the changes up. [Format](docs/file-format.md).
- **Every platform, one look.** A small widget on Windows, an app window on macOS and Linux, and the phone
  app on iPhone and Android. All work offline and share one design, down to the typeface.
- **No account needed.** Everything works on a single device. Sync is optional: it runs on the free plan of
  your own Cloudflare account, with no subscription and no server run by anyone else.
- **Built for real lists.** Subtasks with progress, seven statuses, deadlines with an optional time (type
  "fri 14:00" or "+3"), notes with links, drag to reorder, move tasks between projects.
- **Reminders.** 15 minutes before a timed deadline and at the time, plus one daily summary of what is due:
  on the computer from the start, on phones once sync is set up.
- **Keyboard-first on Windows.** Up/Down move between tasks, Enter adds a task, Shift+Enter a subtask, Tab
  indents while you edit one, Alt+Up/Down moves it.
- **Accessible.** Everything works from the keyboard; screen readers get names, roles and states for every
  control (checked with axe-core and Windows UI Automation); text and status colours meet WCAG 2.2 AA in both
  themes. [What is checked](docs/accessibility.md).

## Get started in one command

**Windows:** paste this into PowerShell (or a Command Prompt).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/francuza9/saqme-to-do/main/scripts/setup.ps1 | iex"
```

**macOS and Linux:** paste this into a terminal.

```bash
curl -fsSL https://raw.githubusercontent.com/francuza9/saqme-to-do/main/scripts/setup.sh | bash
```

Setup installs the app with your lists on this computer; no account is needed. To have them on your phone
too, open the app's **Settings > Sync** and choose **Set up sync**. It creates your own free sync service in
your Cloudflare account and uploads your lists (nothing is deleted). The one step it cannot do for you is the
Cloudflare login: a browser window opens, you sign in (or create a free account) and click **Allow**. Then the
app shows a QR code for your phone. Running setup again is safe at any time: it updates or repairs the app.

| | Without an account | With sync |
|---|---|---|
| **Windows** | desktop widget, lists in a folder | the same lists on your phones and other computers |
| **macOS, Linux** | app window, lists in a folder, reminders | the same |
| **iPhone, Android** | the phone app, lists on the phone (export and import as markdown) | pair it with the QR code |

Prefer to look first? Download the repository as a ZIP and run **`setup.cmd`** (Windows) or
`scripts/setup.sh`. Every step, requirement and manual click is in [docs/setup.md](docs/setup.md).

<details>
<summary>Setup options</summary>

| Windows | macOS, Linux | What it does |
|---|---|---|
| (default) | (default) | only the app; your lists stay on this computer |
| `-Cloud` | `--cloud` | the app and the cloud part (what Settings > Sync > Set up sync does; also updates it) |
| `-CloudOnly` | `--cloud-only` | only the cloud part |
| `-RotateToken` | `--rotate-token` | a new access key: the old one stops working at once (pair your devices again) |
| `-DeviceLogin` | `--device-login` | log in to Cloudflare with a code instead of a browser redirect |
| `-NoStart`, `-NoAutostart` | `--no-start`, `--no-autostart` | don't start the app / don't start it at login |
| `-Uninstall [-PurgeData]` | `--uninstall [--purge-data]` | remove the app (your lists stay unless you add the second option) |

</details>

## Your phone in 3 steps

1. **Scan the QR code** the computer app shows after setting up sync with the phone camera, and open the
   link (Safari on iPhone, Chrome on Android). To see it again: **Settings > Sync > Pair phone**.
2. **Add it to the Home Screen:** on iPhone tap **Share**, then **Add to Home Screen**; on Android, **Install app**.
3. **Turn on reminders:** open Saqme from the Home Screen, tap the logo to open **Settings**, and tap
   **Enable** next to Notifications (iOS 16.4 or later).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/phone-settings-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/phone-settings-light.png">
    <img src="docs/images/phone-settings-light.png" width="300" alt="Phone app settings with the button that enables notifications">
  </picture>
</p>

Your lists are already there, and they stay available offline. No Cloudflare account? The phone app also
works on its own, with the lists kept on the phone: open <https://francuza9.github.io/saqme-to-do/> and tap
**Use it on this device** ([details](docs/setup.md#7-phones-and-browsers-without-a-cloud-account)).

## How sync works

Every change is saved on the device first and sent in the background to a small Worker with a D1 database
in your Cloudflare account, which passes it on to your other devices. Changes merge per task and per field,
so renaming a task on the phone while ticking it off on the PC keeps both. If the same field changes on two
devices before they sync, the newest edit wins and the other one waits under **Conflicts** for you to pick;
deleted tasks go to **Recently deleted**. On a computer, the lists folder is part of this: a file edited by
hand or by an AI assistant syncs like any other change. The details are in [docs/sync.md](docs/sync.md).

## Privacy

Your lists are stored on your devices and, if you turn sync on, in the database of your own Cloudflare
account. Nobody else runs a server for this app, and it has no analytics or tracking. Without sync, nothing
leaves the device. With it, devices prove access with a 256-bit key that travels in the pairing link after
the `#`, the part of a URL browsers never send to a server. Cloudflare hosts the data (encrypted at rest);
the key is stored on your devices (the app's data folder and the phone app's storage), so protect them as
you would any signed-in device. On macOS and Linux the app window talks to a local program that answers
only on this computer and only with its own key.

The copy of the phone app on GitHub Pages (for use without a Cloudflare account) is shared: everyone who
uses it runs the code published there. If you would rather not trust that, use the copy your own sync
service serves (with sync, the QR code opens exactly that) or host your own (fork the repository and enable
Pages).

## FAQ

**Does it cost anything?** No. Without sync there is nothing to pay for. Sync fits Cloudflare's free plan
with a wide margin: a typical day is under 10,000 requests against 100,000 allowed, and the database stays
in the megabytes against 5 GB.

**Do I need a Cloudflare account?** Only for sync. Each app works on its own, and the phone app can export
and import its lists as markdown files.

**What happens offline?** Everything keeps working. Changes queue up and are sent when the connection is
back.

**Can my AI assistant edit the lists?** Yes, that is the point. Each line carries a short id like
`^k3j9x2ab` so sync can follow a task through edits; leave it in place (the app usually re-attaches a lost
one). See [docs/file-format.md](docs/file-format.md).

**Android?** Yes: the phone app installs from Chrome, push included. It is tuned and tested mostly on iPhone.

**Which Linux and macOS versions?** Linux with glibc 2.28 or newer (Debian 10, Ubuntu 20.04, RHEL 8, Fedora
and anything newer) and macOS 13.5 or newer; older systems work with Node.js 22.13+ installed.
[Details](docs/setup.md#requirements-linux-and-macos).

**No notifications on Windows?** Check Do Not Disturb, and make Saqme To Do a priority app under Windows
notification settings. More in [docs/setup.md](docs/setup.md#windows-notifications).

## Documentation

- [docs/setup.md](docs/setup.md): every setup step, updating, troubleshooting, removing everything
- [docs/sync.md](docs/sync.md): the sync protocol and conflict rules
- [docs/file-format.md](docs/file-format.md): the markdown format and the data folder
- [docs/architecture.md](docs/architecture.md): how the pieces fit together
- [docs/design.md](docs/design.md): colours, type and layout shared by all the apps
- [docs/accessibility.md](docs/accessibility.md): keyboard, screen readers, contrast, and how they are checked
- [CONTRIBUTING.md](CONTRIBUTING.md): running the tests and the apps locally

## License

MIT, see [LICENSE](LICENSE). The bundled typeface is [FiraGO](https://github.com/bBoxType/FiraGO) by Carrois / bBox Type and HERE,
under the SIL Open Font License 1.1 ([worker/public/fonts/OFL.txt](worker/public/fonts/OFL.txt)).
