#include "versus/webrtc/ice_config.h"

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <limits>
#include <optional>
#include <sstream>
#include <string_view>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#endif

namespace versus::webrtc {
namespace {

using json = nlohmann::json;

constexpr int kMinutesPerDay = 60 * 24;
constexpr int kMaxUdpTurnServers = 2;
constexpr int kMaxTcpTurnServers = 1;
constexpr int64_t kTurnListEpochOffsetMs = 1653305816700LL;

struct TurnServerCandidate {
    IceServerConfig server;
    std::optional<int> tz;
    std::optional<int> distance;
    int originalIndex = 0;
};

int currentTimezoneOffsetMinutes() {
#ifdef _WIN32
    TIME_ZONE_INFORMATION tzInfo;
    const DWORD result = GetTimeZoneInformation(&tzInfo);
    LONG totalBias = tzInfo.Bias;
    if (result == TIME_ZONE_ID_DAYLIGHT) {
        totalBias += tzInfo.DaylightBias;
    } else if (result == TIME_ZONE_ID_STANDARD) {
        totalBias += tzInfo.StandardBias;
    }
    return static_cast<int>(totalBias);
#else
    return 0;
#endif
}

std::string toLowerCopy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

bool startsWithInsensitive(const std::string &value, std::string_view prefix) {
    if (value.size() < prefix.size()) {
        return false;
    }
    for (size_t i = 0; i < prefix.size(); ++i) {
        if (std::tolower(static_cast<unsigned char>(value[i])) !=
            std::tolower(static_cast<unsigned char>(prefix[i]))) {
            return false;
        }
    }
    return true;
}

bool isTurnUrl(const std::string &url) {
    return startsWithInsensitive(url, "turn:") || startsWithInsensitive(url, "turns:");
}

bool isPrivateIpv4(std::string_view address) {
    if (address.starts_with("10.") || address.starts_with("192.168.")) {
        return true;
    }
    if (!address.starts_with("172.")) {
        return false;
    }

    const size_t secondDot = address.find('.', 4);
    if (secondDot == std::string_view::npos) {
        return false;
    }
    try {
        const int secondOctet = std::stoi(std::string(address.substr(4, secondDot - 4)));
        return secondOctet >= 16 && secondOctet <= 31;
    } catch (...) {
        return false;
    }
}

std::optional<std::string_view> extractCandidateAddress(std::string_view candidate) {
    const std::string_view prefix = "candidate:";
    if (candidate.starts_with(prefix)) {
        candidate.remove_prefix(prefix.size());
    }

    size_t tokenIndex = 0;
    size_t position = 0;
    while (position < candidate.size()) {
        while (position < candidate.size() && candidate[position] == ' ') {
            ++position;
        }
        if (position >= candidate.size()) {
            break;
        }
        const size_t nextSpace = candidate.find(' ', position);
        const std::string_view token =
            nextSpace == std::string_view::npos
                ? candidate.substr(position)
                : candidate.substr(position, nextSpace - position);
        if (tokenIndex == 4) {
            return token;
        }
        ++tokenIndex;
        if (nextSpace == std::string_view::npos) {
            break;
        }
        position = nextSpace + 1;
    }
    return std::nullopt;
}

std::vector<std::string> splitLines(const std::string &text) {
    std::vector<std::string> lines;
    std::string current;
    std::istringstream stream(text);
    while (std::getline(stream, current)) {
        if (!current.empty() && current.back() == '\r') {
            current.pop_back();
        }
        lines.push_back(current);
    }
    if (!text.empty() && (text.back() == '\n' || text.back() == '\r')) {
        lines.emplace_back();
    }
    return lines;
}

std::string joinLines(const std::vector<std::string> &lines, std::string_view delimiter) {
    std::ostringstream oss;
    for (size_t i = 0; i < lines.size(); ++i) {
        if (i != 0) {
            oss << delimiter;
        }
        oss << lines[i];
    }
    return oss.str();
}

std::vector<IceServerConfig> defaultStunServers() {
    return {
        {"stun:stun.l.google.com:19302", "", "", true},
        {"stun:stun.cloudflare.com:3478", "", "", true},
    };
}

std::vector<TurnServerCandidate> fallbackTurnCandidates() {
    return {
        {{"turn:turn-cae2.vdo.ninja:3478", "vdoninja", "canuk", true}, std::nullopt, 490, 0},
        {{"turn:turn-cae1.vdo.ninja:3478", "steve", "setupYourOwnPlease", true}, std::nullopt, 519, 1},
        {{"turns:turn-cae2.vdo.ninja:443", "vdoninja", "canuk", false}, std::nullopt, 490, 2},
        {{"turns:www.turn.obs.ninja:443", "steve", "setupYourOwnPlease", false}, 300, std::nullopt, 3},
        {{"turn:turn-cae1.vdo.ninja:3478", "steve", "setupYourOwnPlease", true}, 300, std::nullopt, 4},
        {{"turn:turn-usw2.vdo.ninja:3478", "vdoninja", "theyBeSharksHere", true}, 480, std::nullopt, 5},
        {{"turn:turn-eu4.vdo.ninja:3478", "vdoninja", "PolandPirat", true}, -70, std::nullopt, 6},
        {{"turns:turn.obs.ninja:443", "steve", "setupYourOwnPlease", false}, -60, std::nullopt, 7},
        {{"turn:turn-eu1.vdo.ninja:3478", "steve", "setupYourOwnPlease", true}, -60, std::nullopt, 8},
        {{"turn:turn-use1.vdo.ninja:3478", "vdoninja", "EastSideRepresentZ", true}, 300, std::nullopt, 9},
    };
}

int scoreTurnServer(const TurnServerCandidate &candidate, int localTimezoneMinutes) {
    if (candidate.distance.has_value()) {
        return *candidate.distance;
    }
    if (!candidate.tz.has_value()) {
        return std::numeric_limits<int>::max() / 2 + candidate.originalIndex;
    }
    int delta = std::abs(*candidate.tz - localTimezoneMinutes);
    const int wrappedDelta = std::abs(delta - kMinutesPerDay);
    if (wrappedDelta < delta) {
        delta = wrappedDelta;
    }
    return delta;
}

std::vector<IceServerConfig> processTurnCandidates(const std::vector<TurnServerCandidate> &rawCandidates) {
    std::vector<TurnServerCandidate> candidates = rawCandidates;
    const int localTimezoneMinutes = currentTimezoneOffsetMinutes();
    std::stable_sort(candidates.begin(), candidates.end(), [localTimezoneMinutes](const TurnServerCandidate &lhs,
                                                                                  const TurnServerCandidate &rhs) {
        const int lhsScore = scoreTurnServer(lhs, localTimezoneMinutes);
        const int rhsScore = scoreTurnServer(rhs, localTimezoneMinutes);
        if (lhsScore != rhsScore) {
            return lhsScore < rhsScore;
        }
        return lhs.originalIndex < rhs.originalIndex;
    });

    std::vector<IceServerConfig> selected;
    int udpCount = 0;
    int tcpCount = 0;
    for (const auto &candidate : candidates) {
        if (candidate.server.udp) {
            if (udpCount >= kMaxUdpTurnServers) {
                continue;
            }
            ++udpCount;
        } else {
            if (tcpCount >= kMaxTcpTurnServers) {
                continue;
            }
            ++tcpCount;
        }
        selected.push_back(candidate.server);
    }
    return selected;
}

std::vector<TurnServerCandidate> parseTurnCandidates(const json &root) {
    std::vector<TurnServerCandidate> out;
    if (!root.is_object() || !root.contains("servers") || !root["servers"].is_array()) {
        return out;
    }

    int originalIndex = 0;
    for (const auto &server : root["servers"]) {
        if (!server.is_object()) {
            continue;
        }
        const std::string username = server.value("username", "");
        const std::string credential = server.value("credential", "");
        const bool udp = server.value("udp", true);
        const std::optional<int> tz =
            server.contains("tz") && server["tz"].is_number_integer()
                ? std::optional<int>(server["tz"].get<int>())
                : std::nullopt;
        const std::optional<int> distance =
            server.contains("distance") && server["distance"].is_number_integer()
                ? std::optional<int>(server["distance"].get<int>())
                : std::nullopt;

        auto appendUrl = [&](const std::string &url) {
            if (!isTurnUrl(url)) {
                return;
            }
            TurnServerCandidate candidate;
            candidate.server.url = url;
            candidate.server.username = username;
            candidate.server.credential = credential;
            candidate.server.udp = udp;
            candidate.tz = tz;
            candidate.distance = distance;
            candidate.originalIndex = originalIndex++;
            out.push_back(candidate);
        };

        if (server.contains("urls") && server["urls"].is_array()) {
            for (const auto &urlValue : server["urls"]) {
                if (urlValue.is_string()) {
                    appendUrl(urlValue.get<std::string>());
                }
            }
        } else if (server.contains("urls") && server["urls"].is_string()) {
            appendUrl(server["urls"].get<std::string>());
        } else if (server.contains("url") && server["url"].is_string()) {
            appendUrl(server["url"].get<std::string>());
        }
    }

    return out;
}

#ifdef _WIN32
std::wstring widen(const std::string &value) {
    if (value.empty()) {
        return {};
    }
    const int length = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
    if (length <= 0) {
        return {};
    }
    std::wstring wide(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, wide.data(), length);
    if (!wide.empty() && wide.back() == L'\0') {
        wide.pop_back();
    }
    return wide;
}

std::optional<std::string> fetchTurnListJson(int timeoutMs) {
    const auto nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
    const std::string path = "/?ts=" + std::to_string(nowMs - kTurnListEpochOffsetMs);

    HINTERNET sessionHandle = WinHttpOpen(L"GameCapture/1.0",
                                          WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                          WINHTTP_NO_PROXY_NAME,
                                          WINHTTP_NO_PROXY_BYPASS,
                                          0);
    if (!sessionHandle) {
        spdlog::warn("[ICE] WinHttpOpen failed: {}", GetLastError());
        return std::nullopt;
    }

    std::optional<std::string> result;
    do {
        WinHttpSetTimeouts(sessionHandle, timeoutMs, timeoutMs, timeoutMs, timeoutMs);

        HINTERNET connectHandle = WinHttpConnect(sessionHandle, L"turnservers.vdo.ninja",
                                                 INTERNET_DEFAULT_HTTPS_PORT, 0);
        if (!connectHandle) {
            spdlog::warn("[ICE] WinHttpConnect failed: {}", GetLastError());
            break;
        }

        const std::wstring widePath = widen(path);
        HINTERNET requestHandle =
            WinHttpOpenRequest(connectHandle, L"GET", widePath.c_str(), nullptr,
                               WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                               WINHTTP_FLAG_SECURE);
        if (!requestHandle) {
            spdlog::warn("[ICE] WinHttpOpenRequest failed: {}", GetLastError());
            WinHttpCloseHandle(connectHandle);
            break;
        }

        if (!WinHttpSendRequest(requestHandle,
                                WINHTTP_NO_ADDITIONAL_HEADERS,
                                0,
                                WINHTTP_NO_REQUEST_DATA,
                                0,
                                0,
                                0)) {
            spdlog::warn("[ICE] WinHttpSendRequest failed: {}", GetLastError());
            WinHttpCloseHandle(requestHandle);
            WinHttpCloseHandle(connectHandle);
            break;
        }

        if (!WinHttpReceiveResponse(requestHandle, nullptr)) {
            spdlog::warn("[ICE] WinHttpReceiveResponse failed: {}", GetLastError());
            WinHttpCloseHandle(requestHandle);
            WinHttpCloseHandle(connectHandle);
            break;
        }

        DWORD statusCode = 0;
        DWORD statusCodeSize = sizeof(statusCode);
        if (!WinHttpQueryHeaders(requestHandle,
                                 WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                 WINHTTP_HEADER_NAME_BY_INDEX,
                                 &statusCode,
                                 &statusCodeSize,
                                 WINHTTP_NO_HEADER_INDEX)) {
            spdlog::warn("[ICE] WinHttpQueryHeaders(status) failed: {}", GetLastError());
            WinHttpCloseHandle(requestHandle);
            WinHttpCloseHandle(connectHandle);
            break;
        }

        if (statusCode != 200) {
            spdlog::warn("[ICE] TURN list endpoint returned HTTP {}", statusCode);
            WinHttpCloseHandle(requestHandle);
            WinHttpCloseHandle(connectHandle);
            break;
        }

        std::string body;
        for (;;) {
            DWORD available = 0;
            if (!WinHttpQueryDataAvailable(requestHandle, &available)) {
                spdlog::warn("[ICE] WinHttpQueryDataAvailable failed: {}", GetLastError());
                body.clear();
                break;
            }
            if (available == 0) {
                break;
            }

            std::string chunk(static_cast<size_t>(available), '\0');
            DWORD bytesRead = 0;
            if (!WinHttpReadData(requestHandle, chunk.data(), available, &bytesRead)) {
                spdlog::warn("[ICE] WinHttpReadData failed: {}", GetLastError());
                body.clear();
                break;
            }
            chunk.resize(static_cast<size_t>(bytesRead));
            body.append(chunk);
        }

        if (!body.empty()) {
            result = body;
        }

        WinHttpCloseHandle(requestHandle);
        WinHttpCloseHandle(connectHandle);
    } while (false);

    WinHttpCloseHandle(sessionHandle);
    return result;
}
#else
std::optional<std::string> fetchTurnListJson(int /*timeoutMs*/) {
    return std::nullopt;
}
#endif

}  // namespace

bool ResolvedIceConfig::hasTurnServers() const {
    return std::any_of(servers.begin(), servers.end(), [](const IceServerConfig &server) {
        return isTurnUrl(server.url);
    });
}

std::string iceModeName(IceMode mode) {
    switch (mode) {
        case IceMode::All:
            return "all";
        case IceMode::HostOnly:
            return "host-only";
        case IceMode::Relay:
            return "relay";
        case IceMode::StunOnly:
            return "stun-only";
    }
    return "all";
}

ResolvedIceConfig resolveIceConfig(IceMode mode, int fetchTimeoutMs) {
    ResolvedIceConfig resolved;
    if (mode != IceMode::HostOnly) {
        resolved.servers = defaultStunServers();
    }

    if (mode == IceMode::HostOnly) {
        spdlog::info("[ICE] Mode={} fetchedTurnList=0 fallbackTurns=0 servers=", iceModeName(mode));
        return resolved;
    }

    auto payload = fetchTurnListJson(fetchTimeoutMs);
    std::vector<TurnServerCandidate> turnCandidates;
    if (payload.has_value()) {
        const auto parsed = json::parse(*payload, nullptr, false);
        if (!parsed.is_discarded()) {
            turnCandidates = parseTurnCandidates(parsed);
            resolved.fetchedTurnList = !turnCandidates.empty();
        }
    }

    if (turnCandidates.empty()) {
        turnCandidates = fallbackTurnCandidates();
        resolved.usedFallbackTurnList = true;
    }

    const auto selectedTurns = processTurnCandidates(turnCandidates);
    resolved.servers.insert(resolved.servers.end(), selectedTurns.begin(), selectedTurns.end());

    std::ostringstream summary;
    summary << "[ICE] Mode=" << iceModeName(mode)
            << " fetchedTurnList=" << resolved.fetchedTurnList
            << " fallbackTurns=" << resolved.usedFallbackTurnList
            << " servers=";
    for (size_t i = 0; i < resolved.servers.size(); ++i) {
        if (i != 0) {
            summary << ", ";
        }
        summary << resolved.servers[i].url;
    }
    spdlog::info("{}", summary.str());

    return resolved;
}

bool candidateLooksRelay(const std::string &candidate) {
    return toLowerCopy(candidate).find(" typ relay") != std::string::npos;
}

bool candidateLooksServerReflexive(const std::string &candidate) {
    return toLowerCopy(candidate).find(" typ srflx") != std::string::npos;
}

bool candidateAllowedForMode(const std::string &candidate, IceMode mode) {
    switch (mode) {
        case IceMode::All:
            return true;
        case IceMode::HostOnly:
            return toLowerCopy(candidate).find(" typ host") != std::string::npos;
        case IceMode::Relay:
            return candidateLooksRelay(candidate);
        case IceMode::StunOnly: {
            if (!candidateLooksServerReflexive(candidate)) {
                return false;
            }
            const auto address = extractCandidateAddress(candidate);
            if (!address.has_value()) {
                return false;
            }
            return !isPrivateIpv4(*address);
        }
    }
    return true;
}

std::string filterSessionDescriptionForMode(const std::string &sdp, IceMode mode) {
    if (mode == IceMode::All || sdp.empty()) {
        return sdp;
    }

    const std::string delimiter = sdp.find("\r\n") != std::string::npos ? "\r\n" : "\n";
    const auto originalLines = splitLines(sdp);
    std::vector<std::string> filteredLines;
    filteredLines.reserve(originalLines.size());

    std::string selectedAddress;
    std::string selectedPort;

    for (const auto &line : originalLines) {
        if (line.rfind("a=candidate:", 0) == 0) {
            if (!candidateAllowedForMode(line.substr(2), mode)) {
                continue;
            }

            std::istringstream iss(line.substr(2));
            std::vector<std::string> parts;
            std::string part;
            while (iss >> part) {
                parts.push_back(part);
            }
            if (parts.size() > 5 && selectedAddress.empty()) {
                selectedAddress = parts[4];
                selectedPort = parts[5];
            }
        }
        filteredLines.push_back(line);
    }

    if (selectedAddress.empty() || selectedPort.empty()) {
        return joinLines(filteredLines, delimiter);
    }

    const std::string cLinePrefix = selectedAddress.find(':') != std::string::npos ? "c=IN IP6 " : "c=IN IP4 ";
    for (auto &line : filteredLines) {
        if (line.rfind("m=", 0) == 0) {
            std::istringstream iss(line);
            std::vector<std::string> parts;
            std::string part;
            while (iss >> part) {
                parts.push_back(part);
            }
            if (parts.size() >= 2) {
                parts[1] = selectedPort;
                std::ostringstream rebuilt;
                for (size_t i = 0; i < parts.size(); ++i) {
                    if (i != 0) {
                        rebuilt << ' ';
                    }
                    rebuilt << parts[i];
                }
                line = rebuilt.str();
            }
        } else if (line.rfind("c=", 0) == 0) {
            line = cLinePrefix + selectedAddress;
        }
    }

    return joinLines(filteredLines, delimiter);
}

}  // namespace versus::webrtc
