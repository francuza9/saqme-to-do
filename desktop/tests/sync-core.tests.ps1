# Unit tests for desktop/sync-core.ps1 (Windows PowerShell 5.1, no modules needed).
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\tests\sync-core.tests.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\sync-core.ps1')
# Rules that also exist in JavaScript (list format, order keys, value rules, plans) are checked against
# shared/fixtures/ by shared-fixtures.tests.ps1; this file covers the engine's own behaviour.

$script:failed = 0; $script:passed = 0
function Test-Case([string]$name, [scriptblock]$body) {
  try { & $body; $script:passed++; Write-Host "  ok   $name" }
  catch { $script:failed++; Write-Host "  FAIL $name`n       $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red }
}
function Assert-Eq($actual, $expected, [string]$what = '') {
  if ($actual -is [array] -or $expected -is [array]) { $a = (@($actual) -join '|'); $e = (@($expected) -join '|') } else { $a = "$actual"; $e = "$expected" }
  if ($a -cne $e) { throw "$what expected <$e> but got <$a>" }
}
function Assert-True($cond, [string]$what) { if (-not $cond) { throw "expected true: $what" } }

function New-TempLists {
  $d = Join-Path ([IO.Path]::GetTempPath()) ('saqme-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  [void](New-Item -ItemType Directory -Path $d)
  return $d
}
function Write-List([string]$dir, [string]$name, [string]$text, [int]$ageSec = 10) {
  $p = Join-Path $dir "$name.md"
  [IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
  [IO.File]::SetLastWriteTimeUtc($p, [DateTime]::UtcNow.AddSeconds(-$ageSec))
}
function Get-Change($st, [string]$kind, [string]$id) {
  foreach ($e in $st.Outbox) { if ($e['kind'] -eq $kind -and $e['id'] -ceq $id) { return $e } }
  return $null
}
# a server-like row for R/S
function New-TaskRow([string]$id, [string]$proj, $parent, [string]$pos, [string]$text, [string]$status = ' ', [long]$ts = 100) {
  return @{ kind = 'task'; id = $id; fields = @{
      place = @{ v = @{ project = $proj; parent = $parent; pos = $pos }; ts = $ts }; text = @{ v = $text; ts = $ts }; status = @{ v = $status; ts = $ts }
      due = @{ v = $null; ts = $ts }; notes = @{ v = ''; ts = $ts }; deleted = @{ v = $false; ts = $ts } } }
}
function New-ProjectRow([string]$id, [string]$name, [string]$pos = 'a0', [bool]$deleted = $false) {
  return @{ kind = 'project'; id = $id; fields = @{ name = @{ v = $name; ts = 100 }; pos = @{ v = $pos; ts = 100 }; deleted = @{ v = $deleted; ts = 100 } } }
}
# state where files == S == R
function New-SyncedState($rows, $files) {
  $st = New-SyncState
  foreach ($r in $rows) { $k = "$($r.kind):$($r.id)"; $st.S[$k] = Copy-Row $r; $st.R[$k] = Copy-Row $r }
  foreach ($k in $files.Keys) { $st.Files[$k] = $files[$k] }
  $st.cursor = 5
  return $st
}

Write-Host 'markdown <-> items'
Test-Case 'parses status, due, time, id in either order' {
  $items = Read-Items "- [/] write report due:2026-10-25T09:05 ^abcd1234`n  - [X] sub ^efgh5678 due:2026-10-26`n* [?] odd mark`n- plain bullet`n"
  Assert-Eq $items.Count 4
  Assert-Eq $items[0].Mark '/'; Assert-Eq $items[0].Text 'write report'; Assert-Eq $items[0].Due '2026-10-25'; Assert-Eq $items[0].DueTime '9:05'; Assert-Eq $items[0].Id 'abcd1234'
  Assert-Eq $items[1].Level 1; Assert-Eq $items[1].Mark 'x'; Assert-Eq $items[1].Id 'efgh5678'; Assert-Eq $items[1].Due '2026-10-26'
  Assert-Eq $items[2].Mark ' '; Assert-Eq $items[3].Text 'plain bullet'
}
Test-Case 'keeps headings, prose, blank lines and notes; round-trips canonical text' {
  $text = "# Work`n`nSome intro text`n- [ ] task one ^aaaaaaaa`n  > a note https://example.com`n  >`n  > more`n  - [!] blocked sub ^bbbbbbbb`n`n## Later`n- [>] someday ^cccccccc`n"
  $items = Read-Items $text
  Assert-Eq $items[3].Notes "a note https://example.com`n`nmore"
  Assert-Eq (ConvertTo-MarkdownText $items) $text
}
Test-Case 'uppercase or short markers are text, not ids' {
  $items = Read-Items "- [ ] call ^ABCDEFGH`n- [ ] x ^abc`n"
  Assert-Eq $items[0].Id ''; Assert-Eq $items[0].Text 'call ^ABCDEFGH'; Assert-Eq $items[1].Text 'x ^abc'
}
Test-Case 'tabs and odd indentation' {
  $items = Read-Items "- [ ] a`n`t- [ ] b`n   - [ ] c`n"
  Assert-Eq (@($items | ForEach-Object { $_.Level }) -join ',') '0,1,1'
}
Test-Case 'stamps missing ids, reuses vanished ids by text, fixes duplicates' {
  $items = Read-Items "- [ ] keep ^aaaaaaaa`n- [ ] lost marker`n- [ ] brand new`n- [ ] dup ^aaaaaaaa`n"
  $changed = Set-MissingIds $items @{ 'lost marker' = 'zzzzzzzz'; 'keep' = 'aaaaaaaa' } @{}
  Assert-True $changed 'changed'
  Assert-Eq $items[0].Id 'aaaaaaaa'; Assert-Eq $items[1].Id 'zzzzzzzz'
  Assert-True ($items[2].Id -cmatch '^[a-z][0-9a-z]{7}$') 'fresh id format'
  Assert-True ($items[3].Id -cne 'aaaaaaaa') 'duplicate re-id'
  Assert-True (-not (Set-MissingIds $items @{} @{})) 'stable once stamped'
}
Test-Case 'id taken by another list gets a fresh id here' {
  $items = Read-Items "- [ ] copy ^aaaaaaaa`n"
  [void](Set-MissingIds $items @{} @{ 'aaaaaaaa' = $true })
  Assert-True ($items[0].Id -cne 'aaaaaaaa') 'fresh'
}
Test-Case 'invalid due dates stay but do not break parsing' {
  $items = Read-Items "- [ ] x due:2026-02-30 ^aaaaaaaa`n"
  Assert-Eq $items[0].Due '2026-02-30'; Assert-True (-not (Test-ValidDate '2026-02-30')) 'invalid'
}

Test-Case 'saving over an outside edit merges by task id instead of overwriting it' {
  $base = "# Work`n- [ ] A ^aaaaaaaa`n- [ ] B ^bbbbbbbb`n- [ ] C ^cccccccc`n"
  $mine = Read-Items $base
  $mine[1].Text = 'A edited in the widget'                       # edit
  $mine[2].Mark = 'x'                                            # status
  [void]$mine.Insert(2, (New-TaskItem 1 ' ' 'new sub of A ^dddddddd'))   # new subtask
  $mine.RemoveAt(4)                                              # delete C
  $theirs = "# Work`nintro by assistant`n- [ ] A ^aaaaaaaa`n  > note by assistant`n- [/] B edited by assistant ^bbbbbbbb`n- [ ] C ^cccccccc`n- [ ] E new by assistant ^eeeeeeee`n"
  $merged = Merge-ListText $base $mine $theirs
  Assert-Eq $merged "# Work`nintro by assistant`n- [ ] A edited in the widget ^aaaaaaaa`n  > note by assistant`n  - [ ] new sub of A ^dddddddd`n- [x] B edited by assistant ^bbbbbbbb`n- [ ] E new by assistant ^eeeeeeee`n"
}
Test-Case 'a task deleted outside comes back only if it was edited in the widget' {
  $base = "- [ ] A ^aaaaaaaa`n- [ ] B ^bbbbbbbb`n"
  $mine = Read-Items $base; $mine[1].Text = 'B changed'
  Assert-Eq (Merge-ListText $base $mine "") "- [ ] B changed ^bbbbbbbb`n"
}
Test-Case 'readers never block an atomic replace' {
  $d = New-TempLists; $p = Join-Path $d 'x.md'
  Write-List $d 'x' "one`n"
  $fs = New-Object IO.FileStream($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try { Write-TextFileAtomic $p "two`n" } finally { $fs.Dispose() }
  Assert-Eq ([IO.File]::ReadAllText($p)) "two`n"
}
Test-Case 'a file with a future timestamp is not treated as busy forever' {
  $d = New-TempLists
  Write-List $d 'Work' "- [ ] A ^aaaaaaaa`n" -3600
  Assert-Eq (Read-LocalLists $d).Files['Work'].Status 'ok'
}

Write-Host 'order keys (cross-checked with keys.js in shared/fixtures/keys.json)'
Test-Case 'rekey keeps the longest increasing run' {
  $m = Get-RekeyMap @('a4', 'a0', 'a1', 'a2', 'a3')
  Assert-Eq (@($m.Keys) -join ',') '0'; Assert-Eq $m[0] 'Zz'
  $m2 = Get-RekeyMap @($null, 'a1', $null, 'a1', 'a0')
  Assert-Eq ((@($m2.Keys) | Sort-Object | ForEach-Object { "$_=$($m2[$_])" }) -join ',') '0=a0,2=a2,3=a3,4=a4'
  Assert-Eq (Get-RekeyMap @('a0', 'a1')).Count 0
}

Test-Case 'keys stay short when lines keep being inserted at the same spot' {
  $keys = New-Object System.Collections.ArrayList; [void]$keys.Add('a0'); [void]$keys.Add('a1')
  for ($i = 0; $i -lt 400; $i++) {
    $keys.Insert(1, $null)
    $m = Get-RekeyMap $keys
    foreach ($k in @($m.Keys)) { $keys[$k] = $m[$k] }
  }
  $max = ($keys | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
  Assert-True ($max -le 48) "max key length $max"
  for ($i = 1; $i -lt $keys.Count; $i++) { Assert-True ([string]::CompareOrdinal($keys[$i - 1], $keys[$i]) -lt 0) 'increasing' }
}

Write-Host 'local diff (files -> changes)'
Test-Case 'first lists become creates with increasing positions' {
  $d = New-TempLists
  Write-List $d 'Work' "# Work`n- [ ] one ^aaaaaaaa`n  - [x] child ^bbbbbbbb`n- [/] two due:2026-10-25T14:00 ^cccccccc`n"
  $st = New-SyncState
  $diff = Add-LocalDiff $st (Read-LocalLists $d) '10:00'
  Assert-Eq $diff.Count 5   # project + 3 tasks + notifyAt
  $projId = @($st.Files.Keys)[0]; Assert-Eq $st.Files[$projId] 'Work'
  $c = Get-Change $st 'task' 'bbbbbbbb'
  Assert-Eq $c.fields.place.v.parent 'aaaaaaaa'; Assert-Eq $c.fields.status.v 'x'; Assert-Eq $c.fields.place.base -1
  $p1 = (Get-Change $st 'task' 'aaaaaaaa').fields.place.v.pos; $p2 = (Get-Change $st 'task' 'cccccccc').fields.place.v.pos
  Assert-True ([string]::CompareOrdinal($p1, $p2) -lt 0) "order $p1 < $p2"
  Assert-Eq (Get-Change $st 'task' 'cccccccc').fields.due.v.time '14:00'
  # nothing new on a second diff
  $st.Outbox.Clear()
  $diff2 = Add-LocalDiff $st (Read-LocalLists $d) '10:00'
  Assert-Eq $diff2.Count 0
}
Test-Case 'values longer than the server accepts are capped, not bounced' {
  $d = New-TempLists
  $long = 'x' * 12000
  Write-List $d 'Work' ("- [ ] $long ^aaaaaaaa`n  > " + ('n' * 60000) + "`n")
  $st = New-SyncState
  [void](Add-LocalDiff $st (Read-LocalLists $d) '')
  $c = Get-Change $st 'task' 'aaaaaaaa'
  Assert-Eq $c.fields.text.v.Length 10000
  Assert-Eq $c.fields.notes.v.Length 50000
}
Test-Case 'edits become field changes with the base timestamp' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'one' ' ' 111), (New-TaskRow 'bbbbbbbb' 'proj0001' $null 'a1' 'two')) @{ proj0001 = 'Work' }
  Write-List $d 'Work' "- [x] one edited ^aaaaaaaa`n  > new note`n- [ ] two due:2026-11-01 ^bbbbbbbb`n"
  $diff = Add-LocalDiff $st (Read-LocalLists $d) ''
  $a = Get-Change $st 'task' 'aaaaaaaa'
  Assert-Eq (@($a.fields.Keys) | Sort-Object) @('notes', 'status', 'text')
  Assert-Eq $a.fields.text.base 111; Assert-Eq $a.fields.text.v 'one edited'; Assert-Eq $a.fields.notes.v 'new note'
  Assert-Eq (Get-Change $st 'task' 'bbbbbbbb').fields.due.v.date '2026-11-01'
  Assert-Eq (Get-Field $st.S['task:aaaaaaaa'] 'text').v 'one edited'
}
Test-Case 'moving one task only re-keys that task; indenting changes its parent' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A'), (New-TaskRow 'bbbbbbbb' 'proj0001' $null 'a1' 'B'), (New-TaskRow 'cccccccc' 'proj0001' $null 'a2' 'C')) @{ proj0001 = 'Work' }
  Write-List $d 'Work' "- [ ] C ^cccccccc`n- [ ] A ^aaaaaaaa`n  - [ ] B ^bbbbbbbb`n"
  [void](Add-LocalDiff $st (Read-LocalLists $d) '')
  Assert-Eq $st.Outbox.Count 2   # one root re-keyed (A or C) + B's new parent
  $posA = (Get-Field $st.S['task:aaaaaaaa'] 'place').v.pos; $posC = (Get-Field $st.S['task:cccccccc'] 'place').v.pos
  Assert-True ([string]::CompareOrdinal($posC, $posA) -lt 0) "C ($posC) before A ($posA)"
  $b = Get-Change $st 'task' 'bbbbbbbb'; Assert-Eq $b.fields.place.v.parent 'aaaaaaaa'
}
Test-Case 'deleted lines become deletes; a busy or unstamped list defers all deletes' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-ProjectRow 'proj0002' 'Home' 'a1'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A'), (New-TaskRow 'bbbbbbbb' 'proj0001' $null 'a1' 'B')) @{ proj0001 = 'Work'; proj0002 = 'Home' }
  Write-List $d 'Work' "- [ ] A ^aaaaaaaa`n"
  Write-List $d 'Home' "- [ ] hand typed`n"           # no id yet
  "Work`nHome`n" | Set-Content -LiteralPath (Join-Path $d '.order') -NoNewline
  $diff = Add-LocalDiff $st (Read-LocalLists $d) ''
  Assert-True $diff.Skipped 'skipped'; Assert-Eq $diff.Stamp.Count 1 'stamp plans'; Assert-Eq $diff.Deletes 0 'deletes while skipped'
  # once stamped, the delete goes out
  [void](Invoke-PlanOps $diff.Stamp $d)
  [IO.File]::SetLastWriteTimeUtc((Join-Path $d 'Home.md'), [DateTime]::UtcNow.AddSeconds(-10))
  $diff2 = Add-LocalDiff $st (Read-LocalLists $d) ''
  Assert-Eq $diff2.Deletes 1 'deletes after stamping'
  Assert-Eq (Get-Change $st 'task' 'bbbbbbbb').fields.deleted.v $true
  Write-List $d 'Work' "- [ ] A edited ^aaaaaaaa`n" 0   # just written: busy
  $diff3 = Add-LocalDiff $st (Read-LocalLists $d) ''
  Assert-True $diff3.Skipped 'busy file skipped'
}
Test-Case 'a list emptied all at once pauses deletes until allowed' {
  $d = New-TempLists
  $rows = @((New-ProjectRow 'proj0001' 'Work'))
  for ($i = 0; $i -lt 30; $i++) { $rows += (New-TaskRow ('t{0:d7}' -f $i) 'proj0001' $null ('a' + $i) "task $i") }
  $st = New-SyncedState $rows @{ proj0001 = 'Work' }
  Write-List $d 'Work' ''
  $diff = Add-LocalDiff $st (Read-LocalLists $d) ''
  Assert-Eq $diff.Guarded 30; Assert-Eq $diff.Deletes 0
  $diff2 = Add-LocalDiff $st (Read-LocalLists $d) '' -AllowMassDelete
  Assert-Eq $diff2.Deletes 30
}
Test-Case 'renamed and deleted list files' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-ProjectRow 'proj0002' 'Home' 'a1'), (New-ProjectRow 'proj0003' 'Old' 'a2'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A'), (New-TaskRow 'bbbbbbbb' 'proj0003' $null 'a0' 'B')) @{ proj0001 = 'Work'; proj0002 = 'Home'; proj0003 = 'Old' }
  Write-List $d 'Office' "- [ ] A ^aaaaaaaa`n"   # Work renamed to Office
  Write-List $d 'Home' ''
  "Office`nHome`n" | Set-Content -LiteralPath (Join-Path $d '.order') -NoNewline
  $diff = Add-LocalDiff $st (Read-LocalLists $d) ''
  Assert-Eq (Get-Change $st 'project' 'proj0001').fields.name.v 'Office'
  Assert-Eq $st.Files['proj0001'] 'Office'
  Assert-True ($null -eq (Get-Change $st 'project' 'proj0003')) 'a list gone for a moment is no delete yet'
  Assert-True $diff.Skipped 'nothing else is decided meanwhile'
  [void](Add-LocalDiff $st (Read-LocalLists $d) '' -Clock ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 11000))
  Assert-Eq (Get-Change $st 'project' 'proj0003').fields.deleted.v $true   # gone for two cycles and 10 seconds
  Assert-True ($null -eq (Get-Change $st 'task' 'bbbbbbbb')) 'tasks of a deleted list are not deleted one by one'
}
Test-Case 'first sync adopts a server project with the same name' {
  $d = New-TempLists
  Write-List $d 'Work' "- [ ] A ^aaaaaaaa`n"
  $st = New-SyncState
  $st.R['project:servr001'] = New-ProjectRow 'servr001' 'Work'
  [void](Add-LocalDiff $st (Read-LocalLists $d) '')
  Assert-True ($null -eq (Get-Change $st 'project' 'servr001')) 'no project create'
  Assert-Eq (Get-Change $st 'task' 'aaaaaaaa').fields.place.v.project 'servr001'
}

