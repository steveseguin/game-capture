param(
    [string]$DistDir = "",
    [switch]$FailOnError = $false
)

$ErrorActionPreference = "Stop"

function Get-ApiKey([string[]]$candidateFiles) {
    if ($env:VT_API_KEY) {
        $value = $env:VT_API_KEY.Trim()
        if ($value) {
            return $value
        }
    }

    foreach ($file in $candidateFiles) {
        if (Test-Path $file) {
            $value = (Get-Content $file -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
            if ($value) {
                return $value
            }
        }
    }

    return ""
}

function Submit-FileToVirusTotal([string]$curlPath, [string]$apiKey, [string]$filePath) {
    $response = & $curlPath `
        --silent `
        --show-error `
        --fail-with-body `
        --request POST `
        --header ("x-apikey: {0}" -f $apiKey) `
        --form ("file=@{0}" -f $filePath) `
        "https://www.virustotal.com/api/v3/files" 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "curl failed for '$filePath': $response"
    }

    $json = $response | ConvertFrom-Json -ErrorAction Stop
    if (-not $json.data -or -not $json.data.id) {
        throw "VirusTotal response missing analysis ID for '$filePath'."
    }

    return [pscustomobject]@{
        AnalysisId = $json.data.id
        Url = "https://www.virustotal.com/gui/file-analysis/$($json.data.id)"
    }
}

$nativeQtRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$repoRoot = Resolve-Path (Join-Path $nativeQtRoot "..")
if (-not $DistDir) {
    $DistDir = Join-Path $nativeQtRoot "dist"
}

if (-not (Test-Path $DistDir)) {
    Write-Host "VirusTotal: dist directory not found ($DistDir); skipping."
    exit 0
}

$apiKey = Get-ApiKey -candidateFiles @(
    (Join-Path $nativeQtRoot ".vt-apikey"),
    (Join-Path $repoRoot ".vt-apikey")
)

if (-not $apiKey) {
    Write-Host "VirusTotal: VT_API_KEY not set (and no .vt-apikey found); skipping submission."
    exit 0
}

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) {
    $msg = "VirusTotal: curl.exe not found; cannot submit artifacts."
    if ($FailOnError) {
        throw $msg
    }
    Write-Warning $msg
    exit 0
}

$allExes = Get-ChildItem -Path $DistDir -File -Filter "*.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "game-capture*.exe" -and $_.Name -notlike "*uninstall*" } |
    Sort-Object Name

if (-not $allExes) {
    Write-Host "VirusTotal: no game-capture EXEs found in $DistDir; skipping."
    exit 0
}

$seenHashes = @{}
$targets = @()
foreach ($file in $allExes) {
    $hash = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $seenHashes.ContainsKey($hash)) {
        $seenHashes[$hash] = $true
        $targets += [pscustomobject]@{
            Name = $file.Name
            Path = $file.FullName
            Sha256 = $hash
        }
    } else {
        Write-Host "VirusTotal: skipping duplicate-by-hash alias $($file.Name)"
    }
}

$failures = @()

Write-Host "VirusTotal: submitting $($targets.Count) unique EXE artifact(s)..."
foreach ($target in $targets) {
    try {
        $result = Submit-FileToVirusTotal -curlPath $curl.Source -apiKey $apiKey -filePath $target.Path
        Write-Host "  PASS $($target.Name)"
        Write-Host "    SHA256: $($target.Sha256)"
        Write-Host "    Analysis: $($result.Url)"
    } catch {
        $message = $_.Exception.Message
        Write-Warning "  FAIL $($target.Name): $message"
        $failures += [pscustomobject]@{
            Name = $target.Name
            Error = $message
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Warning "VirusTotal: $($failures.Count) submission(s) failed."
    if ($FailOnError) {
        exit 1
    }
}

Write-Host "VirusTotal: submission step complete."
exit 0
