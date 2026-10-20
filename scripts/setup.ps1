<#
.SYNOPSIS
  Installs or updates Saqme To Do on Windows. Your lists stay on this PC; with -Cloud it also sets up sync
  with your phone and other computers through your own free Cloudflare account. Safe to run again at any time.

.DESCRIPTION
  Desktop app  -> %LOCALAPPDATA%\Programs\SaqmeToDo   (scripts + icons; replaced on every run)
  Your data    -> %APPDATA%\SaqmeToDo                 (lists, settings, sync state; never deleted unless -PurgeData)
  Also registers: notifications (app identity), the saqme: link used by notifications, a Start menu
  shortcut, "start with Windows" and an entry in Settings > Apps.
  Cloud part   -> needs Node.js (offered via winget) and one browser click to log in to Cloudflare.

.EXAMPLE
  .\setup.cmd                           the desktop app, lists on this PC (no account needed)
  .\setup.cmd -Cloud                    the app + cloud sync + QR code for the phone (adds or updates sync)
  .\setup.cmd -CloudOnly                (re)do only the cloud part
  .\setup.cmd -Import "D:\lists"        also copy lists (*.md) from another folder (copies, never moves)
  .\setup.cmd -RotateToken -CloudOnly   new access key: the old one stops working (pair your devices again)
  .\setup.cmd -Uninstall                remove the app (keeps your lists; -PurgeData deletes them too)
  (The app's Settings > Sync > Set up sync runs: setup.ps1 -FromApp -ResultFile <file>, the cloud part only.)
#>
[CmdletBinding()]
param(
  [string]$Import,
  [switch]$Cloud,
  [switch]$SkipCloud,   # the default; accepted for compatibility
  [switch]$CloudOnly,
  [switch]$Uninstall,
  [switch]$PurgeData,
  [switch]$NoStart,
  [switch]$NoAutostart,
  [switch]$RotateToken,
  [switch]$DeviceLogin,
  [switch]$Yes,
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,40}$')][string]$WorkerName = 'saqme',
  [string]$Source,
  [switch]$FromApp,       # started by the app (Settings > Sync > Set up sync): the cloud part, window stays readable
  [string]$ResultFile,    # how it ended, as JSON, for the app: { ok, url } or { ok: false, message, next }
  [string]$DataDir        # the app's data folder, when it is not the usual one (the app passes its own)
)
if ($FromApp) { $CloudOnly = $true }
$SetupOptions = @($PSBoundParameters.GetEnumerator() | Where-Object { $_.Key -notin 'FromApp', 'ResultFile', 'DataDir' } |
  ForEach-Object { if ($_.Value -is [System.Management.Automation.SwitchParameter]) { "-$($_.Key)" } else { "-$($_.Key) `"$($_.Value)`"" } }) -join ' '
$ErrorActionPreference = 'Stop'
Set-StrictMode -Off

# GitHub repository used when this script runs on its own (irm ... | iex): change it in a fork.
$Repo = 'francuza9/saqme-to-do'
$Branch = 'main'

$AppName = 'Saqme To Do'
$AppId = 'Saqme.ToDo'
$AppDir = Join-Path $env:LOCALAPPDATA 'Programs\SaqmeToDo'
if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA 'SaqmeToDo' }
$Instance = 'Local\SaqmeToDo'
$Reg = 'HKCU:\Software'
$StartMenuDir = [Environment]::GetFolderPath('Programs')
$StartupDir = [Environment]::GetFolderPath('Startup')
if ($env:SAQME_SETUP_SANDBOX) {
  # tests (scripts/dev/test-setup.ps1): every path, shortcut and registry key goes into a throw-away place
  $sb = $env:SAQME_SETUP_SANDBOX
  $AppDir = Join-Path $sb 'Programs\SaqmeToDo'; $DataDir = Join-Path $sb 'AppData\SaqmeToDo'; $Instance = 'Local\SaqmeToDo.Sandbox'
  $Reg = 'HKCU:\Software\SaqmeSetupSandbox'; $StartMenuDir = Join-Path $sb 'StartMenu'; $StartupDir = Join-Path $sb 'Startup'
  New-Item -ItemType Directory -Path $StartMenuDir, $StartupDir -Force | Out-Null
}
$UninstallKey = "$Reg\Microsoft\Windows\CurrentVersion\Uninstall\SaqmeToDo"
$StartMenuLnk = Join-Path $StartMenuDir "$AppName.lnk"
$StartupLnk = Join-Path $StartupDir "$AppName.lnk"
$AppFiles = @('widget.ps1', 'tokens.ps1', 'rules.ps1', 'a11y.cs', 'sync-core.ps1', 'sync-worker.ps1', 'qr.ps1', 'start-widget.vbs')

# ---------------------------------------------------------------- console helpers
function Write-Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Magenta }
function Write-Ok([string]$text) { Write-Host "   ok  $text" -ForegroundColor Green }
function Write-Info([string]$text) { Write-Host "       $text" }
function Write-Warn([string]$text) { Write-Host "   !!  $text" -ForegroundColor Yellow }
function Write-Result([bool]$ok, [string]$message = '', [string]$next = '') {
  if (-not $ResultFile) { return }
  $r = $(if ($ok) { @{ ok = $true } } else { @{ ok = $false; message = $message; next = $next } })
  try { [IO.File]::WriteAllText($ResultFile, ($r | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false))) } catch {}
}
# the window the app opened stays until it has been read
function Wait-Close([bool]$ok) {
  if (-not $FromApp -or $env:SAQME_SETUP_SANDBOX) { return }
  Write-Host ''
  if ($ok) { Write-Host 'Done. The app shows the QR code for your phone. This window closes in 20 seconds.'; Start-Sleep -Seconds 20 }
  else { [void](Read-Host 'Nothing was changed on this PC. Press Enter to close this window') }
}
function Stop-Setup([string]$what, [string]$next) {
  Write-Host ''
  Write-Host "Setup stopped: $what" -ForegroundColor Red
  if ($next) { Write-Host "What to do: $next" }
  Write-Host 'Running setup again is safe - finished steps are skipped.'
  Write-Result $false $what $next
  Wait-Close $false
  exit 1
}
# this setup with other options: setup.cmd where there is one, else the one-liner from the web
function Get-SetupCommand([string]$options) {
  if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\setup.cmd'))) { return "setup.cmd $options" }
  $u = "https://raw.githubusercontent.com/$Repo/$Branch/scripts/setup.ps1"
  return "powershell -NoProfile -ExecutionPolicy Bypass -Command `"& ([scriptblock]::Create((irm $u))) $options`""
}
# Inside an MSIX-packaged app (a Store app's terminal, an AI assistant's shell in a desktop app) Windows gives
# AppData and HKCU a private copy per package: what setup wrote there (the data folder, registry entries) would
# be invisible to the app started from the Start menu. Returns the package's name, or '' outside one.
function Get-PackageContext {
  if ($env:SAQME_SETUP_SANDBOX -and $env:SAQME_TEST_PACKAGE) { return $env:SAQME_TEST_PACKAGE }   # tests
  try {
    Add-Type -Namespace SaqmeSetup -Name Package -ErrorAction Stop -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetCurrentPackageFullName(ref int length, System.Text.StringBuilder name);'
    $len = 0
    if ([SaqmeSetup.Package]::GetCurrentPackageFullName([ref]$len, $null) -ne 122) { return '' }   # 15700: no package
    $name = New-Object System.Text.StringBuilder ($len + 1)
    [void][SaqmeSetup.Package]::GetCurrentPackageFullName([ref]$len, $name)
    return $name.ToString()
  } catch { return '' }   # no such API (Windows 7): never packaged
}
function Assert-NotPackaged {
  $pkg = Get-PackageContext
  if (-not $pkg) { return }
  $what = "Setup is running inside another app's package ($pkg), for example a terminal or an AI assistant started from that app. Windows keeps what such a program writes to AppData and the registry in that app's private copy, so Saqme started from the Start menu would not find it."
  if ($FromApp) { Stop-Setup $what 'Quit Saqme (tray icon > Quit), start it from the Start menu, then choose Set up sync again.' }
  $cmd = $(if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\setup.cmd'))) { "`"$([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\setup.cmd')))`" $SetupOptions" } else { Get-SetupCommand $SetupOptions })
  Stop-Setup $what "Run it from a normal window instead: double-click setup.cmd in File Explorer, or press Win+R and run: $($cmd.Trim())"
}
function Confirm-Step([string]$question) {
  if ($Yes) { return $true }
  $a = Read-Host "       $question [Y/n]"
  return (-not $a) -or ($a -match '^(y|yes|j|ja)$')
}

# ---------------------------------------------------------------- source files
# Run from a clone or an extracted zip: use it in place. Run from the web (irm | iex): download the zip.
function Get-SourceDir {
  if ($Source) { return (Resolve-Path $Source).Path }
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\desktop\widget.ps1'))) { return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
  $dest = Join-Path $AppDir 'source'
  $zip = Join-Path $env:TEMP "saqme-$([guid]::NewGuid().ToString('N').Substring(0, 8)).zip"
  $url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
  Write-Info "downloading $url"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  } catch { Stop-Setup "could not download Saqme To Do ($($_.Exception.Message))." 'Check the internet connection, or download the zip from GitHub, extract it and run setup.cmd from there.' }
  $tmp = Join-Path $env:TEMP "saqme-src-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  Remove-Item -LiteralPath $zip -Force
  $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  # keep worker\node_modules from an earlier run (saves a minute); everything else is replaced
  if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
  Get-ChildItem -LiteralPath $dest -Force | Where-Object { $_.Name -ne 'worker' } | Remove-Item -Recurse -Force
  if (Test-Path (Join-Path $dest 'worker')) { Get-ChildItem -LiteralPath (Join-Path $dest 'worker') -Force | Where-Object { $_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force }
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $dest -Recurse -Force
  Remove-Item -LiteralPath $tmp -Recurse -Force
  Get-ChildItem -LiteralPath $dest -Recurse -File | Unblock-File
  return $dest
}

# ---------------------------------------------------------------- running app
function Test-AppRunning {
  $m = $null
  if ([System.Threading.Mutex]::TryOpenExisting("$Instance.Instance", [ref]$m)) { $m.Dispose(); return $true }
  return $false
}
function Stop-App {
  if (-not (Test-AppRunning)) { return }
  Write-Info 'closing the running app (it saves first)...'
  $quit = $null
  if ([System.Threading.EventWaitHandle]::TryOpenExisting("$Instance.Quit", [ref]$quit)) { [void]$quit.Set(); $quit.Dispose() }
  for ($i = 0; $i -lt 40 -and (Test-AppRunning); $i++) { Start-Sleep -Milliseconds 250 }
  if (Test-AppRunning) {
    # older builds without the quit signal: stop the process that runs our widget.ps1
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*$AppDir\widget.ps1*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
  }
  Write-Ok 'app closed'
}
function Start-App {
  # the sandbox's app gets the sandbox's name and data folder (the launcher passes the environment on), so it
  # never takes the real app's place or touches its lists; scripts/dev/test-setup.ps1 quits it afterwards
  if ($env:SAQME_SETUP_SANDBOX) { $env:SAQME_INSTANCE = $Instance; $env:SAQME_DATA_DIR = $DataDir }
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $AppDir 'start-widget.vbs') + '"')
  Write-Ok 'app started (look for the icon in the notification area)'
}
# ---------------------------------------------------------------- install
function New-Shortcut([string]$path, [string]$description) {
  $sh = New-Object -ComObject WScript.Shell
  $l = $sh.CreateShortcut($path)
  $l.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $l.Arguments = '"' + (Join-Path $AppDir 'start-widget.vbs') + '"'
  $l.WorkingDirectory = $AppDir
  $l.IconLocation = (Join-Path $AppDir 'assets\saqme.ico') + ',0'
  $l.Description = $description
  $l.Save()
}

function Install-App([string]$src) {
  Write-Step 'Desktop app'
  Stop-App
  New-Item -ItemType Directory -Path $AppDir, (Join-Path $AppDir 'assets'), (Join-Path $AppDir 'fonts'), $DataDir -Force | Out-Null
  foreach ($f in $AppFiles) { Copy-Item -LiteralPath (Join-Path $src "desktop\$f") -Destination (Join-Path $AppDir $f) -Force }
  Copy-Item -Path (Join-Path $src 'desktop\assets\*') -Destination (Join-Path $AppDir 'assets') -Force
  # the same FiraGO files the phone app serves (OFL, see fonts\OFL.txt); the widget falls back to Segoe UI without them
  Copy-Item -Path (Join-Path $src 'worker\public\fonts\*') -Destination (Join-Path $AppDir 'fonts') -Force
  Copy-Item -LiteralPath (Join-Path $src 'scripts\setup.ps1') -Destination (Join-Path $AppDir 'setup.ps1') -Force
  Get-ChildItem -LiteralPath $AppDir -Recurse -File | Unblock-File
  Write-Ok "installed to $AppDir"
  # sanity check before anything points at it: the widget builds all its views headlessly
  $check = & powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File (Join-Path $AppDir 'widget.ps1') -DataDir (Join-Path $env:TEMP "saqme-selftest-$PID") -SmokeTest 2>&1
  Remove-Item -LiteralPath (Join-Path $env:TEMP "saqme-selftest-$PID") -Recurse -Force -ErrorAction SilentlyContinue
  if (($check -join "`n") -notmatch 'SMOKE OK') { Stop-Setup "the app failed its self-check:`n$($check -join "`n")" 'Please open an issue on GitHub with this message.' }
  Write-Ok 'self-check passed'
}

