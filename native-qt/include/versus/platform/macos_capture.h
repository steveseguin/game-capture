#pragma once

#include <string>

namespace versus::platform {
// Inspection never requests permission. Only an explicit user action requests it.
bool screenCapturePermissionGranted();
bool requestScreenCapturePermission();
std::string screenCaptureStatus();
} // namespace versus::platform
