param(
    [string]$ReadinessPath = (Join-Path $PSScriptRoot '..\qa\run-release-readiness.ps1'),
    [ValidateRange(1, 120)]
    [int]$TimeoutSeconds = 20,
    [switch]$NegativeControl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Probe {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Get-TextSha256 {
    param([string]$Text)

    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $utf8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Get-LiteralParameterValues {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string]$ParameterName
    )

    $values = @()
    for ($index = 0; $index -lt $Command.CommandElements.Count; $index++) {
        $element = $Command.CommandElements[$index]
        if ($element -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $element.ParameterName -cne $ParameterName) {
            continue
        }

        Assert-Probe (($index + 1) -lt $Command.CommandElements.Count) "-$ParameterName must have a value."
        $valueElement = $Command.CommandElements[$index + 1]
        Assert-Probe ($valueElement -is [System.Management.Automation.Language.StringConstantExpressionAst]) "-$ParameterName must have a literal value."
        $values += $valueElement.Value
    }
    return @($values)
}

function Get-EngineConstantBinding {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Name
    )

    $expectedResolver = '($ExecutionContext.SessionState.InvokeCommand.GetCommand(''New-Variable'',[System.Management.Automation.CommandTypes]::Cmdlet))'
    $matches = @()
    $commands = @($Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst]
    }, $true))

    foreach ($command in $commands) {
        if ($command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand -or
            $command.CommandElements.Count -lt 9) {
            continue
        }

        $nameValues = @(Get-LiteralParameterValues $command 'Name')
        if ($nameValues.Count -ne 1 -or $nameValues[0] -cne $Name) {
            continue
        }

        $resolver = $command.CommandElements[0].Extent.Text -replace '\s', ''
        Assert-Probe ($resolver -ceq $expectedResolver) "$Name must resolve engine-owned New-Variable as a Cmdlet."

        $scopeValues = @(Get-LiteralParameterValues $command 'Scope')
        $optionValues = @(Get-LiteralParameterValues $command 'Option')
        $valueParameters = @($command.CommandElements | Where-Object {
            $_ -is [System.Management.Automation.Language.CommandParameterAst] -and
            $_.ParameterName -ceq 'Value'
        })
        Assert-Probe ($scopeValues.Count -eq 1 -and $scopeValues[0] -ceq 'Script') "$Name must use exactly one literal -Scope Script."
        Assert-Probe ($optionValues.Count -eq 1 -and $optionValues[0] -ceq 'Constant') "$Name must use exactly one literal -Option Constant."
        Assert-Probe ($valueParameters.Count -eq 1) "$Name must use exactly one -Value parameter."
        Assert-Probe (
            $command.Parent -is [System.Management.Automation.Language.PipelineAst] -and
            $command.Parent.Parent -is [System.Management.Automation.Language.NamedBlockAst] -and
            [object]::ReferenceEquals($command.Parent.Parent.Parent, $Ast)
        ) "$Name binding must be a top-level production statement."
        $matches += $command
    }

    Assert-Probe ($matches.Count -eq 1) "Expected exactly one top-level engine-owned Constant binding for $Name; found $($matches.Count)."
    return $matches[0].Extent.Text
}

function Get-AssignmentName {
    param([System.Management.Automation.Language.StatementAst]$Statement)

    if ($Statement -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
        $Statement.Left -isnot [System.Management.Automation.Language.VariableExpressionAst]) {
        return ''
    }
    return $Statement.Left.VariablePath.UserPath
}

function Get-SignalReleaseFragment {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Source
    )

    $statements = @($Ast.EndBlock.Statements)
    $startStatements = @($statements | Where-Object {
        $_ -is [System.Management.Automation.Language.PipelineAst] -and
        $_.Extent.Text -ceq 'Write-Section "Local candidate send-outcome contract"'
    })
    Assert-Probe ($startStatements.Count -eq 1) "Expected exactly one signal-chain start section; found $($startStatements.Count)."

    $endStatements = @($statements | Where-Object {
        (Get-AssignmentName $_) -ceq 'allPass' -and
        $_.Extent.Text -match '\$controlCenterInstalledFirefoxPass\s*$'
    })
    Assert-Probe ($endStatements.Count -eq 1) "Expected exactly one installed-Firefox Control Center result fold; found $($endStatements.Count)."

    $startIndex = [array]::IndexOf($statements, $startStatements[0])
    $endIndex = [array]::IndexOf($statements, $endStatements[0])
    Assert-Probe ($startIndex -ge 0 -and $endIndex -gt $startIndex) 'The signal release chain is missing or out of order.'

    $expectedAssignments = @(
        @{ Offset = 1; Name = 'candidateOutcomeGateArgs' },
        @{ Offset = 5; Name = 'signalingSpoutGateArgs' },
        @{ Offset = 9; Name = 'directorIdentityGateArgs' },
        @{ Offset = 13; Name = 'signalFixtureGateArgs' },
        @{ Offset = 17; Name = 'installedFirefoxGateArgs' },
        @{ Offset = 20; Name = 'signalEdgeReportDir' },
        @{ Offset = 21; Name = 'signalEdgePass' },
        @{ Offset = 22; Name = 'allPass' },
        @{ Offset = 23; Name = 'signalFirefoxReportDir' },
        @{ Offset = 24; Name = 'signalFirefoxPass' },
        @{ Offset = 25; Name = 'allPass' },
        @{ Offset = 26; Name = 'signalInstalledFirefoxReportDir' },
        @{ Offset = 27; Name = 'signalInstalledFirefoxPass' },
        @{ Offset = 28; Name = 'allPass' },
        @{ Offset = 29; Name = 'controlCenterEdgeReportDir' },
        @{ Offset = 30; Name = 'controlCenterEdgePass' },
        @{ Offset = 31; Name = 'allPass' },
        @{ Offset = 32; Name = 'controlCenterFirefoxReportDir' },
        @{ Offset = 33; Name = 'controlCenterFirefoxPass' },
        @{ Offset = 34; Name = 'allPass' },
        @{ Offset = 35; Name = 'controlCenterInstalledFirefoxReportDir' },
        @{ Offset = 36; Name = 'controlCenterInstalledFirefoxPass' },
        @{ Offset = 37; Name = 'allPass' }
    )
    Assert-Probe (($endIndex - $startIndex) -eq 37) 'The exact signal release chain contains unexpected inserted, removed, or reordered top-level statements.'
    foreach ($expectation in $expectedAssignments) {
        $actualName = Get-AssignmentName $statements[$startIndex + [int]$expectation.Offset]
        Assert-Probe ($actualName -ceq [string]$expectation.Name) "Unexpected statement at signal-chain offset $($expectation.Offset); expected assignment to $($expectation.Name), found '$actualName'."
    }
    foreach ($gateOffset in @(1, 5, 9, 13, 17)) {
        Assert-Probe ($statements[$startIndex + $gateOffset + 1] -is [System.Management.Automation.Language.PipelineAst]) "Gate at signal-chain offset $gateOffset is not invoked immediately."
        Assert-Probe ($statements[$startIndex + $gateOffset + 2] -is [System.Management.Automation.Language.IfStatementAst]) "Gate at signal-chain offset $gateOffset has no immediate exit guard."
    }

    $startStatement = $statements[$startIndex]
    $endStatement = $statements[$endIndex]
    $startOffset = $startStatement.Extent.StartOffset
    $endOffset = $endStatement.Extent.EndOffset
    $fragment = $Source.Substring($startOffset, $endOffset - $startOffset)

    foreach ($requiredLiteral in @(
        'gate:local-candidate-send-outcomes',
        'gate:signaling-spout-artifact-bindings',
        'gate:director-packaged-identity',
        'gate:signaling-media-fixture',
        'gate:installed-firefox-bidi',
        'e2e:signaling-regressions:edge',
        'e2e:signaling-regressions:firefox',
        'e2e:signaling-regressions:firefox-installed',
        'e2e:control-center:edge',
        'e2e:control-center:firefox',
        'e2e:control-center:firefox-installed'
    )) {
        $literalPattern = '(?<![A-Za-z0-9_:-])' +
            [regex]::Escape($requiredLiteral) +
            '(?![A-Za-z0-9_:-])'
        $count = [regex]::Matches($fragment, $literalPattern).Count
        Assert-Probe ($count -eq 1) "The exact extracted fragment must contain $requiredLiteral once; found $count."
    }
    return $fragment
}

