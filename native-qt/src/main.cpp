#include <QApplication>
#include <QIcon>
#include <QSettings>
#include <QFileInfo>
#include <QDir>
#include <QScreen>
#include <QJsonArray>
#include <QJsonObject>
#include <QLockFile>
#include <QMetaObject>
#include <QObject>
#include <QPointer>
#include <QTimer>
#include <QUuid>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <optional>
#include <sstream>
#include <vector>

#include <spdlog/spdlog.h>
#include <spdlog/sinks/basic_file_sink.h>
#ifdef __linux__
#include <spdlog/sinks/rotating_file_sink.h>
#endif
#include <spdlog/sinks/stdout_sinks.h>
#include <rtc/rtc.hpp>

#include "versus/app/versus_app.h"
#include "versus/control/local_control_server.h"
#include "versus/diagnostics/crash_reporter.h"
#include "versus/ui/main_window.h"
#include "versus/video/window_capture.h"
#include "versus/platform/capabilities.h"
#if defined(__APPLE__) || defined(__linux__)
#include "versus/platform/app_paths.h"
#include <QColorSpace>
#include <QSurfaceFormat>
#endif

namespace {

const char *passwordLogValue(const std::string &password) {
    if (password.empty()) {
        return "(empty)";
    }
    if (password == "false" || password == "0" || password == "off") {
        return "disabled";
    }
    return "(set)";
}

std::string resolveLogFilePath() {
#ifdef _WIN32
    const char *localAppData = std::getenv("LOCALAPPDATA");
    std::filesystem::path logDir = localAppData && *localAppData
        ? std::filesystem::path(localAppData)
        : std::filesystem::current_path();
    logDir /= "GameCapture";
    logDir /= "logs";
    std::error_code ec;
    std::filesystem::create_directories(logDir, ec);
    return (logDir / "game-capture-debug.log").string();
#elif defined(__APPLE__) || defined(__linux__)
    return QDir(versus::platform::logDirectory()).filePath("game-capture-debug.log").toStdString();
#else
    return "game-capture-debug.log";
#endif
}

[[noreturn]] void forceExitProcess(int exitCode) {
    // Force-quit must bypass QApplication teardown because Qt destroys the
    // global QThreadPool on shutdown and waits for active QtConcurrent jobs.
    if (auto logger = spdlog::default_logger()) {
        logger->flush();
    }
    std::_Exit(exitCode);
}

std::optional<int> parseInteger(const std::string &value) {
    try {
        size_t parsed = 0;
        const int result = std::stoi(value, &parsed);
        if (parsed == value.size()) {
            return result;
        }
    } catch (...) {
    }
    return std::nullopt;
}

std::optional<int> parsePositiveInteger(const std::string &value) {
    const auto parsed = parseInteger(value);
    if (parsed && *parsed > 0) {
        return parsed;
    }
    return std::nullopt;
}

std::optional<int> parseNonNegativeInteger(const std::string &value) {
    const auto parsed = parseInteger(value);
    if (parsed && *parsed >= 0) {
        return parsed;
    }
    return std::nullopt;
}

int clampEvenDimension(int value, int minimum, int maximum) {
    const int clamped = std::clamp(value, minimum, maximum);
    return std::max(2, clamped & ~1);
}

int clampStartupWidth(int value) {
    return clampEvenDimension(value, 160, 3840);
}

int clampStartupHeight(int value) {
    return clampEvenDimension(value, 90, 2160);
}

bool boolEnvEnabled(const char *value) {
    if (!value || !*value) {
        return false;
    }
    std::string normalized = value;
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on";
}

std::optional<std::array<uint8_t, 3>> parseRgbColor(std::string value) {
    if (!value.empty() && value[0] == '#') {
        value.erase(value.begin());
    }
    if (value.size() != 6) {
        return std::nullopt;
    }
    auto hexByte = [](const std::string &part) -> std::optional<uint8_t> {
        try {
            size_t parsed = 0;
            const int result = std::stoi(part, &parsed, 16);
            if (parsed == part.size() && result >= 0 && result <= 255) {
                return static_cast<uint8_t>(result);
            }
        } catch (...) {
        }
        return std::nullopt;
    };
    const auto r = hexByte(value.substr(0, 2));
    const auto g = hexByte(value.substr(2, 2));
    const auto b = hexByte(value.substr(4, 2));
    if (!r || !g || !b) {
        return std::nullopt;
    }
    return std::array<uint8_t, 3>{*r, *g, *b};
}

QJsonArray sourceListToJson(const std::vector<versus::video::WindowInfo> &sources) {
    QJsonArray items;
    for (const auto &source : sources) {
        QJsonObject item;
        item["id"] = QString::fromStdString(source.id);
        item["name"] = QString::fromStdString(source.name);
        item["executableName"] = QString::fromStdString(source.executableName);
        item["width"] = source.width;
        item["height"] = source.height;
        item["processId"] = static_cast<int>(source.processId);
        items.append(item);
    }
    return items;
}

QJsonArray audioInputListToJson(const std::vector<versus::audio::AudioDeviceInfo> &devices) {
    QJsonArray items;
    for (const auto &device : devices) {
        QJsonObject item;
        item["id"] = QString::fromStdString(device.id);
        item["name"] = QString::fromStdString(device.name);
        item["sampleRate"] = static_cast<int>(device.sampleRate);
        item["channels"] = static_cast<int>(device.channels);
        item["bitsPerSample"] = static_cast<int>(device.bitsPerSample);
        item["validBitsPerSample"] = static_cast<int>(device.validBitsPerSample);
        item["floatingPoint"] = device.floatingPoint;
        item["isDefault"] = device.isDefault;
        items.append(item);
    }
    return items;
}

}  // namespace

