@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=%PATH%;C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin
set PATH=%PATH%;C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja
cd /d C:\Users\Steve\code\versus-app\native-qt

if not exist build-test mkdir build-test
cd build-test

echo === Configuring with tests enabled ===
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DVERSUS_BUILD_TESTS=ON -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DCMAKE_PREFIX_PATH=C:/vcpkg/installed/x64-windows
if %ERRORLEVEL% neq 0 exit /b 1

echo === Building ===
cmake --build .
if %ERRORLEVEL% neq 0 exit /b 1

echo === Copying Qt platform plugins ===
if not exist bin\platforms mkdir bin\platforms
copy /Y C:\vcpkg\installed\x64-windows\Qt6\plugins\platforms\qwindows.dll bin\platforms\

echo === Running tests ===
set PATH=%PATH%;C:\vcpkg\installed\x64-windows\bin;C:\vcpkg\installed\x64-windows\debug\bin
ctest --output-on-failure -V
