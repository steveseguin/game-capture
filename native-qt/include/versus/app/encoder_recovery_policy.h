#pragma once

#include "versus/video/video_encoder.h"

#include <algorithm>
#include <chrono>

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

// Keep at most one captured frame waiting behind the frame currently being
// encoded. This lets capture/readback overlap the encoder without allowing an
// unbounded queue to accumulate and make input or the desktop feel laggy.
inline bool shouldAdmitCapturedFrame(
    bool live,
    bool encodeThreadRunning,
    bool pendingFrameReady) {
    return !live || (encodeThreadRunning && !pendingFrameReady);
}

inline std::chrono::nanoseconds outputFrameInterval(int fps) {
    return std::chrono::nanoseconds(
        1000000000LL / std::max(1, fps));
}

// Advance one output slot without trying to encode a burst of stale frames
// after a delayed encoder call or a scheduler stall.
inline std::chrono::steady_clock::time_point advanceOutputFrameDeadline(
    std::chrono::steady_clock::time_point deadline,
    std::chrono::steady_clock::time_point now,
    std::chrono::nanoseconds interval) {
    deadline += interval;
    if (deadline <= now) {
        const auto overdue = now - deadline;
        deadline += interval * ((overdue / interval) + 1);
    }
    return deadline;
}

inline int64_t outputFrameTimestamp100ns(
    std::chrono::steady_clock::time_point deadline) {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               deadline.time_since_epoch())
               .count() /
        100;
}

}  // namespace versus::app
