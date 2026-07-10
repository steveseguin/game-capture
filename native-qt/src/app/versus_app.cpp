#include "versus/app/versus_app.h"

#include "versus/video/aspect_fit.h"

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstddef>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <thread>
#include <utility>

#ifdef _WIN32
#include <windows.h>
#endif

namespace versus::app {
namespace {

#ifndef APP_VERSION
#define APP_VERSION "dev"
#endif

constexpr int64_t kStaleResendMs = 350;
constexpr int64_t kPeriodicKeyframeMs = 2500;
constexpr int64_t kDataInfoIntervalMs = 2000;
constexpr int64_t kPrimaryAudioActiveWindowMs = 250;
constexpr int64_t kRoomInitGracePeriodMs = 1500;
constexpr int64_t kDirectInitGracePeriodMs = 1000;
constexpr int64_t kDisconnectedPeerPruneMs = 10000;
constexpr int64_t kResizeKeyframeCooldownMs = 700;
constexpr int64_t kPendingRemoteCandidateTtlMs = 15000;
constexpr int kHardwareFailSampleWindow = 300;
constexpr double kHardwareFailRatioThreshold = 0.35;
constexpr int kHardwareMaxSelfRecoveries = 2;
constexpr int kLqWidth = 640;
constexpr int kLqHeight = 360;
constexpr int kLqFps = 30;
constexpr int kLqBitrateKbps = 2000;
constexpr std::size_t kPendingRemoteCandidatesMaxPerPeer = 100;

int64_t steadyNowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

#ifdef _WIN32
uint64_t fileTimeToUint64(const FILETIME &value) {
    ULARGE_INTEGER converted{};
    converted.LowPart = value.dwLowDateTime;
    converted.HighPart = value.dwHighDateTime;
    return converted.QuadPart;
}
#endif

std::string toLowerCopy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

const char *hardwareEncoderLabel(video::HardwareEncoder encoder) {
    switch (encoder) {
        case video::HardwareEncoder::NVENC:
            return "NVENC";
        case video::HardwareEncoder::QuickSync:
            return "QuickSync";
        case video::HardwareEncoder::AMF:
            return "AMF";
        case video::HardwareEncoder::None:
        default:
            return "Software";
    }
}

bool encoderNameMatchesHardwarePreference(const std::string &encoderName, video::HardwareEncoder mode) {
    const std::string lower = toLowerCopy(encoderName);
    switch (mode) {
        case video::HardwareEncoder::NVENC:
            return lower.find("nvidia") != std::string::npos ||
                   lower.find("nvenc") != std::string::npos ||
                   lower.find("geforce") != std::string::npos;
        case video::HardwareEncoder::QuickSync:
            return lower.find("intel") != std::string::npos ||
                   lower.find("quick sync") != std::string::npos ||
                   lower.find("qsv") != std::string::npos;
        case video::HardwareEncoder::AMF:
            return lower.find("amd") != std::string::npos ||
                   lower.find("amf") != std::string::npos ||
                   lower.find("radeon") != std::string::npos;
        case video::HardwareEncoder::None:
        default:
            return false;
    }
}

bool isStreamIdInUseAlert(const std::string &messageLower) {
    return messageLower.find("streamid-already-published") != std::string::npos ||
           messageLower.find("already in use") != std::string::npos ||
           messageLower.find("already has this stream id") != std::string::npos ||
           messageLower.find("already has this streamid") != std::string::npos ||
           messageLower.find("duplicate stream") != std::string::npos ||
           ((messageLower.find("stream") != std::string::npos ||
             messageLower.find("stream id") != std::string::npos ||
             messageLower.find("streamid") != std::string::npos) &&
            (messageLower.find("in use") != std::string::npos ||
             messageLower.find("already has") != std::string::npos));
}

bool jsonBoolLike(const nlohmann::json &value, bool defaultValue) {
    if (value.is_boolean()) {
        return value.get<bool>();
    }
    if (value.is_number_integer()) {
        if (value.is_number_unsigned()) {
            return value.get<uint64_t>() != 0;
        }
        return value.get<int64_t>() != 0;
    }
    if (value.is_number_float()) {
        const double numeric = value.get<double>();
        return std::isfinite(numeric) ? numeric != 0.0 : defaultValue;
    }
    if (value.is_string()) {
        const std::string lower = toLowerCopy(value.get<std::string>());
        if (lower == "1" || lower == "true" || lower == "yes" || lower == "on") {
            return true;
        }
        if (lower == "0" || lower == "false" || lower == "no" || lower == "off") {
            return false;
        }
    }
    return defaultValue;
}

bool jsonToggleBool(const nlohmann::json &value, bool currentValue, bool defaultValue) {
    if (value.is_string()) {
        const std::string lower = toLowerCopy(value.get<std::string>());
        if (lower == "toggle") {
            return !currentValue;
        }
    }
    return jsonBoolLike(value, defaultValue);
}

int jsonIntLike(const nlohmann::json &value, int defaultValue = 0) {
    if (value.is_number_integer()) {
        if (value.is_number_unsigned()) {
            const auto numeric = value.get<uint64_t>();
            if (numeric > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
                return std::numeric_limits<int>::max();
            }
            return static_cast<int>(numeric);
        }
        const auto numeric = value.get<int64_t>();
        if (numeric > static_cast<int64_t>(std::numeric_limits<int>::max())) {
            return std::numeric_limits<int>::max();
        }
        if (numeric < static_cast<int64_t>(std::numeric_limits<int>::min())) {
            return std::numeric_limits<int>::min();
        }
        return static_cast<int>(numeric);
    }
    if (value.is_number_float()) {
        const double rounded = std::round(value.get<double>());
        if (!std::isfinite(rounded)) {
            return defaultValue;
        }
        if (rounded > static_cast<double>(std::numeric_limits<int>::max())) {
            return std::numeric_limits<int>::max();
        }
        if (rounded < static_cast<double>(std::numeric_limits<int>::min())) {
            return std::numeric_limits<int>::min();
        }
        return static_cast<int>(rounded);
    }
    if (value.is_string()) {
        try {
            return std::stoi(value.get<std::string>());
        } catch (...) {
            return defaultValue;
        }
    }
    return defaultValue;
}

bool parseResolutionString(const std::string &value, int &width, int &height) {
    const auto xPos = value.find('x');
    if (xPos == std::string::npos) {
        return false;
    }
    try {
        width = std::stoi(value.substr(0, xPos));
        height = std::stoi(value.substr(xPos + 1));
        return width > 0 && height > 0;
    } catch (...) {
        width = 0;
        height = 0;
        return false;
    }
}

std::string resolutionLabel(int width, int height) {
    if (width <= 0 || height <= 0) {
        return {};
    }
    return std::to_string(width) + " x " + std::to_string(height);
}

bool sdpAnswerRejectsVideoMLine(const std::string &sdp) {
    std::istringstream stream(sdp);
    std::string line;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }
        if (line.rfind("m=video ", 0) != 0) {
            continue;
        }

        std::istringstream media(line);
        std::string mediaType;
        int port = -1;
        media >> mediaType >> port;
        return port == 0;
    }
    return false;
}

int clampEvenDimension(int value, int minimum, int maximum) {
    const int clamped = std::clamp(value, minimum, maximum);
    return std::max(2, clamped & ~1);
}

int deriveAspectDimension(int knownValue, int knownAspect, int derivedAspect) {
    if (knownValue <= 0 || knownAspect <= 0 || derivedAspect <= 0) {
        return 0;
    }
    return std::max(1, static_cast<int>(std::lround(
                           static_cast<double>(knownValue) *
                           static_cast<double>(derivedAspect) /
                           static_cast<double>(knownAspect))));
}

struct CompletedResolution {
    int width = 0;
    int height = 0;
};

CompletedResolution completeResolutionRequest(int requestedWidth,
                                              int requestedHeight,
                                              int aspectWidth,
                                              int aspectHeight) {
    constexpr int kMinWidth = 160;
    constexpr int kMaxWidth = 3840;
    constexpr int kMinHeight = 90;
    constexpr int kMaxHeight = 2160;

    CompletedResolution result;
    const bool widthRequested = requestedWidth > 0;
    const bool heightRequested = requestedHeight > 0;
    if (!widthRequested && !heightRequested) {
        return result;
    }

    const int baseWidth = aspectWidth > 0 ? aspectWidth : 16;
    const int baseHeight = aspectHeight > 0 ? aspectHeight : 9;

    if (widthRequested && heightRequested) {
        result.width = clampEvenDimension(requestedWidth, kMinWidth, kMaxWidth);
        result.height = clampEvenDimension(requestedHeight, kMinHeight, kMaxHeight);
        return result;
    }

    if (heightRequested) {
        result.height = clampEvenDimension(requestedHeight, kMinHeight, kMaxHeight);
        const int derivedWidth = deriveAspectDimension(result.height, baseHeight, baseWidth);
        if (derivedWidth > kMaxWidth) {
            result.width = kMaxWidth;
            result.height = clampEvenDimension(
                deriveAspectDimension(result.width, baseWidth, baseHeight),
                kMinHeight,
                kMaxHeight);
        } else if (derivedWidth < kMinWidth) {
            result.width = kMinWidth;
            result.height = clampEvenDimension(
                deriveAspectDimension(result.width, baseWidth, baseHeight),
                kMinHeight,
                kMaxHeight);
        } else {
            result.width = clampEvenDimension(derivedWidth, kMinWidth, kMaxWidth);
        }
        return result;
    }

    result.width = clampEvenDimension(requestedWidth, kMinWidth, kMaxWidth);
    const int derivedHeight = deriveAspectDimension(result.width, baseWidth, baseHeight);
    if (derivedHeight > kMaxHeight) {
        result.height = kMaxHeight;
        result.width = clampEvenDimension(
            deriveAspectDimension(result.height, baseHeight, baseWidth),
            kMinWidth,
            kMaxWidth);
    } else if (derivedHeight < kMinHeight) {
        result.height = kMinHeight;
        result.width = clampEvenDimension(
            deriveAspectDimension(result.height, baseHeight, baseWidth),
            kMinWidth,
            kMaxWidth);
    } else {
        result.height = clampEvenDimension(derivedHeight, kMinHeight, kMaxHeight);
    }
    return result;
}

CompletedResolution completeVdoScaleResolutionRequest(int requestedWidth,
                                                      int requestedHeight,
                                                      bool cover,
                                                      int nativeWidth,
                                                      int nativeHeight) {
    const int baseWidth = nativeWidth > 0 ? nativeWidth : 16;
    const int baseHeight = nativeHeight > 0 ? nativeHeight : 9;
    const bool widthRequested = requestedWidth > 0;
    const bool heightRequested = requestedHeight > 0;
    if (!widthRequested && !heightRequested) {
        return {};
    }

    double scale = 1.0;
    if (!widthRequested) {
        scale = static_cast<double>(requestedHeight) / static_cast<double>(baseHeight);
    } else if (!heightRequested) {
        scale = static_cast<double>(requestedWidth) / static_cast<double>(baseWidth);
    } else {
        const double widthScale = static_cast<double>(requestedWidth) / static_cast<double>(baseWidth);
        const double heightScale = static_cast<double>(requestedHeight) / static_cast<double>(baseHeight);
        scale = cover ? std::max(widthScale, heightScale) : std::min(widthScale, heightScale);
    }
    if (!(scale > 0.0)) {
        return {};
    }
    scale = std::min(scale, 1.0);

    const int scaledWidth = std::max(2, static_cast<int>(std::lround(static_cast<double>(baseWidth) * scale)) & ~1);
    const int scaledHeight = std::max(2, static_cast<int>(std::lround(static_cast<double>(baseHeight) * scale)) & ~1);
    return completeResolutionRequest(scaledWidth, scaledHeight, baseWidth, baseHeight);
}

bool buildAspectFitAlphaPlane(const video::CapturedFrame &frame,
                              int dstW,
                              int dstH,
                              std::vector<uint8_t> &out) {
    if (frame.format != video::CapturedFrame::Format::BGRA ||
        frame.width <= 0 ||
        frame.height <= 0 ||
        frame.stride < frame.width * 4 ||
        dstW <= 0 ||
        dstH <= 0 ||
        frame.data.size() < static_cast<size_t>(frame.stride) * static_cast<size_t>(frame.height)) {
        return false;
    }

    const size_t outputSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH);
    const video::AspectFitRect fit = video::computeAspectFitRect(frame.width, frame.height, dstW, dstH);
    if (fit.width <= 0 || fit.height <= 0) {
        return false;
    }

    const uint8_t *src = frame.data.data();
    if (fit.x == 0 && fit.y == 0 &&
        fit.width == dstW && fit.height == dstH &&
        frame.width == dstW && frame.height == dstH) {
        out.resize(outputSize);
        for (int y = 0; y < dstH; ++y) {
            const size_t srcRow = static_cast<size_t>(y) * static_cast<size_t>(frame.stride);
            const size_t dstRow = static_cast<size_t>(y) * static_cast<size_t>(dstW);
            for (int x = 0; x < dstW; ++x) {
                out[dstRow + static_cast<size_t>(x)] =
                    src[srcRow + static_cast<size_t>(x) * 4 + 3];
            }
        }
        return true;
    }

    out.assign(outputSize, 0);
    for (int y = 0; y < fit.height; ++y) {
        const int srcY = (y * frame.height) / fit.height;
        const size_t srcRow = static_cast<size_t>(srcY) * static_cast<size_t>(frame.stride);
        const size_t dstRow = static_cast<size_t>(fit.y + y) * static_cast<size_t>(dstW) +
                              static_cast<size_t>(fit.x);
        for (int x = 0; x < fit.width; ++x) {
            const int srcX = (x * frame.width) / fit.width;
            out[dstRow + static_cast<size_t>(x)] =
                src[srcRow + static_cast<size_t>(srcX) * 4 + 3];
        }
    }
    return true;
}

bool compositeAlphaBackground(const video::CapturedFrame &frame,
                              const video::EncoderConfig &config,
                              std::vector<uint8_t> &scratch,
                              video::CapturedFrame &out) {
    if (config.alphaBackgroundMode == video::AlphaBackgroundMode::None ||
        config.enableAlpha ||
        frame.format != video::CapturedFrame::Format::BGRA ||
        frame.width <= 0 ||
        frame.height <= 0 ||
        frame.stride < frame.width * 4 ||
        frame.data.size() < static_cast<size_t>(frame.stride) * static_cast<size_t>(frame.height)) {
        return false;
    }

    const size_t outputStride = static_cast<size_t>(frame.width) * 4;
    const size_t outputSize = outputStride * static_cast<size_t>(frame.height);
    scratch.resize(outputSize);

    const int bgR = std::clamp<int>(config.alphaBackgroundRed, 0, 255);
    const int bgG = std::clamp<int>(config.alphaBackgroundGreen, 0, 255);
    const int bgB = std::clamp<int>(config.alphaBackgroundBlue, 0, 255);

    for (int y = 0; y < frame.height; ++y) {
        const uint8_t *srcRow = frame.data.data() + static_cast<size_t>(y) * static_cast<size_t>(frame.stride);
        uint8_t *dstRow = scratch.data() + static_cast<size_t>(y) * outputStride;
        for (int x = 0; x < frame.width; ++x) {
            const uint8_t *src = srcRow + static_cast<size_t>(x) * 4;
            uint8_t *dst = dstRow + static_cast<size_t>(x) * 4;
            const int a = src[3];
            if (a >= 255) {
                dst[0] = src[0];
                dst[1] = src[1];
                dst[2] = src[2];
            } else if (a <= 0) {
                dst[0] = static_cast<uint8_t>(bgB);
                dst[1] = static_cast<uint8_t>(bgG);
                dst[2] = static_cast<uint8_t>(bgR);
            } else {
                const int invA = 255 - a;
                dst[0] = static_cast<uint8_t>((static_cast<int>(src[0]) * a + bgB * invA + 127) / 255);
                dst[1] = static_cast<uint8_t>((static_cast<int>(src[1]) * a + bgG * invA + 127) / 255);
                dst[2] = static_cast<uint8_t>((static_cast<int>(src[2]) * a + bgR * invA + 127) / 255);
            }
            dst[3] = 255;
        }
    }

    out = frame;
    out.data = scratch;
    out.stride = static_cast<int>(outputStride);
    out.format = video::CapturedFrame::Format::BGRA;
    return true;
}

std::string redactPasswordQueryValue(std::string url) {
    constexpr const char *kPasswordParam = "password=";
    constexpr size_t kPasswordParamLength = 9;

    size_t searchFrom = 0;
    while (true) {
        const size_t paramPos = url.find(kPasswordParam, searchFrom);
        if (paramPos == std::string::npos) {
            break;
        }

        const size_t valueStart = paramPos + kPasswordParamLength;
        const size_t valueEnd = url.find('&', valueStart);
        const std::string value = url.substr(
            valueStart,
            valueEnd == std::string::npos ? std::string::npos : valueEnd - valueStart);
        if (value != "false" && value != "0" && value != "off") {
            url.replace(
                valueStart,
                valueEnd == std::string::npos ? std::string::npos : valueEnd - valueStart,
                "<redacted>");
        }

        if (valueEnd == std::string::npos) {
            break;
        }
        searchFrom = valueEnd + 1;
    }
    return url;
}

const char *videoCodecName(video::VideoCodec codec) {
    switch (codec) {
        case video::VideoCodec::H264:
            return "H.264";
        case video::VideoCodec::H265:
            return "H.265";
        case video::VideoCodec::VP8:
            return "VP8";
        case video::VideoCodec::VP9:
            return "VP9";
        case video::VideoCodec::AV1:
            return "AV1";
        default:
            return "Unknown";
    }
}

const char *alphaBackgroundModeName(video::AlphaBackgroundMode mode) {
    switch (mode) {
        case video::AlphaBackgroundMode::Chroma:
            return "chroma";
        case video::AlphaBackgroundMode::Opaque:
            return "opaque";
        case video::AlphaBackgroundMode::None:
        default:
            return "none";
    }
}

const char *connectionStateName(webrtc::ConnectionState state) {
    switch (state) {
        case webrtc::ConnectionState::Disconnected:
            return "disconnected";
        case webrtc::ConnectionState::Connecting:
            return "connecting";
        case webrtc::ConnectionState::Connected:
            return "connected";
        case webrtc::ConnectionState::Failed:
            return "failed";
        case webrtc::ConnectionState::Closed:
            return "closed";
        default:
            return "unknown";
    }
}

const char *audioSourceModeName(AudioSourceMode mode) {
    switch (mode) {
        case AudioSourceMode::SelectedWindow:
            return "selected-window";
        case AudioSourceMode::DefaultOutput:
            return "default-output";
        case AudioSourceMode::CommunicationsOutput:
            return "communications-output";
        case AudioSourceMode::DefaultMicrophone:
            return "default-microphone";
        case AudioSourceMode::None:
        default:
            return "none";
    }
}

const char *videoSourceModeName(VideoSourceMode mode) {
    switch (mode) {
        case VideoSourceMode::Spout:
            return "spout";
        case VideoSourceMode::Window:
        default:
            return "window";
    }
}

nlohmann::json integerRange(int minValue, int maxValue, int step = 0) {
    nlohmann::json range = {
        {"min", minValue},
        {"max", maxValue}
    };
    if (step > 0) {
        range["step"] = step;
    }
    return range;
}

std::vector<float> normalizeAudioForOpus(const audio::StreamChunk &chunk) {
    constexpr uint32_t kOpusSampleRate = 48000;
    constexpr uint32_t kOpusChannels = 2;

    const uint32_t inputChannels = std::max<uint32_t>(1, chunk.channels);
    const uint32_t inputSampleRate = std::max<uint32_t>(1, chunk.sampleRate);
    const size_t inputFrames = chunk.samples.size() / inputChannels;
    if (inputFrames == 0) {
        return {};
    }

    std::vector<float> stereo;
    stereo.resize(inputFrames * kOpusChannels);
    for (size_t frame = 0; frame < inputFrames; ++frame) {
        const size_t src = frame * inputChannels;
        float left = 0.0f;
        float right = 0.0f;
        if (inputChannels == 1) {
            left = chunk.samples[src];
            right = left;
        } else if (inputChannels == 2) {
            left = chunk.samples[src];
            right = chunk.samples[src + 1];
        } else {
            uint32_t leftCount = 0;
            uint32_t rightCount = 0;
            for (uint32_t ch = 0; ch < inputChannels; ++ch) {
                if ((ch % 2) == 0) {
                    left += chunk.samples[src + ch];
                    leftCount++;
                } else {
                    right += chunk.samples[src + ch];
                    rightCount++;
                }
            }
            left /= static_cast<float>(std::max<uint32_t>(1, leftCount));
            right /= static_cast<float>(std::max<uint32_t>(1, rightCount));
        }
        stereo[(frame * kOpusChannels)] = left;
        stereo[(frame * kOpusChannels) + 1] = right;
    }

    if (inputSampleRate == kOpusSampleRate) {
        return stereo;
    }

    const size_t outputFrames = std::max<size_t>(
        1,
        static_cast<size_t>(std::ceil(
            (static_cast<double>(inputFrames) * static_cast<double>(kOpusSampleRate)) /
            static_cast<double>(inputSampleRate))));
    std::vector<float> resampled;
    resampled.resize(outputFrames * kOpusChannels);

    const double step = static_cast<double>(inputSampleRate) / static_cast<double>(kOpusSampleRate);
    for (size_t frame = 0; frame < outputFrames; ++frame) {
        const double srcPos = static_cast<double>(frame) * step;
        const size_t srcFrame = std::min<size_t>(static_cast<size_t>(srcPos), inputFrames - 1);
        const size_t nextFrame = std::min<size_t>(srcFrame + 1, inputFrames - 1);
        const float mix = static_cast<float>(srcPos - static_cast<double>(srcFrame));
        for (size_t ch = 0; ch < kOpusChannels; ++ch) {
            const float a = stereo[(srcFrame * kOpusChannels) + ch];
            const float b = stereo[(nextFrame * kOpusChannels) + ch];
            resampled[(frame * kOpusChannels) + ch] = a + ((b - a) * mix);
        }
    }

    return resampled;
}

std::string publisherVersionTag() {
    return std::string("game-capture-native-qt/") + APP_VERSION;
}

webrtc::PeerConfig::VideoCodec toPeerVideoCodec(video::VideoCodec codec) {
    switch (codec) {
        case video::VideoCodec::H265:
            return webrtc::PeerConfig::VideoCodec::H265;
        case video::VideoCodec::AV1:
            return webrtc::PeerConfig::VideoCodec::AV1;
        case video::VideoCodec::VP9:
            return webrtc::PeerConfig::VideoCodec::VP9;
        case video::VideoCodec::H264:
        case video::VideoCodec::VP8:
        default:
            return webrtc::PeerConfig::VideoCodec::H264;
    }
}

bool supportsVp9AlphaTrack(video::VideoCodec codec) {
    return codec == video::VideoCodec::H264 || codec == video::VideoCodec::VP9;
}

bool usesVp9AlphaTrack(const video::EncoderConfig &config) {
    return config.enableAlpha && supportsVp9AlphaTrack(config.codec);
}

std::pair<int, int> alphaTrackDimensions(const video::EncoderConfig &config, int primaryWidth, int primaryHeight) {
    int width = std::max(2, primaryWidth & ~1);
    int height = std::max(2, primaryHeight & ~1);
    const int64_t pixels = static_cast<int64_t>(width) * static_cast<int64_t>(height);
    if (config.codec == video::VideoCodec::H264 &&
        config.enableAlpha &&
        pixels >= (3840LL * 2160LL)) {
        width = std::max(2, (width / 4) & ~1);
        height = std::max(2, (height / 4) & ~1);
    } else if (config.codec == video::VideoCodec::H264 &&
        config.enableAlpha &&
        config.frameRate >= 50 &&
        pixels > (1280LL * 720LL)) {
        width = std::max(2, (width / 2) & ~1);
        height = std::max(2, (height / 2) & ~1);
    }
    return {width, height};
}

video::EncoderConfig primaryVideoEncoderConfig(video::EncoderConfig config) {
    if (usesVp9AlphaTrack(config)) {
        // Dual-track alpha sends color and alpha through separate encoders.
        // The primary can be VP9 or H.264; the alpha mask is always VP9.
        config.enableAlpha = false;
    }
    return config;
}

video::EncoderConfig alphaVideoEncoderConfig(video::EncoderConfig config) {
    const auto [alphaWidth, alphaHeight] = alphaTrackDimensions(config, config.width, config.height);
    config.codec = video::VideoCodec::VP9;
    config.enableAlpha = true;
    config.width = alphaWidth;
    config.height = alphaHeight;
    config.bitrate = std::max(500, config.bitrate / 4);
    config.minBitrate = std::max(250, config.bitrate / 2);
    config.maxBitrate = std::max(config.bitrate + 1000, (config.bitrate * 3) / 2);
    config.preferredHardware = video::HardwareEncoder::None;
    return config;
}

}  // namespace

VersusApp::VersusApp() = default;
VersusApp::~VersusApp() { shutdown(); }

bool VersusApp::initialize() {
    setupCallbacks();
    return true;
}

void VersusApp::shutdown() {
    stopLive();
    stopCapture();
    waitForPendingPeerShutdowns();
}

std::vector<versus::video::WindowInfo> VersusApp::listWindows() {
    return windowCapture_.getWindows();
}

std::vector<versus::video::WindowInfo> VersusApp::listSpoutSenders() {
    return spoutCapture_.getSenders();
}

std::vector<versus::audio::AudioDeviceInfo> VersusApp::listAudioInputDevices() {
    return audioCapture_.GetInputDevices();
}

bool VersusApp::startCapture(const std::string &windowId) {
    return startCapture(videoSourceMode_, windowId);
}

bool VersusApp::startCapture(VideoSourceMode mode, const std::string &sourceId) {
    if (capturing_) {
        stopCapture();
    }

    audioPts100ns_.store(0);
    audioLevelRms_.store(0.0f);
    audioPeak_.store(0.0f);
    primaryAudioLevelRms_.store(0.0f, std::memory_order_relaxed);
    primaryAudioPeak_.store(0.0f, std::memory_order_relaxed);
    additionalAudioLevelRms_.store(0.0f, std::memory_order_relaxed);
    additionalAudioPeak_.store(0.0f, std::memory_order_relaxed);
    lastPrimaryAudioChunkMs_.store(0, std::memory_order_relaxed);
    videoBytesSent_.store(0, std::memory_order_relaxed);
    audioBytesSent_.store(0, std::memory_order_relaxed);
    videoFramesCaptured_.store(0, std::memory_order_relaxed);
    videoFramesSent_.store(0, std::memory_order_relaxed);
    videoFramesDropped_.store(0, std::memory_order_relaxed);
    audioPacketsSent_.store(0, std::memory_order_relaxed);
    videoEncodeFailures_.store(0, std::memory_order_relaxed);
    videoEncodeTimeouts_.store(0, std::memory_order_relaxed);
    videoEncodeHardFailures_.store(0, std::memory_order_relaxed);
    videoSendFailures_.store(0, std::memory_order_relaxed);
    alphaPacketsSent_.store(0, std::memory_order_relaxed);
    alphaEncodeFailures_.store(0, std::memory_order_relaxed);
    alphaEncodeTimeouts_.store(0, std::memory_order_relaxed);
    alphaFramesQueued_.store(0, std::memory_order_relaxed);
    alphaFramesDropped_.store(0, std::memory_order_relaxed);
    alphaSendFailures_.store(0, std::memory_order_relaxed);
    audioSendFailures_.store(0, std::memory_order_relaxed);
    const int64_t metricsStartMs = steadyNowMs();
    metricsStartMs_.store(metricsStartMs, std::memory_order_relaxed);
    resetMetricsWindow(metricsStartMs);
    lastSentWidth_.store(0, std::memory_order_relaxed);
    lastSentHeight_.store(0, std::memory_order_relaxed);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(false);
    captureBackendFailureNotified_.store(false, std::memory_order_relaxed);
    lastVideoSendMs_.store(0);
    lastKeyframeSendMs_.store(0);
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        activeHqWidth_ = 0;
        activeHqHeight_ = 0;
        lastCaptureWidth_ = 0;
        lastCaptureHeight_ = 0;
        lastCaptureResizeMs_ = 0;
        lastHqReconfigureMs_ = 0;
        lastResizeKeyframeRequestMs_ = 0;
        hardwareEncodeSampleCount_ = 0;
        hardwareEncodeFailCount_ = 0;
        hardwareRecoveryAttemptCount_ = 0;
        hardwareAutoFallbackTriggered_ = false;
        softwareExternalEncodeFailCount_ = 0;
        softwareExternalFailWindowStartMs_ = 0;
        hqAspectLocked_ = false;
        lqEncoderInitialized_.store(false, std::memory_order_relaxed);
        publishVideoStateSnapshotLocked();
    }
    {
        std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
        hasLatestVideoFrame_ = false;
        latestVideoFrame_ = video::CapturedFrame{};
    }
    selectedWindowId_ = sourceId;
    videoSourceMode_ = mode;
    resetSourceHealth(mode, sourceId);
    uint32_t selectedWindowProcessId = 0;
    if (mode == VideoSourceMode::Window && !selectedWindowId_.empty()) {
        if (!windowCapture_.startCapture(sourceId, 1920, 1080, 60)) {
            return false;
        }
        auto windows = windowCapture_.getWindows();
        for (const auto &info : windows) {
            if (info.id == selectedWindowId_) {
                selectedWindowProcessId = info.processId;
                break;
            }
        }
    } else if (mode == VideoSourceMode::Spout) {
        video::EncoderConfig captureConfig;
        {
            std::lock_guard<std::mutex> lock(videoSendMutex_);
            captureConfig = videoConfig_;
        }
        if (!spoutCapture_.startCapture(
                sourceId,
                captureConfig.width,
                captureConfig.height,
                captureConfig.frameRate > 0 ? captureConfig.frameRate : 60)) {
            return false;
        }
    } else {
        return false;
    }
    startAudioCapture(selectedWindowProcessId);

    video::EncoderConfig config;
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        config = videoConfig_;
    }
    if (config.width == 0 || config.height == 0) {
        config.width = 1920;
        config.height = 1080;
        config.frameRate = 60;
        config.bitrate = 12000;
    }
    const video::EncoderConfig requestedConfig = config;
    const bool alphaRequested = usesVp9AlphaTrack(requestedConfig);
    video::EncoderConfig primaryConfig = primaryVideoEncoderConfig(config);
    std::string activeEncoderName;
    bool activeHardwareEncoder = false;
    bool alphaEncoderOk = false;
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        if (!videoEncoder_.initialize(primaryConfig)) {
            if (alphaRequested) {
                spdlog::error("[App] Primary encoder failed to initialize for explicit VP9 alpha workflow");
                emitRuntimeEvent(
                    "Primary encoder failed to initialize for VP9 alpha workflow. Use bundled FFmpeg/libvpx, lower FPS/resolution, or use chroma background mode.",
                    true);
                windowCapture_.stopCapture();
                spoutCapture_.stopCapture();
                return false;
            }
            if (config.codec == video::VideoCodec::H264) {
                windowCapture_.stopCapture();
                spoutCapture_.stopCapture();
                return false;
            }

            const video::VideoCodec selectedCodec = config.codec;
            spdlog::warn("[App] Selected {} encoder failed to initialize; trying H.264 fallback",
                         videoCodecName(selectedCodec));

            video::EncoderConfig fallbackConfig = config;
            fallbackConfig.codec = video::VideoCodec::H264;
            fallbackConfig.enableAlpha = false;
            fallbackConfig.forceFfmpegNvenc = false;

            videoEncoder_.shutdown();
            if (!videoEncoder_.initialize(fallbackConfig)) {
                spdlog::error("[App] H.264 fallback encoder failed to initialize after {} startup failure",
                              videoCodecName(selectedCodec));
                windowCapture_.stopCapture();
                spoutCapture_.stopCapture();
                return false;
            }

            config = fallbackConfig;
            primaryConfig = fallbackConfig;
            videoConfig_ = fallbackConfig;
            emitRuntimeEvent(
                std::string("Selected ") + videoCodecName(selectedCodec) +
                    " encoder failed to initialize; switched to H.264 fallback.",
                false);
        }
        activeHqWidth_ = std::max(2, primaryConfig.width & ~1);
        activeHqHeight_ = std::max(2, primaryConfig.height & ~1);
        hqAspectLocked_ = false;
        activeEncoderName = videoEncoder_.activeEncoderName();
        activeHardwareEncoder = videoEncoder_.isHardwareEncoderActive();

        // VP9 alpha: initialize a separate encoder instance for the alpha (gray) track.
        {
            std::lock_guard<std::mutex> alphaLock(alphaEncoderMutex_);
            videoEncoderAlpha_.shutdown();
            if (alphaRequested) {
                alphaEncoderOk = videoEncoderAlpha_.initialize(alphaVideoEncoderConfig(config));
            }
        }
        if (alphaRequested && !alphaEncoderOk) {
            config.enableAlpha = false;
            videoConfig_.enableAlpha = false;
        }
        clearAlphaEncodeQueues();
        publishVideoStateSnapshotLocked();
    }
    if (activeEncoderName.empty()) {
        windowCapture_.stopCapture();
        spoutCapture_.stopCapture();
        return false;
    }
    spdlog::info("[App] Video encoder active: {} (hardware={})",
                 activeEncoderName, activeHardwareEncoder);

    if (alphaRequested) {
        if (!alphaEncoderOk) {
            spdlog::warn("[App] VP9 alpha encoder init failed; streaming without alpha channel");
            emitRuntimeEvent(
                "VP9 alpha track encoder failed to initialize. Transparency is not being sent; use bundled FFmpeg/libvpx, lower FPS/resolution, or use chroma background mode.",
                false);
        } else {
            const auto [alphaWidth, alphaHeight] = alphaTrackDimensions(
                requestedConfig, requestedConfig.width, requestedConfig.height);
            spdlog::info("[App] VP9 alpha encoder active: {} kbps {}x{}",
                         std::max(500, requestedConfig.bitrate / 4),
                         alphaWidth,
                         alphaHeight);
        }
    }

    audio::AudioEncoderConfig audioConfig;
    audioConfig.sampleRate = 48000;
    audioConfig.channels = 2;
    audioConfig.bitrate = audioEncoderBitrateKbps_.load(std::memory_order_relaxed);
    opusEncoder_.initialize(audioConfig);

    const auto frameCallback = [this](video::CapturedFrame frame) {
        handleVideoFrame(std::move(frame));
    };
    windowCapture_.setFrameCallback(frameCallback);
    spoutCapture_.setFrameCallback(frameCallback);

    capturing_ = true;
    startEncodeThread();
    startVideoMaintenanceThread();
    return true;
}

