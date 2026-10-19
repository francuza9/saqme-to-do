# Checks what Narrator and other screen readers see in the desktop widget, through UI Automation - the
# same interface they use (docs/accessibility.md). Runs a copy of the widget under its own instance name on
# the sample lists (scripts/dev/sample), off-screen and not activated, with no tray icon; a second step
# reads its automation tree from outside, like a screen reader would:
#   - every button, tab, list item, check box, radio button, link and text box has a name
#   - each offers the action a screen reader uses (Invoke, SelectionItem, Toggle) and is keyboard-focusable
#   - the tasks are a list of items whose names include their status in words; the projects are a tab list
#   - no icon-font glyphs leak out as text
#   - the Tab order (WPF's: focusable tab stops in visual order) goes header, tabs, window buttons, list, add box
# It also opens Settings and Keyboard shortcuts through UI Automation (Invoke), and checks those too.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\uia-check.ps1 [-Out C:\temp\uia]
param([string]$Out = (Join-Path ([IO.Path]::GetTempPath()) 'saqme-uia'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('saqme-uia-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
$app = Join-Path $tmp 'app'; $data = Join-Path $tmp 'data'
New-Item -ItemType Directory -Path $app, (Join-Path $data 'lists'), $Out -Force | Out-Null
Copy-Item -Path (Join-Path $root 'desktop\*') -Destination $app -Recurse -Force -Exclude 'cache'
Copy-Item -Path (Join-Path $root 'worker\public\fonts') -Destination (Join-Path $app 'fonts') -Recurse -Force
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($f in Get-ChildItem (Join-Path $root 'scripts\dev\sample') -Force -File) {
  $text = [regex]::Replace([IO.File]::ReadAllText($f.FullName), 'due:\{([+-]?\d+)\}', { param($m) 'due:' + (Get-Date).Date.AddDays([int]$m.Groups[1].Value).ToString('yyyy-MM-dd') })
  [IO.File]::WriteAllText((Join-Path $data "lists\$($f.Name)"), $text, $utf8)
}
[IO.File]::WriteAllText((Join-Path $data '.widget-settings'), "active=Work`nwidth=440`nheight=700`ntheme=dark`n", $utf8)
$hwndFile = Join-Path $tmp 'hwnd.txt'; $quitFile = Join-Path $tmp 'quit.txt'; $orderFile = Join-Path $tmp 'taborder.txt'; $orderAsk = Join-Path $tmp 'taborder.ask'

# ---------------------------------------------------------------- the widget copy
$w = [IO.File]::ReadAllText((Join-Path $app 'widget.ps1'))
$w = $w -replace '\$instance = \$\(if \(\$SmokeTest\)[^\r\n]*', '$instance = "Local\SaqmeToDo.Uia.$PID"'
$w = $w.Replace('$tray.Visible = -not $SmokeTest', '$tray.Visible = $false').Replace('$tray.Visible = $true', '$tray.Visible = $false')
$inject = @"
`$w.ShowActivated = `$false; `$w.ShowInTaskbar = `$false; `$w.Left = -5000; `$w.Top = 0; `$w.Width = 440; `$w.Height = 700
`$w.Show(); Render
if (`$script:visible.Count -gt 1) { Set-Sel `$script:visible[1] }   # a selected task, as after pressing Down
`$w.UpdateLayout()
# WPF's Tab order: within a navigation scope, tab stops sort by TabIndex, then by visual order; a container
# with TabNavigation Local (or Cycle / Contained / Once) is one entry, sorted by its own TabIndex
function Get-TabStops(`$v) {
  `$entries = New-Object System.Collections.ArrayList
  Collect-TabStops `$v `$entries
  `$out = New-Object System.Collections.ArrayList
  foreach (`$e in (`$entries | Sort-Object @{ Expression = { `$_.Idx } }, @{ Expression = { `$_.Order } })) { foreach (`$x in `$e.Items) { [void]`$out.Add(`$x) } }
  return ,`$out
}
function Collect-TabStops(`$v, `$entries) {
  `$n = [System.Windows.Media.VisualTreeHelper]::GetChildrenCount(`$v)
  for (`$i = 0; `$i -lt `$n; `$i++) {
    `$c = [System.Windows.Media.VisualTreeHelper]::GetChild(`$v, `$i)
    if (`$c -is [System.Windows.UIElement] -and -not `$c.IsVisible) { continue }
    `$isStop = `$c -is [System.Windows.UIElement] -and `$c.Focusable -and `$c.IsEnabled -and [System.Windows.Input.KeyboardNavigation]::GetIsTabStop(`$c)
    `$name = `$(if (`$isStop) { `$nm = [System.Windows.Automation.AutomationProperties]::GetName(`$c); if (`$nm) { `$nm } else { '(' + `$c.GetType().Name + ')' } })
    `$mode = `$(if (`$c -is [System.Windows.DependencyObject]) { [string][System.Windows.Input.KeyboardNavigation]::GetTabNavigation(`$c) } else { 'Continue' })
    `$idx = `$(if (`$c -is [System.Windows.DependencyObject]) { [System.Windows.Input.KeyboardNavigation]::GetTabIndex(`$c) } else { [int]::MaxValue })
    if (`$mode -ne 'Continue') {
      `$items = New-Object System.Collections.ArrayList
      if (`$isStop) { [void]`$items.Add(`$name) }
      foreach (`$x in (Get-TabStops `$c)) { [void]`$items.Add(`$x) }
      [void]`$entries.Add(@{ Idx = `$idx; Order = `$entries.Count; Items = `$items })
    } else {
      if (`$isStop) { [void]`$entries.Add(@{ Idx = `$idx; Order = `$entries.Count; Items = @(`$name) }) }
      Collect-TabStops `$c `$entries
    }
  }
}
`$ticker = New-Object System.Windows.Threading.DispatcherTimer; `$ticker.Interval = [TimeSpan]::FromMilliseconds(150)
`$ticker.Add_Tick({
  if (Test-Path '$orderAsk') {
    Remove-Item '$orderAsk' -Force
    `$acc = Get-TabStops `$w
    [IO.File]::WriteAllText('$orderFile', (`$acc -join "``n"))
  }
  if (Test-Path '$quitFile') { `$script:quitting = `$true; `$w.Close(); [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() }
})
`$ticker.Start()
[IO.File]::WriteAllText('$hwndFile', [string](New-Object System.Windows.Interop.WindowInteropHelper(`$w)).Handle)
[System.Windows.Threading.Dispatcher]::Run()
exit 0
"@
$m = [regex]::Match($w, '(?m)^if \(\$SmokeTest\) \{\s*$')
if (-not $m.Success) { throw 'anchor not found in widget.ps1' }
$w = $w.Substring(0, $m.Index) + $inject + "`n" + $w.Substring($m.Index)
[IO.File]::WriteAllText((Join-Path $app 'widget.ps1'), $w, $utf8)
$proc = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', "`"$(Join-Path $app 'widget.ps1')`"", '-DataDir', "`"$data`"") -PassThru -WindowStyle Hidden

# ---------------------------------------------------------------- the screen reader's side
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$failed = 0
$report = New-Object System.Text.StringBuilder
function Check([bool]$cond, [string]$what) { if ($cond) { Write-Host "  ok   $what" } else { Write-Host "  FAIL $what" -ForegroundColor Red; $script:failed++ } }
function Wait-For([scriptblock]$cond, [int]$ms = 15000) { $end = [DateTime]::UtcNow.AddMilliseconds($ms); while (-not (& $cond) -and [DateTime]::UtcNow -lt $end) { Start-Sleep -Milliseconds 150 }; return (& $cond) }

$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$named = @($CT::Button, $CT::ListItem, $CT::TabItem, $CT::CheckBox, $CT::RadioButton, $CT::Hyperlink, $CT::Edit, $CT::List, $CT::Tab)
$needs = @{ 'Button' = 'Invoke'; 'ListItem' = 'SelectionItem'; 'TabItem' = 'SelectionItem'; 'RadioButton' = 'SelectionItem'; 'CheckBox' = 'Toggle'; 'Hyperlink' = 'Invoke' }

function Get-Tree($el, [int]$depth, $acc) {
  $c = $el.Current
  $pats = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers.Pattern', '' -replace 'Identifiers.Pattern', '' })
  $type = $c.ControlType.ProgrammaticName -replace 'ControlType.', ''
  $state = ''
  if ($pats -contains 'SelectionItem') { if ($el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $state = ' [selected]' } }
  if ($pats -contains 'Toggle') { $state = ' [' + $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState + ']' }
  [void]$acc.Add([pscustomobject]@{ El = $el; Type = $type; Name = $c.Name; Help = $c.HelpText; Focusable = $c.IsKeyboardFocusable; Patterns = $pats; Depth = $depth; State = $state })
  $wk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $ch = $wk.GetFirstChild($el)
  while ($ch) { Get-Tree $ch ($depth + 1) $acc; $ch = $wk.GetNextSibling($ch) }
}

function Test-View([string]$view, $win) {
  Write-Host $view
  $acc = New-Object System.Collections.ArrayList
  Get-Tree $win 0 $acc
  [void]$report.AppendLine("== $view")
  foreach ($x in $acc) { [void]$report.AppendLine(('  ' * $x.Depth) + "$($x.Type) '$($x.Name)'$($x.State)$(if ($x.Help) { "  - $($x.Help)" })$(if ($x.Focusable) { '  (focusable)' })  {$($x.Patterns -join ',')}") }
  $interactive = @($acc | Where-Object { $named -contains [System.Windows.Automation.ControlType]::LookupById($_.El.Current.ControlType.Id) })
  $unnamed = @($interactive | Where-Object { -not $_.Name.Trim() })
  Check ($unnamed.Count -eq 0) "every control has a name ($($interactive.Count) controls$(if ($unnamed.Count) { '; unnamed: ' + (($unnamed | ForEach-Object { $_.Type }) -join ', ') }))"
  $noAction = @($acc | Where-Object { $needs.ContainsKey($_.Type) -and $_.Patterns -notcontains $needs[$_.Type] })
  Check ($noAction.Count -eq 0) "each one can be operated by a screen reader$(if ($noAction.Count) { ': missing for ' + (($noAction | ForEach-Object { "$($_.Type) '$($_.Name)'" }) -join ', ') })"
  $notFocusable = @($acc | Where-Object { $needs.ContainsKey($_.Type) -and -not $_.Focusable })
  Check ($notFocusable.Count -eq 0) "and is keyboard-focusable$(if ($notFocusable.Count) { ': not ' + (($notFocusable | ForEach-Object { "$($_.Type) '$($_.Name)'" }) -join ', ') })"
  $glyphs = @($acc | Where-Object { $_.Name -match '[\uE000-\uF8FF]' })
  Check ($glyphs.Count -eq 0) "no icon-font glyphs read out as text$(if ($glyphs.Count) { ' (' + $glyphs.Count + ' found)' })"
  return ,$acc
}

try {
  if (-not (Wait-For { Test-Path $hwndFile })) { throw 'the widget copy did not start' }
  Start-Sleep -Milliseconds 800
  $win = $A::FromHandle([IntPtr][long](Get-Content $hwndFile))

  # ---- the list view
  $acc = Test-View 'list view' $win
  $lists = @($acc | Where-Object { $_.Type -eq 'List' })
  $items = @($acc | Where-Object { $_.Type -eq 'ListItem' })
  $statusWords = 'To do|In progress|Done|Postponed|Blocked|Failed|Abandoned'
  Check ($lists.Count -ge 1 -and $items.Count -ge 5) "the tasks are a list of items ($($items.Count) items in '$($lists[0].Name)')"
  Check (@($items | Where-Object { $_.Name -notmatch $statusWords }).Count -eq 0) "every task's name says its status in words (e.g. '$($items[0].Name)')"
  Check (@($items | Where-Object { $_.State -eq ' [selected]' }).Count -eq 1) 'the selected task is reported as selected'
  Check (@($acc | Where-Object { $_.Type -eq 'ListItem' -and $_.Name -match 'overdue' }).Count -ge 1) 'an overdue deadline is said in words, not only in red'
  $tabs = @($acc | Where-Object { $_.Type -eq 'TabItem' })
  Check (@($acc | Where-Object { $_.Type -eq 'Tab' -and $_.Name -eq 'Projects' }).Count -eq 1 -and $tabs.Count -eq 3) "the projects are a tab list ($(($tabs | ForEach-Object { $_.Name }) -join ' | '))"
  Check (@($tabs | Where-Object { $_.State -eq ' [selected]' }).Count -eq 1) 'the current project is the selected tab'
  Check (@($acc | Where-Object { $_.Type -eq 'Button' -and $_.Name -like 'Status: *' }).Count -ge 5) 'status chips are buttons named by their status'
  Check (@($acc | Where-Object { $_.Type -eq 'Edit' -and $_.Name -eq 'Add a task' }).Count -eq 1) 'the new-task box is labelled'

  Set-Content $orderAsk 'x'
  [void](Wait-For { Test-Path $orderFile })
  Start-Sleep -Milliseconds 200
  $order = @(Get-Content $orderFile)
  [void]$report.AppendLine('== Tab order (list view)'); foreach ($o in $order) { [void]$report.AppendLine("  $o") }
  $iSettings = [array]::IndexOf($order, 'Settings'); $iTab = [array]::IndexOf($order, ($order | Where-Object { $_ -like 'Work*' } | Select-Object -First 1))
  $iClose = [array]::IndexOf($order, ($order | Where-Object { $_ -like 'Close*' } | Select-Object -First 1)); $iAdd = [array]::IndexOf($order, 'Add a task')
  $iRow = [array]::IndexOf($order, ($order | Where-Object { $_ -match "$statusWords" -and $_ -notlike 'Status:*' } | Select-Object -First 1))
  Check ($iSettings -eq 0 -and $iTab -gt $iSettings -and $iClose -gt $iTab -and $iRow -gt $iClose -and $iAdd -gt $iRow) "Tab order: $($order -join ' > ')"
  Check (@($order | Where-Object { $_ -match "$statusWords" -and $_ -notlike 'Status:*' }).Count -eq 1) 'the list is one Tab stop (arrow keys move inside it)'
  Check (@($order | Where-Object { $_ -like '(*' }).Count -eq 0) 'every Tab stop has a name'

  # ---- Settings, opened the way a screen reader would: Invoke on the Settings button
  $settings = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Settings')))
  $settings.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 900
  $acc = Test-View 'settings view' $win
  Check (@($acc | Where-Object { $_.Type -eq 'RadioButton' }).Count -eq 3 -and @($acc | Where-Object { $_.Type -eq 'RadioButton' -and $_.State -eq ' [selected]' }).Count -eq 1) 'theme choice: three radio buttons, one selected'
  Check (@($acc | Where-Object { $_.Type -eq 'CheckBox' -and $_.Name -eq 'Start with Windows' }).Count -eq 1) "'Start with Windows' is a switch with its state"
  Check (@($acc | Where-Object { $_.Type -eq 'Edit' -and $_.Name -eq 'Daily summary time' }).Count -eq 1) 'the time box is labelled'

  $kb = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Keyboard shortcuts')))
  $kb.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 900
  $acc = Test-View 'keyboard shortcuts view' $win
  Check (@($acc | Where-Object { $_.Name -like 'Move between the tabs*' }).Count -ge 1) 'the shortcuts list explains Tab'
} finally {
  Set-Content $quitFile 'x'
  [void](Wait-For { $proc.HasExited } 8000)
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  [IO.File]::WriteAllText((Join-Path $Out 'uia-tree.txt'), $report.ToString(), $utf8)
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ''
Write-Host "Automation tree: $(Join-Path $Out 'uia-tree.txt')"
if ($failed) { Write-Host "$failed check(s) FAILED" -ForegroundColor Red; exit 1 } else { Write-Host 'uia checks passed' }
