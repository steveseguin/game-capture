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
#include <cstddef>
#include <cstring>
#include <mutex>
#include <thread>
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
            if (first) {
                descriptor |= 0x08;
            }
            if (last) {
                descriptor |= 0x04;
            }
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
    if (safeFps > 30 || pixels > (1280LL * 720LL)) {
        // Level 4.2 allows 1080p60 class streams.
        return "42e02a";
    }
    if (pixels > (640LL * 480LL)) {
        // Level 3.1 comfortably covers 720p30 class streams.
        return "42e01f";
    }
    // Level 3.0 for SD class streams.
    return "42e01e";
}

}  // namespace

struct WebRtcClient::Impl {
    struct RemoteCandidate {
        std::string candidate;
        std::string mid;
        int mlineIndex = 0;
    };

    rtc::Configuration config;
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
    std::string localDescription;
    IceCandidateCallback iceCallback;
    StateCallback stateCallback;
    KeyframeRequestCallback keyframeCallback;
    DataMessageCallback dataMessageCallback;
    DataChannelStateCallback dataChannelStateCallback;
    std::shared_ptr<rtc::DataChannel> sendChannel;
    std::mutex descMutex;
    std::mutex dataChannelMutex;
    std::mutex remoteCandidateMutex;
    std::vector<RemoteCandidate> pendingRemoteCandidates;
    std::atomic<ConnectionState> state{ConnectionState::Disconnected};
    std::atomic<bool> suppressCallbacks{false};
    std::atomic<bool> gatheringComplete{false};
    std::atomic<bool> remoteDescriptionSet{false};
    std::atomic<bool> sentFirstKeyframe{false};
    std::atomic<bool> videoTrackOpen{false};
    std::atomic<bool> alphaVideoTrackOpen{false};
    std::atomic<bool> audioTrackOpen{false};
    std::atomic<bool> dataChannelOpen{false};
    std::chrono::steady_clock::time_point trackOpenedTime;
    uint32_t videoSsrc = 2222222;
    uint32_t alphaVideoSsrc = 4444444;
    uint32_t audioSsrc = 3333333;
    uint16_t videoSequenceNumber = 0;
    uint16_t alphaVideoSequenceNumber = 0;
    bool enableAlphaTrack = false;
    bool enableDataChannel = true;
    PeerConfig::VideoCodec videoCodec = PeerConfig::VideoCodec::H264;
    int configuredVideoWidth = 1920;
    int configuredVideoHeight = 1080;
    int configuredVideoFps = 60;
    IceMode iceMode = IceMode::All;

    void resetRemoteCandidateState() {
        {
            std::lock_guard<std::mutex> lock(remoteCandidateMutex);
            pendingRemoteCandidates.clear();
        }
        remoteDescriptionSet.store(false, std::memory_order_relaxed);
    }

    bool tryAddRemoteCandidate(const RemoteCandidate &remote) {
        if (!pc || remote.candidate.empty()) {
            return false;
        }
        (void)remote.mlineIndex;
        pc->addRemoteCandidate(rtc::Candidate(remote.candidate, remote.mid));
        return true;
    }

    bool queueRemoteCandidate(RemoteCandidate remote) {
        if (remote.candidate.empty()) {
            return false;
        }

        constexpr size_t kMaxPendingRemoteCandidates = 100;
        std::lock_guard<std::mutex> lock(remoteCandidateMutex);
        if (pendingRemoteCandidates.size() >= kMaxPendingRemoteCandidates) {
            pendingRemoteCandidates.erase(pendingRemoteCandidates.begin());
            spdlog::warn("[WebRTC] Pending remote ICE candidate queue full; dropping oldest candidate");
        }
        pendingRemoteCandidates.push_back(std::move(remote));
        spdlog::info("[WebRTC] Queued remote ICE candidate until remote description is set (pending={})",
                     pendingRemoteCandidates.size());
        return true;
    }

