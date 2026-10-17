#pragma once

#include <arm_neon.h>
#include <cstdint>

namespace versus::platform::detail {

// Two even-width rows of straight BGRA to limited-range BT.601 I420.
// Preserve the existing integer contract: round each 2x2 RGB average before
// applying the chroma matrix. Alpha never participates in the color track.
inline void bgraRowsToI420(const uint8_t *top, const uint8_t *bottom, int width,
                          uint8_t *yTop, uint8_t *yBottom, uint8_t *u, uint8_t *v) {
    const auto luma = [](uint8x8_t b, uint8x8_t g, uint8x8_t r) {
        auto sum = vmull_u8(r, vdup_n_u8(66));
        sum = vmlal_u8(sum, g, vdup_n_u8(129));
        sum = vmlal_u8(sum, b, vdup_n_u8(25));
        return vadd_u8(vrshrn_n_u16(sum, 8), vdup_n_u8(16));
    };
    const auto average = [](uint8x16_t a, uint8x16_t b) {
        return vreinterpretq_s16_u16(vrshrq_n_u16(
            vaddq_u16(vpaddlq_u8(a), vpaddlq_u8(b)), 2));
    };
    int x = 0;
    for (; x + 16 <= width; x += 16) {
        const auto a = vld4q_u8(top + x * 4);
        const auto b = vld4q_u8(bottom + x * 4);
        vst1_u8(yTop + x, luma(vget_low_u8(a.val[0]), vget_low_u8(a.val[1]), vget_low_u8(a.val[2])));
        vst1_u8(yTop + x + 8, luma(vget_high_u8(a.val[0]), vget_high_u8(a.val[1]), vget_high_u8(a.val[2])));
        vst1_u8(yBottom + x, luma(vget_low_u8(b.val[0]), vget_low_u8(b.val[1]), vget_low_u8(b.val[2])));
        vst1_u8(yBottom + x + 8, luma(vget_high_u8(b.val[0]), vget_high_u8(b.val[1]), vget_high_u8(b.val[2])));
        const auto red = average(a.val[2], b.val[2]);
        const auto green = average(a.val[1], b.val[1]);
        const auto blue = average(a.val[0], b.val[0]);
        auto cb = vmulq_n_s16(red, -38);
        cb = vmlaq_n_s16(cb, green, -74);
        cb = vmlaq_n_s16(cb, blue, 112);
        auto cr = vmulq_n_s16(red, 112);
        cr = vmlaq_n_s16(cr, green, -94);
        cr = vmlaq_n_s16(cr, blue, -18);
        vst1_u8(u + x / 2, vqmovun_s16(vaddq_s16(vrshrq_n_s16(cb, 8), vdupq_n_s16(128))));
        vst1_u8(v + x / 2, vqmovun_s16(vaddq_s16(vrshrq_n_s16(cr, 8), vdupq_n_s16(128))));
    }
    // Encoders accept even dimensions that need not be multiples of sixteen.
    for (; x < width; x += 2) {
        int red = 0, green = 0, blue = 0;
        for (int dy = 0; dy < 2; ++dy) {
            const auto *row = dy ? bottom : top;
            auto *out = dy ? yBottom : yTop;
            for (int dx = 0; dx < 2; ++dx) {
                const auto *pixel = row + (x + dx) * 4;
                const int b = pixel[0], g = pixel[1], r = pixel[2];
                out[x + dx] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                red += r; green += g; blue += b;
            }
        }
        red = (red + 2) / 4; green = (green + 2) / 4; blue = (blue + 2) / 4;
        u[x / 2] = ((-38 * red - 74 * green + 112 * blue + 128) >> 8) + 128;
        v[x / 2] = ((112 * red - 94 * green - 18 * blue + 128) >> 8) + 128;
    }
}

} // namespace versus::platform::detail
