# Saqme To Do - Claude Desktop on this PC, for Settings > Use with AI > Connect Claude Desktop (widget.ps1): whether it
# is installed, and Saqme in its settings file (claude_desktop_config.json, "mcpServers" > "saqme"), so that Claude
# Desktop starts desktop/mcp-server.ps1 and has the lists in every chat, without sync and without anything pasted.
# Dot-source it after sync-core.ps1; it only defines functions. Windows PowerShell 5.1.
#
# The settings file is the user's: only the "saqme" entry is added, replaced or removed; everything else (other
# servers, preferences, the key order, the indent) stays. A file that is not plain JSON is left alone and the app says
# so. Before every change the file as it was is copied to claude_desktop_config.json.saqme-backup, and the new one
# replaces it in one step. Connecting twice changes nothing the second time. The Linux/macOS app does the same in
# local/claude-desktop.mjs; shared/fixtures/claude-config.json holds the cases both must agree on.

$script:ClaudeServerName = 'saqme'
$script:ClaudeBackupSuffix = '.saqme-backup'
$script:ClaudeDownload = 'https://claude.ai/download'

# Where Claude Desktop reads its settings: %APPDATA%\Claude, unless its Store (MSIX) package keeps a private copy of
# that folder (LocalCache\Roaming\Claude in the package's folder), which is then the one it sees.
function Get-ClaudeConfigPath([string]$AppData = $env:APPDATA, [string]$LocalAppData = $env:LOCALAPPDATA) {
  foreach ($pkg in (Get-ClaudePackageDirs $LocalAppData)) {
    $p = [IO.Path]::Combine($pkg, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
    if ([IO.File]::Exists($p)) { return $p }
  }
  return [IO.Path]::Combine($AppData, 'Claude', 'claude_desktop_config.json')
}
function Get-ClaudePackageDirs([string]$LocalAppData) {
  $pkgs = [IO.Path]::Combine($LocalAppData, 'Packages')
  try { return @([IO.Directory]::GetDirectories($pkgs) | Where-Object { [IO.Path]::GetFileName($_) -match '^Claude_[0-9a-z]{13}\z' }) } catch { return @() }
}
# Installed: the Store app (its package folder), the classic installer's folder, or Claude's settings folder.
function Test-ClaudeInstalled([string]$AppData = $env:APPDATA, [string]$LocalAppData = $env:LOCALAPPDATA) {
  if (@(Get-ClaudePackageDirs $LocalAppData).Count) { return $true }
  foreach ($p in @([IO.Path]::Combine($LocalAppData, 'AnthropicClaude'), [IO.Path]::Combine($AppData, 'Claude'))) { if ([IO.Directory]::Exists($p)) { return $true } }
  return $false
}

# What Claude Desktop runs: Windows PowerShell with the server script ($script: the stable launcher next to versions\
# when installed, saqme-mcp.ps1, which follows updates), on this data folder.
function Get-ClaudeEntry([string]$script, [string]$dataDir) {
  return [ordered]@{
    command = [IO.Path]::Combine($env:WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $script, '-DataDir', $dataDir.TrimEnd('\'))
  }
}

# ---------------------------------------------------------------- the settings file's text
function New-ClaudeConfigError([string]$msg) { $e = New-Object System.Exception $msg; $e.Data['saqme'] = 'claude-config'; return $e }
function ConvertFrom-ClaudeConfig($text) {
  $t = $(if ($null -eq $text) { '' } else { [string]$text })
  if ($t.Length -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
  if (-not $t.Trim()) { return (New-Object 'System.Collections.Generic.Dictionary[string,object]') }
  try { $o = $script:Json.DeserializeObject($t) } catch { throw (New-ClaudeConfigError "Claude Desktop's settings file is not plain JSON (it may have a comment or a typo in it), so Saqme left it alone.") }
  if (-not ($o -is [System.Collections.Generic.Dictionary[string, object]])) { throw (New-ClaudeConfigError "Claude Desktop's settings file does not look as expected, so Saqme left it alone.") }
  # (JavaScriptSerializer takes a few things JSON does not, a trailing comma among them: refuse those too)
  if ($t -match ',\s*[}\]]') { throw (New-ClaudeConfigError "Claude Desktop's settings file is not plain JSON (it may have a comment or a typo in it), so Saqme left it alone.") }
  if ($o.ContainsKey('mcpServers') -and -not ($o['mcpServers'] -is [System.Collections.Generic.Dictionary[string, object]])) { throw (New-ClaudeConfigError "Claude Desktop's settings file has an unexpected `"mcpServers`" part, so Saqme left it alone.") }
  return $o
}
# JSON with the file's own indent and line endings (two spaces when it has none)
function ConvertTo-ClaudeConfigText($o, $before) {
  $t = [string]$before
  $ind = $(if ($t -match '\n([ \t]+)\S') { $matches[1] } else { '  ' })
  $sb = New-Object System.Text.StringBuilder
  Add-ClaudeJson $sb $o '' $ind
  $out = $sb.ToString() + "`n"
  if ($t.Contains("`r`n")) { $out = $out.Replace("`n", "`r`n") }
  return $out
}
function Add-ClaudeJson($sb, $v, [string]$pad, [string]$ind) {
  if ($v -is [System.Collections.IDictionary]) {
    if (-not $v.Count) { [void]$sb.Append('{}'); return }
    [void]$sb.Append("{`n"); $first = $true
    foreach ($k in @($v.Keys)) {
      if (-not $first) { [void]$sb.Append(",`n") }; $first = $false
      [void]$sb.Append($pad + $ind + (ConvertTo-ClaudeJsonString ([string]$k)) + ': ')
      Add-ClaudeJson $sb $v[$k] ($pad + $ind) $ind
    }
    [void]$sb.Append("`n$pad}"); return
  }
  if ($v -is [string]) { [void]$sb.Append((ConvertTo-ClaudeJsonString $v)); return }
  if ($v -is [System.Collections.IEnumerable]) {
    $list = @($v)
    if (-not $list.Count) { [void]$sb.Append('[]'); return }
    [void]$sb.Append("[`n")
    for ($i = 0; $i -lt $list.Count; $i++) {
      [void]$sb.Append($pad + $ind); Add-ClaudeJson $sb $list[$i] ($pad + $ind) $ind
      if ($i -lt $list.Count - 1) { [void]$sb.Append(',') }
      [void]$sb.Append("`n")
    }
    [void]$sb.Append("$pad]"); return
  }
  if ($null -eq $v) { [void]$sb.Append('null'); return }
  if ($v -is [bool]) { [void]$sb.Append($(if ($v) { 'true' } else { 'false' })); return }
  [void]$sb.Append([Convert]::ToString($v, [Globalization.CultureInfo]::InvariantCulture))
}
# a JSON string as JavaScript writes it (JavaScriptSerializer would also escape < > & ')
function ConvertTo-ClaudeJsonString([string]$s) {
  $sb = New-Object System.Text.StringBuilder '"'
  foreach ($c in $s.ToCharArray()) {
    switch ([int]$c) {
      0x22 { [void]$sb.Append('\"') } 0x5C { [void]$sb.Append('\\') } 0x0A { [void]$sb.Append('\n') } 0x0D { [void]$sb.Append('\r') } 0x09 { [void]$sb.Append('\t') }
      0x08 { [void]$sb.Append('\b') } 0x0C { [void]$sb.Append('\f') }
      default { if ([int]$c -lt 0x20) { [void]$sb.Append(('\u{0:x4}' -f [int]$c)) } else { [void]$sb.Append($c) } }
    }
  }
  return $sb.Append('"').ToString()
}
function Test-ClaudeSame($a, $b) { return (ConvertTo-JsonText $a) -ceq (ConvertTo-JsonText $b) }

# -> 'none' | 'connected' (this entry, exactly) | 'other' (a "saqme" entry that runs something else); throws when unreadable
function Get-ClaudeServerState($text, $entry, [string]$name = $script:ClaudeServerName) {
  $o = ConvertFrom-ClaudeConfig $text
  if (-not $o.ContainsKey('mcpServers') -or -not $o['mcpServers'].ContainsKey($name)) { return 'none' }
  if (Test-ClaudeSame $o['mcpServers'][$name] $entry) { return 'connected' }
  return 'other'
}
# -> @{ Text; Changed }: the entry added, or put in place of an older one ($text $null: no file yet)
function Add-ClaudeServer($text, $entry, [string]$name = $script:ClaudeServerName) {
  $o = ConvertFrom-ClaudeConfig $text
  if (-not $o.ContainsKey('mcpServers')) { $o['mcpServers'] = New-Object 'System.Collections.Generic.Dictionary[string,object]' }
  $s = $o['mcpServers']
  if ($s.ContainsKey($name) -and (Test-ClaudeSame $s[$name] $entry)) { return @{ Text = $text; Changed = $false } }
  if ($s.ContainsKey($name)) {
    # in its place (a Dictionary would put a removed-and-added key elsewhere): rebuilt in order
    $n = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    foreach ($k in @($s.Keys)) { if ($k -ceq $name) { $n[$k] = $entry } else { $n[$k] = $s[$k] } }
    $o['mcpServers'] = $n
  } else { $s[$name] = $entry }
  return @{ Text = (ConvertTo-ClaudeConfigText $o $text); Changed = $true }
}
# -> @{ Text; Changed }: the entry removed, nothing else
function Remove-ClaudeServer($text, [string]$name = $script:ClaudeServerName) {
  if ($null -eq $text) { return @{ Text = $text; Changed = $false } }
  $o = ConvertFrom-ClaudeConfig $text
  if (-not $o.ContainsKey('mcpServers') -or -not $o['mcpServers'].ContainsKey($name)) { return @{ Text = $text; Changed = $false } }
  $n = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  foreach ($k in @($o['mcpServers'].Keys)) { if ($k -cne $name) { $n[$k] = $o['mcpServers'][$k] } }
  $o['mcpServers'] = $n
  return @{ Text = (ConvertTo-ClaudeConfigText $o $text); Changed = $true }
}

# ---------------------------------------------------------------- on disk
function Read-ClaudeConfigText([string]$path) {
  if (-not [IO.File]::Exists($path)) { return $null }
  $t = Read-TextFile $path
  if ($null -eq $t) { throw (New-ClaudeConfigError 'Claude Desktop''s settings file is in use by another program. Try again in a moment.') }
  return $t
}
function Save-ClaudeConfigText([string]$path, [string]$text, $before) {
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
  if ($null -ne $before) { Assert-RealAppData ($path + $script:ClaudeBackupSuffix); [IO.File]::Copy($path, $path + $script:ClaudeBackupSuffix, $true) }
  if (-not (Write-TextFileIfUnchanged $path $text $before)) { throw (New-ClaudeConfigError 'Claude Desktop changed its settings at the same moment. Try again.') }
}
# -> @{ Installed; Path; State ('none' | 'connected' | 'other' | 'unreadable'); Error }
function Get-ClaudeDesktopStatus($entry, [string]$AppData = $env:APPDATA, [string]$LocalAppData = $env:LOCALAPPDATA) {
  $path = Get-ClaudeConfigPath $AppData $LocalAppData
  $r = @{ Installed = (Test-ClaudeInstalled $AppData $LocalAppData); Path = $path; State = 'none'; Error = '' }
  try { $r.State = Get-ClaudeServerState (Read-ClaudeConfigText $path) $entry } catch { $r.State = 'unreadable'; $r.Error = $_.Exception.Message }
  return $r
}
# Connect / Disconnect -> @{ Ok; Changed; Error }
function Connect-ClaudeDesktop($entry, [string]$AppData = $env:APPDATA, [string]$LocalAppData = $env:LOCALAPPDATA) {
  try {
    if (-not (Test-ClaudeInstalled $AppData $LocalAppData)) { return @{ Ok = $false; Changed = $false; Error = 'Claude Desktop is not installed on this PC.' } }
    $path = Get-ClaudeConfigPath $AppData $LocalAppData
    $before = Read-ClaudeConfigText $path
    $r = Add-ClaudeServer $before $entry
    if ($r.Changed) { Save-ClaudeConfigText $path $r.Text $before }
    return @{ Ok = $true; Changed = $r.Changed; Error = '' }
  } catch { return @{ Ok = $false; Changed = $false; Error = $_.Exception.Message } }
}
function Disconnect-ClaudeDesktop([string]$AppData = $env:APPDATA, [string]$LocalAppData = $env:LOCALAPPDATA) {
  try {
    $path = Get-ClaudeConfigPath $AppData $LocalAppData
    $before = Read-ClaudeConfigText $path
    $r = Remove-ClaudeServer $before
    if ($r.Changed) { Save-ClaudeConfigText $path $r.Text $before }
    return @{ Ok = $true; Changed = $r.Changed; Error = '' }
  } catch { return @{ Ok = $false; Changed = $false; Error = $_.Exception.Message } }
}

# ---------------------------------------------------------------- Settings > Use with AI: what comes first
# With sync, the link (it works in Claude and ChatGPT on the web and the phone too); without, Claude Desktop on this
# PC (no sync needed). The other ways come after it. (worker/public/js/ai.js aiOptions, the same rule)
function Get-AiOptions([bool]$Sync) {
  if ($Sync) { return @('link', 'desktop', 'files') }
  return @('desktop', 'link', 'files')
}
