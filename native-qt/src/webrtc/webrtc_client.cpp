#include "versus/webrtc/webrtc_client.h"

#include <rtc/common.hpp>
#include <rtc/configuration.hpp>
#include <rtc/rtc.hpp>
#include <rtc/av1rtppacketizer.hpp>
#include <rtc/h264rtppacketizer.hpp>
#include <rtc/h265rtppacketizer.hpp>
#include <rtc/nalunit.hpp>
#include <rtc/plihandler.hpp>
#include <rtc/rtppacketizationconfig.hpp>
#include <rtc/rtppacketizer.hpp>

#include <spdlog/spdlog.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <thread>
#include <utility>
#include <variant>

namespace versus::webrtc {
namespace {

constexpr uint8_t kVideoPayloadType = 96;
constexpr uint8_t kAlphaVideoPayloadType = 97;
constexpr uint8_t kAudioPayloadType = 111;
constexpr uint32_t kVideoClockRate = rtc::RtpPacketizer::VideoClockRate;
constexpr uint32_t kAudioClockRate = rtc::OpusRtpPacketizer::DefaultClockRate;
constexpr size_t kMaxVp9RtpPayload = 1150;

rtc::binary toBinary(const std::vector<uint8_t> &data) {
    rtc::binary out;
    out.reserve(data.size());
    for (uint8_t byte : data) {
        out.push_back(static_cast<rtc::byte>(byte));
    }
    return out;
}

bool sendVp9FrameRtp(const std::shared_ptr<rtc::Track> &track,
                     uint16_t &sequenceNumber,
                     uint32_t timestamp,
                     uint32_t ssrc,
                     uint8_t payloadType,
                     const std::vector<uint8_t> &vp9Frame) {
    if (!track || vp9Frame.empty()) {
        return false;
    }

    size_t offset = 0;
    bool first = true;
    try {
        while (offset < vp9Frame.size()) {
            const size_t remaining = vp9Frame.size() - offset;
            const bool last = remaining <= kMaxVp9RtpPayload;
            const size_t chunkLength = last ? remaining : kMaxVp9RtpPayload;

            rtc::binary packet(12 + 1 + chunkLength);
            auto *payload = reinterpret_cast<uint8_t *>(packet.data());
            payload[0] = 0x80;
            payload[1] = static_cast<uint8_t>(last ? (0x80 | payloadType) : payloadType);
            payload[2] = static_cast<uint8_t>((sequenceNumber >> 8) & 0xFF);
            payload[3] = static_cast<uint8_t>(sequenceNumber & 0xFF);
            ++sequenceNumber;
            payload[4] = static_cast<uint8_t>((timestamp >> 24) & 0xFF);
            payload[5] = static_cast<uint8_t>((timestamp >> 16) & 0xFF);
            payload[6] = static_cast<uint8_t>((timestamp >> 8) & 0xFF);
            payload[7] = static_cast<uint8_t>(timestamp & 0xFF);
            payload[8] = static_cast<uint8_t>((ssrc >> 24) & 0xFF);
            payload[9] = static_cast<uint8_t>((ssrc >> 16) & 0xFF);
            payload[10] = static_cast<uint8_t>((ssrc >> 8) & 0xFF);
            payload[11] = static_cast<uint8_t>(ssrc & 0xFF);

            uint8_t descriptor = 0;
            if (first) descriptor |= 0x08;
            if (last) descriptor |= 0x04;
            payload[12] = descriptor;

            std::memcpy(payload + 13, vp9Frame.data() + offset, chunkLength);
            track->send(packet);
            offset += chunkLength;
            first = false;
        }
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to send VP9 RTP packet: {}", e.what());
        return false;
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to send VP9 RTP packet");
        return false;
    }
    return true;
}

std::string selectH264ProfileLevelId(int width, int height, int fps) {
    const int safeWidth = std::max(1, width);
    const int safeHeight = std::max(1, height);
    const int safeFps = std::max(1, fps);
    const long long pixels = static_cast<long long>(safeWidth) * static_cast<long long>(safeHeight);
    if (safeFps > 30 || pixels > (1280LL * 720LL)) return "42e02a";
    if (pixels > (640LL * 480LL)) return "42e01f";
    return "42e01e";
}

}  // namespace

const char *selectedIcePathName(SelectedIcePath path) {
    switch (path) {
        case SelectedIcePath::Host:
            return "HOST";
        case SelectedIcePath::Stun:
            return "STUN";
        case SelectedIcePath::TurnRelay:
            return "TURN/RELAY";
        case SelectedIcePath::Unknown:
        default:
            return "UNKNOWN";
    }
}

struct WebRtcClient::Impl : std::enable_shared_from_this<WebRtcClient::Impl> {
    struct RemoteCandidate {
        std::string candidate;
        std::string mid;
        int mlineIndex = 0;
        uint64_t generation = 0;
    };

    struct ConcurrencyTestHooks {
        std::function<void(uint64_t)> beforeVideoSend;
        std::function<void(uint64_t)> beforeCallbackAdmission;
        std::function<void(uint64_t)> afterTransportClose;
        std::function<void(uint64_t)> beforeStateCommit;
    };

    struct TransportState {
        uint64_t generation = 0;
        IceMode mode = IceMode::All;
        PeerConfig::VideoCodec videoCodec = PeerConfig::VideoCodec::H264;
        bool alphaTrackEnabled = false;
        bool dataChannelEnabled = true;
        bool hasVideoSection = false;
        bool hasAudioSection = false;
        bool hasAlphaSection = false;
        int videoWidth = 1920;
        int videoHeight = 1080;
        int videoFps = 60;

        std::shared_ptr<rtc::PeerConnection> pc;
        std::shared_ptr<rtc::Track> videoTrack;
        std::shared_ptr<rtc::Track> alphaVideoTrack;
        std::shared_ptr<rtc::Track> audioTrack;
        std::shared_ptr<rtc::RtpPacketizer> videoPacketizer;
        std::shared_ptr<rtc::RtpPacketizer> alphaVideoPacketizer;
        std::shared_ptr<rtc::RtpPacketizer> audioPacketizer;
        std::shared_ptr<rtc::RtpPacketizationConfig> videoRtpConfig;
        std::shared_ptr<rtc::RtpPacketizationConfig> alphaVideoRtpConfig;
        std::shared_ptr<rtc::RtpPacketizationConfig> audioRtpConfig;

        std::mutex descriptionMutex;
        std::string localDescription;

        std::mutex remoteCandidateMutex;
        std::vector<RemoteCandidate> pendingRemoteCandidates;
        bool remoteDescriptionSet = false;

        std::mutex dataChannelMutex;
        std::shared_ptr<rtc::DataChannel> sendChannel;
        std::atomic<bool> dataChannelOpen{false};

        std::mutex videoSendMutex;
        std::mutex alphaVideoSendMutex;
        std::mutex audioSendMutex;
        std::atomic<bool> sentFirstKeyframe{false};
        std::atomic<bool> videoTrackOpen{false};
        std::atomic<bool> alphaVideoTrackOpen{false};
        std::atomic<bool> audioTrackOpen{false};
        uint32_t videoSsrc = 2222222;
        uint32_t alphaVideoSsrc = 4444444;
        uint32_t audioSsrc = 3333333;
        std::atomic<bool> published{false};
        std::atomic<bool> closed{false};
        std::shared_ptr<const ConcurrencyTestHooks> testHooks;
        std::atomic<bool> testHooksEnabled{false};

        ~TransportState() { close(); }

