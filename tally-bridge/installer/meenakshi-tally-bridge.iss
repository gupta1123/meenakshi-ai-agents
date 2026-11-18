#define AppName "Meenakshi Tally Connector"
#define AppVersion "0.6.2"
#define AppPublisher "Meenakshi"
#define AppInstallDir "C:\Meenakshi\tally-bridge"
#define AppExeName "Meenakshi Tally Connector.exe"

[Setup]
AppId={{A91F7FE3-7BD5-4A0F-9F4C-2D5DFE6F4A71}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
UninstallDisplayName={#AppName}
DefaultDirName={#AppInstallDir}
DisableProgramGroupPage=yes
DisableReadyPage=no
OutputDir=output
OutputBaseFilename=MeenakshiTallyConnectorSetup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
Uninstallable=yes
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
SetupIconFile=electron-app\app.ico
UninstallDisplayIcon={app}\resources\app\app.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[InstallDelete]
Type: filesandordirs; Name: "{app}\*"

[Files]
Source: "payload-clean\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Classes\meenakshi-tally"; ValueType: string; ValueName: ""; ValueData: "URL:Meenakshi Tally Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\meenakshi-tally"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\meenakshi-tally\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\resources\app\app.ico"
Root: HKCU; Subkey: "Software\Classes\meenakshi-tally\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "Meenakshi Tally Connector"; Flags: deletevalue

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\resources\app\app.ico"
Name: "{group}\{#AppName} logs"; Filename: "{localappdata}\Meenakshi\logs"

[Tasks]
Name: "server"; Description: "Set up as the shared Tally server"; Flags: checkedonce

[Run]
Filename: "{app}\{#AppExeName}"; Parameters: "--setup-server"; Description: "Launch and set up the Tally server"; Tasks: server; Flags: nowait postinstall skipifsilent
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Tasks: not server; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Stopped: Boolean;
begin
  Stopped := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -Command "$ErrorActionPreference=''Stop''; $task=Get-ScheduledTask -TaskName ''Meenakshi Tally Connector (server)'' -ErrorAction SilentlyContinue; if($task){Stop-ScheduledTask -InputObject $task; $deadline=(Get-Date).AddSeconds(15); while((Get-ScheduledTask -TaskName $task.TaskName).State -eq ''Running''){if((Get-Date) -gt $deadline){exit 1}; Start-Sleep -Milliseconds 100}}"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if (not Stopped) or (ResultCode <> 0) then begin
    Result := 'The background connector could not be stopped. Close its Windows server task, then retry setup.';
    Exit;
  end;
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM "Meenakshi Tally Connector.exe" >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
