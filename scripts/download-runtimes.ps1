param(
  [string]$Repo = "lanchoxie/remote_codex",
  [string]$Tag = "v2.4.7",
  [string]$OutDir = "",
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptsDir
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $Root "tmp"
}

$NodeAssetName = "node-v16.20.2-linux-x64.tar.xz"
$CodexAssetName = "codex-linux-x86_64.zip"
$NodeTarget = Join-Path $OutDir $NodeAssetName
$CodexTarget = Join-Path $OutDir "codex-linux-x86_64"
$DownloadDir = Join-Path $OutDir "runtime-download"
$CodexZipPath = Join-Path $DownloadDir $CodexAssetName
$ReleaseBase = "https://github.com/$Repo/releases/download/$Tag"

# Legacy v2.4.5/v2.4.6 release assets contained runtimes inside the full app zip.
# Keep this fallback so older tags still work, but new releases should publish the two runtime assets directly.
$LegacyZipName = "mobile-codex-remote-$Tag.zip"
$LegacyManifestName = "$LegacyZipName.manifest.json"

function Write-Step {
  param([string]$Message)
  Write-Host "[runtime] $Message"
}

function Invoke-Download {
  param(
    [string]$Uri,
    [string]$Path
  )
  Write-Step "download $Uri"
  if ($DryRun) {
    return
  }
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Path
}

function Ensure-Directory {
  param([string]$Path)
  if ($DryRun) {
    Write-Step "ensure directory $Path"
    return
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Test-RuntimeReady {
  return (Test-Path -LiteralPath $NodeTarget) -and (Test-Path -LiteralPath (Join-Path $CodexTarget "codex"))
}

function Expand-CodexRuntimeZip {
  param([string]$ZipPath)

  $ExtractDir = Join-Path $DownloadDir "codex-extract"
  if (-not $DryRun -and (Test-Path -LiteralPath $ExtractDir)) {
    Remove-Item -LiteralPath $ExtractDir -Recurse -Force
  }
  Ensure-Directory $ExtractDir
  Write-Step "extract $ZipPath"
  if (-not $DryRun) {
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
  }

  $CodexSource = Join-Path $ExtractDir "codex-linux-x86_64"
  if (-not $DryRun -and -not (Test-Path -LiteralPath (Join-Path $CodexSource "codex"))) {
    $nested = Get-ChildItem -LiteralPath $ExtractDir -Directory -Recurse -ErrorAction SilentlyContinue |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "codex") } |
      Select-Object -First 1
    if ($nested) {
      $CodexSource = $nested.FullName
    }
  }

  if (-not $DryRun -and -not (Test-Path -LiteralPath (Join-Path $CodexSource "codex"))) {
    throw "Codex Linux runtime was not found in the direct runtime zip: $CodexSource"
  }

  if ($DryRun) {
    Write-Step "copy $CodexSource -> tmp\codex-linux-x86_64"
    return
  }
  if (Test-Path -LiteralPath $CodexTarget) {
    Remove-Item -LiteralPath $CodexTarget -Recurse -Force
  }
  Copy-Item -LiteralPath $CodexSource -Destination $CodexTarget -Recurse -Force
}

function Install-DirectRuntimeAssets {
  Ensure-Directory $OutDir
  Ensure-Directory $DownloadDir
  Invoke-Download "$ReleaseBase/$NodeAssetName" $NodeTarget
  Invoke-Download "$ReleaseBase/$CodexAssetName" $CodexZipPath
  Expand-CodexRuntimeZip $CodexZipPath
}

function Expand-LegacyReleaseZip {
  param([string]$ZipPath)

  $ExtractDir = Join-Path $DownloadDir "legacy-extract"
  if (-not $DryRun -and (Test-Path -LiteralPath $ExtractDir)) {
    Remove-Item -LiteralPath $ExtractDir -Recurse -Force
  }
  Ensure-Directory $ExtractDir
  Write-Step "extract $ZipPath"
  if (-not $DryRun) {
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
  }

  $RuntimeRoot = Get-ChildItem -LiteralPath $ExtractDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "runtimes") } |
    Select-Object -First 1
  $Base = if ($RuntimeRoot) { $RuntimeRoot.FullName } else { $ExtractDir }
  $NodeSource = Join-Path $Base "runtimes\node\$NodeAssetName"
  $CodexSource = Join-Path $Base "runtimes\codex\linux-x86_64"

  if (-not $DryRun) {
    if (-not (Test-Path -LiteralPath $NodeSource)) {
      throw "Node runtime was not found in the legacy release zip: $NodeSource"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $CodexSource "codex"))) {
      throw "Codex Linux runtime was not found in the legacy release zip: $CodexSource"
    }
  }

  Ensure-Directory $OutDir
  if ($DryRun) {
    Write-Step "copy $NodeSource -> tmp\node-v16.20.2-linux-x64.tar.xz"
    Write-Step "copy $CodexSource -> tmp\codex-linux-x86_64"
    return
  }
  Copy-Item -LiteralPath $NodeSource -Destination $NodeTarget -Force
  if (Test-Path -LiteralPath $CodexTarget) {
    Remove-Item -LiteralPath $CodexTarget -Recurse -Force
  }
  Copy-Item -LiteralPath $CodexSource -Destination $CodexTarget -Recurse -Force
}

function Install-LegacyReleaseZipAssets {
  Ensure-Directory $OutDir
  Ensure-Directory $DownloadDir

  $ZipPath = Join-Path $DownloadDir $LegacyZipName
  $ManifestPath = Join-Path $DownloadDir $LegacyManifestName

  try {
    Invoke-Download "$ReleaseBase/$LegacyManifestName" $ManifestPath
    if (-not $DryRun) {
      $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
      $parts = @($manifest.parts)
      if ($parts.Count -eq 0) {
        throw "Legacy release manifest did not contain any parts."
      }
      if (Test-Path -LiteralPath $ZipPath) {
        Remove-Item -LiteralPath $ZipPath -Force
      }
      $zipStream = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::CreateNew)
      try {
        foreach ($part in $parts) {
          $name = if ($part.name) { [string]$part.name } else { [string]$part }
          $partPath = Join-Path $DownloadDir $name
          Invoke-Download "$ReleaseBase/$name" $partPath
          $partBytes = [System.IO.File]::ReadAllBytes($partPath)
          $zipStream.Write($partBytes, 0, $partBytes.Length)
        }
      } finally {
        $zipStream.Dispose()
      }
    } else {
      Write-Step "would assemble $LegacyZipName from split legacy zip parts"
    }
  } catch {
    Write-Step "legacy manifest download failed, trying full legacy release zip"
    Invoke-Download "$ReleaseBase/$LegacyZipName" $ZipPath
  }

  Expand-LegacyReleaseZip $ZipPath
}

if ((Test-RuntimeReady) -and -not $Force) {
  Write-Step "runtime cache already exists"
  Write-Step "Node:  tmp\node-v16.20.2-linux-x64.tar.xz"
  Write-Step "Codex: tmp\codex-linux-x86_64"
  exit 0
}

try {
  Install-DirectRuntimeAssets
} catch {
  Write-Step "direct runtime asset download failed, trying legacy full release zip fallback"
  Write-Step $_.Exception.Message
  Install-LegacyReleaseZipAssets
}

Write-Step "runtime cache ready"
Write-Step "Node:  tmp\node-v16.20.2-linux-x64.tar.xz"
Write-Step "Codex: tmp\codex-linux-x86_64"
