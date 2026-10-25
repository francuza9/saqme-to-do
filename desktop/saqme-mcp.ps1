# What Claude Desktop's settings point at once Saqme To Do is installed (Settings > Use with AI > Connect Claude Desktop):
# setup.ps1 copies this file next to versions\, where it stays when the app updates itself, and it runs the current
# version's mcp-server.ps1 (current.txt; previous.txt while current.txt names a folder that is not there). Only the
# server's answers may reach stdout: everything else from here goes nowhere.
param([string]$DataDir)
$root = $PSScriptRoot
foreach ($pointer in 'current.txt', 'previous.txt') {
  $v = ''
  try { $v = ([IO.File]::ReadAllText((Join-Path $root $pointer))).Trim() } catch { continue }
  if ($v -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}\z') { continue }
  $server = Join-Path $root "versions\$v\mcp-server.ps1"
  if (-not (Test-Path -LiteralPath $server)) { continue }
  & $server -DataDir $DataDir | Out-Null
  exit $LASTEXITCODE
}
[Console]::Error.WriteLine("Saqme To Do: no installed version in $root (run its setup again)")
exit 1
