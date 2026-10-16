// Controlled frames for an already installed OBS Camera Extension. Does not
// install a device, start OBS, modify OBS settings, or open physical cameras.
// CMIO sink protocol reference: obsproject/obs-studio 32.2.2,
// plugins/mac-virtualcam/src/obs-plugin/plugin-main.mm.
#import <Foundation/Foundation.h>
#import <CoreMediaIO/CoreMediaIO.h>
#import <CoreVideo/CoreVideo.h>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <poll.h>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
volatile sig_atomic_t stopping = 0;
void stop(int) { stopping = 1; }
CMIOObjectPropertyAddress address(UInt32 selector) {
    return {selector, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
}
template<class T> bool property(CMIOObjectID object, UInt32 selector, T &value) {
    auto key = address(selector); UInt32 used = 0;
    return CMIOObjectGetPropertyData(object, &key, 0, nullptr, sizeof(T), &used, &value) == noErr && used == sizeof(T);
}
std::vector<CMIOObjectID> objects(CMIOObjectID parent, UInt32 selector) {
    auto key = address(selector); UInt32 size = 0, used = 0;
    if (CMIOObjectGetPropertyDataSize(parent, &key, 0, nullptr, &size) || size > 1024 * 1024 || size % sizeof(CMIOObjectID)) return {};
    std::vector<CMIOObjectID> result(size / sizeof(CMIOObjectID));
    if (CMIOObjectGetPropertyData(parent, &key, 0, nullptr, size, &used, result.data()) || used != size) return {};
    return result;
}
void fill(CVPixelBufferRef buffer, uint16_t identity) {
    CVPixelBufferLockBaseAddress(buffer, 0);
    auto *data = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(buffer));
    const int width = static_cast<int>(CVPixelBufferGetWidth(buffer)), height = static_cast<int>(CVPixelBufferGetHeight(buffer));
    const size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        uint8_t r = 24, g = 48, b = 66;
        if (y < height / 8) { r = 220; g = 25; b = 20; }
        if (y >= height * 7 / 8) { r = 20; g = 220; b = 25; }
        if (y >= height / 4 && y < height * 3 / 4) {
            if (x >= width / 10 && x < width * 15 / 100) { r = 0; g = 255; b = 255; }
            if (x >= width * 85 / 100 && x < width * 90 / 100) { r = 255; g = 0; b = 255; }
            if (x >= width / 5 && x < width * 4 / 5) {
                const int bit = (x - width / 5) * 16 / (width * 3 / 5);
                r = g = b = (identity >> bit) & 1 ? 255 : 0;
            }
        }
        auto *pixel = data + y * stride + x * 4;
        pixel[0] = b; pixel[1] = g; pixel[2] = r; pixel[3] = 255;
    }
    CVPixelBufferUnlockBaseAddress(buffer, 0);
}
}
int main(int argc, char **argv) { @autoreleasepool {
    if (argc != 2) { fprintf(stderr, "Usage: macos-camera-fixture EXISTING_OBS_DEVICE_UID\n"); return 2; }
    CMIODeviceID device = 0;
    for (auto candidate : objects(kCMIOObjectSystemObject, kCMIOHardwarePropertyDevices)) {
        CFStringRef uid = nullptr, name = nullptr;
        if (property(candidate, kCMIODevicePropertyDeviceUID, uid)) {
            if (property(candidate, kCMIOObjectPropertyName, name)) {
                if ([(__bridge NSString *)uid isEqualToString:[NSString stringWithUTF8String:argv[1]]] &&
                    [(__bridge NSString *)name isEqualToString:@"OBS Virtual Camera"]) device = candidate;
                CFRelease(name);
            }
            CFRelease(uid);
        }
    }
    UInt32 running = 0;
    if (!device || !property(device, kCMIODevicePropertyDeviceIsRunningSomewhere, running) || running) {
        fprintf(stderr, "An explicitly selected, idle OBS Camera Extension is required\n"); return 3;
    }
    CMIOStreamID sink = 0;
    for (auto candidate : objects(device, kCMIODevicePropertyStreams)) {
        UInt32 direction = 1;
        if (property(candidate, kCMIOStreamPropertyDirection, direction) && direction == 0) sink = candidate;
    }
    CMSimpleQueueRef queue = nullptr;
    if (!sink || CMIOStreamCopyBufferQueue(sink, [](CMIOStreamID, void *, void *) {}, nullptr, &queue) || !queue) {
        fprintf(stderr, "OBS Camera Extension sink is unavailable\n"); return 3;
    }
    CVPixelBufferPoolRef pool = nullptr;
    NSDictionary *attributes = @{(id)kCVPixelBufferWidthKey:@1920, (id)kCVPixelBufferHeightKey:@1080,
        (id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA), (id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
    if (CVPixelBufferPoolCreate(nullptr, nullptr, (__bridge CFDictionaryRef)attributes, &pool)) { CFRelease(queue); return 4; }
    if (CMIODeviceStartStream(device, sink)) { CFRelease(pool); CFRelease(queue); return 4; }
    signal(SIGTERM, stop); signal(SIGINT, stop);
    printf("READY %s\n", argv[1]); fflush(stdout);
    const auto origin = std::chrono::steady_clock::now();
    auto next = origin;
    bool paused = false, stalled = false; uint16_t identity = 0;
    uint64_t publishedFrames = 0, changedFrames = 0;
    std::string commands;
    while (!stopping) { @autoreleasepool {
        pollfd input{STDIN_FILENO, POLLIN, 0};
        if (poll(&input, 1, 0) > 0 && (input.revents & (POLLIN | POLLHUP))) {
            char data[256]; const auto count = read(STDIN_FILENO, data, sizeof(data));
            if (count <= 0) break;
            commands.append(data, count);
            for (size_t end; (end = commands.find('\n')) != std::string::npos;) {
                auto command = commands.substr(0, end); commands.erase(0, end + 1);
                if (command == "pause") paused = true;
                if (command == "resume") paused = false;
                if (command == "stall") stalled = true;
                if (command == "flow") stalled = false;
                if (command == "quit") stopping = 1;
                if (command == "state") {
                    const double time = std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
                    printf("{\"publishedFrames\":%llu,\"changedFrames\":%llu,\"identity\":%u,\"time\":%.9f,\"paused\":%s,\"stalled\":%s}\n",
                        static_cast<unsigned long long>(publishedFrames), static_cast<unsigned long long>(changedFrames),
                        identity, time, paused ? "true" : "false", stalled ? "true" : "false");
                    fflush(stdout);
                }
            }
        }
        if (stopping) break;
        if (!stalled && CMSimpleQueueGetCount(queue) < CMSimpleQueueGetCapacity(queue)) {
            CVPixelBufferRef buffer = nullptr;
            NSDictionary *limits = @{(id)kCVPixelBufferPoolAllocationThresholdKey:@4};
            if (!CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(nullptr, pool, (__bridge CFDictionaryRef)limits, &buffer)) {
                // Each successfully queued moving frame gets a new identity.
                // Rounded clock buckets can repeat/skip IDs at 30 Hz even when
                // the camera produces every frame, invalidating cadence checks.
                const uint16_t nextIdentity = paused ? identity : static_cast<uint16_t>(identity + 1);
                fill(buffer, nextIdentity);
                CMVideoFormatDescriptionRef format = nullptr;
                CMSampleBufferRef sample = nullptr;
                CMSampleTimingInfo timing{CMTimeMake(1, 30), CMClockGetTime(CMClockGetHostTimeClock()), kCMTimeInvalid};
                if (!CMVideoFormatDescriptionCreateForImageBuffer(nullptr, buffer, &format)) {
                    if (!CMSampleBufferCreateReadyWithImageBuffer(nullptr, buffer, format, &timing, &sample)) {
                        // The sink consumes ownership of successfully queued samples.
                        if (CMSimpleQueueEnqueue(queue, sample)) CFRelease(sample);
                        else { identity = nextIdentity; ++publishedFrames; if (!paused) ++changedFrames; }
                    }
                    CFRelease(format);
                }
                CFRelease(buffer);
            }
        }
        next += std::chrono::microseconds(33333);
        if (next < std::chrono::steady_clock::now()) next = std::chrono::steady_clock::now();
        std::this_thread::sleep_until(next);
    } }
    CMIODeviceStopStream(device, sink);
    CFRelease(pool); CFRelease(queue);
    return 0;
} }
