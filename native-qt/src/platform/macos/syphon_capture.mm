#include "versus/platform/macos_syphon_capture.h"
#include "alpha_conversion.h"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <Syphon/Syphon.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <thread>

namespace versus::platform {
namespace {
using Clock = std::chrono::steady_clock;
std::string text(NSString *value) { return value ? std::string(value.UTF8String ?: "") : std::string{}; }
NSDictionary *descriptionFor(const std::string &uuid) {
    for (NSDictionary *server in SyphonServerDirectory.sharedDirectory.servers)
        if (text(server[SyphonServerDescriptionUUIDKey]) == uuid) return server;
    return nil;
}
struct Generation {
    std::atomic<bool> stop{false}, active{false};
    std::atomic<int> fps{60};
    std::atomic<uint64_t> frameEpoch{0};
    std::atomic<uint64_t> gpuCopies{0}, verifiedFrames{0}, mismatchedCopies{0}, deferredFrames{0};
    std::mutex waitMutex, errorMutex;
    std::condition_variable wake;
    std::string error;
    MacSyphonCapture::FrameCallback callback;
    MacSyphonCapture::Alpha alpha = MacSyphonCapture::Alpha::Straight;
    SyphonMetalClient *__strong client = nil;
    id<MTLCommandQueue> __strong queue = nil;
    // The pinned Syphon transport names its CFMessagePort with the server UUID.
    // Retaining a read-only reference detects owner death without sending a
    // heartbeat or treating an intentionally static texture as disconnected.
    CFMessagePortRef livenessPort = nullptr;
    ~Generation() { if (livenessPort) CFRelease(livenessPort); }
    void fail(const char *message) {
        std::lock_guard lock(errorMutex); error = message; active = false;
    }
    void run() {
        video::CapturedFrame cached;
        const auto started = Clock::now();
        auto due = started;
        int configuredRate = fps.load();
        video::detail::CaptureFramePacer pacer(configuredRate);
        bool retryReadback = false;
        Clock::time_point unstableSince{};
        while (!stop) {
            const int rate = fps.load();
            if (rate != configuredRate) {
                configuredRate = rate;
                pacer.reset(rate);
                due = Clock::now();
            }
            const auto observedEpoch = frameEpoch.load(std::memory_order_acquire);
            const auto interval = std::chrono::nanoseconds(1000000000LL / rate);
            const auto grace = std::min(interval / 4, std::chrono::nanoseconds(std::chrono::milliseconds(4)));
            auto waitDue = due;
            @autoreleasepool {
                if (!client.isValid || !livenessPort || !CFMessagePortIsValid(livenessPort)) {
                    fail("The selected Syphon server disconnected. Select a server again."); break;
                }
                const auto now = Clock::now();
                const bool fresh = client.hasNewFrame || retryReadback;
                // Admit fresh notifications with the shared bounded-burst
                // pacer, rather than sampling two independent 60 Hz clocks.
                // The timer still supplies paced callbacks for static images.
                const auto replayDue = due + (cached.data.empty() ? std::chrono::nanoseconds::zero() : grace);
                waitDue = fresh ? due : replayDue;
                if ((fresh || now >= replayDue) && pacer.shouldAdmit(now)) {
                    // A replay must not consume the next fresh frame's slot
                    // merely because the producer clock trails by a few ms.
                    // Keep the static deadline phase, avoiding cumulative
                    // grace delay when the sender intentionally pauses.
                    due = fresh ? now + interval : std::max(due + interval, now);
                    waitDue = due + grace;
                    if (fresh) {
                        id<MTLTexture> texture = [client newFrameImage];
                        if (!texture || texture.width < 1 || texture.height < 1 || texture.width > 8192 || texture.height > 8192 ||
                            (texture.pixelFormat != MTLPixelFormatBGRA8Unorm && texture.pixelFormat != MTLPixelFormatBGRA8Unorm_sRGB)) {
                            fail("Syphon requires an SDR BGRA8 texture no larger than 8192 pixels per side."); break;
                        }
                        const size_t width = texture.width, height = texture.height;
                        const size_t rowBytes = (width * 4 + 255) & ~size_t(255);
                        id<MTLBuffer> previous = [queue.device newBufferWithLength:rowBytes * height options:MTLResourceStorageModeShared];
                        id<MTLBuffer> buffer = [queue.device newBufferWithLength:rowBytes * height options:MTLResourceStorageModeShared];
                        if (!previous || !buffer) { fail("Unable to allocate Syphon frame readback resources."); break; }
                        // Syphon exposes a live IOSurface, not an immutable frame.
                        // Retaining its texture does not stop a producer update.
                        // Require two consecutive owned copies to agree, avoiding
                        // mixed rows when a server write overlaps our first blit.
                        const auto deadline = Clock::now() + std::chrono::milliseconds(500);
                        auto readback = [&](id<MTLBuffer> destination) {
                            if (stop) return false;
                            id<MTLCommandBuffer> command = [queue commandBuffer];
                            id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
                            if (!command || !blit) { fail("Unable to allocate Syphon frame readback resources."); return false; }
                            [blit copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)
                                sourceSize:MTLSizeMake(width,height,1) toBuffer:destination destinationOffset:0
                                destinationBytesPerRow:rowBytes destinationBytesPerImage:rowBytes * height];
                            [blit endEncoding];
                            dispatch_semaphore_t completed = dispatch_semaphore_create(0);
                            [command addCompletedHandler:^(id<MTLCommandBuffer>) { dispatch_semaphore_signal(completed); }];
                            [command commit];
                            // All attempts share one deadline. Commands retain their
                            // resources; a late completion owns only its semaphore.
                            const auto remaining = std::max<int64_t>(0,
                                std::chrono::duration_cast<std::chrono::nanoseconds>(deadline - Clock::now()).count());
                            if (dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, remaining)) ||
                                command.status != MTLCommandBufferStatusCompleted) {
                                fail("Syphon GPU frame readback failed or exceeded 500 ms."); return false;
                            }
                            gpuCopies.fetch_add(1, std::memory_order_relaxed);
                            return !stop;
                        };
                        if (!readback(previous)) break;
                        bool stable = false;
                        for (int attempt = 0; attempt < 2 && !stable; ++attempt) {
                            if (!readback(buffer)) break;
                            stable = true;
                            for (size_t y = 0; y < height && stable; ++y)
                                stable = std::memcmp(static_cast<const uint8_t *>(previous.contents) + y * rowBytes,
                                    static_cast<const uint8_t *>(buffer.contents) + y * rowBytes, width * 4) == 0;
                            if (!stable) {
                                mismatchedCopies.fetch_add(1, std::memory_order_relaxed);
                                id<MTLBuffer> temporary = previous; previous = buffer; buffer = temporary;
                            }
                        }
                        if (stop || !active) break;
                        if (!stable) {
                            deferredFrames.fetch_add(1, std::memory_order_relaxed);
                            if (!retryReadback) unstableSince = Clock::now();
                            retryReadback = true;
                            if (Clock::now() - unstableSince > std::chrono::seconds(3)) {
                                fail("Syphon frames keep changing during readback. Lower the sender resolution or frame rate."); break;
                            }
                        } else {
                            verifiedFrames.fetch_add(1, std::memory_order_relaxed);
                            retryReadback = false;
                            cached.width = int(width); cached.height = int(height); cached.stride = int(width * 4);
                            cached.data.resize(width * height * 4);
                            for (size_t y = 0; y < height; ++y)
                                std::memcpy(cached.data.data() + y * cached.stride,
                                    static_cast<const uint8_t *>(buffer.contents) + y * rowBytes, width * 4);
                            // The protocol does not identify alpha association. Honor
                            // the explicit input setting and normalize to straight BGRA.
                            if (alpha == MacSyphonCapture::Alpha::Premultiplied) {
                                detail::unpremultiplyBgra(cached.data.data(), cached.data.size());
                            }
                        }
                    }
                    if (!cached.data.empty() && !stop && callback) {
                        cached.timestamp = std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count() / 100;
                        callback(cached);
                    } else if (cached.data.empty() && Clock::now() - started > std::chrono::seconds(3)) {
                        fail("The selected Syphon server did not supply a frame within three seconds."); break;
                    }
                }
            }
            // Static textures stay paced without GPU readback. An unstable
            // copy retries even if the producer stops publishing new frames.
            // Skip missed deadlines instead of emitting a backlog.
            std::unique_lock lock(waitMutex);
            wake.wait_until(lock, std::max(waitDue, Clock::now() + std::chrono::milliseconds(1)), [&] {
                return stop.load() || fps.load() != rate ||
                    frameEpoch.load(std::memory_order_acquire) != observedEpoch;
            });
        }
        active = false;
        @autoreleasepool { [client stop]; client = nil; queue = nil; }
    }
};
} // namespace

