@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" > nul 2>&1
set PATH=%PATH%;C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja
cd /d C:\Users\Steve\code\game-capture\native-qt\build
ninja > C:\Users\Steve\code\game-capture\native-qt\build_output.txt 2>&1
type C:\Users\Steve\code\game-capture\native-qt\build_output.txt

