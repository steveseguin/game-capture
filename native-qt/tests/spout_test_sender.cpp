#include <SpoutLibrary.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr int kDefaultWidth = 640;
constexpr int kDefaultHeight = 360;
constexpr int kDefaultFps = 30;
constexpr int kDefaultDurationMs = 30000;

int parseIntArg(const std::string &value, int fallback) {
    try {
        size_t parsed = 0;
        const int result = std::stoi(value, &parsed);
        return parsed == value.size() ? result : fallback;
    } catch (...) {
        return fallback;
    }
}

void drawFrame(std::vector<uint8_t> &pixels, int width, int height, int frameIndex) {
    std::fill(pixels.begin(), pixels.end(), 0);

    const int boxSize = std::max(32, std::min(width, height) / 4);
    const int travel = std::max(1, width - boxSize);
    const int boxX = (frameIndex * 9) % travel;
    const int boxY = std::max(0, (height - boxSize) / 2);

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const size_t idx = (static_cast<size_t>(y) * static_cast<size_t>(width) + static_cast<size_t>(x)) * 4;
            const bool inBox = x >= boxX && x < boxX + boxSize && y >= boxY && y < boxY + boxSize;
            const int dx = x - (width / 2);
            const int dy = y - (height / 2);
            const int radiusSq = dx * dx + dy * dy;
            const int inner = std::max(1, std::min(width, height) / 6);
            const int outer = std::max(inner + 1, std::min(width, height) / 4);
            const bool inRing = radiusSq >= inner * inner && radiusSq <= outer * outer;

            if (inBox) {
                pixels[idx + 0] = 255;  // B
                pixels[idx + 1] = 90;   // G
                pixels[idx + 2] = 40;   // R
                pixels[idx + 3] = 255;  // A
            } else if (inRing) {
                pixels[idx + 0] = 80;
                pixels[idx + 1] = 220;
                pixels[idx + 2] = 255;
                pixels[idx + 3] = 128;
            }
        }
    }
}

}  // namespace

int main(int argc, char **argv) {
    std::string name = "Game Capture Spout Alpha Test";
    int width = kDefaultWidth;
    int height = kDefaultHeight;
    int fps = kDefaultFps;
    int durationMs = kDefaultDurationMs;
    int resizeAfterMs = 0;
    int resizeWidth = 0;
    int resizeHeight = 0;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg.rfind("--name=", 0) == 0) {
            name = arg.substr(7);
        } else if (arg.rfind("--width=", 0) == 0) {
            width = parseIntArg(arg.substr(8), width);
        } else if (arg.rfind("--height=", 0) == 0) {
            height = parseIntArg(arg.substr(9), height);
        } else if (arg.rfind("--fps=", 0) == 0) {
            fps = parseIntArg(arg.substr(6), fps);
        } else if (arg.rfind("--duration-ms=", 0) == 0) {
            durationMs = parseIntArg(arg.substr(14), durationMs);
        } else if (arg.rfind("--resize-after-ms=", 0) == 0) {
            resizeAfterMs = parseIntArg(arg.substr(18), resizeAfterMs);
        } else if (arg.rfind("--resize-width=", 0) == 0) {
            resizeWidth = parseIntArg(arg.substr(15), resizeWidth);
        } else if (arg.rfind("--resize-height=", 0) == 0) {
            resizeHeight = parseIntArg(arg.substr(16), resizeHeight);
        }
    }

    width = std::clamp(width, 64, 3840);
    height = std::clamp(height, 64, 2160);
    fps = std::clamp(fps, 1, 120);
    durationMs = std::max(1000, durationMs);
    resizeAfterMs = std::clamp(resizeAfterMs, 0, durationMs);
    resizeWidth = resizeWidth > 0 ? std::clamp(resizeWidth, 64, 3840) : width;
    resizeHeight = resizeHeight > 0 ? std::clamp(resizeHeight, 64, 2160) : height;

    SPOUTLIBRARY *sender = GetSpout();
    if (!sender) {
        std::cerr << "GetSpout failed\n";
        return 2;
    }

    if (!sender->CreateOpenGL(nullptr)) {
        std::cerr << "CreateOpenGL failed\n";
        sender->Release();
        return 3;
    }

    sender->SetSenderName(name.c_str());
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * static_cast<size_t>(height) * 4);

    std::cout << "SPOUT_TEST_SENDER_READY name=" << name
              << " width=" << width
              << " height=" << height
              << " fps=" << fps
              << std::endl;

    const auto start = std::chrono::steady_clock::now();
    const auto frameInterval = std::chrono::milliseconds(std::max(1, 1000 / fps));
    int frame = 0;
    bool resized = false;
    while (std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now() - start)
               .count() < durationMs) {
        const int elapsedMs = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - start)
            .count());
        if (!resized && resizeAfterMs > 0 && elapsedMs >= resizeAfterMs) {
            width = resizeWidth;
            height = resizeHeight;
            pixels.assign(static_cast<size_t>(width) * static_cast<size_t>(height) * 4, 0);
            resized = true;
            std::cout << "SPOUT_TEST_SENDER_RESIZED name=" << name
                      << " width=" << width
                      << " height=" << height
                      << std::endl;
        }
        drawFrame(pixels, width, height, frame++);
        sender->SendImage(pixels.data(), static_cast<unsigned int>(width), static_cast<unsigned int>(height), GL_BGRA, false);
        sender->HoldFps(fps);
        std::this_thread::sleep_for(frameInterval);
    }

    sender->ReleaseSender();
    sender->CloseOpenGL();
    sender->Release();
    return 0;
}
