# Registers NetShield as a Windows Scheduled Task that starts at logon, so
# monitoring runs without a manually started terminal (ROADMAP Phase 4.11).
#
# Usage (from the repo root, no elevation required):
#   .\install-task.ps1            # register the logon task (and start it now)
#   .\install-task.ps1 -Status    # show task state and last run result
#   .\install-task.ps1 -Uninstall # remove the task (stops the server it started)
#
# The task runs `node backend\server.js` in a hidden window under the current
# user. The node.exe path is resolved at install time and baked into the task,
# so PATH differences in the logon environment don't matter.

param(
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$taskName = 'NetShield Server'
$repo = $PSScriptRoot

if ($Status) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Task '$taskName' is not installed." -ForegroundColor Yellow
    exit 1
  }
  $info = $task | Get-ScheduledTaskInfo
  Write-Host "Task:            $taskName"
  Write-Host "State:           $($task.State)"
  Write-Host "Last run time:   $($info.LastRunTime)"
  Write-Host "Last result:     $($info.LastTaskResult) (0 = still running or OK)"
  Write-Host "Next run:        at next logon"
  exit 0
}

if ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Task '$taskName' is not installed - nothing to do."
    exit 0
  }
  if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName
  }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed task '$taskName'. Note: a server started outside the task (npm start / NetShield.cmd) is unaffected."
  exit 0
}

# --- Install ---

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error 'node.exe not found on PATH. Install Node.js first.'
}

if (-not (Test-Path (Join-Path $repo 'backend\node_modules'))) {
  Write-Error "Backend dependencies missing. Run 'npm run install:all' first."
}

if (-not (Test-Path (Join-Path $repo 'frontend\dist\index.html'))) {
  Write-Host 'Production frontend bundle missing - building it now...'
  Push-Location $repo
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Error 'Frontend build failed; task not installed.' }
  } finally {
    Pop-Location
  }
}

# Hidden-window wrapper: a bare node.exe action would flash a console at logon.
$command = "Set-Location -LiteralPath '$repo'; & '$node' backend\server.js"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`"" `
  -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# No execution time limit (the server runs indefinitely); restart up to 3
# times a minute apart if it crashes; catch up if logon was missed.
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'NetShield connection monitor (http://localhost:3010)' -Force | Out-Null

Write-Host "Registered task '$taskName' - NetShield will start at every logon of $env:USERNAME."

if (-not $NoStart) {
  $listening = netstat -ano | Select-String -Pattern ':3010 .*LISTENING' -Quiet
  if ($listening) {
    Write-Host 'A server is already listening on port 3010; not starting the task now (it will take over at next logon).'
  } else {
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Started NetShield: http://localhost:3010'
  }
}
