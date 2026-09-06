#include "versus/video/video_encoder.h"
#include "versus/video/h264_color_metadata.h"
#include "versus/video/aspect_fit.h"
#include "versus/video/window_capture.h"

#include <spdlog/spdlog.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <cwctype>
#include <deque>
#include <filesystem>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

#ifdef VERSUS_HAS_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}
#else
// Windows Media Foundation H264 encoder fallback
#ifdef _WIN32
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>
#include <codecapi.h>
#include <mferror.h>
#include <d3d11.h>
#include <strmif.h>  // For ICodecAPI
#include <wrl/client.h>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "d3d11.lib")
#endif
#endif

namespace versus::video {

namespace detail {

namespace {

struct NormalizedFfmpegOption {
    bool valid = false;
    bool fileValue = false;
    bool inlineValue = false;
    bool inlineValueHasContent = false;
    std::string name;
    std::string canonicalToken;
    std::string inlineValueText;
};

NormalizedFfmpegOption normalizeFfmpegOption(const std::string &token) {
    NormalizedFfmpegOption result;
    size_t nameBegin = 0;
    while (nameBegin < token.size() && token[nameBegin] == '-') {
        ++nameBegin;
    }
    if (nameBegin == 0 || nameBegin >= token.size()) {
        return result;
    }
    if (token[nameBegin] == '/') {
        result.fileValue = true;
        ++nameBegin;
    }
    if (nameBegin >= token.size()) {
        return result;
    }

    const size_t equals = token.find('=', nameBegin);
    const size_t specifier = token.find(':', nameBegin);
    size_t nameEnd = token.size();
    if (equals != std::string::npos) {
        nameEnd = std::min(nameEnd, equals);
        result.inlineValue = true;
        result.inlineValueHasContent = equals + 1 < token.size();
        if (result.inlineValueHasContent) {
            result.inlineValueText = token.substr(equals + 1);
        }
    }
    if (specifier != std::string::npos) {
        nameEnd = std::min(nameEnd, specifier);
    }
    if (nameEnd == nameBegin) {
        return result;
    }

    result.name = token.substr(nameBegin, nameEnd - nameBegin);
    std::transform(
        result.name.begin(),
        result.name.end(),
        result.name.begin(),
        [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });

    // Canonicalize accepted options to FFmpeg's supported single-dash form.
    // The bundled CLI does not consistently accept `-option=value`; split its
    // value into a distinct argv element below while retaining a stream
    // specifier such as `:v:0` on the option itself.
    result.canonicalToken = "-" + result.name;
    if (specifier != std::string::npos &&
        (equals == std::string::npos || specifier < equals)) {
        const size_t specifierEnd =
            equals == std::string::npos ? token.size() : equals;
        result.canonicalToken +=
            token.substr(specifier, specifierEnd - specifier);
    }
    result.valid = true;
    return result;
}

bool isSafeProtectedVp9TuningOption(const std::string &name) {
    // Protected alpha mode intentionally uses an allow-list. Unknown FFmpeg
    // options are not safe by default: new releases regularly add aliases that
    // can filter, retime, remap, duplicate, drop, or recode frames.
    static constexpr std::array<const char *, 7> safeOptions = {{
        "threads",
        "deadline",
        "cpu-used",
        "row-mt",
        "tile-columns",
        "tile-rows",
        "frame-parallel",
    }};
    return std::find_if(
               safeOptions.begin(),
               safeOptions.end(),
               [&name](const char *candidate) { return name == candidate; }) !=
        safeOptions.end();
}

bool tokenCanBeAnOption(const std::string &token) {
    if (token.size() >= 2 && token[0] == '-' &&
        (std::isdigit(static_cast<unsigned char>(token[1])) != 0 ||
         token[1] == '.')) {
        return false;
    }
    return normalizeFfmpegOption(token).valid;
}

bool annexBContainsH264RandomAccessNal(const std::vector<uint8_t> &accessUnit) {
    for (size_t index = 0; index + 3 < accessUnit.size(); ++index) {
        size_t prefixLength = 0;
        if (accessUnit[index] == 0 && accessUnit[index + 1] == 0 &&
            accessUnit[index + 2] == 1) {
            prefixLength = 3;
        } else if (index + 4 < accessUnit.size() &&
                   accessUnit[index] == 0 && accessUnit[index + 1] == 0 &&
                   accessUnit[index + 2] == 0 && accessUnit[index + 3] == 1) {
            prefixLength = 4;
        }
        if (prefixLength == 0 || index + prefixLength >= accessUnit.size()) {
            continue;
        }
        const uint8_t nalType = accessUnit[index + prefixLength] & 0x1F;
        if (nalType == 5) {
            return true;
        }
        index += prefixLength;
    }
    return false;
}

struct H264AccessUnitScan {
    bool valid = false;
    bool keyframe = false;
};

H264AccessUnitScan scanAvccH264AccessUnit(
    const std::vector<uint8_t> &accessUnit) {
    size_t offset = 0;
    bool foundNal = false;
    bool keyframe = false;
    while (offset + 4 <= accessUnit.size()) {
        const uint32_t nalSize =
            (static_cast<uint32_t>(accessUnit[offset]) << 24) |
            (static_cast<uint32_t>(accessUnit[offset + 1]) << 16) |
            (static_cast<uint32_t>(accessUnit[offset + 2]) << 8) |
            static_cast<uint32_t>(accessUnit[offset + 3]);
        offset += 4;
        if (nalSize == 0 || nalSize > accessUnit.size() - offset) {
            return {};
        }
        foundNal = true;
        const uint8_t nalType = accessUnit[offset] & 0x1F;
        if (nalType == 5) {
            keyframe = true;
        }
        offset += nalSize;
    }
    if (!foundNal || offset != accessUnit.size()) {
        return {};
    }
    return {true, keyframe};
}

bool av1FrameContainsSequenceHeader(const std::vector<uint8_t> &packet) {
    size_t pos = 0;
    while (pos < packet.size()) {
        const uint8_t header = packet[pos];
        if ((header & 0x80) != 0) {
            return false;
        }
        const uint8_t obuType = (header >> 3) & 0x0F;
        const bool hasExtension = (header & 0x04) != 0;
        const bool hasSizeField = (header & 0x02) != 0;
        if (obuType == 1) {
            return true;
        }
        pos += 1 + (hasExtension ? 1 : 0);
        if (!hasSizeField) {
            return false;
        }
        uint64_t obuSize = 0;
        int shift = 0;
        bool sizeParsed = false;
        while (pos < packet.size() && shift < 56) {
            const uint8_t byte = packet[pos++];
            obuSize |= static_cast<uint64_t>(byte & 0x7F) << shift;
            if ((byte & 0x80) == 0) {
                sizeParsed = true;
                break;
            }
            shift += 7;
        }
        if (!sizeParsed || obuSize > packet.size() - pos) {
            return false;
        }
        pos += static_cast<size_t>(obuSize);
    }
    return false;
}

class Vp9BitReader {
  public:
    explicit Vp9BitReader(const std::vector<uint8_t> &packet) : packet_(packet) {}

    bool readBits(int count, uint32_t &value) {
        value = 0;
        for (int bit = 0; bit < count; ++bit) {
            if (bitOffset_ >= packet_.size() * 8) {
                return false;
            }
            const uint8_t byte = packet_[bitOffset_ / 8];
            value = (value << 1) |
                static_cast<uint32_t>((byte >> (7 - (bitOffset_ % 8))) & 1U);
            ++bitOffset_;
        }
        return true;
    }

