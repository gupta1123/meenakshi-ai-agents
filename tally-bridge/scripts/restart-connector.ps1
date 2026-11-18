param([int]$UiPid=0,[int]$WorkerPid=0,[switch]$CloseUi,[string]$InstallerPath="",[string]$InstallerSha256="")
$ErrorActionPreference="Stop"
$installRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$exe=Join-Path $installRoot 'Meenakshi Tally Connector.exe'
$reopenUi=$UiPid -gt 0 -and -not $CloseUi
if ($UiPid -gt 0) {
 if (-not $CloseUi) { Wait-Process -Id $UiPid -Timeout 30 -ErrorAction SilentlyContinue }
 $ui=Get-CimInstance Win32_Process -Filter "ProcessId=$UiPid" -ErrorAction SilentlyContinue
 if ($ui -and $ui.ExecutablePath -eq $exe -and $UiPid -ne $WorkerPid -and $ui.CommandLine -notmatch '(worker|bridge)\.mjs') { $reopenUi=$true; Stop-Process -Id $UiPid -Force -ErrorAction SilentlyContinue }
}
$taskName='Meenakshi Tally Connector (server)'
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
if ($WorkerPid -gt 0) {
 $worker=Get-CimInstance Win32_Process -Filter "ProcessId=$WorkerPid" -ErrorAction SilentlyContinue
 if ($worker -and $worker.ExecutablePath -eq $exe) { Stop-Process -Id $WorkerPid -Force -ErrorAction SilentlyContinue }
}
if ($InstallerPath.Trim()) {
 $privateRoot=[IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Meenakshi\TallyBridge\application-releases'))+[IO.Path]::DirectorySeparatorChar
 $resolvedInstaller=[IO.Path]::GetFullPath($InstallerPath)
 if (-not $resolvedInstaller.StartsWith($privateRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime update path.' }
 if ($InstallerSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash -ne $InstallerSha256) { throw 'Runtime package changed after verification.' }
 $result=Start-Process -FilePath $resolvedInstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="'+$installRoot+'"')) -WindowStyle Hidden -Wait -PassThru
 if ($result.ExitCode -ne 0) { throw 'The runtime update did not complete.' }
}
if ($task) { Start-ScheduledTask -TaskName $taskName }
if ($reopenUi) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; Start-Process -FilePath $exe }
