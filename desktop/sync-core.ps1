# Saqme To Do - shared core for the widget (UI thread) and the background sync runspace.
# Dot-source it; it only defines functions. Windows PowerShell 5.1.
#
#   markdown <-> items      Read-Items / ConvertTo-MarkdownText (one task line: "- [ ] text due:2026-10-25T14:00 ^k3j9x2ab")
#   order keys              Get-KeyBetween / Get-RekeyMap (port of worker/public/js/keys.js)
#   sync engine             Invoke-SyncCycle: diff files against the last synced base, send, apply remote changes
#
# Sync state (sync\state.json in the data dir):
#   R       = server rows as last received ("task:<id>" -> { kind, id, fields: { name: { v, ts } } })
#   S       = base: what the files reflected at the last reconcile, plus local changes already queued
#   Outbox  = local changes not yet acknowledged by the server (resent unchanged after a crash)
#   Files   = project id -> file base name
# A cycle: read files (L) -> queue Diff(L, S) -> POST /api/sync -> fold rows into R -> if no file changed
# meanwhile, rewrite the files so they match R (one all-or-nothing plan, executed on the UI thread) -> S := R.
# See docs/sync.md.

Add-Type -AssemblyName System.Web.Extensions

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:KeyDigits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
$script:Json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$script:Json.MaxJsonLength = [int]::MaxValue
$script:Json.RecursionLimit = 64
$script:ValidMarks = @(' ', '/', 'x', '>', '!', '-', '~')

