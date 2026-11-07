# Saqme To Do - the Windows app's words in its languages. Dot-source it; it only defines functions and the current
# language. The words are the phone app's files, worker\public\js\lang\<code>.js (installed as lang\<code>.js): a
# JavaScript module whose body is plain JSON, read here as UTF-8. English is the fallback for anything missing.
#   T 'key' @{ name = ... }      a message; {name} in it is filled in
#   TN 'key' $n @{ ... }         a count: 'key.one' or 'key.other' ({n} is filled in)
#   Set-AppLanguage 'ka'         switches (an unknown code or '' picks the system's language, else English)
#   Get-DueText / Get-DueLongText   a deadline's label in the current language (English: rules.ps1 Due-Label)
# This file stays ASCII (Windows PowerShell reads scripts without a BOM in the ANSI code page): no words in here.

$script:Langs = @('en', 'ka', 'fr', 'es', 'de')
$script:LangCultures = @{ en = 'en-GB'; ka = 'ka-GE'; fr = 'fr-FR'; es = 'es-ES'; de = 'de-DE' }
$script:LangDirs = @((Join-Path $PSScriptRoot 'lang'), (Join-Path $PSScriptRoot '..\worker\public\js\lang'))
$script:LangCache = @{}

# one language's file -> hashtable key -> text (case-sensitive), or $null when it is not there or not readable
function Read-LangFile([string]$code) {
  if ($script:LangCache.ContainsKey($code)) { return $script:LangCache[$code] }
  $table = $null
  foreach ($d in $script:LangDirs) {
    $p = Join-Path $d "$code.js"
    if (-not (Test-Path -LiteralPath $p)) { continue }
    try {
      $raw = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
      $a = $raw.IndexOf('{', $raw.IndexOf('export default')); $b = $raw.LastIndexOf('}')
      $obj = ConvertFrom-Json $raw.Substring($a, $b - $a + 1)
      $table = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
      foreach ($prop in $obj.PSObject.Properties) { $table[$prop.Name] = [string]$prop.Value }
    } catch { $table = $null }
    break
  }
  $script:LangCache[$code] = $table
  return $table
}

# the language to use: the one chosen in Settings, else the system's (Windows display language) if the app has it,
# else English
function Get-PickedLanguage([string]$choice, [string]$system = [Globalization.CultureInfo]::CurrentUICulture.Name) {
  if ($script:Langs -ccontains $choice) { return $choice }
  $code = ([string]$system).ToLowerInvariant().Split('-_')[0]
  if ($script:Langs -ccontains $code) { return $code }
  return 'en'
}

function Set-AppLanguage([string]$choice) {
  $code = Get-PickedLanguage $choice
  $table = Read-LangFile $code
  if (-not $table) { $code = 'en'; $table = Read-LangFile 'en' }
  $script:Lang = $code
  $script:LangTable = $table
  $script:LangEn = Read-LangFile 'en'
  $script:LangCulture = [Globalization.CultureInfo]::GetCultureInfo($script:LangCultures[$code])
  return $code
}

function T([string]$key, $vars = $null) {
  $s = $null
  if ($script:LangTable -and $script:LangTable.TryGetValue($key, [ref]$s)) {}
  elseif ($script:LangEn -and $script:LangEn.TryGetValue($key, [ref]$s)) {}
  else { $s = $key }
  if ($vars) { foreach ($k in @($vars.Keys)) { $s = $s.Replace('{' + $k + '}', [string]$vars[$k]) } }
  return $s
}

# a count's form, as Intl.PluralRules has it for these languages: one for 1 (French: 0 and 1), other for the rest
function TN([string]$key, [long]$n, $vars = $null) {
  $one = ($n -eq 1 -or ($script:Lang -ceq 'fr' -and $n -eq 0))
  $all = @{ n = $n }
  if ($vars) { foreach ($k in @($vars.Keys)) { $all[$k] = $vars[$k] } }
  return (T $(if ($one) { "$key.one" } else { "$key.other" }) $all)
}

# the name of a language in itself ("Deutsch"), for the picker
function Get-LanguageName([string]$code) {
  $t = Read-LangFile $code
  if ($t -and $t.ContainsKey('lang.name')) { return $t['lang.name'] }
  return $code
}

# A deadline's short label in the current language: English keeps the app's own forms (Due-Label, rules.ps1: shared
# with the phone app's fixtures); the others use the culture's weekday and month names (as Intl does on the phone).
function Get-DueText([datetime]$d, [datetime]$Now = (Get-Date)) {
  if ($script:Lang -ceq 'en' -or -not $script:LangCulture) { return (Due-Label $d $Now) }
  $diff = ($d.Date - $Now.Date).Days
  if ($diff -eq 0) { return (T 'date.today') }
  if ($diff -eq 1) { return (T 'date.tomorrow') }
  if ($diff -eq -1) { return (T 'date.yesterday') }
  $ci = $script:LangCulture
  if ($diff -gt 1 -and $diff -lt 7) { return $d.ToString('ddd', $ci) }
  $f = $(if ($script:Lang -ceq 'de') { 'd. MMM' } else { 'd MMM' })
  if ($d.Year -eq $Now.Year) { return $d.ToString($f, $ci) }
  return $d.ToString("$f yyyy", $ci)
}

# a deadline in full: "Friday, 17 October 2026, 14:00"
function Get-DueLongText([datetime]$d, [string]$time = '') {
  $s = $(if ($script:Lang -ceq 'en' -or -not $script:LangCulture) { $d.ToString('dddd, d MMMM yyyy', [Globalization.CultureInfo]::InvariantCulture) } else { $d.ToString('D', $script:LangCulture) })
  if ($time) { $s += ", $time" }
  return $s
}

[void](Set-AppLanguage 'en')
