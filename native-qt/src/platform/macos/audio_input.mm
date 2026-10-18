#include "versus/platform/macos_audio_input.h"
#include "versus/webrtc/media_clock.h"
#import <AVFoundation/AVFoundation.h>
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <utility>
#include <spdlog/spdlog.h>

namespace {
using namespace versus;
NSArray<AVCaptureDevice *> *devices() {
    return [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:
        @[AVCaptureDeviceTypeMicrophone, AVCaptureDeviceTypeExternal]
        mediaType:AVMediaTypeAudio position:AVCaptureDevicePositionUnspecified].devices;
}
struct Completion {
    std::mutex mutex;
    std::condition_variable ready;
    bool done = false;
    std::string error;
    void finish(std::string message = {}) {
        std::lock_guard lock(mutex); error = std::move(message); done = true; ready.notify_all();
    }
    std::string wait() {
        std::unique_lock lock(mutex);
        if (!ready.wait_for(lock, std::chrono::seconds(3), [&] { return done; }))
            return "Microphone operation timed out. The input has been cancelled.";
        return error;
    }
};
struct InputState {
    std::atomic<bool> active{false};
    std::mutex delivery;
    audio::WindowAudioCaptureCore::StreamCallback callback;
    std::vector<float> buffered;
    __weak AVCaptureSession *session = nil;
    const int64_t clockOffset = webrtc::mediaTime100ns() -
        CMTimeConvertScale(CMClockGetTime(CMClockGetHostTimeClock()), 10000000, kCMTimeRoundingMethod_Default).value;
    void receive(CMSampleBufferRef sample) {
        std::lock_guard lock(delivery);
        if (!active || !CMSampleBufferIsValid(sample) || !CMSampleBufferDataIsReady(sample)) return;
        auto description = CMSampleBufferGetFormatDescription(sample);
        const auto *format = description ? CMAudioFormatDescriptionGetStreamBasicDescription(description) : nullptr;
        if (!format || format->mFormatID != kAudioFormatLinearPCM || format->mBitsPerChannel != 32 ||
            !(format->mFormatFlags & kAudioFormatFlagIsFloat) || (format->mFormatFlags & kAudioFormatFlagIsBigEndian) ||
            format->mSampleRate != 48000 || format->mChannelsPerFrame != 2) {
            active = false; spdlog::error("[MacMicrophone] Unexpected converted input format; input stopped"); return;
        }
        const auto frames = CMSampleBufferGetNumSamples(sample);
        if (frames <= 0 || frames > 48000) return;
        size_t bytes = 0;
        if (CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, &bytes, nullptr, 0,
            nullptr, nullptr, 0, nullptr) || bytes < sizeof(AudioBufferList) || bytes > 4096) return;
        std::vector<std::max_align_t> storage((bytes + sizeof(std::max_align_t) - 1) / sizeof(std::max_align_t));
        auto *list = reinterpret_cast<AudioBufferList *>(storage.data());
        CMBlockBufferRef block = nullptr;
        if (CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, nullptr, list, bytes,
            nullptr, nullptr, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &block)) return;
        struct Release { CMBlockBufferRef value; ~Release() { if (value) CFRelease(value); } } release{block};
        const bool planar = format->mFormatFlags & kAudioFormatFlagIsNonInterleaved;
        if (list->mNumberBuffers != (planar ? 2u : 1u)) return;
        for (unsigned index = 0; index < list->mNumberBuffers; ++index) {
            const auto &buffer = list->mBuffers[index];
            if (!buffer.mData || buffer.mNumberChannels != (planar ? 1u : 2u) ||
                buffer.mDataByteSize < static_cast<size_t>(frames) * sizeof(float) * (planar ? 1 : 2)) return;
        }
        audio::StreamChunk chunk;
        chunk.samples.resize(frames * 2);
        for (size_t index = 0; index < chunk.samples.size(); ++index) {
            const auto value = planar ? static_cast<const float *>(list->mBuffers[index % 2].mData)[index / 2]
                                     : static_cast<const float *>(list->mBuffers[0].mData)[index];
            chunk.samples[index] = std::isfinite(value) ? std::clamp(value, -1.0f, 1.0f) : 0;
        }
        AVCaptureSession *current = session;
        CMClockRef clock = current.synchronizationClock;
        const auto pts = CMSampleBufferGetPresentationTimeStamp(sample);
        const auto hostTime = clock && CMTIME_IS_NUMERIC(pts)
            ? CMSyncConvertTime(pts, clock, CMClockGetHostTimeClock()) : kCMTimeInvalid;
        chunk.captureTime100ns = CMTIME_IS_NUMERIC(hostTime)
            ? clockOffset + CMTimeConvertScale(hostTime, 10000000, kCMTimeRoundingMethod_Default).value : 0;
        if (callback) callback(std::move(chunk));
        else {
            constexpr size_t maximum = 48000 * 2 * 15;
            if (buffered.size() + chunk.samples.size() > maximum)
                buffered.erase(buffered.begin(), buffered.begin() + (buffered.size() + chunk.samples.size() - maximum));
            buffered.insert(buffered.end(), chunk.samples.begin(), chunk.samples.end());
        }
    }
};
}
@interface GCMicrophoneOutput : NSObject <AVCaptureAudioDataOutputSampleBufferDelegate> {
@public
    std::shared_ptr<InputState> state;
}
@end
@implementation GCMicrophoneOutput
- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)sample fromConnection:(AVCaptureConnection *)connection {
    try { state->receive(sample); }
    catch (const std::exception &error) { state->active = false; spdlog::error("[MacMicrophone] {}", error.what()); }
}
@end
namespace {
struct Generation {
    std::shared_ptr<InputState> state = std::make_shared<InputState>();
    AVCaptureSession *session = nil;
    AVCaptureAudioDataOutput *output = nil;
    GCMicrophoneOutput *delegate = nil;
    NSMutableArray *observers = [NSMutableArray new];
    dispatch_queue_t delivery = dispatch_queue_create("ninja.vdo.game-capture.microphone.samples",
        dispatch_queue_attr_make_with_autorelease_frequency(DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM));
    void stopNative() {
        state->active = false;
        [output setSampleBufferDelegate:nil queue:nil];
        [session stopRunning];
        for (id observer in observers) [NSNotificationCenter.defaultCenter removeObserver:observer];
        [observers removeAllObjects];
        session = nil; output = nil; delegate = nil;
    }
};
}
namespace versus::platform {
std::string microphonePermissionStatus() {
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
        case AVAuthorizationStatusAuthorized: return "granted";
        case AVAuthorizationStatusDenied: return "denied";
        case AVAuthorizationStatusRestricted: return "restricted";
        default: return "not_determined";
    }
}
std::vector<audio::AudioDeviceInfo> macAudioInputDevices() { @autoreleasepool {
    std::vector<audio::AudioDeviceInfo> result;
    AVCaptureDevice *defaultDevice = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
    for (AVCaptureDevice *device in devices()) {
        if (!device.connected) continue;
        audio::AudioDeviceInfo info;
        info.id = device.uniqueID.UTF8String ?: "";
        info.name = device.localizedName.UTF8String ?: "Audio input";
        info.isDefault = [device.uniqueID isEqualToString:defaultDevice.uniqueID];
        const auto description = device.activeFormat.formatDescription;
        if (const auto *format = description ? CMAudioFormatDescriptionGetStreamBasicDescription(description) : nullptr) {
            info.sampleRate = format->mSampleRate; info.channels = format->mChannelsPerFrame;
            info.bitsPerSample = info.validBitsPerSample = format->mBitsPerChannel;
            info.floatingPoint = format->mFormatFlags & kAudioFormatFlagIsFloat;
        }
        result.push_back(std::move(info));
    }
    return result;
} }
struct MacAudioInput::Impl {
    std::shared_ptr<Generation> current = std::make_shared<Generation>();
    dispatch_queue_t control = dispatch_queue_create("ninja.vdo.game-capture.microphone.control",
        dispatch_queue_attr_make_with_autorelease_frequency(DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM));
};
MacAudioInput::MacAudioInput() : impl_(std::make_unique<Impl>()) {}
MacAudioInput::~MacAudioInput() { stop(); }
audio::CaptureResult MacAudioInput::start(const std::string &id, audio::WindowAudioCaptureCore::StreamCallback callback) { @autoreleasepool {
    stop();
    AVCaptureDevice *selected = nil;
    if (id.empty()) selected = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
    else for (AVCaptureDevice *device in devices())
        if (id == (device.uniqueID.UTF8String ?: "")) { selected = device; break; }
    if (!selected || !selected.connected)
        return {false, false, 0, 0, "Selected microphone/input is unavailable. Select an available input; no other device was opened."};
    const auto permission = microphonePermissionStatus();
    if (permission == "not_determined") {
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
            spdlog::info("[MacMicrophone] Permission {}. Start capture again to use the selected input.", granted ? "granted" : "denied");
        }];
        return {false, false, 0, 0, "Microphone permission requested. Allow Game Capture in the macOS prompt, then start again."};
    }
    if (permission != "granted") return {false, false, 0, 0,
        "Microphone access is denied or restricted. Enable Game Capture in System Settings > Privacy & Security > Microphone."};
    auto generation = std::make_shared<Generation>();
    generation->state->callback = std::move(callback);
    generation->state->active = true;
    std::atomic_store(&impl_->current, generation);
    auto completion = std::make_shared<Completion>();
    dispatch_async(impl_->control, ^{
        @try {
            NSError *error = nil;
            auto input = [AVCaptureDeviceInput deviceInputWithDevice:selected error:&error];
            if (!input) { completion->finish(error.localizedDescription.UTF8String ?: "Could not open selected microphone"); return; }
            generation->session = [AVCaptureSession new];
            generation->state->session = generation->session;
            generation->output = [AVCaptureAudioDataOutput new];
            generation->output.audioSettings = @{AVFormatIDKey:@(kAudioFormatLinearPCM), AVSampleRateKey:@48000,
                AVNumberOfChannelsKey:@2, AVLinearPCMBitDepthKey:@32, AVLinearPCMIsFloatKey:@YES,
                AVLinearPCMIsNonInterleaved:@NO};
            if (![generation->session canAddInput:input] || ![generation->session canAddOutput:generation->output]) {
                completion->finish("Could not configure the selected microphone session"); return;
            }
            [generation->session addInput:input]; [generation->session addOutput:generation->output];
            generation->delegate = [GCMicrophoneOutput new]; generation->delegate->state = generation->state;
            [generation->output setSampleBufferDelegate:generation->delegate queue:generation->delivery];
            const auto state = generation->state;
            auto failed = ^(NSNotification *notification) {
                state->active = false;
                spdlog::warn("[MacMicrophone] Input unavailable ({}). No replacement device will be opened.", notification.name.UTF8String);
            };
            for (NSNotificationName name in @[AVCaptureSessionRuntimeErrorNotification, AVCaptureSessionWasInterruptedNotification])
                [generation->observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:name object:generation->session queue:nil usingBlock:failed]];
            [generation->observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:AVCaptureDeviceWasDisconnectedNotification object:selected queue:nil usingBlock:failed]];
            if (state->active) [generation->session startRunning];
            if (!state->active || !generation->session.running) {
                generation->stopNative(); completion->finish("Selected microphone failed to start or capture was cancelled"); return;
            }
            completion->finish();
        } @catch (NSException *exception) { completion->finish(exception.reason.UTF8String ?: "Microphone configuration failed"); }
    });
    const auto error = completion->wait();
    if (!error.empty()) { stop(); return {false, false, 0, 0, error}; }
    spdlog::info("[MacMicrophone] Capturing '{}' as 48000 Hz stereo", selected.localizedName.UTF8String);
    return {true, false, 48000, 2, ""};
} }
void MacAudioInput::stop() {
    auto generation = std::atomic_load(&impl_->current);
    generation->state->active = false;
    { std::lock_guard barrier(generation->state->delivery); generation->state->callback = {}; generation->state->buffered.clear(); }
    auto completion = std::make_shared<Completion>();
    dispatch_async(impl_->control, ^{ generation->stopNative(); completion->finish(); });
    const auto error = completion->wait();
    if (!error.empty()) spdlog::warn("[MacMicrophone] {}", error);
}
bool MacAudioInput::active() const { return std::atomic_load(&impl_->current)->state->active; }
std::vector<float> MacAudioInput::drain() {
    const auto generation = std::atomic_load(&impl_->current);
    std::lock_guard lock(generation->state->delivery);
    return std::exchange(generation->state->buffered, {});
}
}
