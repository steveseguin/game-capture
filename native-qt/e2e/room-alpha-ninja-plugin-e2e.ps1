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
    [int]$GameCaptureDurationMs = 240000,
    [int]$AlphaReceiverProbeTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($PluginRepo)) {
    throw "PluginRepo is required."
}
$PluginRepo = [System.IO.Path]::GetFullPath($PluginRepo)
$nativeQtRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$driver = Join-Path $PluginRepo "scripts\run-vdoninja-gamecapture-spout-smoke.ps1"
$sourceSmoke = Join-Path $PluginRepo "scripts\run-vdoninja-source-smoke.ps1"
$sourceChecker = Join-Path $PluginRepo "scripts\obs-websocket-vdoninja-source-check.cjs"
$analyzerRegression = Join-Path $PSScriptRoot "alpha-composite-analyzer-regression.js"
$receiverProbe = Join-Path $PSScriptRoot "room-alpha-receiver-probe.js"
$harnessContracts = Join-Path $PluginRepo "scripts\alpha-harness-contracts.ps1"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$idSuffix = Get-Date -Format "yyyyMMddHHmmss"
if ([string]::IsNullOrWhiteSpace($ReportDir)) {
    $reportDir = Join-Path $PSScriptRoot "reports\phase3-room-alpha-$stamp"
} else {
    $reportDir = [System.IO.Path]::GetFullPath($ReportDir)
}
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$manifestPath = Join-Path $reportDir "manifest.json"

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

function Get-LiteralOccurrenceCount {
    param([string]$Text, [string]$Needle)

    if ([string]::IsNullOrEmpty($Needle)) { return 0 }
    return [regex]::Matches([string]$Text, [regex]::Escape($Needle)).Count
}