function Get-TopLevelFunctionText {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Source,
        [string]$Name
    )

    $matches = @($Ast.EndBlock.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $_.Name -ceq $Name
    })
    Assert-Probe ($matches.Count -eq 1) "Expected one top-level production function $Name; found $($matches.Count)."
    $match = $matches[0]
    return $Source.Substring(
        $match.Extent.StartOffset,
        $match.Extent.EndOffset - $match.Extent.StartOffset)
}

function Get-ArtifactValidationFragment {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Source
    )

    Assert-Probe ($Ast.EndBlock -ne $null) 'Release readiness has no executable root block.'
    $specifications = @(
        [pscustomobject]@{
            name = 'publisher file guard'
            pattern = '\[System\.IO\.File\]::Exists\(\$script:publisherExe\)'
        },
        [pscustomobject]@{
            name = 'artifact manifest file guard'
            pattern = '\[System\.IO\.File\]::Exists\(\$script:artifactManifestPathBinding\)'
        },
        [pscustomobject]@{
            name = 'artifact manifest hash guard'
            pattern = 'Get-FileHash.*\$script:artifactManifestPathBinding.*-cne\s*\$script:artifactManifestSha256Binding'
        }
    )
    $guards = @()
    foreach ($specification in $specifications) {
        $matches = @($Ast.EndBlock.Statements | Where-Object {
            $_ -is [System.Management.Automation.Language.IfStatementAst] -and
            $_.Clauses.Count -eq 1 -and
            -not $_.ElseClause -and
            $_.Clauses[0].Item1.Extent.Text -match $specification.pattern -and
            @($_.Clauses[0].Item2.Statements).Count -eq 1 -and
            $_.Clauses[0].Item2.Statements[0] -is
                [System.Management.Automation.Language.ThrowStatementAst]
        })
        Assert-Probe ($matches.Count -eq 1) "Expected one production $($specification.name); found $($matches.Count)."
        $guards += $matches[0]
    }
    $guards = @($guards | Sort-Object { $_.Extent.StartOffset })
    Assert-Probe ($guards[0].Extent.StartOffset -lt $guards[1].Extent.StartOffset -and
        $guards[1].Extent.StartOffset -lt $guards[2].Extent.StartOffset) 'Artifact validation guards are out of order.'
    return (@($guards | ForEach-Object {
        $Source.Substring($_.Extent.StartOffset, $_.Extent.EndOffset - $_.Extent.StartOffset)
    }) -join "`n")
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

function Invoke-ChildPowerShell {
    param(
        [string]$EnginePath,
        [string]$ScriptPath,
        [string]$FakeBin,
        [string]$LogPath,
        [string]$Nonce,
        [string]$FailAlias,
        [string]$SuppressReportAlias,
        [string]$ReportMode,
        [string]$ReportModeAlias,
        [int]$TimeoutMilliseconds
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $EnginePath
    $quotedScript = '"' + $ScriptPath.Replace('"', '\"') + '"'
    $startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedScript"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['PATH'] = $FakeBin + [System.IO.Path]::PathSeparator + [Environment]::GetEnvironmentVariable('PATH', 'Process')
    $startInfo.EnvironmentVariables['GC_RUNTIME_LOG'] = $LogPath
    $startInfo.EnvironmentVariables['GC_RUNTIME_NONCE'] = $Nonce
    $startInfo.EnvironmentVariables['GC_RUNTIME_FAIL_ALIAS'] = $FailAlias
    $startInfo.EnvironmentVariables['GC_RUNTIME_SUPPRESS_REPORT_ALIAS'] = $SuppressReportAlias
    $startInfo.EnvironmentVariables['GC_RUNTIME_REPORT_MODE'] = $ReportMode
    $startInfo.EnvironmentVariables['GC_RUNTIME_REPORT_MODE_ALIAS'] = $ReportModeAlias
    $startInfo.EnvironmentVariables['GC_RUNTIME_EXPECTED_NPM'] = (Join-Path $FakeBin 'npm.cmd')
    $startInfo.EnvironmentVariables['GC_RUNTIME_EXPECTED_REPO'] = Split-Path -Parent (Split-Path -Parent $ScriptPath)

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        Assert-Probe $process.Start() "Failed to start child PowerShell engine: $EnginePath"
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $completed = $process.WaitForExit($TimeoutMilliseconds)
        $timedOut = -not $completed
        if ($timedOut) {
            try {
                $process.Kill()
            } catch {
                # The process may have exited between the timeout and Kill().
            }
            $process.WaitForExit(5000) | Out-Null
        } else {
            $process.WaitForExit()
        }

        Assert-Probe $process.HasExited "Timed-out child process could not be terminated: $ScriptPath"
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StdOut = $stdoutTask.Result
            StdErr = $stderrTask.Result
            TimedOut = $timedOut
        }
    } finally {
        $process.Dispose()
    }
}

function Read-FakeNpmLog {
    param(
        [string]$Path,
        [string]$ExpectedNonce
    )

    if (-not [System.IO.File]::Exists($Path)) {
        return @()
    }

    $records = @()
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        try {
            $record = $line | ConvertFrom-Json -ErrorAction Stop
        } catch {
            throw "Malformed fake npm JSON log record: $line"
        }
        Assert-Probe ([string]$record.nonce -ceq $ExpectedNonce) "Fake npm log nonce mismatch: $line"
        Assert-Probe ($null -ne $record.args) "Fake npm log record has no argument vector: $line"
        $records += [pscustomobject]@{
            Args = @($record.args | ForEach-Object { [string]$_ })
        }
    }
    return @($records)
}

