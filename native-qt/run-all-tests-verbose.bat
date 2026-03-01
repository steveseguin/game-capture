@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=%PATH%;C:\vcpkg\installed\x64-windows\bin

cd /d C:\Users\Steve\code\game-capture\native-qt\build-test
ctest --output-on-failure -V

