#pragma once

#include "versus/webrtc/media_clock.h"
#include "receiver_feedback.h"
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
                      std::shared_ptr<MediaClock> clock,
                      std::shared_ptr<ReceiverFeedback> feedback = {})
        : config_(std::move(config)), clock_(std::move(clock)), feedback_(std::move(feedback)) {}

    void incoming(rtc::message_vector &messages, const rtc::message_callback &) override {
        if (!feedback_) return;
        for (const auto &message : messages) {
            if (message->type != rtc::Message::Control) continue;
            const auto *data = reinterpret_cast<const uint8_t *>(message->data());
            for (size_t offset = 0; offset + 4 <= message->size();) {
                const auto *header = data + offset;
                const size_t size = (size_t(header[2]) * 256 + header[3] + 1) * 4;
                if ((header[0] >> 6) != 2 || size > message->size() - offset) break;
                const size_t reports = header[0] & 31;
                if (header[1] == 201 && reports && size >= 8 + reports * 24) {
                    for (size_t i = 0; i < reports; ++i) {
                        const auto *block = header + 8 + i * 24;
                        const uint32_t ssrc = (uint32_t(block[0]) << 24) | (uint32_t(block[1]) << 16) |
                            (uint32_t(block[2]) << 8) | block[3];
                        if (ssrc == config_->ssrc) { feedback_->received(); break; }
                    }
                }
                offset += size;
            }
        }
    }

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
    std::shared_ptr<ReceiverFeedback> feedback_;
    uint32_t packets_ = 0, octets_ = 0;
    int64_t lastReport_ = 0;
};
} // namespace versus::webrtc
