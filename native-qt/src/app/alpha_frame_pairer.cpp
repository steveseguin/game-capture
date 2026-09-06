#include "versus/app/alpha_frame_pairer.h"

#include <algorithm>
#include <iterator>
#include <utility>

namespace versus::app {

namespace {

// WebRtcClient converts 100-ns PTS to 90 kHz with (pts * 9) / 1000.
// Advancing by 112 guarantees a distinct RTP timestamp after that integer
// conversion; +1 alone can collapse two completed pairs onto the same tick.
constexpr int64_t kMinimumTransportStep100ns = 112;

}  // namespace

AlphaFrameAdmissionTracker::AlphaFrameAdmissionTracker(std::size_t maxPendingFrames)
    : maxPendingFrames_(std::max<std::size_t>(1, maxPendingFrames)) {}

AlphaFrameAdmission AlphaFrameAdmissionTracker::admit(int64_t captureTimestamp,
                                                       uint64_t pipelineGeneration) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (captureTimestamp == std::numeric_limits<int64_t>::min() ||
        pipelineGeneration == 0 ||
        nextSequence_ == std::numeric_limits<uint64_t>::max()) {
        ++droppedAdmissionCount_;
        return {};
    }

    int64_t correlationTimestamp = captureTimestamp;
    if (latestAdmission_.valid() &&
        correlationTimestamp <= latestAdmission_.sourceTimestamp) {
        if (latestAdmission_.sourceTimestamp == std::numeric_limits<int64_t>::max()) {
            ++droppedAdmissionCount_;
            return {};
        }
        correlationTimestamp = latestAdmission_.sourceTimestamp + 1;
    }
    AlphaFrameAdmission admission;
    admission.sourceTimestamp = correlationTimestamp;
    admission.pipelineGeneration = pipelineGeneration;
    admission.sequence = ++nextSequence_;
    entries_.push_back({admission, false, false});
    latestAdmission_ = admission;
    while (entries_.size() > maxPendingFrames_) {
        entries_.pop_front();
        ++droppedAdmissionCount_;
    }
    return admission;
}

std::optional<AlphaFrameAdmission> AlphaFrameAdmissionTracker::resolvePrimary(
    int64_t sourceTimestamp) {
    return resolve(sourceTimestamp, true);
}

std::optional<AlphaFrameAdmission> AlphaFrameAdmissionTracker::resolveAlpha(
    int64_t sourceTimestamp) {
    return resolve(sourceTimestamp, false);
}

void AlphaFrameAdmissionTracker::clearPending() {
    std::lock_guard<std::mutex> lock(mutex_);
    droppedAdmissionCount_ += entries_.size();
    entries_.clear();
}

AlphaFrameAdmission AlphaFrameAdmissionTracker::latestAdmission() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return latestAdmission_;
}

std::size_t AlphaFrameAdmissionTracker::pendingCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return entries_.size();
}

uint64_t AlphaFrameAdmissionTracker::droppedAdmissionCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return droppedAdmissionCount_;
}

std::optional<AlphaFrameAdmission> AlphaFrameAdmissionTracker::resolve(
    int64_t sourceTimestamp,
    bool primary) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto entry = std::find_if(
        entries_.begin(),
        entries_.end(),
        [sourceTimestamp, primary](const Entry &candidate) {
            return candidate.admission.sourceTimestamp == sourceTimestamp &&
                (primary ? !candidate.primaryResolved : !candidate.alphaResolved);
        });
    if (entry == entries_.end()) {
        ++droppedAdmissionCount_;
        return std::nullopt;
    }
    const AlphaFrameAdmission admission = entry->admission;
    if (primary) {
        entry->primaryResolved = true;
    } else {
        entry->alphaResolved = true;
    }
    if (entry->primaryResolved && entry->alphaResolved) {
        entries_.erase(entry);
    }
    return admission;
}

bool isExactAlphaFramePair(const ExactAlphaFramePair &pair) {
    return !pair.primary.packet.data.empty() &&
        !pair.alpha.packet.data.empty() &&
        pair.primary.pipelineGeneration != 0 &&
        pair.primary.pipelineGeneration == pair.alpha.pipelineGeneration &&
        pair.primary.sourceAdmissionSequence != 0 &&
        pair.primary.sourceAdmissionSequence == pair.alpha.sourceAdmissionSequence &&
        pair.primary.packet.sourceTimestamp != std::numeric_limits<int64_t>::min() &&
        pair.primary.packet.sourceTimestamp == pair.alpha.packet.sourceTimestamp &&
        pair.transportPts != std::numeric_limits<int64_t>::min() &&
        pair.primary.encodedWidth > 0 &&
        pair.primary.encodedHeight > 0 &&
        pair.alpha.encodedWidth > 0 &&
        pair.alpha.encodedHeight > 0;
}

