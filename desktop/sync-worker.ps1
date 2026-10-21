# Saqme To Do - background sync loop. widget.ps1 runs this in its own runspace; it never touches the UI and
# talks to the widget only through the synchronized hashtable $shared:
#   AppDir, ListsDir, SyncDir        paths
#   Wake                             AutoResetEvent: sync soon (local edit, "Sync now", window shown)
#   Stop                             $true -> finish the current step and exit
#   Status, StatusText, LastSync     for the indicator ('off' | 'syncing' | 'synced' | 'offline' | 'error')
#   Plan, PlanTaken, PlanResult, PlanDone, Lock
#                                    file changes the UI thread applies between edits (see Apply-SyncPlan in widget.ps1)
#   Conflicts, Guarded, AllowMassDelete, Queue (requests from the UI), NotifyAt
#   RestoreHeld                      "Restore them": put the held-back deletes back into the files (Get-RestorePlan)
#   WorkerApi, WorkerVersion         what this PC's own Worker runs, once it answered (an older one: API 1)
# Lists shared with this PC (docs/sync.md, "Shared lists") each sync with their owner's server, in an engine of their
# own after this PC's own one (sync-core.ps1 Read-ShareBindings); the own one leaves their files out:
#   Shares                           @( @{ Id; File; Server; Access; Name; State; Message } )
#   SharedByMe                       @{ file name = $true } of this PC's lists that others have (their tabs' badge)
#   Notices                          what a shared list's server did not take (view-only), with the conflicts
#   Ended, JoinResults               Queue of @{ Id; Name; Kept } (shares their owners ended); ticket -> join result
# Every change to lists\.remotes.json is made here, in this thread, so no two writers ever meet. The UI asks
# through Queue: @{ kind = 'join'; link; ticket }, @{ kind = 'leave'; share }, @{ kind = 'notice'; share; id } (dismiss),
# conflict resolutions (@{ kind; id; field; value; share }).
. (Join-Path $shared.AppDir 'sync-core.ps1')

$configPath = Join-Path $shared.SyncDir 'config.json'
$statePath = Join-Path $shared.SyncDir 'state.json'
$logPath = Join-Path $shared.SyncDir 'sync.log'
$sharesDir = Join-Path $shared.SyncDir 'shares'
$state = $null
$shareStates = @{}   # binding id -> its engine state

function Write-SyncLog([string]$msg) {
  try {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 256KB) { Move-Item -LiteralPath $logPath -Destination "$logPath.old" -Force }
    [IO.File]::AppendAllText($logPath, ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg) + "`r`n")
  } catch {}
}

function Set-SyncStatus([string]$status, [string]$text) {
  $shared.Status = $status; $shared.StatusText = $text
}

function Read-SyncConfig {
  $t = Read-TextFile $configPath
  if (-not $t) { return $null }
  try { $c = ConvertFrom-JsonText $t } catch { return $null }
  if (-not $c -or -not $c['url'] -or -not $c['token'] -or $c['enabled'] -eq $false) { return $null }
  if (-not $c['deviceId']) {
    $c['deviceId'] = 'pc-' + (New-SaqmeId 10)
    try { Write-TextFileAtomic $configPath (ConvertTo-JsonText $c) } catch {}
  }
  return $c
}

# hand a plan to the UI thread and wait until it has been applied (or refused because the user is typing)
$applyPlan = {
  param($plan)
  [System.Threading.Monitor]::Enter($shared.Lock)
  try { $shared.PlanResult = $null; $shared.PlanTaken = $false; [void]$shared.PlanDone.Reset(); $shared.Plan = $plan }
  finally { [System.Threading.Monitor]::Exit($shared.Lock) }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not $shared.PlanDone.WaitOne(200)) {
    if ($shared.Stop -or [DateTime]::UtcNow -gt $deadline) {
      [System.Threading.Monitor]::Enter($shared.Lock)
      try { if (-not $shared.PlanTaken) { $shared.Plan = $null; return $false } }
      finally { [System.Threading.Monitor]::Exit($shared.Lock) }
    }
  }
  return [bool]$shared.PlanResult
}

# a shared list's plans: the same, and when the owner renamed the list, its binding follows at once (before the
# engine for this PC's own server reads the folder again, so it never takes the renamed file for one of its own)
$applySharePlan = {
  param($plan)
  $ok = & $applyPlan $plan
  $c = $script:curShare
  if ($ok -and $c -and $plan.Files.ContainsKey($c.Project) -and $plan.Files[$c.Project]) { Set-ShareBinding $shared.ListsDir $c.Id @{ file = [string]$plan.Files[$c.Project] } }
  return $ok
}

