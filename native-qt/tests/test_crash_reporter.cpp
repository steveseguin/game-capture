#include "versus/diagnostics/crash_reporter.h"

#include <windows.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <exception>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr DWORD kSyntheticExceptionCode = 0xE047C001;

std::filesystem::path currentExecutablePath() {
    std::wstring buffer(MAX_PATH, L'\0');
    for (;;) {
        const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (length == 0) {
            return {};
        }
        if (length < buffer.size() - 1) {
            buffer.resize(length);
            return std::filesystem::path(buffer);
        }
        buffer.resize(buffer.size() * 2);
    }
}

std::wstring quoteArg(const std::wstring &arg) {
    std::wstring quoted = L"\"";
    for (const wchar_t ch : arg) {
        if (ch == L'"') {
            quoted += L"\\\"";
        } else {
            quoted += ch;
        }
    }
    quoted += L"\"";
    return quoted;
}

int runChild(const std::filesystem::path &crashDir, const std::string &mode) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    versus::diagnostics::installCrashReporter({
        crashDir.string(),
        (crashDir / "child.log").string(),
        "crash-reporter-test"
    });

    if (mode == "seh") {
        RaiseException(kSyntheticExceptionCode, EXCEPTION_NONCONTINUABLE, 0, nullptr);
    }
    if (mode == "terminate") {
        std::terminate();
    }
    return 0;
}

bool startChildAndWait(const std::filesystem::path &crashDir, const std::string &mode, DWORD &exitCode) {
    const auto exe = currentExecutablePath();
    if (exe.empty()) {
        std::cerr << "Could not resolve current executable path\n";
        return false;
    }

    std::wstring modeWide(mode.begin(), mode.end());
    std::wstring commandLine =
        quoteArg(exe.wstring()) +
        L" --child " +
        quoteArg(modeWide) +
        L" " +
        quoteArg(crashDir.wstring());
    std::vector<wchar_t> mutableCommandLine(commandLine.begin(), commandLine.end());
    mutableCommandLine.push_back(L'\0');

    STARTUPINFOW startupInfo{};
    startupInfo.cb = sizeof(startupInfo);
    PROCESS_INFORMATION processInfo{};
    if (!CreateProcessW(
            nullptr,
            mutableCommandLine.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_NO_WINDOW,
            nullptr,
            nullptr,
            &startupInfo,
            &processInfo)) {
        std::cerr << "CreateProcessW failed: " << GetLastError() << "\n";
        return false;
    }

    const DWORD waitResult = WaitForSingleObject(processInfo.hProcess, 15000);
    if (waitResult == WAIT_TIMEOUT) {
        TerminateProcess(processInfo.hProcess, 0xFFFF);
        CloseHandle(processInfo.hThread);
        CloseHandle(processInfo.hProcess);
        std::cerr << "Crash reporter child timed out for mode " << mode << "\n";
        return false;
    }
    if (waitResult != WAIT_OBJECT_0) {
        CloseHandle(processInfo.hThread);
        CloseHandle(processInfo.hProcess);
        std::cerr << "WaitForSingleObject failed for mode " << mode << ": " << GetLastError() << "\n";
        return false;
    }

    if (!GetExitCodeProcess(processInfo.hProcess, &exitCode)) {
        CloseHandle(processInfo.hThread);
        CloseHandle(processInfo.hProcess);
        std::cerr << "GetExitCodeProcess failed: " << GetLastError() << "\n";
        return false;
    }
    CloseHandle(processInfo.hThread);
    CloseHandle(processInfo.hProcess);
    return true;
}

std::string readFile(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::in | std::ios::binary);
    return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

bool hasCrashArtifacts(const std::filesystem::path &crashDir, const std::string &expectedReason) {
    bool foundJson = false;
    bool foundDump = false;
    for (const auto &entry : std::filesystem::directory_iterator(crashDir)) {
        if (!entry.is_regular_file()) {
            continue;
        }
        if (entry.path().extension() == ".dmp" && entry.file_size() > 0) {
            foundDump = true;
        }
        if (entry.path().extension() == ".json") {
            const std::string content = readFile(entry.path());
            if (content.find("\"reason\": \"" + expectedReason + "\"") != std::string::npos) {
                foundJson = true;
            }
        }
    }
    if (!foundJson) {
        std::cerr << "No crash JSON found for reason " << expectedReason << "\n";
    }
    if (!foundDump) {
        std::cerr << "No minidump found\n";
    }
    return foundJson && foundDump;
}

bool verifyCrashMode(const std::filesystem::path &root, const std::string &mode, const std::string &reason) {
    const auto crashDir = root / mode;
    std::filesystem::create_directories(crashDir);

    DWORD exitCode = 0;
    if (!startChildAndWait(crashDir, mode, exitCode)) {
        return false;
    }
    if (exitCode == 0) {
        std::cerr << "Child unexpectedly exited cleanly for mode " << mode << "\n";
        return false;
    }
    return hasCrashArtifacts(crashDir, reason);
}

} // namespace

int main(int argc, char **argv) {
    if (argc == 4 && std::string(argv[1]) == "--child") {
        return runChild(std::filesystem::path(argv[3]), argv[2]);
    }

    const auto root =
        std::filesystem::temp_directory_path() /
        ("game-capture-crash-reporter-test-" + std::to_string(GetCurrentProcessId()));
    std::filesystem::remove_all(root);
    std::filesystem::create_directories(root);

    const bool sehOk = verifyCrashMode(root, "seh", "unhandled_exception");
    const bool terminateOk = verifyCrashMode(root, "terminate", "terminate");

    if (sehOk && terminateOk) {
        std::filesystem::remove_all(root);
        return 0;
    }

    std::cerr << "Crash reporter artifacts left at " << root.string() << "\n";
    return 1;
}
