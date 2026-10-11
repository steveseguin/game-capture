param([Parameter(Mandatory=$true)][string]$PluginRepo)
$ErrorActionPreference='Stop'
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cacheRoot=[IO.Path]::GetFullPath((Join-Path $repoRoot 'native-qt/.cache')).TrimEnd('\')+'\'
$preparedRepo=(Resolve-Path -LiteralPath $PluginRepo).Path
if(!$preparedRepo.StartsWith($cacheRoot,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use an isolated prepared plugin checkout under native-qt/.cache; the adjacent working repository is not modified.'
}
$gitRoot=& git -C $preparedRepo rev-parse --show-toplevel
if($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath([string]$gitRoot) -ne $preparedRepo) {
    throw 'PluginRepo must be the root of its own isolated Git checkout.'
}
$checker=Join-Path $preparedRepo 'scripts/obs-websocket-vdoninja-source-check.cjs'
$original='36f533d820967a2ea97f938e5254419beabbbf13851badbc82206f995551cde3'
$calibrated='3e4344cd5c4565c9d1f25e9cbd8a1a4afc2ef51d42d647bf057ed8369e0651e0'
$hash=(Get-FileHash -LiteralPath $checker -Algorithm SHA256).Hash.ToLowerInvariant()
if($hash -ne $calibrated) {
    if($hash -ne $original){throw 'Unknown OBS checker revision; review it before applying the calibration.'}
    $patch=Join-Path $PSScriptRoot 'obs-alpha-quantization.patch'
    & git -C $preparedRepo apply --check $patch
    if($LASTEXITCODE -ne 0){throw 'OBS checker patch validation failed'}
    & git -C $preparedRepo apply $patch
    if($LASTEXITCODE -ne 0){throw 'OBS checker patch failed'}
    if((Get-FileHash -LiteralPath $checker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $calibrated){throw 'Calibrated checker hash mismatch'}
}
& node (Join-Path $PSScriptRoot 'obs-alpha-quantization-gate.cjs') $preparedRepo
if($LASTEXITCODE -ne 0){throw 'Quantization boundary gate failed'}
& node (Join-Path $repoRoot 'native-qt/e2e/alpha-composite-analyzer-regression.js') "--plugin-repo=$preparedRepo"
if($LASTEXITCODE -ne 0){throw 'Existing alpha analyzer gates failed'}
Write-Output "Prepared OBS checker SHA-256: $calibrated"
