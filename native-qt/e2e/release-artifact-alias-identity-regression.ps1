[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DistDir,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,
    [switch]$AllowMissingFfmpeg = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedDistDir = [System.IO.Path]::GetFullPath($DistDir)
if (-not (Test-Path -LiteralPath $resolvedDistDir -PathType Container)) {
    Write-Host "[ALIAS-IDENTITY] FAIL dist directory is missing: $resolvedDistDir"
    exit 1
}

$pairs = @(
    [pscustomobject]@{
        name = 'setup'
        versioned = "game-capture-$Version-setup.exe"
        stable = 'game-capture-setup.exe'
        required = $true
    },
    [pscustomobject]@{
        name = 'portable'
        versioned = "game-capture-$Version-portable.exe"
        stable = 'game-capture-portable.exe'
        required = $true
    },
    [pscustomobject]@{
        name = 'win64-zip'
        versioned = "game-capture-$Version-win64.zip"
        stable = 'game-capture-win64.zip'
        required = $true
    },
    [pscustomobject]@{
        name = 'ffmpeg-source-info'
        versioned = "game-capture-$Version-ffmpeg-source-info.zip"
        stable = 'game-capture-ffmpeg-source-info.zip'
        required = -not $AllowMissingFfmpeg
    }
)

$failures = New-Object System.Collections.Generic.List[string]
$checked = 0
foreach ($pair in $pairs) {
    $versionedPath = Join-Path $resolvedDistDir $pair.versioned
    $stablePath = Join-Path $resolvedDistDir $pair.stable
    $versionedPresent = Test-Path -LiteralPath $versionedPath
    $stablePresent = Test-Path -LiteralPath $stablePath
    $versionedExists = Test-Path -LiteralPath $versionedPath -PathType Leaf
    $stableExists = Test-Path -LiteralPath $stablePath -PathType Leaf

    if (-not $pair.required -and -not $versionedPresent -and -not $stablePresent) {
        Write-Host ("[PAIR {0}] SKIP optional pair absent" -f $pair.name)
        Write-Host ("  [VERSIONED] path={0}" -f $versionedPath)
        Write-Host ("  [STABLE]    path={0}" -f $stablePath)
        continue
    }

    if (-not $versionedExists -or -not $stableExists) {
        Write-Host ("[PAIR {0}] FAIL missing corresponding artifact" -f $pair.name)
        Write-Host ("  [VERSIONED] exists={0} path={1}" -f $versionedExists, $versionedPath)
        Write-Host ("  [STABLE]    exists={0} path={1}" -f $stableExists, $stablePath)
        $failures.Add("$($pair.name): missing corresponding artifact") | Out-Null
        continue
    }

    $versionedHash = (Get-FileHash -LiteralPath $versionedPath -Algorithm SHA256).Hash
    $stableHash = (Get-FileHash -LiteralPath $stablePath -Algorithm SHA256).Hash
    $checked++
    Write-Host ("[PAIR {0}]" -f $pair.name)
    Write-Host ("  [VERSIONED] path={0} sha256={1}" -f $versionedPath, $versionedHash)
    Write-Host ("  [STABLE]    path={0} sha256={1}" -f $stablePath, $stableHash)

    if ($versionedHash -cne $stableHash) {
        Write-Host ("  [RESULT] FAIL byte identity mismatch")
        $failures.Add("$($pair.name): SHA256 mismatch") | Out-Null
    } else {
        Write-Host ("  [RESULT] PASS byte-identical")
    }
}

if ($failures.Count -gt 0) {
    Write-Host ("[ALIAS-IDENTITY] FAIL version={0} dist={1} checked={2} failures={3}" -f $Version, $resolvedDistDir, $checked, $failures.Count)
    foreach ($failure in $failures) {
        Write-Host ("  - {0}" -f $failure)
    }
    exit 1
}

Write-Host ("[ALIAS-IDENTITY] PASS version={0} dist={1} checked={2}" -f $Version, $resolvedDistDir, $checked)
exit 0