function Get-LoggedOption {
    param(
        [string[]]$ArgumentVector,
        [string]$Name
    )

    $matches = @()
    for ($index = 0; $index -lt $ArgumentVector.Count; $index++) {
        if ($ArgumentVector[$index] -ceq $Name) {
            Assert-Probe (($index + 1) -lt $ArgumentVector.Count) "$Name has no value in the fake npm argument vector."
            $matches += $ArgumentVector[$index + 1]
        } elseif ($ArgumentVector[$index].StartsWith($Name + '=', [System.StringComparison]::Ordinal)) {
            $matches += $ArgumentVector[$index].Substring($Name.Length + 1)
        }
    }
    Assert-Probe ($matches.Count -eq 1) "Expected exactly one $Name option; found $($matches.Count). args=$($ArgumentVector -join ' | ')"
    return [string]$matches[0]
}

function Test-LoggedOptionPresent {
    param(
        [string[]]$ArgumentVector,
        [string]$Name
    )

    return @($ArgumentVector | Where-Object {
        $_ -ceq $Name -or $_.StartsWith($Name + '=', [System.StringComparison]::Ordinal)
    }).Count -gt 0
}

function Assert-ChildSucceeded {
    param(
        [pscustomobject]$Result,
        [string]$Scenario
    )

    Assert-Probe (-not $Result.TimedOut) "$Scenario exceeded the hard timeout."
    Assert-Probe ($Result.ExitCode -eq 0) "$Scenario exited $($Result.ExitCode). stdout=[$($Result.StdOut)] stderr=[$($Result.StdErr)]"
}

