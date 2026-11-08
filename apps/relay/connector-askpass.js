const fs = require('fs');

const ASKPASS_OUTCOMES = new Set([
  'static_answer',
  'browser_answer',
  'askpass_timeout',
  'askpass_cancelled',
  'askpass_unavailable',
  'askpass_missing_answer',
]);

function buildWindowsAskpassPowerShell() {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$promptText = [string]$env:RC_ASKPASS_PROMPT',
    'function Decode-B64([string]$value) {',
    '  if ([string]::IsNullOrWhiteSpace($value)) { return "" }',
    '  try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) } catch { return "" }',
    '}',
    'function Encode-Query([string]$value) {',
    '  return [uri]::EscapeDataString($value)',
    '}',
    'function Set-AskpassOutcome([string]$value) {',
    '  if ([string]::IsNullOrWhiteSpace($env:RC_ASKPASS_OUTCOME_FILE)) { return }',
    '  try { [IO.File]::WriteAllText([string]$env:RC_ASKPASS_OUTCOME_FILE, $value, [Text.Encoding]::UTF8) } catch {}',
    '}',
    'function Has-BrokerPrompt {',
    '  return -not [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_RELAY_URL) -and -not [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_CONNECTOR_ID) -and -not [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_ACTION_ID) -and -not [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_TOKEN)',
    '}',
    'function Prompt-Contains([string]$value) {',
    '  if ([string]::IsNullOrWhiteSpace($value)) { return $false }',
    '  return $promptText.IndexOf($value, [StringComparison]::OrdinalIgnoreCase) -ge 0',
    '}',
    'function Try-BrokerPrompt {',
    '  if (-not (Has-BrokerPrompt)) { return $null }',
    '  $timeoutSeconds = 90',
    '  if ($env:RC_ASKPASS_TIMEOUT_SECONDS) { try { $timeoutSeconds = [Math]::Max(10, [int]$env:RC_ASKPASS_TIMEOUT_SECONDS) } catch {} }',
    '  $base = [string]$env:RC_ASKPASS_RELAY_URL',
    '  $headers = @{}',
    '  if (-not [string]::IsNullOrWhiteSpace($env:RC_RELAY_AUTH_TOKEN)) { $headers["Authorization"] = "Bearer $env:RC_RELAY_AUTH_TOKEN" }',
    '  $body = @{ connectorId = [string]$env:RC_ASKPASS_CONNECTOR_ID; actionId = [string]$env:RC_ASKPASS_ACTION_ID; token = [string]$env:RC_ASKPASS_TOKEN; prompt = $promptText } | ConvertTo-Json -Compress',
    '  try { $created = Invoke-RestMethod -Method Post -Uri "$base/api/askpass/prompts" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 8 } catch { Set-AskpassOutcome "askpass_unavailable"; return $null }',
    '  if (-not $created -or [string]::IsNullOrWhiteSpace([string]$created.promptId)) { Set-AskpassOutcome "askpass_unavailable"; return $null }',
    '  $promptId = [string]$created.promptId',
    '  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)',
    '  $query = "connectorId=$(Encode-Query $env:RC_ASKPASS_CONNECTOR_ID)&actionId=$(Encode-Query $env:RC_ASKPASS_ACTION_ID)&token=$(Encode-Query $env:RC_ASKPASS_TOKEN)"',
    '  while ([DateTime]::UtcNow -lt $deadline) {',
    '    try { $status = Invoke-RestMethod -Method Get -Uri "$base/api/askpass/prompts/$promptId`?$query" -Headers $headers -TimeoutSec 8 } catch { Start-Sleep -Milliseconds 700; continue }',
    '    if ($status.status -eq "answered") { Set-AskpassOutcome "browser_answer"; return [string]$status.response }',
    '    if ($status.status -eq "cancelled" -or $status.status -eq "closed") { Set-AskpassOutcome "askpass_cancelled"; return $null }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '  Set-AskpassOutcome "askpass_timeout"',
    '  return $null',
    '}',
    '$index = 1',
    'if ($env:RC_ASKPASS_STATE_FILE -and (Test-Path -LiteralPath $env:RC_ASKPASS_STATE_FILE)) { try { $index = [int](Get-Content -LiteralPath $env:RC_ASKPASS_STATE_FILE -TotalCount 1) } catch { $index = 1 } }',
    'if ($index -lt 1) { $index = 1 }',
    '$nextIndex = $index + 1',
    'if ($env:RC_ASKPASS_STATE_FILE) { try { Set-Content -LiteralPath $env:RC_ASKPASS_STATE_FILE -Value ([string]$nextIndex) -NoNewline } catch {} }',
    '$oneTimePrompt = $promptText -match "(?i)(otp|mfa|verification|authenticator|passcode|one[- _]?time|2fa|two[- _]?factor|totp|google|duo|challenge|token|code)"',
    '$passwordPrompt = $promptText -match "(?i)(password|passphrase)"',
    '$b64 = [Environment]::GetEnvironmentVariable("RC_ASKPASS_PASSWORD_${index}_B64")',
    'if ($oneTimePrompt -and (Has-BrokerPrompt)) {',
    '  $b64 = ""',
    '} elseif ($oneTimePrompt -and -not [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_OTP_B64)) {',
    '  $b64 = $env:RC_ASKPASS_OTP_B64',
    '} elseif ($passwordPrompt) {',
    '  if ((Prompt-Contains $env:RC_ASKPASS_GATEWAY_HOST) -and -not [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_GATEWAY_PASSWORD_B64)) {',
    '    $b64 = $env:RC_ASKPASS_GATEWAY_PASSWORD_B64',
    '  } elseif ((Prompt-Contains $env:RC_ASKPASS_TARGET_HOST) -and -not [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_TARGET_PASSWORD_B64)) {',
    '    $b64 = $env:RC_ASKPASS_TARGET_PASSWORD_B64',
    '  } elseif (-not [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_ONLY_PASSWORD_B64)) {',
    '    $b64 = $env:RC_ASKPASS_ONLY_PASSWORD_B64',
    '  }',
    '}',
    '$answer = Decode-B64 $b64',
    'if (-not [string]::IsNullOrWhiteSpace($answer)) {',
    '  Set-AskpassOutcome "static_answer"',
    '  [Console]::Out.Write($answer)',
    '  exit 0',
    '}',
    '$answer = Try-BrokerPrompt',
    'if (-not [string]::IsNullOrWhiteSpace($answer)) { [Console]::Out.Write($answer); exit 0 }',
    'if (-not (Has-BrokerPrompt)) { Set-AskpassOutcome "askpass_missing_answer" }',
    'exit 1',
  ].join('\r\n');
}

