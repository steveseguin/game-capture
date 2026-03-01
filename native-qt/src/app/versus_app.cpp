#include "versus/app/versus_app.h"

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <thread>

namespace versus::app {
namespace {

constexpr int64_t kStaleResendMs = 350;
constexpr int64_t kPeriodicKeyframeMs = 2500;
constexpr int64_t kDataInfoIntervalMs = 2000;
constexpr int64_t kRoomInitTimeoutMs = 7000;
constexpr int kLqWidth = 640;
constexpr int kLqHeight = 360;
constexpr int kLqFps = 30;
constexpr int kLqBitrateKbps = 2000;

int64_t steadyNowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

std::string toLowerCopy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

bool isStreamIdInUseAlert(const std::string &messageLower) {
    return messageLower.find("streamid-already-published") != std::string::npos ||
           messageLower.find("already in use") != std::string::npos ||
           messageLower.find("already has this stream id") != std::string::npos ||
           messageLower.find("already has this streamid") != std::string::npos ||
           messageLower.find("duplicate stream") != std::string::npos ||
           ((messageLower.find("stream") != std::string::npos ||
             messageLower.find("stream id") != std::string::npos ||
             messageLower.find("streamid") != std::string::npos) &&
            (messageLower.find("in use") != std::string::npos ||
             messageLower.find("already has") != std::string::npos));
}

bool jsonBoolLike(const nlohmann::json &value, bool defaultValue) {
    if (value.is_boolean()) {
        return value.get<bool>();
    }
    if (value.is_number_integer()) {
        return value.get<int>() != 0;
    }
    if (value.is_string()) {
        const std::string lower = toLowerCopy(value.get<std::string>());
        if (lower == "1" || lower == "true" || lower == "yes" || lower == "on") {
            return true;
        }
        if (lower == "0" || lower == "false" || lower == "no" || lower == "off") {
            return false;
        }
    }
    return defaultValue;
}

const char *videoCodecName(video::VideoCodec codec) {
    switch (codec) {
        case video::VideoCodec::H264:
            return "H.264";
        case video::VideoCodec::H265:
            return "H.265";
        case video::VideoCodec::VP8:
            return "VP8";
        case video::VideoCodec::VP9:
            return "VP9";
        case video::VideoCodec::AV1:
            return "AV1";
        default:
            return "Unknown";
    }
}

webrtc::PeerConfig::VideoCodec toPeerVideoCodec(video::VideoCodec codec) {
    switch (codec) {
        case video::VideoCodec::H265:
            return webrtc::PeerConfig::VideoCodec::H265;
        case video::VideoCodec::AV1:
            return webrtc::PeerConfig::VideoCodec::AV1;
        case video::VideoCodec::H264:
        case video::VideoCodec::VP8:
        case video::VideoCodec::VP9:
        default:
            return webrtc::PeerConfig::VideoCodec::H264;
    }
}

}  // namespace

VersusApp::VersusApp() = default;
VersusApp::~VersusApp() { shutdown(); }

bool VersusApp::initialize() {
    setupCallbacks();
    return true;
}

void VersusApp::shutdown() {
    stopLive();
    stopCapture();
}

std::vector<versus::video::WindowInfo> VersusApp::listWindows() {
    return windowCapture_.getWindows();
}

bool VersusApp::startCapture(const std::string &windowId) {
    if (capturing_) {
        stopCapture();
    }

    audioPts100ns_.store(0);
    audioLevelRms_.store(0.0f);
    audioPeak_.store(0.0f);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(false);
    lastVideoSendMs_.store(0);
    lastKeyframeSendMs_.store(0);
    {
        std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
        hasLatestVideoFrame_ = false;
        latestVideoFrame_ = video::CapturedFrame{};
    }
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        lqEncoderInitialized_.store(false, std::memory_order_relaxed);
    }

    selectedWindowId_ = windowId;
    if (!windowCapture_.startCapture(windowId, 1920, 1080, 60)) {
        return false;
    }

    if (!selectedWindowId_.empty()) {
        auto windows = windowCapture_.getWindows();
        for (const auto &info : windows) {
            if (info.id != selectedWindowId_) {
                continue;
            }

            audioCapture_.StartStreamCapture(info.processId, [this](versus::audio::StreamChunk &&chunk) {
                if (!live_) {
                    return;
                }

                float peak = 0.0f;
                double sumSquares = 0.0;
                for (float sample : chunk.samples) {
                    const float absSample = std::abs(sample);
                    peak = std::max(peak, absSample);
                    sumSquares += static_cast<double>(sample) * static_cast<double>(sample);
                }
                const float rms = chunk.samples.empty()
                    ? 0.0f
                    : static_cast<float>(std::sqrt(sumSquares / static_cast<double>(chunk.samples.size())));
                const float prevRms = audioLevelRms_.load(std::memory_order_relaxed);
                const float smoothedRms = (prevRms * 0.75f) + (rms * 0.25f);
                audioLevelRms_.store(std::clamp(smoothedRms, 0.0f, 1.0f), std::memory_order_relaxed);

                const float prevPeak = audioPeak_.load(std::memory_order_relaxed);
                const float decayedPeak = std::max(peak, prevPeak * 0.90f);
                audioPeak_.store(std::clamp(decayedPeak, 0.0f, 1.0f), std::memory_order_relaxed);

                const uint32_t channels = std::max<uint32_t>(1, chunk.channels);
                const uint32_t sampleRate = std::max<uint32_t>(1, chunk.sampleRate);
                const size_t frames = chunk.samples.size() / channels;
                const int64_t chunkDuration100ns =
                    static_cast<int64_t>(frames) * 10000000LL / static_cast<int64_t>(sampleRate);
                const int64_t pts = audioPts100ns_.fetch_add(chunkDuration100ns);
                if (!hasAnyActiveAudioTrack()) {
                    return;
                }

                opusEncoder_.encode(chunk.samples,
                                    static_cast<int>(sampleRate),
                                    static_cast<int>(channels),
                                    pts);
            });
            break;
        }
    }

    video::EncoderConfig config = videoConfig_;
    if (config.width == 0 || config.height == 0) {
        config.width = 1920;
        config.height = 1080;
        config.frameRate = 60;
        config.bitrate = 12000;
    }
    if (!videoEncoder_.initialize(config)) {
        windowCapture_.stopCapture();
        return false;
    }
    spdlog::info("[App] Video encoder active: {} (hardware={})",
                 videoEncoder_.activeEncoderName(), videoEncoder_.isHardwareEncoderActive());

    audio::AudioEncoderConfig audioConfig;
    audioConfig.sampleRate = 48000;
    audioConfig.channels = 2;
    audioConfig.bitrate = 192;
    opusEncoder_.initialize(audioConfig);

    windowCapture_.setFrameCallback([this](const video::CapturedFrame &frame) {
        static int frameCount = 0;
        static auto lastLog = std::chrono::steady_clock::now();
        frameCount++;

        {
            std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
            latestVideoFrame_ = frame;
            hasLatestVideoFrame_ = true;
        }

        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::seconds>(now - lastLog).count() >= 5) {
            spdlog::info("[Frame] Received {} frames in last 5s, live={}", frameCount, live_);
            frameCount = 0;
            lastLog = now;
        }

        if (!live_) {
            return;
        }

        const bool trackActive = hasAnyActiveVideoTrack();
        const bool wasTrackActive = videoTrackActive_.exchange(trackActive);
        if (!trackActive) {
            static auto lastNoViewerLog = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::seconds>(now - lastNoViewerLog).count() >= 5) {
                spdlog::debug("[Frame] No active viewer track yet; skipping encode");
                lastNoViewerLog = now;
            }
            return;
        }

        if (!wasTrackActive) {
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            spdlog::info("[Frame] Video track became active; forcing keyframe on next frame");
        }

        if (!encodeAndSendVideoFrame(frame, false)) {
            static int sendFailCount = 0;
            if (++sendFailCount % 100 == 1) {
                spdlog::warn("[Frame] encodeAndSendVideoFrame failed (count={})", sendFailCount);
            }
        }
    });

    capturing_ = true;
    startVideoMaintenanceThread();
    return true;
}

