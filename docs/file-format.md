# The list files

Each project is one markdown file in the `lists` folder; the tab name is the file name. Project names leave
out what file names cannot hold everywhere (`\ / : * ? " < > |`, control characters, dots and spaces at the
end) and stop at 100 characters; names Windows reserves for devices (`con`, `nul`, `lpt1`, …) get the file
name `Project con.md`.

| | Lists folder |
|---|---|
| Windows | `%APPDATA%\SaqmeToDo\lists\<Project>.md` |
| Linux | `~/.local/share/saqme/lists/<Project>.md` (`$XDG_DATA_HOME`, or `setup.sh --data`) |
| macOS | `~/Library/Application Support/Saqme To Do/lists/<Project>.md` |
| Phone | inside the app; **Settings > Data > Export lists** writes the same files into a zip |

Edit the files with any editor (or let an AI assistant do it); the app shows the change within a few
seconds and sync picks it up. Files are UTF-8 (a byte order mark is read and dropped; UTF-16 with a byte
order mark is read too, and a file in a legacy code page such as Windows-1252 keeps its accents). The apps
write UTF-8. A file keeps its line endings: when its first line ends in CRLF the apps write CRLF back,
otherwise LF; new files get LF.

```markdown
# Work
Notes for the whole list can go anywhere as plain text.

- [/] Ship the roadmap due:2026-10-25T14:00 ^k3j9x2ab
  > Draft: https://docs.example.com/roadmap
  > second line of the note
  - [x] Collect feedback ^p0q1r2s3
  - [ ] Review numbers with finance ^t4u5v6w7
- [!] Waiting on legal due:2026-10-28 ^a8b9c0d1

## Later
- [>] Clean up the old dashboards ^e2f3g4h5
```

## Tasks

`- [S] text` — a dash (or `*`), a space, a status in brackets, the text. Two spaces (or one tab) per level
make subtasks. A plain bullet without brackets is read as a to-do.

| Status | Meaning | Shown |
|---|---|---|
| `[ ]` | to do | in manual order |
| `[/]` | in progress | in manual order |
| `[!]` | blocked / waiting | in manual order |
| `[>]` | postponed | in the *Postponed* section at the bottom |
| `[x]` | done | folded into *Completed* |
| `[-]` | failed / rejected | folded into *Completed* |
| `[~]` | abandoned | folded into *Completed* |

Order within a level is the order of the lines. A status the apps do not know (Obsidian's `[?]`, `[<]`,
`[*]` and so on) counts as to do and stays as written while the task is to do.

## Deadlines

` due:YYYY-MM-DD` at the end of the line, optionally with a time: ` due:2026-10-25T14:00` (24-hour; the
app writes hours without a leading zero, `T9:30`). `DUE:` in capitals is read too and written back as
`due:`. A date that does not exist (`due:2026-02-30`) stays in the line but counts as no deadline. Times are
wall-clock times where you are: a deadline at 2:30 on the night the clocks go forward is over at 3:00.
Reminders: 15 minutes before and at a timed deadline; date-only and overdue tasks are collected in one
daily summary.

## Notes and links

Lines starting with `>` right below a task, indented deeper than the task, are its notes (a quote at the
task's own depth is an ordinary paragraph).
Links (`https://…` or `www.…`) become clickable. An empty `>` line keeps a blank line in the note.

## Ids

` ^k3j9x2ab` at the very end of a task line is its id (8 to 32 lowercase letters and digits). The app
adds it to every task and hides it; sync uses it to know which task is which across edits, moves and
devices.

- Leave it where it is when you edit a line. If an editor drops it, the app usually reattaches the old id
  (same text in the same list); otherwise the line is treated as a new task and the old one as deleted
  (restorable on the phone under *Recently deleted*).
- When you **copy** a line, one of the two copies gets a new id automatically. When you **move** a line to
  another file, keep the id — sync then moves the task instead of deleting and recreating it.
- Writing new tasks without an id is fine; they get one within seconds.

## Everything else is kept

Headings (`#`, `##`), paragraphs and blank lines are kept exactly where they are, and so are YAML front
matter (`---` at the very top), fenced code blocks (between ``` or ~~~ lines) and horizontal rules
(`* * *`, `---`): lines in them are never read as tasks. The first `# Heading`
is hidden in the app (it would repeat the tab name); other headings show as small section labels. Tasks
added on another device appear next to their neighbours (after the previous task's subtasks), so they stay
in the right section.

Note: a non-task line between a task and its indented lines ends the nesting — an indented task after a
heading or paragraph is a top-level task.

## Other files in the data folder

Windows (`%APPDATA%\SaqmeToDo`):

| File | What |
|---|---|
| `lists\.order` | tab order, one project name per line |
| `lists\.state` | which tasks are open or closed (per device, not synced) |
| `lists\.notified` | reminders already shown on this PC (dedupe, last 7 days) |
| `lists\.trash\` | deleted projects (`Name-YYYYMMDD-HHMMSS.md`), never erased automatically |
| `lists\.recovery\` | edits the app could not save before you quit or switched lists (the file was locked by another program); copy back what you need |
| `.widget-settings` | app settings (`theme`, `notifyAt`, window size, …), `key=value` |
| `.widget-pos` | window position |
| `recently-deleted.json` | tasks deleted in the widget in the last 30 days, as list lines with their ids (*Settings > Data > Recently deleted* restores them) |
| `sync\config.json` | server address, access token, this device's id (private) |
| `sync\state.json` | sync engine state (server rows, last synced base, unsent changes) |
| `sync\sync.log` | sync log (errors and summaries; rotated at 256 KB) |
| `cloud.json` | what setup generated: token, push keys, database id, URL (private) |

Linux and macOS (the data folder above `lists`): `lists/` with `.order` and `.trash/` as on Windows, plus

| File | What |
|---|---|
| `local/store.db` | the app's local database (SQLite): what its window shows, kept in step with `lists/` |
| `local/files-state.json` | engine state between `lists/` and that database (same format as `sync\state.json`) |
| `local/token` | the key of the local app; its window gets it through `saqme open` (private) |
| `local/server.json`, `local/settings.json` | port and process of the running app; `{"port": N}` chosen at setup |
| `local/saqme.log` | the app's log (rotated at 256 KB) |
| `sync/config.json`, `sync/state.json` | cloud sync, as on Windows (only when sync is set up) |

Only the daily summary time (`notifyAt`) and the phone's time zone are synced settings; theme, window and
open/closed state stay per device.
