// Compare the original Mac sleep_until behavior with scoped timer alternatives.
// This is a timer diagnostic gate, not packaged application testing.
#import <Foundation/Foundation.h>
#include <chrono>
#include <pthread/qos.h>
#include <mach/mach_time.h>
#include <dispatch/dispatch.h>
#include <algorithm>
#include <thread>
#include <vector>

int main() { @autoreleasepool {
    NSMutableArray *cases = [NSMutableArray new];
    for (int pass = 0; pass < 2; ++pass) {
        for (int step = 0; step < 5; ++step) {
            const int mode = pass ? 4 - step : step;
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
                dispatch_source_t timer = nullptr;
                dispatch_semaphore_t signal = nullptr;
                dispatch_queue_t queue = nullptr;
                if (mode == 4) {
                    signal = dispatch_semaphore_create(0);
                    queue = dispatch_queue_create("ninja.vdo.timer-probe",
                        dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INITIATED, 0));
                    timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, DISPATCH_TIMER_STRICT, queue);
                    if (!timer) { result = @{@"error": @"Strict timer creation failed"}; return; }
                    dispatch_source_set_event_handler(timer, ^{ dispatch_semaphore_signal(signal); });
                    dispatch_resume(timer);
                }
                const auto started = Clock::now();
                auto due = started + interval;
                for (int frame = 0; frame < 36; ++frame) {
                    if (mode == 3 || mode == 4) {
                        const auto remaining = std::chrono::duration_cast<std::chrono::nanoseconds>(due - Clock::now()).count();
                        if (remaining > 0 && mode == 3) {
                            mach_timebase_info_data_t scale{};
                            mach_timebase_info(&scale);
                            mach_wait_until(mach_absolute_time() + static_cast<uint64_t>(
                                (static_cast<__uint128_t>(remaining) * scale.denom + scale.numer - 1) / scale.numer));
                        } else if (remaining > 0) {
                            dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, remaining), DISPATCH_TIME_FOREVER, 0);
                            dispatch_semaphore_wait(signal, DISPATCH_TIME_FOREVER);
                        }
                    } else std::this_thread::sleep_until(due);
                    const auto now = Clock::now();
                    late.push_back(std::chrono::duration<double, std::milli>(now - due).count());
                    due = now + interval;
                }
                const double seconds = std::chrono::duration<double>(Clock::now() - started).count();
                std::sort(late.begin(), late.end());
                result = @{@"mode": @[@"inherited-user-activity", @"user-initiated-qos", @"latency-critical-activity", @"mach-deadline", @"strict-dispatch-timer"][mode],
                    @"pass": @(pass), @"beforeStatus": @(beforeStatus), @"beforeQos": @(before),
                    @"setQosStatus": @(setStatus), @"afterStatus": @(afterStatus), @"afterQos": @(after),
                    @"activityCreated": @(token != nil), @"waits": @36, @"elapsedSeconds": @(seconds),
                    @"lateMedianMs": @(late[18]), @"lateP95Ms": @(late[34]), @"lateMaxMs": @(late.back())};
                fprintf(stderr, "pass=%d mode=%d lateP95Ms=%.3f lateMaxMs=%.3f\n", pass, mode, late[34], late.back());
                if (timer) dispatch_source_cancel(timer);
                if (token) [NSProcessInfo.processInfo endActivity:token];
            } });
            worker.join();
            [cases addObject:result];
        }
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{
        @"scope": @"Bounded baseline sleep_until/timer gate, 36 deadlines at 30 Hz per condition, forward/reverse order; no application pass implied",
        @"cases": cases} options:NSJSONWritingPrettyPrinted error:nil];
    if (!data) return 1;
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); return 0;
} }
