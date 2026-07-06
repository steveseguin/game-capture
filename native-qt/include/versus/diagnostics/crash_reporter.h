#pragma once

#include <string>

namespace versus::diagnostics {

struct CrashReporterConfig {
    std::string crashDirectory;
    std::string logPath;
    std::string appVersion;
};

std::string defaultCrashDirectory();
void installCrashReporter(const CrashReporterConfig &config);

} // namespace versus::diagnostics
