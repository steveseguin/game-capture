param(
    [Parameter(Mandatory = $true)][string]$PublisherPath,
    [string]$ReportDir = ""
)
$ErrorActionPreference = 'Stop'
$env:GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING = '1'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SourceSelectionWindows {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public delegate bool Callback(IntPtr hwnd, IntPtr context);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr context);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr hwnd, string text);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
}
'@
[void][SourceSelectionWindows]::SetProcessDPIAware()
$publisher = (Resolve-Path -LiteralPath $PublisherPath).Path
if (-not (Test-Path (Join-Path (Split-Path $publisher) 'platforms/qwindows.dll'))) {
    throw 'A complete packaged application is required.'
}
if (-not $ReportDir) { $ReportDir = Join-Path $PSScriptRoot 'reports/source-selection' }
$runDir = Join-Path ([IO.Path]::GetFullPath($ReportDir)) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$discovery = Join-Path $runDir 'control.json'
$results = [Collections.Generic.List[object]]::new()
$completed = $false
$failureMessage = $null
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
    $button = $null
    # Accessible names describe the current action/state; visible button text
    # is no longer its UI Automation name in the accessible desktop UI.
    foreach ($name in @('Go live', 'Go live unavailable', 'GO LIVE')) {
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $name)
        $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        if ($button) { break }
    }
    if (-not $button) { throw 'Go Live button not found.' }
    return $button.Current.IsEnabled
}
function Save-SourceScreenshot([string]$Name) {
    # Qt does not expose these custom row labels through UI Automation.
    # Retain the displayed text for visual review in addition to selection checks.
    $rect = $root.Current.BoundingRectangle
    $bitmap = New-Object System.Drawing.Bitmap([int]$rect.Width, [int]$rect.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen([int]$rect.X, [int]$rect.Y, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $runDir $Name))
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
try {
    # Keep fixture message loops in separate processes so synchronous Windows
    # thumbnail requests cannot block on this automation thread.
    $fixture = (Resolve-Path (Join-Path $PSScriptRoot '../qa/e2e-capture-source.ps1')).Path
    foreach ($number in @(1, 2)) {
        $fixtureTitle = if ($number -eq 1) { 'Source Selection <b>Fixture 1</b> &amp;' } else { 'Source Selection Fixture 2' }
        $sourceProcesses.Add((Start-Process powershell -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $fixture + '"'),
            '-Title', ('"' + $fixtureTitle + '"'), '-Width', '640', '-Height', '360'
        ) -WindowStyle Hidden -PassThru))
    }
    Start-Sleep -Seconds 2
    # PowerShell's hidden startup flag can also hide its first fixture form.
    [void][SourceSelectionWindows]::EnumWindows({
        param($handle, $context)
        $owner = 0
        [void][SourceSelectionWindows]::GetWindowThreadProcessId($handle, [ref]$owner)
        if (@($sourceProcesses | Where-Object { $_.Id -eq $owner }).Count) {
            $title = [Text.StringBuilder]::new(256)
            [void][SourceSelectionWindows]::GetWindowText($handle, $title, 256)
            if ($title.ToString().StartsWith('Source Selection ')) {
                [void][SourceSelectionWindows]::ShowWindow($handle, 5)
                if ($owner -eq $sourceProcesses[0].Id) { $script:titleFixtureHandle = $handle }
            }
        }
        return $true
    }, [IntPtr]::Zero)
    $process = Start-Process -FilePath $publisher -ArgumentList @(
        '--local-control', ('--local-control-discovery="' + $discovery + '"')
    ) -WindowStyle Hidden -PassThru
    $script:mainHandle = [IntPtr]::Zero
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline -and $script:mainHandle -eq [IntPtr]::Zero) {
        [void][SourceSelectionWindows]::EnumWindows({
            param($handle, $context)
            $owner = 0
            [void][SourceSelectionWindows]::GetWindowThreadProcessId($handle, [ref]$owner)
            if ($owner -eq $process.Id) {
                $title = [Text.StringBuilder]::new(256)
                [void][SourceSelectionWindows]::GetWindowText($handle, $title, 256)
                if ($title.ToString() -eq 'Game Capture - Powered by VDO.Ninja') { $script:mainHandle = $handle }
            }
            return $true
        }, [IntPtr]::Zero)
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 100
    }
    if ($script:mainHandle -eq [IntPtr]::Zero) { throw 'Main window not found.' }
    [void][SourceSelectionWindows]::ShowWindow($script:mainHandle, 9)
    [void][SourceSelectionWindows]::SetForegroundWindow($script:mainHandle)
    Start-Sleep -Seconds 1
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($script:mainHandle)
    $list = Find-Control 'QListWidget'
    if (-not $list) { throw 'Source list not found.' }
    $control = Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json
    $literalTitle = 'Source Selection <b>Fixture 1</b> &amp;'
    $sources = Invoke-RestMethod ($control.base_url + '/sources/windows') -TimeoutSec 3 `
        -Headers @{ Authorization = ('Bearer ' + $control.token) }
    Record 'source-api-preserves-literal-title' (@($sources.sources | Where-Object { $_.name -ceq $literalTitle }).Count -eq 1)
    Save-SourceScreenshot 'source-list.png'
    Record 'initially-no-source' (-not (Go-Enabled))
    $itemCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
    $items = $list.FindAll([System.Windows.Automation.TreeScope]::Children, $itemCondition)
    if ($items.Count -lt 2) { throw 'At least two window sources are needed.' }
    $first = [System.Windows.Automation.SelectionItemPattern]$items[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $first.Select()
    Record 'accessible-selection-selects-row' $first.Current.IsSelected
    Record 'accessible-selection-enables-go-live' (Go-Enabled)
    $second = [System.Windows.Automation.SelectionItemPattern]$items[1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $second.Select()
    Record 'second-source-selected' ($second.Current.IsSelected -and -not $first.Current.IsSelected)
    Record 'second-source-enables-go-live' (Go-Enabled)
    $updatedTitle = 'Source Selection <i>Renamed</i> &amp;'
    if (-not [SourceSelectionWindows]::SetWindowText($script:titleFixtureHandle, $updatedTitle)) {
        throw 'Could not rename the fixture window.'
    }
    Start-Sleep -Milliseconds 3200
    Record 'automatic-refresh-preserves-selection' ($second.Current.IsSelected -and (Go-Enabled))
    Save-SourceScreenshot 'source-list-renamed.png'
    $completed = $true
} catch {
    $failureMessage = $_.Exception.Message
    throw
} finally {
    if ($process -and -not $process.HasExited) {
        if (-not $control -and (Test-Path -LiteralPath $discovery)) {
            $control = Get-Content -Raw -LiteralPath $discovery | ConvertFrom-Json
        }
        if ($control) {
            Invoke-RestMethod ($control.base_url + '/commands') -Method Post -TimeoutSec 3 `
                -Headers @{ Authorization = ('Bearer ' + $control.token) } `
                -ContentType application/json -Body '{"command":"quit"}' | Out-Null
        }
        if (-not $process.WaitForExit(5000)) { Stop-Process -Id $process.Id -Force }
    }
    foreach ($sourceProcess in $sourceProcesses) {
        if (-not $sourceProcess.HasExited) { Stop-Process -Id $sourceProcess.Id -Force }
    }
    [pscustomobject]@{
        ok = ($completed -and @($results | Where-Object { -not $_.passed }).Count -eq 0)
        completed = $completed
        error = $failureMessage
        publisher = $publisher
        sha256 = (Get-FileHash -LiteralPath $publisher).Hash
        results = @($results.ToArray())
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDir 'results.json')
    Write-Host "Results: $runDir"
}
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
