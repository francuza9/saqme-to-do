# Runs scripts/setup.ps1 end to end in a sandbox: install over an install before 1.1.0 + import, re-run, the
# updater (an update, a download that does not match, a version that does not start), uninstall, purge.
# Nothing real is touched (paths, shortcuts and registry keys are redirected by SAQME_SETUP_SANDBOX).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\test-setup.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ver = (Get-Content -LiteralPath (Join-Path $root 'worker\package.json') -Raw | ConvertFrom-Json).version
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

# The app setup starts here runs under the sandbox's own instance name and data folder (never the real
# Local\SaqmeToDo, which a real install would then only "show"); every case that starts it quits it again.
$sbInstance = 'Local\SaqmeToDo.Sandbox'
function Test-SandboxApp { $m = $null; if ([System.Threading.Mutex]::TryOpenExisting("$sbInstance.Instance", [ref]$m)) { $m.Dispose(); return $true }; return $false }
function Stop-SandboxApp {
  $q = $null
  if ([System.Threading.EventWaitHandle]::TryOpenExisting("$sbInstance.Quit", [ref]$q)) { [void]$q.Set(); $q.Dispose() }
  for ($i = 0; $i -lt 40 -and (Test-SandboxApp); $i++) { Start-Sleep -Milliseconds 250 }
  # and anything else still running from the sandbox's app folder (a widget that never got that far)
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*$app\*widget.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Wait-SandboxApp { for ($i = 0; $i -lt 80 -and -not (Test-SandboxApp); $i++) { Start-Sleep -Milliseconds 250 }; return (Test-SandboxApp) }
function Get-Pointer([string]$name) { $p = Join-Path $app $name; if (Test-Path -LiteralPath $p) { return ([IO.File]::ReadAllText($p)).Trim() }; return '' }

# A release as scripts/build-release.mjs makes it (saqme-X.Y.Z.zip with its folder inside, and its manifest),
# from this repository with another version. -Broken: it passes its self-check but does not start. -BadSum: the
# manifest's checksum is not the zip's.
Add-Type -AssemblyName System.IO.Compression.FileSystem
function New-TestRelease([string]$version, [switch]$Broken, [switch]$BadSum) {
  $dir = Join-Path $sb "release-$version"; $tree = Join-Path $dir "saqme-$version"
  foreach ($p in 'setup.cmd', 'LICENSE', 'desktop', 'scripts\setup.ps1', 'scripts\cloud-setup.mjs', 'worker\src', 'worker\public', 'worker\migrations', 'worker\package.json', 'worker\package-lock.json', 'worker\wrangler.toml.template') {
    $to = Join-Path $tree $p
    New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root $p) -Destination $to -Recurse -Force
  }
  $pj = Join-Path $tree 'worker\package.json'
  [IO.File]::WriteAllText($pj, ([regex]'"version":\s*"[^"]*"').Replace([IO.File]::ReadAllText($pj), "`"version`": `"$version`"", 1), $utf8)
  if ($Broken) {
    $wp = Join-Path $tree 'desktop\widget.ps1'
    $lines = [IO.File]::ReadAllLines($wp)
    [IO.File]::WriteAllLines($wp, [string[]](@($lines[0], 'if (-not $SmokeTest) { exit 1 }') + $lines[1..($lines.Count - 1)]), $utf8)
  }
  $zip = Join-Path $dir "saqme-$version.zip"
  [IO.Compression.ZipFile]::CreateFromDirectory($tree, $zip, [IO.Compression.CompressionLevel]::Fastest, $true)
  $sha = $(if ($BadSum) { '0' * 64 } else { (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() })
  $m = @{ schema = 1; version = $version; tag = "v$version"; api = 3; minWorkerApi = 1; asset = @{ name = "saqme-$version.zip"; size = (Get-Item -LiteralPath $zip).Length; sha256 = $sha } }
  $mf = Join-Path $dir 'saqme-release.json'
  [IO.File]::WriteAllText($mf, ($m | ConvertTo-Json -Depth 4), $utf8)
  return @{ Manifest = $mf; Asset = $zip }
}
# what the app's Update now runs: the installed version's update.ps1 (without the Worker part: there is none here)
function Invoke-Updater([string]$from, $rel) {
  $ErrorActionPreference = 'Continue'
  $rf = Join-Path $app 'update\result.json'
  Remove-Item -LiteralPath $rf -Force -ErrorAction SilentlyContinue
  Push-Location -LiteralPath $sb
  try { $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app "versions\$from\update.ps1") -AppDir $app -DataDir $data -NoWorker -Manifest $rel.Manifest -Asset $rel.Asset 2>&1 | Out-String } finally { Pop-Location }
  $res = $null
  if (Test-Path -LiteralPath $rf) { $res = Get-Content -LiteralPath $rf -Raw | ConvertFrom-Json }
  return @{ Code = $LASTEXITCODE; Out = $out; Result = $res }
}

# lists in another folder to import (without ids)
$old = Join-Path $sb 'old\todo'
New-Item -ItemType Directory -Path (Join-Path $old 'lists') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $old 'lists\Work.md'), "# Work`n- [/] ship it due:2026-10-25T14:00`n  - [ ] sub`n", $utf8)
[IO.File]::WriteAllText((Join-Path $old 'lists\Home.md'), "- [ ] groceries`n", $utf8)
[IO.File]::WriteAllText((Join-Path $old 'lists\.order'), "Work`nHome`n", $utf8)
[IO.File]::WriteAllText((Join-Path $old '.widget-settings'), "theme=light`nnotifyAt=9:30`n", $utf8)
$oldHash = (Get-ChildItem $old -Recurse -File | Get-FileHash | ForEach-Object { $_.Hash }) -join ','

