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

// A frame taking slightly longer than its interval should not halve throughput
// by discarding the next slot. Permit one late slot, but discard the backlog
// after a long encode or reconfiguration stall.
inline std::chrono::steady_clock::time_point outputFrameDeadlineAfterEncode(
    std::chrono::steady_clock::time_point scheduledDeadline,
    std::chrono::steady_clock::time_point now,
    std::chrono::nanoseconds interval) {
    const auto next = scheduledDeadline + interval;
    return now < next + interval ? next
                                : advanceOutputFrameDeadline(scheduledDeadline, now, interval);
}

// Match the pacer's one-late-slot allowance when an output task blocks before
// encoding (for example on the encoder reconfiguration mutex).
inline bool outputFrameSlotExpired(
    int64_t scheduledTimestamp100ns,
    std::chrono::steady_clock::time_point now,
    std::chrono::nanoseconds interval) {
    const auto deadline = std::chrono::steady_clock::time_point(
        std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::nanoseconds(scheduledTimestamp100ns * 100)));
    return now >= deadline + 2 * interval;
}

}  // namespace versus::app
