#pragma once
#include <filesystem>
#include <string>
#include <vector>
namespace versus::platform {
struct FfmpegCommandResult {
    std::string output;
    bool started = false;
    bool timedOut = false;
    int exitCode = -1;
};
std::filesystem::path resolveMacFfmpeg(const std::string &configured);
bool isBundledMacFfmpeg(const std::filesystem::path &path);
bool isMacFfmpegOverride(const std::string &configured, const std::filesystem::path &resolved);
FfmpegCommandResult runMacFfmpegProbe(const std::filesystem::path &executable, const std::vector<std::string> &arguments);
}
