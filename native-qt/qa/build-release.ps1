param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$Version = "0.2.49",
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ExpectedSourceSnapshotSha256,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [long]::MaxValue)]
    [long]$ExpectedSourceSnapshotFileCount,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedSourceSnapshotAlgorithm,
    [string]$FfmpegBundleRoot = "",
    [switch]$AllowMissingFfmpeg = $false,
    [switch]$SkipVirusTotal = $false,
    [switch]$RequireReleaseArtifacts = $false
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'release-source-snapshot.ps1')

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

function ConvertTo-RootRelativePath([string]$Root, [string]$Path) {
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    $rootPrefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not $pathFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the release source root: $pathFull"
    }
    return $pathFull.Substring($rootPrefix.Length).Replace('\', '/')
}

function Get-ReleasePayloadInventory {
    param(
        [Parameter(Mandatory = $true)][string]$StageRoot,
        [Parameter(Mandatory = $true)][string]$ExcludedRelativePath
    )

    $rootItem = Get-Item -LiteralPath $StageRoot -ErrorAction Stop
    if (-not $rootItem.PSIsContainer -or
        ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Release payload root must be a regular directory: $StageRoot"
    }

    $normalizedExcludedPath = $ExcludedRelativePath.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($normalizedExcludedPath) -or
        [System.IO.Path]::IsPathRooted($normalizedExcludedPath) -or
        $normalizedExcludedPath -match '(^|/)\.\.(/|$)' -or
        $normalizedExcludedPath.Contains('\')) {
        throw "Excluded release payload path is not normalized: $ExcludedRelativePath"
    }

    $entriesByPath = [System.Collections.Generic.SortedDictionary[string, object]]::new(
        [System.StringComparer]::Ordinal)
    $pendingDirectories = [System.Collections.Generic.Queue[System.IO.DirectoryInfo]]::new()
    $pendingDirectories.Enqueue([System.IO.DirectoryInfo]$rootItem)
    while ($pendingDirectories.Count -gt 0) {
        $directory = $pendingDirectories.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Release payload contains a reparse point: $($item.FullName)"
            }
            if ($item.PSIsContainer) {
                $pendingDirectories.Enqueue([System.IO.DirectoryInfo]$item)
                continue
            }
            if ($item -isnot [System.IO.FileInfo]) {
                throw "Release payload contains an unsupported filesystem object: $($item.FullName)"
            }

            $relativePath = ConvertTo-RootRelativePath -Root $rootItem.FullName -Path $item.FullName
            if ($relativePath -ieq $normalizedExcludedPath) {
                if ($relativePath -cne $normalizedExcludedPath) {
                    throw "Release manifest path has non-canonical casing: $relativePath"
                }
                continue
            }
            if ([string]::IsNullOrWhiteSpace($relativePath) -or
                [System.IO.Path]::IsPathRooted($relativePath) -or
                $relativePath.Contains('\') -or
                $relativePath -match '(^|/)\.\.(/|$)') {
                throw "Release payload path is not normalized: $relativePath"
            }
            if ([int64]$item.Length -lt 1) {
                throw "Release payload files must have positive size: $relativePath"
            }
            if ($entriesByPath.ContainsKey($relativePath)) {
                throw "Release payload contains a duplicate normalized path: $relativePath"
            }

            $entry = [pscustomobject]([ordered]@{
                relativePath = $relativePath
                size = [int64]$item.Length
                sha256 = (Microsoft.PowerShell.Utility\Get-FileHash `
                    -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            })
            $entriesByPath.Add($relativePath, $entry)
        }
    }

    if ($entriesByPath.Count -lt 1) {
        throw 'Release payload inventory is empty.'
    }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        foreach ($entry in $entriesByPath.Values) {
            $line = "$($entry.relativePath)`0$($entry.size)`0$($entry.sha256)`n"
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
            [void]$hasher.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0)
        }
        [void]$hasher.TransformFinalBlock([byte[]]@(), 0, 0)
        $aggregateSha256 = ([System.BitConverter]::ToString($hasher.Hash)).Replace('-', '').ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }

    return [pscustomobject]([ordered]@{
        algorithm = 'sha256(utf8(relative-path-nul-size-nul-sha256-lf))/ordinal-sort/v1'
        fileCount = [int64]$entriesByPath.Count
        aggregateSha256 = $aggregateSha256
        files = @($entriesByPath.Values)
    })
}

function Get-ReleaseSourceProvenance([string]$SourceRoot) {
    $gitCommit = $null
    $dirty = $null
    $statusEntryCount = $null
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $insideWorktree = (& $git.Source -C $SourceRoot rev-parse --is-inside-work-tree 2>$null) -join ''
        if ($LASTEXITCODE -eq 0 -and $insideWorktree.Trim() -eq 'true') {
            $commitText = (& $git.Source -C $SourceRoot rev-parse HEAD 2>$null) -join ''
            if ($LASTEXITCODE -eq 0 -and
                $commitText.Trim() -match '^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$') {
                $gitCommit = $commitText.Trim().ToLowerInvariant()
            }
            $statusEntries = @(& $git.Source -C $SourceRoot status --porcelain=v1 --untracked-files=all 2>$null)
            if ($LASTEXITCODE -eq 0) {
                $statusEntryCount = $statusEntries.Count
                $dirty = $statusEntryCount -gt 0
            }
        }
    }

    $snapshot = Get-ReleaseSourceSnapshot -SourceRoot $SourceRoot
    return [pscustomobject]([ordered]@{
        gitCommit = $gitCommit
        dirty = $dirty
        statusEntryCount = $statusEntryCount
        snapshotSha256 = if ($snapshot) { $snapshot.sha256 } else { $null }
        snapshotFileCount = if ($snapshot) { $snapshot.fileCount } else { $null }
        snapshotAlgorithm = if ($snapshot) { $snapshot.algorithm } else { $null }
        snapshotScope = 'native-qt tracked and untracked non-ignored files at packaging time; not a reproducible-build claim'
    })
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

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must use numeric semantic version format (for example, 0.2.48)."
}
if ($Configuration -cne 'Release') {
    throw "Release packaging requires Configuration=Release."
}

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
$sourceExecutableRelativePath = ConvertTo-RootRelativePath -Root $repoRoot -Path $exePath
$sourceExecutableInfo = Get-Item -LiteralPath $exePath -ErrorAction Stop
$sourceExecutableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()

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
$sourceInfoDir = Join-Path $distRoot "$artifactPrefix-$Version-ffmpeg-source-info"
$portableArchive = Join-Path $distRoot "$artifactPrefix-$Version-portable.7z"
$releaseManifestPath = Join-Path $stageDir "release-artifact-manifest.json"

