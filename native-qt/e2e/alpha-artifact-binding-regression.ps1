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
$contractsPath = Join-Path $PluginRepo "scripts\alpha-harness-contracts.ps1"
if (-not (Test-Path -LiteralPath $contractsPath -PathType Leaf)) {
    throw "Production alpha harness contracts were not found: $contractsPath"
}
. $contractsPath

$sha = "a" * 64
$otherSha = "b" * 64
$binding = [pscustomobject]@{ path = "C:\fixture\obs-vdoninja.dll"; sha256 = $sha }
$publisher = [pscustomobject]@{ path = "C:\fixture\game-capture.exe"; sha256 = $sha }
$spout = [pscustomobject]@{ path = "C:\fixture\spout_test_sender.exe"; sha256 = $sha }
$positive = Test-AlphaLoadedPluginEvidence `
    -LoadedModules @($binding) -LoadedPlugin $binding -StagedPlugin $binding -ExpectedSha256 $sha
if (-not $positive.ok) {
    throw "Valid loaded-plugin evidence failed: $($positive.reasons -join '; ')"
}
$packagedPositive = Test-AlphaPackagedArtifactEvidence `
    -Publisher $publisher -SpoutSender $spout `
    -ExpectedPublisherSha256 $sha -ExpectedSpoutSenderSha256 $sha
if (-not $packagedPositive.ok) {
    throw "Valid packaged-artifact evidence failed: $($packagedPositive.reasons -join '; ')"
}

$negativeCases = @(
    [ordered]@{
        name = "duplicate-loaded-dll"
        result = Test-AlphaLoadedPluginEvidence `
            -LoadedModules @($binding, $binding) -LoadedPlugin $binding -StagedPlugin $binding -ExpectedSha256 $sha
    },
    [ordered]@{
        name = "wrong-loaded-hash"
        result = Test-AlphaLoadedPluginEvidence `
            -LoadedModules @([pscustomobject]@{ path = $binding.path; sha256 = $otherSha }) `
            -LoadedPlugin $binding -StagedPlugin $binding -ExpectedSha256 $sha
    },
    [ordered]@{
        name = "missing-module-metadata"
        result = Test-AlphaLoadedPluginEvidence `
            -LoadedModules @([pscustomobject]@{ path = ""; sha256 = "" }) `
            -LoadedPlugin $binding -StagedPlugin $binding -ExpectedSha256 $sha
    },
    [ordered]@{
        name = "missing-singular-binding"
        result = Test-AlphaLoadedPluginEvidence `
            -LoadedModules @($binding) -LoadedPlugin $null -StagedPlugin $binding -ExpectedSha256 $sha
    },
    [ordered]@{
        name = "staged-hash-mismatch"
        result = Test-AlphaLoadedPluginEvidence `
            -LoadedModules @($binding) -LoadedPlugin $binding `
            -StagedPlugin ([pscustomobject]@{ path = $binding.path; sha256 = $otherSha }) `
            -ExpectedSha256 $sha
    },
    [ordered]@{
        name = "wrong-packaged-publisher-hash"
        result = Test-AlphaPackagedArtifactEvidence `
            -Publisher ([pscustomobject]@{ path = $publisher.path; sha256 = $otherSha }) `
            -SpoutSender $spout -ExpectedPublisherSha256 $sha -ExpectedSpoutSenderSha256 $sha
    },
    [ordered]@{
        name = "missing-packaged-publisher-metadata"
        result = Test-AlphaPackagedArtifactEvidence `
            -Publisher $null -SpoutSender $spout `
            -ExpectedPublisherSha256 $sha -ExpectedSpoutSenderSha256 $sha
    },
    [ordered]@{
        name = "wrong-spout-fixture-hash"
        result = Test-AlphaPackagedArtifactEvidence `
            -Publisher $publisher `
            -SpoutSender ([pscustomobject]@{ path = $spout.path; sha256 = $otherSha }) `
            -ExpectedPublisherSha256 $sha -ExpectedSpoutSenderSha256 $sha
    },
    [ordered]@{
        name = "missing-spout-fixture-metadata"
        result = Test-AlphaPackagedArtifactEvidence `
            -Publisher $publisher -SpoutSender $null `
            -ExpectedPublisherSha256 $sha -ExpectedSpoutSenderSha256 $sha
    }
)

foreach ($case in $negativeCases) {
    if ([bool]$case.result.ok) {
        throw "$($case.name) negative control unexpectedly passed"
    }
}

[ordered]@{
    ok = $true
    productionContractsPath = (Resolve-Path -LiteralPath $contractsPath).Path
    productionContractsSha256 = (Get-FileHash -LiteralPath $contractsPath -Algorithm SHA256).Hash.ToLowerInvariant()
    positive = $positive
    packagedPositive = $packagedPositive
    negativeControlCount = $negativeCases.Count
    negativeControls = @($negativeCases | ForEach-Object {
        [ordered]@{ name = $_.name; reasons = @($_.result.reasons) }
    })
} | ConvertTo-Json -Depth 10
