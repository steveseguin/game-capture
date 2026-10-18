#include "versus/audio/sample_clock.h"
#include <array>
#include <cstdint>
#include <iostream>

// Arithmetic regression gate, not packaged-application testing.
int main() {
    for (const uint32_t block : {128u, 512u, 1024u}) {
        versus::audio::SampleClockFraction clock;
        uint64_t frames = 0;
        int64_t duration = 0;
        while (frames < 48000ULL * 7200) {
            frames += block;
            duration += clock.duration100ns(block);
            // Compare against the total frame count, independent of partitioning.
            if (duration != static_cast<int64_t>(frames * 10000000 / 48000)) return 1;
        }
        clock.reset();
        if (clock.duration100ns(240) != 50000) return 2;
    }
    versus::audio::SampleClockFraction mixed;
    uint64_t frames = 0;
    int64_t duration = 0;
    for (unsigned index = 0; index < 100000; ++index) {
        const auto block = std::array<uint32_t, 7>{1, 128, 511, 512, 1024, 4096, 16384}[index % 7];
        frames += block;
        duration += mixed.duration100ns(block);
        if (duration != static_cast<int64_t>(frames * 10000000 / 48000)) return 3;
        if (index % 137 == 0) {
            mixed.reset(); frames = 0; duration = 0;
        }
    }
    std::cout << "Sample-clock arithmetic gate passed\n";
}
