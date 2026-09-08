param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [string]$ReportDir = ""
)
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer workflow from an elevated PowerShell session. No changes were made.'
}
# The installer uses shared registry/shortcut names and closes all publishers.
# Refuse to disturb an existing installation, firewall rule, shortcut, or app.
foreach ($key in @('HKLM:\Software\GameCapture', 'HKLM:\Software\WOW6432Node\GameCapture',
                   'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture',
                   'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\GameCapture')) {
    if (Test-Path $key) { throw 'An existing Game Capture install must be tested on a separate host.' }
}
if (Get-Process game-capture -ErrorAction SilentlyContinue) { throw 'Close existing publishers or use a separate host.' }
if (@(Get-NetFirewallRule -ErrorAction Stop | Where-Object DisplayName -eq 'Game Capture WebRTC UDP').Count) {
    throw 'An existing firewall rule must be preserved; use a separate host.'
}
foreach ($shortcut in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Game Capture.lnk'),
                        (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Game Capture.lnk'),
                        (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Game Capture'),
                        (Join-Path ([Environment]::GetFolderPath('Programs')) 'Game Capture'))) {
    if (Test-Path -LiteralPath $shortcut) { throw "Existing shortcut must be preserved: $shortcut" }
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if (-not $ReportDir) { $ReportDir = Join-Path $PSScriptRoot '../qa/reports/installer-firewall' }
$reportRoot = [IO.Path]::GetFullPath($ReportDir)
$runDir = Join-Path $reportRoot ([guid]::NewGuid().ToString('N'))
$installDir = Join-Path $runDir 'installed'
if (-not $installDir.StartsWith($reportRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer target must remain within the report directory.'
}
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$exe = Join-Path $installDir 'game-capture.exe'
$discovery = Join-Path $runDir 'control.json'
$publisher = $null
$results = [ordered]@{ installer = $installer; installerSha256 = (Get-FileHash $installer -Algorithm SHA256).Hash; installDir = $installDir }
try {
    $setup = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDir") -WindowStyle Hidden -PassThru
    if (-not $setup.WaitForExit(120000)) { throw 'Installer did not finish within two minutes.' }
    if ($setup.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw "Install failed: $($setup.ExitCode)" }
    $firewall = & (Join-Path $PSScriptRoot '../tools/check-firewall.ps1') -ExecutablePath $exe | ConvertFrom-Json
    if (-not $firewall.matching_installer_rule) { throw 'Installed executable has no enabled inbound UDP installer rule.' }
    $results.installedFirewall = $firewall
    $publisher = Start-Process -FilePath $exe -ArgumentList @('--local-control', '--local-control-port=0', "--local-control-discovery=$discovery") -WindowStyle Hidden -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($publisher.HasExited) { throw 'Installed app exited before local control was ready.' }
        try {
            $control = Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json
            $health = Invoke-RestMethod ($control.base_url + '/health') -TimeoutSec 2
            if ($health.pid -eq $publisher.Id) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw 'Installed app did not expose local control.' }
    $headers = @{ Authorization = "Bearer $($control.token)" }
    $results.diagnostics = Invoke-RestMethod ($control.base_url + '/diagnostics') -Headers $headers -TimeoutSec 5
    Invoke-RestMethod ($control.base_url + '/commands') -Method Post -Headers $headers -ContentType 'application/json' -Body '{"command":"quit"}' | Out-Null
    if (-not $publisher.WaitForExit(10000)) { throw 'Installed app failed to quit.' }
    $results.applicationWorkflow = 'PASS'
} finally {
    if ($publisher -and -not $publisher.HasExited) { Stop-Process -Id $publisher.Id -ErrorAction SilentlyContinue }
    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installDir") -WindowStyle Hidden -PassThru
        if (-not $uninstall.WaitForExit(60000)) { throw 'Uninstall did not finish within one minute.' }
        $remaining = & (Join-Path $PSScriptRoot '../tools/check-firewall.ps1') -ExecutablePath $exe | ConvertFrom-Json
        $results.uninstalledFirewall = $remaining
        if ($uninstall.ExitCode -ne 0 -or $remaining.matching_installer_rule -or (Test-Path -LiteralPath $exe)) {
            throw 'Uninstall did not remove the installed application and its firewall rule.'
        }
        $results.uninstallWorkflow = 'PASS'
    }
    $results | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runDir 'results.json') -Encoding UTF8
}
Write-Output "PASS installed application, firewall creation, and uninstall removal. Report: $runDir"