    void drainPendingRemoteCandidates() {
        std::vector<RemoteCandidate> pending;
        {
            std::lock_guard<std::mutex> lock(remoteCandidateMutex);
            pending.swap(pendingRemoteCandidates);
        }
        if (pending.empty()) {
            return;
        }

        size_t added = 0;
        for (const auto &remote : pending) {
            try {
                if (tryAddRemoteCandidate(remote)) {
                    ++added;
                }
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

    void resetMediaState() {
        videoTrack.reset();
        alphaVideoTrack.reset();
        audioTrack.reset();
        videoPacketizer.reset();
        alphaVideoPacketizer.reset();
        audioPacketizer.reset();
        videoRtpConfig.reset();
        alphaVideoRtpConfig.reset();
        audioRtpConfig.reset();
        videoTrackOpen.store(false);
        alphaVideoTrackOpen.store(false);
        audioTrackOpen.store(false);
        sentFirstKeyframe.store(false);
    }

    void bindDataChannel(const std::shared_ptr<rtc::DataChannel> &channel, const char *origin) {
        if (!channel) {
            return;
        }

        {
            std::lock_guard<std::mutex> lock(dataChannelMutex);
            sendChannel = channel;
        }

        spdlog::info("[WebRTC] DataChannel '{}' attached (origin={})", channel->label(), origin);
        std::weak_ptr<rtc::DataChannel> weakChannel = channel;

        channel->onOpen([this, weakChannel]() {
            auto opened = weakChannel.lock();
            if (!opened) {
                return;
            }
            {
                std::lock_guard<std::mutex> lock(dataChannelMutex);
                if (sendChannel != opened) {
                    return;
                }
                dataChannelOpen.store(true);
            }
            spdlog::info("[WebRTC] DataChannel open: {}", opened->label());
            if (!suppressCallbacks.load(std::memory_order_relaxed) && dataChannelStateCallback) {
                dataChannelStateCallback(true);
            }
        });

        channel->onClosed([this, weakChannel]() {
            auto closed = weakChannel.lock();
            {
                std::lock_guard<std::mutex> lock(dataChannelMutex);
                if (!closed || sendChannel == closed) {
                    dataChannelOpen.store(false);
                }
            }
            if (closed) {
                spdlog::info("[WebRTC] DataChannel closed: {}", closed->label());
            } else {
                spdlog::info("[WebRTC] DataChannel closed");
            }
            if (!suppressCallbacks.load(std::memory_order_relaxed) && dataChannelStateCallback) {
                dataChannelStateCallback(false);
            }
        });

        channel->onError([this](const std::string &error) {
            spdlog::warn("[WebRTC] DataChannel error: {}", error);
        });

        channel->onMessage([this, weakChannel](rtc::message_variant data) {
            auto inbound = weakChannel.lock();
            if (!inbound) {
                return;
            }

            {
                std::lock_guard<std::mutex> lock(dataChannelMutex);
                if (sendChannel != inbound) {
                    return;
                }
            }

            if (suppressCallbacks.load(std::memory_order_relaxed) || !dataMessageCallback) {
                return;
            }

            if (std::holds_alternative<std::string>(data)) {
                dataMessageCallback(std::get<std::string>(data));
                return;
            }

            const auto &binary = std::get<rtc::binary>(data);
            if (!binary.empty()) {
                std::string payload;
                payload.reserve(binary.size());
                for (rtc::byte byte : binary) {
                    payload.push_back(static_cast<char>(std::to_integer<unsigned char>(byte)));
                }
                dataMessageCallback(payload);
            }
        });
    }

    void clearDataChannel(bool detachCallbacks = false) {
        std::shared_ptr<rtc::DataChannel> oldChannel;
        {
            std::lock_guard<std::mutex> lock(dataChannelMutex);
            oldChannel = std::move(sendChannel);
            dataChannelOpen.store(false);
        }

        if (oldChannel) {
            if (detachCallbacks) {
                oldChannel->resetCallbacks();
            }
            oldChannel->close();
        }
        if (!suppressCallbacks.load(std::memory_order_relaxed) && dataChannelStateCallback) {
            dataChannelStateCallback(false);
        }
    }

    bool ensureVideoTrack() {
        if (!pc) {
            return false;
        }
        if (videoTrack) {
            return true;
        }

        spdlog::info("[WebRTC] Adding video track after control-plane bootstrap");

        rtc::Description::Video video("video", rtc::Description::Direction::SendOnly);
        switch (videoCodec) {
            case PeerConfig::VideoCodec::H265:
                spdlog::info("[WebRTC] Configuring video codec: H265");
                video.addH265Codec(kVideoPayloadType);
                break;
            case PeerConfig::VideoCodec::AV1:
                spdlog::info("[WebRTC] Configuring video codec: AV1");
                video.addAV1Codec(kVideoPayloadType);
                break;
            case PeerConfig::VideoCodec::VP9:
                spdlog::info("[WebRTC] Configuring video codec: VP9 (primary, PT={})", kVideoPayloadType);
                video.addVP9Codec(kVideoPayloadType);
                break;
            case PeerConfig::VideoCodec::H264:
            default:
                // Choose H.264 level based on configured publish target to avoid advertising 3.1 for 1080p60.
                const std::string levelId = selectH264ProfileLevelId(
                    configuredVideoWidth,
                    configuredVideoHeight,
                    configuredVideoFps);
                const std::string fmtp =
                    "profile-level-id=" + levelId + ";packetization-mode=1;level-asymmetry-allowed=1";
                video.addH264Codec(kVideoPayloadType, fmtp);
                spdlog::info("[WebRTC] Configuring video codec: H264 ({}x{}@{} fmtp={})",
                             configuredVideoWidth,
                             configuredVideoHeight,
                             configuredVideoFps,
                             fmtp);
                break;
        }
        video.addSSRC(videoSsrc, "gamecapture-video");
        videoTrack = pc->addTrack(video);
        if (!videoTrack) {
            spdlog::error("[WebRTC] Failed to add video track");
            return false;
        }

        videoTrack->onOpen([this]() {
            spdlog::info("[WebRTC] Video track opened");
            videoTrackOpen.store(true);
            trackOpenedTime = std::chrono::steady_clock::now();
        });
        videoTrack->onClosed([this]() {
            spdlog::info("[WebRTC] Video track closed");
            videoTrackOpen.store(false);
        });

        videoRtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(videoSsrc, "gamecapture-video", kVideoPayloadType, kVideoClockRate);
        switch (videoCodec) {
            case PeerConfig::VideoCodec::H265:
                videoPacketizer =
                    std::make_shared<rtc::H265RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, videoRtpConfig);
                break;
            case PeerConfig::VideoCodec::AV1:
                videoPacketizer = std::make_shared<rtc::AV1RtpPacketizer>(
                    rtc::AV1RtpPacketizer::Packetization::TemporalUnit, videoRtpConfig);
                break;
            case PeerConfig::VideoCodec::VP9:
                videoPacketizer.reset();
                break;
            case PeerConfig::VideoCodec::H264:
            default:
                videoPacketizer =
                    std::make_shared<rtc::H264RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, videoRtpConfig);
                break;
        }
        if (videoCodec == PeerConfig::VideoCodec::VP9) {
            spdlog::info("[WebRTC] Using explicit RTP packetization for VP9 primary video");
        } else {
            auto videoReporter = std::make_shared<rtc::RtcpSrReporter>(videoRtpConfig);
            auto videoNack = std::make_shared<rtc::RtcpNackResponder>();
            auto videoPli = std::make_shared<rtc::PliHandler>([this]() {
                spdlog::info("[WebRTC] Received PLI/FIR - keyframe requested by receiver");
                if (!suppressCallbacks.load(std::memory_order_relaxed) && keyframeCallback) {
                    keyframeCallback();
                }
            });
            videoPacketizer->addToChain(videoReporter);
            videoPacketizer->addToChain(videoNack);
            videoPacketizer->addToChain(videoPli);
            videoTrack->setMediaHandler(videoPacketizer);
        }
        if (videoTrack->isOpen()) {
            videoTrackOpen.store(true);
            trackOpenedTime = std::chrono::steady_clock::now();
            spdlog::info("[WebRTC] Video track already open after addTrack");
        }
        return true;
    }

    // Alpha must remain the second video section. The OBS VDO.Ninja plugin recognizes either
    // that video-section ordering or the explicit "video-alpha" MID; audio/data m-lines may
    // already exist when a capable receiver requests alpha during renegotiation.
    bool ensureAlphaVideoTrack() {
        if (!pc || !enableAlphaTrack) {
            return false;
        }
        if (alphaVideoTrack) {
            return true;
        }

        spdlog::info("[WebRTC] Adding VP9 alpha video track (PT={})", kAlphaVideoPayloadType);
        rtc::Description::Video alpha("video-alpha", rtc::Description::Direction::SendOnly);
        alpha.addVP9Codec(kAlphaVideoPayloadType);
        alpha.addSSRC(alphaVideoSsrc, "gamecapture-alpha");
        alphaVideoTrack = pc->addTrack(alpha);
        if (!alphaVideoTrack) {
            spdlog::error("[WebRTC] Failed to add VP9 alpha video track");
            return false;
        }

        alphaVideoTrack->onOpen([this]() {
            spdlog::info("[WebRTC] Alpha video track opened");
            alphaVideoTrackOpen.store(true);
        });
        alphaVideoTrack->onClosed([this]() {
            spdlog::info("[WebRTC] Alpha video track closed");
            alphaVideoTrackOpen.store(false);
        });

        alphaVideoRtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
            alphaVideoSsrc, "gamecapture-alpha", kAlphaVideoPayloadType, kVideoClockRate);
        alphaVideoPacketizer.reset();
        spdlog::info("[WebRTC] Using explicit RTP packetization for VP9 alpha video");

        if (alphaVideoTrack->isOpen()) {
            alphaVideoTrackOpen.store(true);
            spdlog::info("[WebRTC] Alpha video track already open after addTrack");
        }
        return true;
    }

