[CmdletBinding()]
param(
    [switch]$BaselineOnly,
    [switch]$ValidateMutationSourcesOnly,
    [switch]$ValidatePublicationSuppression,
    [string]$MutationPattern = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$policy = Join-Path $PSScriptRoot 'release-gate-wiring-regression.ps1'
if (-not (Test-Path -LiteralPath $policy -PathType Leaf)) {
    throw "Release-wiring policy was not found: $policy"
}
$aliasIdentityPolicy = Join-Path $PSScriptRoot 'release-artifact-alias-identity-regression.ps1'
if (-not (Test-Path -LiteralPath $aliasIdentityPolicy -PathType Leaf)) {
    throw "Release artifact alias-identity policy was not found: $aliasIdentityPolicy"
}

$mutationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('game-capture-release-wiring-mutations-' + [guid]::NewGuid().ToString('N'))
$resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$resolvedMutationRoot = [System.IO.Path]::GetFullPath($mutationRoot)
if (-not $resolvedMutationRoot.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or
    $resolvedMutationRoot -eq $resolvedTemp) {
    throw 'Refusing to create mutation fixture outside the system temporary directory.'
}

function Write-FixtureFile {
    param([string]$Root, [string]$RelativePath, [string]$Content)

    $path = Join-Path $Root $RelativePath
    $parent = Split-Path -Parent $path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Set-Content -LiteralPath $path -Value $Content -Encoding UTF8
}

function Replace-ExactlyOnce {
    param([string]$Root, [string]$RelativePath, [string]$Before, [string]$After)

    $path = Join-Path $Root $RelativePath
    $content = Get-Content -LiteralPath $path -Raw
    $first = $content.IndexOf($Before, [System.StringComparison]::Ordinal)
    if ($first -lt 0 -or $content.IndexOf($Before, $first + $Before.Length, [System.StringComparison]::Ordinal) -ge 0) {
        throw "Mutation source must occur exactly once: $RelativePath :: $Before"
    }
    $mutated = $content.Substring(0, $first) + $After + $content.Substring($first + $Before.Length)
    Set-Content -LiteralPath $path -Value $mutated -Encoding UTF8
}

function ConvertFrom-PolicyOutputWithTerminalEvidence {
    param(
        [object[]]$Output,
        [string]$TerminalNonce
    )

    if (@($Output).Count -eq 0) {
        throw 'Policy process was silent and emitted no terminal evidence.'
    }
    try {
        $result = (@($Output) -join "`n") | ConvertFrom-Json
    } catch {
        throw "Policy did not return JSON with terminal evidence: $(@($Output) -join ' | ')"
    }
    if (-not $result.PSObject.Properties['terminalEvidence'] -or
        -not $result.terminalEvidence -or
        [string]$result.terminalEvidence.state -cne 'complete' -or
        [string]$result.terminalEvidence.nonce -cne $TerminalNonce -or
        [int]$result.terminalEvidence.checkCount -ne @($result.checks).Count -or
        [int]$result.terminalEvidence.failedCount -ne
            @($result.checks | Where-Object { -not [bool]$_.ok }).Count) {
        throw "Policy output lacked exact terminal evidence for nonce $TerminalNonce."
    }
    return $result
}

function Test-TerminalEvidenceInstrument {
    $nonce = 'terminal-evidence-self-test'
    $valid = [pscustomobject]@{
        ok = $true
        checks = @([pscustomobject]@{ id = 'SELF_TEST'; ok = $true })
        summary = [pscustomobject]@{ total = 1; passed = 1; failed = 0 }
        terminalEvidence = [pscustomobject]@{
            state = 'complete'
            nonce = $nonce
            checkCount = 1
            failedCount = 0
        }
    } | ConvertTo-Json -Depth 6
    [void](ConvertFrom-PolicyOutputWithTerminalEvidence @($valid) $nonce)

    $earlySuccessWithoutTerminal = [pscustomobject]@{
        ok = $true
        checks = @()
        summary = [pscustomobject]@{ total = 0; passed = 0; failed = 0 }
    } | ConvertTo-Json -Depth 6
    $wrongNonceObject = $valid | ConvertFrom-Json
    $wrongNonceObject.terminalEvidence.nonce = 'wrong-terminal-nonce'
    $wrongNonce = $wrongNonceObject | ConvertTo-Json -Depth 6
    $wrongCountObject = $valid | ConvertFrom-Json
    $wrongCountObject.terminalEvidence.checkCount = 2
    $wrongCount = $wrongCountObject | ConvertTo-Json -Depth 6
    $invalidCases = @(
        [pscustomobject]@{ name = 'silent-process'; output = @() },
        [pscustomobject]@{ name = 'early-success-without-terminal'; output = @($earlySuccessWithoutTerminal) },
        [pscustomobject]@{ name = 'wrong-terminal-nonce'; output = @($wrongNonce) },
        [pscustomobject]@{ name = 'wrong-terminal-count'; output = @($wrongCount) }
    )
    foreach ($case in $invalidCases) {
        $rejected = $false
        try {
            [void](ConvertFrom-PolicyOutputWithTerminalEvidence $case.output $nonce)
        } catch {
            $rejected = $true
        }
        if (-not $rejected) {
            throw "Terminal-evidence instrument accepted invalid case: $($case.name)"
        }
    }
    Write-Host '[TERMINAL EVIDENCE SELF-TEST] valid=accepted invalid=4/4-rejected'
}

function Invoke-PolicyFixture {
    param([string]$Root)

    $terminalNonce = [guid]::NewGuid().ToString('N')
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $policy `
            -RepositoryRoot $Root -Json -TerminalEvidenceNonce $terminalNonce 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    $result = ConvertFrom-PolicyOutputWithTerminalEvidence $output $terminalNonce
    return [pscustomobject]@{ exitCode = $exitCode; result = $result }
}

function Get-FailedIds {
    param([object]$Result)
    return @($Result.checks | Where-Object { -not [bool]$_.ok } | ForEach-Object { [string]$_.id } | Sort-Object)
}

function Invoke-AliasIdentityFixture {
    param([string]$DistDir, [string]$Version, [switch]$AllowMissingFfmpeg)

    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $aliasIdentityPolicy,
        '-DistDir', $DistDir,
        '-Version', $Version
    )
    if ($AllowMissingFfmpeg) { $arguments += '-AllowMissingFfmpeg' }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& powershell.exe @arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ exitCode = $exitCode; output = @($output) }
}

function Assert-ExactFailures {
    param([string]$Name, [string[]]$Actual, [string[]]$Expected)

    $actualSorted = @($Actual | Sort-Object -Unique)
    $expectedSorted = @($Expected | Sort-Object -Unique)
    $difference = @(Compare-Object -ReferenceObject $expectedSorted -DifferenceObject $actualSorted)
    if ($difference.Count -gt 0) {
        throw "Mutation '$Name' changed the wrong checks. Expected=[$($expectedSorted -join ',')] Actual=[$($actualSorted -join ',')]"
    }
    Write-Host ("[MUTATION PASS] {0}: {1}" -f $Name, ($actualSorted -join ','))
}

try {
    Test-TerminalEvidenceInstrument
    $base = Join-Path $mutationRoot 'base'
    New-Item -ItemType Directory -Path $base -Force | Out-Null

    $aliasFixtureVersion = '1.2.3'
    $optionalAliasFixture = Join-Path $mutationRoot 'alias-optional-absent'
    New-Item -ItemType Directory -Path $optionalAliasFixture -Force | Out-Null
    foreach ($name in @(
        "game-capture-$aliasFixtureVersion-setup.exe", 'game-capture-setup.exe',
        "game-capture-$aliasFixtureVersion-portable.exe", 'game-capture-portable.exe',
        "game-capture-$aliasFixtureVersion-win64.zip", 'game-capture-win64.zip'
    )) {
        Set-Content -LiteralPath (Join-Path $optionalAliasFixture $name) -Value 'same-bytes' -NoNewline
    }
    $optionalAbsentRun = Invoke-AliasIdentityFixture $optionalAliasFixture $aliasFixtureVersion -AllowMissingFfmpeg
    if ($optionalAbsentRun.exitCode -ne 0) {
        throw "Optional-FFmpeg absent fixture should pass: $($optionalAbsentRun.output -join ' | ')"
    }
    Write-Host '[ALIAS FIXTURE] optional-ffmpeg-absent PASS'

    $wrongTypeAliasFixture = Join-Path $mutationRoot 'alias-optional-wrong-type'
    Copy-Item -LiteralPath $optionalAliasFixture -Destination $wrongTypeAliasFixture -Recurse
    New-Item -ItemType Directory -Path (Join-Path $wrongTypeAliasFixture "game-capture-$aliasFixtureVersion-ffmpeg-source-info.zip") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $wrongTypeAliasFixture 'game-capture-ffmpeg-source-info.zip') -Force | Out-Null
    $wrongTypeRun = Invoke-AliasIdentityFixture $wrongTypeAliasFixture $aliasFixtureVersion -AllowMissingFfmpeg
    if ($wrongTypeRun.exitCode -eq 0 -or ($wrongTypeRun.output -join "`n") -notmatch '(?i)ffmpeg-source-info.*FAIL|FAIL.*ffmpeg-source-info') {
        throw "Optional-FFmpeg wrong-type fixture was not rejected specifically: $($wrongTypeRun.output -join ' | ')"
    }
    Write-Host '[ALIAS FIXTURE] optional-ffmpeg-wrong-type REJECTED'

    Write-FixtureFile $base 'native-qt/package.json' @'
{
  "scripts": {
    "gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",
    "e2e:signaling-regressions:edge": "node e2e/signaling-regressions-e2e.js --browser=edge",
    "e2e:signaling-regressions:firefox": "node e2e/signaling-regressions-e2e.js --browser=firefox",
    "e2e:control-center:edge": "node e2e/director-room-e2e.js --browser=edge --strict-negotiation",
    "e2e:control-center:firefox": "node e2e/director-room-e2e.js --browser=firefox --strict-negotiation",
    "gate:alpha-workflow-manifests": "powershell -File e2e/alpha-workflow-manifest-regression.ps1",
    "gate:alpha-artifact-bindings": "powershell -File e2e/alpha-artifact-binding-regression.ps1",
    "gate:alpha-composite-analyzer": "node e2e/alpha-composite-analyzer-regression.js",
    "e2e:room-alpha-ninja-plugin": "powershell -File e2e/room-alpha-ninja-plugin-e2e.ps1",
    "e2e:ninja-plugin-alpha": "powershell -File e2e/ninja-plugin-alpha-e2e.ps1",
    "gate:release-wiring": "powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-gate-wiring-policy-mutations.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-gate-wiring-regression.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-readiness-runtime-regression.ps1"
  }
}
'@

    Write-FixtureFile $base 'native-qt/qa/run-release-readiness.ps1' @'
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$PublisherPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ArtifactManifestPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ArtifactManifestSha256,
    [string]$RoomAlphaPluginRepo = '',
    [string]$RoomAlphaPublisherPath = '',
    [string]$RoomAlphaSpoutSenderPath = '',
    [switch]$SkipRoomAlpha = $false
)
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
        if ($global:LASTEXITCODE -ne 0) { throw 'command failed' }
        return $true
    } catch {
        [System.Console]::Error.WriteLine("FAILED: {0}", $name)
        [System.Console]::Error.WriteLine([string]$_)
        return $false
    }
}
function Resolve-PackagedPublisherExecutable([string]$ExplicitPath) {
    if ([string]::IsNullOrWhiteSpace($ExplicitPath)) { throw 'Explicit packaged publisher is required.' }
    return (Resolve-Path -LiteralPath $ExplicitPath).Path
}
function Resolve-RoomAlphaSpoutSender([string]$ExplicitPath) {
    if ([string]::IsNullOrWhiteSpace($ExplicitPath)) { throw 'Explicit Spout sender is required.' }
    return (Resolve-Path -LiteralPath $ExplicitPath).Path
}
$allPass = $true
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
if (-not [System.IO.Directory]::Exists($script:repoRoot)) { throw 'Resolved repository root does not exist.' }
if (-not [System.IO.File]::Exists($script:npmExecutable)) { throw 'Resolved npm.cmd application does not exist.' }
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
$packagedPublisher = Resolve-PackagedPublisherExecutable $RoomAlphaPublisherPath
$roomAlphaSender = Resolve-RoomAlphaSpoutSender $RoomAlphaSpoutSenderPath
$publisherHash = (Get-FileHash $packagedPublisher).Hash
$pluginHash = (Get-FileHash (Join-Path $RoomAlphaPluginRepo 'install/obs-vdoninja.dll')).Hash
$senderHash = (Get-FileHash $roomAlphaSender).Hash
$signalFixtureGateArgs = @('--prefix', $script:repoRoot, 'run', 'gate:signaling-media-fixture')
& $script:npmExecutable @signalFixtureGateArgs
$signalFixtureGateExit = $LASTEXITCODE
if ($signalFixtureGateExit -ne 0) {
    exit $signalFixtureGateExit
}
$signalEdgePass = & $script:runStepImplementation 'Signal Edge' {
    $signalEdgeArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:edge', '--', "--publisher-path=$script:publisherExe", "--artifact-manifest-path=$script:artifactManifestPathBinding", "--artifact-manifest-sha256=$script:artifactManifestSha256Binding")
    & $script:npmExecutable @signalEdgeArgs
}
$allPass = $allPass -and $signalEdgePass
$signalFirefoxPass = & $script:runStepImplementation 'Signal Firefox' {
    $signalFirefoxArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:firefox', '--', "--publisher-path=$script:publisherExe", "--artifact-manifest-path=$script:artifactManifestPathBinding", "--artifact-manifest-sha256=$script:artifactManifestSha256Binding")
    & $script:npmExecutable @signalFirefoxArgs
}
$allPass = $allPass -and $signalFirefoxPass
$controlEdgePass = & $script:runStepImplementation 'Control Edge' {
    $controlEdgeArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:control-center:edge', '--', '--publisher-path', $script:publisherExe)
    & $script:npmExecutable @controlEdgeArgs
}
$allPass = $allPass -and $controlEdgePass
$controlFirefoxPass = & $script:runStepImplementation 'Control Firefox' {
    $controlFirefoxArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:control-center:firefox', '--', '--publisher-path', $script:publisherExe)
    & $script:npmExecutable @controlFirefoxArgs
}
$allPass = $allPass -and $controlFirefoxPass
$manifestPass = & $script:runStepImplementation 'Manifest' {
    $manifestArgs = @('--prefix', $script:repoRoot, 'run', 'gate:alpha-workflow-manifests', '--', '-PluginRepo', $RoomAlphaPluginRepo)
    & $script:npmExecutable @manifestArgs
}
$allPass = $allPass -and $manifestPass
$artifactPass = & $script:runStepImplementation 'Artifact' {
    $artifactArgs = @('--prefix', $script:repoRoot, 'run', 'gate:alpha-artifact-bindings', '--', '-PluginRepo', $RoomAlphaPluginRepo)
    & $script:npmExecutable @artifactArgs
}
$allPass = $allPass -and $artifactPass
$analyzerPass = & $script:runStepImplementation 'Analyzer' {
    $analyzerArgs = @('--prefix', $script:repoRoot, 'run', 'gate:alpha-composite-analyzer', '--', '--plugin-repo', $RoomAlphaPluginRepo)
    & $script:npmExecutable @analyzerArgs
}
$allPass = $allPass -and $analyzerPass
if (-not $SkipRoomAlpha) {
    $roomAlphaPass = & $script:runStepImplementation 'Room Alpha' {
        $roomAlphaArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:room-alpha-ninja-plugin', '--', '-PluginRepo', $RoomAlphaPluginRepo, '-PublisherPath', $packagedPublisher, '-SpoutSenderPath', $roomAlphaSender, '-ExpectedPublisherSha256', $publisherHash, '-ExpectedPluginSha256', $pluginHash, '-ExpectedSpoutSenderSha256', $senderHash)
        & $script:npmExecutable @roomAlphaArgs
    }
    $allPass = $allPass -and $roomAlphaPass
    $fullAlphaPass = & $script:runStepImplementation 'Full Alpha' {
        $fullAlphaArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:ninja-plugin-alpha', '--', '-PluginRepo', $RoomAlphaPluginRepo, '-PublisherPath', $packagedPublisher, '-SpoutSenderPath', $roomAlphaSender, '-ExpectedPublisherSha256', $publisherHash, '-ExpectedPluginSha256', $pluginHash, '-ExpectedSpoutSenderSha256', $senderHash)
        & $script:npmExecutable @fullAlphaArgs
    }
    $allPass = $allPass -and $fullAlphaPass
}
$installerRan = $false
if (-not $SkipRoomAlpha) { $installerBinDir = Split-Path -Parent $RoomAlphaPublisherPath }
else { $installerBinDir = Split-Path -Parent $publisherExe }
$lines += "## Overall"
if (-not $allPass) {
    exit 1
}
'@

    $wrapperTemplate = @'
param(
    [string]$Version = '0.2.48',
    [string]$RoomAlphaPluginRepo = '',
    [switch]$SkipRoomAlpha = $false
)
. (Join-Path $PSScriptRoot 'release-source-snapshot.ps1')
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$sourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $repoRoot
$buildScript = Join-Path $PSScriptRoot 'build-release.ps1'
$buildParams = @{
    Version = $Version
    ExpectedSourceSnapshotSha256 = $sourceSnapshot.sha256
    ExpectedSourceSnapshotFileCount = $sourceSnapshot.fileCount
    ExpectedSourceSnapshotAlgorithm = $sourceSnapshot.algorithm
}
& $buildScript @buildParams
$packagedPublisher = Join-Path $repoRoot "dist/game-capture-$Version-win64/game-capture.exe"
$artifactManifestPath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($packagedPublisher)), 'release-artifact-manifest.json')
$artifactManifestSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $artifactManifestPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
$scriptPath = Join-Path $PSScriptRoot 'run-release-readiness.ps1'
$params = @{
    PublisherPath = $packagedPublisher
    ArtifactManifestPath = $artifactManifestPath
    ArtifactManifestSha256 = $artifactManifestSha256
    RoomAlphaPluginRepo = $RoomAlphaPluginRepo
    SkipRoomAlpha = $SkipRoomAlpha
}
& $scriptPath @params
'@
    Write-FixtureFile $base 'native-qt/qa/run-fast-gate.ps1' $wrapperTemplate
    Write-FixtureFile $base 'native-qt/qa/run-nightly-soak.ps1' $wrapperTemplate

    Write-FixtureFile $base 'native-qt/qa/release-and-publish.ps1' @'