bool preservesAlphaPrimaryPredictionChain(const ExactAlphaFramePair &pair, uint64_t lastEncodedSequence) {
    if (pair.primary.packet.codec != versus::video::VideoCodec::H264 || pair.primary.packet.isKeyframe) return true;
    return lastEncodedSequence != 0 && lastEncodedSequence != std::numeric_limits<uint64_t>::max() &&
        pair.primary.encodedSequence == lastEncodedSequence + 1;
}

bool canStartAlphaTransportWithPair(const ExactAlphaFramePair &pair) {
    return isExactAlphaFramePair(pair) &&
        pair.primary.packet.isKeyframe &&
        pair.alpha.packet.isKeyframe;
}

const char *protectedAlphaContractRejectionName(
    ProtectedAlphaContractRejection rejection) {
    switch (rejection) {
        case ProtectedAlphaContractRejection::None:
            return "none";
        case ProtectedAlphaContractRejection::PairIdentityInvalid:
            return "pair-identity-invalid";
        case ProtectedAlphaContractRejection::AlphaCodecNotVp9:
            return "alpha-codec-not-vp9";
        case ProtectedAlphaContractRejection::AlphaNotKeyframe:
            return "alpha-not-keyframe";
        case ProtectedAlphaContractRejection::PrimaryCodecUnsupported:
            return "primary-codec-unsupported";
        case ProtectedAlphaContractRejection::PrimaryVp9NotKeyframe:
            return "primary-vp9-not-keyframe";
        default:
            return "unknown";
    }
}

ProtectedAlphaContractValidation validateProtectedAlphaKeyframeContract(
    const ExactAlphaFramePair &pair) {
    if (!isExactAlphaFramePair(pair)) {
        return {ProtectedAlphaContractRejection::PairIdentityInvalid};
    }
    if (pair.alpha.packet.codec != versus::video::VideoCodec::VP9) {
        return {ProtectedAlphaContractRejection::AlphaCodecNotVp9};
    }
    if (!pair.alpha.packet.isKeyframe) {
        return {ProtectedAlphaContractRejection::AlphaNotKeyframe};
    }
    if (pair.primary.packet.codec != versus::video::VideoCodec::VP9 &&
        pair.primary.packet.codec != versus::video::VideoCodec::H264) {
        return {ProtectedAlphaContractRejection::PrimaryCodecUnsupported};
    }
    if (pair.primary.packet.codec == versus::video::VideoCodec::VP9 &&
        !pair.primary.packet.isKeyframe) {
        return {ProtectedAlphaContractRejection::PrimaryVp9NotKeyframe};
    }
    return {};
}

bool satisfiesProtectedAlphaKeyframeContract(const ExactAlphaFramePair &pair) {
    return validateProtectedAlphaKeyframeContract(pair).valid();
}

AlphaContractRecoveryController::AlphaContractRecoveryController(
    int64_t recoveryCooldownMs)
    : recoveryCooldownMs_(std::max<int64_t>(1, recoveryCooldownMs)) {}

AlphaContractRecoveryObservation AlphaContractRecoveryController::observe(
    const ExactAlphaFramePair &pair,
    int64_t nowMs) {
    AlphaContractRecoveryObservation observation;
    observation.validation = validateProtectedAlphaKeyframeContract(pair);
    std::lock_guard<std::mutex> lock(mutex_);
    if (observation.validation.valid()) {
        if (recoveryActive_) {
            recoveryActive_ = false;
            observation.recovered = true;
            ++recoverySuccessCount_;
        }
        return observation;
    }

    ++rejectedPairCount_;
    recoveryActive_ = true;
    lastRejection_ = observation.validation.rejection;
    const bool clockMovedBackwards = hasScheduledRecovery_ && nowMs < lastRecoveryMs_;
    if (!hasScheduledRecovery_ || clockMovedBackwards ||
        nowMs - lastRecoveryMs_ >= recoveryCooldownMs_) {
        hasScheduledRecovery_ = true;
        lastRecoveryMs_ = nowMs;
        observation.recoveryScheduled = true;
        ++recoveryAttemptCount_;
    }
    return observation;
}

