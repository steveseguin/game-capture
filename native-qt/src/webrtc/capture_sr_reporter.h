#pragma once

#include "versus/webrtc/media_clock.h"
#include <rtc/mediahandler.hpp>
#include <rtc/rtp.hpp>
#include <rtc/rtppacketizationconfig.hpp>

namespace versus::webrtc {

// RFC 3550: the SR's NTP and RTP timestamps describe the SAME instant.
// Pairing a queued packet's capture timestamp with its later send time shifts
// audio and video by their different encoding/packetization delays.
class CaptureSrReporter final : public rtc::MediaHandler {
  public:
    CaptureSrReporter(std::shared_ptr<rtc::RtpPacketizationConfig> config,
                      std::shared_ptr<MediaClock> clock)
        : config_(std::move(config)), clock_(std::move(clock)) {}

    void outgoing(rtc::message_vector &messages, const rtc::message_callback &send) override {
        bool sentMedia = false;
        for (const auto &message : messages) {
            if (message->type == rtc::Message::Control || message->size() < sizeof(rtc::RtpHeader)) continue;
            const auto *header = reinterpret_cast<const rtc::RtpHeader *>(message->data());
            if (header->ssrc() != config_->ssrc || header->getSize() > message->size()) continue;
            ++packets_;
            octets_ += static_cast<uint32_t>(message->size() - header->getSize());
            sentMedia = true;
        }
        const auto now = mediaTime100ns();
        if (!sentMedia || (lastReport_ && now - lastReport_ < 10000000)) return;
        lastReport_ = now;
        const auto srSize = rtc::RtcpSr::Size(0);
        auto message = rtc::make_message(srSize + rtc::RtcpSdes::Size({{uint8_t(config_->cname.size())}}), rtc::Message::Control);
        auto *sr = reinterpret_cast<rtc::RtcpSr *>(message->data());
        sr->setNtpTimestamp(clock_->ntpTimestamp(now));
        sr->setRtpTimestamp(mediaRtpTimestamp(now, config_->clockRate));
        sr->setPacketCount(packets_);
        sr->setOctetCount(octets_);
        sr->preparePacket(config_->ssrc, 0);
        auto *sdes = reinterpret_cast<rtc::RtcpSdes *>(message->data() + srSize);
        auto *chunk = sdes->getChunk(0);
        chunk->setSSRC(config_->ssrc);
        auto *item = chunk->getItem(0);
        item->type = 1;
        item->setText(config_->cname);
        sdes->preparePacket(1);
        send(message);
    }

  private:
    std::shared_ptr<rtc::RtpPacketizationConfig> config_;
    std::shared_ptr<MediaClock> clock_;
    uint32_t packets_ = 0, octets_ = 0;
    int64_t lastReport_ = 0;
};
} // namespace versus::webrtc
