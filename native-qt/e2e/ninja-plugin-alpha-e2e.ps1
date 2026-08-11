[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PluginRepo,
    [string]$PublisherPath = "",
    [string]$SpoutSenderPath = "",
    [string]$ExpectedPublisherSha256 = "",
    [string]$ExpectedPluginSha256 = "",
    [string]$ExpectedSpoutSenderSha256 = "",
    [string]$ReportDir = "",
    [int]$GameCaptureWarmupSeconds = 14,
    [int]$CheckTimeoutSeconds = 170,
    [string[]]$Patterns = @("alpha-checker", "alpha-moving-edge", "alpha-opaque", "alpha-half")
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($PluginRepo)) {
    throw "PluginRepo is required."
}
$PluginRepo = [System.IO.Path]::GetFullPath($PluginRepo)
$requiredPatterns = @("alpha-checker", "alpha-moving-edge", "alpha-opaque", "alpha-half")
$requiredWorkflowCases = @(
    [ordered]@{ name = "checker-source-toggle"; pattern = "alpha-checker"; transitionMode = "source-toggle" },
    [ordered]@{ name = "moving-source-toggle"; pattern = "alpha-moving-edge"; transitionMode = "source-toggle" },
    [ordered]@{ name = "opaque-source-toggle"; pattern = "alpha-opaque"; transitionMode = "source-toggle" },
    [ordered]@{ name = "half-source-toggle"; pattern = "alpha-half"; transitionMode = "source-toggle" },
    [ordered]@{ name = "moving-source-recreate"; pattern = "alpha-moving-edge"; transitionMode = "source-recreate" },
    [ordered]@{ name = "moving-same-peer-rebuild"; pattern = "alpha-moving-edge"; transitionMode = "same-peer-ice-rebuild" },
    [ordered]@{ name = "moving-publisher-restart"; pattern = "alpha-moving-edge"; transitionMode = "publisher-restart" },
    [ordered]@{
        name = "h264-1080p60-half-resolution-alpha"
        pattern = "alpha-moving-edge"
        transitionMode = "source-toggle"
        videoCodec = "h264"
        outputWidth = 1920
        outputHeight = 1080
        outputFps = 60
        expectedAlphaWidth = 960
        expectedAlphaHeight = 540
    }
)
$nativeQtRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($ReportDir)) {
    $reportDir = Join-Path $PSScriptRoot ("reports\phase3-plugin-alpha-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
} else {
    $reportDir = [System.IO.Path]::GetFullPath($ReportDir)
}
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$manifestPath = Join-Path $reportDir "manifest.json"
$driver = Join-Path $PluginRepo "scripts\run-vdoninja-gamecapture-spout-smoke.ps1"
$sourceSmoke = Join-Path $PluginRepo "scripts\run-vdoninja-source-smoke.ps1"
$sourceChecker = Join-Path $PluginRepo "scripts\obs-websocket-vdoninja-source-check.cjs"
$analyzerRegression = Join-Path $PSScriptRoot "alpha-composite-analyzer-regression.js"
$artifactRegression = Join-Path $PSScriptRoot "alpha-artifact-binding-regression.ps1"
$harnessContracts = Join-Path $PluginRepo "scripts\alpha-harness-contracts.ps1"

function Normalize-Sha256 {
    param([string]$Value, [string]$Label)

    $normalized = ([string]$Value).Trim().ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{64}$') {
        throw "$Label is required and must be a 64-character SHA256 value"
    }
    return $normalized
}