void AlphaContractRecoveryController::reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    recoveryActive_ = false;
    hasScheduledRecovery_ = false;
    lastRecoveryMs_ = 0;
    rejectedPairCount_ = 0;
    recoveryAttemptCount_ = 0;
    recoverySuccessCount_ = 0;
    lastRejection_ = ProtectedAlphaContractRejection::None;
}

uint64_t AlphaContractRecoveryController::rejectedPairCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return rejectedPairCount_;
}

uint64_t AlphaContractRecoveryController::recoveryAttemptCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return recoveryAttemptCount_;
}

uint64_t AlphaContractRecoveryController::recoverySuccessCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return recoverySuccessCount_;
}

bool AlphaContractRecoveryController::recoveryActive() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return recoveryActive_;
}

ProtectedAlphaContractRejection AlphaContractRecoveryController::lastRejection() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return lastRejection_;
}

bool isAlphaPairNewerThan(const ExactAlphaFramePair &pair,
                          int64_t lastPrimaryTransportPts,
                          uint64_t minimumAdmissionSequenceExclusive) {
    return isExactAlphaFramePair(pair) &&
        nextMonotonicVideoTransportPts(pair.transportPts, lastPrimaryTransportPts) >
            lastPrimaryTransportPts &&
        pair.primary.sourceAdmissionSequence > minimumAdmissionSequenceExclusive;
}

int64_t nextMonotonicVideoTransportPts(int64_t candidateSourcePts,
                                       int64_t lastReservedTransportPts) {
    if (lastReservedTransportPts == std::numeric_limits<int64_t>::min()) {
        return candidateSourcePts;
    }
    if (lastReservedTransportPts >
        std::numeric_limits<int64_t>::max() - kMinimumTransportStep100ns) {
        return std::numeric_limits<int64_t>::max();
    }
    return std::max(
        candidateSourcePts,
        lastReservedTransportPts + kMinimumTransportStep100ns);
}

ExactAlphaFramePairer::ExactAlphaFramePairer(std::size_t maxPendingFrames)
    : maxPendingFrames_(std::max<std::size_t>(1, maxPendingFrames)) {}

std::optional<ExactAlphaFramePair> ExactAlphaFramePairer::submitPrimary(ExactAlphaFramePacket packet) {
    return submit(std::move(packet), true);
}

std::optional<ExactAlphaFramePair> ExactAlphaFramePairer::submitAlpha(ExactAlphaFramePacket packet) {
    return submit(std::move(packet), false);
}

void ExactAlphaFramePairer::clear() {
    std::lock_guard<std::mutex> lock(mutex_);
    droppedHalfCount_ += primaryPackets_.size() + alphaPackets_.size();
    for (const auto &packet : primaryPackets_) {
        retiredAdmissionSequenceWatermark_ = std::max(
            retiredAdmissionSequenceWatermark_,
            packet.sourceAdmissionSequence);
    }
    for (const auto &packet : alphaPackets_) {
        retiredAdmissionSequenceWatermark_ = std::max(
            retiredAdmissionSequenceWatermark_,
            packet.sourceAdmissionSequence);
    }
    for (const auto &identity : completedIdentities_) {
        retiredAdmissionSequenceWatermark_ = std::max(
            retiredAdmissionSequenceWatermark_,
            std::get<1>(identity));
    }
    primaryPackets_.clear();
    alphaPackets_.clear();
    completedIdentities_.clear();
}

std::size_t ExactAlphaFramePairer::pendingPrimaryCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return primaryPackets_.size();
}

std::size_t ExactAlphaFramePairer::pendingAlphaCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return alphaPackets_.size();
}

uint64_t ExactAlphaFramePairer::droppedHalfCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return droppedHalfCount_;
}

