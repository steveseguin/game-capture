#include "versus/video/camera_capture.h"
#include "versus/platform/macos_camera.h"
#include "versus/webrtc/media_clock.h"
#import <AVFoundation/AVFoundation.h>
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <limits>
#include <mutex>
#include <spdlog/spdlog.h>

namespace {
using namespace versus;
NSArray<AVCaptureDevice *> *cameraDevices() {
    return [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:
        @[AVCaptureDeviceTypeBuiltInWideAngleCamera, AVCaptureDeviceTypeExternal,
          AVCaptureDeviceTypeContinuityCamera]
        mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified].devices;
}

struct CameraState {
    std::atomic<bool> active{false}, firstFrame{false};
    std::atomic<int64_t> lastDelivery100ns{0};
    std::mutex statusMutex, deliveryMutex;
    std::condition_variable ready;
    std::string error;
    video::CameraCapture::FrameCallback callback;
    video::detail::CaptureFramePacer pacer;
    __weak AVCaptureSession *session = nil;
    const int64_t clockOffset = webrtc::mediaTime100ns() -
        CMTimeConvertScale(CMClockGetTime(CMClockGetHostTimeClock()), 10000000, kCMTimeRoundingMethod_Default).value;

    void fail(std::string message) {
        { std::lock_guard lock(statusMutex); error = std::move(message); active = false; }
        ready.notify_all();
    }
    std::string lastError() {
        std::lock_guard lock(statusMutex); return error;
    }
    bool waitForFirstFrame() {
        std::unique_lock lock(statusMutex);
        if (!ready.wait_for(lock, std::chrono::seconds(4), [&] { return firstFrame || !active; })) {
            error = "No first frame from the selected camera. It may be busy, disconnected, or an inactive virtual camera. Start its sender or select another camera, then retry.";
            active = false;
        }
        return active && firstFrame;
    }
    void receive(CMSampleBufferRef sample) {
        std::lock_guard lock(deliveryMutex);
        if (!active || !CMSampleBufferIsValid(sample) || !CMSampleBufferDataIsReady(sample)) return;
        if (!pacer.shouldAdmit(std::chrono::steady_clock::now())) return;
        CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
        if (!buffer || CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA ||
            CVPixelBufferIsPlanar(buffer)) { fail("Camera returned an unsupported converted pixel format."); return; }
        const size_t width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer);
        if (!width || !height || width > 8192 || height > 8192) { fail("Camera returned invalid frame dimensions."); return; }
        if (CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly)) return;
        struct Unlock {
            CVPixelBufferRef buffer;
            ~Unlock() { CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly); }
        } unlock{buffer};
        const auto *pixels = static_cast<const uint8_t *>(CVPixelBufferGetBaseAddress(buffer));
        const size_t stride = CVPixelBufferGetBytesPerRow(buffer);
        if (!pixels || stride < width * 4) { fail("Camera returned an invalid pixel buffer."); return; }
        AVCaptureSession *current = session;
        CMClockRef clock = current.synchronizationClock;
        const CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
        const CMTime host = clock && CMTIME_IS_NUMERIC(pts)
            ? CMSyncConvertTime(pts, clock, CMClockGetHostTimeClock()) : kCMTimeInvalid;
        if (!CMTIME_IS_NUMERIC(host)) { fail("Camera returned an invalid frame clock."); return; }
        video::CapturedFrame frame;
        frame.width = static_cast<int>(width); frame.height = static_cast<int>(height);
        frame.stride = frame.width * 4; frame.format = video::CapturedFrame::Format::BGRA;
        frame.timestamp = clockOffset + CMTimeConvertScale(host, 10000000, kCMTimeRoundingMethod_Default).value;
        frame.data.resize(width * height * 4);
        for (size_t row = 0; row < height; ++row)
            std::memcpy(frame.data.data() + row * width * 4, pixels + row * stride, width * 4);
        if (!active) return;
        lastDelivery100ns = webrtc::mediaTime100ns();
        if (callback) callback(std::move(frame));
        { std::lock_guard statusLock(statusMutex); firstFrame = true; }
        ready.notify_all();
    }
};
}

@interface GCCameraOutput : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate> {
@public
    std::shared_ptr<CameraState> state;
}
@end
@implementation GCCameraOutput
- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)sample fromConnection:(AVCaptureConnection *)connection {
    try { state->receive(sample); }
    catch (const std::exception &error) { state->fail(std::string("Camera frame delivery failed: ") + error.what()); }
}
@end

