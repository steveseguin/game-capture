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
#include <charconv>
#include <deque>
#include <fstream>
#include <map>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>
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
// Process identity includes the kernel start tick, preventing a reused PID from
// becoming part of an existing capture generation. /proc is local-user only.
struct ProcessIdentity {
    uint32_t pid = 0, parent = 0;
    uint64_t birth = 0;
    explicit operator bool() const { return pid && birth; }
};
ProcessIdentity processIdentity(uint32_t pid) {
    const std::string path = "/proc/" + std::to_string(pid);
    struct stat attributes{};
    if (!pid || stat(path.c_str(), &attributes) || attributes.st_uid != geteuid()) return {};
    std::ifstream input(path + "/stat"); std::string line;
    if (!std::getline(input, line)) return {};
    const auto end = line.rfind(')');
    if (end == std::string::npos) return {};
    std::istringstream fields(line.substr(end + 2));
    std::string field; ProcessIdentity identity{pid};
    for (int number = 3; number <= 22; ++number) {
        if (!(fields >> field)) return {};
        if (number == 3 && (field == "Z" || field == "X")) return {};
        if (number == 4 || number == 22) {
            uint64_t value = 0;
            const auto parsed = std::from_chars(field.data(), field.data() + field.size(), value);
            if (parsed.ec != std::errc{} || parsed.ptr != field.data() + field.size()) return {};
            if (number == 4) identity.parent = uint32_t(value); else identity.birth = value;
        }
    }
    return identity;
}
bool belongsTo(ProcessIdentity candidate, const ProcessIdentity &root) {
    for (int depth = 0; candidate && depth < 128; ++depth) {
        if (candidate.pid == root.pid) return candidate.birth == root.birth;
        if (candidate.parent == candidate.pid) break;
        candidate = processIdentity(candidate.parent);
    }
    return false;
}
struct Playback {
    uint32_t index = PA_INVALID_INDEX, sink = PA_INVALID_INDEX, pid = 0;
    std::string name, executable;
    bool active = false;
};
// Asynchronous catalog refresh keeps audio draining while the server replies.
struct PlaybackQuery {
    std::vector<Playback> streams;
    std::map<uint32_t, std::string> monitors;
    pa_operation *inputs = nullptr, *sinks = nullptr;
    bool inputsDone = false, sinksDone = false, failed = false;
    Clock::time_point deadline = Clock::now() + std::chrono::seconds(2);
    explicit PlaybackQuery(Server &server) {
        inputs = pa_context_get_sink_input_info_list(server.context, [](pa_context *, const pa_sink_input_info *info, int end, void *data) {
            auto &out = *static_cast<PlaybackQuery *>(data);
            if (end) { out.inputsDone = true; out.failed |= end < 0; return; }
            if (!info || out.streams.size() >= 1024) { out.failed = true; return; }
            Playback stream; stream.index = info->index; stream.sink = info->sink; stream.active = !info->corked;
            if (const auto *pid = pa_proplist_gets(info->proplist, PA_PROP_APPLICATION_PROCESS_ID)) {
                const auto parsed = std::from_chars(pid, pid + std::strlen(pid), stream.pid);
                if (parsed.ec != std::errc{} || *parsed.ptr) stream.pid = 0;
            }
            if (const auto *name = pa_proplist_gets(info->proplist, PA_PROP_APPLICATION_NAME)) stream.name = name;
            if (const auto *binary = pa_proplist_gets(info->proplist, PA_PROP_APPLICATION_PROCESS_BINARY)) stream.executable = binary;
            out.streams.push_back(std::move(stream));
        }, this);
        sinks = pa_context_get_sink_info_list(server.context, [](pa_context *, const pa_sink_info *info, int end, void *data) {
            auto &out = *static_cast<PlaybackQuery *>(data);
            if (end) { out.sinksDone = true; out.failed |= end < 0; return; }
            if (!info || out.monitors.size() >= 1024) { out.failed = true; return; }
            if (info->monitor_source_name) out.monitors[info->index] = info->monitor_source_name;
        }, this);
        failed = !inputs || !sinks;
    }
    ~PlaybackQuery() {
        for (auto *operation : {inputs, sinks}) if (operation) {
            if (pa_operation_get_state(operation) == PA_OPERATION_RUNNING) pa_operation_cancel(operation);
            pa_operation_unref(operation);
        }
    }
    bool done() const { return inputsDone && sinksDone; }
};
struct AudioBlock { int64_t first = 0; std::vector<float> samples; };
struct MonitorTap {
    pa_stream *stream = nullptr;
    uint32_t sink = 0, pid = 0;
    uint64_t birth = 0;
    int64_t next = -1;
    std::deque<AudioBlock> blocks;
    Clock::time_point deadline = Clock::now() + std::chrono::seconds(3);
    ~MonitorTap() { if (stream) { pa_stream_disconnect(stream); pa_stream_unref(stream); } }
};

}