int main(int argc, char *argv[]) {
    // Check for --headless mode
    bool headless = false;
    bool temporarySettings = false;
    QString settingsDirectory;
    versus::output::Config outputConfig;
    std::string streamId = "steve123";
    std::string password;
    std::string room;
    std::string label;
    std::string server = "wss://wss.vdo.ninja:443";
    std::string salt = "vdo.ninja";
    std::string videoEncoderArg;
    std::string videoCodecArg;
    std::string ffmpegPathArg;
    std::string ffmpegOptionsArg;
    std::string windowFilterArg;
    std::string videoSourceArg = "window";
    std::string spoutSenderArg;
#ifdef __APPLE__
    std::string syphonServerArg;
    bool syphonPremultiplied = false;
#endif
    std::string cameraFilterArg;
    std::string cameraIdArg;
    versus::app::VideoSourceMode videoSourceMode = versus::app::VideoSourceMode::Window;
    versus::app::AudioSourceMode audioSourceMode = versus::app::AudioSourceMode::SelectedWindow;
    std::string audioSourceArg = "selected-window";
    versus::webrtc::IceMode iceMode = versus::webrtc::IceMode::All;
    int width = 0;
    int height = 0;
    int fps = 0;
    int bitrateKbps = 0;
    int audioBitrateKbps = versus::defaults::AudioBitrateKbps;
    int audioChannels = 2;
    bool pcmAudio = false;
    bool audioRed = false;
    bool audioRedSpecified = false;
    int durationMs = 120000;
    int maxViewers = 10;
    bool remoteControlEnabled = false;
    bool roomModeLqEnabled = true;
    std::string remoteControlToken;
    bool alphaWorkflowEnabled = false;
    bool alphaBackgroundConfigured = false;
    versus::video::AlphaBackgroundMode alphaBackgroundMode = versus::video::AlphaBackgroundMode::None;
    std::array<uint8_t, 3> alphaBackgroundColor = {0, 255, 0};
    bool includeMicrophone = false;
    std::string microphoneDeviceId;
#ifdef __linux__
    std::string communicationsOutputDeviceId;
    uint32_t audioProcessId = 0;
#endif
    std::string diagnosticsOutArg;
    bool localControlEnabled = false;
    int localControlPort = 0;
    bool localControlPortSpecified = false;
    std::string localControlTokenArg;
    std::string localControlDiscoveryArg;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--temporary-settings") {
            temporarySettings = true;
        } else if (arg.find("--settings-dir=") == 0) {
            const auto value = arg.substr(15);
            if (value.empty()) { spdlog::error("--settings-dir requires a nonempty directory"); return 2; }
            settingsDirectory = QFileInfo(QString::fromStdString(value)).absoluteFilePath();
        } else if (arg == "--headless") {
            headless = true;
        } else if (arg.rfind("--output=", 0) == 0) {
            try { outputConfig.protocol = versus::output::parseProtocol(arg.substr(9)); }
            catch (const std::exception &error) { spdlog::error("{}", error.what()); return 2; }
        } else if (arg.rfind("--output-url=", 0) == 0) {
            outputConfig.url = arg.substr(13);
        } else if (arg.rfind("--output-token=", 0) == 0) {
            outputConfig.bearerToken = arg.substr(15);
        } else if (arg.rfind("--output-key=", 0) == 0) {
            outputConfig.streamKey = arg.substr(13);
        } else if (arg.rfind("--srt-stream-id=", 0) == 0) {
            outputConfig.streamId = arg.substr(16);
        } else if (arg.rfind("--srt-passphrase=", 0) == 0) {
            outputConfig.passphrase = arg.substr(17);
        } else if (arg.rfind("--srt-latency-ms=", 0) == 0) {
            const auto value = parsePositiveInteger(arg.substr(17));
            if (!value || *value < 20 || *value > 8000) { spdlog::error("SRT latency must be 20 to 8000 ms"); return 2; }
            outputConfig.latencyMs = *value;
        } else if (arg.rfind("--aac-bitrate-kbps=", 0) == 0) {
            const auto value = parsePositiveInteger(arg.substr(19));
            if (!value || *value < 32 || *value > 320) { spdlog::error("AAC bitrate must be 32 to 320 kbps"); return 2; }
            outputConfig.aacBitrateKbps = *value;
        } else if (arg.find("--stream=") == 0) {
            streamId = arg.substr(9);
        } else if (arg.find("--password=") == 0) {
            password = arg.substr(11);
        } else if (arg.find("--room=") == 0) {
            room = arg.substr(7);
        } else if (arg.find("--label=") == 0) {
            label = arg.substr(8);
        } else if (arg.find("--server=") == 0) {
            server = arg.substr(9);
        } else if (arg.find("--salt=") == 0) {
            salt = arg.substr(7);
        } else if (arg.find("--video-encoder=") == 0) {
            videoEncoderArg = arg.substr(16);
        } else if (arg.find("--video-codec=") == 0) {
            videoCodecArg = arg.substr(14);
        } else if (arg.find("--ffmpeg-path=") == 0) {
            ffmpegPathArg = arg.substr(14);
        } else if (arg.find("--ffmpeg-options=") == 0) {
            ffmpegOptionsArg = arg.substr(17);
        } else if (arg.find("--ice-mode=") == 0) {
            std::string normalized = arg.substr(11);
            std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
                return static_cast<char>(std::tolower(ch));
            });
            if (normalized.empty() || normalized == "all") {
                iceMode = versus::webrtc::IceMode::All;
            } else if (normalized == "host" || normalized == "host-only" || normalized == "host_only") {
                iceMode = versus::webrtc::IceMode::HostOnly;
            } else if (normalized == "relay" || normalized == "turn") {
                iceMode = versus::webrtc::IceMode::Relay;
            } else if (normalized == "stun" || normalized == "stun-only" || normalized == "stun_only") {
                iceMode = versus::webrtc::IceMode::StunOnly;
            }
        } else if (arg.find("--window=") == 0) {
            windowFilterArg = arg.substr(9);
        } else if (arg.find("--source=") == 0) {
            videoSourceArg = arg.substr(9);
            std::string normalized = videoSourceArg;
            std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
                return static_cast<char>(std::tolower(ch));
            });
            if (normalized == "spout" || normalized == "spout2") {
                videoSourceMode = versus::app::VideoSourceMode::Spout;
                videoSourceArg = "spout";
#ifdef __APPLE__
            } else if (normalized == "syphon") {
                videoSourceMode = versus::app::VideoSourceMode::Syphon;
                videoSourceArg = "syphon";
#endif
            } else if (normalized == "camera" || normalized == "webcam" || normalized == "video-input") {
                videoSourceMode = versus::app::VideoSourceMode::Camera;
                videoSourceArg = "camera";
            } else if (normalized == "window" || normalized == "game" || normalized == "app") {
                videoSourceMode = versus::app::VideoSourceMode::Window;
                videoSourceArg = "window";
            } else {
                spdlog::warn("[Main] Unknown --source value '{}'; expected window|camera|spout", videoSourceArg);
                videoSourceArg = "window";
                videoSourceMode = versus::app::VideoSourceMode::Window;
            }
