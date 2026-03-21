#pragma once

#include <string>
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

struct ResolvedIceConfig {
    std::vector<IceServerConfig> servers;
    bool fetchedTurnList = false;
    bool usedFallbackTurnList = false;

    [[nodiscard]] bool hasTurnServers() const;
};

std::string iceModeName(IceMode mode);
ResolvedIceConfig resolveIceConfig(IceMode mode, int fetchTimeoutMs = 2000);
bool candidateLooksRelay(const std::string &candidate);
bool candidateLooksServerReflexive(const std::string &candidate);
bool candidateAllowedForMode(const std::string &candidate, IceMode mode);
std::string filterSessionDescriptionForMode(const std::string &sdp, IceMode mode);

}  // namespace versus::webrtc
