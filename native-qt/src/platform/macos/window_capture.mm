#include "versus/video/window_capture.h"
#include "versus/platform/macos_capture.h"
#include "versus/webrtc/media_clock.h"

#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreVideo/CoreVideo.h>

#include <QImage>
#include <algorithm>
#include <charconv>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <optional>
#include <mutex>
#include <unordered_map>
#include <spdlog/spdlog.h>

namespace {
using namespace versus;

struct ContentCache {
    std::mutex mutex;
    std::condition_variable ready;
    SCShareableContent *content = nil;
    bool pending = false;
    std::chrono::steady_clock::time_point requested{};
    std::string error;
};
auto contentCache = std::make_shared<ContentCache>();

bool parseWindowId(const std::string &id, CGWindowID &value) {
    uint32_t parsed = 0;
    const auto result = std::from_chars(id.data(), id.data() + id.size(), parsed);
    if (result.ec != std::errc{} || result.ptr != id.data() + id.size() || parsed == 0) return false;
    value = parsed;
    return true;
}

SCShareableContent *shareableContent() {
    if (!CGPreflightScreenCaptureAccess()) return nil;
    const auto cache = contentCache;
    std::unique_lock lock(cache->mutex);
    const auto now = std::chrono::steady_clock::now();
    if (!cache->pending && now - cache->requested > std::chrono::seconds(1)) {
        cache->pending = true;
        cache->requested = now;
        lock.unlock();
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES
            completionHandler:^(SCShareableContent *content, NSError *error) {
                std::lock_guard guard(cache->mutex);
                cache->content = content;
                cache->error = error ? error.localizedDescription.UTF8String : "";
                cache->pending = false;
                cache->ready.notify_all();
            }];
        lock.lock();
    }
    // A stalled OS request cannot block the UI indefinitely or create a new
    // request on every refresh. Completion owns its cache, never a caller stack.
    if (!cache->content && cache->pending)
        cache->ready.wait_for(lock, std::chrono::milliseconds(500), [&] { return !cache->pending; });
    return cache->content;
}

SCWindow *findWindow(const std::string &id) {
    CGWindowID value;
    if (!parseWindowId(id, value)) return nil;
    for (SCWindow *window in shareableContent().windows)
        if (window.windowID == value) return window;
    return nil;
}

SCStreamConfiguration *configuration(int width, int height, bool alpha = false) {
    auto *config = [SCStreamConfiguration new];
    config.width = width;
    config.height = height;
    // Let the compositor supply fresh frames at its native cadence. Applying
    // another FPS throttle here can undershoot the requested rate before our
    // admission pacer ever sees a frame. CaptureState still bounds readback and
    // delivery to the user's rate, and the shared encoder paces output.
    config.minimumFrameInterval = kCMTimeZero;
    config.pixelFormat = kCVPixelFormatType_32BGRA;
    config.queueDepth = 3;
    // Match Windows Graphics Capture's IsCursorCaptureEnabled(false). The
    // system pointer is an overlay, not part of the selected window's pixels.
    config.showsCursor = NO;
    config.scalesToFit = YES;
    config.preservesAspectRatio = YES;
    config.ignoreShadowsSingleWindow = YES;
    config.capturesAudio = NO;
    config.colorSpaceName = kCGColorSpaceSRGB;
    config.backgroundColor = CGColorGetConstantColor(alpha ? kCGColorClear : kCGColorBlack);
    config.shouldBeOpaque = NO;
    return config;
}

struct Completion {
    std::mutex mutex;
    std::condition_variable ready;
    bool finished = false;
    bool success = false;
    void finish(NSError *error) {
        std::lock_guard lock(mutex);
        success = error == nil;
        finished = true;
        if (error) spdlog::warn("[ScreenCaptureKit] {}", error.localizedDescription.UTF8String);
        ready.notify_all();
    }
    bool wait(std::chrono::milliseconds timeout) {
        std::unique_lock lock(mutex);
        return ready.wait_for(lock, timeout, [&] { return finished; }) && success;
    }
};

struct PixelReadLock {
    CVPixelBufferRef buffer = nullptr;
    explicit PixelReadLock(CVPixelBufferRef value) {
        if (CVPixelBufferLockBaseAddress(value, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess) buffer = value;
    }
    ~PixelReadLock() { if (buffer) CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly); }
    PixelReadLock(const PixelReadLock &) = delete;
    PixelReadLock &operator=(const PixelReadLock &) = delete;
};

