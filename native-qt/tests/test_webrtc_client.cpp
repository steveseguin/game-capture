#include <QtTest/QtTest>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "versus/webrtc/webrtc_client.h"
#include "versus/app/versus_app.h"

namespace versus::webrtc {

class WebRtcClientTestAccess {
  public:
    using Hook = std::function<void(uint64_t)>;

    static void setConcurrencyHooks(WebRtcClient &client,
                                    Hook beforeVideoSend,
                                    Hook beforeCallbackAdmission,
                                    Hook afterTransportClose,
                                    Hook beforeStateCommit = {}) {
        client.setConcurrencyTestHooks(std::move(beforeVideoSend),
                                       std::move(beforeCallbackAdmission),
                                       std::move(afterTransportClose),
                                       std::move(beforeStateCommit));
    }

    static void clearConcurrencyHooks(WebRtcClient &client) {
        client.setConcurrencyTestHooks({}, {}, {}, {});
    }

    static std::pair<uint16_t, uint16_t> vp9SequenceNumbers(const WebRtcClient &client) {
        return client.vp9SequenceNumbersForTesting();
    }

    static void invokeDataMessageCallback(WebRtcClient &client,
                                          const std::string &message,
                                          uint64_t generation) {
        client.invokeDataMessageCallbackForTesting(message, generation);
    }

    static void invokeIceCandidateCallback(
        WebRtcClient &client,
        const std::string &candidate,
        const std::string &mid,
        int mlineIndex,
        uint64_t generation) {
        client.invokeIceCandidateCallbackForTesting(
            candidate,
            mid,
            mlineIndex,
            generation);
    }

    static std::size_t callbacksInFlight(const WebRtcClient &client) {
        return client.callbacksInFlightForTesting();
    }

    static void invokeStateCallback(WebRtcClient &client,
                                    ConnectionState state,
                                    uint64_t generation) {
        client.invokeStateCallbackForTesting(state, generation);
    }

    static void invokeDataChannelStateCallback(WebRtcClient &client,
                                               bool open,
                                               uint64_t generation) {
        client.invokeDataChannelStateCallbackForTesting(open, generation);
    }
};

}  // namespace versus::webrtc

namespace versus::app {

class VersusAppTestAccess {
  public:
    using OpaquePeer = std::shared_ptr<void>;
    struct OfferDispatch {
        uint64_t sequence = 0;
        uint64_t offerGeneration = 0;
        uint64_t transportGeneration = 0;
        std::string wireSession;
        std::string sdpSha256;
        std::string reason;
    };

    static OpaquePeer createPeer(VersusApp &app, const std::string &suffix = {}) {
        if (!app.initialize()) {
            return {};
        }
        auto peer = std::make_shared<VersusApp::PeerSession>();
        peer->uuid = "callback-lock-order-peer" + suffix;
        peer->session = "callback-lock-order-session" + suffix;
        peer->activeWireSession = peer->session;
        peer->streamId = "callback-lock-order-stream" + suffix;
        peer->client = std::make_unique<webrtc::WebRtcClient>();
        webrtc::PeerConfig config;
        config.enableDataChannel = true;
        config.initialVideo = true;
        config.initialAudio = true;
        config.initialAlpha = true;
        config.enableAlphaTrack = true;
        config.videoCodec = webrtc::PeerConfig::VideoCodec::VP9;
        config.iceMode = webrtc::IceMode::HostOnly;
        if (!peer->client->initialize(config)) {
            return {};
        }
        peer->clientTransportGeneration = peer->client->transportGeneration();
        peer->activeTransportGeneration = 1;
        peer->activeOfferGeneration = 1;
        peer->sessionInitializing = false;
        {
            std::lock_guard<std::mutex> lock(app.peerSessionsMutex_);
            app.peerSessions_.emplace(peer->uuid, peer);
        }
        app.installPeerOperationCallbacks(peer);
        return std::static_pointer_cast<void>(peer);
    }

    static std::shared_ptr<webrtc::WebRtcClient> stabilizePeerSignaling(
        const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer || !peer->client) {
            return {};
        }
        std::string offer;
        {
            std::lock_guard<std::mutex> lock(peer->negotiationMutex);
            offer = peer->lastLocalOfferSdp;
        }
        if (offer.empty()) {
            return {};
        }
        auto answerer = std::make_shared<webrtc::WebRtcClient>();
        webrtc::PeerConfig config;
        config.enableDataChannel = false;
        config.initialVideo = false;
        config.initialAudio = false;
        config.initialAlpha = false;
        config.enableAlphaTrack = false;
        config.iceMode = webrtc::IceMode::HostOnly;
        if (!answerer->initialize(config)) {
            return {};
        }
        const std::string answer = answerer->createAnswer(offer);
        if (answer.empty() ||
            !peer->client->setRemoteDescription(answer, "answer")) {
            answerer->shutdown();
            return {};
        }
        return answerer;
    }

    static std::unique_lock<std::recursive_mutex> lockCallbackOperation(
        const OpaquePeer &opaque) {
        return std::unique_lock<std::recursive_mutex>(
            cast(opaque)->callbackOperationMutex);
    }

    static std::unique_lock<std::recursive_mutex> lockClientOperation(
        const OpaquePeer &opaque) {
        return std::unique_lock<std::recursive_mutex>(
            cast(opaque)->clientOperationMutex);
    }

    static std::unique_lock<std::mutex> lockNegotiation(
        const OpaquePeer &opaque) {
        return std::unique_lock<std::mutex>(cast(opaque)->negotiationMutex);
    }

    static std::unique_lock<std::mutex> lockSignaling(VersusApp &app) {
        return std::unique_lock<std::mutex>(app.signalingOpsMutex_);
    }

    static void setOfferDispatched(const OpaquePeer &opaque, bool dispatched) {
        const auto peer = cast(opaque);
        if (!peer) {
            return;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        peer->offerDispatched = dispatched;
    }

    static webrtc::WebRtcClient *client(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->client.get() : nullptr;
    }

    static uint64_t generation(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return 0;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return peer->clientTransportGeneration;
    }

    static std::string peerKey(VersusApp &app, const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? app.makePeerKey(peer->uuid, peer->session) : std::string{};
    }

    static bool rebuildWhileOwningOperationMutex(
        const OpaquePeer &opaque,
        const std::function<void()> &afterLock) {
        const auto peer = cast(opaque);
        if (!peer || !peer->client) {
            return false;
        }
        std::lock_guard<std::recursive_mutex> operationLock(peer->clientOperationMutex);
        {
            std::lock_guard<std::mutex> lock(peer->negotiationMutex);
            peer->clientTransportGeneration = 0;
        }
        if (afterLock) {
            afterLock();
        }
        const bool reset = peer->client->resetPeerConnection(false, false, false);
        const uint64_t replacement = peer->client->transportGeneration();
        {
            std::lock_guard<std::mutex> lock(peer->negotiationMutex);
            if (!peer->removed && reset) {
                peer->clientTransportGeneration = replacement;
                ++peer->activeTransportGeneration;
            }
        }
        return reset;
    }

    static void whileOwningOperationMutex(
        const OpaquePeer &opaque,
        const std::function<void()> &operation) {
        const auto peer = cast(opaque);
        if (!peer) {
            return;
        }
        std::lock_guard<std::recursive_mutex> operationLock(peer->clientOperationMutex);
        operation();
    }

    static void setBeforeEnqueueHook(
        VersusApp &app,
        std::function<void(const std::string &, uint64_t)> hook) {
        std::lock_guard<std::mutex> lock(app.peerCallbackTestHookMutex_);
        app.beforePeerCallbackEnqueueForTesting_ = std::move(hook);
    }

    static void setOperationHook(
        VersusApp &app,
        std::function<bool(const std::string &, const std::string &, uint64_t)> hook) {
        std::lock_guard<std::mutex> lock(app.peerCallbackTestHookMutex_);
        app.peerCallbackOperationForTesting_ = std::move(hook);
    }

    static bool waitUntilIdle(VersusApp &app, std::chrono::milliseconds timeout) {
        return app.peerOperationExecutor_.waitUntilIdle(timeout);
    }

    static std::size_t pendingCount(VersusApp &app) {
        return app.peerOperationExecutor_.pendingCount();
    }

    static GenerationTaggedPeerOperationExecutor::Stats executorStats(
        VersusApp &app) {
        return app.peerOperationExecutor_.stats();
    }

    static void stopPeerOperationExecutor(VersusApp &app) {
        app.peerOperationExecutor_.stop();
    }

    static void setExecutorBeforeStopFinalizeHook(
        GenerationTaggedPeerOperationExecutor &executor,
        std::function<void(uint64_t)> hook) {
        std::lock_guard<std::mutex> lock(executor.mutex_);
        executor.beforeStopFinalizeForTesting_ = std::move(hook);
    }

    static uint64_t executorWorkerEpoch(
        const GenerationTaggedPeerOperationExecutor &executor) {
        std::lock_guard<std::mutex> lock(executor.mutex_);
        return executor.workerEpoch_;
    }

    static int64_t lastOverloadLogMs(const VersusApp &app) {
        return app.lastPeerOperationOverloadLogMs_.load(std::memory_order_relaxed);
    }

    static void enableTokenlessRemoteControl(VersusApp &app) {
        app.remoteControlEnabled_.store(true, std::memory_order_relaxed);
        std::lock_guard<std::mutex> lock(app.lifecycleStateMutex_);
        app.remoteControlToken_.clear();
    }

    static video::EncoderConfig configuredVideo(VersusApp &app) {
        std::lock_guard<std::mutex> lock(app.videoSendMutex_);
        return app.videoConfig_;
    }

    static bool tryPeerOperationWhileHoldingVideoSend(
        VersusApp &app,
        const OpaquePeer &opaque,
        const std::function<void()> &afterVideoLock,
        const std::function<bool()> &beginPeerAttempt,
        std::chrono::milliseconds timeout) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        std::unique_lock<std::mutex> videoLock(app.videoSendMutex_);
        if (afterVideoLock) {
            afterVideoLock();
        }
        if (!waitForPredicate(beginPeerAttempt, std::chrono::seconds(2))) {
            return false;
        }
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline) {
            if (peer->clientOperationMutex.try_lock()) {
                peer->clientOperationMutex.unlock();
                return true;
            }
            std::this_thread::yield();
        }
        return false;
    }

    static void installSyntheticEncodePeerWait(
        VersusApp &app,
        const OpaquePeer &opaque,
        const std::function<bool()> &beginPeerAttempt,
        const std::shared_ptr<std::atomic<bool>> &acquiredPeerOperation,
        std::chrono::milliseconds timeout) {
        const auto peer = cast(opaque);
        app.capturing_.store(true, std::memory_order_relaxed);
        app.encodeThreadRunning_.store(true, std::memory_order_relaxed);
        app.encodeThread_ = std::thread([
            peer,
            beginPeerAttempt,
            acquiredPeerOperation,
            timeout]() {
            if (!peer || !acquiredPeerOperation ||
                !waitForPredicate(beginPeerAttempt, std::chrono::seconds(2))) {
                return;
            }
            const auto deadline = std::chrono::steady_clock::now() + timeout;
            while (std::chrono::steady_clock::now() < deadline) {
                if (peer->clientOperationMutex.try_lock()) {
                    acquiredPeerOperation->store(true, std::memory_order_release);
                    peer->clientOperationMutex.unlock();
                    return;
                }
                std::this_thread::yield();
            }
        });
    }

    static bool capturing(const VersusApp &app) {
        return app.capturing_.load(std::memory_order_relaxed);
    }

    static void removePeer(VersusApp &app, const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (peer) {
            app.removePeerSession(peer, "callback-executor-gate-removal");
        }
    }

    static std::string ownerSession(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->session : std::string{};
    }

    static std::string activeWireSession(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return {};
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return peer->activeWireSession;
    }

    static bool transportRetired(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return true;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return peer->transportRetired;
    }

    static uint64_t activeTransportGeneration(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return 0;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return peer->activeTransportGeneration;
    }

    static uint64_t activeOfferGeneration(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return 0;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return peer->activeOfferGeneration;
    }

    static int answerCount(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer
            ? peer->answerCount.load(std::memory_order_relaxed)
            : 0;
    }

    static bool answerReceived(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return peer->answerReceived;
    }

    static bool alphaAllowed(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer && peer->alphaAllowed.load(std::memory_order_relaxed);
    }

    static std::string alphaReceiveMode(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return {};
        }
        std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
        return peer->alphaReceiveMode;
    }

    static std::string uuid(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->uuid : std::string{};
    }

    static nlohmann::json peerDiagnostics(VersusApp &app,
                                          const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return nlohmann::json::object();
        }
        const auto diagnostics = nlohmann::json::parse(
            app.buildDiagnosticsJson(),
            nullptr,
            false);
        if (diagnostics.is_discarded() || !diagnostics.contains("peers") ||
            !diagnostics["peers"].is_array()) {
            return nlohmann::json::object();
        }
        for (const auto &item : diagnostics["peers"]) {
            if (item.is_object() && item.value("uuid", std::string{}) == peer->uuid) {
                return item;
            }
        }
        return nlohmann::json::object();
    }

    static void installSignalingCallbacks(VersusApp &app) {
        app.setupSignalingCallbacks();
    }

    static void markActiveOfferAnswered(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        peer->offerCreationInProgress = false;
        peer->offerDispatched = true;
        peer->answerApplicationInProgress = false;
        peer->answerReceived = true;
        peer->answeredOfferGeneration = peer->activeOfferGeneration;
        peer->transportRetired = false;
    }

    static void markTransportRetired(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        peer->transportRetired = true;
    }

    static bool hasUnresolvedOffer(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return !peer->removed &&
            (peer->offerCreationInProgress ||
             (peer->offerDispatched && !peer->answerReceived)) &&
            !peer->transportRetired;
    }

    static bool removed(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return true;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return peer->removed;
    }

    static std::string lastConnectionState(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return {};
        }
        std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
        return peer->lastConnectionState;
    }

    static bool timelineContains(const OpaquePeer &opaque,
                                 const std::string &fragment) {
        const auto peer = cast(opaque);
        if (!peer || fragment.empty()) {
            return false;
        }
        std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
        return std::any_of(
            peer->timeline.begin(),
            peer->timeline.end(),
            [&](const std::string &entry) {
                return entry.find(fragment) != std::string::npos;
            });
    }

    static bool duplicateOfferRecheckPending(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer && peer->duplicateOfferRecheckPending.load(
            std::memory_order_relaxed);
    }

    static std::size_t duplicateOfferRecheckJobCount(VersusApp &app) {
        std::lock_guard<std::mutex> lock(app.duplicateOfferRecheckMutex_);
        return app.duplicateOfferRechecks_.size();
    }

    static bool hasDuplicateOfferRecheckJob(VersusApp &app,
                                             const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        const std::string ownerKey = app.makePeerKey(peer->uuid, peer->session);
        std::lock_guard<std::mutex> lock(app.duplicateOfferRecheckMutex_);
        return app.duplicateOfferRechecks_.find(ownerKey) !=
            app.duplicateOfferRechecks_.end();
    }

    static std::string peerOwnerKey(VersusApp &app,
                                    const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? app.makePeerKey(peer->uuid, peer->session) : std::string{};
    }

    static uint64_t duplicateOfferRechecksScheduled(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->duplicateOfferRechecksScheduled.load(
                          std::memory_order_relaxed)
                    : 0;
    }

    static uint64_t duplicateOfferRechecksCoalesced(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->duplicateOfferRechecksCoalesced.load(
                          std::memory_order_relaxed)
                    : 0;
    }

    static uint64_t duplicateOfferRechecksFired(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->duplicateOfferRechecksFired.load(
                          std::memory_order_relaxed)
                    : 0;
    }

    static uint64_t duplicateOfferRechecksRebuilt(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->duplicateOfferRechecksRebuilt.load(
                          std::memory_order_relaxed)
                    : 0;
    }

    static uint64_t duplicateOfferRechecksIgnoredConnected(
        const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->duplicateOfferRechecksIgnoredConnected.load(
                          std::memory_order_relaxed)
                    : 0;
    }

    static uint64_t duplicateOfferRechecksStale(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->duplicateOfferRechecksStale.load(
                          std::memory_order_relaxed)
                    : 0;
    }

    static uint64_t duplicateOfferRechecksCanceled(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->duplicateOfferRechecksCanceled.load(
                          std::memory_order_relaxed)
                    : 0;
    }

    static void setDuplicateOfferRecheckHooks(
        VersusApp &app,
        std::function<void(uint64_t)> afterMapInsert,
        std::function<void(uint64_t)> beforeExecution,
        std::function<void(uint64_t)> beforeSend = {}) {
        std::lock_guard<std::mutex> lock(
            app.duplicateOfferRecheckTestHookMutex_);
        app.afterDuplicateOfferRecheckMapInsertForTesting_ =
            std::move(afterMapInsert);
        app.beforeDuplicateOfferRecheckExecutionForTesting_ =
            std::move(beforeExecution);
        app.beforeDuplicateOfferRecheckSendForTesting_ =
            std::move(beforeSend);
    }

    static void clearDuplicateOfferRecheckHooks(VersusApp &app) {
        setDuplicateOfferRecheckHooks(app, {}, {}, {});
    }

    static void cancelDuplicateOfferRechecks(VersusApp &app) {
        app.cancelDuplicateOfferRechecks(true, "concurrency-regression");
    }

    static GenerationTaggedPeerOperationExecutor::EnqueueResult
    enqueueExecutorOperation(
        VersusApp &app,
        uint64_t generation,
        std::string peerKey,
        GenerationTaggedPeerOperationExecutor::Priority priority,
        std::string coalesceKey,
        std::function<void(uint64_t)> operation,
        GenerationTaggedPeerOperationExecutor::Criticality criticality,
        GenerationTaggedPeerOperationExecutor::Completion completion = {}) {
        return app.peerOperationExecutor_.enqueue(
            generation,
            std::move(peerKey),
            priority,
            std::move(coalesceKey),
            [](uint64_t) { return true; },
            std::move(operation),
            criticality,
            std::move(completion));
    }

    static bool completePendingDuplicateOfferRecheckAs(
        VersusApp &app,
        const OpaquePeer &opaque,
        GenerationTaggedPeerOperationExecutor::CompletionDisposition
            disposition) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        const std::string ownerKey = app.makePeerKey(peer->uuid, peer->session);
        std::optional<VersusApp::PendingDuplicateOfferRecheck> job;
        {
            std::lock_guard<std::mutex> lock(app.duplicateOfferRecheckMutex_);
            const auto current = app.duplicateOfferRechecks_.find(ownerKey);
            if (current == app.duplicateOfferRechecks_.end()) {
                return false;
            }
            job = current->second;
        }
        app.handleDuplicateOfferRecheckExecutorCompletion(*job, disposition);
        return true;
    }

    static void dispatchDuplicateOfferRequest(VersusApp &app,
                                              const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (peer) {
            (void)app.handleDuplicatePeerOfferRequest(
                peer,
                "duplicate-offer-request-regression");
        }
    }

    static uint64_t offerCount(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer
            ? peer->offerCount.load(std::memory_order_relaxed)
            : 0;
    }

    static uint64_t recoveryOfferCount(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer
            ? peer->recoveryOfferCount.load(std::memory_order_relaxed)
                    : 0;
    }

    static std::vector<OfferDispatch> offerDispatches(
        const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return {};
        }
        std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
        std::vector<OfferDispatch> result;
        result.reserve(peer->offerDispatches.size());
        for (const auto &dispatch : peer->offerDispatches) {
            result.push_back({
                dispatch.sequence,
                dispatch.offerGeneration,
                dispatch.transportGeneration,
                dispatch.wireSession,
                dispatch.sdpSha256,
                dispatch.reason});
        }
        return result;
    }

    static bool hasDispatchedOffer(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        return peer->offerDispatched && !peer->lastLocalOfferSdp.empty();
    }

    static bool signalLookupMatches(VersusApp &app,
                                    const OpaquePeer &opaque,
                                    const std::string &session) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        std::lock_guard<std::mutex> lock(app.peerSessionsMutex_);
        return app.findPeerSessionForSignalLocked(peer->uuid, session) == peer;
    }

    static bool rebuildAndRotateWireSession(VersusApp &app, const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer || !peer->client) {
            return false;
        }
        const std::string before = activeWireSession(opaque);
        const uint64_t generationBefore = generation(opaque);
        app.sendPeerOffer(peer, "wire-session-rotation-regression", true);
        return activeWireSession(opaque) != before && generation(opaque) > generationBefore;
    }

    static bool renegotiateWithoutTransportReset(
        VersusApp &app,
        const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer || !peer->client) {
            return false;
        }
        const std::string wireSessionBefore = activeWireSession(opaque);
        const uint64_t clientGenerationBefore = generation(opaque);
        const uint64_t transportGenerationBefore =
            activeTransportGeneration(opaque);
        const uint64_t offerGenerationBefore = activeOfferGeneration(opaque);
        uint64_t dispatchSequenceBefore = 0;
        {
            std::lock_guard<std::mutex> lock(peer->negotiationMutex);
            if (!peer->offerDispatches.empty()) {
                dispatchSequenceBefore = peer->offerDispatches.back().sequence;
            }
        }
        const bool sent = app.sendPeerOffer(
            peer,
            "same-pc-renegotiation-control",
            false);
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        // The focused fixture deliberately has no live WSS transport, so an
        // exact offer dispatch attempt can return false only after production
        // created and recorded B. Never accept generation reservation alone:
        // require the immutable dispatch observation and non-empty cached SDP.
        const bool exactDispatchObserved =
            !peer->offerDispatches.empty() &&
            peer->offerDispatches.back().sequence > dispatchSequenceBefore &&
            peer->offerDispatches.back().offerGeneration ==
                peer->activeOfferGeneration &&
            peer->offerDispatches.back().wireSession ==
                peer->activeWireSession &&
            !peer->offerDispatches.back().sdpSha256.empty() &&
            peer->offerDispatches.back().reason ==
                "same-pc-renegotiation-control";
        const bool dispatchCompleted = sent || exactDispatchObserved;
        return dispatchCompleted && exactDispatchObserved &&
            peer->activeWireSession == wireSessionBefore &&
            peer->clientTransportGeneration == clientGenerationBefore &&
            peer->activeTransportGeneration == transportGenerationBefore &&
            peer->activeOfferGeneration > offerGenerationBefore &&
            peer->offerDispatched &&
            !peer->lastLocalOfferSdp.empty();
    }

    static bool duplicateUuidOwnerIsRejected(VersusApp &app, const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        auto duplicate = std::make_shared<VersusApp::PeerSession>();
        duplicate->uuid = peer->uuid;
        duplicate->session = "request-controlled-duplicate-session";
        duplicate->activeWireSession = duplicate->session;
        std::lock_guard<std::mutex> lock(app.peerSessionsMutex_);
        return !app.peerSessions_.emplace(duplicate->uuid, duplicate).second &&
            app.peerSessions_.at(peer->uuid) == peer;
    }

    static std::size_t queuedCandidateCount(VersusApp &app,
                                            const OpaquePeer &opaque,
                                            const std::string &session) {
        const auto peer = cast(opaque);
        if (!peer) {
            return 0;
        }
        std::lock_guard<std::mutex> lock(app.peerSessionsMutex_);
        const auto it = app.pendingRemoteCandidates_.find(
            app.makePeerKey(peer->uuid, session));
        return it == app.pendingRemoteCandidates_.end() ? 0 : it->second.size();
    }

    static int remoteCandidatesApplied(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer
            ? peer->remoteCandidatesApplied.load(std::memory_order_relaxed)
            : 0;
    }

    static void routeCandidate(VersusApp &app,
                               const OpaquePeer &opaque,
                               const std::string &session) {
        const auto peer = cast(opaque);
        if (!peer) {
            return;
        }
        signaling::SignalCandidate candidate;
        candidate.uuid = peer->uuid;
        candidate.session = session;
        candidate.type = "remote";
        candidate.mid = "video";
        candidate.mlineIndex = 0;
        candidate.candidate =
            "candidate:1 1 udp 2113937151 192.0.2.1 50000 typ host generation 0 ufrag stale";
        app.handlePeerRemoteCandidate(peer, candidate, "wire-session-regression");
    }

  private:
    static bool waitForPredicate(const std::function<bool()> &predicate,
                                 std::chrono::milliseconds timeout) {
        if (!predicate) {
            return true;
        }
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline) {
            if (predicate()) {
                return true;
            }
            std::this_thread::yield();
        }
        return predicate();
    }

    static std::shared_ptr<VersusApp::PeerSession> cast(const OpaquePeer &opaque) {
        return std::static_pointer_cast<VersusApp::PeerSession>(opaque);
    }
};

}  // namespace versus::app

class TestWebRtcClient : public QObject {
    Q_OBJECT

