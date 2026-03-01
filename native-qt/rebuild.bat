@echo off
echo Setting up Visual Studio environment...
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set PATH=%PATH%;C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin
set PATH=%PATH%;C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja

cd /d C:\Users\Steve\code\game-capture\native-qt\build

echo Running CMake configure...
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="C:/Users/Steve/code/obs-studio/.deps/obs-deps-qt6-2025-08-23-x64"

echo.
echo Running Ninja build...
ninja game-capture

echo.
echo Build complete. Exit code: %ERRORLEVEL%
dir bin\game-capture.exe

