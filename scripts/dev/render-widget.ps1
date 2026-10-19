# Renders the desktop widget to PNG without a visible window and without touching a running instance:
# runs a copy of desktop\widget.ps1 under its own instance name, on a throw-away data folder filled from
# scripts\dev\sample (due:{N} = N days from today), tray icon hidden, window at Left=-5000 (not activated,
# not in the taskbar), then Show() + UpdateLayout() + RenderTargetBitmap of the window frame per theme.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\render-widget.ps1 -Out C:\temp\shots [-Prefix desktop] [-Project Work] [-View settings]
param([Parameter(Mandatory)][string]$Out, [string]$Prefix = 'desktop', [string]$Project = 'Work', [int]$Width = 440, [int]$Height = 660,
  [ValidateSet('list', 'settings', 'keys')][string]$View = 'list')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('saqme-render-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$app = Join-Path $tmp 'app'; $data = Join-Path $tmp 'data'
New-Item -ItemType Directory -Path $app, (Join-Path $data 'lists'), $Out -Force | Out-Null
Copy-Item -Path (Join-Path $root 'desktop\*') -Destination $app -Recurse -Force
if (Test-Path (Join-Path $root 'worker\public\fonts')) { Copy-Item -Path (Join-Path $root 'worker\public\fonts') -Destination (Join-Path $app 'fonts') -Recurse -Force }

$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($f in Get-ChildItem (Join-Path $root 'scripts\dev\sample') -Force -File) {
  $text = [IO.File]::ReadAllText($f.FullName)
  $text = [regex]::Replace($text, 'due:\{([+-]?\d+)\}', { param($m) 'due:' + (Get-Date).Date.AddDays([int]$m.Groups[1].Value).ToString('yyyy-MM-dd') })
  [IO.File]::WriteAllText((Join-Path $data "lists\$($f.Name)"), $text, $utf8)
}
[IO.File]::WriteAllText((Join-Path $data '.widget-settings'), "active=$Project`nwidth=$Width`nheight=$Height`ntheme=dark`n", $utf8)

# the copy: own instance name, no tray icon, and a render step instead of the message loop
$w = [IO.File]::ReadAllText((Join-Path $app 'widget.ps1'))
$w = $w -replace '\$instance = \$\(if \(\$SmokeTest\)[^\r\n]*', '$instance = "Local\SaqmeToDo.Render.$PID"'
$w = $w.Replace('$tray.Visible = -not $SmokeTest', '$tray.Visible = $false').Replace('$tray.Visible = $true', '$tray.Visible = $false')
$render = @"
try {
`$w.ShowActivated = `$false; `$w.ShowInTaskbar = `$false; `$w.Left = -5000; `$w.Top = 0
`$w.Width = $Width; `$w.Height = $Height
`$w.Show()
`$script:view = '$View'
foreach (`$th in 'dark', 'light') {
  Apply-Theme `$th; Render; `$w.UpdateLayout()
  `$rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap([int](`$w.ActualWidth * 2), [int](`$w.ActualHeight * 2), 192, 192, [System.Windows.Media.PixelFormats]::Pbgra32)
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
