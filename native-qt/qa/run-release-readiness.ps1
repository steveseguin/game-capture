param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PublisherPath,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ArtifactManifestPath,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ArtifactManifestSha256,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FirefoxPath,
    [switch]$IncludeSoak = $false,
    [switch]$SkipSoak = $false,
    [int]$SoakDurationMin = 30,
    [int]$SoakHoldMs = 15000,
    [int]$DualSoakHoldMs = 4000,
    [string]$SoakPassword = "",
    [string]$SoakVideoEncoder = "",
    [string]$RefreshPassword = "",
    [string]$RefreshVideoEncoder = "nvenc",
    [string]$ControlPassword = "",
    [string]$ControlToken = "release-control-token",
    [string]$FfmpegPath = "",
    [switch]$SkipDualStream = $false,
    [switch]$CheckHardwareEncoders = $true,
    [switch]$EnforceHardwareEncoders = $false,
    [string]$CaptureWindowFilter = "",
    [switch]$DisableE2eCaptureSource = $false,
    [int]$BitrateRetries = 1,
    [int]$HardwareRetries = 1,
    [string]$RoomAlphaPluginRepo = "",
    [string]$RoomAlphaPublisherPath = "",
    [string]$RoomAlphaSpoutSenderPath = "",
    [switch]$SkipRoomAlpha = $false
)

$ErrorActionPreference = "Stop"

function Write-Section($title) {
    Write-Host ""
    Write-Host "=== $title ==="
}

& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name runStepImplementation -Scope Script -Option Constant -Value {
    param([string]$name, [scriptblock]$action)

    [System.Console]::WriteLine("")
    [System.Console]::WriteLine("=== {0} ===", $name)
    try {
        $global:LASTEXITCODE = 0
        & $action | & (
            $ExecutionContext.SessionState.InvokeCommand.GetCommand(
                'Out-Host',
                [System.Management.Automation.CommandTypes]::Cmdlet
            )
        )
        if ($global:LASTEXITCODE -ne 0) {
            throw "Command exited with code $($global:LASTEXITCODE)"
        }
        return $true
    } catch {
        [System.Console]::Error.WriteLine("FAILED: {0}", $name)
        [System.Console]::Error.WriteLine([string]$_)
        return $false
    }
}

function Run-StepWithRetry($name, [int]$attempts, [scriptblock]$action) {
    $totalAttempts = [Math]::Max(1, $attempts)
    for ($attempt = 1; $attempt -le $totalAttempts; $attempt++) {
        $attemptName = $name
        if ($totalAttempts -gt 1) {
            $attemptName = "$name (attempt $attempt/$totalAttempts)"
        }
        $ok = & $script:runStepImplementation $attemptName $action
        if ($ok) {
            return $true
        }
        if ($attempt -lt $totalAttempts) {
            Write-Host "Retrying $name..."
            Start-Sleep -Seconds 2
        }
    }
    return $false
}

function Resolve-PackagedPublisherExecutable([string]$ExplicitPath) {
    if ([string]::IsNullOrWhiteSpace($ExplicitPath)) {
        throw "Explicit packaged publisher is required; pass -RoomAlphaPublisherPath."
    }
    if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
        throw "Packaged room-alpha publisher was not found: $ExplicitPath"
    }
    $candidate = (Resolve-Path -LiteralPath $ExplicitPath).Path
    $packageRoot = Split-Path -Parent $candidate
    $platformPlugin = Join-Path $packageRoot "platforms\qwindows.dll"
    if (-not (Test-Path -LiteralPath $platformPlugin -PathType Leaf)) {
        throw "Room-alpha publisher is not a complete packaged artifact (missing $platformPlugin)"
    }
    return $candidate
}

function Resolve-RoomAlphaSpoutSender([string]$ExplicitPath) {
    if ([string]::IsNullOrWhiteSpace($ExplicitPath)) {
        throw "Explicit room-alpha Spout fixture is required; pass -RoomAlphaSpoutSenderPath."
    }
    if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
        throw "Room-alpha Spout fixture was not found: $ExplicitPath"
    }
    return (Resolve-Path -LiteralPath $ExplicitPath).Path
}