  private:
    const std::vector<uint8_t> &packet_;
    size_t bitOffset_ = 0;
};

}  // namespace

bool h264AccessUnitIsKeyframe(const std::vector<uint8_t> &accessUnit,
                              H264BitstreamFormat format) {
    if (accessUnit.empty()) {
        return false;
    }
    if (format == H264BitstreamFormat::AnnexB) {
        return annexBContainsH264RandomAccessNal(accessUnit);
    }
    if (format == H264BitstreamFormat::Avcc) {
        const auto scan = scanAvccH264AccessUnit(accessUnit);
        return scan.valid && scan.keyframe;
    }
    const auto avcc = scanAvccH264AccessUnit(accessUnit);
    return avcc.valid
        ? avcc.keyframe
        : annexBContainsH264RandomAccessNal(accessUnit);
}

bool prepareFreshMediaFoundationEncoderAfterWarmup(
    const MediaFoundationWarmupLifecycle &lifecycle) {
    if (!lifecycle.releaseWarmedTransform ||
        !lifecycle.shutdownActivation ||
        !lifecycle.activateFreshTransform ||
        !lifecycle.configureFreshTransform ||
        !lifecycle.clearLiveIdentityState) {
        return false;
    }
    lifecycle.releaseWarmedTransform();
    if (!lifecycle.shutdownActivation()) {
        return false;
    }
    if (!lifecycle.activateFreshTransform()) {
        return false;
    }
    if (!lifecycle.configureFreshTransform()) {
        return false;
    }
    lifecycle.clearLiveIdentityState();
    return true;
}

FfmpegOptionPolicyResult appendProtectedVp9Options(
    std::vector<std::string> baseArgs,
    const std::vector<std::string> &customArgs) {
    FfmpegOptionPolicyResult result;
    result.args = std::move(baseArgs);
    for (size_t index = 0; index < customArgs.size(); ++index) {
        const std::string &token = customArgs[index];
        const NormalizedFfmpegOption option = normalizeFfmpegOption(token);
        const bool safeOption = option.valid && !option.fileValue &&
            isSafeProtectedVp9TuningOption(option.name);
        if (safeOption) {
            if (option.inlineValue) {
                if (option.inlineValueHasContent) {
                    result.args.push_back(option.canonicalToken);
                    result.args.push_back(option.inlineValueText);
                } else {
                    result.rejectedOptions.push_back(
                        token + " (missing required value)");
                }
                continue;
            }
            if (index + 1 < customArgs.size() &&
                !tokenCanBeAnOption(customArgs[index + 1])) {
                result.args.push_back(option.canonicalToken);
                result.args.push_back(customArgs[++index]);
                continue;
            }

            result.rejectedOptions.push_back(
                token + " (missing required value)");
            continue;
        }

        std::string rejected = token;
        if (option.valid && !option.inlineValue &&
            index + 1 < customArgs.size() &&
            !tokenCanBeAnOption(customArgs[index + 1])) {
            rejected += ' ';
            rejected += customArgs[++index];
        }
        result.rejectedOptions.push_back(std::move(rejected));
    }

    // These are intentionally last: FFmpeg resolves repeated scalar options by
    // taking the last value for the output stream.
    const std::array<const char *, 12> mandatory = {
        "-c:v", "libvpx-vp9",
        "-fps_mode", "passthrough",
        "-lag-in-frames", "0",
        "-auto-alt-ref", "0",
        "-g", "1",
        "-keyint_min", "1",
    };
    result.args.insert(result.args.end(), mandatory.begin(), mandatory.end());
    return result;
}

BoundedSourceTimestampQueue::BoundedSourceTimestampQueue(std::size_t capacity)
    : capacity_(std::max<std::size_t>(1, capacity)) {}

bool BoundedSourceTimestampQueue::tryPush(int64_t sourceTimestamp) {
    if (timestamps_.size() >= capacity_) {
        return false;
    }
    timestamps_.push_back(sourceTimestamp);
    return true;
}

bool BoundedSourceTimestampQueue::tryPop(int64_t &sourceTimestamp) {
    if (timestamps_.empty()) {
        return false;
    }
    sourceTimestamp = timestamps_.front();
    timestamps_.pop_front();
    return true;
}

void BoundedSourceTimestampQueue::clear() {
    timestamps_.clear();
}

std::size_t BoundedSourceTimestampQueue::size() const {
    return timestamps_.size();
}

std::size_t BoundedSourceTimestampQueue::capacity() const {
    return capacity_;
}

bool vp9FrameIsKeyframe(const std::vector<uint8_t> &packet) {
    Vp9BitReader bits(packet);
    uint32_t value = 0;
    if (!bits.readBits(2, value) || value != 2) {
        return false;
    }
    uint32_t profileLow = 0;
    uint32_t profileHigh = 0;
    if (!bits.readBits(1, profileLow) || !bits.readBits(1, profileHigh)) {
        return false;
    }
    const uint32_t profile = profileLow | (profileHigh << 1);
    if (profile == 3 && !bits.readBits(1, value)) {
        return false;
    }
    uint32_t showExistingFrame = 0;
    if (!bits.readBits(1, showExistingFrame) || showExistingFrame != 0) {
        return false;
    }
    uint32_t frameType = 1;
    if (!bits.readBits(1, frameType) || frameType != 0) {
        return false;
    }
    // show_frame and error_resilient_mode precede the keyframe sync code.
    if (!bits.readBits(1, value) || !bits.readBits(1, value)) {
        return false;
    }
    uint32_t sync0 = 0;
    uint32_t sync1 = 0;
    uint32_t sync2 = 0;
    return bits.readBits(8, sync0) &&
        bits.readBits(8, sync1) &&
        bits.readBits(8, sync2) &&
        sync0 == 0x49 && sync1 == 0x83 && sync2 == 0x42;
}

bool ivfFrameIsKeyframe(VideoCodec codec, const std::vector<uint8_t> &packet) {
    if (codec == VideoCodec::VP9) {
        return vp9FrameIsKeyframe(packet);
    }
    if (codec == VideoCodec::AV1) {
        return av1FrameContainsSequenceHeader(packet);
    }
    return false;
}

bool protectedVp9RuntimeContractHealthy(
    bool initialized,
    bool requireEveryFrameKeyframe,
    VideoCodec activeCodec,
    const std::string &activeEncoderName,
    bool mostRecentProtectedPacketHealthy) {
    std::string normalizedEncoder = activeEncoderName;
    std::transform(
        normalizedEncoder.begin(),
        normalizedEncoder.end(),
        normalizedEncoder.begin(),
        [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return initialized && requireEveryFrameKeyframe &&
        activeCodec == VideoCodec::VP9 &&
        normalizedEncoder.find("libvpx-vp9") != std::string::npos &&
        mostRecentProtectedPacketHealthy;
}

bool shouldRetryH264NvencWithFfmpeg(const EncoderConfig &config,
                                    const std::string &activeEncoderName,
                                    bool hardwareEncoderActive) {
    if (config.codec != VideoCodec::H264 ||
        !config.explicitEncoderSelection ||
        config.preferredHardware != HardwareEncoder::NVENC ||
        config.forceFfmpegNvenc) {
        return false;
    }

    std::string normalizedEncoder = activeEncoderName;
    std::transform(
        normalizedEncoder.begin(),
        normalizedEncoder.end(),
        normalizedEncoder.begin(),
        [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    const bool confirmedNvidia =
        normalizedEncoder.find("nvidia") != std::string::npos ||
        normalizedEncoder.find("nvenc") != std::string::npos;
    return !hardwareEncoderActive || !confirmedNvidia;
}

}  // namespace detail

namespace {

const char *videoCodecName(VideoCodec codec) {
    switch (codec) {
        case VideoCodec::H264:
            return "H.264";
        case VideoCodec::H265:
            return "H.265";
        case VideoCodec::VP8:
            return "VP8";
        case VideoCodec::VP9:
            return "VP9";
        case VideoCodec::AV1:
            return "AV1";
        default:
            return "Unknown";
    }
}

std::string toLowerCopy(std::string value);

const char *requestedEncoderModeName(const EncoderConfig &config) {
    if (!config.explicitEncoderSelection) {
        return "Auto";
    }
    switch (config.preferredHardware) {
        case HardwareEncoder::NVENC:
            return config.forceFfmpegNvenc ? "NVIDIA (FFmpeg NVENC)" : "NVIDIA";
        case HardwareEncoder::QuickSync:
            return "Intel";
        case HardwareEncoder::AMF:
            return "AMD";
        case HardwareEncoder::None:
        default:
            return "Software";
    }
}

bool encoderMatchesExplicitSelection(const EncoderConfig &config,
                                     const std::string &encoderName,
                                     bool hardware) {
    if (!config.explicitEncoderSelection) {
        return true;
    }
    if (config.preferredHardware == HardwareEncoder::None) {
        return !hardware;
    }
    if (!hardware) {
        return false;
    }
    const std::string lower = toLowerCopy(encoderName);
    switch (config.preferredHardware) {
        case HardwareEncoder::NVENC:
            return lower.find("nvidia") != std::string::npos ||
                   lower.find("nvenc") != std::string::npos ||
                   lower.find("geforce") != std::string::npos;
        case HardwareEncoder::QuickSync:
            return lower.find("intel") != std::string::npos ||
                   lower.find("quick sync") != std::string::npos ||
                   lower.find("qsv") != std::string::npos;
        case HardwareEncoder::AMF:
            return lower.find("amd") != std::string::npos ||
                   lower.find("radeon") != std::string::npos ||
                   lower.find("amf") != std::string::npos;
        case HardwareEncoder::None:
        default:
            return false;
    }
}

std::string encoderCategoryName(const std::string &encoderName, bool hardware) {
    if (encoderName.empty()) {
        return "Unavailable";
    }
    if (!hardware) {
        return "Software";
    }
    const std::string lower = toLowerCopy(encoderName);
    if (lower.find("nvidia") != std::string::npos ||
        lower.find("nvenc") != std::string::npos ||
        lower.find("geforce") != std::string::npos) {
        return "NVIDIA";
    }
    if (lower.find("intel") != std::string::npos ||
        lower.find("quick sync") != std::string::npos ||
        lower.find("qsv") != std::string::npos) {
        return "Intel";
    }
    if (lower.find("amd") != std::string::npos ||
        lower.find("radeon") != std::string::npos ||
        lower.find("amf") != std::string::npos) {
        return "AMD";
    }
    return "Hardware";
}

std::string trimCopyForPath(const std::string &value) {
    size_t begin = 0;
    while (begin < value.size() && std::isspace(static_cast<unsigned char>(value[begin])) != 0) {
        ++begin;
    }
    size_t end = value.size();
    while (end > begin && std::isspace(static_cast<unsigned char>(value[end - 1])) != 0) {
        --end;
    }
    return value.substr(begin, end - begin);
}

std::string toLowerCopy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

bool textContainsInsensitive(const std::string &text, const std::string &needle) {
    return toLowerCopy(text).find(toLowerCopy(needle)) != std::string::npos;
}

int recommendedRealtimeVp9Threads(int width, int height) {
    const unsigned int cores = std::max(1u, std::thread::hardware_concurrency());
    int threads = cores <= 2 ? 1 : std::clamp(static_cast<int>(cores / 2), 2, 8);
    const int64_t pixels = static_cast<int64_t>(std::max(1, width)) * static_cast<int64_t>(std::max(1, height));
    if (pixels <= 1280LL * 720LL) {
        threads = std::min(threads, 4);
    }
    return std::max(1, threads);
}

std::filesystem::path normalizeFfmpegCandidate(std::filesystem::path candidate) {
    if (candidate.empty()) {
        return {};
    }
    std::error_code ec;
    if (std::filesystem::is_directory(candidate, ec)) {
        candidate /= "ffmpeg.exe";
    }
    if (!candidate.has_extension() &&
        (candidate.filename().string() == "ffmpeg" ||
         candidate.filename().string() == "ffmpeg.exe")) {
#ifdef _WIN32
        candidate += ".exe";
#endif
    }
    if (!candidate.is_absolute()) {
        candidate = std::filesystem::absolute(candidate, ec);
    }
    return candidate;
}

bool existingRegularFile(const std::filesystem::path &path) {
    std::error_code ec;
    return !path.empty() &&
           std::filesystem::exists(path, ec) &&
           std::filesystem::is_regular_file(path, ec);
}

std::filesystem::path firstExistingFfmpegPath(const std::vector<std::filesystem::path> &candidates) {
    std::vector<std::string> seen;
    for (const auto &rawCandidate : candidates) {
        const std::filesystem::path candidate = normalizeFfmpegCandidate(rawCandidate);
        if (candidate.empty()) {
            continue;
        }
        std::string key = candidate.lexically_normal().string();
        std::transform(key.begin(), key.end(), key.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
            continue;
        }
        seen.push_back(key);
        if (existingRegularFile(candidate)) {
            return candidate;
        }
    }
    return {};
}

std::filesystem::path executableDirectory() {
#ifdef _WIN32
    wchar_t modulePathWide[MAX_PATH] = {};
    const DWORD modulePathLen = GetModuleFileNameW(nullptr, modulePathWide, MAX_PATH);
    if (modulePathLen > 0 && modulePathLen < MAX_PATH) {
        return std::filesystem::path(modulePathWide).parent_path();
    }
#endif
    std::error_code ec;
    return std::filesystem::current_path(ec);
}

bool envFlagEnabled(const char *name) {
    const char *value = std::getenv(name);
    if (!value || !*value) {
        return false;
    }
    const std::string lower = toLowerCopy(trimCopyForPath(value));
    return lower == "1" || lower == "true" || lower == "yes" || lower == "on";
}

std::filesystem::path resolveFfmpegPathImpl(const std::string &configuredPath) {
    const std::string configured = trimCopyForPath(configuredPath);
    if (!configured.empty()) {
        return firstExistingFfmpegPath({configured});
    }

    const std::filesystem::path moduleDir = executableDirectory();
    std::filesystem::path bundled = firstExistingFfmpegPath({
        moduleDir / "ffmpeg" / "bin" / "ffmpeg.exe",
        moduleDir / "ffmpeg.exe"
    });
    if (!bundled.empty()) {
        return bundled;
    }

    const char *envPath = std::getenv("VERSUS_FFMPEG_PATH");
    if (envPath && *envPath) {
        std::filesystem::path envCandidate = firstExistingFfmpegPath({envPath});
        if (!envCandidate.empty()) {
            return envCandidate;
        }
    }

    if (!envFlagEnabled("VERSUS_ALLOW_SYSTEM_FFMPEG")) {
        return {};
    }

    envPath = std::getenv("FFMPEG_PATH");
    if (envPath && *envPath) {
        std::filesystem::path envCandidate = firstExistingFfmpegPath({envPath});
        if (!envCandidate.empty()) {
            return envCandidate;
        }
    }
    envPath = std::getenv("FFMPEG_EXE");
    if (envPath && *envPath) {
        std::filesystem::path envCandidate = firstExistingFfmpegPath({envPath});
        if (!envCandidate.empty()) {
            return envCandidate;
        }
    }
#ifdef _WIN32
    wchar_t searchResult[MAX_PATH] = {};
    const DWORD searchLen = SearchPathW(nullptr, L"ffmpeg.exe", nullptr, MAX_PATH, searchResult, nullptr);
    if (searchLen > 0 && searchLen < MAX_PATH) {
        return firstExistingFfmpegPath({std::filesystem::path(searchResult)});
    }
#endif
    return {};
}

bool isBundledFfmpegPath(const std::filesystem::path &path) {
    if (path.empty()) {
        return false;
    }
    const std::filesystem::path moduleDir = executableDirectory();
    const std::string normalized = toLowerCopy(path.lexically_normal().string());
    return normalized == toLowerCopy((moduleDir / "ffmpeg" / "bin" / "ffmpeg.exe").lexically_normal().string()) ||
           normalized == toLowerCopy((moduleDir / "ffmpeg.exe").lexically_normal().string());
}

#ifdef _WIN32
std::wstring utf8ToWideForCommand(const std::string &value) {
    if (value.empty()) {
        return {};
    }
    const int len = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
    if (len <= 0) {
        return std::wstring(value.begin(), value.end());
    }
    std::wstring wide(static_cast<size_t>(len - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, wide.data(), len);
    return wide;
}

std::wstring quoteCommandArgForShell(const std::wstring &arg) {
    if (arg.empty()) {
        return L"\"\"";
    }
    bool needsQuotes = false;
    for (wchar_t ch : arg) {
        if (std::iswspace(ch) || ch == L'"') {
            needsQuotes = true;
            break;
        }
    }
    if (!needsQuotes) {
        return arg;
    }
    std::wstring quoted = L"\"";
    int backslashes = 0;
    for (wchar_t ch : arg) {
        if (ch == L'\\') {
            ++backslashes;
            continue;
        }
        if (ch == L'"') {
            quoted.append(static_cast<size_t>(backslashes * 2 + 1), L'\\');
            quoted.push_back(L'"');
            backslashes = 0;
            continue;
        }
        if (backslashes > 0) {
            quoted.append(static_cast<size_t>(backslashes), L'\\');
            backslashes = 0;
        }
        quoted.push_back(ch);
    }
    if (backslashes > 0) {
        quoted.append(static_cast<size_t>(backslashes * 2), L'\\');
    }
    quoted.push_back(L'"');
    return quoted;
}

struct CommandCaptureResult {
    std::string output;
    bool started = false;
    bool timedOut = false;
    int exitCode = -1;
};

constexpr DWORD kFfmpegProbeTimeoutMs = 3000;
constexpr size_t kFfmpegProbeMaximumOutputBytes = 2 * 1024 * 1024;

void drainCommandPipe(HANDLE readPipe, std::string &output) {
    std::array<char, 4096> buffer{};
    while (true) {
        DWORD available = 0;
        if (!PeekNamedPipe(readPipe, nullptr, 0, nullptr, &available, nullptr) || available == 0) {
            return;
        }
        DWORD bytesRead = 0;
        const DWORD bytesToRead = std::min<DWORD>(available, static_cast<DWORD>(buffer.size()));
        if (!ReadFile(readPipe, buffer.data(), bytesToRead, &bytesRead, nullptr) || bytesRead == 0) {
            return;
        }
        if (output.size() < kFfmpegProbeMaximumOutputBytes) {
            const size_t remaining = kFfmpegProbeMaximumOutputBytes - output.size();
            output.append(buffer.data(), std::min<size_t>(bytesRead, remaining));
        }
    }
}

CommandCaptureResult runCommandCapture(const std::filesystem::path &exe,
                                       const std::vector<std::string> &args) {
    CommandCaptureResult result;
    std::wstring command = quoteCommandArgForShell(exe.wstring());
    for (const auto &arg : args) {
        command.push_back(L' ');
        command += quoteCommandArgForShell(utf8ToWideForCommand(arg));
    }

    SECURITY_ATTRIBUTES pipeAttributes{};
    pipeAttributes.nLength = sizeof(pipeAttributes);
    pipeAttributes.bInheritHandle = TRUE;
    HANDLE readPipe = nullptr;
    HANDLE writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &pipeAttributes, 0)) {
        return result;
    }
    if (!SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0)) {
        CloseHandle(readPipe);
        CloseHandle(writePipe);
        return result;
    }
    HANDLE nullInput = CreateFileW(
        L"NUL",
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &pipeAttributes,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (nullInput == INVALID_HANDLE_VALUE) {
        CloseHandle(readPipe);
        CloseHandle(writePipe);
        return result;
    }

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = nullInput;
    startup.hStdOutput = writePipe;
    startup.hStdError = writePipe;
    PROCESS_INFORMATION process{};
    const BOOL created = CreateProcessW(
        exe.c_str(),
        command.data(),
        nullptr,
        nullptr,
        TRUE,
        CREATE_NO_WINDOW,
        nullptr,
        nullptr,
        &startup,
        &process);
    CloseHandle(writePipe);
    CloseHandle(nullInput);
    if (!created) {
        CloseHandle(readPipe);
        return result;
    }

    result.started = true;
    const auto deadline = std::chrono::steady_clock::now() +
        std::chrono::milliseconds(kFfmpegProbeTimeoutMs);
    while (true) {
        drainCommandPipe(readPipe, result.output);
        const DWORD waitResult = WaitForSingleObject(process.hProcess, 25);
        if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_FAILED) {
            break;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            result.timedOut = true;
            TerminateProcess(process.hProcess, 1);
            WaitForSingleObject(process.hProcess, 1000);
            break;
        }
    }
    drainCommandPipe(readPipe, result.output);
    DWORD exitCode = 0;
    if (GetExitCodeProcess(process.hProcess, &exitCode)) {
        result.exitCode = static_cast<int>(exitCode);
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(readPipe);
    return result;
}
#else
struct CommandCaptureResult {
    std::string output;
    bool started = false;
    bool timedOut = false;
    int exitCode = -1;
};

CommandCaptureResult runCommandCapture(const std::filesystem::path &, const std::vector<std::string> &) {
    return {};
}
#endif

FfmpegProbeInfo probeFfmpegImpl(const std::string &configuredPath) {
    FfmpegProbeInfo info;
    const std::filesystem::path resolved = resolveFfmpegPathImpl(configuredPath);
    info.userOverride = !trimCopyForPath(configuredPath).empty();
    if (resolved.empty()) {
        info.error = info.userOverride
            ? "Configured FFmpeg path was not found"
            : "FFmpeg was not found";
        return info;
    }

    info.resolved = true;
    info.path = resolved.string();
    info.bundled = isBundledFfmpegPath(resolved);

    struct ProbeCacheEntry {
        bool valid = false;
        std::string key;
        std::filesystem::file_time_type modified{};
        std::chrono::steady_clock::time_point probedAt{};
        FfmpegProbeInfo info;
    };
    static std::mutex probeCacheMutex;
    static ProbeCacheEntry probeCache;
    std::error_code modifiedError;
    const auto modified = std::filesystem::last_write_time(resolved, modifiedError);
    const std::string cacheKey =
        (info.userOverride ? "user:" : "auto:") + toLowerCopy(resolved.lexically_normal().string());
    const auto probeNow = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> cacheLock(probeCacheMutex);
    if (probeCache.valid &&
        probeCache.key == cacheKey &&
        !modifiedError &&
        probeCache.modified == modified &&
        (probeNow - probeCache.probedAt) < std::chrono::seconds(60)) {
        return probeCache.info;
    }
    const auto cacheAndReturn = [&](FfmpegProbeInfo completed) {
        probeCache.valid = !modifiedError;
        probeCache.key = cacheKey;
        probeCache.modified = modified;
        probeCache.probedAt = probeNow;
        probeCache.info = completed;
        return completed;
    };

    const CommandCaptureResult versionProbe = runCommandCapture(resolved, {"-hide_banner", "-version"});
    if (!versionProbe.started) {
        info.error = "FFmpeg probe failed";
        return cacheAndReturn(info);
    }
    if (versionProbe.timedOut) {
        info.error = "FFmpeg version probe timed out";
        return cacheAndReturn(info);
    }
    if (versionProbe.exitCode != 0 || versionProbe.output.empty()) {
        info.error = "FFmpeg version probe failed";
        return cacheAndReturn(info);
    }
    const CommandCaptureResult encoderProbe = runCommandCapture(resolved, {"-hide_banner", "-encoders"});
    if (!encoderProbe.started) {
        info.error = "FFmpeg encoder probe failed";
        return cacheAndReturn(info);
    }
    if (encoderProbe.timedOut) {
        info.error = "FFmpeg encoder probe timed out";
        return cacheAndReturn(info);
    }
    if (encoderProbe.exitCode != 0 || encoderProbe.output.empty()) {
        info.error = "FFmpeg encoder probe failed";
        return cacheAndReturn(info);
    }

    std::istringstream versionStream(versionProbe.output);
    std::string line;
    if (std::getline(versionStream, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
            line.pop_back();
        }
        info.version = line;
    }
    versionStream.clear();
    versionStream.str(versionProbe.output);
    while (std::getline(versionStream, line)) {
        if (line.rfind("configuration:", 0) == 0) {
            while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
                line.pop_back();
            }
            info.configuration = line;
            break;
        }
    }

    info.hasLibvpxVp9 = textContainsInsensitive(encoderProbe.output, "libvpx-vp9");
    info.gplEnabled = textContainsInsensitive(info.configuration, "--enable-gpl");
    info.nonfreeEnabled = textContainsInsensitive(info.configuration, "--enable-nonfree");
    return cacheAndReturn(info);
}

void fillBgraOpaqueColor(uint8_t *dst,
                         int dstW,
                         int dstH,
                         int dstStride,
                         uint8_t blue,
                         uint8_t green,
                         uint8_t red) {
    if (!dst || dstW <= 0 || dstH <= 0 || dstStride < (dstW * 4)) {
        return;
    }

    const size_t rowSize = static_cast<size_t>(dstW) * 4;
    for (int y = 0; y < dstH; ++y) {
        uint8_t *row = dst + static_cast<size_t>(y) * dstStride;
        for (int x = 0; x < dstW; ++x) {
            row[x * 4 + 0] = blue;
            row[x * 4 + 1] = green;
            row[x * 4 + 2] = red;
            row[x * 4 + 3] = 255;
        }
    }
}

void fillBgraOpaqueBlack(uint8_t *dst, int dstW, int dstH, int dstStride) {
    fillBgraOpaqueColor(dst, dstW, dstH, dstStride, 0, 0, 0);
}

void getAspectPaddingColor(const EncoderConfig &config, uint8_t &blue, uint8_t &green, uint8_t &red) {
    if (config.alphaBackgroundMode == AlphaBackgroundMode::None) {
        blue = 0;
        green = 0;
        red = 0;
        return;
    }
    blue = config.alphaBackgroundBlue;
    green = config.alphaBackgroundGreen;
    red = config.alphaBackgroundRed;
}

void blitBgraAspectFit(const uint8_t *src, int srcW, int srcH, int srcStride,
                       uint8_t *dst, int dstW, int dstH, int dstStride,
                       const EncoderConfig &config) {
    uint8_t padB = 0;
    uint8_t padG = 0;
    uint8_t padR = 0;
    getAspectPaddingColor(config, padB, padG, padR);

    if (!dst || dstW <= 0 || dstH <= 0 || dstStride < (dstW * 4)) {
        return;
    }

    if (!src || srcW <= 0 || srcH <= 0 || srcStride < (srcW * 4)) {
        fillBgraOpaqueColor(dst, dstW, dstH, dstStride, padB, padG, padR);
        return;
    }

    const AspectFitRect fit = computeAspectFitRect(srcW, srcH, dstW, dstH);
    if (fit.width <= 0 || fit.height <= 0) {
        fillBgraOpaqueColor(dst, dstW, dstH, dstStride, padB, padG, padR);
        return;
    }

    if (fit.x == 0 && fit.y == 0 &&
        fit.width == dstW && fit.height == dstH &&
        srcW == dstW && srcH == dstH) {
        const size_t rowBytes = static_cast<size_t>(dstW) * 4;
        for (int y = 0; y < dstH; ++y) {
            const uint8_t *srcRow = src + static_cast<size_t>(y) * srcStride;
            uint8_t *dstRow = dst + static_cast<size_t>(y) * dstStride;
            std::memcpy(dstRow, srcRow, rowBytes);
        }
        return;
    }

    fillBgraOpaqueColor(dst, dstW, dstH, dstStride, padB, padG, padR);

    // Downscaling gameplay/text with nearest-neighbor produces visible aliasing.
    // Fit the full source into the target so aspect-ratio changes do not crop gameplay.
    thread_local std::vector<int> x0Map;
    thread_local std::vector<int> x1Map;
    thread_local std::vector<int> y0Map;
    thread_local std::vector<int> y1Map;
    thread_local std::vector<uint16_t> xWeightMap;
    thread_local std::vector<uint16_t> yWeightMap;

    x0Map.resize(static_cast<size_t>(fit.width));
    x1Map.resize(static_cast<size_t>(fit.width));
    xWeightMap.resize(static_cast<size_t>(fit.width));
    y0Map.resize(static_cast<size_t>(fit.height));
    y1Map.resize(static_cast<size_t>(fit.height));
    yWeightMap.resize(static_cast<size_t>(fit.height));

    const auto buildAxisMap = [](int sourceExtent,
                                 int targetExtent,
                                 std::vector<int> &lowMap,
                                 std::vector<int> &highMap,
                                 std::vector<uint16_t> &weightMap) {
        const double scale = static_cast<double>(sourceExtent) / std::max(1, targetExtent);
        const int maxCoord = sourceExtent - 1;

        for (int i = 0; i < targetExtent; ++i) {
            double srcPos = ((static_cast<double>(i) + 0.5) * scale) - 0.5;
            int low = static_cast<int>(std::floor(srcPos));
            double frac = srcPos - low;

            if (low < 0) {
                low = 0;
                frac = 0.0;
            } else if (low >= maxCoord) {
                low = maxCoord;
                frac = 0.0;
            }

            const int high = std::min(low + 1, maxCoord);
            const int weight = std::clamp(static_cast<int>(std::lround(frac * 256.0)), 0, 256);
            lowMap[static_cast<size_t>(i)] = low;
            highMap[static_cast<size_t>(i)] = high;
            weightMap[static_cast<size_t>(i)] = static_cast<uint16_t>(weight);
        }
    };

    buildAxisMap(srcW, fit.width, x0Map, x1Map, xWeightMap);
    buildAxisMap(srcH, fit.height, y0Map, y1Map, yWeightMap);

    for (int y = 0; y < fit.height; ++y) {
        const int srcY0 = y0Map[static_cast<size_t>(y)];
        const int srcY1 = y1Map[static_cast<size_t>(y)];
        const int wy = yWeightMap[static_cast<size_t>(y)];
        const int invWy = 256 - wy;
        const uint8_t *srcRow0 = src + static_cast<size_t>(srcY0) * srcStride;
        const uint8_t *srcRow1 = src + static_cast<size_t>(srcY1) * srcStride;
        uint8_t *dstRow = dst + static_cast<size_t>(fit.y + y) * dstStride + static_cast<size_t>(fit.x) * 4;

        for (int x = 0; x < fit.width; ++x) {
            const int srcX0 = x0Map[static_cast<size_t>(x)];
            const int srcX1 = x1Map[static_cast<size_t>(x)];
            const int wx = xWeightMap[static_cast<size_t>(x)];
            const int invWx = 256 - wx;
            const uint8_t *p00 = srcRow0 + static_cast<size_t>(srcX0) * 4;
            const uint8_t *p01 = srcRow0 + static_cast<size_t>(srcX1) * 4;
            const uint8_t *p10 = srcRow1 + static_cast<size_t>(srcX0) * 4;
            const uint8_t *p11 = srcRow1 + static_cast<size_t>(srcX1) * 4;
            uint8_t *dstPixel = dstRow + static_cast<size_t>(x) * 4;

            for (int c = 0; c < 4; ++c) {
                const int top = p00[c] * invWx + p01[c] * wx;
                const int bottom = p10[c] * invWx + p11[c] * wx;
                dstPixel[c] = static_cast<uint8_t>((top * invWy + bottom * wy + 32768) >> 16);
            }
        }
    }
}

}  // namespace

#ifdef VERSUS_HAS_FFMPEG

class VideoEncoder::Impl {
  public:
    bool initialize(const EncoderConfig &config) {
        config_ = config;
        pendingSourceTimestamps_.clear();
        lastEncodeFailureKind_.store(EncodeFailureKind::None, std::memory_order_relaxed);
        return tryInitEncoder(config_.preferredHardware);
    }

    void shutdown() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (codecCtx_) {
            avcodec_free_context(&codecCtx_);
        }
        if (hwDeviceCtx_) {
            av_buffer_unref(&hwDeviceCtx_);
        }
        if (hwFrameCtx_) {
            av_buffer_unref(&hwFrameCtx_);
        }
        if (swsCtx_) {
            sws_freeContext(swsCtx_);
            swsCtx_ = nullptr;
        }
        if (frame_) {
            av_frame_free(&frame_);
        }
        if (hwFrame_) {
            av_frame_free(&hwFrame_);
        }
        if (packet_) {
            av_packet_free(&packet_);
        }
        initialized_ = false;
        pendingSourceTimestamps_.clear();
        setActiveEncoderName("");
        activeCodec_.store(VideoCodec::H264, std::memory_order_relaxed);
        lastEncodeFailureKind_.store(EncodeFailureKind::None, std::memory_order_relaxed);
    }

    bool encode(const CapturedFrame &input,
                EncodedPacket &output,
                int64_t sourceTimestamp) {
        std::lock_guard<std::mutex> lock(mutex_);
        lastEncodeFailureKind_.store(EncodeFailureKind::None, std::memory_order_relaxed);
        if (!initialized_) {
            lastEncodeFailureKind_.store(EncodeFailureKind::InvalidInput, std::memory_order_relaxed);
            return false;
        }
        if (!prepareFrame(input)) {
            lastEncodeFailureKind_.store(EncodeFailureKind::InvalidInput, std::memory_order_relaxed);
            return false;
        }
        const int64_t submittedEncoderPts = frame_->pts;
        int ret = avcodec_send_frame(codecCtx_, useHardware_ ? hwFrame_ : frame_);
        if (ret < 0 && ret != AVERROR(EAGAIN)) {
            lastEncodeFailureKind_.store(EncodeFailureKind::IoFailure, std::memory_order_relaxed);
            return false;
        }
        if (ret >= 0) {
            pendingSourceTimestamps_.emplace_back(submittedEncoderPts, sourceTimestamp);
            while (pendingSourceTimestamps_.size() > 128) {
                pendingSourceTimestamps_.pop_front();
            }
        }
        ret = avcodec_receive_packet(codecCtx_, packet_);
        if (ret < 0) {
            lastEncodeFailureKind_.store(ret == AVERROR(EAGAIN) ? EncodeFailureKind::Timeout
                                                               : EncodeFailureKind::IoFailure,
                                         std::memory_order_relaxed);
            return false;
        }
        output.data.assign(packet_->data, packet_->data + packet_->size);
        output.sourceTimestamp = std::numeric_limits<int64_t>::min();
        const auto sourceTimestamp = std::find_if(
            pendingSourceTimestamps_.begin(),
            pendingSourceTimestamps_.end(),
            [this](const auto &entry) { return entry.first == packet_->pts; });
        if (sourceTimestamp != pendingSourceTimestamps_.end()) {
            output.sourceTimestamp = sourceTimestamp->second;
            pendingSourceTimestamps_.erase(sourceTimestamp);
        }
        output.pts = packet_->pts;
        output.dts = packet_->dts;
        output.isKeyframe = config_.codec == VideoCodec::H264
            ? detail::h264AccessUnitIsKeyframe(output.data)
            : (packet_->flags & AV_PKT_FLAG_KEY) != 0;
        output.codec = config_.codec;
        av_packet_unref(packet_);
        return true;
    }

    void setBitrate(int kbps) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (codecCtx_) {
            codecCtx_->bit_rate = kbps * 1000;
        }
        config_.bitrate = kbps;
    }

    void requestKeyframe() { forceKeyframe_ = true; }
    std::string activeEncoderName() const {
        std::lock_guard<std::mutex> lock(activeEncoderNameMutex_);
        return activeEncoderName_;
    }
    VideoCodec activeCodec() const { return activeCodec_.load(std::memory_order_relaxed); }
    std::string activeCodecName() const { return videoCodecName(activeCodec()); }
    std::string activeInputFormatName() const {
        return useHardware_.load(std::memory_order_relaxed) ? "NV12" : "YUV420P";
    }
    bool isHardwareEncoder() const { return useHardware_.load(std::memory_order_relaxed); }
    EncodeFailureKind lastEncodeFailureKind() const {
        return lastEncodeFailureKind_.load(std::memory_order_relaxed);
    }

  private:
    void setActiveEncoderName(std::string name) {
        std::lock_guard<std::mutex> lock(activeEncoderNameMutex_);
        activeEncoderName_ = std::move(name);
    }

    bool tryInitEncoder(HardwareEncoder hardware) {
        const char *encoderName = "h264_nvenc";
        AVHWDeviceType hwType = AV_HWDEVICE_TYPE_CUDA;

        if (config_.codec == VideoCodec::H265) {
            encoderName = "hevc_nvenc";
        }

        if (hardware == HardwareEncoder::QuickSync) {
            encoderName = (config_.codec == VideoCodec::H265) ? "hevc_qsv" : "h264_qsv";
            hwType = AV_HWDEVICE_TYPE_QSV;
        } else if (hardware == HardwareEncoder::AMF) {
            encoderName = (config_.codec == VideoCodec::H265) ? "hevc_amf" : "h264_amf";
            hwType = AV_HWDEVICE_TYPE_D3D11VA;
        }
        setActiveEncoderName(encoderName);

        const AVCodec *codec = avcodec_find_encoder_by_name(encoderName);
        if (!codec) {
            return false;
        }

        codecCtx_ = avcodec_alloc_context3(codec);
        if (!codecCtx_) {
            return false;
        }

        codecCtx_->width = config_.width;
        codecCtx_->height = config_.height;
        codecCtx_->time_base = {1, config_.frameRate};
        codecCtx_->framerate = {config_.frameRate, 1};
        codecCtx_->bit_rate = config_.bitrate * 1000;
        codecCtx_->gop_size = config_.gopSize;
        codecCtx_->max_b_frames = config_.bFrames;

        useHardware_ = (hardware != HardwareEncoder::None);
        if (useHardware_) {
            if (av_hwdevice_ctx_create(&hwDeviceCtx_, hwType, nullptr, nullptr, 0) < 0) {
                return false;
            }
            codecCtx_->hw_device_ctx = av_buffer_ref(hwDeviceCtx_);
            codecCtx_->pix_fmt = (hwType == AV_HWDEVICE_TYPE_QSV) ? AV_PIX_FMT_QSV : AV_PIX_FMT_NV12;

            hwFrameCtx_ = av_hwframe_ctx_alloc(hwDeviceCtx_);
            if (!hwFrameCtx_) {
                return false;
            }
            auto *framesCtx = reinterpret_cast<AVHWFramesContext *>(hwFrameCtx_->data);
            framesCtx->format = codecCtx_->pix_fmt;
            framesCtx->sw_format = AV_PIX_FMT_NV12;
            framesCtx->width = config_.width;
            framesCtx->height = config_.height;
            framesCtx->initial_pool_size = 4;
            if (av_hwframe_ctx_init(hwFrameCtx_) < 0) {
                return false;
            }
            codecCtx_->hw_frames_ctx = av_buffer_ref(hwFrameCtx_);
        } else {
            codecCtx_->pix_fmt = AV_PIX_FMT_YUV420P;
        }

        if (avcodec_open2(codecCtx_, codec, nullptr) < 0) {
            return false;
        }

        frame_ = av_frame_alloc();
        frame_->format = useHardware_ ? AV_PIX_FMT_NV12 : AV_PIX_FMT_YUV420P;
        frame_->width = config_.width;
        frame_->height = config_.height;
        av_frame_get_buffer(frame_, 0);

        if (useHardware_) {
            hwFrame_ = av_frame_alloc();
            av_hwframe_get_buffer(codecCtx_->hw_frames_ctx, hwFrame_, 0);
        }

        packet_ = av_packet_alloc();
        initialized_ = true;
        activeCodec_.store(config_.codec, std::memory_order_relaxed);
        return true;
    }