try {
  Write-Host 'install over an install before 1.1.0 (all files in one folder) + import'
  # what such an install leaves: its files in the app folder, the downloaded repository with wrangler in source\
  New-Item -ItemType Directory -Path (Join-Path $app 'source\worker\node_modules\wrangler'), (Join-Path $app 'cache') -Force | Out-Null
  foreach ($f in 'widget.ps1', 'sync-core.ps1', 'qr.ps1') { [IO.File]::WriteAllText((Join-Path $app $f), '# 1.0.x', $utf8) }
  [IO.File]::WriteAllText((Join-Path $app 'source\worker\node_modules\wrangler\marker.txt'), 'kept', $utf8)
  $r = Invoke-Setup -NoStart -Import $old -Yes
  Check ($r.Code -eq 0) "setup exit code 0`n$($r.Out)"
  Check ($r.Out -notmatch 'Cloudflare account' -and $r.Out -match 'Settings > Sync > Set up sync' -and $r.Out -match 'setup.cmd -Cloud') 'sync left out by default, with a hint how to add it'
  $vdir = Join-Path $app "versions\$ver"
  foreach ($f in 'widget.ps1', 'tokens.ps1', 'rules.ps1', 'a11y.cs', 'sync-core.ps1', 'sync-worker.ps1', 'qr.ps1', 'start-widget.vbs', 'update.ps1', 'update-core.ps1', 'setup.ps1', 'release.json', 'assets\saqme.ico', 'fonts\FiraGO-Regular.ttf', 'fonts\OFL.txt') { Check (Test-Path (Join-Path $vdir $f)) "app file versions\$ver\$f" }
  foreach ($f in 'start-widget.vbs', 'setup.ps1', 'assets\saqme.ico', 'cloud\scripts\cloud-setup.mjs', 'cloud\worker\src\index.js', 'cloud\worker\package.json') { Check (Test-Path (Join-Path $app $f)) "install file $f" }
  Check ((Get-Pointer 'current.txt') -eq $ver) "current.txt names $ver"
  Check ((Get-Content (Join-Path $vdir 'release.json') -Raw | ConvertFrom-Json).version -eq $ver) 'release.json has the version of worker\package.json'
  Check (-not (Test-Path (Join-Path $app 'widget.ps1')) -and -not (Test-Path (Join-Path $app 'source')) -and -not (Test-Path (Join-Path $app 'cache'))) 'the files of the install before 1.1.0 are gone'
  Check (Test-Path (Join-Path $app 'cloud\worker\node_modules\wrangler\marker.txt')) '... its wrangler moved to cloud\ (not downloaded again)'
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
  Check ((Get-ItemProperty "$reg\Classes\saqme\shell\open\command").'(default)' -like '*" "%1"') 'saqme: links (invites to shared lists) reach the app'
  Check ((Get-ItemProperty "$reg\Classes\AppUserModelId\Saqme.ToDo").DisplayName -eq 'Saqme To Do') 'notification identity'
  Check ((Get-ItemProperty "$reg\Microsoft\Windows\CurrentVersion\Uninstall\SaqmeToDo").UninstallString -like "*$app\setup.ps1*-Uninstall*") 'Settings > Apps entry'

  Write-Host 're-run (idempotent, never overwrites lists)'
  [IO.File]::WriteAllText((Join-Path $data 'lists\Work.md'), "- [ ] edited since ^abcdefgh`n", $utf8)
  $r = Invoke-Setup -SkipCloud -NoStart -Import $old -Yes   # -SkipCloud: accepted, the default
  Check ($r.Code -eq 0) 're-run with -SkipCloud (now the default) exit code 0'
  Check ((Get-Content (Join-Path $data 'lists\Work.md') -Raw) -match 'edited since') 'existing list kept'
  Check ($r.Out -match 'kept the existing Work.md') 'told the user it kept it'
  Check ((@(Get-ChildItem -LiteralPath (Join-Path $app 'versions') -Directory | ForEach-Object { $_.Name }) -join ',') -eq $ver) 'the same version again replaced its folder (nothing left beside it)'

  Write-Host 'updates (what Settings > Updates runs)'
  $listsHash = { (Get-ChildItem (Join-Path $data 'lists') -Recurse -File | Get-FileHash | ForEach-Object { $_.Hash }) -join ',' }
  $before = & $listsHash
  $u = Invoke-Updater $ver (New-TestRelease '9.9.9')
  Check ($u.Result -and $u.Result.ok -and $u.Result.version -eq '9.9.9' -and $u.Result.from -eq $ver) "an update installs`n$($u.Out)"
  Check ((Get-Pointer 'current.txt') -eq '9.9.9' -and (Get-Pointer 'previous.txt') -eq $ver) '... switches over and keeps the version before to go back to'
  Check ((Test-Path (Join-Path $app 'versions\9.9.9\widget.ps1')) -and (Test-Path (Join-Path $app "versions\$ver\widget.ps1"))) '... both version folders there'
  Check (Wait-SandboxApp) '... and the app runs again'
  Check ((& $listsHash) -eq $before) '... the lists untouched'
  Check (-not @(Get-ChildItem -LiteralPath (Join-Path $app 'update') -Filter 'src-*' -Directory).Count -and -not @(Get-ChildItem -LiteralPath (Join-Path $app 'update') -Filter '*.zip' -File).Count) '... and nothing of the download left'
  $u = Invoke-Updater '9.9.9' (New-TestRelease '9.9.10' -BadSum)
  Check ($u.Result -and -not $u.Result.ok -and $u.Result.message -match 'checksum') 'a download that does not match the manifest is refused'
  Check ((Get-Pointer 'current.txt') -eq '9.9.9' -and (Test-SandboxApp) -and -not (Test-Path (Join-Path $app 'versions\9.9.10'))) '... the running version stays, untouched'
  $env:SAQME_TEST_WAIT_UP = '8'
  $u = Invoke-Updater '9.9.9' (New-TestRelease '9.9.11' -Broken)
  Remove-Item Env:\SAQME_TEST_WAIT_UP
  Check ($u.Result -and -not $u.Result.ok -and $u.Result.message -match 'went back to 9\.9\.9') "a version that does not start: back to the one before`n$($u.Out)"
  Check ((Get-Pointer 'current.txt') -eq '9.9.9' -and (Get-Pointer 'previous.txt') -eq $ver) '... the pointers as they were'
  Check (Wait-SandboxApp) '... and the app is back'
  Check ((& $listsHash) -eq $before) '... the lists untouched'
  Stop-SandboxApp

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
  # -CloudOnly starts the app when it isn't running: the sandbox's own copy, on the sandbox's data
  Check (Wait-SandboxApp) 'the app setup started runs under the sandbox instance name'
  $settings = Join-Path $data '.widget-settings'   # written once the window is up
  for ($i = 0; $i -lt 80 -and -not (Test-Path $settings); $i++) { Start-Sleep -Milliseconds 250 }
  Check (Test-Path $settings) '... on the sandbox data folder'
  Stop-SandboxApp
  Check (-not (Test-SandboxApp)) '... and quits when asked'
  $r = Invoke-Setup -NoStart
  Check ($r.Out -notmatch 'FAKE-CLOUD') 'no cloud part without asking for it'
  # the app's Settings > Sync > Set up sync
  $result = Join-Path $sb 'result.json'
  $r = Invoke-Setup -FromApp -ResultFile $result
  Check ($r.Code -eq 0 -and $r.Out -match 'FAKE-CLOUD .*--result' -and $r.Out -notmatch 'Desktop app') 'from the app: only the cloud part, told where to report'
  Check ((Test-Path $result) -and (Get-Content $result -Raw) -match '"ok":\s*true') 'it reports success'
  Remove-Item $result
  [void](Wait-SandboxApp); Stop-SandboxApp
  $env:FAKE_NODE_EXIT = '1'
  $r = Invoke-Setup -FromApp -ResultFile $result
  Remove-Item Env:\FAKE_NODE_EXIT
  Check ($r.Code -ne 0 -and (Test-Path $result) -and (Get-Content $result -Raw) -match '"ok":\s*false') 'a cloud part that stops reports failure'
  Remove-Item Env:\SAQME_SETUP_NODE

  Write-Host 'inside another app''s package (MSIX: private AppData and registry)'
  $env:SAQME_TEST_PACKAGE = 'Some.App_1.0.0.0_x64__test'
  $before = (Get-ChildItem -LiteralPath $sb -Recurse -Force | Measure-Object).Count
  $r = Invoke-Setup -Cloud -Yes
  $okPkg = $r.Code -ne 0 -and $r.Out -match "inside another app's package \(Some\.App" -and $r.Out -match '\\setup\.cmd" -Cloud -Yes'
  Check $okPkg 'setup stops, says why and gives the command for a normal window'
  if (-not $okPkg) { Write-Host $r.Out }
  Check ($before -eq (Get-ChildItem -LiteralPath $sb -Recurse -Force | Measure-Object).Count) '... before writing anything'
  $r = Invoke-Setup -FromApp -ResultFile $result
  Check ($r.Code -ne 0 -and (Get-Content $result -Raw) -match 'Start menu') 'from the app: it reports why, and what to do'
  Remove-Item $result -ErrorAction SilentlyContinue
  Remove-Item Env:\SAQME_TEST_PACKAGE

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
  Stop-SandboxApp
  Check (@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*$app\*widget.ps1*" }).Count -eq 0) 'no widget left running from the sandbox'
  Remove-Item -Path $reg -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sb -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ''
if ($failed) { Write-Host "$failed check(s) FAILED" -ForegroundColor Red; exit 1 } else { Write-Host 'setup checks passed' }
