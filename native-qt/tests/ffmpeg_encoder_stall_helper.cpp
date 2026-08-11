#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

bool hasArgument(int argc, char **argv, const std::string &expected) {
    for (int index = 1; index < argc; ++index) {
        if (argv[index] == expected) {
            return true;
        }
    }
    return false;
}

std::string argumentValue(int argc, char **argv, const std::string &option) {
    for (int index = 1; index + 1 < argc; ++index) {
        if (argv[index] == option) {
            return argv[index + 1];
        }
    }
    return {};
}

int incrementLaunchCount(const std::string &statePath) {
    int launchCount = 0;
    {
        std::ifstream input(statePath);
        input >> launchCount;
    }
    ++launchCount;
    {
        std::ofstream output(statePath, std::ios::trunc);
        output << launchCount << '\n';
        output.flush();
    }
    return launchCount;
}

void writeLe16(std::ostream &output, uint16_t value) {
    const std::array<char, 2> bytes = {
        static_cast<char>(value & 0xff),
        static_cast<char>((value >> 8) & 0xff),
    };
    output.write(bytes.data(), bytes.size());
}

void writeLe32(std::ostream &output, uint32_t value) {
    const std::array<char, 4> bytes = {
        static_cast<char>(value & 0xff),
        static_cast<char>((value >> 8) & 0xff),
        static_cast<char>((value >> 16) & 0xff),
        static_cast<char>((value >> 24) & 0xff),
    };
    output.write(bytes.data(), bytes.size());
}

void writeLe64(std::ostream &output, uint64_t value) {
    writeLe32(output, static_cast<uint32_t>(value & 0xffffffffULL));
    writeLe32(output, static_cast<uint32_t>(value >> 32));
}

void writeIvfHeader(std::ostream &output, int width, int height) {
    output.write("DKIF", 4);
    writeLe16(output, 0);
    writeLe16(output, 32);
    output.write("VP90", 4);
    writeLe16(output, static_cast<uint16_t>(width));
    writeLe16(output, static_cast<uint16_t>(height));
    writeLe32(output, 30);
    writeLe32(output, 1);
    writeLe32(output, 0);
    writeLe32(output, 0);
}

void writeVp9Keyframe(std::ostream &output, uint64_t timestamp) {
    constexpr std::array<uint8_t, 4> payload = {0x82, 0x49, 0x83, 0x42};
    writeLe32(output, static_cast<uint32_t>(payload.size()));
    writeLe64(output, timestamp);
    output.write(
        reinterpret_cast<const char *>(payload.data()),
        static_cast<std::streamsize>(payload.size()));
    output.flush();
}

}  // namespace

int main(int argc, char **argv) {
    if (hasArgument(argc, argv, "-version")) {
        std::cout << "ffmpeg version versus-stall-helper\n"
                     "configuration: --disable-gpl --disable-nonfree\n";
        return 0;
    }
    if (hasArgument(argc, argv, "-encoders")) {
        std::cout << "Encoders:\n V..... libvpx-vp9 deterministic test encoder\n";
        return 0;
    }

    const char *stateEnvironment = std::getenv("VERSUS_FFMPEG_STALL_STATE_PATH");
    if (!stateEnvironment || *stateEnvironment == '\0') {
        return 20;
    }
    const int launchCount = incrementLaunchCount(stateEnvironment);
    const bool parkOutput = launchCount == 2;

    int width = 64;
    int height = 64;
    const std::string videoSize = argumentValue(argc, argv, "-video_size");
    const auto separator = videoSize.find('x');
    if (separator != std::string::npos) {
        width = std::max(1, std::stoi(videoSize.substr(0, separator)));
        height = std::max(1, std::stoi(videoSize.substr(separator + 1)));
    }
    const std::string pixelFormat = argumentValue(argc, argv, "-pix_fmt");
    size_t frameBytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
    if (pixelFormat == "nv12" || pixelFormat == "yuv420p") {
        frameBytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 3 / 2;
    } else if (pixelFormat == "gray") {
        frameBytes = static_cast<size_t>(width) * static_cast<size_t>(height);
    }

#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    std::vector<char> frame(frameBytes);
    bool headerWritten = false;
    uint64_t timestamp = 0;
    while (std::cin.read(frame.data(), static_cast<std::streamsize>(frame.size()))) {
        if (parkOutput) {
            continue;
        }
        if (!headerWritten) {
            writeIvfHeader(std::cout, width, height);
            headerWritten = true;
        }
        writeVp9Keyframe(std::cout, timestamp++);
    }
    return 0;
}
