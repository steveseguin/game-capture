#pragma once

#include "versus/video/window_capture.h"
#include <QtCore/QString>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <vector>

namespace versus::app::detail {

// Opt-in QA trace for the embedded-ID browser fixture. Disabled in ordinary
// runs, bounded to 100,000 rows, and buffered rather than flushed per frame.
class FrameTrace {
  public:
    static FrameTrace &instance() { static FrameTrace trace; return trace; }
    void record(const char *stage, const video::CapturedFrame *frame, int64_t pts) {
        if (!enabled_) return;
        std::lock_guard<std::mutex> lock(mutex_);
        if (rows_ >= 100000) return;
        ++rows_;
        const auto now = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count() / 100;
        file_ << stage << ',' << now << ',' << (frame ? frame->timestamp : 0)
              << ',' << pts << ',' << (frame ? marker(*frame) : -1) << ','
              << std::chrono::duration_cast<std::chrono::milliseconds>(
                     std::chrono::system_clock::now().time_since_epoch()).count() << '\n';
    }
  private:
    FrameTrace() {
        movingEdge_ = qEnvironmentVariable("VERSUS_FRAME_TRACE_PATTERN") == "alpha-moving-edge";
        const auto path = qEnvironmentVariable("VERSUS_FRAME_TRACE");
        if (!path.isEmpty()) {
            file_.open(std::filesystem::path(path.toStdWString()));
            enabled_ = file_.is_open();
            file_ << "stage,now100ns,capture100ns,output100ns,id,wallMs\n";
        }
    }
    int marker(const video::CapturedFrame &f) {
        if (f.format != video::CapturedFrame::Format::BGRA || f.width < 1 ||
            f.height < 1 || f.stride < f.width * 4 ||
            f.data.size() < static_cast<size_t>(f.stride) * f.height) return -1;
        if (movingEdge_) {
            // Fixture identity is its blue rectangle's left edge (9 px/step).
            // Sample one row; avoid the browser-marker search on this fixture.
            const auto *row = f.data.data() + static_cast<size_t>(f.height / 2) * f.stride;
            for (int x = 0; x < f.width; ++x) {
                const auto *p = row + x * 4;
                if (p[0] > 160 && p[1] < 100 && p[2] < 100) return x;
            }
            return -1;
        }
        const int h = std::max(1L, std::lround(640.0 * f.height / f.width));
        auto pixel = [&](double x, double y) {
            const int sx = std::clamp<int>(std::lround(x * f.width / 640.0), 0, f.width - 1);
            const int sy = std::clamp<int>(std::lround(y * f.height / h), 0, f.height - 1);
            return &f.data[static_cast<size_t>(sy) * f.stride + sx * 4];
        };
        auto mag = [&](double x, double y) {
            const auto p = pixel(x, y);
            return p[2] > 160 && p[1] < 100 && p[0] > 160;
        };
        auto cyan = [&](double x, double y) {
            const auto p = pixel(x, y);
            return p[2] < 100 && p[1] > 160 && p[0] > 160;
        };
        auto read = [&](double x, double y, double cell) {
            int id = 0;
            for (int bit = 0; bit < 12; ++bit) {
                const auto a = pixel(x + (bit + 2) * cell, y)[2];
                const auto b = pixel(x + (bit + 14) * cell, y)[2];
                const int va = a > 160 ? 1 : a < 90 ? 0 : -1;
                const int vb = b > 160 ? 1 : b < 90 ? 0 : -1;
                if (va < 0 || vb < 0 || va == vb) return -1;
                id |= va << bit;
            }
            return id;
        };
        if (height_ == h && cell_ > 0 && mag(x_, y_) && cyan(x_ + cell_, y_)) {
            const int id = read(x_, y_, cell_);
            if (id >= 0) return id;
        }
        cell_ = 0;
        height_ = h;
        for (int y = h * 6 / 10; y < h - 4; y += 2) {
            std::vector<double> runs;
            for (int x = 0; x < 640; ++x) if (mag(x, y)) {
                const int first = x;
                while (x < 640 && mag(x, y)) ++x;
                if (x - first >= 3 && x - first <= 20) runs.push_back((first + x - 1) / 2.0);
            }
            for (double left : runs) for (double right : runs) {
                const double cell = (right - left) / 27;
                if (cell < 3 || cell > 20 || !cyan(left + cell, y) || !cyan(left + 26 * cell, y)) continue;
                const int id = read(left, y + 3, cell);
                if (id >= 0) {
                    x_ = left;
                    y_ = y + 3;
                    cell_ = cell;
                    return id;
                }
            }
        }
        return -1;
    }
    bool enabled_ = false;
    bool movingEdge_ = false;
    std::ofstream file_;
    std::mutex mutex_;
    unsigned rows_ = 0;
    double x_ = 0, y_ = 0, cell_ = 0;
    int height_ = 0;
};
} // namespace versus::app::detail
