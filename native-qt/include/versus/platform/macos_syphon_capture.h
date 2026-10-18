#pragma once
#include "versus/video/window_capture.h"
#include <memory>
#include <cstdint>

namespace versus::platform {

// Syphon UUIDs identify server generations. A restarted or same-named server
// requires a new explicit selection; capture never follows a name implicitly.
class MacSyphonCapture {
public:
    enum class Alpha { Straight, Premultiplied };
    struct ReadbackStats {
        uint64_t gpuCopies = 0;
        uint64_t verifiedFrames = 0;
        uint64_t mismatchedCopies = 0;
        uint64_t deferredFrames = 0;
    };
    using FrameCallback = std::function<void(video::CapturedFrame)>;
    MacSyphonCapture();
    ~MacSyphonCapture();
    std::vector<video::WindowInfo> getServers() const;
    bool startCapture(const std::string &uuid, int fps, Alpha alpha = Alpha::Straight);
    void stopCapture();
    bool isCapturing() const;
    void setFrameRate(int fps);
    // Set before starting a generation. stopCapture waits for its callbacks.
    void setFrameCallback(FrameCallback callback);
    std::string lastError() const;
    // Counters for the most recent capture generation, retained after Stop.
    ReadbackStats readbackStats() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace versus::platform
