#include "versus/audio/window_audio_capture_core.h"
#include "versus/webrtc/media_clock.h"
#include "versus/platform/macos_audio_input.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <libproc.h>
#include <array>
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <cstddef>
#include <utility>
#include <spdlog/spdlog.h>

namespace {
using namespace versus::audio;
struct Completion {
    std::mutex mutex;
    std::condition_variable ready;
    bool done = false;
    std::string error;
    void finish(NSError *failure) {
        std::lock_guard lock(mutex);
        error = failure ? failure.localizedDescription.UTF8String : "";
        done = true;
        ready.notify_all();
    }
    std::string wait() {
        std::unique_lock lock(mutex);
        if (!ready.wait_for(lock, std::chrono::seconds(3), [&] { return done; }))
            return "ScreenCaptureKit audio operation timed out";
        return error;
    }
};
struct ContentRequest : Completion { SCShareableContent *content = nil; };
SCShareableContent *content() {
    if (!CGPreflightScreenCaptureAccess()) return nil;
    auto request = std::make_shared<ContentRequest>();
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
        completionHandler:^(SCShareableContent *value, NSError *error) {
            request->content = value;
            request->finish(error);
        }];
    if (!request->wait().empty()) return nil;
    return request->content;
}

AudioObjectPropertyAddress address(AudioObjectPropertySelector selector) {
    return {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
}
template<class T> bool property(AudioObjectID object, AudioObjectPropertySelector selector, T &value) {
    auto key = address(selector);
    UInt32 size = sizeof(value);
    return AudioObjectGetPropertyData(object, &key, 0, nullptr, &size, &value) == noErr && size == sizeof(value);
}
bool processInfo(pid_t pid, proc_bsdinfo &info) {
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info);
}
bool descendant(pid_t pid, pid_t root) {
    for (unsigned depth = 0; depth < 64 && pid > 1; ++depth) {
        if (pid == root) return true;
        proc_bsdinfo info{};
        if (!processInfo(pid, info) || info.pbi_ppid == pid) return false;
        pid = info.pbi_ppid;
    }
    return false;
}
NSArray<NSNumber *> *audioProcesses(pid_t root) {
    auto key = address(kAudioHardwarePropertyProcessObjectList);
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &key, 0, nullptr, &size) || size > 1024 * 1024)
        return nil;
    std::vector<AudioObjectID> processes(size / sizeof(AudioObjectID));
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &key, 0, nullptr, &size, processes.data())) return nil;
    auto *selected = [NSMutableArray<NSNumber *> new];
    for (size_t index = 0; index < size / sizeof(AudioObjectID); ++index) {
        pid_t pid = 0;
        if (property(processes[index], kAudioProcessPropertyPID, pid) && descendant(pid, root))
            [selected addObject:@(processes[index])];
    }
    return selected;
}

struct AudioState {
    static constexpr size_t slots = 8, maximumFrames = 16384;
    struct Packet { std::array<float, maximumFrames * 2> samples; size_t count; int64_t timestamp; };
    std::array<Packet, slots> packets;
    std::atomic<uint64_t> written{0}, read{0}, dropped{0};
    std::atomic<bool> active{false};
    dispatch_semaphore_t available = dispatch_semaphore_create(0);
    WindowAudioCaptureCore::StreamCallback callback;
    std::mutex bufferMutex;
    std::vector<float> buffered;
    uint32_t sampleRate = 48000;
    const int64_t clockOffset = versus::webrtc::mediaTime100ns() -
        CMTimeConvertScale(CMClockGetTime(CMClockGetHostTimeClock()), 10000000, kCMTimeRoundingMethod_Default).value;

