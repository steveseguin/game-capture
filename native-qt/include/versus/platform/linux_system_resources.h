#pragma once
#include <cstdint>

namespace versus::platform {
struct LinuxSystemResources {
    double cpuPercent = -1;
    double memoryPercent = -1;
    std::uint64_t memoryTotalBytes = 0;
    std::uint64_t memoryUsedBytes = 0;
};
// Host-wide load for the shared diagnostics/UI contract, not process or cgroup
// usage. CPU needs two samples; memory usage excludes MemAvailable.
LinuxSystemResources linuxSystemResources();
}
