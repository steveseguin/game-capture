#pragma once

#include <algorithm>
#include <cmath>

namespace versus::video {

struct AspectFitRect {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

inline AspectFitRect computeAspectFitRect(int srcW, int srcH, int dstW, int dstH) {
    AspectFitRect rect;
    if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
        return rect;
    }

    const double scale = std::min(
        static_cast<double>(dstW) / static_cast<double>(srcW),
        static_cast<double>(dstH) / static_cast<double>(srcH));
    rect.width = std::clamp(static_cast<int>(std::lround(static_cast<double>(srcW) * scale)), 1, dstW);
    rect.height = std::clamp(static_cast<int>(std::lround(static_cast<double>(srcH) * scale)), 1, dstH);
    rect.x = (dstW - rect.width) / 2;
    rect.y = (dstH - rect.height) / 2;
    return rect;
}

}  // namespace versus::video

