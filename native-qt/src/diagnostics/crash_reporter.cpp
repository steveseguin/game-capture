#include "versus/diagnostics/crash_reporter.h"

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <string>
#include <exception>

#include <spdlog/spdlog.h>

#ifdef _WIN32
#include <windows.h>
#include <dbghelp.h>
#endif

namespace versus::diagnostics {
namespace {

#ifdef _WIN32

struct CrashReporterState {
    std::filesystem::path crashDirectory;
    std::string logPath;
    std::string appVersion;
    std::atomic_bool handling{false};
    std::terminate_handler previousTerminate = nullptr;
};

CrashReporterState &crashState() {
    static CrashReporterState state;
    return state;
}

std::string timestampForFile() {
    SYSTEMTIME now{};
    GetLocalTime(&now);
    std::ostringstream out;
    out << std::setfill('0')
        << std::setw(4) << now.wYear
        << std::setw(2) << now.wMonth
        << std::setw(2) << now.wDay
        << "-"
        << std::setw(2) << now.wHour
        << std::setw(2) << now.wMinute
        << std::setw(2) << now.wSecond
        << "-"
        << std::setw(3) << now.wMilliseconds;
    return out.str();
}

std::string hexValue(uint64_t value) {
    std::ostringstream out;
    out << "0x" << std::hex << std::uppercase << value;
    return out.str();
}

std::string jsonEscape(const std::string &value) {
    std::string escaped;
    escaped.reserve(value.size() + 8);
    for (const char ch : value) {
        switch (ch) {
            case '\\':
                escaped += "\\\\";
                break;
            case '"':
                escaped += "\\\"";
                break;
            case '\b':
                escaped += "\\b";
                break;
            case '\f':
                escaped += "\\f";
                break;
            case '\n':
                escaped += "\\n";
                break;
            case '\r':
                escaped += "\\r";
                break;
            case '\t':
                escaped += "\\t";
                break;
            default:
                if (static_cast<unsigned char>(ch) < 0x20) {
                    std::ostringstream code;
                    code << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                         << static_cast<int>(static_cast<unsigned char>(ch));
                    escaped += code.str();
                } else {
                    escaped += ch;
                }
                break;
        }
    }
    return escaped;
}

void writeTextFile(const std::filesystem::path &path,
                   const char *reason,
                   EXCEPTION_POINTERS *exceptionPointers,
                   const std::string &message,
                   const std::filesystem::path &dumpPath,
                   bool dumpWritten) {
    try {
        std::ofstream out(path, std::ios::out | std::ios::trunc);
        if (!out) {
            return;
        }
        const DWORD processId = GetCurrentProcessId();
        const DWORD threadId = GetCurrentThreadId();
        out << "{\n";
        out << "  \"schema\": \"game-capture-crash-report-v1\",\n";
        out << "  \"reason\": \"" << jsonEscape(reason ? reason : "unknown") << "\",\n";
        out << "  \"timestamp\": \"" << jsonEscape(timestampForFile()) << "\",\n";
        out << "  \"process_id\": " << processId << ",\n";
        out << "  \"thread_id\": " << threadId << ",\n";
        out << "  \"app_version\": \"" << jsonEscape(crashState().appVersion) << "\",\n";
        out << "  \"log_path\": \"" << jsonEscape(crashState().logPath) << "\",\n";
        out << "  \"dump_path\": \"" << jsonEscape(dumpPath.string()) << "\",\n";
        out << "  \"dump_written\": " << (dumpWritten ? "true" : "false");
        if (!message.empty()) {
            out << ",\n  \"message\": \"" << jsonEscape(message) << "\"";
        }
        if (exceptionPointers && exceptionPointers->ExceptionRecord) {
            const auto *record = exceptionPointers->ExceptionRecord;
            out << ",\n  \"exception_code\": \"" << hexValue(record->ExceptionCode) << "\"";
            out << ",\n  \"exception_address\": \""
                << hexValue(reinterpret_cast<uintptr_t>(record->ExceptionAddress)) << "\"";
        }
        out << "\n}\n";
    } catch (...) {
    }
}

bool writeMiniDump(const std::filesystem::path &path, EXCEPTION_POINTERS *exceptionPointers) {
    HANDLE file = CreateFileW(
        path.wstring().c_str(),
        GENERIC_WRITE,
        0,
        nullptr,
        CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }

    MINIDUMP_EXCEPTION_INFORMATION exceptionInfo{};
    exceptionInfo.ThreadId = GetCurrentThreadId();
    exceptionInfo.ExceptionPointers = exceptionPointers;
    exceptionInfo.ClientPointers = FALSE;

    const MINIDUMP_TYPE dumpType = static_cast<MINIDUMP_TYPE>(
        MiniDumpNormal |
        MiniDumpWithThreadInfo |
        MiniDumpWithUnloadedModules);
    const BOOL ok = MiniDumpWriteDump(
        GetCurrentProcess(),
        GetCurrentProcessId(),
        file,
        dumpType,
        exceptionPointers ? &exceptionInfo : nullptr,
        nullptr,
        nullptr);
    CloseHandle(file);
    return ok == TRUE;
}

void writeCrashReport(const char *reason, EXCEPTION_POINTERS *exceptionPointers, const std::string &message) {
    auto &state = crashState();
    if (state.handling.exchange(true)) {
        return;
    }

    std::filesystem::path reportPath;
    std::filesystem::path dumpPath;
    bool dumpWritten = false;
    try {
        std::filesystem::create_directories(state.crashDirectory);
        const std::string baseName =
            std::string("crash-") +
            timestampForFile() +
            "-pid" +
            std::to_string(GetCurrentProcessId());
        reportPath = state.crashDirectory / (baseName + ".json");
        dumpPath = state.crashDirectory / (baseName + ".dmp");
        dumpWritten = writeMiniDump(dumpPath, exceptionPointers);
        writeTextFile(reportPath, reason, exceptionPointers, message, dumpPath, dumpWritten);
    } catch (...) {
    }

    try {
        spdlog::critical(
            "[CrashReporter] Captured crash reason={} dumpWritten={} report={} dump={}",
            reason ? reason : "unknown",
            dumpWritten,
            reportPath.string(),
            dumpPath.string());
        if (auto logger = spdlog::default_logger()) {
            logger->flush();
        }
    } catch (...) {
    }
}

LONG WINAPI unhandledExceptionFilter(EXCEPTION_POINTERS *exceptionPointers) {
    writeCrashReport("unhandled_exception", exceptionPointers, {});
    return EXCEPTION_EXECUTE_HANDLER;
}

void terminateHandler() {
    std::string message = "std::terminate called";
    try {
        if (const auto current = std::current_exception()) {
            try {
                std::rethrow_exception(current);
            } catch (const std::exception &e) {
                message = e.what();
            } catch (...) {
                message = "std::terminate called with non-standard exception";
            }
        }
    } catch (...) {
    }

    writeCrashReport("terminate", nullptr, message);

    auto previous = crashState().previousTerminate;
    if (previous && previous != terminateHandler) {
        previous();
    }
    std::abort();
}

#endif

} // namespace

std::string defaultCrashDirectory() {
#ifdef _WIN32
    const char *localAppData = std::getenv("LOCALAPPDATA");
    std::filesystem::path crashDir = localAppData && *localAppData
        ? std::filesystem::path(localAppData)
        : std::filesystem::current_path();
    crashDir /= "GameCapture";
    crashDir /= "crashes";
    return crashDir.string();
#else
    return {};
#endif
}

void installCrashReporter(const CrashReporterConfig &config) {
#ifdef _WIN32
    auto &state = crashState();
    state.crashDirectory = config.crashDirectory.empty()
        ? std::filesystem::path(defaultCrashDirectory())
        : std::filesystem::path(config.crashDirectory);
    state.logPath = config.logPath;
    state.appVersion = config.appVersion;
    state.handling.store(false);
    state.previousTerminate = std::set_terminate(terminateHandler);
    SetUnhandledExceptionFilter(unhandledExceptionFilter);
    try {
        std::filesystem::create_directories(state.crashDirectory);
        spdlog::info("[CrashReporter] Crash reports directory: {}", state.crashDirectory.string());
    } catch (const std::exception &e) {
        spdlog::warn("[CrashReporter] Could not prepare crash reports directory: {}", e.what());
    } catch (...) {
        spdlog::warn("[CrashReporter] Could not prepare crash reports directory");
    }
#else
    (void)config;
#endif
}

} // namespace versus::diagnostics
