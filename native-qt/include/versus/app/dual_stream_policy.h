#pragma once

#include <string>

namespace versus::app {

enum class PeerRole {
    Unknown,
    Scene,
    Director,
    Guest,
    Viewer
};

enum class StreamTier {
    None,
    HQ,
    LQ
};

struct PeerRouteState {
    bool roomMode = false;
    bool initReceived = false;
    bool roleValid = false;
    PeerRole role = PeerRole::Unknown;
    bool videoEnabled = true;
    bool audioEnabled = true;
};

PeerRole parsePeerRole(const std::string &value);
const char *peerRoleName(PeerRole role);
StreamTier assignStreamTier(bool roomMode, bool roleValid, PeerRole role);
const char *streamTierName(StreamTier tier);
bool canSendVideo(const PeerRouteState &state);
bool canSendAudio(const PeerRouteState &state);

}  // namespace versus::app