void VersusApp::stopCapture() {
    if (!capturing_) {
        return;
    }

    stopVideoMaintenanceThread();
    stopEncodeThread();
    windowCapture_.stopCapture();
    spoutCapture_.stopCapture();
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        videoEncoder_.shutdown();
        {
            std::lock_guard<std::mutex> alphaLock(alphaEncoderMutex_);
            videoEncoderAlpha_.shutdown();
        }
        clearAlphaEncodeQueues();
        shutdownLqEncoderLocked();
        activeHqWidth_ = 0;
        activeHqHeight_ = 0;
        lastCaptureWidth_ = 0;
        lastCaptureHeight_ = 0;
        lastCaptureResizeMs_ = 0;
        lastHqReconfigureMs_ = 0;
        lastResizeKeyframeRequestMs_ = 0;
        hardwareEncodeSampleCount_ = 0;
        hardwareEncodeFailCount_ = 0;
        hardwareRecoveryAttemptCount_ = 0;
        hardwareAutoFallbackTriggered_ = false;
        softwareExternalEncodeFailCount_ = 0;
        softwareExternalFailWindowStartMs_ = 0;
        hqAspectLocked_ = false;
        publishVideoStateSnapshotLocked();
    }
    audioCapture_.StopCapture();
    microphoneAudioCapture_.StopCapture();
    {
        std::lock_guard<std::mutex> lock(additionalAudioMutex_);
        additionalAudioBuffer_.clear();
        additionalAudioSampleRate_ = 0;
        additionalAudioChannels_ = 0;
    }
    opusEncoder_.shutdown();
    audioLevelRms_.store(0.0f, std::memory_order_relaxed);
    audioPeak_.store(0.0f, std::memory_order_relaxed);
    primaryAudioLevelRms_.store(0.0f, std::memory_order_relaxed);
    primaryAudioPeak_.store(0.0f, std::memory_order_relaxed);
    additionalAudioLevelRms_.store(0.0f, std::memory_order_relaxed);
    additionalAudioPeak_.store(0.0f, std::memory_order_relaxed);
    lastPrimaryAudioChunkMs_.store(0, std::memory_order_relaxed);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(false);
    captureBackendFailureNotified_.store(false, std::memory_order_relaxed);
    lastVideoSendMs_.store(0);
    lastKeyframeSendMs_.store(0);
    resetMetricsWindow(steadyNowMs());
    capturing_ = false;
}

void VersusApp::setSelectedWindow(const std::string &windowId) {
    selectedWindowId_ = windowId;
}

void VersusApp::setVideoSourceMode(VideoSourceMode mode) {
    videoSourceMode_ = mode;
}

void VersusApp::setVideoConfig(const versus::video::EncoderConfig &config) {
    std::lock_guard<std::mutex> lock(videoSendMutex_);
    videoConfig_ = config;
    if (config.bitrate > 0) {
        configuredVideoBitrateKbps_.store(config.bitrate, std::memory_order_relaxed);
    }
    if (!capturing_) {
        activeHqWidth_ = std::max(2, videoConfig_.width & ~1);
        activeHqHeight_ = std::max(2, videoConfig_.height & ~1);
        hqAspectLocked_ = false;
    }
    publishVideoStateSnapshotLocked();
}

void VersusApp::setAudioSourceMode(AudioSourceMode mode) {
    audioSourceMode_ = mode;
}

void VersusApp::setIncludeMicrophone(bool enabled) {
    includeMicrophone_ = enabled;
}

void VersusApp::setMicrophoneDeviceId(const std::string &deviceId) {
    microphoneDeviceId_ = deviceId;
}

void VersusApp::setAudioMixConfig(float primaryGain, float additionalGain, bool limiterEnabled) {
    primaryAudioGain_.store(std::clamp(primaryGain, 0.0f, 2.0f), std::memory_order_relaxed);
    additionalAudioGain_.store(std::clamp(additionalGain, 0.0f, 2.0f), std::memory_order_relaxed);
    audioLimiterEnabled_.store(limiterEnabled, std::memory_order_relaxed);
}

bool VersusApp::goLive(const StartOptions &options) {
    if (live_) {
        return true;
    }

    startOptions_ = options;
    stopRequested_.store(false);
    reconnecting_.store(false);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(true);
    lastVideoSendMs_.store(0);
    lastKeyframeSendMs_.store(0);
    lastRelayWarningMs_.store(0, std::memory_order_relaxed);
    lastPacketLossWarningMs_.store(0, std::memory_order_relaxed);
    lastAlphaWarningMs_.store(0, std::memory_order_relaxed);
    pliWindowStartMs_.store(0, std::memory_order_relaxed);
    pliWindowCount_.store(0, std::memory_order_relaxed);
    lastCpuWarningMs_.store(0, std::memory_order_relaxed);
    softwareOverloadSamples_.store(0, std::memory_order_relaxed);
    hardwareEncodeSampleCount_ = 0;
    hardwareEncodeFailCount_ = 0;
    hardwareRecoveryAttemptCount_ = 0;
    hardwareAutoFallbackTriggered_ = false;
    softwareExternalEncodeFailCount_ = 0;
    softwareExternalFailWindowStartMs_ = 0;
    videoBytesSent_.store(0, std::memory_order_relaxed);
    audioBytesSent_.store(0, std::memory_order_relaxed);
    videoFramesCaptured_.store(0, std::memory_order_relaxed);
    videoFramesSent_.store(0, std::memory_order_relaxed);
    videoFramesDropped_.store(0, std::memory_order_relaxed);
    audioPacketsSent_.store(0, std::memory_order_relaxed);
    videoEncodeFailures_.store(0, std::memory_order_relaxed);
    videoEncodeTimeouts_.store(0, std::memory_order_relaxed);
    videoEncodeHardFailures_.store(0, std::memory_order_relaxed);
    videoSendFailures_.store(0, std::memory_order_relaxed);
    alphaPacketsSent_.store(0, std::memory_order_relaxed);
    alphaEncodeFailures_.store(0, std::memory_order_relaxed);
    alphaEncodeTimeouts_.store(0, std::memory_order_relaxed);
    alphaFramesQueued_.store(0, std::memory_order_relaxed);
    alphaFramesDropped_.store(0, std::memory_order_relaxed);
    alphaSendFailures_.store(0, std::memory_order_relaxed);
    audioSendFailures_.store(0, std::memory_order_relaxed);
    const int64_t metricsStartMs = steadyNowMs();
    metricsStartMs_.store(metricsStartMs, std::memory_order_relaxed);
    resetMetricsWindow(metricsStartMs);
    relayCandidateSeen_.store(false, std::memory_order_relaxed);
    directCandidateSeen_.store(false, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(healthStateMutex_);
        lastPeerDisconnectReason_.clear();
    }

    room_ = options.room;
    password_ = options.password;
    salt_ = options.salt.empty() ? "vdo.ninja" : options.salt;
    maxViewers_.store(std::max(0, options.maxViewers), std::memory_order_relaxed);
    roomModeLqEnabled_.store(options.roomModeLqEnabled, std::memory_order_relaxed);
    remoteControlEnabled_.store(options.remoteControlEnabled, std::memory_order_relaxed);
    remoteControlToken_ = options.remoteControlToken;
    roomCodecWarningEmitted_ = false;
    const auto resolvedIce = webrtc::resolveIceConfig(options.iceMode);
    {
        std::lock_guard<std::mutex> lock(iceConfigMutex_);
        iceMode_ = options.iceMode;
        resolvedIceServers_ = resolvedIce.servers;
    }
    if (options.iceMode == webrtc::IceMode::Relay && !resolvedIce.hasTurnServers()) {
        emitRuntimeEvent("Relay-only ICE mode was requested, but no TURN servers were available.", true);
        return false;
    }

    clearPeerSessions();
    setupSignalingCallbacks();

    if (!enforceRoomCodecLock()) {
        return false;
    }

    spdlog::info("[App] Connecting to signaling server: {}", options.server);
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        if (!signaling_.connect(options.server)) {
            spdlog::error("[App] Failed to connect to signaling server");
            return false;
        }
    }
    spdlog::info("[App] Connected to signaling server");

    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        signaling_.setPassword(password_);
        if (password_ == "false" || password_ == "0" || password_ == "off") {
            spdlog::info("[App] Encryption disabled");
            signaling_.disableEncryption();
        }
    }

    if (!room_.empty()) {
        spdlog::info("[App] Joining room: {}", room_);
        signaling::RoomConfig roomConfig;
        roomConfig.room = room_;
        roomConfig.password = password_;
        roomConfig.label = options.label;
        roomConfig.streamId = options.streamId;
        roomConfig.salt = salt_;
        {
            std::lock_guard<std::mutex> lock(signalingOpsMutex_);
            if (!signaling_.joinRoom(roomConfig)) {
                spdlog::error("[App] Failed to join room");
                signaling_.disconnect();
                return false;
            }
        }
    }

    if (options.streamId.empty()) {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        streamId_ = signaling_.getStreamId();
    } else {
        streamId_ = options.streamId;
    }
    if (streamId_.empty()) {
        streamId_ = "gamecapture_" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
    }

    if (remoteControlEnabled_.load(std::memory_order_relaxed) && remoteControlToken_.empty()) {
        if (!password_.empty() && password_ != "false" && password_ != "0" && password_ != "off") {
            remoteControlToken_ = password_;
        } else {
            remoteControlToken_ = streamId_;
        }
    }
    if (remoteControlEnabled_.load(std::memory_order_relaxed)) {
        spdlog::info("[App] Remote control enabled (tokenLength={})", remoteControlToken_.size());
    }

    spdlog::info("[App] Publishing stream: {}", streamId_);
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        if (!signaling_.publish(streamId_, options.label)) {
            spdlog::error("[App] Failed to publish stream");
            signaling_.disconnect();
            return false;
        }
    }

    std::string viewUrl;
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        viewUrl = signaling_.getViewUrl();
    }
    spdlog::info("[App] ========================================");
    spdlog::info("[App] VIEW URL: {}", redactPasswordQueryValue(viewUrl));
    spdlog::info("[App] ========================================");

    live_ = true;
    startVideoMaintenanceThread();
    return true;
}

void VersusApp::stopLive() {
    if (!live_) {
        stopRequested_.store(true);
        reconnecting_.store(false);
        videoTrackActive_.store(false);
        pendingGlobalKeyframe_.store(false);
        stopSignalingRecoveryThread();
        stopVideoMaintenanceThread();
        clearPeerSessions();
        return;
    }

    stopRequested_.store(true);
    reconnecting_.store(false);
    live_ = false;
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(false);
    stopSignalingRecoveryThread();
    stopVideoMaintenanceThread();
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        signaling_.unpublish();
        signaling_.disconnect();
    }
    clearPeerSessions();
}

std::string VersusApp::getShareLink() const {
    std::lock_guard<std::mutex> lock(signalingOpsMutex_);
    return signaling_.getViewUrl();
}

void VersusApp::onRuntimeEvent(RuntimeEventCallback cb) {
    std::lock_guard<std::mutex> lock(runtimeEventMutex_);
    runtimeEventCallback_ = std::move(cb);
}

void VersusApp::emitRuntimeEvent(const std::string &message, bool fatal) {
    RuntimeEventCallback callback;
    {
        std::lock_guard<std::mutex> lock(runtimeEventMutex_);
        callback = runtimeEventCallback_;
    }
    if (callback) {
        callback(message, fatal);
    }
}

void VersusApp::recordPeerEvent(const std::shared_ptr<PeerSession> &peer, const std::string &event) const {
    if (!peer || event.empty()) {
        return;
    }
    std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
    peer->timeline.push_back(std::to_string(steadyNowMs()) + " " + event);
    while (peer->timeline.size() > 60) {
        peer->timeline.pop_front();
    }
}

std::string VersusApp::getVideoEncoderName() const {
    return videoStateSnapshot().encoderName;
}

std::string VersusApp::getVideoCodecName() const {
    return videoStateSnapshot().codecName;
}

bool VersusApp::isHardwareVideoEncoder() const {
    return videoStateSnapshot().hardwareEncoder;
}

float VersusApp::getAudioLevelRms() const {
    return audioLevelRms_.load(std::memory_order_relaxed);
}

float VersusApp::getAudioPeak() const {
    return audioPeak_.load(std::memory_order_relaxed);
}

float VersusApp::getPrimaryAudioLevelRms() const {
    return primaryAudioLevelRms_.load(std::memory_order_relaxed);
}

float VersusApp::getPrimaryAudioPeak() const {
    return primaryAudioPeak_.load(std::memory_order_relaxed);
}

float VersusApp::getAdditionalAudioLevelRms() const {
    return additionalAudioLevelRms_.load(std::memory_order_relaxed);
}

float VersusApp::getAdditionalAudioPeak() const {
    return additionalAudioPeak_.load(std::memory_order_relaxed);
}

void VersusApp::resetMetricsWindow(int64_t nowMs) {
    std::lock_guard<std::mutex> lock(metricsWindowMutex_);
    recentMetricsLastMs_ = nowMs;
    recentMetricsLastVideoBytes_ = videoBytesSent_.load(std::memory_order_relaxed);
    recentMetricsLastAudioBytes_ = audioBytesSent_.load(std::memory_order_relaxed);
    recentMetricsLastVideoFrames_ = videoFramesSent_.load(std::memory_order_relaxed);
    recentMetricsLastDroppedFrames_ = videoFramesDropped_.load(std::memory_order_relaxed);
    recentVideoBitrateKbps_ = 0.0;
    recentAudioBitrateKbps_ = 0.0;
    recentFrameRate_ = 0.0;
    recentDroppedFrameRate_ = 0.0;
    recentMetricsInitialized_ = false;
}

StreamMetrics VersusApp::buildStreamMetricsSnapshot(bool updateRecentWindow) const {
    StreamMetrics metrics;
    const VideoStateSnapshot videoState = videoStateSnapshot();

    const int64_t nowMs = steadyNowMs();
    const int64_t startedMs = metricsStartMs_.load(std::memory_order_relaxed);
    const int64_t elapsedMs = startedMs > 0 ? std::max<int64_t>(1, nowMs - startedMs) : 1;
    const uint64_t videoBytes = videoBytesSent_.load(std::memory_order_relaxed);
    const uint64_t audioBytes = audioBytesSent_.load(std::memory_order_relaxed);
    const uint64_t videoFrames = videoFramesSent_.load(std::memory_order_relaxed);
    const uint64_t droppedFrames = videoFramesDropped_.load(std::memory_order_relaxed);
    const double lifetimeVideoKbps = (static_cast<double>(videoBytes) * 8.0) / static_cast<double>(elapsedMs);
    const double lifetimeAudioKbps = (static_cast<double>(audioBytes) * 8.0) / static_cast<double>(elapsedMs);
    const double lifetimeFps = (static_cast<double>(videoFrames) * 1000.0) / static_cast<double>(elapsedMs);
    const double lifetimeDroppedFps = (static_cast<double>(droppedFrames) * 1000.0) / static_cast<double>(elapsedMs);

    {
        std::lock_guard<std::mutex> lock(metricsWindowMutex_);
        if (!recentMetricsInitialized_) {
            recentMetricsLastMs_ = nowMs;
            recentMetricsLastVideoBytes_ = videoBytes;
            recentMetricsLastAudioBytes_ = audioBytes;
            recentMetricsLastVideoFrames_ = videoFrames;
            recentMetricsLastDroppedFrames_ = droppedFrames;
            recentVideoBitrateKbps_ = lifetimeVideoKbps;
            recentAudioBitrateKbps_ = lifetimeAudioKbps;
            recentFrameRate_ = lifetimeFps;
            recentDroppedFrameRate_ = lifetimeDroppedFps;
            recentMetricsInitialized_ = true;
        } else if (updateRecentWindow) {
            const int64_t deltaMs = nowMs - recentMetricsLastMs_;
            if (deltaMs >= 750) {
                const auto safeDelta = [](uint64_t current, uint64_t previous) {
                    return current >= previous ? current - previous : uint64_t{0};
                };
                const double instantVideoKbps =
                    (static_cast<double>(safeDelta(videoBytes, recentMetricsLastVideoBytes_)) * 8.0) /
                    static_cast<double>(deltaMs);
                const double instantAudioKbps =
                    (static_cast<double>(safeDelta(audioBytes, recentMetricsLastAudioBytes_)) * 8.0) /
                    static_cast<double>(deltaMs);
                const double instantFps =
                    (static_cast<double>(safeDelta(videoFrames, recentMetricsLastVideoFrames_)) * 1000.0) /
                    static_cast<double>(deltaMs);
                const double instantDroppedFps =
                    (static_cast<double>(safeDelta(droppedFrames, recentMetricsLastDroppedFrames_)) * 1000.0) /
                    static_cast<double>(deltaMs);

                constexpr double kSmoothing = 0.35;
                recentVideoBitrateKbps_ =
                    (recentVideoBitrateKbps_ <= 0.0) ? instantVideoKbps
                                                     : (recentVideoBitrateKbps_ * (1.0 - kSmoothing)) +
                                                           (instantVideoKbps * kSmoothing);
                recentAudioBitrateKbps_ =
                    (recentAudioBitrateKbps_ <= 0.0) ? instantAudioKbps
                                                     : (recentAudioBitrateKbps_ * (1.0 - kSmoothing)) +
                                                           (instantAudioKbps * kSmoothing);
                recentFrameRate_ =
                    (recentFrameRate_ <= 0.0) ? instantFps
                                              : (recentFrameRate_ * (1.0 - kSmoothing)) +
                                                    (instantFps * kSmoothing);
                recentDroppedFrameRate_ =
                    (recentDroppedFrameRate_ <= 0.0) ? instantDroppedFps
                                                     : (recentDroppedFrameRate_ * (1.0 - kSmoothing)) +
                                                           (instantDroppedFps * kSmoothing);
                recentMetricsLastMs_ = nowMs;
                recentMetricsLastVideoBytes_ = videoBytes;
                recentMetricsLastAudioBytes_ = audioBytes;
                recentMetricsLastVideoFrames_ = videoFrames;
                recentMetricsLastDroppedFrames_ = droppedFrames;
            }
        }

        metrics.videoBitrateKbps = recentVideoBitrateKbps_;
        metrics.audioBitrateKbps = recentAudioBitrateKbps_;
        metrics.frameRate = recentFrameRate_;
        metrics.droppedFrameRate = recentDroppedFrameRate_;
    }

    if (metrics.videoBitrateKbps <= 0.0) {
        metrics.videoBitrateKbps = lifetimeVideoKbps;
    }
    if (metrics.audioBitrateKbps <= 0.0) {
        metrics.audioBitrateKbps = lifetimeAudioKbps;
    }
    if (metrics.frameRate <= 0.0) {
        metrics.frameRate = lifetimeFps;
    }
    if (metrics.droppedFrameRate <= 0.0) {
        metrics.droppedFrameRate = lifetimeDroppedFps;
    }
    metrics.width = lastSentWidth_.load(std::memory_order_relaxed);
    metrics.height = lastSentHeight_.load(std::memory_order_relaxed);
    if (metrics.width <= 0 || metrics.height <= 0) {
        metrics.width = videoState.hqWidth;
        metrics.height = videoState.hqHeight;
    }
    metrics.codec = videoState.codecName;
    metrics.encoder = videoState.encoderName;

    const PeerCounts counts = collectPeerCounts();
    metrics.peerCount = counts.total;
    metrics.hqPeerCount = counts.hq;
    metrics.lqPeerCount = counts.lq;
    metrics.activeVideoPeers = counts.activeVideo;
    metrics.activeAudioPeers = counts.activeAudio;
    metrics.videoFramesCaptured = videoFramesCaptured_.load(std::memory_order_relaxed);
    metrics.videoFramesSent = videoFrames;
    metrics.videoFramesDropped = droppedFrames;
    metrics.audioPacketsSent = audioPacketsSent_.load(std::memory_order_relaxed);
    metrics.videoEncodeFailures = videoEncodeFailures_.load(std::memory_order_relaxed);
    metrics.videoEncodeTimeouts = videoEncodeTimeouts_.load(std::memory_order_relaxed);
    metrics.videoEncodeHardFailures = videoEncodeHardFailures_.load(std::memory_order_relaxed);
    metrics.videoSendFailures = videoSendFailures_.load(std::memory_order_relaxed);
    metrics.alphaPacketsSent = alphaPacketsSent_.load(std::memory_order_relaxed);
    metrics.alphaEncodeFailures = alphaEncodeFailures_.load(std::memory_order_relaxed);
    metrics.alphaEncodeTimeouts = alphaEncodeTimeouts_.load(std::memory_order_relaxed);
    metrics.alphaFramesQueued = alphaFramesQueued_.load(std::memory_order_relaxed);
    metrics.alphaFramesDropped = alphaFramesDropped_.load(std::memory_order_relaxed);
    metrics.alphaSendFailures = alphaSendFailures_.load(std::memory_order_relaxed);
    metrics.audioSendFailures = audioSendFailures_.load(std::memory_order_relaxed);
    return metrics;
}

StreamMetrics VersusApp::getStreamMetrics() const {
    return buildStreamMetricsSnapshot(true);
}

SourceHealth VersusApp::getSourceHealth() const {
    std::lock_guard<std::mutex> lock(sourceHealthMutex_);
    return sourceHealth_;
}

void VersusApp::resetSourceHealth(VideoSourceMode mode, const std::string &sourceId) {
    std::lock_guard<std::mutex> lock(sourceHealthMutex_);
    sourceHealth_ = SourceHealth{};
    sourceHealth_.mode = mode;
    sourceHealth_.sourceId = sourceId;
}

void VersusApp::updateSourceHealthFromFrame(const video::CapturedFrame &frame) {
    if (frame.width <= 0 || frame.height <= 0) {
        return;
    }

    std::lock_guard<std::mutex> lock(sourceHealthMutex_);
    if (sourceHealth_.hasFrame &&
        (sourceHealth_.width != frame.width || sourceHealth_.height != frame.height)) {
        sourceHealth_.resizeCount++;
    }

    sourceHealth_.hasFrame = true;
    sourceHealth_.bgra = frame.format == video::CapturedFrame::Format::BGRA;
    sourceHealth_.width = frame.width;
    sourceHealth_.height = frame.height;
    sourceHealth_.largeSource =
        frame.width > 1920 ||
        frame.height > 1080 ||
        (static_cast<int64_t>(frame.width) * static_cast<int64_t>(frame.height)) > (1920LL * 1080LL);

    if (frame.format != video::CapturedFrame::Format::BGRA ||
        frame.stride < frame.width * 4 ||
        frame.data.size() < static_cast<size_t>(frame.stride) * static_cast<size_t>(frame.height)) {
        sourceHealth_.sampledFrames++;
        sourceHealth_.transparentRatio = 0.0;
        sourceHealth_.translucentRatio = 0.0;
        sourceHealth_.opaqueRatio = 0.0;
        sourceHealth_.greenRatio = 0.0;
        sourceHealth_.colorContentRatio = 0.0;
        sourceHealth_.alphaDetected = false;
        sourceHealth_.greenBackgroundLikely = false;
        return;
    }

    const int stepX = std::max(1, frame.width / 80);
    const int stepY = std::max(1, frame.height / 45);
    int total = 0;
    int transparent = 0;
    int translucent = 0;
    int opaque = 0;
    int green = 0;
    int colorContent = 0;

    for (int y = 0; y < frame.height; y += stepY) {
        const uint8_t *row = frame.data.data() + static_cast<size_t>(y) * static_cast<size_t>(frame.stride);
        for (int x = 0; x < frame.width; x += stepX) {
            const uint8_t *px = row + static_cast<size_t>(x) * 4;
            const int b = px[0];
            const int g = px[1];
            const int r = px[2];
            const int a = px[3];
            total++;
            if (a <= 8) {
                transparent++;
            } else if (a < 248) {
                translucent++;
            } else {
                opaque++;
            }
            if (g > 150 && g > r + 40 && g > b + 40) {
                green++;
            }
            if (r > 16 || g > 16 || b > 16) {
                colorContent++;
            }
        }
    }

    sourceHealth_.sampledFrames++;
    sourceHealth_.transparentRatio = total > 0 ? static_cast<double>(transparent) / total : 0.0;
    sourceHealth_.translucentRatio = total > 0 ? static_cast<double>(translucent) / total : 0.0;
    sourceHealth_.opaqueRatio = total > 0 ? static_cast<double>(opaque) / total : 0.0;
    sourceHealth_.greenRatio = total > 0 ? static_cast<double>(green) / total : 0.0;
    sourceHealth_.colorContentRatio = total > 0 ? static_cast<double>(colorContent) / total : 0.0;
    sourceHealth_.alphaDetected =
        sourceHealth_.transparentRatio >= 0.01 ||
        sourceHealth_.translucentRatio >= 0.01;
    sourceHealth_.greenBackgroundLikely =
        !sourceHealth_.alphaDetected &&
        sourceHealth_.greenRatio >= 0.20;
}

void VersusApp::populateSystemResourceUsage(ConnectionHealth &health) const {
#ifdef _WIN32
    MEMORYSTATUSEX memoryStatus{};
    memoryStatus.dwLength = sizeof(memoryStatus);
    if (GlobalMemoryStatusEx(&memoryStatus)) {
        health.systemMemoryPercent = static_cast<double>(memoryStatus.dwMemoryLoad);
        health.systemMemoryTotalBytes = static_cast<uint64_t>(memoryStatus.ullTotalPhys);
        health.systemMemoryUsedBytes =
            static_cast<uint64_t>(memoryStatus.ullTotalPhys - memoryStatus.ullAvailPhys);
    }

    FILETIME idleTime{};
    FILETIME kernelTime{};
    FILETIME userTime{};
    if (!GetSystemTimes(&idleTime, &kernelTime, &userTime)) {
        return;
    }

    const uint64_t idle = fileTimeToUint64(idleTime);
    const uint64_t kernel = fileTimeToUint64(kernelTime);
    const uint64_t user = fileTimeToUint64(userTime);
    std::lock_guard<std::mutex> lock(systemResourceMutex_);
    if (systemCpuSampleInitialized_) {
        const uint64_t idleDelta = idle >= lastSystemIdleTime_ ? idle - lastSystemIdleTime_ : 0;
        const uint64_t kernelDelta = kernel >= lastSystemKernelTime_ ? kernel - lastSystemKernelTime_ : 0;
        const uint64_t userDelta = user >= lastSystemUserTime_ ? user - lastSystemUserTime_ : 0;
        const uint64_t totalDelta = kernelDelta + userDelta;
        if (totalDelta > 0 && idleDelta <= totalDelta) {
            const double busyPercent =
                (static_cast<double>(totalDelta - idleDelta) * 100.0) / static_cast<double>(totalDelta);
            lastSystemCpuPercent_ = std::clamp(busyPercent, 0.0, 100.0);
        }
    } else {
        systemCpuSampleInitialized_ = true;
    }

    lastSystemIdleTime_ = idle;
    lastSystemKernelTime_ = kernel;
    lastSystemUserTime_ = user;
    health.systemCpuPercent = lastSystemCpuPercent_;
#else
    (void)health;
#endif
}

ConnectionHealth VersusApp::getConnectionHealth() const {
    ConnectionHealth health;
    const StreamMetrics metrics = buildStreamMetricsSnapshot(false);
    health.videoBitrateKbps = metrics.videoBitrateKbps;
    health.audioBitrateKbps = metrics.audioBitrateKbps;
    health.frameRate = metrics.frameRate;
    health.droppedFrameRate = metrics.droppedFrameRate;
    health.width = metrics.width;
    health.height = metrics.height;
    health.codec = metrics.codec;
    health.encoder = metrics.encoder;
    health.peerCount = metrics.peerCount;
    health.hqPeerCount = metrics.hqPeerCount;
    health.lqPeerCount = metrics.lqPeerCount;
    health.activeVideoPeers = metrics.activeVideoPeers;
    health.activeAudioPeers = metrics.activeAudioPeers;
    health.videoFramesCaptured = metrics.videoFramesCaptured;
    health.videoFramesSent = metrics.videoFramesSent;
    health.videoFramesDropped = metrics.videoFramesDropped;
    health.videoEncodeFailures = metrics.videoEncodeFailures;
    health.videoEncodeTimeouts = metrics.videoEncodeTimeouts;
    health.videoEncodeHardFailures = metrics.videoEncodeHardFailures;
    health.videoSendFailures = metrics.videoSendFailures;
    health.alphaPacketsSent = metrics.alphaPacketsSent;
    health.alphaEncodeFailures = metrics.alphaEncodeFailures;
    health.alphaEncodeTimeouts = metrics.alphaEncodeTimeouts;
    health.alphaFramesQueued = metrics.alphaFramesQueued;
    health.alphaFramesDropped = metrics.alphaFramesDropped;
    health.alphaSendFailures = metrics.alphaSendFailures;
    health.audioSendFailures = metrics.audioSendFailures;
    populateSystemResourceUsage(health);
    {
        std::lock_guard<std::mutex> lock(iceConfigMutex_);
        health.iceMode = webrtc::iceModeName(iceMode_);
        health.resolvedIceServers = static_cast<int>(resolvedIceServers_.size());
    }
    {
        std::lock_guard<std::mutex> lock(healthStateMutex_);
        health.lastPeerDisconnectReason = lastPeerDisconnectReason_;
    }

    const bool relaySeen = relayCandidateSeen_.load(std::memory_order_relaxed);
    const bool directSeen = directCandidateSeen_.load(std::memory_order_relaxed);
    if (health.peerCount <= 0) {
        health.candidatePath = "No peers";
    } else if (relaySeen) {
        health.candidatePath = "Relay candidate observed";
    } else if (directSeen) {
        health.candidatePath = "Direct candidate observed";
    } else {
        health.candidatePath = "Waiting for ICE";
    }
    return health;
}

std::string VersusApp::buildDiagnosticsJson() const {
    nlohmann::json root;
    root["schema"] = "game-capture-diagnostics-v1";
    root["version"] = publisherVersionTag();
    root["generated_steady_ms"] = steadyNowMs();

    const StreamMetrics metrics = getStreamMetrics();
    const SourceHealth sourceHealth = getSourceHealth();
    ConnectionHealth health;
    populateSystemResourceUsage(health);
    const VideoStateSnapshot videoState = videoStateSnapshot();
    const PeerCounts counts = collectPeerCounts();
    const video::FfmpegProbeInfo ffmpegInfo = video::VideoEncoder::probeFfmpeg(videoState.config.ffmpegPath);

    root["app"] = {
        {"live", live_.load(std::memory_order_relaxed)},
        {"capturing", capturing_.load(std::memory_order_relaxed)},
        {"reconnecting", reconnecting_.load(std::memory_order_relaxed)},
        {"stop_requested", stopRequested_.load(std::memory_order_relaxed)}
    };
    root["source"] = {
        {"mode", videoSourceModeName(sourceHealth.mode)},
        {"source_id", sourceHealth.sourceId},
        {"has_frame", sourceHealth.hasFrame},
        {"bgra", sourceHealth.bgra},
        {"width", sourceHealth.width},
        {"height", sourceHealth.height},
        {"sampled_frames", sourceHealth.sampledFrames},
        {"resize_count", sourceHealth.resizeCount},
        {"transparent_ratio", sourceHealth.transparentRatio},
        {"translucent_ratio", sourceHealth.translucentRatio},
        {"opaque_ratio", sourceHealth.opaqueRatio},
        {"green_ratio", sourceHealth.greenRatio},
        {"color_content_ratio", sourceHealth.colorContentRatio},
        {"alpha_detected", sourceHealth.alphaDetected},
        {"green_background_likely", sourceHealth.greenBackgroundLikely},
        {"large_source", sourceHealth.largeSource}
    };
    root["signaling"] = {
        {"server", startOptions_.server},
        {"room", room_},
        {"stream_id", streamId_},
        {"password_set", !password_.empty()},
        {"password_disabled", password_ == "false" || password_ == "0" || password_ == "off"},
        {"remote_control_enabled", remoteControlEnabled_.load(std::memory_order_relaxed)},
        {"remote_control_token_length", static_cast<int>(remoteControlToken_.size())},
        {"ice_mode", webrtc::iceModeName(iceMode_)},
        {"resolved_ice_servers", static_cast<int>(resolvedIceServers_.size())},
        {"relay_candidate_seen", relayCandidateSeen_.load(std::memory_order_relaxed)},
        {"direct_candidate_seen", directCandidateSeen_.load(std::memory_order_relaxed)},
        {"max_viewers", maxViewers_.load(std::memory_order_relaxed)}
    };
    root["video"] = {
        {"configured_width", videoState.config.width},
        {"configured_height", videoState.config.height},
        {"configured_fps", videoState.config.frameRate},
        {"configured_bitrate_kbps", videoState.config.bitrate},
        {"configured_codec", videoCodecName(videoState.config.codec)},
        {"active_codec", videoState.codecName},
        {"encoder", videoState.encoderName},
        {"encoder_input_format", videoState.encoderInputFormat},
        {"hardware_encoder", videoState.hardwareEncoder},
        {"alpha_enabled", videoState.config.enableAlpha},
        {"alpha_background_mode", alphaBackgroundModeName(videoState.config.alphaBackgroundMode)},
        {"alpha_background_color_rgb", {
            static_cast<int>(videoState.config.alphaBackgroundRed),
            static_cast<int>(videoState.config.alphaBackgroundGreen),
            static_cast<int>(videoState.config.alphaBackgroundBlue)
        }},
        {"ffmpeg_configured_path", videoState.config.ffmpegPath},
        {"ffmpeg_resolved", ffmpegInfo.resolved},
        {"ffmpeg_resolved_path", ffmpegInfo.path},
        {"ffmpeg_version", ffmpegInfo.version},
        {"ffmpeg_configuration", ffmpegInfo.configuration},
        {"ffmpeg_has_libvpx_vp9", ffmpegInfo.hasLibvpxVp9},
        {"ffmpeg_is_bundled", ffmpegInfo.bundled},
        {"ffmpeg_is_user_override", ffmpegInfo.userOverride},
        {"ffmpeg_gpl_enabled", ffmpegInfo.gplEnabled},
        {"ffmpeg_nonfree_enabled", ffmpegInfo.nonfreeEnabled},
        {"ffmpeg_probe_error", ffmpegInfo.error},
        {"hq_width", videoState.hqWidth},
        {"hq_height", videoState.hqHeight},
        {"lq_encoder_initialized", videoState.lqEncoderInitialized},
        {"lq_encoder", videoState.lqEncoderName},
        {"last_sent_width", lastSentWidth_.load(std::memory_order_relaxed)},
        {"last_sent_height", lastSentHeight_.load(std::memory_order_relaxed)},
        {"last_capture_width", lastCaptureWidth_},
        {"last_capture_height", lastCaptureHeight_},
        {"pending_global_keyframe", pendingGlobalKeyframe_.load(std::memory_order_relaxed)},
        {"video_track_active", videoTrackActive_.load(std::memory_order_relaxed)},
        {"encode_failures", videoEncodeFailures_.load(std::memory_order_relaxed)},
        {"encode_timeouts", videoEncodeTimeouts_.load(std::memory_order_relaxed)},
        {"encode_hard_failures", videoEncodeHardFailures_.load(std::memory_order_relaxed)},
        {"send_failures", videoSendFailures_.load(std::memory_order_relaxed)},
        {"alpha_packets_sent", alphaPacketsSent_.load(std::memory_order_relaxed)},
        {"alpha_encode_failures", alphaEncodeFailures_.load(std::memory_order_relaxed)},
        {"alpha_encode_timeouts", alphaEncodeTimeouts_.load(std::memory_order_relaxed)},
        {"alpha_frames_queued", alphaFramesQueued_.load(std::memory_order_relaxed)},
        {"alpha_frames_dropped", alphaFramesDropped_.load(std::memory_order_relaxed)},
        {"alpha_send_failures", alphaSendFailures_.load(std::memory_order_relaxed)},
        {"frames_captured", videoFramesCaptured_.load(std::memory_order_relaxed)},
        {"frames_sent", videoFramesSent_.load(std::memory_order_relaxed)},
        {"frames_dropped", videoFramesDropped_.load(std::memory_order_relaxed)},
        {"dropped_frame_rate", metrics.droppedFrameRate}
    };
    root["audio"] = {
        {"source_mode", audioSourceModeName(audioSourceMode_)},
        {"include_microphone", includeMicrophone_},
        {"active_microphone_source", activeMicrophoneSourceName_},
        {"configured_opus_bitrate_kbps", audioEncoderBitrateKbps_.load(std::memory_order_relaxed)},
        {"primary_gain", primaryAudioGain_.load(std::memory_order_relaxed)},
        {"additional_gain", additionalAudioGain_.load(std::memory_order_relaxed)},
        {"limiter_enabled", audioLimiterEnabled_.load(std::memory_order_relaxed)},
        {"level_rms", audioLevelRms_.load(std::memory_order_relaxed)},
        {"peak", audioPeak_.load(std::memory_order_relaxed)},
        {"primary_level_rms", primaryAudioLevelRms_.load(std::memory_order_relaxed)},
        {"primary_peak", primaryAudioPeak_.load(std::memory_order_relaxed)},
        {"additional_level_rms", additionalAudioLevelRms_.load(std::memory_order_relaxed)},
        {"additional_peak", additionalAudioPeak_.load(std::memory_order_relaxed)},
        {"last_primary_audio_chunk_ms", lastPrimaryAudioChunkMs_.load(std::memory_order_relaxed)},
        {"send_failures", audioSendFailures_.load(std::memory_order_relaxed)}
    };
    {
        std::lock_guard<std::mutex> lock(additionalAudioMutex_);
        root["audio"]["additional_audio_sample_rate"] = additionalAudioSampleRate_;
        root["audio"]["additional_audio_channels"] = additionalAudioChannels_;
        root["audio"]["additional_audio_buffer_samples"] = static_cast<int>(additionalAudioBuffer_.size());
    }
    root["metrics"] = {
        {"video_bitrate_kbps", metrics.videoBitrateKbps},
        {"audio_bitrate_kbps", metrics.audioBitrateKbps},
        {"frame_rate", metrics.frameRate},
        {"dropped_frame_rate", metrics.droppedFrameRate},
        {"width", metrics.width},
        {"height", metrics.height},
        {"codec", metrics.codec},
        {"encoder", metrics.encoder},
        {"peer_count", metrics.peerCount},
        {"hq_peer_count", metrics.hqPeerCount},
        {"lq_peer_count", metrics.lqPeerCount},
        {"active_video_peers", metrics.activeVideoPeers},
        {"active_audio_peers", metrics.activeAudioPeers},
        {"video_bytes_sent", videoBytesSent_.load(std::memory_order_relaxed)},
        {"audio_bytes_sent", audioBytesSent_.load(std::memory_order_relaxed)},
        {"video_frames_captured", metrics.videoFramesCaptured},
        {"video_frames_sent", metrics.videoFramesSent},
        {"video_frames_dropped", metrics.videoFramesDropped},
        {"audio_packets_sent", metrics.audioPacketsSent},
        {"video_encode_failures", metrics.videoEncodeFailures},
        {"video_encode_timeouts", metrics.videoEncodeTimeouts},
        {"video_encode_hard_failures", metrics.videoEncodeHardFailures},
        {"video_send_failures", metrics.videoSendFailures},
        {"alpha_packets_sent", metrics.alphaPacketsSent},
        {"alpha_encode_failures", metrics.alphaEncodeFailures},
        {"alpha_encode_timeouts", metrics.alphaEncodeTimeouts},
        {"alpha_frames_queued", metrics.alphaFramesQueued},
        {"alpha_frames_dropped", metrics.alphaFramesDropped},
        {"alpha_send_failures", metrics.alphaSendFailures},
        {"audio_send_failures", metrics.audioSendFailures}
    };
    root["system"] = {
        {"cpu_percent", health.systemCpuPercent},
        {"memory_percent", health.systemMemoryPercent},
        {"memory_used_bytes", health.systemMemoryUsedBytes},
        {"memory_total_bytes", health.systemMemoryTotalBytes}
    };
    root["peer_counts"] = {
        {"total", counts.total},
        {"hq", counts.hq},
        {"lq", counts.lq},
        {"active_video", counts.activeVideo},
        {"active_audio", counts.activeAudio},
        {"room_guests", counts.roomGuests},
        {"room_scenes", counts.roomScenes},
        {"room_non_guest_viewers", counts.roomNonGuestViewers}
    };

    std::vector<std::shared_ptr<PeerSession>> peers;
    nlohmann::json pendingRemoteCandidateQueues = nlohmann::json::array();
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peers.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (entry.second) {
                peers.push_back(entry.second);
            }
        }
        for (const auto &entry : pendingRemoteCandidates_) {
            pendingRemoteCandidateQueues.push_back({
                {"key", entry.first},
                {"count", static_cast<int>(entry.second.size())}
            });
        }
    }

    root["pending_remote_candidate_queues"] = std::move(pendingRemoteCandidateQueues);
    root["peers"] = nlohmann::json::array();
    for (const auto &peer : peers) {
        if (!peer) {
            continue;
        }

        nlohmann::json item;
        item["uuid"] = peer->uuid;
        item["session"] = peer->session;
        item["stream_id"] = peer->streamId;
        item["candidate_type"] = peer->candidateType;
        item["created_steady_ms"] = peer->createdAtMs;
        item["last_state_change_steady_ms"] = peer->lastStateChangeMs.load(std::memory_order_relaxed);
        int bufferedLocalCandidateCount = 0;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            bufferedLocalCandidateCount = static_cast<int>(peer->pendingCandidates.size());
        }
        item["signaling"] = {
            {"offer_dispatched", peer->offerDispatched},
            {"answer_received", peer->answerReceived},
            {"offer_count", peer->offerCount.load(std::memory_order_relaxed)},
            {"recovery_offer_count", peer->recoveryOfferCount.load(std::memory_order_relaxed)},
            {"answer_count", peer->answerCount.load(std::memory_order_relaxed)},
            {"local_candidates_sent", peer->localCandidatesSent.load(std::memory_order_relaxed)},
            {"remote_candidates_applied", peer->remoteCandidatesApplied.load(std::memory_order_relaxed)},
            {"buffered_local_candidates", bufferedLocalCandidateCount}
        };
        item["room"] = {
            {"room_mode", peer->roomMode},
            {"init_received", peer->initReceived.load(std::memory_order_relaxed)},
            {"role_valid", peer->roleValid.load(std::memory_order_relaxed)},
            {"role", peerRoleName(peer->role.load(std::memory_order_relaxed))},
            {"assigned_tier", streamTierName(peer->assignedTier.load(std::memory_order_relaxed))},
            {"init_deadline_steady_ms", peer->initDeadlineMs.load(std::memory_order_relaxed)}
        };
        item["media"] = {
            {"video_enabled", peer->videoEnabled.load(std::memory_order_relaxed)},
            {"audio_enabled", peer->audioEnabled.load(std::memory_order_relaxed)},
            {"waiting_for_keyframe", peer->waitingForKeyframe.load(std::memory_order_relaxed)},
            {"requested_video_bitrate_kbps", peer->requestedVideoBitrateKbps.load(std::memory_order_relaxed)},
            {"requested_audio_bitrate_kbps", peer->requestedAudioBitrateKbps.load(std::memory_order_relaxed)},
            {"renegotiation_queued", peer->renegotiationQueued.load(std::memory_order_relaxed)},
            {"codec_fallback_attempted", peer->codecFallbackAttempted.load(std::memory_order_relaxed)},
            {"alpha_allowed", peer->alphaAllowed.load(std::memory_order_relaxed)}
        };
        item["transport"] = {
            {"data_channel_open", peer->dataChannelOpen.load(std::memory_order_relaxed)},
            {"disconnected_since_steady_ms", peer->disconnectedSinceMs.load(std::memory_order_relaxed)},
            {"stats_continuous", peer->statsContinuous.load(std::memory_order_relaxed)}
        };
        item["controls"] = {
            {"rejected_control_count", peer->rejectedControlCount.load(std::memory_order_relaxed)}
        };
        {
            std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
            item["last_connection_state"] = peer->lastConnectionState;
            item["last_offer_reason"] = peer->lastOfferReason;
            item["last_answer_source"] = peer->lastAnswerSource;
            item["last_removal_reason"] = peer->lastRemovalReason;
            item["peer_label"] = peer->peerLabel;
            item["system"] = {
                {"app", peer->systemApp},
                {"version", peer->systemVersion},
                {"platform", peer->systemPlatform},
                {"browser", peer->systemBrowser}
            };
            item["alpha_receive_mode"] = peer->alphaReceiveMode;
            item["timeline"] = peer->timeline;
        }
        root["peers"].push_back(std::move(item));
    }

    return root.dump(2);
}

bool VersusApp::writeDiagnosticsJson(const std::string &path) const {
    if (path.empty()) {
        return false;
    }
    try {
        const std::filesystem::path outputPath(path);
        const auto parent = outputPath.parent_path();
        if (!parent.empty()) {
            std::error_code ec;
            std::filesystem::create_directories(parent, ec);
            if (ec) {
                spdlog::warn("[Diagnostics] Failed to create diagnostics directory '{}': {}",
                             parent.string(),
                             ec.message());
                return false;
            }
        }

        std::ofstream out(outputPath, std::ios::binary | std::ios::trunc);
        if (!out) {
            spdlog::warn("[Diagnostics] Failed to open diagnostics output '{}'", path);
            return false;
        }
        out << buildDiagnosticsJson() << '\n';
        if (!out.good()) {
            spdlog::warn("[Diagnostics] Failed while writing diagnostics output '{}'", path);
            return false;
        }
        spdlog::info("[Diagnostics] Wrote diagnostics to {}", path);
        return true;
    } catch (const std::exception &e) {
        spdlog::warn("[Diagnostics] Failed to write diagnostics '{}': {}", path, e.what());
    } catch (...) {
        spdlog::warn("[Diagnostics] Failed to write diagnostics '{}'", path);
    }
    return false;
}

void VersusApp::startAudioCapture(uint32_t selectedWindowProcessId) {
    {
        std::lock_guard<std::mutex> lock(additionalAudioMutex_);
        additionalAudioBuffer_.clear();
        additionalAudioSampleRate_ = 0;
        additionalAudioChannels_ = 0;
    }
    activeMicrophoneSourceName_ = microphoneDeviceId_.empty() ? "default-microphone" : "selected-microphone";

    const auto primaryCallback = [this](versus::audio::StreamChunk &&chunk) {
        handlePrimaryAudioChunk(std::move(chunk));
    };
    const auto additionalCallback = [this](versus::audio::StreamChunk &&chunk) {
        handleAdditionalAudioChunk(std::move(chunk));
    };

    const auto warnIfConverted = [this](const std::string &source, const audio::CaptureResult &capture) {
        if (!capture.success) {
            return;
        }
        if (capture.sampleRate != 48000 || capture.channels != 2) {
            const std::string message =
                "Audio source " + source + " is " + std::to_string(capture.sampleRate) + " Hz/" +
                std::to_string(capture.channels) + " channel(s); converting to 48 kHz stereo for WebRTC.";
            spdlog::warn("[Audio] {}", message);
            if (capture.sampleRate > 96000 || capture.channels > 2) {
                emitRuntimeEvent(message, false);
            }
        }
    };

    const auto resolveMicrophoneLabel = [this]() {
        if (microphoneDeviceId_.empty()) {
            return std::string("default-microphone");
        }
        const auto devices = microphoneAudioCapture_.GetInputDevices();
        for (const auto &device : devices) {
            if (device.id == microphoneDeviceId_) {
                return device.name.empty() ? std::string("selected-microphone") : device.name;
            }
        }
        return std::string("selected-microphone");
    };

    const auto startMicrophone = [&](const audio::WindowAudioCaptureCore::StreamCallback &callback,
                                     const char *role) {
        const std::string requestedLabel = resolveMicrophoneLabel();
        audio::CaptureResult micResult;
        if (!microphoneDeviceId_.empty()) {
            micResult = microphoneAudioCapture_.StartInputDeviceStreamCapture(microphoneDeviceId_, callback);
            if (!micResult.success) {
                spdlog::warn("[Audio] {} microphone capture device='{}' failed: {}; falling back to default input",
                             role,
                             requestedLabel,
                             micResult.error.empty() ? "unknown error" : micResult.error);
                emitRuntimeEvent("Selected microphone/input was unavailable; using Windows default microphone/input.", false);
                activeMicrophoneSourceName_ = "default-microphone";
                micResult = microphoneAudioCapture_.StartDefaultEndpointStreamCapture(
                    audio::DefaultAudioEndpoint::MultimediaInput, callback);
            } else {
                activeMicrophoneSourceName_ = requestedLabel;
            }
        } else {
            micResult = microphoneAudioCapture_.StartDefaultEndpointStreamCapture(
                audio::DefaultAudioEndpoint::MultimediaInput, callback);
            activeMicrophoneSourceName_ = "default-microphone";
        }

        if (micResult.success) {
            spdlog::info("[Audio] {} microphone capture source={} sampleRate={} channels={} processLoopback={}",
                         role,
                         activeMicrophoneSourceName_,
                         micResult.sampleRate,
                         micResult.channels,
                         micResult.usingProcessLoopback);
            warnIfConverted(activeMicrophoneSourceName_, micResult);
            return true;
        }

        spdlog::warn("[Audio] {} microphone capture failed: {}",
                     role,
                     micResult.error.empty() ? "unknown error" : micResult.error);
        activeMicrophoneSourceName_ = "none";
        return false;
    };
    const auto startMicrophoneAsPrimary = [&]() {
        return startMicrophone(primaryCallback, "Primary");
    };

    audio::CaptureResult result;
    switch (audioSourceMode_) {
        case AudioSourceMode::DefaultOutput:
            result = audioCapture_.StartDefaultEndpointStreamCapture(
                audio::DefaultAudioEndpoint::MultimediaOutput, primaryCallback);
            break;
        case AudioSourceMode::CommunicationsOutput:
            result = audioCapture_.StartDefaultEndpointStreamCapture(
                audio::DefaultAudioEndpoint::CommunicationsOutput, primaryCallback);
            break;
        case AudioSourceMode::DefaultMicrophone:
            startMicrophoneAsPrimary();
            return;
        case AudioSourceMode::None:
            if (!includeMicrophone_) {
                spdlog::info("[Audio] Audio capture disabled by user setting");
                return;
            }
            startMicrophoneAsPrimary();
            return;
        case AudioSourceMode::SelectedWindow:
        default:
            if (selectedWindowProcessId == 0) {
                spdlog::warn("[Audio] Selected-window audio requested but no process id was available");
                if (includeMicrophone_) {
                    spdlog::warn("[Audio] Falling back to default microphone/input as primary audio source");
                    startMicrophoneAsPrimary();
                }
                return;
            }
            result = audioCapture_.StartStreamCapture(selectedWindowProcessId, primaryCallback);
            break;
    }

    if (result.success) {
        spdlog::info("[Audio] Capture source={} sampleRate={} channels={} processLoopback={}",
                     audioSourceModeName(audioSourceMode_),
                     result.sampleRate,
                     result.channels,
                     result.usingProcessLoopback);
        warnIfConverted(audioSourceModeName(audioSourceMode_), result);
    } else {
        spdlog::warn("[Audio] Capture source={} failed: {}",
                     audioSourceModeName(audioSourceMode_),
                     result.error.empty() ? "unknown error" : result.error);
        if (includeMicrophone_ && audioSourceMode_ != AudioSourceMode::DefaultMicrophone) {
            spdlog::warn("[Audio] Falling back to default microphone/input as primary audio source");
            startMicrophoneAsPrimary();
        }
        return;
    }

    if (includeMicrophone_ && audioSourceMode_ != AudioSourceMode::DefaultMicrophone) {
        startMicrophone(additionalCallback, "Additional");
    }
}

void VersusApp::handleAdditionalAudioChunk(versus::audio::StreamChunk &&chunk) {
    if (!live_) {
        return;
    }

    std::vector<float> normalizedSamples = normalizeAudioForOpus(chunk);
    if (normalizedSamples.empty()) {
        return;
    }
    applyAudioGain(normalizedSamples, additionalAudioGain_.load(std::memory_order_relaxed));
    updateAudioLevelMeters(normalizedSamples, additionalAudioLevelRms_, additionalAudioPeak_);

    std::vector<float> standaloneSamples;
    const int64_t lastPrimaryMs = lastPrimaryAudioChunkMs_.load(std::memory_order_relaxed);
    const int64_t nowMs = steadyNowMs();
    const bool primaryAudioActive = lastPrimaryMs > 0 && (nowMs - lastPrimaryMs) <= kPrimaryAudioActiveWindowMs;

    {
        std::lock_guard<std::mutex> lock(additionalAudioMutex_);
        additionalAudioSampleRate_ = 48000;
        additionalAudioChannels_ = 2;
        for (float sample : normalizedSamples) {
            additionalAudioBuffer_.push_back(sample);
        }
        constexpr size_t kMaxAdditionalAudioSamples = 48000 * 2 / 4;
        while (additionalAudioBuffer_.size() > kMaxAdditionalAudioSamples) {
            additionalAudioBuffer_.pop_front();
        }

        if (!primaryAudioActive) {
            size_t take = std::min(normalizedSamples.size(), additionalAudioBuffer_.size());
            take -= take % 2;
            standaloneSamples.reserve(take);
            for (size_t i = 0; i < take; ++i) {
                standaloneSamples.push_back(additionalAudioBuffer_.front());
                additionalAudioBuffer_.pop_front();
            }
        }
    }

    if (!standaloneSamples.empty()) {
        encodeNormalizedAudio(standaloneSamples);
    }
}

void VersusApp::mixAdditionalAudioInto(std::vector<float> &samples, uint32_t sampleRate, uint32_t channels) {
    if (samples.empty() || sampleRate != 48000 || channels != 2) {
        return;
    }

    std::lock_guard<std::mutex> lock(additionalAudioMutex_);
    if (additionalAudioBuffer_.empty() || additionalAudioSampleRate_ != 48000 || additionalAudioChannels_ != 2) {
        return;
    }

    const size_t mixCount = std::min(samples.size(), additionalAudioBuffer_.size());
    for (size_t i = 0; i < mixCount; ++i) {
        samples[i] = samples[i] + additionalAudioBuffer_.front();
        additionalAudioBuffer_.pop_front();
    }
}

void VersusApp::handlePrimaryAudioChunk(versus::audio::StreamChunk &&chunk) {
    if (!live_) {
        return;
    }
    lastPrimaryAudioChunkMs_.store(steadyNowMs(), std::memory_order_relaxed);

    std::vector<float> normalizedSamples = normalizeAudioForOpus(chunk);
    if (normalizedSamples.empty()) {
        return;
    }
    applyAudioGain(normalizedSamples, primaryAudioGain_.load(std::memory_order_relaxed));
    updateAudioLevelMeters(normalizedSamples, primaryAudioLevelRms_, primaryAudioPeak_);
    mixAdditionalAudioInto(normalizedSamples, 48000, 2);

    encodeNormalizedAudio(normalizedSamples);
}

void VersusApp::applyAudioGain(std::vector<float> &samples, float gain) const {
    if (samples.empty()) {
        return;
    }
    gain = std::clamp(gain, 0.0f, 2.0f);
    if (std::abs(gain - 1.0f) < 0.001f) {
        return;
    }
    for (float &sample : samples) {
        sample *= gain;
    }
}

void VersusApp::applyAudioLimiter(std::vector<float> &samples) const {
    if (samples.empty() || !audioLimiterEnabled_.load(std::memory_order_relaxed)) {
        return;
    }

    float peak = 0.0f;
    for (float sample : samples) {
        peak = std::max(peak, std::abs(sample));
    }
    if (peak <= 0.98f) {
        return;
    }

    // Soft-limit first so mixed game+mic transients do not hard clip, then
    // normalize any remaining overs above full scale.
    constexpr float kDrive = 1.35f;
    const float normalizer = std::tanh(kDrive);
    float limitedPeak = 0.0f;
    for (float &sample : samples) {
        sample = std::tanh(sample * kDrive) / normalizer;
        limitedPeak = std::max(limitedPeak, std::abs(sample));
    }
    if (limitedPeak > 1.0f) {
        const float scale = 1.0f / limitedPeak;
        for (float &sample : samples) {
            sample *= scale;
        }
    }
}

void VersusApp::updateAudioLevelMeters(const std::vector<float> &samples,
                                       std::atomic<float> &rmsTarget,
                                       std::atomic<float> &peakTarget) {
    if (samples.empty()) {
        return;
    }

    float peak = 0.0f;
    double sumSquares = 0.0;
    for (float sample : samples) {
        const float absSample = std::abs(sample);
        peak = std::max(peak, absSample);
        sumSquares += static_cast<double>(sample) * static_cast<double>(sample);
    }
    const float rms = static_cast<float>(std::sqrt(sumSquares / static_cast<double>(samples.size())));
    const float prevRms = rmsTarget.load(std::memory_order_relaxed);
    const float smoothedRms = (prevRms * 0.75f) + (rms * 0.25f);
    rmsTarget.store(std::clamp(smoothedRms, 0.0f, 1.0f), std::memory_order_relaxed);

    const float prevPeak = peakTarget.load(std::memory_order_relaxed);
    const float decayedPeak = std::max(peak, prevPeak * 0.90f);
    peakTarget.store(std::clamp(decayedPeak, 0.0f, 1.0f), std::memory_order_relaxed);
}

void VersusApp::encodeNormalizedAudio(std::vector<float> &normalizedSamples) {
    if (!live_ || normalizedSamples.empty()) {
        return;
    }

    // Primary (loopback) and additional (microphone) capture threads can both
    // reach the shared Opus encoder; libopus encoder state is not thread-safe.
    std::lock_guard<std::mutex> encodeLock(audioEncodeMutex_);

    applyAudioLimiter(normalizedSamples);
    updateAudioLevelMeters(normalizedSamples, audioLevelRms_, audioPeak_);

    constexpr uint32_t kOpusSampleRate = 48000;
    constexpr uint32_t kOpusChannels = 2;
    const size_t frames = normalizedSamples.size() / kOpusChannels;
    const int64_t chunkDuration100ns =
        static_cast<int64_t>(frames) * 10000000LL / static_cast<int64_t>(kOpusSampleRate);
    const int64_t pts = audioPts100ns_.fetch_add(chunkDuration100ns);
    if (!hasAnyActiveAudioTrack()) {
        return;
    }

    opusEncoder_.encode(normalizedSamples,
                        static_cast<int>(kOpusSampleRate),
                        static_cast<int>(kOpusChannels),
                        pts);
}

void VersusApp::setupCallbacks() {
    opusEncoder_.setPacketCallback([this](const versus::audio::EncodedAudioPacket &packet) {
        webrtc::EncodedAudioPacket out;
        out.data = packet.data;
        out.pts = packet.pts;
        out.sampleRate = packet.sampleRate;
        out.channels = static_cast<uint16_t>(packet.channels);
        sendAudioPacketToPeers(out);
    });
}

