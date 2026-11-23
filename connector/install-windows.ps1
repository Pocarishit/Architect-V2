# Architect ⇄ Anytype connector — start it automatically when you sign in to Windows.
# It runs hidden, independent of Claude Code and of any browser tab. It still needs the PC awake and
# Anytype Desktop running; when either isn't, your phone keeps showing the last good import.
#
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1              install (and start now)
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall   remove the task
#
# Logs: %APPDATA%\ArchitectAnytype\connector.log (counts and statuses only — no content, no keys).
param([switch]$Uninstall)

$TaskName = 'Architect Anytype connector'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $Here 'architect-anytype.mjs'
$LogDir = Join-Path $env:APPDATA 'ArchitectAnytype'
$Log = Join-Path $LogDir 'connector.log'

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed '$TaskName'. Saved keys stay until you run: node architect-anytype.mjs forget"
  exit 0
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { Write-Error 'Node.js 18 or newer is needed: https://nodejs.org'; exit 1 }
$major = [int]((& $Node --version).TrimStart('v').Split('.')[0])
if ($major -lt 18) { Write-Error "Node $major is too old — install Node 18 or newer."; exit 1 }
if (-not (Test-Path $Script)) { Write-Error "Can't find $Script"; exit 1 }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Run hidden, append to the log, keep the newest ~1 MB.
$cmd = "if ((Test-Path '$Log') -and ((Get-Item '$Log').Length -gt 1MB)) { Move-Item -Force '$Log' '$Log.old' }; & '$Node' '$Script' run --ui --no-open *>> '$Log'"
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`"" -WorkingDirectory $Here
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed '$TaskName' — it starts at sign-in and is running now."
Write-Host "Log: $Log"
Write-Host "Mapping editor: node architect-anytype.mjs ui   (or open http://127.0.0.1:31019 while 'ui' runs)"
