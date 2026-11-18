# Sets up the Meenakshi Tally connector to run as a permanent SERVER connector.
#
# Run once as the paired Windows user on the Tally server, after the connector
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
  [string]$NodePath = (Join-Path $PSScriptRoot 'Meenakshi Tally Connector.exe'),
  [string]$BridgePath = (Join-Path $PSScriptRoot 'resources\app\worker.mjs'),
  [string]$UserName = "$env:USERDOMAIN\$env:USERNAME",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$taskName = "Meenakshi Tally Connector (server)"
# The packaged Electron executable includes Node; standalone Node is optional.
$env:ELECTRON_RUN_AS_NODE = '1'

function Set-ConnectorMode([string]$Mode) {
  $modeProcess = Start-Process -FilePath $NodePath -ArgumentList @("`"$BridgePath`"", 'set-mode', '--mode', $Mode) -WindowStyle Hidden -Wait -PassThru
  if ($modeProcess.ExitCode -ne 0) { throw "Could not configure $Mode mode. Pair the connector first." }
}

if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  Set-ConnectorMode 'pc'
  Write-Host "Server task removed and connector set back to PC mode."
  exit 0
}

if (-not (Test-Path $NodePath)) { throw "Node was not found at $NodePath" }
if (-not (Test-Path $BridgePath)) { throw "The connector was not found at $BridgePath" }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
$activeBridge = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains($BridgePath) -and $_.CommandLine -match '\sstart(?:\s|$)'
}
if ($activeBridge) { throw 'Exit the running Meenakshi connector before enabling server startup, then run this script again.' }

Set-ConnectorMode 'server'

$runner = Join-Path $PSScriptRoot 'start-server-connector.vbs'
if (-not (Test-Path -LiteralPath $runner)) { throw "Missing packaged server runner: $runner" }
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$runner`" `"$NodePath`" `"$BridgePath`""
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
