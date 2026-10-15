#pragma once

#include <rtc/mediahandler.hpp>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

namespace versus::webrtc {
// Spread encoded-frame bursts without holding up audio, RTCP or retransmits.
// A stalled destination fails instead of growing memory or streaming old video.
class VideoPacer final : public rtc::MediaHandler {
    using Clock = std::chrono::steady_clock;
    struct Pending { rtc::message_ptr packet; rtc::message_callback send; Clock::time_point due; };
  public:
    explicit VideoPacer(int bitrateKbps) : bytesPerSecond_(std::max(128, bitrateKbps)*125.0*1.25), thread_([this] { run(); }) {}
    ~VideoPacer() { stop(); }
    void stop() {
        { std::lock_guard lock(mutex_); stopped_ = true; queue_.clear(); bytes_ = 0; }
        ready_.notify_all(); if (thread_.joinable()) thread_.join();
    }
    bool failed() const { return failed_.load(); }
    void outgoing(rtc::message_vector &messages, const rtc::message_callback &send) override {
        std::lock_guard lock(mutex_); const auto now = Clock::now();
        for (const auto &packet : messages) {
            if (stopped_ || failed_) break;
            next_ = std::max(next_, now);
            if (bytes_ + packet->size() > 8*1024*1024 || next_-now > std::chrono::milliseconds(750)) {
                failed_ = true; queue_.clear(); bytes_ = 0; break;
            }
            queue_.push_back({packet, send, next_}); bytes_ += packet->size();
            next_ += std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(packet->size()/bytesPerSecond_));
        }
        messages.clear(); ready_.notify_one();
    }
  private:
    void run() {
        std::unique_lock lock(mutex_);
        while (!stopped_) {
            if (queue_.empty()) { ready_.wait(lock, [&] { return stopped_ || !queue_.empty(); }); continue; }
            const auto due = queue_.front().due;
            if (Clock::now() < due) { ready_.wait_until(lock, due); continue; }
            auto item = std::move(queue_.front()); queue_.pop_front(); bytes_ -= item.packet->size();
            lock.unlock();
            try { item.send(item.packet); } catch (...) { failed_ = true; }
            lock.lock();
            if (failed_) { queue_.clear(); bytes_ = 0; }
        }
    }
    const double bytesPerSecond_;
    std::atomic<bool> failed_{false}; bool stopped_ = false; size_t bytes_ = 0;
    std::mutex mutex_; std::condition_variable ready_; std::deque<Pending> queue_;
    Clock::time_point next_{}; std::thread thread_;
};
} // namespace versus::webrtc
