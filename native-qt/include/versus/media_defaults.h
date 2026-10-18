#pragma once

#include <cstddef>

// First-run defaults shared by the GUI, CLI, core and output workers.
// Saved profiles and explicit user settings take precedence.
namespace versus::defaults {
inline constexpr int VideoWidth = 1280;
inline constexpr int VideoHeight = 720;
inline constexpr int VideoFps = 60;
inline constexpr int VideoBitrateKbps = 4000;
inline constexpr int AudioBitrateKbps = 128;
// RTP codec fragment, not the complete encrypted IP packet. Leave room for
// RTP extensions, RTX and SRTP on ordinary IPv6/UDP paths.
inline constexpr std::size_t RtpVideoFragmentBytes = 1200;
} // namespace versus::defaults
