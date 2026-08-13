#include "versus/webrtc/ice_config.h"

#include <mbedtls/md.h>
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#endif

namespace versus::webrtc {
namespace {

using json = nlohmann::json;
using ordered_json = nlohmann::ordered_json;

constexpr int64_t kTurnListEpochOffsetMs = 1653305816700LL;
constexpr std::string_view kTurnRegistryBaseUrl = "https://turnservers.vdo.ninja/";

std::string sha256Hex(std::string_view input) {
    std::array<unsigned char, 32> digest{};
    mbedtls_md_context_t context;
    mbedtls_md_init(&context);
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (info == nullptr ||
        mbedtls_md_setup(&context, info, 0) != 0 ||
        mbedtls_md_starts(&context) != 0 ||
        mbedtls_md_update(
            &context,
            reinterpret_cast<const unsigned char *>(input.data()),
            input.size()) != 0 ||
        mbedtls_md_finish(&context, digest.data()) != 0) {
        mbedtls_md_free(&context);
        throw std::runtime_error("Unable to compute TURN registry SHA-256");
    }
    mbedtls_md_free(&context);

    static constexpr char kHex[] = "0123456789abcdef";
    std::string result;
    result.reserve(digest.size() * 2);
    for (const unsigned char byte : digest) {
        result.push_back(kHex[(byte >> 4) & 0x0f]);
        result.push_back(kHex[byte & 0x0f]);
    }
    return result;
}

std::string makeTransactionId(std::int64_t timestampUnixMs) {
    static std::atomic<std::uint64_t> sequence{0};
    std::ostringstream value;
    value << "turn-" << std::hex << timestampUnixMs << '-'
          << sequence.fetch_add(1, std::memory_order_relaxed);
    return value.str();
}

std::string turnRegistryUrl(std::int64_t timestampUnixMs) {
    return std::string(kTurnRegistryBaseUrl) + "?ts=" +
        std::to_string(timestampUnixMs - kTurnListEpochOffsetMs);
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

bool isLowercaseSha256(std::string_view value) {
    if (value.size() != 64) {
        return false;
    }
    return std::all_of(value.begin(), value.end(), [](unsigned char ch) {
        return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
    });
}

bool containsUnicodeControl(std::string_view value) {
    for (std::size_t index = 0; index < value.size(); ++index) {
        const auto byte = static_cast<unsigned char>(value[index]);
        if (byte <= 0x1f || byte == 0x7f) {
            return true;
        }
        if (byte == 0xc2 && index + 1 < value.size()) {
            const auto next = static_cast<unsigned char>(value[index + 1]);
            if (next >= 0x80 && next <= 0x9f) {
                return true;
            }
        }
    }
    return false;
}

bool containsUnicodeWhitespace(std::string_view value) {
    for (std::size_t index = 0; index < value.size(); ++index) {
        const auto byte = static_cast<unsigned char>(value[index]);
        if (std::isspace(byte) != 0) {
            return true;
        }
        if (index + 1 < value.size()) {
            const auto next = static_cast<unsigned char>(value[index + 1]);
            if (byte == 0xc2 && (next == 0x85 || next == 0xa0)) {
                return true;
            }
        }
        if (index + 2 < value.size()) {
            const auto second = static_cast<unsigned char>(value[index + 1]);
            const auto third = static_cast<unsigned char>(value[index + 2]);
            if ((byte == 0xe1 && second == 0x9a && third == 0x80) ||
                (byte == 0xe2 && second == 0x80 &&
                 ((third >= 0x80 && third <= 0x8a) || third == 0xa8 ||
                  third == 0xa9 || third == 0xaf)) ||
                (byte == 0xe2 && second == 0x81 && third == 0x9f) ||
                (byte == 0xe3 && second == 0x80 && third == 0x80) ||
                (byte == 0xef && second == 0xbb && third == 0xbf)) {
                return true;
            }
        }
    }
    return false;
}

bool isValidTurnUrl(const std::string &url) {
    if (!isTurnUrl(url) || containsUnicodeControl(url) || containsUnicodeWhitespace(url)) {
        return false;
    }
    const std::size_t colon = url.find(':');
    return colon != std::string::npos && colon + 1 < url.size();
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

struct ValidatedTurnRegistry {
    std::vector<IceServerConfig> servers;
    std::size_t sourceServerCount = 0;
    std::size_t sourceUrlCount = 0;
    std::string canonicalConfigSha256;
    std::string consumedConfigSha256;
};

std::string consumedTurnConfigFingerprint(
    const std::vector<IceServerConfig> &servers) {
    ordered_json canonical = ordered_json::array();
    for (const auto &server : servers) {
        if (!isTurnUrl(server.url)) {
            continue;
        }
        ordered_json entry = ordered_json::object();
        entry["url"] = server.url;
        entry["username"] = server.username;
        entry["credential"] = server.credential;
        entry["udp"] = server.udp;
        canonical.push_back(std::move(entry));
    }
    return sha256Hex(
        "game-capture-consumed-turn-config-v1\n" + canonical.dump());
}

std::optional<ValidatedTurnRegistry> validateTurnRegistry(const json &root) {
    if (!root.is_object() ||
        !root.contains("version") ||
        !root["version"].is_number_integer() ||
        root["version"].get<int>() != 1 ||
        !root.contains("servers") ||
        !root["servers"].is_array() ||
        root["servers"].empty()) {
        return std::nullopt;
    }

    ValidatedTurnRegistry validated;
    ordered_json canonical = ordered_json::array();
    for (const auto &server : root["servers"]) {
        if (!server.is_object() ||
            !server.contains("username") || !server["username"].is_string() ||
            !server.contains("credential") || !server["credential"].is_string() ||
            !server.contains("udp") || !server["udp"].is_boolean() ||
            !server.contains("urls")) {
            return std::nullopt;
        }

        const std::string username = server["username"].get<std::string>();
        const std::string credential = server["credential"].get<std::string>();
        const bool udp = server["udp"].get<bool>();
        if (username.empty() || credential.empty() ||
            containsUnicodeControl(username) || containsUnicodeControl(credential)) {
            return std::nullopt;
        }

        const bool scalarUrls = server["urls"].is_string();
        std::vector<std::string> urls;
        if (scalarUrls) {
            urls.push_back(server["urls"].get<std::string>());
        } else if (server["urls"].is_array() && !server["urls"].empty()) {
            for (const auto &urlValue : server["urls"]) {
                if (!urlValue.is_string()) {
                    return std::nullopt;
                }
                urls.push_back(urlValue.get<std::string>());
            }
        } else {
            return std::nullopt;
        }

        ordered_json canonicalEntry = ordered_json::object();
        if (scalarUrls) {
            canonicalEntry["urls"] = urls.front();
        } else {
            ordered_json canonicalUrls = ordered_json::array();
            for (const auto &url : urls) {
                canonicalUrls.push_back(url);
            }
            canonicalEntry["urls"] = std::move(canonicalUrls);
        }
        canonicalEntry["username"] = username;
        canonicalEntry["credential"] = credential;
        canonicalEntry["udp"] = udp;

        for (const auto &url : urls) {
            if (!isValidTurnUrl(url)) {
                return std::nullopt;
            }
            validated.servers.push_back({url, username, credential, udp});
        }
        validated.sourceUrlCount += urls.size();
        ++validated.sourceServerCount;
        canonical.push_back(std::move(canonicalEntry));
    }

    const std::string canonicalText =
        "game-capture-turn-registry-config-v1\n" + canonical.dump();
    validated.canonicalConfigSha256 = sha256Hex(canonicalText);
    validated.consumedConfigSha256 =
        consumedTurnConfigFingerprint(validated.servers);
    return validated;
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

TurnRegistryHttpResponse fetchTurnRegistryHttp(const TurnRegistryRequest &request) {
    TurnRegistryHttpResponse response;
    HINTERNET sessionHandle = WinHttpOpen(L"GameCapture/1.0",
                                          WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                          WINHTTP_NO_PROXY_NAME,
                                          WINHTTP_NO_PROXY_BYPASS,
                                          0);
    if (!sessionHandle) {
        spdlog::warn("[ICE] WinHttpOpen failed: {}", GetLastError());
        return response;
    }

    do {
        WinHttpSetTimeouts(
            sessionHandle,
            request.timeoutMs,
            request.timeoutMs,
            request.timeoutMs,
            request.timeoutMs);

        HINTERNET connectHandle = WinHttpConnect(sessionHandle, L"turnservers.vdo.ninja",
                                                 INTERNET_DEFAULT_HTTPS_PORT, 0);
        if (!connectHandle) {
            spdlog::warn("[ICE] WinHttpConnect failed: {}", GetLastError());
            break;
        }

        const std::string path =
            "/?ts=" + std::to_string(request.timestampUnixMs - kTurnListEpochOffsetMs);
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

        response.httpStatus = static_cast<int>(statusCode);

        std::string body;
        bool readSucceeded = true;
        for (;;) {
            DWORD available = 0;
            if (!WinHttpQueryDataAvailable(requestHandle, &available)) {
                spdlog::warn("[ICE] WinHttpQueryDataAvailable failed: {}", GetLastError());
                readSucceeded = false;
                break;
            }
            if (available == 0) {
                break;
            }

            std::string chunk(static_cast<size_t>(available), '\0');
            DWORD bytesRead = 0;
            if (!WinHttpReadData(requestHandle, chunk.data(), available, &bytesRead)) {
                spdlog::warn("[ICE] WinHttpReadData failed: {}", GetLastError());
                readSucceeded = false;
                break;
            }
            if (bytesRead == 0) {
                break;
            }
            chunk.resize(static_cast<size_t>(bytesRead));
            body.append(chunk);
        }

        if (readSucceeded) {
            response.transportSucceeded = true;
            response.body = std::move(body);
        }

        WinHttpCloseHandle(requestHandle);
        WinHttpCloseHandle(connectHandle);
    } while (false);

    WinHttpCloseHandle(sessionHandle);
    return response;
}
#else
TurnRegistryHttpResponse fetchTurnRegistryHttp(const TurnRegistryRequest & /*request*/) {
    return {};
}
#endif

std::string outcomeName(TurnRegistryOutcome outcome) {
    switch (outcome) {
        case TurnRegistryOutcome::NotRequired:
            return "not-required";
        case TurnRegistryOutcome::Success:
            return "success";
        case TurnRegistryOutcome::TransportFailure:
            return "transport-failure";
        case TurnRegistryOutcome::HttpStatusFailure:
            return "http-status-failure";
        case TurnRegistryOutcome::EmptyBody:
            return "empty-body";
        case TurnRegistryOutcome::InvalidJson:
            return "invalid-json";
        case TurnRegistryOutcome::InvalidSchema:
            return "invalid-schema";
    }
    return "invalid-schema";
}

std::string turnRegistryDiagnostic(
    IceMode mode,
    const ResolvedIceConfig &resolved) {
    const auto &turn = resolved.turn;
    std::ostringstream summary;
    summary << "[ICE] TurnRegistryFetch"
            << " mode=" << iceModeName(mode)
            << " turnRegistrySourceUrl="
            << (turn.sourceUrl.empty() ? "none" : turn.sourceUrl)
            << " turnRegistryTransactionId="
            << (turn.transactionId.empty() ? "none" : turn.transactionId)
            << " turnRegistryRequestTimestampUnixMs=" << turn.requestTimestampUnixMs
            << " turnRegistryTimeoutMs=" << turn.timeoutMs
            << " turnRegistryFetchAttempted=" << (turn.fetchAttempted ? "true" : "false")
            << " turnRegistryFetchSucceeded=" << (turn.fetchSucceeded ? "true" : "false")
            << " turnRegistryConfigAccepted=" << (turn.configAccepted ? "true" : "false")
            << " turnRegistryOutcome=" << outcomeName(turn.outcome)
            << " turnRegistryHttpStatus=" << turn.httpStatus
            << " turnRegistryResponseVersion=" << turn.responseVersion
            << " turnConfigV1Count=" << turn.responseServerCount
            << " turnUrlCount=" << turn.responseUrlCount
            << " turnRegistryResponseSha256="
            << (turn.rawResponseSha256.empty() ? "none" : turn.rawResponseSha256)
            << " turnConfigV1Sha256="
            << (turn.canonicalConfigSha256.empty() ? "none" : turn.canonicalConfigSha256)
            << " consumedConfigSha256="
            << (turn.consumedConfigSha256.empty() ? "none" : turn.consumedConfigSha256)
            << " turnUrls=";
    bool first = true;
    for (const auto &server : resolved.servers) {
        if (!isTurnUrl(server.url)) {
            continue;
        }
        if (!first) {
            summary << ',';
        }
        first = false;
        summary << server.url;
    }
    if (first) {
        summary << "none";
    }
    return summary.str();
}

}  // namespace

bool ResolvedIceConfig::hasTurnServers() const {
    return std::any_of(servers.begin(), servers.end(), [](const IceServerConfig &server) {
        return isTurnUrl(server.url);
    });
}

std::string consumedTurnConfigSha256(
    const std::vector<IceServerConfig> &servers) {
    return consumedTurnConfigFingerprint(servers);
}

IceConfigBindingValidation validateIceConfigBinding(
    IceMode mode,
    const std::vector<IceServerConfig> &servers,
    const TurnRegistryProvenance &turnRegistry) {
    IceConfigBindingValidation validation;
    validation.iceServerCount = servers.size();
    for (const auto &server : servers) {
        if (isTurnUrl(server.url)) {
            ++validation.turnServerCount;
        }
    }

    const auto reject = [&validation](std::string reason) {
        validation.accepted = false;
        validation.failureReason = std::move(reason);
        return validation;
    };

    const bool turnMode = mode == IceMode::All || mode == IceMode::Relay;
    if (!turnMode) {
        if (mode == IceMode::HostOnly && !servers.empty()) {
            return reject("host-only-has-ice-servers");
        }
        if (validation.turnServerCount != 0) {
            return reject("turn-servers-not-permitted-for-mode");
        }
        const bool provenanceIsEmpty =
            !turnRegistry.fetchAttempted &&
            !turnRegistry.fetchSucceeded &&
            !turnRegistry.configAccepted &&
            turnRegistry.outcome == TurnRegistryOutcome::NotRequired &&
            turnRegistry.sourceUrl.empty() &&
            turnRegistry.transactionId.empty() &&
            turnRegistry.requestTimestampUnixMs == 0 &&
            turnRegistry.timeoutMs == 0 &&
            turnRegistry.httpStatus == 0 &&
            turnRegistry.responseVersion == 0 &&
            turnRegistry.responseServerCount == 0 &&
            turnRegistry.responseUrlCount == 0 &&
            turnRegistry.rawResponseSha256.empty() &&
            turnRegistry.canonicalConfigSha256.empty() &&
            turnRegistry.consumedConfigSha256.empty();
        if (!provenanceIsEmpty) {
            return reject("turn-registry-not-required");
        }
        validation.accepted = true;
        return validation;
    }

    const bool registryFailureStateIsConsistent =
        (turnRegistry.outcome == TurnRegistryOutcome::TransportFailure &&
         !turnRegistry.fetchSucceeded) ||
        (turnRegistry.outcome == TurnRegistryOutcome::HttpStatusFailure &&
         !turnRegistry.fetchSucceeded && turnRegistry.httpStatus != 200) ||
        (turnRegistry.outcome == TurnRegistryOutcome::EmptyBody &&
         turnRegistry.fetchSucceeded && turnRegistry.httpStatus == 200 &&
         turnRegistry.rawResponseSha256.empty()) ||
        ((turnRegistry.outcome == TurnRegistryOutcome::InvalidJson ||
          turnRegistry.outcome == TurnRegistryOutcome::InvalidSchema) &&
         turnRegistry.fetchSucceeded && turnRegistry.httpStatus == 200 &&
         isLowercaseSha256(turnRegistry.rawResponseSha256));
    const bool registryRecordedFailure =
        turnRegistry.fetchAttempted &&
        !turnRegistry.configAccepted &&
        registryFailureStateIsConsistent &&
        turnRegistry.requestTimestampUnixMs > 0 &&
        turnRegistry.sourceUrl == turnRegistryUrl(turnRegistry.requestTimestampUnixMs) &&
        !turnRegistry.transactionId.empty() &&
        turnRegistry.transactionId.starts_with("turn-") &&
        turnRegistry.timeoutMs > 0 &&
        turnRegistry.responseServerCount == 0 &&
        turnRegistry.responseUrlCount == 0 &&
        turnRegistry.canonicalConfigSha256.empty() &&
        turnRegistry.consumedConfigSha256.empty();
    if (validation.turnServerCount == 0 &&
        mode == IceMode::All &&
        registryRecordedFailure) {
        // "All" is the automatic mode: retain its STUN/host path when the optional
        // registry lookup fails. Relay-only remains fail-closed below.
        validation.accepted = true;
        return validation;
    }
    if (validation.turnServerCount == 0) {
        return reject("turn-registry-no-turn-servers");
    }
    if (!turnRegistry.fetchAttempted ||
        !turnRegistry.fetchSucceeded ||
        !turnRegistry.configAccepted ||
        turnRegistry.outcome != TurnRegistryOutcome::Success) {
        return reject("turn-registry-not-accepted");
    }
    if (turnRegistry.requestTimestampUnixMs <= 0 ||
        turnRegistry.sourceUrl != turnRegistryUrl(turnRegistry.requestTimestampUnixMs)) {
        return reject("turn-registry-source-mismatch");
    }
    if (turnRegistry.transactionId.empty() ||
        !turnRegistry.transactionId.starts_with("turn-") ||
        turnRegistry.timeoutMs <= 0 ||
        turnRegistry.httpStatus != 200 ||
        turnRegistry.responseVersion != 1) {
        return reject("turn-registry-request-metadata");
    }
    if (turnRegistry.responseServerCount == 0 ||
        turnRegistry.responseServerCount > turnRegistry.responseUrlCount) {
        return reject("turn-registry-count-metadata");
    }
    if (turnRegistry.responseUrlCount != validation.turnServerCount) {
        return reject("turn-registry-url-count-mismatch");
    }
    if (!isLowercaseSha256(turnRegistry.rawResponseSha256) ||
        !isLowercaseSha256(turnRegistry.canonicalConfigSha256) ||
        !isLowercaseSha256(turnRegistry.consumedConfigSha256)) {
        return reject("turn-registry-hash-format");
    }
    for (const auto &server : servers) {
        if (!isTurnUrl(server.url)) {
            continue;
        }
        if (!isValidTurnUrl(server.url)) {
            return reject("turn-registry-invalid-turn-url");
        }
        if (server.username.empty() || server.credential.empty()) {
            return reject("turn-registry-missing-credentials");
        }
    }
    try {
        validation.consumedConfigSha256 = consumedTurnConfigFingerprint(servers);
    } catch (...) {
        return reject("turn-registry-consumed-hash-error");
    }
    if (validation.consumedConfigSha256 != turnRegistry.consumedConfigSha256) {
        return reject("turn-registry-consumed-hash-mismatch");
    }

    validation.accepted = true;
    return validation;
}

std::string consumedIceConfigDiagnostic(
    IceMode mode,
    const IceConfigBindingValidation &binding,
    const TurnRegistryProvenance &turnRegistry) {
    std::ostringstream summary;
    summary << "[WebRTC] ConsumedIceConfig"
            << " mode=" << iceModeName(mode)
            << " iceServerCount=" << binding.iceServerCount
            << " turnUrlCount=" << binding.turnServerCount
            << " turnConfigV1Count=" << turnRegistry.responseServerCount
            << " turnRegistrySourceUrl="
            << (turnRegistry.sourceUrl.empty() ? "none" : turnRegistry.sourceUrl)
            << " turnRegistryTransactionId="
            << (turnRegistry.transactionId.empty() ? "none" : turnRegistry.transactionId)
            << " turnRegistryResponseSha256="
            << (turnRegistry.rawResponseSha256.empty()
                    ? "none"
                    : turnRegistry.rawResponseSha256)
            << " turnConfigV1Sha256="
            << (turnRegistry.canonicalConfigSha256.empty()
                    ? "none"
                    : turnRegistry.canonicalConfigSha256)
            << " consumedConfigSha256="
            << (binding.consumedConfigSha256.empty()
                    ? "none"
                    : binding.consumedConfigSha256);
    return summary.str();
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

ResolvedIceConfig resolveIceConfigWithDependencies(
    IceMode mode,
    int fetchTimeoutMs,
    const IceConfigDependencies &dependencies) {
    if (!dependencies.fetchTurnRegistry || !dependencies.emitDiagnostic) {
        throw std::invalid_argument("TURN registry dependencies must be provided");
    }

    ResolvedIceConfig resolved;
    if (mode != IceMode::HostOnly) {
        resolved.servers = defaultStunServers();
    }

    if (mode == IceMode::HostOnly || mode == IceMode::StunOnly) {
        resolved.turn.outcome = TurnRegistryOutcome::NotRequired;
        dependencies.emitDiagnostic(turnRegistryDiagnostic(mode, resolved));
        return resolved;
    }

    auto &turn = resolved.turn;
    turn.fetchAttempted = true;
    turn.timeoutMs = fetchTimeoutMs;
    turn.requestTimestampUnixMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count();
    turn.sourceUrl = turnRegistryUrl(turn.requestTimestampUnixMs);
    turn.transactionId = makeTransactionId(turn.requestTimestampUnixMs);

    TurnRegistryHttpResponse response;
    try {
        response = dependencies.fetchTurnRegistry({
            turn.sourceUrl,
            turn.transactionId,
            turn.requestTimestampUnixMs,
            turn.timeoutMs,
        });
    } catch (...) {
        response = {};
    }
    turn.httpStatus = response.httpStatus;

    if (!response.transportSucceeded) {
        turn.outcome = TurnRegistryOutcome::TransportFailure;
    } else if (response.httpStatus != 200) {
        turn.outcome = TurnRegistryOutcome::HttpStatusFailure;
    } else {
        turn.fetchSucceeded = true;
        const auto firstContent = response.body.find_first_not_of(" \t\r\n");
        if (firstContent == std::string::npos) {
            turn.outcome = TurnRegistryOutcome::EmptyBody;
        } else {
            turn.rawResponseSha256 = sha256Hex(response.body);
            const json root = json::parse(response.body, nullptr, false);
            if (root.is_discarded()) {
                turn.outcome = TurnRegistryOutcome::InvalidJson;
            } else {
                if (root.is_object() && root.contains("version") &&
                    root["version"].is_number_integer()) {
                    turn.responseVersion = root["version"].get<int>();
                }
                const auto validated = validateTurnRegistry(root);
                if (!validated.has_value()) {
                    turn.outcome = TurnRegistryOutcome::InvalidSchema;
                } else {
                    turn.outcome = TurnRegistryOutcome::Success;
                    turn.configAccepted = true;
                    turn.responseServerCount = validated->sourceServerCount;
                    turn.responseUrlCount = validated->sourceUrlCount;
                    turn.canonicalConfigSha256 = validated->canonicalConfigSha256;
                    turn.consumedConfigSha256 = validated->consumedConfigSha256;
                    resolved.servers.insert(
                        resolved.servers.end(),
                        validated->servers.begin(),
                        validated->servers.end());
                    resolved.fetchedTurnList = true;
                }
            }
        }
    }

    dependencies.emitDiagnostic(turnRegistryDiagnostic(mode, resolved));
    return resolved;
}

ResolvedIceConfig resolveIceConfig(IceMode mode, int fetchTimeoutMs) {
    IceConfigDependencies dependencies;
    dependencies.fetchTurnRegistry = [](const TurnRegistryRequest &request) {
        return fetchTurnRegistryHttp(request);
    };
    dependencies.emitDiagnostic = [](std::string_view diagnostic) {
        spdlog::info("{}", diagnostic);
    };
    return resolveIceConfigWithDependencies(mode, fetchTimeoutMs, dependencies);
}

bool candidateLooksRelay(const std::string &candidate) {
    return toLowerCopy(candidate).find(" typ relay") != std::string::npos;
}

bool candidateLooksServerReflexive(const std::string &candidate) {
    return toLowerCopy(candidate).find(" typ srflx") != std::string::npos;
}

bool candidateLooksHost(const std::string &candidate) {
    return toLowerCopy(candidate).find(" typ host") != std::string::npos;
}

bool candidateAllowedForMode(const std::string &candidate, IceMode mode) {
    switch (mode) {
        case IceMode::All:
            return true;
        case IceMode::HostOnly:
            return candidateLooksHost(candidate);
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
