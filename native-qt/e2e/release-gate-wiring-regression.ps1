[CmdletBinding()]
param(
    [Alias('RepoRoot')]
    [string]$RepositoryRoot = '',
    [switch]$Json,
    [string]$TerminalEvidenceNonce = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Join-Path $PSScriptRoot '..\..'
}
$repoRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
$checks = New-Object System.Collections.Generic.List[object]

function Read-PolicyFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $path = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Release-wiring policy input is missing: $RelativePath"
    }
    return (Get-Content -LiteralPath $path -Raw).Replace("`r`n", "`n")
}

function Add-PolicyCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Failure
    )

    $checks.Add([pscustomobject]@{ id = $Id; ok = $Condition; failure = $Failure }) | Out-Null
}

function Test-ContainsLiteral {
    param([string]$Content, [string]$Needle)
    return $Content.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-Regex {
    param([string]$Content, [string]$Pattern)
    return [regex]::IsMatch(
        $Content,
        $Pattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
            [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
}

function Parse-PowerShellPolicy {
    param([string]$Content, [string]$Label)

    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $Content,
        [ref]$tokens,
        [ref]$errors
    )
    if (@($errors).Count -gt 0) {
        $messages = @($errors | ForEach-Object { $_.Message }) -join '; '
        throw "PowerShell policy input is not parseable ($Label): $messages"
    }
    return $ast
}

function Get-AstNodes {
    param(
        [System.Management.Automation.Language.Ast]$Ast,
        [type]$NodeType
    )
    return @($Ast.FindAll({ param($node) $NodeType.IsAssignableFrom($node.GetType()) }, $true))
}

function Get-AssignmentVariableName {
    param([System.Management.Automation.Language.AssignmentStatementAst]$Assignment)
    if ($Assignment.Left -isnot [System.Management.Automation.Language.VariableExpressionAst]) {
        return ''
    }
    return $Assignment.Left.VariablePath.UserPath
}

function Get-StringValues {
    param([System.Management.Automation.Language.Ast]$Ast)

    $values = @()
    foreach ($node in (Get-AstNodes $Ast ([System.Management.Automation.Language.StringConstantExpressionAst]))) {
        $values += [string]$node.Value
    }
    foreach ($node in (Get-AstNodes $Ast ([System.Management.Automation.Language.ExpandableStringExpressionAst]))) {
        $values += [string]$node.Value
    }
    return @($values)
}

function Test-TextHasAlias {
    param([string[]]$Values, [string[]]$Aliases)

    foreach ($value in $Values) {
        foreach ($alias in $Aliases) {
            if ($value.IndexOf($alias, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                return $true
            }
        }
    }
    return $false
}

function Test-IsExecutionCommand {
    param([System.Management.Automation.Language.CommandAst]$Command)

    $name = [string]$Command.GetCommandName()
    if ($name -match '^(?i:Run-Step|Run-StepWithRetry|Join-Path|Test-Path|Write-(?:Host|Output|Warning)|Get-FileHash)$') {
        return $false
    }
    if ($name -match '^(?i:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|npm(?:\.cmd)?|npx(?:\.cmd)?|node(?:\.exe)?|cmake(?:\.exe)?|gh(?:\.exe)?)$') {
        return $true
    }
    if ($Command.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
        $Command.CommandElements.Count -gt 0 -and
        $Command.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Command.CommandElements[0].Splatted -and
        $Command.CommandElements[0].VariablePath.UserPath -ceq 'script:runStepImplementation') {
        return $false
    }
    return $Command.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand
}

function Test-VariableDependsOnAlias {
    param(
        [string]$VariableName,
        [hashtable]$Assignments,
        [string[]]$Aliases,
        [hashtable]$Visited
    )

    if ($Visited.ContainsKey($VariableName)) {
        return $false
    }
    $Visited[$VariableName] = $true
    if (-not $Assignments.ContainsKey($VariableName)) {
        return $false
    }
    $assignment = $Assignments[$VariableName]
    if (Test-TextHasAlias (Get-StringValues $assignment.Right) $Aliases) {
        return $true
    }
    foreach ($variable in (Get-AstNodes $assignment.Right ([System.Management.Automation.Language.VariableExpressionAst]))) {
        $dependency = $variable.VariablePath.UserPath
        if (Test-VariableDependsOnAlias $dependency $Assignments $Aliases $Visited) {
            return $true
        }
    }
    return $false
}

function Find-ActualInvocation {
    param(
        [System.Management.Automation.Language.Ast]$Scope,
        [string[]]$Aliases
    )

    $assignments = @{}
    foreach ($assignment in (Get-AstNodes $Scope ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        $name = Get-AssignmentVariableName $assignment
        if ($name) {
            $assignments[$name] = $assignment
        }
    }

    foreach ($command in (Get-AstNodes $Scope ([System.Management.Automation.Language.CommandAst]))) {
        if (-not (Test-IsExecutionCommand $command)) {
            continue
        }
        if (Test-TextHasAlias (Get-StringValues $command) $Aliases) {
            return $command
        }
        foreach ($element in $command.CommandElements) {
            if ($element -isnot [System.Management.Automation.Language.VariableExpressionAst]) {
                continue
            }
            $visited = @{}
            if (Test-VariableDependsOnAlias $element.VariablePath.UserPath $assignments $Aliases $visited) {
                return $command
            }
        }
    }
    return $null
}

function Find-ActualInvocations {
    param(
        [System.Management.Automation.Language.Ast]$Scope,
        [string[]]$Aliases
    )

    $assignments = @{}
    foreach ($assignment in (Get-AstNodes $Scope ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        $name = Get-AssignmentVariableName $assignment
        if ($name) { $assignments[$name] = $assignment }
    }
    $invocationsFound = @()
    foreach ($command in @(
        Get-AstNodes $Scope ([System.Management.Automation.Language.CommandAst]) |
            Sort-Object { $_.Extent.StartOffset }
    )) {
        if (-not (Test-IsExecutionCommand $command)) { continue }
        $matched = Test-TextHasAlias (Get-StringValues $command) $Aliases
        if (-not $matched) {
            foreach ($element in $command.CommandElements) {
                if ($element -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
                $visited = @{}
                if (Test-VariableDependsOnAlias $element.VariablePath.UserPath $assignments $Aliases $visited) {
                    $matched = $true
                    break
                }
            }
        }
        if ($matched) { $invocationsFound += $command }
    }
    return @($invocationsFound)
}

function Get-BlockingRunSteps {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$ScriptAst,
        [string[]]$Aliases
    )

    $records = @()
    $allAssignments = Get-AstNodes $ScriptAst ([System.Management.Automation.Language.AssignmentStatementAst])
    foreach ($assignment in $allAssignments) {
        $resultName = Get-AssignmentVariableName $assignment
        if (-not $resultName) {
            continue
        }
        $runStepCandidates = @(
            Get-AstNodes $assignment.Right ([System.Management.Automation.Language.CommandAst]) |
                Where-Object {
                    $_.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
                    $_.CommandElements.Count -eq 3 -and
                    $_.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
                    -not $_.CommandElements[0].Splatted -and
                    $_.CommandElements[0].VariablePath.UserPath -ceq 'script:runStepImplementation' -and
                    $_.CommandElements[2] -is [System.Management.Automation.Language.ScriptBlockExpressionAst]
                }
        )
        if ($runStepCandidates.Count -ne 1) {
            continue
        }
        $runStep = $runStepCandidates[0]
        if (-not (Test-AstIsReachablePolicyCode $assignment)) {
            continue
        }
        $action = $runStep.CommandElements[2].ScriptBlock
        $invocation = Find-ActualInvocation $action $Aliases
        if (-not $invocation) {
            continue
        }
        $blocking = @(
            $allAssignments | Where-Object {
                $_.Extent.StartOffset -gt $assignment.Extent.EndOffset -and
                (Get-AssignmentVariableName $_) -ieq 'allPass' -and
                $_.Right.Extent.Text -match ('^\s*\$allPass\s*-and\s*\$' + [regex]::Escape($resultName) + '\s*$')
            }
        ) | Select-Object -First 1
        if ($blocking) {
            if (-not (Test-AstIsReachablePolicyCode $blocking)) { continue }
            $records += [pscustomobject]@{
                node = $assignment
                resultName = $resultName
                runStep = $runStep
                invocation = $invocation
                blockingAssignment = $blocking
            }
        }
    }
    return @($records)
}

function Get-BlockingRunStep {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$ScriptAst,
        [string[]]$Aliases
    )

    $records = @(Get-BlockingRunSteps $ScriptAst $Aliases)
    if ($records.Count -eq 0) { return $null }
    return $records[0]
}

function Get-InvocationArgumentMap {
    param(
        [System.Management.Automation.Language.Ast]$Scope,
        [System.Management.Automation.Language.CommandAst]$Invocation,
        [string[]]$ArgumentNames
    )

    $texts = New-Object System.Collections.Generic.List[string]
    $texts.Add($Invocation.Extent.Text) | Out-Null
    $assignments = @{}
    foreach ($assignment in (Get-AstNodes $Scope ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        $name = Get-AssignmentVariableName $assignment
        if ($name) {
            $assignments[$name] = $assignment
        }
    }
    foreach ($element in $Invocation.CommandElements) {
        if ($element -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $assignments.ContainsKey($element.VariablePath.UserPath)) {
            $texts.Add($assignments[$element.VariablePath.UserPath].Right.Extent.Text) | Out-Null
        }
    }

    $map = @{}
    foreach ($argumentName in $ArgumentNames) {
        $escaped = [regex]::Escape($argumentName)
        foreach ($text in $texts) {
            $arrayPattern = '["'']-{1,2}' + $escaped + '["'']\s*,\s*(?<value>\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)'
            $commandPattern = '(?<![A-Za-z0-9_-])-{1,2}' + $escaped + '(?:=|\s+)(?<value>\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)'
            $match = [regex]::Match($text, $arrayPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if (-not $match.Success) {
                $match = [regex]::Match($text, $commandPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            }
            if ($match.Success) {
                $map[$argumentName] = $match.Groups['value'].Value
                break
            }
        }
    }
    return $map
}

function Get-InvocationArgumentTexts {
    param(
        [System.Management.Automation.Language.Ast]$Scope,
        [System.Management.Automation.Language.CommandAst]$Invocation
    )

    if (-not $Invocation) { return @() }
    $texts = @($Invocation.Extent.Text)
    $assignments = @{}
    foreach ($assignment in (Get-AstNodes $Scope ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        $name = Get-AssignmentVariableName $assignment
        if ($name) { $assignments[$name] = $assignment }
    }
    foreach ($element in $Invocation.CommandElements) {
        if ($element -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $assignments.ContainsKey($element.VariablePath.UserPath)) {
            $texts += $assignments[$element.VariablePath.UserPath].Right.Extent.Text
        }
    }
    return @($texts)
}

function Test-InvocationHasSwitch {
    param(
        [System.Management.Automation.Language.Ast]$Scope,
        [System.Management.Automation.Language.CommandAst]$Invocation,
        [string]$SwitchName
    )

    $pattern = '(?:^|[\s,''"`])-{1,2}' + [regex]::Escape($SwitchName) + '(?:$|[\s,''"`])'
    foreach ($text in (Get-InvocationArgumentTexts $Scope $Invocation)) {
        if (Test-Regex $text $pattern) { return $true }
    }
    return $false
}

function Test-CommandGuardedByNegativeSwitch {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string]$SwitchName
    )

    if (-not $Command) { return $false }
    $parent = $Command.Parent
    while ($parent) {
        if ($parent -is [System.Management.Automation.Language.IfStatementAst]) {
            foreach ($clause in $parent.Clauses) {
                $condition = $clause.Item1.Extent.Text
                $escaped = [regex]::Escape($SwitchName)
                if ($condition -match ('(?i)(?:-not\s+|!\s*)\$' + $escaped + '\b|\$' + $escaped + '\s+-eq\s+\$false\b')) {
                    return $true
                }
            }
        }
        $parent = $parent.Parent
    }
    return $false
}

function Test-ImmediateWarningHandler {
    param([string]$Content, [System.Management.Automation.Language.CommandAst]$Command)

    if (-not $Command) { return $false }
    $length = [Math]::Min(1200, $Content.Length - $Command.Extent.EndOffset)
    $tail = $Content.Substring($Command.Extent.EndOffset, $length)
    $pattern = '^\s*\$(?<exit>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$LASTEXITCODE\s*;?\s*if\s*\(\s*\$\k<exit>\s+-ne\s+0\s*\)\s*\{(?s:.{0,500}?\bWrite-Warning\b)'
    return Test-Regex $tail $pattern
}

function Test-MapsShareExactValues {
    param([hashtable]$First, [hashtable]$Second, [string[]]$Keys)

    foreach ($key in $Keys) {
        if (-not $First.ContainsKey($key) -or -not $Second.ContainsKey($key) -or
            [string]$First[$key] -cne [string]$Second[$key]) {
            return $false
        }
    }
    return $true
}

function Test-SharedArtifactBindingsStable {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [object]$RoomRecord,
        [object]$FullRecord,
        [hashtable]$RoomMap,
        [hashtable]$FullMap,
        [string[]]$Keys
    )

    if (-not $RoomRecord -or -not $FullRecord -or
        -not (Test-MapsShareExactValues $RoomMap $FullMap $Keys) -or
        $RoomRecord.invocation.Extent.StartOffset -ge $FullRecord.invocation.Extent.StartOffset) {
        return $false
    }
    $variables = @{}
    foreach ($key in $Keys) {
        $expression = [string]$RoomMap[$key]
        if ($expression -notmatch '^\$(?<name>[A-Za-z_][A-Za-z0-9_]*)$') { return $false }
        $variables[$Matches.name] = $true
    }
    $assignments = @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))
    foreach ($assignment in $assignments) {
        if ($assignment.Extent.StartOffset -le $RoomRecord.invocation.Extent.EndOffset -or
            $assignment.Extent.StartOffset -ge $FullRecord.invocation.Extent.StartOffset) { continue }
        foreach ($name in $variables.Keys) {
            if ($assignment.Left.Extent.Text -match ('^\$' + [regex]::Escape($name) + '(?:\b|\.|\[)')) {
                return $false
            }
        }
    }
    foreach ($hashKey in @('ExpectedPublisherSha256', 'ExpectedPluginSha256', 'ExpectedSpoutSenderSha256')) {
        $hashVariable = ([string]$RoomMap[$hashKey]).Substring(1)
        $lastAssignment = @(
            $assignments | Where-Object {
                (Get-AssignmentVariableName $_) -ceq $hashVariable -and
                $_.Extent.StartOffset -lt $RoomRecord.invocation.Extent.StartOffset
            } | Sort-Object { $_.Extent.StartOffset } -Descending
        ) | Select-Object -First 1
        $hashCommand = $null
        if ($lastAssignment) {
            $hashCommand = @(
                Get-AstNodes $lastAssignment.Right ([System.Management.Automation.Language.CommandAst]) |
                    Where-Object { $_.GetCommandName() -ieq 'Get-FileHash' }
            ) | Select-Object -First 1
        }
        if (-not $lastAssignment -or -not $hashCommand) {
            return $false
        }
        $ancestor = $lastAssignment.Parent
        while ($ancestor) {
            if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
                $ancestor -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
                return $false
            }
            $ancestor = $ancestor.Parent
        }
    }
    return $true
}

function Test-PackageScriptContract {
    param([object]$Package, [string]$Name, [string[]]$RequiredTokens)

    $property = $Package.scripts.PSObject.Properties[$Name]
    if (-not $property) { return $false }
    $command = [string]$property.Value
    foreach ($token in $RequiredTokens) {
        if (-not (Test-ContainsLiteral $command $token)) { return $false }
    }
    return $true
}

function Test-ExactPackageScriptCommand {
    param([object]$Package, [string]$Name, [string]$ExpectedCommand)

    $properties = @(
        $Package.scripts.PSObject.Properties |
            Where-Object { $_.Name -ceq $Name }
    )
    if ($properties.Count -ne 1) { return $false }
    return ([string]$properties[0].Value).Trim() -ceq $ExpectedCommand
}

function Test-ExactPackageScriptWithoutLifecycleHooks {
    param([object]$Package, [string]$Name, [string]$ExpectedCommand)

    if (-not (Test-ExactPackageScriptCommand $Package $Name $ExpectedCommand)) {
        return $false
    }
    $forbiddenNames = @("pre$Name", "post$Name")
    return @(
        $Package.scripts.PSObject.Properties |
            Where-Object { $forbiddenNames -icontains $_.Name }
    ).Count -eq 0
}

function Get-ExactSignalingMediaFixtureRunSteps {
    param([System.Management.Automation.Language.ScriptBlockAst]$ScriptAst)

    $records = @()
    if (-not $ScriptAst.EndBlock) { return @() }
    $statements = @($ScriptAst.EndBlock.Statements)
    for ($index = 0; $index -lt $statements.Count; $index++) {
        $statement = $statements[$index]
        if ($statement -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
            $statement.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
            $statement.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
            $statement.Left.Splatted -or
            $statement.Right -isnot [System.Management.Automation.Language.PipelineAst] -or
            $statement.Right.PipelineElements.Count -ne 1) {
            continue
        }

        $runStep = $statement.Right.PipelineElements[0]
        if ($runStep -isnot [System.Management.Automation.Language.CommandAst] -or
            $runStep.GetCommandName() -cne 'Run-Step' -or
            $runStep.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown -or
            $runStep.Redirections.Count -ne 0 -or
            $runStep.CommandElements.Count -ne 3 -or
            $runStep.CommandElements[2] -isnot [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
            continue
        }

        $action = $runStep.CommandElements[2].ScriptBlock
        if ($action.ParamBlock -or $action.BeginBlock -or $action.ProcessBlock -or
            $action.DynamicParamBlock -or -not $action.EndBlock) {
            continue
        }
        $actionStatements = @($action.EndBlock.Statements)
        if ($actionStatements.Count -ne 2) { continue }

        $argumentsAssignment = $actionStatements[0]
        if ($argumentsAssignment -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
            $argumentsAssignment.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
            $argumentsAssignment.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
            $argumentsAssignment.Left.Splatted -or
            $argumentsAssignment.Right -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
            $argumentsAssignment.Right.Expression -isnot [System.Management.Automation.Language.ArrayExpressionAst]) {
            continue
        }
        $argumentsVariable = $argumentsAssignment.Left.VariablePath.UserPath
        $arrayExpression = $argumentsAssignment.Right.Expression
        $arrayStatements = @($arrayExpression.SubExpression.Statements)
        if ($arrayStatements.Count -ne 1 -or
            $arrayStatements[0] -isnot [System.Management.Automation.Language.PipelineAst] -or
            $arrayStatements[0].PipelineElements.Count -ne 1 -or
            $arrayStatements[0].PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
            $arrayStatements[0].PipelineElements[0].Expression -isnot [System.Management.Automation.Language.ArrayLiteralAst]) {
            continue
        }
        $elements = @($arrayStatements[0].PipelineElements[0].Expression.Elements)
        if ($elements.Count -ne 4 -or
            $elements[0] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $elements[0].Value -cne '--prefix' -or
            $elements[1] -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
            $elements[1].Splatted -or
            $elements[1].VariablePath.UserPath -cne 'repoRoot' -or
            $elements[2] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $elements[2].Value -cne 'run' -or
            $elements[3] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $elements[3].Value -cne 'gate:signaling-media-fixture') {
            continue
        }

        $invocationPipeline = $actionStatements[1]
        if ($invocationPipeline -isnot [System.Management.Automation.Language.PipelineAst] -or
            $invocationPipeline.PipelineElements.Count -ne 1) {
            continue
        }
        $invocation = $invocationPipeline.PipelineElements[0]
        if ($invocation -isnot [System.Management.Automation.Language.CommandAst] -or
            $invocation.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand -or
            $invocation.Redirections.Count -ne 0 -or
            $invocation.CommandElements.Count -ne 2 -or
            $invocation.CommandElements[0] -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
            $invocation.CommandElements[0].Splatted -or
            $invocation.CommandElements[0].VariablePath.UserPath -cne 'npmExecutable' -or
            $invocation.CommandElements[1] -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
            -not $invocation.CommandElements[1].Splatted -or
            $invocation.CommandElements[1].VariablePath.UserPath -cne $argumentsVariable) {
            continue
        }

        $records += [pscustomobject]@{
            node = $statement
            statementIndex = $index
            resultName = $statement.Left.VariablePath.UserPath
            invocation = $invocation
        }
    }
    return @($records)
}

function Get-ExactImmediateAllPassBinding {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$ScriptAst,
        [object]$RunStepRecord
    )

    if (-not $ScriptAst.EndBlock -or -not $RunStepRecord) { return $null }
    $statements = @($ScriptAst.EndBlock.Statements)
    $runStepIndex = -1
    if ($RunStepRecord.PSObject.Properties['statementIndex']) {
        $runStepIndex = [int]$RunStepRecord.statementIndex
    } elseif ($RunStepRecord.PSObject.Properties['node']) {
        for ($index = 0; $index -lt $statements.Count; $index++) {
            if ([object]::ReferenceEquals($statements[$index], $RunStepRecord.node)) {
                $runStepIndex = $index
                break
            }
        }
    }
    if ($runStepIndex -lt 0) { return $null }
    $bindingIndex = $runStepIndex + 1
    if ($bindingIndex -ge $statements.Count) { return $null }
    $binding = $statements[$bindingIndex]
    if ($binding -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
        $binding.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
        $binding.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        $binding.Left.Splatted -or
        $binding.Left.VariablePath.UserPath -cne 'allPass' -or
        $binding.Right -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $binding.Right.Expression -isnot [System.Management.Automation.Language.BinaryExpressionAst]) {
        return $null
    }
    $expression = $binding.Right.Expression
    if ($expression.Operator -ne [System.Management.Automation.Language.TokenKind]::And -or
        $expression.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        $expression.Left.Splatted -or
        $expression.Left.VariablePath.UserPath -cne 'allPass' -or
        $expression.Right -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        $expression.Right.Splatted -or
        $expression.Right.VariablePath.UserPath -cne [string]$RunStepRecord.resultName) {
        return $null
    }
    return $binding
}

function Get-ExactTopLevelFixtureInvocation {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    if (-not $Ast.EndBlock) { return @() }
    $statements = @($Ast.EndBlock.Statements)
    $records = @()
    for ($index = 0; $index -lt ($statements.Count - 1); $index++) {
        $argumentsAssignment = $statements[$index]
        if ($argumentsAssignment -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
            -not (Test-AssignmentDefinesExactNpmRunAlias $argumentsAssignment 'gate:signaling-media-fixture')) {
            continue
        }
        $argumentsName = Get-AssignmentVariableName $argumentsAssignment
        $invocationPipeline = $statements[$index + 1]
        if ($invocationPipeline -isnot [System.Management.Automation.Language.PipelineAst] -or
            $invocationPipeline.PipelineElements.Count -ne 1) {
            continue
        }
        $invocation = $invocationPipeline.PipelineElements[0]
        if ($invocation -isnot [System.Management.Automation.Language.CommandAst] -or
            $invocation.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand -or
            $invocation.Redirections.Count -ne 0 -or
            $invocation.CommandElements.Count -ne 2 -or
            $invocation.CommandElements[0] -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
            $invocation.CommandElements[0].Splatted -or
            $invocation.CommandElements[0].VariablePath.UserPath -cne 'script:npmExecutable' -or
            $invocation.CommandElements[1] -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
            -not $invocation.CommandElements[1].Splatted -or
            $invocation.CommandElements[1].VariablePath.UserPath -cne $argumentsName) {
            continue
        }
        $records += [pscustomobject]@{
            arguments = $argumentsAssignment
            invocation = $invocation
            statementIndex = $index
        }
    }
    return @($records)
}

function Get-ExactFixtureFailFastGuard {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [object]$InvocationRecord
    )

    if (-not $Ast.EndBlock -or -not $InvocationRecord) { return $null }
    $statements = @($Ast.EndBlock.Statements)
    $captureIndex = [int]$InvocationRecord.statementIndex + 2
    $guardIndex = $captureIndex + 1
    if ($guardIndex -ge $statements.Count) { return $null }

    $capture = $statements[$captureIndex]
    if ($capture -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
        $capture.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
        $capture.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        $capture.Left.Splatted -or
        $capture.Left.VariablePath.UserPath -cne 'signalFixtureGateExit' -or
        $capture.Right -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $capture.Right.Expression -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        $capture.Right.Expression.Splatted -or
        $capture.Right.Expression.VariablePath.UserPath -cne 'LASTEXITCODE') {
        return $null
    }

    $guard = $statements[$guardIndex]
    if ($guard -isnot [System.Management.Automation.Language.IfStatementAst] -or
        $guard.Clauses.Count -ne 1 -or $guard.ElseClause) {
        return $null
    }
    $conditionPipeline = $guard.Clauses[0].Item1
    if ($conditionPipeline -isnot [System.Management.Automation.Language.PipelineAst] -or
        $conditionPipeline.PipelineElements.Count -ne 1 -or
        $conditionPipeline.PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $conditionPipeline.PipelineElements[0].Expression -isnot [System.Management.Automation.Language.BinaryExpressionAst]) {
        return $null
    }
    $condition = $conditionPipeline.PipelineElements[0].Expression
    if ($condition.Operator -ne [System.Management.Automation.Language.TokenKind]::Ine -or
        $condition.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        $condition.Left.Splatted -or
        $condition.Left.VariablePath.UserPath -cne 'signalFixtureGateExit' -or
        $condition.Right -isnot [System.Management.Automation.Language.ConstantExpressionAst] -or
        [int]$condition.Right.Value -ne 0) {
        return $null
    }
    $bodyStatements = @($guard.Clauses[0].Item2.Statements)
    if ($bodyStatements.Count -ne 1 -or
        $bodyStatements[0] -isnot [System.Management.Automation.Language.ExitStatementAst] -or
        $bodyStatements[0].Extent.Text -notmatch '^\s*exit\s+\$signalFixtureGateExit\s*$') {
        return $null
    }
    return [pscustomobject]@{ capture = $capture; guard = $guard; exit = $bodyStatements[0] }
}

function Test-ExactScriptConstantBinding {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$ConstantName,
        [string]$ValueVariable
    )

    if (-not $Ast.EndBlock) { return $false }
    $matches = @()
    foreach ($statement in @($Ast.EndBlock.Statements)) {
        if ($statement -isnot [System.Management.Automation.Language.PipelineAst] -or
            $statement.PipelineElements.Count -ne 1) {
            continue
        }
        $command = $statement.PipelineElements[0]
        if ($command -isnot [System.Management.Automation.Language.CommandAst] -or
            $command.GetCommandName() -cne 'Microsoft.PowerShell.Utility\Set-Variable' -or
            $command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown -or
            $command.Redirections.Count -ne 0 -or $command.CommandElements.Count -ne 9) {
            continue
        }
        $elements = $command.CommandElements
        if ($elements[1] -is [System.Management.Automation.Language.CommandParameterAst] -and
            $elements[1].ParameterName -ceq 'Name' -and
            $elements[2] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $elements[2].Value -ceq $ConstantName -and
            $elements[3] -is [System.Management.Automation.Language.CommandParameterAst] -and
            $elements[3].ParameterName -ceq 'Scope' -and
            $elements[4] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $elements[4].Value -ceq 'Script' -and
            $elements[5] -is [System.Management.Automation.Language.CommandParameterAst] -and
            $elements[5].ParameterName -ceq 'Option' -and
            $elements[6] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $elements[6].Value -ceq 'Constant' -and
            $elements[7] -is [System.Management.Automation.Language.CommandParameterAst] -and
            $elements[7].ParameterName -ceq 'Value' -and
            $elements[8] -is [System.Management.Automation.Language.VariableExpressionAst] -and
            -not $elements[8].Splatted -and
            $elements[8].VariablePath.UserPath -ceq $ValueVariable) {
            $matches += $statement
        }
    }
    return $matches.Count -eq 1
}

function Get-CompactAstText {
    param([System.Management.Automation.Language.Ast]$Ast)
    if (-not $Ast) { return '' }
    return ($Ast.Extent.Text -replace '\s+', '')
}

function Test-ExactEngineCommandLookupExpression {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [string]$CommandName,
        [string]$CommandType
    )

    if ($Expression -isnot [System.Management.Automation.Language.ParenExpressionAst]) {
        return $false
    }
    $expected = '($ExecutionContext.SessionState.InvokeCommand.GetCommand(' +
        "'$CommandName',[System.Management.Automation.CommandTypes]::$CommandType))"
    return (Get-CompactAstText $Expression) -ceq $expected
}

function Get-CallOperatorGetCommandLookup {
    param([System.Management.Automation.Language.CommandAst]$Command)

    if (-not $Command -or
        $Command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand -or
        $Command.CommandElements.Count -eq 0 -or
        $Command.CommandElements[0] -isnot [System.Management.Automation.Language.ParenExpressionAst]) {
        return $null
    }
    $target = $Command.CommandElements[0]
    $lookups = @(
        Get-AstNodes $target ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                [string]$_.GetCommandName() -match
                    '^(?i:(?:Microsoft\.PowerShell\.Core\\)?Get-Command)$'
            }
    )
    if ($lookups.Count -ne 1) { return $null }
    $nameTexts = @(Get-CommandParameterArgumentTexts $lookups[0] @('Name'))
    $typeTexts = @(Get-CommandParameterArgumentTexts $lookups[0] @('CommandType'))
    if ($nameTexts.Count -ne 1 -or $typeTexts.Count -ne 1) { return $null }
    $nameText = [string]$nameTexts[0]
    $staticName = ''
    if ($nameText -match '^\s*([''"])(?<value>[^''"]+)\1\s*$') {
        $staticName = [string]$Matches.value
    }
    return [pscustomobject]@{
        command = $lookups[0]
        nameText = $nameText
        staticName = $staticName
        commandType = ([string]$typeTexts[0]).Trim().Trim('"', "'")
    }
}

function Test-ExactEngineSetVariableResolverBinding {
    param([System.Management.Automation.Language.CommandAst]$Command)

    if (-not $Command -or
        $Command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand -or
        $Command.Redirections.Count -ne 0 -or
        $Command.CommandElements.Count -notin @(5, 7, 9) -or
        -not (Test-ExactEngineCommandLookupExpression `
            $Command.CommandElements[0] 'Set-Variable' 'Cmdlet')) {
        return $false
    }
    $elements = $Command.CommandElements
    if ($elements[1] -isnot [System.Management.Automation.Language.CommandParameterAst] -or
        $elements[1].ParameterName -cne 'Name' -or
        $elements[2] -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return $false
    }
    $name = [string]$elements[2].Value

    if ($elements.Count -eq 5) {
        return $name -ceq 'resolvedNpmExecutable' -and
            $elements[3] -is [System.Management.Automation.Language.CommandParameterAst] -and
            $elements[3].ParameterName -ceq 'Value' -and
            $elements[4] -is [System.Management.Automation.Language.StringConstantExpressionAst]
    }
    if ($name -cne 'npmExecutable' -or
        $elements[3] -isnot [System.Management.Automation.Language.CommandParameterAst] -or
        $elements[3].ParameterName -cne 'Scope' -or
        $elements[4] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
        $elements[4].Value -cne 'Script') {
        return $false
    }
    $valueParameterIndex = 5
    if ($elements.Count -eq 9) {
        if ($elements[5] -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $elements[5].ParameterName -cne 'Option' -or
            $elements[6] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $elements[6].Value -cne 'Constant') {
            return $false
        }
        $valueParameterIndex = 7
    }
    return $elements[$valueParameterIndex] -is
            [System.Management.Automation.Language.CommandParameterAst] -and
        $elements[$valueParameterIndex].ParameterName -ceq 'Value' -and
        $elements[$valueParameterIndex + 1] -is
            [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $elements[$valueParameterIndex + 1].Splatted -and
        $elements[$valueParameterIndex + 1].VariablePath.UserPath -ceq
            'resolvedNpmExecutable'
}

function Get-ExactEngineConstantBindings {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Name
    )

    $records = @()
    if (-not $Ast.EndBlock) { return @() }
    $statements = @($Ast.EndBlock.Statements)
    for ($index = 0; $index -lt $statements.Count; $index++) {
        $statement = $statements[$index]
        if ($statement -isnot [System.Management.Automation.Language.PipelineAst] -or
            $statement.PipelineElements.Count -ne 1) {
            continue
        }
        $command = $statement.PipelineElements[0]
        if ($command -isnot [System.Management.Automation.Language.CommandAst] -or
            $command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand -or
            $command.Redirections.Count -ne 0 -or
            $command.CommandElements.Count -ne 9 -or
            -not (Test-ExactEngineCommandLookupExpression $command.CommandElements[0] 'New-Variable' 'Cmdlet')) {
            continue
        }
        $elements = $command.CommandElements
        if ($elements[1] -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $elements[1].ParameterName -cne 'Name' -or
            $elements[2] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $elements[2].Value -cne $Name -or
            $elements[3] -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $elements[3].ParameterName -cne 'Scope' -or
            $elements[4] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $elements[4].Value -cne 'Script' -or
            $elements[5] -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $elements[5].ParameterName -cne 'Option' -or
            $elements[6] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $elements[6].Value -cne 'Constant' -or
            $elements[7] -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $elements[7].ParameterName -cne 'Value') {
            continue
        }
        $records += [pscustomobject]@{
            statement = $statement
            statementIndex = $index
            command = $command
            value = $elements[8]
        }
    }
    return @($records)
}

function Test-ExactRunStepActionPipeline {
    param([System.Management.Automation.Language.Ast]$Pipeline)

    if ($Pipeline -isnot [System.Management.Automation.Language.PipelineAst] -or
        $Pipeline.PipelineElements.Count -ne 2) {
        return $false
    }
    $action = $Pipeline.PipelineElements[0]
    $sink = $Pipeline.PipelineElements[1]
    return $action -is [System.Management.Automation.Language.CommandAst] -and
        $action.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
        $action.Redirections.Count -eq 0 -and
        $action.CommandElements.Count -eq 1 -and
        $action.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $action.CommandElements[0].Splatted -and
        $action.CommandElements[0].VariablePath.UserPath -ceq 'action' -and
        $sink -is [System.Management.Automation.Language.CommandAst] -and
        $sink.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
        $sink.Redirections.Count -eq 0 -and
        $sink.CommandElements.Count -eq 1 -and
        (Test-ExactEngineCommandLookupExpression $sink.CommandElements[0] 'Out-Host' 'Cmdlet')
}

function Test-RunStepContract {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $bindings = @(Get-ExactEngineConstantBindings $Ast 'runStepImplementation')
    if ($bindings.Count -ne 1 -or
        $bindings[0].value -isnot [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
        return $false
    }
    $binding = $bindings[0]
    $implementation = $binding.value.ScriptBlock
    if (-not $implementation.ParamBlock -or $implementation.BeginBlock -or
        $implementation.ProcessBlock -or $implementation.DynamicParamBlock -or
        -not $implementation.EndBlock) {
        return $false
    }
    $parameters = @($implementation.ParamBlock.Parameters)
    if ($parameters.Count -ne 2 -or
        $parameters[0].Name.VariablePath.UserPath -cne 'name' -or
        $parameters[0].StaticType -ne [string] -or
        $parameters[1].Name.VariablePath.UserPath -cne 'action' -or
        $parameters[1].StaticType -ne [scriptblock]) {
        return $false
    }

    $statements = @($implementation.EndBlock.Statements)
    if ($statements.Count -ne 3 -or
        (Get-CompactAstText $statements[0]) -cne '[System.Console]::WriteLine("")' -or
        (Get-CompactAstText $statements[1]) -cne '[System.Console]::WriteLine("==={0}===",$name)' -or
        $statements[2] -isnot [System.Management.Automation.Language.TryStatementAst]) {
        return $false
    }
    $try = $statements[2]
    if ($try.CatchClauses.Count -ne 1 -or $try.Finally) { return $false }
    $tryBody = @($try.Body.Statements)
    if ($tryBody.Count -ne 4) { return $false }

    $reset = $tryBody[0]
    if ($reset -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
        $reset.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
        (Get-AssignmentVariableName $reset) -cne 'global:LASTEXITCODE' -or
        (Get-CompactAstText $reset.Right) -cne '0' -or
        -not (Test-ExactRunStepActionPipeline $tryBody[1])) {
        return $false
    }

    $guard = $tryBody[2]
    if ($guard -isnot [System.Management.Automation.Language.IfStatementAst] -or
        $guard.Clauses.Count -ne 1 -or $guard.ElseClause -or
        $guard.Clauses[0].Item1.Extent.Text -notmatch '^\s*\$global:LASTEXITCODE\s+-ne\s+0\s*$' -or
        @($guard.Clauses[0].Item2.Statements).Count -ne 1 -or
        $guard.Clauses[0].Item2.Statements[0] -isnot [System.Management.Automation.Language.ThrowStatementAst] -or
        $tryBody[3] -isnot [System.Management.Automation.Language.ReturnStatementAst] -or
        $tryBody[3].Extent.Text -notmatch '^\s*return\s+\$true\s*$') {
        return $false
    }

    $catchBody = @($try.CatchClauses[0].Body.Statements)
    if ($catchBody.Count -ne 3 -or
        (Get-CompactAstText $catchBody[0]) -cne '[System.Console]::Error.WriteLine("FAILED:{0}",$name)' -or
        (Get-CompactAstText $catchBody[1]) -cne '[System.Console]::Error.WriteLine([string]$_)' -or
        $catchBody[2] -isnot [System.Management.Automation.Language.ReturnStatementAst] -or
        $catchBody[2].Extent.Text -notmatch '^\s*return\s+\$false\s*$') {
        return $false
    }

    $legacyDefinitions = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.FunctionDefinitionAst]) |
            Where-Object { $_.Name -ceq 'Run-Step' }
    )
    $legacyInvocations = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object { $_.GetCommandName() -ceq 'Run-Step' }
    )
    $ownedInvocations = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
                $_.CommandElements.Count -gt 0 -and
                $_.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
                -not $_.CommandElements[0].Splatted -and
                $_.CommandElements[0].VariablePath.UserPath -ceq 'script:runStepImplementation'
            }
    )
    return $legacyDefinitions.Count -eq 0 -and $legacyInvocations.Count -eq 0 -and
        $ownedInvocations.Count -gt 0 -and
        @($ownedInvocations | Where-Object {
            $_.Extent.StartOffset -le $binding.statement.Extent.EndOffset
        }).Count -eq 0
}

function Test-ExactTopLevelSignalingRecord {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [object]$Record,
        [string]$ExactAlias
    )

    if (-not $Ast.EndBlock -or -not $Record) { return $false }
    $isTopLevel = @($Ast.EndBlock.Statements | Where-Object {
        [object]::ReferenceEquals($_, $Record.node)
    }).Count -eq 1
    if (-not $isTopLevel) { return $false }
    $binding = Get-ExactImmediateAllPassBinding $Ast $Record
    if (-not $binding) { return $false }

    $actionBlocks = @(
        Get-AstNodes $Record.node ([System.Management.Automation.Language.ScriptBlockExpressionAst])
    )
    if ($actionBlocks.Count -ne 1 -or -not $actionBlocks[0].ScriptBlock.EndBlock) { return $false }
    $actionStatements = @($actionBlocks[0].ScriptBlock.EndBlock.Statements)
    if ($actionStatements.Count -ne 2 -or
        -not (Test-AssignmentDefinesExactNpmRunAlias $actionStatements[0] $ExactAlias)) {
        return $false
    }
    $argumentsName = Get-AssignmentVariableName $actionStatements[0]
    $invocationPipeline = $actionStatements[1]
    if ($invocationPipeline -isnot [System.Management.Automation.Language.PipelineAst] -or
        $invocationPipeline.PipelineElements.Count -ne 1) {
        return $false
    }
    $invocation = $invocationPipeline.PipelineElements[0]
    return $invocation -is [System.Management.Automation.Language.CommandAst] -and
        $invocation.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
        $invocation.Redirections.Count -eq 0 -and
        $invocation.CommandElements.Count -eq 2 -and
        $invocation.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $invocation.CommandElements[0].Splatted -and
        $invocation.CommandElements[0].VariablePath.UserPath -ceq 'script:npmExecutable' -and
        $invocation.CommandElements[1] -is [System.Management.Automation.Language.VariableExpressionAst] -and
        $invocation.CommandElements[1].Splatted -and
        $invocation.CommandElements[1].VariablePath.UserPath -ceq $argumentsName
}

function Get-YamlSteps {
    param([string]$Content)

    $lines = @($Content -split "`n")
    $stepsLine = -1
    $stepsIndent = -1
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^(?<indent>\s*)steps:\s*$') {
            $stepsLine = $index
            $stepsIndent = $Matches.indent.Length
            break
        }
    }
    if ($stepsLine -lt 0) { return @() }

    $chunks = New-Object System.Collections.Generic.List[string]
    $current = New-Object System.Collections.Generic.List[string]
    $stepIndent = $stepsIndent + 2
    for ($index = $stepsLine + 1; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        if ($line.Trim().Length -gt 0 -and $line -match '^(?<indent>\s*)') {
            $indent = $Matches.indent.Length
            if ($indent -le $stepsIndent) { break }
        }
        if ($line -match '^(?<indent>\s*)-\s+(?:name|uses):' -and $Matches.indent.Length -eq $stepIndent) {
            if ($current.Count -gt 0) {
                $chunks.Add(($current -join "`n")) | Out-Null
                $current.Clear()
            }
        }
        if ($current.Count -gt 0 -or ($line -match '^(?<indent>\s*)-\s+(?:name|uses):' -and $Matches.indent.Length -eq $stepIndent)) {
            $current.Add($line) | Out-Null
        }
    }
    if ($current.Count -gt 0) { $chunks.Add(($current -join "`n")) | Out-Null }

    $result = @()
    foreach ($raw in $chunks) {
        $uses = ''
        if ($raw -match '(?m)^\s*(?:-\s+)?uses:\s*(?<value>[^#\r\n]+)') { $uses = $Matches.value.Trim() }
        $hasIf = $raw -match '(?m)^\s+if:\s*'
        $run = ''
        $runMatch = [regex]::Match($raw, '(?m)^(?<indent>\s*)run:\s*(?<value>[^\r\n]*)$')
        if ($runMatch.Success) {
            $inline = $runMatch.Groups['value'].Value.Trim()
            if ($inline -and $inline -notin @('|', '>')) {
                $run = $inline
            } else {
                $tail = $raw.Substring($runMatch.Index + $runMatch.Length)
                $run = $tail
            }
        }
        $result += [pscustomobject]@{ raw = $raw; uses = $uses; conditional = $hasIf; run = $run }
    }
    return @($result)
}

function Remove-CommentOnlyLines {
    param([string]$Content)
    return (@($Content -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n")
}

function Find-UnconditionalRunStep {
    param([object[]]$Steps, [string]$CommandPattern)

    foreach ($step in $Steps) {
        if ($step.conditional -or [string]::IsNullOrWhiteSpace($step.run)) { continue }
        $run = Remove-CommentOnlyLines $step.run
        if (Test-Regex $run $CommandPattern) { return $step }
    }
    return $null
}

function Test-StepBefore {
    param([string]$WorkflowContent, [object]$First, [object]$Second)

    if (-not $First -or -not $Second) { return $false }
    $firstIndex = $WorkflowContent.IndexOf($First.raw, [System.StringComparison]::Ordinal)
    $secondIndex = $WorkflowContent.IndexOf($Second.raw, [System.StringComparison]::Ordinal)
    return $firstIndex -ge 0 -and $secondIndex -gt $firstIndex
}

function Test-WorkflowJobUnconditionalWindows {
    param([string]$Content)

    $lines = @($Content -split "`n")
    $stepsIndex = -1
    $stepsIndent = -1
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^(?<indent>\s*)steps:\s*$') {
            $stepsIndex = $index
            $stepsIndent = $Matches.indent.Length
            break
        }
    }
    if ($stepsIndex -lt 0) { return $false }
    $jobStart = -1
    for ($index = $stepsIndex - 1; $index -ge 0; $index--) {
        if ($lines[$index] -match '^(?<indent>\s*)(?<name>[A-Za-z0-9_-]+):\s*$' -and
            $Matches.indent.Length -lt $stepsIndent -and $Matches.name -notin @('jobs', 'strategy', 'matrix')) {
            $jobStart = $index
            break
        }
    }
    if ($jobStart -lt 0) { return $false }
    $jobHeader = ($lines[$jobStart..($stepsIndex - 1)] -join "`n")
    return $jobHeader -notmatch '(?m)^\s+if:\s*' -and
        $jobHeader -match '(?im)^\s+runs-on:\s*[^\r\n]*(?:Windows|windows)[^\r\n]*$'
}

function Test-StepUsesPwsh {
    param([object]$Step)
    return $Step -and $Step.raw -match '(?im)^\s+shell:\s*pwsh\s*$'
}

function Find-NinjaCheckoutStep {
    param([object[]]$Steps)

    foreach ($step in $Steps) {
        if ($step.conditional -or $step.uses -notmatch '^actions/checkout@') { continue }
        if ($step.raw -notmatch '(?im)^\s+repository:\s*["'']?steveseguin/ninja-plugin["'']?\s*$') { continue }
        if ($step.raw -notmatch '(?im)^\s+ref:\s*(?:main|[0-9a-f]{40})\s*$') { continue }
        if ($step.raw -match '(?im)^\s+path:\s*(?<path>[^#\r\n]+)\s*$') {
            $path = $Matches.path.Trim().Trim('"').Trim("'")
            if ($path -ceq 'ninja-plugin') {
                return $step
            }
        }
    }
    return $null
}

function Get-NinjaCheckoutPath {
    param([object[]]$Steps)

    foreach ($step in $Steps) {
        if ($step.conditional -or $step.uses -notmatch '^actions/checkout@') { continue }
        if ($step.raw -notmatch '(?im)^\s+repository:\s*["'']?steveseguin/ninja-plugin["'']?\s*$') { continue }
        if ($step.raw -notmatch '(?im)^\s+ref:\s*(?:main|[0-9a-f]{40})\s*$') { continue }
        if ($step.raw -match '(?im)^\s+path:\s*(?<path>[^#\r\n]+)\s*$') {
            $path = $Matches.path.Trim().Trim('"').Trim("'")
            if ($path -ceq 'ninja-plugin') {
                return $path
            }
        }
    }
    return ''
}

function Test-WorkflowPluginForwarding {
    param([object]$GateStep, [string]$CheckoutPath)

    if (-not $GateStep -or [string]::IsNullOrWhiteSpace($CheckoutPath)) { return $false }
    $run = Remove-CommentOnlyLines $GateStep.run
    if ($run -match '(?i)C:\\Users\\') { return $false }
    $escapedPath = [regex]::Escape($CheckoutPath)
    $assignment = [regex]::Match(
        $run,
        '\$(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*Join-Path\s+\$env:GITHUB_WORKSPACE\s+["'']' + $escapedPath + '["'']',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if ($assignment.Success) {
        $variable = [regex]::Escape($assignment.Groups['name'].Value)
        return Test-Regex $run ('-RoomAlphaPluginRepo\b\s+`?\s*\$' + $variable + '\b')
    }
    $direct = '-RoomAlphaPluginRepo\b[^\r\n]*\$\{\{\s*github\.workspace\s*\}\}[\\/]' + $escapedPath + '\b'
    return Test-Regex $run $direct
}

function Test-HashtableForwarding {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Key,
        [string]$VariableName
    )

    foreach ($table in (Get-AstNodes $Ast ([System.Management.Automation.Language.HashtableAst]))) {
        foreach ($pair in $table.KeyValuePairs) {
            $keyText = $pair.Item1.Extent.Text.Trim().Trim('"').Trim("'")
            $valueText = $pair.Item2.Extent.Text.Trim()
            if ($keyText -ieq $Key -and $valueText -ceq ('$' + $VariableName)) {
                return $true
            }
        }
    }
    return $false
}

function Test-InvokedHashtableValue {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Invocation,
        [string]$Key,
        [string]$ExpectedValue
    )

    if (-not $Invocation) { return $false }
    $assignments = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object { $_.Extent.StartOffset -lt $Invocation.Extent.StartOffset } |
            Sort-Object { $_.Extent.StartOffset }
    )
    foreach ($element in $Invocation.CommandElements) {
        if ($element -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
        $name = $element.VariablePath.UserPath
        $finalValue = $null
        $sawInvokedHashtable = $false
        foreach ($assignment in $assignments) {
            if ((Get-AssignmentVariableName $assignment) -ieq $name) {
                $tables = @(Get-AstNodes $assignment.Right ([System.Management.Automation.Language.HashtableAst]))
                if ($tables.Count -gt 0) {
                    $sawInvokedHashtable = $true
                    $finalValue = $null
                    foreach ($pair in $tables[0].KeyValuePairs) {
                        $keyText = $pair.Item1.Extent.Text.Trim().Trim('"').Trim("'")
                        if ($keyText -ieq $Key) { $finalValue = $pair.Item2.Extent.Text.Trim() }
                    }
                } else {
                    $sawInvokedHashtable = $false
                    $finalValue = $null
                }
                continue
            }
            $memberPattern = '^\$' + [regex]::Escape($name) + '(?:\.' + [regex]::Escape($Key) + '|\[\s*["'']' + [regex]::Escape($Key) + '["'']\s*\])\s*$'
            if ($assignment.Left.Extent.Text -match $memberPattern) {
                $finalValue = $assignment.Right.Extent.Text.Trim()
            }
        }
        if ($sawInvokedHashtable -and $finalValue -ceq $ExpectedValue) { return $true }
    }
    return $false
}

function Test-ComponentWrapperPackagesExactArtifact {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $buildInvocation = Find-ActualInvocation $Ast @('build-release.ps1')
    $readinessInvocation = Find-ActualInvocation $Ast @('run-release-readiness.ps1')
    if (-not $buildInvocation -or -not $readinessInvocation -or
        -not (Test-CommandUnconditional $buildInvocation) -or
        -not (Test-ExactSourceSnapshotHelperImport $Ast)) {
        return $false
    }

    $publisherParameters = @(
        $Ast.ParamBlock.Parameters | Where-Object {
            $_.Name.VariablePath.UserPath -ceq 'PublisherPath'
        }
    )
    if ($publisherParameters.Count -ne 0) { return $false }

    foreach ($spec in @(
        [pscustomobject]@{ key = 'ExpectedSourceSnapshotSha256'; value = '$sourceSnapshot.sha256' },
        [pscustomobject]@{ key = 'ExpectedSourceSnapshotFileCount'; value = '$sourceSnapshot.fileCount' },
        [pscustomobject]@{ key = 'ExpectedSourceSnapshotAlgorithm'; value = '$sourceSnapshot.algorithm' }
    )) {
        if (-not (Test-InvokedHashtableValue $Ast $buildInvocation $spec.key $spec.value)) {
            return $false
        }
    }

    foreach ($spec in @(
        [pscustomobject]@{ key = 'PublisherPath'; value = '$packagedPublisher' },
        [pscustomobject]@{ key = 'ArtifactManifestPath'; value = '$artifactManifestPath' },
        [pscustomobject]@{ key = 'ArtifactManifestSha256'; value = '$artifactManifestSha256' }
    )) {
        if (-not (Test-InvokedHashtableValue $Ast $readinessInvocation $spec.key $spec.value)) {
            return $false
        }
    }

    $sourceSnapshot = Get-UniqueTopLevelAssignment $Ast 'sourceSnapshot'
    $packagedPublisher = Get-UniqueTopLevelAssignment $Ast 'packagedPublisher'
    $manifestPath = Get-UniqueTopLevelAssignment $Ast 'artifactManifestPath'
    $manifestHash = Get-UniqueTopLevelAssignment $Ast 'artifactManifestSha256'
    if (-not $sourceSnapshot -or -not $packagedPublisher -or
        -not $manifestPath -or -not $manifestHash -or
        (Get-CompactAstText $sourceSnapshot.Right) -cne
            'Get-ReleaseSourceSnapshot-SourceRoot$repoRoot' -or
        (Get-CompactAstText $packagedPublisher.Right) -notmatch
            '^Join-Path\$repoRoot["'']dist/game-capture-\$Version-win64/game-capture\.exe["'']$' -or
        (Get-CompactAstText $manifestPath.Right) -notmatch
            '^\[System\.IO\.Path\]::Combine\(\[System\.IO\.Path\]::GetDirectoryName\(\[System\.IO\.Path\]::GetFullPath\(\$packagedPublisher\)\),["'']release-artifact-manifest\.json["'']\)$' -or
        (Get-CompactAstText $manifestHash.Right) -cne
            '(Microsoft.PowerShell.Utility\Get-FileHash-LiteralPath$artifactManifestPath-AlgorithmSHA256-ErrorActionStop).Hash.ToLowerInvariant()') {
        return $false
    }

    return $sourceSnapshot.Extent.EndOffset -lt $buildInvocation.Extent.StartOffset -and
        $buildInvocation.Extent.EndOffset -lt $packagedPublisher.Extent.StartOffset -and
        $manifestHash.Extent.EndOffset -lt $readinessInvocation.Extent.StartOffset
}

function Test-WorkflowSwitchForwarding {
    param([object]$GateStep, [string]$SwitchName)

    if (-not $GateStep) { return $false }
    $run = Remove-CommentOnlyLines $GateStep.run
    return Test-Regex $run ('(?m)^\s*(?:\./)?native-qt/qa/[^\r\n]*\b-' + [regex]::Escape($SwitchName) + '\b|-' + [regex]::Escape($SwitchName) + '\b\s*$')
}

function Test-NoUserPathParameterDefaults {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    foreach ($parameter in (Get-AstNodes $Ast ([System.Management.Automation.Language.ParameterAst]))) {
        if ($parameter.DefaultValue -and $parameter.DefaultValue.Extent.Text -match '(?i)C:\\Users\\') {
            return $false
        }
    }
    return $true
}

function Test-ExplicitPluginRepoParameter {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $pluginParameter = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ParameterAst]) |
            Where-Object { $_.Name.VariablePath.UserPath -ieq 'PluginRepo' }
    ) | Select-Object -First 1
    if (-not $pluginParameter -or $pluginParameter.DefaultValue) { return $false }
    return (Test-MandatoryParameter $Ast 'PluginRepo') -and (Test-VariableThrowGuard $Ast 'PluginRepo')
}

function Test-MandatoryParameter {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast, [string]$Name)

    foreach ($parameter in (Get-AstNodes $Ast ([System.Management.Automation.Language.ParameterAst]))) {
        if ($parameter.Name.VariablePath.UserPath -ine $Name) { continue }
        foreach ($attribute in $parameter.Attributes) {
            if ($attribute.TypeName.Name -ine 'Parameter') { continue }
            foreach ($argument in $attribute.NamedArguments) {
                if ($argument.ArgumentName -ieq 'Mandatory' -and $argument.Argument.Extent.Text -ieq '$true') {
                    return $true
                }
            }
        }
    }
    return $false
}

function Test-SwitchParameterDeclared {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast, [string]$Name)

    return @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ParameterAst]) | Where-Object {
            $_.Name.VariablePath.UserPath -ieq $Name -and
            $_.StaticType -eq [System.Management.Automation.SwitchParameter]
        }
    ).Count -eq 1
}

function Test-BuildClearsReleaseTargetsEarly {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string[]]$TargetVariables
    )

    $stageMarker = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) | Where-Object {
            $_.GetCommandName() -ieq 'Write-Step' -and $_.Extent.Text -match '(?i)Stage Artifacts'
        }
    ) | Select-Object -First 1
    if (-not $stageMarker) { return $false }
    foreach ($target in $TargetVariables) {
        $removal = @(
            Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) | Where-Object {
                $_.GetCommandName() -ieq 'Remove-Item' -and
                $_.Extent.StartOffset -lt $stageMarker.Extent.StartOffset -and
                $_.Extent.Text -match ('(?i)\$' + [regex]::Escape($target) + '\b') -and
                $_.Extent.Text -match '(?i)-LiteralPath\b' -and
                $_.Extent.Text -match '(?i)-Force\b' -and
                (Test-AstIsReachablePolicyCode $_)
            }
        ) | Select-Object -First 1
        if (-not $removal) { return $false }
        if ($target -iin @('stageDir', 'sourceInfoDir') -and
            $removal.Extent.Text -notmatch '(?i)-Recurse\b') { return $false }
        $ancestor = $removal.Parent
        while ($ancestor) {
            if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return $false }
            $ancestor = $ancestor.Parent
        }
    }
    return $true
}

function Test-ExactPositiveLiteralPathCondition {
    param(
        [System.Management.Automation.Language.Ast]$Condition,
        [string]$TargetVariable,
        [switch]$RequireLeaf
    )

    if (-not $Condition) { return $false }
    $commands = @(
        Get-AstNodes $Condition ([System.Management.Automation.Language.CommandAst]) |
            Where-Object { $_.GetCommandName() -ieq 'Test-Path' }
    )
    if ($commands.Count -ne 1) { return $false }
    $command = $commands[0]
    $commandText = $command.Extent.Text.Trim()
    $conditionText = $Condition.Extent.Text.Trim()
    while ($conditionText.Length -ge 2 -and
        $conditionText[0] -eq '(' -and
        $conditionText[$conditionText.Length - 1] -eq ')') {
        $conditionText = $conditionText.Substring(1, $conditionText.Length - 2).Trim()
    }
    if ($conditionText -cne $commandText -or
        $commandText -notmatch '(?i)-LiteralPath\b' -or
        $commandText -notmatch ('(?i)\$' + [regex]::Escape($TargetVariable) + '\b')) {
        return $false
    }
    return -not $RequireLeaf -or $commandText -match '(?i)-PathType\s+Leaf\b'
}

function Test-CommandHasExactPositiveLiteralPathGuard {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string]$TargetVariable
    )

    $ancestor = $Command.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
            $ancestor -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
            return $false
        }
        if ($ancestor -is [System.Management.Automation.Language.IfStatementAst]) {
            foreach ($clause in $ancestor.Clauses) {
                if ((Test-AstExtentContains $clause.Item2 $Command) -and
                    (Test-ExactPositiveLiteralPathCondition $clause.Item1 $TargetVariable)) {
                    return $true
                }
            }
        }
        $ancestor = $ancestor.Parent
    }
    return $false
}

function Get-CommandParameterArgumentTexts {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string[]]$ParameterNames
    )

    $values = @()
    for ($index = 1; $index -lt $Command.CommandElements.Count; $index++) {
        $element = $Command.CommandElements[$index]
        if ($element -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $ParameterNames -inotcontains $element.ParameterName) {
            continue
        }
        if ($element.Argument) {
            $values += $element.Argument.Extent.Text
        } elseif ($index + 1 -lt $Command.CommandElements.Count -and
            $Command.CommandElements[$index + 1] -isnot [System.Management.Automation.Language.CommandParameterAst]) {
            $values += $Command.CommandElements[$index + 1].Extent.Text
        } else {
            $values += ''
        }
    }
    return @($values)
}

function Test-GlobalErrorActionStopBeforeCommand {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Command
    )

    $assignment = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object {
                (Get-AssignmentVariableName $_) -ieq 'ErrorActionPreference' -and
                $_.Extent.StartOffset -lt $Command.Extent.StartOffset
            } | Sort-Object { $_.Extent.StartOffset } -Descending
    ) | Select-Object -First 1
    if (-not $assignment -or
        $assignment.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
        $assignment.Right.Extent.Text -notmatch '(?is)^\s*(?:["'']Stop["'']|\[(?:System\.Management\.Automation\.)?ActionPreference\]::Stop)\s*$') {
        return $false
    }
    $ancestor = $assignment.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
            $ancestor -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or
            $ancestor -is [System.Management.Automation.Language.IfStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.SwitchStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.LoopStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.TryStatementAst]) {
            return $false
        }
        $ancestor = $ancestor.Parent
    }
    return $true
}

function Test-RemovalFailureIsBlocking {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Removal
    )

    $ancestor = $Removal.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.TryStatementAst]) { return $false }
        $ancestor = $ancestor.Parent
    }
    $errorActions = @(Get-CommandParameterArgumentTexts $Removal @('ErrorAction', 'EA'))
    if ($errorActions.Count -gt 0) {
        foreach ($errorAction in $errorActions) {
            if ($errorAction -notmatch '(?i)^\s*["'']?Stop["'']?\s*$') { return $false }
        }
        return $true
    }
    return Test-GlobalErrorActionStopBeforeCommand $Ast $Removal
}

function Test-TargetHasPostRemovalStaleGuard {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Removal,
        [string]$TargetVariable,
        [int]$BeforeOffset
    )

    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        if ($ifAst.Extent.StartOffset -le $Removal.Extent.EndOffset -or
            $ifAst.Extent.EndOffset -ge $BeforeOffset -or
            -not (Test-AstIsReachablePolicyCode $ifAst)) {
            continue
        }
        $tryAncestor = $ifAst.Parent
        $insideTry = $false
        while ($tryAncestor) {
            if ($tryAncestor -is [System.Management.Automation.Language.TryStatementAst]) {
                $insideTry = $true
                break
            }
            $tryAncestor = $tryAncestor.Parent
        }
        if ($insideTry) { continue }
        foreach ($clause in $ifAst.Clauses) {
            if (-not (Test-ExactPositiveLiteralPathCondition $clause.Item1 $TargetVariable)) { continue }
            $directThrows = @($clause.Item2.Statements | Where-Object {
                $_ -is [System.Management.Automation.Language.ThrowStatementAst]
            })
            if ($directThrows.Count -gt 0) { return $true }
        }
    }
    return $false
}

function Test-BuildReleaseTargetCleanupFailureBlocking {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string[]]$TargetVariables
    )

    $stageMarker = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) | Where-Object {
            $_.GetCommandName() -ieq 'Write-Step' -and $_.Extent.Text -match '(?i)Stage Artifacts'
        }
    ) | Select-Object -First 1
    if (-not $stageMarker) { return $true }
    foreach ($target in $TargetVariables) {
        $removal = @(
            Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) | Where-Object {
                $_.GetCommandName() -ieq 'Remove-Item' -and
                $_.Extent.StartOffset -lt $stageMarker.Extent.StartOffset -and
                $_.Extent.Text -match ('(?i)\$' + [regex]::Escape($target) + '\b') -and
                (Test-AstIsReachablePolicyCode $_)
            } | Sort-Object { $_.Extent.StartOffset }
        ) | Select-Object -First 1
        # Cleanup existence and target coverage are owned by BUILD_CLEARS_ALL_RELEASE_TARGETS_EARLY.
        if (-not $removal) { continue }
        if (-not (Test-CommandHasExactPositiveLiteralPathGuard $removal $target) -or
            -not (Test-RemovalFailureIsBlocking $Ast $removal) -or
            -not (Test-TargetHasPostRemovalStaleGuard $Ast $removal $target $stageMarker.Extent.StartOffset)) {
            return $false
        }
    }
    return $true
}

function Test-IfStatementIsTopLevelReachable {
    param([System.Management.Automation.Language.IfStatementAst]$IfStatement)

    if (-not $IfStatement -or -not (Test-AstIsReachablePolicyCode $IfStatement)) { return $false }
    $ancestor = $IfStatement.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
            $ancestor -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or
            $ancestor -is [System.Management.Automation.Language.IfStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.SwitchStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.LoopStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.TryStatementAst]) {
            return $false
        }
        $ancestor = $ancestor.Parent
    }
    return $true
}

function Find-UnconditionalReleaseToolGuard {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$KeywordPattern
    )

    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        $condition = $ifAst.Clauses[0].Item1
        $body = $ifAst.Clauses[0].Item2
        $conditionVariables = @(
            Get-AstNodes $condition ([System.Management.Automation.Language.VariableExpressionAst]) |
                ForEach-Object { $_.VariablePath.UserPath }
        )
        if (-not ('RequireReleaseArtifacts' -iin $conditionVariables) -and
            (Test-IfStatementIsTopLevelReachable $ifAst) -and
            @((Get-AstNodes $body ([System.Management.Automation.Language.ThrowStatementAst]))).Count -gt 0 -and
            ($condition.Extent.Text + ' ' + $body.Extent.Text) -match $KeywordPattern) {
            return $ifAst
        }
    }
    return $null
}

function Test-RequireReleaseArtifactsFinalPresenceContract {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    if (-not (Test-SwitchParameterDeclared $Ast 'RequireReleaseArtifacts')) { return $false }
    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        if (-not (Test-IfStatementIsTopLevelReachable $ifAst)) { continue }
        foreach ($clause in $ifAst.Clauses) {
            if ($clause.Item1.Extent.Text -notmatch '^\s*\$RequireReleaseArtifacts\s*$') { continue }
            $requiredAssignment = @(
                Get-AstNodes $clause.Item2 ([System.Management.Automation.Language.AssignmentStatementAst]) |
                    Where-Object {
                        (Get-AssignmentVariableName $_) -ieq 'requiredReleaseArtifacts' -and
                        $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals
                    }
            ) | Select-Object -First 1
            if (-not $requiredAssignment) { continue }
            $requiredText = $requiredAssignment.Right.Extent.Text
            $hasAllRequiredTargets = $requiredText -match '(?i)\$stageDir\b' -and
                $requiredText -match '(?i)\$zipPath\b' -and
                $requiredText -match '(?i)\$zipStablePath\b' -and
                $requiredText -match '(?i)\$portableVersionedPath\b' -and
                $requiredText -match '(?i)\$portableStablePath\b' -and
                $requiredText -match '(?i)\$installerVersionedPath\b' -and
                $requiredText -match '(?i)\$installerStablePath\b'
            if (-not $hasAllRequiredTargets) { continue }
            $validationLoop = @(
                Get-AstNodes $clause.Item2 ([System.Management.Automation.Language.ForEachStatementAst]) |
                    Where-Object {
                        $_.Variable.VariablePath.UserPath -ieq 'requiredReleaseArtifact' -and
                        $_.Condition.Extent.Text -match '(?i)\$requiredReleaseArtifacts\b'
                    }
            ) | Select-Object -First 1
            if (-not $validationLoop) { continue }
            foreach ($validationIf in (Get-AstNodes $validationLoop.Body ([System.Management.Automation.Language.IfStatementAst]))) {
                $conditionText = $validationIf.Clauses[0].Item1.Extent.Text
                $directThrows = @($validationIf.Clauses[0].Item2.Statements | Where-Object {
                    $_ -is [System.Management.Automation.Language.ThrowStatementAst]
                })
                if ($conditionText -match '(?i)(?:-not\s+|!\s*)' -and
                    $conditionText -match '(?i)Test-Path\b' -and
                    $conditionText -match '(?i)-LiteralPath\s+\$requiredReleaseArtifact\b' -and
                    $conditionText -match '(?i)-PathType\s+Leaf\b' -and
                    $directThrows.Count -gt 0) {
                    return $true
                }
            }
        }
    }
    return $false
}

function Test-BuildAliasRequiredToolsPreflightCoherent {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string[]]$TargetVariables
    )

    $firstCleanup = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) | Where-Object {
            if ($_.GetCommandName() -ine 'Remove-Item') { return $false }
            foreach ($target in $TargetVariables) {
                if ($_.Extent.Text -match ('(?i)\$' + [regex]::Escape($target) + '\b')) { return $true }
            }
            return $false
        } | Sort-Object { $_.Extent.StartOffset }
    ) | Select-Object -First 1
    # Cleanup coverage is owned by BUILD_CLEARS_ALL_RELEASE_TARGETS_EARLY.
    if (-not $firstCleanup) { return $true }
    $sevenZipGuard = Find-UnconditionalReleaseToolGuard $Ast '(?i)7-Zip|sevenZip|portable-sfx-config'
    $nsisGuard = Find-UnconditionalReleaseToolGuard $Ast '(?i)makensis|NSIS'
    if (-not $sevenZipGuard -or -not $nsisGuard -or
        $sevenZipGuard.Extent.StartOffset -ge $firstCleanup.Extent.StartOffset -or
        $nsisGuard.Extent.StartOffset -ge $firstCleanup.Extent.StartOffset) {
        return $false
    }
    foreach ($toolVariable in @('sevenZipExe', 'sevenZipSfx', 'portableConfig')) {
        $literalLeafCheck = @(
            Get-AstNodes $sevenZipGuard.Clauses[0].Item1 ([System.Management.Automation.Language.CommandAst]) |
                Where-Object {
                    $_.GetCommandName() -ieq 'Test-Path' -and
                    $_.Extent.Text -match '(?i)-LiteralPath\b' -and
                    $_.Extent.Text -match '(?i)-PathType\s+Leaf\b' -and
                    $_.Extent.Text -match ('(?i)\$' + [regex]::Escape($toolVariable) + '\b')
                }
        )
        if ($literalLeafCheck.Count -ne 1) { return $false }
    }
    return $nsisGuard.Clauses[0].Item1.Extent.Text -match '(?i)(?:-not\s+|!\s*)\$makensis\b'
}

function Test-BuildNumericVersionValidationBeforeOffset {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [int]$BeforeOffset
    )

    $versionParameter = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ParameterAst]) |
            Where-Object { $_.Name.VariablePath.UserPath -ieq 'Version' }
    ) | Select-Object -First 1
    if ($versionParameter) {
        $exactValidation = @($versionParameter.Attributes | Where-Object {
            $_ -is [System.Management.Automation.Language.AttributeAst] -and
            $_.TypeName.Name -ieq 'ValidatePattern' -and
            $_.PositionalArguments.Count -eq 1 -and
            [string]$_.PositionalArguments[0].Value -ceq '^\d+\.\d+\.\d+$'
        })
        if ($exactValidation.Count -eq 1) { return $true }
    }
    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        if ($ifAst.Extent.StartOffset -ge $BeforeOffset) { continue }
        foreach ($clause in $ifAst.Clauses) {
            $condition = $clause.Item1
            $patternValues = @(
                Get-AstNodes $condition ([System.Management.Automation.Language.StringConstantExpressionAst]) |
                    ForEach-Object { [string]$_.Value }
            )
            $directThrows = @($clause.Item2.Statements | Where-Object {
                $_ -is [System.Management.Automation.Language.ThrowStatementAst]
            })
            if ($condition.Extent.Text -match '(?i)\$Version\b' -and
                $condition.Extent.Text -match '(?i)-notmatch\b' -and
                $patternValues -ccontains '^\d+\.\d+\.\d+$' -and
                $directThrows.Count -gt 0) {
                return $true
            }
        }
    }
    return $false
}

function Test-BuildReleasePreflightBeforeCleanup {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string[]]$TargetVariables
    )

    $cleanupCommands = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) | Where-Object {
            if ($_.GetCommandName() -ine 'Remove-Item') { return $false }
            foreach ($target in $TargetVariables) {
                if ($_.Extent.Text -match ('(?i)\$' + [regex]::Escape($target) + '\b')) { return $true }
            }
            return $false
        } | Sort-Object { $_.Extent.StartOffset }
    )
    # Cleanup existence is owned by BUILD_CLEARS_ALL_RELEASE_TARGETS_EARLY.
    if ($cleanupCommands.Count -eq 0) { return $true }
    $firstCleanupOffset = $cleanupCommands[0].Extent.StartOffset
    if (-not (Test-BuildNumericVersionValidationBeforeOffset $Ast $firstCleanupOffset)) { return $false }

    $assignments = @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))
    foreach ($discovery in @(
        [pscustomobject]@{ name = 'exePath'; pattern = '(?i)Resolve-ExecutablePath' },
        [pscustomobject]@{ name = 'sevenZipExe'; pattern = '.+' },
        [pscustomobject]@{ name = 'sevenZipSfx'; pattern = '.+' },
        [pscustomobject]@{ name = 'portableConfig'; pattern = '.+' },
        [pscustomobject]@{ name = 'makensis'; pattern = '(?i)Get-Command\s+makensis\b' }
    )) {
        $matchingAssignment = @($assignments | Where-Object {
            (Get-AssignmentVariableName $_) -ieq $discovery.name -and
            $_.Extent.StartOffset -lt $firstCleanupOffset -and
            $_.Right.Extent.Text -match $discovery.pattern
        }) | Select-Object -First 1
        if (-not $matchingAssignment) { return $false }
    }

    $exeMissingGuard = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]) | Where-Object {
            $_.Extent.StartOffset -lt $firstCleanupOffset -and
            $_.Clauses[0].Item1.Extent.Text -match '(?i)(?:-not\s+|!\s*)\$exePath\b' -and
            @($_.Clauses[0].Item2.Statements | Where-Object {
                $_ -is [System.Management.Automation.Language.ThrowStatementAst]
            }).Count -gt 0
        }
    ) | Select-Object -First 1
    $exeVersionGuard = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]) | Where-Object {
            $_.Extent.StartOffset -lt $firstCleanupOffset -and
            $_.Clauses[0].Item1.Extent.Text -match '(?i)Test-BinaryContainsAsciiString' -and
            $_.Clauses[0].Item1.Extent.Text -match '(?i)\$exePath\b' -and
            $_.Clauses[0].Item1.Extent.Text -match '(?i)\$Version\b' -and
            $_.Clauses[0].Item1.Extent.Text -match '(?i)(?:-not\s+|!\s*)' -and
            @($_.Clauses[0].Item2.Statements | Where-Object {
                $_ -is [System.Management.Automation.Language.ThrowStatementAst]
            }).Count -gt 0
        }
    ) | Select-Object -First 1
    if (-not $exeMissingGuard -or -not $exeVersionGuard) { return $false }

    $ffmpegPreflight = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) | Where-Object {
            $_.GetCommandName() -ieq 'Assert-FfmpegBundle' -and
            $_.Extent.StartOffset -lt $firstCleanupOffset -and
            $_.Extent.Text -match '(?i)\$FfmpegBundleRoot\b' -and
            (Test-AstIsReachablePolicyCode $_)
        }
    ) | Select-Object -First 1
    $ffmpegRequiredGuard = $null
    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        if ($ifAst.Extent.StartOffset -ge $firstCleanupOffset -or
            -not (Test-AstIsReachablePolicyCode $ifAst)) { continue }
        foreach ($clause in $ifAst.Clauses) {
            if ($clause.Item1.Extent.Text -match '(?i)(?:-not\s+|!\s*)\$AllowMissingFfmpeg\b' -and
                ($clause.Item1.Extent.Text + ' ' + $clause.Item2.Extent.Text) -match '(?i)ffmpeg' -and
                @($clause.Item2.Statements | Where-Object {
                    $_ -is [System.Management.Automation.Language.ThrowStatementAst] -and
                    (Test-AstIsReachablePolicyCode $_)
                }).Count -gt 0) {
                $ffmpegRequiredGuard = $ifAst
                break
            }
        }
        if ($ffmpegRequiredGuard) { break }
    }
    return [bool]($ffmpegPreflight -and $ffmpegRequiredGuard)
}

function Test-VariableThrowGuard {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast, [string]$VariableName)

    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        $condition = $ifAst.Clauses[0].Item1
        $body = $ifAst.Clauses[0].Item2
        $conditionVariables = @(
            Get-AstNodes $condition ([System.Management.Automation.Language.VariableExpressionAst]) |
                ForEach-Object { $_.VariablePath.UserPath }
        )
        $throws = Get-AstNodes $body ([System.Management.Automation.Language.ThrowStatementAst])
        if ($VariableName -iin $conditionVariables -and
            $condition.Extent.Text -match '(?i)IsNullOrWhiteSpace' -and
            @($throws).Count -gt 0) {
            return $true
        }
    }
    return $false
}

function Test-CommandUnconditional {
    param([System.Management.Automation.Language.CommandAst]$Command)

    $parent = $Command.Parent
    while ($parent) {
        if ($parent -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
            $parent -is [System.Management.Automation.Language.IfStatementAst] -or
            $parent -is [System.Management.Automation.Language.SwitchStatementAst]) {
            return $false
        }
        $parent = $parent.Parent
    }
    return $true
}

function Test-ImmediateFailureGuard {
    param([string]$Content, [System.Management.Automation.Language.CommandAst]$Command)

    if (-not $Command) { return $false }
    $statement = [System.Management.Automation.Language.Ast]$Command
    $container = $null
    while ($statement.Parent) {
        if ($statement.Parent -is [System.Management.Automation.Language.NamedBlockAst] -or
            $statement.Parent -is [System.Management.Automation.Language.StatementBlockAst]) {
            $container = $statement.Parent
            break
        }
        $statement = $statement.Parent
    }
    if (-not $container) { return $false }
    $statements = @($container.Statements)
    $statementIndex = -1
    for ($index = 0; $index -lt $statements.Count; $index++) {
        if ($statements[$index].Extent.StartOffset -eq $statement.Extent.StartOffset -and
            $statements[$index].Extent.EndOffset -eq $statement.Extent.EndOffset) {
            $statementIndex = $index
            break
        }
    }
    if ($statementIndex -lt 0 -or $statementIndex + 2 -ge $statements.Count) { return $false }

    $capture = $statements[$statementIndex + 1]
    $guard = $statements[$statementIndex + 2]
    if ($capture -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
        $capture.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
        $capture.Right.Extent.Text -notmatch '^\s*\$LASTEXITCODE\s*$') {
        return $false
    }
    $exitVariable = Get-AssignmentVariableName $capture
    if (-not $exitVariable -or $guard -isnot [System.Management.Automation.Language.IfStatementAst] -or
        $guard.Clauses.Count -ne 1) {
        return $false
    }
    $conditionPattern = '^\s*\$' + [regex]::Escape($exitVariable) + '\s+-ne\s+0\s*$'
    if ($guard.Clauses[0].Item1.Extent.Text -notmatch $conditionPattern) { return $false }
    return @(
        Get-AstNodes $guard.Clauses[0].Item2 ([System.Management.Automation.Language.ThrowStatementAst])
    ).Count -gt 0
}

function Find-CmakeCompileInvocation {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    foreach ($command in (Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        if (-not (Test-IsExecutionCommand $command)) { continue }
        if ($command.GetCommandName() -match '^(?i:cmake(?:\.exe)?)$' -and
            $command.Extent.Text -match '(?i)\s--build\s+\$BuildDir\b' -and
            $command.Extent.Text -match '(?i)\s--config\s+\$Configuration\b') {
            return $command
        }
    }
    return $null
}

function Find-GhReleaseMutationInvocations {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $assignments = @{}
    foreach ($assignment in (Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        $name = Get-AssignmentVariableName $assignment
        if ($name) { $assignments[$name] = $assignment }
    }
    $results = @()
    foreach ($command in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Sort-Object { $_.Extent.StartOffset }
    )) {
        if (-not (Test-IsExecutionCommand $command)) { continue }
        $arguments = @(
            $command.CommandElements | Where-Object {
                $_ -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $_.Value
            } | ForEach-Object { [string]$_.Value }
        )
        $mutationArguments = @($arguments | Where-Object { $_ -iin @('upload', 'edit', 'create') })
        if ($arguments -notcontains 'release' -or $mutationArguments.Count -eq 0) { continue }
        if ($command.GetCommandName() -match '^(?i:gh(?:\.exe)?)$') {
            $results += $command
            continue
        }
        foreach ($element in $command.CommandElements) {
            if ($element -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
            $visited = @{}
            if (Test-VariableDependsOnAlias $element.VariablePath.UserPath $assignments @('gh', 'gh.exe') $visited) {
                $results += $command
                break
            }
        }
    }
    return @($results)
}

function Test-GhReleaseSubcommand {
    param([System.Management.Automation.Language.CommandAst]$Command, [string]$Subcommand)

    if (-not $Command) { return $false }
    $arguments = @(
        $Command.CommandElements | Where-Object {
            $_ -is [System.Management.Automation.Language.StringConstantExpressionAst]
        } | ForEach-Object { [string]$_.Value }
    )
    return $arguments -contains 'release' -and $arguments -contains $Subcommand
}

function Get-StaticPolicyConditionValue {
    param([System.Management.Automation.Language.Ast]$Condition)

    if (-not $Condition) { return 'Unknown' }
    $conditionText = $Condition.Extent.Text.Trim()
    while ($conditionText.Length -ge 2 -and
        $conditionText[0] -eq '(' -and
        $conditionText[$conditionText.Length - 1] -eq ')') {
        $conditionText = $conditionText.Substring(1, $conditionText.Length - 2).Trim()
    }
    if ($conditionText -match '^(?i:\$false|\$null|0(?:\.0+)?|''|"")$' -or
        $conditionText -match '^(?i:!\s*\$true|-not\s+\$true)$') {
        return 'False'
    }
    if ($conditionText -match '^(?i:\$true|1(?:\.0+)?)$' -or
        $conditionText -match '^(?i:!\s*\$false|-not\s+\$false)$') {
        return 'True'
    }
    return 'Unknown'
}

function Test-AstExtentContains {
    param(
        [System.Management.Automation.Language.Ast]$Container,
        [System.Management.Automation.Language.Ast]$Candidate
    )

    return $Container -and $Candidate -and
        $Candidate.Extent.StartOffset -ge $Container.Extent.StartOffset -and
        $Candidate.Extent.EndOffset -le $Container.Extent.EndOffset
}

function Test-AstIsReachablePolicyCode {
    param([System.Management.Automation.Language.Ast]$Candidate)

    if (-not $Candidate) { return $false }
    $ancestor = $Candidate.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
            $ancestor -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
            return $false
        }
        if ($ancestor -is [System.Management.Automation.Language.IfStatementAst]) {
            $priorClauseIsAlwaysTrue = $false
            $matchedConditionalRegion = $false
            foreach ($clause in $ancestor.Clauses) {
                $condition = $clause.Item1
                $body = $clause.Item2
                $conditionValue = Get-StaticPolicyConditionValue $condition
                if (Test-AstExtentContains $condition $Candidate) {
                    if ($priorClauseIsAlwaysTrue) { return $false }
                    $matchedConditionalRegion = $true
                    break
                }
                if (Test-AstExtentContains $body $Candidate) {
                    if ($priorClauseIsAlwaysTrue -or $conditionValue -eq 'False') { return $false }
                    $matchedConditionalRegion = $true
                    break
                }
                if ($conditionValue -eq 'True') {
                    $priorClauseIsAlwaysTrue = $true
                }
            }
            if (-not $matchedConditionalRegion -and
                $ancestor.ElseClause -and
                (Test-AstExtentContains $ancestor.ElseClause $Candidate) -and
                $priorClauseIsAlwaysTrue) {
                return $false
            }
        }
        $ancestor = $ancestor.Parent
    }
    return $true
}

function Test-ReadinessInvocationIsReachable {
    param([System.Management.Automation.Language.Ast]$Candidate)

    if (-not $Candidate) { return $false }
    $ancestor = $Candidate.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
            return $false
        }
        if ($ancestor -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
            $owner = $ancestor.Parent
            $ownedRunStep = $owner -is [System.Management.Automation.Language.CommandAst] -and
                $owner.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
                $owner.CommandElements.Count -gt 0 -and
                $owner.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
                -not $owner.CommandElements[0].Splatted -and
                $owner.CommandElements[0].VariablePath.UserPath -ceq 'script:runStepImplementation'
            $retryStep = $owner -is [System.Management.Automation.Language.CommandAst] -and
                $owner.GetCommandName() -ieq 'Run-StepWithRetry'
            if (-not $ownedRunStep -and -not $retryStep) {
                return $false
            }
        }
        if ($ancestor -is [System.Management.Automation.Language.IfStatementAst]) {
            $priorClauseIsAlwaysTrue = $false
            $matchedConditionalRegion = $false
            foreach ($clause in $ancestor.Clauses) {
                $condition = $clause.Item1
                $body = $clause.Item2
                $conditionValue = Get-StaticPolicyConditionValue $condition
                if (Test-AstExtentContains $condition $Candidate) {
                    if ($priorClauseIsAlwaysTrue) { return $false }
                    $matchedConditionalRegion = $true
                    break
                }
                if (Test-AstExtentContains $body $Candidate) {
                    if ($priorClauseIsAlwaysTrue -or $conditionValue -eq 'False') { return $false }
                    $matchedConditionalRegion = $true
                    break
                }
                if ($conditionValue -eq 'True') { $priorClauseIsAlwaysTrue = $true }
            }
            if (-not $matchedConditionalRegion -and
                $ancestor.ElseClause -and
                (Test-AstExtentContains $ancestor.ElseClause $Candidate) -and
                $priorClauseIsAlwaysTrue) {
                return $false
            }
        }
        $ancestor = $ancestor.Parent
    }
    return $true
}

function Get-ContainingScriptBlockAst {
    param([System.Management.Automation.Language.Ast]$Candidate)

    $ancestor = $Candidate
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.ScriptBlockAst]) {
            return $ancestor
        }
        $ancestor = $ancestor.Parent
    }
    return $null
}

function Test-AssignmentDefinesExactNpmRunAlias {
    param(
        [System.Management.Automation.Language.AssignmentStatementAst]$Assignment,
        [string]$ExactAlias
    )

    if (-not $Assignment -or
        $Assignment.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
        $Assignment.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        $Assignment.Left.Splatted -or
        $Assignment.Right -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $Assignment.Right.Expression -isnot [System.Management.Automation.Language.ArrayExpressionAst]) {
        return $false
    }
    $arrayStatements = @($Assignment.Right.Expression.SubExpression.Statements)
    if ($arrayStatements.Count -ne 1 -or
        $arrayStatements[0] -isnot [System.Management.Automation.Language.PipelineAst] -or
        $arrayStatements[0].PipelineElements.Count -ne 1 -or
        $arrayStatements[0].PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $arrayStatements[0].PipelineElements[0].Expression -isnot [System.Management.Automation.Language.ArrayLiteralAst]) {
        return $false
    }
    $elements = @($arrayStatements[0].PipelineElements[0].Expression.Elements)
    $prefixIsExact = $elements.Count -ge 4 -and
        $elements[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $elements[0].Value -ceq '--prefix' -and
        $elements[1] -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $elements[1].Splatted -and
        $elements[1].VariablePath.UserPath -ceq 'script:repoRoot' -and
        $elements[2] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $elements[2].Value -ceq 'run' -and
        $elements[3] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $elements[3].Value -ceq $ExactAlias
    if (-not $prefixIsExact) { return $false }

    if ($ExactAlias -ceq 'gate:signaling-media-fixture') {
        # npm options after the script name can redirect or suppress the root
        # fixture (for example, workspace + if-present). The fixture command has
        # no legitimate trailing arguments, so its array is deliberately exact.
        return $elements.Count -eq 4
    }
    if ($ExactAlias -ceq 'e2e:signaling-regressions:edge' -or
        $ExactAlias -ceq 'e2e:signaling-regressions:firefox') {
        return $elements.Count -eq 8 -and
            $elements[4] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $elements[4].Value -ceq '--' -and
            $elements[5] -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
            $elements[5].Extent.Text -ceq '"--publisher-path=$script:publisherExe"' -and
            @($elements[5].NestedExpressions).Count -eq 1 -and
            $elements[5].NestedExpressions[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
            -not $elements[5].NestedExpressions[0].Splatted -and
            $elements[5].NestedExpressions[0].VariablePath.UserPath -ceq 'script:publisherExe' -and
            $elements[6] -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
            $elements[6].Extent.Text -ceq '"--artifact-manifest-path=$script:artifactManifestPathBinding"' -and
            @($elements[6].NestedExpressions).Count -eq 1 -and
            $elements[6].NestedExpressions[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
            -not $elements[6].NestedExpressions[0].Splatted -and
            $elements[6].NestedExpressions[0].VariablePath.UserPath -ceq 'script:artifactManifestPathBinding' -and
            $elements[7] -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
            $elements[7].Extent.Text -ceq '"--artifact-manifest-sha256=$script:artifactManifestSha256Binding"' -and
            @($elements[7].NestedExpressions).Count -eq 1 -and
            $elements[7].NestedExpressions[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
            -not $elements[7].NestedExpressions[0].Splatted -and
            $elements[7].NestedExpressions[0].VariablePath.UserPath -ceq 'script:artifactManifestSha256Binding'
    }
    return $true
}

function Get-NpmRunArrayElementsFromExpression {
    param([System.Management.Automation.Language.Ast]$Expression)

    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        $Expression = $Expression.Expression
    }
    if ($Expression -isnot [System.Management.Automation.Language.ArrayExpressionAst]) {
        return @()
    }
    $arrayStatements = @($Expression.SubExpression.Statements)
    if ($arrayStatements.Count -ne 1 -or
        $arrayStatements[0] -isnot [System.Management.Automation.Language.PipelineAst] -or
        $arrayStatements[0].PipelineElements.Count -ne 1 -or
        $arrayStatements[0].PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $arrayStatements[0].PipelineElements[0].Expression -isnot [System.Management.Automation.Language.ArrayLiteralAst]) {
        return @()
    }
    return @($arrayStatements[0].PipelineElements[0].Expression.Elements)
}

function Get-NpmRunArrayElements {
    param([System.Management.Automation.Language.AssignmentStatementAst]$Assignment)

    if (-not $Assignment -or
        $Assignment.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
        $Assignment.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        $Assignment.Left.Splatted) {
        return @()
    }
    return @(Get-NpmRunArrayElementsFromExpression $Assignment.Right)
}

function Expand-SafeStaticCompositeFormat {
    param(
        [string]$FormatText,
        [string[]]$ArgumentValues
    )

    if ($null -eq $FormatText) { return $null }
    $builder = New-Object System.Text.StringBuilder
    $index = 0
    while ($index -lt $FormatText.Length) {
        $character = $FormatText[$index]
        if ($character -eq '{') {
            if ($index + 1 -lt $FormatText.Length -and
                $FormatText[$index + 1] -eq '{') {
                [void]$builder.Append('{')
                $index += 2
                continue
            }

            $placeholderStart = $index + 1
            $cursor = $placeholderStart
            while ($cursor -lt $FormatText.Length -and
                [char]::IsDigit($FormatText[$cursor])) {
                $cursor++
            }
            if ($cursor -eq $placeholderStart -or
                $cursor -ge $FormatText.Length -or
                $FormatText[$cursor] -ne '}') {
                return $null
            }

            $placeholderText = $FormatText.Substring(
                $placeholderStart,
                $cursor - $placeholderStart
            )
            $argumentIndex = 0
            if (-not [int]::TryParse(
                    $placeholderText,
                    [System.Globalization.NumberStyles]::None,
                    [System.Globalization.CultureInfo]::InvariantCulture,
                    [ref]$argumentIndex
                ) -or
                $argumentIndex -lt 0 -or
                $argumentIndex -ge @($ArgumentValues).Count) {
                return $null
            }
            [void]$builder.Append([string]$ArgumentValues[$argumentIndex])
            $index = $cursor + 1
            continue
        }
        if ($character -eq '}') {
            if ($index + 1 -lt $FormatText.Length -and
                $FormatText[$index + 1] -eq '}') {
                [void]$builder.Append('}')
                $index += 2
                continue
            }
            return $null
        }
        [void]$builder.Append($character)
        $index++
    }
    return $builder.ToString()
}

function Get-StaticFormatArgumentExpressions {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) {
        return [pscustomobject]@{ ok = $false; expressions = @() }
    }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Get-StaticFormatArgumentExpressions `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst] -and
        $Expression.Pipeline.PipelineElements.Count -eq 1 -and
        $Expression.Pipeline.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Get-StaticFormatArgumentExpressions `
            $Expression.Pipeline.PipelineElements[0].Expression `
            $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Get-StaticFormatArgumentExpressions `
            $Expression.PipelineElements[0].Expression `
            $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ArrayLiteralAst]) {
        return [pscustomobject]@{
            ok = $true
            expressions = @($Expression.Elements)
        }
    }
    if ($Expression -is [System.Management.Automation.Language.ArrayExpressionAst]) {
        $statements = @($Expression.SubExpression.Statements)
        if ($statements.Count -ne 1 -or
            $statements[0] -isnot [System.Management.Automation.Language.PipelineAst] -or
            $statements[0].PipelineElements.Count -ne 1 -or
            $statements[0].PipelineElements[0] -isnot
                [System.Management.Automation.Language.CommandExpressionAst]) {
            return [pscustomobject]@{ ok = $false; expressions = @() }
        }
        return Get-StaticFormatArgumentExpressions `
            $statements[0].PipelineElements[0].Expression `
            $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        $visitKey = "static-format-arguments:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) {
            return [pscustomobject]@{ ok = $false; expressions = @() }
        }
        $nextVisited = [hashtable]$Visited.Clone()
        $nextVisited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition -and
            $definition.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals) {
            return Get-StaticFormatArgumentExpressions `
                $definition.Right $Assignments $definition.Extent.StartOffset $nextVisited
        }
    }
    return [pscustomobject]@{
        ok = $true
        expressions = @($Expression)
    }
}

function Resolve-SafeStaticFormatExpression {
    param(
        [System.Management.Automation.Language.BinaryExpressionAst]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited,
        [switch]$ReleasePathTemplate
    )

    if (-not $Expression -or
        $Expression.Operator -ne [System.Management.Automation.Language.TokenKind]::Format) {
        return $null
    }

    $formatVisited = [hashtable]$Visited.Clone()
    $formatText = if ($ReleasePathTemplate) {
        Resolve-ReleasePathTextTemplate `
            $Expression.Left $Assignments $BeforeOffset $formatVisited
    } else {
        Resolve-StaticStringValue `
            $Expression.Left $Assignments $BeforeOffset $formatVisited
    }
    if ($null -eq $formatText) { return $null }

    $argumentModel = Get-StaticFormatArgumentExpressions `
        $Expression.Right $Assignments $BeforeOffset ([hashtable]$Visited.Clone())
    if (-not $argumentModel -or -not [bool]$argumentModel.ok) { return $null }

    $argumentValues = New-Object System.Collections.Generic.List[string]
    foreach ($argumentExpression in @($argumentModel.expressions)) {
        $argumentVisited = [hashtable]$Visited.Clone()
        $argumentValue = if ($ReleasePathTemplate) {
            Resolve-ReleasePathTextTemplate `
                $argumentExpression $Assignments $BeforeOffset $argumentVisited
        } else {
            Resolve-StaticStringValue `
                $argumentExpression $Assignments $BeforeOffset $argumentVisited
        }
        if ($null -eq $argumentValue) { return $null }
        $argumentValues.Add([string]$argumentValue) | Out-Null
    }

    return Expand-SafeStaticCompositeFormat `
        ([string]$formatText) $argumentValues.ToArray()
}

function Resolve-StaticStringValue {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $null }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return [string]$Expression.Value
    }
    if ($Expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
        @($Expression.NestedExpressions).Count -eq 0) {
        return [string]$Expression.Value
    }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Resolve-StaticStringValue $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst] -and
        $Expression.Pipeline.PipelineElements.Count -eq 1 -and
        $Expression.Pipeline.PipelineElements[0] -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Resolve-StaticStringValue $Expression.Pipeline.PipelineElements[0].Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.BinaryExpressionAst] -and
        $Expression.Operator -eq [System.Management.Automation.Language.TokenKind]::Plus) {
        $left = Resolve-StaticStringValue $Expression.Left $Assignments $BeforeOffset $Visited
        $right = Resolve-StaticStringValue $Expression.Right $Assignments $BeforeOffset $Visited
        if ($null -ne $left -and $null -ne $right) { return ([string]$left + [string]$right) }
        return $null
    }
    if ($Expression -is [System.Management.Automation.Language.BinaryExpressionAst] -and
        $Expression.Operator -eq [System.Management.Automation.Language.TokenKind]::Format) {
        return Resolve-SafeStaticFormatExpression `
            $Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = $Expression.VariablePath.UserPath
        $visitKey = "$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $null }
        $Visited[$visitKey] = $true
        $definition = @(
            $Assignments | Where-Object {
                (Get-AssignmentVariableName $_) -ieq $name -and
                $_.Extent.StartOffset -lt $BeforeOffset
            } | Sort-Object { $_.Extent.StartOffset } -Descending
        ) | Select-Object -First 1
        if ($definition) {
            return Resolve-StaticStringValue $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
    }
    return $null
}

function Test-NoPolicyVariableMutation {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$VariableName
    )

    if (@(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object { (Get-AssignmentVariableName $_) -ieq $VariableName }
    ).Count -gt 0) {
        return $false
    }

    foreach ($command in (Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        $commandName = [string]$command.GetCommandName()
        if ($commandName -match '(?i)(?:^|\\)(?:Set|New)-Variable$') {
            $names = @(Get-CommandParameterArgumentTexts $command @('Name'))
            if ($names.Count -eq 0 -and $command.CommandElements.Count -gt 1 -and
                $command.CommandElements[1] -isnot [System.Management.Automation.Language.CommandParameterAst]) {
                $names = @($command.CommandElements[1].Extent.Text)
            }
            if (@($names | Where-Object {
                ($_.Trim() -replace '^["'']|["'']$', '') -ieq $VariableName
            }).Count -gt 0) {
                return $false
            }
        }
        if ($commandName -match '(?i)(?:^|\\)Set-Item$') {
            $paths = @(
                @(Get-CommandParameterArgumentTexts $command @('Path', 'LiteralPath')) +
                @(Get-StringValues $command)
            )
            if (@($paths | Where-Object {
                ($_.Trim() -replace '^["'']|["'']$', '') -match
                    ('^(?i:Variable:)(?:(?:script|global|local|private):)?' + [regex]::Escape($VariableName) + '$')
            }).Count -gt 0) {
                return $false
            }
        }
    }
    return $true
}

function Test-StaticValueNamesNpmApplication {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $normalized = $Value.Trim().Trim('"', "'") -replace '/', '\\'
    return $normalized -match '(?i)(?:^|\\)npm(?:\.cmd)?$'
}

function Get-LatestAssignmentBeforeOffset {
    param(
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [string]$VariableName,
        [int]$BeforeOffset
    )

    return @(
        $Assignments | Where-Object {
            (Get-AssignmentVariableName $_) -ieq $VariableName -and
            $_.Extent.StartOffset -lt $BeforeOffset
        } | Sort-Object { $_.Extent.StartOffset } -Descending
    ) | Select-Object -First 1
}

function Get-CommandParameterArgumentAsts {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string[]]$ParameterNames
    )

    $values = @()
    for ($index = 1; $index -lt $Command.CommandElements.Count; $index++) {
        $element = $Command.CommandElements[$index]
        if ($element -isnot [System.Management.Automation.Language.CommandParameterAst] -or
            $ParameterNames -inotcontains $element.ParameterName) {
            continue
        }
        if ($element.Argument) {
            $values += $element.Argument
        } elseif ($index + 1 -lt $Command.CommandElements.Count -and
            $Command.CommandElements[$index + 1] -isnot [System.Management.Automation.Language.CommandParameterAst]) {
            $values += $Command.CommandElements[$index + 1]
        }
    }
    return @($values)
}

function Test-ExpressionResolvesCmdShell {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesCmdShell $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return ([string]$Expression.Value).Trim() -match '(?i)(?:^|[\\/])cmd(?:\.exe)?$'
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = $Expression.VariablePath.UserPath
        if ($name -ieq 'env:ComSpec') { return $true }
        $visitKey = "cmd:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionResolvesCmdShell `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
    }
    return $false
}

function Test-CommandTargetsCmdShell {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments
    )

    $name = [string]$Command.GetCommandName()
    if ($name -match '^(?i:cmd(?:\.exe)?)$') { return $true }
    if ($Command.CommandElements.Count -eq 0) { return $false }
    return Test-ExpressionResolvesCmdShell `
        $Command.CommandElements[0] $Assignments $Command.Extent.StartOffset @{}
}

function Test-CommandLaunchesCmdShell {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments
    )

    if (Test-CommandTargetsCmdShell $Command $Assignments) { return $true }
    if ([string]$Command.GetCommandName() -notmatch '^(?i:Start-Process)$') { return $false }
    foreach ($filePath in @(Get-CommandParameterArgumentAsts $Command @('FilePath'))) {
        if (Test-ExpressionResolvesCmdShell `
            $filePath $Assignments $Command.Extent.StartOffset @{}) {
            return $true
        }
    }
    return $false
}

function Get-SemanticCommandStringValues {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments
    )

    $values = @(Get-StringValues $Command)
    foreach ($element in (Get-AstNodes $Command ([System.Management.Automation.Language.VariableExpressionAst]))) {
        if ($element.Splatted) {
            continue
        }
        $definition = Get-LatestAssignmentBeforeOffset `
            $Assignments $element.VariablePath.UserPath $Command.Extent.StartOffset
        if ($definition) {
            $values += @(Get-StringValues $definition.Right)
        }
    }
    return @($values)
}

function Test-ExpressionResolvesNpmApplication {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return Test-StaticValueNamesNpmApplication ([string]$Expression.Value)
    }
    if ($Expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
        @($Expression.NestedExpressions).Count -eq 0) {
        return Test-StaticValueNamesNpmApplication ([string]$Expression.Value)
    }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesNpmApplication $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if (Test-ExactEngineCommandLookupExpression $Expression 'npm.cmd' 'Application') {
        return $true
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = $Expression.VariablePath.UserPath
        if ($name -match '^(?i:(?:script:)?npmExecutable)$') { return $true }
        $visitKey = "npm:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionResolvesNpmApplication $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
        return $false
    }

    $compact = Get-CompactAstText $Expression
    $strings = @(Get-StringValues $Expression)
    $namesNpm = @($strings | Where-Object { Test-StaticValueNamesNpmApplication $_ }).Count -gt 0
    if ($namesNpm -and $compact -match '(?i)(?:Get-Command|\.GetCommand\()' -and
        $compact -match '(?i)Application' -and $compact -match '(?i)\.Source\)?$') {
        return $true
    }
    $staticValue = Resolve-StaticStringValue $Expression $Assignments $BeforeOffset @{}
    return $null -ne $staticValue -and (Test-StaticValueNamesNpmApplication ([string]$staticValue))
}

function Test-ExpressionResolvesNpmRunAlias {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [string]$ExactAlias,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return [string]$Expression.Value -ceq $ExactAlias
    }
    if ($Expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
        @($Expression.NestedExpressions).Count -eq 0) {
        return [string]$Expression.Value -ceq $ExactAlias
    }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesNpmRunAlias $Expression.Expression $Assignments $BeforeOffset $ExactAlias $Visited
    }
    $inlineElements = @(Get-NpmRunArrayElementsFromExpression $Expression)
    if ($inlineElements.Count -ge 4) {
        $inlinePrefix = Resolve-StaticStringValue $inlineElements[0] $Assignments $BeforeOffset @{}
        $inlineVerb = Resolve-StaticStringValue $inlineElements[2] $Assignments $BeforeOffset @{}
        $inlineAlias = Resolve-StaticStringValue $inlineElements[3] $Assignments $BeforeOffset @{}
        if ($inlinePrefix -ceq '--prefix' -and $inlineVerb -ceq 'run' -and
            $inlineAlias -ceq $ExactAlias) {
            return $true
        }
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst]) {
        $name = $Expression.VariablePath.UserPath
        $visitKey = "alias:${ExactAlias}:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if (-not $definition) { return $false }
        if (Test-AssignmentDefinesExactNpmRunAlias $definition $ExactAlias) { return $true }
        $elements = @(Get-NpmRunArrayElements $definition)
        if ($elements.Count -ge 4) {
            $prefix = Resolve-StaticStringValue $elements[0] $Assignments $definition.Extent.StartOffset @{}
            $verb = Resolve-StaticStringValue $elements[2] $Assignments $definition.Extent.StartOffset @{}
            $alias = Resolve-StaticStringValue $elements[3] $Assignments $definition.Extent.StartOffset @{}
            if ($prefix -ceq '--prefix' -and $verb -ceq 'run' -and $alias -ceq $ExactAlias) {
                return $true
            }
        }
        return Test-ExpressionResolvesNpmRunAlias $definition.Right $Assignments $definition.Extent.StartOffset $ExactAlias $Visited
    }
    $resolved = Resolve-StaticStringValue $Expression $Assignments $BeforeOffset @{}
    return $null -ne $resolved -and [string]$resolved -ceq $ExactAlias
}

function Test-CommandTargetsNpmApplication {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments
    )

    $name = [string]$Command.GetCommandName()
    if ($name -match '^(?i:Start-Process)$') {
        foreach ($filePath in @(Get-CommandParameterArgumentAsts $Command @('FilePath'))) {
            if (Test-ExpressionResolvesNpmApplication `
                $filePath $Assignments $Command.Extent.StartOffset @{}) {
                return $true
            }
        }
        return $false
    }
    if (Test-StaticValueNamesNpmApplication $name) { return $true }
    if ($Command.CommandElements.Count -eq 0) { return $false }
    return Test-ExpressionResolvesNpmApplication `
        $Command.CommandElements[0] $Assignments $Command.Extent.StartOffset @{}
}

function Test-ProcessStartInvocation {
    param([System.Management.Automation.Language.InvokeMemberExpressionAst]$Invocation)

    return $Invocation -and
        $Invocation.Member -is
            [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $Invocation.Member.Extent.Text.Trim() -match '^(?i:Start)$'
}

function Get-SemanticNpmRunAliasInvocations {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$ExactAlias
    )

    $assignments = @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))
    $results = @()
    foreach ($command in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Sort-Object { $_.Extent.StartOffset }
    )) {
        if (Test-CommandLaunchesCmdShell $command $assignments) {
            $commandTextValues = @(Get-SemanticCommandStringValues $command $assignments)
            $combinedCommandText = $commandTextValues -join ' '
            if ((Test-TextHasAlias $commandTextValues @($ExactAlias)) -and
                $combinedCommandText -match '(?i)\bnpm(?:\.cmd)?\b' -and
                $combinedCommandText -match '(?i)\brun\b') {
                $results += $command
            }
            continue
        }
        $targetsNpm = Test-CommandTargetsNpmApplication $command $assignments
        if (-not $targetsNpm) {
            $targetsNpm = @(
                $command.CommandElements | Select-Object -Skip 1 | Where-Object {
                    $_ -is [System.Management.Automation.Language.VariableExpressionAst] -and
                        (Test-ExpressionResolvesNpmApplication `
                            $_ $assignments $command.Extent.StartOffset @{})
                }
            ).Count -gt 0
        }
        if (-not $targetsNpm) { continue }
        $matched = $false
        $argumentExpressions = @($command.CommandElements | Select-Object -Skip 1)
        $argumentExpressions += @(Get-CommandParameterArgumentAsts $command @('ArgumentList'))
        foreach ($element in $argumentExpressions) {
            if (Test-ExpressionResolvesNpmRunAlias `
                $element $assignments $command.Extent.StartOffset $ExactAlias @{}) {
                $matched = $true
                break
            }
        }
        if ($matched) { $results += $command }
    }
    return @($results)
}

function Get-ContainingCommandAst {
    param([System.Management.Automation.Language.Ast]$Candidate)

    $ancestor = $Candidate
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.CommandAst]) {
            return $ancestor
        }
        if ($ancestor -is [System.Management.Automation.Language.ScriptBlockAst]) {
            return $null
        }
        $ancestor = $ancestor.Parent
    }
    return $null
}

function Test-NpmExecutableReferenceIsGuardOwned {
    param([System.Management.Automation.Language.VariableExpressionAst]$Reference)

    if ($Reference.Parent -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
        (Get-CompactAstText $Reference.Parent) -ceq '[System.IO.File]::Exists($script:npmExecutable)') {
        return $true
    }
    if ($Reference.Parent -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
        $Reference.Parent.Extent.Text -ceq '"Resolved npm.cmd application does not exist: $script:npmExecutable"') {
        $ancestor = $Reference.Parent.Parent
        while ($ancestor -and $ancestor -isnot [System.Management.Automation.Language.ScriptBlockAst]) {
            if ($ancestor -is [System.Management.Automation.Language.ThrowStatementAst]) {
                return $true
            }
            $ancestor = $ancestor.Parent
        }
    }
    return $false
}

function Test-OwnedNpmInvocationInventory {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $approvedAliases = @(
        'gate:signaling-media-fixture',
        'e2e:signaling-regressions:edge',
        'e2e:signaling-regressions:firefox',
        'e2e:control-center:edge',
        'e2e:control-center:firefox',
        'gate:alpha-workflow-manifests',
        'gate:alpha-artifact-bindings',
        'gate:alpha-composite-analyzer',
        'e2e:room-alpha-ninja-plugin',
        'e2e:ninja-plugin-alpha'
    )
    $ownedOffsets = @{}
    foreach ($alias in $approvedAliases) {
        foreach ($invocation in @(Get-SemanticNpmRunAliasInvocations $Ast $alias)) {
            $ownedOffsets[[string]$invocation.Extent.StartOffset] = $true
        }
    }
    $assignments = @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))
    foreach ($invocation in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst])
    )) {
        if (Test-ProcessStartInvocation $invocation) {
            return $false
        }
    }
    $potentialNpmInvocations = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $candidate = $_
                if (Test-ExactEngineSetVariableResolverBinding $candidate) {
                    return $false
                }
                if (Test-CommandTargetsNpmApplication $candidate $assignments) { return $true }
                return @(
                    $candidate.CommandElements | Select-Object -Skip 1 | Where-Object {
                        $_ -is [System.Management.Automation.Language.VariableExpressionAst] -and
                            (Test-ExpressionResolvesNpmApplication `
                                $_ $assignments $candidate.Extent.StartOffset @{})
                    }
                ).Count -gt 0
            }
    )
    foreach ($invocation in $potentialNpmInvocations) {
        if (-not $ownedOffsets.ContainsKey([string]$invocation.Extent.StartOffset)) {
            return $false
        }
    }

    foreach ($reference in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.VariableExpressionAst]) |
            Where-Object { $_.VariablePath.UserPath -ceq 'script:npmExecutable' }
    )) {
        if ($reference.Parent -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            [object]::ReferenceEquals($reference.Parent.Left, $reference)) {
            # Binding/assignment integrity is owned by
            # READINESS_NPM_APPLICATION_RESOLUTION. A write to the production
            # Constant fails loudly at runtime and is not an extra npm launch.
            continue
        }
        $command = Get-ContainingCommandAst $reference
        if ($command -and $ownedOffsets.ContainsKey([string]$command.Extent.StartOffset)) {
            continue
        }
        if (Test-NpmExecutableReferenceIsGuardOwned $reference) { continue }
        return $false
    }
    return $true
}

function Test-BreakOrContinueIsLexicallyLocal {
    param([System.Management.Automation.Language.Ast]$Statement)

    $requestedLabel = [string]$Statement.Label
    $ancestor = $Statement.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.ScriptBlockAst]) {
            return $false
        }
        if ($ancestor -is [System.Management.Automation.Language.ForStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.ForEachStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.WhileStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.DoWhileStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.DoUntilStatementAst] -or
            $ancestor -is [System.Management.Automation.Language.SwitchStatementAst]) {
            if ([string]::IsNullOrWhiteSpace($requestedLabel)) {
                return $true
            }
            if ($ancestor.PSObject.Properties['Label'] -and
                -not [string]::IsNullOrWhiteSpace([string]$ancestor.Label) -and
                [string]$ancestor.Label -ieq $requestedLabel) {
                return $true
            }
        }
        $ancestor = $ancestor.Parent
    }
    return $false
}

function Test-NoDynamicExecutionOrSuccessfulProcessTerminationCalls {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [int]$PreFixtureCutoff
    )

    foreach ($typeExpression in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.TypeExpressionAst])
    )) {
        if ((Get-CompactAstText $typeExpression) -match
            '^\[(?i:(?:System\.Management\.Automation\.)?PowerShell)\]$') {
            return $false
        }
    }
    foreach ($command in (Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        if ([string]$command.GetCommandName() -match '(?i)(?:^|\\)(?:Invoke-Expression|iex)$') {
            return $false
        }
    }
    foreach ($invocation in (Get-AstNodes $Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst]))) {
        if ($invocation.Member -isnot
            [System.Management.Automation.Language.StringConstantExpressionAst]) {
            return $false
        }
        $typeText = Get-CompactAstText $invocation.Expression
        $memberText = $invocation.Member.Extent.Text.Trim()
        if ($memberText -match '(?i)Invoke' -or
            $memberText -match '^(?i:CreateDelegate|NewScriptBlock|AddScript|AddCommand)$') {
            return $false
        }
        if (-not $invocation.Static) { continue }
        if ($typeText -match '^\[(?i:(?:System\.)?Environment)\]$' -and
            $memberText -match '^(?i:Exit|FailFast)$') {
            return $false
        }
        if ($memberText -match '^(?i:Create)$') {
            $owner = Get-ContainingCommandAst $invocation
            if ($owner -and
                $owner.Extent.StartOffset -lt $PreFixtureCutoff -and
                $owner.InvocationOperator -eq
                    [System.Management.Automation.Language.TokenKind]::Ampersand -and
                [object]::ReferenceEquals((Get-ContainingScriptBlockAst $owner), $Ast)) {
                continue
            }
            return $false
        }
    }
    return $true
}

function Test-NoUnownedPostFixtureCallOperators {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [int]$PreFixtureCutoff
    )

    $semanticNpmOffsets = @{}
    foreach ($alias in @(
        'gate:signaling-media-fixture',
        'e2e:signaling-regressions:edge',
        'e2e:signaling-regressions:firefox',
        'e2e:control-center:edge',
        'e2e:control-center:firefox',
        'gate:alpha-workflow-manifests',
        'gate:alpha-artifact-bindings',
        'gate:alpha-composite-analyzer',
        'e2e:room-alpha-ninja-plugin',
        'e2e:ninja-plugin-alpha'
    )) {
        foreach ($invocation in @(Get-SemanticNpmRunAliasInvocations $Ast $alias)) {
            $semanticNpmOffsets[[string]$invocation.Extent.StartOffset] = $true
        }
    }
    $engineConstantOffsets = @{}
    foreach ($constantName in @(
        'runStepImplementation',
        'repoRoot',
        'npmExecutable',
        'publisherExe',
        'artifactManifestPathBinding',
        'artifactManifestSha256Binding'
    )) {
        foreach ($binding in @(Get-ExactEngineConstantBindings $Ast $constantName)) {
            $engineConstantOffsets[[string]$binding.command.Extent.StartOffset] = $true
        }
    }
    foreach ($command in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst])
    )) {
        if ($command.Extent.StartOffset -lt $PreFixtureCutoff -or
            $command.CommandElements.Count -eq 0) {
            continue
        }
        if ($command.InvocationOperator -eq
                [System.Management.Automation.Language.TokenKind]::Dot) {
            return $false
        }
        $commandName = [string]$command.GetCommandName()
        if ($commandName -match '(?i)\.ps1$' -or
            (Test-CommandMutatesNamedVariable $command 'allPass')) {
            return $false
        }
        if (-not [string]::IsNullOrWhiteSpace($commandName)) {
            foreach ($definition in @(
                Get-AstNodes $Ast ([System.Management.Automation.Language.FunctionDefinitionAst]) |
                    Where-Object { $_.Name -ieq $commandName }
            )) {
                if (-not (Test-NoProtectedVariableWritesInRange $definition.Body `
                    @('allPass') $definition.Body.Extent.StartOffset `
                    ($definition.Body.Extent.EndOffset + 1))) {
                    return $false
                }
            }
        }
        if ($command.InvocationOperator -ne
                [System.Management.Automation.Language.TokenKind]::Ampersand) {
            continue
        }
        $target = $command.CommandElements[0]
        $isImmutableRunner = $target -is
                [System.Management.Automation.Language.VariableExpressionAst] -and
            -not $target.Splatted -and
            $target.VariablePath.UserPath -ceq 'script:runStepImplementation'
        $isOwnedNpm = $semanticNpmOffsets.ContainsKey(
            [string]$command.Extent.StartOffset
        )
        $isEngineConstantBinding = $engineConstantOffsets.ContainsKey(
            [string]$command.Extent.StartOffset
        )
        $isInstallerCompiler = (Get-CompactAstText $target) -ceq '$makensis.Path'
        if (-not $isImmutableRunner -and -not $isOwnedNpm -and
            -not $isEngineConstantBinding -and
            -not $isInstallerCompiler) {
            return $false
        }
    }
    return $true
}

function Test-StaticScriptBlockOnlyWrapsOwnedNpmInvocation {
    param(
        [System.Management.Automation.Language.ScriptBlockExpressionAst]$Expression,
        [hashtable]$SemanticNpmOffsets
    )

    if (-not $Expression -or -not $Expression.ScriptBlock -or
        -not $Expression.ScriptBlock.EndBlock -or
        $Expression.ScriptBlock.ParamBlock -or
        $Expression.ScriptBlock.DynamicParamBlock -or
        $Expression.ScriptBlock.BeginBlock -or
        $Expression.ScriptBlock.ProcessBlock) {
        return $false
    }

    $commands = @(
        Get-AstNodes $Expression.ScriptBlock ([System.Management.Automation.Language.CommandAst])
    )
    if ($commands.Count -ne 1 -or
        -not [object]::ReferenceEquals(
            (Get-ContainingScriptBlockAst $commands[0]),
            $Expression.ScriptBlock
        ) -or
        -not $SemanticNpmOffsets.ContainsKey([string]$commands[0].Extent.StartOffset)) {
        return $false
    }

    $statements = @($Expression.ScriptBlock.EndBlock.Statements)
    if ($statements.Count -ne 2 -or
        $statements[0] -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
        $statements[1] -isnot [System.Management.Automation.Language.PipelineAst] -or
        $statements[1].PipelineElements.Count -ne 1 -or
        -not [object]::ReferenceEquals($statements[1].PipelineElements[0], $commands[0]) -or
        -not (Test-AstExtentContains $statements[1] $commands[0]) -or
        $commands[0].InvocationOperator -ne
            [System.Management.Automation.Language.TokenKind]::Ampersand -or
        $commands[0].CommandElements.Count -ne 2 -or
        $commands[0].CommandElements[1] -isnot
            [System.Management.Automation.Language.VariableExpressionAst] -or
        -not $commands[0].CommandElements[1].Splatted) {
        return $false
    }
    $assignmentName = Get-AssignmentVariableName $statements[0]
    if ([string]::IsNullOrWhiteSpace($assignmentName) -or
        $assignmentName -match ':' -or
        $commands[0].CommandElements[1].VariablePath.UserPath -cne $assignmentName) {
        return $false
    }
    foreach ($alias in @(
        'gate:signaling-media-fixture',
        'e2e:signaling-regressions:edge',
        'e2e:signaling-regressions:firefox'
    )) {
        if (Test-AssignmentDefinesExactNpmRunAlias $statements[0] $alias) {
            return $true
        }
    }
    return $false
}

function Test-StaticScriptBlockOnlyContainsSuccessfulExit {
    param([System.Management.Automation.Language.ScriptBlockExpressionAst]$Expression)

    if (-not $Expression -or -not $Expression.ScriptBlock -or
        -not $Expression.ScriptBlock.EndBlock -or
        $Expression.ScriptBlock.ParamBlock -or
        $Expression.ScriptBlock.DynamicParamBlock -or
        $Expression.ScriptBlock.BeginBlock -or
        $Expression.ScriptBlock.ProcessBlock) {
        return $false
    }
    $statements = @($Expression.ScriptBlock.EndBlock.Statements)
    return $statements.Count -eq 1 -and
        $statements[0] -is [System.Management.Automation.Language.ExitStatementAst] -and
        $statements[0].Extent.Text -match '^\s*exit\s+(?:0|\$false)\s*$'
}

function Test-PreFixtureExecutionAllowlist {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [object]$FixtureRecord
    )

    if (-not $Ast.EndBlock -or -not $FixtureRecord -or -not $FixtureRecord.arguments) {
        return $false
    }
    $cutoff = $FixtureRecord.arguments.Extent.StartOffset
    $semanticNpmOffsets = @{}
    foreach ($alias in @(
        'gate:signaling-media-fixture',
        'e2e:signaling-regressions:edge',
        'e2e:signaling-regressions:firefox'
    )) {
        foreach ($invocation in @(Get-SemanticNpmRunAliasInvocations $Ast $alias)) {
            $semanticNpmOffsets[[string]$invocation.Extent.StartOffset] = $true
        }
    }
    foreach ($command in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Sort-Object { $_.Extent.StartOffset }
    )) {
        if ($command.Extent.StartOffset -ge $cutoff -or
            -not [object]::ReferenceEquals((Get-ContainingScriptBlockAst $command), $Ast)) {
            continue
        }

        $commandName = [string]$command.GetCommandName()
        if ($commandName -match '(?i)\.ps1$') {
            return $false
        }
        if ($command.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Dot) {
            return $false
        }
        if ($command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand) {
            continue
        }
        if ($command.CommandElements.Count -eq 0) { return $false }
        $target = $command.CommandElements[0]
        $isImmutableRunner = $target -is [System.Management.Automation.Language.VariableExpressionAst] -and
            -not $target.Splatted -and
            $target.VariablePath.UserPath -ceq 'script:runStepImplementation'
        $isEngineConstantBinding = Test-ExactEngineCommandLookupExpression `
            $target 'New-Variable' 'Cmdlet'
        $isEngineResolverBinding = Test-ExactEngineSetVariableResolverBinding $command
        $isSemanticallyOwnedNpm = $semanticNpmOffsets.ContainsKey(
            [string]$command.Extent.StartOffset
        )
        $isStaticOwnedNpmWrapper = $target -is
            [System.Management.Automation.Language.ScriptBlockExpressionAst] -and
            (Test-StaticScriptBlockOnlyWrapsOwnedNpmInvocation `
                $target $semanticNpmOffsets)
        $isStaticSuccessfulExitWrapper = $target -is
            [System.Management.Automation.Language.ScriptBlockExpressionAst] -and
            (Test-StaticScriptBlockOnlyContainsSuccessfulExit $target)
        if (-not $isImmutableRunner -and -not $isEngineConstantBinding -and
            -not $isEngineResolverBinding -and
            -not $isSemanticallyOwnedNpm -and -not $isStaticOwnedNpmWrapper -and
            -not $isStaticSuccessfulExitWrapper) {
            return $false
        }
    }
    return $true
}

function Test-RootExitAndReturnAllowlist {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [object]$FixtureGuard
    )

    if (-not $Ast.EndBlock -or -not $FixtureGuard -or -not $FixtureGuard.exit) { return $false }
    $rootReturns = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ReturnStatementAst]) |
            Where-Object { [object]::ReferenceEquals((Get-ContainingScriptBlockAst $_), $Ast) }
    )
    $unsafeBreaks = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.BreakStatementAst]) |
            Where-Object { -not (Test-BreakOrContinueIsLexicallyLocal $_) }
    )
    $unsafeContinues = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ContinueStatementAst]) |
            Where-Object { -not (Test-BreakOrContinueIsLexicallyLocal $_) }
    )
    $allExits = @(Get-AstNodes $Ast ([System.Management.Automation.Language.ExitStatementAst]))
    if ($rootReturns.Count -ne 0 -or $unsafeBreaks.Count -ne 0 -or
        $unsafeContinues.Count -ne 0 -or $allExits.Count -ne 2 -or
        -not (Test-NoDynamicExecutionOrSuccessfulProcessTerminationCalls `
            $Ast $FixtureGuard.capture.Extent.StartOffset) -or
        -not (Test-NoUnownedPostFixtureCallOperators `
            $Ast $FixtureGuard.capture.Extent.StartOffset)) {
        return $false
    }
    if (@($allExits | Where-Object { [object]::ReferenceEquals($_, $FixtureGuard.exit) }).Count -ne 1) {
        return $false
    }
    $finalStatement = @($Ast.EndBlock.Statements)[-1]
    if ($finalStatement -isnot [System.Management.Automation.Language.IfStatementAst] -or
        $finalStatement.Clauses.Count -ne 1 -or $finalStatement.ElseClause -or
        $finalStatement.Clauses[0].Item1.Extent.Text -notmatch '^\s*-not\s+\$allPass\s*$') {
        return $false
    }
    $finalBody = @($finalStatement.Clauses[0].Item2.Statements)
    return $finalBody.Count -eq 1 -and
        $finalBody[0] -is [System.Management.Automation.Language.ExitStatementAst] -and
        $finalBody[0].Extent.Text -match '^\s*exit\s+1\s*$' -and
        @($allExits | Where-Object { [object]::ReferenceEquals($_, $finalBody[0]) }).Count -eq 1
}

function Test-NoRootTrapStatements {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    return @(Get-AstNodes $Ast ([System.Management.Automation.Language.TrapStatementAst])).Count -eq 0
}

function Get-ExactReachableNpmRunAliasInvocations {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$ExactAlias
    )

    $assignments = @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))
    $results = @()
    foreach ($command in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Sort-Object { $_.Extent.StartOffset }
    )) {
        if ($command.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand -or
            $command.CommandElements.Count -lt 2 -or
            -not (Test-ReadinessInvocationIsReachable $command)) {
            continue
        }
        $target = $command.CommandElements[0]
        $targetIsNpm =
            ($target -is [System.Management.Automation.Language.VariableExpressionAst] -and
                -not $target.Splatted -and $target.VariablePath.UserPath -ceq 'npmExecutable') -or
            ($target -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $target.Value -ieq 'npm.cmd')
        if (-not $targetIsNpm) { continue }

        $commandScope = Get-ContainingScriptBlockAst $command
        foreach ($argument in $command.CommandElements | Select-Object -Skip 1) {
            if ($argument -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
                -not $argument.Splatted) {
                continue
            }
            $argumentName = $argument.VariablePath.UserPath
            $definition = @(
                $assignments | Where-Object {
                    $_.Extent.StartOffset -lt $command.Extent.StartOffset -and
                    (Get-AssignmentVariableName $_) -ceq $argumentName -and
                    [object]::ReferenceEquals((Get-ContainingScriptBlockAst $_), $commandScope) -and
                    (Test-ReadinessInvocationIsReachable $_)
                } | Sort-Object { $_.Extent.StartOffset } -Descending
            ) | Select-Object -First 1
            if (Test-AssignmentDefinesExactNpmRunAlias $definition $ExactAlias) {
                $results += $command
                break
            }
        }
    }
    return @($results)
}

function Test-ExactNpmApplicationResolver {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [object]$FixtureRecord
    )

    if (-not $Ast.EndBlock -or -not $FixtureRecord) { return $false }
    $resolverAssignments = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object {
                (Get-AssignmentVariableName $_) -ceq 'npmExecutable' -and
                (Test-AstIsReachablePolicyCode $_)
            }
    )
    if ($resolverAssignments.Count -ne 1) { return $false }
    $resolver = $resolverAssignments[0]
    $isTopLevel = @($Ast.EndBlock.Statements | Where-Object {
        [object]::ReferenceEquals($_, $resolver)
    }).Count -eq 1
    return $isTopLevel -and
        $resolver.Extent.EndOffset -lt $FixtureRecord.node.Extent.StartOffset -and
        $resolver.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals -and
        $resolver.Right.Extent.Text.Trim() -ceq "(Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction Stop).Source"
}

function Test-ExpressionMonotonicallyPreservesAllPass {
    param([System.Management.Automation.Language.Ast]$Expression)

    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionMonotonicallyPreservesAllPass $Expression.Expression
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst]) {
        return -not $Expression.Splatted -and $Expression.VariablePath.UserPath -ceq 'allPass'
    }
    if ($Expression -is [System.Management.Automation.Language.BinaryExpressionAst] -and
        $Expression.Operator -eq [System.Management.Automation.Language.TokenKind]::And) {
        return Test-ExpressionMonotonicallyPreservesAllPass $Expression.Left
    }
    return $false
}

function Test-FixtureFailureRemainsPreserved {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [object]$FixtureRecord,
        [System.Management.Automation.Language.AssignmentStatementAst]$FixtureBinding
    )

    if (-not $FixtureRecord -or -not $FixtureBinding) { return $false }
    foreach ($assignment in (Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        if ($assignment.Extent.StartOffset -le $FixtureBinding.Extent.EndOffset -or
            -not (Test-AstIsReachablePolicyCode $assignment)) {
            continue
        }
        $name = Get-AssignmentVariableName $assignment
        if ($name -ceq [string]$FixtureRecord.resultName) { return $false }
        if ($name -ceq 'allPass' -and
            ($assignment.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals -or
                -not (Test-ExpressionMonotonicallyPreservesAllPass $assignment.Right))) {
            return $false
        }
    }
    foreach ($command in (Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        if ($command.Extent.StartOffset -le $FixtureBinding.Extent.EndOffset -or
            -not (Test-AstIsReachablePolicyCode $command) -or
            $command.GetCommandName() -notmatch '^(?i:Set-Variable|New-Variable|Remove-Variable|Clear-Variable)$') {
            continue
        }
        $values = @(Get-StringValues $command)
        if ($values -icontains 'allPass' -or $values -icontains [string]$FixtureRecord.resultName) {
            return $false
        }
    }
    return $true
}

function Test-CommandIsReachablePolicyCode {
    param([System.Management.Automation.Language.CommandAst]$Command)

    return Test-AstIsReachablePolicyCode $Command
}

function Get-ReachableCommandsByName {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$NamePattern
    )

    return @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.GetCommandName() -match $NamePattern -and
                (Test-CommandIsReachablePolicyCode $_)
            } |
            Sort-Object { $_.Extent.StartOffset }
    )
}

function Get-AssignmentMap {
    param([System.Management.Automation.Language.Ast]$Ast)

    $assignments = @{}
    foreach ($assignment in (Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        $name = Get-AssignmentVariableName $assignment
        if ($name) { $assignments[$name] = $assignment }
    }
    return $assignments
}

function Test-ExpressionDependsOnAlias {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [hashtable]$Assignments,
        [string[]]$Aliases
    )

    if (Test-TextHasAlias (Get-StringValues $Expression) $Aliases) { return $true }
    foreach ($variable in (Get-AstNodes $Expression ([System.Management.Automation.Language.VariableExpressionAst]))) {
        $visited = @{}
        if (Test-VariableDependsOnAlias $variable.VariablePath.UserPath $Assignments $Aliases $visited) {
            return $true
        }
    }
    return $false
}

function Test-VariableHistoryDependsOnAlias {
    param(
        [string]$VariableName,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [string[]]$Aliases,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    $visitKey = "$VariableName@$BeforeOffset"
    if ($Visited.ContainsKey($visitKey)) { return $false }
    $Visited[$visitKey] = $true
    foreach ($assignment in @(
        $Assignments | Where-Object {
            (Get-AssignmentVariableName $_) -ieq $VariableName -and
            $_.Extent.StartOffset -lt $BeforeOffset
        } | Sort-Object { $_.Extent.StartOffset } -Descending
    )) {
        if (Test-TextHasAlias (Get-StringValues $assignment.Right) $Aliases) { return $true }
        foreach ($dependency in (Get-AstNodes $assignment.Right ([System.Management.Automation.Language.VariableExpressionAst]))) {
            if (Test-VariableHistoryDependsOnAlias $dependency.VariablePath.UserPath $Assignments $Aliases $assignment.Extent.StartOffset $Visited) {
                return $true
            }
        }
        if ($assignment.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals) {
            break
        }
    }
    return $false
}

function Find-ActualInvocationWithAssignmentHistory {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string[]]$Aliases
    )

    $assignments = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object { Test-AstIsReachablePolicyCode $_ }
    )
    foreach ($command in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Sort-Object { $_.Extent.StartOffset }
    )) {
        if (-not (Test-IsExecutionCommand $command)) { continue }
        if (Test-TextHasAlias (Get-StringValues $command) $Aliases) { return $command }
        foreach ($element in $command.CommandElements) {
            if ($element -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
            $visited = @{}
            if (Test-VariableHistoryDependsOnAlias $element.VariablePath.UserPath $assignments $Aliases $command.Extent.StartOffset $visited) {
                return $command
            }
        }
    }
    return $null
}

function Get-HistoricalInvocationArgumentMap {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Invocation,
        [string[]]$ArgumentNames
    )

    if (-not $Invocation) { return @{} }
    $texts = @($Invocation.Extent.Text)
    $assignments = @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))
    foreach ($element in $Invocation.CommandElements) {
        if ($element -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
        foreach ($assignment in @(
            $assignments | Where-Object {
                (Get-AssignmentVariableName $_) -ieq $element.VariablePath.UserPath -and
                $_.Extent.StartOffset -lt $Invocation.Extent.StartOffset
            } | Sort-Object { $_.Extent.StartOffset } -Descending
        )) {
            $texts += $assignment.Right.Extent.Text
            if ($assignment.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals) {
                break
            }
        }
    }

    $map = @{}
    foreach ($argumentName in $ArgumentNames) {
        $escaped = [regex]::Escape($argumentName)
        foreach ($argumentText in $texts) {
            $arrayPattern = '["'']-{1,2}' + $escaped + '["'']\s*,\s*(?<value>\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)'
            $commandPattern = '(?<![A-Za-z0-9_-])-{1,2}' + $escaped + '(?:=|\s+)(?<value>\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)'
            $argumentMatch = [regex]::Match($argumentText, $arrayPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if (-not $argumentMatch.Success) {
                $argumentMatch = [regex]::Match($argumentText, $commandPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
            }
            if ($argumentMatch.Success) {
                $map[$argumentName] = $argumentMatch.Groups['value'].Value
                break
            }
        }
    }
    return $map
}

function Test-AliasIdentityOptionalFfmpegForwarding {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Invocation
    )

    if (-not $Invocation) { return $false }
    $splatVariables = @(
        $Invocation.CommandElements | Where-Object {
            $_ -is [System.Management.Automation.Language.VariableExpressionAst] -and $_.Splatted
        }
    )
    if ($splatVariables.Count -ne 1) { return $false }
    $argumentVariable = $splatVariables[0].VariablePath.UserPath
    $argumentAssignments = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object {
                (Get-AssignmentVariableName $_) -ieq $argumentVariable -and
                $_.Extent.StartOffset -lt $Invocation.Extent.StartOffset
            } | Sort-Object { $_.Extent.StartOffset }
    )
    $latestPlainAssignment = @(
        $argumentAssignments | Where-Object {
            $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals
        } | Sort-Object { $_.Extent.StartOffset } -Descending
    ) | Select-Object -First 1
    if (-not $latestPlainAssignment) { return $false }

    $matchingAugmentations = @()
    foreach ($assignment in @(
        $argumentAssignments | Where-Object {
            $_.Extent.StartOffset -ge $latestPlainAssignment.Extent.StartOffset
        }
    )) {
        $hasExactSwitch = @(
            Get-StringValues $assignment.Right | Where-Object { $_ -ceq '-AllowMissingFfmpeg' }
        ).Count -gt 0
        if (-not $hasExactSwitch) { continue }
        if ($assignment.Operator -ne [System.Management.Automation.Language.TokenKind]::PlusEquals) {
            return $false
        }
        $matchingAugmentations += $assignment
    }
    if ($matchingAugmentations.Count -ne 1) { return $false }

    $augmentation = $matchingAugmentations[0]
    $ancestor = $augmentation.Parent
    $guard = $null
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.IfStatementAst]) {
            $guard = $ancestor
            break
        }
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst]) { break }
        $ancestor = $ancestor.Parent
    }
    if (-not $guard -or $guard.Clauses.Count -ne 1 -or
        $guard.Clauses[0].Item1.Extent.Text -notmatch '^\s*\$AllowMissingFfmpeg\s*$') {
        return $false
    }
    return $guard.Extent.EndOffset -lt $Invocation.Extent.StartOffset
}

function Test-AliasIdentityHelperPathExact {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Invocation
    )

    if (-not $Invocation) { return $false }
    $splatVariable = @(
        $Invocation.CommandElements | Where-Object {
            $_ -is [System.Management.Automation.Language.VariableExpressionAst] -and $_.Splatted
        }
    ) | Select-Object -First 1
    if (-not $splatVariable) { return $false }
    $argumentVariable = $splatVariable.VariablePath.UserPath
    $latestPlainAssignment = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object {
                (Get-AssignmentVariableName $_) -ieq $argumentVariable -and
                $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals -and
                $_.Extent.StartOffset -lt $Invocation.Extent.StartOffset
            } | Sort-Object { $_.Extent.StartOffset } -Descending
    ) | Select-Object -First 1
    if (-not $latestPlainAssignment) { return $false }
    $pathPattern = '(?is)["'']-File["'']\s*,\s*\(\s*Join-Path\s+\$PSScriptRoot\s+["'']\.\.[\\/]e2e[\\/]release-artifact-alias-identity-regression\.ps1["'']\s*\)'
    return $latestPlainAssignment.Right.Extent.Text -match $pathPattern
}

function Get-SingleCommandAstFromExpression {
    param([System.Management.Automation.Language.Ast]$Expression)

    if (-not $Expression) { return $null }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Get-SingleCommandAstFromExpression $Expression.Expression
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Get-SingleCommandAstFromExpression $Expression.Pipeline
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is [System.Management.Automation.Language.CommandAst]) {
        return $Expression.PipelineElements[0]
    }
    if ($Expression -is [System.Management.Automation.Language.CommandAst]) {
        return $Expression
    }
    return $null
}

function Get-ExpressionSequenceElements {
    param([System.Management.Automation.Language.Ast]$Expression)

    if (-not $Expression) { return @() }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return @(Get-ExpressionSequenceElements $Expression.Expression)
    }
    if ($Expression -is [System.Management.Automation.Language.ArrayLiteralAst]) {
        return @($Expression.Elements)
    }
    if ($Expression -is [System.Management.Automation.Language.ArrayExpressionAst]) {
        $statements = @($Expression.SubExpression.Statements)
        if ($statements.Count -eq 1 -and
            $statements[0] -is [System.Management.Automation.Language.PipelineAst] -and
            $statements[0].PipelineElements.Count -eq 1 -and
            $statements[0].PipelineElements[0] -is
                [System.Management.Automation.Language.CommandExpressionAst]) {
            return @(
                Get-ExpressionSequenceElements `
                    $statements[0].PipelineElements[0].Expression
            )
        }
    }
    return @($Expression)
}

function Get-JoinPathArgumentExpressions {
    param([System.Management.Automation.Language.CommandAst]$Command)

    $path = $null
    $childPath = $null
    $additionalChildPaths = New-Object System.Collections.Generic.List[object]
    $positional = New-Object System.Collections.Generic.List[object]
    for ($index = 1; $index -lt $Command.CommandElements.Count; $index++) {
        $element = $Command.CommandElements[$index]
        if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
            $argument = $element.Argument
            if (-not $argument -and $index + 1 -lt $Command.CommandElements.Count -and
                $Command.CommandElements[$index + 1] -isnot
                    [System.Management.Automation.Language.CommandParameterAst]) {
                $index++
                $argument = $Command.CommandElements[$index]
            }
            if ($element.ParameterName -ieq 'Path') { $path = $argument }
            if ($element.ParameterName -ieq 'ChildPath') { $childPath = $argument }
            if ($element.ParameterName -ieq 'AdditionalChildPath') {
                foreach ($additional in @(Get-ExpressionSequenceElements $argument)) {
                    $additionalChildPaths.Add($additional) | Out-Null
                }
            }
            continue
        }
        $positional.Add($element) | Out-Null
    }
    if (-not $path -and $positional.Count -ge 1) { $path = $positional[0] }
    if (-not $childPath -and $positional.Count -ge 2) { $childPath = $positional[1] }
    if ($positional.Count -gt 2) {
        foreach ($additional in @($positional | Select-Object -Skip 2)) {
            foreach ($element in @(Get-ExpressionSequenceElements $additional)) {
                $additionalChildPaths.Add($element) | Out-Null
            }
        }
    }
    return [pscustomobject]@{
        path = $path
        childPath = $childPath
        additionalChildPaths = $additionalChildPaths.ToArray()
    }
}

function Test-TextNamesReleaseArtifactLeaf {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    $normalized = $Text.Trim().Trim('"', "'") -replace '\\', '/'
    if ($normalized -match '/') { return $false }
    return $normalized -match
        '^(?i:game-capture-(?:(?:\$Version|\$\{Version\}|[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)-)?(?:setup\.exe|portable\.exe|win64\.zip|ffmpeg-source-info\.zip))$'
}

function Test-TextNamesReleaseArtifactBelowDist {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    $normalized = ($Text.Trim().Trim('"', "'") -replace '\\', '/') -replace '/+', '/'
    $match = [regex]::Match(
        $normalized,
        '(?i)(?:^|/)dist/(?<leaf>[^/]+)$'
    )
    return $match.Success -and
        (Test-TextNamesReleaseArtifactLeaf $match.Groups['leaf'].Value)
}

function Resolve-ReleasePathTextTemplate {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $null }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Resolve-ReleasePathTextTemplate `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst] -and
        $Expression.Pipeline.PipelineElements.Count -eq 1 -and
        $Expression.Pipeline.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Resolve-ReleasePathTextTemplate `
            $Expression.Pipeline.PipelineElements[0].Expression `
            $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Resolve-ReleasePathTextTemplate `
            $Expression.PipelineElements[0].Expression `
            $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
        $Expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        return [string]$Expression.Value
    }
    if ($Expression -is [System.Management.Automation.Language.BinaryExpressionAst] -and
        $Expression.Operator -eq [System.Management.Automation.Language.TokenKind]::Plus) {
        $left = Resolve-ReleasePathTextTemplate `
            $Expression.Left $Assignments $BeforeOffset $Visited
        $right = Resolve-ReleasePathTextTemplate `
            $Expression.Right $Assignments $BeforeOffset $Visited
        if ($null -ne $left -and $null -ne $right) {
            return ([string]$left + [string]$right)
        }
        return $null
    }
    if ($Expression -is [System.Management.Automation.Language.BinaryExpressionAst] -and
        $Expression.Operator -eq [System.Management.Automation.Language.TokenKind]::Format) {
        return Resolve-SafeStaticFormatExpression `
            $Expression $Assignments $BeforeOffset $Visited -ReleasePathTemplate
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        if ($name -ieq 'Version') { return '$Version' }
        if ($name -ieq 'distRoot') { return '$distRoot' }
        if ($name -ieq 'PSScriptRoot') { return '$PSScriptRoot' }
        $visitKey = "release-path-template:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $null }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Resolve-ReleasePathTextTemplate `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
    }
    return $null
}

function Test-ExpressionResolvesReleaseScriptRoot {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesReleaseScriptRoot `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Test-ExpressionResolvesReleaseScriptRoot `
            $Expression.Pipeline $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesReleaseScriptRoot `
            $Expression.PipelineElements[0].Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        if ($name -ieq 'PSScriptRoot') { return $true }
        $visitKey = "release-script-root:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionResolvesReleaseScriptRoot `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
    }
    return $false
}

function Test-ExpressionNamesReleaseArtifactLeaf {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionNamesReleaseArtifactLeaf `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Test-ExpressionNamesReleaseArtifactLeaf `
            $Expression.Pipeline $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionNamesReleaseArtifactLeaf `
            $Expression.PipelineElements[0].Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
        $Expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        return Test-TextNamesReleaseArtifactLeaf ([string]$Expression.Value)
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        $visitKey = "release-leaf:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionNamesReleaseArtifactLeaf `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
    }
    $templateValue = Resolve-ReleasePathTextTemplate `
        $Expression $Assignments $BeforeOffset @{}
    return $null -ne $templateValue -and
        (Test-TextNamesReleaseArtifactLeaf ([string]$templateValue))
}

function Test-ExpressionResolvesReleaseDistDirectory {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesReleaseDistDirectory `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Test-ExpressionResolvesReleaseDistDirectory `
            $Expression.Pipeline $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesReleaseDistDirectory `
            $Expression.PipelineElements[0].Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        if ($name -ieq 'distRoot') { return $true }
        $visitKey = "release-dist:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionResolvesReleaseDistDirectory `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
        return $false
    }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
        $Expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        $normalized = (([string]$Expression.Value) -replace '\\', '/').TrimEnd('/')
        return $normalized -match
            '^(?i:\$(?:PSScriptRoot|\{PSScriptRoot\})/\.\./dist)$'
    }

    $command = Get-SingleCommandAstFromExpression $Expression
    if ($command -and [string]$command.GetCommandName() -match
            '^(?i:(?:Microsoft\.PowerShell\.Management\\)?Join-Path)$') {
        $arguments = Get-JoinPathArgumentExpressions $command
        $childValue = Resolve-StaticStringValue `
            $arguments.childPath $Assignments $command.Extent.StartOffset @{}
        return $null -ne $childValue -and
            (([string]$childValue -replace '\\', '/').TrimEnd('/') -match
                '^(?i:\.\./dist)$') -and
            (Test-ExpressionResolvesReleaseScriptRoot `
                $arguments.path $Assignments $command.Extent.StartOffset @{})
    }
    if ($Expression -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
        (Test-ExpressionResolvesSystemIoPathComposition $Expression)) {
        $model = Resolve-ReleasePathSegmentModel `
            $Expression $Assignments $Expression.Extent.StartOffset @{}
        if ($model) {
            $segments = @(Get-NormalizedReleasePathSegments @($model.segments))
            if ([string]$model.root -ceq 'dist' -and $segments.Count -eq 0) {
                return $true
            }
            if ([string]$model.root -ceq 'script' -and
                $segments.Count -eq 2 -and
                $segments[0] -ceq '..' -and
                $segments[1] -ieq 'dist') {
                return $true
            }
        }
    }
    return $false
}

function Test-ExpressionResolvesSystemIoPathComposition {
    param([System.Management.Automation.Language.InvokeMemberExpressionAst]$Invocation)

    if (-not $Invocation -or -not $Invocation.Static -or
        $Invocation.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst] -or
        $Invocation.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return $false
    }
    $owner = [string]$Invocation.Expression.TypeName.FullName
    return $owner -match '^(?i:(?:System\.)?IO\.Path)$' -and
        [string]$Invocation.Member.Value -match '^(?i:Combine|Join)$'
}

function Join-ReleasePathSegmentModels {
    param([object]$Base, [object]$Child)

    if (-not $Base -or -not $Child -or [string]$Child.root -cne 'relative') {
        return $null
    }
    $segments = New-Object System.Collections.Generic.List[string]
    foreach ($segment in @($Base.segments) + @($Child.segments)) {
        $segments.Add([string]$segment) | Out-Null
    }
    return [pscustomobject]@{
        root = [string]$Base.root
        segments = $segments.ToArray()
    }
}

function Resolve-ReleasePathSegmentModel {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $null }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Resolve-ReleasePathSegmentModel `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Resolve-ReleasePathSegmentModel `
            $Expression.Pipeline $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Resolve-ReleasePathSegmentModel `
            $Expression.PipelineElements[0].Expression `
            $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        if ($name -ieq 'PSScriptRoot') {
            return [pscustomobject]@{ root = 'script'; segments = @() }
        }
        if ($name -ieq 'distRoot') {
            return [pscustomobject]@{ root = 'dist'; segments = @() }
        }
        $visitKey = "release-path-model:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $null }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Resolve-ReleasePathSegmentModel `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
        return $null
    }
    $templateValue = Resolve-ReleasePathTextTemplate `
        $Expression $Assignments $BeforeOffset @{}
    if ($null -ne $templateValue) {
        $normalized = [string]$templateValue -replace '\\', '/'
        $root = 'relative'
        if ($normalized -match
            '^(?i:\$(?:PSScriptRoot|\{PSScriptRoot\}))(?:/(?<tail>.*))?$') {
            $root = 'script'
            $normalized = [string]$Matches['tail']
        } elseif ($normalized -match
            '^(?i:\$(?:distRoot|\{distRoot\}))(?:/(?<tail>.*))?$') {
            $root = 'dist'
            $normalized = [string]$Matches['tail']
        } elseif ($normalized -match '^(?:[A-Za-z]:/|/)') {
            return $null
        }
        $segments = @(
            $normalized -split '/' | Where-Object { -not [string]::IsNullOrEmpty($_) }
        )
        return [pscustomobject]@{ root = $root; segments = $segments }
    }

    if ($Expression -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
        (Test-ExpressionResolvesSystemIoPathComposition $Expression)) {
        $combined = $null
        $pathArguments = @(
            foreach ($argument in @($Expression.Arguments)) {
                Get-ExpressionSequenceElements $argument
            }
        )
        foreach ($argument in $pathArguments) {
            $argumentModel = Resolve-ReleasePathSegmentModel `
                $argument $Assignments $Expression.Extent.StartOffset $Visited
            if (-not $argumentModel) { return $null }
            if (-not $combined) {
                $combined = $argumentModel
            } else {
                $combined = Join-ReleasePathSegmentModels $combined $argumentModel
                if (-not $combined) { return $null }
            }
        }
        return $combined
    }

    $command = Get-SingleCommandAstFromExpression $Expression
    if ($command -and [string]$command.GetCommandName() -match
            '^(?i:(?:Microsoft\.PowerShell\.Management\\)?Join-Path)$') {
        $arguments = Get-JoinPathArgumentExpressions $command
        $baseModel = Resolve-ReleasePathSegmentModel `
            $arguments.path $Assignments $command.Extent.StartOffset $Visited
        $childModel = Resolve-ReleasePathSegmentModel `
            $arguments.childPath $Assignments $command.Extent.StartOffset $Visited
        $combined = Join-ReleasePathSegmentModels $baseModel $childModel
        foreach ($additionalChildPath in @($arguments.additionalChildPaths)) {
            $additionalModel = Resolve-ReleasePathSegmentModel `
                $additionalChildPath $Assignments $command.Extent.StartOffset $Visited
            $combined = Join-ReleasePathSegmentModels $combined $additionalModel
            if (-not $combined) { return $null }
        }
        return $combined
    }
    return $null
}

function Get-NormalizedReleasePathSegments {
    param([string[]]$Segments)

    $normalized = New-Object System.Collections.Generic.List[string]
    foreach ($segment in $Segments) {
        if ([string]$segment -eq '.' -or [string]::IsNullOrEmpty([string]$segment)) {
            continue
        }
        if ([string]$segment -eq '..') {
            if ($normalized.Count -gt 0 -and $normalized[$normalized.Count - 1] -ne '..') {
                $normalized.RemoveAt($normalized.Count - 1)
            } else {
                $normalized.Add('..') | Out-Null
            }
            continue
        }
        $normalized.Add([string]$segment) | Out-Null
    }
    return $normalized.ToArray()
}

function Test-ReleasePathSegmentModelNamesArtifact {
    param([object]$Model)

    if (-not $Model) { return $false }
    $segments = @(Get-NormalizedReleasePathSegments @($Model.segments))
    if ([string]$Model.root -ceq 'dist') {
        return $segments.Count -eq 1 -and
            (Test-TextNamesReleaseArtifactLeaf $segments[0])
    }
    return [string]$Model.root -ceq 'script' -and
        $segments.Count -eq 3 -and
        $segments[0] -ceq '..' -and
        $segments[1] -ieq 'dist' -and
        (Test-TextNamesReleaseArtifactLeaf $segments[2])
}

function Test-ExpressionResolvesReleaseArtifactPath {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [string[]]$ArtifactVariables,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesReleaseArtifactPath `
            $Expression.Expression $Assignments $BeforeOffset $ArtifactVariables $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Test-ExpressionResolvesReleaseArtifactPath `
            $Expression.Pipeline $Assignments $BeforeOffset $ArtifactVariables $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesReleaseArtifactPath `
            $Expression.PipelineElements[0].Expression `
            $Assignments $BeforeOffset $ArtifactVariables $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        if ($name -iin $ArtifactVariables) { return $true }
        $visitKey = "release-artifact:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionResolvesReleaseArtifactPath `
                $definition.Right $Assignments $definition.Extent.StartOffset `
                $ArtifactVariables $Visited
        }
        return $false
    }
    if ($Expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        $template = ([string]$Expression.Value -replace '\\', '/')
        if ($template -match '^(?i:\$(?:\{?distRoot\}?)/)(?<leaf>[^/]+)$') {
            return Test-TextNamesReleaseArtifactLeaf $Matches['leaf']
        }
    }

    $pathModel = Resolve-ReleasePathSegmentModel `
        $Expression $Assignments $BeforeOffset @{}
    if (Test-ReleasePathSegmentModelNamesArtifact $pathModel) { return $true }

    $command = Get-SingleCommandAstFromExpression $Expression
    if ($command -and [string]$command.GetCommandName() -match
            '^(?i:(?:Microsoft\.PowerShell\.Management\\)?Join-Path)$') {
        $arguments = Get-JoinPathArgumentExpressions $command
        if ((Test-ExpressionResolvesReleaseDistDirectory `
                $arguments.path $Assignments $command.Extent.StartOffset @{}) -and
            (Test-ExpressionNamesReleaseArtifactLeaf `
                $arguments.childPath $Assignments $command.Extent.StartOffset @{})) {
            return $true
        }
        $childValue = if ($arguments.childPath -is
                [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $arguments.childPath -is
                [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
            [string]$arguments.childPath.Value
        } else {
            Resolve-StaticStringValue `
                $arguments.childPath $Assignments $command.Extent.StartOffset @{}
        }
        if ($null -ne $childValue -and
            (Test-TextNamesReleaseArtifactBelowDist ([string]$childValue)) -and
            (Test-ExpressionResolvesReleaseScriptRoot `
                $arguments.path $Assignments $command.Extent.StartOffset @{})) {
            return $true
        }
    }

    if ($Expression -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
        (Test-ExpressionResolvesSystemIoPathComposition $Expression)) {
        $arguments = @(
            foreach ($argument in @($Expression.Arguments)) {
                Get-ExpressionSequenceElements $argument
            }
        )
        for ($index = 0; $index + 1 -lt $arguments.Count; $index++) {
            if ((Test-ExpressionResolvesReleaseDistDirectory `
                    $arguments[$index] $Assignments $Expression.Extent.StartOffset @{}) -and
                (Test-ExpressionNamesReleaseArtifactLeaf `
                    $arguments[$index + 1] $Assignments $Expression.Extent.StartOffset @{})) {
                return $true
            }
        }
        if ($arguments.Count -ge 2) {
            $tail = $arguments[-1]
            $tailValue = if ($tail -is
                    [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $tail -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
                [string]$tail.Value
            } else {
                Resolve-StaticStringValue `
                    $tail $Assignments $Expression.Extent.StartOffset @{}
            }
            if ($null -ne $tailValue -and
                (Test-TextNamesReleaseArtifactBelowDist ([string]$tailValue)) -and
                (Test-ExpressionResolvesReleaseScriptRoot `
                    $arguments[0] $Assignments $Expression.Extent.StartOffset @{})) {
                return $true
            }
        }
    }
    return $false
}

function Test-ExpressionResolvesSystemIoFileType {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesSystemIoFileType `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Test-ExpressionResolvesSystemIoFileType `
            $Expression.Pipeline $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionResolvesSystemIoFileType `
            $Expression.PipelineElements[0].Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.TypeExpressionAst]) {
        return [string]$Expression.TypeName.FullName -match
            '^(?i:(?:System\.)?IO\.File|File)$'
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        $visitKey = "system-io-file:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionResolvesSystemIoFileType `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
    }
    return $false
}

function Test-ExpressionIsReadOnlyFileAccess {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionIsReadOnlyFileAccess `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Test-ExpressionIsReadOnlyFileAccess `
            $Expression.Pipeline $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionIsReadOnlyFileAccess `
            $Expression.PipelineElements[0].Expression $Assignments $BeforeOffset $Visited
    }
    if ((Get-CompactAstText $Expression) -match
        '^\[(?i:(?:System\.)?IO\.FileAccess)\]::Read$') {
        return $true
    }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        [string]$Expression.Value -ieq 'Read') {
        return $true
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        $visitKey = "file-access:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionIsReadOnlyFileAccess `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
    }
    return $false
}

function Test-ExpressionIsReadOnlyFileMode {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $false }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionIsReadOnlyFileMode `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Test-ExpressionIsReadOnlyFileMode `
            $Expression.Pipeline $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst] -and
        $Expression.PipelineElements.Count -eq 1 -and
        $Expression.PipelineElements[0] -is
            [System.Management.Automation.Language.CommandExpressionAst]) {
        return Test-ExpressionIsReadOnlyFileMode `
            $Expression.PipelineElements[0].Expression $Assignments $BeforeOffset $Visited
    }
    if ((Get-CompactAstText $Expression) -match
        '^\[(?i:(?:System\.)?IO\.FileMode)\]::Open$') {
        return $true
    }
    if ($Expression -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        [string]$Expression.Value -ieq 'Open') {
        return $true
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        $visitKey = "file-mode:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $false }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Test-ExpressionIsReadOnlyFileMode `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
    }
    return $false
}

function Get-SystemIoFileWritablePathArgumentIndexes {
    param(
        [string]$MemberName,
        [System.Management.Automation.Language.InvokeMemberExpressionAst]$Invocation,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments
    )

    if ($MemberName -match
        '^(?i:AppendAllLines|AppendAllText|Create|CreateText|Decrypt|Delete|Encrypt|OpenWrite|SetAccessControl|SetAttributes|SetCreationTime|SetCreationTimeUtc|SetLastAccessTime|SetLastAccessTimeUtc|SetLastWriteTime|SetLastWriteTimeUtc|WriteAllBytes|WriteAllLines|WriteAllText)$') {
        return @(0)
    }
    if ($MemberName -ieq 'Copy') { return @(1) }
    if ($MemberName -ieq 'Move') { return @(0, 1) }
    if ($MemberName -ieq 'Replace') { return @(0, 1, 2) }
    if ($MemberName -ieq 'Open' -or $MemberName -ieq 'OpenHandle') {
        if (@($Invocation.Arguments).Count -ge 3 -and
            (Test-ExpressionIsReadOnlyFileMode `
                $Invocation.Arguments[1] $Assignments $Invocation.Extent.StartOffset @{}) -and
            (Test-ExpressionIsReadOnlyFileAccess `
                $Invocation.Arguments[2] $Assignments $Invocation.Extent.StartOffset @{})) {
            return @()
        }
        return @(0)
    }
    return @()
}

function Get-CommandPositionalArgumentAsts {
    param([System.Management.Automation.Language.CommandAst]$Command)

    $switchParameters = @(
        'Append', 'AsByteStream', 'Confirm', 'Container', 'Force', 'NoClobber',
        'NoNewline', 'PassThru', 'Recurse', 'UseTransaction', 'WhatIf'
    )
    $arguments = New-Object System.Collections.Generic.List[object]
    for ($index = 1; $index -lt $Command.CommandElements.Count; $index++) {
        $element = $Command.CommandElements[$index]
        if ($element -isnot [System.Management.Automation.Language.CommandParameterAst]) {
            $arguments.Add($element) | Out-Null
            continue
        }
        if ($element.Argument -or $element.ParameterName -iin $switchParameters) {
            continue
        }
        if ($index + 1 -lt $Command.CommandElements.Count -and
            $Command.CommandElements[$index + 1] -isnot
                [System.Management.Automation.Language.CommandParameterAst]) {
            $index++
        }
    }
    return $arguments.ToArray()
}

function Get-CanonicalReleaseWriterCommandName {
    param([string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
    $unqualified = $Name -replace '^.*\\', ''
    if ($unqualified -ieq 'sc') { return 'Set-Content' }
    if ($unqualified -match
        '^(?i:Set-Content|Add-Content|Clear-Content|Remove-Item|Set-Item|New-Item|Set-Acl|Unblock-File|Set-AuthenticodeSignature|Sign-File|Out-File|Tee-Object|Copy-Item|Move-Item|Rename-Item)$') {
        return [string]$Matches[0]
    }
    return $null
}

function Resolve-ReleaseWriterCommandName {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [System.Management.Automation.Language.CommandAst[]]$Commands
    )

    $rawName = [string]$Command.GetCommandName()
    if ([string]::IsNullOrWhiteSpace($rawName) -and
        $Command.InvocationOperator -eq
            [System.Management.Automation.Language.TokenKind]::Ampersand -and
        $Command.CommandElements.Count -gt 0) {
        $rawName = Resolve-StaticStringValue `
            $Command.CommandElements[0] $Assignments $Command.Extent.StartOffset @{}
    }
    if ([string]::IsNullOrWhiteSpace([string]$rawName)) { return $null }
    $unqualified = [string]$rawName -replace '^.*\\', ''

    $aliasState = @(
        $Commands | Where-Object {
            $_.Extent.StartOffset -lt $Command.Extent.StartOffset -and
            [string]$_.GetCommandName() -match
                '^(?i:(?:Microsoft\.PowerShell\.Utility\\)?(?:Set|New|Remove)-Alias)$'
        } | Sort-Object { $_.Extent.StartOffset } -Descending | ForEach-Object {
            $aliasCommand = $_
            $nameArguments = @(Get-CommandParameterArgumentAsts $aliasCommand @('Name'))
            $positional = @(Get-CommandPositionalArgumentAsts $aliasCommand)
            if ($nameArguments.Count -eq 0 -and $positional.Count -gt 0) {
                $nameArguments = @($positional[0])
            }
            $aliasName = if ($nameArguments.Count -eq 1) {
                Resolve-StaticStringValue `
                    $nameArguments[0] $Assignments $aliasCommand.Extent.StartOffset @{}
            } else {
                $null
            }
            if ([string]$aliasName -ieq $unqualified) { $aliasCommand }
        }
    ) | Select-Object -First 1
    if ($aliasState) {
        if ([string]$aliasState.GetCommandName() -match '(?i)(?:^|\\)Remove-Alias$') {
            return $null
        }
        $valueArguments = @(Get-CommandParameterArgumentAsts $aliasState @('Value'))
        $positional = @(Get-CommandPositionalArgumentAsts $aliasState)
        if ($valueArguments.Count -eq 0 -and $positional.Count -gt 1) {
            $valueArguments = @($positional[1])
        }
        if ($valueArguments.Count -ne 1) { return $null }
        $aliasValue = Resolve-StaticStringValue `
            $valueArguments[0] $Assignments $aliasState.Extent.StartOffset @{}
        return Get-CanonicalReleaseWriterCommandName ([string]$aliasValue)
    }
    return Get-CanonicalReleaseWriterCommandName $unqualified
}

function Get-CommandWritablePathExpressions {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string]$ResolvedName
    )

    $name = [string]$ResolvedName -replace '^.*\\', ''
    $paths = New-Object System.Collections.Generic.List[object]
    $parameterNames = @()
    $positionalIndexes = @()
    if ($name -match '^(?i:Set-Content|Add-Content|Clear-Content|Remove-Item|Set-Item|New-Item|Set-Acl|Unblock-File|Set-AuthenticodeSignature|Sign-File)$') {
        $parameterNames = @('Path', 'LiteralPath', 'FilePath')
        $positionalIndexes = @(0)
    } elseif ($name -match '^(?i:Out-File|Tee-Object)$') {
        $parameterNames = @('FilePath')
        $positionalIndexes = @(0)
    } elseif ($name -ieq 'Copy-Item') {
        $parameterNames = @('Destination')
        $positionalIndexes = @(1)
    } elseif ($name -match '^(?i:Move-Item|Rename-Item)$') {
        $parameterNames = @('Path', 'LiteralPath', 'Destination', 'NewName')
        $positionalIndexes = @(0, 1)
    } else {
        return @()
    }

    foreach ($path in @(Get-CommandParameterArgumentAsts $Command $parameterNames)) {
        $paths.Add($path) | Out-Null
    }
    $positional = @(Get-CommandPositionalArgumentAsts $Command)
    foreach ($index in $positionalIndexes) {
        if ($index -lt $positional.Count) { $paths.Add($positional[$index]) | Out-Null }
    }
    return @(
        $paths | Sort-Object { $_.Extent.StartOffset } -Unique
    )
}

function Get-SystemIoFileInfoPathExpression {
    param(
        [System.Management.Automation.Language.Ast]$Expression,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments,
        [int]$BeforeOffset,
        [hashtable]$Visited
    )

    if (-not $Expression) { return $null }
    if ($Expression -is [System.Management.Automation.Language.CommandExpressionAst]) {
        return Get-SystemIoFileInfoPathExpression `
            $Expression.Expression $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.ParenExpressionAst]) {
        return Get-SystemIoFileInfoPathExpression `
            $Expression.Pipeline $Assignments $BeforeOffset $Visited
    }
    if ($Expression -is [System.Management.Automation.Language.PipelineAst]) {
        if ($Expression.PipelineElements.Count -eq 1 -and
            $Expression.PipelineElements[0] -is
                [System.Management.Automation.Language.CommandExpressionAst]) {
            return Get-SystemIoFileInfoPathExpression `
                $Expression.PipelineElements[0].Expression `
                $Assignments $BeforeOffset $Visited
        }
        $last = @($Expression.PipelineElements) | Select-Object -Last 1
        if ($last -is [System.Management.Automation.Language.CommandAst] -and
            [string]$last.GetCommandName() -match
                '^(?i:(?:Microsoft\.PowerShell\.Management\\)?Get-Item)$') {
            if ($Expression.PipelineElements.Count -eq 2 -and
                $Expression.PipelineElements[0] -is
                    [System.Management.Automation.Language.CommandExpressionAst]) {
                return $Expression.PipelineElements[0].Expression
            }
            $paths = @(Get-CommandParameterArgumentAsts $last @('Path', 'LiteralPath'))
            if ($paths.Count -eq 0) {
                $paths = @(Get-CommandPositionalArgumentAsts $last)
            }
            if ($paths.Count -eq 1) { return $paths[0] }
        }
        return $null
    }
    if ($Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
        -not $Expression.Splatted) {
        $name = Get-UnscopedVariableName $Expression.VariablePath.UserPath
        $visitKey = "system-io-fileinfo:$name@$BeforeOffset"
        if ($Visited.ContainsKey($visitKey)) { return $null }
        $Visited[$visitKey] = $true
        $definition = Get-LatestAssignmentBeforeOffset $Assignments $name $BeforeOffset
        if ($definition) {
            return Get-SystemIoFileInfoPathExpression `
                $definition.Right $Assignments $definition.Extent.StartOffset $Visited
        }
        return $null
    }
    if ($Expression -isnot [System.Management.Automation.Language.InvokeMemberExpressionAst] -or
        -not $Expression.Static -or
        $Expression.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst] -or
        $Expression.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
        [string]$Expression.Expression.TypeName.FullName -notmatch
            '^(?i:(?:System\.)?IO\.FileInfo)$' -or
        [string]$Expression.Member.Value -ine 'new' -or
        @($Expression.Arguments).Count -lt 1) {
        return $null
    }
    return $Expression.Arguments[0]
}

function Test-SystemIoFileInfoMemberIsWritable {
    param(
        [string]$MemberName,
        [System.Management.Automation.Language.InvokeMemberExpressionAst]$Invocation,
        [System.Management.Automation.Language.AssignmentStatementAst[]]$Assignments
    )

    if ($MemberName -match '^(?i:Create|CreateText|Delete|MoveTo|OpenWrite|Replace)$') {
        return $true
    }
    if ($MemberName -ine 'Open') { return $false }
    if (@($Invocation.Arguments).Count -ge 2 -and
        (Test-ExpressionIsReadOnlyFileMode `
            $Invocation.Arguments[0] $Assignments $Invocation.Extent.StartOffset @{}) -and
        (Test-ExpressionIsReadOnlyFileAccess `
            $Invocation.Arguments[1] $Assignments $Invocation.Extent.StartOffset @{})) {
        return $false
    }
    return $true
}

function Test-NoReleaseArtifactMutationAfterIdentityGuard {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$IdentityInvocation,
        [string[]]$ArtifactVariables
    )

    # Gate existence/identity is owned by RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING.
    # This check is intentionally non-overlapping and evaluates only a present real gate.
    if (-not $IdentityInvocation) { return $true }
    $assignments = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object { Test-AstIsReachablePolicyCode $_ }
    )
    $commands = @(Get-ReachableCommandsByName $Ast '.*')
    foreach ($command in $commands) {
        if ($command.Extent.StartOffset -le $IdentityInvocation.Extent.EndOffset) { continue }
        $resolvedWriterName = Resolve-ReleaseWriterCommandName `
            $command $assignments $commands
        foreach ($pathExpression in @(
            Get-CommandWritablePathExpressions $command $resolvedWriterName
        )) {
            if (Test-ExpressionResolvesReleaseArtifactPath `
                $pathExpression $assignments $command.Extent.StartOffset `
                $ArtifactVariables @{}) {
                return $false
            }
        }
        $texts = @($command.Extent.Text)
        if ($command.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -or
            $command.GetCommandName() -match '^(?i:powershell(?:\.exe)?|pwsh(?:\.exe)?)$') {
            $texts += Get-InvocationArgumentTexts $Ast $command
        }
        $combined = $texts -join "`n"
        $referencesArtifact = $combined -match '(?i)\$distRoot\b'
        foreach ($artifactVariable in $ArtifactVariables) {
            if ($combined -match ('(?i)\$' + [regex]::Escape($artifactVariable) + '\b')) {
                $referencesArtifact = $true
                break
            }
        }
        $localMutation = [string]$resolvedWriterName -match '^(?i:Copy-Item|Move-Item|Rename-Item|Set-Item|Set-Content|Add-Content|Clear-Content|Remove-Item|Out-File|Sign-File)$'
        $signingInvocation = $combined -match '(?i)sign-artifacts\.ps1'
        if (($localMutation -and $referencesArtifact) -or $signingInvocation) {
            return $false
        }
    }
    foreach ($redirection in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.FileRedirectionAst]) |
            Sort-Object { $_.Extent.StartOffset }
    )) {
        if ($redirection.Extent.StartOffset -le $IdentityInvocation.Extent.EndOffset -or
            -not (Test-AstIsReachablePolicyCode $redirection)) {
            continue
        }
        if (Test-ExpressionResolvesReleaseArtifactPath `
            $redirection.Location $assignments $redirection.Extent.StartOffset `
            $ArtifactVariables @{}) {
            return $false
        }
    }
    foreach ($invocation in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst]) |
            Sort-Object { $_.Extent.StartOffset }
    )) {
        if ($invocation.Extent.StartOffset -le $IdentityInvocation.Extent.EndOffset -or
            -not (Test-AstIsReachablePolicyCode $invocation)) {
            continue
        }
        $memberName = if ($invocation.Member -is
                [System.Management.Automation.Language.StringConstantExpressionAst]) {
            [string]$invocation.Member.Value
        } else {
            Resolve-StaticStringValue `
                $invocation.Member $assignments $invocation.Extent.StartOffset @{}
        }
        if ([string]::IsNullOrWhiteSpace([string]$memberName)) { continue }
        $fileInfoPath = Get-SystemIoFileInfoPathExpression `
            $invocation.Expression $assignments $invocation.Extent.StartOffset @{}
        if ($fileInfoPath -and
            (Test-SystemIoFileInfoMemberIsWritable `
                ([string]$memberName) $invocation $assignments) -and
            (Test-ExpressionResolvesReleaseArtifactPath `
                $fileInfoPath $assignments `
                $invocation.Extent.StartOffset $ArtifactVariables @{})) {
            return $false
        }
        if ($invocation.Static -and
            $invocation.Expression -is
                [System.Management.Automation.Language.TypeExpressionAst] -and
            [string]$invocation.Expression.TypeName.FullName -match
                '^(?i:(?:System\.)?IO\.FileStream)$' -and
            [string]$memberName -ieq 'new' -and
            @($invocation.Arguments).Count -gt 0 -and
            (Test-ExpressionResolvesReleaseArtifactPath `
                $invocation.Arguments[0] $assignments `
                $invocation.Extent.StartOffset $ArtifactVariables @{})) {
            return $false
        }
        if (-not (Test-ExpressionResolvesSystemIoFileType `
            $invocation.Expression $assignments $invocation.Extent.StartOffset @{})) {
            continue
        }
        foreach ($argumentIndex in @(
            Get-SystemIoFileWritablePathArgumentIndexes `
                ([string]$memberName) $invocation $assignments
        )) {
            if ($argumentIndex -ge @($invocation.Arguments).Count) { continue }
            if (Test-ExpressionResolvesReleaseArtifactPath `
                $invocation.Arguments[$argumentIndex] $assignments `
                $invocation.Extent.StartOffset $ArtifactVariables @{}) {
                return $false
            }
        }
    }
    return $true
}

function Get-HistoricalInvocationArgumentTexts {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Invocation
    )

    if (-not $Invocation) { return @() }
    $texts = @($Invocation.Extent.Text)
    $assignments = @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))
    foreach ($element in $Invocation.CommandElements) {
        if ($element -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
        foreach ($assignment in @(
            $assignments | Where-Object {
                (Get-AssignmentVariableName $_) -ieq $element.VariablePath.UserPath -and
                $_.Extent.StartOffset -lt $Invocation.Extent.StartOffset
            } | Sort-Object { $_.Extent.StartOffset } -Descending
        )) {
            $texts += $assignment.Right.Extent.Text
            if ($assignment.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals) {
                break
            }
        }
    }
    return @($texts)
}

function Test-ExactSignArtifactsInvocation {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst]$Invocation
    )

    if (-not $Invocation -or
        $Invocation.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Ampersand -or
        $Invocation.CommandElements.Count -lt 1) {
        return $false
    }
    $target = $Invocation.CommandElements[0]
    if ($target -isnot [System.Management.Automation.Language.VariableExpressionAst] -or $target.Splatted) {
        return $false
    }
    $targetName = $target.VariablePath.UserPath
    $targetAssignment = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object {
                (Get-AssignmentVariableName $_) -ieq $targetName -and
                $_.Extent.StartOffset -lt $Invocation.Extent.StartOffset -and
                (Test-AstIsReachablePolicyCode $_)
            } | Sort-Object { $_.Extent.StartOffset } -Descending
    ) | Select-Object -First 1
    if (-not $targetAssignment -or
        $targetAssignment.Operator -ne [System.Management.Automation.Language.TokenKind]::Equals) {
        return $false
    }
    return $targetAssignment.Right.Extent.Text -match '(?is)^\s*Join-Path\s+\$PSScriptRoot\s+["'']sign-artifacts\.ps1["'']\s*$'
}

function Get-BuildReleaseExeSignInvocations {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $commandsFound = @()
    foreach ($command in (Get-ReachableCommandsByName $Ast '.*')) {
        if (-not (Test-ExactSignArtifactsInvocation $Ast $command)) { continue }
        $texts = (Get-HistoricalInvocationArgumentTexts $Ast $command) -join "`n"
        $hasCanonicalFilePaths = $command.Extent.Text -match '(?i)(?:^|[\s,''"`])-FilePaths(?:$|[\s,''"`])' -and
            $texts -match '(?i)portableVersionedPath' -and
            $texts -match '(?i)installerVersionedPath' -and
            $texts -notmatch '(?i)portableStablePath|installerStablePath'
        if ($hasCanonicalFilePaths) {
            $commandsFound += $command
        }
    }
    return @($commandsFound)
}

function Get-CopyCommandsToVariable {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$DestinationVariable
    )

    $destinationPattern = '(?i)-Destination\s+\$' + [regex]::Escape($DestinationVariable) + '\b'
    return @(
        Get-ReachableCommandsByName $Ast '^(?i:Copy-Item)$' |
            Where-Object { $_.Extent.Text -match $destinationPattern }
    )
}

function Test-ExactAliasCopySource {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string]$SourceVariable
    )

    if (-not $Command) { return $false }
    $sourcePattern = '(?i)-(?:Literal)?Path\s+\$' + [regex]::Escape($SourceVariable) + '\b'
    return $Command.Extent.Text -match $sourcePattern
}

function Test-NoBuildAliasMutationAfterCopy {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.CommandAst[]]$Copies,
        [string[]]$StableVariables,
        [string[]]$CanonicalVariables
    )

    if (@($Copies).Count -ne $StableVariables.Count -or
        $StableVariables.Count -ne $CanonicalVariables.Count) { return $false }
    for ($index = 0; $index -lt $Copies.Count; $index++) {
        $copy = $Copies[$index]
        $protectedVariables = @($StableVariables[$index], $CanonicalVariables[$index])
        foreach ($command in (Get-ReachableCommandsByName $Ast '.*')) {
            if ($command.Extent.StartOffset -le $copy.Extent.EndOffset) { continue }
            $text = $command.Extent.Text
            $referencesProtectedArtifact = $false
            foreach ($protectedVariable in $protectedVariables) {
                if ($text -match ('(?i)\$' + [regex]::Escape($protectedVariable) + '\b')) {
                    $referencesProtectedArtifact = $true
                    break
                }
            }
            if ($referencesProtectedArtifact -and $command.GetCommandName() -match '^(?i:Copy-Item|Move-Item|Rename-Item|Set-Content|Add-Content|Clear-Content|Remove-Item|Sign-File)$') {
                return $false
            }
            if ($command.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand) {
                $texts = (Get-InvocationArgumentTexts $Ast $command) -join "`n"
                $referencesProtectedInvocation = $referencesProtectedArtifact
                foreach ($protectedVariable in $protectedVariables) {
                    if ($texts -match ('(?i)\$' + [regex]::Escape($protectedVariable) + '\b')) {
                        $referencesProtectedInvocation = $true
                        break
                    }
                }
                $broadSignDist = $texts -match '(?i)sign-artifacts\.ps1' -and
                    $texts -match '(?i)(?:^|[\s,''"`])-DistDir(?:$|[\s,''"`])'
                if ($referencesProtectedInvocation -or $broadSignDist) {
                    return $false
                }
            }
        }
    }
    return $true
}

function Test-SignDistRequiresVersion {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $versionParameter = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ParameterAst]) |
            Where-Object { $_.Name.VariablePath.UserPath -ieq 'Version' }
    ) | Select-Object -First 1
    if (-not $versionParameter) { return $false }
    $numericSemverValidation = @(
        $versionParameter.Attributes | Where-Object {
            $_ -is [System.Management.Automation.Language.AttributeAst] -and
            $_.TypeName.Name -ieq 'ValidatePattern' -and
            $_.PositionalArguments.Count -eq 1 -and
            [string]$_.PositionalArguments[0].Value -ceq '^\d+\.\d+\.\d+$'
        }
    ).Count -eq 1
    if (-not $numericSemverValidation) { return $false }

    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        $condition = $ifAst.Clauses[0].Item1
        $body = $ifAst.Clauses[0].Item2
        $variables = @(
            Get-AstNodes $condition ([System.Management.Automation.Language.VariableExpressionAst]) |
                ForEach-Object { $_.VariablePath.UserPath }
        )
        if ('DistDir' -iin $variables -and 'Version' -iin $variables -and
            $condition.Extent.Text -match '(?i)IsNullOrWhiteSpace\s*\(\s*\$Version\s*\)' -and
            @((Get-AstNodes $body ([System.Management.Automation.Language.ThrowStatementAst]))).Count -gt 0) {
            return $true
        }
    }
    return $false
}

function Test-SignDistSelectsVersionedExesOnly {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $assignments = Get-AssignmentMap $Ast
    $selections = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object {
                (Get-AssignmentVariableName $_) -ieq 'allExes' -and
                (Test-ExpressionDependsOnAlias $_.Right $assignments @('game-capture-$Version-setup.exe')) -and
                (Test-ExpressionDependsOnAlias $_.Right $assignments @('game-capture-$Version-portable.exe'))
            }
    )
    if ($selections.Count -ne 1) { return $false }
    $selection = $selections[0]

    if (Test-ExpressionDependsOnAlias $selection.Right $assignments @(
        'game-capture-setup.exe',
        'game-capture-portable.exe'
    )) {
        return $false
    }
    if ($selection.Right.Extent.Text -match '(?i)Get-ChildItem|Where-Object|-[A-Za-z]*like\b|\*\.exe') {
        return $false
    }
    $getItems = @(
        Get-AstNodes $selection.Right ([System.Management.Automation.Language.CommandAst]) |
            Where-Object { $_.GetCommandName() -ieq 'Get-Item' }
    )
    if ($getItems.Count -ne 2) { return $false }
    foreach ($canonicalName in @(
        'game-capture-$Version-setup.exe',
        'game-capture-$Version-portable.exe'
    )) {
        $canonicalGetItems = @(
            $getItems | Where-Object {
                $_.Extent.Text -match '(?i)-LiteralPath\b' -and
                (Test-ExpressionDependsOnAlias $_ $assignments @($canonicalName))
            }
        )
        if ($canonicalGetItems.Count -ne 1) { return $false }
    }

    $signCommands = @(Get-ReachableCommandsByName $Ast '^(?i:Sign-File)$')
    if ($signCommands.Count -ne 1 -or $signCommands[0].Extent.Text -notmatch '(?i)\$file\.FullName\b') {
        return $false
    }
    return $true
}

function Test-ExactNegativeLiteralLeafThrowGuard {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$TargetVariable,
        [int]$AfterOffset,
        [int]$BeforeOffset,
        [System.Management.Automation.Language.Ast]$Scope
    )

    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        if ($ifAst.Extent.StartOffset -le $AfterOffset -or
            $ifAst.Extent.EndOffset -ge $BeforeOffset -or
            ($Scope -and -not (Test-AstExtentContains $Scope $ifAst)) -or
            -not (Test-AstIsReachablePolicyCode $ifAst)) {
            continue
        }
        foreach ($clause in $ifAst.Clauses) {
            $testPaths = @(
                Get-AstNodes $clause.Item1 ([System.Management.Automation.Language.CommandAst]) |
                    Where-Object { $_.GetCommandName() -ieq 'Test-Path' }
            )
            if ($testPaths.Count -ne 1) { continue }
            $testPath = $testPaths[0]
            if ($testPath.Extent.Text -notmatch '(?i)-LiteralPath\b' -or
                $testPath.Extent.Text -notmatch '(?i)-PathType\s+Leaf\b' -or
                $testPath.Extent.Text -notmatch ('(?i)\$' + [regex]::Escape($TargetVariable) + '\b')) {
                continue
            }
            $conditionText = $clause.Item1.Extent.Text -replace '\s+', ''
            $commandText = $testPath.Extent.Text -replace '\s+', ''
            if ($conditionText -inotmatch ('^(?:-not|!)\(?' + [regex]::Escape($commandText) + '\)?$')) {
                continue
            }
            $directThrows = @($clause.Item2.Statements | Where-Object {
                $_ -is [System.Management.Automation.Language.ThrowStatementAst]
            })
            if ($directThrows.Count -gt 0) { return $true }
        }
    }
    return $false
}

function Test-SignInputsLiteralLeafOnly {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $assignments = Get-AssignmentMap $Ast
    foreach ($targetVariable in @('versionedSetupPath', 'versionedPortablePath')) {
        if (-not $assignments.ContainsKey($targetVariable)) { continue }
        $getItem = @(
            Get-ReachableCommandsByName $Ast '^(?i:Get-Item)$' | Where-Object {
                $_.Extent.Text -match '(?i)-LiteralPath\b' -and
                $_.Extent.Text -match ('(?i)\$' + [regex]::Escape($targetVariable) + '\b')
            }
        ) | Select-Object -First 1
        # Exact DistDir selection existence is owned by SIGN_DIST_VERSIONED_EXES_ONLY.
        if (-not $getItem) { continue }
        if (-not (Test-ExactNegativeLiteralLeafThrowGuard $Ast $targetVariable `
            $assignments[$targetVariable].Extent.EndOffset $getItem.Extent.StartOffset $null)) {
            return $false
        }
    }

    $filePathsLoop = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ForEachStatementAst]) |
            Where-Object {
                $_.Variable.VariablePath.UserPath -ieq 'path' -and
                $_.Condition.Extent.Text -match '(?i)\$FilePaths\b' -and
                (Test-AstIsReachablePolicyCode $_)
            }
    ) | Select-Object -First 1
    if (-not $filePathsLoop) { return $false }
    $resolvePath = @(
        Get-AstNodes $filePathsLoop.Body ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.GetCommandName() -ieq 'Resolve-Path' -and
                $_.Extent.Text -match '(?i)-LiteralPath\b' -and
                $_.Extent.Text -match '(?i)\$path\b'
            }
    ) | Select-Object -First 1
    $getResolvedItem = @(
        Get-AstNodes $filePathsLoop.Body ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.GetCommandName() -ieq 'Get-Item' -and
                $_.Extent.Text -match '(?i)-LiteralPath\b' -and
                $_.Extent.Text -match '(?i)\$resolved\b'
            }
    ) | Select-Object -First 1
    if (-not $resolvePath -or -not $getResolvedItem -or
        $getResolvedItem.Extent.StartOffset -le $resolvePath.Extent.EndOffset) {
        return $false
    }
    return Test-ExactNegativeLiteralLeafThrowGuard $Ast 'path' `
        $filePathsLoop.Body.Extent.StartOffset $resolvePath.Extent.StartOffset $filePathsLoop.Body
}

function Test-CommandWithinPositiveDistDirGuard {
    param([System.Management.Automation.Language.CommandAst]$Command)

    $positiveGuard = $false
    $ancestor = $Command.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
            $ancestor -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
            return $false
        }
        if ($ancestor -is [System.Management.Automation.Language.IfStatementAst]) {
            foreach ($clause in $ancestor.Clauses) {
                $condition = $clause.Item1.Extent.Text
                if ($condition -match '^\s*\$(?:false|null)\s*$|^\s*(?:0|False)\s*$') { return $false }
                if ($condition -match '^\s*\$DistDir\s*$') { $positiveGuard = $true }
            }
        }
        $ancestor = $ancestor.Parent
    }
    return $positiveGuard
}

function Get-ExactSignAliasCopies {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$VersionedName,
        [string]$StableName
    )

    $assignments = Get-AssignmentMap $Ast
    $copies = @()
    $argumentPattern = '(?is)-LiteralPath\s+\$(?<source>[A-Za-z_][A-Za-z0-9_]*)\b.{0,300}?-Destination\s+\$(?<destination>[A-Za-z_][A-Za-z0-9_]*)\b'
    foreach ($command in (Get-ReachableCommandsByName $Ast '^(?i:Copy-Item)$')) {
        $argumentMatch = [regex]::Match($command.Extent.Text, $argumentPattern)
        if (-not $argumentMatch.Success) { continue }
        $sourceName = $argumentMatch.Groups['source'].Value
        $destinationName = $argumentMatch.Groups['destination'].Value
        if (-not $assignments.ContainsKey($sourceName) -or -not $assignments.ContainsKey($destinationName)) { continue }
        $sourceIsVersioned = Test-ExpressionDependsOnAlias $assignments[$sourceName].Right $assignments @($VersionedName)
        $sourceIsStable = Test-ExpressionDependsOnAlias $assignments[$sourceName].Right $assignments @($StableName)
        $destinationIsStable = Test-ExpressionDependsOnAlias $assignments[$destinationName].Right $assignments @($StableName)
        $destinationIsVersioned = Test-ExpressionDependsOnAlias $assignments[$destinationName].Right $assignments @($VersionedName)
        if ($sourceIsVersioned -and -not $sourceIsStable -and
            $destinationIsStable -and -not $destinationIsVersioned -and
            (Test-CommandWithinPositiveDistDirGuard $command)) {
            $copies += $command
        }
    }
    return @(
        $copies | Sort-Object { $_.Extent.StartOffset }
    )
}

function Test-SignDistReAliasesAfterSigning {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $signCommands = @(Get-ReachableCommandsByName $Ast '^(?i:Sign-File)$')
    if ($signCommands.Count -ne 1) { return $false }
    $setupCopies = @(Get-ExactSignAliasCopies $Ast 'game-capture-$Version-setup.exe' 'game-capture-setup.exe')
    $portableCopies = @(Get-ExactSignAliasCopies $Ast 'game-capture-$Version-portable.exe' 'game-capture-portable.exe')
    if ($setupCopies.Count -ne 1 -or $portableCopies.Count -ne 1) { return $false }
    if ($setupCopies[0].Extent.StartOffset -le $signCommands[0].Extent.EndOffset -or
        $portableCopies[0].Extent.StartOffset -le $signCommands[0].Extent.EndOffset) {
        return $false
    }
    return $true
}

function Get-DirectStatementInBlock {
    param(
        [System.Management.Automation.Language.Ast]$Candidate,
        [System.Management.Automation.Language.Ast]$Block
    )

    if (-not $Candidate -or -not $Block -or -not (Test-AstExtentContains $Block $Candidate)) {
        return $null
    }
    $current = $Candidate
    while ($current.Parent) {
        if ([object]::ReferenceEquals($current.Parent, $Block)) { return $current }
        $current = $current.Parent
    }
    return $null
}

function Get-ExactDistDirContext {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.Ast]$Candidate
    )

    $ancestor = $Candidate.Parent
    while ($ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
            $ancestor -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
            return $null
        }
        if ($ancestor -is [System.Management.Automation.Language.IfStatementAst] -and
            $ancestor.Clauses.Count -eq 1 -and -not $ancestor.ElseClause -and
            $ancestor.Clauses[0].Item1.Extent.Text -match '^\s*\$DistDir\s*$' -and
            (Test-AstExtentContains $ancestor.Clauses[0].Item2 $Candidate)) {
            $directDistStatement = Get-DirectStatementInBlock $ancestor $Ast.EndBlock
            if (-not [object]::ReferenceEquals($directDistStatement, $ancestor)) { return $null }
            return [pscustomobject]@{
                statement = $ancestor
                body = $ancestor.Clauses[0].Item2
            }
        }
        $ancestor = $ancestor.Parent
    }
    return $null
}

function Test-DirectThrowClause {
    param([System.Management.Automation.Language.StatementBlockAst]$Body)

    return $Body -and $Body.Statements.Count -eq 1 -and
        $Body.Statements[0] -is [System.Management.Automation.Language.ThrowStatementAst]
}

function Test-NoLocalCommandDefinition {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$LeafName
    )

    foreach ($definition in (Get-AstNodes $Ast ([System.Management.Automation.Language.FunctionDefinitionAst]))) {
        $normalizedName = [string]$definition.Name
        $normalizedName = $normalizedName -replace '^(?i:(?:global|script|local|private):)+', ''
        if ($normalizedName -ieq $LeafName) { return $false }
    }
    return $true
}

function Test-CommandHasExactNamedArgument {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string]$ParameterName,
        [string]$ExpectedPattern
    )

    $arguments = @(Get-CommandParameterArgumentTexts $Command @($ParameterName))
    return $arguments.Count -eq 1 -and $arguments[0] -match $ExpectedPattern
}

function Test-SignStableDestinationTypeGuard {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.StatementBlockAst]$DistBody,
        [string]$StableVariable,
        [int]$BeforeOffset
    )

    $variablePattern = '(?i)\$' + [regex]::Escape($StableVariable) + '\b'
    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        if ($ifAst.Extent.StartOffset -ge $BeforeOffset -or
            -not (Test-AstIsReachablePolicyCode $ifAst) -or
            -not [object]::ReferenceEquals((Get-DirectStatementInBlock $ifAst $DistBody), $ifAst) -or
            $ifAst.Clauses.Count -ne 1 -or $ifAst.ElseClause) {
            continue
        }
        foreach ($clause in $ifAst.Clauses) {
            if (-not (Test-DirectThrowClause $clause.Item2)) { continue }
            $binaryConditions = @(Get-AstNodes $clause.Item1 ([System.Management.Automation.Language.BinaryExpressionAst]))
            if ($binaryConditions.Count -ne 1 -or [string]$binaryConditions[0].Operator -ine 'And') { continue }
            $testPaths = @(
                Get-AstNodes $clause.Item1 ([System.Management.Automation.Language.CommandAst]) |
                    Where-Object {
                        $_.GetCommandName() -ieq 'Test-Path' -and
                        $_.Extent.Text -match '(?i)-LiteralPath\b' -and
                        $_.Extent.Text -match $variablePattern
                    }
            )
            $existenceTest = @($testPaths | Where-Object { $_.Extent.Text -notmatch '(?i)-PathType\b' }) | Select-Object -First 1
            $leafTest = @($testPaths | Where-Object { $_.Extent.Text -match '(?i)-PathType\s+Leaf\b' }) | Select-Object -First 1
            if (-not $existenceTest -or -not $leafTest) { continue }
            $normalizedCondition = $clause.Item1.Extent.Text -replace '\s+', ''
            $normalizedExistence = $existenceTest.Extent.Text -replace '\s+', ''
            $normalizedLeaf = $leafTest.Extent.Text -replace '\s+', ''
            if ($normalizedCondition -match ('(?i)(?:-not|!)\(?' + [regex]::Escape($normalizedExistence) + '(?=\)|-and|-or|$)') -or
                $normalizedCondition -notmatch ('(?i)(?:-not|!)\(?' + [regex]::Escape($normalizedLeaf) + '(?=\)|-and|-or|$)')) {
                continue
            }
            return $true
        }
    }
    return $false
}

function Test-SignStableAliasHashGuard {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.StatementBlockAst]$DistBody,
        [string]$CanonicalVariable,
        [string]$StableVariable,
        [int]$AfterOffset
    )

    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        if ($ifAst.Extent.StartOffset -le $AfterOffset -or
            -not (Test-AstIsReachablePolicyCode $ifAst) -or
            -not [object]::ReferenceEquals((Get-DirectStatementInBlock $ifAst $DistBody), $ifAst) -or
            $ifAst.Clauses.Count -ne 1 -or $ifAst.ElseClause) {
            continue
        }
        foreach ($clause in $ifAst.Clauses) {
            if (-not (Test-DirectThrowClause $clause.Item2)) { continue }
            $binaryConditions = @(Get-AstNodes $clause.Item1 ([System.Management.Automation.Language.BinaryExpressionAst]))
            if ($binaryConditions.Count -ne 1 -or [string]$binaryConditions[0].Operator -ine 'Cne') { continue }
            $hashCommands = @(
                Get-AstNodes $clause.Item1 ([System.Management.Automation.Language.CommandAst]) |
                    Where-Object {
                        $_.GetCommandName() -ieq 'Microsoft.PowerShell.Utility\Get-FileHash' -and
                        (Test-CommandHasExactNamedArgument $_ 'Algorithm' '^\s*["'']?SHA256["'']?\s*$')
                    }
            )
            if ($hashCommands.Count -ne 2) { continue }
            $canonicalMatches = @($hashCommands | Where-Object {
                Test-CommandHasExactNamedArgument $_ 'LiteralPath' `
                    ('^\s*\$' + [regex]::Escape($CanonicalVariable) + '\s*$')
            })
            $stableMatches = @($hashCommands | Where-Object {
                Test-CommandHasExactNamedArgument $_ 'LiteralPath' `
                    ('^\s*\$' + [regex]::Escape($StableVariable) + '\s*$')
            })
            if ($canonicalMatches.Count -eq 1 -and $stableMatches.Count -eq 1) { return $true }
        }
    }
    return $false
}

function Test-SignStablePostCopyLeafGuard {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [System.Management.Automation.Language.StatementBlockAst]$DistBody,
        [string]$StableVariable,
        [int]$AfterOffset
    )

    foreach ($ifAst in (Get-AstNodes $Ast ([System.Management.Automation.Language.IfStatementAst]))) {
        if ($ifAst.Extent.StartOffset -le $AfterOffset -or
            -not (Test-AstIsReachablePolicyCode $ifAst) -or
            -not [object]::ReferenceEquals((Get-DirectStatementInBlock $ifAst $DistBody), $ifAst) -or
            $ifAst.Clauses.Count -ne 1 -or $ifAst.ElseClause) {
            continue
        }
        $clause = $ifAst.Clauses[0]
        if (-not (Test-DirectThrowClause $clause.Item2)) { continue }
        $testPaths = @(
            Get-AstNodes $clause.Item1 ([System.Management.Automation.Language.CommandAst]) |
                Where-Object {
                    $_.GetCommandName() -ieq 'Test-Path' -and
                    (Test-CommandHasExactNamedArgument $_ 'LiteralPath' `
                        ('^\s*\$' + [regex]::Escape($StableVariable) + '\s*$')) -and
                    (Test-CommandHasExactNamedArgument $_ 'PathType' '^\s*["'']?Leaf["'']?\s*$')
                }
        )
        if ($testPaths.Count -ne 1) { continue }
        $normalizedCondition = $clause.Item1.Extent.Text -replace '\s+', ''
        $normalizedCommand = $testPaths[0].Extent.Text -replace '\s+', ''
        if ($normalizedCondition -match ('(?i)^(?:-not|!)\(?' + [regex]::Escape($normalizedCommand) + '\)?$')) {
            return $true
        }
    }
    return $false
}

function Test-SignDistStableAliasIntegrity {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $setupCopies = @(Get-ExactSignAliasCopies $Ast 'game-capture-$Version-setup.exe' 'game-capture-setup.exe')
    $portableCopies = @(Get-ExactSignAliasCopies $Ast 'game-capture-$Version-portable.exe' 'game-capture-portable.exe')
    # Copy existence, direction, and ordering are owned by SIGN_DIST_REALIASES_AFTER_SIGNING.
    if ($setupCopies.Count -ne 1 -or $portableCopies.Count -ne 1) { return $true }
    if (-not (Test-NoLocalCommandDefinition $Ast 'Get-FileHash')) { return $false }
    $distContext = Get-ExactDistDirContext $Ast $setupCopies[0]
    $portableDistContext = Get-ExactDistDirContext $Ast $portableCopies[0]
    if (-not $distContext -or -not $portableDistContext -or
        -not [object]::ReferenceEquals($distContext.body, $portableDistContext.body)) {
        return $false
    }
    $reachableTraps = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.TrapStatementAst]) |
            Where-Object { Test-AstIsReachablePolicyCode $_ }
    )
    if ($reachableTraps.Count -gt 0) { return $false }
    foreach ($contract in @(
        [pscustomobject]@{
            canonical = 'versionedSetupPath'
            stable = 'stableSetupPath'
            copy = $setupCopies[0]
        },
        [pscustomobject]@{
            canonical = 'versionedPortablePath'
            stable = 'stablePortablePath'
            copy = $portableCopies[0]
        }
    )) {
        if (-not (Test-SignStableDestinationTypeGuard $Ast $distContext.body $contract.stable $contract.copy.Extent.StartOffset) -or
            -not (Test-SignStablePostCopyLeafGuard $Ast $distContext.body $contract.stable $contract.copy.Extent.EndOffset) -or
            -not (Test-SignStableAliasHashGuard $Ast $distContext.body $contract.canonical $contract.stable $contract.copy.Extent.EndOffset)) {
            return $false
        }
    }
    return $true
}

function Get-SignAuthenticodeFlow {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $fileLoops = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ForEachStatementAst]) |
            Where-Object {
                $_.Variable.VariablePath.UserPath -ieq 'file' -and
                $_.Condition.Extent.Text -match '^\s*\$allExes\s*$' -and
                (Test-AstIsReachablePolicyCode $_)
            }
    )
    if ($fileLoops.Count -ne 1) { return $null }
    $loop = $fileLoops[0]
    $signCommands = @(
        Get-AstNodes $loop.Body ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.GetCommandName() -ieq 'Sign-File' -and
                $_.Extent.Text -match '(?i)-filePath\s+\$file\.FullName\b' -and
                (Test-AstIsReachablePolicyCode $_)
            }
    )
    $authCommands = @(
        Get-AstNodes $loop.Body ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.GetCommandName() -match '^(?i:(?:Microsoft\.PowerShell\.Security\\)?Get-AuthenticodeSignature)$' -and
                (Test-AstIsReachablePolicyCode $_)
            }
    )
    if ($signCommands.Count -ne 1 -or $authCommands.Count -ne 1) { return $null }
    $signCommand = $signCommands[0]
    $authCommand = $authCommands[0]
    $signOuter = Get-DirectStatementInBlock $signCommand $loop.Body
    $authOuter = Get-DirectStatementInBlock $authCommand $loop.Body
    $executionBlock = $loop.Body
    $tryStatement = $null
    if ($signOuter -is [System.Management.Automation.Language.TryStatementAst]) {
        if (-not [object]::ReferenceEquals($signOuter, $authOuter) -or
            -not (Test-AstExtentContains $signOuter.Body $signCommand) -or
            -not (Test-AstExtentContains $signOuter.Body $authCommand)) {
            return $null
        }
        $tryStatement = $signOuter
        $executionBlock = $signOuter.Body
    } elseif ($authOuter -is [System.Management.Automation.Language.TryStatementAst]) {
        return $null
    }
    $signStatement = Get-DirectStatementInBlock $signCommand $executionBlock
    $authStatement = Get-DirectStatementInBlock $authCommand $executionBlock
    if (-not $signStatement -or
        $authStatement -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
        -not (Test-AstExtentContains $authStatement.Right $authCommand)) {
        return $null
    }
    $statements = @($executionBlock.Statements)
    $signIndex = [array]::IndexOf($statements, $signStatement)
    $authIndex = [array]::IndexOf($statements, $authStatement)
    if ($signIndex -lt 0 -or $authIndex -ne $signIndex + 1) { return $null }
    return [pscustomobject]@{
        loop = $loop
        tryStatement = $tryStatement
        executionBlock = $executionBlock
        signCommand = $signCommand
        signStatement = $signStatement
        authCommand = $authCommand
        authAssignment = $authStatement
        authIndex = $authIndex
    }
}

function Test-SignAuthenticodeLiteralPath {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    if (-not (Test-NoLocalCommandDefinition $Ast 'Get-AuthenticodeSignature')) { return $false }
    $flow = Get-SignAuthenticodeFlow $Ast
    if (-not $flow -or $flow.authCommand.GetCommandName() -ine 'Microsoft.PowerShell.Security\Get-AuthenticodeSignature') {
        return $false
    }
    return (Test-CommandHasExactNamedArgument $flow.authCommand 'LiteralPath' '^\s*\$file\.FullName\s*$') -and
        @(Get-CommandParameterArgumentTexts $flow.authCommand @('FilePath')).Count -eq 0
}

function Test-DirectReturnValue {
    param(
        [System.Management.Automation.Language.StatementBlockAst]$Body,
        [string]$ValuePattern
    )

    return $Body -and $Body.Statements.Count -eq 1 -and
        $Body.Statements[0] -is [System.Management.Automation.Language.ReturnStatementAst] -and
        $Body.Statements[0].Extent.Text -match $ValuePattern
}

function Test-SignatureAcceptableHelperContract {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $helpers = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.FunctionDefinitionAst]) |
            Where-Object {
                $name = ([string]$_.Name) -replace '^(?i:(?:global|script|local|private):)+', ''
                $name -ieq 'Test-SignatureAcceptable'
            }
    )
    if ($helpers.Count -ne 1) { return $false }
    $helper = $helpers[0]
    $cleanBlockProperty = $helper.Body.PSObject.Properties['CleanBlock']
    if ($helper.Body.BeginBlock -or $helper.Body.ProcessBlock -or
        ($cleanBlockProperty -and $cleanBlockProperty.Value)) {
        return $false
    }
    if (@(Get-AstNodes $helper.Body ([System.Management.Automation.Language.FunctionDefinitionAst])).Count -ne 0 -or
        @(Get-AstNodes $helper.Body ([System.Management.Automation.Language.ScriptBlockExpressionAst])).Count -ne 0) {
        return $false
    }
    $body = $helper.Body.EndBlock
    if (-not $body) { return $false }
    $parameters = @($helper.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    if (-not ('signature' -iin $parameters)) { return $false }

    $statements = @($body.Statements)
    if ($statements.Count -ne 5 -or
        $statements[0] -isnot [System.Management.Automation.Language.IfStatementAst] -or
        $statements[1] -isnot [System.Management.Automation.Language.IfStatementAst] -or
        $statements[2] -isnot [System.Management.Automation.Language.AssignmentStatementAst] -or
        $statements[3] -isnot [System.Management.Automation.Language.IfStatementAst] -or
        $statements[4] -isnot [System.Management.Automation.Language.ReturnStatementAst]) {
        return $false
    }
    $allReturns = @(Get-AstNodes $helper.Body ([System.Management.Automation.Language.ReturnStatementAst]))
    if ($allReturns.Count -ne 4) { return $false }
    $trueReturns = @($allReturns | Where-Object {
        $_.Extent.Text -match '^\s*return\s+\$true\s*$'
    })
    if ($trueReturns.Count -ne 1 -or
        -not [object]::ReferenceEquals($trueReturns[0], $statements[4])) {
        return $false
    }

    $directIfs = @($statements | Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst]
    })
    $nullGuard = @($directIfs | Where-Object {
        $_.Clauses.Count -eq 1 -and -not $_.ElseClause -and
        ($_.Clauses[0].Item1.Extent.Text -replace '\s+', '') -match '^(?i)(?:-not|!)\(?\$signature\)?$' -and
        (Test-DirectReturnValue $_.Clauses[0].Item2 '^\s*return\s+\$false\s*$')
    })
    $certificateGuard = @($directIfs | Where-Object {
        $_.Clauses.Count -eq 1 -and -not $_.ElseClause -and
        ($_.Clauses[0].Item1.Extent.Text -replace '\s+', '') -match '^(?i)(?:-not|!)\(?\$signature\.SignerCertificate\)?$' -and
        (Test-DirectReturnValue $_.Clauses[0].Item2 '^\s*return\s+\$false\s*$')
    })
    if ($nullGuard.Count -ne 1 -or $certificateGuard.Count -ne 1 -or
        -not [object]::ReferenceEquals($nullGuard[0], $statements[0]) -or
        -not [object]::ReferenceEquals($certificateGuard[0], $statements[1])) {
        return $false
    }

    $hardFailureAssignments = @($statements | Where-Object {
        $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        (Get-AssignmentVariableName $_) -ieq 'hardFailures' -and
        $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals
    })
    if ($hardFailureAssignments.Count -ne 1 -or
        -not [object]::ReferenceEquals($hardFailureAssignments[0], $statements[2])) {
        return $false
    }

    $hardFailureRight = $hardFailureAssignments[0].Right
    if ($hardFailureRight -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $hardFailureRight.Expression -isnot [System.Management.Automation.Language.ArrayExpressionAst]) {
        return $false
    }
    $arrayStatements = @($hardFailureRight.Expression.SubExpression.Statements)
    if ($arrayStatements.Count -ne 1 -or
        $arrayStatements[0] -isnot [System.Management.Automation.Language.PipelineAst]) {
        return $false
    }
    $arrayPipelineElements = @($arrayStatements[0].PipelineElements)
    if ($arrayPipelineElements.Count -ne 1 -or
        $arrayPipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $arrayPipelineElements[0].Expression -isnot [System.Management.Automation.Language.ArrayLiteralAst]) {
        return $false
    }
    $hardFailureElements = @($arrayPipelineElements[0].Expression.Elements)
    if ($hardFailureElements.Count -ne 4 -or
        @($hardFailureElements | Where-Object {
            $_ -isnot [System.Management.Automation.Language.StringConstantExpressionAst]
        }).Count -ne 0) {
        return $false
    }
    $actualHardFailures = @($hardFailureElements | ForEach-Object { [string]$_.Value })
    if (($actualHardFailures -join '|') -cne 'NotSigned|HashMismatch|NotSupported|Incompatible') {
        return $false
    }

    $hardFailureGuard = $statements[3]
    if ($hardFailureGuard.Clauses.Count -ne 1 -or $hardFailureGuard.ElseClause -or
        -not (Test-DirectReturnValue $hardFailureGuard.Clauses[0].Item2 '^\s*return\s+\$false\s*$')) {
        return $false
    }
    $hardFailureCondition = $hardFailureGuard.Clauses[0].Item1
    if ($hardFailureCondition -isnot [System.Management.Automation.Language.PipelineAst] -or
        $hardFailureCondition.PipelineElements.Count -ne 1 -or
        $hardFailureCondition.PipelineElements[0] -isnot [System.Management.Automation.Language.CommandExpressionAst] -or
        $hardFailureCondition.PipelineElements[0].Expression -isnot [System.Management.Automation.Language.BinaryExpressionAst]) {
        return $false
    }
    $hardFailureBinary = $hardFailureCondition.PipelineElements[0].Expression
    if ($hardFailureBinary.Operator -ne [System.Management.Automation.Language.TokenKind]::Icontains -or
        $hardFailureBinary.Left -isnot [System.Management.Automation.Language.VariableExpressionAst] -or
        ($hardFailureBinary.Left.Extent.Text -replace '\s+', '') -cne '$hardFailures' -or
        $hardFailureBinary.Right -isnot [System.Management.Automation.Language.ConvertExpressionAst] -or
        ($hardFailureBinary.Right.Extent.Text -replace '\s+', '') -cne '[string]$signature.Status') {
        return $false
    }
    return $true
}

function Test-SignAuthenticodeFailurePolicy {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $flow = Get-SignAuthenticodeFlow $Ast
    if (-not $flow) { return $true }
    $literalContractApplies = $flow.authCommand.GetCommandName() -ieq 'Microsoft.PowerShell.Security\Get-AuthenticodeSignature' -and
        (Test-CommandHasExactNamedArgument $flow.authCommand 'LiteralPath' '^\s*\$file\.FullName\s*$') -and
        @(Get-CommandParameterArgumentTexts $flow.authCommand @('FilePath')).Count -eq 0
    if (-not $literalContractApplies) { return $true }
    if (-not (Test-SignatureAcceptableHelperContract $Ast) -or -not $flow.tryStatement) { return $false }

    $signatureVariable = Get-AssignmentVariableName $flow.authAssignment
    if (-not $signatureVariable) { return $false }
    $executionStatements = @($flow.executionBlock.Statements)
    if ($flow.authIndex + 1 -ge $executionStatements.Count) { return $false }
    $signatureGuard = $executionStatements[$flow.authIndex + 1]
    if ($signatureGuard -isnot [System.Management.Automation.Language.IfStatementAst] -or
        $signatureGuard.Clauses.Count -ne 1 -or $signatureGuard.ElseClause -or
        -not (Test-DirectThrowClause $signatureGuard.Clauses[0].Item2)) {
        return $false
    }
    $helperCalls = @(
        Get-AstNodes $signatureGuard.Clauses[0].Item1 ([System.Management.Automation.Language.CommandAst]) |
            Where-Object { $_.GetCommandName() -ieq 'Test-SignatureAcceptable' }
    )
    if ($helperCalls.Count -ne 1 -or
        -not (Test-CommandHasExactNamedArgument $helperCalls[0] 'signature' `
            ('^\s*\$' + [regex]::Escape($signatureVariable) + '\s*$'))) {
        return $false
    }
    $normalizedGuard = $signatureGuard.Clauses[0].Item1.Extent.Text -replace '\s+', ''
    $normalizedHelperCall = $helperCalls[0].Extent.Text -replace '\s+', ''
    if ($normalizedGuard -notmatch ('(?i)^(?:-not|!)\(?' + [regex]::Escape($normalizedHelperCall) + '\)?$')) {
        return $false
    }

    if ($flow.tryStatement.CatchClauses.Count -ne 1) { return $false }
    $catchAssignments = @($flow.tryStatement.CatchClauses[0].Body.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        (Get-AssignmentVariableName $_) -ieq 'failures' -and
        $_.Operator -eq [System.Management.Automation.Language.TokenKind]::PlusEquals -and
        $_.Right.Extent.Text -match '(?i)^\s*\[pscustomobject\]\s*@\{'
    })
    if ($catchAssignments.Count -ne 1) { return $false }
    $failureInitializers = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object {
                (Get-AssignmentVariableName $_) -ieq 'failures' -and
                $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals -and
                $_.Extent.StartOffset -lt $flow.loop.Extent.StartOffset -and
                $_.Right.Extent.Text -match '^\s*@\(\s*\)\s*$' -and
                [object]::ReferenceEquals((Get-DirectStatementInBlock $_ $Ast.EndBlock), $_)
            }
    )
    if ($failureInitializers.Count -ne 1) { return $false }

    $finalFailureGuards = @($Ast.EndBlock.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst] -and
        $_.Extent.StartOffset -gt $flow.loop.Extent.EndOffset -and
        $_.Clauses.Count -eq 1 -and -not $_.ElseClause -and
        ($_.Clauses[0].Item1.Extent.Text -replace '\s+', '') -match '^(?i)\$failures\.Count-gt0$'
    })
    if ($finalFailureGuards.Count -ne 1) { return $false }
    $finalBody = $finalFailureGuards[0].Clauses[0].Item2
    $warningCommands = @(
        Get-AstNodes $finalBody ([System.Management.Automation.Language.CommandAst]) |
            Where-Object { $_.GetCommandName() -ieq 'Write-Warning' }
    )
    if ($warningCommands.Count -ne 1 -or
        -not (Get-DirectStatementInBlock $warningCommands[0] $finalBody)) {
        return $false
    }
    $failOnErrorGuards = @($finalBody.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst] -and
        $_.Clauses.Count -eq 1 -and -not $_.ElseClause -and
        $_.Clauses[0].Item1.Extent.Text -match '^\s*\$FailOnError\s*$'
    })
    if ($failOnErrorGuards.Count -ne 1) { return $false }
    $exitStatements = @($failOnErrorGuards[0].Clauses[0].Item2.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.ExitStatementAst] -and
        $_.Extent.Text -match '^\s*exit\s+1\s*$'
    })
    return $exitStatements.Count -eq 1
}

function Test-ReleaseFfmpegPayloadMandatory {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    if ($Ast.ParamBlock) {
        foreach ($parameter in $Ast.ParamBlock.Parameters) {
            if ($parameter.Name.VariablePath.UserPath -ieq 'AllowMissingFfmpeg') { return $false }
        }
    }
    $bypassVariables = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.VariableExpressionAst]) |
            Where-Object { $_.VariablePath.UserPath -ieq 'AllowMissingFfmpeg' }
    )
    if ($bypassVariables.Count -gt 0) { return $false }
    return @(
        Get-StringValues $Ast | Where-Object { $_ -ceq '-AllowMissingFfmpeg' }
    ).Count -eq 0
}

function Get-UniqueTopLevelAssignment {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Name
    )

    if (-not $Ast.EndBlock) { return $null }
    $matches = @($Ast.EndBlock.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals -and
        (Get-AssignmentVariableName $_) -ceq $Name
    })
    if ($matches.Count -ne 1) { return $null }
    return $matches[0]
}

function Get-UniqueNamedFunction {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Name
    )

    $matches = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.FunctionDefinitionAst]) |
            Where-Object { $_.Name -ceq $Name }
    )
    if ($matches.Count -ne 1) { return $null }
    return $matches[0]
}

function Get-ReleaseManifestWrite {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $writes = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst]) |
            Where-Object {
                $_.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $_.Member.Value -ceq 'WriteAllText' -and
                (Get-CompactAstText $_) -ceq
                    '[System.IO.File]::WriteAllText($releaseManifestPath,$releaseManifestJson+"`n",$utf8WithoutBom)'
            }
    )
    if ($writes.Count -ne 1) { return $null }
    return $writes[0]
}

function Test-BuildReleaseManifestSchemaPath {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $pathAssignment = Get-UniqueTopLevelAssignment $Ast 'releaseManifestPath'
    $manifestAssignment = Get-UniqueTopLevelAssignment $Ast 'releaseManifest'
    if (-not $pathAssignment -or -not $manifestAssignment) { return $false }
    $pathText = Get-CompactAstText $pathAssignment.Right
    $manifestText = Get-CompactAstText $manifestAssignment.Right
    return $pathText -match '^(?i)Join-Path\$stageDir[''"]release-artifact-manifest\.json[''"]$' -and
        $manifestText -match '(?i)schema=[''"]game-capture-release-artifact/v1[''"]' -and
        $manifestText -match '(?i)relativePath=[''"]game-capture\.exe[''"]'
}

function Test-BuildReleaseManifestOrder {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $write = Get-ReleaseManifestWrite $Ast
    if (-not $write) { return $false }
    $stagedSigners = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
                (Get-CompactAstText $_) -ceq '&$signScript-FilePaths@($stagedExecutablePath)'
            }
    )
    if ($stagedSigners.Count -ne 1 -or
        $write.Extent.StartOffset -le $stagedSigners[0].Extent.EndOffset) {
        return $false
    }

    $zipCommands = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.GetCommandName() -ieq 'Compress-Archive' -and
                $_.Extent.Text -match '(?i)-DestinationPath\s+\$zipPath\b'
            }
    )
    $portableCommands = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
                $_.CommandElements.Count -gt 0 -and
                $_.CommandElements[0] -is [System.Management.Automation.Language.VariableExpressionAst] -and
                $_.CommandElements[0].VariablePath.UserPath -ceq 'sevenZipExe'
            }
    )
    $installerCommands = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
                $_.CommandElements.Count -gt 0 -and
                $_.CommandElements[0].Extent.Text -ceq '$makensis.Source'
            }
    )
    if ($zipCommands.Count -ne 1 -or $portableCommands.Count -ne 1 -or
        $installerCommands.Count -ne 1) {
        return $false
    }
    foreach ($packager in @($zipCommands[0], $portableCommands[0], $installerCommands[0])) {
        if ($write.Extent.EndOffset -ge $packager.Extent.StartOffset) { return $false }
    }
    return @(
        $stagedSigners | Where-Object { $_.Extent.StartOffset -gt $write.Extent.EndOffset }
    ).Count -eq 0
}

function Test-BuildReleaseManifestUtf8NoBom {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $encodingAssignment = Get-UniqueTopLevelAssignment $Ast 'utf8WithoutBom'
    $write = Get-ReleaseManifestWrite $Ast
    return [bool]$encodingAssignment -and [bool]$write -and
        (Get-CompactAstText $encodingAssignment.Right) -ceq
            'New-ObjectSystem.Text.UTF8Encoding($false)' -and
        $encodingAssignment.Extent.StartOffset -lt $write.Extent.StartOffset
}

function Test-BuildReleaseManifestReleaseConfiguration {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $manifestAssignment = Get-UniqueTopLevelAssignment $Ast 'releaseManifest'
    if (-not $manifestAssignment -or -not $Ast.EndBlock) { return $false }
    $configurationGuards = @($Ast.EndBlock.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst] -and
        $_.Extent.StartOffset -lt $manifestAssignment.Extent.StartOffset -and
        $_.Clauses.Count -eq 1 -and -not $_.ElseClause -and
        (Get-CompactAstText $_.Clauses[0].Item1) -ceq "`$Configuration-cne'Release'" -and
        @(Get-AstNodes $_.Clauses[0].Item2 ([System.Management.Automation.Language.ThrowStatementAst])).Count -eq 1
    })
    return $configurationGuards.Count -eq 1 -and
        (Get-CompactAstText $manifestAssignment.Right) -match
            '(?i)build=\[ordered\]@\{configuration=\$Configurationdirectory='
}

function Test-BuildReleaseManifestSourceProvenanceRequired {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string]$Content
    )

    $write = Get-ReleaseManifestWrite $Ast
    $manifestAssignment = Get-UniqueTopLevelAssignment $Ast 'releaseManifest'
    $provenanceAssignment = Get-UniqueTopLevelAssignment $Ast 'sourceProvenance'
    $provenanceFunction = Get-UniqueNamedFunction $Ast 'Get-ReleaseSourceProvenance'
    if (-not $write -or -not $manifestAssignment -or -not $provenanceAssignment -or
        -not $provenanceFunction -or
        $provenanceAssignment.Extent.StartOffset -ge $write.Extent.StartOffset) {
        return $false
    }
    $manifestText = Get-CompactAstText $manifestAssignment.Right
    $provenanceText = Get-CompactAstText $provenanceFunction.Body
    $requiredManifestBindings = @(
        'gitCommit=$sourceProvenance.gitCommit',
        'dirty=$sourceProvenance.dirty',
        'snapshotSha256=$sourceProvenance.snapshotSha256',
        'snapshotFileCount=$sourceProvenance.snapshotFileCount',
        'snapshotAlgorithm=$sourceProvenance.snapshotAlgorithm'
    )
    foreach ($binding in $requiredManifestBindings) {
        if ($manifestText.IndexOf($binding, [System.StringComparison]::Ordinal) -lt 0) {
            return $false
        }
    }
    if ($provenanceText -notmatch '\$gitCommit=\$commitText\.Trim\(\)\.ToLowerInvariant\(\)') {
        return $false
    }

    $prefix = $Content.Substring(0, $write.Extent.StartOffset)
    return $prefix -match '(?is)\$sourceProvenance\.gitCommit\s+-notmatch\s+[''\"]\^\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)\$[''\"].{0,500}?throw' -and
        $prefix -match '(?is)\$sourceProvenance\.dirty\s+-isnot\s+\[bool\].{0,300}?throw' -and
        $prefix -match '(?is)\$sourceProvenance\.snapshotSha256\s+-notmatch\s+[''\"]\^\[0-9a-f\]\{64\}\$[''\"].{0,300}?throw' -and
        $prefix -match '(?is)\$sourceProvenance\.snapshotFileCount.{0,260}?-(?:lt|le)\s+1.{0,300}?throw' -and
        $prefix -match '(?is)IsNullOrWhiteSpace\(\[string\]\$sourceProvenance\.snapshotAlgorithm\).{0,300}?throw'
}

function Test-BuildReleaseManifestCompletePayload {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $write = Get-ReleaseManifestWrite $Ast
    $manifestAssignment = Get-UniqueTopLevelAssignment $Ast 'releaseManifest'
    $inventoryAssignment = Get-UniqueTopLevelAssignment $Ast 'payloadInventory'
    $inventoryFunction = Get-UniqueNamedFunction $Ast 'Get-ReleasePayloadInventory'
    $qtConfigurationAssignment = Get-UniqueTopLevelAssignment $Ast 'qtConfiguration'
    if (-not $write -or -not $manifestAssignment -or -not $inventoryAssignment -or
        -not $inventoryFunction -or -not $qtConfigurationAssignment) {
        return $false
    }

    $inventoryText = Get-CompactAstText $inventoryFunction.Body
    $inventoryBindingText = (Get-CompactAstText $inventoryAssignment.Right).Replace('`', '')
    $manifestText = Get-CompactAstText $manifestAssignment.Right
    $qtConfigurationText = $qtConfigurationAssignment.Right.Extent.Text.Replace("`r`n", "`n")
    if ($inventoryText -notmatch [regex]::Escape(
            '[System.Collections.Generic.SortedDictionary[string,object]]::new([System.StringComparer]::Ordinal)') -or
        $inventoryText -notmatch '(?i)FileAttributes\]::ReparsePoint' -or
        $inventoryText -notmatch '(?i)Microsoft\.PowerShell\.Utility\\Get-FileHash' -or
        $inventoryText -notmatch '(?i)\$item\.Length-lt1' -or
        $inventoryText -notmatch [regex]::Escape(
            "algorithm='sha256(utf8(relative-path-nul-size-nul-sha256-lf))/ordinal-sort/v1'") -or
        $inventoryBindingText -notmatch
            '^Get-ReleasePayloadInventory-StageRoot\$stageDir-ExcludedRelativePath[''"]release-artifact-manifest\.json[''"]$' -or
        $manifestText -notmatch
            'payload=\[ordered\]@\{algorithm=\$payloadInventory\.algorithm;?fileCount=\$payloadInventory\.fileCount;?aggregateSha256=\$payloadInventory\.aggregateSha256;?files=@\(\$payloadInventory\.files\)' -or
        $qtConfigurationText -notmatch '(?s)^@[''"]\n\[Paths\]\nPrefix=\.\nPlugins=\.\n[''"]@$') {
        return $false
    }

    $qtWrites = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst]) |
            Where-Object {
                $_.Member -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $_.Member.Value -ceq 'WriteAllText' -and
                $_.Extent.StartOffset -gt $qtConfigurationAssignment.Extent.EndOffset -and
                $_.Extent.StartOffset -lt $inventoryAssignment.Extent.StartOffset -and
                (Get-CompactAstText $_) -match
                    '^\[System\.IO\.File\]::WriteAllText\(\(Join-Path\$stageDir[''"]qt\.conf[''"]\),'
            }
    )
    if ($qtWrites.Count -ne 1 -or
        $inventoryAssignment.Extent.EndOffset -ge $manifestAssignment.Extent.StartOffset) {
        return $false
    }

    $payloadExecutableBindings = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.MemberExpressionAst]) |
            Where-Object {
                $_.Extent.StartOffset -gt $inventoryAssignment.Extent.EndOffset -and
                $_.Extent.StartOffset -lt $manifestAssignment.Extent.StartOffset -and
                (Get-CompactAstText $_) -ceq '$payloadInventory.files'
            }
    )
    return $payloadExecutableBindings.Count -ge 1
}

function Test-BuildReleaseSourceSnapshotDeterministic {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $snapshotFunction = Get-UniqueNamedFunction $Ast 'Get-ReleaseSourceSnapshot'
    if (-not $snapshotFunction) {
        $snapshotFunction = Get-UniqueNamedFunction $Ast 'Get-SourceSnapshot'
    }
    if (-not $snapshotFunction) { return $false }
    $text = Get-CompactAstText $snapshotFunction.Body
    $staticContract = $text -match [regex]::Escape('[System.Collections.Generic.SortedSet[string]]::new([System.StringComparer]::Ordinal)') -and
        $text -notmatch 'StringComparer\]::OrdinalIgnoreCase' -and
        $text -match '\[void\]\$relativePathSet\.Add\(\[string\]\$rawRelativePath\)' -and
        $text -match '\$relativePaths=@\(\$relativePathSet\)' -and
        $text -match 'ls-files--cached--others--exclude-standard' -and
        $text -match 'algorithm=[''"][^''"]+/ordinal-sort-unique/v2[''"]'
    return $staticContract -and (Test-ReleaseSourceSnapshotBehavior $snapshotFunction)
}

function Get-UnscopedVariableName {
    param([string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) { return '' }
    return ($Name -replace '^(?i:(?:global|script|local|private):)+', '')
}

function Test-AstReferencesProtectedVariable {
    param(
        [System.Management.Automation.Language.Ast]$Ast,
        [string[]]$Names
    )

    foreach ($reference in @(Get-AstNodes $Ast ([System.Management.Automation.Language.VariableExpressionAst]))) {
        if ((Get-UnscopedVariableName $reference.VariablePath.UserPath) -iin $Names) {
            return $true
        }
    }
    return $false
}

function Get-StaticCommandTargetTexts {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string[]]$ParameterNames = @()
    )

    $texts = New-Object System.Collections.Generic.List[string]
    foreach ($text in @(Get-CommandParameterArgumentTexts $Command $ParameterNames)) {
        $texts.Add([string]$text) | Out-Null
    }
    for ($index = 1; $index -lt $Command.CommandElements.Count; $index++) {
        $element = $Command.CommandElements[$index]
        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
            $element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
            $texts.Add([string]$element.Extent.Text) | Out-Null
        }
    }
    return @($texts | ForEach-Object { $_.Trim().Trim('"', "'") })
}

function Test-CommandMutatesNamedVariable {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string]$VariableName
    )

    $commandName = [string]$Command.GetCommandName()
    if ($commandName -match '(?i)(?:^|\\)(?:Set|New|Remove|Clear)-Variable$') {
        $names = @(Get-StaticCommandTargetTexts $Command @('Name'))
        if ($names.Count -eq 0 -and $Command.CommandElements.Count -gt 1) {
            $names = @([string]$Command.CommandElements[1].Extent.Text.Trim('"', "'"))
        }
        if (@($names | Where-Object {
            (Get-UnscopedVariableName $_) -ieq $VariableName
        }).Count -gt 0) {
            return $true
        }
    }

    if ($commandName -match '(?i)(?:^|\\)(?:Set|New|Remove|Clear)-Item(?:Property)?$') {
        foreach ($path in @(Get-StaticCommandTargetTexts $Command @('Path', 'LiteralPath', 'Name'))) {
            if ($path -match ('^(?i:Variable:)\\?(?:(?:global|script|local|private):)?' +
                    [regex]::Escape($VariableName) + '$')) {
                return $true
            }
        }
    }

    if ($commandName -match '(?i)(?:^|\\)(?:Add-Member|Set-ItemProperty|Remove-ItemProperty|Clear-ItemProperty)$' -and
        (Test-AstReferencesProtectedVariable $Command @($VariableName))) {
        return $true
    }
    return $false
}

function Test-SessionStatePsVariableSetTargetsName {
    param(
        [System.Management.Automation.Language.InvokeMemberExpressionAst]$Invocation,
        [string[]]$Names
    )

    if (-not $Invocation -or
        $Invocation.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
        [string]$Invocation.Member.Value -ine 'Set' -or
        (Get-CompactAstText $Invocation.Expression) -cne
            '$ExecutionContext.SessionState.PSVariable' -or
        @($Invocation.Arguments).Count -lt 1 -or
        $Invocation.Arguments[0] -isnot
            [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return $false
    }
    $targetName = Get-UnscopedVariableName ([string]$Invocation.Arguments[0].Value)
    return $targetName -iin $Names
}

function Test-NoProtectedVariableWritesInRange {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string[]]$Names,
        [int]$StartOffset,
        [int]$EndOffset,
        [int[]]$AllowedAssignmentOffsets = @(),
        [int[]]$AllowedCommandOffsets = @(),
        [switch]$RejectDeferredReferences
    )

    foreach ($assignment in @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        if ($assignment.Extent.StartOffset -lt $StartOffset -or
            $assignment.Extent.StartOffset -ge $EndOffset -or
            $assignment.Extent.StartOffset -in $AllowedAssignmentOffsets) {
            continue
        }
        foreach ($reference in @(Get-AstNodes $assignment.Left ([System.Management.Automation.Language.VariableExpressionAst]))) {
            if ((Get-UnscopedVariableName $reference.VariablePath.UserPath) -iin $Names) {
                return $false
            }
        }
    }

    foreach ($unary in @(Get-AstNodes $Ast ([System.Management.Automation.Language.UnaryExpressionAst]))) {
        if ($unary.Extent.StartOffset -lt $StartOffset -or $unary.Extent.StartOffset -ge $EndOffset) {
            continue
        }
        if ($unary.TokenKind -in @(
                [System.Management.Automation.Language.TokenKind]::PlusPlus,
                [System.Management.Automation.Language.TokenKind]::MinusMinus,
                [System.Management.Automation.Language.TokenKind]::PostfixPlusPlus,
                [System.Management.Automation.Language.TokenKind]::PostfixMinusMinus
            ) -and (Test-AstReferencesProtectedVariable $unary $Names)) {
            return $false
        }
    }

    foreach ($command in @(Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        if ($command.Extent.StartOffset -lt $StartOffset -or
            $command.Extent.StartOffset -ge $EndOffset -or
            $command.Extent.StartOffset -in $AllowedCommandOffsets) {
            continue
        }
        foreach ($name in $Names) {
            if (Test-CommandMutatesNamedVariable $command $name) { return $false }
        }
    }

    foreach ($invocation in @(Get-AstNodes $Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst]))) {
        if ($invocation.Extent.StartOffset -lt $StartOffset -or
            $invocation.Extent.StartOffset -ge $EndOffset) {
            continue
        }
        if (Test-SessionStatePsVariableSetTargetsName $invocation $Names) {
            return $false
        }
        if (-not (Test-AstReferencesProtectedVariable $invocation $Names)) { continue }
        $member = if ($invocation.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            [string]$invocation.Member.Value
        } else {
            ''
        }
        if ([string]::IsNullOrWhiteSpace($member) -or
            $member -match '^(?i:Add|Append|Clear|Delete|Insert|Move|Remove|Replace|Set|Write)') {
            return $false
        }
    }

    if ($RejectDeferredReferences) {
        foreach ($expression in @(Get-AstNodes $Ast ([System.Management.Automation.Language.ScriptBlockExpressionAst]))) {
            if ($expression.Extent.StartOffset -ge $StartOffset -and
                $expression.Extent.StartOffset -lt $EndOffset -and
                (Test-AstReferencesProtectedVariable $expression $Names)) {
                return $false
            }
        }
    }
    return $true
}

function Get-ProtectedVariableAliasesInRange {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string[]]$Names,
        [int]$StartOffset,
        [int]$EndOffset
    )

    $effectiveNames = New-Object System.Collections.Generic.List[string]
    foreach ($name in $Names) {
        if (@($effectiveNames) -inotcontains $name) {
            $effectiveNames.Add([string]$name) | Out-Null
        }
    }
    $assignments = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]) |
            Where-Object {
                $_.Extent.StartOffset -ge $StartOffset -and
                $_.Extent.StartOffset -lt $EndOffset -and
                $_.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals
            } | Sort-Object { $_.Extent.StartOffset }
    )
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($assignment in $assignments) {
            $leftName = Get-AssignmentVariableName $assignment
            if ([string]::IsNullOrWhiteSpace($leftName) -or
                (Get-UnscopedVariableName $leftName) -iin @($effectiveNames) -or
                -not (Test-AstReferencesProtectedVariable $assignment.Right @($effectiveNames))) {
                continue
            }
            $effectiveNames.Add((Get-UnscopedVariableName $leftName)) | Out-Null
            $changed = $true
        }
    }
    return @($effectiveNames)
}

function Test-NoProtectedPathMutationInRange {
    param(
        [System.Management.Automation.Language.ScriptBlockAst]$Ast,
        [string[]]$Names,
        [int]$StartOffset,
        [int]$EndOffset
    )

    if (-not (Test-NoProtectedVariableWritesInRange $Ast $Names $StartOffset $EndOffset)) {
        return $false
    }
    $effectiveNames = @(Get-ProtectedVariableAliasesInRange `
        $Ast $Names $StartOffset $EndOffset)
    foreach ($command in @(Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        if ($command.Extent.StartOffset -lt $StartOffset -or
            $command.Extent.StartOffset -ge $EndOffset -or
            -not (Test-AstReferencesProtectedVariable $command $effectiveNames)) {
            continue
        }
        $commandName = [string]$command.GetCommandName()
        if ($commandName -match '(?i)(?:^|\\)(?:Set|Add|Clear)-Content$' -or
            $commandName -match '(?i)(?:^|\\)(?:Copy|Move|Rename|Remove|New|Set)-Item$' -or
            $commandName -match '(?i)(?:^|\\)(?:Out-File|Set-Acl|Unblock-File|Set-AuthenticodeSignature|Sign-File)$') {
            return $false
        }
    }
    foreach ($invocation in @(Get-AstNodes $Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst]))) {
        if ($invocation.Extent.StartOffset -lt $StartOffset -or
            $invocation.Extent.StartOffset -ge $EndOffset -or
            -not (Test-AstReferencesProtectedVariable $invocation $effectiveNames)) {
            continue
        }
        $memberName = if ($invocation.Member -is
                [System.Management.Automation.Language.StringConstantExpressionAst]) {
            [string]$invocation.Member.Value
        } else {
            ''
        }
        if ([string]::IsNullOrWhiteSpace($memberName) -or
            $memberName -match '^(?i:AppendAllText|Copy|Create|Delete|Move|OpenWrite|Replace|SetAttributes|WriteAllBytes|WriteAllLines|WriteAllText)$') {
            return $false
        }
    }
    return $true
}

function Test-NoDynamicCodeExecution {
    param([System.Management.Automation.Language.Ast]$Ast)

    foreach ($command in @(Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        if ([string]$command.GetCommandName() -match '(?i)(?:^|\\)(?:Invoke-Expression|iex)$') {
            return $false
        }
    }
    foreach ($invocation in @(Get-AstNodes $Ast ([System.Management.Automation.Language.InvokeMemberExpressionAst]))) {
        if ($invocation.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
            return $false
        }
        $owner = Get-CompactAstText $invocation.Expression
        $member = [string]$invocation.Member.Value
        if ($owner -match '^\[(?i:(?:System\.Management\.Automation\.)?(?:PowerShell|ScriptBlock))\]$' -and
            $member -match '^(?i:Create|CreateDelegate|NewScriptBlock|AddScript|AddCommand|Invoke)$') {
            return $false
        }
    }
    return $true
}

function Test-CommandOrProviderShadowsName {
    param(
        [System.Management.Automation.Language.CommandAst]$Command,
        [string]$Name
    )

    $commandName = [string]$Command.GetCommandName()
    if ([string]::IsNullOrWhiteSpace($commandName)) {
        $lookup = Get-CallOperatorGetCommandLookup $Command
        if ($lookup -and $lookup.commandType -ieq 'Cmdlet' -and
            -not [string]::IsNullOrWhiteSpace($lookup.staticName)) {
            $commandName = [string]$lookup.staticName
        }
    }
    if ($commandName -match '(?i)(?:^|\\)(?:Set|New|Remove)-Alias$') {
        $names = @(Get-StaticCommandTargetTexts $Command @('Name'))
        if ($names.Count -eq 0 -and $Command.CommandElements.Count -gt 1) {
            $names = @([string]$Command.CommandElements[1].Extent.Text.Trim('"', "'"))
        }
        if (@($names | Where-Object { $_ -ieq $Name }).Count -gt 0) { return $true }
    }
    if ($commandName -match '(?i)(?:^|\\)(?:Set|New|Remove|Clear)-Item(?:Property)?$') {
        foreach ($path in @(Get-StaticCommandTargetTexts $Command @('Path', 'LiteralPath', 'Name'))) {
            if ($path -match ('^(?i:Function:)\\?(?:(?:global|script|local|private):)?' +
                    [regex]::Escape($Name) + '$')) {
                return $true
            }
        }
    }
    return $false
}

function Test-NoCommandShadowing {
    param(
        [System.Management.Automation.Language.Ast]$Ast,
        [string]$Name,
        [System.Management.Automation.Language.FunctionDefinitionAst]$AllowedDefinition = $null
    )

    foreach ($definition in @(Get-AstNodes $Ast ([System.Management.Automation.Language.FunctionDefinitionAst]))) {
        if ($definition.Name -ieq $Name -and
            (-not $AllowedDefinition -or -not [object]::ReferenceEquals($definition, $AllowedDefinition))) {
            return $false
        }
    }
    foreach ($assignment in @(Get-AstNodes $Ast ([System.Management.Automation.Language.AssignmentStatementAst]))) {
        foreach ($reference in @(Get-AstNodes $assignment.Left ([System.Management.Automation.Language.VariableExpressionAst]))) {
            if ($reference.VariablePath.UserPath -match ('^(?i:Function:)\\?' + [regex]::Escape($Name) + '$')) {
                return $false
            }
        }
    }
    foreach ($command in @(Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        if (Test-CommandOrProviderShadowsName $command $Name) { return $false }
    }
    return $true
}

function ConvertTo-SnapshotIdentity {
    param([object]$Snapshot)

    if (-not $Snapshot -or
        [string]$Snapshot.sha256 -notmatch '^[0-9a-f]{64}$' -or
        [int64]$Snapshot.fileCount -lt 1 -or
        [string]::IsNullOrWhiteSpace([string]$Snapshot.algorithm)) {
        throw 'Snapshot helper returned an invalid identity.'
    }
    return '{0}|{1}|{2}' -f ([string]$Snapshot.sha256), ([int64]$Snapshot.fileCount), ([string]$Snapshot.algorithm)
}

function Invoke-SnapshotFunctionDefinition {
    param(
        [System.Management.Automation.Language.FunctionDefinitionAst]$Definition,
        [string]$SourceRoot
    )

    $module = Microsoft.PowerShell.Core\New-Module -ScriptBlock (
        [scriptblock]::Create($Definition.Extent.Text)
    )
    try {
        return & $module {
            param($FunctionName, $Root)
            & $FunctionName -SourceRoot $Root
        } ([string]$Definition.Name) $SourceRoot
    } finally {
        Microsoft.PowerShell.Core\Remove-Module -ModuleInfo $module -Force -ErrorAction SilentlyContinue
    }
}

function Test-ReleaseSourceSnapshotBehavior {
    param([System.Management.Automation.Language.FunctionDefinitionAst]$Definition)

    $script:sourceSnapshotBehaviorDiagnostic = 'initializing dynamic snapshot probe'
    $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $probeRoot = [System.IO.Path]::Combine(
        $tempBase,
        'game-capture-source-snapshot-probe-' + [guid]::NewGuid().ToString('N')
    )
    if (-not $probeRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -or
        $probeRoot -eq $tempBase) {
        return $false
    }
    $originalPath = $env:PATH
    $originalMode = $env:GC_SNAPSHOT_ENUM_MODE
    try {
        $script:sourceSnapshotBehaviorDiagnostic = 'creating dynamic snapshot corpus'
        [void][System.IO.Directory]::CreateDirectory($probeRoot)
        $nested = [System.IO.Path]::Combine($probeRoot, 'nested')
        [void][System.IO.Directory]::CreateDirectory($nested)
        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($probeRoot, 'alpha.txt'), 'AAAA')
        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($nested, 'bravo.txt'), 'BBBB')
        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($probeRoot, 'zeta.txt'), 'ZZZZ')
        $git = @(
            Microsoft.PowerShell.Core\Get-Command -Name git -CommandType Application -ErrorAction Stop
        ) | Select-Object -First 1
        & $git.Source -C $probeRoot init --quiet
        if ($LASTEXITCODE -ne 0) { return $false }
        # Some Windows installations expose the same Git executable through
        # multiple PATH entries. The helper intentionally consumes one
        # application identity; constrain the probe so Get-Command cannot
        # manufacture a multi-path array unrelated to snapshot semantics.
        $env:PATH = [System.IO.Path]::GetDirectoryName([string]$git.Source)

        $script:sourceSnapshotBehaviorDiagnostic = 'invoking baseline dynamic snapshot'
        $base = Invoke-SnapshotFunctionDefinition $Definition $probeRoot
        $baseIdentity = ConvertTo-SnapshotIdentity $base
        if ([int64]$base.fileCount -ne 3) { return $false }

        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($probeRoot, 'alpha.txt'), 'CCCC')
        $sameSizeIdentity = ConvertTo-SnapshotIdentity (
            Invoke-SnapshotFunctionDefinition $Definition $probeRoot
        )
        if ($sameSizeIdentity -ceq $baseIdentity) { return $false }
        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($probeRoot, 'alpha.txt'), 'AAAA')
        if ((ConvertTo-SnapshotIdentity (Invoke-SnapshotFunctionDefinition $Definition $probeRoot)) -cne $baseIdentity) {
            return $false
        }

        [System.IO.File]::Move(
            [System.IO.Path]::Combine($nested, 'bravo.txt'),
            [System.IO.Path]::Combine($nested, 'charlie.txt')
        )
        $renamed = Invoke-SnapshotFunctionDefinition $Definition $probeRoot
        if ([int64]$renamed.fileCount -ne 3 -or
            (ConvertTo-SnapshotIdentity $renamed) -ceq $baseIdentity) {
            return $false
        }
        [System.IO.File]::Move(
            [System.IO.Path]::Combine($nested, 'charlie.txt'),
            [System.IO.Path]::Combine($nested, 'bravo.txt')
        )

        $addedPath = [System.IO.Path]::Combine($probeRoot, 'delta.txt')
        [System.IO.File]::WriteAllText($addedPath, 'DDDD')
        $added = Invoke-SnapshotFunctionDefinition $Definition $probeRoot
        if ([int64]$added.fileCount -ne 4 -or
            (ConvertTo-SnapshotIdentity $added) -ceq $baseIdentity) {
            return $false
        }
        [System.IO.File]::Delete($addedPath)
        $removed = Invoke-SnapshotFunctionDefinition $Definition $probeRoot
        if ([int64]$removed.fileCount -ne 3 -or
            (ConvertTo-SnapshotIdentity $removed) -cne $baseIdentity) {
            return $false
        }

        $shimDir = [System.IO.Path]::Combine($probeRoot, 'git-shim')
        [void][System.IO.Directory]::CreateDirectory($shimDir)
        $shimPath = [System.IO.Path]::Combine($shimDir, 'git.cmd')
        $shim = @(
            '@echo off'
            'if /I "%GC_SNAPSHOT_ENUM_MODE%"=="reverse" ('
            '  echo zeta.txt'
            '  echo nested/bravo.txt'
            '  echo alpha.txt'
            '  exit /b 0'
            ')'
            'if /I "%GC_SNAPSHOT_ENUM_MODE%"=="duplicate" ('
            '  echo zeta.txt'
            '  echo alpha.txt'
            '  echo nested/bravo.txt'
            '  echo zeta.txt'
            '  echo alpha.txt'
            '  exit /b 0'
            ')'
            'exit /b 9'
        ) -join "`r`n"
        [System.IO.File]::WriteAllText($shimPath, $shim, [System.Text.Encoding]::ASCII)
        $env:PATH = $shimDir

        $script:sourceSnapshotBehaviorDiagnostic = 'invoking reversed enumeration snapshot'
        $env:GC_SNAPSHOT_ENUM_MODE = 'reverse'
        if ((ConvertTo-SnapshotIdentity (Invoke-SnapshotFunctionDefinition $Definition $probeRoot)) -cne $baseIdentity) {
            return $false
        }
        $script:sourceSnapshotBehaviorDiagnostic = 'invoking duplicate enumeration snapshot'
        $env:GC_SNAPSHOT_ENUM_MODE = 'duplicate'
        if ((ConvertTo-SnapshotIdentity (Invoke-SnapshotFunctionDefinition $Definition $probeRoot)) -cne $baseIdentity) {
            return $false
        }
        return $true
    } catch {
        $script:sourceSnapshotBehaviorDiagnostic = '{0}: {1}' -f (
            $script:sourceSnapshotBehaviorDiagnostic
        ), $_.Exception.Message
        return $false
    } finally {
        $env:PATH = $originalPath
        $env:GC_SNAPSHOT_ENUM_MODE = $originalMode
        if ([System.IO.Directory]::Exists($probeRoot)) {
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Test-ExactSourceSnapshotHelperImport {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $imports = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Dot -and
                (Get-CompactAstText $_) -ceq ".(Join-Path`$PSScriptRoot'release-source-snapshot.ps1')"
            }
    )
    return $imports.Count -eq 1
}

function Get-UniqueTopLevelReleaseHelperImportSlotCommand {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    if (-not $Ast -or -not $Ast.EndBlock) { return $null }
    $dotSources = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                [object]::ReferenceEquals((Get-ContainingScriptBlockAst $_), $Ast) -and
                $_.InvocationOperator -eq
                    [System.Management.Automation.Language.TokenKind]::Dot
            }
    )
    if ($dotSources.Count -ne 1) { return $null }
    return $dotSources[0]
}

function Test-ReleaseHasNoEarlySuccessfulTermination {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    if (-not $Ast -or -not $Ast.EndBlock) { return $false }
    $sharedHelperImportSlot =
        Get-UniqueTopLevelReleaseHelperImportSlotCommand $Ast
    foreach ($exitStatement in @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.ExitStatementAst])
    )) {
        if (-not [object]::ReferenceEquals(
                (Get-ContainingScriptBlockAst $exitStatement),
                $Ast
            )) {
            continue
        }
        $exitValue = if ($exitStatement.Pipeline) {
            Get-CompactAstText $exitStatement.Pipeline
        } else {
            ''
        }
        if ([string]::IsNullOrWhiteSpace($exitValue) -or
            $exitValue -in @('0', '$false')) {
            return $false
        }
    }

    foreach ($command in @(Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]))) {
        if (-not [object]::ReferenceEquals((Get-ContainingScriptBlockAst $command), $Ast)) {
            continue
        }
        if ($command.InvocationOperator -eq
                [System.Management.Automation.Language.TokenKind]::Dot) {
            if ($sharedHelperImportSlot -and
                [object]::ReferenceEquals($command, $sharedHelperImportSlot)) {
                continue
            }
            return $false
        }
        $lookup = Get-CallOperatorGetCommandLookup $command
        if ($lookup -and $lookup.commandType -ieq 'ExternalScript') {
            return $false
        }
    }
    return $true
}

function Test-SharedReleaseSourceSnapshotHelper {
    param(
        [bool]$HelperPresent,
        [System.Management.Automation.Language.ScriptBlockAst]$HelperAst,
        [System.Management.Automation.Language.ScriptBlockAst]$BuildAst,
        [System.Management.Automation.Language.ScriptBlockAst]$ReleaseAst
    )

    $canonicalFunction = if ($HelperPresent) {
        Get-UniqueNamedFunction $HelperAst 'Get-ReleaseSourceSnapshot'
    } else {
        $null
    }
    if (-not $HelperPresent -or -not $canonicalFunction -or -not $HelperAst.EndBlock -or
        -not (Test-ExactSourceSnapshotHelperImport $BuildAst) -or
        -not (Test-ExactSourceSnapshotHelperImport $ReleaseAst)) {
        return $false
    }

    $helperDefinitions = @(Get-AstNodes $HelperAst ([System.Management.Automation.Language.FunctionDefinitionAst]))
    $rootStatements = @($HelperAst.EndBlock.Statements)
    if ($helperDefinitions.Count -ne 1 -or
        -not [object]::ReferenceEquals($helperDefinitions[0], $canonicalFunction) -or
        @($rootStatements | Where-Object {
            -not [object]::ReferenceEquals($_, $canonicalFunction) -and
            -not ($_ -is [System.Management.Automation.Language.PipelineAst] -and
                (Get-CompactAstText $_) -ceq 'Set-StrictMode-VersionLatest')
        }).Count -ne 0 -or
        @($rootStatements | Where-Object {
            $_ -is [System.Management.Automation.Language.ReturnStatementAst]
        }).Count -ne 0 -or
        -not (Test-NoDynamicCodeExecution $HelperAst) -or
        -not (Test-NoCommandShadowing $HelperAst 'Get-ReleaseSourceSnapshot' $canonicalFunction) -or
        -not (Test-NoCommandShadowing $HelperAst 'Get-SourceSnapshot')) {
        return $false
    }
    foreach ($consumerAst in @($BuildAst, $ReleaseAst)) {
        if (-not (Test-NoDynamicCodeExecution $consumerAst) -or
            -not (Test-NoCommandShadowing $consumerAst 'Get-ReleaseSourceSnapshot') -or
            -not (Test-NoCommandShadowing $consumerAst 'Get-SourceSnapshot')) {
            return $false
        }
    }
    return $true
}

function Test-ReleaseSourceSnapshotStableAcrossBuild {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $preBuild = Get-UniqueTopLevelAssignment $Ast 'preBuildSourceSnapshot'
    $prePackage = Get-UniqueTopLevelAssignment $Ast 'prePackageSourceSnapshot'
    if (-not $preBuild -or -not $prePackage -or
        (Get-CompactAstText $preBuild.Right) -cne 'Get-ReleaseSourceSnapshot-SourceRoot$nativeQtRoot' -or
        (Get-CompactAstText $prePackage.Right) -cne 'Get-ReleaseSourceSnapshot-SourceRoot$nativeQtRoot') {
        return $false
    }
    $compileCommands = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand -and
                $_.CommandElements.Count -gt 0 -and
                $_.CommandElements[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $_.CommandElements[0].Value -ieq 'cmake' -and
                $_.Extent.Text -match '(?i)--build\s+\$BuildDir\s+--config\s+\$Configuration'
            }
    )
    $packageCommands = @(Find-ActualInvocations $Ast @('build-release.ps1'))
    if ($packageCommands.Count -ne 1 -or
        -not (Get-DirectStatementInBlock $packageCommands[0] $Ast.EndBlock) -or
        $preBuild.Extent.EndOffset -ge $prePackage.Extent.StartOffset -or
        $prePackage.Extent.EndOffset -ge $packageCommands[0].Extent.StartOffset) {
        return $false
    }
    foreach ($compileCommand in $compileCommands) {
        if (-not (Get-DirectStatementInBlock $compileCommand $Ast.EndBlock) -or
            $preBuild.Extent.EndOffset -ge $compileCommand.Extent.StartOffset -or
            $prePackage.Extent.StartOffset -le $compileCommand.Extent.EndOffset) {
            return $false
        }
    }

    $rootStatements = @($Ast.EndBlock.Statements)
    $prePackageIndex = [array]::IndexOf($rootStatements, $prePackage)
    $comparisonGuards = @($rootStatements | Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst] -and
        $_.Clauses.Count -eq 1 -and -not $_.ElseClause -and
        (Get-CompactAstText $_.Clauses[0].Item1) -ceq
            '$prePackageSourceSnapshot.sha256-cne$preBuildSourceSnapshot.sha256-or$prePackageSourceSnapshot.fileCount-ne$preBuildSourceSnapshot.fileCount-or$prePackageSourceSnapshot.algorithm-cne$preBuildSourceSnapshot.algorithm' -and
        @($_.Clauses[0].Item2.Statements).Count -eq 1 -and
        $_.Clauses[0].Item2.Statements[0] -is
            [System.Management.Automation.Language.ThrowStatementAst]
    })
    if ($prePackageIndex -lt 0 -or $comparisonGuards.Count -ne 1 -or
        $prePackageIndex + 1 -ge $rootStatements.Count -or
        -not [object]::ReferenceEquals($rootStatements[$prePackageIndex + 1], $comparisonGuards[0]) -or
        -not (Test-NoProtectedVariableWritesInRange $Ast `
            @('preBuildSourceSnapshot', 'prePackageSourceSnapshot') `
            $preBuild.Extent.StartOffset ($packageCommands[0].Extent.EndOffset + 1) `
            @($preBuild.Extent.StartOffset, $prePackage.Extent.StartOffset) @() `
            -RejectDeferredReferences)) {
        return $false
    }

    $argumentMap = Get-InvocationArgumentMap $Ast $packageCommands[0] @(
        'ExpectedSourceSnapshotSha256',
        'ExpectedSourceSnapshotFileCount',
        'ExpectedSourceSnapshotAlgorithm'
    )
    return $argumentMap.ContainsKey('ExpectedSourceSnapshotSha256') -and
        $argumentMap['ExpectedSourceSnapshotSha256'] -ceq '$preBuildSourceSnapshot.sha256' -and
        $argumentMap.ContainsKey('ExpectedSourceSnapshotFileCount') -and
        $argumentMap['ExpectedSourceSnapshotFileCount'] -ceq '$preBuildSourceSnapshot.fileCount' -and
        $argumentMap.ContainsKey('ExpectedSourceSnapshotAlgorithm') -and
        $argumentMap['ExpectedSourceSnapshotAlgorithm'] -ceq '$preBuildSourceSnapshot.algorithm'
}

function Test-BuildExpectedSourceSnapshotBinding {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    if (-not $Ast.ParamBlock) { return $false }
    $parameterSpecs = @(
        [pscustomobject]@{ name = 'ExpectedSourceSnapshotSha256'; validation = 'ValidatePattern' },
        [pscustomobject]@{ name = 'ExpectedSourceSnapshotFileCount'; validation = 'ValidateRange' },
        [pscustomobject]@{ name = 'ExpectedSourceSnapshotAlgorithm'; validation = 'ValidateNotNullOrEmpty' }
    )
    foreach ($spec in $parameterSpecs) {
        $parameters = @($Ast.ParamBlock.Parameters | Where-Object {
            $_.Name.VariablePath.UserPath -ceq $spec.name
        })
        if ($parameters.Count -ne 1 -or $parameters[0].DefaultValue -or
            -not (Test-MandatoryParameter $Ast $spec.name) -or
            @($parameters[0].Attributes | Where-Object {
                $_.TypeName.Name -ceq $spec.validation
            }).Count -ne 1) {
            return $false
        }
    }
    $provenance = Get-UniqueTopLevelAssignment $Ast 'sourceProvenance'
    $manifest = Get-UniqueTopLevelAssignment $Ast 'releaseManifest'
    if (-not $provenance -or -not $manifest) { return $false }
    $rootStatements = @($Ast.EndBlock.Statements)
    $provenanceIndex = [array]::IndexOf($rootStatements, $provenance)
    $comparisonGuards = @($rootStatements | Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst] -and
        $_.Clauses.Count -eq 1 -and -not $_.ElseClause -and
        (Get-CompactAstText $_.Clauses[0].Item1) -ceq
            '$sourceProvenance.snapshotSha256-cne$ExpectedSourceSnapshotSha256-or[int64]$sourceProvenance.snapshotFileCount-ne$ExpectedSourceSnapshotFileCount-or$sourceProvenance.snapshotAlgorithm-cne$ExpectedSourceSnapshotAlgorithm' -and
        @($_.Clauses[0].Item2.Statements).Count -eq 1 -and
        $_.Clauses[0].Item2.Statements[0] -is
            [System.Management.Automation.Language.ThrowStatementAst]
    })
    return $provenanceIndex -ge 0 -and $comparisonGuards.Count -eq 1 -and
        $provenanceIndex + 1 -lt $rootStatements.Count -and
        [object]::ReferenceEquals($rootStatements[$provenanceIndex + 1], $comparisonGuards[0]) -and
        (Test-NoProtectedVariableWritesInRange $Ast @('sourceProvenance') `
            $provenance.Extent.StartOffset $manifest.Extent.EndOffset `
            @($provenance.Extent.StartOffset) @() -RejectDeferredReferences)
}

function Test-BuildReleaseManifestFinalStagedExeIdentity {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $write = Get-ReleaseManifestWrite $Ast
    $manifestAssignment = Get-UniqueTopLevelAssignment $Ast 'releaseManifest'
    $infoAssignment = Get-UniqueTopLevelAssignment $Ast 'stagedExecutableInfo'
    $hashAssignment = Get-UniqueTopLevelAssignment $Ast 'stagedExecutableSha256'
    if (-not $write -or -not $manifestAssignment -or -not $infoAssignment -or -not $hashAssignment) {
        return $false
    }
    $signer = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object { (Get-CompactAstText $_) -ceq '&$signScript-FilePaths@($stagedExecutablePath)' }
    )
    if ($signer.Count -ne 1 -or
        $infoAssignment.Extent.StartOffset -le $signer[0].Extent.EndOffset -or
        $hashAssignment.Extent.StartOffset -le $signer[0].Extent.EndOffset -or
        $infoAssignment.Extent.StartOffset -ge $write.Extent.StartOffset -or
        $hashAssignment.Extent.StartOffset -ge $write.Extent.StartOffset) {
        return $false
    }
    $infoText = Get-CompactAstText $infoAssignment.Right
    $hashText = Get-CompactAstText $hashAssignment.Right
    $manifestText = Get-CompactAstText $manifestAssignment.Right
    if ($infoText -cne 'Get-Item-LiteralPath$stagedExecutablePath-ErrorActionStop' -or
        $hashText -cne '(Get-FileHash-LiteralPath$stagedExecutablePath-AlgorithmSHA256).Hash.ToLowerInvariant()' -or
        $manifestText -notmatch 'artifact=\[ordered\]@\{relativePath=[''\"]game-capture\.exe[''\"];?size=\[int64\]\$stagedExecutableInfo\.Length;?sha256=\$stagedExecutableSha256') {
        return $false
    }
    $leafGuards = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.GetCommandName() -ieq 'Test-Path' -and
                $_.Extent.StartOffset -gt $signer[0].Extent.EndOffset -and
                $_.Extent.StartOffset -lt $infoAssignment.Extent.StartOffset -and
                (Get-CompactAstText $_) -ceq 'Test-Path-LiteralPath$stagedExecutablePath-PathTypeLeaf'
            }
    )
    $identityCompleteOffset = [Math]::Max(
        $infoAssignment.Extent.EndOffset,
        $hashAssignment.Extent.EndOffset
    )
    return $leafGuards.Count -eq 1 -and
        (Test-NoProtectedPathMutationInRange $Ast `
            @('stagedExecutablePath', 'stageDir') `
            $identityCompleteOffset ($Ast.Extent.EndOffset + 1))
}

function Test-ReleaseManifestCoLocatedPath {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $publisher = Get-UniqueTopLevelAssignment $Ast 'packagedPublisher'
    $manifestPath = Get-UniqueTopLevelAssignment $Ast 'artifactManifestPath'
    if (-not $publisher -or -not $manifestPath -or
        $manifestPath.Extent.StartOffset -le $publisher.Extent.EndOffset) {
        return $false
    }
    $pathText = Get-CompactAstText $manifestPath.Right
    if ($pathText -notmatch '^\[System\.IO\.Path\]::Combine\(\[System\.IO\.Path\]::GetDirectoryName\(\[System\.IO\.Path\]::GetFullPath\(\$packagedPublisher\)\),[''"]release-artifact-manifest\.json[''"]\)$') {
        return $false
    }
    $guards = @(
        Get-AstNodes $Ast ([System.Management.Automation.Language.CommandAst]) |
            Where-Object {
                $_.GetCommandName() -ieq 'Test-Path' -and
                $_.Extent.StartOffset -gt $manifestPath.Extent.EndOffset -and
                (Get-CompactAstText $_) -ceq 'Test-Path-LiteralPath$artifactManifestPath-PathTypeLeaf' -and
                (Get-DirectStatementInBlock $_ $Ast.EndBlock) -is [System.Management.Automation.Language.IfStatementAst]
            }
    )
    return $guards.Count -eq 1
}

function Test-ReleaseManifestSha256Binding {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    $pathAssignment = Get-UniqueTopLevelAssignment $Ast 'artifactManifestPath'
    $hashAssignment = Get-UniqueTopLevelAssignment $Ast 'artifactManifestSha256'
    if (-not $pathAssignment -or -not $hashAssignment -or
        $hashAssignment.Extent.StartOffset -le $pathAssignment.Extent.EndOffset) {
        return $false
    }
    if ((Get-CompactAstText $hashAssignment.Right) -cne
        '(Microsoft.PowerShell.Utility\Get-FileHash-LiteralPath$artifactManifestPath-AlgorithmSHA256-ErrorActionStop).Hash.ToLowerInvariant()') {
        return $false
    }
    $guards = @($Ast.EndBlock.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst] -and
        $_.Extent.StartOffset -gt $hashAssignment.Extent.EndOffset -and
        (Get-CompactAstText $_.Clauses[0].Item1) -ceq "`$artifactManifestSha256-notmatch'^[0-9a-f]{64}`$'" -and
        @(Get-AstNodes $_.Clauses[0].Item2 ([System.Management.Automation.Language.ThrowStatementAst])).Count -eq 1
    })
    return $guards.Count -eq 1 -and
        (Test-NoCommandShadowing $Ast 'Get-FileHash')
}

function Test-ArtifactManifestParameterContract {
    param([System.Management.Automation.Language.ScriptBlockAst]$Ast)

    if (-not $Ast.ParamBlock) { return $false }
    foreach ($spec in @(
        [pscustomobject]@{ name = 'PublisherPath'; validation = 'ValidateNotNullOrEmpty' },
        [pscustomobject]@{ name = 'ArtifactManifestPath'; validation = 'ValidateNotNullOrEmpty' },
        [pscustomobject]@{ name = 'ArtifactManifestSha256'; validation = 'ValidatePattern' }
    )) {
        $parameters = @($Ast.ParamBlock.Parameters | Where-Object {
            $_.Name.VariablePath.UserPath -ceq $spec.name
        })
        if ($parameters.Count -ne 1 -or $parameters[0].DefaultValue -or
            $parameters[0].StaticType -ne [string] -or
            -not (Test-MandatoryParameter $Ast $spec.name)) {
            return $false
        }
        $validation = @($parameters[0].Attributes | Where-Object {
            $_.TypeName.Name -ceq $spec.validation
        })
        if ($validation.Count -ne 1) { return $false }
        if ($spec.validation -ceq 'ValidatePattern' -and
            (Get-CompactAstText $validation[0]) -notmatch '^\[ValidatePattern\([''"]\^\[0-9a-f\]\{64\}\$[''"]\)\]$') {
            return $false
        }
    }

    $bindingSpecs = @(
        [pscustomobject]@{ name = 'publisherExe'; value = '$PublisherPath' },
        [pscustomobject]@{ name = 'artifactManifestPathBinding'; value = '$ArtifactManifestPath' },
        [pscustomobject]@{ name = 'artifactManifestSha256Binding'; value = '$ArtifactManifestSha256' }
    )
    $bindingOffsets = New-Object System.Collections.Generic.List[int]
    $bindings = @{}
    foreach ($spec in $bindingSpecs) {
        $matches = @(Get-ExactEngineConstantBindings $Ast $spec.name)
        if ($matches.Count -ne 1 -or
            (Get-CompactAstText $matches[0].value) -cne $spec.value) {
            return $false
        }
        $bindings[$spec.name] = $matches[0]
        $bindingOffsets.Add([int]$matches[0].command.Extent.StartOffset) | Out-Null
    }

    $ownedInvocationOffsets = @(
        foreach ($alias in @(
            'gate:signaling-media-fixture',
            'e2e:signaling-regressions:edge',
            'e2e:signaling-regressions:firefox'
        )) {
            foreach ($invocation in @(Get-SemanticNpmRunAliasInvocations $Ast $alias)) {
                [int]$invocation.Extent.StartOffset
            }
        }
    )
    if ($ownedInvocationOffsets.Count -gt 0) {
        $firstOwnedInvocation = ($ownedInvocationOffsets | Measure-Object -Minimum).Minimum
        if (@($bindings.Values | Where-Object {
            $_.command.Extent.StartOffset -ge $firstOwnedInvocation
        }).Count -gt 0) {
            return $false
        }
    }

    return (Test-NoProtectedVariableWritesInRange $Ast @(
            'PublisherPath',
            'ArtifactManifestPath',
            'ArtifactManifestSha256',
            'publisherExe',
            'artifactManifestPathBinding',
            'artifactManifestSha256Binding'
        ) 0 ($Ast.Extent.EndOffset + 1) @() @($bindingOffsets))
}

$package = (Read-PolicyFile 'native-qt/package.json') | ConvertFrom-Json
$readiness = Read-PolicyFile 'native-qt/qa/run-release-readiness.ps1'
$fastGate = Read-PolicyFile 'native-qt/qa/run-fast-gate.ps1'
$nightlyGate = Read-PolicyFile 'native-qt/qa/run-nightly-soak.ps1'
$releasePublish = Read-PolicyFile 'native-qt/qa/release-and-publish.ps1'
$buildRelease = Read-PolicyFile 'native-qt/qa/build-release.ps1'
$sourceSnapshotHelperRelativePath = 'native-qt/qa/release-source-snapshot.ps1'
$sourceSnapshotHelperPath = Join-Path $repoRoot $sourceSnapshotHelperRelativePath
$sourceSnapshotHelperPresent = Test-Path -LiteralPath $sourceSnapshotHelperPath -PathType Leaf
$sourceSnapshotHelper = if ($sourceSnapshotHelperPresent) {
    (Get-Content -LiteralPath $sourceSnapshotHelperPath -Raw).Replace("`r`n", "`n")
} else {
    ''
}
$signArtifacts = Read-PolicyFile 'native-qt/qa/sign-artifacts.ps1'
$virusTotalScript = Read-PolicyFile 'native-qt/qa/submit-virustotal.ps1'
$fastWorkflow = Read-PolicyFile '.github/workflows/qa-fast-gate.yml'
$nightlyWorkflow = Read-PolicyFile '.github/workflows/qa-nightly-soak.yml'
$alphaManifestScript = Read-PolicyFile 'native-qt/e2e/alpha-workflow-manifest-regression.ps1'
$alphaArtifactScript = Read-PolicyFile 'native-qt/e2e/alpha-artifact-binding-regression.ps1'
$alphaAnalyzerScript = Read-PolicyFile 'native-qt/e2e/alpha-composite-analyzer-regression.js'
$fullAlphaScript = Read-PolicyFile 'native-qt/e2e/ninja-plugin-alpha-e2e.ps1'
$roomAlphaScript = Read-PolicyFile 'native-qt/e2e/room-alpha-ninja-plugin-e2e.ps1'

$readinessAst = Parse-PowerShellPolicy $readiness 'run-release-readiness.ps1'
$fastGateAst = Parse-PowerShellPolicy $fastGate 'run-fast-gate.ps1'
$nightlyGateAst = Parse-PowerShellPolicy $nightlyGate 'run-nightly-soak.ps1'
$releaseAst = Parse-PowerShellPolicy $releasePublish 'release-and-publish.ps1'
$buildReleaseAst = Parse-PowerShellPolicy $buildRelease 'build-release.ps1'
$sourceSnapshotHelperAst = Parse-PowerShellPolicy $sourceSnapshotHelper 'release-source-snapshot.ps1'
$signArtifactsAst = Parse-PowerShellPolicy $signArtifacts 'sign-artifacts.ps1'
$alphaManifestAst = Parse-PowerShellPolicy $alphaManifestScript 'alpha-workflow-manifest-regression.ps1'
$alphaArtifactAst = Parse-PowerShellPolicy $alphaArtifactScript 'alpha-artifact-binding-regression.ps1'
$fullAlphaAst = Parse-PowerShellPolicy $fullAlphaScript 'ninja-plugin-alpha-e2e.ps1'
$roomAlphaAst = Parse-PowerShellPolicy $roomAlphaScript 'room-alpha-ninja-plugin-e2e.ps1'
$fastSteps = Get-YamlSteps $fastWorkflow
$nightlySteps = Get-YamlSteps $nightlyWorkflow

Add-PolicyCheck 'SCRIPT_SIGNALING_EDGE_CONTRACT' (Test-PackageScriptContract $package 'e2e:signaling-regressions:edge' @('--browser=edge')) 'Edge signaling must select Edge.'
Add-PolicyCheck 'SCRIPT_SIGNALING_FIREFOX_CONTRACT' (Test-PackageScriptContract $package 'e2e:signaling-regressions:firefox' @('--browser=firefox')) 'Firefox signaling must select Firefox.'
Add-PolicyCheck 'SCRIPT_SIGNALING_MEDIA_FIXTURE_CONTRACT' (Test-ExactPackageScriptWithoutLifecycleHooks $package 'gate:signaling-media-fixture' 'node e2e/signaling-media-fixture-regression.js') 'The deterministic-media fixture package alias must map exactly to its real regression guard and must not expose npm pre/post lifecycle hooks.'
Add-PolicyCheck 'SCRIPT_CONTROL_CENTER_EDGE_STRICT' (Test-PackageScriptContract $package 'e2e:control-center:edge' @('--browser=edge', '--strict-negotiation')) 'Edge Control Center must use strict negotiation.'
Add-PolicyCheck 'SCRIPT_CONTROL_CENTER_FIREFOX_STRICT' (Test-PackageScriptContract $package 'e2e:control-center:firefox' @('--browser=firefox', '--strict-negotiation')) 'Firefox Control Center must use strict negotiation.'
Add-PolicyCheck 'SCRIPT_ROOM_ALPHA_CONTRACT' (Test-PackageScriptContract $package 'e2e:room-alpha-ninja-plugin' @('room-alpha-ninja-plugin-e2e.ps1')) 'The two-case Room Quality/alpha package script must map to its real wrapper.'
Add-PolicyCheck 'SCRIPT_FULL_ALPHA_CONTRACT' (Test-PackageScriptContract $package 'e2e:ninja-plugin-alpha' @('ninja-plugin-alpha-e2e.ps1')) 'The seven-case alpha package script must map to its real wrapper.'
Add-PolicyCheck 'SCRIPT_RELEASE_POLICY_SELF_TESTED' (Test-PackageScriptContract $package 'gate:release-wiring' @('release-gate-wiring-policy-mutations.ps1', 'release-gate-wiring-regression.ps1')) 'gate:release-wiring must run its mutation self-check before evaluating repository wiring.'
$releaseWiringCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-gate-wiring-policy-mutations.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-gate-wiring-regression.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File e2e/release-readiness-runtime-regression.ps1'
Add-PolicyCheck 'SCRIPT_RELEASE_RUNTIME_PROBE_WIRED' (Test-ExactPackageScriptWithoutLifecycleHooks $package 'gate:release-wiring' $releaseWiringCommand) 'gate:release-wiring must execute mutations, the structural checker, and the release-readiness runtime probe in that exact failure-blocking order, with no npm lifecycle hooks.'

$runStepContract = Test-RunStepContract $readinessAst
Add-PolicyCheck 'READINESS_RUN_STEP_CONTRACT' $runStepContract 'Readiness must use one engine-owned Constant runner that invokes its action exactly once, immediately guards native failure, and emits only one Boolean result.'

$repoBindings = @(Get-ExactEngineConstantBindings $readinessAst 'repoRoot')
$repoConstantValid = $repoBindings.Count -eq 1 -and
    (Get-CompactAstText $repoBindings[0].value) -ceq "([System.IO.Path]::GetFullPath([System.IO.Path]::Combine(`$PSScriptRoot,'..')))"
if ($repoConstantValid) {
    $earlyRepoUses = @(
        Get-AstNodes $readinessAst ([System.Management.Automation.Language.VariableExpressionAst]) |
            Where-Object {
                $_.VariablePath.UserPath -ceq 'script:repoRoot' -and
                $_.Extent.StartOffset -le $repoBindings[0].statement.Extent.EndOffset -and
                (Test-AstIsReachablePolicyCode $_)
            }
    )
    $repoConstantValid = $earlyRepoUses.Count -eq 0
}
$repoConstantValid = $repoConstantValid -and
    (Test-NoPolicyVariableMutation $readinessAst 'PSScriptRoot')
Add-PolicyCheck 'READINESS_REPO_ROOT_CONSTANT' $repoConstantValid 'Readiness must derive repoRoot directly from PSScriptRoot and create one engine-owned script-scope Constant before its first use.'

$npmBindings = @(Get-ExactEngineConstantBindings $readinessAst 'npmExecutable')
$npmResolverValid = $npmBindings.Count -eq 1 -and
    (Get-CompactAstText $npmBindings[0].value) -ceq "(`$ExecutionContext.SessionState.InvokeCommand.GetCommand('npm.cmd',[System.Management.Automation.CommandTypes]::Application).Source)"
if ($npmResolverValid) {
    $earlyNpmUses = @(
        Get-AstNodes $readinessAst ([System.Management.Automation.Language.VariableExpressionAst]) |
            Where-Object {
                $_.VariablePath.UserPath -ceq 'script:npmExecutable' -and
                $_.Extent.StartOffset -le $npmBindings[0].statement.Extent.EndOffset -and
                (Test-AstIsReachablePolicyCode $_)
            }
    )
    $npmResolverValid = $earlyNpmUses.Count -eq 0
}
Add-PolicyCheck 'READINESS_NPM_APPLICATION_RESOLUTION' $npmResolverValid 'Readiness must engine-resolve npm.cmd as an Application and create one engine-owned script-scope Constant before its first use.'

$blockingGateSpecs = @(
    [pscustomobject]@{ id = 'READINESS_CONTROL_CENTER_EDGE'; aliases = @('e2e:control-center:edge') },
    [pscustomobject]@{ id = 'READINESS_CONTROL_CENTER_FIREFOX'; aliases = @('e2e:control-center:firefox') },
    [pscustomobject]@{ id = 'READINESS_ALPHA_MANIFEST'; aliases = @('gate:alpha-workflow-manifests') },
    [pscustomobject]@{ id = 'READINESS_ALPHA_ARTIFACT'; aliases = @('gate:alpha-artifact-bindings') },
    [pscustomobject]@{ id = 'READINESS_ALPHA_ANALYZER'; aliases = @('gate:alpha-composite-analyzer') }
)
$blockingRecords = @{}
foreach ($spec in $blockingGateSpecs) {
    $record = Get-BlockingRunStep $readinessAst $spec.aliases
    $blockingRecords[$spec.id] = $record
    Add-PolicyCheck $spec.id ([bool]$record) "run-release-readiness.ps1 must actually invoke and allPass-block '$($spec.aliases[0])'."
}

$edgeRecords = @(Get-BlockingRunSteps $readinessAst @('e2e:signaling-regressions:edge'))
$firefoxRecords = @(Get-BlockingRunSteps $readinessAst @('e2e:signaling-regressions:firefox'))
$edgeRecord = if ($edgeRecords.Count -eq 1) { $edgeRecords[0] } else { $null }
$firefoxRecord = if ($firefoxRecords.Count -eq 1) { $firefoxRecords[0] } else { $null }
$edgeRecordValid = $edgeRecords.Count -eq 1 -and
    (Test-ExactTopLevelSignalingRecord $readinessAst $edgeRecord 'e2e:signaling-regressions:edge')
$firefoxRecordValid = $firefoxRecords.Count -eq 1 -and
    (Test-ExactTopLevelSignalingRecord $readinessAst $firefoxRecord 'e2e:signaling-regressions:firefox')
$artifactManifestParametersValid = Test-ArtifactManifestParameterContract $readinessAst
Add-PolicyCheck 'READINESS_ARTIFACT_MANIFEST_PARAMETERS' $artifactManifestParametersValid 'Readiness must require non-defaulted ArtifactManifestPath and lowercase-64 ArtifactManifestSha256 parameters before any packaged signaling run.'
$blockingRecords['READINESS_SIGNALING_EDGE'] = $edgeRecord
$blockingRecords['READINESS_SIGNALING_FIREFOX'] = $firefoxRecord
Add-PolicyCheck 'READINESS_SIGNALING_EDGE' $edgeRecordValid 'Edge signaling must have one exact top-level immutable-runner record forwarding publisher, manifest path, and manifest SHA-256, followed by an immediate allPass binding.'
Add-PolicyCheck 'READINESS_SIGNALING_FIREFOX' $firefoxRecordValid 'Firefox signaling must have one exact top-level immutable-runner record forwarding publisher, manifest path, and manifest SHA-256, followed by an immediate allPass binding.'

$fixtureAliasAssignments = @(
    Get-AstNodes $readinessAst ([System.Management.Automation.Language.AssignmentStatementAst]) |
        Where-Object { Test-AssignmentDefinesExactNpmRunAlias $_ 'gate:signaling-media-fixture' }
)
$fixtureInvocationRecords = @(Get-ExactTopLevelFixtureInvocation $readinessAst)
$fixtureSemanticInvocations = @(Get-SemanticNpmRunAliasInvocations $readinessAst 'gate:signaling-media-fixture')
$fixtureStructureValid = $fixtureAliasAssignments.Count -eq 1 -and
    $fixtureInvocationRecords.Count -eq 1 -and
    $fixtureSemanticInvocations.Count -eq 1 -and
    [object]::ReferenceEquals($fixtureSemanticInvocations[0], $fixtureInvocationRecords[0].invocation) -and
    (Test-OwnedNpmInvocationInventory $readinessAst)
$fixtureInvocationRecord = if ($fixtureInvocationRecords.Count -eq 1) { $fixtureInvocationRecords[0] } else { $null }
$preFixtureExecutionValid = if ($fixtureInvocationRecord) {
    Test-PreFixtureExecutionAllowlist $readinessAst $fixtureInvocationRecord
} else {
    $true
}
Add-PolicyCheck 'READINESS_PRE_FIXTURE_EXECUTION_ALLOWLIST' $preFixtureExecutionValid 'Before the deterministic fixture, readiness may dynamically invoke only the engine-owned Constant bindings and immutable run-step implementation; dot-sourcing, dynamic evaluation, and alternate call-operator targets are forbidden.'
$fixtureFailFastGuard = if ($fixtureStructureValid) {
    Get-ExactFixtureFailFastGuard $readinessAst $fixtureInvocationRecord
} else {
    $null
}
$rootExitReturnValid = if ($fixtureFailFastGuard) {
    Test-RootExitAndReturnAllowlist $readinessAst $fixtureFailFastGuard
} else {
    $true
}
$fixtureInvocationValid = $fixtureStructureValid -and $rootExitReturnValid
Add-PolicyCheck 'READINESS_SIGNALING_MEDIA_FIXTURE_INVOCATION' $fixtureInvocationValid 'Readiness must execute exactly one direct top-level fixture command, with no unowned process launch, dynamic-code execution, or successful root control transfer that can bypass it.'
$fixtureFailFastValid = if ($fixtureStructureValid) {
    [bool]$fixtureFailFastGuard -and (Test-NoRootTrapStatements $readinessAst)
} else {
    $true
}
Add-PolicyCheck 'READINESS_SIGNALING_MEDIA_FIXTURE_FAIL_FAST' $fixtureFailFastValid 'The fixture must immediately capture native status and exit with that nonzero status, with no root trap able to continue execution.'
$edgeSemanticInvocations = @(Get-SemanticNpmRunAliasInvocations $readinessAst 'e2e:signaling-regressions:edge')
$firefoxSemanticInvocations = @(Get-SemanticNpmRunAliasInvocations $readinessAst 'e2e:signaling-regressions:firefox')
$fixtureOrderValid = $true
if ($fixtureStructureValid -and $fixtureFailFastGuard) {
    $fixtureOrderValid = @($edgeSemanticInvocations + $firefoxSemanticInvocations | Where-Object {
            $_.Extent.StartOffset -le $fixtureFailFastGuard.guard.Extent.EndOffset
        }).Count -eq 0
}
Add-PolicyCheck 'READINESS_SIGNALING_MEDIA_FIXTURE_ORDER' $fixtureOrderValid 'Every semantic Edge and Firefox npm invocation must occur after the exact fixture fail-fast guard; harmless alias text does not establish execution.'

$roomRecord = Get-BlockingRunStep $readinessAst @('e2e:room-alpha-ninja-plugin', 'room-alpha-ninja-plugin-e2e.ps1')
$fullRecord = Get-BlockingRunStep $readinessAst @('e2e:ninja-plugin-alpha', 'ninja-plugin-alpha-e2e.ps1')
Add-PolicyCheck 'READINESS_ROOM_ALPHA_BLOCKING' ([bool]$roomRecord) 'The two-case Room Quality/alpha workflow must be an actual failure-blocking Run-Step.'
Add-PolicyCheck 'READINESS_FULL_ALPHA_BLOCKING' ([bool]$fullRecord) 'The seven-case transparency workflow must be an actual failure-blocking Run-Step.'

$artifactKeys = @('PluginRepo', 'PublisherPath', 'SpoutSenderPath', 'ExpectedPublisherSha256', 'ExpectedPluginSha256', 'ExpectedSpoutSenderSha256')
$roomMap = @{}
$fullMap = @{}
if ($roomRecord) { $roomMap = Get-InvocationArgumentMap $roomRecord.node $roomRecord.invocation $artifactKeys }
if ($fullRecord) { $fullMap = Get-InvocationArgumentMap $fullRecord.node $fullRecord.invocation $artifactKeys }
Add-PolicyCheck 'READINESS_ALPHA_WORKFLOWS_SHARE_IDENTITIES' (Test-MapsShareExactValues $roomMap $fullMap $artifactKeys) 'The two-case and seven-case workflows must pass the exact same six path/SHA variable expressions through invoked argument lists.'
Add-PolicyCheck 'READINESS_ALPHA_IDENTITIES_STABLE_AT_CALLS' (Test-SharedArtifactBindingsStable $readinessAst $roomRecord $fullRecord $roomMap $fullMap $artifactKeys) 'Room/full alpha calls must use top-level freshly hashed identities in order, with no shared path/hash alias reassignment between invocations.'

foreach ($id in @('READINESS_ALPHA_MANIFEST', 'READINESS_ALPHA_ARTIFACT', 'READINESS_ALPHA_ANALYZER')) {
    $record = $blockingRecords[$id]
    $map = @{}
    if ($record) { $map = Get-InvocationArgumentMap $record.node $record.invocation @('PluginRepo', 'plugin-repo') }
    $value = ''
    if ($map.ContainsKey('PluginRepo')) { $value = $map['PluginRepo'] }
    if ($map.ContainsKey('plugin-repo')) { $value = $map['plugin-repo'] }
    Add-PolicyCheck ($id + '_PLUGIN_FORWARDING') ($value -ceq '$RoomAlphaPluginRepo') "$id must pass the exact RoomAlphaPluginRepo variable to its invoked static gate."
}

$noUserDefaults = (
    (Test-ExplicitPluginRepoParameter $alphaManifestAst) -and
    (Test-ExplicitPluginRepoParameter $alphaArtifactAst) -and
    (Test-ExplicitPluginRepoParameter $fullAlphaAst) -and
    (Test-ExplicitPluginRepoParameter $roomAlphaAst) -and
    $alphaAnalyzerScript -match '(?is)if\s*\([^\)]*!\s*(?:arg|pluginRepoArg)[^\)]*\)\s*\{[^\}]*\bthrow\b' -and
    $alphaAnalyzerScript -notmatch '(?is)__dirname.{0,300}ninja-plugin'
)
Add-PolicyCheck 'ALPHA_SCRIPTS_NO_LOCAL_DEFAULTS' $noUserDefaults 'Every alpha gate must require and validate an explicit PluginRepo; the analyzer must reject omission instead of resolving a local sibling/default.'

$fastCheckout = Get-NinjaCheckoutPath $fastSteps
$nightlyCheckout = Get-NinjaCheckoutPath $nightlySteps
$fastCheckoutStep = Find-NinjaCheckoutStep $fastSteps
$nightlyCheckoutStep = Find-NinjaCheckoutStep $nightlySteps

$fastRunStep = Find-UnconditionalRunStep $fastSteps '(?im)^\s*(?:\./)?native-qt/qa/run-fast-gate\.ps1\b'
$nightlyRunStep = Find-UnconditionalRunStep $nightlySteps '(?im)^\s*(?:\./)?native-qt/qa/run-nightly-soak\.ps1\b'
Add-PolicyCheck 'FAST_CI_JOB_RUNTIME' (Test-WorkflowJobUnconditionalWindows $fastWorkflow) 'Fast QA must run in an unconditional Windows job.'
Add-PolicyCheck 'NIGHTLY_CI_JOB_RUNTIME' (Test-WorkflowJobUnconditionalWindows $nightlyWorkflow) 'Nightly QA must run in an unconditional Windows job.'
Add-PolicyCheck 'FAST_CI_POWERSHELL_RUNTIME' (Test-StepUsesPwsh $fastRunStep) 'The fast PowerShell QA command must execute with shell: pwsh.'
Add-PolicyCheck 'NIGHTLY_CI_POWERSHELL_RUNTIME' (Test-StepUsesPwsh $nightlyRunStep) 'The nightly PowerShell QA command must execute with shell: pwsh.'
Add-PolicyCheck 'FAST_CI_NINJA_CHECKOUT' (-not [string]::IsNullOrWhiteSpace($fastCheckout) -and (Test-StepBefore $fastWorkflow $fastCheckoutStep $fastRunStep)) 'Fast CI must unconditionally checkout ninja-plugin to a relative path before its QA gate.'
Add-PolicyCheck 'NIGHTLY_CI_NINJA_CHECKOUT' (-not [string]::IsNullOrWhiteSpace($nightlyCheckout) -and (Test-StepBefore $nightlyWorkflow $nightlyCheckoutStep $nightlyRunStep)) 'Nightly CI must unconditionally checkout ninja-plugin to a relative path before its QA gate.'
Add-PolicyCheck 'FAST_CI_PLUGIN_FORWARDING' (Test-WorkflowPluginForwarding $fastRunStep $fastCheckout) 'Fast CI must pass its exact checked-out ninja-plugin path as -RoomAlphaPluginRepo.'
Add-PolicyCheck 'NIGHTLY_CI_PLUGIN_FORWARDING' (Test-WorkflowPluginForwarding $nightlyRunStep $nightlyCheckout) 'Nightly CI must pass its exact checked-out ninja-plugin path as -RoomAlphaPluginRepo.'

$fastReadinessInvocation = Find-ActualInvocation $fastGateAst @('run-release-readiness.ps1')
$nightlyReadinessInvocation = Find-ActualInvocation $nightlyGateAst @('run-release-readiness.ps1')
$fastForwardsPlugin = Test-InvokedHashtableValue $fastGateAst $fastReadinessInvocation 'RoomAlphaPluginRepo' '$RoomAlphaPluginRepo'
$nightlyForwardsPlugin = Test-InvokedHashtableValue $nightlyGateAst $nightlyReadinessInvocation 'RoomAlphaPluginRepo' '$RoomAlphaPluginRepo'
Add-PolicyCheck 'FAST_WRAPPER_PLUGIN_FORWARDING' ([bool]$fastReadinessInvocation -and $fastForwardsPlugin -and $fastGate -notmatch '(?i)C:\\Users\\') 'run-fast-gate.ps1 must forward its supplied RoomAlphaPluginRepo through the invoked readiness call.'
Add-PolicyCheck 'NIGHTLY_WRAPPER_PLUGIN_FORWARDING' ([bool]$nightlyReadinessInvocation -and $nightlyForwardsPlugin -and $nightlyGate -notmatch '(?i)C:\\Users\\') 'run-nightly-soak.ps1 must forward its supplied RoomAlphaPluginRepo through the invoked readiness call.'
Add-PolicyCheck 'FAST_WRAPPER_PACKAGED_ARTIFACT_FORWARDING' (Test-ComponentWrapperPackagesExactArtifact $fastGateAst) 'run-fast-gate.ps1 must package the current source snapshot and pass the exact co-located publisher manifest path/hash to readiness.'
Add-PolicyCheck 'NIGHTLY_WRAPPER_PACKAGED_ARTIFACT_FORWARDING' (Test-ComponentWrapperPackagesExactArtifact $nightlyGateAst) 'run-nightly-soak.ps1 must package the current source snapshot and pass the exact co-located publisher manifest path/hash to readiness.'

$fastSkipsPackaged = (Test-WorkflowSwitchForwarding $fastRunStep 'SkipRoomAlpha') -and
    (Test-InvokedHashtableValue $fastGateAst $fastReadinessInvocation 'SkipRoomAlpha' '$SkipRoomAlpha')
$nightlySkipsPackaged = (Test-WorkflowSwitchForwarding $nightlyRunStep 'SkipRoomAlpha') -and
    (Test-InvokedHashtableValue $nightlyGateAst $nightlyReadinessInvocation 'SkipRoomAlpha' '$SkipRoomAlpha')
Add-PolicyCheck 'FAST_COMPONENT_PACKAGED_ALPHA_SKIP' $fastSkipsPackaged 'Fast component CI must pass SkipRoomAlpha in its real workflow command and the wrapper must forward that exact switch to readiness.'
Add-PolicyCheck 'NIGHTLY_COMPONENT_PACKAGED_ALPHA_SKIP' $nightlySkipsPackaged 'Nightly component CI must pass SkipRoomAlpha in its real workflow command and the wrapper must forward that exact switch to readiness.'

$fastPlaywright = Find-UnconditionalRunStep $fastSteps '(?im)^\s*(?:npx(?:\.cmd)?|npm\s+exec)\s+playwright\s+install\b[^#\r\n]*\bmsedge\b[^#\r\n]*\bfirefox\b'
$nightlyPlaywright = Find-UnconditionalRunStep $nightlySteps '(?im)^\s*(?:npx(?:\.cmd)?|npm\s+exec)\s+playwright\s+install\b[^#\r\n]*\bmsedge\b[^#\r\n]*\bfirefox\b'
Add-PolicyCheck 'FAST_CI_BROWSER_RUNTIMES' ([bool]$fastPlaywright -and (Test-StepBefore $fastWorkflow $fastPlaywright $fastRunStep)) 'Fast CI must install Playwright msedge and firefox in a real step before its QA gate.'
Add-PolicyCheck 'NIGHTLY_CI_BROWSER_RUNTIMES' ([bool]$nightlyPlaywright -and (Test-StepBefore $nightlyWorkflow $nightlyPlaywright $nightlyRunStep)) 'Nightly CI must install Playwright msedge and firefox in a real step before its QA gate.'

$policyCommandPattern = '(?im)^\s*(?:npm(?:\.cmd)?|npx(?:\.cmd)?)\b[^#\r\n]*\brun\s+gate:release-wiring\b'
$fastPolicyStep = Find-UnconditionalRunStep $fastSteps $policyCommandPattern
$nightlyPolicyStep = Find-UnconditionalRunStep $nightlySteps $policyCommandPattern
Add-PolicyCheck 'FAST_CI_RUNS_POLICY' ([bool]$fastPolicyStep -and (Test-StepBefore $fastWorkflow $fastPolicyStep $fastRunStep)) 'Fast CI must execute gate:release-wiring in a real step before its QA gate.'
Add-PolicyCheck 'NIGHTLY_CI_RUNS_POLICY' ([bool]$nightlyPolicyStep -and (Test-StepBefore $nightlyWorkflow $nightlyPolicyStep $nightlyRunStep)) 'Nightly CI must execute gate:release-wiring in a real step before its QA gate.'

$resolverStart = $readiness.IndexOf('function Resolve-PackagedPublisherExecutable', [System.StringComparison]::OrdinalIgnoreCase)
$resolverEnd = $readiness.IndexOf('function Resolve-RoomAlphaSpoutSender', [System.StringComparison]::OrdinalIgnoreCase)
$resolver = if ($resolverStart -ge 0 -and $resolverEnd -gt $resolverStart) { $readiness.Substring($resolverStart, $resolverEnd - $resolverStart) } else { '' }
$resolverExact = $resolver -and $resolver -match '(?i)IsNullOrWhiteSpace\s*\(\s*\$ExplicitPath\s*\)' -and $resolver -match '(?i)\bthrow\b' -and $resolver -notmatch '(?i)Get-ChildItem|Sort-Object\s+LastWriteTime|Select-Object\s+-First\s+1'
Add-PolicyCheck 'READINESS_EXACT_PACKAGED_PUBLISHER' ([bool]$resolverExact) 'Packaged publisher resolution must require the explicit path and never discover newest dist output.'

$installerStart = $readiness.IndexOf('$installerRan = $false', [System.StringComparison]::OrdinalIgnoreCase)
$installerEnd = $readiness.IndexOf('$lines += "## Overall"', [System.StringComparison]::OrdinalIgnoreCase)
$installer = if ($installerStart -ge 0 -and $installerEnd -gt $installerStart) { $readiness.Substring($installerStart, $installerEnd - $installerStart) } else { '' }
$installerNoDiscovery = $installer -and $installer -notmatch '(?i)Get-ChildItem|game-capture-\*-win64|Sort-Object\s+LastWriteTime'
$installerExact = $installer -and ($installer -match '(?i)RoomAlphaPublisherPath|\$packagedPublisher') -and ($installer -match '(?i)\$publisherExe|\$PublisherPath')
Add-PolicyCheck 'INSTALLER_NO_NEWEST_DIST' ([bool]$installerNoDiscovery) 'Installer smoke must never enumerate or select newest dist output.'
Add-PolicyCheck 'INSTALLER_EXACT_ARTIFACT' ([bool]$installerExact) 'Installer smoke must bind packaged mode and normal mode to their explicit publisher identities.'

$staleReportLeak = $buildRelease -match '(?i)release-readiness-\*\.md|\$latestReport|Latest readiness report'
Add-PolicyCheck 'BUILD_PACKAGE_NO_STALE_READINESS' (-not $staleReportLeak) 'build-release.ps1 must not embed a newest pre-existing readiness report.'

$releaseTargetVariables = @(
    'stageDir',
    'zipPath',
    'zipStablePath',
    'installerVersionedPath',
    'installerStablePath',
    'portableVersionedPath',
    'portableStablePath',
    'ffmpegSourceInfoVersionedPath',
    'ffmpegSourceInfoStablePath',
    'sourceInfoDir',
    'portableArchive'
)
Add-PolicyCheck 'BUILD_CLEARS_ALL_RELEASE_TARGETS_EARLY' (Test-BuildClearsReleaseTargetsEarly $buildReleaseAst $releaseTargetVariables) 'After release prerequisites pass, build-release.ps1 must guard and clear the stage directory, temporary archives/directories, and every versioned/stable setup, portable, zip, and FFmpeg-info target before artifact generation.'
Add-PolicyCheck 'BUILD_RELEASE_TARGET_CLEANUP_FAILURE_BLOCKING' (Test-BuildReleaseTargetCleanupFailureBlocking $buildReleaseAst $releaseTargetVariables) 'Every present release target cleanup must use a real LiteralPath Test-Path guard, fail-closed ErrorAction semantics without a swallowing catch, and a post-delete stale-path throw before generation.'
Add-PolicyCheck 'BUILD_RELEASE_PREFLIGHT_BEFORE_CLEANUP' (Test-BuildReleasePreflightBeforeCleanup $buildReleaseAst $releaseTargetVariables) 'Numeric version, current executable/version, packaging-tool discovery, and non-optional FFmpeg preflight must all pass before the first destructive release-target cleanup.'
Add-PolicyCheck 'BUILD_ALIAS_REQUIRED_TOOLS_PREFLIGHT_COHERENT' (Test-BuildAliasRequiredToolsPreflightCoherent $buildReleaseAst $releaseTargetVariables) 'Because alias identity always requires setup and portable EXEs, 7-Zip/SFX/config and NSIS must be unconditionally required before any destructive cleanup, independent of RequireReleaseArtifacts.'
Add-PolicyCheck 'BUILD_RELEASE_MANIFEST_SCHEMA_PATH' (Test-BuildReleaseManifestSchemaPath $buildReleaseAst) 'build-release.ps1 must emit release-artifact-manifest.json in the staged package with the exact v1 schema and game-capture.exe artifact path.'
Add-PolicyCheck 'BUILD_RELEASE_MANIFEST_ORDER' (Test-BuildReleaseManifestOrder $buildReleaseAst) 'The release manifest must be written after the only staged-publisher signing attempt and before the versioned ZIP, portable archive, and installer are created.'
Add-PolicyCheck 'BUILD_RELEASE_MANIFEST_UTF8_NO_BOM' (Test-BuildReleaseManifestUtf8NoBom $buildReleaseAst) 'The release manifest must be written exactly once with UTF-8 encoding configured without a byte-order mark.'
Add-PolicyCheck 'BUILD_RELEASE_MANIFEST_RELEASE_CONFIGURATION' (Test-BuildReleaseManifestReleaseConfiguration $buildReleaseAst) 'Release packaging must fail unless Configuration is exactly Release, and the manifest must record that guarded value.'
Add-PolicyCheck 'BUILD_RELEASE_MANIFEST_SOURCE_PROVENANCE' (Test-BuildReleaseManifestSourceProvenanceRequired $buildReleaseAst $buildRelease) 'The release manifest must fail closed unless commit, dirty state, snapshot SHA-256, positive file count, and named algorithm are definitive, then bind those exact values.'
Add-PolicyCheck 'BUILD_RELEASE_MANIFEST_COMPLETE_PAYLOAD' (Test-BuildReleaseManifestCompletePayload $buildReleaseAst) 'The release manifest must bind every positive-size non-reparse staged payload file except itself using normalized ordinal paths, individual SHA-256 values, exact count, and a deterministic aggregate; qt.conf must confine Qt plugin lookup to the package.'
$sourceSnapshotOwnerAst = if ($sourceSnapshotHelperPresent) { $sourceSnapshotHelperAst } else { $buildReleaseAst }
$script:sourceSnapshotBehaviorDiagnostic = ''
$sourceSnapshotDeterministic = Test-BuildReleaseSourceSnapshotDeterministic $sourceSnapshotOwnerAst
$sourceSnapshotDeterministicFailure = 'Source snapshot inputs must be ordinal-sorted and deduplicated through a SortedSet before deterministic path/size/content hashing.'
if (-not $sourceSnapshotDeterministic -and
    -not [string]::IsNullOrWhiteSpace([string]$script:sourceSnapshotBehaviorDiagnostic)) {
    $sourceSnapshotDeterministicFailure += ' Dynamic probe: ' + $script:sourceSnapshotBehaviorDiagnostic
}
Add-PolicyCheck 'BUILD_RELEASE_SOURCE_SNAPSHOT_DETERMINISTIC' $sourceSnapshotDeterministic $sourceSnapshotDeterministicFailure
Add-PolicyCheck 'BUILD_RELEASE_MANIFEST_FINAL_EXE_IDENTITY' (Test-BuildReleaseManifestFinalStagedExeIdentity $buildReleaseAst) 'Manifest artifact size and lowercase SHA-256 must be measured from the final staged game-capture.exe after its signing attempt.'
Add-PolicyCheck 'RELEASE_SOURCE_SNAPSHOT_SHARED_HELPER' (Test-SharedReleaseSourceSnapshotHelper $sourceSnapshotHelperPresent $sourceSnapshotHelperAst $buildReleaseAst $releaseAst) 'One shared release-source-snapshot helper must own deterministic snapshot computation and be dot-sourced exactly once by both build-release and release-and-publish, with no duplicate local implementation.'
Add-PolicyCheck 'RELEASE_SOURCE_SNAPSHOT_STABLE_ACROSS_BUILD' (Test-ReleaseSourceSnapshotStableAcrossBuild $releaseAst) 'Release orchestration must establish an immutable pre-package source-snapshot window, keep any recognized compile inside it, fail on hash/count/algorithm drift, and pass the first identity into packaging.'
Add-PolicyCheck 'BUILD_RELEASE_EXPECTED_SOURCE_SNAPSHOT_BINDING' (Test-BuildExpectedSourceSnapshotBinding $buildReleaseAst) 'build-release must require the orchestrator source snapshot identity and fail if its packaging-time snapshot differs before manifest emission.'
$buildRequiresArtifactsContract = Test-RequireReleaseArtifactsFinalPresenceContract $buildReleaseAst
Add-PolicyCheck 'BUILD_REQUIRE_RELEASE_ARTIFACTS_CONTRACT' $buildRequiresArtifactsContract 'build-release.ps1 must retain RequireReleaseArtifacts as a final generated-artifact presence check for release-wrapper freshness enforcement.'

$releaseExeSignInvocations = @(Get-BuildReleaseExeSignInvocations $buildReleaseAst)
$releaseExeSignText = if ($releaseExeSignInvocations.Count -eq 1) {
    (Get-HistoricalInvocationArgumentTexts $buildReleaseAst $releaseExeSignInvocations[0]) -join "`n"
} else {
    ''
}
$singleCanonicalReleaseSign = $releaseExeSignInvocations.Count -eq 1 -and
    $releaseExeSignText -match '(?i)portableVersionedPath' -and
    $releaseExeSignText -match '(?i)installerVersionedPath' -and
    $releaseExeSignText -notmatch '(?i)portableStablePath|installerStablePath' -and
    $releaseExeSignText -match '(?i)(?:^|[\s,''"`])-FilePaths(?:$|[\s,''"`])'
Add-PolicyCheck 'BUILD_VERSIONED_EXES_SIGNED_ONCE' ([bool]$singleCanonicalReleaseSign) 'build-release.ps1 must pass the versioned portable and setup EXEs together through exactly one release signing invocation, excluding stable aliases.'

$setupAliasCopies = @(Get-CopyCommandsToVariable $buildReleaseAst 'installerStablePath')
$portableAliasCopies = @(Get-CopyCommandsToVariable $buildReleaseAst 'portableStablePath')
$aliasCopySourcesExact = $setupAliasCopies.Count -eq 1 -and
    $portableAliasCopies.Count -eq 1 -and
    (Test-ExactAliasCopySource $setupAliasCopies[0] 'installerVersionedPath') -and
    (Test-ExactAliasCopySource $portableAliasCopies[0] 'portableVersionedPath')
Add-PolicyCheck 'BUILD_STABLE_EXE_ALIAS_SOURCES' ([bool]$aliasCopySourcesExact) 'Stable setup and portable aliases must each be copied exactly once from their corresponding versioned canonical EXE.'

$lastReleaseExeSignOffset = -1
if ($releaseExeSignInvocations.Count -gt 0) {
    $lastReleaseExeSignOffset = (@($releaseExeSignInvocations | Sort-Object { $_.Extent.EndOffset } -Descending)[0].Extent.EndOffset)
}
$aliasCopiesAfterSigning = $releaseExeSignInvocations.Count -eq 0 -or (
    $setupAliasCopies.Count -eq 1 -and $portableAliasCopies.Count -eq 1 -and
    $setupAliasCopies[0].Extent.StartOffset -gt $lastReleaseExeSignOffset -and
    $portableAliasCopies[0].Extent.StartOffset -gt $lastReleaseExeSignOffset
)
Add-PolicyCheck 'BUILD_STABLE_EXE_ALIASES_AFTER_SIGNING' ([bool]$aliasCopiesAfterSigning) 'Stable setup and portable aliases must be created only after the single canonical versioned-EXE signing pass.'

$allStableExeCopies = @($setupAliasCopies + $portableAliasCopies)
$aliasesImmutable = $setupAliasCopies.Count -eq 1 -and $portableAliasCopies.Count -eq 1 -and
    (Test-NoBuildAliasMutationAfterCopy $buildReleaseAst $allStableExeCopies @('installerStablePath', 'portableStablePath') @('installerVersionedPath', 'portableVersionedPath'))
Add-PolicyCheck 'BUILD_STABLE_EXE_ALIASES_IMMUTABLE_AFTER_COPY' ([bool]$aliasesImmutable) 'After stable EXE aliases are copied, build-release.ps1 must not sign, overwrite, remove, or otherwise mutate them or re-sign their canonical sources through a broad DistDir call.'

Add-PolicyCheck 'SIGN_DIST_REQUIRES_EXACT_VERSION' (Test-SignDistRequiresVersion $signArtifactsAst) 'sign-artifacts.ps1 must require a strict numeric-semver Version with manual DistDir signing so it never guesses a canonical release or accepts path-like input.'
Add-PolicyCheck 'SIGN_DIST_VERSIONED_EXES_ONLY' (Test-SignDistSelectsVersionedExesOnly $signArtifactsAst) 'The sign-artifacts.ps1 DistDir path must select only the exact versioned setup and portable EXEs for Sign-File; stable aliases must never be independently signed.'
Add-PolicyCheck 'SIGN_INPUTS_LITERAL_LEAF_ONLY' (Test-SignInputsLiteralLeafOnly $signArtifactsAst) 'Exact DistDir EXEs and every explicit FilePaths input must be rejected unless they are literal leaf files, and FilePaths resolution/Get-Item must remain literal rather than wildcard-aware.'
Add-PolicyCheck 'SIGN_DIST_REALIASES_AFTER_SIGNING' (Test-SignDistReAliasesAfterSigning $signArtifactsAst) 'After manual DistDir signing, sign-artifacts.ps1 must recreate stable setup and portable aliases from their corresponding signed versioned EXEs.'
Add-PolicyCheck 'SIGN_DIST_STABLE_ALIAS_INTEGRITY' (Test-SignDistStableAliasIntegrity $signArtifactsAst) 'Manual DistDir signing must use direct failure-blocking type/leaf/hash guards and module-qualified SHA256 hashing so stable aliases are literal files exactly matching their signed canonical EXEs.'
Add-PolicyCheck 'SIGN_AUTHENTICODE_LITERAL_PATH' (Test-SignAuthenticodeLiteralPath $signArtifactsAst) 'Every per-file signing path must directly invoke module-qualified Microsoft.PowerShell.Security\Get-AuthenticodeSignature with -LiteralPath $file.FullName immediately after Sign-File, without local shadowing.'
Add-PolicyCheck 'SIGN_AUTHENTICODE_FAILURE_POLICY' (Test-SignAuthenticodeFailurePolicy $signArtifactsAst) 'Authenticode verification must reject null, signerless, and exact hard-failure signatures, record per-file failures, and exit 1 under FailOnError while preserving best-effort default behavior.'

$buildAliasIdentityInvocation = Find-ActualInvocationWithAssignmentHistory $buildReleaseAst @('release-artifact-alias-identity-regression.ps1')
$buildAliasIdentityMap = @{}
if ($buildAliasIdentityInvocation) {
    $buildAliasIdentityMap = Get-HistoricalInvocationArgumentMap $buildReleaseAst $buildAliasIdentityInvocation @('DistDir', 'Version')
}
$buildAliasIdentityBindingsExact = $buildAliasIdentityMap.ContainsKey('DistDir') -and
    $buildAliasIdentityMap['DistDir'] -ceq '$distRoot' -and
    $buildAliasIdentityMap.ContainsKey('Version') -and
    $buildAliasIdentityMap['Version'] -ceq '$Version'
$buildAliasIdentityFfmpegPolicy = Test-AliasIdentityOptionalFfmpegForwarding $buildReleaseAst $buildAliasIdentityInvocation
$buildVirusTotalInvocation = Find-ActualInvocation $buildReleaseAst @('submit-virustotal.ps1')
$lastBuildAliasCopyOffset = -1
if ($allStableExeCopies.Count -gt 0) {
    $lastBuildAliasCopyOffset = (@($allStableExeCopies | Sort-Object { $_.Extent.EndOffset } -Descending)[0].Extent.EndOffset)
}
$buildAliasIdentityGuarded = $buildAliasIdentityInvocation -and
    (Test-CommandUnconditional $buildAliasIdentityInvocation) -and
    (Test-ImmediateFailureGuard $buildRelease $buildAliasIdentityInvocation) -and
    (Test-AliasIdentityHelperPathExact $buildReleaseAst $buildAliasIdentityInvocation) -and
    $buildAliasIdentityBindingsExact -and $buildAliasIdentityFfmpegPolicy -and
    $buildAliasIdentityInvocation.Extent.StartOffset -gt $lastBuildAliasCopyOffset -and
    $buildAliasIdentityInvocation.Extent.StartOffset -gt $lastReleaseExeSignOffset -and
    (-not $buildVirusTotalInvocation -or
        $buildAliasIdentityInvocation.Extent.StartOffset -lt $buildVirusTotalInvocation.Extent.StartOffset)
Add-PolicyCheck 'BUILD_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING' ([bool]$buildAliasIdentityGuarded) 'After final alias creation and before its own VirusTotal path, build-release.ps1 must run the exact repo alias-identity regression with $distRoot/$Version, correctly forward AllowMissingFfmpeg, and immediately throw on mismatch.'

$compileInvocation = Find-CmakeCompileInvocation $releaseAst
$buildInvocation = Find-ActualInvocation $releaseAst @('build-release.ps1')
$readinessInvocation = Find-ActualInvocation $releaseAst @('run-release-readiness.ps1')
$ghMutationInvocations = @(Find-GhReleaseMutationInvocations $releaseAst)
$publishInvocation = @($ghMutationInvocations | Sort-Object { $_.Extent.StartOffset }) | Select-Object -First 1
$compileValid = $compileInvocation -and (Test-CommandUnconditional $compileInvocation) -and (Test-ImmediateFailureGuard $releasePublish $compileInvocation)
Add-PolicyCheck 'RELEASE_FRESH_COMPILE' ([bool]$compileValid) 'release-and-publish.ps1 must freshly run failure-blocking cmake --build $BuildDir --config $Configuration before staging.'
$orderValid = $compileInvocation -and $buildInvocation -and $readinessInvocation -and $publishInvocation -and
    $compileInvocation.Extent.StartOffset -lt $buildInvocation.Extent.StartOffset -and
    $buildInvocation.Extent.StartOffset -lt $readinessInvocation.Extent.StartOffset -and
    $readinessInvocation.Extent.StartOffset -lt $publishInvocation.Extent.StartOffset -and
    (Test-ReleaseHasNoEarlySuccessfulTermination $releaseAst)
Add-PolicyCheck 'RELEASE_COMPILE_PACKAGE_VALIDATE_PUBLISH_ORDER' ([bool]$orderValid) 'Actual commands must order fresh compile, package staging, packaged readiness, then gh release.'
Add-PolicyCheck 'RELEASE_BUILD_FAILURE_BLOCKING' ([bool]($buildInvocation -and (Test-CommandUnconditional $buildInvocation) -and (Test-ImmediateFailureGuard $releasePublish $buildInvocation))) 'The actual build-release invocation must be unconditional and immediately failure-blocking.'
Add-PolicyCheck 'RELEASE_REQUIRES_FRESH_ARTIFACT_GENERATION' ([bool]($buildInvocation -and (Test-InvocationHasSwitch $releaseAst $buildInvocation 'RequireReleaseArtifacts'))) 'release-and-publish.ps1 must always pass RequireReleaseArtifacts so missing 7-Zip/NSIS cannot leave stale setup or portable files acceptable.'
Add-PolicyCheck 'RELEASE_FFMPEG_PAYLOAD_MANDATORY' (Test-ReleaseFfmpegPayloadMandatory $releaseAst) 'release-and-publish.ps1 must neither expose nor forward AllowMissingFfmpeg; published releases always require the FFmpeg payload while direct build-release dev use may retain the bypass.'
Add-PolicyCheck 'RELEASE_READINESS_FAILURE_BLOCKING' ([bool]($readinessInvocation -and (Test-CommandUnconditional $readinessInvocation) -and (Test-ImmediateFailureGuard $releasePublish $readinessInvocation))) 'The actual post-package readiness invocation must be unconditional and immediately failure-blocking.'

$aliasIdentityInvocation = Find-ActualInvocationWithAssignmentHistory $releaseAst @('release-artifact-alias-identity-regression.ps1')
$aliasIdentityMap = @{}
if ($aliasIdentityInvocation) {
    $aliasIdentityMap = Get-HistoricalInvocationArgumentMap $releaseAst $aliasIdentityInvocation @('DistDir', 'Version')
}
$aliasIdentityBindingsExact = $aliasIdentityMap.ContainsKey('DistDir') -and
    $aliasIdentityMap['DistDir'] -ceq '$distRoot' -and
    $aliasIdentityMap.ContainsKey('Version') -and
    $aliasIdentityMap['Version'] -ceq '$Version'
$firstVirusTotalInvocation = Find-ActualInvocation $releaseAst @('submit-virustotal.ps1')
$aliasIdentityGuarded = $aliasIdentityInvocation -and
    (Test-CommandUnconditional $aliasIdentityInvocation) -and
    (Test-ImmediateFailureGuard $releasePublish $aliasIdentityInvocation) -and
    (Test-AliasIdentityHelperPathExact $releaseAst $aliasIdentityInvocation) -and
    $aliasIdentityBindingsExact -and
    $buildInvocation -and $readinessInvocation -and $publishInvocation -and
    $aliasIdentityInvocation.Extent.StartOffset -gt $buildInvocation.Extent.EndOffset -and
    $aliasIdentityInvocation.Extent.StartOffset -gt $readinessInvocation.Extent.EndOffset -and
    (-not $firstVirusTotalInvocation -or
        $aliasIdentityInvocation.Extent.StartOffset -lt $firstVirusTotalInvocation.Extent.StartOffset) -and
    $aliasIdentityInvocation.Extent.StartOffset -lt $publishInvocation.Extent.StartOffset
Add-PolicyCheck 'RELEASE_ALIAS_IDENTITY_GUARD_FAILURE_BLOCKING' ([bool]$aliasIdentityGuarded) 'Before VirusTotal or any gh publication, release-and-publish.ps1 must run the exact alias-identity regression with $distRoot/$Version and immediately throw on a mismatch exit.'
$releaseArtifactVariables = @(
    'versionedSetup',
    'stableSetup',
    'versionedPortable',
    'stablePortable',
    'versionedZip',
    'stableZip',
    'versionedFfmpegSourceInfo',
    'stableFfmpegSourceInfo'
)
Add-PolicyCheck 'RELEASE_ARTIFACTS_IMMUTABLE_AFTER_IDENTITY_GUARD' (Test-NoReleaseArtifactMutationAfterIdentityGuard $releaseAst $aliasIdentityInvocation $releaseArtifactVariables) 'After the exact identity gate passes, release-and-publish.ps1 must not copy, sign, overwrite, remove, or otherwise mutate any versioned/stable release artifact before VirusTotal, GitHub publication, or completion.'

$packagedPublisherAssignment = @(
    Get-AstNodes $releaseAst ([System.Management.Automation.Language.AssignmentStatementAst]) |
        Where-Object {
            (Get-AssignmentVariableName $_) -ceq 'packagedPublisher' -and
            $_.Right.Extent.Text -match '(?i)Join-Path\s+\$distRoot\s+["'']game-capture-\$Version-win64[\\/]game-capture\.exe["'']'
        }
) | Select-Object -First 1
Add-PolicyCheck 'RELEASE_EXACT_VERSIONED_PUBLISHER' ([bool]$packagedPublisherAssignment) 'Release must structurally derive exact dist/game-capture-$Version-win64/game-capture.exe.'
Add-PolicyCheck 'RELEASE_MANIFEST_COLOCATED_PATH' (Test-ReleaseManifestCoLocatedPath $releaseAst) 'Release must derive the exact co-located release-artifact-manifest.json from packagedPublisher and reject a missing or non-file path.'
Add-PolicyCheck 'RELEASE_MANIFEST_SHA256_BINDING' (Test-ReleaseManifestSha256Binding $releaseAst) 'Release must module-hash the exact manifest path with SHA-256, lowercase it, and reject any non-lowercase-64 result before readiness.'

$pluginGuard = (Test-MandatoryParameter $releaseAst 'RoomAlphaPluginRepo') -and (Test-VariableThrowGuard $releaseAst 'RoomAlphaPluginRepo')
$buildStagesSpout = $buildRelease -match '(?is)(?:Copy-Item|Stage)[^\r\n]{0,240}spout_test_sender\.exe'
$spoutGuard = (Test-MandatoryParameter $releaseAst 'RoomAlphaSpoutSenderPath') -and (Test-VariableThrowGuard $releaseAst 'RoomAlphaSpoutSenderPath')
Add-PolicyCheck 'RELEASE_PLUGIN_GUARD' $pluginGuard 'Release must structurally require and reject an empty RoomAlphaPluginRepo.'
Add-PolicyCheck 'RELEASE_SPOUT_GUARD' ($buildStagesSpout -or $spoutGuard) 'Release must stage Spout deterministically or structurally require and reject an empty RoomAlphaSpoutSenderPath.'

$releaseMap = @{}
if ($readinessInvocation) {
    $releaseMap = Get-InvocationArgumentMap $releaseAst $readinessInvocation @('PublisherPath', 'RoomAlphaPublisherPath', 'RoomAlphaPluginRepo', 'RoomAlphaSpoutSenderPath', 'ArtifactManifestPath', 'ArtifactManifestSha256')
}
$releaseBindings = $releaseMap.ContainsKey('PublisherPath') -and $releaseMap['PublisherPath'] -ceq '$packagedPublisher' -and
    $releaseMap.ContainsKey('RoomAlphaPublisherPath') -and $releaseMap['RoomAlphaPublisherPath'] -ceq '$packagedPublisher' -and
    $releaseMap.ContainsKey('ArtifactManifestPath') -and $releaseMap['ArtifactManifestPath'] -ceq '$artifactManifestPath' -and
    $releaseMap.ContainsKey('ArtifactManifestSha256') -and $releaseMap['ArtifactManifestSha256'] -ceq '$artifactManifestSha256' -and
    $releaseMap.ContainsKey('RoomAlphaPluginRepo') -and $releaseMap['RoomAlphaPluginRepo'] -ceq '$RoomAlphaPluginRepo' -and
    ($buildStagesSpout -or ($releaseMap.ContainsKey('RoomAlphaSpoutSenderPath') -and $releaseMap['RoomAlphaSpoutSenderPath'] -ceq '$RoomAlphaSpoutSenderPath'))
$releaseReadinessInputsImmutable = $true
$releaseManifestHashAssignment = Get-UniqueTopLevelAssignment $releaseAst 'artifactManifestSha256'
if ($releaseManifestHashAssignment -and $readinessInvocation) {
    $releaseReadinessInputsImmutable = Test-NoProtectedPathMutationInRange `
        $releaseAst @('packagedPublisher', 'artifactManifestPath', 'artifactManifestSha256') `
        $releaseManifestHashAssignment.Extent.EndOffset `
        ($readinessInvocation.Extent.EndOffset + 1)
}
$releaseBindings = $releaseBindings -and $releaseReadinessInputsImmutable
Add-PolicyCheck 'RELEASE_EXACT_READINESS_BINDINGS' $releaseBindings 'The actual readiness invocation must bind both publisher arguments, exact co-located manifest path/hash, and exact plugin/Spout variables.'
$releaseHasSkip = $releasePublish -match '(?i)SkipRoomAlpha|SkipPackaged(?:Validation|Readiness|Alpha)|SkipShippedValidation'
Add-PolicyCheck 'RELEASE_PACKAGED_VALIDATION_MANDATORY' ([bool]($readinessInvocation -and (Test-CommandUnconditional $readinessInvocation) -and -not $releaseHasSkip)) 'Packaged validation must be an unconditional non-skippable release command.'

$virusTotalInvocations = @(Find-ActualInvocations $releaseAst @('submit-virustotal.ps1'))
$postReadinessVirusTotal = @(
    $virusTotalInvocations | Where-Object {
        $readinessInvocation -and $publishInvocation -and
        $_.Extent.StartOffset -gt $readinessInvocation.Extent.StartOffset -and
        $_.Extent.StartOffset -lt $publishInvocation.Extent.StartOffset
    }
) | Select-Object -First 1
$buildForcesVirusTotalSkip = $buildInvocation -and (Test-InvocationHasSwitch $releaseAst $buildInvocation 'SkipVirusTotal')
Add-PolicyCheck 'RELEASE_BUILD_FORCES_EARLY_VT_SKIP' ([bool]$buildForcesVirusTotalSkip) 'The actual build-release invocation must always include -SkipVirusTotal so staging cannot submit before packaged readiness.'
$virusTotalPostReadiness = $virusTotalInvocations.Count -eq 1 -and $postReadinessVirusTotal -and
    (Test-ImmediateFailureGuard $releasePublish $readinessInvocation)
Add-PolicyCheck 'RELEASE_VT_SINGLE_POST_READINESS_CALL' ([bool]$virusTotalPostReadiness) 'Exactly one checked submit-virustotal invocation may exist, after successful packaged readiness and before the first gh release command.'
$skipVirusTotalParameter = @(
    Get-AstNodes $releaseAst ([System.Management.Automation.Language.ParameterAst]) |
        Where-Object {
            $_.Name.VariablePath.UserPath -ieq 'SkipVirusTotal' -and
            $_.StaticType -eq [System.Management.Automation.SwitchParameter]
        }
) | Select-Object -First 1
Add-PolicyCheck 'RELEASE_VT_EXPLICIT_SKIP_GUARD' ([bool]($skipVirusTotalParameter -and (Test-CommandGuardedByNegativeSwitch $postReadinessVirusTotal 'SkipVirusTotal'))) 'The post-readiness VirusTotal call must be controlled by the caller-facing negative SkipVirusTotal switch.'
$virusTotalMap = @{}
if ($postReadinessVirusTotal) {
    $virusTotalMap = Get-InvocationArgumentMap $releaseAst $postReadinessVirusTotal @('DistDir', 'Version')
}
$virusTotalExactBindings = $virusTotalMap.ContainsKey('DistDir') -and $virusTotalMap['DistDir'] -ceq '$distRoot' -and
    $virusTotalMap.ContainsKey('Version') -and $virusTotalMap['Version'] -ceq '$Version'
Add-PolicyCheck 'RELEASE_VT_EXACT_VERSIONED_BINDINGS' $virusTotalExactBindings 'The checked VirusTotal call must receive the exact release $distRoot and $Version variables.'
Add-PolicyCheck 'RELEASE_VT_BEST_EFFORT_EXPLICITLY_HANDLED' ([bool](Test-ImmediateWarningHandler $releasePublish $postReadinessVirusTotal)) 'VirusTotal must immediately capture its exit status and emit an explicit warning on failure while remaining non-blocking.'

$uploadInvocations = @($ghMutationInvocations | Where-Object { Test-GhReleaseSubcommand $_ 'upload' })
$editInvocations = @($ghMutationInvocations | Where-Object { Test-GhReleaseSubcommand $_ 'edit' })
$createInvocations = @($ghMutationInvocations | Where-Object { Test-GhReleaseSubcommand $_ 'create' })
$uploadBlocking = $uploadInvocations.Count -eq 1 -and (Test-ImmediateFailureGuard $releasePublish $uploadInvocations[0])
$editBlocking = $editInvocations.Count -eq 1 -and (Test-ImmediateFailureGuard $releasePublish $editInvocations[0])
$createBlocking = $createInvocations.Count -eq 1 -and (Test-ImmediateFailureGuard $releasePublish $createInvocations[0])
Add-PolicyCheck 'RELEASE_GH_UPLOAD_FAILURE_BLOCKING' ([bool]$uploadBlocking) 'The single gh release upload command must immediately capture its own exit and throw on failure.'
Add-PolicyCheck 'RELEASE_GH_EDIT_FAILURE_BLOCKING' ([bool]$editBlocking) 'The single gh release edit command must immediately capture its own exit and throw on failure.'
Add-PolicyCheck 'RELEASE_GH_CREATE_FAILURE_BLOCKING' ([bool]$createBlocking) 'The single gh release create command must immediately capture its own exit and throw on failure.'
$lastGhOffset = -1
if ($ghMutationInvocations.Count -gt 0) {
    $lastGhOffset = (@($ghMutationInvocations | Sort-Object { $_.Extent.StartOffset } -Descending)[0].Extent.StartOffset)
}
$notesRemoval = @(
    Get-AstNodes $releaseAst ([System.Management.Automation.Language.CommandAst]) | Where-Object {
        $_.GetCommandName() -ieq 'Remove-Item' -and $_.Extent.Text -match '(?i)\$notesPath\b'
    }
) | Select-Object -First 1
$successWrite = @(
    Get-AstNodes $releaseAst ([System.Management.Automation.Language.CommandAst]) | Where-Object {
        $_.GetCommandName() -ieq 'Write-Host' -and $_.Extent.Text -match '(?i)Release completed'
    }
) | Select-Object -First 1
$successAfterGh = $uploadBlocking -and $editBlocking -and $createBlocking -and $notesRemoval -and $successWrite -and
    $notesRemoval.Extent.StartOffset -gt $lastGhOffset -and $successWrite.Extent.StartOffset -gt $notesRemoval.Extent.StartOffset
Add-PolicyCheck 'RELEASE_GH_SUCCESS_ONLY_AFTER_GUARDS' ([bool]$successAfterGh) 'Release notes deletion and success reporting must occur only after all guarded gh mutations.'

$failed = @($checks | Where-Object { -not $_.ok })
$terminalEvidence = [pscustomobject]@{
    state = 'complete'
    nonce = $TerminalEvidenceNonce
    checkCount = $checks.Count
    failedCount = $failed.Count
}
if ($Json) {
    [pscustomobject]@{
        ok = $failed.Count -eq 0
        checks = @($checks | ForEach-Object { $_ })
        summary = [pscustomobject]@{ total = $checks.Count; passed = $checks.Count - $failed.Count; failed = $failed.Count }
        terminalEvidence = $terminalEvidence
    } | ConvertTo-Json -Depth 6
} else {
    foreach ($check in $checks) {
        if ($check.ok) { Write-Host ("[PASS] {0}" -f $check.id) }
        else { Write-Host ("[FAIL] {0}: {1}" -f $check.id, $check.failure) }
    }
    Write-Host ("[RELEASE-WIRING] checks={0} passed={1} failed={2}" -f $checks.Count, ($checks.Count - $failed.Count), $failed.Count)
    if ($failed.Count -eq 0) { Write-Host '[RELEASE-WIRING] PASS' }
    Write-Host ("[RELEASE-WIRING TERMINAL] state=complete nonce={0} checks={1} failed={2}" -f $TerminalEvidenceNonce, $checks.Count, $failed.Count)
}
if ($failed.Count -gt 0) { exit 1 }