param(
    [string]$Version,
    [string]$BuildDir,
    [string]$Configuration,
    [Parameter(Mandatory = $true)][string]$RoomAlphaPluginRepo,
    [Parameter(Mandatory = $true)][string]$RoomAlphaSpoutSenderPath,
    [switch]$SkipVirusTotal = $false
)
. (Join-Path $PSScriptRoot 'release-source-snapshot.ps1')
if ([string]::IsNullOrWhiteSpace($RoomAlphaPluginRepo)) { throw 'Plugin repo is required.' }
if ([string]::IsNullOrWhiteSpace($RoomAlphaSpoutSenderPath)) { throw 'Spout sender is required.' }
$nativeQtRoot = Join-Path $PSScriptRoot '..'
$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot
& cmake --build $BuildDir --config $Configuration
$compileExit = $LASTEXITCODE
if ($compileExit -ne 0) { throw 'Fresh compile failed.' }
$prePackageSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot
if ($prePackageSourceSnapshot.sha256 -cne $preBuildSourceSnapshot.sha256 -or $prePackageSourceSnapshot.fileCount -ne $preBuildSourceSnapshot.fileCount -or $prePackageSourceSnapshot.algorithm -cne $preBuildSourceSnapshot.algorithm) {
    throw 'Source changed during release build.'
}
$buildArgs = @('-File', (Join-Path $PSScriptRoot 'build-release.ps1'), '-BuildDir', $BuildDir, '-Configuration', $Configuration, '-Version', $Version, '-ExpectedSourceSnapshotSha256', $preBuildSourceSnapshot.sha256, '-ExpectedSourceSnapshotFileCount', $preBuildSourceSnapshot.fileCount, '-ExpectedSourceSnapshotAlgorithm', $preBuildSourceSnapshot.algorithm, '-SkipVirusTotal', '-RequireReleaseArtifacts')
& powershell.exe @buildArgs
$packageExit = $LASTEXITCODE
if ($packageExit -ne 0) { throw 'Package staging failed.' }
$distRoot = Join-Path $PSScriptRoot '../dist'
$packagedPublisher = Join-Path $distRoot "game-capture-$Version-win64/game-capture.exe"
$artifactManifestPath = [System.IO.Path]::Combine(
    [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($packagedPublisher)),
    'release-artifact-manifest.json'
)
if (-not (Test-Path -LiteralPath $artifactManifestPath -PathType Leaf)) {
    throw 'Release artifact manifest is required.'
}
$artifactManifestSha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $artifactManifestPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
if ($artifactManifestSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'Release artifact manifest SHA-256 is invalid.'
}
$versionedSetup = Join-Path $distRoot "game-capture-$Version-setup.exe"
$stableSetup = Join-Path $distRoot 'game-capture-setup.exe'
$versionedPortable = Join-Path $distRoot "game-capture-$Version-portable.exe"
$stablePortable = Join-Path $distRoot 'game-capture-portable.exe'
$versionedZip = Join-Path $distRoot "game-capture-$Version-win64.zip"
$stableZip = Join-Path $distRoot 'game-capture-win64.zip'
$versionedFfmpegSourceInfo = Join-Path $distRoot "game-capture-$Version-ffmpeg-source-info.zip"
$stableFfmpegSourceInfo = Join-Path $distRoot 'game-capture-ffmpeg-source-info.zip'
$readinessArgs = @('-File', (Join-Path $PSScriptRoot 'run-release-readiness.ps1'), '-PublisherPath', $packagedPublisher, '-ArtifactManifestPath', $artifactManifestPath, '-ArtifactManifestSha256', $artifactManifestSha256, '-RoomAlphaPublisherPath', $packagedPublisher, '-RoomAlphaPluginRepo', $RoomAlphaPluginRepo, '-RoomAlphaSpoutSenderPath', $RoomAlphaSpoutSenderPath)
& powershell.exe @readinessArgs
$readinessExit = $LASTEXITCODE
if ($readinessExit -ne 0) { throw 'Post-package readiness failed.' }
$aliasIdentityArgs = @('-File', (Join-Path $PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', $distRoot, '-Version', $Version)
& powershell.exe @aliasIdentityArgs
$aliasIdentityExit = $LASTEXITCODE
if ($aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }
if (-not $SkipVirusTotal) {
    $virusTotalArgs = @('-File', (Join-Path $PSScriptRoot 'submit-virustotal.ps1'), '-DistDir', $distRoot, '-Version', $Version)
    & powershell.exe @virusTotalArgs
    $virusTotalExit = $LASTEXITCODE
    if ($virusTotalExit -ne 0) { Write-Warning 'VirusTotal submission failed; validated release will continue.' }
}
if ($releaseExists) {
    gh release upload "v$Version" $packagedPublisher
    $uploadExit = $LASTEXITCODE
    if ($uploadExit -ne 0) { throw 'gh release upload failed.' }
    gh release edit "v$Version" --title "Game Capture $Version"
    $editExit = $LASTEXITCODE
    if ($editExit -ne 0) { throw 'gh release edit failed.' }
} else {
    gh release create "v$Version" $packagedPublisher
    $createExit = $LASTEXITCODE
    if ($createExit -ne 0) { throw 'gh release create failed.' }
}
Remove-Item -LiteralPath $notesPath -Force
Write-Host "Release completed: v$Version"
'@
    Write-FixtureFile $base 'native-qt/qa/release-source-snapshot.ps1' @'
function Get-ReleaseSourceSnapshot([string]$SourceRoot) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { return $null }
    $rawRelativePaths = @(& $git.Source -C $SourceRoot -c core.quotePath=false ls-files --cached --others --exclude-standard 2>$null)
    if ($LASTEXITCODE -ne 0 -or $rawRelativePaths.Count -eq 0) { return $null }
    $relativePathSet = [System.Collections.Generic.SortedSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    foreach ($rawRelativePath in $rawRelativePaths) {
        if (-not [string]::IsNullOrEmpty([string]$rawRelativePath)) {
            [void]$relativePathSet.Add([string]$rawRelativePath)
        }
    }
    $relativePaths = @($relativePathSet)
    if ($relativePaths.Count -eq 0) { return $null }

    $sourceRootFull = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd([char[]]@('\', '/'))
    $sourceRootPrefix = $sourceRootFull + [System.IO.Path]::DirectorySeparatorChar
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $buffer = New-Object byte[] (1024 * 1024)
    $fileCount = 0
    try {
        foreach ($relativePathValue in $relativePaths) {
            $relativePath = [string]$relativePathValue
            if ([string]::IsNullOrEmpty($relativePath)) { continue }

            $fullPath = [System.IO.Path]::GetFullPath((Join-Path $SourceRoot $relativePath))
            if (-not $fullPath.StartsWith($sourceRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $null
            }
            $normalizedPath = $relativePath.Replace('\', '/')
            if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
                $fileInfo = Get-Item -LiteralPath $fullPath -ErrorAction Stop
                $header = $utf8.GetBytes("file`0$normalizedPath`0$($fileInfo.Length)`0")
                [void]$hasher.TransformBlock($header, 0, $header.Length, $header, 0)
                $stream = [System.IO.File]::OpenRead($fullPath)
                try {
                    while (($bytesRead = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        [void]$hasher.TransformBlock($buffer, 0, $bytesRead, $buffer, 0)
                    }
                } finally {
                    $stream.Dispose()
                }
                $fileCount++
            } else {
                $header = $utf8.GetBytes("missing`0$normalizedPath`0")
                [void]$hasher.TransformBlock($header, 0, $header.Length, $header, 0)
            }
            $terminator = [byte[]]@(0)
            [void]$hasher.TransformBlock($terminator, 0, $terminator.Length, $terminator, 0)
        }
        [void]$hasher.TransformFinalBlock([byte[]]@(), 0, 0)
        return [pscustomobject]([ordered]@{
            sha256 = ([System.BitConverter]::ToString($hasher.Hash)).Replace('-', '').ToLowerInvariant()
            fileCount = $fileCount
            algorithm = 'sha256(file-nul-path-nul-size-nul-content-nul)/git-ls-files-cached-others-exclude-standard/ordinal-sort-unique/v2'
        })
    } catch {
        return $null
    } finally {
        $hasher.Dispose()
    }
}
'@
    Write-FixtureFile $base 'native-qt/qa/build-release.ps1' @'
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$Configuration = 'Release',
    [string]$FfmpegBundleRoot = '',
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSourceSnapshotSha256,
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ExpectedSourceSnapshotFileCount,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ExpectedSourceSnapshotAlgorithm,
    [switch]$AllowMissingFfmpeg = $false,
    [switch]$RequireReleaseArtifacts = $false
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-source-snapshot.ps1')
function Get-ReleasePayloadInventory([string]$StageRoot, [string]$ExcludedRelativePath) {
    $entriesByPath = [System.Collections.Generic.SortedDictionary[string, object]]::new(
        [System.StringComparer]::Ordinal)
    $item = [System.IO.FileInfo](Join-Path $StageRoot 'game-capture.exe')
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw 'Reparse payloads are forbidden.'
    }
    if ([int64]$item.Length -lt 1) {
        throw 'Positive payload size is required.'
    }
    $entry = [pscustomobject]@{
        relativePath = 'game-capture.exe'
        size = [int64]$item.Length
        sha256 = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $entriesByPath.Add($entry.relativePath, $entry)
    return [pscustomobject]@{
        algorithm = 'sha256(utf8(relative-path-nul-size-nul-sha256-lf))/ordinal-sort/v1'
        fileCount = $entriesByPath.Count
        aggregateSha256 = ('a' * 64)
        files = @($entriesByPath.Values)
    }
}
function Get-ReleaseSourceProvenance([string]$SourceRoot) {
    $commitText = ('b' * 40)
    $gitCommit = $commitText.Trim().ToLowerInvariant()
    $snapshot = Get-ReleaseSourceSnapshot -SourceRoot $SourceRoot
    return [pscustomobject]@{
        gitCommit = $gitCommit
        dirty = [bool]$false
        statusEntryCount = 0
        snapshotSha256 = $snapshot.sha256
        snapshotFileCount = $snapshot.fileCount
        snapshotAlgorithm = $snapshot.algorithm
        snapshotScope = 'fixture'
    }
}
$repoRoot = Join-Path $PSScriptRoot '..'
$distRoot = Join-Path $PSScriptRoot '../dist'
if ($Configuration -cne 'Release') {
    throw 'Release packaging requires Configuration=Release.'
}
if ([string]::IsNullOrWhiteSpace($FfmpegBundleRoot)) { $FfmpegBundleRoot = Join-Path $repoRoot 'third_party/ffmpeg-win64' }
$exePath = Resolve-ExecutablePath -RepoRoot $repoRoot
if (-not $exePath) { throw 'Current executable is required.' }
if (-not (Test-BinaryContainsAsciiString -Path $exePath -Needle $Version)) { throw 'Current executable version mismatch.' }
$ffmpegManifest = $null
if (Test-Path -LiteralPath (Join-Path $FfmpegBundleRoot 'bin/ffmpeg.exe') -PathType Leaf) {
    $ffmpegManifest = Assert-FfmpegBundle -BundleRoot $FfmpegBundleRoot
} elseif (-not $AllowMissingFfmpeg) {
    throw 'FFmpeg bundle is required.'
}
$stageDir = Join-Path $PSScriptRoot "../dist/game-capture-$Version-win64"
$releaseManifestPath = Join-Path $stageDir 'release-artifact-manifest.json'
$zipPath = Join-Path $PSScriptRoot "../dist/game-capture-$Version-win64.zip"
$zipStablePath = Join-Path $PSScriptRoot '../dist/game-capture-win64.zip'
$installerVersionedPath = Join-Path $PSScriptRoot "../dist/game-capture-$Version-setup.exe"
$installerStablePath = Join-Path $PSScriptRoot '../dist/game-capture-setup.exe'
$portableVersionedPath = Join-Path $PSScriptRoot "../dist/game-capture-$Version-portable.exe"
$portableStablePath = Join-Path $PSScriptRoot '../dist/game-capture-portable.exe'
$ffmpegSourceInfoVersionedPath = Join-Path $PSScriptRoot "../dist/game-capture-$Version-ffmpeg-source-info.zip"
$ffmpegSourceInfoStablePath = Join-Path $PSScriptRoot '../dist/game-capture-ffmpeg-source-info.zip'
$sourceInfoDir = Join-Path $PSScriptRoot "../dist/game-capture-$Version-ffmpeg-source-info"
$portableArchive = Join-Path $PSScriptRoot "../dist/game-capture-$Version-portable.7z"
$sevenZipExe = 'C:/Program Files/7-Zip/7z.exe'
$sevenZipSfx = 'C:/Program Files/7-Zip/7z.sfx'
$portableConfig = Join-Path $repoRoot 'portable-sfx-config.txt'
$makensis = Get-Command makensis -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $sevenZipExe -PathType Leaf) -or -not (Test-Path -LiteralPath $sevenZipSfx -PathType Leaf) -or -not (Test-Path -LiteralPath $portableConfig -PathType Leaf)) { throw '7-Zip and portable-sfx-config are required.' }
if (-not $makensis) { throw 'NSIS makensis is required.' }
if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
    if (Test-Path -LiteralPath $stageDir) { throw 'Stale stage directory survived cleanup.' }
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
    if (Test-Path -LiteralPath $zipPath) { throw 'Stale versioned ZIP survived cleanup.' }
}
if (Test-Path -LiteralPath $zipStablePath) {
    Remove-Item -LiteralPath $zipStablePath -Force
    if (Test-Path -LiteralPath $zipStablePath) { throw 'Stale stable ZIP survived cleanup.' }
}
if (Test-Path -LiteralPath $installerVersionedPath) {
    Remove-Item -LiteralPath $installerVersionedPath -Force
    if (Test-Path -LiteralPath $installerVersionedPath) { throw 'Stale versioned installer survived cleanup.' }
}
if (Test-Path -LiteralPath $installerStablePath) {
    Remove-Item -LiteralPath $installerStablePath -Force
    if (Test-Path -LiteralPath $installerStablePath) { throw 'Stale stable installer survived cleanup.' }
}
if (Test-Path -LiteralPath $portableVersionedPath) {
    Remove-Item -LiteralPath $portableVersionedPath -Force
    if (Test-Path -LiteralPath $portableVersionedPath) { throw 'Stale versioned portable survived cleanup.' }
}
if (Test-Path -LiteralPath $portableStablePath) {
    Remove-Item -LiteralPath $portableStablePath -Force
    if (Test-Path -LiteralPath $portableStablePath) { throw 'Stale stable portable survived cleanup.' }
}
if (Test-Path -LiteralPath $ffmpegSourceInfoVersionedPath) {
    Remove-Item -LiteralPath $ffmpegSourceInfoVersionedPath -Force
    if (Test-Path -LiteralPath $ffmpegSourceInfoVersionedPath) { throw 'Stale versioned FFmpeg info survived cleanup.' }
}
if (Test-Path -LiteralPath $ffmpegSourceInfoStablePath) {
    Remove-Item -LiteralPath $ffmpegSourceInfoStablePath -Force
    if (Test-Path -LiteralPath $ffmpegSourceInfoStablePath) { throw 'Stale stable FFmpeg info survived cleanup.' }
}
if (Test-Path -LiteralPath $sourceInfoDir) {
    Remove-Item -LiteralPath $sourceInfoDir -Recurse -Force
    if (Test-Path -LiteralPath $sourceInfoDir) { throw 'Stale FFmpeg info directory survived cleanup.' }
}
if (Test-Path -LiteralPath $portableArchive) {
    Remove-Item -LiteralPath $portableArchive -Force
    if (Test-Path -LiteralPath $portableArchive) { throw 'Stale portable archive survived cleanup.' }
}
Write-Step 'Stage Artifacts'
$stagedExecutablePath = Join-Path $stageDir 'game-capture.exe'
Copy-Item game-capture.exe $stagedExecutablePath
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$qtConfiguration = @"
[Paths]
Prefix=.
Plugins=.
"@
[System.IO.File]::WriteAllText(
    (Join-Path $stageDir 'qt.conf'),
    $qtConfiguration.Replace("`r`n", "`n") + "`n",
    $utf8WithoutBom)
$signScript = Join-Path $PSScriptRoot 'sign-artifacts.ps1'
if (Test-Path $signScript) {
    try {
        & $signScript -FilePaths @($stagedExecutablePath)
    } catch {
        Write-Warning 'Staged code-signing failed; continuing.'
    }
}
if (-not (Test-Path -LiteralPath $stagedExecutablePath -PathType Leaf)) {
    throw 'Final staged executable is required.'
}
$payloadInventory = Get-ReleasePayloadInventory -StageRoot $stageDir -ExcludedRelativePath `
    'release-artifact-manifest.json'
$stagedExecutableInfo = Get-Item -LiteralPath $stagedExecutablePath -ErrorAction Stop
$stagedExecutableSha256 = (Get-FileHash -LiteralPath $stagedExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
$payloadExecutableEntries = @($payloadInventory.files | Where-Object {
    $_.relativePath -ceq 'game-capture.exe'
})
if ($payloadExecutableEntries.Count -ne 1) {
    throw 'Complete payload must bind game-capture.exe.'
}
$sourceExecutableInfo = $stagedExecutableInfo
$sourceExecutableSha256 = $stagedExecutableSha256
$sourceExecutableRelativePath = 'fixture/game-capture.exe'
$sourceProvenance = Get-ReleaseSourceProvenance -SourceRoot $repoRoot
if ($sourceProvenance.snapshotSha256 -cne $ExpectedSourceSnapshotSha256 -or [int64]$sourceProvenance.snapshotFileCount -ne $ExpectedSourceSnapshotFileCount -or $sourceProvenance.snapshotAlgorithm -cne $ExpectedSourceSnapshotAlgorithm) {
    throw 'Packaging source snapshot differs from the pre-build snapshot.'
}
if ($sourceProvenance.gitCommit -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') {
    throw 'A lowercase Git commit is required.'
}
if ($sourceProvenance.dirty -isnot [bool]) {
    throw 'A definitive dirty state is required.'
}
if ($sourceProvenance.snapshotSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'A source snapshot SHA-256 is required.'
}
if ($null -eq $sourceProvenance.snapshotFileCount -or [int64]$sourceProvenance.snapshotFileCount -lt 1) {
    throw 'A positive source snapshot file count is required.'
}
if ([string]::IsNullOrWhiteSpace([string]$sourceProvenance.snapshotAlgorithm)) {
    throw 'A source snapshot algorithm is required.'
}
$releaseManifest = [ordered]@{
    schema = 'game-capture-release-artifact/v1'
    version = $Version
    packagedAtUtc = [System.DateTime]::UtcNow.ToString('o')
    artifact = [ordered]@{
        relativePath = 'game-capture.exe'
        size = [int64]$stagedExecutableInfo.Length
        sha256 = $stagedExecutableSha256
    }
    payload = [ordered]@{
        algorithm = $payloadInventory.algorithm
        fileCount = $payloadInventory.fileCount
        aggregateSha256 = $payloadInventory.aggregateSha256
        files = @($payloadInventory.files)
    }
    build = [ordered]@{
        configuration = $Configuration
        directory = 'fixture'
        sourceExecutable = [ordered]@{
            relativePath = $sourceExecutableRelativePath
            size = [int64]$sourceExecutableInfo.Length
            sha256 = $sourceExecutableSha256
        }
    }
    source = [ordered]@{
        gitCommit = $sourceProvenance.gitCommit
        dirty = $sourceProvenance.dirty
        snapshotSha256 = $sourceProvenance.snapshotSha256
        snapshotFileCount = $sourceProvenance.snapshotFileCount
        snapshotAlgorithm = $sourceProvenance.snapshotAlgorithm
    }
}
$releaseManifestJson = $releaseManifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($releaseManifestPath, $releaseManifestJson + "`n", $utf8WithoutBom)
$releaseManifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -Force
& $sevenZipExe a $portableArchive (Join-Path $stageDir '*')
& $makensis.Source /V2 "/DOUTFILE=$installerVersionedPath" installer.nsi
$releaseExePaths = @($portableVersionedPath, $installerVersionedPath)
if (Test-Path $signScript) {
    try {
        & $signScript -FilePaths $releaseExePaths
    } catch {
        Write-Warning 'Code-signing step failed; continuing.'
    }
}
Copy-Item -Path $portableVersionedPath -Destination $portableStablePath -Force
Copy-Item -Path $installerVersionedPath -Destination $installerStablePath -Force
if ($RequireReleaseArtifacts) {
    $requiredReleaseArtifacts = @(
        (Join-Path $stageDir 'game-capture.exe'),
        $zipPath,
        $zipStablePath,
        $portableVersionedPath,
        $portableStablePath,
        $installerVersionedPath,
        $installerStablePath
    )
    foreach ($requiredReleaseArtifact in $requiredReleaseArtifacts) {
        if (-not (Test-Path -LiteralPath $requiredReleaseArtifact -PathType Leaf)) {
            throw 'Required release artifact was not generated by this invocation.'
        }
    }
}
$buildAliasIdentityArgs = @('-File', (Join-Path $PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', $distRoot, '-Version', $Version)
if ($AllowMissingFfmpeg) { $buildAliasIdentityArgs += '-AllowMissingFfmpeg' }
& powershell.exe @buildAliasIdentityArgs
$buildAliasIdentityExit = $LASTEXITCODE
if ($buildAliasIdentityExit -ne 0) { throw 'Built release artifact alias identity validation failed.' }
$vtScript = Join-Path $PSScriptRoot 'submit-virustotal.ps1'
& $vtScript -DistDir $distRoot -Version $Version
'@
    Write-FixtureFile $base 'native-qt/qa/sign-artifacts.ps1' @'
param(
    [string]$DistDir = '',
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '',
    [string[]]$FilePaths = @(),
    [switch]$FailOnError = $false
)
function Sign-File([string]$filePath) { Write-Host "Signing $filePath" }
function Test-SignatureAcceptable($signature) {
    if (-not $signature) { return $false }
    if (-not $signature.SignerCertificate) { return $false }
    $hardFailures = @('NotSigned', 'HashMismatch', 'NotSupported', 'Incompatible')
    if ($hardFailures -contains [string]$signature.Status) { return $false }
    return $true
}
if ($DistDir -and [string]::IsNullOrWhiteSpace($Version)) {
    throw 'Version is required with DistDir.'
}
$allExes = @()
if ($FilePaths -and $FilePaths.Count -gt 0) {
    foreach ($path in $FilePaths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Explicit signing input must be a literal file.' }
        $resolved = Resolve-Path -LiteralPath $path
        $allExes += Get-Item -LiteralPath $resolved
    }
} else {
    $versionedSetupPath = Join-Path $DistDir "game-capture-$Version-setup.exe"
    $versionedPortablePath = Join-Path $DistDir "game-capture-$Version-portable.exe"
    if (-not (Test-Path -LiteralPath $versionedSetupPath -PathType Leaf)) { throw 'Versioned setup EXE is required.' }
    if (-not (Test-Path -LiteralPath $versionedPortablePath -PathType Leaf)) { throw 'Versioned portable EXE is required.' }
    $allExes = @(
        Get-Item -LiteralPath $versionedSetupPath
        Get-Item -LiteralPath $versionedPortablePath
    )
}
$failures = @()
foreach ($file in $allExes) {
    try {
        Sign-File -filePath $file.FullName
        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file.FullName
        if (-not (Test-SignatureAcceptable -signature $signature)) { throw 'Signature check failed.' }
    } catch {
        $failures += [pscustomobject]@{
            Name = $file.Name
            Error = $_.Exception.Message
        }
    }
}
if ($DistDir) {
    $stableSetupPath = Join-Path $DistDir 'game-capture-setup.exe'
    $stablePortablePath = Join-Path $DistDir 'game-capture-portable.exe'
    if ((Test-Path -LiteralPath $stableSetupPath) -and -not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw 'Stable setup destination must be absent or a literal file.' }
    if ((Test-Path -LiteralPath $stablePortablePath) -and -not (Test-Path -LiteralPath $stablePortablePath -PathType Leaf)) { throw 'Stable portable destination must be absent or a literal file.' }
    Copy-Item -LiteralPath $versionedSetupPath -Destination $stableSetupPath -Force
    Copy-Item -LiteralPath $versionedPortablePath -Destination $stablePortablePath -Force
    if (-not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw 'Stable setup alias was not created as a literal file.' }
    if (-not (Test-Path -LiteralPath $stablePortablePath -PathType Leaf)) { throw 'Stable portable alias was not created as a literal file.' }
    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw 'Stable setup alias hash mismatch.' }
    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedPortablePath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stablePortablePath -Algorithm SHA256).Hash) { throw 'Stable portable alias hash mismatch.' }
}
if ($failures.Count -gt 0) {
    Write-Warning "Code signing: $($failures.Count) artifact(s) failed to sign."
    if ($FailOnError) { exit 1 }
}
'@
    Write-FixtureFile $base 'native-qt/qa/submit-virustotal.ps1' "param([string]`$DistDir, [string]`$Version)`n"

    $fastWorkflowTemplate = @'
name: QA
jobs:
  qa:
    runs-on: [self-hosted, Windows, X64]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Checkout ninja-plugin
        uses: actions/checkout@v4
        with:
          repository: steveseguin/ninja-plugin
          ref: main
          path: ninja-plugin
      - name: Install browser runtimes
        run: npx playwright install msedge firefox
      - name: Release wiring policy
        run: npm --prefix native-qt run gate:release-wiring
      - name: Run QA Gate
        shell: pwsh
        run: |
          $ninjaPluginRepo = Join-Path $env:GITHUB_WORKSPACE "ninja-plugin"
          ./native-qt/qa/WORKFLOW_SCRIPT `
            -RoomAlphaPluginRepo $ninjaPluginRepo `
            -SkipRoomAlpha
'@
    Write-FixtureFile $base '.github/workflows/qa-fast-gate.yml' ($fastWorkflowTemplate.Replace('WORKFLOW_SCRIPT', 'run-fast-gate.ps1'))
    Write-FixtureFile $base '.github/workflows/qa-nightly-soak.yml' ($fastWorkflowTemplate.Replace('WORKFLOW_SCRIPT', 'run-nightly-soak.ps1'))

    foreach ($alphaScript in @(
        'alpha-workflow-manifest-regression.ps1',
        'alpha-artifact-binding-regression.ps1',
        'ninja-plugin-alpha-e2e.ps1',
        'room-alpha-ninja-plugin-e2e.ps1'
    )) {
        Write-FixtureFile $base (Join-Path 'native-qt/e2e' $alphaScript) "param([Parameter(Mandatory = `$true)][string]`$PluginRepo)`nif ([string]::IsNullOrWhiteSpace(`$PluginRepo)) { throw 'PluginRepo is required.' }`n"
    }
    Write-FixtureFile $base 'native-qt/e2e/alpha-composite-analyzer-regression.js' @'
const arg = process.argv.find((value) => value.startsWith('--plugin-repo='));
if (!arg) { throw new Error('plugin repo required'); }
'@
    Write-FixtureFile $base 'native-qt/e2e/signaling-media-fixture-regression.js' "process.exit(0);`n"
    Write-FixtureFile $base 'native-qt/qa/adv-early-success.ps1' "exit 0`n"

    $baseline = Invoke-PolicyFixture $base
    $baselineFailures = @(Get-FailedIds $baseline.result)
    if ($baseline.exitCode -ne 0 -or -not [bool]$baseline.result.ok -or $baselineFailures.Count -ne 0) {
        $baselineFailureDetails = @(
            $baseline.result.checks |
                Where-Object { -not [bool]$_.ok } |
                ForEach-Object { '{0}: {1}' -f $_.id, $_.failure }
        )
        throw "Compliant mutation baseline did not pass: $($baselineFailureDetails -join ' | ')"
    }
    Write-Host '[MUTATION BASELINE] PASS'
    Write-Host '[MUTATION CONTROL] non-sign makensis ampersand with canonical installer output accepted'
    Write-Host '[MUTATION CONTROL] real best-effort conditional signer invocation accepted'
    if ($BaselineOnly) { return }

    $fixtureArgsAssignment = "`$signalFixtureGateArgs = @('--prefix', `$script:repoRoot, 'run', 'gate:signaling-media-fixture')"
    $fixtureInvocation = '& $script:npmExecutable @signalFixtureGateArgs'
    $fixtureExitCapture = '$signalFixtureGateExit = $LASTEXITCODE'
    $fixtureFailureGuard = @(
        'if ($signalFixtureGateExit -ne 0) {'
        '    exit $signalFixtureGateExit'
        '}'
    ) -join "`n"
    $fixtureStep = @(
        $fixtureArgsAssignment
        $fixtureInvocation
        $fixtureExitCapture
        $fixtureFailureGuard
    ) -join "`n"
    $edgeStep = @(
        "`$signalEdgePass = & `$script:runStepImplementation 'Signal Edge' {"
        '    $signalEdgeArgs = @(''--prefix'', $script:repoRoot, ''run'', ''e2e:signaling-regressions:edge'', ''--'', "--publisher-path=$script:publisherExe", "--artifact-manifest-path=$script:artifactManifestPathBinding", "--artifact-manifest-sha256=$script:artifactManifestSha256Binding")'
        '    & $script:npmExecutable @signalEdgeArgs'
        '}'
    ) -join "`n"
    $edgeBinding = '$allPass = $allPass -and $signalEdgePass'
    $firefoxStep = @(
        "`$signalFirefoxPass = & `$script:runStepImplementation 'Signal Firefox' {"
        '    $signalFirefoxArgs = @(''--prefix'', $script:repoRoot, ''run'', ''e2e:signaling-regressions:firefox'', ''--'', "--publisher-path=$script:publisherExe", "--artifact-manifest-path=$script:artifactManifestPathBinding", "--artifact-manifest-sha256=$script:artifactManifestSha256Binding")'
        '    & $script:npmExecutable @signalFirefoxArgs'
        '}'
    ) -join "`n"
    $firefoxBinding = '$allPass = $allPass -and $signalFirefoxPass'
    $earlyEdgeInvocation = @(
        "`$earlyEdgeArgs = @('--prefix', `$repoRoot, 'run', 'e2e:signaling-regressions:edge', '--', '--publisher-path', `$publisherExe)"
        '& npm.cmd @earlyEdgeArgs'
    ) -join "`n"
    $earlyFirefoxInvocation = @(
        "`$earlyFirefoxArgs = @('--prefix', `$repoRoot, 'run', 'e2e:signaling-regressions:firefox', '--', '--publisher-path', `$publisherExe)"
        '& npm.cmd @earlyFirefoxArgs'
    ) -join "`n"
    $noncanonicalFixtureStep = @(
        "`$duplicateFixtureArgs = @('--prefix', `$script:repoRoot, 'run', 'gate:signaling-media-fixture')"
        "Write-Host 'extra live statement'"
        '& $script:npmExecutable @duplicateFixtureArgs'
    ) -join "`n"
    $runStepActionInvocation = @'
        & $action | & (
            $ExecutionContext.SessionState.InvokeCommand.GetCommand(
                'Out-Host',
                [System.Management.Automation.CommandTypes]::Cmdlet
            )
        )
'@
    $runStepExitGuard = "        if (`$global:LASTEXITCODE -ne 0) { throw 'command failed' }"
    $runStepCore = @(
        '        $global:LASTEXITCODE = 0'
        $runStepActionInvocation
        $runStepExitGuard
        '        return $true'
    ) -join "`n"
    $repoConstantBinding = @'
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name repoRoot -Scope Script -Option Constant -Value (
    [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..'))
)
'@
    $npmConstantBinding = @'
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
'@
    $publisherConstantBinding = @'
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name publisherExe -Scope Script -Option Constant -Value $PublisherPath
'@
    $manifestPathConstantBinding = @'
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name artifactManifestPathBinding -Scope Script -Option Constant -Value $ArtifactManifestPath
'@
    $manifestHashConstantBinding = @'
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'New-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name artifactManifestSha256Binding -Scope Script -Option Constant -Value $ArtifactManifestSha256
'@
    $repoDirectoryGuard = "if (-not [System.IO.Directory]::Exists(`$script:repoRoot)) { throw 'Resolved repository root does not exist.' }"
    $npmFileGuard = "if (-not [System.IO.File]::Exists(`$script:npmExecutable)) { throw 'Resolved npm.cmd application does not exist.' }"
    $releaseWiringCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-gate-wiring-policy-mutations.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-gate-wiring-regression.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-readiness-runtime-regression.ps1'
    $releaseWiringWithoutRuntime = 'powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-gate-wiring-policy-mutations.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-gate-wiring-regression.ps1'
    $aliasIdentityFailureGuard = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
    $aliasIdentityArgsAssignment = "`$aliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)"
    $readinessPreFixtureSetup = @(
        $publisherConstantBinding
        $manifestPathConstantBinding
        $manifestHashConstantBinding
        '$packagedPublisher = Resolve-PackagedPublisherExecutable $RoomAlphaPublisherPath'
        '$roomAlphaSender = Resolve-RoomAlphaSpoutSender $RoomAlphaSpoutSenderPath'
        '$publisherHash = (Get-FileHash $packagedPublisher).Hash'
        '$pluginHash = (Get-FileHash (Join-Path $RoomAlphaPluginRepo ''install/obs-vdoninja.dll'')).Hash'
        '$senderHash = (Get-FileHash $roomAlphaSender).Hash'
    ) -join "`n"

    $acceptedControls = @(
        [pscustomobject]@{
            name = 'control-harmless-fixture-alias-log'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`nWrite-Host 'gate:signaling-media-fixture'"
        },
        [pscustomobject]@{
            name = 'control-harmless-early-edge-alias-log'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "Write-Host 'e2e:signaling-regressions:edge'`n" + $fixtureStep
        },
        [pscustomobject]@{
            name = 'control-loop-local-break'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "foreach (`$localProbe in 1) { break }`n" + $fixtureStep
        },
        [pscustomobject]@{
            name = 'control-loop-local-continue'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "foreach (`$localProbe in 1) { continue }`n" + $fixtureStep
        },
        [pscustomobject]@{
            name = 'control-post-identity-read-only-release-artifact'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[void][System.IO.File]::ReadAllText((Join-Path `$PSScriptRoot '../dist/game-capture-`$Version-setup.exe'))"
        },
        [pscustomobject]@{
            name = 'control-post-identity-read-only-file-open'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[void][System.IO.File]::Open(`$stableSetup, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)"
        },
        [pscustomobject]@{
            name = 'control-post-identity-unrelated-dotnet-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[System.IO.File]::WriteAllText((Join-Path `$PSScriptRoot '../logs/game-capture-`$Version-setup.exe'), 'unrelated-output')"
        },
        [pscustomobject]@{
            name = 'control-post-identity-unrelated-path-combine-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$unrelatedCombinedPath = [IO.Path]::Combine(`$PSScriptRoot, '..', 'logs', `"game-capture-`$Version-setup.exe`")`n[IO.File]::WriteAllText(`$unrelatedCombinedPath, 'unrelated-output')"
        },
        [pscustomobject]@{
            name = 'control-post-identity-read-only-artifact-alias'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateReadArtifact = `$stableSetup`n[void][IO.File]::ReadAllText(`$lateReadArtifact)"
        },
        [pscustomobject]@{
            name = 'control-post-identity-read-only-composed-versioned-artifact'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$readOnlyArtifactLeaf = 'game-capture-' + `$Version + '-setup.exe'`n`$readOnlyArtifactPath = [System.IO.Path]::Combine(`$distRoot, `$readOnlyArtifactLeaf)`n[void][System.IO.File]::ReadAllText(`$readOnlyArtifactPath)"
        },
        [pscustomobject]@{
            name = 'control-post-identity-composed-log-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateLogLeaf = 'game-capture-' + `$Version + '-setup.exe'`n`$lateLogRoot = [System.IO.Path]::Combine(`$PSScriptRoot, '..', 'logs')`n`$lateLogPath = [System.IO.Path]::Combine(`$lateLogRoot, `$lateLogLeaf)`n[System.IO.File]::WriteAllText(`$lateLogPath, 'unrelated-output')"
        },
        [pscustomobject]@{
            name = 'control-round5-formatted-log-writeallbytes'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateLogSuffix = 'setup.exe'`n`$lateLogLeaf = 'game-capture-{0}-{1}' -f `$Version, `$lateLogSuffix`n`$lateLogPath = [System.IO.Path]::Combine(`$PSScriptRoot, '..', 'logs', `$lateLogLeaf)`n[System.IO.File]::WriteAllBytes(`$lateLogPath, [byte[]]@(1, 2, 3))"
        },
        [pscustomobject]@{
            name = 'control-round5-formatted-read-only-fileinfo-open'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateReadSuffix = 'portable.exe'`n`$lateReadArguments = @(`$Version, `$lateReadSuffix)`n`$lateReadLeaf = 'game-capture-{0}-{1}' -f `$lateReadArguments`n`$lateReadPath = Join-Path `$distRoot `$lateReadLeaf`n`$lateReadInfo = [System.IO.FileInfo]::new(`$lateReadPath)`n[void]`$lateReadInfo.Open([System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)"
        },
        [pscustomobject]@{
            name = 'control-round5-unrelated-formatted-dist-name'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateUnrelatedLeaf = 'release-notes-{1}-{0}.txt' -f 'setup', `$Version`n`$lateUnrelatedPath = [System.IO.Path]::Join(`$distRoot, `$lateUnrelatedLeaf)`n[System.IO.File]::WriteAllBytes(`$lateUnrelatedPath, [byte[]]@(1, 2, 3))"
        },
        [pscustomobject]@{
            name = 'control-round5-invalid-format-syntax-unresolved'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateInvalidLeaf = 'game-capture-{0-setup.exe' -f `$Version`n`$lateInvalidPath = [System.IO.Path]::Combine(`$distRoot, `$lateInvalidLeaf)`n[System.IO.File]::WriteAllText(`$lateInvalidPath, 'invalid-format-never-writes')"
        },
        [pscustomobject]@{
            name = 'control-round5-out-of-range-format-unresolved'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateOutOfRangeLeaf = 'game-capture-{2}-setup.exe' -f `$Version`n`$lateOutOfRangePath = Join-Path `$distRoot `$lateOutOfRangeLeaf`n[System.IO.File]::WriteAllText(`$lateOutOfRangePath, 'out-of-range-format-never-writes')"
        },
        [pscustomobject]@{
            name = 'control-round5-dynamic-format-argument-unresolved'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateDynamicVersion = Get-Date`n`$lateDynamicLeaf = 'game-capture-{0}-setup.exe' -f `$lateDynamicVersion`n`$lateDynamicPath = [System.IO.Path]::Combine(`$distRoot, `$lateDynamicLeaf)`n[System.IO.File]::WriteAllText(`$lateDynamicPath, 'dynamic-format-not-statically-guessed')"
        },
        [pscustomobject]@{
            name = 'control-round5-culture-provider-format-unresolved'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateCultureLeaf = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, 'release-notes-{0}.txt', `$Version)`n`$lateCulturePath = [System.IO.Path]::Combine(`$distRoot, `$lateCultureLeaf)`n[System.IO.File]::WriteAllText(`$lateCulturePath, 'culture-provider-not-statically-guessed')"
        },
        [pscustomobject]@{
            name = 'control-pre-identity-release-artifact-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityArgsAssignment
            after = "[System.IO.File]::WriteAllText((Join-Path `$PSScriptRoot '../dist/game-capture-`$Version-setup.exe'), 'pre-identity-write')`n" + $aliasIdentityArgsAssignment
        }
    )
    if (-not $ValidateMutationSourcesOnly) {
        foreach ($control in $acceptedControls) {
            $controlRoot = Join-Path $mutationRoot $control.name
            Copy-Item -LiteralPath $base -Destination $controlRoot -Recurse
            Replace-ExactlyOnce $controlRoot $control.file $control.before $control.after
            $controlRun = Invoke-PolicyFixture $controlRoot
            $controlFailures = @(Get-FailedIds $controlRun.result)
            if ($controlRun.exitCode -ne 0 -or -not [bool]$controlRun.result.ok -or $controlFailures.Count -ne 0) {
                throw "Accepted control '$($control.name)' was rejected: $($controlFailures -join ',')"
            }
            Write-Host ("[MUTATION CONTROL PASS] {0}: full policy green" -f $control.name)
        }
    }

    $mutations = @(
        [pscustomobject]@{
            name = 'qa-release-direct-success-exit'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')`nexit 0"
            expected = @('RELEASE_COMPILE_PACKAGE_VALIDATE_PUBLISH_ORDER')
        },
        [pscustomobject]@{
            name = 'qa-release-dot-source-success-exit'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')`n. (Join-Path `$PSScriptRoot 'adv-early-success.ps1')"
            expected = @('RELEASE_COMPILE_PACKAGE_VALIDATE_PUBLISH_ORDER')
        },
        [pscustomobject]@{
            name = 'qa-release-dynamic-call-success-exit'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')`n& (Microsoft.PowerShell.Core\Get-Command -Name (Join-Path `$PSScriptRoot 'adv-early-success.ps1') -CommandType ExternalScript -ErrorAction Stop)"
            expected = @('RELEASE_COMPILE_PACKAGE_VALIDATE_PUBLISH_ORDER')
        },
        [pscustomobject]@{
            name = 'qa-release-call-operator-helper-shadow'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')`n& (Microsoft.PowerShell.Core\Get-Command -Name 'Set-Alias' -CommandType Cmdlet -ErrorAction Stop) -Name Get-ReleaseSourceSnapshot -Value Get-Date"
            expected = @('RELEASE_SOURCE_SNAPSHOT_SHARED_HELPER')
        },
        [pscustomobject]@{
            name = 'qa-release-sessionstate-prebuild-collapse'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$prePackageSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot'
            after = "`$prePackageSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot `$nativeQtRoot`n`$freshSnapshotAlias = `$prePackageSourceSnapshot`n`$ExecutionContext.SessionState.PSVariable.Set('preBuildSourceSnapshot', `$freshSnapshotAlias)"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'qa-readiness-sessionstate-publisher-parameter-rebind'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $publisherConstantBinding
            after = "`$replacementPublisherParameter = `$stalePublisherPath`n`$ExecutionContext.SessionState.PSVariable.Set('PublisherPath', `$replacementPublisherParameter)`n" + $publisherConstantBinding
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'qa-build-alias-exe-replacement-before-archive'
            file = 'native-qt/qa/build-release.ps1'
            before = '$releaseManifestSha256 = (Get-FileHash -LiteralPath $releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()'
            after = "`$archiveExecutableAlias = `$stagedExecutablePath`n[System.IO.File]::WriteAllText(`$archiveExecutableAlias, 'replaced-after-manifest-before-archive')`n`$releaseManifestSha256 = (Get-FileHash -LiteralPath `$releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()"
            expected = @('BUILD_RELEASE_MANIFEST_FINAL_EXE_IDENTITY')
        },
        [pscustomobject]@{
            name = 'qa-release-alias-publisher-replacement-before-readiness'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$readinessArgs = @(''-File'', (Join-Path $PSScriptRoot ''run-release-readiness.ps1''), ''-PublisherPath'', $packagedPublisher'
            after = "`$publisherWriteAlias = `$packagedPublisher`n[System.IO.File]::WriteAllText(`$publisherWriteAlias, 'replaced-after-identity-before-readiness')`n`$readinessArgs = @('-File', (Join-Path `$PSScriptRoot 'run-release-readiness.ps1'), '-PublisherPath', `$packagedPublisher"
            expected = @('RELEASE_EXACT_READINESS_BINDINGS')
        },
        [pscustomobject]@{
            name = 'review-survivor-helper-early-constant-return'
            file = 'native-qt/qa/release-source-snapshot.ps1'
            before = 'function Get-ReleaseSourceSnapshot([string]$SourceRoot) {'
            after = "function Get-ReleaseSourceSnapshot([string]`$SourceRoot) {`n    return [pscustomobject]@{ sha256 = ('f' * 64); fileCount = 3; algorithm = 'sha256(fake)/ordinal-sort-unique/v2' }"
            expected = @('BUILD_RELEASE_SOURCE_SNAPSHOT_DETERMINISTIC')
        },
        [pscustomobject]@{
            name = 'review-survivor-helper-dynamic-execution'
            file = 'native-qt/qa/release-source-snapshot.ps1'
            before = 'function Get-ReleaseSourceSnapshot([string]$SourceRoot) {'
            after = "function Get-ReleaseSourceSnapshot([string]`$SourceRoot) {`n    Invoke-Expression '`$unusedSnapshotProbe = 1'"
            expected = @('RELEASE_SOURCE_SNAPSHOT_SHARED_HELPER')
        },
        [pscustomobject]@{
            name = 'review-survivor-release-comparison-false-nested'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$prePackageSourceSnapshot.sha256 -cne `$preBuildSourceSnapshot.sha256 -or `$prePackageSourceSnapshot.fileCount -ne `$preBuildSourceSnapshot.fileCount -or `$prePackageSourceSnapshot.algorithm -cne `$preBuildSourceSnapshot.algorithm) {`n    throw 'Source changed during release build.'`n}"
            after = "if (`$false) {`n    if (`$prePackageSourceSnapshot.sha256 -cne `$preBuildSourceSnapshot.sha256 -or `$prePackageSourceSnapshot.fileCount -ne `$preBuildSourceSnapshot.fileCount -or `$prePackageSourceSnapshot.algorithm -cne `$preBuildSourceSnapshot.algorithm) {`n        throw 'Source changed during release build.'`n    }`n}"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'review-survivor-release-comparison-deferred'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$prePackageSourceSnapshot.sha256 -cne `$preBuildSourceSnapshot.sha256 -or `$prePackageSourceSnapshot.fileCount -ne `$preBuildSourceSnapshot.fileCount -or `$prePackageSourceSnapshot.algorithm -cne `$preBuildSourceSnapshot.algorithm) {`n    throw 'Source changed during release build.'`n}"
            after = "`$deferredSourceComparison = {`n    if (`$prePackageSourceSnapshot.sha256 -cne `$preBuildSourceSnapshot.sha256 -or `$prePackageSourceSnapshot.fileCount -ne `$preBuildSourceSnapshot.fileCount -or `$prePackageSourceSnapshot.algorithm -cne `$preBuildSourceSnapshot.algorithm) {`n        throw 'Source changed during release build.'`n    }`n}"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'review-survivor-build-comparison-false-nested'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (`$sourceProvenance.snapshotSha256 -cne `$ExpectedSourceSnapshotSha256 -or [int64]`$sourceProvenance.snapshotFileCount -ne `$ExpectedSourceSnapshotFileCount -or `$sourceProvenance.snapshotAlgorithm -cne `$ExpectedSourceSnapshotAlgorithm) {`n    throw 'Packaging source snapshot differs from the pre-build snapshot.'`n}"
            after = "if (`$false) {`n    if (`$sourceProvenance.snapshotSha256 -cne `$ExpectedSourceSnapshotSha256 -or [int64]`$sourceProvenance.snapshotFileCount -ne `$ExpectedSourceSnapshotFileCount -or `$sourceProvenance.snapshotAlgorithm -cne `$ExpectedSourceSnapshotAlgorithm) {`n        throw 'Packaging source snapshot differs from the pre-build snapshot.'`n    }`n}"
            expected = @('BUILD_RELEASE_EXPECTED_SOURCE_SNAPSHOT_BINDING')
        },
        [pscustomobject]@{
            name = 'review-survivor-prebuild-field-reassigned'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot'
            after = "`$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot `$nativeQtRoot`n`$preBuildSourceSnapshot.sha256 = ('e' * 64)"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'review-survivor-prebuild-destructured'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot'
            after = "`$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot `$nativeQtRoot`n(`$preBuildSourceSnapshot, `$ignoredSnapshot) = @(`$preBuildSourceSnapshot, `$null)"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'review-survivor-prebuild-set-variable'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot'
            after = "`$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot `$nativeQtRoot`nSet-Variable -Name preBuildSourceSnapshot -Value ([pscustomobject]@{ sha256 = ('d' * 64); fileCount = 3; algorithm = 'fake' })"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'review-survivor-prepackage-field-reassigned'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$prePackageSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot $nativeQtRoot'
            after = "`$prePackageSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot `$nativeQtRoot`n`$prePackageSourceSnapshot.algorithm = `$preBuildSourceSnapshot.algorithm"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'review-survivor-provenance-field-reassigned'
            file = 'native-qt/qa/build-release.ps1'
            before = '$sourceProvenance = Get-ReleaseSourceProvenance -SourceRoot $repoRoot'
            after = "`$sourceProvenance = Get-ReleaseSourceProvenance -SourceRoot `$repoRoot`n`$sourceProvenance.snapshotSha256 = `$ExpectedSourceSnapshotSha256"
            expected = @('BUILD_RELEASE_EXPECTED_SOURCE_SNAPSHOT_BINDING')
        },
        [pscustomobject]@{
            name = 'review-survivor-provenance-set-variable'
            file = 'native-qt/qa/build-release.ps1'
            before = '$sourceProvenance = Get-ReleaseSourceProvenance -SourceRoot $repoRoot'
            after = "`$sourceProvenance = Get-ReleaseSourceProvenance -SourceRoot `$repoRoot`nSet-Variable -Name sourceProvenance -Value `$sourceProvenance"
            expected = @('BUILD_RELEASE_EXPECTED_SOURCE_SNAPSHOT_BINDING')
        },
        [pscustomobject]@{
            name = 'review-survivor-build-function-provider-shadow'
            file = 'native-qt/qa/build-release.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')`nSet-Item -Path Function:Get-ReleaseSourceSnapshot -Value { [pscustomobject]@{ sha256 = ('c' * 64); fileCount = 3; algorithm = 'fake' } }"
            expected = @('RELEASE_SOURCE_SNAPSHOT_SHARED_HELPER')
        },
        [pscustomobject]@{
            name = 'review-survivor-release-alias-shadow'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')`nSet-Alias -Name Get-ReleaseSourceSnapshot -Value Get-Date"
            expected = @('RELEASE_SOURCE_SNAPSHOT_SHARED_HELPER')
        },
        [pscustomobject]@{
            name = 'review-survivor-helper-root-early-return'
            file = 'native-qt/qa/release-source-snapshot.ps1'
            before = 'function Get-ReleaseSourceSnapshot([string]$SourceRoot) {'
            after = "return`nfunction Get-ReleaseSourceSnapshot([string]`$SourceRoot) {"
            expected = @('RELEASE_SOURCE_SNAPSHOT_SHARED_HELPER')
        },
        [pscustomobject]@{
            name = 'review-survivor-postfixture-dot-mutation'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureFailureGuard
            after = $fixtureFailureGuard + "`n. { `$script:allPass = `$true }"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'review-survivor-postfixture-direct-helper-mutation'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureFailureGuard
            after = $fixtureFailureGuard + "`nfunction Set-GatePass { `$script:allPass = `$true }`nSet-GatePass"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'review-survivor-postfixture-set-variable'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureFailureGuard
            after = $fixtureFailureGuard + "`nSet-Variable -Name allPass -Value `$true"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'review-survivor-postfixture-variable-provider-write'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureFailureGuard
            after = $fixtureFailureGuard + "`nSet-Item -Path Variable:allPass -Value `$true"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'review-survivor-publisher-parameter-reassigned'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $publisherConstantBinding
            after = "`$PublisherPath = `$stalePublisherPath`n" + $publisherConstantBinding
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'review-survivor-manifest-path-destructured'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $publisherConstantBinding
            after = "(`$ArtifactManifestPath, `$unusedManifestPath) = @(`$staleManifestPath, `$null)`n" + $publisherConstantBinding
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'review-survivor-manifest-hash-set-variable'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $publisherConstantBinding
            after = "Set-Variable -Name ArtifactManifestSha256 -Value ('b' * 64)`n" + $publisherConstantBinding
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'review-survivor-publisher-binding-reassigned'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureFailureGuard
            after = $fixtureFailureGuard + "`n`$publisherExe = `$stalePublisherPath"
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'review-survivor-manifest-path-binding-reassigned-before-edge'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureFailureGuard
            after = $fixtureFailureGuard + "`n`$script:artifactManifestPathBinding = `$staleManifestPath"
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'review-survivor-manifest-hash-binding-set-variable-before-firefox'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $edgeStep + "`n" + $edgeBinding
            after = $edgeStep + "`n" + $edgeBinding + "`nSet-Variable -Scope Script -Name artifactManifestSha256Binding -Value ('b' * 64)"
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'review-survivor-release-filehash-function-shadow'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')`nfunction Get-FileHash { [pscustomobject]@{ Hash = ('a' * 64) } }"
            expected = @('RELEASE_MANIFEST_SHA256_BINDING')
        },
        [pscustomobject]@{
            name = 'review-survivor-release-filehash-alias-shadow'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')`nNew-Alias -Name Get-FileHash -Value Get-Date"
            expected = @('RELEASE_MANIFEST_SHA256_BINDING')
        },
        [pscustomobject]@{
            name = 'review-survivor-staged-exe-mutated-after-manifest'
            file = 'native-qt/qa/build-release.ps1'
            before = '[System.IO.File]::WriteAllText($releaseManifestPath, $releaseManifestJson + "`n", $utf8WithoutBom)'
            after = "[System.IO.File]::WriteAllText(`$releaseManifestPath, `$releaseManifestJson + `"``n`", `$utf8WithoutBom)`nSet-Content -LiteralPath `$stagedExecutablePath -Value 'mutated-after-identity'"
            expected = @('BUILD_RELEASE_MANIFEST_FINAL_EXE_IDENTITY')
        },
        [pscustomobject]@{
            name = 'review-survivor-packaged-publisher-mutated-before-readiness'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$readinessArgs = @(''-File'', (Join-Path $PSScriptRoot ''run-release-readiness.ps1''), ''-PublisherPath'', $packagedPublisher'
            after = "Set-Content -LiteralPath `$packagedPublisher -Value 'mutated-before-readiness'`n`$readinessArgs = @('-File', (Join-Path `$PSScriptRoot 'run-release-readiness.ps1'), '-PublisherPath', `$packagedPublisher"
            expected = @('RELEASE_EXACT_READINESS_BINDINGS')
        },
        [pscustomobject]@{
            name = 'manifest-build-complete-payload-count-unbound'
            file = 'native-qt/qa/build-release.ps1'
            before = '        fileCount = $payloadInventory.fileCount'
            after = '        fileCount = 1'
            expected = @('BUILD_RELEASE_MANIFEST_COMPLETE_PAYLOAD')
        },
        [pscustomobject]@{
            name = 'manifest-build-wrong-schema-path'
            file = 'native-qt/qa/build-release.ps1'
            before = "`$releaseManifestPath = Join-Path `$stageDir 'release-artifact-manifest.json'"
            after = "`$releaseManifestPath = Join-Path `$stageDir 'release-metadata.json'"
            expected = @('BUILD_RELEASE_MANIFEST_SCHEMA_PATH')
        },
        [pscustomobject]@{
            name = 'manifest-build-written-after-zip'
            file = 'native-qt/qa/build-release.ps1'
            before = "[System.IO.File]::WriteAllText(`$releaseManifestPath, `$releaseManifestJson + `"``n`", `$utf8WithoutBom)`n`$releaseManifestSha256 = (Get-FileHash -LiteralPath `$releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()`nCompress-Archive -Path (Join-Path `$stageDir '*') -DestinationPath `$zipPath -Force"
            after = "Compress-Archive -Path (Join-Path `$stageDir '*') -DestinationPath `$zipPath -Force`n[System.IO.File]::WriteAllText(`$releaseManifestPath, `$releaseManifestJson + `"``n`", `$utf8WithoutBom)`n`$releaseManifestSha256 = (Get-FileHash -LiteralPath `$releaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()"
            expected = @('BUILD_RELEASE_MANIFEST_ORDER')
        },
        [pscustomobject]@{
            name = 'manifest-build-utf8-bom-enabled'
            file = 'native-qt/qa/build-release.ps1'
            before = '$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)'
            after = '$utf8WithoutBom = New-Object System.Text.UTF8Encoding($true)'
            expected = @('BUILD_RELEASE_MANIFEST_UTF8_NO_BOM')
        },
        [pscustomobject]@{
            name = 'manifest-build-debug-configuration-accepted'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (`$Configuration -cne 'Release') {"
            after = 'if ($false) {'
            expected = @('BUILD_RELEASE_MANIFEST_RELEASE_CONFIGURATION')
        },
        [pscustomobject]@{
            name = 'manifest-build-uppercase-commit-accepted'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (`$sourceProvenance.gitCommit -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') {"
            after = "if (`$sourceProvenance.gitCommit -notmatch '^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$') {"
            expected = @('BUILD_RELEASE_MANIFEST_SOURCE_PROVENANCE')
        },
        [pscustomobject]@{
            name = 'manifest-build-nonboolean-dirty-accepted'
            file = 'native-qt/qa/build-release.ps1'
            before = 'if ($sourceProvenance.dirty -isnot [bool]) {'
            after = 'if ($sourceProvenance.dirty -isnot [object]) {'
            expected = @('BUILD_RELEASE_MANIFEST_SOURCE_PROVENANCE')
        },
        [pscustomobject]@{
            name = 'manifest-build-uppercase-snapshot-accepted'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (`$sourceProvenance.snapshotSha256 -notmatch '^[0-9a-f]{64}$') {"
            after = "if (`$sourceProvenance.snapshotSha256 -notmatch '^[0-9A-Fa-f]{64}$') {"
            expected = @('BUILD_RELEASE_MANIFEST_SOURCE_PROVENANCE')
        },
        [pscustomobject]@{
            name = 'manifest-build-zero-file-snapshot-accepted'
            file = 'native-qt/qa/build-release.ps1'
            before = '[int64]$sourceProvenance.snapshotFileCount -lt 1'
            after = '[int64]$sourceProvenance.snapshotFileCount -lt 0'
            expected = @('BUILD_RELEASE_MANIFEST_SOURCE_PROVENANCE')
        },
        [pscustomobject]@{
            name = 'manifest-build-empty-algorithm-accepted'
            file = 'native-qt/qa/build-release.ps1'
            before = 'if ([string]::IsNullOrWhiteSpace([string]$sourceProvenance.snapshotAlgorithm)) {'
            after = 'if ([string]::IsNullOrWhiteSpace([string]$sourceProvenance.unrelated)) {'
            expected = @('BUILD_RELEASE_MANIFEST_SOURCE_PROVENANCE')
        },
        [pscustomobject]@{
            name = 'manifest-build-snapshot-case-insensitive-order'
            file = 'native-qt/qa/release-source-snapshot.ps1'
            before = '[System.StringComparer]::Ordinal'
            after = '[System.StringComparer]::OrdinalIgnoreCase'
            expected = @('BUILD_RELEASE_SOURCE_SNAPSHOT_DETERMINISTIC')
        },
        [pscustomobject]@{
            name = 'manifest-build-snapshot-bypasses-dedupe'
            file = 'native-qt/qa/release-source-snapshot.ps1'
            before = '$relativePaths = @($relativePathSet)'
            after = '$relativePaths = @($rawRelativePaths)'
            expected = @('BUILD_RELEASE_SOURCE_SNAPSHOT_DETERMINISTIC')
        },
        [pscustomobject]@{
            name = 'manifest-build-snapshot-algorithm-hides-order'
            file = 'native-qt/qa/release-source-snapshot.ps1'
            before = "algorithm = 'sha256(file-nul-path-nul-size-nul-content-nul)/git-ls-files-cached-others-exclude-standard/ordinal-sort-unique/v2'"
            after = "algorithm = 'sha256(file-nul-path-nul-size-nul-content-nul)/git-ls-files-cached-others-exclude-standard/v2'"
            expected = @('BUILD_RELEASE_SOURCE_SNAPSHOT_DETERMINISTIC')
        },
        [pscustomobject]@{
            name = 'manifest-build-hashes-prestage-path'
            file = 'native-qt/qa/build-release.ps1'
            before = '$stagedExecutableSha256 = (Get-FileHash -LiteralPath $stagedExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()'
            after = '$stagedExecutableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()'
            expected = @('BUILD_RELEASE_MANIFEST_FINAL_EXE_IDENTITY')
        },
        [pscustomobject]@{
            name = 'manifest-build-records-source-size'
            file = 'native-qt/qa/build-release.ps1'
            before = '        size = [int64]$stagedExecutableInfo.Length'
            after = '        size = [int64]$sourceExecutableInfo.Length'
            expected = @('BUILD_RELEASE_MANIFEST_FINAL_EXE_IDENTITY')
        },
        [pscustomobject]@{
            name = 'manifest-release-path-not-colocated'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '[System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($packagedPublisher))'
            after = '[System.IO.Path]::GetFullPath($distRoot)'
            expected = @('RELEASE_MANIFEST_COLOCATED_PATH')
        },
        [pscustomobject]@{
            name = 'manifest-release-path-not-leaf-guarded'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = 'Test-Path -LiteralPath $artifactManifestPath -PathType Leaf'
            after = 'Test-Path -LiteralPath $artifactManifestPath'
            expected = @('RELEASE_MANIFEST_COLOCATED_PATH')
        },
        [pscustomobject]@{
            name = 'manifest-release-hash-command-shadowable'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = 'Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $artifactManifestPath'
            after = 'Get-FileHash -LiteralPath $artifactManifestPath'
            expected = @('RELEASE_MANIFEST_SHA256_BINDING')
        },
        [pscustomobject]@{
            name = 'manifest-release-hash-not-lowercase'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ').Hash.ToLowerInvariant()'
            after = ').Hash'
            expected = @('RELEASE_MANIFEST_SHA256_BINDING')
        },
        [pscustomobject]@{
            name = 'manifest-release-uppercase-hash-accepted'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$artifactManifestSha256 -notmatch '^[0-9a-f]{64}$') {"
            after = "if (`$artifactManifestSha256 -notmatch '^[0-9A-Fa-f]{64}$') {"
            expected = @('RELEASE_MANIFEST_SHA256_BINDING')
        },
        [pscustomobject]@{
            name = 'manifest-release-readiness-stale-path'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "'-ArtifactManifestPath', `$artifactManifestPath"
            after = "'-ArtifactManifestPath', `$staleManifestPath"
            expected = @('RELEASE_EXACT_READINESS_BINDINGS')
        },
        [pscustomobject]@{
            name = 'manifest-release-readiness-stale-hash'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "'-ArtifactManifestSha256', `$artifactManifestSha256"
            after = "'-ArtifactManifestSha256', `$staleManifestSha256"
            expected = @('RELEASE_EXACT_READINESS_BINDINGS')
        },
        [pscustomobject]@{
            name = 'manifest-readiness-path-optional'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '[Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ArtifactManifestPath'
            after = '[ValidateNotNullOrEmpty()][string]$ArtifactManifestPath'
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'manifest-readiness-hash-validation-broadened'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = "[Parameter(Mandatory = `$true)][ValidatePattern('^[0-9a-f]{64}`$')][string]`$ArtifactManifestSha256"
            after = "[Parameter(Mandatory = `$true)][ValidatePattern('^[0-9A-Fa-f]{64}`$')][string]`$ArtifactManifestSha256"
            expected = @('READINESS_ARTIFACT_MANIFEST_PARAMETERS')
        },
        [pscustomobject]@{
            name = 'manifest-readiness-edge-omits-path'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '$signalEdgeArgs = @(''--prefix'', $script:repoRoot, ''run'', ''e2e:signaling-regressions:edge'', ''--'', "--publisher-path=$script:publisherExe", "--artifact-manifest-path=$script:artifactManifestPathBinding", "--artifact-manifest-sha256=$script:artifactManifestSha256Binding")'
            after = '$signalEdgeArgs = @(''--prefix'', $script:repoRoot, ''run'', ''e2e:signaling-regressions:edge'', ''--'', "--publisher-path=$script:publisherExe", "--artifact-manifest-sha256=$script:artifactManifestSha256Binding")'
            expected = @('READINESS_SIGNALING_EDGE')
        },
        [pscustomobject]@{
            name = 'manifest-readiness-firefox-hardcodes-hash'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '$signalFirefoxArgs = @(''--prefix'', $script:repoRoot, ''run'', ''e2e:signaling-regressions:firefox'', ''--'', "--publisher-path=$script:publisherExe", "--artifact-manifest-path=$script:artifactManifestPathBinding", "--artifact-manifest-sha256=$script:artifactManifestSha256Binding")'
            after = '$signalFirefoxArgs = @(''--prefix'', $script:repoRoot, ''run'', ''e2e:signaling-regressions:firefox'', ''--'', "--publisher-path=$script:publisherExe", "--artifact-manifest-path=$script:artifactManifestPathBinding", "--artifact-manifest-sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")'
            expected = @('READINESS_SIGNALING_FIREFOX')
        },
        [pscustomobject]@{
            name = 'source-snapshot-build-helper-import-diverged'
            file = 'native-qt/qa/build-release.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'stale-source-snapshot.ps1')"
            expected = @('RELEASE_SOURCE_SNAPSHOT_SHARED_HELPER')
        },
        [pscustomobject]@{
            name = 'source-snapshot-release-helper-import-diverged'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = ". (Join-Path `$PSScriptRoot 'release-source-snapshot.ps1')"
            after = ". (Join-Path `$PSScriptRoot 'stale-source-snapshot.ps1')"
            expected = @('RELEASE_SOURCE_SNAPSHOT_SHARED_HELPER')
        },
        [pscustomobject]@{
            name = 'source-snapshot-prebuild-captured-after-compile'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "`$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot `$nativeQtRoot`n& cmake --build `$BuildDir --config `$Configuration`n`$compileExit = `$LASTEXITCODE`nif (`$compileExit -ne 0) { throw 'Fresh compile failed.' }"
            after = "& cmake --build `$BuildDir --config `$Configuration`n`$compileExit = `$LASTEXITCODE`nif (`$compileExit -ne 0) { throw 'Fresh compile failed.' }`n`$preBuildSourceSnapshot = Get-ReleaseSourceSnapshot -SourceRoot `$nativeQtRoot"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'source-snapshot-postbuild-hash-not-compared'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$prePackageSourceSnapshot.sha256 -cne $preBuildSourceSnapshot.sha256 -or '
            after = ''
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'source-snapshot-package-gets-postbuild-hash'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "'-ExpectedSourceSnapshotSha256', `$preBuildSourceSnapshot.sha256"
            after = "'-ExpectedSourceSnapshotSha256', `$prePackageSourceSnapshot.sha256"
            expected = @('RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD')
        },
        [pscustomobject]@{
            name = 'source-snapshot-build-expected-hash-optional'
            file = 'native-qt/qa/build-release.ps1'
            before = "[Parameter(Mandatory = `$true)][ValidatePattern('^[0-9a-f]{64}`$')][string]`$ExpectedSourceSnapshotSha256"
            after = "[ValidatePattern('^[0-9a-f]{64}`$')][string]`$ExpectedSourceSnapshotSha256"
            expected = @('BUILD_RELEASE_EXPECTED_SOURCE_SNAPSHOT_BINDING')
        },
        [pscustomobject]@{
            name = 'source-snapshot-build-compares-wrong-hash'
            file = 'native-qt/qa/build-release.ps1'
            before = '$sourceProvenance.snapshotSha256 -cne $ExpectedSourceSnapshotSha256'
            after = '$sourceProvenance.snapshotSha256 -cne $staleSourceSnapshotSha256'
            expected = @('BUILD_RELEASE_EXPECTED_SOURCE_SNAPSHOT_BINDING')
        },
        [pscustomobject]@{
            name = 'fixture-run-step-action-not-invoked'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $runStepActionInvocation
            after = "        [System.Console]::WriteLine('action intentionally skipped')"
            expected = @('READINESS_RUN_STEP_CONTRACT')
        },
        [pscustomobject]@{
            name = 'fixture-npm-script-scope-reassigned'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $npmConstantBinding
            after = @'
$resolvedNpmExecutable = (Microsoft.PowerShell.Core\Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction Stop).Source
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'Set-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name npmExecutable -Scope Script -Value $resolvedNpmExecutable
$script:npmExecutable = 'C:\attacker\npm.cmd'
'@
            expected = @('READINESS_NPM_APPLICATION_RESOLUTION')
        },
        [pscustomobject]@{
            name = 'red-spoofed-set-variable-launches-resolved-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$qaResolvedNpm = (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'npm.cmd',
        [System.Management.Automation.CommandTypes]::Application
    )
).Source
function Set-Variable {
    param([string]$Name, [object]$Value)
    & $Value @signalFixtureGateArgs
}
Set-Variable -Name ignored -Value $qaResolvedNpm
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-qualified-set-variable-function-shadow-launches-resolved-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$qualifiedFunctionResolvedNpm = (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'npm.cmd',
        [System.Management.Automation.CommandTypes]::Application
    )
).Source
function Microsoft.PowerShell.Utility\Set-Variable {
    param([string]$Name, [object]$Value)
    & $Value @signalFixtureGateArgs
}
Microsoft.PowerShell.Utility\Set-Variable -Name ignored -Value $qualifiedFunctionResolvedNpm
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-qualified-set-variable-alias-shadow-launches-resolved-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$qualifiedAliasResolvedNpm = (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'npm.cmd',
        [System.Management.Automation.CommandTypes]::Application
    )
).Source
function Invoke-QualifiedSetVariableAlias {
    param([string]$Name, [object]$Value)
    & $Value @signalFixtureGateArgs
}
Microsoft.PowerShell.Utility\Set-Alias -Name 'Microsoft.PowerShell.Utility\Set-Variable' -Value Invoke-QualifiedSetVariableAlias
Microsoft.PowerShell.Utility\Set-Variable -Name ignored -Value $qualifiedAliasResolvedNpm
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-direct-dotnet-process-start-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

[void][System.Diagnostics.Process]::Start('npm.cmd', '--version')
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-dotnet-process-start-info-overload-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

[void][System.Diagnostics.Process]::Start(
    [System.Diagnostics.ProcessStartInfo]::new('npm.cmd', '--version')
)
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-dotnet-process-instance-start-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

$hiddenProcess = [System.Diagnostics.Process]::new()
$hiddenProcess.StartInfo = [System.Diagnostics.ProcessStartInfo]::new('npm.cmd', '--version')
[void]$hiddenProcess.Start()
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-dotnet-activator-process-instance-start-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

$activatedProcess = [System.Activator]::CreateInstance([System.Diagnostics.Process])
$activatedProcess.StartInfo = [System.Diagnostics.ProcessStartInfo]::new('npm.cmd', '--version')
[void]$activatedProcess.Start()
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-dotnet-process-type-variable-static-start-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

$processType = [System.Diagnostics.Process]
[void]$processType::Start('npm.cmd', '--version')
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-engine-set-variable-argument-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'Set-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name hiddenProcess -Scope Script -Value (
    [System.Diagnostics.Process]::Start('npm.cmd', '--version')
)
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-post-fixture-scriptblock-create-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n& ([scriptblock]::Create('npm.cmd --version'))"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-canonical-scriptblock-create-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$canonicalDeferred = [scriptblock]::Create('exit 0')`n" +
                $fixtureStep + "`n& `$canonicalDeferred"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-parenthesized-scriptblock-create-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$parenthesizedDeferred = ([scriptblock])::Create('exit 0')`n" +
                $fixtureStep + "`n& `$parenthesizedDeferred"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-type-variable-scriptblock-create-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$deferredScriptBlockType = [scriptblock]`n" +
                "`$typeVariableDeferred = `$deferredScriptBlockType::Create('exit 0')`n" +
                $fixtureStep + "`n& `$typeVariableDeferred"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-parenthesized-full-scriptblock-create-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$fullTypeDeferred = ([System.Management.Automation.ScriptBlock])::Create('exit 0')`n" +
                $fixtureStep + "`n& `$fullTypeDeferred"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-cast-type-scriptblock-create-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$castTypeDeferred = ([type]'System.Management.Automation.ScriptBlock')::Create('exit 0')`n" +
                $fixtureStep + "`n& `$castTypeDeferred"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-reflection-scriptblock-create-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$reflectedCreateMethod = [scriptblock].GetMethod('Create', [type[]]@([string]))
$reflectionDeferred = $reflectedCreateMethod.Invoke($null, @('exit 0'))
'@ + "`n" + $fixtureStep + "`n& `$reflectionDeferred"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-literal-scriptblock-invoke-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$literalInvokeDeferred = { exit 0 }`n" +
                $fixtureStep + "`n[void]`$literalInvokeDeferred.Invoke()"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-literal-scriptblock-call-operator-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$literalCallDeferred = { exit 0 }`n" +
                $fixtureStep + "`n& `$literalCallDeferred"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-deferred-literal-scriptblock-invoke-return-as-is-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$literalInvokeReturnDeferred = { exit 0 }`n" +
                $fixtureStep + "`n[void]`$literalInvokeReturnDeferred.InvokeReturnAsIs()"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-post-fixture-reflected-environment-exit-delegate'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

$reflectedExitMethod = [System.Environment].GetMethod('Exit', [type[]]@([int]))
$reflectedExitDelegate = $reflectedExitMethod.CreateDelegate([System.Action[int]])
[void]$reflectedExitDelegate.DynamicInvoke(0)
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-post-fixture-invoke-script-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n`$ExecutionContext.InvokeCommand.InvokeScript('npm.cmd --version')"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-post-fixture-computed-invoke-script-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

$computedInvokeMethod = 'InvokeScript'
$ExecutionContext.InvokeCommand.$computedInvokeMethod('npm.cmd --version')
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-post-fixture-new-scriptblock-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n& (`$ExecutionContext.InvokeCommand.NewScriptBlock('npm.cmd --version'))"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-post-fixture-powershell-builder-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

