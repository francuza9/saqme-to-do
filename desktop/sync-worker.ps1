# Saqme To Do - background sync loop. widget.ps1 runs this in its own runspace; it never touches the UI and
# talks to the widget only through the synchronized hashtable $shared:
#   AppDir, ListsDir, SyncDir        paths
#   Wake                             AutoResetEvent: sync soon (local edit, "Sync now", window shown)
#   Stop                             $true -> finish the current step and exit
#   Status, StatusText, LastSync     for the indicator ('off' | 'syncing' | 'synced' | 'offline' | 'error')
#   Plan, PlanTaken, PlanResult, PlanDone, Lock
#                                    file changes the UI thread applies between edits (see Apply-SyncPlan in widget.ps1)
#   Conflicts, Guarded, AllowMassDelete, Queue (conflict resolutions from the UI), NotifyAt
. (Join-Path $shared.AppDir 'sync-core.ps1')

$configPath = Join-Path $shared.SyncDir 'config.json'
$statePath = Join-Path $shared.SyncDir 'state.json'
$logPath = Join-Path $shared.SyncDir 'sync.log'
$state = $null

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

# changes requested from the UI (conflict resolutions) go straight to the outbox: they are not in the
# files yet, so they must not touch the base, or the next diff would undo them
function Add-QueuedChanges($st) {
  while ($shared.Queue.Count -gt 0) {
    $q = $shared.Queue.Dequeue()
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

$failures = 0
$retryMs = 0
Write-SyncLog 'sync loop started'
while (-not $shared.Stop) {
  $woken = $shared.Wake.WaitOne($(if ($retryMs) { $retryMs } else { 12000 }))
  if ($shared.Stop) { break }
  if ($woken) { Start-Sleep -Milliseconds 1600 }   # let a burst of edits settle (lists written <1.5 s ago are skipped)
  $cfg = Read-SyncConfig
  if (-not $cfg) { Set-SyncStatus 'off' ''; $state = $null; $retryMs = 0; continue }
  try {
    if (-not $state) { $state = Read-SyncState $statePath }
    Add-QueuedChanges $state
    if ($shared.Status -ne 'synced' -or $woken) { Set-SyncStatus 'syncing' 'Syncing...' }
    $ctx = @{
      State = $state; StatePath = $statePath; ListsDir = $shared.ListsDir; Url = [string]$cfg['url']; Token = [string]$cfg['token']
      DeviceId = [string]$cfg['deviceId']; NotifyAt = [string]$shared.NotifyAt; AllowMassDelete = [bool]$shared.AllowMassDelete; ApplyPlan = $applyPlan
    }
    $res = Invoke-SyncCycle $ctx
    if ($ctx.AllowMassDelete) { $shared.AllowMassDelete = $false }
    $shared.Guarded = $res.Guarded
    $shared.Conflicts = Get-OpenConflicts $state
    $shared.Pending = $state.Outbox.Count
    switch ($res.Status) {
      'synced' {
        $failures = 0
        $shared.LastSync = Get-Date
        if ($res.Refused.Count) { Write-SyncLog ('refused by the server: ' + ($res.Refused -join '; ')) }
        if ($res.Guarded) { Set-SyncStatus 'error' "$($res.Guarded) tasks disappeared from the lists folder at once. Deleting them everywhere is paused - Settings > Sync." }
        elseif ($res.Refused.Count) { Set-SyncStatus 'error' ("The server refused a change (" + $res.Refused[0] + '). Details in sync\sync.log.') }
        else { Set-SyncStatus 'synced' 'Synced' }
        $retryMs = $(if ($res.Retry) { 2500 } else { 0 })
        if ($res.Sent -or $res.Received) { Write-SyncLog "synced: sent $($res.Sent), received $($res.Received)" }
      }
      'offline' { $failures++; Set-SyncStatus 'offline' "Offline - changes are kept and sent later ($($res.Message))"; $retryMs = [Math]::Min(60000, 5000 * $failures) }
      'auth' { $failures++; Set-SyncStatus 'error' $res.Message; $retryMs = 60000; Write-SyncLog $res.Message }
      default { $failures++; Set-SyncStatus 'error' $res.Message; $retryMs = [Math]::Min(120000, 10000 * $failures); Write-SyncLog "error: $($res.Message)" }
    }
  } catch {
    $failures++
    Set-SyncStatus 'error' ("Sync failed: " + $_.Exception.Message)
    Write-SyncLog ("exception: " + $_.Exception.ToString())
    $state = $null   # reload from disk next time
    $retryMs = [Math]::Min(120000, 10000 * $failures)
  }
}
Write-SyncLog 'sync loop stopped'