#ifdef __APPLE__
        } else if (arg.find("--syphon-server=") == 0) {
            syphonServerArg = arg.substr(16);
        } else if (arg.find("--syphon-alpha=") == 0) {
            const auto association = arg.substr(15);
            if (association != "straight" && association != "premultiplied") {
                spdlog::error("--syphon-alpha requires straight or premultiplied");
                return 2;
            }
            syphonPremultiplied = association == "premultiplied";
#endif
        } else if (arg.find("--spout-sender=") == 0) {
            spoutSenderArg = arg.substr(15);
        } else if (arg.find("--camera=") == 0) {
            cameraFilterArg = arg.substr(9);
        } else if (arg.find("--camera-id=") == 0) {
            cameraIdArg = arg.substr(12);
            if (cameraIdArg.empty()) {
                spdlog::error("--camera-id requires an exact, nonempty device ID");
                return 2;
            }
        } else if (arg.find("--audio-codec=") == 0) {
            const auto codec = arg.substr(14);
            if (codec != "opus" && codec != "pcm") {
                spdlog::error("--audio-codec must be opus|pcm");
                return 2;
            }
            pcmAudio = codec == "pcm";
        } else if (arg == "--audio-red") {
            audioRed = true;
            audioRedSpecified = true;
        } else if (arg == "--no-audio-red") {
            audioRed = false;
            audioRedSpecified = true;
        } else if (arg.find("--audio-bitrate-kbps=") == 0) {
            const auto parsed = parsePositiveInteger(arg.substr(21));
            if (!parsed || *parsed < 6 || *parsed > 510) {
                spdlog::error("--audio-bitrate-kbps must be an integer from 6 to 510");
                return 2;
            }
            audioBitrateKbps = *parsed;
        } else if (arg.find("--audio-channels=") == 0) {
            const std::string value = arg.substr(17);
            if (value == "mono" || value == "1") {
                audioChannels = 1;
            } else if (value == "stereo" || value == "2") {
                audioChannels = 2;
            } else {
                spdlog::error("--audio-channels must be mono|stereo|1|2");
                return 2;
            }
        } else if (arg.find("--audio-source=") == 0) {
            audioSourceArg = arg.substr(15);
            std::string normalized = audioSourceArg;
            std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
                return static_cast<char>(std::tolower(ch));
            });
            if (normalized == "selected" || normalized == "selected-window" || normalized == "window" ||
                normalized == "app" || normalized == "process") {
                audioSourceMode = versus::app::AudioSourceMode::SelectedWindow;
            } else if (normalized == "default-output" || normalized == "output" || normalized == "system" ||
                       normalized == "system-output") {
                audioSourceMode = versus::app::AudioSourceMode::DefaultOutput;
            } else if (normalized == "communications-output" || normalized == "communication-output" ||
                       normalized == "communications" || normalized == "voip") {
                audioSourceMode = versus::app::AudioSourceMode::CommunicationsOutput;
            } else if (normalized == "default-microphone" || normalized == "microphone" || normalized == "mic" ||
                       normalized == "input" || normalized == "default-input") {
                audioSourceMode = versus::app::AudioSourceMode::DefaultMicrophone;
            } else if (normalized == "none" || normalized == "off" || normalized == "disabled") {
                audioSourceMode = versus::app::AudioSourceMode::None;
            } else {
                spdlog::warn("[Main] Unknown --audio-source value '{}'; expected selected-window|default-output|communications-output|default-microphone|none", audioSourceArg);
                audioSourceArg = "selected-window";
                audioSourceMode = versus::app::AudioSourceMode::SelectedWindow;
            }
        } else if (arg.find("--resolution=") == 0) {
            const std::string resolution = arg.substr(13);
            const auto xPos = resolution.find('x');
            if (xPos != std::string::npos) {
                const auto parsedWidth = parsePositiveInteger(resolution.substr(0, xPos));
                const auto parsedHeight = parsePositiveInteger(resolution.substr(xPos + 1));
                if (parsedWidth && parsedHeight) {
                    width = clampStartupWidth(*parsedWidth);
                    height = clampStartupHeight(*parsedHeight);
                }
            }
        } else if (arg.find("--width=") == 0) {
            const auto parsed = parsePositiveInteger(arg.substr(8));
            if (parsed) {
                width = clampStartupWidth(*parsed);
            }
        } else if (arg.find("--height=") == 0) {
            const auto parsed = parsePositiveInteger(arg.substr(9));
            if (parsed) {
                height = clampStartupHeight(*parsed);
            }
        } else if (arg.find("--fps=") == 0) {
            const auto parsed = parsePositiveInteger(arg.substr(6));
            if (parsed) {
                fps = std::clamp(*parsed, 1, 120);
            }
        } else if (arg.find("--bitrate-kbps=") == 0) {
            const auto parsed = parsePositiveInteger(arg.substr(15));
            if (parsed) {
                bitrateKbps = std::clamp(*parsed, 250, 100000);
            }
        } else if (arg.find("--duration-ms=") == 0) {
            const auto parsed = parsePositiveInteger(arg.substr(14));
            if (parsed) {
                durationMs = std::max(1000, *parsed);
            }
        } else if (arg.find("--max-viewers=") == 0) {
            const auto parsed = parseNonNegativeInteger(arg.substr(14));
            if (parsed) {
                maxViewers = *parsed;
            }
        } else if (arg == "--remote-control") {
            remoteControlEnabled = true;
        } else if (arg == "--disable-room-lq") {
            roomModeLqEnabled = false;
        } else if (arg.find("--remote-token=") == 0) {
            remoteControlToken = arg.substr(15);
        } else if (arg == "--include-microphone" || arg == "--include-mic") {
            includeMicrophone = true;
#ifdef __linux__
        } else if (arg.starts_with("--communications-output-device=")) {
            communicationsOutputDeviceId = arg.substr(std::string("--communications-output-device=").size());
            if (!communicationsOutputDeviceId.starts_with("pulse-output:") || communicationsOutputDeviceId.size() <= 13) {
                spdlog::error("--communications-output-device requires pulse-output:<output name>"); return 2;
            }
        } else if (arg.find("--audio-process=") == 0) {
            const std::string value = arg.substr(16);
            try {
                size_t consumed = 0; const auto parsed = std::stoull(value, &consumed);
                if (consumed != value.size() || !parsed || parsed > UINT32_MAX || value.front() == '-') throw std::invalid_argument("pid");
                audioProcessId = uint32_t(parsed);
            } catch (...) {
                spdlog::error("--audio-process requires a positive local process ID"); return 2;
            }
#endif
        } else if (arg.find("--microphone-device=") == 0) {
            microphoneDeviceId = arg.substr(20);
            includeMicrophone = true;
        } else if (arg.find("--mic-device=") == 0) {
            microphoneDeviceId = arg.substr(13);
            includeMicrophone = true;
        } else if (arg.find("--diagnostics-out=") == 0) {
            diagnosticsOutArg = arg.substr(18);
        } else if (arg == "--alpha-workflow") {
            alphaWorkflowEnabled = true;
        } else if (arg.find("--alpha-background=") == 0) {
            std::string normalized = arg.substr(19);
            std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
                return static_cast<char>(std::tolower(ch));
            });
            alphaBackgroundConfigured = true;
            if (normalized == "chroma" || normalized == "green" || normalized == "greenscreen") {
                alphaBackgroundMode = versus::video::AlphaBackgroundMode::Chroma;
            } else if (normalized == "opaque" || normalized == "solid" || normalized == "background") {
                alphaBackgroundMode = versus::video::AlphaBackgroundMode::Opaque;
            } else {
                alphaBackgroundMode = versus::video::AlphaBackgroundMode::None;
            }
        } else if (arg.find("--alpha-background-color=") == 0) {
            const auto parsed = parseRgbColor(arg.substr(25));
            if (parsed) {
                alphaBackgroundColor = *parsed;
                alphaBackgroundConfigured = true;
            } else {
                spdlog::warn("[Main] Ignoring invalid --alpha-background-color value '{}'", arg.substr(25));
            }
        } else if (arg == "--local-control") {
            localControlEnabled = true;
        } else if (arg.find("--local-control-port=") == 0) {
            const auto parsed = parseNonNegativeInteger(arg.substr(21));
            if (parsed) {
                localControlPort = std::clamp(*parsed, 0, 65535);
                localControlPortSpecified = true;
                localControlEnabled = true;
            }
        } else if (arg.find("--local-control-token=") == 0) {
            localControlTokenArg = arg.substr(22);
            localControlEnabled = true;
        } else if (arg.find("--local-control-discovery=") == 0) {
            localControlDiscoveryArg = arg.substr(26);
            localControlEnabled = true;
        }
    }

    if (!localControlEnabled && boolEnvEnabled(std::getenv("GAME_CAPTURE_LOCAL_CONTROL"))) {
        localControlEnabled = true;
    }
    if (!localControlPortSpecified) {
        if (const char *envPort = std::getenv("GAME_CAPTURE_LOCAL_CONTROL_PORT")) {
            const auto parsed = parseNonNegativeInteger(envPort);
            if (parsed) {
                localControlPort = std::clamp(*parsed, 0, 65535);
            }
        }
    }
    if (localControlTokenArg.empty()) {
        if (const char *envToken = std::getenv("GAME_CAPTURE_LOCAL_CONTROL_TOKEN")) {
            localControlTokenArg = envToken;
        }
    }
    if (localControlDiscoveryArg.empty()) {
        if (const char *envDiscovery = std::getenv("GAME_CAPTURE_LOCAL_CONTROL_DISCOVERY")) {
            localControlDiscoveryArg = envDiscovery;
        }
    }

    // Set up logging - console for headless, file otherwise
    std::string logPath = resolveLogFilePath();
    // Preserve the conventional log name for the first publisher. Other
    // publishers must not truncate or mix records into its active log.
    QLockFile logLock(QString::fromStdString(logPath) + ".lock");
    logLock.setStaleLockTime(0); // Held for the process lifetime, not a short write.
    if (!logLock.tryLock(0)) {
        const std::filesystem::path defaultPath(logPath);
        const std::string uniqueName = defaultPath.stem().string() + '-' +
            QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString() +
            defaultPath.extension().string();
        logPath = (defaultPath.parent_path() / uniqueName).string();
    }
    try {
        std::vector<spdlog::sink_ptr> sinks;
#ifdef __linux__
        // Recovery often requires a relaunch (for example after unlocking the
        // desktop password store). Preserve the previous failure's evidence,
        // while bounding disk use for long-running publishers.
        sinks.push_back(std::make_shared<spdlog::sinks::rotating_file_sink_mt>(
            logPath, 5 * 1024 * 1024, 3, true));
#else
        sinks.push_back(std::make_shared<spdlog::sinks::basic_file_sink_mt>(logPath, true));
#endif
        if (headless) {
            sinks.push_back(std::make_shared<spdlog::sinks::stdout_sink_mt>());
        }
        auto logger = std::make_shared<spdlog::logger>("game-capture", sinks.begin(), sinks.end());
        spdlog::set_default_logger(logger);
        spdlog::set_level(spdlog::level::debug);
        spdlog::flush_on(spdlog::level::debug);
        spdlog::info("Logging to {}", logPath);
        spdlog::info("Game Capture app starting (headless={})", headless);
    } catch (...) {
        // Fall back to default logger
    }
    if (const char *rtcLog = std::getenv("GAME_CAPTURE_RTC_LOG"); rtcLog && *rtcLog) {
        std::string normalized = rtcLog;
        std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        const rtc::LogLevel rtcLevel = normalized == "verbose"
            ? rtc::LogLevel::Verbose
            : rtc::LogLevel::Debug;
        rtc::InitLogger(rtcLevel, [](rtc::LogLevel level, std::string message) {
            if (level <= rtc::LogLevel::Error) {
                spdlog::error("[libdatachannel] {}", message);
            } else if (level == rtc::LogLevel::Warning) {
                spdlog::warn("[libdatachannel] {}", message);
            } else {
                spdlog::debug("[libdatachannel] {}", message);
            }
        });
        spdlog::info("[Main] libdatachannel diagnostic logging enabled ({})", normalized);
    }
    versus::diagnostics::installCrashReporter({
        versus::diagnostics::defaultCrashDirectory(),
        logPath,
        APP_VERSION
    });

    if (windowFilterArg.empty()) {
        const char *envWindowFilter = std::getenv("GAME_CAPTURE_WINDOW_FILTER");
        if (envWindowFilter && *envWindowFilter) {
            windowFilterArg = envWindowFilter;
            spdlog::info("[Main] Using capture window filter from GAME_CAPTURE_WINDOW_FILTER");
        }
    }
    if (spoutSenderArg.empty()) {
        const char *envSpoutSender = std::getenv("GAME_CAPTURE_SPOUT_SENDER");
        if (envSpoutSender && *envSpoutSender) {
            spoutSenderArg = envSpoutSender;
            spdlog::info("[Main] Using Spout sender from GAME_CAPTURE_SPOUT_SENDER");
        }
    }
    if (cameraFilterArg.empty()) {
        const char *envCameraFilter = std::getenv("GAME_CAPTURE_CAMERA");
        if (envCameraFilter && *envCameraFilter) {
            cameraFilterArg = envCameraFilter;
            spdlog::info("[Main] Using camera filter from GAME_CAPTURE_CAMERA");
        }
    }
    if (videoSourceMode == versus::app::VideoSourceMode::Spout && audioSourceArg == "selected-window") {
        audioSourceArg = "none";
        audioSourceMode = versus::app::AudioSourceMode::None;
        spdlog::info("[Main] Defaulting audio source to none for Spout video source");
    } else if (videoSourceMode == versus::app::VideoSourceMode::Camera &&
#ifdef __linux__
               audioProcessId == 0 &&
#endif
               audioSourceArg == "selected-window") {
        audioSourceArg = "none";
        audioSourceMode = versus::app::AudioSourceMode::None;
        spdlog::info("[Main] Camera audio is off unless explicitly selected");
    }

    if (!settingsDirectory.isEmpty()) {
        if (temporarySettings || headless || !QDir().mkpath(settingsDirectory)) {
            spdlog::error("--settings-dir requires GUI mode, writable storage, and cannot be combined with --temporary-settings");
            return 2;
        }
        QSettings::setDefaultFormat(QSettings::IniFormat);
        QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsDirectory);
        QSettings::setPath(QSettings::IniFormat, QSettings::SystemScope, settingsDirectory);
    }