  private slots:
    void testTurnModesInitializeWithoutRegistryBinding();
    void testTurnModesConsumeExactRegistryBindingAcrossReset();
    void testRelayModeRequiresTurnServer();
    void testRemoteCandidateQueuesBeforeRemoteDescription();
    void testInitialOfferCompletesPromptlyAfterBootstrapTracks();
    void testVp9AlphaOfferUsesPluginDualTrackContract();
    void testAlphaMlineOrderSurvivesResetAndCodecFallback();
    void testAlphaCapabilityRequiresExactPluginField_data();
    void testAlphaCapabilityRequiresExactPluginField();
    void testTransportGenerationTokensAdvanceAcrossReset();
    void testPublisherWireSessionOwnershipAndReplacementIsolation();
    void testAdmittedOldFailedStateCannotRetireReplacementTransport();
    void testAdmittedOldSessionlessRestartCannotReplaceReplacementTransport();
    void testDuplicateOfferRequestRebuildsOnlyAnsweredTerminalTransport();
    void testStaleConnectionStateCannotCrossGenerationCommit();
    void testPeerOperationExecutorSerializesConcurrentLifecycle();
    void testPeerOperationExecutorStaleStopCannotFinalizeRestartedWorker();
    void testPeerOperationExecutorRejectsStartDuringStopAndRestarts();
    void testPeerOperationExecutorHandlesReentrantLifecycleCallbacks();
    void testPeerOperationExecutorDelegatedStopDoesNotJoinActiveCallback();
    void testPeerOperationExecutorReportsEveryCompletionDisposition();
    void testDuplicateOfferRecheckExecutorDispositionCleanup_data();
    void testDuplicateOfferRecheckExecutorDispositionCleanup();
    void testDuplicateOfferRecheckOperationThrowCleansPendingJob();
    void testDuplicateOfferRecheckSupersessionCleansPendingJob();
    void testDuplicateOfferRecheckStaleCompletionDoesNotDoubleFinalize();
    void testDuplicateOfferRecheckDroppedOnStopCleansPendingJob();
    void testDuplicateOfferRecheckRejectedStoppedCleansPendingJob();
    void testEvictedDuplicateOfferRecheckReceivesCompletion();
    void testCancelIsBarrierAgainstAdmittedDuplicateRecheck();
    void testScheduleCancelTransitionCannotLeavePhantomPendingJob();
    void testShutdownWaitsForInFlightCallbackWithoutDeadlock();
    void testResetWaitsForAdmittedCallbackWithoutDeadlock();
    void testAdmittedCallbackDoesNotReenterPeerOperationMutex();
    void testPeerRemovalWaitsForDispatchedHandlerWithoutClientLock();
    void testRuntimeVideoControlDoesNotInvertPeerAndVideoLocks();
    void testRemoteHangupDoesNotJoinWhileHoldingPeerLock();
    void testCallbackQueueOverloadCannotLoseFailedState();
    void testAllCriticalOverflowPreservesNewPeerConvergence();
    void testPeerOperationExecutorPrioritizesAndFairlyBoundsWork();
    void testCriticalOverflowPolicyAndBurstFairness();
    void testCallbackCanShutdownClientWithoutDeadlock();
    void testConcurrentSendResetAndShutdownCompletes();
};

namespace {

using MediaSection = std::pair<std::string, std::string>;

std::vector<MediaSection> mediaSections(const std::string &sdp) {
    std::vector<MediaSection> sections;
    std::istringstream input(sdp);
    std::string line;
    while (std::getline(input, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.rfind("m=", 0) == 0) {
            const size_t typeEnd = line.find(' ', 2);
            sections.emplace_back(line.substr(2, typeEnd - 2), std::string{});
        } else if (!sections.empty() && sections.back().second.empty() &&
                   line.rfind("a=mid:", 0) == 0) {
            sections.back().second = line.substr(6);
        }
    }
    return sections;
}

std::string describeSections(const std::vector<MediaSection> &sections) {
    std::string description;
    for (const auto &[type, mid] : sections) {
        if (!description.empty()) description += ", ";
        description += type + "/" + mid;
    }
    return description;
}

versus::webrtc::PeerConfig boundTurnPeerConfig(versus::webrtc::IceMode mode) {
    versus::webrtc::PeerConfig config;
    config.enableDataChannel = false;
    config.iceMode = mode;
    config.iceServers = {
        {"stun:stun.example.invalid:3478", "", "", true},
        {"turn:turn-a.example.invalid:3478?transport=udp", "fixture-user", "fixture-secret", true},
        {"turns:turn-b.example.invalid:443?transport=tcp", "fixture-user", "fixture-secret", false},
    };
    config.turnRegistry.fetchAttempted = true;
    config.turnRegistry.fetchSucceeded = true;
    config.turnRegistry.configAccepted = true;
    config.turnRegistry.outcome = versus::webrtc::TurnRegistryOutcome::Success;
    config.turnRegistry.requestTimestampUnixMs = 1786340000000LL;
    config.turnRegistry.sourceUrl =
        "https://turnservers.vdo.ninja/?ts=" +
        std::to_string(config.turnRegistry.requestTimestampUnixMs - 1653305816700LL);
    config.turnRegistry.transactionId = "turn-fixture-1";
    config.turnRegistry.timeoutMs = 2000;
    config.turnRegistry.httpStatus = 200;
    config.turnRegistry.responseVersion = 1;
    config.turnRegistry.responseServerCount = 1;
    config.turnRegistry.responseUrlCount = 2;
    config.turnRegistry.rawResponseSha256.assign(64, 'a');
    config.turnRegistry.canonicalConfigSha256.assign(64, 'b');
    config.turnRegistry.consumedConfigSha256 =
        versus::webrtc::consumedTurnConfigSha256(config.iceServers);
    return config;
}

void verifyCanonicalAlphaSections(const std::string &sdp, const char *context) {
    const std::vector<MediaSection> expected = {
        {"video", "video"},
        {"audio", "audio"},
        {"video", "video-alpha"},
        {"application", "0"},
    };
    const auto actual = mediaSections(sdp);
    QVERIFY2(actual == expected,
             qPrintable(QString("%1 m-line order was [%2]")
                            .arg(QString::fromUtf8(context))
                            .arg(QString::fromStdString(describeSections(actual)))));
}

versus::webrtc::PeerConfig alphaPeerConfig() {
    versus::webrtc::PeerConfig config;
    config.enableDataChannel = true;
    config.initialVideo = true;
    config.initialAudio = true;
    config.initialAlpha = true;
    config.videoCodec = versus::webrtc::PeerConfig::VideoCodec::VP9;
    config.enableAlphaTrack = true;
    config.iceMode = versus::webrtc::IceMode::HostOnly;
    return config;
}

template <typename Predicate>
bool waitUntil(Predicate &&predicate,
               std::chrono::milliseconds timeout,
               std::chrono::milliseconds pollInterval = std::chrono::milliseconds(5)) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        if (predicate()) return true;
        std::this_thread::sleep_for(pollInterval);
    }
    return predicate();
}

// std::future returned by std::async blocks in its destructor. That behavior
// turns a useful timeout assertion into a hung test process when diagnosing a
// real deadlock. This task joins only after its completion flag is visible and
// otherwise detaches; every concurrency test captures heap-owned state so a
// timed-out worker cannot access a dead test stack frame.
class BoundedTask {
  public:
    template <typename Function>
    explicit BoundedTask(Function &&function)
        : done_(std::make_shared<std::atomic<bool>>(false)),
          worker_([done = done_, function = std::forward<Function>(function)]() mutable {
              try {
                  function();
              } catch (...) {
              }
              done->store(true, std::memory_order_release);
          }) {}

    BoundedTask(const BoundedTask &) = delete;
    BoundedTask &operator=(const BoundedTask &) = delete;

    ~BoundedTask() { finishWithoutBlocking(); }

    bool waitFor(std::chrono::milliseconds timeout) const {
        return waitUntil(
            [&]() { return done_->load(std::memory_order_acquire); },
            timeout);
    }

    void finishWithoutBlocking() {
        if (!worker_.joinable()) return;
        if (done_->load(std::memory_order_acquire)) {
            worker_.join();
        } else {
            worker_.detach();
        }
    }

  private:
    std::shared_ptr<std::atomic<bool>> done_;
    std::thread worker_;
};

}  // namespace

void TestWebRtcClient::testTurnModesInitializeWithoutRegistryBinding() {
    // A failed or absent TURN registry fetch must not block connectivity:
    // TURN-capable modes accept whatever servers resolved.
    const std::vector<versus::webrtc::IceMode> turnModes = {
        versus::webrtc::IceMode::All,
        versus::webrtc::IceMode::Relay,
    };

    for (const auto mode : turnModes) {
        versus::webrtc::WebRtcClient client;
        versus::webrtc::PeerConfig config;
        config.enableDataChannel = false;
        config.iceMode = mode;
        config.iceServers = {
            {"stun:stun.example.invalid:3478", "", "", true},
            {"turn:turn.example.invalid:3478?transport=udp", "fixture-user", "fixture-secret", true},
        };

        QVERIFY2(client.initialize(config),
                 qPrintable(QString("ICE mode %1 rejected TURN servers that lacked registry provenance")
                                .arg(QString::fromStdString(versus::webrtc::iceModeName(mode)))));
        client.shutdown();
    }
}

void TestWebRtcClient::testTurnModesConsumeExactRegistryBindingAcrossReset() {
    for (const auto mode : {versus::webrtc::IceMode::All, versus::webrtc::IceMode::Relay}) {
        versus::webrtc::WebRtcClient client;
        const auto config = boundTurnPeerConfig(mode);

        QVERIFY2(client.initialize(config),
                 qPrintable(QString("ICE mode %1 rejected an exact registry binding")
                                .arg(QString::fromStdString(versus::webrtc::iceModeName(mode)))));
        const uint64_t initialGeneration = client.transportGeneration();
        QVERIFY(initialGeneration > 0);
        QVERIFY2(client.resetPeerConnection(false, false, false),
                 "PeerConnection reset did not reuse the exact accepted ICE binding");
        QVERIFY(client.transportGeneration() > initialGeneration);
        client.shutdown();
    }
}

void TestWebRtcClient::testRelayModeRequiresTurnServer() {
    {
        // Relay mode cannot function without a TURN server to relay through.
        versus::webrtc::WebRtcClient client;
        versus::webrtc::PeerConfig config;
        config.enableDataChannel = false;
        config.iceMode = versus::webrtc::IceMode::Relay;
        config.iceServers = {
            {"stun:stun.example.invalid:3478", "", "", true},
        };
        QVERIFY2(!client.initialize(config),
                 "Relay mode initialized without any TURN server");
        client.shutdown();
    }
    {
        // All mode degrades to STUN when the TURN list is empty.
        versus::webrtc::WebRtcClient client;
        versus::webrtc::PeerConfig config;
        config.enableDataChannel = false;
        config.iceMode = versus::webrtc::IceMode::All;
        config.iceServers = {
            {"stun:stun.example.invalid:3478", "", "", true},
        };
        QVERIFY2(client.initialize(config),
                 "All mode refused to initialize with STUN-only servers");
        client.shutdown();
    }
}

void TestWebRtcClient::testRemoteCandidateQueuesBeforeRemoteDescription() {
    versus::webrtc::WebRtcClient client;
    versus::webrtc::PeerConfig config;
    config.enableDataChannel = true;
    config.iceMode = versus::webrtc::IceMode::HostOnly;

    QVERIFY(client.initialize(config));
    QVERIFY(client.addRemoteCandidate(
        "candidate:1 1 UDP 2113937151 192.0.2.10 50000 typ host",
        "0",
        0));

    client.shutdown();
}

void TestWebRtcClient::testInitialOfferCompletesPromptlyAfterBootstrapTracks() {
    versus::webrtc::WebRtcClient client;
    versus::webrtc::PeerConfig config;
    config.enableDataChannel = true;
    config.initialVideo = true;
    config.initialAudio = true;
    config.iceMode = versus::webrtc::IceMode::HostOnly;

    QVERIFY(client.initialize(config));
    // Let any implicit negotiation caused by bootstrap setup finish. The explicit
    // createOffer call must still produce its own callback without a two-second stall.
    QTest::qWait(100);

    const auto started = std::chrono::steady_clock::now();
    const std::string offer = client.createOffer();
    const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();

    QVERIFY2(!offer.empty(), "Initial WebRTC offer was empty");
    QVERIFY2(offer.find("m=video") != std::string::npos, "Initial offer is missing video");
    QVERIFY2(offer.find("m=audio") != std::string::npos, "Initial offer is missing audio");
    QVERIFY2(offer.find("m=application") != std::string::npos, "Initial offer is missing sendChannel");
    QVERIFY2(elapsedMs < 1000,
             qPrintable(QString("Initial offer took %1 ms; it must not wait for the two-second fallback")
                            .arg(elapsedMs)));

    client.shutdown();
}

void TestWebRtcClient::testVp9AlphaOfferUsesPluginDualTrackContract() {
    versus::webrtc::WebRtcClient client;
    const auto config = alphaPeerConfig();

    QVERIFY(client.initialize(config));
    QTest::qWait(100);
    const std::string offer = client.createOffer();

    QVERIFY2(!offer.empty(), "VP9 alpha offer was empty");
    int videoMlineCount = 0;
    for (size_t offset = 0; (offset = offer.find("m=video", offset)) != std::string::npos; offset += 7) {
        ++videoMlineCount;
    }
    QCOMPARE(videoMlineCount, 2);
    QVERIFY2(offer.find("a=mid:video-alpha") != std::string::npos,
             "VP9 alpha offer is missing the ninja-plugin video-alpha MID");
    QVERIFY2(offer.find("VP9/90000") != std::string::npos,
             "VP9 alpha offer does not advertise VP9");

    client.shutdown();
}

void TestWebRtcClient::testAlphaMlineOrderSurvivesResetAndCodecFallback() {
    versus::webrtc::WebRtcClient client;
    QVERIFY(client.initialize(alphaPeerConfig()));

    const std::string initialOffer = client.createOffer();
    QVERIFY2(!initialOffer.empty(), "Initial alpha offer was empty");
    verifyCanonicalAlphaSections(initialOffer, "initial");

    const auto capabilityPlan = client.ensureMediaTracks(true, true, true);
    QVERIFY2(!capabilityPlan.changed,
             "Alpha capability activation must not append a new m-line after the data section");

    QVERIFY(client.resetPeerConnection(false, false, false));
    const std::string resetOffer = client.createOffer();
    QVERIFY2(!resetOffer.empty(), "Reset alpha offer was empty");
    verifyCanonicalAlphaSections(resetOffer, "reset");

    client.setVideoCodec(versus::webrtc::PeerConfig::VideoCodec::H264, false);
    QVERIFY(client.resetPeerConnection(false, false, false));
    const std::string fallbackOffer = client.createOffer();
    QVERIFY2(!fallbackOffer.empty(), "Codec fallback offer was empty");
    verifyCanonicalAlphaSections(fallbackOffer, "codec fallback");
    QVERIFY2(fallbackOffer.find("H264/90000") != std::string::npos,
             "Codec fallback did not advertise H264 primary video");
    QVERIFY2(fallbackOffer.find("a=mid:video-alpha") != std::string::npos,
             "Codec fallback removed the negotiated alpha section");

    client.shutdown();
}

void TestWebRtcClient::testAlphaCapabilityRequiresExactPluginField_data() {
    QTest::addColumn<QString>("payload");
    QTest::addColumn<bool>("expectedAllowed");

    QTest::newRow("camel-case-alias")
        << QStringLiteral(R"({"info":{"alphaReceive":"vp9-dualtrack-v1"}})")
        << false;
    QTest::newRow("boolean-true")
        << QStringLiteral(R"({"info":{"alpha_receive":true}})")
        << false;
    QTest::newRow("wrong-version")
        << QStringLiteral(R"({"info":{"alpha_receive":"vp9-dualtrack-v2"}})")
        << false;
    QTest::newRow("wrong-case")
        << QStringLiteral(R"({"info":{"alpha_receive":"VP9-DUALTRACK-V1"}})")
        << false;
    QTest::newRow("wrong-type")
        << QStringLiteral(R"({"info":{"alpha_receive":1}})")
        << false;
    QTest::newRow("exact-ninja-plugin-capability")
        << QStringLiteral(R"({"info":{"alpha_receive":"vp9-dualtrack-v1"}})")
        << true;
}

void TestWebRtcClient::testAlphaCapabilityRequiresExactPluginField() {
    QFETCH(QString, payload);
    QFETCH(bool, expectedAllowed);

    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-strict-alpha-capability");
    QVERIFY2(peer, "Could not construct the strict alpha-capability fixture");
    auto *client = versus::app::VersusAppTestAccess::client(peer);
    QVERIFY(client);
    const uint64_t generation =
        versus::app::VersusAppTestAccess::generation(peer);

    versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
        *client,
        payload.toStdString(),
        generation);
    const bool callbackDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(
            *app,
            std::chrono::seconds(3));
    const bool actualAllowed =
        versus::app::VersusAppTestAccess::alphaAllowed(peer);
    const std::string actualMode =
        versus::app::VersusAppTestAccess::alphaReceiveMode(peer);

    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(4));
    shutdownTask.finishWithoutBlocking();

    QVERIFY2(callbackDrained,
             "The real generation-tagged data-message callback did not drain");
    QCOMPARE(actualAllowed, expectedAllowed);
    QCOMPARE(actualMode,
             expectedAllowed ? std::string("vp9-dualtrack-v1") : std::string{});
    QVERIFY2(shutdownCompleted,
             "The strict alpha-capability fixture did not shut down within the bound");
}

void TestWebRtcClient::testTransportGenerationTokensAdvanceAcrossReset() {
    versus::webrtc::WebRtcClient client;
    auto config = alphaPeerConfig();
    QVERIFY(client.initialize(config));
    const uint64_t firstGeneration = client.transportGeneration();
    QVERIFY(firstGeneration > 0);

    std::mutex tokenMutex;
    std::vector<uint64_t> tokens;
    std::vector<uint64_t> stateTokens;
    client.setIceCandidateCallback(
        [&tokenMutex, &tokens](const std::string &, const std::string &, int,
                              uint64_t generation) {
            std::lock_guard<std::mutex> lock(tokenMutex);
            tokens.push_back(generation);
        });
    client.setStateCallback(
        [&tokenMutex, &stateTokens](versus::webrtc::ConnectionState, uint64_t generation) {
            std::lock_guard<std::mutex> lock(tokenMutex);
            stateTokens.push_back(generation);
        });
    QVERIFY(!client.createOffer().empty());
    QTest::qWait(50);
    {
        std::lock_guard<std::mutex> lock(tokenMutex);
        QVERIFY2(!tokens.empty(), "Initial transport emitted no candidate token");
        QVERIFY(std::all_of(tokens.begin(), tokens.end(),
                            [firstGeneration](uint64_t token) { return token == firstGeneration; }));
        QVERIFY2(!stateTokens.empty(), "Initial transport emitted no state callback token");
        QVERIFY(std::all_of(stateTokens.begin(), stateTokens.end(),
                            [firstGeneration](uint64_t token) { return token == firstGeneration; }));
        tokens.clear();
        stateTokens.clear();
    }

    QVERIFY(client.resetPeerConnection(false, false, false));
    const uint64_t secondGeneration = client.transportGeneration();
    QVERIFY(secondGeneration > firstGeneration);
    QVERIFY(!client.createOffer().empty());
    QTest::qWait(50);
    {
        std::lock_guard<std::mutex> lock(tokenMutex);
        QVERIFY2(!tokens.empty(), "Replacement transport emitted no candidate token");
        QVERIFY(std::all_of(tokens.begin(), tokens.end(),
                            [secondGeneration](uint64_t token) { return token == secondGeneration; }));
        QVERIFY2(!stateTokens.empty(), "Replacement transport emitted no state callback token");
        QVERIFY(std::all_of(stateTokens.begin(), stateTokens.end(),
                            [secondGeneration](uint64_t token) { return token == secondGeneration; }));
    }

    client.shutdown();
}

void TestWebRtcClient::testPublisherWireSessionOwnershipAndReplacementIsolation() {
    versus::app::VersusApp app;
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        app,
        "-wire-session-regression");
    QVERIFY2(peer, "Failed to create the publisher peer fixture");

    const std::string ownerSession =
        versus::app::VersusAppTestAccess::ownerSession(peer);
    const std::string wireSessionA =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    QVERIFY(!ownerSession.empty());
    QCOMPARE(wireSessionA, ownerSession);
    QVERIFY(versus::app::VersusAppTestAccess::signalLookupMatches(
        app,
        peer,
        {}));
    QVERIFY(versus::app::VersusAppTestAccess::signalLookupMatches(
        app,
        peer,
        wireSessionA));
    QVERIFY(!versus::app::VersusAppTestAccess::signalLookupMatches(
        app,
        peer,
        "viewer-controlled-request-hint"));
    QVERIFY2(
        versus::app::VersusAppTestAccess::duplicateUuidOwnerIsRejected(app, peer),
        "A second request-side session admitted another owner for the same UUID");

    QVERIFY2(
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(app, peer),
        "A real PeerConnection replacement did not rotate its wire session");
    const std::string wireSessionB =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    QVERIFY(!wireSessionB.empty());
    QVERIFY(wireSessionB != wireSessionA);
    QCOMPARE(
        versus::app::VersusAppTestAccess::ownerSession(peer),
        ownerSession);
    QVERIFY(!versus::app::VersusAppTestAccess::signalLookupMatches(
        app,
        peer,
        wireSessionA));
    QVERIFY(versus::app::VersusAppTestAccess::signalLookupMatches(
        app,
        peer,
        wireSessionB));

    const int appliedBefore =
        versus::app::VersusAppTestAccess::remoteCandidatesApplied(peer);
    versus::app::VersusAppTestAccess::routeCandidate(
        app,
        peer,
        wireSessionA);
    QCOMPARE(
        versus::app::VersusAppTestAccess::queuedCandidateCount(
            app,
            peer,
            wireSessionA),
        std::size_t{0});
    QCOMPARE(
        versus::app::VersusAppTestAccess::remoteCandidatesApplied(peer),
        appliedBefore);
}