std::optional<ExactAlphaFramePair> ExactAlphaFramePairer::submit(ExactAlphaFramePacket packet,
                                                                 bool primary) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid(packet)) {
        ++droppedHalfCount_;
        return std::nullopt;
    }

    if (packet.sourceAdmissionSequence <= retiredAdmissionSequenceWatermark_) {
        ++droppedHalfCount_;
        return std::nullopt;
    }

    const auto identity = std::make_tuple(
        packet.pipelineGeneration,
        packet.sourceAdmissionSequence,
        packet.packet.sourceTimestamp);
    if (std::find(completedIdentities_.begin(), completedIdentities_.end(), identity) !=
        completedIdentities_.end()) {
        ++droppedHalfCount_;
        return std::nullopt;
    }

    auto &ownPackets = primary ? primaryPackets_ : alphaPackets_;
    auto &oppositePackets = primary ? alphaPackets_ : primaryPackets_;
    const auto match = std::find_if(
        oppositePackets.begin(),
        oppositePackets.end(),
        [&packet](const ExactAlphaFramePacket &candidate) {
            return sameIdentity(packet, candidate);
        });
    if (match == oppositePackets.end()) {
        const auto duplicate = std::find_if(
            ownPackets.begin(),
            ownPackets.end(),
            [&packet](const ExactAlphaFramePacket &candidate) {
                return sameIdentity(packet, candidate);
            });
        if (duplicate != ownPackets.end()) {
            *duplicate = std::move(packet);
            ++droppedHalfCount_;
            return std::nullopt;
        }
        ownPackets.push_back(std::move(packet));
        prune(ownPackets);
        return std::nullopt;
    }

    ExactAlphaFramePacket counterpart = std::move(*match);
    oppositePackets.erase(match);
    ExactAlphaFramePair pair;
    if (primary) {
        pair.primary = std::move(packet);
        pair.alpha = std::move(counterpart);
    } else {
        pair.primary = std::move(counterpart);
        pair.alpha = std::move(packet);
    }
    const int64_t sourceTimestamp = pair.primary.packet.sourceTimestamp;
    if (lastTransportPts_ == std::numeric_limits<int64_t>::min()) {
        pair.transportPts = sourceTimestamp;
    } else if (lastTransportPts_ >
               std::numeric_limits<int64_t>::max() - kMinimumTransportStep100ns) {
        // A 100-ns signed clock cannot realistically exhaust during process
        // lifetime. Keep equality rather than overflowing into a backwards PTS.
        pair.transportPts = std::numeric_limits<int64_t>::max();
    } else {
        pair.transportPts = std::max(
            sourceTimestamp,
            lastTransportPts_ + kMinimumTransportStep100ns);
    }
    lastTransportPts_ = pair.transportPts;
    completedIdentities_.push_back(identity);
    trimCompletedIdentities();
    return pair;
}

bool ExactAlphaFramePairer::valid(const ExactAlphaFramePacket &packet) {
    return !packet.packet.data.empty() &&
        packet.packet.sourceTimestamp != std::numeric_limits<int64_t>::min() &&
        packet.pipelineGeneration != 0 &&
        packet.sourceAdmissionSequence != 0 &&
        packet.encodedWidth > 0 &&
        packet.encodedHeight > 0;
}

bool ExactAlphaFramePairer::sameIdentity(const ExactAlphaFramePacket &lhs,
                                         const ExactAlphaFramePacket &rhs) {
    return lhs.pipelineGeneration == rhs.pipelineGeneration &&
        lhs.sourceAdmissionSequence == rhs.sourceAdmissionSequence &&
        lhs.packet.sourceTimestamp == rhs.packet.sourceTimestamp;
}

void ExactAlphaFramePairer::prune(std::deque<ExactAlphaFramePacket> &packets) {
    while (packets.size() > maxPendingFrames_) {
        retiredAdmissionSequenceWatermark_ = std::max(
            retiredAdmissionSequenceWatermark_,
            packets.front().sourceAdmissionSequence);
        packets.pop_front();
        ++droppedHalfCount_;
    }
}

void ExactAlphaFramePairer::trimCompletedIdentities() {
    const std::size_t completedLimit = std::max<std::size_t>(16, maxPendingFrames_ * 4);
    while (completedIdentities_.size() > completedLimit) {
        retiredAdmissionSequenceWatermark_ = std::max(
            retiredAdmissionSequenceWatermark_,
            std::get<1>(completedIdentities_.front()));
        completedIdentities_.pop_front();
    }
}

ExactAlphaDispatchResult dispatchExactAlphaFramePair(
    const ExactAlphaFramePair &pair,
    std::recursive_mutex &transportOperationMutex,
    const ExactAlphaDispatchAdmission &admit,
    const ExactAlphaPacketSender &sendAlpha,
    const ExactAlphaPacketSender &sendPrimary) {
    ExactAlphaDispatchResult result;
    if (!isExactAlphaFramePair(pair) || !admit || !sendAlpha || !sendPrimary) {
        return result;
    }

    std::lock_guard<std::recursive_mutex> transportLock(transportOperationMutex);
    if (!admit()) {
        return result;
    }
    result.admitted = true;
    result.alphaSent = sendAlpha(pair.alpha.packet);
    if (!result.alphaSent) {
        return result;
    }
    result.primarySent = sendPrimary(pair.primary.packet);
    return result;
}

}  // namespace versus::app