struct WindowAudioCaptureCore::LinuxImpl {
    std::atomic<bool> running{false};
    std::thread worker;
    mutable std::mutex mutex;
    std::condition_variable ready;
    bool initialized = false;
    std::string error;
    std::vector<float> buffered;
    enum class Kind { Output, Input, Process };
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
    void deliver(StreamChunk chunk, const StreamCallback &callback) {
        if (!running) return;
        if (callback) callback(std::move(chunk));
        else {
            std::lock_guard lock(mutex);
            if (buffered.size() + chunk.samples.size() > 48000) buffered.clear();
            buffered.insert(buffered.end(), chunk.samples.begin(), chunk.samples.end());
        }
    }
    void captureProcess(uint32_t pid, uint64_t expectedBirth, const StreamCallback &callback) {
        const auto root = processIdentity(pid);
        if (!root || (expectedBirth && root.birth != expectedBirth) || pid == uint32_t(getpid())) {
            fail("Selected audio app is unavailable or has restarted. Select the app again; no replacement audio was opened."); return;
        }
        Server server;
        if (!server.connect(running)) { fail(server.error); return; }
        if (pa_context_is_local(server.context) != 1) {
            fail("Application audio requires the local desktop audio service; remote process IDs cannot identify local apps."); return;
        }
        std::map<uint32_t, std::unique_ptr<MonitorTap>> taps;
        std::unique_ptr<PlaybackQuery> query;
        auto refresh = Clock::now();
        const int64_t epoch = webrtc::mediaTime100ns();
        int64_t outputFrame = 0;
        constexpr int64_t delay100ns = 1200000; // Allow independent monitors to arrive before mixing.
        spdlog::info("[LinuxAudio] Capturing app PID {} generation {} and its children", root.pid, root.birth);
        while (running && server.connected()) {
            if (!query && Clock::now() >= refresh) {
                const auto current = processIdentity(root.pid);
                if (!current || current.birth != root.birth) { fail("Selected audio app closed. Audio from this app is off; select an app and restart streaming."); return; }
                query = std::make_unique<PlaybackQuery>(server);
            }
            if (!server.pump()) break;
            if (query && (query->failed || Clock::now() >= query->deadline)) {
                fail("Could not refresh application audio streams. Application audio is off."); return;
            }
            if (query && query->done()) {
                std::map<uint32_t, std::pair<Playback, ProcessIdentity>> wanted;
                for (const auto &stream : query->streams) {
                    const auto identity = processIdentity(stream.pid);
                    // Corking pauses the playback clock. Recreate its monitor
                    // on resume so Pulse's interpolator cannot carry stale
                    // latency through the pause and discard fresh samples.
                    if (stream.active && belongsTo(identity, root)) wanted.emplace(stream.index, std::make_pair(stream, identity));
                }
                if (wanted.size() > 64) { fail("Selected app has too many playback streams (limit 64)."); return; }
                for (auto it = taps.begin(); it != taps.end();) {
                    const auto match = wanted.find(it->first);
                    if (match == wanted.end() || match->second.first.sink != it->second->sink ||
                        match->second.second.pid != it->second->pid || match->second.second.birth != it->second->birth)
                        it = taps.erase(it);
                    else ++it;
                }
                for (const auto &[index, entry] : wanted) {
                    if (taps.contains(index)) continue;
                    const auto monitor = query->monitors.find(entry.first.sink);
                    if (monitor == query->monitors.end()) continue; // Removed output; next catalog reconciles it.
                    auto tap = std::make_unique<MonitorTap>();
                    tap->sink = entry.first.sink; tap->pid = entry.second.pid; tap->birth = entry.second.birth;
                    pa_channel_map channels; pa_channel_map_init_stereo(&channels);
                    tap->stream = pa_stream_new(server.context, "Game Capture selected app", &sampleSpec, &channels);
                    pa_buffer_attr buffer{uint32_t(maximumChunkBytes), uint32_t(-1), uint32_t(-1), uint32_t(-1), 480 * 2 * sizeof(float)};
                    // Monitor exactly this playback stream; never open an unfiltered system monitor.
                    if (!tap->stream || pa_stream_set_monitor_stream(tap->stream, index) < 0 ||
                        pa_stream_connect_record(tap->stream, monitor->second.c_str(), &buffer,
                            pa_stream_flags_t(PA_STREAM_ADJUST_LATENCY | PA_STREAM_AUTO_TIMING_UPDATE |
                                PA_STREAM_INTERPOLATE_TIMING | PA_STREAM_DONT_MOVE)) < 0) {
                        fail(server.failure("Could not monitor the selected app stream")); return;
                    }
                    spdlog::info("[LinuxAudio] Monitoring app playback {} PID {} on output {}", index, tap->pid, tap->sink);
                    taps.emplace(index, std::move(tap));
                }
                query.reset(); refresh = Clock::now() + std::chrono::milliseconds(250);
                { std::lock_guard lock(mutex); initialized = true; } ready.notify_all();
            }
            for (auto &[index, owned] : taps) {
                auto &tap = *owned;
                const auto state = pa_stream_get_state(tap.stream);
                if (state != PA_STREAM_READY) {
                    // A disappearing playback stream terminates its monitor. Keep
                    // emitting silence until the catalog removes it or a new stream appears.
                    tap.blocks.clear(); tap.next = -1;
                    if (PA_STREAM_IS_GOOD(state) && Clock::now() < tap.deadline) continue;
                    if (Clock::now() >= tap.deadline) {
                        fail("An application audio monitor could not start or recover. Stop and start streaming again."); return;
                    }
                    refresh = Clock::now(); continue;
                }
                tap.deadline = Clock::now() + std::chrono::seconds(3);
                for (int count = 0; count < 64; ++count) {
                    const size_t available = pa_stream_readable_size(tap.stream);
                    if (available == size_t(-1)) { fail(server.failure("Could not read app audio")); return; }
                    if (!available) break;
                    const void *data = nullptr; size_t bytes = 0;
                    if (pa_stream_peek(tap.stream, &data, &bytes) < 0) { fail(server.failure("Could not read app samples")); return; }
                    if (!bytes) break;
                    if (bytes > maximumChunkBytes || bytes % (2 * sizeof(float))) {
                        fail("Application audio service returned an invalid sample block."); return;
                    }
                    AudioBlock block; block.samples.resize(bytes / sizeof(float), 0.0f);
                    if (data) std::memcpy(block.samples.data(), data, bytes);
                    for (auto &sample : block.samples) if (!std::isfinite(sample)) sample = 0.0f;
                    const auto frames = int64_t(block.samples.size() / 2);
                    pa_usec_t latency = 0; int negative = 0;
                    const auto now = webrtc::mediaTime100ns();
                    const bool timed = pa_stream_get_latency(tap.stream, &latency, &negative) == 0 && latency < 2000000;
                    const int64_t estimatedTime = timed ? now + (negative ? 1 : -1) * int64_t(latency) * 10 : now - frames * 10000000 / 48000;
                    const int64_t estimatedFrame = (estimatedTime - epoch) * 48000 / 10000000;
                    if (tap.next >= 0 && std::abs(estimatedFrame - tap.next) > 2400)
                        spdlog::debug("[LinuxAudio] App playback {} clock discontinuity: deltaFrames={} latencyUs={} negative={} outputOffset={} blockFrames={}",
                            index, estimatedFrame - tap.next, latency, negative, estimatedFrame - outputFrame, frames);
                    if (tap.next < 0 || std::abs(estimatedFrame - tap.next) > 2400) {
                        tap.blocks.clear(); // Never mix overlapping generations after a clock discontinuity.
                        tap.next = estimatedFrame;
                    }
                    block.first = tap.next; tap.next += frames;
                    if (pa_stream_drop(tap.stream) < 0) { fail(server.failure("Could not release app samples")); return; }
                    if (block.first + frames > outputFrame && block.first < outputFrame + 48000) {
                        if (tap.blocks.size() >= 128) { fail("Application audio backlog exceeded its bound."); return; }
                        tap.blocks.push_back(std::move(block));
                    }
                }
            }
            const auto dueFrame = (webrtc::mediaTime100ns() - epoch - delay100ns) * 48000 / 10000000;
            if (dueFrame - outputFrame > 12000) { fail("Application audio could not keep up with the capture clock."); return; }
            while (running && outputFrame + 480 <= dueFrame) {
                StreamChunk chunk; chunk.samples.resize(960, 0.0f);
                chunk.captureTime100ns = epoch + outputFrame * 10000000 / 48000;
                for (auto &[index, tap] : taps) {
                    for (const auto &block : tap->blocks) {
                        const auto first = std::max(outputFrame, block.first);
                        const auto end = std::min(outputFrame + 480, block.first + int64_t(block.samples.size() / 2));
                        for (int64_t frame = first; frame < end; ++frame)
                            for (int channel = 0; channel < 2; ++channel)
                                chunk.samples[(frame - outputFrame) * 2 + channel] += block.samples[(frame - block.first) * 2 + channel];
                    }
                    while (!tap->blocks.empty() && tap->blocks.front().first + int64_t(tap->blocks.front().samples.size() / 2) <= outputFrame + 480)
                        tap->blocks.pop_front();
                }
                deliver(std::move(chunk), callback); outputFrame += 480;
            }
        }
        if (running) fail("Desktop audio service disconnected. Selected-app audio is off.");
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
    CaptureResult start(Kind kind, std::string id, StreamCallback callback, uint32_t pid = 0, uint64_t birth = 0) {
        stop();
        { std::lock_guard lock(mutex); error.clear(); initialized = false; }
        running = true;
        worker = std::thread([this, kind, pid, birth, id = std::move(id), callback = std::move(callback)] {
            try {
                if (kind == Kind::Process) captureProcess(pid, birth, callback);
                else capture(kind, id, callback);
            }
            catch (const std::exception &e) { fail(std::string("Audio capture failed: ") + e.what()); }
            catch (...) { fail("Audio capture failed unexpectedly."); }
            running = false; ready.notify_all();
        });
        std::unique_lock lock(mutex);
        const bool ok = ready.wait_for(lock, std::chrono::seconds(12), [&] { return initialized || !running; }) && initialized && running;
        const auto message = error.empty() ? "Audio startup cancelled or timed out." : error;
        lock.unlock();
        if (!ok) { stop(); return {false, false, 0, 0, message}; }
        return {true, kind == Kind::Process, 48000, 2, ""};
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
std::vector<AudioSessionInfo> WindowAudioCaptureCore::GetAudioSessions() {
    std::atomic<bool> active{true}; Server server;
    if (!server.connect(active)) return {};
    PlaybackQuery query(server);
    while (!query.done() && !query.failed && Clock::now() < query.deadline && server.connected())
        if (!server.pump()) break;
    if (!query.done() || query.failed) return {};
    std::map<uint32_t, AudioSessionInfo> sessions;
    for (const auto &stream : query.streams) {
        const auto identity = processIdentity(stream.pid);
        if (!identity || stream.pid == uint32_t(getpid())) continue;
        auto &session = sessions[stream.pid];
        session.sessionId = stream.index; session.processId = stream.pid;
        session.executableName = stream.executable; session.displayName = stream.name;
        session.active |= stream.active; session.processStartTime = identity.birth;
    }
    std::vector<AudioSessionInfo> result;
    for (auto &[pid, session] : sessions) result.push_back(std::move(session));
    return result;
}
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
CaptureResult WindowAudioCaptureCore::StartStreamCapture(uint32_t pid, StreamCallback callback) {
    return StartProcessStreamCapture(pid, 0, std::move(callback));
}
CaptureResult WindowAudioCaptureCore::StartProcessStreamCapture(uint32_t pid, uint64_t birth, StreamCallback callback) {
    return linux_->start(LinuxImpl::Kind::Process, {}, std::move(callback), pid, birth);
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