void VersusApp::setupSignalingCallbacks() {
    signaling_.onDisconnected([this]() {
        spdlog::warn("[Signaling] Disconnected");
        if (!live_ || stopRequested_.load()) {
            return;
        }
        startSignalingRecovery();
    });

    signaling_.onError([this](const std::string &error) {
        spdlog::warn("[Signaling] Error: {}", error);
        if (!live_ || stopRequested_.load()) {
            return;
        }
        if (signaling_.isConnected()) {
            spdlog::warn("[Signaling] Ignoring reconnect on non-fatal error while socket remains connected");
            return;
        }
        startSignalingRecovery();
    });

    signaling_.onAlert([this](const std::string &message) {
        const std::string lower = toLowerCopy(message);
        const bool streamIdInUse = isStreamIdInUseAlert(lower);

        if (streamIdInUse) {
            const std::string notify =
                "Stream ID is already in use. Pick a different Stream ID and try again.";
            spdlog::error("[App] {}", notify);
            emitRuntimeEvent(notify, true);

            stopRequested_.store(true);
            reconnecting_.store(false);
            live_ = false;
            pendingGlobalKeyframe_.store(false, std::memory_order_relaxed);
            videoTrackActive_.store(false, std::memory_order_relaxed);
            {
                std::lock_guard<std::mutex> lock(signalingOpsMutex_);
                signaling_.disconnect();
            }
            clearPeerSessions();
            return;
        }

        if (!message.empty()) {
            emitRuntimeEvent(message, false);
        }
    });

    signaling_.onPeerCleanup([this](const std::string &uuid, const std::string &session) {
        spdlog::info("[Signaling] onPeerCleanup uuid={} session={}", uuid, session);
        std::shared_ptr<PeerSession> peer;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peer = findPeerSessionForSignalLocked(uuid, session);
        }
        if (!peer) {
            spdlog::warn("[Signaling] No matching peer for cleanup uuid={} session={}", uuid, session);
            return;
        }
        removePeerSession(peer, "signaling-cleanup");
    });

    signaling_.onIceRestartRequest([this](const std::string &uuid, const std::string &session, const std::string &streamId) {
        spdlog::info("[Signaling] onIceRestartRequest uuid={} session={} streamId={}", uuid, session, streamId);
        std::shared_ptr<PeerSession> peer;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peer = findPeerSessionForSignalLocked(uuid, session);
        }
        if (!peer) {
            spdlog::warn("[Signaling] No matching peer for ICE restart uuid={} session={}", uuid, session);
            return;
        }

        peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        if (!sendPeerOffer(peer, "signaling-ice-restart", true)) {
            spdlog::warn("[App] Failed to refresh peer connection from signaling ICE restart {}:{}",
                         peer->uuid,
                         peer->session);
        }
    });

    signaling_.onOfferRequest([this](const std::string &uuid, const std::string &session, const std::string &streamId) {
        spdlog::info("[Signaling] onOfferRequest uuid={} session={} streamId={}", uuid, session, streamId);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);

        std::string resolvedSession = session;
        if (resolvedSession.empty()) {
            std::shared_ptr<PeerSession> existingPeer;
            {
                std::lock_guard<std::mutex> lock(peerSessionsMutex_);
                existingPeer = findPeerSessionForSignalLocked(uuid, "");
            }
            resolvedSession = existingPeer && !existingPeer->session.empty() ? existingPeer->session : "default";
            spdlog::info("[Signaling] Using stable default session ID for uuid={}: {}", uuid, resolvedSession);
        }
        const std::string resolvedStreamId = streamId_.empty() ? streamId : streamId_;
        const std::string key = makePeerKey(uuid, resolvedSession);
        const int maxViewers = maxViewers_.load(std::memory_order_relaxed);
        if (maxViewers > 0) {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            const bool replacingExisting = (peerSessions_.find(key) != peerSessions_.end());
            if (!replacingExisting && static_cast<int>(peerSessions_.size()) >= maxViewers) {
                spdlog::warn("[Signaling] Viewer limit reached (max={}); rejecting {}:{}",
                             maxViewers,
                             uuid,
                             resolvedSession);
                return;
            }
        }

        std::shared_ptr<PeerSession> replacedPeer;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            const auto existing = peerSessions_.find(key);
            if (existing != peerSessions_.end()) {
                replacedPeer = existing->second;
                peerSessions_.erase(existing);
            }
        }
        shutdownPeerClientAsync(replacedPeer);

        auto peer = std::make_shared<PeerSession>();
        peer->uuid = uuid;
        peer->session = resolvedSession;
        peer->streamId = resolvedStreamId;
        peer->candidateType = "local";
        peer->createdAtMs = steadyNowMs();
        peer->lastStateChangeMs.store(peer->createdAtMs, std::memory_order_relaxed);
        peer->answerReceived = false;
        peer->roomMode = !room_.empty();
        peer->initReceived.store(false, std::memory_order_relaxed);
        peer->roleValid.store(false, std::memory_order_relaxed);
        peer->role.store(PeerRole::Unknown, std::memory_order_relaxed);
        peer->assignedTier.store(StreamTier::None, std::memory_order_relaxed);
        peer->videoEnabled.store(true, std::memory_order_relaxed);
        peer->audioEnabled.store(true, std::memory_order_relaxed);
        peer->initDeadlineMs.store(0, std::memory_order_relaxed);
        peer->client = std::make_unique<webrtc::WebRtcClient>();

        webrtc::PeerConfig peerConfig;
        {
            std::lock_guard<std::mutex> lock(iceConfigMutex_);
            peerConfig.iceServers = resolvedIceServers_;
            peerConfig.iceMode = iceMode_;
        }
        const VideoStateSnapshot videoState = videoStateSnapshot();
        peerConfig.videoCodec = toPeerVideoCodec(videoState.config.codec);
        peerConfig.enableAlphaTrack = usesVp9AlphaTrack(videoState.config);
        // Always negotiate VDO.Ninja's sendChannel so both sides can exchange
        // the standard info handshake, even for direct VP9/alpha viewers.
        peerConfig.enableDataChannel = true;
        // Include media m-lines in the first offer so VDO.Ninja room/slot mode
        // does not need a second negotiation before it can attach the stream.
        peerConfig.initialVideo = true;
        peerConfig.initialAudio = true;
        peerConfig.initialAlpha = false;
        peerConfig.videoWidth = std::max(1, videoState.config.width);
        peerConfig.videoHeight = std::max(1, videoState.config.height);
        peerConfig.videoFps = std::max(1, videoState.config.frameRate);
        if (!peer->client->initialize(peerConfig)) {
            spdlog::error("[WebRTC] Failed to initialize peer session {}:{}", uuid, resolvedSession);
            return;
        }
        recordPeerEvent(peer, "session-created stream=" + resolvedStreamId);

        std::weak_ptr<PeerSession> weakPeer = peer;
        peer->client->setStateCallback([this, weakPeer](webrtc::ConnectionState state) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            const char *stateName = connectionStateName(state);
            peerPtr->lastStateChangeMs.store(steadyNowMs(), std::memory_order_relaxed);
            {
                std::lock_guard<std::mutex> lock(peerPtr->diagnosticsMutex);
                peerPtr->lastConnectionState = stateName;
            }
            recordPeerEvent(peerPtr, std::string("connection-state ") + stateName);
            if (state == webrtc::ConnectionState::Connected) {
                peerPtr->disconnectedSinceMs.store(0, std::memory_order_relaxed);
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                peerPtr->waitingForKeyframe.store(true, std::memory_order_relaxed);
                spdlog::info("[WebRTC] Peer connected {}:{}", peerPtr->uuid, peerPtr->session);
                return;
            }
            if (state == webrtc::ConnectionState::Disconnected) {
                int64_t expected = 0;
                peerPtr->disconnectedSinceMs.compare_exchange_strong(
                    expected,
                    steadyNowMs(),
                    std::memory_order_relaxed,
                    std::memory_order_relaxed);
                spdlog::warn("[WebRTC] Peer connection disconnected {}:{}; keeping session for ICE recovery",
                             peerPtr->uuid,
                             peerPtr->session);
                return;
            }
            if (state == webrtc::ConnectionState::Closed) {
                peerPtr->disconnectedSinceMs.store(0, std::memory_order_relaxed);
                spdlog::info("[WebRTC] Peer connection closed {}:{}; removing session",
                             peerPtr->uuid,
                             peerPtr->session);
                removePeerSession(peerPtr, "connection-closed");
                return;
            }
            if (state == webrtc::ConnectionState::Failed) {
                spdlog::warn("[WebRTC] Peer connection degraded {}:{} state={}",
                             peerPtr->uuid,
                             peerPtr->session,
                             "failed");
                bool shouldTryTurnFallback = false;
                {
                    std::lock_guard<std::mutex> lock(iceConfigMutex_);
                    shouldTryTurnFallback = iceMode_ == webrtc::IceMode::StunOnly;
                }
                if (shouldTryTurnFallback && !stopRequested_.load(std::memory_order_relaxed)) {
                    const auto fallbackIce = webrtc::resolveIceConfig(webrtc::IceMode::All, 1000);
                    if (fallbackIce.hasTurnServers()) {
                        {
                            std::lock_guard<std::mutex> lock(iceConfigMutex_);
                            resolvedIceServers_ = fallbackIce.servers;
                            iceMode_ = webrtc::IceMode::All;
                            startOptions_.iceMode = webrtc::IceMode::All;
                        }
                        emitRuntimeEvent(
                            "Direct STUN connection failed; retrying new room connections with TURN fallback.",
                            false);
                    }
                }
                removePeerSession(peerPtr, "connection-failed");
            }
        });

        peer->client->setIceCandidateCallback([this, weakPeer](const std::string &candidate,
                                                                const std::string &mid,
                                                                int mlineIndex) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr || candidate.empty()) {
                return;
            }

            const std::string lowerCandidate = toLowerCopy(candidate);
            const bool relayCandidate =
                lowerCandidate.find(" typ relay") != std::string::npos;
            if (relayCandidate) {
                relayCandidateSeen_.store(true, std::memory_order_relaxed);
            } else {
                directCandidateSeen_.store(true, std::memory_order_relaxed);
            }

            bool shouldSend = false;
            std::string uuidLocal;
            std::string sessionLocal;
            std::string typeLocal;
            {
                std::lock_guard<std::mutex> lock(peerSessionsMutex_);
                const auto it = peerSessions_.find(makePeerKey(peerPtr->uuid, peerPtr->session));
                if (it == peerSessions_.end() || !it->second) {
                    return;
                }

                auto &sessionState = it->second;
                if (!sessionState->offerDispatched) {
                    sessionState->pendingCandidates.push_back({candidate, mid, mlineIndex});
                    recordPeerEvent(peerPtr, "local-candidate-buffered");
                    return;
                }

                shouldSend = true;
                uuidLocal = sessionState->uuid;
                sessionLocal = sessionState->session;
                typeLocal = sessionState->candidateType;
            }

            if (!shouldSend) {
                return;
            }

            if (relayCandidate) {
                const int64_t nowMs = steadyNowMs();
                const int64_t lastWarnMs = lastRelayWarningMs_.load(std::memory_order_relaxed);
                if ((lastWarnMs == 0) || ((nowMs - lastWarnMs) > 15000)) {
                    lastRelayWarningMs_.store(nowMs, std::memory_order_relaxed);
                    emitRuntimeEvent(
                        "Connection is using TURN relay (higher latency/bandwidth cost). If possible, allow direct UDP or use a closer TURN server.",
                        false);
                }
            }

            signaling::SignalCandidate cand;
            cand.uuid = uuidLocal;
            cand.candidate = candidate;
            cand.mid = mid;
            cand.mlineIndex = mlineIndex;
            cand.session = sessionLocal;
            cand.type = typeLocal;
            {
                std::lock_guard<std::mutex> lock(signalingOpsMutex_);
                signaling_.sendCandidate(cand);
            }
            peerPtr->localCandidatesSent.fetch_add(1, std::memory_order_relaxed);
            recordPeerEvent(peerPtr, relayCandidate ? "local-candidate-sent relay" : "local-candidate-sent");
        });

        peer->client->setKeyframeRequestCallback([this]() {
            spdlog::info("[App] Browser requested keyframe via PLI/FIR");
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);

            const int64_t nowMs = steadyNowMs();
            const int64_t windowStartMs = pliWindowStartMs_.load(std::memory_order_relaxed);
            if (windowStartMs == 0 || (nowMs - windowStartMs) > 10000) {
                pliWindowStartMs_.store(nowMs, std::memory_order_relaxed);
                pliWindowCount_.store(1, std::memory_order_relaxed);
                return;
            }

            const int pliCount = pliWindowCount_.fetch_add(1, std::memory_order_relaxed) + 1;
            if (pliCount >= 8) {
                const int64_t lastWarnMs = lastPacketLossWarningMs_.load(std::memory_order_relaxed);
                if ((lastWarnMs == 0) || ((nowMs - lastWarnMs) > 15000)) {
                    lastPacketLossWarningMs_.store(nowMs, std::memory_order_relaxed);
                    emitRuntimeEvent(
                        "High packet-loss recovery detected. Consider lowering bitrate/resolution or reducing concurrent viewers.",
                        false);
                }
                pliWindowStartMs_.store(nowMs, std::memory_order_relaxed);
                pliWindowCount_.store(0, std::memory_order_relaxed);
            }
        });

        peer->client->setDataMessageCallback([this, weakPeer](const std::string &message) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            peerPtr->dataChannelOpen.store(true, std::memory_order_relaxed);
            if (!peerPtr->initReceived.load(std::memory_order_relaxed) &&
                peerPtr->initDeadlineMs.load(std::memory_order_relaxed) <= 0) {
                const int64_t graceMs = peerPtr->roomMode ? kRoomInitGracePeriodMs : kDirectInitGracePeriodMs;
                peerPtr->initDeadlineMs.store(steadyNowMs() + graceMs, std::memory_order_relaxed);
            }
            // Peer-supplied JSON can contain unexpected value types; never let a
            // malformed message escape as an exception on the transport thread.
            try {
                handlePeerDataMessage(peerPtr, message);
            } catch (const std::exception &e) {
                spdlog::warn("[App] Failed to handle peer data message from {}:{}: {}",
                             peerPtr->uuid,
                             peerPtr->session,
                             e.what());
            } catch (...) {
                spdlog::warn("[App] Failed to handle peer data message from {}:{}",
                             peerPtr->uuid,
                             peerPtr->session);
            }
        });

        peer->client->setDataChannelStateCallback([this, weakPeer](bool open) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            peerPtr->dataChannelOpen.store(open, std::memory_order_relaxed);
            recordPeerEvent(peerPtr, open ? "datachannel-open" : "datachannel-closed");
            if (open) {
                peerPtr->disconnectedSinceMs.store(0, std::memory_order_relaxed);
                if (!peerPtr->initReceived.load(std::memory_order_relaxed)) {
                    const int64_t graceMs = peerPtr->roomMode ? kRoomInitGracePeriodMs : kDirectInitGracePeriodMs;
                    peerPtr->initDeadlineMs.store(steadyNowMs() + graceMs, std::memory_order_relaxed);
                }
                sendPeerDataInfo(peerPtr, true);
                applyPeerMediaPlan(peerPtr, "datachannel-open");
            } else {
                peerPtr->initDeadlineMs.store(0, std::memory_order_relaxed);
                int64_t expected = 0;
                peerPtr->disconnectedSinceMs.compare_exchange_strong(
                    expected,
                    steadyNowMs(),
                    std::memory_order_relaxed,
                    std::memory_order_relaxed);
            }
        });

        if (!peer->roomMode) {
            applyPeerInitState(peer, true, PeerRole::Viewer, true, true);
            peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        }

        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peerSessions_[key] = peer;
        }

        if (!sendPeerOffer(peer, "bootstrap")) {
            return;
        }
    });

    signaling_.onOffer([this](const signaling::SignalOffer &offer) {
        spdlog::warn("[Signaling] Unexpected incoming offer uuid={} session={} (publisher mode)",
                     offer.uuid,
                     offer.session);
    });

    signaling_.onAnswer([this](const signaling::SignalAnswer &answer) {
        spdlog::info("[Signaling] onAnswer uuid={} session={}", answer.uuid, answer.session);

        std::shared_ptr<PeerSession> peer;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peer = findPeerSessionForSignalLocked(answer.uuid, answer.session);
            if (!peer) {
                spdlog::warn("[Signaling] No matching peer for answer uuid={} session={}",
                             answer.uuid,
                             answer.session);
                return;
            }
        }

        applyPeerAnswer(peer, answer.sdp, "signaling-wss");
    });

    signaling_.onCandidate([this](const signaling::SignalCandidate &cand) {
        if (cand.candidate.empty()) {
            return;
        }

        const std::string lowerCandidate = toLowerCopy(cand.candidate);
        if (lowerCandidate.find(" typ relay") != std::string::npos) {
            relayCandidateSeen_.store(true, std::memory_order_relaxed);
        } else {
            directCandidateSeen_.store(true, std::memory_order_relaxed);
        }

        std::shared_ptr<PeerSession> peer;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peer = findPeerSessionForSignalLocked(cand.uuid, cand.session);
            if (!peer || !peer->client) {
                queuePendingRemoteCandidateLocked(cand, steadyNowMs());
                return;
            }
        }

        peer->client->addRemoteCandidate(cand.candidate, cand.mid, cand.mlineIndex);
        peer->remoteCandidatesApplied.fetch_add(1, std::memory_order_relaxed);
        recordPeerEvent(peer, "remote-candidate-applied signaling");
    });
}

bool VersusApp::isControlMessageAuthorized(const std::shared_ptr<PeerSession> &peer, const std::string &token) const {
    if (peer &&
        peer->roomMode &&
        peer->roleValid.load(std::memory_order_relaxed) &&
        peer->role.load(std::memory_order_relaxed) == PeerRole::Director) {
        return true;
    }

    if (!remoteControlEnabled_.load(std::memory_order_relaxed)) {
        return false;
    }
    if (remoteControlToken_.empty()) {
        return true;
    }
    return token == remoteControlToken_;
}

bool VersusApp::applyRuntimeVideoControl(int bitrateKbps,
                                         int &width,
                                         int &height,
                                         int fps,
                                         bool vdoScaleResolutionRequest,
                                         bool vdoScaleResolutionCover) {
    if (bitrateKbps <= 0 && width <= 0 && height <= 0 && fps <= 0) {
        return true;
    }

    std::lock_guard<std::mutex> lock(videoSendMutex_);
    auto nextConfig = videoConfig_;
    const int requestedWidth = width;
    const int requestedHeight = height;

    const bool bitrateRequested = bitrateKbps > 0;
    if (bitrateRequested) {
        const int clamped = std::clamp(bitrateKbps, 250, 100000);
        nextConfig.bitrate = clamped;
        nextConfig.minBitrate = std::max(250, clamped / 2);
        nextConfig.maxBitrate = std::max(nextConfig.maxBitrate, std::max(clamped + 4000, (clamped * 3) / 2));
    }

    const bool hasResolutionRequest = width > 0 || height > 0;
    if (hasResolutionRequest) {
        int captureWidth = lastCaptureWidth_;
        int captureHeight = lastCaptureHeight_;
        {
            std::lock_guard<std::mutex> latestLock(latestVideoFrameMutex_);
            if (hasLatestVideoFrame_ && latestVideoFrame_.width > 0 && latestVideoFrame_.height > 0) {
                captureWidth = latestVideoFrame_.width;
                captureHeight = latestVideoFrame_.height;
            }
        }
        if (captureWidth > 0 && captureHeight > 0 &&
            (captureWidth != lastCaptureWidth_ || captureHeight != lastCaptureHeight_)) {
            lastCaptureWidth_ = captureWidth;
            lastCaptureHeight_ = captureHeight;
            lastCaptureResizeMs_ = steadyNowMs();
        }

        const int aspectWidth = std::max(2, ((captureWidth > 0 ? captureWidth : videoConfig_.width) & ~1));
        const int aspectHeight = std::max(2, ((captureHeight > 0 ? captureHeight : videoConfig_.height) & ~1));
        const bool vdoRequestAtOrAboveCurrent =
            vdoScaleResolutionRequest &&
            (requestedWidth <= 0 || requestedWidth >= videoConfig_.width) &&
            (requestedHeight <= 0 || requestedHeight >= videoConfig_.height);
        const CompletedResolution resolvedResolution =
            vdoRequestAtOrAboveCurrent
                ? CompletedResolution{videoConfig_.width, videoConfig_.height}
                : (vdoScaleResolutionRequest
                       ? completeVdoScaleResolutionRequest(width,
                                                           height,
                                                           vdoScaleResolutionCover,
                                                           aspectWidth,
                                                           aspectHeight)
                       : completeResolutionRequest(width, height, aspectWidth, aspectHeight));
        if (resolvedResolution.width <= 0 || resolvedResolution.height <= 0) {
            return false;
        }
        nextConfig.width = resolvedResolution.width;
        nextConfig.height = resolvedResolution.height;
        if (vdoRequestAtOrAboveCurrent) {
            spdlog::info("[App] Ignoring VDO runtime resolution request {}x{} cover={} because current output is already {}x{}",
                         requestedWidth,
                         requestedHeight,
                         vdoScaleResolutionCover,
                         nextConfig.width,
                         nextConfig.height);
        } else if (vdoScaleResolutionRequest) {
            spdlog::info("[App] Resolved VDO runtime resolution request {}x{} cover={} using source {}x{} -> {}x{}",
                         requestedWidth,
                         requestedHeight,
                         vdoScaleResolutionCover,
                         aspectWidth,
                         aspectHeight,
                         nextConfig.width,
                         nextConfig.height);
        } else if (requestedWidth <= 0 || requestedHeight <= 0) {
            spdlog::info("[App] Completed partial runtime resolution request {}x{} using aspect {}x{} -> {}x{}",
                         requestedWidth,
                         requestedHeight,
                         aspectWidth,
                         aspectHeight,
                         nextConfig.width,
                         nextConfig.height);
        }
    }
    if (fps > 0) {
        nextConfig.frameRate = std::clamp(fps, 10, 120);
    }

    const bool bitrateChanged = nextConfig.bitrate != videoConfig_.bitrate;
    const bool resolutionChanged = nextConfig.width != videoConfig_.width || nextConfig.height != videoConfig_.height;
    const bool fpsChanged = nextConfig.frameRate != videoConfig_.frameRate;
    const bool requiresReinit = resolutionChanged || fpsChanged;

    if (!capturing_) {
        videoConfig_ = nextConfig;
        activeHqWidth_ = std::max(2, nextConfig.width & ~1);
        activeHqHeight_ = std::max(2, nextConfig.height & ~1);
        hqAspectLocked_ = false;
        publishVideoStateSnapshotLocked();
        if (hasResolutionRequest) {
            width = videoConfig_.width;
            height = videoConfig_.height;
        }
        return true;
    }

    if (!bitrateChanged && !resolutionChanged && !fpsChanged) {
        if (hasResolutionRequest) {
            width = videoConfig_.width;
            height = videoConfig_.height;
        }
        return true;
    }

    const auto previousConfig = videoConfig_;
    if (requiresReinit) {
        spdlog::info("[App] Applying runtime video reconfigure: {}x{} @{}fps {}kbps",
                     nextConfig.width,
                     nextConfig.height,
                     nextConfig.frameRate,
                     nextConfig.bitrate);
        videoEncoder_.shutdown();
        const auto previousPrimaryConfig = primaryVideoEncoderConfig(previousConfig);
        const auto nextPrimaryConfig = primaryVideoEncoderConfig(nextConfig);
        if (!videoEncoder_.initialize(nextPrimaryConfig)) {
            spdlog::error("[App] Failed runtime reconfigure; restoring previous encoder config");
            if (!videoEncoder_.initialize(previousPrimaryConfig)) {
                spdlog::error("[App] Failed to restore previous encoder config after runtime reconfigure failure");
            } else {
                activeHqWidth_ = std::max(2, previousConfig.width & ~1);
                activeHqHeight_ = std::max(2, previousConfig.height & ~1);
                hqAspectLocked_ = false;
                publishVideoStateSnapshotLocked();
            }
            return false;
        }
        activeHqWidth_ = std::max(2, nextConfig.width & ~1);
        activeHqHeight_ = std::max(2, nextConfig.height & ~1);
        lastHqReconfigureMs_ = steadyNowMs();
        hqAspectLocked_ = false;
    } else if (bitrateChanged) {
        spdlog::info("[App] Applying runtime bitrate update: {} kbps", nextConfig.bitrate);
        videoEncoder_.setBitrate(nextConfig.bitrate);
    }

    if (usesVp9AlphaTrack(nextConfig) && requiresReinit) {
        clearAlphaEncodeQueues();
        {
            std::lock_guard<std::mutex> alphaLock(alphaEncoderMutex_);
            videoEncoderAlpha_.shutdown();
            if (!videoEncoderAlpha_.initialize(alphaVideoEncoderConfig(nextConfig))) {
                spdlog::warn("[App] VP9 alpha encoder reconfigure failed; continuing without alpha channel");
                nextConfig.enableAlpha = false;
                videoEncoderAlpha_.shutdown();
            }
        }
        clearAlphaEncodeQueues();
    } else if (usesVp9AlphaTrack(nextConfig) && bitrateChanged) {
        const video::EncoderConfig alphaConfig = alphaVideoEncoderConfig(nextConfig);
        spdlog::info("[App] Queuing VP9 alpha bitrate update: {} kbps", alphaConfig.bitrate);
        queueAlphaEncoderReconfigure(alphaConfig);
    } else if (!usesVp9AlphaTrack(nextConfig)) {
        clearAlphaEncodeQueues();
        {
            std::lock_guard<std::mutex> alphaLock(alphaEncoderMutex_);
            videoEncoderAlpha_.shutdown();
        }
        clearAlphaEncodeQueues();
    }

    videoConfig_ = nextConfig;
    publishVideoStateSnapshotLocked();
    if (hasResolutionRequest || bitrateRequested) {
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
    }
    if (hasResolutionRequest) {
        width = videoConfig_.width;
        height = videoConfig_.height;
    }
    return true;
}

bool VersusApp::applyRuntimeAudioControl(int bitrateKbps) {
    const int targetKbps = bitrateKbps <= 0 ? 192 : std::clamp(bitrateKbps, 6, 510);

    if (!capturing_) {
        audioEncoderBitrateKbps_.store(targetKbps, std::memory_order_relaxed);
        return true;
    }

    std::lock_guard<std::mutex> encodeLock(audioEncodeMutex_);
    if (!opusEncoder_.setBitrate(targetKbps)) {
        return false;
    }

    audioEncoderBitrateKbps_.store(targetKbps, std::memory_order_relaxed);
    spdlog::info("[App] Applying runtime audio bitrate update: {} kbps", targetKbps);
    return true;
}

bool VersusApp::enforceRoomCodecLock() {
    if (room_.empty()) {
        return true;
    }
    if (!roomModeLqEnabled_.load(std::memory_order_relaxed)) {
        return true;
    }
    bool needsCodecLock = false;
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        needsCodecLock = videoConfig_.codec != video::VideoCodec::H264;
    }
    if (!needsCodecLock) {
        return true;
    }

    if (!roomCodecWarningEmitted_) {
        roomCodecWarningEmitted_ = true;
        emitRuntimeEvent(
            "Room Quality uses H.264 for mixed-tier room compatibility. Disable Room Quality to try the selected codec in room mode.",
            false);
    }

    std::lock_guard<std::mutex> lock(videoSendMutex_);
    if (videoConfig_.codec == video::VideoCodec::H264) {
        return true;
    }
    const auto previousConfig = videoConfig_;
    videoConfig_.codec = video::VideoCodec::H264;
    videoConfig_.enableAlpha = false;
    videoConfig_.forceFfmpegNvenc = false;

    if (!capturing_) {
        publishVideoStateSnapshotLocked();
        return true;
    }

    videoEncoder_.shutdown();
    shutdownLqEncoderLocked();
    if (videoEncoder_.initialize(videoConfig_)) {
        activeHqWidth_ = std::max(2, videoConfig_.width & ~1);
        activeHqHeight_ = std::max(2, videoConfig_.height & ~1);
        lastHqReconfigureMs_ = steadyNowMs();
        hqAspectLocked_ = false;
        publishVideoStateSnapshotLocked();
        return true;
    }

    spdlog::error("[App] Failed to enforce room-mode H.264 lock; restoring previous codec");
    videoConfig_ = previousConfig;
    if (!videoEncoder_.initialize(primaryVideoEncoderConfig(previousConfig))) {
        spdlog::error("[App] Failed to restore previous encoder config after room codec lock failure");
    } else {
        activeHqWidth_ = std::max(2, previousConfig.width & ~1);
        activeHqHeight_ = std::max(2, previousConfig.height & ~1);
        hqAspectLocked_ = false;
        publishVideoStateSnapshotLocked();
    }
    return false;
}

void VersusApp::applyPeerInitState(const std::shared_ptr<PeerSession> &peer,
                                   bool roleValid,
                                   PeerRole role,
                                   bool videoEnabled,
                                   bool audioEnabled) {
    if (!peer) {
        return;
    }

    peer->roleValid.store(roleValid, std::memory_order_relaxed);
    peer->role.store(role, std::memory_order_relaxed);
    peer->videoEnabled.store(videoEnabled, std::memory_order_relaxed);
    peer->audioEnabled.store(audioEnabled, std::memory_order_relaxed);

    if (peer->roomMode) {
        const bool initReady = roleValid;
        const StreamTier tier = assignStreamTier(
            true,
            roomModeLqEnabled_.load(std::memory_order_relaxed),
            roleValid,
            role);
        peer->initReceived.store(initReady, std::memory_order_relaxed);
        peer->assignedTier.store(tier, std::memory_order_relaxed);
        if (initReady) {
            peer->initDeadlineMs.store(0, std::memory_order_relaxed);
        }
        spdlog::info("[App] Peer init {}:{} roomMode=1 role={} roleValid={} tier={} video={} audio={}",
                     peer->uuid,
                     peer->session,
                     peerRoleName(role),
                     roleValid,
                     streamTierName(tier),
                     videoEnabled,
                     audioEnabled);
        recordPeerEvent(peer, std::string("peer-init room role=") + peerRoleName(role) +
                                  " tier=" + streamTierName(tier));
        return;
    }

    peer->initReceived.store(true, std::memory_order_relaxed);
    peer->assignedTier.store(StreamTier::HQ, std::memory_order_relaxed);
    peer->initDeadlineMs.store(0, std::memory_order_relaxed);
    spdlog::info("[App] Peer init {}:{} roomMode=0 role={} roleValid={} tier=hq video={} audio={}",
                 peer->uuid,
                 peer->session,
                 peerRoleName(role),
                 roleValid,
                 videoEnabled,
                 audioEnabled);
    recordPeerEvent(peer, std::string("peer-init direct role=") + peerRoleName(role) + " tier=hq");
}

void VersusApp::pruneTimedOutPeerInits(int64_t nowMs) {
    std::vector<std::shared_ptr<PeerSession>> expired;
    std::vector<std::shared_ptr<PeerSession>> disconnected;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        for (const auto &entry : peerSessions_) {
            const auto &peer = entry.second;
            if (!peer) {
                continue;
            }
            const int64_t disconnectedSinceMs = peer->disconnectedSinceMs.load(std::memory_order_relaxed);
            if (disconnectedSinceMs > 0 && (nowMs - disconnectedSinceMs) >= kDisconnectedPeerPruneMs) {
                disconnected.push_back(peer);
                continue;
            }
            if (peer->initReceived.load(std::memory_order_relaxed)) {
                continue;
            }
            const int64_t deadlineMs = peer->initDeadlineMs.load(std::memory_order_relaxed);
            if (deadlineMs <= 0 || nowMs < deadlineMs) {
                continue;
            }
            expired.push_back(peer);
        }
    }

    for (const auto &peer : disconnected) {
        const int64_t disconnectedSinceMs = peer->disconnectedSinceMs.load(std::memory_order_relaxed);
        if (disconnectedSinceMs <= 0 || (nowMs - disconnectedSinceMs) < kDisconnectedPeerPruneMs) {
            continue;
        }
        spdlog::info("[WebRTC] Pruning stale disconnected peer {}:{} after {}ms",
                     peer->uuid,
                     peer->session,
                     nowMs - disconnectedSinceMs);
        removePeerSession(peer, "stale-disconnected-prune");
    }

    for (const auto &peer : expired) {
        if (peer->initReceived.load(std::memory_order_relaxed)) {
            continue;
        }
        peer->initDeadlineMs.store(0, std::memory_order_relaxed);
        const bool dataChannelOpen =
            peer->dataChannelOpen.load(std::memory_order_relaxed) ||
            (peer->client && peer->client->isDataChannelOpen());
        if (!dataChannelOpen) {
            continue;
        }
        peer->dataChannelOpen.store(true, std::memory_order_relaxed);

        if (!peer->roomMode && peer->sawPeerInfoMessage.load(std::memory_order_relaxed)) {
            // A real info heartbeat is already in flight for this direct peer.
            // Let that path own initialization/capability negotiation instead
            // of racing it with the timeout fallback.
            continue;
        }

        if (peer->roomMode) {
            const StreamTier fallbackTier = assignStreamTier(
                true,
                roomModeLqEnabled_.load(std::memory_order_relaxed),
                true,
                PeerRole::Viewer);
            spdlog::info("[App] Implicit room init fallback {}:{} -> viewer/{}",
                         peer->uuid,
                         peer->session,
                         streamTierName(fallbackTier));
        } else {
            // Direct viewers that never send control metadata fall back to viewer/HQ after the grace window.
            spdlog::info("[App] Implicit direct init fallback {}:{} -> viewer/hq",
                         peer->uuid,
                         peer->session);
        }
        applyPeerInitState(peer, true, PeerRole::Viewer, true, true);
        applyPeerMediaPlan(peer, peer->roomMode ? "room-init-fallback" : "direct-init-fallback");
        sendPeerDataInfo(peer, true);
    }
}

bool VersusApp::ensureLqEncoderInitializedLocked() {
    if (lqEncoderInitialized_.load(std::memory_order_relaxed)) {
        return true;
    }

    video::EncoderConfig lqConfig = videoConfig_;
    lqConfig.codec = video::VideoCodec::H264;
    lqConfig.preferredHardware = video::HardwareEncoder::None;
    lqConfig.forceFfmpegNvenc = false;
    lqConfig.ffmpegPath.clear();
    lqConfig.ffmpegOptions.clear();
    lqConfig.width = kLqWidth;
    lqConfig.height = kLqHeight;
    lqConfig.frameRate = kLqFps;
    lqConfig.bitrate = kLqBitrateKbps;
    lqConfig.minBitrate = 1000;
    lqConfig.maxBitrate = 3000;
    lqConfig.gopSize = 30;
    lqConfig.bFrames = 0;
    lqConfig.lowLatency = true;

    if (!videoEncoderLq_.initialize(lqConfig)) {
        spdlog::error("[App] Failed to initialize LQ encoder");
        return false;
    }

    lqEncoderInitialized_.store(true, std::memory_order_relaxed);
    publishVideoStateSnapshotLocked();
    spdlog::info("[App] LQ encoder active: {} ({}x{}@{} {}kbps)",
                 videoEncoderLq_.activeEncoderName(),
                 kLqWidth,
                 kLqHeight,
                 kLqFps,
                 kLqBitrateKbps);
    return true;
}

