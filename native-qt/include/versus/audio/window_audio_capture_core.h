#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace versus::audio {

struct AudioSessionInfo {
    uint32_t sessionId = 0;
    uint32_t processId = 0;
    std::string executableName;
    std::string displayName;
    bool active = false;
    bool isSystemSounds = false;
};

struct WindowInfo {
    uint64_t id = 0;
    uint32_t processId = 0;
    std::string title;
    std::string executableName;
};

struct CaptureResult {
    bool success = false;
    bool usingProcessLoopback = false;
    uint32_t sampleRate = 48000;
    uint32_t channels = 2;
    std::string error;
};

struct StreamChunk {
    std::vector<float> samples;
    uint32_t sampleRate = 48000;
    uint32_t channels = 2;
};

class WindowAudioCaptureCore {
  public:
    using StreamCallback = std::function<void(StreamChunk &&)>;

    WindowAudioCaptureCore();
    ~WindowAudioCaptureCore();

    std::vector<WindowInfo> GetWindowList();
    std::vector<AudioSessionInfo> GetAudioSessions();

    CaptureResult StartCapture(uint32_t processId);
    CaptureResult StartStreamCapture(uint32_t processId, StreamCallback callback);
    void StopCapture();

    std::vector<float> DrainAudioBuffer();
    bool IsCapturing() const;

  private:
    CaptureResult StartProcessLoopback(uint32_t processId);
    void CaptureLoop();
    void AppendSamples(const float *samples, size_t count);

    std::mutex mutex_;
    std::vector<float> audioBuffer_;
    std::thread captureThread_;
    std::atomic<bool> capturing_{false};
    std::atomic<bool> usingProcessLoopback_{false};
    uint32_t sampleRate_ = 48000;
    uint32_t channels_ = 2;
    uint32_t bitsPerSample_ = 32;
    bool isFloatFormat_ = true;
    size_t maxBufferSamples_ = 48000 * 2 * 15;
    std::mutex callbackMutex_;
    StreamCallback streamCallback_;
    std::atomic<bool> streaming_{false};
    bool coInitialized_ = false;
    bool roInitialized_ = false;

#ifdef _WIN32
    void *audioClient_ = nullptr;
    void *captureClient_ = nullptr;
    void *sampleReadyEvent_ = nullptr;
    void *stopEvent_ = nullptr;
#endif
};

}  // namespace versus::audio
