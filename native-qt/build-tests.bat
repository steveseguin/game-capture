@echo off
setlocal

REM Build and run tests for Game Capture Native Qt
REM Run this from a Visual Studio Developer Command Prompt

echo === Game Capture Native Qt Test Build ===

REM Create test build directory
if not exist build-test mkdir build-test
cd build-test

REM Configure with tests enabled
echo Configuring CMake with tests enabled...
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DVERSUS_BUILD_TESTS=ON
if %ERRORLEVEL% neq 0 (
    echo CMake configuration failed!
    exit /b 1
)

REM Build
echo Building...
cmake --build .
if %ERRORLEVEL% neq 0 (
    echo Build failed!
    exit /b 1
)

REM Run tests
echo Running tests...
ctest --output-on-failure
if %ERRORLEVEL% neq 0 (
    echo Some tests failed!
    exit /b 1
)

echo === All tests passed! ===
