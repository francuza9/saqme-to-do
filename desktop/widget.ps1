param([string]$DataDir = '', [switch]$SmokeTest)
# Saqme To Do - to-do widget with project tabs, optionally synced with the iPhone app (see docs/).
# Runs in the system tray: X hides the window, tray icon > Quit exits.
# App files sit next to this script; your data lives in %APPDATA%\SaqmeToDo (or -DataDir / $env:SAQME_DATA_DIR;
# a "lists" folder next to the script means portable mode). Each project is one markdown file in
# lists\<Project>.md (tab order in lists\.order); sync state is in sync\.
#   Tabs                       -> click to switch, + to add, double/right-click to rename / delete
#   Click a task's text        -> edit it
#     Enter                    -> save + start a new task below
#     Shift+Enter              -> save + start a new subtask
#     Enter on an empty line   -> stop editing (empty tasks are removed)
#     Esc                      -> cancel;  Tab / Shift+Tab -> indent / outdent
#   Click the status square    -> pick status
#   Chevron                    -> open / close a task (subtasks + notes)
#   Hover a task               -> deadline, notes/links, + subtask, x delete
#   Drag the tab bar to move; drag any edge to resize.
#   Postponed tasks are listed at the bottom; done + rejected fold into "Completed".
# File format (plain markdown, editable by hand or by an AI assistant; see docs/file-format.md):
#   - [ ] task text due:2026-10-25 ^k3j9x2ab   (due: is optional; due:2026-10-25T14:00 adds a time;
#                                               the ^id is added automatically and hidden in the app)
#     > a note or link under the task     (notes are "> " lines indented one level deeper)
#     - [ ] subtask                        (two spaces per level)
#   statuses: [ ] to do  [/] in progress  [x] done  [>] postponed  [!] blocked  [-] failed / rejected  [~] abandoned
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing
# own taskbar identity, so Windows shows the Saqme icon instead of grouping it under PowerShell
$AppId = 'Saqme.ToDo'
Add-Type -Namespace Saqme -Name Shell -MemberDefinition '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string id);'
[void][Saqme.Shell]::SetCurrentProcessExplicitAppUserModelID($AppId)
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $script:toastOk = $true
} catch { $script:toastOk = $false }

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path      # app files (scripts, assets)
. (Join-Path $dir 'sync-core.ps1')
# the data folder; the self-check never touches real lists (a temp folder without -DataDir, see Resolve-WidgetDataDir)
$where = Resolve-WidgetDataDir $DataDir -SmokeTest:$SmokeTest $dir $env:SAQME_DATA_DIR ([Environment]::GetFolderPath('ApplicationData')) ([IO.Path]::GetTempPath())
if ($where.Refused) { Write-Output "SMOKE FAIL: $($where.Refused)"; exit 2 }
$DataDir = $where.Dir
$script:smokeTemp = $where.Temp
if ($script:smokeTemp) { Write-Output "SMOKE DATA: no -DataDir given, so the self-check runs in a new temp folder, $DataDir (deleted afterwards)" }
if (-not (Test-Path -LiteralPath $DataDir)) { [void](New-Item -ItemType Directory -Path $DataDir -Force) }
$listsDir  = Join-Path $DataDir 'lists'
$orderFile = Join-Path $listsDir '.order'
$stateFile = Join-Path $listsDir '.state'
$posFile   = Join-Path $DataDir '.widget-pos'
$cfgFile   = Join-Path $DataDir '.widget-settings'
$syncDir   = Join-Path $DataDir 'sync'
$syncCfgFile = Join-Path $syncDir 'config.json'
$logoFile  = Join-Path $dir 'assets\saqme-glyph.png'
$iconFile  = Join-Path $dir 'assets\saqme.png'
$notifFile = Join-Path $listsDir '.notified'
$CI        = [Globalization.CultureInfo]::InvariantCulture
. (Join-Path $dir 'qr.ps1')
. (Join-Path $dir 'update-core.ps1')
# this version (release.json, from worker\package.json) and where it is installed: <install>\versions\<v>\ (setup.ps1);
# $null when it runs from a copy of the repository, which does not update itself (docs/setup.md, "Updating")
$script:Release = Get-AppRelease $dir
$InstallRoot = Get-InstallRoot $dir
# what starts the app (shortcuts, start with Windows, a restart): the launcher next to versions\ picks the current one
$Launcher = $(if ($InstallRoot -and (Test-Path -LiteralPath (Join-Path $InstallRoot 'start-widget.vbs'))) { Join-Path $InstallRoot 'start-widget.vbs' } else { Join-Path $dir 'start-widget.vbs' })
$script:startHidden = ($env:SAQME_START_HIDDEN -eq '1')   # the updater restarted an app whose window was hidden
Remove-Item Env:\SAQME_START_HIDDEN -ErrorAction SilentlyContinue

# one instance per user: a second start just shows the running one; setup.ps1 can ask it to quit.
# SAQME_INSTANCE (Local\SaqmeToDo.<something>) gives a test copy a name of its own (setup's sandbox).
$instance = $(if ($SmokeTest) { "Local\SaqmeToDo.Smoke.$PID" } elseif ($env:SAQME_INSTANCE -match '^Local\\SaqmeToDo\.[\w.-]+$') { $env:SAQME_INSTANCE } else { 'Local\SaqmeToDo' })
$showEvt = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "$instance.Show")
$quitEvt = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "$instance.Quit")
$mutex = New-Object System.Threading.Mutex($false, "$instance.Instance")
try { $got = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
if (-not $got) {
  # already running: ask that instance to show itself, and hand it the saqme:// link this start came with (an
  # invite to a shared list: start-widget.vbs puts it in SAQME_OPEN_URL; the running app asks before it joins)
  if ($env:SAQME_OPEN_URL -and -not $SmokeTest) { try { [IO.File]::WriteAllText((Join-Path $DataDir '.open-url'), $env:SAQME_OPEN_URL) } catch {} }
  [void]$showEvt.Set(); exit
}
$script:mutexHeld = $true
$script:pendingUrl = $env:SAQME_OPEN_URL   # (handled once the window is up)
Remove-Item Env:\SAQME_OPEN_URL -ErrorAction SilentlyContinue   # not for the programs this app starts

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, $Utf8NoBom) }
function Read-Lines([string]$path) {
  if (Test-Path -LiteralPath $path) { try { return [IO.File]::ReadAllLines($path, [Text.Encoding]::UTF8) } catch {} }
  return @()
}

# ---------------------------------------------------------------- first run / migration
if (-not (Test-Path -LiteralPath $listsDir)) { [void](New-Item -ItemType Directory -Path $listsDir) }
if (-not (Get-ChildItem -LiteralPath $listsDir -Filter *.md -File)) {
  $old = Join-Path $DataDir 'todo.md'
  if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination (Join-Path $listsDir 'General.md') }
  else { Write-Utf8 (Join-Path $listsDir 'General.md') '' }
  if (-not (Test-Path -LiteralPath $orderFile)) { Write-Utf8 $orderFile "General`n" }
}

# ---------------------------------------------------------------- settings + open/closed state
$script:cfg = @{ showCompleted = '0'; active = ''; width = ''; height = ''; theme = 'auto'; notifyAt = '10:00'; autoUpdate = '1'; updatedSeen = '' }
foreach ($l in (Read-Lines $cfgFile)) { if ($l -match '^(\w+)=(.*)$') { $script:cfg[$matches[1]] = $matches[2] } }
function Save-Settings {
  $t = ($script:cfg.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
  try { Write-Utf8 $cfgFile ($t + "`n") } catch {}
}
$script:openState = @{}
# keys: task id (current) or "project<TAB>text" (written by older versions, still honoured)
foreach ($l in (Read-Lines $stateFile)) {
  $p = $l.Split("`t")
  if ($p.Count -eq 3) { $script:openState["$($p[0])`t$($p[1])"] = $p[2] }
  elseif ($p.Count -eq 2) { $script:openState[$p[0]] = $p[1] }
}
function Save-State {
  $t = ($script:openState.GetEnumerator() | ForEach-Object { "$($_.Key)`t$($_.Value)" }) -join "`n"
  try { Write-Utf8 $stateFile ($t + "`n") } catch {}
}

# ---------------------------------------------------------------- theme + type (shared with the phone app)
# $Tokens and $Themes come from tokens.ps1, generated from design/tokens.json (docs/design.md)
. (Join-Path $dir 'tokens.ps1')
. (Join-Path $dir 'rules.ps1')
$TypeSize = @{}; foreach ($k in $Tokens.Type.Keys) { $TypeSize[$k] = [double]$Tokens.Type[$k].Size }
function Resolve-Theme([string]$pref) {
  if ($pref -eq 'light' -or $pref -eq 'dark') { return $pref }
  try {
    $v = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop).AppsUseLightTheme
    if ($v -eq 1) { return 'light' }
  } catch {}
  return 'dark'
}
if (@('dark', 'light', 'auto') -notcontains $script:cfg.theme) { $script:cfg.theme = 'auto' }

$MDL2 = New-Object System.Windows.Media.FontFamily('Segoe MDL2 Assets')
# the phone app's typeface (FiraGO), loaded from the bundled files; Segoe UI if they are missing
function Get-UiFont {
  foreach ($fd in @((Join-Path $dir 'fonts'), (Join-Path $dir '..\worker\public\fonts'))) {
    if (-not (Test-Path -LiteralPath (Join-Path $fd $Tokens.Font.Files[0]))) { continue }
    try {
      $uri = New-Object Uri(((Resolve-Path -LiteralPath $fd).ProviderPath.TrimEnd('\') + '\'))
      $found = @([System.Windows.Media.Fonts]::GetFontFamilies($uri) | Where-Object { $_.Source -like "*#$($Tokens.Font.Family)" })
      if ($found.Count) {
        $script:FontSource = $uri.AbsoluteUri + '#' + $Tokens.Font.Family + ', ' + $Tokens.Font.Fallback   # for the XAML styles
        return New-Object System.Windows.Media.FontFamily($uri, "./#$($Tokens.Font.Family), $($Tokens.Font.Fallback)")
      }
    } catch {}
  }
  $script:FontSource = $Tokens.Font.Fallback
  return New-Object System.Windows.Media.FontFamily($Tokens.Font.Fallback)
}
$UI = Get-UiFont
function Set-Tabular($tb) { [System.Windows.Documents.Typography]::SetNumeralAlignment($tb, [System.Windows.FontNumeralAlignment]::Tabular) }

# ---------------------------------------------------------------- accessibility (a11y.cs, docs/accessibility.md)
# Compiled once with the .NET Framework's own compiler into cache\, then loaded from there (fast). If that fails
# for any reason the widget still runs, with plain Borders (mouse and shortcuts work, screen readers see less).
function Import-A11y {
  if ('Saqme.AccessibleBorder' -as [type]) { return $true }
  try {
    Add-Type -AssemblyName UIAutomationProvider, UIAutomationTypes
    $src = [IO.File]::ReadAllText((Join-Path $dir 'a11y.cs'))
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($src))[0..7] | ForEach-Object { $_.ToString('x2') })
    $refs = @([System.Windows.Controls.Border].Assembly.Location, [System.Windows.UIElement].Assembly.Location, [System.Windows.DependencyObject].Assembly.Location,
              [System.Windows.Automation.Provider.IInvokeProvider].Assembly.Location, [System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location,
              [System.Xaml.XamlType].Assembly.Location)
    foreach ($cache in @((Join-Path $dir 'cache'), (Join-Path ([IO.Path]::GetTempPath()) 'saqme-cache'))) {
      $dll = Join-Path $cache "a11y-$hash.dll"
      try {
        if (-not (Test-Path -LiteralPath $dll)) {
          [void](New-Item -ItemType Directory -Path $cache -Force)
          Add-Type -TypeDefinition $src -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library -ErrorAction Stop
        }
        Add-Type -Path $dll -ErrorAction Stop
        # builds from earlier versions of a11y.cs are not needed any more
        Get-ChildItem -LiteralPath $cache -Filter 'a11y-*.dll' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ne $dll } | Remove-Item -Force -ErrorAction SilentlyContinue
        return $true
      } catch {}
    }
    Add-Type -TypeDefinition $src -ReferencedAssemblies $refs -ErrorAction Stop   # in memory
    return $true
  } catch { return $false }
}
$script:HasA11y = Import-A11y

# A Border that is also a control for keyboards and screen readers; Activate runs on Enter / Space and when
# UI Automation (Narrator) invokes, selects or toggles it. Mouse handlers are added by the caller as before.
#   role: button | listitem | tab | toggle | radio | link
function New-Control([string]$role, [string]$name, [string]$help = '', [scriptblock]$onActivate = $null) {
  if ($script:HasA11y) {
    $b = New-Object Saqme.AccessibleBorder
    $b.Role = $role
    if ($role -eq 'listitem') { $b.ActivateOnKeys = $false }
    if ($role -eq 'none') { $b.Focusable = $false; $b.ActivateOnKeys = $false }
    if ($onActivate) { $b.Add_Activate($onActivate) }
    $b.FocusVisualStyle = $script:FocusRing
  } else { $b = New-Object System.Windows.Controls.Border }
  Set-Name $b $name $help
  return $b
}
# Wraps a purely visual element (a placeholder over a text box, an icon) so screen readers skip it; keeps its
# place in a Grid. The text box or button next to it carries the words.
function Hide-Decoration($el) {
  if (-not $script:HasA11y) { return $el }
  $d = New-Control 'none' ''
  foreach ($p in 'Margin', 'HorizontalAlignment', 'VerticalAlignment', 'IsHitTestVisible') { $d.$p = $el.$p }
  [System.Windows.Controls.Grid]::SetColumn($d, [System.Windows.Controls.Grid]::GetColumn($el)); [System.Windows.Controls.Grid]::SetRow($d, [System.Windows.Controls.Grid]::GetRow($el))
  $el.Margin = '0'
  $d.Child = $el
  return $d
}
function Set-Name($el, [string]$name, [string]$help = '') {
  [System.Windows.Automation.AutomationProperties]::SetName($el, $name)
  if ($help) { [System.Windows.Automation.AutomationProperties]::SetHelpText($el, $help) }
}
function New-AccessibleList([string]$role, [string]$name) {
  $p = $(if ($script:HasA11y) { $x = New-Object Saqme.AccessiblePanel; $x.Role = $role; $x } else { New-Object System.Windows.Controls.StackPanel })
  Set-Name $p $name
  return $p
}
function Brush([string]$hex) {
  $b = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
  $b.Freeze(); return $b
}
function G([int]$code) { return [string][char]$code }

function St([string]$m) {
  foreach ($s in $script:Statuses) { if ($s.Mark -eq $m) { return $s } }
  return $script:Statuses[0]
}
# 0 = active, 1 = postponed, 2 = closed (done / rejected / abandoned)
function Rank([string]$m) { if ($m -eq 'x' -or $m -eq '-' -or $m -eq '~') { return 2 } elseif ($m -eq '>') { return 1 } else { return 0 } }

# styles for menus, tooltips and the scrollbar (popups otherwise use the plain Windows look)
$script:stylesTemplate = @'
<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Style TargetType="ContextMenu">
    <Setter Property="HasDropShadow" Value="False"/>
    <Setter Property="SnapsToDevicePixels" Value="True"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="ContextMenu">
          <Border Margin="0,0,10,10" Background="{MenuBg}" BorderBrush="{Edge}" BorderThickness="1" CornerRadius="10" Padding="4">
            <Border.Effect><DropShadowEffect BlurRadius="14" ShadowDepth="3" Opacity="0.3"/></Border.Effect>
            <StackPanel IsItemsHost="True" KeyboardNavigation.DirectionalNavigation="Cycle"/>
          </Border>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style TargetType="MenuItem">
    <Setter Property="FontFamily" Value="{Font}"/>
    <Setter Property="FontSize" Value="{LabelSize}"/>
    <Setter Property="Foreground" Value="{Ink}"/>
    <Setter Property="Cursor" Value="Hand"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="MenuItem">
          <Border x:Name="bd" Background="Transparent" CornerRadius="7" Padding="12,7,20,7" MinWidth="160">
            <ContentPresenter ContentSource="Header" RecognizesAccessKey="False" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsHighlighted" Value="True">
              <Setter TargetName="bd" Property="Background" Value="{MenuHover}"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style TargetType="Separator">
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="Separator">
          <Border Height="1" Background="{Line}" Margin="8,4"/>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style TargetType="ToolTip">
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="ToolTip">
          <Border Background="{TipBg}" CornerRadius="5" Padding="8,4" Margin="0,0,6,6">
            <ContentPresenter TextElement.Foreground="{TipFg}" TextElement.FontSize="{SmallSize}"
                              TextElement.FontFamily="{Font}"/>
          </Border>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style TargetType="ScrollBar">
    <Setter Property="Width" Value="6"/>
    <Setter Property="MinWidth" Value="6"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="ScrollBar">
          <Track x:Name="PART_Track" IsDirectionReversed="True">
            <Track.Thumb>
              <Thumb>
                <Thumb.Template>
                  <ControlTemplate TargetType="Thumb">
                    <Border Background="{Thumb}" CornerRadius="3"/>
                  </ControlTemplate>
                </Thumb.Template>
              </Thumb>
            </Track.Thumb>
          </Track>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
</ResourceDictionary>
'@

# everything colour-dependent is (re)built here; Apply-Theme also repaints the window live
function Set-Palette([string]$name) {
  $script:themeName = $name
  $script:T = $Themes[$name]
  $T = $script:T
  $script:Statuses = @(
    [pscustomobject]@{ Mark=' '; Name='To do';             Chip='#00000000';    Edge=$T.S_todo_edge;  Text=$T.S_todo_text;  Glyph='';           Strike=$false; Half=$false; Italic=$false }
    [pscustomobject]@{ Mark='/'; Name='In progress';       Chip=$T.S_prog_chip; Edge=$T.S_prog_chip;  Text=$T.S_prog_text;  Glyph='';           Strike=$false; Half=$true;  Italic=$false }
    [pscustomobject]@{ Mark='x'; Name='Done';              Chip=$T.S_done_chip; Edge=$T.S_done_chip;  Text=$T.S_done_text;  Glyph=(G 0xE73E); GlyphInk=$T.S_done_glyph;  Strike=$true;  Half=$false; Italic=$false }
    [pscustomobject]@{ Mark='>'; Name='Postponed';         Chip=$T.S_post_chip; Edge=$T.S_post_chip;  Text=$T.S_post_text;  Glyph=(G 0xE823); GlyphInk=$T.S_post_glyph;  Strike=$false; Half=$false; Italic=$true  }
    [pscustomobject]@{ Mark='!'; Name='Blocked / waiting'; Chip=$T.S_block_chip; Edge=$T.S_block_chip; Text=$T.S_block_text; Glyph=(G 0xE8C9); GlyphInk=$T.S_block_glyph; Strike=$false; Half=$false; Italic=$false }
    [pscustomobject]@{ Mark='-'; Name='Failed / rejected'; Chip=$T.S_rej_chip;  Edge=$T.S_rej_chip;   Text=$T.S_rej_text;   Glyph=(G 0xE711); GlyphInk=$T.S_rej_glyph;   Strike=$true;  Half=$false; Italic=$false }
    [pscustomobject]@{ Mark='~'; Name='Abandoned';         Chip=$T.S_aband_chip; Edge=$T.S_aband_chip; Text=$T.S_aband_text; Glyph=(G 0xE738); GlyphInk=$T.S_aband_glyph; Strike=$true;  Half=$false; Italic=$true  }
  )

  foreach ($pair in @(
      @('Card','Card'), @('StripBg','Strip'), @('Edge','Edge'), @('Hover','Hover'), @('TabHover','TabHover'), @('TabInk','TabInk'),
      @('Ink','Ink'), @('Faint','Faint'), @('Line','Line'), @('Accent','Accent'), @('NoteBg','NoteBg'), @('NoteInk','NoteInk'),
      @('MenuBg','MenuBg'), @('MenuHover','MenuHover'), @('Red','Red'), @('RedSoft','RedSoft'), @('Amber','Amber'),
      @('AmberSoft','AmberSoft'), @('CloseHover','CloseHover'), @('CloseGlyph','CloseGlyph'), @('Paper','Paper'), @('Selected','Selected'), @('ButtonBg','ButtonBg'),
      @('OnAccent','OnAccent'), @('Closed','Closed'),
      @('GroupBg','Group'), @('GroupHover','GroupHover'), @('GroupPress','GroupPress'), @('GroupSel','GroupSel'), @('GroupLine','GroupLine'))) {
    Set-Variable -Scope Script -Name $pair[0] -Value (Brush $T[$pair[1]])
  }
  $script:Clear = [System.Windows.Media.Brushes]::Transparent
  $x = $script:stylesTemplate
  foreach ($k in 'MenuBg', 'Edge', 'Ink', 'MenuHover', 'Line', 'TipBg', 'TipFg', 'Thumb') { $x = $x.Replace("{$k}", $T[$k]) }
  $x = $x.Replace('{Font}', [System.Security.SecurityElement]::Escape($script:FontSource)).Replace('{LabelSize}', [string]$TypeSize.label).Replace('{SmallSize}', [string]$TypeSize.small)
  $script:Styles = [Windows.Markup.XamlReader]::Parse($x)
  # keyboard focus ring for the widget's own controls: 2 px violet, drawn only for keyboard focus
  $script:FocusRing = [Windows.Markup.XamlReader]::Parse(('<Style xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Setter Property="Control.Template"><Setter.Value>' +
    '<ControlTemplate><Rectangle Stroke="{0}" StrokeThickness="2" RadiusX="6" RadiusY="6" Margin="-1" SnapsToDevicePixels="True"/></ControlTemplate>' +
    '</Setter.Value></Setter></Style>') -f $T.Accent)
}
Set-Palette (Resolve-Theme $script:cfg.theme)

function Apply-Theme([string]$name) {
  if ($name -eq $script:themeName) { Render; return }
  Commit-Edit
  Set-Palette $name
  foreach ($k in @($w.Resources.Keys)) { $w.Resources.Remove($k) }
  foreach ($k in $script:Styles.Keys) { $w.Resources[$k] = $script:Styles[$k] }
  $outer.Background = $Card; $outer.BorderBrush = $Edge
  $strip.Background = $StripBg; $strip.BorderBrush = $Line
  $countText.Foreground = $Faint
  foreach ($b in @($menuBtn, $minBtn, $maxBtn, $clsBtn)) { $b.Child.Foreground = $TabInk }
  $addBorder.Background = $GroupBg; $addBox.Foreground = $Ink; $addBox.CaretBrush = $Accent
  $ph.Foreground = $Accent; $phText.Foreground = $Faint
  $conflictBadge.Background = $AmberSoft; $cbText.Foreground = $Amber
  if ($notice) { Update-NoticeColors }   # (defined further down; not yet at the first theme)
  [void](Update-SyncIndicator -Force)
  try {
    $cms.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#' + $T.MenuBg.Substring(3))
    $cms.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#' + $T.Ink.Substring(3))
  } catch {}
  Render
}
function New-Menu {
  $m = New-Object System.Windows.Controls.ContextMenu
  $m.Style = $script:Styles[[System.Windows.Controls.ContextMenu]]
  return $m
}
function New-MenuItem($header) {
  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Style = $script:Styles[[System.Windows.Controls.MenuItem]]
  $mi.Header = $header
  return $mi
}
function New-Separator {
  $s = New-Object System.Windows.Controls.Separator
  $s.Style = $script:Styles[[System.Windows.Controls.Separator]]
  return $s
}

# ---------------------------------------------------------------- projects
function Proj-Path([string]$name) { return (Join-Path $listsDir "$name.md") }
function Get-ProjectNames {
  $files = @(Get-ChildItem -LiteralPath $listsDir -Filter *.md -File | ForEach-Object { $_.BaseName } | Where-Object { -not $script:leaving.ContainsKey($_) })
  $order = @(Read-Lines $orderFile | Where-Object { $_ -and ($files -contains $_) } | Select-Object -Unique)
  $rest  = @($files | Where-Object { $order -notcontains $_ } | Sort-Object)
  return @($order + $rest)
}

# ---------------------------------------------------------------- shared lists (docs/sync.md, "Shared lists")
# A list someone shares with this PC is a file like any other, bound in lists\.remotes.json to its owner's server
# (sync-core.ps1 Read-ShareBindings; the sync loop keeps it in step, and makes every change to the bindings). With
# view access it is read-only here. Lists of this PC that others have come from the sync loop (SharedByMe).
$script:bindings = @(); $script:bindSig = $null; $script:leaving = @{}; $script:readOnly = $false
function Update-Bindings {
  $p = Join-Path $listsDir '.remotes.json'
  $sig = $(try { [string](Get-Item -LiteralPath $p -ErrorAction Stop).LastWriteTimeUtc.Ticks } catch { '' })
  if ($sig -eq $script:bindSig) { return }
  $script:bindSig = $sig
  $script:bindings = @((Read-ShareBindings $listsDir) | Where-Object { -not $_['left'] })
}
function Get-ShareOf([string]$name) {
  foreach ($b in $script:bindings) { if ([string]$b['file'] -eq $name) { return $b } }
  return $null
}
function Test-SharedByMe([string]$name) { return [bool]($script:sync -and $script:sync.SharedByMe -and $script:sync.SharedByMe.ContainsKey($name)) }
function Update-ReadOnly {
  Update-Bindings
  $b = Get-ShareOf $script:proj
  $script:readOnly = [bool]($b -and [string]$b['access'] -ne 'edit')
}
function Get-ShareHost($b) { try { return ([Uri][string]$b['server']).Host } catch { return [string]$b['server'] } }
$script:AccessText = @{
  edit = @('Can edit', 'They can add, change, check off and delete tasks in this list.')
  view = @('Can view', 'They see the list and its updates, but can''t change anything.')
}
$script:ShareNeedsSync = 'Sharing needs sync with your own Cloudflare account (Settings > Sync & sharing): a shared list lives on your sync service, where the people you share it with sync it from.'
# a Worker below this API has no shared lists (worker/src/version.js SHARING_API; the phone app's store.js says the same)
$script:SharingApi = 2
$script:WorkerTooOld = 'Your sync service runs an older version, without shared lists yet. It is updated together with this app (Settings > Updates); then try again.'
# from this API on the Worker can update itself, given a token (worker/src/version.js SELF_UPDATE_API; store.js too)
$script:SelfUpdateApi = 4
function Save-Order($names) { try { Write-Utf8 $orderFile ((@($names) -join "`n") + "`n") } catch {} }
function Open-Count([string]$name) {
  $n = 0
  foreach ($l in (Read-Lines (Proj-Path $name))) { if ($l -match '^\s*[-*]\s+\[[ /!]\]\s*\S') { $n++ } }
  return $n
}
function Tab-Signature {
  $parts = @(Get-ChildItem -LiteralPath $listsDir -Filter *.md -File | ForEach-Object { "$($_.Name):$($_.LastWriteTimeUtc.Ticks)" })
  foreach ($f in @($orderFile, (Join-Path $listsDir '.remotes.json'))) { if (Test-Path -LiteralPath $f) { $parts += (Get-Item -LiteralPath $f).LastWriteTimeUtc.Ticks } }
  $parts += (Get-Date).ToString('yyyy-MM-dd')   # (what is due today changes at midnight)
  if ($script:sync -and $script:sync.SharedByMe) { $parts += (@($script:sync.SharedByMe.Keys) | Sort-Object) -join ',' }   # badges of lists shared by this PC
  return ($parts -join '|')
}

# ---------------------------------------------------------------- row geometry
# A task row: [2 px selection edge][drag handle][chevron][status chip][gap][text ...][deadline etc.]. The handle
# and chevron columns are their click targets; the empty space around them is what was trimmed (BUGS #9).
# Everything that lines up with the rows (notes, hairlines, section headings, the add line) is derived from
# these, measured from the left edge of the card the rows sit in.
$RowGripW = 13   # six dots, 7 px wide, 3 px on each side
$RowChevW = 16   # an 8 pt chevron with room to click it
$RowChipX = $RowGripW + $RowChevW                    # where the chip column starts (after the 2 px edge)
$RowTextX = 2 + $RowChipX + 17 + $Tokens.Row.chipGap   # where the text starts: edge, columns, chip, gap
# the cards of a grouped list (docs/design.md, "Grouped lists"): inset from the window, rounded, spaced apart
$CardInset = $Tokens.Card.inset     # window edge to card
$CardPad = $Tokens.Card.padding     # card edge to a row's text (rows without an icon)
$CardGap = $Tokens.Card.gap         # between two cards (or a footnote and the next card)
$CardRadius = $Tokens.Radius.card
$RowMinH = $Tokens.Card.rowMin      # a Settings row

# ---------------------------------------------------------------- model
# parsing / writing is shared with the sync engine (sync-core.ps1: Read-Items, ConvertTo-MarkdownText)
$script:items = New-Object System.Collections.ArrayList
function New-Task([int]$level, [string]$mark, [string]$text) {
  $t = New-TaskItem $level $mark $text
  if (-not $t.Id) { $t.Id = New-SaqmeId }
  return $t
}
# text -> id per project from the last load: an editor that drops the ^id markers gets the same ids back
$script:knownIds = @{}
# The open list from disk, with ids added where lines lack them. $null when it cannot be loaded safely right
# now: another program holds it, or (-Settle) changed it in the last 1.5 s and may still be writing it (the
# sync engine waits the same), or the ids could not be written back onto exactly what was read. Callers keep
# what they have, or show the list as busy (Use-Loaded), and try again on the next tick.
function Load-Items([switch]$Settle) {
  if (-not (Test-Path -LiteralPath $script:todo)) { return ,(New-Object System.Collections.ArrayList) }
  if ($Settle) {
    try { $age = ([DateTime]::UtcNow - [IO.File]::GetLastWriteTimeUtc($script:todo)).TotalMilliseconds } catch { return $null }
    if ($age -ge 0 -and $age -lt 1500) { return $null }
  }
  $text = Read-TextFile $script:todo
  if ($null -eq $text) { return $null }
  $list = Read-Items $text
  $eol = Get-TextEol $text   # written back with the line endings it has
  if (Set-MissingIds $list $script:knownIds[$script:proj] $null) {
    $stamped = ConvertTo-MarkdownText $list 0 $eol
    try { if (-not (Write-TextFileIfUnchanged $script:todo $stamped $text)) { return $null } } catch { return $null }
    $text = $stamped
  }
  $script:eol = $eol
  $script:loadedText = $text   # what the in-memory list is based on (Save-Items merges if the file moved on)
  $map = New-TextMap
  foreach ($it in $list) { if ($it.Kind -eq 'task' -and $it.Text) { $map[$it.Text] = $it.Id } }
  $script:knownIds[$script:proj] = $map
  return ,$list
}

# shows a freshly loaded list, or "busy" when it could not be loaded (Load-Items); $true when loaded
function Use-Loaded($loaded) {
  if ($null -eq $loaded) {
    if (-not $script:listBusy) { $script:items = New-Object System.Collections.ArrayList; $script:listBusy = $true; $script:loadedText = $null }
    return $false
  }
  $script:items = $loaded; $script:listBusy = $false; $script:allowRemove.Clear()
  try { $script:lastWrite = (Get-Item -LiteralPath $script:todo).LastWriteTimeUtc } catch {}
  return $true
}

# The list could not be written this moment (another program holds it, or changed it while we saved): the
# edit stays in memory and the timer saves it, merged with that program's version, as soon as it can.
function Defer-Save([string]$why = '') {
  if (-not $script:saveFailed) { $script:saveFailedSince = Get-Date }
  $script:saveFailed = $true
  if (-not $script:saveWarned -and ((Get-Date) - $script:saveFailedSince).TotalSeconds -ge 5) {
    $script:saveWarned = $true
    Show-Toast 'Saqme To Do' "'$($script:proj)' is busy in another program$(if ($why) { " ($why)" }). Your changes are kept and saved as soon as it is free." $script:proj
  }
}

# a save that keeps failing must not lose the edits when the list is closed (quit, another tab): a copy goes
# to lists\.recovery (ignored by sync), and the user is told where
function Save-Recovery {
  try {
    $dir = Join-Path $listsDir '.recovery'
    if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir) }
    $name = '{0}-{1}.md' -f $script:proj, (Get-Date -Format 'yyyyMMdd-HHmmss')
    Write-TextFileAtomic (Join-Path $dir $name) (ConvertTo-MarkdownText $script:items 0 "`n")
    Show-Toast 'Saqme To Do' "'$($script:proj)' could not be saved. Your changes are in lists\.recovery\$name." $script:proj
  } catch {}
  $script:saveFailed = $false; $script:saveWarned = $false
}

function Save-Items {
  if ($script:listBusy) { return }   # nothing of this list is loaded: never write over it
  if ($script:readOnly) {
    # a view-only shared list: nothing is written, the list is shown as it is on disk (the controls that change
    # things are not there; this catches anything that slips through)
    $script:allowRemove.Clear(); $script:undoExtra = $null
    [void](Use-Loaded (Load-Items)); Render
    Show-Notice "'$($script:proj)' is view-only: only its owner can change it."
    return
  }
  $text = ConvertTo-MarkdownText $script:items 0 $(if ($script:eol) { $script:eol } else { "`n" })
  if (-not (Test-Path -LiteralPath $script:todo)) {
    # the open list was renamed outside the app meanwhile: follow it instead of re-creating the old file
    $ids = @{}; foreach ($it in $script:items) { if ($it.Kind -eq 'task' -and $it.Id) { $ids[$it.Id] = $true } }
    $moved = $(if ($ids.Count) { Find-ListWithIds $listsDir $ids $script:proj } else { $null })
    if ($moved) { $script:proj = $moved; $script:todo = Proj-Path $moved; $script:cfg.active = $moved; Save-Settings }
  }
  $exists = Test-Path -LiteralPath $script:todo
  $disk = $(if ($exists) { Read-TextFile $script:todo } else { $null })
  if ($exists -and $null -eq $disk) { Defer-Save; return }   # another program holds it: never write blind
  $merged = $false
  if ($null -ne $disk -and $null -ne $script:loadedText -and $disk -cne $script:loadedText -and $disk -cne $text) {
    # changed on disk since we loaded it (an editor / AI assistant): replay our edits onto their version
    $text = Merge-ListText $script:loadedText $script:items $disk
    $merged = $true
  }
  # tasks leave a list only by an explicit delete or a move to another list: a save that would lose any other
  # is refused, so a bug can never turn into a delete that sync sends to every device
  $lost = Get-UnexplainedLoss $script:loadedText $disk $script:items $text $script:allowRemove
  if ($lost.Count) { Refuse-Save $lost; return }
  try {
    # only over what was just read and merged: if it changed again meanwhile, merge with that next time
    if (-not (Write-TextFileIfUnchanged $script:todo $text $disk)) { Defer-Save; return }
  } catch {
    Defer-Save $_.Exception.Message
    return
  }
  $script:saveFailed = $false; $script:saveWarned = $false
  if (-not $script:undoing -and $text -cne $disk) {
    # Ctrl+Z puts every file back as it was, as long as nothing else changed it meanwhile (Undo-Last)
    $files = @(@{ Path = $script:todo; Before = $disk; After = $text })
    if ($script:undoExtra) { $files += $script:undoExtra }
    [void]$script:undo.Add(@{ Proj = $script:proj; Files = $files })
    while ($script:undo.Count -gt 30) { $script:undo.RemoveAt(0) }
  }
  # what left the list by a delete here is expected to vanish: the sync never holds it back as lost (Add-LocalDiff)
  if ($script:sync -and $script:sync.Removed) { foreach ($id in $script:allowRemove) { $script:sync.Removed.Enqueue("task:$id") } }
  $script:undoExtra = $null; $script:allowRemove.Clear()
  $script:loadedText = $text
  if ($merged) { $script:items = Read-Items $text }
  try { $script:lastWrite = (Get-Item -LiteralPath $script:todo).LastWriteTimeUtc } catch {}
  Request-Sync
}
$script:saveFailed = $false; $script:saveWarned = $false; $script:saveFailedSince = Get-Date; $script:loadedText = $null; $script:openPopup = $null
$script:listBusy = $false
# ids that may leave the open list with the next save: explicit deletes, moves to another list, undo
$script:allowRemove = New-Object 'System.Collections.Generic.HashSet[string]'
$script:undo = New-Object System.Collections.ArrayList; $script:undoing = $false; $script:undoExtra = $null
$script:refusedSaves = 0

# Save-Items found that a change would make tasks disappear that nobody deleted (a bug, never what was asked
# for): nothing is written, the list is shown as it is on disk, and the user is told.
function Refuse-Save($lost) {
  $script:refusedSaves++
  $names = @((Read-Items $script:loadedText) | Where-Object { $_.Kind -eq 'task' -and $lost -contains $_.Id } | ForEach-Object { "'$($_.Text)'" })
  $script:allowRemove.Clear(); $script:undoExtra = $null
  [void](Use-Loaded (Load-Items)); Render
  $what = $(if ($names.Count -eq 1) { $names[0] } elseif ($names.Count) { "$($names.Count) tasks" } else { 'tasks' })
  Show-Notice "Not saved: that change would have removed $what. The list is as it was."
}
# a menu or popup holds references to task objects: never swap the list under it
function Test-PopupOpen { return ($null -ne $script:openPopup -and $script:openPopup.IsOpen) }
function Request-Sync { if ($script:sync) { [void]$script:sync.Wake.Set() } }

function Subtree-End([int]$i) {
  $L = $script:items[$i].Level; $j = $i + 1
  while ($j -lt $script:items.Count -and $script:items[$j].Kind -eq 'task' -and $script:items[$j].Level -gt $L) { $j++ }
  return $j
}
# An explicit delete (the delete button or menu, a task whose text was erased): the task and its subtasks leave
# the list and are kept in Recently deleted. The only way, besides a move to another list, that Save-Items
# lets tasks go.
function Remove-Subtree($it) {
  $i = $script:items.IndexOf($it); if ($i -lt 0) { return }
  $end = Subtree-End $i
  $block = $script:items.GetRange($i, $end - $i).ToArray()
  $parent = ''
  for ($k = $i - 1; $k -ge 0; $k--) { $p = $script:items[$k]; if ($p.Kind -eq 'task' -and $p.Level -lt $it.Level) { $parent = [string]$p.Id; break } }
  Add-DeletedEntry $block $parent $script:proj
  foreach ($b in $block) { if ($b.Id) { [void]$script:allowRemove.Add([string]$b.Id) } }
  $script:items.RemoveRange($i, $end - $i)
}
function Shift-Level($it, [int]$delta) {
  $i = $script:items.IndexOf($it); if ($i -lt 0) { return }
  if ($delta -gt 0) {
    $p = $i - 1
    if ($p -lt 0 -or $script:items[$p].Kind -ne 'task') { return }
    if ($it.Level -gt $script:items[$p].Level) { return }
  } elseif ($it.Level -eq 0) { return }
  $end = Subtree-End $i
  for ($k = $i; $k -lt $end; $k++) { $script:items[$k].Level += $delta }
}
function Add-Task([string]$text) {
  $pos = $script:items.Count
  for ($k = $script:items.Count - 1; $k -ge 0; $k--) { if ($script:items[$k].Kind -eq 'task') { $pos = $k + 1; break } }
  if ($pos -eq $script:items.Count) {
    while ($pos -gt 0 -and $script:items[$pos - 1].Kind -eq 'raw' -and $script:items[$pos - 1].Raw -match '^\s*$') { $pos-- }
  }
  $script:items.Insert($pos, (New-Task 0 ' ' $text))
  Save-Items; Render
}
function Add-Subtask($parent) {
  Commit-Edit
  if ($script:readOnly) { return }
  $i = $script:items.IndexOf($parent); if ($i -lt 0) { return }
  $end = Subtree-End $i
  $new = New-Task ($parent.Level + 1) ' ' ''
  $script:items.Insert($end, $new)
  $script:openState[(Open-Key $parent)] = '1'; Save-State
  Render
  Edit-Item $new
}

# ---------------------------------------------------------------- dates
# Parse-DueDate, Parse-Due, Due-Label, Get-DueTone, Get-Reminders: rules.ps1 (shared rules, tested with shared/fixtures)

# ---------------------------------------------------------------- UI pieces
function New-Chip($st, [double]$size) {
  $b = New-Object System.Windows.Controls.Border
  $b.Width = $size; $b.Height = $size
  $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.chip)
  $b.BorderThickness = New-Object System.Windows.Thickness(1.5)
  $b.BorderBrush = Brush $st.Edge
  if ($st.Half) {
    $c  = [System.Windows.Media.ColorConverter]::ConvertFromString($st.Chip)
    $tr = [System.Windows.Media.Colors]::Transparent
    $lg = New-Object System.Windows.Media.LinearGradientBrush
    $lg.StartPoint = New-Object System.Windows.Point(0, 0)
    $lg.EndPoint   = New-Object System.Windows.Point(1, 0)
    $lg.GradientStops.Add((New-Object System.Windows.Media.GradientStop($c, 0)))
    $lg.GradientStops.Add((New-Object System.Windows.Media.GradientStop($c, 0.5)))
    $lg.GradientStops.Add((New-Object System.Windows.Media.GradientStop($tr, 0.5)))
    $lg.GradientStops.Add((New-Object System.Windows.Media.GradientStop($tr, 1)))
    $b.Background = $lg
  } else { $b.Background = Brush $st.Chip }
  if ($st.Glyph) {
    $t = New-Object System.Windows.Controls.TextBlock
    $t.Text = $st.Glyph; $t.FontFamily = $MDL2; $t.FontSize = [math]::Round($size * 0.55)
    $t.Foreground = $(if ($st.GlyphInk) { Brush $st.GlyphInk } else { $OnAccent }); $t.HorizontalAlignment = 'Center'; $t.VerticalAlignment = 'Center'
    $b.Child = $t
  }
  return $b
}

function New-IconButton([int]$code, [string]$tip, [scriptblock]$onActivate = $null) {
  $b = New-Control 'button' $tip '' $onActivate
  $t = New-Object System.Windows.Controls.TextBlock
  $t.Text = G $code; $t.FontFamily = $MDL2; $t.FontSize = 10.5; $t.Foreground = $Ink
  $b.Child = $t; $b.Margin = '3,0,0,0'; $b.Padding = '3'; $b.Cursor = 'Hand'; $b.ToolTip = $tip; $b.Background = $Clear
  return $b
}

function Open-Key($it) { if ($it.Id) { return $it.Id } else { return "$($script:proj)`t$($it.Text)" } }
function Is-Open($node) {
  $k = Open-Key $node.Item
  if ($script:openState.ContainsKey($k)) { return ($script:openState[$k] -eq '1') }
  $legacy = "$($script:proj)`t$($node.Item.Text)"
  if ($script:openState.ContainsKey($legacy)) { return ($script:openState[$legacy] -eq '1') }
  return ($node.Kids.Count -gt 0)
}

function New-DuePill($it) {
  $d = [datetime]::ParseExact($it.Due, 'yyyy-MM-dd', $CI)
  $tone = Get-DueTone $it.Due $it.DueTime ((Rank $it.Mark) -eq 2)
  $over = ($tone -eq 'over')
  $label = (Due-Label $d) + $(if ($it.DueTime) { ' ' + $it.DueTime } else { '' })
  $late = $over -and (Rank $it.Mark) -ne 2
  $b = New-Control 'button' ("Deadline: $label" + $(if ($late) { ', overdue' } else { '' })) 'Change the deadline' { param($s, $e) Show-DuePopup $s.Tag $s }
  [System.Windows.Input.KeyboardNavigation]::SetIsTabStop($b, $false)   # in the list, Ctrl+D does this
  $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $b.Padding = '0,1,0,1'; $b.Margin = '10,0,0,0'
  $b.Cursor = 'Hand'; $b.VerticalAlignment = 'Center'; $b.Tag = $it
  $b.ToolTip = 'Deadline: ' + $d.ToString('dddd, d MMMM yyyy', $CI) + $(if ($it.DueTime) { ', ' + $it.DueTime } else { '' })
  $t = New-Object System.Windows.Controls.TextBlock
  $t.Text = (Due-Label $d) + $(if ($it.DueTime) { ' ' + $it.DueTime } else { '' }); $t.FontFamily = $UI; $t.FontSize = $TypeSize.meta
  Set-Tabular $t
  $b.Background = $Clear; $t.Foreground = $Faint
  if ($tone -eq 'over' -or $tone -eq 'soon') {
    $b.Padding = '8,1,8,2'; $t.FontWeight = 'Medium'
    if ($over) { $b.Background = $RedSoft; $t.Foreground = $Red } else { $b.Background = $AmberSoft; $t.Foreground = $Amber }
  }
  $b.Child = $t
  $b.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Show-DuePopup $s.Tag $s })
  return $b
}

function Toggle-RowOpen($chev) {
  Commit-Edit
  $script:openState[(Open-Key $chev.Tag.Item)] = $(if ($chev.Tag.Open) { '0' } else { '1' })
  Save-State; Render
}
# One phrase for a task: what it says, its status, deadline, subtasks (what a screen reader reads for the row)
function Row-Summary($node, $st) {
  $it = $node.Item
  $parts = New-Object System.Collections.ArrayList
  [void]$parts.Add($(if ($it.Text) { $it.Text } else { 'Untitled' })); [void]$parts.Add($st.Name)
  if ($it.Due) {
    try {
      $d = [datetime]::ParseExact($it.Due, 'yyyy-MM-dd', $CI)
      $late = (Get-DueTone $it.Due $it.DueTime ((Rank $it.Mark) -eq 2)) -eq 'over'
      [void]$parts.Add('deadline ' + $d.ToString('dddd d MMMM', $CI) + $(if ($it.DueTime) { ' ' + $it.DueTime } else { '' }) + $(if ($late) { ', overdue' } else { '' }))
    } catch {}
  }
  if ($node.Kids.Count) { $dn = @($node.Kids | Where-Object { (Rank $_.Item.Mark) -eq 2 }).Count; [void]$parts.Add("$dn of $($node.Kids.Count) subtasks closed") }
  if ($it.Notes) { [void]$parts.Add('has notes') }
  return ($parts -join ', ')
}

function New-Row($node) {
  $it = $node.Item; $st = St $it.Mark
  $ro = $script:readOnly   # a view-only shared list: read, never changed (no editing, menus, drag or hover actions)
  $hasKids = $node.Kids.Count -gt 0
  $open = Is-Open $node
  $row = New-Control 'listitem' (Row-Summary $node $st) 'Enter edits, Space marks it done, Ctrl+M for more' { param($s, $e) Set-Sel $s.Tag -Focus }
  if ($script:HasA11y) { $row.IsSelected = ($it -eq $script:sel) }
  [System.Windows.Input.KeyboardNavigation]::SetIsTabStop($row, ($it -eq $script:sel))   # one Tab stop for the list (the selected task)
  $row.Add_GotKeyboardFocus({ param($s, $e) if ($e.NewFocus -eq $s -and $script:sel -ne $s.Tag) { Set-Sel $s.Tag } })
  # a row of the list's card, as wide as the card: a subtask is indented inside it. Its notes, when open, follow
  # right under the text (Render-Node), so the row keeps little room below it then.
  $notesBelow = ($open -or $script:notesEditing -eq $it) -and ($it.Notes -or $script:notesEditing -eq $it)
  $row.Padding = "$($it.Level * $Tokens.Row.indent),9,8,$(if ($notesBelow) { 3 } else { 9 })"; $row.MinHeight = $Tokens.Row.minPointer
  $row.BorderThickness = '2,0,0,0'
  $row.Tag = $it
  Paint-TaskRow $row ($it -eq $script:sel)
  $g = New-Object System.Windows.Controls.Grid
  # columns: 0 grip | 1 chevron | 2 chip | 3 text | 4 deadline, subtask count, notes mark | 5 (spare); the hover
  # actions float over 3-5. (children order: chev, chip, text, meta, acts, grip - other code relies on these indices)
  foreach ($wd in @("$RowGripW", "$RowChevW", 'Auto', '*', 'Auto', 'Auto')) {
    $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $wd; $g.ColumnDefinitions.Add($cd)
  }
  foreach ($ht in @('Auto', 'Auto')) { $rd = New-Object System.Windows.Controls.RowDefinition; $rd.Height = $ht; $g.RowDefinitions.Add($rd) }
  $row.Child = $g
  $row.Add_MouseRightButtonUp({ param($s, $e) $e.Handled = $true; Show-RowMenu $s $s.Tag })

  # chevron (only when there is something to open)
  $chevGlyph = New-Object System.Windows.Controls.TextBlock
  $chevGlyph.FontFamily = $MDL2; $chevGlyph.FontSize = 8; $chevGlyph.Foreground = $Faint; $chevGlyph.TextAlignment = 'Center'
  if ($hasKids -or $it.Notes) {
    $chev = New-Control 'button' $(if ($open) { 'Collapse subtasks and notes' } else { 'Expand subtasks and notes' }) '' { param($s, $e) Toggle-RowOpen $s }
    [System.Windows.Input.KeyboardNavigation]::SetIsTabStop($chev, $false)   # Right / Left on the row
    $chevGlyph.Text = $(if ($open) { G 0xE70D } else { G 0xE76C })
    $chev.Cursor = 'Hand'; $chev.ToolTip = $(if ($open) { 'Collapse' } else { 'Expand' })
    $chev.Tag = @{ Item = $it; Open = $open }
    $chev.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Toggle-RowOpen $s })
    $chev.Child = $chevGlyph
  } else { $chev = New-Object System.Windows.Controls.Border }
  $chev.VerticalAlignment = 'Top'; $chev.Margin = '0,4,0,0'; $chev.Padding = '2,3,2,3'; $chev.Background = $Clear
  [System.Windows.Controls.Grid]::SetColumn($chev, 1); [void]$g.Children.Add($chev)

  # 1: status chip
  $chip = New-Control 'button' "Status: $($st.Name)" 'Change the status' { param($s, $e) Show-StatusMenu $s }
  [System.Windows.Input.KeyboardNavigation]::SetIsTabStop($chip, $false)   # Ctrl+M > Change status on the row
  $chip.Child = (New-Chip $st 17); $chip.Background = $Clear
  $chip.Margin = "0,2,$($Tokens.Row.chipGap),0"; $chip.VerticalAlignment = 'Top'; $chip.Cursor = $(if ($ro) { 'Arrow' } else { 'Hand' })
  $chip.Tag = $it; $chip.ToolTip = $st.Name
  $chip.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Show-StatusMenu $s })
  [System.Windows.Controls.Grid]::SetColumn($chip, 2); [void]$g.Children.Add($chip)

  # 2: text
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $it.Text; $tb.TextWrapping = 'Wrap'; $tb.FontFamily = $UI; $tb.FontSize = $TypeSize.body
  $tb.LineHeight = $Tokens.Type.body.Line; $tb.LineStackingStrategy = 'BlockLineHeight'
  $tb.Foreground = $(if ($st.Strike -and $it -eq $script:sel) { $Faint } else { Brush $st.Text }); $tb.Cursor = $(if ($ro) { 'Arrow' } else { 'IBeam' }); $tb.Tag = $it; $tb.Background = $Clear
  if ($st.Strike) { $tb.TextDecorations = [System.Windows.TextDecorations]::Strikethrough }
  if ($st.Italic) { $tb.FontStyle = 'Italic' }
  $tb.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Begin-Edit $s })
  [System.Windows.Controls.Grid]::SetColumn($tb, 3); [void]$g.Children.Add($tb)

  # 3: on the right of the first line, the row's value: notes mark, subtask progress, deadline (rightmost)
  $meta = New-Object System.Windows.Controls.StackPanel
  $meta.Orientation = 'Horizontal'; $meta.VerticalAlignment = 'Top'; $meta.Height = $Tokens.Type.body.Line
  if ($it.Notes -and -not $open) {
    $n = New-Object System.Windows.Controls.TextBlock
    $n.Text = G 0xE71B; $n.FontFamily = $MDL2; $n.FontSize = 11; $n.Foreground = $Faint; $n.Margin = '10,1,0,0'
    $n.ToolTip = 'Has notes or links'; $n.VerticalAlignment = 'Center'; Set-Name $n 'Has notes or links'
    [void]$meta.Children.Add($n)
  }
  if ($hasKids) {
    $dn = @($node.Kids | Where-Object { (Rank $_.Item.Mark) -eq 2 }).Count
    $p = New-Object System.Windows.Controls.TextBlock
    $p.Text = "$dn/$($node.Kids.Count)"; $p.FontFamily = $UI; $p.FontSize = $TypeSize.meta; $p.Foreground = $Faint; $p.Margin = '10,0,0,0'
    $p.ToolTip = "$dn of $($node.Kids.Count) subtasks closed"; $p.VerticalAlignment = 'Center'
    Set-Name $p "$dn of $($node.Kids.Count) subtasks closed"
    Set-Tabular $p
    [void]$meta.Children.Add($p)
  }
  if ($it.Due) { try { [void]$meta.Children.Add((New-DuePill $it)) } catch {} }
  if ($meta.Children.Count -eq 0) { $meta.Visibility = 'Collapsed' }
  if ($script:metaBelow) {   # (a narrow window: under the text, so the text keeps its line)
    $meta.Margin = '-10,1,0,0'; $meta.Height = [double]::NaN
    [System.Windows.Controls.Grid]::SetColumn($meta, 3); [System.Windows.Controls.Grid]::SetRow($meta, 1)
  } else { [System.Windows.Controls.Grid]::SetColumn($meta, 4) }
  [void]$g.Children.Add($meta)

  # 4: hover actions
  $acts = New-Object System.Windows.Controls.StackPanel
  $acts.Orientation = 'Horizontal'; $acts.Visibility = 'Collapsed'; $acts.Opacity = 0.85; $acts.VerticalAlignment = 'Top'
  $acts.HorizontalAlignment = 'Right'; $acts.Background = $GroupHover; $acts.Margin = '6,1,0,0'
  # (shown on mouse hover; the same actions are in the row menu, Ctrl+M, for keyboards and screen readers)
  $cal = New-IconButton 0xE787 'Deadline' { param($s, $e) Show-DuePopup $s.Tag $s }; $cal.Tag = $it
  $cal.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Show-DuePopup $s.Tag $s })
  $nt = New-IconButton 0xE70B 'Notes / links' { param($s, $e) Begin-Notes $s.Tag }; $nt.Tag = $it
  $nt.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Begin-Notes $s.Tag })
  $add = New-IconButton 0xE710 'Add subtask' { param($s, $e) Add-Subtask $s.Tag }; $add.Tag = $it
  $add.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Add-Subtask $s.Tag })
  $del = New-IconButton 0xE711 'Delete (with subtasks)' { param($s, $e) Delete-Task $s.Tag }; $del.Tag = $it
  $del.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Delete-Task $s.Tag })
  foreach ($x in @($cal, $nt, $add, $del)) { [System.Windows.Input.KeyboardNavigation]::SetIsTabStop($x, $false) }
  if (-not $ro) { foreach ($x in @($cal, $nt, $add, $del)) { [void]$acts.Children.Add($x) } }
  # floats over the end of the row on hover instead of reserving width
  [System.Windows.Controls.Grid]::SetColumn($acts, 3); [System.Windows.Controls.Grid]::SetColumnSpan($acts, 3); [void]$g.Children.Add($acts)

  # six-dot drag handle - only for manually ordered (active) tasks, not auto-sorted ones
  $grip = New-Object System.Windows.Controls.Border
  $grip.Background = $Clear; $grip.VerticalAlignment = 'Top'; $grip.Margin = '0,4,0,0'; $grip.Padding = '3,2,3,2'
  if ($script:renderSection -eq 'active' -and (Node-Rank $it) -eq 0 -and $it.Text -ne '' -and -not $ro) {
    $dots = New-Object System.Windows.Controls.Primitives.UniformGrid
    $dots.Columns = 2; $dots.Rows = 3; $dots.Width = 7; $dots.Height = 11
    for ($k = 0; $k -lt 6; $k++) {
      $el = New-Object System.Windows.Shapes.Ellipse; $el.Width = 2.6; $el.Height = 2.6; $el.Fill = $Faint
      [void]$dots.Children.Add($el)
    }
    $grip.Child = $dots; $grip.Opacity = 0.35; $grip.Cursor = 'SizeAll'; $grip.ToolTip = 'Drag to reorder (Alt+Up / Alt+Down)'
    $grip.Tag = $it
    $grip.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Start-Drag $s })
    $grip.Add_MouseMove({ param($s, $e) if ($script:drag) { Drag-Move $e } })
    $grip.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; End-Drag $true })
    $grip.Add_LostMouseCapture({ param($s, $e) if ($script:drag) { End-Drag $false } })
  }
  [System.Windows.Controls.Grid]::SetColumn($grip, 0); [void]$g.Children.Add($grip)

  # on hover the tools take the place of the value on the right (the deadline is one of the tools too)
  $row.Add_MouseEnter({ param($s, $e)
    Paint-TaskRow $s ($s.Tag -eq $script:sel)
    $s.Child.Children[4].Background = $s.Background; $s.Child.Children[4].Visibility = 'Visible'
    if ($s.Child.Children[4].Children.Count -and [System.Windows.Controls.Grid]::GetColumn($s.Child.Children[3]) -eq 4) { $s.Child.Children[3].Visibility = 'Hidden' }
    if ($s.Child.Children[5].Child) { $s.Child.Children[5].Opacity = 0.9 } })
  $row.Add_MouseLeave({ param($s, $e)
    Paint-TaskRow $s ($s.Tag -eq $script:sel)
    if ($s.Child.Children[3].Visibility -eq 'Hidden') { $s.Child.Children[3].Visibility = 'Visible' }
    $s.Child.Children[4].Visibility = 'Collapsed'; $s.Child.Children[5].Opacity = 0.35 })
  return $row
}
# a task row's colours: the card's, a shade darker under the mouse, violet-tinted with the violet edge when selected.
# (The edge is the row's left border; at rest it has the row's own colour, so the card shows no seam.)
function Paint-TaskRow($row, [bool]$sel) {
  $bg = $(if ($sel) { $GroupSel } elseif ($row.IsMouseOver) { $GroupHover } else { $GroupBg })
  $row.Background = $bg
  $row.BorderBrush = $(if ($sel) { $Accent } else { $bg })
  # closed grey is under 4.5 : 1 on the selection tint (3.9 dark, 4.3 light): a selected closed task is drawn in smoke
  # (the strike-through still says closed), as in the phone app
  if ($row.Child -is [System.Windows.Controls.Grid] -and $row.Child.Children.Count -ge 3 -and $row.Tag -and (St $row.Tag.Mark).Strike) {
    $row.Child.Children[2].Foreground = $(if ($sel) { $Faint } else { Brush (St $row.Tag.Mark).Text })
  }
}

# ---------------------------------------------------------------- drag to reorder
$script:drag = $null
function Is-TaskRow($c) {
  return ($c -is [System.Windows.Controls.Border] -and $c.Child -is [System.Windows.Controls.Grid] -and $c.Child.Children.Count -ge 6)
}
function Start-Drag($grip) {
  Commit-Edit
  # Commit-Edit may have re-rendered; find the live grip for this item
  $it = $grip.Tag
  $live = $null
  foreach ($c in $list.Children) { if ((Is-TaskRow $c) -and $c.Tag -eq $it) { $live = $c; break } }
  if (-not $live) { return }
  # the drop line: 2 px of violet drawn over the hairline where the task would go. It takes no room (negative
  # margins, drawn on top), so the rows and the card stay where they are while dragging.
  $ph = New-Object System.Windows.Controls.Border
  $ph.Height = 2; $ph.Background = $Accent; $ph.Margin = "$RowTextX,-1,8,-1"; $ph.CornerRadius = 1; $ph.Visibility = 'Collapsed'
  $ph.IsHitTestVisible = $false; [System.Windows.Controls.Panel]::SetZIndex($ph, 10)
  [void]$list.Children.Add($ph)
  $live.Child.Opacity = 0.45
  $script:drag = @{ Item = $it; Row = $live; Ph = $ph; Target = $null; End = $false }
  [void]$live.Child.Children[5].CaptureMouse()
}
function Drag-Move($e) {
  $d = $script:drag; if (-not $d) { return }
  $y = $e.GetPosition($list).Y
  [void]$list.Children.Remove($d.Ph)
  $target = $null; $insertAt = -1; $lastActive = -1
  for ($i = 0; $i -lt $list.Children.Count; $i++) {
    $c = $list.Children[$i]
    if (-not (Is-TaskRow $c)) { continue }
    if (-not $c.Child.Children[5].Child) { continue }          # only drop among manually ordered rows
    $lastActive = $i
    $top = $c.TranslatePoint((New-Object System.Windows.Point(0, 0)), $list).Y
    if ($y -lt $top + $c.ActualHeight / 2) { $target = $c.Tag; $insertAt = $i; break }
  }
  if ($insertAt -lt 0) { $insertAt = $lastActive + 1; $d.End = $true } else { $d.End = $false }
  $d.Target = $target
  if ($insertAt -lt 0) { $insertAt = 0 }
  $lvl = $(if ($target) { $target.Level } else { 0 })
  $d.Ph.Margin = "$($RowTextX + $lvl * $Tokens.Row.indent),-1,8,-1"; $d.Ph.Visibility = 'Visible'
  $list.Children.Insert([Math]::Min($insertAt, $list.Children.Count), $d.Ph)
}
function End-Drag([bool]$apply) {
  $d = $script:drag; if (-not $d) { return }
  $script:drag = $null
  try { $d.Row.Child.Children[5].ReleaseMouseCapture() } catch {}
  if ($apply -and $d.Ph.Visibility -eq 'Visible') { Move-Task $d.Item $d.Target $d.End }
  Render
}
# move a task (with subtasks) to sit just before $target, adopting its level; $atEnd -> after the last task.
# A drop that cannot be done (sync-core.ps1 Move-ListBlock) changes nothing.
function Move-Task($it, $target, [bool]$atEnd) {
  if ($script:readOnly) { return }
  if (-not (Move-ListBlock $script:items $it $target $atEnd)) { return }
  $script:sel = $it
  Save-Items
}
# the delete button and menu: the task and its subtasks, to Recently deleted (Remove-Subtree); Undo is offered
function Delete-Task($it) {
  Commit-Edit
  if ($script:readOnly) { return }
  $i = $script:items.IndexOf($it); if ($i -lt 0) { return }
  $n = 0; for ($k = $i; $k -lt (Subtree-End $i); $k++) { if ($script:items[$k].Text) { $n++ } }
  $name = $it.Text
  Remove-Subtree $it; Save-Items; Render
  if ($script:saveFailed) { return }
  Show-Notice ("Deleted '$name'" + $(if ($n -gt 2) { " and its $($n - 1) subtasks" } elseif ($n -eq 2) { ' and its subtask' } else { '' }) + '.') -Undo
}

# Ctrl+Z: puts back the files of the last change to a list (a move, a delete, an edit; a move to another list
# puts back both lists), as long as nothing else has changed them since (sync, an editor, an AI assistant).
function Undo-Last {
  Commit-Edit
  if (-not $script:undo.Count) { Show-Notice 'Nothing to undo.'; return }
  $u = $script:undo[$script:undo.Count - 1]
  $script:undo.RemoveAt($script:undo.Count - 1)
  foreach ($f in $u.Files) {
    $cur = $(if (Test-Path -LiteralPath $f.Path) { Read-TextFile $f.Path } else { $null })
    if ($cur -cne $f.After) { $script:undo.Clear(); Show-Notice 'Could not undo: the list has changed since (sync or another program).'; return }
  }
  if ($u.Proj -ne $script:proj) { Switch-Project $u.Proj }
  $script:view = 'list'
  foreach ($f in $u.Files) { if ($f.Path -ne $script:todo) { try { [void](Write-TextFileIfUnchanged $f.Path ([string]$f.Before) $f.After) } catch {} } }
  $open = @($u.Files | Where-Object { $_.Path -eq $script:todo })
  if ($open.Count -and -not $script:listBusy) {
    $before = Read-Items $open[0].Before
    $keep = Get-TaskIdSet $before
    # tasks the undo takes out of the list (it undoes adding them) go to Recently deleted, like any delete
    for ($k = 0; $k -lt $script:items.Count; $k++) {
      $t = $script:items[$k]
      if ($t.Kind -ne 'task' -or -not $t.Text -or $keep.Contains([string]$t.Id)) { continue }
      $e = Subtree-End $k
      $blk = @($script:items.GetRange($k, $e - $k).ToArray() | Where-Object { -not $keep.Contains([string]$_.Id) })
      $parent = ''; for ($q = $k - 1; $q -ge 0; $q--) { if ($script:items[$q].Kind -eq 'task' -and $script:items[$q].Level -lt $t.Level) { $parent = [string]$script:items[$q].Id; break } }
      Add-DeletedEntry $blk $parent $script:proj
      foreach ($b in $blk) { if ($b.Id) { [void]$script:allowRemove.Add([string]$b.Id) } }
      $k = $e - 1
    }
    $script:items = $before
    $script:undoing = $true
    try { Save-Items } finally { $script:undoing = $false }
  }
  Render
  if (-not $script:saveFailed) { Show-Notice 'Undone.' }
}

# ---------------------------------------------------------------- recently deleted
# Tasks deleted here, and with sync on also those deleted on other devices, can be restored for 30 days. The
# widget's own deletes are kept in recently-deleted.json in the data folder (outside the lists folder: nothing
# syncs or reads it as a list). Restoring writes the lines back with their ids; sync sends them as not deleted.
$deletedFile = Join-Path $DataDir 'recently-deleted.json'
$TrashMs = [long]30 * 86400000
function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Read-DeletedJournal {   # the entries, one by one
  $t = Read-TextFile $deletedFile
  if (-not $t) { return }
  try { $o = ConvertFrom-JsonText $t } catch { return }
  $o | Where-Object { $_ -is [System.Collections.IDictionary] -and $_['text'] }
}
function Save-DeletedJournal($entries) { try { Write-TextFileAtomic $deletedFile (ConvertTo-JsonText @($entries)) } catch {} }
function Add-DeletedEntry($block, [string]$parent, [string]$listName) {
  $tasks = @($block | Where-Object { $_.Kind -eq 'task' -and $_.Text -ne '' })
  if (-not $tasks.Count) { return }
  $now = Get-NowMs
  $keep = @(Read-DeletedJournal | Where-Object { $now - [long]$_['at'] -lt $TrashMs } | Select-Object -Last 199)
  $entry = @{ key = (New-SaqmeId 10); list = $listName; at = $now; parent = $parent; text = (Serialize-Block $tasks); first = [string]$tasks[0].Text
              count = $tasks.Count; ids = @($tasks | ForEach-Object { [string]$_.Id }) }
  Save-DeletedJournal ($keep + ,$entry)
}
# the ids in every list (the open one as it is in memory)
function Get-AllListIds {
  $set = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($n in @(Get-ProjectNames)) {
    $its = $(if ($n -eq $script:proj -and -not $script:listBusy) { $script:items } else { Read-Items (Read-TextFile (Proj-Path $n)) })
    foreach ($id in (Get-TaskIdSet $its)) { [void]$set.Add($id) }
  }
  return ,$set
}
# what can be restored, newest first: @{ Key; List; At (ms); Parent; Text (list lines with ids); First; Count }
function Get-DeletedEntries {
  $now = Get-NowMs
  $present = Get-AllListIds
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  $out = New-Object System.Collections.ArrayList
  foreach ($e in (Read-DeletedJournal)) {
    if ($now - [long]$e['at'] -ge $TrashMs) { continue }
    $ids = @($e['ids'] | ForEach-Object { [string]$_ })
    foreach ($id in $ids) { [void]$seen.Add($id) }
    if (-not @($ids | Where-Object { -not $present.Contains($_) }).Count) { continue }   # all back already
    [void]$out.Add(@{ Key = [string]$e['key']; List = [string]$e['list']; At = [long]$e['at']; Parent = [string]$e['parent']; Text = [string]$e['text']; First = [string]$e['first']; Count = [int]$e['count'] })
  }
  if (Read-SyncConfigUi) { foreach ($t in (Get-SyncTombstones $present $seen $now)) { [void]$out.Add($t) } }
  $out | Sort-Object { $_.At } -Descending
}
# tasks deleted on any device, from the sync state (read only): each with the subtasks deleted along with it
function Get-SyncTombstones($present, $seen, [long]$now) {
  $out = New-Object System.Collections.ArrayList
  try { $st = Read-SyncState (Join-Path $syncDir 'state.json') } catch { return }
  $del = @{}
  foreach ($r in @($st.R.Values)) {
    if ($r['kind'] -ne 'task') { continue }
    $d = Get-Field $r 'deleted'
    if ($d -and $d['v'] -and ($now - [long]$d['ts']) -lt $TrashMs) { $del[[string]$r['id']] = $r }
  }
  $kids = @{}
  foreach ($r in $del.Values) {
    $p = [string](Get-PlaceOf $r)['parent']
    if ($p) { if (-not $kids.ContainsKey($p)) { $kids[$p] = New-Object System.Collections.ArrayList }; [void]$kids[$p].Add($r) }
  }
  foreach ($r in $del.Values) {
    $id = [string]$r['id']; $ts = [long](Get-Field $r 'deleted')['ts']; $p = [string](Get-PlaceOf $r)['parent']
    if ($p -and $del.ContainsKey($p) -and [Math]::Abs([long](Get-Field $del[$p] 'deleted')['ts'] - $ts) -le 5000) { continue }   # went with its parent
    if ($seen.Contains($id) -or $present.Contains($id)) { continue }
    $its = New-Object System.Collections.ArrayList
    Add-TombstoneItems $its $r 0 $kids $ts $present
    $projId = [string](Get-PlaceOf $r)['project']
    $listName = $(if ($st.Files.ContainsKey($projId)) { [string]$st.Files[$projId] } elseif ($st.R.ContainsKey("project:$projId")) { [string](Get-Field $st.R["project:$projId"] 'name')['v'] } else { '' })
    [void]$out.Add(@{ Key = "sync:$id"; List = $listName; At = $ts; Parent = $p; Text = (ConvertTo-MarkdownText $its 0); First = [string]$its[0].Text; Count = $its.Count })
  }
  $out
}
function Add-TombstoneItems($its, $r, [int]$level, $kids, [long]$ts, $present) {
  $due = (Get-Field $r 'due')['v']
  [void]$its.Add([pscustomobject]@{ Kind = 'task'; Level = $level; Mark = [string](Get-Field $r 'status')['v']; MarkRaw = ''; Indent = 2 * $level
    Text = [string](Get-Field $r 'text')['v']; Due = $(if ($due) { [string]$due['date'] } else { '' }); DueTime = $(if ($due) { [string]$due['time'] } else { '' })
    Notes = [string](Get-Field $r 'notes')['v']; Raw = ''; Id = [string]$r['id'] })
  $mine = $kids[[string]$r['id']]
  if (-not $mine) { return }
  foreach ($k in (Sort-Ordinal $mine { param($x) [string](Get-PlaceOf $x)['pos'] })) {
    if ([Math]::Abs([long](Get-Field $k 'deleted')['ts'] - $ts) -gt 5000 -or $present.Contains([string]$k['id'])) { continue }
    Add-TombstoneItems $its $k ($level + 1) $kids $ts $present
  }
}
# puts an entry back into its list (the open one if that list is gone): under its parent when that is still
# there, else at the end. Ids already in some list are skipped, so a restore never duplicates a task.
function Restore-Deleted($en) {
  Commit-Edit
  $names = @(Get-ProjectNames)
  $target = $(if ($en.List -and $names -contains $en.List) { $en.List } else { $script:proj })
  if ($target -ne $script:proj) { Switch-Project $target }
  $script:view = 'list'
  if ($script:listBusy) { Render; Show-Notice "'$target' is busy in another program. Try again in a moment."; return }
  $present = Get-AllListIds
  $block = @((Read-Items $en.Text) | Where-Object { $_.Kind -eq 'task' -and $_.Text -ne '' -and -not $present.Contains([string]$_.Id) })
  if ($block.Count) {
    $pi = -1
    if ($en.Parent) { for ($k = 0; $k -lt $script:items.Count; $k++) { if ($script:items[$k].Kind -eq 'task' -and [string]$script:items[$k].Id -ceq $en.Parent) { $pi = $k; break } } }
    if ($pi -ge 0) { $pos = Subtree-End $pi; $lv = $script:items[$pi].Level + 1 }
    else {
      $pos = $script:items.Count; $lv = 0
      for ($k = $script:items.Count - 1; $k -ge 0; $k--) { if ($script:items[$k].Kind -eq 'task' -and $script:items[$k].Level -eq 0) { $pos = Subtree-End $k; break } }
    }
    foreach ($b in $block) { $b.Level += $lv }
    # with sync: tell it this is a restore, not a stale copy of a list from before a delete on another device
    if ($script:sync) { foreach ($b in $block) { $script:sync.Queue.Enqueue(@{ kind = 'task'; id = [string]$b.Id; field = 'restore' }) } }
    $script:items.InsertRange($pos, [object[]]$block)
    Save-Items
    $script:sel = $block[0]
  }
  if (-not $en.Key.StartsWith('sync:')) { Save-DeletedJournal @(Read-DeletedJournal | Where-Object { [string]$_['key'] -ne $en.Key }) }
  Render
  if ($block.Count) { Show-Notice "Restored '$($en.First)' to $target." -Undo } else { Show-Notice "'$($en.First)' is already back." }
}
function Format-Deleted([long]$ms) {
  $t = [DateTimeOffset]::FromUnixTimeMilliseconds($ms).LocalDateTime
  if ($t.Date -eq (Get-Date).Date) { return 'today ' + $t.ToString('H:mm', $CI) }
  if ($t.Date -eq (Get-Date).Date.AddDays(-1)) { return 'yesterday ' + $t.ToString('H:mm', $CI) }
  return $t.ToString('d MMM H:mm', $CI)
}
# one card per list, newest first; a row is the task (with its subtasks), when it was deleted, and Restore
function Render-TrashView {
  [void]$list.Children.Add((New-SettingsHeader 'Recently deleted'))
  $entries = @(Get-DeletedEntries)
  $about = 'Deleted tasks stay here for 30 days' + $(if (Read-SyncConfigUi) { ', also those deleted on your other devices' } else { '' }) + '. Right after a change, Ctrl+Z undoes it.'
  if (-not $entries.Count) { Add-Note 'Nothing deleted in the last 30 days.' $Ink; Add-Note $about; return }
  $lists = New-Object System.Collections.ArrayList
  foreach ($en in $entries) { if (-not $lists.Contains($en.List)) { [void]$lists.Add($en.List) } }
  foreach ($ln in $lists) {
    Add-Heading $(if ($ln) { $ln } else { 'Other lists' })
    foreach ($en in @($entries | Where-Object { $_.List -eq $ln })) {
      $more = $(if ($en.Count -eq 2) { ', with its subtask' } elseif ($en.Count -gt 2) { ", with $($en.Count - 1) subtasks" } else { '' })
      $when = Format-Deleted $en.At
      $b = New-TextButton 'Restore' { param($x) Restore-Deleted $x } $Accent $en
      Set-Name $b "Restore $($en.First)" ("From $(if ($en.List) { $en.List } else { 'a list that is gone' }), deleted $when$more")
      $label = $en.First + $(if ($en.Count -gt 1) { " (+$($en.Count - 1))" } else { '' })
      Add-CardRow (New-InfoRow $label $when $b -Tip "$($en.First)$more. Deleted $when$(if ($en.List) { " from $($en.List)" })")
    }
  }
  Add-Footnote $about
}

# Alt+Up / Alt+Down: swap with the previous / next sibling
function Nudge-Task($it, [int]$dir) {
  if ($script:readOnly) { return }
  if (-not (Step-ListBlock $script:items $it $dir)) { return }
  $script:sel = $it; Save-Items; Render
}

# ---------------------------------------------------------------- row menu (right-click / Ctrl+M) + move to list
function Show-RowMenu($target, $it) {
  Commit-Edit
  $script:sel = $it
  if ($script:readOnly) { return }   # a view-only shared list: nothing to change
  $m = New-Menu
  $e0 = New-MenuItem 'Change status...'; $e0.Tag = $target
  $e0.Add_Click({ param($s, $e) if (Is-TaskRow $s.Tag) { Show-StatusMenu $s.Tag.Child.Children[1] } })
  [void]$m.Items.Add($e0)
  $e1 = New-MenuItem 'Edit'; $e1.Tag = $it; $e1.Add_Click({ param($s, $e) Edit-Item $s.Tag })
  $e2 = New-MenuItem 'Deadline...'; $e2.Tag = @{ It = $it; T = $target }; $e2.Add_Click({ param($s, $e) Show-DuePopup $s.Tag.It $s.Tag.T })
  $e3 = New-MenuItem 'Notes / links'; $e3.Tag = $it; $e3.Add_Click({ param($s, $e) Begin-Notes $s.Tag })
  $e4 = New-MenuItem 'Add subtask'; $e4.Tag = $it; $e4.Add_Click({ param($s, $e) Add-Subtask $s.Tag })
  foreach ($x in @($e1, $e2, $e3, $e4)) { [void]$m.Items.Add($x) }
  # (not into a view-only shared list; into or out of an editable one it is a copy there and a delete here, which
  # each list's sync sends to its own server)
  $others = @(Get-ProjectNames | Where-Object { $_ -ne $script:proj } | Where-Object { $sb = Get-ShareOf $_; -not ($sb -and [string]$sb['access'] -ne 'edit') })
  if ($others.Count) {
    [void]$m.Items.Add((New-Separator))
    $mv = New-MenuItem 'Move to list...'; $mv.Tag = @{ It = $it; T = $target; Others = $others }
    $mv.Add_Click({ param($s, $e) Show-MoveMenu $s.Tag.T $s.Tag.It $s.Tag.Others })
    [void]$m.Items.Add($mv)
  }
  [void]$m.Items.Add((New-Separator))
  $del = New-MenuItem 'Delete'; $del.Tag = $it; $del.Add_Click({ param($s, $e) Delete-Task $s.Tag })
  [void]$m.Items.Add($del)
  $m.PlacementTarget = $target; $m.Placement = 'MousePoint'
  if ($target -ne $null -and -not $target.IsMouseOver) { $m.Placement = 'Bottom' }
  $m.IsOpen = $true
  $script:openPopup = $m
}
function Show-MoveMenu($target, $it, $lists) {
  $m = New-Menu
  foreach ($p in $lists) {
    $mi = New-MenuItem $p; $mi.Tag = @{ It = $it; P = $p }
    $mi.Add_Click({ param($s, $e) Move-ToProject $s.Tag.It $s.Tag.P })
    [void]$m.Items.Add($mi)
  }
  $m.PlacementTarget = $target; $m.Placement = 'Bottom'; $m.IsOpen = $true
  $script:openPopup = $m
}
function Serialize-Block($block, [string]$eol = "`n") { return (ConvertTo-MarkdownText $block $block[0].Level $eol) }   # ids move along
function Move-ToProject($it, [string]$proj) {
  Commit-Edit
  $i = $script:items.IndexOf($it); if ($i -lt 0) { return }
  $end = Subtree-End $i
  $block = $script:items.GetRange($i, $end - $i).ToArray()
  $dest = Proj-Path $proj
  try {
    $before = $(if (Test-Path -LiteralPath $dest) { [IO.File]::ReadAllText($dest, [Text.Encoding]::UTF8) } else { '' })
    $existing = $before
    $eol = Get-TextEol $existing
    $text = Serialize-Block $block $eol
    if ($existing -and -not $existing.EndsWith("`n")) { $existing += $eol }
    Write-TextFileAtomic $dest ($existing + $text)
  } catch { return }
  $script:undoExtra = @{ Path = $dest; Before = $before; After = $existing + $text }
  foreach ($b in $block) { if ($b.Id) { [void]$script:allowRemove.Add([string]$b.Id) } }
  $script:items.RemoveRange($i, $end - $i)
  $script:sel = $null
  Save-Items; Render
}

function Show-StatusMenu($chip) {
  Commit-Edit
  if ($script:readOnly) { return }
  $it = $chip.Tag
  $m = New-Menu
  foreach ($st in $script:Statuses) {
    $sp = New-Object System.Windows.Controls.StackPanel; $sp.Orientation = 'Horizontal'
    $c = New-Chip $st 14; $c.Margin = '0,0,10,0'
    $tx = New-Object System.Windows.Controls.TextBlock; $tx.Text = $st.Name; $tx.VerticalAlignment = 'Center'
    if ($st.Mark -eq $it.Mark) { $tx.FontWeight = 'SemiBold' }
    [void]$sp.Children.Add($c); [void]$sp.Children.Add($tx)
    $mi = New-MenuItem $sp
    Set-Name $mi ($st.Name + $(if ($st.Mark -eq $it.Mark) { ' (current)' } else { '' }))
    $mi.Tag = @{ Item = $it; Mark = $st.Mark }
    $mi.Add_Click({ param($s, $e) $s.Tag.Item.Mark = $s.Tag.Mark; Save-Items; Render })
    [void]$m.Items.Add($mi)
  }
  $m.PlacementTarget = $chip; $m.Placement = 'Bottom'; $m.IsOpen = $true
  $script:openPopup = $m
}

# ---------------------------------------------------------------- deadline popup
function New-PopupItem([string]$text, [string]$hint, [scriptblock]$onActivate = $null) {
  $b = New-Control 'button' $(if ($hint) { "$text, $hint" } else { $text }) '' $onActivate
  $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $b.Padding = '12,8,12,8'; $b.Cursor = 'Hand'; $b.Background = $Clear
  $g = New-Object System.Windows.Controls.Grid
  foreach ($wd in @('*', 'Auto')) { $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $wd; $g.ColumnDefinitions.Add($cd) }
  $a = New-Object System.Windows.Controls.TextBlock; $a.Text = $text; $a.FontFamily = $UI; $a.FontSize = $TypeSize.label; $a.Foreground = $Ink
  $h = New-Object System.Windows.Controls.TextBlock; $h.Text = $hint; $h.FontFamily = $UI; $h.FontSize = $TypeSize.meta; $h.Foreground = $Faint
  Set-Tabular $h
  [System.Windows.Controls.Grid]::SetColumn($h, 1)
  [void]$g.Children.Add($a); [void]$g.Children.Add($h)
  $b.Child = $g
  $b.Add_MouseEnter({ param($s, $e) $s.Background = $MenuHover })
  $b.Add_MouseLeave({ param($s, $e) $s.Background = $Clear })
  return $b
}

function Show-DuePopup($it, $target) {
  Commit-Edit
  if ($script:readOnly) { return }
  $p = New-Object System.Windows.Controls.Primitives.Popup
  $p.AllowsTransparency = $true; $p.StaysOpen = $false; $p.PlacementTarget = $target; $p.Placement = 'Bottom'
  $b = New-Object System.Windows.Controls.Border
  $b.Background = $MenuBg; $b.BorderBrush = $Edge; $b.BorderThickness = '1'; $b.CornerRadius = 10; $b.Padding = '4'; $b.Margin = '0,0,10,10'
  $b.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect -Property @{ BlurRadius = 14; ShadowDepth = 3; Opacity = 0.3 }
  $sp = New-Object System.Windows.Controls.StackPanel; $sp.Width = 250
  $today = (Get-Date).Date
  $nextMon = $today.AddDays(1); while ($nextMon.DayOfWeek -ne 'Monday') { $nextMon = $nextMon.AddDays(1) }
  $opts = @(@('Today', $today), @('Tomorrow', $today.AddDays(1)), @('Next Monday', $nextMon), @('In a week', $today.AddDays(7)))
  foreach ($o in $opts) {
    $row = New-PopupItem $o[0] ($o[1].ToString('ddd d MMM', $CI)) { param($s, $e) $s.Tag.Item.Due = $s.Tag.Date.ToString('yyyy-MM-dd'); $s.Tag.Popup.IsOpen = $false; Save-Items; Render }
    $row.Tag = @{ Item = $it; Date = $o[1]; Popup = $p }
    $row.Add_MouseLeftButtonUp({ param($s, $e)
      $s.Tag.Item.Due = $s.Tag.Date.ToString('yyyy-MM-dd'); $s.Tag.Popup.IsOpen = $false; Save-Items; Render })
    [void]$sp.Children.Add($row)
  }
  # free-form date entry
  $tg = New-Object System.Windows.Controls.Grid; $tg.Margin = '6,4,6,4'
  $box = New-Object System.Windows.Controls.TextBox
  Set-Name $box 'Deadline' 'Type a date: fri 14:00, 25 oct, +3, 9:30. Enter saves'
  $box.FontFamily = $UI; $box.FontSize = $TypeSize.label; $box.Background = $Clear; $box.Foreground = $Ink; $box.CaretBrush = $Accent
  $box.BorderThickness = '0,0,0,1.5'; $box.BorderBrush = $Line; $box.Padding = '4,4,4,4'
  $hint = New-Object System.Windows.Controls.TextBlock
  $hint.Text = 'Type: fri 14:00, 25 oct, +3, 9:30'; $hint.FontFamily = $UI; $hint.FontSize = $TypeSize.meta; $hint.Foreground = $Faint
  $hint.Margin = '5,3,0,0'; $hint.IsHitTestVisible = $false
  $box.Tag = @{ Item = $it; Popup = $p; Hint = $hint }
  $box.Add_TextChanged({ param($s, $e) $s.Tag.Hint.Visibility = $(if ($s.Text) { 'Collapsed' } else { 'Visible' }); $s.BorderBrush = $Line })
  $box.Add_PreviewKeyDown({ param($s, $e)
    if ($e.Key -eq 'Return') {
      $e.Handled = $true
      $d = Parse-Due $s.Text
      if ($d) { $s.Tag.Item.Due = $d.Date.ToString('yyyy-MM-dd'); $s.Tag.Item.DueTime = $d.Time; $s.Tag.Popup.IsOpen = $false; Save-Items; Render }
      else { $s.BorderBrush = $Red }
    } elseif ($e.Key -eq 'Escape') { $e.Handled = $true; $s.Tag.Popup.IsOpen = $false } })
  [void]$tg.Children.Add($box); [void]$tg.Children.Add((Hide-Decoration $hint))
  [void]$sp.Children.Add($tg)
  if ($it.Due) {
    $sep = New-Object System.Windows.Controls.Border; $sep.Height = 1; $sep.Background = $Line; $sep.Margin = '8,4'
    [void]$sp.Children.Add($sep)
    $clr = New-PopupItem 'Remove deadline' '' { param($s, $e) $s.Tag.Item.Due = ''; $s.Tag.Item.DueTime = ''; $s.Tag.Popup.IsOpen = $false; Save-Items; Render }
    $clr.Tag = @{ Item = $it; Popup = $p }
    $clr.Add_MouseLeftButtonUp({ param($s, $e) $s.Tag.Item.Due = ''; $s.Tag.Item.DueTime = ''; $s.Tag.Popup.IsOpen = $false; Save-Items; Render })
    [void]$sp.Children.Add($clr)
  }
  $b.Child = $sp; $p.Child = $b
  $p.IsOpen = $true
  $script:openPopup = $p
  [void]$box.Focus()
}

# ---------------------------------------------------------------- notes / links
$script:notesEditing = $null; $script:notesBox = $null

# a task's notes when it is open: quiet text in the task's card, right under the task's text (no box of its own)
function New-Notes($it) {
  $wrap = New-Object System.Windows.Controls.Border
  $wrap.Background = $GroupBg; $wrap.Padding = "$($it.Level * $Tokens.Row.indent + $RowTextX),0,12,10"
  if ($script:notesEditing -eq $it) {
    $gr = New-Object System.Windows.Controls.Grid
    $box = New-Object System.Windows.Controls.TextBox
    Set-Name $box 'Notes and links' 'Ctrl+Enter saves, Esc cancels'
    $box.Text = $it.Notes; $box.Tag = $it; $box.AcceptsReturn = $true; $box.TextWrapping = 'Wrap'
    $box.FontFamily = $UI; $box.FontSize = $TypeSize.meta; $box.Background = $Clear; $box.Foreground = $Ink
    $box.BorderThickness = '0,0,0,1.5'; $box.BorderBrush = $Accent; $box.CaretBrush = $Accent; $box.MinHeight = 20; $box.Padding = '0,0,0,2'
    $hint = New-Object System.Windows.Controls.TextBlock
    $hint.Text = 'Links, notes, context (Ctrl+Enter saves)'; $hint.FontFamily = $UI; $hint.FontSize = $TypeSize.meta
    $hint.Foreground = $Faint; $hint.IsHitTestVisible = $false; $hint.Margin = '2,0,0,0'
    if ($it.Notes) { $hint.Visibility = 'Collapsed' }
    $box.Add_TextChanged({ param($s, $e) $s.Parent.Children[1].Visibility = $(if ($s.Text) { 'Collapsed' } else { 'Visible' }) })
    $box.Add_PreviewKeyDown({ param($s, $e)
      $ctrl = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control) -ne 0
      if ($e.Key -eq 'Escape') { $e.Handled = $true; Commit-Notes -Cancel }
      elseif ($e.Key -eq 'Return' -and $ctrl) { $e.Handled = $true; Commit-Notes } })
    $box.Add_LostKeyboardFocus({ param($s, $e) if ($script:notesBox -eq $s) { Commit-Notes } })
    [void]$gr.Children.Add($box); [void]$gr.Children.Add((Hide-Decoration $hint))
    $wrap.Child = $gr
    $script:notesBox = $box
  } else {
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.TextWrapping = 'Wrap'; $tb.FontFamily = $UI; $tb.FontSize = $TypeSize.meta; $tb.Foreground = $NoteInk
    $tb.LineHeight = 20; $tb.LineStackingStrategy = 'BlockLineHeight'
    $tb.Cursor = 'IBeam'; $tb.Tag = $it; $tb.Background = $Clear
    $lines = $it.Notes.Split("`n")
    for ($li = 0; $li -lt $lines.Count; $li++) {
      $pos = 0
      foreach ($m in [regex]::Matches($lines[$li], '(https?://[^\s<>"]+|www\.[^\s<>"]+)')) {
        if ($m.Index -gt $pos) { $tb.Inlines.Add((New-Object System.Windows.Documents.Run($lines[$li].Substring($pos, $m.Index - $pos)))) }
        $url = $m.Value; if ($url -notmatch '^https?://') { $url = 'https://' + $url }
        $hl = New-Object System.Windows.Documents.Hyperlink((New-Object System.Windows.Documents.Run($m.Value)))
        $hl.Foreground = $Accent; $hl.Cursor = 'Hand'; $hl.Tag = $url; $hl.ToolTip = $url
        $hl.Add_Click({ param($s, $e) try { Start-Process $s.Tag } catch {} })
        $tb.Inlines.Add($hl)
        $pos = $m.Index + $m.Length
      }
      if ($pos -lt $lines[$li].Length) { $tb.Inlines.Add((New-Object System.Windows.Documents.Run($lines[$li].Substring($pos)))) }
      if ($li -lt $lines.Count - 1) { $tb.Inlines.Add((New-Object System.Windows.Documents.LineBreak)) }
    }
    $tb.Add_MouseLeftButtonUp({ param($s, $e)
      $src = $e.OriginalSource
      while ($src -is [System.Windows.Documents.TextElement]) {
        if ($src -is [System.Windows.Documents.Hyperlink]) { return }
        $src = $src.Parent
      }
      $e.Handled = $true; Begin-Notes $s.Tag })
    $wrap.Child = $tb
  }
  return $wrap
}

function Begin-Notes($it) {
  Commit-Edit
  if ($script:readOnly) { return }
  $script:openState[(Open-Key $it)] = '1'; Save-State
  $script:notesEditing = $it
  Render
  if ($script:notesBox) {
    [void]$w.Activate(); [void]$script:notesBox.Focus(); $script:notesBox.CaretIndex = $script:notesBox.Text.Length
  }
}

function Commit-Notes([switch]$Cancel) {
  if (-not $script:notesBox) { return }
  $box = $script:notesBox; $it = $script:notesEditing
  $script:notesBox = $null; $script:notesEditing = $null
  if (-not $Cancel) { $it.Notes = ($box.Text -replace "`r", '').Trim(); Save-Items }
  Render
}

# ---------------------------------------------------------------- task editing
$script:editItem = $null; $script:editBox = $null; $script:tabEditing = $false
$script:sel = $null; $script:visible = New-Object System.Collections.ArrayList
$script:rows = New-Object System.Collections.ArrayList; $script:tabRow = $null   # the task rows Render made (Set-Sel)

function Begin-Edit($tb) {
  Commit-Edit
  if ($script:readOnly) { return }
  $it = $tb.Tag; $grid = $tb.Parent
  if (-not $grid) { return }
  $box = New-Object System.Windows.Controls.TextBox
  Set-Name $box 'Task text' 'Enter saves and adds a task below, Shift+Enter a subtask, Esc cancels'
  $box.Text = $it.Text; $box.Tag = $it; $box.FontFamily = $UI; $box.FontSize = $TypeSize.body
  $box.TextWrapping = 'Wrap'; $box.Background = $Clear; $box.Foreground = $Ink
  $box.BorderThickness = '0,0,0,1.5'; $box.BorderBrush = $Accent; $box.Padding = '0'; $box.CaretBrush = $Accent
  [System.Windows.Controls.Grid]::SetColumn($box, 3)
  $grid.Children.Remove($tb); $grid.Children.Insert(2, $box)
  $script:editItem = $it; $script:editBox = $box; $script:sel = $it
  $box.Add_PreviewKeyDown({ param($s, $e) Edit-Key $s $e })
  $box.Add_LostKeyboardFocus({ param($s, $e) if ($script:editBox -eq $s) { Commit-Edit } })
  [void]$w.Activate()
  [void]$box.Focus(); $box.CaretIndex = $box.Text.Length
}

function Edit-Item($it) {
  foreach ($row in $list.Children) {
    if ($row -is [System.Windows.Controls.Border] -and $row.Child -is [System.Windows.Controls.Grid] -and
        $row.Child.Children.Count -ge 3 -and $row.Child.Children[2].Tag -eq $it) {
      Begin-Edit $row.Child.Children[2]; return
    }
  }
}

function Rekey-State([string]$oldText, [string]$newText) {
  if ($oldText -eq $newText) { return }
  $k = "$($script:proj)`t$oldText"
  if ($script:openState.ContainsKey($k)) {
    $script:openState["$($script:proj)`t$newText"] = $script:openState[$k]; $script:openState.Remove($k); Save-State
  }
}

function Edit-Key($box, $e) {
  $it = $script:editItem
  $shift = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Shift) -ne 0
  if ($e.Key -eq 'Return') {
    $e.Handled = $true
    $text = $box.Text.Trim()
    if ($text -eq '') { Commit-Edit; return }
    $script:editItem = $null; $script:editBox = $null
    Rekey-State $it.Text $text
    $it.Text = $text
    $i = $script:items.IndexOf($it)
    if ($shift) {
      $pos = $i + 1; $lvl = $it.Level + 1
      $script:openState[(Open-Key $it)] = '1'; Save-State
    } else { $pos = Subtree-End $i; $lvl = $it.Level }
    $new = New-Task $lvl ' ' ''
    $script:items.Insert($pos, $new)
    Save-Items
    Render
    Edit-Item $new
  }
  elseif ($e.Key -eq 'Up' -or $e.Key -eq 'Down') {
    # outliner-style: arrows move the editor to the previous / next visible task
    $e.Handled = $true
    $vis = $script:visible; $i = $vis.IndexOf($it)
    $j = $(if ($e.Key -eq 'Up') { $i - 1 } else { $i + 1 })
    $target = $null; if ($i -ge 0 -and $j -ge 0 -and $j -lt $vis.Count) { $target = $vis[$j] }
    Commit-Edit
    if ($target -and $script:items.IndexOf($target) -ge 0) { $script:sel = $target; Edit-Item $target }
    elseif ($e.Key -eq 'Down') { [void]$addBox.Focus() }
  }
  elseif ($e.Key -eq 'Escape') { $e.Handled = $true; Commit-Edit -Cancel; [void]$w.Focus() }
  elseif ($e.Key -eq 'Tab') {
    $e.Handled = $true
    $text = $box.Text.Trim()
    $script:editItem = $null; $script:editBox = $null
    Rekey-State $it.Text $text
    $it.Text = $text
    if ($shift) { Shift-Level $it -1 } else { Shift-Level $it 1 }
    if ($text -ne '') { Save-Items }
    Render
    Edit-Item $it
  }
}

function Commit-Edit([switch]$Cancel) {
  Commit-Notes
  $it = $script:editItem; if (-not $it) { return }
  $box = $script:editBox
  $script:editItem = $null; $script:editBox = $null
  if ($Cancel) {
    if ($it.Text -eq '') { Remove-Subtree $it }
  } else {
    $t = $box.Text.Trim()
    $erased = $(if ($t -eq '' -and $it.Text -ne '') { $it.Text } else { '' })
    if ($t -eq '') { Remove-Subtree $it } else { Rekey-State $it.Text $t; $it.Text = $t }
    Save-Items
  }
  Render
  if ($erased -and -not $script:saveFailed) { Show-Notice "Deleted '$erased'." -Undo }
  if (-not [System.Windows.Input.Keyboard]::FocusedElement) { [void]$w.Focus() }
}

# ---------------------------------------------------------------- tabs
function Switch-Project([string]$name) {
  Commit-Edit
  if ($script:saveFailed) { Save-Items }
  if ($script:saveFailed) { Save-Recovery }   # leaving a list whose edits still cannot be written
  $script:proj = $name
  $script:todo = Proj-Path $name
  Update-ReadOnly
  if (-not (Test-Path -LiteralPath $script:todo) -and -not (Get-ShareOf $name)) { Write-Utf8 $script:todo '' }   # (a shared list's file comes from its sync)
  $script:listBusy = $false
  [void](Use-Loaded (Load-Items))
  $script:cfg.active = $name; Save-Settings
  Render
}

# ---------------------------------------------------------------- the list switcher (docs/design.md, "The list switcher")
# The title at the top is the current list's name with a small chevron: one menu button that opens the lists menu
# (a popup under it: a row per list, then New list). A list's own menu (the old tab menu) is the right-click menu
# of a row, or of the title for the current list.
$script:listNames = @(); $script:listInfo = @{}; $script:titleBtn = $null; $script:titleChev = $null
$script:listsPopup = $null; $script:listsClosedAt = [datetime]::MinValue; $script:listsRefocus = $false
$script:listsRows = New-Object System.Collections.ArrayList

# open tasks of a list, how many of them are due today or earlier, and how many of those are overdue
function Get-ListInfo([string]$name) {
  $r = @{ Open = 0; Due = 0; Over = 0 }
  $now = Get-Date
  foreach ($l in (Read-Lines (Proj-Path $name))) {
    if ($l -notmatch '^\s*[-*]\s+\[[ /!]\]\s*\S') { continue }
    $r.Open++
    if ($l -match '(?i)\sdue:(\d{4}-\d{2}-\d{2})(?:T(\d{1,2}:\d{2}))?(?=\s|$)') {
      try {
        $d = [datetime]::ParseExact($matches[1], 'yyyy-MM-dd', $CI)
        if ((Get-DueTone $matches[1] $matches[2] $false $now) -eq 'over') { $r.Over++; $r.Due++ }
        elseif (($d - $now.Date).Days -le 0) { $r.Due++ }
      } catch {}
    }
  }
  return $r
}

# the little badge of a shared list (people; an eye for a list that is view-only here); its Tag says what it means
function New-ShareBadge([string]$name, $ink) {
  $share = Get-ShareOf $name
  if (-not $share -and -not (Test-SharedByMe $name)) { return $null }
  $bd = New-Object System.Windows.Controls.TextBlock
  $bd.Text = $(if ($share -and [string]$share['access'] -ne 'edit') { G 0xE7B3 } else { G 0xE716 }); $bd.FontFamily = $MDL2; $bd.FontSize = 10.5
  $bd.Foreground = $ink; $bd.VerticalAlignment = 'Center'
  $what = $(if ($share) { "Shared with you from $(Get-ShareHost $share): $($script:AccessText[[string]$share['access']][0].ToLower())" } else { 'Shared with others' })
  $bd.ToolTip = $what; $bd.Tag = $what
  return $bd
}

function New-TitleButton {
  $name = [string]$script:proj
  $open = [bool]($script:listsPopup -and $script:listsPopup.IsOpen)
  $other = @($script:listNames | Where-Object { $_ -ne $name -and $script:listInfo[$_] -and $script:listInfo[$_].Due -gt 0 })
  $b = New-Control 'disclosure' $name 'Shows your lists' { param($s, $e) Toggle-ListsMenu }
  if ($script:HasA11y) { $b.IsExpanded = $open }
  $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $b.Padding = '8,4,8,4'; $b.Cursor = 'Hand'; $b.Background = $Clear
  $dp = New-Object System.Windows.Controls.DockPanel
  # (docked to the right, so the first one added is the rightmost: the violet dot, then the chevron, then the badge;
  # the phone reads name, badge, chevron, dot)
  $tip = $name; $help = 'Shows your lists'
  if ($other.Count) {
    $dot = New-Object System.Windows.Shapes.Ellipse; $dot.Width = 7; $dot.Height = 7; $dot.Fill = $Accent; $dot.VerticalAlignment = 'Center'; $dot.Margin = '8,2,0,0'
    [System.Windows.Controls.DockPanel]::SetDock($dot, 'Right'); [void]$dp.Children.Add($dot)
    $tip += "`nDue today or earlier in: " + ($other -join ', '); $help = 'Shows your lists. Something is due in ' + ($other -join ', ')
  }
  $chev = New-Object System.Windows.Controls.TextBlock
  $chev.Text = G 0xE70D; $chev.FontFamily = $MDL2; $chev.FontSize = 9; $chev.Foreground = $TabInk; $chev.VerticalAlignment = 'Center'; $chev.Margin = '8,2,0,0'
  $chev.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
  $chev.RenderTransform = New-Object System.Windows.Media.RotateTransform($(if ($open) { 180 } else { 0 }))
  [System.Windows.Controls.DockPanel]::SetDock($chev, 'Right'); [void]$dp.Children.Add($chev)
  $script:titleChev = $chev
  $label = $name
  $bd = New-ShareBadge $name $Faint
  if ($bd) { $bd.Margin = '8,2,0,0'; [System.Windows.Controls.DockPanel]::SetDock($bd, 'Right'); [void]$dp.Children.Add($bd); $label += ', ' + ([string]$bd.Tag).Split(':')[0].ToLower() }
  $t = New-Object System.Windows.Controls.TextBlock
  $t.Text = $name; $t.FontFamily = $UI; $t.FontSize = $TypeSize.title; $t.FontWeight = 'SemiBold'; $t.Foreground = $Ink
  $t.TextTrimming = 'CharacterEllipsis'; $t.TextWrapping = 'NoWrap'; $t.VerticalAlignment = 'Center'
  [void]$dp.Children.Add($t)
  $b.Child = $dp; $b.ToolTip = $tip; Set-Name $b $label $help
  $b.Add_MouseEnter({ param($s, $e) $s.Background = $TabHover })
  $b.Add_MouseLeave({ param($s, $e) $s.Background = $Clear })
  $b.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Toggle-ListsMenu })
  $b.ContextMenu = New-ListContextMenu $name
  return $b
}

# a list moved one place up or down (the same order file the old tab drag wrote); the lists menu then opens again
function Move-List([string]$name, [int]$by) {
  $names = @(Get-ProjectNames)
  $i = [array]::IndexOf($names, $name); $j = $i + $by
  if ($i -lt 0 -or $j -lt 0 -or $j -ge $names.Count) { return }
  $names[$i], $names[$j] = $names[$j], $names[$i]
  Save-Order $names
  Render-Tabs
  if (-not $SmokeTest) { [void]$w.Dispatcher.BeginInvoke([Action]{ Show-ListsMenu }, [System.Windows.Threading.DispatcherPriority]::Background) }
}
function New-MoveItems([string]$name) {
  $names = @(Get-ProjectNames); $i = [array]::IndexOf($names, $name); $out = @()
  if ($i -gt 0) { $u = New-MenuItem 'Move up'; $u.Tag = $name; $u.Add_Click({ param($s, $e) Move-List $s.Tag -1 }); $out += $u }
  if ($i -ge 0 -and $i -lt $names.Count - 1) { $d = New-MenuItem 'Move down'; $d.Tag = $name; $d.Add_Click({ param($s, $e) Move-List $s.Tag 1 }); $out += $d }
  return $out
}

# a list's own menu: share, rename, move up / down, delete; for a list shared with you, where it comes from, moving
# and leaving it
function New-ListContextMenu([string]$name) {
  $share = Get-ShareOf $name
  $m = New-Menu
  if ($share) {
    # someone else's list: its name and its deletion are theirs; leaving takes it off this PC only
    $info = New-MenuItem "Shared from $(Get-ShareHost $share) - $($script:AccessText[[string]$share['access']][0].ToLower())"; $info.IsEnabled = $false
    $mi1 = New-MenuItem 'Rename'; $mi1.IsEnabled = $false; $mi1.ToolTip = 'Only its owner can rename it'
    [System.Windows.Controls.ToolTipService]::SetShowOnDisabled($mi1, $true)
    $mi2 = New-MenuItem 'Leave this list'; $mi2.Tag = $name
    $mi2.Add_Click({ param($s, $e) Leave-SharedList $s.Tag })
    foreach ($x in @($info, (New-Separator), $mi1) + @(New-MoveItems $name) + @($mi2)) { [void]$m.Items.Add($x) }
  } else {
    $mi0 = New-MenuItem 'Share...'; $mi0.Tag = $name
    $mi0.Add_Click({ param($s, $e) Show-Share $s.Tag })
    if (-not $script:ownSync) { $mi0.IsEnabled = $false; $mi0.ToolTip = $script:ShareNeedsSync; [System.Windows.Controls.ToolTipService]::SetShowOnDisabled($mi0, $true) }
    $mi1 = New-MenuItem 'Rename'; $mi1.Tag = $name
    $mi1.Add_Click({ param($s, $e) Begin-TabEdit $s.Tag })
    $mi2 = New-MenuItem 'Delete list'; $mi2.Tag = $name
    $mi2.Add_Click({ param($s, $e) Delete-Project $s.Tag })
    foreach ($x in @($mi0, $mi1) + @(New-MoveItems $name) + @($mi2)) { [void]$m.Items.Add($x) }
  }
  return $m
}
function Show-ListMenu([string]$name, [bool]$below) {
  $m = New-ListContextMenu $name
  $m.PlacementTarget = $script:titleBtn; $m.Placement = $(if ($below) { 'Bottom' } else { 'MousePoint' })
  $m.IsOpen = $true
  $script:openPopup = $m
}

# the title after the menu closed (by a key or a choice at once, by a click outside when its Closed event comes)
function Reset-ListsTitle {
  $script:listsClosedAt = [datetime]::UtcNow
  if ($script:titleBtn) { if ($script:HasA11y) { $script:titleBtn.IsExpanded = $false }; if ($script:titleChev) { $script:titleChev.RenderTransform = New-Object System.Windows.Media.RotateTransform(0) } }
  if ($script:listsRefocus) { $script:listsRefocus = $false; if ($script:titleBtn) { [void]$script:titleBtn.Focus() } }
}
function Close-ListsMenu([bool]$refocus) {
  $script:listsRefocus = $refocus
  if ($script:listsPopup) { $script:listsPopup.IsOpen = $false }
  Reset-ListsTitle
}
function Toggle-ListsMenu {
  if ($script:listsPopup -and $script:listsPopup.IsOpen) { Close-ListsMenu $true; return }
  if (([datetime]::UtcNow - $script:listsClosedAt).TotalMilliseconds -lt 250) { return }   # the click that just closed it
  Show-ListsMenu
}
function Choose-List([string]$name) {
  Close-ListsMenu $true
  if ($name -ne $script:proj) { Switch-Project $name }
}

function New-ListRow([string]$name) {
  $cur = ($name -eq $script:proj)
  $info = $script:listInfo[$name]
  $label = $name
  $b = New-Control 'radio' $name '' { param($s, $e) Choose-List ([string]$s.Tag) }
  if ($script:HasA11y) { $b.IsSelected = $cur }
  $b.Tag = $name; $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $b.Padding = '10,9,12,9'; $b.Cursor = 'Hand'; $b.Background = $Clear
  $g = New-Object System.Windows.Controls.Grid
  foreach ($wd in @('22', '*', 'Auto', 'Auto')) { $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $wd; $g.ColumnDefinitions.Add($cd) }
  if ($cur) {
    $ck = New-Object System.Windows.Controls.TextBlock; $ck.Text = G 0xE73E; $ck.FontFamily = $MDL2; $ck.FontSize = 11; $ck.Foreground = $Accent
    $ck.VerticalAlignment = 'Top'; $ck.Margin = '0,4,0,0'
    [void]$g.Children.Add($ck)
  }
  $t = New-Object System.Windows.Controls.TextBlock
  $t.Text = $name; $t.FontFamily = $UI; $t.FontSize = $TypeSize.label; $t.Foreground = $Ink; $t.TextWrapping = 'Wrap'
  if ($cur) { $t.FontWeight = 'SemiBold' }
  [System.Windows.Controls.Grid]::SetColumn($t, 1); [void]$g.Children.Add($t)
  $bd = New-ShareBadge $name $Faint
  if ($bd) {
    $bd.Margin = '8,4,0,0'; $bd.VerticalAlignment = 'Top'; [System.Windows.Controls.Grid]::SetColumn($bd, 2); [void]$g.Children.Add($bd)
    $label += ', ' + ([string]$bd.Tag).Split(':')[0].ToLower()
  }
  $v = $null
  if ($info.Due -gt 0) {
    $v = "$($info.Due) due"; $ink = $(if ($info.Over -gt 0) { $Red } else { $Amber })
    $label += ", $($info.Due) due" + $(if ($info.Over -gt 0) { ", $($info.Over) overdue" })
  } elseif ($info.Open -gt 0) { $v = "$($info.Open)"; $ink = $Faint; $label += ", $($info.Open) open" }
  if ($v) {
    $vt = New-Object System.Windows.Controls.TextBlock
    $vt.Text = $v; $vt.FontFamily = $UI; $vt.FontSize = $TypeSize.meta; $vt.Foreground = $ink; $vt.Margin = '12,2,0,0'; $vt.VerticalAlignment = 'Top'; Set-Tabular $vt
    [System.Windows.Controls.Grid]::SetColumn($vt, 3); [void]$g.Children.Add($vt)
  }
  $b.Child = $g; Set-Name $b $label
  $b.Add_MouseEnter({ param($s, $e) $s.Background = $MenuHover })
  $b.Add_MouseLeave({ param($s, $e) $s.Background = $Clear })
  $b.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Choose-List ([string]$s.Tag) })
  $b.Add_MouseRightButtonUp({ param($s, $e) $e.Handled = $true; $n = [string]$s.Tag; Close-ListsMenu $false; Show-ListMenu $n $false })
  return $b
}

function Show-ListsMenu {
  Commit-Edit
  if ($script:tabEditing) { return }
  $script:listNames = @(Get-ProjectNames)
  foreach ($n in $script:listNames) { $script:listInfo[$n] = Get-ListInfo $n }   # (fresh: the dot may be a minute old)
  $p = New-Object System.Windows.Controls.Primitives.Popup
  $p.AllowsTransparency = $true; $p.StaysOpen = $false; $p.PlacementTarget = $script:titleBtn; $p.Placement = 'Bottom'
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = $MenuBg; $outer.BorderBrush = $Edge; $outer.BorderThickness = '1'; $outer.CornerRadius = 10; $outer.Padding = '4'; $outer.Margin = '0,0,10,10'
  $outer.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect -Property @{ BlurRadius = 14; ShadowDepth = 3; Opacity = 0.3 }
  $col = New-Object System.Windows.Controls.StackPanel
  $col.Width = [math]::Min(320, [math]::Max(200, $w.ActualWidth - 50))
  $script:listsRows.Clear()
  $sp = New-Object System.Windows.Controls.StackPanel
  $first = $true
  foreach ($n in $script:listNames) {
    if (-not $first) {
      $hl = New-Object System.Windows.Controls.Border; $hl.Height = 1; $hl.Background = $GroupLine; $hl.Margin = '32,0,8,0'; [void]$sp.Children.Add($hl)
    }
    $first = $false
    $row = New-ListRow $n
    [void]$script:listsRows.Add($row); [void]$sp.Children.Add($row)
  }
  $sv = New-Object System.Windows.Controls.ScrollViewer
  $sv.VerticalScrollBarVisibility = 'Auto'; $sv.HorizontalScrollBarVisibility = 'Disabled'; $sv.Focusable = $false
  $sv.MaxHeight = [math]::Max(120, $w.ActualHeight - 150); $sv.Content = $sp
  $card = New-Object System.Windows.Controls.Border
  $card.Background = $GroupBg; $card.CornerRadius = New-Object System.Windows.CornerRadius($CardRadius); $card.Padding = '2'; $card.Child = $sv
  [void]$col.Children.Add($card)
  # New list: a card of its own after a small gap, in the accent colour
  $nb = New-Control 'button' 'New list' '' { param($s, $e) Close-ListsMenu $false; Begin-TabEdit $null }
  $nb.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $nb.Padding = '10,9,12,9'; $nb.Cursor = 'Hand'; $nb.Background = $Clear
  $ng = New-Object System.Windows.Controls.StackPanel; $ng.Orientation = 'Horizontal'
  $np = New-Object System.Windows.Controls.TextBlock; $np.Text = G 0xE710; $np.FontFamily = $MDL2; $np.FontSize = 11; $np.Foreground = $Accent; $np.Width = 22; $np.VerticalAlignment = 'Center'
  $nt = New-Object System.Windows.Controls.TextBlock; $nt.Text = 'New list'; $nt.FontFamily = $UI; $nt.FontSize = $TypeSize.label; $nt.FontWeight = 'Medium'; $nt.Foreground = $Accent; $nt.VerticalAlignment = 'Center'
  [void]$ng.Children.Add($np); [void]$ng.Children.Add($nt); $nb.Child = $ng
  $nb.Add_MouseEnter({ param($s, $e) $s.Background = $MenuHover })
  $nb.Add_MouseLeave({ param($s, $e) $s.Background = $Clear })
  $nb.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Close-ListsMenu $false; Begin-TabEdit $null })
  $nc = New-Object System.Windows.Controls.Border
  $nc.Background = $GroupBg; $nc.CornerRadius = New-Object System.Windows.CornerRadius($CardRadius); $nc.Padding = '2'; $nc.Margin = '0,8,0,0'; $nc.Child = $nb
  [void]$col.Children.Add($nc)
  [void]$script:listsRows.Add($nb)
  $outer.Child = $col
  $outer.Add_PreviewKeyDown({ param($s, $e)
    $k = "$($(if ($e.Key -eq 'System') { $e.SystemKey } else { $e.Key }))"
    $shift = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Shift) -ne 0
    $rows = $script:listsRows; $f = [System.Windows.Input.Keyboard]::FocusedElement; $i = $rows.IndexOf($f)
    if ($k -eq 'Down') { $e.Handled = $true; [void]$rows[($i + 1) % $rows.Count].Focus() }
    elseif ($k -eq 'Up') { $e.Handled = $true; [void]$rows[$(if ($i -le 0) { $rows.Count - 1 } else { $i - 1 })].Focus() }
    elseif ($k -eq 'Home') { $e.Handled = $true; [void]$rows[0].Focus() }
    elseif ($k -eq 'End') { $e.Handled = $true; [void]$rows[$rows.Count - 1].Focus() }
    elseif ($k -eq 'Escape' -or $k -eq 'Tab') { $e.Handled = $true; Close-ListsMenu $true }
    elseif (($k -eq 'Apps' -or ($k -eq 'F10' -and $shift)) -and $i -ge 0 -and $f.Tag) { $e.Handled = $true; $n = [string]$f.Tag; Close-ListsMenu $false; Show-ListMenu $n $true }
  })
  $p.Child = $outer
  $p.Add_Closed({ param($s, $e) Reset-ListsTitle })
  $script:listsPopup = $p
  $script:listsRefocus = $false
  if ($script:HasA11y) { $script:titleBtn.IsExpanded = $true }
  $script:titleChev.RenderTransform = New-Object System.Windows.Media.RotateTransform(180)
  $p.IsOpen = $true
  $script:openPopup = $p
  $cur = $null; foreach ($r in $script:listsRows) { if ($r.Tag -eq $script:proj) { $cur = $r } }
  if (-not $cur) { $cur = $script:listsRows[0] }
  [void]$cur.Focus()
}

function Render-Tabs {
  if ($script:tabEditing) { return }
  if ($script:listsPopup -and $script:listsPopup.IsOpen) { return }   # (the timer comes back for it when the menu is closed)
  Update-Bindings
  $script:ownSync = [bool](Read-SyncConfigUi)   # (sharing needs this PC's own sync)
  foreach ($n in @($script:leaving.Keys)) { if (-not (Test-Path -LiteralPath (Proj-Path $n))) { $script:leaving.Remove($n) } }
  $hadFocus = $titleHost.IsKeyboardFocusWithin
  $script:listNames = @(Get-ProjectNames)
  $script:listInfo = @{}
  foreach ($n in $script:listNames) { $script:listInfo[$n] = Get-ListInfo $n }
  $script:titleBtn = New-TitleButton
  $titleHost.Child = $script:titleBtn
  if ($hadFocus) { [void]$script:titleBtn.Focus() }   # keyboard users keep their place
  $script:tabSig = Tab-Signature
}
function Cycle-Project([int]$dir) {
  $names = @(Get-ProjectNames); if ($names.Count -lt 2) { return }
  $i = [array]::IndexOf($names, $script:proj)
  Switch-Project $names[(($i + $dir) % $names.Count + $names.Count) % $names.Count]
}

function Begin-TabEdit($name) {   # a list's name (rename), or $null for a new list
  Commit-Edit
  if ($script:tabEditing) { return }
  if ($name -and (Get-ShareOf ([string]$name))) { Show-Notice 'Only its owner can rename a shared list.'; return }
  $script:tabEditing = $true
  $box = New-Object System.Windows.Controls.TextBox
  Set-Name $box $(if ($name) { 'List name' } else { 'New list name' }) 'Enter saves, Esc cancels'
  $box.FontFamily = $UI; $box.FontSize = $TypeSize.label; $box.MinWidth = 160; $box.Padding = '4,3,4,3'
  $box.VerticalAlignment = 'Center'; $box.Background = $StripBg; $box.Foreground = $Ink
  $box.BorderThickness = '0,0,0,1.5'; $box.BorderBrush = $Accent; $box.CaretBrush = $Accent
  $old = [string]$name; $box.Text = $old; $box.Tag = $old
  $hint = New-Object System.Windows.Controls.TextBlock
  $hint.Text = 'New list'; $hint.FontFamily = $UI; $hint.FontSize = $TypeSize.label; $hint.Foreground = $Faint; $hint.IsHitTestVisible = $false
  $hint.VerticalAlignment = 'Center'; $hint.Margin = '5,0,0,0'; $hint.Visibility = $(if ($old) { 'Collapsed' } else { 'Visible' })
  $script:tabHint = $hint
  $box.Add_TextChanged({ param($s, $e) $script:tabHint.Visibility = $(if ($s.Text) { 'Collapsed' } else { 'Visible' }) })
  $g = New-Object System.Windows.Controls.Grid
  [void]$g.Children.Add($box); [void]$g.Children.Add((Hide-Decoration $hint))
  $titleHost.Child = $g
  $box.Add_PreviewKeyDown({ param($s, $e)
    if ($e.Key -eq 'Return') { $e.Handled = $true; Finish-TabEdit $s $true }
    elseif ($e.Key -eq 'Escape') { $e.Handled = $true; Finish-TabEdit $s $false } })
  $box.Add_LostKeyboardFocus({ param($s, $e) Finish-TabEdit $s $true })
  [void]$w.Activate(); [void]$box.Focus(); $box.SelectAll()
}

function Finish-TabEdit($box, [bool]$apply) {
  if (-not $script:tabEditing) { return }
  $script:tabEditing = $false
  $old = [string]$box.Tag
  $new = ConvertTo-ProjectName $box.Text   # the same rule as the phone app's (sync-core.ps1)
  if ($apply -and $new -and $new -cne $old) {
    $names = @(Get-ProjectNames)
    if (-not @($names | Where-Object { $_ -eq $new -and $_ -cne $old }).Count) {
      try {
        if ($old) {
          if ($new -eq $old) {   # only the letter case changes: go through a temporary name
            $mid = (Proj-Path $old) + '.renaming'
            [IO.File]::Move((Proj-Path $old), $mid); [IO.File]::Move($mid, (Proj-Path $new))
          } else { Rename-Item -LiteralPath (Proj-Path $old) -NewName "$new.md" -ErrorAction Stop }
          Save-Order @($names | ForEach-Object { if ($_ -eq $old) { $new } else { $_ } })
        } else {
          Write-Utf8 (Proj-Path $new) ''
          Save-Order (@($names) + $new)
        }
      } catch { Render-Tabs; return }
    }
    Switch-Project $new
    return
  }
  Render-Tabs
}

function Delete-Project([string]$name) {
  Commit-Edit
  if (Get-ShareOf $name) { Leave-SharedList $name; return }   # someone else's list: leave it instead
  $names = @(Get-ProjectNames)
  if ($names.Count -le 1) { return }
  $r = [System.Windows.MessageBox]::Show($w, "Delete list '$name'?`nIt is moved to lists\.trash, not erased.", 'Saqme To Do', 'YesNo', 'Warning')
  if ("$r" -ne 'Yes') { return }
  $trash = Join-Path $listsDir '.trash'
  if (-not (Test-Path -LiteralPath $trash)) { [void](New-Item -ItemType Directory -Path $trash) }
  try {
    Move-Item -LiteralPath (Proj-Path $name) -Destination (Join-Path $trash ("{0}-{1}.md" -f $name, (Get-Date -Format 'yyyyMMdd-HHmmss'))) -ErrorAction Stop
  } catch { return }
  $names = @($names | Where-Object { $_ -ne $name })
  Save-Order $names
  if ($script:proj -eq $name) { Switch-Project $names[0] } else { Render-Tabs }
}

# ---------------------------------------------------------------- window
$w = New-Object System.Windows.Window
$w.WindowStyle = 'None'; $w.AllowsTransparency = $true; $w.Background = $Clear
$w.Topmost = $false; $w.ShowInTaskbar = $true; $w.ResizeMode = 'CanResize'
$w.Width = 420; $w.MinWidth = 300; $w.MinHeight = 160; $w.Title = 'Saqme To Do'
foreach ($k in $script:Styles.Keys) { $w.Resources[$k] = $script:Styles[$k] }   # tooltips + scrollbar pick these up
$wa = [System.Windows.SystemParameters]::WorkArea
$w.MaxHeight = $wa.Height + 14

$chrome = New-Object System.Windows.Shell.WindowChrome
$chrome.CaptionHeight = 42
$chrome.ResizeBorderThickness = New-Object System.Windows.Thickness(7)
$chrome.GlassFrameThickness = New-Object System.Windows.Thickness(0)
$chrome.CornerRadius = New-Object System.Windows.CornerRadius(0)
$chrome.UseAeroCaptionButtons = $false
[System.Windows.Shell.WindowChrome]::SetWindowChrome($w, $chrome)

if ($script:cfg.width -match '^\d+$')  { $w.Width = [double]$script:cfg.width }
$w.SizeToContent = 'Manual'   # fixed height: the task list scrolls, the add-task footer stays put
$w.Height = $(if ($script:cfg.height -match '^\d+$') { [double]$script:cfg.height } else { 520 })

$logoBmp = $null
if (Test-Path -LiteralPath $logoFile) {
  try {
    $logoBmp = New-Object System.Windows.Media.Imaging.BitmapImage
    $logoBmp.BeginInit(); $logoBmp.UriSource = New-Object System.Uri($logoFile); $logoBmp.DecodePixelHeight = 96
    $logoBmp.CacheOption = 'OnLoad'; $logoBmp.EndInit(); $logoBmp.Freeze()
    $ico = New-Object System.Windows.Media.Imaging.BitmapImage
    $ico.BeginInit(); $ico.UriSource = New-Object System.Uri($iconFile); $ico.DecodePixelHeight = 64
    $ico.CacheOption = 'OnLoad'; $ico.EndInit(); $ico.Freeze(); $w.Icon = $ico
  } catch { $logoBmp = $null }
}

$outer = New-Object System.Windows.Controls.Border
$outer.Background = $Card; $outer.BorderBrush = $Edge; $outer.BorderThickness = '1'
$outer.CornerRadius = $Tokens.Radius.container; $outer.Margin = '7'
$outer.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect -Property @{ BlurRadius = 14; ShadowDepth = 2; Opacity = 0.35 }
$dock = New-Object System.Windows.Controls.DockPanel
$outer.Child = $dock; $w.Content = $outer

# tab strip (drag empty space to move the widget)
$strip = New-Object System.Windows.Controls.Border
$strip.Background = $StripBg; $strip.CornerRadius = New-Object System.Windows.CornerRadius(($Tokens.Radius.container - 1), ($Tokens.Radius.container - 1), 0, 0); $strip.Padding = '8,8,6,0'
$strip.BorderBrush = $Line; $strip.BorderThickness = '0,0,0,1'
$stripGrid = New-Object System.Windows.Controls.Grid
foreach ($wd in @('Auto', '*', 'Auto', 'Auto', 'Auto', 'Auto', 'Auto')) { $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $wd; $stripGrid.ColumnDefinitions.Add($cd) }
if ($logoBmp) {
  $logoImg = New-Object System.Windows.Controls.Image
  $logoImg.Source = $logoBmp; $logoImg.Height = 21
  [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($logoImg, 'HighQuality')
  $logo = New-Control 'button' 'Settings' 'Ctrl+comma' { param($s, $e) Toggle-Settings }
  $logo.Child = $logoImg; $logo.Background = $Clear; $logo.Margin = '3,0,9,6'; $logo.VerticalAlignment = 'Center'
  $logo.ToolTip = 'Settings'; $logo.Cursor = 'Hand'
  [System.Windows.Shell.WindowChrome]::SetIsHitTestVisibleInChrome($logo, $true)
  $logo.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Toggle-Settings })
  [void]$stripGrid.Children.Add($logo)
}
# the title: the current list's name, which opens the lists menu (Render-Tabs fills it); it takes the room the
# buttons on its right leave, and a long name ends in an ellipsis
$titleHost = New-Object System.Windows.Controls.Border
$titleHost.VerticalAlignment = 'Center'; $titleHost.HorizontalAlignment = 'Left'; $titleHost.Margin = '0,0,4,6'
[System.Windows.Shell.WindowChrome]::SetIsHitTestVisibleInChrome($titleHost, $true)
[System.Windows.Controls.Grid]::SetColumn($titleHost, 1); [void]$stripGrid.Children.Add($titleHost)
$countText = New-Object System.Windows.Controls.TextBlock
$countText.FontFamily = $UI; $countText.FontSize = $TypeSize.small; $countText.Foreground = $Faint; Set-Tabular $countText
$countText.VerticalAlignment = 'Center'; $countText.Margin = '6,0,4,5'
$countText.Visibility = 'Collapsed'   # per-tab counts already show open tasks
[System.Windows.Controls.Grid]::SetColumn($countText, 2)   # (not shown: the tabs show open counts)

# sync status (hidden while sync is off) and a badge when edits on two devices collided
$syncBox = New-Object System.Windows.Controls.StackPanel
$syncBox.Orientation = 'Horizontal'; $syncBox.VerticalAlignment = 'Center'; $syncBox.Margin = '4,0,2,5'
$conflictBadge = New-Control 'button' 'Conflicts' 'Changed on two devices at once - choose which version to keep' { param($s, $e) Show-View 'conflicts' }
$conflictBadge.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $conflictBadge.Padding = '8,2,8,3'; $conflictBadge.Cursor = 'Hand'
$conflictBadge.Background = $AmberSoft; $conflictBadge.Visibility = 'Collapsed'; $conflictBadge.Margin = '0,0,3,0'; $conflictBadge.VerticalAlignment = 'Center'
$conflictBadge.ToolTip = 'Changed on two devices at once - click to choose'
$cbText = New-Object System.Windows.Controls.TextBlock; $cbText.FontFamily = $UI; $cbText.FontSize = $TypeSize.small; $cbText.FontWeight = 'Medium'; $cbText.Foreground = $Amber
$conflictBadge.Child = $cbText
$conflictBadge.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Show-View 'conflicts' })
# the cloud glyph is a button whose name says the sync state in words (the glyph and its colour are extra)
$syncButton = New-Control 'button' 'Sync' 'Opens Settings, Sync & sharing' { param($s, $e) Request-Sync; Show-View 'sync' }
$syncGlyph = New-Object System.Windows.Controls.TextBlock
$syncGlyph.FontFamily = $MDL2; $syncGlyph.FontSize = 13
$syncButton.Child = $syncGlyph; $syncButton.Padding = '5,4,5,3'; $syncButton.Cursor = 'Hand'
$syncButton.Background = $Clear; $syncButton.Visibility = 'Collapsed'; $syncButton.VerticalAlignment = 'Center'
$syncButton.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Request-Sync; Show-View 'sync' })
foreach ($x in @($conflictBadge, $syncButton)) { [System.Windows.Shell.WindowChrome]::SetIsHitTestVisibleInChrome($x, $true); [void]$syncBox.Children.Add($x) }
[System.Windows.Controls.Grid]::SetColumn($syncBox, 2); [void]$stripGrid.Children.Add($syncBox)

function New-WinButton([int]$code, [string]$tip, [bool]$danger, [scriptblock]$onActivate) {
  $b = New-Control 'button' $tip '' $onActivate
  $b.Width = 28; $b.Height = 26; $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control)
  $b.Background = $Clear; $b.Cursor = 'Hand'; $b.ToolTip = $tip; $b.Margin = '1,0,0,5'; $b.VerticalAlignment = 'Center'
  $b.Tag = $danger
  [System.Windows.Shell.WindowChrome]::SetIsHitTestVisibleInChrome($b, $true)
  $t = New-Object System.Windows.Controls.TextBlock
  $t.Text = G $code; $t.FontFamily = $MDL2; $t.FontSize = 9.5; $t.Foreground = $TabInk
  $t.HorizontalAlignment = 'Center'; $t.VerticalAlignment = 'Center'
  $b.Child = $t
  $b.Add_MouseEnter({ param($s, $e) if ($s.Tag) { $s.Background = $CloseHover; $s.Child.Foreground = $CloseGlyph } else { $s.Background = $TabHover } })
  $b.Add_MouseLeave({ param($s, $e) $s.Background = $Clear; $s.Child.Foreground = $TabInk })
  return $b
}
$menuBtn = New-WinButton 0xE712 'Options' $false { param($s, $e) Show-AppMenu $s }
$minBtn  = New-WinButton 0xE921 'Minimize' $false { param($s, $e) Commit-Edit; $w.WindowState = 'Minimized' }
$maxBtn  = New-WinButton 0xE922 'Fullscreen' $false { param($s, $e) Commit-Edit; Toggle-Max }
$clsBtn  = New-WinButton 0xE8BB 'Close (keeps running in the tray)' $true { param($s, $e) Commit-Edit; $w.Close() }
$col = 3
foreach ($x in @($menuBtn, $minBtn, $maxBtn, $clsBtn)) { [System.Windows.Controls.Grid]::SetColumn($x, $col); [void]$stripGrid.Children.Add($x); $col++ }
$strip.Child = $stripGrid
[System.Windows.Controls.DockPanel]::SetDock($strip, 'Top'); [void]$dock.Children.Add($strip)

$strip.Add_MouseLeftButtonDown({
  param($s, $e)
  Commit-Edit
  if ($e.ClickCount -ge 2) { Toggle-Max; return }
  if ($script:maxed) { return }
  try { $w.DragMove() } catch {}
  try { Set-Content -Path $posFile -Value ("{0},{1}" -f [int]$w.Left, [int]$w.Top) } catch {}
})

$script:maxed = $false
function Toggle-Max {
  if (-not $script:maxed) {
    $script:restore = @{ L = $w.Left; T = $w.Top; W = $w.ActualWidth; H = $w.ActualHeight; S = $w.SizeToContent }
    $w.SizeToContent = 'Manual'
    $w.Left = $wa.Left - 7; $w.Top = $wa.Top - 7; $w.Width = $wa.Width + 14; $w.Height = $wa.Height + 14
    $script:maxed = $true; $maxBtn.Child.Text = G 0xE923; $maxBtn.ToolTip = 'Restore'
  } else {
    $r = $script:restore
    $w.Left = $r.L; $w.Top = $r.T; $w.Width = $r.W
    if ($r.S -eq 'Height') { $w.SizeToContent = 'Height' } else { $w.Height = $r.H }
    $script:maxed = $false; $maxBtn.Child.Text = G 0xE922; $maxBtn.ToolTip = 'Fullscreen'
  }
}
# double-clicking the title bar maximizes natively; route that to our own fullscreen toggle
$w.Add_StateChanged({ if ($w.WindowState -eq 'Maximized') { $w.WindowState = 'Normal'; if (-not $script:maxed) { Toggle-Max } } })
$script:posDirty = $false
$w.Add_LocationChanged({ $script:posDirty = $true })
$minBtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Commit-Edit; $w.WindowState = 'Minimized' })
$maxBtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Commit-Edit; Toggle-Max })
$clsBtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Commit-Edit; $w.Close() })

function Restart-Widget {
  Commit-Edit
  if ($script:mutexHeld) { $mutex.ReleaseMutex(); $script:mutexHeld = $false }
  Start-Process wscript.exe -ArgumentList "`"$Launcher`""
  Quit-App
}

$menuBtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; Show-AppMenu $s })
function Show-AppMenu($s) {
  Commit-Edit
  $m = New-Menu
  $open = New-MenuItem 'Open this list in Notepad'
  $open.Add_Click({ Start-Process notepad.exe -ArgumentList "`"$($script:todo)`"" })
  $folder = New-MenuItem 'Open lists folder'
  $folder.Add_Click({ Start-Process explorer.exe -ArgumentList "`"$listsDir`"" })
  $fit = New-MenuItem 'Fit height to content'
  $fit.Add_Click({ if ($script:maxed) { Toggle-Max }; $w.SizeToContent = 'Height'; $w.UpdateLayout(); $fh = [math]::Min($w.ActualHeight, $wa.Height * 0.85); $w.SizeToContent = 'Manual'; $w.Height = $fh; $script:sizeDirty = $true })
  $theme = New-MenuItem 'Settings'
  $theme.Add_Click({ Toggle-Settings })
  $test = New-MenuItem 'Send a test notification'
  $test.Add_Click({ Show-Toast 'Saqme To Do' 'Notifications are working.' $script:proj })
  $reload = New-MenuItem 'Reload'
  $reload.Add_Click({ [void](Use-Loaded (Load-Items)); Render })
  $trashItem = New-MenuItem 'Recently deleted'
  $trashItem.Add_Click({ Show-View 'trash' })
  foreach ($x in @($theme, $trashItem, $open, $folder, $fit, $test, $reload)) { [void]$m.Items.Add($x) }
  if ($script:sync) {
    $sn = New-MenuItem 'Sync now'
    $sn.Add_Click({ Request-Sync })
    [void]$m.Items.Insert(1, $sn)
  }
  $m.PlacementTarget = $s; $m.Placement = 'Bottom'; $m.IsOpen = $true
}

# add-task line: a card of its own at the bottom, drawn like one more row of the list ("+" in the chip column)
$addGrid = New-Object System.Windows.Controls.Grid
$addBorder = New-Object System.Windows.Controls.Border
$addBorder.Background = $GroupBg; $addBorder.CornerRadius = New-Object System.Windows.CornerRadius($CardRadius)
$addBorder.Padding = '0,10,8,10'; $addBorder.Margin = "$CardInset,8,$CardInset,$CardInset"
$addBox = New-Object System.Windows.Controls.TextBox
Set-Name $addBox 'Add a task' 'Enter adds it at the end of the list'
$addBox.FontFamily = $UI; $addBox.FontSize = $TypeSize.body; $addBox.Background = $Clear; $addBox.Foreground = $Ink
$addBox.BorderThickness = '0'; $addBox.Padding = "$($RowTextX - 2),0,0,0"; $addBox.CaretBrush = $Accent
$ph = New-Object System.Windows.Controls.TextBlock
$ph.Text = (G 0xE710); $ph.FontFamily = $MDL2; $ph.FontSize = 11; $ph.Foreground = $Accent
$ph.IsHitTestVisible = $false; $ph.VerticalAlignment = 'Center'; $ph.Margin = "$(2 + $RowChipX + 3),0,0,0"
$phText = New-Object System.Windows.Controls.TextBlock
$phText.Text = 'Add a task'; $phText.FontFamily = $UI; $phText.FontSize = $TypeSize.body; $phText.Foreground = $Faint
$phText.IsHitTestVisible = $false; $phText.VerticalAlignment = 'Center'; $phText.Margin = "$RowTextX,0,0,0"
[void]$addGrid.Children.Add($addBox); [void]$addGrid.Children.Add((Hide-Decoration $ph)); [void]$addGrid.Children.Add((Hide-Decoration $phText))
$addBorder.Child = $addGrid
[System.Windows.Controls.DockPanel]::SetDock($addBorder, 'Bottom'); [void]$dock.Children.Add($addBorder)
# the Settings views' bottom line, where the add-task line is in the list: the version (Update-VersionDisplay)
$verBar = New-Object System.Windows.Controls.Border
$verBar.Margin = "$CardInset,2,$CardInset,10"; $verBar.Visibility = 'Collapsed'
[System.Windows.Controls.DockPanel]::SetDock($verBar, 'Bottom'); [void]$dock.Children.Add($verBar)

# a short message above the add line ("Deleted ...  Undo", "Not saved ..."); it goes away by itself
$notice = New-Object System.Windows.Controls.Border
$notice.Margin = "$CardInset,8,$CardInset,0"; $notice.Padding = "$CardPad,8,8,8"; $notice.Visibility = 'Collapsed'
$notice.CornerRadius = New-Object System.Windows.CornerRadius($CardRadius)
$noticeGrid = New-Object System.Windows.Controls.Grid
foreach ($wd in @('*', 'Auto')) { $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $wd; $noticeGrid.ColumnDefinitions.Add($cd) }
$noticeText = New-Object System.Windows.Controls.TextBlock
$noticeText.FontFamily = $UI; $noticeText.FontSize = $TypeSize.meta; $noticeText.TextWrapping = 'Wrap'; $noticeText.VerticalAlignment = 'Center'
try { [System.Windows.Automation.AutomationProperties]::SetLiveSetting($noticeText, 'Polite') } catch {}   # read out (.NET 4.7.1+)
[void]$noticeGrid.Children.Add($noticeText)
$notice.Child = $noticeGrid
[System.Windows.Controls.DockPanel]::SetDock($notice, 'Bottom'); [void]$dock.Children.Add($notice)
$noticeTimer = New-Object System.Windows.Threading.DispatcherTimer
$noticeTimer.Interval = [TimeSpan]::FromSeconds(8)
$noticeTimer.Add_Tick({ $noticeTimer.Stop(); $notice.Visibility = 'Collapsed' })
function Update-NoticeColors {
  $notice.Background = $ButtonBg; $noticeText.Foreground = $Ink
  if ($noticeGrid.Children.Count -gt 1) { $noticeGrid.Children[1].Child.Foreground = $Accent }
}
function Show-Notice([string]$text, [switch]$Undo) {
  $noticeText.Text = $text
  if ($noticeGrid.Children.Count -gt 1) { $noticeGrid.Children.RemoveAt(1) }
  if ($Undo) {
    $b = New-TextButton 'Undo' { $notice.Visibility = 'Collapsed'; Undo-Last }
    $b.ToolTip = 'Ctrl+Z'; $b.Margin = '8,-4,0,-4'; [System.Windows.Controls.Grid]::SetColumn($b, 1); [void]$noticeGrid.Children.Add($b)
  }
  Update-NoticeColors
  $notice.Visibility = 'Visible'
  $noticeTimer.Stop(); $noticeTimer.Start()
}

$addBox.Add_GotKeyboardFocus({ Commit-Edit })
$addBox.Add_TextChanged({ $phText.Visibility = $(if ($addBox.Text) { 'Collapsed' } else { 'Visible' }) })
$addBox.Add_PreviewKeyDown({
  param($s, $e)
  if ($e.Key -eq 'Return') {
    $e.Handled = $true
    $t = $s.Text.Trim()
    if ($t) { $s.Text = ''; Add-Task $t }
  } elseif ($e.Key -eq 'Escape') {
    $e.Handled = $true; $s.Text = ''; [System.Windows.Input.Keyboard]::ClearFocus(); [void]$w.Focus()
  }
})

# task list (and the Settings views): the cards are inset from the window by the list's margin; the scrollbar is
# drawn over that margin instead of taking a column of its own, so the cards stay centred whether it shows or not
$scroll = New-Object System.Windows.Controls.ScrollViewer
$scroll.VerticalScrollBarVisibility = 'Auto'; $scroll.HorizontalScrollBarVisibility = 'Disabled'; $scroll.Margin = '0,4,0,0'
$scroll.Focusable = $false   # not a Tab stop of its own (the rows are)
$scroll.Template = [Windows.Markup.XamlReader]::Parse(@'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" TargetType="ScrollViewer">
  <Grid Background="{TemplateBinding Background}">
    <ScrollContentPresenter x:Name="PART_ScrollContentPresenter" Margin="{TemplateBinding Padding}" CanContentScroll="{TemplateBinding CanContentScroll}"/>
    <ScrollBar x:Name="PART_VerticalScrollBar" HorizontalAlignment="Right" Margin="0,2,3,4" Cursor="Arrow"
               Maximum="{TemplateBinding ScrollableHeight}" ViewportSize="{TemplateBinding ViewportHeight}"
               Value="{Binding VerticalOffset, Mode=OneWay, RelativeSource={RelativeSource TemplatedParent}}"
               Visibility="{TemplateBinding ComputedVerticalScrollBarVisibility}"/>
  </Grid>
</ControlTemplate>
'@)
$list = New-AccessibleList 'list' 'Tasks'
$list.Margin = "$CardInset,0,$CardInset,4"
$list.UseLayoutRounding = $true   # (the hairlines stay one crisp pixel)
$scroll.Content = $list
[void]$dock.Children.Add($scroll)
$tabGroup = 0
foreach ($area in @($strip, $scroll, $addBorder, $verBar)) {
  [System.Windows.Input.KeyboardNavigation]::SetTabNavigation($area, 'Local'); [System.Windows.Input.KeyboardNavigation]::SetTabIndex($area, $tabGroup); $tabGroup++
}

# ---------------------------------------------------------------- render
function Build-Tree {
  $roots = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.ArrayList
  foreach ($it in $script:items) {
    $node = [pscustomobject]@{ Item = $it; Kids = (New-Object System.Collections.ArrayList) }
    if ($it.Kind -eq 'raw') { [void]$roots.Add($node); $stack.Clear(); continue }
    while ($stack.Count -gt 0 -and $stack[$stack.Count - 1].Item.Level -ge $it.Level) { $stack.RemoveAt($stack.Count - 1) }
    if ($stack.Count -eq 0) { [void]$roots.Add($node) } else { [void]$stack[$stack.Count - 1].Kids.Add($node) }
    [void]$stack.Add($node)
  }
  return ,$roots
}

function Node-Rank($it) { if ($it.Text -eq '') { return 0 } else { return (Rank $it.Mark) } }

# a task, then (when open) its notes and subtasks: active first, then postponed, then closed. All in the open card;
# the hairline above a row starts at its text, so a subtask's hairlines are indented with it.
function Render-Node($node) {
  [void]$script:visible.Add($node.Item)
  $row = New-Row $node; [void]$script:rows.Add($row)
  Add-CardRow $row ($RowTextX + $node.Item.Level * $Tokens.Row.indent)
  $open = Is-Open $node
  if ($script:notesEditing -eq $node.Item) { $open = $true }
  if (-not $open) { return }
  if ($node.Item.Notes -or $script:notesEditing -eq $node.Item) { Add-CardRow (New-Notes $node.Item) -Joined }
  foreach ($r in 0, 1, 2) {
    foreach ($c in $node.Kids) { if ((Node-Rank $c.Item) -eq $r) { Render-Node $c } }
  }
}

# the headings of the list's cards line up with the status chips
$ListHeadX = 2 + $RowChipX

function Toggle-Completed {
  Commit-Edit
  $script:cfg.showCompleted = $(if ($script:cfg.showCompleted -eq '1') { '0' } else { '1' })
  Save-Settings; Render
}
# the Completed heading: "Completed · 2" with a chevron at the right end; it shows or hides the card under it
function New-CompletedHeading([int]$count, [bool]$show) {
  $h = New-Control 'disclosure' ("Completed, $count " + $(if ($count -eq 1) { 'task' } else { 'tasks' })) 'Shows or hides the completed tasks' { param($s, $e) Toggle-Completed }
  if ($script:HasA11y) { $h.IsExpanded = $show }
  $h.Padding = "$ListHeadX,3,$($CardPad - 2),3"; $h.Cursor = 'Hand'; $h.Background = $Clear
  $h.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control)
  $g = New-Object System.Windows.Controls.Grid
  foreach ($wd in @('Auto', 'Auto', '*', 'Auto')) { $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $wd; $g.ColumnDefinitions.Add($cd) }
  $lbl = New-Text 'Completed' $TypeSize.small $Faint; $lbl.FontWeight = 'Medium'; $lbl.VerticalAlignment = 'Center'
  $num = New-Text " $([char]0x00B7) $count" $TypeSize.small $Faint; $num.VerticalAlignment = 'Center'; Set-Tabular $num
  $chev = New-Text $(if ($show) { G 0xE70D } else { G 0xE76C }) 9 $Faint; $chev.FontFamily = $MDL2; $chev.VerticalAlignment = 'Center'
  [System.Windows.Controls.Grid]::SetColumn($num, 1); [System.Windows.Controls.Grid]::SetColumn($chev, 3)
  foreach ($x in @($lbl, $num, $chev)) { [void]$g.Children.Add($x) }
  $h.Child = $g
  $h.Add_MouseEnter({ param($s, $e) $s.Child.Children[0].Foreground = $Ink })
  $h.Add_MouseLeave({ param($s, $e) $s.Child.Children[0].Foreground = $Faint })
  $h.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Toggle-Completed })
  return $h
}

# The list: its tasks in a card (a heading line or a blank line in the file starts a new one), then Postponed and
# Completed, each a card under its own heading. Done, postponed and the other states look as they always did.
# Below this window width a task's deadline, subtask count and notes mark go under its text rather than beside it:
# the text column would get too narrow for one line otherwise.
$MetaBelowW = 380; $script:metaBelow = $false
function Render {
  if ($script:editItem -or $script:notesBox) { return }
  $script:metaBelow = $w.Width -lt $MetaBelowW
  Render-Tabs
  Update-ReadOnly
  if ($script:view -ne 'list') { Render-Settings; return }
  $addBorder.Visibility = $(if ($script:readOnly) { 'Collapsed' } else { 'Visible' })
  $fromSettings = $script:renderedView -ne 'list'; $script:renderedView = 'list'
  $hadFocus = $list.IsKeyboardFocusWithin -or ($fromSettings -and $verBar.IsKeyboardFocusWithin)
  $verBar.Visibility = 'Collapsed'
  $list.Children.Clear(); Reset-Groups
  if ($script:HasA11y) { $list.Role = 'list' }
  Set-Name $list "$($script:proj) tasks"
  $share = Get-ShareOf $script:proj
  if ($share) {
    # a list someone shares with this PC: where it comes from; for a view-only one also that it can't be changed
    $sst = $(if ($script:sync -and $script:sync.Shares) { @($script:sync.Shares | Where-Object { $_.Id -eq [string]$share['id'] })[0] } else { $null })
    $trouble = $(if ($sst -and @('offline', 'error') -contains $sst.State) { " Not synced right now: $($sst.Message)" } else { '' })
    if ($script:readOnly -or $trouble) {
      $txt = $(if ($script:readOnly) { "View only. Shared with you from $(Get-ShareHost $share): you see the changes as they are made, but can't change it." } else { "Shared with you from $(Get-ShareHost $share)." }) + $trouble
      $note = New-Text $txt $TypeSize.meta $(if ($trouble) { $Ink } else { $Faint }); $note.Margin = "$ListHeadX,2,$CardPad,2"
      [void]$list.Children.Add($note)
    }
  }
  $before = $list.Children.Count
  $script:visible = New-Object System.Collections.ArrayList; $script:rows = New-Object System.Collections.ArrayList
  $titleTaken = $false; $total = 0; $done = 0
  foreach ($it in $script:items) {
    if ($it.Kind -eq 'task' -and $it.Text -ne '' -and $it.Mark -ne '-' -and $it.Mark -ne '~') { $total++; if ($it.Mark -eq 'x') { $done++ } }
  }
  $postponed = New-Object System.Collections.ArrayList
  $closed    = New-Object System.Collections.ArrayList
  foreach ($n in (Build-Tree)) {
    $it = $n.Item
    if ($it.Kind -eq 'raw') {
      if (-not $titleTaken -and $it.Raw -match '^#\s+(.*)$') { $titleTaken = $true; continue }
      if ($it.Raw -match '^\s*$') { Close-Card; continue }   # a blank line ends a card
      if ($it.Raw -match '^#+\s*(.*)$') { Add-Heading $matches[1] $ListHeadX; continue }
      Add-Footnote $it.Raw $Ink $ListHeadX
      continue
    }
    $r = Node-Rank $it
    if ($r -eq 1) { [void]$postponed.Add($n); continue }
    if ($r -eq 2) { [void]$closed.Add($n); continue }
    $script:renderSection = 'active'; Render-Node $n
  }

  if ($postponed.Count) {
    Add-Heading 'Postponed' $ListHeadX
    $script:renderSection = 'postponed'; foreach ($n in $postponed) { Render-Node $n }
  }

  if ($closed.Count) {
    $show = $script:cfg.showCompleted -eq '1'
    Add-Heading (New-CompletedHeading $closed.Count $show)
    $script:renderSection = 'closed'; if ($show) { foreach ($n in $closed) { Render-Node $n } }
  }
  Close-Card

  if ($script:listBusy) { $addBorder.Visibility = 'Collapsed' }
  if ($list.Children.Count -eq $before) {   # (nothing but the shared-list note)
    $e = New-Text $(if ($script:listBusy) { "'$($script:proj)' is busy: another program is writing it. It shows here as soon as it is free." }
                    elseif ($share -and -not (Test-Path -LiteralPath $script:todo)) { 'Getting the list from its owner...' }
                    elseif ($script:readOnly) { 'No tasks here yet.' } else { 'No tasks here yet. Add one below.' }) $TypeSize.body $Faint
    $e.Margin = "$ListHeadX,24,$CardPad,8"
    [void]$list.Children.Add($e)
  }

  $countText.Text = $(if ($total) { "$done/$total" } else { '' })
  if ($script:sel -and $script:visible.IndexOf($script:sel) -lt 0) { $script:sel = $null }
  # the rows were rebuilt: keep a keyboard user on the selected task (one Tab stop for the list either way)
  $f = [System.Windows.Input.Keyboard]::FocusedElement
  Set-Sel $script:sel -Focus:($hadFocus -and ($null -eq $f -or $f -eq $w -or -not $f.IsVisible))
  # back from Settings with the keyboard and no task selected: focus goes back to the Settings button that opened it
  if ($fromSettings -and $hadFocus -and -not $script:sel -and $logo) { [void]$logo.Focus() }
}

# ---------------------------------------------------------------- settings view (logo / ... > Settings / Ctrl+,)
# Settings is a short list of sections, each a page of its own, so a narrow window stays easy to scan (docs/setup.md
# names them). Every view is a grouped list (docs/design.md): cards of one-line rows, where places to go have a
# chevron, actions are rows in violet (red when risky) and explanations are footnotes under the card. Rare and risky
# actions sit at the bottom, under Advanced. A quiet line under every Settings view says the version, with a dot when
# an update needs a look (it opens Updates); the tray icon's tooltip says it too.
$script:view = 'list'
# (in this order; the last two are a card of their own, "App")
$script:SettingsPages = [ordered]@{ general = 'General'; notifications = 'Notifications'; sync = 'Sync & sharing'; yourlists = 'Your lists'; updates = 'Updates'; about = 'About' }
# where Back (the header, Esc) goes from each view
$script:ViewParent = @{ settings = 'list'; share = 'list'; keys = 'general'; pair = 'sync'; conflicts = 'sync'; trash = 'yourlists' }
$script:ViewTitles = @{ list = 'the list'; settings = 'Settings'; keys = 'Keyboard shortcuts'; pair = 'Pair phone'; conflicts = 'Conflicts'; trash = 'Recently deleted'; share = 'Share' }
foreach ($k in $script:SettingsPages.Keys) { $script:ViewParent[$k] = 'settings'; $script:ViewTitles[$k] = $script:SettingsPages[$k] }
$script:advancedOpen = $false; $script:focusKey = ''; $script:renderedView = 'list'
function Get-ViewParent([string]$v) { if ($script:ViewParent.ContainsKey($v)) { return $script:ViewParent[$v] }; return 'settings' }
# opens a view; keyboard focus goes to the control whose key (Get-FocusKey) is $focus, else to the view's header
function Show-View([string]$v, [string]$focus = '') {
  Commit-Edit
  $script:view = $v; $script:focusKey = $focus
  Render
}
# Back (the header, Esc): one level up, with focus on what opened the view just left
function Go-Back {
  $from = $script:view
  Show-View (Get-ViewParent $from) "open-$from"
}
# the controls inside an element, depth first (the logical tree, which a view is built of)
function Get-Controls($root, $acc = $null) {
  if ($null -eq $acc) { $acc = New-Object System.Collections.ArrayList }
  foreach ($c in [System.Windows.LogicalTreeHelper]::GetChildren($root)) {
    if ($c -is [System.Windows.UIElement]) { [void]$acc.Add($c); [void](Get-Controls $c $acc) }
  }
  return ,$acc
}
# what finds a control again after a view is rebuilt: its AutomationId, else its name
function Get-FocusKey($el) {
  $id = [System.Windows.Automation.AutomationProperties]::GetAutomationId($el)
  if ($id) { return $id }
  return [System.Windows.Automation.AutomationProperties]::GetName($el)
}
function Find-Control($root, [string]$key) {
  foreach ($c in (Get-Controls $root)) { if ($c.Focusable -and (Get-FocusKey $c) -eq $key) { return $c } }
  return $null
}
# a path under %APPDATA% and friends written that way (shorter, and without the account name)
function Format-Path([string]$p) {
  foreach ($v in 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE') {
    $base = ([string][Environment]::GetEnvironmentVariable($v)).TrimEnd('\')
    if ($base -and $p.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { return "%$v%" + $p.Substring($base.Length) }
  }
  return $p
}
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Saqme To Do.lnk'
function Set-StartWithWindows([bool]$on) {
  if ($on) {
    $sh = New-Object -ComObject WScript.Shell
    $l = $sh.CreateShortcut($startupLnk)
    $l.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $l.Arguments = '"' + $Launcher + '"'
    $appHome = Split-Path -Parent $Launcher   # (the install's folder: it stays when the version changes)
    $l.WorkingDirectory = $appHome; $l.IconLocation = (Join-Path $appHome 'assets\saqme.ico') + ',0'; $l.Description = 'Saqme To Do'
    $l.Save()
  } elseif (Test-Path -LiteralPath $startupLnk) { Remove-Item -LiteralPath $startupLnk -Force }
}
# Keyboard shortcuts: @('', heading) starts a card, @(keys, what it does) is a row, @('#', text) the card's footnote
$script:Keybinds = @(
  @('', 'Tasks'),
  @('Up / Down', 'Previous / next task'),
  @('Enter', 'Edit the task'),
  @('Space', 'Done / not done'),
  @('Right / Left', 'Open / close a task'),
  @('Alt+Up / Alt+Down', 'Move the task'),
  @('Ctrl+Z', 'Undo'),
  @('Ctrl+D', 'Deadline'),
  @('Ctrl+I', 'Notes / links'),
  @('Ctrl+M', 'Task menu'),
  @('Ctrl+N', 'New task'),
  @('Esc', 'Clear the selection'),
  @('#', 'A screen reader reads the selected task. Left on a subtask goes to its parent. Ctrl+Z undoes the last change: a move, a delete, an edit. The task menu has the status, deadline, move and delete.'),
  @('', 'While editing a task'),
  @('Enter', 'Save, new task below'),
  @('Shift+Enter', 'Save, new subtask'),
  @('Enter', 'Stop (on an empty line)'),
  @('Up / Down', 'Edit the previous / next'),
  @('Tab / Shift+Tab', 'Subtask / back out'),
  @('Esc', 'Cancel'),
  @('Ctrl+Enter', 'Save the notes'),
  @('', 'Lists and app'),
  @('Tab / Shift+Tab', 'Move around the window'),
  @('Left / Right', 'Switch lists (on the title)'),
  @('Down', 'Open the lists menu (on the title)'),
  @('Enter / Space', 'Use the focused button'),
  @('Shift+F10', 'Menu of the list or task'),
  @('Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous list'),
  @('Up / Down / Home / End', 'Move in the lists menu (Enter chooses, Esc closes)'),
  @('Ctrl+,', 'Settings, and back'),
  @('Esc', 'Back one level'),
  @('#', 'Tab goes through the title, the window buttons, the list (one stop: the selected task) and the new-task box. Esc goes from a Settings page to Settings, and from Settings to the list.')
)

function Toggle-Settings {
  Show-View $(if ($script:view -eq 'list') { 'settings' } else { 'list' })
}
function Set-Theme([string]$pref) {
  $script:cfg.theme = $pref; Save-Settings
  Apply-Theme (Resolve-Theme $pref)
}
function New-Text([string]$text, [double]$size, $brush) {
  $t = New-Object System.Windows.Controls.TextBlock
  $t.Text = $text; $t.FontFamily = $UI; $t.FontSize = $size; $t.Foreground = $brush; $t.TextWrapping = 'Wrap'
  return $t
}
# the "needs a look" mark: a small violet dot (always next to words that say what it is about)
function New-Dot {
  $d = New-Object System.Windows.Shapes.Ellipse; $d.Width = 7; $d.Height = 7; $d.Fill = $Accent
  return $d
}

# ---------------------------------------------------------------- grouped lists (docs/design.md, "Grouped lists")
# The task list and every Settings view are built the same way, top to bottom in $list: an optional heading, a card
# of one-line rows, an optional footnote under the card, then the next card. A card is not a container: its rows are
# siblings in $list (selection, editing and drag and drop find the task rows there). Each row has the card's colour,
# the first and the last carry its rounded corners, and the hairline between two rows starts where the lower row's
# text starts. A row says one thing: what is said under a setting elsewhere goes to the footnote, the value on the
# right, the tooltip, or the description a screen reader reads.
$script:card = $null; $script:blocks = 0; $script:headed = $false
function Reset-Groups { $script:card = $null; $script:blocks = 0; $script:headed = $false }
# the room above a new heading or card: none under its heading, the gap between cards, a little at the top of a view
function Get-BlockGap { if ($script:headed) { return 0 } elseif ($script:blocks) { return $CardGap } else { return 6 } }
function Set-Top($el, [double]$top) { $m = $el.Margin; $el.Margin = New-Object System.Windows.Thickness($m.Left, $top, $m.Right, $m.Bottom) }
# a heading over the next card: small, quiet, sentence case. $el: its text, or a control (the Completed disclosure)
function Add-Heading($el, [double]$x = $CardPad) {
  Close-Card
  if ($el -is [string]) {
    $t = New-Text $el $TypeSize.small $Faint; $t.FontWeight = 'Medium'; $t.TextWrapping = 'NoWrap'; $t.TextTrimming = 'CharacterEllipsis'
    $t.Margin = "$x,0,$CardPad,6"; $el = $t
  } else { $el.Margin = '0,0,0,3' }
  Set-Top $el (Get-BlockGap)
  [void]$list.Children.Add($el); $script:blocks++; $script:headed = $true
}
# a row of the open card (the first row opens one). $lineX: where the hairline above it starts (its text);
# -Joined: it continues the row above (a task's notes), with no hairline between them
function Add-CardRow($row, [double]$lineX = $CardPad, [switch]$Joined) {
  if (-not $script:card) {
    $script:card = New-Object System.Collections.ArrayList
    $row.Margin = "0,$(Get-BlockGap),0,0"; $script:blocks++; $script:headed = $false
    $row.CornerRadius = New-Object System.Windows.CornerRadius($CardRadius, $CardRadius, 0, 0)
  } else {
    $row.Margin = $NoMargin
    if (-not $Joined) {
      $l = New-Object System.Windows.Controls.Border; $l.Height = 1; $l.Background = (Get-HairlineBrush $lineX); $l.Tag = $lineX
      $l.IsHitTestVisible = $false; $l.SnapsToDevicePixels = $true
      [void]$list.Children.Add($l)
    }
  }
  [void]$script:card.Add($row)
  [void]$list.Children.Add($row)
}
$NoMargin = New-Object System.Windows.Thickness(0)
# a hairline's brush: the card's colour up to x, the hairline colour from there (one per x and theme, frozen)
$script:hairlineBrushes = @{}
function Get-HairlineBrush([double]$x) {
  $k = "$($script:themeName)|$x"
  $b = $script:hairlineBrushes[$k]
  if (-not $b) {
    $b = New-Object System.Windows.Media.LinearGradientBrush
    $b.MappingMode = 'Absolute'; $b.StartPoint = New-Object System.Windows.Point($x, 0); $b.EndPoint = New-Object System.Windows.Point(($x + 1), 0)
    $b.GradientStops.Add((New-Object System.Windows.Media.GradientStop($GroupBg.Color, 0)))
    $b.GradientStops.Add((New-Object System.Windows.Media.GradientStop($GroupLine.Color, 1)))
    $b.Freeze(); $script:hairlineBrushes[$k] = $b
  }
  return $b
}
# ends the open card: its last row gets the bottom corners
function Close-Card {
  $c = $script:card; $script:card = $null
  if (-not $c -or -not $c.Count) { return }
  $top = $(if ($c.Count -eq 1) { $CardRadius } else { 0 })
  $c[$c.Count - 1].CornerRadius = New-Object System.Windows.CornerRadius($top, $top, $CardRadius, $CardRadius)
}
# the footnote under a card: what its rows mean, when that is not obvious (iOS group footers)
function Add-Footnote([string]$text, $brush = $Faint, [double]$x = $CardPad) {
  Close-Card
  $t = New-Text $text $TypeSize.meta $brush; $t.Margin = "$x,6,$CardPad,0"
  [void]$list.Children.Add($t)
}
# a quiet paragraph of its own, between cards; and something that is not a card (a QR code), with the same spacing
function Add-Note([string]$text, $brush = $Faint) {
  $t = New-Text $text $TypeSize.meta $brush; $t.Margin = "$CardPad,0,$CardPad,0"
  Add-Loose $t
}
function Add-Loose($el) {
  Close-Card
  Set-Top $el (Get-BlockGap)
  [void]$list.Children.Add($el); $script:blocks++; $script:headed = $false
}

# A row's content, all on one line: [icon] label ...... [dot] value [trailing]. The label is cut with "..." if the
# row is too narrow (callers put the whole text in the tooltip where that can happen); the value is short and muted.
#   -LongValue: the value may be long (a version of a task's text): it takes the room and is the one cut short
#   -Icon: a glyph before the label; -Lead: a short text there instead (a step's number)
function New-RowGrid([string]$label, [string]$value = '', $trailing = $null, [switch]$Dot, $LabelBrush = $null, [int]$Icon = 0, [switch]$LongValue, [string]$Lead = '') {
  $g = New-Object System.Windows.Controls.Grid; $g.VerticalAlignment = 'Center'
  foreach ($wd in @('Auto', $(if ($LongValue) { 'Auto' } else { '*' }), $(if ($LongValue) { '*' } else { 'Auto' }), 'Auto')) {
    $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $wd; $g.ColumnDefinitions.Add($cd)
  }
  if ($Icon) {
    $ic = New-Text (G $Icon) 14 $TabInk; $ic.FontFamily = $MDL2; $ic.TextWrapping = 'NoWrap'; $ic.Width = 16; $ic.TextAlignment = 'Center'; $ic.VerticalAlignment = 'Center'; $ic.Margin = '0,1,12,0'
    [void]$g.Children.Add((Hide-Decoration $ic))
  } elseif ($Lead) {
    $ld = New-Text $Lead $TypeSize.body $TabInk; $ld.TextWrapping = 'NoWrap'; $ld.Width = 16; $ld.TextAlignment = 'Center'; $ld.VerticalAlignment = 'Center'; $ld.Margin = '0,0,12,0'; Set-Tabular $ld
    [void]$g.Children.Add($ld)
  }
  $l = New-Text $label $TypeSize.body $(if ($LabelBrush) { $LabelBrush } else { $Ink })
  $l.TextWrapping = 'NoWrap'; $l.TextTrimming = 'CharacterEllipsis'; $l.VerticalAlignment = 'Center'
  [System.Windows.Controls.Grid]::SetColumn($l, 1); [void]$g.Children.Add($l)
  if ($value -or $Dot) {
    # (a long value fills the room left of the trailing part, right-aligned, and is the one cut short)
    if ($LongValue) { $vp = New-Object System.Windows.Controls.DockPanel; $vp.LastChildFill = $true }
    else { $vp = New-Object System.Windows.Controls.StackPanel; $vp.Orientation = 'Horizontal' }
    $vp.VerticalAlignment = 'Center'; $vp.Margin = '12,0,0,0'
    if ($Dot) { $d = New-Dot; $d.VerticalAlignment = 'Center'; $d.Margin = '0,1,8,0'; [void]$vp.Children.Add($d) }
    if ($value) {
      $v = New-Text $value $TypeSize.body $Faint; $v.TextWrapping = 'NoWrap'; $v.VerticalAlignment = 'Center'; Set-Tabular $v
      if ($LongValue) { $v.TextTrimming = 'CharacterEllipsis'; $v.TextAlignment = 'Right' }
      [void]$vp.Children.Add($v)
    }
    [System.Windows.Controls.Grid]::SetColumn($vp, 2); [void]$g.Children.Add($vp)
  }
  if ($trailing) {
    $trailing.VerticalAlignment = 'Center'; $m = $trailing.Margin
    $trailing.Margin = New-Object System.Windows.Thickness(($m.Left + 10), $m.Top, $m.Right, $m.Bottom)
    [System.Windows.Controls.Grid]::SetColumn($trailing, 3); [void]$g.Children.Add($trailing)
  }
  return $g
}
function Set-RowBox($b, $content) {
  $b.Background = $GroupBg; $b.Padding = "$CardPad,6,$($CardPad - 2),6"; $b.MinHeight = $RowMinH; $b.Child = $content
}
# a row that does nothing by itself: a value, or a control at its end (a switch, a choice, a box, a small button)
function New-InfoRow([string]$label, [string]$value = '', $trailing = $null, [switch]$Dot, [string]$Tip = '', [int]$Icon = 0, [switch]$LongValue, [string]$Lead = '') {
  $b = New-Object System.Windows.Controls.Border
  Set-RowBox $b (New-RowGrid $label $value $trailing -Dot:$Dot -Icon $Icon -LongValue:$LongValue -Lead $Lead)
  if ($Tip) { $b.ToolTip = $Tip }
  return $b
}
# a row that is one button: the whole row reacts to the mouse (hover, pressed) and to Enter / Space. $do gets $arg.
# $id: its AutomationId, the key Get-FocusKey finds it by again after the view is rebuilt
function New-RowButton([string]$name, [string]$help, $content, [scriptblock]$do, $arg = $null, [string]$id = '', [string]$role = 'button') {
  $b = New-Control $role $name $help { param($s, $e) & $s.Tag.Do $s.Tag.Arg }
  if ($id) { [System.Windows.Automation.AutomationProperties]::SetAutomationId($b, $id) }
  Set-RowBox $b $content
  $b.Cursor = 'Hand'; $b.Tag = @{ Do = $do; Arg = $arg }
  if ($help) { $b.ToolTip = $help }
  $b.Add_MouseEnter({ param($s, $e) $s.Background = $GroupHover })
  $b.Add_MouseLeave({ param($s, $e) $s.Background = $GroupBg })
  $b.Add_PreviewMouseLeftButtonDown({ param($s, $e) $s.Background = $GroupPress })
  $b.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; $s.Background = $GroupHover; & $s.Tag.Do $s.Tag.Arg })
  return $b
}
function New-Chevron { $c = New-Text (G 0xE76C) 11 $TabInk; $c.FontFamily = $MDL2; $c.TextWrapping = 'NoWrap'; $c.Margin = '0,1,0,0'; return (Hide-Decoration $c) }
# a row that opens another view (a Settings page, Keyboard shortcuts, Pair phone, ...): label, value, chevron. Its key
# is "open-<view>", so Back puts keyboard focus on it again. -Name / -Help: what a screen reader says (and the tooltip)
function New-LinkRow([string]$label, [string]$value, [string]$view, [switch]$Dot, [string]$Name = '', [string]$Help = '', [int]$Icon = 0) {
  $g = New-RowGrid $label $value (New-Chevron) -Dot:$Dot -Icon $Icon
  return (New-RowButton $(if ($Name) { $Name } else { $label }) $Help $g { param($v) Show-View $v } $view "open-$view")
}
# a row that does something: its label in violet, or red when it is risky (-Danger). -Name: when the label alone
# does not say enough to a screen reader
function New-ActionRow([string]$label, [scriptblock]$do, $arg = $null, [switch]$Danger, [string]$Name = '', [string]$Help = '', [string]$Value = '', [switch]$Dot) {
  $g = New-RowGrid $label $Value $null -Dot:$Dot -LabelBrush $(if ($Danger) { $Red } else { $Accent })
  return (New-RowButton $(if ($Name) { $Name } else { $label }) $Help $g $do $arg)
}
# a switch row: the switch at the end; a click anywhere on the row flips it too
function New-SwitchRow([string]$label, [bool]$on, [scriptblock]$onToggle, [string]$help = '') {
  $tg = New-Toggle $on $onToggle $label
  if ($help) { Set-Name $tg $label $help }
  $r = New-InfoRow $label '' $tg
  $r.Tag = $tg; $r.Cursor = 'Hand'
  $r.Add_MouseLeftButtonUp({ param($s, $e) if (-not $e.Handled) { $e.Handled = $true; & $s.Tag.Tag.F (-not $s.Tag.Tag.On) } })
  return $r
}
# a small button at the end of a row (Restore, Leave, Connect): text only, violet or red
function New-TextButton([string]$text, [scriptblock]$onClick, $fg = $null, $arg = $null) {
  $b = New-Control 'button' $text '' { param($s, $e) & $s.Tag.F $s.Tag.A }
  $b.Background = $Clear; $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $b.Padding = '8,3,8,4'; $b.Margin = '0,-3,-6,-3'; $b.Cursor = 'Hand'
  $b.Child = (New-Text $text $TypeSize.body $(if ($fg) { $fg } else { $Accent })); $b.Child.TextWrapping = 'NoWrap'
  $b.Tag = @{ F = $onClick; A = $arg }
  $b.Add_MouseEnter({ param($s, $e) $s.Background = $GroupPress })
  $b.Add_MouseLeave({ param($s, $e) $s.Background = $Clear })
  $b.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; & $s.Tag.F $s.Tag.A })
  return $b
}
# a text box that is a whole row (a link to paste), with an optional button at its end; $hint: shown while it is empty
function New-InputRow($box, [string]$hint, $button = $null) {
  $box.FontFamily = $UI; $box.FontSize = $TypeSize.body; $box.Background = $Clear; $box.Foreground = $Ink; $box.CaretBrush = $Accent
  $box.BorderThickness = '0'; $box.BorderBrush = $Red; $box.Padding = '0,2,0,2'; $box.VerticalContentAlignment = 'Center'
  $g = New-Object System.Windows.Controls.Grid; $g.VerticalAlignment = 'Center'
  foreach ($wd in @('*', 'Auto')) { $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $wd; $g.ColumnDefinitions.Add($cd) }
  $h = New-Text $hint $TypeSize.body $Faint; $h.IsHitTestVisible = $false; $h.TextWrapping = 'NoWrap'; $h.TextTrimming = 'CharacterEllipsis'
  $h.Margin = '2,0,0,0'; $h.VerticalAlignment = 'Center'
  $hw = Hide-Decoration $h; $hw.Visibility = $(if ($box.Text) { 'Collapsed' } else { 'Visible' })
  $box.Add_TextChanged({ param($s, $e) $s.Parent.Children[1].Visibility = $(if ($s.Text) { 'Collapsed' } else { 'Visible' }); $s.BorderThickness = '0' })
  [void]$g.Children.Add($box); [void]$g.Children.Add($hw)
  if ($button) { $button.VerticalAlignment = 'Center'; $button.Margin = '10,-3,-6,-3'; [System.Windows.Controls.Grid]::SetColumn($button, 1); [void]$g.Children.Add($button) }
  $r = New-Object System.Windows.Controls.Border; Set-RowBox $r $g
  return $r
}
# a box of an input row that does not take what was typed: a red line under it until it changes
function Set-BoxError($box) { $box.BorderThickness = '0,0,0,1.5'; $box.BorderBrush = $Red }
# a choice of a few (the theme, an access level): segments on a quiet track, the current one violet. $options:
# @(value, label[, what it means: tooltip and screen-reader description])
function New-Segmented($options, [string]$current, [scriptblock]$onPick, [string]$group = '') {
  $wrap = New-Object System.Windows.Controls.Border
  $wrap.Background = $GroupPress; $wrap.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $wrap.Padding = '2'
  $sp = New-Object System.Windows.Controls.StackPanel; $sp.Orientation = 'Horizontal'
  foreach ($o in $options) {
    $b = New-Control 'radio' $o[1] $(if ($o.Count -gt 2) { $o[2] } else { $group }) { param($s, $e) & $s.Tag.F $s.Tag.V }
    if ($script:HasA11y) { $b.IsSelected = ($o[0] -eq $current) }
    if ($o.Count -gt 2) { $b.ToolTip = $o[2] }
    $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.chip); $b.Padding = '11,3,11,4'; $b.Cursor = 'Hand'
    $t = New-Text $o[1] $TypeSize.label $TabInk; $t.FontWeight = 'Medium'; $t.TextWrapping = 'NoWrap'
    if ($o[0] -eq $current) { $b.Background = $Accent; $t.Foreground = $OnAccent; $t.FontWeight = 'SemiBold' } else { $b.Background = $Clear }
    $b.Child = $t; $b.Tag = @{ V = $o[0]; F = $onPick }
    $b.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; & $s.Tag.F $s.Tag.V })
    [void]$sp.Children.Add($b)
  }
  $wrap.Child = $sp
  return $wrap
}
function New-Toggle([bool]$on, [scriptblock]$onToggle, [string]$name = '') {
  $b = New-Control 'toggle' $name '' { param($s, $e) & $s.Tag.F (-not $s.Tag.On) }
  if ($script:HasA11y) { $b.IsChecked = $on }
  $b.Width = 36; $b.Height = 20; $b.CornerRadius = New-Object System.Windows.CornerRadius(10); $b.Cursor = 'Hand'
  $b.Background = $(if ($on) { $Accent } else { $GroupLine })
  $k = New-Object System.Windows.Shapes.Ellipse; $k.Width = 14; $k.Height = 14; $k.Fill = $(if ($on) { $OnAccent } else { $Paper })
  $k.HorizontalAlignment = $(if ($on) { 'Right' } else { 'Left' }); $k.Margin = '3,0,3,0'
  $b.Child = $k; $b.Tag = @{ On = $on; F = $onToggle }
  $b.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; & $s.Tag.F (-not $s.Tag.On) })
  return $b
}
# a view's title, which is also its Back button (to where Get-ViewParent says)
function New-SettingsHeader([string]$title) {
  $h = New-Control 'button' "$title - back to $($script:ViewTitles[(Get-ViewParent $script:view)])" 'Esc goes back too' { param($s, $e) Go-Back }
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($h, 'back')
  $h.Padding = '6,4,8,6'; $h.Margin = '0,0,0,2'; $h.Cursor = 'Hand'; $h.Background = $Clear; $h.HorizontalAlignment = 'Left'
  $h.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control)
  $sp = New-Object System.Windows.Controls.StackPanel; $sp.Orientation = 'Horizontal'
  $c = New-Object System.Windows.Controls.TextBlock; $c.Text = G 0xE76B; $c.FontFamily = $MDL2; $c.FontSize = 10
  $c.Foreground = $TabInk; $c.VerticalAlignment = 'Center'; $c.Margin = '0,1,10,0'
  $t = New-Text $title $TypeSize.title $Ink; $t.FontWeight = 'SemiBold'
  [void]$sp.Children.Add($c); [void]$sp.Children.Add($t)
  $h.Child = $sp
  $h.Add_MouseEnter({ param($s, $e) $s.Background = $Hover })
  $h.Add_MouseLeave({ param($s, $e) $s.Background = $Clear })
  $h.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Go-Back })
  return $h
}
# every view but the list: Settings and its pages, and the views they open (also Share and Conflicts)
function Render-Settings {
  if ($script:view -eq 'share' -and -not $script:shareView) { $script:view = 'list'; Render; return }
  $addBorder.Visibility = 'Collapsed'
  # keyboard focus: on the same control when a view is rebuilt in place (a sync update, a switch flipped), else on
  # what Show-View asked for or on the new view's header, so keyboard and screen reader users land on the new page
  $changed = $script:view -ne $script:renderedView
  $f = [System.Windows.Input.Keyboard]::FocusedElement
  $keep = $(if (-not $changed -and $f -is [System.Windows.DependencyObject] -and $list.IsKeyboardFocusWithin) { Get-FocusKey $f } else { '' })
  $list.Children.Clear(); Reset-Groups
  if ($script:HasA11y) { $list.Role = 'group' }
  Set-Name $list $(if ($script:view -eq 'share') { 'Share' } elseif ($script:ViewTitles.ContainsKey($script:view)) { $script:ViewTitles[$script:view] } else { 'Settings' })
  $script:visible = New-Object System.Collections.ArrayList; $script:rows = New-Object System.Collections.ArrayList
  Render-SettingsView
  Close-Card
  $verBar.Visibility = 'Visible'; Update-VersionDisplay
  $want = $(if ($script:focusKey) { $script:focusKey } elseif ($changed) { 'back' } else { $keep })
  $script:focusKey = ''; $script:renderedView = $script:view
  if ($want) {
    $el = Find-Control $list $want
    if (-not $el -and $changed) { $el = Find-Control $list 'back' }
    if ($el) { [void]$el.Focus() }
  }
}
function Render-SettingsView {
  switch ($script:view) {
    'pair' { Render-PairView; return }
    'share' { Render-ShareView; return }
    'trash' { Render-TrashView; return }
    'conflicts' { Render-ConflictsView; return }
    'keys' { Render-KeysView; return }
    'general' { Render-GeneralPage; return }
    'notifications' { Render-NotificationsPage; return }
    'sync' { Render-SyncPage; return }
    'updates' { [void]$list.Children.Add((New-SettingsHeader 'Updates')); Render-UpdateSettings; return }
    'yourlists' { Render-YourListsPage; return }
    'about' { Render-AboutPage; return }
  }
  $script:view = 'settings'
  Render-SettingsHome
}
# what it does on the left, its keys on the right (each a small key cap)
function Render-KeysView {
  [void]$list.Children.Add((New-SettingsHeader 'Keyboard shortcuts'))
  foreach ($kb in $script:Keybinds) {
    if (-not $kb[0]) { Add-Heading $kb[1]; continue }
    if ($kb[0] -eq '#') { Add-Footnote $kb[1]; continue }
    $keys = New-Object System.Windows.Controls.StackPanel; $keys.Orientation = 'Horizontal'
    foreach ($part in ($kb[0] -split ' / ')) {
      $chip = New-Object System.Windows.Controls.Border
      $chip.Background = $GroupPress; $chip.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.chip); $chip.Padding = '6,1,6,2'; $chip.Margin = '4,0,0,0'
      $chip.Child = (New-Text $part $TypeSize.small $Ink); $chip.Child.TextWrapping = 'NoWrap'
      [void]$keys.Children.Add($chip)
    }
    Add-CardRow (New-InfoRow $kb[1] '' $keys -Tip "$($kb[1]): $($kb[0])")
  }
  Close-Card
}

# Settings: two cards of pages (the app's own things last), each row with what it stands at on the right
function Render-SettingsHome {
  [void]$list.Children.Add((New-SettingsHeader 'Settings'))
  $page = {
    param([string]$id, [string]$value, [string]$name, [string]$help, [int]$icon, [bool]$dot = $false)
    Add-CardRow (New-LinkRow $script:SettingsPages[$id] $value $id -Dot:$dot -Name "$($script:SettingsPages[$id]), $name" -Help $help -Icon $icon) ($CardPad + 28)
  }
  $theme = (Get-Culture).TextInfo.ToTitleCase($script:cfg.theme)
  & $page 'general' $theme "$($theme.ToLower()) theme" 'Theme, start with Windows, keyboard shortcuts' 0xE713
  & $page 'notifications' $script:cfg.notifyAt "daily summary at $($script:cfg.notifyAt)" 'Daily summary, test notification' 0xEA8F
  $sync = Get-SyncSummary
  & $page 'sync' $sync.Short $sync.Text 'Set up sync or how it stands, pair phone, conflicts, shared lists' 0xE753 $sync.Dot
  $n = @(Get-ProjectNames).Count
  $nl = $(if ($n -eq 1) { '1 list' } else { "$n lists" })
  & $page 'yourlists' $nl $nl 'Lists folder, recently deleted' 0xE8FD
  Add-Heading 'App'
  $badge = Get-UpdateBadge
  $upd = $(if ($badge) { $badge } else { Get-UpdateSummary })
  & $page 'updates' $upd.Short $upd.Text 'The version, checking and installing updates' 0xE777 ([bool]($badge -and $badge.Dot))
  & $page 'about' $script:Release.Version "version $($script:Release.Version)" 'Version, where the app and your data are' 0xE946
}
# the Sync & sharing row: own sync (off, setting up, its state), conflicts, lists shared with this PC, paused deletes.
# Text says all of it (for screen readers); Short is the value on the right, what needs a look first
function Get-SyncSummary {
  $parts = New-Object System.Collections.ArrayList
  $own = Read-SyncConfigUi
  if ($script:setupRun) { [void]$parts.Add('Setting up sync...') }
  elseif ($own) { [void]$parts.Add((Get-SyncStatusLine)) }
  else { [void]$parts.Add('Sync is off') }
  $n = @(Get-OpenConflictList).Count + @(Get-NoticeList).Count
  $nc = $(if ($n -eq 1) { '1 conflict' } else { "$n conflicts" })
  if ($n) { [void]$parts.Add($nc) }
  $sh = @($script:bindings).Count
  $ns = $(if ($sh -eq 1) { '1 shared list' } else { "$sh shared lists" })
  if ($sh) { [void]$parts.Add($ns) }
  $guarded = $script:sync -and $script:sync.Guarded
  if ($guarded) { [void]$parts.Add('deletions paused') }
  $short = $(if ($n) { $nc } elseif ($guarded) { 'Deletions paused' } elseif ($script:setupRun) { 'Setting up...' }
             elseif ($own) { Get-SyncStatusLine } elseif ($sh) { $ns } else { 'Off' })
  return @{ Text = ($parts -join ', '); Short = $short; Dot = [bool]($n -or $guarded) }
}

function Render-GeneralPage {
  [void]$list.Children.Add((New-SettingsHeader 'General'))
  $seg = New-Segmented @(@('dark', 'Dark'), @('light', 'Light'), @('auto', 'Auto', 'Follows the Windows light or dark setting')) $script:cfg.theme { param($v) Set-Theme $v } 'Theme'
  Add-CardRow (New-InfoRow 'Theme' '' $seg)
  Add-CardRow (New-SwitchRow 'Start with Windows' (Test-Path -LiteralPath $startupLnk) {
    param($on)
    try { Set-StartWithWindows $on } catch {}
    Render
  } 'Saqme opens when you sign in to Windows')
  Add-CardRow (New-LinkRow 'Keyboard shortcuts' '' 'keys' -Help 'Everything you can do without the mouse')
}

function Render-NotificationsPage {
  [void]$list.Children.Add((New-SettingsHeader 'Notifications'))
  $tb = New-Object System.Windows.Controls.TextBox
  Set-Name $tb 'Daily summary time' 'Hours and minutes, for example 9:30'
  $tb.Text = $script:cfg.notifyAt; $tb.Width = 58; $tb.FontFamily = $UI; $tb.FontSize = $TypeSize.body; $tb.TextAlignment = 'Center'; Set-Tabular $tb
  $tb.Background = $Clear; $tb.Foreground = $Ink; $tb.CaretBrush = $Accent; $tb.BorderThickness = '0'; $tb.BorderBrush = $Red; $tb.Padding = '0,2,0,2'
  $save = {
    param($s)
    if ($s.Text.Trim() -match '^(\d{1,2}):(\d{2})$' -and [int]$matches[1] -lt 24 -and [int]$matches[2] -lt 60) {
      $script:cfg.notifyAt = '{0}:{1}' -f [int]$matches[1], $matches[2]; Save-Settings; $s.BorderThickness = '0'
      if ($script:sync) { $script:sync.NotifyAt = $script:cfg.notifyAt; Request-Sync }
    } else { Set-BoxError $s }
  }
  $tb.Tag = $save
  $tb.Add_PreviewKeyDown({ param($s, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; & $s.Tag $s; [void]$w.Focus() } })
  $tb.Add_LostKeyboardFocus({ param($s, $e) & $s.Tag $s })
  # the time sits in a small pill, like a value you can change
  $pill = New-Object System.Windows.Controls.Border
  $pill.Background = $GroupPress; $pill.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $pill.Padding = '4,1,4,1'; $pill.Child = $tb
  Add-CardRow (New-InfoRow 'Daily summary' '' $pill)
  Add-Footnote 'One notification with what is due today or overdue; your phone uses the same time. A task with a deadline time also reminds you 15 minutes before it and at the time.'
  Add-CardRow (New-ActionRow 'Send a test notification' { Show-Toast 'Saqme To Do' 'Notifications are working.' $script:proj })
  Add-Footnote 'Nothing shows up? Turn off Do Not Disturb, or make Saqme a priority app.'
}

function Render-SyncPage {
  [void]$list.Children.Add((New-SettingsHeader 'Sync & sharing'))
  Render-SyncSettings
  Render-SharedListSettings
  # a pending decision: shown whenever it is there, below the everyday rows
  if ($script:sync -and $script:sync.Guarded) {
    $g = $script:sync.Guarded
    $msg = $(if (Read-SyncConfigUi) { "$g tasks vanished from the lists folder at once, so deleting them on your other devices is paused in case that was an accident. Restore them puts them back into their lists, as they were when they last synced. Delete them deletes them on your other devices too." }
             else { "$g tasks vanished from a shared list's file at once, so deleting them for its owner is paused in case that was an accident. Restore them puts them back into the list, as they were when they last synced. Delete them deletes them for its owner too." })
    Add-Heading 'Deletions paused'
    Add-CardRow (New-InfoRow 'Waiting for you' $(if ($script:sync.RestoreHeld) { 'Restoring...' } else { "$g tasks" }) -Dot -Tip $msg)
    Add-CardRow (New-ActionRow 'Restore them' { $script:sync.AllowMassDelete = $false; $script:sync.RestoreHeld = $true; Request-Sync; Render } -Help 'Puts the tasks back into their lists, as they were when they last synced')
    Add-CardRow (New-ActionRow 'Delete them' { $script:sync.RestoreHeld = $false; $script:sync.AllowMassDelete = $true; Request-Sync; Render } -Danger -Help 'Confirms the paused deletions: the tasks are deleted on your other devices too')
    Add-Footnote $msg
  }
  if ($script:rewritten.Count) { Render-RewrittenLists }
  Render-SyncAdvanced
}
# Lists whose file vanished from the lists folder without being deleted in an app (another program, a sync client, a
# copy of the folder in another app's private storage): the sync wrote them again from the last sync (docs/sync.md)
function Render-RewrittenLists {
  Add-Heading 'Lists written again'
  foreach ($x in $script:rewritten) {
    Add-CardRow (New-InfoRow ([string]$x.Name) ("$($x.Count) $(if ($x.Count -eq 1) { 'task' } else { 'tasks' }), $($x.At.ToString('HH:mm', $CI))"))
  }
  Add-CardRow (New-ActionRow 'OK' { $script:rewritten.Clear(); Render } -Name 'Dismiss: lists written again' -Help 'Clears this list')
  Add-Footnote 'Their files vanished from the lists folder without being deleted in the app, so Saqme wrote them again from the last sync instead of deleting anything. To delete a list, use Delete list in its menu.'
}
# Sync & sharing > Advanced: turning sync off, a new key, the sync log (a row that opens the rest of its card)
function Render-SyncAdvanced {
  $own = Read-SyncConfigUi
  $log = Join-Path $syncDir 'sync.log'
  $hasLog = Test-Path -LiteralPath $log
  if (-not $own -and -not $hasLog) { return }
  $inside = @()
  if ($own) { $inside += 'Turn off sync', 'a new sync key' }
  if ($hasLog) { $inside += $(if ($own) { 'the sync log' } else { 'The sync log' }) }
  $open = $script:advancedOpen
  $chev = New-Text $(if ($open) { G 0xE70D } else { G 0xE76C }) 11 $TabInk; $chev.FontFamily = $MDL2; $chev.TextWrapping = 'NoWrap'; $chev.Margin = '0,1,0,0'
  $adv = New-RowButton 'Advanced' ($inside -join ', ') (New-RowGrid 'Advanced' '' (Hide-Decoration $chev)) { $script:advancedOpen = -not $script:advancedOpen; Render } $null 'advanced' 'disclosure'
  if ($script:HasA11y) { $adv.IsExpanded = $open }
  Add-CardRow $adv
  if (-not $open) { return }
  $notes = @()
  if ($own) {
    Add-CardRow (New-ActionRow 'Turn off sync' {
            $r = [System.Windows.MessageBox]::Show($w, "Turn off sync on this PC?`n`n$($script:TurnOffHelp)", 'Saqme To Do', 'YesNo', 'Question')
            if ("$r" -eq 'Yes') { Disable-Sync; Render } } -Danger -Help $script:TurnOffHelp)
    $notes += $script:TurnOffHelp, "A new sync key, if a pairing link got out: run setup again with $([char]0x2011)RotateToken. The old key stops working; pair your devices again."
  }
  if ($hasLog) {
    Add-CardRow (New-ActionRow 'Open the sync log' { Start-Process notepad.exe -ArgumentList "`"$(Join-Path $syncDir 'sync.log')`"" } -Help 'In Notepad')
    $notes += 'The sync log says what sync did, for a bug report (sync\sync.log in your data folder).'
  }
  Add-Footnote ($notes -join ' ')
}

# "Use with AI": the instructions for an AI assistant (Get-AiPrompt, rules.ps1) with this PC's real lists folder
function Get-ThisAiPrompt { return (Get-AiPrompt ([IO.Path]::GetFullPath($listsDir))) }
function Copy-AiPrompt {
  try { [System.Windows.Clipboard]::SetText((Get-ThisAiPrompt)); Show-Notice 'Instructions copied. Paste them into your AI assistant.' }
  catch { Show-Notice 'Could not copy: another program is using the clipboard.' }
}
# writes the instructions to $path (UTF-8). Returns why not, or '' when saved. Not into the lists folder: the app would show the file as a list
function Save-AiPromptFile([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  $in = ([IO.Path]::GetFullPath($listsDir)).TrimEnd('\') + '\'
  if (([IO.Path]::GetDirectoryName($full) + '\').StartsWith($in, [StringComparison]::OrdinalIgnoreCase)) { return 'Not in the lists folder: the app would show that file as a list. Choose another folder.' }
  try { Write-TextFileAtomic $full (Get-ThisAiPrompt) } catch { return "Could not save it: $($_.Exception.Message)" }
  return ''
}
function Save-AiPromptAs {
  $dlg = New-Object Microsoft.Win32.SaveFileDialog
  $dlg.Title = 'Save the instructions for your AI'; $dlg.FileName = 'SAQME.md'; $dlg.DefaultExt = '.md'
  $dlg.Filter = 'Markdown (*.md)|*.md|All files (*.*)|*.*'; $dlg.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')
  if ($dlg.ShowDialog($w) -ne $true) { return }
  $err = Save-AiPromptFile $dlg.FileName
  Show-Notice $(if ($err) { $err } else { "Saved $([IO.Path]::GetFileName($dlg.FileName))." })
}

function Render-YourListsPage {
  [void]$list.Children.Add((New-SettingsHeader 'Your lists'))
  Add-Heading 'Use with AI'
  Add-CardRow (New-ActionRow 'Copy instructions for your AI' { Copy-AiPrompt } -Help 'Where your lists are and how to edit them, to paste into Claude, ChatGPT, Cursor...')
  Add-CardRow (New-ActionRow 'Save them as a file...' { Save-AiPromptAs } -Name 'Save the instructions for your AI as a file' -Help 'SAQME.md, to add to an assistant''s instructions, a Claude Project or a skill')
  Add-Footnote "Your lists are plain markdown files, so an AI assistant that can open files can read and manage them. These instructions tell it where they are, the format and what it must not do."
  Add-Heading 'Lists'
  Add-CardRow (New-ActionRow 'Open the lists folder' { Start-Process explorer.exe -ArgumentList "`"$listsDir`"" } -Help (Format-Path $listsDir))
  Add-CardRow (New-LinkRow 'Recently deleted' '' 'trash' -Help 'Deleted tasks, ready to restore for 30 days')
  Add-Footnote "Plain markdown files, one per list, in $(Format-Path $listsDir). Editors and AI assistants can change them too; the app picks up their changes by itself."
}

function Render-AboutPage {
  [void]$list.Children.Add((New-SettingsHeader 'About'))
  Add-CardRow (New-InfoRow 'Version' $script:Release.Version -Tip (Get-VersionText))
  $badge = Get-UpdateBadge
  if ($badge) { Add-CardRow (New-LinkRow 'Updates' $badge.Short 'updates' -Dot:$badge.Dot -Name "Updates, $($badge.Text)" -Help $badge.Text) }
  Add-CardRow (New-ActionRow 'Open the data folder' { Start-Process explorer.exe -ArgumentList "`"$DataDir`"" } -Help (Format-Path $DataDir))
  Add-Footnote ($(if ($InstallRoot) { "Installed in $(Format-Path $InstallRoot), and it updates itself." }
                         else { "Runs from $(Format-Path $dir) and does not update itself (setup.cmd installs it)." }) +
                       " Your lists, these settings and the sync keys are in $(Format-Path $DataDir).")
  Add-Note 'Saqme To Do is free and open source (MIT license). Your lists are plain markdown files: this app, AI assistants and any editor can change them.'
}

# ---------------------------------------------------------------- sync (cloud): UI side
# The sync loop (sync-worker.ps1) runs in its own runspace and never touches WPF; it reports through
# $script:sync and hands file changes over as plans, which Apply-SyncPlan executes here on the UI thread
# between edits (never while you are typing).
$script:sync = $null; $script:resolving = @{}; $script:syncShown = ''
$script:rewritten = New-Object System.Collections.ArrayList   # lists written again this session (Settings > Sync & sharing)

function Start-SyncLoop {
  if ($script:sync) { return }
  $shared = [hashtable]::Synchronized(@{})
  $shared.AppDir = $dir; $shared.ListsDir = $listsDir; $shared.SyncDir = $syncDir
  $shared.Wake = New-Object System.Threading.AutoResetEvent($true)
  $shared.PlanDone = New-Object System.Threading.ManualResetEvent($false)
  $shared.Lock = New-Object Object
  $shared.Queue = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
  $shared.Stop = $false; $shared.Status = 'syncing'; $shared.StatusText = 'Starting...'; $shared.Conflicts = @()
  $shared.Guarded = 0; $shared.AllowMassDelete = $false; $shared.RestoreHeld = $false; $shared.NotifyAt = $script:cfg.notifyAt; $shared.Plan = $null
  # shared lists (sync-worker.ps1): what it reports, and what it hands back
  $shared.Shares = @(); $shared.Notices = @(); $shared.SharedByMe = @{}; $shared.ProjectIds = @{}
  $shared.Ended = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
  $shared.JoinResults = [hashtable]::Synchronized(@{})
  # deletes made here (never held back as vanished), and lists whose file was gone and came back (sync-worker.ps1)
  $shared.Removed = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
  $shared.Rewritten = [System.Collections.Queue]::Synchronized((New-Object System.Collections.Queue))
  $rs = [runspacefactory]::CreateRunspace()
  $rs.ApartmentState = 'MTA'; $rs.ThreadOptions = 'ReuseThread'
  $rs.Open()
  $rs.SessionStateProxy.SetVariable('shared', $shared)
  $ps = [powershell]::Create(); $ps.Runspace = $rs
  [void]$ps.AddScript([IO.File]::ReadAllText((Join-Path $dir 'sync-worker.ps1')))
  $shared.Handle = $ps.BeginInvoke()
  $script:sync = $shared; $script:syncPs = $ps; $script:syncRs = $rs
}

function Stop-SyncLoop {
  $s = $script:sync
  if (-not $s) { return }
  $s.Stop = $true; [void]$s.Wake.Set(); [void]$s.PlanDone.Set()
  try { [void]$s.Handle.AsyncWaitHandle.WaitOne(4000) } catch {}
  try { $script:syncPs.Stop(); $script:syncPs.Dispose(); $script:syncRs.Dispose() } catch {}
  $script:sync = $null
}

function Read-SyncConfigUi {
  $t = Read-TextFile $syncCfgFile
  if (-not $t) { return $null }
  try { $c = ConvertFrom-JsonText $t } catch { return $null }
  if (-not $c -or -not $c['url'] -or -not $c['token'] -or $c['enabled'] -eq $false) { return $null }
  return $c
}

function Format-Ago([datetime]$t) {
  $sec = ((Get-Date) - $t).TotalSeconds
  if ($sec -lt 45) { return 'just now' }
  if ($sec -lt 3600) { return "$([int][Math]::Round($sec / 60)) min ago" }
  return 'at ' + $t.ToString('HH:mm', $CI)
}

function Get-SyncStatusLine {
  $s = $script:sync
  if (-not $s -or $s.Status -eq 'off') { return 'Sync is off' }
  switch ($s.Status) {
    'syncing' { return 'Syncing...' }
    'synced' { return 'Synced' + $(if ($s.LastSync) { ' ' + (Format-Ago $s.LastSync) } else { '' }) }
    default { return [string]$s.StatusText }
  }
}

function Get-OpenConflictList {
  if (-not $script:sync -or -not $script:sync.Conflicts) { return @() }
  return @($script:sync.Conflicts | Where-Object { -not $script:resolving.ContainsKey($_.Id) })
}
# what a shared list's server did not take (the list is view-only here): shown with the conflicts
function Get-NoticeList {
  if (-not $script:sync -or -not $script:sync.Notices) { return @() }
  return @($script:sync.Notices | Where-Object { -not $script:resolving.ContainsKey($_.Id) })
}

# repaints the strip glyph + badge; returns $true when something changed
function Update-SyncIndicator([switch]$Force) {
  $s = $script:sync
  $status = $(if ($s) { [string]$s.Status } else { 'off' })
  $n = @(Get-OpenConflictList).Count + @(Get-NoticeList).Count
  $sig = "$status|$(if ($s) { $s.StatusText })|$n|$(if ($s) { $s.Guarded })|$(if ($s -and $s.LastSync) { (Format-Ago $s.LastSync) })"
  if (-not $Force -and $sig -eq $script:syncShown) { return $false }
  $script:syncShown = $sig
  if ($status -eq 'off') { $syncButton.Visibility = 'Collapsed' }
  else {
    $syncButton.Visibility = 'Visible'
    switch ($status) {
      'syncing' { $syncGlyph.Text = G 0xE895; $syncGlyph.Foreground = $Accent; $syncGlyph.Opacity = 0.85 }
      'synced'  { $syncGlyph.Text = G 0xE753; $syncGlyph.Foreground = $TabInk; $syncGlyph.Opacity = 0.55 }
      'offline' { $syncGlyph.Text = G 0xE753; $syncGlyph.Foreground = $Faint; $syncGlyph.Opacity = 0.35 }
      default   { $syncGlyph.Text = G 0xE7BA; $syncGlyph.Foreground = $Red; $syncGlyph.Opacity = 1 }
    }
    $syncButton.ToolTip = Get-SyncStatusLine; Set-Name $syncButton ('Sync: ' + (Get-SyncStatusLine))
  }
  if ($n -gt 0) { $conflictBadge.Visibility = 'Visible'; $cbText.Text = $(if ($n -eq 1) { '1 conflict' } else { "$n conflicts" }); Set-Name $conflictBadge $cbText.Text }
  else { $conflictBadge.Visibility = 'Collapsed' }
  return $true
}

# executes a plan from the sync loop: all list rewrites at once, or nothing (then it is retried)
function Apply-SyncPlan {
  $s = $script:sync
  if (-not $s -or -not $s.Plan) { return }
  if ($script:editItem -or $script:tabEditing -or $script:notesBox -or $script:drag -or $script:saveFailed -or (Test-PopupOpen)) { return }   # later, between edits
  [System.Threading.Monitor]::Enter($s.Lock)
  try {
    $plan = $s.Plan
    if (-not $plan -or $s.PlanTaken) { return }
    $s.PlanTaken = $true
  } finally { [System.Threading.Monitor]::Exit($s.Lock) }
  $ok = $false
  $openPath = $script:todo
  try {
    $done = Invoke-PlanOps $plan.Ops $listsDir
    $ok = ($done -eq @($plan.Ops).Count)
    if ($ok -and $null -ne $plan.Setting -and $plan.Setting -and $plan.Setting -ne $script:cfg.notifyAt) { $script:cfg.notifyAt = $plan.Setting; Save-Settings; $s.NotifyAt = $plan.Setting }
  } catch { $ok = $false }
  [System.Threading.Monitor]::Enter($s.Lock)
  try { $s.PlanResult = $ok; $s.Plan = $null } finally { [System.Threading.Monitor]::Exit($s.Lock) }
  [void]$s.PlanDone.Set()
  # follow a rename / removal of the open list, then show the new content
  $target = $script:proj
  foreach ($o in @($plan.Ops)) {
    if ($o.type -eq 'rename' -and $o.from -eq $openPath) { $target = [IO.Path]::GetFileNameWithoutExtension($o.to) }
    if ($o.type -eq 'trash' -and $o.path -eq $openPath) { $target = $null }
  }
  $names = @(Get-ProjectNames)
  if (-not $target -or $names -notcontains $target) { $target = $(if ($names.Count) { $names[0] } else { 'General' }) }
  if ($target -ne $script:proj) { Switch-Project $target }
  else { [void](Use-Loaded (Load-Items)); Render }
}

# A pairing link from a device that already syncs (sync-core.ps1 Get-PairingLink: https only, no user name in
# the address). Says where this PC's lists go before uploading them. 'ok' | 'bad' (not a link) | 'cancel'
function Connect-Sync([string]$link) {
  $p = Get-PairingLink $link
  if (-not $p -or -not $p.Server) { return 'bad' }
  $srvHost = ([Uri]$p.Server).Host
  $n = @(Get-ProjectNames).Count
  $r = [System.Windows.MessageBox]::Show($w, "Sync this PC with $srvHost?`n`nThis uploads this PC's $n $(if ($n -eq 1) { 'list' } else { 'lists' }) to $srvHost and keeps them in step with it. Only use a pairing link from your own devices: whoever runs that server can read your lists.", 'Saqme To Do', 'YesNo', 'Question')
  if ("$r" -ne 'Yes') { return 'cancel' }
  if (-not (Test-Path -LiteralPath $syncDir)) { [void](New-Item -ItemType Directory -Path $syncDir -Force) }
  Write-TextFileAtomic $syncCfgFile (ConvertTo-JsonText @{ url = $p.Server; token = $p.Key; deviceId = "pc-$(New-SaqmeId 10)"; enabled = $true })
  Start-SyncLoop
  Request-Sync
  return 'ok'
}

# ---------------------------------------------------------------- Settings > Sync & sharing > Set up sync
# Runs the cloud part of setup (what setup.cmd -Cloud does) in a console window of its own: Node.js, the
# Cloudflare sign-in in the browser and any questions happen there, while the app keeps running. Its result
# file says how it ended (Watch-SyncSetup); without one, the window was closed before it finished.
$script:SetupHelp = 'Creates your own free sync service in your Cloudflare account. Your lists stay on this PC and are uploaded there; nothing is deleted. You need a free Cloudflare account and one sign-in in the browser.'
$script:TurnOffHelp = 'This PC stops syncing. Your lists stay on this PC. The copy in your Cloudflare account is kept until you delete it there.'
$script:setupRun = $null; $script:setupOutcome = $null
function Find-SetupScript {
  foreach ($p in @($env:SAQME_SETUP_SCRIPT, (Join-Path $dir 'setup.ps1'), (Join-Path $dir '..\scripts\setup.ps1'))) {
    if ($p -and (Test-Path -LiteralPath $p)) { return (Resolve-Path -LiteralPath $p).Path }
  }
  return $null
}
# Started from inside an MSIX-packaged app (e.g. by an AI assistant's shell in a desktop app), this process sees
# that app's private copy of AppData and the registry: setup run from here would write there, where Saqme
# started from the Start menu never looks. The package's name, or '' (SAQME_TEST_PACKAGE pretends, for tests).
function Get-PackageContext {
  if ($env:SAQME_TEST_PACKAGE) { return $env:SAQME_TEST_PACKAGE }
  try {
    if (-not ('SaqmeApp.Package' -as [type])) {
      Add-Type -Namespace SaqmeApp -Name Package -ErrorAction Stop -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetCurrentPackageFullName(ref int length, System.Text.StringBuilder name);'
    }
    $len = 0
    if ([SaqmeApp.Package]::GetCurrentPackageFullName([ref]$len, $null) -ne 122) { return '' }   # 15700: no package
    $name = New-Object System.Text.StringBuilder ($len + 1)
    [void][SaqmeApp.Package]::GetCurrentPackageFullName([ref]$len, $name)
    return $name.ToString()
  } catch { return '' }
}

function Start-SyncSetup {
  if ($script:setupRun) { return }
  $pkg = Get-PackageContext
  if ($pkg) {
    $script:setupOutcome = @{ message = "Saqme was started from inside another app ($pkg), so Windows would keep what setup writes in that app's private copy of your settings."
                              next = 'Quit Saqme (tray icon > Quit), start it from the Start menu, then choose Set up sync again.' }
    Render; return
  }
  $setup = Find-SetupScript
  if (-not $setup) {
    $script:setupOutcome = @{ message = 'The setup script is not installed next to the app.'; next = 'Run setup.cmd -Cloud from the folder you installed the app from.' }
    Render; return
  }
  if (-not (Test-Path -LiteralPath $syncDir)) { [void](New-Item -ItemType Directory -Path $syncDir -Force) }
  $result = Join-Path $syncDir 'setup-result.json'
  if (Test-Path -LiteralPath $result) { Remove-Item -LiteralPath $result -Force }
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$setup`"", '-FromApp', '-ResultFile', "`"$result`"", '-DataDir', "`"$DataDir`"")
  try { $p = Start-Process -FilePath $ps -ArgumentList $a -PassThru -ErrorAction Stop }
  catch { $script:setupOutcome = @{ message = "Setup could not start: $($_.Exception.Message)"; next = '' }; Render; return }
  $script:setupRun = @{ Proc = $p; Result = $result }
  $script:setupOutcome = $null
  Render
}
function Watch-SyncSetup {
  $r = $script:setupRun
  if (-not $r) { return }
  $res = $null
  if (Test-Path -LiteralPath $r.Result) { try { $res = ConvertFrom-JsonText (Read-TextFile $r.Result) } catch { $res = $null } }
  if (-not $res -and -not $r.Proc.HasExited) { return }   # still running
  $script:setupRun = $null
  if ($res -and $res['ok'] -and (Read-SyncConfigUi)) {
    if (-not $script:sync) { Start-SyncLoop }
    Request-Sync
    $script:view = 'pair'   # what comes next: the phone
    Show-Main
  } elseif ($res -and -not $res['ok']) {
    $script:setupOutcome = @{ message = [string]$res['message']; next = [string]$res['next'] }
  } else {
    $script:setupOutcome = @{ message = 'The setup window was closed before it finished.'; next = 'Nothing changed on this PC. You can run it again any time.' }
  }
  Render
}

function Disable-Sync {
  try { Remove-Item -LiteralPath $syncCfgFile -Force -ErrorAction Stop } catch {}
  Stop-SyncLoop
  if ((Read-ShareBindings $listsDir).Count) { Start-SyncLoop }   # lists shared with this PC keep syncing with their owners
  [void](Update-SyncIndicator -Force)
}

function Render-SyncSettings {
  $syncCfg = Read-SyncConfigUi
  Add-Heading 'Sync'
  if (-not $syncCfg) {
    if ($script:setupRun) {
      Add-CardRow (New-InfoRow 'Sync with your phone' 'Setting up...')
      Add-Footnote 'Follow the window that opened: a browser asks you to sign in to Cloudflare (or create a free account) and to click Allow. You can keep using the app meanwhile.'
    } else {
      Add-CardRow (New-InfoRow 'Sync with your phone' 'Off')
      Add-CardRow (New-ActionRow 'Set up sync' { Start-SyncSetup } -Help $script:SetupHelp)
      Add-Footnote 'Set it up once: your own free sync service, in your Cloudflare account. Your lists stay on this PC and are uploaded there.'
    }
    if ($script:setupOutcome) {
      Add-Footnote ((@('Sync was not set up.', $script:setupOutcome.message, $script:setupOutcome.next) | Where-Object { $_ }) -join ' ') $Red
    }
    # a device that already syncs: its pairing link connects this PC to the same sync service
    Add-Heading 'Already syncing on another device?'
    $box = New-Object System.Windows.Controls.TextBox
    Set-Name $box 'Pairing link' 'From a device that already syncs: its Pair phone page, Copy link'
    $script:pairBox = $box
    $box.Add_PreviewKeyDown({ param($s, $e) if ($e.Key -eq 'Return') {
        $e.Handled = $true
        $r = Connect-Sync $s.Text
        if ($r -eq 'ok') { [void]$w.Focus(); Render } elseif ($r -eq 'bad') { Set-BoxError $s } } })
    $go = New-TextButton 'Connect' {
      $r = Connect-Sync $script:pairBox.Text
      if ($r -eq 'ok') { Render } elseif ($r -eq 'bad') { Set-BoxError $script:pairBox }
    }
    Add-CardRow (New-InputRow $box 'Paste its pairing link' $go)
    Add-Footnote 'There: Pair phone, Copy link. It looks like https://...workers.dev/#pair=...'
    return
  }
  $srvHost = try { ([Uri][string]$syncCfg['url']).Host } catch { [string]$syncCfg['url'] }
  $wv = $(if ($script:sync -and $script:sync.WorkerVersion) { ", version $($script:sync.WorkerVersion)" } elseif ($script:sync -and $script:sync.WorkerApi) { ', an older version' } else { '' })
  Add-CardRow (New-InfoRow 'Status' (Get-SyncStatusLine) -Tip "Your sync service: $srvHost$wv")
  Add-CardRow (New-ActionRow 'Sync now' { Request-Sync; if ($script:sync) { $script:sync.Status = 'syncing' }; [void](Update-SyncIndicator -Force); Render })
  Add-CardRow (New-LinkRow 'Pair phone' '' 'pair' -Help 'QR code and pairing code for your phone (or another PC)')
  # (Turn off sync is under Advanced, at the bottom of the page)
  $n = @(Get-OpenConflictList).Count + @(Get-NoticeList).Count
  if ($n) { Add-CardRow (New-LinkRow 'Conflicts' "$n" 'conflicts' -Dot -Name "Conflicts, $n" -Help 'Changed on two devices at once: pick which version to keep') }
  Add-Footnote "Your sync service: $srvHost$wv."
}

function New-QrImage([string]$text) {
  $m = Get-QrMatrix $text 'M'
  $n = $m.Count; $q = 4; $size = $n + 2 * $q
  $px = New-Object byte[] ($size * $size)
  for ($i = 0; $i -lt $px.Length; $i++) { $px[$i] = 255 }
  for ($r = 0; $r -lt $n; $r++) { $row = $m[$r]; for ($c = 0; $c -lt $n; $c++) { if ($row[$c]) { $px[($r + $q) * $size + $c + $q] = 0 } } }
  $bmp = [System.Windows.Media.Imaging.BitmapSource]::Create($size, $size, 96, 96, [System.Windows.Media.PixelFormats]::Gray8, $null, $px, $size)
  $img = New-Object System.Windows.Controls.Image
  $img.Source = $bmp; $img.Width = 228; $img.Height = 228; $img.Stretch = 'Fill'; $img.SnapsToDevicePixels = $true
  [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($img, [System.Windows.Media.BitmapScalingMode]::NearestNeighbor)
  return $img
}

# A one-time pairing code for the phone app (the Worker's POST /api/pair/code). The app on an iPhone's Home
# Screen starts at the manifest's start_url with storage of its own, so it is paired by typing this code. It is
# fetched off the UI thread; the timer picks it up (Receive-PairCode) and the Pair phone view shows it.
$script:pairCode = $null; $script:pairReq = $null
function Request-PairCode($syncCfg) {
  if ($script:pairReq -or ($script:pairCode -and $script:pairCode.Until -gt (Get-Date))) { return }
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
    param($core, $url, $token)
    . $core
    try { $r = Invoke-SaqmeApi $url $token 'POST' @{} 8000; if ($r.Status -eq 200 -and $r.Data) { return [string]$r.Data['code'] } } catch {}
    return ''
  }).AddArgument((Join-Path $dir 'sync-core.ps1')).AddArgument(([string]$syncCfg['url']).TrimEnd('/') + '/api/pair/code').AddArgument([string]$syncCfg['token'])
  $script:pairReq = @{ Ps = $ps; Handle = $ps.BeginInvoke() }
}
function Receive-PairCode {
  $q = $script:pairReq
  if (-not $q -or -not $q.Handle.IsCompleted) { return }
  $code = ''
  try { $code = [string](@($q.Ps.EndInvoke($q.Handle)) | Select-Object -Last 1) } catch {}
  try { $q.Ps.Dispose() } catch {}
  $script:pairReq = $null
  # valid for 10 minutes: shown for 9; no code (offline, or a sync service from before codes): ask again in a minute
  $script:pairCode = @{ Code = $code; Until = (Get-Date).AddMinutes($(if ($code) { 9 } else { 1 })) }
  if ($script:view -eq 'pair') { Render }
}

function Render-PairView {
  [void]$list.Children.Add((New-SettingsHeader 'Pair phone'))
  $syncCfg = Read-SyncConfigUi
  if (-not $syncCfg) { Add-Note 'Sync is not set up on this PC yet (Settings > Sync & sharing).'; return }
  Request-PairCode $syncCfg
  $code = $(if ($script:pairCode -and $script:pairCode.Until -gt (Get-Date)) { $script:pairCode.Code } else { $null })
  $link = ([string]$syncCfg['url']).TrimEnd('/') + '/#pair=' + [string]$syncCfg['token']
  $frame = New-Object System.Windows.Controls.Border
  $frame.Background = $Paper; $frame.CornerRadius = New-Object System.Windows.CornerRadius($CardRadius); $frame.Padding = '8'
  $frame.HorizontalAlignment = 'Center'
  try { $frame.Child = New-QrImage $link } catch { $frame.Child = New-Text "Could not draw the QR code: $($_.Exception.Message)" $TypeSize.meta $Red }
  Add-Loose $frame
  # the steps on the phone, one short line each
  Add-Heading 'On the iPhone'
  $codeStep = $(if ($code) { 'Type the pairing code below' } elseif ($null -eq $code) { 'Type the code (it shows below)' } else { 'Paste the link below' })
  $steps = @('Scan the code with the Camera', 'Open the link in Safari', 'Share, then Add to Home Screen', 'Open Saqme from the Home Screen', $codeStep, 'In its Settings: Enable notifications')
  for ($k = 0; $k -lt $steps.Count; $k++) { Add-CardRow (New-InfoRow $steps[$k] -Lead "$($k + 1)" -Tip $steps[$k]) ($CardPad + 28) }
  if ($code) {
    Add-Heading 'Pairing code'
    $ct = New-Text $code 26 $Ink; $ct.FontWeight = 'SemiBold'; $ct.TextWrapping = 'NoWrap'; $ct.HorizontalAlignment = 'Center'; Set-Tabular $ct
    Set-Name $ct ('Pairing code ' + (($code -replace '-', '').ToCharArray() -join ' '))
    $r = New-Object System.Windows.Controls.Border; Set-RowBox $r $ct; $r.Padding = '8,10,8,10'
    Add-CardRow $r
    Add-Footnote 'It works once, for 10 minutes.'
  } elseif ($code -eq '') { Add-Footnote 'No pairing code from your sync service right now: Copy link, and send the link to the phone.' }
  Add-Heading 'Pairing link'
  $box = New-Object System.Windows.Controls.TextBox
  Set-Name $box 'Pairing link (keep it private)'
  $box.Text = $link; $box.IsReadOnly = $true
  $box.Add_GotKeyboardFocus({ param($s, $e) $s.SelectAll() })
  $copy = New-TextButton 'Copy link' { try { [System.Windows.Clipboard]::SetText($script:pairLink); Show-Toast 'Saqme To Do' 'Pairing link copied.' 'Saqme To Do' } catch {} }
  $script:pairLink = $link
  $row = New-InputRow $box '' $copy
  $box.Foreground = $Faint
  Add-CardRow $row
  Add-Footnote "The QR code and the link are the key to your lists: anyone who has them can read and change them. To revoke it, run setup again with $([char]0x2011)RotateToken and pair your devices again."
}

# ---------------------------------------------------------------- updates (Settings > Updates; docs/setup.md, "Updating")
# The app checks GitHub's newest release when it starts and about once a day, in the background. Installing it is
# desktop\update.ps1's job, hidden, in a process of its own that outlives this one: it downloads and checks the
# release, has it installed next to this version (with the user's own Worker updated first), restarts the app
# and goes back to this version if the new one does not come up. The widget starts it (Update now, or by itself
# when the app is idle) and shows what it says in <install>\update\status.json and result.json.
$script:upd = @{ Latest = $null; CheckedAt = [long]0; Error = ''; Checking = $null; Proc = $null; Watch = $false; Since = [long]0; Login = $null; LoginError = ''; Sig = ''; Tick = 0 }
$script:startedAt = Get-NowMs
$UpdateIdleMs = 10 * 60000
if (-not $SmokeTest) {
  try {
    Add-Type -Namespace SaqmeApp -Name Idle -ErrorAction Stop -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LastInput { public uint Size; public uint Time; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
public static long Ms() { LastInput i = new LastInput(); i.Size = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) return 0; return (long)unchecked((uint)Environment.TickCount - i.Time); }
'@
  } catch {}
}
# how long nobody touched the keyboard or mouse (0 when Windows does not say)
function Get-IdleMs { try { return [long][SaqmeApp.Idle]::Ms() } catch { return [long]0 } }

function Test-UpdateRunning {
  if ($SmokeTest) { return $false }   # (setup runs the self-check inside an update: that one is not this copy's)
  if ($script:upd.Proc -and -not $script:upd.Proc.HasExited) { return $true }
  $m = $null
  if ([System.Threading.Mutex]::TryOpenExisting('Local\SaqmeToDo.Update', [ref]$m)) { $m.Dispose(); return $true }
  return $false
}
function Start-UpdateCheck {
  if (-not $InstallRoot -or $script:upd.Checking) { return }
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
    param($core, $upd, $repo)
    . $core; . $upd
    try { return (Get-LatestRelease $repo) } catch { return @{ Ok = $false; Error = $_.Exception.Message } }
  }).AddArgument((Join-Path $dir 'sync-core.ps1')).AddArgument((Join-Path $dir 'update-core.ps1')).AddArgument($script:Release.Repo)
  $script:upd.Checking = @{ Ps = $ps; Handle = $ps.BeginInvoke() }
}
function Receive-UpdateCheck {
  $c = $script:upd.Checking
  if (-not $c -or -not $c.Handle.IsCompleted) { return }
  $r = $null
  try { $r = @($c.Ps.EndInvoke($c.Handle)) | Select-Object -Last 1 } catch {}
  try { $c.Ps.Dispose() } catch {}
  $script:upd.Checking = $null
  $script:upd.CheckedAt = Get-NowMs
  if ($r -and $r.Ok) { $script:upd.Latest = $r.Manifest; $script:upd.Error = '' }
  else { $script:upd.Error = $(if ($r -and $r.Error) { [string]$r.Error } else { 'The check did not finish.' }) }
}
# the newest release when it is newer than this version, else $null
function Get-AvailableUpdate {
  $m = $script:upd.Latest
  if ($m -and (Compare-SaqmeVersion $m.version $script:Release.Version) -gt 0) { return $m }
  return $null
}
# how the last update ended, when it still matters: this version installed (its Worker may still be pending), or
# a newer one that did not install (failed, or held for the Worker); a check that failed. Else $null
function Get-UpdateResult {
  $r = Read-UpdateFile $InstallRoot 'result.json'
  if (-not $r) { return $null }
  $v = [string]$r['version']
  if ($r['ok']) { if ($v -eq $script:Release.Version) { return $r } else { return $null } }
  if (-not $v -or (Compare-SaqmeVersion $v $script:Release.Version) -gt 0) { return $r }
  return $null
}
# -WorkerOnly: only the Worker part of the update already installed (after signing in to Cloudflare)
function Start-Update([switch]$WorkerOnly) {
  if (-not $InstallRoot -or (Test-UpdateRunning)) { return }
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$(Join-Path $dir 'update.ps1')`"", '-AppDir', "`"$InstallRoot`"", '-DataDir', "`"$DataDir`"")
  if (-not $w.IsVisible) { $a += '-Hidden' }   # (the new version starts in the tray as well)
  if ($WorkerOnly) { $a += '-WorkerOnly' }
  $script:upd.Since = Get-NowMs
  try { $script:upd.Proc = Start-Process -FilePath $ps -ArgumentList $a -WindowStyle Hidden -PassThru -ErrorAction Stop; $script:upd.Watch = $true }
  catch { $script:upd.Error = "The update could not start: $($_.Exception.Message)" }
  Render-IfSettings
}
# the Cloudflare sign-in an update needs: the browser opens (wrangler), the Worker part runs once it is done
function Start-CloudLogin {
  if (-not $InstallRoot -or $script:upd.Login) { return }
  $setup = Join-Path $dir 'setup.ps1'
  $res = Join-Path $InstallRoot 'update\login.json'
  Remove-Item -LiteralPath $res -Force -ErrorAction SilentlyContinue
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$setup`"", '-CloudLogin', '-Yes', '-DataDir', "`"$DataDir`"", '-ResultFile', "`"$res`"")
  try {
    $p = Start-Process -FilePath $ps -ArgumentList $a -WindowStyle Hidden -PassThru -ErrorAction Stop
    [void]$p.Handle   # (without it, ExitCode stays empty once the process is gone)
    $script:upd.Login = @{ Proc = $p; Result = $res }; $script:upd.LoginError = ''
  } catch { $script:upd.LoginError = "The sign-in could not start: $($_.Exception.Message)" }
  Render-IfSettings
}
function Watch-CloudLogin {
  $l = $script:upd.Login
  if (-not $l -or -not $l.Proc.HasExited) { return }
  $script:upd.Login = $null
  $r = $null
  if (Test-Path -LiteralPath $l.Result) { try { $r = ConvertFrom-JsonText (Read-TextFile $l.Result) } catch {} }
  if (($r -and $r['ok']) -or (-not $r -and $l.Proc.ExitCode -eq 0)) {
    # signed in: a held update installs now (with its Worker); an installed one gets its Worker
    $held = Get-UpdateResult
    if ($held -and -not $held['ok']) { Start-Update } else { Start-Update -WorkerOnly }
  } else {
    $script:upd.LoginError = $(if ($r -and $r['message']) { [string]$r['message'] } else { 'The sign-in did not finish. Try again; a browser window asks you to allow it.' })
  }
  Render-IfSettings
}
function Render-IfSettings {
  Update-VersionDisplay
  $typing = [System.Windows.Input.Keyboard]::FocusedElement -is [System.Windows.Controls.TextBox]
  if (@('settings', 'updates', 'about') -contains $script:view -and -not $typing) { Render }
}

# ---------------------------------------------------------------- the version: under every Settings view, in About, on the tray icon
function Get-VersionText { return "Saqme To Do $($script:Release.Version)" }
# when an update needs a look: what the version line adds (Dot: something to do or decide), else $null. Short: the
# value of the Updates row in Settings
function Get-UpdateBadge {
  if (-not $InstallRoot) { return $null }
  if (Test-UpdateRunning) { return @{ Text = 'Updating...'; Short = 'Updating...'; Dot = $false } }
  $res = Get-UpdateResult
  if ($res -and $res['needsLogin']) { return @{ Text = 'Sign in to Cloudflare to finish the update'; Short = 'Sign in needed'; Dot = $true } }
  $avail = Get-AvailableUpdate
  if ($avail) { return @{ Text = "Update available: $($avail.version)"; Short = "$($avail.version) available"; Dot = $true } }
  if ($res -and -not $res['ok'] -and $res['version']) { return @{ Text = "The update to $($res['version']) is waiting"; Short = 'Waiting'; Dot = $true } }
  return $null
}
# the Updates row in Settings when there is no badge: Text in words, Short for the row's value
function Get-UpdateSummary {
  if (-not $InstallRoot) { return @{ Text = 'This copy does not update itself'; Short = 'Off' } }
  if ($script:upd.Checking) { return @{ Text = 'Checking for updates...'; Short = 'Checking...' } }
  if ($script:upd.Error) { return @{ Text = 'Could not check for updates'; Short = "Couldn't check" } }
  if ($script:upd.CheckedAt) { return @{ Text = 'Up to date'; Short = 'Up to date' } }
  if ($script:cfg.autoUpdate -eq '1') { return @{ Text = 'Checked once a day, installed by itself when idle'; Short = 'Automatic' } }
  return @{ Text = 'Checked once a day'; Short = 'Manual' }
}

# the quiet line at the bottom of the Settings views, and the tray icon's tooltip. With a badge, the line is a link to Updates.
$script:versionShown = ''
function Update-VersionDisplay {
  $text = Get-VersionText
  $badge = Get-UpdateBadge
  if ($tray) {
    $tip = $text + $(if ($badge) { "`n" + $badge.Text } else { '' })
    $tray.Text = $(if ($tip.Length -gt 63) { $tip.Substring(0, 62) + [char]0x2026 } else { $tip })   # (NotifyIcon's limit)
  }
  $link = $badge -and $script:view -ne 'updates'
  $sig = "$text|$(if ($badge) { $badge.Text + $badge.Dot })|$link|$($script:themeName)"
  if ($sig -eq $script:versionShown -and $verBar.Child) { return }
  $script:versionShown = $sig
  $row = New-Object System.Windows.Controls.WrapPanel
  $v = New-Text $text $TypeSize.meta $Faint; Set-Tabular $v; [void]$row.Children.Add($v)
  if ($badge) {
    $more = New-Object System.Windows.Controls.StackPanel; $more.Orientation = 'Horizontal'; $more.Margin = '10,0,0,0'
    if ($badge.Dot) { $d = New-Dot; $d.VerticalAlignment = 'Center'; $d.Margin = '0,1,6,0'; [void]$more.Children.Add($d) }
    $bt = New-Text $badge.Text $TypeSize.meta $(if ($link) { $Accent } else { $Ink }); Set-Tabular $bt; [void]$more.Children.Add($bt)
    [void]$row.Children.Add($more)
  }
  if ($link) {
    $b = New-Control 'link' "$text. $($badge.Text)" 'Opens Settings, Updates' { param($s, $e) Show-View 'updates' }
    [System.Windows.Automation.AutomationProperties]::SetAutomationId($b, 'version')
    $b.Child = $row; $b.Tag = 'updates'; $b.Cursor = 'Hand'; $b.Background = $Clear; $b.Padding = '6,3,6,3'; $b.Margin = "$($CardPad - 6),0,0,0"; $b.HorizontalAlignment = 'Left'
    $b.CornerRadius = New-Object System.Windows.CornerRadius($Tokens.Radius.control); $b.ToolTip = 'Open Updates'
    $b.Add_MouseEnter({ param($s, $e) $s.Background = $Hover })
    $b.Add_MouseLeave({ param($s, $e) $s.Background = $Clear })
    $b.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Show-View 'updates' })
    $verBar.Child = $b
  } else { $row.Margin = "$CardPad,3,$CardPad,3"; $verBar.Child = $row }
}
# the timer, every few seconds: the daily check, an idle update, what a running one says
function Step-Updates {
  if (-not $InstallRoot -or $SmokeTest) { return }
  $now = Get-NowMs
  Receive-UpdateCheck
  if ($script:upd.Login) { Watch-CloudLogin }
  $running = Test-UpdateRunning
  if ($script:upd.Watch -and -not $running) {
    # an update this app started ended without restarting it: say how (a Worker-only one, a failure, a hold)
    $script:upd.Watch = $false; $script:upd.Proc = $null
    $r = Get-UpdateResult
    if ($r -and $r['message'] -and [long]$r['at'] -ge $script:upd.Since) { Show-Notice ([string]$r['message']) }
  }
  # checks: two minutes after the start, then once a day (after a failed check: every 6 hours)
  $due = $(if (-not $script:upd.CheckedAt) { $script:startedAt + 120000 } elseif ($script:upd.Error) { $script:upd.CheckedAt + 6 * 3600000 } else { $script:upd.CheckedAt + 24 * 3600000 })
  if (-not $running -and -not $script:upd.Checking -and $now -ge $due) { Start-UpdateCheck }
  # Updated to X: once, when the window is up
  $res = Get-UpdateResult
  if ($w.IsVisible -and $res -and $res['ok'] -and $script:cfg.updatedSeen -ne $script:Release.Version) {
    $script:cfg.updatedSeen = $script:Release.Version; Save-Settings
    Show-Notice ([string]$res['message'])
  }
  # by itself: when the app is idle (window hidden, or nobody at the keyboard for 10 minutes), never mid-edit, and
  # not again soon after one that did not work (12 hours; 6 when it waits for the Worker)
  if ($script:cfg.autoUpdate -eq '1' -and -not $running -and -not $script:upd.Login -and -not $script:setupRun) {
    $busy = $script:editItem -or $script:tabEditing -or $script:notesBox -or $script:drag -or (Test-PopupOpen) -or $script:saveFailed
    $idle = (-not $w.IsVisible) -or ((Get-IdleMs) -ge $UpdateIdleMs)
    if (-not $busy -and $idle) {
      $wait = $(if ($res -and -not $res['ok'] -and $res['at']) { [long]$res['at'] + $(if ($res['held']) { 6 } else { 12 }) * 3600000 } else { 0 })
      if ((Get-AvailableUpdate) -and $now -ge $wait) { Start-Update }
      elseif ($res -and $res['ok'] -and $res['worker'] -eq 'pending' -and -not $res['needsLogin'] -and $now -ge [long]$res['at'] + 12 * 3600000) { Start-Update -WorkerOnly }
    }
  }
  $st = Read-UpdateFile $InstallRoot 'status.json'
  $sig = "$running|$(if ($st) { $st['state'] })|$(if ($res) { $res['at'] })|$($script:upd.CheckedAt)|$([bool]$script:upd.Checking)|$([bool]$script:upd.Login)|$($script:upd.LoginError)"
  if ($sig -ne $script:upd.Sig) { $script:upd.Sig = $sig; Render-IfSettings }   # (also the version line and the tray tooltip)
}

function Render-UpdateSettings {
  $cur = $script:Release.Version
  Add-CardRow (New-InfoRow 'Version' $cur -Tip (Get-VersionText))
  if (-not $InstallRoot) {
    Add-Footnote 'This copy runs from a folder of its own, not an installed one, so it does not update itself. setup.cmd installs it.'
    Render-ServiceUpdate
    return
  }
  $running = Test-UpdateRunning
  $avail = Get-AvailableUpdate
  $res = Get-UpdateResult
  if ($running) {
    $st = Read-UpdateFile $InstallRoot 'status.json'
    $v = $(if ($st -and $st['version']) { [string]$st['version'] } elseif ($avail) { $avail.version } else { '' })
    $what = $(switch ($(if ($st) { [string]$st['state'] } else { '' })) {
      'checking' { 'Checking...' }
      'downloading' { "Downloading $v..." }
      'installing' { "Installing $v..." }
      'worker' { 'Updating your sync service...' }
      'restarting' { 'Restarting...' }
      default { 'Updating...' } })
    Add-CardRow (New-InfoRow 'Status' $what -LongValue -Tip $what)
    Add-Footnote 'Saqme restarts by itself when it is done; your lists stay as they are.'
  } elseif ($avail) {
    Add-CardRow (New-InfoRow 'Available' $avail.version -Dot)
    Add-CardRow (New-ActionRow 'Update now' { Start-Update } -Name "Update now to $($avail.version)" -Help 'Saqme restarts by itself; your lists stay as they are')
    Add-Footnote "You have $cur. It takes a minute; Saqme restarts by itself and your lists stay as they are."
  } else {
    $state = $(if ($script:upd.Checking) { 'Checking...' } elseif ($script:upd.Error) { "Couldn't check" } elseif ($script:upd.CheckedAt) { 'Up to date' } else { 'Not checked yet' })
    Add-CardRow (New-InfoRow 'Status' $state)
    Add-CardRow (New-ActionRow 'Check now' { Start-UpdateCheck; Render } -Name 'Check for updates now')
    Add-Footnote $(if ($script:upd.Error) { [string]$script:upd.Error } elseif ($script:upd.CheckedAt) { "Checked at $(Format-Ms $script:upd.CheckedAt 'H:mm'), then again once a day." } else { 'Checked shortly after the start, then once a day.' })
  }
  # how the last one ended, when there is something to do about it
  if ($script:upd.Login) {
    Add-CardRow (New-InfoRow 'Signing in to Cloudflare...')
    Add-Footnote 'Allow it in the browser window that opened; the update finishes by itself afterwards.'
  } elseif (-not $running -and $res -and ($res['needsLogin'] -or -not $res['ok'] -or $res['worker'] -eq 'pending')) {
    $hint = (([string]$res['message']), ([string]$res['next']), $script:upd.LoginError | Where-Object { $_ }) -join ' '
    if ($res['needsLogin']) {
      Add-CardRow (New-ActionRow 'Sign in to Cloudflare' { Start-CloudLogin } -Help 'Opens the browser; the update finishes by itself afterwards')
    } elseif ($res['ok']) {
      Add-CardRow (New-InfoRow 'Your sync service' 'Not updated yet')
      Add-CardRow (New-ActionRow 'Try again' { Start-Update -WorkerOnly } -Name 'Try updating your sync service again')
    } elseif ($res['version']) {
      Add-CardRow (New-InfoRow "Update to $($res['version'])" $(if ($res['held']) { 'Waiting' } else { "Didn't install" }) -Dot)
      Add-CardRow (New-ActionRow 'Try again' { Start-Update } -Name "Try the update to $($res['version']) again")
    } else {
      Add-CardRow (New-InfoRow 'Checking for updates' "Couldn't check")
    }
    if ($hint) { Add-Footnote $hint }
  }
  Close-Card
  Add-CardRow (New-SwitchRow 'Install updates automatically' ($script:cfg.autoUpdate -eq '1') {
    param($on)
    $script:cfg.autoUpdate = $(if ($on) { '1' } else { '0' }); Save-Settings
    Render
  } 'When the app is idle. It restarts by itself; your lists stay as they are.')
  Add-Footnote 'When the app is idle. It restarts by itself; your lists stay as they are.'
  Render-ServiceUpdate
}

# Updates > Your sync service: with a Cloudflare API token it updates itself, also while this PC is off
# (worker/src/selfupdate.js; docs/sync.md, "The sync service updates itself"). What it says comes from the Worker
# (GET /api/update, off the UI thread: Start-OwnApi), asked when the page opens, then every minute, every few seconds
# while it updates. The token goes to the Worker, which checks it with Cloudflare and keeps it; this PC keeps nothing.
$script:svc = @{ Status = $null; Error = ''; Msg = ''; Done = ''; Busy = $false; Asking = $false; At = 0; Box = $null }
function Step-ServiceStatus {
  $sv = $script:svc
  if ($sv.Asking -or -not (Read-SyncConfigUi)) { return }
  if ($script:sync -and $script:sync.WorkerApi -and $script:sync.WorkerApi -lt $script:SelfUpdateApi) { return }
  $wait = $(if ($sv.Status -and $sv.Status['running']) { 3000 } else { 60000 })
  if ((Get-NowMs) - $sv.At -lt $wait) { return }
  $sv.Asking = $true; $sv.At = Get-NowMs
  Start-OwnApi 'GET' 'update' $null {
    param($r)
    $sv = $script:svc; $sv.Asking = $false
    if ($r.Status -eq 200 -and $r.Data) { $sv.Status = $r.Data; $sv.Error = '' } else { $sv.Error = Get-ApiError $r }
    if ($script:view -eq 'updates') { Render }
  }
}
# a change: the token, the switch, Update now. $done: what to say when it worked
function Send-ServiceUpdate([string]$path, $body, [string]$done = '') {
  $sv = $script:svc
  $sv.Busy = $true; $sv.Msg = ''; $sv.Done = $done; Render
  Start-OwnApi 'POST' $path $body {
    param($r)
    $sv = $script:svc; $sv.Busy = $false; $sv.At = Get-NowMs
    if ($r.Status -eq 200 -and $r.Data) {
      $sv.Status = $r.Data; $sv.Msg = ''
      if ($sv.Box) { $sv.Box.Text = '' }
      if ($sv.Done) { Show-Notice $sv.Done }
    } else { $sv.Msg = Get-ApiError $r }
    if ($script:view -eq 'updates') { Render }
  }
}
function Save-ServiceToken {
  $t = ([string]$script:svc.Box.Text).Trim()
  if (-not $t) { Set-BoxError $script:svc.Box; return }
  Send-ServiceUpdate 'update/token' @{ token = $t } 'Your sync service updates itself from now on.'
}
function Render-ServiceUpdate {
  if (-not (Read-SyncConfigUi)) { return }
  $sv = $script:svc; $s = $sv.Status
  Add-Heading 'Your sync service'
  $wv = $(if ($script:sync -and $script:sync.WorkerVersion) { [string]$script:sync.WorkerVersion } else { '' })
  if ($script:sync -and $script:sync.WorkerApi -and $script:sync.WorkerApi -lt $script:SelfUpdateApi) {
    Add-CardRow (New-InfoRow 'Version' $(if ($wv) { $wv } else { 'An older one' }))
    Add-Footnote 'It updates with this app (above). From its next update on, it can also update itself.'
    return
  }
  if (-not $s) {
    Add-CardRow (New-InfoRow 'Version' $wv)
    Add-Footnote $(if ($sv.Error) { "Could not ask your sync service: $($sv.Error)" } else { 'Asking your sync service...' }) $(if ($sv.Error) { $Red } else { $Faint })
    return
  }
  Add-CardRow (New-InfoRow 'Version' ([string]$s['version']))
  if (-not $s['knowsItself']) {
    Add-Footnote 'It updates with this app (above). Once this app has updated it, it can also update itself (it then knows its Cloudflare account).'
    return
  }
  if (-not $s['token']) {
    # making the token is the one step only the user can do: Cloudflare's page, filled in; then paste it here
    Add-CardRow (New-ActionRow 'Open Cloudflare''s token page' { try { Start-Process ([string]$script:svc.Status['tokenUrl']) } catch {} } -Help 'In the browser, filled in already: Workers Scripts, Edit, on your account only')
    $box = New-Object System.Windows.Controls.TextBox
    Set-Name $box 'Cloudflare API token' 'The token Cloudflare showed after Create Token'
    $sv.Box = $box
    $box.Add_PreviewKeyDown({ param($s, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; Save-ServiceToken } })
    Add-CardRow (New-InputRow $box 'Paste the token' (New-TextButton 'Save' { Save-ServiceToken }))
    if ($sv.Busy) { Add-Footnote 'Checking it with Cloudflare...' }
    elseif ($sv.Msg) { Add-Footnote $sv.Msg $Red }
    Add-Footnote ('Let it update itself: it then installs new versions by itself, from this project''s releases on GitHub, also when this PC is off. ' +
      'It needs a token from Cloudflare that may change the Workers of your account, and nothing else: open the page above (signed in), click Continue to summary and Create Token, copy the token and paste it here. ' +
      '(No permission shown on that page? Create Custom Token; Permissions: Account, Workers Scripts, Edit; Account Resources: Include, your account.)')
    return
  }
  $steps = @{ checking = 'Checking...'; downloading = 'Downloading...'; uploading = 'Uploading...'; switching = 'Switching over...' }
  $run = [string]$s['running']
  $newer = $(if (-not $run -and $s['latest'] -and [string]$s['latest'] -ne [string]$s['version']) { [string]$s['latest'] } else { '' })
  $state = $(if ($run) { $(if ($steps[$run]) { $steps[$run] } else { 'Updating...' }) } elseif ($newer) { "$newer available" } elseif ($s['checkedAt']) { 'Up to date' } else { 'Not checked yet' })
  Add-CardRow (New-InfoRow 'Status' $state -Dot:([bool]$newer) -LongValue -Tip $state)
  Add-CardRow (New-ActionRow 'Update now' { Send-ServiceUpdate 'update/now' @{} 'Your sync service is looking for a new version.' } -Name 'Update your sync service now' -Help 'Looks for a new version now and installs it')
  Add-CardRow (New-SwitchRow 'Update by itself' ([bool]$s['auto']) { param($on) Send-ServiceUpdate 'update/auto' @{ on = [bool]$on } } 'Looks every 6 hours and installs a new version. Off: only with Update now.')
  $last = $(if (-not $run -and $s['last']) { $s['last'] } else { $null })
  if ($sv.Msg) { Add-Footnote $sv.Msg $Red }
  elseif ($last -and -not $last['ok']) { Add-Footnote ([string]$last['message']) $Red }
  else {
    $when = $(if ($s['checkedAt']) { "Checked at $(Format-Ms ([long]$s['checkedAt']) 'H:mm'); " } else { '' })
    Add-Footnote ("$(if ($last) { "$($last['message']) " })$when$(if ($s['auto']) { 'it looks every 6 hours by itself.' } else { 'it looks only with Update now.' })")
  }
  Add-CardRow (New-ActionRow 'Remove the token' {
      $r = [System.Windows.MessageBox]::Show($w, "Remove the token?`n`nYour sync service then stops updating itself; this app updates it again, as before.", 'Saqme To Do', 'YesNo', 'Question')
      if ("$r" -eq 'Yes') { Send-ServiceUpdate 'update/token' @{ token = '' } 'The token is removed.' } } -Danger -Help 'It stops updating itself; this app updates it again')
  $lines = @(@($s['log']) | Where-Object { $_ } | Select-Object -Last 5 | ForEach-Object { "$(Format-Ms ([long]$_['at']) 'd MMM H:mm')  $($_['text'])" })
  Add-Footnote ((@("The token is kept by your sync service on Cloudflare, not on this PC; it can change the Workers of your account and nothing else.") + $(if ($lines.Count) { @('What it did:') + $lines } else { @() })) -join "`n")
}

# ---------------------------------------------------------------- sharing a list (the owner's side)
# A view like Pair phone: invite someone with a one-time link (and its QR code), see who has the list, change
# their access, revoke them, cancel an invite. The calls to this PC's own sync service run off the UI thread
# (Start-OwnApi); the timer hands their answers back (Receive-OwnApi). See worker/src/shares.js.
$script:apiReqs = New-Object System.Collections.ArrayList
$script:shareView = $null
function Start-OwnApi([string]$method, [string]$path, $body, [scriptblock]$done) {
  $cfg = Read-SyncConfigUi
  if (-not $cfg) { & $done @{ Status = 0; Data = @{ error = $script:ShareNeedsSync } }; return }
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
    param($core, $url, $token, $method, $body)
    . $core
    try { return (Invoke-SaqmeApi $url $token $method $body 15000) } catch { return @{ Status = 0; Data = @{ error = ($_.Exception.Message -replace '^offline: ', '') } } }
  }).AddArgument((Join-Path $dir 'sync-core.ps1')).AddArgument(([string]$cfg['url']).TrimEnd('/') + '/api/' + $path).AddArgument([string]$cfg['token']).AddArgument($method).AddArgument($body)
  [void]$script:apiReqs.Add(@{ Ps = $ps; Handle = $ps.BeginInvoke(); Done = $done })
}
function Receive-OwnApi {
  foreach ($q in @($script:apiReqs)) {
    if (-not $q.Handle.IsCompleted) { continue }
    $r = $null
    try { $r = @($q.Ps.EndInvoke($q.Handle)) | Select-Object -Last 1 } catch {}
    try { $q.Ps.Dispose() } catch {}
    $script:apiReqs.Remove($q)
    if (-not $r) { $r = @{ Status = 0; Data = @{ error = 'No answer from your sync service.' } } }
    try { & $q.Done $r } catch {}
  }
}
function Get-ApiError($r) {
  if ($r.Data -and $r.Data['error']) { return [string]$r.Data['error'] }
  return "Your sync service answered $($r.Status)."
}
function Format-Ms([long]$ms, [string]$fmt) { return [DateTimeOffset]::FromUnixTimeMilliseconds($ms).LocalDateTime.ToString($fmt, $CI) }

function Show-Share([string]$name) {
  Commit-Edit
  $pidOf = $(if ($script:sync -and $script:sync.ProjectIds) { $script:sync.ProjectIds[$name] } else { $null })
  $script:shareView = @{ Name = $name; ProjectId = $pidOf; People = $null; Error = ''; Invite = $null; Access = 'edit'; Alias = ''; Busy = $false }
  $script:view = 'share'
  Update-SharePeople
  Render
}
function Update-SharePeople {
  $sv = $script:shareView
  if (-not $sv -or -not $sv.ProjectId) { return }
  Start-OwnApi 'GET' "shares?project=$($sv.ProjectId)" $null {
    param($r)
    $sv = $script:shareView; if (-not $sv) { return }
    if ($r.Status -eq 200 -and $r.Data) { $sv.People = @($r.Data['shares']); $sv.Error = '' }
    else { if ($null -eq $sv.People) { $sv.People = @() }; $sv.Error = Get-ApiError $r }
    if ($script:view -eq 'share') { Render }
  }
}
# create an invite: its link is shown (and copied), with a QR code for a phone
function New-ShareInvite {
  $sv = $script:shareView
  $alias = ConvertTo-CleanText ([string]$sv.Alias)
  if (-not $alias) { $sv.Error = 'Give the person a name, so you can recognise them later (only you see it).'; Render; return }
  $sv.Busy = $true; $sv.Error = ''; Render
  Start-OwnApi 'POST' 'shares/invite' @{ projectId = $sv.ProjectId; alias = $alias; access = $sv.Access } {
    param($r)
    $sv = $script:shareView; if (-not $sv) { return }
    $sv.Busy = $false
    if ($r.Status -eq 200 -and $r.Data -and $r.Data['link']) {
      $sv.Invite = $r.Data; $sv.Alias = ''; $sv.Error = ''
      try { [System.Windows.Clipboard]::SetText([string]$r.Data['link']) } catch {}
      Request-Sync; Update-SharePeople
      Show-Notice "Invite link for $($r.Data['share']['alias']) copied. Send it to them yourself; it works once."
    } else { $sv.Error = Get-ApiError $r }
    if ($script:view -eq 'share') { Render }
  }
}
function Set-ShareAccess($person, [string]$access) {
  Start-OwnApi 'POST' 'shares/update' @{ id = [string]$person['id']; access = $access } {
    param($r)
    if ($r.Status -ne 200) { Show-Notice "Not changed: $(Get-ApiError $r)" }
    Update-SharePeople
  }
}
function Remove-ShareAccess($person) {
  $joined = [string]$person['state'] -eq 'joined'
  if ($joined) {
    $q = [System.Windows.MessageBox]::Show($w, "Revoke $($person['alias'])'s access?`n`nTheir key stops working now. The list stays on their device as their own copy, unshared.", 'Saqme To Do', 'YesNo', 'Question')
    if ("$q" -ne 'Yes') { return }
  }
  Start-OwnApi 'POST' 'shares/revoke' @{ id = [string]$person['id'] } {
    param($r)
    if ($r.Status -ne 200) { Show-Notice "Not done: $(Get-ApiError $r)" } else { Request-Sync }
    Update-SharePeople
  }
}

function Render-ShareView {
  $sv = $script:shareView
  [void]$list.Children.Add((New-SettingsHeader "Share '$($sv.Name)'"))
  if (-not (Read-SyncConfigUi)) { Add-Note $script:ShareNeedsSync; return }
  if ($script:sync -and $script:sync.WorkerApi -and $script:sync.WorkerApi -lt $script:SharingApi) { Add-Note $script:WorkerTooOld; return }
  if (-not $sv.ProjectId -and $script:sync -and $script:sync.ProjectIds) { $sv.ProjectId = $script:sync.ProjectIds[$sv.Name]; if ($sv.ProjectId) { Update-SharePeople } }
  if (-not $sv.ProjectId) { Add-Note 'This list is not on your sync service yet. It gets there within a few seconds; then open Share again.'; return }
  # who (a name only you see, to recognise them later), what they may do, and the link
  Add-Heading 'Invite someone'
  $box = New-Object System.Windows.Controls.TextBox
  Set-Name $box 'Their name' 'Only you see it: it is how you recognise them in this list later'
  $box.Text = [string]$sv.Alias; $box.MaxLength = 60
  $box.Add_TextChanged({ param($s, $e) $script:shareView.Alias = $s.Text })
  $box.Add_PreviewKeyDown({ param($s, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; New-ShareInvite } })
  Add-CardRow (New-InputRow $box 'Their name, e.g. Nuca')
  $seg = New-Segmented @(@('edit', $script:AccessText.edit[0], $script:AccessText.edit[1]), @('view', $script:AccessText.view[0], $script:AccessText.view[1])) $sv.Access { param($v) $script:shareView.Access = $v; Render } 'Access'
  Add-CardRow (New-InfoRow 'Access' '' $seg)
  Add-CardRow (New-ActionRow $(if ($sv.Busy) { 'Creating...' } else { 'Create invite link' }) { if (-not $script:shareView.Busy) { New-ShareInvite } } -Name 'Create invite link')
  Add-Footnote "Only you see their name. $($script:AccessText[$sv.Access][1]) They get a link that works once, for 24 hours; the list stays on your sync service, and they sync it from there with a key that reaches this list only."
  if ($sv.Error) { Add-Footnote $sv.Error $Red }
  if ($sv.Invite) {
    $inv = $sv.Invite; $link = [string]$inv['link']
    $frame = New-Object System.Windows.Controls.Border
    $frame.Background = $Paper; $frame.CornerRadius = New-Object System.Windows.CornerRadius($CardRadius); $frame.Padding = '8'; $frame.HorizontalAlignment = 'Center'
    try { $frame.Child = New-QrImage $link; $frame.Child.Width = 180; $frame.Child.Height = 180 } catch { $frame.Child = New-Text "Could not draw the QR code: $($_.Exception.Message)" $TypeSize.meta $Red }
    Add-Loose $frame
    $lb = New-Object System.Windows.Controls.TextBox
    Set-Name $lb 'Invite link'
    $lb.Text = $link; $lb.IsReadOnly = $true
    $lb.Add_GotKeyboardFocus({ param($s, $e) $s.SelectAll() })
    $cp = New-TextButton 'Copy' { param($x) try { [System.Windows.Clipboard]::SetText($x); Show-Notice 'Invite link copied.' } catch {} } $Accent $link
    Set-Name $cp 'Copy the invite link'
    $row = New-InputRow $lb '' $cp; $lb.Foreground = $Faint
    Add-CardRow $row
    Add-Footnote ("For $($inv['share']['alias']), $($script:AccessText[[string]$inv['share']['access']][0].ToLower()). It works once, until $(Format-Ms ([long]$inv['expiresAt']) 'ddd H:mm'). Send it to them yourself (a message, an email): whoever opens it first joins.") $Ink
  }
  # who has it: one row each, with their access; the row's menu changes it, or revokes it
  Add-Heading 'Shared with'
  if ($null -eq $sv.People) { Add-Note 'Loading...'; return }
  if (-not @($sv.People).Count) { Add-Note 'Nobody yet.'; return }
  foreach ($p in @($sv.People)) {
    $state = [string]$p['state']
    $access = $script:AccessText[[string]$p['access']][0]
    $when = $(switch ($state) {
      'joined' { "joined $(Format-Ms ([long]$p['joinedAt']) 'd MMM')" }
      'pending' { "invited $(Format-Ms ([long]$p['createdAt']) 'd MMM'), not joined yet" }
      default { 'invite expired, never used' } })
    $value = $(switch ($state) { 'joined' { $access } 'pending' { 'Invited' } default { 'Expired' } })
    $more = New-Text (G 0xE70D) 10 $TabInk; $more.FontFamily = $MDL2; $more.TextWrapping = 'NoWrap'; $more.Margin = '0,2,0,0'
    $g = New-RowGrid ([string]$p['alias']) $value (Hide-Decoration $more)
    $r = New-RowButton "$($p['alias']), $($access.ToLower()), $when" 'Opens a menu: change their access, or revoke it' $g { param($x) Show-PersonMenu $x.Row $x.P } @{ P = $p; Row = $null }
    $r.Tag.Arg.Row = $r; $r.ToolTip = "$access, $when"
    Add-CardRow $r
  }
}
# a person's menu in Share: their access (the current one in bold), then revoke / cancel the invite / remove it
function Show-PersonMenu($target, $p) {
  $m = New-Menu
  $state = [string]$p['state']
  if ($state -ne 'expired') {
    foreach ($v in @('edit', 'view')) {
      $cur = ([string]$p['access'] -eq $v)
      $mi = New-MenuItem $script:AccessText[$v][0]; $mi.ToolTip = $script:AccessText[$v][1]
      if ($cur) { $mi.FontWeight = 'SemiBold' }
      Set-Name $mi ("$($script:AccessText[$v][0]) for $($p['alias'])" + $(if ($cur) { ' (current)' } else { '' })) $script:AccessText[$v][1]
      $mi.Tag = @{ P = $p; V = $v }
      $mi.Add_Click({ param($s, $e) if ($s.Tag.V -ne [string]$s.Tag.P['access']) { Set-ShareAccess $s.Tag.P $s.Tag.V } })
      [void]$m.Items.Add($mi)
    }
    [void]$m.Items.Add((New-Separator))
  }
  $end = New-MenuItem $(switch ($state) { 'joined' { 'Revoke' } 'pending' { 'Cancel invite' } default { 'Remove' } }); $end.Tag = $p
  if ($state -eq 'joined') { $end.Foreground = $Red; $end.ToolTip = 'Their key stops working now; the list stays on their device as their own copy.' }
  $end.Add_Click({ param($s, $e) Remove-ShareAccess $s.Tag })
  [void]$m.Items.Add($end)
  $m.PlacementTarget = $target; $m.Placement = 'Bottom'; $m.IsOpen = $true
  $script:openPopup = $m
}

# ---------------------------------------------------------------- joining and leaving (the other side)
# Join: an invite link pasted in Settings > Sync & sharing, or handed over by a saqme://join link (the owner's join page).
# The app asks before it uses up the one-time code; the sync loop then claims it and binds a new file.
$script:joining = $null
function Start-JoinShare([string]$link) {
  $inv = Get-InviteLink $link
  if (-not $inv) { return 'bad' }
  $srvHost = ([Uri]$inv.Server).Host
  $r = [System.Windows.MessageBox]::Show($w, "Join a list shared from $srvHost?`n`nIt shows up here as a new tab and stays in step with theirs. What you change in it goes to $srvHost, which belongs to the person who shared it.", 'Saqme To Do', 'YesNo', 'Question')
  if ("$r" -ne 'Yes') { return 'cancel' }
  if (-not $script:sync) { Start-SyncLoop }
  $ticket = New-SaqmeId 8
  $script:joining = @{ Ticket = $ticket; Server = $srvHost; File = $null; Since = (Get-Date) }
  $script:sync.Queue.Enqueue(@{ kind = 'join'; link = $link.Trim($script:JsSpace); ticket = $ticket })
  Request-Sync
  Show-Notice "Joining the list shared from $srvHost..."
  return 'ok'
}
function Receive-JoinResult {
  $j = $script:joining
  if (-not $j -or -not $script:sync) { return }
  if (-not $j.File) {
    $res = $script:sync.JoinResults[$j.Ticket]
    if (-not $res) { return }
    $script:sync.JoinResults.Remove($j.Ticket)
    if (-not $res.Ok) { $script:joining = $null; Show-Notice "Could not join: $($res.Error)"; return }
    $j.File = $res.File; $j.Since = Get-Date
    Show-Notice "Joined '$($res.File)'. Getting it from $($j.Server)..."
  }
  if (Test-Path -LiteralPath (Proj-Path $j.File)) {
    $script:joining = $null; $script:view = 'list'; Switch-Project $j.File
    Show-Notice "Joined '$($j.File)', shared from $($j.Server)."
  } elseif (((Get-Date) - $j.Since).TotalSeconds -gt 120) { $script:joining = $null }
}
# a saqme:// link this app was started with, or that a second start handed over (.open-url in the data folder)
$openUrlFile = Join-Path $DataDir '.open-url'
function Receive-OpenUrl([string]$url = '') {
  if (-not $url -and (Test-Path -LiteralPath $openUrlFile)) {
    try { $url = [IO.File]::ReadAllText($openUrlFile).Trim(); Remove-Item -LiteralPath $openUrlFile -Force } catch { return }
  }
  if ($url -and (Get-InviteLink $url)) { Show-Main; [void](Start-JoinShare $url) }
}

# Leave: the file goes to lists\.trash and the list is no longer synced; nothing changes in the owner's list.
# The sync loop does it (it makes every change to the bindings); the tab goes at once.
function Leave-SharedList([string]$name) {
  $b = Get-ShareOf $name
  if (-not $b) { return }
  $r = [System.Windows.MessageBox]::Show($w, "Leave '$name'?`n`nIt goes from this PC (to lists\.trash). Nothing changes in the owner's list. To have it here again, you need a new invite.", 'Saqme To Do', 'YesNo', 'Question')
  if ("$r" -ne 'Yes') { return }
  Commit-Edit
  if (-not $script:sync) { Start-SyncLoop }
  $script:sync.Queue.Enqueue(@{ kind = 'leave'; share = [string]$b['id'] })
  Request-Sync
  $script:leaving[$name] = $true
  if ($script:proj -eq $name) { $n = @(Get-ProjectNames); Switch-Project $(if ($n.Count) { $n[0] } else { 'General' }) } else { Render }
  Show-Notice "Left '$name'."
}

# Settings > Sync & sharing > Shared lists: join one (paste the invite link), and those this PC has, each with Leave
function Render-SharedListSettings {
  Add-Heading 'Shared lists'
  $box = New-Object System.Windows.Controls.TextBox
  Set-Name $box 'Invite link' 'From the person who shares the list with you'
  $script:joinBox = $box
  $box.Add_PreviewKeyDown({ param($s, $e) if ($e.Key -eq 'Return') { $e.Handled = $true; $r = Start-JoinShare $s.Text; if ($r -eq 'ok') { $s.Text = '' } elseif ($r -eq 'bad') { Set-BoxError $s } } })
  $go = New-TextButton 'Join' { $r = Start-JoinShare $script:joinBox.Text; if ($r -eq 'ok') { $script:joinBox.Text = '' } elseif ($r -eq 'bad') { Set-BoxError $script:joinBox; Show-Notice 'That is not an invite link (it looks like https://.../join#code=...).' } }
  Add-CardRow (New-InputRow $box 'Paste an invite link to join' $go)
  # (Deletions paused, for this PC's own lists or a shared one, is further down the Sync & sharing page)
  foreach ($b in $script:bindings) {
    $st = $(if ($script:sync -and $script:sync.Shares) { @($script:sync.Shares | Where-Object { $_.Id -eq [string]$b['id'] })[0] } else { $null })
    $trouble = $st -and @('offline', 'error') -contains $st.State
    $access = $script:AccessText[[string]$b['access']][0]
    $about = "From $(Get-ShareHost $b), $($access.ToLower())$(if ($trouble) { ", $($st.Message)" })"
    $lv = New-TextButton 'Leave' { param($x) Leave-SharedList $x } $Red ([string]$b['file'])
    Set-Name $lv "Leave $([string]$b['file'])" "$about. It goes from this PC; nothing changes in the owner's list"
    Add-CardRow (New-InfoRow ([string]$b['file']) $(if ($trouble) { 'Not synced' } else { $access }) $lv -Dot:$trouble -Tip $about)
  }
  Add-Footnote 'Someone shared a list with you? Paste the invite link they sent; it works without sync of your own too. To share one of your own lists, right-click it in the lists menu (or the title) and choose Share.'
}

function Format-ConflictValue([string]$field, $v) {
  switch ($field) {
    'status' { return (St ([string]$v)).Name }
    'due' { if (-not $v) { return 'No deadline' }; return [string]$v['date'] + $(if ($v['time']) { ' ' + [string]$v['time'] } else { '' }) }
    'deleted' { if ($v) { return 'Deleted' } else { return 'Kept' } }
    default { if ([string]$v) { return [string]$v } else { return '(empty)' } }
  }
}

function Resolve-SyncConflict($c, [bool]$useOther) {
  if (-not $script:sync) { return }
  $script:resolving[$c.Id] = $true
  # (a shared list's conflict goes to its own engine: Share is its binding's id, '' for this PC's own server)
  if ($useOther) { $script:sync.Queue.Enqueue(@{ kind = 'task'; id = $c.Task; field = $c.Field; value = $c.Value; share = [string]$c.Share }) }
  $script:sync.Queue.Enqueue(@{ kind = 'conflict'; id = $c.Id; field = 'resolved'; value = $true; share = [string]$c.Share })
  Request-Sync
  [void](Update-SyncIndicator -Force)
  Render
}
function Dismiss-SyncNotice($n) {
  if (-not $script:sync) { return }
  $script:resolving[$n.Id] = $true
  $script:sync.Queue.Enqueue(@{ kind = 'notice'; share = [string]$n.Share; id = [string]$n.NoticeId })
  Request-Sync
  [void](Update-SyncIndicator -Force)
  Render
}

function Render-ConflictsView {
  [void]$list.Children.Add((New-SettingsHeader 'Conflicts'))
  $all = @(Get-OpenConflictList)
  $notices = @(Get-NoticeList)
  if (-not $all.Count -and -not $notices.Count) {
    Add-Note 'No conflicts. When the same thing is changed on two devices before they sync, the newest change wins and the other one is kept here for you to pick.'
    return
  }
  # a version on one line: the whole of it (a long note, say) is in the tooltip and read by screen readers
  $flat = { param([string]$t) ($t -replace '\s*\r?\n\s*', ' / ').Trim() }
  # changes made in a view-only shared list (by hand, an editor, an AI assistant): the owner's version stays, and
  # what was typed is kept here, not lost. One card per task: what is kept, then Copy and Dismiss
  $what = @{ text = 'Text'; status = 'Status'; due = 'Deadline'; notes = 'Notes'; deleted = 'Delete'; new = 'New task' }
  foreach ($n in $notices) {
    Add-Heading $(if ($n.Text) { $n.Text } else { '(untitled)' })
    $val = $(if ($n.Field -eq 'deleted') { 'Deleted' } elseif ($n.Field -eq 'new') { [string]$n.Value } else { Format-ConflictValue $n.Field $n.Value })
    Add-CardRow (New-InfoRow 'Your version' (& $flat $val) -LongValue -Tip $val)
    Add-CardRow (New-ActionRow 'Copy' { param($x) try { [System.Windows.Clipboard]::SetText($x); Show-Notice 'Copied.' } catch {} } $val -Name 'Copy your version' -Help $val)
    Add-CardRow (New-ActionRow 'Dismiss' { param($x) Dismiss-SyncNotice $x } $n)
    $why = $(if ($n.Reason -eq 'this shared list is view-only') { "'$($n.List)' is view-only for you, so the owner's version stays." } else { "The owner's server did not take it: $($n.Reason)." })
    Add-Footnote ("Not saved: " + [string]$what[$n.Field] + " in '$($n.List)'. " + $why)
  }
  # changed on two devices before they synced: the version that won (Now) and the other one, then the choice
  $names = @{ text = 'Text'; status = 'Status'; due = 'Deadline'; notes = 'Notes' }
  foreach ($c in $all) {
    Add-Heading $(if ($c.TaskText) { $c.TaskText } else { '(untitled)' })
    foreach ($pair in @(@('Now', $c.Current), @('Other version', $c.Value))) {
      $v = Format-ConflictValue $c.Field $pair[1]
      Add-CardRow (New-InfoRow $pair[0] (& $flat $v) -LongValue -Tip $v)
    }
    $useText = $(if ($c.Field -eq 'deleted') { if ($c.Value) { 'Delete it' } else { 'Restore it' } } else { 'Use other' })
    Add-CardRow (New-ActionRow 'Keep now' { param($x) Resolve-SyncConflict $x $false } $c -Name 'Keep the version you have now')
    Add-CardRow (New-ActionRow $useText { param($x) Resolve-SyncConflict $x $true } $c -Name $(if ($c.Field -eq 'deleted') { $useText } else { 'Use the other version' }))
    Add-Footnote $(if ($c.Field -eq 'deleted') { 'Deleted on one device, edited on another.' } else { "$([string]$names[$c.Field]) changed on two devices. The newest change is the one you have now." })
  }
}

# ---------------------------------------------------------------- keyboard
function Set-Sel($it, [switch]$Focus) {
  $script:sel = $it
  $first = $null; $selRow = $null
  # (only the rows whose state changes are touched: the one selected before and the new one; long lists stay quick)
  foreach ($row in $script:rows) {
    if (-not $first) { $first = $row }
    $isSel = ($null -ne $it -and $row.Tag -eq $it)
    if ($isSel -or $row.BorderBrush -eq $Accent) {
      Paint-TaskRow $row $isSel
      if ($script:HasA11y) { $row.IsSelected = $isSel }
      [System.Windows.Input.KeyboardNavigation]::SetIsTabStop($row, $isSel)
    }
    if ($isSel) { $row.BringIntoView(); $selRow = $row }
  }
  # one Tab stop for the list: the selected task, else the first one (the list stays reachable with Tab)
  $stop = $(if ($selRow) { $selRow } else { $first })
  if ($script:tabRow -and $script:tabRow -ne $stop) { [System.Windows.Input.KeyboardNavigation]::SetIsTabStop($script:tabRow, $false) }
  if ($stop) { [System.Windows.Input.KeyboardNavigation]::SetIsTabStop($stop, $true) }
  $script:tabRow = $stop
  # keyboard focus follows the selection (screen readers then read the task), unless someone is typing
  $f = [System.Windows.Input.Keyboard]::FocusedElement
  if ($selRow -and ($Focus -or $null -eq $f -or $f -eq $w -or (Is-TaskRow $f)) -and -not ($f -is [System.Windows.Controls.TextBox])) { [void]$selRow.Focus() }
}
function Sel-Row { foreach ($c in $script:rows) { if ($c.Tag -eq $script:sel) { return $c } }; return $null }

function Node-HasMore($it) {
  $i = $script:items.IndexOf($it)
  return ($it.Notes -or ($i -ge 0 -and (Subtree-End $i) -gt $i + 1))
}
$w.Add_PreviewKeyDown({
  param($s, $e)
  $mods = [System.Windows.Input.Keyboard]::Modifiers
  $ctrl  = ($mods -band [System.Windows.Input.ModifierKeys]::Control) -ne 0
  $shift = ($mods -band [System.Windows.Input.ModifierKeys]::Shift) -ne 0
  $key = $(if ($e.Key -eq 'System') { $e.SystemKey.ToString() } else { $e.Key.ToString() })
  $alt = $e.Key -eq 'System'

  # app-wide shortcuts (work even while typing)
  if ($ctrl -and $key -eq 'Tab') { $e.Handled = $true; Commit-Edit; Cycle-Project $(if ($shift) { -1 } else { 1 }); return }
  if ($ctrl -and $key -eq 'Next') { $e.Handled = $true; Commit-Edit; Cycle-Project 1; return }
  if ($ctrl -and $key -eq 'PageUp') { $e.Handled = $true; Commit-Edit; Cycle-Project -1; return }
  if ($ctrl -and $key -eq 'OemComma') { $e.Handled = $true; Toggle-Settings; return }
  if ($ctrl -and $key -eq 'N') { $e.Handled = $true; Commit-Edit; if ($script:view -ne 'list') { $script:view = 'list'; Render }; [void]$addBox.Focus(); return }

  $f = [System.Windows.Input.Keyboard]::FocusedElement
  # (Shift+F10 arrives as the System key)
  if ($f -eq $script:titleBtn -and (($key -eq 'F10' -and $shift) -or $key -eq 'Apps')) { $e.Handled = $true; Show-ListMenu $script:proj $true; return }
  if ($script:HasA11y -and $f -is [Saqme.AccessibleBorder] -and $f.Role -ne 'listitem' -and -not $ctrl -and -not $alt) {
    if ($key -eq 'Return' -or $key -eq 'Space') { return }   # the focused button's own action (its KeyDown)
    if ($f -eq $script:titleBtn -and ($key -eq 'Left' -or $key -eq 'Right')) {
      $e.Handled = $true; Commit-Edit; Cycle-Project $(if ($key -eq 'Left') { -1 } else { 1 }); return
    }
    if ($f -eq $script:titleBtn -and $key -eq 'Down') { $e.Handled = $true; Show-ListsMenu; return }
    if ($key -eq 'Tab') { return }
  }
  if ($key -eq 'Tab' -and -not $ctrl) { return }   # moves keyboard focus through the window (WPF)
  if ($f -is [System.Windows.Controls.TextBox]) {
    if ($f -eq $addBox -and $key -eq 'Up' -and $script:visible.Count) {
      $e.Handled = $true; [void]$w.Focus(); Set-Sel $script:visible[$script:visible.Count - 1]
    }
    return    # the task / notes / tab editors handle their own keys
  }

  if ($ctrl -and $key -eq 'Z') { $e.Handled = $true; Undo-Last; return }   # (text boxes keep their own Ctrl+Z)
  if ($script:view -ne 'list') {
    if ($key -eq 'Escape') { $e.Handled = $true; Go-Back }
    return
  }

  $vis = $script:visible
  if ($vis.Count -eq 0) { return }
  $i = $(if ($script:sel) { $vis.IndexOf($script:sel) } else { -1 })
  $sel = $script:sel

  # the task's menu from the keyboard, like a right-click: Shift+F10 or the Menu key
  if (($key -eq 'F10' -and $shift) -or $key -eq 'Apps') {
    if ($sel) { $e.Handled = $true; $r = Sel-Row; if ($r) { Show-RowMenu $r $sel } }
    return
  }
  if ($alt -and ($key -eq 'Up' -or $key -eq 'Down')) {
    $e.Handled = $true
    if ($sel -and (Node-Rank $sel) -eq 0 -and -not $script:readOnly) { Nudge-Task $sel $(if ($key -eq 'Up') { -1 } else { 1 }); Set-Sel $sel }
    return
  }
  if ($ctrl) {
    switch ($key) {
      'D' { if ($sel) { $e.Handled = $true; $r = Sel-Row; if ($r) { Show-DuePopup $sel $r } } }
      'I' { if ($sel) { $e.Handled = $true; Begin-Notes $sel } }
      'M' { if ($sel) { $e.Handled = $true; $r = Sel-Row; if ($r) { Show-RowMenu $r $sel } } }
    }
    return
  }
  switch ($key) {
    'Down'   { $e.Handled = $true; if ($i + 1 -lt $vis.Count) { Set-Sel $vis[$i + 1] } }
    'Up'     { $e.Handled = $true; if ($i -le 0) { Set-Sel $vis[0] } else { Set-Sel $vis[$i - 1] } }
    'Return' { $e.Handled = $true; if ($sel) { Edit-Item $sel } else { Set-Sel $vis[0] } }
    'Space'  { if ($sel -and -not $script:readOnly) { $e.Handled = $true; $sel.Mark = $(if ((Rank $sel.Mark) -eq 2) { ' ' } else { 'x' }); Save-Items; Render } }
    'Right'  { if ($sel -and (Node-HasMore $sel)) { $e.Handled = $true; $script:openState[(Open-Key $sel)] = '1'; Save-State; Render } }
    'Left'   {
      if ($sel) {
        $e.Handled = $true
        $k = Open-Key $sel
        $isOpen = $(if ($script:openState.ContainsKey($k)) { $script:openState[$k] -eq '1' } else { $vis.Count -gt $i + 1 -and $vis[$i + 1].Level -gt $sel.Level })
        if ((Node-HasMore $sel) -and $isOpen) { $script:openState[$k] = '0'; Save-State; Render }
        elseif ($sel.Level -gt 0) { for ($p = $i - 1; $p -ge 0; $p--) { if ($vis[$p].Level -lt $sel.Level) { Set-Sel $vis[$p]; break } } }
      }
    }
    'Escape' { $e.Handled = $true; Set-Sel $null }
  }
})
$w.Add_Activated({ if (-not [System.Windows.Input.Keyboard]::FocusedElement) { [void]$w.Focus() } })

# ---------------------------------------------------------------- reminders (Windows notifications)
#   timed deadlines: 15 min before + at the time;  date-only deadlines: one digest at notifyAt (10:00) for
#   everything due today or overdue.  Covers all projects.  Fires late if the PC was off at that moment.
$script:notified = @{}
foreach ($l in (Read-Lines $notifFile)) { if ($l) { $script:notified[$l] = $true } }
function Mark-Notified([string]$k) {
  $script:notified[$k] = $true
  $cut = (Get-Date).Date.AddDays(-7).ToString('yyyy-MM-dd')
  $keep = @($script:notified.Keys | Where-Object { $_.Substring(0, [Math]::Min(10, $_.Length)) -ge $cut })
  try { Write-Utf8 $notifFile (($keep -join "`n") + "`n") } catch {}
}
function Show-Toast([string]$title, [string]$body, [string]$attr) {
  if ($SmokeTest) { return }   # the installer's self-check must not pop anything up
  $esc = [System.Security.SecurityElement]
  if ($script:toastOk) {
    try {
      $xml = '<toast activationType="protocol" launch="saqme:open"><visual><binding template="ToastGeneric">' +
             "<text>$($esc::Escape($title))</text><text>$($esc::Escape($body))</text>" +
             "<text placement=`"attribution`">$($esc::Escape($attr))</text></binding></visual>" +
             '<actions><action content="Open Saqme" activationType="protocol" arguments="saqme:open"/></actions></toast>'
      $x = New-Object Windows.Data.Xml.Dom.XmlDocument
      $x.LoadXml($xml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show((New-Object Windows.UI.Notifications.ToastNotification $x))
      return
    } catch {}
  }
  try { $tray.ShowBalloonTip(8000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info) } catch {}
}
function Get-DueTasks {
  $res = New-Object System.Collections.ArrayList
  foreach ($p in @(Get-ProjectNames)) {
    foreach ($it in (Read-Items (Read-TextFile (Proj-Path $p)))) {
      if ($it.Kind -eq 'task' -and $it.Due -and $it.Text) {
        [void]$res.Add(@{ Id = $(if ($it.Id) { $it.Id } else { "$p|$($it.Text)" }); Text = $it.Text; Status = $it.Mark; Due = $it.Due; DueTime = $it.DueTime; Project = $p })
      }
    }
  }
  return ,$res
}
function Check-Reminders {
  $atStr = $(if ($script:cfg.notifyAt) { $script:cfg.notifyAt } else { '10:00' })
  foreach ($r in (Get-Reminders (Get-DueTasks) (Get-Date) $atStr $script:notified)) {
    Show-Toast $r.Title $r.Body $r.Sub
    foreach ($k in $r.Keys) { Mark-Notified $k }
  }
}

# ---------------------------------------------------------------- tray icon (X hides, tray > Quit exits)
$script:quitting = $false
$w.Add_Closing({ param($s, $e) if (-not $script:quitting) { $e.Cancel = $true; Commit-Edit; $w.Hide() } })
function Show-Main {
  Request-Sync
  $w.Show()
  if ($w.WindowState -eq 'Minimized') { $w.WindowState = 'Normal' }
  [void]$w.Activate()
}
function Quit-App {
  Commit-Edit
  if ($script:saveFailed) { Save-Items }
  if ($script:saveFailed) { Save-Recovery }   # still not written: keep a copy rather than lose the edits
  Stop-SyncLoop
  $script:quitting = $true
  try { $tray.Visible = $false; $tray.Dispose() } catch {}
  $w.Close()
  $w.Dispatcher.InvokeShutdown()
}
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text = Get-VersionText   # (with what an update needs, when it needs something: Update-VersionDisplay)
try {
  $src = [System.Drawing.Image]::FromFile($logoFile)
  $ib = New-Object System.Drawing.Bitmap 32, 32
  $ig = [System.Drawing.Graphics]::FromImage($ib)
  $ig.InterpolationMode = 'HighQualityBicubic'; $ig.SmoothingMode = 'HighQuality'
  $sc = [Math]::Min(30 / $src.Width, 30 / $src.Height); $iw = [int]($src.Width * $sc); $ih = [int]($src.Height * $sc)
  $ig.DrawImage($src, [int]((32 - $iw) / 2), [int]((32 - $ih) / 2), $iw, $ih); $src.Dispose()
  $tray.Icon = [System.Drawing.Icon]::FromHandle($ib.GetHicon())
} catch { $tray.Icon = [System.Drawing.SystemIcons]::Application }
$cms = New-Object System.Windows.Forms.ContextMenuStrip
$cms.ShowImageMargin = $false
$cms.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#' + $T.MenuBg.Substring(3))
$cms.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#' + $T.Ink.Substring(3))
$cms.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$miOpen = $cms.Items.Add('Open Saqme To Do'); $miOpen.Add_Click({ Show-Main })
[void]$cms.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miQuit = $cms.Items.Add('Quit'); $miQuit.Add_Click({ Quit-App })
$tray.ContextMenuStrip = $cms
$tray.Add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-Main } })
$tray.Visible = -not $SmokeTest

# ---------------------------------------------------------------- start
$w.Left = $wa.Right - $w.Width - 20; $w.Top = $wa.Top + 20
if (Test-Path $posFile) {
  try {
    $p = (Get-Content $posFile -Raw).Trim().Split(',')
    $l = [double]$p[0]; $t = [double]$p[1]
    if ($l -ge $wa.Left - 300 -and $l -le $wa.Right - 40 -and $t -ge $wa.Top - 10 -and $t -le $wa.Bottom - 40) { $w.Left = $l; $w.Top = $t }
  } catch {}
}
if ($w.Left + $w.Width -gt $wa.Right + 7) { $w.Left = $wa.Right + 7 - $w.Width }

$script:sizeDirty = $false
$w.Add_SizeChanged({
  $script:sizeDirty = $true
  if (($w.Width -lt $MetaBelowW) -ne $script:metaBelow) { Render }   # (the rows' deadlines move to or from under the text)
})

$names = @(Get-ProjectNames)
$start = $script:cfg.active
if ($names -notcontains $start) { $start = $names[0] }
Switch-Project $start

# live reload when files change on disk (e.g. an AI assistant edits a list or adds a project)
$script:tick = 0
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(800)
$timer.Add_Tick({
  if ($showEvt.WaitOne(0)) { Show-Main; Receive-OpenUrl }
  if ($quitEvt.WaitOne(0)) { Quit-App; return }
  if ($script:pendingUrl -and $w.IsVisible) { $u = $script:pendingUrl; $script:pendingUrl = $null; Receive-OpenUrl $u }
  if ($script:setupRun) { Watch-SyncSetup }
  if (($script:upd.Tick++) % 4 -eq 0) { Step-Updates }
  if ($script:pairReq) { Receive-PairCode }
  elseif ($script:view -eq 'pair' -and $script:pairCode -and $script:pairCode.Until -lt (Get-Date)) { Render }   # a fresh code
  if ($script:apiReqs.Count) { Receive-OwnApi }
  if ($script:view -eq 'updates' -and -not $SmokeTest) { Step-ServiceStatus }
  if ($script:joining) { Receive-JoinResult }
  while ($script:sync -and $script:sync.Rewritten -and $script:sync.Rewritten.Count) {
    # a list's file was gone (not deleted here): the sync wrote it again from the last sync instead of deleting it
    $x = $script:sync.Rewritten.Dequeue()
    [void]$script:rewritten.Insert(0, @{ Name = [string]$x.Name; Count = [int]$x.Count; At = (Get-Date) })
    while ($script:rewritten.Count -gt 10) { $script:rewritten.RemoveAt($script:rewritten.Count - 1) }
    $msg = "'$($x.Name)' was missing from the lists folder, so Saqme wrote it again from the last sync ($($x.Count) $(if ($x.Count -eq 1) { 'task' } else { 'tasks' })). Nothing was deleted."
    Show-Notice $msg; Show-Toast 'Saqme To Do' $msg $x.Name; Render
  }
  while ($script:sync -and $script:sync.Ended.Count) {
    # its owner stopped sharing a list with this PC: it stays, as one of this PC's own lists
    $x = $script:sync.Ended.Dequeue()
    $msg = $(if ($x.Kept) { "'$($x.Name)' is no longer shared with you: its owner stopped sharing it. It stays here as your own list." } else { "'$($x.Name)' is no longer shared with you: its owner stopped sharing it." })
    Show-Notice $msg; Show-Toast 'Saqme To Do' $msg $x.Name; Render
  }
  if (-not $script:sync -and $script:tick % 10 -eq 5 -and (((Test-Path -LiteralPath $syncCfgFile) -and (Read-SyncConfigUi)) -or (Read-ShareBindings $listsDir).Count)) {
    Start-SyncLoop   # setup (-CloudOnly) just connected this PC, or a list shared with it is there
  }
  if ($script:sync) {
    if ($script:sync.Plan) { Apply-SyncPlan }
    $typing = [System.Windows.Input.Keyboard]::FocusedElement -is [System.Windows.Controls.TextBox]
    # (the views that show how sync stands; the others stay as they are, with keyboard focus where it was)
    if ((Update-SyncIndicator) -and @('settings', 'sync', 'conflicts', 'share', 'pair', 'trash') -contains $script:view -and -not $typing) { Render }
  }
  if ($script:posDirty -and $w.IsLoaded -and -not $script:maxed -and $w.WindowState -eq 'Normal') {
    $script:posDirty = $false
    try { Set-Content -Path $posFile -Value ("{0},{1}" -f [int]$w.Left, [int]$w.Top) } catch {}
  }
  if ($script:sizeDirty -and $w.IsLoaded -and -not $script:maxed -and $w.WindowState -eq 'Normal') {
    $script:sizeDirty = $false
    $script:cfg.width = [string][int]$w.ActualWidth
    if ($w.SizeToContent -eq 'Manual') { $script:cfg.height = [string][int]$w.ActualHeight }
    Save-Settings
  }
  if ($script:editItem -or $script:tabEditing -or $script:notesBox -or $script:drag -or (Test-PopupOpen)) { return }
  if ($script:listBusy) { if (Use-Loaded (Load-Items -Settle)) { Render }; return }   # waiting for another program
  if ($script:saveFailed) { Save-Items; return }   # keep trying; never reload over unsaved changes
  if (-not (Test-Path -LiteralPath $script:todo)) {
    $n = @(Get-ProjectNames)
    if ($n.Count) { Switch-Project $n[0] } else { Switch-Project 'General' }
    return
  }
  try {
    $lw = (Get-Item -LiteralPath $script:todo -ErrorAction Stop).LastWriteTimeUtc
    if ($lw -ne $script:lastWrite) {
      # changed by another program: read it once it has settled (it may still be writing)
      $new = Load-Items -Settle
      if ($null -ne $new) { [void](Use-Loaded $new); Render }
      return
    }
  } catch {}
  $script:tick++
  if ($script:tick % 12 -eq 0 -and $script:cfg.theme -eq 'auto' -and (Resolve-Theme 'auto') -ne $script:themeName) { Apply-Theme (Resolve-Theme 'auto') }
  if ($script:tick -eq 6 -or $script:tick % 37 -eq 0) { try { Check-Reminders } catch {} }
  if ($script:tick % 3 -eq 0) { if ((Tab-Signature) -ne $script:tabSig) { Render-Tabs } }
  # midnight: refresh deadline labels (Today / Tomorrow / overdue)
  if ($script:tick % 75 -eq 0) { $d = (Get-Date).Date; if ($d -ne $script:lastDay) { $script:lastDay = $d; Render } }
})
$script:lastDay = (Get-Date).Date
if ((Read-SyncConfigUi) -or (Read-ShareBindings $listsDir).Count) { Start-SyncLoop }   # (lists shared with this PC sync without sync of its own too)

if ($SmokeTest) {
  # headless self-check used by the installer and the tests: builds every view and runs the main editing
  # paths without showing a window or a tray icon, then exits (0 = fine)
  $code = 0
  try {
    if ($env:SAQME_SMOKE_SHOTS) {
      # the untouched list first (README screenshots), before the self-check adds its own tasks
      $w.Height = 600
      foreach ($theme in 'dark', 'light') {
        Apply-Theme $theme
        $sz = New-Object System.Windows.Size($w.Width, $w.Height)
        $outer.Measure($sz); $outer.Arrange((New-Object System.Windows.Rect(0, 0, $w.Width, $w.Height))); $outer.UpdateLayout()
        $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap([int]($w.Width * 2), [int]($w.Height * 2), 192, 192, [System.Windows.Media.PixelFormats]::Pbgra32)
        $rtb.Render($outer)
        $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
        $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
        $fs = [IO.File]::Create((Join-Path $env:SAQME_SMOKE_SHOTS "showcase-$theme.png")); try { $enc.Save($fs) } finally { $fs.Close() }
      }
    }
    Add-Task 'smoke task one'
    $first = @($script:items | Where-Object { $_.Kind -eq 'task' -and $_.Text -eq 'smoke task one' })[0]
    if (-not $first.Id) { throw 'new task has no id' }
    Add-Subtask $first; $script:editBox.Text = 'smoke subtask'; Commit-Edit
    $first.Due = (Get-Date).ToString('yyyy-MM-dd'); $first.DueTime = '9:00'; $first.Notes = 'see https://example.com'; Save-Items; Render
    Show-DuePopup $first $list
    $script:openPopup.IsOpen = $false
    $script:openState[(Open-Key $first)] = '1'; Render
    $text = [IO.File]::ReadAllText($script:todo)
    if ($text -notmatch ('- \[ \] smoke task one due:\d{4}-\d{2}-\d{2}T9:00 \^' + $first.Id)) { throw "unexpected file content: $text" }
    foreach ($v in @('settings') + @($script:SettingsPages.Keys) + @('keys', 'pair', 'conflicts', 'trash', 'list')) { $script:view = $v; Render }
    # Settings: every setting and action is on its page, each page opens from Settings the way Enter or a screen
    # reader's Invoke opens it, and Back (the header, Esc) goes up one level. Nothing here is switched or pressed
    # (Start with Windows is the real Startup folder's shortcut). The settings file keeps its keys.
    $find = { param($root, [string]$k) foreach ($c in (Get-Controls $root)) { if ((Get-FocusKey $c) -eq $k) { return $c } }; return $null }
    $activate = { param($el) if ($script:HasA11y) { $el.RaiseActivate() } elseif ($el.Tag -is [hashtable]) { & $el.Tag.Do $el.Tag.Arg } else { Show-View $el.Tag } }
    $mustHave = [ordered]@{
      general       = @('Dark', 'Light', 'Auto', 'Start with Windows', 'open-keys')
      notifications = @('Daily summary time', 'Send a test notification')
      sync          = @('Set up sync', 'Pairing link', 'Connect', 'Invite link', 'Join')
      yourlists     = @('Copy instructions for your AI', 'Save the instructions for your AI as a file', 'Open the lists folder', 'open-trash')
      updates       = @('back')
      about         = @('Open the data folder')
    }
    if ((@($mustHave.Keys) -join ',') -ne (@($script:SettingsPages.Keys) -join ',')) { throw 'a Settings page without checks' }
    foreach ($pg in $mustHave.Keys) {
      Show-View 'settings'
      $row = & $find $list "open-$pg"
      if (-not $row) { throw "Settings has no row for $pg" }
      & $activate $row
      if ($script:view -ne $pg) { throw "the $pg row opened '$($script:view)'" }
      foreach ($k in $mustHave[$pg]) {
        $c = & $find $list $k
        if (-not $c -or -not $c.IsEnabled -or ($script:HasA11y -and -not $c.Focusable)) { throw "Settings > $($script:SettingsPages[$pg]): '$k' missing or out of keyboard reach" }
      }
      Go-Back
      if ($script:view -ne 'settings') { throw "Back from $pg went to '$($script:view)'" }
    }
    # Use with AI: the text names this data folder's real lists folder; the saved file is that text and never goes into the lists folder
    $ai = Get-ThisAiPrompt
    if (-not $ai.Contains("`n$([IO.Path]::GetFullPath($listsDir))`n") -or -not $ai.Contains('Never delete') -or $ai.Contains("`r")) { throw 'the AI instructions do not name the lists folder' }
    $aiFile = Join-Path $DataDir 'SAQME.md'
    $aiErr = Save-AiPromptFile $aiFile
    if ($aiErr) { throw "saving the AI instructions: $aiErr" }
    if ([IO.File]::ReadAllText($aiFile) -cne $ai) { throw 'the saved AI instructions differ from the copied ones' }
    Remove-Item -LiteralPath $aiFile -Force
    if (-not (Save-AiPromptFile (Join-Path $listsDir 'SAQME.md')) -or (Test-Path -LiteralPath (Join-Path $listsDir 'SAQME.md'))) { throw 'the AI instructions were saved into the lists folder' }
    foreach ($sub in @(@('general', 'keys'), @('yourlists', 'trash'))) {
      Show-View $sub[0]; & $activate (& $find $list "open-$($sub[1])")
      if ($script:view -ne $sub[1]) { throw "$($sub[0]) did not open $($sub[1])" }
      Go-Back
      if ($script:view -ne $sub[0]) { throw "Back from $($sub[1]) went to '$($script:view)'" }
    }
    foreach ($p in @(@('settings', 'list'), @('share', 'list'), @('keys', 'general'), @('pair', 'sync'), @('conflicts', 'sync'), @('trash', 'yourlists'), @('about', 'settings'))) {
      if ((Get-ViewParent $p[0]) -ne $p[1]) { throw "Back from $($p[0]) goes to $(Get-ViewParent $p[0])" }
    }
    # with sync set up: Sync now, Pair phone, and Advanced, closed at first, with Turn off sync in it
    $hadCfg = Test-Path -LiteralPath $syncCfgFile
    if (-not $hadCfg) { [void](New-Item -ItemType Directory -Path $syncDir -Force); Write-TextFileAtomic $syncCfgFile (ConvertTo-JsonText @{ url = 'https://saqme.example.workers.dev'; token = ('k' * 43); deviceId = 'pc-smoke'; enabled = $true }) }
    $script:advancedOpen = $false; Show-View 'sync'
    foreach ($k in 'Sync now', 'open-pair', 'advanced') { if (-not (& $find $list $k)) { throw "Sync & sharing: '$k' missing" } }
    if ((& $find $list 'Turn off sync') -or ($script:HasA11y -and (& $find $list 'advanced').IsExpanded)) { throw 'Advanced is open at first' }
    & $activate (& $find $list 'advanced')
    if (-not (& $find $list 'Turn off sync') -or ($script:HasA11y -and -not (& $find $list 'advanced').IsExpanded)) { throw 'Advanced did not open' }
    $script:advancedOpen = $false
    if (-not $hadCfg) { Remove-Item -LiteralPath $syncCfgFile -Force }
    $keys = @(Read-Lines $cfgFile | Where-Object { $_ -match '^\w+=' } | ForEach-Object { ($_ -split '=', 2)[0] } | Sort-Object)
    if (($keys -join ',') -ne 'active,autoUpdate,height,notifyAt,showCompleted,theme,updatedSeen,width') { throw "the settings file's keys changed: $($keys -join ',')" }
    # the version: the line under every Settings view (plain while no update needs a look), About, the tray icon's tooltip
    $ver = Get-VersionText
    $hasText = { param($root, [string]$t) foreach ($c in (Get-Controls $root)) { if ($c -is [System.Windows.Controls.TextBlock] -and $c.Text -eq $t) { return $true } }; return $false }
    if ($ver -notmatch '^Saqme To Do \d+\.\d+\.\d+$') { throw "version: $ver" }
    foreach ($v in @('settings') + @($script:SettingsPages.Keys) + @('keys', 'trash')) {
      Show-View $v
      if ($verBar.Visibility -ne 'Visible' -or -not (& $hasText $verBar $ver)) { throw "no version line under $v" }
    }
    if ($null -eq $InstallRoot -and (& $find $verBar 'version')) { throw 'the version line links to Updates with nothing to show' }
    Show-View 'about'
    if (-not (& $hasText $list $script:Release.Version)) { throw 'About does not say the version' }
    if (-not $tray.Text.StartsWith($ver)) { throw "tray tooltip: $($tray.Text)" }
    Show-View 'list'
    if ($verBar.Visibility -ne 'Collapsed') { throw 'the version line shows in the list' }
    # Set up sync from inside a packaged app explains itself instead of starting setup there
    $env:SAQME_TEST_PACKAGE = 'Some.App_1.0.0.0_x64__test'
    try { Start-SyncSetup } finally { Remove-Item Env:\SAQME_TEST_PACKAGE }
    if ($script:setupRun -or [string]$script:setupOutcome.message -notmatch 'Some\.App_1\.0\.0\.0') { throw 'Set up sync started inside a package' }
    $script:setupOutcome = $null
    # Settings > Updates as an installed copy sees it: an update available, one waiting for the Cloudflare sign-in. The
    # version line gets a dot and opens Updates; the Updates row in Settings and the tray icon's tooltip say it too
    $keepRoot = $InstallRoot; $InstallRoot = Join-Path $DataDir 'smoke-install'
    [void](New-Item -ItemType Directory -Path (Join-Path $InstallRoot 'update') -Force)
    Write-TextFileAtomic (Join-Path $InstallRoot 'update\result.json') (ConvertTo-JsonText @{ ok = $false; held = $true; needsLogin = $true; version = '99.0.0'; message = 'Sign in to Cloudflare to finish the update.'; at = 1 })
    $script:upd.Latest = @{ version = '99.0.0' }
    Show-View 'settings'
    if (-not (Get-AvailableUpdate) -or -not (Get-UpdateResult)['needsLogin']) { throw 'Settings > Updates' }
    $nameOf = { param($el) [System.Windows.Automation.AutomationProperties]::GetName($el) }
    $vl = & $find $verBar 'version'
    if (-not $vl -or (& $nameOf $vl) -notmatch "^$([regex]::Escape($ver))\. Sign in to Cloudflare") { throw 'the version line does not say the update waits for the sign-in' }
    if ((& $nameOf (& $find $list 'open-updates')) -notmatch 'Sign in to Cloudflare') { throw 'the Updates row does not say it' }
    if ($tray.Text -notmatch "^$([regex]::Escape($ver))`nSign in") { throw "tray tooltip: $($tray.Text)" }
    & $activate $vl
    if ($script:view -ne 'updates') { throw "the version line opened '$($script:view)'" }
    foreach ($k in 'Update now to 99.0.0', 'Sign in to Cloudflare', 'Install updates automatically') { if (-not (& $find $list $k)) { throw "Settings > Updates: '$k' missing" } }
    if (& $find $verBar 'version') { throw 'on Updates, the version line links to Updates' }
    Remove-Item -LiteralPath (Join-Path $InstallRoot 'update\result.json') -Force   # signed in: only available now
    Show-View 'about'
    if ((& $nameOf (& $find $verBar 'version')) -notmatch 'Update available: 99\.0\.0' -or -not (& $find $list 'open-updates')) { throw 'About and the version line: update available' }
    # Updates > Your sync service (with sync of its own): the token to paste, then how updating itself stands. (What
    # the Worker answers is set here: the smoke test has no Worker; worker/test/node/self-update.test.js has it.)
    $keepCfg = ${function:Read-SyncConfigUi}
    ${function:script:Read-SyncConfigUi} = { @{ url = 'https://saqme.smoke.test'; token = 'k' } }
    try {
      $script:svc.Status = @{ version = '0.8.0'; knowsItself = $true; token = $false; auto = $true; tokenUrl = 'https://dash.cloudflare.com/profile/api-tokens'; log = @() }
      Show-View 'updates'
      foreach ($k in 'Open Cloudflare''s token page', 'Cloudflare API token') { if (-not (& $find $list $k)) { throw "Updates > Your sync service: '$k' missing" } }
      $script:svc.Status = @{ version = '0.8.0'; knowsItself = $true; token = $true; auto = $true; latest = '0.9.0'; checkedAt = 1; last = @{ ok = $true; message = 'Up to date (0.8.0).' }; log = @(@{ at = 1; text = 'checked' }) }
      Render
      foreach ($k in 'Update your sync service now', 'Update by itself', 'Remove the token') { if (-not (& $find $list $k)) { throw "Updates > Your sync service: '$k' missing" } }
      if (-not (& $hasText $list '0.9.0 available')) { throw 'Updates > Your sync service does not say a new version is out' }
    } finally { ${function:script:Read-SyncConfigUi} = $keepCfg; $script:svc.Status = $null }
    $script:upd.Latest = $null; Remove-Item -LiteralPath $InstallRoot -Recurse -Force; $InstallRoot = $keepRoot
    Show-View 'list'; Update-VersionDisplay
    if ($null -eq $InstallRoot -and $tray.Text -ne $ver) { throw "tray tooltip after the update: $($tray.Text)" }
    Write-Output 'SETTINGS OK'
    # Grouped lists (docs/design.md): every view is cards of rows. A card's first row has its rounded top corners and
    # its last row the bottom ones; between two rows of a card a hairline starts where the lower row's text starts (a
    # task's notes follow it without one); a Settings row is one line (its texts never wrap: explanations are
    # footnotes); in the list the deadline sits on the right of the task's line.
    $cardsIn = {
      # the view's cards, each a list of @{ Row; Line } (Line: the hairline above the row, or $null)
      $cards = New-Object System.Collections.ArrayList; $cur = $null; $line = $null
      foreach ($c in $list.Children) {
        if ($c -is [System.Windows.Controls.Border] -and $c.Height -eq 1 -and $c.Tag -is [double]) { $line = $c; continue }
        $part = $c -is [System.Windows.Controls.Border] -and @($GroupBg, $GroupHover, $GroupSel, $GroupPress) -contains $c.Background
        if (-not $part) { $cur = $null; $line = $null; continue }
        if (-not $cur -or $c.Margin.Top -gt 0) { $cur = New-Object System.Collections.ArrayList; [void]$cards.Add($cur) }
        [void]$cur.Add(@{ Row = $c; Line = $line }); $line = $null
      }
      return ,$cards
    }
    $checkCards = {
      param([string]$where)
      $cards = & $cardsIn
      if (-not $cards.Count) { throw "${where}: no cards" }
      foreach ($cd in $cards) {
        for ($k = 0; $k -lt $cd.Count; $k++) {
          $r = $cd[$k].Row.CornerRadius
          $top = $(if ($k -eq 0) { $CardRadius } else { 0 }); $bottom = $(if ($k -eq $cd.Count - 1) { $CardRadius } else { 0 })
          if ($r.TopLeft -ne $top -or $r.TopRight -ne $top -or $r.BottomLeft -ne $bottom -or $r.BottomRight -ne $bottom) { throw "${where}: the corners of row $($k + 1) of $($cd.Count) are $r" }
          if ($k -eq 0 -and $cd[$k].Line) { throw "${where}: a hairline above a card" }
        }
      }
      return ,$cards
    }
    foreach ($v in @('settings') + @($script:SettingsPages.Keys) + @('keys')) {
      Show-View $v
      foreach ($cd in (& $checkCards "Settings view '$v'")) {
        for ($k = 0; $k -lt $cd.Count; $k++) {
          if ($k -gt 0 -and -not $cd[$k].Line) { throw "Settings view '$v': no hairline between two rows" }
          if ($k -gt 0 -and @($CardPad, ($CardPad + 28)) -notcontains $cd[$k].Line.Tag) { throw "Settings view '$v': a hairline starts at $($cd[$k].Line.Tag)" }
          foreach ($t in (Get-Controls $cd[$k].Row)) { if ($t -is [System.Windows.Controls.TextBlock] -and $t.TextWrapping -ne 'NoWrap') { throw "Settings view '$v': '$($t.Text)' can take a second line" } }
        }
      }
    }
    Show-View 'settings'
    $homeCards = & $cardsIn
    $pageCards = @($homeCards | ForEach-Object { (@($_ | ForEach-Object { [System.Windows.Automation.AutomationProperties]::GetAutomationId($_.Row) }) -join ',') })
    if (($pageCards -join ' | ') -ne 'open-general,open-notifications,open-sync,open-yourlists | open-updates,open-about' -or -not (& $hasText $list 'App')) { throw "Settings is not two cards of pages: $($pageCards -join ' | ')" }
    $groupedHome = $script:proj
    Write-TextFileAtomic (Proj-Path 'Grouped check') ("- [ ] G one due:$((Get-Date).ToString('yyyy-MM-dd')) ^gggggg01`n  > a note`n  - [ ] G sub ^gggggg02`n  - [x] G sub done ^gggggg03`n" +
      "- [ ] G two ^gggggg04`n- [>] G later ^gggggg05`n- [x] G done ^gggggg06`n")
    Switch-Project 'Grouped check'
    $script:openState['gggggg01'] = '1'; $script:cfg.showCompleted = '1'; $script:view = 'list'; Render
    $cards = & $checkCards 'the list'
    $rowsOf = { param($cd) @($cd | ForEach-Object { if (Is-TaskRow $_.Row) { $_.Row.Tag.Id.Substring(6) } else { 'notes' } }) -join ',' }
    $shape = @($cards | ForEach-Object { & $rowsOf $_ }) -join ' | '
    if ($shape -ne '01,notes,02,03,04 | 05 | 06') { throw "the list's cards: $shape" }
    foreach ($e in $cards[0]) {
      if (Is-TaskRow $e.Row) {
        if ($e.Row.Tag.Id -ne 'gggggg01' -and $e.Line.Tag -ne $RowTextX + $e.Row.Tag.Level * $Tokens.Row.indent) { throw "the hairline above '$($e.Row.Tag.Text)' starts at $($e.Line.Tag)" }
      } elseif ($e.Line) { throw 'a hairline between a task and its notes' }
    }
    $meta = $cards[0][0].Row.Child.Children[3]
    if ([System.Windows.Controls.Grid]::GetColumn($meta) -ne 4 -or -not @($meta.Children | Where-Object { [System.Windows.Automation.AutomationProperties]::GetName($_) -like 'Deadline: Today*' }).Count) { throw 'the deadline is not on the right of the line' }
    if (-not (& $hasText $list 'Postponed')) { throw 'no Postponed heading' }
    Set-Sel $cards[0][4].Row.Tag
    foreach ($e in $cards[0]) {
      if (-not (Is-TaskRow $e.Row)) { continue }
      $ok = $(if ($e.Row.Tag.Id -eq 'gggggg04') { $e.Row.Background -eq $GroupSel -and $e.Row.BorderBrush -eq $Accent } else { $e.Row.BorderBrush -eq $e.Row.Background })
      if (-not $ok) { throw "the selection paints '$($e.Row.Tag.Text)' wrong" }
    }
    # a selected closed task is drawn in smoke (closed grey is under 4.5 : 1 on the selection tint), and back in closed grey
    $doneRow = $cards[0][3].Row
    if ($doneRow.Tag.Id -ne 'gggggg03') { throw 'the done subtask is not where the check looks' }
    $closedGrey = (Brush (St 'x').Text).Color
    if ($doneRow.Child.Children[2].Foreground.Color -ne $closedGrey) { throw 'a closed task is not in closed grey' }
    Set-Sel $doneRow.Tag
    if ($doneRow.Child.Children[2].Foreground.Color -ne $Faint.Color -or $doneRow.Child.Children[2].TextDecorations.Count -ne 1) { throw 'a selected closed task is not in smoke grey with its strike-through' }
    Set-Sel $cards[0][4].Row.Tag
    if ($doneRow.Child.Children[2].Foreground.Color -ne $closedGrey) { throw 'a closed task stays smoke grey after the selection moved' }
    $doneHead = $null
    foreach ($c in (Get-Controls $list)) { if ([System.Windows.Automation.AutomationProperties]::GetName($c) -eq 'Completed, 1 task') { $doneHead = $c } }
    if (-not $doneHead -or ($script:HasA11y -and ($doneHead.Role -ne 'disclosure' -or -not $doneHead.IsExpanded))) { throw 'the Completed heading is not an open disclosure' }
    & $activate $doneHead
    if ($script:cfg.showCompleted -ne '0' -or (& $cardsIn).Count -ne 2) { throw 'Completed did not close' }
    Switch-Project $groupedHome
    Remove-Item -LiteralPath (Proj-Path 'Grouped check') -Force
    Render
    $first = @($script:items | Where-Object { $_.Kind -eq 'task' -and $_.Id -eq $first.Id })[0]   # (the list was loaded again)
    Write-Output 'GROUPED OK'
    Apply-Theme $(if ($script:themeName -eq 'dark') { 'light' } else { 'dark' })
    [void](New-QrImage 'https://saqme.example.workers.dev/#pair=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG')
    Check-Reminders
    # an outside edit (editor / AI assistant) while the widget holds the list is merged, never overwritten
    $disk = [IO.File]::ReadAllText($script:todo)
    Write-TextFileAtomic $script:todo ($disk + "- [ ] added by an assistant ^zzzzzzzz`n")
    $first.Mark = '/'; Save-Items
    $after = [IO.File]::ReadAllText($script:todo)
    if ($after -notmatch 'added by an assistant' -or $after -notmatch '- \[/\] smoke task one') { throw "outside edit lost: $after" }
    # Drag and drop through the code the mouse handlers run (Start-Drag / Drag-Move / End-Drag), Alt+Up/Down,
    # Ctrl+Z, a delete and its restore from Recently deleted, and the save guard: a list never loses a task
    # that was not deleted (1.0.0 lost every dragged task, and sync sent them as deletes)
    $homeList = $script:proj
    Write-TextFileAtomic (Proj-Path 'Drag check') ("- [ ] P one ^pppppp01`n  - [ ] P sub a ^pppppp02`n  - [x] P sub b ^pppppp03`n  - [ ] P sub c ^pppppp04`n" +
      "- [ ] Q two ^qqqqqq01`n- [ ] R three ^rrrrrr01`n- [>] S later ^ssssss01`n- [x] T done ^tttttt01`n")
    Switch-Project 'Drag check'
    $script:cfg.showCompleted = '1'; Render
    $layout = { $outer.Measure((New-Object System.Windows.Size(420, 1200))); $outer.Arrange((New-Object System.Windows.Rect(0, 0, 420, 1200))); $outer.UpdateLayout() }
    $fileText = { [IO.File]::ReadAllText($script:todo) }
    $ids = { $set = Get-TaskIdSet (Read-Items (& $fileText)); $a = New-Object string[] $set.Count; $set.CopyTo($a); [Array]::Sort($a, [StringComparer]::Ordinal); $a -join ',' }
    $all = & $ids
    if ($all.Split(',').Count -ne 8) { throw "drag check list: $all" }
    $rowOf = { param($id) @($list.Children | Where-Object { (Is-TaskRow $_) -and $_.Tag.Id -ceq $id })[0] }
    $dragTo = {   # (not $drag: this runs at script scope, where $drag is the widget's own)
      param([string]$from, [string]$to, [string]$where)
      & $layout
      Start-Drag (& $rowOf $from).Child.Children[5]
      & $layout
      if ($where -eq 'end') { $y = 100000 } else {
        $dst = & $rowOf $to
        $top = $dst.TranslatePoint((New-Object System.Windows.Point(0, 0)), $list).Y
        $y = $(if ($where -eq 'above') { $top + 1 } else { $top + $dst.ActualHeight - 1 })
      }
      $ev = New-Object psobject -Property @{ Y = $y }
      $ev | Add-Member -MemberType ScriptMethod -Name GetPosition -Value { param($rel) New-Object System.Windows.Point(4, $this.Y) }
      Drag-Move $ev; End-Drag $true
      if ((& $ids) -ne $all) { throw "drag $from $where $to lost tasks:`n$(& $fileText)" }
    }
    $order = { (@((Read-Items (& $fileText)) | Where-Object { $_.Kind -eq 'task' } | ForEach-Object { ('  ' * $_.Level) + $_.Id.Substring(0, 1) + $_.Id.Substring(7) }) -join ' ') }
    & $dragTo 'pppppp01' 'qqqqqq01' 'below'      # a task with subtasks, between top-level tasks
    if ((& $order) -ne 'q1 p1   p2   p3   p4 r1 s1 t1') { throw "drag below: $(& $order)" }
    & $dragTo 'rrrrrr01' 'pppppp02' 'above'      # into a parent
    if ((& $order) -ne 'q1 p1   r1   p2   p3   p4 s1 t1') { throw "drag into a parent: $(& $order)" }
    & $dragTo 'rrrrrr01' $null 'end'             # out again, to the end
    & $dragTo 'pppppp04' 'qqqqqq01' 'above'      # a subtask out of its parent
    if ((& $order) -ne 'p4 q1 p1   p2   p3 s1 t1 r1') { throw "drag out of a parent: $(& $order)" }
    $t0 = & $fileText
    & $dragTo 'pppppp01' 'pppppp02' 'above'      # into its own subtasks: cancelled, nothing changes
    if ((& $fileText) -cne $t0) { throw 'a drop into its own subtasks changed the list' }
    Nudge-Task @($script:items | Where-Object { $_.Id -eq 'qqqqqq01' })[0] -1
    Nudge-Task @($script:items | Where-Object { $_.Id -eq 'pppppp01' })[0] 1
    if ((& $ids) -ne $all) { throw "Alt+Up/Down lost tasks:`n$(& $fileText)" }
    # Ctrl+Z right after a drag puts the list back
    $t0 = & $fileText
    & $dragTo 'qqqqqq01' $null 'end'
    Undo-Last
    if ((& $fileText) -cne $t0) { throw "undo after a drag:`n$(& $fileText)" }
    # a delete goes to Recently deleted; Ctrl+Z, or Restore there, brings it back
    Delete-Task @($script:items | Where-Object { $_.Id -eq 'pppppp01' })[0]
    if ((& $ids) -match 'pppppp0[123]') { throw 'delete' }
    $en = @(Get-DeletedEntries | Where-Object { $_.First -eq 'P one' })
    if ($en.Count -ne 1 -or $en[0].Count -ne 3) { throw "Recently deleted: $($en.Count) entries" }
    $script:view = 'trash'; Render; $script:view = 'list'
    Undo-Last
    if ((& $ids) -ne $all) { throw "undo after a delete:`n$(& $fileText)" }
    Delete-Task @($script:items | Where-Object { $_.Id -eq 'pppppp01' })[0]
    Restore-Deleted @(Get-DeletedEntries | Where-Object { $_.First -eq 'P one' })[0]
    if ((& $ids) -ne $all) { throw "restore:`n$(& $fileText)" }
    # the guard: a change that drops a task nobody deleted is not saved
    $t0 = & $fileText; $refused = $script:refusedSaves
    $script:items.Remove(@($script:items | Where-Object { $_.Id -eq 'qqqqqq01' })[0])
    Save-Items
    if ((& $fileText) -cne $t0 -or $script:refusedSaves -ne $refused + 1 -or -not @($script:items | Where-Object { $_.Id -eq 'qqqqqq01' }).Count) { throw 'the save guard let a task go' }
    # and random drags between all kinds of rows
    $rng = New-Object System.Random 19
    for ($k = 0; $k -lt 30; $k++) {
      & $layout
      $rows = @($list.Children | Where-Object { (Is-TaskRow $_) -and $_.Child.Children[5].Child })
      & $dragTo $rows[$rng.Next($rows.Count)].Tag.Id $rows[$rng.Next($rows.Count)].Tag.Id @('above', 'below')[$rng.Next(2)]
    }
    Switch-Project $homeList
    Remove-Item -LiteralPath (Proj-Path 'Drag check') -Force
    Render
    Write-Output 'DRAG OK'
    # a list shared with this PC (bound in lists\.remotes.json): view-only, it renders read-only and is never written;
    # its list menu offers Leave, not Delete or Rename; an own list's Share view says it needs sync (none here)
    Write-TextFileAtomic (Proj-Path 'Shared check') "- [ ] owner's task ^shshsh01`n  - [ ] owner's subtask ^shshsh02`n"
    Save-ShareBindings $listsDir @(@{ id = 'ssmoke000001'; file = 'Shared check'; server = 'https://owner.example'; project = 'pshared01'; access = 'view'; name = 'Shared check'; joinedAt = 1 })
    $script:bindSig = $null
    Switch-Project 'Shared check'
    if (-not $script:readOnly) { throw 'a view-only shared list is not read-only' }
    $t0 = [IO.File]::ReadAllText($script:todo)
    $script:items[0].Text = 'changed here'; Save-Items
    if ([IO.File]::ReadAllText($script:todo) -cne $t0 -or $script:items[0].Text -ne "owner's task") { throw 'a view-only list was written' }
    Delete-Task $script:items[0]; Begin-Notes $script:items[0]
    if ([IO.File]::ReadAllText($script:todo) -cne $t0) { throw 'a view-only list was changed' }
    $lm = New-ListContextMenu 'Shared check'
    if (@($lm.Items | Where-Object { $_.Header -eq 'Leave this list' }).Count -ne 1 -or @($lm.Items | Where-Object { $_.Header -eq 'Delete list' }).Count) { throw 'shared list menu' }
    if ($script:titleBtn.ContextMenu.Items.Count -ne (4 + @(New-MoveItems 'Shared check').Count) -or (Get-ListInfo 'Shared check').Open -ne 2) { throw 'the title of a shared list' }
    Show-Share $homeList; Render-Settings
    foreach ($v in 'settings', 'sync', 'conflicts', 'list') { $script:view = $v; Render }
    if (-not (Get-InviteLink 'https://owner.example/join#code=AAAAAAAAAAAAAAAAAAAAAA')) { throw 'invite link' }
    Save-ShareBindings $listsDir @(); $script:bindSig = $null
    Switch-Project $homeList
    Remove-Item -LiteralPath (Proj-Path 'Shared check') -Force
    Render
    Write-Output 'SHARED OK'
    # the list switcher: the title is a menu button with a dot for another list that has something due; its menu has
    # a row per list (the current one selected) and New list; closing it and a choice work
    $swHome = $script:proj
    Write-TextFileAtomic (Proj-Path 'Switch check') ("- [ ] S one due:$((Get-Date).AddDays(-1).ToString('yyyy-MM-dd')) ^swswsw01`n- [ ] S two due:$((Get-Date).ToString('yyyy-MM-dd')) ^swswsw02`n- [ ] S three ^swswsw03`n- [x] S done due:$((Get-Date).AddDays(-3).ToString('yyyy-MM-dd')) ^swswsw04`n")
    $swInfo = Get-ListInfo 'Switch check'
    if ($swInfo.Open -ne 3 -or $swInfo.Due -ne 2 -or $swInfo.Over -ne 1) { throw "list counts: $($swInfo | ConvertTo-Json -Compress)" }
    Render-Tabs
    $tb = $script:titleBtn
    $dotOf = { param($b) @($b.Child.Children | Where-Object { $_ -is [System.Windows.Shapes.Ellipse] }).Count }
    if ([System.Windows.Automation.AutomationProperties]::GetName($tb) -ne $swHome -or $tb.Child.Children[$tb.Child.Children.Count - 1].Text -ne $swHome) { throw 'the title is not the current list' }
    if ($script:HasA11y -and ($tb.Role -ne 'disclosure' -or $tb.IsExpanded)) { throw 'the title is not a closed menu button' }
    if ((& $dotOf $tb) -ne 1 -or ([string]$tb.ToolTip) -notlike '*Switch check*') { throw 'no dot for a list with something due' }
    # (docked right, so the first child is the rightmost: the title reads name, chevron, dot, as on the phone)
    if ($tb.Child.Children[0] -isnot [System.Windows.Shapes.Ellipse] -or -not [object]::ReferenceEquals($tb.Child.Children[1], $script:titleChev)) { throw 'the title does not read name, chevron, dot' }
    Show-ListsMenu
    $swNames = @(Get-ProjectNames)
    if (-not $script:listsPopup.IsOpen -or $script:listsRows.Count -ne $swNames.Count + 1) { throw "the lists menu has $($script:listsRows.Count) rows for $($swNames.Count) lists" }
    if ($script:HasA11y -and (-not $tb.IsExpanded -or -not @($script:listsRows | Where-Object { $_.Role -eq 'radio' -and $_.IsSelected -and $_.Tag -eq $swHome }).Count)) { throw 'the menu is not expanded or does not select the current list' }
    $swRow = @($script:listsRows | Where-Object { $_.Tag -eq 'Switch check' })[0]
    if ([System.Windows.Automation.AutomationProperties]::GetName($swRow) -ne 'Switch check, 2 due, 1 overdue') { throw "the row says: $([System.Windows.Automation.AutomationProperties]::GetName($swRow))" }
    $swSrc = New-Object System.Windows.Interop.HwndSource(0, 0, 0, 0, 0, 'swkeys', [IntPtr]::Zero)   # (a source for the key events)
    $swKey = {   # a key as the menu's root sees it: whether the menu took it
        param([string]$key)
        $root = $script:listsPopup.Child
        $ke = New-Object System.Windows.Input.KeyEventArgs([System.Windows.Input.Keyboard]::PrimaryDevice, $swSrc, 0, [System.Windows.Input.Key]$key)
        $ke.RoutedEvent = [System.Windows.UIElement]::PreviewKeyDownEvent
        $root.RaiseEvent($ke)
        return $ke.Handled
    }
    foreach ($k in 'Down', 'Up', 'Home', 'End') { if (-not (& $swKey $k)) { throw "the lists menu ignored $k" } }
    if (& $swKey 'A') { throw 'the lists menu took a letter' }
    if (-not (& $swKey 'Escape') -or $script:listsPopup.IsOpen) { throw 'Esc did not close the lists menu' }
    $swSrc.Dispose()
    # a list's own menu moves it: the first list has no Move up, the last no Move down; a move rewrites lists\.order
    $mvNames = @(Get-ProjectNames)
    $mvFirst = (New-ListContextMenu $mvNames[0]); $mvLast = (New-ListContextMenu $mvNames[-1])
    $hasItem = { param($m, $h) @($m.Items | Where-Object { $_.Header -eq $h }).Count -eq 1 }
    if ((& $hasItem $mvFirst 'Move up') -or -not (& $hasItem $mvFirst 'Move down') -or -not (& $hasItem $mvLast 'Move up') -or (& $hasItem $mvLast 'Move down')) { throw 'Move up / Move down at the ends of the lists' }
    Move-List $mvNames[0] 1
    $mvAfter = @(Get-ProjectNames)
    if (($mvAfter -join '|') -ne (@($mvNames[1], $mvNames[0]) + @($mvNames | Select-Object -Skip 2) -join '|')) { throw "Move down gave: $($mvAfter -join ', ')" }
    if (@(Read-Lines $orderFile)[0] -cne $mvNames[1]) { throw 'the move did not reach lists\.order' }
    Move-List $mvNames[0] -1
    if ((@(Get-ProjectNames) -join '|') -ne ($mvNames -join '|')) { throw 'Move up did not undo it' }
    Show-ListsMenu
    Close-ListsMenu $true
    if ($script:listsPopup.IsOpen) { throw 'the lists menu did not close' }
    if ($script:HasA11y -and $tb.IsExpanded) { throw 'the title still says it is expanded' }
    Choose-List 'Switch check'
    if ($script:proj -ne 'Switch check') { throw 'choosing a list did not switch to it' }
    if (([string]$script:titleBtn.ToolTip) -like '*earlier in:*Switch check*') { throw 'the dot names the current list' }
    $script:openPopup = $null
    Switch-Project $swHome
    Remove-Item -LiteralPath (Proj-Path 'Switch check') -Force
    Render
    Write-Output 'SWITCHER OK'
    $first = @($script:items | Where-Object { $_.Kind -eq 'task' -and $_.Text -eq 'smoke task one' })[0]
    if ($script:sync) {
      # with a sync config in the data dir: the real loop must push our task, and a change made on
      # "another device" must come back into the open list through the UI-thread plan
      $syncCfg = Read-SyncConfigUi
      $api = ([string]$syncCfg['url']).TrimEnd('/') + '/api/sync'
      $wait = {
        param([scriptblock]$cond, [string]$what)
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
          if ($script:sync.Plan) { Apply-SyncPlan }
          if (& $cond) { return }
          Start-Sleep -Milliseconds 200
        }
        throw "timed out waiting for: $what ($($script:sync.Status): $($script:sync.StatusText))"
      }
      $serverRow = {
        $r = Invoke-SaqmeApi $api ([string]$syncCfg['token']) 'POST' @{ deviceId = 'smoke-probe'; cursor = 0; changes = @() }
        foreach ($row in @($r.Data['changes'])) { if ($row['kind'] -eq 'task' -and $row['id'] -eq $first.Id) { return $row } }
        return $null
      }
      & $wait { $null -ne (& $serverRow) } 'the task to reach the server'
      $row = & $serverRow
      $change = @{ kind = 'task'; id = $first.Id; fields = @{ text = @{ v = 'changed on another device'; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); base = [long]$row['fields']['text']['ts'] } } }
      [void](Invoke-SaqmeApi $api ([string]$syncCfg['token']) 'POST' @{ deviceId = 'smoke-phone'; cursor = 0; changes = @($change) })
      Request-Sync
      & $wait { @($script:items | Where-Object { $_.Id -eq $first.Id -and $_.Text -eq 'changed on another device' }).Count -eq 1 } 'the remote edit to show up in the open list'
      Write-Output "SYNC OK ($($script:sync.Status))"
      # Pair phone: a one-time code from the Worker, fetched in the background
      $script:view = 'pair'; Render
      & $wait { Receive-PairCode; $script:pairCode -and $script:pairCode.Code } 'a pairing code'
      if ($script:pairCode.Code -notmatch '^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$') { throw "unexpected pairing code: $($script:pairCode.Code)" }
      $claim = Invoke-SaqmeApi (([string]$syncCfg['url']).TrimEnd('/') + '/api/pair/claim') '' 'POST' @{ code = $script:pairCode.Code }
      if ($claim.Status -ne 200 -or [string]$claim.Data['token'] -ne [string]$syncCfg['token']) { throw "the pairing code did not pair: $($claim.Status) $($claim.Text)" }
      Write-Output 'PAIR CODE OK'
      $script:view = 'list'; Render
      # a task deleted on another device shows in Recently deleted here; restoring it undeletes it everywhere
      $rowOfId = {
        param($id)
        $r = Invoke-SaqmeApi $api ([string]$syncCfg['token']) 'POST' @{ deviceId = 'smoke-probe'; cursor = 0; changes = @() }
        foreach ($x in @($r.Data['changes'])) { if ($x['kind'] -eq 'task' -and $x['id'] -eq $id) { return $x } }
        return $null
      }
      Add-Task 'smoke deleted elsewhere'
      $other = @($script:items | Where-Object { $_.Text -eq 'smoke deleted elsewhere' })[0]
      Request-Sync
      & $wait { $null -ne (& $rowOfId $other.Id) } 'the new task to reach the server'
      $orow = & $rowOfId $other.Id
      $gone = @{ kind = 'task'; id = $other.Id; fields = @{ deleted = @{ v = $true; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); base = [long]$orow['fields']['deleted']['ts'] } } }
      [void](Invoke-SaqmeApi $api ([string]$syncCfg['token']) 'POST' @{ deviceId = 'smoke-phone'; cursor = 0; changes = @($gone) })
      Request-Sync
      & $wait { -not @($script:items | Where-Object { $_.Id -eq $other.Id }).Count } 'the delete from the other device to arrive'
      & $wait { @(Get-DeletedEntries | Where-Object { $_.First -eq 'smoke deleted elsewhere' }).Count -eq 1 } 'the task in Recently deleted'
      Restore-Deleted @(Get-DeletedEntries | Where-Object { $_.First -eq 'smoke deleted elsewhere' })[0]
      Request-Sync
      & $wait { $x = & $rowOfId $other.Id; $x -and -not $x['fields']['deleted']['v'] } 'the restore to reach the server'
      Write-Output 'RESTORE OK'
      if ($env:SAQME_SMOKE_SHOTS) {
        # a stale edit from yet another device -> a conflict to look at
        $stale = @{ kind = 'task'; id = $first.Id; fields = @{ text = @{ v = 'older edit from a laptop'; ts = [long]$row['fields']['text']['ts'] + 5; base = [long]$row['fields']['text']['ts'] } } }
        [void](Invoke-SaqmeApi $api ([string]$syncCfg['token']) 'POST' @{ deviceId = 'smoke-laptop'; cursor = 0; changes = @($stale) })
        Request-Sync
        & $wait { @(Get-OpenConflictList).Count -gt 0 } 'a conflict'
      }
    }
    if ($env:SAQME_SMOKE_SHOTS) {
      # off-screen renders of the main views, for visual checks (scripts/dev/widget-shots.ps1)
      $shot = {
        param([string]$name)
        [void](Update-SyncIndicator -Force)
        $sz = New-Object System.Windows.Size($w.Width, $w.Height)
        $outer.Measure($sz); $outer.Arrange((New-Object System.Windows.Rect(0, 0, $w.Width, $w.Height))); $outer.UpdateLayout()
        $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap([int]($w.Width * 2), [int]($w.Height * 2), 192, 192, [System.Windows.Media.PixelFormats]::Pbgra32)
        $rtb.Render($outer)
        $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
        $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
        $fs = [IO.File]::Create((Join-Path $env:SAQME_SMOKE_SHOTS "$name.png")); try { $enc.Save($fs) } finally { $fs.Close() }
      }
      $w.Height = 640
      foreach ($theme in 'dark', 'light') {
        Apply-Theme $theme
        foreach ($v in @('list', 'settings') + @($script:SettingsPages.Keys) + @('pair', 'conflicts')) { $script:view = $v; Render; & $shot "$v-$theme" }
      }
    }
    Write-Output 'SMOKE OK'
  } catch {
    Write-Output "SMOKE FAIL: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
    $code = 1
  }
  Stop-SyncLoop
  try { $tray.Dispose() } catch {}
  if ($script:mutexHeld) { try { $mutex.ReleaseMutex() } catch {} }
  if ($script:smokeTemp) { Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue }
  exit $code
}
$timer.Start()

if (-not $script:startHidden) { $w.Show() }   # (else in the tray only, as it was before the updater restarted it)
[System.Windows.Threading.Dispatcher]::Run()   # runs until Quit
try { $tray.Dispose() } catch {}
if ($script:mutexHeld) { try { $mutex.ReleaseMutex() } catch {} }
