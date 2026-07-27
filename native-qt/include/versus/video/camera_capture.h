#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "versus/video/window_capture.h"

namespace versus::video {

class CameraCapture {
  public:
    using FrameCallback = std::function<void(CapturedFrame)>;

    CameraCapture();
    ~CameraCapture();

    std::vector<WindowInfo> getCameras();

    bool startCapture(const std::string &deviceId, int width, int height, int fps);
    void stopCapture();
    bool isCapturing() const;
    std::string lastError() const;

    void setFrameCallback(FrameCallback cb);

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    FrameCallback frameCallback_;
};

}  // namespace versus::video