namespace {
struct CameraGeneration {
    std::shared_ptr<CameraState> state = std::make_shared<CameraState>();
    AVCaptureSession *session = nil;
    AVCaptureVideoDataOutput *output = nil;
    GCCameraOutput *delegate = nil;
    NSMutableArray *observers = [NSMutableArray new];
    dispatch_queue_t delivery = dispatch_queue_create("ninja.vdo.game-capture.camera.samples",
        dispatch_queue_attr_make_with_autorelease_frequency(DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM));
    void stopNative() {
        [output setSampleBufferDelegate:nil queue:nil];
        [session stopRunning];
        for (id observer in observers) [NSNotificationCenter.defaultCenter removeObserver:observer];
        [observers removeAllObjects];
        output = nil; delegate = nil; session = nil;
    }
};
struct CameraFormatChoice {
    AVCaptureDeviceFormat *format = nil;
    double fps = 0;
    CMTime duration = kCMTimeInvalid;
    double score = std::numeric_limits<double>::infinity();
};
CameraFormatChoice chooseFormat(AVCaptureDevice *device, int width, int height, int fps) {
    CameraFormatChoice choice;
    for (AVCaptureDeviceFormat *format in device.formats) {
        const auto size = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
        if (size.width <= 0 || size.height <= 0 || size.width > 8192 || size.height > 8192) continue;
        for (AVFrameRateRange *range in format.videoSupportedFrameRateRanges) {
            if (range.minFrameRate <= 0 || range.maxFrameRate < range.minFrameRate) continue;
            const double rate = std::clamp(static_cast<double>(fps), range.minFrameRate, range.maxFrameRate);
            if (!std::isfinite(rate) || rate > 240) continue;
            const CMTime duration = std::abs(rate - range.maxFrameRate) < .000001 ? range.minFrameDuration :
                std::abs(rate - range.minFrameRate) < .000001 ? range.maxFrameDuration :
                CMTimeMake(1000000, static_cast<int32_t>(std::llround(rate * 1000000)));
            const double score = std::abs(size.width - width) + std::abs(size.height - height) + 40 * std::abs(rate - fps);
            if (score < choice.score) choice = {format, rate, duration, score};
        }
    }
    return choice;
}
}

namespace versus::platform {
std::string cameraPermissionStatus() {
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]) {
        case AVAuthorizationStatusAuthorized: return "granted";
        case AVAuthorizationStatusDenied: return "denied";
        case AVAuthorizationStatusRestricted: return "restricted";
        default: return "not_determined";
    }
}
}

