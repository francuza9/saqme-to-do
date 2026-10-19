# Runs scripts/setup.ps1 end to end in a sandbox: install + import, re-run, uninstall, purge.
# Nothing real is touched (paths, shortcuts and registry keys are redirected by SAQME_SETUP_SANDBOX).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\test-setup.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$sb = Join-Path ([IO.Path]::GetTempPath()) ('saqme-setup-sandbox-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$env:SAQME_SETUP_SANDBOX = $sb
$setup = Join-Path $root 'scripts\setup.ps1'
$app = Join-Path $sb 'Programs\SaqmeToDo'; $data = Join-Path $sb 'AppData\SaqmeToDo'; $reg = 'HKCU:\Software\SaqmeSetupSandbox'
$failed = 0
function Check([bool]$cond, [string]$what) { if ($cond) { Write-Host "  ok   $what" } else { Write-Host "  FAIL $what" -ForegroundColor Red; $script:failed++ } }
# from a local folder (cmd.exe complains about a \\wsl.localhost working folder); stderr is part of the output
function Invoke-Setup {
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $sb
  try { $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setup @args 2>&1 | Out-String } finally { Pop-Location }
  return @{ Code = $LASTEXITCODE; Out = $out }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Path $sb -Force | Out-Null

# lists in another folder to import (without ids)
$old = Join-Path $sb 'old\todo'
New-Item -ItemType Directory -Path (Join-Path $old 'lists') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $old 'lists\Work.md'), "# Work`n- [/] ship it due:2026-10-25T14:00`n  - [ ] sub`n", $utf8)
[IO.File]::WriteAllText((Join-Path $old 'lists\Home.md'), "- [ ] groceries`n", $utf8)
[IO.File]::WriteAllText((Join-Path $old 'lists\.order'), "Work`nHome`n", $utf8)
[IO.File]::WriteAllText((Join-Path $old '.widget-settings'), "theme=light`nnotifyAt=9:30`n", $utf8)
$oldHash = (Get-ChildItem $old -Recurse -File | Get-FileHash | ForEach-Object { $_.Hash }) -join ','

