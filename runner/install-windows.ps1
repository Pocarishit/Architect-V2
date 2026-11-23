# Architect runner — start it automatically when you sign in to Windows.
# It runs hidden (no console window, no pop-ups, no focus stealing) and picks up the updates you push or
# schedule from Architect → Settings → Updates & Fixes. Set it up first:
#   node architect-runner.mjs setup --token arch_… --repo "C:\path\to\Architect-V2"
#
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1              install (and start now)
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall   remove the task
#
# Log: %APPDATA%\ArchitectRunner\runner.log
param([switch]$Uninstall)

$TaskName = 'Architect runner'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $Here 'architect-runner.mjs'
$LogDir = Join-Path $env:APPDATA 'ArchitectRunner'
$Log = Join-Path $LogDir 'runner.log'

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed '$TaskName'. The saved token stays until you run: node architect-runner.mjs forget"
  exit 0
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { Write-Error 'Node.js 18 or newer is needed: https://nodejs.org'; exit 1 }
$major = [int]((& $Node --version).TrimStart('v').Split('.')[0])
if ($major -lt 18) { Write-Error "Node $major is too old — install Node 18 or newer."; exit 1 }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Warning "The 'claude' command isn't on PATH — install Claude Code, or run setup with --claude <path>." }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$cmd = "if ((Test-Path '$Log') -and ((Get-Item '$Log').Length -gt 1MB)) { Move-Item -Force '$Log' '$Log.old' }; & '$Node' '$Script' run *>> '$Log'"
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`"" -WorkingDirectory $Here
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed '$TaskName' — it starts at sign-in and is running now."
Write-Host "Log: $Log"