struct CaptureState {
    bool preserveAlpha = false;
    CGWindowID windowId = kCGNullWindowID;
    pid_t ownerPid = 0;
    std::atomic<bool> active{false};
    std::atomic<bool> suspended{false};
    std::atomic<uint64_t> skipped{0};
    std::mutex delivery;
    video::WindowCapture::FrameCallback callback;
    video::WindowCapture::FrameAdmissionCallback admission;
    video::detail::CaptureFramePacer pacer{60};
    video::CapturedFrame previous;
    std::optional<double> stableOpacity;
    std::optional<double> pendingOpacity;
    std::chrono::steady_clock::time_point opacityChanged{};
    const int64_t clockOffset = webrtc::mediaTime100ns() -
        CMTimeConvertScale(CMClockGetTime(CMClockGetHostTimeClock()), 10000000, kCMTimeRoundingMethod_Default).value;

    std::optional<double> windowOpacity() const {
        // Query only this generation's window, not every application window.
        // The API takes an array of raw CGWindowID values, not CFNumbers.
        const void *windowValue = reinterpret_cast<const void *>(static_cast<uintptr_t>(windowId));
        const auto ids = CFArrayCreate(kCFAllocatorDefault, &windowValue, 1, nullptr);
        NSArray *descriptions = CFBridgingRelease(CGWindowListCreateDescriptionFromArray(ids));
        CFRelease(ids);
        for (NSDictionary *window in descriptions) {
            if ([window[(id)kCGWindowNumber] unsignedIntValue] == windowId &&
                [window[(id)kCGWindowOwnerPID] intValue] == ownerPid) {
                const double opacity = [window[(id)kCGWindowAlpha] doubleValue];
                if ([window[(id)kCGWindowIsOnscreen] boolValue] && std::isfinite(opacity) && opacity > 0 && opacity <= 1)
                    return opacity;
                return std::nullopt;
            }
        }
        return std::nullopt;
    }