[void][System.Management.Automation.PowerShell]::Create().AddScript('npm.cmd --version').Invoke()
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-post-fixture-powershell-add-command-launches-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + @'

[void][System.Management.Automation.PowerShell]::Create().AddCommand('npm.cmd').AddArgument('--version').Invoke()
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-repo-root-reassigned'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $repoConstantBinding
            after = @(
                "`$resolvedRepoRoot = (Resolve-Path (Join-Path `$PSScriptRoot '..')).Path"
                'Microsoft.PowerShell.Utility\Set-Variable -Name repoRoot -Scope Script -Value $resolvedRepoRoot'
                "`$script:repoRoot = 'C:\attacker'"
            ) -join "`n"
            expected = @('READINESS_REPO_ROOT_CONSTANT')
        },
        [pscustomobject]@{
            name = 'red-fixture-psscriptroot-reassigned-before-binding'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $repoConstantBinding
            after = "`$PSScriptRoot = 'C:\alternate-readiness\qa'`n" + $repoConstantBinding
            expected = @('READINESS_REPO_ROOT_CONSTANT')
        },
        [pscustomobject]@{
            name = 'fixture-status-script-scope-reset'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureExitCapture + "`n" + $fixtureFailureGuard
            after = $fixtureExitCapture + "`n`$script:signalFixtureGateExit = 0`n" + $fixtureFailureGuard
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_FAIL_FAST')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-target-alias-duplicate'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @(
                '$npmAlias = $script:npmExecutable'
                "`$aliasedFixtureArgs = @('--prefix', `$script:repoRoot, 'run', 'gate:signaling-media-fixture')"
                '& $npmAlias @aliasedFixtureArgs'
                $fixtureStep
            ) -join "`n"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-invoked-scriptblock-duplicate'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @(
                '& {'
                "    `$scriptblockFixtureArgs = @('--prefix', `$script:repoRoot, 'run', 'gate:signaling-media-fixture')"
                '    & $script:npmExecutable @scriptblockFixtureArgs'
                '}'
                $fixtureStep
            ) -join "`n"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-invoked-scriptblock-duplicate-side-effect-assignment'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