void VersusApp::stopCapture() {
    if (!capturing_) {
        return;
    }

    stopVideoMaintenanceThread();
    windowCapture_.stopCapture();
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        videoEncoder_.shutdown();
        shutdownLqEncoderLocked();
    }
    audioCapture_.StopCapture();
    opusEncoder_.shutdown();
    audioLevelRms_.store(0.0f, std::memory_order_relaxed);
    audioPeak_.store(0.0f, std::memory_order_relaxed);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(false);
    lastVideoSendMs_.store(0);
    lastKeyframeSendMs_.store(0);
    capturing_ = false;
}

void VersusApp::setSelectedWindow(const std::string &windowId) {
    selectedWindowId_ = windowId;
}

void VersusApp::setVideoConfig(const versus::video::EncoderConfig &config) {
    videoConfig_ = config;
}

bool VersusApp::goLive(const StartOptions &options) {
    if (live_) {
        return true;
    }

    startOptions_ = options;
    stopRequested_.store(false);
    reconnecting_.store(false);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(true);
    lastVideoSendMs_.store(0);
    lastKeyframeSendMs_.store(0);
    lastRelayWarningMs_.store(0, std::memory_order_relaxed);
    lastPacketLossWarningMs_.store(0, std::memory_order_relaxed);
    pliWindowStartMs_.store(0, std::memory_order_relaxed);
    pliWindowCount_.store(0, std::memory_order_relaxed);
    lastCpuWarningMs_.store(0, std::memory_order_relaxed);
    softwareOverloadSamples_.store(0, std::memory_order_relaxed);

    room_ = options.room;
    password_ = options.password;
    salt_ = options.salt.empty() ? "vdo.ninja" : options.salt;
    maxViewers_.store(std::max(0, options.maxViewers), std::memory_order_relaxed);
    remoteControlEnabled_.store(options.remoteControlEnabled, std::memory_order_relaxed);
    remoteControlToken_ = options.remoteControlToken;
    roomCodecWarningEmitted_ = false;

    clearPeerSessions();
    setupSignalingCallbacks();

    if (!enforceRoomCodecLock()) {
        return false;
    }

    spdlog::info("[App] Connecting to signaling server: {}", options.server);
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        if (!signaling_.connect(options.server)) {
            spdlog::error("[App] Failed to connect to signaling server");
            return false;
        }
    }
    spdlog::info("[App] Connected to signaling server");

    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        signaling_.setPassword(password_);
        if (password_ == "false" || password_ == "0" || password_ == "off") {
            spdlog::info("[App] Encryption disabled");
            signaling_.disableEncryption();
        }
    }

    if (!room_.empty()) {
        spdlog::info("[App] Joining room: {}", room_);
        signaling::RoomConfig roomConfig;
        roomConfig.room = room_;
        roomConfig.password = password_;
        roomConfig.label = options.label;
        roomConfig.streamId = options.streamId;
        roomConfig.salt = salt_;
        {
            std::lock_guard<std::mutex> lock(signalingOpsMutex_);
            if (!signaling_.joinRoom(roomConfig)) {
                spdlog::error("[App] Failed to join room");
                signaling_.disconnect();
                return false;
            }
        }
    }

    if (options.streamId.empty()) {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        streamId_ = signaling_.getStreamId();
    } else {
        streamId_ = options.streamId;
    }
    if (streamId_.empty()) {
        streamId_ = "gamecapture_" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
    }

    if (remoteControlEnabled_.load(std::memory_order_relaxed) && remoteControlToken_.empty()) {
        if (!password_.empty() && password_ != "false" && password_ != "0" && password_ != "off") {
            remoteControlToken_ = password_;
        } else {
            remoteControlToken_ = streamId_;
        }
    }
    if (remoteControlEnabled_.load(std::memory_order_relaxed)) {
        spdlog::info("[App] Remote control enabled (tokenLength={})", remoteControlToken_.size());
    }

    spdlog::info("[App] Publishing stream: {}", streamId_);
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        if (!signaling_.publish(streamId_, options.label)) {
            spdlog::error("[App] Failed to publish stream");
            signaling_.disconnect();
            return false;
        }
    }

    std::string viewUrl;
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        viewUrl = signaling_.getViewUrl();
    }
    spdlog::info("[App] ========================================");
    spdlog::info("[App] VIEW URL: {}", viewUrl);
    spdlog::info("[App] ========================================");

    live_ = true;
    startVideoMaintenanceThread();
    return true;
}

void VersusApp::stopLive() {
    if (!live_) {
        stopRequested_.store(true);
        reconnecting_.store(false);
        videoTrackActive_.store(false);
        pendingGlobalKeyframe_.store(false);
        stopSignalingRecoveryThread();
        stopVideoMaintenanceThread();
        clearPeerSessions();
        return;
    }

    stopRequested_.store(true);
    reconnecting_.store(false);
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        signaling_.unpublish();
        signaling_.disconnect();
    }
    stopSignalingRecoveryThread();
    stopVideoMaintenanceThread();
    clearPeerSessions();
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(false);
    live_ = false;
}

std::string VersusApp::getShareLink() const {
    std::lock_guard<std::mutex> lock(signalingOpsMutex_);
    return signaling_.getViewUrl();
}

void VersusApp::onRuntimeEvent(RuntimeEventCallback cb) {
    std::lock_guard<std::mutex> lock(runtimeEventMutex_);
    runtimeEventCallback_ = std::move(cb);
}

void VersusApp::emitRuntimeEvent(const std::string &message, bool fatal) {
    RuntimeEventCallback callback;
    {
        std::lock_guard<std::mutex> lock(runtimeEventMutex_);
        callback = runtimeEventCallback_;
    }
    if (callback) {
        callback(message, fatal);
    }
}

std::string VersusApp::getVideoEncoderName() const {
    return videoEncoder_.activeEncoderName();
}

std::string VersusApp::getVideoCodecName() const {
    return videoEncoder_.activeCodecName();
}

bool VersusApp::isHardwareVideoEncoder() const {
    return videoEncoder_.isHardwareEncoderActive();
}

float VersusApp::getAudioLevelRms() const {
    return audioLevelRms_.load(std::memory_order_relaxed);
}

float VersusApp::getAudioPeak() const {
    return audioPeak_.load(std::memory_order_relaxed);
}

void VersusApp::setupCallbacks() {
    opusEncoder_.setPacketCallback([this](const versus::audio::EncodedAudioPacket &packet) {
        webrtc::EncodedAudioPacket out;
        out.data = packet.data;
        out.pts = packet.pts;
        out.sampleRate = packet.sampleRate;
        out.channels = static_cast<uint16_t>(packet.channels);
        sendAudioPacketToPeers(out);
    });
}

