# The shared fixtures (shared/fixtures/) against the Windows app's PowerShell: the same input -> expected
# output files that worker/test/node/shared-fixtures.test.js runs against the JavaScript side.
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\tests\shared-fixtures.tests.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\sync-core.ps1')
. (Join-Path $PSScriptRoot '..\rules.ps1')
. (Join-Path $PSScriptRoot '..\update-core.ps1')

$Fixtures = Join-Path $PSScriptRoot '..\..\shared\fixtures'
$CI = [Globalization.CultureInfo]::InvariantCulture
$script:failed = 0; $script:passed = 0
function Test-Case([string]$name, [scriptblock]$body) {
  try { & $body; $script:passed++; Write-Host "  ok   $name" }
  catch { $script:failed++; Write-Host "  FAIL $name`n       $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red }
}
function Assert-Eq($actual, $expected, [string]$what = '') {
  if ("$actual" -cne "$expected") { throw "$what`n         expected <$expected>`n         but got  <$actual>" }
}
function Assert-True($cond, [string]$what) { if (-not $cond) { throw "expected true: $what" } }

# file bytes as UTF-8, byte order mark and line endings included
function Read-Utf8([string]$path) { return [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($path)) }
function Read-Fixture([string]$name) { return ConvertFrom-JsonText (Read-Utf8 (Join-Path $Fixtures $name)) }
# a value as canonical JSON (object keys sorted), to compare structures in one string
function ConvertTo-Canon($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { return $(if ($v) { 'true' } else { 'false' }) }
  if ($v -is [string] -or $v -is [char]) { return $script:Json.Serialize([string]$v) }
  if ($v -is [Collections.IDictionary]) {
    $keys = [string[]]@($v.get_Keys()); [Array]::Sort($keys, [StringComparer]::Ordinal)
    return '{' + (@($keys | ForEach-Object { $script:Json.Serialize($_) + ':' + (ConvertTo-Canon $v[$_]) }) -join ',') + '}'
  }
  if ($v -is [Collections.IEnumerable]) { return '[' + (@($v | ForEach-Object { ConvertTo-Canon $_ }) -join ',') + ']' }
  return [string]::Format($CI, '{0}', $v)
}
function Get-Sorted([string[]]$a) { $a = [string[]]@($a); [Array]::Sort($a, [StringComparer]::Ordinal); return , $a }

# ---------------------------------------------------------------- deadlines
Write-Host 'dates.json: Parse-Due, Due-Label, Get-DueTone (rules.ps1)'
$dates = Read-Fixture 'dates.json'
function Get-WallNow($g) { return [datetime]::ParseExact($g['now'], "yyyy-MM-dd'T'HH:mm", $CI) }
foreach ($g in $dates['parse']) {
  Test-Case "parse: $($g['about']) ($($g['now']) $($g['tz']))" {
    $now = Get-WallNow $g
    foreach ($c in $g['cases']) {
      $r = Parse-Due $c[0] $now
      $got = $(if ($r) { @($c[0], $r.Date.ToString('yyyy-MM-dd', $CI), $r.Time) } else { @($c[0], $null, '') })
      Assert-Eq (ConvertTo-Canon $got) (ConvertTo-Canon $c) "parse '$($c[0])'"
    }
  }
}
foreach ($g in $dates['labels']) {
  Test-Case "labels at $($g['now'])" {
    $now = Get-WallNow $g
    foreach ($c in $g['cases']) { Assert-Eq (Due-Label ([datetime]::ParseExact($c[0], 'yyyy-MM-dd', $CI)) $now) $c[1] "label $($c[0])" }
  }
}
foreach ($g in $dates['tones']) {
  Test-Case "tones at $($g['now'])" {
    $now = Get-WallNow $g
    foreach ($c in $g['cases']) { Assert-Eq (Get-DueTone $c[0] $c[1] $c[2] $now) $c[3] "tone $($c[0]) $($c[1]) closed=$($c[2])" }
  }
}

# ---------------------------------------------------------------- reminders
Write-Host 'reminders.json: Get-Reminders (rules.ps1)'
foreach ($c in (Read-Fixture 'reminders.json')['cases']) {
  Test-Case $c['name'] {
    $utc = [datetime]::Parse($c['now'], $CI, ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal))
    $now = [TimeZoneInfo]::ConvertTimeFromUtc($utc, [TimeZoneInfo]::FindSystemTimeZoneById($c['windowsTz']))
    $tasks = @(foreach ($t in $c['tasks']) { @{ Id = $t['id']; Text = $t['text']; Status = $t['status']; Due = $t['due']; DueTime = $t['dueTime']; Project = $t['project'] } })
    $notified = @{}; foreach ($k in $c['notified']) { $notified[$k] = $true }
    $got = @(foreach ($r in (Get-Reminders $tasks $now $c['notifyAt'] $notified)) { @{ keys = @($r.Keys); title = $r.Title; body = $r.Body; sub = $r.Sub } })
    Assert-Eq (ConvertTo-Canon $got) (ConvertTo-Canon $c['expect'])
  }
}