try {
  Write-Host 'install + import'
  $r = Invoke-Setup -NoStart -Import $old -Yes
  Check ($r.Code -eq 0) "setup exit code 0`n$($r.Out)"
  Check ($r.Out -notmatch 'Cloudflare account' -and $r.Out -match 'Settings > Sync > Set up sync' -and $r.Out -match 'setup.cmd -Cloud') 'sync left out by default, with a hint how to add it'
  foreach ($f in 'widget.ps1', 'tokens.ps1', 'rules.ps1', 'a11y.cs', 'sync-core.ps1', 'sync-worker.ps1', 'qr.ps1', 'start-widget.vbs', 'setup.ps1', 'assets\saqme.ico', 'fonts\FiraGO-Regular.ttf', 'fonts\OFL.txt') { Check (Test-Path (Join-Path $app $f)) "app file $f" }
  Check ($r.Out -match 'self-check passed') 'widget self-check ran'
  Check ((Get-Content (Join-Path $data 'lists\Work.md') -Raw) -match 'ship it') 'Work list imported'
  Check ((Get-Content (Join-Path $data 'lists\.order') -Raw) -match '^Work\s+Home') 'tab order imported'
  Check ((Get-Content (Join-Path $data '.widget-settings') -Raw) -match 'notifyAt=9:30') 'settings imported'
  Check ($oldHash -eq ((Get-ChildItem $old -Recurse -File | Get-FileHash | ForEach-Object { $_.Hash }) -join ',')) 'old install untouched'
  Check (Test-Path (Join-Path $sb 'StartMenu\Saqme To Do.lnk')) 'Start menu shortcut'
  Check (Test-Path (Join-Path $sb 'Startup\Saqme To Do.lnk')) 'start with Windows'
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $sb 'StartMenu\Saqme To Do.lnk'))
  Check ($lnk.Arguments -like "*$app\start-widget.vbs*") 'shortcut points at the installed launcher'
  Check ((Get-ItemProperty "$reg\Classes\saqme\shell\open\command").'(default)' -like "*$app\start-widget.vbs*") 'saqme: link registered'
  Check ((Get-ItemProperty "$reg\Classes\AppUserModelId\Saqme.ToDo").DisplayName -eq 'Saqme To Do') 'notification identity'
  Check ((Get-ItemProperty "$reg\Microsoft\Windows\CurrentVersion\Uninstall\SaqmeToDo").UninstallString -like "*$app\setup.ps1*-Uninstall*") 'Settings > Apps entry'

  Write-Host 're-run (idempotent, never overwrites lists)'
  [IO.File]::WriteAllText((Join-Path $data 'lists\Work.md'), "- [ ] edited since ^abcdefgh`n", $utf8)
  $r = Invoke-Setup -SkipCloud -NoStart -Import $old -Yes   # -SkipCloud: accepted, the default
  Check ($r.Code -eq 0) 're-run with -SkipCloud (now the default) exit code 0'
  Check ((Get-Content (Join-Path $data 'lists\Work.md') -Raw) -match 'edited since') 'existing list kept'
  Check ($r.Out -match 'kept the existing Work.md') 'told the user it kept it'

  Write-Host 'uninstall (keeps data), then purge'
  $r = Invoke-Setup -Uninstall
  Check ($r.Code -eq 0) 'uninstall exit code 0'
  Start-Sleep -Seconds 4
  Check (-not (Test-Path $app)) 'app folder removed'
  Check (-not (Test-Path (Join-Path $sb 'StartMenu\Saqme To Do.lnk'))) 'shortcut removed'
  Check (-not (Test-Path "$reg\Classes\saqme")) 'saqme: link removed'
  Check (Test-Path (Join-Path $data 'lists\Work.md')) 'lists kept'
  $r = Invoke-Setup -Uninstall -PurgeData
  Check (-not (Test-Path $data)) 'data purged with -PurgeData'

  Write-Host 'cloud options'
  # a stand-in for node that prints what the cloud setup would have been given
  $fakeNode = Join-Path $sb 'fake-node.cmd'
  [IO.File]::WriteAllText($fakeNode, "@echo off`r`nif ""%~1""==""--version"" (echo v22.13.0& exit /b 0)`r`necho FAKE-CLOUD %*`r`nif defined FAKE_NODE_EXIT exit /b %FAKE_NODE_EXIT%`r`nexit /b 0`r`n", $utf8)
  $env:SAQME_SETUP_NODE = $fakeNode
  $r = Invoke-Setup -RotateToken -NoStart
  Check ($r.Code -eq 0 -and $r.Out -match 'FAKE-CLOUD .*cloud-setup\.mjs.*--rotate-token') '-RotateToken alone runs the cloud part (the old key is replaced)'
  $r = Invoke-Setup -DeviceLogin -CloudOnly
  Check ($r.Code -eq 0 -and $r.Out -match 'FAKE-CLOUD .*--device-login') '-DeviceLogin reaches the cloud part'
  $r = Invoke-Setup -NoStart
  Check ($r.Out -notmatch 'FAKE-CLOUD') 'no cloud part without asking for it'
  # the app's Settings > Sync > Set up sync
  $result = Join-Path $sb 'result.json'
  $r = Invoke-Setup -FromApp -ResultFile $result
  Check ($r.Code -eq 0 -and $r.Out -match 'FAKE-CLOUD .*--result' -and $r.Out -notmatch 'Desktop app') 'from the app: only the cloud part, told where to report'
  Check ((Test-Path $result) -and (Get-Content $result -Raw) -match '"ok":\s*true') 'it reports success'
  Remove-Item $result
  $env:FAKE_NODE_EXIT = '1'
  $r = Invoke-Setup -FromApp -ResultFile $result
  Remove-Item Env:\FAKE_NODE_EXIT
  Check ($r.Code -ne 0 -and (Test-Path $result) -and (Get-Content $result -Raw) -match '"ok":\s*false') 'a cloud part that stops reports failure'
  Remove-Item Env:\SAQME_SETUP_NODE

  Write-Host 'argument checks'
  $r = Invoke-Setup -SkipCloud -CloudOnly
  Check ($r.Code -ne 0 -and $r.Out -match 'cannot be combined') 'conflicting switches are refused'
  $r = Invoke-Setup -SkipCloud -Cloud
  Check ($r.Code -ne 0 -and $r.Out -match 'cannot be combined') '-SkipCloud with -Cloud is refused too'
  $r = Invoke-Setup -NoStart -Import (Join-Path $sb 'nope')
  $okImport = $r.Code -ne 0 -and $r.Out -match 'does not exist'
  Check $okImport 'missing import folder explained'
  if (-not $okImport) { Write-Host "       exit $($r.Code):`n$(($r.Out -split "`n" | Select-Object -Last 12) -join "`n")" }
} finally {
  Remove-Item -Path $reg -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sb -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ''
if ($failed) { Write-Host "$failed check(s) FAILED" -ForegroundColor Red; exit 1 } else { Write-Host 'setup checks passed' }