    bool ensureAudioTrack() {
        if (!pc) {
            return false;
        }
        if (audioTrack) {
            return true;
        }

        spdlog::info("[WebRTC] Adding audio track after control-plane bootstrap");
        rtc::Description::Audio audio("audio", rtc::Description::Direction::SendOnly);
        audio.addOpusCodec(kAudioPayloadType);
        audio.addSSRC(audioSsrc, "gamecapture-audio");
        audioTrack = pc->addTrack(audio);
        if (!audioTrack) {
            spdlog::error("[WebRTC] Failed to add audio track");
            return false;
        }

        audioTrack->onOpen([this]() {
            spdlog::info("[WebRTC] Audio track opened");
            audioTrackOpen.store(true);
        });
        audioTrack->onClosed([this]() {
            spdlog::info("[WebRTC] Audio track closed");
            audioTrackOpen.store(false);
        });

        audioRtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(audioSsrc, "gamecapture-audio", kAudioPayloadType, kAudioClockRate);
        audioPacketizer = std::make_shared<rtc::OpusRtpPacketizer>(audioRtpConfig);
        auto audioReporter = std::make_shared<rtc::RtcpSrReporter>(audioRtpConfig);
        auto audioNack = std::make_shared<rtc::RtcpNackResponder>();
        audioPacketizer->addToChain(audioReporter);
        audioPacketizer->addToChain(audioNack);
        audioTrack->setMediaHandler(audioPacketizer);
        if (audioTrack->isOpen()) {
            audioTrackOpen.store(true);
            spdlog::info("[WebRTC] Audio track already open after addTrack");
        }
        return true;
    }

