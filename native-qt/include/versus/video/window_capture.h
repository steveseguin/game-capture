#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <QPixmap>

namespace versus::video {

struct WindowInfo {
    std::string id;
    std::string name;
    std::string executableName;
    uint32_t processId = 0;
    int width = 0;
    int height = 0;
};

const WindowInfo *findBestWindowMatch(const std::vector<WindowInfo> &windows, const std::string &filter);

struct CapturedFrame {
    std::vector<uint8_t> data;
    int width = 0;
    int height = 0;
    int stride = 0;
    int64_t timestamp = 0;
    enum class Format { BGRA, NV12, I420, Gray } format = Format::BGRA;
};

namespace detail {

class CaptureFramePacer {
  public:
    explicit CaptureFramePacer(int targetFps = 0);

    void reset(int targetFps);
    bool shouldAdmit(std::chrono::steady_clock::time_point now);

  private:
    std::chrono::steady_clock::duration interval_{};
    std::chrono::steady_clock::time_point nextDue_{};
    bool scheduled_ = false;
};

bool frameAdmissionAllowed(const std::function<bool()> &admissionCallback);

}  // namespace detail

class WindowCapture {
  public:
    using FrameCallback = std::function<void(CapturedFrame)>;
    using FrameAdmissionCallback = std::function<bool()>;

    WindowCapture();
    ~WindowCapture();

    std::vector<WindowInfo> getWindows();
    WindowInfo *findWindowByName(const std::string &partialName);

    bool startCapture(const std::string &windowId,
                      int width,
                      int height,
                      int fps,
                      bool preserveAlpha = false);
    void stopCapture();
    bool isCapturing() const;
    void setFrameRate(int fps);

    void setFrameCallback(FrameCallback cb);
    void setFrameAdmissionCallback(FrameAdmissionCallback cb);
    uint64_t framesSkippedBeforeReadback() const;

    // Capture a static thumbnail of a window (does not require active capture)
    static QPixmap captureWindowThumbnail(const std::string &windowId, int maxWidth = 120, int maxHeight = 68);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    FrameCallback frameCallback_;
    FrameAdmissionCallback frameAdmissionCallback_;
    std::atomic<bool> capturing_{false};
};

}  // namespace versus::video
