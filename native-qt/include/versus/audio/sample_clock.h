#pragma once

#include <cstdint>

namespace versus::audio {

// Duration of normalized 48 kHz PCM in 100-ns units. Carry the fractional
// remainder across callbacks so callback size cannot change the clock rate.
class SampleClockFraction {
public:
    constexpr void reset() { remainder_ = 0; }
    constexpr int64_t duration100ns(uint32_t frames) {
        const uint64_t numerator = uint64_t(frames) * 10000000 + remainder_;
        remainder_ = numerator % 48000;
        return static_cast<int64_t>(numerator / 48000);
    }

private:
    uint32_t remainder_ = 0;
};

} // namespace versus::audio
