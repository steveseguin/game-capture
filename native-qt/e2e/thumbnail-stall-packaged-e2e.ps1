param(
    [Parameter(Mandatory = $true)][string]$PublisherPath,
    [string]$ReportDir = ""
)
$ErrorActionPreference = 'Stop'
$publisher = (Resolve-Path -LiteralPath $PublisherPath).Path
if (-not (Test-Path (Join-Path (Split-Path $publisher) 'platforms/qwindows.dll'))) {
    throw 'A complete packaged application is required.'
}
if (-not $ReportDir) { $ReportDir = Join-Path $PSScriptRoot 'reports/thumbnail-stall' }
$runDir = Join-Path ([IO.Path]::GetFullPath($ReportDir)) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$discovery = Join-Path $runDir 'control.json'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\VDO.Ninja\Game Capture\video')
$hadMode = $key.GetValueNames() -contains 'sourceMode'
$originalMode = $key.GetValue('sourceMode')
$originalKind = if ($hadMode) { $key.GetValueKind('sourceMode') } else { 'String' }
$process = $null
$fixtureProcess = $null
$results = [Collections.Generic.List[object]]::new()
function Record([string]$Name, [bool]$Passed) {
    $results.Add([pscustomobject]@{name=$Name; passed=$Passed})
    Write-Host "$Name : $Passed"
}
function Wait-File([string]$Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath (Join-Path $runDir $Name))) {
        if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for $Name" }
        Start-Sleep -Milliseconds 100
    }
}
try {
    $key.SetValue('sourceMode', 'window')
    $fixture = Join-Path $PSScriptRoot 'thumbnail-stall-fixture.ps1'
    $fixtureProcess = Start-Process powershell -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $fixture + '"'), '-StateDir', ('"' + $runDir + '"')
    ) -WindowStyle Hidden -PassThru
    Wait-File 'ready'
    Wait-File 'entered'
    $process = Start-Process -FilePath $publisher -ArgumentList @(
        '--local-control', ('--local-control-discovery="' + $discovery + '"')
    ) -WindowStyle Hidden -PassThru
    Wait-File 'control.json'
    $control = Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json
    Record 'source-message-loop-is-stalled' (Test-Path -LiteralPath (Join-Path $runDir 'entered'))
    $responsive = $false
    try {
        $health = Invoke-RestMethod ($control.base_url + '/health') -TimeoutSec 2
        $responsive = $health.pid -eq $process.Id
    } catch { }
    Record 'startup-responsive-with-stalled-source' $responsive
    if ($responsive) {
        $initialThreads = $process.Threads.Count
        $steady = $true
        for ($sample=0; $sample -lt 7; $sample++) {
            Start-Sleep -Milliseconds 1000
            $health = Invoke-RestMethod ($control.base_url + '/health') -TimeoutSec 2
            $steady = $steady -and $health.pid -eq $process.Id
        }
        $process.Refresh()
        Record 'responsive-across-automatic-refreshes' $steady
        Record 'worker-count-remains-bounded' ($process.Threads.Count -le $initialThreads + 4)
        Invoke-RestMethod ($control.base_url + '/commands') -Method Post -TimeoutSec 2 `
            -Headers @{Authorization=('Bearer ' + $control.token)} `
            -ContentType application/json -Body '{"command":"quit"}' | Out-Null
        Record 'quit-completes-while-source-is-stalled' ($process.WaitForExit(5000) -and -not (Test-Path -LiteralPath (Join-Path $runDir 'release')))
    }
} finally {
    Set-Content -LiteralPath (Join-Path $runDir 'release') -Value release
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    if ($fixtureProcess -and -not $fixtureProcess.HasExited) {
        Start-Sleep -Milliseconds 100
        [void]$fixtureProcess.CloseMainWindow()
        if (-not $fixtureProcess.WaitForExit(2000)) { Stop-Process -Id $fixtureProcess.Id -Force }
    }
    if ($hadMode) { $key.SetValue('sourceMode', $originalMode, $originalKind) }
    else { $key.DeleteValue('sourceMode', $false) }
    $key.Dispose()
    [pscustomobject]@{publisher=$publisher; sha256=(Get-FileHash $publisher).Hash; results=@($results.ToArray())} |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDir 'results.json')
    Write-Host "Results: $runDir"
}
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