void VersusApp::setupSignalingCallbacks() {
    signaling_.onDisconnected([this]() {
        spdlog::warn("[Signaling] Disconnected");
        if (!live_ || stopRequested_.load()) {
            return;
        }
        startSignalingRecovery();
    });

    signaling_.onError([this](const std::string &error) {
        spdlog::warn("[Signaling] Error: {}", error);
        if (!live_ || stopRequested_.load()) {
            return;
        }
        if (signaling_.isConnected()) {
            spdlog::warn("[Signaling] Ignoring reconnect on non-fatal error while socket remains connected");
            return;
        }
        startSignalingRecovery();
    });

    signaling_.onAlert([this](const std::string &message) {
        const std::string lower = toLowerCopy(message);
        const bool streamIdInUse = isStreamIdInUseAlert(lower);

        if (streamIdInUse) {
            const std::string notify =
                "Stream ID is already in use. Pick a different Stream ID and try again.";
            spdlog::error("[App] {}", notify);
            emitRuntimeEvent(notify, true);

            stopRequested_.store(true);
            reconnecting_.store(false);
            live_ = false;
            pendingGlobalKeyframe_.store(false, std::memory_order_relaxed);
            videoTrackActive_.store(false, std::memory_order_relaxed);
            {
                std::lock_guard<std::mutex> lock(signalingOpsMutex_);
                signaling_.disconnect();
            }
            clearPeerSessions();
            return;
        }

        if (!message.empty()) {
            emitRuntimeEvent(message, false);
        }
    });

    signaling_.onOfferRequest([this](const std::string &uuid, const std::string &session, const std::string &streamId) {
        spdlog::info("[Signaling] onOfferRequest uuid={} session={} streamId={}", uuid, session, streamId);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);

        std::string resolvedSession = session;
        if (resolvedSession.empty()) {
            auto now = std::chrono::system_clock::now().time_since_epoch().count();
            resolvedSession = "session_" + std::to_string(now);
            spdlog::info("[Signaling] Generated session ID: {}", resolvedSession);
        }
        const std::string resolvedStreamId = streamId_.empty() ? streamId : streamId_;
        const std::string key = makePeerKey(uuid, resolvedSession);
        const int maxViewers = maxViewers_.load(std::memory_order_relaxed);
        if (maxViewers > 0) {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            const bool replacingExisting = (peerSessions_.find(key) != peerSessions_.end());
            if (!replacingExisting && static_cast<int>(peerSessions_.size()) >= maxViewers) {
                spdlog::warn("[Signaling] Viewer limit reached (max={}); rejecting {}:{}",
                             maxViewers,
                             uuid,
                             resolvedSession);
                return;
            }
        }

        std::shared_ptr<PeerSession> replacedPeer;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            const auto existing = peerSessions_.find(key);
            if (existing != peerSessions_.end()) {
                replacedPeer = existing->second;
                peerSessions_.erase(existing);
            }
        }
        if (replacedPeer && replacedPeer->client) {
            replacedPeer->client->shutdown();
        }

        auto peer = std::make_shared<PeerSession>();
        peer->uuid = uuid;
        peer->session = resolvedSession;
        peer->streamId = resolvedStreamId;
        peer->candidateType = "local";
        peer->answerReceived = false;
        peer->roomMode = !room_.empty();
        if (peer->roomMode) {
            applyPeerInitState(peer, false, PeerRole::Unknown, true, true);
            peer->initDeadlineMs.store(steadyNowMs() + kRoomInitTimeoutMs, std::memory_order_relaxed);
        } else {
            applyPeerInitState(peer, false, PeerRole::Unknown, true, true);
        }
        peer->client = std::make_unique<webrtc::WebRtcClient>();

        webrtc::PeerConfig peerConfig;
        peerConfig.iceServers = {"stun:stun.l.google.com:19302"};
        peerConfig.videoCodec = toPeerVideoCodec(videoConfig_.codec);
        if (videoConfig_.codec == video::VideoCodec::VP9 || videoConfig_.codec == video::VideoCodec::VP8) {
            spdlog::warn("[App] Requested codec {} is not supported in the current WebRTC publisher path; using H.264",
                         videoCodecName(videoConfig_.codec));
        }
        if (!peer->client->initialize(peerConfig)) {
            spdlog::error("[WebRTC] Failed to initialize peer session {}:{}", uuid, resolvedSession);
            return;
        }

        std::weak_ptr<PeerSession> weakPeer = peer;
        peer->client->setStateCallback([this, weakPeer](webrtc::ConnectionState state) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            if (state == webrtc::ConnectionState::Connected) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                peerPtr->waitingForKeyframe.store(true, std::memory_order_relaxed);
                spdlog::info("[WebRTC] Peer connected {}:{}", peerPtr->uuid, peerPtr->session);
                return;
            }
            if (state == webrtc::ConnectionState::Disconnected || state == webrtc::ConnectionState::Failed) {
                spdlog::warn("[WebRTC] Peer connection degraded {}:{} state={}",
                             peerPtr->uuid,
                             peerPtr->session,
                             state == webrtc::ConnectionState::Failed ? "failed" : "disconnected");
                removePeerSession(peerPtr->uuid, peerPtr->session);
            }
        });

        peer->client->setIceCandidateCallback([this, weakPeer](const std::string &candidate,
                                                                const std::string &mid,
                                                                int mlineIndex) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr || candidate.empty()) {
                return;
            }

            const std::string lowerCandidate = toLowerCopy(candidate);
            const bool relayCandidate =
                lowerCandidate.find(" typ relay") != std::string::npos;

            bool shouldSend = false;
            std::string uuidLocal;
            std::string sessionLocal;
            std::string typeLocal;
            {
                std::lock_guard<std::mutex> lock(peerSessionsMutex_);
                const auto it = peerSessions_.find(makePeerKey(peerPtr->uuid, peerPtr->session));
                if (it == peerSessions_.end() || !it->second) {
                    return;
                }

                auto &sessionState = it->second;
                if (!sessionState->answerReceived) {
                    sessionState->pendingCandidates.push_back({candidate, mid, mlineIndex});
                    if (relayCandidate) {
                        sessionState->candidateType = "relay";
                    }
                    return;
                }

                shouldSend = true;
                uuidLocal = sessionState->uuid;
                sessionLocal = sessionState->session;
                if (relayCandidate) {
                    sessionState->candidateType = "relay";
                }
                typeLocal = sessionState->candidateType;
            }

            if (!shouldSend) {
                return;
            }

            if (relayCandidate) {
                const int64_t nowMs = steadyNowMs();
                const int64_t lastWarnMs = lastRelayWarningMs_.load(std::memory_order_relaxed);
                if ((lastWarnMs == 0) || ((nowMs - lastWarnMs) > 15000)) {
                    lastRelayWarningMs_.store(nowMs, std::memory_order_relaxed);
                    emitRuntimeEvent(
                        "Connection is using TURN relay (higher latency/bandwidth cost). If possible, allow direct UDP or use a closer TURN server.",
                        false);
                }
            }

            signaling::SignalCandidate cand;
            cand.uuid = uuidLocal;
            cand.candidate = candidate;
            cand.mid = mid;
            cand.mlineIndex = mlineIndex;
            cand.session = sessionLocal;
            cand.type = typeLocal;
            {
                std::lock_guard<std::mutex> lock(signalingOpsMutex_);
                signaling_.sendCandidate(cand);
            }
        });

        peer->client->setKeyframeRequestCallback([this]() {
            spdlog::info("[App] Browser requested keyframe via PLI/FIR");
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);

            const int64_t nowMs = steadyNowMs();
            const int64_t windowStartMs = pliWindowStartMs_.load(std::memory_order_relaxed);
            if (windowStartMs == 0 || (nowMs - windowStartMs) > 10000) {
                pliWindowStartMs_.store(nowMs, std::memory_order_relaxed);
                pliWindowCount_.store(1, std::memory_order_relaxed);
                return;
            }

            const int pliCount = pliWindowCount_.fetch_add(1, std::memory_order_relaxed) + 1;
            if (pliCount >= 8) {
                const int64_t lastWarnMs = lastPacketLossWarningMs_.load(std::memory_order_relaxed);
                if ((lastWarnMs == 0) || ((nowMs - lastWarnMs) > 15000)) {
                    lastPacketLossWarningMs_.store(nowMs, std::memory_order_relaxed);
                    emitRuntimeEvent(
                        "High packet-loss recovery detected. Consider lowering bitrate/resolution or reducing concurrent viewers.",
                        false);
                }
                pliWindowStartMs_.store(nowMs, std::memory_order_relaxed);
                pliWindowCount_.store(0, std::memory_order_relaxed);
            }
        });

        peer->client->setDataMessageCallback([this, weakPeer](const std::string &message) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            handlePeerDataMessage(peerPtr, message);
        });

        peer->client->setDataChannelStateCallback([this, weakPeer](bool open) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            peerPtr->dataChannelOpen.store(open, std::memory_order_relaxed);
            if (open) {
                if (peerPtr->roomMode) {
                    peerPtr->initDeadlineMs.store(steadyNowMs() + kRoomInitTimeoutMs, std::memory_order_relaxed);
                } else {
                    peerPtr->initReceived.store(true, std::memory_order_relaxed);
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                }
                sendPeerDataInfo(peerPtr, true);
            } else if (peerPtr->roomMode) {
                peerPtr->initDeadlineMs.store(steadyNowMs() + kRoomInitTimeoutMs, std::memory_order_relaxed);
            }
        });

        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peerSessions_[key] = peer;
        }

        const auto offerSdp = peer->client->createOffer();
        if (offerSdp.empty()) {
            spdlog::error("[WebRTC] Failed to create offer for {}:{}", uuid, resolvedSession);
            removePeerSession(uuid, resolvedSession);
            return;
        }

        signaling::SignalOffer offer;
        offer.uuid = uuid;
        offer.session = resolvedSession;
        offer.streamId = resolvedStreamId;
        offer.sdp = offerSdp;
        {
            std::lock_guard<std::mutex> lock(signalingOpsMutex_);
            signaling_.sendOffer(offer);
        }
    });

    signaling_.onOffer([this](const signaling::SignalOffer &offer) {
        spdlog::warn("[Signaling] Unexpected incoming offer uuid={} session={} (publisher mode)",
                     offer.uuid,
                     offer.session);
    });

    signaling_.onAnswer([this](const signaling::SignalAnswer &answer) {
        spdlog::info("[Signaling] onAnswer uuid={} session={}", answer.uuid, answer.session);

        std::shared_ptr<PeerSession> peer;
        std::vector<PendingCandidate> buffered;
        std::string candidateType = "local";
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            auto it = peerSessions_.find(makePeerKey(answer.uuid, answer.session));
            if (it == peerSessions_.end() || !it->second) {
                for (auto &entry : peerSessions_) {
                    if (entry.second && entry.second->uuid == answer.uuid) {
                        it = peerSessions_.find(entry.first);
                        break;
                    }
                }
            }

            if (it == peerSessions_.end() || !it->second) {
                spdlog::warn("[Signaling] No matching peer for answer uuid={} session={}",
                             answer.uuid,
                             answer.session);
                return;
            }

            peer = it->second;
            peer->answerReceived = true;
            buffered = peer->pendingCandidates;
            peer->pendingCandidates.clear();
            candidateType = peer->candidateType;
        }

        peer->client->setRemoteDescription(answer.sdp, "answer");
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);

        for (const auto &pending : buffered) {
            signaling::SignalCandidate cand;
            cand.uuid = peer->uuid;
            cand.candidate = pending.candidate;
            cand.mid = pending.mid;
            cand.mlineIndex = pending.mlineIndex;
            cand.session = peer->session;
            cand.type = candidateType;
            {
                std::lock_guard<std::mutex> lock(signalingOpsMutex_);
                signaling_.sendCandidate(cand);
            }
        }
    });

    signaling_.onCandidate([this](const signaling::SignalCandidate &cand) {
        if (cand.candidate.empty()) {
            return;
        }

        std::shared_ptr<PeerSession> peer;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            auto it = peerSessions_.find(makePeerKey(cand.uuid, cand.session));
            if (it != peerSessions_.end()) {
                peer = it->second;
            } else {
                for (auto &entry : peerSessions_) {
                    if (entry.second && entry.second->uuid == cand.uuid) {
                        peer = entry.second;
                        break;
                    }
                }
            }
        }

        if (!peer || !peer->client) {
            spdlog::debug("[Signaling] Ignoring candidate for unknown peer uuid={} session={}",
                          cand.uuid,
                          cand.session);
            return;
        }

        peer->client->addRemoteCandidate(cand.candidate, cand.mid, cand.mlineIndex);
    });
}

