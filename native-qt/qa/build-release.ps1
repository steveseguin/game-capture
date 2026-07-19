param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$Version = "0.2.45",
    [string]$FfmpegBundleRoot = "",
    [switch]$AllowMissingFfmpeg = $false,
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

function Test-BinaryContainsAsciiString([string]$Path, [string]$Needle) {
    if (-not (Test-Path $Path) -or [string]::IsNullOrWhiteSpace($Needle)) {
        return $false
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)
    return $text.Contains($Needle)
}

function Write-Step([string]$Name) {
    Write-Host ""
    Write-Host "=== $Name ==="
}

function Resolve-Windeployqt {
    $command = Get-Command windeployqt -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidates = @()
    if ($env:VCPKG_ROOT) {
        $candidates += (Join-Path $env:VCPKG_ROOT "installed\x64-windows\tools\Qt6\bin\windeployqt.exe")
    }
    $candidates += @(
        "C:\vcpkg\installed\x64-windows\tools\Qt6\bin\windeployqt.exe",
        "C:\vcpkg\packages\qtbase_x64-windows\tools\Qt6\bin\windeployqt.exe",
        "C:\Users\Steve\code\obs-studio\.deps\obs-deps-qt6-2025-08-23-x64\bin\windeployqt.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }
    return ""
}

function Resolve-RuntimeDll([string]$Name) {
    $roots = @()
    if ($env:VCPKG_ROOT) {
        $roots += (Join-Path $env:VCPKG_ROOT "installed\x64-windows\bin")
    }
    $roots += "C:\vcpkg\installed\x64-windows\bin"

    if ($env:VCINSTALLDIR) {
        $roots += (Join-Path $env:VCINSTALLDIR "Redist\MSVC")
    }
    $roots += @(
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Redist\MSVC",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Redist\MSVC",
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Redist\MSVC",
        "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Redist\MSVC",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\VC\Redist\MSVC",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\Professional\VC\Redist\MSVC",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\Enterprise\VC\Redist\MSVC",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Redist\MSVC"
    )

    foreach ($root in $roots | Select-Object -Unique) {
        if (-not (Test-Path $root)) {
            continue
        }
        $direct = Join-Path $root $Name
        if (Test-Path $direct) {
            return (Resolve-Path $direct).Path
        }
        $match = Get-ChildItem -Path $root -Filter $Name -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '(?i)[\\/](x64|amd64)[\\/]' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($match) {
            return $match.FullName
        }
    }
    return ""
}

function Test-TextContains([string]$Text, [string]$Needle) {
    return $Text.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Assert-FfmpegBundle([string]$BundleRoot) {
    $ffmpegExe = Join-Path $BundleRoot "bin\ffmpeg.exe"
    $manifestPath = Join-Path $BundleRoot "bundle-manifest.json"
    if (-not (Test-Path $ffmpegExe)) {
        throw "FFmpeg bundle missing bin\ffmpeg.exe: $BundleRoot"
    }
    if (-not (Test-Path $manifestPath)) {
        throw "FFmpeg bundle missing bundle-manifest.json: $BundleRoot"
    }

    $manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
    $configText = [string]$manifest.configuration
    if (Test-TextContains -Text $configText -Needle "--enable-gpl") {
        throw "Bundled FFmpeg manifest is GPL-enabled; refusing release package."
    }
    if (Test-TextContains -Text $configText -Needle "--enable-nonfree") {
        throw "Bundled FFmpeg manifest is nonfree-enabled; refusing release package."
    }
    if (-not [bool]$manifest.has_libvpx_vp9) {
        throw "Bundled FFmpeg manifest does not confirm libvpx-vp9."
    }

    $versionOutput = (& $ffmpegExe -hide_banner -version 2>&1) -join "`n"
    $encoderOutput = (& $ffmpegExe -hide_banner -encoders 2>&1) -join "`n"
    if (Test-TextContains -Text $versionOutput -Needle "--enable-gpl") {
        throw "Bundled FFmpeg runtime reports --enable-gpl; refusing release package."
    }
    if (Test-TextContains -Text $versionOutput -Needle "--enable-nonfree") {
        throw "Bundled FFmpeg runtime reports --enable-nonfree; refusing release package."
    }
    if (-not (Test-TextContains -Text $encoderOutput -Needle "libvpx-vp9")) {
        throw "Bundled FFmpeg runtime does not expose libvpx-vp9 encoder."
    }
    return $manifest
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

if ([string]::IsNullOrWhiteSpace($FfmpegBundleRoot)) {
    $FfmpegBundleRoot = Join-Path $repoRoot "third_party\ffmpeg-win64"
}

$exePath = Resolve-ExecutablePath -RepoRoot $repoRoot -BuildDir $BuildDir -Configuration $Configuration
if (-not $exePath) {
    throw "Could not locate game-capture.exe in build output. Build first: $BuildDir"
}
if (-not (Test-BinaryContainsAsciiString -Path $exePath -Needle $Version)) {
    throw "Selected executable does not contain the requested version string '$Version': $exePath. Rebuild before packaging."
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
$ffmpegSourceInfoVersionedPath = Join-Path $distRoot "$artifactPrefix-$Version-ffmpeg-source-info.zip"
$ffmpegSourceInfoStablePath = Join-Path $distRoot "$artifactPrefix-ffmpeg-source-info.zip"

Write-Step "Stage Artifacts"
if (Test-Path $stageDir) {
    Remove-Item -Recurse -Force $stageDir
}
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
Copy-Item -Path $exePath -Destination (Join-Path $stageDir "game-capture.exe") -Force
Copy-Item -Path (Join-Path $repoRoot "resources/vdoninja.ico") -Destination (Join-Path $stageDir "vdoninja.ico") -Force

$windeployqt = Resolve-Windeployqt
if ($windeployqt) {
    Write-Step "Run windeployqt"
    & $windeployqt --release --no-translations --compiler-runtime --dir $stageDir $exePath
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

Write-Step "Runtime DLL Closure"
$runtimeDlls = @(
    "brotlicommon.dll",
    "brotlidec.dll",
    "bz2.dll",
    "double-conversion.dll",
    "freetype.dll",
    "harfbuzz.dll",
    "jpeg62.dll",
    "libcrypto-3-x64.dll",
    "libpng16.dll",
    "md4c.dll",
    "pcre2-16.dll",
    "zlib1.dll",
    "zstd.dll",
    "MSVCP140.dll",
    "MSVCP140_1.dll",
    "MSVCP140_2.dll",
    "VCRUNTIME140.dll",
    "VCRUNTIME140_1.dll"
)
foreach ($dll in $runtimeDlls) {
    $target = Join-Path $stageDir $dll
    if (Test-Path $target) {
        continue
    }
    $source = Resolve-RuntimeDll $dll
    if ($source) {
        Copy-Item -Path $source -Destination $target -Force
        Write-Host "Copied $dll"
    } else {
        Write-Warning "Could not locate runtime dependency $dll"
    }
}

Write-Step "FFmpeg Bundle"
$ffmpegManifest = $null
$ffmpegStageDir = Join-Path $stageDir "ffmpeg"
if (Test-Path (Join-Path $FfmpegBundleRoot "bin\ffmpeg.exe")) {
    $ffmpegManifest = Assert-FfmpegBundle -BundleRoot $FfmpegBundleRoot
    if (Test-Path $ffmpegStageDir) {
        Remove-Item -Recurse -Force $ffmpegStageDir
    }
    New-Item -ItemType Directory -Path $ffmpegStageDir -Force | Out-Null
    Copy-Item -Path (Join-Path $FfmpegBundleRoot "*") -Destination $ffmpegStageDir -Recurse -Force
    Write-Host "Staged FFmpeg: $ffmpegStageDir"
    Write-Host "FFmpeg: $($ffmpegManifest.ffmpeg_version)"
} elseif ($AllowMissingFfmpeg) {
    Write-Warning "FFmpeg bundle missing; continuing because -AllowMissingFfmpeg was set."
} else {
    throw "FFmpeg bundle missing. Run native-qt/tools/fetch-ffmpeg-lgpl.ps1 before release packaging, or pass -AllowMissingFfmpeg for dev-only packaging."
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
if ($ffmpegManifest) {
    $notes += "- FFmpeg LGPL shared bundle ($($ffmpegManifest.ffmpeg_version))"
    $notes += "- FFmpeg source/build info archive: $artifactPrefix-$Version-ffmpeg-source-info.zip"
}

Set-Content -Path (Join-Path $stageDir "RELEASE-NOTES.txt") -Value $notes -Encoding UTF8

if ($ffmpegManifest) {
    Write-Step "FFmpeg Source/Build Info Archive"
    $sourceInfoDir = Join-Path $distRoot "$artifactPrefix-$Version-ffmpeg-source-info"
    if (Test-Path $sourceInfoDir) {
        Remove-Item -Recurse -Force $sourceInfoDir
    }
    New-Item -ItemType Directory -Path $sourceInfoDir -Force | Out-Null
    foreach ($name in @("bundle-manifest.json", "BUILDINFO.txt", "SOURCES.txt", "SHA256SUMS.txt", "README.txt", "LICENSE.txt", "VERSION.txt")) {
        $source = Join-Path $FfmpegBundleRoot $name
        if (Test-Path $source) {
            Copy-Item -Path $source -Destination (Join-Path $sourceInfoDir $name) -Force
        }
    }
    $licensesSource = Join-Path $FfmpegBundleRoot "licenses"
    if (Test-Path $licensesSource) {
        Copy-Item -Path $licensesSource -Destination (Join-Path $sourceInfoDir "licenses") -Recurse -Force
    }
    if (Test-Path $ffmpegSourceInfoVersionedPath) {
        Remove-Item -Force $ffmpegSourceInfoVersionedPath
    }
    Compress-Archive -Path (Join-Path $sourceInfoDir "*") -DestinationPath $ffmpegSourceInfoVersionedPath -Force
    Copy-Item -Path $ffmpegSourceInfoVersionedPath -Destination $ffmpegSourceInfoStablePath -Force
    Remove-Item -Recurse -Force $sourceInfoDir
}

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
if (Test-Path $ffmpegSourceInfoVersionedPath) {
    Write-Host "FFmpeg source/build info: $ffmpegSourceInfoVersionedPath"
}