#ifdef __APPLE__
    // ScreenCaptureKit previews and Qt widget colors are sRGB. Cocoa otherwise
    // inherits the display profile, interpreting these pixels in its wider gamut.
    auto surfaceFormat = QSurfaceFormat::defaultFormat();
    surfaceFormat.setColorSpace(QColorSpace::SRgb);
    QSurfaceFormat::setDefaultFormat(surfaceFormat);
#endif
    QApplication app(argc, argv);
#ifdef __APPLE__
    if (videoSourceMode == versus::app::VideoSourceMode::Syphon) {
        if (headless && syphonServerArg.empty()) {
            spdlog::error("Syphon requires --syphon-server=<exact UUID or unique sender name>");
            return 2;
        }
        if (audioSourceMode == versus::app::AudioSourceMode::SelectedWindow) {
            audioSourceMode = versus::app::AudioSourceMode::None;
            audioSourceArg = "none";
        }
    }
    if (headless && ((videoSourceMode != versus::app::VideoSourceMode::Window &&
        videoSourceMode != versus::app::VideoSourceMode::Camera &&
        videoSourceMode != versus::app::VideoSourceMode::Syphon) ||
        audioSourceMode == versus::app::AudioSourceMode::CommunicationsOutput ||
        (!videoCodecArg.empty() && videoCodecArg != "h264" && videoCodecArg != "avc" &&
         videoCodecArg != "h265" && videoCodecArg != "hevc" && videoCodecArg != "vp9" && videoCodecArg != "av1") ||
        (alphaWorkflowEnabled && ((videoSourceMode != versus::app::VideoSourceMode::Window &&
         videoSourceMode != versus::app::VideoSourceMode::Syphon) ||
         (!videoCodecArg.empty() && videoCodecArg != "h264" && videoCodecArg != "avc" && videoCodecArg != "vp9"))) ||
        (alphaBackgroundConfigured && alphaBackgroundMode != versus::video::AlphaBackgroundMode::None &&
         videoSourceMode != versus::app::VideoSourceMode::Window &&
         videoSourceMode != versus::app::VideoSourceMode::Syphon))) {
        spdlog::error("This Mac development build supports window/camera/Syphon video, H.264/H.265/VP9/AV1, and app/system/microphone audio. Alpha requires H.264 or VP9 window/Syphon capture.");
        return 2;
    }
