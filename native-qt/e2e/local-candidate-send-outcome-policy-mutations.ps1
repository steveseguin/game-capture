param(
    [string]$SourcePath = (Join-Path $PSScriptRoot '..\src\app\versus_app.cpp'),
    [string]$HeaderPath = (Join-Path $PSScriptRoot '..\include\versus\app\versus_app.h'),
    [string]$WebRtcSourcePath = (Join-Path $PSScriptRoot '..\src\webrtc\webrtc_client.cpp'),
    [string]$WebRtcHeaderPath = (Join-Path $PSScriptRoot '..\include\versus\webrtc\webrtc_client.h'),
    [string]$PackagedE2ePath = (Join-Path $PSScriptRoot 'signaling-regressions-e2e.js'),
    [string]$GatePath = (Join-Path $PSScriptRoot 'local-candidate-send-outcome-regression.ps1')
)

$ErrorActionPreference = 'Stop'

function Replace-ExactlyOnce {
    param(
        [string]$Content,
        [string]$Before,
        [string]$After,
        [string]$Name
    )

    $first = $Content.IndexOf($Before, [System.StringComparison]::Ordinal)
    if ($first -lt 0 -or
        $Content.IndexOf(
            $Before,
            $first + $Before.Length,
            [System.StringComparison]::Ordinal) -ge 0) {
        throw "[$Name] Expected exactly one mutation anchor."
    }
    return $Content.Substring(0, $first) + $After +
        $Content.Substring($first + $Before.Length)
}