function Register-Windows {
  Write-Step 'Windows integration'
  # app identity for notifications (name + icon on the toast) and permission to show banners
  $k = "$Reg\Classes\AppUserModelId\$AppId"
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty -Path $k -Name DisplayName -Value $AppName
  Set-ItemProperty -Path $k -Name IconUri -Value (Join-Path $AppDir 'assets\saqme.png')
  Set-ItemProperty -Path $k -Name IconBackgroundColor -Value 'FF1E1A23'
  $n = "$Reg\Microsoft\Windows\CurrentVersion\Notifications\Settings\$AppId"
  New-Item -Path $n -Force | Out-Null
  Set-ItemProperty -Path $n -Name Enabled -Value 1 -Type DWord
  Set-ItemProperty -Path $n -Name ShowInActionCenter -Value 1 -Type DWord
  Write-Ok 'notifications allowed'
  # saqme:open -> brings the app up (or starts it); clicking a notification uses it. saqme://join?... (a shared
  # list's invite page) is handed to the app (start-widget.vbs), which asks before it joins
  $p = "$Reg\Classes\saqme"
  New-Item -Path "$p\shell\open\command" -Force | Out-Null
  New-Item -Path "$p\DefaultIcon" -Force | Out-Null
  Set-ItemProperty -Path $p -Name '(default)' -Value "URL:$AppName"
  Set-ItemProperty -Path $p -Name 'URL Protocol' -Value ''
  Set-ItemProperty -Path "$p\DefaultIcon" -Name '(default)' -Value (Join-Path $AppDir 'assets\saqme.ico')
  Set-ItemProperty -Path "$p\shell\open\command" -Name '(default)' -Value ('"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" "' + (Join-Path $AppDir 'start-widget.vbs') + '" "%1"')
  Write-Ok 'saqme: links registered (notifications, invites to shared lists)'
  New-Shortcut $StartMenuLnk $AppName
  Write-Ok 'Start menu shortcut'
  if ($NoAutostart) { Write-Info 'start with Windows: left as it was (-NoAutostart)' }
  else { New-Shortcut $StartupLnk $AppName; Write-Ok 'starts with Windows (switch off in the app: Settings > Startup)' }
  # Settings > Apps entry
  New-Item -Path $UninstallKey -Force | Out-Null
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $vals = @{ DisplayName = $AppName; Publisher = 'Saqme To Do (open source)'; DisplayIcon = (Join-Path $AppDir 'assets\saqme.ico'); InstallLocation = $AppDir
             UninstallString = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $AppDir 'setup.ps1')`" -Uninstall"; NoModify = 1; NoRepair = 1 }
  foreach ($key in $vals.Keys) { Set-ItemProperty -Path $UninstallKey -Name $key -Value $vals[$key] }
  Write-Ok 'listed in Settings > Apps'
  $g = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -ErrorAction SilentlyContinue
  if ($g -and $g.ToastEnabled -eq 0) { Write-Warn 'Windows notifications are switched off globally (Settings > System > Notifications).' }
}

# copies lists from an older install; never overwrites, moves or deletes anything
function Import-Lists([string]$from) {
  Write-Step "Importing lists from $from"
  if (-not (Test-Path -LiteralPath $from)) { Stop-Setup "the folder $from does not exist." 'Pass the folder of the old install (the one that contains "lists").' }
  $srcLists = $(if (Test-Path -LiteralPath (Join-Path $from 'lists')) { Join-Path $from 'lists' } else { $from })
  $srcRoot = $(if ($srcLists -ne $from) { $from } else { Split-Path -Parent $from })
  $files = @(Get-ChildItem -LiteralPath $srcLists -Filter *.md -File | Where-Object { -not $_.Name.StartsWith('.') })
  if (-not $files.Count) { Stop-Setup "no lists (*.md) found in $srcLists." 'Point -Import at the old install folder or its "lists" folder.' }
  $dest = Join-Path $DataDir 'lists'
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  $copied = 0; $skipped = 0
  foreach ($f in $files) {
    $target = Join-Path $dest $f.Name
    $empty = (Test-Path -LiteralPath $target) -and -not ((Get-Content -LiteralPath $target -Raw -ErrorAction SilentlyContinue) -match '\S')
    if ((Test-Path -LiteralPath $target) -and -not $empty) { Write-Warn "kept the existing $($f.Name) (not overwritten)"; $skipped++; continue }
    Copy-Item -LiteralPath $f.FullName -Destination $target -Force
    $copied++
  }
  foreach ($extra in @(@($srcLists, '.order', $dest), @($srcLists, '.state', $dest), @($srcRoot, '.widget-settings', $DataDir), @($srcRoot, '.widget-pos', $DataDir))) {
    $s = Join-Path $extra[0] $extra[1]; $t = Join-Path $extra[2] $extra[1]
    if ((Test-Path -LiteralPath $s) -and -not (Test-Path -LiteralPath $t)) { Copy-Item -LiteralPath $s -Destination $t }
  }
  if ((Test-Path -LiteralPath (Join-Path $srcLists '.order')) -and $copied) {
    # make sure imported lists keep their tab order even if a default list already existed
    $order = @(Get-Content -LiteralPath (Join-Path $srcLists '.order') | Where-Object { $_ })
    $cur = @(Get-Content -LiteralPath (Join-Path $dest '.order') -ErrorAction SilentlyContinue | Where-Object { $_ })
    $merged = @($order + @($cur | Where-Object { $order -notcontains $_ }))
    [IO.File]::WriteAllText((Join-Path $dest '.order'), (($merged -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Ok "$copied list(s) copied$(if ($skipped) { ", $skipped already here" }) - the old folder was not changed"
}

# ---------------------------------------------------------------- cloud
function Find-Node {
  if ($env:SAQME_SETUP_SANDBOX -and $env:SAQME_SETUP_NODE) { return $env:SAQME_SETUP_NODE }   # tests: a stand-in
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  $v = & $node.Source --version 2>$null
  if ($v -match '^v(\d+)\.' -and [int]$matches[1] -ge 22) { return $node.Source }   # what wrangler needs
  return $null
}

function Install-Node {
  $node = Find-Node
  if ($node) { Write-Ok "Node.js $(& $node --version)"; return $node }
  Write-Info 'Sync setup needs Node.js 22 or newer (only for setting up / updating the cloud part).'
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { Stop-Setup 'Node.js 22 or newer is missing and winget is not available.' "Install the LTS version from https://nodejs.org, then run: $(Get-SetupCommand '-CloudOnly')" }
  Write-Info 'winget installs it for all users, so Windows may ask for administrator approval.'
  if (-not (Confirm-Step 'Install Node.js LTS now with winget?')) { Stop-Setup 'Node.js is needed for the cloud part.' "Install it from https://nodejs.org (LTS), then run: $(Get-SetupCommand '-CloudOnly')" }
  & $winget.Source install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $node = Find-Node
  if (-not $node) { Stop-Setup 'Node.js was installed but is not visible yet.' "Close this window, open a new one and run: $(Get-SetupCommand '-CloudOnly')" }
  Write-Ok "Node.js $(& $node --version) installed"
  return $node
}

function Install-Cloud([string]$src) {
  Write-Step 'Cloud sync (your own Cloudflare account, free plan)'
  $node = Install-Node
  $nodeArgs = @((Join-Path $src 'scripts\cloud-setup.mjs'), '--state', (Join-Path $DataDir 'cloud.json'), '--desktop-config', (Join-Path $DataDir 'sync\config.json'), '--worker-name', $WorkerName)
  if ($RotateToken) { $nodeArgs += '--rotate-token' }
  if ($DeviceLogin) { $nodeArgs += '--device-login' }
  if ($Yes) { $nodeArgs += '--yes' }
  if ($ResultFile) { $nodeArgs += @('--result', $ResultFile) }
  & $node @nodeArgs
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    # cloud-setup.mjs already explained what to do (and wrote the result, unless it was stopped)
    if ($ResultFile -and -not (Test-Path -LiteralPath $ResultFile)) { Write-Result $false 'The cloud setup did not finish.' 'Run it again; the window shows where it stopped.' }
    Wait-Close $false
    exit $code
  }
}

# ---------------------------------------------------------------- uninstall
function Uninstall-App {
  Write-Step "Removing $AppName"
  Stop-App
  foreach ($p in @($StartMenuLnk, $StartupLnk)) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force } }
  foreach ($k in @("$Reg\Classes\AppUserModelId\$AppId", "$Reg\Microsoft\Windows\CurrentVersion\Notifications\Settings\$AppId", "$Reg\Classes\saqme", $UninstallKey)) {
    if (Test-Path $k) { Remove-Item -Path $k -Recurse -Force }
  }
  if (Test-Path -LiteralPath $AppDir) {
    # this script may be running from inside AppDir: remove the rest now, the folder itself right after we exit
    Get-ChildItem -LiteralPath $AppDir -Force | Where-Object { $_.FullName -ne $PSCommandPath } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$AppDir`""
  }
  Write-Ok 'app, shortcuts and Windows integration removed'
  if ($PurgeData) {
    if (Test-Path -LiteralPath $DataDir) { Remove-Item -LiteralPath $DataDir -Recurse -Force }
    Write-Ok "your data was deleted ($DataDir)"
  } else {
    Write-Info "Your lists are still in $DataDir (delete that folder, or run again with -PurgeData)."
  }
  Write-Info 'The cloud part stays in your Cloudflare account; see docs/setup.md ("Removing everything") to delete it.'
}