bool VersusApp::isControlMessageAuthorized(const std::string &token) const {
    if (!remoteControlEnabled_.load(std::memory_order_relaxed)) {
        return false;
    }
    if (remoteControlToken_.empty()) {
        return true;
    }
    return token == remoteControlToken_;
}

bool VersusApp::applyRuntimeVideoControl(int bitrateKbps, int width, int height, int fps) {
    if (bitrateKbps <= 0 && width <= 0 && height <= 0 && fps <= 0) {
        return true;
    }

    std::lock_guard<std::mutex> lock(videoSendMutex_);
    auto nextConfig = videoConfig_;

    const bool bitrateRequested = bitrateKbps > 0;
    if (bitrateRequested) {
        const int clamped = std::clamp(bitrateKbps, 250, 100000);
        nextConfig.bitrate = clamped;
        nextConfig.minBitrate = std::max(250, clamped / 2);
        nextConfig.maxBitrate = std::max(nextConfig.maxBitrate, clamped + 2000);
    }

    const bool hasResolutionRequest = width > 0 || height > 0;
    const bool widthRequested = width > 0;
    const bool heightRequested = height > 0;
    if (widthRequested) {
        nextConfig.width = std::clamp(width, 160, 3840);
    }
    if (heightRequested) {
        nextConfig.height = std::clamp(height, 90, 2160);
    }
    if (fps > 0) {
        nextConfig.frameRate = std::clamp(fps, 10, 120);
    }

    const bool bitrateChanged = nextConfig.bitrate != videoConfig_.bitrate;
    const bool resolutionChanged = nextConfig.width != videoConfig_.width || nextConfig.height != videoConfig_.height;
    const bool fpsChanged = nextConfig.frameRate != videoConfig_.frameRate;
    const bool requiresReinit = resolutionChanged || fpsChanged;

    if (!capturing_) {
        videoConfig_ = nextConfig;
        return true;
    }

    if (!bitrateChanged && !resolutionChanged && !fpsChanged) {
        return true;
    }

    const auto previousConfig = videoConfig_;
    if (requiresReinit) {
        spdlog::info("[App] Applying runtime video reconfigure: {}x{} @{}fps {}kbps",
                     nextConfig.width,
                     nextConfig.height,
                     nextConfig.frameRate,
                     nextConfig.bitrate);
        videoEncoder_.shutdown();
        if (!videoEncoder_.initialize(nextConfig)) {
            spdlog::error("[App] Failed runtime reconfigure; restoring previous encoder config");
            if (!videoEncoder_.initialize(previousConfig)) {
                spdlog::error("[App] Failed to restore previous encoder config after runtime reconfigure failure");
            }
            return false;
        }
    } else if (bitrateChanged) {
        spdlog::info("[App] Applying runtime bitrate update: {} kbps", nextConfig.bitrate);
        videoEncoder_.setBitrate(nextConfig.bitrate);
    }

    videoConfig_ = nextConfig;
    if (hasResolutionRequest || bitrateRequested) {
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
    }
    return true;
}

bool VersusApp::enforceRoomCodecLock() {
    if (room_.empty()) {
        return true;
    }
    if (videoConfig_.codec == video::VideoCodec::H264) {
        return true;
    }

    if (!roomCodecWarningEmitted_) {
        roomCodecWarningEmitted_ = true;
        emitRuntimeEvent(
            "Room mode forces H.264 for dual-tier compatibility. Selected codec was overridden.",
            false);
    }

    const auto previousConfig = videoConfig_;
    videoConfig_.codec = video::VideoCodec::H264;

    if (!capturing_) {
        return true;
    }

    std::lock_guard<std::mutex> lock(videoSendMutex_);
    videoEncoder_.shutdown();
    shutdownLqEncoderLocked();
    if (videoEncoder_.initialize(videoConfig_)) {
        return true;
    }

    spdlog::error("[App] Failed to enforce room-mode H.264 lock; restoring previous codec");
    videoConfig_ = previousConfig;
    if (!videoEncoder_.initialize(previousConfig)) {
        spdlog::error("[App] Failed to restore previous encoder config after room codec lock failure");
    }
    return false;
}