# ---------------------------------------------------------------- markdown list format
Write-Host 'markdown.json: Read-Items, ConvertTo-MarkdownText, Set-MissingIds (sync-core.ps1)'
$md = Read-Fixture 'markdown.json'
function ConvertTo-CompactItem($it) {
  if ($it.Kind -eq 'task') { return , @('task', $it.Level, $it.Mark, $it.Text, $it.Due, $it.DueTime, $it.Id, $it.Notes) }
  return , @('raw', $it.Raw)
}
foreach ($c in $md['cases']) {
  Test-Case "$($c['file']): $($c['about'])" {
    $text = Read-Utf8 (Join-Path $Fixtures "markdown\$($c['file'])")
    $items = Read-Items $text
    Assert-Eq (ConvertTo-Canon @($items | ForEach-Object { , (ConvertTo-CompactItem $_) })) (ConvertTo-Canon $c['items']) 'items'
    $out = ConvertTo-MarkdownText $items 0 (Get-TextEol $text)
    $want = $(if ($c['roundtrip']) { $text } else { Read-Utf8 (Join-Path $Fixtures "markdown\$($c['expect'])") })
    Assert-Eq (ConvertTo-Canon $out) (ConvertTo-Canon $want) 'written text'
    Assert-Eq (ConvertTo-Canon (ConvertTo-MarkdownText (Read-Items $out) 0 (Get-TextEol $out))) (ConvertTo-Canon $out) 'written text reads back the same'
  }
}
foreach ($c in $md['stamp']) {
  Test-Case "stamp: $($c['about'])" {
    $items = Read-Items $c['text']
    $known = New-TextMap; foreach ($k in $c['known'].Keys) { $known[$k] = $c['known'][$k] }
    $taken = @{}; foreach ($k in $c['taken']) { $taken[$k] = $true }
    Assert-Eq (Set-MissingIds $items $known $taken) $c['changed'] 'changed'
    $ids = @($items | Where-Object { $_.Kind -eq 'task' } | ForEach-Object { $_.Id })
    $exp = @($c['expect'])
    for ($i = 0; $i -lt $exp.Count; $i++) {
      if ($exp[$i] -ceq '<new>') {
        Assert-True ($ids[$i] -cmatch '^[a-z][0-9a-z]{7}$') "new id $($ids[$i])"
        Assert-True (-not ($c['taken'] -ccontains $ids[$i]) -and -not (@($c['known'].Values) -ccontains $ids[$i])) "new id $($ids[$i]) is not reused"
      } else { Assert-Eq $ids[$i] $exp[$i] "id $i" }
    }
    Assert-Eq @($ids | Select-Object -Unique).Count $ids.Count 'all ids different'
  }
}

