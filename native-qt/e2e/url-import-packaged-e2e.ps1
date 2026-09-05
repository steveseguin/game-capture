param(
    [Parameter(Mandatory = $true)][string]$PublisherPath,
    [Parameter(Mandatory = $true)][string]$SenderPath,
    [string]$ReportDir = ""
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UrlImportWindows {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public delegate bool Callback(IntPtr hwnd, IntPtr context);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr context);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
'@
[void][UrlImportWindows]::SetProcessDPIAware()
$publisher = (Resolve-Path -LiteralPath $PublisherPath).Path
if (-not (Test-Path (Join-Path (Split-Path $publisher) 'platforms/qwindows.dll'))) {
    throw 'A complete packaged application is required.'
}
if (-not $ReportDir) { $ReportDir = Join-Path $PSScriptRoot 'reports/url-import' }
$runDir = Join-Path ([IO.Path]::GetFullPath($ReportDir)) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$discovery = Join-Path $runDir 'control.json'
$results = [Collections.Generic.List[object]]::new()
$process = $null
$control = $null
$sourceProcesses = [Collections.Generic.List[object]]::new()
function Find-Control([string]$ClassName) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty, $ClassName)
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Record([string]$Name, [bool]$Passed) {
    $results.Add([pscustomobject]@{ name = $Name; passed = $Passed })
    Write-Host "$Name : $Passed"
}
function Go-Enabled {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'GO LIVE')
    $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if (-not $button) { throw 'Go Live button not found.' }
    return $button.Current.IsEnabled
}
$settings = [Collections.Generic.List[object]]::new()
$streamId = 'urlreview' + [guid]::NewGuid().ToString('N')
$senderName = 'UrlImport' + [guid]::NewGuid().ToString('N')
$expectedPassword = 'a&b+c%20 d'
$target = 'https://vdo.ninja/?push=' + $streamId + '&password=a%26b%2Bc%2520+d'
function Set-ReviewSetting([string]$Group, [string]$Name, $Value) {
    $keyPath = 'Software\VDO.Ninja\Game Capture\' + $Group
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
    try {
        $exists = $key.GetValueNames() -contains $Name
        $settings.Add(@{ path=$keyPath; name=$Name; exists=$exists;
            value=$key.GetValue($Name); kind= $(if ($exists) { $key.GetValueKind($Name) } else { 'String' }) })
        $key.SetValue($Name, $Value)
    } finally { $key.Dispose() }
}
try {
    Set-ReviewSetting video sourceMode spout
    Set-ReviewSetting video codec h264
    Set-ReviewSetting video encoderMode auto
    Set-ReviewSetting video alphaWorkflow 'false'
    Set-ReviewSetting audio source none
    Set-ReviewSetting audio includeMicrophone 'false'
    Set-ReviewSetting stream target $target
    Set-ReviewSetting stream room ''
    Set-ReviewSetting stream password ''
    $sourceProcesses.Add((Start-Process -FilePath (Resolve-Path -LiteralPath $SenderPath).Path -ArgumentList @(
        ('--name=' + $senderName), '--duration-ms=90000'
    ) -WindowStyle Hidden -PassThru))
    Start-Sleep -Seconds 2
    $process = Start-Process -FilePath $publisher -ArgumentList @(
        '--local-control', ('--local-control-discovery="' + $discovery + '"')
    ) -WindowStyle Hidden -PassThru
    $script:mainHandle = [IntPtr]::Zero
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline -and $script:mainHandle -eq [IntPtr]::Zero) {
        [void][UrlImportWindows]::EnumWindows({
            param($handle, $context)
            $owner = 0
            [void][UrlImportWindows]::GetWindowThreadProcessId($handle, [ref]$owner)
            if ($owner -eq $process.Id) {
                $title = [Text.StringBuilder]::new(256)
                [void][UrlImportWindows]::GetWindowText($handle, $title, 256)
                if ($title.ToString() -eq 'Game Capture - Powered by VDO.Ninja') { $script:mainHandle = $handle }
            }
            return $true
        }, [IntPtr]::Zero)
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 100
    }
    if ($script:mainHandle -eq [IntPtr]::Zero) { throw 'Main window not found.' }
    [void][UrlImportWindows]::ShowWindow($script:mainHandle, 9)
    [void][UrlImportWindows]::SetForegroundWindow($script:mainHandle)
    Start-Sleep -Seconds 1
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($script:mainHandle)
    $list = Find-Control 'QListWidget'
    if (-not $list) { throw 'Source list not found.' }
    $control = Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json
    $headers = @{ Authorization = ('Bearer ' + $control.token) }
    $sources = (Invoke-RestMethod ($control.base_url + '/sources/spout') -Headers $headers -TimeoutSec 5).sources
    $sourceIndex = -1
    for ($index=0; $index -lt $sources.Count; $index++) {
        if ($sources[$index].name -eq $senderName) { $sourceIndex = $index; break }
    }
    if ($sourceIndex -lt 0) { throw 'Synthetic Spout sender not found.' }
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
    $items = $list.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($items.Count -ne $sources.Count) { throw 'Source enumeration changed; refusing to choose a different source.' }
    ([System.Windows.Automation.SelectionItemPattern]$items[$sourceIndex].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select()
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $preview = @($all | Where-Object { $_.Current.AutomationId.EndsWith('.selectedPreview') })[0]
    if (-not $preview.Current.Name.Contains($senderName)) { throw 'Selected preview does not identify the synthetic sender.' }
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'GO LIVE')
    $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
    ([System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $diagnostics = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
        $diagnostics = Invoke-RestMethod ($control.base_url + '/diagnostics') -Headers $headers -TimeoutSec 5
        if ($diagnostics.app.live -and $diagnostics.source.has_frame) { break }
    }
    $streamSettings = Get-ItemProperty 'HKCU:\Software\VDO.Ninja\Game Capture\stream'
    Record 'url-import-resolves-stream-id' ($streamSettings.target -ceq $streamId)
    Record 'url-import-decodes-password-once' ($streamSettings.password -ceq $expectedPassword)
    Record 'synthetic-source-goes-live' ($diagnostics.app.live -and $diagnostics.source.has_frame -and $diagnostics.source.source_id -eq $sources[$sourceIndex].id)
    Start-Sleep -Milliseconds 300
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $share = @($all | Where-Object { $_.Current.Name.StartsWith('https://vdo.ninja/?view=' + $streamId) } | Select-Object -First 1)
    $matchesPassword = $false
    if ($share.Count) {
        $uri = [Uri]$share[0].Current.Name
        foreach ($part in $uri.Query.TrimStart('?').Split('&')) {
            if ($part.StartsWith('password=')) { $matchesPassword = [Uri]::UnescapeDataString($part.Substring(9)) -ceq $expectedPassword }
        }
    }
    Record 'generated-view-link-preserves-password' $matchesPassword
    Invoke-RestMethod ($control.base_url + '/commands') -Headers $headers -Method Post -ContentType application/json -Body '{"command":"stop"}' -TimeoutSec 5 | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $diagnostics = Invoke-RestMethod ($control.base_url + '/diagnostics') -Headers $headers -TimeoutSec 5
    } while (($diagnostics.app.live -or $diagnostics.app.capturing) -and [DateTime]::UtcNow -lt $deadline)
    Record 'stop-ends-capture-and-publishing' (-not $diagnostics.app.live -and -not $diagnostics.app.capturing)
} finally {
    try {
        if ($process -and -not $process.HasExited) {
            if (-not $control -and (Test-Path -LiteralPath $discovery)) { $control = Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json }
            try {
                if ($control) {
                    Invoke-RestMethod ($control.base_url + '/commands') -Method Post -TimeoutSec 3 -Headers @{ Authorization = ('Bearer ' + $control.token) } -ContentType application/json -Body '{"command":"quit"}' | Out-Null
                }
            } finally { if (-not $process.WaitForExit(5000)) { Stop-Process -Id $process.Id -Force } }
        }
    } finally {
        foreach ($sourceProcess in $sourceProcesses) { if (-not $sourceProcess.HasExited) { Stop-Process -Id $sourceProcess.Id -Force } }
        foreach ($setting in $settings) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($setting.path)
            try {
                if ($setting.exists) { $key.SetValue($setting.name, $setting.value, $setting.kind) }
                else { $key.DeleteValue($setting.name, $false) }
            } finally { $key.Dispose() }
        }
        [pscustomobject]@{ publisher=$publisher; sha256=(Get-FileHash -LiteralPath $publisher).Hash; results=@($results.ToArray()) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDir 'results.json')
        Write-Host "Results: $runDir"
    }
}
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
