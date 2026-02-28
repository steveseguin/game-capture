param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$Repo = "steveseguin/game-capture",
    [switch]$SkipFastGate = $false,
    [switch]$SkipVirusTotal = $false
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Name) {
    Write-Host ""
    Write-Host "=== $Name ==="
}

function Clear-ProxyEnv {
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")) {
        Remove-Item -Path ("Env:{0}" -f $name) -ErrorAction SilentlyContinue
    }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $repoRoot

Clear-ProxyEnv

if (-not $SkipFastGate) {
    Write-Step "Fast Gate"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run-fast-gate.ps1") -BuildDir $BuildDir -Configuration $Configuration
    if ($LASTEXITCODE -ne 0) {
        throw "Fast gate failed."
    }
}

Write-Step "Build Release Artifacts"
$buildArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "build-release.ps1"),
    "-BuildDir", $BuildDir,
    "-Configuration", $Configuration,
    "-Version", $Version
)
if ($SkipVirusTotal) {
    $buildArgs += "-SkipVirusTotal"
}
& powershell @buildArgs
if ($LASTEXITCODE -ne 0) {
    throw "build-release.ps1 failed."
}

$distRoot = Join-Path $repoRoot "native-qt\dist"
$versionedSetup = Join-Path $distRoot "game-capture-$Version-setup.exe"
$versionedPortable = Join-Path $distRoot "game-capture-$Version-portable.exe"
$versionedZip = Join-Path $distRoot "game-capture-$Version-win64.zip"
$stableSetup = Join-Path $distRoot "game-capture-setup.exe"
$stablePortable = Join-Path $distRoot "game-capture-portable.exe"
$stableZip = Join-Path $distRoot "game-capture-win64.zip"

$required = @($versionedSetup, $versionedPortable, $versionedZip, $stableSetup, $stablePortable, $stableZip)
foreach ($path in $required) {
    if (-not (Test-Path $path)) {
        throw "Missing release artifact: $path"
    }
}

$tag = "v$Version"
$title = "Game Capture v$Version"
$notesPath = Join-Path $repoRoot ("release-notes-{0}.md" -f $tag)
$notes = @"
## Game Capture $Version

Automated release from native QA flow:
- Fast gate (unless skipped)
- Build/package
- Code signing (best effort)
- VirusTotal submission (best effort)
"@
Set-Content -Path $notesPath -Value $notes -Encoding UTF8

Write-Step "Create/Update GitHub Release"
$releaseExists = $false
try {
    gh release view $tag --repo $Repo --json tagName | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $releaseExists = $true
    }
} catch {
    $releaseExists = $false
}

if ($releaseExists) {
    gh release upload $tag $versionedSetup $versionedPortable $versionedZip $stableSetup $stablePortable $stableZip --clobber --repo $Repo
    gh release edit $tag --repo $Repo --title $title --notes-file $notesPath --latest
} else {
    gh release create $tag $versionedSetup $versionedPortable $versionedZip $stableSetup $stablePortable $stableZip --repo $Repo --target main --title $title --notes-file $notesPath --latest
}

Remove-Item -Path $notesPath -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Release completed: https://github.com/$Repo/releases/tag/$tag"
