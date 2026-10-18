#include "versus/platform/capabilities.h"

namespace versus::platform {

const Capabilities &capabilities() {
#ifdef _WIN32
    static constexpr Capabilities value{
        "Windows", true, true,
#ifdef VERSUS_USE_SPOUT
        true,
#else
        false,
#endif
        true, true, true, true, ""};
#elif defined(__APPLE__)
    // Change each flag only when its backend is wired into both production
    // and gate targets. A launchable bundle alone cannot capture or publish.
    static constexpr Capabilities value{
        "macOS", true, true, false, true, true, false, true, ""};
#elif defined(__linux__)
    static constexpr Capabilities value{
        "Linux", true, true, false, true, true, false, true, ""};
#else
    static constexpr Capabilities value{
        "Unknown", false, false, false, false, false, false, false,
        "Capture and encoding are not available on this platform."};
#endif
    return value;
}

} // namespace versus::platform
