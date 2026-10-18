#pragma once

#include "versus/video/video_encoder.h"

namespace versus::platform {
// Native implementation behind VideoEncoder's packet facade. VT waits for one
// native frame; VFR x264 retains at most one accepted frame for its next input.
class MacVideoEncoder {
public:
    MacVideoEncoder();
    ~MacVideoEncoder();
    bool initialize(const video::EncoderConfig &, bool handover = false);
    bool primeHandover(const video::CapturedFrame &) { return false; }
    void shutdown();
    bool encode(const video::CapturedFrame &, video::EncodedPacket &, int64_t sourceTimestamp,
                int64_t presentationTimestamp);
    void setBitrate(int kbps);
    void requestKeyframe();
    video::VideoCodec activeCodec() const;
    std::string activeCodecName() const;
    std::string activeEncoderName() const;
    std::string activeInputFormatName() const;
    bool isHardwareEncoder() const;
    video::EncodeFailureKind lastEncodeFailureKind() const;
private:
    struct State;
    std::unique_ptr<State> state_;
};
} // namespace versus::platform
