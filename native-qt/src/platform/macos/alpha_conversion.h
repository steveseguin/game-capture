#pragma once
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>

namespace versus::platform::detail {

// Preserve the exact rounded/clamped byte conversion without three integer
// divisions per pixel on the capture thread. The immutable 64 KiB table covers
// all channel/alpha inputs, including malformed premultiplied values > alpha.
inline void unpremultiplyBgra(uint8_t *pixels, size_t byteCount) {
    static const auto channels = [] {
        std::array<uint8_t, 256 * 256> values{};
        for (unsigned a = 1; a < 256; ++a)
            for (unsigned c = 0; c < 256; ++c)
                values[a * 256 + c] = uint8_t(std::min(255u, (c * 255 + a / 2) / a));
        return values;
    }();
    for (size_t i = 0; i + 3 < byteCount; i += 4) {
        const auto *row = channels.data() + unsigned(pixels[i + 3]) * 256;
        pixels[i] = row[pixels[i]];
        pixels[i + 1] = row[pixels[i + 1]];
        pixels[i + 2] = row[pixels[i + 2]];
    }
}

} // namespace versus::platform::detail
