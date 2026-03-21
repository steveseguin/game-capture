#pragma once

#include <functional>
#include <memory>
#include <string>
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
    enum class VideoCodec {
        H264,
        H265,
        AV1
    };
    VideoCodec videoCodec = VideoCodec::H264;
    int videoWidth = 1920;
    int videoHeight = 1080;
    int videoFps = 60;
};

enum class ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Failed
};

struct MediaPlanChange {
    bool changed = false;
    bool videoAdded = false;
    bool audioAdded = false;
};

class WebRtcClient {
  public:
    using IceCandidateCallback = std::function<void(const std::string &candidate, const std::string &mid, int mlineIndex)>;
    using StateCallback = std::function<void(ConnectionState)>;
    using KeyframeRequestCallback = std::function<void()>;
    using DataMessageCallback = std::function<void(const std::string &message)>;
    using DataChannelStateCallback = std::function<void(bool open)>;

    WebRtcClient();
    ~WebRtcClient();

    bool initialize(const PeerConfig &config);
    void shutdown();
    void resetPeerConnection();  // Create fresh PeerConnection for new viewer

    bool setRemoteDescription(const std::string &sdp, const std::string &type);
    std::string createOffer();
    std::string createAnswer(const std::string &offer);
    void addRemoteCandidate(const std::string &candidate, const std::string &mid, int mlineIndex);

    void setIceCandidateCallback(IceCandidateCallback cb);
    void setStateCallback(StateCallback cb);
    void setKeyframeRequestCallback(KeyframeRequestCallback cb);
    void setDataMessageCallback(DataMessageCallback cb);
    void setDataChannelStateCallback(DataChannelStateCallback cb);
    MediaPlanChange ensureMediaTracks(bool enableVideo, bool enableAudio);

    bool sendVideo(const EncodedVideoPacket &packet);
    bool sendAudio(const EncodedAudioPacket &packet);
    bool sendDataMessage(const std::string &message);
    bool isDataChannelOpen() const;
    bool hasActiveVideoTrack() const;
    bool hasActiveAudioTrack() const;
    bool hasConfiguredVideoTrack() const;
    bool hasConfiguredAudioTrack() const;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace versus::webrtc
