#include "versus/video/video_encoder.h"
#include "versus/video/window_capture.h"

#include <iostream>
#include <stdexcept>
#include <utility>

using namespace versus::video;

static void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}

int main() {
    try {
        CapturedFrame source;
        source.width = 2; source.height = 2; source.stride = 12; source.timestamp = 12345;
        // Row padding must never leak into either half. Hidden green must not
        // contaminate the opaque blue when the source is scaled.
        source.data = {255,0,0,255, 0,255,0,0, 99,99,99,99,
                       255,0,0,255, 0,255,0,0, 99,99,99,99};
        const auto original = source.data;
        CapturedFrame packed;
        require(detail::buildPackedAlphaFrame(source, 2, 2, packed), "pack failed");
        require(packed.width == 4 && packed.height == 2 && packed.stride == 16 && packed.timestamp == 12345, "geometry/timestamp lost");
        require(packed.data[0] == 255 && packed.data[8] == 255 && packed.data[12] == 0, "color/mask layout wrong");
        for (size_t i = 3; i < packed.data.size(); i += 4) require(packed.data[i] == 255, "carrier must be opaque");
        require(source.data == original, "source preview modified");
        require(detail::buildPackedAlphaFrame(source, 4, 4, packed), "scale failed");
        require(packed.data[4] == 255 && packed.data[5] == 0 && packed.data[6] == 0, "hidden color contaminated filtered edge");
        require(packed.data[20] >= 190 && packed.data[20] <= 192, "filtered alpha incorrect");
        require(detail::buildPackedAlphaFrame(source, 4, 2, packed), "aspect fit failed");
        require(packed.data[16] == 0 && packed.data[20] == 255 && packed.data[28] == 0, "padding mask must be transparent");
        // The encoder reuses one output buffer across frames and size changes. Unscaled,
        // scaled, pillarboxed and letterboxed packs must each overwrite every byte of it.
        for (const auto &[width, height] : {std::pair{2, 2}, std::pair{4, 4}, std::pair{4, 2}, std::pair{2, 4}}) {
            CapturedFrame fresh, reused;
            require(detail::buildPackedAlphaFrame(source, width, height, fresh), "fresh pack failed");
            reused.data.assign(static_cast<size_t>(3840) * 4 * 1080, 0x5a);
            require(detail::buildPackedAlphaFrame(source, width, height, reused), "repack failed");
            require(reused.data == fresh.data, "stale output survived a repack");
            for (size_t i = 3; i < reused.data.size(); i += 4) require(reused.data[i] == 255, "repacked carrier must be opaque");
        }
        require(!detail::buildPackedAlphaFrame(source, 3, 2, packed), "odd half width accepted");
        require(!detail::buildPackedAlphaFrame(source, 1922, 1080, packed), "unsupported coded width accepted");
        require(!detail::buildPackedAlphaFrame(source, 1920, 1082, packed), "unsupported coded height accepted");
        source.data.resize(6);
        require(!detail::buildPackedAlphaFrame(source, 2, 2, packed), "short buffer accepted");
        source.width = 1920; source.height = 1080; source.stride = 1920 * 4;
        source.data.assign(static_cast<size_t>(source.stride) * source.height, 128);
        source.data.back() = 255;
        require(detail::buildPackedAlphaFrame(source, 1920, 1080, packed), "1080p pack failed");
        require(packed.width == 3840 && packed.height == 1080, "1080p coded dimensions wrong");
        require(packed.data[1920 * 4] == 128 && packed.data[packed.data.size() - 4] == 255, "1080p mask bounds wrong");
        std::cout << "Packed alpha gates passed\n";
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