# ---------------------------------------------------------------- order keys
Write-Host 'keys.json: Get-KeyBetween, Test-OrderKey, Get-RekeyMap (sync-core.ps1)'
$keysFx = Read-Fixture 'keys.json'
Test-Case 'between' {
  foreach ($c in $keysFx['between']) {
    $k = $(try { Get-KeyBetween $c[0] $c[1] } catch { $null })
    Assert-Eq (ConvertTo-Canon $k) (ConvertTo-Canon $c[2]) "between($($c[0]), $($c[1]))"
  }
}
Test-Case 'valid' {
  foreach ($c in $keysFx['valid']) { Assert-Eq (Test-OrderKey $c[0]) $c[1] "valid '$($c[0])'" }
}
foreach ($c in $keysFx['rekey']) {
  Test-Case "rekey $(ConvertTo-Canon $c['keys'])" {
    $m = Get-RekeyMap @($c['keys'])
    $got = @{}; foreach ($k in $m.Keys) { $got["$k"] = $m[$k] }
    Assert-Eq (ConvertTo-Canon $got) (ConvertTo-Canon $c['expect'])
  }
}
Test-Case "walk of $($keysFx['walk']['steps']) inserts" {
  [long]$s = $keysFx['walk']['seed']
  $keys = New-Object System.Collections.ArrayList; [void]$keys.Add('a0')
  for ($i = 0; $i -lt $keysFx['walk']['steps']; $i++) {
    $s = ($s * 1664525 + 1013904223) % 4294967296
    $at = [int][Math]::Floor(($s / 4294967296.0) * ($keys.Count + 1))
    $lo = $(if ($at -gt 0) { $keys[$at - 1] } else { $null }); $hi = $(if ($at -lt $keys.Count) { $keys[$at] } else { $null })
    $keys.Insert($at, (Get-KeyBetween $lo $hi))
  }
  Assert-Eq ($keys -join ',') (@($keysFx['walk']['expect']) -join ',')
}

# ---------------------------------------------------------------- value rules
Write-Host 'text.json: value rules (sync-core.ps1)'
$textFx = Read-Fixture 'text.json'
function Get-FixtureValue($v) {
  if ($v -is [Collections.IDictionary] -and $v.ContainsKey('repeat')) { return [string]$v['repeat'][0] * [int]$v['repeat'][1] }
  if ($v -is [object[]]) { return (@($v | ForEach-Object { Get-FixtureValue $_ }) -join '') }
  return $v
}
$rules = [ordered]@{
  cleanText = { param($s) ConvertTo-CleanText $s }; cleanNotes = { param($s) ConvertTo-CleanNotes $s }; cleanTime = { param($s) ConvertTo-CleanTime $s }
  validDate = { param($s) Test-ValidDate $s }; projectName = { param($s) ConvertTo-ProjectName $s }; fileName = { param($s) ConvertTo-FileName $s }
  pairingLink = { param($s) $r = Get-PairingLink $s; if ($r) { @{ key = $r.Key; server = $r.Server } } else { $null } }
  inviteLink = { param($s) $r = Get-InviteLink $s; if ($r) { @{ server = $r.Server; code = $r.Code } } else { $null } }
  serverLabel = { param($s) Get-ServerLabel $s }
}
foreach ($rule in $rules.Keys) {
  Test-Case $rule {
    foreach ($c in $textFx[$rule]) {
      if ($c -is [Collections.IDictionary]) { $in = Get-FixtureValue $c['in']; $want = Get-FixtureValue $c['out'] } else { $in = $c[0]; $want = $c[1] }
      $label = ConvertTo-Canon $in; if ($label.Length -gt 60) { $label = $label.Substring(0, 60) + '...' }
      Assert-Eq (ConvertTo-Canon (& $rules[$rule] $in)) (ConvertTo-Canon $want) "$rule $label"
    }
  }
}

