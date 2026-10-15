#pragma once

#include "versus/webrtc/webrtc_client.h"
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace versus::output {

enum class Protocol { VdoNinja, Whip, Srt, Rtmp, Rtsp, RtspUdp, Udp, Rist };
const char *protocolName(Protocol protocol);
Protocol parseProtocol(const std::string &name);
inline bool isRtsp(Protocol protocol) { return protocol == Protocol::Rtsp || protocol == Protocol::RtspUdp; }

struct Config {
    Protocol protocol = Protocol::VdoNinja;
    std::string url;
    std::string bearerToken;
    std::string streamKey;
    std::string streamId;
    std::string passphrase;
    int latencyMs = 200;
    int aacBitrateKbps = 192;
};

// Errors and destination labels never include URL paths, query strings or keys.
std::string validateConfig(const Config &config);
std::string destinationLabel(const Config &config);
std::string destinationUrl(const Config &config);

struct MediaConfig {
    int width = 1920, height = 1080, fps = 60;
    int videoBitrateKbps = 4000;
    int audioChannels = 2;
    bool audioEnabled = true;
    webrtc::IceMode iceMode = webrtc::IceMode::All;
    std::string ffmpegPath;
};

enum class State { Stopped, Connecting, Live, Reconnecting, Error };
struct Status {
    State state = State::Stopped;
    std::string message;
    uint64_t reconnects = 0, videoPackets = 0, audioPackets = 0;
    uint64_t videoBytes = 0, audioBytes = 0, queuedBytes = 0;
    int64_t processId = 0;
    int64_t receiverReportAgeMs = -1, receiverReportTimeoutMs = 0;
    uint64_t receiverReports = 0;
    std::string icePath;
    int videoPlayoutMs = 0;
    bool videoNack = false, videoPli = false, videoRtx = false;
    uint64_t retransmitted = 0, repairMisses = 0;
};

// One destination per capture session. Network and muxer work run on an owned
// worker; capture callbacks only append to a bounded queue.
class Session {
  public:
    Session(Config config, MediaConfig media, std::function<void()> requestKeyframe);
    ~Session();
    Session(const Session &) = delete;
    Session &operator=(const Session &) = delete;
    bool start();
    void stop();
    bool wantsVideo() const;
    bool wantsAudio() const;
    bool usesPcmInput() const;
    bool sendVideo(const webrtc::EncodedVideoPacket &packet, int width, int height);
    bool sendOpus(const webrtc::EncodedAudioPacket &packet);
    bool sendPcm(const std::vector<float> &stereo48k, int64_t pts);
    Status status() const;
  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace versus::output