    void setupBootstrapTransport() {
        clearDataChannel();
        dataChannelOpen.store(false);
        bindDataChannel(pc->createDataChannel("sendChannel"), "local");
    }
};

WebRtcClient::WebRtcClient() : impl_(std::make_unique<Impl>()) {}
WebRtcClient::~WebRtcClient() { shutdown(); }

bool WebRtcClient::initialize(const PeerConfig &config) {
    impl_->videoCodec = config.videoCodec;
    impl_->enableAlphaTrack = config.enableAlphaTrack;
    impl_->enableDataChannel = config.enableDataChannel;
    impl_->configuredVideoWidth = std::max(1, config.videoWidth);
    impl_->configuredVideoHeight = std::max(1, config.videoHeight);
    impl_->configuredVideoFps = std::max(1, config.videoFps);
    impl_->iceMode = config.iceMode;

    rtc::Configuration rtcConfig;
    for (const auto &ice : config.iceServers) {
        rtc::IceServer server(ice.url);
        if (!ice.username.empty()) {
            server.username = ice.username;
        }
        if (!ice.credential.empty()) {
            server.password = ice.credential;
        }
        rtcConfig.iceServers.emplace_back(std::move(server));
    }
    if (config.iceMode == IceMode::Relay) {
        rtcConfig.iceTransportPolicy = rtc::TransportPolicy::Relay;
    }
    // libdatachannel skips SRTP transport setup for datachannel-only sessions
    // unless this is forced up front, which breaks late addTrack renegotiation.
    rtcConfig.forceMediaTransport = true;
    impl_->config = rtcConfig;
    impl_->suppressCallbacks.store(false, std::memory_order_relaxed);
    impl_->resetRemoteCandidateState();

    impl_->pc = std::make_shared<rtc::PeerConnection>(rtcConfig);
    impl_->resetMediaState();

    impl_->pc->onStateChange([this](rtc::PeerConnection::State state) {
        const char* stateStr = "unknown";
        ConnectionState mapped = ConnectionState::Disconnected;
        if (state == rtc::PeerConnection::State::Connecting) {
            mapped = ConnectionState::Connecting;
            stateStr = "connecting";
        } else if (state == rtc::PeerConnection::State::Connected) {
            mapped = ConnectionState::Connected;
            stateStr = "connected";
        } else if (state == rtc::PeerConnection::State::Failed) {
            mapped = ConnectionState::Failed;
            stateStr = "failed";
        } else if (state == rtc::PeerConnection::State::Closed) {
            mapped = ConnectionState::Closed;
            stateStr = "closed";
        } else if (state == rtc::PeerConnection::State::Disconnected) {
            stateStr = "disconnected";
        } else if (state == rtc::PeerConnection::State::New) {
            stateStr = "new";
        }
        spdlog::info("[WebRTC] PeerConnection state: {}", stateStr);
        impl_->state.store(mapped);
        if (!impl_->suppressCallbacks.load(std::memory_order_relaxed) && impl_->stateCallback) {
            impl_->stateCallback(mapped);
        }
    });

    impl_->pc->onLocalCandidate([this](rtc::Candidate candidate) {
        if (!candidateAllowedForMode(candidate.candidate(), impl_->iceMode)) {
            spdlog::info("[WebRTC] Dropping local ICE candidate due to mode={}: {}",
                         iceModeName(impl_->iceMode),
                         candidate.candidate());
            return;
        }
        if (!impl_->suppressCallbacks.load(std::memory_order_relaxed) && impl_->iceCallback) {
            impl_->iceCallback(candidate.candidate(), candidate.mid(), 0);
        }
    });

    impl_->pc->onLocalDescription([this](rtc::Description desc) {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        impl_->localDescription = std::string(desc);
        spdlog::debug("[WebRTC] Local description set");
    });

    impl_->pc->onGatheringStateChange([this](rtc::PeerConnection::GatheringState state) {
        const char* stateStr = "unknown";
        if (state == rtc::PeerConnection::GatheringState::New) stateStr = "new";
        else if (state == rtc::PeerConnection::GatheringState::InProgress) stateStr = "in_progress";
        else if (state == rtc::PeerConnection::GatheringState::Complete) stateStr = "complete";
        spdlog::info("[WebRTC] ICE gathering state: {}", stateStr);
        if (state == rtc::PeerConnection::GatheringState::Complete) {
            impl_->gatheringComplete.store(true);
        }
    });

    impl_->pc->onDataChannel([this](std::shared_ptr<rtc::DataChannel> channel) {
        if (!channel) {
            return;
        }
        impl_->bindDataChannel(channel, "remote");
    });

    if (impl_->enableDataChannel) {
        if (config.initialVideo && !impl_->ensureVideoTrack()) {
            return false;
        }
        if (config.initialVideo && config.initialAlpha && impl_->enableAlphaTrack && !impl_->ensureAlphaVideoTrack()) {
            return false;
        }
        if (config.initialAudio && !impl_->ensureAudioTrack()) {
            return false;
        }
        impl_->setupBootstrapTransport();
    } else {
        impl_->resetMediaState();
        impl_->dataChannelOpen.store(false);
        impl_->clearDataChannel();
    }
    return true;
}