struct MacSyphonCapture::Impl {
    std::mutex lifecycleMutex, stateMutex;
    std::shared_ptr<Generation> state;
    std::thread worker;
    FrameCallback callback;
    std::shared_ptr<Generation> snapshot() {
        std::lock_guard lock(stateMutex); return state;
    }
    void stop() {
        if (auto current = snapshot()) {
            { std::lock_guard lock(current->waitMutex); current->stop = true; current->active = false; }
            current->wake.notify_all();
        }
        if (worker.joinable()) worker.join();
    }
};
MacSyphonCapture::MacSyphonCapture() : impl_(std::make_unique<Impl>()) {}
MacSyphonCapture::~MacSyphonCapture() { stopCapture(); }
std::vector<video::WindowInfo> MacSyphonCapture::getServers() const {
    @autoreleasepool {
        std::vector<video::WindowInfo> result;
        for (NSDictionary *server in SyphonServerDirectory.sharedDirectory.servers) {
            video::WindowInfo info;
            info.id = text(server[SyphonServerDescriptionUUIDKey]);
            if (info.id.empty()) continue;
            CFMessagePortRef port = CFMessagePortCreateRemote(kCFAllocatorDefault,
                (__bridge CFStringRef)server[SyphonServerDescriptionUUIDKey]);
            const bool alive = port && CFMessagePortIsValid(port);
            if (port) CFRelease(port);
            if (!alive) continue;
            info.name = text(server[SyphonServerDescriptionNameKey]);
            info.executableName = text(server[SyphonServerDescriptionAppNameKey]);
            if (info.name.empty()) info.name = "Unnamed Syphon server";
            if (info.executableName.empty()) info.executableName = "Syphon application";
            result.push_back(std::move(info));
        }
        std::sort(result.begin(), result.end(), [](const auto &a, const auto &b) { return a.id < b.id; });
        return result;
    }
}
bool MacSyphonCapture::startCapture(const std::string &uuid, int fps, Alpha alpha) {
    std::lock_guard lifecycle(impl_->lifecycleMutex);
    impl_->stop();
    auto state = std::make_shared<Generation>();
    { std::lock_guard lock(impl_->stateMutex); impl_->state = state; state->callback = impl_->callback; }
    @autoreleasepool {
        NSDictionary *description = uuid.empty() ? nil : descriptionFor(uuid);
        if (!description) { state->fail("The selected Syphon server is no longer available."); return false; }
        state->livenessPort = CFMessagePortCreateRemote(kCFAllocatorDefault,
            (__bridge CFStringRef)description[SyphonServerDescriptionUUIDKey]);
        if (!state->livenessPort || !CFMessagePortIsValid(state->livenessPort)) {
            state->fail("The selected Syphon server is no longer available."); return false;
        }
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        state->queue = [device newCommandQueue];
        if (!device || !state->queue) { state->fail("No Metal device is available for Syphon capture."); return false; }
        // A weak reference avoids a client -> block -> generation retain
        // cycle. Notifications only wake the owned worker; they do no readback
        // or application callback work on Syphon's notification queue.
        const std::weak_ptr<Generation> weakState = state;
        state->client = [[SyphonMetalClient alloc] initWithServerDescription:description device:device options:nil
            newFrameHandler:^(SyphonMetalClient *) {
                if (auto current = weakState.lock()) {
                    { std::lock_guard lock(current->waitMutex);
                      current->frameEpoch.fetch_add(1, std::memory_order_release); }
                    current->wake.notify_one();
                }
            }];
        if (!state->client.isValid) {
            state->fail("Unable to connect to the selected Syphon server using Metal.");
            [state->client stop]; state->client = nil; state->queue = nil; return false;
        }
        state->fps = std::clamp(fps, 1, 120); state->alpha = alpha; state->active = true;
    }
    impl_->worker = std::thread([state] { state->run(); });
    return true;
}
void MacSyphonCapture::stopCapture() { std::lock_guard lock(impl_->lifecycleMutex); impl_->stop(); }
bool MacSyphonCapture::isCapturing() const { auto state = impl_->snapshot(); return state && state->active; }
void MacSyphonCapture::setFrameRate(int fps) {
    if (auto state = impl_->snapshot()) {
        { std::lock_guard lock(state->waitMutex); state->fps = std::clamp(fps, 1, 120); }
        state->wake.notify_all();
    }
}
void MacSyphonCapture::setFrameCallback(FrameCallback callback) { std::lock_guard lock(impl_->stateMutex); impl_->callback = std::move(callback); }
std::string MacSyphonCapture::lastError() const {
    if (auto state = impl_->snapshot()) { std::lock_guard lock(state->errorMutex); return state->error; }
    return {};
}
MacSyphonCapture::ReadbackStats MacSyphonCapture::readbackStats() const {
    if (auto state = impl_->snapshot()) {
        return {state->gpuCopies.load(std::memory_order_relaxed), state->verifiedFrames.load(std::memory_order_relaxed),
            state->mismatchedCopies.load(std::memory_order_relaxed), state->deferredFrames.load(std::memory_order_relaxed)};
    }
    return {};
}
} // namespace versus::platform
