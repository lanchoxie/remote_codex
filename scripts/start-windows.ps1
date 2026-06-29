param(
  [int]$Port = 0,
  [string]$HostId = "",
  [string]$HostLabel = "",
  [string]$CodexHome = "",
  [switch]$NoBrowser,
  [switch]$DryRun,
  [switch]$Restart,
  [switch]$NoRestart,
  [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"

$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptsDir
$LogDir = Join-Path $Root "tmp\windows-start"
$RelayLog = Join-Path $LogDir "relay.log"

function Get-EnvOrDefault {
  param(
    [string]$Name,
    [string]$DefaultValue
  )
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $DefaultValue
  }
  return $value.Trim()
}

function ConvertTo-PsLiteral {
  param([string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

function Normalize-HostId {
  param([string]$Value)
  $normalized = ($Value -replace "[^A-Za-z0-9._-]+", "-").Trim("-")
  if ([string]::IsNullOrWhiteSpace($normalized)) {
    return "windows-local"
  }
  return $normalized.ToLowerInvariant()
}

function Test-PortListening {
  param([int]$LocalPort)
  try {
    return @(
      Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
    ).Count -gt 0
  } catch {
    $pattern = "[:.]$LocalPort\s+.*LISTENING"
    return @(netstat -ano -p tcp | Select-String -Pattern $pattern).Count -gt 0
  }
}

function Get-RepoProcess {
  param([string]$Needle)
  $rootNorm = $Root.ToLowerInvariant().Replace("/", "\")
  $needleNorm = $Needle.ToLowerInvariant().Replace("/", "\")
  try {
    return @(
      Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $cmd = [string]$_.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) {
          $false
        } else {
          $cmdNorm = $cmd.ToLowerInvariant().Replace("/", "\")
          $cmdNorm.Contains($needleNorm) -and ($cmdNorm.Contains($rootNorm) -or -not $cmdNorm.Contains(".codex\sandbox"))
        }
      }
    )
  } catch {
    return @()
  }
}

function Stop-RepoProcesses {
  param(
    [string]$Name,
    [object[]]$Processes
  )

  $targets = @($Processes | Where-Object { $_ -and $_.ProcessId } | Sort-Object ProcessId -Unique)
  if ($targets.Count -eq 0) {
    Write-Host "No existing $Name process found for this repo."
    return
  }

  foreach ($process in $targets) {
    if ($DryRun) {
      Write-Host "[dry-run] would stop $Name PID: $($process.ProcessId)"
      continue
    }
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Host "Stopped $Name PID: $($process.ProcessId)"
    } catch {
      Write-Host "Failed to stop $Name PID $($process.ProcessId): $($_.Exception.Message)"
    }
  }
}

function Start-RemoteCodexConsole {
  param(
    [string]$Title,
    [string]$Command
  )

  $fullCommand = "`$Host.UI.RawUI.WindowTitle = $(ConvertTo-PsLiteral $Title); $Command"
  if ($DryRun) {
    Write-Host "[dry-run] would start $Title"
    Write-Host $Command
    return $null
  }

  return Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $fullCommand) `
    -WindowStyle Normal `
    -PassThru
}

function Get-RelayAuthHeader {
  $tokenPath = Join-Path $Root "tmp\relay-auth-token.txt"
  if (-not (Test-Path -LiteralPath $tokenPath)) {
    return @{}
  }
  $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) {
    return @{}
  }
  return @{ Authorization = "Bearer $token" }
}

function Wait-RelayHealth {
  param(
    [string]$Url,
    [int]$Attempts = 30
  )

  for ($i = 0; $i -lt $Attempts; $i += 1) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$Url/health" -TimeoutSec 1 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

function Start-RelayManagedLocalAgent {
  param(
    [string]$Url,
    [string]$TargetHostId,
    [string]$TargetHostLabel
  )

  $headers = Get-RelayAuthHeader
  $body = @{
    action = "start"
    label = $TargetHostLabel
  } | ConvertTo-Json -Compress

  if ($DryRun) {
    Write-Host "[dry-run] would request relay-managed local agent for $TargetHostId"
    Write-Host "POST $Url/api/hosts/$TargetHostId/local-agent $body"
    return
  }

  try {
    $response = Invoke-RestMethod `
      -UseBasicParsing `
      -Method Post `
      -Uri "$Url/api/hosts/$TargetHostId/local-agent" `
      -Headers $headers `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 10
    $status = if ($response.localAgent -and $response.localAgent.status) { $response.localAgent.status } else { $response.status }
    Write-Host "Relay-managed local agent requested. Status: $status"
  } catch {
    throw "Failed to start relay-managed local agent: $($_.Exception.Message)"
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js was not found in PATH. Install Node.js 22+ first, then run start-windows.bat again."
}

if ($Port -le 0) {
  $envPort = Get-EnvOrDefault -Name "PORT" -DefaultValue ""
  if ($envPort -match "^\d+$") {
    $Port = [int]$envPort
  } else {
    $Port = 8797
  }
}

if ([string]::IsNullOrWhiteSpace($HostId)) {
  $HostId = Get-EnvOrDefault -Name "HOST_ID" -DefaultValue $env:COMPUTERNAME
}
$HostId = Normalize-HostId $HostId

if ([string]::IsNullOrWhiteSpace($HostLabel)) {
  $HostLabel = Get-EnvOrDefault -Name "HOST_LABEL" -DefaultValue "$env:COMPUTERNAME Windows"
}

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
  $CodexHome = Get-EnvOrDefault -Name "CODEX_HOME" -DefaultValue (Join-Path $env:USERPROFILE ".codex")
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location -LiteralPath $Root

if (-not $SkipPreflight) {
  Write-Host "Running local Codex preflight..."
  $preflight = & node scripts/check-codex-preflight.js --codex-home "$CodexHome"
  $preflightExit = $LASTEXITCODE
  if ($preflight) {
    Write-Host $preflight
  }
  if ($preflightExit -ne 0) {
    throw "Local Codex preflight failed. Fix the reported Codex install/CODEX_HOME issue, or rerun with -SkipPreflight if you know what you are doing."
  }
}

$restartRequested = -not $NoRestart -or $Restart
$url = "http://127.0.0.1:$Port"
$relayProcesses = @(Get-RepoProcess "apps\relay\server.js")
$agentProcesses = @(Get-RepoProcess "apps\host-agent\agent.js")

Write-Host "Remote Codex Windows launcher"
Write-Host "Root:       $Root"
Write-Host "URL:        $url"
Write-Host "Host ID:    $HostId"
Write-Host "Host label: $HostLabel"
Write-Host "CODEX_HOME: $CodexHome"
Write-Host "Logs:       $LogDir"
Write-Host "Restart:    $restartRequested"
Write-Host ""

if ($restartRequested) {
  Write-Host "Restart requested. Stopping repo relay and host-agent processes before launch..."
  Stop-RepoProcesses -Name "host-agent" -Processes $agentProcesses
  Stop-RepoProcesses -Name "relay" -Processes $relayProcesses
  if (-not $DryRun) {
    Start-Sleep -Seconds 1
  }
  $relayProcesses = @(Get-RepoProcess "apps\relay\server.js")
}

$relayProcess = $relayProcesses | Select-Object -First 1

if ($relayProcess) {
  Write-Host "Relay already appears to be running in this repo. PID: $($relayProcess.ProcessId)"
} elseif (Test-PortListening $Port) {
  Write-Host "Port $Port is already listening. Reusing the existing relay at $url."
} else {
  $relayCommand = @"
Set-Location -LiteralPath $(ConvertTo-PsLiteral $Root)
`$env:PORT = $(ConvertTo-PsLiteral ([string]$Port))
`$env:LOCAL_CODEX_HOME = $(ConvertTo-PsLiteral $CodexHome)
`$env:RELAY_LOCAL_AGENT_WATCHDOG_ENABLED = 'true'
`$env:RELAY_LOCAL_AGENT_STARTUP_GRACE_MS = '300000'
Write-Host "[relay] starting at $url"
Write-Host "[relay] log: $RelayLog"
node apps/relay/server.js *>&1 | Tee-Object -FilePath $(ConvertTo-PsLiteral $RelayLog) -Append
"@
  $startedRelay = Start-RemoteCodexConsole -Title "Remote Codex Relay" -Command $relayCommand
  if ($startedRelay) {
    Write-Host "Started relay. PID: $($startedRelay.Id)"
  }
}

if (-not $DryRun) {
  if (-not (Wait-RelayHealth -Url $url)) {
    throw "Relay did not become healthy at $url"
  }
  Start-RelayManagedLocalAgent -Url $url -TargetHostId $HostId -TargetHostLabel $HostLabel

  if (-not $NoBrowser) {
    Start-Process $url
  }
} else {
  Start-RelayManagedLocalAgent -Url $url -TargetHostId $HostId -TargetHostLabel $HostLabel
}

Write-Host ""
Write-Host "Remote Codex launch requested. Keep the relay window open while using it."
Write-Host "The local host-agent is managed by relay watchdog and the UI Restart Local / Stop Local controls."
Write-Host "To use another port: .\start-windows.bat -Port 8787"
Write-Host "Restart is enabled by default. To reuse existing processes: .\start-windows.bat -NoRestart"