# ================================================================ files
# Where the widget keeps its data: -DataDir, else SAQME_DATA_DIR, else the app's folder when a "lists" folder is next
# to it (portable), else %APPDATA%\SaqmeToDo. The self-check (-SmokeTest) adds tasks and settings, and syncs with any
# sync set up where it runs, so it never runs on someone's lists: without -DataDir it gets a new temp folder (the
# other three are real data), and a -DataDir that is one of those three is refused.
# -> @{ Dir; Temp ($true: a temp folder made up for the self-check); Refused (why it may not run there, or '') }
function Resolve-WidgetDataDir([string]$DataDir, [switch]$SmokeTest, [string]$AppDir, [string]$EnvDir, [string]$AppData, [string]$TempDir) {
  $real = @($EnvDir, $AppDir, $(if ($AppData) { Join-Path $AppData 'SaqmeToDo' })) | Where-Object { $_ }
  if (-not $SmokeTest) {
    $d = $(if ($DataDir) { $DataDir } elseif ($EnvDir) { $EnvDir } elseif ($AppDir -and (Test-Path -LiteralPath (Join-Path $AppDir 'lists'))) { $AppDir } else { Join-Path $AppData 'SaqmeToDo' })
    return @{ Dir = $d; Temp = $false; Refused = '' }
  }
  if (-not $DataDir) { return @{ Dir = (Join-Path $TempDir ('saqme-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))); Temp = $true; Refused = '' } }
  $norm = { param([string]$p) try { [IO.Path]::GetFullPath($p).TrimEnd('\', '/') } catch { $p } }
  foreach ($r in $real) {
    if ((& $norm $DataDir) -ieq (& $norm $r)) {
      return @{ Dir = $DataDir; Temp = $false; Refused = "the self-check adds tasks to the lists in $DataDir and syncs them, and that folder holds the app's real lists. Give it an empty scratch folder with -DataDir, or leave -DataDir out for a temp one." }
    }
  }
  return @{ Dir = $DataDir; Temp = $false; Refused = '' }
}

# File bytes -> text (byte order marks dropped): UTF-8, or UTF-16 with its byte order mark. A file that is
# not valid UTF-8 was saved in the system's legacy code page (Windows PowerShell's Set-Content does that)
# and is read that way, instead of turning its accents into U+FFFD for good on the next write.
$script:Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
function ConvertFrom-FileBytes([byte[]]$b) {
  if ($b.Length -ge 2 -and $b[0] -eq 0xFF -and $b[1] -eq 0xFE) { return [Text.Encoding]::Unicode.GetString($b, 2, $b.Length - 2) }
  if ($b.Length -ge 2 -and $b[0] -eq 0xFE -and $b[1] -eq 0xFF) { return [Text.Encoding]::BigEndianUnicode.GetString($b, 2, $b.Length - 2) }
  $start = $(if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { 3 } else { 0 })
  try { return $script:Utf8Strict.GetString($b, $start, $b.Length - $start) } catch { return [Text.Encoding]::Default.GetString($b) }
}

function Read-TextFile([string]$path) {
  # $null when missing or unreadable (locked / mid-write); never throws
  try {
    if (-not [IO.File]::Exists($path)) { return $null }
    # ReadWrite + Delete: a reader must never make another program's (or our own) atomic replace fail
    $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
      $ms = New-Object IO.MemoryStream
      $fs.CopyTo($ms)
      return (ConvertFrom-FileBytes $ms.ToArray())
    } finally { $fs.Dispose() }
  } catch { return $null }
}

# temp file + replace, so a crash never leaves a half-written list. Split in two steps so a plan can stage
# every file before replacing any of them.
function Write-TempFile([string]$path, [string]$text) {
  $dirPath = [IO.Path]::GetDirectoryName($path)
  $tmp = Join-Path $dirPath ('.' + [IO.Path]::GetFileName($path) + '.' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp')
  # flushed to disk before the replace: after a power cut the list is the old one or the new one, not empty
  $bytes = $script:Utf8NoBom.GetBytes($text)
  $fs = New-Object IO.FileStream($tmp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
  return $tmp
}
function Complete-TempFile([string]$tmp, [string]$path) {
  # antivirus, indexers and sync clients can hold a file for a moment: retry briefly
  for ($attempt = 1; ; $attempt++) {
    try {
      if ([IO.File]::Exists($path)) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
      return
    } catch {
      if ($attempt -ge 6) { try { [IO.File]::Delete($tmp) } catch {}; throw }
      Start-Sleep -Milliseconds (40 * $attempt)
    }
  }
}
function Write-TextFileAtomic([string]$path, [string]$text) {
  $tmp = Write-TempFile $path $text
  Complete-TempFile $tmp $path
}

# Replaces $path with $text only while it still holds $expected ($null: the file must not exist yet), checked
# again before every retry: a save never overwrites what another program wrote meanwhile, nor a file it
# cannot read (locked). Returns $false when the file changed (read again, merge, and try again later).
function Write-TextFileIfUnchanged([string]$path, [string]$text, $expected) {
  $tmp = Write-TempFile $path $text
  for ($attempt = 1; ; $attempt++) {
    $exists = [IO.File]::Exists($path)
    $same = $(if ($null -eq $expected) { -not $exists } else { $exists -and (Read-TextFile $path) -ceq $expected })
    if (-not $same) { try { [IO.File]::Delete($tmp) } catch {}; return $false }
    try {
      if ($exists) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
      return $true
    } catch {
      if ($attempt -ge 6) { try { [IO.File]::Delete($tmp) } catch {}; throw }
      Start-Sleep -Milliseconds (40 * $attempt)
    }
  }
}

# ================================================================ ids
function New-SaqmeId([int]$len = 8) {
  $alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  $bytes = New-Object byte[] $len
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append($alphabet[10 + ($bytes[0] % 26)])        # always starts with a letter
  for ($i = 1; $i -lt $len; $i++) { [void]$sb.Append($alphabet[$bytes[$i] % 36]) }
  return $sb.ToString()
}

# ================================================================ markdown <-> items
# An item is a task ({ Kind='task'; Level; Mark; MarkRaw; Indent; Text; Due; DueTime; Notes; Id }) or any other line
# ({ Kind='raw'; Raw }) kept verbatim (headings, blank lines, prose).

# The white space JavaScript's trim() and \s remove. .NET's Trim() differs (it keeps U+FEFF, removes U+0085), and
# the apps must agree on every value they sync, so the value rules below trim exactly this set.
$script:JsSpace = [char[]](@(9, 10, 11, 12, 13, 32, 0xA0, 0x1680) + @(0x2000..0x200A) + @(0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF))
# The list format's patterns, written as in markdown.js; \s and \d become JavaScript's (.NET's \d also takes
# other scripts' digits).
$script:JsSpaceClass = '\t\n\x0B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'   # inside [...]
function Get-JsPattern([string]$p) {
  return $p.Replace('\s', '[' + $script:JsSpaceClass + ']').Replace('\d', '[0-9]')
}
$script:RxTaskLine = Get-JsPattern '^(\s*)[-*]\s+\[(.)\]\s?(.*)$'
$script:RxBulletLine = Get-JsPattern '^(\s*)[-*]\s+(.*)$'
$script:RxNoteLine = Get-JsPattern '^(\s*)>\s?(.*)$'
$script:RxFrontOpen = Get-JsPattern '^---\s*$'
$script:RxFrontClose = Get-JsPattern '^(---|\.\.\.)\s*$'
$script:RxFence = Get-JsPattern '^\s*(`{3,}|~{3,})'
$script:RxBreak = Get-JsPattern '^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$'
$script:RxIdTail = Get-JsPattern '^(.*?)\s+\^([0-9a-z]{8,32})\s*$'
$script:RxDueTail = Get-JsPattern '^(.*?)\s+(?i:due):(\d{4}-\d{2}-\d{2})(?:(?i:T)(\d{1,2}:\d{2}))?\s*$'

function ConvertTo-CleanTime([string]$t) {
  if ($t -cmatch '^([0-9]{1,2}):([0-9]{2})\z' -and [int]$matches[1] -lt 24 -and [int]$matches[2] -lt 60) { return ('{0}:{1}' -f [int]$matches[1], $matches[2]) }
  return ''
}

function ConvertFrom-TaskText([string]$text) {
  # trailing " ^id" and " due:YYYY-MM-DD[THH:MM]" in either order
  $id = ''; $due = ''; $time = ''
  for ($pass = 0; $pass -lt 2; $pass++) {
    if (-not $id -and $text -cmatch $script:RxIdTail) { $text = $matches[1]; $id = $matches[2]; continue }
    if (-not $due -and $text -cmatch $script:RxDueTail) {
      $text = $matches[1]; $due = $matches[2]; if ($matches[3]) { $time = ConvertTo-CleanTime $matches[3] }; continue
    }
    break
  }
  return @{ Text = $text.Trim($script:JsSpace); Due = $due; DueTime = $time; Id = $id }
}

# $markRaw: a status character the apps do not know ([?], [<] ...): the task counts as to do, and the
# character stays as written while it is (markdown.js taskItem)
function New-TaskItem([int]$level, [string]$mark, [string]$text, [string]$markRaw = '', [int]$indent = -1) {
  $p = ConvertFrom-TaskText $text
  return [pscustomobject]@{ Kind = 'task'; Level = $level; Mark = $mark; MarkRaw = $markRaw; Indent = $(if ($indent -ge 0) { $indent } else { 2 * $level })
                            Text = $p.Text; Due = $p.Due; DueTime = $p.DueTime; Notes = ''; Raw = ''; Id = $p.Id }
}
function New-RawItem([string]$raw) {
  return [pscustomobject]@{ Kind = 'raw'; Level = 0; Mark = ''; MarkRaw = ''; Indent = 0; Text = ''; Due = ''; DueTime = ''; Notes = ''; Raw = $raw; Id = '' }
}

# Lines that are never tasks or notes (markdown.js verbatimLines): YAML front matter, closed code fences,
# thematic breaks. Returns a hashtable of line indexes.
function Get-VerbatimLines($lines) {
  $out = @{}
  $i = 0
  if ($lines.Count -gt 0 -and $lines[0] -cmatch $script:RxFrontOpen) {
    for ($j = 1; $j -lt $lines.Count; $j++) {
      if ($lines[$j] -cmatch $script:RxFrontClose) { for ($k = 0; $k -le $j; $k++) { $out[$k] = $true }; $i = $j + 1; break }
    }
  }
  for (; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -cmatch $script:RxFence) {
      $fence = $matches[1]
      $close = Get-JsPattern ('^\s*' + [string]$fence[0] + '{' + $fence.Length + ',}\s*$')
      $end = -1
      for ($j = $i + 1; $j -lt $lines.Count; $j++) { if ($lines[$j] -cmatch $close) { $end = $j; break } }
      if ($end -gt 0) { for ($k = $i; $k -le $end; $k++) { $out[$k] = $true }; $i = $end; continue }
    }
    if ($lines[$i] -cmatch $script:RxBreak) { $out[$i] = $true }
  }
  return $out
}

function Read-Items([string]$text) {
  $list = New-Object System.Collections.ArrayList
  if ($null -eq $text) { return ,$list }
  if ($text.Length -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }   # a byte order mark
  $lines = $text -split "`r?`n"
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines = @($lines | Select-Object -First ($lines.Count - 1)) }
  $verbatim = Get-VerbatimLines $lines
  $last = $null
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $raw = $lines[$i]
    if ($verbatim.ContainsKey($i)) {
      $last = $null; [void]$list.Add((New-RawItem $raw))
    } elseif ($raw -cmatch $script:RxTaskLine) {
      $ind = $matches[1].Replace("`t", '  ').Length
      $m = $matches[2]; if ($m -ceq 'X') { $m = 'x' }
      if ($script:ValidMarks -ccontains $m) { $last = New-TaskItem ([int][math]::Floor($ind / 2)) $m $matches[3] '' $ind }
      else { $last = New-TaskItem ([int][math]::Floor($ind / 2)) ' ' $matches[3] $m $ind }
      [void]$list.Add($last)
    } elseif ($raw -cmatch $script:RxBulletLine) {
      $ind = $matches[1].Replace("`t", '  ').Length
      $last = New-TaskItem ([int][math]::Floor($ind / 2)) ' ' $matches[2] '' $ind; [void]$list.Add($last)
    } elseif ($last -and $raw -cmatch $script:RxNoteLine -and $matches[1].Replace("`t", '  ').Length -gt $last.Indent) {
      # a note is indented deeper than its task; a quote at the task's own depth is a paragraph
      $last.Notes = $(if ($last.Notes -eq '') { $matches[2] } else { $last.Notes + "`n" + $matches[2] })
    } else {
      $last = $null
      [void]$list.Add((New-RawItem $raw))
    }
  }
  return ,$list
}

function Format-TaskLine($it, [int]$level) {
  $mk = $(if ($it.Mark -ceq ' ' -and $it.MarkRaw) { $it.MarkRaw } else { $it.Mark })
  $line = ('  ' * $level) + '- [' + $mk + '] ' + $it.Text
  if ($it.Due) { $line += " due:$($it.Due)"; if ($it.DueTime) { $line += "T$($it.DueTime)" } }
  if ($it.Id) { $line += " ^$($it.Id)" }
  return $line
}

# The line ending a list file uses (its first line break): a file saved with CRLF stays CRLF when the apps
# write it, so editing a task does not rewrite every line (git diffs, editors). New files get LF.
function Get-TextEol([string]$text) {
  if ($null -eq $text) { return "`n" }
  $i = $text.IndexOf("`n")
  if ($i -gt 0 -and $text[$i - 1] -eq "`r") { return "`r`n" }
  return "`n"
}

function ConvertTo-MarkdownText($items, [int]$baseLevel = 0, [string]$eol = "`n") {
  $sb = New-Object System.Text.StringBuilder
  foreach ($it in $items) {
    if ($it.Kind -eq 'task') {
      if ($it.Text -eq '') { continue }
      $lv = [Math]::Max(0, $it.Level - $baseLevel)
      [void]$sb.Append((Format-TaskLine $it $lv) + $eol)
      if ($it.Notes) {
        $ind = '  ' * ($lv + 1)
        foreach ($nl in $it.Notes.Split("`n")) { [void]$sb.Append(("$ind> $nl").TrimEnd() + $eol) }
      }
    } else { [void]$sb.Append($it.Raw + $eol) }
  }
  return $sb.ToString()
}

function Get-SubtreeEnd($items, [int]$i) {
  $localTasks = $items[$i].Level; $j = $i + 1
  while ($j -lt $items.Count -and $items[$j].Kind -eq 'task' -and $items[$j].Level -gt $localTasks) { $j++ }
  return $j
}

# Gives every task an id; rematches id-less lines to ids that vanished from the same list (same text),
# so an editor that dropped the markers does not turn edits into delete + create. Returns $true if changed.
#   $known  = text -> id of tasks this list had before (ids not present now are reused)
#   $taken  = id -> $true for ids already used elsewhere (duplicates get a fresh id)
# text -> id, matched exactly (a PowerShell @{} ignores letter case; markdown.js uses a Map)
function New-TextMap { return ,(New-Object 'System.Collections.Generic.Dictionary[string,string]') }

function Set-MissingIds($items, $known, $taken) {
  $changed = $false
  $present = @{}
  foreach ($it in $items) { if ($it.Kind -eq 'task' -and $it.Id) { $present[$it.Id] = $true } }
  $seen = @{}
  foreach ($it in $items) {
    if ($it.Kind -ne 'task') { continue }
    if ($it.Id -and -not $seen.ContainsKey($it.Id) -and -not ($taken -and $taken.ContainsKey($it.Id))) { $seen[$it.Id] = $true; continue }
    $reuse = $null
    if (-not $it.Id -and $known -and $known.ContainsKey($it.Text)) {
      $cand = $known[$it.Text]
      if (-not $present.ContainsKey($cand) -and -not $seen.ContainsKey($cand) -and -not ($taken -and $taken.ContainsKey($cand))) { $reuse = $cand }
    }
    $it.Id = $(if ($reuse) { $reuse } else { New-SaqmeId })
    $seen[$it.Id] = $true
    $changed = $true
  }
  return $changed
}

# The widget's in-memory list ($mine) was loaded from $baseText, but the file now holds $theirsText (an
# editor or an AI assistant changed it meanwhile). Returns their version with my edits replayed by task id:
# my field edits win (they are newer), my new tasks are inserted next to their neighbours, my deletes apply;
# their structure and their other changes stay.
function Merge-ListText([string]$baseText, $mine, [string]$theirsText) {
  $base = @{}; foreach ($it in (Read-Items $baseText)) { if ($it.Kind -eq 'task' -and $it.Id) { $base[$it.Id] = $it } }
  $result = Read-Items $theirsText
  $mineIds = @{}
  $mineList = @($mine | Where-Object { $_.Kind -eq 'task' -and $_.Text -ne '' })
  foreach ($it in $mineList) { if ($it.Id) { $mineIds[$it.Id] = $true } }
  $fields = @(@('Text'), @('Mark'), @('Due', 'DueTime'), @('Notes'))
  for ($m = 0; $m -lt $mineList.Count; $m++) {
    $it = $mineList[$m]
    $i = Find-ItemIndex $result $it.Id
    $b = $base[$it.Id]
    if ($b -and $i -ge 0) {
      foreach ($group in $fields) {
        $changed = $false; foreach ($p in $group) { if ([string]$it.$p -cne [string]$b.$p) { $changed = $true } }
        if ($changed) { foreach ($p in $group) { $result[$i].$p = $it.$p } }
      }
      continue
    }
    if ($b -and $i -lt 0) {
      # they deleted it: it comes back only if I edited it (the newer action wins)
      $edited = $false; foreach ($group in $fields) { foreach ($p in $group) { if ([string]$it.$p -cne [string]$b.$p) { $edited = $true } } }
      if (-not $edited) { continue }
    }
    if ($i -ge 0) { continue }
    # new here (or edited after their delete): insert after the nearest earlier task they still have
    $copy = [pscustomobject]@{ Kind = 'task'; Level = $it.Level; Mark = $it.Mark; MarkRaw = $it.MarkRaw; Indent = $it.Indent; Text = $it.Text; Due = $it.Due; DueTime = $it.DueTime; Notes = $it.Notes; Raw = ''; Id = $it.Id }
    $at = -1
    for ($k = $m - 1; $k -ge 0; $k--) {
      $j = Find-ItemIndex $result $mineList[$k].Id
      if ($j -lt 0) { continue }
      $at = $(if ($it.Level -gt $mineList[$k].Level) { $j + 1 } else { Get-SubtreeEnd $result $j })
      $copy.Level = $it.Level - $mineList[$k].Level + $result[$j].Level
      break
    }
    if ($at -lt 0) {
      $at = $result.Count
      for ($k = $result.Count - 1; $k -ge 0; $k--) { if ($result[$k].Kind -eq 'task') { $at = $k + 1; break } }
      $copy.Level = 0
    }
    $result.Insert($at, $copy)
  }
  foreach ($id in @($base.Keys)) {
    if ($mineIds.ContainsKey($id)) { continue }
    $i = Find-ItemIndex $result $id
    if ($i -ge 0) { Remove-ItemKeepChildren $result $i }   # I deleted it
  }
  return (ConvertTo-MarkdownText $result 0 (Get-TextEol $theirsText))
}

# ---------------------------------------------------------------- moving tasks inside a list (the widget)
# A task moves with its subtasks as one block (drag and drop, Alt+Up / Alt+Down). These never drop an item: a
# move that cannot be done (a target that is not in this list, or inside the moved block) changes nothing and
# returns $false. The block is copied before the list changes: ArrayList.GetRange is only a view of the list,
# which the RemoveRange that follows invalidates. (Using that view lost the dragged tasks: every drag in 1.0.0
# saved the list without them, and sync sent them as deletes.)

# Moves $it (with its subtasks) to just before $target, taking its level; $atEnd or no target: after the last
# top-level task's subtree, at the top level.
function Move-ListBlock($items, $it, $target, [bool]$atEnd) {
  $i = $items.IndexOf($it)
  if ($i -lt 0 -or $it.Kind -ne 'task') { return $false }
  $end = Get-SubtreeEnd $items $i
  $toEnd = $atEnd -or $null -eq $target
  if (-not $toEnd) {
    if ($target -eq $it) { return $false }
    $ti = $items.IndexOf($target)
    if ($ti -lt 0 -or $target.Kind -ne 'task') { return $false }     # not in this list (any more)
    if ($ti -gt $i -and $ti -lt $end) { return $false }               # into its own subtree
  }
  $count = $items.Count
  $block = $items.GetRange($i, $end - $i).ToArray()
  $items.RemoveRange($i, $end - $i)
  if ($toEnd) {
    $pos = $items.Count
    for ($k = $items.Count - 1; $k -ge 0; $k--) { if ($items[$k].Kind -eq 'task' -and $items[$k].Level -eq 0) { $pos = Get-SubtreeEnd $items $k; break } }
    $newLevel = 0
  } else {
    $pos = $items.IndexOf($target); $newLevel = $target.Level
  }
  $delta = $newLevel - $it.Level
  foreach ($b in $block) { $b.Level += $delta }
  $items.InsertRange($pos, $block)
  if ($items.Count -ne $count) { throw "a move changed the number of items ($count -> $($items.Count))" }
  return $true
}

# Swaps $it (with its subtasks) with the previous ($dir < 0) or next sibling and its subtasks.
function Step-ListBlock($items, $it, [int]$dir) {
  $i = $items.IndexOf($it)
  if ($i -lt 0 -or $it.Kind -ne 'task') { return $false }
  $L = $it.Level; $end = Get-SubtreeEnd $items $i; $len = $end - $i
  if ($dir -lt 0) {
    $k = $i - 1
    while ($k -ge 0 -and $items[$k].Kind -eq 'task' -and $items[$k].Level -gt $L) { $k-- }
    if ($k -lt 0 -or $items[$k].Kind -ne 'task' -or $items[$k].Level -ne $L) { return $false }
    $at = $k
  } else {
    if ($end -ge $items.Count -or $items[$end].Kind -ne 'task' -or $items[$end].Level -ne $L) { return $false }
    $at = (Get-SubtreeEnd $items $end) - $len
  }
  $count = $items.Count
  $block = $items.GetRange($i, $len).ToArray()
  $items.RemoveRange($i, $len)
  $items.InsertRange($at, $block)
  if ($items.Count -ne $count) { throw "a move changed the number of items ($count -> $($items.Count))" }
  return $true
}

# The ids of the tasks a list holds (tasks without text are never written, so they do not count).
function Get-TaskIdSet($items) {
  $set = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($it in $items) { if ($it.Kind -eq 'task' -and $it.Text -ne '' -and $it.Id) { [void]$set.Add([string]$it.Id) } }
  return ,$set
}

# The widget's last line of defence before it writes a list: the ids that writing $newText would make disappear
# without anyone deleting them. A task may leave the file only by an explicit delete or a move to another list
# ($allowed), or because another program deleted it on disk since the widget loaded the list (in $baseText, not
# in $diskText). Anything else in the file or in memory ($items) must be in $newText. Empty = safe to write.
function Get-UnexplainedLoss($baseText, $diskText, $items, $newText, $allowed) {   # texts may be $null (no file)
  $base = Get-TaskIdSet (Read-Items $baseText)
  $disk = Get-TaskIdSet (Read-Items $diskText)
  $result = Get-TaskIdSet (Read-Items $newText)
  $lost = New-Object System.Collections.ArrayList
  $check = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($id in $disk) { [void]$check.Add($id) }
  foreach ($id in (Get-TaskIdSet $items)) { [void]$check.Add($id) }
  # what memory came from counts too, unless it was deleted on disk meanwhile
  foreach ($id in $base) { if ($null -eq $diskText -or $disk.Contains($id)) { [void]$check.Add($id) } }
  foreach ($id in $check) {
    if ($result.Contains($id)) { continue }
    if ($allowed -and $allowed.Contains($id)) { continue }
    if ($base.Contains($id) -and $null -ne $diskText -and -not $disk.Contains($id)) { continue }
    [void]$lost.Add($id)
  }
  return ,$lost
}

# the list (other than $except) holding most of these ids: where an open list went when renamed outside
function Find-ListWithIds([string]$listsDir, $ids, [string]$except) {
  $best = $null; $bestHits = 0
  foreach ($name in (Get-ProjectFileNames $listsDir)) {
    if ($name -eq $except) { continue }
    $hits = 0
    foreach ($it in (Read-Items (Read-TextFile (Join-Path $listsDir "$name.md")))) { if ($it.Kind -eq 'task' -and $it.Id -and $ids.ContainsKey($it.Id)) { $hits++ } }
    if ($hits -gt $bestHits) { $best = $name; $bestHits = $hits }
  }
  if ($bestHits -ge [Math]::Max(1, [Math]::Ceiling($ids.Count / 2))) { return $best }
  return $null
}

function Get-ProjectFileNames([string]$listsDir) {
  # same order as the tabs: lists\.order first, then the rest alphabetically
  # plain .NET calls on purpose: names end up in JSON, pipeline output would come back PSObject-wrapped
  $files = New-Object 'System.Collections.Generic.List[string]'
  try { foreach ($f in [IO.Directory]::GetFiles($listsDir, '*.md')) { $n = [IO.Path]::GetFileName($f); if (-not $n.StartsWith('.')) { $files.Add([IO.Path]::GetFileNameWithoutExtension($f)) } } } catch {}
  $result = New-Object 'System.Collections.Generic.List[string]'
  $t = Read-TextFile (Join-Path $listsDir '.order')
  if ($t) { foreach ($n in ($t -split "`r?`n")) { if ($n -and $files.Contains($n) -and -not $result.Contains($n)) { $result.Add($n) } } }
  $rest = New-Object 'System.Collections.Generic.List[string]'
  foreach ($n in $files) { if (-not $result.Contains($n)) { $rest.Add($n) } }
  $rest.Sort([StringComparer]::CurrentCultureIgnoreCase)
  $result.AddRange($rest)
  return $result.ToArray()
}

# A project (tab) name that is also a usable file name everywhere: no characters Windows forbids, no control
# characters, no trailing dots or spaces, at most 100 characters. '' = not a usable name. (markdown.js cleanProjectName)
function ConvertTo-ProjectName([string]$name) {
  $n = ($name -replace '[\\/:*?"<>|\x00-\x1f]', '').Trim($script:JsSpace).TrimEnd('.', ' ').Trim($script:JsSpace)
  if ($n.Length -gt 100) { $n = $n.Substring(0, 100).Trim($script:JsSpace).TrimEnd('.', ' ').Trim($script:JsSpace) }
  return $n
}

# Project name -> its list file name; reserved device names (con, nul, lpt1...) and empty names get "Project ".
function ConvertTo-FileName([string]$name) {
  $n = ConvertTo-ProjectName $name
  if (-not $n -or $n -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])\z') { $n = "Project $n".Trim() }
  return $n
}

# ================================================================ fractional order keys
function Get-IntLen([char]$head) {
  $c = [int]$head
  if ($c -ge 97 -and $c -le 122) { return $c - 97 + 2 }
  if ($c -ge 65 -and $c -le 90) { return 90 - $c + 2 }
  throw "invalid order key head: $head"
}

function Test-OrderKey($key) {
  if (-not ($key -is [string]) -or $key.Length -eq 0 -or $key.Length -gt 128) { return $false }
  if ($key -cnotmatch '^[0-9A-Za-z]+$' -or $key -ceq ('A' + ('0' * 26))) { return $false }
  try { $n = Get-IntLen $key[0] } catch { return $false }
  if ($n -gt $key.Length) { return $false }
  return -not $key.Substring($n).EndsWith('0')
}

function Get-Midpoint([string]$a, $b) {
  $digits = $script:KeyDigits
  if ($null -ne $b -and [string]::CompareOrdinal($a, $b) -ge 0) { throw "$a >= $b" }
  if ($a.EndsWith('0') -or ($b -and $b.EndsWith('0'))) { throw 'trailing zero' }
  if ($b) {
    $n = 0
    while ($n -lt $b.Length -and $(if ($n -lt $a.Length) { $a[$n] } else { [char]'0' }) -ceq $b[$n]) { $n++ }
    if ($n -gt 0) {
      $ra = $(if ($n -lt $a.Length) { $a.Substring($n) } else { '' })
      return $b.Substring(0, $n) + (Get-Midpoint $ra $b.Substring($n))
    }
  }
  $digitA = $(if ($a) { $digits.IndexOf($a[0]) } else { 0 })
  $digitB = $(if ($null -ne $b) { $digits.IndexOf($b[0]) } else { $digits.Length })
  if ($digitB - $digitA -gt 1) { return [string]$digits[[int][Math]::Round(0.5 * ($digitA + $digitB), [MidpointRounding]::AwayFromZero)] }
  if ($b -and $b.Length -gt 1) { return $b.Substring(0, 1) }
  $rest = $(if ($a.Length -gt 1) { $a.Substring(1) } else { '' })
  return [string]$digits[$digitA] + (Get-Midpoint $rest $null)
}

function Step-Integer([string]$x, [int]$dir) {
  $digits = $script:KeyDigits
  $head = $x[0]; $digs = $x.Substring(1).ToCharArray()
  $carry = $true
  for ($i = $digs.Length - 1; $carry -and $i -ge 0; $i--) {
    $d = $digits.IndexOf($digs[$i]) + $dir
    if ($d -eq $digits.Length) { $digs[$i] = '0' }
    elseif ($d -eq -1) { $digs[$i] = 'z' }
    else { $digs[$i] = $digits[$d]; $carry = $false }
  }
  if (-not $carry) { return [string]$head + (-join $digs) }
  $list = New-Object System.Collections.Generic.List[char]
  $list.AddRange([char[]]$digs)
  if ($dir -gt 0) {
    if ($head -ceq 'Z') { return 'a0' }
    if ($head -ceq 'z') { return $null }
    $h = [char]([int]$head + 1)
    if ([int]$h -gt 97) { $list.Add('0') } else { $list.RemoveAt($list.Count - 1) }
  } else {
    if ($head -ceq 'a') { return 'Zz' }
    if ($head -ceq 'A') { return $null }
    $h = [char]([int]$head - 1)
    if ([int]$h -lt 90) { $list.Add('z') } else { $list.RemoveAt($list.Count - 1) }
  }
  return [string]$h + (-join $list.ToArray())
}

function Get-IntPart([string]$key) { return $key.Substring(0, (Get-IntLen $key[0])) }

function Get-KeyBetween($a, $b) {
  if ($null -ne $a -and -not (Test-OrderKey $a)) { throw "invalid order key: $a" }
  if ($null -ne $b -and -not (Test-OrderKey $b)) { throw "invalid order key: $b" }
  if ($null -ne $a -and $null -ne $b -and [string]::CompareOrdinal($a, $b) -ge 0) { throw "$a >= $b" }
  if ($null -eq $a) {
    if ($null -eq $b) { return 'a0' }
    $ib = Get-IntPart $b; $fb = $b.Substring($ib.Length)
    if ($ib -ceq ('A' + ('0' * 26))) { return $ib + (Get-Midpoint '' $fb) }
    if ([string]::CompareOrdinal($ib, $b) -lt 0) { return $ib }
    $r = Step-Integer $ib -1
    if ($null -eq $r) { throw 'cannot decrement any more' }
    return $r
  }
  if ($null -eq $b) {
    $ia = Get-IntPart $a
    $i = Step-Integer $ia 1
    if ($null -eq $i) { return $ia + (Get-Midpoint $a.Substring($ia.Length) $null) }
    return $i
  }
  $ia = Get-IntPart $a; $fa = $a.Substring($ia.Length)
  $ib = Get-IntPart $b
  if ($ia -ceq $ib) { return $ia + (Get-Midpoint $fa $b.Substring($ib.Length)) }
  $i = Step-Integer $ia 1
  if ($null -eq $i) { throw 'cannot increment any more' }
  if ([string]::CompareOrdinal($i, $b) -lt 0) { return $i }
  return $ia + (Get-Midpoint $fa $null)
}

# Sorts by a string key with ordinal comparison (Sort-Object is culture-aware: it would put 'Zz' after 'a0').
function Sort-Ordinal($items, [scriptblock]$key) {
  $arr = @($items)
  if ($arr.Count -lt 2) { return ,$arr }
  $sorted = New-Object 'System.Collections.Generic.SortedDictionary[string,object]' ([StringComparer]::Ordinal)
  for ($i = 0; $i -lt $arr.Count; $i++) { $sorted.Add(([string](& $key $arr[$i])) + [char]0 + $i.ToString('D6'), $arr[$i]) }
  return ,@($sorted.Values)
}

# keys: list of current keys in the desired order ($null = none). Returns index -> new key for the
# entries that must change, keeping the longest strictly increasing run of valid keys untouched.
function Get-RekeyMap($keys) {
  $n = @($keys).Count
  $k = @($keys)
  $valid = New-Object bool[] $n
  for ($i = 0; $i -lt $n; $i++) { $valid[$i] = ($null -ne $k[$i]) -and (Test-OrderKey $k[$i]) }
  $len = New-Object int[] $n; $prev = New-Object int[] $n
  $best = -1
  for ($i = 0; $i -lt $n; $i++) {
    $prev[$i] = -1
    if (-not $valid[$i]) { continue }
    $len[$i] = 1
    for ($j = 0; $j -lt $i; $j++) {
      if ($valid[$j] -and [string]::CompareOrdinal($k[$j], $k[$i]) -lt 0 -and $len[$j] + 1 -gt $len[$i]) { $len[$i] = $len[$j] + 1; $prev[$i] = $j }
    }
    if ($best -lt 0 -or $len[$i] -gt $len[$best]) { $best = $i }
  }
  $keep = @{}
  for ($i = $best; $i -ge 0; $i = $prev[$i]) { $keep[$i] = $true }
  $out = @{}
  $i = 0
  while ($i -lt $n) {
    if ($keep.ContainsKey($i)) { $i++; continue }
    $j = $i
    while ($j -lt $n -and -not $keep.ContainsKey($j)) { $j++ }
    $lo = $(if ($i -gt 0) { $k[$i - 1] } else { $null })
    $hi = $(if ($j -lt $n) { $k[$j] } else { $null })
    for ($x = $i; $x -lt $j; $x++) { $lo = Get-KeyBetween $lo $hi; $out[$x] = $lo }
    $i = $j
  }
  # keys grow when lines keep being inserted at the same spot: past 48 characters, start the list over
  foreach ($x in @($out.Keys)) {
    if ($out[$x].Length -gt 48) {
      $out = @{}; $lo = $null
      for ($y = 0; $y -lt $n; $y++) { $lo = Get-KeyBetween $lo $null; $out[$y] = $lo }
      break
    }
  }
  return $out
}

# ================================================================ json + rows
function ConvertFrom-JsonText([string]$s) { return $script:Json.DeserializeObject($s) }

# Values that went through a PowerShell pipeline can carry invisible PSObject wrappers, which
# JavaScriptSerializer cannot handle; a tiny compiled helper unwraps everything first (compiled once per
# process, on first use, so the widget does not pay for it at startup).
function ConvertTo-JsonText($o) {
  if (-not ('Saqme.JsonOut' -as [type])) {
    Add-Type -ReferencedAssemblies @('System.Web.Extensions', [psobject].Assembly.Location) -TypeDefinition @'
using System; using System.Collections; using System.Collections.Generic; using System.Globalization;
using System.Management.Automation; using System.Web.Script.Serialization;
namespace Saqme {
  public static class JsonOut {
    public static object Plain(object o) {
      PSObject ps = o as PSObject;
      if (ps != null) o = ps.BaseObject;
      if (o == null) return null;
      if (o is string || o is bool || o is char) return o is char ? o.ToString() : o;
      if (o.GetType().IsPrimitive || o is decimal) return o;
      IDictionary d = o as IDictionary;
      if (d != null) {
        Dictionary<string, object> r = new Dictionary<string, object>();
        foreach (DictionaryEntry e in d) r[Convert.ToString(e.Key, CultureInfo.InvariantCulture)] = Plain(e.Value);
        return r;
      }
      IEnumerable en = o as IEnumerable;
      if (en != null) { List<object> l = new List<object>(); foreach (object x in en) l.Add(Plain(x)); return l; }
      return Convert.ToString(o, CultureInfo.InvariantCulture);
    }
    public static string Serialize(object o) {
      JavaScriptSerializer js = new JavaScriptSerializer();
      js.MaxJsonLength = int.MaxValue; js.RecursionLimit = 64;
      return js.Serialize(Plain(o));
    }
  }
}
'@
  }
  return [Saqme.JsonOut]::Serialize($o)
}

function Get-Field($row, [string]$name) {
  if ($null -eq $row) { return $null }
  $f = $row['fields']
  if ($null -eq $f -or -not $f.ContainsKey($name)) { return $null }
  return $f[$name]
}

# canonical string for value comparisons (case-sensitive)
function Get-ValueKey([string]$field, $v) {
  if ($null -eq $v) { return '<null>' }
  switch ($field) {
    'place' { return "$($v['project'])`t$($v['parent'])`t$($v['pos'])" }
    'due' { return "$($v['date'])`t$($v['time'])" }
    'deleted' { return [string][bool]$v }
    'resolved' { return [string][bool]$v }
    default { return [string]$v }
  }
}
function Test-SameValue([string]$field, $a, $b) { return (Get-ValueKey $field $a) -ceq (Get-ValueKey $field $b) }

function Copy-Value($v) {
  if ($v -is [System.Collections.IDictionary]) { $h = @{}; foreach ($k in @($v.Keys)) { $h[$k] = $v[$k] }; return $h }
  return $v
}
# An outbox entry as it is sent: acknowledging the answer removes fields from the outbox entry itself, so what
# the answer's refusals are read from (notices, a lost project) must be this copy. (engine.mjs syncCycle)
function Copy-OutboxEntry($e) {
  $out = @{}
  foreach ($k in @($e.Keys)) { if ($k -ne 'fields') { $out[$k] = $e[$k] } }
  $f = @{}
  foreach ($name in @($e['fields'].Keys)) { $f[$name] = Copy-Value $e['fields'][$name] }
  $out['fields'] = $f
  return $out
}
function Copy-Row($row) {
  if ($null -eq $row) { return $null }
  $out = @{}
  foreach ($k in @($row.Keys)) { if ($k -ne 'fields') { $out[$k] = $row[$k] } }
  $f = @{}
  foreach ($name in @($row['fields'].Keys)) { $x = $row['fields'][$name]; $f[$name] = @{ v = (Copy-Value $x['v']); ts = [long]$x['ts'] } }
  $out['fields'] = $f
  return $out
}
function New-EmptyRow([string]$kind, [string]$id) {
  $f = @{}
  switch ($kind) {
    'task' { foreach ($p in @(@('place', $null), @('text', ''), @('status', ' '), @('due', $null), @('notes', ''), @('deleted', $false))) { $f[$p[0]] = @{ v = $p[1]; ts = [long]0 } } }
    'project' { $f.name = @{ v = ''; ts = [long]0 }; $f.pos = @{ v = 'a0'; ts = [long]0 }; $f.deleted = @{ v = $false; ts = [long]0 } }
    'setting' { $f.value = @{ v = ''; ts = [long]0 } }
  }
  return @{ kind = $kind; id = $id; fields = $f }
}

function ConvertTo-CleanNotes([string]$s) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($l in ($s -replace "`r", '').Split("`n")) { $lines.Add($l.TrimEnd($script:JsSpace)) }
  while ($lines.Count -and $lines[0] -eq '') { $lines.RemoveAt(0) }
  while ($lines.Count -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  return ($lines -join "`n")
}
function ConvertTo-CleanText([string]$s, [int]$max = 10000) {
  $t = (($s -replace "[`r`n`t]+", ' ') -replace '[\x00-\x1f\x7f]', '').Trim($script:JsSpace)
  if ($t.Length -gt $max) { $t = $t.Substring(0, $max).Trim($script:JsSpace) }   # the server's limits: longer text stays local only
  return $t
}

function Test-ValidDate([string]$d) {   # YYYY-MM-DD that exists, years 1-9999 (markdown.js isValidDate)
  $r = [datetime]::MinValue
  return $d -cmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}\z' -and [datetime]::TryParseExact($d, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$r)
}

# ================================================================ pairing links
# A pairing link (https://<server>/#pair=<key>) or a bare key -> @{ Key; Server } or $null. Only https servers
# (plain http just on this computer, for testing), and no user name in the address: https://my.worker.dev@evil.example
# would send everything to evil.example. (worker/public/js/pairing.js parsePairingLink)
function Get-PairingLink([string]$text) {
  $v = $text.Trim($script:JsSpace)
  if ($v -cmatch '^([A-Za-z0-9_-]{32,})\z') { return @{ Key = $matches[1]; Server = '' } }
  if ($v -cnotmatch ('^(https?://[^/#?' + $script:JsSpaceClass + ']+)/?(?:\?[^#]*)?#pair=([A-Za-z0-9_-]{32,})\z')) { return $null }
  $origin = $matches[1]; $key = $matches[2]
  if ($origin.Contains('@')) { return $null }
  $u = $null
  if (-not [Uri]::TryCreate($origin, [UriKind]::Absolute, [ref]$u)) { return $null }
  if ($u.Scheme -ne 'https' -and @('localhost', '127.0.0.1', '[::1]') -notcontains $u.Host) { return $null }
  return @{ Key = $key; Server = $u.GetLeftPart([UriPartial]::Authority) }
}

# An address that may be a sync server -> its origin, or $null (the same rules as for pairing links)
function Get-ServerOrigin([string]$s) {
  if ($s.Contains('@')) { return $null }
  $u = $null
  if (-not [Uri]::TryCreate($s, [UriKind]::Absolute, [ref]$u)) { return $null }
  if ($u.UserInfo) { return $null }
  if ($u.Scheme -ne 'https' -and -not ($u.Scheme -eq 'http' -and @('localhost', '127.0.0.1', '[::1]') -contains $u.Host)) { return $null }
  return $u.GetLeftPart([UriPartial]::Authority)
}

# An invite to a shared list -> @{ Server; Code } or $null: https://<owner's server>/join#code=<code>, that server's
# app with #join=<code>, or saqme://join?server=<encoded origin>&code=<code> (what the join page hands this app).
# (worker/public/js/pairing.js parseInviteLink)
function Get-InviteLink([string]$text) {
  $v = $text.Trim($script:JsSpace)
  $server = $null; $code = $null
  if ($v -cmatch ('^saqme://join/?\?([^#' + $script:JsSpaceClass + ']*)\z')) {
    $q = @{}
    foreach ($part in $matches[1].Split('&')) {
      $i = $part.IndexOf('=')
      $k = $(if ($i -ge 0) { $part.Substring(0, $i) } else { $part }); $val = $(if ($i -ge 0) { $part.Substring($i + 1) } else { '' })
      $k = [Uri]::UnescapeDataString($k.Replace('+', ' '))
      if (-not $q.ContainsKey($k)) { $q[$k] = [Uri]::UnescapeDataString($val.Replace('+', ' ')) }   # the first one counts (URLSearchParams.get)
    }
    $s = [string]$q['server']; $code = [string]$q['code']
    if ($s -cnotmatch ('^https?://[^/#?' + $script:JsSpaceClass + ']+/?\z')) { return $null }
    $server = Get-ServerOrigin ($s -replace '/\z', '')
  } elseif ($v -cmatch ('^(https?://[^/#?' + $script:JsSpaceClass + ']+)(?:/join/?(?:\?[^#]*)?#code=|/?(?:\?[^#]*)?#join=)([^&' + $script:JsSpaceClass + ']+)\z')) {
    $origin = $matches[1]; $code = $matches[2]
    $server = Get-ServerOrigin $origin
  } else { return $null }
  if (-not $server -or $code -cnotmatch '^[A-Za-z0-9_-]{22,64}\z') { return $null }
  return @{ Server = $server; Code = $code }
}

# A sync server's short name, for a shared list whose name another list has ("Groceries (from nuca)"): the account
# part of a workers.dev address, else the host without www. or saqme. (pairing.js serverLabel; shared/fixtures/text.json)
function Get-ServerLabel([string]$server) {
  $v = ([string]$server).Trim($script:JsSpace)
  $u = $null
  if (-not [Uri]::TryCreate($v, [UriKind]::Absolute, [ref]$u) -or ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https')) { return $v }
  $h = $u.Host.ToLowerInvariant()
  if (-not $u.IsDefaultPort) { $h = "${h}:$($u.Port)" }
  if ($h -cmatch '^(?:[^.]+\.)?([^.]+)\.workers\.dev\z') { return $matches[1] }
  return ($h -creplace '^(www|saqme)\.', '')
}

# ================================================================ sync state
# Planned: "task:<id>" -> what the lists held before the last plans changed that task (Add-PlannedNotes);
# Missing: project id -> when its list was first seen missing;  Guard: @{ ids } of the deletes held back
# Notices: what a shared list's server did not take (a view-only list), shown with the conflicts;
# Shared: ids of the projects one's own server says are shared with others (their tabs get a badge)
function New-SyncState {
  return @{ version = 1; cursor = 0; dbId = ''; clockOffset = [long]0; lastTs = [long]0
            R = @{}; S = @{}; Outbox = (New-Object System.Collections.ArrayList); Files = @{}; Stamped = @{}
            Planned = @{}; Missing = @{}; Guard = $null; Notices = (New-Object System.Collections.ArrayList); Shared = @() }
}

function Read-SyncState([string]$path) {
  $st = New-SyncState
  $t = Read-TextFile $path
  if (-not $t) { return $st }
  $o = ConvertFrom-JsonText $t
  foreach ($k in 'cursor', 'dbId', 'clockOffset', 'lastTs') { if ($o.ContainsKey($k)) { $st[$k] = $o[$k] } }
  foreach ($m in 'R', 'S', 'Files', 'Stamped', 'Planned', 'Missing') {
    if ($o.ContainsKey($m) -and $o[$m]) { foreach ($k in @($o[$m].Keys)) { $st[$m][$k] = $o[$m][$k] } }
  }
  if ($o.ContainsKey('Outbox') -and $o['Outbox']) { foreach ($c in $o['Outbox']) { [void]$st.Outbox.Add($c) } }
  if ($o.ContainsKey('Guard') -and $o['Guard'] -and $o['Guard']['ids']) { $st.Guard = @{ ids = @($o['Guard']['ids']) } }
  if ($o.ContainsKey('Notices') -and $o['Notices']) { foreach ($n in $o['Notices']) { [void]$st.Notices.Add($n) } }
  if ($o.ContainsKey('Shared') -and $o['Shared']) { $st.Shared = @($o['Shared'] | ForEach-Object { [string]$_ }) }
  return $st
}

function Save-SyncState($st, [string]$path) {
  $dirPath = [IO.Path]::GetDirectoryName($path)
  if (-not (Test-Path -LiteralPath $dirPath)) { [void](New-Item -ItemType Directory -Path $dirPath -Force) }
  Write-TextFileAtomic $path (ConvertTo-JsonText $st)
}

function Get-SyncNow($st) {
  # server-corrected ms clock, strictly increasing
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + [long]$st.clockOffset
  if ($t -le [long]$st.lastTs) { $t = [long]$st.lastTs + 1 }
  $st.lastTs = $t
  return $t
}

# Adds a change to the outbox (coalescing per row + field, keeping the first base) and folds it into S.
# $Over = @{ base = @{ field = ts }; ts = @{ field = ts } } replaces the base / time of single fields (stale saves).
function Add-LocalChange($st, [string]$kind, [string]$id, $values, [long]$ts, [switch]$Create, $Over = $null) {
  $key = "${kind}:$id"
  $srow = $st.S[$key]
  if (-not $srow) { $srow = New-EmptyRow $kind $id; $st.S[$key] = $srow }
  $entry = $null
  foreach ($e in $st.Outbox) { if ($e['kind'] -eq $kind -and $e['id'] -ceq $id) { $entry = $e; break } }
  if (-not $entry) { $entry = @{ kind = $kind; id = $id; fields = @{} }; [void]$st.Outbox.Add($entry) }
  foreach ($name in @($values.Keys)) {
    $v = $values[$name]
    if (-not $entry['fields'].ContainsKey($name)) {
      $base = $(if ($Create) { -1 } elseif ($srow['fields'].ContainsKey($name)) { [long]$srow['fields'][$name]['ts'] } else { -1 })
      $entry['fields'][$name] = @{ base = $base }
    }
    if ($Over -and $Over.base.ContainsKey($name)) { $entry['fields'][$name]['base'] = [long]$Over.base[$name] }
    $t = $(if ($Over -and $Over.ts.ContainsKey($name)) { [long]$Over.ts[$name] } else { $ts })
    $entry['fields'][$name]['v'] = $v
    $entry['fields'][$name]['ts'] = $t
    $srow['fields'][$name] = @{ v = (Copy-Value $v); ts = $t }
  }
}

# ================================================================ local snapshot
# Reads every list. A file is usable ('ok') only if it could be read, was not written in the last moment,
# all its tasks have unique ids and it holds no NUL characters (what a power cut can leave in a file that
# was being written); otherwise it is left alone this cycle.
# $view: which lists this engine syncs (shared lists, docs/sync.md): @{ Only = name } (a shared list's engine),
# @{ Exclude = @{ name = $true } } (the lists shared with this PC, which the engine for one's own server leaves out).
# All: every list in the folder. (engine.mjs readLocalLists)
function Read-LocalLists([string]$listsDir, [int]$settleMs = 1500, $view = $null) {
  $res = @{ Ok = $true; Dir = $listsDir; Names = @(); All = @(); Files = @{} }
  if (-not (Test-Path -LiteralPath $listsDir)) { $res.Ok = $false; return $res }
  $res.All = @(Get-ProjectFileNames $listsDir)
  if ($view) {
    # plain loops, not a pipeline: names end up in JSON and as keys (Get-ProjectFileNames)
    $keep = New-Object 'System.Collections.Generic.List[string]'
    foreach ($n in $res.All) {
      if ($null -ne $view.Only) { if ($n -ceq [string]$view.Only) { $keep.Add($n) } }
      elseif (-not ($view.Exclude -and $view.Exclude.ContainsKey($n))) { $keep.Add($n) }
    }
    $res.Names = $keep.ToArray()
  } else { $res.Names = $res.All }
  $now = [DateTime]::UtcNow
  $allIds = @{}
  foreach ($name in $res.Names) {
    $path = Join-Path $listsDir "$name.md"
    $f = @{ Name = $name; Path = $path; Text = $null; Items = $null; Status = 'ok'; MTime = [long]0 }
    try { $lw = [IO.File]::GetLastWriteTimeUtc($path) } catch { $lw = $now }
    $f.MTime = [long]([DateTimeOffset]$lw).ToUnixTimeMilliseconds()
    $f.Text = Read-TextFile $path
    if ($null -eq $f.Text -or $f.Text.IndexOf([char]0) -ge 0) { $f.Status = 'error' }
    elseif (($now - $lw).TotalMilliseconds -ge 0 -and ($now - $lw).TotalMilliseconds -lt $settleMs) { $f.Status = 'busy' }
    else {
      $f.Items = Read-Items $f.Text
      foreach ($it in $f.Items) {
        if ($it.Kind -ne 'task' -or $it.Text -eq '') { continue }
        if (-not $it.Id -or $allIds.ContainsKey($it.Id)) { $f.Status = 'unstamped' } else { $allIds[$it.Id] = $name }
      }
    }
    $res.Files[$name] = $f
  }
  return $res
}

# ================================================================ diff: files -> outgoing changes
$script:PlannedKeep = 30 * 60000   # how long after a plan a save can still be from a copy older than it
$script:MissingGrace = 10000       # a list gone this long (and for two cycles) is written again; its delete is held back

# lists\.trash holds a copy of list $name with one of $ids in it (any copy, if the list had no tasks)
function Test-TrashedCopy([string]$listsDir, [string]$name, $ids) {
  if (-not $listsDir) { return $false }
  $trash = Join-Path $listsDir '.trash'
  if (-not (Test-Path -LiteralPath $trash)) { return $false }
  $re = '^' + [regex]::Escape($name) + '-[0-9]{8}-[0-9]{6}\.md$'
  foreach ($f in [IO.Directory]::GetFiles($trash)) {
    if ([IO.Path]::GetFileName($f) -notmatch $re) { continue }   # letter case ignored, as in engine.mjs
    if ($ids.Count -eq 0) { return $true }
    $t = Read-TextFile $f
    if ($t) { foreach ($it in (Read-Items $t)) { if ($it.Kind -eq 'task' -and $ids -ccontains $it.Id) { return $true } } }
  }
  return $false
}
function Get-LiveTaskIds($base, [string]$projId) {
  $out = New-Object System.Collections.ArrayList
  foreach ($key in @($base.Keys)) {
    $r = $base[$key]
    if ($r['kind'] -ne 'task' -or (Get-Field $r 'deleted')['v']) { continue }
    $pl = Get-PlaceOf $r
    if ($pl -and $pl['project'] -eq $projId) { [void]$out.Add([string]$r['id']) }
  }
  return ,$out
}

# A plan rewrote lists with what came from other devices; S then takes the server's rows. Before that, keep
# what the lists held, for each task field the plan changed and each task it brought into a list (added),
# so that a list saved later from an older copy (an editor or an AI that read it before the plan) is told
# apart from an edit (Get-StaleSave). Entries last $script:PlannedKeep; each field is used once. (engine.mjs notePlanned)
function Add-PlannedNotes($st, $waiting, [long]$clock) {
  foreach ($key in @($st.R.Keys)) {
    $r = $st.R[$key]
    if ($r['kind'] -ne 'task' -or $waiting.ContainsKey($key) -or -not (Test-RowPending $st $key)) { continue }
    $s = $st.S[$key]
    $p = $(if ($st.Planned.ContainsKey($key)) { $st.Planned[$key] } else { @{ at = $clock; added = $false; fields = @{} } })
    $p['at'] = $clock
    $shownR = -not (Get-Field $r 'deleted')['v']
    $shownS = ($null -ne $s) -and -not (Get-Field $s 'deleted')['v']
    $projS = $(if ($s -and (Get-PlaceOf $s)) { (Get-PlaceOf $s)['project'] } else { $null })
    $projR = $(if (Get-PlaceOf $r) { (Get-PlaceOf $r)['project'] } else { $null })
    if ($shownR -and (-not $shownS -or $projS -ne $projR) -and -not $p['added']) {
      $p['added'] = $true
      $min = [long]::MaxValue; foreach ($n in @($r['fields'].Keys)) { $t = [long]$r['fields'][$n]['ts']; if ($t -lt $min) { $min = $t } }
      $p['addedTs'] = [Math]::Max([long]0, $min - 1)
    }
    if ($s) {
      foreach ($n in @($r['fields'].Keys)) {
        if ($p['fields'].ContainsKey($n)) { continue }
        $sf = Get-Field $s $n
        $sv = $(if ($sf) { $sf['v'] } else { $null })
        if (Test-SameValue $n $r['fields'][$n]['v'] $sv) { continue }
        $p['fields'][$n] = @{ v = (Copy-Value $sv); ts = $(if ($sf) { [long]$sf['ts'] } else { [long]0 }) }
      }
    }
    if ($p['added'] -or $p['fields'].Count) { $st.Planned[$key] = $p }
  }
}

# back to how it was before the plan (a place: back under the parent / in the list it had, when the plan moved it)
function Test-Revert([string]$field, $pre, $value, $post) {
  if ($field -ne 'place') { return (Test-SameValue $field $pre $value) }
  $where = { param($v) if ($v) { "$($v['project'])`t$($v['parent'])" } else { "`t" } }
  return ((& $where $pre) -ceq (& $where $value) -and (& $where $pre) -cne (& $where $post))
}

# The base / time to send a task's changed fields with, when a recent plan changed them. A field back to its
# value from before the plan is sent as of then: the other device's newer value stays and this one is kept
# as a conflict. Any other change counts as made alongside the other device's (newest wins, the other one
# is kept as a conflict). Nothing is lost either way, where a plain edit would silently undo the other device.
function Get-StaleSave($st, [string]$tid, $vals, [long]$clock) {
  $over = @{ base = @{}; ts = @{} }
  $key = "task:$tid"
  if (-not $st.Planned.ContainsKey($key)) { return $over }
  $p = $st.Planned[$key]
  foreach ($fn in @($vals.Keys)) {
    if (-not $p['fields'].ContainsKey($fn)) { continue }
    $pre = $p['fields'][$fn]
    $over.base[$fn] = [long]$pre['ts']
    $sf = Get-Field $st.S[$key] $fn
    if (Test-Revert $fn $pre['v'] $vals[$fn] $(if ($sf) { $sf['v'] } else { $null })) { $over.ts[$fn] = [long]$pre['ts'] }
    [void]$p['fields'].Remove($fn)
  }
  if ($p['fields'].Count -eq 0 -and -not $p['added']) { [void]$st.Planned.Remove($key) }
  return $over
}

# deletes held back when a large share vanishes at once: 5+ tasks and over half of one list, or 25+ tasks
# and over half of all of them
function Test-Alarming($cands, $sizeOf, [int]$total) {
  $per = @{}; $n = 0
  foreach ($c in $cands) { $per[$c.list] = [int]$per[$c.list] + $c.weight; $n += $c.weight }
  foreach ($list in @($per.Keys)) { if ($per[$list] -ge 5 -and $per[$list] -gt $sizeOf[$list] / 2) { return $true } }
  return ($n -ge 25 -and $n -gt $total / 2)
}

# File names -> project ids (new lists, renamed ones, adopted ones), names and order; lists that are gone (into
# $projectDeletes). Part of Add-LocalDiff. (engine.mjs mapProjects)
function Add-ProjectMapping($st, $local, $out, [long]$now, [long]$Clock, $nameToId, $projectDeletes) {
  $base = $st.S; $srv = $st.R
  $mapped = @{}
  foreach ($pidK in @($st.Files.Keys)) { $mapped[$st.Files[$pidK]] = $pidK }
  $unmatched = New-Object System.Collections.ArrayList
  foreach ($name in $local.Names) {
    if ($mapped.ContainsKey($name)) {
      $mid = $mapped[$name]
      if (-not $base.ContainsKey("project:$mid")) {
        # the server did not know this project (it said "unknown project"): create it again, same id
        Add-LocalChange $st 'project' $mid @{ name = (ConvertTo-CleanText $name 120); pos = 'a0'; deleted = $false } $now -Create
        $out.Count++
      }
      $nameToId[$name] = $mid; continue
    }
    [void]$unmatched.Add($name)
  }
  $usedIds = @{}; foreach ($v in $nameToId.Values) { $usedIds[$v] = $true }
  $missing = New-Object System.Collections.ArrayList   # live base projects without a file
  foreach ($key in @($base.Keys)) {
    $r = $base[$key]
    if ($r['kind'] -ne 'project' -or $usedIds.ContainsKey($r['id']) -or (Get-Field $r 'deleted')['v']) { continue }
    [void]$missing.Add($r['id'])
  }
  $newNames = New-Object System.Collections.ArrayList
  foreach ($name in $unmatched) {
    $hit = $null
    # same name as a known project whose file mapping got lost (or a project restored by hand)
    foreach ($key in @($base.Keys)) {
      $r = $base[$key]
      if ($r['kind'] -eq 'project' -and -not $usedIds.ContainsKey($r['id']) -and [string](Get-Field $r 'name')['v'] -eq $name) { $hit = $r['id']; break }
    }
    # a project the server already has (first sync of this PC): adopt its id instead of duplicating it
    if (-not $hit) {
      foreach ($key in @($srv.Keys)) {
        $r = $srv[$key]
        if ($r['kind'] -eq 'project' -and -not $usedIds.ContainsKey($r['id']) -and -not (Get-Field $r 'deleted')['v'] -and [string](Get-Field $r 'name')['v'] -eq $name -and -not $base.ContainsKey($key)) {
          $hit = $r['id']; $base[$key] = Copy-Row $r; break
        }
      }
    }
    if ($hit) { $nameToId[$name] = $hit; $usedIds[$hit] = $true; [void]$missing.Remove($hit) } else { [void]$newNames.Add($name) }
  }
  # renamed files: a new file holding most of a vanished project's tasks (or the only new + only vanished one)
  foreach ($name in @($newNames)) {
    $f = $local.Files[$name]
    $best = $null; $bestHits = 0
    if ($f.Status -eq 'ok') {
      $ids = @{}; foreach ($it in $f.Items) { if ($it.Kind -eq 'task' -and $it.Id) { $ids[$it.Id] = $true } }
      foreach ($cand in $missing) {
        $hits = 0
        foreach ($tid in @($ids.Keys)) {
          $sr = $base["task:$tid"]
          if ($sr -and (Get-Field $sr 'place')['v']['project'] -eq $cand) { $hits++ }
        }
        if ($hits -gt $bestHits) { $best = $cand; $bestHits = $hits }
      }
      if ($bestHits -lt [Math]::Max(1, [Math]::Ceiling($ids.Count / 2))) { $best = $null }
    }
    if (-not $best -and $newNames.Count -eq 1 -and $missing.Count -eq 1 -and $f.Status -eq 'ok') { $best = $missing[0] }
    if ($best) { $nameToId[$name] = $best; $usedIds[$best] = $true; [void]$missing.Remove($best); [void]$newNames.Remove($name) }
  }
  foreach ($name in $newNames) {
    $id = New-SaqmeId
    $nameToId[$name] = $id
    Add-LocalChange $st 'project' $id @{ name = (ConvertTo-CleanText $name 120); pos = 'a0'; deleted = $false } $now -Create
    $out.Count++
  }
  # names, restores, order
  $orderKeys = New-Object System.Collections.ArrayList
  foreach ($name in $local.Names) {
    $id = $nameToId[$name]
    $sr = $base["project:$id"]
    $vals = @{}
    if ($st.Files[$id] -cne $name -and [string](Get-Field $sr 'name')['v'] -cne (ConvertTo-CleanText $name 120)) { $vals.name = ConvertTo-CleanText $name 120 }
    if ((Get-Field $sr 'deleted')['v']) { $vals.deleted = $false }
    if ($vals.Count) { Add-LocalChange $st 'project' $id $vals $now; $out.Count++ }
    $st.Files[$id] = $name
    [void]$orderKeys.Add([string](Get-Field $base["project:$id"] 'pos')['v'])
  }
  $rk = Get-RekeyMap $orderKeys
  foreach ($i in @($rk.Keys)) { Add-LocalChange $st 'project' $nameToId[$local.Names[$i]] @{ pos = $rk[$i] } $now; $out.Count++ }
  # projects whose list is gone. Moved to lists\.trash (how the apps delete a list): deleted below. Gone some
  # other way (moved out and back, a sync client re-downloading the folder, git checkout, another program, another
  # app's private copy of AppData): nothing is decided until it has been gone for two cycles and 10 seconds; then
  # the delete is held back (never sent without the user) and the list is written again (Restore-VanishedLists)
  foreach ($id in $missing) {
    $ids = Get-LiveTaskIds $base $id
    if ($st.Files.ContainsKey($id) -and (Test-TrashedCopy $local.Dir $st.Files[$id] $ids)) { [void]$projectDeletes.Add(@{ id = $id; ids = $ids; trashed = $true }); continue }
    if (-not $st.Missing.ContainsKey($id)) { $st.Missing[$id] = $Clock }
    if ($Clock - [long]$st.Missing[$id] -lt $script:MissingGrace) { $out.Skipped = $true; continue }
    [void]$projectDeletes.Add(@{ id = $id; ids = $ids; trashed = $false })
  }
  foreach ($id in @($st.Missing.Keys)) { if (-not $missing.Contains($id)) { [void]$st.Missing.Remove($id) } }
}

# Returns @{ Count; Deletes; Guarded; Skipped; Empty; Stamp = @(plans for files that need ids) }; mutates $st.
# $Clock: this computer's time in ms (tests move it on).
# $Scope = @{ Project; File }: the engine of a list shared with this PC, whose one file is that project. The list
# itself (its name, order, deletion) is its owner's: nothing about it is sent, only its tasks.
# $Expected: keys of tasks whose disappearance is expected, never held back. (engine.mjs addLocalDiff)
function Add-LocalDiff($st, $local, [string]$notifyAt, [switch]$AllowMassDelete, [long]$Clock = 0, $Scope = $null, $Expected = $null) {
  $out = @{ Count = 0; Deletes = 0; Guarded = 0; Stamp = (New-Object System.Collections.ArrayList); Skipped = $false; Empty = $false }
  if (-not $local.Ok -or $local.Names.Count -eq 0) { $out.Skipped = $true; $out.Empty = [bool]$local.Ok; return $out }
  if (-not $Clock) { $Clock = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $now = Get-SyncNow $st
  foreach ($k in @($st.Planned.Keys)) { if (-not ($Clock - [long]$st.Planned[$k]['at'] -lt $script:PlannedKeep)) { [void]$st.Planned.Remove($k) } }
  # an edit counts from when its list was saved, not from when this cycle noticed it ("newest wins" stays
  # fair); a list we only rewrote to add ids keeps the time of the edit before that
  $editTs = @{}
  foreach ($name in $local.Names) {
    $f = $local.Files[$name]
    $t = [long]$f.MTime + [long]$st.clockOffset
    $editTs[$name] = $(if ($t -gt 0 -and $t -lt $now) { $t } else { $now })
    $mark = $st.Stamped[$f.Path]
    if ($mark) {
      if ($f.Text -ceq [string]$mark['text']) { $editTs[$name] = [long]$mark['ts'] }
      elseif ($f.Status -eq 'ok') { [void]$st.Stamped.Remove($f.Path) }
    }
  }
  $base = $st.S; $srv = $st.R

  # ---- files that need ids first (no changes are sent for them this cycle)
  $taken = @{}
  foreach ($name in $local.Names) { $f = $local.Files[$name]; if ($f.Status -eq 'ok') { foreach ($it in $f.Items) { if ($it.Kind -eq 'task' -and $it.Id) { $taken[$it.Id] = $true } } } }
  foreach ($name in $local.Names) {
    $f = $local.Files[$name]
    if ($f.Status -ne 'unstamped') { continue }
    $items = Read-Items $f.Text
    $pid0 = $null; foreach ($k in @($st.Files.Keys)) { if ($st.Files[$k] -eq $name) { $pid0 = $k } }
    $known = New-TextMap
    foreach ($key in @($base.Keys)) {
      $r = $base[$key]
      if ($r['kind'] -ne 'task' -or -not $pid0) { continue }
      $pl = (Get-Field $r 'place')['v']
      if ($pl -and $pl['project'] -eq $pid0 -and -not $taken.ContainsKey($r['id'])) { $known[[string](Get-Field $r 'text')['v']] = $r['id'] }
    }
    [void](Set-MissingIds $items $known $taken)
    foreach ($it in $items) { if ($it.Kind -eq 'task' -and $it.Id) { $taken[$it.Id] = $true } }
    $stampedText = ConvertTo-MarkdownText $items 0 (Get-TextEol $f.Text)
    [void]$out.Stamp.Add(@{ type = 'write'; path = $f.Path; expected = $f.Text; text = $stampedText })
    $st.Stamped[$f.Path] = @{ text = $stampedText; ts = $editTs[$name] }
  }
  foreach ($name in $local.Names) { if ($local.Files[$name].Status -ne 'ok') { $out.Skipped = $true } }

  # ---- projects: file name -> project id
  $nameToId = @{}
  $projectDeletes = New-Object System.Collections.ArrayList
  if ($Scope) {
    foreach ($name in $local.Names) { $nameToId[$name] = $Scope.Project; $st.Files[$Scope.Project] = $name }
  } else { Add-ProjectMapping $st $local $out $now $Clock $nameToId $projectDeletes }

  # ---- tasks
  # how many live tasks each list had before this diff ("every task of a list gone" is weighed against these;
  # the lines it creates below come into S first)
  $hadOf = @{}
  foreach ($key in @($base.Keys)) {
    $r = $base[$key]
    if ($r['kind'] -ne 'task' -or (Get-Field $r 'deleted')['v']) { continue }
    $pl = Get-PlaceOf $r
    if ($pl) { $hadOf[[string]$pl['project']] = [int]$hadOf[[string]$pl['project']] + 1 }
  }
  $localTasks = @{}
  $order = New-Object System.Collections.ArrayList
  foreach ($name in $local.Names) {
    $f = $local.Files[$name]
    if ($f.Status -ne 'ok') { continue }
    $projId = $nameToId[$name]
    $groups = @{}; $groupOrder = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.ArrayList
    foreach ($it in $f.Items) {
      if ($it.Kind -ne 'task') { $stack.Clear(); continue }
      if ($it.Text -eq '') { continue }
      while ($stack.Count -gt 0 -and $stack[$stack.Count - 1].Level -ge $it.Level) { $stack.RemoveAt($stack.Count - 1) }
      $parent = $(if ($stack.Count -gt 0) { $stack[$stack.Count - 1].Id } else { $null })
      [void]$stack.Add($it)
      $due = $null
      if ($it.Due -and (Test-ValidDate $it.Due)) { $due = @{ date = $it.Due; time = (ConvertTo-CleanTime $it.DueTime) } }
      $notesClean = ConvertTo-CleanNotes $it.Notes
      if ($notesClean.Length -gt 50000) { $notesClean = ConvertTo-CleanNotes $notesClean.Substring(0, 50000) }
      $localTasks[$it.Id] = @{ project = $projId; parent = $parent; pos = $null; text = (ConvertTo-CleanText $it.Text); status = $it.Mark; due = $due; notes = $notesClean; ts = $editTs[$name] }
      [void]$order.Add($it.Id)
      $gk = "$projId|$parent"
      if (-not $groups.ContainsKey($gk)) { $groups[$gk] = New-Object System.Collections.ArrayList; [void]$groupOrder.Add($gk) }
      [void]$groups[$gk].Add($it.Id)
    }
    foreach ($gk in $groupOrder) {
      $ids = $groups[$gk]
      $keys = New-Object System.Collections.ArrayList
      foreach ($tid in $ids) {
        $sp = (Get-Field $base["task:$tid"] 'place')
        $k = $null
        if ($sp -and $sp['v'] -and -not (Get-Field $base["task:$tid"] 'deleted')['v'] -and $sp['v']['project'] -eq $localTasks[$tid].project -and "$($sp['v']['parent'])" -eq "$($localTasks[$tid].parent)") { $k = [string]$sp['v']['pos'] }
        [void]$keys.Add($k)
      }
      $rk = Get-RekeyMap $keys
      for ($i = 0; $i -lt $ids.Count; $i++) { $localTasks[$ids[$i]].pos = $(if ($rk.ContainsKey($i)) { $rk[$i] } else { $keys[$i] }) }
    }
  }
  foreach ($tid in $order) {
    $l = $localTasks[$tid]
    $place = @{ project = $l.project; parent = $l.parent; pos = $l.pos }
    $sr = $base["task:$tid"]
    if (-not $sr) {
      Add-LocalChange $st 'task' $tid @{ place = $place; text = $l.text; status = $l.status; due = $l.due; notes = $l.notes; deleted = $false } $l.ts -Create
      $out.Count++; continue
    }
    $vals = @{}
    if (-not (Test-SameValue 'place' (Get-Field $sr 'place')['v'] $place)) { $vals.place = $place }
    foreach ($fn in 'text', 'status', 'due', 'notes') { if (-not (Test-SameValue $fn (Get-Field $sr $fn)['v'] $l[$fn])) { $vals[$fn] = $l[$fn] } }
    if ((Get-Field $sr 'deleted')['v']) { $vals.deleted = $false }
    if ($vals.Count) { Add-LocalChange $st 'task' $tid $vals $l.ts -Over (Get-StaleSave $st $tid $vals $Clock); $out.Count++ }
  }
  # deletes: tasks gone from every list while their project's list is here, and projects whose list is gone.
  # Never decided while any list was unusable (it may just have moved there). Held back until the user decides
  # (Guard): a list whose file is gone (however small: only lists\.trash says a list was deleted), every task
  # of a list gone at once (the file emptied or written over by another program), and a large share vanishing
  # at once (Test-Alarming). Confirming deletes exactly what was held back, whatever vanished since is weighed
  # again; deletes made in the app ($Expected) are never held.
  if (-not $out.Skipped) {
    $liveProjects = @{}; foreach ($v in $nameToId.Values) { $liveProjects[$v] = $true }
    $tsOfProject = @{}; foreach ($name in $local.Names) { $tsOfProject[$nameToId[$name]] = $editTs[$name] }
    $sizeOf = @{}
    $cands = New-Object System.Collections.ArrayList
    $total = 0
    foreach ($key in @($base.Keys)) {
      $r = $base[$key]
      if ($r['kind'] -ne 'task' -or (Get-Field $r 'deleted')['v']) { continue }
      $pl = (Get-Field $r 'place')['v']
      if (-not $pl -or -not $liveProjects.ContainsKey($pl['project'])) { continue }
      $total++
      $sizeOf[$pl['project']] = [int]$sizeOf[$pl['project']] + 1
      if ($localTasks.ContainsKey($r['id'])) { continue }
      $tkey = "task:$($r['id'])"
      if ($st.Planned.ContainsKey($tkey) -and $st.Planned[$tkey]['added']) {
        # the last plan brought it into this list and a save from an older copy dropped it: not a delete
        # but a conflict (dated before the task arrived, so the server keeps it and the next plan puts it back)
        Add-LocalChange $st 'task' $r['id'] @{ deleted = $true } ([long]$st.Planned[$tkey]['addedTs'])
        [void]$st.Planned.Remove($tkey)
        $out.Count++
        continue
      }
      [void]$cands.Add(@{ key = $tkey; id = [string]$r['id']; list = $pl['project']; weight = 1; project = $false })
    }
    foreach ($pd in $projectDeletes) {
      if ($pd.trashed) { continue }
      $total += $pd.ids.Count
      $sizeOf[$pd.id] = $pd.ids.Count
      [void]$cands.Add(@{ key = "project:$($pd.id)"; id = $pd.id; list = $pd.id; weight = $pd.ids.Count; project = $true })
    }
    $confirmed = @{}
    if ($AllowMassDelete -and $st.Guard) { foreach ($k in @($st.Guard['ids'])) { $confirmed[$k] = $true } }
    if ($Expected) { foreach ($k in @($Expected.Keys)) { $confirmed[$k] = $true } }
    $fresh = @($cands | Where-Object { -not $confirmed.ContainsKey($_.key) })
    $goneOf = @{}; foreach ($c in $cands) { if (-not $c.project) { $goneOf[$c.list] = [int]$goneOf[$c.list] + 1 } }
    $hold = @($fresh | Where-Object { $_.project -or [int]$goneOf[$_.list] -ge [int]$hadOf[[string]$_.list] })
    if ($fresh.Count -and (Test-Alarming $fresh $sizeOf $total)) { $hold = $fresh }
    $send = @($cands)
    if ($hold.Count) {
      $held = @{}; foreach ($c in $hold) { $held[$c.key] = $true }
      $send = @($cands | Where-Object { -not $held.ContainsKey($_.key) })
      $w = 0; foreach ($c in $hold) { $w += $c.weight }
      $out.Guarded = $w
      $st.Guard = @{ ids = @($hold | ForEach-Object { $_.key }) }
    } else { $st.Guard = $null }
    foreach ($pd in $projectDeletes) { if ($pd.trashed) { $send += @{ id = $pd.id; project = $true } } }
    foreach ($c in $send) {
      if ($c.project) {
        Add-LocalChange $st 'project' $c.id @{ deleted = $true } $now
        [void]$st.Files.Remove($c.id); [void]$st.Missing.Remove($c.id)
      } else {
        Add-LocalChange $st 'task' $c.id @{ deleted = $true } $(if ($tsOfProject.ContainsKey($c.list)) { $tsOfProject[$c.list] } else { $now })
        $out.Deletes++
      }
      $out.Count++
    }
  }
  # ---- synced settings
  if ($notifyAt) {
    $sr = $base['setting:notifyAt']; $rr = $srv['setting:notifyAt']
    if (-not $sr -and $rr) {
      # first contact with a server that already has one: the server's value wins (applied by the next plan)
      $sr = Copy-Row $rr; $sr['fields']['value']['v'] = $notifyAt; $base['setting:notifyAt'] = $sr
    } elseif (-not $sr) {
      Add-LocalChange $st 'setting' 'notifyAt' @{ value = $notifyAt } $now -Create; $out.Count++
    } elseif ([string](Get-Field $sr 'value')['v'] -cne $notifyAt) {
      Add-LocalChange $st 'setting' 'notifyAt' @{ value = $notifyAt } $now; $out.Count++
    }
  }
  return $out
}

# ================================================================ remote -> files
function Get-PlaceOf($row) { $p = Get-Field $row 'place'; if ($p) { return $p['v'] } else { return $null } }

function Test-RowPending($st, [string]$key) {
  $r = $st.R[$key]; $s = $st.S[$key]
  if (-not $r) { return $false }
  if (-not $s) { return $true }
  foreach ($name in @($r['fields'].Keys)) {
    if (-not (Test-SameValue $name $r['fields'][$name]['v'] (Get-Field $s $name)['v'])) { return $true }
  }
  return $false
}

function New-ItemFromRow($row, [int]$level) {
  $due = (Get-Field $row 'due')['v']
  return [pscustomobject]@{
    Kind = 'task'; Level = $level; Mark = [string](Get-Field $row 'status')['v']
    Text = $(if ([string](Get-Field $row 'text')['v']) { [string](Get-Field $row 'text')['v'] } else { '(untitled)' })
    Due = $(if ($due) { [string]$due['date'] } else { '' }); DueTime = $(if ($due) { [string]$due['time'] } else { '' })
    Notes = [string](Get-Field $row 'notes')['v']; Raw = ''; Id = [string]$row['id']; MarkRaw = ''; Indent = 2 * $level
  }
}

# copies onto a line only the fields the server changed (R differs from the base), nothing else
function Set-ItemFromRemote($it, $row, $baseRow) {
  $n = New-ItemFromRow $row $it.Level
  $map = @{ text = @('Text'); status = @('Mark'); due = @('Due', 'DueTime'); notes = @('Notes') }
  foreach ($field in $map.Keys) {
    if ($baseRow -and (Test-SameValue $field (Get-Field $row $field)['v'] (Get-Field $baseRow $field)['v'])) { continue }
    foreach ($p in $map[$field]) { $it.$p = $n.$p }
  }
}

# ordinal comparison of (key, id) pairs, the sibling order everywhere
function Compare-Position([string]$k1, [string]$id1, [string]$k2, [string]$id2) {
  $c = [string]::CompareOrdinal($k1, $k2)
  if ($c -ne 0) { return $c }
  return [string]::CompareOrdinal($id1, $id2)
}

# id -> order key (server first, then base) for placing tasks among their siblings
function Get-PositionMap($st) {
  $m = @{}
  foreach ($src in @($st.S, $st.R)) {
    foreach ($key in @($src.Keys)) { $r = $src[$key]; if ($r['kind'] -eq 'task') { $pl = Get-PlaceOf $r; if ($pl) { $m[$r['id']] = [string]$pl['pos'] } } }
  }
  return $m
}

# Inserts $block (item + its subtree, levels relative to its first item) under $parentId by order key.
# $unsettled: ids that are still going to move; they sit at stale spots, so they are no anchors
function Add-BlockByPosition($items, $block, $parentId, [string]$pos, $posOf, [string]$selfId = '', $unsettled = $null) {
  $pi = -1; $plevel = -1
  if ($parentId) { for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i].Kind -eq 'task' -and $items[$i].Id -ceq $parentId) { $pi = $i; $plevel = $items[$i].Level; break } } }
  # direct children of the parent (or roots of the list)
  $sibs = New-Object System.Collections.ArrayList
  if ($pi -ge 0) {
    $end = Get-SubtreeEnd $items $pi
    $i = $pi + 1
    while ($i -lt $end) { [void]$sibs.Add($i); $i = Get-SubtreeEnd $items $i }
  } else {
    # top-level tasks: nothing shallower before them since the last non-task line
    $runMin = [int]::MaxValue
    for ($i = 0; $i -lt $items.Count; $i++) {
      $it = $items[$i]
      if ($it.Kind -ne 'task') { $runMin = [int]::MaxValue; continue }
      if ($it.Level -le $runMin) { [void]$sibs.Add($i); $runMin = $it.Level }
    }
  }
  $at = -1; $level = $(if ($pi -ge 0) { $plevel + 1 } else { 0 })
  # after the sibling with the largest smaller (key, id); else before the smallest larger one
  $after = $null; $afterKey = $null; $afterId = ''
  $before = $null; $beforeKey = $null; $beforeId = ''
  $settled = New-Object System.Collections.ArrayList
  foreach ($si in $sibs) { if (-not ($unsettled -and $unsettled.ContainsKey($items[$si].Id))) { [void]$settled.Add($si) } }
  foreach ($si in $settled) {
    $sid = $items[$si].Id
    $k = $posOf[$sid]
    if (-not $k) { continue }
    if ((Compare-Position $k $sid $pos $selfId) -lt 0) {
      if ($null -eq $afterKey -or (Compare-Position $k $sid $afterKey $afterId) -gt 0) { $after = $si; $afterKey = $k; $afterId = $sid }
    } elseif ($null -eq $beforeKey -or (Compare-Position $k $sid $beforeKey $beforeId) -lt 0) { $before = $si; $beforeKey = $k; $beforeId = $sid }
  }
  if ($null -ne $after) { $at = Get-SubtreeEnd $items $after; $level = $items[$after].Level }
  elseif ($null -ne $before) { $at = $before; $level = $items[$before].Level }
  elseif ($settled.Count -gt 0) { $last = $settled[$settled.Count - 1]; $at = Get-SubtreeEnd $items $last; $level = $items[$last].Level }
  elseif ($sibs.Count -gt 0) { $at = $sibs[0]; $level = $items[$sibs[0]].Level }
  elseif ($pi -ge 0) { $at = $pi + 1 }
  else {
    # like Add-Task: after the last task, before trailing blank lines
    $at = $items.Count
    for ($k = $items.Count - 1; $k -ge 0; $k--) { if ($items[$k].Kind -eq 'task') { $at = $k + 1; break } }
    if ($at -eq $items.Count) { while ($at -gt 0 -and $items[$at - 1].Kind -eq 'raw' -and $items[$at - 1].Raw -match '^\s*$') { $at-- } }
  }
  $delta = $level - $block[0].Level
  foreach ($b in $block) { $b.Level += $delta }
  $items.InsertRange($at, $block)
}

function Find-ItemIndex($items, [string]$id) {
  for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i].Kind -eq 'task' -and $items[$i].Id -ceq $id) { return $i } }
  return -1
}

