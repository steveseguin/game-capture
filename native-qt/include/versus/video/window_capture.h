#pragma once

#include <atomic>
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

class WindowCapture {
  public:
    using FrameCallback = std::function<void(CapturedFrame)>;

    WindowCapture();
    ~WindowCapture();

    std::vector<WindowInfo> getWindows();
    WindowInfo *findWindowByName(const std::string &partialName);

    bool startCapture(const std::string &windowId, int width, int height, int fps);
    void stopCapture();
    bool isCapturing() const;

    void setFrameCallback(FrameCallback cb);

    // Capture a static thumbnail of a window (does not require active capture)
    static QPixmap captureWindowThumbnail(const std::string &windowId, int maxWidth = 120, int maxHeight = 68);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    FrameCallback frameCallback_;
    std::atomic<bool> capturing_{false};
};

}  // namespace versus::video
