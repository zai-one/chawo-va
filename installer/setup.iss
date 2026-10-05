; Inno Setup script for Chawo Voice Assistant (Windows). Build: ISCC.exe setup.iss
; Expects the published app in ..\dist\app (dotnet publish output).

#define AppExe "ChawoVoiceAssistant.exe"
#define AppVersion GetStringFileInfo("..\dist\app\ChawoVoiceAssistant.exe", "ProductVersion")
#define AppPublisher "Chawo"
#define AppUrl "https://chawo.ai"

[Setup]
AppId={{7E1B0C4E-6C2B-4B7C-9C57-2D1E1F8A5A10}
AppName={cm:AppName}
AppVersion={#AppVersion}
AppVerName={cm:AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
DefaultDirName={autopf}\ChawoVoiceAssistant
DefaultGroupName={cm:AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=ChawoVoiceAssistant-Setup
SetupIconFile=..\src\Assets\app.ico
WizardImageFile=art\wizard-large-*.png
WizardSmallImageFile=art\wizard-small-*.png
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={cm:AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=auto
DisableWelcomePage=no
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
CloseApplications=force
RestartApplications=no
MinVersion=10.0.17763

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
russian.AppName=Chawo Voice Assistant
english.AppName=Chawo Voice Assistant
russian.AutoStart=Запускать при входе в Windows
english.AutoStart=Start when I sign in to Windows
russian.Extra=Дополнительно:
english.Extra=Additional options:
russian.Launch=Запустить Chawo Voice Assistant
english.Launch=Launch Chawo Voice Assistant
russian.Uninstall=Удалить Chawo Voice Assistant
english.Uninstall=Uninstall Chawo Voice Assistant

[Tasks]
Name: "autostart"; Description: "{cm:AutoStart}"; GroupDescription: "{cm:Extra}"

[Files]
Source: "..\dist\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{cm:AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{cm:Uninstall}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:Launch}"; Flags: nowait postinstall skipifsilent
; Silent runs come from the in-app updater: relaunch without asking, with a "what changed" toast.
Filename: "{app}\{#AppExe}"; Parameters: "--updated"; Flags: nowait; Check: WizardSilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/im {#AppExe} /f"; Flags: runhidden; RunOnceId: "KillApp"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\ChawoVoiceAssistant"
Type: filesandordirs; Name: "{userappdata}\ChawoVoiceAssistant"
; Data folders of versions before 1.17.0, if the first-start move left anything behind.
Type: filesandordirs; Name: "{localappdata}\GigaPisar"
Type: filesandordirs; Name: "{userappdata}\GigaPisar"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ChawoVoiceAssistant"; ValueData: """{app}\{#AppExe}"""; Tasks: autostart
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "ChawoVoiceAssistant"; Flags: deletevalue; Tasks: not autostart
; Whatever set the value (installer task or the app's own checkbox), uninstall removes it.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "ChawoVoiceAssistant"; Flags: uninsdeletevalue
; Run value written before 1.17.0 (pointed at the old EXE).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "GigaPisar"; Flags: deletevalue uninsdeletevalue
