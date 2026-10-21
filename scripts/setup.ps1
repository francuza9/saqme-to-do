<#
.SYNOPSIS
  Installs or updates Saqme To Do on Windows. Your lists stay on this PC; with -Cloud it also sets up sync
  with your phone and other computers through your own free Cloudflare account. Safe to run again at any time.
  Once installed, the app updates itself (Settings > Updates); you never need to run this again for that.

.DESCRIPTION
  Desktop app  -> %LOCALAPPDATA%\Programs\SaqmeToDo   (one folder per version in versions\, current.txt says which
                                                       runs; the one before is kept to go back to)
  Your data    -> %APPDATA%\SaqmeToDo                 (lists, settings, sync state; never deleted unless -PurgeData)
  Also registers: notifications (app identity), the saqme: link used by notifications, a Start menu
  shortcut, "start with Windows" and an entry in Settings > Apps.
  Cloud part   -> needs Node.js (downloaded just for Saqme when there is none) and one browser click to log in to
                  Cloudflare.

.EXAMPLE
  .\setup.cmd                           the desktop app, lists on this PC (no account needed)
  .\setup.cmd -Cloud                    the app + cloud sync + QR code for the phone (adds or updates sync)
  .\setup.cmd -CloudOnly                (re)do only the cloud part
  .\setup.cmd -Import "D:\lists"        also copy lists (*.md) from another folder (copies, never moves)
  .\setup.cmd -RotateToken -CloudOnly   new access key: the old one stops working (pair your devices again)
  .\setup.cmd -Uninstall                remove the app (keeps your lists; -PurgeData deletes them too)
  The apps run it too: Settings > Sync & sharing > Set up sync (-FromApp -ResultFile <file>, the cloud part only), and the
  updater (desktop\update.ps1: -Update -Source <release>; -WorkerUpdate; -CloudLogin).
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
  [switch]$FromApp,       # started by the app (Settings > Sync & sharing > Set up sync): the cloud part, window stays readable
  [string]$ResultFile,    # how it ended, as JSON, for the app: { ok, url } or { ok: false, message, next }
  [string]$DataDir,       # the app's data folder, when it is not the usual one (the app passes its own)
  [switch]$Update,        # the updater: install the release in -Source next to the running version, update the
                          # user's Worker, switch over, restart the app (or go back); no questions, no window
  [int]$MinWorkerApi = 1, # (with -Update) the oldest Worker API the new release works with (its manifest says)
  [switch]$NoWorker,      # (with -Update) leave the Worker as it is: tests
  [switch]$StartHidden,   # (with -Update) the new version starts in the tray only (the window was hidden)
  [switch]$WorkerUpdate,  # only the Worker part of an update that is installed already (after signing in)
  [switch]$CloudLogin     # the Cloudflare sign-in an update needs (the browser), and nothing else
)
if ($FromApp) { $CloudOnly = $true }
$SetupOptions = @($PSBoundParameters.GetEnumerator() | Where-Object { $_.Key -notin 'FromApp', 'ResultFile', 'DataDir' } |
  ForEach-Object { if ($_.Value -is [System.Management.Automation.SwitchParameter]) { "-$($_.Key)" } else { "-$($_.Key) `"$($_.Value)`"" } }) -join ' '
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # (PowerShell 5.1 downloads crawl while drawing a progress bar)
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
  $AppDir = Join-Path $sb 'Programs\SaqmeToDo'; if (-not $PSBoundParameters.ContainsKey('DataDir')) { $DataDir = Join-Path $sb 'AppData\SaqmeToDo' }; $Instance = 'Local\SaqmeToDo.Sandbox'
  $Reg = 'HKCU:\Software\SaqmeSetupSandbox'; $StartMenuDir = Join-Path $sb 'StartMenu'; $StartupDir = Join-Path $sb 'Startup'
  New-Item -ItemType Directory -Path $StartMenuDir, $StartupDir -Force | Out-Null
}
$UninstallKey = "$Reg\Microsoft\Windows\CurrentVersion\Uninstall\SaqmeToDo"
$StartMenuLnk = Join-Path $StartMenuDir "$AppName.lnk"
$StartupLnk = Join-Path $StartupDir "$AppName.lnk"
$VersionsDir = Join-Path $AppDir 'versions'
$CloudDir = Join-Path $AppDir 'cloud'     # where the user's Worker is deployed from (wrangler stays there)
$NodeDir = Join-Path $AppDir 'node'       # Node.js, when this setup downloaded it
$UpdateDir = Join-Path $AppDir 'update'
# a version's folder: these from desktop\, plus assets\, fonts\, setup.ps1 and release.json
$AppFiles = @('widget.ps1', 'tokens.ps1', 'rules.ps1', 'a11y.cs', 'sync-core.ps1', 'sync-worker.ps1', 'qr.ps1', 'start-widget.vbs', 'update.ps1', 'update-core.ps1')
# the app's files as installs before 1.1.0 kept them, all in one folder (removed once a version folder runs)
$FlatFiles = @('widget.ps1', 'tokens.ps1', 'rules.ps1', 'a11y.cs', 'sync-core.ps1', 'sync-worker.ps1', 'qr.ps1')

# ---------------------------------------------------------------- console helpers
function Write-Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Magenta }
function Write-Ok([string]$text) { Write-Host "   ok  $text" -ForegroundColor Green }
function Write-Info([string]$text) { Write-Host "       $text" }
function Write-Warn([string]$text) { Write-Host "   !!  $text" -ForegroundColor Yellow }
function Write-ResultJson($r) {
  if (-not $ResultFile) { return }
  $r['at'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  try { [IO.File]::WriteAllText($ResultFile, ($r | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding($false))) } catch {}
}
function Write-Result([bool]$ok, [string]$message = '', [string]$next = '') {
  if ($ok) { Write-ResultJson @{ ok = $true } } else { Write-ResultJson @{ ok = $false; message = $message; next = $next } }
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
  $r = @{ ok = $false; message = $what; next = $next }
  if ($Update) { $r['version'] = $script:newVersion; $r['from'] = $script:fromVersion }
  Write-ResultJson $r
  Restore-App
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
# A plain Windows path for a folder (on a \\wsl.localhost\... share Resolve-Path's .Path has
# "Microsoft.PowerShell.Core\FileSystem::" in front, which node and cmd.exe cannot open)
function Get-PlainPath([string]$p) { return (Resolve-Path -LiteralPath $p).ProviderPath }

# Run from a clone or an extracted release: use it in place. Run from the web (irm | iex): the newest release.
# The app's Set up sync (-CloudOnly from an installed version's folder): $null, the installed copy is used
# (the Worker gets the app's own version)
function Get-SourceDir {
  if ($Source) { return (Get-PlainPath $Source) }
  if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\desktop\widget.ps1'))) { return (Get-PlainPath (Join-Path $PSScriptRoot '..')) }
  if ($CloudOnly -and $PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release.json')) -and (Test-Path -LiteralPath (Join-Path $CloudDir 'scripts\cloud-setup.mjs'))) { return $null }
  return (Get-ReleaseSource)
}

# The newest release from GitHub, checked against its manifest (size and SHA-256); the main branch only while no
# release is published yet. -> the unpacked folder
function Get-ReleaseSource {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $tmp = Join-Path $env:TEMP "saqme-src-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $m = $null
  $mf = Join-Path $tmp 'saqme-release.json'
  # (to a file: GitHub sends release files as application/octet-stream)
  try { Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/releases/latest/download/saqme-release.json" -OutFile $mf }
  catch {
    $code = $(try { [int]$_.Exception.Response.StatusCode } catch { 0 })
    if ($code -ne 404) { Stop-Setup "could not reach GitHub ($($_.Exception.Message))." 'Check the internet connection, or download the release zip from GitHub, extract it and run setup.cmd from there.' }
  }
  if (Test-Path -LiteralPath $mf) {
    try { $m = Get-Content -LiteralPath $mf -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $m = $null }
    if (-not $m) { Stop-Setup 'the release on GitHub has no valid manifest.' 'Try again later, or download the release zip from GitHub and run setup.cmd from it.' }
  }
  if ($m) {
    $v = [string]$m.version
    $ok = $v -match '^[0-9]+\.[0-9]+\.[0-9]+$' -and $m.tag -ceq "v$v" -and $m.asset.name -ceq "saqme-$v.zip" -and [string]$m.asset.sha256 -match '^[0-9a-fA-F]{64}$' -and [long]$m.asset.size -gt 0
    if (-not $ok) { Stop-Setup 'the release on GitHub has no valid manifest.' 'Try again later, or download the release zip from GitHub and run setup.cmd from it.' }
    $zip = Join-Path $tmp "saqme-$v.zip"
    $url = "https://github.com/$Repo/releases/download/v$v/saqme-$v.zip"
    Write-Info "downloading $url"
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip } catch { Stop-Setup "could not download Saqme To Do ($($_.Exception.Message))." 'Check the internet connection and run setup again.' }
    if ((Get-Item -LiteralPath $zip).Length -ne [long]$m.asset.size -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne ([string]$m.asset.sha256).ToUpperInvariant()) {
      Stop-Setup 'the download does not match the checksum of the release.' 'Run setup again; if it keeps happening, please open an issue on GitHub.'
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $inner = Join-Path $tmp "saqme-$v"
    Write-Ok "Saqme To Do $v downloaded and checked"
  } else {
    $zip = Join-Path $tmp 'main.zip'
    $url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
    Write-Info "no release published yet: downloading $url"
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip } catch { Stop-Setup "could not download Saqme To Do ($($_.Exception.Message))." 'Check the internet connection, or download the zip from GitHub, extract it and run setup.cmd from there.' }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $inner = (Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName
  }
  if (-not (Test-Path -LiteralPath (Join-Path $inner 'desktop\widget.ps1'))) { Stop-Setup 'the download is not Saqme To Do.' 'Run setup again; if it keeps failing, download the release zip and run setup.cmd from it.' }
  Get-ChildItem -LiteralPath $inner -Recurse -File | Unblock-File
  return $inner
}

# version and repository of a source folder (worker\package.json: the single source of the version)
function Get-SourceRelease([string]$src) {
  $pkg = Get-Content -LiteralPath (Join-Path $src 'worker\package.json') -Raw | ConvertFrom-Json
  $r = $Repo
  if ([string]$pkg.repository.url -match 'github\.com/([^/]+/[^/.]+)') { $r = $matches[1] }
  if ([string]$pkg.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Stop-Setup "$src has no version in worker\package.json." 'Use a release, or a copy of the whole repository.' }
  return @{ Version = [string]$pkg.version; Repo = $r }
}

# ---------------------------------------------------------------- running app
function Test-AppRunning {
  $m = $null
  if ([System.Threading.Mutex]::TryOpenExisting("$Instance.Instance", [ref]$m)) { $m.Dispose(); return $true }
  return $false
}
$script:stoppedApp = $false
function Stop-App {
  if (-not (Test-AppRunning)) { return }
  Write-Info 'closing the running app (it saves first)...'
  $quit = $null
  if ([System.Threading.EventWaitHandle]::TryOpenExisting("$Instance.Quit", [ref]$quit)) { [void]$quit.Set(); $quit.Dispose() }
  for ($i = 0; $i -lt 40 -and (Test-AppRunning); $i++) { Start-Sleep -Milliseconds 250 }
  if (Test-AppRunning) {
    # older builds without the quit signal: stop the process that runs our widget.ps1 (any version folder)
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*$AppDir\*widget.ps1*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
  }
  $script:stoppedApp = $true
  Write-Ok 'app closed'
}
function Start-App([switch]$Hidden) {
  # the sandbox's app gets the sandbox's name and data folder (the launcher passes the environment on), so it
  # never takes the real app's place or touches its lists; scripts/dev/test-setup.ps1 quits it afterwards
  if ($env:SAQME_SETUP_SANDBOX) { $env:SAQME_INSTANCE = $Instance; $env:SAQME_DATA_DIR = $DataDir }
  if ($Hidden) { $env:SAQME_START_HIDDEN = '1' }
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $AppDir 'start-widget.vbs') + '"')
  Remove-Item Env:\SAQME_START_HIDDEN -ErrorAction SilentlyContinue
  $script:stoppedApp = $false
  Write-Ok 'app started (look for the icon in the notification area)'
}
# whatever happened: an app this setup closed comes back (the version that is current then)
function Restore-App {
  if ($script:stoppedApp -and -not (Test-AppRunning) -and (Test-Path -LiteralPath (Join-Path $AppDir 'start-widget.vbs'))) {
    try { Start-App -Hidden:$StartHidden } catch {}
  }
}
# the app is up (it holds its instance) and still up a few seconds later
function Wait-AppUp([int]$seconds = 40) {
  if ($env:SAQME_SETUP_SANDBOX -and $env:SAQME_TEST_WAIT_UP) { $seconds = [int]$env:SAQME_TEST_WAIT_UP }   # tests
  for ($i = 0; $i -lt ($seconds * 4) -and -not (Test-AppRunning); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-AppRunning)) { return $false }
  Start-Sleep -Seconds 5
  return (Test-AppRunning)
}
function Set-UpdateStatus([string]$state, [string]$version = '') {
  if (-not $Update -and -not $WorkerUpdate) { return }
  try {
    if (-not (Test-Path -LiteralPath $UpdateDir)) { New-Item -ItemType Directory -Path $UpdateDir -Force | Out-Null }
    [IO.File]::WriteAllText((Join-Path $UpdateDir 'status.json'), (@{ state = $state; version = $version; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
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
function Read-Pointer([string]$name) {
  $p = Join-Path $AppDir $name
  if (Test-Path -LiteralPath $p) { return ([IO.File]::ReadAllText($p)).Trim() }
  return ''
}

# One version's folder from a source tree (a release or the repository).
function Copy-AppFiles([string]$src, [string]$dest, $rel) {
  New-Item -ItemType Directory -Path $dest, (Join-Path $dest 'assets'), (Join-Path $dest 'fonts') -Force | Out-Null
  foreach ($f in $AppFiles) { Copy-Item -LiteralPath (Join-Path $src "desktop\$f") -Destination (Join-Path $dest $f) -Force }
  Copy-Item -Path (Join-Path $src 'desktop\assets\*') -Destination (Join-Path $dest 'assets') -Force
  # the same FiraGO files the phone app serves (OFL, see fonts\OFL.txt); the widget falls back to Segoe UI without them
  Copy-Item -Path (Join-Path $src 'worker\public\fonts\*') -Destination (Join-Path $dest 'fonts') -Force
  Copy-Item -LiteralPath (Join-Path $src 'scripts\setup.ps1') -Destination (Join-Path $dest 'setup.ps1') -Force
  # (worker\package.json's version: what the app and its updater read about themselves)
  [IO.File]::WriteAllText((Join-Path $dest 'release.json'), (@{ version = $rel.Version; repo = $rel.Repo } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  Get-ChildItem -LiteralPath $dest -Recurse -File | Unblock-File
}

# The Worker's deploy folder: the release's worker files and cloud-setup.mjs; wrangler (node_modules) stays.
function Sync-CloudWorkspace([string]$src) {
  $w = Join-Path $CloudDir 'worker'
  New-Item -ItemType Directory -Path $w, (Join-Path $CloudDir 'scripts') -Force | Out-Null
  # wrangler of an install before 1.1.0 (which kept the whole repository in source\): moved here, not downloaded again
  $legacy = Join-Path $AppDir 'source\worker\node_modules'
  if ((Test-Path -LiteralPath $legacy) -and -not (Test-Path -LiteralPath (Join-Path $w 'node_modules'))) { Move-Item -LiteralPath $legacy -Destination (Join-Path $w 'node_modules') -ErrorAction SilentlyContinue }
  foreach ($d in 'src', 'public', 'migrations') {
    $t = Join-Path $w $d
    if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $src "worker\$d") -Destination $t -Recurse -Force
  }
  foreach ($f in 'package.json', 'package-lock.json', 'wrangler.toml.template') { Copy-Item -LiteralPath (Join-Path $src "worker\$f") -Destination (Join-Path $w $f) -Force }
  Copy-Item -LiteralPath (Join-Path $src 'scripts\cloud-setup.mjs') -Destination (Join-Path $CloudDir 'scripts\cloud-setup.mjs') -Force
}

# Puts the new version's folder next to the running one (which keeps running) and checks it there.
# -> @{ Version; Dir (its folder); Stage (where it is now: its folder, or beside it when that version runs already) }
function Install-App([string]$src) {
  Write-Step 'Desktop app'
  $rel = Get-SourceRelease $src
  $script:newVersion = $rel.Version
  New-Item -ItemType Directory -Path $AppDir, $VersionsDir, (Join-Path $AppDir 'assets'), $DataDir -Force | Out-Null
  $dir = Join-Path $VersionsDir $rel.Version
  # the version that runs is replaced only once it stopped (its compiled helper in cache\ is in use)
  $stage = $(if ((Read-Pointer 'current.txt') -eq $rel.Version -and (Test-Path -LiteralPath $dir)) { Join-Path $VersionsDir ".staging-$($rel.Version)" } else { $dir })
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Copy-AppFiles $src $stage $rel
  Write-Ok "version $($rel.Version) copied to $stage"
  # sanity check before anything points at it: the widget builds all its views headlessly
  $check = & powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File (Join-Path $stage 'widget.ps1') -DataDir (Join-Path $env:TEMP "saqme-selftest-$PID") -SmokeTest 2>&1
  Remove-Item -LiteralPath (Join-Path $env:TEMP "saqme-selftest-$PID") -Recurse -Force -ErrorAction SilentlyContinue
  if (($check -join "`n") -notmatch 'SMOKE OK') {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Stop-Setup "version $($rel.Version) failed its self-check, so it was not installed:`n$($check -join "`n")" 'Please open an issue on GitHub with this message.'
  }
  Write-Ok 'self-check passed'
  Sync-CloudWorkspace $src
  return @{ Version = $rel.Version; Dir = $dir; Stage = $stage; Src = $src }
}

# a widget that has just quit may hold its files for a moment longer
function Move-Folder([string]$from, [string]$to) {
  for ($i = 0; ; $i++) {
    try { Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop; return }
    catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 300 }
  }
}
# Makes the installed version the current one (the app is closed for it) -> the version that was current before
function Switch-AppVersion($inst) {
  $was = Read-Pointer 'current.txt'
  Stop-App
  if ($inst.Stage -ne $inst.Dir) {
    # the same version again: the fresh copy takes its place now that nothing runs from it
    $old = Join-Path $VersionsDir ".old-$($inst.Version)"
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
    Move-Folder $inst.Dir $old
    try { Move-Item -LiteralPath $inst.Stage -Destination $inst.Dir }
    catch { Move-Item -LiteralPath $old -Destination $inst.Dir; throw }   # (the copy that ran stays where it was)
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($was -and $was -ne $inst.Version) { Write-VersionPointer $AppDir $was 'previous.txt' }
  Write-VersionPointer $AppDir $inst.Version
  # what shortcuts, the saqme: link and Settings > Apps point at: next to the version folders, always the newest
  Copy-Item -LiteralPath (Join-Path $inst.Src 'desktop\start-widget.vbs') -Destination (Join-Path $AppDir 'start-widget.vbs') -Force
  Copy-Item -Path (Join-Path $inst.Src 'desktop\assets\*') -Destination (Join-Path $AppDir 'assets') -Force
  Copy-Item -LiteralPath (Join-Path $inst.Src 'scripts\setup.ps1') -Destination (Join-Path $AppDir 'setup.ps1') -Force
  # an install before 1.1.0 had its files in the app folder itself: the version folder replaces them
  foreach ($f in $FlatFiles) { Remove-Item -LiteralPath (Join-Path $AppDir $f) -Force -ErrorAction SilentlyContinue }
  foreach ($d in 'fonts', 'cache', 'source') { Remove-Item -LiteralPath (Join-Path $AppDir $d) -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Ok "version $($inst.Version) is the one that runs$(if ($was -and $was -ne $inst.Version) { " (was $was, kept to go back to)" })"
  return $was
}
# version folders other than the current and the previous one go (and what an interrupted run left)
function Remove-OldVersions {
  $keep = @((Read-Pointer 'current.txt'), (Read-Pointer 'previous.txt')) | Where-Object { $_ }
  Get-ChildItem -LiteralPath $VersionsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $keep -notcontains $_.Name } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
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
  elseif ($Update) { if (Test-Path -LiteralPath $StartupLnk) { New-Shortcut $StartupLnk $AppName } }   # (an update keeps the user's choice)
  else { New-Shortcut $StartupLnk $AppName; Write-Ok 'starts with Windows (switch off in the app: Settings > General)' }
  # Settings > Apps entry
  New-Item -Path $UninstallKey -Force | Out-Null
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $vals = @{ DisplayName = $AppName; Publisher = 'Saqme To Do (open source)'; DisplayIcon = (Join-Path $AppDir 'assets\saqme.ico'); InstallLocation = $AppDir
             DisplayVersion = $script:newVersion
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

# ---------------------------------------------------------------- Node.js (for the cloud part only)
function Find-Node {
  if ($env:SAQME_SETUP_SANDBOX -and $env:SAQME_SETUP_NODE) { return $env:SAQME_SETUP_NODE }   # tests: a stand-in
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  foreach ($cand in @((Join-Path $NodeDir 'node.exe'), $(if ($onPath) { $onPath.Source }))) {
    if (-not $cand -or -not (Test-Path -LiteralPath $cand)) { continue }
    $v = & $cand --version 2>$null
    if ($v -match '^v(\d+)\.' -and [int]$matches[1] -ge 22) { return $cand }   # what wrangler needs
  }
  return $null
}
# Node.js from nodejs.org into the app folder (no administrator rights, nothing else on the PC changes), checked
# against the release's checksums. -> node.exe, or $null
function Install-PortableNode {
  $arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' })
  $tmp = Join-Path $AppDir 'node-download'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $sums = [string](Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
    $hit = [regex]::Match($sums, "([0-9a-f]{64})\s+(node-(v[0-9.]+)-win-$arch\.zip)")
    if (-not $hit.Success) { Write-Warn "nodejs.org has no Node.js 24 for win-$arch"; return $null }
    $zip = Join-Path $tmp $hit.Groups[2].Value
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$($hit.Groups[3].Value)/$($hit.Groups[2].Value)" -OutFile $zip
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hit.Groups[1].Value) { Write-Warn 'the Node.js download is damaged (checksum mismatch)'; return $null }
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'x') -Force
    $inner = Get-ChildItem -LiteralPath (Join-Path $tmp 'x') -Directory | Select-Object -First 1
    if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
    Move-Item -LiteralPath $inner.FullName -Destination $NodeDir
    return (Join-Path $NodeDir 'node.exe')
  } catch { Write-Warn "Node.js could not be downloaded: $($_.Exception.Message)"; return $null }
  finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
function Install-Node {
  $node = Find-Node
  if ($node) { Write-Ok "Node.js $(& $node --version)"; return $node }
  Write-Info 'The cloud part needs Node.js 22 or newer: downloading it just for Saqme (about 30 MB, no administrator rights).'
  $node = Install-PortableNode
  if (-not $node) { Stop-Setup 'Node.js 22 or newer is missing and could not be downloaded.' "Check the internet connection, or install the LTS version from https://nodejs.org, then run: $(Get-SetupCommand '-CloudOnly')" }
  Write-Ok "Node.js $(& $node --version) ($node)"
  return $node
}

# ---------------------------------------------------------------- cloud
function Install-Cloud([string]$src) {
  Write-Step 'Cloud sync (your own Cloudflare account, free plan)'
  $node = Install-Node
  if ($src) { Sync-CloudWorkspace $src }
  $nodeArgs = @((Join-Path $CloudDir 'scripts\cloud-setup.mjs'), '--state', (Join-Path $DataDir 'cloud.json'), '--desktop-config', (Join-Path $DataDir 'sync\config.json'), '--worker-name', $WorkerName)
  if ($RotateToken) { $nodeArgs += '--rotate-token' }
  if ($DeviceLogin) { $nodeArgs += '--device-login' }
  if ($Yes) { $nodeArgs += '--yes' }
  if ($ResultFile) { $nodeArgs += @('--result', $ResultFile) }
  & $node @nodeArgs
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    # cloud-setup.mjs already explained what to do (and wrote the result, unless it was stopped)
    if ($ResultFile -and -not (Test-Path -LiteralPath $ResultFile)) { Write-Result $false 'The cloud setup did not finish.' 'Run it again; the window shows where it stopped.' }
    Restore-App
    Wait-Close $false
    exit $code
  }
}

# The user's own Worker to this version (code and phone app; its keys stay): cloud-setup.mjs --update.
# -> @{ Deploy = none | ok | needs-login | failed; WorkerApi; Message }
function Update-OwnWorker([string]$version) {
  if ($NoWorker) { return @{ Deploy = 'none'; WorkerApi = $null; Message = '' } }
  $ErrorActionPreference = 'Continue'   # (wrangler writes to stderr; with Stop, PowerShell 5.1 would end here)
  $cfgFile = Join-Path $DataDir 'sync\config.json'
  $cfg = $null
  if (Test-Path -LiteralPath $cfgFile) { try { $cfg = Get-Content -LiteralPath $cfgFile -Raw | ConvertFrom-Json } catch {} }
  if (-not $cfg -or -not $cfg.url -or -not $cfg.token -or $cfg.enabled -eq $false) { return @{ Deploy = 'none'; WorkerApi = $null; Message = '' } }
  Set-UpdateStatus 'worker' $version
  # what runs there now (a Worker before 1.1.0 does not say its API: 1); one another computer updated already is left
  $api = $null
  try {
    $h = Invoke-RestMethod -UseBasicParsing -Uri (([string]$cfg.url).TrimEnd('/') + '/api/health') -TimeoutSec 15
    $api = $(if ($h.api) { [long]$h.api } else { [long]1 })
    if ((Compare-SaqmeVersion ([string]$h.version) $version) -ge 0) { return @{ Deploy = 'ok'; WorkerApi = $api; Message = '' } }
  } catch {}
  $node = Find-Node
  if (-not $node) { $node = Install-PortableNode }
  if (-not $node) { return @{ Deploy = 'failed'; WorkerApi = $api; Message = 'Node.js, which updating it needs, could not be downloaded' } }
  $res = Join-Path $UpdateDir "worker-$PID.json"
  if (-not (Test-Path -LiteralPath $UpdateDir)) { New-Item -ItemType Directory -Path $UpdateDir -Force | Out-Null }
  Remove-Item -LiteralPath $res -Force -ErrorAction SilentlyContinue
  & $node (Join-Path $CloudDir 'scripts\cloud-setup.mjs') --update --state (Join-Path $DataDir 'cloud.json') --desktop-config $cfgFile --yes --result $res 2>&1 | Out-Null
  $r = $null
  if (Test-Path -LiteralPath $res) { try { $r = Get-Content -LiteralPath $res -Raw | ConvertFrom-Json } catch {}; Remove-Item -LiteralPath $res -Force -ErrorAction SilentlyContinue }
  if ($r -and $r.ok) { return @{ Deploy = 'ok'; WorkerApi = $api; Message = '' } }
  if ($r -and $r.needsLogin) { return @{ Deploy = 'needs-login'; WorkerApi = $api; Message = [string]$r.message } }
  return @{ Deploy = 'failed'; WorkerApi = $api; Message = $(if ($r) { [string]$r.message } else { 'the update of your sync service did not finish' }) }
}

# -Update: the release in -Source next to the running version, the Worker, then the switch (or nothing at all).
function Invoke-AppUpdate([string]$src) {
  $script:fromVersion = Read-Pointer 'current.txt'
  Set-UpdateStatus 'installing' (Get-SourceRelease $src).Version
  $inst = Install-App $src
  $from = $script:fromVersion
  $w = Update-OwnWorker $inst.Version
  $decision = Get-UpdateDecision $w.Deploy $w.WorkerApi $MinWorkerApi
  $worker = $(if ($w.Deploy -eq 'none') { 'none' } elseif ($w.Deploy -eq 'ok') { 'ok' } else { 'pending' })
  $needsLogin = $w.Deploy -eq 'needs-login'
  if ($decision -eq 'hold') {
    if ($inst.Stage -ne $inst.Dir) { Remove-Item -LiteralPath $inst.Stage -Recurse -Force -ErrorAction SilentlyContinue }
    $msg = $(if ($needsLogin) { "Sign in to Cloudflare to finish the update to $($inst.Version): it needs your sync service updated first." }
             else { "The update to $($inst.Version) is waiting: it needs your sync service updated first, and that did not work ($(if ($w.Message) { $w.Message } else { 'no reason given' }))." })
    Write-ResultJson @{ ok = $false; held = $true; version = $inst.Version; from = $from; worker = $worker; needsLogin = $needsLogin; message = $msg; next = 'Nothing changed. It is tried again later, or now with Try again.' }
    Write-Info $msg
    exit 1
  }
  Register-Windows
  Set-UpdateStatus 'restarting' $inst.Version
  $wasRunning = Test-AppRunning
  $prevBefore = Read-Pointer 'previous.txt'
  [void](Switch-AppVersion $inst)
  if ($wasRunning -or -not $NoStart) {
    Start-App -Hidden:$StartHidden
    if (-not (Wait-AppUp)) {
      # the new version does not come up: back to the one before, which is started again
      Stop-App
      if ($from -and $from -ne $inst.Version -and (Test-Path -LiteralPath (Join-Path $VersionsDir $from))) {
        Write-VersionPointer $AppDir $from
        if ($prevBefore) { Write-VersionPointer $AppDir $prevBefore 'previous.txt' }
        else { Remove-Item -LiteralPath (Join-Path $AppDir 'previous.txt') -Force -ErrorAction SilentlyContinue }
      }
      Start-App -Hidden:$StartHidden
      Write-ResultJson @{ ok = $false; version = $inst.Version; from = $from; message = "Version $($inst.Version) did not start, so Saqme went back to $(if ($from) { $from } else { 'the version before' })."; next = "Please report it (the widget's log is in $DataDir\sync\sync.log)." }
      exit 1
    }
  }
  Remove-OldVersions
  $msg = $(if ($worker -ne 'pending') { "Updated to $($inst.Version)." } elseif ($needsLogin) { "Updated to $($inst.Version). Sign in to Cloudflare to finish: your sync service still runs the version before." }
           else { "Updated to $($inst.Version). Your sync service could not be updated yet ($($w.Message)); it is tried again later." })
  Write-ResultJson @{ ok = $true; version = $inst.Version; from = $from; worker = $worker; needsLogin = $needsLogin; message = $msg }
  Write-Ok $msg
}

# ---------------------------------------------------------------- uninstall
function Uninstall-App {
  Write-Step "Removing $AppName"
  Stop-App
  $script:stoppedApp = $false   # (it stays closed)
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

if ($WorkerUpdate -or $CloudLogin) {
  # run by the updater from the installed version's folder (its own files are next to it)
  . (Join-Path $PSScriptRoot 'sync-core.ps1')
  . (Join-Path $PSScriptRoot 'update-core.ps1')
  if ($CloudLogin) {
    $node = Install-Node
    $a = @((Join-Path $CloudDir 'scripts\cloud-setup.mjs'), '--login-only')
    if ($ResultFile) { $a += @('--result', $ResultFile) }
    & $node @a
    exit $LASTEXITCODE
  }
  $rel = Get-AppRelease $PSScriptRoot
  $w = Update-OwnWorker $rel.Version
  $ok = $w.Deploy -eq 'ok' -or $w.Deploy -eq 'none'
  Write-ResultJson @{ ok = $true; version = $rel.Version; worker = $(if ($w.Deploy -eq 'none') { 'none' } elseif ($ok) { 'ok' } else { 'pending' }); needsLogin = ($w.Deploy -eq 'needs-login')
                      message = $(if ($ok) { "Updated to $($rel.Version), your sync service too." } elseif ($w.Deploy -eq 'needs-login') { 'Sign in to Cloudflare to finish the update of your sync service.' } else { "Your sync service could not be updated yet ($($w.Message))." }) }
  Set-UpdateStatus 'idle'
  exit 0
}

$withCloud = $Cloud -or $CloudOnly -or $RotateToken -or $DeviceLogin   # those two only make sense with it
$src = Get-SourceDir
# the release's own rules (versions, the update decision, its pointer files)
$core = $(if ($src) { Join-Path $src 'desktop' } else { $PSScriptRoot })
. (Join-Path $core 'sync-core.ps1')
. (Join-Path $core 'update-core.ps1')
try {
  if ($Update) { Invoke-AppUpdate $src; exit 0 }
  if (-not $CloudOnly) {
    $inst = Install-App $src
    Register-Windows
    $wasRunning = Test-AppRunning
    [void](Switch-AppVersion $inst)
    Remove-OldVersions
    if ($Import) { Import-Lists $Import }
  }
  if ($withCloud) { Install-Cloud $src }
  else {
    Write-Host ''
    if (Test-Path -LiteralPath (Join-Path $DataDir 'sync\config.json')) { Write-Info 'Cloud sync stays on (set up earlier); the app keeps it updated by itself.' }
    else {
      Write-Info 'Your lists stay on this PC. To have them on your phone too: in the app, Settings > Sync & sharing > Set up sync.'
      Write-Info "(or run: $(Get-SetupCommand '-Cloud'); a device that already syncs: paste its pairing link there)"
    }
  }
  if (-not $CloudOnly -and (-not $NoStart -or $wasRunning)) { Write-Step 'Starting'; Start-App }
  elseif ($CloudOnly -and (Test-AppRunning)) { Write-Info 'The running app picks up the sync settings by itself within a few seconds.' }
  elseif ($CloudOnly) { Start-App }
} catch {
  Stop-Setup "$($_.Exception.Message)" 'Please open an issue on GitHub with this message if it keeps happening.'
} finally {
  Restore-App
}
Write-Host ''
Write-Host 'All done.' -ForegroundColor Green
if ($withCloud -and $ResultFile -and -not (Test-Path -LiteralPath $ResultFile)) { Write-Result $true }
Wait-Close $true
