#pragma once

#include <chrono>
#include <thread>
#ifdef _WIN32
#include <Windows.h>
#endif

namespace versus::video::detail {

// One timer owned by the capture thread. Ordinary Windows sleeps can round a
// 16.67 ms deadline to scheduler ticks, producing alternating repeats/skips.
class FrameWaiter {
  public:
    FrameWaiter() {
#ifdef _WIN32
        timer_ = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                       TIMER_MODIFY_STATE | SYNCHRONIZE);
#endif
    }
    ~FrameWaiter() {
#ifdef _WIN32
        if (timer_) CloseHandle(timer_);
#endif
    }
    FrameWaiter(const FrameWaiter &) = delete;
    FrameWaiter &operator=(const FrameWaiter &) = delete;

    void waitUntil(std::chrono::steady_clock::time_point deadline) {
        const auto remaining = deadline - std::chrono::steady_clock::now();
        if (remaining <= std::chrono::steady_clock::duration::zero()) return;
#ifdef _WIN32
        if (timer_) {
            LARGE_INTEGER due;
            due.QuadPart = -(std::chrono::duration_cast<std::chrono::nanoseconds>(remaining).count() + 99) / 100;
            if (SetWaitableTimer(timer_, &due, 0, nullptr, nullptr, FALSE) &&
                WaitForSingleObject(timer_, INFINITE) == WAIT_OBJECT_0) return;
        }
#endif
        std::this_thread::sleep_until(deadline);
    }

  private:
#ifdef _WIN32
    HANDLE timer_ = nullptr;
#endif
};
} // namespace versus::video::detail
