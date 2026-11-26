#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$extDir = Join-Path $repoRoot "x-following-exporter"
$pemFile = Join-Path $repoRoot "x-following-exporter.pem"
$zipFull = Join-Path $repoRoot "x-following-exporter.zip"
$zipShare = Join-Path $repoRoot "x-following-exporter-share.zip"
$crxFile = Join-Path $repoRoot "x-following-exporter.crx"
$testFile = Join-Path $repoRoot "tests\core.test.mjs"

if (-not (Test-Path $extDir)) {
  throw "Extension directory not found: $extDir"
}

if (Test-Path $testFile) {
  Write-Host "[1/4] Running unit tests..."
  & node --test $testFile
  if ($LASTEXITCODE -ne 0) {
    throw "Unit tests failed; aborting packaging."
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-FilteredZip {
  param(
    [Parameter(Mandatory)] [string]$SourceDir,
    [Parameter(Mandatory)] [string]$DestZip,
    [string[]]$ExcludePrefixes = @()
  )

  if (Test-Path $DestZip) {
    Remove-Item -LiteralPath $DestZip -Force
  }

  $sourceRoot = (Resolve-Path $SourceDir).Path.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $zip = [System.IO.Compression.ZipFile]::Open($DestZip, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $files = Get-ChildItem -LiteralPath $SourceDir -Recurse -File | Sort-Object FullName
    foreach ($file in $files) {
      $rel = $file.FullName.Substring($sourceRoot.Length).Replace('\', '/')
      if ($rel.StartsWith("_") -or $rel -match '/_' -or $rel.EndsWith(".pem")) {
        continue
      }
      $skip = $false
      foreach ($prefix in $ExcludePrefixes) {
        if ($rel.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
          $skip = $true
          break
        }
      }
      if ($skip) {
        continue
      }
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip,
        $file.FullName,
        $rel,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $zip.Dispose()
  }
}

Write-Host "[2/4] Building x-following-exporter.zip (full source + docs)..."
New-FilteredZip -SourceDir $extDir -DestZip $zipFull

Write-Host "[3/4] Building x-following-exporter-share.zip (runtime-only share package)..."
New-FilteredZip -SourceDir $extDir -DestZip $zipShare -ExcludePrefixes @("docs/")

Write-Host "[4/4] Building x-following-exporter.crx..."
$chromeCandidates = @(
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
) | Where-Object { $_ -and (Test-Path $_) }

$chromeExe = $chromeCandidates | Select-Object -First 1
if (-not $chromeExe) {
  Write-Warning "Chrome executable not found; skipping .crx packaging."
} elseif (-not (Test-Path $pemFile)) {
  Write-Warning "Signing key x-following-exporter.pem not found; skipping .crx packaging."
} else {
  if (Test-Path $crxFile) {
    Remove-Item -LiteralPath $crxFile -Force
  }
  $packArgs = @(
    "--pack-extension=$extDir",
    "--pack-extension-key=$pemFile"
  )
  $proc = Start-Process -FilePath $chromeExe -ArgumentList $packArgs -Wait -PassThru
  if ($proc.ExitCode -ne 0 -or -not (Test-Path $crxFile)) {
    throw "Chrome CRX packaging failed (exit code $($proc.ExitCode))."
  }
}

Write-Host "Packaging complete:"
Get-Item $zipFull, $zipShare, $crxFile -ErrorAction SilentlyContinue |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize
