#include "versus/app/versus_app.h"
#include "versus/app/video_control_snapshot.h"
#include "versus/app/encoder_recovery_policy.h"
#include "versus/app/frame_trace.h"
#include "versus/app/keyframe_request_policy.h"
#include "versus/app/remote_control_policy.h"

#include "versus/audio/audio_format_converter.h"
#include "versus/video/aspect_fit.h"

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>
#include <QtCore/QCryptographicHash>
#include <QtCore/QSaveFile>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstddef>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <limits>
#include <optional>
#include <sstream>
#include <thread>
#include <utility>

#ifdef _WIN32
#include <windows.h>
#endif

namespace versus::app {

namespace detail {

std::string sha256Hex(const std::string &value) {
    return QCryptographicHash::hash(
               QByteArray::fromStdString(value),
               QCryptographicHash::Sha256)
        .toHex()
        .toStdString();
}

}  // namespace detail

namespace {

#ifndef APP_VERSION
#define APP_VERSION "dev"
#endif

constexpr int64_t kPeriodicKeyframeMs = 2500;
constexpr int64_t kDataInfoIntervalMs = 2000;
constexpr int64_t kPrimaryAudioActiveWindowMs = 250;
constexpr int64_t kRoomInitGracePeriodMs = 1500;
constexpr int64_t kDirectInitGracePeriodMs = 1000;
constexpr int64_t kDisconnectedPeerPruneMs = 90000;
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

struct PeerCallbackSchedule {
    GenerationTaggedPeerOperationExecutor::Priority priority =
        GenerationTaggedPeerOperationExecutor::Priority::Ordinary;
    GenerationTaggedPeerOperationExecutor::Criticality criticality =
        GenerationTaggedPeerOperationExecutor::Criticality::State;
    std::string coalesceKey;
};

PeerCallbackSchedule schedulePeerDataMessage(const std::string &message) {
    using Priority = GenerationTaggedPeerOperationExecutor::Priority;
    using Criticality = GenerationTaggedPeerOperationExecutor::Criticality;
    const auto msg = nlohmann::json::parse(message, nullptr, false);
    if (msg.is_discarded() || !msg.is_object()) {
        return {};
    }
    if (msg.contains("hangup")) {
        return {Priority::Critical, Criticality::Convergent, "remote-hangup"};
    }
    bool cleanupRequested = false;
    if (msg.contains("request") && msg["request"].is_string()) {
        std::string request = msg["request"].get<std::string>();
        std::transform(
            request.begin(),
            request.end(),
            request.begin(),
            [](unsigned char ch) {
                return static_cast<char>(std::tolower(ch));
            });
        cleanupRequested = request == "cleanup";
    }
    if (msg.contains("bye") || cleanupRequested) {
        return {Priority::Critical, Criticality::Convergent, "peer-cleanup"};
    }
    if (msg.contains("iceRestartRequest")) {
        return {Priority::Critical, Criticality::Convergent, "ice-restart"};
    }
    if (msg.contains("refreshAll")) {
        return {Priority::Critical, Criticality::Convergent, "refresh-all"};
    }
    if (msg.contains("refreshConnection")) {
        return {Priority::Critical, Criticality::Convergent, "refresh-connection"};
    }
    if (msg.contains("description")) {
        // Only the newest queued answer/offer description for one peer can
        // describe the recoverable transport state. Trickle candidates remain
        // ordinary, bounded per peer, and ordered within that peer's queue.
        return {Priority::Critical, Criticality::Replaceable, "signal-description"};
    }
    return {Priority::Ordinary, Criticality::State, videoControlSnapshotKey(msg)};
}

const char *peerOperationEnqueueResultName(
    GenerationTaggedPeerOperationExecutor::EnqueueResult result) {
    using Result = GenerationTaggedPeerOperationExecutor::EnqueueResult;
    switch (result) {
        case Result::Queued:
            return "queued";
        case Result::CoalescedCritical:
            return "coalesced-critical";
        case Result::CoalescedOrdinary:
            return "coalesced-ordinary";
        case Result::QueuedAfterEvictingOrdinary:
            return "queued-after-ordinary-eviction";
        case Result::QueuedAfterEvictingCritical:
            return "queued-after-critical-eviction";
        case Result::RejectedInvalid:
            return "rejected-invalid";
        case Result::RejectedStopped:
            return "rejected-stopped";
        case Result::RejectedOrdinaryCapacity:
            return "rejected-ordinary-capacity";
        case Result::RejectedCriticalCapacity:
            return "rejected-critical-capacity";
    }
    return "unknown";
}

void advanceMonotonic(std::atomic<int64_t> &target, int64_t value) {
    int64_t current = target.load(std::memory_order_relaxed);
    while (value > current &&
           !target.compare_exchange_weak(
               current,
               value,
               std::memory_order_relaxed,
               std::memory_order_relaxed)) {
    }
}

void advanceMonotonic(std::atomic<uint64_t> &target, uint64_t value) {
    uint64_t current = target.load(std::memory_order_relaxed);
    while (value > current &&
           !target.compare_exchange_weak(
               current,
               value,
               std::memory_order_relaxed,
               std::memory_order_relaxed)) {
    }
}

std::string generatePeerSessionId() {
    static std::atomic<uint64_t> sequence{0};
    return "gc-" + std::to_string(steadyNowMs()) + "-" +
        std::to_string(sequence.fetch_add(1, std::memory_order_relaxed) + 1);
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

bool compositeAlphaBackground(video::CapturedFrame &frame,
                              const video::EncoderConfig &config) {
    if (config.alphaBackgroundMode == video::AlphaBackgroundMode::None ||
        config.enableAlpha ||
        frame.format != video::CapturedFrame::Format::BGRA ||
        frame.width <= 0 ||
        frame.height <= 0 ||
        frame.stride < frame.width * 4 ||
        frame.data.size() < static_cast<size_t>(frame.stride) * static_cast<size_t>(frame.height)) {
        return false;
    }

    const int bgR = std::clamp<int>(config.alphaBackgroundRed, 0, 255);
    const int bgG = std::clamp<int>(config.alphaBackgroundGreen, 0, 255);
    const int bgB = std::clamp<int>(config.alphaBackgroundBlue, 0, 255);

    for (int y = 0; y < frame.height; ++y) {
        uint8_t *row = frame.data.data() + static_cast<size_t>(y) * static_cast<size_t>(frame.stride);
        for (int x = 0; x < frame.width; ++x) {
            uint8_t *pixel = row + static_cast<size_t>(x) * 4;
            const int a = pixel[3];
            if (a <= 0) {
                pixel[0] = static_cast<uint8_t>(bgB);
                pixel[1] = static_cast<uint8_t>(bgG);
                pixel[2] = static_cast<uint8_t>(bgR);
            } else if (a < 255) {
                const int invA = 255 - a;
                pixel[0] = static_cast<uint8_t>((static_cast<int>(pixel[0]) * a + bgB * invA + 127) / 255);
                pixel[1] = static_cast<uint8_t>((static_cast<int>(pixel[1]) * a + bgG * invA + 127) / 255);
                pixel[2] = static_cast<uint8_t>((static_cast<int>(pixel[2]) * a + bgR * invA + 127) / 255);
            }
            pixel[3] = 255;
        }
    }
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

GenerationTaggedPeerOperationExecutor::Criticality connectionStateCriticality(
    webrtc::ConnectionState state) {
    using Criticality = GenerationTaggedPeerOperationExecutor::Criticality;
    switch (state) {
        case webrtc::ConnectionState::Disconnected:
        case webrtc::ConnectionState::Failed:
        case webrtc::ConnectionState::Closed:
            // These states drive retention, transport retirement, and recovery.
            return Criticality::Convergent;
        case webrtc::ConnectionState::Connecting:
        case webrtc::ConnectionState::Connected:
        default:
            return Criticality::State;
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
        case VideoSourceMode::Camera:
            return "camera";
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
        config.requireEveryFrameKeyframe = config.codec == video::VideoCodec::VP9;
        config.enableAlpha = false;
    }
    return config;
}

video::EncoderConfig alphaVideoEncoderConfig(video::EncoderConfig config) {
    const auto [alphaWidth, alphaHeight] = alphaTrackDimensions(config, config.width, config.height);
    config.codec = video::VideoCodec::VP9;
    config.enableAlpha = true;
    config.requireEveryFrameKeyframe = true;
    config.width = alphaWidth;
    config.height = alphaHeight;
    config.bitrate = std::max(500, config.bitrate / 4);
    config.minBitrate = std::max(250, config.bitrate / 2);
    config.maxBitrate = std::max(config.bitrate + 1000, (config.bitrate * 3) / 2);
    config.preferredHardware = video::HardwareEncoder::None;
    return config;
}

}  // namespace

VersusApp::VersusApp(std::size_t peerOperationMaxQueued)
    : peerOperationExecutor_(peerOperationMaxQueued) {}
VersusApp::~VersusApp() { shutdown(); }

bool VersusApp::initialize() {
    if (!peerOperationExecutor_.start()) {
        return false;
    }
    if (!startDuplicateOfferRecheckScheduler()) {
        peerOperationExecutor_.stop();
        return false;
    }
    setupCallbacks();
    return true;
}

void VersusApp::shutdown() {
    stopDuplicateOfferRecheckScheduler();
    stopLive();
    stopCapture();
    waitForPendingPeerShutdowns();
    peerOperationExecutor_.stop();
}

std::vector<versus::video::WindowInfo> VersusApp::listWindows() {
    return windowCapture_.getWindows();
}

std::vector<versus::video::WindowInfo> VersusApp::listSpoutSenders() {
    return spoutCapture_.getSenders();
}

std::vector<versus::video::WindowInfo> VersusApp::listCameras() {
    return cameraCapture_.getCameras();
}

std::vector<versus::audio::AudioDeviceInfo> VersusApp::listAudioInputDevices() {
    return audioCapture_.GetInputDevices();
}

std::string VersusApp::lastCaptureError() const {
    {
        std::lock_guard<std::mutex> lock(captureErrorMutex_);
        if (!lastCaptureError_.empty()) {
            return lastCaptureError_;
        }
    }
    if (lifecycleStateSnapshot().videoSourceMode == VideoSourceMode::Camera) {
        return cameraCapture_.lastError();
    }
    return {};
}

bool VersusApp::startCapture(const std::string &windowId) {
    return startCapture(lifecycleStateSnapshot().videoSourceMode, windowId);
}

bool VersusApp::startCapture(VideoSourceMode mode, const std::string &sourceId) {
    // A previous startup can fail after one of the capture backends has
    // already opened but before capturing_ becomes true. Always begin from a
    // fully stopped state, then arm a rollback for every early return below.
    stopCapture();
    {
        std::lock_guard<std::mutex> lock(captureErrorMutex_);
        lastCaptureError_.clear();
    }
    struct StartupRollback {
        VersusApp *app = nullptr;
        bool armed = true;
        ~StartupRollback() {
            if (armed && app) {
                app->stopCapture();
            }
        }
    } startupRollback{this};

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
    alphaContractRecovery_.reset();
    lastAlphaContractDiagnosticMs_.store(0, std::memory_order_relaxed);
    audioSendFailures_.store(0, std::memory_order_relaxed);
    const int64_t metricsStartMs = steadyNowMs();
    metricsStartMs_.store(metricsStartMs, std::memory_order_relaxed);
    resetMetricsWindow(metricsStartMs);
    lastSentWidth_.store(0, std::memory_order_relaxed);
    lastSentHeight_.store(0, std::memory_order_relaxed);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(false);
    captureBackendFailureNotified_.store(false, std::memory_order_relaxed);
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
        pendingVideoFrame_.reset();
        cachedVideoFrame_.reset();
    }
    const auto frameCallback = [this](video::CapturedFrame frame) {
        handleVideoFrame(std::move(frame));
    };
    windowCapture_.setFrameCallback(frameCallback);
    windowCapture_.setFrameAdmissionCallback([this]() {
        // Capture is rate-limited before readback and handleVideoFrame replaces
        // a single pending image. Keep the latest image even while encoding;
        // rejecting it based on output-thread phase lowers motion cadence.
        return !live_.load(std::memory_order_acquire) ||
            encodeThreadRunning_.load(std::memory_order_acquire);
    });
    spoutCapture_.setFrameCallback(frameCallback);
    cameraCapture_.setFrameCallback(frameCallback);
    {
        std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
        selectedWindowId_ = sourceId;
        videoSourceMode_ = mode;
    }
    resetSourceHealth(mode, sourceId);
    uint32_t selectedWindowProcessId = 0;
    if (mode == VideoSourceMode::Window && !sourceId.empty()) {
        video::EncoderConfig captureConfig;
        {
            std::lock_guard<std::mutex> lock(videoSendMutex_);
            captureConfig = videoConfig_;
        }
        if (!windowCapture_.startCapture(
                sourceId,
                captureConfig.width > 0 ? captureConfig.width : 1920,
                captureConfig.height > 0 ? captureConfig.height : 1080,
                captureConfig.frameRate > 0 ? captureConfig.frameRate : 60,
                captureConfig.enableAlpha ||
                    captureConfig.alphaBackgroundMode != video::AlphaBackgroundMode::None)) {
            return false;
        }
        auto windows = windowCapture_.getWindows();
        for (const auto &info : windows) {
            if (info.id == sourceId) {
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
    } else if (mode == VideoSourceMode::Camera) {
        video::EncoderConfig captureConfig;
        {
            std::lock_guard<std::mutex> lock(videoSendMutex_);
            captureConfig = videoConfig_;
        }
        if (!cameraCapture_.startCapture(
                sourceId,
                captureConfig.width > 0 ? captureConfig.width : 1920,
                captureConfig.height > 0 ? captureConfig.height : 1080,
                captureConfig.frameRate > 0 ? captureConfig.frameRate : 30)) {
            const std::string detail = cameraCapture_.lastError();
            spdlog::warn("[App] Camera capture failed: {}",
                         detail.empty() ? "unknown error" : detail);
            emitRuntimeEvent(
                detail.empty()
                    ? "Failed to open the selected camera."
                    : detail,
                false);
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
    bool alphaEncoderOk = false;
    {
        std::lock_guard<std::mutex> lock(videoSendMutex_);
        if (!videoEncoder_.initialize(primaryConfig)) {
            const std::string requestedEncoder = videoEncoder_.requestedEncoderMode();
            const std::string encoderError =
                "Requested " + requestedEncoder + " encoder could not start with " +
                videoCodecName(config.codec) + ". No different encoder category was selected.";
            {
                std::lock_guard<std::mutex> errorLock(captureErrorMutex_);
                lastCaptureError_ = encoderError;
            }
            spdlog::error("[App] {}", encoderError);
            if (alphaRequested) {
                spdlog::error("[App] Primary encoder failed to initialize for explicit VP9 alpha workflow");
                emitRuntimeEvent(
                    "Primary encoder failed to initialize for VP9 alpha workflow. Use bundled FFmpeg/libvpx, lower FPS/resolution, or use chroma background mode.",
                    true);
                windowCapture_.stopCapture();
                spoutCapture_.stopCapture();
                cameraCapture_.stopCapture();
                return false;
            }
            if (config.codec == video::VideoCodec::H264 || config.explicitEncoderSelection) {
                windowCapture_.stopCapture();
                spoutCapture_.stopCapture();
                cameraCapture_.stopCapture();
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
                cameraCapture_.stopCapture();
                return false;
            }

            config = fallbackConfig;
            primaryConfig = fallbackConfig;
            videoConfig_ = fallbackConfig;
            updateRoomQualityDecisionForCodecLocked();
            emitRuntimeEvent(
                std::string("Selected ") + videoCodecName(selectedCodec) +
                    " encoder failed to initialize; switched to H.264 fallback.",
                false);
        }
        activeHqWidth_ = std::max(2, primaryConfig.width & ~1);
        activeHqHeight_ = std::max(2, primaryConfig.height & ~1);
        hqAspectLocked_ = false;
        activeEncoderName = videoEncoder_.activeEncoderName();

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
            updateRoomQualityDecisionForCodecLocked();
        }
        clearAlphaEncodeQueues();
        publishVideoStateSnapshotLocked();
    }
    syncRoomQualityDecision();
    if (activeEncoderName.empty()) {
        windowCapture_.stopCapture();
        spoutCapture_.stopCapture();
        cameraCapture_.stopCapture();
        return false;
    }
    const VideoStateSnapshot activeVideoState = videoStateSnapshot();
    spdlog::info(
        "[App] Video encoder selected requested={} active='{}' category={} fallbackReason='{}'",
        activeVideoState.requestedEncoderMode,
        activeEncoderName,
        activeVideoState.encoderCategory,
        activeVideoState.encoderFallbackReason.empty()
            ? "none"
            : activeVideoState.encoderFallbackReason);

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

    capturing_ = true;
    startEncodeThread();
    startVideoMaintenanceThread();
    startupRollback.armed = false;
    return true;
}

void VersusApp::stopCapture() {
    stopVideoMaintenanceThread();
    stopEncodeThread();
    windowCapture_.stopCapture();
    spoutCapture_.stopCapture();
    cameraCapture_.stopCapture();
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
    primaryAudioResampler_ = {};
    additionalAudioResampler_ = {};
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
    lastKeyframeSendMs_.store(0);
    resetMetricsWindow(steadyNowMs());
    capturing_ = false;
    {
        std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
        pendingVideoFrame_.reset();
        cachedVideoFrame_.reset();
    }
}

void VersusApp::setSelectedWindow(const std::string &windowId) {
    std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
    selectedWindowId_ = windowId;
}

void VersusApp::setVideoSourceMode(VideoSourceMode mode) {
    std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
    videoSourceMode_ = mode;
}

void VersusApp::setVideoConfig(const versus::video::EncoderConfig &config) {
    bool enteredCodecUnavailable = false;
    video::VideoCodec committedCodec = config.codec;
    uint64_t committedGeneration = 0;
    {
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
        updateRoomQualityDecisionForCodecLocked(
            &enteredCodecUnavailable,
            &committedGeneration);
        committedCodec = videoConfig_.codec;
        publishVideoStateSnapshotLocked();
    }
    emitRoomQualityCodecUnavailable({
        enteredCodecUnavailable,
        committedCodec,
        committedGeneration});
}

void VersusApp::setAudioSourceMode(AudioSourceMode mode) {
    std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
    audioSourceMode_ = mode;
}

void VersusApp::setIncludeMicrophone(bool enabled) {
    std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
    includeMicrophone_ = enabled;
}

void VersusApp::setMicrophoneDeviceId(const std::string &deviceId) {
    std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
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

    const std::string sessionSalt = options.salt.empty() ? "vdo.ninja" : options.salt;
    const RoomQualityWarningTicket roomQualityWarning =
        transitionRoomQualityLifecycle(&options, sessionSalt);
    stopRequested_.store(false);
    resetDuplicateOfferRecheckSchedulerForLive();
    reconnecting_.store(false);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(true);
    lastKeyframeSendMs_.store(0);
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
    alphaContractRecovery_.reset();
    lastAlphaContractDiagnosticMs_.store(0, std::memory_order_relaxed);
    audioSendFailures_.store(0, std::memory_order_relaxed);
    const int64_t metricsStartMs = steadyNowMs();
    metricsStartMs_.store(metricsStartMs, std::memory_order_relaxed);
    resetMetricsWindow(metricsStartMs);
    {
        std::lock_guard<std::mutex> lock(healthStateMutex_);
        lastPeerDisconnectReason_.clear();
    }

    maxViewers_.store(std::max(0, options.maxViewers), std::memory_order_relaxed);
    remoteControlEnabled_.store(options.remoteControlEnabled, std::memory_order_relaxed);
    webrtc::ResolvedIceConfig resolvedIce;
    try {
        resolvedIce = webrtc::resolveIceConfig(options.iceMode);
    } catch (const std::exception &error) {
        spdlog::error("[App] ICE configuration resolution failed: {}", error.what());
        emitRuntimeEvent("ICE server configuration could not be resolved; streaming was not started.", true);
        stopLive();
        return false;
    } catch (...) {
        spdlog::error("[App] ICE configuration resolution failed");
        emitRuntimeEvent("ICE server configuration could not be resolved; streaming was not started.", true);
        stopLive();
        return false;
    }

    const webrtc::IceConfigBindingValidation iceBinding = webrtc::validateIceConfigBinding(
        options.iceMode,
        resolvedIce.servers,
        resolvedIce.turn);
    if (!iceBinding.accepted) {
        spdlog::error("[App] ICE configuration rejected mode={} reason={}",
                      webrtc::iceModeName(options.iceMode),
                      iceBinding.failureReason);
        emitRuntimeEvent(
            "The authoritative TURN configuration was unavailable or invalid; streaming was not started.",
            true);
        stopLive();
        return false;
    }
    spdlog::info("{}", webrtc::consumedIceConfigDiagnostic(
                           options.iceMode,
                           iceBinding,
                           resolvedIce.turn));
    {
        std::lock_guard<std::mutex> lock(iceConfigMutex_);
        iceMode_ = options.iceMode;
        resolvedIceServers_ = resolvedIce.servers;
        resolvedTurnRegistry_ = resolvedIce.turn;
    }

    clearPeerSessions();
    setupSignalingCallbacks();

    spdlog::info("[App] Connecting to signaling server: {}", options.server);
    bool signalingConnected = false;
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        signalingConnected = signaling_.connect(options.server);
    }
    if (!signalingConnected) {
        spdlog::error("[App] Failed to connect to signaling server");
        stopLive();
        return false;
    }
    spdlog::info("[App] Connected to signaling server");

    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        signaling_.setPassword(options.password);
        if (options.password == "false" || options.password == "0" || options.password == "off") {
            spdlog::info("[App] Encryption disabled");
            signaling_.disableEncryption();
        }
    }

    if (!options.room.empty()) {
        spdlog::info("[App] Joining room: {}", options.room);
        signaling::RoomConfig roomConfig;
        roomConfig.room = options.room;
        roomConfig.password = options.password;
        roomConfig.label = options.label;
        roomConfig.streamId = options.streamId;
        roomConfig.salt = sessionSalt;
        bool roomJoined = false;
        {
            std::lock_guard<std::mutex> lock(signalingOpsMutex_);
            roomJoined = signaling_.joinRoom(roomConfig);
            if (!roomJoined) {
                signaling_.disconnect();
            }
        }
        if (!roomJoined) {
            spdlog::error("[App] Failed to join room");
            stopLive();
            return false;
        }
    }

    std::string resolvedStreamId;
    if (options.streamId.empty()) {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        resolvedStreamId = signaling_.getStreamId();
    } else {
        resolvedStreamId = options.streamId;
    }
    if (resolvedStreamId.empty()) {
        resolvedStreamId = "gamecapture_" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
    }
    std::string resolvedRemoteControlToken = options.remoteControlToken;
    if (remoteControlEnabled_.load(std::memory_order_relaxed) && resolvedRemoteControlToken.empty()) {
        if (!options.password.empty() && options.password != "false" && options.password != "0" && options.password != "off") {
            resolvedRemoteControlToken = options.password;
        } else {
            resolvedRemoteControlToken = resolvedStreamId;
        }
    }
    {
        std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
        streamId_ = resolvedStreamId;
        remoteControlToken_ = resolvedRemoteControlToken;
    }
    if (remoteControlEnabled_.load(std::memory_order_relaxed)) {
        spdlog::info("[App] Remote control enabled (tokenLength={})", resolvedRemoteControlToken.size());
    }

    spdlog::info("[App] Publishing stream: {}", resolvedStreamId);
    bool streamPublished = false;
    {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        streamPublished = signaling_.publish(resolvedStreamId, options.label);
        if (!streamPublished) {
            signaling_.disconnect();
        }
    }
    if (!streamPublished) {
        spdlog::error("[App] Failed to publish stream");
        stopLive();
        return false;
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
    emitRoomQualityCodecUnavailable(roomQualityWarning);
    return true;
}

void VersusApp::stopLive() {
    const bool wasLive = live_.exchange(false);
    stopRequested_.store(true);
    cancelDuplicateOfferRechecks(true, "stop-live");
    reconnecting_.store(false);
    videoTrackActive_.store(false);
    pendingGlobalKeyframe_.store(false);
    stopSignalingRecoveryThread();
    stopVideoMaintenanceThread();
    if (wasLive) {
        std::lock_guard<std::mutex> lock(signalingOpsMutex_);
        signaling_.unpublish();
        signaling_.disconnect();
    }
    clearPeerSessions();
    transitionRoomQualityLifecycle(nullptr, {});
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

std::string VersusApp::getRequestedVideoEncoderMode() const {
    return videoStateSnapshot().requestedEncoderMode;
}

std::string VersusApp::getVideoEncoderCategory() const {
    return videoStateSnapshot().encoderCategory;
}

std::string VersusApp::getVideoEncoderFallbackReason() const {
    return videoStateSnapshot().encoderFallbackReason;
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

StreamMetrics VersusApp::buildStreamMetricsSnapshot(
    bool updateRecentWindow,
    const PeerCounts *peerCountsOverride) const {
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

    const PeerCounts counts = peerCountsOverride
        ? *peerCountsOverride
        : collectPeerCounts();
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

std::shared_ptr<const video::CapturedFrame> VersusApp::getPublisherPreviewFrame() {
    return getCachedVideoFrame();
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

webrtc::SelectedIcePath VersusApp::selectedIcePathSnapshot() const {
    std::vector<std::shared_ptr<PeerSession>> peers;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peers.reserve(peerSessions_.size());
        for (const auto &[key, peer] : peerSessions_) {
            (void)key;
            if (peer) {
                peers.push_back(peer);
            }
        }
    }

    auto rank = [](webrtc::SelectedIcePath path) {
        switch (path) {
            case webrtc::SelectedIcePath::TurnRelay:
                return 3;
            case webrtc::SelectedIcePath::Stun:
                return 2;
            case webrtc::SelectedIcePath::Host:
                return 1;
            case webrtc::SelectedIcePath::Unknown:
            default:
                return 0;
        }
    };

    webrtc::SelectedIcePath selected = webrtc::SelectedIcePath::Unknown;
    for (const auto &peer : peers) {
        std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
        if (!peer->client) {
            continue;
        }
        const webrtc::SelectedIcePath candidate = peer->client->selectedIcePath();
        if (rank(candidate) > rank(selected)) {
            selected = candidate;
        }
    }
    return selected;
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
    const VideoStateSnapshot videoState = videoStateSnapshot();
    health.requestedEncoder = videoState.requestedEncoderMode;
    health.encoderCategory = videoState.encoderCategory;
    health.encoderFallbackReason = videoState.encoderFallbackReason;
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

    if (health.peerCount <= 0) {
        health.candidatePath = "No peers";
    } else {
        health.candidatePath = webrtc::selectedIcePathName(selectedIcePathSnapshot());
    }
    return health;
}

std::string VersusApp::buildDiagnosticsJson() const {
    nlohmann::json root;
    root["schema"] = "game-capture-diagnostics-v1";
    root["version"] = publisherVersionTag();
    root["generated_steady_ms"] = steadyNowMs();

    refreshDiagnosticsTrackObservationsForTesting();
    const RoomQualityDiagnosticsSnapshot roomQualitySnapshot =
        roomQualityDiagnosticsSnapshot();
    const StreamMetrics metrics = buildStreamMetricsSnapshot(
        true,
        &roomQualitySnapshot.counts);
    const SourceHealth sourceHealth = getSourceHealth();
    ConnectionHealth health;
    populateSystemResourceUsage(health);
    const VideoStateSnapshot videoState = videoStateSnapshot();
    std::function<void()> afterVideoSnapshot;
    {
        std::lock_guard<std::mutex> hookLock(roomQualityArchitectureTestHookMutex_);
        afterVideoSnapshot = afterDiagnosticsVideoSnapshotForTesting_;
    }
    if (afterVideoSnapshot) {
        afterVideoSnapshot();
    }
    const RoomQualityDecision &roomQuality = roomQualitySnapshot.decision;
    const PeerCounts &counts = roomQualitySnapshot.counts;
    const auto peerOperationStats = peerOperationExecutor_.stats();
    const video::FfmpegProbeInfo ffmpegInfo = video::VideoEncoder::probeFfmpeg(videoState.config.ffmpegPath);
    std::string diagnosticsServer;
    std::string diagnosticsRoom;
    std::string diagnosticsStreamId;
    bool diagnosticsPasswordSet = false;
    bool diagnosticsPasswordDisabled = false;
    int diagnosticsRemoteControlTokenLength = 0;
    AudioSourceMode diagnosticsAudioSourceMode = AudioSourceMode::None;
    bool diagnosticsIncludeMicrophone = false;
    std::string diagnosticsMicrophoneSource;
    {
        std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
        diagnosticsServer = startOptions_.server;
        diagnosticsStreamId = streamId_;
        diagnosticsPasswordSet = !password_.empty();
        diagnosticsPasswordDisabled = password_ == "false" || password_ == "0" || password_ == "off";
        diagnosticsRemoteControlTokenLength = static_cast<int>(remoteControlToken_.size());
        diagnosticsAudioSourceMode = audioSourceMode_;
        diagnosticsIncludeMicrophone = includeMicrophone_;
        diagnosticsMicrophoneSource = activeMicrophoneSourceName_;
    }
    diagnosticsRoom = roomQualitySnapshot.activeRoom;
    std::string diagnosticsIceMode;
    int diagnosticsIceServerCount = 0;
    {
        std::lock_guard<std::mutex> lock(iceConfigMutex_);
        diagnosticsIceMode = webrtc::iceModeName(iceMode_);
        diagnosticsIceServerCount = static_cast<int>(resolvedIceServers_.size());
    }
    int diagnosticsCaptureWidth = sourceHealth.width;
    int diagnosticsCaptureHeight = sourceHealth.height;
    {
        // Diagnostics is served from the Qt/control thread and must never
        // wait behind a driver or encoder call that owns the video mutex.
        // The source-health dimensions remain a useful, thread-safe fallback.
        std::unique_lock<std::mutex> lock(videoSendMutex_, std::try_to_lock);
        if (lock.owns_lock()) {
            diagnosticsCaptureWidth = lastCaptureWidth_;
            diagnosticsCaptureHeight = lastCaptureHeight_;
        }
    }

    root["app"] = {
        {"live", live_.load(std::memory_order_relaxed)},
        {"capturing", capturing_.load(std::memory_order_relaxed)},
        {"reconnecting", reconnecting_.load(std::memory_order_relaxed)},
        {"stop_requested", stopRequested_.load(std::memory_order_relaxed)}
    };
    root["room_quality"] = {
        {"generation", roomQualitySnapshot.generation},
        {"active_room", roomQualitySnapshot.activeRoom},
        {"committed_codec", videoCodecName(roomQualitySnapshot.codec)},
        {"requested", roomQuality.requested},
        {"effective", roomQuality.effective},
        {"reason", roomQualityReasonName(roomQuality.reason)}
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
        {"server", diagnosticsServer},
        {"room", diagnosticsRoom},
        {"stream_id", diagnosticsStreamId},
        {"password_set", diagnosticsPasswordSet},
        {"password_disabled", diagnosticsPasswordDisabled},
        {"remote_control_enabled", remoteControlEnabled_.load(std::memory_order_relaxed)},
        {"remote_control_token_length", diagnosticsRemoteControlTokenLength},
        {"ice_mode", diagnosticsIceMode},
        {"resolved_ice_servers", diagnosticsIceServerCount},
        {"selected_ice_path", webrtc::selectedIcePathName(selectedIcePathSnapshot())},
        {"max_viewers", maxViewers_.load(std::memory_order_relaxed)}
    };
    root["peer_operation_executor"] = {
        {"queued_critical", peerOperationStats.queuedCritical},
        {"queued_ordinary", peerOperationStats.queuedOrdinary},
        {"in_flight", peerOperationStats.inFlight},
        {"accepted_critical", peerOperationStats.acceptedCritical},
        {"accepted_ordinary", peerOperationStats.acceptedOrdinary},
        {"coalesced_critical", peerOperationStats.coalescedCritical},
        {"coalesced_ordinary", peerOperationStats.coalescedOrdinary},
        {"dropped_ordinary_capacity", peerOperationStats.droppedOrdinaryCapacity},
        {"evicted_ordinary_for_critical", peerOperationStats.evictedOrdinaryForCritical},
        {"evicted_critical_for_critical", peerOperationStats.evictedCriticalForCritical},
        {"rejected_critical_capacity", peerOperationStats.rejectedCriticalCapacity},
        {"rejected_invalid", peerOperationStats.rejectedInvalid},
        {"rejected_stopped", peerOperationStats.rejectedStopped},
        {"stale_generation", peerOperationStats.staleGeneration},
        {"dropped_on_stop", peerOperationStats.droppedOnStop}
    };
    root["video"] = {
        {"configured_width", videoState.config.width},
        {"configured_height", videoState.config.height},
        {"configured_fps", videoState.config.frameRate},
        {"configured_bitrate_kbps", videoState.config.bitrate},
        {"configured_codec", videoCodecName(roomQualitySnapshot.codec)},
        {"active_codec", videoState.codecName},
        {"requested_encoder", videoState.requestedEncoderMode},
        {"active_encoder", videoState.encoderName},
        {"active_encoder_category", videoState.encoderCategory},
        {"encoder_fallback_reason", videoState.encoderFallbackReason},
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
        {"last_capture_width", diagnosticsCaptureWidth},
        {"last_capture_height", diagnosticsCaptureHeight},
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
        {"alpha_contract_rejected_pairs", alphaContractRecovery_.rejectedPairCount()},
        {"alpha_contract_recovery_attempts", alphaContractRecovery_.recoveryAttemptCount()},
        {"alpha_contract_recovery_successes", alphaContractRecovery_.recoverySuccessCount()},
        {"alpha_contract_recovery_active", alphaContractRecovery_.recoveryActive()},
        {"alpha_contract_last_rejection",
         protectedAlphaContractRejectionName(alphaContractRecovery_.lastRejection())},
        {"frames_captured", videoFramesCaptured_.load(std::memory_order_relaxed)},
        {"frames_sent", videoFramesSent_.load(std::memory_order_relaxed)},
        {"frames_dropped", videoFramesDropped_.load(std::memory_order_relaxed)},
        {"frames_skipped_before_readback", windowCapture_.framesSkippedBeforeReadback()},
        {"dropped_frame_rate", metrics.droppedFrameRate}
    };
    root["audio"] = {
        {"source_mode", audioSourceModeName(diagnosticsAudioSourceMode)},
        {"include_microphone", diagnosticsIncludeMicrophone},
        {"active_microphone_source", diagnosticsMicrophoneSource},
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
        {"alpha_contract_rejected_pairs", alphaContractRecovery_.rejectedPairCount()},
        {"alpha_contract_recovery_attempts", alphaContractRecovery_.recoveryAttemptCount()},
        {"alpha_contract_recovery_successes", alphaContractRecovery_.recoverySuccessCount()},
        {"alpha_contract_recovery_active", alphaContractRecovery_.recoveryActive()},
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

    nlohmann::json pendingRemoteCandidateQueues = nlohmann::json::array();
    std::unordered_map<std::string, int> pendingRemoteCandidateCounts;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        for (const auto &entry : pendingRemoteCandidates_) {
            pendingRemoteCandidateCounts[entry.first] =
                static_cast<int>(entry.second.size());
            pendingRemoteCandidateQueues.push_back({
                {"key", entry.first},
                {"count", static_cast<int>(entry.second.size())}
            });
        }
    }

    root["pending_remote_candidate_queues"] = std::move(pendingRemoteCandidateQueues);
    root["peers"] = nlohmann::json::array();
    for (const auto &peerSnapshot : roomQualitySnapshot.peers) {
        const auto &peer = peerSnapshot.peer;
        if (!peer) {
            continue;
        }

        nlohmann::json item;
        item["uuid"] = peerSnapshot.uuid;
        item["session"] = peerSnapshot.session;
        item["owner_session"] = peer->session;
        item["active_wire_session"] = peerSnapshot.session;
        item["stream_id"] = peerSnapshot.streamId;
        item["candidate_type"] = peerSnapshot.candidateType;
        item["created_steady_ms"] = peerSnapshot.createdAtMs;
        item["uuid_owner_high_watermark"] =
            peer->uuidOwnerHighWatermark.load(std::memory_order_relaxed);
        item["last_state_change_steady_ms"] = peer->lastStateChangeMs.load(std::memory_order_relaxed);
        int bufferedLocalCandidateCount = 0;
        bool offerDispatched = false;
        bool answerReceived = false;
        bool offerCreationInProgress = false;
        bool transportRetired = false;
        uint64_t activeOfferGeneration = 0;
        uint64_t activeTransportGeneration = 0;
        uint64_t clientTransportGeneration = 0;
        std::string selectedIcePath;
        {
            std::lock_guard<std::mutex> lock(peer->negotiationMutex);
            bufferedLocalCandidateCount = static_cast<int>(peer->pendingCandidates.size());
            offerDispatched = peer->offerDispatched;
            answerReceived = peer->answerReceived;
            offerCreationInProgress = peer->offerCreationInProgress;
            transportRetired = peer->transportRetired;
            activeOfferGeneration = peer->activeOfferGeneration;
            activeTransportGeneration = peer->activeTransportGeneration;
            clientTransportGeneration = peer->clientTransportGeneration;
        }
        {
            webrtc::SelectedIcePath livePath = webrtc::SelectedIcePath::Unknown;
            std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
            if (peer->client) {
                livePath = peer->client->selectedIcePath();
            }
            std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
            if (livePath != webrtc::SelectedIcePath::Unknown) {
                peer->selectedIcePath = webrtc::selectedIcePathName(livePath);
            }
            selectedIcePath = peer->selectedIcePath;
        }
        item["signaling"] = {
            {"offer_dispatched", offerDispatched},
            {"offer_creation_in_progress", offerCreationInProgress},
            {"answer_received", answerReceived},
            {"active_offer_generation", activeOfferGeneration},
            {"active_transport_generation", activeTransportGeneration},
            {"client_transport_generation", clientTransportGeneration},
            {"active_wire_session", peerSnapshot.session},
            {"offer_count", peer->offerCount.load(std::memory_order_relaxed)},
            {"recovery_offer_count", peer->recoveryOfferCount.load(std::memory_order_relaxed)},
            {"answer_count", peer->answerCount.load(std::memory_order_relaxed)},
            {"local_candidates_sent", peer->localCandidatesSent.load(std::memory_order_relaxed)},
            {"local_candidate_send_failures",
             peer->localCandidateSendFailures.load(std::memory_order_relaxed)},
            {"remote_candidates_applied", peer->remoteCandidatesApplied.load(std::memory_order_relaxed)},
            {"pending_remote_candidates", pendingRemoteCandidateCounts[
                makePeerKey(peerSnapshot.uuid, peerSnapshot.session)]},
            {"duplicate_offer_recheck_pending",
             peer->duplicateOfferRecheckPending.load(std::memory_order_relaxed)},
            {"duplicate_offer_rechecks_scheduled",
             peer->duplicateOfferRechecksScheduled.load(std::memory_order_relaxed)},
            {"duplicate_offer_rechecks_coalesced",
             peer->duplicateOfferRechecksCoalesced.load(std::memory_order_relaxed)},
            {"duplicate_offer_rechecks_fired",
             peer->duplicateOfferRechecksFired.load(std::memory_order_relaxed)},
            {"duplicate_offer_rechecks_rebuilt",
             peer->duplicateOfferRechecksRebuilt.load(std::memory_order_relaxed)},
            {"duplicate_offer_rechecks_ignored_connected",
             peer->duplicateOfferRechecksIgnoredConnected.load(std::memory_order_relaxed)},
            {"duplicate_offer_rechecks_stale",
             peer->duplicateOfferRechecksStale.load(std::memory_order_relaxed)},
            {"duplicate_offer_rechecks_canceled",
             peer->duplicateOfferRechecksCanceled.load(std::memory_order_relaxed)},
            {"buffered_local_candidates", bufferedLocalCandidateCount}
        };
        item["room"] = {
            {"room_mode", peer->roomMode},
            {"init_received", peer->initReceived.load(std::memory_order_relaxed)},
            {"role_valid", peer->roleValid.load(std::memory_order_relaxed)},
            {"role", peerRoleName(peer->role.load(std::memory_order_relaxed))},
            {"assigned_tier", streamTierName(peerSnapshot.assignedTier)},
            {"init_deadline_steady_ms", peer->initDeadlineMs.load(std::memory_order_relaxed)}
        };
        item["media"] = {
            {"video_enabled", peer->videoEnabled.load(std::memory_order_relaxed)},
            {"audio_enabled", peer->audioEnabled.load(std::memory_order_relaxed)},
            {"last_observed_video_track_active", peerSnapshot.activeVideo},
            {"last_observed_audio_track_active", peerSnapshot.activeAudio},
            {"waiting_for_keyframe", peer->waitingForKeyframe.load(std::memory_order_relaxed)},
            {"requested_video_bitrate_kbps", peer->requestedVideoBitrateKbps.load(std::memory_order_relaxed)},
            {"requested_audio_bitrate_kbps", peer->requestedAudioBitrateKbps.load(std::memory_order_relaxed)},
            {"renegotiation_queued", peer->renegotiationQueued.load(std::memory_order_relaxed)},
            {"codec_fallback_attempted", peer->codecFallbackAttempted.load(std::memory_order_relaxed)},
            {"alpha_allowed", peer->alphaAllowed.load(std::memory_order_relaxed)},
            {"last_primary_transport_pts", peer->lastPrimaryPtsSent.load(std::memory_order_relaxed)},
            {"last_video_wire_pts_reserved",
             peer->lastVideoWirePtsReserved.load(std::memory_order_relaxed)},
            {"alpha_source_cutoff_timestamp", peer->alphaSourceCutoffTimestamp.load(std::memory_order_relaxed)},
            {"alpha_admission_cutoff_sequence", peer->alphaAdmissionCutoffSequence.load(std::memory_order_relaxed)}
        };
        item["transport"] = {
            {"data_channel_open", peer->dataChannelOpen.load(std::memory_order_relaxed)},
            {"disconnected_since_steady_ms", peer->disconnectedSinceMs.load(std::memory_order_relaxed)},
            {"transport_retired", transportRetired},
            {"stats_continuous", peer->statsContinuous.load(std::memory_order_relaxed)},
            {"selected_ice_path", selectedIcePath}
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

#ifdef _WIN32
        QSaveFile out(QString::fromStdWString(outputPath.native()));
#else
        QSaveFile out(QString::fromStdString(outputPath.native()));
#endif
        if (!out.open(QIODevice::WriteOnly)) {
            spdlog::warn("[Diagnostics] Failed to open diagnostics output '{}'", path);
            return false;
        }
        const std::string bytes = buildDiagnosticsJson() + '\n';
        if (out.write(bytes.data(), static_cast<qint64>(bytes.size())) != static_cast<qint64>(bytes.size()) ||
            !out.commit()) {
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

int VersusApp::refreshPeerTransportsForLocalControl() {
    struct RefreshTarget {
        std::shared_ptr<PeerSession> peer;
        uint64_t clientTransportGeneration = 0;
    };
    std::vector<RefreshTarget> peersToRefresh;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        peersToRefresh.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (entry.second && entry.second->client &&
                entry.second->dataChannelOpen.load(std::memory_order_relaxed)) {
                std::lock_guard<std::mutex> negotiationLock(
                    entry.second->negotiationMutex);
                if (!entry.second->removed &&
                    entry.second->clientTransportGeneration != 0) {
                    peersToRefresh.push_back({
                        entry.second,
                        entry.second->clientTransportGeneration});
                }
            }
        }
    }

    int acceptedPeerCount = 0;
    spdlog::info("[App] Authenticated local control requested asynchronous peer transport rebuild for {} peer(s)",
                 peersToRefresh.size());
    for (const auto &target : peersToRefresh) {
        const auto &peer = target.peer;
        if (!peer || !peer->client) {
            continue;
        }
        if (enqueuePeerCallbackOperation(
                peer,
                target.clientTransportGeneration,
                "local-control-refresh",
                GenerationTaggedPeerOperationExecutor::Priority::Critical,
                GenerationTaggedPeerOperationExecutor::Criticality::Convergent,
                "local-control-refresh",
                [this](const std::shared_ptr<PeerSession> &queuedPeer, uint64_t) {
                    queuedPeer->waitingForKeyframe.store(
                        true,
                        std::memory_order_relaxed);
                    reservePeerAlphaAdmissionCutoff(queuedPeer);
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                    lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                    if (!sendPeerOffer(
                            queuedPeer,
                            "local-control-refresh",
                            true)) {
                        spdlog::warn(
                            "[App] Authenticated local control could not refresh peer {}:{}",
                            queuedPeer->uuid,
                            queuedPeer->session);
                    }
                })) {
            ++acceptedPeerCount;
        } else {
            spdlog::warn("[App] Authenticated local control could not schedule peer refresh {}:{}",
                         peer->uuid,
                         peer->session);
        }
    }
    return acceptedPeerCount;
}

void VersusApp::startAudioCapture(uint32_t selectedWindowProcessId) {
    const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
    const AudioSourceMode audioSourceMode = lifecycleState.audioSourceMode;
    const bool includeMicrophone = lifecycleState.includeMicrophone;
    const std::string microphoneDeviceId = lifecycleState.microphoneDeviceId;
    {
        std::lock_guard<std::mutex> lock(additionalAudioMutex_);
        additionalAudioBuffer_.clear();
        additionalAudioSampleRate_ = 0;
        additionalAudioChannels_ = 0;
    }
    const auto setActiveMicrophoneSource = [this](std::string source) {
        std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
        activeMicrophoneSourceName_ = std::move(source);
    };
    const auto activeMicrophoneSource = [this]() {
        std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
        return activeMicrophoneSourceName_;
    };
    setActiveMicrophoneSource(microphoneDeviceId.empty() ? "default-microphone" : "selected-microphone");

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

    const auto resolveMicrophoneLabel = [this, &microphoneDeviceId]() {
        if (microphoneDeviceId.empty()) {
            return std::string("default-microphone");
        }
        const auto devices = microphoneAudioCapture_.GetInputDevices();
        for (const auto &device : devices) {
            if (device.id == microphoneDeviceId) {
                return device.name.empty() ? std::string("selected-microphone") : device.name;
            }
        }
        return std::string("selected-microphone");
    };

    const auto startMicrophone = [&](const audio::WindowAudioCaptureCore::StreamCallback &callback,
                                     const char *role) {
        const std::string requestedLabel = resolveMicrophoneLabel();
        audio::CaptureResult micResult;
        if (!microphoneDeviceId.empty()) {
            micResult = microphoneAudioCapture_.StartInputDeviceStreamCapture(microphoneDeviceId, callback);
            if (!micResult.success) {
                spdlog::warn("[Audio] {} microphone capture device='{}' failed: {}; falling back to default input",
                             role,
                             requestedLabel,
                             micResult.error.empty() ? "unknown error" : micResult.error);
                emitRuntimeEvent("Selected microphone/input was unavailable; using Windows default microphone/input.", false);
                setActiveMicrophoneSource("default-microphone");
                micResult = microphoneAudioCapture_.StartDefaultEndpointStreamCapture(
                    audio::DefaultAudioEndpoint::MultimediaInput, callback);
            } else {
                setActiveMicrophoneSource(requestedLabel);
            }
        } else {
            micResult = microphoneAudioCapture_.StartDefaultEndpointStreamCapture(
                audio::DefaultAudioEndpoint::MultimediaInput, callback);
            setActiveMicrophoneSource("default-microphone");
        }

        if (micResult.success) {
            const std::string activeSource = activeMicrophoneSource();
            spdlog::info("[Audio] {} microphone capture source={} sampleRate={} channels={} processLoopback={}",
                         role,
                         activeSource,
                         micResult.sampleRate,
                         micResult.channels,
                         micResult.usingProcessLoopback);
            warnIfConverted(activeSource, micResult);
            return true;
        }

        spdlog::warn("[Audio] {} microphone capture failed: {}",
                     role,
                     micResult.error.empty() ? "unknown error" : micResult.error);
        setActiveMicrophoneSource("none");
        return false;
    };
    const auto startMicrophoneAsPrimary = [&]() {
        return startMicrophone(primaryCallback, "Primary");
    };

    audio::CaptureResult result;
    switch (audioSourceMode) {
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
            if (!includeMicrophone) {
                spdlog::info("[Audio] Audio capture disabled by user setting");
                return;
            }
            startMicrophoneAsPrimary();
            return;
        case AudioSourceMode::SelectedWindow:
        default:
            if (selectedWindowProcessId == 0) {
                spdlog::warn("[Audio] Selected-window audio requested but no process id was available");
                if (includeMicrophone) {
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
                     audioSourceModeName(audioSourceMode),
                     result.sampleRate,
                     result.channels,
                     result.usingProcessLoopback);
        warnIfConverted(audioSourceModeName(audioSourceMode), result);
    } else {
        spdlog::warn("[Audio] Capture source={} failed: {}",
                     audioSourceModeName(audioSourceMode),
                     result.error.empty() ? "unknown error" : result.error);
        if (includeMicrophone && audioSourceMode != AudioSourceMode::DefaultMicrophone) {
            spdlog::warn("[Audio] Falling back to default microphone/input as primary audio source");
            startMicrophoneAsPrimary();
        }
        return;
    }

    if (includeMicrophone && audioSourceMode != AudioSourceMode::DefaultMicrophone) {
        startMicrophone(additionalCallback, "Additional");
    }
}

void VersusApp::handleAdditionalAudioChunk(versus::audio::StreamChunk &&chunk) {
    if (!live_) {
        return;
    }

    std::vector<float> normalizedSamples = audio::normalizeAudioForOpus(chunk, &additionalAudioResampler_);
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

    std::vector<float> normalizedSamples = audio::normalizeAudioForOpus(chunk, &primaryAudioResampler_);
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

bool VersusApp::enqueuePeerCallbackOperation(
    const std::shared_ptr<PeerSession> &peer,
    uint64_t clientTransportGeneration,
    const char *kind,
    GenerationTaggedPeerOperationExecutor::Priority priority,
    GenerationTaggedPeerOperationExecutor::Criticality criticality,
    std::string coalesceKey,
    PeerCallbackOperation operation) {
    if (!peer || !peer->client || clientTransportGeneration == 0 || !operation) {
        return false;
    }
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed ||
            peer->clientTransportGeneration != clientTransportGeneration) {
            return false;
        }
    }

    const std::string operationKind = kind ? kind : "peer-callback";
    std::function<void(const std::string &, uint64_t)> beforeEnqueue;
    {
        std::lock_guard<std::mutex> hookLock(peerCallbackTestHookMutex_);
        beforeEnqueue = beforePeerCallbackEnqueueForTesting_;
    }
    if (beforeEnqueue) {
        beforeEnqueue(operationKind, clientTransportGeneration);
    }

    std::weak_ptr<PeerSession> weakPeer = peer;
    const auto enqueueResult = peerOperationExecutor_.enqueue(
        clientTransportGeneration,
        makePeerKey(peer->uuid, peer->session),
        priority,
        std::move(coalesceKey),
        [weakPeer](uint64_t generation) {
            const auto currentPeer = weakPeer.lock();
            if (!currentPeer) {
                return false;
            }
            std::lock_guard<std::mutex> negotiationLock(currentPeer->negotiationMutex);
            return !currentPeer->removed &&
                currentPeer->clientTransportGeneration == generation;
        },
        [this,
         weakPeer,
         operationKind,
         operation = std::move(operation)](uint64_t generation) {
            const auto currentPeer = weakPeer.lock();
            if (!currentPeer) {
                return;
            }

            // Callback handlers may acquire videoSendMutex, stop capture and
            // join the encode thread, or enter a narrowly scoped peer-client
            // operation themselves. Holding clientOperationMutex around the
            // whole handler would invert the encode path's video->peer order
            // and can deadlock shutdown. Revalidate immediately before dispatch
            // and let each transport operation own its existing narrow lock.
            // A separate callback lease coordinates the validated generation
            // with replacement and async teardown; encode/send paths never
            // acquire it.
            std::lock_guard<std::recursive_mutex> callbackOperationLock(
                currentPeer->callbackOperationMutex);
            if (!currentPeer->client) {
                return;
            }
            {
                std::lock_guard<std::mutex> negotiationLock(
                    currentPeer->negotiationMutex);
                if (currentPeer->removed ||
                    currentPeer->clientTransportGeneration != generation) {
                    return;
                }
            }

            std::function<bool(const std::string &, const std::string &, uint64_t)>
                testOperation;
            {
                std::lock_guard<std::mutex> hookLock(peerCallbackTestHookMutex_);
                testOperation = peerCallbackOperationForTesting_;
            }
            if (testOperation &&
                testOperation(
                    makePeerKey(currentPeer->uuid, currentPeer->session),
                    operationKind,
                    generation)) {
                return;
            }
            operation(currentPeer, generation);
        },
        criticality);
    const bool queued =
        GenerationTaggedPeerOperationExecutor::accepted(enqueueResult);
    const bool overloadEvent =
        enqueueResult == GenerationTaggedPeerOperationExecutor::EnqueueResult::
                             QueuedAfterEvictingOrdinary ||
        enqueueResult == GenerationTaggedPeerOperationExecutor::EnqueueResult::
                             QueuedAfterEvictingCritical ||
        enqueueResult == GenerationTaggedPeerOperationExecutor::EnqueueResult::
                             RejectedOrdinaryCapacity ||
        enqueueResult == GenerationTaggedPeerOperationExecutor::EnqueueResult::
                             RejectedCriticalCapacity;
    if (overloadEvent) {
        const int64_t nowMs = steadyNowMs();
        int64_t lastLogMs =
            lastPeerOperationOverloadLogMs_.load(std::memory_order_relaxed);
        if ((lastLogMs == 0 || nowMs - lastLogMs >= 5000) &&
            lastPeerOperationOverloadLogMs_.compare_exchange_strong(
                lastLogMs,
                nowMs,
                std::memory_order_relaxed,
                std::memory_order_relaxed)) {
            const auto stats = peerOperationExecutor_.stats();
            spdlog::warn(
                "[PeerOperations] Callback queue overload result={} kind={} generation={} peer={}:{} pendingCritical={} pendingOrdinary={} ordinaryDropped={} ordinaryEvicted={} criticalEvicted={} criticalRejected={} criticalCoalesced={}",
                peerOperationEnqueueResultName(enqueueResult),
                operationKind,
                clientTransportGeneration,
                peer->uuid,
                peer->session,
                stats.queuedCritical,
                stats.queuedOrdinary,
                stats.droppedOrdinaryCapacity,
                stats.evictedOrdinaryForCritical,
                stats.evictedCriticalForCritical,
                stats.rejectedCriticalCapacity,
                stats.coalescedCritical);
        }
    }
    return queued;
}

void VersusApp::installPeerOperationCallbacks(
    const std::shared_ptr<PeerSession> &peer) {
    if (!peer || !peer->client) {
        return;
    }
    std::weak_ptr<PeerSession> weakPeer = peer;
    peer->client->setStateCallback(
        [this, weakPeer](webrtc::ConnectionState state,
                         uint64_t clientTransportGeneration) {
            const auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            enqueuePeerCallbackOperation(
                peerPtr,
                clientTransportGeneration,
                "connection-state",
                GenerationTaggedPeerOperationExecutor::Priority::Critical,
                connectionStateCriticality(state),
                "connection-state",
                [this, state](const std::shared_ptr<PeerSession> &queuedPeer,
                              uint64_t generation) {
                    handlePeerConnectionState(queuedPeer, state, generation);
                });
        });
    peer->client->setDataMessageCallback(
        [this, weakPeer](const std::string &message,
                         uint64_t clientTransportGeneration) {
            const auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            const PeerCallbackSchedule schedule =
                schedulePeerDataMessage(message);
            enqueuePeerCallbackOperation(
                peerPtr,
                clientTransportGeneration,
                "data-message",
                schedule.priority,
                schedule.criticality,
                schedule.coalesceKey,
                [this, message](const std::shared_ptr<PeerSession> &queuedPeer,
                                uint64_t) {
                    queuedPeer->dataChannelOpen.store(true, std::memory_order_relaxed);
                    if (!queuedPeer->initReceived.load(std::memory_order_relaxed) &&
                        queuedPeer->initDeadlineMs.load(std::memory_order_relaxed) <= 0) {
                        const int64_t graceMs = queuedPeer->roomMode
                            ? kRoomInitGracePeriodMs
                            : kDirectInitGracePeriodMs;
                        queuedPeer->initDeadlineMs.store(
                            steadyNowMs() + graceMs,
                            std::memory_order_relaxed);
                    }
                    try {
                        handlePeerDataMessage(queuedPeer, message);
                    } catch (const std::exception &e) {
                        spdlog::warn(
                            "[App] Failed to handle peer data message from {}:{}: {}",
                            queuedPeer->uuid,
                            queuedPeer->session,
                            e.what());
                    } catch (...) {
                        spdlog::warn(
                            "[App] Failed to handle peer data message from {}:{}",
                            queuedPeer->uuid,
                            queuedPeer->session);
                    }
                });
        });
    peer->client->setDataChannelStateCallback(
        [this, weakPeer](bool open, uint64_t clientTransportGeneration) {
            const auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            enqueuePeerCallbackOperation(
                peerPtr,
                clientTransportGeneration,
                "datachannel-state",
                GenerationTaggedPeerOperationExecutor::Priority::Critical,
                open
                    ? GenerationTaggedPeerOperationExecutor::Criticality::State
                    : GenerationTaggedPeerOperationExecutor::Criticality::Convergent,
                "datachannel-state",
                [this, open](const std::shared_ptr<PeerSession> &queuedPeer,
                             uint64_t generation) {
                    handlePeerDataChannelState(queuedPeer, open, generation);
                });
        });
}

void VersusApp::handlePeerConnectionState(
    const std::shared_ptr<PeerSession> &peer,
    webrtc::ConnectionState state,
    uint64_t) {
    if (!peer) {
        return;
    }
    const char *stateName = connectionStateName(state);
    peer->lastStateChangeMs.store(steadyNowMs(), std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
        peer->lastConnectionState = stateName;
    }
    recordPeerEvent(peer, std::string("connection-state ") + stateName);
    if (state == webrtc::ConnectionState::Connected) {
        webrtc::SelectedIcePath selectedPath = webrtc::SelectedIcePath::Unknown;
        {
            std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
            if (peer->client) {
                selectedPath = peer->client->selectedIcePath();
            }
        }
        {
            std::lock_guard<std::mutex> lock(peer->negotiationMutex);
            peer->transportRetired = false;
            peer->directFailureNoticeEmitted = false;
        }
        peer->disconnectedSinceMs.store(0, std::memory_order_relaxed);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
        reservePeerAlphaAdmissionCutoff(peer);
        {
            std::lock_guard<std::mutex> lock(peer->diagnosticsMutex);
            peer->selectedIcePath = webrtc::selectedIcePathName(selectedPath);
        }
        spdlog::info("[WebRTC] Peer connected {}:{} selectedIcePath={}",
                     peer->uuid,
                     peer->session,
                     webrtc::selectedIcePathName(selectedPath));
        return;
    }
    if (state == webrtc::ConnectionState::Disconnected) {
        int64_t expected = 0;
        peer->disconnectedSinceMs.compare_exchange_strong(
            expected,
            steadyNowMs(),
            std::memory_order_relaxed,
            std::memory_order_relaxed);
        spdlog::warn(
            "[WebRTC] Peer connection disconnected {}:{}; keeping session for ICE recovery",
            peer->uuid,
            peer->session);
        return;
    }
    if (state != webrtc::ConnectionState::Failed &&
        state != webrtc::ConnectionState::Closed) {
        return;
    }

    int64_t expected = 0;
    peer->disconnectedSinceMs.compare_exchange_strong(
        expected,
        steadyNowMs(),
        std::memory_order_relaxed,
        std::memory_order_relaxed);
    bool emitDirectFailure = false;
    {
        std::lock_guard<std::mutex> lock(peer->negotiationMutex);
        peer->transportRetired = true;
        if (!peer->directFailureNoticeEmitted) {
            emitDirectFailure = peer->activeIceMode == webrtc::IceMode::StunOnly ||
                peer->activeIceMode == webrtc::IceMode::HostOnly;
            peer->directFailureNoticeEmitted = emitDirectFailure;
        }
    }
    if (emitDirectFailure && !stopRequested_.load(std::memory_order_relaxed)) {
        emitRuntimeEvent(
            "Direct-only ICE failed; TURN was not enabled. Select Auto or Relay only and reconnect.",
            false);
    }
    spdlog::warn("[WebRTC] {} transport {}:{}; retaining logical session for {}ms",
                 state == webrtc::ConnectionState::Failed ? "Failed" : "Closed",
                 peer->uuid,
                 peer->session,
                 kDisconnectedPeerPruneMs);
    runQueuedPeerTransition(peer, "transport-retired");
}

void VersusApp::handlePeerDataChannelState(
    const std::shared_ptr<PeerSession> &peer,
    bool open,
    uint64_t) {
    if (!peer) {
        return;
    }
    peer->dataChannelOpen.store(open, std::memory_order_relaxed);
    recordPeerEvent(peer, open ? "datachannel-open" : "datachannel-closed");
    if (open) {
        peer->disconnectedSinceMs.store(0, std::memory_order_relaxed);
        if (!peer->initReceived.load(std::memory_order_relaxed)) {
            const int64_t graceMs = peer->roomMode
                ? kRoomInitGracePeriodMs
                : kDirectInitGracePeriodMs;
            peer->initDeadlineMs.store(
                steadyNowMs() + graceMs,
                std::memory_order_relaxed);
        }
        sendPeerDataInfo(peer, true);
        applyPeerMediaPlan(peer, "datachannel-open");
        return;
    }
    peer->initDeadlineMs.store(0, std::memory_order_relaxed);
    int64_t expected = 0;
    peer->disconnectedSinceMs.compare_exchange_strong(
        expected,
        steadyNowMs(),
        std::memory_order_relaxed,
        std::memory_order_relaxed);
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
            // VDO.Ninja cleanup/bye is UUID-scoped. A request-side session is
            // only a hint and may name a PeerConnection already replaced.
            peer = findPeerSessionForSignalLocked(uuid, {});
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
            // VDO.Ninja routes restart controls to the active UUID owner. The
            // supplied session may be stale and must not select the transport.
            peer = findPeerSessionForSignalLocked(uuid, {});
        }
        if (!peer) {
            spdlog::warn("[Signaling] No matching peer for ICE restart uuid={} session={}", uuid, session);
            return;
        }

        peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
        reservePeerAlphaAdmissionCutoff(peer);
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

        std::shared_ptr<PeerSession> existingPeer;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            // offerSDP is UUID-scoped in VDO.Ninja; request-side session values
            // are not publisher identity and cannot create another owner.
            existingPeer = findPeerSessionForSignalLocked(uuid, {});
        }
        if (existingPeer) {
            handleDuplicatePeerOfferRequest(existingPeer, "duplicate-offer-request");
            return;
        }

        // Echo the viewer-supplied session when the play request carries one
        // (VDO.Ninja receivers reply with the session our offer names, and
        // older receivers expect their own value back). Mint only when absent.
        const std::string resolvedSession =
            session.empty() ? generatePeerSessionId() : session;
        const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
        const std::string resolvedStreamId = lifecycleState.streamId.empty() ? streamId : lifecycleState.streamId;
        const std::string key = uuid;
        auto peer = std::make_shared<PeerSession>();
        peer->uuid = uuid;
        peer->session = resolvedSession;
        peer->activeWireSession = resolvedSession;
        peer->streamId = resolvedStreamId;
        peer->candidateType = "local";
        peer->createdAtMs = steadyNowMs();
        reservePeerAlphaAdmissionCutoff(peer);
        peer->lastStateChangeMs.store(peer->createdAtMs, std::memory_order_relaxed);
        peer->answerReceived = false;
        peer->roomMode = !lifecycleState.room.empty();
        peer->initReceived.store(false, std::memory_order_relaxed);
        peer->roleValid.store(false, std::memory_order_relaxed);
        peer->role.store(PeerRole::Unknown, std::memory_order_relaxed);
        {
            std::lock_guard<std::mutex> decisionLock(roomQualityDecisionMutex_);
            peer->assignedTier.store(StreamTier::None, std::memory_order_relaxed);
        }
        peer->videoEnabled.store(true, std::memory_order_relaxed);
        peer->audioEnabled.store(true, std::memory_order_relaxed);
        peer->initDeadlineMs.store(0, std::memory_order_relaxed);
        // Publish a stable client pointer with the logical reservation. The
        // object is initialized only after admission, under its operation lock.
        peer->client = std::make_unique<webrtc::WebRtcClient>();

        // Admission and reservation are one map operation. Initialization is
        // intentionally outside the map lock; duplicate requests observe the
        // reserved logical peer and no-op until its first offer is ready.
        std::shared_ptr<PeerSession> racedPeer;
        bool admitted = false;
        const int maxViewers = maxViewers_.load(std::memory_order_relaxed);
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            racedPeer = findPeerSessionForSignalLocked(uuid, {});
            if (!racedPeer && (maxViewers <= 0 || static_cast<int>(peerSessions_.size()) < maxViewers)) {
                admitted = peerSessions_.emplace(key, peer).second;
                if (admitted) {
                    int sameUuidOwnerCount = 0;
                    for (const auto &entry : peerSessions_) {
                        if (entry.second && entry.second->uuid == uuid) {
                            ++sameUuidOwnerCount;
                        }
                    }
                    for (const auto &entry : peerSessions_) {
                        if (entry.second && entry.second->uuid == uuid) {
                            const int previous = entry.second->uuidOwnerHighWatermark.load(
                                std::memory_order_relaxed);
                            entry.second->uuidOwnerHighWatermark.store(
                                std::max(previous, sameUuidOwnerCount),
                                std::memory_order_relaxed);
                        }
                    }
                }
                if (!admitted) {
                    const auto it = peerSessions_.find(key);
                    racedPeer = it == peerSessions_.end() ? nullptr : it->second;
                }
            }
        }
        if (racedPeer) {
            handleDuplicatePeerOfferRequest(
                racedPeer,
                "concurrent-duplicate-offer-request");
            return;
        }
        if (!admitted) {
            spdlog::warn("[Signaling] Viewer limit reached (max={}); rejecting {}:{}",
                         maxViewers,
                         uuid,
                         resolvedSession);
            return;
        }
        spdlog::info("[Signaling] Assigned publisher-owned wire session for uuid={}: {} requestHint={}",
                     uuid,
                     resolvedSession,
                     session.empty() ? "none" : "ignored");

        // Keep initialization and callback installation serialized with
        // teardown. A cleanup can arrive as soon as the logical peer is
        // reserved.
        std::unique_lock<std::recursive_mutex> initializationLock(peer->clientOperationMutex);
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            if (peer->removed) {
                return;
            }
        }
        webrtc::PeerConfig peerConfig;
        {
            std::lock_guard<std::mutex> lock(iceConfigMutex_);
            peerConfig.iceServers = resolvedIceServers_;
            peerConfig.iceMode = iceMode_;
            peerConfig.turnRegistry = resolvedTurnRegistry_;
        }
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            peer->activeIceMode = peerConfig.iceMode;
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
        // Reserve the optional alpha transceiver in the first offer. Adding it
        // behind an already-negotiated data m-line and then rebuilding a fresh
        // libdatachannel transport would reorder the m-lines on ICE recovery.
        // Keep it inactive until opt-in: a silent sendonly track can replace
        // the color track in an ordinary browser viewer's media element.
        peerConfig.reserveAlphaTrack = peerConfig.enableAlphaTrack;
        peerConfig.initialAlpha = false;
        peerConfig.videoWidth = std::max(1, videoState.config.width);
        peerConfig.videoHeight = std::max(1, videoState.config.height);
        peerConfig.videoFps = std::max(1, videoState.config.frameRate);
        if (!peer->client->initialize(peerConfig)) {
            spdlog::error("[WebRTC] Failed to initialize peer session {}:{}", uuid, resolvedSession);
            removePeerSession(peer, "peer-initialize-failed");
            return;
        }
        // Do not call into WebRtcClient while holding negotiationMutex. Some
        // client operations synchronously invoke callbacks which re-enter the
        // peer's negotiation state.
        const uint64_t initialClientTransportGeneration = peer->client->transportGeneration();
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            peer->clientTransportGeneration = initialClientTransportGeneration;
        }
        recordPeerEvent(peer, "session-created stream=" + resolvedStreamId);

        std::weak_ptr<PeerSession> weakPeer = peer;
        installPeerOperationCallbacks(peer);

        peer->client->setIceCandidateCallback([this, weakPeer](const std::string &candidate,
                                                                const std::string &mid,
                                                                int mlineIndex,
                                                                uint64_t clientTransportGeneration) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr || candidate.empty()) {
                return;
            }
            bool shouldSend = false;
            std::string uuidLocal;
            std::string sessionLocal;
            std::string typeLocal;
            {
                std::lock_guard<std::mutex> lock(peerPtr->negotiationMutex);
                if (peerPtr->removed ||
                    peerPtr->clientTransportGeneration != clientTransportGeneration) {
                    if (!peerPtr->removed) {
                        recordPeerEvent(peerPtr, "local-candidate-dropped retired-transport-generation");
                    }
                    return;
                }
                // Candidates belong to the ICE transport, not an offer
                // generation: a same-transport renegotiation keeps them valid.
                if (!peerPtr->offerDispatched) {
                    peerPtr->pendingCandidates.push_back({
                        candidate,
                        mid,
                        mlineIndex,
                        clientTransportGeneration});
                    recordPeerEvent(peerPtr, "local-candidate-buffered");
                } else {
                    shouldSend = true;
                    uuidLocal = peerPtr->uuid;
                    sessionLocal = peerPtr->activeWireSession;
                    typeLocal = peerPtr->candidateType;
                }
            }

            const std::string lowerCandidate = toLowerCopy(candidate);
            const bool relayCandidate =
                lowerCandidate.find(" typ relay") != std::string::npos;
            if (!shouldSend) {
                return;
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
                bool stillCurrent = false;
                {
                    std::lock_guard<std::mutex> negotiationLock(peerPtr->negotiationMutex);
                    stillCurrent = !peerPtr->removed &&
                        peerPtr->clientTransportGeneration == clientTransportGeneration &&
                        peerPtr->activeWireSession == sessionLocal &&
                        peerPtr->offerDispatched;
                }
                if (!stillCurrent) {
                    recordPeerEvent(peerPtr, "local-candidate-dropped superseded-transport");
                    return;
                }
                dispatchPeerCandidateToSignaling(peerPtr, cand, relayCandidate);
            }
        });

        peer->client->setKeyframeRequestCallback([this, weakPeer](uint64_t clientTransportGeneration) {
            auto peerPtr = weakPeer.lock();
            if (!peerPtr) {
                return;
            }
            {
                std::lock_guard<std::mutex> negotiationLock(peerPtr->negotiationMutex);
                if (peerPtr->removed ||
                    peerPtr->clientTransportGeneration != clientTransportGeneration) {
                    return;
                }
            }
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

        if (!peer->roomMode) {
            applyPeerInitState(peer, true, PeerRole::Viewer, true, true);
            peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
            reservePeerAlphaAdmissionCutoff(peer);
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
        }

        {
            std::lock_guard<std::mutex> lock(peer->negotiationMutex);
            peer->sessionInitializing = false;
        }
        initializationLock.unlock();

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
        std::string routedWireSession = answer.session;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peer = findPeerSessionForSignalLocked(answer.uuid, answer.session);
            if (!peer) {
                const auto activePeer = findPeerSessionForSignalLocked(answer.uuid, {});
                if (activePeer && !answer.session.empty()) {
                    spdlog::warn(
                        "[Signaling] Rejecting stale-session answer before SDP routing uuid={} session={}",
                        answer.uuid,
                        answer.session);
                    recordPeerEvent(activePeer, "answer-ignored stale-wire-session");
                } else {
                    spdlog::warn("[Signaling] No matching peer for answer uuid={} session={}",
                                 answer.uuid,
                                 answer.session);
                }
                return;
            }
            if (answer.session.empty()) {
                std::lock_guard<std::mutex> negotiationLock(
                    peer->negotiationMutex);
                routedWireSession = peer->activeWireSession;
                if (peer->removed || routedWireSession.empty() ||
                    routedWireSession != peer->session) {
                    const std::string answerSdpSha256 =
                        detail::sha256Hex(answer.sdp);
                    spdlog::warn(
                        "[Signaling] Rejecting publisher WebSocket answer reason=missing-session uuid={} source=signaling-wss receivedSession=missing activeSession={} answerSdpSha256={}",
                        answer.uuid,
                        routedWireSession,
                        answerSdpSha256);
                    recordPeerEvent(
                        peer,
                        "answer-ignored missing-wire-session sha256=" +
                            answerSdpSha256);
                    return;
                }
            }
        }

        // A sessionless initial response is retained for VDO.Ninja
        // compatibility, but bind it to the exact wire session observed above
        // so a concurrent transport rotation cannot retarget it.
        applyPeerAnswer(peer, answer.sdp, "signaling-wss", routedWireSession);
    });

