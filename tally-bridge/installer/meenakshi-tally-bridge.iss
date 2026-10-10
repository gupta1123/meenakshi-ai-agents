#define AppName "Meenakshi Tally Connector"
#define AppVersion "0.3.6"
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

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM "Meenakshi Tally Connector.exe" >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