function Resolve-RoomAlphaPluginRepo([string]$RepoRoot, [string]$ExplicitPath) {
    if ($ExplicitPath) {
        return [System.IO.Path]::GetFullPath($ExplicitPath)
    }
    $environmentPath = [Environment]::GetEnvironmentVariable("NINJA_PLUGIN_REPO", "Process")
    if ($environmentPath) {
        return [System.IO.Path]::GetFullPath($environmentPath)
    }
    $codeRoot = Split-Path -Parent (Split-Path -Parent $RepoRoot)
    return (Join-Path $codeRoot "ninja-plugin")
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

function Test-SameArtifactPath([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }
    $leftFull = [System.IO.Path]::GetFullPath($Left)
    $rightFull = [System.IO.Path]::GetFullPath($Right)
    return [string]::Equals(
        $leftFull,
        $rightFull,
        [System.StringComparison]::OrdinalIgnoreCase)
}

function New-BrowserWorkflowReportDirectory([string]$Name) {
    $directory = Join-Path $script:reportDirBinding (
        "release-$Name-$timestamp-" + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $directory) {
        throw "Fresh browser workflow report directory already exists: $directory"
    }
    return $directory
}

function Assert-FreshBrowserWorkflowReport {
    param(
        [string]$ReportDir,
        [ValidateSet('signaling', 'director')]
        [string]$Kind,
        [string]$Browser,
        [datetime]$StartedAtUtc
    )

    if (-not (Test-Path -LiteralPath $ReportDir -PathType Container)) {
        throw "Browser workflow did not create its report directory: $ReportDir"
    }
    $pattern = if ($Kind -eq 'signaling') {
        'signaling-regressions-*.json'
    } else {
        'director-room-e2e-*.json'
    }
    $reports = @(Get-ChildItem -LiteralPath $ReportDir -File -Filter $pattern)
    if ($reports.Count -ne 1) {
        throw "Expected exactly one fresh $Kind report in $ReportDir; found $($reports.Count)."
    }
    $reportFile = $reports[0]
    if ($reportFile.LastWriteTimeUtc -lt $StartedAtUtc.AddSeconds(-1)) {
        throw "Browser workflow report predates this invocation: $($reportFile.FullName)"
    }
    $report = Get-Content -LiteralPath $reportFile.FullName -Raw | ConvertFrom-Json
    if (-not [bool]$report.ok -or [string]$report.browser -cne $Browser) {
        throw "Browser workflow report is not a passing $Browser result: $($reportFile.FullName)"
    }
    if (-not (Test-SameArtifactPath ([string]$report.packagedArtifactManifest.path) `
            $script:artifactManifestPathBinding) -or
        [string]$report.packagedArtifactManifest.sha256 -cne
            $script:artifactManifestSha256Binding) {
        throw "Browser workflow report does not bind the exact release manifest: $($reportFile.FullName)"
    }

    if ($Kind -eq 'signaling') {
        if (-not (Test-SameArtifactPath ([string]$report.packagedPublisher) `
                $script:publisherExe) -or
            [string]$report.packagedPublisherSha256 -cne $script:publisherSha256Binding -or
            -not (Test-SameArtifactPath ([string]$report.spoutSenderArtifact.path) `
                $script:spoutSenderPathBinding) -or
            [string]$report.spoutSenderArtifact.sha256 -cne
                $script:spoutSenderSha256Binding -or
            @($report.harnessErrors).Count -ne 0 -or
            @($report.checks).Count -eq 0 -or
            @($report.checks | Where-Object { -not [bool]$_.ok }).Count -ne 0) {
            throw "Signaling report failed exact artifact or behavior validation: $($reportFile.FullName)"
        }
    } else {
        if (-not [bool]$report.strictNegotiation -or
            -not [bool]$report.packagedArtifactIdentityRequired -or
            -not (Test-SameArtifactPath ([string]$report.publisherArtifact.path) `
                $script:publisherExe) -or
            [string]$report.publisherArtifact.sha256 -cne $script:publisherSha256Binding -or
            -not (Test-SameArtifactPath ([string]$report.sourceFixtureArtifact.path) `
                $script:spoutSenderPathBinding) -or
            [string]$report.sourceFixtureArtifact.sha256 -cne
                $script:spoutSenderSha256Binding -or
            [string]$report.sourceFixtureArtifact.expectedSha256 -cne
                $script:spoutSenderSha256Binding -or
            @($report.checks).Count -eq 0 -or
            @($report.checks | Where-Object { -not [bool]$_.ok }).Count -ne 0) {
            throw "Control Center report failed exact artifact or behavior validation: $($reportFile.FullName)"
        }
    }

    if ($Browser -eq 'firefox-installed') {
        if (-not (Test-SameArtifactPath ([string]$report.browserArtifact.path) `
                $script:firefoxPathBinding) -or
            [string]$report.browserArtifact.sha256 -cne $script:firefoxSha256Binding) {
            throw "Installed Firefox report does not bind the launched browser identity: $($reportFile.FullName)"
        }
    }
    return $reportFile.FullName
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportDir = Join-Path $PSScriptRoot "reports"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir "release-readiness-$timestamp.md"
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name reportDirBinding -Scope Script -Option Constant -Value $reportDir

& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name repoRoot -Scope Script -Option Constant -Value (
    [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..'))
)
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name npmExecutable -Scope Script -Option Constant -Value (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'npm.cmd',
        [System.Management.Automation.CommandTypes]::Application
    ).Source
)
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name publisherExe -Scope Script -Option Constant -Value $PublisherPath
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name artifactManifestPathBinding -Scope Script -Option Constant -Value $ArtifactManifestPath
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name artifactManifestSha256Binding -Scope Script -Option Constant -Value $ArtifactManifestSha256
if (-not [System.IO.Directory]::Exists($script:repoRoot)) {
    throw "Resolved repository root does not exist: $script:repoRoot"
}
if (-not [System.IO.File]::Exists($script:npmExecutable)) {
    throw "Resolved npm.cmd application does not exist: $script:npmExecutable"
}
if (-not [System.IO.File]::Exists($script:publisherExe)) {
    throw "Packaged publisher executable does not exist: $script:publisherExe"
}
if (-not [System.IO.File]::Exists($script:artifactManifestPathBinding)) {
    throw "Release artifact manifest does not exist: $script:artifactManifestPathBinding"
}
if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $script:artifactManifestPathBinding -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -cne
    $script:artifactManifestSha256Binding) {
    throw "Release artifact manifest SHA-256 does not match the required identity."
}
$buildRoot = if ([System.IO.Path]::IsPathRooted($BuildDir)) {
    [System.IO.Path]::GetFullPath($BuildDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $script:repoRoot $BuildDir))
}
$spoutSenderCandidate = Join-Path $buildRoot "bin\$Configuration\spout_test_sender.exe"
if (-not (Test-Path -LiteralPath $spoutSenderCandidate -PathType Leaf)) {
    throw "Exact BuildDir/Configuration Spout fixture does not exist: $spoutSenderCandidate"
}
$resolvedSpoutSenderPath = (Resolve-Path -LiteralPath $spoutSenderCandidate).Path
$resolvedSpoutSenderSha256 = (
    Microsoft.PowerShell.Utility\Get-FileHash `
        -LiteralPath $resolvedSpoutSenderPath `
        -Algorithm SHA256 `
        -ErrorAction Stop
).Hash.ToLowerInvariant()
if (-not (Test-Path -LiteralPath $FirefoxPath -PathType Leaf)) {
    throw "Explicit installed Firefox executable does not exist: $FirefoxPath"
}
$resolvedFirefoxPath = (Resolve-Path -LiteralPath $FirefoxPath).Path
$resolvedFirefoxSha256 = (
    Microsoft.PowerShell.Utility\Get-FileHash `
        -LiteralPath $resolvedFirefoxPath `
        -Algorithm SHA256 `
        -ErrorAction Stop
).Hash.ToLowerInvariant()
$resolvedPublisherSha256 = (
    Microsoft.PowerShell.Utility\Get-FileHash `
        -LiteralPath $script:publisherExe `
        -Algorithm SHA256 `
        -ErrorAction Stop
).Hash.ToLowerInvariant()
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name spoutSenderPathBinding -Scope Script -Option Constant -Value $resolvedSpoutSenderPath
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name spoutSenderSha256Binding -Scope Script -Option Constant -Value $resolvedSpoutSenderSha256
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name firefoxPathBinding -Scope Script -Option Constant -Value $resolvedFirefoxPath
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name firefoxSha256Binding -Scope Script -Option Constant -Value $resolvedFirefoxSha256
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name publisherSha256Binding -Scope Script -Option Constant -Value $resolvedPublisherSha256
Set-Location $script:repoRoot
$RoomAlphaPluginRepo = Resolve-RoomAlphaPluginRepo `
    -RepoRoot $script:repoRoot `
    -ExplicitPath $RoomAlphaPluginRepo

if ($IncludeSoak -and $SkipSoak) {
    throw "Use either -IncludeSoak or -SkipSoak, not both."
}

# Soak is now part of the default release gate.
$runSoak = $IncludeSoak -or (-not $SkipSoak)

$captureSourceProcess = $null
$captureWindowFilterEffective = $CaptureWindowFilter
if (-not $captureWindowFilterEffective) {
    $captureWindowFilterEffective = [Environment]::GetEnvironmentVariable("GAME_CAPTURE_WINDOW_FILTER", "Process")
}
if (-not $captureWindowFilterEffective -and -not $DisableE2eCaptureSource) {
    $captureWindowFilterEffective = "Game Capture E2E Source $timestamp"
    Write-Host "Starting E2E capture source: $captureWindowFilterEffective"
    $captureSourceProcess = Start-E2eCaptureSource -Title $captureWindowFilterEffective
    Register-EngineEvent -SourceIdentifier PowerShell.Exiting -MessageData $captureSourceProcess.Id -Action {
        Stop-Process -Id ([int]$Event.MessageData) -Force -ErrorAction SilentlyContinue
    } | Out-Null
}
if ($captureWindowFilterEffective) {
    [Environment]::SetEnvironmentVariable("GAME_CAPTURE_WINDOW_FILTER", $captureWindowFilterEffective, "Process")
    Write-Host "Using E2E capture window filter: $captureWindowFilterEffective"
}

$lines = @()
$lines += "# Release Readiness Report"
$lines += ""
$lines += "- Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")"
$lines += "- Build dir: $BuildDir"
$lines += "- Config: $Configuration"
$lines += "- Publisher path: $publisherExe"
$lines += "- FFmpeg path override: $(if ($FfmpegPath) { $FfmpegPath } else { "(auto)" })"
$lines += "- Bitrate retries: $BitrateRetries"
$lines += "- Hardware retries: $HardwareRetries"
$lines += "- Refresh password: $(if ($RefreshPassword -ne '') { $RefreshPassword } else { '(default)' })"
$lines += "- Refresh encoder: $(if ($RefreshVideoEncoder) { $RefreshVideoEncoder } else { "(default)" })"
$lines += "- Control password: $(if ($ControlPassword -ne '') { $ControlPassword } else { '(default)' })"
$lines += "- Control token length: $($ControlToken.Length)"
$lines += "- Dual-stream gate enabled: $(if ($SkipDualStream) { 'no (explicitly skipped)' } else { 'yes' })"
$lines += "- Packaged room-alpha gate enabled: $(if ($SkipRoomAlpha) { 'no (explicitly skipped)' } else { 'yes' })"
$lines += "- Room-alpha plugin repo: $RoomAlphaPluginRepo"
$lines += "- Soak gate enabled: $(if ($runSoak) { 'yes' } else { 'no (explicitly skipped)' })"
$lines += "- Dual soak hold-ms: $DualSoakHoldMs"
$lines += "- Capture window filter: $(if ($captureWindowFilterEffective) { $captureWindowFilterEffective } else { '(default headless selection)' })"
$lines += "- Managed capture source: $(if ($captureSourceProcess) { 'yes' } else { 'no' })"
$lines += ""

$ffmpegCliArg = ""
if ($FfmpegPath) {
    $ffmpegCliArg = " --ffmpeg-path=`"$FfmpegPath`""
}