#endif
    app.setWindowIcon(QIcon(":/icons/vdoninja.ico"));
    app.setProperty("force_exit_without_shutdown", false);
    auto coreHolder = std::make_unique<versus::app::VersusApp>();
    auto &core = *coreHolder;
    core.initialize();
#ifdef __APPLE__
    // Start distributed discovery on the Cocoa event loop before source selection.
    core.listSyphonServers();
    core.setSyphonPremultiplied(syphonPremultiplied);
#endif
    auto writeDiagnostics = [&core, &diagnosticsOutArg](const char *reason) {
        if (diagnosticsOutArg.empty()) {
            return;
        }
        if (core.writeDiagnosticsJson(diagnosticsOutArg)) {
            spdlog::info("[Diagnostics] Exported diagnostics reason={} path={}",
                         reason ? reason : "unspecified",
                         diagnosticsOutArg);
        } else {
            spdlog::warn("[Diagnostics] Failed to export diagnostics reason={} path={}",
                         reason ? reason : "unspecified",
                         diagnosticsOutArg);
        }
    };
    if (headless && !versus::platform::capabilities().canPublish()) {
        spdlog::error("{}", versus::platform::capabilities().unavailableReason);
        writeDiagnostics("unsupported-platform");
        return 3;
    }
    core.onRuntimeEvent([headless](const std::string &message, bool fatal) {
        if (message.empty()) {
            return;
        }
        if (fatal) {
            spdlog::error("[Runtime] {}", message);
        } else {
            spdlog::warn("[Runtime] {}", message);
        }
        if (headless && fatal) {
            QMetaObject::invokeMethod(qApp, []() { QApplication::exit(3); }, Qt::QueuedConnection);
        }
    });

    QPointer<versus::ui::MainWindow> guiWindow;
    std::unique_ptr<versus::control::LocalControlServer> localControlServer;
    if (localControlEnabled) {
        localControlServer = std::make_unique<versus::control::LocalControlServer>();
        localControlServer->setDiagnosticsProvider([&core]() {
            return QByteArray::fromStdString(core.buildDiagnosticsJson());
        });
        localControlServer->setWindowSourcesProvider([&core]() {
            return sourceListToJson(core.listWindows());
        });
        localControlServer->setCameraSourcesProvider([&core]() {
            return sourceListToJson(core.listCameras());
        });
#ifdef __APPLE__
        localControlServer->setSyphonSourcesProvider([&core]() {
            return sourceListToJson(core.listSyphonServers());
        });
#endif
        localControlServer->setSpoutSourcesProvider([&core]() {
            return sourceListToJson(core.listSpoutSenders());
        });
        localControlServer->setAudioInputSourcesProvider([&core]() {
            return audioInputListToJson(core.listAudioInputDevices());
        });
        localControlServer->setStopCallback([&core, &guiWindow, headless]() {
            QMetaObject::invokeMethod(qApp, [&core, &guiWindow, headless]() {
                if (!headless && guiWindow) {
                    guiWindow->requestStop();
                    return;
                }
                core.stopLive();
                core.stopCapture();
            }, Qt::QueuedConnection);
        });
        localControlServer->setQuitCallback([&core, &guiWindow, headless]() {
            QMetaObject::invokeMethod(qApp, [&core, &guiWindow, headless]() {
                if (!headless && guiWindow) {
                    guiWindow->requestQuit();
                    return;
                }
                core.stopLive();
                core.stopCapture();
                QApplication::quit();
            }, Qt::QueuedConnection);
        });
        localControlServer->setRefreshPeerTransportsCallback([&core]() {
            return core.refreshPeerTransportsForLocalControl();
        });

        versus::control::LocalControlServerConfig controlConfig;
        controlConfig.port = static_cast<quint16>(localControlPort);
        controlConfig.token = QString::fromStdString(localControlTokenArg);
        controlConfig.discoveryPath = QString::fromStdString(localControlDiscoveryArg);
        controlConfig.logPath = QString::fromStdString(logPath);
        if (!localControlServer->start(controlConfig)) {
            spdlog::warn("[Main] Local control server was requested but could not start");
            localControlServer.reset();
        }
    }

    bool hasVideoConfigOverride = false;
    versus::video::EncoderConfig encoderOverride;
    if (!videoEncoderArg.empty()) {
        std::string normalized = videoEncoderArg;
        std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });

        if (normalized == "videotoolbox" || normalized == "vt") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::VideoToolbox;
            encoderOverride.explicitEncoderSelection = true;
            hasVideoConfigOverride = true;
        } else if (normalized == "nvenc" || normalized == "nvidia") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::NVENC;
            encoderOverride.explicitEncoderSelection = true;
            hasVideoConfigOverride = true;
        } else if (normalized == "ffmpeg" || normalized == "ffmpeg_nvenc") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::NVENC;
            encoderOverride.explicitEncoderSelection = true;
            encoderOverride.forceFfmpegNvenc = true;
            spdlog::warn("[Main] External FFmpeg NVENC mode is experimental; prefer --video-encoder=nvenc for production.");
            hasVideoConfigOverride = true;
