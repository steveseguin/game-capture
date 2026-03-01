@echo off
setlocal

set BASE_DIR=%~dp0
if "%BASE_DIR:~-1%"=="\" set BASE_DIR=%BASE_DIR:~0,-1%
set SRC=%BASE_DIR%\build\bin
set DIST=%BASE_DIR%\dist
set ARCHIVE_NAME=game-capture-portable
set SFX_MODULE=C:\Program Files\7-Zip\7z.sfx
set SEVENZIP=C:\Program Files\7-Zip\7z.exe

if not exist "%DIST%" mkdir "%DIST%"

if not exist "%SRC%\game-capture.exe" (
  echo Missing source executable: %SRC%\game-capture.exe
  echo Build the app first so portable packaging has staged binaries.
  exit /b 1
)

echo Creating 7z archive...
"%SEVENZIP%" a -t7z -mx=9 "%DIST%\%ARCHIVE_NAME%.7z" "%SRC%\*" -r
if errorlevel 1 exit /b %errorlevel%

echo Creating self-extracting archive...
copy /b "%SFX_MODULE%" + "%BASE_DIR%\portable-sfx-config.txt" + "%DIST%\%ARCHIVE_NAME%.7z" "%DIST%\%ARCHIVE_NAME%.exe"
if errorlevel 1 exit /b %errorlevel%

echo Cleaning up...
del "%DIST%\%ARCHIVE_NAME%.7z"

echo Done! Created %DIST%\%ARCHIVE_NAME%.exe
dir "%DIST%\%ARCHIVE_NAME%.exe"