    signaling_.onCandidate([this](const signaling::SignalCandidate &cand) {
        if (cand.candidate.empty()) {
            return;
        }

        std::shared_ptr<PeerSession> peer;
        signaling::SignalCandidate routedCandidate = cand;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peer = findPeerSessionForSignalLocked(cand.uuid, cand.session);
            if (peer && cand.session.empty()) {
                std::lock_guard<std::mutex> negotiationLock(
                    peer->negotiationMutex);
                routedCandidate.session = peer->activeWireSession;
                if (peer->removed || routedCandidate.session.empty() ||
                    routedCandidate.session != peer->session) {
                    const std::string candidateSha256 =
                        detail::sha256Hex(cand.candidate);
                    spdlog::warn(
                        "[Signaling] Rejecting publisher WebSocket remote ICE candidate reason=missing-session uuid={} source=signaling-wss receivedSession=missing activeSession={} candidateSha256={}",
                        cand.uuid,
                        routedCandidate.session,
                        candidateSha256);
                    recordPeerEvent(
                        peer,
                        "remote-candidate-dropped missing-wire-session sha256=" +
                            candidateSha256);
                    return;
                }
            }
            if (!peer || !peer->client) {
                const auto activePeer = findPeerSessionForSignalLocked(cand.uuid, {});
                if (activePeer && !cand.session.empty()) {
                    std::string activeWireSession;
                    {
                        std::lock_guard<std::mutex> negotiationLock(
                            activePeer->negotiationMutex);
                        activeWireSession = activePeer->activeWireSession;
                    }
                    const std::string candidateSha256 =
                        detail::sha256Hex(cand.candidate);
                    spdlog::warn(
                        "[Signaling] Rejecting stale-session remote ICE candidate before content routing uuid={} session={} activeSession={} source=signaling-wss sha256={}",
                        cand.uuid,
                        cand.session,
                        activeWireSession,
                        candidateSha256);
                    recordPeerEvent(
                        activePeer,
                        "remote-candidate-dropped stale-wire-session sha256=" +
                            candidateSha256);
                    return;
                }
                queuePendingRemoteCandidateLocked(routedCandidate, steadyNowMs());
                return;
            }
        }

        // As with answers, attaching the observed initial wire session closes
        // the validation-to-routing race if the transport rotates now.
        handlePeerRemoteCandidate(peer, routedCandidate, "signaling");
    });
}

