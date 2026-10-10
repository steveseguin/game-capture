#pragma once

#include "versus/webrtc/media_clock.h"
#include "versus/webrtc/webrtc_client.h"
#include <algorithm>
#include <mutex>

namespace versus::webrtc {

// Observe authenticated RTCP receiver reports, without changing media clocks.
// Learn that a receiver reports regularly before using silence as a failure
// signal. Receivers without reports retain ordinary ICE failure detection.
class ReceiverFeedback {
  public:
    void received() {
        const auto now = mediaTime100ns() / 10000;
        std::lock_guard lock(mutex_);
        if (lastMs_) longestGapMs_ = std::max(longestGapMs_, now - lastMs_);
        else firstMs_ = now;
        lastMs_ = now;
        ++reports_;
    }
    ReceiverFeedbackStatus status() const {
        std::lock_guard lock(mutex_);
        ReceiverFeedbackStatus result;
        result.reports = reports_;
        if (lastMs_) result.ageMs = std::max<int64_t>(0, mediaTime100ns() / 10000 - lastMs_);
        if (reports_ >= 3 && lastMs_ - firstMs_ >= 10000)
            result.timeoutMs = std::clamp<int64_t>(longestGapMs_ * 3 + 1000, 15000, 60000);
        return result;
    }
  private:
    mutable std::mutex mutex_;
    int64_t firstMs_ = 0, lastMs_ = 0, longestGapMs_ = 0;
    uint64_t reports_ = 0;
};
} // namespace versus::webrtc
