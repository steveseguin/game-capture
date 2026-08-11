#pragma once

namespace versus::app::keyframe_policy {

constexpr bool shouldDispatchEncoderRequest(bool requested,
                                            bool externalEncoder,
                                            bool encoderGuaranteesEveryFrameKeyframe) {
    return requested && !externalEncoder &&
        !encoderGuaranteesEveryFrameKeyframe;
}

constexpr bool shouldRearmAfterPacket(bool requested,
                                      bool packetIsKeyframe,
                                      bool externalEncoder) {
    return requested && !packetIsKeyframe && !externalEncoder;
}

constexpr bool shouldRearmAfterEncodeFailure(bool requested,
                                             bool externalEncoder) {
    return requested && !externalEncoder;
}

}  // namespace versus::app::keyframe_policy
