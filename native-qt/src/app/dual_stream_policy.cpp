#include "versus/app/dual_stream_policy.h"

#include <algorithm>
#include <cctype>

namespace versus::app {
namespace {

std::string normalize(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

}  // namespace

PeerRole parsePeerRole(const std::string &value) {
    const std::string normalized = normalize(value);
    if (normalized == "scene") {
        return PeerRole::Scene;
    }
    if (normalized == "director") {
        return PeerRole::Director;
    }
    if (normalized == "guest") {
        return PeerRole::Guest;
    }
    if (normalized == "viewer") {
        return PeerRole::Viewer;
    }
    return PeerRole::Unknown;
}

const char *peerRoleName(PeerRole role) {
    switch (role) {
        case PeerRole::Scene:
            return "scene";
        case PeerRole::Director:
            return "director";
        case PeerRole::Guest:
            return "guest";
        case PeerRole::Viewer:
            return "viewer";
        case PeerRole::Unknown:
        default:
            return "unknown";
    }
}

RoomQualityDecision resolveRoomQualityDecision(bool roomMode,
                                               bool requested,
                                               bool selectedCodecIsH264) {
    if (!roomMode) {
        return {requested, false, RoomQualityReason::NotInRoom};
    }
    if (!requested) {
        return {false, false, RoomQualityReason::NotRequested};
    }
    if (!selectedCodecIsH264) {
        return {true, false, RoomQualityReason::CodecNotH264};
    }
    return {true, true, RoomQualityReason::Enabled};
}

const char *roomQualityReasonName(RoomQualityReason reason) {
    switch (reason) {
        case RoomQualityReason::Enabled:
            return "enabled";
        case RoomQualityReason::NotInRoom:
            return "not-in-room";
        case RoomQualityReason::NotRequested:
            return "not-requested";
        case RoomQualityReason::CodecNotH264:
            return "codec-not-h264";
        default:
            return "not-requested";
    }
}

StreamTier assignStreamTier(bool roomMode,
                            bool roomQualityEffective,
                            bool roleValid,
                            PeerRole role) {
    if (!roomMode) {
        return StreamTier::HQ;
    }
    if (!roleValid) {
        return StreamTier::None;
    }
    if (role == PeerRole::Scene) {
        return StreamTier::HQ;
    }
    if (!roomQualityEffective) {
        return StreamTier::HQ;
    }
    return StreamTier::LQ;
}

StreamTier selectEffectiveStreamTier(StreamTier policyTier, bool forceHq) {
    if (policyTier == StreamTier::None) {
        return StreamTier::None;
    }
    if (forceHq) {
        return StreamTier::HQ;
    }
    return policyTier;
}

const char *streamTierName(StreamTier tier) {
    switch (tier) {
        case StreamTier::HQ:
            return "hq";
        case StreamTier::LQ:
            return "lq";
        case StreamTier::None:
        default:
            return "none";
    }
}

bool canSendVideo(const PeerRouteState &state) {
    if (!state.videoEnabled) {
        return false;
    }
    if (state.roomMode && !state.initReceived) {
        return false;
    }
    return assignStreamTier(state.roomMode, state.roomQualityEffective, state.roleValid, state.role) != StreamTier::None;
}

bool canSendAudio(const PeerRouteState &state) {
    if (!state.audioEnabled) {
        return false;
    }
    if (state.roomMode && !state.initReceived) {
        return false;
    }
    return assignStreamTier(state.roomMode, state.roomQualityEffective, state.roleValid, state.role) != StreamTier::None;
}

}  // namespace versus::app
