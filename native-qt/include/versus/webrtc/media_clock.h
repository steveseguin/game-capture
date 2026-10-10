#pragma once

#include <chrono>
#include <cstdint>

namespace versus::webrtc {

// Capture timestamps, audio timestamps and RTP sender reports share this clock.
inline int64_t mediaTime100ns() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count() / 100;
}

inline uint32_t mediaRtpTimestamp(int64_t time100ns, uint32_t rate) {
    // Divide before multiplying: QPC uptime can exceed the range of time * rate.
    return static_cast<uint32_t>((time100ns / 10000000) * rate +
        (time100ns % 10000000) * rate / 10000000);
}

class MediaClock {
  public:
    MediaClock() : steadyOrigin_(mediaTime100ns()), unixOrigin_(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count() / 100) {}

    uint64_t ntpTimestamp(int64_t time100ns) const {
        const auto unixTime = unixOrigin_ + time100ns - steadyOrigin_;
        const uint64_t seconds = static_cast<uint64_t>(unixTime / 10000000) + 2208988800ULL;
        const uint64_t fraction = static_cast<uint64_t>(unixTime % 10000000);
        return (seconds << 32) | ((fraction << 32) / 10000000);
    }

  private:
    const int64_t steadyOrigin_;
    const int64_t unixOrigin_;
};
} // namespace versus::webrtc
