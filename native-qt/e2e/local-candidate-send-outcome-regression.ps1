param(
    [string]$SourcePath = (Join-Path $PSScriptRoot '..\src\app\versus_app.cpp'),
    [string]$HeaderPath = (Join-Path $PSScriptRoot '..\include\versus\app\versus_app.h'),
    [string]$WebRtcSourcePath = (Join-Path $PSScriptRoot '..\src\webrtc\webrtc_client.cpp'),
    [string]$WebRtcHeaderPath = (Join-Path $PSScriptRoot '..\include\versus\webrtc\webrtc_client.h'),
    [string]$PackagedE2ePath = (Join-Path $PSScriptRoot 'signaling-regressions-e2e.js')
)

$ErrorActionPreference = 'Stop'

function Fail-Policy {
    param(
        [string]$Id,
        [string]$Detail
    )

    # Emit the machine-readable policy ID on stdout without PowerShell's
    # ErrorRecord formatting. The mutation harness must be able to attribute
    # every intentional red result to exactly one policy.
    [Console]::Out.WriteLine("[{0}] {1}", $Id, $Detail)
    exit 1
}

$resolvedSource = (Resolve-Path -LiteralPath $SourcePath).Path
$resolvedHeader = (Resolve-Path -LiteralPath $HeaderPath).Path
$resolvedWebRtcSource = (Resolve-Path -LiteralPath $WebRtcSourcePath).Path
$resolvedWebRtcHeader = (Resolve-Path -LiteralPath $WebRtcHeaderPath).Path
$resolvedPackagedE2e = (Resolve-Path -LiteralPath $PackagedE2ePath).Path
$source = Get-Content -LiteralPath $resolvedSource -Raw
$header = Get-Content -LiteralPath $resolvedHeader -Raw
$webRtcSource = Get-Content -LiteralPath $resolvedWebRtcSource -Raw
$webRtcHeader = Get-Content -LiteralPath $resolvedWebRtcHeader -Raw
$packagedE2e = Get-Content -LiteralPath $resolvedPackagedE2e -Raw