Write-Host 'remote -> files'
function Invoke-Plan($st, $d) {
  $plan = Get-RemotePlan $st (Read-LocalLists $d 0) $d
  Assert-True ($null -ne $plan) 'plan'
  Assert-Eq (Invoke-PlanOps $plan.Ops $d) $plan.Ops.Count 'ops done'
  foreach ($k in @($plan.Files.Keys)) { if ($null -eq $plan.Files[$k]) { [void]$st.Files.Remove($k) } else { $st.Files[$k] = $plan.Files[$k] } }
  foreach ($k in @($st.R.Keys)) { $st.S[$k] = Copy-Row $st.R[$k] }
  return $plan
}
function Read-List($d, $name) { return [IO.File]::ReadAllText((Join-Path $d "$name.md")) }

Test-Case 'remote edits rewrite only their lines and keep everything else' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A'), (New-TaskRow 'bbbbbbbb' 'proj0001' 'aaaaaaaa' 'a0' 'B')) @{ proj0001 = 'Work' }
  Write-List $d 'Work' "# Work`nintro line`n- [ ] A ^aaaaaaaa`n  - [ ] B ^bbbbbbbb`n`n## Done`n"
  $st.R['task:aaaaaaaa'].fields.text = @{ v = 'A from phone'; ts = 200 }
  $st.R['task:aaaaaaaa'].fields.due = @{ v = @{ date = '2026-10-30'; time = '8:00' }; ts = 200 }
  $st.R['task:bbbbbbbb'].fields.status = @{ v = '>'; ts = 200 }
  $st.R['task:bbbbbbbb'].fields.notes = @{ v = "line 1`nline 2"; ts = 200 }
  [void](Invoke-Plan $st $d)
  Assert-Eq (Read-List $d 'Work') "# Work`nintro line`n- [ ] A from phone due:2026-10-30T8:00 ^aaaaaaaa`n  - [>] B ^bbbbbbbb`n    > line 1`n    > line 2`n`n## Done`n"
}
Test-Case 'remote delete removes the line and lifts its subtasks' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A'), (New-TaskRow 'bbbbbbbb' 'proj0001' 'aaaaaaaa' 'a0' 'B'), (New-TaskRow 'cccccccc' 'proj0001' $null 'a1' 'C')) @{ proj0001 = 'Work' }
  Write-List $d 'Work' "- [ ] A ^aaaaaaaa`n  - [ ] B ^bbbbbbbb`n- [ ] C ^cccccccc`n"
  $st.R['task:aaaaaaaa'].fields.deleted = @{ v = $true; ts = 200 }
  [void](Invoke-Plan $st $d)
  Assert-Eq (Read-List $d 'Work') "- [ ] B ^bbbbbbbb`n- [ ] C ^cccccccc`n"
}
Test-Case 'remote new tasks land at their position, under their parent' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A'), (New-TaskRow 'cccccccc' 'proj0001' $null 'a2' 'C')) @{ proj0001 = 'Work' }
  Write-List $d 'Work' "# Work`n- [ ] A ^aaaaaaaa`n- [ ] C ^cccccccc`n`n"
  $st.R['task:bbbbbbbb'] = New-TaskRow 'bbbbbbbb' 'proj0001' $null 'a1' 'B new' ' ' 200
  $st.R['task:dddddddd'] = New-TaskRow 'dddddddd' 'proj0001' 'bbbbbbbb' 'a0' 'D under B' ' ' 200
  $st.R['task:eeeeeeee'] = New-TaskRow 'eeeeeeee' 'proj0001' $null 'a3' 'E last' ' ' 200
  [void](Invoke-Plan $st $d)
  Assert-Eq (Read-List $d 'Work') "# Work`n- [ ] A ^aaaaaaaa`n- [ ] B new ^bbbbbbbb`n  - [ ] D under B ^dddddddd`n- [ ] C ^cccccccc`n- [ ] E last ^eeeeeeee`n`n"
}
Test-Case 'remote reorder and move to another list (with subtasks)' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-ProjectRow 'proj0002' 'Home' 'a1'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A'), (New-TaskRow 'bbbbbbbb' 'proj0001' $null 'a1' 'B'), (New-TaskRow 'cccccccc' 'proj0001' 'bbbbbbbb' 'a0' 'C'), (New-TaskRow 'hhhhhhhh' 'proj0002' $null 'a0' 'H')) @{ proj0001 = 'Work'; proj0002 = 'Home' }
  Write-List $d 'Work' "- [ ] A ^aaaaaaaa`n- [ ] B ^bbbbbbbb`n  - [ ] C ^cccccccc`n"
  Write-List $d 'Home' "- [ ] H ^hhhhhhhh`n"
  "Work`nHome`n" | Set-Content -LiteralPath (Join-Path $d '.order') -NoNewline
  $st.R['task:aaaaaaaa'].fields.place = @{ v = @{ project = 'proj0001'; parent = $null; pos = 'a2' }; ts = 200 }
  [void](Invoke-Plan $st $d)
  Assert-Eq (Read-List $d 'Work') "- [ ] B ^bbbbbbbb`n  - [ ] C ^cccccccc`n- [ ] A ^aaaaaaaa`n"
  $st.R['task:bbbbbbbb'].fields.place = @{ v = @{ project = 'proj0002'; parent = $null; pos = 'Zz' }; ts = 300 }
  $st.R['task:cccccccc'].fields.place = @{ v = @{ project = 'proj0002'; parent = 'bbbbbbbb'; pos = 'a0' }; ts = 300 }
  [void](Invoke-Plan $st $d)
  Assert-Eq (Read-List $d 'Work') "- [ ] A ^aaaaaaaa`n"
  Assert-Eq (Read-List $d 'Home') "- [ ] B ^bbbbbbbb`n  - [ ] C ^cccccccc`n- [ ] H ^hhhhhhhh`n"
}
Test-Case 'remote project create, rename, reorder and delete' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work' 'a0'), (New-ProjectRow 'proj0002' 'Home' 'a1'), (New-TaskRow 'hhhhhhhh' 'proj0002' $null 'a0' 'H')) @{ proj0001 = 'Work'; proj0002 = 'Home' }
  Write-List $d 'Work' ''
  Write-List $d 'Home' "- [ ] H ^hhhhhhhh`n"
  "Work`nHome`n" | Set-Content -LiteralPath (Join-Path $d '.order') -NoNewline
  $st.R['project:proj0003'] = New-ProjectRow 'proj0003' 'Trip: Rome/Paris' 'Zz'
  $st.R['task:tttttttt'] = New-TaskRow 'tttttttt' 'proj0003' $null 'a0' 'pack'
  $st.R['project:proj0001'].fields.name = @{ v = 'Office'; ts = 200 }
  [void](Invoke-Plan $st $d)
  Assert-Eq ((Get-ProjectFileNames $d) -join ',') 'Trip RomeParis,Office,Home'
  Assert-Eq (Read-List $d 'Trip RomeParis') "- [ ] pack ^tttttttt`n"
  # the sanitized file name maps back to the same project without renaming it on the server
  $diff = Add-LocalDiff $st (Read-LocalLists $d) ''
  Assert-Eq $diff.Count 0
  $st.R['project:proj0002'].fields.deleted = @{ v = $true; ts = 300 }
  [void](Invoke-Plan $st $d)
  Assert-Eq ((Get-ProjectFileNames $d) -join ',') 'Trip RomeParis,Office'
  Assert-True (@(Get-ChildItem (Join-Path $d '.trash') -Filter 'Home-*.md').Count -eq 1) 'trashed, not erased'
}
Test-Case 'remote moves, inserts, reorders and deletes always reproduce the server tree (randomized)' {
  $rnd = New-Object System.Random 7
  function Get-Kids($rows, $parent) {
    $list = @($rows.Values | Where-Object { $_.kind -eq 'task' -and -not $_.fields.deleted.v -and "$($_.fields.place.v.parent)" -eq "$parent" })
    $sorted = Sort-Ordinal $list { param($x) "$($x.fields.place.v.pos) $($x.id)" }
    return $sorted
  }
  function Get-Descendants($rows, $id) {
    $out = @{}; $todo = New-Object System.Collections.Queue; $todo.Enqueue($id)
    while ($todo.Count) { $p = $todo.Dequeue(); foreach ($r in $rows.Values) { if ($r.kind -eq 'task' -and $r.fields.place.v.parent -ceq $p -and -not $out.ContainsKey($r.id)) { $out[$r.id] = $true; $todo.Enqueue($r.id) } } }
    return $out
  }
  function Set-RandomPlace($rows, $id, $parent) {
    $kids = @(Get-Kids $rows $parent | Where-Object { $_.id -cne $id })
    $at = $rnd.Next(0, $kids.Count + 1)
    $lo = $(if ($at -gt 0) { [string]$kids[$at - 1].fields.place.v.pos } else { $null })
    $hi = $(if ($at -lt $kids.Count) { [string]$kids[$at].fields.place.v.pos } else { $null })
    if ($null -ne $lo -and $null -ne $hi -and [string]::CompareOrdinal($lo, $hi) -ge 0) { $hi = $null; $lo = [string]$kids[$kids.Count - 1].fields.place.v.pos }
    return (Get-KeyBetween $lo $hi)
  }
  function Get-TreeText($rows, $parent, $depth) {
    $sb = ''
    foreach ($k in (Get-Kids $rows $parent)) { $sb += ('  ' * $depth) + $k.fields.text.v + "`n" + (Get-TreeText $rows $k.id ($depth + 1)) }
    return $sb
  }
  for ($round = 0; $round -lt 25; $round++) {
    $d = New-TempLists
    $rows = @{ 'project:proj0001' = (New-ProjectRow 'proj0001' 'Work') }
    $ids = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt 12; $i++) {
      $id = 't{0:d3}{1:d4}' -f $round, $i
      $parent = $(if ($ids.Count -and $rnd.Next(3) -eq 0) { $ids[$rnd.Next($ids.Count)] } else { $null })
      $row = New-TaskRow $id 'proj0001' $parent 'a0' "task $i"
      $rows["task:$id"] = $row
      $row.fields.place.v.pos = Set-RandomPlace $rows $id $parent
      [void]$ids.Add($id)
    }
    $st = New-SyncState
    foreach ($k in $rows.Keys) { $st.S[$k] = Copy-Row $rows[$k]; $st.R[$k] = Copy-Row $rows[$k] }
    $st.Files['proj0001'] = 'Work'
    Write-List $d 'Work' (New-ListFromRows $st 'proj0001' (Get-RowDepthMap $st 'proj0001'))
    # the server side changes: moves (never into the own subtree), reorders, new tasks, subtree deletes
    $R = @{}; foreach ($k in $st.R.Keys) { $R[$k] = Copy-Row $st.R[$k] }
    for ($m = 0; $m -lt 6; $m++) {
      $live = @($R.Values | Where-Object { $_.kind -eq 'task' -and -not $_.fields.deleted.v })
      $op = $rnd.Next(4)
      if ($op -eq 0) {
        $id = 'n{0:d3}{1:d4}' -f $round, $m
        $parent = $(if ($rnd.Next(2)) { $live[$rnd.Next($live.Count)].id } else { $null })
        $row = New-TaskRow $id 'proj0001' $parent 'a0' "new $m" ' ' 200
        $R["task:$id"] = $row; $row.fields.place.v.pos = Set-RandomPlace $R $id $parent
      } elseif ($op -eq 3 -and $live.Count -gt 3) {
        $t = $live[$rnd.Next($live.Count)]
        $t.fields.deleted = @{ v = $true; ts = 200 }
        foreach ($k in (Get-Descendants $R $t.id).Keys) { $R["task:$k"].fields.deleted = @{ v = $true; ts = 200 } }
      } else {
        $t = $live[$rnd.Next($live.Count)]
        $desc = Get-Descendants $R $t.id
        $cands = @($live | Where-Object { $_.id -cne $t.id -and -not $desc.ContainsKey($_.id) })
        $parent = $(if ($op -eq 1 -and $cands.Count) { $cands[$rnd.Next($cands.Count)].id } else { $t.fields.place.v.parent })
        $pos = Set-RandomPlace $R $t.id $parent
        $t.fields.place = @{ v = @{ project = 'proj0001'; parent = $parent; pos = $pos }; ts = 200 }
      }
    }
    $st.R = $R
    [void](Invoke-Plan $st $d)
    # what the file says, as an indented outline of texts, must equal the server's tree
    $items = Read-Items (Read-List $d 'Work')
    $got = ''; $stack = New-Object System.Collections.ArrayList
    foreach ($it in $items) { if ($it.Kind -eq 'task') { $got += ('  ' * $it.Level) + $it.Text + "`n" } }
    $want = Get-TreeText $R $null 0
    Assert-Eq $got $want "round $round"
  }
}
Test-Case 'a stale plan is refused as a whole' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A')) @{ proj0001 = 'Work' }
  Write-List $d 'Work' "- [ ] A ^aaaaaaaa`n"
  $st.R['task:aaaaaaaa'].fields.text = @{ v = 'remote'; ts = 200 }
  $plan = Get-RemotePlan $st (Read-LocalLists $d 0) $d
  Write-List $d 'Work' "- [ ] A typed meanwhile ^aaaaaaaa`n"
  Assert-Eq (Invoke-PlanOps $plan.Ops $d) -1
  Assert-Eq (Read-List $d 'Work') "- [ ] A typed meanwhile ^aaaaaaaa`n"
}
Test-Case 'a list deleted elsewhere stays when it changed while the plan waited' {
  $d = New-TempLists
  $st = New-SyncedState @((New-ProjectRow 'proj0001' 'Work'), (New-ProjectRow 'proj0002' 'Old' 'a1'), (New-TaskRow 'aaaaaaaa' 'proj0001' $null 'a0' 'A'), (New-TaskRow 'oooooooo' 'proj0002' $null 'a0' 'O')) @{ proj0001 = 'Work'; proj0002 = 'Old' }
  Write-List $d 'Work' "- [ ] A ^aaaaaaaa`n"
  Write-List $d 'Old' "- [ ] O ^oooooooo`n"
  $st.R['project:proj0002'].fields.deleted = @{ v = $true; ts = 200 }
  $plan = Get-RemotePlan $st (Read-LocalLists $d 0) $d
  Assert-True (@($plan.Ops | Where-Object { $_.type -eq 'trash' }).Count -eq 1) 'the plan trashes Old'
  Write-List $d 'Old' "- [ ] O ^oooooooo`n- [ ] typed meanwhile`n"
  Assert-Eq (Invoke-PlanOps $plan.Ops $d) -1
  Assert-True (-not (Test-Path (Join-Path $d '.trash'))) 'nothing went to .trash'
}

