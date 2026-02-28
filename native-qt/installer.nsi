; Versus Native Qt Installer Script
; NSIS 3.x

!include "MUI2.nsh"

; General
Name "Versus"
!ifndef VERSION
!define VERSION "0.2.5"
!endif
!ifndef BUILD_BIN_DIR
!define BUILD_BIN_DIR "build\bin"
!endif
!ifndef OUTFILE
!define OUTFILE "dist\Versus-${VERSION}-Setup.exe"
!endif
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Versus"
InstallDirRegKey HKLM "Software\Versus" "InstallDir"
RequestExecutionLevel admin

; Version Info
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Versus"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Versus - Esports Game Capture"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2024"

; Interface Settings
!define MUI_ABORTWARNING
!define MUI_ICON "resources\versus.ico"
!define MUI_UNICON "resources\versus.ico"

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; Languages
!insertmacro MUI_LANGUAGE "English"

; Installer Section
Section "Install"
    SetOutPath "$INSTDIR"

    ; Main executable
    File "${BUILD_BIN_DIR}\versus-qt.exe"
    File /nonfatal "${BUILD_BIN_DIR}\*.dll"
    File /nonfatal "${BUILD_BIN_DIR}\versus.ico"
    File /nonfatal "${BUILD_BIN_DIR}\RELEASE-NOTES.txt"

    ; Qt plugins - platforms
    SetOutPath "$INSTDIR\platforms"
    File "${BUILD_BIN_DIR}\platforms\qwindows.dll"

    ; Qt plugins - styles
    SetOutPath "$INSTDIR\styles"
    File /nonfatal "${BUILD_BIN_DIR}\styles\qmodernwindowsstyle.dll"

    ; Create shortcuts
    SetOutPath "$INSTDIR"
    CreateDirectory "$SMPROGRAMS\Versus"
    CreateShortcut "$SMPROGRAMS\Versus\Versus.lnk" "$INSTDIR\versus-qt.exe" "" "$INSTDIR\versus-qt.exe"
    CreateShortcut "$SMPROGRAMS\Versus\Uninstall.lnk" "$INSTDIR\uninstall.exe"
    CreateShortcut "$DESKTOP\Versus.lnk" "$INSTDIR\versus-qt.exe" "" "$INSTDIR\versus-qt.exe"

    ; Registry
    WriteRegStr HKLM "Software\Versus" "InstallDir" "$INSTDIR"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Versus" "DisplayName" "Versus"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Versus" "UninstallString" "$INSTDIR\uninstall.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Versus" "DisplayVersion" "${VERSION}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Versus" "DisplayIcon" "$INSTDIR\versus-qt.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Versus" "Publisher" "VDO.Ninja"
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Versus" "NoModify" 1
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Versus" "NoRepair" 1

    ; Create uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

; Uninstaller Section
Section "Uninstall"
    ; Remove files
    Delete "$INSTDIR\*.*"
    RMDir /r "$INSTDIR\platforms"
    RMDir /r "$INSTDIR\styles"
    Delete "$INSTDIR\uninstall.exe"

    ; Remove directories
    RMDir "$INSTDIR"

    ; Remove shortcuts
    Delete "$SMPROGRAMS\Versus\Versus.lnk"
    Delete "$SMPROGRAMS\Versus\Uninstall.lnk"
    Delete "$DESKTOP\Versus.lnk"
    RMDir "$SMPROGRAMS\Versus"

    ; Remove registry
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Versus"
    DeleteRegKey HKLM "Software\Versus"
SectionEnd
