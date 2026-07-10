#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <future>
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
#include "versus/video/spout_capture.h"
#include "versus/video/video_encoder.h"
#include "versus/video/window_capture.h"
#include "versus/audio/opus_encoder.h"
#include "versus/audio/window_audio_capture_core.h"

namespace versus::app {

enum class AudioSourceMode {
    SelectedWindow,
    DefaultOutput,
    CommunicationsOutput,
    DefaultMicrophone,
    None
};

enum class VideoSourceMode {
    Window,
    Spout
};

struct StreamMetrics {
    double videoBitrateKbps = 0.0;
    double audioBitrateKbps = 0.0;
    double frameRate = 0.0;
    double droppedFrameRate = 0.0;
    int width = 0;
    int height = 0;
    std::string codec;
    std::string encoder;
    int peerCount = 0;
    int hqPeerCount = 0;
    int lqPeerCount = 0;
    int activeVideoPeers = 0;
    int activeAudioPeers = 0;
    uint64_t videoFramesCaptured = 0;
    uint64_t videoFramesSent = 0;
    uint64_t videoFramesDropped = 0;
    uint64_t audioPacketsSent = 0;
    uint64_t videoEncodeFailures = 0;
    uint64_t videoEncodeTimeouts = 0;
    uint64_t videoEncodeHardFailures = 0;
    uint64_t videoSendFailures = 0;
    uint64_t alphaPacketsSent = 0;
    uint64_t alphaEncodeFailures = 0;
    uint64_t alphaEncodeTimeouts = 0;
    uint64_t alphaFramesQueued = 0;
    uint64_t alphaFramesDropped = 0;
    uint64_t alphaSendFailures = 0;
    uint64_t audioSendFailures = 0;
};

struct ConnectionHealth {
    std::string iceMode;
    std::string candidatePath;
    int resolvedIceServers = 0;
    int peerCount = 0;
    int hqPeerCount = 0;
    int lqPeerCount = 0;
    int activeVideoPeers = 0;
    int activeAudioPeers = 0;
    std::string codec;
    std::string encoder;
    double videoBitrateKbps = 0.0;
    double audioBitrateKbps = 0.0;
    double frameRate = 0.0;
    double droppedFrameRate = 0.0;
    int width = 0;
    int height = 0;
    uint64_t videoFramesCaptured = 0;
    uint64_t videoFramesSent = 0;
    uint64_t videoFramesDropped = 0;
    uint64_t videoEncodeFailures = 0;
    uint64_t videoEncodeTimeouts = 0;
    uint64_t videoEncodeHardFailures = 0;
    uint64_t videoSendFailures = 0;
    uint64_t alphaPacketsSent = 0;
    uint64_t alphaEncodeFailures = 0;
    uint64_t alphaEncodeTimeouts = 0;
    uint64_t alphaFramesQueued = 0;
    uint64_t alphaFramesDropped = 0;
    uint64_t alphaSendFailures = 0;
    uint64_t audioSendFailures = 0;
    double systemCpuPercent = -1.0;
    double systemMemoryPercent = -1.0;
    uint64_t systemMemoryUsedBytes = 0;
    uint64_t systemMemoryTotalBytes = 0;
    std::string lastPeerDisconnectReason;
};

struct SourceHealth {
    VideoSourceMode mode = VideoSourceMode::Window;
    std::string sourceId;
    bool hasFrame = false;
    bool bgra = false;
    int width = 0;
    int height = 0;
    uint64_t sampledFrames = 0;
    uint64_t resizeCount = 0;
    double transparentRatio = 0.0;
    double translucentRatio = 0.0;
    double opaqueRatio = 0.0;
    double greenRatio = 0.0;
    double colorContentRatio = 0.0;
    bool alphaDetected = false;
    bool greenBackgroundLikely = false;
    bool largeSource = false;
};

struct StartOptions {
    std::string room;
    std::string password;
    std::string label;
    std::string streamId;
    std::string server = "wss://wss.vdo.ninja:443";
    std::string salt = "vdo.ninja";
    int maxViewers = 10;
    bool roomModeLqEnabled = true;
    bool remoteControlEnabled = false;
    std::string remoteControlToken;
    webrtc::IceMode iceMode = webrtc::IceMode::StunOnly;
};

class VersusApp {
  public:
    using RuntimeEventCallback = std::function<void(const std::string &, bool fatal)>;

