param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$Version = "0.2.55",
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FirefoxPath,
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
    [int]$ViewerChurnJoinGapMs = 250,
    [string]$RoomAlphaPluginRepo = "",
    [switch]$SkipRoomAlpha = $true
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'release-source-snapshot.ps1')

function Quote-ProcessArgument([string]$Value) {
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Start-E2eCaptureSource([string]$Title) {
    $sourceScript = Join-Path $PSScriptRoot "e2e-capture-source.ps1"
    if (-not (Test-Path $sourceScript)) {
        throw "Capture source script not found: $sourceScript"
    }

    $argText = "-NoProfile -ExecutionPolicy Bypass -STA -File $(Quote-ProcessArgument $sourceScript) -Title $(Quote-ProcessArgument $Title)"
    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $argText -PassThru -WindowStyle Normal
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $current = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if (-not $current) {
            throw "E2E capture source exited before its window became available."
        }
        if ($current.MainWindowTitle -like "*$Title*") {
            return $proc
        }
    }

    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw "Timed out waiting for E2E capture source window: $Title"
}

function Stop-E2eCaptureSource($Process) {
    if ($Process) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $repoRoot
if ($null -eq $sourceSnapshot) {
    throw "Could not establish the source snapshot for the packaged fast gate."
}
$buildScript = Join-Path $PSScriptRoot "build-release.ps1"
$buildParams = @{
    BuildDir = $BuildDir
    Configuration = $Configuration
    Version = $Version
    ExpectedSourceSnapshotSha256 = $sourceSnapshot.sha256
    ExpectedSourceSnapshotFileCount = $sourceSnapshot.fileCount
    ExpectedSourceSnapshotAlgorithm = $sourceSnapshot.algorithm
    SkipVirusTotal = $true
    RequireReleaseArtifacts = $true
}
& $buildScript @buildParams
$packagedPublisher = Join-Path $repoRoot "dist/game-capture-$Version-win64/game-capture.exe"
$artifactManifestPath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($packagedPublisher)), 'release-artifact-manifest.json')
if (-not (Test-Path -LiteralPath $packagedPublisher -PathType Leaf) -or
    -not (Test-Path -LiteralPath $artifactManifestPath -PathType Leaf)) {
    throw "Fast-gate release package or co-located manifest is missing."
}
$artifactManifestSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $artifactManifestPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()

$previousCaptureWindowFilter = [Environment]::GetEnvironmentVariable("GAME_CAPTURE_WINDOW_FILTER", "Process")
$captureWindowFilter = "Game Capture Fast Gate Source $(Get-Date -Format "yyyyMMdd-HHmmss")"
$captureSourceProcess = $null

try {
    Write-Host "Starting E2E capture source: $captureWindowFilter"
    $captureSourceProcess = Start-E2eCaptureSource -Title $captureWindowFilter
    [Environment]::SetEnvironmentVariable("GAME_CAPTURE_WINDOW_FILTER", $captureWindowFilter, "Process")

    $scriptPath = Join-Path $PSScriptRoot "run-release-readiness.ps1"
    $params = @{
        BuildDir = $BuildDir
        Configuration = $Configuration
        PublisherPath = $packagedPublisher
        ArtifactManifestPath = $artifactManifestPath
        ArtifactManifestSha256 = $artifactManifestSha256
        FirefoxPath = $FirefoxPath
        SkipSoak = $true
        CheckHardwareEncoders = $false
        BitrateRetries = $BitrateRetries
        RefreshPassword = $RefreshPassword
        RefreshVideoEncoder = $RefreshVideoEncoder
        ControlPassword = $ControlPassword
        ControlToken = $ControlToken
        SkipDualStream = $SkipDualStream
        RoomAlphaPluginRepo = $RoomAlphaPluginRepo
        SkipRoomAlpha = $SkipRoomAlpha
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
    $viewerChurnCmd = "npm --prefix `"$repoRoot`" run e2e:viewer-churn -- --publisher-path=`"$packagedPublisher`" --password=$RefreshPassword --viewers=$ViewerChurnViewers --cycles=$ViewerChurnCycles --timeout-ms=$ViewerChurnTimeoutMs --hold-ms=$ViewerChurnHoldMs --join-gap-ms=$ViewerChurnJoinGapMs"
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
} finally {
    Stop-E2eCaptureSource $captureSourceProcess
    [Environment]::SetEnvironmentVariable("GAME_CAPTURE_WINDOW_FILTER", $previousCaptureWindowFilter, "Process")
}
