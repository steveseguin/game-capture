param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PublisherPath,
    [string]$ReportDir = ""
)

$ErrorActionPreference = 'Stop'
$publisher = (Resolve-Path -LiteralPath $PublisherPath).Path
$packageRoot = Split-Path -Parent $publisher
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'platforms\qwindows.dll') -PathType Leaf)) {
    throw "Publisher is not a complete packaged application: $publisher"
}

if ([string]::IsNullOrWhiteSpace($ReportDir)) {
    $ReportDir = Join-Path $PSScriptRoot '..\qa\reports\ice-settings'
}
$ReportDir = [System.IO.Path]::GetFullPath($ReportDir)
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$settingsPath = 'HKCU:\Software\VDO.Ninja\Game Capture\network'
$valueName = 'iceMode'
$logPath = Join-Path $env:LOCALAPPDATA 'GameCapture\logs\game-capture-debug.log'
$originalKeyExists = Test-Path -LiteralPath $settingsPath
$originalValueExists = $false
$originalValue = $null
$originalKind = $null
if ($originalKeyExists) {
    try {
        $originalValue = (Get-ItemProperty -LiteralPath $settingsPath -Name $valueName -ErrorAction Stop).$valueName
        $originalValueExists = $true
        $originalKind = (Get-Item -LiteralPath $settingsPath).GetValueKind($valueName)
    } catch [System.Management.Automation.PSArgumentException] {
        $originalValueExists = $false
    }
}

function Set-IceSetting([AllowNull()][string]$Value, [switch]$Missing) {
    New-Item -Path $settingsPath -Force | Out-Null
    if ($Missing) {
        Remove-ItemProperty -LiteralPath $settingsPath -Name $valueName -ErrorAction SilentlyContinue
    } else {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(
            'Software\VDO.Ninja\Game Capture\network')
        try {
            $key.SetValue($valueName, $Value, [Microsoft.Win32.RegistryValueKind]::String)
        } finally {
            $key.Dispose()
        }
    }
}

function Invoke-Case(
    [string]$Name,
    [AllowNull()][string]$StoredValue,
    [string]$ExpectedSource,
    [string]$ExpectedActive,
    [switch]$Missing
) {
    Set-IceSetting -Value $StoredValue -Missing:$Missing
    $beforeLength = if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        (Get-Item -LiteralPath $logPath).Length
    } else { 0L }
    $process = Start-Process -FilePath $publisher -PassThru
    $matchedLine = ''
    try {
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 200
            if (Test-Path -LiteralPath $logPath -PathType Leaf) {
                $stream = [System.IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
                try {
                    # The packaged logger truncates its current file at startup.
                    # Read from zero when that happened; otherwise read only the
                    # bytes appended after this case began.
                    $stream.Position = if ($stream.Length -lt $beforeLength) { 0L } else { $beforeLength }
                    $reader = New-Object System.IO.StreamReader($stream)
                    $newText = $reader.ReadToEnd()
                    $matchedLine = @($newText -split "`r?`n" | Where-Object {
                        $_ -match '\[UI\] ICE setting loaded source=(\S+) active=(\S+)'
                    } | Select-Object -Last 1)
                } finally {
                    $stream.Dispose()
                }
            }
            if ($matchedLine) { break }
            if ($process.HasExited) { break }
        }
    } finally {
        if (-not $process.HasExited) {
            [void]$process.CloseMainWindow()
            if (-not $process.WaitForExit(3000)) {
                Stop-Process -Id $process.Id -Force
                $process.WaitForExit()
            }
        }
    }

    if (-not $matchedLine) {
        throw "Case '$Name' did not produce the packaged UI ICE settings diagnostic."
    }
    $match = [regex]::Match($matchedLine, '\[UI\] ICE setting loaded source=(\S+) active=(\S+)')
    if (-not $match.Success -or
        $match.Groups[1].Value -cne $ExpectedSource -or
        $match.Groups[2].Value -cne $ExpectedActive) {
        throw "Case '$Name' expected source=$ExpectedSource active=$ExpectedActive, got: $matchedLine"
    }
    return [pscustomobject]@{
        name = $Name
        source = $match.Groups[1].Value
        active = $match.Groups[2].Value
        line = $matchedLine
    }
}

$results = @()
try {
    $results += Invoke-Case 'missing-defaults-auto' '' 'missing' 'all' -Missing
    $results += Invoke-Case 'invalid-defaults-auto' 'invalid-release-probe' 'invalid' 'all'
    $results += Invoke-Case 'valid-relay-is-preserved' 'relay' 'relay' 'relay'
} finally {
    if ($originalValueExists) {
        New-Item -Path $settingsPath -Force | Out-Null
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(
            'Software\VDO.Ninja\Game Capture\network')
        try {
            $key.SetValue($valueName, $originalValue, $originalKind)
        } finally {
            $key.Dispose()
        }
    } else {
        Remove-ItemProperty -LiteralPath $settingsPath -Name $valueName -ErrorAction SilentlyContinue
        if (-not $originalKeyExists -and (Test-Path -LiteralPath $settingsPath)) {
            $remaining = @(Get-ItemProperty -LiteralPath $settingsPath | Get-Member -MemberType NoteProperty |
                Where-Object { $_.Name -notmatch '^PS' })
            if ($remaining.Count -eq 0) {
                Remove-Item -LiteralPath $settingsPath -Force
            }
        }
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportPath = Join-Path $ReportDir "ice-settings-packaged-$stamp.json"
[pscustomobject]@{
    ok = $true
    publisher = $publisher
    cases = $results
    settingsRestored = $true
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Host "[ICE-SETTINGS] PASS: $reportPath"