void WebRtcClient::shutdown() {
    impl_->suppressCallbacks.store(true, std::memory_order_relaxed);
    impl_->clearDataChannel();
    if (impl_->pc) {
        impl_->pc->close();
        impl_->pc.reset();
    }
    impl_->resetMediaState();
    impl_->resetRemoteCandidateState();
}

bool WebRtcClient::resetPeerConnection(bool initialVideo, bool initialAudio, bool initialAlpha) {
    spdlog::info("[WebRTC] Resetting PeerConnection");
    const bool previousSuppress = impl_->suppressCallbacks.exchange(true, std::memory_order_relaxed);

    // Close old connection
    impl_->clearDataChannel(true);
    if (impl_->pc) {
        impl_->pc->resetCallbacks();
        impl_->pc->close();
        impl_->pc.reset();
    }
    impl_->resetMediaState();
    impl_->resetRemoteCandidateState();
    impl_->gatheringComplete.store(false);
    {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        impl_->localDescription.clear();
    }

    // Create fresh PeerConnection
    impl_->pc = std::make_shared<rtc::PeerConnection>(impl_->config);
    impl_->suppressCallbacks.store(previousSuppress, std::memory_order_relaxed);

    impl_->pc->onStateChange([this](rtc::PeerConnection::State state) {
        const char* stateStr = "unknown";
        ConnectionState mapped = ConnectionState::Disconnected;
        if (state == rtc::PeerConnection::State::Connecting) {
            mapped = ConnectionState::Connecting;
            stateStr = "connecting";
        } else if (state == rtc::PeerConnection::State::Connected) {
            mapped = ConnectionState::Connected;
            stateStr = "connected";
        } else if (state == rtc::PeerConnection::State::Failed) {
            mapped = ConnectionState::Failed;
            stateStr = "failed";
        } else if (state == rtc::PeerConnection::State::Closed) {
            mapped = ConnectionState::Closed;
            stateStr = "closed";
        } else if (state == rtc::PeerConnection::State::Disconnected) {
            stateStr = "disconnected";
        } else if (state == rtc::PeerConnection::State::New) {
            stateStr = "new";
        }
        spdlog::info("[WebRTC] PeerConnection state: {}", stateStr);
        impl_->state.store(mapped);
        if (!impl_->suppressCallbacks.load(std::memory_order_relaxed) && impl_->stateCallback) {
            impl_->stateCallback(mapped);
        }
    });

    impl_->pc->onLocalCandidate([this](rtc::Candidate candidate) {
        if (!candidateAllowedForMode(candidate.candidate(), impl_->iceMode)) {
            spdlog::info("[WebRTC] Dropping local ICE candidate due to mode={}: {}",
                         iceModeName(impl_->iceMode),
                         candidate.candidate());
            return;
        }
        if (!impl_->suppressCallbacks.load(std::memory_order_relaxed) && impl_->iceCallback) {
            impl_->iceCallback(candidate.candidate(), candidate.mid(), 0);
        }
    });

    impl_->pc->onLocalDescription([this](rtc::Description desc) {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        impl_->localDescription = std::string(desc);
    });

    impl_->pc->onGatheringStateChange([this](rtc::PeerConnection::GatheringState state) {
        if (state == rtc::PeerConnection::GatheringState::Complete) {
            impl_->gatheringComplete.store(true);
        }
    });

    impl_->pc->onDataChannel([this](std::shared_ptr<rtc::DataChannel> channel) {
        if (!channel) {
            return;
        }
        impl_->bindDataChannel(channel, "remote");
    });

    if (impl_->enableDataChannel) {
        if (initialVideo && !impl_->ensureVideoTrack()) {
            return false;
        }
        if (initialVideo && initialAlpha && impl_->enableAlphaTrack && !impl_->ensureAlphaVideoTrack()) {
            return false;
        }
        if (initialAudio && !impl_->ensureAudioTrack()) {
            return false;
        }
        impl_->setupBootstrapTransport();
    } else {
        impl_->resetMediaState();
        impl_->dataChannelOpen.store(false);
        impl_->clearDataChannel();
    }
    spdlog::info("[WebRTC] PeerConnection reset complete");
    return true;
}

