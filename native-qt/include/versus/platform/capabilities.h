#pragma once

namespace versus::platform {

// Compiled backend availability, not permission state or a promise that a
// particular device/encoder will initialize. Keep OS types out of this API.
struct Capabilities {
    const char *name;
    bool windowCapture;
    bool cameraCapture;
    bool spoutCapture;
    bool audioCapture;
    bool microphoneCapture;
    bool communicationsAudioCapture;
    bool videoEncoding;
    const char *unavailableReason;

    bool canCapture() const { return windowCapture || cameraCapture || spoutCapture; }
    bool canPublish() const { return videoEncoding && canCapture(); }
};

const Capabilities &capabilities();

} // namespace versus::platform
