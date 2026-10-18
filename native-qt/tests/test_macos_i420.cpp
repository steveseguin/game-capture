// Arithmetic/memory gate only; packaged end-to-end testing is separate.
#include "versus/platform/macos_i420.h"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <vector>

static void reference(const uint8_t *a, const uint8_t *b, int width,
                      uint8_t *y0, uint8_t *y1, uint8_t *u, uint8_t *v) {
    auto clip = [](int x) { return static_cast<uint8_t>(std::clamp(x, 0, 255)); };
    for (int x = 0; x < width; x += 2) {
        int r = 0, g = 0, blue = 0;
        for (int row = 0; row < 2; ++row) {
            for (int col = 0; col < 2; ++col) {
                const auto *p = (row ? b : a) + (x + col) * 4;
                (row ? y1 : y0)[x + col] = clip(((66*p[2] + 129*p[1] + 25*p[0] + 128) >> 8) + 16);
                r += p[2]; g += p[1]; blue += p[0];
            }
        }
        r = (r+2)/4; g = (g+2)/4; blue = (blue+2)/4;
        u[x/2] = clip(((-38*r - 74*g + 112*blue + 128) >> 8) + 128);
        v[x/2] = clip(((112*r - 94*g - 18*blue + 128) >> 8) + 128);
    }
}

static uint64_t pixels = 0;
static void compare(const uint8_t *a, const uint8_t *b, int width) {
    // Separate buffers with guard bytes catch wrong lane order and tail writes.
    std::array<std::vector<uint8_t>, 4> expected, actual;
    for (int i = 0; i < 4; ++i) {
        expected[i].assign((i < 2 ? width : width/2) + 17, 0xcd);
        actual[i] = expected[i];
    }
    reference(a, b, width, expected[0].data()+1, expected[1].data()+1,
              expected[2].data()+1, expected[3].data()+1);
    versus::platform::detail::bgraRowsToI420(a, b, width, actual[0].data()+1, actual[1].data()+1,
                                           actual[2].data()+1, actual[3].data()+1);
    if (actual != expected) {
        std::fprintf(stderr, "I420 mismatch, width=%d, checkedPixels=%llu\n", width,
                     static_cast<unsigned long long>(pixels));
        std::exit(1);
    }
    std::vector<uint8_t> nv12(width + 17, 0xcd), expectedNv12 = nv12;
    for (int x = 0; x < width / 2; ++x) {
        expectedNv12[1 + 2*x] = expected[2][1+x];
        expectedNv12[2 + 2*x] = expected[3][1+x];
    }
    std::fill(actual[0].begin(), actual[0].end(), 0xcd);
    std::fill(actual[1].begin(), actual[1].end(), 0xcd);
    versus::platform::detail::bgraRowsToNV12(a, b, width, actual[0].data()+1, actual[1].data()+1, nv12.data()+1);
    if (actual[0] != expected[0] || actual[1] != expected[1] || nv12 != expectedNv12) {
        std::fprintf(stderr, "NV12 mismatch, width=%d\n", width); std::exit(1);
    }
    pixels += width * 2;
}

int main() {
    // Every solid RGB triplet, with different alpha on the two rows. Also
    // exercise adjacent colors, so a channel/lane swap cannot hide in gray.
    std::vector<uint8_t> top(512*4), bottom(512*4);
    for (int r = 0; r < 256; ++r) for (int g = 0; g < 256; ++g) {
        for (int x = 0; x < 512; ++x) {
            const int b = x / 2;
            top[x*4] = bottom[x*4] = b;
            top[x*4+1] = bottom[x*4+1] = g;
            top[x*4+2] = bottom[x*4+2] = r;
            top[x*4+3] = 0; bottom[x*4+3] = 255;
        }
        compare(top.data(), bottom.data(), 512);
    }
    std::mt19937 random(0x601420);
    const int widths[] = {2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,62,64,66,128,1920,1922,8192};
    for (int width : widths) for (int iteration = 0; iteration < 256; ++iteration) {
        // Offset input starts, exact-sized tails and separately allocated rows.
        const int offset = iteration % 16;
        top.resize(width*4 + offset); bottom.resize(width*4 + 15-offset);
        for (auto &value : top) value = random() & 255;
        for (auto &value : bottom) value = random() & 255;
        compare(top.data()+offset, bottom.data()+15-offset, width);
        // Alternating extrema exercise positive/negative chroma and rounding.
        for (auto &value : top) value = (random() & 1) ? 255 : 0;
        for (auto &value : bottom) value = (random() & 1) ? 255 : 0;
        compare(top.data()+offset, bottom.data()+15-offset, width);
    }
    std::printf("{\"passed\":true,\"comparedPixels\":%llu,\"scope\":\"arithmetic and memory gate\"}\n",
                static_cast<unsigned long long>(pixels));
}
