# Isolated hosted Windows compile/unit gates; no capture or media qualification.
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$report = Join-Path $PSScriptRoot 'reports/windows-build-gate'
$build = Join-Path $repo 'native-qt/build-windows-hosted'
New-Item -ItemType Directory -Path $report -Force | Out-Null
$gate = [ordered]@{
    scope = 'Windows compile, backend-selection and isolated capability gates; not application testing or a release package'
    sourceRevision = (& git -C $repo rev-parse HEAD)
    qtVersion = '6.9.3'
    aqtVersion = '3.3.0'
    runnerImage = $env:ImageVersion
    startedUtc = [DateTime]::UtcNow.ToString('o')
    applicationTestingCompleted = $false
    passed = $false
}
try {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'MSVC x64 tools unavailable' }
    # Import compiler variables without printing the runner environment.
    $devcmd = Join-Path $vs 'Common7/Tools/VsDevCmd.bat'
    $compilerEnvironment = & cmd.exe /d /s /c "`"$devcmd`" -arch=amd64 -host_arch=amd64 >nul && set"
    if ($LASTEXITCODE -ne 0) { throw 'MSVC environment initialization failed' }
    foreach ($line in $compilerEnvironment) {
        if ($line -match '^([^=]+)=(.*)$') { Set-Item -Path ('Env:' + $Matches[1]) -Value $Matches[2] }
    }
    $gate.compiler = (Get-Command cl.exe).Source
    $gate.visualStudio = $vs
    $gate.windowsSdk = $env:WindowsSDKVersion
    & cmake --version | Out-File (Join-Path $report 'cmake-version.txt')
    if ($LASTEXITCODE -ne 0) { throw 'CMake unavailable' }
    & ninja --version | Out-File (Join-Path $report 'ninja-version.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Ninja unavailable' }

    $venv = Join-Path $env:RUNNER_TEMP 'game-capture-build-python'
    & py -3.12 -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
    $python = Join-Path $venv 'Scripts/python.exe'
    & $python -m pip install --disable-pip-version-check 'aqtinstall==3.3.0' 2>&1 | Tee-Object (Join-Path $report 'aqt-install.log')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Qt installer setup failed' }
    & $python -m pip freeze | Out-File (Join-Path $report 'python-packages.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Python inventory failed' }
    $qtParent = Join-Path $env:RUNNER_TEMP 'game-capture-qt'
    & $python -m aqt install-qt windows desktop 6.9.3 win64_msvc2022_64 --outputdir $qtParent --archives qtbase 2>&1 | Tee-Object (Join-Path $report 'qt-install.log')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned Qt installation failed' }
    $qt = Join-Path $qtParent '6.9.3/msvc2022_64'
    $env:PATH = (Join-Path $qt 'bin') + ';' + $env:PATH
    $actualQt = (& (Join-Path $qt 'bin/qmake.exe') -query QT_VERSION)
    if ($LASTEXITCODE -ne 0 -or $actualQt.Trim() -ne '6.9.3') { throw 'Unexpected Qt installation' }

    & cmake -S (Join-Path $repo 'native-qt') -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_PREFIX_PATH=$qt" -DVERSUS_BUILD_TESTS=ON 2>&1 | Tee-Object (Join-Path $report 'configure.log')
    if ($LASTEXITCODE -ne 0) { throw 'Windows configure gate failed' }
    & cmake --build $build --config Release --target game-capture test_platform_capabilities --parallel 2 2>&1 | Tee-Object (Join-Path $report 'build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Windows compile/link gate failed' }
    & $python (Join-Path $PSScriptRoot 'windows-build-selection.py') --build $build --output (Join-Path $report 'backend-selection.json')
    if ($LASTEXITCODE -ne 0) { throw 'Windows backend selection gate failed' }
    & ctest --test-dir $build -R '^PlatformCapabilitiesGate$' --no-tests=error --output-on-failure 2>&1 | Tee-Object (Join-Path $report 'capability-gate.log')
    if ($LASTEXITCODE -ne 0) { throw 'Compiled Windows capability gate failed' }
    $gate.passed = $true
} catch {
    $gate.error = $_.Exception.Message
    throw
} finally {
    $gate.endedUtc = [DateTime]::UtcNow.ToString('o')
    $gate | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $report 'result.json')
    foreach ($name in @('CMakeCache.txt', 'compile_commands.json')) {
        $file = Join-Path $build $name
        if (Test-Path $file) { Copy-Item $file $report }
    }
    $depRoot = Join-Path $build '_deps'
    if (Test-Path $depRoot) {
        $revisions = @{}
        Get-ChildItem $depRoot -Directory -Filter '*-src' | ForEach-Object {
            $revision = & git -C $_.FullName rev-parse HEAD 2>$null
            if ($LASTEXITCODE -eq 0) { $revisions[$_.Name] = $revision }
        }
        $revisions | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $report 'dependency-revisions.json')
    }
}
