# Saqme To Do - the tools of the local server for Claude Desktop (desktop/mcp-server.ps1), on the list files.
# Dot-source it after sync-core.ps1; it only defines functions. Windows PowerShell 5.1.
#
# The same tools, names and shapes as the Worker's AI connector (worker/src/mcp.js; desktop/mcp-tools.json is made from
# its LOCAL_TOOLS by scripts/build-mcp-tools.mjs), done on the lists folder directly, so they need no sync: today,
# get_lists, list_tasks, add_tasks, update_task, move_task, delete_task, restore_task, create_list. A list's id is its
# name (its file name). The app (widget.ps1) picks every change up like any other program's edit, and syncs it.
#
# What keeps the lists safe (docs/ai.md, "Connect Claude Desktop"):
#   - no list file is ever deleted, emptied or renamed; a new list is a new file, only where there is none
#   - every write replaces the file in one step and only while it still holds what was read (Write-TextFileIfUnchanged);
#     when someone else changed it meanwhile the tool reads again and starts over
#   - before a write, every task id the file had must still be in it unless the tool is moving or deleting that task
#     (Assert-McpNoLoss); ids are kept, new tasks get new ones
#   - a deleted task goes to Recently deleted (recently-deleted.json, the widget's own) before it leaves its file, at most
#     McpDeleteLimit an hour (ai-deletes.json), as the Worker's connector does
#   - lists someone shares with this PC for viewing only (lists\.remotes.json) are not changed
#   - the writers refuse AppData while this process sees another app's private copy of it (Assert-RealAppData):
#     mcp-server.ps1 runs these tools outside Claude's container

$script:McpCI = [Globalization.CultureInfo]::InvariantCulture
$script:McpStatus = [ordered]@{ todo = ' '; in_progress = '/'; done = 'x'; postponed = '>'; blocked = '!'; failed = '-'; abandoned = '~' }
$script:McpStatusName = @{}; foreach ($k in $script:McpStatus.Keys) { $script:McpStatusName[$script:McpStatus[$k]] = $k }
$script:McpMaxResults = 200
$script:McpMaxNew = 50
$script:McpDeleteLimit = 25
$script:McpTrashMs = [long]30 * 86400000

# A message for the model (the tool answers with it, isError), or a write that found the file changed (read again).
function Stop-Mcp([string]$msg) { $e = New-Object System.Exception $msg; $e.Data['saqme'] = 'tool'; throw $e }
function Stop-McpRetry { $e = New-Object System.Exception 'changed meanwhile'; $e.Data['saqme'] = 'retry'; throw $e }

# ---------------------------------------------------------------- context
# @{ DataDir; Lists; Now (a DateTime: tests); Tz } -> the context the tools work in
function New-McpContext([string]$DataDir, $Now = $null) {
  return @{ DataDir = $DataDir; Lists = (Join-Path $DataDir 'lists'); Now = $Now; Tz = [TimeZoneInfo]::Local.Id; Refused = '' }
}
function Get-McpNow($ctx) { if ($ctx.Now) { return [DateTime]$ctx.Now } else { return [DateTime]::Now } }
function Get-McpNowMs($ctx) { return ([DateTimeOffset](Get-McpNow $ctx)).ToUnixTimeMilliseconds() }

function Get-McpToday($ctx) {
  $now = Get-McpNow $ctx
  $d = $now.Date
  $dow = (([int]$d.DayOfWeek) + 6) % 7   # Monday 0
  $day = { param([int]$n) $d.AddDays($n).ToString('yyyy-MM-dd', $script:McpCI) }
  return [ordered]@{
    date = $d.ToString('yyyy-MM-dd', $script:McpCI); time = $now.ToString('HH:mm', $script:McpCI); weekday = $now.ToString('dddd', $script:McpCI)
    timezone = $ctx.Tz; week_start = (& $day (-$dow)); week_end = (& $day (6 - $dow)); yesterday = (& $day -1); tomorrow = (& $day 1)
  }
}

