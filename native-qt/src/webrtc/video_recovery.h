#pragma once

#include "capture_sr_reporter.h"
#include <rtc/mediahandler.hpp>
#include <rtc/rtp.hpp>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstring>
#include <deque>
#include <mutex>
#include <sstream>
#include <unordered_map>
#include <unordered_set>
#include <random>

namespace versus::webrtc {

// WHIP recovery is bounded by time, packet count, bytes, and retransmit rate.
// RTX uses its own sequence space (RFC 4588), avoiding old primary packets
// being rejected by the SRTP replay window. Only use it after SDP acceptance.
class VideoRecovery final : public rtc::MediaHandler {
    using Clock = std::chrono::steady_clock;
    struct Entry { rtc::message_ptr packet; Clock::time_point sent, repaired{}; };
  public:
    VideoRecovery(uint32_t ssrc, uint32_t rtxSsrc, int historyMs, int bitrateKbps,
                  std::shared_ptr<MediaClock> clock, const std::string &cname)
        : ssrc_(ssrc), rtxSsrc_(rtxSsrc), history_(std::clamp(historyMs, 250, 3000)),
          repairBudget_(std::clamp(size_t(std::max(1, bitrateKbps))*125/2, size_t(65536), size_t(2*1024*1024))),
          rtxSequence_(uint16_t(std::random_device{}())),
          rtxReporter_(std::make_shared<rtc::RtpPacketizationConfig>(rtxSsrc, cname, 98, 90000), std::move(clock)) {}

