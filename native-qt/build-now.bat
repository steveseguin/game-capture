@echo off
echo Starting build...
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d C:\Users\Steve\code\game-capture\native-qt\build
echo Running ninja...
ninja game-capture
echo Build complete. Exit code: %ERRORLEVEL%
echo.
dir bin\game-capture.exe

