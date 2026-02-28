param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$Version = "0.2.5"
)

$ErrorActionPreference = "Stop"

function Resolve-ExecutablePath([string]$RepoRoot, [string]$BuildDir, [string]$Configuration) {
    $candidates = @(
        (Join-Path $RepoRoot "$BuildDir/bin/$Configuration/versus-qt.exe"),
        (Join-Path $RepoRoot "$BuildDir/bin/versus-qt.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }
    return ""
}

function Write-Step([string]$Name) {
    Write-Host ""
    Write-Host "=== $Name ==="
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$exePath = Resolve-ExecutablePath -RepoRoot $repoRoot -BuildDir $BuildDir -Configuration $Configuration
if (-not $exePath) {
    throw "Could not locate versus-qt.exe in build output. Build first: $BuildDir"
}

$distRoot = Join-Path $repoRoot "dist"
$stageDir = Join-Path $distRoot "Versus-$Version-win64"
$zipPath = Join-Path $distRoot "Versus-$Version-win64.zip"

Write-Step "Stage Artifacts"
if (Test-Path $stageDir) {
    Remove-Item -Recurse -Force $stageDir
}
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
Copy-Item -Path $exePath -Destination (Join-Path $stageDir "versus-qt.exe") -Force
Copy-Item -Path (Join-Path $repoRoot "resources/versus.ico") -Destination (Join-Path $stageDir "versus.ico") -Force

$windeployqt = Get-Command windeployqt -ErrorAction SilentlyContinue
if ($windeployqt) {
    Write-Step "Run windeployqt"
    & $windeployqt.Source --release --no-translations --compiler-runtime --dir $stageDir $exePath
} else {
    Write-Host "windeployqt not found; copying local runtime files from build output."
    $exeDir = Split-Path -Parent $exePath
    Get-ChildItem -Path $exeDir -Filter "*.dll" -File -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item -Path $_.FullName -Destination $stageDir -Force }
    foreach ($subDir in @("platforms", "styles", "imageformats")) {
        $src = Join-Path $exeDir $subDir
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination (Join-Path $stageDir $subDir) -Recurse -Force
        }
    }
}

$platformsDir = Join-Path $stageDir "platforms"
$stylesDir = Join-Path $stageDir "styles"
New-Item -ItemType Directory -Path $platformsDir -Force | Out-Null
New-Item -ItemType Directory -Path $stylesDir -Force | Out-Null

$qtPluginRootCandidates = @()
if ($env:QT_PLUGIN_PATH) {
    $qtPluginRootCandidates += $env:QT_PLUGIN_PATH
}
$qtPluginRootCandidates += @(
    "C:\vcpkg\installed\x64-windows\Qt6\plugins",
    "C:\Users\Steve\code\obs-studio\.deps\obs-deps-qt6-2025-08-23-x64\plugins"
)

$qwindowsTarget = Join-Path $platformsDir "qwindows.dll"
if (-not (Test-Path $qwindowsTarget)) {
    foreach ($root in $qtPluginRootCandidates) {
        $candidate = Join-Path $root "platforms\qwindows.dll"
        if (Test-Path $candidate) {
            Copy-Item -Path $candidate -Destination $qwindowsTarget -Force
            break
        }
    }
}
if (-not (Test-Path $qwindowsTarget)) {
    throw "Missing required Qt platform plugin qwindows.dll in release staging."
}

$styleTarget = Join-Path $stylesDir "qmodernwindowsstyle.dll"
if (-not (Test-Path $styleTarget)) {
    foreach ($root in $qtPluginRootCandidates) {
        $candidate = Join-Path $root "styles\qmodernwindowsstyle.dll"
        if (Test-Path $candidate) {
            Copy-Item -Path $candidate -Destination $styleTarget -Force
            break
        }
    }
}

$reportDir = Join-Path $repoRoot "qa/reports"
$latestReport = Get-ChildItem -Path $reportDir -Filter "release-readiness-*.md" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

$notes = @()
$notes += "Versus Native Qt Release"
$notes += "Version: $Version"
$notes += "BuildDir: $BuildDir"
$notes += "Configuration: $Configuration"
$notes += "Built: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")"
$notes += ""
if ($latestReport) {
    $notes += "Latest readiness report:"
    $notes += $latestReport.FullName
    $notes += ""
}
$notes += "Contents:"
$notes += "- versus-qt.exe"
$notes += "- Qt runtime files (if windeployqt is available)"
$notes += "- versus.ico"

Set-Content -Path (Join-Path $stageDir "RELEASE-NOTES.txt") -Value $notes -Encoding UTF8

Write-Step "Zip Package"
if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
}
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force

Write-Step "Optional NSIS Installer"
$makensis = Get-Command makensis -ErrorAction SilentlyContinue
if (-not $makensis) {
    foreach ($candidate in @(
        "C:\Program Files (x86)\NSIS\makensis.exe",
        "C:\Program Files\NSIS\makensis.exe"
    )) {
        if (Test-Path $candidate) {
            $makensis = [pscustomobject]@{ Source = $candidate }
            break
        }
    }
}
if ($makensis) {
    $buildBinDir = $stageDir
    & $makensis.Source /V2 "/DVERSION=$Version" "/DBUILD_BIN_DIR=$buildBinDir" installer.nsi
} else {
    Write-Host "makensis not found; skipped installer build."
}

Write-Host ""
Write-Host "Release staging dir: $stageDir"
Write-Host "Release zip: $zipPath"
