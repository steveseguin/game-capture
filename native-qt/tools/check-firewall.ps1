param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath
)
$ErrorActionPreference = 'Stop'
try {
    $exe = [IO.Path]::GetFullPath($ExecutablePath)
    $named = @(Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop | Where-Object DisplayName -eq 'Game Capture WebRTC UDP')
    $rules = @($named | ForEach-Object {
        $rule = $_
        $application = $rule | Get-NetFirewallApplicationFilter
        $port = $rule | Get-NetFirewallPortFilter
        $program = [Environment]::ExpandEnvironmentVariables($application.Program)
        [pscustomobject]@{
            name = $rule.Name
            enabled = [string]$rule.Enabled
            direction = [string]$rule.Direction
            action = [string]$rule.Action
            profiles = [string]$rule.Profile
            program = $program
            program_matches = $program -ieq $exe
            protocol = [string]$port.Protocol
        }
    })
    $matching = @($rules | Where-Object {
        $_.program_matches -and $_.enabled -eq 'True' -and $_.direction -eq 'Inbound' -and
        $_.action -eq 'Allow' -and $_.protocol -in @('UDP', '17')
    })
    [ordered]@{
        ok = $true
        executable = $exe
        executable_exists = Test-Path -LiteralPath $exe -PathType Leaf
        matching_installer_rule = $matching.Count -gt 0
        rules = $rules
        note = 'Read-only check of the installer rule in ActiveStore. Other rules, network profiles, or policy can still affect connectivity. Portable copies do not add a firewall rule.'
    } | ConvertTo-Json -Depth 5 -Compress
} catch {
    [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
