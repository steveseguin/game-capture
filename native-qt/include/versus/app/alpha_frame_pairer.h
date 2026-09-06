#pragma once

#include "versus/video/video_encoder.h"

#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
#include <mutex>
#include <optional>
#include <tuple>
#include <utility>

namespace versus::app {

struct AlphaFrameAdmission {
    int64_t sourceTimestamp = std::numeric_limits<int64_t>::min();
    uint64_t pipelineGeneration = 0;
    uint64_t sequence = 0;

    bool valid() const {
        return sourceTimestamp != std::numeric_limits<int64_t>::min() &&
            pipelineGeneration != 0 && sequence != 0;
    }
};

// Records a frame before either encoder can consume it, assigns a unique
// internal correlation timestamp, then resolves the generation/admission
// token from the identity reported by each encoder. The unique timestamp
// avoids ambiguous pairing when capture timestamps repeat and the two
// encoders complete in different orders.
class AlphaFrameAdmissionTracker {
  public:
    explicit AlphaFrameAdmissionTracker(std::size_t maxPendingFrames = 256);

    AlphaFrameAdmission admit(int64_t captureTimestamp, uint64_t pipelineGeneration);
    std::optional<AlphaFrameAdmission> resolvePrimary(int64_t sourceTimestamp);
    std::optional<AlphaFrameAdmission> resolveAlpha(int64_t sourceTimestamp);
    void clearPending();

    AlphaFrameAdmission latestAdmission() const;
    std::size_t pendingCount() const;
    uint64_t droppedAdmissionCount() const;

  private:
    struct Entry {
        AlphaFrameAdmission admission;
        bool primaryResolved = false;
        bool alphaResolved = false;
    };

    std::optional<AlphaFrameAdmission> resolve(int64_t sourceTimestamp, bool primary);

    const std::size_t maxPendingFrames_;
    mutable std::mutex mutex_;
    std::deque<Entry> entries_;
    AlphaFrameAdmission latestAdmission_;
    uint64_t nextSequence_ = 0;
    uint64_t droppedAdmissionCount_ = 0;
};

// The primary and alpha encoders run independently. A packet is compositable
// only with the packet produced from the same source timestamp in the same
// encoder generation. Encoded dimensions are metadata rather than part of the
// identity: the ninja-plugin receiver deliberately supports a scaled alpha
// track and expands it to the primary dimensions before composition.
struct ExactAlphaFramePacket {
    versus::video::EncodedPacket packet;
    uint64_t pipelineGeneration = 0;
    uint64_t sourceAdmissionSequence = 0;
    int encodedWidth = 0;
    int encodedHeight = 0;
    // Actual primary packet order, independent of skipped encoder inputs.
    uint64_t encodedSequence = 0;
};

struct ExactAlphaFramePair {
    ExactAlphaFramePacket primary;
    ExactAlphaFramePacket alpha;
    // Common 100-ns transport clock value assigned only after the two source
    // identities match. Backend encoder PTS never leaks into cross-track sync.
    int64_t transportPts = std::numeric_limits<int64_t>::min();
};

bool isExactAlphaFramePair(const ExactAlphaFramePair &pair);
enum class ProtectedAlphaContractRejection {
    None,
    PairIdentityInvalid,
    AlphaCodecNotVp9,
    AlphaNotKeyframe,
    PrimaryCodecUnsupported,
    PrimaryVp9NotKeyframe,
};

struct ProtectedAlphaContractValidation {
    ProtectedAlphaContractRejection rejection =
        ProtectedAlphaContractRejection::None;

