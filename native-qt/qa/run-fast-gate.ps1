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
$publisherExe = Resolve-PublisherExecutable -RepoRoot $repoRoot -BuildDir $BuildDir -Configuration $Configuration -ExplicitPath $PublisherPath
if (-not $publisherExe) {
    throw "Could not locate game-capture.exe for BuildDir '$BuildDir' and Configuration '$Configuration'. Build first or pass -PublisherPath."
}

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
} finally {
    Stop-E2eCaptureSource $captureSourceProcess
    [Environment]::SetEnvironmentVariable("GAME_CAPTURE_WINDOW_FILTER", $previousCaptureWindowFilter, "Process")
}
