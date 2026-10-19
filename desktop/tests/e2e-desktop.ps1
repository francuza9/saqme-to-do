# Runs desktop sync cycles against a running server; used by worker/test/e2e/run.mjs.
# Same engine as the widget, with plans applied directly instead of on the UI thread.
param([string]$Url, [string]$Token, [string]$DataDir, [int]$Cycles = 1, [string]$NotifyAt = '', [string]$DeviceId = 'pc-e2e', [int]$SettleMs = 0)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\sync-core.ps1')
$lists = Join-Path $DataDir 'lists'
$statePath = Join-Path $DataDir 'sync\state.json'
$st = Read-SyncState $statePath
$runs = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $Cycles; $i++) {
  $ctx = @{ State = $st; StatePath = $statePath; ListsDir = $lists; Url = $Url; Token = $Token; DeviceId = $DeviceId; NotifyAt = $NotifyAt
            AllowMassDelete = $false; SettleMs = $SettleMs; ApplyPlan = { param($plan) return ((Invoke-PlanOps $plan.Ops $lists) -eq $plan.Ops.Count) } }
  $res = Invoke-SyncCycle $ctx
  [void]$runs.Add(@{ status = $res.Status; message = $res.Message; retry = $res.Retry; sent = $res.Sent; received = $res.Received })
  if ($res.Status -ne 'synced') { break }
}
[Console]::Out.Write((ConvertTo-JsonText @{ runs = $runs; conflicts = (Get-OpenConflicts $st).Count; outbox = $st.Outbox.Count }))