    VersusApp();
    ~VersusApp();

    bool initialize();
    void shutdown();

    std::vector<versus::video::WindowInfo> listWindows();
    std::vector<versus::video::WindowInfo> listSpoutSenders();
    std::vector<versus::audio::AudioDeviceInfo> listAudioInputDevices();
    bool startCapture(const std::string &windowId);
    bool startCapture(VideoSourceMode mode, const std::string &sourceId);
    void stopCapture();
    void setSelectedWindow(const std::string &windowId);
    void setVideoSourceMode(VideoSourceMode mode);

    bool goLive(const StartOptions &options);
    void stopLive();

    void setVideoConfig(const versus::video::EncoderConfig &config);
    void setAudioSourceMode(AudioSourceMode mode);
    void setIncludeMicrophone(bool enabled);
    void setMicrophoneDeviceId(const std::string &deviceId);
    void setAudioMixConfig(float primaryGain, float additionalGain, bool limiterEnabled);
    std::string getVideoEncoderName() const;
    std::string getVideoCodecName() const;
    bool isHardwareVideoEncoder() const;
    float getAudioLevelRms() const;
    float getAudioPeak() const;
    float getPrimaryAudioLevelRms() const;
    float getPrimaryAudioPeak() const;
    float getAdditionalAudioLevelRms() const;
    float getAdditionalAudioPeak() const;
    StreamMetrics getStreamMetrics() const;
    ConnectionHealth getConnectionHealth() const;
    SourceHealth getSourceHealth() const;
    std::string buildDiagnosticsJson() const;
    bool writeDiagnosticsJson(const std::string &path) const;

    bool isLive() const { return live_; }

    std::string getShareLink() const;
    void onRuntimeEvent(RuntimeEventCallback cb);