void WebRtcClient::setVideoCodec(PeerConfig::VideoCodec codec, bool enableAlphaTrack) {
    impl_->videoCodec = codec;
    impl_->enableAlphaTrack = enableAlphaTrack;
}


bool WebRtcClient::setRemoteDescription(const std::string &sdp, const std::string &type) {
    if (!impl_->pc) {
        return false;
    }
    // Log the received SDP for debugging
    spdlog::info("[WebRTC] === SDP {} START ===", type);
    spdlog::info("{}", sdp);
    spdlog::info("[WebRTC] === SDP {} END ===", type);

    rtc::Description::Type descType = rtc::Description::Type::Offer;
    if (type == "answer") {
        descType = rtc::Description::Type::Answer;
    }
    try {
        impl_->pc->setRemoteDescription(rtc::Description(sdp, descType));
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to set remote {} description: {}", type, e.what());
        return false;
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to set remote {} description", type);
        return false;
    }
    impl_->remoteDescriptionSet.store(true, std::memory_order_relaxed);
    impl_->drainPendingRemoteCandidates();
    return true;
}

std::string WebRtcClient::createOffer() {
    if (!impl_->pc) {
        return {};
    }
    impl_->resetRemoteCandidateState();
    {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        impl_->localDescription.clear();
    }
    impl_->gatheringComplete.store(false);

    spdlog::info("[WebRTC] Creating offer with trickle ICE enabled...");
    impl_->pc->setLocalDescription(rtc::Description::Type::Offer);

    auto hasFreshLocalDescription = [this]() {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        return !impl_->localDescription.empty();
    };

    // Wait only for the initial local description so we can send the SDP promptly and trickle candidates.
    auto start = std::chrono::steady_clock::now();
    while (!hasFreshLocalDescription()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (std::chrono::steady_clock::now() - start > std::chrono::seconds(2)) {
            spdlog::warn("[WebRTC] Timed out waiting for initial local description; proceeding with current SDP state");
            break;
        }
    }

    // Return whatever SDP is currently available; remaining ICE candidates will trickle separately.
    std::string sdp;
    {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        sdp = impl_->localDescription;
    }
    if (sdp.empty()) {
        auto desc = impl_->pc->localDescription();
        if (desc) {
            sdp = std::string(*desc);
        }
    }

    if (!sdp.empty()) {
        sdp = filterSessionDescriptionForMode(sdp, impl_->iceMode);
        spdlog::info("[WebRTC] Offer created with {} bytes, gathering complete={}",
                     sdp.size(), impl_->gatheringComplete.load());
        // Log full SDP for debugging
        spdlog::info("[WebRTC] === SDP OFFER START ===");
        spdlog::info("{}", sdp);
        spdlog::info("[WebRTC] === SDP OFFER END ===");
        return sdp;
    }

    std::lock_guard<std::mutex> lock(impl_->descMutex);
    if (!impl_->localDescription.empty()) {
        return filterSessionDescriptionForMode(impl_->localDescription, impl_->iceMode);
    }
    return impl_->localDescription;
}