function Remove-ItemKeepChildren($items, [int]$i) {
  # drops one task; its subtasks move up a level (to the nearest remaining ancestor)
  $end = Get-SubtreeEnd $items $i
  for ($k = $i + 1; $k -lt $end; $k++) { $items[$k].Level -= 1 }
  $items.RemoveAt($i)
}

function Get-RowDepthMap($st, [string]$projId) {
  $depth = @{}
  foreach ($key in @($st.R.Keys)) {
    $r = $st.R[$key]
    if ($r['kind'] -ne 'task') { continue }
    $d = 0; $p = (Get-PlaceOf $r)['parent']; $guard = 0
    while ($p -and $guard -lt 200) { $pr = $st.R["task:$p"]; if (-not $pr) { break }; $d++; $p = (Get-PlaceOf $pr)['parent']; $guard++ }
    $depth[$r['id']] = $d
  }
  return $depth
}

# New text for one list so it matches the server, given that the file currently equals S.
function Update-ListFromRemote($st, $items, [string]$projId, $depth) {
  $srv = $st.R; $base = $st.S
  $posOf = Get-PositionMap $st
  $remove = New-Object System.Collections.ArrayList
  $place = New-Object System.Collections.ArrayList     # rows to (re)place: moved here, moved within, arriving
  foreach ($it in @($items)) {
    if ($it.Kind -ne 'task' -or -not $it.Id) { continue }
    $key = "task:$($it.Id)"
    if (-not $base.ContainsKey($key) -or -not (Test-RowPending $st $key)) { continue }
    $r = $srv[$key]; $s = $base[$key]
    if ((Get-Field $r 'deleted')['v'] -or (Get-PlaceOf $r)['project'] -ne $projId) { [void]$remove.Add($it.Id); continue }
    Set-ItemFromRemote $it $r $s
    if (-not (Test-SameValue 'place' (Get-PlaceOf $r) (Get-PlaceOf $s))) { [void]$place.Add($r) }
  }
  foreach ($id in $remove) { $i = Find-ItemIndex $items $id; if ($i -ge 0) { Remove-ItemKeepChildren $items $i } }
  # tasks the server brought into this list (new, moved in, restored)
  $present = @{}; foreach ($it in $items) { if ($it.Kind -eq 'task' -and $it.Id) { $present[$it.Id] = $true } }
  foreach ($key in @($srv.Keys)) {
    $r = $srv[$key]
    if ($r['kind'] -ne 'task' -or (Get-Field $r 'deleted')['v'] -or $present.ContainsKey($r['id'])) { continue }
    $pl = Get-PlaceOf $r
    if (-not $pl -or $pl['project'] -ne $projId) { continue }
    $s = $base[$key]
    $arrives = (-not $s) -or (Get-Field $s 'deleted')['v'] -or ((Get-PlaceOf $s)['project'] -ne $projId)
    if ($arrives) { [void]$place.Add($r) }
  }
  # parents before children, so every task finds its (possibly just placed) parent; siblings by key,
  # anchored only on siblings that are already where they belong
  $unsettled = @{}; foreach ($r in $place) { $unsettled[[string]$r['id']] = $true }
  foreach ($r in (Sort-Ordinal $place { param($x) '{0:D4} {1} {2}' -f [int]$depth[$x['id']], (Get-PlaceOf $x)['pos'], $x['id'] })) {
    $id = [string]$r['id']
    $i = Find-ItemIndex $items $id
    if ($i -ge 0) {
      $end = Get-SubtreeEnd $items $i
      $block = $items.GetRange($i, $end - $i).ToArray()
      $items.RemoveRange($i, $end - $i)
    } else { $block = @(New-ItemFromRow $r 0) }
    $pl = Get-PlaceOf $r
    Add-BlockByPosition $items $block $pl['parent'] ([string]$pl['pos']) $posOf $id $unsettled
    $unsettled.Remove($id)
  }
  return ,$items
}

