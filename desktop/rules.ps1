# Saqme To Do - date and reminder rules of the Windows widget. Dot-source it; it only defines functions.
# The same rules exist in JavaScript (worker/public/js/dates.js, worker/src/reminders.js); both are checked
# against shared/fixtures/dates.json and reminders.json, so keep them in step (docs/architecture.md).
#
#   Parse-DueDate / Parse-Due   "today", "fri", "+3", "25 oct", "fri 14:00", "3pm" -> date (+ time)
#   Due-Label / Get-DueTone     "Today", "Fri", "17 Oct" / over | soon | later | closed
#   Get-Reminders               which notifications are due now (15 min before, at the time, daily summary)
# Every function takes "now" as a local wall-clock [datetime] (default: the computer's clock).

$script:RuleCI = [Globalization.CultureInfo]::InvariantCulture
$script:RuleDayNames = @('sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday')
$script:RuleMonthNames = @('january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december')

# a weekday: a prefix of its name of at least 3 letters ("fri", "frid", "friday"), or "weds"
function Get-WeekdayIndex([string]$w) {
  if ($w -cnotmatch '^[a-z]{3,9}$') { return -1 }
  for ($i = 0; $i -lt 7; $i++) { if ($script:RuleDayNames[$i].StartsWith($w, [StringComparison]::Ordinal)) { return $i } }
  if ($w -ceq 'weds') { return 3 }
  return -1
}
# a month: its first three letters, its full name, or "sept"; 0-based, -1 if none
function Get-MonthIndex([string]$w) {
  if ($w -cnotmatch '^[a-z]{3,9}$') { return -1 }
  for ($i = 0; $i -lt 12; $i++) {
    $full = $script:RuleMonthNames[$i]
    if ($w -ceq $full -or ($w.Length -eq 3 -and $full.StartsWith($w, [StringComparison]::Ordinal)) -or ($i -eq 8 -and $w -ceq 'sept')) { return $i }
  }
  return -1
}
function New-RuleDate([int]$y, [int]$m, [int]$d) {
  if ($y -lt 1 -or $y -gt 9999 -or $m -lt 1 -or $m -gt 12 -or $d -lt 1 -or $d -gt [DateTime]::DaysInMonth($y, $m)) { return $null }
  return New-Object DateTime($y, $m, $d)
}

# "today", "tmr", "+3", "+2w", "fri", "25 oct", "oct 25", "25.10", "25/10/2027", "2026-10-25" -> [datetime] or $null
function Parse-DueDate([string]$s, [datetime]$Now = (Get-Date)) {
  $s = $s.Trim().ToLowerInvariant(); $t = $Now.Date
  if (-not $s) { return $null }
  if ($s -ceq 'today' -or $s -ceq 'tod') { return $t }
  if ($s -ceq 'tomorrow' -or $s -ceq 'tmr' -or $s -ceq 'tom') { return $t.AddDays(1) }
  if ($s -cmatch '^\+([0-9]+)d?$') { return $t.AddDays([int]$matches[1]) }
  if ($s -cmatch '^\+([0-9]+)w$') { return $t.AddDays(7 * [int]$matches[1]) }
  $wd = Get-WeekdayIndex $s
  if ($wd -ge 0) {
    $d = $t.AddDays(1)
    while ([int]$d.DayOfWeek -ne $wd) { $d = $d.AddDays(1) }   # strictly after today
    return $d
  }
  $y = $null; $mo = $null; $day = $null
  if ($s -cmatch '^([0-9]{4})-([0-9]{2})-([0-9]{2})$') { $y = [int]$matches[1]; $mo = [int]$matches[2]; $day = [int]$matches[3] }
  elseif ($s -cmatch '^([0-9]{1,2})\s+([a-z]{3,9})(?:\s+([0-9]{4}))?$' -and (Get-MonthIndex $matches[2]) -ge 0) {
    $day = [int]$matches[1]; $mo = (Get-MonthIndex $matches[2]) + 1; if ($matches[3]) { $y = [int]$matches[3] }
  }
  elseif ($s -cmatch '^([a-z]{3,9})\s+([0-9]{1,2})$' -and (Get-MonthIndex $matches[1]) -ge 0) { $mo = (Get-MonthIndex $matches[1]) + 1; $day = [int]$matches[2] }
  elseif ($s -cmatch '^([0-9]{1,2})[./]([0-9]{1,2})(?:[./]([0-9]{4}))?$') { $day = [int]$matches[1]; $mo = [int]$matches[2]; if ($matches[3]) { $y = [int]$matches[3] } }
  else { return $null }
  $explicit = ($null -ne $y)
  $d = New-RuleDate $(if ($explicit) { $y } else { $t.Year }) $mo $day
  if (-not $d) { return $null }
  # a day this year that is more than 30 days gone means next year's (29 Feb may not exist then: no date)
  if (-not $explicit -and $d -lt $t.AddDays(-30)) { return (New-RuleDate ($d.Year + 1) $mo $day) }
  return $d
}

