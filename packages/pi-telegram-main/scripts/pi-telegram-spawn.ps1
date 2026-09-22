# Local helper: open a visible Pi in a cwd and auto-connect Telegram.
# This is operator tooling for Threaded Mode "new instance / new thread".
# It does NOT implement same-thread session /new.
#
# Usage:
#   ./scripts/pi-telegram-spawn.ps1
#   ./scripts/pi-telegram-spawn.ps1 -Cwd D:\Code\foo
#   ./scripts/pi-telegram-spawn.ps1 -NoAutoConnect
#   ./scripts/pi-telegram-spawn.ps1 -Wait

[CmdletBinding()]
param(
  [string]$Cwd = (Get-Location).Path,
  [switch]$NoAutoConnect,
  [switch]$Wait,
  [int]$WaitSeconds = 45,
  [string]$PiCommand = "pi",
  [string]$ProxyPort = "7897"
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$PathValue) {
  return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $PathValue).Path)
}

if (-not (Test-Path -LiteralPath $Cwd -PathType Container)) {
  throw "Working directory does not exist: $Cwd"
}

$resolvedCwd = Resolve-FullPath $Cwd
$stateDir = Join-Path $env:USERPROFILE ".pi\agent\tmp\telegram"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$statePath = Join-Path $stateDir "last-spawn.json"
$logPath = Join-Path $stateDir "logs.jsonl"

$state = [ordered]@{
  cwd = $resolvedCwd
  autoConnect = -not $NoAutoConnect.IsPresent
  createdAtMs = $stamp
  platform = "windows"
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

Write-Host "Spawning Pi in: $resolvedCwd"
Write-Host "State written: $statePath"
if (-not $NoAutoConnect.IsPresent) {
  Write-Host "PI_TELEGRAM_AUTO_CONNECT=1 (connects on session start)"
} else {
  Write-Host "Auto-connect disabled; run /telegram-connect manually in the new terminal."
}

# Build a cmd.exe one-liner so env is applied inside the new tab/window.
# Windows Terminal does not reliably inherit the caller's process env for new-tab.
$piExe = $PiCommand
if ($PiCommand -match '[\s"]') {
  $piExe = '"' + ($PiCommand -replace '"', '""') + '"'
}

$proxyUrl = "http://127.0.0.1:$ProxyPort"
$proxyEnv = "set NODE_USE_ENV_PROXY=1&& set HTTPS_PROXY=$proxyUrl&& set HTTP_PROXY=$proxyUrl&& set NO_PROXY=localhost,127.0.0.1&& set PI_TELEGRAM_NETWORK_FAMILY=auto&& "
if (-not $NoAutoConnect.IsPresent) {
  $inner = "${proxyEnv}set PI_TELEGRAM_AUTO_CONNECT=1&& $piExe"
} else {
  $inner = "${proxyEnv}$piExe"
}

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
  $argList = @(
    "-w", "0",
    "new-tab",
    "--title", "pi-telegram-spawn",
    "-d", $resolvedCwd,
    "cmd.exe", "/k", $inner
  )
  Start-Process -FilePath $wt.Source -ArgumentList $argList | Out-Null
  Write-Host "Launched via Windows Terminal."
} else {
  $cmd = Get-Command cmd.exe -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Neither wt.exe nor cmd.exe is available to open a visible terminal."
  }
  Start-Process -FilePath $cmd.Source -WorkingDirectory $resolvedCwd -ArgumentList @(
    "/k",
    $inner
  ) | Out-Null
  Write-Host "Launched via cmd /k fallback."
}

if ($NoAutoConnect.IsPresent -or -not $Wait.IsPresent) {
  if (-not $NoAutoConnect.IsPresent) {
    Write-Host "Tip: re-run with -Wait to poll logs for auto-connect success/failure."
  }
  exit 0
}

Write-Host "Waiting up to ${WaitSeconds}s for auto-connect result in logs..."
$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
$result = $null
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (-not (Test-Path -LiteralPath $logPath)) { continue }
  $lines = Get-Content -LiteralPath $logPath -Tail 120 -ErrorAction SilentlyContinue
  foreach ($line in $lines) {
    if ($line -notmatch 'auto-connect') { continue }
    try {
      $obj = $line | ConvertFrom-Json
    } catch {
      continue
    }
    if ($obj.kind -ne 'event') { continue }
    if ($null -eq $obj.at -or [int64]$obj.at -lt $stamp) { continue }
    $phase = ""
    if ($obj.details -and $obj.details.phase) { $phase = [string]$obj.details.phase }
    if ($phase -eq 'auto-connect-complete' -or $phase -eq 'auto-connect-failed' -or $phase -eq 'auto-connect-retry') {
      $result = $obj
      if ($phase -eq 'auto-connect-complete' -or $phase -eq 'auto-connect-failed') {
        break
      }
    }
  }
  if ($result -and ($result.details.phase -eq 'auto-connect-complete' -or $result.details.phase -eq 'auto-connect-failed')) {
    break
  }
}

if (-not $result) {
  Write-Host "Timed out waiting for auto-connect log events."
  Write-Host "Check the new terminal UI notify, or inspect: $logPath"
  exit 2
}

Write-Host ("Result phase: {0}" -f $result.details.phase)
Write-Host ("Message: {0}" -f $result.message)
if ($result.details.phase -eq 'auto-connect-failed' -or ($result.message -match 'failed|EPERM|in-flight')) {
  Write-Host "Auto-connect did not fully succeed."
  Write-Host "If leader is an old process, run /reload in the leader TUI so state.json rename retries load, then re-run this script."
  exit 1
}

Write-Host "Auto-connect finished (see message above)."
exit 0