# changes requested from the UI (conflict resolutions) go straight to the outbox: they are not in the
# files yet, so they must not touch the base, or the next diff would undo them
function Add-QueuedChanges($st, $requests) {
  foreach ($q in $requests) {
    if ($q.kind -eq 'task' -and $q.field -eq 'restore') {
      # Recently deleted put this task back in its list on purpose: not a save from before a remote delete
      # (Get-StaleSave), so the next diff sends it as not deleted, as of now
      [void]$st.Planned.Remove("task:$($q.id)")
      continue
    }
    $now = Get-SyncNow $st
    $targets = @($q.id)
    if ($q.kind -eq 'task' -and $q.field -eq 'deleted' -and $q.value -eq $true) {
      # deleting from a conflict takes the subtasks along, like everywhere else
      $todo = New-Object System.Collections.Queue; $todo.Enqueue($q.id)
      while ($todo.Count) {
        $p = $todo.Dequeue()
        foreach ($key in @($st.R.Keys)) {
          $r = $st.R[$key]
          if ($r['kind'] -eq 'task' -and (Get-PlaceOf $r)['parent'] -ceq $p -and -not (Get-Field $r 'deleted')['v']) { $targets += $r['id']; $todo.Enqueue($r['id']) }
        }
      }
    }
    foreach ($id in $targets) {
      $key = "$($q.kind):$id"
      $cur = Get-Field $st.R[$key] $q.field
      $entry = $null
      foreach ($e in $st.Outbox) { if ($e['kind'] -eq $q.kind -and $e['id'] -ceq $id) { $entry = $e; break } }
      if (-not $entry) { $entry = @{ kind = $q.kind; id = $id; fields = @{} }; [void]$st.Outbox.Add($entry) }
      $entry['fields'][$q.field] = @{ v = $q.value; ts = $now; base = $(if ($cur) { [long]$cur['ts'] } else { -1 }) }
    }
  }
}

# ---------------------------------------------------------------- lists shared with this PC
function Get-ShareState([string]$id) {
  if (-not $shareStates.ContainsKey($id)) { $shareStates[$id] = Read-SyncState (Join-Path $sharesDir "$id.json") }
  return $shareStates[$id]
}
function Get-ShareDeviceId {
  $keys = Read-ShareKeys $shared.SyncDir
  if (-not $keys['deviceId']) { $keys['deviceId'] = 'pc-' + (New-SaqmeId 10); Save-ShareKeys $shared.SyncDir $keys }
  return [string]$keys['deviceId']
}

# Its owner stopped sharing it (the key got 401): the file stays as one of this PC's own lists, with new ids so it
# never gets mixed up with the owner's copy, and the binding goes (only then does the own engine see the file).
# $false when the widget could not take the rewrite right now (tried again next round).
function Stop-SharedList($b) {
  $path = Join-Path $shared.ListsDir "$($b['file']).md"
  $text = Read-TextFile $path
  if ($null -ne $text) {
    $plan = @{ Ops = @(@{ type = 'write'; path = $path; expected = $text; text = (Get-TextWithNewIds $text) }); Files = @{}; Setting = $null; Stamp = $true }
    if (-not (& $applyPlan $plan)) { return $false }
  }
  Remove-SharedList $shared.ListsDir $shared.SyncDir ([string]$b['id'])
  [void]$shareStates.Remove([string]$b['id'])
  $shared.Ended.Enqueue(@{ Id = [string]$b['id']; Name = [string]$b['file']; Kept = ($null -ne $text) })
  Write-SyncLog "shared list $($b['file']): the owner stopped sharing it; it stays as this PC's own list"
  return $true
}

