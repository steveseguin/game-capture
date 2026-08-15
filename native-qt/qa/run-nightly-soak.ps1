param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$Version = "0.2.50",
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FirefoxPath,
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
    [int]$HardwareRetries = 1,
    [string]$RoomAlphaPluginRepo = "",
    [switch]$SkipRoomAlpha = $true
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'release-source-snapshot.ps1')

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $repoRoot
if ($null -eq $sourceSnapshot) {
    throw "Could not establish the source snapshot for the packaged nightly gate."
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
    throw "Nightly release package or co-located manifest is missing."
}
$artifactManifestSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $artifactManifestPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()

$scriptPath = Join-Path $PSScriptRoot "run-release-readiness.ps1"
$params = @{
    BuildDir = $BuildDir
    Configuration = $Configuration
    PublisherPath = $packagedPublisher
    ArtifactManifestPath = $artifactManifestPath
    ArtifactManifestSha256 = $artifactManifestSha256
    FirefoxPath = $FirefoxPath
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
    RoomAlphaPluginRepo = $RoomAlphaPluginRepo
    SkipRoomAlpha = $SkipRoomAlpha
}

if ($FfmpegPath) {
    $params.FfmpegPath = $FfmpegPath
}

& $scriptPath @params