    void receive(CMSampleBufferRef sample) {
        std::lock_guard lock(delivery);
        if (!active || !CMSampleBufferIsValid(sample)) return;
        NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
        NSNumber *statusValue = [attachments.firstObject objectForKey:SCStreamFrameInfoStatus];
        if (!statusValue) return;
        const auto status = static_cast<SCFrameStatus>(statusValue.integerValue);
        if (status == SCFrameStatusStopped) {
            active = false;
            spdlog::warn("[ScreenCaptureKit] Window stream unavailable (status={})", static_cast<int>(status));
            return;
        }
        if (status == SCFrameStatusBlank || status == SCFrameStatusSuspended) {
            // Minimizing/hiding a window suspends its stream without closing
            // it. Keep the native generation alive, but never replay its last
            // image as a fresh capture. Only a complete image can resume it.
            if (!suspended.exchange(true))
                spdlog::info("[ScreenCaptureKit] Window stream suspended (status={})", static_cast<int>(status));
            previous = {};
            pendingOpacity.reset();
            return;
        }
        if (status != SCFrameStatusComplete && status != SCFrameStatusIdle) return;
        if (!pacer.shouldAdmit(std::chrono::steady_clock::now()) || !video::detail::frameAdmissionAllowed(admission)) {
            ++skipped;
            return;
        }
        video::CapturedFrame frame;
        if (status == SCFrameStatusIdle) {
            // Idle is a valid static source. Blank/suspended sources never reuse
            // their last picture to masquerade as a healthy capture.
            if (previous.data.empty()) return;
            frame = previous;
        } else {
            CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
            if (!pixels || CVPixelBufferGetPixelFormatType(pixels) != kCVPixelFormatType_32BGRA) return;
            const size_t width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels);
            if (!width || !height || width > 8192 || height > 8192) return;
            // ScreenCaptureKit's surface can include letterboxing. Its content
            // rectangle is in surface points; convert to pixel coordinates so
            // the shared encoder sees the window's aspect, not a padded canvas.
            CGRect visible = CGRectMake(0, 0, width, height);
            NSDictionary *metadata = attachments.firstObject;
            id rectangle = metadata[SCStreamFrameInfoContentRect];
            id scaleValue = metadata[SCStreamFrameInfoScaleFactor];
            CGRect content{};
            if ([rectangle isKindOfClass:[NSDictionary class]] && [scaleValue isKindOfClass:[NSNumber class]] &&
                CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rectangle, &content)) {
                const double scale = [scaleValue doubleValue];
                content = CGRectMake(content.origin.x * scale, content.origin.y * scale,
                                     content.size.width * scale, content.size.height * scale);
                if (scale > 0 && scale <= 8 && std::isfinite(content.origin.x) && std::isfinite(content.origin.y) &&
                    std::isfinite(content.size.width) && std::isfinite(content.size.height) &&
                    content.size.width > 0 && content.size.height > 0) {
                    const auto clipped = CGRectIntersection(visible, CGRectIntegral(content));
                    if (!CGRectIsEmpty(clipped) && !CGRectIsNull(clipped)) visible = clipped;
                }
            }
            const size_t left = static_cast<size_t>(visible.origin.x), top = static_cast<size_t>(visible.origin.y);
            const size_t copyWidth = static_cast<size_t>(visible.size.width), copyHeight = static_cast<size_t>(visible.size.height);
            {
                const PixelReadLock readLock(pixels);
                if (!readLock.buffer) return;
                const auto *base = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(pixels));
                const size_t stride = CVPixelBufferGetBytesPerRow(pixels);
                if (base && stride >= width * 4) {
                    frame.width = static_cast<int>(copyWidth);
                    frame.height = static_cast<int>(copyHeight);
                    frame.stride = static_cast<int>(copyWidth * 4);
                    frame.data.resize(copyWidth * copyHeight * 4);
                    for (size_t row = 0; row < copyHeight; ++row) {
                        auto *destination = frame.data.data() + row * frame.stride;
                        std::memcpy(destination, base + (top + row) * stride + left * 4, copyWidth * 4);
                        if (preserveAlpha) {
                            // ScreenCaptureKit BGRA is premultiplied. The shared
                            // color/mask and chroma paths require straight RGB.
                            for (size_t x = 0; x < copyWidth; ++x) {
                                auto *pixel = destination + x * 4;
                                const unsigned a = pixel[3];
                                for (int channel = 0; channel < 3; ++channel)
                                    pixel[channel] = a ? std::min(255u, (unsigned(pixel[channel]) * 255u + a / 2u) / a) : 0;
                            }
                        }
                    }
                }
            }
            if (frame.data.empty()) return;
        }
        // During orderOut's fade, SCK can deliver Complete/Idle frames whose
        // alpha is multiplied by the window-server animation, ending in a
        // cleared image before Suspended arrives. Keep the last delivered
        // image while window opacity changes. A deliberate stable opacity
        // change is admitted after 150 ms; normal frames incur no delay.
        // Per-pixel transparency and black content are not visibility signals.
        const auto opacity = windowOpacity();
        if (!opacity) {
            if (!suspended.exchange(true))
                spdlog::info("[ScreenCaptureKit] Window ordered off screen (frame status={}); capture suspended", static_cast<int>(status));
            previous = {};
            pendingOpacity.reset();
            return;
        }
        if (status == SCFrameStatusComplete) previous = frame;
        if (!stableOpacity) stableOpacity = opacity;
        if (std::abs(*opacity - *stableOpacity) > 1e-6) {
            const auto now = std::chrono::steady_clock::now();
            if (!pendingOpacity || std::abs(*opacity - *pendingOpacity) > 1e-6) {
                pendingOpacity = opacity;
                opacityChanged = now;
            }
            if (now - opacityChanged < std::chrono::milliseconds(150)) {
                if (!suspended.exchange(true))
                    spdlog::info("[ScreenCaptureKit] Window opacity changing; retaining the last image");
                return;
            }
            stableOpacity = opacity;
        }
        pendingOpacity.reset();
        const CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
        frame.timestamp = CMTIME_IS_NUMERIC(pts)
            ? clockOffset + CMTimeConvertScale(pts, 10000000, kCMTimeRoundingMethod_Default).value
            : webrtc::mediaTime100ns();
        if (callback) callback(std::move(frame));
        if (suspended.exchange(false))
            spdlog::info("[ScreenCaptureKit] Window stream resumed with a fresh frame");
    }
};
} // namespace

@interface GCCaptureOutput : NSObject <SCStreamOutput, SCStreamDelegate> {
@public
    std::shared_ptr<CaptureState> state;
}
@end
@implementation GCCaptureOutput
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (type == SCStreamOutputTypeScreen) {
        try { state->receive(sample); }
        catch (const std::exception &error) {
            state->active = false;
            spdlog::error("[ScreenCaptureKit] Frame delivery failed: {}", error.what());
        }
    }
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    state->active = false;
    spdlog::warn("[ScreenCaptureKit] Stream stopped: {}", error.localizedDescription.UTF8String);
}
@end

