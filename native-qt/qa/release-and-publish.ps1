param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FirefoxPath,
    [string]$Repo = "steveseguin/game-capture",
    [string]$FfmpegBundleRoot = "",
    [switch]$SkipVirusTotal = $false,
    [Parameter(Mandatory = $true)]
    [string]$RoomAlphaPluginRepo,
    [Parameter(Mandatory = $true)]
    [string]$RoomAlphaSpoutSenderPath
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'release-source-snapshot.ps1')

function Write-Step([string]$Name) {
    Write-Host ""
    Write-Host "=== $Name ==="
}

function Clear-ProxyEnv {
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) {
        Remove-Item -Path ("Env:{0}" -f $name) -ErrorAction SilentlyContinue
    }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $repoRoot

Clear-ProxyEnv

if ([string]::IsNullOrWhiteSpace($RoomAlphaPluginRepo)) {
    throw "RoomAlphaPluginRepo is required."
}
if ([string]::IsNullOrWhiteSpace($RoomAlphaSpoutSenderPath)) {
    throw "RoomAlphaSpoutSenderPath is required."
}
$RoomAlphaPluginRepo = [System.IO.Path]::GetFullPath($RoomAlphaPluginRepo)
$RoomAlphaSpoutSenderPath = [System.IO.Path]::GetFullPath($RoomAlphaSpoutSenderPath)
if (-not (Test-Path -LiteralPath $RoomAlphaPluginRepo -PathType Container)) {
    throw "ninja-plugin repository was not found: $RoomAlphaPluginRepo"
}
if (-not (Test-Path -LiteralPath $RoomAlphaSpoutSenderPath -PathType Leaf)) {
    throw "Spout sender fixture was not found: $RoomAlphaSpoutSenderPath"
}

$nativeQtRoot = Join-Path $repoRoot "native-qt"
Set-Location $nativeQtRoot
$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot
if ($null -eq $preBuildSourceSnapshot -or
    $preBuildSourceSnapshot.sha256 -notmatch '^[0-9a-f]{64}$' -or
    [int64]$preBuildSourceSnapshot.fileCount -lt 1 -or
    [string]::IsNullOrWhiteSpace([string]$preBuildSourceSnapshot.algorithm)) {
    throw "Could not establish a complete source snapshot before the release build."
}

Write-Step "Fresh Release Build"
& cmake --build $BuildDir --config $Configuration
$compileExit = $LASTEXITCODE
if ($compileExit -ne 0) {
    throw "Fresh release build failed with exit code $compileExit."
}
$prePackageSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot
if ($prePackageSourceSnapshot.sha256 -cne $preBuildSourceSnapshot.sha256 -or
    $prePackageSourceSnapshot.fileCount -ne $preBuildSourceSnapshot.fileCount -or
    $prePackageSourceSnapshot.algorithm -cne $preBuildSourceSnapshot.algorithm) {
    throw "Release source snapshot changed during the build."
}

Write-Step "Build Release Artifacts"
$buildArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "build-release.ps1"),
    "-BuildDir", $BuildDir,
    "-Configuration", $Configuration,
    "-Version", $Version,
    "-ExpectedSourceSnapshotSha256", $preBuildSourceSnapshot.sha256,
    "-ExpectedSourceSnapshotFileCount", $preBuildSourceSnapshot.fileCount,
    "-ExpectedSourceSnapshotAlgorithm", $preBuildSourceSnapshot.algorithm,
    "-SkipVirusTotal",
    "-RequireReleaseArtifacts"
    if ($FfmpegBundleRoot) {
        "-FfmpegBundleRoot"
        $FfmpegBundleRoot
    }
)
& powershell.exe @buildArgs
$packageExit = $LASTEXITCODE
if ($packageExit -ne 0) {
    throw "build-release.ps1 failed with exit code $packageExit."
}

$distRoot = Join-Path $repoRoot "native-qt\dist"
$packagedPublisher = Join-Path $distRoot "game-capture-$Version-win64/game-capture.exe"
$artifactManifestPath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($packagedPublisher)), 'release-artifact-manifest.json')
if (-not (Test-Path -LiteralPath $artifactManifestPath -PathType Leaf)) {
    throw "Packaged release artifact manifest is missing: $artifactManifestPath"
}
$artifactManifestSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $artifactManifestPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
if ($artifactManifestSha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Packaged release artifact manifest SHA-256 is invalid."
}
$versionedSetup = Join-Path $distRoot "game-capture-$Version-setup.exe"
$versionedPortable = Join-Path $distRoot "game-capture-$Version-portable.exe"
$versionedZip = Join-Path $distRoot "game-capture-$Version-win64.zip"
$versionedFfmpegSourceInfo = Join-Path $distRoot "game-capture-$Version-ffmpeg-source-info.zip"
$stableSetup = Join-Path $distRoot "game-capture-setup.exe"
$stablePortable = Join-Path $distRoot "game-capture-portable.exe"
$stableZip = Join-Path $distRoot "game-capture-win64.zip"
$stableFfmpegSourceInfo = Join-Path $distRoot "game-capture-ffmpeg-source-info.zip"