        void close() noexcept {
            if (closed.exchange(true, std::memory_order_acq_rel)) return;

            try {
                if (videoTrack) videoTrack->resetCallbacks();
                if (alphaVideoTrack) alphaVideoTrack->resetCallbacks();
                if (audioTrack) audioTrack->resetCallbacks();
            } catch (...) {
                spdlog::debug("[WebRTC] Retired track callback reset raised an exception");
            }

            std::shared_ptr<rtc::DataChannel> channel;
            {
                std::lock_guard<std::mutex> lock(dataChannelMutex);
                channel = std::move(sendChannel);
                dataChannelOpen.store(false, std::memory_order_release);
            }
            if (channel) {
                try {
                    channel->resetCallbacks();
                    channel->close();
                } catch (...) {
                    spdlog::debug("[WebRTC] Retired data channel close raised an exception");
                }
            }

            auto targetPc = std::move(pc);
            if (targetPc) {
                try {
                    targetPc->resetCallbacks();
                    targetPc->close();
                } catch (...) {
                    spdlog::debug("[WebRTC] Retired PeerConnection close raised an exception");
                }
            }

            if (testHooksEnabled.load(std::memory_order_acquire)) {
                const auto hooks = std::atomic_load_explicit(&testHooks, std::memory_order_acquire);
                if (hooks && hooks->afterTransportClose) {
                    try {
                        hooks->afterTransportClose(generation);
                    } catch (...) {
                        spdlog::debug("[WebRTC] Transport close test hook raised an exception");
                    }
                }
            }
        }
    };

    // This mutex protects only the current bundle pointer. No libdatachannel
    // call is made while it is held. A copied bundle keeps a retiring
    // generation alive until the operation using it has returned.
    mutable std::mutex transportMutex;
    std::shared_ptr<TransportState> transport;
    std::recursive_mutex operationMutex;
    std::atomic<uint64_t> nextGeneration{0};
    std::atomic<uint64_t> activeGeneration{0};
    // The connection state and the transport generation it describes are
    // published under transportMutex as one snapshot. A retired transport
    // callback must not pass a generation check and then overwrite the state
    // of a replacement transport.
    ConnectionState state = ConnectionState::Disconnected;
    uint64_t stateGeneration = 0;
    bool shutdownRequested = false;

    std::shared_ptr<const ConcurrencyTestHooks> testHooks;
    std::atomic<bool> testHooksEnabled{false};

    // Rebuilt PeerConnections retain the advertised SSRCs and renegotiate the
    // same browser transceivers. Manual VP9 RTP sequence state therefore
    // belongs to the logical sender, not to one transport generation.
    std::mutex vp9VideoSequenceMutex;
    std::mutex vp9AlphaSequenceMutex;
    uint16_t vp9VideoSequenceNumber = 0;
    uint16_t vp9AlphaSequenceNumber = 0;

    std::mutex configMutex;
    rtc::Configuration config;
    IceMode iceMode = IceMode::All;
    PeerConfig::VideoCodec configuredVideoCodec = PeerConfig::VideoCodec::H264;
    bool enableAlphaTrack = false;
    bool enableDataChannel = true;
    bool videoSectionNegotiated = false;
    bool audioSectionNegotiated = false;
    bool alphaSectionNegotiated = false;
    int configuredVideoWidth = 1920;
    int configuredVideoHeight = 1080;
    int configuredVideoFps = 60;

    std::mutex callbackMutex;
    IceCandidateCallback iceCallback;
    StateCallback stateCallback;
    KeyframeRequestCallback keyframeCallback;
    DataMessageCallback dataMessageCallback;
    DataChannelStateCallback dataChannelStateCallback;

    // User callbacks are serialized so a callback may suppress callbacks and
    // shut down its own client without waiting on a second admitted callback.
    // The lifecycle mutex is held only for admission accounting, never while a
    // user callback executes.
    std::recursive_mutex callbackDispatchMutex;
    std::mutex callbackLifecycleMutex;
    std::condition_variable callbackLifecycleCv;
    bool callbacksSuppressed = true;
    size_t callbacksInFlight = 0;

    static std::vector<const Impl *> &callbackStack() {
        static thread_local std::vector<const Impl *> stack;
        return stack;
    }

    struct CallbackLease {
        Impl &owner;
        std::unique_lock<std::recursive_mutex> dispatchLock;
        bool admitted = false;

        CallbackLease(Impl &ownerValue, uint64_t generation)
            : owner(ownerValue), dispatchLock(ownerValue.callbackDispatchMutex) {
            std::lock_guard<std::mutex> lock(owner.callbackLifecycleMutex);
            if (owner.callbacksSuppressed || !owner.isCurrentGeneration(generation)) return;
            ++owner.callbacksInFlight;
            callbackStack().push_back(&owner);
            admitted = true;
        }

        ~CallbackLease() {
            if (!admitted) return;
            auto &stack = callbackStack();
            if (!stack.empty() && stack.back() == &owner) {
                stack.pop_back();
            } else {
                const auto it = std::find(stack.begin(), stack.end(), &owner);
                if (it != stack.end()) stack.erase(it);
            }
            {
                std::lock_guard<std::mutex> lock(owner.callbackLifecycleMutex);
                --owner.callbacksInFlight;
            }
            owner.callbackLifecycleCv.notify_all();
        }

        explicit operator bool() const { return admitted; }
    };

    static rtc::Configuration makeRtcConfiguration(const std::vector<IceServerConfig> &iceServers,
                                                     IceMode mode) {
        rtc::Configuration rtcConfig;
        for (const auto &ice : iceServers) {
            rtc::IceServer server(ice.url);
            if (!ice.username.empty()) server.username = ice.username;
            if (!ice.credential.empty()) server.password = ice.credential;
            rtcConfig.iceServers.emplace_back(std::move(server));
        }
        if (mode == IceMode::Relay) rtcConfig.iceTransportPolicy = rtc::TransportPolicy::Relay;
        rtcConfig.disableAutoNegotiation = true;
        rtcConfig.forceMediaTransport = true;
        return rtcConfig;
    }

    std::shared_ptr<TransportState> transportSnapshot() const {
        std::lock_guard<std::mutex> lock(transportMutex);
        return transport;
    }

    bool isCurrentGeneration(uint64_t generation) const {
        return generation != 0 && activeGeneration.load(std::memory_order_acquire) == generation;
    }

    bool isCurrentTransport(const std::shared_ptr<TransportState> &candidate) const {
        if (!candidate) return false;
        std::lock_guard<std::mutex> lock(transportMutex);
        return transport == candidate &&
            activeGeneration.load(std::memory_order_relaxed) == candidate->generation;
    }

    std::shared_ptr<TransportState> swapTransport(
        std::shared_ptr<TransportState> replacement,
        ConnectionState replacementState) {
        std::shared_ptr<TransportState> retired;
        {
            std::lock_guard<std::mutex> lock(transportMutex);
            if (replacement) replacement->published.store(true, std::memory_order_release);
            retired = std::exchange(transport, std::move(replacement));
            const uint64_t generation = transport ? transport->generation : 0;
            activeGeneration.store(generation, std::memory_order_release);
            state = replacementState;
            stateGeneration = generation;
        }
        return retired;
    }

    bool publishConnectionState(
        const std::shared_ptr<TransportState> &candidate,
        ConnectionState replacementState) {
        if (!candidate) {
            return false;
        }
        std::lock_guard<std::mutex> lock(transportMutex);
        if (transport != candidate ||
            activeGeneration.load(std::memory_order_relaxed) !=
                candidate->generation) {
            return false;
        }
        state = replacementState;
        stateGeneration = candidate->generation;
        return true;
    }