bool VersusApp::isControlMessageAuthorized(const std::shared_ptr<PeerSession> &peer, const std::string &token) const {
    if (peer &&
        peer->roomMode &&
        peer->roleValid.load(std::memory_order_relaxed) &&
        peer->role.load(std::memory_order_relaxed) == PeerRole::Director) {
        return remoteControlEnabled_.load(std::memory_order_relaxed);
    }

    if (!remoteControlEnabled_.load(std::memory_order_relaxed)) {
        return false;
    }
    const std::string remoteControlToken = lifecycleStateSnapshot().remoteControlToken;
    if (remoteControlToken.empty()) {
        return true;
    }
    return token == remoteControlToken;
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

    std::lock_guard<std::mutex> controlLock(runtimeVideoControlMutex_);
    // Declare before lock so the retired pipeline is destroyed after unlocking.
    std::unique_ptr<video::VideoEncoder> replacement;
    std::unique_lock<std::mutex> lock(videoSendMutex_);
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
            const auto cachedFrame = getCachedVideoFrame();
            if (cachedFrame && cachedFrame->width > 0 && cachedFrame->height > 0) {
                captureWidth = cachedFrame->width;
                captureHeight = cachedFrame->height;
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
    const auto activeEncoder = videoEncoder_.activeEncoderName();
    const bool prepareReplacement =
        !usesVp9AlphaTrack(previousConfig) &&
        previousConfig.codec == video::VideoCodec::H264 &&
        (activeEncoder == "FFmpeg h264_qsv" || activeEncoder == "FFmpeg h264_nvenc");
    if (prepareReplacement) {
        const auto revision = videoEncoder_.configurationRevision();
        const auto nextPrimaryConfig = primaryVideoEncoderConfig(nextConfig);
        replacement = std::make_unique<video::VideoEncoder>();
        spdlog::info("[App] Preparing runtime encoder replacement while streaming: {}x{} @{}fps {}kbps",
                     nextConfig.width, nextConfig.height, nextConfig.frameRate, nextConfig.bitrate);
        lock.unlock();
        const auto preparationFrame = getCachedVideoFrame();
        const bool prime = preparationFrame && nextPrimaryConfig.bFrames == 0 && nextPrimaryConfig.ffmpegOptions.empty();
        detail::FrameTrace::instance().record("prepare-start", nullptr, 0);
        const bool ready = replacement->initialize(nextPrimaryConfig, prime ? preparationFrame.get() : nullptr);
        detail::FrameTrace::instance().record("prepare-ready", nullptr, ready ? 1 : 0);
        lock.lock();
        if (!ready || !capturing_ || videoConfig_ != previousConfig ||
            videoEncoder_.configurationRevision() != revision) {
            spdlog::warn("[App] Runtime encoder replacement {}. Keeping current pipeline",
                         ready ? "became stale during preparation" : "failed preparation");
            return false;
        }
        // Only a successfully checked pipeline with isolated preparation may take over. Its old
        // counterpart is retired after releasing videoSendMutex_, so process
        // drain/termination cannot pause the new output worker.
        videoEncoder_.swapPipeline(*replacement);
        detail::FrameTrace::instance().record("handover", nullptr, 0);
        activeHqWidth_ = std::max(2, nextConfig.width & ~1);
        activeHqHeight_ = std::max(2, nextConfig.height & ~1);
        lastHqReconfigureMs_ = steadyNowMs();
        hqAspectLocked_ = false;
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        spdlog::info("[App] Runtime encoder replacement committed");
    } else if (requiresReinit) {
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

    const bool roomQualityRoutingChanged =
        usesVp9AlphaTrack(videoConfig_) != usesVp9AlphaTrack(nextConfig);
    videoConfig_ = nextConfig;
    if (fpsChanged && spoutCapture_.isCapturing()) {
        spoutCapture_.setFrameRate(nextConfig.frameRate);
    }
    if (fpsChanged && windowCapture_.isCapturing()) {
        windowCapture_.setFrameRate(nextConfig.frameRate);
    }
    if (roomQualityRoutingChanged) {
        updateRoomQualityDecisionForCodecLocked();
    }
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

RoomQualityDecision VersusApp::syncRoomQualityDecision() {
    std::function<void()> beforeDecisionCommit;
    {
        std::lock_guard<std::mutex> hookLock(roomQualitySyncTestHookMutex_);
        beforeDecisionCommit = beforeRoomQualityDecisionCommitForTesting_;
    }
    bool enteredCodecUnavailable = false;
    video::VideoCodec committedCodec = video::VideoCodec::H264;
    uint64_t committedGeneration = 0;
    RoomQualityDecision next;
    {
        // Room-quality transitions serialize behind the video path. The nested
        // order is video -> lifecycle snapshot -> decision -> peer sessions.
        std::lock_guard<std::mutex> videoLock(videoSendMutex_);
        const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
        const bool requested = lifecycleState.startOptions.roomModeLqEnabled;
        committedCodec = videoConfig_.codec;

        if (beforeDecisionCommit) {
            beforeDecisionCommit();
        }

        next = commitRoomQualityDecisionLocked(
            lifecycleState.room,
            requested,
            &enteredCodecUnavailable,
            &committedGeneration);
        if (!next.effective) {
            shutdownLqEncoderLocked();
        }
    }

    emitRoomQualityCodecUnavailable({
        enteredCodecUnavailable,
        committedCodec,
        committedGeneration});
    return next;
}

RoomQualityDecision VersusApp::commitRoomQualityDecisionLocked(
    const std::string &activeRoom,
    bool requested,
    bool *enteredCodecUnavailable,
    uint64_t *committedGeneration) {
    // The caller owns videoSendMutex_. Keep the authoritative codec, decision,
    // alpha routing, and cached peer tiers coherent until that lock is released.
    const bool roomMode = !activeRoom.empty();
    const video::VideoCodec codec = videoConfig_.codec;
    const RoomQualityDecision next = resolveRoomQualityDecision(
        roomMode,
        requested,
        codec == video::VideoCodec::H264);

    bool entered = false;
    {
        std::lock_guard<std::mutex> decisionLock(roomQualityDecisionMutex_);
        entered =
            next.reason == RoomQualityReason::CodecNotH264 &&
            (roomQualityState_.decision.reason != RoomQualityReason::CodecNotH264 ||
             roomQualityState_.codec != codec);
        ++roomQualityState_.generation;
        roomQualityState_.activeRoom = activeRoom;
        roomQualityState_.roomMode = roomMode;
        roomQualityState_.codec = codec;
        roomQualityState_.alphaWorkflowEnabled = usesVp9AlphaTrack(videoConfig_);
        roomQualityState_.decision = next;
        refreshRoomQualityPeerTiersLocked(next);
        if (committedGeneration) {
            *committedGeneration = roomQualityState_.generation;
        }
    }

    if (enteredCodecUnavailable) {
        *enteredCodecUnavailable = entered;
    }
    return next;
}

RoomQualityDecision VersusApp::updateRoomQualityDecisionForCodecLocked(
    bool *enteredCodecUnavailable,
    uint64_t *committedGeneration) {
    // Caller owns videoSendMutex_; lifecycle is a short inner snapshot.
    const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
    const RoomQualityDecision next = commitRoomQualityDecisionLocked(
        lifecycleState.room,
        lifecycleState.startOptions.roomModeLqEnabled,
        enteredCodecUnavailable,
        committedGeneration);
    if (!next.effective) {
        shutdownLqEncoderLocked();
    }
    return next;
}

RoomQualityDecision VersusApp::roomQualityDecisionSnapshot() const {
    std::lock_guard<std::mutex> lock(roomQualityDecisionMutex_);
    return roomQualityState_.decision;
}

bool VersusApp::lqRoutingAllowedLocked(
    const RoomQualityDecision &decision) const {
    // Caller owns videoSendMutex_ then roomQualityDecisionMutex_. This is the
    // single admission predicate for both routing and the LQ encoder backend.
    return decision.effective &&
        videoConfig_.codec == video::VideoCodec::H264 &&
        roomQualityState_.codec == video::VideoCodec::H264 &&
        videoConfig_.codec == roomQualityState_.codec;
}

StreamTier VersusApp::roomQualityPeerTierLocked(
    const std::shared_ptr<PeerSession> &peer,
    const RoomQualityDecision &decision,
    bool lqRoutingAllowed) const {
    if (!peer) {
        return StreamTier::None;
    }
    const StreamTier policyTier = assignStreamTier(
        peer->roomMode,
        decision.effective && lqRoutingAllowed,
        peer->roleValid.load(std::memory_order_relaxed),
        peer->role.load(std::memory_order_relaxed));
    const bool alphaReceiverNeedsHq =
        roomQualityState_.alphaWorkflowEnabled &&
        peer->alphaAllowed.load(std::memory_order_relaxed);
    return selectEffectiveStreamTier(policyTier, alphaReceiverNeedsHq);
}

void VersusApp::refreshRoomQualityPeerTiersLocked(
    const RoomQualityDecision &decision) {
    // Caller owns videoSendMutex_ and roomQualityDecisionMutex_.
    const bool lqRoutingAllowed = lqRoutingAllowedLocked(decision);
    std::lock_guard<std::mutex> peersLock(peerSessionsMutex_);
    for (const auto &entry : peerSessions_) {
        const auto &peer = entry.second;
        if (!peer) {
            continue;
        }
        peer->assignedTier.store(
            roomQualityPeerTierLocked(peer, decision, lqRoutingAllowed),
            std::memory_order_relaxed);
    }
}

void VersusApp::emitRoomQualityCodecUnavailable(
    const RoomQualityWarningTicket &ticket) {
    if (!ticket.pending) {
        return;
    }
    {
        std::lock_guard<std::mutex> decisionLock(roomQualityDecisionMutex_);
        if (roomQualityState_.generation != ticket.generation ||
            roomQualityState_.activeRoom.empty() ||
            roomQualityState_.codec != ticket.codec ||
            roomQualityState_.decision.reason != RoomQualityReason::CodecNotH264) {
            return;
        }
    }
    emitRuntimeEvent(
        std::string("Room Quality is unavailable with ") +
            videoCodecName(ticket.codec) +
            "; continuing HQ-only without changing the selected codec or alpha workflow.",
        false);
}

VersusApp::RoomQualityWarningTicket VersusApp::transitionRoomQualityLifecycle(
    const StartOptions *activationOptions,
    const std::string &sessionSalt) {
    std::function<void()> duringLifecycleMutation;
    std::function<void()> afterLifecycleMutation;
    {
        std::lock_guard<std::mutex> hookLock(roomQualityArchitectureTestHookMutex_);
        duringLifecycleMutation = duringRoomQualityLifecycleMutationForTesting_;
        afterLifecycleMutation = afterRoomQualityLifecycleMutationForTesting_;
    }

    RoomQualityWarningTicket warning;
    RoomQualityDecision next;
    {
        std::unique_lock<std::mutex> videoLock(videoSendMutex_);
        {
            std::unique_lock<std::mutex> lifecycleLock(lifecycleStateMutex_);
            if (activationOptions) {
                startOptions_ = *activationOptions;
                room_ = activationOptions->room;
                password_ = activationOptions->password;
                salt_ = sessionSalt;
                remoteControlToken_ = activationOptions->remoteControlToken;
            } else {
                room_.clear();
                startOptions_.room.clear();
            }
            if (duringLifecycleMutation) {
                duringLifecycleMutation();
            }

            next = commitRoomQualityDecisionLocked(
                room_,
                startOptions_.roomModeLqEnabled,
                &warning.pending,
                &warning.generation);
            warning.codec = videoConfig_.codec;
        }
        if (!next.effective) {
            shutdownLqEncoderLocked();
        }
    }

    if (afterLifecycleMutation) {
        afterLifecycleMutation();
    }
    return warning;
}

void VersusApp::applyPeerInitState(const std::shared_ptr<PeerSession> &peer,
                                   bool roleValid,
                                   PeerRole role,
                                   bool videoEnabled,
                                   bool audioEnabled) {
    if (!peer) {
        return;
    }
    std::lock_guard<std::recursive_mutex> initLock(peer->initStateMutex);

    peer->roleValid.store(roleValid, std::memory_order_relaxed);
    peer->role.store(role, std::memory_order_relaxed);
    peer->videoEnabled.store(videoEnabled, std::memory_order_relaxed);
    peer->audioEnabled.store(audioEnabled, std::memory_order_relaxed);

    if (peer->roomMode) {
        const bool initReady = roleValid;
        StreamTier tier = StreamTier::None;
        {
            std::lock_guard<std::mutex> videoLock(videoSendMutex_);
            std::lock_guard<std::mutex> decisionLock(roomQualityDecisionMutex_);
            tier = roomQualityPeerTierLocked(
                peer,
                roomQualityState_.decision,
                lqRoutingAllowedLocked(roomQualityState_.decision));
            peer->assignedTier.store(tier, std::memory_order_relaxed);
        }
        peer->initReceived.store(initReady, std::memory_order_relaxed);
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

bool VersusApp::applyPeerInitFallbackIfPending(const std::shared_ptr<PeerSession> &peer,
                                               bool videoEnabled,
                                               bool audioEnabled) {
    if (!peer) {
        return false;
    }
    std::lock_guard<std::recursive_mutex> initLock(peer->initStateMutex);
    if (peer->initReceived.load(std::memory_order_relaxed)) {
        return false;
    }
    applyPeerInitState(peer, true, PeerRole::Viewer, videoEnabled, audioEnabled);
    return true;
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

        if (!applyPeerInitFallbackIfPending(peer, true, true)) {
            continue;
        }
        if (peer->roomMode) {
            const StreamTier fallbackTier = peer->assignedTier.load(std::memory_order_relaxed);
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
        applyPeerMediaPlan(peer, peer->roomMode ? "room-init-fallback" : "direct-init-fallback");
        sendPeerDataInfo(peer, true);
    }
}

bool VersusApp::ensureLqEncoderInitializedLocked() {
    bool lqRoutingAllowed = false;
    {
        std::lock_guard<std::mutex> decisionLock(roomQualityDecisionMutex_);
        lqRoutingAllowed = lqRoutingAllowedLocked(roomQualityState_.decision);
    }
    if (!lqRoutingAllowed) {
        shutdownLqEncoderLocked();
        return false;
    }
    if (lqEncoderInitialized_.load(std::memory_order_relaxed)) {
        return true;
    }
    std::function<bool()> beforeLqInitialize;
    {
        std::lock_guard<std::mutex> hookLock(roomQualityArchitectureTestHookMutex_);
        beforeLqInitialize = beforeLqEncoderInitializeForTesting_;
    }
    if (beforeLqInitialize && !beforeLqInitialize()) {
        return false;
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

    std::lock_guard<std::mutex> infoSendLock(peer->dataInfoSendMutex);
    if (!peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
    const PeerRole peerRole = peer->role.load(std::memory_order_relaxed);
    const bool roleValid = peer->roleValid.load(std::memory_order_relaxed);
    const bool initReceived = peer->initReceived.load(std::memory_order_relaxed);
    const bool videoEnabled = peer->videoEnabled.load(std::memory_order_relaxed);
    const bool audioEnabled = peer->audioEnabled.load(std::memory_order_relaxed);
    const VideoStateSnapshot videoState = videoStateSnapshot();
    const int requestedVideoBitrate = peer->requestedVideoBitrateKbps.load(std::memory_order_relaxed);
    RoomQualityDecision roomQuality;
    StreamTier assignedTier = StreamTier::None;
    bool alphaReceiverUsesHq = false;
    {
        std::lock_guard<std::mutex> videoLock(videoSendMutex_);
        std::lock_guard<std::mutex> decisionLock(roomQualityDecisionMutex_);
        roomQuality = roomQualityState_.decision;
        const StreamTier policyTier = assignStreamTier(
            peer->roomMode,
            roomQuality.effective,
            roleValid,
            peerRole);
        assignedTier = roomQualityPeerTierLocked(
            peer,
            roomQuality,
            lqRoutingAllowedLocked(roomQuality));
        alphaReceiverUsesHq =
            videoEnabled &&
            policyTier == StreamTier::LQ &&
            assignedTier == StreamTier::HQ;
        peer->assignedTier.store(assignedTier, std::memory_order_relaxed);
    }

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

    info["label"] = lifecycleState.startOptions.label;
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
    info["room_init"] = !lifecycleState.room.empty();
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
    info["room_quality_requested"] = roomQuality.requested;
    info["room_quality_effective"] = roomQuality.effective;
    info["room_quality_reason"] = roomQualityReasonName(roomQuality.reason);
    info["requested_video_bitrate_kbps"] = requestedVideoBitrate;
    info["requested_audio_bitrate_kbps"] = peer->requestedAudioBitrateKbps.load(std::memory_order_relaxed);
    info["audio_source"] = audioSourceModeName(lifecycleState.audioSourceMode);
    const bool additionalMicrophoneActive =
        lifecycleState.includeMicrophone &&
        lifecycleState.audioSourceMode != AudioSourceMode::DefaultMicrophone &&
        lifecycleState.activeMicrophoneSourceName != "none";
    info["include_microphone"] = additionalMicrophoneActive;
    info["additional_audio_source"] = additionalMicrophoneActive
        ? lifecycleState.activeMicrophoneSourceName
        : "none";
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
            roomQuality.effective &&
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

    const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
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
    const RoomQualityDecision roomQuality = roomQualityDecisionSnapshot();
    const int roomOnlyTier =
        roomQuality.effective &&
                counts.roomGuests > 0 &&
                counts.roomScenes == 0 &&
                counts.roomNonGuestViewers == 0 &&
                counts.hq == 0
            ? 2
            : 0;

    nlohmann::json stats;
    stats["label"] = lifecycleState.startOptions.label.empty()
        ? "Game Capture"
        : lifecycleState.startOptions.label;
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
    stats["room_quality_requested"] = roomQuality.requested;
    stats["room_quality_effective"] = roomQuality.effective;
    stats["room_quality_reason"] = roomQualityReasonName(roomQuality.reason);
    stats["peers"] = counts.total;
    stats["active_video"] = counts.activeVideo;
    stats["active_audio"] = counts.activeAudio;

    const std::string key = lifecycleState.streamId.empty()
        ? std::string("game-capture")
        : lifecycleState.streamId;
    nlohmann::json msg;
    msg["remoteStats"][key] = stats;
    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::sendPeerAudioOptions(const std::shared_ptr<PeerSession> &peer) {
    if (!peer || !peer->client || !peer->client->isDataChannelOpen()) {
        return;
    }

    const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
    nlohmann::json options = nlohmann::json::array();
    if (lifecycleState.audioSourceMode != AudioSourceMode::None || lifecycleState.includeMicrophone) {
        std::string microphoneLabel = lifecycleState.activeMicrophoneSourceName;
        std::string microphoneDeviceId = lifecycleState.microphoneDeviceId;
        if (microphoneLabel == "default-microphone" ||
            microphoneLabel == "selected-microphone" ||
            microphoneLabel.empty()) {
            const auto devices = microphoneAudioCapture_.GetInputDevices();
            for (const auto &device : devices) {
                if ((!microphoneDeviceId.empty() && device.id == microphoneDeviceId) ||
                    (microphoneDeviceId.empty() && device.isDefault)) {
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
        switch (lifecycleState.audioSourceMode) {
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
                label = lifecycleState.includeMicrophone ? microphoneLabel : "";
                break;
        }
        if (lifecycleState.includeMicrophone &&
            lifecycleState.audioSourceMode != AudioSourceMode::DefaultMicrophone &&
            lifecycleState.audioSourceMode != AudioSourceMode::None) {
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

    const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
    const std::string selectedWindowId = lifecycleState.selectedWindowId;
    nlohmann::json devices = nlohmann::json::array();
    devices.push_back({
        {"deviceId", selectedWindowId.empty() ? "game-capture-window" : selectedWindowId},
        {"kind", "videoinput"},
        {"label", "Game Capture window"},
        {"groupId", "game-capture"}
    });

    const bool microphoneAvailable =
        lifecycleState.audioSourceMode == AudioSourceMode::DefaultMicrophone ||
        lifecycleState.includeMicrophone;
    if (microphoneAvailable) {
        const auto inputDevices = microphoneAudioCapture_.GetInputDevices();
        for (const auto &device : inputDevices) {
            devices.push_back({
                {"deviceId", device.id.empty() ? "default" : device.id},
                {"kind", "audioinput"},
                {"label", device.name.empty() ? "Microphone/input device" : device.name},
                {"groupId", device.isDefault ? "default-audioinput" : "audioinput"}
            });
        }
    }

    nlohmann::json msg;
    msg["UUID"] = peer->uuid;
    msg["mediaDevices"] = devices;
    peer->client->sendDataMessage(msg.dump());
}

void VersusApp::sendPeerConnectionMap(
    const std::shared_ptr<PeerSession> &requestingPeer,
    const nlohmann::json &request,
    bool authorized) {
    if (!requestingPeer || !requestingPeer->client ||
        !requestingPeer->client->isDataChannelOpen()) {
        return;
    }

    const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
    const std::string sourceStreamId = lifecycleState.streamId.empty()
        ? std::string("game-capture")
        : lifecycleState.streamId;
    const std::string sourceLabel = lifecycleState.startOptions.label.empty()
        ? sourceStreamId
        : lifecycleState.startOptions.label;
    const bool microphoneAvailable =
        lifecycleState.audioSourceMode == AudioSourceMode::DefaultMicrophone ||
        lifecycleState.includeMicrophone;

    nlohmann::json connectionMap;
    connectionMap["status"] = authorized ? "ok" : "rejected";
    connectionMap["uuid"] = sourceStreamId;
    connectionMap["streamID"] = sourceStreamId;
    connectionMap["label"] = sourceLabel;
    connectionMap["browser"] = std::string("Game Capture ") + APP_VERSION;
    connectionMap["runtime"] = {
        {"name", "Game Capture Native Qt"},
        {"version", APP_VERSION},
#if defined(_WIN32)
        {"platform", "Windows"}
#else
        {"platform", "Unknown"}
#endif
    };
    connectionMap["source"] = {
        {"streamID", sourceStreamId},
        {"type", videoSourceModeName(lifecycleState.videoSourceMode)},
        {"label", sourceLabel},
        {"sourceId", lifecycleState.selectedWindowId},
        {"capturing", capturing_.load(std::memory_order_relaxed)}
    };
    // The UUID carried in the request identifies the requested guest from the
    // director's side. The peer UUID here is the director identity as observed
    // by Game Capture, which is what VDO.Ninja uses to join this edge back to
    // the director node.
    connectionMap["requesterUUID"] = requestingPeer->uuid;
    if (request.contains("meshRequestId")) {
        connectionMap["meshRequestId"] = request["meshRequestId"];
    }

    connectionMap["capabilities"] = {
        {"videoTrack", true},
        {"audioTrack", lifecycleState.audioSourceMode != AudioSourceMode::None ||
                           lifecycleState.includeMicrophone},
        {"microphone", microphoneAvailable},
        {"whip", false},
        {"whipRestart", false},
        {"recoveryActions", nlohmann::json::array({"refreshConnection", "refreshAll"})}
    };
    connectionMap["whip"] = {
        {"active", false},
        {"restartSupported", false}
    };
    connectionMap["connections"] = nlohmann::json::array();

    if (!authorized) {
        connectionMap["reason"] = "unauthorized";
        connectionMap["message"] = "Connection diagnostics are only available to the room director.";
        requestingPeer->rejectedControlCount.fetch_add(1, std::memory_order_relaxed);
        recordPeerEvent(requestingPeer, "rejected-control getConnectionMap");
    } else {
        std::vector<std::shared_ptr<PeerSession>> peers;
        {
            std::lock_guard<std::mutex> lock(peerSessionsMutex_);
            peers.reserve(peerSessions_.size());
            for (const auto &entry : peerSessions_) {
                if (entry.second) {
                    peers.push_back(entry.second);
                }
            }
        }

        for (const auto &peer : peers) {
            if (!peer) {
                continue;
            }

            webrtc::ConnectionState state = webrtc::ConnectionState::Disconnected;
            webrtc::SelectedIcePath selectedPath = webrtc::SelectedIcePath::Unknown;
            bool activeVideoTrack = false;
            bool activeAudioTrack = false;
            {
                std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
                if (peer->client) {
                    state = peer->client->connectionState();
                    selectedPath = peer->client->selectedIcePath();
                    activeVideoTrack = peer->client->hasActiveVideoTrack();
                    activeAudioTrack = peer->client->hasActiveAudioTrack();
                }
            }

            const char *candidateType = "unknown";
            switch (selectedPath) {
                case webrtc::SelectedIcePath::Host:
                    candidateType = "host";
                    break;
                case webrtc::SelectedIcePath::Stun:
                    candidateType = "srflx";
                    break;
                case webrtc::SelectedIcePath::TurnRelay:
                    candidateType = "relay";
                    break;
                case webrtc::SelectedIcePath::Unknown:
                default:
                    break;
            }

            nlohmann::json connection = {
                {"peerUUID", peer->uuid},
                {"peerStreamID", peer->uuid},
                {"direction", "outgoing"},
                {"state", connectionStateName(state)},
                {"iceState", connectionStateName(state)},
                {"candidateType", candidateType},
                {"icePath", webrtc::selectedIcePathName(selectedPath)},
                {"transport", "webrtc"},
                {"bandwidth", -1},
                {"audioEnabled", peer->audioEnabled.load(std::memory_order_relaxed) &&
                                     activeAudioTrack},
                {"videoEnabled", peer->videoEnabled.load(std::memory_order_relaxed) &&
                                     activeVideoTrack},
                {"bytesSent", peer->videoBytesSent.load(std::memory_order_relaxed) +
                                  peer->audioBytesSent.load(std::memory_order_relaxed)},
                {"bytesReceived", 0},
                {"videoBytesSent", peer->videoBytesSent.load(std::memory_order_relaxed)},
                {"videoFramesSent", peer->videoFramesSent.load(std::memory_order_relaxed)},
                {"audioBytesSent", peer->audioBytesSent.load(std::memory_order_relaxed)},
                {"audioPacketsSent", peer->audioPacketsSent.load(std::memory_order_relaxed)},
                {"receiveTrafficSupported", false},
                {"nackCount", 0},
                {"pliCount", 0}
            };
            connectionMap["connections"].push_back(std::move(connection));
        }
    }

    nlohmann::json response;
    response["connectionMap"] = std::move(connectionMap);
    if (request.contains("meshRequestId")) {
        response["meshRequestId"] = request["meshRequestId"];
    }
    if (!authorized) {
        response["rejected"] = "getConnectionMap";
        response["reason"] = "unauthorized";
        response["message"] = "Connection diagnostics are only available to the room director.";
    }

    const bool sent = requestingPeer->client->sendDataMessage(response.dump());
    if (sent) {
        spdlog::info("[App] Sent source-specific connection map to {}:{} source={} status={}",
                     requestingPeer->uuid,
                     requestingPeer->session,
                     sourceStreamId,
                     authorized ? "ok" : "rejected");
    } else {
        spdlog::warn("[App] Failed to send connection map to {}:{} source={} status={}",
                     requestingPeer->uuid,
                     requestingPeer->session,
                     sourceStreamId,
                     authorized ? "ok" : "rejected");
    }
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
        msg["reason"] = "unsupported";
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
        reservePeerAlphaAdmissionCutoff(peer);
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

        const bool alphaFieldPresent = info.contains("alpha_receive");
        std::string alphaReceiveMode;
        if (alphaFieldPresent && info["alpha_receive"].is_string()) {
            alphaReceiveMode = info["alpha_receive"].get<std::string>();
        }
        if (alphaFieldPresent) {
            const bool alphaAllowed = alphaReceiveMode == "vp9-dualtrack-v1";
            const bool previousAlphaAllowed = peer->alphaAllowed.load(std::memory_order_relaxed);
            peer->alphaAllowed.store(alphaAllowed, std::memory_order_relaxed);
            if (alphaAllowed && !previousAlphaAllowed) {
                // Do not replay a completed pair from before capability was
                // acknowledged; that peer has already consumed newer primary
                // RTP timestamps without alpha.
                reservePeerAlphaAdmissionCutoff(peer);
                peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
            }
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
                    // The native receiver may reject the inactive section in
                    // its first answer. Start a fresh transport on capability
                    // changes so both ends install the active track together.
                    if (usesVp9AlphaTrack(videoStateSnapshot().config)) {
                        sendPeerOffer(peer, "peer-alpha-capability", true);
                    } else {
                        applyPeerMediaPlan(peer, "peer-alpha-capability");
                    }
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
    const bool sharedControlAuthorized = directorAuthorized
        ? remoteControlEnabled_.load(std::memory_order_relaxed)
        : controlAuthorized;
    auto sendRejectedControl = [this, &peer](const char *rejectedName,
                                             const char *reason,
                                             const char *message) {
        nlohmann::json rejected;
        rejected["rejected"] = rejectedName;
        rejected["reason"] = reason;
        if (message && *message) {
            rejected["message"] = message;
        }
        peer->rejectedControlCount.fetch_add(1, std::memory_order_relaxed);
        recordPeerEvent(peer, std::string("rejected-control ") + (rejectedName ? rejectedName : "unknown"));
        spdlog::warn("[App] Sending rejected control {} to {}:{} reason={} message={}",
                     rejectedName ? rejectedName : "unknown",
                     peer->uuid,
                     peer->session,
                     reason ? reason : "unknown",
                     message ? message : "");
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
        const std::string streamId = lifecycleStateSnapshot().streamId;
        const std::string nativeStatsKey = streamId.empty() ? std::string("game-capture") : streamId;
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
        if (!sharedControlAuthorized) {
            spdlog::warn("[App] Ignoring unauthorized requestAs control from {} for '{}'",
                         peer->uuid,
                         requestAsTarget);
            const char *rejectedName = msg.contains("targetBitrate")
                ? "targetBitrate"
                : (msg.contains("optimizedBitrate")
                       ? "optimizedBitrate"
                       : (msg.contains("targetAudioBitrate")
                              ? "targetAudioBitrate"
                              : "requestResolution"));
            const bool anonymousResolutionHint =
                std::string(rejectedName) == "requestResolution" &&
                !shouldReportUnauthorizedResolutionControl(
                    directorAuthorized,
                    !controlToken.empty());
            if (anonymousResolutionHint) {
                recordPeerEvent(peer, "ignored-viewer-resolution-hint");
                spdlog::debug(
                    "[App] Silently ignored anonymous viewer resolution hint from {}:{}",
                    peer->uuid,
                    peer->session);
            } else {
                sendRejectedControl(
                    rejectedName,
                    "unauthorized",
                    "This shared-stream control is not authorized.");
            }
            return;
        }
    }

    if (msg.contains("hangup")) {
        if (!controlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized VDO hangup from {}", peer->uuid);
            sendRejectedControl("hangup", "unauthorized", "Remote hangup is not authorized.");
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
            if (audioSettingsRequested) {
                sendRejectedControl(
                    "getAudioSettings",
                    "unauthorized",
                    "Audio settings are only available to the room director.");
            }
            if (videoSettingsRequested) {
                sendRejectedControl(
                    "getVideoSettings",
                    "unauthorized",
                    "Video settings are only available to the room director.");
            }
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
        if (!directorAuthorized || !sharedControlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized refreshMicrophone from {}", peer->uuid);
            sendRejectedControl(
                "refreshMicrophone",
                "unauthorized",
                "Remote microphone refresh is not authorized.");
        } else {
            sendPeerAudioOptions(peer);
            sendPeerMediaDevices(peer);
        }
    }
    if (msg.contains("refreshVideo")) {
        if (!controlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized refreshVideo from {}", peer->uuid);
            sendRejectedControl("refreshVideo", "unauthorized", "Remote video refresh is not authorized.");
        } else {
            sendPeerVideoOptions(peer);
            sendPeerMediaDevices(peer);
        }
    }
    if (msg.contains("changeCamera")) {
        if (!directorAuthorized || !sharedControlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized changeCamera from {}", peer->uuid);
            sendRejectedControl("changeCamera", "unauthorized", "Remote camera changes are not authorized.");
        } else {
            const std::string deviceId = msg["changeCamera"].is_string() ? msg["changeCamera"].get<std::string>() : "";
            const std::string selectedWindowId = lifecycleStateSnapshot().selectedWindowId;
            const std::string currentWindowDeviceId = selectedWindowId.empty()
                ? "game-capture-window"
                : selectedWindowId;
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
        if (!directorAuthorized || !sharedControlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized changeMicrophone from {}", peer->uuid);
            sendRejectedControl(
                "changeMicrophone",
                "unauthorized",
                "Remote microphone changes are not authorized.");
        } else {
            const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
            const bool microphoneAvailable =
                lifecycleState.audioSourceMode == AudioSourceMode::DefaultMicrophone ||
                lifecycleState.includeMicrophone;
            const std::string currentDeviceId = lifecycleState.microphoneDeviceId.empty()
                ? std::string("default")
                : lifecycleState.microphoneDeviceId;
            const bool sameDevice =
                microphoneAvailable &&
                (deviceId.empty() || deviceId == currentDeviceId);
            sendPeerMediaDeviceChange(
                peer,
                "microphone",
                sameDevice,
                deviceId,
                sameDevice
                    ? ""
                    : (microphoneAvailable
                           ? "Changing microphone devices live from VDO.Ninja Control Center is not supported."
                           : "Game Capture is not publishing a microphone track."));
            if (sameDevice) {
                sendPeerAudioOptions(peer);
                sendPeerMediaDevices(peer);
            }
        }
    }
    if (msg.contains("changeSpeaker")) {
        const std::string deviceId =
            msg["changeSpeaker"].is_string() ? msg["changeSpeaker"].get<std::string>() : "";
        if (!directorAuthorized || !sharedControlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized changeSpeaker from {}", peer->uuid);
            sendRejectedControl("changeSpeaker", "unauthorized", "Remote speaker changes are not authorized.");
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
            sendRejectedControl(
                unsupportedKey,
                "unsupported",
                "This VDO.Ninja Control Center command is not supported by Game Capture.");
        }
    }
    if (msg.contains("group")) {
        spdlog::warn("[App] Rejected unsupported VDO control group from {}", peer->uuid);
        sendRejectedControl(
            "group",
            "unsupported",
            "This VDO.Ninja Control Center command is not supported by Game Capture.");
    }
    if (msg.contains("rotate")) {
        spdlog::warn("[App] Rejected unsupported VDO control rotate from {}", peer->uuid);
        sendRejectedControl(
            "rotate",
            "unsupported",
            "This VDO.Ninja Control Center command is not supported by Game Capture.");
    }
    if (msg.contains("mirrorGuestState") && msg.contains("mirrorGuestTarget")) {
        spdlog::warn("[App] Rejected unsupported VDO control mirrorGuestState from {}", peer->uuid);
        sendRejectedControl(
            "mirrorGuestState",
            "unsupported",
            "This VDO.Ninja Control Center command is not supported by Game Capture.");
    }
    if (msg.contains("getConnectionMap") && jsonBoolLike(msg["getConnectionMap"], true)) {
        if (!directorAuthorized) {
            spdlog::warn("[App] Rejected unauthorized VDO control getConnectionMap from {}", peer->uuid);
        }
        sendPeerConnectionMap(peer, msg, directorAuthorized);
        return;
    }
    if (msg.contains("reconnectPeer")) {
        spdlog::warn("[App] Rejected unsupported VDO control reconnectPeer from {}", peer->uuid);
        sendRejectedControl(
            "reconnectPeer",
            "unsupported",
            "This VDO.Ninja Control Center command is not supported by Game Capture.");
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
        directorMediaStateAuthorized = directorAuthorized && sharedControlAuthorized;
    }
    if (msg.contains("remoteVideoMuted")) {
        if (!directorMediaStateAuthorized) {
            spdlog::warn("[App] Rejected unauthorized remoteVideoMuted from {}", peer->uuid);
            sendRejectedControl(
                "remoteVideoMuted",
                "unauthorized",
                "Remote video mute control is not authorized.");
        } else {
            const bool muted = jsonBoolLike(msg["remoteVideoMuted"], false);
            peer->videoEnabled.store(!muted, std::memory_order_relaxed);
            peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
            reservePeerAlphaAdmissionCutoff(peer);
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
            sendRejectedControl(
                "volume",
                "unauthorized",
                "Remote audio mute control is not authorized.");
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
    bool peerVideoRouteRejected = false;
    int requestedBitrate = 0;
    auto applyPeerVideoRouteControl = [&](const char *controlName, int value) {
        const int previous = peer->requestedVideoBitrateKbps.load(std::memory_order_relaxed);
        int next = previous;
        if (value == 0) {
            next = 0;
        } else if (value < 0) {
            next = -1;
        } else {
            // A non-zero per-peer quality value cannot change this shared
            // encoded stream. If video was Off, restore the peer's assigned
            // HQ/LQ route, but do not pretend the requested quality applied.
            if (previous == 0) {
                next = -1;
            }
            if (!peerVideoRouteRejected) {
                sendRejectedControl(
                    controlName,
                    "unsupported",
                    "Per-peer Low/High quality selection is not supported; video uses its assigned stream tier.");
                peerVideoRouteRejected = true;
            }
        }
        if (next == previous) {
            if (value <= 0) {
                // Off and On/unlock are supported route controls; echo the
                // actual unchanged state when they are requested again.
                peerMediaRateChanged = true;
            }
            return;
        }
        peer->requestedVideoBitrateKbps.store(next, std::memory_order_relaxed);
        peerMediaRateChanged = true;
        peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
        reservePeerAlphaAdmissionCutoff(peer);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
    };
    if (msg.contains("bitrate")) {
        const int requestedPeerBitrate = parseRateLimitValue(msg["bitrate"], -1);
        applyPeerVideoRouteControl("bitrate", requestedPeerBitrate);
    }
    if (msg.contains("audioBitrate")) {
        const int requestedAudioBitrate = parseRateLimitValue(msg["audioBitrate"], -1);
        peer->requestedAudioBitrateKbps.store(requestedAudioBitrate, std::memory_order_relaxed);
        peerMediaRateChanged = true;
    }
    if (msg.contains("targetBitrate")) {
        if (!sharedControlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized targetBitrate from {}", peer->uuid);
            sendRejectedControl(
                "targetBitrate",
                "unauthorized",
                "Shared-stream bitrate control is not authorized.");
        } else {
            const bool unlockTargetBitrate =
                msg["targetBitrate"].is_boolean() && !msg["targetBitrate"].get<bool>();
            const int requestedTargetBitrate = unlockTargetBitrate ? -1 : jsonIntLike(msg["targetBitrate"], -1);
            if (unlockTargetBitrate || requestedTargetBitrate > 0) {
                if (requestedTargetBitrate > 0) {
                    requestedBitrate = requestedTargetBitrate;
                } else {
                    requestedBitrate = configuredVideoBitrateKbps_.load(std::memory_order_relaxed);
                }
                // This changes the shared encoder, not this peer's route.
                // Keep delivering its current prediction chain while a
                // replacement prepares; applyRuntimeVideoControl requests a
                // keyframe when the new configuration is committed.
            }
        }
    }
    if (msg.contains("optimizedBitrate")) {
        const bool unlockOptimizedBitrate =
            msg["optimizedBitrate"].is_boolean() && !msg["optimizedBitrate"].get<bool>();
        const int requestedOptimizedBitrate =
            unlockOptimizedBitrate ? -1 : jsonIntLike(msg["optimizedBitrate"], -1);
        if (unlockOptimizedBitrate || requestedOptimizedBitrate >= 0) {
            applyPeerVideoRouteControl("optimizedBitrate", requestedOptimizedBitrate);
        }
    }
    if (msg.contains("targetAudioBitrate")) {
        if (!sharedControlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized targetAudioBitrate from {}", peer->uuid);
            sendRejectedControl(
                "targetAudioBitrate",
                "unauthorized",
                "Shared-stream audio bitrate control is not authorized.");
        } else {
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
    const bool actionRequestsResolution =
        action == "requestresolution" ||
        action == "setwidth" ||
        action == "width" ||
        action == "setheight" ||
        action == "height";
    const bool actionRequestsBitrate = action == "bitrate" && actionValue;
    const bool messageRequestsResolution = msg.contains("requestResolution");
    const bool globalVideoControlDenied =
        (actionRequestsResolution || actionRequestsBitrate || messageRequestsResolution) &&
        !sharedControlAuthorized;
    if (globalVideoControlDenied) {
        const bool bitrateControlDenied = actionRequestsBitrate && !messageRequestsResolution;
        const bool reportRejection =
            bitrateControlDenied ||
            shouldReportUnauthorizedResolutionControl(
                directorAuthorized,
                !controlToken.empty());
        if (reportRejection) {
            spdlog::warn("[App] Rejected unauthorized shared video control {} from {}",
                         bitrateControlDenied ? "bitrate" : "requestResolution",
                         peer->uuid);
            sendRejectedControl(
                bitrateControlDenied ? "bitrate" : "requestResolution",
                "unauthorized",
                bitrateControlDenied
                    ? "Shared-stream bitrate control is not authorized."
                    : "Shared-stream resolution control is not authorized.");
        } else {
            recordPeerEvent(peer, "ignored-viewer-resolution-hint");
            spdlog::debug(
                "[App] Silently ignored anonymous viewer resolution hint from {}:{}",
                peer->uuid,
                peer->session);
        }
    }
    if (!globalVideoControlDenied && actionRequestsBitrate) {
        requestedBitrate = jsonIntLike(*actionValue, 0);
    }
    if (!globalVideoControlDenied &&
        msg.contains("requestResolution") && msg["requestResolution"].is_object()) {
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
    } else if (!globalVideoControlDenied &&
               msg.contains("requestResolution") && msg["requestResolution"].is_string()) {
        parseResolutionString(msg["requestResolution"].get<std::string>(), requestedWidth, requestedHeight);
    }
    if (!globalVideoControlDenied && action == "requestresolution" && actionValue) {
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
    if (!globalVideoControlDenied &&
        (action == "setwidth" || action == "width") && actionValue) {
        requestedWidth = jsonIntLike(*actionValue, requestedWidth);
    }
    if (!globalVideoControlDenied &&
        (action == "setheight" || action == "height") && actionValue) {
        requestedHeight = jsonIntLike(*actionValue, requestedHeight);
    }

    bool videoSettingsControlRequested = false;
    if (msg.contains("requestVideoHack")) {
        if (!sharedControlAuthorized) {
            spdlog::warn("[App] Rejected unauthorized requestVideoHack from {}", peer->uuid);
            sendRejectedControl(
                "requestVideoHack",
                "unauthorized",
                "Remote video settings control is not authorized.");
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
                rejected["reason"] = "unsupported";
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
                "unauthorized",
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
                reservePeerAlphaAdmissionCutoff(refreshPeer);
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

bool VersusApp::encodeAndSendVideoFrame(const video::CapturedFrame &frame,
                                        bool forceKeyframe,
                                        int64_t outputTimestamp) {
    if (!live_) {
        return false;
    }

    const int64_t frameOutputTimestamp =
        outputTimestamp == std::numeric_limits<int64_t>::min()
        ? frame.timestamp
        : outputTimestamp;
    if (frameOutputTimestamp == std::numeric_limits<int64_t>::min()) {
        return false;
    }

    const auto totalStart = std::chrono::steady_clock::now();
    int64_t lockWaitElapsedMs = 0;
    int64_t hqEncodeElapsedMs = 0;
    int64_t lqEncodeElapsedMs = 0;
    int64_t sendElapsedMs = 0;

    struct VideoPeerCandidate {
        std::string mapKey;
        std::shared_ptr<PeerSession> peer;
        bool activeVideo = false;
    };
    std::function<void()> beforeActiveVideoTrackQuery;
    {
        std::lock_guard<std::mutex> hookLock(roomQualityArchitectureTestHookMutex_);
        beforeActiveVideoTrackQuery = beforePeerActiveVideoTrackQueryForTesting_;
    }
    std::vector<VideoPeerCandidate> candidates;
    {
        std::lock_guard<std::mutex> peersLock(peerSessionsMutex_);
        candidates.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (entry.second) {
                candidates.push_back({entry.first, entry.second, false});
            }
        }
    }
    for (auto &candidate : candidates) {
        const auto &peer = candidate.peer;
        if (!peer) {
            continue;
        }
        std::unique_lock<std::recursive_mutex> clientLock(
            peer->clientOperationMutex,
            std::try_to_lock);
        if (clientLock.owns_lock() && peer->client) {
            if (beforeActiveVideoTrackQuery) {
                beforeActiveVideoTrackQuery();
            }
            const bool activeVideo = peer->client->hasActiveVideoTrack();
            const bool activeAudio = peer->client->hasActiveAudioTrack();
            peer->lastObservedVideoTrackActive.store(
                activeVideo,
                std::memory_order_relaxed);
            peer->lastObservedAudioTrackActive.store(
                activeAudio,
                std::memory_order_relaxed);
        }
        candidate.activeVideo = peer->lastObservedVideoTrackActive.load(
            std::memory_order_relaxed);
    }

    const auto lockWaitStart = std::chrono::steady_clock::now();
    std::unique_lock<std::mutex> lock(videoSendMutex_);
    lockWaitElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - lockWaitStart)
                            .count();
    if (!live_) {
        return false;
    }
    // A reconfiguration can hold this lock for hundreds of milliseconds.
    // Discard a scheduled slot that expired while waiting, before consuming
    // keyframe requests or admitting an alpha pair. The worker will select the
    // latest image for its next slot. Unscheduled callers use source timestamps
    // that need not share the output clock's epoch.
    if (outputTimestamp != std::numeric_limits<int64_t>::min() &&
        outputFrameSlotExpired(outputTimestamp, std::chrono::steady_clock::now(),
                               outputFrameInterval(videoConfig_.frameRate))) {
        detail::FrameTrace::instance().record("expired", &frame, outputTimestamp);
        return true;
    }
    bool renegotiateH264CodecFallback = false;
    std::unique_lock<std::mutex> decisionLock(roomQualityDecisionMutex_);
    const RoomQualityDecision roomQuality = roomQualityState_.decision;
    const bool lqRoutingAllowed = lqRoutingAllowedLocked(roomQuality);

    std::vector<std::shared_ptr<PeerSession>> hqPeers;
    std::vector<std::shared_ptr<PeerSession>> lqPeers;
    {
        std::lock_guard<std::mutex> peersLock(peerSessionsMutex_);
        hqPeers.reserve(candidates.size());
        lqPeers.reserve(candidates.size());
        for (const auto &candidate : candidates) {
            const auto current = peerSessions_.find(candidate.mapKey);
            if (current == peerSessions_.end() ||
                current->second != candidate.peer ||
                !candidate.activeVideo) {
                continue;
            }
            const auto &peer = current->second;
            const PeerRouteState route{
                peer->roomMode,
                lqRoutingAllowed,
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
            const StreamTier tier = roomQualityPeerTierLocked(
                peer,
                roomQuality,
                lqRoutingAllowed);
            peer->assignedTier.store(tier, std::memory_order_relaxed);
            if (tier == StreamTier::HQ) {
                hqPeers.push_back(peer);
            } else if (tier == StreamTier::LQ) {
                lqPeers.push_back(peer);
            }
        }
    }
    decisionLock.unlock();

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

    const bool alphaWorkflowForFrame = !hqPeers.empty() && usesVp9AlphaTrack(videoConfig_);
    const int primaryFrameWidth = activeHqWidth_ > 0
        ? activeHqWidth_
        : std::max(2, videoConfig_.width & ~1);
    const int primaryFrameHeight = activeHqHeight_ > 0
        ? activeHqHeight_
        : std::max(2, videoConfig_.height & ~1);
    AlphaFrameAdmission alphaFrameAdmission;
    if (alphaWorkflowForFrame) {
        if (requestKeyframe) {
            std::lock_guard<std::mutex> alphaEncoderLock(alphaEncoderMutex_);
            // The protected VP9 contract is explicit and non-overrideable;
            // every other backend must honor a real keyframe request.
            if (!videoEncoderAlpha_.guaranteesEveryFrameKeyframe()) {
                videoEncoderAlpha_.requestKeyframe();
            }
        }
        const auto [alphaWidth, alphaHeight] =
            alphaTrackDimensions(videoConfig_, primaryFrameWidth, primaryFrameHeight);
        if (buildAspectFitAlphaPlane(frame, alphaWidth, alphaHeight, alphaGrayBuffer_)) {
            // Start the independent alpha encoder before the primary encode so
            // both pipelines overlap. Dispatch remains delayed until the exact
            // generation+admission mate from each encoder has completed.
            alphaFrameAdmission = queueAlphaEncodeFrame(
                alphaWidth,
                alphaHeight,
                frameOutputTimestamp,
                std::move(alphaGrayBuffer_));
        }
    }

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
            updateRoomQualityDecisionForCodecLocked();
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
        if (keyframe_policy::shouldDispatchEncoderRequest(
                requestKeyframe,
                externalFfmpegEncoder,
                videoEncoder_.guaranteesEveryFrameKeyframe())) {
            videoEncoder_.requestKeyframe();
        }

        const auto encodeStart = std::chrono::steady_clock::now();
        const bool hardwareEncodingBefore = videoEncoder_.isHardwareEncoderActive();
        const int64_t encoderSourceTimestamp = alphaFrameAdmission.valid()
            ? alphaFrameAdmission.sourceTimestamp
            : frameOutputTimestamp;
        detail::FrameTrace::instance().record("submit", &frame, encoderSourceTimestamp);
        const bool encodeOk = videoEncoder_.encodeWithSourceTimestamp(
            frame,
            hqPacket,
            encoderSourceTimestamp);
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
                        if (candidateConfig.explicitEncoderSelection &&
                            candidateConfig.preferredHardware != video::HardwareEncoder::None &&
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

                    const bool preserveVp9AlphaTrack = usesVp9AlphaTrack(videoConfig_);
                    const auto publishRecoveredConfig = [this, preserveVp9AlphaTrack](
                                                            video::EncoderConfig recoveredConfig) {
                        recoveredConfig.enableAlpha = preserveVp9AlphaTrack;
                        videoConfig_ = std::move(recoveredConfig);
                        updateRoomQualityDecisionForCodecLocked();
                        publishVideoStateSnapshotLocked();
                    };
                    bool switchedToHardware = false;

                    if (hardwareRecoveryAttemptCount_ < kHardwareMaxSelfRecoveries) {
                        video::EncoderConfig selfRecoveryConfig = videoConfig_;
                        selfRecoveryConfig.codec = video::VideoCodec::H264;
                        selfRecoveryConfig.enableAlpha = false;
                        if (reinitAndCheck(selfRecoveryConfig, true, false, "Self-recovery reinit", "current")) {
                            hardwareRecoveryAttemptCount_++;
                            publishRecoveredConfig(selfRecoveryConfig);
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

                    if (!switchedToHardware && !videoConfig_.explicitEncoderSelection) {
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
                            publishRecoveredConfig(candidateConfig);
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

                    if (!switchedToHardware && !videoConfig_.explicitEncoderSelection) {
                        video::EncoderConfig fallbackConfig = videoConfig_;
                        fallbackConfig.preferredHardware = video::HardwareEncoder::None;
                        fallbackConfig.codec = video::VideoCodec::H264;
                        fallbackConfig.enableAlpha = false;
                        fallbackConfig.forceFfmpegNvenc = false;

                        videoEncoder_.shutdown();
                        if (videoEncoder_.initialize(fallbackConfig)) {
                            publishRecoveredConfig(fallbackConfig);
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
                    if (!switchedToHardware && videoConfig_.explicitEncoderSelection) {
                        const std::string requestedMode = videoEncoder_.requestedEncoderMode();
                        emitRuntimeEvent(
                            "The explicitly selected " + requestedMode +
                                " encoder became unstable. Automatic category fallback is disabled.",
                            true);
                        spdlog::error(
                            "[App] Explicit encoder mode {} could not recover; category fallback is disabled",
                            requestedMode);
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
            const bool hasTrustedSourceTimestamp =
                hqPacket.sourceTimestamp != std::numeric_limits<int64_t>::min();
            haveHqPacket = hasTrustedSourceTimestamp;
            if (!hasTrustedSourceTimestamp) {
                videoEncodeFailures_.fetch_add(1, std::memory_order_relaxed);
                videoEncodeHardFailures_.fetch_add(1, std::memory_order_relaxed);
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                static uint64_t missingHqSourceTimestampCount = 0;
                if (++missingHqSourceTimestampCount <= 5 ||
                    (missingHqSourceTimestampCount % 300) == 0) {
                    spdlog::error(
                        "[VideoPath] Dropping encoded primary packet without a trusted source timestamp (count={})",
                        missingHqSourceTimestampCount);
                }
            }
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

            if (keyframe_policy::shouldRearmAfterPacket(
                    requestKeyframe,
                    hqPacket.isKeyframe,
                    externalFfmpegEncoder)) {
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
            if (alphaWorkflowForFrame &&
                videoEncoder_.guaranteesEveryFrameKeyframe() &&
                !hqPacket.isKeyframe) {
                spdlog::error(
                    "[VideoPath] Protected VP9 primary encoder produced a delta frame; restarting before alpha startup can continue");
                videoEncoder_.requestKeyframe();
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            }
        } else {
            const SoftwareEncoderFailureDisposition softwareFailureDisposition =
                classifySoftwareEncoderFailure(encodeFailureKind);
            const bool transientExternalFailure =
                softwareFailureDisposition == SoftwareEncoderFailureDisposition::Transient;
            const bool immediateSoftwareFallback =
                softwareFailureDisposition == SoftwareEncoderFailureDisposition::ImmediateFallback;
            if (externalFfmpegEncoder &&
                !hardwareEncodingBefore &&
                videoEncoder_.activeCodec() != video::VideoCodec::H264 &&
                immediateSoftwareFallback) {
                if (fallbackUnstableSoftwareCodec(
                        "Software external encoder stopped producing output")) {
                    renegotiateH264CodecFallback = true;
                }
            } else if (externalFfmpegEncoder &&
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
            if (keyframe_policy::shouldRearmAfterEncodeFailure(
                    requestKeyframe,
                    externalFfmpegEncoder)) {
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
            if (videoEncoderLq_.encodeWithSourceTimestamp(
                    frame,
                    lqPacket,
                    frameOutputTimestamp)) {
                lqEncodeElapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                        std::chrono::steady_clock::now() - lqEncodeStart)
                                        .count();
                haveLqPacket =
                    lqPacket.sourceTimestamp != std::numeric_limits<int64_t>::min();
                if (!haveLqPacket) {
                    videoEncodeFailures_.fetch_add(1, std::memory_order_relaxed);
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                    static uint64_t missingLqSourceTimestampCount = 0;
                    if (++missingLqSourceTimestampCount <= 5 ||
                        (missingLqSourceTimestampCount % 300) == 0) {
                        spdlog::error(
                            "[VideoPath] Dropping encoded LQ packet without a trusted source timestamp (count={})",
                            missingLqSourceTimestampCount);
                    }
                } else if (requestKeyframe && !lqPacket.isKeyframe) {
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

    std::vector<ExactAlphaFramePair> completedAlphaPairs;
    if (alphaWorkflowForFrame) {
        ExactAlphaFramePacket completedAlpha;
        if (takeLatestAlphaPacket(completedAlpha)) {
            if (auto pair = alphaFramePairer_.submitAlpha(std::move(completedAlpha))) {
                completedAlphaPairs.push_back(std::move(*pair));
            }
        }
    }

    if (!haveHqPacket && !haveLqPacket && completedAlphaPairs.empty()) {
        return false;
    }

    bool sentAny = false;
    bool sentKeyframe = false;
    uint64_t videoBytesSentThisCall = 0;
    std::vector<int64_t> primaryPtsSentThisCall;
    int sentWidth = 0;
    int sentHeight = 0;
    const std::size_t hqPacketBytes = hqPacket.data.size();
    const auto sendStart = std::chrono::steady_clock::now();

    if (haveHqPacket) {
        detail::FrameTrace::instance().record("packet", nullptr, hqPacket.sourceTimestamp);
        webrtc::EncodedVideoPacket packet;
        packet.data = hqPacket.data;
        packet.pts = hqPacket.sourceTimestamp;
        packet.isKeyframe = hqPacket.isKeyframe;
        for (const auto &peer : hqPeers) {
            if (!peer || !peer->client) {
                continue;
            }
            // Alpha-capable peers are handled only after both independently
            // encoded halves with this exact source PTS are available.
            if (alphaWorkflowForFrame &&
                peer->alphaAllowed.load(std::memory_order_relaxed)) {
                continue;
            }
            if (peer->waitingForKeyframe.load(std::memory_order_relaxed) && !packet.isKeyframe) {
                continue;
            }
            std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
            const int64_t lastReserved =
                peer->lastVideoWirePtsReserved.load(std::memory_order_relaxed);
            packet.pts = nextMonotonicVideoTransportPts(
                hqPacket.sourceTimestamp,
                lastReserved);
            if (packet.pts <= lastReserved) {
                continue;
            }
            advanceMonotonic(peer->lastVideoWirePtsReserved, packet.pts);
            if (peer->client->sendVideo(packet)) {
                detail::FrameTrace::instance().record("sent", nullptr, hqPacket.sourceTimestamp);
                sentAny = true;
                videoBytesSentThisCall += packet.data.size();
                primaryPtsSentThisCall.push_back(packet.pts);
                peer->videoBytesSent.fetch_add(packet.data.size(), std::memory_order_relaxed);
                peer->videoFramesSent.fetch_add(1, std::memory_order_relaxed);
                advanceMonotonic(peer->lastPrimaryPtsSent, packet.pts);
                sentWidth = primaryFrameWidth;
                sentHeight = primaryFrameHeight;
                if (packet.isKeyframe) {
                    sentKeyframe = true;
                    peer->waitingForKeyframe.store(false, std::memory_order_relaxed);
                }
            } else {
                videoSendFailures_.fetch_add(1, std::memory_order_relaxed);
            }
        }

        if (alphaWorkflowForFrame) {
            ExactAlphaFramePacket completedPrimary;
            const auto admission = alphaFrameAdmissionTracker_.resolvePrimary(
                hqPacket.sourceTimestamp);
            if (admission &&
                admission->pipelineGeneration ==
                    alphaPipelineGeneration_.load(std::memory_order_acquire)) {
                completedPrimary.packet = std::move(hqPacket);
                completedPrimary.pipelineGeneration = admission->pipelineGeneration;
                completedPrimary.sourceAdmissionSequence = admission->sequence;
                completedPrimary.encodedWidth = primaryFrameWidth;
                completedPrimary.encodedHeight = primaryFrameHeight;
                if (auto pair = alphaFramePairer_.submitPrimary(std::move(completedPrimary))) {
                    completedAlphaPairs.push_back(std::move(*pair));
                }
            }
        }
    }

    // The ninja-plugin consumes alpha by RTP timestamp at primary decode time.
    // Queue alpha first, then the exact matching primary, while holding the
    // peer operation lock so a transport reset cannot split the pair.
    for (const auto &pair : completedAlphaPairs) {
        if (pair.primary.pipelineGeneration !=
                alphaPipelineGeneration_.load(std::memory_order_acquire)) {
            continue;
        }
        // This pair-level preflight is deliberately outside the peer loop.
        // One malformed completed pair yields one telemetry increment and at
        // most one cooldown-bounded recovery request, regardless of viewers.
        const auto contract = alphaContractRecovery_.observe(pair, nowMs);
        if (!contract.validation.valid()) {
            for (const auto &peer : hqPeers) {
                if (!peer ||
                    !peer->alphaAllowed.load(std::memory_order_relaxed)) {
                    continue;
                }
                peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
                reservePeerAlphaAdmissionCutoff(peer);
            }
            pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
            lastKeyframeSendMs_.store(0, std::memory_order_relaxed);

            if (contract.recoveryScheduled) {
                const auto rejection = contract.validation.rejection;
                const bool recoverPrimary =
                    rejection == ProtectedAlphaContractRejection::PairIdentityInvalid ||
                    rejection == ProtectedAlphaContractRejection::PrimaryCodecUnsupported ||
                    rejection == ProtectedAlphaContractRejection::PrimaryVp9NotKeyframe;
                const bool recoverAlpha =
                    rejection == ProtectedAlphaContractRejection::PairIdentityInvalid ||
                    rejection == ProtectedAlphaContractRejection::AlphaCodecNotVp9 ||
                    rejection == ProtectedAlphaContractRejection::AlphaNotKeyframe;
                if (recoverPrimary) {
                    videoEncoder_.requestKeyframe();
                }
                if (recoverAlpha) {
                    std::lock_guard<std::mutex> alphaEncoderLock(alphaEncoderMutex_);
                    videoEncoderAlpha_.requestKeyframe();
                }
            }

            const int64_t lastDiagnostic =
                lastAlphaContractDiagnosticMs_.load(std::memory_order_relaxed);
            if (lastDiagnostic == 0 || nowMs < lastDiagnostic ||
                nowMs - lastDiagnostic >= 5000) {
                lastAlphaContractDiagnosticMs_.store(nowMs, std::memory_order_relaxed);
                spdlog::warn(
                    "[VideoPath] Rejected completed alpha pair reason={} sequence={} generation={} rejectedPairs={} recoveryAttempts={}",
                    protectedAlphaContractRejectionName(
                        contract.validation.rejection),
                    pair.primary.sourceAdmissionSequence,
                    pair.primary.pipelineGeneration,
                    alphaContractRecovery_.rejectedPairCount(),
                    alphaContractRecovery_.recoveryAttemptCount());
            }
            continue;
        }
        if (contract.recovered) {
            spdlog::info(
                "[VideoPath] Protected alpha pair contract recovered at sequence={} generation={}",
                pair.primary.sourceAdmissionSequence,
                pair.primary.pipelineGeneration);
        }
        webrtc::EncodedVideoPacket alphaPacket;
        alphaPacket.data = pair.alpha.packet.data;
        alphaPacket.pts = pair.transportPts;
        alphaPacket.isKeyframe = pair.alpha.packet.isKeyframe;
        webrtc::EncodedVideoPacket primaryPacket;
        primaryPacket.data = pair.primary.packet.data;
        primaryPacket.pts = pair.transportPts;
        primaryPacket.isKeyframe = pair.primary.packet.isKeyframe;

        for (const auto &peer : hqPeers) {
            if (!peer || !peer->client ||
                !peer->alphaAllowed.load(std::memory_order_relaxed)) {
                continue;
            }

            int64_t peerPairWirePts = std::numeric_limits<int64_t>::min();
            const auto result = dispatchExactAlphaFramePair(
                pair,
                peer->clientOperationMutex,
                [&]() {
                    if (!peer->alphaAllowed.load(std::memory_order_relaxed)) {
                        return false;
                    }
                    if (!isAlphaPairNewerThan(
                            pair,
                            peer->lastVideoWirePtsReserved.load(std::memory_order_relaxed),
                            peer->alphaAdmissionCutoffSequence.load(std::memory_order_relaxed))) {
                        return false;
                    }
                    if (peer->waitingForKeyframe.load(std::memory_order_relaxed) &&
                        !canStartAlphaTransportWithPair(pair)) {
                        return false;
                    }
                    const uint64_t clientGeneration = peer->client->transportGeneration();
                    {
                        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
                        if (peer->removed ||
                            peer->clientTransportGeneration != clientGeneration) {
                            return false;
                        }
                    }
                    const int64_t lastReserved =
                        peer->lastVideoWirePtsReserved.load(std::memory_order_relaxed);
                    peerPairWirePts = nextMonotonicVideoTransportPts(
                        pair.transportPts,
                        lastReserved);
                    if (peerPairWirePts <= lastReserved) {
                        return false;
                    }
                    alphaPacket.pts = peerPairWirePts;
                    primaryPacket.pts = peerPairWirePts;
                    advanceMonotonic(
                        peer->lastVideoWirePtsReserved,
                        peerPairWirePts);
                    return true;
                },
                [&](const video::EncodedPacket &) {
                    return peer->client->sendAlphaVideo(alphaPacket);
                },
                [&](const video::EncodedPacket &) {
                    return peer->client->sendVideo(primaryPacket);
                });
            if (!result.admitted) {
                continue;
            }
            if (!result.alphaSent) {
                alphaSendFailures_.fetch_add(1, std::memory_order_relaxed);
                advanceMonotonic(
                    peer->alphaSourceCutoffTimestamp,
                    pair.primary.packet.sourceTimestamp);
                advanceMonotonic(
                    peer->alphaAdmissionCutoffSequence,
                    pair.primary.sourceAdmissionSequence);
                peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                continue;
            }
            peer->videoBytesSent.fetch_add(alphaPacket.data.size(), std::memory_order_relaxed);
            alphaPacketsSent_.fetch_add(1, std::memory_order_relaxed);
            if (!result.primarySent) {
                videoSendFailures_.fetch_add(1, std::memory_order_relaxed);
                advanceMonotonic(
                    peer->alphaSourceCutoffTimestamp,
                    pair.primary.packet.sourceTimestamp);
                advanceMonotonic(
                    peer->alphaAdmissionCutoffSequence,
                    pair.primary.sourceAdmissionSequence);
                peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
                continue;
            }

            sentAny = true;
            videoBytesSentThisCall += primaryPacket.data.size();
            primaryPtsSentThisCall.push_back(primaryPacket.pts);
            peer->videoBytesSent.fetch_add(primaryPacket.data.size(), std::memory_order_relaxed);
            peer->videoFramesSent.fetch_add(1, std::memory_order_relaxed);
            advanceMonotonic(peer->lastPrimaryPtsSent, primaryPacket.pts);
            sentWidth = primaryFrameWidth;
            sentHeight = primaryFrameHeight;
            if (primaryPacket.isKeyframe) {
                sentKeyframe = true;
            }
            if (canStartAlphaTransportWithPair(pair)) {
                // A new/replaced alpha transport is ready only after both
                // keyframe halves were accepted on the same transport bundle.
                peer->waitingForKeyframe.store(false, std::memory_order_relaxed);
            }
        }
    }
    if (haveLqPacket) {
        webrtc::EncodedVideoPacket packet;
        packet.data = lqPacket.data;
        packet.pts = lqPacket.sourceTimestamp;
        packet.isKeyframe = lqPacket.isKeyframe;
        for (const auto &peer : lqPeers) {
            if (!peer || !peer->client) {
                continue;
            }
            if (peer->waitingForKeyframe.load(std::memory_order_relaxed) && !packet.isKeyframe) {
                continue;
            }
            std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
            const int64_t lastReserved =
                peer->lastVideoWirePtsReserved.load(std::memory_order_relaxed);
            packet.pts = nextMonotonicVideoTransportPts(
                lqPacket.sourceTimestamp,
                lastReserved);
            if (packet.pts <= lastReserved) {
                continue;
            }
            advanceMonotonic(peer->lastVideoWirePtsReserved, packet.pts);
            if (peer->client->sendVideo(packet)) {
                sentAny = true;
                videoBytesSentThisCall += packet.data.size();
                primaryPtsSentThisCall.push_back(packet.pts);
                peer->videoBytesSent.fetch_add(packet.data.size(), std::memory_order_relaxed);
                peer->videoFramesSent.fetch_add(1, std::memory_order_relaxed);
                advanceMonotonic(peer->lastPrimaryPtsSent, packet.pts);
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
        std::sort(primaryPtsSentThisCall.begin(), primaryPtsSentThisCall.end());
        primaryPtsSentThisCall.erase(
            std::unique(primaryPtsSentThisCall.begin(), primaryPtsSentThisCall.end()),
            primaryPtsSentThisCall.end());
        videoBytesSent_.fetch_add(videoBytesSentThisCall, std::memory_order_relaxed);
        videoFramesSent_.fetch_add(
            std::max<std::size_t>(1, primaryPtsSentThisCall.size()),
            std::memory_order_relaxed);
        if (sentWidth > 0 && sentHeight > 0) {
            lastSentWidth_.store(sentWidth, std::memory_order_relaxed);
            lastSentHeight_.store(sentHeight, std::memory_order_relaxed);
        }
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
                         hqPacketBytes,
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

std::shared_ptr<const video::CapturedFrame> VersusApp::getCachedVideoFrame() {
    std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
    return cachedVideoFrame_;
}

void VersusApp::handleVideoFrame(video::CapturedFrame frame) {
    static int frameCount = 0;
    static auto lastLog = std::chrono::steady_clock::now();
    frameCount++;
    videoFramesCaptured_.fetch_add(1, std::memory_order_relaxed);
    updateSourceHealthFromFrame(frame);

    const video::EncoderConfig config = videoStateSnapshot().config;
    compositeAlphaBackground(frame, config);

    detail::FrameTrace::instance().record("capture", &frame, 0);

    const auto sharedFrame = std::make_shared<const video::CapturedFrame>(std::move(frame));
    {
        std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
        pendingVideoFrame_ = sharedFrame;
        cachedVideoFrame_ = sharedFrame;
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

            const LifecycleStateSnapshot lifecycleState = lifecycleStateSnapshot();
            bool recovered = false;
            {
                std::lock_guard<std::mutex> lock(signalingOpsMutex_);
                signaling_.disconnect();

                if (signaling_.connect(lifecycleState.startOptions.server, [this]() {
                        return stopRequested_.load() || !live_.load();
                    })) {
                    signaling_.setPassword(lifecycleState.password);
                    if (lifecycleState.password == "false" ||
                        lifecycleState.password == "0" ||
                        lifecycleState.password == "off") {
                        signaling_.disableEncryption();
                    }

                    bool joined = true;
                    if (!lifecycleState.room.empty()) {
                        signaling::RoomConfig roomConfig;
                        roomConfig.room = lifecycleState.room;
                        roomConfig.password = lifecycleState.password;
                        roomConfig.label = lifecycleState.startOptions.label;
                        roomConfig.streamId = lifecycleState.streamId;
                        roomConfig.salt = lifecycleState.salt;
                        joined = signaling_.joinRoom(roomConfig);
                    }

                    if (joined) {
                        recovered = signaling_.publish(
                            lifecycleState.streamId,
                            lifecycleState.startOptions.label);
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

    const VideoSourceMode sourceMode = lifecycleStateSnapshot().videoSourceMode;
    videoMaintenanceThread_ = std::thread([this, sourceMode]() {
        int64_t lastInfoBroadcastMs = 0;
        while (videoMaintenanceRunning_.load()) {
            bool sourceCapturing = false;
            switch (sourceMode) {
                case VideoSourceMode::Camera:
                    sourceCapturing = cameraCapture_.isCapturing();
                    break;
                case VideoSourceMode::Spout:
                    sourceCapturing = spoutCapture_.isCapturing();
                    break;
                case VideoSourceMode::Window:
                default:
                    sourceCapturing = windowCapture_.isCapturing();
                    break;
            }
            if (capturing_.load(std::memory_order_relaxed) && !sourceCapturing) {
                videoTrackActive_.store(false, std::memory_order_relaxed);
                pendingGlobalKeyframe_.store(false, std::memory_order_relaxed);
                if (!captureBackendFailureNotified_.exchange(true, std::memory_order_relaxed)) {
                    std::string message;
                    switch (sourceMode) {
                        case VideoSourceMode::Camera:
                            message = cameraCapture_.lastError();
                            if (message.empty()) {
                                message =
                                    "Camera capture stopped. Check the camera connection and Windows privacy settings, then start streaming again.";
                            }
                            break;
                        case VideoSourceMode::Spout:
                            message =
                                "Spout2 capture stopped. Select a valid Spout2 sender and start streaming again.";
                            break;
                        case VideoSourceMode::Window:
                        default:
                            message =
                                "Window capture stopped. Select a valid window and start streaming again.";
                            break;
                    }
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

            const int64_t lastKeyframeMs = lastKeyframeSendMs_.load(std::memory_order_relaxed);
            const bool periodicKeyframeDue =
                (lastKeyframeMs == 0) || ((nowMs - lastKeyframeMs) >= kPeriodicKeyframeMs);

            if (periodicKeyframeDue) {
                // The encode worker already replays cached images at the
                // requested cadence, including while capture is idle. Request
                // its next keyframe instead of inserting an unpaced frame from
                // a second thread with a competing output timestamp.
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
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
                    latestAlphaPacket_ = ExactAlphaFramePacket{};
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
                            updateRoomQualityDecisionForCodecLocked();
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

            if (job.gray.empty() || job.width <= 0 || job.height <= 0 ||
                !job.admission.valid()) {
                continue;
            }

            video::CapturedFrame alphaFrame;
            alphaFrame.format = video::CapturedFrame::Format::Gray;
            alphaFrame.width = job.width;
            alphaFrame.height = job.height;
            alphaFrame.stride = job.width;
            alphaFrame.timestamp = job.admission.sourceTimestamp;
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
                if (alphaPacket.sourceTimestamp == std::numeric_limits<int64_t>::min()) {
                    alphaEncodeFailures_.fetch_add(1, std::memory_order_relaxed);
                    alphaFramesDropped_.fetch_add(1, std::memory_order_relaxed);
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                    static uint64_t missingAlphaSourceTimestampCount = 0;
                    if (++missingAlphaSourceTimestampCount <= 5 ||
                        (missingAlphaSourceTimestampCount % 300) == 0) {
                        spdlog::error(
                            "[AlphaEncodeThread] Dropping encoded alpha packet without a trusted source timestamp (count={})",
                            missingAlphaSourceTimestampCount);
                    }
                    continue;
                }
                const auto admission = alphaFrameAdmissionTracker_.resolveAlpha(
                    alphaPacket.sourceTimestamp);
                if (!admission ||
                    admission->pipelineGeneration !=
                        alphaPipelineGeneration_.load(std::memory_order_acquire)) {
                    alphaFramesDropped_.fetch_add(1, std::memory_order_relaxed);
                    continue;
                }
                if (!alphaPacket.isKeyframe) {
                    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                    std::lock_guard<std::mutex> encoderLock(alphaEncoderMutex_);
                    videoEncoderAlpha_.requestKeyframe();
                    if (videoEncoderAlpha_.guaranteesEveryFrameKeyframe()) {
                        spdlog::error(
                            "[AlphaEncodeThread] Protected VP9 alpha encoder produced a delta frame; restarting before alpha startup can continue");
                    }
                }
                std::lock_guard<std::mutex> packetLock(alphaPacketMutex_);
                if (latestAlphaPacketReady_) {
                    alphaFramesDropped_.fetch_add(1, std::memory_order_relaxed);
                }
                latestAlphaPacket_.packet = std::move(alphaPacket);
                latestAlphaPacket_.pipelineGeneration = admission->pipelineGeneration;
                latestAlphaPacket_.sourceAdmissionSequence = admission->sequence;
                latestAlphaPacket_.encodedWidth = job.width;
                latestAlphaPacket_.encodedHeight = job.height;
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
        alphaPipelineGeneration_.fetch_add(1, std::memory_order_acq_rel);
        alphaFrameAdmissionTracker_.clearPending();
        pendingAlphaEncodeJob_ = AlphaEncodeJob{};
        pendingAlphaEncodeJobReady_ = false;
        pendingAlphaEncoderConfig_ = video::EncoderConfig{};
        pendingAlphaEncoderReconfigure_ = false;
    }
    {
        std::lock_guard<std::mutex> lock(alphaPacketMutex_);
        latestAlphaPacket_ = ExactAlphaFramePacket{};
        latestAlphaPacketReady_ = false;
    }
    alphaFramePairer_.clear();
}

AlphaFrameAdmission VersusApp::queueAlphaEncodeFrame(int width,
                                                     int height,
                                                     int64_t timestamp,
                                                     std::vector<uint8_t> gray) {
    if (!alphaEncodeThreadRunning_.load(std::memory_order_acquire) ||
        gray.empty() ||
        width <= 0 ||
        height <= 0) {
        return {};
    }

    AlphaFrameAdmission admission;
    {
        std::lock_guard<std::mutex> lock(alphaEncodeMutex_);
        const uint64_t pipelineGeneration =
            alphaPipelineGeneration_.load(std::memory_order_acquire);
        admission = alphaFrameAdmissionTracker_.admit(timestamp, pipelineGeneration);
        if (!admission.valid()) {
            alphaFramesDropped_.fetch_add(1, std::memory_order_relaxed);
            return {};
        }
        if (pendingAlphaEncodeJobReady_) {
            alphaFramesDropped_.fetch_add(1, std::memory_order_relaxed);
        }
        pendingAlphaEncodeJob_.gray = std::move(gray);
        pendingAlphaEncodeJob_.width = width;
        pendingAlphaEncodeJob_.height = height;
        pendingAlphaEncodeJob_.admission = admission;
        pendingAlphaEncodeJobReady_ = true;
        alphaFramesQueued_.fetch_add(1, std::memory_order_relaxed);
    }
    alphaEncodeCV_.notify_one();
    return admission;
}

void VersusApp::queueAlphaEncoderReconfigure(video::EncoderConfig config) {
    if (!alphaEncodeThreadRunning_.load(std::memory_order_acquire)) {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(alphaEncodeMutex_);
        alphaPipelineGeneration_.fetch_add(1, std::memory_order_acq_rel);
        alphaFrameAdmissionTracker_.clearPending();
        if (pendingAlphaEncodeJobReady_) {
            alphaFramesDropped_.fetch_add(1, std::memory_order_relaxed);
        }
        pendingAlphaEncodeJob_ = AlphaEncodeJob{};
        pendingAlphaEncodeJobReady_ = false;
        pendingAlphaEncoderConfig_ = std::move(config);
        pendingAlphaEncoderReconfigure_ = true;
    }
    {
        std::lock_guard<std::mutex> lock(alphaPacketMutex_);
        if (latestAlphaPacketReady_) {
            alphaFramesDropped_.fetch_add(1, std::memory_order_relaxed);
        }
        latestAlphaPacket_ = ExactAlphaFramePacket{};
        latestAlphaPacketReady_ = false;
    }
    alphaFramePairer_.clear();
    alphaEncodeCV_.notify_one();
}

bool VersusApp::takeLatestAlphaPacket(ExactAlphaFramePacket &packet) {
    std::lock_guard<std::mutex> lock(alphaPacketMutex_);
    if (!latestAlphaPacketReady_ || latestAlphaPacket_.packet.data.empty()) {
        return false;
    }
    packet = std::move(latestAlphaPacket_);
    latestAlphaPacket_ = ExactAlphaFramePacket{};
    latestAlphaPacketReady_ = false;
    return true;
}

void VersusApp::reservePeerAlphaAdmissionCutoff(const std::shared_ptr<PeerSession> &peer) {
    if (!peer) {
        return;
    }
    const AlphaFrameAdmission watermark = alphaFrameAdmissionTracker_.latestAdmission();
    if (!watermark.valid()) {
        return;
    }
    advanceMonotonic(peer->alphaAdmissionCutoffSequence, watermark.sequence);
    advanceMonotonic(peer->alphaSourceCutoffTimestamp, watermark.sourceTimestamp);
}

void VersusApp::startEncodeThread() {
    if (encodeThreadRunning_.exchange(true)) {
        return;
    }

    startAlphaEncodeThread();

    encodeThread_ = std::thread([this]() {
        spdlog::info("[EncodeThread] Started");
        using Clock = std::chrono::steady_clock;
        auto nextFrameDue = Clock::now();
        while (encodeThreadRunning_.load()) {
            const VideoStateSnapshot videoState = videoStateSnapshot();
            const auto frameInterval = outputFrameInterval(
                std::max(1, videoState.config.frameRate));
            auto scheduledFrameDue = nextFrameDue;
            {
                std::unique_lock<std::mutex> lock(encodeNotifyMutex_);
                encodeFrameCV_.wait_until(
                    lock,
                    scheduledFrameDue,
                    [this] { return !encodeThreadRunning_.load(); });
                // Independent capture/output clocks can straddle a compositor
                // update. Briefly wait for that fresh image before replaying the
                // cached one; static sources still keep the output cadence.
                if (!encodeFrameReady_ && encodeThreadRunning_.load()) {
                    const auto grace = std::min(frameInterval / 4,
                        std::chrono::duration_cast<std::chrono::nanoseconds>(
                            std::chrono::milliseconds(4)));
                    const bool fresh = encodeFrameCV_.wait_until(lock, scheduledFrameDue + grace, [this] {
                        return !encodeThreadRunning_.load() || encodeFrameReady_;
                    });
                    // Follow the capture phase after a successful fresh-frame
                    // wait. Otherwise every slot can keep landing just before
                    // capture arrives. A timeout must not shift the clock:
                    // paused sources still need full-rate cached output.
                    if (fresh && encodeThreadRunning_.load()) {
                        scheduledFrameDue = Clock::now();
                    }
                }
                if (!encodeThreadRunning_.load()) {
                    break;
                }
                encodeFrameReady_ = false;
            }

            nextFrameDue = advanceOutputFrameDeadline(
                scheduledFrameDue,
                Clock::now(),
                frameInterval);

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

            std::shared_ptr<const video::CapturedFrame> frame;
            {
                std::lock_guard<std::mutex> lock(latestVideoFrameMutex_);
                if (pendingVideoFrame_) {
                    frame = std::move(pendingVideoFrame_);
                } else {
                    frame = cachedVideoFrame_;
                }
            }

            if (!frame || frame->data.empty()) {
                continue;
            }

            const int64_t outputTimestamp = outputFrameTimestamp100ns(
                scheduledFrameDue);
            if (!encodeAndSendVideoFrame(
                    *frame,
                    false,
                    outputTimestamp)) {
                static int sendFailCount = 0;
                if (++sendFailCount % 100 == 1) {
                    spdlog::warn("[EncodeThread] encodeAndSendVideoFrame failed (count={})", sendFailCount);
                }
            }
            // Allow one late slot for normal encode jitter. A longer stall
            // must not be followed by a backlog of stale scheduled frames.
            nextFrameDue = outputFrameDeadlineAfterEncode(
                scheduledFrameDue, Clock::now(), frameInterval);
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

void VersusApp::refreshPeerTrackObservations(
    bool observeVideo,
    bool observeAudio) const {
    std::vector<std::shared_ptr<PeerSession>> peers;
    {
        std::lock_guard<std::mutex> peersLock(peerSessionsMutex_);
        peers.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (entry.second) {
                peers.push_back(entry.second);
            }
        }
    }
    for (const auto &peer : peers) {
        std::unique_lock<std::recursive_mutex> clientLock(
            peer->clientOperationMutex,
            std::try_to_lock);
        if (!clientLock.owns_lock() || !peer->client) {
            continue;
        }
        if (observeVideo) {
            peer->lastObservedVideoTrackActive.store(
                peer->client->hasActiveVideoTrack(),
                std::memory_order_relaxed);
        }
        if (observeAudio) {
            peer->lastObservedAudioTrackActive.store(
                peer->client->hasActiveAudioTrack(),
                std::memory_order_relaxed);
        }
    }
}

bool VersusApp::hasAnyActiveVideoTrack() const {
    refreshPeerTrackObservations(true, false);
    return roomQualityDiagnosticsSnapshot().counts.activeVideo > 0;
}

bool VersusApp::hasAnyActiveAudioTrack() const {
    refreshPeerTrackObservations(false, true);
    return roomQualityDiagnosticsSnapshot().counts.activeAudio > 0;
}

VersusApp::PeerCounts VersusApp::collectPeerCounts() const {
    return roomQualityDiagnosticsSnapshot().counts;
}

void VersusApp::refreshDiagnosticsTrackObservationsForTesting() const {
    std::function<bool()> activeVideoTrackForDiagnostics;
    {
        std::lock_guard<std::mutex> hookLock(roomQualityArchitectureTestHookMutex_);
        activeVideoTrackForDiagnostics = peerActiveVideoTrackForDiagnosticsTesting_;
    }
    if (!activeVideoTrackForDiagnostics) {
        return;
    }

    std::vector<std::shared_ptr<PeerSession>> peers;
    {
        std::lock_guard<std::mutex> peersLock(peerSessionsMutex_);
        peers.reserve(peerSessions_.size());
        for (const auto &entry : peerSessions_) {
            if (entry.second) {
                peers.push_back(entry.second);
            }
        }
    }
    for (const auto &peer : peers) {
        peer->lastObservedVideoTrackActive.store(
            activeVideoTrackForDiagnostics(),
            std::memory_order_relaxed);
    }
}

VersusApp::RoomQualityDiagnosticsSnapshot
VersusApp::roomQualityDiagnosticsSnapshot() const {
    RoomQualityDiagnosticsSnapshot snapshot;
    std::lock_guard<std::mutex> decisionLock(roomQualityDecisionMutex_);
    snapshot.generation = roomQualityState_.generation;
    snapshot.decision = roomQualityState_.decision;
    snapshot.activeRoom = roomQualityState_.activeRoom;
    snapshot.codec = roomQualityState_.codec;

    std::lock_guard<std::mutex> peersLock(peerSessionsMutex_);
    snapshot.peers.reserve(peerSessions_.size());
    for (const auto &entry : peerSessions_) {
        const auto &peer = entry.second;
        if (!peer) {
            continue;
        }
        const StreamTier assignedTier =
            peer->assignedTier.load(std::memory_order_relaxed);
        const bool lastObservedVideo =
            peer->lastObservedVideoTrackActive.load(std::memory_order_relaxed);
        const bool lastObservedAudio =
            peer->lastObservedAudioTrackActive.load(std::memory_order_relaxed);
        const PeerRouteState route{
            peer->roomMode,
            snapshot.decision.effective,
            peer->initReceived.load(std::memory_order_relaxed),
            peer->roleValid.load(std::memory_order_relaxed),
            peer->role.load(std::memory_order_relaxed),
            peer->videoEnabled.load(std::memory_order_relaxed),
            peer->audioEnabled.load(std::memory_order_relaxed)};

        ++snapshot.counts.total;

        if (route.roomMode && route.initReceived && route.roleValid) {
            if (route.role == PeerRole::Guest) {
                ++snapshot.counts.roomGuests;
            } else if (route.role == PeerRole::Scene) {
                ++snapshot.counts.roomScenes;
            } else {
                ++snapshot.counts.roomNonGuestViewers;
            }
        }

        const bool activeVideo = lastObservedVideo &&
            peer->requestedVideoBitrateKbps.load(std::memory_order_relaxed) != 0 &&
            canSendVideo(route);
        if (assignedTier == StreamTier::HQ) {
            ++snapshot.counts.hq;
        } else if (assignedTier == StreamTier::LQ) {
            ++snapshot.counts.lq;
        }
        if (activeVideo) {
            ++snapshot.counts.activeVideo;
        }
        const bool activeAudio = lastObservedAudio &&
            peer->requestedAudioBitrateKbps.load(std::memory_order_relaxed) != 0 &&
            canSendAudio(route);
        if (activeAudio) {
            ++snapshot.counts.activeAudio;
        }

        std::string activeWireSession;
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            activeWireSession = peer->activeWireSession;
        }

        snapshot.peers.push_back({
            peer,
            peer->uuid,
            activeWireSession,
            peer->streamId,
            peer->candidateType,
            peer->createdAtMs,
            assignedTier,
            activeVideo,
            activeAudio});
    }
    return snapshot;
}

VersusApp::VideoStateSnapshot VersusApp::buildVideoStateSnapshotLocked() const {
    VideoStateSnapshot snapshot;
    snapshot.config = videoConfig_;
    snapshot.hqWidth = activeHqWidth_ > 0 ? activeHqWidth_ : std::max(2, videoConfig_.width & ~1);
    snapshot.hqHeight = activeHqHeight_ > 0 ? activeHqHeight_ : std::max(2, videoConfig_.height & ~1);
    snapshot.encoderName = videoEncoder_.activeEncoderName();
    snapshot.requestedEncoderMode = videoEncoder_.requestedEncoderMode();
    snapshot.encoderCategory = videoEncoder_.activeEncoderCategory();
    snapshot.encoderFallbackReason = videoEncoder_.encoderFallbackReason();
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

VersusApp::LifecycleStateSnapshot VersusApp::lifecycleStateSnapshot() const {
    std::lock_guard<std::mutex> lock(lifecycleStateMutex_);
    LifecycleStateSnapshot snapshot;
    snapshot.startOptions = startOptions_;
    snapshot.streamId = streamId_;
    snapshot.room = room_;
    snapshot.password = password_;
    snapshot.salt = salt_;
    snapshot.remoteControlToken = remoteControlToken_;
    snapshot.selectedWindowId = selectedWindowId_;
    snapshot.videoSourceMode = videoSourceMode_;
    snapshot.audioSourceMode = audioSourceMode_;
    snapshot.includeMicrophone = includeMicrophone_;
    snapshot.microphoneDeviceId = microphoneDeviceId_;
    snapshot.activeMicrophoneSourceName = activeMicrophoneSourceName_;
    return snapshot;
}

void VersusApp::sendAudioPacketToPeers(const versus::webrtc::EncodedAudioPacket &packet) {
    refreshPeerTrackObservations(false, true);
    const RoomQualityDiagnosticsSnapshot roomQualitySnapshot =
        roomQualityDiagnosticsSnapshot();
    std::vector<std::shared_ptr<PeerSession>> peers;
    peers.reserve(roomQualitySnapshot.peers.size());
    for (const auto &peerSnapshot : roomQualitySnapshot.peers) {
        if (peerSnapshot.activeAudio && peerSnapshot.peer) {
            peers.push_back(peerSnapshot.peer);
        }
    }

    uint64_t bytesSent = 0;
    int packetsSent = 0;
    for (const auto &peer : peers) {
        if (!peer) {
            continue;
        }
        std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
        if (!peer->client) {
            continue;
        }
        if (peer->client->sendAudio(packet)) {
            bytesSent += packet.data.size();
            packetsSent++;
            peer->audioBytesSent.fetch_add(packet.data.size(), std::memory_order_relaxed);
            peer->audioPacketsSent.fetch_add(1, std::memory_order_relaxed);
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

    std::string activeWireSession;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed) {
            return true;
        }
        activeWireSession = peer->activeWireSession;
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
        const std::string answerSession = parsed.answer.session.empty()
            ? activeWireSession
            : parsed.answer.session;
        const bool sameSession = !parsed.answer.session.empty() &&
            answerSession == activeWireSession;
        const bool sameUuid = answerUuid == peer->uuid;
        const bool channelScoped = parsed.answer.session.empty() && parsed.answer.uuid.empty();
        if ((sameUuid && answerSession == activeWireSession) || sameSession || channelScoped) {
            if (!sameUuid && sameSession) {
                spdlog::info("[App] Accepting datachannel answer by session match {}:{} payloadUuid={}",
                             peer->uuid,
                             peer->session,
                             parsed.answer.uuid);
            }
            applyPeerAnswer(peer, parsed.answer.sdp, "datachannel", activeWireSession);
        } else {
            spdlog::warn("[App] Ignoring datachannel answer for mismatched peer uuid={} session={}",
                         parsed.answer.uuid,
                         parsed.answer.session);
        }
        handled = true;
    }

    for (const auto &candidate : parsed.candidates) {
        const std::string candidateUuid = candidate.uuid.empty() ? peer->uuid : candidate.uuid;
        const std::string candidateSession = candidate.session.empty()
            ? activeWireSession
            : candidate.session;
        const bool sameSession = !candidate.session.empty() &&
            candidateSession == activeWireSession;
        const bool sameUuid = candidateUuid == peer->uuid;
        const bool channelScoped = candidate.session.empty() && candidate.uuid.empty();
        if (!((sameUuid && candidateSession == activeWireSession) || sameSession || channelScoped)) {
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
        signaling::SignalCandidate routedCandidate = candidate;
        routedCandidate.uuid = peer->uuid;
        routedCandidate.session = activeWireSession;
        handlePeerRemoteCandidate(peer, routedCandidate, "datachannel");
        handled = true;
    }

    return handled;
}

bool VersusApp::handleDuplicatePeerOfferRequest(
    const std::shared_ptr<PeerSession> &peer,
    const char *reason) {
    if (!peer || !peer->client) {
        return false;
    }

    std::lock_guard<std::recursive_mutex> callbackGenerationLock(
        peer->callbackOperationMutex);
    bool terminalTransport = false;
    bool sessionInitializing = false;
    std::string activeWireSession;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed) {
            return false;
        }
        terminalTransport = peer->transportRetired;
        sessionInitializing = peer->sessionInitializing;
        activeWireSession = peer->activeWireSession;
    }
    if (sessionInitializing) {
        spdlog::info(
            "[Signaling] Ignoring duplicate offer request while peer initializes uuid={} activeSession={} reason={}",
            peer->uuid,
            activeWireSession,
            reason ? reason : "unspecified");
        return true;
    }

    const webrtc::ConnectionState connectionState =
        peer->client->connectionState();
    if (connectionState == webrtc::ConnectionState::Connected) {
        peer->duplicateOfferRechecksIgnoredConnected.fetch_add(
            1,
            std::memory_order_relaxed);
        spdlog::info(
            "[Signaling] Ignoring duplicate offer request for connected transport uuid={} activeSession={} reason={}",
            peer->uuid,
            activeWireSession,
            reason ? reason : "unspecified");
        return true;
    }

    if (terminalTransport ||
        connectionState == webrtc::ConnectionState::Failed ||
        connectionState == webrtc::ConnectionState::Closed) {
        spdlog::info(
            "[Signaling] Duplicate offer request is replacing terminal transport uuid={} activeSession={} reason={}",
            peer->uuid,
            activeWireSession,
            reason ? reason : "unspecified");
        return sendPeerOffer(peer, reason ? reason : "duplicate-offer-terminal-recovery", true);
    }
    return scheduleDuplicateOfferRecheck(peer, reason);
}

bool VersusApp::startDuplicateOfferRecheckScheduler() {
    std::lock_guard<std::mutex> lock(duplicateOfferRecheckMutex_);
    if (duplicateOfferRecheckRunning_) {
        return true;
    }
    duplicateOfferRecheckStopRequested_ = false;
    duplicateOfferRecheckAccepting_ = true;
    duplicateOfferRechecks_.clear();
    if (++duplicateOfferRecheckEpoch_ == 0) {
        ++duplicateOfferRecheckEpoch_;
    }
    ++duplicateOfferRecheckRevision_;
    duplicateOfferRecheckRunning_ = true;
    try {
        duplicateOfferRecheckThread_ = std::thread(
            [this]() { duplicateOfferRecheckSchedulerLoop(); });
    } catch (const std::exception &error) {
        duplicateOfferRecheckRunning_ = false;
        duplicateOfferRecheckAccepting_ = false;
        spdlog::error(
            "[Signaling] Failed to start duplicate-offer recheck scheduler: {}",
            error.what());
        return false;
    } catch (...) {
        duplicateOfferRecheckRunning_ = false;
        duplicateOfferRecheckAccepting_ = false;
        spdlog::error(
            "[Signaling] Failed to start duplicate-offer recheck scheduler");
        return false;
    }
    return true;
}

void VersusApp::stopDuplicateOfferRecheckScheduler() {
    std::thread scheduler;
    std::vector<PendingDuplicateOfferRecheck> canceledJobs;
    {
        std::lock_guard<std::mutex> lock(duplicateOfferRecheckMutex_);
        duplicateOfferRecheckAccepting_ = false;
        duplicateOfferRecheckStopRequested_ = true;
        if (++duplicateOfferRecheckEpoch_ == 0) {
            ++duplicateOfferRecheckEpoch_;
        }
        ++duplicateOfferRecheckRevision_;
        canceledJobs.reserve(duplicateOfferRechecks_.size());
        for (auto &[_, job] : duplicateOfferRechecks_) {
            job.state = PendingDuplicateOfferRecheck::State::Canceling;
            canceledJobs.push_back(job);
        }
        scheduler.swap(duplicateOfferRecheckThread_);
    }
    duplicateOfferRecheckCv_.notify_all();
    for (const auto &job : canceledJobs) {
        cancelDuplicateOfferRecheckJob(
            job,
            DuplicateOfferRecheckDisposition::Canceled,
            "scheduler-stop");
    }
    if (scheduler.joinable()) {
        scheduler.join();
    }
    {
        std::lock_guard<std::mutex> lock(duplicateOfferRecheckMutex_);
        duplicateOfferRecheckRunning_ = false;
        duplicateOfferRecheckStopRequested_ = false;
    }
}

void VersusApp::resetDuplicateOfferRecheckSchedulerForLive() {
    std::vector<PendingDuplicateOfferRecheck> canceledJobs;
    {
        std::lock_guard<std::mutex> lock(duplicateOfferRecheckMutex_);
        if (!duplicateOfferRecheckRunning_ ||
            duplicateOfferRecheckStopRequested_) {
            return;
        }
        duplicateOfferRecheckAccepting_ = false;
        canceledJobs.reserve(duplicateOfferRechecks_.size());
        for (auto &[_, job] : duplicateOfferRechecks_) {
            job.state = PendingDuplicateOfferRecheck::State::Canceling;
            canceledJobs.push_back(job);
        }
        if (++duplicateOfferRecheckEpoch_ == 0) {
            ++duplicateOfferRecheckEpoch_;
        }
        ++duplicateOfferRecheckRevision_;
    }
    duplicateOfferRecheckCv_.notify_all();
    for (const auto &job : canceledJobs) {
        cancelDuplicateOfferRecheckJob(
            job,
            DuplicateOfferRecheckDisposition::Canceled,
            "reset-live");
    }
    {
        std::lock_guard<std::mutex> lock(duplicateOfferRecheckMutex_);
        if (duplicateOfferRecheckRunning_ &&
            !duplicateOfferRecheckStopRequested_) {
            duplicateOfferRecheckAccepting_ = true;
            ++duplicateOfferRecheckRevision_;
        }
    }
    duplicateOfferRecheckCv_.notify_all();
}

void VersusApp::cancelDuplicateOfferRechecks(
    bool disableAdmission,
    const char *reason) {
    std::vector<PendingDuplicateOfferRecheck> canceledJobs;
    {
        std::lock_guard<std::mutex> lock(duplicateOfferRecheckMutex_);
        if (disableAdmission) {
            duplicateOfferRecheckAccepting_ = false;
        }
        canceledJobs.reserve(duplicateOfferRechecks_.size());
        for (auto &[_, job] : duplicateOfferRechecks_) {
            job.state = PendingDuplicateOfferRecheck::State::Canceling;
            canceledJobs.push_back(job);
        }
        if (++duplicateOfferRecheckEpoch_ == 0) {
            ++duplicateOfferRecheckEpoch_;
        }
        ++duplicateOfferRecheckRevision_;
    }
    duplicateOfferRecheckCv_.notify_all();
    for (const auto &job : canceledJobs) {
        cancelDuplicateOfferRecheckJob(
            job,
            DuplicateOfferRecheckDisposition::Canceled,
            reason ? reason : "unspecified");
    }
    if (!canceledJobs.empty()) {
        spdlog::info(
            "[Signaling] Completed cancellation barrier for {} duplicate offer recheck(s) reason={}",
            canceledJobs.size(),
            reason ? reason : "unspecified");
    }
}

void VersusApp::cancelDuplicateOfferRecheck(
    const std::shared_ptr<PeerSession> &peer,
    const char *reason) {
    if (!peer) {
        return;
    }
    const std::string ownerKey = makePeerKey(peer->uuid, peer->session);
    std::optional<PendingDuplicateOfferRecheck> canceledJob;
    {
        std::lock_guard<std::mutex> lock(duplicateOfferRecheckMutex_);
        const auto it = duplicateOfferRechecks_.find(ownerKey);
        if (it != duplicateOfferRechecks_.end() &&
            it->second.peer.lock().get() == peer.get()) {
            it->second.state = PendingDuplicateOfferRecheck::State::Canceling;
            canceledJob = it->second;
            ++duplicateOfferRecheckRevision_;
        }
    }
    duplicateOfferRecheckCv_.notify_all();
    if (canceledJob) {
        cancelDuplicateOfferRecheckJob(
            *canceledJob,
            DuplicateOfferRecheckDisposition::Canceled,
            reason ? reason : "unspecified");
    }
}

bool VersusApp::scheduleDuplicateOfferRecheck(
    const std::shared_ptr<PeerSession> &peer,
    const char *reason) {
    if (!peer || !peer->client) {
        return false;
    }

    for (;;) {
        PendingDuplicateOfferRecheck job;
        job.peer = peer;
        job.ownerKey = makePeerKey(peer->uuid, peer->session);
        job.uuid = peer->uuid;
        job.ownerSession = peer->session;
        job.reason = reason ? reason : "unspecified";
        job.deadlineMs = steadyNowMs() + 1000;
        job.control = std::make_shared<DuplicateOfferRecheckControl>();
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            if (peer->removed || peer->sessionInitializing) {
                return false;
            }
            job.activeWireSession = peer->activeWireSession;
            job.offerGeneration = peer->activeOfferGeneration;
            job.transportGeneration = peer->activeTransportGeneration;
            job.clientGeneration = peer->clientTransportGeneration;
        }
        if (job.activeWireSession.empty() || job.transportGeneration == 0 ||
            job.clientGeneration == 0) {
            spdlog::info(
                "[Signaling] Ignoring duplicate offer request without an active transport uuid={} activeSession={} reason={}",
                job.uuid,
                job.activeWireSession,
                job.reason);
            return true;
        }

        std::optional<PendingDuplicateOfferRecheck> supersededJob;
        bool inserted = false;
        {
            std::lock_guard<std::mutex> lock(duplicateOfferRecheckMutex_);
            if (!duplicateOfferRecheckRunning_ ||
                duplicateOfferRecheckStopRequested_ ||
                !duplicateOfferRecheckAccepting_) {
                return false;
            }
            const auto existing = duplicateOfferRechecks_.find(job.ownerKey);
            if (existing != duplicateOfferRechecks_.end()) {
                const auto existingPeer = existing->second.peer.lock();
                const bool sameTransport =
                    existing->second.state !=
                        PendingDuplicateOfferRecheck::State::Canceling &&
                    existingPeer.get() == peer.get() &&
                    existing->second.activeWireSession == job.activeWireSession &&
                    existing->second.transportGeneration == job.transportGeneration &&
                    existing->second.clientGeneration == job.clientGeneration;
                if (sameTransport) {
                    peer->duplicateOfferRechecksCoalesced.fetch_add(
                        1,
                        std::memory_order_relaxed);
                    spdlog::info(
                        "[Signaling] Coalesced unresolved duplicate offer recheck uuid={} activeSession={} offerGeneration={} transportGeneration={} clientGeneration={} delayMs=1000 reason={}",
                        existing->second.uuid,
                        existing->second.activeWireSession,
                        existing->second.offerGeneration,
                        existing->second.transportGeneration,
                        existing->second.clientGeneration,
                        existing->second.reason);
                    return true;
                }
                existing->second.state =
                    PendingDuplicateOfferRecheck::State::Canceling;
                supersededJob = existing->second;
                ++duplicateOfferRecheckRevision_;
            } else {
                if (++duplicateOfferRecheckSerial_ == 0) {
                    ++duplicateOfferRecheckSerial_;
                }
                job.serial = duplicateOfferRecheckSerial_;
                job.schedulerEpoch = duplicateOfferRecheckEpoch_;
                job.state = PendingDuplicateOfferRecheck::State::Waiting;
                duplicateOfferRechecks_[job.ownerKey] = job;
                ++duplicateOfferRecheckRevision_;
                peer->duplicateOfferRecheckPending.store(
                    true,
                    std::memory_order_relaxed);
                peer->duplicateOfferRechecksScheduled.fetch_add(
                    1,
                    std::memory_order_relaxed);
                spdlog::info(
                    "[Signaling] Scheduled unresolved duplicate offer recheck uuid={} activeSession={} offerGeneration={} transportGeneration={} clientGeneration={} delayMs=1000 reason={} ownerSession={} serial={}",
                    job.uuid,
                    job.activeWireSession,
                    job.offerGeneration,
                    job.transportGeneration,
                    job.clientGeneration,
                    job.reason,
                    job.ownerSession,
                    job.serial);
                recordPeerEvent(
                    peer,
                    "duplicate-offer-recheck-scheduled generation=" +
                        std::to_string(job.transportGeneration));
                inserted = true;
            }
        }

        if (supersededJob) {
            cancelDuplicateOfferRecheckJob(
                *supersededJob,
                DuplicateOfferRecheckDisposition::Stale,
                "superseded-transport");
            continue;
        }
        if (!inserted) {
            return false;
        }

        {
            std::function<void(uint64_t)> hook;
            {
                std::lock_guard<std::mutex> hookLock(
                    duplicateOfferRecheckTestHookMutex_);
                hook = afterDuplicateOfferRecheckMapInsertForTesting_;
            }
            if (hook) {
                hook(job.serial);
            }
        }
        duplicateOfferRecheckCv_.notify_all();
        return true;
    }
}

void VersusApp::duplicateOfferRecheckSchedulerLoop() {
    std::unique_lock<std::mutex> lock(duplicateOfferRecheckMutex_);
    for (;;) {
        duplicateOfferRecheckCv_.wait(lock, [this]() {
            return duplicateOfferRecheckStopRequested_ ||
                !duplicateOfferRechecks_.empty();
        });
        if (duplicateOfferRecheckStopRequested_) {
            return;
        }

        auto due = duplicateOfferRechecks_.end();
        for (auto it = duplicateOfferRechecks_.begin();
             it != duplicateOfferRechecks_.end();
             ++it) {
            if (it->second.state != PendingDuplicateOfferRecheck::State::Waiting) {
                continue;
            }
            if (due == duplicateOfferRechecks_.end() ||
                it->second.deadlineMs < due->second.deadlineMs) {
                due = it;
            }
        }
        if (due == duplicateOfferRechecks_.end()) {
            const uint64_t revision = duplicateOfferRecheckRevision_;
            duplicateOfferRecheckCv_.wait(lock, [this, revision]() {
                return duplicateOfferRecheckStopRequested_ ||
                    duplicateOfferRecheckRevision_ != revision;
            });
            continue;
        }

        const int64_t nowMs = steadyNowMs();
        if (due->second.deadlineMs > nowMs) {
            const uint64_t revision = duplicateOfferRecheckRevision_;
            duplicateOfferRecheckCv_.wait_for(
                lock,
                std::chrono::milliseconds(due->second.deadlineMs - nowMs),
                [this, revision]() {
                    return duplicateOfferRecheckStopRequested_ ||
                        duplicateOfferRecheckRevision_ != revision;
                });
            continue;
        }

        due->second.state = PendingDuplicateOfferRecheck::State::Dispatched;
        const PendingDuplicateOfferRecheck job = due->second;
        if (auto peer = job.peer.lock()) {
            peer->duplicateOfferRechecksFired.fetch_add(1, std::memory_order_relaxed);
        }
        lock.unlock();
        const auto enqueueResult = peerOperationExecutor_.enqueue(
            job.serial,
            job.ownerKey,
            GenerationTaggedPeerOperationExecutor::Priority::Critical,
            "duplicate-offer-recheck",
            [this,
             ownerKey = job.ownerKey,
             serial = job.serial,
             epoch = job.schedulerEpoch](uint64_t scheduledSerial) {
                std::lock_guard<std::mutex> schedulerLock(
                    duplicateOfferRecheckMutex_);
                const auto current = duplicateOfferRechecks_.find(ownerKey);
                return duplicateOfferRecheckRunning_ &&
                    duplicateOfferRecheckAccepting_ &&
                    !duplicateOfferRecheckStopRequested_ &&
                    scheduledSerial == serial &&
                    current != duplicateOfferRechecks_.end() &&
                    current->second.serial == serial &&
                    current->second.schedulerEpoch == epoch &&
                    current->second.state ==
                        PendingDuplicateOfferRecheck::State::Dispatched;
            },
            [this, job](uint64_t) { runDuplicateOfferRecheck(job); },
            GenerationTaggedPeerOperationExecutor::Criticality::Convergent,
            [this, job](
                uint64_t,
                GenerationTaggedPeerOperationExecutor::CompletionDisposition
                    disposition) {
                handleDuplicateOfferRecheckExecutorCompletion(
                    job,
                    disposition);
            });
        if (!GenerationTaggedPeerOperationExecutor::accepted(enqueueResult)) {
            spdlog::warn(
                "[Signaling] Duplicate offer recheck enqueue rejected uuid={} activeSession={} serial={} result={}",
                job.uuid,
                job.activeWireSession,
                job.serial,
                peerOperationEnqueueResultName(enqueueResult));
        }
        lock.lock();
    }
}

void VersusApp::runDuplicateOfferRecheck(
    const PendingDuplicateOfferRecheck &job) {
    auto peer = job.peer.lock();
    if (!peer) {
        cancelDuplicateOfferRecheckJob(
            job,
            DuplicateOfferRecheckDisposition::Stale,
            "peer-expired");
        return;
    }
    {
        std::lock_guard<std::mutex> schedulerLock(
            duplicateOfferRecheckMutex_);
        const auto current = duplicateOfferRechecks_.find(job.ownerKey);
        if (!duplicateOfferRecheckRunning_ ||
            !duplicateOfferRecheckAccepting_ ||
            duplicateOfferRecheckStopRequested_ ||
            current == duplicateOfferRechecks_.end() ||
            current->second.serial != job.serial ||
            current->second.schedulerEpoch != job.schedulerEpoch ||
            current->second.state !=
                PendingDuplicateOfferRecheck::State::Dispatched) {
            return;
        }
    }
    {
        std::function<void(uint64_t)> hook;
        {
            std::lock_guard<std::mutex> hookLock(
                duplicateOfferRecheckTestHookMutex_);
            hook = beforeDuplicateOfferRecheckExecutionForTesting_;
        }
        if (hook) {
            hook(job.serial);
        }
    }

    if (!job.control) {
        completeDuplicateOfferRecheck(
            job,
            DuplicateOfferRecheckDisposition::Stale,
            "missing-control");
        return;
    }

    DuplicateOfferRecheckDisposition disposition =
        DuplicateOfferRecheckDisposition::Stale;
    {
        std::lock_guard<std::recursive_mutex> callbackLock(
            peer->callbackOperationMutex);
        std::lock_guard<std::recursive_mutex> clientLock(
            peer->clientOperationMutex);

        std::unique_lock<std::mutex> executionBarrier(
            job.control->barrierMutex);
        if (job.control->disposition !=
            DuplicateOfferRecheckDisposition::None) {
            disposition = job.control->disposition;
        } else {
            bool admitted = false;
            {
                std::lock_guard<std::mutex> schedulerLock(
                    duplicateOfferRecheckMutex_);
                const auto current = duplicateOfferRechecks_.find(job.ownerKey);
                admitted = duplicateOfferRecheckRunning_ &&
                    duplicateOfferRecheckAccepting_ &&
                    !duplicateOfferRecheckStopRequested_ &&
                    current != duplicateOfferRechecks_.end() &&
                    current->second.serial == job.serial &&
                    current->second.schedulerEpoch == job.schedulerEpoch &&
                    current->second.state ==
                        PendingDuplicateOfferRecheck::State::Dispatched;
            }
            if (!admitted) {
                job.control->canceled = true;
                disposition = DuplicateOfferRecheckDisposition::Canceled;
            } else {
                bool mappedOwner = false;
                {
                    std::lock_guard<std::mutex> mapLock(peerSessionsMutex_);
                    const auto current = peerSessions_.find(job.uuid);
                    mappedOwner = current != peerSessions_.end() &&
                        current->second && current->second.get() == peer.get();
                }
                bool exactTransport = false;
                {
                    std::lock_guard<std::mutex> negotiationLock(
                        peer->negotiationMutex);
                    // VDO.Ninja keys the grace period to PeerConnection
                    // identity, not an ordinary offer generation on that same
                    // transport.
                    exactTransport = mappedOwner && !peer->removed &&
                        peer->session == job.ownerSession &&
                        peer->activeWireSession == job.activeWireSession &&
                        peer->activeTransportGeneration ==
                            job.transportGeneration &&
                        peer->clientTransportGeneration == job.clientGeneration;
                }
                if (exactTransport && peer->client) {
                    const webrtc::ConnectionState state =
                        peer->client->connectionState();
                    if (state == webrtc::ConnectionState::Connected) {
                        disposition =
                            DuplicateOfferRecheckDisposition::Connected;
                        spdlog::info(
                            "[Signaling] Duplicate offer recheck canceled uuid={} activeSession={} offerGeneration={} transportGeneration={} clientGeneration={} reason=connected",
                            job.uuid,
                            job.activeWireSession,
                            job.offerGeneration,
                            job.transportGeneration,
                            job.clientGeneration);
                    } else {
                        std::function<void(uint64_t)> beforeSendHook;
                        {
                            std::lock_guard<std::mutex> hookLock(
                                duplicateOfferRecheckTestHookMutex_);
                            beforeSendHook =
                                beforeDuplicateOfferRecheckSendForTesting_;
                        }
                        if (beforeSendHook) {
                            beforeSendHook(job.serial);
                        }
                        spdlog::info(
                            "[Signaling] Duplicate offer recheck replacing unresolved transport uuid={} activeSession={} offerGeneration={} transportGeneration={} clientGeneration={} reason={}",
                            job.uuid,
                            job.activeWireSession,
                            job.offerGeneration,
                            job.transportGeneration,
                            job.clientGeneration,
                            job.reason);
                        (void)sendPeerOffer(
                            peer,
                            "duplicate-offer-recheck",
                            true);
                        bool transportChanged = false;
                        {
                            std::lock_guard<std::mutex> negotiationLock(
                                peer->negotiationMutex);
                            transportChanged =
                                peer->activeWireSession !=
                                    job.activeWireSession &&
                                peer->activeTransportGeneration >
                                    job.transportGeneration &&
                                peer->clientTransportGeneration !=
                                    job.clientGeneration;
                        }
                        disposition = transportChanged
                            ? DuplicateOfferRecheckDisposition::Rebuilt
                            : DuplicateOfferRecheckDisposition::RebuildFailed;
                    }
                } else {
                    disposition = DuplicateOfferRecheckDisposition::Stale;
                }
            }
            job.control->disposition = disposition;
        }
    }
    completeDuplicateOfferRecheck(job, disposition, "executed");
}

void VersusApp::completeDuplicateOfferRecheck(
    const PendingDuplicateOfferRecheck &job,
    DuplicateOfferRecheckDisposition disposition,
    const char *detail) {
    std::lock_guard<std::mutex> schedulerLock(
        duplicateOfferRecheckMutex_);
    const auto current = duplicateOfferRechecks_.find(job.ownerKey);
    if (current == duplicateOfferRechecks_.end() ||
        current->second.serial != job.serial ||
        current->second.schedulerEpoch != job.schedulerEpoch) {
        return;
    }

    auto peer = job.peer.lock();
    duplicateOfferRechecks_.erase(current);
    ++duplicateOfferRecheckRevision_;
    if (peer) {
        peer->duplicateOfferRecheckPending.store(
            false,
            std::memory_order_relaxed);
    }

    switch (disposition) {
        case DuplicateOfferRecheckDisposition::Connected:
            if (peer) {
                peer->duplicateOfferRechecksIgnoredConnected.fetch_add(
                    1,
                    std::memory_order_relaxed);
                recordPeerEvent(
                    peer,
                    "duplicate-offer-recheck-canceled reason=connected");
            }
            break;
        case DuplicateOfferRecheckDisposition::Rebuilt:
            if (peer) {
                peer->duplicateOfferRechecksRebuilt.fetch_add(
                    1,
                    std::memory_order_relaxed);
                recordPeerEvent(
                    peer,
                    "duplicate-offer-recheck-rebuilt generation=" +
                        std::to_string(job.transportGeneration));
            }
            break;
        case DuplicateOfferRecheckDisposition::RebuildFailed:
            if (peer) {
                peer->duplicateOfferRechecksCanceled.fetch_add(
                    1,
                    std::memory_order_relaxed);
            }
            spdlog::warn(
                "[Signaling] Duplicate offer recheck failed to replace transport uuid={} activeSession={} transportGeneration={} clientGeneration={}",
                job.uuid,
                job.activeWireSession,
                job.transportGeneration,
                job.clientGeneration);
            break;
        case DuplicateOfferRecheckDisposition::Stale:
            if (peer) {
                peer->duplicateOfferRechecksStale.fetch_add(
                    1,
                    std::memory_order_relaxed);
            }
            spdlog::info(
                "[Signaling] Duplicate offer recheck canceled uuid={} activeSession={} offerGeneration={} transportGeneration={} clientGeneration={} reason=stale-transport detail={}",
                job.uuid,
                job.activeWireSession,
                job.offerGeneration,
                job.transportGeneration,
                job.clientGeneration,
                detail ? detail : "unspecified");
            break;
        case DuplicateOfferRecheckDisposition::Canceled:
        case DuplicateOfferRecheckDisposition::ExecutorEvicted:
        case DuplicateOfferRecheckDisposition::ExecutorRejected:
        case DuplicateOfferRecheckDisposition::ExecutorDropped:
        case DuplicateOfferRecheckDisposition::ExecutorSuperseded:
        case DuplicateOfferRecheckDisposition::ExecutorStale:
        case DuplicateOfferRecheckDisposition::ExecutorThrew:
            if (peer) {
                peer->duplicateOfferRechecksCanceled.fetch_add(
                    1,
                    std::memory_order_relaxed);
            }
            spdlog::info(
                "[Signaling] Canceled duplicate offer recheck uuid={} ownerSession={} activeSession={} serial={} reason={}",
                job.uuid,
                job.ownerSession,
                job.activeWireSession,
                job.serial,
                detail ? detail : "unspecified");
            break;
        case DuplicateOfferRecheckDisposition::None:
        default:
            if (peer) {
                peer->duplicateOfferRechecksCanceled.fetch_add(
                    1,
                    std::memory_order_relaxed);
            }
            spdlog::warn(
                "[Signaling] Duplicate offer recheck completed without a disposition uuid={} activeSession={} serial={}",
                job.uuid,
                job.activeWireSession,
                job.serial);
            break;
    }
    duplicateOfferRecheckCv_.notify_all();
}

void VersusApp::cancelDuplicateOfferRecheckJob(
    const PendingDuplicateOfferRecheck &job,
    DuplicateOfferRecheckDisposition disposition,
    const char *detail) {
    DuplicateOfferRecheckDisposition finalDisposition = disposition;
    if (job.control) {
        std::lock_guard<std::mutex> executionBarrier(
            job.control->barrierMutex);
        if (job.control->disposition ==
            DuplicateOfferRecheckDisposition::None) {
            job.control->canceled = true;
            job.control->disposition = disposition;
        }
        finalDisposition = job.control->disposition;
    }
    completeDuplicateOfferRecheck(job, finalDisposition, detail);
}

void VersusApp::handleDuplicateOfferRecheckExecutorCompletion(
    const PendingDuplicateOfferRecheck &job,
    GenerationTaggedPeerOperationExecutor::CompletionDisposition disposition) {
    using ExecutorDisposition =
        GenerationTaggedPeerOperationExecutor::CompletionDisposition;
    if (disposition == ExecutorDisposition::Executed) {
        return;
    }

    DuplicateOfferRecheckDisposition appDisposition =
        DuplicateOfferRecheckDisposition::ExecutorRejected;
    const char *detail = "executor-rejected";
    switch (disposition) {
        case ExecutorDisposition::Evicted:
            appDisposition =
                DuplicateOfferRecheckDisposition::ExecutorEvicted;
            detail = "executor-evicted";
            break;
        case ExecutorDisposition::DroppedOnStop:
            appDisposition =
                DuplicateOfferRecheckDisposition::ExecutorDropped;
            detail = "executor-stopped";
            break;
        case ExecutorDisposition::Superseded:
            appDisposition =
                DuplicateOfferRecheckDisposition::ExecutorSuperseded;
            detail = "executor-superseded";
            break;
        case ExecutorDisposition::StaleGeneration:
            appDisposition = DuplicateOfferRecheckDisposition::ExecutorStale;
            detail = "executor-stale-generation";
            break;
        case ExecutorDisposition::OperationThrew:
            appDisposition = DuplicateOfferRecheckDisposition::ExecutorThrew;
            detail = "executor-operation-threw";
            break;
        case ExecutorDisposition::RejectedInvalid:
            detail = "executor-rejected-invalid";
            break;
        case ExecutorDisposition::RejectedStopped:
            detail = "executor-rejected-stopped";
            break;
        case ExecutorDisposition::RejectedOrdinaryCapacity:
            detail = "executor-rejected-ordinary-capacity";
            break;
        case ExecutorDisposition::RejectedCriticalCapacity:
            detail = "executor-rejected-critical-capacity";
            break;
        case ExecutorDisposition::Executed:
        default:
            return;
    }
    cancelDuplicateOfferRecheckJob(job, appDisposition, detail);
}

bool VersusApp::dispatchPeerOfferToSignaling(
    const std::shared_ptr<PeerSession> &peer,
    const signaling::SignalOffer &offer,
    uint64_t offerGeneration,
    uint64_t transportGeneration,
    const std::string &reason) {
    if (!peer || offer.session.empty() || offer.sdp.empty() ||
        offerGeneration == 0 || transportGeneration == 0) {
        return false;
    }
    {
        std::lock_guard<std::mutex> diagnosticsLock(peer->diagnosticsMutex);
        if (++peer->offerDispatchSequence == 0) {
            ++peer->offerDispatchSequence;
        }
        peer->offerDispatches.push_back({
            peer->offerDispatchSequence,
            offerGeneration,
            transportGeneration,
            offer.session,
            detail::sha256Hex(offer.sdp),
            reason});
        while (peer->offerDispatches.size() > 60) {
            peer->offerDispatches.pop_front();
        }
    }
    return signaling_.sendOffer(offer);
}

bool VersusApp::dispatchPeerCandidateToSignaling(
    const std::shared_ptr<PeerSession> &peer,
    const signaling::SignalCandidate &candidate,
    bool relayCandidate) {
    if (!peer) {
        return false;
    }

    if (!signaling_.sendCandidate(candidate)) {
        const int failureCount =
            peer->localCandidateSendFailures.fetch_add(1, std::memory_order_relaxed) + 1;
        spdlog::error(
            "[Signaling] Failed to send local ICE candidate uuid={} wireSessionBytes={} failureCount={}",
            peer->uuid,
            candidate.session.size(),
            failureCount);
        recordPeerEvent(
            peer,
            relayCandidate
                ? "local-candidate-send-failed relay"
                : "local-candidate-send-failed");
        return false;
    }

    peer->localCandidatesSent.fetch_add(1, std::memory_order_relaxed);
    recordPeerEvent(
        peer,
        relayCandidate ? "local-candidate-sent relay" : "local-candidate-sent");
    return true;
}

bool VersusApp::sendPeerOffer(const std::shared_ptr<PeerSession> &peer, const char *reason, bool rebuildPeerConnection) {
    if (!peer || !peer->client) {
        return false;
    }
    // App callbacks other than ICE own this lease after their final generation
    // check. ICE is intentionally excluded: WebRtcClient serializes its
    // candidate context under callbackDispatchMutex and App accounts its work
    // by offer generation, avoiding callbackDispatch -> callbackOperation
    // versus callbackOperation -> reset(callbackDispatch) deadlock.
    std::lock_guard<std::recursive_mutex> callbackGenerationLock(
        peer->callbackOperationMutex);
    // Serialize generation reservation with every callback that can mutate App
    // peer state. The mutex is recursive because libdatachannel may synchronously
    // re-enter a callback while an offer/answer operation is in progress.
    std::lock_guard<std::recursive_mutex> offerClientLock(peer->clientOperationMutex);

    const std::string requestedReason = reason ? reason : "unspecified";
    if (rebuildPeerConnection) {
        // The VDO.Ninja watchdog can wait more than 45 seconds before asking
        // for a restart. Refresh the bounded logical-session retention as soon
        // as the request is accepted, even if another offer must finish first.
        peer->disconnectedSinceMs.store(steadyNowMs(), std::memory_order_relaxed);
    }
    uint64_t offerGeneration = 0;
    bool rebuild = rebuildPeerConnection;
    bool coalescedTransition = false;
    uint64_t coalescedGeneration = 0;
    std::string offerWireSession;
    std::string retiredWireSession;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed || peer->sessionInitializing) {
            return false;
        }

        const bool unresolvedOffer = peer->offerCreationInProgress ||
            (peer->offerDispatched && !peer->answerReceived);
        const bool operationBusy = peer->answerApplicationInProgress ||
            peer->mediaPlanApplicationInProgress;
        // A requested rebuild means the existing PeerConnection is no longer
        // an acceptable answer to the request. In particular, an outstanding
        // offer cannot satisfy an ICE restart. Only an active answer/media
        // mutation may defer the replacement; its completion drains this
        // queued rebuild.
        if (operationBusy ||
            (unresolvedOffer && !peer->transportRetired && !rebuild)) {
            coalescedTransition = true;
            coalescedGeneration = peer->activeOfferGeneration;
            peer->queuedOfferTransition = true;
            peer->queuedOfferRebuild = peer->queuedOfferRebuild || rebuild;
            if (peer->queuedOfferReason.empty() || rebuild) {
                peer->queuedOfferReason = requestedReason;
            }
            peer->renegotiationQueued.store(true, std::memory_order_relaxed);
        } else {
            // A terminal transport retires the unresolved wire generation. The
            // next queued/requested transition must rebuild that transport while
            // retaining the logical VDO.Ninja session.
            rebuild = rebuild || peer->transportRetired;
            rebuild = rebuild || peer->queuedOfferRebuild;
            peer->queuedOfferTransition = false;
            peer->queuedOfferRebuild = false;
            peer->queuedMediaPlan = false;
            peer->queuedOfferReason.clear();
            peer->renegotiationQueued.store(false, std::memory_order_relaxed);

            if (peer->activeTransportGeneration == 0) {
                peer->activeTransportGeneration = 1;
            } else if (rebuild) {
                ++peer->activeTransportGeneration;
            }
            if (rebuild) {
                // Invalidate every callback from the retiring client transport
                // atomically with reserving the replacement wire generation.
                peer->clientTransportGeneration = 0;
                retiredWireSession = peer->activeWireSession;
                peer->activeWireSession = generatePeerSessionId();
            }
            offerGeneration = ++peer->activeOfferGeneration;
            offerWireSession = peer->activeWireSession;
            peer->offerCreationInProgress = true;
            peer->answerReceived = false;
            peer->offerDispatched = false;
            peer->lastLocalOfferSdp.clear();
            peer->candidateType = "local";
            peer->transportRetired = false;
            peer->offerCount.fetch_add(1, std::memory_order_relaxed);
            if (rebuild) {
                peer->recoveryOfferCount.fetch_add(1, std::memory_order_relaxed);
            }
            {
                std::lock_guard<std::mutex> diagnosticsLock(peer->diagnosticsMutex);
                peer->lastOfferReason = requestedReason;
            }
        }
    }

    if (coalescedTransition) {
        spdlog::info("[App] Coalesced offer transition {}:{} generation={} reason={} rebuild={}",
                     peer->uuid,
                     peer->session,
                     coalescedGeneration,
                     requestedReason,
                     rebuild);
        recordPeerEvent(peer,
                        std::string("offer-transition-queued") +
                            " generation=" + std::to_string(coalescedGeneration) +
                            " reason=" + requestedReason);
        return true;
    }
    if (!retiredWireSession.empty() && retiredWireSession != offerWireSession) {
        std::lock_guard<std::mutex> mapLock(peerSessionsMutex_);
        pendingRemoteCandidates_.erase(makePeerKey(peer->uuid, retiredWireSession));
    }
    recordPeerEvent(peer, std::string("offer-start generation=") + std::to_string(offerGeneration) +
                              " reason=" + requestedReason +
                              (rebuild ? " rebuild=1" : " rebuild=0"));

    bool clientOperationOk = true;
    std::string offerSdp;
    {
        std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            clientOperationOk = !peer->removed &&
                peer->offerCreationInProgress &&
                peer->activeOfferGeneration == offerGeneration &&
                peer->activeWireSession == offerWireSession;
        }
        if (rebuild) {
            // WebRtcClient owns the immutable, validated ICE snapshot from
            // initialization. Every reset reuses that exact rtc::Configuration;
            // recovery cannot substitute a later process-wide server list.
            peer->disconnectedSinceMs.store(steadyNowMs(), std::memory_order_relaxed);
            const bool wantVideo = peer->videoEnabled.load(std::memory_order_relaxed);
            const bool wantAudio = peer->audioEnabled.load(std::memory_order_relaxed);
            const VideoStateSnapshot videoState = videoStateSnapshot();
            // Preserve the reserved alpha transceiver on every transport
            // generation, but only activate it for an opted-in receiver.
            // WebRtcClient retains the reserved section's position before data.
            const bool wantAlpha = wantVideo && usesVp9AlphaTrack(videoState.config) &&
                peer->alphaAllowed.load(std::memory_order_relaxed);

            spdlog::info("[App] Rebuilding peer connection {}:{} reason={} media video={} audio={} alpha={}",
                         peer->uuid,
                         peer->session,
                         requestedReason,
                         wantVideo,
                         wantAudio,
                         wantAlpha);
            // Retire every pair completed before this reset reservation. The
            // operation mutex held by sendPeerOffer also prevents a live pair
            // from being split across the old and replacement transports.
            reservePeerAlphaAdmissionCutoff(peer);
            if (clientOperationOk &&
                !peer->client->resetPeerConnection(wantVideo, wantAudio, wantAlpha)) {
                spdlog::error("[WebRTC] Failed to rebuild peer connection for {}:{} during recovery offer",
                              peer->uuid,
                              peer->session);
                clientOperationOk = false;
            }
            if (clientOperationOk) {
                const uint64_t rebuiltClientGeneration = peer->client->transportGeneration();
                std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
                if (!peer->removed &&
                    peer->activeOfferGeneration == offerGeneration &&
                    peer->activeWireSession == offerWireSession) {
                    peer->clientTransportGeneration = rebuiltClientGeneration;
                } else {
                    clientOperationOk = false;
                }
            }
            if (clientOperationOk) {
                peer->dataChannelOpen.store(false, std::memory_order_relaxed);
                spdlog::info(
                    "[App] Rebuilt peer transport uuid={} retiredSession={} activeSession={} generation={} reason={}",
                    peer->uuid,
                    retiredWireSession,
                    offerWireSession,
                    offerGeneration,
                    requestedReason);
            }
            if (clientOperationOk && wantVideo && !peer->client->hasConfiguredVideoTrack()) {
                spdlog::error("[WebRTC] Failed to restore video track for {}:{} during recovery offer",
                              peer->uuid,
                              peer->session);
                clientOperationOk = false;
            }
            if (clientOperationOk && wantAudio && !peer->client->hasConfiguredAudioTrack()) {
                spdlog::error("[WebRTC] Failed to restore audio track for {}:{} during recovery offer",
                              peer->uuid,
                              peer->session);
                clientOperationOk = false;
            }
            if (clientOperationOk && (wantVideo || wantAudio || wantAlpha)) {
                peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
                reservePeerAlphaAdmissionCutoff(peer);
                pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
                lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
            }
        }

        if (clientOperationOk) {
            spdlog::info("[App] Creating offer {}:{} reason={} rebuildPeerConnection={}",
                         peer->uuid,
                         peer->session,
                         requestedReason,
                         rebuild);
            offerSdp = peer->client->createOffer();
            clientOperationOk = !offerSdp.empty();
        }
    }

    if (!clientOperationOk || offerSdp.empty()) {
        spdlog::error("[WebRTC] Failed to create offer for {}:{} (reason={})",
                      peer->uuid,
                      peer->session,
                      requestedReason);
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            if (peer->activeOfferGeneration == offerGeneration &&
                peer->activeWireSession == offerWireSession) {
                peer->offerCreationInProgress = false;
                peer->offerDispatched = false;
                peer->transportRetired = true;
            }
        }
        int64_t expected = 0;
        peer->disconnectedSinceMs.compare_exchange_strong(
            expected,
            steadyNowMs(),
            std::memory_order_relaxed,
            std::memory_order_relaxed);
        recordPeerEvent(peer, "offer-create-failed");
        return false;
    }

    signaling::SignalOffer offer;
    offer.uuid = peer->uuid;
    offer.session = offerWireSession;
    offer.streamId = peer->streamId;
    offer.sdp = offerSdp;

    bool sent = false;
    {
        std::lock_guard<std::mutex> signalingLock(signalingOpsMutex_);
        bool stillCurrent = false;
        uint64_t dispatchTransportGeneration = 0;
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            stillCurrent = !peer->removed &&
                peer->offerCreationInProgress &&
                peer->activeOfferGeneration == offerGeneration &&
                peer->activeWireSession == offerWireSession;
            if (stillCurrent) {
                peer->offerCreationInProgress = false;
                peer->offerDispatched = true;
                peer->lastLocalOfferSdp = offerSdp;
                dispatchTransportGeneration =
                    peer->activeTransportGeneration;
            }
        }
        if (!stillCurrent) {
            spdlog::warn("[App] Offer generation changed before dispatch {}:{} expected={}",
                         peer->uuid,
                         peer->session,
                         offerGeneration);
            return false;
        }
        sent = dispatchPeerOfferToSignaling(
            peer,
            offer,
            offerGeneration,
            dispatchTransportGeneration,
            requestedReason);
        if (!sent) {
            spdlog::error("[Signaling] Failed to send offer for {}:{} (reason={})",
                          peer->uuid,
                          peer->session,
                          requestedReason);
            recordPeerEvent(peer, "offer-send-failed");
        }
    }
    if (!sent) {
        // The offer never reached the wire. Revert the dispatched flag so new
        // candidates buffer for the next attempt instead of being sent against
        // an offer the receiver never saw.
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            if (peer->activeOfferGeneration == offerGeneration &&
                peer->activeWireSession == offerWireSession) {
                peer->offerDispatched = false;
            }
        }
        int64_t expected = 0;
        peer->disconnectedSinceMs.compare_exchange_strong(
            expected,
            steadyNowMs(),
            std::memory_order_relaxed,
            std::memory_order_relaxed);
        return false;
    }

    std::vector<PendingCandidate> bufferedCandidates;
    std::string candidateType = "local";
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed ||
            peer->activeOfferGeneration != offerGeneration ||
            peer->activeWireSession != offerWireSession) {
            return false;
        }
        auto pending = peer->pendingCandidates.begin();
        while (pending != peer->pendingCandidates.end()) {
            if (pending->clientTransportGeneration ==
                peer->clientTransportGeneration) {
                bufferedCandidates.push_back(*pending);
            } else {
                recordPeerEvent(
                    peer, "local-candidate-dropped retired-transport-generation");
            }
            pending = peer->pendingCandidates.erase(pending);
        }
        candidateType = peer->candidateType;
    }

    bool allBufferedCandidatesSent = true;
    for (const auto &pending : bufferedCandidates) {
        signaling::SignalCandidate cand;
        cand.uuid = peer->uuid;
        cand.candidate = pending.candidate;
        cand.mid = pending.mid;
        cand.mlineIndex = pending.mlineIndex;
        cand.session = offerWireSession;
        cand.type = candidateType;
        {
            std::lock_guard<std::mutex> signalingLock(signalingOpsMutex_);
            bool stillCurrent = false;
            {
                std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
                stillCurrent = !peer->removed &&
                    peer->clientTransportGeneration ==
                        pending.clientTransportGeneration &&
                    peer->activeWireSession == offerWireSession &&
                    peer->offerDispatched;
            }
            if (!stillCurrent) {
                recordPeerEvent(peer, "local-candidate-dropped superseded-transport");
                continue;
            }
            if (!dispatchPeerCandidateToSignaling(
                    peer,
                    cand,
                    toLowerCopy(pending.candidate).find(" typ relay") !=
                        std::string::npos)) {
                allBufferedCandidatesSent = false;
            }
        }
    }
    recordPeerEvent(peer, std::string("offer-sent generation=") + std::to_string(offerGeneration) +
                              " reason=" + requestedReason);
    return allBufferedCandidatesSent;
}

void VersusApp::runQueuedPeerTransition(const std::shared_ptr<PeerSession> &peer, const char *trigger) {
    if (!peer || !peer->client) {
        return;
    }

    bool rebuild = false;
    bool applyMediaPlan = false;
    std::string reason;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed || !peer->queuedOfferTransition) {
            return;
        }
        const bool unresolvedOffer = peer->offerCreationInProgress ||
            (peer->offerDispatched && !peer->answerReceived);
        if (peer->answerApplicationInProgress ||
            peer->mediaPlanApplicationInProgress ||
            (unresolvedOffer && !peer->transportRetired &&
             !peer->queuedOfferRebuild)) {
            return;
        }

        rebuild = peer->queuedOfferRebuild || peer->transportRetired;
        applyMediaPlan = peer->queuedMediaPlan && !rebuild;
        reason = peer->queuedOfferReason.empty() ? "queued-transition" : peer->queuedOfferReason;
        peer->queuedOfferTransition = false;
        peer->queuedOfferRebuild = false;
        peer->queuedMediaPlan = false;
        peer->queuedOfferReason.clear();
        peer->renegotiationQueued.store(false, std::memory_order_relaxed);
    }

    spdlog::info("[App] Running queued peer transition {}:{} trigger={} reason={} rebuild={} mediaPlan={}",
                 peer->uuid,
                 peer->session,
                 trigger ? trigger : "unspecified",
                 reason,
                 rebuild,
                 applyMediaPlan);
    if (applyMediaPlan) {
        applyPeerMediaPlan(peer, reason.c_str());
    } else {
        sendPeerOffer(peer, reason.c_str(), rebuild);
    }
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
        {
            std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
            peer->client->setVideoCodec(webrtc::PeerConfig::VideoCodec::H264, false);
        }
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
                updateRoomQualityDecisionForCodecLocked();
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
        updateRoomQualityDecisionForCodecLocked();
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
    syncRoomQualityDecision();

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
        {
            std::lock_guard<std::recursive_mutex> clientLock(session->clientOperationMutex);
            session->client->setVideoCodec(webrtc::PeerConfig::VideoCodec::H264, false);
        }
        const char *reason = session.get() == peer.get()
            ? "video-codec-fallback-h264"
            : "global-video-codec-fallback-h264";
        if (sendPeerOffer(session, reason, true) && session.get() == peer.get()) {
            sentTriggerPeerOffer = true;
        }
    }
    return sentTriggerPeerOffer;
}

void VersusApp::applyPeerAnswer(const std::shared_ptr<PeerSession> &peer,
                                const std::string &sdp,
                                const char *source,
                                const std::string &expectedWireSession) {
    if (!peer || !peer->client || sdp.empty()) {
        return;
    }

    uint64_t answerGeneration = 0;
    uint64_t answerTransportGeneration = 0;
    std::string answerWireSession;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed) {
            return;
        }
        if (!expectedWireSession.empty() &&
            peer->activeWireSession != expectedWireSession) {
            spdlog::warn(
                "[App] Rejecting stale-session answer before SDP apply uuid={} session={} activeSession={} source={}",
                peer->uuid,
                expectedWireSession,
                peer->activeWireSession,
                source ? source : "unknown");
            recordPeerEvent(peer, "answer-ignored stale-wire-session");
            return;
        }
        answerWireSession = peer->activeWireSession;
        if (peer->offerCreationInProgress || !peer->offerDispatched) {
            spdlog::warn("[App] Ignoring answer before offer dispatch {}:{} source={}",
                         peer->uuid,
                         peer->session,
                         source ? source : "unknown");
            recordPeerEvent(peer, "answer-ignored offer-not-dispatched");
            return;
        }

        if (peer->answerReceived || peer->answerApplicationInProgress) {
            spdlog::info("[App] Ignoring stale or replayed answer {}:{} source={} generation={}",
                         peer->uuid,
                         peer->session,
                         source ? source : "unknown",
                         peer->activeOfferGeneration);
            recordPeerEvent(peer, "answer-ignored stale-or-replayed");
            return;
        }

        answerGeneration = peer->activeOfferGeneration;
        answerTransportGeneration = peer->activeTransportGeneration;
        peer->answerApplicationInProgress = true;
    }

    spdlog::info("[App] Applying peer answer {}:{} source={}",
                 peer->uuid,
                 peer->session,
                 source ? source : "unknown");

    const bool codecFallbackQueued = sdpAnswerRejectsVideoMLine(sdp) &&
        videoStateSnapshot().config.codec != video::VideoCodec::H264 &&
        fallbackToH264AfterRejectedVideoAnswer(peer, source);

    bool applied = codecFallbackQueued;
    if (!codecFallbackQueued) {
        std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
        bool stillCurrent = false;
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            stillCurrent = !peer->removed &&
                peer->answerApplicationInProgress &&
                peer->activeOfferGeneration == answerGeneration &&
                peer->activeTransportGeneration == answerTransportGeneration &&
                peer->activeWireSession == answerWireSession;
        }
        if (stillCurrent) {
            applied = peer->client->setRemoteDescription(sdp, "answer");
        }
    }

    bool runQueuedTransition = false;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed ||
            peer->activeOfferGeneration != answerGeneration ||
            peer->activeTransportGeneration != answerTransportGeneration ||
            peer->activeWireSession != answerWireSession) {
            peer->answerApplicationInProgress = false;
            return;
        }
        peer->answerApplicationInProgress = false;
        if (applied) {
            peer->answerReceived = true;
            peer->answeredOfferGeneration = answerGeneration;
            peer->answerCount.fetch_add(1, std::memory_order_relaxed);
            {
                std::lock_guard<std::mutex> diagnosticsLock(peer->diagnosticsMutex);
                peer->lastAnswerSource = source ? source : "unknown";
            }
        } else {
            // A description rejected by the transport cannot be repaired in
            // place. Retire this transport so the next offer rebuilds it.
            peer->transportRetired = true;
        }
        runQueuedTransition = peer->queuedOfferTransition;
    }

    if (!applied) {
        int64_t expected = 0;
        peer->disconnectedSinceMs.compare_exchange_strong(
            expected,
            steadyNowMs(),
            std::memory_order_relaxed,
            std::memory_order_relaxed);
        spdlog::warn("[App] Failed to apply peer answer {}:{} source={}",
                     peer->uuid,
                     peer->session,
                     source ? source : "unknown");
        recordPeerEvent(peer, std::string("answer-apply-failed source=") + (source ? source : "unknown"));
        if (runQueuedTransition) {
            runQueuedPeerTransition(peer, "answer-apply-failed");
        }
        return;
    }

    pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
    if (!codecFallbackQueued) {
        drainPendingRemoteCandidates(
            peer,
            answerGeneration,
            answerTransportGeneration,
            source ? source : "answer-applied");
    }
    recordPeerEvent(peer, std::string("answer-applied generation=") +
                              std::to_string(answerGeneration) +
                              " source=" + (source ? source : "unknown"));

    if (runQueuedTransition) {
        runQueuedPeerTransition(peer, codecFallbackQueued ? "codec-fallback-answer-consumed" : "answer-consumed");
    }
}

void VersusApp::applyPeerMediaPlan(const std::shared_ptr<PeerSession> &peer, const char *reason) {
    if (!peer || !peer->client) {
        return;
    }

    const std::string requestedReason = reason ? reason : "peer-media-plan";
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        const bool unresolvedOffer = peer->offerCreationInProgress ||
            (peer->offerDispatched && !peer->answerReceived);
        if (peer->removed) {
            return;
        }
        if (peer->answerApplicationInProgress || peer->mediaPlanApplicationInProgress ||
            unresolvedOffer || peer->transportRetired) {
            peer->queuedOfferTransition = true;
            peer->queuedMediaPlan = true;
            peer->queuedOfferRebuild = peer->queuedOfferRebuild || peer->transportRetired;
            if (peer->queuedOfferReason.empty()) {
                peer->queuedOfferReason = requestedReason;
            }
            peer->renegotiationQueued.store(true, std::memory_order_relaxed);
            spdlog::info("[App] Queued media-plan transition {}:{} reason={} generation={}",
                         peer->uuid,
                         peer->session,
                         requestedReason,
                         peer->activeOfferGeneration);
            return;
        }
        peer->mediaPlanApplicationInProgress = true;
    }

    const bool initReceived = peer->initReceived.load(std::memory_order_relaxed);
    const bool wantVideo = initReceived && peer->videoEnabled.load(std::memory_order_relaxed);
    const bool wantAudio = initReceived && peer->audioEnabled.load(std::memory_order_relaxed);
    const VideoStateSnapshot videoState = videoStateSnapshot();
    const bool wantAlpha = wantVideo &&
        usesVp9AlphaTrack(videoState.config) &&
        peer->alphaAllowed.load(std::memory_order_relaxed);

    bool dataChannelOpen = false;
    webrtc::MediaPlanChange change;
    {
        std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
        dataChannelOpen = peer->dataChannelOpen.load(std::memory_order_relaxed) ||
            peer->client->isDataChannelOpen();
        if (dataChannelOpen) {
            peer->dataChannelOpen.store(true, std::memory_order_relaxed);
            change = peer->client->ensureMediaTracks(wantVideo, wantAudio, wantAlpha);
        }
    }

    bool queuedTransition = false;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        peer->mediaPlanApplicationInProgress = false;
        queuedTransition = peer->queuedOfferTransition;
    }

    if (dataChannelOpen && change.videoAdded) {
        peer->waitingForKeyframe.store(true, std::memory_order_relaxed);
        reservePeerAlphaAdmissionCutoff(peer);
        pendingGlobalKeyframe_.store(true, std::memory_order_relaxed);
        lastKeyframeSendMs_.store(0, std::memory_order_relaxed);
    }

    if (queuedTransition) {
        runQueuedPeerTransition(peer, "media-plan-complete");
        return;
    }
    if (dataChannelOpen && change.changed) {
        sendPeerOffer(peer, requestedReason.c_str());
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

    const auto it = peerSessions_.find(uuid);
    if (it == peerSessions_.end() || !it->second) {
        return nullptr;
    }
    const auto &peer = it->second;
    if (!session.empty()) {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed || peer->activeWireSession != session) {
            return nullptr;
        }
    }
    return peer;
}

void VersusApp::handlePeerRemoteCandidate(const std::shared_ptr<PeerSession> &peer,
                                          const signaling::SignalCandidate &cand,
                                          const char *source) {
    if (!peer || !peer->client || cand.candidate.empty()) {
        return;
    }

    uint64_t candidateGeneration = 0;
    uint64_t candidateTransportGeneration = 0;
    std::string candidateWireSession;
    bool queueCandidate = false;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed) {
            return;
        }
        if (!cand.session.empty() && cand.session != peer->activeWireSession) {
            spdlog::warn(
                "[Signaling] Rejecting stale-session remote ICE candidate before content routing uuid={} session={} activeSession={} source={}",
                peer->uuid,
                cand.session,
                peer->activeWireSession,
                source ? source : "unknown");
            recordPeerEvent(peer, "remote-candidate-dropped stale-wire-session");
            return;
        }
        candidateGeneration = peer->activeOfferGeneration;
        candidateTransportGeneration = peer->activeTransportGeneration;
        candidateWireSession = peer->activeWireSession;
        queueCandidate = peer->sessionInitializing ||
            peer->offerCreationInProgress ||
            peer->answerApplicationInProgress ||
            !peer->offerDispatched ||
            !peer->answerReceived;
    }

    signaling::SignalCandidate routed = cand;
    routed.uuid = peer->uuid;
    routed.session = candidateWireSession;
    if (queueCandidate) {
        bool queued = false;
        {
            // Revalidate under map -> negotiation ordering so answer commit +
            // drain cannot pass between the pending-state decision and queue
            // insertion, leaving a candidate stranded until another answer.
            std::lock_guard<std::mutex> mapLock(peerSessionsMutex_);
            const auto it = peerSessions_.find(peer->uuid);
            if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
                return;
            }
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            if (peer->removed) {
                return;
            }
            if (peer->activeWireSession != candidateWireSession) {
                spdlog::warn(
                    "[Signaling] Rejecting stale-session remote ICE candidate after transport rotation uuid={} session={} activeSession={} source={}",
                    peer->uuid,
                    candidateWireSession,
                    peer->activeWireSession,
                    source ? source : "unknown");
                recordPeerEvent(peer, "remote-candidate-dropped rotated-wire-session");
                return;
            }
            candidateGeneration = peer->activeOfferGeneration;
            candidateTransportGeneration = peer->activeTransportGeneration;
            queueCandidate = peer->sessionInitializing ||
                peer->offerCreationInProgress ||
                peer->answerApplicationInProgress ||
                !peer->offerDispatched ||
                !peer->answerReceived;
            if (queueCandidate) {
                queuePendingRemoteCandidateLocked(
                    routed,
                    steadyNowMs(),
                    candidateGeneration,
                    candidateTransportGeneration);
                queued = true;
            }
        }
        if (queued) {
            recordPeerEvent(peer, "remote-candidate-buffered generation=" +
                                      std::to_string(candidateGeneration));
            return;
        }
    }

    bool applied = false;
    {
        std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
        bool stillCurrent = false;
        uint64_t activeGeneration = 0;
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            activeGeneration = peer->activeOfferGeneration;
            stillCurrent = !peer->removed &&
                peer->activeTransportGeneration == candidateTransportGeneration &&
                peer->activeWireSession == candidateWireSession &&
                !peer->transportRetired;
        }
        if (!stillCurrent) {
            spdlog::warn("[Signaling] Rejecting stale-generation remote ICE candidate {}:{} source={} queuedGeneration={} activeGeneration={}",
                         peer->uuid,
                         peer->session,
                         source ? source : "unknown",
                         candidateGeneration,
                         activeGeneration);
            recordPeerEvent(peer, "remote-candidate-dropped stale-generation");
            return;
        }
        applied = peer->client->addRemoteCandidate(routed.candidate, routed.mid, routed.mlineIndex);
    }
    if (applied) {
        peer->remoteCandidatesApplied.fetch_add(1, std::memory_order_relaxed);
        recordPeerEvent(peer, std::string("remote-candidate-applied ") +
                                  (source ? source : "unknown") +
                                  " generation=" + std::to_string(candidateGeneration));
    }
}

void VersusApp::queuePendingRemoteCandidateLocked(const signaling::SignalCandidate &cand,
                                                  int64_t nowMs,
                                                  uint64_t offerGeneration,
                                                  uint64_t transportGeneration) {
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
        offerGeneration,
        transportGeneration,
    });
    spdlog::info("[Signaling] Queued remote ICE candidate uuid={} session={} generation={} transportGeneration={} queued={}",
                 cand.uuid,
                 cand.session,
                 offerGeneration,
                 transportGeneration,
                 queue.size());
}

std::vector<VersusApp::PendingRemoteCandidate> VersusApp::takePendingRemoteCandidatesLocked(
    const std::string &uuid,
    const std::string &session,
    int64_t nowMs,
    uint64_t offerGeneration,
    uint64_t transportGeneration) {
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
            const bool generationMatches = pending.transportGeneration == transportGeneration ||
                (pending.transportGeneration == 0 && transportGeneration == 1);
            if (!generationMatches) {
                spdlog::warn("[Signaling] Dropped stale-generation remote ICE candidate key={} queuedGeneration={} activeGeneration={} queuedTransportGeneration={} activeTransportGeneration={}",
                             key,
                             pending.offerGeneration,
                             offerGeneration,
                             pending.transportGeneration,
                             transportGeneration);
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

void VersusApp::drainPendingRemoteCandidates(const std::shared_ptr<PeerSession> &peer,
                                             uint64_t offerGeneration,
                                             uint64_t transportGeneration,
                                             const char *reason) {
    if (!peer || !peer->client) {
        return;
    }

    std::vector<PendingRemoteCandidate> pendingCandidates;
    std::string activeWireSession;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(peer->uuid);
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return;
        }
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            if (peer->removed ||
                peer->activeOfferGeneration != offerGeneration ||
                peer->activeTransportGeneration != transportGeneration) {
                return;
            }
            activeWireSession = peer->activeWireSession;
        }
        pendingCandidates = takePendingRemoteCandidatesLocked(
            peer->uuid,
            activeWireSession,
            steadyNowMs(),
            offerGeneration,
            transportGeneration);
    }

    if (pendingCandidates.empty()) {
        return;
    }

    spdlog::info("[Signaling] Draining {} queued remote ICE candidates for {}:{} reason={}",
                 pendingCandidates.size(),
                 peer->uuid,
                 activeWireSession,
                 reason ? reason : "unspecified");
    int appliedCount = 0;
    std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
    for (const auto &pending : pendingCandidates) {
        bool stillCurrent = false;
        uint64_t activeGeneration = 0;
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            activeGeneration = peer->activeOfferGeneration;
            stillCurrent = !peer->removed &&
                peer->activeTransportGeneration == transportGeneration &&
                peer->activeWireSession == activeWireSession &&
                !peer->transportRetired;
        }
        if (!stillCurrent) {
            spdlog::warn("[Signaling] Dropped stale-generation remote ICE candidate during drain {}:{} queuedGeneration={} activeGeneration={}",
                         peer->uuid,
                         peer->session,
                         pending.offerGeneration,
                         activeGeneration);
            continue;
        }
        if (peer->client->addRemoteCandidate(pending.candidate, pending.mid, pending.mlineIndex)) {
            ++appliedCount;
        }
    }
    peer->remoteCandidatesApplied.fetch_add(appliedCount, std::memory_order_relaxed);
    recordPeerEvent(peer, "remote-candidates-drained count=" + std::to_string(appliedCount) +
                              " generation=" + std::to_string(offerGeneration));
}

void VersusApp::removePeerSession(const std::shared_ptr<PeerSession> &peer, const char *reason) {
    if (!peer) {
        return;
    }

    std::string activeWireSession;
    {
        std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
        if (peer->removed) {
            return;
        }
        peer->removed = true;
        peer->queuedOfferTransition = false;
        peer->queuedOfferRebuild = false;
        peer->queuedMediaPlan = false;
        peer->renegotiationQueued.store(false, std::memory_order_relaxed);
        activeWireSession = peer->activeWireSession;
    }
    cancelDuplicateOfferRecheck(peer, reason ? reason : "peer-removed");

    std::shared_ptr<PeerSession> removedPeer;
    bool hasRemainingPeers = true;
    {
        std::lock_guard<std::mutex> lock(peerSessionsMutex_);
        const auto it = peerSessions_.find(peer->uuid);
        if (it == peerSessions_.end() || !it->second || it->second.get() != peer.get()) {
            return;
        }
        removedPeer = it->second;
        peerSessions_.erase(it);
        pendingRemoteCandidates_.erase(makePeerKey(peer->uuid, peer->session));
        if (activeWireSession != peer->session) {
            pendingRemoteCandidates_.erase(makePeerKey(peer->uuid, activeWireSession));
        }
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

    {
        std::lock_guard<std::mutex> diagnosticsLock(removedPeer->diagnosticsMutex);
        removedPeer->lastRemovalReason = reason ? reason : "unspecified";
    }
    {
        std::lock_guard<std::mutex> healthLock(healthStateMutex_);
        lastPeerDisconnectReason_ = reason ? reason : "unspecified";
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
    if (!peer) {
        return;
    }

    reapCompletedPeerShutdowns();
    auto shutdownFuture = std::async(std::launch::async, [peer]() {
        try {
            // First block new callback admission and wait for callbacks already
            // using App state. Executor-dispatched handlers have already left
            // that callback gate, so wait for their separate lifetime lease
            // before taking the client operation mutex. The order must remain
            // callback gate -> handler lifetime -> client operation.
            auto *client = peer->client.get();
            if (!client) {
                return;
            }
            client->prepareForShutdown();
            std::lock_guard<std::recursive_mutex> callbackOperationLock(
                peer->callbackOperationMutex);
            std::lock_guard<std::recursive_mutex> clientLock(peer->clientOperationMutex);
            client->shutdown();
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
        {
            std::lock_guard<std::mutex> negotiationLock(peer->negotiationMutex);
            peer->removed = true;
            peer->queuedOfferTransition = false;
            peer->queuedOfferRebuild = false;
            peer->queuedMediaPlan = false;
        }
        shutdownPeerClientAsync(peer);
    }
    cancelDuplicateOfferRechecks(false, "clear-peer-sessions");
    std::lock_guard<std::mutex> lock(videoSendMutex_);
    shutdownLqEncoderLocked();
}

}  // namespace versus::app
