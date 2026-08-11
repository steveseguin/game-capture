[CmdletBinding()]
param(
    [string]$SignArtifactsScript = '',
    [switch]$UseAcceptingFixtureControl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SignArtifactsScript)) {
    $SignArtifactsScript = Join-Path $PSScriptRoot '../qa/sign-artifacts.ps1'
}
$resolvedSignScript = (Resolve-Path -LiteralPath $SignArtifactsScript).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('game-capture-sign-input-regression-' + [guid]::NewGuid().ToString('N'))
$resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$resolvedRoot = [System.IO.Path]::GetFullPath($tempRoot)
if (-not $resolvedRoot.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or
    $resolvedRoot -eq $resolvedTemp) {
    throw 'Refusing to create signing-input fixtures outside the system temporary directory.'
}

$failures = @()
function Invoke-ChildPowerShell {
    param(
        [string]$ScriptPath,
        [string[]]$Arguments
    )

    $previousPreference = $ErrorActionPreference
    $output = @()
    $exitCode = 0
    try {
        # Windows PowerShell promotes redirected native stderr to NativeCommandError records.
        # Keep those records capturable without allowing them to abort this rejection harness.
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1)
        $exitCode = [int]$global:LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = @($output)
    }
}

function Get-RejectionFailureMessage {
    param(
        [string]$Name,
        [object]$Run,
        [bool]$AdditionalOk
    )

    if ($Run.ExitCode -ne 0 -and $AdditionalOk) { return $null }
    return "$Name accepted invalid input (exit=$($Run.ExitCode), additionalCheck=$AdditionalOk): $($Run.Output -join ' | ')"
}

function Invoke-RejectionCase {
    param(
        [string]$Name,
        [string[]]$Arguments,
        [scriptblock]$AdditionalAssertion
    )

    $run = Invoke-ChildPowerShell -ScriptPath $resolvedSignScript -Arguments $Arguments
    $additionalOk = $true
    if ($AdditionalAssertion) { $additionalOk = [bool](& $AdditionalAssertion $run) }
    $failure = Get-RejectionFailureMessage -Name $Name -Run $run -AdditionalOk $additionalOk
    if (-not $failure) {
        Write-Host "[SIGN INPUT PASS] $Name rejected exit=$($run.ExitCode)"
        return
    }
    $script:failures += $failure
    Write-Host "[SIGN INPUT FAIL] $Name accepted invalid input exit=$($run.ExitCode)"
}

