#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "versus/video/window_capture.h"

namespace versus::video {

class SpoutCapture {
  public:
    using FrameCallback = std::function<void(CapturedFrame)>;

    SpoutCapture();
    ~SpoutCapture();

    std::vector<WindowInfo> getSenders();

    bool startCapture(const std::string &senderName, int width, int height, int fps);
    void stopCapture();
    bool isCapturing() const;

    void setFrameCallback(FrameCallback cb);
    bool getLatestFrame(CapturedFrame &outFrame);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    FrameCallback frameCallback_;
    std::atomic<bool> capturing_{false};
};

}  // namespace versus::video
