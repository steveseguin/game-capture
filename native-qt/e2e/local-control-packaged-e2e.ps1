param(
    [Parameter(Mandatory = $true)][string]$PublisherPath,
    [string]$ReportDir = ""
)

$ErrorActionPreference = 'Stop'
$publisher = (Resolve-Path -LiteralPath $PublisherPath).Path
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $publisher) 'platforms/qwindows.dll'))) {
    throw 'A complete packaged application is required.'
}
if (-not $ReportDir) { $ReportDir = Join-Path $PSScriptRoot 'reports/local-control' }
$ReportDir = [IO.Path]::GetFullPath($ReportDir)
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$runDir = Join-Path $ReportDir ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runDir | Out-Null
$discovery = Join-Path $runDir 'control.json'
$processes = [Collections.Generic.List[object]]::new()
$results = [Collections.Generic.List[object]]::new()

function Record([string]$Name, [bool]$Passed, $Actual) {
    $results.Add([pscustomobject]@{ name = $Name; passed = $Passed; actual = $Actual })
    Write-Host "$Name : $Passed ($Actual)"
}
function Start-Publisher {
    $process = Start-Process -FilePath $publisher -ArgumentList @(
        '--local-control', ('--local-control-discovery="' + $discovery + '"')
    ) -WindowStyle Hidden -PassThru
    $processes.Add($process)
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) { throw 'Publisher exited during startup.' }
        if (Test-Path -LiteralPath $discovery) {
            try {
                $control = Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json
                if ($control.pid -eq $process.Id) {
                    $health = Invoke-RestMethod ($control.base_url + '/health') -TimeoutSec 2
                    if ($health.pid -eq $process.Id) { return $control }
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    throw 'Publisher did not become ready.'
}
function Raw-Request($Control, [string]$Headers, [string]$Body = '', [switch]$Fragmented) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $client.Connect('127.0.0.1', [int]$Control.port)
        $stream = $client.GetStream()
        $stream.ReadTimeout = 2000
        $bytes = [Text.Encoding]::UTF8.GetBytes($Headers + "`r`n`r`n")
        $stream.Write($bytes, 0, $bytes.Length)
        if ($Fragmented) { Start-Sleep -Milliseconds 100 }
        $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
        $stream.Write($bytes, 0, $bytes.Length)
        $reader = [IO.StreamReader]::new($stream)
        try { return $reader.ReadToEnd() } catch { return 'TIMEOUT' }
    } finally { $client.Dispose() }
}
function Command($Control, $Body) {
    Invoke-RestMethod ($Control.base_url + '/commands') -Method Post -TimeoutSec 5 `
        -Headers @{ Authorization = ('Bearer ' + $Control.token) } `
        -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress)
}