namespace versus::platform {
bool screenCapturePermissionGranted() { return CGPreflightScreenCaptureAccess(); }
bool requestScreenCapturePermission() { return CGRequestScreenCaptureAccess(); }
std::string screenCaptureStatus() {
    if (!screenCapturePermissionGranted())
        return "Allow Screen Recording in System Settings, then restart Game Capture if requested.";
    std::lock_guard lock(contentCache->mutex);
    return contentCache->error;
}
} // namespace versus::platform

namespace versus::video {
struct WindowCapture::Impl {
    // Native lifecycle/configuration operations never race each other. Frame
    // delivery owns only CaptureState and does not acquire this mutex.
    mutable std::mutex lifecycle;
    std::shared_ptr<CaptureState> state = std::make_shared<CaptureState>();
    SCStream *stream = nil;
    GCCaptureOutput *output = nil;
    dispatch_queue_t queue = dispatch_queue_create("ninja.vdo.game-capture.screen", DISPATCH_QUEUE_SERIAL);
    int width = 0, height = 0;
    bool preserveAlpha = false;
    CGWindowID windowId = kCGNullWindowID;
    pid_t ownerPid = 0;
    std::chrono::steady_clock::time_point lastLifetimeCheck{};
    unsigned missingWindowChecks = 0;

    void checkSuspendedWindowLifetime() {
        if (!state->active || !state->suspended) {
            missingWindowChecks = 0;
            return;
        }
        const auto now = std::chrono::steady_clock::now();
        if (now - lastLifetimeCheck < std::chrono::milliseconds(500)) return;
        lastLifetimeCheck = now;
        @autoreleasepool {
            // Unlike the source picker (and IncludingWindow lookup), All
            // includes minimized/hidden window identities. ScreenCaptureKit can
            // report only suspension when a window closes but its app lives.
            NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
            if (!windows) { missingWindowChecks = 0; return; } // Window server unavailable, not proof of closure.
            for (NSDictionary *window in windows) {
                if ([window[(id)kCGWindowNumber] unsignedIntValue] == windowId &&
                    [window[(id)kCGWindowOwnerPID] intValue] == ownerPid) {
                    missingWindowChecks = 0;
                    return;
                }
            }
            if (++missingWindowChecks >= 2) {
                state->active = false;
                spdlog::warn("[ScreenCaptureKit] Suspended source window no longer exists");
            }
        }
    }

