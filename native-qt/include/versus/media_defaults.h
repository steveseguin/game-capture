#pragma once

#include <cstddef>

// First-run defaults shared by the GUI, CLI, core and output workers.
// Saved profiles and explicit user settings take precedence.
namespace versus::defaults {
inline constexpr int VideoWidth = 1280;
inline constexpr int VideoHeight = 720;
// ARM Linux spans small boards and larger desktops. Start with a lower CPU
// budget without assuming that a board provides a usable hardware encoder.
// This is an initial preference, not a performance guarantee or a frame-rate
// limit. Saved profiles and explicit 60 fps selections still take precedence.
#if defined(__linux__) && (defined(__aarch64__) || defined(__arm__))
inline constexpr int VideoFps = 30;
#else
inline constexpr int VideoFps = 60;
#endif
inline constexpr int VideoBitrateKbps = 4000;
inline constexpr int AudioBitrateKbps = 128;
// RTP codec fragment, not the complete encrypted IP packet. Leave room for
// RTP extensions, RTX and SRTP on ordinary IPv6/UDP paths.
inline constexpr std::size_t RtpVideoFragmentBytes = 1200;
} // namespace versus::defaults
