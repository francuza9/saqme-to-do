# Dependency-free QR Code encoder (ISO/IEC 18004, model 2): byte mode, UTF-8 input, EC levels L/M/Q/H.
# Port of worker/public/js/qr.js and MUST produce the identical matrix (same version choice, same mask
# penalty and tie-breaks): keep any algorithm change in sync there. Dot-source it; it only defines
#   Get-QrMatrix -Text <string> [-Ecl L|M|Q|H]  -> array of rows, each a [bool[]] (true = dark), no quiet zone
#   ConvertTo-QrText <matrix>                  -> one '1'/'0' string per row
# PowerShell 5.1 is slow at function calls and per-element loops, so the hot parts use flat typed arrays
# (index = y * size + x), precomputed index lists, and .NET string searches over row/column strings.

function Get-QrMatrix {
  param([string]$Text, [string]$Ecl = 'M')
  if ($Ecl -notmatch '^[LMQH]\z') { throw "Get-QrMatrix: invalid error correction level '$Ecl' (use L, M, Q or H)" }
  $e = 'LMQH'.IndexOf([char]$Ecl.ToUpperInvariant())
  $eclFormat = [int[]](1, 0, 3, 2)  # 2-bit EC level code in the format info

  # Per EC level (L, M, Q, H), indexed by version (index 0 unused): EC codewords per block, number of blocks.
  $ecPerBlock = @(
    [int[]](0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    [int[]](0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
    [int[]](0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    [int[]](0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30))
  $numBlocks = @(
    [int[]](0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25),
    [int[]](0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49),
    [int[]](0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68),
    [int[]](0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81))

  # Modules available for data + EC codewords (everything except function patterns and format/version info).
  function rawModules([int]$v) {
    $r = (16 * $v + 128) * $v + 64
    if ($v -ge 2) {
      $al = ($v - $v % 7) / 7 + 2
      $r -= (25 * $al - 10) * $al - 55
      if ($v -ge 7) { $r -= 36 }
    }
    $r
  }
  function dataCodewords([int]$v) { ((rawModules $v) -shr 3) - $ecPerBlock[$e][$v] * $numBlocks[$e][$v] }

  # 1. smallest version whose capacity fits mode (4 bits) + length (8 or 16 bits) + data
  [byte[]]$bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $n = $bytes.Length
  $ver = 1
  while ($ver -le 40 -and 4 + $(if ($ver -lt 10) { 8 } else { 16 }) + $n * 8 -gt (dataCodewords $ver) * 8) { $ver++ }
  if ($ver -gt 40) {
    $max = ((dataCodewords 40) * 8 - 20) -shr 3
    throw "Get-QrMatrix: $n bytes do not fit in a QR code at EC level $('LMQH'[$e]) (max $max)"
  }
  $ccBits = if ($ver -lt 10) { 8 } else { 16 }

  # 2. data codewords: mode 0100, count, bytes. The header is 12 or 20 bits, so the 4-bit terminator
  #    ends on a byte boundary; the rest is alternating pad bytes 0xEC 0x11.
  $dataLen = dataCodewords $ver
  $data = New-Object int[] $dataLen
  $vals = New-Object int[] ($n + 2); $lens = New-Object int[] ($n + 2)
  $vals[0] = 4; $lens[0] = 4; $vals[1] = $n; $lens[1] = $ccBits
  for ($i = 0; $i -lt $n; $i++) { $vals[$i + 2] = $bytes[$i]; $lens[$i + 2] = 8 }
  $bl = 0
  for ($f = 0; $f -lt $vals.Length; $f++) {
    for ($i = $lens[$f] - 1; $i -ge 0; $i--) {
      if (($vals[$f] -shr $i) -band 1) { $data[$bl -shr 3] = $data[$bl -shr 3] -bor (1 -shl (7 - ($bl -band 7))) }
      $bl++
    }
  }
  $pad = 0xEC
  for ($i = ($bl + 4) -shr 3; $i -lt $dataLen; $i++) { $data[$i] = $pad; $pad = $pad -bxor 0xFD }  # 0xEC <-> 0x11

  # GF(256) with primitive polynomial 0x11D: exp is doubled so exp[log[a] + log[b]] needs no modulo.
  $exp = New-Object int[] 512; $log = New-Object int[] 256
  $x = 1
  for ($i = 0; $i -lt 255; $i++) { $exp[$i] = $x; $log[$x] = $i; $x = $x -shl 1; if ($x -band 0x100) { $x = $x -bxor 0x11D } }
  for ($i = 255; $i -lt 512; $i++) { $exp[$i] = $exp[$i - 255] }

  # Reed-Solomon generator prod(x - a^i), i < ecLen; coefficients high to low, leading 1 omitted.
  $nb = $numBlocks[$e][$ver]; $ecLen = $ecPerBlock[$e][$ver]; $raw = (rawModules $ver) -shr 3
  $numShort = $nb - $raw % $nb; $shortLen = ($raw - $raw % $nb) / $nb - $ecLen  # data codewords in a short block
  $gen = New-Object int[] $ecLen; $gen[$ecLen - 1] = 1
  for ($i = 0; $i -lt $ecLen; $i++) {
    for ($j = 0; $j -lt $ecLen; $j++) {
      $t = 0
      if ($gen[$j]) { $t = $exp[$log[$gen[$j]] + $i] }
      if ($j + 1 -lt $ecLen) { $t = $t -bxor $gen[$j + 1] }
      $gen[$j] = $t
    }
  }

  # 3. per block: EC codewords = remainder of data(x) * x^ecLen / generator; then interleave column-wise
  $start = New-Object int[] $nb
  $ecAll = New-Object int[] ($nb * $ecLen)
  $r = New-Object int[] $ecLen
  $k = 0
  for ($b = 0; $b -lt $nb; $b++) {
    $len = $shortLen; if ($b -ge $numShort) { $len++ }
    $start[$b] = $k
    [Array]::Clear($r, 0, $ecLen)
    for ($i = $k; $i -lt $k + $len; $i++) {
      $fct = $data[$i] -bxor $r[0]
      [Array]::Copy($r, 1, $r, 0, $ecLen - 1); $r[$ecLen - 1] = 0
      if ($fct) {
        $lf = $log[$fct]
        for ($j = 0; $j -lt $ecLen; $j++) { if ($gen[$j]) { $r[$j] = $r[$j] -bxor $exp[$log[$gen[$j]] + $lf] } }
      }
    }
    [Array]::Copy($r, 0, $ecAll, $b * $ecLen, $ecLen)
    $k += $len
  }
  $cw = New-Object int[] $raw
  $o = 0
  for ($i = 0; $i -le $shortLen; $i++) {
    for ($b = 0; $b -lt $nb; $b++) { if ($i -lt $shortLen -or $b -ge $numShort) { $cw[$o] = $data[$start[$b] + $i]; $o++ } }
  }
  for ($i = 0; $i -lt $ecLen; $i++) { for ($b = 0; $b -lt $nb; $b++) { $cw[$o] = $ecAll[$b * $ecLen + $i]; $o++ } }

  # 4. function patterns: timing, finders (with separators), alignment, reserved format area, version info
  $size = $ver * 4 + 17
  $mod = New-Object int[] ($size * $size)
  $fn = New-Object bool[] ($size * $size)
  for ($i = 0; $i -lt $size; $i++) {
    $d = 1 - $i % 2
    $mod[$i * $size + 6] = $d; $fn[$i * $size + 6] = $true
    $mod[6 * $size + $i] = $d; $fn[6 * $size + $i] = $true
  }
  foreach ($c in @(@(3, 3), @(($size - 4), 3), @(3, ($size - 4)))) {
    for ($dy = -4; $dy -le 4; $dy++) {
      for ($dx = -4; $dx -le 4; $dx++) {
        $x = $c[0] + $dx; $y = $c[1] + $dy
        if ($x -lt 0 -or $x -ge $size -or $y -lt 0 -or $y -ge $size) { continue }
        $dist = [Math]::Max([Math]::Abs($dx), [Math]::Abs($dy))
        $mod[$y * $size + $x] = [int]($dist -ne 2 -and $dist -ne 4); $fn[$y * $size + $x] = $true
      }
    }
  }
  $al = @()  # alignment pattern centres (same list for rows and columns)
  if ($ver -gt 1) {
    $cnt = ($ver - $ver % 7) / 7 + 2
    $q = $ver * 8 + $cnt * 3 + 5; $dv = $cnt * 4 - 4
    $step = ($q - $q % $dv) / $dv * 2
    $al = New-Object int[] $cnt
    $al[0] = 6
    for ($i = $cnt - 1; $i -ge 1; $i--) { $al[$i] = $size - 7 - ($cnt - 1 - $i) * $step }
  }
  $last = $al.Length - 1
  for ($i = 0; $i -le $last; $i++) {
    for ($j = 0; $j -le $last; $j++) {
      if (($i -eq 0 -and $j -eq 0) -or ($i -eq 0 -and $j -eq $last) -or ($i -eq $last -and $j -eq 0)) { continue }  # finder corners
      for ($dy = -2; $dy -le 2; $dy++) {
        for ($dx = -2; $dx -le 2; $dx++) {
          $k = ($al[$j] + $dy) * $size + $al[$i] + $dx
          $mod[$k] = [int]([Math]::Max([Math]::Abs($dx), [Math]::Abs($dy)) -ne 1); $fn[$k] = $true
        }
      }
    }
  }
  # format info positions: bit i goes to fmtA[i] (around the top-left finder) and fmtB[i] (split copy)
  $fmtA = New-Object int[] 15; $fmtB = New-Object int[] 15
  for ($i = 0; $i -lt 15; $i++) {
    if ($i -lt 6) { $x = 8; $y = $i } elseif ($i -lt 8) { $x = 8; $y = $i + 1 } elseif ($i -eq 8) { $x = 7; $y = 8 } else { $x = 14 - $i; $y = 8 }
    $fmtA[$i] = $y * $size + $x
    if ($i -lt 8) { $x = $size - 1 - $i; $y = 8 } else { $x = 8; $y = $size - 15 + $i }
    $fmtB[$i] = $y * $size + $x
    $fn[$fmtA[$i]] = $true; $fn[$fmtB[$i]] = $true
  }
  $k = ($size - 8) * $size + 8; $mod[$k] = 1; $fn[$k] = $true  # the "dark module"
  if ($ver -ge 7) {  # 18-bit version info, BCH(18,6), in two 6x3 blocks
    $rem = $ver
    for ($i = 0; $i -lt 12; $i++) { $rem = ($rem -shl 1) -bxor (($rem -shr 11) * 0x1F25) }
    $bits = ($ver -shl 12) -bor $rem
    for ($i = 0; $i -lt 18; $i++) {
      $bit = ($bits -shr $i) -band 1; $a = $size - 11 + $i % 3; $c = ($i - $i % 3) / 3
      $mod[$c * $size + $a] = $bit; $fn[$c * $size + $a] = $true
      $mod[$a * $size + $c] = $bit; $fn[$a * $size + $c] = $true
    }
  }

  # 5. codeword bits in the zigzag: 2-module-wide columns from the right, alternating up/down, skipping
  #    column 6 (timing). Remainder bits stay light.
  $total = $cw.Length * 8; $i = 0
  for ($right = $size - 1; $right -ge 1; $right -= 2) {
    if ($right -eq 6) { $right = 5 }
    $upward = (($right + 1) -band 2) -eq 0
    for ($v = 0; $v -lt $size; $v++) {
      if ($upward) { $y = $size - 1 - $v } else { $y = $v }
      for ($j = 0; $j -lt 2; $j++) {
        $k = $y * $size + $right - $j
        if ($fn[$k] -or $i -ge $total) { continue }
        $mod[$k] = ($cw[$i -shr 3] -shr (7 - ($i -band 7))) -band 1
        $i++
      }
    }
  }

  # 6. masks: list the modules each mask flips (x = column, y = row; function modules never flip)
  $flips = New-Object 'object[]' 8
  for ($i = 0; $i -lt 8; $i++) { $flips[$i] = New-Object 'System.Collections.Generic.List[int]' }
  for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
      $k = $y * $size + $x
      if ($fn[$k]) { continue }
      $xy = $x * $y
      if (($x + $y) % 2 -eq 0) { $flips[0].Add($k) }
      if ($y % 2 -eq 0) { $flips[1].Add($k) }
      if ($x % 3 -eq 0) { $flips[2].Add($k) }
      if (($x + $y) % 3 -eq 0) { $flips[3].Add($k) }
      if ((($x - $x % 3) / 3 + ($y - $y % 2) / 2) % 2 -eq 0) { $flips[4].Add($k) }
      if ($xy % 2 + $xy % 3 -eq 0) { $flips[5].Add($k) }
      if (($xy % 2 + $xy % 3) % 2 -eq 0) { $flips[6].Add($k) }
      if ((($x + $y) % 2 + $xy % 3) % 2 -eq 0) { $flips[7].Add($k) }
    }
  }
  # index lists to cut rows and columns out of the flat array
  $rowIdx = New-Object 'object[]' $size; $colIdx = New-Object 'object[]' $size
  for ($a = 0; $a -lt $size; $a++) {
    $ri = New-Object int[] $size; $ci = New-Object int[] $size
    for ($b = 0; $b -lt $size; $b++) { $ri[$b] = $a * $size + $b; $ci[$b] = $b * $size + $a }
    $rowIdx[$a] = $ri; $colIdx[$a] = $ci
  }
  $reRun = [regex]'0{5,}|1{5,}'
  $ord = [StringComparison]::Ordinal

  # 7. try all 8 masks, keep the lowest penalty (first one wins ties). Penalty (ZXing flavour):
  #    N1 runs of >= 5 equal modules (3 + extra), N2 2x2 equal blocks (3 each), N3 1:1:3:1:1 finder-like
  #    runs with 4 light modules on either side, outside counts as light (40 each), N4 dark ratio
  #    deviation from 50% in whole 5% steps (10 each).
  $best = $null; $bestPenalty = [int]::MaxValue
  $area = $size * $size
  for ($mask = 0; $mask -lt 8; $mask++) {
    $m = [int[]]$mod.Clone()
    foreach ($k in $flips[$mask]) { $m[$k] = 1 - $m[$k] }
    $fd = ($eclFormat[$e] -shl 3) -bor $mask
    $rem = $fd
    for ($i = 0; $i -lt 10; $i++) { $rem = ($rem -shl 1) -bxor (($rem -shr 9) * 0x537) }
    $bits = (($fd -shl 10) -bor $rem) -bxor 0x5412  # BCH(15,5) format info
    for ($i = 0; $i -lt 15; $i++) { $bit = ($bits -shr $i) -band 1; $m[$fmtA[$i]] = $bit; $m[$fmtB[$i]] = $bit }

    $p = 0; $dark = 0
    for ($a = 0; $a -lt $size; $a++) {
      $row = -join $m[$rowIdx[$a]]
      $dark += $size - $row.Replace('1', '').Length
      foreach ($s in @($row, (-join $m[$colIdx[$a]]))) {
        foreach ($run in $reRun.Matches($s)) { $p += $run.Length - 2 }
        $t = '0000' + $s + '0000'  # outside the symbol counts as light
        for ($i = $t.IndexOf('1011101', $ord); $i -ge 0; $i = $t.IndexOf('1011101', $i + 1, $ord)) {
          if ($t.Substring($i - 4, 4) -eq '0000' -or $t.Substring($i + 7, 4) -eq '0000') { $p += 40 }
        }
      }
    }
    for ($y = 0; $y -lt $size - 1; $y++) {
      $k = $y * $size
      for ($x = 0; $x -lt $size - 1; $x++) {
        $c = $m[$k + $x]
        if ($c -eq $m[$k + $x + 1] -and $c -eq $m[$k + $size + $x] -and $c -eq $m[$k + $size + $x + 1]) { $p += 3 }
      }
    }
    $p += [Math]::Floor([Math]::Abs($dark * 2 - $area) * 10 / $area) * 10
    if ($p -lt $bestPenalty) { $best = $m; $bestPenalty = $p }
  }

  $rows = New-Object 'object[]' $size
  for ($y = 0; $y -lt $size; $y++) {
    $row = New-Object bool[] $size
    for ($x = 0; $x -lt $size; $x++) { $row[$x] = $best[$y * $size + $x] -eq 1 }
    $rows[$y] = $row
  }
  return ,$rows
}

# The matrix as one '1'/'0' string per row (dark = 1).
function ConvertTo-QrText($Matrix) {
  foreach ($row in $Matrix) { -join ([int[]]$row) }
}
