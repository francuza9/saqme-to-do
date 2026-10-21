# The desktop widget and other programs writing the same list (an editor, an AI assistant, a sync client):
# runs a copy of the widget under its own instance name on throw-away lists, off-screen and with no tray
# icon, and drives it through small request files while this script plays the other program:
#   - a save while another program holds the list waits for it, then merges (nothing of either is lost)
#   - a list that is still being written is not reloaded (and stamped with ids) until it has settled
#   - a list that cannot be read when its tab is opened shows as busy and is not written over
#   - quitting while a save keeps failing leaves a copy in lists\.recovery
#   - Settings > Sync & sharing > Set up sync, with a stand-in for setup.ps1: success starts sync and shows the QR code;
#     a failure or a closed window leaves sync off and says so
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\widget-files-check.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('saqme-files-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$app = Join-Path $tmp 'app'; $data = Join-Path $tmp 'data'; $lists = Join-Path $data 'lists'
New-Item -ItemType Directory -Path $app, $lists -Force | Out-Null
Copy-Item -Path (Join-Path $root 'desktop\*') -Destination $app -Recurse -Force -Exclude 'cache'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $lists 'Work.md'), "- [ ] one ^aaaaaaaa`n", $utf8)
[IO.File]::WriteAllText((Join-Path $lists 'Home.md'), "- [ ] home ^hhhhhhhh`n", $utf8)
[IO.File]::WriteAllText((Join-Path $lists '.order'), "Work`nHome`n", $utf8)
[IO.File]::WriteAllText((Join-Path $data '.widget-settings'), "active=Work`ntheme=dark`n", $utf8)
$ask = Join-Path $tmp 'ask.txt'; $answer = Join-Path $tmp 'answer.txt'
# a stand-in for scripts\setup.ps1 -FromApp: does what mode.txt says, as the real one would report it
$mode = Join-Path $tmp 'mode.txt'
$fakeSetup = Join-Path $tmp 'fake-setup.ps1'
[IO.File]::WriteAllText($fakeSetup, @"
param([switch]`$FromApp, [string]`$ResultFile, [string]`$DataDir)
`$m = [IO.File]::ReadAllText('$mode').Trim()
Start-Sleep -Milliseconds 600
if (`$m -eq 'ok') {
  New-Item -ItemType Directory -Path (Join-Path `$DataDir 'sync') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path `$DataDir 'sync\config.json'), '{"url":"https://saqme.invalid","token":"$('k' * 43)","deviceId":"pc-test","enabled":true}')
  [IO.File]::WriteAllText(`$ResultFile, '{"ok":true,"url":"https://saqme.invalid"}')
} elseif (`$m -eq 'fail') {
  [IO.File]::WriteAllText(`$ResultFile, '{"ok":false,"message":"Deploying the Worker failed.","next":"Run it again."}')
}
"@, $utf8)
$env:SAQME_SETUP_SCRIPT = $fakeSetup

