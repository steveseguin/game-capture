#pragma once

#include <QtCore/QString>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <vector>

namespace versus::audio::detail {

// Opt-in capture diagnostics. Records timing and signal energy, not audio.
// Each capture thread owns its file; ordinary capture does no signal analysis.
class CaptureTrace {
public:
    explicit CaptureTrace(unsigned long threadId) {
        const auto prefix = qEnvironmentVariable("VERSUS_AUDIO_CAPTURE_TRACE");
        if (prefix.isEmpty()) return;
        file_.open(std::filesystem::path(
            (prefix + "." + QString::number(threadId) + ".csv").toStdWString()));
        enabled_ = file_.is_open();
        if (enabled_) file_ << "arrival100ns,capture100ns,devicePosition,frames,flags,rate,channels,rms,peak\n";
    }

    void record(int64_t captureTime, uint64_t position, unsigned frames,
                unsigned flags, unsigned rate, unsigned channels,
                const std::vector<float> &samples) {
        if (!enabled_ || rows_ >= 100000) return;
        ++rows_;
        const auto arrival = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count() / 100;
        double sum = 0, peak = 0;
        for (const float sample : samples) {
            sum += static_cast<double>(sample) * sample;
            peak = std::max(peak, std::abs(static_cast<double>(sample)));
        }
        const double rms = samples.empty() ? 0 : std::sqrt(sum / samples.size());
        file_ << arrival << ',' << captureTime << ',' << position << ',' << frames
              << ',' << flags << ',' << rate << ',' << channels << ',' << rms << ',' << peak << '\n';
    }

private:
    std::ofstream file_;
    bool enabled_ = false;
    unsigned rows_ = 0;
};
}