std::string WebRtcClient::createAnswer(const std::string &offer) {
    if (!impl_->pc) {
        return {};
    }
    {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        impl_->localDescription.clear();
    }
    try {
        impl_->pc->setRemoteDescription(rtc::Description(offer, rtc::Description::Type::Offer));
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to set remote offer description: {}", e.what());
        return {};
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to set remote offer description");
        return {};
    }
    impl_->remoteDescriptionSet.store(true, std::memory_order_relaxed);
    impl_->drainPendingRemoteCandidates();
    impl_->pc->setLocalDescription(rtc::Description::Type::Answer);

    auto hasFreshLocalDescription = [this]() {
        std::lock_guard<std::mutex> lock(impl_->descMutex);
        return !impl_->localDescription.empty();
    };

    auto start = std::chrono::steady_clock::now();
    while (!hasFreshLocalDescription()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (std::chrono::steady_clock::now() - start > std::chrono::seconds(5)) {
            break;
        }
    }
    return impl_->localDescription;
}

bool WebRtcClient::addRemoteCandidate(const std::string &candidate, const std::string &mid, int mlineIndex) {
    if (!impl_->pc) {
        spdlog::warn("[WebRTC] Dropping remote ICE candidate because peer connection is not initialized");
        return false;
    }
    Impl::RemoteCandidate remote{candidate, mid, mlineIndex};
    if (!impl_->remoteDescriptionSet.load(std::memory_order_relaxed)) {
        return impl_->queueRemoteCandidate(std::move(remote));
    }
    try {
        return impl_->tryAddRemoteCandidate(remote);
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to add remote ICE candidate: {}", e.what());
        return false;
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to add remote ICE candidate");
        return false;
    }
}

void WebRtcClient::prepareForShutdown() {
    impl_->suppressCallbacks.store(true, std::memory_order_relaxed);
}

void WebRtcClient::setIceCandidateCallback(IceCandidateCallback cb) {
    impl_->iceCallback = std::move(cb);
}

void WebRtcClient::setStateCallback(StateCallback cb) {
    impl_->stateCallback = std::move(cb);
}

void WebRtcClient::setKeyframeRequestCallback(KeyframeRequestCallback cb) {
    impl_->keyframeCallback = std::move(cb);
}

void WebRtcClient::setDataMessageCallback(DataMessageCallback cb) {
    impl_->dataMessageCallback = std::move(cb);
}

void WebRtcClient::setDataChannelStateCallback(DataChannelStateCallback cb) {
    impl_->dataChannelStateCallback = std::move(cb);
}

MediaPlanChange WebRtcClient::ensureMediaTracks(bool enableVideo, bool enableAudio, bool enableAlpha) {
    MediaPlanChange change;
    if (!impl_->pc) {
        return change;
    }

    if (enableVideo && !impl_->videoTrack && impl_->ensureVideoTrack()) {
        change.changed = true;
        change.videoAdded = true;
    }
    // Keep alpha after the primary video section; absolute SDP m-line index is not significant.
    if (enableVideo && enableAlpha && impl_->enableAlphaTrack && !impl_->alphaVideoTrack && impl_->ensureAlphaVideoTrack()) {
        change.changed = true;
        change.alphaAdded = true;
    }
    if (enableAudio && !impl_->audioTrack && impl_->ensureAudioTrack()) {
        change.changed = true;
        change.audioAdded = true;
    }

    if (change.changed) {
        spdlog::info("[WebRTC] Applied media plan: videoAdded={} alphaAdded={} audioAdded={}",
                     change.videoAdded,
                     change.alphaAdded,
                     change.audioAdded);
    }
    return change;
}