# Leave (asked by the UI): the file goes to lists\.trash through the UI thread, then the binding, the key and the
# engine state go. Nothing changes on the owner's server except that this key ends.
function Exit-SharedList([string]$id) {
  $b = $null; foreach ($x in (Read-ShareBindings $shared.ListsDir)) { if ($x['id'] -ceq $id) { $b = $x } }
  if (-not $b) { return }
  Set-ShareBinding $shared.ListsDir $id @{ left = $true }   # from here on no engine syncs the file
  $path = Join-Path $shared.ListsDir "$($b['file']).md"
  $text = Read-TextFile $path
  if ($null -ne $text) {
    $plan = @{ Ops = @(@{ type = 'trash'; path = $path; name = [string]$b['file']; expected = $text }); Files = @{}; Setting = $null }
    if (-not (& $applyPlan $plan)) { return }   # (still marked as left: done next round)
  }
  $token = (Read-ShareKeys $shared.SyncDir)['tokens'][$id]
  if ($token) { try { [void](Invoke-SaqmeApi (([string]$b['server']).TrimEnd('/') + '/api/shares/leave') ([string]$token) 'POST' @{} 8000) } catch {} }
  Remove-SharedList $shared.ListsDir $shared.SyncDir $id
  [void]$shareStates.Remove($id)
  Write-SyncLog "shared list $($b['file']): left"
}

# One cycle of a shared list's engine. -> the cycle's result, with .Ended when the share ended in it.
function Invoke-ShareCycle($b) {
  $id = [string]$b['id']
  $st = Get-ShareState $id
  $token = (Read-ShareKeys $shared.SyncDir)['tokens'][$id]
  if (-not $token) { return @{ Status = 'error'; Message = 'no key for this shared list'; Guarded = 0; Refused = @(); Retry = $false; Sent = 0; Received = 0 } }
  $proj = [string]$b['project']
  $script:curShare = @{ Id = $id; Project = $proj }   # for $applySharePlan
  $ctx = @{
    State = $st; StatePath = (Join-Path $sharesDir "$id.json"); ListsDir = $shared.ListsDir; Url = [string]$b['server']; Token = [string]$token
    DeviceId = (Get-ShareDeviceId); NotifyAt = ''; AllowMassDelete = [bool]$shared.AllowMassDelete; Restore = [bool]$shared.RestoreHeld; ApplyPlan = $applySharePlan
    View = @{ Only = [string]$b['file'] }; Scope = @{ Project = $proj; File = [string]$b['file']; ReadOnly = ([string]$b['access'] -ne 'edit'); Label = (Get-ServerLabel ([string]$b['server'])) }
  }
  $res = Invoke-SyncCycle $ctx
  if ($res.Access -and $res.Access -ne [string]$b['access']) {
    Set-ShareBinding $shared.ListsDir $id @{ access = $res.Access }
    Write-SyncLog "shared list $($b['file']): now $(if ($res.Access -eq 'edit') { 'editable' } else { 'view-only' })"
  }
  if ($res.Status -eq 'auth') { $res.Ended = Stop-SharedList $b }
  return $res
}

# the conflicts the UI shows: this PC's own, and those of shared lists it may edit (tagged with their share)
function Get-AllConflicts($bindings) {
  $all = New-Object System.Collections.ArrayList
  if ($state) { foreach ($c in (Get-OpenConflicts $state)) { $c.Share = ''; [void]$all.Add($c) } }
  foreach ($b in $bindings) {
    if ([string]$b['access'] -ne 'edit' -or -not $shareStates.ContainsKey([string]$b['id'])) { continue }
    foreach ($c in (Get-OpenConflicts $shareStates[[string]$b['id']])) { $c.Share = [string]$b['id']; [void]$all.Add($c) }
  }
  return ,$all
}

function Publish-Shares($bindings, $statusOf) {
  $list = New-Object System.Collections.ArrayList
  $notices = New-Object System.Collections.ArrayList
  foreach ($b in $bindings) {
    $id = [string]$b['id']
    $s = $statusOf[$id]
    [void]$list.Add(@{ Id = $id; File = [string]$b['file']; Server = [string]$b['server']; Access = [string]$b['access']; Name = [string]$b['name']
                       State = $(if ($s) { $s.State } else { 'syncing' }); Message = $(if ($s) { $s.Message } else { '' }) })
    if ($shareStates.ContainsKey($id)) {
      foreach ($n in $shareStates[$id].Notices) {
        [void]$notices.Add(@{ Id = "$id`:$($n['id'])"; Share = $id; NoticeId = [string]$n['id']; Task = [string]$n['task']; List = [string]$b['file']
                              Field = [string]$n['field']; Value = $n['value']; Text = [string]$n['text']; Reason = [string]$n['reason']; At = [long]$n['at'] })
      }
    }
  }
  $byMe = @{}; $ids = @{}
  if ($state) {
    foreach ($p in @($state.Shared)) { if ($p -and $state.Files.ContainsKey($p)) { $byMe[[string]$state.Files[$p]] = $true } }
    foreach ($p in @($state.Files.Keys)) { $ids[[string]$state.Files[$p]] = [string]$p }   # file -> project id, for Share
  }
  $shared.Shares = $list.ToArray(); $shared.Notices = $notices.ToArray(); $shared.SharedByMe = $byMe; $shared.ProjectIds = $ids
}

