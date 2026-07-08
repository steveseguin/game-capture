#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace versus::video {

struct CapturedFrame;

enum class VideoCodec {
    H264,
    H265,
    VP8,
    VP9,
    AV1
};

enum class HardwareEncoder {
    None,
    NVENC,
    QuickSync,
    AMF
};

enum class AlphaBackgroundMode {
    None,
    Chroma,
    Opaque
};

enum class EncodeFailureKind {
    None,
    Timeout,
    Backpressure,
    ProcessExited,
    IoFailure,
    InvalidInput,
    Unsupported
};

struct EncoderConfig {
    VideoCodec codec = VideoCodec::H264;
    HardwareEncoder preferredHardware = HardwareEncoder::NVENC;
    bool forceFfmpegNvenc = false;
    std::string ffmpegPath;
    std::string ffmpegOptions;
    bool enableAlpha = false;
    AlphaBackgroundMode alphaBackgroundMode = AlphaBackgroundMode::None;
    uint8_t alphaBackgroundRed = 0;
    uint8_t alphaBackgroundGreen = 255;
    uint8_t alphaBackgroundBlue = 0;
    int width = 1920;
    int height = 1080;
    int frameRate = 60;
    int bitrate = 12000;
    int minBitrate = 8000;
    int maxBitrate = 20000;
    int gopSize = 60;
    int bFrames = 0;
    bool lowLatency = true;
};

struct EncodedPacket {
    std::vector<uint8_t> data;
    int64_t pts = 0;
    int64_t dts = 0;
    bool isKeyframe = false;
    VideoCodec codec = VideoCodec::H264;
};

struct FfmpegProbeInfo {
    bool resolved = false;
    bool bundled = false;
    bool userOverride = false;
    bool hasLibvpxVp9 = false;
    bool gplEnabled = false;
    bool nonfreeEnabled = false;
    std::string path;
    std::string version;
    std::string configuration;
    std::string error;
};

class VideoEncoder {
  public:
    VideoEncoder();
    ~VideoEncoder();

    bool initialize(const EncoderConfig &config);
    void shutdown();

    bool encode(const CapturedFrame &frame, EncodedPacket &packet);
    void setBitrate(int kbps);
    void requestKeyframe();
    VideoCodec activeCodec() const;
    std::string activeCodecName() const;
    std::string activeEncoderName() const;
    bool isHardwareEncoderActive() const;
    EncodeFailureKind lastEncodeFailureKind() const;

    static std::string resolveFfmpegPath(const std::string &configuredPath = {});
    static FfmpegProbeInfo probeFfmpeg(const std::string &configuredPath = {});

    using PacketCallback = std::function<void(const EncodedPacket &)>;
    void setPacketCallback(PacketCallback cb) { packetCallback_ = std::move(cb); }

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    EncoderConfig config_;
    PacketCallback packetCallback_;
    bool initialized_ = false;
};

}  // namespace versus::video