# ---------------------------------------------------------------- main
Write-Host ''
Write-Host "  $AppName setup" -ForegroundColor Magenta
Assert-NotPackaged
if ($Uninstall) { Uninstall-App; exit 0 }
if ($SkipCloud -and ($Cloud -or $CloudOnly)) { Stop-Setup '-SkipCloud cannot be combined with -Cloud or -CloudOnly.' 'Pick one (without -Cloud, setup leaves sync out anyway).' }
$withCloud = $Cloud -or $CloudOnly -or $RotateToken -or $DeviceLogin   # those two only make sense with it

$src = Get-SourceDir
if (-not $CloudOnly) {
  Install-App $src
  Register-Windows
  if ($Import) { Import-Lists $Import }
}
if ($withCloud) { Install-Cloud $src }
else {
  Write-Host ''
  if (Test-Path -LiteralPath (Join-Path $DataDir 'sync\config.json')) { Write-Info "Cloud sync stays on (set up earlier). To update it as well: $(Get-SetupCommand '-Cloud')" }
  else {
    Write-Info 'Your lists stay on this PC. To have them on your phone too: in the app, Settings > Sync > Set up sync.'
    Write-Info "(or run: $(Get-SetupCommand '-Cloud'); a device that already syncs: paste its pairing link there)"
  }
}
if (-not $CloudOnly -and -not $NoStart) { Write-Step 'Starting'; Start-App }
elseif ($CloudOnly -and (Test-AppRunning)) { Write-Info 'The running app picks up the sync settings by itself within a few seconds.' }
elseif ($CloudOnly) { Start-App }
Write-Host ''
Write-Host 'All done.' -ForegroundColor Green
if ($withCloud -and $ResultFile -and -not (Test-Path -LiteralPath $ResultFile)) { Write-Result $true }
Wait-Close $true