& {
    $scriptblockFixtureArgs = @('--prefix', $script:repoRoot, 'run', 'gate:signaling-media-fixture')
    & $script:npmExecutable @scriptblockFixtureArgs
    $scriptblockFixtureArgs = @(
        [void][System.Diagnostics.Process]::Start('npm.cmd', '--version')
    )
}
'@ + "`n" + $fixtureStep
            expected = @(
                'READINESS_PRE_FIXTURE_EXECUTION_ALLOWLIST',
                'READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION'
            )
        },
        [pscustomobject]@{
            name = 'red-fixture-invoked-scriptblock-duplicate-multi-pipeline-execution'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
& {
    $scriptblockFixtureArgs = @('--prefix', $script:repoRoot, 'run', 'gate:signaling-media-fixture')
    $ExecutionContext.InvokeCommand.InvokeScript('npm.cmd --version') | & $script:npmExecutable @scriptblockFixtureArgs
}
'@ + "`n" + $fixtureStep
            expected = @(
                'READINESS_PRE_FIXTURE_EXECUTION_ALLOWLIST',
                'READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION'
            )
        },
        [pscustomobject]@{
            name = 'fixture-order-early-firefox-direct-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "& npm '--prefix' `$script:repoRoot 'run' 'e2e:signaling-regressions:firefox' '--' '--publisher-path' `$publisherExe`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'fixture-edge-record-unknown-conditional'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $edgeStep + "`n" + $edgeBinding
            after = "if (`$env:RUN_EDGE) {`n" + $edgeStep + "`n" + $edgeBinding + "`n}"
            expected = @('READINESS_SIGNALING_EDGE')
        },
        [pscustomobject]@{
            name = 'fixture-edge-record-while-false'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $edgeStep + "`n" + $edgeBinding
            after = "while (`$false) {`n" + $edgeStep + "`n" + $edgeBinding + "`n}"
            expected = @('READINESS_SIGNALING_EDGE')
        },
        [pscustomobject]@{
            name = 'fixture-firefox-record-empty-foreach'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $firefoxStep + "`n" + $firefoxBinding
            after = "foreach (`$item in @()) {`n" + $firefoxStep + "`n" + $firefoxBinding + "`n}"
            expected = @('READINESS_SIGNALING_FIREFOX')
        },
        [pscustomobject]@{
            name = 'fixture-package-alias-renamed'
            file = 'native-qt/package.json'
            before = '"gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",'
            after = '"gate:signaling-media-fixture-disabled": "node e2e/signaling-media-fixture-regression.js",'
            expected = @('SCRIPT_SIGNALING_MEDIA_FIXTURE_CONTRACT')
        },
        [pscustomobject]@{
            name = 'fixture-package-wrong-script'
            file = 'native-qt/package.json'
            before = '"gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",'
            after = '"gate:signaling-media-fixture": "node e2e/not-the-fixture-guard.js",'
            expected = @('SCRIPT_SIGNALING_MEDIA_FIXTURE_CONTRACT')
        },
        [pscustomobject]@{
            name = 'fixture-package-alias-case-only'
            file = 'native-qt/package.json'
            before = '"gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",'
            after = '"Gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",'
            expected = @('SCRIPT_SIGNALING_MEDIA_FIXTURE_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-release-wiring-runtime-probe-omitted'
            file = 'native-qt/package.json'
            before = '"gate:release-wiring": "' + $releaseWiringCommand + '"'
            after = '"gate:release-wiring": "' + $releaseWiringWithoutRuntime + '"'
            expected = @('SCRIPT_RELEASE_RUNTIME_PROBE_WIRED')
        },
        [pscustomobject]@{
            name = 'red-release-wiring-runtime-probe-decoy-echo'
            file = 'native-qt/package.json'
            before = '"gate:release-wiring": "' + $releaseWiringCommand + '"'
            after = '"gate:release-wiring": "' + $releaseWiringWithoutRuntime + ' && echo e2e/release-readiness-runtime-regression.ps1"'
            expected = @('SCRIPT_RELEASE_RUNTIME_PROBE_WIRED')
        },
        [pscustomobject]@{
            name = 'red-release-wiring-runtime-probe-prehook'
            file = 'native-qt/package.json'
            before = '    "gate:release-wiring": "' + $releaseWiringCommand + '"'
            after = '    "pregate:release-wiring": "exit 0",' + "`n" +
                '    "gate:release-wiring": "' + $releaseWiringCommand + '"'
            expected = @('SCRIPT_RELEASE_RUNTIME_PROBE_WIRED')
        },
        [pscustomobject]@{
            name = 'red-release-wiring-runtime-probe-posthook'
            file = 'native-qt/package.json'
            before = '    "gate:release-wiring": "' + $releaseWiringCommand + '"'
            after = '    "gate:release-wiring": "' + $releaseWiringCommand + '",' + "`n" +
                '    "postgate:release-wiring": "exit 0"'
            expected = @('SCRIPT_RELEASE_RUNTIME_PROBE_WIRED')
        },
        [pscustomobject]@{
            name = 'red-fixture-package-prehook-edge'
            file = 'native-qt/package.json'
            before = '    "gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",'
            after = @'
    "pregate:signaling-media-fixture": "npm run e2e:signaling-regressions:edge",
    "gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",
'@
            expected = @('SCRIPT_SIGNALING_MEDIA_FIXTURE_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-fixture-package-posthook-edge'
            file = 'native-qt/package.json'
            before = '    "gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",'
            after = @'
    "gate:signaling-media-fixture": "node e2e/signaling-media-fixture-regression.js",
    "postgate:signaling-media-fixture": "npm run e2e:signaling-regressions:edge",
'@
            expected = @('SCRIPT_SIGNALING_MEDIA_FIXTURE_CONTRACT')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-step-removed'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = '# deterministic-media fixture step removed'
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-alias-suffix'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = "'gate:signaling-media-fixture'"
            after = "'gate:signaling-media-fixture-disabled'"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-alias-case-only'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = "'gate:signaling-media-fixture'"
            after = "'Gate:signaling-media-fixture'"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-args-after-invocation'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @(
                $fixtureInvocation
                $fixtureArgsAssignment
                $fixtureExitCapture
                $fixtureFailureGuard
            ) -join "`n"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-fake-echo'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureInvocation
            after = "# & `$script:npmExecutable @signalFixtureGateArgs`n& cmd.exe /c 'echo gate:signaling-media-fixture'"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-static-false'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "if (`$false) {`n" + $fixtureStep + "`n}"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-duplicated'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-result-overwritten'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureExitCapture + "`n" + $fixtureFailureGuard
            after = $fixtureExitCapture + "`n`$signalFixtureGateExit = 0`n" + $fixtureFailureGuard
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_FAIL_FAST')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-binding-deferred'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureFailureGuard + "`n" + $edgeStep + "`n" + $edgeBinding
            after = $edgeStep + "`n" + $edgeBinding + "`n" + $fixtureFailureGuard
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_FAIL_FAST')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-after-browsers'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep + "`n" + $edgeStep + "`n" + $edgeBinding + "`n" + $firefoxStep + "`n" + $firefoxBinding
            after = $edgeStep + "`n" + $edgeBinding + "`n" + $firefoxStep + "`n" + $firefoxBinding + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-after-firefox-before-edge'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep + "`n" + $edgeStep + "`n" + $edgeBinding + "`n" + $firefoxStep + "`n" + $firefoxBinding
            after = $firefoxStep + "`n" + $firefoxBinding + "`n" + $fixtureStep + "`n" + $edgeStep + "`n" + $edgeBinding
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-exit-reset-before-guard'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureExitCapture + "`n" + $fixtureFailureGuard
            after = $fixtureExitCapture + "`n`$signalFixtureGateExit = 0`n" + $fixtureFailureGuard
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_FAIL_FAST')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-exit-capture-forced-success'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureExitCapture
            after = '$signalFixtureGateExit = 0'
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_FAIL_FAST')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-npm-function-shadow'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "function npm.cmd { return }`n" + $fixtureStep.Replace('& $script:npmExecutable @signalFixtureGateArgs', '& npm.cmd @signalFixtureGateArgs')
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-npm-resolver-weakened'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '[System.Management.Automation.CommandTypes]::Application'
            after = '[System.Management.Automation.CommandTypes]::All'
            expected = @('READINESS_NPM_APPLICATION_RESOLUTION')
        },
        [pscustomobject]@{
            name = 'fixture-readiness-noncanonical-duplicate'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n" + $noncanonicalFixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'fixture-order-early-edge-invocation'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $earlyEdgeInvocation + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'fixture-order-early-firefox-invocation'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $earlyFirefoxInvocation + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'fixture-order-dead-edge-record-spoof'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep + "`n" + $edgeStep + "`n" + $edgeBinding
            after = $earlyEdgeInvocation + "`n" + $fixtureStep + "`nif (`$false) {`n" + $edgeStep + "`n" + $edgeBinding + "`n}"
            expected = @('READINESS_SIGNALING_EDGE', 'READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'fixture-order-dead-firefox-record-spoof'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep + "`n" + $edgeStep + "`n" + $edgeBinding + "`n" + $firefoxStep + "`n" + $firefoxBinding
            after = $earlyFirefoxInvocation + "`n" + $fixtureStep + "`n" + $edgeStep + "`n" + $edgeBinding + "`nif (`$false) {`n" + $firefoxStep + "`n" + $firefoxBinding + "`n}"
            expected = @('READINESS_SIGNALING_FIREFOX', 'READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-top-level-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "exit 0`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-top-level-break'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "break`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-top-level-continue'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "continue`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-missing-label-break-in-loop'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "foreach (`$probeItem in 1) { break MissingLabel }`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-invoked-helper-break'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
function Invoke-EarlyBreak {
    break
}
Invoke-EarlyBreak
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-invoked-helper-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
function Invoke-EarlySuccess {
    exit 0
}
Invoke-EarlySuccess
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-invoked-scriptblock-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "& { exit 0 }`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-environment-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "[System.Environment]::Exit(0)`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-invoke-expression-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "Invoke-Expression 'exit 0'`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-invoke-expression-variable-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "`$advExecutor = 'Invoke-Expression'`n& `$advExecutor 'exit 0'`n" + $fixtureStep
            expected = @('READINESS_PRE_FIXTURE_EXECUTION_ALLOWLIST')
        },
        [pscustomobject]@{
            name = 'red-fixture-scriptblock-create-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "& ([scriptblock]::Create('exit 0'))`n" + $fixtureStep
            expected = @('READINESS_PRE_FIXTURE_EXECUTION_ALLOWLIST')
        },
        [pscustomobject]@{
            name = 'red-fixture-dot-sourced-success-exit'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = ". (Join-Path `$PSScriptRoot 'adv-early-success.ps1')`n" + $fixtureStep
            expected = @('READINESS_PRE_FIXTURE_EXECUTION_ALLOWLIST')
        },
        [pscustomobject]@{
            name = 'red-fixture-trap-continues-after-throw'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = "trap { continue }`n" + $fixtureStep.Replace('    exit $signalFixtureGateExit', "    throw 'fixture failed'")
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_FAIL_FAST')
        },
        [pscustomobject]@{
            name = 'red-fixture-second-direct-call-reuses-args'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n& `$script:npmExecutable @signalFixtureGateArgs"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-extra-npm-workspace-options'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureArgsAssignment
            after = "`$signalFixtureGateArgs = @('--prefix', `$script:repoRoot, 'run', 'gate:signaling-media-fixture', '--workspace', 'blank', '--if-present')"
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-helper-second-call-reuses-args'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n" + @'
function Invoke-SignalFixtureAgain {
    & $script:npmExecutable @signalFixtureGateArgs
}
Invoke-SignalFixtureAgain
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-helper-parameter-second-call'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n" + @'
function Invoke-SignalFixtureWithArguments([string[]]$PassedArguments) {
    & $script:npmExecutable @PassedArguments
}
Invoke-SignalFixtureWithArguments $signalFixtureGateArgs
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-helper-executable-and-arguments-second-call'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n" + @'
function Invoke-IndirectNpmAgain([string]$Executable, [string[]]$PassedArguments) {
    & $Executable @PassedArguments
}
Invoke-IndirectNpmAgain $script:npmExecutable $signalFixtureGateArgs
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-set-alias-to-npm-second-call'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = $fixtureStep + "`n" + @'
Microsoft.PowerShell.Utility\Set-Alias -Name npmAgain -Value $script:npmExecutable -Scope Script
npmAgain @signalFixtureGateArgs
'@
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-concatenated-alias'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$earlyEdgeAlias = 'e2e:signaling-regressions:' + 'edge'
$earlyEdgeArgs = @('--prefix', $script:repoRoot, 'run', $earlyEdgeAlias, '--', '--publisher-path', $publisherExe)
& $script:npmExecutable @earlyEdgeArgs
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-helper-executable-and-arguments'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$prematureEdgeArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:edge', '--', '--publisher-path', $publisherExe)
function Invoke-IndirectNpmEarly([string]$Executable, [string[]]$PassedArguments) {
    & $Executable @PassedArguments
}
Invoke-IndirectNpmEarly $script:npmExecutable $prematureEdgeArgs
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-cmd-wrapper'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
cmd.exe /c "npm --prefix `"$script:repoRoot`" run e2e:signaling-regressions:edge -- --publisher-path `"$publisherExe`""
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-literal-full-npm-path'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$prematureEdgeArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:edge', '--', '--publisher-path', $publisherExe)
& 'C:\Program Files\nodejs\npm.cmd' @prematureEdgeArgs
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-resolver-derived-npm-path'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$prematureNpmPath = (Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction Stop).Source
$prematureEdgeArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:edge', '--', '--publisher-path', $publisherExe)
& $prematureNpmPath @prematureEdgeArgs
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-second-engine-npm-resolver'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$prematureNpmPath = $ExecutionContext.SessionState.InvokeCommand.GetCommand('npm.cmd', [System.Management.Automation.CommandTypes]::Application).Source
$prematureEdgeArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:edge', '--', '--publisher-path', $publisherExe)
& $prematureNpmPath @prematureEdgeArgs
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-start-process'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$earlyEdgeProcessArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:edge', '--', '--publisher-path', $publisherExe)
Start-Process -FilePath $script:npmExecutable -ArgumentList $earlyEdgeProcessArgs -Wait
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-start-process-literal-npm'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$earlyEdgeLiteralArgs = @(
    '--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:edge', '--',
    "--publisher-path=$publisherExe"
)
Start-Process -FilePath 'npm.cmd' -ArgumentList $earlyEdgeLiteralArgs -Wait -NoNewWindow
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-applicationinfo-call'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$advEdgeArgs = @('--prefix', $script:repoRoot, 'run', 'e2e:signaling-regressions:edge', '--', "--publisher-path=$publisherExe")
& ($ExecutionContext.SessionState.InvokeCommand.GetCommand(
    'npm.cmd',
    [System.Management.Automation.CommandTypes]::Application
)) @advEdgeArgs
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-comspec'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$earlyEdgeViaComSpec = "npm.cmd --prefix `"$script:repoRoot`" run e2e:signaling-regressions:edge -- --publisher-path=`"$publisherExe`""
& $env:ComSpec /d /s /c $earlyEdgeViaComSpec
if ($LASTEXITCODE -ne 0) { throw 'Early Edge launch failed.' }
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-comspec-variable'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$advShell = $env:ComSpec
$advCmd = "npm.cmd --prefix `"$script:repoRoot`" run e2e:signaling-regressions:edge -- --publisher-path=`"$publisherExe`""
& $advShell /d /s /c $advCmd
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-early-edge-start-process-comspec'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
$advCmd = "npm.cmd --prefix `"$script:repoRoot`" run e2e:signaling-regressions:edge -- --publisher-path=`"$publisherExe`""
Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $advCmd) -Wait
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_ORDER')
        },
        [pscustomobject]@{
            name = 'red-fixture-duplicate-inline-start-process'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
Start-Process -FilePath 'npm.cmd' -ArgumentList @(
    '--prefix', $script:repoRoot, 'run', 'gate:signaling-media-fixture'
) -Wait -NoNewWindow
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-duplicate-comspec'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep
            after = @'
& $env:ComSpec /d /s /c "npm.cmd --prefix `"$script:repoRoot`" run gate:signaling-media-fixture"
if ($LASTEXITCODE -ne 0) { throw 'Duplicate fixture launch failed.' }
'@ + "`n" + $fixtureStep
            expected = @('READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-return-before-action'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $runStepCore
            after = @(
                '        $global:LASTEXITCODE = 0'
                '        return $true'
                $runStepActionInvocation
                $runStepExitGuard
            ) -join "`n"
            expected = @('READINESS_RUN_STEP_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-action-static-false'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $runStepActionInvocation
            after = "        if (`$false) {`n" + ($runStepActionInvocation -replace '(?m)^', '    ') + "`n        }"
            expected = @('READINESS_RUN_STEP_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-alias-shadow'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep + "`n" + $edgeStep + "`n" + $edgeBinding
            after = $fixtureStep + "`nMicrosoft.PowerShell.Utility\Set-Alias -Name Run-Step -Value Write-Output -Scope Script`n" +
                $edgeStep.Replace('& $script:runStepImplementation', 'Run-Step') + "`n" + $edgeBinding
            expected = @('READINESS_RUN_STEP_CONTRACT', 'READINESS_SIGNALING_EDGE')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-function-provider-overwrite'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $fixtureStep + "`n" + $edgeStep + "`n" + $edgeBinding
            after = $fixtureStep + "`nMicrosoft.PowerShell.Management\Set-Item -LiteralPath Function:Run-Step -Value { param(`$name, [scriptblock]`$action) return `$true } -Force`n" +
                $edgeStep.Replace('& $script:runStepImplementation', 'Run-Step') + "`n" + $edgeBinding
            expected = @('READINESS_RUN_STEP_CONTRACT', 'READINESS_SIGNALING_EDGE')
        },
        [pscustomobject]@{
            name = 'red-fixture-npm-source-prebind-set-variable'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $npmConstantBinding
            after = @'
$resolvedNpmExecutable = (Microsoft.PowerShell.Core\Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction Stop).Source
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'Set-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name resolvedNpmExecutable -Value 'C:\attacker\npm.cmd'
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'Set-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name npmExecutable -Scope Script -Option Constant -Value $resolvedNpmExecutable
'@
            expected = @('READINESS_NPM_APPLICATION_RESOLUTION')
        },
        [pscustomobject]@{
            name = 'red-fixture-repo-source-prebind-set-variable'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $repoConstantBinding
            after = @(
                "`$resolvedRepoRoot = (Resolve-Path (Join-Path `$PSScriptRoot '..')).Path"
                "Microsoft.PowerShell.Utility\Set-Variable -Name resolvedRepoRoot -Value 'C:\attacker'"
                'Microsoft.PowerShell.Utility\Set-Variable -Name repoRoot -Scope Script -Option Constant -Value $resolvedRepoRoot'
            ) -join "`n"
            expected = @('READINESS_REPO_ROOT_CONSTANT')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-status-reset-before-guard'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $runStepActionInvocation + "`n" + $runStepExitGuard
            after = $runStepActionInvocation + "`n        `$global:LASTEXITCODE = 0`n" + $runStepExitGuard
            expected = @('READINESS_RUN_STEP_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-guard-before-action'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $runStepActionInvocation + "`n" + $runStepExitGuard
            after = $runStepExitGuard + "`n" + $runStepActionInvocation
            expected = @('READINESS_RUN_STEP_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-action-parameter-rebound'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = @(
                '    param([string]$name, [scriptblock]$action)'
                ''
                '    [System.Console]::WriteLine("")'
            ) -join "`n"
            after = @(
                '    param([string]$name, [scriptblock]$action)'
                ''
                '    $action = { $global:LASTEXITCODE = 0 }'
                '    [System.Console]::WriteLine("")'
            ) -join "`n"
            expected = @('READINESS_RUN_STEP_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-guard-static-false'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $runStepExitGuard
            after = "        if (`$false) {`n            if (`$global:LASTEXITCODE -ne 0) { throw 'command failed' }`n        }"
            expected = @('READINESS_RUN_STEP_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-fixture-run-step-catch-true-before-false'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '        return $false'
            after = "        return `$true`n        return `$false"
            expected = @('READINESS_RUN_STEP_CONTRACT')
        },
        [pscustomobject]@{
            name = 'red-fixture-npm-constant-after-fixture'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $npmConstantBinding + "`n" + $repoDirectoryGuard + "`n" + $npmFileGuard + "`n" + $readinessPreFixtureSetup + "`n" + $fixtureStep
            after = $repoDirectoryGuard + "`n" + $readinessPreFixtureSetup + "`n" + $fixtureStep + "`n" + $npmConstantBinding + "`n" + $npmFileGuard
            expected = @('READINESS_NPM_APPLICATION_RESOLUTION')
        },
        [pscustomobject]@{
            name = 'red-fixture-qualified-get-command-function-collision'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $npmConstantBinding
            after = @'
function Microsoft.PowerShell.Core\Get-Command {
    [pscustomobject]@{ Source = 'C:\attacker\npm.cmd' }
}
$resolvedNpmExecutable = (Microsoft.PowerShell.Core\Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction Stop).Source
& (
    $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'Set-Variable',
        [System.Management.Automation.CommandTypes]::Cmdlet
    )
) -Name npmExecutable -Scope Script -Option Constant -Value $resolvedNpmExecutable
'@
            expected = @('READINESS_NPM_APPLICATION_RESOLUTION')
        },
        [pscustomobject]@{
            name = 'red-fixture-duplicate-edge-record-after-fixture'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $edgeStep + "`n" + $edgeBinding
            after = $edgeStep + "`n" + $edgeBinding + "`n" + $edgeStep + "`n" + $edgeBinding
            expected = @('READINESS_SIGNALING_EDGE')
        },
        [pscustomobject]@{
            name = 'unreachable-signaling-function'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = $edgeStep + "`n" + $edgeBinding
            after = "function Invoke-NeverCalledSignalEdge {`n" + (($edgeStep + "`n" + $edgeBinding) -replace '(?m)^', '    ') + "`n}"
            expected = @('READINESS_SIGNALING_EDGE')
        },
        [pscustomobject]@{
            name = 'missing-command'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '    & $script:npmExecutable @signalEdgeArgs'
            after = '    # command removed'
            expected = @('READINESS_SIGNALING_EDGE')
        },
        [pscustomobject]@{
            name = 'dead-command-result'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '$allPass = $allPass -and $controlEdgePass'
            after = '# result deliberately ignored'
            expected = @('READINESS_CONTROL_CENTER_EDGE')
        },
        [pscustomobject]@{
            name = 'fake-token-comment'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '    & $script:npmExecutable @signalFirefoxArgs'
            after = '    # npm run e2e:signaling-regressions:firefox'
            expected = @('READINESS_SIGNALING_FIREFOX')
        },
        [pscustomobject]@{
            name = 'wrong-artifact-variable'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = "'-ExpectedPublisherSha256', `$publisherHash, '-ExpectedPluginSha256', `$pluginHash, '-ExpectedSpoutSenderSha256', `$senderHash)`n        & `$script:npmExecutable @fullAlphaArgs"
            after = "'-ExpectedPublisherSha256', `$wrongPublisherHash, '-ExpectedPluginSha256', `$pluginHash, '-ExpectedSpoutSenderSha256', `$senderHash)`n        & `$script:npmExecutable @fullAlphaArgs"
            expected = @('READINESS_ALPHA_IDENTITIES_STABLE_AT_CALLS', 'READINESS_ALPHA_WORKFLOWS_SHARE_IDENTITIES')
        },
        [pscustomobject]@{
            name = 'shared-hash-reassigned-between-calls'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = "    `$allPass = `$allPass -and `$roomAlphaPass`n    `$fullAlphaPass = & `$script:runStepImplementation 'Full Alpha'"
            after = "    `$allPass = `$allPass -and `$roomAlphaPass`n    `$publisherHash = `$wrongHash`n    `$fullAlphaPass = & `$script:runStepImplementation 'Full Alpha'"
            expected = @('READINESS_ALPHA_IDENTITIES_STABLE_AT_CALLS')
        },
        [pscustomobject]@{
            name = 'missing-room-quality-command'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '        & $script:npmExecutable @roomAlphaArgs'
            after = '        # two-case workflow omitted'
            expected = @('READINESS_ALPHA_IDENTITIES_STABLE_AT_CALLS', 'READINESS_ALPHA_WORKFLOWS_SHARE_IDENTITIES', 'READINESS_ROOM_ALPHA_BLOCKING')
        },
        [pscustomobject]@{
            name = 'wrong-static-plugin-forwarding'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = "'gate:alpha-workflow-manifests', '--', '-PluginRepo', `$RoomAlphaPluginRepo"
            after = "'gate:alpha-workflow-manifests', '--', '-PluginRepo', `$implicitPluginRepo"
            expected = @('READINESS_ALPHA_MANIFEST_PLUGIN_FORWARDING')
        },
        [pscustomobject]@{
            name = 'user-specific-alpha-default'
            file = 'native-qt/e2e/ninja-plugin-alpha-e2e.ps1'
            before = "param([Parameter(Mandatory = `$true)][string]`$PluginRepo)"
            after = "param([string]`$PluginRepo = '..\..\ninja-plugin')"
            expected = @('ALPHA_SCRIPTS_NO_LOCAL_DEFAULTS')
        },
        [pscustomobject]@{
            name = 'analyzer-relative-default'
            file = 'native-qt/e2e/alpha-composite-analyzer-regression.js'
            before = "if (!arg) { throw new Error('plugin repo required'); }"
            after = "if (!arg) { return path.resolve(__dirname, '..', '..', 'ninja-plugin'); }"
            expected = @('ALPHA_SCRIPTS_NO_LOCAL_DEFAULTS')
        },
        [pscustomobject]@{
            name = 'newest-dist-selection'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = "    if ([string]::IsNullOrWhiteSpace(`$ExplicitPath)) { throw 'Explicit packaged publisher is required.' }"
            after = "    if ([string]::IsNullOrWhiteSpace(`$ExplicitPath)) { `$ExplicitPath = Get-ChildItem dist | Sort-Object LastWriteTime | Select-Object -First 1 }"
            expected = @('READINESS_EXACT_PACKAGED_PUBLISHER')
        },
        [pscustomobject]@{
            name = 'stale-readiness-report'
            file = 'native-qt/qa/build-release.ps1'
            before = 'Copy-Item game-capture.exe $stagedExecutablePath'
            after = "Copy-Item game-capture.exe `$stagedExecutablePath`n`$latestReport = Get-ChildItem 'release-readiness-*.md'"
            expected = @('BUILD_PACKAGE_NO_STALE_READINESS')
        },
        [pscustomobject]@{
            name = 'stale-setup-survives-missing-nsis'
            file = 'native-qt/qa/build-release.ps1'
            before = (@(
                'if (Test-Path -LiteralPath $installerVersionedPath) {'
                '    Remove-Item -LiteralPath $installerVersionedPath -Force'
                '    if (Test-Path -LiteralPath $installerVersionedPath) { throw ''Stale versioned installer survived cleanup.'' }'
                '}'
                'if (Test-Path -LiteralPath $installerStablePath) {'
                '    Remove-Item -LiteralPath $installerStablePath -Force'
                '    if (Test-Path -LiteralPath $installerStablePath) { throw ''Stale stable installer survived cleanup.'' }'
                '}'
            ) -join "`n")
            after = ''
            expected = @('BUILD_CLEARS_ALL_RELEASE_TARGETS_EARLY')
        },
        [pscustomobject]@{
            name = 'stale-portable-survives-missing-sevenzip'
            file = 'native-qt/qa/build-release.ps1'
            before = (@(
                'if (Test-Path -LiteralPath $portableVersionedPath) {'
                '    Remove-Item -LiteralPath $portableVersionedPath -Force'
                '    if (Test-Path -LiteralPath $portableVersionedPath) { throw ''Stale versioned portable survived cleanup.'' }'
                '}'
                'if (Test-Path -LiteralPath $portableStablePath) {'
                '    Remove-Item -LiteralPath $portableStablePath -Force'
                '    if (Test-Path -LiteralPath $portableStablePath) { throw ''Stale stable portable survived cleanup.'' }'
                '}'
            ) -join "`n")
            after = ''
            expected = @('BUILD_CLEARS_ALL_RELEASE_TARGETS_EARLY')
        },
        [pscustomobject]@{
            name = 'release-target-cleanup-silently-continues'
            file = 'native-qt/qa/build-release.ps1'
            before = '    Remove-Item -LiteralPath $zipPath -Force'
            after = '    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue'
            expected = @('BUILD_RELEASE_TARGET_CLEANUP_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'release-target-cleanup-error-swallowed'
            file = 'native-qt/qa/build-release.ps1'
            before = '    Remove-Item -LiteralPath $zipStablePath -Force'
            after = (@(
                '    try {'
                '        Remove-Item -LiteralPath $zipStablePath -Force'
                '    } catch {'
                '        Write-Warning ''Stable ZIP cleanup failed; continuing.'''
                '    }'
            ) -join "`n")
            expected = @('BUILD_RELEASE_TARGET_CLEANUP_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'post-delete-stale-guard-error-swallowed'
            file = 'native-qt/qa/build-release.ps1'
            before = '    if (Test-Path -LiteralPath $zipPath) { throw ''Stale versioned ZIP survived cleanup.'' }'
            after = (@(
                '    try {'
                '        if (Test-Path -LiteralPath $zipPath) { throw ''Stale versioned ZIP survived cleanup.'' }'
                '    } catch {'
                '        Write-Warning ''Post-delete stale ZIP was ignored.'''
                '    }'
            ) -join "`n")
            expected = @('BUILD_RELEASE_TARGET_CLEANUP_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'missing-required-final-presence-contract'
            file = 'native-qt/qa/build-release.ps1'
            before = (@(
                'if ($RequireReleaseArtifacts) {'
                '    $requiredReleaseArtifacts = @('
                '        (Join-Path $stageDir ''game-capture.exe''),'
                '        $zipPath,'
                '        $zipStablePath,'
                '        $portableVersionedPath,'
                '        $portableStablePath,'
                '        $installerVersionedPath,'
                '        $installerStablePath'
                '    )'
                '    foreach ($requiredReleaseArtifact in $requiredReleaseArtifacts) {'
                '        if (-not (Test-Path -LiteralPath $requiredReleaseArtifact -PathType Leaf)) {'
                '            throw ''Required release artifact was not generated by this invocation.'''
                '        }'
                '    }'
                '}'
            ) -join "`n")
            after = ''
            expected = @('BUILD_REQUIRE_RELEASE_ARTIFACTS_CONTRACT')
        },
        [pscustomobject]@{
            name = 'sevenzip-prerequisite-wrapped-in-require-switch'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (-not (Test-Path -LiteralPath `$sevenZipExe -PathType Leaf) -or -not (Test-Path -LiteralPath `$sevenZipSfx -PathType Leaf) -or -not (Test-Path -LiteralPath `$portableConfig -PathType Leaf)) { throw '7-Zip and portable-sfx-config are required.' }"
            after = "if (`$RequireReleaseArtifacts -and (-not (Test-Path -LiteralPath `$sevenZipExe -PathType Leaf) -or -not (Test-Path -LiteralPath `$sevenZipSfx -PathType Leaf) -or -not (Test-Path -LiteralPath `$portableConfig -PathType Leaf))) { throw '7-Zip and portable-sfx-config are required.' }"
            expected = @('BUILD_ALIAS_REQUIRED_TOOLS_PREFLIGHT_COHERENT')
        },
        [pscustomobject]@{
            name = 'nsis-prerequisite-wrapped-in-require-switch'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (-not `$makensis) { throw 'NSIS makensis is required.' }"
            after = "if (`$RequireReleaseArtifacts) {`n    if (-not `$makensis) { throw 'NSIS makensis is required.' }`n}"
            expected = @('BUILD_ALIAS_REQUIRED_TOOLS_PREFLIGHT_COHERENT')
        },
        [pscustomobject]@{
            name = 'required-tool-guard-after-first-cleanup'
            file = 'native-qt/qa/build-release.ps1'
            before = (@(
                'if (-not $makensis) { throw ''NSIS makensis is required.'' }'
                'if (Test-Path -LiteralPath $stageDir) {'
                '    Remove-Item -LiteralPath $stageDir -Recurse -Force'
                '    if (Test-Path -LiteralPath $stageDir) { throw ''Stale stage directory survived cleanup.'' }'
                '}'
            ) -join "`n")
            after = (@(
                'if (Test-Path -LiteralPath $stageDir) {'
                '    Remove-Item -LiteralPath $stageDir -Recurse -Force'
                '    if (Test-Path -LiteralPath $stageDir) { throw ''Stale stage directory survived cleanup.'' }'
                '}'
                'if (-not $makensis) { throw ''NSIS makensis is required.'' }'
            ) -join "`n")
            expected = @('BUILD_ALIAS_REQUIRED_TOOLS_PREFLIGHT_COHERENT')
        },
        [pscustomobject]@{
            name = 'cleanup-before-ffmpeg-preflight'
            file = 'native-qt/qa/build-release.ps1'
            before = '$ffmpegManifest = $null'
            after = (@(
                'if (Test-Path -LiteralPath $stageDir) {'
                '    Remove-Item -LiteralPath $stageDir -Recurse -Force'
                '    if (Test-Path -LiteralPath $stageDir) { throw ''Stale stage directory survived cleanup.'' }'
                '}'
                '$ffmpegManifest = $null'
            ) -join "`n")
            expected = @('BUILD_ALIAS_REQUIRED_TOOLS_PREFLIGHT_COHERENT', 'BUILD_RELEASE_PREFLIGHT_BEFORE_CLEANUP')
            justification = 'Moving cleanup before FFmpeg preflight also necessarily places cleanup before the unconditional setup/portable tool guards.'
        },
        [pscustomobject]@{
            name = 'ffmpeg-required-guard-dead-static-false'
            file = 'native-qt/qa/build-release.ps1'
            before = (@(
                '} elseif (-not $AllowMissingFfmpeg) {'
                '    throw ''FFmpeg bundle is required.'''
                '}'
            ) -join "`n")
            after = (@(
                '}'
                'if ($false) {'
                '    if (-not $AllowMissingFfmpeg) {'
                '        throw ''FFmpeg bundle is required.'''
                '    }'
                '}'
            ) -join "`n")
            expected = @('BUILD_RELEASE_PREFLIGHT_BEFORE_CLEANUP')
        },
        [pscustomobject]@{
            name = 'stable-included-in-dist-sign-selection'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '        Get-Item -LiteralPath $versionedPortablePath'
            after = "        Get-Item -LiteralPath `$versionedPortablePath`n        Get-Item -LiteralPath `$stablePortablePath"
            expected = @('SIGN_DIST_VERSIONED_EXES_ONLY')
        },
        [pscustomobject]@{
            name = 'broad-wildcard-dist-sign-selection'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = "`$allExes = @(`n        Get-Item -LiteralPath `$versionedSetupPath`n        Get-Item -LiteralPath `$versionedPortablePath`n    )"
            after = "`$canonicalNames = @(`"game-capture-`$Version-setup.exe`", `"game-capture-`$Version-portable.exe`")`n    `$allExes = Get-ChildItem -LiteralPath `$DistDir -File -Filter '*.exe' | Where-Object { `$canonicalNames -contains `$_.Name -or `$_.Name -like '*.exe' }"
            expected = @('SIGN_DIST_VERSIONED_EXES_ONLY')
        },
        [pscustomobject]@{
            name = 'dist-exe-leaf-check-weakened'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if (-not (Test-Path -LiteralPath $versionedSetupPath -PathType Leaf)) { throw ''Versioned setup EXE is required.'' }'
            after = '    if (-not (Test-Path -LiteralPath $versionedSetupPath)) { throw ''Versioned setup EXE is required.'' }'
            expected = @('SIGN_INPUTS_LITERAL_LEAF_ONLY')
        },
        [pscustomobject]@{
            name = 'filepaths-resolution-wildcard-aware'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = (@(
                '        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ''Explicit signing input must be a literal file.'' }'
                '        $resolved = Resolve-Path -LiteralPath $path'
                '        $allExes += Get-Item -LiteralPath $resolved'
            ) -join "`n")
            after = (@(
                '        if (-not (Test-Path $path -PathType Leaf)) { throw ''Explicit signing input must be a literal file.'' }'
                '        $resolved = Resolve-Path $path'
                '        $allExes += Get-Item -LiteralPath $resolved'
            ) -join "`n")
            expected = @('SIGN_INPUTS_LITERAL_LEAF_ONLY')
        },
        [pscustomobject]@{
            name = 'authenticode-verification-wildcard-filepath'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file.FullName'
            after = '        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -FilePath $file.FullName'
            expected = @('SIGN_AUTHENTICODE_LITERAL_PATH')
        },
        [pscustomobject]@{
            name = 'custom-authenticode-shadowed-command'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = 'function Sign-File([string]$filePath) { Write-Host "Signing $filePath" }'
            after = "function Get-AuthenticodeSignature { param([string]`$LiteralPath) return `$null }`nfunction Sign-File([string]`$filePath) { Write-Host `"Signing `$filePath`" }"
            expected = @('SIGN_AUTHENTICODE_LITERAL_PATH')
        },
        [pscustomobject]@{
            name = 'custom-authenticode-unknown-conditional'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file.FullName'
            after = '        if ($EnableVerification) { $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file.FullName }'
            expected = @('SIGN_AUTHENTICODE_LITERAL_PATH')
        },
        [pscustomobject]@{
            name = 'authenticode-verification-unqualified-command'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file.FullName'
            after = '        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName'
            expected = @('SIGN_AUTHENTICODE_LITERAL_PATH')
        },
        [pscustomobject]@{
            name = 'authenticode-failure-guard-ignored'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '        if (-not (Test-SignatureAcceptable -signature $signature)) { throw ''Signature check failed.'' }'
            after = '        Write-Host ''Signature verification result ignored.'''
            expected = @('SIGN_AUTHENTICODE_FAILURE_POLICY')
        },
        [pscustomobject]@{
            name = 'authenticode-hard-failures-omit-not-signed'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    $hardFailures = @(''NotSigned'', ''HashMismatch'', ''NotSupported'', ''Incompatible'')'
            after = '    $hardFailures = @(''HashMismatch'', ''NotSupported'', ''Incompatible'')'
            expected = @('SIGN_AUTHENTICODE_FAILURE_POLICY')
        },
        [pscustomobject]@{
            name = 'authenticode-helper-unconditional-early-accept'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    $hardFailures = @(''NotSigned'', ''HashMismatch'', ''NotSupported'', ''Incompatible'')'
            after = "    return `$true`n    `$hardFailures = @('NotSigned', 'HashMismatch', 'NotSupported', 'Incompatible')"
            expected = @('SIGN_AUTHENTICODE_FAILURE_POLICY')
        },
        [pscustomobject]@{
            name = 'authenticode-helper-conditional-early-accept'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    $hardFailures = @(''NotSigned'', ''HashMismatch'', ''NotSupported'', ''Incompatible'')'
            after = "    if (`$BypassSignaturePolicy) { return `$true }`n    `$hardFailures = @('NotSigned', 'HashMismatch', 'NotSupported', 'Incompatible')"
            expected = @('SIGN_AUTHENTICODE_FAILURE_POLICY')
        },
        [pscustomobject]@{
            name = 'authenticode-helper-hard-failure-guard-before-array'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = "    `$hardFailures = @('NotSigned', 'HashMismatch', 'NotSupported', 'Incompatible')`n    if (`$hardFailures -contains [string]`$signature.Status) { return `$false }"
            after = "    if (`$hardFailures -contains [string]`$signature.Status) { return `$false }`n    `$hardFailures = @('NotSigned', 'HashMismatch', 'NotSupported', 'Incompatible')"
            expected = @('SIGN_AUTHENTICODE_FAILURE_POLICY')
        },
        [pscustomobject]@{
            name = 'authenticode-catch-records-ignored-variable'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '        $failures += [pscustomobject]@{'
            after = '        $ignoredFailures += [pscustomobject]@{'
            expected = @('SIGN_AUTHENTICODE_FAILURE_POLICY')
        },
        [pscustomobject]@{
            name = 'authenticode-fail-on-error-exits-zero'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ($FailOnError) { exit 1 }'
            after = '    if ($FailOnError) { exit 0 }'
            expected = @('SIGN_AUTHENTICODE_FAILURE_POLICY')
        },
        [pscustomobject]@{
            name = 'manual-stable-destination-type-guard-removed'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Test-Path -LiteralPath $stableSetupPath) -and -not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup destination must be absent or a literal file.'' }'
            after = '    if ($false) { throw ''Stable setup destination type ignored.'' }'
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'manual-stable-copy-result-leaf-guard-removed'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if (-not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup alias was not created as a literal file.'' }'
            after = '    Write-Host ''Stable setup copy result type ignored.'''
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'manual-stable-copy-hash-check-self-compares-source'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
            after = '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'custom-stable-hash-guard-swallowed'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
            after = "    try {`n        if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath `$versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath `$stableSetupPath -Algorithm SHA256).Hash) { throw 'Stable setup alias hash mismatch.' }`n    } catch { Write-Warning 'stable hash mismatch ignored' }"
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-destination-type-guard-swallowed'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Test-Path -LiteralPath $stableSetupPath) -and -not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup destination must be absent or a literal file.'' }'
            after = "    try {`n        if ((Test-Path -LiteralPath `$stableSetupPath) -and -not (Test-Path -LiteralPath `$stableSetupPath -PathType Leaf)) { throw 'Stable setup destination must be absent or a literal file.' }`n    } catch { Write-Warning 'stable destination type ignored' }"
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-destination-type-guard-unknown-wrapper'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Test-Path -LiteralPath $stableSetupPath) -and -not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup destination must be absent or a literal file.'' }'
            after = "    if (`$EnableStableTypeCheck) {`n        if ((Test-Path -LiteralPath `$stableSetupPath) -and -not (Test-Path -LiteralPath `$stableSetupPath -PathType Leaf)) { throw 'Stable setup destination must be absent or a literal file.' }`n    }"
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-copy-leaf-guard-swallowed'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if (-not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup alias was not created as a literal file.'' }'
            after = "    try {`n        if (-not (Test-Path -LiteralPath `$stableSetupPath -PathType Leaf)) { throw 'Stable setup alias was not created as a literal file.' }`n    } catch { Write-Warning 'stable copy leaf failure ignored' }"
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-copy-leaf-guard-unknown-wrapper'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if (-not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup alias was not created as a literal file.'' }'
            after = "    if (`$EnableStableLeafCheck) {`n        if (-not (Test-Path -LiteralPath `$stableSetupPath -PathType Leaf)) { throw 'Stable setup alias was not created as a literal file.' }`n    }"
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-hash-guard-unknown-wrapper'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
            after = "    if (`$EnableHashCheck) {`n        if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath `$versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath `$stableSetupPath -Algorithm SHA256).Hash) { throw 'Stable setup alias hash mismatch.' }`n    }"
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-hash-guard-extra-enable-conjunct'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
            after = '    if ($EnableHashCheck -and ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash)) { throw ''Stable setup alias hash mismatch.'' }'
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-hash-unqualified-command'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
            after = '    if ((Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-hash-unqualified-local-shadow'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
            after = "    function Get-FileHash { [pscustomobject]@{ Hash = 'same' } }`n    if ((Get-FileHash -LiteralPath `$versionedSetupPath -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath `$stableSetupPath -Algorithm SHA256).Hash) { throw 'Stable setup alias hash mismatch.' }"
            expected = @('SIGN_DIST_STABLE_ALIAS_INTEGRITY')
        },
        [pscustomobject]@{
            name = 'stable-copy-moved-before-signing'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (Test-Path `$signScript) {`n    try {`n        & `$signScript -FilePaths `$releaseExePaths`n    } catch {`n        Write-Warning 'Code-signing step failed; continuing.'`n    }`n}`nCopy-Item -Path `$portableVersionedPath -Destination `$portableStablePath -Force"
            after = "Copy-Item -Path `$portableVersionedPath -Destination `$portableStablePath -Force`nif (Test-Path `$signScript) {`n    try {`n        & `$signScript -FilePaths `$releaseExePaths`n    } catch {`n        Write-Warning 'Code-signing step failed; continuing.'`n    }`n}"
            expected = @('BUILD_STABLE_EXE_ALIASES_AFTER_SIGNING', 'BUILD_STABLE_EXE_ALIASES_IMMUTABLE_AFTER_COPY')
            justification = 'Moving a stable copy before canonical signing necessarily violates both post-sign ordering and post-copy immutability.'
        },
        [pscustomobject]@{
            name = 'stable-copy-uses-wrong-canonical-source'
            file = 'native-qt/qa/build-release.ps1'
            before = 'Copy-Item -Path $portableVersionedPath -Destination $portableStablePath -Force'
            after = 'Copy-Item -Path $installerVersionedPath -Destination $portableStablePath -Force'
            expected = @('BUILD_STABLE_EXE_ALIAS_SOURCES')
        },
        [pscustomobject]@{
            name = 'duplicate-canonical-release-signing'
            file = 'native-qt/qa/build-release.ps1'
            before = '        & $signScript -FilePaths $releaseExePaths'
            after = "        & `$signScript -FilePaths `$releaseExePaths`n        & `$signScript -FilePaths `$releaseExePaths"
            expected = @('BUILD_VERSIONED_EXES_SIGNED_ONCE')
        },
        [pscustomobject]@{
            name = 'second-canonical-release-signing-alias'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (Test-Path `$signScript) {`n    try {`n        & `$signScript -FilePaths `$releaseExePaths`n    } catch {`n        Write-Warning 'Code-signing step failed; continuing.'`n    }`n}"
            after = "if (Test-Path `$signScript) {`n    try {`n        & `$signScript -FilePaths `$releaseExePaths`n    } catch {`n        Write-Warning 'Code-signing step failed; continuing.'`n    }`n}`n`$secondSignScript = Join-Path `$PSScriptRoot 'sign-artifacts.ps1'`n& `$secondSignScript -FilePaths `$releaseExePaths"
            expected = @('BUILD_VERSIONED_EXES_SIGNED_ONCE')
        },
        [pscustomobject]@{
            name = 'canonical-release-signing-only-in-static-false-branch'
            file = 'native-qt/qa/build-release.ps1'
            before = '        & $signScript -FilePaths $releaseExePaths'
            after = "        if (`$false) {`n            & `$signScript -FilePaths `$releaseExePaths`n        }"
            expected = @('BUILD_VERSIONED_EXES_SIGNED_ONCE')
        },
        [pscustomobject]@{
            name = 'canonical-signer-assignment-only-in-static-false-branch'
            file = 'native-qt/qa/build-release.ps1'
            before = '$signScript = Join-Path $PSScriptRoot ''sign-artifacts.ps1'''
            after = "`$signScript = Join-Path `$attackerRoot 'sign-artifacts.ps1'`nif (`$false) {`n    `$signScript = Join-Path `$PSScriptRoot 'sign-artifacts.ps1'`n}"
            expected = @('BUILD_VERSIONED_EXES_SIGNED_ONCE')
        },
        [pscustomobject]@{
            name = 'canonical-signer-augmented-before-invocation'
            file = 'native-qt/qa/build-release.ps1'
            before = '$signScript = Join-Path $PSScriptRoot ''sign-artifacts.ps1'''
            after = "`$signScript = Join-Path `$PSScriptRoot 'sign-artifacts.ps1'`n`$signScript += '.disabled'"
            expected = @('BUILD_VERSIONED_EXES_SIGNED_ONCE')
        },
        [pscustomobject]@{
            name = 'stable-alias-mutated-after-copy'
            file = 'native-qt/qa/build-release.ps1'
            before = 'Copy-Item -Path $installerVersionedPath -Destination $installerStablePath -Force'
            after = "Copy-Item -Path `$installerVersionedPath -Destination `$installerStablePath -Force`nSet-Content -LiteralPath `$portableStablePath -Value 'mutated'"
            expected = @('BUILD_STABLE_EXE_ALIASES_IMMUTABLE_AFTER_COPY')
        },
        [pscustomobject]@{
            name = 'build-alias-identity-gate-removed'
            file = 'native-qt/qa/build-release.ps1'
            before = "`$buildAliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`nif (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }`n& powershell.exe @buildAliasIdentityArgs`n`$buildAliasIdentityExit = `$LASTEXITCODE`nif (`$buildAliasIdentityExit -ne 0) { throw 'Built release artifact alias identity validation failed.' }`n"
            after = ''
            expected = @('BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'build-alias-identity-gate-moved-after-virustotal'
            file = 'native-qt/qa/build-release.ps1'
            before = "`$buildAliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`nif (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }`n& powershell.exe @buildAliasIdentityArgs`n`$buildAliasIdentityExit = `$LASTEXITCODE`nif (`$buildAliasIdentityExit -ne 0) { throw 'Built release artifact alias identity validation failed.' }`n`$vtScript = Join-Path `$PSScriptRoot 'submit-virustotal.ps1'`n& `$vtScript -DistDir `$distRoot -Version `$Version"
            after = "`$vtScript = Join-Path `$PSScriptRoot 'submit-virustotal.ps1'`n& `$vtScript -DistDir `$distRoot -Version `$Version`n`$buildAliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`nif (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }`n& powershell.exe @buildAliasIdentityArgs`n`$buildAliasIdentityExit = `$LASTEXITCODE`nif (`$buildAliasIdentityExit -ne 0) { throw 'Built release artifact alias identity validation failed.' }"
            expected = @('BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'dist-signing-version-guard-removed'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = "if (`$DistDir -and [string]::IsNullOrWhiteSpace(`$Version)) {`n    throw 'Version is required with DistDir.'`n}"
            after = "if (`$false) { throw 'Version is optional.' }"
            expected = @('SIGN_DIST_REQUIRES_EXACT_VERSION')
        },
        [pscustomobject]@{
            name = 'dist-signing-version-allows-path-input'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = "[ValidatePattern('^\d+\.\d+\.\d+`$')][string]`$Version = ''"
            after = "[ValidatePattern('^.+`$')][string]`$Version = ''"
            expected = @('SIGN_DIST_REQUIRES_EXACT_VERSION')
        },
        [pscustomobject]@{
            name = 'manual-stable-realias-moved-before-signing'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = (@(
                '$failures = @()'
                'foreach ($file in $allExes) {'
                '    try {'
                '        Sign-File -filePath $file.FullName'
                '        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file.FullName'
                '        if (-not (Test-SignatureAcceptable -signature $signature)) { throw ''Signature check failed.'' }'
                '    } catch {'
                '        $failures += [pscustomobject]@{'
                '            Name = $file.Name'
                '            Error = $_.Exception.Message'
                '        }'
                '    }'
                '}'
                'if ($DistDir) {'
                '    $stableSetupPath = Join-Path $DistDir ''game-capture-setup.exe'''
                '    $stablePortablePath = Join-Path $DistDir ''game-capture-portable.exe'''
                '    if ((Test-Path -LiteralPath $stableSetupPath) -and -not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup destination must be absent or a literal file.'' }'
                '    if ((Test-Path -LiteralPath $stablePortablePath) -and -not (Test-Path -LiteralPath $stablePortablePath -PathType Leaf)) { throw ''Stable portable destination must be absent or a literal file.'' }'
                '    Copy-Item -LiteralPath $versionedSetupPath -Destination $stableSetupPath -Force'
                '    Copy-Item -LiteralPath $versionedPortablePath -Destination $stablePortablePath -Force'
                '    if (-not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup alias was not created as a literal file.'' }'
                '    if (-not (Test-Path -LiteralPath $stablePortablePath -PathType Leaf)) { throw ''Stable portable alias was not created as a literal file.'' }'
                '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
                '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedPortablePath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stablePortablePath -Algorithm SHA256).Hash) { throw ''Stable portable alias hash mismatch.'' }'
                '}'
            ) -join "`n")
            after = (@(
                'if ($DistDir) {'
                '    $stableSetupPath = Join-Path $DistDir ''game-capture-setup.exe'''
                '    $stablePortablePath = Join-Path $DistDir ''game-capture-portable.exe'''
                '    if ((Test-Path -LiteralPath $stableSetupPath) -and -not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup destination must be absent or a literal file.'' }'
                '    if ((Test-Path -LiteralPath $stablePortablePath) -and -not (Test-Path -LiteralPath $stablePortablePath -PathType Leaf)) { throw ''Stable portable destination must be absent or a literal file.'' }'
                '    Copy-Item -LiteralPath $versionedSetupPath -Destination $stableSetupPath -Force'
                '    Copy-Item -LiteralPath $versionedPortablePath -Destination $stablePortablePath -Force'
                '    if (-not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) { throw ''Stable setup alias was not created as a literal file.'' }'
                '    if (-not (Test-Path -LiteralPath $stablePortablePath -PathType Leaf)) { throw ''Stable portable alias was not created as a literal file.'' }'
                '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) { throw ''Stable setup alias hash mismatch.'' }'
                '    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedPortablePath -Algorithm SHA256).Hash -cne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stablePortablePath -Algorithm SHA256).Hash) { throw ''Stable portable alias hash mismatch.'' }'
                '}'
                '$failures = @()'
                'foreach ($file in $allExes) {'
                '    try {'
                '        Sign-File -filePath $file.FullName'
                '        $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file.FullName'
                '        if (-not (Test-SignatureAcceptable -signature $signature)) { throw ''Signature check failed.'' }'
                '    } catch {'
                '        $failures += [pscustomobject]@{'
                '            Name = $file.Name'
                '            Error = $_.Exception.Message'
                '        }'
                '    }'
                '}'
            ) -join "`n")
            expected = @('SIGN_DIST_REALIASES_AFTER_SIGNING')
        },
        [pscustomobject]@{
            name = 'manual-stable-realias-source-reversed'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = '    Copy-Item -LiteralPath $versionedSetupPath -Destination $stableSetupPath -Force'
            after = '    Copy-Item -LiteralPath $stableSetupPath -Destination $versionedSetupPath -Force'
            expected = @('SIGN_DIST_REALIASES_AFTER_SIGNING')
        },
        [pscustomobject]@{
            name = 'manual-stable-realias-dead-conditional'
            file = 'native-qt/qa/sign-artifacts.ps1'
            before = 'if ($DistDir) {'
            after = 'if ($false) {'
            expected = @('SIGN_DIST_REALIASES_AFTER_SIGNING')
        },
        [pscustomobject]@{
            name = 'alias-mismatch-throw-removed'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            after = "if (`$aliasIdentityExit -ne 0) { Write-Warning 'Alias mismatch ignored.' }"
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'alias-mismatch-fake-throw-string'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            after = "if (`$aliasIdentityExit -ne 0) { Write-Warning 'throw ignored; alias mismatch accepted' }"
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'alias-mismatch-fake-throw-comment'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            after = "if (`$aliasIdentityExit -ne 0) {`n    # throw 'Release artifact alias identity validation failed.'`n    Write-Warning 'Alias mismatch accepted.'`n}"
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'alias-mismatch-exit-neutralized'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "`$aliasIdentityExit = `$LASTEXITCODE`nif (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            after = "`$aliasIdentityExit = `$LASTEXITCODE`n`$aliasIdentityExit = 0`nif (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-setup-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[System.IO.File]::WriteAllText((Join-Path `$PSScriptRoot '../dist/game-capture-`$Version-setup.exe'), 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-create-with-aliases'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$fileApi = [System.IO.File]`n`$lateArtifactPath = [System.IO.Path]::Combine(`$distRoot, 'game-capture-portable.exe')`n[void]`$fileApi::CreateText(`$lateArtifactPath)"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-copy-to-release-artifact'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[System.IO.File]::Copy((Join-Path `$PSScriptRoot '../logs/source.zip'), (Join-Path `$distRoot 'game-capture-`$Version-win64.zip'), `$true)"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-move-release-artifact'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[System.IO.File]::Move(`$stablePortable, (Join-Path `$PSScriptRoot '../logs/moved-portable.exe'))"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-replace-release-artifact'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[System.IO.File]::Replace((Join-Path `$PSScriptRoot '../logs/source.tmp'), `$versionedSetup, (Join-Path `$PSScriptRoot '../logs/backup.tmp'))"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-delete-release-artifact'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[IO.File]::Delete((Join-Path `$distRoot 'game-capture-ffmpeg-source-info.zip'))"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-open-write-release-artifact'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[void][System.IO.File]::OpenWrite(`$stableZip)"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-open-write-access'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[void][System.IO.File]::Open(`$versionedPortable, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write)"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-static-dotnet-open-or-create-read-access'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[void][System.IO.File]::Open(`$stableSetup, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Read)"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round2-post-identity-path-combine-segments-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateCombinedArtifact = [IO.Path]::Combine(`$PSScriptRoot, '..', 'dist', `"game-capture-`$Version-setup.exe`")`n[IO.File]::WriteAllText(`$lateCombinedArtifact, 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round2-post-identity-nested-join-path-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateNestedArtifact = Join-Path (Join-Path `$PSScriptRoot '..') (Join-Path 'dist' `"game-capture-`$Version-setup.exe`")`n[IO.File]::WriteAllText(`$lateNestedArtifact, 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round2-post-identity-command-path-alias-set-content'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateArtifact = `$stableSetup`nSet-Content `$lateArtifact -Value 'mutated-after-identity'"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round2-post-identity-fileinfo-open-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[void][IO.FileInfo]::new(`$stableSetup).OpenWrite()"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round2-post-identity-new-item-file-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`nNew-Item -ItemType File -Path `$stableSetup -Force | Out-Null"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round2-post-identity-tee-object-file-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n'mutated-after-identity' | Tee-Object -FilePath `$stableSetup | Out-Null"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-native-redirection-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n'mutated-after-identity' > `$stableSetup"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-filestream-constructor-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[void][System.IO.FileStream]::new(`$stableSetup, [System.IO.FileMode]::Create)"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-fileinfo-open-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n[void][IO.FileInfo]::new(`$stableSetup).Open([IO.FileMode]::Open, [IO.FileAccess]::Write)"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-sc-alias-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`nsc -Path `$stableSetup -Value 'mutated-after-identity'"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-defined-command-alias-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`nSet-Alias -Name lateArtifactWriter -Value Set-Content`nlateArtifactWriter -LiteralPath `$stableSetup -Value 'mutated-after-identity'"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-variable-command-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateArtifactWriter = 'Set-Content'`n& `$lateArtifactWriter -LiteralPath `$stableSetup -Value 'mutated-after-identity'"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-pipeline-fileinfo-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateArtifactInfo = `$stableSetup | Get-Item`n[void]`$lateArtifactInfo.OpenWrite()"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-path-join-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateJoinedArtifact = [IO.Path]::Join(`$distRoot, 'game-capture-setup.exe')`n[IO.File]::WriteAllText(`$lateJoinedArtifact, 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-join-path-additional-child-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateAdditionalArtifact = Join-Path -Path `$PSScriptRoot -ChildPath '..' -AdditionalChildPath 'dist', `"game-capture-`$Version-setup.exe`"`n[IO.File]::WriteAllText(`$lateAdditionalArtifact, 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round3-post-identity-array-path-combine-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateArrayCombinedArtifact = [IO.Path]::Combine(@(`$distRoot, 'game-capture-setup.exe'))`n[IO.File]::WriteAllText(`$lateArrayCombinedArtifact, 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round4-post-identity-composed-version-leaf-path-combine-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateComposedArtifact = [System.IO.Path]::Combine(`$distRoot, ('game-capture-' + `$Version + '-setup.exe'))`n[System.IO.File]::WriteAllText(`$lateComposedArtifact, 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round4-post-identity-nested-variable-path-combine-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateComposedDistRoot = [System.IO.Path]::Combine(`$PSScriptRoot, '..', 'dist')`n`$lateArtifactSuffix = '-portable.exe'`n`$lateComposedLeaf = ('game-capture-' + `$Version) + `$lateArtifactSuffix`n`$lateNestedComposedArtifact = [System.IO.Path]::Combine(`$lateComposedDistRoot, `$lateComposedLeaf)`n[System.IO.File]::WriteAllText(`$lateNestedComposedArtifact, 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round5-post-identity-format-pathjoin-fileinfo-open-write'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$heldSuffix = 'portable.exe'`n`$heldLeaf = 'game-capture-{0}-{1}' -f `$Version, `$heldSuffix`n`$heldRootAlias = [System.IO.Path]::Combine(`$PSScriptRoot, '..', 'dist')`n`$heldPathAlias = [System.IO.Path]::Join(`$heldRootAlias, `$heldLeaf)`n`$heldInfo = [System.IO.FileInfo]::new(`$heldPathAlias)`n[void]`$heldInfo.Open([System.IO.FileMode]::Open, [System.IO.FileAccess]::Write)"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'round5-post-identity-format-path-combine-writealltext'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$heldLeaf = 'game-capture-{0}-setup.exe' -f `$Version`n`$heldPathAlias = [System.IO.Path]::Combine(`$distRoot, `$heldLeaf)`n[System.IO.File]::WriteAllText(`$heldPathAlias, 'mutated-after-identity')"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'format-independent-reordered-two-arg-static-array-escaped-writeallbytes'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = $aliasIdentityFailureGuard
            after = $aliasIdentityFailureGuard + "`n`$lateEscapedFormat = 'game-capture-{{1}}{{0}}' -f 'ignored-placeholder-value'`n`$lateFormatArguments = @('-portable.exe', `$Version)`n`$lateFormattedLeaf = `$lateEscapedFormat -f `$lateFormatArguments`n`$lateFormattedPath = Join-Path `$distRoot `$lateFormattedLeaf`n[System.IO.File]::WriteAllBytes(`$lateFormattedPath, [byte[]]@(1, 2, 3))"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-stable-set-content'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            after = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }`nSet-Content -LiteralPath `$stableSetup -Value 'mutated'"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-stable-copy'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            after = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }`nCopy-Item -LiteralPath `$versionedPortable -Destination `$stablePortable -Force"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'post-alias-gate-versioned-signing'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            after = "if (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }`n`$lateSignArgs = @('-File', (Join-Path `$PSScriptRoot 'sign-artifacts.ps1'), '-FilePaths', `$versionedSetup)`n& powershell.exe @lateSignArgs"
            expected = @('RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD')
        },
        [pscustomobject]@{
            name = 'alias-args-overwritten-before-invocation'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '& powershell.exe @aliasIdentityArgs'
            after = "`$aliasIdentityArgs = @('-File', `$unrelatedScript)`n& powershell.exe @aliasIdentityArgs"
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'alias-helper-redirected-to-attacker-root'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "(Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1')"
            after = "(Join-Path `$attackerRoot 'release-artifact-alias-identity-regression.ps1')"
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'build-alias-ffmpeg-forwarding-removed'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }"
            after = "if (`$AllowMissingFfmpeg) { Write-Host 'Optional FFmpeg policy ignored.' }"
            expected = @('BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'build-alias-ffmpeg-forwarding-wrong-switch'
            file = 'native-qt/qa/build-release.ps1'
            before = "`$buildAliasIdentityArgs += '-AllowMissingFfmpeg'"
            after = "`$buildAliasIdentityArgs += '-NotAllowMissingFfmpeg'"
            expected = @('BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'build-alias-ffmpeg-forwarding-unconditional'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }"
            after = "`$buildAliasIdentityArgs += '-AllowMissingFfmpeg'"
            expected = @('BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'build-alias-ffmpeg-forwarding-after-invocation'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }`n& powershell.exe @buildAliasIdentityArgs"
            after = "& powershell.exe @buildAliasIdentityArgs`nif (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }"
            expected = @('BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'build-alias-ffmpeg-forwarding-reset-before-invocation'
            file = 'native-qt/qa/build-release.ps1'
            before = "if (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }`n& powershell.exe @buildAliasIdentityArgs"
            after = "if (`$AllowMissingFfmpeg) { `$buildAliasIdentityArgs += '-AllowMissingFfmpeg' }`n`$buildAliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`n& powershell.exe @buildAliasIdentityArgs"
            expected = @('BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'build-alias-ffmpeg-forwarding-unused-variable'
            file = 'native-qt/qa/build-release.ps1'
            before = "`$buildAliasIdentityArgs += '-AllowMissingFfmpeg'"
            after = "`$unusedBuildAliasArgs += '-AllowMissingFfmpeg'"
            expected = @('BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'release-exposes-allow-missing-ffmpeg-parameter'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '    [switch]$SkipVirusTotal = $false'
            after = "    [switch]`$AllowMissingFfmpeg = `$false,`n    [switch]`$SkipVirusTotal = `$false"
            expected = @('RELEASE_FFMPEG_PAYLOAD_MANDATORY')
        },
        [pscustomobject]@{
            name = 'release-forwards-allow-missing-ffmpeg-to-build'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "'-SkipVirusTotal', '-RequireReleaseArtifacts')"
            after = "'-SkipVirusTotal', '-RequireReleaseArtifacts', '-AllowMissingFfmpeg')"
            expected = @('RELEASE_FFMPEG_PAYLOAD_MANDATORY')
        },
        [pscustomobject]@{
            name = 'release-forwards-allow-missing-ffmpeg-to-alias-gate'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "`$aliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)"
            after = "`$aliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version, '-AllowMissingFfmpeg')"
            expected = @('RELEASE_FFMPEG_PAYLOAD_MANDATORY')
        },
        [pscustomobject]@{
            name = 'alias-guard-moved-after-virustotal'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = (@(
                '$aliasIdentityArgs = @(''-File'', (Join-Path $PSScriptRoot ''../e2e/release-artifact-alias-identity-regression.ps1''), ''-DistDir'', $distRoot, ''-Version'', $Version)'
                '& powershell.exe @aliasIdentityArgs'
                '$aliasIdentityExit = $LASTEXITCODE'
                'if ($aliasIdentityExit -ne 0) { throw ''Release artifact alias identity validation failed.'' }'
                'if (-not $SkipVirusTotal) {'
                '    $virusTotalArgs = @(''-File'', (Join-Path $PSScriptRoot ''submit-virustotal.ps1''), ''-DistDir'', $distRoot, ''-Version'', $Version)'
                '    & powershell.exe @virusTotalArgs'
                '    $virusTotalExit = $LASTEXITCODE'
                '    if ($virusTotalExit -ne 0) { Write-Warning ''VirusTotal submission failed; validated release will continue.'' }'
                '}'
            ) -join "`n")
            after = (@(
                'if (-not $SkipVirusTotal) {'
                '    $virusTotalArgs = @(''-File'', (Join-Path $PSScriptRoot ''submit-virustotal.ps1''), ''-DistDir'', $distRoot, ''-Version'', $Version)'
                '    & powershell.exe @virusTotalArgs'
                '    $virusTotalExit = $LASTEXITCODE'
                '    if ($virusTotalExit -ne 0) { Write-Warning ''VirusTotal submission failed; validated release will continue.'' }'
                '}'
                '$aliasIdentityArgs = @(''-File'', (Join-Path $PSScriptRoot ''../e2e/release-artifact-alias-identity-regression.ps1''), ''-DistDir'', $distRoot, ''-Version'', $Version)'
                '& powershell.exe @aliasIdentityArgs'
                '$aliasIdentityExit = $LASTEXITCODE'
                'if ($aliasIdentityExit -ne 0) { throw ''Release artifact alias identity validation failed.'' }'
            ) -join "`n")
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'installer-newest-dist-selection'
            file = 'native-qt/qa/run-release-readiness.ps1'
            before = '$installerRan = $false'
            after = "`$installerRan = `$false`n`$stageCandidate = Get-ChildItem 'game-capture-*-win64' | Sort-Object LastWriteTime"
            expected = @('INSTALLER_NO_NEWEST_DIST')
        },
        [pscustomobject]@{
            name = 'skipped-packaged-validation'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "& powershell.exe @readinessArgs`n`$readinessExit = `$LASTEXITCODE`nif (`$readinessExit -ne 0) { throw 'Post-package readiness failed.' }"
            after = "if (-not `$SkipValidation) {`n    & powershell.exe @readinessArgs`n    `$readinessExit = `$LASTEXITCODE`n    if (`$readinessExit -ne 0) { throw 'Post-package readiness failed.' }`n}"
            expected = @('RELEASE_READINESS_FAILURE_BLOCKING', 'RELEASE_PACKAGED_VALIDATION_MANDATORY')
        },
        [pscustomobject]@{
            name = 'missing-forced-early-vt-skip'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "'-SkipVirusTotal', '-RequireReleaseArtifacts'"
            after = "'-RequireReleaseArtifacts'"
            expected = @('RELEASE_BUILD_FORCES_EARLY_VT_SKIP')
        },
        [pscustomobject]@{
            name = 'release-allows-stale-optional-artifacts'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "'-SkipVirusTotal', '-RequireReleaseArtifacts'"
            after = "'-SkipVirusTotal'"
            expected = @('RELEASE_REQUIRES_FRESH_ARTIFACT_GENERATION')
        },
        [pscustomobject]@{
            name = 'extra-post-gate-vt-call'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (-not `$SkipVirusTotal) {`n    `$virusTotalArgs = @("
            after = "if (-not `$SkipVirusTotal) {`n    `$extraVirusTotalArgs = @('-File', (Join-Path `$PSScriptRoot 'submit-virustotal.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`n    & powershell.exe @extraVirusTotalArgs`n    `$extraVirusTotalExit = `$LASTEXITCODE`n    if (`$extraVirusTotalExit -ne 0) { Write-Warning 'extra VT failed' }`n    `$virusTotalArgs = @("
            expected = @('RELEASE_VT_SINGLE_POST_READINESS_CALL')
        },
        [pscustomobject]@{
            name = 'missing-post-readiness-vt-call'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if (-not `$SkipVirusTotal) {`n    `$virusTotalArgs = @('-File', (Join-Path `$PSScriptRoot 'submit-virustotal.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`n    & powershell.exe @virusTotalArgs`n    `$virusTotalExit = `$LASTEXITCODE`n    if (`$virusTotalExit -ne 0) { Write-Warning 'VirusTotal submission failed; validated release will continue.' }`n}`n"
            after = ''
            expected = @('RELEASE_VT_BEST_EFFORT_EXPLICITLY_HANDLED', 'RELEASE_VT_EXACT_VERSIONED_BINDINGS', 'RELEASE_VT_EXPLICIT_SKIP_GUARD', 'RELEASE_VT_SINGLE_POST_READINESS_CALL')
        },
        [pscustomobject]@{
            name = 'vt-before-readiness'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "& powershell.exe @readinessArgs`n`$readinessExit = `$LASTEXITCODE`nif (`$readinessExit -ne 0) { throw 'Post-package readiness failed.' }`n`$aliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`n& powershell.exe @aliasIdentityArgs`n`$aliasIdentityExit = `$LASTEXITCODE`nif (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }`nif (-not `$SkipVirusTotal) {`n    `$virusTotalArgs = @('-File', (Join-Path `$PSScriptRoot 'submit-virustotal.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`n    & powershell.exe @virusTotalArgs`n    `$virusTotalExit = `$LASTEXITCODE`n    if (`$virusTotalExit -ne 0) { Write-Warning 'VirusTotal submission failed; validated release will continue.' }`n}"
            after = "if (-not `$SkipVirusTotal) {`n    `$virusTotalArgs = @('-File', (Join-Path `$PSScriptRoot 'submit-virustotal.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`n    & powershell.exe @virusTotalArgs`n    `$virusTotalExit = `$LASTEXITCODE`n    if (`$virusTotalExit -ne 0) { Write-Warning 'VirusTotal submission failed; validated release will continue.' }`n}`n& powershell.exe @readinessArgs`n`$readinessExit = `$LASTEXITCODE`nif (`$readinessExit -ne 0) { throw 'Post-package readiness failed.' }`n`$aliasIdentityArgs = @('-File', (Join-Path `$PSScriptRoot '../e2e/release-artifact-alias-identity-regression.ps1'), '-DistDir', `$distRoot, '-Version', `$Version)`n& powershell.exe @aliasIdentityArgs`n`$aliasIdentityExit = `$LASTEXITCODE`nif (`$aliasIdentityExit -ne 0) { throw 'Release artifact alias identity validation failed.' }"
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING', 'RELEASE_VT_BEST_EFFORT_EXPLICITLY_HANDLED', 'RELEASE_VT_EXACT_VERSIONED_BINDINGS', 'RELEASE_VT_EXPLICIT_SKIP_GUARD', 'RELEASE_VT_SINGLE_POST_READINESS_CALL')
            justification = 'Moving VirusTotal before readiness necessarily places it before the required post-readiness identity recheck as well.'
        },
        [pscustomobject]@{
            name = 'vt-wrong-dist-binding'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "'-DistDir', `$distRoot, '-Version', `$Version)`n    & powershell.exe @virusTotalArgs"
            after = "'-DistDir', `$staleDistRoot, '-Version', `$Version)`n    & powershell.exe @virusTotalArgs"
            expected = @('RELEASE_VT_EXACT_VERSIONED_BINDINGS')
        },
        [pscustomobject]@{
            name = 'vt-exit-ignored'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "    `$virusTotalExit = `$LASTEXITCODE`n    if (`$virusTotalExit -ne 0) { Write-Warning 'VirusTotal submission failed; validated release will continue.' }"
            after = "    Write-Host 'VirusTotal exit ignored'"
            expected = @('RELEASE_VT_BEST_EFFORT_EXPLICITLY_HANDLED')
        },
        [pscustomobject]@{
            name = 'vt-skip-guard-removed'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = 'if (-not $SkipVirusTotal) {'
            after = 'if ($true) {'
            expected = @('RELEASE_VT_EXPLICIT_SKIP_GUARD')
        },
        [pscustomobject]@{
            name = 'missing-ninja-checkout'
            file = '.github/workflows/qa-fast-gate.yml'
            before = "      - name: Checkout ninja-plugin`n        uses: actions/checkout@v4`n        with:`n          repository: steveseguin/ninja-plugin`n          ref: main`n          path: ninja-plugin`n"
            after = ''
            expected = @('FAST_CI_NINJA_CHECKOUT', 'FAST_CI_PLUGIN_FORWARDING')
        },
        [pscustomobject]@{
            name = 'attacker-ninja-checkout'
            file = '.github/workflows/qa-fast-gate.yml'
            before = "          repository: steveseguin/ninja-plugin`n          ref: main`n          path: ninja-plugin"
            after = "          repository: attacker/ninja-plugin`n          ref: attacker`n          path: attacker-plugin"
            expected = @('FAST_CI_NINJA_CHECKOUT', 'FAST_CI_PLUGIN_FORWARDING')
        },
        [pscustomobject]@{
            name = 'missing-workflow-forwarding'
            file = '.github/workflows/qa-fast-gate.yml'
            before = '            -RoomAlphaPluginRepo $ninjaPluginRepo'
            after = '            -Configuration Release'
            expected = @('FAST_CI_PLUGIN_FORWARDING')
        },
        [pscustomobject]@{
            name = 'missing-wrapper-forwarding'
            file = 'native-qt/qa/run-fast-gate.ps1'
            before = '    RoomAlphaPluginRepo = $RoomAlphaPluginRepo'
            after = '    ControlToken = $ControlToken'
            expected = @('FAST_WRAPPER_PLUGIN_FORWARDING')
        },
        [pscustomobject]@{
            name = 'wrapper-splat-overwritten'
            file = 'native-qt/qa/run-fast-gate.ps1'
            before = "}`n& `$scriptPath @params"
            after = "}`n`$params.RoomAlphaPluginRepo = `$wrongPluginRepo`n& `$scriptPath @params"
            expected = @('FAST_WRAPPER_PLUGIN_FORWARDING')
        },
        [pscustomobject]@{
            name = 'fast-wrapper-wrong-manifest-hash-forwarding'
            file = 'native-qt/qa/run-fast-gate.ps1'
            before = '    ArtifactManifestSha256 = $artifactManifestSha256'
            after = '    ArtifactManifestSha256 = $wrongArtifactManifestSha256'
            expected = @('FAST_WRAPPER_PACKAGED_ARTIFACT_FORWARDING')
        },
        [pscustomobject]@{
            name = 'nightly-wrapper-wrong-manifest-path-forwarding'
            file = 'native-qt/qa/run-nightly-soak.ps1'
            before = '    ArtifactManifestPath = $artifactManifestPath'
            after = '    ArtifactManifestPath = $wrongArtifactManifestPath'
            expected = @('NIGHTLY_WRAPPER_PACKAGED_ARTIFACT_FORWARDING')
        },
        [pscustomobject]@{
            name = 'powershell-step-uses-bash'
            file = '.github/workflows/qa-fast-gate.yml'
            before = '        shell: pwsh'
            after = '        shell: bash'
            expected = @('FAST_CI_POWERSHELL_RUNTIME')
        },
        [pscustomobject]@{
            name = 'qa-job-disabled'
            file = '.github/workflows/qa-fast-gate.yml'
            before = "  qa:`n    runs-on: [self-hosted, Windows, X64]"
            after = "  qa:`n    if: `${{ false }}`n    runs-on: [self-hosted, Windows, X64]"
            expected = @('FAST_CI_JOB_RUNTIME')
        },
        [pscustomobject]@{
            name = 'fake-skip-comment'
            file = '.github/workflows/qa-fast-gate.yml'
            before = '            -SkipRoomAlpha'
            after = '            # -SkipRoomAlpha'
            expected = @('FAST_COMPONENT_PACKAGED_ALPHA_SKIP')
        },
        [pscustomobject]@{
            name = 'fake-playwright-comment'
            file = '.github/workflows/qa-fast-gate.yml'
            before = '        run: npx playwright install msedge firefox'
            after = "        run: |`n          # npx playwright install msedge firefox`n          Write-Host 'browsers not installed'"
            expected = @('FAST_CI_BROWSER_RUNTIMES')
        },
        [pscustomobject]@{
            name = 'fake-policy-comment'
            file = '.github/workflows/qa-fast-gate.yml'
            before = '        run: npm --prefix native-qt run gate:release-wiring'
            after = "        run: |`n          # npm --prefix native-qt run gate:release-wiring`n          Write-Host 'not a policy gate'"
            expected = @('FAST_CI_RUNS_POLICY')
        },
        [pscustomobject]@{
            name = 'wrong-release-artifact-binding'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "'-RoomAlphaPublisherPath', `$packagedPublisher"
            after = "'-RoomAlphaPublisherPath', `$stalePublisher"
            expected = @('RELEASE_EXACT_READINESS_BINDINGS')
        },
        [pscustomobject]@{
            name = 'cmake-exit-reset-before-guard'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "`$compileExit = `$LASTEXITCODE`nif (`$compileExit -ne 0) { throw 'Fresh compile failed.' }"
            after = "`$compileExit = `$LASTEXITCODE`n`$compileExit = 0`nif (`$compileExit -ne 0) { throw 'Fresh compile failed.' }"
            expected = @('RELEASE_FRESH_COMPILE')
        },
        [pscustomobject]@{
            name = 'aliased-publish-before-readiness'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = '$readinessArgs = @('
            after = "`$ghTool = 'gh'`n& `$ghTool release upload 'premature'`n`$readinessArgs = @("
            expected = @('RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING', 'RELEASE_COMPILE_PACKAGE_VALIDATE_PUBLISH_ORDER', 'RELEASE_GH_SUCCESS_ONLY_AFTER_GUARDS', 'RELEASE_GH_UPLOAD_FAILURE_BLOCKING', 'RELEASE_VT_BEST_EFFORT_EXPLICITLY_HANDLED', 'RELEASE_VT_EXACT_VERSIONED_BINDINGS', 'RELEASE_VT_EXPLICIT_SKIP_GUARD', 'RELEASE_VT_SINGLE_POST_READINESS_CALL')
            justification = 'Publishing before readiness also necessarily precedes the required post-readiness identity recheck.'
        },
        [pscustomobject]@{
            name = 'nonblocking-package-staging'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "& powershell.exe @buildArgs`n`$packageExit = `$LASTEXITCODE`nif (`$packageExit -ne 0) { throw 'Package staging failed.' }"
            after = "& powershell.exe @buildArgs`nWrite-Host 'package exit ignored'"
            expected = @('RELEASE_BUILD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'gh-upload-unguarded'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "    `$uploadExit = `$LASTEXITCODE`n    if (`$uploadExit -ne 0) { throw 'gh release upload failed.' }"
            after = "    Write-Host 'upload exit ignored'"
            expected = @('RELEASE_GH_SUCCESS_ONLY_AFTER_GUARDS', 'RELEASE_GH_UPLOAD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'gh-edit-failure-ignored-after-upload'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "    `$editExit = `$LASTEXITCODE`n    if (`$editExit -ne 0) { throw 'gh release edit failed.' }"
            after = "    Write-Host 'edit exit ignored'"
            expected = @('RELEASE_GH_EDIT_FAILURE_BLOCKING', 'RELEASE_GH_SUCCESS_ONLY_AFTER_GUARDS')
        },
        [pscustomobject]@{
            name = 'gh-create-failure-ignored'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "    `$createExit = `$LASTEXITCODE`n    if (`$createExit -ne 0) { throw 'gh release create failed.' }"
            after = "    Write-Host 'create exit ignored'"
            expected = @('RELEASE_GH_CREATE_FAILURE_BLOCKING', 'RELEASE_GH_SUCCESS_ONLY_AFTER_GUARDS')
        },
        [pscustomobject]@{
            name = 'gh-upload-exit-reset'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "    `$uploadExit = `$LASTEXITCODE`n    if (`$uploadExit -ne 0) { throw 'gh release upload failed.' }"
            after = "    `$uploadExit = `$LASTEXITCODE`n    `$uploadExit = 0`n    if (`$uploadExit -ne 0) { throw 'gh release upload failed.' }"
            expected = @('RELEASE_GH_SUCCESS_ONLY_AFTER_GUARDS', 'RELEASE_GH_UPLOAD_FAILURE_BLOCKING')
        },
        [pscustomobject]@{
            name = 'wrong-plugin-guard-variable'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "if ([string]::IsNullOrWhiteSpace(`$RoomAlphaPluginRepo)) { throw 'Plugin repo is required.' }"
            after = "if ([string]::IsNullOrWhiteSpace(`$UnrelatedPath)) { throw 'Plugin repo is required.' }"
            expected = @('RELEASE_PLUGIN_GUARD')
        },
        [pscustomobject]@{
            name = 'no-fresh-compilation'
            file = 'native-qt/qa/release-and-publish.ps1'
            before = "& cmake --build `$BuildDir --config `$Configuration`n`$compileExit = `$LASTEXITCODE`nif (`$compileExit -ne 0) { throw 'Fresh compile failed.' }"
            after = '# compile omitted; build-release only stages an existing executable'
            expected = @('RELEASE_COMPILE_PACKAGE_VALIDATE_PUBLISH_ORDER', 'RELEASE_FRESH_COMPILE')
        }
    )

    if (-not [string]::IsNullOrWhiteSpace($MutationPattern)) {
        $mutations = @($mutations | Where-Object { $_.name -match $MutationPattern })
        if ($mutations.Count -eq 0) { throw "No mutations matched pattern: $MutationPattern" }
    }

    if ($ValidatePublicationSuppression) {
        $probe = @(
            $mutations | Where-Object {
                $_.name -ceq 'round3-post-identity-native-redirection-write'
            }
        )
        if ($probe.Count -ne 1) {
            throw 'Publication-suppression validation requires the exact native-redirection mutation.'
        }
        $probeRoot = Join-Path $mutationRoot 'publication-suppression'
        Copy-Item -LiteralPath $base -Destination $probeRoot -Recurse
        Replace-ExactlyOnce $probeRoot $probe[0].file $probe[0].before $probe[0].after
        $publicationMarker = Join-Path $probeRoot 'publication-attempted.marker'
        $run = Invoke-PolicyFixture $probeRoot
        if ($run.exitCode -eq 0) {
            [System.IO.File]::WriteAllText($publicationMarker, 'publication callback ran')
        }
        $failures = @(Get-FailedIds $run.result)
        Assert-ExactFailures 'publication-suppression-gate' $failures $probe[0].expected
        if ($run.exitCode -eq 0 -or [bool]$run.result.ok -or
            (Test-Path -LiteralPath $publicationMarker)) {
            throw "Failed release-wiring gate did not suppress publication: exit=$($run.exitCode) marker=$(Test-Path -LiteralPath $publicationMarker)"
        }
        Write-Host (
            '[PUBLICATION SUPPRESSION PASS] gateExit={0} owner={1} publicationCallback=not-invoked marker=absent terminal={2}' -f `
                $run.exitCode,
                $failures[0],
                $run.result.terminalEvidence.state
        )
        return
    }

    if ($ValidateMutationSourcesOnly) {
        $invalidMutationSources = New-Object System.Collections.Generic.List[string]
        foreach ($mutation in $mutations) {
            $path = Join-Path $base $mutation.file
            $content = Get-Content -LiteralPath $path -Raw
            $first = $content.IndexOf($mutation.before, [System.StringComparison]::Ordinal)
            $second = if ($first -ge 0) {
                $content.IndexOf(
                    $mutation.before,
                    $first + $mutation.before.Length,
                    [System.StringComparison]::Ordinal
                )
            } else {
                -1
            }
            if ([string]::IsNullOrEmpty([string]$mutation.before) -or $first -lt 0 -or $second -ge 0) {
                $invalidMutationSources.Add(
                    "$($mutation.name) :: $($mutation.file) :: first=$first second=$second"
                ) | Out-Null
            }
        }
        if ($invalidMutationSources.Count -gt 0) {
            throw "Mutation sources are not uniquely instrumented ($($invalidMutationSources.Count)): $($invalidMutationSources -join ' | ')"
        }
        Write-Host ("[MUTATION SOURCE SUMMARY] mutations={0} uniquely-addressed={0}" -f $mutations.Count)
        return
    }

    foreach ($mutation in $mutations) {
        $mutantRoot = Join-Path $mutationRoot $mutation.name
        Copy-Item -LiteralPath $base -Destination $mutantRoot -Recurse
        Replace-ExactlyOnce $mutantRoot $mutation.file $mutation.before $mutation.after
        $run = Invoke-PolicyFixture $mutantRoot
        if ($run.exitCode -eq 0 -or [bool]$run.result.ok) {
            throw "Mutation '$($mutation.name)' was not rejected."
        }
        Assert-ExactFailures $mutation.name (Get-FailedIds $run.result) $mutation.expected
        if ($mutation.PSObject.Properties['justification'] -and $mutation.justification) {
            Write-Host ("[MUTATION OVERLAP] {0}: {1}" -f $mutation.name, $mutation.justification)
        }
    }

    Write-Host ("[MUTATION SUMMARY] baseline=pass mutations={0} rejected={0}" -f $mutations.Count)
} finally {
    if (Test-Path -LiteralPath $resolvedMutationRoot -PathType Container) {
        Remove-Item -LiteralPath $resolvedMutationRoot -Recurse -Force
    }
}
