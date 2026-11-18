param([int]$UiPid=0,[int]$WorkerPid=0,[switch]$CloseUi,[switch]$WaitForWorkerExit,[string]$HandoffFile="",[string]$InstallerPath="",[string]$InstallerSha256="")
$ErrorActionPreference="Stop"
$restartLogDirectory=Join-Path $env:LOCALAPPDATA 'Meenakshi\logs'
New-Item -ItemType Directory -Path $restartLogDirectory -Force | Out-Null
$restartLog=Join-Path $restartLogDirectory ('connector-'+(Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')+'.log')
function Write-RestartLog([string]$Message) { Add-Content -LiteralPath $restartLog -Value ((Get-Date).ToUniversalTime().ToString('o')+' INFO connector restart '+$Message) }
$handoffValidated=$false
function Write-Handoff([string]$State,[string]$ErrorMessage="") {
 if($handoffValidated -and $HandoffFile){[IO.File]::WriteAllText($HandoffFile,(@{state=$State;pid=$PID;error=$ErrorMessage;at=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress))}
}
trap { Write-RestartLog ('failed: '+$_.Exception.Message); Write-Handoff 'failed' $_.Exception.Message; exit 1 }
if($HandoffFile){
 $HandoffFile=[IO.Path]::GetFullPath($HandoffFile)
 if([IO.Path]::GetFileName($HandoffFile) -notmatch '^[a-fA-F0-9-]{36}\.json$' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($HandoffFile)) -ne 'restart-handoffs'){throw 'Invalid restart acknowledgement path.'}
 $handoffValidated=$true
}
Write-RestartLog ('started ui='+$UiPid+' worker='+$WorkerPid)
Write-Handoff 'started'
if($WaitForWorkerExit -and $WorkerPid -gt 0){
 $waitingWorker=Get-Process -Id $WorkerPid -ErrorAction SilentlyContinue
 if($waitingWorker){Wait-Process -Id $WorkerPid -Timeout 150 -ErrorAction Stop}
}
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
if ($task) {
 Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
 $stoppingDeadline=(Get-Date).AddSeconds(15)
 while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
  if ((Get-Date) -gt $stoppingDeadline) { throw 'The previous server task did not stop.' }
  Start-Sleep -Milliseconds 100
 }
}
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
Write-RestartLog ('completed task='+[bool]$task+' ui='+$reopenUi)
Write-Handoff 'completed'
