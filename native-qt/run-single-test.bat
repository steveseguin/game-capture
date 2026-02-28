@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=%PATH%;C:\vcpkg\installed\x64-windows\bin
echo Running test...
C:\Users\Steve\code\versus-app\native-qt\build-test\bin\test_stats_panel.exe -v2
echo Exit code: %ERRORLEVEL%
