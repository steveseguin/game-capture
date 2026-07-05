#include <QApplication>
#include <QIcon>
#include <QMetaObject>
#include <QObject>
#include <QTimer>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <optional>
#include <sstream>

#include <spdlog/spdlog.h>
#include <spdlog/sinks/basic_file_sink.h>
#include <spdlog/sinks/stdout_sinks.h>

#include "versus/app/versus_app.h"
#include "versus/ui/main_window.h"
#include "versus/video/window_capture.h"

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
    std::string videoSourceArg = "window";
    std::string spoutSenderArg;
    versus::app::VideoSourceMode videoSourceMode = versus::app::VideoSourceMode::Window;
    versus::app::AudioSourceMode audioSourceMode = versus::app::AudioSourceMode::SelectedWindow;
    std::string audioSourceArg = "selected-window";
    versus::webrtc::IceMode iceMode = versus::webrtc::IceMode::StunOnly;
    int width = 0;
    int height = 0;
    int fps = 0;
    int bitrateKbps = 0;
    int durationMs = 120000;
    int maxViewers = 10;
    bool remoteControlEnabled = false;
    std::string remoteControlToken;
    bool alphaWorkflowEnabled = false;
    bool includeMicrophone = false;
    std::string microphoneDeviceId;
    std::string diagnosticsOutArg;

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
        } else if (arg.find("--source=") == 0) {
            videoSourceArg = arg.substr(9);
            std::string normalized = videoSourceArg;
            std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
                return static_cast<char>(std::tolower(ch));
            });
            if (normalized == "spout" || normalized == "spout2") {
                videoSourceMode = versus::app::VideoSourceMode::Spout;
                videoSourceArg = "spout";
            } else if (normalized == "window" || normalized == "game" || normalized == "app") {
                videoSourceMode = versus::app::VideoSourceMode::Window;
                videoSourceArg = "window";
            } else {
                spdlog::warn("[Main] Unknown --source value '{}'; expected window|spout", videoSourceArg);
                videoSourceArg = "window";
                videoSourceMode = versus::app::VideoSourceMode::Window;
            }
        } else if (arg.find("--spout-sender=") == 0) {
            spoutSenderArg = arg.substr(15);
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
        } else if (arg.find("--remote-token=") == 0) {
            remoteControlToken = arg.substr(15);
        } else if (arg == "--include-microphone" || arg == "--include-mic") {
            includeMicrophone = true;
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
        }
    }

    // Set up logging - console for headless, file otherwise
    try {
        const std::string logPath = resolveLogFilePath();
        std::vector<spdlog::sink_ptr> sinks;
        sinks.push_back(std::make_shared<spdlog::sinks::basic_file_sink_mt>(logPath, true));
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
    if (videoSourceMode == versus::app::VideoSourceMode::Spout && audioSourceArg == "selected-window") {
        audioSourceArg = "none";
        audioSourceMode = versus::app::AudioSourceMode::None;
        spdlog::info("[Main] Defaulting audio source to none for Spout video source");
    }

    QApplication app(argc, argv);
    app.setWindowIcon(QIcon(":/icons/vdoninja.ico"));
    app.setProperty("force_exit_without_shutdown", false);
    auto coreHolder = std::make_unique<versus::app::VersusApp>();
    auto &core = *coreHolder;
    core.initialize();
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
    core.setAudioSourceMode(audioSourceMode);
    core.setVideoSourceMode(videoSourceMode);
    core.setIncludeMicrophone(includeMicrophone);
    core.setMicrophoneDeviceId(microphoneDeviceId);

    if (headless) {
        // Headless mode - auto-configure and start streaming
        spdlog::info("[Headless] Auto-starting streamId={} room={} password={} server={} durationMs={} maxViewers={} remoteControl={} iceMode={} source={} spoutSender={} audioSource={} includeMicrophone={} microphoneDevice={}",
                     streamId,
                     room.empty() ? "(none)" : room,
                     passwordLogValue(password),
                     server,
                     durationMs,
                     maxViewers,
                     remoteControlEnabled,
                     versus::webrtc::iceModeName(iceMode),
                     videoSourceArg,
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

        QTimer::singleShot(1000, [&core, options, windowFilterArg, videoSourceMode, spoutSenderArg]() {
            if (videoSourceMode == versus::app::VideoSourceMode::Spout) {
                auto senders = core.listSpoutSenders();
                if (senders.empty()) {
                    spdlog::warn("[Headless] No Spout2 senders found for capture!");
                    spdlog::default_logger()->flush();
                    QApplication::quit();
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
                        QApplication::quit();
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
                    QApplication::quit();
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
    versus::ui::MainWindow window(&core);
    window.show();
    const int result = app.exec();
    if (app.property("force_exit_without_shutdown").toBool()) {
        forceExitProcess(result);
    }
    writeDiagnostics("gui-exit");
    core.shutdown();
    return result;
}

