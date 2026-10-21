<#
.SYNOPSIS
  The app updater on Windows (docs/setup.md, "Updating"). The widget starts it, hidden: Settings > Updates >
  Update now, or by itself when the app is idle. Lists and data are never touched.

.DESCRIPTION
  Checks the newest release on GitHub, downloads its zip, checks it against the release's manifest (size and
  SHA-256), unpacks it, and hands it to that release's own scripts\setup.ps1 -Update, which installs it next to
  this version, updates the user's own Worker (code and phone app; its keys stay), switches over, restarts the
  app and waits for it, or goes back. How it ended is in <install>\update\result.json (the widget shows it);
  what it is doing meanwhile in status.json.

.EXAMPLE
  update.ps1 -AppDir <install> -DataDir <data>                the newest release
  update.ps1 ... -WorkerOnly                                  only the Worker part of the update already installed
  update.ps1 ... -Manifest m.json -Asset saqme-X.Y.Z.zip      a release from files (scripts\dev\test-setup.ps1)
#>
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [switch]$Hidden,       # the window was hidden: the new version starts in the tray only
  [switch]$WorkerOnly,
  [switch]$NoWorker,     # tests
  [string]$Manifest,     # tests
  [string]$Asset         # tests
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Off
. (Join-Path $PSScriptRoot 'sync-core.ps1')
. (Join-Path $PSScriptRoot 'update-core.ps1')

$upd = Join-Path $AppDir 'update'
if (-not (Test-Path -LiteralPath $upd)) { [void](New-Item -ItemType Directory -Path $upd -Force) }
$statusFile = Join-Path $upd 'status.json'
$resultFile = Join-Path $upd 'result.json'
function Set-UpdateStatus([string]$state, [string]$version = '') {
  try { Write-TextFileAtomic $statusFile (ConvertTo-JsonText @{ state = $state; version = $version; at = (Get-NowMs) }) } catch {}
}
function Write-UpdateResult($r) {
  $r['at'] = Get-NowMs
  try { Write-TextFileAtomic $resultFile (ConvertTo-JsonText $r) } catch {}
}
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Invoke-Update {
  $release = Get-AppRelease $PSScriptRoot
  if ($WorkerOnly) {
    Set-UpdateStatus 'worker' $release.Version
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup.ps1') -WorkerUpdate -Yes -DataDir $DataDir -ResultFile $resultFile | Out-Null
    return
  }
  Set-UpdateStatus 'checking'
  if ($Manifest) { $m = Test-ReleaseManifest (ConvertFrom-JsonText (Read-TextFile $Manifest)) }
  else {
    $l = Get-LatestRelease $release.Repo
    if (-not $l.Ok) { Write-UpdateResult @{ ok = $false; message = "Could not check for updates: $($l.Error)"; next = 'It is tried again later.' }; return }
    $m = $l.Manifest
  }
  if (-not $m -or (Compare-SaqmeVersion $m.version $release.Version) -le 0) { return }   # up to date: nothing to say
  $from = $release.Version
  $failed = { param($why) Write-UpdateResult @{ ok = $false; version = $m.version; from = $from; message = "The update to $($m.version) did not install: $why"; next = "Saqme $from keeps running. It is tried again later." } }

  Set-UpdateStatus 'downloading' $m.version
  $zip = Join-Path $upd $m.asset
  if ($Asset) { Copy-Item -LiteralPath $Asset -Destination $zip -Force; $bad = Test-AssetFile $zip $m }
  elseif ((Test-Path -LiteralPath $zip) -and -not (Test-AssetFile $zip $m)) { $bad = '' }   # (downloaded before, still good)
  else { $bad = Save-ReleaseAsset $release.Repo $m $zip }
  if ($bad) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue; & $failed $bad; return }

  Set-UpdateStatus 'installing' $m.version
  $src = Join-Path $upd "src-$($m.version)"
  if (Test-Path -LiteralPath $src) { Remove-Item -LiteralPath $src -Recurse -Force }
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $src)   # (refuses entries that would land outside $src)
  } catch { & $failed "it could not be unpacked ($($_.Exception.Message))"; return }
  $tree = Join-Path $src "saqme-$($m.version)"
  $got = Get-AppRelease (Join-Path $tree 'desktop')
  if (-not (Test-Path -LiteralPath (Join-Path $tree 'scripts\setup.ps1')) -or $got.Version -ne $m.version) { & $failed 'it is not the release it says it is'; return }
  Get-ChildItem -LiteralPath $tree -Recurse -File | Unblock-File

  # the new release installs itself: its own setup knows its own files
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tree 'scripts\setup.ps1'), '-Update', '-Source', $tree, '-Yes',
         '-DataDir', $DataDir, '-ResultFile', $resultFile, '-MinWorkerApi', [string]$m.minWorkerApi)
  if ($Hidden) { $a += '-StartHidden' }
  if ($NoWorker) { $a += '-NoWorker' }
  Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue   # (what this run says, nothing older)
  & $ps @a | Out-Null
  if (-not (Test-Path -LiteralPath $resultFile)) { & $failed 'its setup stopped without saying why' }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\SaqmeToDo.Update')
$got = $false
try { $got = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
if (-not $got) { exit 3 }   # another update is running
try {
  Invoke-Update
} catch {
  Write-UpdateResult @{ ok = $false; message = "The update stopped: $($_.Exception.Message)"; next = 'Saqme keeps running as it was. It is tried again later.' }
} finally {
  Set-UpdateStatus 'idle'
  # what this run unpacked is not needed any more; the download only until it is installed (a held update keeps it)
  Get-ChildItem -LiteralPath $upd -Directory -Filter 'src-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $done = Read-UpdateFile $AppDir 'result.json'
  if ($done -and $done['ok']) { Get-ChildItem -LiteralPath $upd -File -Filter 'saqme-*.zip' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }
  $mutex.ReleaseMutex()
}