Write-Host 'moving tasks in a list (drag and drop, Alt+Up / Alt+Down)'
$MoveBase = "# Work`n- [ ] A ^aaaaaaaa`n  - [ ] A1 ^a1a1a1a1`n  - [ ] A2 ^a2a2a2a2`n- [ ] B ^bbbbbbbb`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n`n## Later`n- [>] D ^dddddddd`n"
function Find-Item($items, [string]$id) { return @($items | Where-Object { $_.Id -ceq $id })[0] }
function Test-Move([string]$id, [string]$beforeId, [bool]$atEnd = $false) {
  $items = Read-Items $MoveBase
  $target = $(if ($beforeId) { Find-Item $items $beforeId } else { $null })
  $ok = Move-ListBlock $items (Find-Item $items $id) $target $atEnd
  return @{ Ok = $ok; Text = (ConvertTo-MarkdownText $items) }
}
Test-Case 'a task moves with its subtasks to just before the drop target' {
  $r = Test-Move 'aaaaaaaa' 'cccccccc'
  Assert-True $r.Ok 'moved'
  Assert-Eq $r.Text "# Work`n- [ ] B ^bbbbbbbb`n- [ ] A ^aaaaaaaa`n  - [ ] A1 ^a1a1a1a1`n  - [ ] A2 ^a2a2a2a2`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n`n## Later`n- [>] D ^dddddddd`n"
  $r = Test-Move 'cccccccc' 'aaaaaaaa'   # upwards, past a task with subtasks
  Assert-Eq $r.Text "# Work`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n- [ ] A ^aaaaaaaa`n  - [ ] A1 ^a1a1a1a1`n  - [ ] A2 ^a2a2a2a2`n- [ ] B ^bbbbbbbb`n`n## Later`n- [>] D ^dddddddd`n"
}
Test-Case 'dropped among subtasks it becomes one; dropped among top-level tasks a subtask leaves its parent' {
  Assert-Eq (Test-Move 'bbbbbbbb' 'a2a2a2a2').Text "# Work`n- [ ] A ^aaaaaaaa`n  - [ ] A1 ^a1a1a1a1`n  - [ ] B ^bbbbbbbb`n  - [ ] A2 ^a2a2a2a2`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n`n## Later`n- [>] D ^dddddddd`n"
  Assert-Eq (Test-Move 'cccccccc' 'a1a1a1a1').Text "# Work`n- [ ] A ^aaaaaaaa`n  - [ ] C ^cccccccc`n    - [ ] C1 ^c1c1c1c1`n  - [ ] A1 ^a1a1a1a1`n  - [ ] A2 ^a2a2a2a2`n- [ ] B ^bbbbbbbb`n`n## Later`n- [>] D ^dddddddd`n"
  Assert-Eq (Test-Move 'a2a2a2a2' 'cccccccc').Text "# Work`n- [ ] A ^aaaaaaaa`n  - [ ] A1 ^a1a1a1a1`n- [ ] B ^bbbbbbbb`n- [ ] A2 ^a2a2a2a2`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n`n## Later`n- [>] D ^dddddddd`n"
}
Test-Case 'dropped below the last task: to the end, at the top level, below sections' {
  Assert-Eq (Test-Move 'a1a1a1a1' $null $true).Text "# Work`n- [ ] A ^aaaaaaaa`n  - [ ] A2 ^a2a2a2a2`n- [ ] B ^bbbbbbbb`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n`n## Later`n- [>] D ^dddddddd`n- [ ] A1 ^a1a1a1a1`n"
  Assert-Eq (Test-Move 'aaaaaaaa' $null $true).Text "# Work`n- [ ] B ^bbbbbbbb`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n`n## Later`n- [>] D ^dddddddd`n- [ ] A ^aaaaaaaa`n  - [ ] A1 ^a1a1a1a1`n  - [ ] A2 ^a2a2a2a2`n"
}
Test-Case 'a drop that cannot be done changes nothing (onto itself, into its own subtasks, a target from another list)' {
  foreach ($case in @(@('aaaaaaaa', 'aaaaaaaa'), @('aaaaaaaa', 'a1a1a1a1'), @('aaaaaaaa', 'a2a2a2a2'))) {
    $r = Test-Move $case[0] $case[1]
    Assert-True (-not $r.Ok) "$($case -join ' before ')"; Assert-Eq $r.Text $MoveBase
  }
  $items = Read-Items $MoveBase
  $stale = (Read-Items $MoveBase)[4]   # the same task, but from another read: not in this list
  Assert-True (-not (Move-ListBlock $items $items[1] $stale $false)) 'stale target'
  Assert-True (-not (Move-ListBlock $items $stale $items[1] $false)) 'stale task'
  Assert-True (-not (Move-ListBlock $items $items[0] $items[1] $false)) 'a heading is not a task'
  Assert-Eq (ConvertTo-MarkdownText $items) $MoveBase
}
Test-Case 'Alt+Up / Alt+Down swap with the sibling and its subtasks, and stop at the ends' {
  $items = Read-Items $MoveBase
  Assert-True (Step-ListBlock $items (Find-Item $items 'bbbbbbbb') -1) 'B up'
  Assert-Eq (ConvertTo-MarkdownText $items) "# Work`n- [ ] B ^bbbbbbbb`n- [ ] A ^aaaaaaaa`n  - [ ] A1 ^a1a1a1a1`n  - [ ] A2 ^a2a2a2a2`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n`n## Later`n- [>] D ^dddddddd`n"
  Assert-True (Step-ListBlock $items (Find-Item $items 'aaaaaaaa') 1) 'A down'
  Assert-Eq (ConvertTo-MarkdownText $items) "# Work`n- [ ] B ^bbbbbbbb`n- [ ] C ^cccccccc`n  - [ ] C1 ^c1c1c1c1`n- [ ] A ^aaaaaaaa`n  - [ ] A1 ^a1a1a1a1`n  - [ ] A2 ^a2a2a2a2`n`n## Later`n- [>] D ^dddddddd`n"
  Assert-True (Step-ListBlock $items (Find-Item $items 'a2a2a2a2') -1) 'A2 up'
  $before = ConvertTo-MarkdownText $items
  foreach ($c in @(@('bbbbbbbb', -1), @('a2a2a2a2', -1), @('a1a1a1a1', 1), @('aaaaaaaa', 1), @('c1c1c1c1', 1), @('dddddddd', -1))) {
    Assert-True (-not (Step-ListBlock $items (Find-Item $items $c[0]) $c[1])) "$($c -join ' ') stops"
  }
  Assert-Eq (ConvertTo-MarkdownText $items) $before
}