# ---------------------------------------------------------------- the loop
$failures = 0
$retryMs = 0
$shareStatus = @{}   # binding id -> @{ State; Message }
Write-SyncLog 'sync loop started'
while (-not $shared.Stop) {
  $woken = $shared.Wake.WaitOne($(if ($retryMs) { $retryMs } else { 12000 }))
  if ($shared.Stop) { break }
  if ($woken) { Start-Sleep -Milliseconds 1600 }   # let a burst of edits settle (lists written <1.5 s ago are skipped)
  $cfg = Read-SyncConfig
  try {
    # what the UI asked for, in order: joins and leaves first, then the rest goes to the engine it belongs to
    $requests = New-Object System.Collections.ArrayList
    while ($shared.Queue.Count -gt 0) { [void]$requests.Add($shared.Queue.Dequeue()) }
    foreach ($q in @($requests)) {
      if ($q.kind -eq 'join') {
        $j = Join-SharedList $shared.ListsDir $shared.SyncDir ([string]$q.link)
        $shared.JoinResults[[string]$q.ticket] = @{ Ok = $j.Ok; Error = [string]$j.Error; File = $(if ($j.Ok) { [string]$j.Binding['file'] } else { '' }) }
        if ($j.Ok) { Write-SyncLog "joined the shared list $($j.Binding['file']) from $(([Uri]$j.Binding['server']).Host) ($($j.Binding['access']))" }
        [void]$requests.Remove($q)
      } elseif ($q.kind -eq 'leave') { Exit-SharedList ([string]$q.share); [void]$requests.Remove($q) }
      elseif ($q.kind -eq 'notice') {
        $st0 = $(if ($shareStates.ContainsKey([string]$q.share)) { $shareStates[[string]$q.share] } else { $null })
        if ($st0) {
          foreach ($n in @($st0.Notices)) { if ($n['id'] -ceq [string]$q.id) { $st0.Notices.Remove($n) } }
          Save-SyncState $st0 (Join-Path $sharesDir "$($q.share).json")
        }
        [void]$requests.Remove($q)
      }
    }
    $bindings = Read-ShareBindings $shared.ListsDir
    foreach ($b in @($bindings)) { if ($b['left']) { Exit-SharedList ([string]$b['id']) } }   # a leave that could not finish yet
    $bindings = @((Read-ShareBindings $shared.ListsDir) | Where-Object { -not $_['left'] })
    if (-not $cfg -and $bindings.Count -eq 0) { Set-SyncStatus 'off' ''; $state = $null; $retryMs = 0; $shared.Shares = @(); $shared.Conflicts = @(); continue }
    if ($shared.Status -ne 'synced' -or $woken) { Set-SyncStatus 'syncing' 'Syncing...' }
    $allow = [bool]$shared.AllowMassDelete
    $restore = [bool]$shared.RestoreHeld
    $guarded = 0; $retry = $false; $worst = $null; $restorePending = $false

    # ---- this PC's own server (without the lists shared with this PC)
    if ($cfg) {
      if (-not $state) { $state = Read-SyncState $statePath }
      Add-QueuedChanges $state @($requests | Where-Object { -not $_.share })
      $ctx = @{
        State = $state; StatePath = $statePath; ListsDir = $shared.ListsDir; Url = [string]$cfg['url']; Token = [string]$cfg['token']
        DeviceId = [string]$cfg['deviceId']; NotifyAt = [string]$shared.NotifyAt; AllowMassDelete = $allow; Restore = $restore; ApplyPlan = $applyPlan
        View = @{ Exclude = (Get-SharedFileSet $shared.ListsDir) }
      }
      $res = Invoke-SyncCycle $ctx
      $guarded += $res.Guarded
      if ($res.RestorePending) { $restorePending = $true }
      if ($res.Restored) { Write-SyncLog "put $($res.Restored) held-back tasks back into their lists" }
      $shared.Pending = $state.Outbox.Count
      if ($res.Api) { $shared.WorkerApi = $res.Api; $shared.WorkerVersion = $res.WorkerVersion }   # (Settings, the Share view)
      $worst = $res
      if ($res.Retry) { $retry = $true }
      if ($res.Status -eq 'synced' -and $res.Refused.Count) { Write-SyncLog ('refused by the server: ' + ($res.Refused -join '; ')) }
      if ($res.Sent -or $res.Received) { Write-SyncLog "synced: sent $($res.Sent), received $($res.Received)" }
    } else { $state = $null }

    # ---- each list shared with this PC, against its owner's server
    foreach ($b in $bindings) {
      $id = [string]$b['id']
      try {
        $st = Get-ShareState $id
        Add-QueuedChanges $st @($requests | Where-Object { $_.share -ceq $id })
        $r2 = Invoke-ShareCycle $b
        $guarded += $r2.Guarded
        if ($r2.RestorePending) { $restorePending = $true }
        if ($r2.Restored) { Write-SyncLog "shared list $($b['file']): put $($r2.Restored) held-back tasks back" }
        if ($r2.Retry -or ($r2.Status -eq 'auth' -and -not $r2.Ended)) { $retry = $true }
        if ($r2.Status -eq 'auth') { continue }
        $shareStatus[$id] = @{ State = $r2.Status; Message = [string]$r2.Message }
        if ($r2.Sent -or $r2.Received) { Write-SyncLog "shared list $($b['file']): sent $($r2.Sent), received $($r2.Received)" }
        if ($r2.Status -ne 'synced') { Write-SyncLog "shared list $($b['file']): $($r2.Status) $($r2.Message)" }
        if (-not $worst) { $worst = $r2 } elseif ($worst.Status -eq 'synced' -and $r2.Status -ne 'synced') { $worst = @{ Status = $r2.Status; Message = "$($b['file']): $($r2.Message)"; Refused = @(); Retry = $r2.Retry } }
      } catch {
        $shareStatus[$id] = @{ State = 'error'; Message = $_.Exception.Message }
        [void]$shareStates.Remove($id)   # reload from disk next time
        Write-SyncLog ("shared list $($b['file']): exception: " + $_.Exception.ToString())
      }
    }
    if ($allow) { $shared.AllowMassDelete = $false }
    if ($restore -and -not $restorePending) { $shared.RestoreHeld = $false }
    $bindings = @((Read-ShareBindings $shared.ListsDir) | Where-Object { -not $_['left'] })
    foreach ($k in @($shareStates.Keys)) { if (-not @($bindings | Where-Object { $_['id'] -ceq $k }).Count) { [void]$shareStates.Remove($k) } }
    Publish-Shares $bindings $shareStatus
    $shared.Guarded = $guarded
    $shared.Conflicts = Get-AllConflicts $bindings
    if (-not $worst) { $worst = @{ Status = 'synced'; Message = ''; Refused = @() } }
    switch ($worst.Status) {
      'synced' {
        $failures = 0
        $shared.LastSync = Get-Date
        if ($guarded) { Set-SyncStatus 'error' "$guarded tasks disappeared from the lists folder at once. Deleting them everywhere is paused: restore them or delete them in Settings > Sync & sharing." }
        elseif ($worst.Refused.Count) { Set-SyncStatus 'error' ("The server refused a change (" + $worst.Refused[0] + '). Details in sync\sync.log.') }
        else { Set-SyncStatus 'synced' 'Synced' }
        $retryMs = $(if ($retry) { 2500 } else { 0 })
      }
      'offline' { $failures++; Set-SyncStatus 'offline' "Offline - changes are kept and sent later ($($worst.Message))"; $retryMs = [Math]::Min(60000, 5000 * $failures) }
      'auth' { $failures++; Set-SyncStatus 'error' $worst.Message; $retryMs = 60000; Write-SyncLog $worst.Message }
      default { $failures++; Set-SyncStatus 'error' $worst.Message; $retryMs = [Math]::Min(120000, 10000 * $failures); Write-SyncLog "error: $($worst.Message)" }
    }
  } catch {
    $failures++
    Set-SyncStatus 'error' ("Sync failed: " + $_.Exception.Message)
    Write-SyncLog ("exception: " + $_.Exception.ToString())
    $state = $null   # reload from disk next time
    $shareStates = @{}
    $retryMs = [Math]::Min(120000, 10000 * $failures)
  }
}
Write-SyncLog 'sync loop stopped'
