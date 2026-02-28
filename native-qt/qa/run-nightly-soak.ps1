param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$PublisherPath = "",
    [int]$SoakDurationMin = 30,
    [int]$SoakHoldMs = 15000,
    [string]$SoakPassword = "",
    [string]$SoakVideoEncoder = "",
    [string]$RefreshPassword = "",
    [string]$RefreshVideoEncoder = "nvenc",
    [string]$ControlPassword = "",
    [string]$ControlToken = "release-control-token",
    [string]$FfmpegPath = "",
    [switch]$EnforceHardwareEncoders = $false,
    [int]$BitrateRetries = 1,
    [int]$HardwareRetries = 1
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "run-release-readiness.ps1"
$params = @{
    BuildDir = $BuildDir
    Configuration = $Configuration
    SoakDurationMin = $SoakDurationMin
    SoakHoldMs = $SoakHoldMs
    SoakPassword = $SoakPassword
    SoakVideoEncoder = $SoakVideoEncoder
    RefreshPassword = $RefreshPassword
    RefreshVideoEncoder = $RefreshVideoEncoder
    ControlPassword = $ControlPassword
    ControlToken = $ControlToken
    CheckHardwareEncoders = $true
    EnforceHardwareEncoders = $EnforceHardwareEncoders
    BitrateRetries = $BitrateRetries
    HardwareRetries = $HardwareRetries
}

if ($PublisherPath) {
    $params.PublisherPath = $PublisherPath
}
if ($FfmpegPath) {
    $params.FfmpegPath = $FfmpegPath
}

& $scriptPath @params
