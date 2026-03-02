#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "versus/video/video_encoder.h"
#include "versus/video/window_capture.h"

namespace {

using Clock = std::chrono::steady_clock;

struct BenchMode {
    std::string name;
    versus::video::HardwareEncoder preferredHardware;
    bool forceFfmpegNvenc;
};

struct BenchResult {
    std::string modeName;
    bool initOk = false;
    std::string activeEncoder;
    bool hardwareActive = false;
    int framesAttempted = 0;
    int framesEncoded = 0;
    int maxConsecutiveMisses = 0;
    std::uint64_t encodedBytes = 0;
    double elapsedSeconds = 0.0;
};

std::string lowerCopy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

double asSeconds(const Clock::duration d) {
    return std::chrono::duration_cast<std::chrono::duration<double>>(d).count();
}

versus::video::CapturedFrame makeFrame(int width, int height, int frameIndex, int frameRate) {
    versus::video::CapturedFrame frame;
    frame.width = width;
    frame.height = height;
    frame.stride = width * 4;
    frame.timestamp = static_cast<std::int64_t>(frameIndex) * (10000000LL / std::max(1, frameRate));
    frame.format = versus::video::CapturedFrame::Format::BGRA;
    frame.data.resize(static_cast<size_t>(frame.stride) * static_cast<size_t>(frame.height));

    for (int y = 0; y < height; ++y) {
        std::uint8_t *row = frame.data.data() + static_cast<size_t>(y) * static_cast<size_t>(frame.stride);
        for (int x = 0; x < width; ++x) {
            const int idx = x * 4;
            const std::uint8_t b = static_cast<std::uint8_t>((x + frameIndex * 3) & 0xFF);
            const std::uint8_t g = static_cast<std::uint8_t>((y + frameIndex * 2) & 0xFF);
            const std::uint8_t r = static_cast<std::uint8_t>((x + y + frameIndex * 5) & 0xFF);
            row[idx + 0] = b;
            row[idx + 1] = g;
            row[idx + 2] = r;
            row[idx + 3] = 255;
        }
    }

    return frame;
}

BenchResult runBench(const BenchMode &mode,
                     int width,
                     int height,
                     int fps,
                     int frameCount,
                     int bitrateKbps,
                     int progressEvery) {
    BenchResult result;
    result.modeName = mode.name;

    versus::video::EncoderConfig config;
    config.codec = versus::video::VideoCodec::H264;
    config.preferredHardware = mode.preferredHardware;
    config.forceFfmpegNvenc = mode.forceFfmpegNvenc;
    config.width = width;
    config.height = height;
    config.frameRate = fps;
    config.bitrate = bitrateKbps;
    config.minBitrate = std::max(250, bitrateKbps / 2);
    config.maxBitrate = std::max(config.bitrate, bitrateKbps + 4000);
    config.gopSize = std::max(1, fps);
    config.bFrames = 0;
    config.lowLatency = true;

    versus::video::VideoEncoder encoder;
    if (!encoder.initialize(config)) {
        return result;
    }

    result.initOk = true;
    result.activeEncoder = encoder.activeEncoderName();
    result.hardwareActive = encoder.isHardwareEncoderActive();

    const auto frameInterval = std::chrono::duration<double>(1.0 / static_cast<double>(std::max(1, fps)));
    auto nextFrameTime = Clock::now();
    const auto start = Clock::now();

    int consecutiveMisses = 0;
    for (int i = 0; i < frameCount; ++i) {
        const auto frame = makeFrame(width, height, i, fps);
        versus::video::EncodedPacket packet;
        const auto callStart = Clock::now();
        const bool ok = encoder.encode(frame, packet);
        const double callMs = asSeconds(Clock::now() - callStart) * 1000.0;
        result.framesAttempted++;
        if (ok) {
            result.framesEncoded++;
            result.encodedBytes += packet.data.size();
            consecutiveMisses = 0;
        } else {
            consecutiveMisses++;
            result.maxConsecutiveMisses = std::max(result.maxConsecutiveMisses, consecutiveMisses);
        }

        if (progressEvery > 0 && (((i + 1) % progressEvery) == 0 || callMs > 150.0)) {
            std::cout << "# progress"
                      << " mode=" << mode.name
                      << " frame=" << (i + 1)
                      << " ok=" << (ok ? 1 : 0)
                      << " callMs=" << std::fixed << std::setprecision(2) << callMs
                      << std::endl;
        }

        nextFrameTime += std::chrono::duration_cast<Clock::duration>(frameInterval);
        std::this_thread::sleep_until(nextFrameTime);
    }

    result.elapsedSeconds = std::max(0.001, asSeconds(Clock::now() - start));
    encoder.shutdown();
    return result;
}

void printResult(const BenchResult &r) {
    const double encodedFps = static_cast<double>(r.framesEncoded) / r.elapsedSeconds;
    const double successPct = (r.framesAttempted > 0)
        ? (100.0 * static_cast<double>(r.framesEncoded) / static_cast<double>(r.framesAttempted))
        : 0.0;
    const double avgKbitsPerFrame = (r.framesEncoded > 0)
        ? (8.0 * static_cast<double>(r.encodedBytes) / 1000.0) / static_cast<double>(r.framesEncoded)
        : 0.0;

    std::cout << "{"
              << "\"mode\":\"" << r.modeName << "\","
              << "\"initOk\":" << (r.initOk ? "true" : "false") << ","
              << "\"activeEncoder\":\"" << r.activeEncoder << "\","
              << "\"hardwareActive\":" << (r.hardwareActive ? "true" : "false") << ","
              << "\"framesAttempted\":" << r.framesAttempted << ","
              << "\"framesEncoded\":" << r.framesEncoded << ","
              << "\"successPct\":" << std::fixed << std::setprecision(2) << successPct << ","
              << "\"encodedFps\":" << std::fixed << std::setprecision(2) << encodedFps << ","
              << "\"maxConsecutiveMisses\":" << r.maxConsecutiveMisses << ","
              << "\"avgKbitsPerFrame\":" << std::fixed << std::setprecision(2) << avgKbitsPerFrame
              << "}" << std::endl;
}

}  // namespace

