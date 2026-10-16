#pragma once
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

} // namespace versus::platform
