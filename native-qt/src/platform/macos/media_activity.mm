#include "versus/platform/macos_media_activity.h"
#import <Foundation/Foundation.h>
#include <atomic>

namespace versus::platform {
namespace {
std::atomic<unsigned> activeActivities{0};
}

struct MacMediaActivity::Impl {
    id<NSObject> __strong token = nil;
    Impl() {
        @autoreleasepool {
            token = [NSProcessInfo.processInfo
                beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep
                reason:@"Capturing and publishing user-selected media"];
            if (token) activeActivities.fetch_add(1, std::memory_order_relaxed);
        }
    }
    ~Impl() {
        @autoreleasepool {
            if (token) {
                [NSProcessInfo.processInfo endActivity:token];
                token = nil;
                activeActivities.fetch_sub(1, std::memory_order_relaxed);
            }
        }
    }
};

MacMediaActivity::MacMediaActivity() : impl_(std::make_unique<Impl>()) {}
MacMediaActivity::~MacMediaActivity() = default;
bool macMediaActivityActive() { return activeActivities.load(std::memory_order_relaxed) != 0; }

} // namespace versus::platform