$cases = @(
    [ordered]@{
        name = "direct-control"
        pattern = "alpha-checker"
        status = "unexecuted"
        ok = $false
        failure = $null
        exitCode = $null
        summary = $null
        driverLog = $null
        loadedPlugin = $null
        loadedPluginModules = @()
        validatedTransitionClaims = $null
        artifactIdentityContract = $null
        roomQualityContract = $null
    },
    [ordered]@{
        name = "room-quality"
        pattern = "alpha-moving-edge"
        status = "unexecuted"
        ok = $false
        failure = $null
        exitCode = $null
        summary = $null
        driverLog = $null
        loadedPlugin = $null
        loadedPluginModules = @()
        validatedTransitionClaims = $null
        artifactIdentityContract = $null
        roomQualityContract = $null
    }
)
$manifest = [ordered]@{
    schemaVersion = 2
    ok = $false
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    completedAt = $null
    fatalError = $null
    expectedArtifactHashes = [ordered]@{
        gameCapture = $ExpectedPublisherSha256
        plugin = $ExpectedPluginSha256
        spoutSender = $ExpectedSpoutSenderSha256
    }
    artifactBinding = $null
    finalArtifactBinding = $null
    artifactHashesStable = $false
    transitionContract = [ordered]@{
        mode = "source-toggle"
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
    analyzerGate = [ordered]@{
        status = "unexecuted"
        ok = $false
        exitCode = $null
        log = $null
    }
    cases = $cases
}

try {
    $ExpectedPublisherSha256 = Normalize-Sha256 $ExpectedPublisherSha256 "ExpectedPublisherSha256"
    $ExpectedPluginSha256 = Normalize-Sha256 $ExpectedPluginSha256 "ExpectedPluginSha256"
    $ExpectedSpoutSenderSha256 = Normalize-Sha256 $ExpectedSpoutSenderSha256 "ExpectedSpoutSenderSha256"
    $manifest.expectedArtifactHashes.gameCapture = $ExpectedPublisherSha256
    $manifest.expectedArtifactHashes.plugin = $ExpectedPluginSha256
    $manifest.expectedArtifactHashes.spoutSender = $ExpectedSpoutSenderSha256

    foreach ($requiredPath in @(
        $driver,
        $sourceSmoke,
        $sourceChecker,
        $analyzerRegression,
        $receiverProbe,
        $harnessContracts
    )) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required room-alpha E2E component was not found: $requiredPath"
        }
    }
    . $harnessContracts
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
    $senderBinding = Get-FileBinding $SpoutSenderPath
    $portableObsBinding = Get-FileBinding (Join-Path $PluginRepo "_obs-portable\bin\64bit\obs64.exe")
    $pluginPayloadBinding = Get-FileBinding (Join-Path $PluginRepo "install\obs-plugins\64bit\obs-vdoninja.dll")
    if ($publisherBinding.sha256 -ne $ExpectedPublisherSha256 -or
        $senderBinding.sha256 -ne $ExpectedSpoutSenderSha256 -or
        $pluginPayloadBinding.sha256 -ne $ExpectedPluginSha256) {
        throw "Publisher, fixture, or plugin payload did not match the explicitly supplied fresh SHA256"
    }
    $PublisherPath = $publisherBinding.path
    $SpoutSenderPath = $senderBinding.path
    $manifest.artifactBinding = [ordered]@{
        gameCapture = $publisherBinding
        spoutSender = $senderBinding
        portableObs = $portableObsBinding
        stagedPlugin = $pluginPayloadBinding
        wrapper = Get-FileBinding $MyInvocation.MyCommand.Path
        analyzerRegression = Get-FileBinding $analyzerRegression
        receiverProbe = Get-FileBinding $receiverProbe
        driver = Get-FileBinding $driver
        sourceSmoke = Get-FileBinding $sourceSmoke
        sourceChecker = Get-FileBinding $sourceChecker
        harnessContracts = Get-FileBinding $harnessContracts
    }

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
        throw "Alpha analyzer deterministic gate failed; room workflows were not started"
    }

    function Invoke-RoomAlphaCase {
        param(
            [System.Collections.Specialized.OrderedDictionary]$Case,
            [string]$StreamId,
            [string]$RoomId,
            [switch]$RequestRoomQuality
        )

        $Case.status = "running"
        $caseArgs = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $driver,
            "-StreamId", $StreamId,
            "-GameCaptureExe", $PublisherPath,
            "-UseTestSpoutSender",
            "-TestSpoutSenderExe", $SpoutSenderPath,
            "-TestSpoutSenderName", "RoomAlphaE2E-$($Case.name)-$idSuffix",
            "-TestSpoutPattern", $Case.pattern,
            "-VideoCodec", "vp9",
            "-GameCaptureDurationMs", [string]$GameCaptureDurationMs,
            "-GameCaptureWarmupSeconds", [string]$GameCaptureWarmupSeconds,
            "-CheckTimeoutSeconds", [string]$CheckTimeoutSeconds,
            "-AlphaBackgroundColor", "4278190335",
            "-AlphaReceiverProbePath", $receiverProbe,
            "-AlphaReceiverProbeTimeoutSeconds", [string]$AlphaReceiverProbeTimeoutSeconds,
            "-AlphaSampleIntervalMs", "75",
            "-AlphaTransitionMode", "source-toggle",
            "-AlphaTransitionLabel", "obs-source-lifecycle",
            "-AlphaTransitionHoldMs", "350",
            "-ExpectedGameCaptureSha256", $ExpectedPublisherSha256,
            "-ExpectedPluginSha256", $ExpectedPluginSha256,
            "-ExpectedSpoutSenderSha256", $ExpectedSpoutSenderSha256
        )
        if ($RoomId) { $caseArgs += @("-RoomId", $RoomId) }
        if ($RequestRoomQuality) { $caseArgs += "-RequestRoomQuality" }
        $driverLogPath = Join-Path $reportDir "$($Case.name)-driver.log"
        try {
            Push-Location $PluginRepo
            $oldPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                $output = & powershell @caseArgs 2>&1
                $exitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $oldPreference
                Pop-Location
            }
            $output | Set-Content -LiteralPath $driverLogPath -Encoding UTF8
            $Case.exitCode = $exitCode
            $Case.driverLog = Get-FileBinding $driverLogPath
            $summaryLine = @($output | ForEach-Object { [string]$_ } |
                Where-Object { $_ -like "SUMMARY=*" }) | Select-Object -Last 1
            $summaryPath = if ($summaryLine) { $summaryLine.Substring("SUMMARY=".Length).Trim() } else { "" }
            if (-not $summaryPath -or -not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
                throw "Driver did not emit a resolvable summary (exit=$exitCode)"
            }
            $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
            $Case.summary = Get-FileBinding $summaryPath
            $Case.loadedPlugin = $summary.artifactBinding.loadedPlugin
            $Case.loadedPluginModules = @($summary.artifactBinding.loadedPluginModules)
            $Case.validatedTransitionClaims = $summary.validatedTransitionClaims
            $Case.artifactIdentityContract = $summary.artifactIdentityContract
            $Case.runDir = [string]$summary.runDir
            $Case.harnessOk = [bool]$summary.harnessOk
            $Case.productOk = [bool]$summary.productOk
            $Case.failureClass = [string]$summary.failureClass
            $Case.sampling = $summary.alphaSampling
            $Case.sequence = $summary.alphaPixelCheck.sequence
            $Case.screenshots = @($summary.artifactBinding.screenshots)
            $Case.evidence = @($summary.artifactBinding.evidence)

            $publisherLogPaths = @($summary.gameCaptureLogs | Where-Object {
                $_ -and (Test-Path -LiteralPath ([string]$_) -PathType Leaf)
            })
            if ($publisherLogPaths.Count -eq 0 -and
                $summary.gameCaptureLog -and
                (Test-Path -LiteralPath ([string]$summary.gameCaptureLog) -PathType Leaf)) {
                $publisherLogPaths = @([string]$summary.gameCaptureLog)
            }
            $publisherLogText = (@($publisherLogPaths | ForEach-Object {
                Get-Content -LiteralPath ([string]$_) -Raw
            }) -join "`n")
            $expectedWarning =
                "Room Quality is unavailable with VP9; continuing HQ-only without changing the selected codec or alpha workflow."
            $exactWarningCount = Get-LiteralOccurrenceCount $publisherLogText $expectedWarning
            $allUnavailableWarningCount = [regex]::Matches(
                $publisherLogText,
                "Room Quality is unavailable with [^;\r\n]+; continuing HQ-only without changing the selected codec or alpha workflow\."
            ).Count
            $expectedWarningCount = if ($RequestRoomQuality) { 1 } else { 0 }
            $expectedReason = if ($RequestRoomQuality) { "codec-not-h264" } else { "not-in-room" }
            $diagnostics = if ($summary.gameCaptureDiagnostics -and
                (Test-Path -LiteralPath ([string]$summary.gameCaptureDiagnostics) -PathType Leaf)) {
                Get-Content -LiteralPath ([string]$summary.gameCaptureDiagnostics) -Raw | ConvertFrom-Json
            } else {
                $null
            }
            $receiverAssertions = $summary.alphaReceiverProbe.report.assertions
            $lqEncoderActiveLogged = $publisherLogText -match "LQ encoder active"
            $lqEncoderInitializedProperty = if ($diagnostics -and $diagnostics.video) {
                $diagnostics.video.PSObject.Properties["lq_encoder_initialized"]
            } else {
                $null
            }
            $lqEncoderInitializedIsBoolean = $null -ne $lqEncoderInitializedProperty -and
                $lqEncoderInitializedProperty.Value -is [bool]
            $lqEncoderInitializedValue = if ($null -ne $lqEncoderInitializedProperty) {
                $lqEncoderInitializedProperty.Value
            } else {
                $null
            }
            $Case.roomQualityContract = [ordered]@{
                requested = if ($diagnostics -and $diagnostics.room_quality) {
                    $diagnostics.room_quality.requested
                } else { $null }
                effective = if ($diagnostics -and $diagnostics.room_quality) {
                    $diagnostics.room_quality.effective
                } else { $null }
                reason = if ($diagnostics -and $diagnostics.room_quality) {
                    $diagnostics.room_quality.reason
                } else { $null }
                expectedReason = $expectedReason
                expectedWarning = $expectedWarning
                expectedWarningCount = $expectedWarningCount
                exactWarningCount = $exactWarningCount
                allUnavailableWarningCount = $allUnavailableWarningCount
                receiverRequested = if ($receiverAssertions) {
                    $receiverAssertions.roomQualityRequested
                } else { $null }
                receiverContext = if ($receiverAssertions) {
                    $receiverAssertions.roomQualityDiagnosticsMatchContext
                } else { $null }
                configuredCodec = if ($diagnostics -and $diagnostics.video) {
                    $diagnostics.video.configured_codec
                } else { $null }
                activeCodec = if ($diagnostics -and $diagnostics.video) {
                    $diagnostics.video.active_codec
                } else { $null }
                alphaEnabled = if ($diagnostics -and $diagnostics.video) {
                    $diagnostics.video.alpha_enabled
                } else { $null }
                publisherLqEncoderActive = $lqEncoderActiveLogged
                diagnosticsLqEncoderInitializedPresent = ($null -ne $lqEncoderInitializedProperty)
                diagnosticsLqEncoderInitializedIsBoolean = $lqEncoderInitializedIsBoolean
                diagnosticsLqEncoderInitialized = $lqEncoderInitializedValue
            }
            if (-not $diagnostics -or -not $diagnostics.room_quality -or
                -not [bool]$diagnostics.room_quality.requested -or
                [bool]$diagnostics.room_quality.effective -or
                [string]$diagnostics.room_quality.reason -ne $expectedReason -or
                $exactWarningCount -ne $expectedWarningCount -or
                $allUnavailableWarningCount -ne $expectedWarningCount -or
                -not $receiverAssertions -or
                -not [bool]$receiverAssertions.roomQualityRequested -or
                -not [bool]$receiverAssertions.roomQualityDiagnosticsMatchContext -or
                -not [bool]$receiverAssertions.selectedCodecAuthorityVp9 -or
                -not [bool]$receiverAssertions.alphaCapabilityAcknowledged -or
                -not [bool]$summary.alphaWorkflow -or
                @($summary.gameCaptureArgs) -notcontains "--video-codec=vp9" -or
                @($summary.gameCaptureArgs) -notcontains "--alpha-workflow" -or
                [string]$diagnostics.video.configured_codec -ne "VP9" -or
                [string]$diagnostics.video.active_codec -ne "VP9" -or
                -not [bool]$diagnostics.video.alpha_enabled -or
                $lqEncoderActiveLogged -or
                -not $lqEncoderInitializedIsBoolean -or
                [bool]$lqEncoderInitializedValue) {
                throw "Packaged VP9 alpha Room Quality diagnostics or exact warning-count contract failed"
            }
            if ($RequestRoomQuality -and (
                [string]$summary.roomAlphaAssertions.expectedHqOnlyRuntimeExplanation -ne $expectedWarning -or
                -not [bool]$summary.roomAlphaAssertions.hqOnlyRuntimeExplanationLogged
            )) {
                throw "Packaged VP9 alpha workflow did not retain the required verbatim Room Quality explanation"
            }
            if ($exitCode -ne 0 -or -not [bool]$summary.ok -or
                -not [bool]$summary.artifactIdentityContract.ok -or
                -not [bool]$summary.harnessOk -or -not [bool]$summary.productOk -or
                -not [bool]$summary.alphaPixelCheck.cadence.ok -or
                -not [bool]$summary.alphaPixelCheck.sequence.ok -or
                -not [bool]$summary.alphaPixelCheck.transition.result.ok -or
                -not [bool]$summary.validatedTransitionClaims.ok -or
                -not [bool]$summary.fixturePostEpochObserved) {
                throw "Room-alpha driver, product, cadence, sequence, or real transition contract failed"
            }
            if ([string]$summary.alphaSampling.transitionMode -ne "source-toggle" -or
                [int]$summary.alphaPixelCheck.transition.settleMs -ne 0 -or
                [int]$summary.alphaPixelCheck.transition.transitionSampleCount -lt 1 -or
                -not [bool]$summary.alphaPixelCheck.transition.boundaryOrderingOk -or
                [int]$summary.alphaPixelCheck.cadence.firstCaptureLatencyMs -gt 100 -or
                [int]$summary.alphaPixelCheck.cadence.maxCaptureStartGapMs -gt 100) {
                throw "Immediate continuous source-toggle capture contract was not met"
            }
            $observed = $summary.validatedTransitionClaims.observedTransition
            if (-not $observed -or -not [bool]$observed.ok -or
                [int]$observed.before.publisherPid -ne [int]$observed.after.publisherPid -or
                [string]$observed.before.peer.logicalKey -eq [string]$observed.after.peer.logicalKey -or
                -not [bool]$summary.validatedTransitionClaims.oldTransportRetiredBeforeVisualEpochChange -or
                -not [bool]$summary.validatedTransitionClaims.newTransportObservedBeforeFirstPostCapture) {
                throw "Room source lifecycle claims were not proven by distinct diagnostics peer evidence"
            }
            if ($Case.pattern -eq "alpha-moving-edge" -and (
                [int]$summary.alphaPixelCheck.sequence.pre.usefulSampleCount -lt 10 -or
                [int]$summary.alphaPixelCheck.sequence.post.usefulSampleCount -lt 10 -or
                [int]$summary.alphaPixelCheck.sequence.pre.uniqueCompositePixelCount -lt 10 -or
                [int]$summary.alphaPixelCheck.sequence.post.uniqueCompositePixelCount -lt 10
            )) {
                throw "Room moving fixture lacked ten independently live useful frames in each epoch"
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
                throw "Child report artifact identities differ from the supplied fresh hashes"
            }
            $Case.ok = $true
            $Case.status = "passed"
        } catch {
            $Case.ok = $false
            $Case.status = "failed"
            $Case.failure = $_.Exception.Message
            if (-not $Case.driverLog -and (Test-Path -LiteralPath $driverLogPath -PathType Leaf)) {
                $Case.driverLog = Get-FileBinding $driverLogPath
            }
        }
    }

    Invoke-RoomAlphaCase -Case $cases[0] -StreamId "roomAlphaDirect$idSuffix" -RoomId ""
    Invoke-RoomAlphaCase -Case $cases[1] -StreamId "roomAlphaRoom$idSuffix" `
        -RoomId "roomAlpha$idSuffix" -RequestRoomQuality
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
        [bool]$manifest.artifactHashesStable -and
        @($cases | Where-Object { -not $_.ok }).Count -eq 0 -and
        $cases.Count -eq 2 -and
        -not $manifest.fatalError
    )
    $manifest.cases = $cases
    $manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}

Write-Host "[ROOM-ALPHA-E2E] MANIFEST=$manifestPath"
if (-not $manifest.ok) {
    throw "Room-alpha workflow manifest is not acceptable; inspect $manifestPath"
}
Write-Host "[ROOM-ALPHA-E2E] PASS"
