# Sets up the Meenakshi Tally connector to run as a permanent SERVER connector.
#
# Run once in an elevated PowerShell on the Tally server, after the connector
# has been paired (Meenakshi connection link) and Tally is open with the company:
#
#   powershell -ExecutionPolicy Bypass -File install-server-task.ps1 -NodePath "C:\Program Files\nodejs\node.exe" -BridgePath "C:\path\to\tally-bridge\src\bridge.mjs"
#
# It does three things:
#   1. switches the connector to server mode (checks come from the cloud queue);
#   2. creates a scheduled task that starts the connector when the chosen Windows
#      user logs on (the same user who paired it and who opens Tally), with no
#      window, and restarts it after a crash. Disconnecting Remote Desktop does
#      not log the user off, so it keeps running;
#   3. starts it now.
# To go back to a normal PC connector, run with -Remove.
param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$BridgePath,
  [string]$UserName = "$env:USERDOMAIN\$env:USERNAME",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$taskName = "Meenakshi Tally Connector (server)"

if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  & $NodePath $BridgePath set-mode --mode pc
  Write-Host "Server task removed and connector set back to PC mode."
  exit 0
}

if (-not (Test-Path $NodePath)) { throw "Node was not found at $NodePath" }
if (-not (Test-Path $BridgePath)) { throw "The connector was not found at $BridgePath" }

& $NodePath $BridgePath set-mode --mode server

$action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$BridgePath`" start"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserName
# Same user as the pairing, so the connector finds its saved configuration.
$principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Server mode is on. The connector starts whenever $UserName logs on, and restarts if it stops."
Write-Host "After a server reboot: log on as $UserName, then open Tally Prime with the company. Checks wait until Tally is ready."