#ifdef __linux__
        } else if (normalized == "vaapi" || normalized == "v4l2") {
            encoderOverride.preferredHardware = normalized == "vaapi" ? versus::video::HardwareEncoder::VAAPI : versus::video::HardwareEncoder::V4L2;
            encoderOverride.explicitEncoderSelection = true;
            hasVideoConfigOverride = true;
#endif
        } else if (normalized == "qsv" || normalized == "quicksync" || normalized == "intel") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::QuickSync;
            encoderOverride.explicitEncoderSelection = true;
            hasVideoConfigOverride = true;
        } else if (normalized == "amf" || normalized == "amd") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::AMF;
            encoderOverride.explicitEncoderSelection = true;
            hasVideoConfigOverride = true;
        } else if (normalized == "software" || normalized == "none" || normalized == "x264") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::None;
            encoderOverride.explicitEncoderSelection = true;
            hasVideoConfigOverride = true;
        } else if (normalized == "auto") {
            encoderOverride.explicitEncoderSelection = false;
            hasVideoConfigOverride = true;
        } else {
            spdlog::warn("[Main] Unknown --video-encoder value '{}'; expected auto|nvenc|qsv|amf|software|ffmpeg", videoEncoderArg);
        }
    }

    if (!videoCodecArg.empty()) {
        std::string normalized = videoCodecArg;
        std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });

        if (normalized == "h264" || normalized == "avc") {
            encoderOverride.codec = versus::video::VideoCodec::H264;
            hasVideoConfigOverride = true;
        } else if (normalized == "h265" || normalized == "hevc") {
            encoderOverride.codec = versus::video::VideoCodec::H265;
            hasVideoConfigOverride = true;
        } else if (normalized == "av1") {
            encoderOverride.codec = versus::video::VideoCodec::AV1;
            hasVideoConfigOverride = true;
        } else if (normalized == "vp9") {
            encoderOverride.codec = versus::video::VideoCodec::VP9;
            hasVideoConfigOverride = true;
        } else {
            spdlog::warn("[Main] Unknown --video-codec value '{}'; expected h264|h265|av1|vp9", videoCodecArg);
        }
    }

    if (alphaWorkflowEnabled) {
        encoderOverride.enableAlpha = true;
        hasVideoConfigOverride = true;
    }
    if (alphaBackgroundConfigured) {
        encoderOverride.alphaBackgroundMode = alphaBackgroundMode;
        encoderOverride.alphaBackgroundRed = alphaBackgroundColor[0];
        encoderOverride.alphaBackgroundGreen = alphaBackgroundColor[1];
        encoderOverride.alphaBackgroundBlue = alphaBackgroundColor[2];
        if (alphaBackgroundMode != versus::video::AlphaBackgroundMode::None) {
            encoderOverride.enableAlpha = false;
        }
        hasVideoConfigOverride = true;
    }

    if (width > 0) {
        encoderOverride.width = width;
        hasVideoConfigOverride = true;
    }
    if (height > 0) {
        encoderOverride.height = height;
        hasVideoConfigOverride = true;
    }
    if (fps > 0) {
        encoderOverride.frameRate = fps;
        encoderOverride.gopSize = fps;
        hasVideoConfigOverride = true;
    }
    if (bitrateKbps > 0) {
        encoderOverride.bitrate = bitrateKbps;
        encoderOverride.minBitrate = std::min(bitrateKbps, std::max(500, bitrateKbps / 2));
        encoderOverride.maxBitrate = bitrateKbps;
        hasVideoConfigOverride = true;
    }
    if (!ffmpegPathArg.empty()) {
        encoderOverride.ffmpegPath = ffmpegPathArg;
        hasVideoConfigOverride = true;
    }
    if (!ffmpegOptionsArg.empty()) {
        encoderOverride.ffmpegOptions = ffmpegOptionsArg;
        hasVideoConfigOverride = true;
    }

    if (outputConfig.protocol == versus::output::Protocol::VdoNinja &&
        (!outputConfig.url.empty() || !outputConfig.bearerToken.empty() || !outputConfig.streamKey.empty() ||
         !outputConfig.streamId.empty() || !outputConfig.passphrase.empty())) {
        spdlog::error("Select --output=whip, srt, rtmp, rtsp, rtsp-udp, udp or rist when supplying external output settings"); return 2;
    }
    if (outputConfig.protocol != versus::output::Protocol::VdoNinja) {
        if (!headless) { spdlog::error("Use advanced output settings in the GUI, or add --headless for output arguments"); return 2; }
        const auto error = versus::output::validateConfig(outputConfig);
        if (!error.empty()) { spdlog::error("{}", error); return 2; }
        if ((!videoCodecArg.empty() && videoCodecArg != "h264") || alphaWorkflowEnabled || pcmAudio || audioRed) {
            spdlog::error("External outputs require H.264 and Opus/AAC; alpha, PCM and RED are available with VDO.Ninja"); return 2;
        }
        encoderOverride.codec = versus::video::VideoCodec::H264;
        encoderOverride.enableAlpha = false;
        encoderOverride.bFrames = 0;
        hasVideoConfigOverride = true;
    }
    if (hasVideoConfigOverride) {
        spdlog::info("[Main] Applying video config override: encoder={} codec={} resolution={}x{} fps={} bitrate={}kbps alpha={} alphaBackground={}",
                     videoEncoderArg.empty() ? "default" : videoEncoderArg,
                     videoCodecArg.empty() ? "default" : videoCodecArg,
                     encoderOverride.width,
                     encoderOverride.height,
                     encoderOverride.frameRate,
                     encoderOverride.bitrate,
                     encoderOverride.enableAlpha,
                     static_cast<int>(encoderOverride.alphaBackgroundMode));
        core.setVideoConfig(encoderOverride);
    }
    core.setAudioSourceMode(audioSourceMode);