    bool publishConnectionState(
        uint64_t generation,
        ConnectionState replacementState) {
        if (generation == 0) {
            return false;
        }
        std::lock_guard<std::mutex> lock(transportMutex);
        if (!transport || transport->generation != generation ||
            activeGeneration.load(std::memory_order_relaxed) != generation) {
            return false;
        }
        state = replacementState;
        stateGeneration = generation;
        return true;
    }

    ConnectionState connectionStateSnapshot() const {
        std::lock_guard<std::mutex> lock(transportMutex);
        const uint64_t generation =
            activeGeneration.load(std::memory_order_relaxed);
        if (stateGeneration != generation) {
            return transport
                ? ConnectionState::Disconnected
                : ConnectionState::Closed;
        }
        return state;
    }

    void suppressCallbacksAndWait() {
        size_t localDepth = 0;
        for (const Impl *entry : callbackStack()) {
            if (entry == this) ++localDepth;
        }
        std::unique_lock<std::mutex> lock(callbackLifecycleMutex);
        callbacksSuppressed = true;
        callbackLifecycleCv.wait(lock, [&]() { return callbacksInFlight <= localDepth; });
    }

    void resumeCallbacks() {
        std::lock_guard<std::mutex> lock(callbackLifecycleMutex);
        callbacksSuppressed = false;
    }

    template <typename Callback, typename... Args>
    void invokeCallback(uint64_t generation, Callback Impl::*member, Args &&...args) {
        Callback callback;
        {
            std::lock_guard<std::mutex> lock(callbackMutex);
            callback = this->*member;
        }
        if (!callback) return;

        if (testHooksEnabled.load(std::memory_order_acquire)) {
            const auto hooks = std::atomic_load_explicit(&testHooks, std::memory_order_acquire);
            if (hooks && hooks->beforeCallbackAdmission) {
                try {
                    hooks->beforeCallbackAdmission(generation);
                } catch (...) {
                    spdlog::debug("[WebRTC] Callback admission test hook raised an exception");
                }
            }
        }

        CallbackLease lease(*this, generation);
        if (!lease) return;
        callback(std::forward<Args>(args)...);
    }

    static void storeTestHooks(std::shared_ptr<const ConcurrencyTestHooks> &destination,
                               std::atomic<bool> &enabled,
                               const std::shared_ptr<const ConcurrencyTestHooks> &hooks) {
        if (hooks) {
            std::atomic_store_explicit(&destination, hooks, std::memory_order_release);
            enabled.store(true, std::memory_order_release);
            return;
        }
        enabled.store(false, std::memory_order_release);
        std::atomic_store_explicit(
            &destination, std::shared_ptr<const ConcurrencyTestHooks>{}, std::memory_order_release);
    }

    void setConcurrencyTestHooks(std::shared_ptr<const ConcurrencyTestHooks> hooks) {
        storeTestHooks(testHooks, testHooksEnabled, hooks);
        auto target = transportSnapshot();
        if (target) storeTestHooks(target->testHooks, target->testHooksEnabled, hooks);
    }

    void invokeBeforeStateCommitTestHook(uint64_t generation) const {
        if (!testHooksEnabled.load(std::memory_order_acquire)) {
            return;
        }
        const auto hooks = std::atomic_load_explicit(
            &testHooks,
            std::memory_order_acquire);
        if (!hooks || !hooks->beforeStateCommit) {
            return;
        }
        try {
            hooks->beforeStateCommit(generation);
        } catch (...) {
            spdlog::debug("[WebRTC] State commit test hook raised an exception");
        }
    }

    bool tryAddRemoteCandidate(const std::shared_ptr<TransportState> &target,
                               const RemoteCandidate &remote) {
        if (!target || !target->pc || remote.candidate.empty() ||
            remote.generation != target->generation || !isCurrentTransport(target)) {
            return false;
        }
        (void)remote.mlineIndex;
        target->pc->addRemoteCandidate(rtc::Candidate(remote.candidate, remote.mid));
        return true;
    }

    bool queueRemoteCandidate(const std::shared_ptr<TransportState> &target,
                              RemoteCandidate remote) {
        if (!target || remote.candidate.empty() || remote.generation != target->generation ||
            !isCurrentTransport(target)) {
            return false;
        }
        constexpr size_t kMaxPendingRemoteCandidates = 100;
        std::lock_guard<std::mutex> lock(target->remoteCandidateMutex);
        if (target->pendingRemoteCandidates.size() >= kMaxPendingRemoteCandidates) {
            target->pendingRemoteCandidates.erase(target->pendingRemoteCandidates.begin());
            spdlog::warn("[WebRTC] Pending remote ICE candidate queue full; dropping oldest candidate");
        }
        target->pendingRemoteCandidates.push_back(std::move(remote));
        spdlog::info("[WebRTC] Queued remote ICE candidate until remote description is set (pending={})",
                     target->pendingRemoteCandidates.size());
        return true;
    }

    void drainPendingRemoteCandidates(const std::shared_ptr<TransportState> &target) {
        std::vector<RemoteCandidate> pending;
        {
            std::lock_guard<std::mutex> lock(target->remoteCandidateMutex);
            pending.swap(target->pendingRemoteCandidates);
        }
        if (pending.empty()) return;

        size_t added = 0;
        for (const auto &remote : pending) {
            try {
                if (tryAddRemoteCandidate(target, remote)) ++added;
            } catch (const std::exception &e) {
                spdlog::warn("[WebRTC] Failed to add queued remote ICE candidate: {}", e.what());
            } catch (...) {
                spdlog::warn("[WebRTC] Failed to add queued remote ICE candidate");
            }
        }
        spdlog::info("[WebRTC] Drained queued remote ICE candidates: added={} dropped={}",
                     added,
                     pending.size() - added);
    }

    void bindDataChannel(const std::shared_ptr<TransportState> &target,
                         const std::shared_ptr<rtc::DataChannel> &channel,
                         const char *origin) {
        if (!target || !channel) return;
        {
            std::lock_guard<std::mutex> lock(target->dataChannelMutex);
            target->sendChannel = channel;
            target->dataChannelOpen.store(false, std::memory_order_release);
        }

        spdlog::info("[WebRTC] DataChannel '{}' attached (origin={})", channel->label(), origin);
        std::weak_ptr<Impl> weakSelf = weak_from_this();
        std::weak_ptr<TransportState> weakTarget = target;
        std::weak_ptr<rtc::DataChannel> weakChannel = channel;
        const uint64_t generation = target->generation;

        channel->onOpen([weakSelf, weakTarget, weakChannel, generation]() {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            auto opened = weakChannel.lock();
            if (!self || !state || !opened || !self->isCurrentTransport(state)) return;
            {
                std::lock_guard<std::mutex> lock(state->dataChannelMutex);
                if (state->sendChannel != opened || !self->isCurrentTransport(state)) return;
                state->dataChannelOpen.store(true, std::memory_order_release);
            }
            spdlog::info("[WebRTC] DataChannel open: {}", opened->label());
            self->invokeCallback(generation, &Impl::dataChannelStateCallback, true, generation);
        });

        channel->onClosed([weakSelf, weakTarget, weakChannel, generation]() {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            auto closed = weakChannel.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            bool closedCurrentChannel = false;
            {
                std::lock_guard<std::mutex> lock(state->dataChannelMutex);
                if (closed && state->sendChannel == closed) {
                    state->dataChannelOpen.store(false, std::memory_order_release);
                    closedCurrentChannel = true;
                }
            }
            if (closed) spdlog::info("[WebRTC] DataChannel closed: {}", closed->label());
            if (closedCurrentChannel) {
                self->invokeCallback(generation, &Impl::dataChannelStateCallback, false, generation);
            }
        });

        channel->onError([weakSelf, weakTarget](const std::string &error) {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (self && state && self->isCurrentTransport(state)) {
                spdlog::warn("[WebRTC] DataChannel error: {}", error);
            }
        });

        channel->onMessage([weakSelf, weakTarget, weakChannel, generation](rtc::message_variant data) {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            auto inbound = weakChannel.lock();
            if (!self || !state || !inbound || !self->isCurrentTransport(state)) return;
            {
                std::lock_guard<std::mutex> lock(state->dataChannelMutex);
                if (state->sendChannel != inbound || !self->isCurrentTransport(state)) return;
            }
            if (std::holds_alternative<std::string>(data)) {
                self->invokeCallback(generation,
                                     &Impl::dataMessageCallback,
                                     std::get<std::string>(data),
                                     generation);
                return;
            }
            const auto &binary = std::get<rtc::binary>(data);
            if (binary.empty()) return;
            std::string payload;
            payload.reserve(binary.size());
            for (rtc::byte byte : binary) {
                payload.push_back(static_cast<char>(std::to_integer<unsigned char>(byte)));
            }
            self->invokeCallback(generation, &Impl::dataMessageCallback, payload, generation);
        });

        if (channel->isOpen()) target->dataChannelOpen.store(true, std::memory_order_release);
    }