$sevenZipExe = "C:\Program Files\7-Zip\7z.exe"
$sevenZipSfx = "C:\Program Files\7-Zip\7z.sfx"
$portableConfig = Join-Path $repoRoot "portable-sfx-config.txt"
$makensis = Get-Command makensis -ErrorAction SilentlyContinue
if (-not $makensis) {
    foreach ($candidate in @(
        "C:\Program Files (x86)\NSIS\makensis.exe",
        "C:\Program Files\NSIS\makensis.exe"
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $makensis = [pscustomobject]@{ Source = $candidate }
            break
        }
    }
}
if (-not (Test-Path -LiteralPath $sevenZipExe -PathType Leaf) -or
     -not (Test-Path -LiteralPath $sevenZipSfx -PathType Leaf) -or
     -not (Test-Path -LiteralPath $portableConfig -PathType Leaf)) {
    throw "7-Zip, its SFX module, and portable-sfx-config.txt are required for release artifacts."
}
if (-not $makensis) {
    throw "NSIS makensis is required for release artifacts."
}

$ffmpegManifest = $null
if (Test-Path -LiteralPath (Join-Path $FfmpegBundleRoot "bin\ffmpeg.exe") -PathType Leaf) {
    $ffmpegManifest = Assert-FfmpegBundle -BundleRoot $FfmpegBundleRoot
} elseif (-not $AllowMissingFfmpeg) {
    throw "FFmpeg bundle missing. Run native-qt/tools/fetch-ffmpeg-lgpl.ps1 before release packaging, or pass -AllowMissingFfmpeg for dev-only packaging."
}

