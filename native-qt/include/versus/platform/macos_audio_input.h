#pragma once
#include "versus/audio/window_audio_capture_core.h"
#include <memory>
namespace versus::platform {
// Discovery and permission inspection never open a device or prompt.
std::vector<audio::AudioDeviceInfo> macAudioInputDevices();
std::string microphonePermissionStatus();
class MacAudioInput {
public:
    MacAudioInput();
    ~MacAudioInput();
    audio::CaptureResult start(const std::string &deviceId, audio::WindowAudioCaptureCore::StreamCallback callback);
    void stop();
    bool active() const;
    std::vector<float> drain();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