namespace versus::video {
struct CameraCapture::Impl {
    std::shared_ptr<CameraGeneration> current = std::make_shared<CameraGeneration>();
    dispatch_queue_t control = dispatch_queue_create("ninja.vdo.game-capture.camera.control",
        dispatch_queue_attr_make_with_autorelease_frequency(DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM));
};
CameraCapture::CameraCapture() : impl_(std::make_unique<Impl>()) {}
CameraCapture::~CameraCapture() { stopCapture(); }
std::vector<WindowInfo> CameraCapture::getCameras() { @autoreleasepool {
    std::vector<WindowInfo> cameras;
    for (AVCaptureDevice *device in cameraDevices()) {
        if (!device.connected) continue;
        WindowInfo info;
        info.id = device.uniqueID.UTF8String ?: "";
        info.name = device.localizedName.UTF8String ?: "Camera";
        info.executableName = "Video input device";
        if (auto description = device.activeFormat.formatDescription) {
            auto size = CMVideoFormatDescriptionGetDimensions(description);
            info.width = size.width; info.height = size.height;
        }
        if (!info.id.empty()) cameras.push_back(std::move(info));
    }
    std::stable_sort(cameras.begin(), cameras.end(), [](const auto &left, const auto &right) { return left.name < right.name; });
    return cameras;
} }
bool CameraCapture::startCapture(const std::string &deviceId, int width, int height, int fps) { @autoreleasepool {
    stopCapture();
    auto generation = std::make_shared<CameraGeneration>();
    std::atomic_store(&impl_->current, generation);
    auto state = generation->state;
    if (deviceId.empty() || width <= 0 || height <= 0 || width > 8192 || height > 8192 || fps <= 0 || fps > 240) {
        state->fail("Select a camera and a valid capture size/frame rate."); return false;
    }
    AVCaptureDevice *selected = nil;
    for (AVCaptureDevice *device in cameraDevices())
        if (deviceId == (device.uniqueID.UTF8String ?: "")) { selected = device; break; }
    if (!selected || !selected.connected) { state->fail("Selected camera is unavailable. No replacement camera was opened."); return false; }
    const auto permission = platform::cameraPermissionStatus();
    if (permission == "not_determined") {
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
            spdlog::info("[MacCamera] Permission {}. Start capture again to use the selected camera.", granted ? "granted" : "denied");
        }];
        state->fail("Camera permission requested. Allow Game Capture in the macOS prompt, then start again."); return false;
    }
    if (permission != "granted") {
        state->fail("Camera access is denied or restricted. Enable Game Capture in System Settings > Privacy & Security > Camera."); return false;
    }
    state->callback = frameCallback_; state->pacer.reset(fps); state->active = true;
    dispatch_async(impl_->control, ^{
        @try {
            if (!state->active) return;
            NSError *error = nil;
            const auto choice = chooseFormat(selected, width, height, fps);
            if (!choice.format) { state->fail("Selected camera has no usable video format."); return; }
            auto input = [AVCaptureDeviceInput deviceInputWithDevice:selected error:&error];
            if (!input) { state->fail(error.localizedDescription.UTF8String ?: "Could not open the selected camera; it may be busy."); return; }
            generation->session = [AVCaptureSession new]; state->session = generation->session;
            generation->output = [AVCaptureVideoDataOutput new];
            generation->output.alwaysDiscardsLateVideoFrames = YES;
            if (![generation->output.availableVideoCVPixelFormatTypes containsObject:@(kCVPixelFormatType_32BGRA)]) {
                state->fail("Selected camera cannot produce converted BGRA video."); return;
            }
            generation->output.videoSettings = @{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA)};
            if (![generation->session canAddInput:input] || ![generation->session canAddOutput:generation->output]) {
                state->fail("Could not configure the selected camera session."); return;
            }
            [generation->session beginConfiguration];
            [generation->session addInput:input]; [generation->session addOutput:generation->output];
            if (![selected lockForConfiguration:&error]) {
                [generation->session commitConfiguration];
                state->fail(error.localizedDescription.UTF8String ?: "Could not configure camera format; it may be busy."); return;
            }
            @try {
                selected.activeFormat = choice.format;
                selected.activeVideoMinFrameDuration = choice.duration;
                selected.activeVideoMaxFrameDuration = choice.duration;
            } @finally { [selected unlockForConfiguration]; [generation->session commitConfiguration]; }
            AVCaptureConnection *connection = [generation->output connectionWithMediaType:AVMediaTypeVideo];
            if (connection.supportsVideoMirroring) {
                connection.automaticallyAdjustsVideoMirroring = NO; connection.videoMirrored = NO;
            }
            generation->delegate = [GCCameraOutput new]; generation->delegate->state = state;
            [generation->output setSampleBufferDelegate:generation->delegate queue:generation->delivery];
            auto failed = ^(NSNotification *notification) {
                state->fail("Selected camera stopped (" + std::string(notification.name.UTF8String ?: "native capture error") +
                    "). Reconnect it, check Camera privacy settings, or close other camera apps, then retry. No replacement camera was opened.");
            };
            for (NSNotificationName name in @[AVCaptureSessionRuntimeErrorNotification, AVCaptureSessionWasInterruptedNotification])
                [generation->observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:name object:generation->session queue:nil usingBlock:failed]];
            [generation->observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:AVCaptureDeviceWasDisconnectedNotification object:selected queue:nil usingBlock:failed]];
            if (state->active) [generation->session startRunning];
            if (!state->active || !generation->session.running) {
                if (state->active) state->fail("Selected camera failed to start.");
                generation->stopNative(); return;
            }
            const auto size = CMVideoFormatDescriptionGetDimensions(choice.format.formatDescription);
            spdlog::info("[MacCamera] '{}' native format {}x{} at {} fps; requested {}x{} at {} fps",
                selected.localizedName.UTF8String, size.width, size.height, choice.fps, width, height, fps);
        } @catch (NSException *exception) { state->fail(exception.reason.UTF8String ?: "Camera configuration failed."); }
    });
    if (!state->waitForFirstFrame()) { stopCapture(); return false; }
    return true;
} }
void CameraCapture::stopCapture() {
    auto generation = std::atomic_load(&impl_->current);
    { std::lock_guard lock(generation->state->statusMutex); generation->state->active = false; }
    generation->state->ready.notify_all();
    { std::lock_guard lock(generation->state->deliveryMutex); generation->state->callback = {}; }
    auto stopped = dispatch_semaphore_create(0);
    dispatch_async(impl_->control, ^{
        @try { generation->stopNative(); }
        @catch (NSException *exception) { spdlog::warn("[MacCamera] Stop failed: {}", exception.reason.UTF8String); }
        dispatch_semaphore_signal(stopped);
    });
    if (dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)))
        spdlog::warn("[MacCamera] Native stop is still pending; retired generation cannot deliver frames.");
}
bool CameraCapture::isCapturing() const {
    auto state = std::atomic_load(&impl_->current)->state;
    if (state->active && state->firstFrame && webrtc::mediaTime100ns() - state->lastDelivery100ns.load() > 50000000)
        state->fail("Selected camera stopped delivering frames. Check its connection or virtual-camera sender, then retry. No replacement camera was opened.");
    return state->active && state->firstFrame;
}
std::string CameraCapture::lastError() const { return std::atomic_load(&impl_->current)->state->lastError(); }
void CameraCapture::setFrameCallback(FrameCallback cb) { frameCallback_ = std::move(cb); }
}