$allPass = $true

$qaEntrypointPass = & $script:runStepImplementation "QA entrypoint contracts" {
    $qaEntrypointArgs = @(
        "--prefix", $script:repoRoot, "run", "gate:qa-entrypoint-contracts"
    )
    & $script:npmExecutable @qaEntrypointArgs
}
$allPass = $allPass -and $qaEntrypointPass

$gpuInfo = Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterCompatibility, VideoProcessor
$lines += "## GPU Inventory"
$lines += ""
foreach ($gpu in $gpuInfo) {
    $lines += "- $($gpu.Name) | Driver $($gpu.DriverVersion) | Vendor $($gpu.AdapterCompatibility)"
}
$lines += ""

$nvidiaSmi = ""
try {
    $nvidiaSmi = cmd /c "nvidia-smi --query-gpu=name,driver_version,encoder.stats.averageFps,encoder.stats.averageLatency --format=csv,noheader"
} catch {
    $nvidiaSmi = "nvidia-smi unavailable"
}
$lines += "## NVIDIA Encoder Snapshot"
$lines += ""
$lines += '```text'
$lines += $nvidiaSmi
$lines += '```'
$lines += ""

$ctestPass = & $script:runStepImplementation "CTest" {
    ctest --test-dir $BuildDir -C $Configuration --output-on-failure
}
$allPass = $allPass -and $ctestPass
$lines += "## CTest"
$lines += ""
$lines += "- Result: " + ($(if ($ctestPass) { "PASS" } else { "FAIL" }))
$lines += ""

$e2ePass = & $script:runStepImplementation "E2E Matrix" {
    cmd /c "npm --prefix `"$repoRoot`" run e2e:matrix -- --publisher-path=`"$publisherExe`""
}
$allPass = $allPass -and $e2ePass
$lines += "## E2E Matrix"
$lines += ""
$lines += "- Result: " + ($(if ($e2ePass) { "PASS" } else { "FAIL" }))
$lines += ""

