#pragma once
#include <cstdint>

namespace versus::platform {
struct MacSystemResources {
    double cpuPercent = -1;
    double memoryPercent = -1;
    std::uint64_t memoryTotalBytes = 0;
    std::uint64_t memoryUsedBytes = 0;
};
// System-wide load, matching the existing Windows diagnostics contract.
// CPU needs two samples. Memory treats free/inactive pages as available;
// this is a physical-use estimate, not macOS's memory-pressure indicator.
MacSystemResources macSystemResources();
}
