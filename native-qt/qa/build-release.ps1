param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$Version = "0.2.24",
    [switch]$SkipVirusTotal = $false
)

$ErrorActionPreference = "Stop"

function Resolve-ExecutablePath([string]$RepoRoot, [string]$BuildDir, [string]$Configuration) {
    $candidates = @(
        (Join-Path $RepoRoot "$BuildDir/bin/$Configuration/game-capture.exe"),
        (Join-Path $RepoRoot "$BuildDir/bin/game-capture.exe")
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
    throw "Could not locate game-capture.exe in build output. Build first: $BuildDir"
}

$artifactPrefix = "game-capture"
$distRoot = Join-Path $repoRoot "dist"
$stageDir = Join-Path $distRoot "$artifactPrefix-$Version-win64"
$zipPath = Join-Path $distRoot "$artifactPrefix-$Version-win64.zip"
$zipStablePath = Join-Path $distRoot "$artifactPrefix-win64.zip"
$installerVersionedPath = Join-Path $distRoot "$artifactPrefix-$Version-setup.exe"
$installerStablePath = Join-Path $distRoot "$artifactPrefix-setup.exe"
$portableVersionedPath = Join-Path $distRoot "$artifactPrefix-$Version-portable.exe"
$portableStablePath = Join-Path $distRoot "$artifactPrefix-portable.exe"

Write-Step "Stage Artifacts"
if (Test-Path $stageDir) {
    Remove-Item -Recurse -Force $stageDir
}
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
Copy-Item -Path $exePath -Destination (Join-Path $stageDir "game-capture.exe") -Force
Copy-Item -Path (Join-Path $repoRoot "resources/vdoninja.ico") -Destination (Join-Path $stageDir "vdoninja.ico") -Force

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
$notes += "Game Capture Native Qt Release"
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
$notes += "- game-capture.exe"
$notes += "- Qt runtime files (if windeployqt is available)"
$notes += "- vdoninja.ico"

Set-Content -Path (Join-Path $stageDir "RELEASE-NOTES.txt") -Value $notes -Encoding UTF8

Write-Step "Code Signing (Best Effort - Staged Binary)"
$signScript = Join-Path $PSScriptRoot "sign-artifacts.ps1"
if (Test-Path $signScript) {
    try {
        & $signScript -FilePaths @(Join-Path $stageDir "game-capture.exe")
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Code-signing staged binary reported errors; continuing."
        }
    } catch {
        Write-Warning "Code-signing staged binary failed: $($_.Exception.Message)"
        Write-Warning "Continuing without failing release packaging."
    }
} else {
    Write-Host "Code-signing script not found ($signScript); skipped signing."
}

Write-Step "Zip Package"
if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
}
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force
Copy-Item -Path $zipPath -Destination $zipStablePath -Force

Write-Step "Portable EXE"
$sevenZipExe = "C:\Program Files\7-Zip\7z.exe"
$sevenZipSfx = "C:\Program Files\7-Zip\7z.sfx"
$portableConfig = Join-Path $repoRoot "portable-sfx-config.txt"
$portableArchive = Join-Path $distRoot "$artifactPrefix-$Version-portable.7z"
if ((Test-Path $sevenZipExe) -and (Test-Path $sevenZipSfx) -and (Test-Path $portableConfig)) {
    if (Test-Path $portableArchive) {
        Remove-Item -Force $portableArchive
    }
    if (Test-Path $portableVersionedPath) {
        Remove-Item -Force $portableVersionedPath
    }
    & $sevenZipExe a -t7z -mx=9 $portableArchive (Join-Path $stageDir "*")
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create portable archive via 7-Zip."
    }
    cmd /c "copy /b `"$sevenZipSfx`" + `"$portableConfig`" + `"$portableArchive`" `"$portableVersionedPath`" >nul"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create portable executable SFX."
    }
    Copy-Item -Path $portableVersionedPath -Destination $portableStablePath -Force
    Remove-Item -Force $portableArchive
} else {
    Write-Host "7-Zip or portable config missing; skipped portable SFX creation."
}

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
    if (Test-Path $installerVersionedPath) {
        Remove-Item -Force $installerVersionedPath
    }
    & $makensis.Source /V2 "/DVERSION=$Version" "/DBUILD_BIN_DIR=$buildBinDir" "/DOUTFILE=$installerVersionedPath" installer.nsi
    if ($LASTEXITCODE -ne 0) {
        throw "NSIS installer build failed."
    }
    Copy-Item -Path $installerVersionedPath -Destination $installerStablePath -Force
} else {
    Write-Host "makensis not found; skipped installer build."
}

Write-Step "Code Signing (Best Effort - Release EXEs)"
if (Test-Path $signScript) {
    try {
        & $signScript -DistDir $distRoot -Version $Version
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Code-signing script reported errors; continuing."
        }
    } catch {
        Write-Warning "Code-signing step failed: $($_.Exception.Message)"
        Write-Warning "Continuing without failing release packaging."
    }
} else {
    Write-Host "Code-signing script not found ($signScript); skipped signing."
}

Write-Step "VirusTotal Submission (Best Effort)"
if ($SkipVirusTotal) {
    Write-Host "Skipped VirusTotal submission by request."
} else {
    $vtScript = Join-Path $PSScriptRoot "submit-virustotal.ps1"
    if (Test-Path $vtScript) {
        try {
            & $vtScript -DistDir $distRoot -Version $Version
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "VirusTotal submission reported errors; release artifacts are still available."
            }
        } catch {
            Write-Warning "VirusTotal submission failed: $($_.Exception.Message)"
            Write-Warning "Continuing without failing release packaging."
        }
    } else {
        Write-Host "VirusTotal script not found ($vtScript); skipped submission."
    }
}

Write-Host ""
Write-Host "Release staging dir: $stageDir"
Write-Host "Release zip: $zipPath"
if (Test-Path $zipStablePath) {
    Write-Host "Release zip (stable): $zipStablePath"
}
if (Test-Path $installerVersionedPath) {
    Write-Host "Release installer: $installerVersionedPath"
}
if (Test-Path $portableVersionedPath) {
    Write-Host "Release portable: $portableVersionedPath"
}