try {
    New-Item -ItemType Directory -Path $resolvedRoot -Force | Out-Null
    $missingSigningRepo = Join-Path $resolvedRoot 'nonexistent-code-signing-repo'
    $version = '9.8.7'

    $stderrNonzeroControl = Join-Path $resolvedRoot 'stderr-nonzero-control.ps1'
    Set-Content -LiteralPath $stderrNonzeroControl -Encoding Ascii -Value @'
[Console]::Error.WriteLine('HARNESS_STDERR_NONZERO')
exit 23
'@
    $nonzeroControlRun = Invoke-ChildPowerShell -ScriptPath $stderrNonzeroControl -Arguments @()
    $nonzeroControlFailure = Get-RejectionFailureMessage -Name 'stderr nonzero self-control' -Run $nonzeroControlRun -AdditionalOk $true
    if ($nonzeroControlFailure -or ($nonzeroControlRun.Output -join "`n") -notmatch 'HARNESS_STDERR_NONZERO') {
        $failures += "Nonzero stderr self-control was not captured as a rejection: $nonzeroControlFailure"
        Write-Host '[HARNESS CONTROL FAIL] stderr plus nonzero exit was not captured'
    } else {
        Write-Host '[HARNESS CONTROL PASS] stderr plus nonzero exit captured without aborting'
    }

    $stderrZeroControl = Join-Path $resolvedRoot 'stderr-zero-control.ps1'
    Set-Content -LiteralPath $stderrZeroControl -Encoding Ascii -Value @'
[Console]::Error.WriteLine('HARNESS_STDERR_EXIT_ZERO')
exit 0
'@
    $zeroControlRun = Invoke-ChildPowerShell -ScriptPath $stderrZeroControl -Arguments @()
    $zeroControlFailure = Get-RejectionFailureMessage -Name 'stderr exit-zero self-control' -Run $zeroControlRun -AdditionalOk $true
    if (-not $zeroControlFailure -or ($zeroControlRun.Output -join "`n") -notmatch 'HARNESS_STDERR_EXIT_ZERO') {
        $failures += 'Exit-zero stderr self-control was not classified as an accepted invalid input.'
        Write-Host '[HARNESS CONTROL FAIL] stderr plus exit zero was not classified as failure'
    } else {
        Write-Host '[HARNESS CONTROL PASS] stderr plus exit zero remains a gate failure'
    }

    if ($UseAcceptingFixtureControl) {
        $acceptingFixture = Join-Path $resolvedRoot 'accepting-sign-artifacts-control.ps1'
        Set-Content -LiteralPath $acceptingFixture -Encoding Ascii -Value @'
param(
    [string]$DistDir = '',
    [string]$Version = '',
    [string]$CodeSigningRepo = '',
    [string[]]$FilePaths = @()
)
if ($DistDir) {
    New-Item -ItemType Directory -Path (Join-Path $DistDir 'game-capture-setup.exe') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $DistDir 'game-capture-portable.exe') -Force | Out-Null
}
exit 0
'@
        $resolvedSignScript = $acceptingFixture
        Write-Host '[HARNESS CONTROL] using isolated accepting signer fixture'
    }

    $distDir = Join-Path $resolvedRoot 'dist-directory-inputs'
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $distDir "game-capture-$version-setup.exe") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $distDir "game-capture-$version-portable.exe") -Force | Out-Null
    $stableSetup = Join-Path $distDir 'game-capture-setup.exe'
    $stablePortable = Join-Path $distDir 'game-capture-portable.exe'
    Invoke-RejectionCase 'DistDir exact-name directories' @(
        '-DistDir', $distDir,
        '-Version', $version,
        '-CodeSigningRepo', $missingSigningRepo
    ) {
        -not (Test-Path -LiteralPath $stableSetup) -and
        -not (Test-Path -LiteralPath $stablePortable)
    }

    $stableDirectoryDist = Join-Path $resolvedRoot 'stable-destination-directories'
    New-Item -ItemType Directory -Path $stableDirectoryDist -Force | Out-Null
    $canonicalSetup = Join-Path $stableDirectoryDist "game-capture-$version-setup.exe"
    $canonicalPortable = Join-Path $stableDirectoryDist "game-capture-$version-portable.exe"
    Set-Content -LiteralPath $canonicalSetup -Value 'canonical-setup-bytes' -NoNewline -Encoding Ascii
    Set-Content -LiteralPath $canonicalPortable -Value 'canonical-portable-bytes' -NoNewline -Encoding Ascii
    $stableSetupDirectory = Join-Path $stableDirectoryDist 'game-capture-setup.exe'
    $stablePortableDirectory = Join-Path $stableDirectoryDist 'game-capture-portable.exe'
    New-Item -ItemType Directory -Path $stableSetupDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $stablePortableDirectory -Force | Out-Null
    $nestedSetupCopy = Join-Path $stableSetupDirectory (Split-Path -Leaf $canonicalSetup)
    $nestedPortableCopy = Join-Path $stablePortableDirectory (Split-Path -Leaf $canonicalPortable)
    Invoke-RejectionCase 'DistDir stable destinations are directories' @(
        '-DistDir', $stableDirectoryDist,
        '-Version', $version,
        '-CodeSigningRepo', $missingSigningRepo
    ) {
        param($run)
        -not (Test-Path -LiteralPath $nestedSetupCopy) -and
        -not (Test-Path -LiteralPath $nestedPortableCopy) -and
        ($run.Output -join "`n") -notmatch '(?i)Code signing:\s*step complete\.'
    }

    $explicitDirectory = Join-Path $resolvedRoot 'explicit-directory.exe'
    New-Item -ItemType Directory -Path $explicitDirectory -Force | Out-Null
    Invoke-RejectionCase 'FilePaths directory with exe suffix' @(
        '-FilePaths', $explicitDirectory,
        '-CodeSigningRepo', $missingSigningRepo
    ) $null

    $wildcardDirectory = Join-Path $resolvedRoot 'wildcard-inputs'
    New-Item -ItemType Directory -Path $wildcardDirectory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $wildcardDirectory 'wild-one.exe') -Value 'not-a-real-executable' -Encoding Ascii
    $wildcardInput = Join-Path $wildcardDirectory 'wild-*.exe'
    Invoke-RejectionCase 'FilePaths wildcard expression' @(
        '-FilePaths', $wildcardInput,
        '-CodeSigningRepo', $missingSigningRepo
    ) $null

    $singletonToolDir = Join-Path $resolvedRoot 'singleton-signing-tool'
    $singletonSigningRepo = Join-Path $resolvedRoot 'singleton-signing-repo'
    $singletonCertificateDir = Join-Path $singletonSigningRepo 'secrets\decrypted\certs'
    New-Item -ItemType Directory -Path $singletonToolDir -Force | Out-Null
    New-Item -ItemType Directory -Path $singletonCertificateDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\where.exe') `
        -Destination (Join-Path $singletonToolDir 'signtool.exe') -Force
    Set-Content -LiteralPath (Join-Path $singletonCertificateDir 'socialstream.pfx') `
        -Value 'runtime singleton certificate fixture' -Encoding Ascii
    $singletonExecutable = Join-Path $resolvedRoot 'singleton-input.exe'
    Set-Content -LiteralPath $singletonExecutable `
        -Value 'runtime singleton executable fixture' -Encoding Ascii

    $previousPath = $env:PATH
    $previousPassword = $env:WIN_CSC_KEY_PASSWORD
    try {
        $env:PATH = $singletonToolDir + [System.IO.Path]::PathSeparator + $previousPath
        $env:WIN_CSC_KEY_PASSWORD = 'runtime-singleton-password'
        $singletonRun = Invoke-ChildPowerShell -ScriptPath $resolvedSignScript -Arguments @(
            '-FilePaths', $singletonExecutable,
            '-CodeSigningRepo', $singletonSigningRepo
        )
    } finally {
        $env:PATH = $previousPath
        $env:WIN_CSC_KEY_PASSWORD = $previousPassword
    }
    $singletonOutput = $singletonRun.Output -join "`n"
    if ($singletonRun.ExitCode -ne 0 -or
        $singletonOutput -notmatch '(?i)Code signing:\s*signing 1 EXE artifact' -or
        $singletonOutput -match '(?i)property [''"]?Count[''"]? cannot be found' -or
        $singletonOutput -notmatch '(?i)Code signing:\s*step complete\.') {
        $failures += "Singleton FilePaths input did not remain a one-item collection: exit=$($singletonRun.ExitCode) output=$singletonOutput"
        Write-Host '[SIGN INPUT FAIL] singleton FilePaths collection collapsed'
    } else {
        Write-Host '[SIGN INPUT PASS] singleton FilePaths remained a one-item collection'
    }

    if ($failures.Count -gt 0) {
        Write-Host "[SIGN INPUT REGRESSION] FAIL cases=$($failures.Count)"
        foreach ($failure in $failures) { Write-Host "  - $failure" }
        exit 1
    }
    Write-Host '[SIGN INPUT REGRESSION] PASS cases=5'
    exit 0
} finally {
    if (Test-Path -LiteralPath $resolvedRoot -PathType Container) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