$intrinsicPolicyPath = Join-Path $PSScriptRoot 'candidate-evidence-intrinsic-integrity.js'
if (-not (Test-Path -LiteralPath $intrinsicPolicyPath -PathType Leaf)) {
    Fail-Policy `
        'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN' `
        'The load-bearing JavaScript intrinsic-integrity analyzer is missing.'
}
$previousErrorActionPreference = $ErrorActionPreference
try {
    # A non-zero analyzer result is an expected policy verdict, not a
    # PowerShell transport error. Capture it before restoring fail-fast mode.
    $ErrorActionPreference = 'Continue'
    $intrinsicPolicyOutput =
        & node.exe $intrinsicPolicyPath $resolvedPackagedE2e 2>&1 | Out-String
    $intrinsicPolicyExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($intrinsicPolicyExitCode -ne 0) {
    Fail-Policy `
        'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN' `
        ("Candidate evidence can mutate a load-bearing JavaScript member. " +
            $intrinsicPolicyOutput.Trim())
}

$diagnosticsStart = $packagedE2e.IndexOf(
    'function readDiagnosticsPeerSnapshot(',
    [System.StringComparison]::Ordinal)
$diagnosticsEnd = if ($diagnosticsStart -ge 0) {
    $packagedE2e.IndexOf(
        'function sessionlessWssDownstreamState(',
        $diagnosticsStart,
        [System.StringComparison]::Ordinal)
} else {
    -1
}
if ($diagnosticsStart -lt 0 -or $diagnosticsEnd -le $diagnosticsStart) {
    Fail-Policy `
        'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN' `
        'Could not isolate the diagnostics snapshot reader from the packaged workflow.'
}
$diagnosticsReader = $packagedE2e.Substring(
    $diagnosticsStart,
    $diagnosticsEnd - $diagnosticsStart)

$dispatchStart = $source.IndexOf(
    'bool VersusApp::dispatchPeerCandidateToSignaling(',
    [System.StringComparison]::Ordinal)
$dispatchEnd = if ($dispatchStart -ge 0) {
    $source.IndexOf(
        'bool VersusApp::sendPeerOffer(',
        $dispatchStart,
        [System.StringComparison]::Ordinal)
} else {
    -1
}
if ($dispatchStart -lt 0 -or $dispatchEnd -le $dispatchStart) {
    Fail-Policy `
        'LOCAL_CANDIDATE_SHARED_OUTCOME_BOUNDARY' `
        'Could not isolate the shared candidate-send boundary from the production source.'
}
$dispatchBoundary = $source.Substring($dispatchStart, $dispatchEnd - $dispatchStart)

# A bare bool-returning send is the original silent-success bug: production
# reported the candidate as sent even when encryption or transport rejected it.
$bareSends = [regex]::Matches(
    $source,
    '(?m)^\s*signaling_\.sendCandidate\s*\([^;]+\)\s*;\s*$')
if ($bareSends.Count -ne 0) {
    Fail-Policy `
        'LOCAL_CANDIDATE_SEND_RESULT_OWNERSHIP' `
        "Found $($bareSends.Count) ICE candidate send result(s) discarded by VersusApp."
}

# One shared production boundary must own the send outcome for both immediate
# trickle candidates and candidates buffered until the offer is dispatched.
$sendCalls = [regex]::Matches($source, 'signaling_\.sendCandidate\s*\(')
$sharedBoundaryReferences = [regex]::Matches(
    $source,
    'dispatchPeerCandidateToSignaling\s*\(')
if ($sendCalls.Count -ne 1 -or
    $sharedBoundaryReferences.Count -ne 3 -or
    $header -notmatch 'dispatchPeerCandidateToSignaling\s*\(') {
    Fail-Policy `
        'LOCAL_CANDIDATE_SHARED_OUTCOME_BOUNDARY' `
        'Expected one shared send boundary, its definition, and both production call paths.'
}

$sentIncrements = [regex]::Matches(
    $dispatchBoundary,
    'localCandidatesSent\.fetch_add\s*\(\s*1\s*,\s*std::memory_order_relaxed\s*\)')
if ($sentIncrements.Count -ne 1) {
    Fail-Policy `
        'LOCAL_CANDIDATE_SENT_COUNTER_TRUTH' `
        "Expected one success-owned sent-counter increment; found $($sentIncrements.Count)."
}

$failureIncrements = [regex]::Matches(
    $dispatchBoundary,
    'localCandidateSendFailures\.fetch_add\s*\(\s*1\s*,\s*std::memory_order_relaxed\s*\)')
$outcomeBranch = [regex]::Match(
    $dispatchBoundary,
    'if\s*\(\s*!signaling_\.sendCandidate\s*\(\s*candidate\s*\)\s*\)\s*\{(?<failure>[\s\S]*?)^\s*\}\s*(?<success>[\s\S]*)$',
    [System.Text.RegularExpressions.RegexOptions]::Multiline)
$preOutcome = if ($outcomeBranch.Success) {
    $dispatchBoundary.Substring(0, $outcomeBranch.Index)
} else {
    ''
}
$failureBranch = if ($outcomeBranch.Success) { $outcomeBranch.Groups['failure'].Value } else { '' }
$successBranch = if ($outcomeBranch.Success) { $outcomeBranch.Groups['success'].Value } else { '' }
$allowedPreOutcome =
    '\Abool\s+VersusApp::dispatchPeerCandidateToSignaling\s*\(\s*' +
    'const\s+std::shared_ptr<PeerSession>\s*&peer\s*,\s*' +
    'const\s+signaling::SignalCandidate\s*&candidate\s*,\s*' +
    'bool\s+relayCandidate\s*\)\s*\{\s*' +
    'if\s*\(\s*!peer\s*\)\s*\{\s*' +
    'return\s+false\s*;\s*' +
    '\}\s*\z'
if (-not $outcomeBranch.Success -or
    $preOutcome -notmatch $allowedPreOutcome -or
    $failureIncrements.Count -ne 1 -or
    $failureBranch -notmatch 'localCandidateSendFailures\.fetch_add\s*\(\s*1\s*,\s*std::memory_order_relaxed\s*\)' -or
    $failureBranch -match 'localCandidatesSent\.fetch_add' -or
    ([regex]::Matches($failureBranch, 'return\s+false\s*;')).Count -ne 1 -or
    $successBranch -notmatch 'localCandidatesSent\.fetch_add\s*\(\s*1\s*,\s*std::memory_order_relaxed\s*\)' -or
    $successBranch -match 'localCandidateSendFailures\.fetch_add' -or
    ([regex]::Matches($successBranch, 'return\s+true\s*;')).Count -ne 1 -or
    $successBranch -notmatch 'return\s+true\s*;\s*\}\s*\z' -or
    ([regex]::Matches($dispatchBoundary, 'return\s+true\s*;')).Count -ne 1 -or
    ([regex]::Matches($dispatchBoundary, 'return\s+false\s*;')).Count -ne 2 -or
    ([regex]::Matches($dispatchBoundary, 'signaling_\.sendCandidate\s*\(\s*candidate\s*\)')).Count -ne 1) {
    Fail-Policy `
        'LOCAL_CANDIDATE_BRANCH_COUNTER_OWNERSHIP' `
        'The exact send result must own failure+false versus success+true counter branches inside the shared boundary.'
}

if ($header -notmatch 'localCandidateSendFailures' -or
    $source -notmatch 'localCandidateSendFailures\.fetch_add\s*\(' -or
    $source -notmatch '"local_candidate_send_failures"' -or
    $source -notmatch 'local-candidate-send-failed') {
    Fail-Policy `
        'LOCAL_CANDIDATE_FAILURE_EVIDENCE' `
        'A rejected candidate must have a failure counter, diagnostics field, and branch-specific timeline evidence.'
}

$sentCounterMethods = @([regex]::Matches(
    $source,
    'localCandidatesSent\s*\.\s*(?<method>[A-Za-z_][A-Za-z0-9_]*)\s*\(') |
    ForEach-Object { $_.Groups['method'].Value })
$failureCounterMethods = @([regex]::Matches(
    $source,
    'localCandidateSendFailures\s*\.\s*(?<method>[A-Za-z_][A-Za-z0-9_]*)\s*\(') |
    ForEach-Object { $_.Groups['method'].Value })
if (($sentCounterMethods | Sort-Object) -join ',' -ne 'fetch_add,load' -or
    ($failureCounterMethods | Sort-Object) -join ',' -ne 'fetch_add,load' -or
    ([regex]::Matches($source, '\blocalCandidatesSent\b')).Count -ne 2 -or
    ([regex]::Matches($source, '\blocalCandidateSendFailures\b')).Count -ne 2 -or
    ([regex]::Matches($header, '\blocalCandidatesSent\b')).Count -ne 1 -or
    ([regex]::Matches($header, '\blocalCandidateSendFailures\b')).Count -ne 1 -or
    $source -match 'localCandidatesSent\s*(?:=|\+=|-=|\+\+|--)' -or
    $source -match 'localCandidateSendFailures\s*(?:=|\+=|-=|\+\+|--)' -or
    $header -notmatch 'std::atomic<int>\s+localCandidatesSent\s*\{\s*0\s*\}\s*;' -or
    $header -notmatch 'std::atomic<int>\s+localCandidateSendFailures\s*\{\s*0\s*\}\s*;') {
    Fail-Policy `
        'LOCAL_CANDIDATE_COUNTERS_ARE_MONOTONIC' `
        'Candidate outcome counters may only initialize at zero, increment once in their owned branch, and load for diagnostics.'
}

if ($source -notmatch '\{"local_candidates_sent",\s*peer->localCandidatesSent\.load\(std::memory_order_relaxed\)\}') {
    Fail-Policy `
        'LOCAL_CANDIDATE_SENT_DIAGNOSTICS_BINDING' `
        'The packaged diagnostics field must read the real per-peer sent counter; a positive literal can falsely claim that the shared send boundary executed.'
}

if ($source -notmatch '\{"local_candidate_send_failures",\s*peer->localCandidateSendFailures\.load\(std::memory_order_relaxed\)\}') {
    Fail-Policy `
        'LOCAL_CANDIDATE_DIAGNOSTICS_BINDING' `
        'The packaged diagnostics field must read the real per-peer candidate failure counter; a literal or substitute value can false-pass E2E.'
}

if (([regex]::Matches($source, '\ballBufferedCandidatesSent\b')).Count -ne 3 -or
    ([regex]::Matches(
        $source,
        'bool\s+allBufferedCandidatesSent\s*=\s*true\s*;')).Count -ne 1 -or
    ([regex]::Matches(
        $source,
        '(?<!bool\s)allBufferedCandidatesSent\s*=\s*false\s*;')).Count -ne 1 -or
    ([regex]::Matches(
        $source,
        'return\s+allBufferedCandidatesSent\s*;')).Count -ne 1) {
    Fail-Policy `
        'LOCAL_CANDIDATE_BUFFERED_FAILURE_PROPAGATION' `
        'A failed candidate buffered behind the offer must make the enclosing offer workflow report failure.'
}

# A zero failure count is only terminal after ICE gathering has completed and
# every admitted local-candidate callback has returned. Diagnostics must carry
# that state from the shared WebRtcClient layer into the packaged observation.
$terminalDiagnosticsHeader =
    'struct\s+LocalCandidateDiagnostics\s*\{[\s\S]*?' +
    'bool\s+gatheringComplete\s*=\s*false\s*;[\s\S]*?' +
    'uint32_t\s+callbacksInFlight\s*=\s*0\s*;[\s\S]*?' +
    'uint64_t\s+activitySequence\s*=\s*0\s*;[\s\S]*?\}\s*;'
if ($webRtcHeader -notmatch $terminalDiagnosticsHeader -or
    $webRtcHeader -notmatch 'LocalCandidateDiagnostics\s+localCandidateDiagnostics\(\)\s+const\s*;' -or
    $webRtcSource -notmatch 'localCandidateCallbacksInFlight' -or
    $webRtcSource -notmatch 'localCandidateActivitySequence' -or
    $webRtcSource -notmatch 'gatheringComplete\.store\(false\s*,\s*std::memory_order_release\)' -or
    $webRtcSource -notmatch 'localCandidateCallbacksInFlight\.fetch_add\s*\(\s*1' -or
    $webRtcSource -notmatch 'localCandidateCallbacksInFlight\.fetch_sub\s*\(\s*1' -or
    $webRtcSource -notmatch 'LocalCandidateDiagnostics\s+WebRtcClient::localCandidateDiagnostics\(\)\s+const' -or
    $source -notmatch 'local_candidate_gathering_complete' -or
    $source -notmatch 'local_candidate_callbacks_in_flight' -or
    $source -notmatch 'local_candidate_activity_sequence') {
    Fail-Policy `
        'LOCAL_CANDIDATE_TERMINALITY_DIAGNOSTICS' `
        'Candidate outcomes lack terminal gathering and in-flight callback diagnostics.'
}

$iceCallbackStart = $source.IndexOf(
    'peer->client->setIceCandidateCallback(',
    [System.StringComparison]::Ordinal)
$iceCallbackEnd = if ($iceCallbackStart -ge 0) {
    $source.IndexOf(
        'peer->client->setKeyframeRequestCallback(',
        $iceCallbackStart,
        [System.StringComparison]::Ordinal)
} else {
    -1
}
$completionStart = $source.IndexOf(
    'bool VersusApp::completePeerLocalCandidateWorkLocked(',
    [System.StringComparison]::Ordinal)
$completionEnd = if ($completionStart -ge 0) {
    $source.IndexOf(
        'bool VersusApp::dispatchPeerCandidateToSignaling(',
        $completionStart,
        [System.StringComparison]::Ordinal)
} else {
    -1
}
$offerStart = $source.IndexOf(
    'bool VersusApp::sendPeerOffer(',
    [System.StringComparison]::Ordinal)
$offerEnd = if ($offerStart -ge 0) {
    $source.IndexOf(
        'void VersusApp::runQueuedPeerTransition(',
        $offerStart,
        [System.StringComparison]::Ordinal)
} else {
    -1
}
if ($iceCallbackStart -lt 0 -or $iceCallbackEnd -le $iceCallbackStart -or
    $completionStart -lt 0 -or $completionEnd -le $completionStart -or
    $offerStart -lt 0 -or $offerEnd -le $offerStart) {
    Fail-Policy `
        'LOCAL_CANDIDATE_GENERATION_ACCOUNTING' `
        'Could not isolate candidate admission, completion, and offer-rotation production boundaries.'
}
$iceCallbackBoundary = $source.Substring(
    $iceCallbackStart,
    $iceCallbackEnd - $iceCallbackStart)
$completionBoundary = $source.Substring(
    $completionStart,
    $completionEnd - $completionStart)
$offerBoundary = $source.Substring($offerStart, $offerEnd - $offerStart)

# A candidate admitted for offer A may finish after offer B is reserved. The
# WebRtc layer must carry the offer context that produced the candidate and the
# App layer must retain per-generation work until every completion is owned.
# Resetting one scalar counter or clearing buffered work would make a transient
# zero look terminal and can apply A's delayed candidate to B.
if ($webRtcHeader -notmatch
        'IceCandidateCallback[\s\S]*?uint64_t\s+transportGeneration\s*,\s*uint64_t\s+localCandidateContext' -or
    $webRtcHeader -notmatch
        'std::string\s+createOffer\s*\(\s*uint64_t\s+localCandidateContext(?:\s*=\s*0)?\s*\)' -or
    $webRtcSource -notmatch
        'std::atomic<uint64_t>\s+localCandidateContext\s*\{\s*0\s*\}' -or
    $webRtcSource -notmatch
        'beginLocalCandidateGathering\s*\([^\)]*uint64_t\s+localCandidateContext' -or
    $webRtcSource -notmatch
        'target->localCandidateContext\.store\s*\(\s*localCandidateContext' -or
    $webRtcSource -notmatch
        'const\s+uint64_t\s+localCandidateContext\s*=\s*state->localCandidateContext\.load' -or
    $webRtcSource -notmatch
        '&Impl::iceCallback\s*,\s*candidate\.candidate\(\)\s*,\s*candidate\.mid\(\)\s*,\s*0\s*,\s*generation\s*,\s*localCandidateContext' -or
    $header -notmatch
        'struct\s+LocalCandidateWorkOwner\s*\{[\s\S]*?offerGeneration[\s\S]*?clientTransportGeneration[\s\S]*?wireSession[\s\S]*?\}\s*;' -or
    $header -notmatch
        'uint64_t\s+workId\s*=\s*0[\s\S]*?uint64_t\s+offerGeneration[\s\S]*?uint64_t\s+clientTransportGeneration[\s\S]*?std::string\s+wireSession' -or
    $header -notmatch
        'std::unordered_map<uint64_t,\s*LocalCandidateWorkOwner>\s+localCandidateOutstandingWork' -or
    $iceCallbackBoundary -notmatch
        'uint64_t\s+localCandidateOfferGeneration' -or
    $iceCallbackBoundary -match
        '\b(?:callbackOperationMutex|clientOperationMutex)\b' -or
    $iceCallbackBoundary -notmatch
        'candidateGeneration\s*=\s*localCandidateOfferGeneration' -or
    $iceCallbackBoundary -match
        'candidateGeneration\s*=\s*peerPtr->activeOfferGeneration' -or
    $iceCallbackBoundary -notmatch
        'localCandidateOutstandingWork\.emplace\s*\(\s*candidateWorkId' -or
    $completionBoundary -notmatch
        'localCandidateOutstandingWork\.find\s*\(\s*workId\s*\)' -or
    $completionBoundary -notmatch
        'work->second\.offerGeneration\s*==\s*offerGeneration' -or
    $completionBoundary -notmatch
        'work->second\.clientTransportGeneration\s*==\s*clientTransportGeneration' -or
    $completionBoundary -notmatch
        'work->second\.wireSession\s*==\s*wireSession' -or
    $completionBoundary -notmatch
        'localCandidateOutstandingWork\.erase\s*\(\s*work\s*\)' -or
    $completionBoundary -notmatch
        'localCandidateWorkAdmitted\s*!=[\s\S]*?localCandidateWorkCompleted\s*\+[\s\S]*?localCandidateWorkOutstanding' -or
    $offerBoundary -notmatch
        'completePeerLocalCandidateWorkLocked\s*\([\s\S]{0,260}pending\.workId[\s\S]{0,260}true' -or
    $offerBoundary -match
        'localCandidateWorkOutstanding\s*=\s*0\s*;' -or
    $offerBoundary -match
        'localCandidateAccountingViolation\s*=\s*false\s*;' -or
    $offerBoundary -match
        'peer->pendingCandidates\.clear\s*\(\s*\)\s*;' -or
    $offerBoundary -notmatch
        'peer->client->createOffer\s*\(\s*offerGeneration\s*\)') {
    Fail-Policy `
        'LOCAL_CANDIDATE_GENERATION_ACCOUNTING' `
        'Offer rotation must preserve and settle generation-tagged candidate work without reintroducing the callback-operation deadlock.'
}

# All candidate activity and gathering transitions share WebRtcClient's
# callback-dispatch order. Offer creation takes dispatch before operation to
# match re-entrant callbacks. A local candidate itself must wait through
# CallbackLease rather than taking dispatch before admission, because reset is
# allowed to retire a callback parked at the pre-admission test/lifecycle gate.
$createOfferContract =
    'std::string\s+WebRtcClient::createOffer\s*\(\s*uint64_t\s+localCandidateContext\s*\)\s*\{\s*' +
    'std::lock_guard<std::recursive_mutex>\s+callbackDispatchLock\s*\(\s*impl_->callbackDispatchMutex\s*\)\s*;\s*' +
    'std::lock_guard<std::recursive_mutex>\s+operationLock\s*\(\s*impl_->operationMutex\s*\)\s*;'
$webRtcCandidateStart = $webRtcSource.IndexOf(
    'target->pc->onLocalCandidate(',
    [System.StringComparison]::Ordinal)
$webRtcCandidateEnd = if ($webRtcCandidateStart -ge 0) {
    $webRtcSource.IndexOf(
        'target->pc->onLocalDescription(',
        $webRtcCandidateStart,
        [System.StringComparison]::Ordinal)
} else {
    -1
}
$webRtcGatheringStart = $webRtcSource.IndexOf(
    'target->pc->onGatheringStateChange(',
    [System.StringComparison]::Ordinal)
$webRtcGatheringEnd = if ($webRtcGatheringStart -ge 0) {
    $webRtcSource.IndexOf(
        'target->pc->onDataChannel(',
        $webRtcGatheringStart,
        [System.StringComparison]::Ordinal)
} else {
    -1
}
if ($webRtcCandidateStart -lt 0 -or
    $webRtcCandidateEnd -le $webRtcCandidateStart -or
    $webRtcGatheringStart -lt 0 -or
    $webRtcGatheringEnd -le $webRtcGatheringStart) {
    Fail-Policy `
        'LOCAL_CANDIDATE_CALLBACK_LOCK_ORDER' `
        'Could not isolate WebRtcClient candidate and gathering callbacks.'
}
$webRtcCandidateBoundary = $webRtcSource.Substring(
    $webRtcCandidateStart,
    $webRtcCandidateEnd - $webRtcCandidateStart)
$webRtcGatheringBoundary = $webRtcSource.Substring(
    $webRtcGatheringStart,
    $webRtcGatheringEnd - $webRtcGatheringStart)
if ($webRtcSource -notmatch $createOfferContract -or
    $webRtcCandidateBoundary -match
        'std::lock_guard<std::recursive_mutex>\s+callbackDispatchLock' -or
    $webRtcCandidateBoundary -notmatch
        'localCandidateContext\.load[\s\S]*?invokeCallback\s*\([\s\S]*?&Impl::iceCallback' -or
    $webRtcGatheringBoundary -notmatch
        'std::lock_guard<std::recursive_mutex>\s+callbackDispatchLock\s*\(\s*self->callbackDispatchMutex\s*\)[\s\S]*?gatheringComplete\.store\s*\(\s*true') {
    Fail-Policy `
        'LOCAL_CANDIDATE_CALLBACK_LOCK_ORDER' `
        'Offer creation, local-candidate callbacks, and gathering completion must share callback-dispatch ordering before operation locking.'
}

$gatheringModelStart = $webRtcSource.IndexOf(
    '    bool beginLocalCandidateGathering(',
    [System.StringComparison]::Ordinal)
$gatheringModelEnd = if ($gatheringModelStart -ge 0) {
    $webRtcSource.IndexOf(
        '    void bindPeerCallbacks(',
        $gatheringModelStart,
        [System.StringComparison]::Ordinal)
} else {
    -1
}
if ($gatheringModelStart -lt 0 -or
    $gatheringModelEnd -le $gatheringModelStart) {
    Fail-Policy `
        'LOCAL_CANDIDATE_GATHERING_STATE_MODEL' `
        'Could not isolate the local candidate gathering state model.'
}
$gatheringModelBoundary = $webRtcSource.Substring(
    $gatheringModelStart,
    $gatheringModelEnd - $gatheringModelStart)
$gatheringModelContract =
    'bool\s+beginLocalCandidateGathering\s*\([\s\S]*?gatheringState\s*=\s*target->pc->gatheringState\s*\(\s*\)[\s\S]*?GatheringState::InProgress[\s\S]*?overlappingCandidateGatheringDetected\.store\s*\(\s*true[\s\S]*?return\s+false\s*;[\s\S]*?GatheringState::New[\s\S]*?localCandidateGatheringEpoch\.fetch_add[\s\S]*?gatheringComplete\.store\s*\(\s*false[\s\S]*?else\s*\{[\s\S]*?gatheringComplete\.store\s*\(\s*true[\s\S]*?return\s+true\s*;'
if ($gatheringModelBoundary -notmatch $gatheringModelContract -or
    $webRtcSource -notmatch
        'if\s*\(\s*!impl_->beginLocalCandidateGathering\s*\([\s\S]{0,160}localCandidateContext\s*\)\s*\)\s*\{[\s\S]{0,240}return\s+\{\s*\}\s*;' -or
    $webRtcCandidateBoundary -notmatch
        'const\s+bool\s+arrivedAfterComplete\s*=[\s\S]*?gatheringComplete\.load[\s\S]*?if\s*\(\s*arrivedAfterComplete\s*\)\s*return\s*;[\s\S]*?invokeCallback') {
    Fail-Policy `
        'LOCAL_CANDIDATE_GATHERING_STATE_MODEL' `
        'Same-PC SDP changes must preserve completed ICE, reject overlapping gathers, and drop unowned candidates delivered after completion.'
}

# The shipped-artifact workflow must prove that a successful peer actually
# traversed this boundary. Diagnostics are recursively frozen before any wait
# predicate receives them, and this proof uses one canonical read-only helper.
# That structural guarantee closes all mutation APIs instead of attempting to
# blacklist individual JavaScript spellings.
$deepFreezeContract = 'function\s+deepFreezeDiagnosticsSnapshot\(value\)\s*\{\s*if\s*\(\s*!value\s*\|\|\s*typeof\s+value\s*!==\s*''object''\s*\|\|\s*Object\.isFrozen\(value\)\s*\)\s*\{\s*return\s+value\s*;\s*\}\s*for\s*\(\s*const\s+child\s+of\s+Object\.values\(value\)\s*\)\s*\{\s*deepFreezeDiagnosticsSnapshot\(child\)\s*;\s*\}\s*return\s+Object\.freeze\(value\)\s*;\s*\}'
$diagnosticsDocumentContract = 'function\s+readDiagnosticsPeerSnapshot\(diagnosticsPath,\s*uuid\)\s*\{\s*try\s*\{\s*const\s+document\s*=\s*deepFreezeDiagnosticsSnapshot\(\s*JSON\.parse\(\s*fs\.readFileSync\(diagnosticsPath,\s*''utf8''\)\s*\)\s*\)\s*;\s*const\s+matches\s*=\s*deepFreezeDiagnosticsSnapshot\(\s*\(Array\.isArray\(document\.peers\)\s*\?\s*document\.peers\s*:\s*\[\s*\]\s*\)\.filter\(\s*\(entry\)\s*=>\s*entry\s*&&\s*entry\.uuid\s*===\s*uuid\s*\)\s*\)\s*;\s*const\s+common\s*='
$diagnosticsSignalingContract = 'const\s+peer\s*=\s*matches\[0\]\s*;\s*const\s+signaling\s*=\s*deepFreezeDiagnosticsSnapshot\(\s*\{\s*\.\.\.\(peer\.signaling\s*\|\|\s*\{\s*\}\s*\)\s*\}\s*\)\s*;\s*const\s+activeWireSessionSource\s*='
$diagnosticsNotFoundToPeerContract = 'timeline:\s*\[\s*\]\s*\}\s*\)\s*;\s*\}\s*const\s+peer\s*=\s*matches\[0\]\s*;'
$candidateReadyContract = 'function\s+candidateOutcomeSnapshotReady\([\s\S]*?!!snapshot[\s\S]*?local_candidate_send_failures[\s\S]*?local_candidates_sent[\s\S]*?>\s*0\s*&&[\s\S]*?local_candidate_gathering_complete\s*===\s*true\s*&&[\s\S]*?local_candidate_callbacks_in_flight\s*===\s*0\s*&&[\s\S]*?local_candidate_activity_sequence[\s\S]*?local_candidate_gathering_epoch\s*>\s*0[\s\S]*?local_candidates_after_gathering_complete\s*===\s*0[\s\S]*?local_candidate_overlapping_gathering_detected\s*===\s*false[\s\S]*?local_candidate_work_outstanding\s*===\s*0[\s\S]*?local_candidate_work_admitted\s*>\s*0[\s\S]*?local_candidate_work_completed\s*===[\s\S]*?local_candidate_work_admitted[\s\S]*?local_candidate_work_superseded\s*>=\s*0[\s\S]*?local_candidate_retired_outstanding\s*===\s*0[\s\S]*?local_candidate_work_invariant_consistent\s*===\s*true[\s\S]*?local_candidate_work_offer_generation\s*===\s*snapshot\.signaling\.active_offer_generation[\s\S]*?local_candidate_accounting_violation\s*===\s*false[\s\S]*?local_candidate_snapshot_coherent\s*===\s*true[\s\S]*?buffered_local_candidates\s*===\s*0\s*;\s*\}'
$candidateStableContract = 'function\s+candidateOutcomeSnapshotsTerminalAndStable\([\s\S]*?candidateOutcomeSnapshotReady\(initialSnapshot,[\s\S]*?candidateOutcomeSnapshotReady\(finalSnapshot,[\s\S]*?finalSnapshot\.generatedSteadyMs\s*-\s*initialSnapshot\.generatedSteadyMs\s*<\s*4000[\s\S]*?local_candidate_activity_sequence\s*===\s*initial\.local_candidate_activity_sequence[\s\S]*?local_candidates_sent\s*===\s*initial\.local_candidates_sent[\s\S]*?local_candidate_send_failures\s*===\s*initial\.local_candidate_send_failures[\s\S]*?local_candidate_gathering_epoch\s*===\s*initial\.local_candidate_gathering_epoch[\s\S]*?local_candidates_after_gathering_complete\s*===\s*initial\.local_candidates_after_gathering_complete[\s\S]*?local_candidate_work_outstanding\s*===\s*initial\.local_candidate_work_outstanding[\s\S]*?local_candidate_work_admitted\s*===\s*initial\.local_candidate_work_admitted[\s\S]*?local_candidate_work_completed\s*===\s*initial\.local_candidate_work_completed[\s\S]*?local_candidate_work_superseded\s*===\s*initial\.local_candidate_work_superseded[\s\S]*?local_candidate_retired_outstanding\s*===[\s\S]*?initial\.local_candidate_retired_outstanding[\s\S]*?local_candidate_outcome_sequence\s*===\s*initial\.local_candidate_outcome_sequence[\s\S]*?buffered_local_candidates\s*===\s*initial\.buffered_local_candidates[\s\S]*?client_transport_generation\s*===\s*initial\.client_transport_generation\s*;\s*\}'
$candidateWaitContract = 'const\s+candidateOutcomeInitialSnapshot\s*=\s*await\s+waitForDiagnosticsPeerSnapshot\([\s\S]*?candidateOutcomeSnapshotReady\([\s\S]*?8000\s*\)\s*;\s*await\s+wait\(4000\)\s*;\s*const\s+candidateOutcomeSnapshot\s*=\s*candidateOutcomeInitialSnapshot\s*\?\s*await\s+waitForDiagnosticsPeerSnapshot\([\s\S]*?candidateOutcomeSnapshotsTerminalAndStable\([\s\S]*?candidateOutcomeInitialSnapshot\.generatedSteadyMs\s*,\s*12000\s*\)\s*:\s*null\s*;\s*const\s+candidateOutcomeTerminalAndStable\s*=\s*candidateOutcomeSnapshotsTerminalAndStable\([\s\S]*?const\s+candidateOutcomeSignaling\s*=\s*Object\.freeze'
$candidateObservationContract = 'packaged-local-candidate-send-outcomes-are-observed''\s*,\s*duplicateConnected\.ok\s*&&\s*duplicateMedia\.ok\s*&&\s*candidateOutcomeTerminalAndStable\s*&&\s*!!candidateOutcomeSnapshot[\s\S]*?observedLocalCandidateSendFailures\s*===\s*0\s*&&[\s\S]*?local_candidate_gathering_complete\s*===\s*true\s*&&[\s\S]*?local_candidate_callbacks_in_flight\s*===\s*0\s*&&[\s\S]*?Number\.isSafeInteger\(observedLocalCandidateActivitySequence\)[\s\S]*?Number\.isSafeInteger\(observedLocalCandidateWorkAdmitted\)[\s\S]*?observedLocalCandidateWorkAdmitted\s*>\s*0[\s\S]*?observedLocalCandidateWorkCompleted\s*===\s*observedLocalCandidateWorkAdmitted[\s\S]*?local_candidate_retired_outstanding\s*===\s*0[\s\S]*?local_candidate_work_invariant_consistent\s*===\s*true\s*,'

if ($packagedE2e -notmatch "packaged-local-candidate-send-outcomes-are-observed" -or
    $packagedE2e -notmatch $deepFreezeContract -or
    ([regex]::Matches($packagedE2e, 'deepFreezeDiagnosticsSnapshot\s*\(')).Count -ne 7 -or
    $diagnosticsReader -notmatch $diagnosticsDocumentContract -or
    $diagnosticsReader -notmatch $diagnosticsNotFoundToPeerContract -or
    $diagnosticsReader -notmatch $diagnosticsSignalingContract -or
    ([regex]::Matches($diagnosticsReader, '\breturn\b')).Count -ne 3 -or
    ([regex]::Matches($diagnosticsReader, 'return\s+deepFreezeDiagnosticsSnapshot\s*\(\s*\{')).Count -ne 2 -or
    ([regex]::Matches($diagnosticsReader, 'return\s+null\s*;')).Count -ne 1 -or
    $packagedE2e -notmatch 'const\s+snapshot\s*=\s*readDiagnosticsPeerSnapshot\(\s*diagnosticsPath\s*,\s*uuid\s*\)\s*;\s*if\s*\(\s*snapshot\s*&&\s*snapshot\.generatedSteadyMs\s*>\s*afterGeneratedSteadyMs\s*&&\s*predicate\(snapshot\)\s*\)' -or
    $packagedE2e -notmatch $candidateReadyContract -or
    ([regex]::Matches($packagedE2e, 'candidateOutcomeSnapshotReady\s*\(')).Count -ne 4 -or
    $packagedE2e -notmatch $candidateStableContract -or
    ([regex]::Matches($packagedE2e, 'candidateOutcomeSnapshotsTerminalAndStable\s*\(')).Count -ne 3 -or
    $packagedE2e -notmatch $candidateWaitContract -or
    $packagedE2e -notmatch $candidateObservationContract -or
    $packagedE2e -notmatch "const\s+observedLocalCandidatesSent\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidates_sent\s*\|\|\s*0\s*\)\s*;" -or
    $packagedE2e -notmatch "const\s+observedLocalCandidateSendFailures\s*=\s*Number\(\s*candidateOutcomeSignaling\.local_candidate_send_failures\s*\)\s*;" -or
    $packagedE2e -notmatch "Number\.isSafeInteger\(observedLocalCandidatesSent\)" -or
    $packagedE2e -notmatch "Number\.isSafeInteger\(observedLocalCandidateSendFailures\)" -or
    $packagedE2e -notmatch "local_candidates_sent[\s\S]{0,240}>\s*0" -or
    $packagedE2e -notmatch "observedLocalCandidateSendFailures\s*===\s*0" -or
    $packagedE2e -notmatch 'candidateOutcomeSignaling\.local_candidate_gathering_complete\s*===\s*true' -or
    $packagedE2e -notmatch 'candidateOutcomeSignaling\.local_candidate_callbacks_in_flight\s*===\s*0') {
    Fail-Policy `
        'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN' `
        'The packaged signaling workflow must observe terminal, stable ICE gathering with sent candidates and exactly zero rejected sends.'
}

Write-Host '[PASS] VersusApp and the packaged signaling workflow own every ICE candidate send result.'
exit 0
