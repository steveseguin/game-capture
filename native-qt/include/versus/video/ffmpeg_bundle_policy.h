#pragma once

namespace versus::video {
// The portable Linux distribution ships the GPL-enabled FFmpeg/libx264 build,
// with sources and notices, as Linux DEBs already use the distribution's GPL
// codecs. Other package policies remain unchanged. Nonfree bundles are rejected.
inline constexpr bool rejectBundledFfmpeg(bool bundled, bool gpl, bool nonfree) {
#if defined(__linux__) && defined(VERSUS_LINUX_PORTABLE)
    return bundled && nonfree;
#else
    return bundled && (gpl || nonfree);
#endif
}
}