void VersusApp::shutdownLqEncoderLocked() {
    if (!lqEncoderInitialized_.load(std::memory_order_relaxed)) {
        return;
    }
    videoEncoderLq_.shutdown();
    lqEncoderInitialized_.store(false, std::memory_order_relaxed);
    publishVideoStateSnapshotLocked();
}

void VersusApp::sendPeerDataInfo(const std::shared_ptr<PeerSession> &peer, bool includeMiniStats) {
    if (!peer || !peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    const PeerRole peerRole = peer->role.load(std::memory_order_relaxed);
    const bool roleValid = peer->roleValid.load(std::memory_order_relaxed);
    const bool initReceived = peer->initReceived.load(std::memory_order_relaxed);
    const bool videoEnabled = peer->videoEnabled.load(std::memory_order_relaxed);
    const bool audioEnabled = peer->audioEnabled.load(std::memory_order_relaxed);
    StreamTier assignedTier = assignStreamTier(
        peer->roomMode,
        roomModeLqEnabled_.load(std::memory_order_relaxed),
        roleValid,
        peerRole);

    const VideoStateSnapshot videoState = videoStateSnapshot();
    const int requestedVideoBitrate = peer->requestedVideoBitrateKbps.load(std::memory_order_relaxed);
    const bool alphaReceiverUsesHq =
        assignedTier != StreamTier::None &&
        videoEnabled &&
        usesVp9AlphaTrack(videoState.config) &&
        peer->alphaAllowed.load(std::memory_order_relaxed);
    if (alphaReceiverUsesHq) {
        assignedTier = StreamTier::HQ;
    } else if (assignedTier != StreamTier::None &&
               requestedVideoBitrate > 0 &&
               requestedVideoBitrate <= kLqBitrateKbps) {
        assignedTier = StreamTier::LQ;
    }
    peer->assignedTier.store(assignedTier, std::memory_order_relaxed);

    const bool peerWantsLq = assignedTier == StreamTier::LQ;
    const int effectiveBitrate =
        alphaReceiverUsesHq
            ? videoState.config.bitrate
            : (requestedVideoBitrate > 0
                   ? requestedVideoBitrate
                   : (peerWantsLq ? kLqBitrateKbps : videoState.config.bitrate));
    const int effectiveWidth = peerWantsLq ? kLqWidth : videoState.hqWidth;
    const int effectiveHeight = peerWantsLq ? kLqHeight : videoState.hqHeight;
    const int effectiveFps = peerWantsLq ? kLqFps : videoState.config.frameRate;
    const StreamMetrics streamMetrics = buildStreamMetricsSnapshot(false);
    const double aggregateVideoKbps = streamMetrics.videoBitrateKbps;
    const double aggregateAudioKbps = streamMetrics.audioBitrateKbps;
    const double sentFps = streamMetrics.frameRate;

    nlohmann::json msg;
    nlohmann::json info;

    info["label"] = startOptions_.label;
    info["version"] = publisherVersionTag();
    info["maxviewers_url"] = maxViewers_.load(std::memory_order_relaxed);
    info["quality_url"] = effectiveBitrate;
    info["width_url"] = effectiveWidth;
    info["height_url"] = effectiveHeight;
    info["fps_url"] = effectiveFps;
    info["video_init_width"] = effectiveWidth;
    info["video_init_height"] = effectiveHeight;
    info["video_init_frameRate"] = effectiveFps;
    info["codec_url"] = peerWantsLq ? "H.264" : videoCodecName(videoState.config.codec);
    if (peerWantsLq) {
        info["video_encoder"] = videoState.lqEncoderInitialized
            ? videoState.lqEncoderName
            : "LQ-CPU-H264";
        info["video_codec"] = "H.264";
        info["hardware_encoder"] = false;
    } else {
        info["video_encoder"] = videoState.encoderName;
        info["video_codec"] = videoState.codecName;
        info["video_encoder_input_format"] = videoState.encoderInputFormat;
        info["hardware_encoder"] = videoState.hardwareEncoder;
    }
    info["room_init"] = !room_.empty();
    info["room_init_received"] = initReceived;
    info["broadcast_mode"] = true;
    info["remote"] = remoteControlEnabled_.load(std::memory_order_relaxed);
    info["allowdrawing"] = false;
    info["obs_control"] = false;
    info["screenShareState"] = false;
    info["video_muted_init"] = !videoEnabled;
    info["muted"] = !audioEnabled;
    info["proaudio_init"] = false;
    info["assigned_role"] = peerRoleName(peerRole);
    info["assigned_tier"] = streamTierName(assignedTier);
    info["requested_video_bitrate_kbps"] = requestedVideoBitrate;
    info["requested_audio_bitrate_kbps"] = peer->requestedAudioBitrateKbps.load(std::memory_order_relaxed);
    info["audio_source"] = audioSourceModeName(audioSourceMode_);
    const bool additionalMicrophoneActive =
        includeMicrophone_ &&
        audioSourceMode_ != AudioSourceMode::DefaultMicrophone &&
        activeMicrophoneSourceName_ != "none";
    info["include_microphone"] = additionalMicrophoneActive;
    info["additional_audio_source"] = additionalMicrophoneActive ? activeMicrophoneSourceName_ : "none";
    info["resolution"] = resolutionLabel(effectiveWidth, effectiveHeight);
    info["video_bitrate_kbps"] = aggregateVideoKbps;
    info["audio_bitrate_kbps"] = aggregateAudioKbps;
    info["nacks_per_second"] = 0;
    info["sent_fps"] = sentFps;
    info["video_bytes_sent"] = videoBytesSent_.load(std::memory_order_relaxed);
    info["audio_bytes_sent"] = audioBytesSent_.load(std::memory_order_relaxed);
    info["video_frames_dropped"] = streamMetrics.videoFramesDropped;
    info["dropped_frame_rate"] = streamMetrics.droppedFrameRate;
    if (!peer->peerLabel.empty()) {
        info["peer_label"] = peer->peerLabel;
    }
    if (!peer->systemApp.empty()) {
        info["system_app"] = peer->systemApp;
    }
    if (!peer->systemVersion.empty()) {
        info["system_version"] = peer->systemVersion;
    }
    if (!peer->systemPlatform.empty()) {
        info["system_platform"] = peer->systemPlatform;
    }
    if (!peer->systemBrowser.empty()) {
        info["system_browser"] = peer->systemBrowser;
    }
    if (usesVp9AlphaTrack(videoState.config)) {
        info["alpha_send"] = "vp9-dualtrack-v1";
        info["alpha_active"] = peer->alphaAllowed.load(std::memory_order_relaxed);
    }
    if (includeMiniStats) {
        const PeerCounts counts = collectPeerCounts();
        const int roomOnlyTier =
            roomModeLqEnabled_.load(std::memory_order_relaxed) &&
                counts.roomGuests > 0 &&
                counts.roomScenes == 0 &&
                counts.roomNonGuestViewers == 0 &&
                counts.hq == 0
                ? 2
                : 0;
        info["room_only_tier"] = roomOnlyTier;
        nlohmann::json miniInfo;
        miniInfo["out"] = {
            {"c", counts.total},
            {"peers", counts.total},
            {"hq_peers", counts.hq},
            {"lq_peers", counts.lq},
            {"active_video", counts.activeVideo},
            {"active_audio", counts.activeAudio},
            {"kbps", aggregateVideoKbps + aggregateAudioKbps},
            {"video_kbps", aggregateVideoKbps},
            {"audio_kbps", aggregateAudioKbps},
            {"fps", sentFps},
            {"width", effectiveWidth},
            {"height", effectiveHeight},
            {"codec", peerWantsLq ? "H.264" : videoCodecName(videoState.config.codec)}};
        miniInfo["rot"] = roomOnlyTier;
        msg["miniInfo"] = miniInfo;
    }

    msg["info"] = info;
    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::sendPeerRemoteStats(const std::shared_ptr<PeerSession> &peer) {
    if (!peer || !peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    int width = lastSentWidth_.load(std::memory_order_relaxed);
    int height = lastSentHeight_.load(std::memory_order_relaxed);
    const VideoStateSnapshot videoState = videoStateSnapshot();
    if (width <= 0 || height <= 0) {
        width = videoState.hqWidth;
        height = videoState.hqHeight;
    }

    const StreamMetrics streamMetrics = buildStreamMetricsSnapshot(false);
    const double aggregateVideoKbps = streamMetrics.videoBitrateKbps;
    const double aggregateAudioKbps = streamMetrics.audioBitrateKbps;
    const PeerCounts counts = collectPeerCounts();
    const int roomOnlyTier =
        roomModeLqEnabled_.load(std::memory_order_relaxed) &&
                counts.roomGuests > 0 &&
                counts.roomScenes == 0 &&
                counts.roomNonGuestViewers == 0 &&
                counts.hq == 0
            ? 2
            : 0;

    nlohmann::json stats;
    stats["label"] = startOptions_.label.empty() ? "Game Capture" : startOptions_.label;
    stats["video_bitrate_kbps"] = aggregateVideoKbps;
    stats["audio_bitrate_kbps"] = aggregateAudioKbps;
    stats["available_outgoing_bitrate_kbps"] = videoState.config.bitrate;
    stats["nacks_per_second"] = 0;
    stats["resolution"] = resolutionLabel(width, height);
    stats["video_encoder"] = videoState.encoderName;
    stats["video_codec"] = videoState.codecName;
    stats["video_encoder_input_format"] = videoState.encoderInputFormat;
    stats["fps"] = streamMetrics.frameRate;
    stats["video_frames_dropped"] = streamMetrics.videoFramesDropped;
    stats["dropped_frame_rate"] = streamMetrics.droppedFrameRate;
    stats["room_only_tier"] = roomOnlyTier;
    stats["peers"] = counts.total;
    stats["active_video"] = counts.activeVideo;
    stats["active_audio"] = counts.activeAudio;

    const std::string key = streamId_.empty() ? std::string("game-capture") : streamId_;
    nlohmann::json msg;
    msg["remoteStats"][key] = stats;
    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::sendPeerAudioOptions(const std::shared_ptr<PeerSession> &peer) {
    if (!peer || !peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    nlohmann::json options = nlohmann::json::array();
    if (audioSourceMode_ != AudioSourceMode::None || includeMicrophone_) {
        std::string microphoneLabel = activeMicrophoneSourceName_;
        std::string microphoneDeviceId = microphoneDeviceId_;
        if (microphoneLabel == "default-microphone" ||
            microphoneLabel == "selected-microphone" ||
            microphoneLabel.empty()) {
            const auto devices = microphoneAudioCapture_.GetInputDevices();
            for (const auto &device : devices) {
                if ((!microphoneDeviceId_.empty() && device.id == microphoneDeviceId_) ||
                    (microphoneDeviceId_.empty() && device.isDefault)) {
                    microphoneLabel = device.name.empty() ? std::string("Microphone/input device") : device.name;
                    microphoneDeviceId = device.id;
                    break;
                }
            }
            if (microphoneLabel == "default-microphone" || microphoneLabel.empty()) {
                microphoneLabel = "Default microphone/input";
            } else if (microphoneLabel == "selected-microphone") {
                microphoneLabel = "Selected microphone/input";
            }
        }

        std::string label;
        switch (audioSourceMode_) {
            case AudioSourceMode::SelectedWindow:
                label = "Selected window/app audio";
                break;
            case AudioSourceMode::DefaultOutput:
                label = "Default system output";
                break;
            case AudioSourceMode::CommunicationsOutput:
                label = "Communications output";
                break;
            case AudioSourceMode::DefaultMicrophone:
                label = microphoneLabel;
                break;
            case AudioSourceMode::None:
            default:
                label = includeMicrophone_ ? microphoneLabel : "";
                break;
        }
        if (includeMicrophone_ &&
            audioSourceMode_ != AudioSourceMode::DefaultMicrophone &&
            audioSourceMode_ != AudioSourceMode::None) {
            label += " + " + microphoneLabel;
        }

        nlohmann::json track;
        track["trackLabel"] = label.empty() ? "Game Capture audio" : label;
        track["deviceId"] = microphoneDeviceId.empty() ? "game-capture-audio" : microphoneDeviceId;
        track["audioConstraints"] = nlohmann::json::object();
        track["currentAudioConstraints"] = {
            {"sampleRate", 48000},
            {"channelCount", 2}
        };
        track["equalizer"] = false;
        track["lowcut"] = false;
        track["subGain"] = false;
        track["gating"] = false;
        track["compressor"] = false;
        track["micDelay"] = false;
        track["micPanning"] = false;
        options.push_back(std::move(track));
    }

    nlohmann::json msg;
    msg["UUID"] = peer->uuid;
    msg["audioOptions"] = options;
    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::sendPeerVideoOptions(const std::shared_ptr<PeerSession> &peer) {
    if (!peer || !peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    const VideoStateSnapshot videoState = videoStateSnapshot();
    const int width = std::max(2, videoState.hqWidth);
    const int height = std::max(2, videoState.hqHeight);
    const int fps = std::max(1, videoState.config.frameRate);

    nlohmann::json options;
    options["trackLabel"] = "Game Capture window";
    options["currentCameraConstraints"] = {
        {"width", width},
        {"height", height},
        {"frameRate", fps}
    };
    options["cameraConstraints"] = {
        {"width", integerRange(160, std::max(3840, width), 2)},
        {"height", integerRange(90, std::max(2160, height), 2)},
        {"frameRate", integerRange(1, std::max(120, fps), 1)}
    };

    nlohmann::json msg;
    msg["UUID"] = peer->uuid;
    msg["videoOptions"] = options;
    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::sendPeerMediaDevices(const std::shared_ptr<PeerSession> &peer) {
    if (!peer || !peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    nlohmann::json devices = nlohmann::json::array();
    devices.push_back({
        {"deviceId", selectedWindowId_.empty() ? "game-capture-window" : selectedWindowId_},
        {"kind", "videoinput"},
        {"label", "Game Capture window"},
        {"groupId", "game-capture"}
    });

    const auto inputDevices = microphoneAudioCapture_.GetInputDevices();
    for (const auto &device : inputDevices) {
        devices.push_back({
            {"deviceId", device.id.empty() ? "default" : device.id},
            {"kind", "audioinput"},
            {"label", device.name.empty() ? "Microphone/input device" : device.name},
            {"groupId", device.isDefault ? "default-audioinput" : "audioinput"}
        });
    }

    nlohmann::json msg;
    msg["UUID"] = peer->uuid;
    msg["mediaDevices"] = devices;
    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::sendPeerMediaDeviceChange(const std::shared_ptr<PeerSession> &peer,
                                          const char *kind,
                                          bool ok,
                                          const std::string &deviceId,
                                          const std::string &error) {
    if (!peer || !peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    nlohmann::json msg;
    msg["UUID"] = peer->uuid;
    msg["mediaDeviceChange"] = {
        {"kind", kind ? kind : "unknown"},
        {"ok", ok},
        {"deviceId", deviceId.empty() ? nlohmann::json(false) : nlohmann::json(deviceId)},
        {"error", error.empty() ? nlohmann::json(false) : nlohmann::json(error)}
    };
    if (!ok) {
        if (kind && std::string(kind) == "camera") {
            msg["rejected"] = "changeCamera";
        } else if (kind && std::string(kind) == "microphone") {
            msg["rejected"] = "changeMicrophone";
        } else if (kind && std::string(kind) == "speaker") {
            msg["rejected"] = "changeSpeaker";
        }
        msg["message"] = error.empty() ? "Device change is not supported by Game Capture." : error;
    }
    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::handlePeerDataMessage(const std::shared_ptr<PeerSession> &peer, const std::string &message) {
    if (!peer) {
        return;
    }
    if (tryHandlePeerSignalMessage(peer, message)) {
        return;
    }

    auto msg = nlohmann::json::parse(message, nullptr, false);
    if (msg.is_discarded()) {
        return;
    }
    if (!msg.is_object()) {
        return;
    }

    const bool peerByeRequested = msg.contains("bye");
    const bool peerCleanupRequested =
        msg.contains("request") &&
        msg["request"].is_string() &&
        toLowerCopy(msg["request"].get<std::string>()) == "cleanup";
    if (peerByeRequested || peerCleanupRequested) {
        const char *cleanupKind = peerByeRequested ? "bye" : "cleanup";
        const char *cleanupReason = peerByeRequested ? "peer-bye" : "peer-cleanup";
        spdlog::info("[WebRTC] Peer sent {} {}:{}; removing session", cleanupKind, peer->uuid, peer->session);
        removePeerSession(peer, cleanupReason);
        return;
    }

    if (msg.contains("cbid")) {
        nlohmann::json callbackResponse;
        callbackResponse["cbid"] = msg["cbid"];
        peer->client->sendDataMessage(callbackResponse.dump());
    }

    auto parseIntValue = [&msg](const char *key, int defaultValue = 0) {
        if (!msg.contains(key)) {
            return defaultValue;
        }
        return jsonIntLike(msg[key], defaultValue);
    };
    auto parseRateLimitValue = [](const nlohmann::json &value, int defaultValue = -1) {
        if (value.is_boolean()) {
            return value.get<bool>() ? defaultValue : -1;
        }
        return jsonIntLike(value, defaultValue);
    };
    auto parseStringValue = [](const nlohmann::json &value) -> std::string {
        if (value.is_string()) {
            return value.get<std::string>();
        }
        if (value.is_number_integer()) {
            if (value.is_number_unsigned()) {
                return std::to_string(value.get<uint64_t>());
            }
            return std::to_string(value.get<int64_t>());
        }
        return {};
    };

    std::string action;
    const nlohmann::json *actionValue = nullptr;
    if (msg.contains("action") && msg["action"].is_string()) {
        action = toLowerCopy(msg["action"].get<std::string>());
        if (msg.contains("value")) {
            actionValue = &msg["value"];
        }
    }
    auto controlTokenFromMessage = [&msg]() -> std::string {
        if (msg.contains("remote") && msg["remote"].is_string()) {
            return msg["remote"].get<std::string>();
        }
        return {};
    };
    const bool actionIsVideo = action == "video" || action == "camera";
    const bool actionIsAudio = action == "audio" || action == "mic";

    if (msg.contains("iceRestartRequest")) {
        spdlog::info("[WebRTC] Peer requested data-channel ICE restart {}:{}", peer->uuid, peer->session);
        peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        if (!sendPeerOffer(peer, "datachannel-ice-restart", true)) {
            spdlog::warn("[App] Failed to refresh peer connection from data-channel ICE restart {}:{}",
                         peer->uuid,
                         peer->session);
        }
        return;
    }

    const nlohmann::json *infoPtr = nullptr;
    if (msg.contains("info") && msg["info"].is_object()) {
        infoPtr = &msg["info"];
    }
    if (infoPtr) {
        peer->sawPeerInfoMessage.store(true, std::memory_order_relaxed);
        const auto &info = *infoPtr;
        {
            std::lock_guard<std::mutex> diagnosticsLock(peer->diagnosticsMutex);
            if (info.contains("label") && info["label"].is_string()) {
                peer->peerLabel = info["label"].get<std::string>();
            }
            if (info.contains("system") && info["system"].is_object()) {
                const auto &system = info["system"];
                if (system.contains("app") && system["app"].is_string()) {
                    peer->systemApp = system["app"].get<std::string>();
                }
                if (system.contains("version") && system["version"].is_string()) {
                    peer->systemVersion = system["version"].get<std::string>();
                }
                if (system.contains("platform") && system["platform"].is_string()) {
                    peer->systemPlatform = system["platform"].get<std::string>();
                }
                if (system.contains("browser") && system["browser"].is_string()) {
                    peer->systemBrowser = system["browser"].get<std::string>();
                }
            }
            if (info.contains("system_app") && info["system_app"].is_string()) {
                peer->systemApp = info["system_app"].get<std::string>();
            }
            if (info.contains("system_version") && info["system_version"].is_string()) {
                peer->systemVersion = info["system_version"].get<std::string>();
            } else if (peer->systemVersion.empty() && info.contains("version") && info["version"].is_string()) {
                peer->systemVersion = info["version"].get<std::string>();
            }
            if (info.contains("system_platform") && info["system_platform"].is_string()) {
                peer->systemPlatform = info["system_platform"].get<std::string>();
            } else if (info.contains("platform") && info["platform"].is_string()) {
                peer->systemPlatform = info["platform"].get<std::string>();
            }
            if (info.contains("system_browser") && info["system_browser"].is_string()) {
                peer->systemBrowser = info["system_browser"].get<std::string>();
            } else if (info.contains("Browser") && info["Browser"].is_string()) {
                peer->systemBrowser = info["Browser"].get<std::string>();
            } else if (info.contains("browser") && info["browser"].is_string()) {
                peer->systemBrowser = info["browser"].get<std::string>();
            }
        }

        bool alphaFieldPresent = false;
        std::string alphaReceiveMode;
        if (info.contains("alpha_receive")) {
            alphaFieldPresent = true;
            if (info["alpha_receive"].is_string()) {
                alphaReceiveMode = info["alpha_receive"].get<std::string>();
            } else if (jsonBoolLike(info["alpha_receive"], false)) {
                alphaReceiveMode = "vp9-dualtrack-v1";
            }
        } else if (info.contains("alphaReceive")) {
            alphaFieldPresent = true;
            if (info["alphaReceive"].is_string()) {
                alphaReceiveMode = info["alphaReceive"].get<std::string>();
            } else if (jsonBoolLike(info["alphaReceive"], false)) {
                alphaReceiveMode = "vp9-dualtrack-v1";
            }
        }
        if (alphaFieldPresent) {
            const bool alphaAllowed = alphaReceiveMode == "vp9-dualtrack-v1";
            const bool previousAlphaAllowed = peer->alphaAllowed.load(std::memory_order_relaxed);
            peer->alphaAllowed.store(alphaAllowed, std::memory_order_relaxed);
            {
                std::lock_guard<std::mutex> diagnosticsLock(peer->diagnosticsMutex);
                peer->alphaReceiveMode = alphaAllowed ? alphaReceiveMode : "";
            }
            if (previousAlphaAllowed != alphaAllowed) {
                spdlog::info("[App] Peer info {}:{} alphaReceive={} mode={}",
                             peer->uuid,
                             peer->session,
                             alphaAllowed,
                             alphaAllowed ? alphaReceiveMode : "none");
                if (peer->initReceived.load(std::memory_order_relaxed)) {
                    applyPeerMediaPlan(peer, "peer-alpha-capability");
                    sendPeerDataInfo(peer, true);
                }
            }
        }
    }

    if (msg.contains("ping")) {
        nlohmann::json pong;
        pong["pong"] = msg["ping"];
        peer->client->sendDataMessage(pong.dump());
    }

    const bool audioSettingsRequested =
        msg.contains("getAudioSettings") && jsonBoolLike(msg["getAudioSettings"], true);
    const bool videoSettingsRequested =
        msg.contains("getVideoSettings") && jsonBoolLike(msg["getVideoSettings"], true);
    const std::string controlToken = controlTokenFromMessage();
    const bool controlAuthorized = isControlMessageAuthorized(peer, controlToken);
    const bool directorAuthorized =
        peer &&
        peer->roomMode &&
        peer->roleValid.load(std::memory_order_relaxed) &&
        peer->role.load(std::memory_order_relaxed) == PeerRole::Director;
    auto sendRejectedControl = [this, &peer](const char *rejectedName, const char *message) {
        nlohmann::json rejected;
        rejected["rejected"] = rejectedName;
        if (message && *message) {
            rejected["message"] = message;
        }
        peer->rejectedControlCount.fetch_add(1, std::memory_order_relaxed);
        recordPeerEvent(peer, std::string("rejected-control ") + (rejectedName ? rejectedName : "unknown"));
        peer->client->sendDataMessage(rejected.dump());
    };

    const bool hasRequestAsTargetedControl =
        msg.contains("requestAs") &&
        (msg.contains("targetBitrate") ||
         msg.contains("optimizedBitrate") ||
         msg.contains("targetAudioBitrate") ||
         msg.contains("requestResolution"));
    if (hasRequestAsTargetedControl) {
        const std::string requesterUuid = msg.contains("UUID") ? parseStringValue(msg["UUID"]) : "";
        const std::string requestAsTarget = parseStringValue(msg["requestAs"]);
        const std::string nativeStatsKey = streamId_.empty() ? std::string("game-capture") : streamId_;
        const bool targetMatchesNative =
            !requestAsTarget.empty() &&
            (requestAsTarget == nativeStatsKey || requestAsTarget == peer->streamId);

        if (requesterUuid.empty()) {
            spdlog::warn("[App] Ignoring requestAs control from {} without requester UUID", peer->uuid);
            return;
        }
        if (!targetMatchesNative) {
            spdlog::warn("[App] Ignoring requestAs control from {} for non-native target '{}'",
                         peer->uuid,
                         requestAsTarget);
            return;
        }
        if (!controlAuthorized) {
            spdlog::warn("[App] Ignoring unauthorized requestAs control from {} for '{}'",
                         peer->uuid,
                         requestAsTarget);
            return;
        }
    }

    if (msg.contains("hangup")) {
        if (!controlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized VDO hangup from {}", peer->uuid);
            sendRejectedControl("hangup", "Remote hangup is not authorized.");
        } else {
            spdlog::info("[App] Remote hangup requested by {}:{}; stopping stream", peer->uuid, peer->session);
            stopLive();
            stopCapture();
            emitRuntimeEvent("Stopped by remote VDO.Ninja hangup.", true);
        }
        return;
    }

    if (audioSettingsRequested || videoSettingsRequested) {
        if (!directorAuthorized) {
            spdlog::warn("[App] Rejected unauthorized Control Center settings request from {}", peer->uuid);
        } else {
            if (audioSettingsRequested) {
                sendPeerAudioOptions(peer);
            }
            if (videoSettingsRequested) {
                sendPeerVideoOptions(peer);
            }
            sendPeerMediaDevices(peer);
        }
    }
    if (msg.contains("refreshMicrophone")) {
        if (!directorAuthorized) {
            spdlog::warn("[App] Rejected unauthorized refreshMicrophone from {}", peer->uuid);
            sendRejectedControl("refreshMicrophone", "Remote microphone refresh is not authorized.");
        } else {
            sendPeerAudioOptions(peer);
            sendPeerMediaDevices(peer);
        }
    }
    if (msg.contains("refreshVideo")) {
        if (!controlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized refreshVideo from {}", peer->uuid);
            sendRejectedControl("refreshVideo", "Remote video refresh is not authorized.");
        } else {
            sendPeerVideoOptions(peer);
            sendPeerMediaDevices(peer);
        }
    }
    if (msg.contains("changeCamera")) {
        if (!directorAuthorized) {
            spdlog::warn("[App] Rejected unauthorized changeCamera from {}", peer->uuid);
            sendRejectedControl("changeCamera", "Remote camera changes are not authorized.");
        } else {
            const std::string deviceId = msg["changeCamera"].is_string() ? msg["changeCamera"].get<std::string>() : "";
            const std::string currentWindowDeviceId = selectedWindowId_.empty() ? "game-capture-window" : selectedWindowId_;
            const bool sameDevice = deviceId.empty() || deviceId == "game-capture-window" || deviceId == currentWindowDeviceId;
            sendPeerMediaDeviceChange(
                peer,
                "camera",
                sameDevice,
                deviceId,
                sameDevice ? "" : "Changing the captured window from VDO.Ninja Control Center is not supported.");
            if (sameDevice) {
                sendPeerVideoOptions(peer);
                sendPeerMediaDevices(peer);
            }
        }
    }
    if (msg.contains("changeMicrophone")) {
        const std::string deviceId =
            msg["changeMicrophone"].is_string() ? msg["changeMicrophone"].get<std::string>() : "";
        if (!directorAuthorized) {
            spdlog::warn("[App] Rejected unauthorized changeMicrophone from {}", peer->uuid);
            sendRejectedControl("changeMicrophone", "Remote microphone changes are not authorized.");
        } else {
            sendPeerMediaDeviceChange(
                peer,
                "microphone",
                false,
                deviceId,
                "Changing microphone devices live from VDO.Ninja Control Center is not supported.");
        }
    }
    if (msg.contains("changeSpeaker")) {
        const std::string deviceId =
            msg["changeSpeaker"].is_string() ? msg["changeSpeaker"].get<std::string>() : "";
        if (!directorAuthorized) {
            spdlog::warn("[App] Rejected unauthorized changeSpeaker from {}", peer->uuid);
            sendRejectedControl("changeSpeaker", "Remote speaker changes are not authorized.");
        } else {
            sendPeerMediaDeviceChange(
                peer,
                "speaker",
                false,
                deviceId,
                "Changing speaker/output devices from Game Capture is not applicable.");
        }
    }
    const std::array<const char *, 39> unsupportedVdoControlKeys = {
        "obsCommand",
        "getOBSState",
        "requestAudioHack",
        "requestVideoRecord",
        "changeOrder",
        "changeURL",
        "changeLabel",
        "restartWhip",
        "reload",
        "scale",
        "pan",
        "tilt",
        "zoom",
        "focus",
        "autofocus",
        "exposure",
        "keyframeRate",
        "requestChangeEQ",
        "requestChangeLowcut",
        "requestChangeGating",
        "requestChangeCompressor",
        "requestChangeSubGain",
        "requestChangeMicPanning",
        "requestChangeMicDelay",
        "lowerhand",
        "displayMute",
        "speakerMute",
        "micIsolate",
        "micIsolated",
        "lowerVolume",
        "requestUpload",
        "stopClock",
        "resumeClock",
        "setClock",
        "hideClock",
        "showClock",
        "startClock",
        "pauseClock",
        "showTime"};
    for (const char *unsupportedKey : unsupportedVdoControlKeys) {
        if (msg.contains(unsupportedKey)) {
            spdlog::warn("[App] Rejected unsupported VDO control {} from {}", unsupportedKey, peer->uuid);
            sendRejectedControl(unsupportedKey, "This VDO.Ninja Control Center command is not supported by Game Capture.");
        }
    }
    if (msg.contains("group")) {
        spdlog::warn("[App] Rejected unsupported VDO control group from {}", peer->uuid);
        sendRejectedControl("group", "This VDO.Ninja Control Center command is not supported by Game Capture.");
    }
    if (msg.contains("rotate")) {
        spdlog::warn("[App] Rejected unsupported VDO control rotate from {}", peer->uuid);
        sendRejectedControl("rotate", "This VDO.Ninja Control Center command is not supported by Game Capture.");
    }
    if (msg.contains("mirrorGuestState") && msg.contains("mirrorGuestTarget")) {
        spdlog::warn("[App] Rejected unsupported VDO control mirrorGuestState from {}", peer->uuid);
        sendRejectedControl("mirrorGuestState", "This VDO.Ninja Control Center command is not supported by Game Capture.");
    }
    if (msg.contains("getConnectionMap")) {
        spdlog::warn("[App] Rejected unsupported VDO control getConnectionMap from {}", peer->uuid);
        sendRejectedControl("getConnectionMap", "This VDO.Ninja Control Center command is not supported by Game Capture.");
    }
    if (msg.contains("reconnectPeer")) {
        spdlog::warn("[App] Rejected unsupported VDO control reconnectPeer from {}", peer->uuid);
        sendRejectedControl("reconnectPeer", "This VDO.Ninja Control Center command is not supported by Game Capture.");
    }

    const bool hasInlineInitFields =
        msg.contains("role") ||
        msg.contains("scene") ||
        msg.contains("director") ||
        msg.contains("guest") ||
        msg.contains("viewer") ||
        msg.contains("video") ||
        msg.contains("audio") ||
        actionIsVideo ||
        actionIsAudio;
    const nlohmann::json *initPtr = nullptr;
    const bool infoHasInitFields = infoPtr &&
        (infoPtr->contains("role") ||
         infoPtr->contains("scene") ||
         infoPtr->contains("director") ||
         infoPtr->contains("guest") ||
         infoPtr->contains("viewer") ||
         infoPtr->contains("video") ||
         infoPtr->contains("audio"));
    if (msg.contains("init") && msg["init"].is_object()) {
        initPtr = &msg["init"];
    } else if (hasInlineInitFields) {
        initPtr = &msg;
    } else if (infoHasInitFields) {
        initPtr = infoPtr;
    } else if (!peer->roomMode && infoPtr) {
        // For direct viewers, receiving the standard VDO.Ninja info handshake is
        // enough to classify the peer as a viewer and negotiate media.
        initPtr = &msg;
    }

    if (initPtr) {
        const auto &init = *initPtr;
        PeerRole role = PeerRole::Unknown;
        bool roleValid = false;
        const bool hasRoleString = init.contains("role") && init["role"].is_string();
        // Stock VDO.Ninja room scene links advertise the scene slot id (often "0"),
        // not a boolean role flag. Treat any present non-false scene field as a scene request.
        const bool sceneRequested =
            init.contains("scene") &&
            !init["scene"].is_null() &&
            !(init["scene"].is_boolean() && !init["scene"].get<bool>());
        const bool directorRequested = init.contains("director") && jsonBoolLike(init["director"], false);
        const bool guestRequested = init.contains("guest") && jsonBoolLike(init["guest"], false);
        const bool viewerRequested = init.contains("viewer") && jsonBoolLike(init["viewer"], false);
        const bool hasExplicitRoleSignal =
            hasRoleString || sceneRequested || directorRequested || guestRequested || viewerRequested;

        if (!peer->roomMode && !hasExplicitRoleSignal) {
            role = PeerRole::Viewer;
            roleValid = true;
        }

        if (hasRoleString) {
            role = parsePeerRole(init["role"].get<std::string>());
            roleValid = role != PeerRole::Unknown;
        }
        if (!roleValid && sceneRequested) {
            role = PeerRole::Scene;
            roleValid = true;
        }
        if (!roleValid && directorRequested) {
            role = PeerRole::Director;
            roleValid = true;
        }
        if (!roleValid && guestRequested) {
            role = PeerRole::Guest;
            roleValid = true;
        }
        if (!roleValid && viewerRequested) {
            role = PeerRole::Viewer;
            roleValid = true;
        }

        const bool hasExplicitMediaSignal = init.contains("video") || init.contains("audio") || actionIsVideo || actionIsAudio;
        const bool invalidExplicitRoleSignal = hasExplicitRoleSignal && !roleValid;
        if (invalidExplicitRoleSignal) {
            spdlog::warn("[App] Ignoring invalid peer init role {}:{}",
                         peer->uuid,
                         peer->session);

            sendPeerDataInfo(peer, true);
            return;
        }

        const bool initAlreadyReceived = peer->initReceived.load(std::memory_order_relaxed);
        const bool currentVideoEnabled = peer->videoEnabled.load(std::memory_order_relaxed);
        const bool currentAudioEnabled = peer->audioEnabled.load(std::memory_order_relaxed);
        bool videoEnabled = initAlreadyReceived ? currentVideoEnabled : true;
        bool audioEnabled = initAlreadyReceived ? currentAudioEnabled : true;
        if (init.contains("video")) {
            videoEnabled = jsonToggleBool(init["video"], currentVideoEnabled, videoEnabled);
        }
        if (init.contains("audio")) {
            audioEnabled = jsonToggleBool(init["audio"], currentAudioEnabled, audioEnabled);
        }
        if (actionIsVideo) {
            videoEnabled = actionValue ? jsonToggleBool(*actionValue, currentVideoEnabled, !currentVideoEnabled)
                                       : !currentVideoEnabled;
        }
        if (actionIsAudio) {
            audioEnabled = actionValue ? jsonToggleBool(*actionValue, currentAudioEnabled, !currentAudioEnabled)
                                       : !currentAudioEnabled;
        }

        {
            std::lock_guard<std::mutex> diagnosticsLock(peer->diagnosticsMutex);
            if (init.contains("label") && init["label"].is_string()) {
                peer->peerLabel = init["label"].get<std::string>();
            }
            if (init.contains("system") && init["system"].is_object()) {
                const auto &system = init["system"];
                if (system.contains("app") && system["app"].is_string()) {
                    peer->systemApp = system["app"].get<std::string>();
                }
                if (system.contains("version") && system["version"].is_string()) {
                    peer->systemVersion = system["version"].get<std::string>();
                }
                if (system.contains("platform") && system["platform"].is_string()) {
                    peer->systemPlatform = system["platform"].get<std::string>();
                }
                if (system.contains("browser") && system["browser"].is_string()) {
                    peer->systemBrowser = system["browser"].get<std::string>();
                }
            }
            if (init.contains("platform") && init["platform"].is_string()) {
                peer->systemPlatform = init["platform"].get<std::string>();
            }
            if (init.contains("Browser") && init["Browser"].is_string()) {
                peer->systemBrowser = init["Browser"].get<std::string>();
            } else if (init.contains("browser") && init["browser"].is_string()) {
                peer->systemBrowser = init["browser"].get<std::string>();
            }
        }

        if (!hasExplicitRoleSignal && initAlreadyReceived) {
            role = peer->role.load(std::memory_order_relaxed);
            roleValid = peer->roleValid.load(std::memory_order_relaxed);
        }

        const bool metadataOnlyRefresh =
            !hasExplicitRoleSignal && !hasExplicitMediaSignal && initAlreadyReceived;
        if (metadataOnlyRefresh) {
            // Direct viewers often send a later info heartbeat after we have
            // already promoted them through the grace-window fallback. Treat
            // that as metadata/capability refresh only, not a second init. Do
            // not return here; VDO data-channel messages can carry additional
            // top-level requests such as keyframe or requestStats.
            if (peer->roomMode) {
                sendPeerDataInfo(peer, true);
            }
        } else {
            const bool videoMuteStateChanged = initAlreadyReceived && currentVideoEnabled != videoEnabled;
            const bool audioMuteStateChanged = initAlreadyReceived && currentAudioEnabled != audioEnabled;

            applyPeerInitState(peer, roleValid, role, videoEnabled, audioEnabled);
            if (peer->roomMode && roleValid) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
            }

            sendPeerDataInfo(peer, true);
            if ((videoMuteStateChanged || audioMuteStateChanged) && peer->client && peer->client->isDataChannelOpen()) {
                nlohmann::json muteState;
                if (videoMuteStateChanged) {
                    muteState["videoMuted"] = !videoEnabled;
                }
                if (audioMuteStateChanged) {
                    muteState["muteState"] = !audioEnabled;
                }
                peer->client->sendDataMessage(muteState.dump());
            }
            applyPeerMediaPlan(peer, hasExplicitRoleSignal ? "peer-init" : "peer-media-update");
        }
    }

    const bool requestKeyframe = (msg.contains("keyframe") ? jsonBoolLike(msg["keyframe"], false) : false) ||
                                 (msg.contains("requestKeyframe") ? jsonBoolLike(msg["requestKeyframe"], false) : false) ||
                                 action == "forcekeyframe";
    if (requestKeyframe) {
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
    }

    bool directorMediaStateChanged = false;
    bool directorMediaStateAuthorized = true;
    if (msg.contains("remoteVideoMuted") || msg.contains("volume")) {
        directorMediaStateAuthorized = directorAuthorized;
    }
    if (msg.contains("remoteVideoMuted")) {
        if (!directorMediaStateAuthorized) {
            spdlog::warn("[App] Rejected unauthorized remoteVideoMuted from {}", peer->uuid);
            nlohmann::json rejected;
            rejected["rejected"] = "remoteVideoMuted";
            peer->client->sendDataMessage(rejected.dump());
        } else {
            const bool muted = jsonBoolLike(msg["remoteVideoMuted"], false);
            peer->videoEnabled.store(!muted, std::memory_order_relaxed);
            peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
            nlohmann::json confirm;
            confirm["videoMuted"] = muted;
            peer->client->sendDataMessage(confirm.dump());
            directorMediaStateChanged = true;
        }
    }
    if (msg.contains("volume")) {
        if (!directorMediaStateAuthorized) {
            spdlog::warn("[App] Rejected unauthorized volume control from {}", peer->uuid);
            nlohmann::json rejected;
            rejected["rejected"] = "volume";
            peer->client->sendDataMessage(rejected.dump());
        } else {
            const int volume = jsonIntLike(msg["volume"], 100);
            const bool muted = volume <= 0;
            peer->audioEnabled.store(!muted, std::memory_order_relaxed);
            nlohmann::json confirm;
            confirm["muteState"] = muted;
            peer->client->sendDataMessage(confirm.dump());
            directorMediaStateChanged = true;
        }
    }
    if (directorMediaStateChanged) {
        if (peer->initReceived.load(std::memory_order_relaxed)) {
            applyPeerMediaPlan(peer, "director-media-control");
        }
        sendPeerDataInfo(peer, true);
    }

    bool peerMediaRateChanged = false;
    int requestedBitrate = 0;
    if (msg.contains("bitrate")) {
        const int requestedPeerBitrate = parseRateLimitValue(msg["bitrate"], -1);
        peer->requestedVideoBitrateKbps.store(requestedPeerBitrate, std::memory_order_relaxed);
        peerMediaRateChanged = true;
        peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
    }
    if (msg.contains("audioBitrate")) {
        const int requestedAudioBitrate = parseRateLimitValue(msg["audioBitrate"], -1);
        peer->requestedAudioBitrateKbps.store(requestedAudioBitrate, std::memory_order_relaxed);
        peerMediaRateChanged = true;
    }
    if (msg.contains("targetBitrate")) {
        const bool unlockTargetBitrate =
            msg["targetBitrate"].is_boolean() && !msg["targetBitrate"].get<bool>();
        const int requestedTargetBitrate = unlockTargetBitrate ? -1 : jsonIntLike(msg["targetBitrate"], -1);
        if (unlockTargetBitrate || requestedTargetBitrate > 0) {
            peer->requestedVideoBitrateKbps.store(requestedTargetBitrate, std::memory_order_relaxed);
            peerMediaRateChanged = true;
            if (requestedTargetBitrate > 0) {
                requestedBitrate = requestedTargetBitrate;
            } else {
                requestedBitrate = configuredVideoBitrateKbps_.load(std::memory_order_relaxed);
            }
            peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        }
    }
    if (msg.contains("optimizedBitrate")) {
        const bool unlockOptimizedBitrate =
            msg["optimizedBitrate"].is_boolean() && !msg["optimizedBitrate"].get<bool>();
        const int requestedOptimizedBitrate =
            unlockOptimizedBitrate ? -1 : jsonIntLike(msg["optimizedBitrate"], -1);
        if (unlockOptimizedBitrate || requestedOptimizedBitrate >= 0) {
            peer->requestedVideoBitrateKbps.store(requestedOptimizedBitrate, std::memory_order_relaxed);
            peerMediaRateChanged = true;
            peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        }
    }
    if (msg.contains("targetAudioBitrate")) {
        const bool unlockTargetAudioBitrate =
            msg["targetAudioBitrate"].is_boolean() && !msg["targetAudioBitrate"].get<bool>();
        const int requestedAudioBitrate =
            unlockTargetAudioBitrate ? -1 : jsonIntLike(msg["targetAudioBitrate"], -1);
        if (unlockTargetAudioBitrate || requestedAudioBitrate > 0) {
            peer->requestedAudioBitrateKbps.store(requestedAudioBitrate, std::memory_order_relaxed);
            peerMediaRateChanged = true;
            if (!applyRuntimeAudioControl(requestedAudioBitrate)) {
                spdlog::warn("[App] Failed to apply data-channel audio bitrate request from {}", peer->uuid);
            }
        }
    }
    bool sendPeerInfoAfterRateChange = false;
    if (peerMediaRateChanged) {
        if (peer->initReceived.load(std::memory_order_relaxed)) {
            applyPeerMediaPlan(peer, "peer-rate-limit");
            sendPeerInfoAfterRateChange = true;
        }
    }

    int requestedWidth = 0;
    int requestedHeight = 0;
    int requestedFps = 0;
    bool vdoScaleResolutionRequest = false;
    bool vdoScaleResolutionCover = false;
    if (action == "bitrate" && actionValue) {
        requestedBitrate = jsonIntLike(*actionValue, 0);
    }
    if (msg.contains("requestResolution") && msg["requestResolution"].is_object()) {
        const auto &resolution = msg["requestResolution"];
        vdoScaleResolutionRequest = resolution.contains("w") || resolution.contains("h");
        if (resolution.contains("c")) {
            vdoScaleResolutionCover = jsonBoolLike(resolution["c"], false);
        }
        if (resolution.contains("w")) {
            requestedWidth = jsonIntLike(resolution["w"], 0);
        }
        if (resolution.contains("h")) {
            requestedHeight = jsonIntLike(resolution["h"], 0);
        }
        if (resolution.contains("f")) {
            requestedFps = jsonIntLike(resolution["f"], 0);
        } else if (resolution.contains("fps")) {
            requestedFps = jsonIntLike(resolution["fps"], 0);
        }
    } else if (msg.contains("requestResolution") && msg["requestResolution"].is_string()) {
        parseResolutionString(msg["requestResolution"].get<std::string>(), requestedWidth, requestedHeight);
    }
    if (action == "requestresolution" && actionValue) {
        if (actionValue->is_string()) {
            parseResolutionString(actionValue->get<std::string>(), requestedWidth, requestedHeight);
        } else if (actionValue->is_object()) {
            if (actionValue->contains("w")) {
                requestedWidth = jsonIntLike((*actionValue)["w"], requestedWidth);
            }
            if (actionValue->contains("h")) {
                requestedHeight = jsonIntLike((*actionValue)["h"], requestedHeight);
            }
            if (actionValue->contains("f")) {
                requestedFps = jsonIntLike((*actionValue)["f"], requestedFps);
            } else if (actionValue->contains("fps")) {
                requestedFps = jsonIntLike((*actionValue)["fps"], requestedFps);
            }
        }
    }
    if ((action == "setwidth" || action == "width") && actionValue) {
        requestedWidth = jsonIntLike(*actionValue, requestedWidth);
    }
    if ((action == "setheight" || action == "height") && actionValue) {
        requestedHeight = jsonIntLike(*actionValue, requestedHeight);
    }

    bool videoSettingsControlRequested = false;
    if (msg.contains("requestVideoHack")) {
        const std::string token = controlTokenFromMessage();

        if (!isControlMessageAuthorized(peer, token)) {
            spdlog::warn("[App] Rejected unauthorized requestVideoHack from {}", peer->uuid);
        } else {
            const std::string keyName = msg.contains("keyname") && msg["keyname"].is_string()
                ? toLowerCopy(msg["keyname"].get<std::string>())
                : "";
            const nlohmann::json *value = msg.contains("value") ? &msg["value"] : nullptr;
            const bool lockAspect = msg.contains("ctrl") && jsonBoolLike(msg["ctrl"], false);
            if (value && (keyName == "width" || keyName == "setwidth")) {
                requestedWidth = jsonIntLike(*value, requestedWidth);
                if (!lockAspect && requestedHeight <= 0) {
                    requestedHeight = videoStateSnapshot().hqHeight;
                }
                videoSettingsControlRequested = true;
            } else if (value && (keyName == "height" || keyName == "setheight")) {
                requestedHeight = jsonIntLike(*value, requestedHeight);
                if (!lockAspect && requestedWidth <= 0) {
                    requestedWidth = videoStateSnapshot().hqWidth;
                }
                videoSettingsControlRequested = true;
            } else if (value && (keyName == "framerate" || keyName == "fps")) {
                requestedFps = jsonIntLike(*value, requestedFps);
                videoSettingsControlRequested = true;
            } else {
                nlohmann::json rejected;
                rejected["rejected"] = "requestVideoHack";
                rejected["message"] = "This Game Capture setting cannot be changed from VDO.Ninja Control Center.";
                if (!keyName.empty()) {
                    rejected["keyname"] = keyName;
                }
                peer->client->sendDataMessage(rejected.dump());
            }
        }
    }

    const bool hasControlRequest =
        requestedBitrate > 0 ||
        requestedWidth > 0 ||
        requestedHeight > 0 ||
        requestedFps > 0;

    bool sentPeerInfoForControl = false;
    if (hasControlRequest) {
        if (peer->roomMode && !peer->initReceived.load(std::memory_order_relaxed)) {
            spdlog::debug("[App] Ignoring data-channel bitrate/resolution request before room init from {}", peer->uuid);
            return;
        }

        const bool ok = applyRuntimeVideoControl(requestedBitrate,
                                                 requestedWidth,
                                                 requestedHeight,
                                                 requestedFps,
                                                 vdoScaleResolutionRequest,
                                                 vdoScaleResolutionCover);
        if (ok) {
            sendPeerDataInfo(peer, true);
            sentPeerInfoForControl = true;
            if (videoSettingsControlRequested) {
                sendPeerVideoOptions(peer);
            }
        } else {
            spdlog::warn("[App] Failed to apply data-channel bitrate/resolution request from {}", peer->uuid);
        }
    }
    if (sendPeerInfoAfterRateChange && !sentPeerInfoForControl) {
        sendPeerDataInfo(peer, true);
    }

    const bool refreshConnectionRequested =
        msg.contains("refreshConnection");
    const bool refreshAllRequested =
        msg.contains("refreshAll");
    if (refreshConnectionRequested || refreshAllRequested) {
        const std::string token = controlTokenFromMessage();
        if (!isControlMessageAuthorized(peer, token)) {
            spdlog::warn("[App] Rejected unauthorized connection refresh from {}", peer->uuid);
            sendRejectedControl(
                refreshAllRequested ? "refreshAll" : "refreshConnection",
                refreshAllRequested
                    ? "Remote full refresh is not authorized."
                    : "Remote connection refresh is not authorized.");
        } else {
            if (refreshAllRequested) {
                sendPeerAudioOptions(peer);
                sendPeerVideoOptions(peer);
                sendPeerMediaDevices(peer);
            }
            const char *reason = refreshAllRequested ? "refresh-all" : "refresh-connection";
            std::vector<std::shared_ptr<PeerSession>> peersToRefresh;
            {
                std::lock_guard<std::mutex> lock(peerSessionsMutex_);
                peersToRefresh.reserve(peerSessions_.size());
                for (const auto &entry : peerSessions_) {
                    if (entry.second && entry.second->client) {
                        peersToRefresh.push_back(entry.second);
                    }
                }
            }
            spdlog::info("[App] Control recovery {} requested by {}:{}; rebuilding {} peer connection(s)",
                         reason,
                         peer->uuid,
                         peer->session,
                         peersToRefresh.size());
            for (const auto &refreshPeer : peersToRefresh) {
                if (!refreshPeer || !refreshPeer->client) {
                    continue;
                }
                refreshPeer->waitingForKeyframe.store(true, std::memory_order_relaxed);
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                if (!sendPeerOffer(refreshPeer, reason, true)) {
                    spdlog::warn("[App] Failed to refresh peer connection {}:{}",
                                 refreshPeer->uuid,
                                 refreshPeer->session);
                }
            }
        }
    }

    if (msg.contains("requestStatsContinuous")) {
        const bool enabled = jsonBoolLike(msg["requestStatsContinuous"], false);
        peer->statsContinuous.store(enabled, std::memory_order_relaxed);
        if (enabled) {
            sendPeerDataInfo(peer, true);
            sendPeerRemoteStats(peer);
        }
    }

    const bool statsRequested = (msg.contains("requestStats") && jsonBoolLike(msg["requestStats"], false)) ||
                                (msg.contains("getStats") && jsonBoolLike(msg["getStats"], false)) ||
                                action == "requeststats" ||
                                action == "getstats" ||
                                action == "getdetails";
    if (statsRequested) {
        sendPeerDataInfo(peer, true);
        sendPeerRemoteStats(peer);
    }
}

bool VersusApp::encodeAndSendVideoFrame(const video::CapturedFrame &frame, bool forceKeyframe) {
    if (!live_) {
        return false;
    }

    const auto totalStart = std::chrono::steady_clock::now();
    int64_t lockWaitElapsedMs = 0;
    int64_t hqEncodeElapsedMs = 0;
    int64_t lqEncodeElapsedMs = 0;
    int64_t sendElapsedMs = 0;
    std::unique_lock<std::mutex> lock(videoSendMutex_);
    lockWaitElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - totalStart)
                            .count();
    if (!live_) {
        return false;
    }
    bool renegotiateH264CodecFallback = false;

    std::vector<std::shared_ptr<PeerSession>> hqPeers;
    std::vector<std::shared_ptr<PeerSession>> lqPeers;
    {
        std::lock_guard<std::mutex> peersLock(peerSessionsMutex_);
        hqPeers.reserve(peerSessions_.size());
        lqPeers.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (!entry.second || !entry.second->client || !entry.second->client->hasActiveVideoTrack()) {
                continue;
            }

            auto &peer = entry.second;
            const PeerRouteState route{
                peer->roomMode,
                roomModeLqEnabled_.load(std::memory_order_relaxed),
                peer->initReceived.load(std::memory_order_relaxed),
                peer->roleValid.load(std::memory_order_relaxed),
                peer->role.load(std::memory_order_relaxed),
                peer->videoEnabled.load(std::memory_order_relaxed),
                peer->audioEnabled.load(std::memory_order_relaxed)};
            if (!canSendVideo(route)) {
                continue;
            }

            const int requestedVideoBitrate = peer->requestedVideoBitrateKbps.load(std::memory_order_relaxed);
            if (requestedVideoBitrate == 0) {
                continue;
            }
            const bool alphaReceiverNeedsHq =
                usesVp9AlphaTrack(videoConfig_) &&
                peer->alphaAllowed.load(std::memory_order_relaxed);
            const StreamTier policyTier = assignStreamTier(
                route.roomMode,
                route.roomModeLqEnabled,
                route.roleValid,
                route.role);
            StreamTier tier = policyTier;
            if (alphaReceiverNeedsHq) {
                tier = StreamTier::HQ;
            } else if (requestedVideoBitrate > 0 && requestedVideoBitrate <= kLqBitrateKbps) {
                tier = StreamTier::LQ;
            }
            peer->assignedTier.store(tier, std::memory_order_relaxed);
            if (tier == StreamTier::HQ) {
                hqPeers.push_back(peer);
            } else if (tier == StreamTier::LQ) {
                lqPeers.push_back(peer);
            }
        }
    }

    if (hqPeers.empty() && lqPeers.empty()) {
        shutdownLqEncoderLocked();
        return false;
    }

    const int64_t nowMs = steadyNowMs();

    if (!hqPeers.empty()) {
        if (!adaptHqEncoderToFrameLocked(frame, nowMs)) {
            return false;
        }
    }

    bool requestKeyframe = forceKeyframe || pendingGlobalKeyframe_.exchange(false, std::memory_order_relaxed);

    video::EncodedPacket hqPacket;
    video::EncodedPacket lqPacket;
    bool haveHqPacket = false;
    bool haveLqPacket = false;

    if (!hqPeers.empty()) {
        const bool externalFfmpegEncoder =
            videoEncoder_.activeEncoderName().find("FFmpeg") != std::string::npos;
        auto fallbackUnstableSoftwareCodec = [&](const char *reason) {
            if (videoEncoder_.activeCodec() == video::VideoCodec::H264) {
                return false;
            }
            if (usesVp9AlphaTrack(videoConfig_)) {
                const video::EncoderConfig recoveryConfig = primaryVideoEncoderConfig(videoConfig_);
                spdlog::warn("[App] {}. Restarting the {} color encoder while preserving alpha",
                             reason,
                             videoCodecName(videoConfig_.codec));
                videoEncoder_.shutdown();
                if (videoEncoder_.initialize(recoveryConfig)) {
                    activeHqWidth_ = std::max(2, recoveryConfig.width & ~1);
                    activeHqHeight_ = std::max(2, recoveryConfig.height & ~1);
                    publishVideoStateSnapshotLocked();
                    softwareExternalEncodeFailCount_ = 0;
                    softwareExternalFailWindowStartMs_ = 0;
                    softwareOverloadSamples_.store(0, std::memory_order_relaxed);
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                    lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                    emitRuntimeEvent(
                        "VP9 color encoder was restarted after a hard failure; alpha remained enabled.",
                        false);
                    return false;
                }

                const int64_t warnNowMs = steadyNowMs();
                const int64_t lastWarnMs = lastAlphaWarningMs_.load(std::memory_order_relaxed);
                if (lastWarnMs == 0 || (warnNowMs - lastWarnMs) > 15000) {
                    lastAlphaWarningMs_.store(warnNowMs, std::memory_order_relaxed);
                    emitRuntimeEvent(
                        "VP9 color encoder failed and could not be restarted while alpha was enabled.",
                        true);
                }
                softwareExternalEncodeFailCount_ = 0;
                softwareExternalFailWindowStartMs_ = 0;
                spdlog::error("[App] {}. Failed to restart the VP9 color encoder", reason);
                return false;
            }

            video::EncoderConfig fallbackConfig = videoConfig_;
            fallbackConfig.codec = video::VideoCodec::H264;
            fallbackConfig.enableAlpha = false;
            fallbackConfig.forceFfmpegNvenc = false;

            videoEncoder_.shutdown();
            if (!videoEncoder_.initialize(fallbackConfig)) {
                spdlog::error("[App] {} but H.264 fallback initialization failed", reason);
                return false;
            }

            videoConfig_ = fallbackConfig;
            publishVideoStateSnapshotLocked();
            softwareExternalEncodeFailCount_ = 0;
            softwareExternalFailWindowStartMs_ = 0;
            softwareOverloadSamples_.store(0, std::memory_order_relaxed);
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
            emitRuntimeEvent("Software fallback encoder was unstable; switched to H.264 for stability.", false);
            spdlog::warn("[App] {}. Switched to '{}' ({})",
                         reason,
                         videoEncoder_.activeEncoderName(),
                         videoEncoder_.activeCodecName());
            return true;
        };
        if (requestKeyframe && !externalFfmpegEncoder) {
            videoEncoder_.requestKeyframe();
        }

        const auto encodeStart = std::chrono::steady_clock::now();
        const bool hardwareEncodingBefore = videoEncoder_.isHardwareEncoderActive();
        const bool encodeOk = videoEncoder_.encode(frame, hqPacket);
        hqEncodeElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 std::chrono::steady_clock::now() - encodeStart)
                                 .count();
        video::EncodeFailureKind encodeFailureKind = videoEncoder_.lastEncodeFailureKind();
        if (!encodeOk && encodeFailureKind == video::EncodeFailureKind::None) {
            encodeFailureKind = video::EncodeFailureKind::Timeout;
        }
        if (!encodeOk) {
            if (encodeFailureKind == video::EncodeFailureKind::Timeout ||
                encodeFailureKind == video::EncodeFailureKind::Backpressure) {
                videoEncodeTimeouts_.fetch_add(1, std::memory_order_relaxed);
            } else {
                videoEncodeFailures_.fetch_add(1, std::memory_order_relaxed);
                videoEncodeHardFailures_.fetch_add(1, std::memory_order_relaxed);
            }
        }

        if (hardwareEncodingBefore && !externalFfmpegEncoder) {
            hardwareEncodeSampleCount_++;
            if (!encodeOk) {
                hardwareEncodeFailCount_++;
            }
            if (!hardwareAutoFallbackTriggered_ && hardwareEncodeSampleCount_ >= kHardwareFailSampleWindow) {
                const double failRate = static_cast<double>(hardwareEncodeFailCount_) /
                                        static_cast<double>(std::max(1, hardwareEncodeSampleCount_));
                if (failRate >= kHardwareFailRatioThreshold) {
                    const std::string unstableEncoder = videoEncoder_.activeEncoderName();
                    const std::string unstableEncoderLower = toLowerCopy(unstableEncoder);
                    spdlog::warn(
                        "[App] Hardware encoder '{}' unstable (failures={}/{} {:.1f}%), attempting hardware-only recovery",
                        unstableEncoder,
                        hardwareEncodeFailCount_,
                        hardwareEncodeSampleCount_,
                        failRate * 100.0);

                    auto reinitAndCheck = [&](const video::EncoderConfig &candidateConfig,
                                              bool rejectSoftware,
                                              bool rejectSameEncoder,
                                              const char *stepLabel,
                                              const char *modeLabel) {
                        videoEncoder_.shutdown();
                        if (!videoEncoder_.initialize(candidateConfig)) {
                            spdlog::warn("[App] {} failed for mode {}", stepLabel, modeLabel);
                            return false;
                        }

                        const std::string candidateName = videoEncoder_.activeEncoderName();
                        const std::string candidateNameLower = toLowerCopy(candidateName);
                        if (rejectSoftware && !videoEncoder_.isHardwareEncoderActive()) {
                            spdlog::warn(
                                "[App] {} for mode {} resolved to software encoder '{}'; rejecting",
                                stepLabel,
                                modeLabel,
                                candidateName);
                            return false;
                        }
                        if (candidateConfig.preferredHardware != video::HardwareEncoder::None &&
                            !encoderNameMatchesHardwarePreference(candidateName, candidateConfig.preferredHardware)) {
                            spdlog::warn(
                                "[App] {} for mode {} selected mismatched encoder '{}'; rejecting",
                                stepLabel,
                                modeLabel,
                                candidateName);
                            return false;
                        }
                        if (rejectSameEncoder && candidateNameLower == unstableEncoderLower) {
                            spdlog::warn(
                                "[App] {} for mode {} selected the same unstable encoder '{}'; rejecting",
                                stepLabel,
                                modeLabel,
                                candidateName);
                            return false;
                        }
                        return true;
                    };

                    bool switchedToHardware = false;

                    if (hardwareRecoveryAttemptCount_ < kHardwareMaxSelfRecoveries) {
                        video::EncoderConfig selfRecoveryConfig = videoConfig_;
                        selfRecoveryConfig.codec = video::VideoCodec::H264;
                        selfRecoveryConfig.enableAlpha = false;
                        if (reinitAndCheck(selfRecoveryConfig, true, false, "Self-recovery reinit", "current")) {
                            hardwareRecoveryAttemptCount_++;
                            videoConfig_ = selfRecoveryConfig;
                            publishVideoStateSnapshotLocked();
                            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                            emitRuntimeEvent(
                                "Hardware encoder became unstable; restarted hardware encoder to recover.",
                                false);
                            spdlog::info("[App] Hardware self-recovery succeeded (attempt {}/{}) with '{}'",
                                         hardwareRecoveryAttemptCount_,
                                         kHardwareMaxSelfRecoveries,
                                         videoEncoder_.activeEncoderName());
                            switchedToHardware = true;
                        }
                    }

                    if (!switchedToHardware) {
                        const std::array<video::HardwareEncoder, 3> hardwareFallbackOrder = {
                            video::HardwareEncoder::QuickSync,
                            video::HardwareEncoder::AMF,
                            video::HardwareEncoder::NVENC};

                        for (const auto mode : hardwareFallbackOrder) {
                            if (mode == videoConfig_.preferredHardware) {
                                continue;
                            }

                            video::EncoderConfig candidateConfig = videoConfig_;
                            candidateConfig.preferredHardware = mode;
                            candidateConfig.codec = video::VideoCodec::H264;
                            candidateConfig.enableAlpha = false;
                            candidateConfig.forceFfmpegNvenc = false;

                            if (!reinitAndCheck(candidateConfig,
                                                true,
                                                true,
                                                "Alternate hardware recovery",
                                                hardwareEncoderLabel(mode))) {
                                continue;
                            }

                            hardwareRecoveryAttemptCount_ = 0;
                            videoConfig_ = candidateConfig;
                            publishVideoStateSnapshotLocked();
                            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                            emitRuntimeEvent(
                                "Primary hardware encoder became unstable; switched to alternate hardware encoder.",
                                false);
                            spdlog::info("[App] Switched to alternate hardware encoder '{}'",
                                         videoEncoder_.activeEncoderName());
                            switchedToHardware = true;
                            break;
                        }
                    }

                    if (!switchedToHardware) {
                        video::EncoderConfig fallbackConfig = videoConfig_;
                        fallbackConfig.preferredHardware = video::HardwareEncoder::None;
                        fallbackConfig.codec = video::VideoCodec::H264;
                        fallbackConfig.enableAlpha = false;
                        fallbackConfig.forceFfmpegNvenc = false;

                        videoEncoder_.shutdown();
                        if (videoEncoder_.initialize(fallbackConfig)) {
                            videoConfig_ = fallbackConfig;
                            publishVideoStateSnapshotLocked();
                            hardwareAutoFallbackTriggered_ = true;
                            hardwareRecoveryAttemptCount_ = 0;
                            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                            emitRuntimeEvent(
                                "All hardware encoder options were unstable; switched to software H.264.",
                                false);
                            spdlog::warn("[App] All hardware fallback options failed; switched to software H.264");
                        } else {
                            spdlog::error("[App] Software fallback encoder initialization failed");
                        }
                    }
                }
                hardwareEncodeSampleCount_ = 0;
                hardwareEncodeFailCount_ = 0;
            }
        } else if (!hardwareEncodingBefore) {
            hardwareEncodeSampleCount_ = 0;
            hardwareEncodeFailCount_ = 0;
            hardwareRecoveryAttemptCount_ = 0;
        }

        if (encodeOk) {
            haveHqPacket = true;
            const bool softwareEncoding = !videoEncoder_.isHardwareEncoderActive();
            if (softwareEncoding) {
                const int frameIntervalMs = std::max(1, 1000 / std::max(1, videoConfig_.frameRate));
                if (hqEncodeElapsedMs > (frameIntervalMs * 2)) {
                    const int samples = softwareOverloadSamples_.fetch_add(1, std::memory_order_relaxed) + 1;
                    if (samples >= 20) {
                        const int64_t nowMsLocal = steadyNowMs();
                        const int64_t lastWarnMs = lastCpuWarningMs_.load(std::memory_order_relaxed);
                        if ((lastWarnMs == 0) || ((nowMsLocal - lastWarnMs) > 15000)) {
                            lastCpuWarningMs_.store(nowMsLocal, std::memory_order_relaxed);
                            emitRuntimeEvent(
                                "CPU encoder appears overloaded. Lower bitrate/resolution/FPS or switch to NVENC/QSV.",
                                false);
                        }
                        softwareOverloadSamples_.store(0, std::memory_order_relaxed);
                    }
                } else {
                    const int current = softwareOverloadSamples_.load(std::memory_order_relaxed);
                    if (current > 0) {
                        softwareOverloadSamples_.store(current - 1, std::memory_order_relaxed);
                    }
                }
            } else {
                softwareOverloadSamples_.store(0, std::memory_order_relaxed);
            }
            if (externalFfmpegEncoder &&
                !hardwareEncodingBefore &&
                videoEncoder_.activeCodec() != video::VideoCodec::H264 &&
                softwareExternalFailWindowStartMs_ != 0 &&
                (steadyNowMs() - softwareExternalFailWindowStartMs_) > 15000) {
                softwareExternalEncodeFailCount_ = 0;
                softwareExternalFailWindowStartMs_ = 0;
            }

            if (requestKeyframe && !hqPacket.isKeyframe && !externalFfmpegEncoder) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
        } else {
            const bool transientExternalFailure =
                encodeFailureKind == video::EncodeFailureKind::Timeout ||
                encodeFailureKind == video::EncodeFailureKind::Backpressure;
            if (externalFfmpegEncoder &&
                !hardwareEncodingBefore &&
                videoEncoder_.activeCodec() != video::VideoCodec::H264 &&
                !transientExternalFailure) {
                const int64_t failNowMs = steadyNowMs();
                if (softwareExternalFailWindowStartMs_ == 0 ||
                    (failNowMs - softwareExternalFailWindowStartMs_) > 15000) {
                    softwareExternalFailWindowStartMs_ = failNowMs;
                    softwareExternalEncodeFailCount_ = 0;
                }
                softwareExternalEncodeFailCount_++;
                if (softwareExternalEncodeFailCount_ >= 2) {
                    if (fallbackUnstableSoftwareCodec("Software external encoder repeatedly failed to encode")) {
                        renegotiateH264CodecFallback = true;
                    }
                }
            } else if (transientExternalFailure) {
                const int64_t warnNowMs = steadyNowMs();
                const int64_t lastWarnMs = lastAlphaWarningMs_.load(std::memory_order_relaxed);
                if (usesVp9AlphaTrack(videoConfig_) &&
                    (lastWarnMs == 0 || (warnNowMs - lastWarnMs) > 15000)) {
                    lastAlphaWarningMs_.store(warnNowMs, std::memory_order_relaxed);
                    emitRuntimeEvent(
                        "VP9 alpha encoder is overloaded. Try 30 FPS, lower resolution, or chroma background mode.",
                        false);
                }
            } else {
                softwareExternalEncodeFailCount_ = 0;
                softwareExternalFailWindowStartMs_ = 0;
            }
            if (requestKeyframe && !externalFfmpegEncoder) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
        }
    }

    if (renegotiateH264CodecFallback) {
        lock.unlock();
        renegotiatePeersForH264CodecFallback("unstable-codec-fallback-h264");
        return false;
    }

    if (!lqPeers.empty()) {
        if (ensureLqEncoderInitializedLocked()) {
            if (requestKeyframe) {
                videoEncoderLq_.requestKeyframe();
            }
            const auto lqEncodeStart = std::chrono::steady_clock::now();
            if (videoEncoderLq_.encode(frame, lqPacket)) {
                lqEncodeElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                        std::chrono::steady_clock::now() - lqEncodeStart)
                                        .count();
                haveLqPacket = true;
                if (requestKeyframe && !lqPacket.isKeyframe) {
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                }
            } else {
                lqEncodeElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                        std::chrono::steady_clock::now() - lqEncodeStart)
                                        .count();
                videoEncodeFailures_.fetch_add(1, std::memory_order_relaxed);
                if (requestKeyframe) {
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                }
            }
        }
    } else {
        shutdownLqEncoderLocked();
    }

    if (!haveHqPacket && !haveLqPacket) {
        return false;
    }

    bool sentAny = false;
    bool sentKeyframe = false;
    uint64_t videoBytesSentThisCall = 0;
    int sentWidth = 0;
    int sentHeight = 0;
    const auto sendStart = std::chrono::steady_clock::now();

    if (haveHqPacket) {
        webrtc::EncodedVideoPacket packet;
        packet.data = hqPacket.data;
        packet.pts = hqPacket.pts;
        packet.isKeyframe = hqPacket.isKeyframe;
        for (const auto &peer : hqPeers) {
            if (!peer || !peer->client) {
                continue;
            }
            if (peer->waitingForKeyframe.load(std::memory_order_relaxed) && !packet.isKeyframe) {
                continue;
            }
            if (peer->client->sendVideo(packet)) {
                sentAny = true;
                videoBytesSentThisCall += packet.data.size();
                sentWidth = activeHqWidth_ > 0 ? activeHqWidth_ : std::max(2, videoConfig_.width & ~1);
                sentHeight = activeHqHeight_ > 0 ? activeHqHeight_ : std::max(2, videoConfig_.height & ~1);
                if (packet.isKeyframe) {
                    sentKeyframe = true;
                    peer->waitingForKeyframe.store(false, std::memory_order_relaxed);
                }
            } else {
                videoSendFailures_.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }

    // VP9 alpha: queue the alpha plane for a dedicated encoder thread and send
    // the latest completed alpha packet without blocking primary video. The
    // packet may be one frame behind, so stamp it to the primary frame it ships
    // beside; the OBS receiver pairs tracks by RTP timestamp.
    if (haveHqPacket && usesVp9AlphaTrack(videoConfig_)) {
        const int primaryWidth = activeHqWidth_ > 0 ? activeHqWidth_ : std::max(2, videoConfig_.width & ~1);
        const int primaryHeight = activeHqHeight_ > 0 ? activeHqHeight_ : std::max(2, videoConfig_.height & ~1);
        const auto [alphaWidth, alphaHeight] = alphaTrackDimensions(videoConfig_, primaryWidth, primaryHeight);
        if (buildAspectFitAlphaPlane(frame, alphaWidth, alphaHeight, alphaGrayBuffer_)) {
            queueAlphaEncodeFrame(alphaWidth, alphaHeight, frame.timestamp, std::move(alphaGrayBuffer_));
        }

        video::EncodedPacket alphaPacket;
        if (takeLatestAlphaPacket(alphaPacket)) {
            webrtc::EncodedVideoPacket alphaVPacket;
            alphaVPacket.data = std::move(alphaPacket.data);
            alphaVPacket.pts = hqPacket.pts;
            alphaVPacket.isKeyframe = alphaPacket.isKeyframe;
            for (const auto &peer : hqPeers) {
                if (!peer || !peer->client) {
                    continue;
                }
                if (!peer->alphaAllowed.load(std::memory_order_relaxed)) {
                    continue;
                }
                if (peer->waitingForKeyframe.load(std::memory_order_relaxed) && !alphaVPacket.isKeyframe) {
                    continue;
                }
                if (peer->client->sendAlphaVideo(alphaVPacket)) {
                    alphaPacketsSent_.fetch_add(1, std::memory_order_relaxed);
                } else {
                    alphaSendFailures_.fetch_add(1, std::memory_order_relaxed);
                }
            }
        }
    }
    if (haveLqPacket) {
        webrtc::EncodedVideoPacket packet;
        packet.data = lqPacket.data;
        packet.pts = lqPacket.pts;
        packet.isKeyframe = lqPacket.isKeyframe;
        for (const auto &peer : lqPeers) {
            if (!peer || !peer->client) {
                continue;
            }
            if (peer->waitingForKeyframe.load(std::memory_order_relaxed) && !packet.isKeyframe) {
                continue;
            }
            if (peer->client->sendVideo(packet)) {
                sentAny = true;
                videoBytesSentThisCall += packet.data.size();
                if (sentWidth <= 0 || sentHeight <= 0) {
                    sentWidth = kLqWidth;
                    sentHeight = kLqHeight;
                }
                if (packet.isKeyframe) {
                    sentKeyframe = true;
                    peer->waitingForKeyframe.store(false, std::memory_order_relaxed);
                }
            } else {
                videoSendFailures_.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }
    sendElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - sendStart)
                        .count();

    if (sentAny) {
        videoBytesSent_.fetch_add(videoBytesSentThisCall, std::memory_order_relaxed);
        videoFramesSent_.fetch_add(1, std::memory_order_relaxed);
        if (sentWidth > 0 && sentHeight > 0) {
            lastSentWidth_.store(sentWidth, std::memory_order_relaxed);
            lastSentHeight_.store(sentHeight, std::memory_order_relaxed);
        }
        lastVideoSendMs_.store(nowMs, std::memory_order_relaxed);
        if (sentKeyframe) {
            lastKeyframeSendMs_.store(nowMs, std::memory_order_relaxed);
        }
    }

    const int frameIntervalMs = std::max(1, 1000 / std::max(1, videoConfig_.frameRate));
    const int64_t totalElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                       std::chrono::steady_clock::now() - totalStart)
                                       .count();
    if (totalElapsedMs > frameIntervalMs * 2 || hqEncodeElapsedMs > frameIntervalMs * 2 ||
        sendElapsedMs > frameIntervalMs * 2) {
        static int slowVideoPathLogCount = 0;
        if (slowVideoPathLogCount < 10 || (slowVideoPathLogCount % 600) == 0) {
            spdlog::info("[VideoPath] slow frame total={}ms lockWait={}ms hqEncode={}ms lqEncode={}ms send={}ms hqBytes={} lqBytes={} hqPeers={} lqPeers={} keyframe={} sent={}",
                         totalElapsedMs,
                         lockWaitElapsedMs,
                         hqEncodeElapsedMs,
                         lqEncodeElapsedMs,
                         sendElapsedMs,
                         hqPacket.data.size(),
                         lqPacket.data.size(),
                         hqPeers.size(),
                         lqPeers.size(),
                         sentKeyframe,
                         sentAny);
        }
        slowVideoPathLogCount++;
    }
    return sentAny;
}

bool VersusApp::adaptHqEncoderToFrameLocked(const video::CapturedFrame &frame, int64_t nowMs) {
    if (frame.width <= 0 || frame.height <= 0) {
        return true;
    }

    const bool captureResized = frame.width != lastCaptureWidth_ || frame.height != lastCaptureHeight_;
    if (captureResized) {
        lastCaptureWidth_ = frame.width;
        lastCaptureHeight_ = frame.height;
        lastCaptureResizeMs_ = nowMs;

        if ((lastResizeKeyframeRequestMs_ == 0) ||
            ((nowMs - lastResizeKeyframeRequestMs_) >= kResizeKeyframeCooldownMs)) {
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
            lastResizeKeyframeRequestMs_ = nowMs;
        }
    }
    return true;
}

bool VersusApp::getCachedVideoFrame(video::CapturedFrame &frame) {
    {
        std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
        if (hasLatestVideoFrame_ && !latestVideoFrame_.data.empty()) {
            frame = latestVideoFrame_;
            return true;
        }
    }
    if (videoSourceMode_ == VideoSourceMode::Spout) {
        return spoutCapture_.getLatestFrame(frame);
    }
    return windowCapture_.getLatestFrame(frame);
}

void VersusApp::handleVideoFrame(video::CapturedFrame frame) {
    static int frameCount = 0;
    static auto lastLog = std::chrono::steady_clock::now();
    frameCount++;
    videoFramesCaptured_.fetch_add(1, std::memory_order_relaxed);
    updateSourceHealthFromFrame(frame);

    video::CapturedFrame frameForEncoding;
    {
        const video::EncoderConfig config = videoStateSnapshot().config;
        video::CapturedFrame compositedFrame;
        if (compositeAlphaBackground(frame, config, alphaCompositeBuffer_, compositedFrame)) {
            frameForEncoding = std::move(compositedFrame);
        } else {
            frameForEncoding = std::move(frame);
        }
    }

    {
        std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
        latestVideoFrame_ = std::move(frameForEncoding);
        hasLatestVideoFrame_ = true;
    }

    auto now = std::chrono::steady_clock::now();
    if (std::chrono::duration_cast<std::chrono::seconds>(now - lastLog).count() >= 5) {
        spdlog::info("[Frame] Received {} frames in last 5s, live={}", frameCount, live_.load());
        frameCount = 0;
        lastLog = now;
    }

    // Notify the encode thread instead of encoding inline.
    // This decouples capture from encoding so the frame producer can deliver
    // the next frame immediately without waiting for encode to finish.
    {
        std::lock_guard<std::mutex> lock(encodeNotifyMutex_);
        if (encodeFrameReady_) {
            videoFramesDropped_.fetch_add(1, std::memory_order_relaxed);
        }
        encodeFrameReady_ = true;
    }
    encodeFrameCV_.notify_one();
}

void VersusApp::startSignalingRecovery() {
    if (reconnecting_.exchange(true)) {
        return;
    }

    emitRuntimeEvent("Signaling connection dropped. Attempting to reconnect...", false);
    stopSignalingRecoveryThread();
    signalingRecoveryThread_ = std::thread([this]() {
        int attempt = 0;
        while (true) {
            if (!live_ || stopRequested_.load()) {
                reconnecting_.store(false);
                return;
            }

            attempt++;
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            spdlog::warn("[App] Signaling recovery attempt {}", attempt);

            bool recovered = false;
            {
                std::lock_guard<std::mutex> lock(signalingOpsMutex_);
                signaling_.disconnect();

                if (signaling_.connect(startOptions_.server)) {
                    signaling_.setPassword(password_);
                    if (password_ == "false" || password_ == "0" || password_ == "off") {
                        signaling_.disableEncryption();
                    }

                    bool joined = true;
                    if (!room_.empty()) {
                        signaling::RoomConfig roomConfig;
                        roomConfig.room = room_;
                        roomConfig.password = password_;
                        roomConfig.label = startOptions_.label;
                        roomConfig.streamId = streamId_;
                        roomConfig.salt = salt_;
                        joined = signaling_.joinRoom(roomConfig);
                    }

                    if (joined) {
                        recovered = signaling_.publish(streamId_, startOptions_.label);
                    }
                }

                if (!recovered) {
                    signaling_.disconnect();
                }
            }

            if (recovered) {
                spdlog::info("[App] Signaling recovery succeeded");
                emitRuntimeEvent("Reconnected to signaling server.", false);
                reconnecting_.store(false);
                return;
            }

            if (attempt == 5 || (attempt % 10) == 0) {
                emitRuntimeEvent(
                    "Still reconnecting to signaling server. Existing viewers may continue, but new viewers cannot join until reconnect succeeds.",
                    false);
            }
            const int waitSeconds = std::min(10, attempt);
            for (int tick = 0; tick < waitSeconds * 10; ++tick) {
                if (!live_ || stopRequested_.load()) {
                    reconnecting_.store(false);
                    return;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
        }
    });
}

void VersusApp::stopSignalingRecoveryThread() {
    if (!signalingRecoveryThread_.joinable()) {
        return;
    }

    if (signalingRecoveryThread_.get_id() == std::this_thread::get_id()) {
        signalingRecoveryThread_.detach();
        return;
    }
    signalingRecoveryThread_.join();
}

void VersusApp::startVideoMaintenanceThread() {
    if (videoMaintenanceRunning_.exchange(true)) {
        return;
    }

    videoMaintenanceThread_ = std::thread([this]() {
        int64_t lastInfoBroadcastMs = 0;
        while (videoMaintenanceRunning_.load()) {
            const bool sourceCapturing = videoSourceMode_ == VideoSourceMode::Spout
                ? spoutCapture_.isCapturing()
                : windowCapture_.isCapturing();
            if (capturing_.load(std::memory_order_relaxed) && !sourceCapturing) {
                videoTrackActive_.store(false, std::memory_order_relaxed);
                pendingGlobalKeyframe_.store(false, std::memory_order_relaxed);
                if (!captureBackendFailureNotified_.exchange(true, std::memory_order_relaxed)) {
                    const std::string message = videoSourceMode_ == VideoSourceMode::Spout
                        ? "Spout2 capture stopped. Select a valid Spout2 sender and start streaming again."
                        : "Window capture stopped. Select a valid window and start streaming again.";
                    spdlog::warn("[App] {}", message);
                    emitRuntimeEvent(message, true);
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }
            if (!live_ || !capturing_) {
                videoTrackActive_.store(false, std::memory_order_relaxed);
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }

            const int64_t nowMs = steadyNowMs();
            pruneTimedOutPeerInits(nowMs);
            const bool trackActive = hasAnyActiveVideoTrack();
            const bool wasTrackActive = videoTrackActive_.exchange(trackActive, std::memory_order_relaxed);
            if (trackActive && !wasTrackActive) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
            if (!trackActive) {
                std::lock_guard<std::mutex> lock(videoSendMutex_);
                shutdownLqEncoderLocked();
                std::this_thread::sleep_for(std::chrono::milliseconds(120));
                continue;
            }
            bool hasPendingInitPeer = false;
            {
                std::lock_guard<std::mutex> lock(peerSessionsMutex_);
                for (const auto &entry : peerSessions_) {
                    if (!entry.second || !entry.second->dataChannelOpen.load(std::memory_order_relaxed)) {
                        continue;
                    }
                    if (!entry.second->initReceived.load(std::memory_order_relaxed)) {
                        hasPendingInitPeer = true;
                        break;
                    }
                }
            }

            if (!hasPendingInitPeer && (nowMs - lastInfoBroadcastMs) >= kDataInfoIntervalMs) {
                std::vector<std::shared_ptr<PeerSession>> peers;
                {
                    std::lock_guard<std::mutex> lock(peerSessionsMutex_);
                    peers.reserve(peerSessions_.size());
                    for (const auto &entry : peerSessions_) {
                        if (entry.second && entry.second->dataChannelOpen.load(std::memory_order_relaxed)) {
                            peers.push_back(entry.second);
                        }
                    }
                }
                for (const auto &peer : peers) {
                    const bool continuousStats = peer->statsContinuous.load(std::memory_order_relaxed);
                    sendPeerDataInfo(peer, continuousStats);
                    if (continuousStats) {
                        sendPeerRemoteStats(peer);
                    }
                }
                lastInfoBroadcastMs = nowMs;
            }

            const int64_t lastSendMs = lastVideoSendMs_.load(std::memory_order_relaxed);
            const bool staleSend = (lastSendMs == 0) || ((nowMs - lastSendMs) >= kStaleResendMs);
            const int64_t lastKeyframeMs = lastKeyframeSendMs_.load(std::memory_order_relaxed);
            const bool periodicKeyframeDue =
                (lastKeyframeMs == 0) || ((nowMs - lastKeyframeMs) >= kPeriodicKeyframeMs);

            if (staleSend || periodicKeyframeDue) {
                video::CapturedFrame cached;
                if (getCachedVideoFrame(cached)) {
                    encodeAndSendVideoFrame(cached, periodicKeyframeDue);
                } else if (periodicKeyframeDue) {
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                }
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    });
}

void VersusApp::stopVideoMaintenanceThread() {
    videoMaintenanceRunning_.store(false);
    if (!videoMaintenanceThread_.joinable()) {
        return;
    }
    if (videoMaintenanceThread_.get_id() == std::this_thread::get_id()) {
        videoMaintenanceThread_.detach();
        return;
    }
    videoMaintenanceThread_.join();
}

void VersusApp::startAlphaEncodeThread() {
    if (alphaEncodeThreadRunning_.exchange(true, std::memory_order_acq_rel)) {
        return;
    }

    alphaEncodeThread_ = std::thread([this]() {
        spdlog::info("[AlphaEncodeThread] Started");
        while (alphaEncodeThreadRunning_.load(std::memory_order_acquire)) {
            AlphaEncodeJob job;
            video::EncoderConfig reconfigureConfig;
            bool reconfigureEncoder = false;
            {
                std::unique_lock<std::mutex> lock(alphaEncodeMutex_);
                alphaEncodeCV_.wait(lock, [this]() {
                    return !alphaEncodeThreadRunning_.load(std::memory_order_acquire) ||
                           pendingAlphaEncoderReconfigure_ ||
                           pendingAlphaEncodeJobReady_;
                });
                if (!alphaEncodeThreadRunning_.load(std::memory_order_acquire)) {
                    break;
                }
                if (pendingAlphaEncoderReconfigure_) {
                    reconfigureConfig = pendingAlphaEncoderConfig_;
                    pendingAlphaEncoderConfig_ = video::EncoderConfig{};
                    pendingAlphaEncoderReconfigure_ = false;
                    reconfigureEncoder = true;
                } else if (pendingAlphaEncodeJobReady_) {
                    job = std::move(pendingAlphaEncodeJob_);
                    pendingAlphaEncodeJob_ = AlphaEncodeJob{};
                    pendingAlphaEncodeJobReady_ = false;
                } else {
                    continue;
                }
            }

            if (reconfigureEncoder) {
                bool initialized = false;
                {
                    std::lock_guard<std::mutex> encoderLock(alphaEncoderMutex_);
                    videoEncoderAlpha_.shutdown();
                    initialized = videoEncoderAlpha_.initialize(reconfigureConfig);
                }
                {
                    std::lock_guard<std::mutex> packetLock(alphaPacketMutex_);
                    latestAlphaPacket_ = video::EncodedPacket{};
                    latestAlphaPacketReady_ = false;
                }
                if (initialized) {
                    spdlog::info("[AlphaEncodeThread] Reconfigured VP9 alpha encoder: {}x{} {}kbps",
                                 reconfigureConfig.width,
                                 reconfigureConfig.height,
                                 reconfigureConfig.bitrate);
                } else {
                    alphaEncodeFailures_.fetch_add(1, std::memory_order_relaxed);
                    {
                        std::lock_guard<std::mutex> videoLock(videoSendMutex_);
                        if (usesVp9AlphaTrack(videoConfig_)) {
                            videoConfig_.enableAlpha = false;
                            publishVideoStateSnapshotLocked();
                        }
                    }
                    {
                        std::lock_guard<std::mutex> queueLock(alphaEncodeMutex_);
                        pendingAlphaEncodeJob_ = AlphaEncodeJob{};
                        pendingAlphaEncodeJobReady_ = false;
                    }
                    emitRuntimeEvent(
                        "VP9 alpha track encoder failed to apply a runtime bitrate update. Alpha output was disabled.",
                        false);
                }
                continue;
            }

            if (job.gray.empty() || job.width <= 0 || job.height <= 0) {
                continue;
            }

            video::CapturedFrame alphaFrame;
            alphaFrame.format = video::CapturedFrame::Format::Gray;
            alphaFrame.width = job.width;
            alphaFrame.height = job.height;
            alphaFrame.stride = job.width;
            alphaFrame.timestamp = job.timestamp;
            alphaFrame.data = std::move(job.gray);

            video::EncodedPacket alphaPacket;
            bool encoded = false;
            video::EncodeFailureKind failureKind = video::EncodeFailureKind::None;
            {
                std::lock_guard<std::mutex> encoderLock(alphaEncoderMutex_);
                encoded = videoEncoderAlpha_.encode(alphaFrame, alphaPacket);
                failureKind = videoEncoderAlpha_.lastEncodeFailureKind();
            }
            if (!encoded && failureKind == video::EncodeFailureKind::None) {
                failureKind = video::EncodeFailureKind::Timeout;
            }

            if (encoded) {
                std::lock_guard<std::mutex> packetLock(alphaPacketMutex_);
                latestAlphaPacket_ = std::move(alphaPacket);
                latestAlphaPacketReady_ = true;
                continue;
            }

            alphaEncodeFailures_.fetch_add(1, std::memory_order_relaxed);
            if (failureKind == video::EncodeFailureKind::Timeout ||
                failureKind == video::EncodeFailureKind::Backpressure) {
                alphaEncodeTimeouts_.fetch_add(1, std::memory_order_relaxed);
            }

            const int64_t warnNowMs = steadyNowMs();
            const int64_t lastWarnMs = lastAlphaWarningMs_.load(std::memory_order_relaxed);
            if (lastWarnMs == 0 || (warnNowMs - lastWarnMs) > 15000) {
                lastAlphaWarningMs_.store(warnNowMs, std::memory_order_relaxed);
                emitRuntimeEvent(
                    "VP9 alpha track encoder is overloaded. Transparency is being preserved, but alpha frames may be dropped; try 30 FPS, lower resolution, or chroma background mode.",
                    false);
            }
        }
        spdlog::info("[AlphaEncodeThread] Stopped");
    });
}

void VersusApp::stopAlphaEncodeThread() {
    alphaEncodeThreadRunning_.store(false, std::memory_order_release);
    alphaEncodeCV_.notify_all();
    if (alphaEncodeThread_.joinable()) {
        if (alphaEncodeThread_.get_id() == std::this_thread::get_id()) {
            alphaEncodeThread_.detach();
        } else {
            alphaEncodeThread_.join();
        }
    }
    clearAlphaEncodeQueues();
}

void VersusApp::clearAlphaEncodeQueues() {
    {
        std::lock_guard<std::mutex> lock(alphaEncodeMutex_);
        pendingAlphaEncodeJob_ = AlphaEncodeJob{};
        pendingAlphaEncodeJobReady_ = false;
        pendingAlphaEncoderConfig_ = video::EncoderConfig{};
        pendingAlphaEncoderReconfigure_ = false;
    }
    {
        std::lock_guard<std::mutex> lock(alphaPacketMutex_);
        latestAlphaPacket_ = video::EncodedPacket{};
        latestAlphaPacketReady_ = false;
    }
}

void VersusApp::queueAlphaEncodeFrame(int width,
                                      int height,
                                      int64_t timestamp,
                                      std::vector<uint8_t> gray) {
    if (!alphaEncodeThreadRunning_.load(std::memory_order_acquire) ||
        gray.empty() ||
        width <= 0 ||
        height <= 0) {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(alphaEncodeMutex_);
        if (pendingAlphaEncodeJobReady_) {
            alphaFramesDropped_.fetch_add(1, std::memory_order_relaxed);
        }
        pendingAlphaEncodeJob_.gray = std::move(gray);
        pendingAlphaEncodeJob_.width = width;
        pendingAlphaEncodeJob_.height = height;
        pendingAlphaEncodeJob_.timestamp = timestamp;
        pendingAlphaEncodeJobReady_ = true;
        alphaFramesQueued_.fetch_add(1, std::memory_order_relaxed);
    }
    alphaEncodeCV_.notify_one();
}

void VersusApp::queueAlphaEncoderReconfigure(video::EncoderConfig config) {
    if (!alphaEncodeThreadRunning_.load(std::memory_order_acquire)) {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(alphaEncodeMutex_);
        pendingAlphaEncoderConfig_ = std::move(config);
        pendingAlphaEncoderReconfigure_ = true;
    }
    alphaEncodeCV_.notify_one();
}

bool VersusApp::takeLatestAlphaPacket(video::EncodedPacket &packet) {
    std::lock_guard<std::mutex> lock(alphaPacketMutex_);
    if (!latestAlphaPacketReady_ || latestAlphaPacket_.data.empty()) {
        return false;
    }
    packet = std::move(latestAlphaPacket_);
    latestAlphaPacket_ = video::EncodedPacket{};
    latestAlphaPacketReady_ = false;
    return true;
}

void VersusApp::startEncodeThread() {
    if (encodeThreadRunning_.exchange(true)) {
        return;
    }

    startAlphaEncodeThread();

    encodeThread_ = std::thread([this]() {
        spdlog::info("[EncodeThread] Started");
        while (encodeThreadRunning_.load()) {
            {
                std::unique_lock<std::mutex> lock(encodeNotifyMutex_);
                encodeFrameCV_.wait_for(lock, std::chrono::milliseconds(50),
                    [this] { return encodeFrameReady_ || !encodeThreadRunning_.load(); });
                if (!encodeThreadRunning_.load()) {
                    break;
                }
                if (!encodeFrameReady_) {
                    continue;
                }
                encodeFrameReady_ = false;
            }

            if (!live_) {
                continue;
            }

            const bool trackActive = hasAnyActiveVideoTrack();
            const bool wasTrackActive = videoTrackActive_.exchange(trackActive);
            if (!trackActive) {
                continue;
            }

            if (!wasTrackActive) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                spdlog::info("[EncodeThread] Video track became active; forcing keyframe on next frame");
            }

            video::CapturedFrame frame;
            {
                std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
                frame = std::move(latestVideoFrame_);
                hasLatestVideoFrame_ = false;
            }

            if (frame.data.empty()) {
                continue;
            }

            if (!encodeAndSendVideoFrame(frame, false)) {
                static int sendFailCount = 0;
                if (++sendFailCount % 100 == 1) {
                    spdlog::warn("[EncodeThread] encodeAndSendVideoFrame failed (count={})", sendFailCount);
                }
            }
        }
        spdlog::info("[EncodeThread] Stopped");
    });
}

void VersusApp::stopEncodeThread() {
    encodeThreadRunning_.store(false);
    encodeFrameCV_.notify_one();
    if (encodeThread_.joinable()) {
        if (encodeThread_.get_id() == std::this_thread::get_id()) {
            encodeThread_.detach();
        } else {
            encodeThread_.join();
        }
    }
    stopAlphaEncodeThread();
}

bool VersusApp::hasAnyActiveVideoTrack() const {
    std::lock_guard<std::mutex> lock(peerSessionsMutex_);
    for (const auto &entry : peerSessions_) {
        if (!entry.second || !entry.second->client || !entry.second->client->hasActiveVideoTrack()) {
            continue;
        }
        const PeerRouteState route{
            entry.second->roomMode,
            roomModeLqEnabled_.load(std::memory_order_relaxed),
            entry.second->initReceived.load(std::memory_order_relaxed),
            entry.second->roleValid.load(std::memory_order_relaxed),
            entry.second->role.load(std::memory_order_relaxed),
            entry.second->videoEnabled.load(std::memory_order_relaxed),
            entry.second->audioEnabled.load(std::memory_order_relaxed)};
        if (entry.second->requestedVideoBitrateKbps.load(std::memory_order_relaxed) != 0 &&
            canSendVideo(route)) {
            return true;
        }
    }
    return false;
}

bool VersusApp::hasAnyActiveAudioTrack() const {
    std::lock_guard<std::mutex> lock(peerSessionsMutex_);
    for (const auto &entry : peerSessions_) {
        if (!entry.second || !entry.second->client || !entry.second->client->hasActiveAudioTrack()) {
            continue;
        }
        const PeerRouteState route{
            entry.second->roomMode,
            roomModeLqEnabled_.load(std::memory_order_relaxed),
            entry.second->initReceived.load(std::memory_order_relaxed),
            entry.second->roleValid.load(std::memory_order_relaxed),
            entry.second->role.load(std::memory_order_relaxed),
            entry.second->videoEnabled.load(std::memory_order_relaxed),
            entry.second->audioEnabled.load(std::memory_order_relaxed)};
        if (entry.second->requestedAudioBitrateKbps.load(std::memory_order_relaxed) != 0 &&
            canSendAudio(route)) {
            return true;
        }
    }
    return false;
}

VersusApp::PeerCounts VersusApp::collectPeerCounts() const {
    PeerCounts counts;
    const bool alphaWorkflowEnabled = usesVp9AlphaTrack(videoStateSnapshot().config);
    std::lock_guard<std::mutex> lock(peerSessionsMutex_);
    counts.total = static_cast<int>(peerSessions_.size());
    for (const auto &entry : peerSessions_) {
        if (!entry.second || !entry.second->client) {
            continue;
        }
        const PeerRouteState route{
            entry.second->roomMode,
            roomModeLqEnabled_.load(std::memory_order_relaxed),
            entry.second->initReceived.load(std::memory_order_relaxed),
            entry.second->roleValid.load(std::memory_order_relaxed),
            entry.second->role.load(std::memory_order_relaxed),
            entry.second->videoEnabled.load(std::memory_order_relaxed),
            entry.second->audioEnabled.load(std::memory_order_relaxed)};

        if (route.roomMode && route.initReceived && route.roleValid) {
            if (route.role == PeerRole::Guest) {
                counts.roomGuests++;
            } else if (route.role == PeerRole::Scene) {
                counts.roomScenes++;
            } else {
                counts.roomNonGuestViewers++;
            }
        }

        if (entry.second->client->hasActiveVideoTrack() &&
            entry.second->requestedVideoBitrateKbps.load(std::memory_order_relaxed) != 0 &&
            canSendVideo(route)) {
            counts.activeVideo++;
            const StreamTier policyTier = assignStreamTier(
                route.roomMode,
                route.roomModeLqEnabled,
                route.roleValid,
                route.role);
            StreamTier tier = policyTier;
            if (alphaWorkflowEnabled && entry.second->alphaAllowed.load(std::memory_order_relaxed)) {
                tier = StreamTier::HQ;
            } else {
                const int requestedVideoBitrate =
                    entry.second->requestedVideoBitrateKbps.load(std::memory_order_relaxed);
                if (requestedVideoBitrate > 0 && requestedVideoBitrate <= kLqBitrateKbps) {
                    tier = StreamTier::LQ;
                }
            }
            if (tier == StreamTier::HQ) {
                counts.hq++;
            } else if (tier == StreamTier::LQ) {
                counts.lq++;
            }
        }
        if (entry.second->client->hasActiveAudioTrack() &&
            entry.second->requestedAudioBitrateKbps.load(std::memory_order_relaxed) != 0 &&
            canSendAudio(route)) {
            counts.activeAudio++;
        }
    }
    return counts;
}

VersusApp::VideoStateSnapshot VersusApp::buildVideoStateSnapshotLocked() const {
    VideoStateSnapshot snapshot;
    snapshot.config = videoConfig_;
    snapshot.hqWidth = activeHqWidth_ > 0 ? activeHqWidth_ : std::max(2, videoConfig_.width & ~1);
    snapshot.hqHeight = activeHqHeight_ > 0 ? activeHqHeight_ : std::max(2, videoConfig_.height & ~1);
    snapshot.encoderName = videoEncoder_.activeEncoderName();
    snapshot.codecName = videoEncoder_.activeCodecName();
    snapshot.encoderInputFormat = videoEncoder_.activeInputFormatName();
    snapshot.hardwareEncoder = videoEncoder_.isHardwareEncoderActive();
    snapshot.lqEncoderInitialized = lqEncoderInitialized_.load(std::memory_order_relaxed);
    if (snapshot.lqEncoderInitialized) {
        snapshot.lqEncoderName = videoEncoderLq_.activeEncoderName();
    }
    return snapshot;
}

void VersusApp::publishVideoStateSnapshotLocked() const {
    const VideoStateSnapshot snapshot = buildVideoStateSnapshotLocked();
    std::lock_guard<std::mutex> snapshotLock(videoStateSnapshotMutex_);
    cachedVideoStateSnapshot_ = snapshot;
}

VersusApp::VideoStateSnapshot VersusApp::videoStateSnapshot() const {
    std::unique_lock<std::mutex> lock(videoSendMutex_, std::try_to_lock);
    if (lock.owns_lock()) {
        const VideoStateSnapshot snapshot = buildVideoStateSnapshotLocked();
        {
            std::lock_guard<std::mutex> snapshotLock(videoStateSnapshotMutex_);
            cachedVideoStateSnapshot_ = snapshot;
        }
        return snapshot;
    }

    std::lock_guard<std::mutex> snapshotLock(videoStateSnapshotMutex_);
    return cachedVideoStateSnapshot_;
}

void VersusApp::sendAudioPacketToPeers(const versus::webrtc::EncodedAudioPacket &packet) {
    std::vector<std::shared_ptr<PeerSession>> peers;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peers.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (!entry.second || !entry.second->client || !entry.second->client->hasActiveAudioTrack()) {
                continue;
            }
            const PeerRouteState route{
                entry.second->roomMode,
                roomModeLqEnabled_.load(std::memory_order_relaxed),
                entry.second->initReceived.load(std::memory_order_relaxed),
                entry.second->roleValid.load(std::memory_order_relaxed),
                entry.second->role.load(std::memory_order_relaxed),
                entry.second->videoEnabled.load(std::memory_order_relaxed),
                entry.second->audioEnabled.load(std::memory_order_relaxed)};
            if (!canSendAudio(route)) {
                continue;
            }
            if (entry.second->requestedAudioBitrateKbps.load(std::memory_order_relaxed) == 0) {
                continue;
            }
            peers.push_back(entry.second);
        }
    }

    uint64_t bytesSent = 0;
    int packetsSent = 0;
    for (const auto &peer : peers) {
        if (!peer || !peer->client) {
            continue;
        }
        if (peer->client->sendAudio(packet)) {
            bytesSent += packet.data.size();
            packetsSent++;
        } else {
            audioSendFailures_.fetch_add(1, std::memory_order_relaxed);
        }
    }
    if (bytesSent > 0) {
        audioBytesSent_.fetch_add(bytesSent, std::memory_order_relaxed);
        audioPacketsSent_.fetch_add(static_cast<uint64_t>(packetsSent), std::memory_order_relaxed);
    }
}

bool VersusApp::tryHandlePeerSignalMessage(const std::shared_ptr<PeerSession> &peer, const std::string &message) {
    if (!peer || !peer->client || message.empty()) {
        return false;
    }

    signaling::ParsedSignalMessage parsed;
    if (!signaling_.tryParseSignalPayload(message, parsed)) {
        return false;
    }

    bool handled = false;
    if (parsed.hasOffer) {
        spdlog::warn("[App] Ignoring unexpected datachannel offer {}:{}",
                     peer->uuid,
                     peer->session);
        handled = true;
    }

    if (parsed.hasAnswer) {
        const std::string answerUuid = parsed.answer.uuid.empty() ? peer->uuid : parsed.answer.uuid;
        const std::string answerSession = parsed.answer.session.empty() ? peer->session : parsed.answer.session;
        const bool sameSession = !parsed.answer.session.empty() && answerSession == peer->session;
        const bool sameUuid = answerUuid == peer->uuid;
        const bool channelScoped = parsed.answer.session.empty() && parsed.answer.uuid.empty();
        if ((sameUuid && answerSession == peer->session) || sameSession || channelScoped) {
            if (!sameUuid && sameSession) {
                spdlog::info("[App] Accepting datachannel answer by session match {}:{} payloadUuid={}",
                             peer->uuid,
                             peer->session,
                             parsed.answer.uuid);
            }
            applyPeerAnswer(peer, parsed.answer.sdp, "datachannel");
        } else {
            spdlog::warn("[App] Ignoring datachannel answer for mismatched peer uuid={} session={}",
                         parsed.answer.uuid,
                         parsed.answer.session);
        }
        handled = true;
    }

    for (const auto &candidate : parsed.candidates) {
        const std::string candidateUuid = candidate.uuid.empty() ? peer->uuid : candidate.uuid;
        const std::string candidateSession = candidate.session.empty() ? peer->session : candidate.session;
        const bool sameSession = !candidate.session.empty() && candidateSession == peer->session;
        const bool sameUuid = candidateUuid == peer->uuid;
        const bool channelScoped = candidate.session.empty() && candidate.uuid.empty();
        if (!((sameUuid && candidateSession == peer->session) || sameSession || channelScoped)) {
            spdlog::warn("[App] Ignoring datachannel candidate for mismatched peer uuid={} session={}",
                         candidate.uuid,
                         candidate.session);
            handled = true;
            continue;
        }
        if (!sameUuid && sameSession) {
            spdlog::info("[App] Accepting datachannel candidate by session match {}:{} payloadUuid={}",
                         peer->uuid,
                         peer->session,
                         candidate.uuid);
        }
        peer->client->addRemoteCandidate(candidate.candidate, candidate.mid, candidate.mlineIndex);
        peer->remoteCandidatesApplied.fetch_add(1, std::memory_order_relaxed);
        recordPeerEvent(peer, "remote-candidate-applied datachannel");
        handled = true;
    }

    return handled;
}

bool VersusApp::sendPeerOffer(const std::shared_ptr<PeerSession> &peer, const char *reason, bool rebuildPeerConnection) {
    if (!peer || !peer->client) {
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(makePeerKey(peer->uuid, peer->session));
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return false;
        }
        it->second->answerReceived = false;
        it->second->offerDispatched = false;
        it->second->pendingCandidates.clear();
        it->second->renegotiationQueued.store(false, std::memory_order_relaxed);
        it->second->candidateType = "local";
        it->second->offerCount.fetch_add(1, std::memory_order_relaxed);
        if (rebuildPeerConnection) {
            it->second->recoveryOfferCount.fetch_add(1, std::memory_order_relaxed);
        }
        {
            std::lock_guard<std::mutex> diagnosticsLock(it->second->diagnosticsMutex);
            it->second->lastOfferReason = reason ? reason : "unspecified";
        }
    }
    recordPeerEvent(peer, std::string("offer-start reason=") + (reason ? reason : "unspecified") +
                              (rebuildPeerConnection ? " rebuild=1" : " rebuild=0"));

    if (rebuildPeerConnection) {
        std::lock_guard<std::mutex> mediaPlanLock(peer->mediaPlanMutex);
        const bool wantVideo = peer->videoEnabled.load(std::memory_order_relaxed);
        const bool wantAudio = peer->audioEnabled.load(std::memory_order_relaxed);
        const VideoStateSnapshot videoState = videoStateSnapshot();
        const bool wantAlpha = wantVideo &&
            usesVp9AlphaTrack(videoState.config) &&
            peer->alphaAllowed.load(std::memory_order_relaxed);

        spdlog::info("[App] Rebuilding peer connection {}:{} reason={} media video={} audio={} alpha={}",
                     peer->uuid,
                     peer->session,
                     reason ? reason : "unspecified",
                     wantVideo,
                     wantAudio,
                     wantAlpha);
        if (!peer->client->resetPeerConnection(wantVideo, wantAudio, wantAlpha)) {
            spdlog::error("[WebRTC] Failed to rebuild peer connection for {}:{} during recovery offer",
                          peer->uuid,
                          peer->session);
            removePeerSession(peer, "recovery-peerconnection-rebuild-failed");
            return false;
        }
        peer->dataChannelOpen.store(false, std::memory_order_relaxed);
        if (wantVideo && !peer->client->hasConfiguredVideoTrack()) {
            spdlog::error("[WebRTC] Failed to restore video track for {}:{} during recovery offer",
                          peer->uuid,
                          peer->session);
            removePeerSession(peer, "recovery-video-track-failed");
            return false;
        }
        if (wantAudio && !peer->client->hasConfiguredAudioTrack()) {
            spdlog::error("[WebRTC] Failed to restore audio track for {}:{} during recovery offer",
                          peer->uuid,
                          peer->session);
            removePeerSession(peer, "recovery-audio-track-failed");
            return false;
        }
        if (wantVideo || wantAudio || wantAlpha) {
            peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        }
    }

    spdlog::info("[App] Sending offer {}:{} reason={} rebuildPeerConnection={}",
                 peer->uuid,
                 peer->session,
                 reason ? reason : "unspecified",
                 rebuildPeerConnection);

    const auto offerSdp = peer->client->createOffer();
    if (offerSdp.empty()) {
        spdlog::error("[WebRTC] Failed to create offer for {}:{} (reason={})",
                      peer->uuid,
                      peer->session,
                      reason ? reason : "unspecified");
        recordPeerEvent(peer, "offer-create-failed");
        removePeerSession(peer, "offer-create-failed");
        return false;
    }

    signaling::SignalOffer offer;
    offer.uuid = peer->uuid;
    offer.session = peer->session;
    offer.streamId = peer->streamId;
    offer.sdp = offerSdp;
    std::vector<PendingCandidate> bufferedCandidates;
    std::string candidateType = "local";
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        if (!signaling_.sendOffer(offer)) {
            spdlog::error("[Signaling] Failed to send offer for {}:{} (reason={})",
                          peer->uuid,
                          peer->session,
                          reason ? reason : "unspecified");
            recordPeerEvent(peer, "offer-send-failed");
            removePeerSession(peer, "offer-send-failed");
            return false;
        }
    }

    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(makePeerKey(peer->uuid, peer->session));
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return false;
        }
        it->second->offerDispatched = true;
        bufferedCandidates = it->second->pendingCandidates;
        it->second->pendingCandidates.clear();
        candidateType = it->second->candidateType;
    }

    for (const auto &pending : bufferedCandidates) {
        signaling::SignalCandidate cand;
        cand.uuid = peer->uuid;
        cand.candidate = pending.candidate;
        cand.mid = pending.mid;
        cand.mlineIndex = pending.mlineIndex;
        cand.session = peer->session;
        cand.type = candidateType;
        {
            std::lock_guard<std::mutex> lock(signalingOpsMutex_);
            signaling_.sendCandidate(cand);
        }
        peer->localCandidatesSent.fetch_add(1, std::memory_order_relaxed);
    }
    recordPeerEvent(peer, std::string("offer-sent reason=") + (reason ? reason : "unspecified"));
    return true;
}

int VersusApp::renegotiatePeersForH264CodecFallback(const char *reason) {
    std::vector<std::shared_ptr<PeerSession>> peersToRenegotiate;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peersToRenegotiate.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (entry.second && entry.second->client) {
                peersToRenegotiate.push_back(entry.second);
            }
        }
    }

    int sentOffers = 0;
    for (const auto &peer : peersToRenegotiate) {
        if (!peer || !peer->client) {
            continue;
        }
        peer->client->setVideoCodec(webrtc::PeerConfig::VideoCodec::H264, false);
        if (sendPeerOffer(peer, reason ? reason : "codec-fallback-h264", true)) {
            sentOffers++;
        }
    }
    if (sentOffers > 0) {
        spdlog::info("[App] Sent {} H.264 fallback renegotiation offer(s) reason={}",
                     sentOffers,
                     reason ? reason : "codec-fallback-h264");
    }
    return sentOffers;
}

bool VersusApp::fallbackToH264AfterRejectedVideoAnswer(const std::shared_ptr<PeerSession> &peer,
                                                       const char *source) {
    if (!peer || !peer->client) {
        return false;
    }
    if (peer->codecFallbackAttempted.exchange(true, std::memory_order_relaxed)) {
        spdlog::warn("[App] Remote answer rejected video for {}:{} source={} after codec fallback was already attempted",
                     peer->uuid,
                     peer->session,
                     source ? source : "unknown");
        return false;
    }

    video::VideoCodec previousCodec = video::VideoCodec::H264;
    std::string fallbackEncoderName;
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        previousCodec = videoConfig_.codec;
        if (previousCodec == video::VideoCodec::H264) {
            return false;
        }

        const video::EncoderConfig previousConfig = videoConfig_;
        video::EncoderConfig fallbackConfig = videoConfig_;
        fallbackConfig.codec = video::VideoCodec::H264;
        fallbackConfig.enableAlpha = false;
        fallbackConfig.forceFfmpegNvenc = false;

        videoEncoder_.shutdown();
        clearAlphaEncodeQueues();
        {
            std::lock_guard<std::mutex> alphaLock(alphaEncoderMutex_);
            videoEncoderAlpha_.shutdown();
        }
        clearAlphaEncodeQueues();
        shutdownLqEncoderLocked();
        if (!videoEncoder_.initialize(fallbackConfig)) {
            spdlog::error("[App] Remote rejected {} video but H.264 fallback initialization failed",
                          videoCodecName(previousCodec));
            if (videoEncoder_.initialize(primaryVideoEncoderConfig(previousConfig))) {
                videoConfig_ = previousConfig;
                activeHqWidth_ = std::max(2, previousConfig.width & ~1);
                activeHqHeight_ = std::max(2, previousConfig.height & ~1);
                publishVideoStateSnapshotLocked();
            } else {
                spdlog::error("[App] Failed to restore {} encoder after rejected-video fallback failure",
                              videoCodecName(previousCodec));
            }
            return false;
        }

        videoConfig_ = fallbackConfig;
        activeHqWidth_ = std::max(2, fallbackConfig.width & ~1);
        activeHqHeight_ = std::max(2, fallbackConfig.height & ~1);
        hqAspectLocked_ = false;
        softwareExternalEncodeFailCount_ = 0;
        softwareExternalFailWindowStartMs_ = 0;
        softwareOverloadSamples_.store(0, std::memory_order_relaxed);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        fallbackEncoderName = videoEncoder_.activeEncoderName();
        publishVideoStateSnapshotLocked();
    }

    emitRuntimeEvent(
        std::string("Viewer rejected ") + videoCodecName(previousCodec) +
            " video; switched to H.264 fallback.",
        false);
    spdlog::warn("[App] Remote answer rejected {} video for {}:{} source={}; switched to H.264 fallback ({})",
                 videoCodecName(previousCodec),
                 peer->uuid,
                 peer->session,
                 source ? source : "unknown",
                 fallbackEncoderName);

    std::vector<std::shared_ptr<PeerSession>> peersToRenegotiate;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peersToRenegotiate.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (entry.second && entry.second->client) {
                peersToRenegotiate.push_back(entry.second);
            }
        }
    }

    bool sentTriggerPeerOffer = false;
    for (const auto &session : peersToRenegotiate) {
        if (!session || !session->client) {
            continue;
        }
        session->client->setVideoCodec(webrtc::PeerConfig::VideoCodec::H264, false);
        const char *reason = session.get() == peer.get()
            ? "video-codec-fallback-h264"
            : "global-video-codec-fallback-h264";
        if (sendPeerOffer(session, reason, true) && session.get() == peer.get()) {
            sentTriggerPeerOffer = true;
        }
    }
    return sentTriggerPeerOffer;
}

void VersusApp::applyPeerAnswer(const std::shared_ptr<PeerSession> &peer, const std::string &sdp, const char *source) {
    if (!peer || !peer->client || sdp.empty()) {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(makePeerKey(peer->uuid, peer->session));
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return;
        }
    }

    spdlog::info("[App] Applying peer answer {}:{} source={}",
                 peer->uuid,
                 peer->session,
                 source ? source : "unknown");

    if (sdpAnswerRejectsVideoMLine(sdp) &&
        videoStateSnapshot().config.codec != video::VideoCodec::H264 &&
        fallbackToH264AfterRejectedVideoAnswer(peer, source)) {
        return;
    }

    if (!peer->client->setRemoteDescription(sdp, "answer")) {
        spdlog::warn("[App] Failed to apply peer answer {}:{} source={}",
                     peer->uuid,
                     peer->session,
                     source ? source : "unknown");
        recordPeerEvent(peer, std::string("answer-apply-failed source=") + (source ? source : "unknown"));
        return;
    }

    std::vector<PendingCandidate> buffered;
    std::string candidateType = "local";
    bool queuedRenegotiation = false;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(makePeerKey(peer->uuid, peer->session));
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return;
        }
        it->second->answerReceived = true;
        it->second->answerCount.fetch_add(1, std::memory_order_relaxed);
        {
            std::lock_guard<std::mutex> diagnosticsLock(it->second->diagnosticsMutex);
            it->second->lastAnswerSource = source ? source : "unknown";
        }
        buffered = it->second->pendingCandidates;
        it->second->pendingCandidates.clear();
        candidateType = it->second->candidateType;
        queuedRenegotiation = it->second->renegotiationQueued.exchange(false, std::memory_order_relaxed);
    }
    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
    drainPendingRemoteCandidates(peer, source ? source : "answer-applied");

    for (const auto &pending : buffered) {
        signaling::SignalCandidate cand;
        cand.uuid = peer->uuid;
        cand.candidate = pending.candidate;
        cand.mid = pending.mid;
        cand.mlineIndex = pending.mlineIndex;
        cand.session = peer->session;
        cand.type = candidateType;
        {
            std::lock_guard<std::mutex> lock(signalingOpsMutex_);
            signaling_.sendCandidate(cand);
        }
        peer->localCandidatesSent.fetch_add(1, std::memory_order_relaxed);
    }
    recordPeerEvent(peer, std::string("answer-applied source=") + (source ? source : "unknown"));

    if (queuedRenegotiation) {
        applyPeerMediaPlan(peer, "queued-media-plan");
    }
}