    bool ensureVideoTrack(const std::shared_ptr<TransportState> &target) {
        if (!target || !target->pc || !isCurrentOrUnpublished(target)) return false;
        PeerConfig::VideoCodec codec;
        {
            std::lock_guard<std::mutex> lock(target->videoSendMutex);
            if (target->videoTrack) return true;
            codec = target->videoCodec;
        }

        rtc::Description::Video video("video", rtc::Description::Direction::SendOnly);
        switch (codec) {
            case PeerConfig::VideoCodec::H265:
                video.addH265Codec(kVideoPayloadType);
                break;
            case PeerConfig::VideoCodec::AV1:
                video.addAV1Codec(kVideoPayloadType);
                break;
            case PeerConfig::VideoCodec::VP9:
                video.addVP9Codec(kVideoPayloadType);
                break;
            case PeerConfig::VideoCodec::H264:
            default: {
                const std::string levelId = selectH264ProfileLevelId(
                    target->videoWidth, target->videoHeight, target->videoFps);
                video.addH264Codec(kVideoPayloadType,
                    "profile-level-id=" + levelId + ";packetization-mode=1;level-asymmetry-allowed=1");
                break;
            }
        }
        video.addSSRC(target->videoSsrc, "gamecapture-video");
        auto track = target->pc->addTrack(video);
        if (!track) return false;

        std::weak_ptr<Impl> weakSelf = weak_from_this();
        std::weak_ptr<TransportState> weakTarget = target;
        const uint64_t generation = target->generation;
        track->onOpen([weakSelf, weakTarget]() {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            state->videoTrackOpen.store(true, std::memory_order_release);
        });
        track->onClosed([weakSelf, weakTarget]() {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            state->videoTrackOpen.store(false, std::memory_order_release);
        });

        auto rtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
            target->videoSsrc, "gamecapture-video", kVideoPayloadType, kVideoClockRate);
        std::shared_ptr<rtc::RtpPacketizer> packetizer;
        switch (codec) {
            case PeerConfig::VideoCodec::H265:
                packetizer = std::make_shared<rtc::H265RtpPacketizer>(
                    rtc::NalUnit::Separator::StartSequence, rtpConfig);
                break;
            case PeerConfig::VideoCodec::AV1:
                packetizer = std::make_shared<rtc::AV1RtpPacketizer>(
                    rtc::AV1RtpPacketizer::Packetization::TemporalUnit, rtpConfig);
                break;
            case PeerConfig::VideoCodec::VP9:
                break;
            case PeerConfig::VideoCodec::H264:
            default:
                packetizer = std::make_shared<rtc::H264RtpPacketizer>(
                    rtc::NalUnit::Separator::StartSequence, rtpConfig);
                break;
        }
        if (packetizer) {
            auto reporter = std::make_shared<rtc::RtcpSrReporter>(rtpConfig);
            auto nack = std::make_shared<rtc::RtcpNackResponder>();
            auto pli = std::make_shared<rtc::PliHandler>([weakSelf, weakTarget, generation]() {
                auto self = weakSelf.lock();
                auto state = weakTarget.lock();
                if (!self || !state || !self->isCurrentTransport(state)) return;
                self->invokeCallback(generation, &Impl::keyframeCallback, generation);
            });
            packetizer->addToChain(reporter);
            packetizer->addToChain(nack);
            packetizer->addToChain(pli);
            track->setMediaHandler(packetizer);
        } else if (codec == PeerConfig::VideoCodec::VP9) {
            // Manual VP9 already supplies complete RTP packets. Cache those
            // packets directly so receiver NACKs can recover a missing fragment
            // without discarding the entire independently decodable frame.
            track->setMediaHandler(std::make_shared<rtc::RtcpNackResponder>());
        }
        const bool open = track->isOpen();
        {
            std::lock_guard<std::mutex> lock(target->videoSendMutex);
            target->videoTrack = std::move(track);
            target->videoRtpConfig = std::move(rtpConfig);
            target->videoPacketizer = std::move(packetizer);
        }
        target->hasVideoSection = true;
        target->videoTrackOpen.store(open, std::memory_order_release);
        return true;
    }