# a list with headings, prose, notes, blank lines, three levels and closed / postponed tasks
$RandomList = "---`ntitle: x`n---`n# Mixed`nIntro line`n- [ ] t01 ^taaaaa01`n  > a note`n  - [ ] t02 ^taaaaa02`n    - [x] t03 ^taaaaa03`n    - [ ] t04 ^taaaaa04`n  - [/] t05 ^taaaaa05`n- [>] t06 ^taaaaa06`n`n## Section`n- [!] t07 ^taaaaa07`n  - [ ] t08 ^taaaaa08`n- [-] t09 ^taaaaa09`n- [~] t10 ^taaaaa10`n  > note 1`n  > note 2`n  - [ ] t11 ^taaaaa11`n- [ ] t12 due:2026-10-20T9:00 ^taaaaa12`n`ntrailing prose`n"
function Invoke-RandomMove($items, $rng) {
  $tasks = @($items | Where-Object { $_.Kind -eq 'task' })
  $a = $tasks[$rng.Next($tasks.Count)]
  switch ($rng.Next(5)) {
    0 { return (Move-ListBlock $items $a $tasks[$rng.Next($tasks.Count)] $false) }
    1 { return (Move-ListBlock $items $a $items[$rng.Next($items.Count)] $false) }   # any row, headings too
    2 { return (Move-ListBlock $items $a $null $true) }
    3 { return (Step-ListBlock $items $a -1) }
    default { return (Step-ListBlock $items $a 1) }
  }
}
function Get-Fingerprint($items) {   # every task by id: its text, status, deadline and notes
  return (@($items | Where-Object { $_.Kind -eq 'task' } | ForEach-Object { "$($_.Id)=$($_.Mark)|$($_.Text)|$($_.Due)T$($_.DueTime)|$($_.Notes)" } | Sort-Object) -join "`n")
}
Test-Case 'thousands of random drags and nudges keep every task with its text, status, deadline and notes' {
  $items = Read-Items $RandomList
  $raws = @($items | Where-Object { $_.Kind -eq 'raw' } | ForEach-Object { $_.Raw }) -join "`n"
  $want = Get-Fingerprint $items
  $rng = New-Object System.Random 20261019
  $moved = 0
  for ($k = 1; $k -le 2000; $k++) {
    $n = $items.Count
    if (Invoke-RandomMove $items $rng) { $moved++ }
    if ($items.Count -ne $n) { throw "move $k changed the number of items" }
    if ($k % 50 -eq 0) {
      $back = Read-Items (ConvertTo-MarkdownText $items)   # also as written to the file and read again
      Assert-Eq (Get-Fingerprint $back) $want "after $k moves"
      Assert-Eq (@($back | Where-Object { $_.Kind -eq 'raw' } | ForEach-Object { $_.Raw }) -join "`n") $raws 'headings and prose stay'
    }
  }
  Assert-True ($moved -gt 1000) "most moves happen ($moved)"
}