    // Core Audio invokes this on its real-time thread. Never allocate, lock, log,
    // encode or invoke application code here. A bounded SPSC queue owns the copy.
    void receive(const AudioBufferList *input, const AudioTimeStamp *time) noexcept {
        if (!active.load(std::memory_order_acquire) || !input || !input->mNumberBuffers) return;
        const bool planar = input->mNumberBuffers == 2;
        if (!planar && input->mNumberBuffers != 1) return;
        const auto &first = input->mBuffers[0];
        if (!first.mData || first.mNumberChannels != (planar ? 1 : 2) ||
            first.mDataByteSize % (sizeof(float) * first.mNumberChannels)) return;
        const size_t frames = first.mDataByteSize / sizeof(float) / first.mNumberChannels;
        if (!frames || frames > maximumFrames) { ++dropped; return; }
        if (planar && (!input->mBuffers[1].mData || input->mBuffers[1].mNumberChannels != 1 ||
            input->mBuffers[1].mDataByteSize != first.mDataByteSize)) return;
        const auto next = written.load(std::memory_order_relaxed);
        if (next - read.load(std::memory_order_acquire) >= slots) { ++dropped; return; }
        auto &packet = packets[next % slots];
        packet.count = frames * 2;
        if (planar) {
            const auto *left = static_cast<const float *>(first.mData);
            const auto *right = static_cast<const float *>(input->mBuffers[1].mData);
            for (size_t frame = 0; frame < frames; ++frame) {
                packet.samples[frame * 2] = left[frame]; packet.samples[frame * 2 + 1] = right[frame];
            }
        } else std::memcpy(packet.samples.data(), first.mData, packet.count * sizeof(float));
        packet.timestamp = time && (time->mFlags & kAudioTimeStampHostTimeValid)
            ? clockOffset + CMTimeConvertScale(CMClockMakeHostTimeFromSystemUnits(time->mHostTime),
                10000000, kCMTimeRoundingMethod_Default).value : 0;
        written.store(next + 1, std::memory_order_release);
        dispatch_semaphore_signal(available);
    }
    void drain() {
        auto next = read.load(std::memory_order_relaxed);
        while (active && next != written.load(std::memory_order_acquire)) {
            const auto &packet = packets[next % slots];
            StreamChunk chunk;
            chunk.sampleRate = sampleRate;
            chunk.captureTime100ns = packet.timestamp;
            chunk.samples.assign(packet.samples.begin(), packet.samples.begin() + packet.count);
            read.store(++next, std::memory_order_release);
            for (float &value : chunk.samples) value = std::isfinite(value) ? std::clamp(value, -1.0f, 1.0f) : 0.0f;
            if (callback) callback(std::move(chunk));
            else {
                std::lock_guard lock(bufferMutex);
                const size_t maximum = sampleRate * 2 * 15;
                if (buffered.size() + chunk.samples.size() > maximum)
                    buffered.erase(buffered.begin(), buffered.begin() + (buffered.size() + chunk.samples.size() - maximum));
                buffered.insert(buffered.end(), chunk.samples.begin(), chunk.samples.end());
            }
        }
    }
};
} // namespace

namespace versus::audio {
struct WindowAudioCaptureCore::MacImpl {
    platform::MacAudioInput input;
    std::shared_ptr<AudioState> state = std::make_shared<AudioState>();
    AudioObjectID tap = kAudioObjectUnknown, device = kAudioObjectUnknown;
    AudioDeviceIOProcID io = nullptr;
    CATapDescription *description = nil;
    std::thread worker;
    pid_t selectedPid = 0;
    proc_bsdinfo selectedIdentity{};

