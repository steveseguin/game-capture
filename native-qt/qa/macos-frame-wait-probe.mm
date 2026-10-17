// Compare the actual shared FrameWaiter under scoped Mac thread/activity modes.
// This is a timer diagnostic gate, not packaged application testing.
#import <Foundation/Foundation.h>
#include "versus/video/frame_waiter.h"
#include <pthread/qos.h>
#include <algorithm>
#include <thread>
#include <vector>

int main() { @autoreleasepool {
    NSMutableArray *cases = [NSMutableArray new];
    for (int pass = 0; pass < 2; ++pass) {
        for (int step = 0; step < 3; ++step) {
            const int mode = pass ? 2 - step : step;
            NSDictionary *result = nil;
            std::thread worker([&] { @autoreleasepool {
                qos_class_t before = QOS_CLASS_UNSPECIFIED, after = QOS_CLASS_UNSPECIFIED;
                int relative = 0;
                const int beforeStatus = pthread_get_qos_class_np(pthread_self(), &before, &relative);
                const int setStatus = mode == 1 ? pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0) : 0;
                const int afterStatus = pthread_get_qos_class_np(pthread_self(), &after, &relative);
                const NSActivityOptions options = NSActivityUserInitiatedAllowingIdleSystemSleep |
                    (mode == 2 ? NSActivityLatencyCritical : 0);
                id token = [NSProcessInfo.processInfo beginActivityWithOptions:options reason:@"Bounded media timer diagnosis"];
                using Clock = std::chrono::steady_clock;
                const auto interval = std::chrono::nanoseconds(1000000000LL / 30);
                std::vector<double> late;
                versus::video::detail::FrameWaiter waiter;
                const auto started = Clock::now();
                auto due = started + interval;
                for (int frame = 0; frame < 36; ++frame) {
                    waiter.waitUntil(due);
                    const auto now = Clock::now();
                    late.push_back(std::chrono::duration<double, std::milli>(now - due).count());
                    due = now + interval;
                }
                const double seconds = std::chrono::duration<double>(Clock::now() - started).count();
                std::sort(late.begin(), late.end());
                result = @{@"mode": @[@"inherited-user-activity", @"user-initiated-qos", @"latency-critical-activity"][mode],
                    @"pass": @(pass), @"beforeStatus": @(beforeStatus), @"beforeQos": @(before),
                    @"setQosStatus": @(setStatus), @"afterStatus": @(afterStatus), @"afterQos": @(after),
                    @"activityCreated": @(token != nil), @"waits": @36, @"elapsedSeconds": @(seconds),
                    @"lateMedianMs": @(late[18]), @"lateP95Ms": @(late[34]), @"lateMaxMs": @(late.back())};
                if (token) [NSProcessInfo.processInfo endActivity:token];
            } });
            worker.join();
            [cases addObject:result];
        }
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{
        @"scope": @"Bounded FrameWaiter gate, 36 deadlines at 30 Hz per condition, forward/reverse order; no application pass implied",
        @"cases": cases} options:NSJSONWritingPrettyPrinted error:nil];
    if (!data) return 1;
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); return 0;
} }