function Invoke-Gate {
    param(
        [string]$Source,
        [string]$Header,
        [string]$WebRtcSource,
        [string]$WebRtcHeader,
        [string]$Runner
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
            -File $resolvedGate `
            -SourcePath $Source `
            -HeaderPath $Header `
            -WebRtcSourcePath $WebRtcSource `
            -WebRtcHeaderPath $WebRtcHeader `
            -PackagedE2ePath $Runner 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = $output
    }
}

$resolvedSource = (Resolve-Path -LiteralPath $SourcePath).Path
$resolvedHeader = (Resolve-Path -LiteralPath $HeaderPath).Path
$resolvedWebRtcSource = (Resolve-Path -LiteralPath $WebRtcSourcePath).Path
$resolvedWebRtcHeader = (Resolve-Path -LiteralPath $WebRtcHeaderPath).Path
$resolvedRunner = (Resolve-Path -LiteralPath $PackagedE2ePath).Path
$resolvedGate = (Resolve-Path -LiteralPath $GatePath).Path
$source = [System.IO.File]::ReadAllText($resolvedSource)
$header = [System.IO.File]::ReadAllText($resolvedHeader)
$webRtcSource = [System.IO.File]::ReadAllText($resolvedWebRtcSource)
$webRtcHeader = [System.IO.File]::ReadAllText($resolvedWebRtcHeader)
$runner = [System.IO.File]::ReadAllText($resolvedRunner)
$nl = "`n"

$baseline = Invoke-Gate `
    $resolvedSource `
    $resolvedHeader `
    $resolvedWebRtcSource `
    $resolvedWebRtcHeader `
    $resolvedRunner
if ($baseline.ExitCode -ne 0) {
    throw "Baseline candidate-send policy must pass before mutation testing.`n$($baseline.Output)"
}

$nullGuard =
    "    if (!peer) {$nl" +
    "        return false;$nl" +
    "    }$nl"
$candidateSendGuard = $nullGuard +
    "$nl    if (!signaling_.sendCandidate(candidate)) {"
$failureIncrement =
    'peer->localCandidateSendFailures.fetch_add(1, std::memory_order_relaxed) + 1;'
$frozenClone =
    "      const candidateOutcomeSignaling = Object.freeze({$nl" +
    "        ...(candidateOutcomeSnapshot ? candidateOutcomeSnapshot.signaling : {})$nl" +
    "      });"
$candidateReadyTail =
    "    Object.prototype.hasOwnProperty.call($nl" +
    "      snapshot.signaling,$nl" +
    "      'local_candidate_send_failures'$nl" +
    "    ) && Number(snapshot.signaling.local_candidates_sent || 0) > 0 &&$nl" +
    "    snapshot.signaling.local_candidate_gathering_complete === true &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_callbacks_in_flight) &&$nl" +
    "    snapshot.signaling.local_candidate_callbacks_in_flight === 0 &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_activity_sequence) &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_gathering_epoch) &&$nl" +
    "    snapshot.signaling.local_candidate_gathering_epoch > 0 &&$nl" +
    "    Number.isSafeInteger($nl" +
    "      snapshot.signaling.local_candidates_after_gathering_complete$nl" +
    "    ) && snapshot.signaling.local_candidates_after_gathering_complete === 0 &&$nl" +
    "    snapshot.signaling.local_candidate_overlapping_gathering_detected === false &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_work_outstanding) &&$nl" +
    "    snapshot.signaling.local_candidate_work_outstanding === 0 &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_work_admitted) &&$nl" +
    "    snapshot.signaling.local_candidate_work_admitted > 0 &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_work_completed) &&$nl" +
    "    snapshot.signaling.local_candidate_work_completed ===$nl" +
    "      snapshot.signaling.local_candidate_work_admitted &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_work_superseded) &&$nl" +
    "    snapshot.signaling.local_candidate_work_superseded >= 0 &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_retired_outstanding) &&$nl" +
    "    snapshot.signaling.local_candidate_retired_outstanding === 0 &&$nl" +
    "    snapshot.signaling.local_candidate_work_invariant_consistent === true &&$nl" +
    "    snapshot.signaling.local_candidate_work_offer_generation ===$nl" +
    "      snapshot.signaling.active_offer_generation &&$nl" +
    "    Number.isSafeInteger(snapshot.signaling.local_candidate_outcome_sequence) &&$nl" +
    "    snapshot.signaling.local_candidate_accounting_violation === false &&$nl" +
    "    snapshot.signaling.local_candidate_snapshot_coherent === true &&$nl" +
    "    snapshot.signaling.buffered_local_candidates === 0;"
$notFoundFrozenReturn =
    "      return deepFreezeDiagnosticsSnapshot({$nl" +
    "        ...common,$nl" +
    "        found: false,"
$foundFrozenReturn =
    "    return deepFreezeDiagnosticsSnapshot({$nl" +
    "      ...common,$nl" +
    "      found: true,"
$frozenSignalingBinding =
    "    const peer = matches[0];$nl" +
    "    const signaling = deepFreezeDiagnosticsSnapshot({$nl" +
    "      ...(peer.signaling || {})$nl" +
    "    });$nl" +
    '    const activeWireSessionSource'
$peerBinding = '    const peer = matches[0];'
$commonBinding = '    const common = {'
$diagnosticsReaderBinding = 'function readDiagnosticsPeerSnapshot(diagnosticsPath, uuid) {'
$frozenDocumentParse =
    "    const document = deepFreezeDiagnosticsSnapshot($nl" +
    "      JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'))$nl" +
    "    );"
$mutations = @(
    [pscustomobject]@{
        Name = 'valid-peer-early-success-return'
        File = 'source'
        Before = $candidateSendGuard
        After = $nullGuard +
            "$nl    if (peer) {$nl        return true;$nl    }$nl" +
            "$nl    if (!signaling_.sendCandidate(candidate)) {"
        Expected = 'LOCAL_CANDIDATE_BRANCH_COUNTER_OWNERSHIP'
    },
    [pscustomobject]@{
        Name = 'failure-counter-dot-store-reset'
        File = 'source'
        Before = $failureIncrement
        After = $failureIncrement +
            "$nl        peer->localCandidateSendFailures.store(0, std::memory_order_relaxed);"
        Expected = 'LOCAL_CANDIDATE_COUNTERS_ARE_MONOTONIC'
    },
    [pscustomobject]@{
        Name = 'failure-counter-free-atomic-store-reset'
        File = 'source'
        Before = $failureIncrement
        After = $failureIncrement +
            "$nl        std::atomic_store(&peer->localCandidateSendFailures, 0);"
        Expected = 'LOCAL_CANDIDATE_COUNTERS_ARE_MONOTONIC'
    },
    [pscustomobject]@{
        Name = 'failure-counter-free-atomic-exchange-reset'
        File = 'source'
        Before = $failureIncrement
        After = $failureIncrement +
            "$nl        std::atomic_exchange(&peer->localCandidateSendFailures, 0);"
        Expected = 'LOCAL_CANDIDATE_COUNTERS_ARE_MONOTONIC'
    },
    [pscustomobject]@{
        Name = 'failure-counter-explicit-operator-assignment-reset'
        File = 'source'
        Before = $failureIncrement
        After = $failureIncrement +
            "$nl        peer->localCandidateSendFailures.operator=(0);"
        Expected = 'LOCAL_CANDIDATE_COUNTERS_ARE_MONOTONIC'
    },
    [pscustomobject]@{
        Name = 'failure-increment-is-zero'
        File = 'source'
        Before = $failureIncrement
        After = 'peer->localCandidateSendFailures.fetch_add(0, std::memory_order_relaxed) + 1;'
        Expected = 'LOCAL_CANDIDATE_BRANCH_COUNTER_OWNERSHIP'
    },
    [pscustomobject]@{
        Name = 'candidate-send-branch-is-short-circuited'
        File = 'source'
        Before = 'if (!signaling_.sendCandidate(candidate)) {'
        After = 'if (false && !signaling_.sendCandidate(candidate)) {'
        Expected = 'LOCAL_CANDIDATE_BRANCH_COUNTER_OWNERSHIP'
    },
    [pscustomobject]@{
        Name = 'buffered-send-failure-is-reset-before-return'
        File = 'source'
        Before = '    return allBufferedCandidatesSent;'
        After =
            "    allBufferedCandidatesSent = true;$nl" +
            '    return allBufferedCandidatesSent;'
        Expected = 'LOCAL_CANDIDATE_BUFFERED_FAILURE_PROPAGATION'
    },
    [pscustomobject]@{
        Name = 'failure-diagnostics-is-hardcoded-zero'
        File = 'source'
        Before = 'peer->localCandidateSendFailures.load(std::memory_order_relaxed)'
        After = '0'
        Expected = 'LOCAL_CANDIDATE_COUNTERS_ARE_MONOTONIC'
    },
    [pscustomobject]@{
        Name = 'sent-diagnostics-is-hardcoded-positive'
        File = 'source'
        Before = 'peer->localCandidatesSent.load(std::memory_order_relaxed)'
        After = '1'
        Expected = 'LOCAL_CANDIDATE_COUNTERS_ARE_MONOTONIC'
    },
    [pscustomobject]@{
        Name = 'candidate-offer-context-is-hardcoded-zero'
        File = 'source'
        Before = '                candidateGeneration = localCandidateOfferGeneration;'
        After = '                candidateGeneration = 0;'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'candidate-offer-context-is-read-from-active-offer'
        File = 'source'
        Before = '                candidateGeneration = localCandidateOfferGeneration;'
        After = '                candidateGeneration = peerPtr->activeOfferGeneration;'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'ice-callback-reenters-callback-operation-lock'
        File = 'source'
        Before =
            "            if (!peerPtr || candidate.empty()) {$nl" +
            "                return;$nl" +
            '            }'
        After =
            "            if (!peerPtr || candidate.empty()) {$nl" +
            "                return;$nl" +
            "            }$nl" +
            '            std::lock_guard<std::recursive_mutex> forbiddenLock(peerPtr->callbackOperationMutex);'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'ice-callback-reenters-client-operation-lock'
        File = 'source'
        Before =
            "            if (!peerPtr || candidate.empty()) {$nl" +
            "                return;$nl" +
            '            }'
        After =
            "            if (!peerPtr || candidate.empty()) {$nl" +
            "                return;$nl" +
            "            }$nl" +
            '            std::lock_guard<std::recursive_mutex> forbiddenLock(peerPtr->clientOperationMutex);'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'candidate-work-id-lookup-uses-first-entry'
        File = 'source'
        Before = '    const auto work = peer.localCandidateOutstandingWork.find(workId);'
        After = '    const auto work = peer.localCandidateOutstandingWork.begin();'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'candidate-owner-offer-generation-check-is-removed'
        File = 'source'
        Before = '        work->second.offerGeneration == offerGeneration &&'
        After = '        true &&'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'candidate-owner-transport-generation-check-is-removed'
        File = 'source'
        Before = '        work->second.clientTransportGeneration == clientTransportGeneration &&'
        After = '        true &&'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'candidate-owner-wire-session-check-is-removed'
        File = 'source'
        Before = '        work->second.wireSession == wireSession;'
        After = '        true;'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'candidate-exact-work-erase-is-removed'
        File = 'source'
        Before = '    peer.localCandidateOutstandingWork.erase(work);'
        After = '    void work;'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'candidate-accounting-invariant-check-is-removed'
        File = 'source'
        Before =
            "    if (peer.localCandidateWorkAdmitted !=$nl" +
            "        peer.localCandidateWorkCompleted +$nl" +
            "            peer.localCandidateWorkOutstanding) {$nl" +
            "        peer.localCandidateAccountingViolation = true;$nl" +
            "        return false;$nl" +
            '    }'
        After = '    return true;'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'offer-rotation-resets-outstanding-scalar'
        File = 'source'
        Before = '            offerGeneration = ++peer->activeOfferGeneration;'
        After =
            "            peer->localCandidateWorkOutstanding = 0;$nl" +
            '            offerGeneration = ++peer->activeOfferGeneration;'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'offer-rotation-clears-sticky-accounting-violation'
        File = 'source'
        Before = '            offerGeneration = ++peer->activeOfferGeneration;'
        After =
            "            peer->localCandidateAccountingViolation = false;$nl" +
            '            offerGeneration = ++peer->activeOfferGeneration;'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'offer-rotation-clears-buffered-candidates-without-settlement'
        File = 'source'
        Before = '            offerGeneration = ++peer->activeOfferGeneration;'
        After =
            "            peer->pendingCandidates.clear();$nl" +
            '            offerGeneration = ++peer->activeOfferGeneration;'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'buffered-candidate-settlement-loses-exact-work-id'
        File = 'source'
        Before =
            "                        pending.workId,$nl" +
            "                        pending.offerGeneration,$nl" +
            "                        pending.clientTransportGeneration,$nl" +
            '                        pending.wireSession,'
        After =
            "                        0,$nl" +
            "                        pending.offerGeneration,$nl" +
            "                        pending.clientTransportGeneration,$nl" +
            '                        pending.wireSession,'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'offer-creation-drops-local-candidate-context'
        File = 'source'
        Before = '            offerSdp = peer->client->createOffer(offerGeneration);'
        After = '            offerSdp = peer->client->createOffer();'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'webrtc-candidate-callback-drops-local-context'
        File = 'webrtc-source'
        Before =
            "                                 candidate.mid(),$nl" +
            "                                 0,$nl" +
            "                                 generation,$nl" +
            '                                 localCandidateContext);'
        After =
            "                                 candidate.mid(),$nl" +
            "                                 0,$nl" +
            "                                 generation,$nl" +
            '                                 0);'
        Expected = 'LOCAL_CANDIDATE_GENERATION_ACCOUNTING'
    },
    [pscustomobject]@{
        Name = 'create-offer-lock-order-is-reversed'
        File = 'webrtc-source'
        Before =
            "std::string WebRtcClient::createOffer(uint64_t localCandidateContext) {$nl" +
            "    std::lock_guard<std::recursive_mutex> callbackDispatchLock($nl" +
            "        impl_->callbackDispatchMutex);$nl" +
            '    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);'
        After =
            "std::string WebRtcClient::createOffer(uint64_t localCandidateContext) {$nl" +
            "    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);$nl" +
            "    std::lock_guard<std::recursive_mutex> callbackDispatchLock($nl" +
            '        impl_->callbackDispatchMutex);'
        Expected = 'LOCAL_CANDIDATE_CALLBACK_LOCK_ORDER'
    },
    [pscustomobject]@{
        Name = 'create-offer-callback-dispatch-lock-is-removed'
        File = 'webrtc-source'
        Before =
            "std::string WebRtcClient::createOffer(uint64_t localCandidateContext) {$nl" +
            "    std::lock_guard<std::recursive_mutex> callbackDispatchLock($nl" +
            "        impl_->callbackDispatchMutex);$nl" +
            '    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);'
        After =
            "std::string WebRtcClient::createOffer(uint64_t localCandidateContext) {$nl" +
            '    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);'
        Expected = 'LOCAL_CANDIDATE_CALLBACK_LOCK_ORDER'
    },
    [pscustomobject]@{
        Name = 'candidate-pre-admission-dispatch-lock-is-reintroduced'
        File = 'webrtc-source'
        Before =
            "            const uint64_t localCandidateContext =$nl" +
            '                state->localCandidateContext.load(std::memory_order_acquire);'
        After =
            "            std::lock_guard<std::recursive_mutex> callbackDispatchLock($nl" +
            "                self->callbackDispatchMutex);$nl" +
            "            const uint64_t localCandidateContext =$nl" +
            '                state->localCandidateContext.load(std::memory_order_acquire);'
        Expected = 'LOCAL_CANDIDATE_CALLBACK_LOCK_ORDER'
    },
    [pscustomobject]@{
        Name = 'gathering-complete-dispatch-lock-is-removed'
        File = 'webrtc-source'
        Before =
            "            if (gathering == rtc::PeerConnection::GatheringState::Complete) {$nl" +
            "                std::lock_guard<std::recursive_mutex> callbackDispatchLock($nl" +
            '                    self->callbackDispatchMutex);'
        After = '            if (gathering == rtc::PeerConnection::GatheringState::Complete) {'
        Expected = 'LOCAL_CANDIDATE_CALLBACK_LOCK_ORDER'
    },
    [pscustomobject]@{
        Name = 'overlapping-gathering-is-not-fail-closed'
        File = 'webrtc-source'
        Before =
            "            target->localCandidateActivitySequence.fetch_add($nl" +
            "                1, std::memory_order_acq_rel);$nl" +
            '            return false;'
        After =
            "            target->localCandidateActivitySequence.fetch_add($nl" +
            "                1, std::memory_order_acq_rel);$nl" +
            '            return true;'
        Expected = 'LOCAL_CANDIDATE_GATHERING_STATE_MODEL'
    },
    [pscustomobject]@{
        Name = 'completed-same-pc-gather-is-marked-incomplete'
        File = 'webrtc-source'
        Before =
            "        } else {$nl" +
            "            // libdatachannel gathers only while its state is New. A normal$nl" +
            "            // same-PC renegotiation in Complete state changes SDP/context but$nl" +
            "            // creates no second gathering-complete callback.$nl" +
            '            target->gatheringComplete.store(true, std::memory_order_release);'
        After =
            "        } else {$nl" +
            '            target->gatheringComplete.store(false, std::memory_order_release);'
        Expected = 'LOCAL_CANDIDATE_GATHERING_STATE_MODEL'
    },
    [pscustomobject]@{
        Name = 'late-candidate-fail-closed-return-is-removed'
        File = 'webrtc-source'
        Before = '            if (arrivedAfterComplete) return;'
        After = '            if (arrivedAfterComplete) { void arrivedAfterComplete; }'
        Expected = 'LOCAL_CANDIDATE_GATHERING_STATE_MODEL'
    },
    [pscustomobject]@{
        Name = 'create-offer-ignores-gathering-admission-failure'
        File = 'webrtc-source'
        Before =
            "    if (!impl_->beginLocalCandidateGathering($nl" +
            '            target, localCandidateContext)) {'
        After =
            "    if (false && !impl_->beginLocalCandidateGathering($nl" +
            '            target, localCandidateContext)) {'
        Expected = 'LOCAL_CANDIDATE_GATHERING_STATE_MODEL'
    },
    [pscustomobject]@{
        Name = 'deep-freeze-recursion-is-removed'
        File = 'runner'
        Before = '    deepFreezeDiagnosticsSnapshot(child);'
        After = '    void child;'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'deep-freeze-returns-mutable-object'
        File = 'runner'
        Before = '  return Object.freeze(value);'
        After = '  return value;'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'not-found-diagnostics-snapshot-is-not-frozen'
        File = 'runner'
        Before = $notFoundFrozenReturn
        After =
            "      return ({$nl" +
            "        ...common,$nl" +
            "        found: false,"
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'found-diagnostics-snapshot-is-not-frozen'
        File = 'runner'
        Before = $foundFrozenReturn
        After =
            "    return ({$nl" +
            "      ...common,$nl" +
            "      found: true,"
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'early-found-peer-return-forges-candidate-outcomes'
        File = 'runner'
        Before = $foundFrozenReturn
        After =
            "    if (true) {$nl" +
            "      return {$nl" +
            "        ...common,$nl" +
            "        found: true,$nl" +
            "        activeWireSession,$nl" +
            "        signaling: {$nl" +
            "          ...signaling,$nl" +
            "          local_candidates_sent: 1,$nl" +
            "          local_candidate_send_failures: 0$nl" +
            "        }$nl" +
            "      };$nl" +
            "    }$nl" +
            $foundFrozenReturn
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'raw-peer-signaling-is-forged-before-freeze'
        File = 'runner'
        Before = $peerBinding
        After =
            "    Object.assign(matches[0].signaling, {$nl" +
            "      local_candidates_sent: 1,$nl" +
            "      local_candidate_send_failures: 0$nl" +
            "    });$nl" +
            $peerBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'raw-peer-signaling-is-reflect-forged-before-freeze'
        File = 'runner'
        Before = $peerBinding
        After =
            "    Reflect.set(matches[0].signaling, 'local_candidates_sent', 1);$nl" +
            "    Reflect.set(matches[0].signaling, 'local_candidate_send_failures', 0);$nl" +
            $peerBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'diagnostics-json-reviver-forges-candidate-outcomes'
        File = 'runner'
        Before = $frozenDocumentParse
        After =
            "    const document = deepFreezeDiagnosticsSnapshot($nl" +
            "      JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'), (key, value) =>$nl" +
            "        key === 'local_candidate_send_failures' ? 0 :$nl" +
            "          (key === 'local_candidates_sent' ? 1 : value))$nl" +
            "    );"
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'mutable-matches-array-replaces-frozen-peer'
        File = 'runner'
        Before = $commonBinding
        After =
            "    matches[0] = {$nl" +
            "      ...matches[0],$nl" +
            "      signaling: {$nl" +
            "        ...(matches[0].signaling || {}),$nl" +
            "        local_candidates_sent: 1,$nl" +
            "        local_candidate_send_failures: 0$nl" +
            "      }$nl" +
            "    };$nl" +
            $commonBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'json-parse-is-proxied-before-diagnostics-read'
        File = 'runner'
        Before = $diagnosticsReaderBinding
        After =
            "JSON.parse = new Proxy(JSON.parse, {$nl" +
            "  apply(target, thisArg, args) {$nl" +
            "    const value = Reflect.apply(target, thisArg, args);$nl" +
            "    for (const peer of value.peers || []) {$nl" +
            "      peer.signaling = { ...(peer.signaling || {}), local_candidates_sent: 1, local_candidate_send_failures: 0 };$nl" +
            "    }$nl" +
            "    return value;$nl" +
            "  }$nl" +
            "});$nl$nl" +
            $diagnosticsReaderBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'aliased-json-parse-is-reassigned'
        File = 'runner'
        Before = $diagnosticsReaderBinding
        After =
            "const candidateJsonOwner = JSON;$nl" +
            "candidateJsonOwner.parse = () => ({ peers: [] });$nl$nl" +
            $diagnosticsReaderBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'json-parse-is-redefined-via-mutator'
        File = 'runner'
        Before = $diagnosticsReaderBinding
        After =
            "Object.defineProperty(JSON, 'parse', { value: () => ({ peers: [] }) });$nl$nl" +
            $diagnosticsReaderBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'assignment-alias-reassigns-json-parse'
        File = 'runner'
        Before = $diagnosticsReaderBinding
        After =
            "let candidateJsonOwner;$nl" +
            "candidateJsonOwner = JSON;$nl" +
            "const candidateOriginalParse = candidateJsonOwner.parse;$nl" +
            "candidateJsonOwner.parse = (text) => {$nl" +
            "  const value = candidateOriginalParse(text);$nl" +
            "  for (const peer of value.peers || []) {$nl" +
            "    peer.signaling = { ...(peer.signaling || {}), local_candidates_sent: 1, local_candidate_send_failures: 0 };$nl" +
            "  }$nl" +
            "  return value;$nl" +
            "};$nl$nl" +
            $diagnosticsReaderBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'global-this-json-parse-is-proxied'
        File = 'runner'
        Before = $diagnosticsReaderBinding
        After =
            "globalThis.JSON.parse = new Proxy(globalThis.JSON.parse, {$nl" +
            "  apply(target, thisArg, args) {$nl" +
            "    const value = Reflect.apply(target, thisArg, args);$nl" +
            "    for (const peer of value.peers || []) {$nl" +
            "      peer.signaling = { ...(peer.signaling || {}), local_candidates_sent: 1, local_candidate_send_failures: 0 };$nl" +
            "    }$nl" +
            "    return value;$nl" +
            "  }$nl" +
            "});$nl$nl" +
            $diagnosticsReaderBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'destructured-global-json-alias-reassigns-parse'
        File = 'runner'
        Before = $diagnosticsReaderBinding
        After =
            "const { JSON: candidateJsonOwner } = globalThis;$nl" +
            "const candidateOriginalParse = candidateJsonOwner.parse;$nl" +
            "candidateJsonOwner.parse = new Proxy(candidateOriginalParse, {$nl" +
            "  apply(target, thisArg, args) {$nl" +
            "    const value = Reflect.apply(target, thisArg, args);$nl" +
            "    for (const peer of value.peers || []) {$nl" +
            "      peer.signaling = { ...(peer.signaling || {}), local_candidates_sent: 1, local_candidate_send_failures: 0 };$nl" +
            "    }$nl" +
            "    return value;$nl" +
            "  }$nl" +
            "});$nl$nl" +
            $diagnosticsReaderBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'assignment-mutator-alias-redefines-json-parse'
        File = 'runner'
        Before = $diagnosticsReaderBinding
        After =
            "const candidateOriginalParse = JSON.parse;$nl" +
            "let candidateDefineProperty;$nl" +
            "candidateDefineProperty = Object.defineProperty;$nl" +
            "candidateDefineProperty(JSON, 'parse', { value: new Proxy(candidateOriginalParse, {$nl" +
            "  apply(target, thisArg, args) {$nl" +
            "    const value = Reflect.apply(target, thisArg, args);$nl" +
            "    for (const peer of value.peers || []) {$nl" +
            "      peer.signaling = { ...(peer.signaling || {}), local_candidates_sent: 1, local_candidate_send_failures: 0 };$nl" +
            "    }$nl" +
            "    return value;$nl" +
            "  }$nl" +
            "}) });$nl$nl" +
            $diagnosticsReaderBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'array-filter-is-proxied-before-diagnostics-read'
        File = 'runner'
        Before = $diagnosticsReaderBinding
        After =
            "Array.prototype.filter = new Proxy(Array.prototype.filter, {$nl" +
            "  apply(target, thisArg, args) {$nl" +
            "    const values = Reflect.apply(target, thisArg, args);$nl" +
            "    return values.map((entry) => entry && entry.signaling ? {$nl" +
            "      ...entry,$nl" +
            "      signaling: { ...entry.signaling, local_candidates_sent: 1, local_candidate_send_failures: 0 }$nl" +
            "    } : entry);$nl" +
            "  }$nl" +
            "});$nl$nl" +
            $diagnosticsReaderBinding
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'found-signaling-is-mutated-after-freeze-binding'
        File = 'runner'
        Before = $frozenSignalingBinding
        After =
            "    const peer = matches[0];$nl" +
            "    const signaling = deepFreezeDiagnosticsSnapshot({$nl" +
            "      ...(peer.signaling || {})$nl" +
            "    });$nl" +
            "    Object.assign(signaling, {$nl" +
            "      local_candidates_sent: 1,$nl" +
            "      local_candidate_send_failures: 0$nl" +
            "    });$nl" +
            '    const activeWireSessionSource'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'found-signaling-binding-forges-candidate-outcomes'
        File = 'runner'
        Before = $frozenSignalingBinding
        After =
            "    const peer = matches[0];$nl" +
            "    const signaling = deepFreezeDiagnosticsSnapshot({$nl" +
            "      ...(peer.signaling || {}),$nl" +
            "      local_candidates_sent: 1,$nl" +
            "      local_candidate_send_failures: 0$nl" +
            "    });$nl" +
            '    const activeWireSessionSource'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-receives-a-mutable-clone'
        File = 'runner'
        Before = 'predicate(snapshot)'
        After = 'predicate({ ...snapshot, signaling: { ...snapshot.signaling } })'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'candidate-signaling-freeze-is-removed'
        File = 'runner'
        Before = $frozenClone
        After =
            "      const candidateOutcomeSignaling = ({$nl" +
            "        ...(candidateOutcomeSnapshot ? candidateOutcomeSnapshot.signaling : {})$nl" +
            "      });"
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-forges-candidate-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && ((snapshot.signaling.local_candidate_send_failures = 0) === 0) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-object-assign-forges-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && (Object.assign(snapshot.signaling, { local_candidate_send_failures: 0 }), true) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-define-property-forges-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && (Object.defineProperty(snapshot.signaling, "local_candidate_send_failures", { value: 0, configurable: true }), true) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-reflect-set-forges-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && (Reflect.set(snapshot.signaling, "local_candidate_send_failures", 0), true) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-define-properties-forges-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && (Object.defineProperties(snapshot.signaling, { local_candidate_send_failures: { value: 0 } }), true) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-reflect-define-property-forges-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && (Reflect.defineProperty(snapshot.signaling, "local_candidate_send_failures", { value: 0 }), true) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-legacy-getter-forges-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && (snapshot.signaling.__defineGetter__("local_candidate_send_failures", () => 0), true) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-bracket-write-forges-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && ((snapshot["signaling"]["local_candidate_send_failures"] = 0) === 0) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-alias-write-forges-failure-field'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && (((target) => { target.local_candidate_send_failures = 0; return true; })(snapshot.signaling)) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'wait-predicate-replaces-signaling-object'
        File = 'runner'
        Before = $candidateReadyTail
        After = $candidateReadyTail.Replace(
            '> 0 &&',
            '> 0 && (Object.assign(snapshot, { signaling: { local_candidates_sent: 1, local_candidate_send_failures: 0 } }), true) &&')
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-stability-verdict-is-forced-true'
        File = 'runner'
        Before =
            '      const candidateOutcomeTerminalAndStable =' + $nl +
            '        candidateOutcomeSnapshotsTerminalAndStable('
        After =
            '      const candidateOutcomeTerminalAndStable = true ||' + $nl +
            '        candidateOutcomeSnapshotsTerminalAndStable('
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'failure-observation-is-forged'
        File = 'runner'
        Before =
            "      const observedLocalCandidateSendFailures = Number($nl" +
            "        candidateOutcomeSignaling.local_candidate_send_failures$nl" +
            "      );"
        After = '      const observedLocalCandidateSendFailures = 0;'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'sent-observation-is-forged'
        File = 'runner'
        Before =
            "      const observedLocalCandidatesSent = Number($nl" +
            "        candidateOutcomeSignaling.local_candidates_sent || 0$nl" +
            "      );"
        After = '      const observedLocalCandidatesSent = 1;'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'packaged-verdict-is-forced-true'
        File = 'runner'
        Before = 'duplicateConnected.ok && duplicateMedia.ok &&'
        After = 'true || duplicateConnected.ok && duplicateMedia.ok &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'failure-safe-integer-check-is-removed'
        File = 'runner'
        Before = 'Number.isSafeInteger(observedLocalCandidateSendFailures) &&'
        After = 'true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'sent-safe-integer-check-is-removed'
        File = 'runner'
        Before = 'Number.isSafeInteger(observedLocalCandidatesSent) &&'
        After = 'true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-gathering-complete-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_gathering_complete === true &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-callbacks-in-flight-zero-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_callbacks_in_flight === 0 &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-gathering-epoch-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_gathering_epoch > 0 &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-late-candidate-check-is-removed'
        File = 'runner'
        Before =
            "    ) && snapshot.signaling.local_candidates_after_gathering_complete === 0 &&$nl" +
            '    snapshot.signaling.local_candidate_overlapping_gathering_detected === false &&'
        After =
            "    ) && true &&$nl" +
            '    snapshot.signaling.local_candidate_overlapping_gathering_detected === false &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-overlapping-gathering-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_overlapping_gathering_detected === false &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-work-outstanding-zero-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_work_outstanding === 0 &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-work-admitted-positive-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_work_admitted > 0 &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-work-completion-equality-is-removed'
        File = 'runner'
        Before =
            "    snapshot.signaling.local_candidate_work_completed ===$nl" +
            '      snapshot.signaling.local_candidate_work_admitted &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-work-superseded-validity-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_work_superseded >= 0 &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-retired-work-zero-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_retired_outstanding === 0 &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-work-invariant-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_work_invariant_consistent === true &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-work-offer-generation-check-is-removed'
        File = 'runner'
        Before =
            "    snapshot.signaling.local_candidate_work_offer_generation ===$nl" +
            '      snapshot.signaling.active_offer_generation &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-accounting-violation-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_accounting_violation === false &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-snapshot-coherence-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.local_candidate_snapshot_coherent === true &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'ready-buffered-candidate-zero-check-is-removed'
        File = 'runner'
        Before = '    snapshot.signaling.buffered_local_candidates === 0;'
        After = '    true;'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-stability-window-is-removed'
        File = 'runner'
        Before = '      finalSnapshot.generatedSteadyMs - initialSnapshot.generatedSteadyMs < 4000) {'
        After = '      finalSnapshot.generatedSteadyMs - initialSnapshot.generatedSteadyMs < 0) {'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-activity-stability-check-is-removed'
        File = 'runner'
        Before =
            "  return final.local_candidate_activity_sequence ===$nl" +
            '      initial.local_candidate_activity_sequence &&'
        After = '  return true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-sent-count-stability-check-is-removed'
        File = 'runner'
        Before = '    final.local_candidates_sent === initial.local_candidates_sent &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-failure-count-stability-check-is-removed'
        File = 'runner'
        Before = '    final.local_candidate_send_failures === initial.local_candidate_send_failures &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-work-admitted-stability-check-is-removed'
        File = 'runner'
        Before = '    final.local_candidate_work_admitted === initial.local_candidate_work_admitted &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-work-completed-stability-check-is-removed'
        File = 'runner'
        Before = '    final.local_candidate_work_completed === initial.local_candidate_work_completed &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-outcome-sequence-stability-check-is-removed'
        File = 'runner'
        Before = '    final.local_candidate_outcome_sequence === initial.local_candidate_outcome_sequence &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-active-offer-stability-check-is-removed'
        File = 'runner'
        Before = '    final.active_offer_generation === initial.active_offer_generation &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-active-transport-stability-check-is-removed'
        File = 'runner'
        Before = '    final.active_transport_generation === initial.active_transport_generation &&'
        After = '    true &&'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'terminal-client-transport-stability-check-is-removed'
        File = 'runner'
        Before = '    final.client_transport_generation === initial.client_transport_generation;'
        After = '    true;'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    },
    [pscustomobject]@{
        Name = 'second-snapshot-delay-is-removed'
        File = 'runner'
        Before = '      await wait(4000);'
        After = '      await wait(0);'
        Expected = 'LOCAL_CANDIDATE_PACKAGED_SUCCESS_CHAIN'
    }
)

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
    ("game-capture-candidate-outcome-mutations-" + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $temporaryRoot -Force)
try {
    $passed = 0
    foreach ($mutation in $mutations) {
        $caseRoot = Join-Path $temporaryRoot $mutation.Name
        [void](New-Item -ItemType Directory -Path $caseRoot -Force)
        $caseSource = Join-Path $caseRoot 'versus_app.cpp'
        $caseHeader = Join-Path $caseRoot 'versus_app.h'
        $caseWebRtcSource = Join-Path $caseRoot 'webrtc_client.cpp'
        $caseWebRtcHeader = Join-Path $caseRoot 'webrtc_client.h'
        $caseRunner = Join-Path $caseRoot 'signaling-regressions-e2e.js'
        $mutatedSource = $source
        $mutatedHeader = $header
        $mutatedWebRtcSource = $webRtcSource
        $mutatedWebRtcHeader = $webRtcHeader
        $mutatedRunner = $runner
        if ($mutation.File -eq 'source') {
            $mutatedSource = Replace-ExactlyOnce `
                $source $mutation.Before $mutation.After $mutation.Name
        } elseif ($mutation.File -eq 'header') {
            $mutatedHeader = Replace-ExactlyOnce `
                $header $mutation.Before $mutation.After $mutation.Name
        } elseif ($mutation.File -eq 'webrtc-source') {
            $mutatedWebRtcSource = Replace-ExactlyOnce `
                $webRtcSource $mutation.Before $mutation.After $mutation.Name
        } elseif ($mutation.File -eq 'webrtc-header') {
            $mutatedWebRtcHeader = Replace-ExactlyOnce `
                $webRtcHeader $mutation.Before $mutation.After $mutation.Name
        } else {
            $mutatedRunner = Replace-ExactlyOnce `
                $runner $mutation.Before $mutation.After $mutation.Name
        }
        [System.IO.File]::WriteAllText($caseSource, $mutatedSource)
        [System.IO.File]::WriteAllText($caseHeader, $mutatedHeader)
        [System.IO.File]::WriteAllText($caseWebRtcSource, $mutatedWebRtcSource)
        [System.IO.File]::WriteAllText($caseWebRtcHeader, $mutatedWebRtcHeader)
        [System.IO.File]::WriteAllText($caseRunner, $mutatedRunner)

        $result = Invoke-Gate `
            $caseSource `
            $caseHeader `
            $caseWebRtcSource `
            $caseWebRtcHeader `
            $caseRunner
        $failedIds = @([regex]::Matches(
            $result.Output,
            '\[(LOCAL_CANDIDATE_[A-Z0-9_]+)\]') |
            ForEach-Object { $_.Groups[1].Value } |
            Sort-Object -Unique)
        if ($result.ExitCode -eq 0 -or
            $failedIds.Count -ne 1 -or
            $failedIds[0] -ne $mutation.Expected) {
            throw "[$($mutation.Name)] Expected only $($mutation.Expected); " +
                "exit=$($result.ExitCode) failed=$($failedIds -join ',').`n$($result.Output)"
        }
        $passed += 1
        Write-Host "[MUTATION PASS] $($mutation.Name): $($mutation.Expected)"
    }
    Write-Host "[MUTATION SUMMARY] baseline=pass mutations=$($mutations.Count) rejected=$passed"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