    void negotiate(const std::string &sdp) {
        std::istringstream input(sdp); std::string line; bool video = false, accepted = false;
        bool mapping = false, associated = false, nack = false, pli = false, playout = false; std::unordered_set<int> formats;
        while (std::getline(input, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.rfind("m=", 0) == 0) {
                if (video) break;
                video = line.rfind("m=video ", 0) == 0;
                if (video) {
                    std::istringstream media(line); std::string kind, port, proto; int pt;
                    media >> kind >> port >> proto; accepted = port != "0";
                    while (media >> pt) formats.insert(pt);
                }
            } else if (video && (line == "a=extmap:4 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay" ||
                       line == "a=extmap:4/recvonly http://www.webrtc.org/experiments/rtp-hdrext/playout-delay" ||
                       line == "a=extmap:4/sendrecv http://www.webrtc.org/experiments/rtp-hdrext/playout-delay")) {
                playout = true;
            } else if (video && (line == "a=rtcp-fb:96 nack" || line == "a=rtcp-fb:* nack")) {
                nack = true;
            } else if (video && (line == "a=rtcp-fb:96 nack pli" || line == "a=rtcp-fb:* nack pli")) {
                pli = true;
            } else if (video && line.rfind("a=rtpmap:98 ", 0) == 0) {
                auto value = line.substr(12);
                std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return char(std::tolower(c)); });
                mapping = value == "rtx/90000";
            } else if (video && line.rfind("a=fmtp:98 ", 0) == 0) {
                std::istringstream params(line.substr(10)); std::string field;
                while (std::getline(params, field, ';')) {
                    field.erase(std::remove_if(field.begin(), field.end(), [](unsigned char c) { return std::isspace(c); }), field.end());
                    if (field == "apt=96") associated = true;
                }
            }
        }
        playout_ = accepted && formats.count(96) && playout;
        nack_ = accepted && formats.count(96) && nack;
        pli_ = accepted && formats.count(96) && pli;
        rtx_ = nack_ && accepted && formats.count(98) && formats.count(96) && mapping && associated;
    }
    bool usesPlayoutDelay() const { return playout_.load(); }
    bool usesNack() const { return nack_.load(); }
    bool usesPli() const { return pli_.load(); }
    bool usesRtx() const { return rtx_.load(); }
    uint64_t retransmitted() const { return retransmitted_.load(); }
    uint64_t missed() const { return missed_.load(); }

    void outgoing(rtc::message_vector &messages, const rtc::message_callback &) override {
        std::lock_guard lock(mutex_); const auto now = Clock::now(); prune(now);
        for (const auto &packet : messages) {
            if (packet->type == rtc::Message::Control || packet->size() < 12) continue;
            const auto *data = reinterpret_cast<const uint8_t *>(packet->data());
            size_t headerSize = 12 + (data[0] & 15)*4;
            if ((data[0] >> 6) != 2 || headerSize > packet->size()) continue;
            if (data[0] & 0x10) {
                if (headerSize+4 > packet->size()) continue;
                headerSize += 4 + (size_t(data[headerSize+2])*256 + data[headerSize+3])*4;
            }
            if (headerSize > packet->size()) continue;
            const size_t padding = (data[0] & 0x20) ? data[packet->size()-1] : 0;
            if ((data[0] & 0x20) && (!padding || padding >= packet->size()-headerSize)) continue;
            const auto *header = reinterpret_cast<const rtc::RtpHeader *>(packet->data());
            if (header->ssrc() != ssrc_ || header->getSize() > packet->size()) continue;
            const auto seq = header->seqNumber();
            if (cache_.count(seq)) continue;
            cache_.emplace(seq, Entry{packet, now}); order_.push_back(seq); bytes_ += packet->size();
            prune(now);
        }
    }

    void incoming(rtc::message_vector &messages, const rtc::message_callback &send) override {
        if (!nack_) return;
        std::lock_guard sendLock(repairSendMutex_);
        std::vector<rtc::message_ptr> repairs;
        {
            std::lock_guard lock(mutex_); const auto now = Clock::now(); prune(now);
            // Refill continuously. A fixed one-second window lets reordered
            // packets consume the allowance early, then refuses even genuine
            // loss repairs until the next window (long enough to lose a GOP).
            // Keep the same average and maximum burst allowance, but let short
            // periods without repairs immediately replenish the budget.
            if (budgetUpdated_ == Clock::time_point{}) repairTokens_ = double(repairBudget_);
            else repairTokens_ = std::min(double(repairBudget_), repairTokens_ +
                std::chrono::duration<double>(now-budgetUpdated_).count()*double(repairBudget_));
            budgetUpdated_ = now;
            std::unordered_set<uint16_t> requested;
            std::vector<uint16_t> requestOrder;
            const auto request = [&](uint16_t seq) { if (requested.size() < 512 && requested.insert(seq).second) requestOrder.push_back(seq); };
            for (const auto &message : messages) {
                if (message->type != rtc::Message::Control) continue;
                const auto *data = reinterpret_cast<const uint8_t *>(message->data());
                for (size_t offset = 0; offset + 4 <= message->size();) {
                    const auto *p = data + offset;
                    const size_t size = (size_t(p[2]) * 256 + p[3] + 1) * 4;
                    if ((p[0] >> 6) != 2 || size > message->size() - offset) break;
                    size_t payloadSize = size;
                    if (p[0] & 0x20) {
                        const size_t padding = p[size-1];
                        if (!padding || padding > size-4 || offset+size != message->size()) break;
                        payloadSize -= padding;
                    }
                    if (p[1] == 205 && (p[0] & 31) == 1 && payloadSize >= 16 && (payloadSize-12)%4 == 0 && read32(p+8) == ssrc_) {
                        for (size_t i = 12; i + 4 <= payloadSize && requested.size() < 512; i += 4) {
                            const uint16_t seq = uint16_t(p[i] * 256 + p[i+1]);
                            const uint16_t mask = uint16_t(p[i+2] * 256 + p[i+3]);
                            request(seq);
                            for (int bit = 0; bit < 16 && requested.size() < 512; ++bit) if (mask & (1 << bit)) request(uint16_t(seq + bit + 1));
                        }
                    }
                    offset += size;
                }
            }
            for (auto seq : requestOrder) {
                auto found = cache_.find(seq);
                if (found == cache_.end()) { ++missed_; continue; }
                auto &entry = found->second;
                // A reordered feedback burst can repeat the same request before
                // the first repair has completed even a short round trip.
                // Suppress those copies without delaying the initial repair.
                const auto cost = entry.packet->size()+2;
                if (now-entry.repaired < std::chrono::milliseconds(50) || double(cost) > repairTokens_) continue;
                entry.repaired = now; repairTokens_ -= double(cost);
                if (!rtx_) { repairs.push_back(entry.packet); continue; }
                const auto *original = reinterpret_cast<const rtc::RtpHeader *>(entry.packet->data());
                const auto headerSize = original->getSize() + original->getExtensionHeaderSize();
                const auto *originalBytes = reinterpret_cast<const uint8_t *>(entry.packet->data());
                const size_t padding = (originalBytes[0] & 0x20) ? originalBytes[entry.packet->size()-1] : 0;
                const size_t payloadSize = entry.packet->size()-headerSize-padding;
                auto packet = rtc::make_message(headerSize+2+payloadSize);
                std::memcpy(packet->data(), entry.packet->data(), headerSize);
                reinterpret_cast<uint8_t *>(packet->data())[0] &= ~0x20; // RFC 4588: strip original RTP padding.
                auto *header = reinterpret_cast<rtc::RtpHeader *>(packet->data());
                header->setSsrc(rtxSsrc_); header->setPayloadType(98); header->setSeqNumber(rtxSequence_++);
                auto *body = reinterpret_cast<uint8_t *>(packet->data()) + headerSize;
                body[0] = uint8_t(seq >> 8); body[1] = uint8_t(seq);
                std::memcpy(body+2, entry.packet->data()+headerSize, payloadSize);
                repairs.push_back(std::move(packet));
            }
        }
        // Never enter transport callbacks while holding the cache lock.
        for (const auto &packet : repairs) { send(packet); ++retransmitted_; }
        if (rtx_ && !repairs.empty()) rtxReporter_.outgoing(repairs, send);
    }
  private:
    static uint32_t read32(const uint8_t *p) { return uint32_t(p[0])<<24 | uint32_t(p[1])<<16 | uint32_t(p[2])<<8 | p[3]; }
    void prune(Clock::time_point now) {
        while (!order_.empty()) {
            auto it = cache_.find(order_.front());
            if (it == cache_.end()) { order_.pop_front(); continue; }
            if (cache_.size() <= 4096 && bytes_ <= 8*1024*1024 && now-it->second.sent <= history_) break;
            bytes_ -= it->second.packet->size(); cache_.erase(it); order_.pop_front();
        }
    }
    const uint32_t ssrc_, rtxSsrc_; const std::chrono::milliseconds history_; const size_t repairBudget_;
    std::mutex mutex_, repairSendMutex_; std::unordered_map<uint16_t, Entry> cache_; std::deque<uint16_t> order_;
    size_t bytes_ = 0; double repairTokens_ = 0; Clock::time_point budgetUpdated_{};
    uint16_t rtxSequence_ = 0;
    CaptureSrReporter rtxReporter_;
    std::atomic<bool> nack_{false}, pli_{false}, rtx_{false}, playout_{false};
    std::atomic<uint64_t> retransmitted_{0}, missed_{0};
};
} // namespace versus::webrtc
