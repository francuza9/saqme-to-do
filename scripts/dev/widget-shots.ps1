# Renders the widget's main views to PNG files without showing a window (visual checks during development).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\widget-shots.ps1 -Out C:\temp\shots [-SyncUrl http://localhost:8787 -Token ...]
# Uses a throw-away data folder; with -SyncUrl/-Token (e.g. `npm run dev` in worker/) it also syncs and shows a conflict.
#   -Scale 1 / 1.25 / 1.5 renders at 100% / 125% / 150% (default 2); -Widget renders another copy of widget.ps1 (before/after).
param([Parameter(Mandatory)][string]$Out, [string]$SyncUrl, [string]$Token, [string]$Widget = '', [double]$Scale = 0)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$data = Join-Path ([IO.Path]::GetTempPath()) ('saqme-shots-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path (Join-Path $data 'lists'), $Out -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $data 'lists\Work.md'), @"
# Work
- [/] Ship the Q4 roadmap draft due:$((Get-Date).ToString('yyyy-MM-dd'))T16:30
  - [x] Collect feedback from design
  - [/] Write the migration section
  - [ ] Review numbers with finance
- [ ] Reply to the vendor about the contract renewal due:$((Get-Date).AddDays(-2).ToString('yyyy-MM-dd'))
  > Thread: https://mail.example.com/thread/123
- [!] Waiting on legal sign-off due:$((Get-Date).AddDays(4).ToString('yyyy-MM-dd'))
- [ ] Book flights for the offsite due:$((Get-Date).AddDays(1).ToString('yyyy-MM-dd'))T9:00
- [ ] Prepare the team offsite agenda
  > Ideas doc: https://docs.example.com/offsite
- [>] Clean up the old dashboards
- [x] Send weekly update
- [-] Try the new CI provider
"@, $utf8)
[IO.File]::WriteAllText((Join-Path $data 'lists\Home.md'), "- [ ] Groceries`n- [ ] Call the plumber`n", $utf8)
[IO.File]::WriteAllText((Join-Path $data 'lists\General.md'), "- [ ] Inbox`n", $utf8)   # (the self-check's backup step expects a General list)
[IO.File]::WriteAllText((Join-Path $data 'lists\.order'), "Work`nHome`nGeneral`n", $utf8)
[IO.File]::WriteAllText((Join-Path $data '.widget-settings'), "active=Work`ntheme=dark`n", $utf8)
if ($SyncUrl) {
  New-Item -ItemType Directory -Path (Join-Path $data 'sync') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $data 'sync\config.json'), ('{"url":"' + $SyncUrl + '","token":"' + $Token + '","enabled":true}'), $utf8)
}
$env:SAQME_SMOKE_SHOTS = (Resolve-Path $Out).ProviderPath   # plain path, also for \\server\share
if ($Scale -gt 0) { $env:SAQME_SMOKE_SCALE = [string]$Scale }
if (-not $Widget) { $Widget = Join-Path $root 'desktop\widget.ps1' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File $Widget -DataDir $data -SmokeTest
Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
