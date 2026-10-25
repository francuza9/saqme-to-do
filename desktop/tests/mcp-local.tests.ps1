# Tests for Connect Claude Desktop on Windows: desktop/mcp-core.ps1 (the tools on the list files), desktop/mcp-server.ps1
# (stdio), desktop/claude-desktop.ps1 (Saqme in Claude Desktop's settings file). Windows PowerShell 5.1, no modules.
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\tests\mcp-local.tests.ps1
# Every folder here is a new one under %TEMP%: never %APPDATA%\SaqmeToDo, never the real Claude Desktop settings.
$ErrorActionPreference = 'Stop'
$desk = Join-Path $PSScriptRoot '..'
. (Join-Path $desk 'sync-core.ps1')
. (Join-Path $desk 'mcp-core.ps1')
. (Join-Path $desk 'claude-desktop.ps1')
$script:McpVersion = 'test'
$def = Read-McpDefinitions (Join-Path $desk 'mcp-tools.json')

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
function Assert-Match([string]$text, [string]$pattern, [string]$what = '') { if ($text -cnotmatch $pattern) { throw "$what <$text> does not match <$pattern>" } }

$tmpRoot = [IO.Path]::GetTempPath()
$made = New-Object System.Collections.ArrayList
function New-TempData {
  $d = Join-Path $tmpRoot ('saqme-mcp-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  [void](New-Item -ItemType Directory -Path (Join-Path $d 'lists'))
  [void]$made.Add($d)
  if (Test-InAppData $d) { throw "not a temp folder: $d" }
  return $d
}
function Write-List([string]$data, [string]$name, [string]$text) { [IO.File]::WriteAllText((Join-Path $data "lists\$name.md"), $text, $script:Utf8NoBom) }
function Read-List([string]$data, [string]$name) { return [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $data "lists\$name.md"))) }
function Get-ListFiles([string]$data) { return @([IO.Directory]::GetFiles((Join-Path $data 'lists'), '*.md') | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object) }
# a tool call as Claude Desktop makes it, through JSON-RPC: -> structuredContent, or @{ error = text }
$script:rpcId = 0
function Invoke-Tool($ctx, [string]$name, $arguments = @{}) {
  $line = ConvertTo-JsonText @{ jsonrpc = '2.0'; id = (++$script:rpcId); method = 'tools/call'; params = @{ name = $name; arguments = $arguments } }
  $r = ConvertFrom-JsonText (Invoke-McpMessage $ctx $def $line)
  if ($r['error']) { throw "rpc error: $($r['error']['message'])" }
  if ($r['result']['isError']) { return @{ error = [string]$r['result']['content'][0]['text'] } }
  return $r['result']['structuredContent']
}
function New-Fixture {
  $d = New-TempData
  Write-List $d 'Work' "# Work`r`nNotes for the list stay.`r`n- [ ] Write the report due:2026-10-20 ^aaaaaaaa`r`n  > a note`r`n  - [ ] Charts ^bbbbbbbb`r`n- [/] Call Anna due:2026-10-26T9:30 ^cccccccc`r`n`r`n## Later`r`n- [>] Clean up ^dddddddd`r`n- [x] Shipped ^eeeeeeee`r`n"
  Write-List $d 'Home' "# Home`n- [ ] Milk ^ffffffff`n"
  [IO.File]::WriteAllText((Join-Path $d 'lists\.order'), "Work`nHome`n")
  return $d
}

