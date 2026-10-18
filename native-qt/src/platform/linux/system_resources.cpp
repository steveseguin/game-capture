#include "versus/platform/linux_system_resources.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <fstream>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>

namespace versus::platform {
LinuxSystemResources linuxSystemResources() {
    using Clock = std::chrono::steady_clock;
    struct Cache {
        std::mutex mutex;
        Clock::time_point sampled{};
        std::array<std::uint64_t, 8> ticks{};
        bool cpuInitialized = false;
        LinuxSystemResources value;
    };
    static Cache cache;
    std::lock_guard lock(cache.mutex);
    const auto now = Clock::now();
    if (cache.sampled != Clock::time_point{} && now - cache.sampled < std::chrono::milliseconds(250))
        return cache.value;
    cache.sampled = now;
    LinuxSystemResources result;

    // Aggregate user/nice/system/idle/iowait/irq/softirq/steal across all CPUs.
    // guest/guest_nice are already included in user/nice: do not add them again.
    std::ifstream stat("/proc/stat");
    std::string line, label;
    std::array<std::uint64_t, 8> ticks{};
    bool valid = false;
    if (std::getline(stat, line)) {
        std::istringstream row(line);
        valid = static_cast<bool>(row >> label) && label == "cpu";
        for (auto &tick : ticks)
            valid = static_cast<bool>(row >> tick) && valid;
    }
    if (valid) {
        long double total = 0, idle = 0;
        bool monotonic = true;
        for (std::size_t i = 0; i < ticks.size(); ++i) {
            if (ticks[i] < cache.ticks[i]) {
                monotonic = false;
                break;
            }
            const auto delta = ticks[i] - cache.ticks[i];
            total += delta;
            if (i == 3 || i == 4) idle += delta;
        }
        if (cache.cpuInitialized && monotonic) {
            if (total > 0)
                result.cpuPercent = std::clamp(static_cast<double>(100 * (total - idle) / total), 0.0, 100.0);
            else
                result.cpuPercent = cache.value.cpuPercent;
        }
        // iowait can decrease; rebase instead of unsigned underflow or a spike.
        cache.ticks = ticks;
    }
    cache.cpuInitialized = valid;

    std::ifstream meminfo("/proc/meminfo");
    std::uint64_t totalKiB = 0, availableKiB = 0;
    bool haveAvailable = false;
    while (std::getline(meminfo, line)) {
        std::istringstream row(line);
        std::string key, unit;
        std::uint64_t value = 0;
        if (!(row >> key >> value >> unit) || unit != "kB") continue;
        if (key == "MemTotal:") totalKiB = value;
        if (key == "MemAvailable:") { availableKiB = value; haveAvailable = true; }
    }
    if (totalKiB && haveAvailable && totalKiB <= std::numeric_limits<std::uint64_t>::max() / 1024) {
        result.memoryTotalBytes = totalKiB * 1024;
        result.memoryUsedBytes = (totalKiB - std::min(totalKiB, availableKiB)) * 1024;
        result.memoryPercent = 100.0 * static_cast<double>(result.memoryUsedBytes) /
                               static_cast<double>(result.memoryTotalBytes);
    }
    return cache.value = result;
}
}