# what the server does with the changes: they become the synced rows
function Confirm-Outbox($st) {
  foreach ($c in @($st.Outbox)) {
    $k = "$($c['kind']):$($c['id'])"
    if (-not $st.R.ContainsKey($k)) { $st.R[$k] = New-EmptyRow $c['kind'] $c['id'] }
    foreach ($f in @($c['fields'].Keys)) { $st.R[$k]['fields'][$f] = @{ v = $c['fields'][$f]['v']; ts = [long]$c['fields'][$f]['ts'] } }
    $st.S[$k] = Copy-Row $st.R[$k]
  }
  $st.Outbox.Clear()
}
Test-Case 'moving tasks around reaches the server as new places, never as deletes' {
  $d = New-TempLists
  Write-List $d 'Mixed' $RandomList
  $st = New-SyncState
  [void](Add-LocalDiff $st (Read-LocalLists $d 0) '' -Clock 1000)
  Confirm-Outbox $st
  $rng = New-Object System.Random 7
  for ($round = 1; $round -le 8; $round++) {
    $items = Read-Items (Read-List $d 'Mixed')
    for ($k = 0; $k -lt 6; $k++) { [void](Invoke-RandomMove $items $rng) }
    Write-List $d 'Mixed' (ConvertTo-MarkdownText $items)
    $diff = Add-LocalDiff $st (Read-LocalLists $d 0) '' -Clock (1000 + 1000 * $round)
    Assert-Eq $diff.Deletes 0 "round $round deletes"
    foreach ($c in $st.Outbox) {
      Assert-Eq $c['kind'] 'task' "round $round"
      Assert-Eq (@($c['fields'].Keys) -join ',') 'place' "round $round, $($c['id']): only its place changes"
    }
    Confirm-Outbox $st
  }
  $live = @($st.R.Values | Where-Object { $_['kind'] -eq 'task' -and -not (Get-Field $_ 'deleted')['v'] })
  Assert-Eq $live.Count 12 'all twelve tasks live on the server'
}