    bool ensureAlphaVideoTrack(const std::shared_ptr<TransportState> &target) {
        if (!target || !target->pc || !isCurrentOrUnpublished(target)) return false;
        {
            std::lock_guard<std::mutex> lock(target->alphaVideoSendMutex);
            if (!target->alphaTrackEnabled) return false;
            if (target->alphaVideoTrack) return true;
        }

        rtc::Description::Video alpha("video-alpha", rtc::Description::Direction::SendOnly);
        alpha.addVP9Codec(kAlphaVideoPayloadType);
        alpha.addSSRC(target->alphaVideoSsrc, "gamecapture-alpha");
        auto track = target->pc->addTrack(alpha);
        if (!track) return false;

        std::weak_ptr<Impl> weakSelf = weak_from_this();
        std::weak_ptr<TransportState> weakTarget = target;
        track->onOpen([weakSelf, weakTarget]() {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            state->alphaVideoTrackOpen.store(true, std::memory_order_release);
        });
        track->onClosed([weakSelf, weakTarget]() {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            state->alphaVideoTrackOpen.store(false, std::memory_order_release);
        });
        auto rtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
            target->alphaVideoSsrc, "gamecapture-alpha", kAlphaVideoPayloadType, kVideoClockRate);
        track->setMediaHandler(std::make_shared<rtc::RtcpNackResponder>());
        const bool open = track->isOpen();
        {
            std::lock_guard<std::mutex> lock(target->alphaVideoSendMutex);
            target->alphaVideoTrack = std::move(track);
            target->alphaVideoRtpConfig = std::move(rtpConfig);
            target->alphaVideoPacketizer.reset();
        }
        target->hasAlphaSection = true;
        target->alphaVideoTrackOpen.store(open, std::memory_order_release);
        return true;
    }

    bool ensureAudioTrack(const std::shared_ptr<TransportState> &target) {
        if (!target || !target->pc || !isCurrentOrUnpublished(target)) return false;
        {
            std::lock_guard<std::mutex> lock(target->audioSendMutex);
            if (target->audioTrack) return true;
        }

        rtc::Description::Audio audio("audio", rtc::Description::Direction::SendOnly);
        audio.addOpusCodec(kAudioPayloadType);
        audio.addSSRC(target->audioSsrc, "gamecapture-audio");
        auto track = target->pc->addTrack(audio);
        if (!track) return false;

        std::weak_ptr<Impl> weakSelf = weak_from_this();
        std::weak_ptr<TransportState> weakTarget = target;
        track->onOpen([weakSelf, weakTarget]() {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            state->audioTrackOpen.store(true, std::memory_order_release);
        });
        track->onClosed([weakSelf, weakTarget]() {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            state->audioTrackOpen.store(false, std::memory_order_release);
        });
        auto rtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
            target->audioSsrc, "gamecapture-audio", kAudioPayloadType, kAudioClockRate);
        auto packetizer = std::make_shared<rtc::OpusRtpPacketizer>(rtpConfig);
        packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(rtpConfig));
        packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());
        track->setMediaHandler(packetizer);
        const bool open = track->isOpen();
        {
            std::lock_guard<std::mutex> lock(target->audioSendMutex);
            target->audioTrack = std::move(track);
            target->audioRtpConfig = std::move(rtpConfig);
            target->audioPacketizer = std::move(packetizer);
        }
        target->hasAudioSection = true;
        target->audioTrackOpen.store(open, std::memory_order_release);
        return true;
    }

    bool setupBootstrapTransport(const std::shared_ptr<TransportState> &target) {
        if (!target || !target->pc || !isCurrentOrUnpublished(target)) return false;
        auto channel = target->pc->createDataChannel("sendChannel");
        if (!channel) return false;
        bindDataChannel(target, channel, "local");
        return true;
    }

    bool isCurrentOrUnpublished(const std::shared_ptr<TransportState> &candidate) const {
        if (!candidate) return false;
        return !candidate->published.load(std::memory_order_acquire) || isCurrentTransport(candidate);
    }

    static std::pair<ConnectionState, const char *> mapConnectionState(
        rtc::PeerConnection::State value) {
        switch (value) {
            case rtc::PeerConnection::State::Connecting:
                return {ConnectionState::Connecting, "connecting"};
            case rtc::PeerConnection::State::Connected:
                return {ConnectionState::Connected, "connected"};
            case rtc::PeerConnection::State::Failed:
                return {ConnectionState::Failed, "failed"};
            case rtc::PeerConnection::State::Closed:
                return {ConnectionState::Closed, "closed"};
            case rtc::PeerConnection::State::New:
            case rtc::PeerConnection::State::Disconnected:
            default:
                return {ConnectionState::Disconnected, "disconnected"};
        }
    }

    void bindPeerCallbacks(const std::shared_ptr<TransportState> &target) {
        std::weak_ptr<Impl> weakSelf = weak_from_this();
        std::weak_ptr<TransportState> weakTarget = target;
        const uint64_t generation = target->generation;
        const IceMode mode = target->mode;

        target->pc->onStateChange([weakSelf, weakTarget, generation](rtc::PeerConnection::State rawState) {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            const auto [mapped, name] = mapConnectionState(rawState);
            spdlog::info("[WebRTC] PeerConnection state: {}", name);
            self->invokeBeforeStateCommitTestHook(generation);
            if (!self->publishConnectionState(state, mapped)) return;
            self->invokeCallback(generation, &Impl::stateCallback, mapped, generation);
        });

        target->pc->onLocalCandidate([weakSelf, weakTarget, generation, mode](rtc::Candidate candidate) {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;

            if (!candidateAllowedForMode(candidate.candidate(), mode)) return;
            self->invokeCallback(generation,
                                 &Impl::iceCallback,
                                 candidate.candidate(),
                                 candidate.mid(),
                                 0,
                                 generation);
        });

        target->pc->onLocalDescription([weakSelf, weakTarget](rtc::Description description) {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !self->isCurrentTransport(state)) return;
            std::lock_guard<std::mutex> lock(state->descriptionMutex);
            if (!self->isCurrentTransport(state)) return;
            state->localDescription = std::string(description);
        });

        target->pc->onDataChannel([weakSelf, weakTarget](std::shared_ptr<rtc::DataChannel> channel) {
            auto self = weakSelf.lock();
            auto state = weakTarget.lock();
            if (!self || !state || !channel || !self->isCurrentTransport(state)) return;
            self->bindDataChannel(state, channel, "remote");
        });
    }

    std::shared_ptr<TransportState> buildTransport(const rtc::Configuration &rtcConfig,
                                                   IceMode mode,
                                                   bool initialVideo,
                                                   bool initialAudio,
                                                   bool initialAlpha) {
        auto target = std::make_shared<TransportState>();
        const auto hooks = std::atomic_load_explicit(&testHooks, std::memory_order_acquire);
        storeTestHooks(target->testHooks, target->testHooksEnabled, hooks);
        target->generation = nextGeneration.fetch_add(1, std::memory_order_acq_rel) + 1;
        target->mode = mode;
        target->videoCodec = configuredVideoCodec;
        target->dataChannelEnabled = enableDataChannel;
        target->videoWidth = configuredVideoWidth;
        target->videoHeight = configuredVideoHeight;
        target->videoFps = configuredVideoFps;

        const bool buildVideo = initialVideo || videoSectionNegotiated;
        const bool buildAudio = initialAudio || audioSectionNegotiated;
        const bool buildAlpha = initialAlpha || alphaSectionNegotiated;
        target->alphaTrackEnabled = enableAlphaTrack || buildAlpha;

        try {
            target->pc = std::make_shared<rtc::PeerConnection>(rtcConfig);
            bindPeerCallbacks(target);
            // libdatachannel emits tracks in insertion order and application
            // last. This order is therefore an invariant across generations.
            if (buildVideo && !ensureVideoTrack(target)) return {};
            if (buildAudio && !ensureAudioTrack(target)) return {};
            if (buildVideo && buildAlpha && !ensureAlphaVideoTrack(target)) return {};
            if (target->dataChannelEnabled && !setupBootstrapTransport(target)) return {};
            return target;
        } catch (const std::exception &e) {
            spdlog::warn("[WebRTC] Failed to build transport generation {}: {}",
                         target->generation,
                         e.what());
        } catch (...) {
            spdlog::warn("[WebRTC] Failed to build transport generation {}", target->generation);
        }
        return {};
    }
};

WebRtcClient::WebRtcClient() : impl_(std::make_shared<Impl>()) {}
WebRtcClient::~WebRtcClient() { shutdown(); }

bool WebRtcClient::initialize(const PeerConfig &config) {
    // Relay mode cannot work without at least one TURN server. Authoritative
    // Auto/Relay registry validation happens before the client is created.
    if (config.iceMode == IceMode::Relay) {
        const bool hasTurnServer = std::any_of(
            config.iceServers.begin(),
            config.iceServers.end(),
            [](const IceServerConfig &server) {
                return server.url.rfind("turn:", 0) == 0 ||
                    server.url.rfind("turns:", 0) == 0;
            });
        if (!hasTurnServer) {
            spdlog::warn(
                "[WebRTC] Rejected ICE configuration mode=relay reason=no-turn-servers");
            return false;
        }
    }

    rtc::Configuration rtcConfig;
    try {
        rtcConfig = Impl::makeRtcConfiguration(config.iceServers, config.iceMode);
    } catch (const std::exception &error) {
        spdlog::warn("[WebRTC] Rejected ICE configuration mode={} reason=rtc-config-error detail={}",
                     iceModeName(config.iceMode),
                     error.what());
        return false;
    } catch (...) {
        spdlog::warn("[WebRTC] Rejected ICE configuration mode={} reason=rtc-config-error",
                     iceModeName(config.iceMode));
        return false;
    }
    {
        std::lock_guard<std::mutex> lock(impl_->configMutex);
        impl_->iceMode = config.iceMode;
        impl_->config = rtcConfig;
    }

    impl_->suppressCallbacksAndWait();
    std::shared_ptr<Impl::TransportState> replacement;
    std::shared_ptr<Impl::TransportState> retired;
    {
        std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
        impl_->shutdownRequested = false;
        impl_->configuredVideoCodec = config.videoCodec;
        impl_->enableAlphaTrack = config.enableAlphaTrack;
        impl_->enableDataChannel = config.enableDataChannel;
        impl_->videoSectionNegotiated = false;
        impl_->audioSectionNegotiated = false;
        impl_->alphaSectionNegotiated = false;
        impl_->configuredVideoWidth = std::max(1, config.videoWidth);
        impl_->configuredVideoHeight = std::max(1, config.videoHeight);
        impl_->configuredVideoFps = std::max(1, config.videoFps);
        replacement = impl_->buildTransport(
            rtcConfig, config.iceMode, config.initialVideo, config.initialAudio, config.initialAlpha);
        if (replacement) {
            impl_->videoSectionNegotiated = replacement->hasVideoSection;
            impl_->audioSectionNegotiated = replacement->hasAudioSection;
            impl_->alphaSectionNegotiated = replacement->hasAlphaSection;
        }
        retired = impl_->swapTransport(
            replacement,
            ConnectionState::Disconnected);
    }
    retired.reset();
    if (replacement) {
        impl_->resumeCallbacks();
    }
    return static_cast<bool>(replacement);
}