    bool prepareFrame(const CapturedFrame &input) {
        if (input.format != CapturedFrame::Format::BGRA ||
            input.data.empty() ||
            input.width <= 0 ||
            input.height <= 0 ||
            input.stride < (input.width * 4)) {
            return false;
        }

        const int swsSrcW = std::max(1, config_.width);
        const int swsSrcH = std::max(1, config_.height);
        const size_t paddedSize = static_cast<size_t>(swsSrcW) * static_cast<size_t>(swsSrcH) * 4;
        if (aspectFitInputBuffer_.size() != paddedSize) {
            aspectFitInputBuffer_.resize(paddedSize);
        }
        blitBgraAspectFit(input.data.data(), input.width, input.height, input.stride,
                          aspectFitInputBuffer_.data(), swsSrcW, swsSrcH, swsSrcW * 4, config_);

        if (!swsCtx_ || lastWidth_ != swsSrcW || lastHeight_ != swsSrcH) {
            if (swsCtx_) {
                sws_freeContext(swsCtx_);
            }
            AVPixelFormat dstFmt = useHardware_ ? AV_PIX_FMT_NV12 : AV_PIX_FMT_YUV420P;
            swsCtx_ = sws_getContext(
                swsSrcW, swsSrcH, AV_PIX_FMT_BGRA,
                config_.width, config_.height, dstFmt,
                SWS_BILINEAR, nullptr, nullptr, nullptr);
            if (!swsCtx_) {
                return false;
            }
            lastWidth_ = swsSrcW;
            lastHeight_ = swsSrcH;
        }

        const uint8_t *srcSlice[1] = {aspectFitInputBuffer_.data()};
        int srcStride[1] = {swsSrcW * 4};
        sws_scale(swsCtx_, srcSlice, srcStride, 0, swsSrcH, frame_->data, frame_->linesize);
        frame_->pts = frameCount_++;
        if (forceKeyframe_) {
            frame_->pict_type = AV_PICTURE_TYPE_I;
            forceKeyframe_ = false;
        } else {
            frame_->pict_type = AV_PICTURE_TYPE_NONE;
        }

        if (useHardware_) {
            if (av_hwframe_transfer_data(hwFrame_, frame_, 0) < 0) {
                return false;
            }
            hwFrame_->pts = frame_->pts;
        }
        return true;
    }

    EncoderConfig config_{};
    std::mutex mutex_;
    AVCodecContext *codecCtx_ = nullptr;
    AVBufferRef *hwDeviceCtx_ = nullptr;
    AVBufferRef *hwFrameCtx_ = nullptr;
    SwsContext *swsCtx_ = nullptr;
    AVFrame *frame_ = nullptr;
    AVFrame *hwFrame_ = nullptr;
    AVPacket *packet_ = nullptr;
    bool initialized_ = false;
    std::atomic<bool> useHardware_{false};
    bool forceKeyframe_ = false;
    int64_t frameCount_ = 0;
    int lastWidth_ = 0;
    int lastHeight_ = 0;
    std::vector<uint8_t> aspectFitInputBuffer_;
    std::deque<std::pair<int64_t, int64_t>> pendingSourceTimestamps_;
    mutable std::mutex activeEncoderNameMutex_;
    std::string activeEncoderName_;
    std::atomic<VideoCodec> activeCodec_{VideoCodec::H264};
    std::atomic<EncodeFailureKind> lastEncodeFailureKind_{EncodeFailureKind::None};
};

#else

// Windows Media Foundation H264 encoder fallback
#ifdef _WIN32
using Microsoft::WRL::ComPtr;

class VideoEncoder::Impl {
  public:
    std::string activeEncoderName() const {
        std::lock_guard<std::mutex> lock(activeEncoderNameMutex_);
        return activeEncoderName_;
    }
    VideoCodec activeCodec() const { return activeCodec_.load(std::memory_order_relaxed); }
    std::string activeCodecName() const { return videoCodecName(activeCodec()); }
    std::string activeInputFormatName() const {
        if (usingExternalFfmpeg_) {
            if (externalInputIsGray_) {
                return "gray";
            }
            return externalInputIsNv12_ ? "NV12" : "BGRA";
        }
        return subtypeName(inputSubtype_);
    }
    bool isHardwareEncoder() const { return usingHardware_.load(std::memory_order_relaxed); }
    EncodeFailureKind lastEncodeFailureKind() const {
        return lastEncodeFailureKind_.load(std::memory_order_relaxed);
    }

    bool primeHandover(const CapturedFrame &frame) {
        if (handoverPrimingFrames_ != 8 || !usingExternalFfmpeg_ ||
            externalFramesSubmitted_ != 0 || config_.codec != VideoCodec::H264) return false;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        handoverFirstLivePacket_ = true;
        for (int i = 0; i < handoverPrimingFrames_; ++i) {
            for (;;) {
                if (std::chrono::steady_clock::now() >= deadline ||
                    WaitForSingleObject(externalProcess_, 0) == WAIT_OBJECT_0 ||
                    !prepareExternalInputFrame(frame)) return false;
                const auto result = enqueueExternalInputFrame(std::move(externalInputBuffer_),
                    std::numeric_limits<int64_t>::min());
                if (result == ExternalEnqueueResult::Queued) {
                    ++externalFramesSubmitted_;
                    break;
                }
                if (result != ExternalEnqueueResult::Backpressure) return false;
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
        }
        // Annex-B framing retains the last access unit until the next AUD.
        // All eight identities are marked discard, including that final unit.
        while (std::chrono::steady_clock::now() < deadline) {
            {
                std::lock_guard<std::mutex> lock(externalIoMutex_);
                EncodedPacket discarded;
                (void)popExternalPacket(discarded);
                if (externalWriterFailed_ || externalReaderFailed_) return false;
                if (externalFramesWritten_ == 8 && externalPacketCount_ > 0 && handoverPrefixKeyframeSeen_) {
                    spdlog::info("[FFmpegEncoder] Prepared handover prefix consumed; all 8 preparation frames excluded from live output");
                    return true;
                }
            }
            if (WaitForSingleObject(externalProcess_, 0) == WAIT_OBJECT_0) return false;
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        return false;
    }

    bool initialize(const EncoderConfig &config, bool prepareHandover = false) {
        config_ = config;
        handoverPrimingFrames_ = prepareHandover ? 8 : 0;
        handoverPrefixKeyframeSeen_ = false;
        handoverFirstLivePacket_ = false;
        spdlog::info("[VideoEncoder] Initializing MF encoder {}x{} @{}kbps", config.width, config.height, config.bitrate);
        frameCount_ = 0;
        lastInputTimestamp_ = 0;
        mfPendingSourceTimestamps_.clear();
        lastEncodeFailureKind_.store(EncodeFailureKind::None, std::memory_order_relaxed);
        activeCodec_.store(VideoCodec::H264, std::memory_order_relaxed);

        // Use the bundled QSV pipeline for explicit Intel selection: the Intel
        // asynchronous MFT can fail warmup in this synchronous MF pipeline.
        const bool requireExternalFfmpeg =
            config_.forceFfmpegNvenc || config_.codec != VideoCodec::H264 ||
            (config_.explicitEncoderSelection && config_.preferredHardware == HardwareEncoder::QuickSync);
        if (requireExternalFfmpeg && initializeExternalFfmpegNvenc()) {
            initialized_ = true;
            usingHardware_ = externalUsingHardware_;
            setActiveEncoderName(externalEncoderName_);
            activeCodec_.store(config_.codec, std::memory_order_relaxed);
            // Handover initialization validates a discarded real-frame prefix
            // before returning publicly. Other starts retain the probe/clean
            // process isolation contract.
            if (!prepareHandover && !runWarmupProbeAndPrepareLivePipeline()) {
                spdlog::warn("[VideoEncoder] FFmpeg warm-up probe failed");
                shutdownExternalFfmpegNvenc();
                initialized_ = false;
                usingHardware_ = false;
                setActiveEncoderName("");
                activeCodec_.store(VideoCodec::H264, std::memory_order_relaxed);
            } else {
                frameCount_ = 0;
            }
        }
        if (initialized_) {
            spdlog::info("[VideoEncoder] Using {} encoder: {} codec={}",
                         usingHardware_ ? "hardware" : "software",
                         activeEncoderName(),
                         videoCodecName(activeCodec()));
            return true;
        }
        if (requireExternalFfmpeg) {
            spdlog::error("[VideoEncoder] External FFmpeg pipeline is required for codec={} but initialization failed",
                          videoCodecName(config_.codec));
            return false;
        }

        if (!ensureComInitialized()) {
            return false;
        }

        HRESULT hr = MFStartup(MF_VERSION);
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] MFStartup failed hr=0x{:08x}", (unsigned)hr);
            releaseCom();
            return false;
        }
        mfStarted_ = true;

        const auto candidates = orderedEncoderCandidates();
        if (candidates.empty()) {
            spdlog::error("[VideoEncoder] No H264 encoder found");
            shutdownMf();
            releaseCom();
            return false;
        }

        HRESULT lastHr = E_FAIL;
        for (const auto &candidate : candidates) {
            resetCurrentTransform();
            shutdownCurrentActivation();
            spdlog::info("[VideoEncoder] Trying {} encoder: {}",
                         candidate.hardware ? "hardware" : "software", candidate.name);

            hr = candidate.activate->ActivateObject(IID_PPV_ARGS(transform_.ReleaseAndGetAddressOf()));
            if (FAILED(hr)) {
                lastHr = hr;
                spdlog::warn("[VideoEncoder] Failed to activate {} encoder '{}' hr=0x{:08x}",
                             candidate.hardware ? "hardware" : "software",
                             candidate.name,
                             static_cast<unsigned>(hr));
                continue;
            }
            activeActivation_ = candidate.activate;

            setActiveEncoderName(candidate.name);
            usingHardware_ = candidate.hardware;
            if (configureTransform()) {
                initialized_ = true;
                if (!runWarmupProbe()) {
                    spdlog::warn("[VideoEncoder] Encoder '{}' failed warm-up probe; trying next candidate", candidate.name);
                    initialized_ = false;
                    resetCurrentTransform();
                    continue;
                }

                // A hardware MFT may need several input samples before its
                // warm-up packet appears. A flush is not a sufficient reset
                // boundary for every vendor implementation: delayed probe
                // output can still arrive after the first live input. Dispose
                // the warmed transform and activate/configure a fresh instance
                // so the live source-identity queue starts with an empty codec.
                spdlog::info(
                    "[VideoEncoder] Replacing warmed Media Foundation encoder '{}' before live input",
                    candidate.name);
                const bool freshPipelineReady =
                    detail::prepareFreshMediaFoundationEncoderAfterWarmup({
                        [this]() {
                            initialized_ = false;
                            resetCurrentTransform();
                        },
                        [&]() {
                            if (!shutdownCurrentActivation()) {
                                lastHr = E_FAIL;
                                spdlog::warn(
                                    "[VideoEncoder] Refusing warmed encoder '{}' because Activate shutdown failed",
                                    candidate.name);
                                return false;
                            }
                            return true;
                        },
                        [&]() {
                            hr = candidate.activate->ActivateObject(
                                IID_PPV_ARGS(transform_.ReleaseAndGetAddressOf()));
                            if (FAILED(hr)) {
                                lastHr = hr;
                                spdlog::warn(
                                    "[VideoEncoder] Failed to reactivate clean encoder '{}' hr=0x{:08x}",
                                    candidate.name,
                                    static_cast<unsigned>(hr));
                                return false;
                            }
                            activeActivation_ = candidate.activate;
                            return true;
                        },
                        [&]() {
                            setActiveEncoderName(candidate.name);
                            usingHardware_ = candidate.hardware;
                            if (!configureTransform()) {
                                spdlog::warn(
                                    "[VideoEncoder] Clean encoder '{}' did not accept the configured media types",
                                    candidate.name);
                                lastHr = E_FAIL;
                                return false;
                            }
                            return true;
                        },
                        [this]() {
                            mfPendingSourceTimestamps_.clear();
                            pendingHaveOutputEvents_ = 0;
                            frameCount_ = 0;
                            lastInputTimestamp_ = 0;
                        },
                    });
                if (!freshPipelineReady) {
                    initialized_ = false;
                    resetCurrentTransform();
                    shutdownCurrentActivation();
                    continue;
                }
                initialized_ = true;

                if (!config_.forceFfmpegNvenc &&
                    config_.explicitEncoderSelection &&
                    config_.preferredHardware == HardwareEncoder::NVENC &&
                    !matchesPreferredHardware(activeEncoderName(), HardwareEncoder::NVENC)) {
                    spdlog::warn(
                        "[VideoEncoder] Requested NVENC but active encoder is '{}'; continuing with Media Foundation path",
                        activeEncoderName());
                }

                frameCount_ = 0;
                activeCodec_.store(VideoCodec::H264, std::memory_order_relaxed);
                spdlog::info("[VideoEncoder] Using {} encoder: {}",
                             usingHardware_ ? "hardware" : "software", activeEncoderName());
                return true;
            }

            spdlog::warn("[VideoEncoder] Encoder '{}' did not accept the configured media types; trying next candidate",
                         candidate.name);
            lastHr = E_FAIL;
        }

        spdlog::error("[VideoEncoder] Failed to initialize any encoder candidate (last hr=0x{:08x})",
                      static_cast<unsigned>(lastHr));
        resetCurrentTransform();
        shutdownCurrentActivation();
        setActiveEncoderName("");
        usingHardware_ = false;
        activeCodec_.store(VideoCodec::H264, std::memory_order_relaxed);
        shutdownMf();
        releaseCom();
        return false;
    }

    void shutdown() {
        shutdownExternalFfmpegNvenc();
        resetCurrentTransform();
        shutdownCurrentActivation();
        shutdownMf();
        releaseCom();
        initialized_ = false;
        usingHardware_ = false;
        setActiveEncoderName("");
        activeCodec_.store(VideoCodec::H264, std::memory_order_relaxed);
        frameCount_ = 0;
        lastInputTimestamp_ = 0;
        mfPendingSourceTimestamps_.clear();
        inputSubtype_ = MFVideoFormat_NV12;
    }

    bool encode(const CapturedFrame &input,
                EncodedPacket &output,
                int64_t sourceTimestamp) {
        lastEncodeFailureKind_.store(EncodeFailureKind::None, std::memory_order_relaxed);
        if (usingExternalFfmpeg_) {
            return encodeExternalFfmpegNvenc(input, output, sourceTimestamp);
        }

        if (!initialized_ || !transform_) {
            lastEncodeFailureKind_.store(EncodeFailureKind::InvalidInput, std::memory_order_relaxed);
            return false;
        }

        std::vector<uint8_t> &inputData = mfInputBuffer_;
        if (!prepareInputBuffer(input, inputData)) {
            return false;
        }

        // Create input sample
        ComPtr<IMFSample> inputSample;
        ComPtr<IMFMediaBuffer> inputBuffer;

        HRESULT hr = MFCreateMemoryBuffer(static_cast<DWORD>(inputData.size()), &inputBuffer);
        if (FAILED(hr)) return false;

        BYTE* bufferData = nullptr;
        hr = inputBuffer->Lock(&bufferData, nullptr, nullptr);
        if (FAILED(hr)) return false;

        std::memcpy(bufferData, inputData.data(), inputData.size());
        inputBuffer->Unlock();
        inputBuffer->SetCurrentLength(static_cast<DWORD>(inputData.size()));

        hr = MFCreateSample(&inputSample);
        if (FAILED(hr)) return false;

        inputSample->AddBuffer(inputBuffer.Get());

        const LONGLONG frameStep = std::max<LONGLONG>(1, 10000000LL / std::max(1, config_.frameRate));
        LONGLONG timestamp =
            (input.timestamp > 0) ? static_cast<LONGLONG>(input.timestamp)
                                  : (frameCount_ * frameStep);
        if (lastInputTimestamp_ > 0 && timestamp <= lastInputTimestamp_) {
            timestamp = lastInputTimestamp_ + frameStep;
        }

        LONGLONG sampleDuration = frameStep;
        if (lastInputTimestamp_ > 0) {
            const LONGLONG delta = timestamp - lastInputTimestamp_;
            if (delta > 0 && delta < 10000000LL) {
                sampleDuration = delta;
            }
        }

        inputSample->SetSampleTime(timestamp);
        inputSample->SetSampleDuration(sampleDuration);
        lastInputTimestamp_ = timestamp;

        // Preserve the capture identity exactly, including zero. The sample
        // time above may be sanitized for Media Foundation's transport clock,
        // but it must never replace the source identity used for alpha pairing.
        const int64_t submittedSourceTimestamp = sourceTimestamp;
        auto recordSubmittedSource = [&]() {
            mfPendingSourceTimestamps_.emplace_back(timestamp, submittedSourceTimestamp);
            while (mfPendingSourceTimestamps_.size() > 128) {
                mfPendingSourceTimestamps_.pop_front();
            }
        };
        auto takeSubmittedSource = [&](LONGLONG outputTimestamp) {
            const auto match = std::find_if(
                mfPendingSourceTimestamps_.begin(),
                mfPendingSourceTimestamps_.end(),
                [outputTimestamp](const auto &entry) {
                    return entry.first == outputTimestamp;
                });
            if (match == mfPendingSourceTimestamps_.end()) {
                return std::numeric_limits<int64_t>::min();
            }
            const int64_t sourceTimestamp = match->second;
            mfPendingSourceTimestamps_.erase(match);
            return sourceTimestamp;
        };

        auto pullOutput = [&](EncodedPacket &packet, bool &produced) -> HRESULT {
            produced = false;
            MFT_OUTPUT_DATA_BUFFER outputDataBuffer = {};
            DWORD status = 0;

            MFT_OUTPUT_STREAM_INFO streamInfo = {};
            HRESULT localHr = transform_->GetOutputStreamInfo(0, &streamInfo);

            static bool loggedStreamInfo = false;
            if (!loggedStreamInfo && SUCCEEDED(localHr)) {
                spdlog::info("[MFEncoder] Output stream info: flags=0x{:x}, cbSize={}",
                             streamInfo.dwFlags, streamInfo.cbSize);
                loggedStreamInfo = true;
            }

            ComPtr<IMFSample> outputSample;
            ComPtr<IMFMediaBuffer> outputBuffer;

            if (SUCCEEDED(localHr) && !(streamInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
                const DWORD bufferSize = (streamInfo.cbSize > 0) ? streamInfo.cbSize : (4 * 1024 * 1024);
                localHr = MFCreateMemoryBuffer(bufferSize, &outputBuffer);
                if (FAILED(localHr)) {
                    return localHr;
                }
                localHr = MFCreateSample(&outputSample);
                if (FAILED(localHr)) {
                    return localHr;
                }
                outputSample->AddBuffer(outputBuffer.Get());
                outputDataBuffer.pSample = outputSample.Get();
            }

            localHr = transform_->ProcessOutput(0, 1, &outputDataBuffer, &status);
            if (localHr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
                return localHr;
            }
            if (localHr == MF_E_TRANSFORM_STREAM_CHANGE) {
                spdlog::info("[MFEncoder] Stream format change, retrieving new output type");
                ComPtr<IMFMediaType> newOutputType;
                HRESULT hr2 = transform_->GetOutputAvailableType(0, 0, &newOutputType);
                if (SUCCEEDED(hr2)) {
                    hr2 = transform_->SetOutputType(0, newOutputType.Get(), 0);
                    if (SUCCEEDED(hr2)) {
                        spdlog::info("[MFEncoder] Successfully set new output type");
                    }
                }
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return localHr;
            }
            if (FAILED(localHr)) {
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return localHr;
            }

            ComPtr<IMFSample> resultSample = outputSample;
            if (outputDataBuffer.pSample && outputDataBuffer.pSample != outputSample.Get()) {
                resultSample.Attach(outputDataBuffer.pSample);
            }
            if (!resultSample) {
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return E_FAIL;
            }

            ComPtr<IMFMediaBuffer> encodedBuffer;
            localHr = resultSample->GetBufferByIndex(0, &encodedBuffer);
            if (FAILED(localHr) || !encodedBuffer) {
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return E_FAIL;
            }

            BYTE *encodedData = nullptr;
            DWORD encodedSize = 0;
            localHr = encodedBuffer->Lock(&encodedData, nullptr, &encodedSize);
            if (FAILED(localHr)) {
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return localHr;
            }

            packet.data.assign(encodedData, encodedData + encodedSize);
            const auto colorPacking = inputPackingFromSubtype(inputSubtype_);
            if (config_.codec == VideoCodec::H264 && !usingHardware_ &&
                (colorPacking == InputPacking::NV12 || colorPacking == InputPacking::I420 ||
                 colorPacking == InputPacking::YV12)) {
                detail::tagSoftwareH264Color(packet.data);
            }
            LONGLONG outTimestamp = timestamp;
            if (FAILED(resultSample->GetSampleTime(&outTimestamp))) {
                outTimestamp = mfPendingSourceTimestamps_.empty()
                    ? timestamp
                    : mfPendingSourceTimestamps_.front().first;
            }
            packet.pts = outTimestamp;
            packet.dts = outTimestamp;
            packet.sourceTimestamp = takeSubmittedSource(outTimestamp);
            packet.isKeyframe = detail::h264AccessUnitIsKeyframe(packet.data);

            static int nalLogCount = 0;
            for (DWORD i = 0; i + 4 < encodedSize; i++) {
                if ((encodedData[i] == 0 && encodedData[i+1] == 0 && encodedData[i+2] == 0 && encodedData[i+3] == 1) ||
                    (encodedData[i] == 0 && encodedData[i+1] == 0 && encodedData[i+2] == 1)) {
                    const int offset = (encodedData[i+2] == 1) ? 3 : 4;
                    const uint8_t nalType = encodedData[i + offset] & 0x1F;
                    if (nalLogCount < 40 && (nalType == 5 || nalType == 7 || nalType == 1)) {
                        spdlog::debug("[MFEncoder] NAL type {} at offset {} (frame {})", nalType, i, frameCount_);
                        nalLogCount++;
                    }
                }
            }
            packet.codec = activeCodec();

            encodedBuffer->Unlock();
            if (outputDataBuffer.pEvents) {
                outputDataBuffer.pEvents->Release();
            }
            produced = true;

            static bool firstEncoded = true;
            if (firstEncoded) {
                std::string hexDump;
                for (DWORD i = 0; i < std::min(encodedSize, DWORD(32)); i++) {
                    char buf[4];
                    snprintf(buf, sizeof(buf), "%02x ", encodedData[i]);
                    hexDump += buf;
                }
                spdlog::info("[MFEncoder] First frame encoded successfully, size={}", encodedSize);
                spdlog::info("[MFEncoder] First bytes: {}", hexDump);
                firstEncoded = false;
            }
            return S_OK;
        };

        if (asyncMft_) {
            pumpAsyncEvents();

            bool produced = false;
            bool havePrefetchedOutput = false;
            EncodedPacket prefetchedOutput;
            if (pendingHaveOutputEvents_ > 0) {
                EncodedPacket preInputPacket;
                hr = pullOutput(preInputPacket, produced);
                if (SUCCEEDED(hr) && produced) {
                    pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                    prefetchedOutput = std::move(preInputPacket);
                    havePrefetchedOutput = true;
                } else {
                    if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
                        pendingHaveOutputEvents_ = 0;
                    } else {
                        pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                    }
                    if (FAILED(hr) && hr != MF_E_TRANSFORM_STREAM_CHANGE) {
                        static int asyncOutputFailCount = 0;
                        if (++asyncOutputFailCount % 100 == 1) {
                            spdlog::warn("[MFEncoder] Async ProcessOutput failed hr=0x{:08x} (count={})",
                                         static_cast<unsigned>(hr), asyncOutputFailCount);
                        }
                    }
                }
            }

            if (pendingNeedInputEvents_ <= 0) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
                pumpAsyncEvents();
                if (pendingNeedInputEvents_ <= 0) {
                    if (havePrefetchedOutput) {
                        output = std::move(prefetchedOutput);
                        return true;
                    }
                    return false;
                }
            }

            hr = transform_->ProcessInput(0, inputSample.Get(), 0);
            if (hr == MF_E_NOTACCEPTING) {
                pendingNeedInputEvents_ = 0;
                pumpAsyncEvents();
                if (!havePrefetchedOutput && pendingHaveOutputEvents_ > 0) {
                    hr = pullOutput(output, produced);
                    if (SUCCEEDED(hr) && produced) {
                        pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                        return true;
                    }
                }
                if (havePrefetchedOutput) {
                    output = std::move(prefetchedOutput);
                    return true;
                }
                return false;
            }
            if (FAILED(hr)) {
                static int asyncInputFailCount = 0;
                if (++asyncInputFailCount % 100 == 1) {
                    spdlog::warn("[MFEncoder] Async ProcessInput failed hr=0x{:08x} (count={})",
                                 static_cast<unsigned>(hr), asyncInputFailCount);
                }
                if (havePrefetchedOutput) {
                    output = std::move(prefetchedOutput);
                    return true;
                }
                return false;
            }
            pendingNeedInputEvents_ = std::max(0, pendingNeedInputEvents_ - 1);
            recordSubmittedSource();
            frameCount_++;

            if (havePrefetchedOutput) {
                output = std::move(prefetchedOutput);
                return true;
            }

            pumpAsyncEvents();
            if (pendingHaveOutputEvents_ > 0) {
                hr = pullOutput(output, produced);
                if (SUCCEEDED(hr) && produced) {
                    pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                    return true;
                }
                if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
                    pendingHaveOutputEvents_ = 0;
                } else {
                    pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                }
            }
            return false;
        }

