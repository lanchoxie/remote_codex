param(
  [int]$Port = 0,
  [string]$HostId = "",
  [string]$HostLabel = "",
  [string]$CodexHome = "",
  [switch]$NoBrowser,
  [switch]$DryRun,
  [switch]$Restart,
  [switch]$NoRestart,
  [switch]$SkipPreflight,
  [ValidateRange(30, 600)]
  [int]$RelayShutdownTimeoutSeconds = 120
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

function Get-InstanceStatePath {
  param(
    [string]$Name,
    [string]$Leaf
  )
  $defaultPath = Join-Path $RelayStateRoot $Leaf
  if ($Port -eq 8797) {
    return Get-EnvOrDefault -Name $Name -DefaultValue $defaultPath
  }
  return $defaultPath
}

function Test-PortListening {
  param([int]$LocalPort)
  try {
    return @(
      Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction Stop
    ).Count -gt 0
  } catch {
    $pattern = "[:.]$LocalPort\s+.*LISTENING"
    return @(netstat -ano -p tcp | Select-String -Pattern $pattern).Count -gt 0
  }
}

function Get-PortListenerProcessIds {
  param([int]$LocalPort)
  try {
    return @(
      Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction Stop |
        ForEach-Object { [int]$_.OwningProcess } |
        Where-Object { $_ -gt 0 } |
        Sort-Object -Unique
    )
  } catch {
    $pattern = "[:.]$LocalPort\s+.*LISTENING\s+(\d+)\s*$"
    return @(
      netstat -ano -p tcp |
        ForEach-Object {
          if ($_ -match $pattern) { [int]$Matches[1] }
        } |
        Where-Object { $_ -gt 0 } |
        Sort-Object -Unique
    )
  }
}

function Test-CommandReferencesPath {
  param(
    [string]$Text,
    [string]$PathValue
  )
  if ([string]::IsNullOrWhiteSpace($Text) -or [string]::IsNullOrWhiteSpace($PathValue)) {
    return $false
  }

  $textNorm = $Text.Replace("/", "\")
  $pathNorm = $PathValue.Replace("/", "\").TrimEnd("\")
  $boundaryChars = @(
    [char]" ", [char]"`t", [char]"`r", [char]"`n", [char]"'", [char]'"',
    [char]"=", [char]";", [char]"(", [char]")", [char]","
  )
  $offset = 0
  while ($offset -lt $textNorm.Length) {
    $index = $textNorm.IndexOf($pathNorm, $offset, [System.StringComparison]::OrdinalIgnoreCase)
    if ($index -lt 0) {
      return $false
    }
    $beforeOk = $index -eq 0 -or $boundaryChars -contains $textNorm[$index - 1]
    $afterIndex = $index + $pathNorm.Length
    $afterOk = $afterIndex -eq $textNorm.Length -or $boundaryChars -contains $textNorm[$afterIndex]
    if ($beforeOk -and $afterOk) {
      return $true
    }
    $offset = $index + 1
  }
  return $false
}

function ConvertTo-NormalizedFullPath {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ""
  }
  try {
    return [System.IO.Path]::GetFullPath($PathValue).TrimEnd("\", "/")
  } catch {
    return ""
  }
}

function Test-PathEquals {
  param(
    [string]$Left,
    [string]$Right
  )
  $leftPath = ConvertTo-NormalizedFullPath $Left
  $rightPath = ConvertTo-NormalizedFullPath $Right
  return $leftPath -and $rightPath -and $leftPath.Equals($rightPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-CanonicalPhysicalPath {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ""
  }
  $helperPath = Join-Path $Root "shared\physical-path.js"
  if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    return ""
  }
  try {
    $canonical = & node -e 'const { canonicalPhysicalPath } = require(process.argv[1]); process.stdout.write(canonicalPhysicalPath(process.argv[2]));' $helperPath $PathValue 2>$null
    if ($LASTEXITCODE -ne 0) {
      return ""
    }
    return ([string]$canonical).Trim()
  } catch {
    return ""
  }
}

function Test-PhysicalPathEquals {
  param(
    [string]$Left,
    [string]$Right
  )
  $leftPath = ConvertTo-CanonicalPhysicalPath $Left
  $rightPath = ConvertTo-CanonicalPhysicalPath $Right
  return $leftPath -and $rightPath -and $leftPath.Equals($rightPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-StrictSetLocationRoot {
  param([string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return ""
  }
  $pattern = "(?i)(?:^|[;`r`n])[ `t]*Set-Location[ `t]+-LiteralPath[ `t]+'((?:''|[^'])+)'(?=[ `t]*(?:;|`r|`n|$))"
  $matches = [regex]::Matches($CommandLine, $pattern)
  if ($matches.Count -ne 1) {
    return ""
  }
  $candidate = $matches[0].Groups[1].Value.Replace("''", "'")
  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    return ""
  }
  return ConvertTo-NormalizedFullPath $candidate
}

function Test-SiblingRepoRoot {
  param([string]$CandidateRoot)
  $candidate = ConvertTo-NormalizedFullPath $CandidateRoot
  $current = ConvertTo-NormalizedFullPath $Root
  if (-not $candidate -or (Test-PathEquals -Left $candidate -Right $current)) {
    return $false
  }
  $candidateParent = Split-Path -Parent $candidate
  $currentParent = Split-Path -Parent $current
  if (-not (Test-PathEquals -Left $candidateParent -Right $currentParent)) {
    return $false
  }
  return (Test-Path -LiteralPath (Join-Path $candidate "apps\relay\server.js") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $candidate "apps\host-agent\agent.js") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $candidate "package.json") -PathType Leaf)
}

function Test-ProcessOwnedByRootScript {
  param(
    [object]$Process,
    [string]$RepoRoot,
    [string]$RelativeScript
  )
  if (-not $Process -or [string]::IsNullOrWhiteSpace($RepoRoot)) {
    return $false
  }
  $expectedScript = Join-Path $RepoRoot $RelativeScript
  $commandLine = [string]$Process.CommandLine
  if (Test-CommandReferencesPath -Text $commandLine -PathValue $expectedScript) {
    return $true
  }
  if (-not (Test-CommandReferencesPath -Text $commandLine -PathValue $RelativeScript)) {
    return $false
  }

  $parentPid = [int]$Process.ParentProcessId
  if ($parentPid -le 0) {
    return $false
  }
  try {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $parentPid" -ErrorAction Stop
    $parentCommand = [string]$parent.CommandLine
    if ([string]::IsNullOrWhiteSpace($parentCommand)) {
      return $false
    }
    $launcherRoot = Get-StrictSetLocationRoot -CommandLine $parentCommand
    return Test-PathEquals -Left $launcherRoot -Right $RepoRoot
  } catch {
    return $false
  }
}

function Test-ProcessOwnedByRepoScript {
  param(
    [object]$Process,
    [string]$RelativeScript
  )
  return Test-ProcessOwnedByRootScript -Process $Process -RepoRoot $Root -RelativeScript $RelativeScript
}

function Get-RepoProcess {
  param([string]$Needle)
  $needleNorm = $Needle.ToLowerInvariant().Replace("/", "\")
  try {
    return @(
      Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $cmd = [string]$_.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) {
          $false
        } else {
          $cmdNorm = $cmd.ToLowerInvariant().Replace("/", "\")
          $cmdNorm.Contains($needleNorm) -and
            (Test-ProcessOwnedByRepoScript -Process $_ -RelativeScript $Needle)
        }
      }
    )
  } catch {
    return @()
  }
}

function Get-RelayManagedAgentProcess {
  param(
    [string]$StateRoot,
    [string]$TargetHostId,
    [string]$TargetRelayUrl
  )

  $ownerRoot = Join-Path $StateRoot "local-agents"
  if (-not (Test-Path -LiteralPath $ownerRoot)) {
    return @()
  }
  return @(
    Get-ChildItem -LiteralPath $ownerRoot -Filter "*.owner.json" -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        try {
          $owner = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
          if (
            [string]$owner.kind -eq "remote-codex-local-agent-owner" -and
            [string]$owner.hostId -ceq $TargetHostId -and
            [string]$owner.relayUrl -ceq $TargetRelayUrl -and
            [int]$owner.pid -gt 0
          ) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$owner.pid)" -ErrorAction SilentlyContinue
            $commandLine = [string]$process.CommandLine
            $commandNorm = $commandLine.ToLowerInvariant().Replace("/", "\")
            if (
              $process -and
              $commandNorm.Contains("apps\host-agent\agent.js") -and
              (Test-ProcessOwnedByRepoScript -Process $process -RelativeScript "apps\host-agent\agent.js")
            ) {
              $process
            }
          }
        } catch {
          # Ignore incomplete or stale ownership markers; Relay recovery validates them too.
        }
      }
  )
}

function Get-ProcessById {
  param([int]$ProcessId)
  if ($ProcessId -le 0) {
    return $null
  }
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-RelayAuthHeaderForPath {
  param([string]$TokenPath)
  if ([string]::IsNullOrWhiteSpace($TokenPath) -or -not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) {
    return $null
  }
  try {
    $token = (Get-Content -LiteralPath $TokenPath -Raw -ErrorAction Stop).Trim()
  } catch {
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($token)) {
    return $null
  }
  return @{ Authorization = "Bearer $token" }
}

function Get-RelayControlHeaderForPath {
  param([string]$TokenPath)
  if ([string]::IsNullOrWhiteSpace($TokenPath) -or -not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) {
    return @{}
  }
  try {
    $token = (Get-Content -LiteralPath $TokenPath -Raw -ErrorAction Stop).Trim()
  } catch {
    return @{}
  }
  if ([string]::IsNullOrWhiteSpace($token)) {
    return @{}
  }
  return @{ "X-Relay-Control-Token" = $token }
}

function Get-VerifiedCurrentRelayProcess {
  param(
    [string]$StateRoot,
    [string]$Url,
    [int]$LocalPort,
    [int[]]$ListenerProcessIds
  )
  $listenerIds = @($ListenerProcessIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  if ($listenerIds.Count -ne 1) {
    return $null
  }
  $ownerPath = Join-Path $StateRoot "relay-owner.json"
  try {
    $owner = Get-Content -LiteralPath $ownerPath -Raw -ErrorAction Stop | ConvertFrom-Json
  } catch {
    return $null
  }
  if (
    [string]$owner.kind -cne "remote-codex-relay-owner" -or
    [int]$owner.version -ne 1 -or
    [int]$owner.pid -ne [int]$listenerIds[0] -or
    [int]$owner.port -ne $LocalPort -or
    -not (Test-PhysicalPathEquals -Left ([string]$owner.repoRoot) -Right $Root) -or
    -not (Test-PhysicalPathEquals -Left ([string]$owner.stateRoot) -Right $StateRoot) -or
    [string]::IsNullOrWhiteSpace([string]$owner.instanceId) -or
    [string]::IsNullOrWhiteSpace([string]$owner.stateRoot)
  ) {
    return $null
  }
  try {
    $canonicalOwner = Get-Content `
      -LiteralPath (Join-Path ([string]$owner.stateRoot) "relay-owner.json") `
      -Raw `
      -ErrorAction Stop | ConvertFrom-Json
  } catch {
    return $null
  }
  if (
    [string]$canonicalOwner.kind -cne [string]$owner.kind -or
    [int]$canonicalOwner.version -ne [int]$owner.version -or
    [string]$canonicalOwner.instanceId -cne [string]$owner.instanceId -or
    [int]$canonicalOwner.pid -ne [int]$owner.pid -or
    [int]$canonicalOwner.port -ne [int]$owner.port -or
    -not (Test-PhysicalPathEquals -Left ([string]$canonicalOwner.repoRoot) -Right ([string]$owner.repoRoot)) -or
    -not (Test-PhysicalPathEquals -Left ([string]$canonicalOwner.stateRoot) -Right ([string]$owner.stateRoot))
  ) {
    return $null
  }
  $process = Get-ProcessById -ProcessId ([int]$owner.pid)
  if (-not (Test-ProcessOwnedByRepoScript -Process $process -RelativeScript "apps\relay\server.js")) {
    return $null
  }
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri "$Url/health" -TimeoutSec 3
  } catch {
    return $null
  }
  if ($health.ok -ne $true -or [string]$health.instanceId -cne [string]$owner.instanceId) {
    return $null
  }
  return $process
}

function Get-VerifiedSiblingRelayCandidate {
  param(
    [string]$Url,
    [int]$LocalPort,
    [int[]]$ListenerProcessIds
  )
  $listenerIds = @($ListenerProcessIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  if ($LocalPort -ne 8797 -or $listenerIds.Count -ne 1) {
    return $null
  }

  $relayProcess = Get-ProcessById -ProcessId $listenerIds[0]
  if (-not $relayProcess -or [string]$relayProcess.Name -notmatch '^node(?:\.exe)?$') {
    return $null
  }
  $parentProcess = Get-ProcessById -ProcessId ([int]$relayProcess.ParentProcessId)
  $candidateRoot = Get-StrictSetLocationRoot -CommandLine ([string]$parentProcess.CommandLine)
  if (-not (Test-SiblingRepoRoot -CandidateRoot $candidateRoot)) {
    return $null
  }
  if (-not (Test-ProcessOwnedByRootScript -Process $relayProcess -RepoRoot $candidateRoot -RelativeScript "apps\relay\server.js")) {
    return $null
  }

  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri "$Url/health" -TimeoutSec 3
  } catch {
    return $null
  }
  if (-not $health -or $health.ok -ne $true) {
    return $null
  }

  $tokenPath = Join-Path $candidateRoot "tmp\relay-auth-token.txt"
  $headers = Get-RelayAuthHeaderForPath -TokenPath $tokenPath
  if (-not $headers) {
    return $null
  }
  try {
    $hostsResponse = Invoke-RestMethod `
      -UseBasicParsing `
      -Uri "$Url/api/hosts" `
      -Headers $headers `
      -TimeoutSec 5
  } catch {
    return $null
  }
  if (-not $hostsResponse -or $null -eq $hostsResponse.hosts) {
    return $null
  }

  $agentRecords = @()
  $seenAgentPids = @{}
  foreach ($hostRecord in @($hostsResponse.hosts)) {
    $agentPid = [int]$hostRecord.localAgent.pid
    if ($agentPid -le 0 -or $seenAgentPids.ContainsKey($agentPid)) {
      continue
    }
    $hostId = [string]$hostRecord.hostId
    $agentRelayUrl = [string]$hostRecord.localAgent.relayUrl
    if ([string]::IsNullOrWhiteSpace($hostId) -or $agentRelayUrl -cne $Url) {
      return $null
    }
    $agentProcess = Get-ProcessById -ProcessId $agentPid
    if (
      -not $agentProcess -or
      [string]$agentProcess.Name -notmatch '^node(?:\.exe)?$' -or
      [int]$agentProcess.ParentProcessId -ne [int]$relayProcess.ProcessId -or
      -not (Test-ProcessOwnedByRootScript -Process $agentProcess -RepoRoot $candidateRoot -RelativeScript "apps\host-agent\agent.js")
    ) {
      return $null
    }
    $seenAgentPids[$agentPid] = $true
    $agentRecords += [pscustomobject]@{
      HostId = $hostId
      Process = $agentProcess
    }
  }

  return [pscustomobject]@{
    Root = $candidateRoot
    RelayProcess = $relayProcess
    ParentProcessId = [int]$relayProcess.ParentProcessId
    TokenPath = $tokenPath
    Headers = $headers
    ControlHeaders = (Get-RelayControlHeaderForPath -TokenPath (Join-Path $candidateRoot "tmp\relay-control-token.txt"))
    AgentRecords = @($agentRecords)
  }
}

function Assert-SiblingRelayCandidateUnchanged {
  param(
    [object]$Candidate,
    [int]$LocalPort
  )
  $listenerIds = @(Get-PortListenerProcessIds -LocalPort $LocalPort)
  if ($listenerIds.Count -ne 1 -or [int]$listenerIds[0] -ne [int]$Candidate.RelayProcess.ProcessId) {
    throw "Port $LocalPort ownership changed during sibling Relay takeover."
  }
  $current = Get-ProcessById -ProcessId ([int]$Candidate.RelayProcess.ProcessId)
  if (
    -not $current -or
    [int]$current.ParentProcessId -ne [int]$Candidate.ParentProcessId -or
    -not (Test-ProcessOwnedByRootScript -Process $current -RepoRoot $Candidate.Root -RelativeScript "apps\relay\server.js")
  ) {
    throw "Sibling Relay process identity changed during takeover."
  }
  return $current
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
      if ($Name -eq "host-agent") {
        $taskkillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
        $result = Start-Process `
          -FilePath $taskkillPath `
          -ArgumentList @("/PID", [string]$process.ProcessId, "/T", "/F") `
          -WindowStyle Hidden `
          -Wait `
          -PassThru
        if ($result.ExitCode -ne 0 -and (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) {
          throw "taskkill.exe exited with code $($result.ExitCode)"
        }
      } else {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      }
      $stopDeadline = (Get-Date).AddSeconds(5)
      while ((Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $stopDeadline) {
        Start-Sleep -Milliseconds 100
      }
      if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
        throw "$Name PID $($process.ProcessId) is still running after the stop request"
      }
      if ($Name -eq "host-agent") {
        Write-Host "Stopped $Name process tree rooted at PID: $($process.ProcessId)"
      } else {
        Write-Host "Stopped $Name PID: $($process.ProcessId)"
      }
    } catch {
      throw "Failed to stop $Name PID $($process.ProcessId): $($_.Exception.Message)"
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
  $tokenPath = $RelayAuthTokenPath
  if ([string]::IsNullOrWhiteSpace($tokenPath)) {
    $tokenPath = Join-Path $Root "tmp\relay-auth-token.txt"
  }
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
      $health = Invoke-RestMethod -UseBasicParsing -Uri "$Url/health" -TimeoutSec 1
      if ($health -and $health.ok -eq $true) {
        return $true
      }
    } catch {
      # Keep polling until a fully initialized Relay reports ok=true.
    }
    Start-Sleep -Milliseconds 500
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

function Stop-RelayManagedLocalAgentWithHeaders {
  param(
    [string]$Url,
    [string]$TargetHostId,
    [hashtable]$Headers
  )

  $body = @{ action = "stop" } | ConvertTo-Json -Compress
  $encodedHostId = [uri]::EscapeDataString($TargetHostId)
  if ($DryRun) {
    Write-Host "[dry-run] would request graceful relay-managed shutdown for $TargetHostId"
    Write-Host "POST $Url/api/hosts/$encodedHostId/local-agent $body"
    return $true
  }

  try {
    $response = Invoke-RestMethod `
      -UseBasicParsing `
      -Method Post `
      -Uri "$Url/api/hosts/$encodedHostId/local-agent" `
      -Headers $Headers `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 10
    $status = if ($response.localAgent -and $response.localAgent.status) { $response.localAgent.status } else { $response.status }
    Write-Host "Relay-managed local agent shutdown requested. Status: $status"
    return $true
  } catch {
    Write-Host "Graceful local agent shutdown request failed; force cleanup remains available: $($_.Exception.Message)"
    return $false
  }
}

function Stop-RelayManagedLocalAgent {
  param(
    [string]$Url,
    [string]$TargetHostId
  )
  return Stop-RelayManagedLocalAgentWithHeaders `
    -Url $Url `
    -TargetHostId $TargetHostId `
    -Headers (Get-RelayAuthHeader)
}

function Request-RelayShutdown {
  param(
    [string]$Url,
    [hashtable]$Headers
  )
  if ($DryRun) {
    Write-Host "[dry-run] would request authenticated Relay shutdown"
    return $true
  }
  try {
    $response = Invoke-RestMethod `
      -UseBasicParsing `
      -Method Post `
      -Uri "$Url/api/control/shutdown" `
      -Headers $Headers `
      -ContentType "application/json" `
      -Body "{}" `
      -TimeoutSec 5
    return $response -and $response.ok -eq $true -and [string]$response.status -eq "shutting_down"
  } catch {
    return $false
  }
}

function Wait-ProcessExit {
  param(
    [int]$ProcessId,
    [int]$TimeoutSeconds = 30
  )
  if ($DryRun) {
    return $true
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  return -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Wait-PortFree {
  param(
    [int]$LocalPort,
    [int]$TimeoutSeconds = 10
  )
  if ($DryRun) {
    return $true
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Test-PortListening -LocalPort $LocalPort) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  return -not (Test-PortListening -LocalPort $LocalPort)
}

function Backup-RelayAuthTokenForTakeover {
  param(
    [string]$SourceTokenPath,
    [string]$TargetTokenPath
  )
  if ($DryRun -or -not (Test-Path -LiteralPath $TargetTokenPath -PathType Leaf)) {
    return
  }
  $sourceToken = (Get-Content -LiteralPath $SourceTokenPath -Raw -ErrorAction Stop).Trim()
  $targetToken = (Get-Content -LiteralPath $TargetTokenPath -Raw -ErrorAction Stop).Trim()
  if ($sourceToken -ceq $targetToken) {
    return
  }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $backupPath = Join-Path $LogDir "relay-auth-token.before-sibling-takeover-$stamp.bak"
  Copy-Item -LiteralPath $TargetTokenPath -Destination $backupPath -ErrorAction Stop
  Write-Host "Backed up the current stable Relay token before sibling takeover."
}

function Adopt-RelayAuthTokenFromSibling {
  param(
    [string]$SourceTokenPath,
    [string]$TargetTokenPath
  )
  if ($DryRun) {
    Write-Host "[dry-run] would adopt the verified active Relay token"
    return
  }
  $sourceToken = (Get-Content -LiteralPath $SourceTokenPath -Raw -ErrorAction Stop).Trim()
  if ([string]::IsNullOrWhiteSpace($sourceToken)) {
    throw "Verified sibling Relay token file became empty before takeover."
  }
  $targetDirectory = Split-Path -Parent $TargetTokenPath
  New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
  $tempPath = "$TargetTokenPath.$PID.takeover.tmp"
  try {
    Copy-Item -LiteralPath $SourceTokenPath -Destination $tempPath -Force -ErrorAction Stop
    Move-Item -LiteralPath $tempPath -Destination $TargetTokenPath -Force -ErrorAction Stop
  } finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  }
  Write-Host "Adopted the verified active Relay token for connection continuity."
}

function Stop-VerifiedSiblingRelay {
  param(
    [object]$Candidate,
    [string]$Url,
    [int]$LocalPort
  )
  Assert-SiblingRelayCandidateUnchanged -Candidate $Candidate -LocalPort $LocalPort | Out-Null

  foreach ($agentRecord in @($Candidate.AgentRecords)) {
    $requested = Stop-RelayManagedLocalAgentWithHeaders `
      -Url $Url `
      -TargetHostId $agentRecord.HostId `
      -Headers $Candidate.Headers
    if (-not $requested) {
      throw "Verified sibling Relay refused graceful shutdown for local Agent $($agentRecord.HostId)."
    }
  }

  if (-not $DryRun) {
    $agentDeadline = (Get-Date).AddSeconds(15)
    do {
      $remainingAgents = @($Candidate.AgentRecords | Where-Object {
        Get-Process -Id ([int]$_.Process.ProcessId) -ErrorAction SilentlyContinue
      })
      if ($remainingAgents.Count -gt 0) {
        Start-Sleep -Milliseconds 200
      }
    } while ($remainingAgents.Count -gt 0 -and (Get-Date) -lt $agentDeadline)

    foreach ($agentRecord in $remainingAgents) {
      $agentProcess = Get-ProcessById -ProcessId ([int]$agentRecord.Process.ProcessId)
      if (
        -not $agentProcess -or
        [int]$agentProcess.ParentProcessId -ne [int]$Candidate.RelayProcess.ProcessId -or
        -not (Test-ProcessOwnedByRootScript -Process $agentProcess -RepoRoot $Candidate.Root -RelativeScript "apps\host-agent\agent.js")
      ) {
        throw "Sibling local Agent identity changed before force cleanup."
      }
      Stop-RepoProcesses -Name "host-agent" -Processes @($agentProcess)
    }
  }

  Assert-SiblingRelayCandidateUnchanged -Candidate $Candidate -LocalPort $LocalPort | Out-Null
  $shutdownHeaders = if ($Candidate.ControlHeaders -and $Candidate.ControlHeaders.Count -gt 0) {
    $Candidate.ControlHeaders
  } else {
    $Candidate.Headers
  }
  $gracefulRelayStop = Request-RelayShutdown -Url $Url -Headers $shutdownHeaders
  if ($Candidate.ControlHeaders -and $Candidate.ControlHeaders.Count -gt 0 -and -not $gracefulRelayStop) {
    throw "Verified sibling Relay rejected its control token; refusing force takeover."
  }
  if ($gracefulRelayStop) {
    Write-Host "Waiting up to $RelayShutdownTimeoutSeconds seconds for sibling Relay persistence to close..."
    Wait-ProcessExit `
      -ProcessId ([int]$Candidate.RelayProcess.ProcessId) `
      -TimeoutSeconds $RelayShutdownTimeoutSeconds | Out-Null
  } elseif (-not $DryRun) {
    Start-Sleep -Seconds 1
  }

  if (-not $DryRun -and (Get-Process -Id ([int]$Candidate.RelayProcess.ProcessId) -ErrorAction SilentlyContinue)) {
    $currentListeners = @(Get-PortListenerProcessIds -LocalPort $LocalPort)
    if ($currentListeners.Count -eq 0) {
      throw "Sibling Relay stopped listening but is still closing persistence after $RelayShutdownTimeoutSeconds seconds. Refusing force takeover; wait for PID $($Candidate.RelayProcess.ProcessId) to exit, then retry."
    }
    $verifiedRelay = Assert-SiblingRelayCandidateUnchanged -Candidate $Candidate -LocalPort $LocalPort
    Stop-RepoProcesses -Name "relay" -Processes @($verifiedRelay)
  }

  if (-not (Wait-PortFree -LocalPort $LocalPort -TimeoutSeconds 10)) {
    throw "Port $LocalPort remained occupied after verified sibling Relay shutdown."
  }
  if (-not $DryRun -and (Get-Process -Id ([int]$Candidate.RelayProcess.ProcessId) -ErrorAction SilentlyContinue)) {
    throw "Verified sibling Relay PID $($Candidate.RelayProcess.ProcessId) remained alive after shutdown."
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

if ($Port -ne 8797) {
  $LogDir = Join-Path $Root "tmp\windows-start-$Port"
  $RelayLog = Join-Path $LogDir "relay.log"
}

$isProductionPort = $Port -eq 8797
$configuredRelayStateRoot = if ($isProductionPort) {
  Get-EnvOrDefault -Name "RELAY_STATE_ROOT" -DefaultValue ""
} else {
  ""
}
$RelayStateRoot = if (-not [string]::IsNullOrWhiteSpace($configuredRelayStateRoot)) {
  $configuredRelayStateRoot
} elseif ($isProductionPort) {
  Join-Path $Root "tmp"
} else {
  Join-Path $Root "tmp\relay-$Port"
}
$RelayStateEnvironment = "`$env:RELAY_STATE_ROOT = " + (ConvertTo-PsLiteral $RelayStateRoot)
$SessionRecordStoreRoot = Get-InstanceStatePath -Name "SESSION_RECORD_STORE_ROOT" -Leaf "session-record-store"
$SessionCollectionsPath = Get-InstanceStatePath -Name "SESSION_COLLECTIONS_PATH" -Leaf "session-collections.json"
$SessionMetadataPath = Get-InstanceStatePath -Name "SESSION_METADATA_PATH" -Leaf "session-metadata.json"
$SessionLogsPath = Get-InstanceStatePath -Name "SESSION_LOGS_PATH" -Leaf "session-logs.json"
$SessionDiagnosticsPath = Get-InstanceStatePath -Name "SESSION_DIAGNOSTICS_PATH" -Leaf "session-diagnostics.json"
$ConnectorsPath = Get-InstanceStatePath -Name "CONNECTORS_PATH" -Leaf "connectors.json"
$ConnectorSecretsPath = Get-InstanceStatePath -Name "CONNECTOR_SECRETS_PATH" -Leaf "connector-secrets.json"
$SkillFavoritesPath = Get-InstanceStatePath -Name "SKILL_FAVORITES_PATH" -Leaf "skill-favorites.json"
$SkillSourcesPath = Get-InstanceStatePath -Name "SKILL_SOURCES_PATH" -Leaf "skill-sources.json"
$SkillLibraryPath = Get-InstanceStatePath -Name "SKILL_LIBRARY_PATH" -Leaf "skill-library.json"
$SkillInventoriesPath = Get-InstanceStatePath -Name "SKILL_INVENTORIES_PATH" -Leaf "skill-inventories.json"
$SkillRegistryPath = Get-InstanceStatePath -Name "SKILL_REGISTRY_PATH" -Leaf "skill-registry.json"
$SkillArtifactRoot = Get-InstanceStatePath -Name "SKILL_ARTIFACT_ROOT" -Leaf "skill-artifacts"
$SkillDeploymentsPath = Get-InstanceStatePath -Name "SKILL_DEPLOYMENTS_PATH" -Leaf "skill-deployments.json"
$SkillAuditPath = Get-InstanceStatePath -Name "SKILL_AUDIT_PATH" -Leaf "skill-audit.jsonl"
$SshKnownHostsPath = Get-InstanceStatePath -Name "SSH_KNOWN_HOSTS_PATH" -Leaf "ssh\known_hosts"
$RelayAuthTokenPath = Get-InstanceStatePath -Name "RELAY_AUTH_TOKEN_PATH" -Leaf "relay-auth-token.txt"
$RelayAuthAccountPath = Get-InstanceStatePath -Name "RELAY_AUTH_ACCOUNT_PATH" -Leaf "relay-auth-account.json"
$RelayControlTokenPath = Get-InstanceStatePath -Name "RELAY_CONTROL_TOKEN_PATH" -Leaf "relay-control-token.txt"

if ([string]::IsNullOrWhiteSpace($HostId)) {
  $HostId = if ($isProductionPort) {
    Get-EnvOrDefault -Name "HOST_ID" -DefaultValue $env:COMPUTERNAME
  } else {
    Get-EnvOrDefault -Name "REMOTE_CODEX_DEV_HOST_ID" -DefaultValue "$env:COMPUTERNAME-dev-$Port"
  }
}
$HostId = Normalize-HostId $HostId

if ([string]::IsNullOrWhiteSpace($HostLabel)) {
  $HostLabel = if ($isProductionPort) {
    Get-EnvOrDefault -Name "HOST_LABEL" -DefaultValue "$env:COMPUTERNAME Windows"
  } else {
    Get-EnvOrDefault -Name "REMOTE_CODEX_DEV_HOST_LABEL" -DefaultValue "$env:COMPUTERNAME Dev $Port"
  }
}

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
  $CodexHome = if ($isProductionPort) {
    Get-EnvOrDefault -Name "CODEX_HOME" -DefaultValue (Join-Path $env:USERPROFILE ".codex")
  } else {
    Get-EnvOrDefault -Name "REMOTE_CODEX_DEV_CODEX_HOME" -DefaultValue (Join-Path $RelayStateRoot "codex-home")
  }
}

$RemoteCodexStateRoot = if ($isProductionPort) {
  Get-EnvOrDefault -Name "REMOTE_CODEX_STATE_ROOT" -DefaultValue (Join-Path $env:USERPROFILE ".remote-codex")
} else {
  Get-EnvOrDefault -Name "REMOTE_CODEX_DEV_AGENT_STATE_ROOT" -DefaultValue (Join-Path $RelayStateRoot "agent-state")
}
$AgentsHome = if ($isProductionPort) {
  Get-EnvOrDefault -Name "AGENTS_HOME" -DefaultValue (Join-Path $env:USERPROFILE ".agents")
} else {
  Join-Path $RemoteCodexStateRoot "agents"
}
$CcSwitchHome = if ($isProductionPort) {
  Get-EnvOrDefault -Name "CC_SWITCH_HOME" -DefaultValue (Join-Path $env:USERPROFILE ".cc-switch")
} else {
  Join-Path $RemoteCodexStateRoot "cc-switch"
}
$SkillArtifactTempRoot = if ($isProductionPort) {
  Get-EnvOrDefault -Name "SKILL_ARTIFACT_TEMP_ROOT" -DefaultValue (Join-Path $env:TEMP "remote-codex-skill-artifacts")
} else {
  Join-Path $RemoteCodexStateRoot "skill-artifact-temp"
}
$LocalAgentStartEnabled = $isProductionPort
$LocalAgentStartEnabledValue = if ($LocalAgentStartEnabled) { "true" } else { "false" }
$AuthIsolationEnvironment = if ($isProductionPort) { "" } else {
  "Remove-Item Env:RELAY_AUTH_TOKEN -ErrorAction SilentlyContinue`n`$env:RELAY_AUTH_DISABLED = 'false'"
}
$RelayServerPath = Join-Path $Root "apps\relay\server.js"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location -LiteralPath $Root

if (-not $SkipPreflight -and $LocalAgentStartEnabled) {
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
$dryRunTakeoverPlanned = $false
$url = "http://127.0.0.1:$Port"
$relayListenerIds = @(Get-PortListenerProcessIds -LocalPort $Port)
$relayProcesses = @(
  Get-VerifiedCurrentRelayProcess `
    -StateRoot $RelayStateRoot `
    -Url $url `
    -LocalPort $Port `
    -ListenerProcessIds $relayListenerIds |
      Where-Object { $_ -and $_.ProcessId }
)
$agentProcesses = @(
  @(
    Get-RepoProcess "apps\host-agent\agent.js" |
      Where-Object { $relayListenerIds -contains [int]$_.ParentProcessId }
  )
  @(Get-RelayManagedAgentProcess -StateRoot $RelayStateRoot -TargetHostId $HostId -TargetRelayUrl $url)
) | Sort-Object ProcessId -Unique

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
  if ($relayProcesses.Count -gt 1) {
    throw "Multiple current-checkout Relay processes appear to own port $Port; refusing restart."
  }

  $siblingCandidate = $null
  if ($relayProcesses.Count -eq 0 -and $relayListenerIds.Count -gt 0 -and $isProductionPort) {
    $siblingCandidate = Get-VerifiedSiblingRelayCandidate `
      -Url $url `
      -LocalPort $Port `
      -ListenerProcessIds $relayListenerIds
    if (-not $siblingCandidate) {
      throw "Port $Port is already owned by another or unverified process. Refusing to reuse or stop it."
    }
    Write-Host "Verified an obsolete sibling checkout on production port $Port. Preparing a controlled takeover."
    Backup-RelayAuthTokenForTakeover `
      -SourceTokenPath $siblingCandidate.TokenPath `
      -TargetTokenPath $RelayAuthTokenPath
  }

  if ($relayProcesses.Count -gt 0) {
    Stop-RelayManagedLocalAgent -Url $url -TargetHostId $HostId | Out-Null
    if (-not $DryRun) {
      $shutdownDeadline = (Get-Date).AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 250
        $agentProcesses = @(
          @(
            Get-RepoProcess "apps\host-agent\agent.js" |
              Where-Object { $relayListenerIds -contains [int]$_.ParentProcessId }
          )
          @(Get-RelayManagedAgentProcess -StateRoot $RelayStateRoot -TargetHostId $HostId -TargetRelayUrl $url)
        ) | Sort-Object ProcessId -Unique
      } while ($agentProcesses.Count -gt 0 -and (Get-Date) -lt $shutdownDeadline)
    }
    Stop-RepoProcesses -Name "host-agent" -Processes $agentProcesses

    $relayShutdownHeaders = Get-RelayControlHeaderForPath -TokenPath $RelayControlTokenPath
    $hasRelayControlToken = $relayShutdownHeaders -and $relayShutdownHeaders.Count -gt 0
    if (-not $hasRelayControlToken) {
      $relayShutdownHeaders = Get-RelayAuthHeader
    }
    $gracefulRelayStop = Request-RelayShutdown -Url $url -Headers $relayShutdownHeaders
    if ($hasRelayControlToken -and -not $gracefulRelayStop) {
      throw "Current Relay rejected its control token; refusing force restart."
    }
    if ($gracefulRelayStop) {
      Write-Host "Waiting up to $RelayShutdownTimeoutSeconds seconds for Relay persistence to close..."
      Wait-ProcessExit `
        -ProcessId ([int]$relayProcesses[0].ProcessId) `
        -TimeoutSeconds $RelayShutdownTimeoutSeconds | Out-Null
    }
    if (-not $DryRun -and (Get-Process -Id ([int]$relayProcesses[0].ProcessId) -ErrorAction SilentlyContinue)) {
      $currentListeners = @(Get-PortListenerProcessIds -LocalPort $Port)
      if ($currentListeners.Count -eq 0) {
        throw "Relay stopped listening but is still closing persistence after $RelayShutdownTimeoutSeconds seconds. Refusing force restart; wait for PID $($relayProcesses[0].ProcessId) to exit, then retry."
      }
      $currentRelay = Get-ProcessById -ProcessId ([int]$relayProcesses[0].ProcessId)
      if (
        $currentListeners.Count -ne 1 -or
        [int]$currentListeners[0] -ne [int]$relayProcesses[0].ProcessId -or
        -not (Test-ProcessOwnedByRepoScript -Process $currentRelay -RelativeScript "apps\relay\server.js")
      ) {
        throw "Current Relay process identity changed during restart."
      }
      Stop-RepoProcesses -Name "relay" -Processes @($currentRelay)
    }
  } elseif ($siblingCandidate) {
    Stop-VerifiedSiblingRelay -Candidate $siblingCandidate -Url $url -LocalPort $Port
    Adopt-RelayAuthTokenFromSibling `
      -SourceTokenPath $siblingCandidate.TokenPath `
      -TargetTokenPath $RelayAuthTokenPath
    $dryRunTakeoverPlanned = [bool]$DryRun
  } else {
    Stop-RepoProcesses -Name "host-agent" -Processes $agentProcesses
  }
  if (-not $DryRun) {
    Start-Sleep -Seconds 1
  }
  $relayListenerIds = @(Get-PortListenerProcessIds -LocalPort $Port)
  $relayProcesses = @(
    Get-VerifiedCurrentRelayProcess `
      -StateRoot $RelayStateRoot `
      -Url $url `
      -LocalPort $Port `
      -ListenerProcessIds $relayListenerIds |
        Where-Object { $_ -and $_.ProcessId }
  )
}

$relayProcess = $relayProcesses | Select-Object -First 1

if ($relayProcess) {
  Write-Host "Relay already appears to be running in this repo. PID: $($relayProcess.ProcessId)"
} elseif ((Test-PortListening $Port) -and -not $dryRunTakeoverPlanned) {
  throw "Port $Port is already owned by another or unverified process. Refusing to reuse or stop it."
} else {
  $relayCommand = @"
Set-Location -LiteralPath $(ConvertTo-PsLiteral $Root)
`$env:PORT = $(ConvertTo-PsLiteral ([string]$Port))
$RelayStateEnvironment
`$env:SESSION_RECORD_STORE_ROOT = $(ConvertTo-PsLiteral $SessionRecordStoreRoot)
`$env:SESSION_COLLECTIONS_PATH = $(ConvertTo-PsLiteral $SessionCollectionsPath)
`$env:SESSION_METADATA_PATH = $(ConvertTo-PsLiteral $SessionMetadataPath)
`$env:SESSION_LOGS_PATH = $(ConvertTo-PsLiteral $SessionLogsPath)
`$env:SESSION_DIAGNOSTICS_PATH = $(ConvertTo-PsLiteral $SessionDiagnosticsPath)
`$env:CONNECTORS_PATH = $(ConvertTo-PsLiteral $ConnectorsPath)
`$env:CONNECTOR_SECRETS_PATH = $(ConvertTo-PsLiteral $ConnectorSecretsPath)
`$env:SKILL_FAVORITES_PATH = $(ConvertTo-PsLiteral $SkillFavoritesPath)
`$env:SKILL_SOURCES_PATH = $(ConvertTo-PsLiteral $SkillSourcesPath)
`$env:SKILL_LIBRARY_PATH = $(ConvertTo-PsLiteral $SkillLibraryPath)
`$env:SKILL_INVENTORIES_PATH = $(ConvertTo-PsLiteral $SkillInventoriesPath)
`$env:SKILL_REGISTRY_PATH = $(ConvertTo-PsLiteral $SkillRegistryPath)
`$env:SKILL_ARTIFACT_ROOT = $(ConvertTo-PsLiteral $SkillArtifactRoot)
`$env:SKILL_DEPLOYMENTS_PATH = $(ConvertTo-PsLiteral $SkillDeploymentsPath)
`$env:SKILL_AUDIT_PATH = $(ConvertTo-PsLiteral $SkillAuditPath)
`$env:SSH_KNOWN_HOSTS_PATH = $(ConvertTo-PsLiteral $SshKnownHostsPath)
`$env:RELAY_AUTH_TOKEN_PATH = $(ConvertTo-PsLiteral $RelayAuthTokenPath)
`$env:RELAY_AUTH_ACCOUNT_PATH = $(ConvertTo-PsLiteral $RelayAuthAccountPath)
`$env:RELAY_CONTROL_TOKEN_PATH = $(ConvertTo-PsLiteral $RelayControlTokenPath)
`$env:LOCAL_CODEX_HOME = $(ConvertTo-PsLiteral $CodexHome)
`$env:REMOTE_CODEX_STATE_ROOT = $(ConvertTo-PsLiteral $RemoteCodexStateRoot)
`$env:AGENTS_HOME = $(ConvertTo-PsLiteral $AgentsHome)
`$env:CC_SWITCH_HOME = $(ConvertTo-PsLiteral $CcSwitchHome)
`$env:SKILL_ARTIFACT_TEMP_ROOT = $(ConvertTo-PsLiteral $SkillArtifactTempRoot)
`$env:RELAY_LOCAL_HOST_ID = $(ConvertTo-PsLiteral $HostId)
`$env:RELAY_LOCAL_HOST_LABEL = $(ConvertTo-PsLiteral $HostLabel)
`$env:RELAY_LOCAL_HOST_STUB = $(ConvertTo-PsLiteral $LocalAgentStartEnabledValue)
`$env:RELAY_LOCAL_AGENT_START_ENABLED = $(ConvertTo-PsLiteral $LocalAgentStartEnabledValue)
`$env:RELAY_LOCAL_AGENT_WATCHDOG_ENABLED = $(ConvertTo-PsLiteral $LocalAgentStartEnabledValue)
`$env:RELAY_LOCAL_AGENT_STARTUP_GRACE_MS = '300000'
$AuthIsolationEnvironment
Write-Host "[relay] starting at $url"
Write-Host "[relay] log: $RelayLog"
node $(ConvertTo-PsLiteral $RelayServerPath) *>&1 | Tee-Object -FilePath $(ConvertTo-PsLiteral $RelayLog) -Append
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
  if ($LocalAgentStartEnabled) {
    Start-RelayManagedLocalAgent -Url $url -TargetHostId $HostId -TargetHostLabel $HostLabel
  }

  if (-not $NoBrowser) {
    Start-Process $url
  }
} elseif ($LocalAgentStartEnabled) {
  Start-RelayManagedLocalAgent -Url $url -TargetHostId $HostId -TargetHostLabel $HostLabel
}

Write-Host ""
Write-Host "Remote Codex launch requested. Keep the relay window open while using it."
if ($LocalAgentStartEnabled) {
  Write-Host "The local host-agent is managed by relay watchdog and the UI Restart Local / Stop Local controls."
} else {
  Write-Host "Non-production Relay mode does not start or manage a local Agent. Use npm run dev with REMOTE_CODEX_DEV_WITH_AGENT=true for isolated Agent testing."
}
Write-Host "To use another port safely: set REMOTE_CODEX_DEV_PORT, then run npm run dev from a development worktree."
Write-Host "Restart is enabled by default. To reuse existing processes: .\start-windows.bat -NoRestart"