# ---------------------------------------------------------------- the widget copy, driven by ask.txt
$w = [IO.File]::ReadAllText((Join-Path $app 'widget.ps1'))
$w = $w -replace '\$instance = \$\(if \(\$SmokeTest\)[^\r\n]*', '$instance = "Local\SaqmeToDo.Files.$PID"'
$w = $w.Replace('$tray.Visible = -not $SmokeTest', '$tray.Visible = $false').Replace('$tray.Visible = $true', '$tray.Visible = $false')
$inject = @"
`$w.ShowActivated = `$false; `$w.ShowInTaskbar = `$false; `$w.Left = -5000; `$w.Top = 0
`$w.Show(); Render
`$timer.Start()   # the widget's own timer: reloads, save retries
`$driver = New-Object System.Windows.Threading.DispatcherTimer; `$driver.Interval = [TimeSpan]::FromMilliseconds(100)
`$driver.Add_Tick({
  if (-not (Test-Path '$ask')) { return }
  `$cmd = [IO.File]::ReadAllText('$ask'); Remove-Item '$ask' -Force
  `$state = { "saveFailed=`$(`$script:saveFailed);busy=`$(`$script:listBusy);proj=`$(`$script:proj);tasks=`$((@(`$script:items | Where-Object { `$_.Kind -eq 'task' } | ForEach-Object { `$_.Text })) -join '|');setup=`$([bool]`$script:setupRun);view=`$(`$script:view);sync=`$([bool]`$script:sync);outcome=`$(`$script:setupOutcome.message)" }
  if (`$cmd -match '^edit (.*)$') { @(`$script:items | Where-Object { `$_.Kind -eq 'task' })[0].Text = `$matches[1]; Save-Items }
  elseif (`$cmd -match '^switch (.*)$') { Switch-Project `$matches[1] }
  elseif (`$cmd -eq 'setup') { `$script:view = 'sync'; Start-SyncSetup }
  elseif (`$cmd -eq 'quit') { [IO.File]::WriteAllText('$answer', (& `$state)); Quit-App; return }
  [IO.File]::WriteAllText('$answer', (& `$state))
})
`$driver.Start()
[System.Windows.Threading.Dispatcher]::Run()
exit 0
"@
$m = [regex]::Match($w, '(?m)^if \(\$SmokeTest\) \{\s*$')
if (-not $m.Success) { throw 'anchor not found in widget.ps1' }
$w = $w.Substring(0, $m.Index) + $inject + "`n" + $w.Substring($m.Index)
[IO.File]::WriteAllText((Join-Path $app 'widget.ps1'), $w, $utf8)
$proc = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', "`"$(Join-Path $app 'widget.ps1')`"", '-DataDir', "`"$data`"") -PassThru -WindowStyle Hidden

$failed = 0
function Check([bool]$cond, [string]$what) { if ($cond) { Write-Host "  ok   $what" } else { Write-Host "  FAIL $what" -ForegroundColor Red; $script:failed++ } }
function Wait-For([scriptblock]$cond, [int]$ms = 15000) { $end = [DateTime]::UtcNow.AddMilliseconds($ms); while (-not (& $cond) -and [DateTime]::UtcNow -lt $end) { Start-Sleep -Milliseconds 100 }; return (& $cond) }
function Ask([string]$cmd, [int]$ms = 15000) {
  if (Test-Path $answer) { Remove-Item $answer -Force }
  [IO.File]::WriteAllText($ask, $cmd, $utf8)
  if (-not (Wait-For { Test-Path $answer } $ms)) { throw "the widget did not answer '$cmd'" }
  Start-Sleep -Milliseconds 50
  return [IO.File]::ReadAllText($answer)
}
# another program: opens the list for writing (share: who else may open it meanwhile) and writes $text
function Open-Writer([string]$path, [string]$share, [string]$text) {
  $fs = New-Object IO.FileStream($path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]$share)
  $b = $utf8.GetBytes($text); $fs.Write($b, 0, $b.Length); $fs.Flush()
  return $fs
}
function Add-Text($fs, [string]$text) { $b = $utf8.GetBytes($text); $fs.Write($b, 0, $b.Length); $fs.Flush() }
# reads a list without getting in the widget's way ('' while it is busy with it)
function Read-Now([string]$path) {
  try {
    $f = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try { return (New-Object IO.StreamReader($f, $utf8)).ReadToEnd() } finally { $f.Dispose() }
  } catch { return '' }
}
$work = Join-Path $lists 'Work.md'; $home2 = Join-Path $lists 'Home.md'

try {
  if ((Ask 'state' 60000) -notmatch 'proj=Work') { throw 'the widget did not start on Work' }

  Write-Host 'a save while another program holds the list'
  $fs = Open-Writer $work 'None' "- [ ] one ^aaaaaaaa`n- [ ] AI added this ^bbbbbbbb`n"
  try {
    $a = Ask 'edit one (edited in the widget)'
    Check ($a -match 'saveFailed=True') "the save waits instead of writing blind ($a)"
    Start-Sleep -Milliseconds 1200   # the widget retries meanwhile, and must keep waiting
  } finally { $fs.Dispose() }
  Check (Wait-For { $t = (Read-Now $work); $t -match 'one \(edited in the widget\)' -and $t -match 'AI added this' }) 'once free: saved, merged with what the other program wrote'
  # held only briefly: a save that just kept retrying the replace for ~600 ms would win and lose the other save
  $job = Start-Job -ScriptBlock {
    param($path)
    $fs = New-Object IO.FileStream($path, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $b = [Text.Encoding]::UTF8.GetBytes("- [ ] one (edited in the widget) ^aaaaaaaa`n- [ ] AI added this ^bbbbbbbb`n- [ ] AI added that too ^cccccccc`n")
    $fs.Write($b, 0, $b.Length); $fs.Flush(); [IO.File]::WriteAllText("$path.held", 'x'); Start-Sleep -Milliseconds 300; $fs.Dispose()
  } -ArgumentList $work
  if (-not (Wait-For { Test-Path "$work.held" })) { throw 'the other program did not start' }
  Remove-Item "$work.held" -Force
  [void](Ask 'edit one (edited again)')
  [void](Wait-Job $job -Timeout 15); Remove-Job $job -Force
  Check (Wait-For { $t = (Read-Now $work); $t -match 'one \(edited again\)' -and $t -match 'AI added that too' }) 'held for a moment: still merged, nothing lost'

  Write-Host 'a list that is still being written'
  $fs = Open-Writer $work 'Read' "- [ ] one (edited again) ^aaaaaaaa`n- [ ] AI added this ^bbbbbbbb`n- [ ] new line without an id`n"
  try { Start-Sleep -Milliseconds 900; Add-Text $fs "- [ ] task 4 ^dddddddd`n" } finally { $fs.Dispose() }
  Check (Wait-For { $t = (Read-Now $work); $t -match 'new line without an id \^[0-9a-z]{8}' }) 'stamped with ids once it settled'
  $t = (Read-Now $work)
  Check ($t -match 'task 4 \^dddddddd' -and $t -match 'AI added this') "nothing of the second half was lost ($($t -replace "`n", ' / '))"
  Check (Wait-For { (Ask 'state') -match 'tasks=.*task 4' }) 'and the widget shows all of it'

  Write-Host 'opening a list another program holds'
  $fs = Open-Writer $home2 'None' "- [ ] home ^hhhhhhhh`n- [ ] home 2 ^hhhhhhh2`n"
  try {
    $a = Ask 'switch Home'
    Check ($a -match 'busy=True;proj=Home;tasks=;') "shown as busy ($a)"
    $a = Ask 'state'
    Check ($a -match 'busy=True') 'still busy while held'
  } finally { $fs.Dispose() }
  Check (Wait-For { (Ask 'state') -match 'busy=False;proj=Home;tasks=home\|home 2' }) 'shows the list once it is free'
  Check ((Read-Now $home2) -eq "- [ ] home ^hhhhhhhh`n- [ ] home 2 ^hhhhhhh2`n") 'and never wrote over it'

  Write-Host 'Settings > Sync & sharing > Set up sync'
  foreach ($case in @(@('fail', 'Deploying the Worker failed'), @('close', 'closed before it finished'))) {
    [IO.File]::WriteAllText($mode, $case[0], $utf8)
    Check ((Ask 'setup') -match 'setup=True') "$($case[0]): runs setup, the app keeps going"
    Check (Wait-For { (Ask 'state') -match "setup=False;view=sync;sync=False;outcome=.*$($case[1])" }) "$($case[0]): sync stays off, and it says why"
  }
  Check (-not (Test-Path (Join-Path $data 'sync\config.json'))) 'nothing changed'
  [IO.File]::WriteAllText($mode, 'ok', $utf8)
  [void](Ask 'setup')
  Check (Wait-For { (Ask 'state') -match 'setup=False;view=pair;sync=True;outcome=$' }) 'success: syncing, and the QR code for the phone is shown'

  Write-Host 'quitting while a save keeps failing'
  $fs = Open-Writer $home2 'None' "- [ ] home ^hhhhhhhh`n- [ ] home 2 ^hhhhhhh2`n"
  try {
    $a = Ask 'edit home (unsaved)'
    Check ($a -match 'saveFailed=True') 'the save is waiting'
    [void](Ask 'quit')
    Check (Wait-For { $proc.HasExited }) 'the widget quit'
  } finally { $fs.Dispose() }
  $rec = @(Get-ChildItem -LiteralPath (Join-Path $lists '.recovery') -Filter 'Home-*.md' -ErrorAction SilentlyContinue)
  Check ($rec.Count -eq 1 -and ([IO.File]::ReadAllText($rec[0].FullName) -match 'home \(unsaved\)')) 'the edit is kept in lists\.recovery'
} finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ''
if ($failed) { Write-Host "$failed check(s) FAILED" -ForegroundColor Red; exit 1 } else { Write-Host 'widget file checks passed' }