void VersusApp::applyPeerMediaPlan(const std::shared_ptr<PeerSession> &peer, const char *reason) {
    if (!peer || !peer->client) {
        return;
    }
    std::lock_guard<std::mutex> mediaPlanLock(peer->mediaPlanMutex);
    const bool dataChannelOpen =
        peer->dataChannelOpen.load(std::memory_order_relaxed) ||
        peer->client->isDataChannelOpen();
    if (!dataChannelOpen) {
        return;
    }
    peer->dataChannelOpen.store(true, std::memory_order_relaxed);

    const bool initReceived = peer->initReceived.load(std::memory_order_relaxed);
    const bool wantVideo = initReceived && peer->videoEnabled.load(std::memory_order_relaxed);
    const bool wantAudio = initReceived && peer->audioEnabled.load(std::memory_order_relaxed);
    const VideoStateSnapshot videoState = videoStateSnapshot();
    const bool wantAlpha = wantVideo &&
        usesVp9AlphaTrack(videoState.config) &&
        peer->alphaAllowed.load(std::memory_order_relaxed);

    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(makePeerKey(peer->uuid, peer->session));
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return;
        }
        if (!it->second->answerReceived) {
            it->second->renegotiationQueued.store(true, std::memory_order_relaxed);
            spdlog::info("[App] Queued media-plan renegotiation {}:{} reason={}",
                         peer->uuid,
                         peer->session,
                         reason ? reason : "unspecified");
            return;
        }
    }

    const auto change = peer->client->ensureMediaTracks(wantVideo, wantAudio, wantAlpha);
    if (!change.changed) {
        return;
    }

    if (change.videoAdded) {
        peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
    }

    if (!sendPeerOffer(peer, reason)) {
        return;
    }
}