# Parse-DueDate plus a time: "fri 14:00", "25 oct 9:30", "3pm", "14:00" (a time alone: today, or tomorrow if
# it has passed). Returns @{ Date = [datetime]; Time = 'H:MM' or '' } or $null.
function Parse-Due([string]$s, [datetime]$Now = (Get-Date)) {
  $s = $s.Trim().ToLowerInvariant(); $t = $Now.Date; $time = ''
  if (-not $s) { return $null }
  if ($s -cmatch '^(.*?)\s*(?:at\s*)?([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)$' -or $s -cmatch '^(.*?)\s*(?:at\s*)?([0-9]{1,2}):([0-9]{2})$') {
    $h = [int]$matches[2]; $mi = $(if ($matches[3]) { [int]$matches[3] } else { 0 })
    if ($matches[4] -ceq 'pm' -and $h -lt 12) { $h += 12 }
    if ($matches[4] -ceq 'am' -and $h -eq 12) { $h = 0 }
    if ($h -gt 23 -or $mi -gt 59) { return $null }
    $time = '{0}:{1:00}' -f $h, $mi
    $s = $matches[1].Trim()
    if (-not $s) {
      # passed on the wall clock (to the second, like the JavaScript side): tomorrow
      $d = $t; if ([Math]::Floor(($Now - $t).TotalSeconds) -gt ($h * 3600 + $mi * 60)) { $d = $t.AddDays(1) }
      return [pscustomobject]@{ Date = $d; Time = $time }
    }
  }
  $d = Parse-DueDate $s $Now
  if ($d) { return [pscustomobject]@{ Date = $d; Time = $time } }
  return $null
}

function Due-Label([datetime]$d, [datetime]$Now = (Get-Date)) {
  $today = $Now.Date; $diff = ($d.Date - $today).Days
  if ($diff -eq 0) { return 'Today' }
  if ($diff -eq 1) { return 'Tomorrow' }
  if ($diff -eq -1) { return 'Yesterday' }
  if ($diff -gt 1 -and $diff -lt 7) { return $d.ToString('ddd', $script:RuleCI) }
  if ($d.Year -eq $today.Year) { return $d.ToString('d MMM', $script:RuleCI) }
  return $d.ToString('d MMM yyyy', $script:RuleCI)
}

# how a deadline looks: over (red pill) | soon (today / tomorrow, amber pill) | later (plain text) | closed
function Get-DueTone([string]$date, [string]$time, [bool]$closed, [datetime]$Now = (Get-Date)) {
  if ($closed) { return 'closed' }
  $d = [datetime]::ParseExact($date, 'yyyy-MM-dd', $script:RuleCI)
  $diff = ($d - $Now.Date).Days
  $over = ($diff -lt 0)
  if ($time -cmatch '^([0-9]{1,2}):([0-9]{2})$') {
    $over = ($d.AddHours([int]$matches[1]).AddMinutes([int]$matches[2]) -lt $Now.AddMilliseconds(-$Now.Millisecond))   # to the second
  }
  if ($over) { return 'over' }
  if ($diff -le 1) { return 'soon' }
  return 'later'
}

# 'H:MM' -> minutes after midnight, or $null when it is not a valid time of day
function Get-RuleMinutes([string]$hm) {
  if ($hm -cmatch '^([0-9]{1,2}):([0-9]{2})$' -and [int]$matches[1] -lt 24 -and [int]$matches[2] -lt 60) { return [int]$matches[1] * 60 + [int]$matches[2] }
  return $null
}

