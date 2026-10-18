#include "versus/audio/window_audio_capture_core.h"
#include "versus/audio/sample_clock.h"
#include "versus/video/window_capture.h"
#include "versus/webrtc/media_clock.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <utility>
#include <pulse/pulseaudio.h>
#include <spdlog/spdlog.h>

namespace versus::audio {
namespace {
using Clock = std::chrono::steady_clock;
constexpr pa_sample_spec sampleSpec{PA_SAMPLE_FLOAT32NE, 48000, 2};
constexpr size_t maximumChunkBytes = 48000 * 2 * sizeof(float) / 4;
struct Server {
    pa_mainloop *loop = pa_mainloop_new();
    pa_context *context = nullptr;
    pa_stream *stream = nullptr;
    std::string error;
    Server() {
        if (loop) context = pa_context_new(pa_mainloop_get_api(loop), "Game Capture");
    }
    ~Server() {
        if (stream) { pa_stream_disconnect(stream); pa_stream_unref(stream); }
        if (context) { pa_context_disconnect(context); pa_context_unref(context); }
        if (loop) pa_mainloop_free(loop);
    }
    bool pump() {
        return pa_mainloop_prepare(loop, 20000) >= 0 && pa_mainloop_poll(loop) >= 0 && pa_mainloop_dispatch(loop) >= 0;
    }
    bool connected() const { return context && pa_context_get_state(context) == PA_CONTEXT_READY; }
    std::string failure(const char *operation) const {
        return std::string(operation) + ": " + (context ? pa_strerror(pa_context_errno(context)) : "allocation failed");
    }
    bool connect(const std::atomic<bool> &running) {
        if (!context || pa_context_connect(context, nullptr, PA_CONTEXT_NOAUTOSPAWN, nullptr) < 0) {
            error = failure("Could not connect to the desktop audio service"); return false;
        }
        const auto deadline = Clock::now() + std::chrono::seconds(3);
        while (running && Clock::now() < deadline) {
            const auto state = pa_context_get_state(context);
            if (state == PA_CONTEXT_READY) return true;
            if (!PA_CONTEXT_IS_GOOD(state) || !pump()) break;
        }
        error = "Desktop audio service is unavailable or connection timed out. Check PipeWire/PulseAudio in this user session.";
        return false;
    }
    bool finish(pa_operation *operation, const std::atomic<bool> &running) {
        if (!operation) return false;
        const auto deadline = Clock::now() + std::chrono::seconds(2);
        while (running && connected() && pa_operation_get_state(operation) == PA_OPERATION_RUNNING && Clock::now() < deadline)
            if (!pump()) break;
        const bool done = pa_operation_get_state(operation) == PA_OPERATION_DONE;
        if (!done) pa_operation_cancel(operation);
        pa_operation_unref(operation);
        return done;
    }
};
struct Source {
    std::string name, description;
    pa_sample_spec spec{};
    bool monitor = false;
};
struct Catalog {
    std::string defaultInput, defaultOutput;
    std::vector<Source> sources;
    bool serverKnown = false, sourcesKnown = false;
};
Catalog catalog(Server &server, const std::atomic<bool> &running) {
    Catalog result;
    server.finish(pa_context_get_server_info(server.context, [](pa_context *, const pa_server_info *info, void *data) {
        auto &out = *static_cast<Catalog *>(data);
        if (!info) return;
        out.defaultInput = info->default_source_name ? info->default_source_name : "";
        out.defaultOutput = info->default_sink_name ? info->default_sink_name : "";
        out.serverKnown = true;
    }, &result), running);
    server.finish(pa_context_get_source_info_list(server.context, [](pa_context *, const pa_source_info *info, int end, void *data) {
        auto &out = *static_cast<Catalog *>(data);
        if (end) { out.sourcesKnown = end > 0; return; }
        if (!info || !info->name || out.sources.size() >= 1024) return;
        out.sources.push_back({info->name, info->description ? info->description : info->name, info->sample_spec, info->monitor_of_sink != PA_INVALID_INDEX});
    }, &result), running);
    return result;
}
}

struct WindowAudioCaptureCore::LinuxImpl {
    std::atomic<bool> running{false};
    std::thread worker;
    mutable std::mutex mutex;
    std::condition_variable ready;
    bool initialized = false;
    std::string error;
    std::vector<float> buffered;
    enum class Kind { Output, Input };
    ~LinuxImpl() { stop(); }
    void fail(std::string message) {
        { std::lock_guard lock(mutex); error = std::move(message); spdlog::warn("[LinuxAudio] {}", error); }
        running = false; ready.notify_all();
    }
    void stop() {
        running = false; ready.notify_all();
        if (worker.joinable()) worker.join();
        std::lock_guard lock(mutex); buffered.clear();
    }
    void capture(Kind kind, const std::string &id, const StreamCallback &callback) {
        Server server;
        if (!server.connect(running)) { fail(server.error); return; }
        const auto devices = catalog(server, running);
        if (!devices.serverKnown || !devices.sourcesKnown) { fail("Could not enumerate desktop audio devices."); return; }
        std::string selected;
        if (kind == Kind::Output) {
            struct Monitor { std::string name; } monitor;
            if (devices.defaultOutput.empty() || !server.finish(pa_context_get_sink_info_by_name(server.context, devices.defaultOutput.c_str(),
                    [](pa_context *, const pa_sink_info *info, int end, void *data) {
                        if (!end && info && info->monitor_source_name) static_cast<Monitor *>(data)->name = info->monitor_source_name;
                    }, &monitor), running) || monitor.name.empty()) {
                fail("The default output has no available monitor source."); return;
            }
            selected = monitor.name;
        } else {
            if (!id.empty() && !id.starts_with("pulse:")) { fail("Invalid Linux microphone/input ID. Select an available input."); return; }
            selected = id.empty() ? devices.defaultInput : id.substr(6);
            const auto device = std::find_if(devices.sources.begin(), devices.sources.end(), [&](const auto &source) { return source.name == selected; });
            if (device == devices.sources.end() || device->monitor) {
                fail("Selected microphone/input is unavailable. No replacement input was opened."); return;
            }
        }
        pa_channel_map channels; pa_channel_map_init_stereo(&channels);
        server.stream = pa_stream_new(server.context, kind == Kind::Output ? "Game Capture system audio" : "Game Capture microphone", &sampleSpec, &channels);
        if (!server.stream) { fail(server.failure("Could not create the audio stream")); return; }
        pa_buffer_attr buffer{uint32_t(maximumChunkBytes), uint32_t(-1), uint32_t(-1), uint32_t(-1), 480 * 2 * sizeof(float)};
        // DONT_MOVE prevents automatic rescue to another physical microphone.
        // Resolve even defaults to exact names, then pin this capture generation.
        const auto flags = pa_stream_flags_t(PA_STREAM_ADJUST_LATENCY | PA_STREAM_AUTO_TIMING_UPDATE |
            PA_STREAM_INTERPOLATE_TIMING | PA_STREAM_DONT_MOVE);
        if (pa_stream_connect_record(server.stream, selected.c_str(), &buffer, flags) < 0) {
            fail(server.failure("Could not open the selected audio device")); return;
        }
        const auto deadline = Clock::now() + std::chrono::seconds(3);
        while (running && Clock::now() < deadline && server.connected() && pa_stream_get_state(server.stream) != PA_STREAM_READY) {
            if (!PA_STREAM_IS_GOOD(pa_stream_get_state(server.stream)) || !server.pump()) break;
        }
        if (!running || !server.connected() || pa_stream_get_state(server.stream) != PA_STREAM_READY) {
            fail(server.failure("Selected audio device did not become ready")); return;
        }
        const auto *actual = pa_stream_get_sample_spec(server.stream);
        const auto *mapping = pa_stream_get_channel_map(server.stream);
        if (!actual || actual->format != sampleSpec.format || actual->rate != 48000 || actual->channels != 2 ||
            !mapping || !pa_channel_map_equal(mapping, &channels)) {
            fail("Audio service did not provide the requested stereo float format."); return;
        }
        spdlog::info("[LinuxAudio] Capturing '{}' as 48000 Hz stereo float", selected);
        auto lastData = Clock::now();
        int64_t nextTimestamp = 0;
        SampleClockFraction clock;
        while (running && server.connected() && pa_stream_get_state(server.stream) == PA_STREAM_READY) {
            if (!server.pump()) break;
            if (!running) break;
            const size_t available = pa_stream_readable_size(server.stream);
            if (available == size_t(-1)) break;
            if (!available) {
                if (Clock::now() - lastData > std::chrono::seconds(3)) { fail("Selected audio device stopped supplying samples. Audio from this device is off."); return; }
                continue;
            }
            const void *data = nullptr; size_t bytes = 0;
            if (pa_stream_peek(server.stream, &data, &bytes) < 0) break;
            if (!bytes) continue;
            if (bytes > maximumChunkBytes || bytes % (2 * sizeof(float))) {
                pa_stream_drop(server.stream); fail("Audio service returned an invalid or excessive sample block."); return;
            }
            StreamChunk chunk; chunk.samples.resize(bytes / sizeof(float), 0.0f);
            if (data) std::memcpy(chunk.samples.data(), data, bytes); // A hole is silence.
            for (auto &sample : chunk.samples) if (!std::isfinite(sample)) sample = 0.0f;
            const auto now = webrtc::mediaTime100ns();
            pa_usec_t latency = 0; int negative = 0;
            const bool haveLatency = pa_stream_get_latency(server.stream, &latency, &negative) == 0 && latency < 2000000;
            const auto frames = chunk.samples.size() / 2;
            const auto estimated = haveLatency ? now + (negative ? 1 : -1) * int64_t(latency) * 10 :
                now - int64_t(frames) * 10000000 / 48000;
            // Keep exact sample cadence across variable blocks. Re-anchor only
            // for a real discontinuity; device-clock drift needs E2E evidence.
            if (!nextTimestamp || std::abs(estimated - nextTimestamp) > 1000000) {
                nextTimestamp = estimated; clock.reset();
            }
            chunk.captureTime100ns = nextTimestamp;
            nextTimestamp += clock.duration100ns(frames);
            if (pa_stream_drop(server.stream) < 0) break;
            lastData = Clock::now();
            if (running && callback) callback(std::move(chunk));
            else if (running) {
                std::lock_guard lock(mutex);
                constexpr size_t limit = 48000 * 2 / 2;
                if (buffered.size() + chunk.samples.size() > limit) buffered.clear();
                buffered.insert(buffered.end(), chunk.samples.begin(), chunk.samples.end());
            }
            { std::lock_guard lock(mutex); initialized = true; }
            ready.notify_all();
        }
        if (running) fail("Selected audio device or desktop audio service disconnected. No replacement device was opened.");
    }
    CaptureResult start(Kind kind, std::string id, StreamCallback callback) {
        stop();
        { std::lock_guard lock(mutex); error.clear(); initialized = false; }
        running = true;
        worker = std::thread([this, kind, id = std::move(id), callback = std::move(callback)] {
            try { capture(kind, id, callback); }
            catch (const std::exception &e) { fail(std::string("Audio capture failed: ") + e.what()); }
            catch (...) { fail("Audio capture failed unexpectedly."); }
            running = false; ready.notify_all();
        });
        std::unique_lock lock(mutex);
        const bool ok = ready.wait_for(lock, std::chrono::seconds(12), [&] { return initialized || !running; }) && initialized && running;
        const auto message = error.empty() ? "Audio startup cancelled or timed out." : error;
        lock.unlock();
        if (!ok) { stop(); return {false, false, 0, 0, message}; }
        return {true, false, 48000, 2, ""};
    }
};

WindowAudioCaptureCore::WindowAudioCaptureCore() : linux_(std::make_unique<LinuxImpl>()) {}
WindowAudioCaptureCore::~WindowAudioCaptureCore() = default;
std::vector<WindowInfo> WindowAudioCaptureCore::GetWindowList() {
    std::vector<WindowInfo> result;
    for (const auto &window : video::WindowCapture().getWindows())
        if (window.processId) result.push_back({0, window.processId, window.name, window.executableName});
    return result;
}
std::vector<AudioSessionInfo> WindowAudioCaptureCore::GetAudioSessions() { return {}; }
std::vector<AudioDeviceInfo> WindowAudioCaptureCore::GetInputDevices() {
    std::atomic<bool> active{true}; Server server;
    if (!server.connect(active)) return {};
    const auto devices = catalog(server, active);
    std::vector<AudioDeviceInfo> result;
    if (!devices.sourcesKnown) return result;
    for (const auto &source : devices.sources) {
        if (source.monitor) continue;
        AudioDeviceInfo device;
        device.id = "pulse:" + source.name; device.name = source.description;
        device.sampleRate = source.spec.rate; device.channels = source.spec.channels;
        device.bitsPerSample = pa_sample_size_of_format(source.spec.format) * 8;
        device.validBitsPerSample = source.spec.format == PA_SAMPLE_S24_32LE || source.spec.format == PA_SAMPLE_S24_32BE ? 24 : device.bitsPerSample;
        device.floatingPoint = source.spec.format == PA_SAMPLE_FLOAT32LE || source.spec.format == PA_SAMPLE_FLOAT32BE;
        device.isDefault = source.name == devices.defaultInput;
        result.push_back(std::move(device));
    }
    return result;
}
CaptureResult WindowAudioCaptureCore::StartCapture(uint32_t pid) { return StartStreamCapture(pid, {}); }
CaptureResult WindowAudioCaptureCore::StartStreamCapture(uint32_t, StreamCallback) {
    StopCapture();
    return {false, false, 0, 0, "Linux application-only audio routing is not implemented yet. Explicitly select system audio, a microphone/input, or no audio."};
}
CaptureResult WindowAudioCaptureCore::StartDefaultEndpointCapture(DefaultAudioEndpoint endpoint) {
    return StartDefaultEndpointStreamCapture(endpoint, {});
}
CaptureResult WindowAudioCaptureCore::StartDefaultEndpointStreamCapture(DefaultAudioEndpoint endpoint, StreamCallback callback) {
    if (endpoint == DefaultAudioEndpoint::MultimediaOutput) return linux_->start(LinuxImpl::Kind::Output, {}, std::move(callback));
    if (endpoint == DefaultAudioEndpoint::MultimediaInput) return linux_->start(LinuxImpl::Kind::Input, {}, std::move(callback));
    StopCapture(); return {false, false, 0, 0, "Linux has no separate communications endpoint. Choose system audio or an explicit input."};
}
CaptureResult WindowAudioCaptureCore::StartInputDeviceStreamCapture(const std::string &id, StreamCallback callback) {
    return linux_->start(LinuxImpl::Kind::Input, id, std::move(callback));
}
void WindowAudioCaptureCore::StopCapture() { linux_->stop(); }
std::vector<float> WindowAudioCaptureCore::DrainAudioBuffer() { std::lock_guard lock(linux_->mutex); return std::exchange(linux_->buffered, {}); }
bool WindowAudioCaptureCore::IsCapturing() const { return linux_->running; }
} // namespace versus::audio