function Get-FileBinding {
    param([string]$Path, [switch]$Optional)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($Optional) { return $null }
        throw "Evidence artifact was not found: $Path"
    }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    return [ordered]@{
        path = $resolved
        sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$caseResults = @(
    $requiredWorkflowCases | ForEach-Object {
        [ordered]@{
            name = $_.name
            pattern = $_.pattern
            transitionMode = $_.transitionMode
            videoCodec = if ($_.videoCodec) { [string]$_.videoCodec } else { "vp9" }
            outputWidth = if ($_.outputWidth) { [int]$_.outputWidth } else { 0 }
            outputHeight = if ($_.outputHeight) { [int]$_.outputHeight } else { 0 }
            outputFps = if ($_.outputFps) { [int]$_.outputFps } else { 0 }
            expectedAlphaWidth = if ($_.expectedAlphaWidth) { [int]$_.expectedAlphaWidth } else { 0 }
            expectedAlphaHeight = if ($_.expectedAlphaHeight) { [int]$_.expectedAlphaHeight } else { 0 }
            status = "unexecuted"
            ok = $false
            failure = $null
            driverExitCode = $null
            driverLog = $null
            summary = $null
            runDir = $null
            sampling = $null
            sequence = $null
            validatedTransitionClaims = $null
            artifactIdentityContract = $null
            loadedPlugin = $null
            loadedPluginModules = @()
            screenshots = @()
            evidence = @()
            gameCaptureDiagnostics = $null
            alphaEncoderDimensionsObserved = $false
            receiverScaleObserved = $false
        }
    }
)
$manifest = [ordered]@{
    schemaVersion = 2
    ok = $false
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    completedAt = $null
    requiredPatterns = $requiredPatterns
    requiredWorkflowCases = @($requiredWorkflowCases)
    requestedPatterns = @($Patterns)
    transitionContract = [ordered]@{
        mode = "required-matrix"
        supportedModes = @("source-toggle", "source-recreate", "command", "same-peer-ice-rebuild", "publisher-restart")
        externalCommandModesRequireExplicitCommand = $true
        realObsLifecycle = $true
        settleBeforeCaptureMs = 0
        maximumCaptureStartCadenceMs = 100
        movingUsefulSamplesPerEpoch = 10
        distinctFixtureVisualEpoch = $true
        requireOldTransportRetiredBeforeVisualEpochChange = $true
        requireObservedNewTransportBeforeFirstPostCapture = $true
    }
    expectedArtifactHashes = [ordered]@{
        gameCapture = $ExpectedPublisherSha256
        plugin = $ExpectedPluginSha256
        spoutSender = $ExpectedSpoutSenderSha256
    }
    artifactBinding = $null
    finalArtifactBinding = $null
    artifactHashesStable = $false
    analyzerGate = [ordered]@{
        status = "unexecuted"
        ok = $false
        exitCode = $null
        log = $null
    }
    artifactBindingGate = [ordered]@{
        status = "unexecuted"
        ok = $false
        exitCode = $null
        log = $null
    }
    fatalError = $null
    cases = $caseResults
}

try {
    $ExpectedPublisherSha256 = Normalize-Sha256 $ExpectedPublisherSha256 "ExpectedPublisherSha256"
    $ExpectedPluginSha256 = Normalize-Sha256 $ExpectedPluginSha256 "ExpectedPluginSha256"
    $ExpectedSpoutSenderSha256 = Normalize-Sha256 $ExpectedSpoutSenderSha256 "ExpectedSpoutSenderSha256"
    $manifest.expectedArtifactHashes.gameCapture = $ExpectedPublisherSha256
    $manifest.expectedArtifactHashes.plugin = $ExpectedPluginSha256
    $manifest.expectedArtifactHashes.spoutSender = $ExpectedSpoutSenderSha256

    foreach ($requiredScript in @(
        $driver,
        $sourceSmoke,
        $sourceChecker,
        $analyzerRegression,
        $artifactRegression,
        $harnessContracts
    )) {
        if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
            throw "Required validation component was not found: $requiredScript"
        }
    }
    . $harnessContracts
    $normalizedPatterns = @($Patterns | ForEach-Object { ([string]$_).ToLowerInvariant() } | Select-Object -Unique)
    $missingPatterns = @($requiredPatterns | Where-Object { $_ -notin $normalizedPatterns })
    if ($missingPatterns.Count -gt 0) {
        throw "Complete transparency validation is missing: $($missingPatterns -join ', ')"
    }

    if ([string]::IsNullOrWhiteSpace($PublisherPath)) {
        $PublisherPath = Get-ChildItem -LiteralPath (Join-Path $nativeQtRoot "dist") -Directory -ErrorAction Stop |
            Where-Object { $_.Name -match '^game-capture-\d+\.\d+\.\d+-win64$' } |
            Sort-Object LastWriteTimeUtc -Descending |
            ForEach-Object { Join-Path $_.FullName "game-capture.exe" } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
    }
    if ([string]::IsNullOrWhiteSpace($SpoutSenderPath)) {
        $SpoutSenderPath = @(
            (Join-Path $nativeQtRoot "build-review2\bin\Release\spout_test_sender.exe"),
            (Join-Path $nativeQtRoot "build-test\bin\spout_test_sender.exe"),
            (Join-Path $nativeQtRoot "build\bin\Release\spout_test_sender.exe")
        ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    $publisherBinding = Get-FileBinding $PublisherPath
    $spoutBinding = Get-FileBinding $SpoutSenderPath
    $pluginPayloadBinding = Get-FileBinding (Join-Path $PluginRepo "install\obs-plugins\64bit\obs-vdoninja.dll")
    if ($publisherBinding.sha256 -ne $ExpectedPublisherSha256) {
        throw "Packaged publisher does not match the explicitly supplied fresh SHA256"
    }
    if ($spoutBinding.sha256 -ne $ExpectedSpoutSenderSha256) {
        throw "Spout fixture does not match the explicitly supplied fresh SHA256"
    }
    if ($pluginPayloadBinding.sha256 -ne $ExpectedPluginSha256) {
        throw "Staged ninja-plugin payload does not match the explicitly supplied fresh SHA256"
    }
    $PublisherPath = $publisherBinding.path
    $SpoutSenderPath = $spoutBinding.path
    $manifest.artifactBinding = [ordered]@{
        gameCapture = $publisherBinding
        spoutSender = $spoutBinding
        stagedPlugin = $pluginPayloadBinding
        wrapper = Get-FileBinding $MyInvocation.MyCommand.Path
        analyzerRegression = Get-FileBinding $analyzerRegression
        artifactRegression = Get-FileBinding $artifactRegression
        harnessContracts = Get-FileBinding $harnessContracts
        driver = Get-FileBinding $driver
        sourceSmoke = Get-FileBinding $sourceSmoke
        sourceChecker = Get-FileBinding $sourceChecker
    }

    Write-Host "[PLUGIN-ALPHA-E2E] Packaged publisher: $PublisherPath"
    Write-Host "[PLUGIN-ALPHA-E2E] Spout sender: $SpoutSenderPath"
    $analyzerLogPath = Join-Path $reportDir "alpha-analyzer-gate.log"
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $analyzerOutput = & node $analyzerRegression "--plugin-repo=$PluginRepo" 2>&1
        $analyzerExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    $analyzerOutput | Set-Content -LiteralPath $analyzerLogPath -Encoding UTF8
    $manifest.analyzerGate.status = if ($analyzerExit -eq 0) { "passed" } else { "failed" }
    $manifest.analyzerGate.ok = ($analyzerExit -eq 0)
    $manifest.analyzerGate.exitCode = $analyzerExit
    $manifest.analyzerGate.log = Get-FileBinding $analyzerLogPath
    if ($analyzerExit -ne 0) {
        throw "Alpha analyzer deterministic gate failed; application workflows were not started"
    }

    $artifactGateLogPath = Join-Path $reportDir "alpha-artifact-binding-gate.log"
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $artifactGateOutput = & powershell -NoProfile -ExecutionPolicy Bypass `
            -File $artifactRegression -PluginRepo $PluginRepo 2>&1
        $artifactGateExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    $artifactGateOutput | Set-Content -LiteralPath $artifactGateLogPath -Encoding UTF8
    $manifest.artifactBindingGate.status = if ($artifactGateExit -eq 0) { "passed" } else { "failed" }
    $manifest.artifactBindingGate.ok = ($artifactGateExit -eq 0)
    $manifest.artifactBindingGate.exitCode = $artifactGateExit
    $manifest.artifactBindingGate.log = Get-FileBinding $artifactGateLogPath
    if ($artifactGateExit -ne 0) {
        throw "Alpha artifact-binding deterministic gate failed; application workflows were not started"
    }

    Push-Location $PluginRepo
    try {
        foreach ($workflowCase in $requiredWorkflowCases) {
            $pattern = [string]$workflowCase.pattern
            $transitionMode = [string]$workflowCase.transitionMode
            $videoCodec = if ($workflowCase.videoCodec) { [string]$workflowCase.videoCodec } else { "vp9" }
            $outputWidth = if ($workflowCase.outputWidth) { [int]$workflowCase.outputWidth } else { 0 }
            $outputHeight = if ($workflowCase.outputHeight) { [int]$workflowCase.outputHeight } else { 0 }
            $outputFps = if ($workflowCase.outputFps) { [int]$workflowCase.outputFps } else { 0 }
            $expectedAlphaWidth = if ($workflowCase.expectedAlphaWidth) {
                [int]$workflowCase.expectedAlphaWidth
            } else { 0 }
            $expectedAlphaHeight = if ($workflowCase.expectedAlphaHeight) {
                [int]$workflowCase.expectedAlphaHeight
            } else { 0 }
            $case = @($caseResults | Where-Object { $_.name -eq $workflowCase.name })[0]
            $case.status = "running"
            $caseLogPath = Join-Path $reportDir "$($workflowCase.name)-driver.log"
            try {
                Write-Host "[PLUGIN-ALPHA-E2E] Running workflow: $($workflowCase.name)"
                $driverArgs = @(
                    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $driver,
                    "-GameCaptureExe", $PublisherPath,
                    "-UseTestSpoutSender",
                    "-TestSpoutSenderExe", $SpoutSenderPath,
                    "-TestSpoutPattern", $pattern,
                    "-VideoCodec", $videoCodec,
                    "-GameCaptureWarmupSeconds", [string]$GameCaptureWarmupSeconds,
                    "-CheckTimeoutSeconds", [string]$CheckTimeoutSeconds,
                    "-AlphaSampleIntervalMs", "75",
                    "-AlphaTransitionMode", $transitionMode,
                    "-AlphaTransitionLabel", "obs-$transitionMode",
                    "-AlphaTransitionHoldMs", "350",
                    "-ExpectedGameCaptureSha256", $ExpectedPublisherSha256,
                    "-ExpectedPluginSha256", $ExpectedPluginSha256,
                    "-ExpectedSpoutSenderSha256", $ExpectedSpoutSenderSha256
                )
                if ($outputWidth -gt 0) { $driverArgs += @("-OutputWidth", [string]$outputWidth) }
                if ($outputHeight -gt 0) { $driverArgs += @("-OutputHeight", [string]$outputHeight) }
                if ($outputFps -gt 0) { $driverArgs += @("-OutputFps", [string]$outputFps) }
                $oldPreference = $ErrorActionPreference
                try {
                    $ErrorActionPreference = "Continue"
                    $driverOutput = & powershell @driverArgs 2>&1
                    $driverExit = $LASTEXITCODE
                } finally {
                    $ErrorActionPreference = $oldPreference
                }
                $driverOutput | Set-Content -LiteralPath $caseLogPath -Encoding UTF8
                $case.driverExitCode = $driverExit
                $case.driverLog = Get-FileBinding $caseLogPath
                $summaryLine = @($driverOutput | ForEach-Object { [string]$_ } |
                    Where-Object { $_ -like "SUMMARY=*" }) | Select-Object -Last 1
                $summaryPath = if ($summaryLine) { $summaryLine.Substring("SUMMARY=".Length).Trim() } else { "" }
                if (-not $summaryPath -or -not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
                    throw "Driver did not emit a resolvable SUMMARY artifact (exit=$driverExit)"
                }
                $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
                $case.summary = Get-FileBinding $summaryPath
                $case.runDir = [string]$summary.runDir
                $case.sampling = $summary.alphaSampling
                $case.sequence = $summary.alphaPixelCheck.sequence
                $case.validatedTransitionClaims = $summary.validatedTransitionClaims
                $case.artifactIdentityContract = $summary.artifactIdentityContract
                $case.loadedPlugin = $summary.artifactBinding.loadedPlugin
                $case.loadedPluginModules = @($summary.artifactBinding.loadedPluginModules)
                $case.screenshots = @($summary.artifactBinding.screenshots)
                $case.evidence = @($summary.artifactBinding.evidence)

                $requiredGameCaptureArgs = @(
                    "--video-codec=$videoCodec",
                    "--alpha-workflow"
                )
                if ($outputWidth -gt 0) { $requiredGameCaptureArgs += "--width=$outputWidth" }
                if ($outputHeight -gt 0) { $requiredGameCaptureArgs += "--height=$outputHeight" }
                if ($outputFps -gt 0) { $requiredGameCaptureArgs += "--fps=$outputFps" }
                $missingGameCaptureArgs = @($requiredGameCaptureArgs | Where-Object {
                    @($summary.gameCaptureArgs) -notcontains $_
                })
                if ($missingGameCaptureArgs.Count -gt 0) {
                    throw "Driver did not execute the required packaged arguments: $($missingGameCaptureArgs -join ', ')"
                }

                if ($expectedAlphaWidth -gt 0 -or $expectedAlphaHeight -gt 0) {
                    $diagnosticsPath = [string]$summary.gameCaptureDiagnostics
                    if (-not $diagnosticsPath -or
                        -not (Test-Path -LiteralPath $diagnosticsPath -PathType Leaf)) {
                        throw "H.264 mismatched-alpha workflow did not produce Game Capture diagnostics"
                    }
                    $diagnostics = Get-Content -LiteralPath $diagnosticsPath -Raw | ConvertFrom-Json
                    $case.gameCaptureDiagnostics = Get-FileBinding $diagnosticsPath
                    $publisherLogText = @($summary.gameCaptureLogs | Where-Object {
                        Test-Path -LiteralPath ([string]$_) -PathType Leaf
                    } | ForEach-Object {
                        Get-Content -LiteralPath ([string]$_) -Raw
                    }) -join "`n"
                    $obsLogPath = [string]$summary.obsLog
                    $obsLogText = if ($obsLogPath -and
                        (Test-Path -LiteralPath $obsLogPath -PathType Leaf)) {
                        Get-Content -LiteralPath $obsLogPath -Raw
                    } else { "" }
                    $case.alphaEncoderDimensionsObserved = $publisherLogText -match (
                        "VP9 alpha encoder active:\s+\d+\s+kbps\s+" +
                        [regex]::Escape("${expectedAlphaWidth}x${expectedAlphaHeight}")
                    )
                    $case.receiverScaleObserved = $obsLogText -match (
                        "Scaled VP9 alpha frame[^\r\n]*from\s+" +
                        [regex]::Escape("${expectedAlphaWidth}x${expectedAlphaHeight}") +
                        "\s+to primary video\s+" +
                        [regex]::Escape("${outputWidth}x${outputHeight}")
                    )
                    if ([int]$diagnostics.video.configured_width -ne $outputWidth -or
                        [int]$diagnostics.video.configured_height -ne $outputHeight -or
                        [int]$diagnostics.video.configured_fps -ne $outputFps -or
                        [string]$diagnostics.video.configured_codec -ne "H264" -or
                        [string]$diagnostics.video.active_codec -ne "H264" -or
                        -not [bool]$diagnostics.video.alpha_enabled -or
                        [long]$diagnostics.video.alpha_packets_sent -le 0 -or
                        -not [bool]$case.alphaEncoderDimensionsObserved -or
                        -not [bool]$case.receiverScaleObserved -or
                        -not [bool]$summary.obsAlphaCompositionActive) {
                        throw "Packaged 1080p60 H.264 workflow did not prove 960x540 alpha encode, receiver scaling, advancing alpha, and visible OBS composition"
                    }
                }

                if ($driverExit -ne 0 -or -not [bool]$summary.ok -or
                    -not [bool]$summary.artifactIdentityContract.ok -or
                    -not [bool]$summary.alphaPixelCheck.sequence.ok -or
                    -not [bool]$summary.alphaPixelCheck.cadence.ok -or
                    -not [bool]$summary.fixturePostEpochObserved) {
                    throw "Driver, pixel sequence, or observed capture cadence failed"
                }
                if ([string]$summary.alphaPattern -ne $pattern -or
                    -not [bool]$summary.alphaSampling.transitionRequested -or
                    [string]$summary.alphaSampling.transitionMode -ne $transitionMode -or
                    [int]$summary.alphaPixelCheck.transition.settleMs -ne 0 -or
                    [int]$summary.alphaPixelCheck.transition.transitionSampleCount -lt 1 -or
                    -not [bool]$summary.alphaPixelCheck.transition.boundaryOrderingOk -or
                    -not [bool]$summary.alphaPixelCheck.transition.result.ok) {
                    throw "The required observed '$transitionMode' transition contract was not executed"
                }
                if ([int]$summary.alphaPixelCheck.cadence.firstCaptureLatencyMs -gt 100 -or
                    [int]$summary.alphaPixelCheck.cadence.maxCaptureStartGapMs -gt 100) {
                    throw "Observed screenshot-request start cadence exceeded 100ms"
                }
                $observed = $summary.validatedTransitionClaims.observedTransition
                if (-not [bool]$summary.validatedTransitionClaims.ok -or
                    -not [bool]$summary.validatedTransitionClaims.diagnosticsEvidencePresent -or
                    -not [bool]$summary.validatedTransitionClaims.oldTransportRetiredBeforeVisualEpochChange -or
                    -not [bool]$summary.validatedTransitionClaims.newTransportObservedBeforeFirstPostCapture -or
                    -not [bool]$summary.validatedTransitionClaims.exactTransitionActionBound -or
                    -not $observed -or -not [bool]$observed.ok) {
                    throw "Transition claims were not derived from complete Game Capture diagnostics evidence"
                }
                if ($transitionMode -in @("source-toggle", "source-recreate")) {
                    if ([int]$observed.before.publisherPid -ne [int]$observed.after.publisherPid -or
                        [string]$observed.before.peer.logicalKey -eq [string]$observed.after.peer.logicalKey) {
                        throw "Source lifecycle did not retire the old peer and connect a distinct uuid/session peer"
                    }
                } elseif ($transitionMode -eq "same-peer-ice-rebuild") {
                    if ([int]$observed.before.publisherPid -ne [int]$observed.after.publisherPid -or
                        [string]$observed.before.peer.logicalKey -ne [string]$observed.after.peer.logicalKey -or
                        [long]$observed.after.peer.clientTransportGeneration -le
                            [long]$observed.before.peer.clientTransportGeneration -or
                        [long]$observed.after.peer.activeTransportGeneration -le
                            [long]$observed.before.peer.activeTransportGeneration) {
                        throw "Same-peer workflow did not preserve logical identity on higher client/active generations"
                    }
                } elseif ($transitionMode -eq "publisher-restart") {
                    if ([int]$observed.before.publisherPid -eq [int]$observed.after.publisherPid -or
                        -not [bool]$summary.publisherRestart.result.ok -or
                        [int]$summary.publisherRestart.result.oldPublisher.pid -ne
                            [int]$observed.before.publisherPid -or
                        [int]$summary.publisherRestart.result.newPublisher.pid -ne
                            [int]$observed.after.publisherPid -or
                        [string]$summary.publisherRestart.result.oldDiscovery.sha256 -eq
                            [string]$summary.publisherRestart.result.newDiscovery.sha256) {
                        throw "Publisher restart workflow did not bind removal/new PID/discovery/peer evidence"
                    }
                }
                if ($pattern -eq "alpha-moving-edge" -and (
                    [int]$summary.alphaPixelCheck.sequence.pre.usefulSampleCount -lt 10 -or
                    [int]$summary.alphaPixelCheck.sequence.post.usefulSampleCount -lt 10 -or
                    [int]$summary.alphaPixelCheck.sequence.pre.uniqueCompositePixelCount -lt 10 -or
                    [int]$summary.alphaPixelCheck.sequence.post.uniqueCompositePixelCount -lt 10
                )) {
                    throw "Moving transition did not produce ten independently live useful frames before and after"
                }
                $loadedPluginEvidence = Test-AlphaLoadedPluginEvidence `
                    -LoadedModules @($summary.artifactBinding.loadedPluginModules) `
                    -LoadedPlugin $summary.artifactBinding.loadedPlugin `
                    -StagedPlugin $summary.artifactBinding.stagedPlugin `
                    -ExpectedSha256 $ExpectedPluginSha256
                $packagedArtifactEvidence = Test-AlphaPackagedArtifactEvidence `
                    -Publisher $summary.artifactBinding.gameCapture `
                    -SpoutSender $summary.artifactBinding.spoutSender `
                    -ExpectedPublisherSha256 $ExpectedPublisherSha256 `
                    -ExpectedSpoutSenderSha256 $ExpectedSpoutSenderSha256
                if (-not $loadedPluginEvidence.ok -or -not $packagedArtifactEvidence.ok) {
                    throw "Child report artifact identities do not match the supplied fresh hashes"
                }
                $case.status = "passed"
                $case.ok = $true
            } catch {
                $case.status = "failed"
                $case.ok = $false
                $case.failure = $_.Exception.Message
                if (-not $case.driverLog -and (Test-Path -LiteralPath $caseLogPath -PathType Leaf)) {
                    $case.driverLog = Get-FileBinding $caseLogPath
                }
            }
        }
    } finally {
        Pop-Location
    }
} catch {
    $manifest.fatalError = $_.Exception.Message
} finally {
    $finalPublisher = Get-FileBinding $PublisherPath -Optional
    $finalSender = Get-FileBinding $SpoutSenderPath -Optional
    $finalPlugin = Get-FileBinding (Join-Path $PluginRepo "install\obs-plugins\64bit\obs-vdoninja.dll") -Optional
    $manifest.finalArtifactBinding = [ordered]@{
        gameCapture = $finalPublisher
        spoutSender = $finalSender
        stagedPlugin = $finalPlugin
    }
    $manifest.artifactHashesStable = (
        $finalPublisher -and $finalPublisher.sha256 -eq $ExpectedPublisherSha256 -and
        $finalSender -and $finalSender.sha256 -eq $ExpectedSpoutSenderSha256 -and
        $finalPlugin -and $finalPlugin.sha256 -eq $ExpectedPluginSha256
    )
    $manifest.completedAt = (Get-Date).ToUniversalTime().ToString("o")
    $manifest.ok = (
        [bool]$manifest.analyzerGate.ok -and
        [bool]$manifest.artifactBindingGate.ok -and
        [bool]$manifest.artifactHashesStable -and
        @($caseResults | Where-Object { -not $_.ok }).Count -eq 0 -and
        $caseResults.Count -eq $requiredWorkflowCases.Count -and
        -not $manifest.fatalError
    )
    $manifest.cases = $caseResults
    $manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}

Write-Host "[PLUGIN-ALPHA-E2E] MANIFEST=$manifestPath"
if (-not $manifest.ok) {
    throw "Transparency workflow manifest is not acceptable; inspect $manifestPath"
}
Write-Host "[PLUGIN-ALPHA-E2E] PASS"
