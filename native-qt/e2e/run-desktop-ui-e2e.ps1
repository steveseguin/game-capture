param(
    [Parameter(Mandatory = $true)][string]$PublisherPath,
    [Parameter(Mandatory = $true)][string]$ProbeHelperPath,
    [string]$ReportDir = ""
)
$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path $PSScriptRoot -Parent
$venv = Join-Path $nativeRoot '.cache/desktop-ui-python'
$python = Join-Path $venv 'Scripts/python.exe'
$requirements = Join-Path $PSScriptRoot 'desktop-ui-requirements.txt'
$stamp = Join-Path $venv 'requirements.sha256'
if (-not (Test-Path -LiteralPath $python)) {
    & python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create desktop UI Python environment.' }
}
$hash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash
if (-not (Test-Path -LiteralPath $stamp) -or (Get-Content -Raw -LiteralPath $stamp).Trim() -ne $hash) {
    & $python -m pip install --disable-pip-version-check -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'Could not install desktop UI observer dependencies.' }
    Set-Content -LiteralPath $stamp -Value $hash
}
if (-not $ReportDir) { $ReportDir = Join-Path $PSScriptRoot 'reports/desktop-ui' }
& $python (Join-Path $PSScriptRoot 'desktop-ui-e2e.py') `
    --publisher $PublisherPath --probe-helper $ProbeHelperPath --report-dir $ReportDir
if ($LASTEXITCODE -ne 0) { throw "Packaged desktop UI workflow failed. See $ReportDir" }
