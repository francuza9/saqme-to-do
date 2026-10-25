<#
.SYNOPSIS
  Saqme To Do for Claude Desktop, without sync: what Claude Desktop starts when Settings > Use with AI > Connect Claude
  Desktop added Saqme to its settings (desktop/claude-desktop.ps1). Windows PowerShell 5.1, nothing to install.

.DESCRIPTION
  An MCP server over stdio: one JSON-RPC message per line on stdin, one answer per line on stdout (nothing else goes
  there). The tools, their descriptions and the instructions for the model are the Worker connector's
  (desktop/mcp-tools.json, made from worker/src/mcp.js); they work on the lists folder (desktop/mcp-core.ps1), and the
  app picks the changes up like any other program's edit.

  Claude Desktop from the Microsoft Store is an MSIX app: the programs it starts see its private copy of AppData, where
  a file written into %APPDATA%\SaqmeToDo would land in the copy, and a replaced one could vanish from the real folder
  (docs/sync.md, "Another app's private copy of AppData"). So when this runs inside such a copy and the lists are in
  AppData, it starts itself again outside (WMI, as the app does) and only passes the lines through, over a named pipe
  with a random name that only this user can open. If that cannot be done, every tool says so and nothing is touched.

  -DataDir  the app's data folder (Connect Claude Desktop writes it into Claude's settings; default %APPDATA%\SaqmeToDo)
  -Pipe     (internal) the half started outside: connect to that pipe and serve it
#>
param([string]$DataDir, [string]$Pipe)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'sync-core.ps1')
. (Join-Path $PSScriptRoot 'update-core.ps1')
. (Join-Path $PSScriptRoot 'mcp-core.ps1')

if (-not $DataDir) { $DataDir = Join-Path $env:APPDATA 'SaqmeToDo' }
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$script:McpVersion = (Get-AppRelease $PSScriptRoot).Version
$def = Read-McpDefinitions (Join-Path $PSScriptRoot 'mcp-tools.json')
$ctx = New-McpContext $DataDir

# the lines in, the answers out (until the input ends)
function Invoke-McpLoop($reader, $writer) {
  while ($null -ne ($line = $reader.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $answer = $null
    try { $answer = Invoke-McpMessage $ctx $def $line }
    catch {
      Write-McpLog $ctx "error: $($_.Exception.Message)"
      $answer = ConvertTo-JsonText (New-McpError $null -32603 'internal error')
    }
    if ($answer) { $writer.WriteLine($answer); $writer.Flush() }
  }
}
function New-LineWriter($stream) {
  $w = New-Object IO.StreamWriter($stream, $script:Utf8NoBom)
  $w.NewLine = "`n"; $w.AutoFlush = $true
  return $w
}
$utf8 = New-Object System.Text.UTF8Encoding($false)

if ($Pipe) {
  # started outside the container (below): read the lines from one pipe, answer on the other; refuse if this process,
  # too, sees a private copy
  if ((Test-InAppData $DataDir) -and (Get-AppDataRedirect)) { $ctx.Refused = "Saqme could not reach your real lists folder from Claude Desktop (Windows gave it $(Get-AppDataRedirect)'s private copy of AppData), so nothing was changed. Ask the user to update Saqme To Do, or to turn on sync and connect Claude with the link instead." }
  $fromClaude = New-Object System.IO.Pipes.NamedPipeClientStream('.', "$Pipe-in", [System.IO.Pipes.PipeDirection]::In)
  $toClaude = New-Object System.IO.Pipes.NamedPipeClientStream('.', "$Pipe-out", [System.IO.Pipes.PipeDirection]::Out)
  $fromClaude.Connect(15000); $toClaude.Connect(15000)
  Write-McpLog $ctx 'started (outside Claude Desktop''s private copy of AppData)'
  try { Invoke-McpLoop (New-Object IO.StreamReader($fromClaude, $utf8, $false)) (New-LineWriter $toClaude) | Out-Null }
  finally { $toClaude.Dispose(); $fromClaude.Dispose(); Write-McpLog $ctx 'stopped' }
  exit 0
}

if ((Test-InAppData $DataDir) -and (Get-AppDataRedirect)) {
  # inside Claude Desktop's container: the same script, outside it, does the work; this passes the bytes through, one
  # pipe each way (so the end of Claude's input reaches it as the end of a pipe, and its last answers still come back)
  $why = ''
  $pipes = @()
  try {
    $name = 'saqme-mcp-' + [guid]::NewGuid().ToString('N')
    $sec = New-Object System.IO.Pipes.PipeSecurity
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $sec.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))
    $newPipe = { param([string]$n, $dir) New-Object System.IO.Pipes.NamedPipeServerStream($n, $dir, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous, 65536, 65536, $sec) }
    $toServer = & $newPipe "$name-in" ([System.IO.Pipes.PipeDirection]::Out)
    $fromServer = & $newPipe "$name-out" ([System.IO.Pipes.PipeDirection]::In)
    $pipes = @($toServer, $fromServer)
    $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $cmd = "`"$ps`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -DataDir `"$DataDir`" -Pipe $name"
    if (-not (Start-OutsideContainer $cmd)) { $why = 'Windows did not let it start outside Claude Desktop' }
    else {
      $w1 = $toServer.BeginWaitForConnection($null, $null); $w2 = $fromServer.BeginWaitForConnection($null, $null)
      if (-not $w1.AsyncWaitHandle.WaitOne(30000) -or -not $w2.AsyncWaitHandle.WaitOne(5000)) { $why = 'it did not start in time' }
      else {
        $toServer.EndWaitForConnection($w1); $fromServer.EndWaitForConnection($w2)
        $stdin = [Console]::OpenStandardInput(); $stdout = [Console]::OpenStandardOutput()
        $up = $stdin.CopyToAsync($toServer); $down = $fromServer.CopyToAsync($stdout)
        if ([Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($up, $down)) -eq 0) {
          # Claude's input ended: the other half finishes what it got, answers, and closes its pipe
          $toServer.Dispose()
          [void]$down.Wait(60000)
        }
        foreach ($x in $pipes) { $x.Dispose() }
        exit 0
      }
    }
  } catch { $why = $_.Exception.Message }
  foreach ($x in $pipes) { try { $x.Dispose() } catch {} }
  $ctx.Refused = "Saqme could not start outside Claude Desktop's private copy of AppData ($why), so it did not touch the lists: from inside that copy, a change could land in the copy instead of the user's real lists folder. Ask the user to close Claude Desktop completely and open it again; if that does not help, to turn on sync in Saqme and connect Claude with the link instead."
}

# here: on the stdin and stdout Claude Desktop gave this process
$in = New-Object IO.StreamReader([Console]::OpenStandardInput(), $utf8, $false)
Invoke-McpLoop $in (New-LineWriter ([Console]::OpenStandardOutput())) | Out-Null
exit 0