void VersusApp::applyPeerInitState(const std::shared_ptr<PeerSession> &peer,
                                   bool roleValid,
                                   PeerRole role,
                                   bool videoEnabled,
                                   bool audioEnabled) {
    if (!peer) {
        return;
    }

    peer->roleValid.store(roleValid, std::memory_order_relaxed);
    peer->role.store(role, std::memory_order_relaxed);
    peer->videoEnabled.store(videoEnabled, std::memory_order_relaxed);
    peer->audioEnabled.store(audioEnabled, std::memory_order_relaxed);

    if (peer->roomMode) {
        const bool initReady = roleValid;
        const StreamTier tier = assignStreamTier(true, roleValid, role);
        peer->initReceived.store(initReady, std::memory_order_relaxed);
        peer->assignedTier.store(tier, std::memory_order_relaxed);
        if (initReady) {
            peer->initDeadlineMs.store(0, std::memory_order_relaxed);
        } else {
            peer->initDeadlineMs.store(steadyNowMs() + kRoomInitTimeoutMs, std::memory_order_relaxed);
        }
        spdlog::info("[App] Peer init {}:{} roomMode=1 role={} roleValid={} tier={} video={} audio={}",
                     peer->uuid,
                     peer->session,
                     peerRoleName(role),
                     roleValid,
                     streamTierName(tier),
                     videoEnabled,
                     audioEnabled);
        return;
    }

    peer->initReceived.store(true, std::memory_order_relaxed);
    peer->assignedTier.store(StreamTier::HQ, std::memory_order_relaxed);
    peer->initDeadlineMs.store(0, std::memory_order_relaxed);
    spdlog::info("[App] Peer init {}:{} roomMode=0 role={} roleValid={} tier=hq video={} audio={}",
                 peer->uuid,
                 peer->session,
                 peerRoleName(role),
                 roleValid,
                 videoEnabled,
                 audioEnabled);
}

void VersusApp::pruneTimedOutPeerInits(int64_t nowMs) {
    std::vector<std::pair<std::string, std::string>> expired;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        for (const auto &entry : peerSessions_) {
            const auto &peer = entry.second;
            if (!peer || !peer->roomMode) {
                continue;
            }
            if (peer->initReceived.load(std::memory_order_relaxed)) {
                continue;
            }
            const int64_t deadlineMs = peer->initDeadlineMs.load(std::memory_order_relaxed);
            if (deadlineMs <= 0 || nowMs < deadlineMs) {
                continue;
            }
            expired.emplace_back(peer->uuid, peer->session);
        }
    }

    for (const auto &entry : expired) {
        spdlog::warn("[App] Closing room peer {}:{} due to missing init payload", entry.first, entry.second);
        emitRuntimeEvent("A room peer was dropped because init metadata was not received in time.", false);
        removePeerSession(entry.first, entry.second);
    }
}

bool VersusApp::ensureLqEncoderInitializedLocked() {
    if (lqEncoderInitialized_.load(std::memory_order_relaxed)) {
        return true;
    }

    video::EncoderConfig lqConfig = videoConfig_;
    lqConfig.codec = video::VideoCodec::H264;
    lqConfig.preferredHardware = video::HardwareEncoder::None;
    lqConfig.forceFfmpegNvenc = false;
    lqConfig.ffmpegPath.clear();
    lqConfig.ffmpegOptions.clear();
    lqConfig.width = kLqWidth;
    lqConfig.height = kLqHeight;
    lqConfig.frameRate = kLqFps;
    lqConfig.bitrate = kLqBitrateKbps;
    lqConfig.minBitrate = 1000;
    lqConfig.maxBitrate = 3000;
    lqConfig.gopSize = 30;
    lqConfig.bFrames = 0;
    lqConfig.lowLatency = true;

    if (!videoEncoderLq_.initialize(lqConfig)) {
        spdlog::error("[App] Failed to initialize LQ encoder");
        return false;
    }

    lqEncoderInitialized_.store(true, std::memory_order_relaxed);
    spdlog::info("[App] LQ encoder active: {} ({}x{}@{} {}kbps)",
                 videoEncoderLq_.activeEncoderName(),
                 kLqWidth,
                 kLqHeight,
                 kLqFps,
                 kLqBitrateKbps);
    return true;
}

void VersusApp::shutdownLqEncoderLocked() {
    if (!lqEncoderInitialized_.load(std::memory_order_relaxed)) {
        return;
    }
    videoEncoderLq_.shutdown();
    lqEncoderInitialized_.store(false, std::memory_order_relaxed);
}

