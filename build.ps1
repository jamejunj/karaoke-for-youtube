# Builds the Chrome Web Store upload: dist/karaoke-for-youtube-<version>.zip
# Only the files the extension needs at runtime are packed (no README, store/ or dist/).
# Uses System.IO.Compression directly: Windows PowerShell 5.1's Compress-Archive writes "\" in
# entry names, which the Chrome Web Store doesn't treat as folders.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version

$files = @(
  'manifest.json',
  'background.js', 'content.js', 'lyrics.js', 'lyrics-core.js', 'i18n.js', 'karaoke-processor.js', 'yt-bridge.js',
  'popup.html', 'popup.css', 'popup.js', 'info.html', 'info.css', 'info.js'
)
$dirs = @('icons', '_locales')

$entries = [System.Collections.Generic.List[string]]::new()
foreach ($f in $files) { $entries.Add($f) }
foreach ($d in $dirs) {
  Get-ChildItem (Join-Path $root $d) -Recurse -File | ForEach-Object {
    $entries.Add($_.FullName.Substring($root.Length + 1))
  }
}

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = Join-Path $dist "karaoke-for-youtube-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($rel in $entries) {
    $name = $rel -replace '\\', '/'
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, (Join-Path $root $rel), $name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $archive.Dispose()
}

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Output "Built $zip ($($entries.Count) files, $size KB)"
