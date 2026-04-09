#pragma once

#include <rtc/rtppacketizer.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace versus::webrtc {

// RFC 9628 VP9 RTP packetizer.
// Uses a 1-byte payload descriptor: B=0x08 (beginning of frame), E=0x04 (end of frame).
// Single-packet frame uses 0x0C (both B and E set).
// The base class RtpPacketizer::outgoing() sets the RTP M-bit on the last element returned
// by fragment(), so only fragment() needs implementing here.
class Vp9RtpPacketizer final : public rtc::RtpPacketizer {
public:
    static constexpr uint8_t kDescB = 0x08;  // beginning-of-frame bit
    static constexpr uint8_t kDescE = 0x04;  // end-of-frame bit

    explicit Vp9RtpPacketizer(
        std::shared_ptr<rtc::RtpPacketizationConfig> rtpConfig,
        size_t maxFragmentSize = DefaultMaxFragmentSize)
        : rtc::RtpPacketizer(std::move(rtpConfig))
        , mMaxFragmentSize(maxFragmentSize) {}

protected:
    std::vector<rtc::binary> fragment(rtc::binary frame) override {
        std::vector<rtc::binary> result;

        // 1 byte is consumed by the VP9 payload descriptor
        const size_t payloadMtu = (mMaxFragmentSize > 1) ? (mMaxFragmentSize - 1) : 1;

        size_t offset = 0;
        bool isFirst = true;

        while (offset < frame.size()) {
            const size_t chunkSize = std::min(payloadMtu, frame.size() - offset);
            const bool isLast = (offset + chunkSize >= frame.size());

            rtc::binary packet;
            packet.reserve(1 + chunkSize);

            uint8_t desc = 0x00;
            if (isFirst) desc |= kDescB;
            if (isLast)  desc |= kDescE;
            packet.push_back(static_cast<rtc::byte>(desc));

            packet.insert(packet.end(),
                          frame.begin() + static_cast<ptrdiff_t>(offset),
                          frame.begin() + static_cast<ptrdiff_t>(offset + chunkSize));

            result.push_back(std::move(packet));
            offset += chunkSize;
            isFirst = false;
        }

        return result;
    }

private:
    const size_t mMaxFragmentSize;
};

}  // namespace versus::webrtc