void WebRtcClient::shutdown() {
    impl_->suppressCallbacksAndWait();
    std::shared_ptr<Impl::TransportState> retired;
    {
        std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
        impl_->shutdownRequested = true;
        retired = impl_->swapTransport({}, ConnectionState::Closed);
    }
    // A send or callback that already captured this generation keeps it alive;
    // the final holder closes it after returning from libdatachannel.
    retired.reset();
}

bool WebRtcClient::resetPeerConnection(bool initialVideo, bool initialAudio, bool initialAlpha) {
    // User callbacks may call reset recursively. A reset from another thread
    // waits for an already-admitted callback to finish, while a callback still
    // parked before admission observes the replacement generation and drops.
    // This removes the need for app callbacks to hold the peer operation mutex.
    std::lock_guard<std::recursive_mutex> callbackDispatchLock(
        impl_->callbackDispatchMutex);
    rtc::Configuration rtcConfig;
    IceMode mode = IceMode::All;
    {
        std::lock_guard<std::mutex> lock(impl_->configMutex);
        rtcConfig = impl_->config;
        mode = impl_->iceMode;
    }

    std::shared_ptr<Impl::TransportState> replacement;
    std::shared_ptr<Impl::TransportState> retired;
    {
        std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
        if (impl_->shutdownRequested) return false;
        replacement = impl_->buildTransport(rtcConfig, mode, initialVideo, initialAudio, initialAlpha);
        if (replacement) {
            impl_->videoSectionNegotiated =
                impl_->videoSectionNegotiated || replacement->hasVideoSection;
            impl_->audioSectionNegotiated =
                impl_->audioSectionNegotiated || replacement->hasAudioSection;
            impl_->alphaSectionNegotiated =
                impl_->alphaSectionNegotiated || replacement->hasAlphaSection;
        }
        retired = impl_->swapTransport(
            replacement,
            ConnectionState::Disconnected);
    }
    retired.reset();
    return static_cast<bool>(replacement);
}

void WebRtcClient::setVideoCodec(PeerConfig::VideoCodec codec, bool enableAlphaTrack) {
    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
    impl_->configuredVideoCodec = codec;
    impl_->enableAlphaTrack = enableAlphaTrack;
}

bool WebRtcClient::setRemoteDescription(const std::string &sdp, const std::string &type) {
    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
    auto target = impl_->transportSnapshot();
    if (!target || !target->pc || !impl_->isCurrentTransport(target)) return false;
    const auto descType = type == "answer"
        ? rtc::Description::Type::Answer
        : rtc::Description::Type::Offer;
    try {
        target->pc->setRemoteDescription(rtc::Description(sdp, descType));
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to set remote {} description: {}", type, e.what());
        return false;
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to set remote {} description", type);
        return false;
    }
    if (!impl_->isCurrentTransport(target)) return false;
    {
        std::lock_guard<std::mutex> lock(target->remoteCandidateMutex);
        target->remoteDescriptionSet = true;
    }
    impl_->drainPendingRemoteCandidates(target);
    return true;
}