std::string VersusApp::makePeerKey(const std::string &uuid, const std::string &session) const {
    return uuid + "|" + session;
}

std::shared_ptr<VersusApp::PeerSession> VersusApp::findPeerSessionForSignalLocked(const std::string &uuid,
                                                                                   const std::string &session) const {
    if (uuid.empty()) {
        return nullptr;
    }

    if (!session.empty()) {
        const auto it = peerSessions_.find(makePeerKey(uuid, session));
        if (it != peerSessions_.end()) {
            return it->second;
        }
        return nullptr;
    }

    std::shared_ptr<PeerSession> matchedPeer;
    for (const auto &entry : peerSessions_) {
        if (!entry.second || entry.second->uuid != uuid) {
            continue;
        }
        if (matchedPeer) {
            spdlog::warn("[Signaling] Ambiguous peer lookup for uuid={} with empty session; ignoring message", uuid);
            return nullptr;
        }
        matchedPeer = entry.second;
    }

    return matchedPeer;
}

void VersusApp::queuePendingRemoteCandidateLocked(const signaling::SignalCandidate &cand, int64_t nowMs) {
    if (cand.uuid.empty() || cand.candidate.empty()) {
        spdlog::debug("[Signaling] Ignoring candidate without queueable peer identity uuid={} session={}",
                      cand.uuid,
                      cand.session);
        return;
    }

    auto &queue = pendingRemoteCandidates_[makePeerKey(cand.uuid, cand.session)];

    std::size_t expiredCount = 0;
    while (!queue.empty() && nowMs - queue.front().queuedAtMs > kPendingRemoteCandidateTtlMs) {
        queue.erase(queue.begin());
        ++expiredCount;
    }
    if (expiredCount > 0) {
        spdlog::warn("[Signaling] Dropped {} stale queued remote ICE candidates uuid={} session={}",
                     expiredCount,
                     cand.uuid,
                     cand.session);
    }

    if (queue.size() >= kPendingRemoteCandidatesMaxPerPeer) {
        queue.erase(queue.begin());
        spdlog::warn("[Signaling] Pending remote ICE queue full; dropping oldest candidate uuid={} session={}",
                     cand.uuid,
                     cand.session);
    }

    queue.push_back({
        cand.uuid,
        cand.session,
        cand.candidate,
        cand.mid,
        cand.mlineIndex,
        nowMs,
    });
    spdlog::info("[Signaling] Queued remote ICE candidate before peer session ready uuid={} session={} queued={}",
                 cand.uuid,
                 cand.session,
                 queue.size());
}