    bool refreshProcesses() {
        // An exited/reused root PID must never select another application.
        if (selectedPid) {
            proc_bsdinfo current{};
            if (!processInfo(selectedPid, current) || current.pbi_start_tvsec != selectedIdentity.pbi_start_tvsec ||
                current.pbi_start_tvusec != selectedIdentity.pbi_start_tvusec) return false;
        }
        AudioStreamBasicDescription format{};
        if (!property(tap, kAudioTapPropertyFormat, format) || format.mSampleRate != std::atomic_load(&state)->sampleRate ||
            format.mChannelsPerFrame != 2 || format.mBitsPerChannel != 32 ||
            !(format.mFormatFlags & kAudioFormatFlagIsFloat)) return false;
        NSArray *processes = audioProcesses(selectedPid ? selectedPid : getpid());
        if (!processes) return false;
        if ([processes isEqualToArray:description.processes]) return true;
        description.processes = processes;
        auto key = address(kAudioTapPropertyDescription);
        CFTypeRef value = (__bridge CFTypeRef)description;
        return AudioObjectSetPropertyData(tap, &key, 0, nullptr, sizeof(value), &value) == noErr;
    }
    CaptureResult start(uint32_t processId, StreamCallback callback) {
        selectedPid = processId;
        if (selectedPid && !processInfo(selectedPid, selectedIdentity))
            return {false, false, 0, 0, "The selected application is no longer available for audio capture"};
        NSArray *processes = audioProcesses(selectedPid ? selectedPid : getpid());
        if (!processes) return {false, false, 0, 0, "Core Audio could not enumerate audio processes"};
        // An empty inclusion list deliberately captures silence until this app
        // creates an audio client. It never broadens into a global mix.
        description = selectedPid ? [[CATapDescription alloc] initStereoMixdownOfProcesses:processes]
                                  : [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:processes];
        description.name = @"Game Capture audio";
        description.privateTap = YES;
        description.muteBehavior = CATapUnmuted;
        auto failure = [](const char *operation, OSStatus code) -> CaptureResult {
            return {false, false, 0, 0, std::string(operation) + " failed (Core Audio " + std::to_string(code) +
                "). Check Screen & System Audio Recording permission for Game Capture."};
        };
        OSStatus status = AudioHardwareCreateProcessTap(description, &tap);
        if (status) return failure("Creating the process tap", status);
        AudioStreamBasicDescription format{};
        if (!property(tap, kAudioTapPropertyFormat, format) || format.mFormatID != kAudioFormatLinearPCM ||
            !(format.mFormatFlags & kAudioFormatFlagIsFloat) || (format.mFormatFlags & kAudioFormatFlagIsBigEndian) ||
            format.mBitsPerChannel != 32 || format.mChannelsPerFrame != 2 ||
            format.mSampleRate < 8000 || format.mSampleRate > 192000)
            return {false, false, 0, 0, "Core Audio returned an unsupported process-tap format"};
        NSDictionary *configuration = @{
            @kAudioAggregateDeviceNameKey: @"Game Capture private audio",
            @kAudioAggregateDeviceUIDKey: NSUUID.UUID.UUIDString,
            @kAudioAggregateDeviceIsPrivateKey: @YES,
            @kAudioAggregateDeviceTapAutoStartKey: @YES,
            @kAudioAggregateDeviceTapListKey: @[@{
                @kAudioSubTapUIDKey: description.UUID.UUIDString,
                @kAudioSubTapDriftCompensationKey: @YES}]
        };
        status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)configuration, &device);
        if (status) return failure("Creating the private audio device", status);
        auto generation = std::make_shared<AudioState>();
        generation->sampleRate = static_cast<uint32_t>(format.mSampleRate);
        generation->callback = std::move(callback);
        std::atomic_store(&state, generation);
        status = AudioDeviceCreateIOProcIDWithBlock(&io, device, nullptr,
            ^(const AudioTimeStamp *, const AudioBufferList *input, const AudioTimeStamp *inputTime,
              AudioBufferList *, const AudioTimeStamp *) { generation->receive(input, inputTime); });
        if (status) return failure("Attaching the audio callback", status);
        generation->active = true;
        worker = std::thread([this, generation] {
            auto refreshed = std::chrono::steady_clock::now();
            try {
                while (generation->active) {
                    dispatch_semaphore_wait(generation->available, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC));
                    generation->drain();
                    const auto now = std::chrono::steady_clock::now();
                    if (now - refreshed > std::chrono::milliseconds(500)) {
                        @autoreleasepool {
                            if (!refreshProcesses()) {
                                generation->active = false;
                                spdlog::warn("[MacAudio] Selected audio process disappeared or its tap could not be updated; audio stopped");
                            }
                        }
                        refreshed = now;
                    }
                }
            } catch (const std::exception &error) {
                generation->active = false;
                spdlog::error("[MacAudio] Delivery failed: {}", error.what());
            }
        });
        status = AudioDeviceStart(device, io);
        if (status) return failure("Starting the audio device", status);
        spdlog::info("[MacAudio] Started {} process tap (pid={}, audioClients={}, {} Hz stereo)",
            selectedPid ? "application" : "system", selectedPid, processes.count, generation->sampleRate);
        return {true, selectedPid != 0, generation->sampleRate, 2, ""};
    }
    void stop() {
        input.stop();
        const auto generation = std::atomic_load(&state);
        generation->active = false;
        dispatch_semaphore_signal(generation->available);
        if (worker.joinable()) worker.join();
        // Joining delivery is the callback barrier. Core Audio's copied block
        // independently retains its inactive generation until IO destruction.
        if (device && io) {
            AudioDeviceStop(device, io);
            AudioDeviceDestroyIOProcID(device, io);
        }
        io = nullptr;
        if (device) AudioHardwareDestroyAggregateDevice(device);
        device = kAudioObjectUnknown;
        if (tap) AudioHardwareDestroyProcessTap(tap);
        tap = kAudioObjectUnknown;
        description = nil;
        generation->callback = {};
        std::lock_guard lock(generation->bufferMutex);
        generation->buffered.clear();
        if (const auto dropped = generation->dropped.exchange(0))
            spdlog::warn("[MacAudio] Dropped {} packets at the bounded capture queue", dropped);
    }
};
WindowAudioCaptureCore::WindowAudioCaptureCore() : mac_(std::make_unique<MacImpl>()) {}
WindowAudioCaptureCore::~WindowAudioCaptureCore() { StopCapture(); }
std::vector<WindowInfo> WindowAudioCaptureCore::GetWindowList() {
    std::vector<WindowInfo> result;
    for (SCWindow *window in content().windows) {
        if (!window.owningApplication) continue;
        result.push_back({window.windowID, static_cast<uint32_t>(window.owningApplication.processID),
            window.title.UTF8String ?: "", window.owningApplication.applicationName.UTF8String ?: ""});
    }
    return result;
}
std::vector<AudioSessionInfo> WindowAudioCaptureCore::GetAudioSessions() { return {}; }
std::vector<AudioDeviceInfo> WindowAudioCaptureCore::GetInputDevices() { return platform::macAudioInputDevices(); }
CaptureResult WindowAudioCaptureCore::StartCapture(uint32_t pid) { return StartStreamCapture(pid, {}); }
CaptureResult WindowAudioCaptureCore::StartStreamCapture(uint32_t pid, StreamCallback callback) {
    StopCapture();
    if (!pid) return {false, false, 0, 0, "Application audio requires a nonzero process ID"};
    auto result = mac_->start(pid, std::move(callback));
    if (!result.success) mac_->stop();
    return result;
}
CaptureResult WindowAudioCaptureCore::StartDefaultEndpointCapture(DefaultAudioEndpoint endpoint) {
    return StartDefaultEndpointStreamCapture(endpoint, {});
}
CaptureResult WindowAudioCaptureCore::StartDefaultEndpointStreamCapture(DefaultAudioEndpoint endpoint, StreamCallback callback) {
    StopCapture();
    if (endpoint == DefaultAudioEndpoint::MultimediaInput) return mac_->input.start({}, std::move(callback));
    if (endpoint != DefaultAudioEndpoint::MultimediaOutput)
        return {false, false, 0, 0, "This Mac backend currently supports application and system audio only"};
    auto result = mac_->start(0, std::move(callback));
    if (!result.success) mac_->stop();
    return result;
}
CaptureResult WindowAudioCaptureCore::StartInputDeviceStreamCapture(const std::string &id, StreamCallback callback) {
    StopCapture();
    return mac_->input.start(id, std::move(callback));
}
void WindowAudioCaptureCore::StopCapture() { mac_->stop(); }
std::vector<float> WindowAudioCaptureCore::DrainAudioBuffer() {
    if (mac_->input.active()) return mac_->input.drain();
    const auto state = std::atomic_load(&mac_->state);
    std::lock_guard lock(state->bufferMutex);
    return std::exchange(state->buffered, {});
}
bool WindowAudioCaptureCore::IsCapturing() const { return mac_->input.active() || std::atomic_load(&mac_->state)->active; }
} // namespace versus::audio