$required = @(
    $versionedSetup,
    $versionedPortable,
    $versionedZip,
    $versionedFfmpegSourceInfo,
    $stableSetup,
    $stablePortable,
    $stableZip,
    $stableFfmpegSourceInfo
)
foreach ($path in $required) {
    if (-not (Test-Path $path)) {
        throw "Missing release artifact: $path"
    }
}

foreach ($path in @(
    $packagedPublisher,
    (Join-Path (Split-Path -Parent $packagedPublisher) "platforms\qwindows.dll")
)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Packaged publisher is incomplete: $path"
    }
}

Write-Step "Validate Exact Packaged Artifacts"
$readinessArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "run-release-readiness.ps1"),
    "-BuildDir", $BuildDir,
    "-Configuration", $Configuration,
    "-PublisherPath", $packagedPublisher,
    "-ArtifactManifestPath", $artifactManifestPath,
    "-ArtifactManifestSha256", $artifactManifestSha256,
    "-FirefoxPath", $FirefoxPath,
    "-RoomAlphaPublisherPath", $packagedPublisher,
    "-RoomAlphaPluginRepo", $RoomAlphaPluginRepo,
    "-RoomAlphaSpoutSenderPath", $RoomAlphaSpoutSenderPath
)
& powershell.exe @readinessArgs
$readinessExit = $LASTEXITCODE
if ($readinessExit -ne 0) {
    throw "Post-package release readiness failed with exit code $readinessExit."
}

$aliasIdentityArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'),
    '-DistDir', $distRoot,
    '-Version', $Version
)
& powershell.exe @aliasIdentityArgs
$aliasIdentityExit = $LASTEXITCODE
if ($aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }

if (-not $SkipVirusTotal) {
    $virusTotalArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $PSScriptRoot "submit-virustotal.ps1"),
        "-DistDir", $distRoot,
        "-Version", $Version
    )
    & powershell.exe @virusTotalArgs
    $virusTotalExit = $LASTEXITCODE
    if ($virusTotalExit -ne 0) {
        Write-Warning "VirusTotal submission failed with exit code $virusTotalExit; the validated release will continue."
    }
}

$tag = "v$Version"
$title = "Game Capture v$Version"
$notesPath = Join-Path $repoRoot ("release-notes-{0}.md" -f $tag)
$notes = @"
## Game Capture $Version

Automated release from native QA flow:
- Fresh failure-blocking release build
- Build/package
- Exact packaged-artifact release readiness
- FFmpeg source/build info archive
- Code signing (best effort)
- VirusTotal submission (best effort)
"@
Set-Content -Path $notesPath -Value $notes -Encoding UTF8

Write-Step "Create/Update GitHub Release"
$releaseExists = $false
try {
    gh release view $tag --repo $Repo --json tagName | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $releaseExists = $true
    }
} catch {
    $releaseExists = $false
}

if ($releaseExists) {
    $uploadAssets = @(
        $versionedSetup,
        $versionedPortable,
        $versionedZip,
        $versionedFfmpegSourceInfo,
        $stableSetup,
        $stablePortable,
        $stableZip,
        $stableFfmpegSourceInfo
    )
    gh release upload $tag @uploadAssets --clobber --repo $Repo
    $uploadExit = $LASTEXITCODE
    if ($uploadExit -ne 0) {
        throw "gh release upload failed with exit code $uploadExit."
    }
    gh release edit $tag --repo $Repo --title $title --notes-file $notesPath --latest
    $editExit = $LASTEXITCODE
    if ($editExit -ne 0) {
        throw "gh release edit failed with exit code $editExit."
    }
} else {
    $uploadAssets = @(
        $versionedSetup,
        $versionedPortable,
        $versionedZip,
        $versionedFfmpegSourceInfo,
        $stableSetup,
        $stablePortable,
        $stableZip,
        $stableFfmpegSourceInfo
    )
    gh release create $tag @uploadAssets --repo $Repo --target main --title $title --notes-file $notesPath --latest
    $createExit = $LASTEXITCODE
    if ($createExit -ne 0) {
        throw "gh release create failed with exit code $createExit."
    }
}

Remove-Item -Path $notesPath -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Release completed: https://github.com/$Repo/releases/tag/$tag"
