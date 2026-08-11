param(
    [string]$DistDir = "",
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version = "",
    [string]$CodeSigningRepo = "C:\Users\Steve\code\code-signing",
    [string[]]$FilePaths = @(),
    [string[]]$TimestampServers = @(
        "http://timestamp.digicert.com",
        "http://timestamp.sectigo.com",
        "http://timestamp.globalsign.com/tsa/r6advanced1"
    ),
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

function Sign-File([string]$signtoolPath, [string]$pfxPath, [string]$password, [string]$filePath, [string[]]$timestampServers) {
    $attempts = if ($timestampServers -and @($timestampServers).Count -gt 0) {
        @($timestampServers)
    } else {
        @("http://timestamp.digicert.com")
    }

    $errors = @()
    foreach ($server in $attempts) {
        Write-Host "  Signing $([System.IO.Path]::GetFileName($filePath)) with timestamp server: $server"
        & $signtoolPath sign /fd SHA256 /td SHA256 /tr $server /f $pfxPath /p $password $filePath | Out-Host
        if ($LASTEXITCODE -eq 0) {
            return
        }
        $errors += "$server exited $LASTEXITCODE"
    }

    throw "signtool failed for '$filePath' with timestamp attempts: $($errors -join '; ')"
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

if ($DistDir -and [string]::IsNullOrWhiteSpace($Version)) {
    throw 'Version is required with DistDir.'
}

if ($DistDir -and $FilePaths -and @($FilePaths).Count -gt 0) {
    throw "Specify either DistDir or FilePaths, not both."
}

if (-not $DistDir -and (-not $FilePaths -or @($FilePaths).Count -eq 0)) {
    Write-Host "Code signing: no DistDir or FilePaths were provided; skipping."
    exit 0
}

if ($DistDir) {
    if (-not (Test-Path -LiteralPath $DistDir -PathType Container)) {
        throw "Code signing: dist directory not found: $DistDir"
    }
    $DistDir = [System.IO.Path]::GetFullPath($DistDir)
}

$allExes = @()
if ($FilePaths -and @($FilePaths).Count -gt 0) {
    foreach ($path in $FilePaths) {
        if ([string]::IsNullOrWhiteSpace($path)) {
            throw 'Explicit signing input must be a literal file.'
        }
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Explicit signing input must be a literal file.' }
        $resolved = Resolve-Path -LiteralPath $path
        $allExes += Get-Item -LiteralPath $resolved
    }
    $allExes = @($allExes | Where-Object { $_.Extension -ieq ".exe" })
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

$allExes = @($allExes | Sort-Object FullName -Unique)
if (@($allExes).Count -eq 0) {
    Write-Host "Code signing: no matching game-capture EXEs found; skipping."
    exit 0
}

$signingAvailable = $true
$signtoolPath = Resolve-SigntoolPath
if (-not $signtoolPath) {
    $msg = "Code signing: signtool.exe not found; skipping signing."
    if ($FailOnError) {
        throw $msg
    }
    Write-Warning $msg
    $signingAvailable = $false
}

$pfxPath = Join-Path $CodeSigningRepo "secrets\decrypted\certs\socialstream.pfx"
if ($signingAvailable -and -not (Test-Path -LiteralPath $pfxPath -PathType Leaf)) {
    $msg = "Code signing: certificate not found at $pfxPath; skipping signing."
    if ($FailOnError) {
        throw $msg
    }
    Write-Warning $msg
    $signingAvailable = $false
}

$password = ""
if ($signingAvailable) {
    $password = Resolve-CodeSigningPassword -CodeSigningRepoPath $CodeSigningRepo
    if (-not $password) {
        $msg = "Code signing: WIN_CSC_KEY_PASSWORD missing (env or decrypted build-config.env); skipping signing."
        if ($FailOnError) {
            throw $msg
        }
        Write-Warning $msg
        $signingAvailable = $false
    }
}

$failures = @()
if ($signingAvailable) {
    Write-Host "Code signing: signing $(@($allExes).Count) EXE artifact(s)..."
    foreach ($file in $allExes) {
        try {
            Sign-File -signtoolPath $signtoolPath -pfxPath $pfxPath -password $password -filePath $file.FullName -timestampServers $TimestampServers
            $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $file.FullName
            if (-not (Test-SignatureAcceptable -signature $signature)) {
                throw "Signature check failed (status=$($signature.Status), message=$($signature.StatusMessage))"
            }
            $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "(none)" }
            Write-Host "  PASS $($file.Name) (status=$($signature.Status), signer=$subject)"
        } catch {
            $message = $_.Exception.Message
            Write-Warning "  FAIL $($file.Name): $message"
            $failures += [pscustomobject]@{
                Name = $file.Name
                Error = $message
            }
        }
    }
}

if ($DistDir) {
    $stableSetupPath = Join-Path $DistDir 'game-capture-setup.exe'
    $stablePortablePath = Join-Path $DistDir 'game-capture-portable.exe'

    if ((Test-Path -LiteralPath $stableSetupPath) -and -not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) {
        throw 'Stable setup destination must be absent or a literal file.'
    }
    Copy-Item -LiteralPath $versionedSetupPath -Destination $stableSetupPath -Force -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $stableSetupPath -PathType Leaf)) {
        throw 'Stable setup alias was not created as a literal file.'
    }
    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedSetupPath -Algorithm SHA256).Hash -cne
        (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stableSetupPath -Algorithm SHA256).Hash) {
        throw 'Stable setup alias hash mismatch.'
    }

    if ((Test-Path -LiteralPath $stablePortablePath) -and -not (Test-Path -LiteralPath $stablePortablePath -PathType Leaf)) {
        throw 'Stable portable destination must be absent or a literal file.'
    }
    Copy-Item -LiteralPath $versionedPortablePath -Destination $stablePortablePath -Force -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $stablePortablePath -PathType Leaf)) {
        throw 'Stable portable alias was not created as a literal file.'
    }
    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $versionedPortablePath -Algorithm SHA256).Hash -cne
        (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $stablePortablePath -Algorithm SHA256).Hash) {
        throw 'Stable portable alias hash mismatch.'
    }
}

if ($failures.Count -gt 0) {
    Write-Warning "Code signing: $(@($failures).Count) artifact(s) failed to sign."
    if ($FailOnError) {
        exit 1
    }
}

Write-Host "Code signing: step complete."
exit 0
