#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
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
    // Dual-track alpha receivers consume the alpha frame already cached for
    // the primary frame's RTP timestamp. Startup/recovery therefore requires
    // every VP9 packet from both protected tracks to be independently
    // decodable; user FFmpeg options may not weaken this contract.
    bool requireEveryFrameKeyframe = false;
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
    // Identity of the CapturedFrame that produced this packet. This remains
    // independent of backend encoder PTS/DTS, which may be a private frame
    // counter or otherwise diverge between primary and alpha encoders.
    int64_t sourceTimestamp = std::numeric_limits<int64_t>::min();
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

namespace detail {

struct FfmpegOptionPolicyResult {
    std::vector<std::string> args;
    std::vector<std::string> rejectedOptions;
};

enum class H264BitstreamFormat {
    Auto,
    AnnexB,
    Avcc,
};

// Reports whether an H.264 access unit contains an IDR VCL NAL. Parameter-set
// NALs alone are configuration, not random-access pictures.
bool h264AccessUnitIsKeyframe(
    const std::vector<uint8_t> &accessUnit,
    H264BitstreamFormat format = H264BitstreamFormat::Auto);

// Dependency-injected orchestration used by the Media Foundation path after a
// warm-up packet has been observed. The callbacks are also an observation seam
// for proving that a warmed activation can never become the live encoder.
struct MediaFoundationWarmupLifecycle {
    std::function<void()> releaseWarmedTransform;
    std::function<bool()> shutdownActivation;
    std::function<bool()> activateFreshTransform;
    std::function<bool()> configureFreshTransform;
    std::function<void()> clearLiveIdentityState;
};

bool prepareFreshMediaFoundationEncoderAfterWarmup(
    const MediaFoundationWarmupLifecycle &lifecycle);

// The external FFmpeg process can continue consuming stdin while producing no
// stdout. Bound source identities independently of the small input queue so a
// stalled encoder cannot grow memory indefinitely or later mislabel output.
class BoundedSourceTimestampQueue {
  public:
    explicit BoundedSourceTimestampQueue(std::size_t capacity = 16);

    bool tryPush(int64_t sourceTimestamp);
    bool tryPop(int64_t &sourceTimestamp);
    void clear();
    std::size_t size() const;
    std::size_t capacity() const;

  private:
    std::size_t capacity_;
    std::deque<int64_t> timestamps_;
};

// Appends only explicitly timing-neutral custom options in protected mode,
// then appends mandatory values last. Unknown/current-future FFmpeg aliases
// therefore cannot weaken codec, GOP, latency, topology, or frame identity.
FfmpegOptionPolicyResult appendProtectedVp9Options(
    std::vector<std::string> baseArgs,
    const std::vector<std::string> &customArgs);

// IVF carries raw codec frames. These helpers derive random-access status from
// the encoded payload rather than trusting the configured GOP intent.
bool vp9FrameIsKeyframe(const std::vector<uint8_t> &packet);
bool ivfFrameIsKeyframe(VideoCodec codec, const std::vector<uint8_t> &packet);
bool protectedVp9RuntimeContractHealthy(bool initialized,
                                        bool requireEveryFrameKeyframe,
                                        VideoCodec activeCodec,
                                        const std::string &activeEncoderName,
                                        bool mostRecentProtectedPacketHealthy);

}  // namespace detail

class VideoEncoder {
  public:
    VideoEncoder();
    ~VideoEncoder();

    bool initialize(const EncoderConfig &config);
    void shutdown();

    bool encode(const CapturedFrame &frame, EncodedPacket &packet);
    // Encodes using the frame's normal timing while attaching an explicit,
    // caller-owned source identity to the eventual delayed output packet.
    bool encodeWithSourceTimestamp(const CapturedFrame &frame,
                                   EncodedPacket &packet,
                                   int64_t sourceTimestamp);
    void setBitrate(int kbps);
    void requestKeyframe();
    bool guaranteesEveryFrameKeyframe() const;
    VideoCodec activeCodec() const;
    std::string activeCodecName() const;
    std::string activeEncoderName() const;
    std::string activeInputFormatName() const;
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
    std::atomic<bool> protectedPacketContractHealthy_{false};
};

}  // namespace versus::video
