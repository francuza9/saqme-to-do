<#
.SYNOPSIS
  The 2026-10-22 incident, reproduced in a scratch folder, and the checks that it cannot happen again (docs/sync.md,
  "Another app's private copy of AppData"). Run it from a shell inside a Store app's container (an AI assistant's
  shell in Claude Desktop): elsewhere it says so and stops.

.DESCRIPTION
  1. Reproduces it: a folder in AppData that exists both in the app's private copy and in the real AppData, a file
     only the real folder has, and the save the app used to make (temp file + File.Replace) from inside the container:
     the real file is gone afterwards (checked through WMI, which sees the real folder).
  2. Checks the fix: the engine refuses that save (and a whole plan); the widget and the updater refuse to run on a
     data folder in AppData (with -Relaunched, so they do not actually start again); a program started through WMI
     (how they start again) is outside the container.
  3. Claude Desktop's local server (desktop/mcp-server.ps1, Connect Claude Desktop), started from in here as Claude
     Desktop starts it: it does its work outside, on the real folder (a list only the app's copy has is not seen, a
     new task lands in the real file, nothing in the copy).
  Never touches %APPDATA%\SaqmeToDo; the scratch folder goes from both copies at the end.
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repo 'desktop\sync-core.ps1')
$script:failed = 0
function Check([bool]$ok, [string]$what) {
  if ($ok) { Write-Host "  ok   $what" } else { Write-Host "  FAIL $what" -ForegroundColor Red; $script:failed++ }
}
$app = Get-AppDataRedirect -Fresh
if (-not $app) { Write-Host 'This shell sees the real AppData (it is not inside another app''s container): nothing to check here.'; exit 0 }
Write-Host "This shell sees $app's private copy of AppData."

