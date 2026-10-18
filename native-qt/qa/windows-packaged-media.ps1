# Build and extract the normal Windows package, then exercise the actual app.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$report = Join-Path $PSScriptRoot 'reports/windows-packaged-media'
New-Item -ItemType Directory -Path $report -Force | Out-Null
$result = [ordered]@{ scope = 'Fresh hosted Windows package and software-media workflows; no physical hardware or production qualification'; sourceRevision = (& git -C $repo rev-parse HEAD); steps = @(); passed = $false }
try {
    # Follow the source revision under review instead of pinning this workflow
    # to an older release. The normal packager also checks the executable version.
    $projectFile = Join-Path $repo 'native-qt/CMakeLists.txt'
    $projectVersions = [regex]::Matches((Get-Content -LiteralPath $projectFile -Raw),
        '(?m)^\s*project\s*\(\s*game-capture-native-qt\s+VERSION\s+([0-9]+\.[0-9]+\.[0-9]+)(?=\s|\))')
    if ($projectVersions.Count -ne 1) { throw 'Expected one native application project version' }
    $packageVersion = $projectVersions[0].Groups[1].Value
    $result.requestedVersion = $packageVersion
    # Known Windows source/backend gates are retained separately from workflows.
    & (Join-Path $PSScriptRoot 'windows-build-gate.ps1')
    $result.steps += @{ name = 'build-and-backend-gates'; kind = 'gate'; passed = $true }
    Set-Location $repo
    & (Join-Path $repo 'native-qt/tools/fetch-ffmpeg-lgpl.ps1')
    if (-not $?) { throw 'Pinned FFmpeg preparation failed' }
    # Snapshot the exact source before invoking the existing package builder.
    . (Join-Path $PSScriptRoot 'release-source-snapshot.ps1')
    $snapshot = Get-ReleaseSourceSnapshot -SourceRoot (Join-Path $repo 'native-qt')
    if (-not $snapshot) { throw 'No source snapshot' }
    & (Join-Path $PSScriptRoot 'build-release.ps1') -BuildDir build-windows-hosted -Version $packageVersion `
        -ExpectedSourceSnapshotSha256 $snapshot.sha256 -ExpectedSourceSnapshotFileCount $snapshot.fileCount `
        -ExpectedSourceSnapshotAlgorithm $snapshot.algorithm -SkipVirusTotal -RequireReleaseArtifacts -RuntimeDependencyMode Imported
    if (-not $?) { throw 'Windows packaging failed' }
    Set-Location $repo
    $archive = Join-Path $repo "native-qt/dist/game-capture-$packageVersion-win64.zip"
    $extracted = Join-Path $env:RUNNER_TEMP ('game-capture-packaged-' + [guid]::NewGuid().ToString())
    Expand-Archive -LiteralPath $archive -DestinationPath $extracted
    $exe = Join-Path $extracted 'game-capture.exe'
    $manifest = Join-Path $extracted 'release-artifact-manifest.json'
    if (-not (Test-Path $exe) -or -not (Test-Path $manifest)) { throw 'Package extraction incomplete' }
    $manifestSha = (Get-FileHash $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.archiveSha256 = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.executableSha256 = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.manifestSha256 = $manifestSha
    Copy-Item $manifest (Join-Path $report 'release-artifact-manifest.json')
    Copy-Item (Join-Path $extracted 'runtime-dependencies.json') (Join-Path $report 'runtime-dependencies.json')
    $result.steps += @{ name = 'normal-packaging-and-extraction'; kind = 'gate'; passed = $true }
    & npm.cmd ci --prefix (Join-Path $repo 'native-qt') --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Pinned browser tooling install failed' }
    Push-Location (Join-Path $repo 'native-qt')
    try { & npx.cmd playwright install chromium; if ($LASTEXITCODE -ne 0) { throw 'Browser install failed' } }
    finally { Pop-Location }
    $node = (Get-Command node.exe).Source
    $python = Join-Path $env:RUNNER_TEMP 'game-capture-build-python/Scripts/python.exe'
    # Prevent the compiled application's dependency search from borrowing Qt
    # or DLLs from the build tree. Only the extracted package supplies them.
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\Wbem"
    foreach ($key in @('QT_PLUGIN_PATH','QML2_IMPORT_PATH','QT_QPA_PLATFORM_PLUGIN_PATH')) { Remove-Item ('Env:' + $key) -ErrorAction SilentlyContinue }
    $result.session = @{ interactive = [Environment]::UserInteractive; processSessionId = (Get-Process -Id $PID).SessionId }
    $result.videoControllers = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
    & $python (Join-Path $repo 'native-qt/e2e/diagnostics-snapshot-packaged-e2e.py') --publisher $exe --reports (Join-Path $report 'diagnostics') --iterations 10 *> (Join-Path $report 'private-diagnostics.log')
    $diagnosticsPassed = $LASTEXITCODE -eq 0
    $result.steps += @{ name = 'packaged-diagnostics-shutdown'; kind = 'application workflow'; passed = $diagnosticsPassed }
    & $node (Join-Path $repo 'native-qt/e2e/windows-hosted-media.js') "--publisher=$exe" "--reports=$(Join-Path $report 'media')" "--manifest-sha256=$manifestSha"
    $mediaPassed = $LASTEXITCODE -eq 0
    $result.steps += @{ name = 'packaged-software-window-media'; kind = 'application workflow'; passed = $mediaPassed }
    if (-not $diagnosticsPassed -or -not $mediaPassed) { throw "Packaged workflows incomplete: diagnostics=$diagnosticsPassed media=$mediaPassed" }
    $result.passed = $true
} catch {
    $result.error = $_.Exception.Message
    throw
} finally {
    $result.endedUtc = [DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 (Join-Path $report 'result.json')
}
