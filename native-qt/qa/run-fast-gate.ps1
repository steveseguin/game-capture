param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$PublisherPath = "",
    [string]$RefreshPassword = "",
    [string]$RefreshVideoEncoder = "nvenc",
    [string]$ControlPassword = "",
    [string]$ControlToken = "release-control-token",
    [string]$FfmpegPath = "",
    [switch]$SkipDualStream = $false,
    [int]$BitrateRetries = 0,
    [int]$ViewerChurnViewers = 4,
    [int]$ViewerChurnCycles = 4,
    [int]$ViewerChurnTimeoutMs = 45000,
    [int]$ViewerChurnHoldMs = 3000,
    [int]$ViewerChurnJoinGapMs = 250
)

$ErrorActionPreference = "Stop"

function Resolve-PublisherExecutable([string]$RepoRoot, [string]$BuildDir, [string]$Configuration, [string]$ExplicitPath) {
    if ($ExplicitPath) {
        if (Test-Path $ExplicitPath) {
            return (Resolve-Path $ExplicitPath).Path
        }
        throw "Publisher executable not found at explicit path: $ExplicitPath"
    }

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

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$publisherExe = Resolve-PublisherExecutable -RepoRoot $repoRoot -BuildDir $BuildDir -Configuration $Configuration -ExplicitPath $PublisherPath
if (-not $publisherExe) {
    throw "Could not locate versus-qt.exe for BuildDir '$BuildDir' and Configuration '$Configuration'. Build first or pass -PublisherPath."
}

$scriptPath = Join-Path $PSScriptRoot "run-release-readiness.ps1"
$params = @{
    BuildDir = $BuildDir
    Configuration = $Configuration
    PublisherPath = $publisherExe
    SkipSoak = $true
    CheckHardwareEncoders = $false
    BitrateRetries = $BitrateRetries
    RefreshPassword = $RefreshPassword
    RefreshVideoEncoder = $RefreshVideoEncoder
    ControlPassword = $ControlPassword
    ControlToken = $ControlToken
    SkipDualStream = $SkipDualStream
}
if ($FfmpegPath) {
    $params.FfmpegPath = $FfmpegPath
}

& $scriptPath @params
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "=== E2E Viewer Churn ==="
$viewerChurnCmd = "npm --prefix `"$repoRoot`" run e2e:viewer-churn -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --viewers=$ViewerChurnViewers --cycles=$ViewerChurnCycles --timeout-ms=$ViewerChurnTimeoutMs --hold-ms=$ViewerChurnHoldMs --join-gap-ms=$ViewerChurnJoinGapMs"
if ($RefreshVideoEncoder) {
    $viewerChurnCmd += " --video-encoder=$RefreshVideoEncoder"
}
if ($FfmpegPath) {
    $viewerChurnCmd += " --ffmpeg-path=`"$FfmpegPath`""
}
cmd /c $viewerChurnCmd
if ($LASTEXITCODE -ne 0) {
    throw "Viewer churn E2E failed with exit code $LASTEXITCODE"
}