        hr = transform_->ProcessInput(0, inputSample.Get(), 0);
        if (hr == MF_E_NOTACCEPTING) {
            bool drained = false;
            const HRESULT drainHr = pullOutput(output, drained);
            if (SUCCEEDED(drainHr) && drained) {
                frameCount_++;
                return true;
            }
            hr = transform_->ProcessInput(0, inputSample.Get(), 0);
        }
        if (FAILED(hr)) {
            static int inputFailCount = 0;
            if (++inputFailCount % 100 == 1) {
                spdlog::warn("[MFEncoder] ProcessInput failed hr=0x{:08x} (count={})",
                             static_cast<unsigned>(hr), inputFailCount);
            }
            return false;
        }

        recordSubmittedSource();

        bool produced = false;
        hr = pullOutput(output, produced);
        if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
            frameCount_++;
            static int needMoreCount = 0;
            if (++needMoreCount % 100 == 1) {
                spdlog::info("[MFEncoder] Need more input (count={})", needMoreCount);
            }
            return false;
        }
        if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
            frameCount_++;
            return false;
        }
        if (FAILED(hr)) {
            static int outputFailCount = 0;
            if (++outputFailCount % 100 == 1) {
                spdlog::warn("[MFEncoder] ProcessOutput failed hr=0x{:08x} (count={})",
                             static_cast<unsigned>(hr), outputFailCount);
            }
            return false;
        }
        if (produced) {
            frameCount_++;
        }
        return produced;
    }

    void setBitrate(int kbps) {
        config_.bitrate = kbps;
        if (usingExternalFfmpeg_) {
            restartExternalFfmpegNvenc(true);
            return;
        }
        if (!codecApi_) {
            return;
        }
        setCodecApiUi4(CODECAPI_AVEncCommonMeanBitRate,
                       static_cast<ULONG>(std::max(1, kbps) * 1000),
                       "Updated mean bitrate (kbps):");
        const int maxKbps = std::max(config_.maxBitrate, kbps);
        setCodecApiUi4(CODECAPI_AVEncCommonMaxBitRate,
                       static_cast<ULONG>(std::max(1, maxKbps) * 1000),
                       "Updated max bitrate (kbps):");
    }

    void requestKeyframe() {
        if (usingExternalFfmpeg_) {
            externalForceKeyframeRequested_ = true;
            return;
        }
        if (!codecApi_) {
            spdlog::warn("[VideoEncoder] requestKeyframe: no ICodecAPI available");
            return;
        }
        VARIANT forceKeyframe;
        VariantInit(&forceKeyframe);
        forceKeyframe.vt = VT_UI4;
        forceKeyframe.ulVal = 1;  // Request keyframe
        HRESULT hr = codecApi_->SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &forceKeyframe);
        VariantClear(&forceKeyframe);
        if (SUCCEEDED(hr)) {
            spdlog::info("[VideoEncoder] Keyframe requested");
        } else {
            spdlog::warn("[VideoEncoder] Failed to request keyframe hr=0x{:08x}", (unsigned)hr);
        }
    }

    static std::string trimCopy(const std::string &value) {
        size_t begin = 0;
        while (begin < value.size() && std::isspace(static_cast<unsigned char>(value[begin])) != 0) {
            ++begin;
        }
        size_t end = value.size();
        while (end > begin && std::isspace(static_cast<unsigned char>(value[end - 1])) != 0) {
            --end;
        }
        return value.substr(begin, end - begin);
    }

    static std::wstring utf8ToWide(const std::string &value) {
        if (value.empty()) {
            return {};
        }
        int length = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
        UINT codePage = CP_UTF8;
        if (length <= 0) {
            codePage = CP_ACP;
            length = MultiByteToWideChar(codePage, 0, value.c_str(), -1, nullptr, 0);
        }
        if (length <= 0) {
            return {};
        }
        std::wstring result(static_cast<size_t>(length), L'\0');
        MultiByteToWideChar(codePage, 0, value.c_str(), -1, result.data(), length);
        if (!result.empty() && result.back() == L'\0') {
            result.pop_back();
        }
        return result;
    }

    static std::wstring quoteCommandArg(const std::wstring &arg) {
        if (arg.empty()) {
            return L"\"\"";
        }
        if (arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
            return arg;
        }
        std::wstring quoted;
        quoted.push_back(L'"');
        int backslashes = 0;
        for (wchar_t ch : arg) {
            if (ch == L'\\') {
                ++backslashes;
                continue;
            }
            if (ch == L'"') {
                quoted.append(static_cast<size_t>(backslashes * 2 + 1), L'\\');
                quoted.push_back(L'"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0) {
                quoted.append(static_cast<size_t>(backslashes), L'\\');
                backslashes = 0;
            }
            quoted.push_back(ch);
        }
        if (backslashes > 0) {
            quoted.append(static_cast<size_t>(backslashes * 2), L'\\');
        }
        quoted.push_back(L'"');
        return quoted;
    }

    static std::vector<std::string> splitCommandArgs(const std::string &value) {
        std::vector<std::string> args;
        std::string current;
        bool inQuotes = false;
        char quoteChar = '\0';
        for (char ch : value) {
            if (inQuotes) {
                if (ch == quoteChar) {
                    inQuotes = false;
                } else {
                    current.push_back(ch);
                }
                continue;
            }

            if (ch == '"' || ch == '\'') {
                inQuotes = true;
                quoteChar = ch;
                continue;
            }
            if (std::isspace(static_cast<unsigned char>(ch)) != 0) {
                if (!current.empty()) {
                    args.push_back(current);
                    current.clear();
                }
                continue;
            }
            current.push_back(ch);
        }
        if (!current.empty()) {
            args.push_back(current);
        }
        return args;
    }

    std::filesystem::path resolveExternalFfmpegPath() const {
        return resolveFfmpegPathImpl(config_.ffmpegPath);
    }

    bool initializeExternalFfmpegNvenc() {
        shutdownExternalFfmpegNvenc();
        externalFfmpegPath_ = resolveExternalFfmpegPath();
        if (externalFfmpegPath_.empty()) {
            spdlog::warn("[FFmpegEncoder] ffmpeg.exe not found (use bundled FFmpeg, --ffmpeg-path, or VERSUS_FFMPEG_PATH for development)");
            return false;
        }
        const FfmpegProbeInfo ffmpegInfo = probeFfmpegImpl(config_.ffmpegPath);
        if (ffmpegInfo.bundled && (ffmpegInfo.gplEnabled || ffmpegInfo.nonfreeEnabled)) {
            spdlog::warn("[FFmpegEncoder] Bundled FFmpeg has GPL/nonfree flags; refusing to use bundled binary");
            return false;
        }
        if (config_.codec == VideoCodec::VP9 && !ffmpegInfo.hasLibvpxVp9) {
            spdlog::warn("[FFmpegEncoder] VP9 requires FFmpeg with libvpx-vp9 encoder; resolved path='{}'",
                         externalFfmpegPath_.string());
            return false;
        }
        if (config_.codec == VideoCodec::VP8) {
            spdlog::warn("[FFmpegEncoder] Codec {} is not supported in current RTP transport path",
                         videoCodecName(config_.codec));
            return false;
        }

        const int width = std::max(1, config_.width);
        const int height = std::max(1, config_.height);
        const int frameRate = std::max(1, config_.frameRate);
        const int bitrate = std::max(250, config_.bitrate);
        // libvpx selects CBR only when minrate == maxrate == bitrate. Using
        // the general ceiling here silently selected VBR even at lower targets.
        const int maxBitrate = config_.codec == VideoCodec::VP9
            ? bitrate : std::max(bitrate, std::max(250, config_.maxBitrate));
        const int gop = config_.lowLatency
            ? std::max(1, std::min(std::max(1, config_.gopSize), frameRate))
            : std::max(1, config_.gopSize);
        const int bFrames = std::max(0, config_.bFrames);
        const int bufferSize = std::max(maxBitrate, bitrate) * 2;

        std::string encoderName;
        auto chooseEncoder = [&](const char *nvenc,
                                 const char *qsv,
                                 const char *amf,
                                 const char *software) {
            switch (config_.preferredHardware) {
                case HardwareEncoder::QuickSync:
                    encoderName = qsv;
                    break;
                case HardwareEncoder::AMF:
                    encoderName = amf;
                    break;
                case HardwareEncoder::None:
                    encoderName = software;
                    break;
                case HardwareEncoder::NVENC:
                default:
                    encoderName = nvenc;
                    break;
            }
        };
        switch (config_.codec) {
            case VideoCodec::H265:
                chooseEncoder("hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265");
                externalOutputFormat_ = ExternalOutputFormat::AnnexB;
                break;
            case VideoCodec::AV1:
                chooseEncoder("av1_nvenc", "av1_qsv", "av1_amf", "libaom-av1");
                externalOutputFormat_ = ExternalOutputFormat::Ivf;
                break;
            case VideoCodec::VP9:
                // VP9 is always software (libvpx-vp9); no hardware variant.
                encoderName = "libvpx-vp9";
                externalOutputFormat_ = ExternalOutputFormat::Ivf;
                break;
            case VideoCodec::H264:
            default:
                chooseEncoder("h264_nvenc", "h264_qsv", "h264_amf", "libx264");
                externalOutputFormat_ = ExternalOutputFormat::AnnexB;
                break;
        }
        externalUsingHardware_ = encoderName.find("_nvenc") != std::string::npos ||
                                 encoderName.find("_qsv") != std::string::npos ||
                                 encoderName.find("_amf") != std::string::npos;
        externalEncoderName_ = "FFmpeg " + encoderName;
        externalIvfHeaderParsed_ = false;
        externalInputIsNv12_ = true;
        externalInputIsGray_ = false;
        if (config_.codec == VideoCodec::AV1 && config_.enableAlpha && !externalUsingHardware_) {
            // Keep BGRA input for software AV1 alpha workflows.
            externalInputIsNv12_ = false;
        } else if (config_.codec == VideoCodec::VP9 && config_.enableAlpha) {
            // VP9 alpha encoder receives gray (Y-plane only) input representing the alpha channel.
            externalInputIsNv12_ = false;
            externalInputIsGray_ = true;
        }
        const char *inputPixelFormat = externalInputIsGray_ ? "gray" : (externalInputIsNv12_ ? "nv12" : "bgra");

        std::vector<std::string> args = {
            "-hide_banner",
            "-loglevel", "error",
            "-nostats",
            // Keep the frame consumed by rawvideo stream analysis. nobuffer
            // discards it, delaying startup until a second input arrives and
            // shifting the FIFO input-PTS/output-packet association by a frame.
            "-f", "rawvideo",
            "-pix_fmt", inputPixelFormat,
            "-video_size", std::to_string(width) + "x" + std::to_string(height),
            "-framerate", std::to_string(frameRate),
            "-i", "-",
            "-an",
            "-c:v", encoderName,
            "-b:v", std::to_string(bitrate) + "k",
            "-maxrate", std::to_string(maxBitrate) + "k",
            "-bufsize", std::to_string(bufferSize) + "k",
        };
        // VP9 uses -g 1 (all-keyframes) for sync-safe streaming; other codecs use GOP-based keyframes.
        if (config_.codec != VideoCodec::VP9) {
            args.push_back("-g");
            args.push_back(std::to_string(gop));
            args.push_back("-force_key_frames");
            // The first post-preparation input must start a new prediction
            // chain. Preparation frames are never sent to a receiver.
            args.push_back(handoverPrimingFrames_ > 0
                ? "expr:eq(n,8)+gte(t,n_forced*2.5)"
                : "expr:gte(t,n_forced*2.5)");
        }
        if (encoderName.find("_nvenc") != std::string::npos) {
            args.push_back("-preset");
            // The legacy llhq alias is not exposed by newer AV1 NVENC builds.
            // p4 plus the low-latency tune is the supported cross-codec equivalent.
            args.push_back("p4");
            args.push_back("-tune");
            args.push_back("ll");
            args.push_back("-zerolatency");
            args.push_back("1");
            // zeroReorderDelay does not disable FFmpeg's separate asynchronous
            // output queue. Avoid holding extra frames in low-latency H.264.
            if (config_.codec == VideoCodec::H264 && config_.lowLatency && bFrames == 0) {
                args.insert(args.end(), {"-delay", "0"});
            }
            args.push_back("-rc");
            args.push_back("cbr");
            args.push_back("-strict_gop");
            args.push_back("1");
            args.push_back("-rc-lookahead");
            args.push_back("0");
            args.push_back("-bf");
            args.push_back(std::to_string(bFrames));
            if (config_.codec == VideoCodec::H264 || config_.codec == VideoCodec::H265) {
                args.push_back("-forced-idr");
                args.push_back("1");
                args.push_back("-aud");
                args.push_back("1");
            }
        } else if (encoderName.find("_qsv") != std::string::npos) {
            // Raw elementary output is correlated with input PTS in FIFO order.
            // QSV permits B frames by default; reordering breaks that mapping.
            args.insert(args.end(), {"-bf", "0", "-async_depth", "1"});
            if (config_.codec == VideoCodec::H264 || config_.codec == VideoCodec::H265) {
                args.insert(args.end(), {"-forced_idr", "1"});
            }
        } else if (encoderName == "libx264") {
            args.push_back("-preset");
            args.push_back("veryfast");
            args.push_back("-tune");
            args.push_back("zerolatency");
        } else if (encoderName == "libx265") {
            args.push_back("-preset");
            args.push_back("fast");
            args.push_back("-tune");
            args.push_back("zerolatency");
        } else if (encoderName == "libaom-av1") {
            args.push_back("-cpu-used");
            args.push_back("6");
            args.push_back("-row-mt");
            args.push_back("1");
            args.push_back("-lag-in-frames");
            args.push_back("0");
        } else if (encoderName == "libvpx-vp9") {
            // Real-time low-latency VP9 settings.
            // Use all-keyframes so viewers can recover without relying on RTCP PLI handling.
            // Match minrate to bitrate and maxrate to select libvpx CBR.
            const int vp9Threads = recommendedRealtimeVp9Threads(width, height);
            spdlog::info("[FFmpegEncoder] libvpx-vp9 realtime threads={} row-mt=1 tile-columns=2 tile-rows=1 frame-parallel=1",
                         vp9Threads);
            args.push_back("-deadline");
            args.push_back("realtime");
            args.push_back("-cpu-used");
            args.push_back("8");
            args.push_back("-threads");
            args.push_back(std::to_string(vp9Threads));
            args.push_back("-lag-in-frames");
            args.push_back("0");
            args.push_back("-row-mt");
            args.push_back("1");
            args.push_back("-tile-columns");
            args.push_back("2");
            args.push_back("-tile-rows");
            args.push_back("1");
            args.push_back("-frame-parallel");
            args.push_back("1");
            if (!config_.requireEveryFrameKeyframe) {
                // Ordinary VP9 keeps the historical all-keyframe default, but
                // advanced users may override it below. Protected alpha mode
                // appends its non-overrideable contract after custom options.
                args.push_back("-g");
                args.push_back("1");
                args.push_back("-keyint_min");
                args.push_back("1");
            }
            args.push_back("-minrate");
            args.push_back(std::to_string(bitrate) + "k");
            // Every default VP9 frame is intra. libvpx's keyframe boost must
            // not repeatedly exceed the average per-frame CBR budget. This
            // limits the frame target, not the exact encoded packet size.
            args.push_back("-max-intra-rate");
            args.push_back("100");
        }

        if (config_.codec == VideoCodec::AV1) {
            if (config_.enableAlpha && !externalUsingHardware_) {
                args.push_back("-pix_fmt");
                args.push_back("yuva420p");
            } else {
                if (config_.enableAlpha && externalUsingHardware_) {
                    spdlog::warn("[FFmpegEncoder] Alpha workflow requested but AV1 hardware encoders do not preserve alpha");
                }
                args.push_back("-pix_fmt");
                args.push_back("yuv420p");
            }
        } else if (config_.codec == VideoCodec::VP9) {
            args.push_back("-pix_fmt");
            args.push_back("yuv420p");
            if (config_.enableAlpha) {
                // Alpha encoder: full color range so Y=0 maps to transparent and Y=255 to opaque.
                // FFmpeg expects the CLI token "pc" here rather than "full".
                args.push_back("-color_range");
                args.push_back("pc");
            }
        } else {
            args.push_back("-pix_fmt");
            args.push_back("nv12");
        }

        if (externalInputIsNv12_) {
            // convertBGRAtoNV12 produces limited-range BT.601 from SDR sRGB.
            // Untagged HD streams may be decoded as BT.709, shifting colors.
            args.insert(args.end(), {"-colorspace", "smpte170m",
                                     "-color_primaries", "bt709",
                                     "-color_trc", "iec61966-2-1",
                                     "-color_range", "tv"});
        }

        const auto extraArgs = splitCommandArgs(config_.ffmpegOptions);
        if (config_.codec == VideoCodec::VP9 && config_.requireEveryFrameKeyframe) {
            auto protectedOptions = detail::appendProtectedVp9Options(
                std::move(args),
                extraArgs);
            args = std::move(protectedOptions.args);
            for (const auto &rejected : protectedOptions.rejectedOptions) {
                spdlog::warn(
                    "[FFmpegEncoder] Ignoring VP9 option '{}' because dual-track alpha requires libvpx-vp9, zero lag, and every frame to be a keyframe",
                    rejected);
            }
        } else {
            args.insert(args.end(), extraArgs.begin(), extraArgs.end());
        }
        if (config_.codec == VideoCodec::H264) {
            args.push_back("-bsf:v");
            args.push_back("h264_metadata=aud=insert,dump_extra=freq=keyframe");
            args.push_back("-f");
            args.push_back("h264");
        } else if (config_.codec == VideoCodec::H265) {
            args.push_back("-bsf:v");
            args.push_back("hevc_metadata=aud=insert");
            args.push_back("-f");
            args.push_back("hevc");
        } else if (config_.codec == VideoCodec::AV1 || config_.codec == VideoCodec::VP9) {
            args.push_back("-f");
            args.push_back("ivf");
        }
        args.push_back("-");

        std::wstring command = quoteCommandArg(externalFfmpegPath_.wstring());
        for (const auto &arg : args) {
            command.push_back(L' ');
            command += quoteCommandArg(utf8ToWide(arg));
        }

        SECURITY_ATTRIBUTES sa = {};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;

        HANDLE childStdInRead = nullptr;
        HANDLE childStdInWrite = nullptr;
        HANDLE childStdOutRead = nullptr;
        HANDLE childStdOutWrite = nullptr;
        HANDLE childStdErrRead = nullptr;
        HANDLE childStdErrWrite = nullptr;
        HANDLE childStdErrFallback = nullptr;

        if (!CreatePipe(&childStdInRead, &childStdInWrite, &sa, 0) ||
            !SetHandleInformation(childStdInWrite, HANDLE_FLAG_INHERIT, 0)) {
            if (childStdInRead) CloseHandle(childStdInRead);
            if (childStdInWrite) CloseHandle(childStdInWrite);
            spdlog::warn("[FFmpegEncoder] Failed to create stdin pipe");
            return false;
        }

        if (!CreatePipe(&childStdOutRead, &childStdOutWrite, &sa, 0) ||
            !SetHandleInformation(childStdOutRead, HANDLE_FLAG_INHERIT, 0)) {
            CloseHandle(childStdInRead);
            CloseHandle(childStdInWrite);
            if (childStdOutRead) CloseHandle(childStdOutRead);
            if (childStdOutWrite) CloseHandle(childStdOutWrite);
            spdlog::warn("[FFmpegEncoder] Failed to create stdout pipe");
            return false;
        }

        if (!CreatePipe(&childStdErrRead, &childStdErrWrite, &sa, 0) ||
            !SetHandleInformation(childStdErrRead, HANDLE_FLAG_INHERIT, 0)) {
            if (childStdErrRead) CloseHandle(childStdErrRead);
            if (childStdErrWrite) CloseHandle(childStdErrWrite);
            childStdErrRead = nullptr;
            childStdErrWrite = nullptr;
            childStdErrFallback = CreateFileW(L"NUL",
                                              FILE_GENERIC_WRITE,
                                              FILE_SHARE_READ | FILE_SHARE_WRITE,
                                              &sa,
                                              OPEN_EXISTING,
                                              FILE_ATTRIBUTE_NORMAL,
                                              nullptr);
            if (childStdErrFallback == INVALID_HANDLE_VALUE) {
                childStdErrFallback = nullptr;
            }
            spdlog::warn("[FFmpegEncoder] Failed to create stderr pipe; FFmpeg stderr will not be captured");
        }

        STARTUPINFOW startupInfo = {};
        startupInfo.cb = sizeof(startupInfo);
        startupInfo.dwFlags = STARTF_USESTDHANDLES;
        startupInfo.hStdInput = childStdInRead;
        startupInfo.hStdOutput = childStdOutWrite;
        startupInfo.hStdError = childStdErrWrite ? childStdErrWrite : childStdErrFallback;

        PROCESS_INFORMATION processInfo = {};
        std::vector<wchar_t> mutableCommand(command.begin(), command.end());
        mutableCommand.push_back(L'\0');
        const BOOL spawned = CreateProcessW(
            externalFfmpegPath_.wstring().c_str(),
            mutableCommand.data(),
            nullptr,
            nullptr,
            TRUE,
            CREATE_NO_WINDOW,
            nullptr,
            nullptr,
            &startupInfo,
            &processInfo);

        CloseHandle(childStdInRead);
        CloseHandle(childStdOutWrite);
        if (childStdErrWrite) {
            CloseHandle(childStdErrWrite);
            childStdErrWrite = nullptr;
        }
        if (childStdErrFallback) {
            CloseHandle(childStdErrFallback);
            childStdErrFallback = nullptr;
        }

        if (!spawned) {
            CloseHandle(childStdInWrite);
            CloseHandle(childStdOutRead);
            if (childStdErrRead) {
                CloseHandle(childStdErrRead);
            }
            spdlog::warn("[FFmpegEncoder] CreateProcess failed for '{}'", externalFfmpegPath_.string());
            return false;
        }

        externalStdInWrite_ = childStdInWrite;
        externalStdOutRead_ = childStdOutRead;
        externalStdErrRead_ = childStdErrRead;
        externalProcess_ = processInfo.hProcess;
        externalThread_ = processInfo.hThread;
        externalFfmpegArgs_ = args;
        externalInputBuffer_.clear();
        externalFramesSubmitted_ = 0;
        externalPacketCount_ = 0;
        externalFirstPacketLogged_ = false;
        externalForceKeyframeRequested_ = false;
        externalIvfHeaderParsed_ = false;
        usingExternalFfmpeg_ = true;

        if (!startExternalIoWorkers()) {
            spdlog::warn("[FFmpegEncoder] Failed to start FFmpeg IO workers");
            shutdownExternalFfmpegNvenc();
            return false;
        }

        const DWORD waitResult = WaitForSingleObject(externalProcess_, 25);
        if (waitResult == WAIT_OBJECT_0) {
            DWORD exitCode = 0;
            GetExitCodeProcess(externalProcess_, &exitCode);
            spdlog::warn("[FFmpegEncoder] ffmpeg exited immediately (code={})", exitCode);
            shutdownExternalFfmpegNvenc();
            return false;
        }

        const char *loggedInputPixelFormat =
            externalInputIsGray_ ? "gray" : (externalInputIsNv12_ ? "nv12" : "bgra");
        spdlog::info("[FFmpegEncoder] Started FFmpeg pipeline: {} codec={} encoder={} input={}",
                     externalFfmpegPath_.string(),
                     videoCodecName(config_.codec),
                     encoderName,
                     loggedInputPixelFormat);
        return true;
    }

    void shutdownExternalFfmpegNvenc() {
        {
            std::lock_guard<std::mutex> lock(externalIoMutex_);
            externalIoStopRequested_ = true;
        }
        externalIoCv_.notify_all();

        HANDLE stdInWrite = nullptr;
        {
            std::lock_guard<std::mutex> lock(externalIoMutex_);
            stdInWrite = externalStdInWrite_;
            externalStdInWrite_ = nullptr;
        }
        if (stdInWrite) {
            CloseHandle(stdInWrite);
        }

        if (externalProcess_) {
            DWORD waitResult = WaitForSingleObject(externalProcess_, 1200);
            if (waitResult == WAIT_TIMEOUT) {
                TerminateProcess(externalProcess_, 1);
                WaitForSingleObject(externalProcess_, 500);
            }
        }

        HANDLE stdOutRead = nullptr;
        {
            std::lock_guard<std::mutex> lock(externalIoMutex_);
            stdOutRead = externalStdOutRead_;
            externalStdOutRead_ = nullptr;
        }
        if (stdOutRead) {
            CloseHandle(stdOutRead);
        }

        HANDLE stdErrRead = nullptr;
        {
            std::lock_guard<std::mutex> lock(externalIoMutex_);
            stdErrRead = externalStdErrRead_;
            externalStdErrRead_ = nullptr;
        }
        if (stdErrRead) {
            CloseHandle(stdErrRead);
        }

        if (externalWriterThread_.joinable()) {
            externalWriterThread_.join();
        }
        if (externalReaderThread_.joinable()) {
            externalReaderThread_.join();
        }
        if (externalStderrThread_.joinable()) {
            externalStderrThread_.join();
        }

        if (externalThread_) {
            CloseHandle(externalThread_);
            externalThread_ = nullptr;
        }
        if (externalProcess_) {
            CloseHandle(externalProcess_);
            externalProcess_ = nullptr;
        }

        externalOutputBuffer_.clear();
        externalInputBuffer_.clear();
        externalReusableInputBuffers_.clear();
        externalFfmpegArgs_.clear();
        externalFramesSubmitted_ = 0;
        externalPacketCount_ = 0;
        externalPendingOutputPts_.clear();
        externalFirstPacketLogged_ = false;
        externalForceKeyframeRequested_ = false;
        externalIvfHeaderParsed_ = false;
        externalInputIsNv12_ = true;
        externalInputIsGray_ = false;
        externalIoStopRequested_ = false;
        externalWriterFailed_ = false;
        externalReaderFailed_ = false;
        externalStdErrRead_ = nullptr;
        externalPendingInputBytes_ = 0;
        externalFramesWritten_ = 0;
        externalEncoderName_.clear();
        externalUsingHardware_ = false;
        usingExternalFfmpeg_ = false;
    }

    bool restartExternalFfmpegNvenc(bool runWarmup) {
        if (!usingExternalFfmpeg_) {
            return false;
        }
        spdlog::info("[FFmpegEncoder] Restarting FFmpeg pipeline");
        shutdownExternalFfmpegNvenc();
        if (!initializeExternalFfmpegNvenc()) {
            spdlog::warn("[FFmpegEncoder] Failed to restart FFmpeg pipeline");
            lastEncodeFailureKind_.store(EncodeFailureKind::ProcessExited, std::memory_order_relaxed);
            return false;
        }
        if (runWarmup && !runWarmupProbeAndPrepareLivePipeline()) {
            spdlog::warn("[FFmpegEncoder] Restarted FFmpeg pipeline failed warm-up probe");
            shutdownExternalFfmpegNvenc();
            lastEncodeFailureKind_.store(EncodeFailureKind::Timeout, std::memory_order_relaxed);
            return false;
        }
        lastEncodeFailureKind_.store(EncodeFailureKind::None, std::memory_order_relaxed);
        return true;
    }

    bool recoverExternalFfmpegNvenc() {
        if (externalWarmupInProgress_) {
            // Initialization owns fallback selection. Restarting with another
            // warm-up from inside the warm-up probe would recurse forever when
            // an encoder process cannot start on this machine.
            shutdownExternalFfmpegNvenc();
            return false;
        }
        return restartExternalFfmpegNvenc(true);
    }

    bool startExternalIoWorkers() {
        {
            std::lock_guard<std::mutex> lock(externalIoMutex_);
            externalIoStopRequested_ = false;
            externalWriterFailed_ = false;
            externalReaderFailed_ = false;
            externalInputQueue_.clear();
            externalReusableInputBuffers_.clear();
            externalPendingOutputPts_.clear();
            externalOutputBuffer_.clear();
            externalPendingInputBytes_ = 0;
            externalFramesWritten_ = 0;
        }

        try {
            externalWriterThread_ = std::thread([this]() { externalWriterLoop(); });
            externalReaderThread_ = std::thread([this]() { externalReaderLoop(); });
            if (externalStdErrRead_) {
                externalStderrThread_ = std::thread([this]() { externalStderrLoop(); });
            }
        } catch (const std::exception &e) {
            spdlog::warn("[FFmpegEncoder] Failed to start IO worker thread: {}", e.what());
            {
                std::lock_guard<std::mutex> lock(externalIoMutex_);
                externalIoStopRequested_ = true;
            }
            externalIoCv_.notify_all();
            if (externalWriterThread_.joinable()) {
                externalWriterThread_.join();
            }
            if (externalReaderThread_.joinable()) {
                externalReaderThread_.join();
            }
            if (externalStderrThread_.joinable()) {
                externalStderrThread_.join();
            }
            return false;
        } catch (...) {
            spdlog::warn("[FFmpegEncoder] Failed to start IO worker thread (unknown exception)");
            {
                std::lock_guard<std::mutex> lock(externalIoMutex_);
                externalIoStopRequested_ = true;
            }
            externalIoCv_.notify_all();
            if (externalWriterThread_.joinable()) {
                externalWriterThread_.join();
            }
            if (externalReaderThread_.joinable()) {
                externalReaderThread_.join();
            }
            if (externalStderrThread_.joinable()) {
                externalStderrThread_.join();
            }
            return false;
        }
        return true;
    }

    static void logFfmpegStderrLine(std::string line) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
            line.pop_back();
        }
        if (!line.empty()) {
            spdlog::warn("[FFmpegEncoder] stderr: {}", line);
        }
    }

    void externalWriterLoop() {
        for (;;) {
            std::vector<uint8_t> frame;
            {
                std::unique_lock<std::mutex> lock(externalIoMutex_);
                externalIoCv_.wait(lock, [this]() {
                    return externalIoStopRequested_ || !externalInputQueue_.empty();
                });
                if (externalIoStopRequested_) {
                    return;
                }
                if (externalInputQueue_.empty()) {
                    continue;
                }
                frame = std::move(externalInputQueue_.front());
                externalInputQueue_.pop_front();
                if (externalPendingInputBytes_ >= frame.size()) {
                    externalPendingInputBytes_ -= frame.size();
                } else {
                    externalPendingInputBytes_ = 0;
                }
                externalIoCv_.notify_all();
            }

            size_t offset = 0;
            while (offset < frame.size()) {
                HANDLE stdInHandle = nullptr;
                {
                    std::lock_guard<std::mutex> lock(externalIoMutex_);
                    if (externalIoStopRequested_) {
                        return;
                    }
                    stdInHandle = externalStdInWrite_;
                }

                if (!stdInHandle) {
                    std::lock_guard<std::mutex> lock(externalIoMutex_);
                    externalWriterFailed_ = true;
                    externalIoStopRequested_ = true;
                    externalIoCv_.notify_all();
                    return;
                }

                const DWORD chunkBytes = static_cast<DWORD>(std::min<size_t>(64 * 1024, frame.size() - offset));
                DWORD bytesWritten = 0;
                const BOOL writeOk = WriteFile(stdInHandle,
                                               frame.data() + offset,
                                               chunkBytes,
                                               &bytesWritten,
                                               nullptr);
                if (!writeOk || bytesWritten == 0) {
                    const DWORD err = GetLastError();
                    if (err != ERROR_BROKEN_PIPE && err != ERROR_NO_DATA && err != ERROR_INVALID_HANDLE) {
                        spdlog::warn("[FFmpegEncoder] FFmpeg writer thread failed to write frame chunk (err={})", err);
                    }
                    std::lock_guard<std::mutex> lock(externalIoMutex_);
                    externalWriterFailed_ = true;
                    externalIoStopRequested_ = true;
                    externalIoCv_.notify_all();
                    return;
                }
                offset += bytesWritten;
            }

            {
                std::lock_guard<std::mutex> lock(externalIoMutex_);
                externalFramesWritten_++;
                if (!externalIoStopRequested_ && externalReusableInputBuffers_.size() < 4) {
                    frame.clear();
                    externalReusableInputBuffers_.push_back(std::move(frame));
                }
            }
            externalIoCv_.notify_all();
        }
    }

    void externalReaderLoop() {
        std::array<uint8_t, 65536> chunk = {};
        for (;;) {
            HANDLE stdOutHandle = nullptr;
            {
                std::lock_guard<std::mutex> lock(externalIoMutex_);
                if (externalIoStopRequested_) {
                    return;
                }
                stdOutHandle = externalStdOutRead_;
            }

            if (!stdOutHandle) {
                return;
            }

            DWORD bytesRead = 0;
            const BOOL readOk = ReadFile(stdOutHandle, chunk.data(), static_cast<DWORD>(chunk.size()), &bytesRead, nullptr);
            if (!readOk || bytesRead == 0) {
                const DWORD err = GetLastError();
                if (err != ERROR_BROKEN_PIPE && err != ERROR_NO_DATA && err != ERROR_INVALID_HANDLE) {
                    std::lock_guard<std::mutex> lock(externalIoMutex_);
                    if (!externalIoStopRequested_) {
                        spdlog::warn("[FFmpegEncoder] FFmpeg reader thread failed to read output (err={})", err);
                        externalReaderFailed_ = true;
                        externalIoStopRequested_ = true;
                    }
                }
                externalIoCv_.notify_all();
                return;
            }

            {
                std::lock_guard<std::mutex> lock(externalIoMutex_);
                externalOutputBuffer_.insert(externalOutputBuffer_.end(), chunk.begin(), chunk.begin() + bytesRead);
            }
            externalIoCv_.notify_all();
        }
    }

    void externalStderrLoop() {
        std::array<char, 4096> chunk = {};
        std::string pending;
        for (;;) {
            HANDLE stdErrHandle = nullptr;
            {
                std::lock_guard<std::mutex> lock(externalIoMutex_);
                if (externalIoStopRequested_) {
                    break;
                }
                stdErrHandle = externalStdErrRead_;
            }

            if (!stdErrHandle) {
                break;
            }

            DWORD bytesRead = 0;
            const BOOL readOk = ReadFile(stdErrHandle, chunk.data(), static_cast<DWORD>(chunk.size()), &bytesRead, nullptr);
            if (!readOk || bytesRead == 0) {
                break;
            }

            pending.append(chunk.data(), bytesRead);
            size_t lineStart = 0;
            for (;;) {
                const size_t lineEnd = pending.find('\n', lineStart);
                if (lineEnd == std::string::npos) {
                    break;
                }
                logFfmpegStderrLine(pending.substr(lineStart, lineEnd - lineStart + 1));
                lineStart = lineEnd + 1;
            }
            if (lineStart > 0) {
                pending.erase(0, lineStart);
            }
            if (pending.size() > 8192) {
                logFfmpegStderrLine(pending);
                pending.clear();
            }
        }

        logFfmpegStderrLine(pending);
    }

    enum class ExternalEnqueueResult {
        Queued,
        InvalidInput,
        Backpressure,
        OutputStalled,
        IoFailure
    };

    ExternalEnqueueResult enqueueExternalInputFrame(std::vector<uint8_t> frame, int64_t timestamp) {
        constexpr size_t kMaxQueuedFrames = 3;
        constexpr size_t kMaxQueuedBytes = 64 * 1024 * 1024;

        if (frame.empty()) {
            return ExternalEnqueueResult::InvalidInput;
        }

        std::unique_lock<std::mutex> lock(externalIoMutex_);
        if (externalWriterFailed_ || externalReaderFailed_ || externalIoStopRequested_) {
            return ExternalEnqueueResult::IoFailure;
        }

        if (externalInputQueue_.size() >= kMaxQueuedFrames) {
            return ExternalEnqueueResult::Backpressure;
        }

        if (externalWriterFailed_ || externalReaderFailed_ || externalIoStopRequested_) {
            return ExternalEnqueueResult::IoFailure;
        }
        if ((externalPendingInputBytes_ + frame.size()) > kMaxQueuedBytes) {
            return ExternalEnqueueResult::Backpressure;
        }

        if (!externalPendingOutputPts_.tryPush(timestamp)) {
            return ExternalEnqueueResult::OutputStalled;
        }
        externalPendingInputBytes_ += frame.size();
        externalInputQueue_.push_back(std::move(frame));
        externalIoCv_.notify_all();
        return ExternalEnqueueResult::Queued;
    }

    void resizeExternalInputBuffer(size_t frameSize) {
        if (externalInputBuffer_.capacity() < frameSize) {
            std::lock_guard<std::mutex> lock(externalIoMutex_);
            auto best = externalReusableInputBuffers_.end();
            for (auto it = externalReusableInputBuffers_.begin(); it != externalReusableInputBuffers_.end(); ++it) {
                if (it->capacity() >= frameSize &&
                    (best == externalReusableInputBuffers_.end() || it->capacity() < best->capacity())) {
                    best = it;
                }
            }
            if (best != externalReusableInputBuffers_.end()) {
                externalInputBuffer_ = std::move(*best);
                externalReusableInputBuffers_.erase(best);
            }
        }
        externalInputBuffer_.resize(frameSize);
    }

    bool prepareExternalInputFrame(const CapturedFrame &input) {
        const int dstW = std::max(1, config_.width);
        const int dstH = std::max(1, config_.height);

        if (externalInputIsGray_) {
            // Gray (Y-plane only) for VP9 alpha encoder.
            if (input.format != CapturedFrame::Format::Gray) {
                spdlog::warn("[FFmpegEncoder] Expected Gray input for VP9 alpha encoder, got format {}",
                             static_cast<int>(input.format));
                return false;
            }
            if (input.data.empty() || input.width <= 0 || input.height <= 0) {
                return false;
            }
            const size_t frameSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH);
            resizeExternalInputBuffer(frameSize);
            if (input.width == dstW && input.height == dstH &&
                input.data.size() >= frameSize) {
                std::memcpy(externalInputBuffer_.data(), input.data.data(), frameSize);
            } else {
                // Nearest-neighbor scale for gray frame.
                const int srcStride = input.stride > 0 ? input.stride : input.width;
                for (int y = 0; y < dstH; ++y) {
                    const int srcY = (y * input.height) / dstH;
                    for (int x = 0; x < dstW; ++x) {
                        const int srcX = (x * input.width) / dstW;
                        const size_t srcIdx = static_cast<size_t>(srcY) * static_cast<size_t>(srcStride) +
                                             static_cast<size_t>(srcX);
                        const size_t dstIdx = static_cast<size_t>(y) * static_cast<size_t>(dstW) +
                                             static_cast<size_t>(x);
                        externalInputBuffer_[dstIdx] = srcIdx < input.data.size() ? input.data[srcIdx] : 0;
                    }
                }
            }
            return true;
        }

        if (input.format != CapturedFrame::Format::BGRA) {
            spdlog::warn("[FFmpegEncoder] Unsupported input pixel format {}", static_cast<int>(input.format));
            return false;
        }
        if (input.data.empty() || input.width <= 0 || input.height <= 0 || input.stride < (input.width * 4)) {
            return false;
        }

        if (externalInputIsNv12_) {
            const size_t frameSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH) * 3 / 2;
            resizeExternalInputBuffer(frameSize);
            convertBGRAtoNV12(input.data.data(),
                              input.width,
                              input.height,
                              input.stride,
                              externalInputBuffer_.data(),
                              dstW,
                              dstH);
            return true;
        }

        const size_t frameSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH) * 4;
        resizeExternalInputBuffer(frameSize);
        if (input.width == dstW &&
            input.height == dstH &&
            input.stride == dstW * 4 &&
            input.data.size() >= frameSize) {
            std::memcpy(externalInputBuffer_.data(), input.data.data(), frameSize);
            return true;
        }

        convertBGRAtoRGB32(input.data.data(),
                           input.width,
                           input.height,
                           input.stride,
                           externalInputBuffer_.data(),
                           dstW,
                           dstH);
        return true;
    }

    static size_t findAnnexBStartCode(const std::vector<uint8_t> &data, size_t from, size_t &prefixLength) {
        prefixLength = 0;
        if (data.size() < 4) {
            return std::string::npos;
        }
        for (size_t i = from; i + 3 < data.size(); ++i) {
            if (data[i] == 0 && data[i + 1] == 0) {
                if (data[i + 2] == 1) {
                    prefixLength = 3;
                    return i;
                }
                if (data[i + 2] == 0 && data[i + 3] == 1) {
                    prefixLength = 4;
                    return i;
                }
            }
        }
        return std::string::npos;
    }

    static uint8_t annexBNalType(const std::vector<uint8_t> &packet,
                                 size_t pos,
                                 size_t prefixLength,
                                 VideoCodec codec) {
        if (pos + prefixLength >= packet.size()) {
            return 0;
        }
        if (codec == VideoCodec::H265) {
            return static_cast<uint8_t>((packet[pos + prefixLength] >> 1) & 0x3F);
        }
        return static_cast<uint8_t>(packet[pos + prefixLength] & 0x1F);
    }

    static bool packetContainsKeyframe(const std::vector<uint8_t> &packet, VideoCodec codec) {
        if (codec == VideoCodec::H264) {
            return detail::h264AccessUnitIsKeyframe(
                packet,
                detail::H264BitstreamFormat::AnnexB);
        }
        size_t pos = 0;
        size_t prefixLength = 0;
        while ((pos = findAnnexBStartCode(packet, pos, prefixLength)) != std::string::npos) {
            if (pos + prefixLength >= packet.size()) {
                break;
            }
            const uint8_t nalType = annexBNalType(packet, pos, prefixLength, codec);
            if (codec == VideoCodec::H265) {
                if (nalType >= 16 && nalType <= 23) {
                    return true;
                }
            }
            pos += prefixLength;
        }
        return false;
    }

    static bool packetContainsVcl(const std::vector<uint8_t> &packet, VideoCodec codec) {
        size_t pos = 0;
        size_t prefixLength = 0;
        while ((pos = findAnnexBStartCode(packet, pos, prefixLength)) != std::string::npos) {
            if (pos + prefixLength >= packet.size()) {
                break;
            }
            const uint8_t nalType = annexBNalType(packet, pos, prefixLength, codec);
            if (codec == VideoCodec::H265) {
                if (nalType <= 31) {
                    return true;
                }
            } else {
                if (nalType == 1 || nalType == 5) {
                    return true;
                }
            }
            pos += prefixLength;
        }
        return false;
    }

    static bool isAnnexBAud(VideoCodec codec, uint8_t nalType) {
        if (codec == VideoCodec::H265) {
            return nalType == 35;
        }
        return nalType == 9;
    }

    bool popExternalAnnexBPacket(EncodedPacket &output) {
        while (!externalOutputBuffer_.empty()) {
            size_t firstAud = std::string::npos;
            size_t secondAud = std::string::npos;
            size_t pos = 0;
            size_t prefixLength = 0;
            while ((pos = findAnnexBStartCode(externalOutputBuffer_, pos, prefixLength)) != std::string::npos) {
                if (pos + prefixLength >= externalOutputBuffer_.size()) {
                    break;
                }
                const uint8_t nalType = annexBNalType(externalOutputBuffer_, pos, prefixLength, config_.codec);
                if (isAnnexBAud(config_.codec, nalType)) {
                    if (firstAud == std::string::npos) {
                        firstAud = pos;
                    } else {
                        secondAud = pos;
                        break;
                    }
                }
                pos += prefixLength;
            }

            size_t packetEnd = std::string::npos;
            if (secondAud != std::string::npos) {
                packetEnd = secondAud;
            } else if (firstAud == std::string::npos && externalOutputBuffer_.size() >= 4096) {
                // Fallback path for builds that do not emit AUD NAL units.
                packetEnd = externalOutputBuffer_.size();
            } else {
                return false;
            }

            if (packetEnd == 0 || packetEnd > externalOutputBuffer_.size()) {
                return false;
            }

            std::vector<uint8_t> candidate(externalOutputBuffer_.begin(),
                                           externalOutputBuffer_.begin() + packetEnd);
            externalOutputBuffer_.erase(externalOutputBuffer_.begin(), externalOutputBuffer_.begin() + packetEnd);
            if (candidate.empty()) {
                continue;
            }

            if (!packetContainsVcl(candidate, config_.codec)) {
                continue;
            }

            output.data = std::move(candidate);
            int64_t pts = 0;
            int64_t sourceTimestamp = std::numeric_limits<int64_t>::min();
            if (externalPendingOutputPts_.tryPop(pts)) {
                sourceTimestamp = pts;
            } else {
                pts = (externalPacketCount_ * 10000000LL) / std::max(1, config_.frameRate);
            }
            output.pts = pts;
            output.dts = pts;
            output.sourceTimestamp = sourceTimestamp;
            output.codec = config_.codec;
            output.isKeyframe = packetContainsKeyframe(output.data, config_.codec);
            externalPacketCount_++;

            if (!externalFirstPacketLogged_) {
                spdlog::info("[FFmpegEncoder] First packet encoded successfully, size={}", output.data.size());
                externalFirstPacketLogged_ = true;
            }
            return true;
        }
        return false;
    }

    static uint32_t readLe32(const uint8_t *data) {
        return static_cast<uint32_t>(data[0]) |
               (static_cast<uint32_t>(data[1]) << 8) |
               (static_cast<uint32_t>(data[2]) << 16) |
               (static_cast<uint32_t>(data[3]) << 24);
    }

    bool popExternalIvfPacket(EncodedPacket &output) {
        if (!externalIvfHeaderParsed_) {
            if (externalOutputBuffer_.size() < 32) {
                return false;
            }
            if (!(externalOutputBuffer_[0] == 'D' &&
                  externalOutputBuffer_[1] == 'K' &&
                  externalOutputBuffer_[2] == 'I' &&
                  externalOutputBuffer_[3] == 'F')) {
                spdlog::warn("[FFmpegEncoder] Unexpected IVF stream header");
                return false;
            }
            externalOutputBuffer_.erase(externalOutputBuffer_.begin(), externalOutputBuffer_.begin() + 32);
            externalIvfHeaderParsed_ = true;
        }

        if (externalOutputBuffer_.size() < 12) {
            return false;
        }
        const uint32_t frameSize = readLe32(externalOutputBuffer_.data());
        if (frameSize == 0) {
            externalOutputBuffer_.erase(externalOutputBuffer_.begin(), externalOutputBuffer_.begin() + 12);
            return false;
        }
        if (externalOutputBuffer_.size() < static_cast<size_t>(12 + frameSize)) {
            return false;
        }

        output.data.assign(externalOutputBuffer_.begin() + 12,
                           externalOutputBuffer_.begin() + 12 + frameSize);
        externalOutputBuffer_.erase(externalOutputBuffer_.begin(),
                                    externalOutputBuffer_.begin() + 12 + frameSize);
        int64_t queuedSourceTimestamp = 0;
        if (externalPendingOutputPts_.tryPop(queuedSourceTimestamp)) {
            output.pts = queuedSourceTimestamp;
            output.sourceTimestamp = output.pts;
        } else {
            output.pts = (externalPacketCount_ * 10000000LL) / std::max(1, config_.frameRate);
            output.sourceTimestamp = std::numeric_limits<int64_t>::min();
        }
        output.dts = output.pts;
        output.codec = config_.codec;
        // Derive the flag from the encoded IVF payload. Configuration intent is
        // not proof that a packet is independently decodable.
        output.isKeyframe = detail::ivfFrameIsKeyframe(config_.codec, output.data);
        externalPacketCount_++;

        if (!externalFirstPacketLogged_) {
            spdlog::info("[FFmpegEncoder] First packet encoded successfully, size={}", output.data.size());
            externalFirstPacketLogged_ = true;
        }
        return true;
    }

    bool popExternalPacket(EncodedPacket &output) {
        if (handoverPrimingFrames_ > 0 && !externalWarmupInProgress_) {
            while (popExternalAnnexBPacket(output)) {
                if (output.sourceTimestamp == std::numeric_limits<int64_t>::min()) {
                    handoverPrefixKeyframeSeen_ = handoverPrefixKeyframeSeen_ || output.isKeyframe;
                    output = {};
                    continue;
                }
                if (handoverFirstLivePacket_) {
                    if (!output.isKeyframe) {
                        spdlog::error("[FFmpegEncoder] Refusing non-keyframe at prepared handover boundary");
                        output = {};
                        continue;
                    }
                    handoverFirstLivePacket_ = false;
                    spdlog::info("[FFmpegEncoder] Prepared handover first live keyframe source={}", output.sourceTimestamp);
                }
                return true;
            }
            return false;
        }
        if (externalOutputFormat_ == ExternalOutputFormat::Ivf) {
            return popExternalIvfPacket(output);
        }
        return popExternalAnnexBPacket(output);
    }

    bool encodeExternalFfmpegNvenc(const CapturedFrame &input,
                                   EncodedPacket &output,
                                   int64_t sourceTimestamp) {
        if (!usingExternalFfmpeg_ || !externalStdInWrite_ || !externalStdOutRead_ || !externalProcess_) {
            lastEncodeFailureKind_.store(EncodeFailureKind::ProcessExited, std::memory_order_relaxed);
            return false;
        }

        if (externalForceKeyframeRequested_) {
            externalForceKeyframeRequested_ = false;
            recoverExternalFfmpegNvenc();
            if (!usingExternalFfmpeg_) {
                lastEncodeFailureKind_.store(EncodeFailureKind::ProcessExited, std::memory_order_relaxed);
                return false;
            }
        }

        if (WaitForSingleObject(externalProcess_, 0) == WAIT_OBJECT_0) {
            DWORD exitCode = 0;
            GetExitCodeProcess(externalProcess_, &exitCode);
            spdlog::warn("[FFmpegEncoder] ffmpeg process exited unexpectedly (code={})", exitCode);
            lastEncodeFailureKind_.store(EncodeFailureKind::ProcessExited, std::memory_order_relaxed);
            if (!recoverExternalFfmpegNvenc()) {
                spdlog::error("[FFmpegEncoder] Failed to recover FFmpeg after unexpected process exit");
            }
            lastEncodeFailureKind_.store(EncodeFailureKind::ProcessExited, std::memory_order_relaxed);
            return false;
        }

        if (!prepareExternalInputFrame(input)) {
            lastEncodeFailureKind_.store(EncodeFailureKind::InvalidInput, std::memory_order_relaxed);
            return false;
        }

        const ExternalEnqueueResult enqueueResult =
            enqueueExternalInputFrame(std::move(externalInputBuffer_), sourceTimestamp);
        if (enqueueResult != ExternalEnqueueResult::Queued) {
            if (enqueueResult == ExternalEnqueueResult::IoFailure) {
                spdlog::warn("[FFmpegEncoder] FFmpeg IO worker rejected input; restarting pipeline");
                lastEncodeFailureKind_.store(EncodeFailureKind::IoFailure, std::memory_order_relaxed);
                if (recoverExternalFfmpegNvenc()) {
                    lastEncodeFailureKind_.store(
                        EncodeFailureKind::IoFailure,
                        std::memory_order_relaxed);
                }
            } else if (enqueueResult == ExternalEnqueueResult::OutputStalled) {
                spdlog::warn(
                    "[FFmpegEncoder] FFmpeg accepted input without producing output; restarting the bounded identity pipeline");
                lastEncodeFailureKind_.store(
                    EncodeFailureKind::OutputStalled,
                    std::memory_order_relaxed);
                if (recoverExternalFfmpegNvenc()) {
                    // restartExternalFfmpegNvenc() clears its own transient
                    // status on success. Preserve the rejection observed by
                    // this encode call so callers can distinguish the bounded
                    // stall from an ordinary no-output-yet timeout.
                    lastEncodeFailureKind_.store(
                        EncodeFailureKind::OutputStalled,
                        std::memory_order_relaxed);
                }
            } else if (enqueueResult == ExternalEnqueueResult::Backpressure) {
                spdlog::warn("[FFmpegEncoder] FFmpeg input queue is full; skipping frame while encoder catches up");
                lastEncodeFailureKind_.store(EncodeFailureKind::Backpressure, std::memory_order_relaxed);
            } else {
                lastEncodeFailureKind_.store(EncodeFailureKind::InvalidInput, std::memory_order_relaxed);
            }
            return false;
        }
        externalFramesSubmitted_++;

        int waitBudgetMs = std::max(10, (3000 / std::max(1, config_.frameRate)));
        // The first live access unit needs the following frame's AUD to close
        // it. Preparation has already proved this process healthy: waiting
        // here only delays admission of that next fresh input.
        if (handoverFirstLivePacket_) waitBudgetMs = 0;
        if (config_.codec == VideoCodec::VP9) {
            waitBudgetMs = std::max(waitBudgetMs, std::max(100, (6000 / std::max(1, config_.frameRate))));
            if (!externalFirstPacketLogged_) {
                waitBudgetMs = std::max(waitBudgetMs, 500);
            }
        }
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(waitBudgetMs);
        while (std::chrono::steady_clock::now() < deadline) {
            size_t observedOutputBytes = 0;
            {
                std::lock_guard<std::mutex> lock(externalIoMutex_);
                if (popExternalPacket(output)) {
                    return true;
                }
                if (externalWriterFailed_ || externalReaderFailed_) {
                    break;
                }
                observedOutputBytes = externalOutputBuffer_.size();
            }

            if (WaitForSingleObject(externalProcess_, 0) == WAIT_OBJECT_0) {
                break;
            }

            std::unique_lock<std::mutex> lock(externalIoMutex_);
            externalIoCv_.wait_for(lock, std::chrono::milliseconds(2), [this, observedOutputBytes]() {
                return externalOutputBuffer_.size() != observedOutputBytes || externalWriterFailed_ || externalReaderFailed_;
            });
        }

        bool ioWorkerFailed = false;
        {
            std::lock_guard<std::mutex> lock(externalIoMutex_);
            if (popExternalPacket(output)) {
                return true;
            }
            if (externalWriterFailed_ || externalReaderFailed_) {
                ioWorkerFailed = true;
            }
        }
        if (ioWorkerFailed) {
            spdlog::warn("[FFmpegEncoder] FFmpeg IO worker failure detected; restarting pipeline");
            lastEncodeFailureKind_.store(EncodeFailureKind::IoFailure, std::memory_order_relaxed);
            if (recoverExternalFfmpegNvenc()) {
                lastEncodeFailureKind_.store(
                    EncodeFailureKind::IoFailure,
                    std::memory_order_relaxed);
            }
            return false;
        }

        if (WaitForSingleObject(externalProcess_, 0) == WAIT_OBJECT_0) {
            DWORD exitCode = 0;
            GetExitCodeProcess(externalProcess_, &exitCode);
            spdlog::warn("[FFmpegEncoder] ffmpeg process exited during encode wait (code={})", exitCode);
            lastEncodeFailureKind_.store(EncodeFailureKind::ProcessExited, std::memory_order_relaxed);
            if (!recoverExternalFfmpegNvenc()) {
                spdlog::error("[FFmpegEncoder] Failed to recover FFmpeg after encode-wait process exit");
            }
            lastEncodeFailureKind_.store(EncodeFailureKind::ProcessExited, std::memory_order_relaxed);
            return false;
        }

        lastEncodeFailureKind_.store(EncodeFailureKind::Timeout, std::memory_order_relaxed);
        return false;
    }

  private:
    void setActiveEncoderName(std::string name) {
        std::lock_guard<std::mutex> lock(activeEncoderNameMutex_);
        activeEncoderName_ = std::move(name);
    }

    struct EncoderCandidate {
        ComPtr<IMFActivate> activate;
        std::string name;
        bool hardware = false;
    };

    enum class InputPacking {
        NV12,
        I420,
        YV12,
        RGB32,
        Unsupported
    };

    enum class MfInputPreference {
        Auto,
        NV12,
        RGB32
    };

    enum class ExternalOutputFormat {
        AnnexB,
        Ivf
    };

    static std::string toLowerCopy(std::string value) {
        std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        return value;
    }

    static std::string subtypeName(const GUID &subtype) {
        if (subtype == MFVideoFormat_NV12) return "NV12";
        if (subtype == MFVideoFormat_IYUV) return "IYUV";
        if (subtype == MFVideoFormat_YV12) return "YV12";
        if (subtype == MFVideoFormat_YUY2) return "YUY2";
        if (subtype == MFVideoFormat_UYVY) return "UYVY";
        if (subtype == MFVideoFormat_RGB32) return "RGB32";
        if (subtype == MFVideoFormat_ARGB32) return "ARGB32";
        char buffer[64];
        std::snprintf(buffer, sizeof(buffer), "{%08lx-%04x-%04x}",
                      static_cast<unsigned long>(subtype.Data1),
                      subtype.Data2,
                      subtype.Data3);
        return buffer;
    }

    static int inputPriority(const GUID &subtype, bool preferRgb32) {
        if (preferRgb32) {
            if (subtype == MFVideoFormat_ARGB32 || subtype == MFVideoFormat_RGB32) return 0;
            if (subtype == MFVideoFormat_NV12) return 1;
            if (subtype == MFVideoFormat_IYUV) return 2;
            if (subtype == MFVideoFormat_YV12) return 3;
            return 100;
        }
        if (subtype == MFVideoFormat_NV12) return 0;
        if (subtype == MFVideoFormat_IYUV) return 1;
        if (subtype == MFVideoFormat_YV12) return 2;
        if (subtype == MFVideoFormat_ARGB32 || subtype == MFVideoFormat_RGB32) return 3;
        if (subtype == MFVideoFormat_YUY2 || subtype == MFVideoFormat_UYVY) return 4;
        return 100;
    }

    static MfInputPreference mfInputPreferenceOverride() {
        const char *raw = std::getenv("GAME_CAPTURE_MF_INPUT");
        if (!raw || !*raw) {
            return MfInputPreference::Auto;
        }

        const std::string value = toLowerCopy(raw);
        if (value == "nv12") {
            return MfInputPreference::NV12;
        }
        if (value == "rgb" || value == "rgb32" || value == "argb" || value == "argb32") {
            return MfInputPreference::RGB32;
        }
        return MfInputPreference::Auto;
    }

    static const char *mfInputPreferenceName(MfInputPreference preference) {
        switch (preference) {
            case MfInputPreference::NV12:
                return "NV12";
            case MfInputPreference::RGB32:
                return "RGB32";
            case MfInputPreference::Auto:
            default:
                return "auto";
        }
    }

    static InputPacking inputPackingFromSubtype(const GUID &subtype) {
        if (subtype == MFVideoFormat_NV12) return InputPacking::NV12;
        if (subtype == MFVideoFormat_IYUV) return InputPacking::I420;
        if (subtype == MFVideoFormat_YV12) return InputPacking::YV12;
        if (subtype == MFVideoFormat_ARGB32 || subtype == MFVideoFormat_RGB32) return InputPacking::RGB32;
        return InputPacking::Unsupported;
    }

    bool shouldPreferRgbInput() const {
        if (!usingHardware_) {
            return false;
        }
        const std::string encoderLower = toLowerCopy(activeEncoderName());
        const bool intelLike = encoderLower.find("intel") != std::string::npos ||
                               encoderLower.find("quick sync") != std::string::npos ||
                               encoderLower.find("qsv") != std::string::npos;
        if (intelLike) {
            return true;
        }

        const bool nvidiaLike = encoderLower.find("nvidia") != std::string::npos ||
                                encoderLower.find("nvenc") != std::string::npos ||
                                encoderLower.find("geforce") != std::string::npos;
        if (nvidiaLike) {
            // Avoid a CPU BGRA->NV12 conversion on the 1080p60 hot path when
            // NVIDIA's MFT accepts ARGB32 directly.
            return true;
        }

        return false;
    }

    DWORD sampleSizeForSubtype(const GUID &subtype) const {
        const DWORD width = static_cast<DWORD>(std::max(1, config_.width));
        const DWORD height = static_cast<DWORD>(std::max(1, config_.height));
        if (subtype == MFVideoFormat_NV12 || subtype == MFVideoFormat_IYUV || subtype == MFVideoFormat_YV12) {
            return width * height * 3 / 2;
        }
        if (subtype == MFVideoFormat_ARGB32 || subtype == MFVideoFormat_RGB32) {
            return width * height * 4;
        }
        return width * height * 3 / 2;
    }

    void setCommonFrameAttributes(IMFMediaType *type) {
        if (!type) {
            return;
        }
        MFSetAttributeSize(type, MF_MT_FRAME_SIZE, std::max(1, config_.width), std::max(1, config_.height));
        MFSetAttributeRatio(type, MF_MT_FRAME_RATE, std::max(1, config_.frameRate), 1);
        MFSetAttributeRatio(type, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    }

    void configureOutputType(IMFMediaType *type) {
        if (!type) {
            return;
        }
        type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        setCommonFrameAttributes(type);
        type->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(std::max(1, config_.bitrate) * 1000));
        if (!usingHardware_) {
            type->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base);
        }
    }

    void configureInputType(IMFMediaType *type, const GUID &subtype) {
        if (!type) {
            return;
        }
        type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        type->SetGUID(MF_MT_SUBTYPE, subtype);
        setCommonFrameAttributes(type);
        type->SetUINT32(MF_MT_SAMPLE_SIZE, sampleSizeForSubtype(subtype));
        type->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
        type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);

        LONG stride = 0;
        if (SUCCEEDED(MFGetStrideForBitmapInfoHeader(subtype.Data1, std::max(1, config_.width), &stride))) {
            type->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(stride));
        }
    }

    bool chooseOutputType(ComPtr<IMFMediaType> &outType) {
        HRESULT hr = S_OK;
        for (DWORD i = 0; i < 64; ++i) {
            ComPtr<IMFMediaType> available;
            hr = transform_->GetOutputAvailableType(0, i, &available);
            if (hr == MF_E_NO_MORE_TYPES) {
                break;
            }
            if (FAILED(hr) || !available) {
                continue;
            }

            GUID subtype = {};
            if (FAILED(available->GetGUID(MF_MT_SUBTYPE, &subtype)) || subtype != MFVideoFormat_H264) {
                continue;
            }

            ComPtr<IMFMediaType> candidate;
            if (FAILED(MFCreateMediaType(&candidate))) {
                continue;
            }
            available->CopyAllItems(candidate.Get());
            configureOutputType(candidate.Get());

            hr = transform_->SetOutputType(0, candidate.Get(), MFT_SET_TYPE_TEST_ONLY);
            if (SUCCEEDED(hr)) {
                outType = candidate;
                spdlog::info("[VideoEncoder] Using output type index {} subtype={}", i, subtypeName(subtype));
                return true;
            }
        }

        ComPtr<IMFMediaType> fallback;
        if (FAILED(MFCreateMediaType(&fallback))) {
            return false;
        }
        configureOutputType(fallback.Get());
        hr = transform_->SetOutputType(0, fallback.Get(), MFT_SET_TYPE_TEST_ONLY);
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] No compatible H264 output type (hr=0x{:08x})", static_cast<unsigned>(hr));
            return false;
        }
        outType = fallback;
        return true;
    }

    bool chooseInputType(ComPtr<IMFMediaType> &outType, GUID &outSubtype) {
        HRESULT hr = S_OK;
        int bestPriority = 999;
        const MfInputPreference inputPreference = mfInputPreferenceOverride();
        const bool preferRgb32 = inputPreference == MfInputPreference::RGB32 ||
                                 (inputPreference == MfInputPreference::Auto && shouldPreferRgbInput());
        if (inputPreference != MfInputPreference::Auto) {
            spdlog::info("[VideoEncoder] MF input preference override: {}",
                         mfInputPreferenceName(inputPreference));
        }

        for (DWORD i = 0; i < 64; ++i) {
            ComPtr<IMFMediaType> available;
            hr = transform_->GetInputAvailableType(0, i, &available);
            if (hr == MF_E_NO_MORE_TYPES) {
                break;
            }
            if (FAILED(hr)) {
                spdlog::warn("[VideoEncoder] GetInputAvailableType {} failed hr=0x{:08x}",
                             i, static_cast<unsigned>(hr));
                continue;
            }
            if (!available) {
                continue;
            }

            GUID subtype = {};
            if (FAILED(available->GetGUID(MF_MT_SUBTYPE, &subtype))) {
                continue;
            }

            ComPtr<IMFMediaType> candidate;
            if (FAILED(MFCreateMediaType(&candidate))) {
                continue;
            }
            available->CopyAllItems(candidate.Get());
            configureInputType(candidate.Get(), subtype);

            hr = transform_->SetInputType(0, candidate.Get(), MFT_SET_TYPE_TEST_ONLY);
            if (FAILED(hr)) {
                spdlog::warn("[VideoEncoder] Reject input type idx={} subtype={} hr=0x{:08x}",
                             i, subtypeName(subtype), static_cast<unsigned>(hr));
                continue;
            }

            const int priority = inputPriority(subtype, preferRgb32);
            spdlog::info("[VideoEncoder] Accept input type idx={} subtype={} priority={}",
                         i, subtypeName(subtype), priority);
            if (priority < bestPriority) {
                bestPriority = priority;
                outSubtype = subtype;
                outType = candidate;
            }
        }

        if (outType) {
            return true;
        }

        const std::array<GUID, 5> manualTypes = preferRgb32
            ? std::array<GUID, 5>{
                  MFVideoFormat_ARGB32,
                  MFVideoFormat_RGB32,
                  MFVideoFormat_NV12,
                  MFVideoFormat_IYUV,
                  MFVideoFormat_YV12}
            : std::array<GUID, 5>{
                  MFVideoFormat_NV12,
                  MFVideoFormat_IYUV,
                  MFVideoFormat_YV12,
                  MFVideoFormat_ARGB32,
                  MFVideoFormat_RGB32};

        for (const GUID &subtype : manualTypes) {
            ComPtr<IMFMediaType> candidate;
            if (FAILED(MFCreateMediaType(&candidate))) {
                continue;
            }
            configureInputType(candidate.Get(), subtype);
            hr = transform_->SetInputType(0, candidate.Get(), MFT_SET_TYPE_TEST_ONLY);
            if (SUCCEEDED(hr)) {
                outSubtype = subtype;
                outType = candidate;
                spdlog::info("[VideoEncoder] Manual input fallback accepted subtype={}", subtypeName(subtype));
                return true;
            }
            spdlog::warn("[VideoEncoder] Manual input fallback rejected subtype={} hr=0x{:08x}",
                         subtypeName(subtype), static_cast<unsigned>(hr));
        }

        return false;
    }

    bool setCodecApiUi4(const GUID &api, ULONG value, const char *label = nullptr) {
        if (!codecApi_) {
            return false;
        }
        VARIANT v;
        VariantInit(&v);
        v.vt = VT_UI4;
        v.ulVal = value;
        const HRESULT hr = codecApi_->SetValue(&api, &v);
        VariantClear(&v);
        if (SUCCEEDED(hr)) {
            if (label) {
                spdlog::info("[VideoEncoder] {} {}", label, value / 1000);
            }
            return true;
        }
        return false;
    }

    void configureCodecApi() {
        if (codecApi_) {
            codecApi_->Release();
            codecApi_ = nullptr;
        }
        if (!transform_) {
            return;
        }

        ICodecAPI *codecApi = nullptr;
        HRESULT hr = transform_->QueryInterface(IID_PPV_ARGS(&codecApi));
        if (FAILED(hr) || !codecApi) {
            spdlog::warn("[VideoEncoder] Could not get ICodecAPI interface");
            return;
        }

        codecApi_ = codecApi;
        const ULONG gopSize = static_cast<ULONG>(std::max(1, config_.gopSize));
        if (!setCodecApiUi4(CODECAPI_AVEncMPVGOPSize, gopSize)) {
            spdlog::warn("[VideoEncoder] Failed to set GOP size");
        }

        VARIANT lowLatency;
        VariantInit(&lowLatency);
        lowLatency.vt = VT_BOOL;
        lowLatency.boolVal = config_.lowLatency ? VARIANT_TRUE : VARIANT_FALSE;
        hr = codecApi_->SetValue(&CODECAPI_AVLowLatencyMode, &lowLatency);
        VariantClear(&lowLatency);
        if (FAILED(hr)) {
            spdlog::debug("[VideoEncoder] AVLowLatencyMode unsupported hr=0x{:08x}", static_cast<unsigned>(hr));
        }

        setCodecApiUi4(CODECAPI_AVEncCommonMeanBitRate, static_cast<ULONG>(std::max(1, config_.bitrate) * 1000));
        const int maxKbps = std::max(config_.maxBitrate, config_.bitrate);
        setCodecApiUi4(CODECAPI_AVEncCommonMaxBitRate, static_cast<ULONG>(std::max(1, maxKbps) * 1000));
    }

    bool configureTransform() {
        if (!transform_) {
            return false;
        }

        unlockAsyncMft();
        if (usingHardware_) {
            attachDxgiDeviceManager();
        }
        detectAsyncMode();
        configureCodecApi();

        ComPtr<IMFMediaType> outputType;
        if (!chooseOutputType(outputType)) {
            return false;
        }

        HRESULT hr = transform_->SetOutputType(0, outputType.Get(), 0);
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] SetOutputType failed hr=0x{:08x}", static_cast<unsigned>(hr));
            return false;
        }
        spdlog::info("[VideoEncoder] Output type set successfully");

        ComPtr<IMFMediaType> inputType;
        GUID selectedSubtype = MFVideoFormat_NV12;
        if (!chooseInputType(inputType, selectedSubtype)) {
            spdlog::error("[VideoEncoder] No compatible input type found");
            return false;
        }

        hr = transform_->SetInputType(0, inputType.Get(), 0);
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] SetInputType failed hr=0x{:08x}", static_cast<unsigned>(hr));
            return false;
        }

        inputSubtype_ = selectedSubtype;
        spdlog::info("[VideoEncoder] Input type set: {}", subtypeName(inputSubtype_));

        hr = transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] BEGIN_STREAMING message failed hr=0x{:08x}", static_cast<unsigned>(hr));
        }
        hr = transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] START_OF_STREAM message failed hr=0x{:08x}", static_cast<unsigned>(hr));
        }
        streamStarted_ = true;
        if (asyncMft_) {
            pumpAsyncEvents();
        }
        return true;
    }

    bool runWarmupProbe() {
        CapturedFrame probeFrame;
        probeFrame.width = std::max(1, config_.width);
        probeFrame.height = std::max(1, config_.height);
        probeFrame.timestamp = 0;
        if (externalInputIsGray_) {
            probeFrame.stride = probeFrame.width;
            probeFrame.format = CapturedFrame::Format::Gray;
            probeFrame.data.assign(static_cast<size_t>(probeFrame.stride) * static_cast<size_t>(probeFrame.height), 0xFF);
        } else {
            probeFrame.stride = probeFrame.width * 4;
            probeFrame.format = CapturedFrame::Format::BGRA;
            probeFrame.data.assign(static_cast<size_t>(probeFrame.stride) * static_cast<size_t>(probeFrame.height), 0);
        }

        EncodedPacket probePacket;
        constexpr int kMaxProbeFrames = 18;
        const bool externalProbe = usingExternalFfmpeg_;
        // External startup is asynchronous. A full input queue can consume an
        // attempt immediately, so a frame count is not a startup deadline.
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        for (int i = 0; externalProbe ? std::chrono::steady_clock::now() < deadline
                                    : i < kMaxProbeFrames; ++i) {
            if (encode(probeFrame, probePacket, probeFrame.timestamp) &&
                !probePacket.data.empty()) {
                spdlog::info("[VideoEncoder] Warm-up probe produced encoded data on frame {}", i + 1);
                return true;
            }
            if (externalProbe) {
                if (!usingExternalFfmpeg_) {
                    break;  // A failed process was already retired by encode().
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
        }
        spdlog::warn("[VideoEncoder] Warm-up probe produced no encoded output");
        return false;
    }

    bool runWarmupProbeAndPrepareLivePipeline() {
        const bool previousWarmupState = externalWarmupInProgress_;
        externalWarmupInProgress_ = true;
        const bool probeSucceeded = runWarmupProbe();
        externalWarmupInProgress_ = previousWarmupState;
        if (!probeSucceeded) {
            return false;
        }
        if (!usingExternalFfmpeg_) {
            return true;
        }

        // A persistent FFmpeg process may still contain probe inputs or encoded
        // probe packets when the first packet arrives. Never expose those to the
        // live RTP path: replace the warmed process with a clean, identical one.
        spdlog::info("[FFmpegEncoder] Replacing warmed FFmpeg pipeline before live input");
        shutdownExternalFfmpegNvenc();
        if (!initializeExternalFfmpegNvenc()) {
            spdlog::warn("[FFmpegEncoder] Failed to start clean FFmpeg pipeline after warm-up");
            return false;
        }
        return true;
    }

    bool ensureComInitialized() {
        if (comInitialized_) {
            return true;
        }
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (hr == RPC_E_CHANGED_MODE) {
            hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        }
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] CoInitializeEx failed hr=0x{:08x}", static_cast<unsigned>(hr));
            return false;
        }
        comInitialized_ = true;
        return true;
    }

    void releaseCom() {
        if (!comInitialized_) {
            return;
        }
        CoUninitialize();
        comInitialized_ = false;
    }

    void shutdownMf() {
        dxgiDeviceManager_.Reset();
        d3dContext_.Reset();
        d3dDevice_.Reset();
        dxgiResetToken_ = 0;
        if (mfStarted_) {
            MFShutdown();
            mfStarted_ = false;
        }
    }

    void unlockAsyncMft() {
        if (!transform_) {
            return;
        }
        ComPtr<IMFAttributes> attrs;
        HRESULT hr = transform_->GetAttributes(attrs.ReleaseAndGetAddressOf());
        if (FAILED(hr) || !attrs) {
            return;
        }

        UINT32 isAsync = 0;
        hr = attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync);
        if (FAILED(hr) || !isAsync) {
            return;
        }

        hr = attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
        const std::string encoderName = activeEncoderName();
        if (SUCCEEDED(hr)) {
            spdlog::info("[VideoEncoder] Enabled async unlock for '{}'", encoderName);
        } else {
            spdlog::warn("[VideoEncoder] Failed to unlock async transform '{}' hr=0x{:08x}",
                         encoderName,
                         static_cast<unsigned>(hr));
        }
    }

    bool ensureDxgiDeviceManager() {
        if (dxgiDeviceManager_) {
            return true;
        }

        D3D_FEATURE_LEVEL featureLevels[] = {
            D3D_FEATURE_LEVEL_11_1,
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0
        };
        D3D_FEATURE_LEVEL createdFeature = D3D_FEATURE_LEVEL_11_0;
        const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;

        HRESULT hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            d3dDevice_.ReleaseAndGetAddressOf(),
            &createdFeature,
            d3dContext_.ReleaseAndGetAddressOf());
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] D3D11CreateDevice(HARDWARE) failed hr=0x{:08x}", static_cast<unsigned>(hr));
            hr = D3D11CreateDevice(
                nullptr,
                D3D_DRIVER_TYPE_WARP,
                nullptr,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                featureLevels,
                ARRAYSIZE(featureLevels),
                D3D11_SDK_VERSION,
                d3dDevice_.ReleaseAndGetAddressOf(),
                &createdFeature,
                d3dContext_.ReleaseAndGetAddressOf());
        }
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] Failed to create D3D11 device for MFT hr=0x{:08x}", static_cast<unsigned>(hr));
            return false;
        }

        hr = MFCreateDXGIDeviceManager(&dxgiResetToken_, dxgiDeviceManager_.ReleaseAndGetAddressOf());
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] MFCreateDXGIDeviceManager failed hr=0x{:08x}", static_cast<unsigned>(hr));
            dxgiDeviceManager_.Reset();
            d3dContext_.Reset();
            d3dDevice_.Reset();
            dxgiResetToken_ = 0;
            return false;
        }

        hr = dxgiDeviceManager_->ResetDevice(d3dDevice_.Get(), dxgiResetToken_);
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] IMFDXGIDeviceManager::ResetDevice failed hr=0x{:08x}", static_cast<unsigned>(hr));
            dxgiDeviceManager_.Reset();
            d3dContext_.Reset();
            d3dDevice_.Reset();
            dxgiResetToken_ = 0;
            return false;
        }

        spdlog::info("[VideoEncoder] DXGI device manager ready (D3D feature level=0x{:x})",
                     static_cast<unsigned>(createdFeature));
        return true;
    }

    void attachDxgiDeviceManager() {
        if (!transform_ || !usingHardware_) {
            return;
        }
        if (!ensureDxgiDeviceManager()) {
            return;
        }
        const HRESULT hr = transform_->ProcessMessage(
            MFT_MESSAGE_SET_D3D_MANAGER,
            reinterpret_cast<ULONG_PTR>(dxgiDeviceManager_.Get()));
        const std::string encoderName = activeEncoderName();
        if (SUCCEEDED(hr)) {
            spdlog::info("[VideoEncoder] Attached DXGI manager to '{}'", encoderName);
        } else {
            spdlog::warn("[VideoEncoder] Failed to attach DXGI manager to '{}' hr=0x{:08x}",
                         encoderName,
                         static_cast<unsigned>(hr));
        }
    }

    void detectAsyncMode() {
        asyncMft_ = false;
        pendingNeedInputEvents_ = 0;
        pendingHaveOutputEvents_ = 0;
        eventGenerator_.Reset();

        if (!transform_) {
            return;
        }
        ComPtr<IMFAttributes> attrs;
        HRESULT hr = transform_->GetAttributes(attrs.ReleaseAndGetAddressOf());
        if (FAILED(hr) || !attrs) {
            return;
        }

        UINT32 isAsync = 0;
        hr = attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync);
        if (FAILED(hr) || !isAsync) {
            return;
        }

        // Some hardware MFTs can stall or underfeed in async mode under real-time churn.
        // Keep Intel/QSV in synchronous mode, but allow NVIDIA MFTs to remain async to
        // avoid E_UNEXPECTED ProcessOutput timing violations.
        const std::string encoderName = activeEncoderName();
        const std::string encoderLower = toLowerCopy(encoderName);
        if (encoderLower.find("quick sync") != std::string::npos ||
            encoderLower.find("intel") != std::string::npos ||
            encoderLower.find("qsv") != std::string::npos) {
            spdlog::info("[VideoEncoder] Forcing synchronous MFT mode for '{}'", encoderName);
            return;
        }

        hr = transform_->QueryInterface(IID_PPV_ARGS(eventGenerator_.ReleaseAndGetAddressOf()));
        if (FAILED(hr) || !eventGenerator_) {
            spdlog::warn("[VideoEncoder] Async MFT detected but IMFMediaEventGenerator unavailable hr=0x{:08x}",
                         static_cast<unsigned>(hr));
            return;
        }

        asyncMft_ = true;
        spdlog::info("[VideoEncoder] Async MFT mode enabled for '{}'", encoderName);
    }

    void pumpAsyncEvents() {
        if (!asyncMft_ || !eventGenerator_) {
            return;
        }

        for (;;) {
            ComPtr<IMFMediaEvent> event;
            const HRESULT hr = eventGenerator_->GetEvent(MF_EVENT_FLAG_NO_WAIT, event.ReleaseAndGetAddressOf());
            if (hr == MF_E_NO_EVENTS_AVAILABLE) {
                return;
            }
            if (FAILED(hr) || !event) {
                return;
            }

            MediaEventType type = MEUnknown;
            event->GetType(&type);
            HRESULT status = S_OK;
            event->GetStatus(&status);
            if (FAILED(status)) {
                spdlog::warn("[VideoEncoder] Async event status failure type={} hr=0x{:08x}",
                             static_cast<unsigned>(type), static_cast<unsigned>(status));
            }

            if (type == METransformNeedInput) {
                pendingNeedInputEvents_++;
            } else if (type == METransformHaveOutput) {
                pendingHaveOutputEvents_++;
            } else if (type == MEError) {
                spdlog::warn("[VideoEncoder] Async MFT error event hr=0x{:08x}", static_cast<unsigned>(status));
            }
        }
    }

    void resetCurrentTransform() {
        mfPendingSourceTimestamps_.clear();
        if (codecApi_) {
            codecApi_->Release();
            codecApi_ = nullptr;
        }
        const bool wasAsyncMft = asyncMft_;
        asyncMft_ = false;
        pendingNeedInputEvents_ = 0;
        pendingHaveOutputEvents_ = 0;
        if (transform_) {
            if (streamStarted_) {
                transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                transform_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
                transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
            if (wasAsyncMft) {
                // Async MFTs own an event queue and must be explicitly shut
                // down before their final interface is released. Releasing
                // the transform and immediately reactivating the same
                // IMFActivate can otherwise leave a vendor work-queue
                // callback racing a destroyed encoder instance.
                ComPtr<IMFShutdown> shutdown;
                const HRESULT queryHr = transform_.As(&shutdown);
                if (SUCCEEDED(queryHr) && shutdown) {
                    const HRESULT shutdownHr = shutdown->Shutdown();
                    if (SUCCEEDED(shutdownHr)) {
                        activeObjectExplicitlyShutdown_ = true;
                        MFSHUTDOWN_STATUS status = MFSHUTDOWN_INITIATED;
                        const auto deadline = std::chrono::steady_clock::now() +
                            std::chrono::milliseconds(250);
                        while (shutdown->GetShutdownStatus(&status) == S_OK &&
                               status != MFSHUTDOWN_COMPLETED &&
                               std::chrono::steady_clock::now() < deadline) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(1));
                        }
                        if (status != MFSHUTDOWN_COMPLETED) {
                            spdlog::warn("[VideoEncoder] Async MFT shutdown did not report completion before release");
                        }
                    } else {
                        spdlog::warn("[VideoEncoder] IMFShutdown::Shutdown failed hr=0x{:08x}",
                                     static_cast<unsigned>(shutdownHr));
                    }
                } else {
                    spdlog::warn("[VideoEncoder] Async MFT did not expose required IMFShutdown hr=0x{:08x}",
                                 static_cast<unsigned>(queryHr));
                }
            }
            eventGenerator_.Reset();
            transform_.Reset();
        } else {
            eventGenerator_.Reset();
        }
        streamStarted_ = false;
    }

    bool shutdownCurrentActivation() {
        if (!activeActivation_) {
            activeObjectExplicitlyShutdown_ = false;
            return true;
        }
        const bool detachExplicitlyShutdownObject = activeObjectExplicitlyShutdown_;
        HRESULT hr = detachExplicitlyShutdownObject
            ? activeActivation_->DetachObject()
            : activeActivation_->ShutdownObject();
        if (detachExplicitlyShutdownObject && hr == E_NOTIMPL) {
            // DetachObject is optional. NVIDIA's H.264 activation object can
            // return E_NOTIMPL even though its encoder initialized and encoded
            // correctly. ShutdownObject still releases the activation object's
            // retained reference before we request a clean live instance.
            spdlog::info(
                "[VideoEncoder] IMFActivate::DetachObject is not implemented; falling back to ShutdownObject");
            hr = activeActivation_->ShutdownObject();
        }
        activeObjectExplicitlyShutdown_ = false;
        activeActivation_.Reset();
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] IMFActivate::{} failed hr=0x{:08x}",
                         detachExplicitlyShutdownObject ? "DetachObject" : "ShutdownObject",
                         static_cast<unsigned>(hr));
            return false;
        }
        return true;
    }

    bool prepareInputBuffer(const CapturedFrame &input, std::vector<uint8_t> &out) {
        const int dstW = std::max(1, config_.width);
        const int dstH = std::max(1, config_.height);
        const InputPacking packing = inputPackingFromSubtype(inputSubtype_);

        if (input.format == CapturedFrame::Format::BGRA) {
            if (input.data.empty() ||
                input.width <= 0 ||
                input.height <= 0 ||
                input.stride < (input.width * 4)) {
                return false;
            }
            if (packing == InputPacking::NV12) {
                out.resize(static_cast<size_t>(dstW) * dstH * 3 / 2);
                convertBGRAtoNV12(input.data.data(), input.width, input.height, input.stride,
                                  out.data(), dstW, dstH);
                return true;
            }
            if (packing == InputPacking::I420 || packing == InputPacking::YV12) {
                out.resize(static_cast<size_t>(dstW) * dstH * 3 / 2);
                uint8_t *yPlane = out.data();
                uint8_t *uPlane = yPlane + (dstW * dstH);
                uint8_t *vPlane = uPlane + (dstW * dstH) / 4;
                if (packing == InputPacking::YV12) {
                    std::swap(uPlane, vPlane);
                }
                convertBGRAtoI420(input.data.data(), input.width, input.height, input.stride,
                                  yPlane, uPlane, vPlane, dstW, dstH);
                return true;
            }
            if (packing == InputPacking::RGB32) {
                out.resize(static_cast<size_t>(dstW) * dstH * 4);
                convertBGRAtoRGB32(input.data.data(), input.width, input.height, input.stride,
                                   out.data(), dstW, dstH);
                return true;
            }
        } else if (input.format == CapturedFrame::Format::NV12 && packing == InputPacking::NV12) {
            out = input.data;
            return true;
        } else if (input.format == CapturedFrame::Format::I420 &&
                   (packing == InputPacking::I420 || packing == InputPacking::YV12)) {
            out = input.data;
            if (packing == InputPacking::YV12 && out.size() >= static_cast<size_t>(dstW) * dstH * 3 / 2) {
                const size_t planeSize = static_cast<size_t>(dstW) * dstH / 4;
                uint8_t *uPlane = out.data() + (static_cast<size_t>(dstW) * dstH);
                uint8_t *vPlane = uPlane + planeSize;
                for (size_t i = 0; i < planeSize; ++i) {
                    std::swap(uPlane[i], vPlane[i]);
                }
            }
            return true;
        }

        spdlog::error("[VideoEncoder] Unsupported input conversion path frameFormat={} subtype={}",
                      static_cast<int>(input.format), subtypeName(inputSubtype_));
        return false;
    }

    static bool matchesPreferredHardware(const std::string &encoderName, HardwareEncoder preferred) {
        const std::string lower = toLowerCopy(encoderName);
        switch (preferred) {
            case HardwareEncoder::NVENC:
                return lower.find("nvidia") != std::string::npos ||
                       lower.find("nvenc") != std::string::npos ||
                       lower.find("geforce") != std::string::npos;
            case HardwareEncoder::QuickSync:
                return lower.find("intel") != std::string::npos ||
                       lower.find("quick sync") != std::string::npos ||
                       lower.find("qsv") != std::string::npos;
            case HardwareEncoder::AMF:
                return lower.find("amd") != std::string::npos ||
                       lower.find("radeon") != std::string::npos ||
                       lower.find("amf") != std::string::npos;
            case HardwareEncoder::None:
            default:
                return false;
        }
    }

    static bool encoderNameLooksDx12Hardware(const std::string &encoderName) {
        const std::string lower = toLowerCopy(encoderName);
        return lower.find("avc dx") != std::string::npos;
    }

    static bool encoderNameLooksGenericHardware(const std::string &encoderName) {
        const std::string lower = toLowerCopy(encoderName);
        return lower == "h264 encoder mft" ||
               lower.find("hardware h264 encoder") != std::string::npos;
    }

    static bool encoderNameLooksWrongVendor(const std::string &encoderName, HardwareEncoder preferred) {
        const std::string lower = toLowerCopy(encoderName);
        const bool nvidia = lower.find("nvidia") != std::string::npos ||
                            lower.find("nvenc") != std::string::npos ||
                            lower.find("geforce") != std::string::npos;
        const bool intel = lower.find("intel") != std::string::npos ||
                           lower.find("quick sync") != std::string::npos ||
                           lower.find("qsv") != std::string::npos;
        const bool amd = lower.find("amd") != std::string::npos ||
                         lower.find("radeon") != std::string::npos ||
                         lower.find("amf") != std::string::npos;

        switch (preferred) {
            case HardwareEncoder::NVENC:
                return intel || amd;
            case HardwareEncoder::QuickSync:
                return nvidia || amd;
            case HardwareEncoder::AMF:
                return nvidia || intel;
            case HardwareEncoder::None:
            default:
                return false;
        }
    }

    static int hardwarePreferenceScore(const EncoderCandidate &candidate, HardwareEncoder preferred) {
        if (preferred == HardwareEncoder::None) {
            return 0;
        }
        if (matchesPreferredHardware(candidate.name, preferred)) {
            return 0;
        }
        if (encoderNameLooksDx12Hardware(candidate.name)) {
            return 1;
        }
        if (encoderNameLooksGenericHardware(candidate.name)) {
            return 2;
        }
        if (encoderNameLooksWrongVendor(candidate.name, preferred)) {
            return 4;
        }
        return 3;
    }

    static std::vector<EncoderCandidate> enumerateEncoders(DWORD flags, bool hardware,
                                                           const MFT_REGISTER_TYPE_INFO *inputType,
                                                           const MFT_REGISTER_TYPE_INFO *outputType) {
        IMFActivate **activates = nullptr;
        UINT32 count = 0;
        HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags,
                               const_cast<MFT_REGISTER_TYPE_INFO *>(inputType),
                               const_cast<MFT_REGISTER_TYPE_INFO *>(outputType),
                               &activates, &count);
        if (FAILED(hr) || count == 0) {
            return {};
        }

        std::vector<EncoderCandidate> encoders;
        encoders.reserve(count);
        for (UINT32 i = 0; i < count; ++i) {
            EncoderCandidate candidate;
            candidate.hardware = hardware;
            candidate.activate = activates[i];

            UINT32 nameLen = 0;
            if (SUCCEEDED(activates[i]->GetStringLength(MFT_FRIENDLY_NAME_Attribute, &nameLen)) && nameLen > 0) {
                std::wstring wideName(nameLen + 1, L'\0');
                if (SUCCEEDED(activates[i]->GetString(MFT_FRIENDLY_NAME_Attribute, wideName.data(), nameLen + 1, nullptr))) {
                    if (!wideName.empty() && wideName.back() == L'\0') {
                        wideName.pop_back();
                    }
                    candidate.name.assign(wideName.begin(), wideName.end());
                }
            }
            if (candidate.name.empty()) {
                candidate.name = hardware ? "Hardware H264 Encoder" : "Software H264 Encoder";
            }
            encoders.push_back(std::move(candidate));
        }

        for (UINT32 i = 0; i < count; ++i) {
            activates[i]->Release();
        }
        CoTaskMemFree(activates);
        return encoders;
    }

    std::vector<EncoderCandidate> orderedEncoderCandidates() {
        MFT_REGISTER_TYPE_INFO outputType = {MFMediaType_Video, MFVideoFormat_H264};

        const DWORD hardwareFlags = MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_HARDWARE;
        const DWORD softwareFlags = MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER;

        std::vector<EncoderCandidate> hardwareEncoders = enumerateEncoders(hardwareFlags, true, nullptr, &outputType);
        std::vector<EncoderCandidate> softwareEncoders = enumerateEncoders(softwareFlags, false, nullptr, &outputType);

        spdlog::info("[VideoEncoder] Encoder candidates: hardware={}, software={}",
                     hardwareEncoders.size(), softwareEncoders.size());
        for (const auto &candidate : hardwareEncoders) {
            spdlog::info("[VideoEncoder] Hardware candidate: {}", candidate.name);
        }
        for (const auto &candidate : softwareEncoders) {
            spdlog::info("[VideoEncoder] Software candidate: {}", candidate.name);
        }

        const HardwareEncoder preferred = config_.preferredHardware;
        std::vector<EncoderCandidate> ordered;
        ordered.reserve(hardwareEncoders.size() + softwareEncoders.size());

        auto appendMatching = [&](const std::vector<EncoderCandidate> &src, auto predicate) {
            for (const auto &candidate : src) {
                if (predicate(candidate)) {
                    ordered.push_back(candidate);
                }
            }
        };

        if (!config_.explicitEncoderSelection &&
            preferred != HardwareEncoder::None) {
            // Auto is vendor-neutral: accept any healthy hardware encoder in
            // the order provided by Media Foundation, then software.
            appendMatching(hardwareEncoders, [](const EncoderCandidate &) { return true; });
            appendMatching(softwareEncoders, [](const EncoderCandidate &) { return true; });
        } else if (preferred == HardwareEncoder::None) {
            // Explicit Software, and Auto's internal software fallback, must
            // never silently resolve back to hardware.
            appendMatching(softwareEncoders, [](const EncoderCandidate &) { return true; });
        } else {
            // Explicit vendor selections accept only a confirmed match.
            std::stable_sort(hardwareEncoders.begin(), hardwareEncoders.end(),
                             [&](const EncoderCandidate &left, const EncoderCandidate &right) {
                                 return hardwarePreferenceScore(left, preferred) <
                                        hardwarePreferenceScore(right, preferred);
                             });
            appendMatching(hardwareEncoders, [&](const EncoderCandidate &candidate) {
                return matchesPreferredHardware(candidate.name, preferred);
            });
        }

        return ordered;
    }

    void convertBGRAtoNV12(const uint8_t* bgra, int srcW, int srcH, int srcStride,
                          uint8_t* nv12, int dstW, int dstH) {
        const size_t scratchSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH) * 4;
        if (conversionScratchBgra_.size() != scratchSize) {
            conversionScratchBgra_.resize(scratchSize);
        }
        blitBgraAspectFit(bgra, srcW, srcH, srcStride,
                          conversionScratchBgra_.data(), dstW, dstH, dstW * 4, config_);

        uint8_t* yPlane = nv12;
        uint8_t* uvPlane = nv12 + dstW * dstH;
        if ((dstW & 1) != 0 || (dstH & 1) != 0) {
            std::fill(uvPlane, uvPlane + (dstW * dstH / 2), static_cast<uint8_t>(128));
        }

        for (int y = 0; y < dstH; y++) {
            const uint8_t* srcRow = conversionScratchBgra_.data() + static_cast<size_t>(y) * dstW * 4;
            uint8_t* yRow = yPlane + static_cast<size_t>(y) * dstW;
            for (int x = 0; x < dstW; x++) {
                const uint8_t* pixel = srcRow + static_cast<size_t>(x) * 4;
                const int b = pixel[0];
                const int g = pixel[1];
                const int r = pixel[2];

                // BT.601 conversion
                const int yVal = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                yRow[x] = static_cast<uint8_t>(std::clamp(yVal, 0, 255));
            }
        }

        for (int y = 0; y + 1 < dstH; y += 2) {
            const uint8_t* srcRow = conversionScratchBgra_.data() + static_cast<size_t>(y) * dstW * 4;
            uint8_t* uvRow = uvPlane + static_cast<size_t>(y / 2) * dstW;
            for (int x = 0; x + 1 < dstW; x += 2) {
                const uint8_t* row0 = srcRow;
                const uint8_t* row1 = conversionScratchBgra_.data() +
                    static_cast<size_t>(std::min(y + 1, dstH - 1)) * dstW * 4;
                const uint8_t* p00 = row0 + static_cast<size_t>(x) * 4;
                const uint8_t* p01 = row0 + static_cast<size_t>(std::min(x + 1, dstW - 1)) * 4;
                const uint8_t* p10 = row1 + static_cast<size_t>(x) * 4;
                const uint8_t* p11 = row1 + static_cast<size_t>(std::min(x + 1, dstW - 1)) * 4;

                const int b = (static_cast<int>(p00[0]) + static_cast<int>(p01[0]) +
                               static_cast<int>(p10[0]) + static_cast<int>(p11[0]) + 2) / 4;
                const int g = (static_cast<int>(p00[1]) + static_cast<int>(p01[1]) +
                               static_cast<int>(p10[1]) + static_cast<int>(p11[1]) + 2) / 4;
                const int r = (static_cast<int>(p00[2]) + static_cast<int>(p01[2]) +
                               static_cast<int>(p10[2]) + static_cast<int>(p11[2]) + 2) / 4;
                const int u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                const int v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                uvRow[x] = static_cast<uint8_t>(std::clamp(u, 0, 255));
                uvRow[x + 1] = static_cast<uint8_t>(std::clamp(v, 0, 255));
            }
        }
    }

    void convertBGRAtoI420(const uint8_t *bgra, int srcW, int srcH, int srcStride,
                           uint8_t *yPlane, uint8_t *uPlane, uint8_t *vPlane,
                           int dstW, int dstH) {
        const size_t scratchSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH) * 4;
        if (conversionScratchBgra_.size() != scratchSize) {
            conversionScratchBgra_.resize(scratchSize);
        }
        blitBgraAspectFit(bgra, srcW, srcH, srcStride,
                          conversionScratchBgra_.data(), dstW, dstH, dstW * 4, config_);

        if ((dstW & 1) != 0 || (dstH & 1) != 0) {
            std::fill(uPlane, uPlane + (dstW * dstH / 4), static_cast<uint8_t>(128));
            std::fill(vPlane, vPlane + (dstW * dstH / 4), static_cast<uint8_t>(128));
        }

        for (int y = 0; y < dstH; ++y) {
            const uint8_t *srcRow = conversionScratchBgra_.data() + static_cast<size_t>(y) * dstW * 4;
            uint8_t *yRow = yPlane + static_cast<size_t>(y) * dstW;
            for (int x = 0; x < dstW; ++x) {
                const uint8_t *pixel = srcRow + static_cast<size_t>(x) * 4;
                const int b = pixel[0];
                const int g = pixel[1];
                const int r = pixel[2];
                const int yVal = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                yRow[x] = static_cast<uint8_t>(std::clamp(yVal, 0, 255));
            }
        }

        for (int y = 0; y + 1 < dstH; y += 2) {
            const uint8_t *srcRow0 = conversionScratchBgra_.data() + static_cast<size_t>(y) * dstW * 4;
            const uint8_t *srcRow1 = conversionScratchBgra_.data() +
                static_cast<size_t>(std::min(y + 1, dstH - 1)) * dstW * 4;
            uint8_t *uRow = uPlane + static_cast<size_t>(y / 2) * (dstW / 2);
            uint8_t *vRow = vPlane + static_cast<size_t>(y / 2) * (dstW / 2);
            for (int x = 0; x + 1 < dstW; x += 2) {
                const uint8_t *p00 = srcRow0 + static_cast<size_t>(x) * 4;
                const uint8_t *p01 = srcRow0 + static_cast<size_t>(std::min(x + 1, dstW - 1)) * 4;
                const uint8_t *p10 = srcRow1 + static_cast<size_t>(x) * 4;
                const uint8_t *p11 = srcRow1 + static_cast<size_t>(std::min(x + 1, dstW - 1)) * 4;

                const int b = (static_cast<int>(p00[0]) + static_cast<int>(p01[0]) +
                               static_cast<int>(p10[0]) + static_cast<int>(p11[0]) + 2) / 4;
                const int g = (static_cast<int>(p00[1]) + static_cast<int>(p01[1]) +
                               static_cast<int>(p10[1]) + static_cast<int>(p11[1]) + 2) / 4;
                const int r = (static_cast<int>(p00[2]) + static_cast<int>(p01[2]) +
                               static_cast<int>(p10[2]) + static_cast<int>(p11[2]) + 2) / 4;

                const int u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                const int v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                const int chromaX = x / 2;
                uRow[chromaX] = static_cast<uint8_t>(std::clamp(u, 0, 255));
                vRow[chromaX] = static_cast<uint8_t>(std::clamp(v, 0, 255));
            }
        }
    }

    void convertBGRAtoRGB32(const uint8_t *bgra, int srcW, int srcH, int srcStride,
                            uint8_t *dst, int dstW, int dstH) {
        blitBgraAspectFit(bgra, srcW, srcH, srcStride, dst, dstW, dstH, dstW * 4, config_);
        // H.264/H.265 MF encoders do not carry alpha. Some hardware MFTs still
        // consult the RGB32 alpha byte during their internal color conversion,
        // so make the primary color stream explicitly opaque.
        for (int y = 0; y < dstH; ++y) {
            uint8_t *row = dst + static_cast<size_t>(y) * static_cast<size_t>(dstW) * 4;
            for (int x = 0; x < dstW; ++x) {
                row[static_cast<size_t>(x) * 4 + 3] = 255;
            }
        }
    }

    EncoderConfig config_{};
    ComPtr<IMFTransform> transform_;
    ComPtr<IMFActivate> activeActivation_;
    ComPtr<ID3D11Device> d3dDevice_;
    ComPtr<ID3D11DeviceContext> d3dContext_;
    ComPtr<IMFDXGIDeviceManager> dxgiDeviceManager_;
    ComPtr<IMFMediaEventGenerator> eventGenerator_;
    ICodecAPI* codecApi_ = nullptr;
    GUID inputSubtype_ = MFVideoFormat_NV12;
    UINT dxgiResetToken_ = 0;
    bool comInitialized_ = false;
    bool asyncMft_ = false;
    bool activeObjectExplicitlyShutdown_ = false;
    bool mfStarted_ = false;
    bool initialized_ = false;
    std::atomic<bool> usingHardware_{false};
    bool streamStarted_ = false;
    bool usingExternalFfmpeg_ = false;
    bool externalWarmupInProgress_ = false;
    int handoverPrimingFrames_ = 0;
    bool handoverFirstLivePacket_ = false;
    bool handoverPrefixKeyframeSeen_ = false;
    bool externalForceKeyframeRequested_ = false;
    bool externalFirstPacketLogged_ = false;
    bool externalIvfHeaderParsed_ = false;
    bool externalInputIsNv12_ = true;
    bool externalInputIsGray_ = false;
    int pendingNeedInputEvents_ = 0;
    int pendingHaveOutputEvents_ = 0;
    int64_t frameCount_ = 0;
    int64_t lastInputTimestamp_ = 0;
    int64_t externalFramesSubmitted_ = 0;
    int64_t externalPacketCount_ = 0;
    ExternalOutputFormat externalOutputFormat_ = ExternalOutputFormat::AnnexB;
    bool externalUsingHardware_ = false;
    std::filesystem::path externalFfmpegPath_;
    std::vector<std::string> externalFfmpegArgs_;
    std::vector<uint8_t> externalInputBuffer_;
    std::vector<uint8_t> externalOutputBuffer_;
    std::vector<uint8_t> mfInputBuffer_;
    std::vector<uint8_t> conversionScratchBgra_;
    std::mutex externalIoMutex_;
    std::condition_variable externalIoCv_;
    std::deque<std::vector<uint8_t>> externalInputQueue_;
    std::deque<std::vector<uint8_t>> externalReusableInputBuffers_;
    detail::BoundedSourceTimestampQueue externalPendingOutputPts_{16};
    std::deque<std::pair<LONGLONG, int64_t>> mfPendingSourceTimestamps_;
    std::thread externalWriterThread_;
    std::thread externalReaderThread_;
    std::thread externalStderrThread_;
    bool externalIoStopRequested_ = false;
    bool externalWriterFailed_ = false;
    bool externalReaderFailed_ = false;
    size_t externalPendingInputBytes_ = 0;
    int64_t externalFramesWritten_ = 0;
    std::atomic<EncodeFailureKind> lastEncodeFailureKind_{EncodeFailureKind::None};
    HANDLE externalStdInWrite_ = nullptr;
    HANDLE externalStdOutRead_ = nullptr;
    HANDLE externalStdErrRead_ = nullptr;
    HANDLE externalProcess_ = nullptr;
    HANDLE externalThread_ = nullptr;
    std::string externalEncoderName_;
    mutable std::mutex activeEncoderNameMutex_;
    std::string activeEncoderName_;
    std::atomic<VideoCodec> activeCodec_{VideoCodec::H264};
};