if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $stageDir) { throw "Stale stage directory survived cleanup." }
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $zipPath) { throw "Stale versioned ZIP survived cleanup." }
}
if (Test-Path -LiteralPath $zipStablePath) {
    Remove-Item -LiteralPath $zipStablePath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $zipStablePath) { throw "Stale stable ZIP survived cleanup." }
}
if (Test-Path -LiteralPath $installerVersionedPath) {
    Remove-Item -LiteralPath $installerVersionedPath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $installerVersionedPath) { throw "Stale versioned installer survived cleanup." }
}
if (Test-Path -LiteralPath $installerStablePath) {
    Remove-Item -LiteralPath $installerStablePath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $installerStablePath) { throw "Stale stable installer survived cleanup." }
}
if (Test-Path -LiteralPath $portableVersionedPath) {
    Remove-Item -LiteralPath $portableVersionedPath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $portableVersionedPath) { throw "Stale versioned portable survived cleanup." }
}
if (Test-Path -LiteralPath $portableStablePath) {
    Remove-Item -LiteralPath $portableStablePath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $portableStablePath) { throw "Stale stable portable survived cleanup." }
}
if (Test-Path -LiteralPath $ffmpegSourceInfoVersionedPath) {
    Remove-Item -LiteralPath $ffmpegSourceInfoVersionedPath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $ffmpegSourceInfoVersionedPath) { throw "Stale versioned FFmpeg info survived cleanup." }
}
if (Test-Path -LiteralPath $ffmpegSourceInfoStablePath) {
    Remove-Item -LiteralPath $ffmpegSourceInfoStablePath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $ffmpegSourceInfoStablePath) { throw "Stale stable FFmpeg info survived cleanup." }
}
if (Test-Path -LiteralPath $sourceInfoDir) {
    Remove-Item -LiteralPath $sourceInfoDir -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $sourceInfoDir) { throw "Stale FFmpeg info directory survived cleanup." }
}
if (Test-Path -LiteralPath $portableArchive) {
    Remove-Item -LiteralPath $portableArchive -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $portableArchive) { throw "Stale portable archive survived cleanup." }
}

Write-Step "Stage Artifacts"
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
$stagedExecutablePath = Join-Path $stageDir "game-capture.exe"
Copy-Item -Path $exePath -Destination $stagedExecutablePath -Force
$stagedCopySha256 = (Get-FileHash -LiteralPath $stagedExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($stagedCopySha256 -ne $sourceExecutableSha256) {
    throw "Staged game-capture.exe does not match the selected build executable before signing."
}
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
$ffmpegStageDir = Join-Path $stageDir "ffmpeg"
if ($ffmpegManifest) {
    if (Test-Path $ffmpegStageDir) {
        Remove-Item -Recurse -Force $ffmpegStageDir
    }
    New-Item -ItemType Directory -Path $ffmpegStageDir -Force | Out-Null
    Copy-Item -Path (Join-Path $FfmpegBundleRoot "*") -Destination $ffmpegStageDir -Recurse -Force
    Write-Host "Staged FFmpeg: $ffmpegStageDir"
    Write-Host "FFmpeg: $($ffmpegManifest.ffmpeg_version)"
} else {
    Write-Warning "FFmpeg bundle missing; continuing because -AllowMissingFfmpeg was set."
}

$notes = @()
$notes += "Game Capture Native Qt Release"
$notes += "Version: $Version"
$notes += "BuildDir: $BuildDir"
$notes += "Configuration: $Configuration"
$notes += "Built: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")"
$notes += ""
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
    Compress-Archive -Path (Join-Path $sourceInfoDir "*") -DestinationPath $ffmpegSourceInfoVersionedPath -Force
    Copy-Item -Path $ffmpegSourceInfoVersionedPath -Destination $ffmpegSourceInfoStablePath -Force
    Remove-Item -Recurse -Force $sourceInfoDir
}

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$qtConfiguration = @'
[Paths]
Prefix=.
Plugins=.
'@
[System.IO.File]::WriteAllText(
    (Join-Path $stageDir 'qt.conf'),
    $qtConfiguration.Replace("`r`n", "`n") + "`n",
    $utf8WithoutBom)

