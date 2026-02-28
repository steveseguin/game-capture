@echo off
setlocal

set BASE_DIR=C:\Users\Steve\code\versus-app\native-qt
set SRC=%BASE_DIR%\build\bin
set DIST=%BASE_DIR%\dist
set ARCHIVE_NAME=Versus-Portable
set SFX_MODULE=C:\Program Files\7-Zip\7z.sfx
set SEVENZIP=C:\Program Files\7-Zip\7z.exe

if not exist "%DIST%" mkdir "%DIST%"

echo Creating 7z archive...
"%SEVENZIP%" a -t7z -mx=9 "%DIST%\%ARCHIVE_NAME%.7z" "%SRC%\*" -r

echo Creating self-extracting archive...
copy /b "%SFX_MODULE%" + "%BASE_DIR%\portable-sfx-config.txt" + "%DIST%\%ARCHIVE_NAME%.7z" "%DIST%\%ARCHIVE_NAME%.exe"

echo Cleaning up...
del "%DIST%\%ARCHIVE_NAME%.7z"

echo Done! Created %DIST%\%ARCHIVE_NAME%.exe
dir "%DIST%\%ARCHIVE_NAME%.exe"
