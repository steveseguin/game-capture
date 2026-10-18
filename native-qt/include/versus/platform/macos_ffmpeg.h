#pragma once
#include "versus/platform/posix_ffmpeg.h"
namespace versus::platform {
inline auto resolveMacFfmpeg(const std::string &path) { return resolvePosixFfmpeg(path); }
inline bool isBundledMacFfmpeg(const std::filesystem::path &path) { return isBundledPosixFfmpeg(path); }
inline bool isMacFfmpegOverride(const std::string &configured, const std::filesystem::path &resolved) { return isPosixFfmpegOverride(configured, resolved); }
inline auto runMacFfmpegProbe(const std::filesystem::path &path, const std::vector<std::string> &args) { return runPosixFfmpegProbe(path, args); }
}
