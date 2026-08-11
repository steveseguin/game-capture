[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PluginRepo
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($PluginRepo)) {
    throw "PluginRepo is required."
}
$PluginRepo = [System.IO.Path]::GetFullPath($PluginRepo)
$artifactRegression = Join-Path $PSScriptRoot "alpha-artifact-binding-regression.ps1"
if (-not (Test-Path -LiteralPath $artifactRegression -PathType Leaf)) {
    throw "Artifact identity regression gate is missing: $artifactRegression"
}
$artifactOutput = & powershell -NoProfile -ExecutionPolicy Bypass `
    -File $artifactRegression -PluginRepo $PluginRepo 2>&1
$artifactExit = $LASTEXITCODE
if ($artifactExit -ne 0) {
    throw "Artifact identity regression gate failed: $($artifactOutput -join [Environment]::NewLine)"
}
$artifactResult = ($artifactOutput -join "`n") | ConvertFrom-Json
$productionContractsPath = (Resolve-Path -LiteralPath (
    Join-Path $PluginRepo "scripts\alpha-harness-contracts.ps1"
)).Path
$productionContractsSha256 = (Get-FileHash -LiteralPath $productionContractsPath -Algorithm SHA256).Hash.ToLowerInvariant()
$requiredIdentityNegatives = @(
    "duplicate-loaded-dll",
    "wrong-loaded-hash",
    "missing-module-metadata",
    "wrong-packaged-publisher-hash",
    "missing-packaged-publisher-metadata",
    "wrong-spout-fixture-hash",
    "missing-spout-fixture-metadata"
)
$observedIdentityNegatives = @($artifactResult.negativeControls | ForEach-Object { [string]$_.name })
$missingIdentityNegatives = @($requiredIdentityNegatives | Where-Object { $_ -notin $observedIdentityNegatives })
if (-not [bool]$artifactResult.ok -or
    [string]$artifactResult.productionContractsPath -ine $productionContractsPath -or
    [string]$artifactResult.productionContractsSha256 -ne $productionContractsSha256 -or
    $missingIdentityNegatives.Count -gt 0) {
    throw "Artifact identity regression gate omitted required negatives: $($missingIdentityNegatives -join ', ')"
}
$gateRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "game-capture-alpha-manifest-gate-" + [guid]::NewGuid().ToString("N")
)
$wrapperCases = @(
    [ordered]@{
        name = "plugin-alpha"
        path = Join-Path $PSScriptRoot "ninja-plugin-alpha-e2e.ps1"
        expectedCases = 8
    },
    [ordered]@{
        name = "room-alpha"
        path = Join-Path $PSScriptRoot "room-alpha-ninja-plugin-e2e.ps1"
        expectedCases = 2
    }
)
$results = @()

foreach ($wrapperCase in $wrapperCases) {
    $caseDir = Join-Path $gateRoot $wrapperCase.name
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $wrapperCase.path `
            -PluginRepo $PluginRepo `
            -ReportDir $caseDir 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    $manifestPath = Join-Path $caseDir "manifest.json"
    if ($exitCode -eq 0) {
        throw "$($wrapperCase.name) missing-artifact-hash negative control unexpectedly passed"
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "$($wrapperCase.name) did not write its required failure manifest"
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $caseRows = @($manifest.cases)
    $nonUnexecuted = @($caseRows | Where-Object { $_.status -ne "unexecuted" })
    if ([bool]$manifest.ok -or
        -not $manifest.fatalError -or
        [bool]$manifest.artifactHashesStable -or
        $caseRows.Count -ne [int]$wrapperCase.expectedCases -or
        $nonUnexecuted.Count -ne 0) {
        throw "$($wrapperCase.name) failure/unexecuted manifest contract was invalid"
    }
    if ($wrapperCase.name -eq "plugin-alpha") {
        $h264Specs = @($manifest.requiredWorkflowCases | Where-Object {
            [string]$_.name -eq "h264-1080p60-half-resolution-alpha"
        })
        $h264Rows = @($caseRows | Where-Object {
            [string]$_.name -eq "h264-1080p60-half-resolution-alpha"
        })
        if ($h264Specs.Count -ne 1 -or
            [string]$h264Specs[0].pattern -ne "alpha-moving-edge" -or
            [string]$h264Specs[0].transitionMode -ne "source-toggle" -or
            [string]$h264Specs[0].videoCodec -ne "h264" -or
            [int]$h264Specs[0].outputWidth -ne 1920 -or
            [int]$h264Specs[0].outputHeight -ne 1080 -or
            [int]$h264Specs[0].outputFps -ne 60 -or
            [int]$h264Specs[0].expectedAlphaWidth -ne 960 -or
            [int]$h264Specs[0].expectedAlphaHeight -ne 540 -or
            $h264Rows.Count -ne 1 -or
            [string]$h264Rows[0].videoCodec -ne "h264" -or
            [int]$h264Rows[0].outputWidth -ne 1920 -or
            [int]$h264Rows[0].outputHeight -ne 1080 -or
            [int]$h264Rows[0].outputFps -ne 60 -or
            [int]$h264Rows[0].expectedAlphaWidth -ne 960 -or
            [int]$h264Rows[0].expectedAlphaHeight -ne 540) {
            throw "plugin-alpha omitted the required packaged 1080p60 H.264 mismatched-alpha workflow contract"
        }
    }
    $results += [ordered]@{
        name = $wrapperCase.name
        ok = $true
        exitCode = $exitCode
        manifest = [ordered]@{
            path = (Resolve-Path -LiteralPath $manifestPath).Path
            sha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        caseCount = $caseRows.Count
        allCasesUnexecuted = $true
        fatalError = [string]$manifest.fatalError
    }
}

[ordered]@{
    ok = (@($results | Where-Object { -not $_.ok }).Count -eq 0)
    gateArtifactRoot = $gateRoot
    artifactIdentityGate = $artifactResult
    results = $results
} | ConvertTo-Json -Depth 10