function New-ListFromRows($st, [string]$projId, $depth) {
  $items = New-Object System.Collections.ArrayList
  $rows = @($st.R.Values | Where-Object { $_['kind'] -eq 'task' -and -not (Get-Field $_ 'deleted')['v'] -and (Get-PlaceOf $_)['project'] -eq $projId })
  $posOf = Get-PositionMap $st
  foreach ($r in (Sort-Ordinal $rows { param($x) '{0:D4} {1} {2}' -f [int]$depth[$x['id']], (Get-PlaceOf $x)['pos'], $x['id'] })) {
    $pl = Get-PlaceOf $r
    Add-BlockByPosition $items @(New-ItemFromRow $r 0) $pl['parent'] ([string]$pl['pos']) $posOf ([string]$r['id'])
  }
  return ConvertTo-MarkdownText $items
}

# "Restore them" (Deletions paused): the deletes the guard holds back ($st.Guard) are undone in the files instead.
# Each held-back task goes back into its list as the last synced copy (S) has it (text, status, deadline, notes, id),
# under its parent and among its siblings by position, merged into what the file holds now (tasks added since stay);
# a list whose file is gone is written again, in its old place in the list order. -> @{ Plan; Count } (Plan $null
# while some list is not usable right now: try again), or $null when nothing is held back. The plan goes through
# ApplyPlan like any other. $Keys: only these of the held-back keys (a vanished list written again by itself,
# Invoke-SyncCycle). (engine.mjs restorePlan)
function Get-RestorePlan($st, $local, [string]$listsDir, $Keys = $null) {
  $ids = @(if ($null -ne $Keys) { $Keys } elseif ($st.Guard) { $st.Guard['ids'] })
  if (-not $ids.Count) { return $null }
  if (-not $local.Ok) { return @{ Plan = $null; Count = 0 } }
  # (a list with lines still waiting for their ids is fine: they stay as they are, the next cycle gives them ids)
  foreach ($name in $local.Names) { if (@('ok', 'unstamped') -notcontains $local.Files[$name].Status) { return @{ Plan = $null; Count = 0 } } }
  $base = $st.S
  $want = [ordered]@{}   # project id -> its rows to put back
  foreach ($key in $ids) {
    $i = $key.IndexOf(':'); $kind = $key.Substring(0, $i); $id = $key.Substring($i + 1)
    if ($kind -eq 'project') {
      if (-not $want.Contains($id)) { $want[$id] = New-Object System.Collections.ArrayList }
      foreach ($tid in (Get-LiveTaskIds $base $id)) { [void]$want[$id].Add($base["task:$tid"]) }
      continue
    }
    $r = $base[$key]
    if (-not $r -or (Get-Field $r 'deleted')['v']) { continue }
    $pl = Get-PlaceOf $r
    if (-not $pl) { continue }
    if (-not $want.Contains($pl['project'])) { $want[$pl['project']] = New-Object System.Collections.ArrayList }
    [void]$want[$pl['project']].Add($r)
  }
  # depth and order keys as of the last sync
  $posOf = @{}
  foreach ($key in @($base.Keys)) { $r = $base[$key]; if ($r['kind'] -eq 'task') { $pl = Get-PlaceOf $r; if ($pl) { $posOf[$r['id']] = [string]$pl['pos'] } } }
  $depth = @{}
  foreach ($rows in $want.Values) {
    foreach ($r in $rows) {
      $d = 0; $p = (Get-PlaceOf $r)['parent']; $guard = 0
      while ($p -and $guard -lt 200) { $pr = $base["task:$p"]; if (-not $pr) { break }; $d++; $p = (Get-PlaceOf $pr)['parent']; $guard++ }
      $depth[$r['id']] = $d
    }
  }
  $plan = @{ Ops = (New-Object System.Collections.ArrayList); Files = @{}; Setting = $null }
  $reserved = @{}; foreach ($n in $(if ($local.All) { $local.All } else { $local.Names })) { $reserved[$n] = $true }
  $creates = New-Object System.Collections.ArrayList; $writes = New-Object System.Collections.ArrayList
  $count = 0
  foreach ($projId in @($want.Keys)) {
    $file = $st.Files[$projId]
    $exists = $file -and $local.Files.ContainsKey($file)
    $items = $(if ($exists) { Read-Items $local.Files[$file].Text } else { New-Object System.Collections.ArrayList })
    $present = @{}; foreach ($it in $items) { if ($it.Kind -eq 'task' -and $it.Id) { $present[$it.Id] = $true } }
    $missing = @($want[$projId] | Where-Object { -not $present.ContainsKey($_['id']) })
    if ($exists -and -not $missing.Count) { continue }
    if (-not $exists) { $p = $base["project:$projId"]; if (-not $p -or (Get-Field $p 'deleted')['v']) { continue } }
    foreach ($r in (Sort-Ordinal $missing { param($x) '{0:D4} {1} {2}' -f [int]$depth[$x['id']], (Get-PlaceOf $x)['pos'], $x['id'] })) {
      $pl = Get-PlaceOf $r
      Add-BlockByPosition $items @(New-ItemFromRow $r 0) $pl['parent'] ([string]$pl['pos']) $posOf ([string]$r['id'])
    }
    $count += $missing.Count
    if ($exists) {
      $f = $local.Files[$file]
      [void]$writes.Add(@{ type = 'write'; path = $f.Path; expected = $f.Text; text = (ConvertTo-MarkdownText $items 0 (Get-TextEol $f.Text)) })
    } else {
      $n = Get-UniqueFileName $listsDir $(if ($file) { [string]$file } else { [string](Get-Field $base["project:$projId"] 'name')['v'] }) $reserved
      [void]$creates.Add(@{ type = 'create'; path = (Join-Path $listsDir "$n.md"); text = (ConvertTo-MarkdownText $items) })
      $plan.Files[$projId] = $n
    }
  }
  foreach ($o in $creates) { [void]$plan.Ops.Add($o) }
  foreach ($o in $writes) { [void]$plan.Ops.Add($o) }
  if ($creates.Count) {
    $new = @($creates | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.path) })
    [void]$plan.Ops.Add(@{ type = 'order'; path = (Join-Path $listsDir '.order'); names = (Get-OrderWith $listsDir $(if ($local.All) { $local.All } else { $local.Names }) $new) })
  }
  return @{ Plan = $plan; Count = $count }
}

