#include "versus/video/window_capture.h"

#include <algorithm>
#include <cctype>
#include <utility>

namespace versus::video {

namespace detail {

CaptureFramePacer::CaptureFramePacer(int targetFps) {
    reset(targetFps);
}

void CaptureFramePacer::reset(int targetFps) {
    scheduled_ = false;
    lastRefill_ = {};
    credits_ = 2.0;
    interval_ = targetFps > 0
        ? std::chrono::nanoseconds(1000000000LL / std::max(1, targetFps))
        : std::chrono::steady_clock::duration::zero();
}

bool CaptureFramePacer::shouldAdmit(std::chrono::steady_clock::time_point now) {
    if (interval_ <= std::chrono::steady_clock::duration::zero()) {
        return true;
    }
    if (!scheduled_) {
        lastRefill_ = now;
        scheduled_ = true;
    }
    // WGC can deliver distinct images in pairs only a few milliseconds apart.
    // Admit a bounded two-frame burst while retaining the requested average
    // rate. The encode worker paces output and holds at most two pending frames.
    const auto elapsed = std::max(now - lastRefill_,
                                  std::chrono::steady_clock::duration::zero());
    credits_ = std::min(2.0, credits_ + std::chrono::duration<double>(elapsed).count()
                                      / std::chrono::duration<double>(interval_).count());
    lastRefill_ = now;
    if (credits_ + 1e-9 < 1.0) {
        return false;
    }
    credits_ = std::max(0.0, credits_ - 1.0);
    return true;
}

bool frameAdmissionAllowed(const std::function<bool()> &admissionCallback) {
    return !admissionCallback || admissionCallback();
}

}  // namespace detail

namespace {

std::string toLowerCopy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

std::string executableStem(std::string executableName) {
    executableName = toLowerCopy(std::move(executableName));
    const size_t lastSlash = executableName.find_last_of("/\\");
    if (lastSlash != std::string::npos) {
        executableName.erase(0, lastSlash + 1);
    }
    if (executableName.size() > 4 && executableName.ends_with(".exe")) {
        executableName.resize(executableName.size() - 4);
    }
    return executableName;
}

int windowMatchScore(const WindowInfo &window, const std::string &filterLower) {
    if (filterLower.empty()) {
        return 0;
    }

    const std::string titleLower = toLowerCopy(window.name);
    const std::string exeLower = toLowerCopy(window.executableName);
    const std::string exeStemLower = executableStem(window.executableName);

    int score = 0;
    const auto titlePos = titleLower.find(filterLower);
    if (titleLower == filterLower) {
        score = std::max(score, 1000);
    } else if (titlePos != std::string::npos) {
        score = std::max(score, 850);
        if (titlePos == 0) {
            score = std::max(score, 900);
        }
        if (titlePos + filterLower.size() == titleLower.size()) {
            score = std::max(score, 920);
        }
        if (titleLower.find(" - " + filterLower) != std::string::npos ||
            titleLower.find(filterLower + " - ") != std::string::npos) {
            score = std::max(score, 950);
        }
    }

    if (exeStemLower == filterLower) {
        score = std::max(score, 700);
    } else if (exeLower == filterLower || exeLower == filterLower + ".exe") {
        score = std::max(score, 680);
    } else if (exeStemLower.find(filterLower) != std::string::npos) {
        score = std::max(score, 620);
    } else if (exeLower.find(filterLower) != std::string::npos) {
        score = std::max(score, 600);
    }

    if (score == 0) {
        return 0;
    }

    if (titlePos != std::string::npos) {
        score += 50;
    }

    if (window.width > 0 && window.height > 0) {
        const int areaBonus = std::min(40, (window.width * window.height) / 500000);
        score += areaBonus;
    }

    if (titlePos == std::string::npos && titleLower.size() <= 16) {
        score -= 25;
    }

    return score;
}

}  // namespace

const WindowInfo *findBestWindowMatch(const std::vector<WindowInfo> &windows, const std::string &filter) {
    if (windows.empty()) {
        return nullptr;
    }

    if (filter.empty()) {
        return &windows.front();
    }

    const std::string filterLower = toLowerCopy(filter);
    const WindowInfo *best = nullptr;
    int bestScore = 0;
    int bestArea = -1;

    for (const auto &window : windows) {
        const int score = windowMatchScore(window, filterLower);
        if (score <= 0) {
            continue;
        }

        const int area = std::max(0, window.width) * std::max(0, window.height);
        if (!best || score > bestScore || (score == bestScore && area > bestArea)) {
            best = &window;
            bestScore = score;
            bestArea = area;
        }
    }

    return best;
}

} // namespace versus::video
