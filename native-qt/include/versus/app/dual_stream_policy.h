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

enum class RoomQualityReason {
    Enabled,
    NotInRoom,
    NotRequested,
    CodecNotH264
};

struct RoomQualityDecision {
    bool requested = false;
    bool effective = false;
    RoomQualityReason reason = RoomQualityReason::NotRequested;

    bool operator==(const RoomQualityDecision &) const = default;
};

struct PeerRouteState {
    bool roomMode = false;
    bool roomQualityEffective = false;
    bool initReceived = false;
    bool roleValid = false;
    PeerRole role = PeerRole::Unknown;
    bool videoEnabled = true;
    bool audioEnabled = true;
};

PeerRole parsePeerRole(const std::string &value);
const char *peerRoleName(PeerRole role);
RoomQualityDecision resolveRoomQualityDecision(bool roomMode,
                                               bool requested,
                                               bool selectedCodecIsH264);
const char *roomQualityReasonName(RoomQualityReason reason);
StreamTier assignStreamTier(bool roomMode,
                            bool roomQualityEffective,
                            bool roleValid,
                            PeerRole role);
StreamTier selectEffectiveStreamTier(StreamTier policyTier, bool forceHq);
const char *streamTierName(StreamTier tier);
bool canSendVideo(const PeerRouteState &state);
bool canSendAudio(const PeerRouteState &state);

}  // namespace versus::app
