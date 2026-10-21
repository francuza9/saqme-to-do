# Renders the desktop widget to PNG without a visible window and without touching a running instance:
# runs a copy of desktop\widget.ps1 under its own instance name, on a throw-away data folder filled from
# scripts\dev\sample (or -Sample: e.g. scripts\dev\sample-tabs, five projects for a crowded tab strip; due:{N} =
# N days from today), tray icon hidden, window at Left=-5000 (not activated, not in the taskbar), then
# Show() + UpdateLayout() + RenderTargetBitmap of the window frame per theme.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\render-widget.ps1 -Out C:\temp\shots [-Prefix desktop] [-Project Work] [-View settings] [-Sample dir]
#     -View      list (default), settings, or any other view of the widget (a Settings page: sync, updates, ...; keys, pair, conflicts, trash)
#     -Full      the whole view, as tall as its content (Settings scrolls inside the window)
#     -Busy      Settings at its most crowded: syncing with a conflict, a list shared with this PC, deletions paused, an
#                installed copy whose update waits for the Cloudflare sign-in, tasks in Recently deleted, and (-View share)
#                the current list shared with three people
#     -Advanced  with the Advanced part of the Settings pages open
#     -Open      the list as it looks in use: every task with notes open, and Completed shown
param([Parameter(Mandatory)][string]$Out, [string]$Prefix = 'desktop', [string]$Project = 'Work', [int]$Width = 440, [int]$Height = 660,
  [string]$View = 'list', [string]$Sample = '', [switch]$Full, [switch]$Busy, [switch]$Advanced, [switch]$Open)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('saqme-render-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$app = Join-Path $tmp 'app'; $data = Join-Path $tmp 'data'
New-Item -ItemType Directory -Path $app, (Join-Path $data 'lists'), $Out -Force | Out-Null
Copy-Item -Path (Join-Path $root 'desktop\*') -Destination $app -Recurse -Force
if (Test-Path (Join-Path $root 'worker\public\fonts')) { Copy-Item -Path (Join-Path $root 'worker\public\fonts') -Destination (Join-Path $app 'fonts') -Recurse -Force }

$utf8 = New-Object System.Text.UTF8Encoding($false)
# this version, as an installed copy has it (the copy is not next to worker\package.json)
$pkg = Get-Content -Raw (Join-Path $root 'worker\package.json') | ConvertFrom-Json
[IO.File]::WriteAllText((Join-Path $app 'release.json'), (@{ version = $pkg.version } | ConvertTo-Json), $utf8)
if (-not $Sample) { $Sample = Join-Path $root 'scripts\dev\sample' }
foreach ($f in Get-ChildItem $Sample -Force -File) {
  $text = [IO.File]::ReadAllText($f.FullName)
  $text = [regex]::Replace($text, 'due:\{([+-]?\d+)\}', { param($m) 'due:' + (Get-Date).Date.AddDays([int]$m.Groups[1].Value).ToString('yyyy-MM-dd') })
  [IO.File]::WriteAllText((Join-Path $data "lists\$($f.Name)"), $text, $utf8)
}
[IO.File]::WriteAllText((Join-Path $data '.widget-settings'), "active=$Project`nwidth=$Width`nheight=$Height`ntheme=dark`nshowCompleted=$([int][bool]$Open)`n", $utf8)

# the copy: own instance name, no tray icon, and a render step instead of the message loop
$w = [IO.File]::ReadAllText((Join-Path $app 'widget.ps1'))
$w = $w -replace '\$instance = \$\(if \(\$SmokeTest\)[^\r\n]*', '$instance = "Local\SaqmeToDo.Render.$PID"'
$w = $w.Replace('$tray.Visible = -not $SmokeTest', '$tray.Visible = $false').Replace('$tray.Visible = $true', '$tray.Visible = $false')
$busyState = @"
[void](New-Item -ItemType Directory -Path `$syncDir -Force)
Write-TextFileAtomic `$syncCfgFile (ConvertTo-JsonText @{ url = 'https://saqme.example.workers.dev'; token = ('k' * 43); deviceId = 'pc-render'; enabled = `$true })
Write-TextFileAtomic (Proj-Path 'Groceries (from nuca)') "- [ ] Bread ^grgrgr01``n"
Save-ShareBindings `$listsDir @(@{ id = 'srender00001'; file = 'Groceries (from nuca)'; server = 'https://saqme.nuca.workers.dev'; project = 'prender01'; access = 'edit'; name = 'Groceries'; joinedAt = 1 })
`$script:bindSig = `$null
`$conflict = [pscustomobject]@{ Id = 'crender01'; Task = 'trender01'; Field = 'text'; TaskText = 'Book flights for the offsite'; Current = 'Book flights for the offsite'; Value = 'Book flights and a hotel'; Share = '' }
`$script:sync = @{ Status = 'synced'; StatusText = ''; LastSync = (Get-Date).AddMinutes(-2); WorkerVersion = `$script:Release.Version; WorkerApi = `$script:SharingApi
  Conflicts = @(`$conflict); Notices = @(); Guarded = 3; Shares = @(); SharedByMe = @{}; ProjectIds = @{}; NotifyAt = `$script:cfg.notifyAt
  Wake = (New-Object System.Threading.AutoResetEvent(`$false)); Queue = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue)) }
`$InstallRoot = Join-Path `$DataDir 'render-install'
`$nextV = [version]`$script:Release.Version; `$nextV = "`$(`$nextV.Major).`$(`$nextV.Minor + 1).0"
[void](New-Item -ItemType Directory -Path (Join-Path `$InstallRoot 'update') -Force)
Write-TextFileAtomic (Join-Path `$InstallRoot 'update\result.json') (ConvertTo-JsonText @{ ok = `$false; held = `$true; needsLogin = `$true; version = `$nextV; message = 'Sign in to Cloudflare to finish the update.'; next = 'Your lists and sync keep working meanwhile.'; at = 1 })
`$script:upd.Latest = @{ version = `$nextV }; `$script:upd.CheckedAt = Get-NowMs
Add-DeletedEntry (Read-Items "- [ ] Old draft of the Q4 roadmap ^drender01``n  - [ ] Outline ^drender02``n  - [ ] Numbers ^drender03``n") '' 'Work'
Add-DeletedEntry (Read-Items "- [ ] Water the plants ^drender04``n") '' 'Home'
`$day = [long]86400000; `$now = Get-NowMs
`$script:shareView = @{ Name = `$script:proj; ProjectId = 'prender02'; Error = ''; Invite = `$null; Access = 'edit'; Alias = ''; Busy = `$false
  People = @(@{ id = 'p1'; alias = 'Nuca'; access = 'edit'; state = 'joined'; joinedAt = `$now - 3 * `$day; createdAt = `$now - 4 * `$day },
             @{ id = 'p2'; alias = 'Giorgi'; access = 'view'; state = 'pending'; createdAt = `$now - `$day },
             @{ id = 'p3'; alias = 'Old link'; access = 'view'; state = 'expired'; createdAt = `$now - 9 * `$day }) }
[void](Update-SyncIndicator -Force)
"@
$render = @"
try {
`$w.ShowActivated = `$false; `$w.ShowInTaskbar = `$false; `$w.Left = -5000; `$w.Top = 0
`$w.Width = $Width; `$w.Height = $Height
$(if ($Busy) { $busyState })
`$script:advancedOpen = `$$([bool]$Advanced)
if (`$$([bool]$Open)) { foreach (`$it in `$script:items) { if (`$it.Kind -eq 'task' -and `$it.Notes) { `$script:openState[(Open-Key `$it)] = '1' } } }
if (-not `$$([bool]$Full)) { `$w.Show() }   # (a window on screen would lay its content out at its own height)
`$script:view = '$($View.Replace("'", "''"))'
foreach (`$th in 'dark', 'light') {
  Apply-Theme `$th; Render; `$w.UpdateLayout()
  # let the work the widget queues for after layout run (the tab strip scrolls the current project into view)
  foreach (`$i in 1..3) { `$w.Dispatcher.Invoke([action]{}, [System.Windows.Threading.DispatcherPriority]::ContextIdle); `$w.UpdateLayout() }
  `$shotW = `$w.ActualWidth; `$shotH = `$w.ActualHeight
  if (`$$([bool]$Full)) {
    # as tall as the content: measured without a height limit, so the list's scroll area takes all it needs
    `$shotW = $Width
    `$outer.Measure((New-Object System.Windows.Size(`$shotW, [double]::PositiveInfinity)))
    `$shotH = [math]::Ceiling(`$outer.DesiredSize.Height)   # (with its margin)
    `$outer.Arrange((New-Object System.Windows.Rect(0, 0, `$shotW, `$shotH))); `$outer.UpdateLayout()
  }
  `$rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap([int](`$shotW * 2), [int](`$shotH * 2), 192, 192, [System.Windows.Media.PixelFormats]::Pbgra32)
  `$rtb.Render(`$outer)
  `$enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  `$enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create(`$rtb))
  # not `$fs: PowerShell names are case-insensitive and the widget has a `$FS-like table of its own
  `$pngFile = [IO.File]::Create('$((Join-Path $Out $Prefix).Replace("'", "''"))-' + `$th + '.png'); try { `$enc.Save(`$pngFile) } finally { `$pngFile.Close() }
}
`$script:quitting = `$true; `$w.Close(); try { `$tray.Dispose() } catch {}
exit 0
} catch {
  Write-Output ("RENDER FAIL: " + `$_.Exception.Message + " (line " + `$_.InvocationInfo.ScriptLineNumber + ")")
  try { `$script:quitting = `$true; `$w.Close(); `$tray.Dispose() } catch {}
  exit 1
}
"@
# just before the top-level self-check block (not the early return inside Show-Toast)
$m = [regex]::Match($w, '(?m)^if \(\$SmokeTest\) \{\s*$')
if (-not $m.Success) { throw 'render anchor not found in widget.ps1' }
$idx = $m.Index
$w = $w.Substring(0, $idx) + $render + "`n" + $w.Substring($idx)
[IO.File]::WriteAllText((Join-Path $app 'widget.ps1'), $w, $utf8)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File (Join-Path $app 'widget.ps1') -DataDir $data
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $Out -Filter "$Prefix-*.png" | ForEach-Object { "{0}  {1:N0} bytes" -f $_.Name, $_.Length }