void VersusApp::sendPeerDataInfo(const std::shared_ptr<PeerSession> &peer, bool includeMiniStats) {
    if (!peer || !peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    const PeerRole peerRole = peer->role.load(std::memory_order_relaxed);
    const bool roleValid = peer->roleValid.load(std::memory_order_relaxed);
    const bool initReceived = peer->initReceived.load(std::memory_order_relaxed);
    const bool videoEnabled = peer->videoEnabled.load(std::memory_order_relaxed);
    const bool audioEnabled = peer->audioEnabled.load(std::memory_order_relaxed);
    StreamTier assignedTier = peer->assignedTier.load(std::memory_order_relaxed);
    if (assignedTier == StreamTier::None) {
        assignedTier = assignStreamTier(peer->roomMode, roleValid, peerRole);
    }

    const bool peerWantsLq = assignedTier == StreamTier::LQ;
    const int effectiveBitrate = peerWantsLq ? kLqBitrateKbps : videoConfig_.bitrate;
    const int effectiveWidth = peerWantsLq ? kLqWidth : videoConfig_.width;
    const int effectiveHeight = peerWantsLq ? kLqHeight : videoConfig_.height;
    const int effectiveFps = peerWantsLq ? kLqFps : videoConfig_.frameRate;

    nlohmann::json msg;
    nlohmann::json info;

    info["label"] = startOptions_.label;
    info["version"] = "game-capture-native-qt/0.2.6";
    info["maxviewers_url"] = maxViewers_.load(std::memory_order_relaxed);
    info["quality_url"] = effectiveBitrate;
    info["width_url"] = effectiveWidth;
    info["height_url"] = effectiveHeight;
    info["fps_url"] = effectiveFps;
    info["codec_url"] = peerWantsLq ? "H.264" : videoCodecName(videoConfig_.codec);
    if (peerWantsLq) {
        info["video_encoder"] = lqEncoderInitialized_.load(std::memory_order_relaxed)
            ? videoEncoderLq_.activeEncoderName()
            : "LQ-CPU-H264";
        info["video_codec"] = "H.264";
        info["hardware_encoder"] = false;
    } else {
        info["video_encoder"] = videoEncoder_.activeEncoderName();
        info["video_codec"] = videoEncoder_.activeCodecName();
        info["hardware_encoder"] = videoEncoder_.isHardwareEncoderActive();
    }
    info["room_init"] = !room_.empty();
    info["room_init_received"] = initReceived;
    info["assigned_role"] = peerRoleName(peerRole);
    info["assigned_tier"] = streamTierName(assignedTier);
    info["peer_video_enabled"] = videoEnabled;
    info["peer_audio_enabled"] = audioEnabled;
    if (!peer->peerLabel.empty()) {
        info["peer_label"] = peer->peerLabel;
    }
    if (!peer->systemApp.empty()) {
        info["system_app"] = peer->systemApp;
    }
    if (!peer->systemVersion.empty()) {
        info["system_version"] = peer->systemVersion;
    }
    if (!peer->systemPlatform.empty()) {
        info["system_platform"] = peer->systemPlatform;
    }
    if (!peer->systemBrowser.empty()) {
        info["system_browser"] = peer->systemBrowser;
    }
    msg["info"] = info;

    if (includeMiniStats) {
        int peerCount = 0;
        int hqPeers = 0;
        int lqPeers = 0;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peerCount = static_cast<int>(peerSessions_.size());
            for (const auto &entry : peerSessions_) {
                if (!entry.second || !entry.second->client) {
                    continue;
                }
                const PeerRouteState route{
                    entry.second->roomMode,
                    entry.second->initReceived.load(std::memory_order_relaxed),
                    entry.second->roleValid.load(std::memory_order_relaxed),
                    entry.second->role.load(std::memory_order_relaxed),
                    entry.second->videoEnabled.load(std::memory_order_relaxed),
                    entry.second->audioEnabled.load(std::memory_order_relaxed)};
                if (!canSendVideo(route)) {
                    continue;
                }
                const StreamTier tier = assignStreamTier(route.roomMode, route.roleValid, route.role);
                if (tier == StreamTier::HQ) {
                    hqPeers++;
                } else if (tier == StreamTier::LQ) {
                    lqPeers++;
                }
            }
        }
        nlohmann::json miniInfo;
        miniInfo["out"] = {{"c", peerCount}, {"hq_peers", hqPeers}, {"lq_peers", lqPeers}};
        msg["miniInfo"] = miniInfo;
    }

    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::handlePeerDataMessage(const std::shared_ptr<PeerSession> &peer, const std::string &message) {
    if (!peer) {
        return;
    }

    auto msg = nlohmann::json::parse(message, nullptr, false);
    if (msg.is_discarded()) {
        return;
    }
    if (!msg.is_object()) {
        return;
    }

    auto parseIntValue = [&msg](const char *key, int defaultValue = 0) {
        if (!msg.contains(key)) {
            return defaultValue;
        }
        if (msg[key].is_number_integer()) {
            return msg[key].get<int>();
        }
        if (msg[key].is_string()) {
            try {
                return std::stoi(msg[key].get<std::string>());
            } catch (...) {
                return defaultValue;
            }
        }
        return defaultValue;
    };

    if (msg.contains("ping")) {
        nlohmann::json pong;
        pong["pong"] = msg["ping"];
        peer->client->sendDataMessage(pong.dump());
    }

    const bool hasInlineInitFields =
        msg.contains("role") ||
        msg.contains("scene") ||
        msg.contains("director") ||
        msg.contains("guest") ||
        msg.contains("viewer") ||
        msg.contains("video") ||
        msg.contains("audio") ||
        msg.contains("system") ||
        msg.contains("label");
    const nlohmann::json *initPtr = nullptr;
    if (msg.contains("init") && msg["init"].is_object()) {
        initPtr = &msg["init"];
    } else if (hasInlineInitFields) {
        initPtr = &msg;
    }

    if (initPtr) {
        const auto &init = *initPtr;
        PeerRole role = PeerRole::Unknown;
        bool roleValid = false;

        if (init.contains("role") && init["role"].is_string()) {
            role = parsePeerRole(init["role"].get<std::string>());
            roleValid = role != PeerRole::Unknown;
        }
        if (!roleValid && init.contains("scene") && jsonBoolLike(init["scene"], false)) {
            role = PeerRole::Scene;
            roleValid = true;
        }
        if (!roleValid && init.contains("director") && jsonBoolLike(init["director"], false)) {
            role = PeerRole::Director;
            roleValid = true;
        }
        if (!roleValid && init.contains("guest") && jsonBoolLike(init["guest"], false)) {
            role = PeerRole::Guest;
            roleValid = true;
        }
        if (!roleValid && init.contains("viewer") && jsonBoolLike(init["viewer"], false)) {
            role = PeerRole::Viewer;
            roleValid = true;
        }

        bool videoEnabled = true;
        bool audioEnabled = true;
        if (init.contains("video")) {
            videoEnabled = jsonBoolLike(init["video"], true);
        }
        if (init.contains("audio")) {
            audioEnabled = jsonBoolLike(init["audio"], true);
        }

        if (init.contains("label") && init["label"].is_string()) {
            peer->peerLabel = init["label"].get<std::string>();
        }
        if (init.contains("system") && init["system"].is_object()) {
            const auto &system = init["system"];
            if (system.contains("app") && system["app"].is_string()) {
                peer->systemApp = system["app"].get<std::string>();
            }
            if (system.contains("version") && system["version"].is_string()) {
                peer->systemVersion = system["version"].get<std::string>();
            }
            if (system.contains("platform") && system["platform"].is_string()) {
                peer->systemPlatform = system["platform"].get<std::string>();
            }
            if (system.contains("browser") && system["browser"].is_string()) {
                peer->systemBrowser = system["browser"].get<std::string>();
            }
        }

        applyPeerInitState(peer, roleValid, role, videoEnabled, audioEnabled);
        if (peer->roomMode && roleValid) {
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        }

        nlohmann::json ack;
        ack["ack"] = "init";
        ack["ok"] = !peer->roomMode || roleValid;
        ack["assigned_role"] = peerRoleName(peer->role.load(std::memory_order_relaxed));
        ack["assigned_tier"] = streamTierName(peer->assignedTier.load(std::memory_order_relaxed));
        ack["video"] = peer->videoEnabled.load(std::memory_order_relaxed);
        ack["audio"] = peer->audioEnabled.load(std::memory_order_relaxed);
        if (!ack["ok"].get<bool>()) {
            ack["error"] = "invalid_role";
        }
        peer->client->sendDataMessage(ack.dump());
        sendPeerDataInfo(peer, true);
    }

    const bool requestKeyframe = msg.contains("keyframe") ? jsonBoolLike(msg["keyframe"], false) : false;
    if (requestKeyframe) {
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
    }

    const int requestedBitrate = parseIntValue("targetBitrate", 0);
    int requestedWidth = 0;
    int requestedHeight = 0;
    int requestedFps = 0;
    if (msg.contains("requestResolution") && msg["requestResolution"].is_object()) {
        const auto &resolution = msg["requestResolution"];
        if (resolution.contains("w")) {
            if (resolution["w"].is_number_integer()) {
                requestedWidth = resolution["w"].get<int>();
            } else if (resolution["w"].is_string()) {
                try {
                    requestedWidth = std::stoi(resolution["w"].get<std::string>());
                } catch (...) {
                    requestedWidth = 0;
                }
            }
        }
        if (resolution.contains("h")) {
            if (resolution["h"].is_number_integer()) {
                requestedHeight = resolution["h"].get<int>();
            } else if (resolution["h"].is_string()) {
                try {
                    requestedHeight = std::stoi(resolution["h"].get<std::string>());
                } catch (...) {
                    requestedHeight = 0;
                }
            }
        }
        if (resolution.contains("f")) {
            if (resolution["f"].is_number_integer()) {
                requestedFps = resolution["f"].get<int>();
            } else if (resolution["f"].is_string()) {
                try {
                    requestedFps = std::stoi(resolution["f"].get<std::string>());
                } catch (...) {
                    requestedFps = 0;
                }
            }
        } else if (resolution.contains("fps")) {
            if (resolution["fps"].is_number_integer()) {
                requestedFps = resolution["fps"].get<int>();
            } else if (resolution["fps"].is_string()) {
                try {
                    requestedFps = std::stoi(resolution["fps"].get<std::string>());
                } catch (...) {
                    requestedFps = 0;
                }
            }
        }
    }

    const bool hasControlRequest =
        requestedBitrate > 0 ||
        (requestedWidth > 0 && requestedHeight > 0) ||
        requestedFps > 0;

    if (hasControlRequest) {
        if (peer->roomMode && !peer->initReceived.load(std::memory_order_relaxed)) {
            nlohmann::json ack;
            ack["ack"] = "control";
            ack["ok"] = false;
            ack["error"] = "init_required";
            peer->client->sendDataMessage(ack.dump());
            return;
        }

        std::string token;
        if (msg.contains("remote") && msg["remote"].is_string()) {
            token = msg["remote"].get<std::string>();
        } else if (msg.contains("token") && msg["token"].is_string()) {
            token = msg["token"].get<std::string>();
        }

        nlohmann::json ack;
        ack["ack"] = "control";
        ack["targetBitrate"] = requestedBitrate;
        if (requestedWidth > 0 && requestedHeight > 0) {
            ack["requestResolution"] = {{"w", requestedWidth}, {"h", requestedHeight}, {"f", requestedFps}};
        }

        if (!isControlMessageAuthorized(token)) {
            spdlog::warn("[App] Rejected unauthorized data-channel control message from {}", peer->uuid);
            ack["ok"] = false;
            ack["error"] = "unauthorized";
            peer->client->sendDataMessage(ack.dump());
        } else {
            const bool ok = applyRuntimeVideoControl(requestedBitrate, requestedWidth, requestedHeight, requestedFps);
            ack["ok"] = ok;
            if (!ok) {
                ack["error"] = "apply_failed";
            }
            peer->client->sendDataMessage(ack.dump());
            if (ok) {
                sendPeerDataInfo(peer, true);
            }
        }
    }

    if (msg.value("requestStats", false) || msg.value("getStats", false)) {
        sendPeerDataInfo(peer, true);
    }
}

bool VersusApp::encodeAndSendVideoFrame(const video::CapturedFrame &frame, bool forceKeyframe) {
    if (!live_) {
        return false;
    }

    std::lock_guard<std::mutex> lock(videoSendMutex_);
    if (!live_) {
        return false;
    }

    std::vector<std::shared_ptr<PeerSession>> hqPeers;
    std::vector<std::shared_ptr<PeerSession>> lqPeers;
    {
        std::lock_guard<std::mutex> peersLock(peerSessionsMutex_);
        hqPeers.reserve(peerSessions_.size());
        lqPeers.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (!entry.second || !entry.second->client || !entry.second->client->hasActiveVideoTrack()) {
                continue;
            }

            auto &peer = entry.second;
            const PeerRouteState route{
                peer->roomMode,
                peer->initReceived.load(std::memory_order_relaxed),
                peer->roleValid.load(std::memory_order_relaxed),
                peer->role.load(std::memory_order_relaxed),
                peer->videoEnabled.load(std::memory_order_relaxed),
                peer->audioEnabled.load(std::memory_order_relaxed)};
            if (!canSendVideo(route)) {
                continue;
            }

            const StreamTier tier = assignStreamTier(route.roomMode, route.roleValid, route.role);
            peer->assignedTier.store(tier, std::memory_order_relaxed);
            if (tier == StreamTier::HQ) {
                hqPeers.push_back(peer);
            } else if (tier == StreamTier::LQ) {
                lqPeers.push_back(peer);
            }
        }
    }

    if (hqPeers.empty() && lqPeers.empty()) {
        shutdownLqEncoderLocked();
        return false;
    }

    bool requestKeyframe = forceKeyframe || pendingGlobalKeyframe_.exchange(false, std::memory_order_relaxed);
    const int64_t nowMs = steadyNowMs();

    video::EncodedPacket hqPacket;
    video::EncodedPacket lqPacket;
    bool haveHqPacket = false;
    bool haveLqPacket = false;

    if (!hqPeers.empty()) {
        const bool externalFfmpegEncoder =
            videoEncoder_.activeEncoderName().find("FFmpeg") != std::string::npos;
        if (requestKeyframe && !externalFfmpegEncoder) {
            videoEncoder_.requestKeyframe();
        }

        const auto encodeStart = std::chrono::steady_clock::now();
        if (videoEncoder_.encode(frame, hqPacket)) {
            haveHqPacket = true;
            const auto encodeElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                             std::chrono::steady_clock::now() - encodeStart)
                                             .count();
            const bool softwareEncoding = !videoEncoder_.isHardwareEncoderActive();
            if (softwareEncoding) {
                const int frameIntervalMs = std::max(1, 1000 / std::max(1, videoConfig_.frameRate));
                if (encodeElapsedMs > (frameIntervalMs * 2)) {
                    const int samples = softwareOverloadSamples_.fetch_add(1, std::memory_order_relaxed) + 1;
                    if (samples >= 20) {
                        const int64_t nowMsLocal = steadyNowMs();
                        const int64_t lastWarnMs = lastCpuWarningMs_.load(std::memory_order_relaxed);
                        if ((lastWarnMs == 0) || ((nowMsLocal - lastWarnMs) > 15000)) {
                            lastCpuWarningMs_.store(nowMsLocal, std::memory_order_relaxed);
                            emitRuntimeEvent(
                                "CPU encoder appears overloaded. Lower bitrate/resolution/FPS or switch to NVENC/QSV.",
                                false);
                        }
                        softwareOverloadSamples_.store(0, std::memory_order_relaxed);
                    }
                } else {
                    const int current = softwareOverloadSamples_.load(std::memory_order_relaxed);
                    if (current > 0) {
                        softwareOverloadSamples_.store(current - 1, std::memory_order_relaxed);
                    }
                }
            } else {
                softwareOverloadSamples_.store(0, std::memory_order_relaxed);
            }

            if (requestKeyframe && !hqPacket.isKeyframe && !externalFfmpegEncoder) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
        } else {
            if (requestKeyframe && !externalFfmpegEncoder) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
        }
    }

    if (!lqPeers.empty()) {
        if (ensureLqEncoderInitializedLocked()) {
            if (requestKeyframe) {
                videoEncoderLq_.requestKeyframe();
            }
            if (videoEncoderLq_.encode(frame, lqPacket)) {
                haveLqPacket = true;
                if (requestKeyframe && !lqPacket.isKeyframe) {
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                }
            } else if (requestKeyframe) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
        }
    } else {
        shutdownLqEncoderLocked();
    }

    if (!haveHqPacket && !haveLqPacket) {
        return false;
    }

    bool sentAny = false;
    bool sentKeyframe = false;

    if (haveHqPacket) {
        webrtc::EncodedVideoPacket packet;
        packet.data = hqPacket.data;
        packet.pts = hqPacket.pts;
        packet.isKeyframe = hqPacket.isKeyframe;
        for (const auto &peer : hqPeers) {
            if (!peer || !peer->client) {
                continue;
            }
            if (peer->waitingForKeyframe.load(std::memory_order_relaxed) && !packet.isKeyframe) {
                continue;
            }
            if (peer->client->sendVideo(packet)) {
                sentAny = true;
                if (packet.isKeyframe) {
                    sentKeyframe = true;
                    peer->waitingForKeyframe.store(false, std::memory_order_relaxed);
                }
            }
        }
    }

    if (haveLqPacket) {
        webrtc::EncodedVideoPacket packet;
        packet.data = lqPacket.data;
        packet.pts = lqPacket.pts;
        packet.isKeyframe = lqPacket.isKeyframe;
        for (const auto &peer : lqPeers) {
            if (!peer || !peer->client) {
                continue;
            }
            if (peer->waitingForKeyframe.load(std::memory_order_relaxed) && !packet.isKeyframe) {
                continue;
            }
            if (peer->client->sendVideo(packet)) {
                sentAny = true;
                if (packet.isKeyframe) {
                    sentKeyframe = true;
                    peer->waitingForKeyframe.store(false, std::memory_order_relaxed);
                }
            }
        }
    }

    if (sentAny) {
        lastVideoSendMs_.store(nowMs, std::memory_order_relaxed);
        if (sentKeyframe) {
            lastKeyframeSendMs_.store(nowMs, std::memory_order_relaxed);
        }
    }
    return sentAny;
}

