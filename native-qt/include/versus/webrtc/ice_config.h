#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace versus::webrtc {

enum class IceMode {
    All,
    HostOnly,
    Relay,
    StunOnly
};

struct IceServerConfig {
    std::string url;
    std::string username;
    std::string credential;
    bool udp = true;
};

enum class TurnRegistryOutcome {
    NotRequired,
    Success,
    TransportFailure,
    HttpStatusFailure,
    EmptyBody,
    InvalidJson,
    InvalidSchema
};

struct TurnRegistryRequest {
    std::string url;
    std::string transactionId;
    std::int64_t timestampUnixMs = 0;
    int timeoutMs = 0;
};

struct TurnRegistryHttpResponse {
    bool transportSucceeded = false;
    int httpStatus = 0;
    std::string body;
};

struct TurnRegistryProvenance {
    bool fetchAttempted = false;
    bool fetchSucceeded = false;
    bool configAccepted = false;
    TurnRegistryOutcome outcome = TurnRegistryOutcome::NotRequired;
    std::string sourceUrl;
    std::string transactionId;
    std::int64_t requestTimestampUnixMs = 0;
    int timeoutMs = 0;
    int httpStatus = 0;
    int responseVersion = 0;
    std::size_t responseServerCount = 0;
    std::size_t responseUrlCount = 0;
    std::string rawResponseSha256;
    std::string canonicalConfigSha256;
    std::string consumedConfigSha256;
};

struct IceConfigDependencies {
    std::function<TurnRegistryHttpResponse(const TurnRegistryRequest &)> fetchTurnRegistry;
    std::function<void(std::string_view)> emitDiagnostic;
};

struct ResolvedIceConfig {
    std::vector<IceServerConfig> servers;
    bool fetchedTurnList = false;
    bool usedFallbackTurnList = false;
    TurnRegistryProvenance turn;

    [[nodiscard]] bool hasTurnServers() const;
};

struct IceConfigBindingValidation {
    bool accepted = false;
    std::size_t iceServerCount = 0;
    std::size_t turnServerCount = 0;
    std::string consumedConfigSha256;
    std::string failureReason;
};

std::string iceModeName(IceMode mode);
ResolvedIceConfig resolveIceConfig(IceMode mode, int fetchTimeoutMs = 2000);
ResolvedIceConfig resolveIceConfigWithDependencies(
    IceMode mode,
    int fetchTimeoutMs,
    const IceConfigDependencies &dependencies);
std::string consumedTurnConfigSha256(const std::vector<IceServerConfig> &servers);
IceConfigBindingValidation validateIceConfigBinding(
    IceMode mode,
    const std::vector<IceServerConfig> &servers,
    const TurnRegistryProvenance &turnRegistry);
std::string consumedIceConfigDiagnostic(
    IceMode mode,
    const IceConfigBindingValidation &binding,
    const TurnRegistryProvenance &turnRegistry);
bool candidateLooksRelay(const std::string &candidate);
bool candidateLooksServerReflexive(const std::string &candidate);
bool candidateAllowedForMode(const std::string &candidate, IceMode mode);
std::string filterSessionDescriptionForMode(const std::string &sdp, IceMode mode);

}  // namespace versus::webrtc
