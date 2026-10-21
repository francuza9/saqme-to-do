# The app updater on Windows (docs/setup.md, "Updating"): its rules, and what the widget (Settings > Updates),
# desktop\update.ps1 and scripts\setup.ps1 -Update share. The rules are local/update.mjs's (Linux and macOS),
# checked against shared/fixtures/update.json by desktop\tests\shared-fixtures.tests.ps1. Needs sync-core.ps1.
#
# Install layout (%LOCALAPPDATA%\Programs\SaqmeToDo, setup.ps1 writes it):
#   versions\<X.Y.Z>\     one folder per version (widget.ps1 and the rest); never changed once there
#   current.txt           the version that runs (start-widget.vbs reads it); previous.txt the one before it.
#                         Switching is one atomic replace of current.txt, going back is the same
#   start-widget.vbs, assets\, setup.ps1   what shortcuts, the saqme: link and Settings > Apps point at
#   cloud\                where the user's own Worker is deployed from (wrangler's node_modules stay there)
#   node\                 Node.js, when setup downloaded it (for the Worker only)
#   update\               downloads, what an update is doing (status.json) and how it ended (result.json)
# The lists and the data folder are never touched.

$script:MaxAssetBytes = 100000000
$script:ReleaseManifest = 'saqme-release.json'

# 'X.Y.Z' (an optional leading v, spaces around) -> @(X, Y, Z), or $null
function ConvertTo-SaqmeVersion([string]$v) {
  if ($v -match '^\s*v?([0-9]+)\.([0-9]+)\.([0-9]+)\s*\z') { return @([long]$matches[1], [long]$matches[2], [long]$matches[3]) }
  return $null
}
# -1 | 0 | 1, or $null when one of them is not X.Y.Z
function Compare-SaqmeVersion([string]$a, [string]$b) {
  $x = ConvertTo-SaqmeVersion $a; $y = ConvertTo-SaqmeVersion $b
  if ($null -eq $x -or $null -eq $y) { return $null }
  for ($i = 0; $i -lt 3; $i++) { if ($x[$i] -ne $y[$i]) { if ($x[$i] -lt $y[$i]) { return -1 } else { return 1 } } }
  return 0
}
function Test-JsonInt($v) { return ($v -is [int] -or $v -is [long]) }

# The release manifest (scripts/build-release.mjs writes it) -> what the updater uses of it, or $null
function Test-ReleaseManifest($m) {
  if (-not ($m -is [System.Collections.IDictionary])) { return $null }
  if (-not (Test-JsonInt $m['schema']) -or $m['schema'] -ne 1) { return $null }
  $v = ConvertTo-SaqmeVersion ([string]$m['version'])
  if ($null -eq $v) { return $null }
  $version = $v -join '.'
  if (-not ($m['tag'] -is [string]) -or $m['tag'] -cne "v$version") { return $null }
  $api = $m['api']; $min = $m['minWorkerApi']
  if (-not (Test-JsonInt $api) -or $api -lt 1 -or -not (Test-JsonInt $min) -or $min -lt 1 -or $min -gt $api) { return $null }
  $a = $m['asset']
  if (-not ($a -is [System.Collections.IDictionary]) -or -not ($a['name'] -is [string]) -or $a['name'] -cne "saqme-$version.zip") { return $null }
  if (-not (Test-JsonInt $a['size']) -or $a['size'] -lt 1 -or $a['size'] -gt $script:MaxAssetBytes) { return $null }
  if (-not ($a['sha256'] -is [string]) -or $a['sha256'] -notmatch '^[0-9a-fA-F]{64}\z') { return $null }
  return @{ version = $version; tag = [string]$m['tag']; api = [long]$api; minWorkerApi = [long]$min; asset = [string]$a['name']; size = [long]$a['size']; sha256 = ([string]$a['sha256']).ToLowerInvariant() }
}

# Whether the apps may switch to the new release, given how updating the user's own Worker went
# (none | ok | needs-login | failed) and the API of the Worker that runs ($null: unknown, taken as 1):
# 'apply' | 'apply-pending' (the apps switch, the Worker is tried again later) | 'hold' (nothing changes)
function Get-UpdateDecision([string]$Deploy, $WorkerApi, [long]$MinWorkerApi) {
  if ($Deploy -eq 'none' -or $Deploy -eq 'ok') { return 'apply' }
  $api = $(if (Test-JsonInt $WorkerApi) { [long]$WorkerApi } else { 1 })
  if ($api -ge $MinWorkerApi) { return 'apply-pending' }
  return 'hold'
}

# This app's version and the repository it updates from: release.json next to it (written by setup from
# worker\package.json, the version's single source), or ..\worker\package.json in a copy of the repository
function Get-AppRelease([string]$dir) {
  foreach ($p in @((Join-Path $dir 'release.json'), (Join-Path $dir '..\worker\package.json'))) {
    $t = Read-TextFile $p
    if (-not $t) { continue }
    try { $j = ConvertFrom-JsonText $t } catch { continue }
    if (-not ($j -is [System.Collections.IDictionary]) -or -not $j['version']) { continue }
    $repo = ''   # (worker\package.json "repository" is the one place it is written: CONTRIBUTING.md, forks)
    if ($j['repo']) { $repo = [string]$j['repo'] }
    elseif ($j['repository'] -is [System.Collections.IDictionary] -and [string]$j['repository']['url'] -match 'github\.com/([^/]+/[^/.]+)') { $repo = $matches[1] }
    return @{ Version = [string]$j['version']; Repo = $repo }
  }
  return @{ Version = '0.0.0'; Repo = '' }
}