# The list order once $new lists are written again: each where lists\.order still has it (its old place), else at
# the end; $now = the lists there now, in order (Get-ProjectFileNames). (engine.mjs orderWith)
function Get-OrderWith([string]$listsDir, $now, $new) {
  $names = New-Object 'System.Collections.Generic.List[string]'
  $known = New-Object 'System.Collections.Generic.HashSet[string]'   # (exact names, as Get-ProjectFileNames matches them)
  foreach ($n in @($now) + @($new)) { [void]$known.Add([string]$n) }
  $t = Read-TextFile (Join-Path $listsDir '.order')
  if ($t) { foreach ($n in ($t -split "`r?`n")) { if ($n -and $known.Contains($n) -and -not $names.Contains($n)) { $names.Add($n) } } }
  foreach ($n in @($now) + @($new)) { if (-not $names.Contains([string]$n)) { $names.Add([string]$n) } }
  return ,$names.ToArray()
}

# $self: the list being renamed, which may hold the name already (a case-only rename: "work" -> "Work" is
# the same file on Windows and macOS, and must not become "Work (2)")
# $from: for a list shared with this PC, its server's short name (Get-ServerLabel): a name another list has becomes
# "Groceries (from nuca)" before it gets a number. (engine.mjs uniqueFileName)
function Get-UniqueFileName([string]$listsDir, [string]$name, $reserved, [string]$self = '', [string]$from = '') {
  $taken = { param($x) ($reserved.ContainsKey($x)) -or ($x -ine $self -and (Test-Path -LiteralPath (Join-Path $listsDir "$x.md"))) }
  $base = ConvertTo-FileName $name
  if ($from -and (& $taken $base)) { $base = ConvertTo-FileName "$name (from $from)" }
  $n = $base; $i = 2
  while (& $taken $n) { $n = "$base ($i)"; $i++ }
  $reserved[$n] = $true
  return $n
}

