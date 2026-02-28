#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace versus::audio {

struct AudioEncoderConfig {
    int sampleRate = 48000;
    int channels = 2;
    int bitrate = 192;
};

struct EncodedAudioPacket {
    std::vector<uint8_t> data;
    int64_t pts = 0;
    int sampleRate = 48000;
    int channels = 2;
};

class OpusEncoder {
  public:
    using PacketCallback = std::function<void(const EncodedAudioPacket &)>;

    OpusEncoder();
    ~OpusEncoder();

    bool initialize(const AudioEncoderConfig &config);
    void shutdown();

    bool encode(const std::vector<float> &samples, int sampleRate, int channels, int64_t pts);
    void setPacketCallback(PacketCallback cb) { packetCallback_ = std::move(cb); }

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    AudioEncoderConfig config_;
    PacketCallback packetCallback_;
    bool initialized_ = false;
};

}  // namespace versus::audio