$name = 'SaqmeContainerCheck-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$here = Join-Path $env:APPDATA $name                                                  # what this shell sees (merged)
$private = Join-Path $env:LOCALAPPDATA "Packages\$app\LocalCache\Roaming\$name"       # the app's copy, seen directly
$q = [char]39
function Get-RealFiles([string]$dir = $here) {   # the real folder, through the WMI service (outside the container)
  $p = ($dir.Substring(2) -replace '\\', '\\') + '\\'
  return @(Get-CimInstance -ClassName CIM_DataFile -Filter ("Drive=$q$($dir.Substring(0, 2))$q AND Path=$q$p$q") | ForEach-Object { [IO.Path]::GetFileName($_.Name) } | Sort-Object)
}
function Invoke-Outside([string]$cmd) {   # a cmd.exe line, run outside the container; waits for it
  if (-not (Start-OutsideContainer "cmd.exe /c $cmd")) { throw 'WMI could not start a process' }
  Start-Sleep -Milliseconds 1500
}
try {
  Write-Host '1. The incident'
  [void](New-Item -ItemType Directory -Path $here)                       # made in here: lands in the app's copy
  Check (Test-Path -LiteralPath $private) 'a folder made in here lands in the app''s copy'
  Invoke-Outside "mkdir `"$here`" & echo real> `"$here\List.md`""           # the same folder in the real AppData, with a list
  Check ((Get-RealFiles) -contains 'List.md') 'the real folder has List.md (made outside)'
  Check (Test-Path -LiteralPath (Join-Path $here 'List.md')) 'this shell sees it too (a merged view)'
  $tmp = Join-Path $here '.List.md.check.tmp'
  [IO.File]::WriteAllText($tmp, "changed`r`n")
  [IO.File]::Replace($tmp, (Join-Path $here 'List.md'), [NullString]::Value)   # how the app saved a list before 1.2.3
  Check (-not ((Get-RealFiles) -contains 'List.md')) 'REPRODUCED: that save deleted List.md from the real folder'
  Check (Test-Path -LiteralPath (Join-Path $private 'List.md')) '... and put the new one in the app''s copy only'

  Write-Host '2. The fix'
  Invoke-Outside "echo real> `"$here\Work.md`""
  $threw = ''; try { Write-TextFileAtomic (Join-Path $here 'Work.md') "changed`n" } catch { $threw = $_.Exception.Message }
  Check ([bool]$threw) "the engine refuses to save a list in AppData from in here ($($threw.Substring(0, [Math]::Min(48, $threw.Length)))...)"
  Check ((Get-RealFiles) -contains 'Work.md') 'the real Work.md is still there'
  $threw = ''; try { [void](Invoke-PlanOps @(@{ type = 'trash'; path = (Join-Path $here 'Work.md'); name = 'Work'; expected = $null }) $here) } catch { $threw = $_.Exception.Message }
  Check ([bool]$threw -and (Get-RealFiles) -contains 'Work.md') 'a plan (rename, move to .trash) is refused too'

  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $data = Join-Path $here 'data'
  $out = & $ps -NoProfile -ExecutionPolicy Bypass -STA -File (Join-Path $repo 'desktop\widget.ps1') -DataDir $data -Relaunched 2>&1 | Out-String
  Check ($LASTEXITCODE -eq 3 -and $out -match 'REFUSED') "the widget does not start on a data folder in AppData from in here (exit $LASTEXITCODE)"
  Check (-not (Test-Path -LiteralPath $data)) '... and makes nothing there'
  $inst = Join-Path $here 'install'
  & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'desktop\update.ps1') -AppDir $inst -DataDir $data -Relaunched | Out-Null
  Check ($LASTEXITCODE -eq 4 -and -not (Test-Path -LiteralPath $inst)) "the updater does nothing from in here (exit $LASTEXITCODE)"

  # how they start again: through WMI, outside the container (that process checks for itself)
  $res = Join-Path ([IO.Path]::GetTempPath()) "$name-outside.txt"
  $probe = ". '$(Join-Path $repo 'desktop\sync-core.ps1')'; [IO.File]::WriteAllText('$res', 'seen:' + (Get-AppDataRedirect -Fresh))"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
  Check (Start-OutsideContainer "`"$ps`" -NoProfile -ExecutionPolicy Bypass -EncodedCommand $enc") 'a program started through WMI'
  for ($i = 0; $i -lt 40 -and -not (Test-Path -LiteralPath $res); $i++) { Start-Sleep -Milliseconds 250 }
  $seen = $(if (Test-Path -LiteralPath $res) { [IO.File]::ReadAllText($res) } else { '(no answer)' })
  Check ($seen -eq 'seen:') "... sees the real AppData ($seen)"
  Remove-Item -LiteralPath $res -Force -ErrorAction SilentlyContinue

  Write-Host '3. Claude Desktop''s local server'
  $mcpData = Join-Path $here 'mcp'
  function Invoke-OutsidePs([string]$code, [string]$wait) {   # PowerShell code, run outside the container; waits for $wait
    [void](Start-OutsideContainer "`"$ps`" -NoProfile -ExecutionPolicy Bypass -EncodedCommand $([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code)))")
    for ($i = 0; $i -lt 60 -and -not (Test-Path -LiteralPath $wait); $i++) { Start-Sleep -Milliseconds 250 }
  }
  $done = Join-Path ([IO.Path]::GetTempPath()) "$name-mcp.txt"
  Invoke-OutsidePs ("[void](New-Item -ItemType Directory -Force -Path '$mcpData\lists'); " +
    "[IO.File]::WriteAllText('$mcpData\lists\Work.md', '# Work' + [char]10 + '- [ ] Real task ^rrrrrrrr' + [char]10); [IO.File]::WriteAllText('$done', 'ok')") $done
  Remove-Item -LiteralPath $done -Force -ErrorAction SilentlyContinue
  Check ((Get-RealFiles (Join-Path $mcpData 'lists')) -contains 'Work.md') 'a real lists folder in AppData (made outside)'
  [void](New-Item -ItemType Directory -Force -Path (Join-Path $private 'mcp\lists'))   # a list in the app's copy only (as an earlier run left them)
  [IO.File]::WriteAllText((Join-Path $private 'mcp\lists\Stale.md'), "# Stale`n- [ ] Only in the copy ^ssssssss`n")
  Check ((Test-Path -LiteralPath (Join-Path $private 'mcp\lists\Stale.md')) -and -not ((Get-RealFiles (Join-Path $mcpData 'lists')) -contains 'Stale.md')) 'a list only the app''s copy has'
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $ps
  $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $repo 'desktop\mcp-server.ps1')`" -DataDir `"$mcpData`""
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $proc = [Diagnostics.Process]::Start($psi)
  $in = New-Object IO.StreamWriter($proc.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding($false))); $in.NewLine = "`n"; $in.AutoFlush = $true
  $in.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')
  $in.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_lists","arguments":{}}}')
  $in.WriteLine('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_tasks","arguments":{"list":"Work","tasks":[{"text":"Added from Claude"}]}}}')
  $in.Close()
  $out = $proc.StandardOutput.ReadToEnd(); $err = $proc.StandardError.ReadToEnd()
  [void]$proc.WaitForExit(60000)
  $answers = @($out -split "`n" | Where-Object { $_ } | ForEach-Object { ConvertFrom-JsonText $_ })
  Check ($answers.Count -eq 3) "three answers through the pipe ($($answers.Count) $err)"
  $names = ''
  if ($answers.Count -ge 2 -and $answers[1]['result']['structuredContent']) { $names = @($answers[1]['result']['structuredContent']['lists'] | ForEach-Object { $_['name'] }) -join ',' }
  elseif ($answers.Count -ge 2) { $names = [string]$answers[1]['result']['content'][0]['text'] }
  Check ($names -eq 'Work') "it sees the real folder, not the app's copy (lists: $names)"
  $copy = Join-Path ([IO.Path]::GetTempPath()) "$name-work.txt"
  Invoke-OutsidePs "Copy-Item -LiteralPath '$mcpData\lists\Work.md' -Destination '$copy'" $copy
  $real = $(if (Test-Path -LiteralPath $copy) { [IO.File]::ReadAllText($copy) } else { '' })
  Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue
  Check ($real -match '- \[ \] Real task \^rrrrrrrr\n- \[ \] Added from Claude \^[0-9a-z]{8}\n$') "the new task is in the real Work.md ($($real.Replace("`n", ' | ')))"
  Check (-not (Test-Path -LiteralPath (Join-Path $private 'mcp\lists\Work.md'))) 'and nothing landed in the app''s copy'
} finally {
  Remove-Item -LiteralPath $private -Recurse -Force -ErrorAction SilentlyContinue
  try { Invoke-Outside "rmdir /s /q `"$here`"" } catch {}
  Check (-not (Test-Path -LiteralPath $private) -and @(Get-RealFiles).Count -eq 0) 'the scratch folder is gone from both copies'
}
Write-Host ''
if ($script:failed) { Write-Host "$script:failed failed"; exit 1 }
Write-Host 'container check OK'
