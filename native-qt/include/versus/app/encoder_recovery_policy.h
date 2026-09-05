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

// Avoid readback when an encoder is busy and already has its next image queued.
// While it waits for an output slot, allow replacing that one queued image with
// fresher content. Rejecting these idle-time captures couples two independent
// pacers and can discard every other image even when encoding keeps up.
inline bool shouldAdmitCapturedFrame(
    bool live,
    bool encodeThreadRunning,
    bool pendingFrameReady,
    bool encodeInProgress) {
    return !live || (encodeThreadRunning && (!pendingFrameReady || !encodeInProgress));
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
