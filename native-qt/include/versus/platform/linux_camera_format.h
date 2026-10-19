#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <tuple>

namespace versus::video::detail {
// Preserve the closest requested size, then avoid a known frame-rate deficit.
// Raw formats still win ties (including drivers without interval enumeration).
// A 1% tolerance keeps 29.97 fps equivalent to a requested 30 fps.
inline auto linuxCameraFormatRank(int width, int height, int requestedWidth,
                                 int requestedHeight, int requestedFps,
                                 double maximumFps, bool compressed) {
    const int64_t distance = std::abs(int64_t(width) - requestedWidth) +
                             std::abs(int64_t(height) - requestedHeight);
    const double shortfall = maximumFps > 0 ?
        std::max(0.0, requestedFps * 0.99 - maximumFps) : 0.0;
    return std::tuple{distance, shortfall, compressed};
}
} // namespace versus::video::detail