# ---------------------------------------------------------------- the lists as they are now
# Every list file: @{ Name; Path; Text (as read: what a write must still find); Items; Eol; Share (its binding, or
# $null); Busy (could not be read just now) }. Tasks without an id get one (as the app would), written by Save-McpIds.
function Read-McpLists($ctx) {
  $shares = @{}
  foreach ($b in (Read-ShareBindings $ctx.Lists)) { if (-not $b['left']) { $shares[[string]$b['file']] = $b } }
  $docs = New-Object System.Collections.ArrayList
  foreach ($name in (Get-ProjectFileNames $ctx.Lists)) {
    $path = Join-Path $ctx.Lists "$name.md"
    $text = Read-TextFile $path
    $items = Read-Items $text
    $doc = [pscustomobject]@{ Name = [string]$name; Path = $path; Text = $text; Items = $items; Eol = (Get-TextEol $text); Share = $shares[[string]$name]; Busy = ($null -eq $text); NeedIds = $false }
    if (-not $doc.Busy -and (Test-McpWritable $doc)) { $doc.NeedIds = [bool](Set-MissingIds $items $null $null) }
    [void]$docs.Add($doc)
  }
  return ,$docs
}
function Test-McpWritable($doc) { return -not ($doc.Share -and [string]$doc.Share['access'] -ne 'edit') }
function Assert-McpWritable($doc) {
  if ($doc.Busy) { Stop-Mcp "The list `"$($doc.Name)`" is open in another program that is saving it right now. Try again in a moment." }
  if (-not (Test-McpWritable $doc)) { Stop-Mcp "The list `"$($doc.Name)`" is shared with the user by $(Get-ServerLabel ([string]$doc.Share['server'])) for viewing only: nothing in it can be changed here." }
}
# the ids given to tasks that had none, written now (a read-only tool); a file changed meanwhile keeps them for later
function Save-McpIds($ctx, $docs) {
  foreach ($doc in $docs) { if ($doc.NeedIds) { try { [void](Save-McpDoc $doc $null) } catch {} } }
}

function Find-McpList($docs, $arg) {
  if (-not ($arg -is [string]) -or -not $arg.Trim()) { Stop-Mcp 'Say which list (its name, from get_lists).' }
  $a = $arg.Trim()
  foreach ($d in $docs) { if ($d.Name -ceq $a) { return $d } }
  foreach ($d in $docs) { if ($d.Name -ieq $a) { return $d } }
  $names = @($docs | ForEach-Object { $_.Name }) -join ', '
  Stop-Mcp "There is no list `"$a`". The lists are: $(if ($names) { $names } else { '(none yet)' })."
}

# The tasks of a list as a tree, in file order: @{ I (index in Items); Item; Parent (node or $null); Kids; Depth }.
# A task's subtasks are the indented tasks right below it; any other line ends the nesting (as the apps read it).
function Get-McpNodes($items) {
  $nodes = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $items.Count; $i++) {
    $it = $items[$i]
    if ($it.Kind -ne 'task') { $stack.Clear(); continue }
    if ($it.Text -eq '') { continue }
    while ($stack.Count -and $stack[$stack.Count - 1].Item.Level -ge $it.Level) { $stack.RemoveAt($stack.Count - 1) }
    $parent = $(if ($stack.Count) { $stack[$stack.Count - 1] } else { $null })
    $n = [pscustomobject]@{ I = $i; Item = $it; Parent = $parent; Kids = (New-Object System.Collections.ArrayList); Depth = $(if ($parent) { $parent.Depth + 1 } else { 0 }) }
    if ($parent) { [void]$parent.Kids.Add($n) }
    [void]$nodes.Add($n)
    [void]$stack.Add($n)
  }
  return ,$nodes
}
function Get-McpRoots($nodes) { foreach ($n in $nodes) { if (-not $n.Parent) { $n } } }   # (call it as @(Get-McpRoots ...))
# a task's block: its line, its subtasks and notes (items I .. end-1)
function Get-McpBlockEnd($items, $node) { return (Get-SubtreeEnd $items $node.I) }

# -> @{ Doc; Node; Nodes } for a live task id, or a message for the model
function Find-McpTask($docs, $id, [string]$what = 'task') {
  if (-not ($id -is [string]) -or $id -cnotmatch '^[0-9a-z]{8,32}$') { Stop-Mcp "That is not a $what id; take one from list_tasks." }
  foreach ($d in $docs) {
    if ($d.Busy) { continue }
    $nodes = Get-McpNodes $d.Items
    foreach ($n in $nodes) { if ([string]$n.Item.Id -ceq $id) { return @{ Doc = $d; Node = $n; Nodes = $nodes } } }
  }
  foreach ($e in (Read-McpDeleted $null)) { if (@($e['ids']) -contains $id) { Stop-Mcp "The $what $id is deleted (restore_task brings it back)." } }
  Stop-Mcp "There is no $what with the id $id."
}

# ---------------------------------------------------------------- values
function Get-McpDue($it) {
  if (-not $it.Due) { return $null }
  if ($it.DueTime) { return $it.Due + 'T' + $it.DueTime.PadLeft(5, '0') }
  return $it.Due
}
function Get-McpStatusName($it) { $n = $script:McpStatusName[[string]$it.Mark]; if ($n) { return $n } else { return 'todo' } }
function ConvertTo-McpTask($it, $doc, $parentId, [int]$kids) {
  return [ordered]@{ id = [string]$it.Id; list = $doc.Name; list_id = $doc.Name; parent_id = $(if ($parentId) { [string]$parentId } else { $null })
                     status = (Get-McpStatusName $it); text = $it.Text; due = (Get-McpDue $it); notes = [string]$it.Notes; subtasks = $kids }
}
function Test-McpArg($a, [string]$k) { return $a.ContainsKey($k) }

$script:McpDueHelp = 'YYYY-MM-DD, or YYYY-MM-DDTHH:MM'
# -> @{ Due; Time } ('' and '' remove it), or $null when not given
function ConvertFrom-McpDue($a, [string]$k = 'due') {
  if (-not (Test-McpArg $a $k)) { return $null }
  $v = $a[$k]
  if ($null -eq $v -or [string]$v -eq '') { return @{ Due = ''; Time = '' } }
  if (-not ($v -is [string]) -or $v.Trim() -cnotmatch '^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ]([0-9]{1,2}:[0-9]{2}))?\z') { Stop-Mcp "`"$v`" is not a deadline: use $script:McpDueHelp." }
  $date = $matches[1]; $time = $(if ($matches[2]) { ConvertTo-CleanTime $matches[2] } else { '' })
  if (-not (Test-ValidDate $date) -or ($matches[2] -and -not $time)) { Stop-Mcp "`"$v`" is not a deadline: use $script:McpDueHelp." }
  return @{ Due = $date; Time = $time }
}
function ConvertFrom-McpStatus($v) {
  if ($null -eq $v) { return $null }
  $s = [string]$v
  if ($script:McpStatus.Contains($s)) { return $script:McpStatus[$s] }
  if ($script:ValidMarks -ccontains $s) { return $s }
  Stop-Mcp "`"$s`" is not a status: use one of $(@($script:McpStatus.Keys) -join ', ')."
}
function ConvertFrom-McpText($v, [string]$what = 'text') {
  if (-not ($v -is [string])) { Stop-Mcp "The $what must be a string." }
  $t = ConvertTo-CleanText $v 1000000
  if (-not $t) { Stop-Mcp "The $what is empty." }
  if ($t.Length -gt 10000) { Stop-Mcp "The $what is too long." }
  # what the list line would read back as: a text ending in " due:..." or " ^id" would turn into a deadline or an id
  $back = ConvertFrom-TaskText $t
  if ($back.Text -cne $t -or $back.Id -or $back.Due) { Stop-Mcp "The $what cannot end with a deadline or an id written out (`"due:`", `"^`"): give the deadline as due." }
  return $t
}
function ConvertFrom-McpNotes($v) {
  if (-not ($v -is [string])) { Stop-Mcp 'notes must be a string.' }
  $n = ConvertTo-CleanNotes $v
  if ($n.Length -gt 100000) { Stop-Mcp 'The notes are too long.' }
  return $n
}

# ---------------------------------------------------------------- writing
# A task id the file had that writing $newText would lose, unless it is allowed to go ($allowed: moved or deleted).
function Assert-McpNoLoss([string]$oldText, [string]$newText, $allowed) {
  $new = Get-TaskIdSet (Read-Items $newText)
  foreach ($id in (Get-TaskIdSet (Read-Items $oldText))) {
    if (-not $new.Contains($id) -and -not ($allowed -and $allowed.Contains($id))) { throw "refused to write: the task $id would be lost" }
  }
}
# -> $true when written; $false when the file changed since it was read (or appeared, for a new one)
function Save-McpDoc($doc, $allowed) {
  $new = ConvertTo-MarkdownText $doc.Items 0 $doc.Eol
  if ($null -ne $doc.Text -and $new -ceq $doc.Text) { $doc.NeedIds = $false; return $true }
  if ($null -ne $doc.Text) { Assert-McpNoLoss $doc.Text $new $allowed }
  if (-not (Write-TextFileIfUnchanged $doc.Path $new $doc.Text)) { return $false }
  $doc.Text = $new; $doc.NeedIds = $false
  return $true
}
function Save-McpDocOrRetry($doc, $allowed) { if (-not (Save-McpDoc $doc $allowed)) { Stop-McpRetry } }

function New-McpId($docs) {
  $taken = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($d in $docs) { foreach ($it in $d.Items) { if ($it.Kind -eq 'task' -and $it.Id) { [void]$taken.Add([string]$it.Id) } } }
  for (; ; ) { $id = New-SaqmeId; if (-not $taken.Contains($id)) { return $id } }
}
function New-McpItem([int]$level, [string]$mark, [string]$text, [string]$due, [string]$time, [string]$notes, [string]$id) {
  return [pscustomobject]@{ Kind = 'task'; Level = $level; Mark = $mark; MarkRaw = ''; Indent = 2 * $level; Text = $text; Due = $due; DueTime = $time; Notes = $notes; Raw = ''; Id = $id }
}

# Where new tasks go among siblings (nodes, in order): -> the index in Items. $after: a sibling node to follow.
function Get-McpInsertAt($items, $siblings, $parent, $position, $after) {
  if ($after) { return (Get-McpBlockEnd $items $after) }
  if ($null -ne $position -and $position -ne 'top' -and $position -ne 'bottom') { Stop-Mcp 'position is top or bottom.' }
  if ($siblings.Count) {
    if ($position -eq 'top') { return $siblings[0].I }
    return (Get-McpBlockEnd $items $siblings[$siblings.Count - 1])
  }
  if ($parent) { return $parent.I + 1 }
  return $items.Count
}

# ---------------------------------------------------------------- Recently deleted (the widget's recently-deleted.json)
function Get-McpDeletedPath($ctx) { return (Join-Path $ctx.DataDir 'recently-deleted.json') }
function Read-McpDeleted($ctx) {
  if (-not $ctx) { $ctx = $script:McpCtx }
  if (-not $ctx) { return }
  $t = Read-TextFile (Get-McpDeletedPath $ctx)
  if (-not $t) { return }
  try { $o = ConvertFrom-JsonText $t } catch { return }
  $o | Where-Object { $_ -is [System.Collections.IDictionary] -and $_['text'] }
}
function Save-McpDeleted($ctx, $entries) { Write-TextFileAtomic (Get-McpDeletedPath $ctx) (ConvertTo-JsonText @($entries)) }

# the deletes of the last hour (ai-deletes.json: [[at, n], ...]) -> how many tasks
function Get-McpDeleteBudgetUsed($ctx, [long]$now) {
  $t = Read-TextFile (Join-Path $ctx.DataDir 'ai-deletes.json')
  $used = 0
  if ($t) { try { foreach ($x in @(ConvertFrom-JsonText $t)) { if ($now - [long]$x[0] -lt 3600000) { $used += [int]$x[1] } } } catch {} }
  return $used
}
function Add-McpDeleteBudget($ctx, [long]$now, [int]$n) {
  $keep = New-Object System.Collections.ArrayList
  $t = Read-TextFile (Join-Path $ctx.DataDir 'ai-deletes.json')
  if ($t) { try { foreach ($x in @(ConvertFrom-JsonText $t)) { if ($now - [long]$x[0] -lt 3600000) { [void]$keep.Add(@([long]$x[0], [int]$x[1])) } } } catch {} }
  [void]$keep.Add(@($now, $n))
  Write-TextFileAtomic (Join-Path $ctx.DataDir 'ai-deletes.json') (ConvertTo-JsonText $keep)
}

# ---------------------------------------------------------------- the tools
function Invoke-McpGetLists($ctx, $a) {
  $docs = Read-McpLists $ctx
  Save-McpIds $ctx $docs
  $today = Get-McpToday $ctx
  $lists = New-Object System.Collections.ArrayList
  foreach ($d in $docs) {
    $open = 0; $due = 0; $over = 0
    foreach ($it in $d.Items) {
      if ($it.Kind -ne 'task' -or $it.Text -eq '' -or ' /!'.IndexOf([string]$it.Mark) -lt 0) { continue }
      $open++
      if ($it.Due -and [string]::CompareOrdinal($it.Due, $today.date) -le 0) { $due++ }
      if ($it.Due -and [string]::CompareOrdinal($it.Due, $today.date) -lt 0) { $over++ }
    }
    $l = [ordered]@{ id = $d.Name; name = $d.Name; open = $open; due_today_or_earlier = $due; overdue = $over }
    if ($d.Share) { $l['shared_from'] = Get-ServerLabel ([string]$d.Share['server']); $l['can_edit'] = (Test-McpWritable $d) }
    if ($d.Busy) { $l['busy'] = $true }
    [void]$lists.Add($l)
  }
  return [ordered]@{ today = $today; lists = $lists }
}

function Invoke-McpListTasks($ctx, $a) {
  $docs = Read-McpLists $ctx
  Save-McpIds $ctx $docs
  if (Test-McpArg $a 'list') { $lists = @(Find-McpList $docs $a['list']) } else { $lists = @($docs) }
  if ((Test-McpArg $a 'status') -and $null -ne $a['status']) { $wanted = @($a['status']) } else { $wanted = @('unfinished') }
  $marks = New-Object 'System.Collections.Generic.HashSet[string]'
  $deleted = $false
  foreach ($w in $wanted) {
    switch -CaseSensitive ([string]$w) {
      'unfinished' { foreach ($m in ' ', '/', '!', '>') { [void]$marks.Add($m) } }
      'open' { foreach ($m in ' ', '/', '!') { [void]$marks.Add($m) } }
      'closed' { foreach ($m in 'x', '-', '~') { [void]$marks.Add($m) } }
      'all' { foreach ($m in $script:McpStatus.Values) { [void]$marks.Add($m) } }
      'deleted' { $deleted = $true }
      default { [void]$marks.Add((ConvertFrom-McpStatus $w)) }
    }
  }
  foreach ($k in 'due_from', 'due_to') {
    if ((Test-McpArg $a $k) -and -not ($a[$k] -is [string] -and (Test-ValidDate $a[$k]))) { Stop-Mcp "$k must be a date, YYYY-MM-DD." }
  }
  $from = $a['due_from']; $to = $a['due_to']
  $q = $(if ($a['query'] -is [string] -and $a['query'].Trim()) { $a['query'].Trim().ToLowerInvariant() } else { '' })
  if ($q.Length -gt 200) { $q = $q.Substring(0, 200) }
  $keep = {
    param($it)
    if ($from -or $to) {
      if (-not $it.Due) { return $false }
      if ($from -and [string]::CompareOrdinal($it.Due, $from) -lt 0) { return $false }
      if ($to -and [string]::CompareOrdinal($it.Due, $to) -gt 0) { return $false }
    }
    return (-not $q -or $it.Text.ToLowerInvariant().Contains($q) -or ([string]$it.Notes).ToLowerInvariant().Contains($q))
  }
  $out = New-Object System.Collections.ArrayList
  $truncated = $false
  $today = Get-McpToday $ctx
  if ($deleted) {
    # Recently deleted on this PC: each entry is a task with the subtasks deleted with it, newest first (30 days)
    $now = Get-McpNowMs $ctx
    $names = @{}; foreach ($d in $lists) { $names[$d.Name] = $d }
    $present = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($d in $docs) { foreach ($id in (Get-TaskIdSet $d.Items)) { [void]$present.Add($id) } }
    $entries = @(Read-McpDeleted $ctx | Where-Object { $now - [long]$_['at'] -lt $script:McpTrashMs } | Sort-Object { [long]$_['at'] } -Descending)
    foreach ($e in $entries) {
      $ids = @($e['ids'] | ForEach-Object { [string]$_ })
      if (-not @($ids | Where-Object { -not $present.Contains($_) }).Count) { continue }   # all back already
      if ((Test-McpArg $a 'list') -and -not $names.ContainsKey([string]$e['list'])) { continue }
      $its = @((Read-Items ([string]$e['text'])) | Where-Object { $_.Kind -eq 'task' -and $_.Text -ne '' })
      if (-not $its.Count -or -not (& $keep $its[0])) { continue }
      if ($out.Count -ge $script:McpMaxResults) { $truncated = $true; break }
      $v = [ordered]@{ id = [string]$its[0].Id; list = [string]$e['list']; list_id = [string]$e['list']; parent_id = $(if ($e['parent']) { [string]$e['parent'] } else { $null })
                       status = 'deleted'; was = (Get-McpStatusName $its[0]); text = $its[0].Text; due = (Get-McpDue $its[0]); notes = [string]$its[0].Notes; subtasks = $its.Count - 1
                       deleted_at = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$e['at']).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $script:McpCI) }
      [void]$out.Add($v)
    }
    $r = [ordered]@{ today = $today; tasks = $out }
    if ($truncated) { $r['truncated'] = $true }
    return $r
  }
  foreach ($d in $lists) {
    if ($truncated) { break }
    foreach ($n in (Get-McpNodes $d.Items)) {
      $mark = [string]$n.Item.Mark
      if (-not $marks.Contains($mark) -or -not (& $keep $n.Item)) { continue }
      if ($out.Count -ge $script:McpMaxResults) { $truncated = $true; break }
      $v = ConvertTo-McpTask $n.Item $d $(if ($n.Parent) { $n.Parent.Item.Id } else { $null }) $n.Kids.Count
      $v['depth'] = $n.Depth
      [void]$out.Add($v)
    }
  }
  $r = [ordered]@{ today = $today; tasks = $out }
  if ($truncated) { $r['truncated'] = $true; $r['hint'] = 'More tasks match: filter by list, status, deadline or query.' }
  return $r
}