$refreshPass = & $script:runStepImplementation "E2E Refresh (dual-viewer reconnect)" {
    $refreshCmd = "npm --prefix `"$repoRoot`" run e2e:refresh -- --publisher-path=`"$publisherExe`" --reloads=3 --join-delay-ms=8000 --timeout-ms=60000 --password=$RefreshPassword"
    if ($RefreshVideoEncoder) {
        $refreshCmd += " --video-encoder=$RefreshVideoEncoder"
    }
    if ($FfmpegPath) {
        $refreshCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    cmd /c $refreshCmd
}
$allPass = $allPass -and $refreshPass
$lines += "## E2E Refresh"
$lines += ""
$lines += "- Result: " + ($(if ($refreshPass) { "PASS" } else { "FAIL" }))
$lines += "- Password: $(if ($RefreshPassword -ne '') { $RefreshPassword } else { '(default)' })"
$lines += "- Video encoder: $(if ($RefreshVideoEncoder) { $RefreshVideoEncoder } else { "(default)" })"
$lines += ""

$collisionPass = & $script:runStepImplementation "E2E Stream-ID Collision" {
    $collisionCmd = "npm --prefix `"$repoRoot`" run e2e:collision -- --publisher-path=`"$publisherExe`" --timeout-ms=30000 --password=$RefreshPassword"
    if ($RefreshVideoEncoder) {
        $collisionCmd += " --video-encoder=$RefreshVideoEncoder"
    }
    if ($FfmpegPath) {
        $collisionCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    cmd /c $collisionCmd
}
$allPass = $allPass -and $collisionPass
$lines += "## E2E Stream-ID Collision"
$lines += ""
$lines += "- Result: " + ($(if ($collisionPass) { "PASS" } else { "FAIL" }))
$lines += "- Password: $(if ($RefreshPassword -ne '') { $RefreshPassword } else { '(default)' })"
$lines += "- Video encoder: $(if ($RefreshVideoEncoder) { $RefreshVideoEncoder } else { "(default)" })"
$lines += ""

$controlPass = & $script:runStepImplementation "E2E Data Channel Control" {
    $controlCmd = "npm --prefix `"$repoRoot`" run e2e:control -- --publisher-path=`"$publisherExe`" --timeout-ms=60000 --password=$ControlPassword --remote-token=$ControlToken --bitrate-kbps=4500"
    if ($RefreshVideoEncoder) {
        $controlCmd += " --video-encoder=$RefreshVideoEncoder"
    }
    if ($FfmpegPath) {
        $controlCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    cmd /c $controlCmd
}
$allPass = $allPass -and $controlPass
$lines += "## E2E Data Channel Control"
$lines += ""
$lines += "- Result: " + ($(if ($controlPass) { "PASS" } else { "FAIL" }))
$lines += "- Password: $(if ($ControlPassword -ne '') { $ControlPassword } else { '(default)' })"
$lines += "- Token length: $($ControlToken.Length)"
$lines += ""

$signalEdgeReportDir = New-BrowserWorkflowReportDirectory 'signaling-edge'
$signalEdgePass = & $script:runStepImplementation "Signaling regressions (Edge)" {
    $startedAtUtc = [datetime]::UtcNow
    $signalEdgeArgs = @(
        "--prefix", $script:repoRoot, "run", "e2e:signaling-regressions:edge", "--",
        "--publisher-path=$script:publisherExe",
        "--artifact-manifest-path=$script:artifactManifestPathBinding",
        "--artifact-manifest-sha256=$script:artifactManifestSha256Binding",
        "--spout-sender-path=$script:spoutSenderPathBinding",
        "--expected-spout-sender-sha256=$script:spoutSenderSha256Binding",
        "--report-dir=$signalEdgeReportDir"
    )
    & $script:npmExecutable @signalEdgeArgs
    if ($LASTEXITCODE -ne 0) { throw "Edge signaling workflow exited with code $LASTEXITCODE" }
    Assert-FreshBrowserWorkflowReport `
        -ReportDir $signalEdgeReportDir `
        -Kind signaling `
        -Browser edge `
        -StartedAtUtc $startedAtUtc
}
$allPass = $allPass -and $signalEdgePass

$signalFirefoxReportDir = New-BrowserWorkflowReportDirectory 'signaling-firefox'
$signalFirefoxPass = & $script:runStepImplementation "Signaling regressions (Firefox)" {
    $startedAtUtc = [datetime]::UtcNow
    $signalFirefoxArgs = @(
        "--prefix", $script:repoRoot, "run", "e2e:signaling-regressions:firefox", "--",
        "--publisher-path=$script:publisherExe",
        "--artifact-manifest-path=$script:artifactManifestPathBinding",
        "--artifact-manifest-sha256=$script:artifactManifestSha256Binding",
        "--spout-sender-path=$script:spoutSenderPathBinding",
        "--expected-spout-sender-sha256=$script:spoutSenderSha256Binding",
        "--report-dir=$signalFirefoxReportDir"
    )
    & $script:npmExecutable @signalFirefoxArgs
    if ($LASTEXITCODE -ne 0) { throw "Firefox signaling workflow exited with code $LASTEXITCODE" }
    Assert-FreshBrowserWorkflowReport `
        -ReportDir $signalFirefoxReportDir `
        -Kind signaling `
        -Browser firefox `
        -StartedAtUtc $startedAtUtc
}
$allPass = $allPass -and $signalFirefoxPass

$signalInstalledFirefoxReportDir = New-BrowserWorkflowReportDirectory 'signaling-firefox-installed'
$signalInstalledFirefoxPass = & $script:runStepImplementation "Signaling regressions (installed Firefox)" {
    $startedAtUtc = [datetime]::UtcNow
    $signalInstalledFirefoxArgs = @(
        "--prefix", $script:repoRoot, "run", "e2e:signaling-regressions:firefox-installed", "--",
        "--publisher-path=$script:publisherExe",
        "--artifact-manifest-path=$script:artifactManifestPathBinding",
        "--artifact-manifest-sha256=$script:artifactManifestSha256Binding",
        "--spout-sender-path=$script:spoutSenderPathBinding",
        "--expected-spout-sender-sha256=$script:spoutSenderSha256Binding",
        "--firefox-path=$script:firefoxPathBinding",
        "--expected-firefox-sha256=$script:firefoxSha256Binding",
        "--report-dir=$signalInstalledFirefoxReportDir"
    )
    & $script:npmExecutable @signalInstalledFirefoxArgs
    if ($LASTEXITCODE -ne 0) { throw "Installed Firefox signaling workflow exited with code $LASTEXITCODE" }
    Assert-FreshBrowserWorkflowReport `
        -ReportDir $signalInstalledFirefoxReportDir `
        -Kind signaling `
        -Browser firefox-installed `
        -StartedAtUtc $startedAtUtc
}
$allPass = $allPass -and $signalInstalledFirefoxPass

$controlCenterEdgeReportDir = New-BrowserWorkflowReportDirectory 'control-center-edge'
$controlCenterEdgePass = & $script:runStepImplementation "Control Center strict negotiation (Edge)" {
    $startedAtUtc = [datetime]::UtcNow
    $controlCenterEdgeArgs = @(
        "--prefix", $script:repoRoot, "run", "e2e:control-center:edge", "--",
        "--publisher-path=$script:publisherExe",
        "--artifact-manifest-path=$script:artifactManifestPathBinding",
        "--artifact-manifest-sha256=$script:artifactManifestSha256Binding",
        "--spout-sender-path=$script:spoutSenderPathBinding",
        "--expected-spout-sender-sha256=$script:spoutSenderSha256Binding",
        "--report-dir=$controlCenterEdgeReportDir"
    )
    & $script:npmExecutable @controlCenterEdgeArgs
    if ($LASTEXITCODE -ne 0) { throw "Edge Control Center workflow exited with code $LASTEXITCODE" }
    Assert-FreshBrowserWorkflowReport `
        -ReportDir $controlCenterEdgeReportDir `
        -Kind director `
        -Browser edge `
        -StartedAtUtc $startedAtUtc
}
$allPass = $allPass -and $controlCenterEdgePass

$controlCenterFirefoxReportDir = New-BrowserWorkflowReportDirectory 'control-center-firefox'
$controlCenterFirefoxPass = & $script:runStepImplementation "Control Center strict negotiation (Firefox)" {
    $startedAtUtc = [datetime]::UtcNow
    $controlCenterFirefoxArgs = @(
        "--prefix", $script:repoRoot, "run", "e2e:control-center:firefox", "--",
        "--publisher-path=$script:publisherExe",
        "--artifact-manifest-path=$script:artifactManifestPathBinding",
        "--artifact-manifest-sha256=$script:artifactManifestSha256Binding",
        "--spout-sender-path=$script:spoutSenderPathBinding",
        "--expected-spout-sender-sha256=$script:spoutSenderSha256Binding",
        "--report-dir=$controlCenterFirefoxReportDir"
    )
    & $script:npmExecutable @controlCenterFirefoxArgs
    if ($LASTEXITCODE -ne 0) { throw "Firefox Control Center workflow exited with code $LASTEXITCODE" }
    Assert-FreshBrowserWorkflowReport `
        -ReportDir $controlCenterFirefoxReportDir `
        -Kind director `
        -Browser firefox `
        -StartedAtUtc $startedAtUtc
}
$allPass = $allPass -and $controlCenterFirefoxPass

$controlCenterInstalledFirefoxReportDir = New-BrowserWorkflowReportDirectory 'control-center-firefox-installed'
$controlCenterInstalledFirefoxPass = & $script:runStepImplementation "Control Center strict negotiation (installed Firefox)" {
    $startedAtUtc = [datetime]::UtcNow
    $controlCenterInstalledFirefoxArgs = @(
        "--prefix", $script:repoRoot, "run", "e2e:control-center:firefox-installed", "--",
        "--publisher-path=$script:publisherExe",
        "--artifact-manifest-path=$script:artifactManifestPathBinding",
        "--artifact-manifest-sha256=$script:artifactManifestSha256Binding",
        "--spout-sender-path=$script:spoutSenderPathBinding",
        "--expected-spout-sender-sha256=$script:spoutSenderSha256Binding",
        "--firefox-path=$script:firefoxPathBinding",
        "--expected-firefox-sha256=$script:firefoxSha256Binding",
        "--report-dir=$controlCenterInstalledFirefoxReportDir"
    )
    & $script:npmExecutable @controlCenterInstalledFirefoxArgs
    if ($LASTEXITCODE -ne 0) { throw "Installed Firefox Control Center workflow exited with code $LASTEXITCODE" }
    Assert-FreshBrowserWorkflowReport `
        -ReportDir $controlCenterInstalledFirefoxReportDir `
        -Kind director `
        -Browser firefox-installed `
        -StartedAtUtc $startedAtUtc
}
$allPass = $allPass -and $controlCenterInstalledFirefoxPass

$alphaArtifactPass = & $script:runStepImplementation "Alpha artifact identity contract" {
    $alphaArtifactArgs = @(
        "--prefix", $script:repoRoot, "run", "gate:alpha-artifact-bindings", "--",
        "-PluginRepo", $RoomAlphaPluginRepo
    )
    & $script:npmExecutable @alphaArtifactArgs
}
$allPass = $allPass -and $alphaArtifactPass

$alphaAnalyzerPass = & $script:runStepImplementation "Alpha analyzer contract" {
    $alphaAnalyzerArgs = @(
        "--prefix", $script:repoRoot, "run", "gate:alpha-composite-analyzer", "--",
        "--plugin-repo", $RoomAlphaPluginRepo
    )
    & $script:npmExecutable @alphaAnalyzerArgs
}
$allPass = $allPass -and $alphaAnalyzerPass

$lines += "## Signaling and Control Center regressions"
$lines += ""
$lines += "- Edge signaling: " + ($(if ($signalEdgePass) { "PASS" } else { "FAIL" }))
$lines += "- Firefox signaling: " + ($(if ($signalFirefoxPass) { "PASS" } else { "FAIL" }))
$lines += "- Installed Firefox signaling: " + ($(if ($signalInstalledFirefoxPass) { "PASS" } else { "FAIL" }))
$lines += "- Edge strict Control Center: " + ($(if ($controlCenterEdgePass) { "PASS" } else { "FAIL" }))
$lines += "- Firefox strict Control Center: " + ($(if ($controlCenterFirefoxPass) { "PASS" } else { "FAIL" }))
$lines += "- Installed Firefox strict Control Center: " + ($(if ($controlCenterInstalledFirefoxPass) { "PASS" } else { "FAIL" }))
$lines += "- Exact Spout sender: $script:spoutSenderPathBinding"
$lines += "- Exact Spout sender SHA-256: $script:spoutSenderSha256Binding"
$lines += "- Exact installed Firefox: $script:firefoxPathBinding"
$lines += "- Exact installed Firefox SHA-256: $script:firefoxSha256Binding"
$lines += ""
$lines += "## QA and alpha static contracts"
$lines += ""
$lines += "- QA entrypoints: " + ($(if ($qaEntrypointPass) { "PASS" } else { "FAIL" }))
$lines += "- Artifact identities: " + ($(if ($alphaArtifactPass) { "PASS" } else { "FAIL" }))
$lines += "- Composite analyzer: " + ($(if ($alphaAnalyzerPass) { "PASS" } else { "FAIL" }))
$lines += ""

$dualQualityPass = $true
$dualQualityChurnPass = $true
$dualInitFuzzPass = $true
$dualRequirementsPass = $true
if (-not $SkipDualStream) {
    $dualQualityPass = & $script:runStepImplementation "E2E Dual Quality Roles" {
        $dualCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --timeout-ms=60000"
        if ($RefreshVideoEncoder) {
            $dualCmd += " --video-encoder=$RefreshVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        cmd /c $dualCmd
    }
    $allPass = $allPass -and $dualQualityPass

    $dualQualityChurnPass = & $script:runStepImplementation "E2E Dual Quality Churn" {
        $dualChurnCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality-churn -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --cycles=4 --timeout-ms=60000 --hold-ms=2500 --join-gap-ms=250 --leave-gap-ms=250"
        if ($RefreshVideoEncoder) {
            $dualChurnCmd += " --video-encoder=$RefreshVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualChurnCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        cmd /c $dualChurnCmd
    }
    $allPass = $allPass -and $dualQualityChurnPass

    $dualInitFuzzPass = & $script:runStepImplementation "E2E Dual Quality Init Fuzz" {
        $dualFuzzCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality-init-fuzz -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --timeout-ms=60000"
        if ($RefreshVideoEncoder) {
            $dualFuzzCmd += " --video-encoder=$RefreshVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualFuzzCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        cmd /c $dualFuzzCmd
    }
    $allPass = $allPass -and $dualInitFuzzPass

    $dualRequirementsPass = & $script:runStepImplementation "E2E Dual Quality Requirements" {
        $dualReqCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality-requirements -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --timeout-ms=60000 --hold-ms=2500 --remote-token=$ControlToken"
        if ($RefreshVideoEncoder) {
            $dualReqCmd += " --video-encoder=$RefreshVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualReqCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        cmd /c $dualReqCmd
    }
    $allPass = $allPass -and $dualRequirementsPass
}
$lines += "## E2E Dual Quality"
$lines += ""
if ($SkipDualStream) {
    $lines += "- Result: SKIPPED (disabled via -SkipDualStream)"
} else {
    $lines += "- Mixed roles result: " + ($(if ($dualQualityPass) { "PASS" } else { "FAIL" }))
    $lines += "- Churn result: " + ($(if ($dualQualityChurnPass) { "PASS" } else { "FAIL" }))
    $lines += "- Init fuzz result: " + ($(if ($dualInitFuzzPass) { "PASS" } else { "FAIL" }))
    $lines += "- Requirements gate result: " + ($(if ($dualRequirementsPass) { "PASS" } else { "FAIL" }))
}
$lines += ""

$roomAlphaPass = $true
$fullAlphaPass = $true
$roomAlphaEvidence = [ordered]@{
    publisher = $null
    publisherSha256 = $null
    spoutSender = $null
    spoutSenderSha256 = $null
    plugin = $null
    pluginSha256 = $null
    manifest = $null
}
$fullAlphaEvidence = [ordered]@{
    publisher = $null
    publisherSha256 = $null
    spoutSender = $null
    spoutSenderSha256 = $null
    plugin = $null
    pluginSha256 = $null
    manifest = $null
}
$packagedPublisher = $null
$roomAlphaSender = $null
$pluginPayload = $null
$publisherHash = $null
$senderHash = $null
$pluginHash = $null
$alphaIdentityError = $null
if (-not $SkipRoomAlpha) {
    try {
        if (-not (Test-Path -LiteralPath $RoomAlphaPluginRepo -PathType Container)) {
            throw "Room-alpha plugin repository was not found: $RoomAlphaPluginRepo"
        }
        $pluginPayload = Join-Path $RoomAlphaPluginRepo "install\obs-plugins\64bit\obs-vdoninja.dll"
        if (-not (Test-Path -LiteralPath $pluginPayload -PathType Leaf)) {
            throw "Staged ninja-plugin payload was not found: $pluginPayload"
        }
        $packagedPublisher = Resolve-PackagedPublisherExecutable `
            -ExplicitPath $RoomAlphaPublisherPath
        $roomAlphaSender = Resolve-RoomAlphaSpoutSender `
            -ExplicitPath $RoomAlphaSpoutSenderPath
        $publisherHash = (Get-FileHash -LiteralPath $packagedPublisher -Algorithm SHA256).Hash.ToLowerInvariant()
        $senderHash = (Get-FileHash -LiteralPath $roomAlphaSender -Algorithm SHA256).Hash.ToLowerInvariant()
        $pluginHash = (Get-FileHash -LiteralPath $pluginPayload -Algorithm SHA256).Hash.ToLowerInvariant()
    } catch {
        $alphaIdentityError = $_
    }

    $roomAlphaRunDir = Join-Path $reportDir "release-room-alpha-$timestamp"
    $fullAlphaRunDir = Join-Path $reportDir "release-full-alpha-$timestamp"
    $roomAlphaPass = & $script:runStepImplementation "Packaged Room Alpha (VP9 authority + Room Quality)" {
        if ($alphaIdentityError) {
            throw $alphaIdentityError
        }
        $roomAlphaArgs = @(
            "--prefix", $script:repoRoot, "run", "e2e:room-alpha-ninja-plugin", "--",
            "-PluginRepo", $RoomAlphaPluginRepo,
            "-PublisherPath", $packagedPublisher,
            "-SpoutSenderPath", $roomAlphaSender,
            "-ExpectedPublisherSha256", $publisherHash,
            "-ExpectedPluginSha256", $pluginHash,
            "-ExpectedSpoutSenderSha256", $senderHash,
            "-ReportDir", $roomAlphaRunDir
        )
        & $script:npmExecutable @roomAlphaArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged room-alpha workflow exited with code $LASTEXITCODE"
        }
        $manifestPath = Join-Path $roomAlphaRunDir "manifest.json"
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            throw "Packaged room-alpha workflow did not produce its manifest: $manifestPath"
        }
        $roomAlphaManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if (-not [bool]$roomAlphaManifest.ok -or
            -not [bool]$roomAlphaManifest.artifactHashesStable -or
            @($roomAlphaManifest.cases | Where-Object { -not $_.ok }).Count -ne 0) {
            throw "Packaged room-alpha manifest is not release-acceptable: $manifestPath"
        }
        $roomAlphaEvidence.publisher = $packagedPublisher
        $roomAlphaEvidence.publisherSha256 = $publisherHash
        $roomAlphaEvidence.spoutSender = $roomAlphaSender
        $roomAlphaEvidence.spoutSenderSha256 = $senderHash
        $roomAlphaEvidence.plugin = $pluginPayload
        $roomAlphaEvidence.pluginSha256 = $pluginHash
        $roomAlphaEvidence.manifest = $manifestPath
    }
    $allPass = $allPass -and $roomAlphaPass

    $fullAlphaPass = & $script:runStepImplementation "Packaged Alpha (seven-case transparency matrix)" {
        if ($alphaIdentityError) {
            throw $alphaIdentityError
        }
        $fullAlphaArgs = @(
            "--prefix", $script:repoRoot, "run", "e2e:ninja-plugin-alpha", "--",
            "-PluginRepo", $RoomAlphaPluginRepo,
            "-PublisherPath", $packagedPublisher,
            "-SpoutSenderPath", $roomAlphaSender,
            "-ExpectedPublisherSha256", $publisherHash,
            "-ExpectedPluginSha256", $pluginHash,
            "-ExpectedSpoutSenderSha256", $senderHash,
            "-ReportDir", $fullAlphaRunDir
        )
        & $script:npmExecutable @fullAlphaArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged seven-case alpha workflow exited with code $LASTEXITCODE"
        }
        $manifestPath = Join-Path $fullAlphaRunDir "manifest.json"
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            throw "Packaged seven-case alpha workflow did not produce its manifest: $manifestPath"
        }
        $fullAlphaManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if (-not [bool]$fullAlphaManifest.ok -or
            -not [bool]$fullAlphaManifest.artifactHashesStable -or
            @($fullAlphaManifest.cases | Where-Object { -not $_.ok }).Count -ne 0) {
            throw "Packaged seven-case alpha manifest is not release-acceptable: $manifestPath"
        }
        $fullAlphaEvidence.publisher = $packagedPublisher
        $fullAlphaEvidence.publisherSha256 = $publisherHash
        $fullAlphaEvidence.spoutSender = $roomAlphaSender
        $fullAlphaEvidence.spoutSenderSha256 = $senderHash
        $fullAlphaEvidence.plugin = $pluginPayload
        $fullAlphaEvidence.pluginSha256 = $pluginHash
        $fullAlphaEvidence.manifest = $manifestPath
    }
    $allPass = $allPass -and $fullAlphaPass
}
$lines += "## Packaged Alpha"
$lines += ""
if ($SkipRoomAlpha) {
    $lines += "- Result: SKIPPED (disabled via -SkipRoomAlpha)"
} else {
    $lines += "- Room Quality result: " + ($(if ($roomAlphaPass) { "PASS" } else { "FAIL" }))
    $lines += "- Seven-case transparency result: " + ($(if ($fullAlphaPass) { "PASS" } else { "FAIL" }))
    $lines += "- Publisher: $(if ($roomAlphaEvidence.publisher) { $roomAlphaEvidence.publisher } else { '(unresolved)' })"
    $lines += "- Publisher SHA-256: $(if ($roomAlphaEvidence.publisherSha256) { $roomAlphaEvidence.publisherSha256 } else { '(unresolved)' })"
    $lines += "- Spout fixture: $(if ($roomAlphaEvidence.spoutSender) { $roomAlphaEvidence.spoutSender } else { '(unresolved)' })"
    $lines += "- Spout fixture SHA-256: $(if ($roomAlphaEvidence.spoutSenderSha256) { $roomAlphaEvidence.spoutSenderSha256 } else { '(unresolved)' })"
    $lines += "- Plugin payload: $(if ($roomAlphaEvidence.plugin) { $roomAlphaEvidence.plugin } else { '(unresolved)' })"
    $lines += "- Plugin SHA-256: $(if ($roomAlphaEvidence.pluginSha256) { $roomAlphaEvidence.pluginSha256 } else { '(unresolved)' })"
    $lines += "- Room Quality manifest: $(if ($roomAlphaEvidence.manifest) { $roomAlphaEvidence.manifest } else { '(unresolved)' })"
    $lines += "- Seven-case manifest: $(if ($fullAlphaEvidence.manifest) { $fullAlphaEvidence.manifest } else { '(unresolved)' })"
}
$lines += ""

$bitratePass = Run-StepWithRetry "Bitrate Preset Smoke" (1 + [Math]::Max(0, $BitrateRetries)) {
    $bitrateCmd = "npm --prefix `"$repoRoot`" run e2e:bitrate -- --publisher-path=`"$publisherExe`""
    if ($FfmpegPath) {
        $bitrateCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    cmd /c $bitrateCmd
}
$allPass = $allPass -and $bitratePass
$lines += "## Bitrate Preset Smoke"
$lines += ""
$lines += "- Result: " + ($(if ($bitratePass) { "PASS" } else { "FAIL" }))
$lines += ""

$hardwareChecksRan = $false
$hardwareNvencPass = $false
$hardwareQsvPass = $false
if ($CheckHardwareEncoders) {
    $hardwareChecksRan = $true
    $hardwareNvencPass = Run-StepWithRetry "Hardware Smoke (NVENC strict)" (1 + [Math]::Max(0, $HardwareRetries)) {
        cmd /c "npm --prefix `"$repoRoot`" run e2e:bitrate -- --publisher-path=`"$publisherExe`" --video-encoder=nvenc --bitrates=12000 --require-hardware --expect-encoder-name=nvenc,nvidia --forbid-encoder-name=intel,qsv$ffmpegCliArg"
    }
    $hardwareQsvPass = Run-StepWithRetry "Hardware Smoke (QSV strict)" (1 + [Math]::Max(0, $HardwareRetries)) {
        cmd /c "npm --prefix `"$repoRoot`" run e2e:bitrate -- --publisher-path=`"$publisherExe`" --video-encoder=qsv --bitrates=12000 --require-hardware --expect-encoder-name=`"intel,qsv,h264 encoder mft,avc dx12`" --forbid-encoder-name=nvenc,nvidia$ffmpegCliArg"
    }
    if ($EnforceHardwareEncoders) {
        $allPass = $allPass -and $hardwareNvencPass -and $hardwareQsvPass
    }
}
$lines += "## Hardware Encoder Capability"
$lines += ""
if ($hardwareChecksRan) {
    $lines += "- NVENC strict result: " + ($(if ($hardwareNvencPass) { "PASS" } else { "FAIL" }))
    $lines += "- QSV strict result: " + ($(if ($hardwareQsvPass) { "PASS" } else { "FAIL" }))
    $lines += "- Enforced: " + ($(if ($EnforceHardwareEncoders) { "yes" } else { "no" }))
} else {
    $lines += "- Result: SKIPPED"
}
$lines += ""

$soakRan = $false
$soakPass = $true
$dualSoakPass = $true
if ($runSoak) {
    $soakRan = $true
    # Run dual-stream soak first while runtime/network state is fresh.
    if (-not $SkipDualStream) {
        $dualSoakCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality-soak -- --publisher-path=`"$publisherExe`" --duration-min=$SoakDurationMin --hold-ms=$DualSoakHoldMs --password=$SoakPassword --stream=dual_soak_$timestamp --room=dual_room_$timestamp"
        if ($SoakVideoEncoder) {
            $dualSoakCmd += " --video-encoder=$SoakVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualSoakCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        $dualSoakPass = & $script:runStepImplementation "E2E Dual Quality Soak" {
            cmd /c $dualSoakCmd
        }
        $allPass = $allPass -and $dualSoakPass
    }

    $soakCmd = "npm --prefix `"$repoRoot`" run e2e:soak -- --publisher-path=`"$publisherExe`" --duration-min=$SoakDurationMin --hold-ms=$SoakHoldMs --password=$SoakPassword --stream=soak_$timestamp"
    if ($SoakVideoEncoder) {
        $soakCmd += " --video-encoder=$SoakVideoEncoder"
    }
    if ($FfmpegPath) {
        $soakCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    $soakPass = & $script:runStepImplementation "E2E Soak" {
        cmd /c $soakCmd
    }
    $allPass = $allPass -and $soakPass
}
$lines += "## E2E Soak"
$lines += ""
if ($soakRan) {
    $lines += "- Result: " + ($(if ($soakPass) { "PASS" } else { "FAIL" }))
    $lines += "- Duration-min: $SoakDurationMin"
    $lines += "- Hold-ms: $SoakHoldMs"
    $lines += "- Dual hold-ms: $DualSoakHoldMs"
    $lines += "- Password: $SoakPassword"
    $lines += "- Video encoder: $(if ($SoakVideoEncoder) { $SoakVideoEncoder } else { "(default)" })"
} else {
    $lines += "- Result: SKIPPED (disabled via -SkipSoak)"
}
$lines += "- Dual quality soak: " + ($(if ($SkipDualStream -or -not $soakRan) { "SKIPPED" } elseif ($dualSoakPass) { "PASS" } else { "FAIL" }))
$lines += ""

$installerRan = $false
$installerPass = $true
$makensis = Get-Command makensis -ErrorAction SilentlyContinue
if (-not $makensis) {
    foreach ($candidate in @(
        "C:\Program Files (x86)\NSIS\makensis.exe",
        "C:\Program Files\NSIS\makensis.exe"
    )) {
        if (Test-Path $candidate) {
            $makensis = [pscustomobject]@{ Path = $candidate }
            break
        }
    }
}
if ($makensis) {
    $installerRan = $true
    $installerPass = & $script:runStepImplementation "Installer Smoke" {
        if (-not $SkipRoomAlpha) {
            $installerPublisher = $packagedPublisher
        } else {
            $installerPublisher = $publisherExe
        }
        if ([string]::IsNullOrWhiteSpace($installerPublisher) -or
            -not (Test-Path -LiteralPath $installerPublisher -PathType Leaf)) {
            throw "Installer smoke publisher identity is unavailable: $installerPublisher"
        }
        $installerPublisher = (Resolve-Path -LiteralPath $installerPublisher).Path
        $installerBinDir = Split-Path -Parent $installerPublisher
        $stagedPublisher = Join-Path $installerBinDir "game-capture.exe"
        if ((Resolve-Path -LiteralPath $stagedPublisher).Path -cne $installerPublisher) {
            throw "Installer smoke is not bound to the selected publisher identity: $installerPublisher"
        }
        foreach ($requiredRelPath in @("game-capture.exe", "platforms\qwindows.dll")) {
            $requiredPath = Join-Path $installerBinDir $requiredRelPath
            if (-not (Test-Path $requiredPath)) {
                throw "Installer smoke missing required staged artifact: $requiredPath"
            }
        }
        $installerOutput = Join-Path $reportDir "installer-smoke-$timestamp.exe"
        & $makensis.Path /V2 "/DBUILD_BIN_DIR=$installerBinDir" "/DOUTFILE=$installerOutput" installer.nsi
        if ($LASTEXITCODE -ne 0) {
            throw "makensis failed with exit code $LASTEXITCODE"
        }
        if (-not (Test-Path -LiteralPath $installerOutput -PathType Leaf)) {
            throw "Installer smoke did not produce its exact output: $installerOutput"
        }
    }
    $allPass = $allPass -and $installerPass
} else {
    Write-Section "Installer Smoke"
    Write-Host "makensis not found; skipping installer build."
}
$lines += "## Installer Smoke"
$lines += ""
if ($installerRan) {
    $lines += "- Result: " + ($(if ($installerPass) { "PASS" } else { "FAIL" }))
} else {
    $lines += "- Result: SKIPPED"
}
$lines += ""

$lines += "## Overall"
$lines += ""
$lines += "- Result: " + ($(if ($allPass) { "PASS" } else { "FAIL" }))
$lines += ""

Set-Content -Path $reportPath -Value $lines -Encoding UTF8
Write-Host ""
Write-Host "Report written to: $reportPath"

Stop-E2eCaptureSource $captureSourceProcess

if (-not $allPass) {
    exit 1
}
