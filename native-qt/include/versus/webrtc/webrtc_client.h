#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <rtc/common.hpp>

#include "versus/webrtc/ice_config.h"

namespace versus::webrtc {

struct EncodedVideoPacket {
    std::vector<uint8_t> data;
    int64_t pts = 0;
    bool isKeyframe = false;
};

struct EncodedAudioPacket {
    std::vector<uint8_t> data;
    int64_t pts = 0;
    uint32_t sampleRate = 48000;
    uint16_t channels = 2;
};

struct PeerConfig {
    std::vector<IceServerConfig> iceServers;
    IceMode iceMode = IceMode::All;
    TurnRegistryProvenance turnRegistry;
    enum class VideoCodec {
        H264,
        H265,
        AV1,
        VP9
    };
    VideoCodec videoCodec = VideoCodec::H264;
    bool enableAlphaTrack = false;
    bool enableDataChannel = true;
    bool initialVideo = false;
    bool initialAudio = false;
    bool initialAlpha = false;
    int videoWidth = 1920;
    int videoHeight = 1080;
    int videoFps = 60;
};

enum class ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Failed,
    Closed
};

struct MediaPlanChange {
    bool changed = false;
    bool videoAdded = false;
    bool alphaAdded = false;
    bool audioAdded = false;
};

class WebRtcClientTestAccess;

class WebRtcClient {
  public:
    using IceCandidateCallback = std::function<void(const std::string &candidate,
                                                    const std::string &mid,
                                                    int mlineIndex,
                                                    uint64_t transportGeneration)>;
    using StateCallback = std::function<void(ConnectionState, uint64_t transportGeneration)>;
    using KeyframeRequestCallback = std::function<void(uint64_t transportGeneration)>;
    using DataMessageCallback = std::function<void(const std::string &message,
                                                   uint64_t transportGeneration)>;
    using DataChannelStateCallback = std::function<void(bool open, uint64_t transportGeneration)>;

    WebRtcClient();
    ~WebRtcClient();
    WebRtcClient(const WebRtcClient &) = delete;
    WebRtcClient &operator=(const WebRtcClient &) = delete;
    WebRtcClient(WebRtcClient &&) = delete;
    WebRtcClient &operator=(WebRtcClient &&) = delete;

    bool initialize(const PeerConfig &config);
    void shutdown();
    bool resetPeerConnection(bool initialVideo = false, bool initialAudio = false, bool initialAlpha = false);
    void setVideoCodec(PeerConfig::VideoCodec codec, bool enableAlphaTrack = false);

    bool setRemoteDescription(const std::string &sdp, const std::string &type);
    std::string createOffer();
    std::string createAnswer(const std::string &offer);
    bool addRemoteCandidate(const std::string &candidate, const std::string &mid, int mlineIndex);

    void prepareForShutdown();
    void setIceCandidateCallback(IceCandidateCallback cb);
    void setStateCallback(StateCallback cb);
    void setKeyframeRequestCallback(KeyframeRequestCallback cb);
    void setDataMessageCallback(DataMessageCallback cb);
    void setDataChannelStateCallback(DataChannelStateCallback cb);
    MediaPlanChange ensureMediaTracks(bool enableVideo, bool enableAudio, bool enableAlpha);

    bool sendVideo(const EncodedVideoPacket &packet);
    bool sendAlphaVideo(const EncodedVideoPacket &packet);
    bool sendAudio(const EncodedAudioPacket &packet);
    bool sendDataMessage(const std::string &message);
    bool isDataChannelOpen() const;
    ConnectionState connectionState() const;
    uint64_t transportGeneration() const;
    bool hasActiveVideoTrack() const;
    bool hasActiveAlphaVideoTrack() const;
    bool hasActiveAudioTrack() const;
    bool hasConfiguredVideoTrack() const;
    bool hasConfiguredAudioTrack() const;

  private:
    friend class WebRtcClientTestAccess;

    void setConcurrencyTestHooks(std::function<void(uint64_t)> beforeVideoSend,
                                 std::function<void(uint64_t)> beforeCallbackAdmission,
                                 std::function<void(uint64_t)> afterTransportClose,
                                 std::function<void(uint64_t)> beforeStateCommit);
    void invokeDataMessageCallbackForTesting(const std::string &message,
                                             uint64_t transportGeneration);
    void invokeIceCandidateCallbackForTesting(
        const std::string &candidate,
        const std::string &mid,
        int mlineIndex,
        uint64_t transportGeneration);
    void invokeStateCallbackForTesting(ConnectionState state,
                                       uint64_t transportGeneration);
    void invokeDataChannelStateCallbackForTesting(bool open,
                                                  uint64_t transportGeneration);
    std::size_t callbacksInFlightForTesting() const;
    std::pair<uint16_t, uint16_t> vp9SequenceNumbersForTesting() const;

    struct Impl;
    // libdatachannel callbacks can finish after a transport has been retired.
    // Keeping Impl shared lets callbacks hold only a weak reference instead of
    // dereferencing a destroyed WebRtcClient.
    std::shared_ptr<Impl> impl_;
};

}  // namespace versus::webrtc
