@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
dumpbin /symbols C:\vcpkg\installed\x64-windows-static\plugins\platforms\qwindows.lib | findstr /i "coroutine"
