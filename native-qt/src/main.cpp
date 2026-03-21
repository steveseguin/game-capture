#include <QApplication>
#include <QIcon>
#include <QMetaObject>
#include <QTimer>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <sstream>

#include <spdlog/spdlog.h>
#include <spdlog/sinks/basic_file_sink.h>
#include <spdlog/sinks/stdout_color_sinks.h>

#include "versus/app/versus_app.h"
#include "versus/ui/main_window.h"
#include "versus/video/window_capture.h"

namespace {

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
#else
    return "game-capture-debug.log";
#endif
}

}  // namespace

int main(int argc, char *argv[]) {
    // Check for --headless mode
    bool headless = false;
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
    versus::webrtc::IceMode iceMode = versus::webrtc::IceMode::All;
    int width = 0;
    int height = 0;
    int fps = 0;
    int bitrateKbps = 0;
    int durationMs = 120000;
    int maxViewers = 10;
    bool remoteControlEnabled = false;
    std::string remoteControlToken;
    bool alphaWorkflowEnabled = false;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--headless") {
            headless = true;
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
        } else if (arg.find("--resolution=") == 0) {
            const std::string resolution = arg.substr(13);
            const auto xPos = resolution.find('x');
            if (xPos != std::string::npos) {
                try {
                    width = std::max(1, std::stoi(resolution.substr(0, xPos)));
                    height = std::max(1, std::stoi(resolution.substr(xPos + 1)));
                } catch (...) {
                    // Keep defaults when parse fails.
                }
            }
        } else if (arg.find("--width=") == 0) {
            try {
                width = std::max(1, std::stoi(arg.substr(8)));
            } catch (...) {
                // Keep default on parse errors.
            }
        } else if (arg.find("--height=") == 0) {
            try {
                height = std::max(1, std::stoi(arg.substr(9)));
            } catch (...) {
                // Keep default on parse errors.
            }
        } else if (arg.find("--fps=") == 0) {
            try {
                fps = std::max(1, std::stoi(arg.substr(6)));
            } catch (...) {
                // Keep default on parse errors.
            }
        } else if (arg.find("--bitrate-kbps=") == 0) {
            try {
                bitrateKbps = std::max(1, std::stoi(arg.substr(15)));
            } catch (...) {
                // Keep default on parse errors.
            }
        } else if (arg.find("--duration-ms=") == 0) {
            try {
                durationMs = std::max(1000, std::stoi(arg.substr(14)));
            } catch (...) {
                // Keep default duration on parse errors.
            }
        } else if (arg.find("--max-viewers=") == 0) {
            try {
                maxViewers = std::max(0, std::stoi(arg.substr(14)));
            } catch (...) {
                // Keep default on parse errors.
            }
        } else if (arg == "--remote-control") {
            remoteControlEnabled = true;
        } else if (arg.find("--remote-token=") == 0) {
            remoteControlToken = arg.substr(15);
        } else if (arg == "--alpha-workflow") {
            alphaWorkflowEnabled = true;
        }
    }

    // Set up logging - console for headless, file otherwise
    try {
        if (headless) {
            auto console_logger = spdlog::stdout_color_mt("game-capture");
            spdlog::set_default_logger(console_logger);
        } else {
            const std::string logPath = resolveLogFilePath();
            auto file_logger = spdlog::basic_logger_mt("game-capture", logPath, true);
            spdlog::set_default_logger(file_logger);
            spdlog::info("Logging to {}", logPath);
        }
        spdlog::set_level(spdlog::level::debug);
        spdlog::flush_on(spdlog::level::debug);
        spdlog::info("Game Capture app starting (headless={})", headless);
    } catch (...) {
        // Fall back to default logger
    }

    QApplication app(argc, argv);
    app.setWindowIcon(QIcon(":/icons/vdoninja.ico"));
    versus::app::VersusApp core;
    core.initialize();
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
            QMetaObject::invokeMethod(qApp, []() { QApplication::quit(); }, Qt::QueuedConnection);
        }
    });

    bool hasVideoConfigOverride = false;
    versus::video::EncoderConfig encoderOverride;
    if (!videoEncoderArg.empty()) {
        std::string normalized = videoEncoderArg;
        std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });

        if (normalized == "nvenc" || normalized == "nvidia") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::NVENC;
            hasVideoConfigOverride = true;
        } else if (normalized == "ffmpeg" || normalized == "ffmpeg_nvenc") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::NVENC;
            encoderOverride.forceFfmpegNvenc = true;
            spdlog::warn("[Main] External FFmpeg NVENC mode is experimental; prefer --video-encoder=nvenc for production.");
            hasVideoConfigOverride = true;
        } else if (normalized == "qsv" || normalized == "quicksync" || normalized == "intel") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::QuickSync;
            hasVideoConfigOverride = true;
        } else if (normalized == "amf" || normalized == "amd") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::AMF;
            hasVideoConfigOverride = true;
        } else if (normalized == "software" || normalized == "none") {
            encoderOverride.preferredHardware = versus::video::HardwareEncoder::None;
            hasVideoConfigOverride = true;
        } else {
            spdlog::warn("[Main] Unknown --video-encoder value '{}'; expected nvenc|qsv|amf|software|ffmpeg", videoEncoderArg);
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
        hasVideoConfigOverride = true;
    }
    if (bitrateKbps > 0) {
        encoderOverride.bitrate = bitrateKbps;
        encoderOverride.minBitrate = std::max(500, bitrateKbps / 2);
        encoderOverride.maxBitrate = std::max(bitrateKbps + 4000, (bitrateKbps * 3) / 2);
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

    if (hasVideoConfigOverride) {
        spdlog::info("[Main] Applying video config override: encoder={} codec={} resolution={}x{} fps={} bitrate={}kbps alpha={}",
                     videoEncoderArg.empty() ? "default" : videoEncoderArg,
                     videoCodecArg.empty() ? "default" : videoCodecArg,
                     encoderOverride.width,
                     encoderOverride.height,
                     encoderOverride.frameRate,
                     encoderOverride.bitrate,
                     encoderOverride.enableAlpha);
        core.setVideoConfig(encoderOverride);
    }

    if (headless) {
        // Headless mode - auto-configure and start streaming
        spdlog::info("[Headless] Auto-starting streamId={} room={} password={} server={} durationMs={} maxViewers={} remoteControl={} iceMode={}",
                     streamId,
                     room.empty() ? "(none)" : room,
                     password,
                     server,
                     durationMs,
                     maxViewers,
                     remoteControlEnabled,
                     versus::webrtc::iceModeName(iceMode));

        // Configure
        versus::app::StartOptions options;
        options.server = server;
        options.streamId = streamId;
        options.password = password;
        options.room = room;
        options.label = label;
        options.salt = salt;
        options.maxViewers = maxViewers;
        options.remoteControlEnabled = remoteControlEnabled;
        options.remoteControlToken = remoteControlToken;
        options.iceMode = iceMode;

        QTimer::singleShot(1000, [&core, options, windowFilterArg]() {
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
                        QApplication::quit();
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
                    QApplication::quit();
                    return;
                }
            } else {
                spdlog::warn("[Headless] No windows found for capture!");
                spdlog::default_logger()->flush();
                QApplication::quit();
                return;
            }

            spdlog::info("[Headless] Going live...");
            spdlog::default_logger()->flush();
            if (!core.goLive(options)) {
                spdlog::error("[Headless] goLive failed!");
                spdlog::default_logger()->flush();
                QApplication::quit();
                return;
            }
            spdlog::info("[Headless] Stream started, waiting for connections...");
            spdlog::default_logger()->flush();
        });

        // Run for configurable duration then exit
        QTimer::singleShot(durationMs, []() {
            spdlog::info("[Headless] Timeout, exiting");
            QApplication::quit();
        });

        const int result = app.exec();
        core.shutdown();
        return result;
    }

    // Normal GUI mode
    versus::ui::MainWindow window(&core);
    window.show();
    const int result = app.exec();
    core.shutdown();
    return result;
}