# Reminder rules (same as computeReminders in worker/src/reminders.js):
#   timed deadline     -> "In N min" 15 minutes before, then "Due now" / "Overdue since H:MM" at the time
#                         (still sent up to 12 h late if nothing ran in between)
#   due today, no time -> one daily summary at notifyAt (10:00 when it is not a valid time)
#   anything overdue   -> (date before today, timed or not) the same daily summary
# Only open tasks count (to do, in progress, blocked). Times are wall-clock times, like the deadlines.
#   $tasks: @{ Id; Text; Status; Due = 'YYYY-MM-DD'; DueTime = 'H:MM' or ''; Project }
#   $notified: hashtable of keys already shown. Returns @{ Keys = @(...); Title; Body; Sub } for each one due now.
function Get-Reminders($tasks, [datetime]$Now, [string]$notifyAt, $notified) {
  $out = New-Object System.Collections.ArrayList
  $digest = New-Object System.Collections.ArrayList
  $todayS = $Now.ToString('yyyy-MM-dd', $script:RuleCI)
  $nowMin = [Math]::Floor(($Now - $Now.Date).TotalMinutes)
  foreach ($t in $tasks) {
    if (@(' ', '/', '!') -cnotcontains $t.Status -or -not $t.Due) { continue }
    if ([string]::CompareOrdinal($t.Due, $todayS) -lt 0) { [void]$digest.Add(@{ T = $t; Over = $true }); continue }
    $tm = Get-RuleMinutes $t.DueTime
    if ($null -eq $tm) { if ($t.Due -ceq $todayS) { [void]$digest.Add(@{ T = $t; Over = $false }) }; continue }
    # minutes from now to the deadline, on the wall clock (whole minutes, like the JavaScript side)
    $dayDiff = ([datetime]::ParseExact($t.Due, 'yyyy-MM-dd', $script:RuleCI) - $Now.Date).Days
    $left = $dayDiff * 1440 + $tm - $nowMin
    $kSoon = "$($t.Due)|soon|$($t.Id)|$($t.DueTime)"
    $kNow = "$($t.Due)|now|$($t.Id)|$($t.DueTime)"
    if ($left -le 15 -and $left -gt 0 -and -not $notified.ContainsKey($kSoon)) {
      [void]$out.Add(@{ Keys = @($kSoon); Title = "In $left min"; Body = $t.Text; Sub = "$($t.Project) $([char]0x00B7) $($t.DueTime)" })
    } elseif ($left -le 0 -and $left -gt -720 -and -not $notified.ContainsKey($kNow)) {
      $title = $(if (-$left -lt 5) { 'Due now' } else { "Overdue since $($t.DueTime)" })
      [void]$out.Add(@{ Keys = @($kNow, $kSoon); Title = $title; Body = $t.Text; Sub = $t.Project })
    }
  }
  $kDig = "$todayS|digest"
  $at = Get-RuleMinutes $notifyAt; if ($null -eq $at) { $at = 600 }
  if ($digest.Count -and $nowMin -ge $at -and -not $notified.ContainsKey($kDig)) {
    $over = @($digest | Where-Object { $_.Over }).Count
    $due = $digest.Count - $over
    if ($digest.Count -eq 1) { $title = $(if ($over) { 'Overdue' } else { 'Due today' }) }
    else { $parts = @(); if ($due) { $parts += "$due due today" }; if ($over) { $parts += "$over overdue" }; $title = $parts -join ', ' }
    $lines = @($digest | Select-Object -First 3 | ForEach-Object { $_.T.Text })
    if ($digest.Count -gt 3) { $lines += "+$($digest.Count - 3) more" }
    [void]$out.Add(@{ Keys = @($kDig); Title = $title; Body = ($lines -join "`n"); Sub = $(if ($digest.Count -eq 1) { $digest[0].T.Project } else { 'Saqme To Do' }) })
  }
  return ,$out
}

# "Use with AI": the instructions an AI assistant needs to manage the lists folder, with the real path filled in
# (Settings > Use with AI > With the files). local/ai-prompt.mjs has the same text for the Linux/macOS app;
# shared/fixtures/ai-prompt.json holds the expected output for both. LF line endings, ASCII only.
function Get-AiPrompt([string]$listsDir) {
  $template = @'
# My to-do lists (Saqme To Do)

My tasks are plain markdown files, one file per list, in this folder:

```
{DIR}
```

A file's name is the list's name (`Work.md` is the list "Work"). The Saqme To Do app watches the folder: when you change a file it picks the change up within a few seconds and syncs it to my other devices. So read and edit the files directly; there is nothing else to call.

## Format

A task is one line, `- [S] text`, where S is its status:

- `[ ]` to do, `[/]` in progress, `[!]` blocked or waiting
- `[>]` postponed
- `[x]` done, `[-]` failed or rejected, `[~]` abandoned

- Subtasks are indented two spaces per level under their parent.
- A deadline ends the text: ` due:YYYY-MM-DD`, with an optional time, ` due:YYYY-MM-DDTHH:MM` (24-hour, local time).
- A task's notes are lines starting with `> `, right below it and indented one level deeper than the task.
- The id is ` ^xxxxxxxx` (8 to 32 lowercase letters and digits) at the very end of the line. Sync follows a task by it, so keep it exactly as it is. A new task needs no id: the app adds one.
- Tasks are in the order of their lines. The order of the lists is in `.order` (one list name per line); a list that is not in it comes after the others.
- Everything else in a file (the `# Title`, other headings, paragraphs, blank lines) is mine: leave it where it is.

Example, `Work.md`:

```markdown
# Work
- [/] Ship the roadmap due:2026-10-25T14:00 ^k3j9x2ab
  > Draft: https://docs.example.com/roadmap
  - [x] Collect feedback ^p0q1r2s3
  - [ ] Review numbers with finance ^t4u5v6w7
- [>] Clean up the old dashboards ^e2f3g4h5
```

## Rules for you

- Never delete, rename or empty a list file. To finish a task, change its mark to `[x]`; remove a task's line (with its subtasks and notes) only when I ask.
- Never rewrite a whole file from memory. Read it first and change only the lines you mean to: the app or I may have changed it since you last looked.
- Keep every `^id` as it is. To move a task to another list, move its whole block (the line, subtasks and notes) with its ids: add it to the other file and remove it from the first.
- A new list is a new file, `Name.md`, starting with `# Name`. The name can't contain `\ / : * ? " < > |`.
- Leave the files whose names start with a dot alone, except `.order`: they belong to the app.
- Files are UTF-8 and keep their line endings.
- Change a file where it is (open, edit, save): don't write a new file and rename it over a list. Never start the Saqme app, its updater or its setup yourself: from some assistants' shells that works on a private copy of the folder instead of mine.
- If it is unclear which list or task I mean, ask before you change anything.
'@
  return (($template -replace "\r\n", "`n").Replace('{DIR}', $listsDir) + "`n")
}