#else
// Non-Windows stub
class VideoEncoder::Impl {
  public:
    bool initialize(const EncoderConfig &, bool = false) { return false; }
    bool primeHandover(const CapturedFrame &) { return false; }
    void shutdown() {}
    bool encode(const CapturedFrame &, EncodedPacket &, int64_t) { return false; }
    void setBitrate(int) {}
    void requestKeyframe() {}
    VideoCodec activeCodec() const { return VideoCodec::H264; }
    std::string activeCodecName() const { return "H.264"; }
    std::string activeEncoderName() const { return "unavailable"; }
    std::string activeInputFormatName() const { return "unavailable"; }
    bool isHardwareEncoder() const { return false; }
    EncodeFailureKind lastEncodeFailureKind() const { return EncodeFailureKind::Unsupported; }
};
#endif

#endif

VideoEncoder::VideoEncoder() : impl_(std::make_unique<Impl>()) {}
VideoEncoder::~VideoEncoder() { shutdown(); }

bool VideoEncoder::initialize(const EncoderConfig &config, const CapturedFrame *handoverFrame) {
    const bool prepareHandover = handoverFrame != nullptr;
    ++configurationRevision_;
    config_ = config;
    requestedConfig_ = config;
    fallbackReason_.clear();
    if (prepareHandover && (config.codec != VideoCodec::H264 || config.bFrames != 0 || !config.ffmpegOptions.empty() ||
        (config.preferredHardware != HardwareEncoder::NVENC && config.preferredHardware != HardwareEncoder::QuickSync))) {
        initialized_ = false;
        return false;
    }
    if (config_.codec == VideoCodec::VP9 && config_.requireEveryFrameKeyframe) {
        config_.gopSize = 1;
        config_.bFrames = 0;
        config_.lowLatency = true;
    }
    if (config_.explicitEncoderSelection &&
        config_.codec == VideoCodec::VP9 &&
        config_.preferredHardware != HardwareEncoder::None) {
        spdlog::error(
            "[VideoEncoder] Requested encoder mode {} cannot provide VP9; refusing software category fallback",
            requestedEncoderModeName(config_));
        initialized_ = false;
        return false;
    }

    auto initializeCandidate = [this, prepareHandover](const EncoderConfig &input) {
        EncoderConfig candidate = input;
        if (prepareHandover) candidate.forceFfmpegNvenc = true;
        impl_->shutdown();
        if (!impl_->initialize(candidate, prepareHandover)) {
            return false;
        }
        config_ = candidate;
        return true;
    };

    if (!config_.explicitEncoderSelection && config_.codec != VideoCodec::H264) {
        const EncoderConfig requested = config_;
        const std::array<HardwareEncoder, 4> candidates = {
            HardwareEncoder::NVENC,
            HardwareEncoder::QuickSync,
            HardwareEncoder::AMF,
            HardwareEncoder::None};
        initialized_ = false;
        for (const HardwareEncoder candidateMode : candidates) {
            if (requested.codec == VideoCodec::VP9 && candidateMode != HardwareEncoder::None) {
                continue;
            }
            EncoderConfig candidate = requested;
            candidate.preferredHardware = candidateMode;
            if (initializeCandidate(candidate)) {
                initialized_ = true;
                break;
            }
        }
    } else {
        initialized_ = initializeCandidate(config_);
    }

    const EncoderConfig requestedConfig = config;
    if (detail::shouldRetryH264NvencWithFfmpeg(
            requestedConfig,
            impl_->activeEncoderName(),
            initialized_ && impl_->isHardwareEncoder())) {
        const std::string mediaFoundationEncoder = impl_->activeEncoderName();
        EncoderConfig ffmpegNvencConfig = requestedConfig;
        ffmpegNvencConfig.forceFfmpegNvenc = true;
        spdlog::warn(
            "[VideoEncoder] Requested NVENC resolved to unconfirmed encoder '{}'; trying FFmpeg h264_nvenc",
            mediaFoundationEncoder.empty() ? "unavailable" : mediaFoundationEncoder);

        if (initializeCandidate(ffmpegNvencConfig) &&
            impl_->isHardwareEncoder() &&
            !detail::shouldRetryH264NvencWithFfmpeg(
                ffmpegNvencConfig,
                impl_->activeEncoderName(),
                impl_->isHardwareEncoder())) {
            config_ = std::move(ffmpegNvencConfig);
            initialized_ = true;
            fallbackReason_ = "NVIDIA Media Foundation was unavailable; using FFmpeg NVENC.";
            spdlog::info(
                "[VideoEncoder] NVENC fallback active: {}",
                impl_->activeEncoderName());
        } else {
            spdlog::error(
                "[VideoEncoder] Explicit NVIDIA selection failed; FFmpeg h264_nvenc was unavailable or unhealthy");
            impl_->shutdown();
            config_ = requestedConfig;
            initialized_ = false;
        }
    }
    if (initialized_ && !encoderMatchesExplicitSelection(
                            requestedConfig,
                            impl_->activeEncoderName(),
                            impl_->isHardwareEncoder())) {
        spdlog::error(
            "[VideoEncoder] Requested encoder mode {} resolved to disallowed category '{}' via '{}'; rejecting",
            requestedEncoderModeName(requestedConfig),
            encoderCategoryName(impl_->activeEncoderName(), impl_->isHardwareEncoder()),
            impl_->activeEncoderName());
        impl_->shutdown();
        config_ = requestedConfig;
        initialized_ = false;
    }
    if (initialized_ && !requestedConfig.explicitEncoderSelection &&
        !impl_->isHardwareEncoder()) {
        fallbackReason_ = requestedConfig.codec == VideoCodec::VP9
            ? "No supported hardware VP9 path is available; Auto selected software."
            : "No healthy supported hardware encoder was available; Auto selected software.";
    }
    protectedPacketContractHealthy_.store(
        initialized_ && config_.requireEveryFrameKeyframe &&
            impl_->activeCodec() == VideoCodec::VP9 &&
            toLowerCopy(impl_->activeEncoderName()).find("libvpx-vp9") !=
                std::string::npos,
        std::memory_order_relaxed);
    if (initialized_ && config_.requireEveryFrameKeyframe &&
        !guaranteesEveryFrameKeyframe()) {
        spdlog::error(
            "[VideoEncoder] Protected VP9 initialization resolved to an incompatible live encoder codec={} encoder='{}'",
            impl_->activeCodecName(),
            impl_->activeEncoderName());
        impl_->shutdown();
        initialized_ = false;
    }
    if (initialized_ && prepareHandover && !impl_->primeHandover(*handoverFrame)) {
        spdlog::warn("[VideoEncoder] Real-frame handover preparation failed; discarding replacement");
        impl_->shutdown();
        initialized_ = false;
    }
    return initialized_;
}

