param(
    [string]$ReleaseTag = "autobuild-2026-07-07-13-44",
    [string]$AssetName = "ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip",
    [string]$ExpectedSha256 = "86db305478bd15928c3f71ebab7cee11a2affc73d580cd35e4c9c635cbaedaf9",
    [string]$OutputRoot = "",
    [string]$CacheDir = "",
    [switch]$Force = $false
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Name) {
    Write-Host ""
    Write-Host "=== $Name ==="
}

function Resolve-FullPath([string]$Path) {
    $executionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Test-CommandOutputContains([string]$Text, [string]$Needle) {
    return $Text.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Save-Url([string]$Uri, [string]$OutFile) {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -L --fail --silent --show-error -o $OutFile $Uri
        if ($LASTEXITCODE -ne 0) {
            throw "curl failed while downloading $Uri"
        }
        return
    }
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile
}

$repoRoot = Resolve-FullPath (Join-Path $PSScriptRoot "..\..")
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot "native-qt\third_party\ffmpeg-win64"
}
if ([string]::IsNullOrWhiteSpace($CacheDir)) {
    $CacheDir = Join-Path $repoRoot "native-qt\third_party\cache"
}

$OutputRoot = Resolve-FullPath $OutputRoot
$CacheDir = Resolve-FullPath $CacheDir
$archivePath = Join-Path $CacheDir $AssetName
$extractRoot = Join-Path $CacheDir "extract-$ReleaseTag"
$downloadUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ReleaseTag/$AssetName"
$checksumsUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ReleaseTag/checksums.sha256"

if ((Test-Path $OutputRoot) -and -not $Force) {
    $existingFfmpeg = Join-Path $OutputRoot "bin\ffmpeg.exe"
    $existingManifest = Join-Path $OutputRoot "bundle-manifest.json"
    if ((Test-Path $existingFfmpeg) -and (Test-Path $existingManifest)) {
        Write-Host "FFmpeg bundle already staged: $OutputRoot"
        Write-Host "Use -Force to refresh it."
        exit 0
    }
}

New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null

Write-Step "Download FFmpeg LGPL Shared Bundle"
if (-not (Test-Path $archivePath) -or $Force) {
    Save-Url -Uri $downloadUrl -OutFile $archivePath
}

Write-Step "Verify Archive Checksum"
$actualSha = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
if ($actualSha -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "FFmpeg archive checksum mismatch. Expected $ExpectedSha256, got $actualSha"
}
Write-Host "Checksum OK: $actualSha"

Write-Step "Verify Upstream Checksum Listing"
$checksumsPath = Join-Path $CacheDir "checksums-$ReleaseTag.sha256"
Save-Url -Uri $checksumsUrl -OutFile $checksumsPath
$checksumListing = Get-Content -Path $checksumsPath -Raw
if (-not (Test-CommandOutputContains -Text $checksumListing -Needle $ExpectedSha256) -or
    -not (Test-CommandOutputContains -Text $checksumListing -Needle $AssetName)) {
    throw "Upstream checksums.sha256 does not contain the expected asset/hash pair."
}

Write-Step "Extract Bundle"
if (Test-Path $extractRoot) {
    Remove-Item -Recurse -Force $extractRoot
}
New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force
$expandedRoot = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
if (-not $expandedRoot) {
    throw "Could not find extracted FFmpeg root inside $extractRoot"
}

$ffmpegExe = Join-Path $expandedRoot.FullName "bin\ffmpeg.exe"
if (-not (Test-Path $ffmpegExe)) {
    throw "Extracted bundle does not contain bin\ffmpeg.exe"
}

Write-Step "Probe Bundle"
$versionOutput = (& $ffmpegExe -hide_banner -version 2>&1) -join "`n"
$encoderOutput = (& $ffmpegExe -hide_banner -encoders 2>&1) -join "`n"
$configurationLine = (($versionOutput -split "`n") | Where-Object { $_ -like "configuration:*" } | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($configurationLine)) {
    throw "Could not find FFmpeg configuration line."
}
if (Test-CommandOutputContains -Text $configurationLine -Needle "--enable-gpl") {
    throw "FFmpeg bundle is GPL-enabled; refusing to stage it."
}
if (Test-CommandOutputContains -Text $configurationLine -Needle "--enable-nonfree") {
    throw "FFmpeg bundle is nonfree-enabled; refusing to stage it."
}
if (-not (Test-CommandOutputContains -Text $encoderOutput -Needle "libvpx-vp9")) {
    throw "FFmpeg bundle does not expose libvpx-vp9 encoder."
}

