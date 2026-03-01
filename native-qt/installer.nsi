; Game Capture Native Qt Installer Script
; NSIS 3.x

!include "MUI2.nsh"

; General
Name "Game Capture"
!ifndef VERSION
!define VERSION "0.2.21"
!endif
!ifndef BUILD_BIN_DIR
!define BUILD_BIN_DIR "build\bin"
!endif
!ifndef OUTFILE
!define OUTFILE "dist\game-capture-setup.exe"
!endif
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

    ; Qt plugins - platforms
    SetOutPath "$INSTDIR\platforms"
    File "${BUILD_BIN_DIR}\platforms\qwindows.dll"

    ; Qt plugins - styles
    SetOutPath "$INSTDIR\styles"
    File /nonfatal "${BUILD_BIN_DIR}\styles\qmodernwindowsstyle.dll"

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

    ; Remove files
    Delete "$INSTDIR\*.*"
    RMDir /r "$INSTDIR\platforms"
    RMDir /r "$INSTDIR\styles"
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