# A view-only shared list (strict): task lines that are not live tasks of it on the server go. (engine.mjs dropUnknownTasks)
function Remove-UnknownTasks($items, $srv, [string]$projId) {
  foreach ($it in @($items)) {
    if ($it.Kind -ne 'task' -or -not $it.Id) { continue }
    $r = $srv["task:$($it.Id)"]
    if ($r -and -not (Get-Field $r 'deleted')['v'] -and (Get-PlaceOf $r)['project'] -eq $projId) { continue }
    $i = Find-ItemIndex $items $it.Id
    if ($i -ge 0) { Remove-ItemKeepChildren $items $i }
  }
}

# Builds the plan that makes the lists match R. $local must be a fresh read; returns $null when some list
# is not usable right now (then nothing is applied and the next cycle tries again).
# $Scope = @{ Project; File; ReadOnly; Label } (a shared list's engine): only that list; its file comes back if it is
# gone while the list is shared, and a view-only list's file is made to match the server exactly (task lines).
# Label: its server's short name, for a rename onto a name another list has.
function Get-RemotePlan($st, $local, [string]$listsDir, $Scope = $null) {
  $plan = @{ Ops = (New-Object System.Collections.ArrayList); Files = @{}; Setting = $null }
  if (-not $local.Ok) { return $null }
  foreach ($name in $local.Names) { if ($local.Files[$name].Status -ne 'ok') { return $null } }
  $srv = $st.R; $base = $st.S
  $fileOf = @{}; foreach ($k in @($st.Files.Keys)) { $fileOf[$k] = $st.Files[$k] }
  # (every list in the folder, also those of other engines: a new or renamed file never takes one of their names)
  $reserved = @{}; foreach ($n in $(if ($local.All) { $local.All } else { $local.Names })) { $reserved[$n] = $true }
  $creates = New-Object System.Collections.ArrayList; $writes = New-Object System.Collections.ArrayList; $after = New-Object System.Collections.ArrayList
  $depthCache = $null

  # ---- projects
  $orderChanged = $false
  foreach ($key in @($srv.Keys)) {
    $r = $srv[$key]
    if ($r['kind'] -ne 'project' -or ($Scope -and $r['id'] -cne $Scope.Project)) { continue }
    $recreate = $false
    if ($Scope -and -not (Get-Field $r 'deleted')['v']) {
      $want = $(if ($fileOf.ContainsKey($r['id'])) { $fileOf[$r['id']] } else { $Scope.File })
      $recreate = -not $local.Files.ContainsKey($want)
    }
    if (-not (Test-RowPending $st $key) -and -not $recreate) { continue }
    if (-not $Scope) { $orderChanged = $true }
    $s = $base[$key]; $id = $r['id']
    $live = -not (Get-Field $r 'deleted')['v']
    $wasLive = $s -and -not (Get-Field $s 'deleted')['v']
    $file = $fileOf[$id]
    $exists = $file -and $local.Files.ContainsKey($file)
    if ($live -and -not $exists) {
      if (-not $depthCache) { $depthCache = Get-RowDepthMap $st $id }
      $n = $(if ($Scope) { $(if ($file) { $file } else { $Scope.File }) } else { Get-UniqueFileName $listsDir ([string](Get-Field $r 'name')['v']) $reserved })
      [void]$creates.Add(@{ type = 'create'; path = (Join-Path $listsDir "$n.md"); text = (New-ListFromRows $st $id $depthCache) })
      $fileOf[$id] = $n; $plan.Files[$id] = $n
      if ($Scope) { $orderChanged = $true }
    } elseif (-not $live -and $exists -and $wasLive) {
      # only the list as it is now: anything typed into it meanwhile stops the plan instead of going to .trash
      [void]$after.Add(@{ type = 'trash'; path = (Join-Path $listsDir "$file.md"); name = $file; expected = $local.Files[$file].Text })
      $plan.Files[$id] = $null; $fileOf.Remove($id)
    } elseif ($live -and $exists -and $s -and [string](Get-Field $r 'name')['v'] -cne [string](Get-Field $s 'name')['v']) {
      $target = ConvertTo-FileName ([string](Get-Field $r 'name')['v'])
      if ($target -cne $file) {
        $reserved.Remove($file)
        $n = Get-UniqueFileName $listsDir $target $reserved $file $(if ($Scope -and $Scope.Label) { [string]$Scope.Label } else { '' })
        [void]$after.Add(@{ type = 'rename'; from = (Join-Path $listsDir "$file.md"); to = (Join-Path $listsDir "$n.md") })
        $fileOf[$id] = $n; $plan.Files[$id] = $n
        if ($Scope) { $orderChanged = $true }   # (the tab keeps its place under its new name)
      }
    }
  }

  # ---- tasks, list by list (only lists that exist now; created ones were generated whole above)
  $needs = @{}
  foreach ($key in @($srv.Keys)) {
    $r = $srv[$key]
    if ($r['kind'] -ne 'task' -or -not (Test-RowPending $st $key)) { continue }
    foreach ($row in @($r, $base[$key])) { if ($row) { $p = (Get-PlaceOf $row); if ($p) { $needs[$p['project']] = $true } } }
  }
  foreach ($name in $local.Names) {
    $projId = $null; foreach ($k in @($st.Files.Keys)) { if ($st.Files[$k] -eq $name) { $projId = $k } }
    $strict = $Scope -and $Scope.ReadOnly -and $projId -ceq $Scope.Project
    if (-not $projId -or (-not $needs.ContainsKey($projId) -and -not $strict)) { continue }
    if ($plan.Files.ContainsKey($projId) -and $null -eq $plan.Files[$projId]) { continue }   # being trashed
    if (-not $depthCache) { $depthCache = Get-RowDepthMap $st $projId }
    $f = $local.Files[$name]
    $items = Read-Items $f.Text
    if ($strict) { Remove-UnknownTasks $items $srv $projId }
    $items = Update-ListFromRemote $st $items $projId $depthCache
    $text = ConvertTo-MarkdownText $items 0 (Get-TextEol $f.Text)
    if ($text -cne $f.Text) {
      # lists that gain tasks are written before lists that lose them: an interrupted plan can then
      # only leave a duplicate behind, never lose a task
      $op = @{ type = 'write'; path = $f.Path; expected = $f.Text; text = $text }
      $had = @{}; foreach ($it in (Read-Items $f.Text)) { if ($it.Kind -eq 'task' -and $it.Id) { $had[$it.Id] = $true } }
      $gains = $false; foreach ($it in $items) { if ($it.Kind -eq 'task' -and $it.Id -and -not $had.ContainsKey($it.Id)) { $gains = $true; break } }
      if ($gains) { [void]$writes.Insert(0, $op) } else { [void]$writes.Add($op) }
    }
  }

  foreach ($o in $creates) { [void]$plan.Ops.Add($o) }
  foreach ($o in $writes) { [void]$plan.Ops.Add($o) }
  foreach ($o in $after) { [void]$plan.Ops.Add($o) }
  if ($orderChanged) {
    # list names after this plan; the server's order for projects it knows, local-only lists keep their slots
    $gone = @{}; $renamed = @{}
    foreach ($o in $after) {
      if ($o.type -eq 'trash') { $gone[$o.name] = $true }
      if ($o.type -eq 'rename') { $renamed[[IO.Path]::GetFileNameWithoutExtension($o.from)] = [IO.Path]::GetFileNameWithoutExtension($o.to) }
    }
    # every list keeps its slot, also those another engine syncs (only this engine's own are put in order)
    $names = New-Object System.Collections.ArrayList
    foreach ($n in $(if ($local.All) { $local.All } else { $local.Names })) { if ($gone.ContainsKey($n)) { continue }; [void]$names.Add($(if ($renamed.ContainsKey($n)) { $renamed[$n] } else { $n })) }
    foreach ($o in $creates) { $cn = [IO.Path]::GetFileNameWithoutExtension($o.path); if (-not $names.Contains($cn)) { [void]$names.Add($cn) } }
    $idOfName = @{}; foreach ($k in @($fileOf.Keys)) { $idOfName[$fileOf[$k]] = $k }
    $known = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $names.Count; $i++) {
      $pidK = $idOfName[$names[$i]]
      if ($pidK -and $srv.ContainsKey("project:$pidK")) { [void]$known.Add(@{ Slot = $i; Name = $names[$i]; Key = [string](Get-Field $srv["project:$pidK"] 'pos')['v']; Id = $pidK }) }
    }
    $sortedKnown = Sort-Ordinal $known { param($x) "$($x.Key) $($x.Id)" }   # space sorts below every key character
    for ($i = 0; $i -lt $known.Count; $i++) { $names[$known[$i].Slot] = $sortedKnown[$i].Name }
    [void]$plan.Ops.Add(@{ type = 'order'; path = (Join-Path $listsDir '.order'); names = @($names) })
  }
  if (-not $Scope -and (Test-RowPending $st 'setting:notifyAt')) { $plan.Setting = [string](Get-Field $srv['setting:notifyAt'] 'value')['v'] }
  return $plan
}

