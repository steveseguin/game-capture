#pragma once
#include <cstdint>
#include <vector>

namespace versus::audio {
// RFC 2198: one previous packet plus the current packet, bounded for UDP MTU.
inline std::vector<uint8_t> makeRedPacket(const std::vector<uint8_t> &current,
                                         const std::vector<uint8_t> &previous,
                                         uint32_t timestampOffset, uint8_t primaryType) {
    std::vector<uint8_t> result;
    const bool includePrevious = !previous.empty() && previous.size() <= 1023 &&
        timestampOffset > 0 && timestampOffset <= 16383 && current.size() + previous.size() + 5 <= 1200;
    if (includePrevious) {
        result.push_back(0x80 | primaryType);
        result.push_back(static_cast<uint8_t>(timestampOffset >> 6));
        result.push_back(static_cast<uint8_t>((timestampOffset << 2) | (previous.size() >> 8)));
        result.push_back(static_cast<uint8_t>(previous.size()));
    }
    result.push_back(primaryType);
    if (includePrevious) result.insert(result.end(), previous.begin(), previous.end());
    result.insert(result.end(), current.begin(), current.end());
    return result;
}
} // namespace versus::audio