  private:
    struct PeerSession;
    struct PeerCounts {
        int total = 0;
        int hq = 0;
        int lq = 0;
        int activeVideo = 0;
        int activeAudio = 0;
        int roomGuests = 0;
        int roomScenes = 0;
        int roomNonGuestViewers = 0;
    };
    struct VideoStateSnapshot {
        versus::video::EncoderConfig config;
        int hqWidth = 0;
        int hqHeight = 0;
        std::string encoderName;
        std::string codecName;
        std::string encoderInputFormat;
        bool hardwareEncoder = false;
        bool lqEncoderInitialized = false;
        std::string lqEncoderName;
    };
    struct PendingRemoteCandidate {
        std::string uuid;
        std::string session;
        std::string candidate;
        std::string mid;
        int mlineIndex = 0;
        int64_t queuedAtMs = 0;
    };
    void setupCallbacks();
    void startAudioCapture(uint32_t selectedWindowProcessId);
    void handlePrimaryAudioChunk(versus::audio::StreamChunk &&chunk);
    void handleAdditionalAudioChunk(versus::audio::StreamChunk &&chunk);
    void mixAdditionalAudioInto(std::vector<float> &samples, uint32_t sampleRate, uint32_t channels);
    void applyAudioGain(std::vector<float> &samples, float gain) const;
    void applyAudioLimiter(std::vector<float> &samples) const;
    void updateAudioLevelMeters(const std::vector<float> &samples,
                                std::atomic<float> &rmsTarget,
                                std::atomic<float> &peakTarget);
    void encodeNormalizedAudio(std::vector<float> &normalizedSamples);
    StreamMetrics buildStreamMetricsSnapshot(bool updateRecentWindow) const;
    void resetSourceHealth(VideoSourceMode mode, const std::string &sourceId);
    void updateSourceHealthFromFrame(const versus::video::CapturedFrame &frame);
    void resetMetricsWindow(int64_t nowMs);
    void populateSystemResourceUsage(ConnectionHealth &health) const;
    void setupSignalingCallbacks();
    void startSignalingRecovery();
    void stopSignalingRecoveryThread();
    void startVideoMaintenanceThread();
    void stopVideoMaintenanceThread();
    void startEncodeThread();
    void stopEncodeThread();
    void startAlphaEncodeThread();
    void stopAlphaEncodeThread();
    void clearAlphaEncodeQueues();
    void queueAlphaEncodeFrame(int width, int height, int64_t timestamp, std::vector<uint8_t> gray);
    void queueAlphaEncoderReconfigure(versus::video::EncoderConfig config);
    bool takeLatestAlphaPacket(versus::video::EncodedPacket &packet);
    bool hasAnyActiveVideoTrack() const;
    bool hasAnyActiveAudioTrack() const;
    void sendAudioPacketToPeers(const versus::webrtc::EncodedAudioPacket &packet);
    bool applyRuntimeVideoControl(int bitrateKbps,
                                  int &width,
                                  int &height,
                                  int fps,
                                  bool vdoScaleResolutionRequest = false,
                                  bool vdoScaleResolutionCover = false);
    bool applyRuntimeAudioControl(int bitrateKbps);
    void handlePeerDataMessage(const std::shared_ptr<PeerSession> &peer, const std::string &message);
    bool tryHandlePeerSignalMessage(const std::shared_ptr<PeerSession> &peer, const std::string &message);
    void sendPeerDataInfo(const std::shared_ptr<PeerSession> &peer, bool includeMiniStats);
    void sendPeerRemoteStats(const std::shared_ptr<PeerSession> &peer);
    void sendPeerAudioOptions(const std::shared_ptr<PeerSession> &peer);
    void sendPeerVideoOptions(const std::shared_ptr<PeerSession> &peer);
    void sendPeerMediaDevices(const std::shared_ptr<PeerSession> &peer);
    void sendPeerMediaDeviceChange(const std::shared_ptr<PeerSession> &peer,
                                   const char *kind,
                                   bool ok,
                                   const std::string &deviceId,
                                   const std::string &error);
    bool sendPeerOffer(const std::shared_ptr<PeerSession> &peer, const char *reason, bool rebuildPeerConnection = false);
    void applyPeerAnswer(const std::shared_ptr<PeerSession> &peer, const std::string &sdp, const char *source);
    int renegotiatePeersForH264CodecFallback(const char *reason);
    bool fallbackToH264AfterRejectedVideoAnswer(const std::shared_ptr<PeerSession> &peer, const char *source);
    void applyPeerMediaPlan(const std::shared_ptr<PeerSession> &peer, const char *reason);
    bool enforceRoomCodecLock();
    void applyPeerInitState(const std::shared_ptr<PeerSession> &peer,
                            bool roleValid,
                            PeerRole role,
                            bool videoEnabled,
                            bool audioEnabled);
    void pruneTimedOutPeerInits(int64_t nowMs);
    bool ensureLqEncoderInitializedLocked();
    void shutdownLqEncoderLocked();
    bool isControlMessageAuthorized(const std::shared_ptr<PeerSession> &peer, const std::string &token) const;
    bool encodeAndSendVideoFrame(const versus::video::CapturedFrame &frame, bool forceKeyframe);
    bool adaptHqEncoderToFrameLocked(const versus::video::CapturedFrame &frame, int64_t nowMs);
    bool getCachedVideoFrame(versus::video::CapturedFrame &frame);
    std::string makePeerKey(const std::string &uuid, const std::string &session) const;
    std::shared_ptr<PeerSession> findPeerSessionForSignalLocked(const std::string &uuid,
                                                                const std::string &session) const;
    void queuePendingRemoteCandidateLocked(const signaling::SignalCandidate &cand, int64_t nowMs);
    std::vector<PendingRemoteCandidate> takePendingRemoteCandidatesLocked(const std::string &uuid,
                                                                          const std::string &session,
                                                                          int64_t nowMs);
    void drainPendingRemoteCandidates(const std::shared_ptr<PeerSession> &peer, const char *reason);
    void shutdownPeerClientAsync(const std::shared_ptr<PeerSession> &peer);
    void reapCompletedPeerShutdowns();
    void waitForPendingPeerShutdowns();
    void removePeerSession(const std::shared_ptr<PeerSession> &peer, const char *reason);
    void clearPeerSessions();
    void emitRuntimeEvent(const std::string &message, bool fatal);
    void handleVideoFrame(versus::video::CapturedFrame frame);
    void recordPeerEvent(const std::shared_ptr<PeerSession> &peer, const std::string &event) const;
    PeerCounts collectPeerCounts() const;
    VideoStateSnapshot buildVideoStateSnapshotLocked() const;
    void publishVideoStateSnapshotLocked() const;
    VideoStateSnapshot videoStateSnapshot() const;