void VideoEncoder::shutdown() {
    ++configurationRevision_;
    impl_->shutdown();
    initialized_ = false;
    fallbackReason_.clear();
    protectedPacketContractHealthy_.store(false, std::memory_order_relaxed);
}

bool VideoEncoder::encode(const CapturedFrame &frame, EncodedPacket &packet) {
    return encodeWithSourceTimestamp(frame, packet, frame.timestamp);
}

bool VideoEncoder::encodeWithSourceTimestamp(const CapturedFrame &frame,
                                             EncodedPacket &packet,
                                             int64_t sourceTimestamp) {
    if (!initialized_) {
        return false;
    }
    if (sourceTimestamp == std::numeric_limits<int64_t>::min()) {
        return false;
    }
    bool ok = impl_->encode(frame, packet, sourceTimestamp);
    if (ok && config_.requireEveryFrameKeyframe) {
        protectedPacketContractHealthy_.store(
            packet.codec == VideoCodec::VP9 && packet.isKeyframe,
            std::memory_order_relaxed);
    }
    if (ok && packetCallback_) {
        packetCallback_(packet);
    }
    return ok;
}

void VideoEncoder::setBitrate(int kbps) {
    ++configurationRevision_;
    impl_->setBitrate(kbps);
    config_.bitrate = kbps;
}