$resolvedReadinessPath = $null
$temporaryRoot = $null
$failure = $null
try {
    $resolvedReadinessPath = (Resolve-Path -LiteralPath $ReadinessPath -ErrorAction Stop).Path
    Assert-Probe ([System.IO.File]::Exists($resolvedReadinessPath)) "Release readiness script does not exist: $resolvedReadinessPath"

    $source = [System.IO.File]::ReadAllText($resolvedReadinessPath)
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $source,
        $resolvedReadinessPath,
        [ref]$tokens,
        [ref]$parseErrors
    )
    Assert-Probe (@($parseErrors).Count -eq 0) "Release readiness script has parser errors: $(@($parseErrors).ForEach({ $_.Message }) -join '; ')"

    $runStepBinding = Get-EngineConstantBinding $ast 'runStepImplementation'
    $repoRootBinding = Get-EngineConstantBinding $ast 'repoRoot'
    $npmExecutableBinding = Get-EngineConstantBinding $ast 'npmExecutable'
    $publisherBinding = Get-EngineConstantBinding $ast 'publisherExe'
    $artifactManifestPathBinding = Get-EngineConstantBinding $ast 'artifactManifestPathBinding'
    $artifactManifestSha256Binding = Get-EngineConstantBinding $ast 'artifactManifestSha256Binding'
    $reportDirBinding = Get-EngineConstantBinding $ast 'reportDirBinding'
    $spoutSenderPathBinding = Get-EngineConstantBinding $ast 'spoutSenderPathBinding'
    $spoutSenderSha256Binding = Get-EngineConstantBinding $ast 'spoutSenderSha256Binding'
    $firefoxPathBinding = Get-EngineConstantBinding $ast 'firefoxPathBinding'
    $firefoxSha256Binding = Get-EngineConstantBinding $ast 'firefoxSha256Binding'
    $publisherSha256Binding = Get-EngineConstantBinding $ast 'publisherSha256Binding'
    $artifactValidationFragment = Get-ArtifactValidationFragment $ast $source
    $sameArtifactPathFunction = Get-TopLevelFunctionText $ast $source 'Test-SameArtifactPath'
    $newReportDirectoryFunction = Get-TopLevelFunctionText $ast $source 'New-BrowserWorkflowReportDirectory'
    $assertFreshReportFunction = Get-TopLevelFunctionText $ast $source 'Assert-FreshBrowserWorkflowReport'
    $productionFragment = Get-SignalReleaseFragment $ast $source

    $fragmentToExecute = $productionFragment
    if ($NegativeControl) {
        [System.Console]::WriteLine('NEGATIVE CONTROL: mutating only the extracted child-process fragment in memory.')
        $negativeAlias = 'gate:signaling-media-fixture-negative-control'
        $fragmentToExecute = $fragmentToExecute.Replace('gate:signaling-media-fixture', $negativeAlias)
        Assert-Probe ($fragmentToExecute -cne $productionFragment) 'Negative control failed to mutate the child fragment.'
    }

    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Assert-Probe ([System.IO.File]::Exists($windowsPowerShell)) "Mandatory Windows powershell.exe was not found: $windowsPowerShell"
    $engines = @([pscustomobject]@{ Name = 'powershell.exe'; Path = $windowsPowerShell })
    $pwshCommand = $ExecutionContext.SessionState.InvokeCommand.GetCommand(
        'pwsh.exe',
        [System.Management.Automation.CommandTypes]::Application
    )
    if ($null -ne $pwshCommand -and [System.IO.File]::Exists($pwshCommand.Source)) {
        $engines += [pscustomobject]@{ Name = 'pwsh.exe'; Path = $pwshCommand.Source }
    }

    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('gc-release-runtime-' + [guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
    $timeoutMilliseconds = $TimeoutSeconds * 1000

    $runnerTemplate = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

__RUN_STEP_BINDING__

__REPO_ROOT_BINDING__

__NPM_EXECUTABLE_BINDING__

function Assert-Child([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "CHILD ASSERTION FAILED: $Message" }
}

$expectedRepo = [System.IO.Path]::GetFullPath($env:GC_RUNTIME_EXPECTED_REPO)
$expectedNpm = [System.IO.Path]::GetFullPath($env:GC_RUNTIME_EXPECTED_NPM)
Assert-Child ([System.IO.Path]::GetFullPath($script:repoRoot) -ceq $expectedRepo) "repoRoot resolved to $script:repoRoot, expected $expectedRepo"
Assert-Child ([System.IO.Path]::GetFullPath($script:npmExecutable) -ceq $expectedNpm) "npmExecutable resolved to $script:npmExecutable, expected $expectedNpm"

foreach ($constantName in @('runStepImplementation', 'repoRoot', 'npmExecutable')) {
    $variable = Get-Variable -Name $constantName -Scope Script -ErrorAction Stop
    Assert-Child (($variable.Options -band [System.Management.Automation.ScopedItemOptions]::Constant) -ne 0) "$constantName is not an actual script Constant"
}

$repoBefore = $script:repoRoot
$repoRejected = $false
try { $script:repoRoot = 'runtime-probe-illegal-repo-reassignment' } catch { $repoRejected = $true }
Assert-Child $repoRejected 'repoRoot accepted reassignment'
Assert-Child ($script:repoRoot -ceq $repoBefore) 'repoRoot changed after rejected reassignment'

$npmBefore = $script:npmExecutable
$npmRejected = $false
try { $script:npmExecutable = 'runtime-probe-illegal-npm-reassignment' } catch { $npmRejected = $true }
Assert-Child $npmRejected 'npmExecutable accepted reassignment'
Assert-Child ($script:npmExecutable -ceq $npmBefore) 'npmExecutable changed after rejected reassignment'

$runnerBefore = $script:runStepImplementation
$runnerRejected = $false
try { $script:runStepImplementation = { return $false } } catch { $runnerRejected = $true }
Assert-Child $runnerRejected 'runStepImplementation accepted reassignment'
Assert-Child ([object]::ReferenceEquals($script:runStepImplementation, $runnerBefore)) 'runStepImplementation changed after rejected reassignment'

$script:successCount = 0
$successResult = & $script:runStepImplementation 'runtime success' {
    $script:successCount++
    $global:LASTEXITCODE = 0
}
Assert-Child ($script:successCount -eq 1) "success action ran $script:successCount times"
Assert-Child ($successResult -is [bool] -and $successResult -ceq $true) 'success result was not exact Boolean true'

$script:nativeCount = 0
$nativeResult = & $script:runStepImplementation 'runtime native nonzero' {
    $script:nativeCount++
    & $script:npmExecutable '--probe-native-nonzero'
}
Assert-Child ($script:nativeCount -eq 1) "native-nonzero action ran $script:nativeCount times"
Assert-Child ($nativeResult -is [bool] -and $nativeResult -ceq $false) 'native-nonzero result was not exact Boolean false'

$script:throwCount = 0
$throwResult = & $script:runStepImplementation 'runtime throw' {
    $script:throwCount++
    throw 'intentional runtime probe throw'
}
Assert-Child ($script:throwCount -eq 1) "throw action ran $script:throwCount times"
Assert-Child ($throwResult -is [bool] -and $throwResult -ceq $false) 'throw result was not exact Boolean false'

[System.Console]::WriteLine('RUNTIME_PROBE_CHILD_OK runner')
'@

    $fragmentTemplate = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

__RUN_STEP_BINDING__

__REPO_ROOT_BINDING__

__NPM_EXECUTABLE_BINDING__

function Assert-Fragment([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "CHILD ASSERTION FAILED: $Message" }
}

$PublisherPath = Join-Path $script:repoRoot 'fake-publisher.exe'
$ArtifactManifestPath = Join-Path $script:repoRoot 'release-artifact-manifest.json'
$ArtifactManifestSha256 = '__EXPECTED_MANIFEST_SHA256__'
$resolvedSpoutSenderPath = Join-Path $script:repoRoot 'fake-spout-sender.exe'
$resolvedSpoutSenderSha256 = '__EXPECTED_SPOUT_SHA256__'
$resolvedFirefoxPath = Join-Path $script:repoRoot 'fake-firefox.exe'
$resolvedFirefoxSha256 = '__EXPECTED_FIREFOX_SHA256__'
$resolvedPublisherSha256 = '__EXPECTED_PUBLISHER_SHA256__'
$timestamp = 'runtime-probe'
$reportDir = Join-Path $script:repoRoot 'reports'

__PUBLISHER_BINDING__

__ARTIFACT_MANIFEST_PATH_BINDING__

__ARTIFACT_MANIFEST_SHA256_BINDING__

__REPORT_DIR_BINDING__

__SPOUT_PATH_BINDING__

__SPOUT_SHA256_BINDING__

__FIREFOX_PATH_BINDING__

__FIREFOX_SHA256_BINDING__

__PUBLISHER_SHA256_BINDING__

__ARTIFACT_VALIDATION_GUARDS__

foreach ($constantName in @(
    'publisherExe',
    'artifactManifestPathBinding',
    'artifactManifestSha256Binding',
    'reportDirBinding',
    'spoutSenderPathBinding',
    'spoutSenderSha256Binding',
    'firefoxPathBinding',
    'firefoxSha256Binding',
    'publisherSha256Binding'
)) {
    $variable = Get-Variable -Name $constantName -Scope Script -ErrorAction Stop
    Assert-Fragment (($variable.Options -band [System.Management.Automation.ScopedItemOptions]::Constant) -ne 0) "$constantName is not an actual script Constant"
}

function Write-Section([string]$title) {
    [System.Console]::WriteLine("SECTION: {0}", $title)
}

__SAME_ARTIFACT_PATH_FUNCTION__

__NEW_REPORT_DIRECTORY_FUNCTION__

__ASSERT_FRESH_REPORT_FUNCTION__

$allPass = $true

__FIXTURE_BROWSER_FRAGMENT__

if (-not $allPass) {
    throw 'The production signaling browser fragment returned a failed browser step.'
}
[System.Console]::WriteLine('RUNTIME_PROBE_CHILD_OK fragment')
'@

    foreach ($engine in $engines) {
        [System.Console]::WriteLine("=== Runtime probe: $($engine.Name) ===")
        $engineRoot = Join-Path $temporaryRoot ($engine.Name -replace '[^A-Za-z0-9.-]', '_')
        $qaDirectory = Join-Path $engineRoot 'qa'
        $fakeBin = Join-Path $engineRoot 'fake-bin'
        [System.IO.Directory]::CreateDirectory($qaDirectory) | Out-Null
        [System.IO.Directory]::CreateDirectory($fakeBin) | Out-Null

        $fakePublisherPath = Join-Path $engineRoot 'fake-publisher.exe'
        $fakeSpoutPath = Join-Path $engineRoot 'fake-spout-sender.exe'
        $fakeFirefoxPath = Join-Path $engineRoot 'fake-firefox.exe'
        $fakeManifestPath = Join-Path $engineRoot 'release-artifact-manifest.json'
        $fakeManifestContent = '{"schema":"runtime-probe-artifact-manifest"}'
        Write-Utf8NoBom $fakePublisherPath 'runtime probe packaged publisher'
        Write-Utf8NoBom $fakeSpoutPath 'runtime probe Spout sender'
        Write-Utf8NoBom $fakeFirefoxPath 'runtime probe installed Firefox'
        Write-Utf8NoBom $fakeManifestPath $fakeManifestContent
        $expectedPublisherSha256 = (Microsoft.PowerShell.Utility\Get-FileHash `
            -LiteralPath $fakePublisherPath `
            -Algorithm SHA256 `
            -ErrorAction Stop).Hash.ToLowerInvariant()
        $expectedSpoutSha256 = (Microsoft.PowerShell.Utility\Get-FileHash `
            -LiteralPath $fakeSpoutPath `
            -Algorithm SHA256 `
            -ErrorAction Stop).Hash.ToLowerInvariant()
        $expectedFirefoxSha256 = (Microsoft.PowerShell.Utility\Get-FileHash `
            -LiteralPath $fakeFirefoxPath `
            -Algorithm SHA256 `
            -ErrorAction Stop).Hash.ToLowerInvariant()
        $expectedManifestSha256 = (Microsoft.PowerShell.Utility\Get-FileHash `
            -LiteralPath $fakeManifestPath `
            -Algorithm SHA256 `
            -ErrorAction Stop).Hash.ToLowerInvariant()

        $fakeNpmPath = Join-Path $fakeBin 'npm.cmd'
        $fakeNpm = @'
@echo off
node.exe "%~dp0fake-npm.js" %*
exit /b %ERRORLEVEL%
'@
        Write-Utf8NoBom $fakeNpmPath $fakeNpm
        $fakeNpmJsPath = Join-Path $fakeBin 'fake-npm.js'
        $fakeNpmJs = @'
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
fs.appendFileSync(
  process.env.GC_RUNTIME_LOG,
  `${JSON.stringify({ nonce: process.env.GC_RUNTIME_NONCE, args })}\n`,
  'utf8'
);

if (args[0] === '--probe-native-nonzero') {
  process.exit(23);
}

const alias = args[3] || '';
if (alias === (process.env.GC_RUNTIME_FAIL_ALIAS || '')) {
  process.exit(37);
}

const descriptors = new Map([
  ['e2e:signaling-regressions:edge', { kind: 'signaling', browser: 'edge' }],
  ['e2e:signaling-regressions:firefox', { kind: 'signaling', browser: 'firefox' }],
  ['e2e:signaling-regressions:firefox-installed', { kind: 'signaling', browser: 'firefox-installed' }],
  ['e2e:control-center:edge', { kind: 'director', browser: 'edge' }],
  ['e2e:control-center:firefox', { kind: 'director', browser: 'firefox' }],
  ['e2e:control-center:firefox-installed', { kind: 'director', browser: 'firefox-installed' }]
]);
const descriptor = descriptors.get(alias);
if (!descriptor || alias === (process.env.GC_RUNTIME_SUPPRESS_REPORT_ALIAS || '')) {
  process.exit(0);
}

function option(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      values.push(args[index + 1]);
    } else if (args[index].startsWith(`${name}=`)) {
      values.push(args[index].slice(name.length + 1));
    }
  }
  if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length === 0) {
    throw new Error(`Expected exactly one ${name}; got ${JSON.stringify(values)} from ${JSON.stringify(args)}`);
  }
  return values[0];
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const publisherPath = option('--publisher-path');
const manifestPath = option('--artifact-manifest-path');
const manifestSha256 = option('--artifact-manifest-sha256');
const spoutPath = option('--spout-sender-path');
const spoutSha256 = option('--expected-spout-sender-sha256');
const reportDir = option('--report-dir');
const mode = alias === (process.env.GC_RUNTIME_REPORT_MODE_ALIAS || '')
  ? (process.env.GC_RUNTIME_REPORT_MODE || '')
  : '';

const report = {
  ok: mode !== 'false-ok',
  browser: descriptor.browser,
  packagedArtifactManifest: {
    path: manifestPath,
    sha256: mode === 'bad-manifest' ? '0'.repeat(64) : manifestSha256
  },
  checks: [{ name: 'runtime-probe', ok: mode !== 'failed-check' }]
};

if (descriptor.kind === 'signaling') {
  report.packagedPublisher = publisherPath;
  report.packagedPublisherSha256 = mode === 'bad-publisher'
    ? '0'.repeat(64)
    : sha256(publisherPath);
  report.spoutSenderArtifact = {
    path: spoutPath,
    sha256: mode === 'bad-spout' ? '0'.repeat(64) : spoutSha256
  };
  report.harnessErrors = [];
} else {
  report.strictNegotiation = true;
  report.packagedArtifactIdentityRequired = true;
  report.publisherArtifact = {
    path: publisherPath,
    sha256: mode === 'bad-publisher' ? '0'.repeat(64) : sha256(publisherPath)
  };
  report.sourceFixtureArtifact = {
    path: spoutPath,
    sha256: mode === 'bad-spout' ? '0'.repeat(64) : spoutSha256,
    expectedSha256: spoutSha256
  };
}

if (descriptor.browser === 'firefox-installed') {
  report.browserArtifact = {
    path: option('--firefox-path'),
    sha256: mode === 'bad-firefox'
      ? '0'.repeat(64)
      : option('--expected-firefox-sha256')
  };
}

fs.mkdirSync(reportDir, { recursive: true });
const prefix = descriptor.kind === 'signaling'
  ? 'signaling-regressions'
  : 'director-room-e2e';
const reportPath = path.join(reportDir, `${prefix}-${Date.now()}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report), 'utf8');
if (mode === 'multiple') {
  fs.writeFileSync(path.join(reportDir, `${prefix}-${Date.now()}-extra.json`), JSON.stringify(report), 'utf8');
}
if (mode === 'stale') {
  const stale = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(reportPath, stale, stale);
}
'@
        Write-Utf8NoBom $fakeNpmJsPath $fakeNpmJs

        $runnerScript = $runnerTemplate.
            Replace('__RUN_STEP_BINDING__', $runStepBinding).
            Replace('__REPO_ROOT_BINDING__', $repoRootBinding).
            Replace('__NPM_EXECUTABLE_BINDING__', $npmExecutableBinding)
        $successScript = $fragmentTemplate.
            Replace('__RUN_STEP_BINDING__', $runStepBinding).
            Replace('__REPO_ROOT_BINDING__', $repoRootBinding).
            Replace('__NPM_EXECUTABLE_BINDING__', $npmExecutableBinding).
            Replace('__PUBLISHER_BINDING__', $publisherBinding).
            Replace('__ARTIFACT_MANIFEST_PATH_BINDING__', $artifactManifestPathBinding).
            Replace('__ARTIFACT_MANIFEST_SHA256_BINDING__', $artifactManifestSha256Binding).
            Replace('__REPORT_DIR_BINDING__', $reportDirBinding).
            Replace('__SPOUT_PATH_BINDING__', $spoutSenderPathBinding).
            Replace('__SPOUT_SHA256_BINDING__', $spoutSenderSha256Binding).
            Replace('__FIREFOX_PATH_BINDING__', $firefoxPathBinding).
            Replace('__FIREFOX_SHA256_BINDING__', $firefoxSha256Binding).
            Replace('__PUBLISHER_SHA256_BINDING__', $publisherSha256Binding).
            Replace('__ARTIFACT_VALIDATION_GUARDS__', $artifactValidationFragment).
            Replace('__SAME_ARTIFACT_PATH_FUNCTION__', $sameArtifactPathFunction).
            Replace('__NEW_REPORT_DIRECTORY_FUNCTION__', $newReportDirectoryFunction).
            Replace('__ASSERT_FRESH_REPORT_FUNCTION__', $assertFreshReportFunction).
            Replace('__EXPECTED_MANIFEST_SHA256__', $expectedManifestSha256).
            Replace('__EXPECTED_SPOUT_SHA256__', $expectedSpoutSha256).
            Replace('__EXPECTED_FIREFOX_SHA256__', $expectedFirefoxSha256).
            Replace('__EXPECTED_PUBLISHER_SHA256__', $expectedPublisherSha256).
            Replace('__FIXTURE_BROWSER_FRAGMENT__', $fragmentToExecute)
        $hashMismatchScript = $successScript.Replace(
            $expectedManifestSha256,
            ('0' * 64)
        )
        Assert-Probe ($hashMismatchScript -cne $successScript) 'Manifest-hash negative control did not mutate the child script.'

        $runnerPath = Join-Path $qaDirectory 'runner-probe.ps1'
        $successPath = Join-Path $qaDirectory 'fragment-success-probe.ps1'
        $failurePath = Join-Path $qaDirectory 'fragment-fixture-failure-probe.ps1'
        $missingManifestPath = Join-Path $qaDirectory 'fragment-missing-manifest-probe.ps1'
        $hashMismatchPath = Join-Path $qaDirectory 'fragment-hash-mismatch-probe.ps1'
        Write-Utf8NoBom $runnerPath $runnerScript
        Write-Utf8NoBom $successPath $successScript
        Write-Utf8NoBom $failurePath $successScript
        Write-Utf8NoBom $missingManifestPath $successScript
        Write-Utf8NoBom $hashMismatchPath $hashMismatchScript

        $runnerLog = Join-Path $engineRoot 'runner.log'
        $runnerNonce = [guid]::NewGuid().ToString('N')
        $runnerResult = Invoke-ChildPowerShell `
            -EnginePath $engine.Path `
            -ScriptPath $runnerPath `
            -FakeBin $fakeBin `
            -LogPath $runnerLog `
            -Nonce $runnerNonce `
            -FailAlias '' `
            -SuppressReportAlias '' `
            -ReportMode '' `
            -ReportModeAlias '' `
            -TimeoutMilliseconds $timeoutMilliseconds
        Assert-ChildSucceeded $runnerResult "$($engine.Name) runner semantics"
        $runnerRecords = @(Read-FakeNpmLog $runnerLog $runnerNonce)
        Assert-Probe ($runnerRecords.Count -eq 1) "$($engine.Name) runner must invoke the fake native application exactly once; found $($runnerRecords.Count)."
        Assert-Probe ($runnerRecords[0].Args.Count -eq 1 -and
            $runnerRecords[0].Args[0] -ceq '--probe-native-nonzero') "$($engine.Name) runner did not exercise the native-nonzero action."
        [System.Console]::WriteLine("PASS runner semantics/constants: $($engine.Name)")

        Remove-Item -LiteralPath $fakeManifestPath -Force -ErrorAction Stop
        $missingManifestLog = Join-Path $engineRoot 'fragment-missing-manifest.log'
        $missingManifestNonce = [guid]::NewGuid().ToString('N')
        $missingManifestResult = Invoke-ChildPowerShell `
            -EnginePath $engine.Path `
            -ScriptPath $missingManifestPath `
            -FakeBin $fakeBin `
            -LogPath $missingManifestLog `
            -Nonce $missingManifestNonce `
            -FailAlias '' `
            -SuppressReportAlias '' `
            -ReportMode '' `
            -ReportModeAlias '' `
            -TimeoutMilliseconds $timeoutMilliseconds
        Assert-Probe (-not $missingManifestResult.TimedOut -and
            $missingManifestResult.ExitCode -ne 0) "$($engine.Name) missing-manifest negative case did not fail."
        Assert-Probe ($missingManifestResult.StdErr -match 'Release artifact manifest does not exist') "$($engine.Name) missing-manifest case failed for the wrong reason: $($missingManifestResult.StdErr)"
        Assert-Probe (@(Read-FakeNpmLog $missingManifestLog $missingManifestNonce).Count -eq 0) "$($engine.Name) missing-manifest case reached npm."
        Write-Utf8NoBom $fakeManifestPath $fakeManifestContent
        [System.Console]::WriteLine("PASS missing manifest blocks before npm: $($engine.Name)")

        $hashMismatchLog = Join-Path $engineRoot 'fragment-hash-mismatch.log'
        $hashMismatchNonce = [guid]::NewGuid().ToString('N')
        $hashMismatchResult = Invoke-ChildPowerShell `
            -EnginePath $engine.Path `
            -ScriptPath $hashMismatchPath `
            -FakeBin $fakeBin `
            -LogPath $hashMismatchLog `
            -Nonce $hashMismatchNonce `
            -FailAlias '' `
            -SuppressReportAlias '' `
            -ReportMode '' `
            -ReportModeAlias '' `
            -TimeoutMilliseconds $timeoutMilliseconds
        Assert-Probe (-not $hashMismatchResult.TimedOut -and
            $hashMismatchResult.ExitCode -ne 0) "$($engine.Name) manifest-hash negative case did not fail."
        Assert-Probe ($hashMismatchResult.StdErr -match 'Release artifact manifest SHA-256 does not match') "$($engine.Name) manifest-hash case failed for the wrong reason: $($hashMismatchResult.StdErr)"
        Assert-Probe (@(Read-FakeNpmLog $hashMismatchLog $hashMismatchNonce).Count -eq 0) "$($engine.Name) manifest-hash case reached npm."
        [System.Console]::WriteLine("PASS manifest SHA mismatch blocks before npm: $($engine.Name)")

        $successLog = Join-Path $engineRoot 'fragment-success.log'
        $successNonce = [guid]::NewGuid().ToString('N')
        $successResult = Invoke-ChildPowerShell `
            -EnginePath $engine.Path `
            -ScriptPath $successPath `
            -FakeBin $fakeBin `
            -LogPath $successLog `
            -Nonce $successNonce `
            -FailAlias '' `
            -SuppressReportAlias '' `
            -ReportMode '' `
            -ReportModeAlias '' `
            -TimeoutMilliseconds $timeoutMilliseconds
        Assert-ChildSucceeded $successResult "$($engine.Name) complete signal release-chain success"
        $successRecords = @(Read-FakeNpmLog $successLog $successNonce)
        $expectedAliases = @(
            'gate:local-candidate-send-outcomes',
            'gate:signaling-spout-artifact-bindings',
            'gate:director-packaged-identity',
            'gate:signaling-media-fixture',
            'gate:installed-firefox-bidi',
            'e2e:signaling-regressions:edge',
            'e2e:signaling-regressions:firefox',
            'e2e:signaling-regressions:firefox-installed',
            'e2e:control-center:edge',
            'e2e:control-center:firefox',
            'e2e:control-center:firefox-installed'
        )
        Assert-Probe ($successRecords.Count -eq $expectedAliases.Count) "$($engine.Name) success path invoked $($successRecords.Count) fake npm commands; expected $($expectedAliases.Count)."
        $observedReportDirs = @()
        for ($recordIndex = 0; $recordIndex -lt $expectedAliases.Count; $recordIndex++) {
            $record = $successRecords[$recordIndex]
            $recordArgs = @($record.Args)
            Assert-Probe ($recordArgs.Count -ge 4) "$($engine.Name) command $recordIndex has an incomplete argument vector."
            Assert-Probe ($recordArgs[0] -ceq '--prefix') "$($engine.Name) success command $recordIndex did not use --prefix."
            Assert-Probe ([System.IO.Path]::GetFullPath($recordArgs[1]) -ceq [System.IO.Path]::GetFullPath($engineRoot)) "$($engine.Name) success command $recordIndex used the wrong repo root: $($recordArgs[1])"
            Assert-Probe ($recordArgs[2] -ceq 'run') "$($engine.Name) success command $recordIndex did not use npm run."
            Assert-Probe ($recordArgs[3] -ceq $expectedAliases[$recordIndex]) "$($engine.Name) command order mismatch at ${recordIndex}: expected $($expectedAliases[$recordIndex]), found $($recordArgs[3])."
            if ($recordIndex -lt 4) {
                Assert-Probe ($recordArgs.Count -eq 4) "$($engine.Name) contract gate $($recordArgs[3]) unexpectedly received arguments."
                continue
            }

            Assert-Probe ($recordArgs[4] -ceq '--') "$($engine.Name) command $recordIndex did not separate npm and script arguments."
            if ($recordIndex -eq 4) {
                Assert-Probe ((Get-LoggedOption $recordArgs '--firefox-path') -ceq $fakeFirefoxPath) "$($engine.Name) installed-Firefox gate used the wrong path."
                Assert-Probe ((Get-LoggedOption $recordArgs '--expected-firefox-sha256') -ceq $expectedFirefoxSha256) "$($engine.Name) installed-Firefox gate used the wrong hash."
                Assert-Probe (-not (Test-LoggedOptionPresent $recordArgs '--report-dir')) "$($engine.Name) installed-Firefox contract gate unexpectedly received a report directory."
                continue
            }

            Assert-Probe ((Get-LoggedOption $recordArgs '--publisher-path') -ceq $fakePublisherPath) "$($engine.Name) browser command $recordIndex forwarded the wrong publisher path."
            Assert-Probe ((Get-LoggedOption $recordArgs '--artifact-manifest-path') -ceq $fakeManifestPath) "$($engine.Name) browser command $recordIndex forwarded the wrong manifest path."
            Assert-Probe ((Get-LoggedOption $recordArgs '--artifact-manifest-sha256') -ceq $expectedManifestSha256) "$($engine.Name) browser command $recordIndex forwarded the wrong manifest hash."
            Assert-Probe ((Get-LoggedOption $recordArgs '--spout-sender-path') -ceq $fakeSpoutPath) "$($engine.Name) browser command $recordIndex forwarded the wrong Spout path."
            Assert-Probe ((Get-LoggedOption $recordArgs '--expected-spout-sender-sha256') -ceq $expectedSpoutSha256) "$($engine.Name) browser command $recordIndex forwarded the wrong Spout hash."
            $browserReportDir = Get-LoggedOption $recordArgs '--report-dir'
            Assert-Probe ([System.IO.Path]::GetFullPath($browserReportDir).StartsWith(
                ([System.IO.Path]::GetFullPath((Join-Path $engineRoot 'reports')) + [System.IO.Path]::DirectorySeparatorChar),
                [System.StringComparison]::OrdinalIgnoreCase)) "$($engine.Name) browser command $recordIndex used an out-of-scope report directory: $browserReportDir"
            $observedReportDirs += [System.IO.Path]::GetFullPath($browserReportDir)

            $installedBrowser = $recordIndex -in @(7, 10)
            if ($installedBrowser) {
                Assert-Probe ((Get-LoggedOption $recordArgs '--firefox-path') -ceq $fakeFirefoxPath) "$($engine.Name) installed browser command $recordIndex forwarded the wrong Firefox path."
                Assert-Probe ((Get-LoggedOption $recordArgs '--expected-firefox-sha256') -ceq $expectedFirefoxSha256) "$($engine.Name) installed browser command $recordIndex forwarded the wrong Firefox hash."
            } else {
                Assert-Probe (-not (Test-LoggedOptionPresent $recordArgs '--firefox-path') -and
                    -not (Test-LoggedOptionPresent $recordArgs '--expected-firefox-sha256')) "$($engine.Name) non-installed browser command $recordIndex received installed-Firefox identity arguments."
            }
        }
        Assert-Probe ($observedReportDirs.Count -eq 6 -and
            @($observedReportDirs | Sort-Object -Unique).Count -eq 6) "$($engine.Name) browser workflows did not use six unique report directories."
        [System.Console]::WriteLine("PASS 5 gates -> 6 fresh-report browser workflows exact-once: $($engine.Name)")

        $failureLog = Join-Path $engineRoot 'fragment-fixture-failure.log'
        $failureNonce = [guid]::NewGuid().ToString('N')
        $fixtureFailureResult = Invoke-ChildPowerShell `
            -EnginePath $engine.Path `
            -ScriptPath $failurePath `
            -FakeBin $fakeBin `
            -LogPath $failureLog `
            -Nonce $failureNonce `
            -FailAlias 'gate:signaling-media-fixture' `
            -SuppressReportAlias '' `
            -ReportMode '' `
            -ReportModeAlias '' `
            -TimeoutMilliseconds $timeoutMilliseconds
        Assert-Probe (-not $fixtureFailureResult.TimedOut) "$($engine.Name) fixture-exit-37 path exceeded the hard timeout."
        Assert-Probe ($fixtureFailureResult.ExitCode -eq 37) "$($engine.Name) fixture exit 37 did not propagate; child exited $($fixtureFailureResult.ExitCode). stdout=[$($fixtureFailureResult.StdOut)] stderr=[$($fixtureFailureResult.StdErr)]"
        $failureRecords = @(Read-FakeNpmLog $failureLog $failureNonce)
        Assert-Probe ($failureRecords.Count -eq 4) "$($engine.Name) fixture failure must stop before installed Firefox and browsers; fake npm was invoked $($failureRecords.Count) times."
        Assert-Probe ($failureRecords[3].Args[3] -ceq 'gate:signaling-media-fixture') "$($engine.Name) fixture-failure path did not invoke the exact fixture alias."
        [System.Console]::WriteLine("PASS fixture exit 37 propagation/browser suppression: $($engine.Name)")

        $installedGateFailureLog = Join-Path $engineRoot 'fragment-installed-gate-failure.log'
        $installedGateFailureNonce = [guid]::NewGuid().ToString('N')
        $installedGateFailureResult = Invoke-ChildPowerShell `
            -EnginePath $engine.Path `
            -ScriptPath $failurePath `
            -FakeBin $fakeBin `
            -LogPath $installedGateFailureLog `
            -Nonce $installedGateFailureNonce `
            -FailAlias 'gate:installed-firefox-bidi' `
            -SuppressReportAlias '' `
            -ReportMode '' `
            -ReportModeAlias '' `
            -TimeoutMilliseconds $timeoutMilliseconds
        Assert-Probe (-not $installedGateFailureResult.TimedOut -and
            $installedGateFailureResult.ExitCode -eq 37) "$($engine.Name) installed-Firefox gate failure did not propagate as exit 37."
        $installedGateFailureRecords = @(Read-FakeNpmLog $installedGateFailureLog $installedGateFailureNonce)
        Assert-Probe ($installedGateFailureRecords.Count -eq 5 -and
            $installedGateFailureRecords[4].Args[3] -ceq 'gate:installed-firefox-bidi') "$($engine.Name) installed-Firefox gate failure did not suppress all browser workflows."
        [System.Console]::WriteLine("PASS installed-Firefox gate exit 37/browser suppression: $($engine.Name)")

        $behaviorNegativeCases = @(
            [pscustomobject]@{
                Name = 'browser-native-nonzero'
                FailAlias = 'e2e:signaling-regressions:edge'
                SuppressReportAlias = ''
                ReportMode = ''
                ReportModeAlias = ''
            },
            [pscustomobject]@{
                Name = 'missing-fresh-report'
                FailAlias = ''
                SuppressReportAlias = 'e2e:signaling-regressions:firefox'
                ReportMode = ''
                ReportModeAlias = ''
            },
            [pscustomobject]@{
                Name = 'stale-report'
                FailAlias = ''
                SuppressReportAlias = ''
                ReportMode = 'stale'
                ReportModeAlias = 'e2e:control-center:edge'
            },
            [pscustomobject]@{
                Name = 'wrong-installed-firefox-identity'
                FailAlias = ''
                SuppressReportAlias = ''
                ReportMode = 'bad-firefox'
                ReportModeAlias = 'e2e:control-center:firefox-installed'
            },
            [pscustomobject]@{
                Name = 'multiple-reports'
                FailAlias = ''
                SuppressReportAlias = ''
                ReportMode = 'multiple'
                ReportModeAlias = 'e2e:signaling-regressions:edge'
            },
            [pscustomobject]@{
                Name = 'failed-behavior-check'
                FailAlias = ''
                SuppressReportAlias = ''
                ReportMode = 'failed-check'
                ReportModeAlias = 'e2e:control-center:firefox'
            }
        )
        foreach ($negativeCase in $behaviorNegativeCases) {
            $negativeLog = Join-Path $engineRoot ("fragment-$($negativeCase.Name).log")
            $negativeNonce = [guid]::NewGuid().ToString('N')
            $negativeResult = Invoke-ChildPowerShell `
                -EnginePath $engine.Path `
                -ScriptPath $failurePath `
                -FakeBin $fakeBin `
                -LogPath $negativeLog `
                -Nonce $negativeNonce `
                -FailAlias $negativeCase.FailAlias `
                -SuppressReportAlias $negativeCase.SuppressReportAlias `
                -ReportMode $negativeCase.ReportMode `
                -ReportModeAlias $negativeCase.ReportModeAlias `
                -TimeoutMilliseconds $timeoutMilliseconds
            Assert-Probe (-not $negativeResult.TimedOut -and
                $negativeResult.ExitCode -ne 0) "$($engine.Name) $($negativeCase.Name) false-green control unexpectedly passed."
            $negativeRecords = @(Read-FakeNpmLog $negativeLog $negativeNonce)
            Assert-Probe ($negativeRecords.Count -eq $expectedAliases.Count) "$($engine.Name) $($negativeCase.Name) did not preserve full independent workflow coverage."
            [System.Console]::WriteLine("PASS RED control $($negativeCase.Name): $($engine.Name)")
        }
    }

    [System.Console]::WriteLine("Readiness SHA-256: $((Get-FileHash -LiteralPath $resolvedReadinessPath -Algorithm SHA256).Hash.ToLowerInvariant())")
    [System.Console]::WriteLine("runStep snippet SHA-256: $(Get-TextSha256 $runStepBinding)")
    [System.Console]::WriteLine("repoRoot snippet SHA-256: $(Get-TextSha256 $repoRootBinding)")
    [System.Console]::WriteLine("npmExecutable snippet SHA-256: $(Get-TextSha256 $npmExecutableBinding)")
    [System.Console]::WriteLine("publisherExe snippet SHA-256: $(Get-TextSha256 $publisherBinding)")
    [System.Console]::WriteLine("artifactManifestPath snippet SHA-256: $(Get-TextSha256 $artifactManifestPathBinding)")
    [System.Console]::WriteLine("artifactManifestSha256 snippet SHA-256: $(Get-TextSha256 $artifactManifestSha256Binding)")
    [System.Console]::WriteLine("artifact validation snippet SHA-256: $(Get-TextSha256 $artifactValidationFragment)")
    [System.Console]::WriteLine("fixture/browser snippet SHA-256: $(Get-TextSha256 $productionFragment)")
    [System.Console]::WriteLine("Probe SHA-256: $((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant())")
    [System.Console]::WriteLine("RUNTIME RELEASE-READINESS REGRESSION GATE: PASS ($($engines.Count) engine(s))")
} catch {
    $failure = $_
} finally {
    if ($temporaryRoot -and [System.IO.Directory]::Exists($temporaryRoot)) {
        $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
        $resolvedSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
        if ($resolvedTemporaryRoot.StartsWith($resolvedSystemTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
            [System.IO.Path]::GetFileName($resolvedTemporaryRoot).StartsWith('gc-release-runtime-', [System.StringComparison]::Ordinal)) {
            Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            $cleanupFailure = "Refusing to recursively remove unexpected temporary path: $resolvedTemporaryRoot"
            if ($null -eq $failure) {
                $failure = [System.Management.Automation.ErrorRecord]::new(
                    [System.InvalidOperationException]::new($cleanupFailure),
                    'UnsafeCleanupTarget',
                    [System.Management.Automation.ErrorCategory]::InvalidArgument,
                    $resolvedTemporaryRoot
                )
            } else {
                [System.Console]::Error.WriteLine($cleanupFailure)
            }
        }
    }
}

if ($null -ne $failure) {
    [System.Console]::Error.WriteLine([string]$failure)
    exit 1
}
exit 0
