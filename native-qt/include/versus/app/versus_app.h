#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "versus/signaling/vdo_signaling.h"
#include "versus/app/dual_stream_policy.h"
#include "versus/webrtc/webrtc_client.h"
#include "versus/video/video_encoder.h"
#include "versus/video/window_capture.h"
#include "versus/audio/opus_encoder.h"
#include "versus/audio/window_audio_capture_core.h"

namespace versus::app {

struct StartOptions {
    std::string room;
    std::string password;
    std::string label;
    std::string streamId;
    std::string server = "wss://wss.vdo.ninja";
    std::string salt = "vdo.ninja";
    int maxViewers = 10;
    bool remoteControlEnabled = false;
    std::string remoteControlToken;
};

class VersusApp {
  public:
    using RuntimeEventCallback = std::function<void(const std::string &, bool fatal)>;

    VersusApp();
    ~VersusApp();

    bool initialize();
    void shutdown();

    std::vector<versus::video::WindowInfo> listWindows();
    bool startCapture(const std::string &windowId);
    void stopCapture();
    void setSelectedWindow(const std::string &windowId);

    bool goLive(const StartOptions &options);
    void stopLive();

    void setVideoConfig(const versus::video::EncoderConfig &config);
    std::string getVideoEncoderName() const;
    std::string getVideoCodecName() const;
    bool isHardwareVideoEncoder() const;
    float getAudioLevelRms() const;
    float getAudioPeak() const;

    bool isLive() const { return live_; }

    std::string getShareLink() const;
    void onRuntimeEvent(RuntimeEventCallback cb);

  private:
    struct PeerSession;
    void setupCallbacks();
    void setupSignalingCallbacks();
    void startSignalingRecovery();
    void stopSignalingRecoveryThread();
    void startVideoMaintenanceThread();
    void stopVideoMaintenanceThread();
    void startEncodeThread();
    void stopEncodeThread();
    bool hasAnyActiveVideoTrack() const;
    bool hasAnyActiveAudioTrack() const;
    void sendAudioPacketToPeers(const versus::webrtc::EncodedAudioPacket &packet);
    bool applyRuntimeVideoControl(int bitrateKbps, int width, int height, int fps);
    void handlePeerDataMessage(const std::shared_ptr<PeerSession> &peer, const std::string &message);
    void sendPeerDataInfo(const std::shared_ptr<PeerSession> &peer, bool includeMiniStats);
    bool enforceRoomCodecLock();
    void applyPeerInitState(const std::shared_ptr<PeerSession> &peer,
                            bool roleValid,
                            PeerRole role,
                            bool videoEnabled,
                            bool audioEnabled);
    void pruneTimedOutPeerInits(int64_t nowMs);
    bool ensureLqEncoderInitializedLocked();
    void shutdownLqEncoderLocked();
    bool isControlMessageAuthorized(const std::string &token) const;
    bool encodeAndSendVideoFrame(const versus::video::CapturedFrame &frame, bool forceKeyframe);
    bool adaptHqEncoderToFrameLocked(const versus::video::CapturedFrame &frame, int64_t nowMs);
    bool getCachedVideoFrame(versus::video::CapturedFrame &frame);
    std::string makePeerKey(const std::string &uuid, const std::string &session) const;
    void removePeerSession(const std::string &uuid, const std::string &session);
    void clearPeerSessions();
    void emitRuntimeEvent(const std::string &message, bool fatal);

    bool live_ = false;
    bool capturing_ = false;
    std::atomic<bool> stopRequested_{false};
    std::atomic<bool> reconnecting_{false};
    std::atomic<bool> videoTrackActive_{false};
    std::atomic<bool> pendingGlobalKeyframe_{false};
    std::atomic<int64_t> lastVideoSendMs_{0};
    std::atomic<int64_t> lastKeyframeSendMs_{0};
    StartOptions startOptions_;
    std::string streamId_;
    std::string room_;
    std::string password_;
    std::string salt_;
    std::string remoteControlToken_;
    std::string selectedWindowId_;
    std::atomic<int64_t> audioPts100ns_{0};
    std::atomic<float> audioLevelRms_{0.0f};
    std::atomic<float> audioPeak_{0.0f};
    std::atomic<int> maxViewers_{10};
    std::atomic<bool> remoteControlEnabled_{false};
    std::atomic<int64_t> lastRelayWarningMs_{0};
    std::atomic<int64_t> lastPacketLossWarningMs_{0};
    std::atomic<int64_t> pliWindowStartMs_{0};
    std::atomic<int> pliWindowCount_{0};
    std::atomic<int64_t> lastCpuWarningMs_{0};
    std::atomic<int> softwareOverloadSamples_{0};
    std::thread signalingRecoveryThread_;
    std::thread videoMaintenanceThread_;
    std::atomic<bool> videoMaintenanceRunning_{false};
    std::thread encodeThread_;
    std::atomic<bool> encodeThreadRunning_{false};
    std::mutex encodeNotifyMutex_;
    std::condition_variable encodeFrameCV_;
    bool encodeFrameReady_ = false;
    mutable std::mutex peerSessionsMutex_;
    mutable std::mutex signalingOpsMutex_;
    mutable std::mutex runtimeEventMutex_;
    RuntimeEventCallback runtimeEventCallback_;
    struct PendingCandidate {
        std::string candidate;
        std::string mid;
        int mlineIndex;
    };
    struct PeerSession {
        std::string uuid;
        std::string session;
        std::string streamId;
        std::string candidateType = "local";
        bool answerReceived = false;
        bool roomMode = false;
        std::atomic<bool> initReceived{false};
        std::atomic<bool> roleValid{false};
        std::atomic<PeerRole> role{PeerRole::Unknown};
        std::atomic<StreamTier> assignedTier{StreamTier::None};
        std::atomic<bool> videoEnabled{true};
        std::atomic<bool> audioEnabled{true};
        std::atomic<int64_t> initDeadlineMs{0};
        std::string peerLabel;
        std::string systemApp;
        std::string systemVersion;
        std::string systemPlatform;
        std::string systemBrowser;
        std::atomic<bool> waitingForKeyframe{true};
        std::atomic<bool> dataChannelOpen{false};
        std::vector<PendingCandidate> pendingCandidates;
        std::unique_ptr<versus::webrtc::WebRtcClient> client;
    };
    std::unordered_map<std::string, std::shared_ptr<PeerSession>> peerSessions_;
    versus::video::EncoderConfig videoConfig_{};
    std::mutex videoSendMutex_;
    std::mutex latestVideoFrameMutex_;
    versus::video::CapturedFrame latestVideoFrame_;
    bool hasLatestVideoFrame_ = false;
    int activeHqWidth_ = 0;
    int activeHqHeight_ = 0;
    int lastCaptureWidth_ = 0;
    int lastCaptureHeight_ = 0;
    int64_t lastCaptureResizeMs_ = 0;
    int64_t lastHqReconfigureMs_ = 0;
    int64_t lastResizeKeyframeRequestMs_ = 0;
    bool hqAspectLocked_ = false;
    std::atomic<bool> lqEncoderInitialized_{false};
    bool roomCodecWarningEmitted_ = false;

    versus::video::WindowCapture windowCapture_;
    versus::video::VideoEncoder videoEncoder_;
    versus::video::VideoEncoder videoEncoderLq_;
    versus::audio::WindowAudioCaptureCore audioCapture_;
    versus::audio::OpusEncoder opusEncoder_;
    versus::signaling::VdoSignaling signaling_;
};

}  // namespace versus::app
