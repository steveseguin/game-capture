@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=%PATH%;C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin
set PATH=%PATH%;C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja
cd /d C:\Users\Steve\code\versus-app\native-qt\build
cmake --build . --target test-websocket 2>&1
if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo Running WebSocket Test
    echo ========================================
    bin\test-websocket.exe
)
