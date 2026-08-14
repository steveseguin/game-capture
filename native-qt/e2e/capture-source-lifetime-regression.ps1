$ErrorActionPreference = "Stop"

$sourceScript = Join-Path (Split-Path -Parent $PSScriptRoot) "qa\e2e-capture-source.ps1"
if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) {
    throw "E2E capture source script not found: $sourceScript"
}

$title = "Game Capture E2E Lifetime $([guid]::NewGuid().ToString('N'))"
$argumentText = "-NoProfile -ExecutionPolicy Bypass -STA -File `"$sourceScript`" -Title `"$title`""
$process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentText -PassThru -WindowStyle Normal

try {
    $deadline = (Get-Date).AddSeconds(15)
    $windowReady = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $process.Refresh()
        if ($process.HasExited) {
            throw "E2E capture source exited before its window became available"
        }
        if ($process.MainWindowTitle -eq $title) {
            $windowReady = $true
            break
        }
    }
    if (-not $windowReady) {
        throw "Timed out waiting for E2E capture source window"
    }

    if (-not $process.CloseMainWindow()) {
        throw "Could not send a close request to the E2E capture source"
    }
    Start-Sleep -Milliseconds 1500
    $process.Refresh()
    if ($process.HasExited) {
        throw "E2E capture source accepted an ordinary close request"
    }

    Write-Output "E2E capture source lifetime regression passed"
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        [void]$process.WaitForExit(5000)
    }
}
