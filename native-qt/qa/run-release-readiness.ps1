param(
    [string]$BuildDir = "build-review2",
    [string]$Configuration = "Release",
    [string]$PublisherPath = "",
    [switch]$IncludeSoak = $false,
    [switch]$SkipSoak = $false,
    [int]$SoakDurationMin = 30,
    [int]$SoakHoldMs = 15000,
    [int]$DualSoakHoldMs = 4000,
    [string]$SoakPassword = "",
    [string]$SoakVideoEncoder = "",
    [string]$RefreshPassword = "",
    [string]$RefreshVideoEncoder = "nvenc",
    [string]$ControlPassword = "",
    [string]$ControlToken = "release-control-token",
    [string]$FfmpegPath = "",
    [switch]$SkipDualStream = $false,
    [switch]$CheckHardwareEncoders = $true,
    [switch]$EnforceHardwareEncoders = $false,
    [int]$BitrateRetries = 1,
    [int]$HardwareRetries = 1
)

$ErrorActionPreference = "Stop"

function Write-Section($title) {
    Write-Host ""
    Write-Host "=== $title ==="
}

function Run-Step($name, [scriptblock]$action) {
    Write-Section $name
    try {
        $global:LASTEXITCODE = 0
        & $action | Out-Host
        if ($global:LASTEXITCODE -ne 0) {
            throw "Command exited with code $($global:LASTEXITCODE)"
        }
        return $true
    } catch {
        Write-Host "FAILED: $name"
        Write-Host $_
        return $false
    }
}

function Run-StepWithRetry($name, [int]$attempts, [scriptblock]$action) {
    $totalAttempts = [Math]::Max(1, $attempts)
    for ($attempt = 1; $attempt -le $totalAttempts; $attempt++) {
        $attemptName = $name
        if ($totalAttempts -gt 1) {
            $attemptName = "$name (attempt $attempt/$totalAttempts)"
        }
        $ok = Run-Step $attemptName $action
        if ($ok) {
            return $true
        }
        if ($attempt -lt $totalAttempts) {
            Write-Host "Retrying $name..."
            Start-Sleep -Seconds 2
        }
    }
    return $false
}