# The install's folder when this app runs from <install>\versions\<v>, else $null (a copy of the repository:
# it does not update itself)
function Get-InstallRoot([string]$dir) {
  $parent = Split-Path -Parent $dir
  if ($parent -and (Split-Path -Leaf $parent) -eq 'versions') { return (Split-Path -Parent $parent) }
  return $null
}
function Read-VersionPointer([string]$root, [string]$name = 'current.txt') {
  $t = Read-TextFile (Join-Path $root $name)
  if ($t) { return $t.Trim() }
  return ''
}
# writes current.txt (or previous.txt) so that it is never half there: a new file replaces the old one at once
function Write-VersionPointer([string]$root, [string]$version, [string]$name = 'current.txt') {
  $path = Join-Path $root $name
  $tmp = "$path.$([guid]::NewGuid().ToString('N').Substring(0, 6)).tmp"
  [IO.File]::WriteAllText($tmp, "$version`r`n", (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $path) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
}

# ---------------------------------------------------------------- downloads (github.com, https only)
function Get-ReleaseUrls([string]$repo, $m) {
  return @{ Manifest = "https://github.com/$repo/releases/latest/download/$($script:ReleaseManifest)"
            Asset = $(if ($m) { "https://github.com/$repo/releases/download/$($m.tag)/$($m.asset)" } else { '' }) }
}
# GET with redirects (GitHub sends release files from its own download host), https only, at most $max bytes;
# to a file, or -> @{ Status; Bytes }
function Invoke-HttpGet([string]$url, [int]$timeoutMs, [long]$max, [string]$toFile = '') {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $req = [Net.HttpWebRequest]::Create($url)
  $req.Method = 'GET'; $req.Timeout = $timeoutMs; $req.ReadWriteTimeout = $timeoutMs; $req.AllowAutoRedirect = $true
  $req.UserAgent = 'SaqmeToDo-Updater'
  try { $resp = $req.GetResponse() }
  catch [Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { throw (New-Object Exception ("offline: " + $_.Exception.Message)) }
  }
  try {
    $code = [int]$resp.StatusCode
    if ($resp.ResponseUri.Scheme -ne 'https') { throw (New-Object Exception 'the download left https') }
    if ($code -ne 200) { return @{ Status = $code } }
    if ($resp.ContentLength -gt $max) { throw (New-Object Exception 'the download is larger than the release says') }
    $in = $resp.GetResponseStream()
    $out = $(if ($toFile) { [IO.File]::Create($toFile) } else { New-Object IO.MemoryStream })
    try {
      $buf = New-Object byte[] 65536
      $total = [long]0
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $total += $n
        if ($total -gt $max) { throw (New-Object Exception 'the download is larger than the release says') }
        $out.Write($buf, 0, $n)
      }
      if ($toFile) { return @{ Status = 200; Size = $total } }
      return @{ Status = 200; Bytes = $out.ToArray() }
    } finally { $out.Dispose(); $in.Dispose() }
  } finally { $resp.Dispose() }
}

# The newest published release -> @{ Ok; Manifest (checked; $null: none published yet); Error }
function Get-LatestRelease([string]$repo, [int]$timeoutMs = 20000) {
  if ($repo -notmatch '^[\w.-]+/[\w.-]+$') { return @{ Ok = $false; Error = 'This copy does not say where it is published (worker\package.json, "repository").' } }
  $urls = Get-ReleaseUrls $repo $null
  try { $r = Invoke-HttpGet $urls.Manifest $timeoutMs 65536 }
  catch { return @{ Ok = $false; Error = "Could not reach GitHub ($($_.Exception.Message -replace '^offline: ', ''))." } }
  if ($r.Status -eq 404) { return @{ Ok = $true; Manifest = $null } }
  if ($r.Status -ne 200) { return @{ Ok = $false; Error = "GitHub answered $($r.Status)." } }
  $m = $null
  try { $m = Test-ReleaseManifest (ConvertFrom-JsonText ([Text.Encoding]::UTF8.GetString($r.Bytes))) } catch {}
  if (-not $m) { return @{ Ok = $false; Error = 'The release on GitHub has no valid manifest.' } }
  return @{ Ok = $true; Manifest = $m }
}

# '' when the file is the manifest's (size and SHA-256), else what is wrong with it
function Test-AssetFile([string]$path, $m) {
  if (-not (Test-Path -LiteralPath $path)) { return 'The download is missing.' }
  $len = (Get-Item -LiteralPath $path).Length
  if ($len -ne $m.size) { return "The download has $len bytes; the release says $($m.size)." }
  $h = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($h -ne $m.sha256) { return 'The download does not match the checksum of the release.' }
  return ''
}

# Downloads a release's zip to $file and checks it -> '' or what went wrong (nothing is left behind then)
function Save-ReleaseAsset([string]$repo, $m, [string]$file) {
  $part = "$file.part"
  try {
    $r = Invoke-HttpGet (Get-ReleaseUrls $repo $m).Asset 600000 $m.size $part
    if ($r.Status -ne 200) { throw (New-Object Exception "GitHub answered $($r.Status) for $($m.asset)") }
  } catch {
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    return "Could not download the update ($($_.Exception.Message -replace '^offline: ', ''))."
  }
  $bad = Test-AssetFile $part $m
  if ($bad) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue; return $bad }
  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
  Move-Item -LiteralPath $part -Destination $file
  return ''
}

# ---------------------------------------------------------------- what the widget shows
function Read-UpdateFile([string]$root, [string]$name) {
  if (-not $root) { return $null }
  $t = Read-TextFile (Join-Path $root "update\$name")
  if (-not $t) { return $null }
  try { return (ConvertFrom-JsonText $t) } catch { return $null }
}
function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
