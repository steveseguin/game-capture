#pragma once
#include <chrono>
#include <memory>

namespace versus::platform {

// Keep user-requested capture out of App Nap for the encode worker's lifetime.
// This activity deliberately permits idle display and system sleep.
class MacMediaActivity {
public:
    MacMediaActivity();
    ~MacMediaActivity();
    MacMediaActivity(const MacMediaActivity &) = delete;
    MacMediaActivity &operator=(const MacMediaActivity &) = delete;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

bool macMediaActivityActive();

// A worker-owned, one-shot timer. Strict dispatch deadlines avoid the large
// sleep coalescing observed on macOS 14 VMs without spinning or changing the
// machine's power settings. Destruction cancels the timer.
class MacFrameWaiter {
public:
    MacFrameWaiter();
    ~MacFrameWaiter();
    MacFrameWaiter(const MacFrameWaiter &) = delete;
    MacFrameWaiter &operator=(const MacFrameWaiter &) = delete;
    bool waitUntil(std::chrono::steady_clock::time_point deadline);
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace versus::platform