try {
    $first = Start-Publisher
    $auth = @{ Authorization = ('Bearer ' + $first.token) }
    # Read actual application logs without modifying the log file.
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $logs = Invoke-RestMethod ($first.base_url + '/logs/recent') -Headers $auth -TimeoutSec 2
        if (@($logs.lines).Count -gt 1) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    Record 'application-logs-available' (@($logs.lines).Count -gt 1) (@($logs.lines).Count)
    foreach ($query in @('headlines=2', 'filter=lines=2', 'lines=2', 'lines=0')) {
        $logs = Invoke-RestMethod ($first.base_url + '/logs/recent?' + $query) -Headers $auth -TimeoutSec 2
        $count = @($logs.lines).Count
        $valid = switch ($query) {
            'lines=2' { $count -eq 2 }
            'lines=0' { $count -eq 1 }
            default { $count -gt 1 }
        }
        Record "log-query-$query" $valid $count
    }
    foreach ($length in @('-1', 'abc', '2147483648', '1048576', '+0', '')) {
        $response = Raw-Request $first "GET /health HTTP/1.1`r`nHost: localhost`r`nContent-Length: $length"
        Record "reject-length-$length" ($response -match '^HTTP/1.1 400 ') ($response.Split("`r`n")[0])
    }
    foreach ($framing in @("Content-Length: 0`r`nContent-Length: 1", 'Transfer-Encoding: chunked')) {
        $response = Raw-Request $first "GET /health HTTP/1.1`r`nHost: localhost`r`n$framing"
        $caseName = if ($framing.StartsWith('Content-Length')) { 'reject-duplicate-length' } else { 'reject-transfer-encoding' }
        Record $caseName ($response -match '^HTTP/1.1 400 ') ($response.Split("`r`n")[0])
    }
    $exportPath = Join-Path $runDir 'diagnostics.json'
    $body = @{ command = 'export_diagnostics'; path = $exportPath } | ConvertTo-Json -Compress
    $length = [Text.Encoding]::UTF8.GetByteCount($body)
    $response = Raw-Request $first "POST /commands HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $($first.token)`r`nContent-Length: $length" $body -Fragmented
    $exported = if (Test-Path -LiteralPath $exportPath) { Get-Content -Raw -LiteralPath $exportPath | ConvertFrom-Json } else { $null }
    Record 'fragmented-diagnostics-export' (($response -match '^HTTP/1.1 200 ') -and $null -ne $exported) ($response.Split("`r`n")[0])
    # Permit writing but deny replacement to exercise a failed atomic commit.
    $original = '{"previous":"keep this report"}'
    [IO.File]::WriteAllText($exportPath, $original)
    $lockedFile = [IO.File]::Open($exportPath, 'Open', 'Read', 'ReadWrite')
    try {
        $response = Raw-Request $first "POST /commands HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $($first.token)`r`nContent-Length: $length" $body
        Record 'failed-replacement-preserves-report' (($response -match '^HTTP/1.1 500 ') -and [IO.File]::ReadAllText($exportPath) -ceq $original) ($response.Split("`r`n")[0])
    } finally { $lockedFile.Dispose() }
    $response = Raw-Request $first "POST /commands HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $($first.token)`r`nContent-Length: $length" $body
    $updated = Get-Content -Raw -LiteralPath $exportPath | ConvertFrom-Json
    Record 'unlocked-replacement-succeeds' (($response -match '^HTTP/1.1 200 ') -and $null -ne $updated -and -not $updated.previous) ($response.Split("`r`n")[0])
    $body = @{ command = 'export_diagnostics'; path = $runDir } | ConvertTo-Json -Compress
    $response = Raw-Request $first "POST /commands HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $($first.token)`r`nContent-Length: $([Text.Encoding]::UTF8.GetByteCount($body))" $body
    Record 'export-failure-status' ($response -match '^HTTP/1.1 500 ') ($response.Split("`r`n")[0])
    $second = Start-Publisher
    Command $first @{ command = 'quit' } | Out-Null
    if (-not $processes[0].WaitForExit(10000)) { throw 'First publisher did not quit.' }
    $preserved = Test-Path -LiteralPath $discovery
    if ($preserved) { $preserved = (Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json).pid -eq $second.pid }
    Record 'older-instance-preserves-new-discovery' $preserved $preserved
    $health = Invoke-RestMethod ($second.base_url + '/health') -TimeoutSec 2
    Record 'second-instance-still-responds' ($health.pid -eq $second.pid) $health.pid
    Command $second @{ command = 'quit' } | Out-Null
    if (-not $processes[1].WaitForExit(10000)) { throw 'Second publisher did not quit.' }
    Record 'owner-removes-discovery' (-not (Test-Path -LiteralPath $discovery)) 'shutdown'
} finally {
    foreach ($process in $processes) {
        if (-not $process.HasExited) {
            [void]$process.CloseMainWindow()
            if (-not $process.WaitForExit(3000)) { Stop-Process -Id $process.Id -Force }
        }
    }
    [pscustomobject]@{
        publisher = $publisher
        sha256 = (Get-FileHash -LiteralPath $publisher -Algorithm SHA256).Hash
        results = @($results.ToArray())
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runDir 'results.json')
    Write-Host "Results: $runDir"
}
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