std::vector<VersusApp::PendingRemoteCandidate> VersusApp::takePendingRemoteCandidatesLocked(
    const std::string &uuid,
    const std::string &session,
    int64_t nowMs) {
    std::vector<PendingRemoteCandidate> drained;
    if (uuid.empty()) {
        return drained;
    }

    int matchingPeerCount = 0;
    for (const auto &entry : peerSessions_) {
        if (entry.second && entry.second->uuid == uuid) {
            ++matchingPeerCount;
        }
    }

    auto drainKey = [&](const std::string &key) {
        const auto it = pendingRemoteCandidates_.find(key);
        if (it == pendingRemoteCandidates_.end()) {
            return;
        }

        std::size_t expiredCount = 0;
        for (const auto &pending : it->second) {
            if (nowMs - pending.queuedAtMs > kPendingRemoteCandidateTtlMs) {
                ++expiredCount;
                continue;
            }
            drained.push_back(pending);
        }
        if (expiredCount > 0) {
            spdlog::warn("[Signaling] Dropped {} stale queued remote ICE candidates for key={}",
                         expiredCount,
                         key);
        }
        pendingRemoteCandidates_.erase(it);
    };

    const std::string exactKey = makePeerKey(uuid, session);
    drainKey(exactKey);

    const std::string emptySessionKey = makePeerKey(uuid, "");
    if (session.empty() || emptySessionKey == exactKey) {
        return drained;
    }

    if (matchingPeerCount == 1) {
        drainKey(emptySessionKey);
    } else if (pendingRemoteCandidates_.find(emptySessionKey) != pendingRemoteCandidates_.end()) {
        spdlog::warn("[Signaling] Keeping queued empty-session ICE candidates for ambiguous uuid={} peerCount={}",
                     uuid,
                     matchingPeerCount);
    }

    return drained;
}

void VersusApp::drainPendingRemoteCandidates(const std::shared_ptr<PeerSession> &peer, const char *reason) {
    if (!peer || !peer->client) {
        return;
    }

    std::vector<PendingRemoteCandidate> pendingCandidates;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(makePeerKey(peer->uuid, peer->session));
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return;
        }
        pendingCandidates = takePendingRemoteCandidatesLocked(peer->uuid, peer->session, steadyNowMs());
    }

    if (pendingCandidates.empty()) {
        return;
    }

    spdlog::info("[Signaling] Draining {} queued remote ICE candidates for {}:{} reason={}",
                 pendingCandidates.size(),
                 peer->uuid,
                 peer->session,
                 reason ? reason : "unspecified");
    for (const auto &pending : pendingCandidates) {
        peer->client->addRemoteCandidate(pending.candidate, pending.mid, pending.mlineIndex);
    }
    peer->remoteCandidatesApplied.fetch_add(static_cast<int>(pendingCandidates.size()), std::memory_order_relaxed);
    recordPeerEvent(peer, "remote-candidates-drained count=" + std::to_string(pendingCandidates.size()));
}

void VersusApp::removePeerSession(const std::shared_ptr<PeerSession> &peer, const char *reason) {
    if (!peer) {
        return;
    }

    std::shared_ptr<PeerSession> removedPeer;
    bool hasRemainingPeers = true;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(makePeerKey(peer->uuid, peer->session));
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return;
        }
        removedPeer = it->second;
        {
            std::lock_guard<std::mutex> diagnosticsLock(removedPeer->diagnosticsMutex);
            removedPeer->lastRemovalReason = reason ? reason : "unspecified";
        }
        {
            std::lock_guard<std::mutex> healthLock(healthStateMutex_);
            lastPeerDisconnectReason_ = reason ? reason : "unspecified";
        }
        peerSessions_.erase(it);
        pendingRemoteCandidates_.erase(makePeerKey(peer->uuid, peer->session));
        const bool hasOtherSameUuid = std::any_of(
            peerSessions_.begin(),
            peerSessions_.end(),
            [&](const auto &entry) {
                return entry.second && entry.second->uuid == peer->uuid;
            });
        if (!hasOtherSameUuid) {
            pendingRemoteCandidates_.erase(makePeerKey(peer->uuid, ""));
        }
        hasRemainingPeers = !peerSessions_.empty();
    }

    spdlog::info("[App] Removed peer session {}:{} reason={} remainingPeers={}",
                 removedPeer->uuid,
                 removedPeer->session,
                 reason ? reason : "unspecified",
                 hasRemainingPeers ? "yes" : "no");
    recordPeerEvent(removedPeer, std::string("session-removed reason=") + (reason ? reason : "unspecified"));
    shutdownPeerClientAsync(removedPeer);
    if (!hasRemainingPeers) {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        shutdownLqEncoderLocked();
    }
}

void VersusApp::shutdownPeerClientAsync(const std::shared_ptr<PeerSession> &peer) {
    if (!peer || !peer->client) {
        return;
    }

    reapCompletedPeerShutdowns();
    peer->client->prepareForShutdown();
    auto shutdownFuture = std::async(std::launch::async, [peer]() {
        try {
            if (peer->client) {
                peer->client->shutdown();
            }
        } catch (const std::exception &e) {
            spdlog::warn("[WebRTC] Peer shutdown threw exception: {}", e.what());
        } catch (...) {
            spdlog::warn("[WebRTC] Peer shutdown threw unknown exception");
        }
    });
    std::lock_guard<std::mutex> lock(peerShutdownTasksMutex_);
    peerShutdownFutures_.push_back(std::move(shutdownFuture));
}

void VersusApp::reapCompletedPeerShutdowns() {
    std::lock_guard<std::mutex> lock(peerShutdownTasksMutex_);
    auto it = peerShutdownFutures_.begin();
    while (it != peerShutdownFutures_.end()) {
        if (!it->valid()) {
            it = peerShutdownFutures_.erase(it);
            continue;
        }
        if (it->wait_for(std::chrono::milliseconds(0)) != std::future_status::ready) {
            ++it;
            continue;
        }
        it->wait();
        it = peerShutdownFutures_.erase(it);
    }
}

void VersusApp::waitForPendingPeerShutdowns() {
    for (;;) {
        std::vector<std::future<void>> pending;
        {
            std::lock_guard<std::mutex> lock(peerShutdownTasksMutex_);
            if (peerShutdownFutures_.empty()) {
                return;
            }
            pending.swap(peerShutdownFutures_);
        }

        for (auto &future : pending) {
            if (future.valid()) {
                future.wait();
            }
        }
    }
}

void VersusApp::clearPeerSessions() {
    std::vector<std::shared_ptr<PeerSession>> peers;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peers.reserve(peerSessions_.size());
        for (auto &entry : peerSessions_) {
            if (entry.second) {
                peers.push_back(entry.second);
            }
        }
        peerSessions_.clear();
        pendingRemoteCandidates_.clear();
    }

    for (const auto &peer : peers) {
        shutdownPeerClientAsync(peer);
    }
    std::lock_guard<std::mutex> lock(videoSendMutex_);
    shutdownLqEncoderLocked();
}

}  // namespace versus::app