Write-Step "Stage Bundle"
if (Test-Path $OutputRoot) {
    Remove-Item -Recurse -Force $OutputRoot
}
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
Copy-Item -Path (Join-Path $expandedRoot.FullName "*") -Destination $OutputRoot -Recurse -Force

foreach ($unusedDir in @("include", "lib")) {
    $path = Join-Path $OutputRoot $unusedDir
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path
    }
}
foreach ($unusedTool in @("ffplay.exe", "ffprobe.exe")) {
    $path = Join-Path $OutputRoot "bin\$unusedTool"
    if (Test-Path $path) {
        Remove-Item -Force $path
    }
}

$licensesDir = Join-Path $OutputRoot "licenses"
New-Item -ItemType Directory -Path $licensesDir -Force | Out-Null
foreach ($name in @("LICENSE.txt", "README.txt", "VERSION.txt")) {
    $candidate = Join-Path $OutputRoot $name
    if (Test-Path $candidate) {
        Copy-Item -Path $candidate -Destination (Join-Path $licensesDir $name) -Force
    }
}

$firstVersionLine = ($versionOutput -split "`n" | Select-Object -First 1).Trim()
$commitMatch = [regex]::Match(
    $firstVersionLine,
    '(?i)(?:^|[-\s])g(?<commit>[0-9a-f]{7,40})(?=[-\s]|$)')
if (-not $commitMatch.Success) {
    throw "Could not derive the FFmpeg source commit from the staged binary version: $firstVersionLine"
}
$ffmpegSourceCommit = $commitMatch.Groups['commit'].Value.ToLowerInvariant()
$sourceArchiveUrl = "https://github.com/FFmpeg/FFmpeg/archive/$ffmpegSourceCommit.zip"
$btbnBuildUrl = "https://github.com/BtbN/FFmpeg-Builds/tree/$ReleaseTag"

$manifest = [ordered]@{
    name = "FFmpeg LGPL shared bundle"
    provider = "BtbN/FFmpeg-Builds"
    release_tag = $ReleaseTag
    asset_name = $AssetName
    asset_url = $downloadUrl
    asset_sha256 = $actualSha
    ffmpeg_source_commit = $ffmpegSourceCommit
    ffmpeg_source_archive_url = $sourceArchiveUrl
    build_scripts_url = $btbnBuildUrl
    staged_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    ffmpeg_version = $firstVersionLine
    configuration = $configurationLine
    has_libvpx_vp9 = $true
    gpl_enabled = $false
    nonfree_enabled = $false
    notes = "Bundled for Game Capture VP9 alpha. Game Capture invokes ffmpeg.exe as a child process."
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
Set-Content -Path (Join-Path $OutputRoot "bundle-manifest.json") -Value $manifestJson -Encoding UTF8

$sources = @()
$sources += "FFmpeg Bundle Source Information"
$sources += ""
$sources += "Provider: BtbN/FFmpeg-Builds"
$sources += "Release tag: $ReleaseTag"
$sources += "Binary asset: $AssetName"
$sources += "Binary URL: $downloadUrl"
$sources += "Binary SHA256: $actualSha"
$sources += ""
$sources += "FFmpeg source commit: $ffmpegSourceCommit"
$sources += "FFmpeg source archive: $sourceArchiveUrl"
$sources += "BtbN build scripts: $btbnBuildUrl"
$sources += ""
$sources += "This file records source locations for the staged FFmpeg bundle. For release compliance, publish a matching source/build-info archive beside release binaries."
Set-Content -Path (Join-Path $OutputRoot "SOURCES.txt") -Value $sources -Encoding UTF8

$buildInfo = @()
$buildInfo += "FFmpeg Bundle Build Info"
$buildInfo += ""
$buildInfo += "Downloaded: $downloadUrl"
$buildInfo += "SHA256: $actualSha"
$buildInfo += ""
$buildInfo += "Version output:"
$buildInfo += $versionOutput
$buildInfo += ""
$buildInfo += "Encoder probe contains libvpx-vp9: yes"
Set-Content -Path (Join-Path $OutputRoot "BUILDINFO.txt") -Value $buildInfo -Encoding UTF8

$hashLines = @()
$hashLines += "$actualSha  $AssetName"
Get-ChildItem -Path $OutputRoot -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
        $relative = $_.FullName.Substring($OutputRoot.Length).TrimStart('\', '/')
        $hash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
        $hashLines += "$hash  $relative"
    }
Set-Content -Path (Join-Path $OutputRoot "SHA256SUMS.txt") -Value $hashLines -Encoding UTF8

Write-Step "Done"
Write-Host "Staged FFmpeg bundle: $OutputRoot"
Write-Host $firstVersionLine