    void stop() {
        state->active = false;
        { std::lock_guard barrier(state->delivery); }
        if (stream) {
            // The stop completion retains only native objects/state, so even a
            // delayed OS completion cannot use a destroyed WindowCapture.
            SCStream *stopping = stream;
            GCCaptureOutput *retainedOutput = output;
            const auto done = std::make_shared<Completion>();
            [stopping stopCaptureWithCompletionHandler:^(NSError *error) {
                (void)stopping;
                (void)retainedOutput;
                done->finish(error);
            }];
            done->wait(std::chrono::seconds(2));
            stream = nil;
            output = nil;
        }
    }
};

WindowCapture::WindowCapture() : impl_(std::make_unique<Impl>()) {}
WindowCapture::~WindowCapture() { stopCapture(); }
std::vector<WindowInfo> WindowCapture::getWindows() {
    std::vector<WindowInfo> windows;
    @autoreleasepool {
        for (SCWindow *window in shareableContent().windows) {
            if (window.windowLayer != 0 || window.frame.size.width < 32 || window.frame.size.height < 32) continue;
            auto *app = window.owningApplication;
            if (!app || app.processID == getpid()) continue;
            NSString *title = window.title.length ? window.title : app.applicationName;
            windows.push_back({std::to_string(window.windowID), title.UTF8String ?: "Untitled",
                app.applicationName.UTF8String ?: "", static_cast<uint32_t>(app.processID),
                static_cast<int>(window.frame.size.width), static_cast<int>(window.frame.size.height)});
        }
    }
    return windows;
}
WindowInfo *WindowCapture::findWindowByName(const std::string &filter) {
    thread_local std::vector<WindowInfo> cached;
    cached = getWindows();
    return const_cast<WindowInfo *>(findBestWindowMatch(cached, filter));
}
bool WindowCapture::startCapture(const std::string &id, int width, int height, int fps, bool alpha) {
    std::lock_guard operation(impl_->lifecycle);
    impl_->stop(); capturing_ = false;
    if (width < 2 || height < 2 || width > 8192 || height > 8192 || fps < 1 || fps > 120) return false;
    @autoreleasepool {
        SCWindow *window = findWindow(id);
        if (!window) {
            spdlog::error("[ScreenCaptureKit] Window unavailable. {}", platform::screenCaptureStatus());
            return false;
        }
        // Each start owns a distinct callback generation, including callbacks
        // delivered late after a bounded stop/start timeout.
        impl_->state = std::make_shared<CaptureState>();
        impl_->state->preserveAlpha = alpha;
        impl_->state->windowId = window.windowID;
        impl_->state->ownerPid = window.owningApplication.processID;
        impl_->state->callback = frameCallback_;
        impl_->state->admission = frameAdmissionCallback_;
        impl_->state->pacer.reset(fps);
        impl_->width = width; impl_->height = height;
        impl_->preserveAlpha = alpha;
        impl_->windowId = window.windowID;
        impl_->ownerPid = window.owningApplication.processID;
        impl_->lastLifetimeCheck = {};
        impl_->missingWindowChecks = 0;
        impl_->output = [GCCaptureOutput new];
        impl_->output->state = impl_->state;
        auto *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
        impl_->stream = [[SCStream alloc] initWithFilter:filter configuration:configuration(width, height, alpha) delegate:impl_->output];
        NSError *error = nil;
        if (![impl_->stream addStreamOutput:impl_->output type:SCStreamOutputTypeScreen sampleHandlerQueue:impl_->queue error:&error]) {
            spdlog::error("[ScreenCaptureKit] Could not attach output: {}", error.localizedDescription.UTF8String);
            impl_->stream = nil; impl_->output = nil;
            return false;
        }
        impl_->state->active = true;
        const auto done = std::make_shared<Completion>();
        const auto generation = impl_->state;
        SCStream *starting = impl_->stream;
        GCCaptureOutput *startingOutput = impl_->output;
        [starting startCaptureWithCompletionHandler:^(NSError *error) {
            (void)startingOutput;
            if (error) generation->active = false;
            if (!generation->active && !error)
                [starting stopCaptureWithCompletionHandler:^(NSError *) { (void)starting; }];
            done->finish(error);
        }];
        if (!done->wait(std::chrono::seconds(3))) { impl_->stop(); return false; }
        capturing_ = impl_->state->active.load();
        return capturing_;
    }
}
void WindowCapture::stopCapture() { std::lock_guard operation(impl_->lifecycle); impl_->stop(); capturing_ = false; }
bool WindowCapture::isCapturing() const {
    std::lock_guard operation(impl_->lifecycle);
    impl_->checkSuspendedWindowLifetime();
    return impl_->state->active;
}
bool WindowCapture::isSuspended() const {
    std::lock_guard operation(impl_->lifecycle);
    return impl_->state->active && impl_->state->suspended;
}
bool WindowCapture::ensureFrameSize(int width, int height) {
    if (width < 2 || height < 2 || width > 8192 || height > 8192) return false;
    std::lock_guard operation(impl_->lifecycle);
    if (!impl_->stream || !impl_->state->active) return false;
    width = std::max(width, impl_->width); height = std::max(height, impl_->height);
    if (width == impl_->width && height == impl_->height) return true;
    @autoreleasepool {
        const auto done = std::make_shared<Completion>();
        SCStream *updating = impl_->stream;
        GCCaptureOutput *updatingOutput = impl_->output;
        [updating updateConfiguration:configuration(width, height, impl_->preserveAlpha)
            completionHandler:^(NSError *error) { (void)updating; (void)updatingOutput; done->finish(error); }];
        if (!done->wait(std::chrono::seconds(1)) || !impl_->state->active) {
            // A timeout cannot be treated as "unchanged": a late OS update may
            // still apply. Quarantine/stop this generation instead of allowing
            // it to affect a later capture or claiming the new size is ready.
            spdlog::error("[ScreenCaptureKit] Native size update failed; stopping capture");
            impl_->stop(); capturing_ = false;
            return false;
        }
        impl_->width = width; impl_->height = height;
        spdlog::info("[ScreenCaptureKit] Capture canvas enlarged to {}x{}", width, height);
        return true;
    }
}
void WindowCapture::setFrameRate(int fps) {
    std::lock_guard operation(impl_->lifecycle);
    fps = std::clamp(fps, 1, 120);
    { std::lock_guard lock(impl_->state->delivery); impl_->state->pacer.reset(fps); }
}
void WindowCapture::setFrameCallback(FrameCallback cb) {
    std::lock_guard operation(impl_->lifecycle);
    std::lock_guard lock(impl_->state->delivery);
    frameCallback_ = std::move(cb); impl_->state->callback = frameCallback_;
}
void WindowCapture::setFrameAdmissionCallback(FrameAdmissionCallback cb) {
    std::lock_guard operation(impl_->lifecycle);
    std::lock_guard lock(impl_->state->delivery);
    frameAdmissionCallback_ = std::move(cb); impl_->state->admission = frameAdmissionCallback_;
}
uint64_t WindowCapture::framesSkippedBeforeReadback() const { std::lock_guard operation(impl_->lifecycle); return impl_->state->skipped; }

QPixmap WindowCapture::captureWindowThumbnail(const std::string &id, int maxWidth, int maxHeight) {
    CGWindowID parsed;
    if (!parseWindowId(id, parsed) || maxWidth <= 0 || maxHeight <= 0 || maxWidth > 4096 || maxHeight > 4096) return {};
    struct Preview {
        bool pending = false;
        QImage image;
        std::chrono::steady_clock::time_point updated{}, visited{};
    };
    struct PreviewCache {
        std::mutex mutex;
        std::unordered_map<std::string, std::shared_ptr<Preview>> entries;
        size_t thumbnailRequests = 0;
        bool largeRequest = false;
    };
    static const auto cache = std::make_shared<PreviewCache>();
    const bool large = maxWidth > 120 || maxHeight > 68;
    const auto key = id + ":" + std::to_string(maxWidth) + "x" + std::to_string(maxHeight);
    std::shared_ptr<Preview> preview;
    QImage result;
    {
        std::lock_guard lock(cache->mutex);
        if (!cache->entries.contains(key)) {
            if (cache->entries.size() >= 64) {
                auto oldest = cache->entries.end();
                for (auto it = cache->entries.begin(); it != cache->entries.end(); ++it)
                    if (!it->second->pending && (oldest == cache->entries.end() || it->second->visited < oldest->second->visited)) oldest = it;
                if (oldest == cache->entries.end()) return {};
                cache->entries.erase(oldest);
            }
            cache->entries.emplace(key, std::make_shared<Preview>());
        }
        preview = cache->entries.at(key);
        const auto now = std::chrono::steady_clock::now();
        preview->visited = now;
        const auto age = now - preview->updated;
        if (age < std::chrono::seconds(large ? 2 : 10)) result = preview->image;
        if (preview->pending || age < std::chrono::milliseconds(large ? 200 : 5000) ||
            (large ? cache->largeRequest : cache->thumbnailRequests >= 8)) return QPixmap::fromImage(result);
        preview->pending = true;
        if (large) cache->largeRequest = true;
        else ++cache->thumbnailRequests;
    }
    SCWindow *window = findWindow(id);
    if (!window) {
        std::lock_guard lock(cache->mutex);
        preview->pending = false; preview->image = {};
        if (large) cache->largeRequest = false;
        else --cache->thumbnailRequests;
        return {};
    }
    const auto requests = cache;
    auto *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    [SCScreenshotManager captureImageWithFilter:filter configuration:configuration(maxWidth, maxHeight)
        completionHandler:^(CGImageRef image, NSError *error) {
            QImage copied;
            if (image && !error) {
                const size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
                copied = QImage(static_cast<int>(width), static_cast<int>(height), QImage::Format_ARGB32);
                CGColorSpaceRef colors = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
                CGContextRef context = CGBitmapContextCreate(copied.bits(), width, height, 8, copied.bytesPerLine(), colors,
                    kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
                if (context) { CGContextDrawImage(context, CGRectMake(0, 0, width, height), image); CGContextRelease(context); }
                else copied = {};
                CGColorSpaceRelease(colors);
            }
            std::lock_guard lock(requests->mutex);
            preview->image = std::move(copied); preview->pending = false;
            if (large) requests->largeRequest = false;
            else --requests->thumbnailRequests;
            preview->updated = std::chrono::steady_clock::now();
        }];
    return QPixmap::fromImage(result);
}
} // namespace versus::video