bool WebRtcClient::sendVideo(const EncodedVideoPacket &packet) {
    if (!impl_->videoTrack || !impl_->videoTrack->isOpen()) {
        return false;
    }
    if (packet.data.empty()) {
        return false;
    }

    // Log first packet info (with GOP=1, every frame is a keyframe)
    if (!impl_->sentFirstKeyframe.load()) {
        spdlog::info("[WebRTC] Starting video transmission, isKeyframe={}", packet.isKeyframe);
        impl_->sentFirstKeyframe.store(true);
    }

    // Update RTP timestamp from packet PTS
    // H.264 RTP uses 90kHz clock. If PTS is in 100ns units (MF timestamps), convert accordingly.
    // MF timestamps: 100ns units, so PTS / 10000 = ms, * 90 = RTP ticks
    // Or: PTS * 90 / 10000 = PTS * 9 / 1000
    uint32_t rtpTimestamp = static_cast<uint32_t>((packet.pts * 9) / 1000);
    bool sent = false;
    if (impl_->videoCodec == PeerConfig::VideoCodec::VP9) {
        sent = sendVp9FrameRtp(
            impl_->videoTrack, impl_->videoSequenceNumber, rtpTimestamp, impl_->videoSsrc, kVideoPayloadType, packet.data);
    } else {
        if (!impl_->videoRtpConfig) {
            return false;
        }
        impl_->videoRtpConfig->timestamp = rtpTimestamp;
        rtc::binary binaryPayload = toBinary(packet.data);
        try {
            impl_->videoTrack->send(binaryPayload);
            sent = true;
        } catch (const std::exception &e) {
            spdlog::warn("[WebRTC] Failed to send video packet: {}", e.what());
        } catch (...) {
            spdlog::warn("[WebRTC] Failed to send video packet");
        }
    }
    if (!sent) {
        return false;
    }
    return true;
}

bool WebRtcClient::sendAlphaVideo(const EncodedVideoPacket &packet) {
    if (!impl_->alphaVideoTrack || !impl_->alphaVideoTrack->isOpen()) {
        return false;
    }
    if (packet.data.empty()) {
        return false;
    }
    uint32_t rtpTimestamp = static_cast<uint32_t>((packet.pts * 9) / 1000);
    if (!sendVp9FrameRtp(impl_->alphaVideoTrack,
                         impl_->alphaVideoSequenceNumber,
                         rtpTimestamp,
                         impl_->alphaVideoSsrc,
                         kAlphaVideoPayloadType,
                         packet.data)) {
        return false;
    }
    return true;
}

bool WebRtcClient::sendAudio(const EncodedAudioPacket &packet) {
    if (!impl_->audioTrack || !impl_->audioTrack->isOpen() || !impl_->audioRtpConfig) {
        return false;
    }

    // Update RTP timestamp from packet PTS
    // Opus uses 48kHz clock. MF timestamps are in 100ns units.
    // PTS * 48000 / 10000000 = PTS * 48 / 10000 = PTS * 0.0048
    uint32_t rtpTimestamp = static_cast<uint32_t>((packet.pts * 48) / 10000);
    impl_->audioRtpConfig->timestamp = rtpTimestamp;

    // Send raw Opus data to the track - the media handler chain will packetize it
    rtc::binary binaryPayload = toBinary(packet.data);
    try {
        impl_->audioTrack->send(binaryPayload);
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to send audio packet: {}", e.what());
        return false;
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to send audio packet");
        return false;
    }
    return true;
}

bool WebRtcClient::sendDataMessage(const std::string &message) {
    std::shared_ptr<rtc::DataChannel> channel;
    {
        std::lock_guard<std::mutex> lock(impl_->dataChannelMutex);
        channel = impl_->sendChannel;
    }

    if (!channel || !channel->isOpen()) {
        return false;
    }
    try {
        return channel->send(message);
    } catch (const std::exception &e) {
        spdlog::warn("[WebRTC] Failed to send data message: {}", e.what());
        return false;
    } catch (...) {
        spdlog::warn("[WebRTC] Failed to send data message");
        return false;
    }
}

bool WebRtcClient::isDataChannelOpen() const {
    return impl_->dataChannelOpen.load();
}

bool WebRtcClient::hasActiveVideoTrack() const {
    if (!impl_->videoTrack) {
        impl_->videoTrackOpen.store(false);
        return false;
    }
    const bool open = impl_->videoTrack->isOpen();
    impl_->videoTrackOpen.store(open);
    return open;
}

bool WebRtcClient::hasActiveAlphaVideoTrack() const {
    if (!impl_->alphaVideoTrack) {
        impl_->alphaVideoTrackOpen.store(false);
        return false;
    }
    const bool open = impl_->alphaVideoTrack->isOpen();
    impl_->alphaVideoTrackOpen.store(open);
    return open;
}

bool WebRtcClient::hasActiveAudioTrack() const {
    if (!impl_->audioTrack) {
        impl_->audioTrackOpen.store(false);
        return false;
    }
    const bool open = impl_->audioTrack->isOpen();
    impl_->audioTrackOpen.store(open);
    return open;
}

bool WebRtcClient::hasConfiguredVideoTrack() const {
    return static_cast<bool>(impl_->videoTrack);
}

bool WebRtcClient::hasConfiguredAudioTrack() const {
    return static_cast<bool>(impl_->audioTrack);
}

}  // namespace versus::webrtc