# ---------------------------------------------------------------- the lists-folder engine
Write-Host 'engine.json: Get-RemotePlan, Add-LocalDiff (sync-core.ps1)'
$engine = Read-Fixture 'engine.json'
# JSON values -> the hashtables and arrays the engine builds itself
function ConvertTo-Plain($v) {
  if ($v -is [Collections.IDictionary]) { $h = @{}; foreach ($k in $v.get_Keys()) { $h[$k] = ConvertTo-Plain $v[$k] }; return $h }
  if ($v -is [object[]]) { return , @($v | ForEach-Object { ConvertTo-Plain $_ }) }
  return $v
}
function ConvertTo-Rows($list, [long]$ts) {
  $rows = @{}
  foreach ($r in $list) {
    $f = { param($v) @{ v = (ConvertTo-Plain $v); ts = $ts } }
    $get = { param($k, $default) if ($r.ContainsKey($k)) { $r[$k] } else { $default } }
    if ($r.ContainsKey('p')) {
      $rows["project:$($r['p'])"] = @{ kind = 'project'; id = $r['p']; fields = @{ name = (& $f $r['name']); pos = (& $f $r['pos']); deleted = (& $f (& $get 'deleted' $false)) } }
    } else {
      $place = @{ project = $r['in']; parent = (& $get 'parent' $null); pos = $r['pos'] }
      $rows["task:$($r['t'])"] = @{ kind = 'task'; id = $r['t']; fields = @{
          place = (& $f $place); text = (& $f $r['text']); status = (& $f (& $get 'status' ' ')); due = (& $f (& $get 'due' $null))
          notes = (& $f (& $get 'notes' '')); deleted = (& $f (& $get 'deleted' $false)) } }
    }
  }
  return $rows
}
function New-FixtureFolder($c) {
  $d = Join-Path ([IO.Path]::GetTempPath()) ('saqme-fx-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $lists = Join-Path $d 'lists'
  [void](New-Item -ItemType Directory -Path $lists)
  foreach ($name in $c['lists'].Keys) {
    $p = Join-Path $lists $name
    [void](New-Item -ItemType Directory -Path (Split-Path $p) -Force)   # ".trash/..."
    [IO.File]::WriteAllText($p, $c['lists'][$name], (New-Object System.Text.UTF8Encoding($false)))
    if (-not ($c.ContainsKey('busy') -and $c['busy'] -ccontains $name)) { [IO.File]::SetLastWriteTimeUtc($p, [DateTime]::UtcNow.AddSeconds(-10)) }
  }
  return $lists
}
function Get-FolderFiles([string]$lists) {
  $h = @{}
  foreach ($f in (Get-ChildItem -LiteralPath $lists -File -Force)) { $h[$f.Name] = Read-Utf8 $f.FullName }
  return $h
}
function New-FixtureState($c, $R, [long]$tsR) {
  $st = New-SyncState
  $st.S = ConvertTo-Rows $c['S'] 100; $st.R = ConvertTo-Rows $R $tsR
  foreach ($k in $c['files'].Keys) { $st.Files[$k] = $c['files'][$k] }
  $st.cursor = 5
  return $st
}

foreach ($c in $engine['plan']) {
  Test-Case "plan: $($c['name'])" {
    $lists = New-FixtureFolder $c
    try {
      $st = New-FixtureState $c $c['R'] 200
      $plan = Get-RemotePlan $st (Read-LocalLists $lists) $lists
      Assert-True ($null -ne $plan) 'a plan'
      Assert-Eq (Invoke-PlanOps $plan.Ops $lists) $plan.Ops.Count 'ops done'
      Assert-Eq (ConvertTo-Canon (Get-FolderFiles $lists)) (ConvertTo-Canon $c['after']) 'files afterwards'
      $trashDir = Join-Path $lists '.trash'
      $trash = @(if (Test-Path -LiteralPath $trashDir) { Get-ChildItem -LiteralPath $trashDir -Force | ForEach-Object { $_.Name } })
      $wantTrash = @(if ($c.ContainsKey('trash')) { $c['trash'] })
      Assert-Eq $trash.Count $wantTrash.Count 'files in .trash'
      foreach ($p in $wantTrash) { Assert-True (@($trash | Where-Object { $_.StartsWith($p, [StringComparison]::Ordinal) }).Count) "a trashed file starting with $p" }
      if ($c.ContainsKey('filesAfter')) {
        $files = @{}; foreach ($k in $st.Files.Keys) { $files[$k] = $st.Files[$k] }
        foreach ($k in @($plan.Files.Keys)) { if ($null -eq $plan.Files[$k]) { $files.Remove($k) } else { $files[$k] = $plan.Files[$k] } }
        Assert-Eq (ConvertTo-Canon $files) (ConvertTo-Canon $c['filesAfter']) 'project files'
      }
    } finally { Remove-Item -LiteralPath (Split-Path $lists) -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
foreach ($c in $engine['restore']) {
  Test-Case "restore: $($c['name'])" {
    $lists = New-FixtureFolder $c
    try {
      $st = New-FixtureState $c $c['S'] 100
      $st.Guard = @{ ids = @($c['guard']) }
      $rp = Get-RestorePlan $st (Read-LocalLists $lists) $lists $(if ($c.ContainsKey('keys')) { @($c['keys']) } else { $null })
      Assert-True ($null -ne $rp.Plan) 'a plan'
      Assert-Eq $rp.Count ([int]$c['count']) 'tasks put back'
      Assert-Eq (Invoke-PlanOps $rp.Plan.Ops $lists) $rp.Plan.Ops.Count 'ops done'
      Assert-Eq (ConvertTo-Canon (Get-FolderFiles $lists)) (ConvertTo-Canon $c['after']) 'files afterwards'
      if ($c.ContainsKey('filesAfter')) {
        $files = @{}; foreach ($k in $st.Files.Keys) { $files[$k] = $st.Files[$k] }
        foreach ($k in @($rp.Plan.Files.Keys)) { $files[$k] = $rp.Plan.Files[$k] }
        Assert-Eq (ConvertTo-Canon $files) (ConvertTo-Canon $c['filesAfter']) 'project files'
      }
    } finally { Remove-Item -LiteralPath (Split-Path $lists) -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
foreach ($c in $engine['diff']) {
  Test-Case "diff: $($c['name'])" {
    $lists = New-FixtureFolder $c
    try {
      $st = New-FixtureState $c $c['S'] 100
      $clock = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($c.ContainsKey('planned')) {
        foreach ($id in $c['planned'].Keys) {
          $p = $c['planned'][$id]; $fields = @{}
          foreach ($n in $p['fields'].Keys) { $fields[$n] = @{ v = (ConvertTo-Plain $p['fields'][$n][0]); ts = [long]$p['fields'][$n][1] } }
          $st.Planned["task:$id"] = @{ at = $clock - 1000 * [long]$p['age']; added = ($p.ContainsKey('added') -and $p['added']); addedTs = $(if ($p.ContainsKey('addedTs')) { [long]$p['addedTs'] } else { [long]0 }); fields = $fields }
        }
      }
      if ($c.ContainsKey('missing')) { foreach ($id in $c['missing'].Keys) { $st.Missing[$id] = $clock - 1000 * [long]$c['missing'][$id] } }
      if ($c.ContainsKey('guard')) { $st.Guard = @{ ids = @($c['guard']) } }
      $local = Read-LocalLists $lists
      $exp = $null; if ($c.ContainsKey('expected')) { $exp = @{}; foreach ($k in $c['expected']) { $exp[$k] = $true } }
      $out = Add-LocalDiff $st $local '' -AllowMassDelete:($c.ContainsKey('allow') -and $c['allow']) -Clock $clock -Expected $exp
      $got = @{}
      foreach ($e in $st.Outbox) { foreach ($n in $e['fields'].Keys) { $got[(ConvertTo-Canon @($e['kind'], $e['id'], $n, $e['fields'][$n]['v']))] = $e['fields'][$n] } }
      $want = @(foreach ($ch in $c['changes']) { ConvertTo-Canon @($ch[0], $ch[1], $ch[2], $ch[3]) })
      Assert-Eq ((Get-Sorted @($got.Keys)) -join "`n") ((Get-Sorted $want) -join "`n") 'changes'
      foreach ($ch in $c['changes']) {
        if ($ch.Count -lt 5) { continue }
        $g = $got[(ConvertTo-Canon @($ch[0], $ch[1], $ch[2], $ch[3]))]
        if ($ch[4].ContainsKey('base')) { Assert-Eq $g['base'] $ch[4]['base'] "base of $($ch[1]) $($ch[2])" }
        if ($ch[4].ContainsKey('ts')) { Assert-Eq $g['ts'] $ch[4]['ts'] "ts of $($ch[1]) $($ch[2])" }
      }
      Assert-Eq $out.Guarded $(if ($c.ContainsKey('guarded')) { $c['guarded'] } else { 0 }) 'guarded'
      $skipped = $out.Skipped -or @($local.Files.Values | Where-Object { $_.Status -ne 'ok' }).Count -gt 0
      Assert-Eq $skipped ($c.ContainsKey('skipped') -and $c['skipped']) 'skipped'
      if ($c.ContainsKey('guardAfter')) {
        $after = @(if ($st.Guard) { $st.Guard['ids'] })
        Assert-Eq ((Get-Sorted $after) -join ',') ((Get-Sorted @($c['guardAfter'])) -join ',') 'held back afterwards'
      }
    } finally { Remove-Item -LiteralPath (Split-Path $lists) -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

foreach ($c in $engine['replay']) {
  Test-Case "replay: $($c['name'])" {
    $lists = New-FixtureFolder $c
    try {
      $st = New-FixtureState $c $c['S'] 100
      $st.dbId = 'db1'
      $script:replaySent = New-Object System.Collections.ArrayList
      $script:replayDir = $lists
      $start = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $got = @()
      foreach ($sec in $c['cycles']) {
        # a server that has everything (S) and answers with nothing new
        $ctx = @{ State = $st; StatePath = (Join-Path (Split-Path $lists) 'state.json'); ListsDir = $lists; Url = 'https://x.example'; Token = 't'; DeviceId = 'replay'
                  NotifyAt = ''; SettleMs = 0; Clock = [scriptblock]::Create([string]($start + 1000 * [long]$sec))
                  ApplyPlan = { param($plan) return ((Invoke-PlanOps $plan.Ops $script:replayDir) -eq @($plan.Ops).Count) }
                  Transport = { param($body) foreach ($e in @($body.changes)) { [void]$script:replaySent.Add($e) }
                                return @{ Status = 200; Data = @{ cursor = 5; more = $false; changes = @(); rejected = @(); serverTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); dbId = 'db1' } } } }
        $res = Invoke-SyncCycle $ctx
        Assert-Eq $res.Status 'synced' "cycle at $sec s"
        foreach ($x in @($res.Rewritten)) { if ($x) { $got += "$($x.Name) $($x.Count)" } }
      }
      Assert-Eq (ConvertTo-Canon (Get-FolderFiles $lists)) (ConvertTo-Canon $c['after']) 'files afterwards'
      Assert-True ($null -eq $st.Guard) 'nothing held back afterwards'
      foreach ($e in $script:replaySent) { if ($e['fields'].ContainsKey('deleted') -and $e['fields']['deleted']['v']) { throw "a delete reached the server: $($e['kind']) $($e['id'])" } }
      Assert-Eq ((Get-Sorted $got) -join ',') ((Get-Sorted @($c['rewritten'] | ForEach-Object { "$($_[0]) $($_[1])" })) -join ',') 'written again'
    } finally { Remove-Item -LiteralPath (Split-Path $lists) -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

foreach ($c in $engine['backups']['prune']) {
  Test-Case "backups: $($c['about'])" {
    $got = Get-BackupsToPrune @($c['names']) ([DateTime]::Parse($c['now'], [Globalization.CultureInfo]::InvariantCulture))
    Assert-Eq (@($got) -join ',') (@($c['pruned']) -join ',') 'pruned'
  }
}
foreach ($c in $engine['backups']['restore']) {
  Test-Case "backup restore: $($c['name'])" {
    $lists = New-FixtureFolder $c
    try {
      $backup = Join-Path (Split-Path $lists) 'backup'
      [void](New-Item -ItemType Directory -Path $backup)
      foreach ($n in $c['backup'].Keys) { [IO.File]::WriteAllText((Join-Path $backup $n), $c['backup'][$n], (New-Object System.Text.UTF8Encoding($false))) }
      $r = Get-BackupRestorePlan (Read-LocalLists $lists) $backup $lists
      Assert-True ($null -ne $r.Plan) 'a plan'
      Assert-Eq $r.Tasks ([int]$c['tasks']) 'tasks put back'
      Assert-Eq (@($r.Lists) -join ',') (@($c['written']) -join ',') 'lists written again'
      Assert-Eq (Invoke-PlanOps $r.Plan.Ops $lists) @($r.Plan.Ops).Count 'ops done'
      Assert-Eq (ConvertTo-Canon (Get-FolderFiles $lists)) (ConvertTo-Canon $c['after']) 'files afterwards'
    } finally { Remove-Item -LiteralPath (Split-Path $lists) -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# ---------------------------------------------------------------- "Use with AI"
Write-Host 'ai-prompt.json: Get-AiPrompt (rules.ps1)'
$aiFx = Read-Fixture 'ai-prompt.json'
function Read-AiExpected([string]$name) { return Read-Utf8 (Join-Path $Fixtures "ai-prompt\$name") }
foreach ($c in $aiFx['cases']) {
  Test-Case "ai-prompt: $($c['about'])" { Assert-Eq (Get-AiPrompt $c['dir']) (Read-AiExpected $c['file']) 'text' }
}
foreach ($c in $aiFx['same']) {
  Test-Case "ai-prompt: the same text for $($c['dir'])" {
    $base = $aiFx['cases'] | Where-Object { $_['file'] -eq $c['as'] }
    Assert-Eq (Get-AiPrompt $c['dir']) ((Read-AiExpected $c['as']).Replace($base['dir'], $c['dir'])) 'text'
  }
}

# ---------------------------------------------------------------- the app updater
Write-Host 'update.json: Compare-SaqmeVersion, Test-ReleaseManifest, Get-UpdateDecision (update-core.ps1)'
$updFx = Read-Fixture 'update.json'
Test-Case 'compareVersions' {
  foreach ($c in $updFx['compareVersions']) { Assert-Eq (ConvertTo-Canon (Compare-SaqmeVersion $c[0] $c[1])) (ConvertTo-Canon $c[2]) "compare '$($c[0])' '$($c[1])'" }
}
Test-Case 'manifest' {
  $i = 0
  foreach ($c in $updFx['manifest']) { $i++; Assert-Eq (ConvertTo-Canon (Test-ReleaseManifest $c['in'])) (ConvertTo-Canon $c['out']) "manifest case $i" }
}
Test-Case 'decision' {
  foreach ($c in $updFx['decision']) {
    Assert-Eq (Get-UpdateDecision $c['deploy'] $c['workerApi'] $c['minWorkerApi']) $c['out'] "decision $($c['deploy']) $($c['workerApi']) $($c['minWorkerApi'])"
  }
}

Write-Host ''
Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed) { exit 1 }