int main(int argc, char **argv) {
    int width = 1920;
    int height = 1080;
    int fps = 60;
    int frameCount = 600;
    int bitrateKbps = 12000;
    bool includeSoftware = false;
    int progressEvery = 0;
    std::set<std::string> modeFilter;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg.rfind("--width=", 0) == 0) {
            width = std::max(160, std::stoi(arg.substr(8)));
        } else if (arg.rfind("--height=", 0) == 0) {
            height = std::max(90, std::stoi(arg.substr(9)));
        } else if (arg.rfind("--fps=", 0) == 0) {
            fps = std::clamp(std::stoi(arg.substr(6)), 10, 120);
        } else if (arg.rfind("--frames=", 0) == 0) {
            frameCount = std::max(60, std::stoi(arg.substr(9)));
        } else if (arg.rfind("--bitrate-kbps=", 0) == 0) {
            bitrateKbps = std::max(250, std::stoi(arg.substr(15)));
        } else if (arg == "--with-software") {
            includeSoftware = true;
        } else if (arg.rfind("--progress-every=", 0) == 0) {
            progressEvery = std::max(0, std::stoi(arg.substr(17)));
        } else if (arg.rfind("--mode=", 0) == 0) {
            std::string raw = arg.substr(7);
            size_t pos = 0;
            while (pos < raw.size()) {
                const size_t comma = raw.find(',', pos);
                const std::string token = raw.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
                if (!token.empty()) {
                    modeFilter.insert(lowerCopy(token));
                }
                if (comma == std::string::npos) {
                    break;
                }
                pos = comma + 1;
            }
        }
    }

    std::vector<BenchMode> allModes = {
        {"nvenc-mf", versus::video::HardwareEncoder::NVENC, false},
        {"nvenc-ffmpeg", versus::video::HardwareEncoder::NVENC, true},
        {"qsv", versus::video::HardwareEncoder::QuickSync, false},
        {"amf", versus::video::HardwareEncoder::AMF, false},
    };
    if (includeSoftware) {
        allModes.push_back({"software", versus::video::HardwareEncoder::None, false});
    }

    std::vector<BenchMode> modes;
    for (const auto &mode : allModes) {
        if (modeFilter.empty() || modeFilter.count(lowerCopy(mode.name)) > 0) {
            modes.push_back(mode);
        }
    }

    std::cout << "# bench_video_encoder"
              << " width=" << width
              << " height=" << height
              << " fps=" << fps
              << " frames=" << frameCount
              << " bitrateKbps=" << bitrateKbps;
    if (!modeFilter.empty()) {
        std::cout << " modeFilter=";
        bool first = true;
        for (const auto &entry : modeFilter) {
            if (!first) {
                std::cout << ",";
            }
            std::cout << entry;
            first = false;
        }
    }
    std::cout
              << std::endl;

    if (modes.empty()) {
        std::cerr << "No modes selected via --mode" << std::endl;
        return 2;
    }

    for (const auto &mode : modes) {
        const BenchResult result = runBench(mode, width, height, fps, frameCount, bitrateKbps, progressEvery);
        printResult(result);
    }

    return 0;
}
