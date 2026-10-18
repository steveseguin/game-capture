#pragma once

#include <chrono>
#include <thread>
#ifdef _WIN32
#include <Windows.h>
#elif defined(__APPLE__)
#include "versus/platform/macos_media_activity.h"
#endif

namespace versus::video::detail {

// One timer owned by the media worker. Windows uses its high-resolution
// waitable timer; macOS uses strict dispatch deadlines to bound coalescing.
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
#ifdef __APPLE__
        if (macTimer_.waitUntil(deadline)) return;
#endif
        std::this_thread::sleep_until(deadline);
    }

  private:
#ifdef _WIN32
    HANDLE timer_ = nullptr;
#elif defined(__APPLE__)
    platform::MacFrameWaiter macTimer_;
#endif
};
} // namespace versus::video::detail
