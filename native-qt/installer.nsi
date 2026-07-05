; Game Capture Native Qt Installer Script
; NSIS 3.x

!include "MUI2.nsh"

; General
Name "Game Capture"
!ifndef VERSION
!define VERSION "0.2.41"
!endif
!ifndef BUILD_BIN_DIR
!define BUILD_BIN_DIR "build\bin"
!endif
!ifndef OUTFILE
!define OUTFILE "dist\game-capture-setup.exe"
!endif
!define FIREWALL_RULE_UDP "Game Capture WebRTC UDP"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Game Capture"
InstallDirRegKey HKLM "Software\GameCapture" "InstallDir"
RequestExecutionLevel admin

; Version Info
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Game Capture"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Game Capture - Windows Game Capture"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026"

; Interface Settings
!define MUI_ABORTWARNING
!define MUI_ICON "resources\vdoninja.ico"
!define MUI_UNICON "resources\vdoninja.ico"

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Languages
!insertmacro MUI_LANGUAGE "English"

Function EnsureGameCaptureClosed
    ; Avoid "Error opening file for writing" when Qt DLLs are still locked.
    nsExec::ExecToLog 'taskkill /F /T /IM game-capture.exe'
FunctionEnd

Function un.EnsureGameCaptureClosed
    ; Uninstaller needs its own function namespace in NSIS.
    nsExec::ExecToLog 'taskkill /F /T /IM game-capture.exe'
FunctionEnd

Function RemoveExistingInstall
    IfFileExists "$INSTDIR\uninstall.exe" 0 done
    DetailPrint "Existing install detected; running previous uninstaller..."
    ExecWait '"$INSTDIR\uninstall.exe" /S _?=$INSTDIR'
done:
FunctionEnd

Function AddFirewallRules
    DetailPrint "Adding Windows Firewall rule for Game Capture WebRTC..."
    ; Replace stale rules so upgrades keep the installed executable path current.
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE_UDP}"'
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FIREWALL_RULE_UDP}" dir=in action=allow program="$INSTDIR\game-capture.exe" protocol=UDP enable=yes profile=any'
FunctionEnd

Function un.RemoveFirewallRules
    DetailPrint "Removing Windows Firewall rule for Game Capture WebRTC..."
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE_UDP}"'
FunctionEnd

; Installer Section
Section "Install"
    Call EnsureGameCaptureClosed
    Call RemoveExistingInstall
    Call EnsureGameCaptureClosed
    Sleep 600

    SetOutPath "$INSTDIR"

    ; Best effort cleanup of stale/legacy file names before copy.
    Delete /REBOOTOK "$INSTDIR\game-capture.exe"
    Delete /REBOOTOK "$INSTDIR\game-catpure.exe"
    Delete /REBOOTOK "$INSTDIR\game-catpure.ede"

    ; Main executable
    ClearErrors
    File "${BUILD_BIN_DIR}\game-capture.exe"
    IfErrors 0 +3
    MessageBox MB_ICONSTOP|MB_OK "Game Capture is still running or files are locked. Close the app and retry setup."
    Abort
    File /nonfatal "${BUILD_BIN_DIR}\*.dll"
    File /nonfatal "${BUILD_BIN_DIR}\vdoninja.ico"
    File /nonfatal "${BUILD_BIN_DIR}\RELEASE-NOTES.txt"

    Call AddFirewallRules

    ; Qt plugins - platforms
    SetOutPath "$INSTDIR\platforms"
    File "${BUILD_BIN_DIR}\platforms\qwindows.dll"

    ; Qt plugins - styles
    SetOutPath "$INSTDIR\styles"
    File /nonfatal "${BUILD_BIN_DIR}\styles\qmodernwindowsstyle.dll"

    ; Qt plugins - generic input
    SetOutPath "$INSTDIR\generic"
    File /nonfatal "${BUILD_BIN_DIR}\generic\*.dll"

    ; Qt plugins - image formats
    SetOutPath "$INSTDIR\imageformats"
    File /nonfatal "${BUILD_BIN_DIR}\imageformats\*.dll"

    ; Qt plugins - network information
    SetOutPath "$INSTDIR\networkinformation"
    File /nonfatal "${BUILD_BIN_DIR}\networkinformation\*.dll"

    ; Qt plugins - TLS
    SetOutPath "$INSTDIR\tls"
    File /nonfatal "${BUILD_BIN_DIR}\tls\*.dll"

    ; Create shortcuts
    SetOutPath "$INSTDIR"
    CreateDirectory "$SMPROGRAMS\Game Capture"
    CreateShortcut "$SMPROGRAMS\Game Capture\Game Capture.lnk" "$INSTDIR\game-capture.exe" "" "$INSTDIR\game-capture.exe"
    CreateShortcut "$SMPROGRAMS\Game Capture\Uninstall.lnk" "$INSTDIR\uninstall.exe"
    CreateShortcut "$DESKTOP\Game Capture.lnk" "$INSTDIR\game-capture.exe" "" "$INSTDIR\game-capture.exe"

    ; Registry
    WriteRegStr HKLM "Software\GameCapture" "InstallDir" "$INSTDIR"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture" "DisplayName" "Game Capture"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture" "UninstallString" "$INSTDIR\uninstall.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture" "DisplayVersion" "${VERSION}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture" "DisplayIcon" "$INSTDIR\game-capture.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture" "Publisher" "VDO.Ninja"
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture" "NoModify" 1
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture" "NoRepair" 1

    ; Create uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

; Uninstaller Section
Section "Uninstall"
    Call un.EnsureGameCaptureClosed
    Call un.RemoveFirewallRules

    ; Remove files
    Delete "$INSTDIR\*.*"
    RMDir /r "$INSTDIR\platforms"
    RMDir /r "$INSTDIR\styles"
    RMDir /r "$INSTDIR\generic"
    RMDir /r "$INSTDIR\imageformats"
    RMDir /r "$INSTDIR\networkinformation"
    RMDir /r "$INSTDIR\tls"
    Delete "$INSTDIR\uninstall.exe"

    ; Remove directories
    RMDir "$INSTDIR"

    ; Remove shortcuts
    Delete "$SMPROGRAMS\Game Capture\Game Capture.lnk"
    Delete "$SMPROGRAMS\Game Capture\Uninstall.lnk"
    Delete "$DESKTOP\Game Capture.lnk"
    RMDir "$SMPROGRAMS\Game Capture"

    ; Remove registry
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture"
    DeleteRegKey HKLM "Software\GameCapture"
SectionEnd

