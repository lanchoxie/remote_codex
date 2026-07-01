param(
  [string]$OutDir = "",
  [string]$TmpDir = ""
)

$ErrorActionPreference = "Stop"

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptsDir
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $Root "dist"
}
if ([string]::IsNullOrWhiteSpace($TmpDir)) {
  $TmpDir = Join-Path $Root "tmp"
}

$NodeAssetName = "node-v16.20.2-linux-x64.tar.xz"
$CodexAssetName = "codex-linux-x86_64.zip"
$NodeSource = Join-Path $TmpDir $NodeAssetName
$CodexSource = Join-Path $TmpDir "codex-linux-x86_64"
$NodeTarget = Join-Path $OutDir $NodeAssetName
$CodexTarget = Join-Path $OutDir $CodexAssetName

function Write-Step {
  param([string]$Message)
  Write-Host "[runtime-release] $Message"
}

if (-not (Test-Path -LiteralPath $NodeSource)) {
  throw "Node runtime archive was not found: $NodeSource"
}
if (-not (Test-Path -LiteralPath (Join-Path $CodexSource "codex"))) {
  throw "Codex Linux runtime directory was not found or is incomplete: $CodexSource"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Step "copy $NodeSource -> $NodeTarget"
Copy-Item -LiteralPath $NodeSource -Destination $NodeTarget -Force

if (Test-Path -LiteralPath $CodexTarget) {
  Remove-Item -LiteralPath $CodexTarget -Force
}

$StageDir = Join-Path $OutDir "codex-linux-x86_64.release-stage"
if (Test-Path -LiteralPath $StageDir) {
  Remove-Item -LiteralPath $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
$StageRuntimeDir = Join-Path $StageDir "codex-linux-x86_64"

Write-Step "stage $CodexSource -> $StageRuntimeDir"
Copy-Item -LiteralPath $CodexSource -Destination $StageRuntimeDir -Recurse -Force

Write-Step "zip $StageRuntimeDir -> $CodexTarget"
Compress-Archive -LiteralPath $StageRuntimeDir -DestinationPath $CodexTarget -Force

Remove-Item -LiteralPath $StageDir -Recurse -Force

Write-Step "ready:"
Write-Step "  $NodeTarget"
Write-Step "  $CodexTarget"
