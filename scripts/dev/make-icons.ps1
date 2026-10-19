# Regenerates the PWA icons in worker/public/icons from desktop/assets (Windows PowerShell, System.Drawing).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$src  = [System.Drawing.Image]::FromFile((Join-Path $root 'desktop\assets\saqme.png'))
$out  = Join-Path $root 'worker\public\icons'
if (-not (Test-Path $out)) { [void](New-Item -ItemType Directory -Path $out) }

# the rounded app icon has transparent corners; iOS and maskable icons need a full square,
# so fill with the icon's own edge colour first
$probe = New-Object System.Drawing.Bitmap $src
$edge  = $probe.GetPixel(24, [int]($probe.Height / 2))
$probe.Dispose()

function Save-Icon([int]$size, [string]$name, [bool]$fill, [double]$scale) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  if ($fill) { $g.Clear($edge) } else { $g.Clear([System.Drawing.Color]::Transparent) }
  $w = [int]($size * $scale); $o = [int](($size - $w) / 2)
  $g.DrawImage($src, $o, $o, $w, $w)
  $g.Dispose()
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
# full-bleed: the source's rounded corners disappear under the fill when drawn 12% larger
Save-Icon 180 'apple-touch-icon.png' $true 1.12
Save-Icon 192 'icon-192.png' $false 1.0
Save-Icon 512 'icon-512.png' $false 1.0
Save-Icon 512 'icon-maskable-512.png' $true 1.12
Save-Icon 64  'favicon-64.png' $false 1.0
Copy-Item (Join-Path $root 'desktop\assets\saqme-glyph.png') (Join-Path $out 'glyph.png') -Force
$src.Dispose()
"edge colour: $edge"
Get-ChildItem $out | ForEach-Object { "{0,-26} {1,8}" -f $_.Name, $_.Length }
