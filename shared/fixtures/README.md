# Shared fixtures

Cases for the rules that exist both in the Windows app's PowerShell and in JavaScript (the phone app, the
Worker, the Linux/macOS app): input → expected output, in plain JSON so neither language owns them.
[docs/architecture.md](../../docs/architecture.md#rules-that-exist-twice) lists which function on each side
implements what.

| File | Rules |
|---|---|
| `dates.json` | deadline input ("fri 14:00", "+3", "25 oct"), labels, pill colours; each group has a fixed "now" and time zone |
| `reminders.json` | which notifications are due at a moment (UTC "now", with the IANA and the Windows name of the zone) |
| `markdown.json`, `markdown/*.md` | reading and writing the list files byte for byte; ids for lines that lost theirs |
| `keys.json` | fractional order keys: between, valid, rekey, and a 300-step insert walk |
| `text.json` | task text, notes, times, dates, project and file names |
| `ai-prompt.json`, `ai-prompt/*.md` | the "Use with AI" instructions, byte for byte, for paths with spaces and Georgian letters |
| `claude-config.json` | Connect Claude Desktop: Saqme's entry in Claude Desktop's settings file (add, remove, state; files left alone) |
| `engine.json` | the lists-folder engine: plans that bring the files in line with the server, and the changes it reads from them |

Every JSON file starts with an `about` that explains its case format. The `.md` samples are compared as
bytes (`.gitattributes` keeps git from touching their line endings); `name.expected.md` is what the apps
write back when that is not the file itself.

Run them:

```bash
cd worker && npx vitest run test/node/shared-fixtures.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/tests/shared-fixtures.tests.ps1
```

When the two sides disagree on a case, decide which one is right, fix the other and keep the case. Don't
loosen a case to make both pass.

## Where the two sides disagreed

What the fixtures found when they were introduced, and which behaviour was kept:

| Disagreement | Kept |
|---|---|
| month words: JavaScript took any word starting with a month's 3 letters ("octo 25", "sept"), PowerShell only "oct" and "october" | the 3-letter or full name, plus "sept" (the PowerShell parser is now a port of dates.js) |
| "29 feb" more than 30 days ago: 28 Feb next year (PowerShell) or nothing (JavaScript) | nothing: that day does not exist next year |
| PowerShell took the year from the computer's clock, not from "now"; .NET's `\d` read "٣pm" as 3 pm | "now" everywhere; digits are 0-9 |
| any word starting with a day's first letters was that day on both sides ("fridge" = Friday) | a prefix of the day's name ("fri", "frid", "friday") or "weds" |
| a time alone and timed pill colours: instants (JavaScript) vs the wall clock (PowerShell), apart around DST | the wall clock, to the second |
| the Worker cron's 23:55 cap on the daily summary applied in the Linux/macOS app too | only the Worker passes it (`lastRun`) |
| an invalid summary time: an error in PowerShell, no summary in JavaScript | 10:00 |
| early reminder subtitle "Work  \|  16:00" (PowerShell) vs "Work  ·  16:00" (JavaScript); PowerShell rounded the minutes left up from seconds | "Work · 16:00"; whole wall-clock minutes |
| a CRLF file was rewritten as LF by both | each file keeps its line endings |
| a byte order mark stayed in the first line in PowerShell's parser | dropped by both |
| a task line with a stray CR, U+2028 or U+2029 was prose in JavaScript (so sync deleted the task) | a task |
| .NET's `\s` (U+0085, no U+FEFF), `\d` and `$` (matches before a final line break) in the list format, times and dates | JavaScript's, on both sides |
| .NET's `Trim()` (keeps U+FEFF, removes U+0085) for task text, notes and names | JavaScript's `trim()` set |
| a lost id came back for the same text in another letter case in PowerShell only | exact text only |
| year 0000 was a valid date in JavaScript only | years 1-9999 |
| three project-name rules (widget tab rename, phone app, file names): control characters, trim order, a dot left after the 100-character cut | one rule: `cleanProjectName` / `ConvertTo-ProjectName` |
| renaming "work" to "Work" made "Work (2).md" and refused the rename in PowerShell | the same file is renamed |