Write-Host 'reading files'
Test-Case 'a list in a legacy code page or UTF-16 is read as written' {
  $d = New-TempLists
  $p = Join-Path $d 'Ansi.md'
  [IO.File]::WriteAllBytes($p, [Text.Encoding]::Default.GetBytes("# Caf$([char]0xE9)`n- [ ] R$([char]0xE9)sum$([char]0xE9) ^aaaaaaaa`n"))
  Assert-Eq (Read-TextFile $p) "# Caf$([char]0xE9)`n- [ ] R$([char]0xE9)sum$([char]0xE9) ^aaaaaaaa`n" 'system code page'
  $geo = -join [char[]](0x10D1, 0x10D8, 0x10E3, 0x10EF, 0x10D4, 0x10E2, 0x10D8)   # Georgian (this file has no BOM)
  [IO.File]::WriteAllText($p, "- [ ] $geo ^aaaaaaaa`n", [Text.Encoding]::Unicode)   # what Out-File writes in Windows PowerShell
  Assert-Eq (Read-TextFile $p) "- [ ] $geo ^aaaaaaaa`n" 'UTF-16 with a byte order mark'
  [IO.File]::WriteAllText($p, "- [ ] $geo ^aaaaaaaa`n", (New-Object System.Text.UTF8Encoding($true)))
  Assert-Eq (Read-TextFile $p) "- [ ] $geo ^aaaaaaaa`n" 'UTF-8 with a byte order mark'
}
Test-Case 'a save never overwrites a list another program holds or changed meanwhile' {
  $d = New-TempLists
  $p = Join-Path $d 'Work.md'
  [IO.File]::WriteAllText($p, "- [ ] A ^aaaaaaaa`n")
  Assert-True (Write-TextFileIfUnchanged $p "- [ ] A edited ^aaaaaaaa`n" "- [ ] A ^aaaaaaaa`n") 'unchanged: written'
  Assert-True (-not (Write-TextFileIfUnchanged $p "- [ ] mine ^aaaaaaaa`n" "- [ ] A ^aaaaaaaa`n")) 'changed meanwhile: not written'
  Assert-Eq (Read-TextFile $p) "- [ ] A edited ^aaaaaaaa`n"
  $fs = New-Object IO.FileStream($p, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)   # another program holds it
  try {
    Assert-True ($null -eq (Read-TextFile $p)) 'a held file cannot be read'
    Assert-True (-not (Write-TextFileIfUnchanged $p "- [ ] mine ^aaaaaaaa`n" "- [ ] A edited ^aaaaaaaa`n")) 'held: not written blind'
  } finally { $fs.Dispose() }
  Assert-Eq (Read-TextFile $p) "- [ ] A edited ^aaaaaaaa`n"
  Assert-True (-not (Write-TextFileIfUnchanged (Join-Path $d 'New.md') 'x' 'something')) 'a missing file is not "unchanged"'
  Assert-True (Write-TextFileIfUnchanged (Join-Path $d 'New.md') "- [ ] B`n" $null) 'expected $null: created'
  Assert-True (-not (Write-TextFileIfUnchanged (Join-Path $d 'New.md') 'x' $null)) '... but never over an existing file'
  Assert-True (@(Get-ChildItem -LiteralPath $d -Filter '*.tmp' -Force).Count -eq 0) 'no temp files left'
}
Test-Case 'a list with NUL characters (a write cut short by a power cut) is left alone' {
  $d = New-TempLists
  Write-List $d 'Work' "- [ ] A ^aaaaaaaa`n$([char]0)$([char]0)"
  Assert-Eq (Read-LocalLists $d).Files['Work'].Status 'error'
}

Write-Host ''
Write-Host ("{0} passed, {1} failed" -f $script:passed, $script:failed)
if ($script:failed) { exit 1 }
