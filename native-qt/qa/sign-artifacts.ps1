param(
    [string]$DistDir = "",
    [string]$Version = "",
    [string]$CodeSigningRepo = "C:\Users\Steve\code\code-signing",
    [string[]]$FilePaths = @(),
    [switch]$FailOnError = $false
)

$ErrorActionPreference = "Stop"

function Resolve-SigntoolPath {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidate = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like "*\x64\signtool.exe" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($candidate) {
        return $candidate.FullName
    }

    return ""
}

function Resolve-CodeSigningPassword([string]$CodeSigningRepoPath) {
    if ($env:WIN_CSC_KEY_PASSWORD) {
        $value = $env:WIN_CSC_KEY_PASSWORD.Trim()
        if ($value) {
            return $value
        }
    }

    $configPath = Join-Path $CodeSigningRepoPath "secrets\decrypted\build-config.env"
    if (-not (Test-Path $configPath)) {
        return ""
    }

    $line = Get-Content $configPath -ErrorAction Stop | Where-Object { $_ -match '^WIN_CSC_KEY_PASSWORD=' } | Select-Object -First 1
    if (-not $line) {
        return ""
    }

    return ($line -replace '^WIN_CSC_KEY_PASSWORD=', '').Trim()
}

function Sign-File([string]$signtoolPath, [string]$pfxPath, [string]$password, [string]$filePath) {
    & $signtoolPath sign /fd SHA256 /td SHA256 /tr "http://timestamp.digicert.com" /f $pfxPath /p $password $filePath | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed for '$filePath' with exit code $LASTEXITCODE"
    }
}

function Test-SignatureAcceptable($signature) {
    if (-not $signature) {
        return $false
    }
    if (-not $signature.SignerCertificate) {
        return $false
    }

    # Local trust may report UnknownError for private/self-signed cert chains.
    # Treat as signed when signer cert is present and status is not a hard failure.
    $hardFailures = @("NotSigned", "HashMismatch", "NotSupported", "Incompatible")
    if ($hardFailures -contains [string]$signature.Status) {
        return $false
    }

    return $true
}

if (-not $DistDir) {
    $DistDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) "dist"
}

if (-not (Test-Path $DistDir)) {
    Write-Host "Code signing: dist directory not found ($DistDir); skipping."
    exit 0
}

$signtoolPath = Resolve-SigntoolPath
if (-not $signtoolPath) {
    $msg = "Code signing: signtool.exe not found; skipping."
    if ($FailOnError) {
        throw $msg
    }
    Write-Warning $msg
    exit 0
}

$pfxPath = Join-Path $CodeSigningRepo "secrets\decrypted\certs\socialstream.pfx"
if (-not (Test-Path $pfxPath)) {
    $msg = "Code signing: certificate not found at $pfxPath; skipping."
    if ($FailOnError) {
        throw $msg
    }
    Write-Warning $msg
    exit 0
}

$password = Resolve-CodeSigningPassword -CodeSigningRepoPath $CodeSigningRepo
if (-not $password) {
    $msg = "Code signing: WIN_CSC_KEY_PASSWORD missing (env or decrypted build-config.env); skipping."
    if ($FailOnError) {
        throw $msg
    }
    Write-Warning $msg
    exit 0
}

$allExes = @()
if ($FilePaths -and $FilePaths.Count -gt 0) {
    foreach ($path in $FilePaths) {
        if ([string]::IsNullOrWhiteSpace($path)) {
            continue
        }
        if (Test-Path $path) {
            $resolved = Resolve-Path $path
            $allExes += Get-Item $resolved
        } else {
            Write-Warning "Code signing: file path not found, skipping '$path'"
        }
    }
    $allExes = $allExes | Where-Object { $_.Extension -ieq ".exe" }
} else {
    $allExes = Get-ChildItem -Path $DistDir -File -Filter "*.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "game-capture*.exe" -and $_.Name -notlike "*uninstall*" }

    if ($Version) {
        $stableNames = @("game-capture-setup.exe", "game-capture-portable.exe")
        $versionPrefix = "game-capture-$Version-"
        $allExes = $allExes | Where-Object {
            ($stableNames -contains $_.Name) -or $_.Name.StartsWith($versionPrefix, [System.StringComparison]::OrdinalIgnoreCase)
        }
    }
}

$allExes = $allExes | Sort-Object FullName -Unique
if (-not $allExes) {
    Write-Host "Code signing: no matching game-capture EXEs found; skipping."
    exit 0
}

$failures = @()
Write-Host "Code signing: signing $($allExes.Count) EXE artifact(s)..."
foreach ($file in $allExes) {
    try {
        Sign-File -signtoolPath $signtoolPath -pfxPath $pfxPath -password $password -filePath $file.FullName
        $sig = Get-AuthenticodeSignature -FilePath $file.FullName
        if (-not (Test-SignatureAcceptable -signature $sig)) {
            throw "Signature check failed (status=$($sig.Status), message=$($sig.StatusMessage))"
        }
        $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "(none)" }
        Write-Host "  PASS $($file.Name) (status=$($sig.Status), signer=$subject)"
    } catch {
        $message = $_.Exception.Message
        Write-Warning "  FAIL $($file.Name): $message"
        $failures += [pscustomobject]@{
            Name = $file.Name
            Error = $message
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Warning "Code signing: $($failures.Count) artifact(s) failed to sign."
    if ($FailOnError) {
        exit 1
    }
}

Write-Host "Code signing: step complete."
exit 0