# Executes plan ops in order; verifies every precondition first so a plan is applied completely or not at
# all (barring I/O errors, after which it stops at the failing op). Returns the number of ops done.
function Invoke-PlanOps($ops, [string]$listsDir) {
  foreach ($o in $ops) {
    switch ($o.type) {
      'write' { if ((Read-TextFile $o.path) -cne $o.expected) { return -1 } }
      'create' { if (Test-Path -LiteralPath $o.path) { return -1 } }
      'rename' { if (-not (Test-Path -LiteralPath $o.from) -or ((Test-Path -LiteralPath $o.to) -and $o.from -ine $o.to)) { return -1 } }
      'trash' { if (-not (Test-Path -LiteralPath $o.path) -or ($null -ne $o.expected -and (Read-TextFile $o.path) -cne $o.expected)) { return -1 } }
    }
  }
  # stage every new file content first; if that fails nothing has changed yet
  $staged = @{}
  try {
    foreach ($o in $ops) { if ($o.type -eq 'write' -or $o.type -eq 'create') { $staged[$o.path] = Write-TempFile $o.path $o.text } }
  } catch {
    foreach ($t in $staged.Values) { try { [IO.File]::Delete($t) } catch {} }
    return 0
  }
  $done = 0
  foreach ($o in $ops) {
    try {
      switch ($o.type) {
        'write' { Complete-TempFile $staged[$o.path] $o.path; $staged.Remove($o.path) }
        'create' { Complete-TempFile $staged[$o.path] $o.path; $staged.Remove($o.path) }
        'rename' {
          if ([string]::Equals($o.from, $o.to, [StringComparison]::OrdinalIgnoreCase)) {
            # case-only rename on a case-insensitive file system: go through a temporary name
            $mid = $o.to + '.renaming'; [IO.File]::Move($o.from, $mid); [IO.File]::Move($mid, $o.to)
          } else { [IO.File]::Move($o.from, $o.to) }
        }
        'trash' {
          $trash = Join-Path $listsDir '.trash'
          if (-not (Test-Path -LiteralPath $trash)) { [void](New-Item -ItemType Directory -Path $trash) }
          Move-Item -LiteralPath $o.path -Destination (Join-Path $trash ('{0}-{1}.md' -f $o.name, (Get-Date -Format 'yyyyMMdd-HHmmss'))) -ErrorAction Stop
        }
        'order' { Write-TextFileAtomic $o.path ((@($o.names) -join "`n") + "`n") }
      }
      $done++
    } catch {
      foreach ($t in $staged.Values) { try { [IO.File]::Delete($t) } catch {} }
      return $done
    }
  }
  return $done
}

# ================================================================ http
function Invoke-SaqmeApi([string]$url, [string]$token, [string]$method, $body, [int]$timeoutMs = 25000) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $req = [Net.HttpWebRequest]::Create($url)
  $req.Method = $method
  $req.Timeout = $timeoutMs; $req.ReadWriteTimeout = $timeoutMs
  $req.Headers['Authorization'] = "Bearer $token"
  $req.Accept = 'application/json'
  $req.UserAgent = 'SaqmeToDo-Desktop/1.0'
  if ($null -ne $body) {
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-JsonText $body))
    $req.ContentType = 'application/json'
    $req.ContentLength = $bytes.Length
    $rs = $req.GetRequestStream(); try { $rs.Write($bytes, 0, $bytes.Length) } finally { $rs.Dispose() }
  }
  try { $resp = $req.GetResponse() }
  catch [Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { throw (New-Object Exception ("offline: " + $_.Exception.Message)) }
  }
  try {
    $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
    $text = $sr.ReadToEnd(); $sr.Dispose()
    $code = [int]$resp.StatusCode
  } finally { $resp.Dispose() }
  $data = $null
  try { $data = ConvertFrom-JsonText $text } catch {}
  return @{ Status = $code; Data = $data; Text = $text }
}

# ================================================================ one sync cycle
# Forget everything synced: the next cycle is a first sync (pull all, then merge the lists in again).
function Reset-SyncState($st) {
  $st.R = @{}; $st.S = @{}; $st.cursor = 0; $st.Outbox.Clear(); $st.Planned = @{}; $st.Missing = @{}; $st.Guard = $null
}

# ---------------------------------------------------------------- shared lists: what was not saved (engine.mjs)
function Get-ShortHash([string]$s) {   # FNV-1a, 32 bits (in longs: no overflow, no sign)
  [long]$h = 2166136261
  foreach ($ch in $s.ToCharArray()) { $h = $h -bxor [long][int]$ch; $h = ($h * 16777619) % 4294967296 }
  return ConvertTo-Base36 $h
}
function ConvertTo-Base36([long]$n) {
  $a = '0123456789abcdefghijklmnopqrstuvwxyz'; if ($n -eq 0) { return '0' }
  $s = ''; while ($n -gt 0) { $s = $a[[int]($n % 36)] + $s; $n = [long][Math]::Floor($n / 36) }
  return $s
}
# Keeps a change the server of a shared list will not take ($st.Notices), once per task, field and value.
function Add-SyncNotice($st, [string]$file, $entry, [string]$field, $value, [string]$reason) {
  $id = "$($entry['id'])-$field-$(Get-ShortHash (ConvertTo-JsonText @{ v = $value }))"
  foreach ($n in $st.Notices) { if ($n['id'] -ceq $id) { return } }
  $text = $null
  if ($entry['fields'].ContainsKey('text')) { $text = [string]$entry['fields']['text']['v'] }
  if ($null -eq $text) { foreach ($src in @($st.R, $st.S)) { $f = Get-Field $src["task:$($entry['id'])"] 'text'; if ($f) { $text = [string]$f['v']; break } } }
  [void]$st.Notices.Add(@{ id = $id; task = [string]$entry['id']; list = $file; field = $field; value = (Copy-Value $value); text = [string]$text; reason = $reason
                           at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() })
  while ($st.Notices.Count -gt 100) { $st.Notices.RemoveAt(0) }
}
# One refused outbox entry -> notices for what it would have changed (moves keep nothing worth showing).
function Add-NoticesFor($st, [string]$file, $e, [string]$reason) {
  if ($e['kind'] -ne 'task') { return }
  $f = $e['fields']
  if ($f.ContainsKey('place') -and [long]$f['place']['base'] -eq -1) { Add-SyncNotice $st $file $e 'new' $(if ($f.ContainsKey('text')) { $f['text']['v'] } else { '' }) $reason; return }
  if ($f.ContainsKey('deleted') -and $f['deleted']['v'] -eq $true) { Add-SyncNotice $st $file $e 'deleted' $true $reason; return }
  foreach ($name in 'text', 'status', 'due', 'notes') { if ($f.ContainsKey($name)) { Add-SyncNotice $st $file $e $name $f[$name]['v'] $reason } }
}
# A view-only shared list: nothing local is sent. What the list's file changed becomes notices (only what differs
# from the server's copy), the base forgets tasks the server never had, and the plan that follows puts the file
# back as the server has it. (engine.mjs holdReadOnly)
function Set-ReadOnlyHold($st, $Scope) {
  $reason = 'this shared list is view-only'
  foreach ($e in @($st.Outbox)) {
    if ($e['kind'] -ne 'task') { continue }
    $f = $e['fields']
    $r = $st.R["task:$($e['id'])"]
    $live = $r -and -not (Get-Field $r 'deleted')['v'] -and (Get-PlaceOf $r)['project'] -eq $Scope.Project
    $del = $f.ContainsKey('deleted') -and $f['deleted']['v'] -eq $true
    if (-not $live) { if (-not $del) { Add-SyncNotice $st $Scope.File $e 'new' $(if ($f.ContainsKey('text')) { $f['text']['v'] } else { '' }) $reason }; continue }
    if ($del) { Add-SyncNotice $st $Scope.File $e 'deleted' $true $reason; continue }
    foreach ($name in 'text', 'status', 'due', 'notes') {
      if ($f.ContainsKey($name) -and -not (Test-SameValue $name $f[$name]['v'] (Get-Field $r $name)['v'])) { Add-SyncNotice $st $Scope.File $e $name $f[$name]['v'] $reason }
    }
  }
  $st.Outbox.Clear()
  foreach ($key in @($st.S.Keys)) { if (-not $st.R.ContainsKey($key)) { [void]$st.S.Remove($key) } }
}
# Whether a row from the server may land in R: a shared list's server can only send rows of that list.
function Test-AcceptRow($st, $row, $Scope) {
  if (-not ($row['id'] -is [string])) { return $false }
  if (-not $Scope) { return -not $row['gone'] }
  if ($row['gone']) { return $row['kind'] -eq 'task' }
  if (-not ($row['fields'] -is [System.Collections.IDictionary])) { return $false }
  switch ($row['kind']) {
    'project' { return $row['id'] -ceq $Scope.Project }
    'task' { $pl = Get-PlaceOf $row; return [bool]($pl -and $pl['project'] -ceq $Scope.Project) }
    'conflict' { $t = $st.R["task:$($row['task'])"]; $pl = Get-PlaceOf $t; return [bool]($pl -and $pl['project'] -ceq $Scope.Project) }
  }
  return $false
}
# A list's text with every task given a new id: a shared list that became one's own (engine.mjs withNewIds).
function Get-TextWithNewIds([string]$text) {
  $items = Read-Items $text
  foreach ($it in $items) { if ($it.Kind -eq 'task' -and $it.Id) { $it.Id = New-SaqmeId } }
  return (ConvertTo-MarkdownText $items 0 (Get-TextEol $text))
}

# A list whose file is gone (an app deletes a list through lists\.trash; this is something else: another program, a
# sync client, a virtualized copy of AppData) is held back by Add-LocalDiff, then written again here from the last
# synced copy (Get-RestorePlan), in its old place, without waiting for the user; its delete is never sent. What was
# written goes into $res.Rewritten (@{ Name; Count }) for the app to say so. (engine.mjs restoreVanished)
function Restore-VanishedLists($st, $local, $ctx, $res) {
  if (-not $st.Guard) { return }
  $keys = @(@($st.Guard['ids']) | Where-Object { ([string]$_).StartsWith('project:', [StringComparison]::Ordinal) })
  if (-not $keys.Count) { return }
  $wp = Get-RestorePlan $st $local $ctx.ListsDir $keys
  if (-not $wp -or -not $wp.Plan -or -not $wp.Plan.Ops.Count) { return }
  if (-not (& $ctx.ApplyPlan $wp.Plan)) { $res.Retry = $true; return }
  $written = New-Object System.Collections.ArrayList
  $done = @{}
  foreach ($k in @($wp.Plan.Files.Keys)) {
    $n = [string]$wp.Plan.Files[$k]
    $st.Files[$k] = $n; [void]$st.Missing.Remove($k); $done["project:$k"] = $true
    $c = (Get-LiveTaskIds $st.S $k).Count
    [void]$written.Add(@{ Name = $n; Count = $c })
    $res.Guarded = [Math]::Max(0, [int]$res.Guarded - $c)
  }
  $keep = @(@($st.Guard['ids']) | Where-Object { -not $done.ContainsKey([string]$_) })
  $st.Guard = $(if ($keep.Count) { @{ ids = $keep } } else { $null })
  $res.Rewritten = $written.ToArray()
  $res.Retry = $true
}