Write-Step "Code Signing (Best Effort - Staged Binary)"
$signScript = Join-Path $PSScriptRoot "sign-artifacts.ps1"
if (Test-Path $signScript) {
    try {
        & $signScript -FilePaths @($stagedExecutablePath)
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

Write-Step "Release Artifact Manifest"
if (-not (Test-Path -LiteralPath $stagedExecutablePath -PathType Leaf)) {
    throw "Final staged game-capture.exe is missing after signing: $stagedExecutablePath"
}
$payloadInventory = Get-ReleasePayloadInventory -StageRoot $stageDir -ExcludedRelativePath `
    'release-artifact-manifest.json'
$stagedExecutableInfo = Get-Item -LiteralPath $stagedExecutablePath -ErrorAction Stop
$stagedExecutableSha256 = (Get-FileHash -LiteralPath $stagedExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
$payloadExecutableEntries = @($payloadInventory.files | Where-Object {
    $_.relativePath -ceq 'game-capture.exe'
})
if ($payloadExecutableEntries.Count -ne 1 -or
    [int64]$payloadExecutableEntries[0].size -ne [int64]$stagedExecutableInfo.Length -or
    [string]$payloadExecutableEntries[0].sha256 -cne $stagedExecutableSha256) {
    throw 'Complete release payload inventory does not bind the final staged executable identity.'
}
$sourceProvenance = Get-ReleaseSourceProvenance -SourceRoot $repoRoot
if ($sourceProvenance.snapshotSha256 -cne $ExpectedSourceSnapshotSha256 -or
    [int64]$sourceProvenance.snapshotFileCount -ne $ExpectedSourceSnapshotFileCount -or
    $sourceProvenance.snapshotAlgorithm -cne $ExpectedSourceSnapshotAlgorithm) {
    throw "Release source snapshot changed between orchestration and packaging. " +
        "Expected sha256=$ExpectedSourceSnapshotSha256 fileCount=$ExpectedSourceSnapshotFileCount algorithm='$ExpectedSourceSnapshotAlgorithm'; " +
        "actual sha256=$($sourceProvenance.snapshotSha256) fileCount=$($sourceProvenance.snapshotFileCount) algorithm='$($sourceProvenance.snapshotAlgorithm)'."
}
if ($sourceProvenance.gitCommit -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') {
    throw "Release source provenance requires a lowercase Git commit object id."
}
if ($sourceProvenance.dirty -isnot [bool]) {
    throw "Release source provenance requires a definitive Git dirty state."
}
if ($sourceProvenance.snapshotSha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Release source provenance requires a complete source snapshot SHA-256."
}
if ($null -eq $sourceProvenance.snapshotFileCount -or
    [int64]$sourceProvenance.snapshotFileCount -lt 1) {
    throw "Release source provenance requires a positive source snapshot file count."
}
if ([string]::IsNullOrWhiteSpace([string]$sourceProvenance.snapshotAlgorithm)) {
    throw "Release source provenance requires a named source snapshot algorithm."
}
$releaseManifest = [ordered]@{
    schema = 'game-capture-release-artifact/v1'
    version = $Version
    packagedAtUtc = [System.DateTime]::UtcNow.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
    artifact = [ordered]@{
        relativePath = 'game-capture.exe'
        size = [int64]$stagedExecutableInfo.Length
        sha256 = $stagedExecutableSha256
    }
    payload = [ordered]@{
        algorithm = $payloadInventory.algorithm
        fileCount = $payloadInventory.fileCount
        aggregateSha256 = $payloadInventory.aggregateSha256
        files = @($payloadInventory.files)
    }
    build = [ordered]@{
        configuration = $Configuration
        directory = ([string]$BuildDir).Replace('\', '/')
        sourceExecutable = [ordered]@{
            relativePath = $sourceExecutableRelativePath
            size = [int64]$sourceExecutableInfo.Length
            sha256 = $sourceExecutableSha256
        }
    }
    source = [ordered]@{
        gitCommit = $sourceProvenance.gitCommit
        dirty = $sourceProvenance.dirty
        statusEntryCount = $sourceProvenance.statusEntryCount
        snapshotSha256 = $sourceProvenance.snapshotSha256
        snapshotFileCount = $sourceProvenance.snapshotFileCount
        snapshotAlgorithm = $sourceProvenance.snapshotAlgorithm
        snapshotScope = $sourceProvenance.snapshotScope
    }
}
$releaseManifestJson = $releaseManifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($releaseManifestPath, $releaseManifestJson + "`n", $utf8WithoutBom)
$releaseManifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Release artifact manifest: $releaseManifestPath"
Write-Host "Release artifact manifest SHA-256: $releaseManifestSha256"

Write-Step "Zip Package"
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force
Copy-Item -Path $zipPath -Destination $zipStablePath -Force

Write-Step "Portable EXE"
if ((Test-Path $sevenZipExe) -and (Test-Path $sevenZipSfx) -and (Test-Path $portableConfig)) {
    & $sevenZipExe a -t7z -mx=9 $portableArchive (Join-Path $stageDir "*")
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create portable archive via 7-Zip."
    }
    cmd /c "copy /b `"$sevenZipSfx`" + `"$portableConfig`" + `"$portableArchive`" `"$portableVersionedPath`" >nul"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create portable executable SFX."
    }
    Remove-Item -Force $portableArchive
} else {
    Write-Host "7-Zip or portable config missing; skipped portable SFX creation."
}

Write-Step "Optional NSIS Installer"
if ($makensis) {
    $buildBinDir = $stageDir
    & $makensis.Source /V2 "/DVERSION=$Version" "/DBUILD_BIN_DIR=$buildBinDir" "/DOUTFILE=$installerVersionedPath" installer.nsi
    if ($LASTEXITCODE -ne 0) {
        throw "NSIS installer build failed."
    }
} else {
    Write-Host "makensis not found; skipped installer build."
}

Write-Step "Code Signing (Best Effort - Release EXEs)"
$releaseExePaths = @($portableVersionedPath, $installerVersionedPath)
if (Test-Path $signScript) {
    try {
        & $signScript -FilePaths $releaseExePaths
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

if (Test-Path -LiteralPath $portableVersionedPath -PathType Leaf) {
    Copy-Item -Path $portableVersionedPath -Destination $portableStablePath -Force
}
if (Test-Path -LiteralPath $installerVersionedPath -PathType Leaf) {
    Copy-Item -Path $installerVersionedPath -Destination $installerStablePath -Force
}

if ($RequireReleaseArtifacts) {
    $requiredReleaseArtifacts = @(
        (Join-Path $stageDir "game-capture.exe"),
        $releaseManifestPath,
        $zipPath,
        $zipStablePath,
        $portableVersionedPath,
        $portableStablePath,
        $installerVersionedPath,
        $installerStablePath
    )
    if ($ffmpegManifest) {
        $requiredReleaseArtifacts += @(
            $ffmpegSourceInfoVersionedPath,
            $ffmpegSourceInfoStablePath
        )
    }
    foreach ($requiredReleaseArtifact in $requiredReleaseArtifacts) {
        if (-not (Test-Path -LiteralPath $requiredReleaseArtifact -PathType Leaf)) {
            throw "Required release artifact was not generated by this invocation: $requiredReleaseArtifact"
        }
    }
}

$buildAliasIdentityArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'),
    '-DistDir', $distRoot,
    '-Version', $Version
)
if ($AllowMissingFfmpeg) { $buildAliasIdentityArgs += '-AllowMissingFfmpeg' }
& powershell.exe @buildAliasIdentityArgs
$buildAliasIdentityExit = $LASTEXITCODE
if ($buildAliasIdentityExit -ne 0) { throw 'Built release artifact alias identity validation failed.' }

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
Write-Host "Release artifact manifest: $releaseManifestPath"
Write-Host "Release artifact manifest SHA-256: $releaseManifestSha256"
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

