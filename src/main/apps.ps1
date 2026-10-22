# Lists everything in the Start menu (Win32 + Store apps) as JSON:
#   [{ "name": "...", "id": "<AppUserModelID or path>", "logo": "<png for Store apps>" }]
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$packages = @{}
foreach ($p in Get-AppxPackage) { $packages[$p.PackageFamilyName] = $p.InstallLocation }

function Find-Logo($location, $relative) {
  if (-not $relative) { return $null }
  $full = Join-Path $location $relative
  if (Test-Path $full) { return $full }
  $dir = Split-Path $full
  $base = [IO.Path]::GetFileNameWithoutExtension($full)
  $files = Get-ChildItem -Path $dir -Filter "$base*.png" -File
  foreach ($pref in 'targetsize-256_altform-unplated', 'targetsize-96_altform-unplated', 'targetsize-48_altform-unplated', 'targetsize-256', 'targetsize-48', 'scale-200', 'scale-100') {
    $hit = $files | Where-Object { $_.Name -like "*.$pref.png" } | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  $any = $files | Sort-Object Length -Descending | Select-Object -First 1
  if ($any) { return $any.FullName }
  return $null
}

$result = foreach ($a in Get-StartApps) {
  $logo = $null
  if ($a.AppID -match '^([^!\\]+)!(.+)$' -and $packages.ContainsKey($matches[1])) {
    $location = $packages[$matches[1]]
    $appId = $matches[2]
    try {
      [xml]$manifest = Get-Content -LiteralPath (Join-Path $location 'AppxManifest.xml') -Raw
      $entry = $manifest.Package.Applications.Application | Where-Object { $_.Id -eq $appId } | Select-Object -First 1
      $ve = $entry.VisualElements
      $logo = Find-Logo $location $ve.Square44x44Logo
      if (-not $logo) { $logo = Find-Logo $location $ve.Square150x150Logo }
    } catch {}
  }
  [pscustomobject]@{ name = $a.Name; id = $a.AppID; logo = $logo }
}

@($result) | ConvertTo-Json -Compress
