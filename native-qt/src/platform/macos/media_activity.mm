#include "versus/platform/macos_media_activity.h"
#import <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
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

struct MacFrameWaiter::Impl {
    dispatch_queue_t queue = nullptr;
    dispatch_semaphore_t signal = nullptr;
    dispatch_source_t timer = nullptr;

    Impl() {
        signal = dispatch_semaphore_create(0);
        queue = dispatch_queue_create("ninja.vdo.frame-deadline",
            dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INITIATED, 0));
        if (!signal || !queue) return;
        timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, DISPATCH_TIMER_STRICT, queue);
        if (!timer) return;
        // The callback retains only its semaphore, never this object. A queued
        // callback remains safe after cancellation and worker destruction.
        const auto wake = signal;
        dispatch_source_set_event_handler(timer, ^{ dispatch_semaphore_signal(wake); });
        dispatch_resume(timer);
    }
    ~Impl() {
        if (timer) dispatch_source_cancel(timer);
    }
};

MacFrameWaiter::MacFrameWaiter() : impl_(std::make_unique<Impl>()) {}
MacFrameWaiter::~MacFrameWaiter() = default;
bool MacFrameWaiter::waitUntil(std::chrono::steady_clock::time_point deadline) {
    if (!impl_->timer) return false;
    for (;;) {
        const auto remaining = std::chrono::duration_cast<std::chrono::nanoseconds>(
            deadline - std::chrono::steady_clock::now()).count();
        if (remaining <= 0) return true;
        dispatch_source_set_timer(impl_->timer, dispatch_time(DISPATCH_TIME_NOW, remaining),
                                  DISPATCH_TIME_FOREVER, 0);
        if (dispatch_semaphore_wait(impl_->signal, DISPATCH_TIME_FOREVER) != 0) return false;
        // Recheck the actual deadline: a pending signal from an earlier arm
        // must never let the encode worker run the next frame early.
    }
}

} // namespace versus::platform