bool VersusApp::getCachedVideoFrame(video::CapturedFrame &frame) {
    {
        std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
        if (hasLatestVideoFrame_ && !latestVideoFrame_.data.empty()) {
            frame = latestVideoFrame_;
            return true;
        }
    }
    return windowCapture_.getLatestFrame(frame);
}

void VersusApp::startSignalingRecovery() {
    if (reconnecting_.exchange(true)) {
        return;
    }

    emitRuntimeEvent("Signaling connection dropped. Attempting to reconnect...", false);
    stopSignalingRecoveryThread();
    signalingRecoveryThread_ = std::thread([this]() {
        int attempt = 0;
        while (true) {
            if (!live_ || stopRequested_.load()) {
                reconnecting_.store(false);
                return;
            }

            attempt++;
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            spdlog::warn("[App] Signaling recovery attempt {}", attempt);

            bool recovered = false;
            {
                std::lock_guard<std::mutex> lock(signalingOpsMutex_);
                signaling_.disconnect();

                if (signaling_.connect(startOptions_.server)) {
                    signaling_.setPassword(password_);
                    if (password_ == "false" || password_ == "0" || password_ == "off") {
                        signaling_.disableEncryption();
                    }

                    bool joined = true;
                    if (!room_.empty()) {
                        signaling::RoomConfig roomConfig;
                        roomConfig.room = room_;
                        roomConfig.password = password_;
                        roomConfig.label = startOptions_.label;
                        roomConfig.streamId = streamId_;
                        roomConfig.salt = salt_;
                        joined = signaling_.joinRoom(roomConfig);
                    }

                    if (joined) {
                        recovered = signaling_.publish(streamId_, startOptions_.label);
                    }
                }

                if (!recovered) {
                    signaling_.disconnect();
                }
            }

            if (recovered) {
                spdlog::info("[App] Signaling recovery succeeded");
                emitRuntimeEvent("Reconnected to signaling server.", false);
                reconnecting_.store(false);
                return;
            }

            if (attempt == 5 || (attempt % 10) == 0) {
                emitRuntimeEvent(
                    "Still reconnecting to signaling server. Existing viewers may continue, but new viewers cannot join until reconnect succeeds.",
                    false);
            }
            std::this_thread::sleep_for(std::chrono::seconds(std::min(10, attempt)));
        }
    });
}