function Invoke-McpAddTasks($ctx, $a) {
  $docs = Read-McpLists $ctx
  if (-not ($a['tasks'] -is [array]) -or -not @($a['tasks']).Count) { Stop-Mcp 'tasks: give at least one task, as { text }.' }
  $parent = $null; $after = $null
  if ($null -ne $a['parent_id']) {
    $p = Find-McpTask $docs $a['parent_id'] 'parent task'
    $doc = $p.Doc; $parent = $p.Node; $nodes = $p.Nodes
    if ((Test-McpArg $a 'list') -and (Find-McpList $docs $a['list']) -ne $doc) { Stop-Mcp "The parent task is in the list `"$($doc.Name)`", not `"$($a['list'])`"." }
  } elseif ($null -ne $a['after_id']) {
    $s = Find-McpTask $docs $a['after_id'] 'after_id task'
    $doc = $s.Doc; $after = $s.Node; $parent = $s.Node.Parent; $nodes = $s.Nodes
    if ((Test-McpArg $a 'list') -and (Find-McpList $docs $a['list']) -ne $doc) { Stop-Mcp "The task $($a['after_id']) (after_id) is in the list `"$($doc.Name)`", not `"$($a['list'])`"." }
  } else {
    $doc = Find-McpList $docs $a['list']
    $nodes = Get-McpNodes $doc.Items
  }
  Assert-McpWritable $doc
  if ($null -ne $a['parent_id'] -and $null -ne $a['after_id']) {
    $s = Find-McpTask $docs $a['after_id'] 'after_id task'
    if ($s.Node.Parent -ne $parent) { Stop-Mcp "The task $($a['after_id']) (after_id) is not among the tasks at that place." }
    $after = $s.Node
  }
  # what to make, checked before anything is written
  $script:mcpCount = 0
  $prep = {
    param($list, [int]$depth)
    if (-not ($list -is [array])) { Stop-Mcp 'subtasks must be a list of tasks.' }
    if ($depth -gt 10) { Stop-Mcp 'Subtasks go at most 10 levels deep.' }
    $res = New-Object System.Collections.ArrayList
    foreach ($t in $list) {
      if (-not ($t -is [System.Collections.IDictionary])) { Stop-Mcp 'Each task is an object with at least text.' }
      if (++$script:mcpCount -gt $script:McpMaxNew) { Stop-Mcp "At most $script:McpMaxNew tasks per call (subtasks included): add the rest with another call." }
      $due = ConvertFrom-McpDue $t
      $st = ConvertFrom-McpStatus $t['status']
      [void]$res.Add(@{ Text = (ConvertFrom-McpText $t['text']); Mark = $(if ($null -ne $st) { $st } else { ' ' }); Due = $(if ($due) { $due.Due } else { '' }); Time = $(if ($due) { $due.Time } else { '' })
                        Notes = $(if (Test-McpArg $t 'notes') { ConvertFrom-McpNotes $t['notes'] } else { '' }); Kids = $(if (Test-McpArg $t 'subtasks') { & $prep $t['subtasks'] ($depth + 1) } else { New-Object System.Collections.ArrayList }) })
    }
    return ,$res
  }
  $todo = & $prep @($a['tasks']) 0
  if ($parent) { $siblings = @($parent.Kids) } else { $siblings = @(Get-McpRoots $nodes) }
  $at = Get-McpInsertAt $doc.Items $siblings $parent $a['position'] $after
  $level = $(if ($parent) { $parent.Item.Level + 1 } elseif ($after) { $after.Item.Level } else { 0 })
  $new = New-Object System.Collections.ArrayList
  $made = New-Object System.Collections.ArrayList
  $make = {
    param($list, [int]$lv, $parentId, $into)
    foreach ($t in $list) {
      $id = New-McpId $docs
      $it = New-McpItem $lv $t.Mark $t.Text $t.Due $t.Time $t.Notes $id
      [void]$new.Add($it); $doc.Items.Insert($at + $new.Count - 1, $it)   # (so the next id is checked against it too)
      $v = [ordered]@{ id = $id; list = $doc.Name; list_id = $doc.Name; parent_id = $parentId; status = (Get-McpStatusName $it); text = $t.Text; due = (Get-McpDue $it); notes = $t.Notes }
      [void]$into.Add($v)
      if ($t.Kids.Count) { $v['subtasks'] = New-Object System.Collections.ArrayList; & $make $t.Kids ($lv + 1) $id $v['subtasks'] }
    }
  }
  & $make $todo $level $(if ($parent) { [string]$parent.Item.Id } else { $null }) $made
  Save-McpDocOrRetry $doc $null
  return [ordered]@{ added = $new.Count; tasks = $made }
}

function Invoke-McpUpdateTask($ctx, $a) {
  $docs = Read-McpLists $ctx
  $f = Find-McpTask $docs $a['id']
  Assert-McpWritable $f.Doc
  $it = $f.Node.Item
  $any = $false
  if (Test-McpArg $a 'text') { $it.Text = ConvertFrom-McpText $a['text']; $any = $true }
  if (Test-McpArg $a 'status') { $it.Mark = ConvertFrom-McpStatus $a['status']; $it.MarkRaw = ''; $any = $true }
  $due = ConvertFrom-McpDue $a
  if ($due) { $it.Due = $due.Due; $it.DueTime = $due.Time; $any = $true }
  if (Test-McpArg $a 'notes') { $it.Notes = ConvertFrom-McpNotes $a['notes']; $any = $true }
  if (-not $any) { Stop-Mcp 'Nothing to change: give status, text, due or notes.' }
  Save-McpDocOrRetry $f.Doc $null
  return [ordered]@{ task = (ConvertTo-McpTask $it $f.Doc $(if ($f.Node.Parent) { $f.Node.Parent.Item.Id } else { $null }) $f.Node.Kids.Count) }
}

function Invoke-McpMoveTask($ctx, $a) {
  $docs = Read-McpLists $ctx
  $src = Find-McpTask $docs $a['id']
  $target = $src.Doc; $parent = $src.Node.Parent; $after = $null
  if ($null -ne $a['after_id']) {
    $after = Find-McpTask $docs $a['after_id'] 'after_id task'
    $target = $after.Doc; $parent = $after.Node.Parent
  }
  if (Test-McpArg $a 'parent_id') {
    if ($null -eq $a['parent_id']) {
      $parent = $null
      if (Test-McpArg $a 'list') { $target = Find-McpList $docs $a['list'] }
    } else {
      $p = Find-McpTask $docs $a['parent_id'] 'parent task'
      $target = $p.Doc; $parent = $p.Node
    }
  } elseif ((Test-McpArg $a 'list') -and -not $after) {
    $l = Find-McpList $docs $a['list']
    if ($l -ne $src.Doc) { $target = $l; $parent = $null }
  }
  if ((Test-McpArg $a 'list') -and (Find-McpList $docs $a['list']) -ne $target) { Stop-Mcp 'list, parent_id and after_id point at different lists.' }
  $parentId = $(if ($parent) { [string]$parent.Item.Id } else { '' })
  if ($after) { $ap = $(if ($after.Node.Parent) { [string]$after.Node.Parent.Item.Id } else { '' }); if ($ap -cne $parentId) { Stop-Mcp 'after_id must be a task under the same parent as where it goes.' } }
  Assert-McpWritable $src.Doc
  Assert-McpWritable $target
  # the block: the task, its subtasks and notes
  $s = $src.Doc.Items; $i = $src.Node.I; $end = Get-McpBlockEnd $s $src.Node
  $block = @($s.GetRange($i, $end - $i).ToArray())
  $ids = Get-TaskIdSet $block
  if ($parentId -and $ids.Contains($parentId)) { Stop-Mcp 'A task cannot go under itself or one of its own subtasks.' }
  if ($after -and $ids.Contains([string]$after.Node.Item.Id)) { Stop-Mcp 'after_id cannot be the task itself or one of its subtasks.' }
  $s.RemoveRange($i, $end - $i)
  # where it goes, in the list as it is without it
  $t = $target.Items
  $nodes = Get-McpNodes $t
  $pNode = $null; $aNode = $null
  foreach ($n in $nodes) { if ($parentId -and [string]$n.Item.Id -ceq $parentId) { $pNode = $n }; if ($after -and [string]$n.Item.Id -ceq [string]$after.Node.Item.Id) { $aNode = $n } }
  if ($pNode) { $siblings = @($pNode.Kids) } else { $siblings = @(Get-McpRoots $nodes) }
  $at = Get-McpInsertAt $t $siblings $pNode $a['position'] $aNode
  $level = $(if ($pNode) { $pNode.Item.Level + 1 } elseif ($aNode) { $aNode.Item.Level } else { 0 })
  $shift = $level - $block[0].Level
  foreach ($b in $block) { if ($b.Kind -eq 'task') { $b.Level = [Math]::Max(0, $b.Level + $shift); $b.Indent = 2 * $b.Level } }
  $t.InsertRange($at, [object[]]$block)
  if ($target -eq $src.Doc) { Save-McpDocOrRetry $target $null }
  else {
    # the list it goes to first: if anything stops halfway, the task is in both lists (the app gives the copy a new id),
    # never in neither
    Save-McpDocOrRetry $target $null
    for ($try = 0; -not (Save-McpDoc $src.Doc $ids); $try++) {
      if ($try -ge 5) { Stop-Mcp "Copied to `"$($target.Name)`", but `"$($src.Doc.Name)`" kept changing, so the task is in both lists now. Ask the user to remove it from `"$($src.Doc.Name)`" in the app." }
      Start-Sleep -Milliseconds 150
      $text = Read-TextFile $src.Doc.Path
      if ($null -eq $text) { continue }
      $src.Doc.Text = $text; $src.Doc.Eol = Get-TextEol $text; $src.Doc.Items = Read-Items $text
      $ns = Get-McpNodes $src.Doc.Items
      foreach ($n in @($ns | Sort-Object { $_.I } -Descending)) {
        if ($ids.Contains([string]$n.Item.Id) -and -not ($n.Parent -and $ids.Contains([string]$n.Parent.Item.Id))) { $e = Get-McpBlockEnd $src.Doc.Items $n; $src.Doc.Items.RemoveRange($n.I, $e - $n.I) }
      }
    }
  }
  return [ordered]@{ moved = $ids.Count; task = (ConvertTo-McpTask $block[0] $target $(if ($parentId) { $parentId } else { $null }) $src.Node.Kids.Count) }
}

function Invoke-McpDeleteTask($ctx, $a) {
  $docs = Read-McpLists $ctx
  $f = Find-McpTask $docs $a['id']
  Assert-McpWritable $f.Doc
  $items = $f.Doc.Items; $i = $f.Node.I; $end = Get-McpBlockEnd $items $f.Node
  $block = @($items.GetRange($i, $end - $i).ToArray() | Where-Object { $_.Kind -eq 'task' -and $_.Text -ne '' })
  $ids = Get-TaskIdSet $block
  $now = Get-McpNowMs $ctx
  if ($ids.Count -gt $script:McpDeleteLimit -or (Get-McpDeleteBudgetUsed $ctx $now) + $ids.Count -gt $script:McpDeleteLimit) {
    Stop-Mcp "Not deleted: that is more than this connection deletes ($script:McpDeleteLimit tasks an hour, subtasks included), the same care the app takes with deletes that may be a mistake. Ask the user to delete them in the Saqme app, or to try again later."
  }
  # into Recently deleted first: if the list cannot be written, the entry is there with the task still in its list
  # (the app shows only entries whose tasks are gone)
  $entry = [ordered]@{ key = (New-SaqmeId 10); list = $f.Doc.Name; at = $now; parent = $(if ($f.Node.Parent) { [string]$f.Node.Parent.Item.Id } else { '' })
                       text = (ConvertTo-MarkdownText $block $block[0].Level); first = [string]$block[0].Text; count = $block.Count; ids = @($block | ForEach-Object { [string]$_.Id }); by = 'claude-desktop' }
  $keep = @(Read-McpDeleted $ctx | Where-Object { $now - [long]$_['at'] -lt $script:McpTrashMs } | Select-Object -Last 199)
  Save-McpDeleted $ctx ($keep + , $entry)
  $items.RemoveRange($i, $end - $i)
  Save-McpDocOrRetry $f.Doc $ids
  Add-McpDeleteBudget $ctx $now $ids.Count
  return [ordered]@{ deleted = $ids.Count; ids = @($entry.ids); list = $f.Doc.Name; text = [string]$block[0].Text; note = 'In Recently deleted for 30 days: restore_task brings it back.' }
}

function Invoke-McpRestoreTask($ctx, $a) {
  $docs = Read-McpLists $ctx
  $id = $a['id']
  if (-not ($id -is [string]) -or $id -cnotmatch '^[0-9a-z]{8,32}$') { Stop-Mcp 'That is not a task id.' }
  $now = Get-McpNowMs $ctx
  $entries = @(Read-McpDeleted $ctx | Where-Object { $now - [long]$_['at'] -lt $script:McpTrashMs })
  $e = @($entries | Where-Object { [string]@($_['ids'])[0] -ceq $id }) + @($entries | Where-Object { @($_['ids']) -ccontains $id }) | Select-Object -First 1
  if (-not $e) {
    foreach ($d in $docs) { if ((Get-TaskIdSet $d.Items).Contains($id)) { Stop-Mcp "The task $id is not deleted." } }
    Stop-Mcp "There is no deleted task with the id $id on this computer (list_tasks with status deleted shows them)."
  }
  $doc = $null; foreach ($d in $docs) { if ($d.Name -ceq [string]$e['list']) { $doc = $d } }
  if (-not $doc) { Stop-Mcp "Its list `"$($e['list'])`" is not there any more. The user can bring it back in the app: Settings > Your lists > Recently deleted." }
  Assert-McpWritable $doc
  $present = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($d in $docs) { foreach ($x in (Get-TaskIdSet $d.Items)) { [void]$present.Add($x) } }
  $all = @((Read-Items ([string]$e['text'])) | Where-Object { $_.Kind -eq 'task' -and $_.Text -ne '' })
  $start = -1
  for ($k = 0; $k -lt $all.Count; $k++) { if ([string]$all[$k].Id -ceq $id) { $start = $k; break } }
  if ($start -gt 0) { $end = $start + 1; while ($end -lt $all.Count -and $all[$end].Level -gt $all[$start].Level) { $end++ }; $all = $all[$start..($end - 1)] }   # a subtask of the entry: just it
  $block = @($all | Where-Object { -not $present.Contains([string]$_.Id) })
  if (-not $block.Count) { Stop-Mcp "The task $id is back already." }
  $nodes = Get-McpNodes $doc.Items
  $pNode = $null
  $parentId = $(if ($start -gt 0) { '' } else { [string]$e['parent'] })
  if ($parentId) { foreach ($n in $nodes) { if ([string]$n.Item.Id -ceq $parentId) { $pNode = $n } } }
  if ($pNode) { $siblings = @($pNode.Kids) } else { $siblings = @(Get-McpRoots $nodes) }
  $at = Get-McpInsertAt $doc.Items $siblings $pNode 'bottom' $null
  $base = $block[0].Level; $lv = $(if ($pNode) { $pNode.Item.Level + 1 } else { 0 })
  foreach ($b in $block) { $b.Level = [Math]::Max(0, $b.Level - $base + $lv); $b.Indent = 2 * $b.Level }
  $doc.Items.InsertRange($at, [object[]]$block)
  Save-McpDocOrRetry $doc $null
  if ($start -le 0) { try { Save-McpDeleted $ctx @(Read-McpDeleted $ctx | Where-Object { [string]$_['key'] -cne [string]$e['key'] }) } catch {} }
  return [ordered]@{ restored = $block.Count; task = (ConvertTo-McpTask $block[0] $doc $(if ($pNode) { [string]$pNode.Item.Id } else { $null }) 0) }
}

function Invoke-McpCreateList($ctx, $a) {
  $docs = Read-McpLists $ctx
  if (-not ($a['name'] -is [string])) { Stop-Mcp 'Give the list a name.' }
  $name = ConvertTo-ProjectName $a['name']
  if (-not $name) { Stop-Mcp 'Give the list a name (letters; \ / : * ? " < > | are left out, as in file names).' }
  if ($a['name'].Trim().Length -gt 100) { Stop-Mcp "A list's name has at most 100 characters." }
  $file = ConvertTo-FileName $name
  foreach ($d in $docs) { if ($d.Name -ieq $file -or $d.Name -ieq $name) { Stop-Mcp "There is a list `"$($d.Name)`" already." } }
  if (Test-Path -LiteralPath (Join-Path $ctx.Lists "$file.md")) { Stop-Mcp "There is a list `"$file`" already." }
  $doc = [pscustomobject]@{ Name = $file; Path = (Join-Path $ctx.Lists "$file.md"); Text = $null; Items = (Read-Items "# $file`n"); Eol = "`n"; Share = $null; Busy = $false; NeedIds = $false }
  if (-not (Save-McpDoc $doc $null)) { Stop-Mcp "There is a list `"$file`" already." }
  # at the end of the lists menu (lists\.order, when the user has ordered the lists)
  $order = Join-Path $ctx.Lists '.order'
  if (Test-Path -LiteralPath $order) {
    try { Write-TextFileAtomic $order (((Get-OrderWith $ctx.Lists @($docs | ForEach-Object { $_.Name }) @($file)) -join "`n") + "`n") } catch {}
  }
  return [ordered]@{ list = [ordered]@{ id = $file; name = $file; open = 0 } }
}

# name -> what runs it; a tool that found a file changed meanwhile starts over (a few times)
function Invoke-McpTool($ctx, [string]$name, $a) {
  if ($ctx.Refused) { Stop-Mcp $ctx.Refused }
  $script:McpCtx = $ctx
  $fn = @{ today = 'Get-McpTodayTool'; get_lists = 'Invoke-McpGetLists'; list_tasks = 'Invoke-McpListTasks'; add_tasks = 'Invoke-McpAddTasks'; update_task = 'Invoke-McpUpdateTask'
           move_task = 'Invoke-McpMoveTask'; delete_task = 'Invoke-McpDeleteTask'; restore_task = 'Invoke-McpRestoreTask'; create_list = 'Invoke-McpCreateList' }[$name]
  if (-not $fn) { return $null }
  for ($try = 1; ; $try++) {
    try { return (& $fn $ctx $a) }
    catch {
      if ($_.Exception.Data['saqme'] -ne 'retry') { throw }
      if ($try -ge 5) { Stop-Mcp 'The list kept changing while this was being saved (the app or another program is busy with it). Try again in a moment.' }
      Start-Sleep -Milliseconds (100 * $try)
    }
  }
}
function Get-McpTodayTool($ctx, $a) { return (Get-McpToday $ctx) }

# ---------------------------------------------------------------- JSON-RPC (one message -> its answer, or $null)
# $def: desktop/mcp-tools.json (protocolVersions, instructions, tools)
function Read-McpDefinitions([string]$path) { return (ConvertFrom-JsonText (Read-TextFile $path)) }
function New-McpError($id, [int]$code, [string]$message) { return [ordered]@{ jsonrpc = '2.0'; id = $id; error = [ordered]@{ code = $code; message = $message } } }
function Invoke-McpMessage($ctx, $def, [string]$line) {
  try { $msg = ConvertFrom-JsonText $line } catch { return (ConvertTo-JsonText (New-McpError $null -32700 'parse error')) }
  if ($msg -is [array]) {
    $out = New-Object System.Collections.ArrayList
    foreach ($m in $msg) { $r = Get-McpAnswer $ctx $def $m; if ($r) { [void]$out.Add($r) } }
    if (-not $out.Count) { return $null }
    return (ConvertTo-JsonText $out)
  }
  $r = Get-McpAnswer $ctx $def $msg
  if ($r) { return (ConvertTo-JsonText $r) }
  return $null
}
function Get-McpAnswer($ctx, $def, $msg) {
  if (-not ($msg -is [System.Collections.IDictionary]) -or $msg['jsonrpc'] -ne '2.0' -or -not ($msg['method'] -is [string])) {
    if ($msg -is [System.Collections.IDictionary] -and $msg.ContainsKey('id') -and -not $msg.ContainsKey('result') -and -not $msg.ContainsKey('error')) { return (New-McpError $msg['id'] -32600 'invalid request') }
    return $null
  }
  if (-not $msg.ContainsKey('id')) { return $null }   # a notification
  $id = $msg['id']; $params = $msg['params']
  $ok = { param($result) [ordered]@{ jsonrpc = '2.0'; id = $id; result = $result } }
  switch -CaseSensitive ([string]$msg['method']) {
    'initialize' {
      $asked = $(if ($params -is [System.Collections.IDictionary]) { [string]$params['protocolVersion'] } else { '' })
      $versions = @($def['protocolVersions'])
      return (& $ok ([ordered]@{ protocolVersion = $(if ($versions -contains $asked) { $asked } else { $versions[0] }); capabilities = [ordered]@{ tools = [ordered]@{ listChanged = $false } }
            serverInfo = [ordered]@{ name = 'saqme'; title = 'Saqme To Do'; version = [string]$script:McpVersion }; instructions = [string]$def['instructions'] }))
    }
    'ping' { return (& $ok @{}) }
    'tools/list' { return (& $ok ([ordered]@{ tools = $def['tools'] })) }
    'tools/call' {
      $name = $(if ($params -is [System.Collections.IDictionary]) { $params['name'] } else { $null })
      $known = @($def['tools'] | ForEach-Object { $_['name'] })
      if (-not ($name -is [string]) -or $known -cnotcontains $name) { return (New-McpError $id -32602 "unknown tool: $(([string]$name).Substring(0, [Math]::Min(60, ([string]$name).Length)))") }
      $a = $params['arguments']
      if ($null -eq $a) { $a = @{} }
      if (-not ($a -is [System.Collections.IDictionary])) { return (New-McpError $id -32602 'arguments must be an object') }
      try {
        $out = Invoke-McpTool $ctx $name $a
        return (& $ok ([ordered]@{ content = @([ordered]@{ type = 'text'; text = (ConvertTo-JsonText $out) }); structuredContent = $out }))
      } catch {
        $m = $(if ($_.Exception.Data['saqme'] -eq 'tool') { $_.Exception.Message } else { "Something went wrong in Saqme, and nothing more was changed: $($_.Exception.Message)" })
        if ($_.Exception.Data['saqme'] -ne 'tool') { Write-McpLog $ctx "error in $name`: $($_.Exception.Message) $($_.InvocationInfo.PositionMessage)" }
        return (& $ok ([ordered]@{ content = @([ordered]@{ type = 'text'; text = $m }); isError = $true }))
      }
    }
    'resources/list' { return (& $ok ([ordered]@{ resources = @() })) }
    'resources/templates/list' { return (& $ok ([ordered]@{ resourceTemplates = @() })) }
    'prompts/list' { return (& $ok ([ordered]@{ prompts = @() })) }
  }
  $mm = [string]$msg['method']
  return (New-McpError $id -32601 "method not found: $($mm.Substring(0, [Math]::Min(60, $mm.Length)))")
}

# a short log next to the lists (ai-connection.log, rotated at 256 KB); never where this process sees a private copy
function Write-McpLog($ctx, [string]$text) {
  try {
    if (-not $ctx -or $ctx.Refused) { return }
    $p = Join-Path $ctx.DataDir 'ai-connection.log'
    Assert-RealAppData $p
    if ((Test-Path -LiteralPath $p) -and (Get-Item -LiteralPath $p).Length -gt 256KB) { Move-Item -LiteralPath $p -Destination "$p.old" -Force }
    [IO.File]::AppendAllText($p, (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $script:McpCI) + " $text`r`n", $script:Utf8NoBom)
  } catch {}
}
