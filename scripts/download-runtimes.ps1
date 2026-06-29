param(
  [string]$Repo = "lanchoxie/remote_codex",
  [string]$Tag = "v2.4.5",
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

$NodeTarget = Join-Path $OutDir "node-v16.20.2-linux-x64.tar.xz"
$CodexTarget = Join-Path $OutDir "codex-linux-x86_64"
$DownloadDir = Join-Path $OutDir "runtime-download"
$ZipName = "mobile-codex-remote-$Tag.zip"
$ManifestName = "$ZipName.manifest.json"
$ReleaseBase = "https://github.com/$Repo/releases/download/$Tag"
# Default release assets: mobile-codex-remote-v2.4.5.zip.manifest.json and mobile-codex-remote-v2.4.5.zip.partNNN.

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

function Expand-RuntimeZip {
  param([string]$ZipPath)
  $ExtractDir = Join-Path $DownloadDir "extract"
  if (-not $DryRun) {
    if (Test-Path -LiteralPath $ExtractDir) {
      Remove-Item -LiteralPath $ExtractDir -Recurse -Force
    }
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
  $NodeSource = Join-Path $Base "runtimes\node\node-v16.20.2-linux-x64.tar.xz"
  $CodexSource = Join-Path $Base "runtimes\codex\linux-x86_64"

  if (-not $DryRun) {
    if (-not (Test-Path -LiteralPath $NodeSource)) {
      throw "Node runtime was not found in the release zip: $NodeSource"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $CodexSource "codex"))) {
      throw "Codex Linux runtime was not found in the release zip: $CodexSource"
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

if ((Test-RuntimeReady) -and -not $Force) {
  Write-Step "runtime cache already exists"
  Write-Step "Node:  tmp\node-v16.20.2-linux-x64.tar.xz"
  Write-Step "Codex: tmp\codex-linux-x86_64"
  exit 0
}

Ensure-Directory $OutDir
Ensure-Directory $DownloadDir

$ZipPath = Join-Path $DownloadDir $ZipName
$ManifestPath = Join-Path $DownloadDir $ManifestName

try {
  Invoke-Download "$ReleaseBase/$ManifestName" $ManifestPath
  if (-not $DryRun) {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $parts = @($manifest.parts)
    if ($parts.Count -eq 0) {
      throw "Runtime release manifest did not contain any parts."
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
    Write-Step "would assemble $ZipName from mobile-codex-remote-v2.4.5.zip.part files"
  }
} catch {
  Write-Step "manifest download failed, trying full release zip"
  Invoke-Download "$ReleaseBase/$ZipName" $ZipPath
}

Expand-RuntimeZip $ZipPath

Write-Step "runtime cache ready"
Write-Step "Node:  tmp\node-v16.20.2-linux-x64.tar.xz"
Write-Step "Codex: tmp\codex-linux-x86_64"