# $ctx = @{ State; StatePath; ListsDir; Url; Token; DeviceId; NotifyAt; AllowMassDelete;
#           ApplyPlan = { param($plan) -> $true when the whole plan was applied };  Log = { param($msg) }
#           Clock = { -> ms } (tests); Transport = { param($body) -> @{ Status; Data } } (tests; else HTTP to Url)
#           View (Read-LocalLists); Scope = @{ Project; File; ReadOnly } (a shared list's engine); Expected
#           Restore = $true: put the held-back deletes back into the files (Get-RestorePlan) instead of syncing }
# Returns @{ Status = 'synced'|'offline'|'error'|'auth'; Message; Conflicts; Guarded; Retry; Access;
#            Api, WorkerVersion (the own Worker's, once it answered: worker/src/version.js);
#            Restored (tasks put back); RestorePending (a restore is still to do: a list was busy);
#            Rewritten (lists whose file was gone, written again: Restore-VanishedLists) }
function Invoke-SyncCycle($ctx) {
  $st = $ctx.State
  $clock = $(if ($ctx.Clock) { [long](& $ctx.Clock) } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() })
  $res = @{ Status = 'synced'; Message = ''; Guarded = 0; Retry = $false; Sent = 0; Received = 0; Refused = @(); Access = $null }
  $settle = $(if ($null -ne $ctx.SettleMs) { [int]$ctx.SettleMs } else { 1500 })
  $scope = $ctx.Scope
  $local = Read-LocalLists $ctx.ListsDir $settle $ctx.View
  if ($scope) { $st.Files[$scope.Project] = $scope.File }
  $firstSync = ($st.S.Count -eq 0)   # nothing reconciled yet: pull everything first (resumes after interruptions)
  if ($ctx.Restore -and -not $firstSync) {
    # "Restore them": the held-back tasks go back into the files, the guard is cleared, and the next cycle finds
    # nothing gone. A list being edited right now refuses the plan: the guard stays and the request is kept
    $rp = Get-RestorePlan $st $local $ctx.ListsDir
    if ($rp -and $rp.Plan -and ($rp.Plan.Ops.Count -eq 0 -or (& $ctx.ApplyPlan $rp.Plan))) {
      foreach ($k in @($rp.Plan.Files.Keys)) { $st.Files[$k] = $rp.Plan.Files[$k] }
      $st.Guard = $null
      Save-SyncState $st $ctx.StatePath
      $res.Restored = $rp.Count; $res.Retry = $true
      return $res
    }
    if ($rp) { $res.RestorePending = $true }
  }
  $diff = $null
  if (-not $firstSync) {
    $diff = Add-LocalDiff $st $local $ctx.NotifyAt -AllowMassDelete:$ctx.AllowMassDelete -Clock $clock -Scope $scope -Expected $ctx.Expected
    if ($scope -and $scope.ReadOnly) { Set-ReadOnlyHold $st $scope }
    $res.Guarded = $diff.Guarded
    if ($diff.Stamp.Count) {
      $p = @{ Ops = $diff.Stamp; Files = @{}; Setting = $null; Stamp = $true }
      [void](& $ctx.ApplyPlan $p)
      $res.Retry = $true
    }
    if ($diff.Skipped) { $res.Retry = $true }
    else { Restore-VanishedLists $st $local $ctx $res }
    Save-SyncState $st $ctx.StatePath
  }
  # send the outbox (in chunks) and pull everything new
  $endpoint = $ctx.Url.TrimEnd('/') + '/api/sync'
  for ($round = 0; $round -lt 40; $round++) {
    # (server limit per request; copies: the acknowledgement below edits the outbox entries, not what was sent)
    $batch = @($st.Outbox | Select-Object -First 100 | ForEach-Object { Copy-OutboxEntry $_ })
    $sentAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    try {
      $body = @{ deviceId = $ctx.DeviceId; cursor = [long]$st.cursor; changes = $batch }
      $r = $(if ($ctx.Transport) { & $ctx.Transport $body } else { Invoke-SaqmeApi $endpoint $ctx.Token 'POST' $body })
    } catch {
      $res.Status = 'offline'; $res.Message = $_.Exception.Message -replace '^offline: ', ''
      return $res
    }
    if ($r.Status -eq 401) {
      $res.Status = 'auth'
      $res.Message = $(if ($scope) { 'The owner stopped sharing this list.' } else { 'The server rejected the sync token. Pair this PC again.' })
      return $res
    }
    if ($r.Status -ne 200 -or -not $r.Data) { $res.Status = 'error'; $res.Message = "Server error $($r.Status)"; return $res }
    $d = $r.Data
    if (-not $scope) {
      # what the own Worker runs (one before 1.1.0 does not say: API 1); a shared list's server is someone else's
      $res.Api = $(if ($d['api'] -is [int] -or $d['api'] -is [long]) { [long]$d['api'] } else { [long]1 })
      $res.WorkerVersion = [string]$d['version']
    }
    if ($scope -and $d['share'] -and @('edit', 'view') -contains [string]$d['share']['access']) { $res.Access = [string]$d['share']['access'] }
    if (-not $scope -and $null -ne $d['shared']) { $st.Shared = @(@($d['shared']) | ForEach-Object { [string]$_ }) }   # this PC's lists others have
    $recvAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $st.clockOffset = [long]([long]$d['serverTime'] - ($sentAt + $recvAt) / 2)
    if ($d['restored'] -or [long]$d['cursor'] -lt [long]$st.cursor) {
      # the server went back in time (restored from a backup): start over like a first sync. The lists keep
      # their content and are merged in again; resending the old base would undo what the restore brought back
      Reset-SyncState $st
      Save-SyncState $st $ctx.StatePath
      $res.Retry = $true
      return $res
    }
    if ($st.dbId -and $d['dbId'] -and $d['dbId'] -ne $st.dbId) {
      # the server database was recreated (or this PC moved to another server): push everything again
      $st.Outbox.Clear(); $st.R = @{}; $st.cursor = 0
      foreach ($key in @($st.S.Keys)) {
        $row = $st.S[$key]
        if ($row['kind'] -eq 'conflict') { continue }
        $fields = @{}; foreach ($n in @($row['fields'].Keys)) { $fields[$n] = @{ v = $row['fields'][$n]['v']; ts = [long]$row['fields'][$n]['ts']; base = -1 } }
        $e = @{ kind = $row['kind']; id = $row['id']; fields = $fields }
        if ($row['kind'] -eq 'project') { $st.Outbox.Insert(0, $e) } else { [void]$st.Outbox.Add($e) }
      }
      $st.dbId = $d['dbId']
      continue
    }
    $st.dbId = $d['dbId']
    # acknowledge what was sent (unless it changed again since)
    foreach ($sent in $batch) {
      $cur = $null; foreach ($e in $st.Outbox) { if ($e['kind'] -eq $sent['kind'] -and $e['id'] -ceq $sent['id']) { $cur = $e; break } }
      if (-not $cur) { continue }
      foreach ($n in @($sent['fields'].Keys)) {
        if ($cur['fields'].ContainsKey($n) -and [long]$cur['fields'][$n]['ts'] -eq [long]$sent['fields'][$n]['ts']) { [void]$cur['fields'].Remove($n) }
      }
      if ($cur['fields'].Count -eq 0) { $st.Outbox.Remove($cur) }
    }
    foreach ($row in @($d['changes'])) {
      if (-not $row -or -not (Test-AcceptRow $st $row $scope)) { continue }
      $key = "$($row['kind']):$($row['id'])"
      if ($row['gone']) {
        # the owner moved it into a list this PC does not share: it leaves this one like a delete
        $s0 = $(if ($st.S.ContainsKey($key)) { $st.S[$key] } else { $st.R[$key] })
        if ($s0) { $g = Copy-Row $s0; $g['fields']['deleted'] = @{ v = $true; ts = [long](Get-Field $s0 'deleted')['ts'] + 1 }; $st.R[$key] = $g }
      } else { $st.R[$key] = $row }
      $res.Received++
    }
    foreach ($rej in @($d['rejected'])) {
      if (-not $rej) { continue }
      if ($scope -and $rej['reason'] -ne 'unknown task') {
        # a shared list's server refused it (view-only by now, or the owner deleted the list): kept as a notice
        foreach ($e in @($batch)) {
          if ($e['kind'] -ne $rej['kind'] -or $e['id'] -cne $rej['id']) { continue }
          $one = $e
          if ($rej['field']) { $fs = @{}; if ($e['fields'].ContainsKey($rej['field'])) { $fs[$rej['field']] = $e['fields'][$rej['field']] }; $one = @{ kind = $e['kind']; id = $e['id']; fields = $fs } }
          Add-NoticesFor $st $scope.File $one ([string]$rej['reason'])
        }
        $res.Refused += ("{0} {1}: {2}" -f $rej['kind'], $rej['id'], $rej['reason'])
        continue
      }
      if ($rej['reason'] -eq 'unknown task' -or $rej['reason'] -eq 'unknown project') {
        # the server lost it: forget the base so the next diff sends it again as a fresh create (a project
        # keeps its id through the file mapping)
        [void]$st.S.Remove("$($rej['kind']):$($rej['id'])")
        if ($rej['kind'] -eq 'task' -and $rej['reason'] -eq 'unknown project') {
          foreach ($e in @($batch)) {
            if ($e['kind'] -eq 'task' -and $e['id'] -ceq $rej['id'] -and $e['fields'].ContainsKey('place')) {
              $pr = $e['fields']['place']['v']['project']
              if ($pr -and -not $st.R.ContainsKey("project:$pr")) { [void]$st.S.Remove("project:$pr") }
            }
          }
        }
        $res.Retry = $true
      } else {
        $res.Refused += ("{0} {1}: {2}" -f $rej['kind'], $rej['id'], $rej['reason'])
      }
    }
    $res.Sent += $batch.Count
    $st.cursor = [long]$d['cursor']
    Save-SyncState $st $ctx.StatePath
    if (-not $d['more'] -and $st.Outbox.Count -eq 0) { break }
  }
  if ($firstSync -and -not ($local.Ok -and $local.Names.Count -eq 0)) {
    # first contact: pulled the server's lists first, now merge ours in (adopting its projects by name)
    $diff = Add-LocalDiff $st $local $ctx.NotifyAt -AllowMassDelete:$ctx.AllowMassDelete -Clock $clock -Scope $scope -Expected $ctx.Expected
    if ($scope -and $scope.ReadOnly) { Set-ReadOnlyHold $st $scope }
    if ($diff.Stamp.Count) { [void](& $ctx.ApplyPlan @{ Ops = $diff.Stamp; Files = @{}; Setting = $null; Stamp = $true }) }
    Save-SyncState $st $ctx.StatePath
    $res.Retry = $true
    return $res
  }
  # (an empty folder on first contact gets the server's lists right away, below)

  # remote -> files: never in a cycle that left a list out (its local edits are not in the base yet, so
  # the plan would treat them as already synced), and only if no list changed since we read them. A folder
  # without lists sends nothing (it may be one that is not there right now), but does receive.
  if ($diff -and $diff.Skipped -and -not $diff.Empty) { $res.Retry = $true; return $res }
  $fresh = Read-LocalLists $ctx.ListsDir 0 $ctx.View
  foreach ($name in $fresh.Names) {
    if (-not $local.Files.ContainsKey($name) -or $local.Files[$name].Text -cne $fresh.Files[$name].Text) { $res.Retry = $true; return $res }
  }
  if ($fresh.Names.Count -ne $local.Names.Count) { $res.Retry = $true; return $res }
  $plan = Get-RemotePlan $st $fresh $ctx.ListsDir $scope
  if (-not $plan) { $res.Retry = $true; return $res }
  if ($plan.Ops.Count -gt 0 -or $null -ne $plan.Setting) {
    $ok = & $ctx.ApplyPlan $plan
    if (-not $ok) { $res.Retry = $true; return $res }
    foreach ($k in @($plan.Files.Keys)) { if ($null -eq $plan.Files[$k]) { [void]$st.Files.Remove($k) } else { $st.Files[$k] = $plan.Files[$k] } }
  }
  # the lists now reflect R
  $waiting = @{}; foreach ($e in $st.Outbox) { $waiting["$($e['kind']):$($e['id'])"] = $true }
  if ($plan.Ops.Count) { Add-PlannedNotes $st $waiting $clock }
  foreach ($key in @($st.R.Keys)) {
    $r = $st.R[$key]
    if ($r['kind'] -eq 'conflict' -or $waiting.ContainsKey($key)) { continue }
    $st.S[$key] = Copy-Row $r
  }
  Save-SyncState $st $ctx.StatePath
  return $res
}

function Get-OpenConflicts($st) {
  $out = New-Object System.Collections.ArrayList
  foreach ($key in @($st.R.Keys)) {
    $c = $st.R[$key]
    if ($c['kind'] -ne 'conflict' -or (Get-Field $c 'resolved')['v']) { continue }
    $t = $st.R["task:$($c['task'])"]
    if (-not $t) { continue }
    [void]$out.Add(@{ Id = $c['id']; Task = $c['task']; Field = $c['field']; Value = $c['value']; Other = $c['other']; At = [long]$c['at']
                      TaskText = [string](Get-Field $t 'text')['v']; Current = (Get-Field $t $c['field'])['v']; ResolvedTs = [long](Get-Field $c 'resolved')['ts']
                      FieldTs = [long](Get-Field $t $c['field'])['ts'] })
  }
  return ,$out
}

# ================================================================ lists shared with this PC (docs/sync.md)
# lists\.remotes.json: the bindings, no secrets ({ version: 1, remotes: [{ id, file, server, project, access, name,
# joinedAt, left? }] }); sync\remotes.json: the keys and this PC's device id for them (private, like
# sync\config.json); sync\shares\<id>.json: each one's engine state. The same files as local/shares.mjs.
function Read-ShareBindings([string]$listsDir) {
  $out = New-Object System.Collections.ArrayList
  $t = Read-TextFile (Join-Path $listsDir '.remotes.json')
  if (-not $t) { return ,$out }
  try { $o = ConvertFrom-JsonText $t } catch { return ,$out }
  foreach ($r in @($o['remotes'])) { if ($r -and $r['id'] -is [string] -and $r['file'] -is [string]) { [void]$out.Add($r) } }
  return ,$out
}
function Save-ShareBindings([string]$listsDir, $list) {
  Write-TextFileAtomic (Join-Path $listsDir '.remotes.json') ((ConvertTo-JsonText @{ version = 1; remotes = @($list) }) + "`n")
}
# the names of the lists shared with this PC, as a set (what the engine for one's own server leaves out)
function Get-SharedFileSet([string]$listsDir) {
  $set = @{}
  foreach ($b in (Read-ShareBindings $listsDir)) { $set[[string]$b['file']] = $true }
  return $set
}
# One binding changed (values: a hashtable) or removed ($null), written at once.
function Set-ShareBinding([string]$listsDir, [string]$id, $values) {
  $list = New-Object System.Collections.ArrayList
  foreach ($b in (Read-ShareBindings $listsDir)) {
    if ($b['id'] -cne $id) { [void]$list.Add($b); continue }
    if ($null -eq $values) { continue }
    foreach ($k in @($values.Keys)) { $b[$k] = $values[$k] }
    [void]$list.Add($b)
  }
  Save-ShareBindings $listsDir $list
}
function Read-ShareKeys([string]$syncDir) {
  $t = Read-TextFile (Join-Path $syncDir 'remotes.json')
  $k = $null
  if ($t) { try { $k = ConvertFrom-JsonText $t } catch {} }
  if (-not ($k -is [System.Collections.IDictionary])) { $k = @{} }
  if (-not ($k['tokens'] -is [System.Collections.IDictionary])) { $k['tokens'] = @{} }
  return $k
}
function Save-ShareKeys([string]$syncDir, $keys) {
  if (-not (Test-Path -LiteralPath $syncDir)) { [void](New-Item -ItemType Directory -Path $syncDir -Force) }
  Write-TextFileAtomic (Join-Path $syncDir 'remotes.json') (ConvertTo-JsonText $keys)
}
# A file name for a list joined now: its name, unique among the lists and the other bindings; one another list
# has already gets whose it is: "Groceries (from nuca)".
function Get-FreeShareFileName([string]$listsDir, [string]$name, [string]$server = '') {
  $reserved = @{}
  foreach ($b in (Read-ShareBindings $listsDir)) { $reserved[[string]$b['file']] = $true }
  return (Get-UniqueFileName $listsDir $name $reserved '' $(if ($server) { Get-ServerLabel $server } else { '' }))
}
# Claims an invite (Get-InviteLink) at its server: -> @{ Ok; Data; Error }. Never throws.
function Invoke-ShareClaim($inv) {
  try {
    $r = Invoke-SaqmeApi ($inv.Server + '/api/shares/claim') '' 'POST' @{ code = $inv.Code } 15000
  } catch { return @{ Ok = $false; Error = "Could not reach $(([Uri]$inv.Server).Host). Try again when you are online." } }
  $d = $r.Data
  if ($r.Status -ne 200 -or -not $d -or -not ($d['token'] -is [string]) -or [string]$d['projectId'] -cnotmatch '^[0-9a-z]{8,32}\z') {
    $msg = $(if ($d -and $d['error']) { [string]$d['error'] } else { "The invite did not work ($($r.Status))." })
    return @{ Ok = $false; Error = $msg }
  }
  return @{ Ok = $true; Data = $d }
}
# Joins a list from its invite link: a key of this PC's own, then a binding to a new file (the share's engine
# creates it on its first sync). -> @{ Ok; Binding; Error }
function Join-SharedList([string]$listsDir, [string]$syncDir, [string]$link) {
  $inv = Get-InviteLink $link
  if (-not $inv) { return @{ Ok = $false; Error = 'That is not an invite link (it looks like https://.../join#code=...).' } }
  $c = Invoke-ShareClaim $inv
  if (-not $c.Ok) { return $c }
  $d = $c.Data
  $access = $(if ($d['access'] -eq 'edit') { 'edit' } else { 'view' })
  foreach ($b in (Read-ShareBindings $listsDir)) {
    if ([string]$b['project'] -ceq [string]$d['projectId'] -and [string]$b['server'] -ceq $inv.Server -and -not $b['left']) {
      if ($d['kind'] -eq 'move') {
        # moved here (from the browser) onto the list this PC has: one key for it, the new one
        $keys = Read-ShareKeys $syncDir
        $old = [string]$keys['tokens'][[string]$b['id']]
        $keys['tokens'][[string]$b['id']] = [string]$d['token']; Save-ShareKeys $syncDir $keys
        if ($old -and $old -cne [string]$d['token']) { try { [void](Invoke-SaqmeApi ($inv.Server + '/api/shares/leave') $old 'POST' @{} 8000) } catch {} }
        Set-ShareBinding $listsDir ([string]$b['id']) @{ access = $access }
        $b['access'] = $access
        return @{ Ok = $true; Binding = $b }
      }
      try { [void](Invoke-SaqmeApi ($inv.Server + '/api/shares/leave') ([string]$d['token']) 'POST' @{} 8000) } catch {}
      return @{ Ok = $false; Error = "'$($d['projectName'])' is already here." }
    }
  }
  $id = 's' + (New-SaqmeId 12)
  $name = $(if ([string]$d['projectName']) { [string]$d['projectName'] } else { 'Shared list' })
  $binding = @{ id = $id; file = (Get-FreeShareFileName $listsDir $name $inv.Server); server = $inv.Server; project = [string]$d['projectId']
                access = $access; name = $name; joinedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $keys = Read-ShareKeys $syncDir
  $keys['tokens'][$id] = [string]$d['token']   # the key first: a binding without one is never synced
  Save-ShareKeys $syncDir $keys
  $list = Read-ShareBindings $listsDir; [void]$list.Add($binding); Save-ShareBindings $listsDir $list
  return @{ Ok = $true; Binding = $binding }
}
# Forgets a binding: its key and its engine's state (the file itself is the caller's).
function Remove-SharedList([string]$listsDir, [string]$syncDir, [string]$id) {
  Set-ShareBinding $listsDir $id $null
  $keys = Read-ShareKeys $syncDir
  if ($keys['tokens'].ContainsKey($id)) { [void]$keys['tokens'].Remove($id); Save-ShareKeys $syncDir $keys }
  $sp = Join-Path $syncDir "shares\$id.json"
  if (Test-Path -LiteralPath $sp) { try { Remove-Item -LiteralPath $sp -Force } catch {} }
}