std::string WebRtcClient::createOffer() {
    std::lock_guard<std::recursive_mutex> callbackDispatchLock(
        impl_->callbackDispatchMutex);
    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
    auto target = impl_->transportSnapshot();
    if (!target || !target->pc || !impl_->isCurrentTransport(target)) return {};
    {
        std::lock_guard<std::mutex> lock(target->remoteCandidateMutex);
        target->pendingRemoteCandidates.clear();
        target->remoteDescriptionSet = false;
    }
    {
        std::lock_guard<std::mutex> lock(target->descriptionMutex);
        target->localDescription.clear();
    }
    try {
        target->pc->setLocalDescription(rtc::Description::Type::Offer);
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to create local offer: {}", e.what());
        return {};
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to create local offer");
        return {};
    }

    const auto started = std::chrono::steady_clock::now();
    for (;;) {
        {
            std::lock_guard<std::mutex> lock(target->descriptionMutex);
            if (!target->localDescription.empty()) break;
        }
        if (!impl_->isCurrentTransport(target)) return {};
        if (std::chrono::steady_clock::now() - started > std::chrono::seconds(2)) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (!impl_->isCurrentTransport(target)) return {};

    std::string sdp;
    {
        std::lock_guard<std::mutex> lock(target->descriptionMutex);
        sdp = target->localDescription;
    }
    if (sdp.empty()) {
        auto description = target->pc->localDescription();
        if (description) sdp = std::string(*description);
    }
    return sdp.empty() ? std::string{} : filterSessionDescriptionForMode(sdp, target->mode);
}

std::string WebRtcClient::createAnswer(const std::string &offer) {
    std::lock_guard<std::recursive_mutex> callbackDispatchLock(
        impl_->callbackDispatchMutex);
    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
    auto target = impl_->transportSnapshot();
    if (!target || !target->pc || !impl_->isCurrentTransport(target)) return {};
    {
        std::lock_guard<std::mutex> lock(target->descriptionMutex);
        target->localDescription.clear();
    }
    try {
        target->pc->setRemoteDescription(rtc::Description(offer, rtc::Description::Type::Offer));
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to set remote offer description: {}", e.what());
        return {};
    } catch (...) {
        return {};
    }
    if (!impl_->isCurrentTransport(target)) return {};
    {
        std::lock_guard<std::mutex> lock(target->remoteCandidateMutex);
        target->remoteDescriptionSet = true;
    }
    impl_->drainPendingRemoteCandidates(target);
    try {
        target->pc->setLocalDescription(rtc::Description::Type::Answer);
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to create local answer: {}", e.what());
        return {};
    } catch (...) {
        return {};
    }

    const auto started = std::chrono::steady_clock::now();
    for (;;) {
        {
            std::lock_guard<std::mutex> lock(target->descriptionMutex);
            if (!target->localDescription.empty()) break;
        }
        if (!impl_->isCurrentTransport(target)) return {};
        if (std::chrono::steady_clock::now() - started > std::chrono::seconds(5)) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    if (!impl_->isCurrentTransport(target)) return {};
    std::lock_guard<std::mutex> lock(target->descriptionMutex);
    return target->localDescription;
}

bool WebRtcClient::addRemoteCandidate(const std::string &candidate,
                                      const std::string &mid,
                                      int mlineIndex) {
    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
    auto target = impl_->transportSnapshot();
    if (!target || !target->pc || !impl_->isCurrentTransport(target)) return false;
    IceMode activeMode = IceMode::All;
    {
        std::lock_guard<std::mutex> lock(impl_->configMutex);
        activeMode = impl_->iceMode;
    }
    if (activeMode == IceMode::Relay) {
        try {
            const rtc::Candidate parsed(candidate, mid);
            if (parsed.type() != rtc::Candidate::Type::Relayed) {
                // libdatachannel's Relay transport policy suppresses local
                // host candidates from signaling, but libjuice can still
                // build a direct pair when a remote host candidate is added.
                // Ignore that candidate in explicit Relay mode so incoming
                // checks establish the peer-reflexive remote half against
                // our TURN-relayed local candidate instead.
                spdlog::debug(
                    "[WebRTC] Ignoring non-relay remote ICE candidate in explicit Relay mode");
                return true;
            }
        } catch (...) {
            spdlog::warn(
                "[WebRTC] Ignoring malformed remote ICE candidate in explicit Relay mode");
            return false;
        }
    }
    Impl::RemoteCandidate remote{candidate, mid, mlineIndex, target->generation};
    bool descriptionReady = false;
    {
        std::lock_guard<std::mutex> lock(target->remoteCandidateMutex);
        descriptionReady = target->remoteDescriptionSet;
    }
    if (!descriptionReady) return impl_->queueRemoteCandidate(target, std::move(remote));
    try {
        return impl_->tryAddRemoteCandidate(target, remote);
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to add remote ICE candidate: {}", e.what());
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to add remote ICE candidate");
    }
    return false;
}

void WebRtcClient::prepareForShutdown() { impl_->suppressCallbacksAndWait(); }

void WebRtcClient::setIceCandidateCallback(IceCandidateCallback cb) {
    std::lock_guard<std::mutex> lock(impl_->callbackMutex);
    impl_->iceCallback = std::move(cb);
}

void WebRtcClient::setStateCallback(StateCallback cb) {
    std::lock_guard<std::mutex> lock(impl_->callbackMutex);
    impl_->stateCallback = std::move(cb);
}

void WebRtcClient::setKeyframeRequestCallback(KeyframeRequestCallback cb) {
    std::lock_guard<std::mutex> lock(impl_->callbackMutex);
    impl_->keyframeCallback = std::move(cb);
}

void WebRtcClient::setDataMessageCallback(DataMessageCallback cb) {
    std::lock_guard<std::mutex> lock(impl_->callbackMutex);
    impl_->dataMessageCallback = std::move(cb);
}

void WebRtcClient::setDataChannelStateCallback(DataChannelStateCallback cb) {
    std::lock_guard<std::mutex> lock(impl_->callbackMutex);
    impl_->dataChannelStateCallback = std::move(cb);
}

void WebRtcClient::setConcurrencyTestHooks(
    std::function<void(uint64_t)> beforeVideoSend,
    std::function<void(uint64_t)> beforeCallbackAdmission,
    std::function<void(uint64_t)> afterTransportClose,
    std::function<void(uint64_t)> beforeStateCommit) {
    if (!beforeVideoSend && !beforeCallbackAdmission && !afterTransportClose &&
        !beforeStateCommit) {
        impl_->setConcurrencyTestHooks({});
        return;
    }

    auto hooks = std::make_shared<Impl::ConcurrencyTestHooks>();
    hooks->beforeVideoSend = std::move(beforeVideoSend);
    hooks->beforeCallbackAdmission = std::move(beforeCallbackAdmission);
    hooks->afterTransportClose = std::move(afterTransportClose);
    hooks->beforeStateCommit = std::move(beforeStateCommit);
    impl_->setConcurrencyTestHooks(std::move(hooks));
}

void WebRtcClient::invokeDataMessageCallbackForTesting(
    const std::string &message,
    uint64_t transportGeneration) {
    if (!impl_) {
        return;
    }
    impl_->invokeCallback(
        transportGeneration,
        &Impl::dataMessageCallback,
        message,
        transportGeneration);
}

void WebRtcClient::invokeIceCandidateCallbackForTesting(
    const std::string &candidate,
    const std::string &mid,
    int mlineIndex,
    uint64_t transportGeneration) {
    if (!impl_) {
        return;
    }
    impl_->invokeCallback(
        transportGeneration,
        &Impl::iceCallback,
        candidate,
        mid,
        mlineIndex,
        transportGeneration);
}

void WebRtcClient::invokeStateCallbackForTesting(
    ConnectionState state,
    uint64_t transportGeneration) {
    if (!impl_) {
        return;
    }
    impl_->invokeBeforeStateCommitTestHook(transportGeneration);
    (void)impl_->publishConnectionState(transportGeneration, state);
    impl_->invokeCallback(
        transportGeneration,
        &Impl::stateCallback,
        state,
        transportGeneration);
}

void WebRtcClient::invokeDataChannelStateCallbackForTesting(
    bool open,
    uint64_t transportGeneration) {
    if (!impl_) {
        return;
    }
    impl_->invokeCallback(
        transportGeneration,
        &Impl::dataChannelStateCallback,
        open,
        transportGeneration);
}

std::size_t WebRtcClient::callbacksInFlightForTesting() const {
    if (!impl_) {
        return 0;
    }
    std::lock_guard<std::mutex> lock(impl_->callbackLifecycleMutex);
    return impl_->callbacksInFlight;
}

std::pair<uint16_t, uint16_t> WebRtcClient::vp9SequenceNumbersForTesting() const {
    std::scoped_lock lock(impl_->vp9VideoSequenceMutex, impl_->vp9AlphaSequenceMutex);
    return {impl_->vp9VideoSequenceNumber, impl_->vp9AlphaSequenceNumber};
}

MediaPlanChange WebRtcClient::ensureMediaTracks(bool enableVideo,
                                                bool enableAudio,
                                                bool enableAlpha) {
    MediaPlanChange change;
    std::lock_guard<std::recursive_mutex> operationLock(impl_->operationMutex);
    if (impl_->shutdownRequested) return change;
    auto target = impl_->transportSnapshot();
    if (!target || !target->pc || !impl_->isCurrentTransport(target)) return change;

    if (enableVideo) {
        bool hasVideo = false;
        {
            std::lock_guard<std::mutex> lock(target->videoSendMutex);
            hasVideo = static_cast<bool>(target->videoTrack);
            if (!hasVideo) target->videoCodec = impl_->configuredVideoCodec;
        }
        if (!hasVideo && impl_->ensureVideoTrack(target)) {
            change.changed = true;
            change.videoAdded = true;
            impl_->videoSectionNegotiated = true;
        }
    }
    if (enableAudio) {
        bool hasAudio = false;
        {
            std::lock_guard<std::mutex> lock(target->audioSendMutex);
            hasAudio = static_cast<bool>(target->audioTrack);
        }
        if (!hasAudio && impl_->ensureAudioTrack(target)) {
            change.changed = true;
            change.audioAdded = true;
            impl_->audioSectionNegotiated = true;
        }
    }
    if (enableVideo && enableAlpha && impl_->enableAlphaTrack) {
        bool hasAlpha = false;
        {
            std::lock_guard<std::mutex> lock(target->alphaVideoSendMutex);
            target->alphaTrackEnabled = true;
            hasAlpha = static_cast<bool>(target->alphaVideoTrack);
        }
        if (!hasAlpha && impl_->ensureAlphaVideoTrack(target)) {
            change.changed = true;
            change.alphaAdded = true;
            impl_->alphaSectionNegotiated = true;
        }
    }
    return change;
}

bool WebRtcClient::sendVideo(const EncodedVideoPacket &packet) {
    auto target = impl_->transportSnapshot();
    if (!target || packet.data.empty() || !impl_->isCurrentTransport(target)) return false;
    std::lock_guard<std::mutex> sendLock(target->videoSendMutex);
    if (!target->videoTrack || !target->videoTrack->isOpen() ||
        !impl_->isCurrentTransport(target)) {
        return false;
    }
    if (target->testHooksEnabled.load(std::memory_order_acquire)) {
        const auto hooks =
            std::atomic_load_explicit(&target->testHooks, std::memory_order_acquire);
        if (hooks && hooks->beforeVideoSend) {
            try {
                hooks->beforeVideoSend(target->generation);
            } catch (...) {
                spdlog::debug("[WebRTC] Video send test hook raised an exception");
            }
        }
    }
    if (!target->sentFirstKeyframe.exchange(true)) {
        spdlog::info("[WebRTC] Starting video transmission, isKeyframe={}", packet.isKeyframe);
    }
    const uint32_t timestamp = static_cast<uint32_t>((packet.pts * 9) / 1000);
    if (target->videoCodec == PeerConfig::VideoCodec::VP9) {
        std::lock_guard<std::mutex> sequenceLock(impl_->vp9VideoSequenceMutex);
        return sendVp9FrameRtp(target->videoTrack,
                               impl_->vp9VideoSequenceNumber,
                               timestamp,
                               target->videoSsrc,
                               kVideoPayloadType,
                               packet.data);
    }
    if (!target->videoRtpConfig) return false;
    target->videoRtpConfig->timestamp = timestamp;
    try {
        target->videoTrack->send(toBinary(packet.data));
        return true;
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to send video packet: {}", e.what());
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to send video packet");
    }
    return false;
}

bool WebRtcClient::sendAlphaVideo(const EncodedVideoPacket &packet) {
    auto target = impl_->transportSnapshot();
    if (!target || packet.data.empty() || !impl_->isCurrentTransport(target)) return false;
    std::lock_guard<std::mutex> sendLock(target->alphaVideoSendMutex);
    if (!target->alphaVideoTrack || !target->alphaVideoTrack->isOpen() ||
        !impl_->isCurrentTransport(target)) {
        return false;
    }
    const uint32_t timestamp = static_cast<uint32_t>((packet.pts * 9) / 1000);
    std::lock_guard<std::mutex> sequenceLock(impl_->vp9AlphaSequenceMutex);
    return sendVp9FrameRtp(target->alphaVideoTrack,
                           impl_->vp9AlphaSequenceNumber,
                           timestamp,
                           target->alphaVideoSsrc,
                           kAlphaVideoPayloadType,
                           packet.data);
}

bool WebRtcClient::sendAudio(const EncodedAudioPacket &packet) {
    auto target = impl_->transportSnapshot();
    if (!target || packet.data.empty() || !impl_->isCurrentTransport(target)) return false;
    std::lock_guard<std::mutex> sendLock(target->audioSendMutex);
    if (!target->audioTrack || !target->audioTrack->isOpen() || !target->audioRtpConfig ||
        !impl_->isCurrentTransport(target)) {
        return false;
    }
    target->audioRtpConfig->timestamp = static_cast<uint32_t>((packet.pts * 48) / 10000);
    try {
        target->audioTrack->send(toBinary(packet.data));
        return true;
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to send audio packet: {}", e.what());
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to send audio packet");
    }
    return false;
}

bool WebRtcClient::sendDataMessage(const std::string &message) {
    auto target = impl_->transportSnapshot();
    if (!target || !impl_->isCurrentTransport(target)) return false;
    std::shared_ptr<rtc::DataChannel> channel;
    {
        std::lock_guard<std::mutex> lock(target->dataChannelMutex);
        channel = target->sendChannel;
    }
    if (!channel || !channel->isOpen() || !impl_->isCurrentTransport(target)) return false;
    try {
        return channel->send(message);
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to send data message: {}", e.what());
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to send data message");
    }
    return false;
}

bool WebRtcClient::isDataChannelOpen() const {
    auto target = impl_->transportSnapshot();
    return target && impl_->isCurrentTransport(target) && target->dataChannelOpen.load();
}

ConnectionState WebRtcClient::connectionState() const {
    return impl_->connectionStateSnapshot();
}

uint64_t WebRtcClient::transportGeneration() const {
    return impl_->activeGeneration.load(std::memory_order_acquire);
}

bool WebRtcClient::hasActiveVideoTrack() const {
    auto target = impl_->transportSnapshot();
    if (!target || !impl_->isCurrentTransport(target)) return false;
    std::shared_ptr<rtc::Track> track;
    {
        std::lock_guard<std::mutex> lock(target->videoSendMutex);
        track = target->videoTrack;
    }
    const bool open = track && track->isOpen();
    target->videoTrackOpen.store(open);
    return open;
}

bool WebRtcClient::hasActiveAlphaVideoTrack() const {
    auto target = impl_->transportSnapshot();
    if (!target || !impl_->isCurrentTransport(target)) return false;
    std::shared_ptr<rtc::Track> track;
    {
        std::lock_guard<std::mutex> lock(target->alphaVideoSendMutex);
        track = target->alphaVideoTrack;
    }
    const bool open = track && track->isOpen();
    target->alphaVideoTrackOpen.store(open);
    return open;
}

bool WebRtcClient::hasActiveAudioTrack() const {
    auto target = impl_->transportSnapshot();
    if (!target || !impl_->isCurrentTransport(target)) return false;
    std::shared_ptr<rtc::Track> track;
    {
        std::lock_guard<std::mutex> lock(target->audioSendMutex);
        track = target->audioTrack;
    }
    const bool open = track && track->isOpen();
    target->audioTrackOpen.store(open);
    return open;
}

bool WebRtcClient::hasConfiguredVideoTrack() const {
    auto target = impl_->transportSnapshot();
    if (!target || !impl_->isCurrentTransport(target)) return false;
    std::lock_guard<std::mutex> lock(target->videoSendMutex);
    return static_cast<bool>(target->videoTrack);
}

bool WebRtcClient::hasConfiguredAudioTrack() const {
    auto target = impl_->transportSnapshot();
    if (!target || !impl_->isCurrentTransport(target)) return false;
    std::lock_guard<std::mutex> lock(target->audioSendMutex);
    return static_cast<bool>(target->audioTrack);
}

SelectedIcePath WebRtcClient::selectedIcePath() const {
    auto target = impl_->transportSnapshot();
    if (!target || !target->pc || !impl_->isCurrentTransport(target)) {
        return SelectedIcePath::Unknown;
    }

    rtc::Candidate local;
    rtc::Candidate remote;
    try {
        if (!target->pc->getSelectedCandidatePair(&local, &remote)) {
            return SelectedIcePath::Unknown;
        }
    } catch (...) {
        return SelectedIcePath::Unknown;
    }

    const auto localType = local.type();
    const auto remoteType = remote.type();
    if (localType == rtc::Candidate::Type::Relayed ||
        remoteType == rtc::Candidate::Type::Relayed) {
        return SelectedIcePath::TurnRelay;
    }
    if (localType == rtc::Candidate::Type::ServerReflexive ||
        localType == rtc::Candidate::Type::PeerReflexive ||
        remoteType == rtc::Candidate::Type::ServerReflexive ||
        remoteType == rtc::Candidate::Type::PeerReflexive) {
        return SelectedIcePath::Stun;
    }
    if (localType == rtc::Candidate::Type::Host &&
        remoteType == rtc::Candidate::Type::Host) {
        return SelectedIcePath::Host;
    }
    return SelectedIcePath::Unknown;
}

}  // namespace versus::webrtc