function Resolve-PublisherExecutable([string]$RepoRoot, [string]$BuildDir, [string]$Configuration, [string]$ExplicitPath) {
    if ($ExplicitPath) {
        if (Test-Path $ExplicitPath) {
            return (Resolve-Path $ExplicitPath).Path
        }
        throw "Publisher executable not found at explicit path: $ExplicitPath"
    }

    $candidates = @(
        (Join-Path $RepoRoot "$BuildDir/bin/$Configuration/versus-qt.exe"),
        (Join-Path $RepoRoot "$BuildDir/bin/versus-qt.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }
    return ""
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportDir = Join-Path $PSScriptRoot "reports"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$reportPath = Join-Path $reportDir "release-readiness-$timestamp.md"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$publisherExe = Resolve-PublisherExecutable -RepoRoot $repoRoot -BuildDir $BuildDir -Configuration $Configuration -ExplicitPath $PublisherPath
if (-not $publisherExe) {
    throw "Could not locate versus-qt.exe for BuildDir '$BuildDir' and Configuration '$Configuration'. Build first or pass -PublisherPath."
}

if ($IncludeSoak -and $SkipSoak) {
    throw "Use either -IncludeSoak or -SkipSoak, not both."
}

# Soak is now part of the default release gate.
$runSoak = $IncludeSoak -or (-not $SkipSoak)

$lines = @()
$lines += "# Release Readiness Report"
$lines += ""
$lines += "- Date: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")"
$lines += "- Build dir: $BuildDir"
$lines += "- Config: $Configuration"
$lines += "- Publisher path: $publisherExe"
$lines += "- FFmpeg path override: $(if ($FfmpegPath) { $FfmpegPath } else { "(auto)" })"
$lines += "- Bitrate retries: $BitrateRetries"
$lines += "- Hardware retries: $HardwareRetries"
$lines += "- Refresh password: $(if ($RefreshPassword -ne '') { $RefreshPassword } else { '(default)' })"
$lines += "- Refresh encoder: $(if ($RefreshVideoEncoder) { $RefreshVideoEncoder } else { "(default)" })"
$lines += "- Control password: $(if ($ControlPassword -ne '') { $ControlPassword } else { '(default)' })"
$lines += "- Control token length: $($ControlToken.Length)"
$lines += "- Dual-stream gate enabled: $(if ($SkipDualStream) { 'no (explicitly skipped)' } else { 'yes' })"
$lines += "- Soak gate enabled: $(if ($runSoak) { 'yes' } else { 'no (explicitly skipped)' })"
$lines += "- Dual soak hold-ms: $DualSoakHoldMs"
$lines += ""

$ffmpegCliArg = ""
if ($FfmpegPath) {
    $ffmpegCliArg = " --ffmpeg-path=`"$FfmpegPath`""
}

$allPass = $true

$gpuInfo = Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterCompatibility, VideoProcessor
$lines += "## GPU Inventory"
$lines += ""
foreach ($gpu in $gpuInfo) {
    $lines += "- $($gpu.Name) | Driver $($gpu.DriverVersion) | Vendor $($gpu.AdapterCompatibility)"
}
$lines += ""

$nvidiaSmi = ""
try {
    $nvidiaSmi = cmd /c "nvidia-smi --query-gpu=name,driver_version,encoder.stats.averageFps,encoder.stats.averageLatency --format=csv,noheader"
} catch {
    $nvidiaSmi = "nvidia-smi unavailable"
}
$lines += "## NVIDIA Encoder Snapshot"
$lines += ""
$lines += '```text'
$lines += $nvidiaSmi
$lines += '```'
$lines += ""

$ctestPass = Run-Step "CTest" {
    ctest --test-dir $BuildDir -C $Configuration --output-on-failure
}
$allPass = $allPass -and $ctestPass
$lines += "## CTest"
$lines += ""
$lines += "- Result: " + ($(if ($ctestPass) { "PASS" } else { "FAIL" }))
$lines += ""

$e2ePass = Run-Step "E2E Matrix" {
    cmd /c "npm --prefix `"$repoRoot`" run e2e:matrix -- --publisher-path=`"$publisherExe`""
}
$allPass = $allPass -and $e2ePass
$lines += "## E2E Matrix"
$lines += ""
$lines += "- Result: " + ($(if ($e2ePass) { "PASS" } else { "FAIL" }))
$lines += ""

$refreshPass = Run-Step "E2E Refresh (dual-viewer reconnect)" {
    $refreshCmd = "npm --prefix `"$repoRoot`" run e2e:refresh -- --publisher-path=`"$publisherExe`" --reloads=3 --join-delay-ms=8000 --timeout-ms=60000 --password=$RefreshPassword"
    if ($RefreshVideoEncoder) {
        $refreshCmd += " --video-encoder=$RefreshVideoEncoder"
    }
    if ($FfmpegPath) {
        $refreshCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    cmd /c $refreshCmd
}
$allPass = $allPass -and $refreshPass
$lines += "## E2E Refresh"
$lines += ""
$lines += "- Result: " + ($(if ($refreshPass) { "PASS" } else { "FAIL" }))
$lines += "- Password: $(if ($RefreshPassword -ne '') { $RefreshPassword } else { '(default)' })"
$lines += "- Video encoder: $(if ($RefreshVideoEncoder) { $RefreshVideoEncoder } else { "(default)" })"
$lines += ""

$collisionPass = Run-Step "E2E Stream-ID Collision" {
    $collisionCmd = "npm --prefix `"$repoRoot`" run e2e:collision -- --publisher-path=`"$publisherExe`" --timeout-ms=30000 --password=$RefreshPassword"
    if ($RefreshVideoEncoder) {
        $collisionCmd += " --video-encoder=$RefreshVideoEncoder"
    }
    if ($FfmpegPath) {
        $collisionCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    cmd /c $collisionCmd
}
$allPass = $allPass -and $collisionPass
$lines += "## E2E Stream-ID Collision"
$lines += ""
$lines += "- Result: " + ($(if ($collisionPass) { "PASS" } else { "FAIL" }))
$lines += "- Password: $(if ($RefreshPassword -ne '') { $RefreshPassword } else { '(default)' })"
$lines += "- Video encoder: $(if ($RefreshVideoEncoder) { $RefreshVideoEncoder } else { "(default)" })"
$lines += ""

$controlPass = Run-Step "E2E Data Channel Control" {
    $controlCmd = "npm --prefix `"$repoRoot`" run e2e:control -- --publisher-path=`"$publisherExe`" --timeout-ms=60000 --password=$ControlPassword --remote-token=$ControlToken --bitrate-kbps=4500"
    if ($RefreshVideoEncoder) {
        $controlCmd += " --video-encoder=$RefreshVideoEncoder"
    }
    if ($FfmpegPath) {
        $controlCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    cmd /c $controlCmd
}
$allPass = $allPass -and $controlPass
$lines += "## E2E Data Channel Control"
$lines += ""
$lines += "- Result: " + ($(if ($controlPass) { "PASS" } else { "FAIL" }))
$lines += "- Password: $(if ($ControlPassword -ne '') { $ControlPassword } else { '(default)' })"
$lines += "- Token length: $($ControlToken.Length)"
$lines += ""

$dualQualityPass = $true
$dualQualityChurnPass = $true
$dualInitFuzzPass = $true
$dualRequirementsPass = $true
if (-not $SkipDualStream) {
    $dualQualityPass = Run-Step "E2E Dual Quality Roles" {
        $dualCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --timeout-ms=60000"
        if ($RefreshVideoEncoder) {
            $dualCmd += " --video-encoder=$RefreshVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        cmd /c $dualCmd
    }
    $allPass = $allPass -and $dualQualityPass

    $dualQualityChurnPass = Run-Step "E2E Dual Quality Churn" {
        $dualChurnCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality-churn -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --cycles=4 --timeout-ms=60000 --hold-ms=2500 --join-gap-ms=250 --leave-gap-ms=250"
        if ($RefreshVideoEncoder) {
            $dualChurnCmd += " --video-encoder=$RefreshVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualChurnCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        cmd /c $dualChurnCmd
    }
    $allPass = $allPass -and $dualQualityChurnPass

    $dualInitFuzzPass = Run-Step "E2E Dual Quality Init Fuzz" {
        $dualFuzzCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality-init-fuzz -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --timeout-ms=60000"
        if ($RefreshVideoEncoder) {
            $dualFuzzCmd += " --video-encoder=$RefreshVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualFuzzCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        cmd /c $dualFuzzCmd
    }
    $allPass = $allPass -and $dualInitFuzzPass

    $dualRequirementsPass = Run-Step "E2E Dual Quality Requirements" {
        $dualReqCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality-requirements -- --publisher-path=`"$publisherExe`" --password=$RefreshPassword --timeout-ms=60000 --hold-ms=2500 --remote-token=$ControlToken"
        if ($RefreshVideoEncoder) {
            $dualReqCmd += " --video-encoder=$RefreshVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualReqCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        cmd /c $dualReqCmd
    }
    $allPass = $allPass -and $dualRequirementsPass
}
$lines += "## E2E Dual Quality"
$lines += ""
if ($SkipDualStream) {
    $lines += "- Result: SKIPPED (disabled via -SkipDualStream)"
} else {
    $lines += "- Mixed roles result: " + ($(if ($dualQualityPass) { "PASS" } else { "FAIL" }))
    $lines += "- Churn result: " + ($(if ($dualQualityChurnPass) { "PASS" } else { "FAIL" }))
    $lines += "- Init fuzz result: " + ($(if ($dualInitFuzzPass) { "PASS" } else { "FAIL" }))
    $lines += "- Requirements gate result: " + ($(if ($dualRequirementsPass) { "PASS" } else { "FAIL" }))
}
$lines += ""

$bitratePass = Run-StepWithRetry "Bitrate Preset Smoke" (1 + [Math]::Max(0, $BitrateRetries)) {
    $bitrateCmd = "npm --prefix `"$repoRoot`" run e2e:bitrate -- --publisher-path=`"$publisherExe`""
    if ($FfmpegPath) {
        $bitrateCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    cmd /c $bitrateCmd
}
$allPass = $allPass -and $bitratePass
$lines += "## Bitrate Preset Smoke"
$lines += ""
$lines += "- Result: " + ($(if ($bitratePass) { "PASS" } else { "FAIL" }))
$lines += ""

$hardwareChecksRan = $false
$hardwareNvencPass = $false
$hardwareQsvPass = $false
if ($CheckHardwareEncoders) {
    $hardwareChecksRan = $true
    $hardwareNvencPass = Run-StepWithRetry "Hardware Smoke (NVENC strict)" (1 + [Math]::Max(0, $HardwareRetries)) {
        cmd /c "npm --prefix `"$repoRoot`" run e2e:bitrate -- --publisher-path=`"$publisherExe`" --video-encoder=nvenc --bitrates=12000 --require-hardware --expect-encoder-name=nvenc,nvidia --forbid-encoder-name=intel,qsv$ffmpegCliArg"
    }
    $hardwareQsvPass = Run-StepWithRetry "Hardware Smoke (QSV strict)" (1 + [Math]::Max(0, $HardwareRetries)) {
        cmd /c "npm --prefix `"$repoRoot`" run e2e:bitrate -- --publisher-path=`"$publisherExe`" --video-encoder=qsv --bitrates=12000 --require-hardware --expect-encoder-name=intel,qsv,h264 encoder mft,avc dx12 --forbid-encoder-name=nvenc,nvidia$ffmpegCliArg"
    }
    if ($EnforceHardwareEncoders) {
        $allPass = $allPass -and $hardwareNvencPass -and $hardwareQsvPass
    }
}
$lines += "## Hardware Encoder Capability"
$lines += ""
if ($hardwareChecksRan) {
    $lines += "- NVENC strict result: " + ($(if ($hardwareNvencPass) { "PASS" } else { "FAIL" }))
    $lines += "- QSV strict result: " + ($(if ($hardwareQsvPass) { "PASS" } else { "FAIL" }))
    $lines += "- Enforced: " + ($(if ($EnforceHardwareEncoders) { "yes" } else { "no" }))
} else {
    $lines += "- Result: SKIPPED"
}
$lines += ""

$soakRan = $false
$soakPass = $true
$dualSoakPass = $true
if ($runSoak) {
    $soakRan = $true
    # Run dual-stream soak first while runtime/network state is fresh.
    if (-not $SkipDualStream) {
        $dualSoakCmd = "npm --prefix `"$repoRoot`" run e2e:dual-quality-soak -- --publisher-path=`"$publisherExe`" --duration-min=$SoakDurationMin --hold-ms=$DualSoakHoldMs --password=$SoakPassword --stream=dual_soak_$timestamp --room=dual_room_$timestamp"
        if ($SoakVideoEncoder) {
            $dualSoakCmd += " --video-encoder=$SoakVideoEncoder"
        }
        if ($FfmpegPath) {
            $dualSoakCmd += " --ffmpeg-path=`"$FfmpegPath`""
        }
        $dualSoakPass = Run-Step "E2E Dual Quality Soak" {
            cmd /c $dualSoakCmd
        }
        $allPass = $allPass -and $dualSoakPass
    }

    $soakCmd = "npm --prefix `"$repoRoot`" run e2e:soak -- --publisher-path=`"$publisherExe`" --duration-min=$SoakDurationMin --hold-ms=$SoakHoldMs --password=$SoakPassword --stream=soak_$timestamp"
    if ($SoakVideoEncoder) {
        $soakCmd += " --video-encoder=$SoakVideoEncoder"
    }
    if ($FfmpegPath) {
        $soakCmd += " --ffmpeg-path=`"$FfmpegPath`""
    }
    $soakPass = Run-Step "E2E Soak" {
        cmd /c $soakCmd
    }
    $allPass = $allPass -and $soakPass
}
$lines += "## E2E Soak"
$lines += ""
if ($soakRan) {
    $lines += "- Result: " + ($(if ($soakPass) { "PASS" } else { "FAIL" }))
    $lines += "- Duration-min: $SoakDurationMin"
    $lines += "- Hold-ms: $SoakHoldMs"
    $lines += "- Dual hold-ms: $DualSoakHoldMs"
    $lines += "- Password: $SoakPassword"
    $lines += "- Video encoder: $(if ($SoakVideoEncoder) { $SoakVideoEncoder } else { "(default)" })"
} else {
    $lines += "- Result: SKIPPED (disabled via -SkipSoak)"
}
$lines += "- Dual quality soak: " + ($(if ($SkipDualStream -or -not $soakRan) { "SKIPPED" } elseif ($dualSoakPass) { "PASS" } else { "FAIL" }))
$lines += ""

$installerRan = $false
$installerPass = $true
$makensis = Get-Command makensis -ErrorAction SilentlyContinue
if (-not $makensis) {
    foreach ($candidate in @(
        "C:\Program Files (x86)\NSIS\makensis.exe",
        "C:\Program Files\NSIS\makensis.exe"
    )) {
        if (Test-Path $candidate) {
            $makensis = [pscustomobject]@{ Path = $candidate }
            break
        }
    }
}
if ($makensis) {
    $installerRan = $true
    $installerPass = Run-Step "Installer Smoke" {
        $installerBinDir = ""
        $distDir = Join-Path $repoRoot "dist"
        $stageCandidates = @()
        if (Test-Path $distDir) {
            foreach ($pattern in @("game-capture-*-win64", "Versus-*-win64")) {
                $stageCandidates += Get-ChildItem -Path $distDir -Directory -Filter $pattern -ErrorAction SilentlyContinue
            }
        }
        $stageCandidate = $stageCandidates |
            Where-Object {
                (Test-Path (Join-Path $_.FullName "versus-qt.exe")) -and
                (Test-Path (Join-Path $_.FullName "platforms\qwindows.dll"))
            } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if (-not $stageCandidate) {
            $stageCandidate = $stageCandidates |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
        }
        if ($stageCandidate) {
            $installerBinDir = $stageCandidate.FullName
        } else {
            $installerBinDir = Join-Path $repoRoot "$BuildDir/bin/$Configuration"
            if (-not (Test-Path $installerBinDir)) {
                $installerBinDir = Join-Path $repoRoot "$BuildDir/bin"
            }
        }
        foreach ($requiredRelPath in @("versus-qt.exe", "platforms\qwindows.dll")) {
            $requiredPath = Join-Path $installerBinDir $requiredRelPath
            if (-not (Test-Path $requiredPath)) {
                throw "Installer smoke missing required staged artifact: $requiredPath"
            }
        }
        & $makensis.Path /V2 "/DBUILD_BIN_DIR=$installerBinDir" installer.nsi
        if ($LASTEXITCODE -ne 0) {
            throw "makensis failed with exit code $LASTEXITCODE"
        }
    }
    $allPass = $allPass -and $installerPass
} else {
    Write-Section "Installer Smoke"
    Write-Host "makensis not found; skipping installer build."
}
$lines += "## Installer Smoke"
$lines += ""
if ($installerRan) {
    $lines += "- Result: " + ($(if ($installerPass) { "PASS" } else { "FAIL" }))
} else {
    $lines += "- Result: SKIPPED"
}
$lines += ""

$lines += "## Overall"
$lines += ""
$lines += "- Result: " + ($(if ($allPass) { "PASS" } else { "FAIL" }))
$lines += ""

Set-Content -Path $reportPath -Value $lines -Encoding UTF8
Write-Host ""
Write-Host "Report written to: $reportPath"

if (-not $allPass) {
    exit 1
}
