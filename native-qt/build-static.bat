@echo off
set PATH=%PATH%;C:\Program Files (x86)\Microsoft Visual Studio\Installer
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
cd /d C:\Users\Steve\code\game-capture\native-qt\build-static
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows-static
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
ninja