#ifdef __linux__
    core.setAudioProcess(audioProcessId);
    core.setCommunicationsOutputDeviceId(communicationsOutputDeviceId);
#endif
    // Protect ordinary Opus publishing against isolated loss. External
    // protocols and PCM retain their own transport/negotiation contracts.
    if (!audioRedSpecified && !pcmAudio &&
        outputConfig.protocol == versus::output::Protocol::VdoNinja) {
        audioRed = true;
    }
    if (pcmAudio && audioRed) {
        spdlog::error("--audio-red currently supports Opus only; PCM RED is not negotiated by the viewer");
        return 2;
    }
    if (!core.setAudioEncodingConfig(audioBitrateKbps, audioChannels, pcmAudio, audioRed)) {
        spdlog::error("Failed to apply audio encoding settings");
        return 2;
    }
    core.setVideoSourceMode(videoSourceMode);
    core.setIncludeMicrophone(includeMicrophone);
    core.setMicrophoneDeviceId(microphoneDeviceId);

    if (headless) {
        // Headless mode - auto-configure and start streaming
        spdlog::info("[Headless] Auto-starting streamId={} room={} password={} server={} durationMs={} maxViewers={} remoteControl={} roomModeLq={} iceMode={} source={} camera={} spoutSender={} audioSource={} includeMicrophone={} microphoneDevice={}",
                     streamId,
                     room.empty() ? "(none)" : room,
                     passwordLogValue(password),
                     server,
                     durationMs,
                     maxViewers,
                     remoteControlEnabled,
                     roomModeLqEnabled,
                     versus::webrtc::iceModeName(iceMode),
                     videoSourceArg,
                     cameraFilterArg.empty() ? "(auto)" : cameraFilterArg,
                     spoutSenderArg.empty() ? "(auto)" : spoutSenderArg,
                     audioSourceArg,
                     includeMicrophone,
                     microphoneDeviceId.empty() ? "(default)" : "(selected)");

        QTimer diagnosticsTimer;
        if (!diagnosticsOutArg.empty()) {
            QObject::connect(&diagnosticsTimer, &QTimer::timeout, [&writeDiagnostics]() {
                writeDiagnostics("headless-periodic");
            });
            diagnosticsTimer.start(5000);
        }

        // Configure
        versus::app::StartOptions options;
        options.output = outputConfig;
        options.server = server;
        options.streamId = streamId;
        options.password = password;
        options.room = room;
        options.label = label;
        options.salt = salt;
        options.maxViewers = maxViewers;
        options.remoteControlEnabled = remoteControlEnabled;
        options.remoteControlToken = remoteControlToken;
        options.roomModeLqEnabled = roomModeLqEnabled;
        options.iceMode = iceMode;
        if (outputConfig.protocol != versus::output::Protocol::VdoNinja) {
            options.streamId.clear(); options.room.clear(); options.password.clear();
            options.remoteControlEnabled = false; options.remoteControlToken.clear(); options.roomModeLqEnabled = false;
        }
        QTimer outputHealthTimer;
        if (outputConfig.protocol != versus::output::Protocol::VdoNinja) {
            QObject::connect(&outputHealthTimer, &QTimer::timeout, [&core, &writeDiagnostics]() {
                const auto status = core.getOutputStatus();
                if (status.state == versus::output::State::Error) {
                    spdlog::error("[Output] {}", status.message);
                    writeDiagnostics("output-error");
                    QApplication::exit(3);
                }
            });
            outputHealthTimer.start(500);
        }

        QTimer::singleShot(
            1000,
            [&core,
             options,
             windowFilterArg,
             videoSourceMode,
             spoutSenderArg,
#ifdef __APPLE__
             syphonServerArg,
#endif
             cameraFilterArg,
             cameraIdArg]() {
            if (videoSourceMode == versus::app::VideoSourceMode::Camera) {
                auto cameras = core.listCameras();
                if (cameras.empty()) {
                    spdlog::warn("[Headless] No cameras found for capture!");
                    spdlog::default_logger()->flush();
                    QApplication::exit(2);
                    return;
                }

                const versus::video::WindowInfo *selected = nullptr;
                if (!cameraIdArg.empty()) {
                    const auto match = std::find_if(cameras.begin(), cameras.end(), [&](const auto &camera) { return camera.id == cameraIdArg; });
                    if (match == cameras.end()) {
                        spdlog::error("[Headless] No camera has the exact requested --camera-id; no replacement camera will be opened");
                        spdlog::default_logger()->flush();
                        QApplication::exit(2);
                        return;
                    }
                    selected = &*match;
                } else if (!cameraFilterArg.empty()) {
                    selected = versus::video::findBestWindowMatch(cameras, cameraFilterArg);
                    if (!selected) {
                        spdlog::error(
                            "[Headless] No camera matched --camera={} ({} cameras available)",
                            cameraFilterArg,
                            cameras.size());
                        spdlog::default_logger()->flush();
                        QApplication::exit(2);
                        return;
                    }
                } else {
                    selected = &cameras[0];
                }

                spdlog::info(
                    "[Headless] Found {} cameras, capturing: {}",
                    cameras.size(),
                    selected->name);
                core.setVideoSourceMode(versus::app::VideoSourceMode::Camera);
                if (!core.startCapture(versus::app::VideoSourceMode::Camera, selected->id)) {
                    spdlog::error("[Headless] Camera startCapture failed");
                    spdlog::default_logger()->flush();
                    QApplication::exit(3);
                    return;
                }
#ifdef __APPLE__
            } else if (videoSourceMode == versus::app::VideoSourceMode::Syphon) {
                const auto servers = core.listSyphonServers();
                const versus::video::WindowInfo *selected = nullptr;
                for (const auto &sender : servers) {
                    if (sender.id == syphonServerArg) { selected = &sender; break; }
                }
                if (!selected) {
                    for (const auto &sender : servers) {
                        if (sender.name != syphonServerArg) continue;
                        if (selected) {
                            spdlog::error("[Headless] Ambiguous Syphon name; select an exact UUID from /sources/syphon");
                            QApplication::exit(2);
                            return;
                        }
                        selected = &sender;
                    }
                }
                if (!selected) {
                    spdlog::error("[Headless] Requested Syphon sender is unavailable; no replacement selected");
                    QApplication::exit(2);
                    return;
                }
                if (!core.startCapture(versus::app::VideoSourceMode::Syphon, selected->id)) {
                    spdlog::error("[Headless] Syphon capture failed: {}", core.lastCaptureError());
                    QApplication::exit(3);
                    return;
                }
#endif
            } else if (videoSourceMode == versus::app::VideoSourceMode::Spout) {
                auto senders = core.listSpoutSenders();
                if (senders.empty()) {
                    spdlog::warn("[Headless] No Spout2 senders found for capture!");
                    spdlog::default_logger()->flush();
                    QApplication::exit(2);
                    return;
                }

                const versus::video::WindowInfo *selected = nullptr;
                if (!spoutSenderArg.empty()) {
                    selected = versus::video::findBestWindowMatch(senders, spoutSenderArg);
                    if (!selected) {
                        spdlog::error("[Headless] No Spout2 sender matched --spout-sender={} ({} senders available)",
                                      spoutSenderArg,
                                      senders.size());
                        spdlog::default_logger()->flush();
                        QApplication::exit(2);
                        return;
                    }
                } else {
                    selected = &senders[0];
                }

                spdlog::info("[Headless] Found {} Spout2 senders, capturing: {} [{}x{}]",
                             senders.size(),
                             selected->name,
                             selected->width,
                             selected->height);
                core.setVideoSourceMode(versus::app::VideoSourceMode::Spout);
                if (!core.startCapture(versus::app::VideoSourceMode::Spout, selected->id)) {
                    spdlog::error("[Headless] Spout startCapture failed");
                    spdlog::default_logger()->flush();
                    QApplication::exit(3);
                    return;
                }
            } else {
                // Auto-select first available window for capture
                auto windows = core.listWindows();
                if (!windows.empty()) {
                    const versus::video::WindowInfo *selected = nullptr;

                    if (!windowFilterArg.empty()) {
                        selected = versus::video::findBestWindowMatch(windows, windowFilterArg);
                        if (!selected) {
                            spdlog::error("[Headless] No window matched --window={} ({} windows available)",
                                          windowFilterArg,
                                          windows.size());
                            spdlog::default_logger()->flush();
                            QApplication::exit(2);
                            return;
                        }
                    } else {
                        selected = &windows[0];
                    }

                    spdlog::info("[Headless] Found {} windows, capturing: {} [{} {}x{}]",
                                 windows.size(),
                                 selected->name,
                                 selected->executableName,
                                 selected->width,
                                 selected->height);
                    if (!core.startCapture(selected->id)) {
                        spdlog::error("[Headless] startCapture failed");
                        spdlog::default_logger()->flush();
                        QApplication::exit(3);
                        return;
                    }
                } else {
                    spdlog::warn("[Headless] No windows found for capture!");
                    spdlog::default_logger()->flush();
                    QApplication::exit(2);
                    return;
                }
            }

            spdlog::info("[Headless] Going live...");
            spdlog::default_logger()->flush();
            if (!core.goLive(options)) {
                spdlog::error("[Headless] goLive failed!");
                spdlog::default_logger()->flush();
                QApplication::exit(3);
                return;
            }
            spdlog::info("[Headless] Stream started, waiting for connections...");
            spdlog::default_logger()->flush();
        });

        // Run for configurable duration then exit
        QTimer::singleShot(durationMs, [&writeDiagnostics]() {
            spdlog::info("[Headless] Timeout, exiting");
            writeDiagnostics("headless-timeout");
            QApplication::quit();
        });

        const int result = app.exec();
        if (app.property("force_exit_without_shutdown").toBool()) {
            forceExitProcess(result);
        }
        writeDiagnostics("headless-exit");
        core.shutdown();
        return result;
    }

    // Normal GUI mode
    versus::ui::MainWindow window(&core, {!temporarySettings, true, settingsDirectory});
    guiWindow = &window;
    // Keep first launch usable on small screens and at high display scaling.
    // The content already scrolls; maximize rather than shrink its controls.
    const auto *screen = window.screen();
    const auto available = screen ? screen->availableGeometry().size() - QSize(16, 48) : QSize();
    if (screen && (window.width() > available.width() || window.height() > available.height()))
        window.showMaximized();
    else
        window.show();
    const int result = app.exec();
    if (app.property("force_exit_without_shutdown").toBool()) {
        forceExitProcess(result);
    }
    writeDiagnostics("gui-exit");
    core.shutdown();
    return result;
}
