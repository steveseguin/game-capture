#pragma once

#include <string_view>

#include "versus/webrtc/webrtc_client.h"

namespace versus::webrtc {

// libdatachannel can lose its transport after isOpen() and before send().
// Only its specific track-lifetime errors, with a now-closed track, explain
// that transition. Other errors must remain visible even during teardown.
inline VideoSendFailure classifyVideoSendException(std::string_view message, bool trackOpen) {
    if (!trackOpen && (message == "Track is not open" || message == "Track is closed")) {
        return VideoSendFailure::TrackClosedDuringSend;
    }
    return VideoSendFailure::SendFailed;
}

}  // namespace versus::webrtc