void VersusApp::stopSignalingRecoveryThread() {
    if (!signalingRecoveryThread_.joinable()) {
        return;
    }

    if (signalingRecoveryThread_.get_id() == std::this_thread::get_id()) {
        signalingRecoveryThread_.detach();
        return;
    }
    signalingRecoveryThread_.join();
}

void VersusApp::startVideoMaintenanceThread() {
    if (videoMaintenanceRunning_.exchange(true)) {
        return;
    }

    videoMaintenanceThread_ = std::thread([this]() {
        int64_t lastInfoBroadcastMs = 0;
        while (videoMaintenanceRunning_.load()) {
            if (!live_ || !capturing_) {
                videoTrackActive_.store(false, std::memory_order_relaxed);
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }

            const int64_t nowMs = steadyNowMs();
            pruneTimedOutPeerInits(nowMs);
            const bool trackActive = hasAnyActiveVideoTrack();
            const bool wasTrackActive = videoTrackActive_.exchange(trackActive, std::memory_order_relaxed);
            if (trackActive && !wasTrackActive) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
            if (!trackActive) {
                std::lock_guard<std::mutex> lock(videoSendMutex_);
                shutdownLqEncoderLocked();
                std::this_thread::sleep_for(std::chrono::milliseconds(120));
                continue;
            }
            if ((nowMs - lastInfoBroadcastMs) >= kDataInfoIntervalMs) {
                std::vector<std::shared_ptr<PeerSession>> peers;
                {
                    std::lock_guard<std::mutex> lock(peerSessionsMutex_);
                    peers.reserve(peerSessions_.size());
                    for (const auto &entry : peerSessions_) {
                        if (entry.second && entry.second->dataChannelOpen.load(std::memory_order_relaxed)) {
                            peers.push_back(entry.second);
                        }
                    }
                }
                for (const auto &peer : peers) {
                    sendPeerDataInfo(peer, false);
                }
                lastInfoBroadcastMs = nowMs;
            }

            const int64_t lastSendMs = lastVideoSendMs_.load(std::memory_order_relaxed);
            const bool staleSend = (lastSendMs == 0) || ((nowMs - lastSendMs) >= kStaleResendMs);
            const int64_t lastKeyframeMs = lastKeyframeSendMs_.load(std::memory_order_relaxed);
            const bool periodicKeyframeDue =
                (lastKeyframeMs == 0) || ((nowMs - lastKeyframeMs) >= kPeriodicKeyframeMs);

            if (staleSend || periodicKeyframeDue) {
                video::CapturedFrame cached;
                if (getCachedVideoFrame(cached)) {
                    encodeAndSendVideoFrame(cached, periodicKeyframeDue);
                }
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    });
}

void VersusApp::stopVideoMaintenanceThread() {
    videoMaintenanceRunning_.store(false);
    if (!videoMaintenanceThread_.joinable()) {
        return;
    }
    if (videoMaintenanceThread_.get_id() == std::this_thread::get_id()) {
        videoMaintenanceThread_.detach();
        return;
    }
    videoMaintenanceThread_.join();
}

bool VersusApp::hasAnyActiveVideoTrack() const {
    std::lock_guard<std::mutex> lock(peerSessionsMutex_);
    for (const auto &entry : peerSessions_) {
        if (!entry.second || !entry.second->client || !entry.second->client->hasActiveVideoTrack()) {
            continue;
        }
        const PeerRouteState route{
            entry.second->roomMode,
            entry.second->initReceived.load(std::memory_order_relaxed),
            entry.second->roleValid.load(std::memory_order_relaxed),
            entry.second->role.load(std::memory_order_relaxed),
            entry.second->videoEnabled.load(std::memory_order_relaxed),
            entry.second->audioEnabled.load(std::memory_order_relaxed)};
        if (canSendVideo(route)) {
            return true;
        }
    }
    return false;
}

bool VersusApp::hasAnyActiveAudioTrack() const {
    std::lock_guard<std::mutex> lock(peerSessionsMutex_);
    for (const auto &entry : peerSessions_) {
        if (!entry.second || !entry.second->client || !entry.second->client->hasActiveAudioTrack()) {
            continue;
        }
        const PeerRouteState route{
            entry.second->roomMode,
            entry.second->initReceived.load(std::memory_order_relaxed),
            entry.second->roleValid.load(std::memory_order_relaxed),
            entry.second->role.load(std::memory_order_relaxed),
            entry.second->videoEnabled.load(std::memory_order_relaxed),
            entry.second->audioEnabled.load(std::memory_order_relaxed)};
        if (canSendAudio(route)) {
            return true;
        }
    }
    return false;
}

void VersusApp::sendAudioPacketToPeers(const versus::webrtc::EncodedAudioPacket &packet) {
    std::vector<std::shared_ptr<PeerSession>> peers;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peers.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (!entry.second || !entry.second->client || !entry.second->client->hasActiveAudioTrack()) {
                continue;
            }
            const PeerRouteState route{
                entry.second->roomMode,
                entry.second->initReceived.load(std::memory_order_relaxed),
                entry.second->roleValid.load(std::memory_order_relaxed),
                entry.second->role.load(std::memory_order_relaxed),
                entry.second->videoEnabled.load(std::memory_order_relaxed),
                entry.second->audioEnabled.load(std::memory_order_relaxed)};
            if (!canSendAudio(route)) {
                continue;
            }
            peers.push_back(entry.second);
        }
    }

    for (const auto &peer : peers) {
        if (!peer || !peer->client) {
            continue;
        }
        peer->client->sendAudio(packet);
    }
}

std::string VersusApp::makePeerKey(const std::string &uuid, const std::string &session) const {
    return uuid + "|" + session;
}

void VersusApp::removePeerSession(const std::string &uuid, const std::string &session) {
    std::shared_ptr<PeerSession> peer;
    bool hasRemainingPeers = true;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(makePeerKey(uuid, session));
        if (it == peerSessions_.end()) {
            return;
        }
        peer = it->second;
        peerSessions_.erase(it);
        hasRemainingPeers = !peerSessions_.empty();
    }

    if (peer && peer->client) {
        peer->client->shutdown();
    }
    if (!hasRemainingPeers) {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        shutdownLqEncoderLocked();
    }
}

void VersusApp::clearPeerSessions() {
    std::vector<std::shared_ptr<PeerSession>> peers;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peers.reserve(peerSessions_.size());
        for (auto &entry : peerSessions_) {
            if (entry.second) {
                peers.push_back(entry.second);
            }
        }
        peerSessions_.clear();
    }

    for (auto &peer : peers) {
        if (peer && peer->client) {
            peer->client->shutdown();
        }
    }
    std::lock_guard<std::mutex> lock(videoSendMutex_);
    shutdownLqEncoderLocked();
}

}  // namespace versus::app
