#include "versus/platform/macos_system_resources.h"
#include <mach/mach.h>
#include <sys/sysctl.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <mutex>

namespace versus::platform {
MacSystemResources macSystemResources() {
    using Clock = std::chrono::steady_clock;
    struct Cache {
        std::mutex mutex;
        Clock::time_point sampled{};
        std::array<std::uint32_t, CPU_STATE_MAX> ticks{};
        bool cpuInitialized = false;
        double lastCpuPercent = -1;
        MacSystemResources value;
    };
    static Cache cache;
    std::lock_guard lock(cache.mutex);
    const auto now = Clock::now();
    if (cache.sampled != Clock::time_point{} && now - cache.sampled < std::chrono::milliseconds(250))
        return cache.value;
    cache.sampled = now;
    MacSystemResources result;
    const mach_port_t host = mach_host_self();
    if (!MACH_PORT_VALID(host)) return cache.value = result;

    host_cpu_load_info_data_t cpu{};
    mach_msg_type_number_t cpuCount = HOST_CPU_LOAD_INFO_COUNT;
    if (host_statistics(host, HOST_CPU_LOAD_INFO, reinterpret_cast<host_info_t>(&cpu), &cpuCount) == KERN_SUCCESS) {
        std::uint64_t total = 0, idle = 0;
        for (unsigned index = 0; index < CPU_STATE_MAX; ++index) {
            // Mach exposes wrapping 32-bit tick counters, including on arm64.
            const auto delta = static_cast<std::uint32_t>(cpu.cpu_ticks[index] - cache.ticks[index]);
            total += delta;
            if (index == CPU_STATE_IDLE) idle = delta;
            cache.ticks[index] = cpu.cpu_ticks[index];
        }
        if (cache.cpuInitialized && total)
            cache.lastCpuPercent = std::clamp(100.0 * static_cast<double>(total - idle) / static_cast<double>(total), 0.0, 100.0);
        cache.cpuInitialized = true;
        result.cpuPercent = cache.lastCpuPercent;
    }

    std::uint64_t physical = 0;
    size_t physicalSize = sizeof(physical);
    vm_size_t pageSize = 0;
    vm_statistics64_data_t memory{};
    mach_msg_type_number_t memoryCount = HOST_VM_INFO64_COUNT;
    if (sysctlbyname("hw.memsize", &physical, &physicalSize, nullptr, 0) == 0 && physicalSize == sizeof(physical) && physical &&
        host_page_size(host, &pageSize) == KERN_SUCCESS && pageSize &&
        host_statistics64(host, HOST_VM_INFO64, reinterpret_cast<host_info64_t>(&memory), &memoryCount) == KERN_SUCCESS) {
        // vm_statistics.h documents speculative pages as already included in
        // free_count. Do not count them a second time or count compressed pages
        // as their larger, uncompressed logical size.
        const auto available = (static_cast<std::uint64_t>(memory.free_count) + memory.inactive_count) * pageSize;
        result.memoryTotalBytes = physical;
        result.memoryUsedBytes = physical - std::min(physical, available);
        result.memoryPercent = 100.0 * static_cast<double>(result.memoryUsedBytes) / static_cast<double>(physical);
    }
    mach_port_deallocate(mach_task_self(), host);
    return cache.value = result;
}
}
