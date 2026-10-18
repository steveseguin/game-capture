#pragma once
#include "versus/video/video_encoder.h"

namespace versus::platform {
// The subprocess and its Qt objects live on one owned worker thread. Callers
// submit at most one frame and receive its verified IVF identity synchronously.
class PosixFfmpegEncoder {
public:
    PosixFfmpegEncoder();
    ~PosixFfmpegEncoder();
    bool initialize(const video::EncoderConfig &);
    void shutdown();
    bool encode(const video::CapturedFrame &, video::EncodedPacket &, int64_t sourceTimestamp);
    void setBitrate(int);
    void requestKeyframe();
    video::EncodeFailureKind lastFailure() const;
private:
    struct State;
    std::unique_ptr<State> state_;
};
}