function buildWindowsAskpassCommand(helperScriptPath) {
  return [
    '@echo off',
    'setlocal EnableExtensions',
    'set "RC_ASKPASS_PROMPT=%*"',
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${String(helperScriptPath || '').replace(/"/g, '""')}"`,
    'exit /b %ERRORLEVEL%',
  ].join('\r\n');
}

function removeAskpassFile(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch (_) {
    // AskPass state is diagnostic only and may be removed by another cleanup.
  }
}

function consumeAskpassOutcome(outcomePath) {
  if (!outcomePath) {
    return null;
  }
  let outcome = null;
  try {
    const value = fs.readFileSync(outcomePath, 'utf8').replace(/^\uFEFF/, '').trim();
    outcome = ASKPASS_OUTCOMES.has(value) ? value : null;
  } catch (_) {
    outcome = null;
  }
  removeAskpassFile(outcomePath);
  return outcome;
}

function attachAskpassOutcome(result, env) {
  const askpassStatus = consumeAskpassOutcome(env?.RC_ASKPASS_OUTCOME_FILE);
  removeAskpassFile(env?.RC_ASKPASS_STATE_FILE);
  return askpassStatus ? { ...result, askpassStatus } : result;
}

module.exports = {
  attachAskpassOutcome,
  buildWindowsAskpassCommand,
  buildWindowsAskpassPowerShell,
  consumeAskpassOutcome,
};
