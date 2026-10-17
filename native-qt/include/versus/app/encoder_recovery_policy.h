#pragma once

#include <cstddef>

#include "versus/video/video_encoder.h"

namespace versus::app {

enum class SoftwareEncoderFailureDisposition {
    Transient,
    CountedFailure,
    ImmediateFallback,
};

inline SoftwareEncoderFailureDisposition classifySoftwareEncoderFailure(
    video::EncodeFailureKind failureKind) {
    switch (failureKind) {
        case video::EncodeFailureKind::Timeout:
        case video::EncodeFailureKind::Backpressure:
            return SoftwareEncoderFailureDisposition::Transient;
        case video::EncodeFailureKind::OutputStalled:
            return SoftwareEncoderFailureDisposition::ImmediateFallback;
        case video::EncodeFailureKind::None:
        case video::EncodeFailureKind::ProcessExited:
        case video::EncodeFailureKind::IoFailure:
        case video::EncodeFailureKind::InvalidInput:
        case video::EncodeFailureKind::Unsupported:
            return SoftwareEncoderFailureDisposition::CountedFailure;
    }
    return SoftwareEncoderFailureDisposition::CountedFailure;
}

// Keep capture admission bounded by the caller-provided queue capacity. This
// lets capture/readback absorb short scheduler jitter without allowing an
// unbounded queue to accumulate and make input or the desktop feel laggy.
inline bool shouldAdmitCapturedFrame(
    bool live,
    bool encodeThreadRunning,
    size_t pendingFrameCount,
    size_t pendingFrameCapacity) {
    return !live ||
        (encodeThreadRunning && pendingFrameCount < pendingFrameCapacity);
}

// The encoder sleeps until a newly captured frame is pending. There is no
// timer-only wakeup that can re-encode cached pixels.
inline bool freshFrameWaitComplete(bool encodeThreadRunning,
                                   bool pendingFrameReady) {
    return !encodeThreadRunning || pendingFrameReady;
}

}  // namespace versus::app