Write-Host 'JSON-RPC'
Test-Case 'initialize: the local instructions, the version asked for; tools/list is mcp-tools.json (the Worker''s shapes)' {
  $ctx = New-McpContext (New-TempData)
  $r = ConvertFrom-JsonText (Invoke-McpMessage $ctx $def '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}')
  Assert-Eq $r['result']['protocolVersion'] '2025-03-26'
  Assert-Match $r['result']['instructions'] 'kept on this computer'
  $r = ConvertFrom-JsonText (Invoke-McpMessage $ctx $def '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
  Assert-Eq (@($r['result']['tools'] | ForEach-Object { $_['name'] }) -join ',') 'today,get_lists,list_tasks,add_tasks,update_task,move_task,delete_task,restore_task,create_list'
  Assert-Eq (ConvertTo-JsonText $r['result']['tools']) (ConvertTo-JsonText $def['tools'])
}
Test-Case 'notifications get no answer; a parse error, an unknown tool and an unknown method do' {
  $ctx = New-McpContext (New-TempData)
  Assert-True ($null -eq (Invoke-McpMessage $ctx $def '{"jsonrpc":"2.0","method":"notifications/initialized"}')) 'notification'
  Assert-Eq (ConvertFrom-JsonText (Invoke-McpMessage $ctx $def '{nope'))['error']['code'] -32700
  Assert-Eq (ConvertFrom-JsonText (Invoke-McpMessage $ctx $def '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_list"}}'))['error']['code'] -32602
  Assert-Eq (ConvertFrom-JsonText (Invoke-McpMessage $ctx $def '{"jsonrpc":"2.0","id":4,"method":"sampling/x"}'))['error']['code'] -32601
}
Test-Case 'a refused context (no way out of a private copy of AppData): every tool says why, nothing is read or written' {
  $d = New-Fixture; $before = Read-List $d 'Work'
  $ctx = New-McpContext $d; $ctx.Refused = 'nope: private copy'
  Assert-Eq (Invoke-Tool $ctx 'get_lists').error 'nope: private copy'
  Assert-Eq (Invoke-Tool $ctx 'add_tasks' @{ list = 'Work'; tasks = @(@{ text = 'x' }) }).error 'nope: private copy'
  Assert-Eq (Read-List $d 'Work') $before
}

Write-Host 'reading'
Test-Case 'today: date, weekday, this week (Monday to Sunday)' {
  $ctx = New-McpContext (New-TempData) ([DateTime]::new(2026, 10, 25, 16, 5, 0))
  $t = Invoke-Tool $ctx 'today'
  Assert-Eq "$($t['date']) $($t['time']) $($t['weekday']) $($t['week_start']) $($t['week_end']) $($t['yesterday']) $($t['tomorrow'])" '2026-10-25 16:05 Sunday 2026-10-19 2026-10-25 2026-10-24 2026-10-26'
}
Test-Case 'get_lists: in the lists'' order, open / due / overdue counts; ids for tasks that had none are written' {
  $d = New-Fixture
  Write-List $d 'Home' "# Home`n- [ ] Milk ^ffffffff`n- [ ] Bread`n"
  $ctx = New-McpContext $d ([DateTime]::new(2026, 10, 25, 12, 0, 0))
  $r = Invoke-Tool $ctx 'get_lists'
  Assert-Eq (@($r['lists'] | ForEach-Object { "$($_['name']):$($_['open'])/$($_['due_today_or_earlier'])/$($_['overdue'])" }) -join ' ') 'Work:3/1/1 Home:2/0/0'
  Assert-Eq $r['lists'][0]['id'] 'Work'
  Assert-Match (Read-List $d 'Home') '- \[ \] Bread \^[0-9a-z]{8}\n$'
}
Test-Case 'list_tasks: subtasks after their parent with depth; filters by list, status, deadline, text' {
  $ctx = New-McpContext (New-Fixture)
  $all = Invoke-Tool $ctx 'list_tasks'
  Assert-Eq (@($all['tasks'] | ForEach-Object { "$($_['id'])@$($_['depth'])" }) -join ' ') 'aaaaaaaa@0 bbbbbbbb@1 cccccccc@0 dddddddd@0 ffffffff@0'
  $b = $all['tasks'][1]
  Assert-Eq "$($b['parent_id']) $($b['list']) $($b['status'])" 'aaaaaaaa Work todo'
  Assert-Eq $all['tasks'][0]['notes'] 'a note'
  Assert-Eq $all['tasks'][2]['due'] '2026-10-26T09:30'
  Assert-Eq (@((Invoke-Tool $ctx 'list_tasks' @{ status = 'closed' })['tasks'] | ForEach-Object { $_['id'] }) -join ' ') 'eeeeeeee'
  Assert-Eq (@((Invoke-Tool $ctx 'list_tasks' @{ status = @('in_progress', 'postponed') })['tasks'] | ForEach-Object { $_['id'] }) -join ' ') 'cccccccc dddddddd'
  Assert-Eq (@((Invoke-Tool $ctx 'list_tasks' @{ due_to = '2026-10-24'; status = 'open' })['tasks'] | ForEach-Object { $_['id'] }) -join ' ') 'aaaaaaaa'
  Assert-Eq (@((Invoke-Tool $ctx 'list_tasks' @{ list = 'home' })['tasks'] | ForEach-Object { $_['id'] }) -join ' ') 'ffffffff'
  Assert-Eq (@((Invoke-Tool $ctx 'list_tasks' @{ query = 'ANNA' })['tasks'] | ForEach-Object { $_['id'] }) -join ' ') 'cccccccc'
  Assert-Match (Invoke-Tool $ctx 'list_tasks' @{ list = 'Nope' }).error 'There is no list "Nope"\. The lists are: Work, Home\.'
  Assert-Match (Invoke-Tool $ctx 'list_tasks' @{ status = 'soon' }).error 'is not a status'
}

Write-Host 'writing'
Test-Case 'add_tasks: at the bottom of the top level, with subtasks, ids, deadline and notes; CRLF, headings and prose kept' {
  $d = New-Fixture; $ctx = New-McpContext $d
  $r = Invoke-Tool $ctx 'add_tasks' @{ list = 'Work'; tasks = @(@{ text = 'Book the room ქართული'; due = '2026-11-03T09:30'; notes = "line 1`nline 2"; subtasks = @(@{ text = 'Projector'; status = 'blocked' }) }) }
  Assert-Eq $r['added'] 2
  $id = $r['tasks'][0]['id']; $sub = $r['tasks'][0]['subtasks'][0]['id']
  Assert-Match $id '^[a-z][0-9a-z]{7}$'
  $t = Read-List $d 'Work'
  Assert-True $t.EndsWith("- [x] Shipped ^eeeeeeee`r`n- [ ] Book the room ქართული due:2026-11-03T9:30 ^$id`r`n  > line 1`r`n  > line 2`r`n  - [!] Projector ^$sub`r`n") "appended: $t"
  Assert-True $t.StartsWith("# Work`r`nNotes for the list stay.`r`n- [ ] Write the report due:2026-10-20 ^aaaaaaaa`r`n  > a note`r`n") 'the rest kept'
}
Test-Case 'add_tasks: top, after_id (after its subtasks), under parent_id; into an empty list' {
  $d = New-Fixture; $ctx = New-McpContext $d
  $top = (Invoke-Tool $ctx 'add_tasks' @{ list = 'Work'; position = 'top'; tasks = @(@{ text = 'First' }) })['tasks'][0]['id']
  $aft = (Invoke-Tool $ctx 'add_tasks' @{ after_id = 'aaaaaaaa'; tasks = @(@{ text = 'After report' }) })['tasks'][0]['id']
  $kid = (Invoke-Tool $ctx 'add_tasks' @{ parent_id = 'aaaaaaaa'; tasks = @(@{ text = 'Kid' }) })['tasks'][0]
  Assert-Eq $kid['parent_id'] 'aaaaaaaa'
  $t = Read-List $d 'Work'
  Assert-True $t.Contains("Notes for the list stay.`r`n- [ ] First ^$top`r`n- [ ] Write the report") 'top'
  Assert-True $t.Contains("  - [ ] Charts ^bbbbbbbb`r`n  - [ ] Kid ^$($kid['id'])`r`n- [ ] After report ^$aft`r`n- [/] Call Anna") "after_id and parent_id: $t"
  Write-List $d 'Empty' "# Empty`n`nJust a note.`n"
  [void](Invoke-Tool $ctx 'add_tasks' @{ list = 'Empty'; tasks = @(@{ text = 'One' }, @{ text = 'Two' }) })
  Assert-Match (Read-List $d 'Empty') '^# Empty\n\nJust a note\.\n- \[ \] One \^[0-9a-z]{8}\n- \[ \] Two \^[0-9a-z]{8}\n$'
}
Test-Case 'add_tasks: checked before anything is written (empty text, bad deadline, text ending in an id, too many)' {
  $d = New-Fixture; $ctx = New-McpContext $d; $before = Read-List $d 'Work'
  Assert-Match (Invoke-Tool $ctx 'add_tasks' @{ list = 'Work'; tasks = @(@{ text = 'ok' }, @{ text = '  ' }) }).error 'empty'
  Assert-Match (Invoke-Tool $ctx 'add_tasks' @{ list = 'Work'; tasks = @(@{ text = 'x'; due = '2026-02-30' }) }).error 'not a deadline'
  Assert-Match (Invoke-Tool $ctx 'add_tasks' @{ list = 'Work'; tasks = @(@{ text = 'call ^abcdefgh' }) }).error 'cannot end with'
  Assert-Match (Invoke-Tool $ctx 'add_tasks' @{ list = 'Work'; tasks = @(1..51 | ForEach-Object { @{ text = "t$_" } }) }).error 'At most 50'
  Assert-Match (Invoke-Tool $ctx 'add_tasks' @{ parent_id = 'zzzzzzzz'; tasks = @(@{ text = 'x' }) }).error 'no parent task with the id zzzzzzzz'
  Assert-Eq (Read-List $d 'Work') $before
}
Test-Case 'update_task: status, text, deadline (and removing it), notes; only what is given' {
  $d = New-Fixture; $ctx = New-McpContext $d
  $r = Invoke-Tool $ctx 'update_task' @{ id = 'cccccccc'; status = 'done'; due = $null }
  Assert-Eq "$($r['task']['status']) $($r['task']['due']) $($r['task']['text'])" 'done  Call Anna'
  [void](Invoke-Tool $ctx 'update_task' @{ id = 'aaaaaaaa'; text = 'Write the final report'; notes = '' })
  [void](Invoke-Tool $ctx 'update_task' @{ id = 'bbbbbbbb'; due = '2026-12-01' })
  $t = Read-List $d 'Work'
  Assert-True $t.Contains("- [ ] Write the final report due:2026-10-20 ^aaaaaaaa`r`n  - [ ] Charts due:2026-12-01 ^bbbbbbbb`r`n- [x] Call Anna ^cccccccc`r`n") $t
  Assert-Match (Invoke-Tool $ctx 'update_task' @{ id = 'aaaaaaaa' }).error 'Nothing to change'
  Assert-Match (Invoke-Tool $ctx 'update_task' @{ id = 'AAAA' }).error 'not a task id'
}
Test-Case 'move_task: with its subtasks to another list (ids kept), under another task, to the top; never into itself' {
  $d = New-Fixture; $ctx = New-McpContext $d
  $r = Invoke-Tool $ctx 'move_task' @{ id = 'aaaaaaaa'; list = 'Home' }
  Assert-Eq "$($r['moved']) $($r['task']['list'])" '2 Home'
  Assert-Eq (Read-List $d 'Home') "# Home`n- [ ] Milk ^ffffffff`n- [ ] Write the report due:2026-10-20 ^aaaaaaaa`n  > a note`n  - [ ] Charts ^bbbbbbbb`n"
  Assert-True (-not (Read-List $d 'Work').Contains('aaaaaaaa') -and -not (Read-List $d 'Work').Contains('bbbbbbbb')) 'gone from Work'
  [void](Invoke-Tool $ctx 'move_task' @{ id = 'ffffffff'; parent_id = 'aaaaaaaa' })
  Assert-Eq (Read-List $d 'Home') "# Home`n- [ ] Write the report due:2026-10-20 ^aaaaaaaa`n  > a note`n  - [ ] Charts ^bbbbbbbb`n  - [ ] Milk ^ffffffff`n"
  [void](Invoke-Tool $ctx 'move_task' @{ id = 'ffffffff'; parent_id = $null; position = 'top' })
  Assert-True (Read-List $d 'Home').StartsWith("# Home`n- [ ] Milk ^ffffffff`n- [ ] Write") 'top level, top'
  Assert-Match (Invoke-Tool $ctx 'move_task' @{ id = 'aaaaaaaa'; parent_id = 'bbbbbbbb' }).error 'cannot go under itself'
  Assert-Match (Invoke-Tool $ctx 'move_task' @{ id = 'dddddddd'; list = 'Home'; parent_id = 'cccccccc' }).error 'different lists'
}
Test-Case 'delete_task: into Recently deleted (the widget''s journal) with its subtasks, out of the file; restore_task puts it back' {
  $d = New-Fixture; $ctx = New-McpContext $d
  $r = Invoke-Tool $ctx 'delete_task' @{ id = 'aaaaaaaa' }
  Assert-Eq "$($r['deleted']) $(@($r['ids']) -join ',') $($r['list'])" '2 aaaaaaaa,bbbbbbbb Work'
  $t = Read-List $d 'Work'
  Assert-True (-not $t.Contains('aaaaaaaa') -and -not $t.Contains('a note') -and $t.Contains('^cccccccc')) $t
  $j = @(ConvertFrom-JsonText ([IO.File]::ReadAllText((Join-Path $d 'recently-deleted.json'))))
  Assert-Eq $j.Count 1
  Assert-Eq "$($j[0]['list'])|$($j[0]['first'])|$($j[0]['count'])|$(@($j[0]['ids']) -join ',')|$($j[0]['parent'])" 'Work|Write the report|2|aaaaaaaa,bbbbbbbb|'
  Assert-Eq $j[0]['text'] "- [ ] Write the report due:2026-10-20 ^aaaaaaaa`n  > a note`n  - [ ] Charts ^bbbbbbbb`n"
  Assert-True ($j[0]['key'] -and $j[0]['at'] -gt 0) 'key and time, as the widget writes them'
  $del = (Invoke-Tool $ctx 'list_tasks' @{ status = 'deleted' })['tasks']
  Assert-Eq "$(@($del).Count) $($del[0]['id']) $($del[0]['status']) $($del[0]['was']) $($del[0]['subtasks'])" '1 aaaaaaaa deleted todo 1'
  Assert-Match (Invoke-Tool $ctx 'update_task' @{ id = 'aaaaaaaa'; status = 'done' }).error 'is deleted \(restore_task'
  $back = Invoke-Tool $ctx 'restore_task' @{ id = 'aaaaaaaa' }
  Assert-Eq $back['restored'] 2
  Assert-True (Read-List $d 'Work').EndsWith("- [x] Shipped ^eeeeeeee`r`n- [ ] Write the report due:2026-10-20 ^aaaaaaaa`r`n  > a note`r`n  - [ ] Charts ^bbbbbbbb`r`n") 'back at the end, ids kept'
  Assert-Eq @(ConvertFrom-JsonText ([IO.File]::ReadAllText((Join-Path $d 'recently-deleted.json')))).Count 0
  Assert-Match (Invoke-Tool $ctx 'restore_task' @{ id = 'aaaaaaaa' }).error 'not deleted'
}
Test-Case 'delete_task: a subtask goes back under its parent; at most 25 an hour, more is left to the user' {
  $d = New-Fixture; $ctx = New-McpContext $d
  [void](Invoke-Tool $ctx 'delete_task' @{ id = 'bbbbbbbb' })
  [void](Invoke-Tool $ctx 'restore_task' @{ id = 'bbbbbbbb' })
  Assert-True (Read-List $d 'Work').Contains("  > a note`r`n  - [ ] Charts ^bbbbbbbb`r`n- [/] Call Anna") 'under its parent again'
  $lines = (1..30 | ForEach-Object { "- [ ] t$_ ^t$(([string]$_).PadLeft(7, '0'))" }) -join "`n"
  Write-List $d 'Many' "# Many`n$lines`n"
  $ok = 0
  foreach ($n in 1..30) { $r = Invoke-Tool $ctx 'delete_task' @{ id = "t$(([string]$n).PadLeft(7, '0'))" }; if (-not $r.error) { $ok++ } else { Assert-Match $r.error 'Not deleted: that is more than' } }
  Assert-Eq $ok 24 'the budget (one went on Charts above)'
  Assert-Eq (@((Read-Items (Read-List $d 'Many')) | Where-Object { $_.Kind -eq 'task' }).Count) 6
}
Test-Case 'create_list: a new file at the end of the order; an existing name or a device name is handled' {
  $d = New-Fixture; $ctx = New-McpContext $d
  Assert-Eq (Invoke-Tool $ctx 'create_list' @{ name = 'Trip: Berlin' })['list']['name'] 'Trip Berlin'
  Assert-Eq (Read-List $d 'Trip Berlin') "# Trip Berlin`n"
  Assert-Eq ([IO.File]::ReadAllText((Join-Path $d 'lists\.order'))) "Work`nHome`nTrip Berlin`n"
  Assert-Match (Invoke-Tool $ctx 'create_list' @{ name = 'work' }).error 'already'
  Assert-Eq (Invoke-Tool $ctx 'create_list' @{ name = 'con' })['list']['name'] 'Project con'
  Assert-Match (Invoke-Tool $ctx 'create_list' @{ name = '???' }).error 'Give the list a name'
}
Test-Case 'a list shared with this PC for viewing only is never changed; an editable one is' {
  $d = New-Fixture; $ctx = New-McpContext $d
  Write-List $d 'Groceries' "# Groceries`n- [ ] Bread ^gggggggg`n- [ ] Eggs`n"
  Write-List $d 'Team' "# Team`n- [ ] Plan ^hhhhhhhh`n"
  [IO.File]::WriteAllText((Join-Path $d 'lists\.remotes.json'), '{"version":1,"remotes":[{"id":"r1","file":"Groceries","server":"https://saqme.nuca.workers.dev","project":"p1","access":"view"},{"id":"r2","file":"Team","server":"https://saqme.dato.workers.dev","project":"p2","access":"edit"}]}')
  $before = Read-List $d 'Groceries'
  $lists = (Invoke-Tool $ctx 'get_lists')['lists']
  $g = @($lists | Where-Object { $_['name'] -eq 'Groceries' })[0]
  Assert-Eq "$($g['shared_from']) $($g['can_edit'])" 'nuca False'
  foreach ($c in @(@('update_task', @{ id = 'gggggggg'; status = 'done' }), @('delete_task', @{ id = 'gggggggg' }), @('add_tasks', @{ list = 'Groceries'; tasks = @(@{ text = 'Milk' }) }),
                   @('move_task', @{ id = 'gggggggg'; list = 'Work' }), @('move_task', @{ id = 'ffffffff'; list = 'Groceries' }))) {
    Assert-Match (Invoke-Tool $ctx $c[0] $c[1]).error 'for viewing only' $c[0]
  }
  Assert-Eq (Read-List $d 'Groceries') $before 'unchanged (not even ids added)'
  [void](Invoke-Tool $ctx 'update_task' @{ id = 'hhhhhhhh'; status = 'done' })
  Assert-True (Read-List $d 'Team').Contains('- [x] Plan ^hhhhhhhh') 'the editable one'
}

Write-Host 'safety'
Test-Case 'a write only replaces a file that still holds what was read; nothing is lost by accident' {
  $d = New-Fixture
  $docs = Read-McpLists (New-McpContext $d)
  $w = $docs[0]
  Write-List $d 'Work' ((Read-List $d 'Work') + "- [ ] Added meanwhile ^zzzzzzzz`n")
  [void]$w.Items.Add((New-McpItem 0 ' ' 'Mine' '' '' '' 'yyyyyyyy'))
  Assert-True (-not (Save-McpDoc $w $null)) 'refused: changed meanwhile'
  Assert-True (Read-List $d 'Work').Contains('Added meanwhile') 'their change kept'
  $docs = Read-McpLists (New-McpContext $d)
  $docs[0].Items.RemoveAt(2)
  $threw = $false; try { [void](Save-McpDoc $docs[0] $null) } catch { $threw = $_.Exception.Message -match 'would be lost' }
  Assert-True $threw 'a task that would vanish without a delete or move stops the write'
}
Test-Case 'a busy list (locked by another program) is not written, and the tool says so' {
  $d = New-Fixture; $ctx = New-McpContext $d
  $fs = [IO.File]::Open((Join-Path $d 'lists\Home.md'), 'Open', 'ReadWrite', 'None')
  try {
    Assert-Match (Invoke-Tool $ctx 'add_tasks' @{ list = 'Home'; tasks = @(@{ text = 'x' }) }).error 'saving it right now'
    Assert-True (@((Invoke-Tool $ctx 'get_lists')['lists'] | Where-Object { $_['name'] -eq 'Home' })[0]['busy']) 'listed as busy'
  } finally { $fs.Dispose() }
}
Test-Case 'after everything: no list file was ever removed, no temp files left' {
  $d = New-Fixture; $ctx = New-McpContext $d
  [void](Invoke-Tool $ctx 'delete_task' @{ id = 'ffffffff' })
  [void](Invoke-Tool $ctx 'move_task' @{ id = 'aaaaaaaa'; list = 'Home' })
  [void](Invoke-Tool $ctx 'create_list' @{ name = 'New' })
  Assert-Eq (Get-ListFiles $d) @('Home.md', 'New.md', 'Work.md')
  Assert-Eq @([IO.Directory]::GetFiles((Join-Path $d 'lists'), '*.tmp')).Count 0
}

Write-Host 'the server over stdio (desktop/mcp-server.ps1)'
Test-Case 'one answer per line, nothing else on stdout; edits reach the file' {
  $d = New-Fixture
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $desk 'mcp-server.ps1')`" -DataDir `"$d`""
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $p = [Diagnostics.Process]::Start($psi)
  $in = New-Object IO.StreamWriter($p.StandardInput.BaseStream, $script:Utf8NoBom); $in.NewLine = "`n"
  $in.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')
  $in.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
  $in.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add_tasks","arguments":{"list":"Home","tasks":[{"text":"Eggs ქ"}]}}}')
  $in.Close()
  $out = $p.StandardOutput.ReadToEnd(); $err = $p.StandardError.ReadToEnd()
  [void]$p.WaitForExit(30000)
  $lines = @($out -split "`n" | Where-Object { $_ })
  Assert-Eq $lines.Count 2 "two answers (stderr: $err) <$out>"
  Assert-Eq (ConvertFrom-JsonText $lines[0])['id'] 1
  $added = (ConvertFrom-JsonText $lines[1])['result']['structuredContent']['tasks'][0]
  Assert-Eq $added['text'] 'Eggs ქ'
  Assert-True (Read-List $d 'Home').Contains("- [ ] Eggs ქ ^$($added['id'])") 'in the file, UTF-8'
  Assert-True ($out -notmatch "`r") 'LF only'
}