void TestWebRtcClient::testAdmittedOldFailedStateCannotRetireReplacementTransport() {
    struct State {
        std::atomic<bool> operationParked{false};
        std::atomic<bool> releaseOperation{false};
        std::atomic<bool> rebuildStarted{false};
        std::atomic<bool> rebuildResult{false};
    };
    auto state = std::make_shared<State>();
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-admitted-failed-generation");
    QVERIFY2(peer, "Could not construct the admitted failed-state fixture");
    auto *client = versus::app::VersusAppTestAccess::client(peer);
    QVERIFY(client);

    const uint64_t generationA =
        versus::app::VersusAppTestAccess::generation(peer);
    const std::string wireSessionA =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    QVERIFY(generationA != 0);
    QVERIFY(!wireSessionA.empty());

    // This hook is inside the executor operation, after its final current-
    // generation validation. Releasing it with `false` runs the production
    // handler, which is the exact admitted-callback boundary under test.
    versus::app::VersusAppTestAccess::setOperationHook(
        *app,
        [state, generationA](const std::string &,
                             const std::string &kind,
                             uint64_t generation) {
            if (kind != "connection-state" || generation != generationA) {
                return true;
            }
            state->operationParked.store(true, std::memory_order_release);
            while (!state->releaseOperation.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            return false;
        });

    versus::webrtc::WebRtcClientTestAccess::invokeStateCallback(
        *client,
        versus::webrtc::ConnectionState::Failed,
        generationA);
    const bool operationParked = waitUntil(
        [state]() {
            return state->operationParked.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));

    BoundedTask rebuildTask([app, peer, state]() {
        state->rebuildStarted.store(true, std::memory_order_release);
        state->rebuildResult.store(
            versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(
                *app,
                peer),
            std::memory_order_release);
    });
    const bool rebuildStarted = waitUntil(
        [state]() {
            return state->rebuildStarted.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    // A correct structural lease keeps B from publishing here. The known-bad
    // implementation publishes B immediately; after release the admitted A
    // failure then retires B and the final assertion goes red.
    (void)rebuildTask.waitFor(std::chrono::milliseconds(150));

    state->releaseOperation.store(true, std::memory_order_release);
    const bool rebuildCompleted = rebuildTask.waitFor(std::chrono::seconds(4));
    rebuildTask.finishWithoutBlocking();
    const bool callbacksDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(
            *app,
            std::chrono::seconds(4));
    const bool replacementRetired =
        versus::app::VersusAppTestAccess::transportRetired(peer);
    const std::string finalWireSession =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    const uint64_t finalGeneration =
        versus::app::VersusAppTestAccess::generation(peer);

    versus::app::VersusAppTestAccess::setOperationHook(*app, {});
    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(4));
    shutdownTask.finishWithoutBlocking();

    QVERIFY2(operationParked,
             "The old failed-state callback never crossed final generation validation");
    QVERIFY2(rebuildStarted && rebuildCompleted &&
                 state->rebuildResult.load(std::memory_order_acquire),
             "The replacement transport did not complete around admitted old callback work");
    QVERIFY2(finalWireSession != wireSessionA && finalGeneration > generationA,
             "The deterministic fixture did not publish replacement transport B");
    QVERIFY2(callbacksDrained,
             "The admitted old failed-state callback did not drain after release");
    QVERIFY2(!replacementRetired,
             "An admitted failed-state callback from transport A retired replacement B");
    QVERIFY2(shutdownCompleted,
             "The admitted failed-state fixture did not shut down within the bound");
}

void TestWebRtcClient::testAdmittedOldSessionlessRestartCannotReplaceReplacementTransport() {
    struct State {
        std::atomic<bool> operationParked{false};
        std::atomic<bool> releaseOperation{false};
        std::atomic<bool> rebuildStarted{false};
        std::atomic<bool> rebuildResult{false};
    };
    auto state = std::make_shared<State>();
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-admitted-sessionless-restart");
    QVERIFY2(peer, "Could not construct the admitted restart fixture");
    auto *client = versus::app::VersusAppTestAccess::client(peer);
    QVERIFY(client);

    const uint64_t generationA =
        versus::app::VersusAppTestAccess::generation(peer);
    const std::string wireSessionA =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    QVERIFY(generationA != 0);
    QVERIFY(!wireSessionA.empty());

    versus::app::VersusAppTestAccess::setOperationHook(
        *app,
        [state, generationA](const std::string &,
                             const std::string &kind,
                             uint64_t generation) {
            if (kind != "data-message" || generation != generationA) {
                return true;
            }
            state->operationParked.store(true, std::memory_order_release);
            while (!state->releaseOperation.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            return false;
        });

    // VDO.Ninja intentionally sends this recovery control over the viewer data
    // channel without a session field. Its transport generation is therefore
    // the only safe way to prevent old A work from being relabelled as B work.
    versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
        *client,
        R"({"iceRestartRequest":true})",
        generationA);
    const bool operationParked = waitUntil(
        [state]() {
            return state->operationParked.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));

    BoundedTask rebuildTask([app, peer, state]() {
        state->rebuildStarted.store(true, std::memory_order_release);
        state->rebuildResult.store(
            versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(
                *app,
                peer),
            std::memory_order_release);
    });
    const bool rebuildStarted = waitUntil(
        [state]() {
            return state->rebuildStarted.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    const bool rebuiltWhileOldOperationParked =
        rebuildTask.waitFor(std::chrono::milliseconds(150));
    std::string wireSessionB;
    uint64_t generationB = 0;
    if (rebuiltWhileOldOperationParked) {
        wireSessionB =
            versus::app::VersusAppTestAccess::activeWireSession(peer);
        generationB = versus::app::VersusAppTestAccess::generation(peer);
        // This is the known-bad ordering: B published while admitted A work
        // was still parked. Let B settle so the stale A restart has an
        // observable, incorrect B -> C replacement instead of an offer replay.
        versus::app::VersusAppTestAccess::markActiveOfferAnswered(peer);
    }

    state->releaseOperation.store(true, std::memory_order_release);
    const bool rebuildCompleted = rebuildTask.waitFor(std::chrono::seconds(4));
    rebuildTask.finishWithoutBlocking();
    const bool callbacksDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(
            *app,
            std::chrono::seconds(4));
    if (!rebuiltWhileOldOperationParked) {
        // With the structural callback lease, the valid A restart performs the
        // one A -> B rebuild. The concurrently requested rebuild then coalesces
        // against B's unresolved offer instead of creating C.
        wireSessionB =
            versus::app::VersusAppTestAccess::activeWireSession(peer);
        generationB = versus::app::VersusAppTestAccess::generation(peer);
    }
    const std::string finalWireSession =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    const uint64_t finalGeneration =
        versus::app::VersusAppTestAccess::generation(peer);

    versus::app::VersusAppTestAccess::setOperationHook(*app, {});
    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(4));
    shutdownTask.finishWithoutBlocking();

    QVERIFY2(operationParked,
             "The old sessionless restart never crossed final generation validation");
    QVERIFY2(rebuildStarted && rebuildCompleted &&
                 state->rebuildResult.load(std::memory_order_acquire),
             "The replacement transport did not complete around admitted old restart work");
    QVERIFY2(wireSessionB != wireSessionA && generationB > generationA,
             "The deterministic fixture did not publish replacement transport B");
    QVERIFY2(callbacksDrained,
             "The admitted old sessionless restart did not drain after release");
    QCOMPARE(finalWireSession, wireSessionB);
    QCOMPARE(finalGeneration, generationB);
    QVERIFY2(shutdownCompleted,
             "The admitted sessionless-restart fixture did not shut down within the bound");
}

void TestWebRtcClient::testDuplicateOfferRequestRebuildsOnlyAnsweredTerminalTransport() {
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-duplicate-terminal-offer");
    QVERIFY2(peer, "Could not construct the duplicate-offer fixture");

    // Establish a real cached offer, then model the normal answered state. The
    // same production helper used by the registered offer-request callback is
    // exercised below. This case targets duplicate policy; parser/dispatcher
    // callback routing is covered by the focused WSS ingress cases below.
    QVERIFY2(
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer),
        "The duplicate-offer fixture could not establish its answered transport");
    versus::app::VersusAppTestAccess::markActiveOfferAnswered(peer);
    const std::string healthyWireSession =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    const uint64_t healthyGeneration =
        versus::app::VersusAppTestAccess::generation(peer);
    const uint64_t healthyOfferCount =
        versus::app::VersusAppTestAccess::offerCount(peer);
    const uint64_t healthyRecoveryOfferCount =
        versus::app::VersusAppTestAccess::recoveryOfferCount(peer);
    QVERIFY(versus::app::VersusAppTestAccess::hasDispatchedOffer(peer));

    versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(*app, peer);
    const std::string afterHealthyDuplicateSession =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    const uint64_t afterHealthyDuplicateGeneration =
        versus::app::VersusAppTestAccess::generation(peer);
    const uint64_t afterHealthyDuplicateOfferCount =
        versus::app::VersusAppTestAccess::offerCount(peer);
    const uint64_t afterHealthyDuplicateRecoveryCount =
        versus::app::VersusAppTestAccess::recoveryOfferCount(peer);

    // VDO.Ninja treats the same duplicate UUID request differently once the
    // current PeerConnection is terminal: replace it and publish a new wire
    // session, rather than ignoring it merely because its old offer answered.
    versus::app::VersusAppTestAccess::markTransportRetired(peer);
    versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(*app, peer);
    const std::string replacementWireSession =
        versus::app::VersusAppTestAccess::activeWireSession(peer);
    const uint64_t replacementGeneration =
        versus::app::VersusAppTestAccess::generation(peer);
    const uint64_t replacementOfferCount =
        versus::app::VersusAppTestAccess::offerCount(peer);
    const uint64_t replacementRecoveryOfferCount =
        versus::app::VersusAppTestAccess::recoveryOfferCount(peer);
    const bool replacementOfferDispatched =
        versus::app::VersusAppTestAccess::hasDispatchedOffer(peer);

    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(4));
    shutdownTask.finishWithoutBlocking();

    QCOMPARE(afterHealthyDuplicateSession, healthyWireSession);
    QCOMPARE(afterHealthyDuplicateGeneration, healthyGeneration);
    QCOMPARE(afterHealthyDuplicateOfferCount, healthyOfferCount);
    QCOMPARE(afterHealthyDuplicateRecoveryCount, healthyRecoveryOfferCount);
    QVERIFY2(replacementWireSession != healthyWireSession &&
                 replacementGeneration > healthyGeneration,
             "A duplicate UUID offer request left an answered terminal transport in place");
    QCOMPARE(replacementOfferCount, healthyOfferCount + uint64_t{1});
    QCOMPARE(replacementRecoveryOfferCount,
             healthyRecoveryOfferCount + uint64_t{1});
    // The replacement offer's wire send fails in this fixture (no live
    // signaling socket), so the dispatched flag must revert: trickle
    // candidates buffer for the next attempt instead of being sent against
    // an offer the receiver never saw.
    QVERIFY2(!replacementOfferDispatched,
             "A failed replacement offer send must not stay marked dispatched");
    QVERIFY2(shutdownCompleted,
             "The duplicate-offer fixture did not shut down within the bound");
}

void TestWebRtcClient::testStaleConnectionStateCannotCrossGenerationCommit() {
    auto client = std::make_shared<versus::webrtc::WebRtcClient>();
    versus::webrtc::PeerConfig config;
    config.enableDataChannel = false;
    config.iceMode = versus::webrtc::IceMode::HostOnly;
    const bool initialized = client->initialize(config);
    const uint64_t generationA = client->transportGeneration();

    struct Barrier {
        std::atomic<bool> armed{true};
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    const auto beforeStateCommit = [barrier, generationA](uint64_t generation) {
        if (!barrier->armed.load(std::memory_order_acquire) ||
            generation != generationA) {
            return;
        }
        barrier->entered.store(true, std::memory_order_release);
        while (!barrier->release.load(std::memory_order_acquire)) {
            std::this_thread::yield();
        }
    };
    versus::webrtc::WebRtcClientTestAccess::setConcurrencyHooks(
        *client,
        {},
        {},
        {},
        beforeStateCommit);

    BoundedTask staleState([client, generationA]() {
        versus::webrtc::WebRtcClientTestAccess::invokeStateCallback(
            *client,
            versus::webrtc::ConnectionState::Connected,
            generationA);
    });
    const bool staleCommitParked = waitUntil(
        [barrier]() { return barrier->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));
    const bool reset = client->resetPeerConnection(false, false, false);
    const uint64_t generationB = client->transportGeneration();
    barrier->release.store(true, std::memory_order_release);
    barrier->armed.store(false, std::memory_order_release);
    const bool staleCommitCompleted = staleState.waitFor(std::chrono::seconds(2));
    staleState.finishWithoutBlocking();
    const auto finalState = client->connectionState();
    versus::webrtc::WebRtcClientTestAccess::clearConcurrencyHooks(*client);
    client->shutdown();

    QVERIFY2(initialized, "Could not initialize the generation-bound state fixture");
    QVERIFY2(staleCommitParked,
             "The stale state callback did not reach the check/store barrier");
    QVERIFY2(reset && generationB > generationA,
             "The replacement transport was not installed while the stale state was parked");
    QVERIFY2(staleCommitCompleted,
             "The stale state callback did not finish after the barrier was released");
    QCOMPARE(finalState, versus::webrtc::ConnectionState::Disconnected);
}

void TestWebRtcClient::testPeerOperationExecutorSerializesConcurrentLifecycle() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    using Priority = Executor::Priority;
    using Result = Executor::EnqueueResult;

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    auto *executor = new Executor(4);
    QVERIFY2(executor->start(),
             "Concurrent lifecycle executor did not start");
    const Result blocker = executor->enqueue(
        1,
        "concurrent-stop-blocker",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [barrier](uint64_t) {
            barrier->entered.store(true, std::memory_order_release);
            while (!barrier->release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });
    const bool blockerEntered = Executor::accepted(blocker) &&
        waitUntil(
            [barrier]() {
                return barrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));

    BoundedTask firstStop([executor]() { executor->stop(); });
    const bool firstStopClosedAdmission = waitUntil(
        [executor]() {
            return executor->enqueue(
                       2,
                       "concurrent-stop-probe",
                       Priority::Critical,
                       "probe",
                       [](uint64_t) { return true; },
                       [](uint64_t) {}) == Result::RejectedStopped;
        },
        std::chrono::seconds(2));
    const bool firstStopReturnedWhileCallbackActive =
        firstStop.waitFor(std::chrono::milliseconds(100));
    BoundedTask secondStop([executor]() { executor->stop(); });
    const bool secondStopReturnedWhileCallbackActive =
        secondStop.waitFor(std::chrono::milliseconds(100));
    barrier->release.store(true, std::memory_order_release);
    const bool firstStopReturned =
        firstStop.waitFor(std::chrono::seconds(2));
    firstStop.finishWithoutBlocking();
    const bool secondStopReturned =
        secondStop.waitFor(std::chrono::seconds(2));
    secondStop.finishWithoutBlocking();
    const bool restarted = waitUntil(
        [executor]() { return executor->start(); },
        std::chrono::seconds(2));
    if (restarted) {
        executor->stop();
    }

    qInfo().noquote()
        << QString("EXECUTOR_LIFECYCLE_BRANCH blocker=%1 admission_closed=%2 first_stop_nonblocking=%3 second_stop_nonblocking=%4 first_stop_returned=%5 second_stop_returned=%6 restarted=%7")
               .arg(blockerEntered)
               .arg(firstStopClosedAdmission)
               .arg(firstStopReturnedWhileCallbackActive)
               .arg(secondStopReturnedWhileCallbackActive)
               .arg(firstStopReturned)
               .arg(secondStopReturned)
               .arg(restarted);

    if (firstStopReturned && secondStopReturned && restarted) {
        delete executor;
    }

    QVERIFY2(blockerEntered,
             "Concurrent lifecycle blocker did not enter the worker operation");
    QVERIFY2(firstStopClosedAdmission,
             "First stop caller never closed executor admission");
    QVERIFY2(firstStopReturnedWhileCallbackActive &&
                 secondStopReturnedWhileCallbackActive &&
                 firstStopReturned && secondStopReturned,
             "A concurrent stop caller waited for an active worker callback");
    QVERIFY2(restarted,
             "Concurrent stop requests did not leave one restartable quiescent lifecycle");
}

void TestWebRtcClient::testPeerOperationExecutorStaleStopCannotFinalizeRestartedWorker() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    using Priority = Executor::Priority;
    using Result = Executor::EnqueueResult;
    using TestAccess = versus::app::VersusAppTestAccess;

    struct State {
        std::atomic<int> hookCalls{0};
        std::atomic<bool> firstStopParked{false};
        std::atomic<bool> releaseFirstStop{false};
        std::atomic<uint64_t> stoppedEpoch{0};
        std::atomic<int> restartedWorkerOperations{0};
        std::atomic<bool> escapeTriggered{false};
    };
    const auto state = std::make_shared<State>();
    auto *executor = new Executor(4);
    TestAccess::setExecutorBeforeStopFinalizeHook(
        *executor,
        [state](uint64_t stoppedEpoch) {
            const int invocation =
                state->hookCalls.fetch_add(1, std::memory_order_acq_rel);
            if (invocation != 0) {
                return;
            }
            state->stoppedEpoch.store(stoppedEpoch, std::memory_order_release);
            state->firstStopParked.store(true, std::memory_order_release);
            while (!state->releaseFirstStop.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });

    const bool initiallyStarted = executor->start();
    const uint64_t initialEpoch =
        TestAccess::executorWorkerEpoch(*executor);
    BoundedTask staleStop([executor]() { executor->stop(); });
    const bool staleStopParked = waitUntil(
        [state]() {
            return state->firstStopParked.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    const bool restarted = staleStopParked && waitUntil(
        [executor]() { return executor->start(); },
        std::chrono::seconds(2));
    const uint64_t restartedEpoch =
        TestAccess::executorWorkerEpoch(*executor);
    const Result restartedOperation = executor->enqueue(
        8,
        "stale-stop-restarted-worker-proof",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [state](uint64_t) {
            state->restartedWorkerOperations.fetch_add(
                1,
                std::memory_order_release);
        });
    const bool restartedWorkerRan = restarted &&
        Executor::accepted(restartedOperation) &&
        executor->waitUntilIdle(std::chrono::seconds(2)) &&
        state->restartedWorkerOperations.load(std::memory_order_acquire) == 1;

    state->releaseFirstStop.store(true, std::memory_order_release);
    const bool staleStopReturnedBeforeEscape =
        staleStop.waitFor(std::chrono::milliseconds(250));
    if (!staleStopReturnedBeforeEscape) {
        // The known-bad stale finalizer owns lifecycleMutex_ and is joining the
        // restarted idle worker. A second stop can still set stopRequested_
        // without that lock, allowing the measurement to unwind instead of
        // hanging the test process.
        state->escapeTriggered.store(true, std::memory_order_release);
        executor->stop();
    }
    const bool staleStopEventuallyReturned =
        staleStop.waitFor(std::chrono::seconds(2));
    staleStop.finishWithoutBlocking();
    const uint64_t stoppedEpoch =
        state->stoppedEpoch.load(std::memory_order_acquire);
    const bool distinctRestartEpoch = stoppedEpoch != 0 &&
        restartedEpoch != 0 && restartedEpoch != stoppedEpoch;

    qInfo().noquote()
        << QString("EXECUTOR_STALE_FINALIZER_BRANCH initial=%1 initial_epoch=%2 stop_parked=%3 stopped_epoch=%4 restarted=%5 restarted_epoch=%6 distinct_epoch=%7 restarted_worker_ran=%8 hook_calls=%9 stale_returned_before_escape=%10 escape=%11 stale_eventually_returned=%12")
               .arg(initiallyStarted)
               .arg(initialEpoch)
               .arg(staleStopParked)
               .arg(stoppedEpoch)
               .arg(restarted)
               .arg(restartedEpoch)
               .arg(distinctRestartEpoch)
               .arg(restartedWorkerRan)
               .arg(state->hookCalls.load(std::memory_order_acquire))
               .arg(staleStopReturnedBeforeEscape)
               .arg(state->escapeTriggered.load(std::memory_order_acquire))
               .arg(staleStopEventuallyReturned);

    if (staleStopEventuallyReturned) {
        TestAccess::setExecutorBeforeStopFinalizeHook(*executor, {});
        executor->stop();
        delete executor;
    }

    QVERIFY2(initiallyStarted && initialEpoch != 0 && staleStopParked &&
                 stoppedEpoch == initialEpoch && restarted &&
                 distinctRestartEpoch && restartedWorkerRan,
             "Could not construct the stale-stop/new-worker-epoch fixture");
    QVERIFY2(staleStopReturnedBeforeEscape,
             "A stale stop finalizer joined the newly restarted worker epoch");
    QVERIFY2(!state->escapeTriggered.load(std::memory_order_acquire),
             "The stale finalizer race required the test instrument's bounded escape");
    QVERIFY2(staleStopEventuallyReturned,
             "The stale finalizer did not unwind after the bounded escape");
}

void TestWebRtcClient::testPeerOperationExecutorRejectsStartDuringStopAndRestarts() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    using Disposition = Executor::CompletionDisposition;
    using Priority = Executor::Priority;
    using Result = Executor::EnqueueResult;

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    Executor executor(4);
    const bool initiallyStarted = executor.start();
    const Result blocker = executor.enqueue(
        1,
        "stop-start-blocker",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [barrier](uint64_t) {
            barrier->entered.store(true, std::memory_order_release);
            while (!barrier->release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });
    const bool blockerEntered = Executor::accepted(blocker) &&
        waitUntil(
            [barrier]() {
                return barrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));

    BoundedTask stopTask([&executor]() { executor.stop(); });
    const bool stopClosedAdmission = waitUntil(
        [&executor]() {
            return executor.enqueue(
                       2,
                       "stop-start-probe",
                       Priority::Critical,
                       "probe",
                       [](uint64_t) { return true; },
                       [](uint64_t) {}) == Result::RejectedStopped;
        },
        std::chrono::seconds(2));
    const auto overlappingStartBegan = std::chrono::steady_clock::now();
    const bool overlappingStart = executor.start();
    const auto overlappingStartElapsed =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - overlappingStartBegan);
    const bool stopReturnedWhileCallbackActive =
        stopTask.waitFor(std::chrono::milliseconds(100));
    barrier->release.store(true, std::memory_order_release);
    const bool stopReturned = stopTask.waitFor(std::chrono::seconds(2));
    stopTask.finishWithoutBlocking();

    const bool restarted = waitUntil(
        [&executor]() { return executor.start(); },
        std::chrono::seconds(2));
    std::atomic<int> operationCount{0};
    std::atomic<int> completionCount{0};
    std::atomic<int> unexpectedDisposition{0};
    constexpr int kLifecycleCycles = 24;
    bool repeatedLifecyclePassed = restarted;
    for (int cycle = 0; cycle < kLifecycleCycles && repeatedLifecyclePassed;
         ++cycle) {
        const Result result = executor.enqueue(
            static_cast<uint64_t>(100 + cycle),
            "repeated-lifecycle",
            Priority::Ordinary,
            {},
            [](uint64_t) { return true; },
            [&operationCount](uint64_t) {
                operationCount.fetch_add(1, std::memory_order_relaxed);
            },
            Executor::Criticality::State,
            [&completionCount, &unexpectedDisposition](
                uint64_t,
                Disposition disposition) {
                completionCount.fetch_add(1, std::memory_order_relaxed);
                if (disposition != Disposition::Executed) {
                    unexpectedDisposition.fetch_add(1, std::memory_order_relaxed);
                }
            });
        repeatedLifecyclePassed = Executor::accepted(result) &&
            executor.waitUntilIdle(std::chrono::seconds(2));
        executor.stop();
        if (cycle + 1 < kLifecycleCycles) {
            repeatedLifecyclePassed =
                repeatedLifecyclePassed && executor.start();
        }
    }

    qInfo().noquote()
        << QString("EXECUTOR_STOP_START_BRANCH initial=%1 blocker=%2 admission_closed=%3 overlapping_start=%4 overlap_ms=%5 stop_nonblocking=%6 stop_returned=%7 restarted=%8 cycles=%9 operations=%10 completions=%11")
               .arg(initiallyStarted)
               .arg(blockerEntered)
               .arg(stopClosedAdmission)
               .arg(overlappingStart)
               .arg(overlappingStartElapsed.count())
               .arg(stopReturnedWhileCallbackActive)
               .arg(stopReturned)
               .arg(restarted)
               .arg(kLifecycleCycles)
               .arg(operationCount.load(std::memory_order_relaxed))
               .arg(completionCount.load(std::memory_order_relaxed));

    QVERIFY2(initiallyStarted && blockerEntered && stopClosedAdmission,
             "Could not construct the stop-vs-start lifecycle fixture");
    QVERIFY2(!overlappingStart &&
                 overlappingStartElapsed < std::chrono::milliseconds(500),
             "start() did not fail closed promptly while stop owned the lifecycle");
    QVERIFY2(stopReturnedWhileCallbackActive && stopReturned,
             "stop() waited for an admitted worker callback instead of returning after its request");
    QVERIFY2(repeatedLifecyclePassed,
             "Executor could not repeatedly restart, execute, drain, and stop");
    QCOMPARE(operationCount.load(std::memory_order_relaxed), kLifecycleCycles);
    QCOMPARE(completionCount.load(std::memory_order_relaxed), kLifecycleCycles);
    QCOMPARE(unexpectedDisposition.load(std::memory_order_relaxed), 0);
}

void TestWebRtcClient::testPeerOperationExecutorHandlesReentrantLifecycleCallbacks() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    using Disposition = Executor::CompletionDisposition;
    using Priority = Executor::Priority;
    using Result = Executor::EnqueueResult;

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    Executor droppedExecutor(4);
    const bool droppedStarted = droppedExecutor.start();
    const Result blocker = droppedExecutor.enqueue(
        1,
        "reentrant-drop-blocker",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [barrier](uint64_t) {
            barrier->entered.store(true, std::memory_order_release);
            while (!barrier->release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });
    const bool blockerEntered = Executor::accepted(blocker) &&
        waitUntil(
            [barrier]() {
                return barrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));
    std::atomic<int> droppedCompletionCount{0};
    std::atomic<int> droppedDisposition{static_cast<int>(Disposition::Executed)};
    std::atomic<bool> reentrantStopReturned{false};
    std::atomic<bool> reentrantStartResult{true};
    const Result droppedTarget = droppedExecutor.enqueue(
        2,
        "reentrant-drop-target",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [](uint64_t) {},
        Executor::Criticality::State,
        [&droppedExecutor,
         &droppedCompletionCount,
         &droppedDisposition,
         &reentrantStopReturned,
         &reentrantStartResult](uint64_t, Disposition disposition) {
            droppedCompletionCount.fetch_add(1, std::memory_order_relaxed);
            droppedDisposition.store(
                static_cast<int>(disposition),
                std::memory_order_relaxed);
            droppedExecutor.stop();
            reentrantStopReturned.store(true, std::memory_order_release);
            reentrantStartResult.store(
                droppedExecutor.start(),
                std::memory_order_release);
        });
    BoundedTask droppedStop([&droppedExecutor]() { droppedExecutor.stop(); });
    const bool droppedStopReturnedWhileWorkerActive =
        droppedStop.waitFor(std::chrono::milliseconds(100));
    barrier->release.store(true, std::memory_order_release);
    const bool reentrantCompletionReturned = waitUntil(
        [&reentrantStopReturned]() {
            return reentrantStopReturned.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    const bool droppedStopReturned =
        droppedStop.waitFor(std::chrono::seconds(2));
    droppedStop.finishWithoutBlocking();

    Executor selfStopExecutor(4);
    const bool selfStopStarted = selfStopExecutor.start();
    std::atomic<bool> selfStopReturned{false};
    std::atomic<bool> selfCompletionEntered{false};
    std::atomic<bool> releaseSelfCompletion{false};
    std::atomic<int> selfStopCompletionCount{0};
    std::atomic<int> selfStopDisposition{
        static_cast<int>(Disposition::OperationThrew)};
    const Result selfStopResult = selfStopExecutor.enqueue(
        3,
        "worker-self-stop",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [&selfStopExecutor, &selfStopReturned](uint64_t) {
            selfStopExecutor.stop();
            selfStopReturned.store(true, std::memory_order_release);
        },
        Executor::Criticality::State,
        [&selfCompletionEntered,
         &releaseSelfCompletion,
         &selfStopCompletionCount,
         &selfStopDisposition](
            uint64_t,
            Disposition disposition) {
            selfStopDisposition.store(
                static_cast<int>(disposition),
                std::memory_order_relaxed);
            selfCompletionEntered.store(true, std::memory_order_release);
            while (!releaseSelfCompletion.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            selfStopCompletionCount.fetch_add(1, std::memory_order_release);
        });
    const bool workerSelfStopRequested = waitUntil(
        [&selfStopReturned, &selfCompletionEntered]() {
            return selfStopReturned.load(std::memory_order_acquire) &&
                selfCompletionEntered.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    const bool startRejectedWhileSelfStopPending = !selfStopExecutor.start();
    releaseSelfCompletion.store(true, std::memory_order_release);
    const bool workerSelfStopCompleted = waitUntil(
        [&selfStopCompletionCount]() {
            return selfStopCompletionCount.load(std::memory_order_acquire) == 1;
        },
        std::chrono::seconds(2));
    selfStopExecutor.stop();
    const bool restartAfterExternalJoin = waitUntil(
        [&selfStopExecutor]() {
            selfStopExecutor.stop();
            return selfStopExecutor.start();
        },
        std::chrono::seconds(2));
    selfStopExecutor.stop();

    struct JoinCycleBarrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> attemptNestedStop{false};
        std::atomic<bool> nestedStopReturned{false};
    };
    const auto joinCycleBarrier = std::make_shared<JoinCycleBarrier>();
    auto *joinCycleExecutor = new Executor(4);
    const bool joinCycleStarted = joinCycleExecutor->start();
    const Result joinCycleBlocker = joinCycleExecutor->enqueue(
        4,
        "external-stop-worker-stop-cycle",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [joinCycleExecutor, joinCycleBarrier](uint64_t) {
            joinCycleBarrier->entered.store(true, std::memory_order_release);
            while (!joinCycleBarrier->attemptNestedStop.load(
                std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            joinCycleExecutor->stop();
            joinCycleBarrier->nestedStopReturned.store(
                true,
                std::memory_order_release);
        });
    const bool joinCycleEntered = Executor::accepted(joinCycleBlocker) &&
        waitUntil(
            [joinCycleBarrier]() {
                return joinCycleBarrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));
    BoundedTask externalStop(
        [joinCycleExecutor]() { joinCycleExecutor->stop(); });
    const bool externalStopClosedAdmission = waitUntil(
        [joinCycleExecutor]() {
            return joinCycleExecutor->enqueue(
                       5,
                       "external-stop-worker-stop-probe",
                       Priority::Critical,
                       "probe",
                       [](uint64_t) { return true; },
                       [](uint64_t) {}) == Result::RejectedStopped;
        },
        std::chrono::seconds(2));
    joinCycleBarrier->attemptNestedStop.store(true, std::memory_order_release);
    const bool nestedStopReturnedDuringExternalJoin = waitUntil(
        [joinCycleBarrier]() {
            return joinCycleBarrier->nestedStopReturned.load(
                std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    const bool externalStopReturned =
        externalStop.waitFor(std::chrono::seconds(2));
    externalStop.finishWithoutBlocking();
    if (nestedStopReturnedDuringExternalJoin && externalStopReturned) {
        delete joinCycleExecutor;
    }

    struct DestructorJoinBarrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
        std::atomic<int> completionCount{0};
    };
    const auto destructorJoinBarrier =
        std::make_shared<DestructorJoinBarrier>();
    auto *destructorJoinExecutor = new Executor(4);
    const bool destructorJoinStarted = destructorJoinExecutor->start();
    const Result destructorJoinResult = destructorJoinExecutor->enqueue(
        6,
        "destructor-joins-after-callback",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [destructorJoinBarrier](uint64_t) {
            destructorJoinBarrier->entered.store(
                true,
                std::memory_order_release);
            while (!destructorJoinBarrier->release.load(
                std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        },
        Executor::Criticality::State,
        [destructorJoinBarrier](uint64_t, Disposition disposition) {
            if (disposition == Disposition::Executed) {
                destructorJoinBarrier->completionCount.fetch_add(
                    1,
                    std::memory_order_release);
            }
        });
    const bool destructorCallbackEntered =
        Executor::accepted(destructorJoinResult) && waitUntil(
            [destructorJoinBarrier]() {
                return destructorJoinBarrier->entered.load(
                    std::memory_order_acquire);
            },
            std::chrono::seconds(2));
    BoundedTask destructorTask(
        [destructorJoinExecutor]() { delete destructorJoinExecutor; });
    const bool destructorWaitedForCallback =
        !destructorTask.waitFor(std::chrono::milliseconds(100));
    destructorJoinBarrier->release.store(true, std::memory_order_release);
    const bool destructorReturned =
        destructorTask.waitFor(std::chrono::seconds(2));
    destructorTask.finishWithoutBlocking();

    qInfo().noquote()
        << QString("EXECUTOR_REENTRANT_BRANCH dropped_started=%1 blocker=%2 dropped_target=%3 outer_stop_nonblocking=%4 callback_returned=%5 nested_start=%6 outer_stop_returned=%7 drop_count=%8 self_started=%9 self_queued=%10 self_completed=%11 pending_start_rejected=%12 restart=%13 self_count=%14 join_cycle_started=%15 join_cycle_entered=%16 external_admission_closed=%17 worker_nested_stop_returned=%18 external_stop_returned=%19 destructor_started=%20 destructor_callback=%21 destructor_waited=%22 destructor_returned=%23 destructor_completions=%24")
               .arg(droppedStarted)
               .arg(blockerEntered)
               .arg(Executor::accepted(droppedTarget))
               .arg(droppedStopReturnedWhileWorkerActive)
               .arg(reentrantCompletionReturned)
               .arg(reentrantStartResult.load(std::memory_order_acquire))
               .arg(droppedStopReturned)
               .arg(droppedCompletionCount.load(std::memory_order_relaxed))
               .arg(selfStopStarted)
               .arg(Executor::accepted(selfStopResult))
               .arg(workerSelfStopCompleted)
               .arg(startRejectedWhileSelfStopPending)
               .arg(restartAfterExternalJoin)
               .arg(selfStopCompletionCount.load(std::memory_order_relaxed))
               .arg(joinCycleStarted)
               .arg(joinCycleEntered)
               .arg(externalStopClosedAdmission)
               .arg(nestedStopReturnedDuringExternalJoin)
               .arg(externalStopReturned)
               .arg(destructorJoinStarted)
               .arg(destructorCallbackEntered)
               .arg(destructorWaitedForCallback)
               .arg(destructorReturned)
               .arg(destructorJoinBarrier->completionCount.load(
                   std::memory_order_acquire));

    QVERIFY2(droppedStarted && blockerEntered &&
                 Executor::accepted(droppedTarget),
             "Could not construct the reentrant dropped-completion fixture");
    QVERIFY2(droppedStopReturnedWhileWorkerActive &&
                 reentrantCompletionReturned && droppedStopReturned,
             "Stop or its worker-owned dropped completion could not re-enter without blocking");
    QVERIFY2(!reentrantStartResult.load(std::memory_order_acquire),
             "A synchronous dropped completion reported start success during stop");
    QCOMPARE(droppedCompletionCount.load(std::memory_order_relaxed), 1);
    QCOMPARE(droppedDisposition.load(std::memory_order_relaxed),
             static_cast<int>(Disposition::DroppedOnStop));
    QVERIFY2(selfStopStarted && Executor::accepted(selfStopResult) &&
                 workerSelfStopRequested &&
                 workerSelfStopCompleted,
             "A worker operation could not request stop without deadlocking");
    QVERIFY2(startRejectedWhileSelfStopPending && restartAfterExternalJoin,
             "Worker-requested stop did not require and survive an external join");
    QCOMPARE(selfStopCompletionCount.load(std::memory_order_relaxed), 1);
    QCOMPARE(selfStopDisposition.load(std::memory_order_relaxed),
             static_cast<int>(Disposition::Executed));
    QVERIFY2(joinCycleStarted && joinCycleEntered &&
                 externalStopClosedAdmission &&
                 nestedStopReturnedDuringExternalJoin &&
                 externalStopReturned,
             "Worker stop reentry deadlocked against an external stop join");
    QVERIFY2(destructorJoinStarted && destructorCallbackEntered &&
                 destructorWaitedForCallback && destructorReturned,
             "Executor destruction did not join after its admitted callback unwound");
    QCOMPARE(destructorJoinBarrier->completionCount.load(
                 std::memory_order_acquire),
             1);
}

void TestWebRtcClient::testPeerOperationExecutorDelegatedStopDoesNotJoinActiveCallback() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    using Disposition = Executor::CompletionDisposition;
    using Priority = Executor::Priority;
    using Result = Executor::EnqueueResult;

    struct State {
        std::atomic<bool> operationEntered{false};
        std::atomic<bool> releaseOperation{false};
        std::atomic<bool> completionEntered{false};
        std::atomic<bool> delegateStopStarted{false};
        std::atomic<bool> delegateStopReturned{false};
        std::atomic<bool> workerWaitedForDelegate{false};
        std::atomic<bool> delegateReturnedBeforeEscape{false};
        std::atomic<bool> escapeTriggered{false};
        std::atomic<bool> completionReturned{false};
        std::atomic<int> completionCount{0};
        std::atomic<int> disposition{
            static_cast<int>(Disposition::OperationThrew)};
        std::atomic<bool> droppedOperationExecuted{false};
        std::atomic<bool> droppedCompletionAfterPrimaryReturn{false};
        std::atomic<int> droppedCompletionCount{0};
        std::atomic<int> droppedDisposition{
            static_cast<int>(Disposition::Executed)};
    };

    const auto state = std::make_shared<State>();
    auto *executor = new Executor(4);
    const bool started = executor->start();
    const Result result = executor->enqueue(
        6,
        "delegated-stop-from-worker-completion",
        Priority::Ordinary,
        {},
        [](uint64_t) { return true; },
        [state](uint64_t) {
            state->operationEntered.store(true, std::memory_order_release);
            while (!state->releaseOperation.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        },
        Executor::Criticality::State,
        [executor, state](uint64_t, Disposition disposition) {
            state->completionEntered.store(true, std::memory_order_release);
            state->disposition.store(
                static_cast<int>(disposition),
                std::memory_order_relaxed);
            state->completionCount.fetch_add(1, std::memory_order_relaxed);

            std::thread delegate([executor, state]() {
                state->delegateStopStarted.store(true, std::memory_order_release);
                executor->stop();
                state->delegateStopReturned.store(true, std::memory_order_release);
            });
            delegate.detach();

            const bool delegateStarted = waitUntil(
                [state]() {
                    return state->delegateStopStarted.load(
                        std::memory_order_acquire);
                },
                std::chrono::seconds(1));
            state->workerWaitedForDelegate.store(
                delegateStarted,
                std::memory_order_release);
            const bool delegateReturned = delegateStarted && waitUntil(
                [state]() {
                    return state->delegateStopReturned.load(
                        std::memory_order_acquire);
                },
                std::chrono::milliseconds(250));
            state->delegateReturnedBeforeEscape.store(
                delegateReturned,
                std::memory_order_release);
            if (!delegateReturned) {
                // This bounded escape is part of the measuring instrument. It
                // releases the worker callback so the known-bad join cycle can
                // unwind and report RED instead of hanging the test process.
                state->escapeTriggered.store(true, std::memory_order_release);
            }
            state->completionReturned.store(true, std::memory_order_release);
        });

    const bool operationEntered = Executor::accepted(result) && waitUntil(
        [state]() {
            return state->operationEntered.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    const Result droppedTarget = executor->enqueue(
        7,
        "delegated-stop-pending-completion",
        Priority::Critical,
        "delegated-stop-pending-completion",
        [](uint64_t) { return true; },
        [state](uint64_t) {
            state->droppedOperationExecuted.store(
                true,
                std::memory_order_release);
        },
        Executor::Criticality::Convergent,
        [state](uint64_t, Disposition disposition) {
            state->droppedDisposition.store(
                static_cast<int>(disposition),
                std::memory_order_relaxed);
            state->droppedCompletionAfterPrimaryReturn.store(
                state->completionReturned.load(std::memory_order_acquire),
                std::memory_order_release);
            state->droppedCompletionCount.fetch_add(
                1,
                std::memory_order_release);
        });
    state->releaseOperation.store(true, std::memory_order_release);

    const bool completionReturned = operationEntered &&
        Executor::accepted(droppedTarget) && waitUntil(
        [state]() {
            return state->completionReturned.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    const bool delegateEventuallyReturned = waitUntil(
        [state]() {
            return state->delegateStopReturned.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    const bool droppedCompletionReturned = waitUntil(
        [state]() {
            return state->droppedCompletionCount.load(
                std::memory_order_acquire) == 1;
        },
        std::chrono::seconds(2));
    executor->stop();
    delete executor;

    qInfo().noquote()
        << QString("EXECUTOR_DELEGATED_STOP_BRANCH started=%1 queued=%2 operation_entered=%3 pending_queued=%4 completion_on_worker=%5 delegate_stop_started=%6 worker_waits_delegate=%7 delegate_returned_before_escape=%8 escape=%9 completion_returned=%10 delegate_eventually_returned=%11 completion_count=%12 disposition=%13 dropped_completion=%14 dropped_after_primary=%15 dropped_operation=%16 dropped_disposition=%17")
               .arg(started)
               .arg(Executor::accepted(result))
               .arg(operationEntered)
               .arg(Executor::accepted(droppedTarget))
               .arg(state->completionEntered.load(std::memory_order_acquire))
               .arg(state->delegateStopStarted.load(std::memory_order_acquire))
               .arg(state->workerWaitedForDelegate.load(std::memory_order_acquire))
               .arg(state->delegateReturnedBeforeEscape.load(
                   std::memory_order_acquire))
               .arg(state->escapeTriggered.load(std::memory_order_acquire))
               .arg(completionReturned)
               .arg(delegateEventuallyReturned)
               .arg(state->completionCount.load(std::memory_order_relaxed))
               .arg(state->disposition.load(std::memory_order_relaxed))
               .arg(droppedCompletionReturned)
               .arg(state->droppedCompletionAfterPrimaryReturn.load(
                   std::memory_order_acquire))
               .arg(state->droppedOperationExecuted.load(
                   std::memory_order_acquire))
               .arg(state->droppedDisposition.load(std::memory_order_relaxed));

    QVERIFY2(started && Executor::accepted(result) && operationEntered &&
                 Executor::accepted(droppedTarget) &&
                 state->completionEntered.load(std::memory_order_acquire) &&
                 state->delegateStopStarted.load(std::memory_order_acquire) &&
                 state->workerWaitedForDelegate.load(std::memory_order_acquire),
             "Could not construct the delegated-stop join-cycle fixture");
    QVERIFY2(state->delegateReturnedBeforeEscape.load(
                 std::memory_order_acquire),
             "A delegated stop joined the worker while its active completion waited for that delegate");
    QVERIFY2(!state->escapeTriggered.load(std::memory_order_acquire),
             "The delegated-stop join cycle required the test instrument's bounded escape");
    QVERIFY2(completionReturned && delegateEventuallyReturned,
             "The delegated-stop fixture did not unwind after its bounded escape");
    QCOMPARE(state->completionCount.load(std::memory_order_relaxed), 1);
    QCOMPARE(state->disposition.load(std::memory_order_relaxed),
             static_cast<int>(Disposition::Executed));
    QVERIFY2(droppedCompletionReturned &&
                 state->droppedCompletionAfterPrimaryReturn.load(
                     std::memory_order_acquire) &&
                 !state->droppedOperationExecuted.load(
                     std::memory_order_acquire),
             "A stop-owned dropped completion ran synchronously or executed its cancelled operation");
    QCOMPARE(state->droppedCompletionCount.load(std::memory_order_relaxed), 1);
    QCOMPARE(state->droppedDisposition.load(std::memory_order_relaxed),
             static_cast<int>(Disposition::DroppedOnStop));
}

void TestWebRtcClient::testPeerOperationExecutorReportsEveryCompletionDisposition() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    using Disposition = Executor::CompletionDisposition;
    using Priority = Executor::Priority;
    using Criticality = Executor::Criticality;
    using Result = Executor::EnqueueResult;

    struct CompletionRecord {
        std::string label;
        uint64_t generation = 0;
        Disposition disposition = Disposition::Executed;
    };
    struct Ledger {
        std::mutex mutex;
        std::vector<CompletionRecord> records;
    };
    const auto ledger = std::make_shared<Ledger>();
    const auto completion = [ledger](std::string label) {
        return [ledger, label = std::move(label)](
                   uint64_t generation,
                   Disposition disposition) {
            std::lock_guard<std::mutex> lock(ledger->mutex);
            ledger->records.push_back({label, generation, disposition});
        };
    };
    const auto hasCompletion = [ledger](const std::string &label) {
        std::lock_guard<std::mutex> lock(ledger->mutex);
        return std::any_of(
            ledger->records.begin(),
            ledger->records.end(),
            [&](const CompletionRecord &record) {
                return record.label == label;
            });
    };
    const auto current = [](uint64_t) { return true; };

    bool simpleStarted = false;
    bool simpleDrained = false;
    Result executedResult = Result::RejectedInvalid;
    Result threwResult = Result::RejectedInvalid;
    Result staleResult = Result::RejectedInvalid;
    {
        Executor executor(8);
        simpleStarted = executor.start();
        executedResult = executor.enqueue(
            11,
            "completion-executed",
            Priority::Ordinary,
            {},
            current,
            [](uint64_t) {},
            Criticality::State,
            completion("executed"));
        threwResult = executor.enqueue(
            12,
            "completion-threw",
            Priority::Ordinary,
            {},
            current,
            [](uint64_t) {
                throw std::runtime_error("deterministic operation failure");
            },
            Criticality::State,
            completion("operation-threw"));
        staleResult = executor.enqueue(
            13,
            "completion-stale",
            Priority::Ordinary,
            {},
            [](uint64_t) { return false; },
            [](uint64_t) {},
            Criticality::State,
            completion("stale-generation"));
        simpleDrained = executor.waitUntilIdle(std::chrono::seconds(2));
        executor.stop();
    }

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto parkWorker = [](const std::shared_ptr<Barrier> &barrier) {
        return [barrier](uint64_t) {
            barrier->entered.store(true, std::memory_order_release);
            while (!barrier->release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        };
    };

    bool supersedeStarted = false;
    bool supersedeBlockerEntered = false;
    bool supersedeDrained = false;
    Result supersededOriginal = Result::RejectedInvalid;
    Result supersedingReplacement = Result::RejectedInvalid;
    {
        const auto barrier = std::make_shared<Barrier>();
        Executor executor(4);
        supersedeStarted = executor.start();
        (void)executor.enqueue(
            20,
            "supersede-blocker",
            Priority::Ordinary,
            {},
            current,
            parkWorker(barrier));
        supersedeBlockerEntered = waitUntil(
            [barrier]() {
                return barrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));
        supersededOriginal = executor.enqueue(
            21,
            "supersede-peer",
            Priority::Critical,
            "same-operation",
            current,
            [](uint64_t) {},
            Criticality::State,
            completion("superseded"));
        supersedingReplacement = executor.enqueue(
            22,
            "supersede-peer",
            Priority::Critical,
            "same-operation",
            current,
            [](uint64_t) {},
            Criticality::State);
        barrier->release.store(true, std::memory_order_release);
        supersedeDrained = executor.waitUntilIdle(std::chrono::seconds(2));
        executor.stop();
    }

    bool evictionStarted = false;
    bool evictionBlockerEntered = false;
    bool evictionDrained = false;
    Result evictionTarget = Result::RejectedInvalid;
    Result evictorResult = Result::RejectedInvalid;
    {
        const auto barrier = std::make_shared<Barrier>();
        Executor executor(1);
        evictionStarted = executor.start();
        (void)executor.enqueue(
            30,
            "eviction-blocker",
            Priority::Ordinary,
            {},
            current,
            parkWorker(barrier));
        evictionBlockerEntered = waitUntil(
            [barrier]() {
                return barrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));
        evictionTarget = executor.enqueue(
            31,
            "eviction-target",
            Priority::Critical,
            "target",
            current,
            [](uint64_t) {},
            Criticality::Convergent,
            completion("evicted"));
        evictorResult = executor.enqueue(
            32,
            "evictor",
            Priority::Critical,
            "evictor",
            current,
            [](uint64_t) {},
            Criticality::Convergent);
        barrier->release.store(true, std::memory_order_release);
        evictionDrained = executor.waitUntilIdle(std::chrono::seconds(2));
        executor.stop();
    }

    Executor stoppedExecutor(2);
    const Result invalidResult = stoppedExecutor.enqueue(
        0,
        "invalid",
        Priority::Ordinary,
        {},
        current,
        [](uint64_t) {},
        Criticality::State,
        completion("rejected-invalid"));
    const Result stoppedResult = stoppedExecutor.enqueue(
        40,
        "stopped",
        Priority::Critical,
        "stopped",
        current,
        [](uint64_t) {},
        Criticality::State,
        completion("rejected-stopped"));

    bool ordinaryStarted = false;
    bool ordinaryBlockerEntered = false;
    bool ordinaryDrained = false;
    Result ordinaryFiller = Result::RejectedInvalid;
    Result ordinaryRejected = Result::RejectedInvalid;
    {
        const auto barrier = std::make_shared<Barrier>();
        Executor executor(1);
        ordinaryStarted = executor.start();
        (void)executor.enqueue(
            50,
            "ordinary-blocker",
            Priority::Critical,
            "blocker",
            current,
            parkWorker(barrier),
            Criticality::Convergent);
        ordinaryBlockerEntered = waitUntil(
            [barrier]() {
                return barrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));
        ordinaryFiller = executor.enqueue(
            51,
            "ordinary-filler",
            Priority::Ordinary,
            {},
            current,
            [](uint64_t) {});
        ordinaryRejected = executor.enqueue(
            52,
            "ordinary-rejected",
            Priority::Ordinary,
            {},
            current,
            [](uint64_t) {},
            Criticality::State,
            completion("rejected-ordinary-capacity"));
        barrier->release.store(true, std::memory_order_release);
        ordinaryDrained = executor.waitUntilIdle(std::chrono::seconds(2));
        executor.stop();
    }

    bool criticalStarted = false;
    bool criticalBlockerEntered = false;
    bool criticalDrained = false;
    Result criticalFiller = Result::RejectedInvalid;
    Result criticalRejected = Result::RejectedInvalid;
    {
        const auto barrier = std::make_shared<Barrier>();
        Executor executor(1);
        criticalStarted = executor.start();
        (void)executor.enqueue(
            60,
            "critical-blocker",
            Priority::Ordinary,
            {},
            current,
            parkWorker(barrier));
        criticalBlockerEntered = waitUntil(
            [barrier]() {
                return barrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));
        criticalFiller = executor.enqueue(
            61,
            "critical-filler",
            Priority::Critical,
            "convergent",
            current,
            [](uint64_t) {},
            Criticality::Convergent);
        criticalRejected = executor.enqueue(
            62,
            "critical-rejected",
            Priority::Critical,
            "state",
            current,
            [](uint64_t) {},
            Criticality::State,
            completion("rejected-critical-capacity"));
        barrier->release.store(true, std::memory_order_release);
        criticalDrained = executor.waitUntilIdle(std::chrono::seconds(2));
        executor.stop();
    }

    bool dropStarted = false;
    bool dropBlockerEntered = false;
    bool dropObserved = false;
    bool dropStopCompleted = false;
    Result dropTarget = Result::RejectedInvalid;
    {
        const auto barrier = std::make_shared<Barrier>();
        const auto executor = std::make_shared<Executor>(2);
        dropStarted = executor->start();
        (void)executor->enqueue(
            70,
            "drop-blocker",
            Priority::Ordinary,
            {},
            current,
            parkWorker(barrier));
        dropBlockerEntered = waitUntil(
            [barrier]() {
                return barrier->entered.load(std::memory_order_acquire);
            },
            std::chrono::seconds(2));
        dropTarget = executor->enqueue(
            71,
            "drop-target",
            Priority::Critical,
            "drop-target",
            current,
            [](uint64_t) {},
            Criticality::Convergent,
            completion("dropped-on-stop"));
        BoundedTask stopTask([executor]() { executor->stop(); });
        dropStopCompleted = stopTask.waitFor(std::chrono::milliseconds(100));
        barrier->release.store(true, std::memory_order_release);
        dropObserved = waitUntil(
            [&]() { return hasCompletion("dropped-on-stop"); },
            std::chrono::seconds(2));
        dropStopCompleted = dropStopCompleted &&
            stopTask.waitFor(std::chrono::seconds(2));
        stopTask.finishWithoutBlocking();
    }

    std::vector<CompletionRecord> records;
    {
        std::lock_guard<std::mutex> lock(ledger->mutex);
        records = ledger->records;
    }
    const auto exactCompletionCount = [&records](
                                          const std::string &label,
                                          uint64_t generation,
                                          Disposition disposition) {
        return static_cast<int>(std::count_if(
            records.begin(),
            records.end(),
            [&](const CompletionRecord &record) {
                return record.label == label &&
                    record.generation == generation &&
                    record.disposition == disposition;
            }));
    };

    QVERIFY2(simpleStarted && simpleDrained &&
                 Executor::accepted(executedResult) &&
                 Executor::accepted(threwResult) &&
                 Executor::accepted(staleResult),
             "Simple executor completion fixtures did not run and drain");
    QVERIFY2(supersedeStarted && supersedeBlockerEntered && supersedeDrained,
             "Supersession fixture did not hold and drain the worker");
    QCOMPARE(supersededOriginal, Result::Queued);
    QCOMPARE(supersedingReplacement, Result::CoalescedCritical);
    QVERIFY2(evictionStarted && evictionBlockerEntered && evictionDrained,
             "Eviction fixture did not hold and drain the worker");
    QCOMPARE(evictionTarget, Result::Queued);
    QCOMPARE(evictorResult, Result::QueuedAfterEvictingCritical);
    QCOMPARE(invalidResult, Result::RejectedInvalid);
    QCOMPARE(stoppedResult, Result::RejectedStopped);
    QVERIFY2(ordinaryStarted && ordinaryBlockerEntered && ordinaryDrained,
             "Ordinary-capacity fixture did not hold and drain the worker");
    QCOMPARE(ordinaryFiller, Result::Queued);
    QCOMPARE(ordinaryRejected, Result::RejectedOrdinaryCapacity);
    QVERIFY2(criticalStarted && criticalBlockerEntered && criticalDrained,
             "Critical-capacity fixture did not hold and drain the worker");
    QCOMPARE(criticalFiller, Result::Queued);
    QCOMPARE(criticalRejected, Result::RejectedCriticalCapacity);
    QVERIFY2(dropStarted && dropBlockerEntered && dropObserved &&
                 dropStopCompleted,
             "Stop did not synchronously disposition queued work before joining");
    QCOMPARE(dropTarget, Result::Queued);

    QCOMPARE(static_cast<int>(records.size()), 10);
    QCOMPARE(exactCompletionCount("executed", 11, Disposition::Executed), 1);
    QCOMPARE(exactCompletionCount(
                 "operation-threw", 12, Disposition::OperationThrew),
             1);
    QCOMPARE(exactCompletionCount(
                 "stale-generation", 13, Disposition::StaleGeneration),
             1);
    QCOMPARE(exactCompletionCount(
                 "superseded", 21, Disposition::Superseded),
             1);
    QCOMPARE(exactCompletionCount("evicted", 31, Disposition::Evicted), 1);
    QCOMPARE(exactCompletionCount(
                 "rejected-invalid", 0, Disposition::RejectedInvalid),
             1);
    QCOMPARE(exactCompletionCount(
                 "rejected-stopped", 40, Disposition::RejectedStopped),
             1);
    QCOMPARE(exactCompletionCount(
                 "rejected-ordinary-capacity",
                 52,
                 Disposition::RejectedOrdinaryCapacity),
             1);
    QCOMPARE(exactCompletionCount(
                 "rejected-critical-capacity",
                 62,
                 Disposition::RejectedCriticalCapacity),
             1);
    QCOMPARE(exactCompletionCount(
                 "dropped-on-stop", 71, Disposition::DroppedOnStop),
             1);
}

void TestWebRtcClient::testDuplicateOfferRecheckExecutorDispositionCleanup_data() {
    using Disposition = versus::app::GenerationTaggedPeerOperationExecutor::
        CompletionDisposition;
    QTest::addColumn<int>("rawDisposition");
    QTest::newRow("operation-threw")
        << static_cast<int>(Disposition::OperationThrew);
    QTest::newRow("stale-generation")
        << static_cast<int>(Disposition::StaleGeneration);
    QTest::newRow("superseded")
        << static_cast<int>(Disposition::Superseded);
    QTest::newRow("evicted")
        << static_cast<int>(Disposition::Evicted);
    QTest::newRow("rejected-invalid")
        << static_cast<int>(Disposition::RejectedInvalid);
    QTest::newRow("rejected-stopped")
        << static_cast<int>(Disposition::RejectedStopped);
    QTest::newRow("rejected-ordinary-capacity")
        << static_cast<int>(Disposition::RejectedOrdinaryCapacity);
    QTest::newRow("rejected-critical-capacity")
        << static_cast<int>(Disposition::RejectedCriticalCapacity);
    QTest::newRow("dropped-on-stop")
        << static_cast<int>(Disposition::DroppedOnStop);
}

void TestWebRtcClient::testDuplicateOfferRecheckExecutorDispositionCleanup() {
    using Disposition = versus::app::GenerationTaggedPeerOperationExecutor::
        CompletionDisposition;
    QFETCH(int, rawDisposition);
    const auto disposition = static_cast<Disposition>(rawDisposition);

    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-executor-disposition-cleanup-" + std::to_string(rawDisposition));
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);
    if (fixtureReady) {
        versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(
            *app,
            peer);
    }
    const bool pendingBeforeCompletion =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckPending(peer);
    const std::size_t jobsBeforeCompletion =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckJobCount(*app);
    const bool completionInvoked = fixtureReady &&
        versus::app::VersusAppTestAccess::completePendingDuplicateOfferRecheckAs(
            *app,
            peer,
            disposition);
    const bool pendingAfterCompletion =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckPending(peer);
    const std::size_t jobsAfterCompletion =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckJobCount(*app);
    const uint64_t canceled =
        versus::app::VersusAppTestAccess::duplicateOfferRechecksCanceled(peer);
    app->shutdown();

    QVERIFY2(fixtureReady,
             "Could not construct defensive executor-disposition fixture");
    QVERIFY2(pendingBeforeCompletion && jobsBeforeCompletion == 1,
             "The exact pending scheduler job was not installed");
    QVERIFY2(completionInvoked,
             "The exact pending scheduler job could not receive completion");
    QVERIFY2(!pendingAfterCompletion && jobsAfterCompletion == 0,
             "A non-executed executor completion left pending scheduler state");
    QCOMPARE(canceled, uint64_t{1});
}

void TestWebRtcClient::testDuplicateOfferRecheckOperationThrowCleansPendingJob() {
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-recheck-operation-throw");
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);
    versus::app::VersusAppTestAccess::setDuplicateOfferRecheckHooks(
        *app,
        {},
        [](uint64_t) {
            throw std::runtime_error("deterministic duplicate recheck failure");
        });
    if (fixtureReady) {
        versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(
            *app,
            peer);
    }
    const bool completionObserved = waitUntil(
        [&]() {
            return versus::app::VersusAppTestAccess::
                       duplicateOfferRechecksCanceled(peer) == 1 &&
                !versus::app::VersusAppTestAccess::
                    duplicateOfferRecheckPending(peer) &&
                !versus::app::VersusAppTestAccess::
                    hasDuplicateOfferRecheckJob(*app, peer);
        },
        std::chrono::seconds(4));
    const bool executorDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(
            *app,
            std::chrono::seconds(2));
    versus::app::VersusAppTestAccess::clearDuplicateOfferRecheckHooks(*app);
    app->shutdown();

    QVERIFY2(fixtureReady,
             "Could not construct duplicate recheck throw fixture");
    QVERIFY2(completionObserved,
             "OperationThrew did not finalize the exact scheduler job");
    QVERIFY2(executorDrained,
             "Executor did not drain after the throwing recheck operation");
}

void TestWebRtcClient::testDuplicateOfferRecheckSupersessionCleansPendingJob() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    auto app = std::make_shared<versus::app::VersusApp>(1);
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-recheck-executor-supersession");
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    const auto blockerResult =
        versus::app::VersusAppTestAccess::enqueueExecutorOperation(
            *app,
            9101,
            "supersession-blocker",
            Executor::Priority::Critical,
            "supersession-blocker",
            [barrier](uint64_t) {
                barrier->entered.store(true, std::memory_order_release);
                while (!barrier->release.load(std::memory_order_acquire)) {
                    std::this_thread::yield();
                }
            },
            Executor::Criticality::Convergent);
    const bool blockerEntered = waitUntil(
        [barrier]() { return barrier->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));
    if (fixtureReady) {
        versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(
            *app,
            peer);
    }
    const bool recheckQueued = waitUntil(
        [&]() {
            return versus::app::VersusAppTestAccess::
                       duplicateOfferRechecksFired(peer) == 1 &&
                versus::app::VersusAppTestAccess::pendingCount(*app) >= 2;
        },
        std::chrono::seconds(4));
    const std::string ownerKey =
        versus::app::VersusAppTestAccess::peerOwnerKey(*app, peer);
    const auto supersedingResult =
        versus::app::VersusAppTestAccess::enqueueExecutorOperation(
            *app,
            9102,
            ownerKey,
            Executor::Priority::Critical,
            "duplicate-offer-recheck",
            [](uint64_t) {},
            Executor::Criticality::Convergent);
    const bool completionObserved = waitUntil(
        [&]() {
            return versus::app::VersusAppTestAccess::
                       duplicateOfferRechecksCanceled(peer) == 1 &&
                !versus::app::VersusAppTestAccess::
                    duplicateOfferRecheckPending(peer) &&
                !versus::app::VersusAppTestAccess::
                    hasDuplicateOfferRecheckJob(*app, peer);
        },
        std::chrono::seconds(2));
    barrier->release.store(true, std::memory_order_release);
    const bool executorDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(
            *app,
            std::chrono::seconds(2));
    app->shutdown();

    QVERIFY2(fixtureReady && blockerEntered && Executor::accepted(blockerResult),
             "Could not construct scheduler supersession fixture");
    QVERIFY2(recheckQueued,
             "Duplicate recheck was not queued behind the parked worker");
    QCOMPARE(supersedingResult, Executor::EnqueueResult::CoalescedCritical);
    QVERIFY2(completionObserved,
             "Superseded did not finalize the exact scheduler job");
    QVERIFY2(executorDrained,
             "Executor did not drain after scheduler-job supersession");
}

void TestWebRtcClient::testDuplicateOfferRecheckStaleCompletionDoesNotDoubleFinalize() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    auto app = std::make_shared<versus::app::VersusApp>(2);
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-recheck-stale-completion");
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    const auto blockerResult =
        versus::app::VersusAppTestAccess::enqueueExecutorOperation(
            *app,
            9201,
            "stale-completion-blocker",
            Executor::Priority::Critical,
            "stale-completion-blocker",
            [barrier](uint64_t) {
                barrier->entered.store(true, std::memory_order_release);
                while (!barrier->release.load(std::memory_order_acquire)) {
                    std::this_thread::yield();
                }
            },
            Executor::Criticality::Convergent);
    const bool blockerEntered = waitUntil(
        [barrier]() { return barrier->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));
    if (fixtureReady) {
        versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(
            *app,
            peer);
    }
    const bool recheckQueued = waitUntil(
        [&]() {
            return versus::app::VersusAppTestAccess::
                       duplicateOfferRechecksFired(peer) == 1 &&
                versus::app::VersusAppTestAccess::pendingCount(*app) >= 2;
        },
        std::chrono::seconds(4));
    const auto statsBeforeCancel =
        versus::app::VersusAppTestAccess::executorStats(*app);
    versus::app::VersusAppTestAccess::cancelDuplicateOfferRechecks(*app);
    const bool cleanedAtCancel =
        !versus::app::VersusAppTestAccess::duplicateOfferRecheckPending(peer) &&
        !versus::app::VersusAppTestAccess::hasDuplicateOfferRecheckJob(
            *app,
            peer) &&
        versus::app::VersusAppTestAccess::duplicateOfferRechecksCanceled(peer) ==
            1;
    barrier->release.store(true, std::memory_order_release);
    const bool executorDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(
            *app,
            std::chrono::seconds(2));
    const auto statsAfterDrain =
        versus::app::VersusAppTestAccess::executorStats(*app);
    const uint64_t canceledAfterDrain =
        versus::app::VersusAppTestAccess::duplicateOfferRechecksCanceled(peer);
    app->shutdown();

    QVERIFY2(fixtureReady && blockerEntered && Executor::accepted(blockerResult),
             "Could not construct stale-completion fixture");
    QVERIFY2(recheckQueued,
             "Duplicate recheck was not queued behind the parked worker");
    QVERIFY2(cleanedAtCancel,
             "Cancellation did not finalize the exact scheduler job");
    QVERIFY2(executorDrained,
             "Executor did not drain the now-stale recheck");
    QCOMPARE(statsAfterDrain.staleGeneration,
             statsBeforeCancel.staleGeneration + uint64_t{1});
    QCOMPARE(canceledAfterDrain, uint64_t{1});
}

void TestWebRtcClient::testDuplicateOfferRecheckDroppedOnStopCleansPendingJob() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    auto app = std::make_shared<versus::app::VersusApp>(2);
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-recheck-dropped-on-stop");
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    const auto blockerResult =
        versus::app::VersusAppTestAccess::enqueueExecutorOperation(
            *app,
            9301,
            "drop-integration-blocker",
            Executor::Priority::Critical,
            "drop-integration-blocker",
            [barrier](uint64_t) {
                barrier->entered.store(true, std::memory_order_release);
                while (!barrier->release.load(std::memory_order_acquire)) {
                    std::this_thread::yield();
                }
            },
            Executor::Criticality::Convergent);
    const bool blockerEntered = waitUntil(
        [barrier]() { return barrier->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));
    if (fixtureReady) {
        versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(
            *app,
            peer);
    }
    const bool recheckQueued = waitUntil(
        [&]() {
            return versus::app::VersusAppTestAccess::
                       duplicateOfferRechecksFired(peer) == 1 &&
                versus::app::VersusAppTestAccess::pendingCount(*app) >= 2;
        },
        std::chrono::seconds(4));
    BoundedTask stopTask([app]() {
        versus::app::VersusAppTestAccess::stopPeerOperationExecutor(*app);
    });
    const bool stopReturnedWhileBlockerActive =
        stopTask.waitFor(std::chrono::milliseconds(100));
    barrier->release.store(true, std::memory_order_release);
    const bool completionObserved = waitUntil(
        [&]() {
            return versus::app::VersusAppTestAccess::
                       duplicateOfferRechecksCanceled(peer) == 1 &&
                !versus::app::VersusAppTestAccess::
                    duplicateOfferRecheckPending(peer) &&
                !versus::app::VersusAppTestAccess::
                    hasDuplicateOfferRecheckJob(*app, peer);
        },
        std::chrono::seconds(2));
    const bool stopCompleted = stopTask.waitFor(std::chrono::seconds(2));
    stopTask.finishWithoutBlocking();
    app->shutdown();

    QVERIFY2(fixtureReady && blockerEntered && Executor::accepted(blockerResult),
             "Could not construct dropped-on-stop scheduler fixture");
    QVERIFY2(recheckQueued,
             "Duplicate recheck was not queued behind the parked worker");
    QVERIFY2(completionObserved,
             "DroppedOnStop did not finalize the exact scheduler job");
    QVERIFY2(stopReturnedWhileBlockerActive,
             "Executor stop waited for its already-running blocker");
    QVERIFY2(stopCompleted,
             "Executor stop did not complete after releasing its blocker");
}

void TestWebRtcClient::testDuplicateOfferRecheckRejectedStoppedCleansPendingJob() {
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-recheck-rejected-stopped");
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);
    versus::app::VersusAppTestAccess::stopPeerOperationExecutor(*app);
    const auto statsBefore =
        versus::app::VersusAppTestAccess::executorStats(*app);
    if (fixtureReady) {
        versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(
            *app,
            peer);
    }
    const bool completionObserved = waitUntil(
        [&]() {
            return versus::app::VersusAppTestAccess::
                       duplicateOfferRechecksFired(peer) == 1 &&
                versus::app::VersusAppTestAccess::
                       duplicateOfferRechecksCanceled(peer) == 1 &&
                !versus::app::VersusAppTestAccess::
                    duplicateOfferRecheckPending(peer) &&
                !versus::app::VersusAppTestAccess::
                    hasDuplicateOfferRecheckJob(*app, peer);
        },
        std::chrono::seconds(4));
    const auto statsAfter =
        versus::app::VersusAppTestAccess::executorStats(*app);
    app->shutdown();

    QVERIFY2(fixtureReady,
             "Could not construct stopped-executor scheduler fixture");
    QVERIFY2(completionObserved,
             "RejectedStopped did not finalize the exact scheduler job");
    QCOMPARE(statsAfter.rejectedStopped,
             statsBefore.rejectedStopped + uint64_t{1});
}

void TestWebRtcClient::testEvictedDuplicateOfferRecheckReceivesCompletion() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    auto app = std::make_shared<versus::app::VersusApp>(1);
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-recheck-eviction");
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    const auto blockerResult =
        versus::app::VersusAppTestAccess::enqueueExecutorOperation(
            *app,
            9001,
            "executor-blocker",
            Executor::Priority::Critical,
            "executor-blocker",
            [barrier](uint64_t) {
                barrier->entered.store(true, std::memory_order_release);
                while (!barrier->release.load(std::memory_order_acquire)) {
                    std::this_thread::yield();
                }
            },
            Executor::Criticality::Convergent);
    const bool blockerEntered = waitUntil(
        [barrier]() { return barrier->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));

    if (fixtureReady) {
        versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(*app, peer);
    }
    const bool recheckQueued = waitUntil(
        [&]() {
            return versus::app::VersusAppTestAccess::duplicateOfferRechecksFired(
                       peer) == 1 &&
                versus::app::VersusAppTestAccess::pendingCount(*app) >= 2;
        },
        std::chrono::seconds(4));
    const auto evictorResult =
        versus::app::VersusAppTestAccess::enqueueExecutorOperation(
            *app,
            9002,
            "executor-evictor",
            Executor::Priority::Critical,
            "executor-evictor",
            [](uint64_t) {},
            Executor::Criticality::Convergent);
    barrier->release.store(true, std::memory_order_release);
    const bool executorDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(
            *app,
            std::chrono::seconds(3));
    const bool pendingAfterEviction =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckPending(peer);
    const std::size_t jobsAfterEviction =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckJobCount(*app);
    const uint64_t canceledAfterEviction =
        versus::app::VersusAppTestAccess::duplicateOfferRechecksCanceled(peer);
    app->shutdown();

    QVERIFY2(fixtureReady, "Could not construct the executor-eviction fixture");
    QVERIFY(Executor::accepted(blockerResult));
    QVERIFY2(blockerEntered, "The executor blocker did not enter");
    QVERIFY2(recheckQueued,
             "The duplicate recheck was not dispatched behind the executor blocker");
    QCOMPARE(evictorResult, Executor::EnqueueResult::QueuedAfterEvictingCritical);
    QVERIFY2(executorDrained, "The executor did not drain after eviction");
    QVERIFY2(!pendingAfterEviction,
             "An evicted duplicate recheck remained permanently pending");
    QCOMPARE(jobsAfterEviction, std::size_t{0});
    QCOMPARE(canceledAfterEviction, uint64_t{1});
}

void TestWebRtcClient::testCancelIsBarrierAgainstAdmittedDuplicateRecheck() {
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-recheck-cancel-barrier");
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);
    const uint64_t generationA =
        versus::app::VersusAppTestAccess::generation(peer);
    const uint64_t offerCountA =
        versus::app::VersusAppTestAccess::offerCount(peer);

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    versus::app::VersusAppTestAccess::setDuplicateOfferRecheckHooks(
        *app,
        {},
        {},
        [barrier](uint64_t) {
            barrier->entered.store(true, std::memory_order_release);
            while (!barrier->release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });
    if (fixtureReady) {
        versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(*app, peer);
    }
    const bool admittedWorkParked = waitUntil(
        [barrier]() { return barrier->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(4));
    const uint64_t generationWhileParked =
        versus::app::VersusAppTestAccess::generation(peer);
    const uint64_t offerCountWhileParked =
        versus::app::VersusAppTestAccess::offerCount(peer);

    struct CancelSnapshot {
        std::atomic<uint64_t> generation{0};
        std::atomic<uint64_t> offerCount{0};
        std::atomic<uint64_t> rebuilt{0};
        std::atomic<uint64_t> canceled{0};
        std::atomic<bool> pending{true};
        std::atomic<std::size_t> jobs{1};
    };
    const auto cancelSnapshot = std::make_shared<CancelSnapshot>();
    BoundedTask cancelTask([app, peer, cancelSnapshot]() {
        versus::app::VersusAppTestAccess::cancelDuplicateOfferRechecks(*app);
        cancelSnapshot->generation.store(
            versus::app::VersusAppTestAccess::generation(peer),
            std::memory_order_release);
        cancelSnapshot->offerCount.store(
            versus::app::VersusAppTestAccess::offerCount(peer),
            std::memory_order_release);
        cancelSnapshot->rebuilt.store(
            versus::app::VersusAppTestAccess::
                duplicateOfferRechecksRebuilt(peer),
            std::memory_order_release);
        cancelSnapshot->canceled.store(
            versus::app::VersusAppTestAccess::
                duplicateOfferRechecksCanceled(peer),
            std::memory_order_release);
        cancelSnapshot->pending.store(
            versus::app::VersusAppTestAccess::
                duplicateOfferRecheckPending(peer),
            std::memory_order_release);
        cancelSnapshot->jobs.store(
            versus::app::VersusAppTestAccess::
                duplicateOfferRecheckJobCount(*app),
            std::memory_order_release);
    });
    const bool cancellationWaitedForBarrier =
        !cancelTask.waitFor(std::chrono::milliseconds(150));
    barrier->release.store(true, std::memory_order_release);
    const bool cancellationCompleted =
        cancelTask.waitFor(std::chrono::seconds(4));
    cancelTask.finishWithoutBlocking();

    const uint64_t generationAtCancelReturn =
        cancelSnapshot->generation.load(std::memory_order_acquire);
    const uint64_t offerCountAtCancelReturn =
        cancelSnapshot->offerCount.load(std::memory_order_acquire);
    const uint64_t rebuiltAtCancelReturn =
        cancelSnapshot->rebuilt.load(std::memory_order_acquire);
    const uint64_t canceledAtCancelReturn =
        cancelSnapshot->canceled.load(std::memory_order_acquire);
    const bool pendingAtCancelReturn =
        cancelSnapshot->pending.load(std::memory_order_acquire);
    const std::size_t jobsAtCancelReturn =
        cancelSnapshot->jobs.load(std::memory_order_acquire);
    const bool executorDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(
            *app,
            std::chrono::seconds(4));
    const uint64_t finalGeneration =
        versus::app::VersusAppTestAccess::generation(peer);
    const uint64_t finalOfferCount =
        versus::app::VersusAppTestAccess::offerCount(peer);
    const uint64_t finalRebuilt =
        versus::app::VersusAppTestAccess::duplicateOfferRechecksRebuilt(peer);
    const uint64_t finalCanceled =
        versus::app::VersusAppTestAccess::duplicateOfferRechecksCanceled(peer);
    const bool finalPending =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckPending(peer);
    const std::size_t finalJobs =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckJobCount(*app);
    versus::app::VersusAppTestAccess::clearDuplicateOfferRecheckHooks(*app);
    app->shutdown();

    QVERIFY2(fixtureReady, "Could not construct the cancel-barrier fixture");
    QVERIFY2(admittedWorkParked,
             "The admitted duplicate recheck did not park after owning its barrier");
    QCOMPARE(generationWhileParked, generationA);
    QCOMPARE(offerCountWhileParked, offerCountA);
    QVERIFY2(cancellationWaitedForBarrier,
             "Cancellation returned while admitted work still owned its barrier");
    QVERIFY2(cancellationCompleted,
             "Cancellation did not return after releasing admitted work");
    QVERIFY2(generationAtCancelReturn > generationA &&
                 offerCountAtCancelReturn == offerCountA + uint64_t{1},
             "Admitted work did not publish exactly one rebuild before cancellation returned");
    QCOMPARE(rebuiltAtCancelReturn, uint64_t{1});
    QCOMPARE(canceledAtCancelReturn, uint64_t{0});
    QVERIFY2(!pendingAtCancelReturn && jobsAtCancelReturn == 0,
             "Cancellation returned before exact scheduler finalization");
    QVERIFY2(executorDrained, "The admitted rebuild did not drain");
    QCOMPARE(finalGeneration, generationAtCancelReturn);
    QCOMPARE(finalOfferCount, offerCountAtCancelReturn);
    QCOMPARE(finalRebuilt, rebuiltAtCancelReturn);
    QCOMPARE(finalCanceled, canceledAtCancelReturn);
    QCOMPARE(finalPending, pendingAtCancelReturn);
    QCOMPARE(finalJobs, jobsAtCancelReturn);
}

void TestWebRtcClient::testScheduleCancelTransitionCannotLeavePhantomPendingJob() {
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(
        *app,
        "-recheck-schedule-cancel-transition");
    const bool fixtureReady = peer &&
        versus::app::VersusAppTestAccess::rebuildAndRotateWireSession(*app, peer);

    struct Barrier {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    const auto barrier = std::make_shared<Barrier>();
    versus::app::VersusAppTestAccess::setDuplicateOfferRecheckHooks(
        *app,
        [barrier](uint64_t) {
            barrier->entered.store(true, std::memory_order_release);
            while (!barrier->release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        },
        {});
    BoundedTask scheduleTask([app, peer, fixtureReady]() {
        if (fixtureReady) {
            versus::app::VersusAppTestAccess::dispatchDuplicateOfferRequest(
                *app,
                peer);
        }
    });
    const bool insertedBeforeBookkeeping = waitUntil(
        [barrier]() { return barrier->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));
    versus::app::VersusAppTestAccess::cancelDuplicateOfferRechecks(*app);
    barrier->release.store(true, std::memory_order_release);
    const bool scheduleReturned = scheduleTask.waitFor(std::chrono::seconds(2));
    scheduleTask.finishWithoutBlocking();
    const bool phantomPending =
        versus::app::VersusAppTestAccess::duplicateOfferRecheckPending(peer);
    const uint64_t scheduled =
        versus::app::VersusAppTestAccess::duplicateOfferRechecksScheduled(peer);
    const uint64_t canceled =
        versus::app::VersusAppTestAccess::duplicateOfferRechecksCanceled(peer);
    versus::app::VersusAppTestAccess::clearDuplicateOfferRecheckHooks(*app);
    app->shutdown();

    QVERIFY2(fixtureReady,
             "Could not construct the schedule/cancel transition fixture");
    QVERIFY2(insertedBeforeBookkeeping,
             "The schedule path did not reach its map/bookkeeping interleaving seam");
    QVERIFY2(scheduleReturned, "The schedule path did not return after cancellation");
    QVERIFY2(!phantomPending,
             "A canceled map entry was followed by stale Scheduled bookkeeping");
    QCOMPARE(scheduled, uint64_t{1});
    QCOMPARE(canceled, uint64_t{1});
}

void TestWebRtcClient::testShutdownWaitsForInFlightCallbackWithoutDeadlock() {
    auto client = std::make_shared<versus::webrtc::WebRtcClient>();
    auto config = alphaPeerConfig();
    QVERIFY(client->initialize(config));

    struct CallbackState {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
    };
    auto callbackState = std::make_shared<CallbackState>();
    client->setIceCandidateCallback(
        [callbackState](const std::string &, const std::string &, int, uint64_t) {
            callbackState->entered.store(true, std::memory_order_release);
            while (!callbackState->release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });

    BoundedTask offerTask([client]() { (void)client->createOffer(); });
    const bool callbackEntered = waitUntil(
        [callbackState]() { return callbackState->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));
    BoundedTask shutdownTask([client]() { client->shutdown(); });
    const bool shutdownWaited = !shutdownTask.waitFor(std::chrono::milliseconds(100));
    callbackState->release.store(true, std::memory_order_release);
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(2));
    const bool offerCompleted = offerTask.waitFor(std::chrono::seconds(2));
    shutdownTask.finishWithoutBlocking();
    offerTask.finishWithoutBlocking();

    QVERIFY2(callbackEntered, "ICE callback did not enter");
    QVERIFY2(shutdownWaited, "Shutdown did not wait for the in-flight callback barrier");
    QVERIFY2(shutdownCompleted, "Shutdown deadlocked after the in-flight callback completed");
    QVERIFY2(offerCompleted, "Offer operation did not complete after shutdown");
}

void TestWebRtcClient::testResetWaitsForAdmittedCallbackWithoutDeadlock() {
    auto client = std::make_shared<versus::webrtc::WebRtcClient>();
    QVERIFY(client->initialize(alphaPeerConfig()));
    const uint64_t initialGeneration = client->transportGeneration();

    struct CallbackState {
        std::atomic<bool> entered{false};
        std::atomic<bool> release{false};
        std::atomic<bool> exited{false};
        std::atomic<bool> resetResult{false};
    };
    auto state = std::make_shared<CallbackState>();
    client->setIceCandidateCallback(
        [state](const std::string &, const std::string &, int, uint64_t) {
            state->entered.store(true, std::memory_order_release);
            while (!state->release.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            state->exited.store(true, std::memory_order_release);
        });

    BoundedTask offerTask([client]() { (void)client->createOffer(); });
    const bool callbackEntered = waitUntil(
        [state]() { return state->entered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));
    BoundedTask resetTask([client, state]() {
        state->resetResult.store(
            client->resetPeerConnection(false, false, false),
            std::memory_order_release);
    });
    const bool resetWaitedForCallback = !resetTask.waitFor(std::chrono::milliseconds(100));
    const uint64_t generationWhileCallbackParked = client->transportGeneration();

    state->release.store(true, std::memory_order_release);
    const bool callbackExited = waitUntil(
        [state]() { return state->exited.load(std::memory_order_acquire); },
        std::chrono::seconds(2));
    const bool resetCompleted = resetTask.waitFor(std::chrono::seconds(3));
    const bool offerCompleted = offerTask.waitFor(std::chrono::seconds(3));
    const uint64_t replacementGeneration = client->transportGeneration();
    resetTask.finishWithoutBlocking();
    offerTask.finishWithoutBlocking();
    client->shutdown();

    QVERIFY2(callbackEntered, "ICE callback did not enter the admitted callback barrier");
    QVERIFY2(resetWaitedForCallback,
             "Transport rebuild crossed an already-admitted user callback");
    QCOMPARE(generationWhileCallbackParked, initialGeneration);
    QVERIFY2(callbackExited, "Admitted callback did not leave its bounded barrier");
    QVERIFY2(resetCompleted && state->resetResult.load(std::memory_order_acquire),
             "Transport rebuild deadlocked after the admitted callback returned");
    QVERIFY2(offerCompleted, "Offer did not unwind after the callback/rebuild interleaving");
    QVERIFY2(replacementGeneration > initialGeneration,
             "Callback-serialized rebuild did not publish a replacement generation");
}

void TestWebRtcClient::testAdmittedCallbackDoesNotReenterPeerOperationMutex() {
    struct State {
        std::atomic<bool> callbackParkedBeforeEnqueue{false};
        std::atomic<bool> releaseCallback{false};
        std::atomic<bool> rebuildOwnsOperationMutex{false};
        std::atomic<bool> callbackReturned{false};
        std::atomic<bool> rebuildResult{false};
        std::atomic<bool> removalCallbackParked{false};
        std::atomic<bool> releaseRemovalCallback{false};
        std::atomic<bool> removalCallbackReturned{false};
        std::mutex operationsMutex;
        std::vector<std::pair<std::string, uint64_t>> operations;
    };
    auto state = std::make_shared<State>();
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(*app);
    QVERIFY2(peer, "Could not construct the production VersusApp callback fixture");
    auto *client = versus::app::VersusAppTestAccess::client(peer);
    QVERIFY(client);
    const uint64_t initialGeneration =
        versus::app::VersusAppTestAccess::generation(peer);
    QVERIFY(initialGeneration != 0);

    versus::app::VersusAppTestAccess::setBeforeEnqueueHook(
        *app,
        [state, initialGeneration](const std::string &kind, uint64_t generation) {
            if (kind != "data-message" || generation != initialGeneration) {
                return;
            }
            state->callbackParkedBeforeEnqueue.store(true, std::memory_order_release);
            while (!state->releaseCallback.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });
    versus::app::VersusAppTestAccess::setOperationHook(
        *app,
        [state](const std::string &, const std::string &kind, uint64_t generation) {
            std::lock_guard<std::mutex> lock(state->operationsMutex);
            state->operations.emplace_back(kind, generation);
            return true;  // Observe the production boundary without signaling IO.
        });

    BoundedTask callbackTask([client, initialGeneration, state]() {
        versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
            *client,
            R"({"iceRestartRequest":true})",
            initialGeneration);
        state->callbackReturned.store(true, std::memory_order_release);
    });
    const bool callbackParked = waitUntil(
        [state]() {
            return state->callbackParkedBeforeEnqueue.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));

    BoundedTask rebuildTask([peer, state]() {
        state->rebuildResult.store(
            versus::app::VersusAppTestAccess::rebuildWhileOwningOperationMutex(
                peer,
                [state]() {
                    state->rebuildOwnsOperationMutex.store(true, std::memory_order_release);
                }),
            std::memory_order_release);
    });
    const bool rebuildOwnsOperationMutex = waitUntil(
        [state]() {
            return state->rebuildOwnsOperationMutex.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    state->releaseCallback.store(true, std::memory_order_release);

    const bool callbackCompleted = callbackTask.waitFor(std::chrono::seconds(2));
    const bool rebuildCompleted = rebuildTask.waitFor(std::chrono::seconds(3));
    const uint64_t replacementGeneration =
        versus::app::VersusAppTestAccess::generation(peer);
    callbackTask.finishWithoutBlocking();
    rebuildTask.finishWithoutBlocking();

    // All three callback origins that formerly re-entered the app operation
    // mutex are installed by the same production helper. Hold that mutex while
    // invoking each actual admitted callback: callback return must not depend
    // on the worker being able to enter the mutex.
    versus::app::VersusAppTestAccess::setBeforeEnqueueHook(*app, {});
    const auto callbackBatchStart = std::chrono::steady_clock::now();
    versus::app::VersusAppTestAccess::whileOwningOperationMutex(peer, [&]() {
        versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
            *client,
            R"({"iceRestartRequest":true})",
            replacementGeneration);
        versus::webrtc::WebRtcClientTestAccess::invokeDataChannelStateCallback(
            *client,
            true,
            replacementGeneration);
        versus::webrtc::WebRtcClientTestAccess::invokeStateCallback(
            *client,
            versus::webrtc::ConnectionState::Failed,
            replacementGeneration);
    });
    const auto callbackBatchElapsed = std::chrono::steady_clock::now() - callbackBatchStart;
    const bool currentOperationsCompleted =
        versus::app::VersusAppTestAccess::waitUntilIdle(*app, std::chrono::seconds(2));

    std::vector<std::pair<std::string, uint64_t>> completedOperations;
    {
        std::lock_guard<std::mutex> lock(state->operationsMutex);
        completedOperations = state->operations;
    }
    const auto operationCount = [&](const std::string &kind, uint64_t generation) {
        return std::count_if(
            completedOperations.begin(),
            completedOperations.end(),
            [&](const auto &entry) {
                return entry.first == kind && entry.second == generation;
            });
    };

    // Park one more admitted callback after its first current-generation check,
    // remove the peer, and then let it attempt to enqueue. This proves both the
    // executor predicate and the operation-side removal check remain effective
    // without relying on the worker taking the peer operation mutex.
    const std::size_t operationsBeforeRemoval = completedOperations.size();
    versus::app::VersusAppTestAccess::setBeforeEnqueueHook(
        *app,
        [state, replacementGeneration](const std::string &kind, uint64_t generation) {
            if (kind != "data-message" || generation != replacementGeneration) {
                return;
            }
            state->removalCallbackParked.store(true, std::memory_order_release);
            while (!state->releaseRemovalCallback.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });
    BoundedTask removalCallbackTask([client, replacementGeneration, state]() {
        versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
            *client,
            R"({"request":"cleanup-gate"})",
            replacementGeneration);
        state->removalCallbackReturned.store(true, std::memory_order_release);
    });
    const bool removalCallbackParked = waitUntil(
        [state]() {
            return state->removalCallbackParked.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    BoundedTask removalTask([app, peer]() {
        versus::app::VersusAppTestAccess::removePeer(*app, peer);
    });
    const bool removalCompleted = removalTask.waitFor(std::chrono::seconds(2));
    state->releaseRemovalCallback.store(true, std::memory_order_release);
    const bool removalCallbackCompleted =
        removalCallbackTask.waitFor(std::chrono::seconds(2));
    removalTask.finishWithoutBlocking();
    removalCallbackTask.finishWithoutBlocking();
    const bool removalQueueDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(*app, std::chrono::seconds(2));
    std::size_t operationsAfterRemoval = 0;
    {
        std::lock_guard<std::mutex> lock(state->operationsMutex);
        operationsAfterRemoval = state->operations.size();
    }
    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(3));
    shutdownTask.finishWithoutBlocking();

    QVERIFY2(callbackParked && rebuildOwnsOperationMutex,
             "The deterministic callback/rebuild lock-order interleaving was not reached");
    QVERIFY2(callbackCompleted && state->callbackReturned.load(std::memory_order_acquire),
             "The admitted callback did not return within the bound");
    QVERIFY2(rebuildCompleted && state->rebuildResult.load(std::memory_order_acquire),
             "The transport rebuild did not complete after the callback returned");
    QVERIFY2(replacementGeneration > initialGeneration,
             "The bounded rebuild did not advance the transport generation");
    QCOMPARE(operationCount("data-message", initialGeneration), qsizetype{0});
    QVERIFY2(callbackBatchElapsed < std::chrono::milliseconds(250),
             "A production callback waited for the peer operation mutex instead of enqueueing");
    QVERIFY2(currentOperationsCompleted,
             "The serialized callback operations did not drain within the bound");
    QCOMPARE(operationCount("data-message", replacementGeneration), qsizetype{1});
    QCOMPARE(operationCount("datachannel-state", replacementGeneration), qsizetype{1});
    QCOMPARE(operationCount("connection-state", replacementGeneration), qsizetype{1});
    QVERIFY2(removalCallbackParked && removalCompleted && removalCallbackCompleted &&
                 state->removalCallbackReturned.load(std::memory_order_acquire),
             "The deterministic removed-peer callback interleaving did not complete");
    QVERIFY2(removalQueueDrained,
             "Removed-peer callback work did not drain from the serialized executor");
    QCOMPARE(operationsAfterRemoval, operationsBeforeRemoval);
    QCOMPARE(versus::app::VersusAppTestAccess::pendingCount(*app), std::size_t{0});
    QVERIFY2(shutdownCompleted,
             "VersusApp callback executor/client teardown did not complete within the bound");
}

void TestWebRtcClient::testPeerRemovalWaitsForDispatchedHandlerWithoutClientLock() {
    struct State {
        std::atomic<bool> operationParked{false};
        std::atomic<bool> releaseOperation{false};
    };
    auto state = std::make_shared<State>();
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(*app);
    QVERIFY2(peer, "Could not construct the production peer-removal fixture");
    auto *client = versus::app::VersusAppTestAccess::client(peer);
    QVERIFY(client);
    const uint64_t generation = versus::app::VersusAppTestAccess::generation(peer);
    QVERIFY(generation != 0);

    versus::app::VersusAppTestAccess::setOperationHook(
        *app,
        [state, generation](const std::string &,
                            const std::string &kind,
                            uint64_t operationGeneration) {
            if (kind != "data-message" || operationGeneration != generation) {
                return true;
            }
            state->operationParked.store(true, std::memory_order_release);
            while (!state->releaseOperation.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            return true;
        });

    const auto callbackStart = std::chrono::steady_clock::now();
    versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
        *client,
        R"({"ordinary":"teardown-lifetime"})",
        generation);
    const auto callbackElapsed = std::chrono::steady_clock::now() - callbackStart;
    const bool operationParked = waitUntil(
        [state]() { return state->operationParked.load(std::memory_order_acquire); },
        std::chrono::seconds(2));

    BoundedTask removalTask([app, peer]() {
        versus::app::VersusAppTestAccess::removePeer(*app, peer);
    });
    const bool removalCompleted = removalTask.waitFor(std::chrono::seconds(2));
    removalTask.finishWithoutBlocking();
    const bool teardownCrossedActiveHandler = waitUntil(
        [client]() { return client->transportGeneration() == 0; },
        std::chrono::milliseconds(250));
    state->releaseOperation.store(true, std::memory_order_release);

    const bool operationDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(*app, std::chrono::seconds(2));
    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(3));
    shutdownTask.finishWithoutBlocking();
    const uint64_t finalGeneration = client->transportGeneration();

    QVERIFY2(callbackElapsed < std::chrono::milliseconds(250) && operationParked,
             "The dispatched-handler teardown interleaving was not reached");
    QVERIFY2(removalCompleted,
             "Peer removal did not return while async teardown waited for the handler");
    QVERIFY2(!teardownCrossedActiveHandler,
             "Async client teardown crossed an executor-dispatched App handler");
    QVERIFY2(operationDrained && shutdownCompleted,
             "Handler release and async peer teardown did not drain within the bounds");
    QCOMPARE(finalGeneration, uint64_t{0});
}

void TestWebRtcClient::testRuntimeVideoControlDoesNotInvertPeerAndVideoLocks() {
    struct InterleavingState {
        std::atomic<bool> videoLockHeld{false};
        std::atomic<bool> workerEnteredControl{false};
        std::atomic<bool> peerLockAcquired{false};
    };
    struct Outcome {
        bool videoPathReached = false;
        bool workerEntered = false;
        bool callbackReturnedPromptly = false;
        bool videoPathCompleted = false;
        bool peerLockAcquired = false;
        bool operationsDrained = false;
        versus::video::EncoderConfig config;
    };
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(*app);
    QVERIFY2(peer, "Could not construct the production runtime-control fixture");
    auto *client = versus::app::VersusAppTestAccess::client(peer);
    QVERIFY(client);
    const uint64_t generation = versus::app::VersusAppTestAccess::generation(peer);
    QVERIFY(generation != 0);
    versus::app::VersusAppTestAccess::enableTokenlessRemoteControl(*app);
    const auto runControl = [&](const std::string &message) {
        auto state = std::make_shared<InterleavingState>();
        versus::app::VersusAppTestAccess::setOperationHook(
            *app,
            [state, generation](const std::string &,
                                const std::string &kind,
                                uint64_t operationGeneration) {
                if (kind == "data-message" && operationGeneration == generation) {
                    state->workerEnteredControl.store(true, std::memory_order_release);
                    return false;  // Exercise the real runtime video-control handler.
                }
                return true;
            });

        BoundedTask videoPathTask([app, peer, state]() {
            const bool acquired =
                versus::app::VersusAppTestAccess::tryPeerOperationWhileHoldingVideoSend(
                    *app,
                    peer,
                    [state]() {
                        state->videoLockHeld.store(true, std::memory_order_release);
                    },
                    [state]() {
                        return state->workerEnteredControl.load(std::memory_order_acquire);
                    },
                    std::chrono::milliseconds(400));
            state->peerLockAcquired.store(acquired, std::memory_order_release);
        });
        Outcome outcome;
        outcome.videoPathReached = waitUntil(
            [state]() { return state->videoLockHeld.load(std::memory_order_acquire); },
            std::chrono::seconds(2));
        const auto callbackStart = std::chrono::steady_clock::now();
        versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
            *client,
            message,
            generation);
        outcome.callbackReturnedPromptly =
            std::chrono::steady_clock::now() - callbackStart <
            std::chrono::milliseconds(250);
        outcome.videoPathCompleted =
            videoPathTask.waitFor(std::chrono::seconds(2));
        videoPathTask.finishWithoutBlocking();
        outcome.operationsDrained =
            versus::app::VersusAppTestAccess::waitUntilIdle(
                *app,
                std::chrono::seconds(3));
        outcome.workerEntered =
            state->workerEnteredControl.load(std::memory_order_acquire);
        outcome.peerLockAcquired =
            state->peerLockAcquired.load(std::memory_order_acquire);
        outcome.config = versus::app::VersusAppTestAccess::configuredVideo(*app);
        return outcome;
    };

    const Outcome bitrate = runControl(R"({"action":"bitrate","value":777})");
    const Outcome resolution = runControl(
        R"({"requestResolution":{"w":1280,"h":720}})");
    const Outcome fps = runControl(R"({"requestResolution":{"f":30}})");
    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(3));
    shutdownTask.finishWithoutBlocking();

    const auto interleavingPassed = [](const Outcome &outcome) {
        return outcome.videoPathReached &&
            outcome.workerEntered &&
            outcome.callbackReturnedPromptly &&
            outcome.videoPathCompleted &&
            outcome.peerLockAcquired &&
            outcome.operationsDrained;
    };
    QVERIFY2(interleavingPassed(bitrate),
             "Bitrate control inverted videoSendMutex and the peer operation lock");
    QVERIFY2(interleavingPassed(resolution),
             "Resolution control inverted videoSendMutex and the peer operation lock");
    QVERIFY2(interleavingPassed(fps),
             "FPS control inverted videoSendMutex and the peer operation lock");
    QCOMPARE(bitrate.config.bitrate, 777);
    QCOMPARE(resolution.config.width, 1280);
    QCOMPARE(resolution.config.height, 720);
    QCOMPARE(fps.config.frameRate, 30);
    QVERIFY2(shutdownCompleted,
             "Runtime-control fixture did not shut down within the bound");
}

void TestWebRtcClient::testRemoteHangupDoesNotJoinWhileHoldingPeerLock() {
    struct State {
        std::atomic<bool> workerEnteredHangup{false};
        std::atomic<bool> callbackReturned{false};
    };
    auto state = std::make_shared<State>();
    auto acquiredPeerOperation = std::make_shared<std::atomic<bool>>(false);
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(*app);
    QVERIFY2(peer, "Could not construct the production remote-hangup fixture");
    auto *client = versus::app::VersusAppTestAccess::client(peer);
    QVERIFY(client);
    const uint64_t generation = versus::app::VersusAppTestAccess::generation(peer);
    QVERIFY(generation != 0);
    versus::app::VersusAppTestAccess::enableTokenlessRemoteControl(*app);
    versus::app::VersusAppTestAccess::setOperationHook(
        *app,
        [state, generation](const std::string &,
                            const std::string &kind,
                            uint64_t operationGeneration) {
            if (kind == "data-message" && operationGeneration == generation) {
                state->workerEnteredHangup.store(true, std::memory_order_release);
                return false;  // Exercise stopLive/stopCapture and the encode join.
            }
            return true;
        });
    versus::app::VersusAppTestAccess::installSyntheticEncodePeerWait(
        *app,
        peer,
        [state]() {
            return state->workerEnteredHangup.load(std::memory_order_acquire);
        },
        acquiredPeerOperation,
        std::chrono::milliseconds(400));

    const auto callbackStart = std::chrono::steady_clock::now();
    versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
        *client,
        R"({"hangup":true})",
        generation);
    const auto callbackElapsed = std::chrono::steady_clock::now() - callbackStart;
    state->callbackReturned.store(true, std::memory_order_release);

    const bool callbackOperationsDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(*app, std::chrono::seconds(3));
    const bool captureStopped = !versus::app::VersusAppTestAccess::capturing(*app);
    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(3));
    shutdownTask.finishWithoutBlocking();

    QVERIFY2(state->workerEnteredHangup.load(std::memory_order_acquire),
             "The production remote-hangup handler was not reached");
    QVERIFY2(callbackElapsed < std::chrono::milliseconds(250) &&
                 state->callbackReturned.load(std::memory_order_acquire),
             "The remote-hangup callback blocked instead of handing off its work");
    QVERIFY2(acquiredPeerOperation->load(std::memory_order_acquire),
             "Remote hangup joined an encode path while holding the peer operation lock");
    QVERIFY2(callbackOperationsDrained && captureStopped,
             "Remote hangup did not finish stopping capture within the bound");
    QVERIFY2(shutdownCompleted,
             "Remote-hangup fixture did not shut down within the bound");
}

void TestWebRtcClient::testCallbackQueueOverloadCannotLoseFailedState() {
    struct State {
        std::atomic<bool> ordinaryWorkerParked{false};
        std::atomic<bool> releaseOrdinaryWorker{false};
        std::mutex operationsMutex;
        std::vector<std::pair<std::string, uint64_t>> operations;
    };
    auto state = std::make_shared<State>();
    auto app = std::make_shared<versus::app::VersusApp>();
    const auto peer = versus::app::VersusAppTestAccess::createPeer(*app);
    QVERIFY2(peer, "Could not construct the production callback-overload fixture");
    auto *client = versus::app::VersusAppTestAccess::client(peer);
    QVERIFY(client);
    const uint64_t generation = versus::app::VersusAppTestAccess::generation(peer);
    QVERIFY(generation != 0);

    versus::app::VersusAppTestAccess::setOperationHook(
        *app,
        [state](const std::string &,
                const std::string &kind,
                uint64_t operationGeneration) {
            if (kind == "data-message" &&
                !state->ordinaryWorkerParked.exchange(true, std::memory_order_acq_rel)) {
                while (!state->releaseOrdinaryWorker.load(std::memory_order_acquire)) {
                    std::this_thread::yield();
                }
            }
            std::lock_guard<std::mutex> lock(state->operationsMutex);
            state->operations.emplace_back(kind, operationGeneration);
            return true;
        });

    versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
        *client,
        R"({"ordinary":0})",
        generation);
    const bool workerParked = waitUntil(
        [state]() {
            return state->ordinaryWorkerParked.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    int64_t firstOverloadLogMs = 0;
    for (int index = 1; index <= 1024; ++index) {
        versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
            *client,
            std::string(R"({"ordinary":)") + std::to_string(index) + "}",
            generation);
        if (index == 65) {
            firstOverloadLogMs =
                versus::app::VersusAppTestAccess::lastOverloadLogMs(*app);
        }
    }
    const int64_t finalOverloadLogMs =
        versus::app::VersusAppTestAccess::lastOverloadLogMs(*app);
    versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
        *client,
        R"({"iceRestartRequest":true})",
        generation);
    versus::webrtc::WebRtcClientTestAccess::invokeStateCallback(
        *client,
        versus::webrtc::ConnectionState::Failed,
        generation);
    state->releaseOrdinaryWorker.store(true, std::memory_order_release);

    const bool callbackOperationsDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(*app, std::chrono::seconds(5));
    std::vector<std::pair<std::string, uint64_t>> operations;
    {
        std::lock_guard<std::mutex> lock(state->operationsMutex);
        operations = state->operations;
    }
    const auto failedStateCount = std::count_if(
        operations.begin(),
        operations.end(),
        [generation](const auto &entry) {
            return entry.first == "connection-state" && entry.second == generation;
        });
    const auto dataMessageCount = std::count_if(
        operations.begin(),
        operations.end(),
        [generation](const auto &entry) {
            return entry.first == "data-message" && entry.second == generation;
        });
    const auto diagnostics = nlohmann::json::parse(
        app->buildDiagnosticsJson(),
        nullptr,
        false);
    const bool overloadTelemetryVisible =
        !diagnostics.is_discarded() &&
        diagnostics.contains("peer_operation_executor") &&
        diagnostics["peer_operation_executor"].is_object() &&
        diagnostics["peer_operation_executor"].value(
            "dropped_ordinary_capacity",
            uint64_t{0}) > 0 &&
        diagnostics["peer_operation_executor"].value(
            "accepted_critical",
            uint64_t{0}) > 0;
    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(3));
    shutdownTask.finishWithoutBlocking();

    QVERIFY2(workerParked,
             "The deterministic ordinary-callback queue saturation was not reached");
    QVERIFY2(callbackOperationsDrained,
             "The saturated production callback queue did not drain within the bound");
    QCOMPARE(failedStateCount, qsizetype{1});
    QCOMPARE(dataMessageCount, qsizetype{66});
    QVERIFY2(firstOverloadLogMs > 0 &&
                 finalOverloadLogMs == firstOverloadLogMs,
             "Ordinary overload logging was not rate-limited across the flood");
    QVERIFY2(overloadTelemetryVisible,
             "Callback overload counters were not visible in production diagnostics");
    QVERIFY2(shutdownCompleted,
             "Callback-overload fixture did not shut down within the bound");
}

void TestWebRtcClient::testAllCriticalOverflowPreservesNewPeerConvergence() {
    struct Operation {
        std::string peerKey;
        std::string kind;
        uint64_t generation = 0;
    };
    struct State {
        std::atomic<bool> criticalWorkerParked{false};
        std::atomic<bool> releaseCriticalWorker{false};
        std::mutex operationsMutex;
        std::vector<Operation> operations;
    };
    auto state = std::make_shared<State>();
    auto app = std::make_shared<versus::app::VersusApp>(4);
    const auto blocker =
        versus::app::VersusAppTestAccess::createPeer(*app, "-critical-blocker");
    std::vector<versus::app::VersusAppTestAccess::OpaquePeer> fillers;
    for (int index = 0; index < 4; ++index) {
        fillers.push_back(versus::app::VersusAppTestAccess::createPeer(
            *app,
            "-critical-filler-" + std::to_string(index)));
    }
    const auto recoveryTarget =
        versus::app::VersusAppTestAccess::createPeer(*app, "-critical-recovery-target");
    const auto lifecycleTarget =
        versus::app::VersusAppTestAccess::createPeer(*app, "-critical-lifecycle-target");
    QVERIFY2(blocker && recoveryTarget && lifecycleTarget &&
                 std::all_of(fillers.begin(), fillers.end(), [](const auto &peer) {
                     return static_cast<bool>(peer);
                 }),
             "Could not construct the production all-critical overflow fixture");

    auto *blockerClient = versus::app::VersusAppTestAccess::client(blocker);
    auto *recoveryClient = versus::app::VersusAppTestAccess::client(recoveryTarget);
    auto *lifecycleClient = versus::app::VersusAppTestAccess::client(lifecycleTarget);
    QVERIFY(blockerClient && recoveryClient && lifecycleClient);
    const uint64_t blockerGeneration =
        versus::app::VersusAppTestAccess::generation(blocker);
    const uint64_t recoveryGeneration =
        versus::app::VersusAppTestAccess::generation(recoveryTarget);
    const uint64_t lifecycleGeneration =
        versus::app::VersusAppTestAccess::generation(lifecycleTarget);
    const uint64_t staleFillerGeneration =
        versus::app::VersusAppTestAccess::generation(fillers.back());
    QVERIFY(blockerGeneration != 0 && recoveryGeneration != 0 &&
            lifecycleGeneration != 0);
    const std::string blockerKey =
        versus::app::VersusAppTestAccess::peerKey(*app, blocker);
    const std::string recoveryKey =
        versus::app::VersusAppTestAccess::peerKey(*app, recoveryTarget);
    const std::string lifecycleKey =
        versus::app::VersusAppTestAccess::peerKey(*app, lifecycleTarget);
    const std::string staleFillerKey =
        versus::app::VersusAppTestAccess::peerKey(*app, fillers.back());

    versus::app::VersusAppTestAccess::setOperationHook(
        *app,
        [state, blockerKey](const std::string &peerKey,
                            const std::string &kind,
                            uint64_t generation) {
            if (peerKey == blockerKey && kind == "connection-state" &&
                !state->criticalWorkerParked.exchange(
                    true,
                    std::memory_order_acq_rel)) {
                while (!state->releaseCriticalWorker.load(std::memory_order_acquire)) {
                    std::this_thread::yield();
                }
            }
            std::lock_guard<std::mutex> lock(state->operationsMutex);
            state->operations.push_back({peerKey, kind, generation});
            return true;
        });

    versus::webrtc::WebRtcClientTestAccess::invokeStateCallback(
        *blockerClient,
        versus::webrtc::ConnectionState::Connected,
        blockerGeneration);
    const bool workerParked = waitUntil(
        [state]() {
            return state->criticalWorkerParked.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    for (const auto &filler : fillers) {
        versus::webrtc::WebRtcClientTestAccess::invokeStateCallback(
            *versus::app::VersusAppTestAccess::client(filler),
            versus::webrtc::ConnectionState::Connected,
            versus::app::VersusAppTestAccess::generation(filler));
    }

    const auto targetCallbacksStart = std::chrono::steady_clock::now();
    versus::webrtc::WebRtcClientTestAccess::invokeStateCallback(
        *recoveryClient,
        versus::webrtc::ConnectionState::Failed,
        recoveryGeneration);
    const int64_t firstOverflowLogMs =
        versus::app::VersusAppTestAccess::lastOverloadLogMs(*app);
    versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
        *recoveryClient,
        R"({"iceRestartRequest":true})",
        recoveryGeneration);
    versus::webrtc::WebRtcClientTestAccess::invokeDataMessageCallback(
        *lifecycleClient,
        R"({"request":"cleanup"})",
        lifecycleGeneration);
    const auto targetCallbacksElapsed =
        std::chrono::steady_clock::now() - targetCallbacksStart;
    const int64_t finalOverflowLogMs =
        versus::app::VersusAppTestAccess::lastOverloadLogMs(*app);

    BoundedTask staleRemovalTask([app, staleFiller = fillers.back()]() {
        versus::app::VersusAppTestAccess::removePeer(*app, staleFiller);
    });
    const bool staleRemovalCompleted =
        staleRemovalTask.waitFor(std::chrono::seconds(2));
    staleRemovalTask.finishWithoutBlocking();
    state->releaseCriticalWorker.store(true, std::memory_order_release);
    const bool callbackOperationsDrained =
        versus::app::VersusAppTestAccess::waitUntilIdle(*app, std::chrono::seconds(4));

    std::vector<Operation> operations;
    {
        std::lock_guard<std::mutex> lock(state->operationsMutex);
        operations = state->operations;
    }
    const auto operationCount = [&operations](const std::string &peerKey,
                                               const std::string &kind,
                                               uint64_t generation) {
        return std::count_if(
            operations.begin(),
            operations.end(),
            [&](const Operation &operation) {
                return operation.peerKey == peerKey &&
                    operation.kind == kind &&
                    operation.generation == generation;
            });
    };
    const auto diagnostics = nlohmann::json::parse(
        app->buildDiagnosticsJson(),
        nullptr,
        false);
    const auto executorDiagnostics =
        !diagnostics.is_discarded() &&
            diagnostics.contains("peer_operation_executor") &&
            diagnostics["peer_operation_executor"].is_object()
        ? diagnostics["peer_operation_executor"]
        : nlohmann::json::object();
    const bool overflowConvergedObservably =
        executorDiagnostics.value(
            "evicted_critical_for_critical",
            uint64_t{0}) >= 3 &&
        executorDiagnostics.value(
            "rejected_critical_capacity",
            uint64_t{0}) == 0;
    BoundedTask shutdownTask([app]() { app->shutdown(); });
    const bool shutdownCompleted = shutdownTask.waitFor(std::chrono::seconds(4));
    shutdownTask.finishWithoutBlocking();

    QVERIFY2(workerParked,
             "The deterministic all-critical saturation barrier was not reached");
    QVERIFY2(targetCallbacksElapsed < std::chrono::milliseconds(250),
             "Critical callback admission blocked behind the saturated worker");
    QVERIFY2(staleRemovalCompleted && callbackOperationsDrained,
             "All-critical overflow did not drain after releasing the worker");
    QCOMPARE(operationCount(recoveryKey, "connection-state", recoveryGeneration),
             qsizetype{1});
    QCOMPARE(operationCount(recoveryKey, "data-message", recoveryGeneration),
             qsizetype{1});
    QCOMPARE(operationCount(lifecycleKey, "data-message", lifecycleGeneration),
             qsizetype{1});
    QCOMPARE(operationCount(staleFillerKey, "connection-state",
                            staleFillerGeneration),
             qsizetype{0});
    QVERIFY2(overflowConvergedObservably,
             "Critical overflow did not retain terminal/recovery convergence with telemetry");
    QVERIFY2(firstOverflowLogMs > 0 && finalOverflowLogMs == firstOverflowLogMs,
             "All-critical overflow logging was not observable and rate-limited");
    QVERIFY2(shutdownCompleted,
             "All-critical overflow fixture did not shut down within the bound");
}

void TestWebRtcClient::testPeerOperationExecutorPrioritizesAndFairlyBoundsWork() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    using Priority = Executor::Priority;
    using Result = Executor::EnqueueResult;
    struct State {
        std::atomic<bool> blockerEntered{false};
        std::atomic<bool> releaseBlocker{false};
        std::mutex operationsMutex;
        std::vector<std::string> operations;
    };
    auto state = std::make_shared<State>();
    auto executor = std::make_shared<Executor>(12);
    const bool started = executor->start();
    const auto current = [](uint64_t) { return true; };
    const auto record = [state](std::string marker) {
        return [state, marker = std::move(marker)](uint64_t) {
            std::lock_guard<std::mutex> lock(state->operationsMutex);
            state->operations.push_back(marker);
        };
    };

    const Result blockerResult = executor->enqueue(
        1,
        "peer-a",
        Priority::Ordinary,
        {},
        current,
        [state](uint64_t) {
            {
                std::lock_guard<std::mutex> lock(state->operationsMutex);
                state->operations.push_back("blocker");
            }
            state->blockerEntered.store(true, std::memory_order_release);
            while (!state->releaseBlocker.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        });
    const bool blockerEntered = waitUntil(
        [state]() { return state->blockerEntered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));

    std::vector<Result> peerAResults;
    for (int index = 0; index < 4; ++index) {
        peerAResults.push_back(executor->enqueue(
            1,
            "peer-a",
            Priority::Ordinary,
            {},
            current,
            record("A-" + std::to_string(index))));
    }
    const Result peerAFloodResult = executor->enqueue(
        1,
        "peer-a",
        Priority::Ordinary,
        {},
        current,
        record("A-over-cap"));

    std::vector<Result> peerBResults;
    for (int index = 0; index < 4; ++index) {
        peerBResults.push_back(executor->enqueue(
            1,
            "peer-b",
            Priority::Ordinary,
            {},
            current,
            record("B-" + std::to_string(index))));
    }
    std::vector<Result> peerCResults;
    for (int index = 0; index < 3; ++index) {
        peerCResults.push_back(executor->enqueue(
            1,
            "peer-c",
            Priority::Ordinary,
            {},
            current,
            record("C-" + std::to_string(index))));
    }

    const Result initialStateResult = executor->enqueue(
        1,
        "peer-a",
        Priority::Critical,
        "connection-state",
        current,
        record("state-connected"));
    const Result recoveryResult = executor->enqueue(
        1,
        "peer-b",
        Priority::Critical,
        "ice-restart",
        current,
        record("recovery"));
    const Result latestStateResult = executor->enqueue(
        1,
        "peer-a",
        Priority::Critical,
        "connection-state",
        current,
        record("state-failed"));
    const Result unrelatedPeerAtCapacityResult = executor->enqueue(
        1,
        "peer-d",
        Priority::Ordinary,
        {},
        current,
        record("D-at-capacity"));

    state->releaseBlocker.store(true, std::memory_order_release);
    const bool firstDrainCompleted =
        executor->waitUntilIdle(std::chrono::seconds(3));

    const Result staleResult = executor->enqueue(
        2,
        "peer-stale",
        Priority::Critical,
        "connection-state",
        [](uint64_t) { return false; },
        record("stale-should-not-run"));
    const bool staleDrainCompleted =
        executor->waitUntilIdle(std::chrono::seconds(2));
    const Result invalidResult = executor->enqueue(
        0,
        "peer-invalid",
        Priority::Ordinary,
        {},
        current,
        record("invalid-should-not-run"));
    const auto statsBeforeStop = executor->stats();
    executor->stop();
    const Result stoppedResult = executor->enqueue(
        3,
        "peer-stopped",
        Priority::Critical,
        "connection-state",
        current,
        record("stopped-should-not-run"));
    const auto statsAfterStop = executor->stats();

    std::vector<std::string> operations;
    {
        std::lock_guard<std::mutex> lock(state->operationsMutex);
        operations = state->operations;
    }
    const auto operationIndex = [&operations](const std::string &marker) {
        const auto found = std::find(operations.begin(), operations.end(), marker);
        return found == operations.end()
            ? operations.size()
            : static_cast<std::size_t>(std::distance(operations.begin(), found));
    };
    const auto firstOrdinary = std::find_if(
        operations.begin(),
        operations.end(),
        [](const std::string &marker) {
            return marker.rfind("A-", 0) == 0 ||
                marker.rfind("B-", 0) == 0 ||
                marker.rfind("C-", 0) == 0;
        });
    const bool peersAccepted = std::all_of(
        peerAResults.begin(),
        peerAResults.end(),
        [](Result result) { return Executor::accepted(result); }) &&
        std::all_of(
            peerBResults.begin(),
            peerBResults.end(),
            [](Result result) { return Executor::accepted(result); }) &&
        std::all_of(
            peerCResults.begin(),
            peerCResults.end(),
            [](Result result) { return Executor::accepted(result); });

    QVERIFY2(started && blockerEntered && Executor::accepted(blockerResult),
             "The deterministic executor saturation barrier was not reached");
    QVERIFY2(peersAccepted,
             "Bounded work from independent peers was rejected before capacity");
    QCOMPARE(peerAFloodResult, Result::RejectedOrdinaryCapacity);
    QCOMPARE(initialStateResult, Result::Queued);
    QCOMPARE(recoveryResult, Result::QueuedAfterEvictingOrdinary);
    QCOMPARE(latestStateResult, Result::CoalescedCritical);
    QCOMPARE(unrelatedPeerAtCapacityResult, Result::RejectedOrdinaryCapacity);
    QVERIFY2(firstDrainCompleted && staleDrainCompleted,
             "The bounded executor queues did not drain within the deadline");
    QVERIFY2(operationIndex("recovery") < static_cast<std::size_t>(
                 std::distance(operations.begin(), firstOrdinary)) &&
                 operationIndex("state-failed") < static_cast<std::size_t>(
                     std::distance(operations.begin(), firstOrdinary)),
             "Critical state/recovery work remained behind ordinary data");
    QVERIFY2(operationIndex("state-connected") == operations.size() &&
                 operationIndex("state-failed") < operations.size(),
             "Critical coalescing did not preserve the latest recoverable state");
    QVERIFY2(firstOrdinary != operations.end() && *firstOrdinary == "B-0",
             "Ordinary peer A flood starved peer B after the critical drain");
    QVERIFY2(operationIndex("B-3") < operations.size() &&
                 operationIndex("C-2") < operations.size(),
             "Valid work from additional peers was lost under peer A flood");
    QCOMPARE(staleResult, Result::Queued);
    QCOMPARE(invalidResult, Result::RejectedInvalid);
    QCOMPARE(stoppedResult, Result::RejectedStopped);
    QVERIFY2(operationIndex("stale-should-not-run") == operations.size() &&
                 operationIndex("invalid-should-not-run") == operations.size() &&
                 operationIndex("stopped-should-not-run") == operations.size(),
             "Invalid, stale, or post-stop work reached an operation callback");
    QCOMPARE(statsBeforeStop.coalescedCritical, uint64_t{1});
    QCOMPARE(statsBeforeStop.evictedOrdinaryForCritical, uint64_t{1});
    QVERIFY2(statsBeforeStop.droppedOrdinaryCapacity >= 2 &&
                 statsBeforeStop.staleGeneration == 1 &&
                 statsBeforeStop.rejectedInvalid == 1,
             "Executor overload/stale/invalid telemetry did not match admissions");
    QVERIFY2(statsAfterStop.rejectedStopped == 1 &&
                 executor->pendingCount() == 0,
             "Stopped executor accepted work or retained queued operations");
}

void TestWebRtcClient::testCriticalOverflowPolicyAndBurstFairness() {
    using Executor = versus::app::GenerationTaggedPeerOperationExecutor;
    using Priority = Executor::Priority;
    using Criticality = Executor::Criticality;
    using Result = Executor::EnqueueResult;
    struct State {
        std::atomic<bool> blockerEntered{false};
        std::atomic<bool> releaseBlocker{false};
        std::mutex operationsMutex;
        std::vector<std::string> operations;
    };
    const auto current = [](uint64_t) { return true; };
    const auto makeRecord = [](const std::shared_ptr<State> &state,
                               std::string marker) {
        return [state, marker = std::move(marker)](uint64_t) {
            std::lock_guard<std::mutex> lock(state->operationsMutex);
            state->operations.push_back(marker);
        };
    };
    const auto makeBlocker = [](const std::shared_ptr<State> &state) {
        return [state](uint64_t) {
            {
                std::lock_guard<std::mutex> lock(state->operationsMutex);
                state->operations.push_back("blocker");
            }
            state->blockerEntered.store(true, std::memory_order_release);
            while (!state->releaseBlocker.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
        };
    };

    auto overflowState = std::make_shared<State>();
    Executor overflowExecutor(3);
    const bool overflowStarted = overflowExecutor.start();
    const Result overflowBlocker = overflowExecutor.enqueue(
        1,
        "overflow-blocker",
        Priority::Ordinary,
        {},
        current,
        makeBlocker(overflowState));
    const bool overflowBlockerEntered = waitUntil(
        [overflowState]() {
            return overflowState->blockerEntered.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    std::vector<Result> initialConvergentResults;
    for (int index = 0; index < 3; ++index) {
        initialConvergentResults.push_back(overflowExecutor.enqueue(
            1,
            "old-convergent-" + std::to_string(index),
            Priority::Critical,
            "terminal-state",
            current,
            makeRecord(overflowState, "old-" + std::to_string(index)),
            Criticality::Convergent));
    }
    const Result lowerValueResult = overflowExecutor.enqueue(
        1,
        "lower-value",
        Priority::Critical,
        "connected-state",
        current,
        makeRecord(overflowState, "lower-value-should-not-run"),
        Criticality::State);
    const Result newestConvergentResult = overflowExecutor.enqueue(
        1,
        "new-convergent",
        Priority::Critical,
        "ice-restart",
        current,
        makeRecord(overflowState, "new-convergent"),
        Criticality::Convergent);
    overflowState->releaseBlocker.store(true, std::memory_order_release);
    const bool overflowDrained =
        overflowExecutor.waitUntilIdle(std::chrono::seconds(2));
    const auto overflowStats = overflowExecutor.stats();
    overflowExecutor.stop();
    std::vector<std::string> overflowOperations;
    {
        std::lock_guard<std::mutex> lock(overflowState->operationsMutex);
        overflowOperations = overflowState->operations;
    }

    auto burstState = std::make_shared<State>();
    Executor burstExecutor(32);
    const bool burstStarted = burstExecutor.start();
    const Result burstBlocker = burstExecutor.enqueue(
        1,
        "burst-blocker",
        Priority::Ordinary,
        {},
        current,
        makeBlocker(burstState));
    const bool burstBlockerEntered = waitUntil(
        [burstState]() {
            return burstState->blockerEntered.load(std::memory_order_acquire);
        },
        std::chrono::seconds(2));
    std::vector<Result> criticalResults;
    for (int index = 0; index < 12; ++index) {
        criticalResults.push_back(burstExecutor.enqueue(
            1,
            "critical-peer-" + std::to_string(index),
            Priority::Critical,
            "critical-class-" + std::to_string(index),
            current,
            makeRecord(burstState, "critical-" + std::to_string(index)),
            Criticality::State));
    }
    std::vector<Result> ordinaryAResults;
    for (int index = 0; index < 4; ++index) {
        ordinaryAResults.push_back(burstExecutor.enqueue(
            1,
            "ordinary-peer-a",
            Priority::Ordinary,
            {},
            current,
            makeRecord(burstState, "ordinary-a-" + std::to_string(index))));
    }
    const Result ordinaryBResult = burstExecutor.enqueue(
        1,
        "ordinary-peer-b",
        Priority::Ordinary,
        {},
        current,
        makeRecord(burstState, "ordinary-b-0"));
    burstState->releaseBlocker.store(true, std::memory_order_release);
    const bool burstDrained = burstExecutor.waitUntilIdle(std::chrono::seconds(3));
    const auto burstStats = burstExecutor.stats();
    burstExecutor.stop();
    std::vector<std::string> burstOperations;
    {
        std::lock_guard<std::mutex> lock(burstState->operationsMutex);
        burstOperations = burstState->operations;
    }
    const auto burstIndex = [&burstOperations](const std::string &marker) {
        const auto found =
            std::find(burstOperations.begin(), burstOperations.end(), marker);
        return found == burstOperations.end()
            ? burstOperations.size()
            : static_cast<std::size_t>(
                  std::distance(burstOperations.begin(), found));
    };
    const auto firstOrdinary = std::find_if(
        burstOperations.begin(),
        burstOperations.end(),
        [](const std::string &marker) {
            return marker.rfind("ordinary-", 0) == 0;
        });
    const std::size_t criticalBeforeOrdinary = static_cast<std::size_t>(
        std::count_if(
            burstOperations.begin(),
            firstOrdinary,
            [](const std::string &marker) {
                return marker.rfind("critical-", 0) == 0;
            }));

    QVERIFY2(overflowStarted && overflowBlockerEntered &&
                 Executor::accepted(overflowBlocker),
             "The critical-only overflow barrier was not reached");
    QVERIFY2(std::all_of(
                 initialConvergentResults.begin(),
                 initialConvergentResults.end(),
                 [](Result result) { return Executor::accepted(result); }),
             "Initial convergent work did not fill the bounded critical queue");
    QCOMPARE(lowerValueResult, Result::RejectedCriticalCapacity);
    QCOMPARE(newestConvergentResult, Result::QueuedAfterEvictingCritical);
    QVERIFY2(overflowDrained &&
                 std::find(overflowOperations.begin(),
                           overflowOperations.end(),
                           "old-0") == overflowOperations.end() &&
                 std::find(overflowOperations.begin(),
                           overflowOperations.end(),
                           "new-convergent") != overflowOperations.end() &&
                 std::find(overflowOperations.begin(),
                           overflowOperations.end(),
                           "lower-value-should-not-run") == overflowOperations.end(),
             "Critical overflow did not apply its explicit value-aware policy");
    QCOMPARE(overflowStats.evictedCriticalForCritical, uint64_t{1});
    QCOMPARE(overflowStats.rejectedCriticalCapacity, uint64_t{1});

    QVERIFY2(burstStarted && burstBlockerEntered && Executor::accepted(burstBlocker),
             "The critical-burst fairness barrier was not reached");
    QVERIFY2(std::all_of(
                 criticalResults.begin(),
                 criticalResults.end(),
                 [](Result result) { return Executor::accepted(result); }) &&
                 std::all_of(
                     ordinaryAResults.begin(),
                     ordinaryAResults.end(),
                     [](Result result) { return Executor::accepted(result); }) &&
                 Executor::accepted(ordinaryBResult),
             "Bounded critical/ordinary fairness fixture rejected valid work");
    QVERIFY2(burstDrained && firstOrdinary != burstOperations.end(),
             "Critical burst did not drain or ordinary work never ran");
    QCOMPARE(criticalBeforeOrdinary, std::size_t{8});
    QVERIFY2(burstIndex("ordinary-b-0") < burstIndex("ordinary-a-2"),
             "Ordinary peer A backlog starved ordinary peer B after the critical burst");
    QVERIFY2(burstStats.droppedOrdinaryCapacity == 0 &&
                 burstStats.rejectedCriticalCapacity == 0,
             "Fair bounded burst unexpectedly dropped admitted work");
}

void TestWebRtcClient::testCallbackCanShutdownClientWithoutDeadlock() {
    auto client = std::make_shared<versus::webrtc::WebRtcClient>();
    QVERIFY(client->initialize(alphaPeerConfig()));

    struct ShutdownState {
        std::atomic<bool> once{false};
        std::atomic<bool> returned{false};
    };
    auto shutdownState = std::make_shared<ShutdownState>();
    std::weak_ptr<versus::webrtc::WebRtcClient> weakClient = client;
    client->setStateCallback(
        [weakClient, shutdownState](versus::webrtc::ConnectionState, uint64_t) {
            if (shutdownState->once.exchange(true, std::memory_order_acq_rel)) return;
            if (auto activeClient = weakClient.lock()) activeClient->shutdown();
            shutdownState->returned.store(true, std::memory_order_release);
        });

    BoundedTask offerTask([client]() { (void)client->createOffer(); });
    const bool callbackCompleted = waitUntil(
        [shutdownState]() { return shutdownState->returned.load(std::memory_order_acquire); },
        std::chrono::seconds(3));
    const bool offerCompleted = offerTask.waitFor(std::chrono::seconds(3));
    offerTask.finishWithoutBlocking();
    const uint64_t finalGeneration = client->transportGeneration();

    QVERIFY2(callbackCompleted, "A callback-triggered shutdown deadlocked");
    QVERIFY2(offerCompleted, "Offer creation did not unwind after callback-triggered shutdown");
    QCOMPARE(finalGeneration, uint64_t{0});
}

void TestWebRtcClient::testConcurrentSendResetAndShutdownCompletes() {
    struct LoopbackState {
        std::shared_ptr<versus::webrtc::WebRtcClient> offerer =
            std::make_shared<versus::webrtc::WebRtcClient>();
        std::shared_ptr<versus::webrtc::WebRtcClient> answerer =
            std::make_shared<versus::webrtc::WebRtcClient>();
        std::atomic<bool> sendAcrossResetResult{false};
        std::atomic<bool> sendAcrossResetExited{false};
        std::atomic<bool> resetWhileSendResult{false};
        std::atomic<int> staleCandidateDeliveries{0};
        std::atomic<bool> staleOfferNonEmpty{false};
        std::atomic<bool> staleResetResult{false};
        std::atomic<bool> answererResetResult{false};
        std::atomic<bool> sendAcrossShutdownResult{false};
        std::atomic<bool> sendAcrossShutdownExited{false};
        std::atomic<bool> shutdownReturned{false};
    };

    struct BarrierState {
        std::atomic<uint64_t> sendGeneration{0};
        std::atomic<bool> sendArmed{false};
        std::atomic<bool> sendEntered{false};
        std::atomic<bool> sendRelease{false};

        std::atomic<uint64_t> callbackGeneration{0};
        std::atomic<bool> callbackArmed{false};
        std::atomic<bool> callbackEntered{false};
        std::atomic<int> callbackEntries{0};
        std::atomic<int> callbackExits{0};
        std::atomic<bool> callbackRelease{false};

        std::mutex closeMutex;
        std::vector<uint64_t> closedGenerations;

        void recordClosed(uint64_t generation) {
            std::lock_guard<std::mutex> lock(closeMutex);
            closedGenerations.push_back(generation);
        }

        bool wasClosed(uint64_t generation) {
            std::lock_guard<std::mutex> lock(closeMutex);
            return std::find(closedGenerations.begin(), closedGenerations.end(), generation) !=
                closedGenerations.end();
        }
    };

    auto loopback = std::make_shared<LoopbackState>();
    auto barriers = std::make_shared<BarrierState>();
    std::weak_ptr<LoopbackState> weakLoopback = loopback;

    const versus::webrtc::WebRtcClient::IceCandidateCallback offererCandidateRouting =
        [weakLoopback](const std::string &candidate,
                       const std::string &mid,
                       int mlineIndex,
                       uint64_t) {
        if (auto state = weakLoopback.lock()) {
            state->answerer->addRemoteCandidate(candidate, mid, mlineIndex);
        }
    };
    const versus::webrtc::WebRtcClient::IceCandidateCallback answererCandidateRouting =
        [weakLoopback](const std::string &candidate,
                       const std::string &mid,
                       int mlineIndex,
                       uint64_t) {
        if (auto state = weakLoopback.lock()) {
            state->offerer->addRemoteCandidate(candidate, mid, mlineIndex);
        }
    };
    loopback->offerer->setIceCandidateCallback(offererCandidateRouting);
    loopback->answerer->setIceCandidateCallback(answererCandidateRouting);

    auto answerConfig = alphaPeerConfig();
    answerConfig.enableDataChannel = false;
    answerConfig.initialVideo = false;
    answerConfig.initialAudio = false;
    answerConfig.initialAlpha = false;
    answerConfig.enableAlphaTrack = false;

    const bool offererInitialized = loopback->offerer->initialize(alphaPeerConfig());
    const bool answererInitialized = loopback->answerer->initialize(answerConfig);

    auto shutdownPair = [loopback]() {
        BoundedTask offererShutdown([loopback]() { loopback->offerer->shutdown(); });
        BoundedTask answererShutdown([loopback]() { loopback->answerer->shutdown(); });
        const bool offererDone = offererShutdown.waitFor(std::chrono::seconds(3));
        const bool answererDone = answererShutdown.waitFor(std::chrono::seconds(3));
        offererShutdown.finishWithoutBlocking();
        answererShutdown.finishWithoutBlocking();
        return offererDone && answererDone;
    };

    std::string offer;
    std::string answer;
    bool answerApplied = false;
    if (offererInitialized && answererInitialized) {
        offer = loopback->offerer->createOffer();
        if (!offer.empty()) answer = loopback->answerer->createAnswer(offer);
        if (!answer.empty()) {
            answerApplied = loopback->offerer->setRemoteDescription(answer, "answer");
        }
    }
    const bool negotiated = answerApplied && waitUntil(
        [loopback]() {
            return loopback->offerer->hasActiveVideoTrack() &&
                loopback->offerer->hasActiveAlphaVideoTrack() &&
                loopback->offerer->hasActiveAudioTrack() &&
                loopback->offerer->isDataChannelOpen();
        },
        std::chrono::seconds(8),
        std::chrono::milliseconds(10));

    versus::webrtc::EncodedVideoPacket video{{0x82, 0x49, 0x83, 0x42}, 1000, true};
    versus::webrtc::EncodedAudioPacket audio{{0xF8, 0xFF, 0xFE}, 1000, 48000, 2};
    const bool preRetirementVideo = negotiated && loopback->offerer->sendVideo(video);
    const bool preRetirementAlpha = negotiated && loopback->offerer->sendAlphaVideo(video);
    const bool preRetirementAudio = negotiated && loopback->offerer->sendAudio(audio);
    const bool preRetirementData = negotiated && loopback->offerer->sendDataMessage("loopback-ready");
    const auto vp9SequencesBeforeReset =
        versus::webrtc::WebRtcClientTestAccess::vp9SequenceNumbers(*loopback->offerer);

    if (!offererInitialized || !answererInitialized || !negotiated ||
        !preRetirementVideo || !preRetirementAlpha || !preRetirementAudio || !preRetirementData) {
        const bool cleanupCompleted = shutdownPair();
        QVERIFY2(offererInitialized && answererInitialized,
                 "Failed to initialize the real WebRtcClient loopback pair");
        QVERIFY2(!offer.empty() && !answer.empty() && answerApplied,
                 "Failed to negotiate the real WebRtcClient loopback pair");
        QVERIFY2(negotiated,
                 "Offerer video/alpha/audio tracks and data channel did not all open");
        QVERIFY2(preRetirementVideo && preRetirementAlpha &&
                     preRetirementAudio && preRetirementData,
                 "A negotiated transport rejected video/alpha/audio/data before retirement");
        QVERIFY2(cleanupCompleted, "Loopback failure cleanup did not complete within its bound");
        return;
    }

    const auto beforeVideoSend = [barriers](uint64_t generation) {
        if (!barriers->sendArmed.load(std::memory_order_acquire) ||
            barriers->sendGeneration.load(std::memory_order_acquire) != generation) {
            return;
        }
        barriers->sendEntered.store(true, std::memory_order_release);
        while (!barriers->sendRelease.load(std::memory_order_acquire)) {
            std::this_thread::yield();
        }
    };
    const auto beforeCallbackAdmission = [barriers](uint64_t generation) {
        if (!barriers->callbackArmed.load(std::memory_order_acquire) ||
            barriers->callbackGeneration.load(std::memory_order_acquire) != generation) {
            return;
        }
        barriers->callbackEntries.fetch_add(1, std::memory_order_acq_rel);
        barriers->callbackEntered.store(true, std::memory_order_release);
        while (!barriers->callbackRelease.load(std::memory_order_acquire)) {
            std::this_thread::yield();
        }
        barriers->callbackExits.fetch_add(1, std::memory_order_acq_rel);
    };
    const auto afterTransportClose = [barriers](uint64_t generation) {
        barriers->recordClosed(generation);
    };

    const uint64_t initialGeneration = loopback->offerer->transportGeneration();
    versus::webrtc::WebRtcClientTestAccess::setConcurrencyHooks(
        *loopback->offerer, beforeVideoSend, {}, afterTransportClose);
    barriers->sendGeneration.store(initialGeneration, std::memory_order_release);
    barriers->sendRelease.store(false, std::memory_order_release);
    barriers->sendEntered.store(false, std::memory_order_release);
    barriers->sendArmed.store(true, std::memory_order_release);

    video.pts = 2000;
    BoundedTask sendAcrossReset([loopback, video]() {
        loopback->sendAcrossResetResult.store(
            loopback->offerer->sendVideo(video), std::memory_order_release);
        loopback->sendAcrossResetExited.store(true, std::memory_order_release);
    });
    const bool sendEnteredResetBarrier = waitUntil(
        [barriers]() { return barriers->sendEntered.load(std::memory_order_acquire); },
        std::chrono::seconds(2));

    BoundedTask resetWhileSend([loopback]() {
        loopback->resetWhileSendResult.store(
            loopback->offerer->resetPeerConnection(false, false, false),
            std::memory_order_release);
    });
    const bool resetCompletedWhileSendParked =
        resetWhileSend.waitFor(std::chrono::seconds(5));
    const uint64_t resetGeneration = loopback->offerer->transportGeneration();
    const auto vp9SequencesDuringReset =
        versus::webrtc::WebRtcClientTestAccess::vp9SequenceNumbers(*loopback->offerer);
    const bool sendStayedParkedAcrossReset =
        !loopback->sendAcrossResetExited.load(std::memory_order_acquire);
    const bool resetCleanupStayedDeferred = !barriers->wasClosed(initialGeneration);

    barriers->sendRelease.store(true, std::memory_order_release);
    barriers->sendArmed.store(false, std::memory_order_release);
    const bool sendAcrossResetCompleted = sendAcrossReset.waitFor(std::chrono::seconds(3));
    const bool resetEventuallyCompleted = resetWhileSend.waitFor(std::chrono::seconds(3));
    const bool resetTransportCleanupCompleted = waitUntil(
        [barriers, initialGeneration]() { return barriers->wasClosed(initialGeneration); },
        std::chrono::seconds(3));
    sendAcrossReset.finishWithoutBlocking();
    resetWhileSend.finishWithoutBlocking();
    const auto vp9SequencesAfterRetiredSend =
        versus::webrtc::WebRtcClientTestAccess::vp9SequenceNumbers(*loopback->offerer);

    bool phaseCanContinue = resetEventuallyCompleted &&
        loopback->resetWhileSendResult.load(std::memory_order_acquire) &&
        resetGeneration > initialGeneration && sendAcrossResetCompleted;

    uint64_t staleReplacementGeneration = 0;
    bool staleCallbackEntered = false;
    bool staleOfferCompletedWhileCallbackParked = false;
    bool staleResetCompletedWhileCallbackParked = false;
    bool staleCallbackStayedParkedAcrossReset = false;
    bool staleCallbackCleanupCompleted = false;
    bool staleOfferEventuallyCompleted = false;
    bool staleResetEventuallyCompleted = false;
    int staleDeliveriesBeforeRelease = -1;
    std::pair<uint16_t, uint16_t> vp9SequencesAfterSecondReset{};

    if (phaseCanContinue) {
        loopback->offerer->setStateCallback({});
        loopback->offerer->setKeyframeRequestCallback({});
        loopback->offerer->setDataMessageCallback({});
        loopback->offerer->setDataChannelStateCallback({});
        loopback->answerer->setIceCandidateCallback({});
        loopback->offerer->setIceCandidateCallback(
            [loopback](const std::string &, const std::string &, int, uint64_t) {
                loopback->staleCandidateDeliveries.fetch_add(1, std::memory_order_acq_rel);
            });

        const uint64_t staleGeneration = loopback->offerer->transportGeneration();
        versus::webrtc::WebRtcClientTestAccess::setConcurrencyHooks(
            *loopback->offerer, {}, beforeCallbackAdmission, afterTransportClose);
        barriers->callbackGeneration.store(staleGeneration, std::memory_order_release);
        barriers->callbackRelease.store(false, std::memory_order_release);
        barriers->callbackEntered.store(false, std::memory_order_release);
        barriers->callbackEntries.store(0, std::memory_order_release);
        barriers->callbackExits.store(0, std::memory_order_release);
        barriers->callbackArmed.store(true, std::memory_order_release);

        BoundedTask staleOffer([loopback]() {
            loopback->staleOfferNonEmpty.store(
                !loopback->offerer->createOffer().empty(), std::memory_order_release);
        });
        staleCallbackEntered = waitUntil(
            [barriers]() { return barriers->callbackEntered.load(std::memory_order_acquire); },
            std::chrono::seconds(2));
        staleOfferCompletedWhileCallbackParked =
            staleOffer.waitFor(std::chrono::seconds(3));

        std::unique_ptr<BoundedTask> staleReset;
        if (staleOfferCompletedWhileCallbackParked) {
            staleReset = std::make_unique<BoundedTask>([loopback]() {
                loopback->staleResetResult.store(
                    loopback->offerer->resetPeerConnection(false, false, false),
                    std::memory_order_release);
            });
            staleResetCompletedWhileCallbackParked =
                staleReset->waitFor(std::chrono::seconds(5));
            staleReplacementGeneration = loopback->offerer->transportGeneration();
            staleCallbackStayedParkedAcrossReset =
                barriers->callbackExits.load(std::memory_order_acquire) == 0;
            staleDeliveriesBeforeRelease =
                loopback->staleCandidateDeliveries.load(std::memory_order_acquire);
        }

        barriers->callbackRelease.store(true, std::memory_order_release);
        barriers->callbackArmed.store(false, std::memory_order_release);
        staleOfferEventuallyCompleted = staleOffer.waitFor(std::chrono::seconds(3));
        staleOffer.finishWithoutBlocking();

        if (!staleReset && staleOfferEventuallyCompleted) {
            staleReset = std::make_unique<BoundedTask>([loopback]() {
                loopback->staleResetResult.store(
                    loopback->offerer->resetPeerConnection(false, false, false),
                    std::memory_order_release);
            });
        }
        if (staleReset) {
            staleResetEventuallyCompleted = staleReset->waitFor(std::chrono::seconds(3));
            if (staleReplacementGeneration == 0 && staleResetEventuallyCompleted) {
                staleReplacementGeneration = loopback->offerer->transportGeneration();
            }
            staleReset->finishWithoutBlocking();
        }
        staleCallbackCleanupCompleted = staleResetEventuallyCompleted && waitUntil(
            [barriers, staleGeneration]() { return barriers->wasClosed(staleGeneration); },
            std::chrono::seconds(3));
        vp9SequencesAfterSecondReset =
            versus::webrtc::WebRtcClientTestAccess::vp9SequenceNumbers(*loopback->offerer);

        phaseCanContinue = staleOfferEventuallyCompleted && staleResetEventuallyCompleted &&
            loopback->staleResetResult.load(std::memory_order_acquire) &&
            staleReplacementGeneration > staleGeneration;
    }

    bool answererResetCompleted = false;
    bool renegotiated = false;
    bool postResetVideo = false;
    bool postResetAlpha = false;
    bool postResetAudio = false;
    bool postResetData = false;
    uint64_t shutdownGeneration = 0;
    bool sendEnteredShutdownBarrier = false;
    bool shutdownCompletedWhileSendParked = false;
    bool shutdownClearedGenerationWhileSendParked = false;
    bool sendStayedParkedAcrossShutdown = false;
    bool shutdownCleanupStayedDeferred = false;
    bool sendAcrossShutdownCompleted = false;
    bool shutdownEventuallyCompleted = false;
    bool shutdownTransportCleanupCompleted = false;
    std::pair<uint16_t, uint16_t> vp9SequencesAfterReplacementSends{};

    if (phaseCanContinue) {
        loopback->offerer->setIceCandidateCallback(offererCandidateRouting);
        loopback->answerer->setIceCandidateCallback(answererCandidateRouting);
        versus::webrtc::WebRtcClientTestAccess::setConcurrencyHooks(
            *loopback->offerer, beforeVideoSend, {}, afterTransportClose);

        BoundedTask resetAnswerer([loopback]() {
            loopback->answererResetResult.store(
                loopback->answerer->resetPeerConnection(false, false, false),
                std::memory_order_release);
        });
        answererResetCompleted = resetAnswerer.waitFor(std::chrono::seconds(5));
        resetAnswerer.finishWithoutBlocking();

        std::string replacementOffer;
        std::string replacementAnswer;
        bool replacementAnswerApplied = false;
        if (answererResetCompleted &&
            loopback->answererResetResult.load(std::memory_order_acquire)) {
            replacementOffer = loopback->offerer->createOffer();
            if (!replacementOffer.empty()) {
                replacementAnswer = loopback->answerer->createAnswer(replacementOffer);
            }
            if (!replacementAnswer.empty()) {
                replacementAnswerApplied =
                    loopback->offerer->setRemoteDescription(replacementAnswer, "answer");
            }
        }
        renegotiated = replacementAnswerApplied && waitUntil(
            [loopback]() {
                return loopback->offerer->hasActiveVideoTrack() &&
                    loopback->offerer->hasActiveAlphaVideoTrack() &&
                    loopback->offerer->hasActiveAudioTrack() &&
                    loopback->offerer->isDataChannelOpen();
            },
            std::chrono::seconds(8),
            std::chrono::milliseconds(10));

        video.pts = 3000;
        audio.pts = 3000;
        postResetVideo = renegotiated && loopback->offerer->sendVideo(video);
        postResetAlpha = renegotiated && loopback->offerer->sendAlphaVideo(video);
        postResetAudio = renegotiated && loopback->offerer->sendAudio(audio);
        postResetData =
            renegotiated && loopback->offerer->sendDataMessage("replacement-loopback-ready");
        vp9SequencesAfterReplacementSends =
            versus::webrtc::WebRtcClientTestAccess::vp9SequenceNumbers(*loopback->offerer);

        if (postResetVideo && postResetAlpha && postResetAudio && postResetData) {
            shutdownGeneration = loopback->offerer->transportGeneration();
            barriers->sendGeneration.store(shutdownGeneration, std::memory_order_release);
            barriers->sendRelease.store(false, std::memory_order_release);
            barriers->sendEntered.store(false, std::memory_order_release);
            barriers->sendArmed.store(true, std::memory_order_release);

            video.pts = 4000;
            BoundedTask sendAcrossShutdown([loopback, video]() {
                loopback->sendAcrossShutdownResult.store(
                    loopback->offerer->sendVideo(video), std::memory_order_release);
                loopback->sendAcrossShutdownExited.store(true, std::memory_order_release);
            });
            sendEnteredShutdownBarrier = waitUntil(
                [barriers]() { return barriers->sendEntered.load(std::memory_order_acquire); },
                std::chrono::seconds(2));

            BoundedTask shutdownOfferer([loopback]() {
                loopback->offerer->shutdown();
                loopback->shutdownReturned.store(true, std::memory_order_release);
            });
            shutdownCompletedWhileSendParked =
                shutdownOfferer.waitFor(std::chrono::seconds(5));
            shutdownClearedGenerationWhileSendParked =
                loopback->offerer->transportGeneration() == 0;
            sendStayedParkedAcrossShutdown =
                !loopback->sendAcrossShutdownExited.load(std::memory_order_acquire);
            shutdownCleanupStayedDeferred = !barriers->wasClosed(shutdownGeneration);

            barriers->sendRelease.store(true, std::memory_order_release);
            barriers->sendArmed.store(false, std::memory_order_release);
            sendAcrossShutdownCompleted =
                sendAcrossShutdown.waitFor(std::chrono::seconds(3));
            shutdownEventuallyCompleted =
                shutdownOfferer.waitFor(std::chrono::seconds(3));
            shutdownTransportCleanupCompleted = waitUntil(
                [barriers, shutdownGeneration]() {
                    return barriers->wasClosed(shutdownGeneration);
                },
                std::chrono::seconds(3));
            sendAcrossShutdown.finishWithoutBlocking();
            shutdownOfferer.finishWithoutBlocking();
        }
    }

    barriers->sendRelease.store(true, std::memory_order_release);
    barriers->callbackRelease.store(true, std::memory_order_release);
    barriers->sendArmed.store(false, std::memory_order_release);
    barriers->callbackArmed.store(false, std::memory_order_release);
    versus::webrtc::WebRtcClientTestAccess::clearConcurrencyHooks(*loopback->offerer);

    BoundedTask offererCleanup([loopback]() { loopback->offerer->shutdown(); });
    BoundedTask answererCleanup([loopback]() { loopback->answerer->shutdown(); });
    const bool offererCleanupCompleted = offererCleanup.waitFor(std::chrono::seconds(3));
    const bool answererCleanupCompleted = answererCleanup.waitFor(std::chrono::seconds(3));
    offererCleanup.finishWithoutBlocking();
    answererCleanup.finishWithoutBlocking();

    QVERIFY2(sendEnteredResetBarrier,
             "The negotiated video send did not enter the deterministic reset barrier");
    QVERIFY2(resetCompletedWhileSendParked,
             "Reset did not complete while the old-generation send was parked");
    QVERIFY2(loopback->resetWhileSendResult.load(std::memory_order_acquire),
             "Reset failed while the old-generation send was parked");
    QVERIFY2(resetGeneration > initialGeneration,
             "Reset did not publish a fresh generation while the old send was parked");
    QVERIFY2(sendStayedParkedAcrossReset,
             "The old-generation send exited before the reset/swap completed");
    QVERIFY2(resetCleanupStayedDeferred,
             "The old generation closed while its send operation still held the bundle");
    QVERIFY2(sendAcrossResetCompleted &&
                 loopback->sendAcrossResetResult.load(std::memory_order_acquire),
             "The retired generation did not finish its parked video send successfully");
    QVERIFY2(resetTransportCleanupCompleted,
             "The retired generation did not close after its video send returned");
    // A rebuild keeps each advertised SSRC, so its manual VP9 RTP sequence must
    // continue across retired and replacement transport generations.
    QCOMPARE(vp9SequencesBeforeReset.first, uint16_t{1});
    QCOMPARE(vp9SequencesBeforeReset.second, uint16_t{1});
    QCOMPARE(vp9SequencesDuringReset.first, vp9SequencesBeforeReset.first);
    QCOMPARE(vp9SequencesDuringReset.second, vp9SequencesBeforeReset.second);
    QCOMPARE(vp9SequencesAfterRetiredSend.first,
             static_cast<uint16_t>(vp9SequencesBeforeReset.first + 1));
    QCOMPARE(vp9SequencesAfterRetiredSend.second, vp9SequencesBeforeReset.second);

    QVERIFY2(staleCallbackEntered,
             "No old-generation ICE candidate entered the callback-admission barrier");
    QVERIFY2(staleOfferCompletedWhileCallbackParked &&
                 loopback->staleOfferNonEmpty.load(std::memory_order_acquire),
             "createOffer did not unwind while its ICE candidate callback was parked");
    QVERIFY2(staleResetCompletedWhileCallbackParked &&
                 loopback->staleResetResult.load(std::memory_order_acquire),
             "The replacement transport was not published while the old callback was parked");
    QVERIFY2(staleReplacementGeneration > resetGeneration,
             "The stale-callback reset did not advance the transport generation");
    QVERIFY2(staleCallbackStayedParkedAcrossReset,
             "The candidate callback left its barrier before the generation swap");
    QCOMPARE(staleDeliveriesBeforeRelease, 0);
    QCOMPARE(loopback->staleCandidateDeliveries.load(std::memory_order_acquire), 0);
    QVERIFY2(staleCallbackCleanupCompleted,
             "The stale callback or its retired transport did not clean up within the bound");
    QCOMPARE(vp9SequencesAfterSecondReset.first, vp9SequencesAfterRetiredSend.first);
    QCOMPARE(vp9SequencesAfterSecondReset.second, vp9SequencesAfterRetiredSend.second);

    QVERIFY2(answererResetCompleted &&
                 loopback->answererResetResult.load(std::memory_order_acquire),
             "The loopback answerer could not reset for the shutdown gate");
    QVERIFY2(renegotiated,
             "The replacement WebRtcClient pair did not reconnect for the shutdown gate");
    QVERIFY2(postResetVideo && postResetAlpha && postResetAudio && postResetData,
             "The replacement transport rejected video/alpha/audio/data before shutdown");
    QCOMPARE(vp9SequencesAfterReplacementSends.first,
             static_cast<uint16_t>(vp9SequencesAfterSecondReset.first + 1));
    QCOMPARE(vp9SequencesAfterReplacementSends.second,
             static_cast<uint16_t>(vp9SequencesAfterSecondReset.second + 1));
    QVERIFY2(sendEnteredShutdownBarrier,
             "The negotiated video send did not enter the deterministic shutdown barrier");
    QVERIFY2(shutdownCompletedWhileSendParked &&
                 loopback->shutdownReturned.load(std::memory_order_acquire),
             "Shutdown did not complete while the old-generation send was parked");
    QVERIFY2(shutdownClearedGenerationWhileSendParked,
             "Shutdown did not clear the active generation while the send was parked");
    QVERIFY2(sendStayedParkedAcrossShutdown,
             "The old-generation send exited before shutdown retired its transport");
    QVERIFY2(shutdownCleanupStayedDeferred,
             "Shutdown closed the generation while its send still held the bundle");
    QVERIFY2(sendAcrossShutdownCompleted &&
                 loopback->sendAcrossShutdownResult.load(std::memory_order_acquire),
             "The shutdown-retired generation did not finish its parked send successfully");
    QVERIFY2(shutdownEventuallyCompleted && shutdownTransportCleanupCompleted,
             "The shutdown-retired transport did not clean up within the bound");
    QVERIFY2(offererCleanupCompleted && answererCleanupCompleted,
             "The real loopback pair did not complete bounded cleanup");
}

QTEST_MAIN(TestWebRtcClient)
#include "test_webrtc_client.moc"