    std::atomic<bool> live_{false};
    std::atomic<bool> capturing_{false};
    std::atomic<bool> stopRequested_{false};
    std::atomic<bool> reconnecting_{false};
    std::atomic<bool> videoTrackActive_{false};
    std::atomic<bool> pendingGlobalKeyframe_{false};
    std::atomic<bool> captureBackendFailureNotified_{false};
    std::atomic<int64_t> lastVideoSendMs_{0};
    std::atomic<int64_t> lastKeyframeSendMs_{0};
    std::atomic<int64_t> lastPrimaryAudioChunkMs_{0};
    StartOptions startOptions_;
    std::string streamId_;
    std::string room_;
    std::string password_;
    std::string salt_;
    std::string remoteControlToken_;
    std::string selectedWindowId_;
    VideoSourceMode videoSourceMode_ = VideoSourceMode::Window;
    std::atomic<int64_t> audioPts100ns_{0};
    std::atomic<float> audioLevelRms_{0.0f};
    std::atomic<float> audioPeak_{0.0f};
    std::atomic<float> primaryAudioLevelRms_{0.0f};
    std::atomic<float> primaryAudioPeak_{0.0f};
    std::atomic<float> additionalAudioLevelRms_{0.0f};
    std::atomic<float> additionalAudioPeak_{0.0f};
    std::atomic<float> primaryAudioGain_{1.0f};
    std::atomic<float> additionalAudioGain_{1.0f};
    std::atomic<bool> audioLimiterEnabled_{true};
    std::atomic<uint64_t> videoBytesSent_{0};
    std::atomic<uint64_t> audioBytesSent_{0};
    std::atomic<uint64_t> videoFramesCaptured_{0};
    std::atomic<uint64_t> videoFramesSent_{0};
    std::atomic<uint64_t> videoFramesDropped_{0};
    std::atomic<uint64_t> audioPacketsSent_{0};
    std::atomic<uint64_t> videoEncodeFailures_{0};
    std::atomic<uint64_t> videoEncodeTimeouts_{0};
    std::atomic<uint64_t> videoEncodeHardFailures_{0};
    std::atomic<uint64_t> videoSendFailures_{0};
    std::atomic<uint64_t> alphaPacketsSent_{0};
    std::atomic<uint64_t> alphaEncodeFailures_{0};
    std::atomic<uint64_t> alphaEncodeTimeouts_{0};
    std::atomic<uint64_t> alphaFramesQueued_{0};
    std::atomic<uint64_t> alphaFramesDropped_{0};
    std::atomic<uint64_t> alphaSendFailures_{0};
    std::atomic<uint64_t> audioSendFailures_{0};
    std::atomic<int> audioEncoderBitrateKbps_{192};
    std::atomic<int64_t> metricsStartMs_{0};
    std::atomic<int> lastSentWidth_{0};
    std::atomic<int> lastSentHeight_{0};
    std::atomic<int> maxViewers_{10};
    std::atomic<bool> roomModeLqEnabled_{true};
    std::atomic<bool> remoteControlEnabled_{false};
    std::atomic<int64_t> lastRelayWarningMs_{0};
    std::atomic<int64_t> lastPacketLossWarningMs_{0};
    std::atomic<int64_t> lastAlphaWarningMs_{0};
    std::atomic<int64_t> pliWindowStartMs_{0};
    std::atomic<int> pliWindowCount_{0};
    std::atomic<int64_t> lastCpuWarningMs_{0};
    std::atomic<int> softwareOverloadSamples_{0};
    std::atomic<bool> relayCandidateSeen_{false};
    std::atomic<bool> directCandidateSeen_{false};
    std::vector<versus::webrtc::IceServerConfig> resolvedIceServers_;
    versus::webrtc::IceMode iceMode_ = versus::webrtc::IceMode::StunOnly;
    std::thread signalingRecoveryThread_;
    std::thread videoMaintenanceThread_;
    std::atomic<bool> videoMaintenanceRunning_{false};
    std::thread encodeThread_;
    std::atomic<bool> encodeThreadRunning_{false};
    std::mutex encodeNotifyMutex_;
    std::condition_variable encodeFrameCV_;
    bool encodeFrameReady_ = false;
    struct AlphaEncodeJob {
        std::vector<uint8_t> gray;
        int width = 0;
        int height = 0;
        int64_t timestamp = 0;
    };
    std::thread alphaEncodeThread_;
    std::atomic<bool> alphaEncodeThreadRunning_{false};
    std::mutex alphaEncodeMutex_;
    std::condition_variable alphaEncodeCV_;
    AlphaEncodeJob pendingAlphaEncodeJob_;
    bool pendingAlphaEncodeJobReady_ = false;
    versus::video::EncoderConfig pendingAlphaEncoderConfig_{};
    bool pendingAlphaEncoderReconfigure_ = false;
    std::mutex alphaEncoderMutex_;
    std::mutex alphaPacketMutex_;
    versus::video::EncodedPacket latestAlphaPacket_;
    bool latestAlphaPacketReady_ = false;
    mutable std::mutex peerSessionsMutex_;
    std::mutex peerShutdownTasksMutex_;
    mutable std::mutex signalingOpsMutex_;
    mutable std::mutex iceConfigMutex_;
    mutable std::mutex runtimeEventMutex_;
    mutable std::mutex additionalAudioMutex_;
    std::mutex audioEncodeMutex_;
    mutable std::mutex healthStateMutex_;
    mutable std::mutex sourceHealthMutex_;
    SourceHealth sourceHealth_;
    mutable std::mutex metricsWindowMutex_;
    mutable int64_t recentMetricsLastMs_ = 0;
    mutable uint64_t recentMetricsLastVideoBytes_ = 0;
    mutable uint64_t recentMetricsLastAudioBytes_ = 0;
    mutable uint64_t recentMetricsLastVideoFrames_ = 0;
    mutable uint64_t recentMetricsLastDroppedFrames_ = 0;
    mutable double recentVideoBitrateKbps_ = 0.0;
    mutable double recentAudioBitrateKbps_ = 0.0;
    mutable double recentFrameRate_ = 0.0;
    mutable double recentDroppedFrameRate_ = 0.0;
    mutable bool recentMetricsInitialized_ = false;
    mutable std::mutex systemResourceMutex_;
    mutable bool systemCpuSampleInitialized_ = false;
    mutable uint64_t lastSystemIdleTime_ = 0;
    mutable uint64_t lastSystemKernelTime_ = 0;
    mutable uint64_t lastSystemUserTime_ = 0;
    mutable double lastSystemCpuPercent_ = -1.0;
    std::string lastPeerDisconnectReason_;
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
        // VDO.Ninja uses this as a routing hint ("local" vs "remote"), not candidate transport type.
        std::string candidateType = "local";
        int64_t createdAtMs = 0;
        bool answerReceived = false;
        bool offerDispatched = false;
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
        std::string alphaReceiveMode;
        std::atomic<bool> alphaAllowed{false};
        std::atomic<bool> sawPeerInfoMessage{false};
        std::atomic<bool> waitingForKeyframe{true};
        std::atomic<bool> dataChannelOpen{false};
        std::atomic<int64_t> disconnectedSinceMs{0};
        std::atomic<bool> statsContinuous{false};
        std::atomic<int> requestedVideoBitrateKbps{-1};
        std::atomic<int> requestedAudioBitrateKbps{-1};
        std::atomic<bool> renegotiationQueued{false};
        std::atomic<bool> codecFallbackAttempted{false};
        std::atomic<int64_t> lastStateChangeMs{0};
        std::atomic<int> offerCount{0};
        std::atomic<int> recoveryOfferCount{0};
        std::atomic<int> answerCount{0};
        std::atomic<int> localCandidatesSent{0};
        std::atomic<int> remoteCandidatesApplied{0};
        std::atomic<int> rejectedControlCount{0};
        mutable std::mutex diagnosticsMutex;
        std::string lastConnectionState = "new";
        std::string lastOfferReason;
        std::string lastAnswerSource;
        std::string lastRemovalReason;
        std::deque<std::string> timeline;
        std::mutex mediaPlanMutex;
        std::vector<PendingCandidate> pendingCandidates;
        std::unique_ptr<versus::webrtc::WebRtcClient> client;
    };
    std::unordered_map<std::string, std::shared_ptr<PeerSession>> peerSessions_;
    std::unordered_map<std::string, std::vector<PendingRemoteCandidate>> pendingRemoteCandidates_;
    std::vector<std::future<void>> peerShutdownFutures_;
    versus::video::EncoderConfig videoConfig_{};
    std::atomic<int> configuredVideoBitrateKbps_{12000};
    mutable std::mutex videoSendMutex_;
    mutable std::mutex videoStateSnapshotMutex_;
    mutable VideoStateSnapshot cachedVideoStateSnapshot_;
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
    int hardwareEncodeSampleCount_ = 0;
    int hardwareEncodeFailCount_ = 0;
    int hardwareRecoveryAttemptCount_ = 0;
    bool hardwareAutoFallbackTriggered_ = false;
    int softwareExternalEncodeFailCount_ = 0;
    int64_t softwareExternalFailWindowStartMs_ = 0;
    std::atomic<bool> lqEncoderInitialized_{false};
    bool roomCodecWarningEmitted_ = false;
    AudioSourceMode audioSourceMode_ = AudioSourceMode::SelectedWindow;
    bool includeMicrophone_ = false;
    std::string microphoneDeviceId_;
    std::string activeMicrophoneSourceName_ = "default-microphone";
    std::deque<float> additionalAudioBuffer_;
    uint32_t additionalAudioSampleRate_ = 0;
    uint32_t additionalAudioChannels_ = 0;

    versus::video::WindowCapture windowCapture_;
    versus::video::SpoutCapture spoutCapture_;
    versus::video::VideoEncoder videoEncoder_;
    versus::video::VideoEncoder videoEncoderLq_;
    versus::video::VideoEncoder videoEncoderAlpha_;
    std::vector<uint8_t> alphaGrayBuffer_;
    std::vector<uint8_t> alphaCompositeBuffer_;
    versus::audio::WindowAudioCaptureCore audioCapture_;
    versus::audio::WindowAudioCaptureCore microphoneAudioCapture_;
    versus::audio::OpusEncoder opusEncoder_;
    versus::signaling::VdoSignaling signaling_;
};

}  // namespace versus::app