Write-Host 'Claude Desktop''s settings (desktop/claude-desktop.ps1)'
function New-FakeProfile { $r = New-TempData; foreach ($s in 'Roaming', 'Local\Packages') { [void](New-Item -ItemType Directory -Path (Join-Path $r $s)) }; return @{ AppData = (Join-Path $r 'Roaming'); Local = (Join-Path $r 'Local') } }
$entry = Get-ClaudeEntry 'C:\Users\n\AppData\Local\Programs\SaqmeToDo\saqme-mcp.ps1' 'C:\Users\n\AppData\Roaming\SaqmeToDo\'
Test-Case 'the entry: Windows PowerShell, hidden, the launcher, the data folder' {
  Assert-Match $entry['command'] '\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$'
  Assert-Eq (@($entry['args']) -join ' ') '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Users\n\AppData\Local\Programs\SaqmeToDo\saqme-mcp.ps1 -DataDir C:\Users\n\AppData\Roaming\SaqmeToDo'
}
Test-Case 'installed: the Store package, the classic installer, or its settings folder; the Store app''s private copy wins' {
  $f = New-FakeProfile
  Assert-True (-not (Test-ClaudeInstalled $f.AppData $f.Local)) 'nothing there'
  Assert-Eq (Get-ClaudeConfigPath $f.AppData $f.Local) (Join-Path $f.AppData 'Claude\claude_desktop_config.json')
  [void](New-Item -ItemType Directory -Path (Join-Path $f.Local 'Packages\ClaudeX_abc'))
  Assert-True (-not (Test-ClaudeInstalled $f.AppData $f.Local)) 'another package'
  $pkg = Join-Path $f.Local 'Packages\Claude_pzs8sxrjxfjjc'
  [void](New-Item -ItemType Directory -Path $pkg)
  Assert-True (Test-ClaudeInstalled $f.AppData $f.Local) 'the Store app'
  Assert-Eq (Get-ClaudeConfigPath $f.AppData $f.Local) (Join-Path $f.AppData 'Claude\claude_desktop_config.json') 'no private copy: the real folder'
  [void](New-Item -ItemType Directory -Path (Join-Path $pkg 'LocalCache\Roaming\Claude'))
  [IO.File]::WriteAllText((Join-Path $pkg 'LocalCache\Roaming\Claude\claude_desktop_config.json'), '{}')
  Assert-Eq (Get-ClaudeConfigPath $f.AppData $f.Local) (Join-Path $pkg 'LocalCache\Roaming\Claude\claude_desktop_config.json')
  $g = New-FakeProfile; [void](New-Item -ItemType Directory -Path (Join-Path $g.Local 'AnthropicClaude'))
  Assert-True (Test-ClaudeInstalled $g.AppData $g.Local) 'the classic installer'
}
Test-Case 'connect: merged, a backup of the file as it was, connecting again changes nothing; disconnect takes out only Saqme' {
  $f = New-FakeProfile; [void](New-Item -ItemType Directory -Path (Join-Path $f.AppData 'Claude'))
  $path = Join-Path $f.AppData 'Claude\claude_desktop_config.json'
  $mine = "{`n  `"mcpServers`": {`n    `"files`": { `"command`": `"npx`", `"args`": [`"-y`", `"x`"] }`n  },`n  `"preferences`": { `"zoom`": 1.25, `"quick`": false }`n}`n"
  [IO.File]::WriteAllText($path, $mine)
  Assert-Eq (Get-ClaudeDesktopStatus $entry $f.AppData $f.Local).State 'none'
  $r = Connect-ClaudeDesktop $entry $f.AppData $f.Local
  Assert-True ($r.Ok -and $r.Changed) "connected: $($r.Error)"
  Assert-Eq ([IO.File]::ReadAllText("$path.saqme-backup")) $mine 'the backup'
  $o = ConvertFrom-JsonText ([IO.File]::ReadAllText($path))
  Assert-Eq (@($o['mcpServers'].Keys) -join ',') 'files,saqme'
  Assert-Eq "$($o['preferences']['zoom']) $($o['preferences']['quick'])" '1.25 False'
  Assert-Eq (Get-ClaudeDesktopStatus $entry $f.AppData $f.Local).State 'connected'
  $once = [IO.File]::ReadAllText($path)
  Assert-Match $once '^\{\n  "mcpServers": \{\n    "files": \{\n      "command": "npx",'
  $r = Connect-ClaudeDesktop $entry $f.AppData $f.Local
  Assert-True ($r.Ok -and -not $r.Changed) 'the second time: nothing'
  Assert-Eq ([IO.File]::ReadAllText($path)) $once
  Assert-Eq (@([IO.Directory]::GetFiles((Join-Path $f.AppData 'Claude')) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object) -join ',') 'claude_desktop_config.json,claude_desktop_config.json.saqme-backup'
  $r = Disconnect-ClaudeDesktop $f.AppData $f.Local
  Assert-True ($r.Ok -and $r.Changed) 'disconnected'
  $o = ConvertFrom-JsonText ([IO.File]::ReadAllText($path))
  Assert-Eq (@($o['mcpServers'].Keys) -join ',') 'files'
  Assert-True (-not (Disconnect-ClaudeDesktop $f.AppData $f.Local).Changed) 'again: nothing'
}
Test-Case 'not installed: nothing written; no settings yet: made; not plain JSON: left alone' {
  $f = New-FakeProfile
  $r = Connect-ClaudeDesktop $entry $f.AppData $f.Local
  Assert-True (-not $r.Ok -and $r.Error -match 'not installed') 'not installed'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.AppData 'Claude'))) 'nothing made'
  [void](New-Item -ItemType Directory -Path (Join-Path $f.Local 'Packages\Claude_pzs8sxrjxfjjc'))
  $r = Connect-ClaudeDesktop $entry $f.AppData $f.Local
  Assert-True ($r.Ok -and $r.Changed) "made: $($r.Error)"
  $path = Join-Path $f.AppData 'Claude\claude_desktop_config.json'
  Assert-Eq (@((ConvertFrom-JsonText ([IO.File]::ReadAllText($path)))['mcpServers'].Keys) -join ',') 'saqme'
  $odd = "{ // mine`n `"mcpServers`": {} }"
  [IO.File]::WriteAllText($path, $odd)
  Assert-Eq (Get-ClaudeDesktopStatus $entry $f.AppData $f.Local).State 'unreadable'
  Assert-Match (Connect-ClaudeDesktop $entry $f.AppData $f.Local).Error 'not plain JSON'
  Assert-Match (Disconnect-ClaudeDesktop $f.AppData $f.Local).Error 'not plain JSON'
  Assert-Eq ([IO.File]::ReadAllText($path)) $odd
}
Test-Case 'Use with AI: with sync the link comes first, without it Claude Desktop' {
  Assert-Eq (Get-AiOptions $true) @('link', 'desktop', 'files')
  Assert-Eq (Get-AiOptions $false) @('desktop', 'link', 'files')
}

foreach ($d in $made) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host ("{0} passed, {1} failed" -f $script:passed, $script:failed)
if ($script:failed) { exit 1 }