void VideoEncoder::swapPipeline(VideoEncoder &other) {
    using std::swap;
    swap(impl_, other.impl_);
    swap(config_, other.config_);
    swap(requestedConfig_, other.requestedConfig_);
    swap(initialized_, other.initialized_);
    swap(fallbackReason_, other.fallbackReason_);
    const bool healthy = protectedPacketContractHealthy_.load(std::memory_order_relaxed);
    protectedPacketContractHealthy_.store(
        other.protectedPacketContractHealthy_.load(std::memory_order_relaxed),
        std::memory_order_relaxed);
    other.protectedPacketContractHealthy_.store(healthy, std::memory_order_relaxed);
    ++configurationRevision_;
    ++other.configurationRevision_;
}

void VideoEncoder::requestKeyframe() {
    impl_->requestKeyframe();
}

bool VideoEncoder::guaranteesEveryFrameKeyframe() const {
    return detail::protectedVp9RuntimeContractHealthy(
        initialized_,
        config_.requireEveryFrameKeyframe,
        impl_->activeCodec(),
        impl_->activeEncoderName(),
        protectedPacketContractHealthy_.load(std::memory_order_relaxed));
}

VideoCodec VideoEncoder::activeCodec() const {
    return impl_->activeCodec();
}

std::string VideoEncoder::activeCodecName() const {
    return impl_->activeCodecName();
}

std::string VideoEncoder::activeEncoderName() const {
    return impl_->activeEncoderName();
}

std::string VideoEncoder::requestedEncoderMode() const {
    return requestedEncoderModeName(requestedConfig_);
}

std::string VideoEncoder::activeEncoderCategory() const {
    return encoderCategoryName(impl_->activeEncoderName(), impl_->isHardwareEncoder());
}

std::string VideoEncoder::encoderFallbackReason() const {
    return fallbackReason_;
}

std::string VideoEncoder::activeInputFormatName() const {
    return impl_->activeInputFormatName();
}

bool VideoEncoder::isHardwareEncoderActive() const {
    return impl_->isHardwareEncoder();
}

EncodeFailureKind VideoEncoder::lastEncodeFailureKind() const {
    return impl_->lastEncodeFailureKind();
}

std::string VideoEncoder::resolveFfmpegPath(const std::string &configuredPath) {
    return resolveFfmpegPathImpl(configuredPath).string();
}

FfmpegProbeInfo VideoEncoder::probeFfmpeg(const std::string &configuredPath) {
    return probeFfmpegImpl(configuredPath);
}

}  // namespace versus::video