    bool valid() const {
        return rejection == ProtectedAlphaContractRejection::None;
    }
};

const char *protectedAlphaContractRejectionName(
    ProtectedAlphaContractRejection rejection);
ProtectedAlphaContractValidation validateProtectedAlphaKeyframeContract(
    const ExactAlphaFramePair &pair);
// The VP9 alpha track is independently decodable on every frame. A VP9 color
// track has the same protected contract; H.264 color may use inter frames once
// the transport has started from an exact dual-keyframe pair and every primary
// dependency has been delivered (checked separately by encoded sequence).
bool satisfiesProtectedAlphaKeyframeContract(const ExactAlphaFramePair &pair);
bool canStartAlphaTransportWithPair(const ExactAlphaFramePair &pair);
bool preservesAlphaPrimaryPredictionChain(const ExactAlphaFramePair &pair, uint64_t lastEncodedSequence);
bool isAlphaPairNewerThan(const ExactAlphaFramePair &pair,
                          int64_t lastPrimaryTransportPts,
                          uint64_t minimumAdmissionSequenceExclusive);
int64_t nextMonotonicVideoTransportPts(int64_t candidateSourcePts,
                                       int64_t lastReservedTransportPts);

struct AlphaContractRecoveryObservation {
    ProtectedAlphaContractValidation validation;
    bool recoveryScheduled = false;
    bool recovered = false;
};

// Pair-level preflight state. One observe() call corresponds to one completed
// exact pair, independent of viewer count, so rejection telemetry and recovery
// are never multiplied by the number of connected peers.
class AlphaContractRecoveryController {
  public:
    explicit AlphaContractRecoveryController(int64_t recoveryCooldownMs = 1000);

    AlphaContractRecoveryObservation observe(const ExactAlphaFramePair &pair,
                                              int64_t nowMs);
    void reset();

    uint64_t rejectedPairCount() const;
    uint64_t recoveryAttemptCount() const;
    uint64_t recoverySuccessCount() const;
    bool recoveryActive() const;
    ProtectedAlphaContractRejection lastRejection() const;

  private:
    const int64_t recoveryCooldownMs_;
    mutable std::mutex mutex_;
    bool recoveryActive_ = false;
    bool hasScheduledRecovery_ = false;
    int64_t lastRecoveryMs_ = 0;
    uint64_t rejectedPairCount_ = 0;
    uint64_t recoveryAttemptCount_ = 0;
    uint64_t recoverySuccessCount_ = 0;
    ProtectedAlphaContractRejection lastRejection_ =
        ProtectedAlphaContractRejection::None;
};

// Bounded one-shot matcher. Packets are moved out exactly once; an unmatched
// or retired-generation half is never retimestamped or reused for another
// source frame.
class ExactAlphaFramePairer {
  public:
    explicit ExactAlphaFramePairer(std::size_t maxPendingFrames = 16);

    std::optional<ExactAlphaFramePair> submitPrimary(ExactAlphaFramePacket packet);
    std::optional<ExactAlphaFramePair> submitAlpha(ExactAlphaFramePacket packet);
    void clear();

    std::size_t pendingPrimaryCount() const;
    std::size_t pendingAlphaCount() const;
    uint64_t droppedHalfCount() const;

  private:
    std::optional<ExactAlphaFramePair> submit(ExactAlphaFramePacket packet, bool primary);
    static bool valid(const ExactAlphaFramePacket &packet);
    static bool sameIdentity(const ExactAlphaFramePacket &lhs, const ExactAlphaFramePacket &rhs);
    void prune(std::deque<ExactAlphaFramePacket> &packets);
    void trimCompletedIdentities();

    const std::size_t maxPendingFrames_;
    mutable std::mutex mutex_;
    std::deque<ExactAlphaFramePacket> primaryPackets_;
    std::deque<ExactAlphaFramePacket> alphaPackets_;
    std::deque<std::tuple<uint64_t, uint64_t, int64_t>> completedIdentities_;
    uint64_t droppedHalfCount_ = 0;
    uint64_t retiredAdmissionSequenceWatermark_ = 0;
    int64_t lastTransportPts_ = std::numeric_limits<int64_t>::min();
};

struct ExactAlphaDispatchResult {
    bool admitted = false;
    bool alphaSent = false;
    bool primarySent = false;
};

using ExactAlphaDispatchAdmission = std::function<bool()>;
using ExactAlphaPacketSender = std::function<bool(const versus::video::EncodedPacket &)>;

// Serializes both track sends with peer transport reset/replacement. The
// primary is never sent unless the matching alpha packet succeeded first.
ExactAlphaDispatchResult dispatchExactAlphaFramePair(
    const ExactAlphaFramePair &pair,
    std::recursive_mutex &transportOperationMutex,
    const ExactAlphaDispatchAdmission &admit,
    const ExactAlphaPacketSender &sendAlpha,
    const ExactAlphaPacketSender &sendPrimary);

}  // namespace versus::app
