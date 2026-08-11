#include <QtTest/QtTest>

#include "versus/app/alpha_frame_pairer.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iterator>
#include <limits>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

versus::app::ExactAlphaFramePacket makePacket(int64_t pts,
                                               uint64_t generation,
                                               uint8_t marker,
                                               bool keyframe = true,
                                               int width = 640,
                                               int height = 360,
                                               int64_t sourceTimestamp = std::numeric_limits<int64_t>::min(),
                                               uint64_t admissionSequence = 0) {
    versus::app::ExactAlphaFramePacket frame;
    frame.packet.data = {marker};
    const int64_t effectiveSourceTimestamp =
        sourceTimestamp == std::numeric_limits<int64_t>::min()
        ? pts
        : sourceTimestamp;
    frame.packet.sourceTimestamp = effectiveSourceTimestamp;
    frame.packet.pts = pts;
    frame.packet.dts = pts;
    frame.packet.isKeyframe = keyframe;
    frame.packet.codec = versus::video::VideoCodec::VP9;
    frame.pipelineGeneration = generation;
    if (admissionSequence == 0) {
        const uint64_t rawTimestamp = static_cast<uint64_t>(effectiveSourceTimestamp);
        admissionSequence = rawTimestamp == std::numeric_limits<uint64_t>::max()
            ? rawTimestamp
            : rawTimestamp + 1;
        if (admissionSequence == 0) {
            admissionSequence = 1;
        }
    }
    frame.sourceAdmissionSequence = admissionSequence;
    frame.encodedWidth = width;
    frame.encodedHeight = height;
    return frame;
}

}  // namespace

class TestAlphaFramePairer : public QObject {
    Q_OBJECT

  private slots:
    void testExactSourcePtsPairsWithoutRetimestamping();
    void testEncoderPtsCannotImpersonateSourceIdentity();
    void testUnknownSourceIdentityIsRejected();
    void testMissingAndStaleHalvesNeverPair();
    void testOutOfOrderAndDuplicatePacketsAreOneShot();
    void testCapacityDropsUnmatchedOldestHalf();
    void testClearAndGenerationPreventPreResetLeakage();
    void testScaledAlphaDimensionsRemainCompatible();
    void testLargePtsAcrossRtpWrapRemainExact();
    void testAdmissionTrackerMapsDelayedAndDuplicateTimestamps();
    void testAdmissionTrackerZeroSentinelAndGenerationReset();
    void testKeyframeAndMonotonicAdmission();
    void testWireTimestampPolicyAdvancesDuplicateBackwardAndDelayedFrames();
    void testLatePreResetSourceRejectedEvenWithNewTransportPts();
    void testPausedPreTransitionAdmissionCannotReachNewTransport();
    void testCompletedIdentityCannotReplayAfterHistoryEviction();
    void testStartupRequiresExactDualKeyframePair();
    void testProtectedVp9OptionsCannotWeakenAlphaContract();
    void testProtectedVp9OptionsRejectTimingCardinalityAndRateAliases();
    void testProtectedVp9OptionsRejectNormalizedTopologyAndFileAliases();
    void testMediaFoundationWarmupLifecycleFailsClosedAndClearsIdentity();
    void testH264AccessUnitKeyframeTruthAndAlphaStartup();
    void testExternalSourceIdentityQueueIsBoundedAndFifo();
    void testProtectedKeyframeGuaranteeUsesLiveRuntimeState();
    void testVp9PayloadKeyframeDetectionIsTruthful();
    void testProtectedAlphaContractReturnsStructuredRejections();
    void testPairLevelContractRecoveryIsOnceAndCooldownBounded();
    void testAlphaFailureSuppressesPrimary();
    void testDispatchIsAlphaFirstAndAtomicAgainstReset();
};

void TestAlphaFramePairer::testExactSourcePtsPairsWithoutRetimestamping() {
    versus::app::ExactAlphaFramePairer pairer;
    QVERIFY(!pairer.submitPrimary(makePacket(41, 7, 0x20, true, 640, 360, 200)).has_value());

    const auto pair = pairer.submitAlpha(makePacket(991, 7, 0xA0, true, 640, 360, 200));
    QVERIFY(pair.has_value());
    QVERIFY(versus::app::isExactAlphaFramePair(*pair));
    QCOMPARE(pair->primary.packet.pts, 41);
    QCOMPARE(pair->alpha.packet.pts, 991);
    QCOMPARE(pair->primary.packet.sourceTimestamp, 200);
    QCOMPARE(pair->alpha.packet.sourceTimestamp, 200);
    QCOMPARE(pair->transportPts, 200);
    QCOMPARE(pair->primary.packet.data.front(), uint8_t{0x20});
    QCOMPARE(pair->alpha.packet.data.front(), uint8_t{0xA0});
    QCOMPARE(pairer.pendingPrimaryCount(), std::size_t{0});
    QCOMPARE(pairer.pendingAlphaCount(), std::size_t{0});
}

void TestAlphaFramePairer::testEncoderPtsCannotImpersonateSourceIdentity() {
    versus::app::ExactAlphaFramePairer pairer;
    QVERIFY(!pairer.submitPrimary(makePacket(5, 2, 0x20, true, 640, 360, 100)).has_value());
    // The independent encoders can both report PTS=5 for different source
    // captures. That is not a pair.
    QVERIFY(!pairer.submitAlpha(makePacket(5, 2, 0xA0, true, 640, 360, 200)).has_value());
    QCOMPARE(pairer.pendingPrimaryCount(), std::size_t{1});
    QCOMPARE(pairer.pendingAlphaCount(), std::size_t{1});

    const auto exact = pairer.submitAlpha(makePacket(6, 2, 0xA1, true, 640, 360, 100));
    QVERIFY(exact.has_value());
    QCOMPARE(exact->primary.packet.pts, 5);
    QCOMPARE(exact->alpha.packet.pts, 6);
    QCOMPARE(exact->transportPts, 100);
}

void TestAlphaFramePairer::testUnknownSourceIdentityIsRejected() {
    versus::app::ExactAlphaFramePairer pairer;
    auto unknownPrimary = makePacket(7, 2, 0x22);
    unknownPrimary.packet.sourceTimestamp = std::numeric_limits<int64_t>::min();
    QVERIFY(!pairer.submitPrimary(std::move(unknownPrimary)).has_value());
    QCOMPARE(pairer.pendingPrimaryCount(), std::size_t{0});
    QCOMPARE(pairer.droppedHalfCount(), uint64_t{1});

    auto pair = versus::app::ExactAlphaFramePair{};
    pair.primary = makePacket(8, 2, 0x23);
    pair.alpha = makePacket(8, 2, 0xA3);
    pair.transportPts = 8;
    pair.alpha.packet.sourceTimestamp = std::numeric_limits<int64_t>::min();
    QVERIFY(!versus::app::isExactAlphaFramePair(pair));
}

void TestAlphaFramePairer::testMissingAndStaleHalvesNeverPair() {
    versus::app::ExactAlphaFramePairer pairer;
    QVERIFY(!pairer.submitAlpha(makePacket(100, 3, 0xA1)).has_value());
    QVERIFY(!pairer.submitPrimary(makePacket(200, 3, 0x21)).has_value());
    QCOMPARE(pairer.pendingPrimaryCount(), std::size_t{1});
    QCOMPARE(pairer.pendingAlphaCount(), std::size_t{1});

    const auto exact = pairer.submitAlpha(makePacket(200, 3, 0xA2));
    QVERIFY(exact.has_value());
    QCOMPARE(exact->primary.packet.pts, 200);
    QCOMPARE(exact->alpha.packet.pts, 200);
    QCOMPARE(exact->alpha.packet.data.front(), uint8_t{0xA2});
    QCOMPARE(pairer.pendingAlphaCount(), std::size_t{1});
}

void TestAlphaFramePairer::testOutOfOrderAndDuplicatePacketsAreOneShot() {
    versus::app::ExactAlphaFramePairer pairer;
    QVERIFY(!pairer.submitAlpha(makePacket(300, 8, 0xA1)).has_value());
    QVERIFY(!pairer.submitAlpha(makePacket(300, 8, 0xA2)).has_value());

    const auto first = pairer.submitPrimary(makePacket(300, 8, 0x21));
    QVERIFY(first.has_value());
    QCOMPARE(first->alpha.packet.data.front(), uint8_t{0xA2});
    QCOMPARE(pairer.pendingAlphaCount(), std::size_t{0});

    const auto second = pairer.submitPrimary(makePacket(300, 8, 0x22));
    QVERIFY(!second.has_value());
    QCOMPARE(pairer.pendingAlphaCount(), std::size_t{0});
    QCOMPARE(pairer.pendingPrimaryCount(), std::size_t{0});
    QVERIFY(pairer.droppedHalfCount() >= 2);
}

void TestAlphaFramePairer::testCapacityDropsUnmatchedOldestHalf() {
    versus::app::ExactAlphaFramePairer pairer(2);
    QVERIFY(!pairer.submitPrimary(makePacket(1, 1, 0x11)).has_value());
    QVERIFY(!pairer.submitPrimary(makePacket(2, 1, 0x12)).has_value());
    QVERIFY(!pairer.submitPrimary(makePacket(3, 1, 0x13)).has_value());
    QCOMPARE(pairer.pendingPrimaryCount(), std::size_t{2});
    QCOMPARE(pairer.droppedHalfCount(), uint64_t{1});

    QVERIFY(!pairer.submitAlpha(makePacket(1, 1, 0xA1)).has_value());
    const auto retained = pairer.submitAlpha(makePacket(2, 1, 0xA2));
    QVERIFY(retained.has_value());
    QCOMPARE(retained->primary.packet.pts, 2);
}

void TestAlphaFramePairer::testClearAndGenerationPreventPreResetLeakage() {
    versus::app::ExactAlphaFramePairer pairer;
    QVERIFY(!pairer.submitPrimary(
        makePacket(500, 10, 0x25, true, 640, 360, 500, 10)).has_value());
    pairer.clear();
    QVERIFY(!pairer.submitAlpha(
        makePacket(500, 10, 0xA5, true, 640, 360, 500, 10)).has_value());
    QVERIFY(!pairer.submitPrimary(
        makePacket(500, 11, 0x26, true, 640, 360, 501, 11)).has_value());

    const auto postReset = pairer.submitAlpha(
        makePacket(500, 11, 0xA6, true, 640, 360, 501, 11));
    QVERIFY(postReset.has_value());
    QCOMPARE(postReset->primary.pipelineGeneration, uint64_t{11});
    QCOMPARE(postReset->alpha.pipelineGeneration, uint64_t{11});
    QCOMPARE(postReset->primary.packet.data.front(), uint8_t{0x26});
}

void TestAlphaFramePairer::testScaledAlphaDimensionsRemainCompatible() {
    versus::app::ExactAlphaFramePairer pairer;
    QVERIFY(!pairer.submitPrimary(makePacket(600, 12, 0x31, true, 1920, 1080)).has_value());
    const auto pair = pairer.submitAlpha(makePacket(600, 12, 0xA1, true, 960, 540));
    QVERIFY(pair.has_value());
    QVERIFY(versus::app::isExactAlphaFramePair(*pair));
    QCOMPARE(pair->primary.encodedWidth, 1920);
    QCOMPARE(pair->alpha.encodedWidth, 960);
}

void TestAlphaFramePairer::testLargePtsAcrossRtpWrapRemainExact() {
    // 90 kHz RTP wraps after this source PTS, but both tracks derive the same
    // wrapped timestamp because their full-width source PTS remains identical.
    constexpr int64_t ptsPastRtpWrap = (static_cast<int64_t>(1) << 32) * 1000 / 9 + 12345;
    versus::app::ExactAlphaFramePairer pairer;
    QVERIFY(!pairer.submitAlpha(makePacket(ptsPastRtpWrap, 13, 0xA3)).has_value());
    const auto pair = pairer.submitPrimary(makePacket(ptsPastRtpWrap, 13, 0x33));
    QVERIFY(pair.has_value());
    QCOMPARE(pair->primary.packet.pts, ptsPastRtpWrap);
    QCOMPARE(pair->alpha.packet.pts, ptsPastRtpWrap);
    QCOMPARE(pair->transportPts, ptsPastRtpWrap);
}

void TestAlphaFramePairer::testAdmissionTrackerMapsDelayedAndDuplicateTimestamps() {
    versus::app::AlphaFrameAdmissionTracker tracker(8);

    const auto first = tracker.admit(100, 4);
    const auto duplicate = tracker.admit(100, 4);
    QVERIFY(first.valid());
    QVERIFY(duplicate.valid());
    QCOMPARE(first.sourceTimestamp, int64_t{100});
    QCOMPARE(duplicate.sourceTimestamp, int64_t{101});
    QVERIFY(first.sequence < duplicate.sequence);

    // Independent encoders may finish different admitted frames in opposite
    // orders. Their unique correlation timestamps still recover the exact
    // admission rather than relying on FIFO ordering for a duplicate capture
    // timestamp.
    const auto primarySecond = tracker.resolvePrimary(duplicate.sourceTimestamp);
    const auto alphaFirst = tracker.resolveAlpha(first.sourceTimestamp);
    const auto primaryFirst = tracker.resolvePrimary(first.sourceTimestamp);
    const auto alphaSecond = tracker.resolveAlpha(duplicate.sourceTimestamp);
    QVERIFY(primarySecond.has_value());
    QVERIFY(alphaFirst.has_value());
    QVERIFY(primaryFirst.has_value());
    QVERIFY(alphaSecond.has_value());
    QCOMPARE(primarySecond->sequence, duplicate.sequence);
    QCOMPARE(alphaSecond->sequence, duplicate.sequence);
    QCOMPARE(primaryFirst->sequence, first.sequence);
    QCOMPARE(alphaFirst->sequence, first.sequence);
    QCOMPARE(tracker.pendingCount(), std::size_t{0});
}

void TestAlphaFramePairer::testAdmissionTrackerZeroSentinelAndGenerationReset() {
    versus::app::AlphaFrameAdmissionTracker tracker(4);

    const auto zero = tracker.admit(0, 1);
    QVERIFY(zero.valid());
    QCOMPARE(zero.sourceTimestamp, int64_t{0});
    QVERIFY(!tracker.admit(std::numeric_limits<int64_t>::min(), 1).valid());
    QVERIFY(!tracker.admit(1, 0).valid());

    tracker.clearPending();
    QVERIFY(!tracker.resolvePrimary(zero.sourceTimestamp).has_value());

    const auto afterReset = tracker.admit(0, 2);
    QVERIFY(afterReset.valid());
    QCOMPARE(afterReset.pipelineGeneration, uint64_t{2});
    QVERIFY(afterReset.sequence > zero.sequence);
    QVERIFY(afterReset.sourceTimestamp > zero.sourceTimestamp);
    const auto primary = tracker.resolvePrimary(afterReset.sourceTimestamp);
    const auto alpha = tracker.resolveAlpha(afterReset.sourceTimestamp);
    QVERIFY(primary.has_value());
    QVERIFY(alpha.has_value());
    QCOMPARE(primary->sequence, afterReset.sequence);
    QCOMPARE(alpha->sequence, afterReset.sequence);
}

void TestAlphaFramePairer::testKeyframeAndMonotonicAdmission() {
    versus::app::ExactAlphaFramePair pair;
    pair.primary = makePacket(800, 14, 0x41, true);
    pair.alpha = makePacket(800, 14, 0xA4, false);
    pair.transportPts = 800;
    QVERIFY(versus::app::isExactAlphaFramePair(pair));
    QVERIFY(!versus::app::canStartAlphaTransportWithPair(pair));
    const uint64_t admissionSequence = pair.primary.sourceAdmissionSequence;
    QVERIFY(versus::app::isAlphaPairNewerThan(pair, 799, admissionSequence - 1));
    QVERIFY(versus::app::isAlphaPairNewerThan(pair, 800, admissionSequence - 1));
    QVERIFY(!versus::app::isAlphaPairNewerThan(pair, 700, admissionSequence));

    pair.alpha.packet.isKeyframe = true;
    QVERIFY(versus::app::canStartAlphaTransportWithPair(pair));
}

void TestAlphaFramePairer::testWireTimestampPolicyAdvancesDuplicateBackwardAndDelayedFrames() {
    using versus::app::nextMonotonicVideoTransportPts;
    const int64_t unset = std::numeric_limits<int64_t>::min();
    const int64_t first = nextMonotonicVideoTransportPts(1000, unset);
    const int64_t subRtpTickForward =
        nextMonotonicVideoTransportPts(1001, first);
    const int64_t duplicate = nextMonotonicVideoTransportPts(1000, first);
    const int64_t backward = nextMonotonicVideoTransportPts(200, duplicate);
    const int64_t delayed = nextMonotonicVideoTransportPts(1050, backward);
    const int64_t forward = nextMonotonicVideoTransportPts(5000, delayed);

    QCOMPARE(first, int64_t{1000});
    QCOMPARE(subRtpTickForward, int64_t{1112});
    QCOMPARE(duplicate, int64_t{1112});
    QCOMPARE(backward, int64_t{1224});
    QCOMPARE(delayed, int64_t{1336});
    QCOMPARE(forward, int64_t{5000});
    QVERIFY(static_cast<uint32_t>((duplicate * 9) / 1000) !=
            static_cast<uint32_t>((first * 9) / 1000));
    QVERIFY(static_cast<uint32_t>((subRtpTickForward * 9) / 1000) !=
            static_cast<uint32_t>((first * 9) / 1000));
    QVERIFY(static_cast<uint32_t>((backward * 9) / 1000) !=
            static_cast<uint32_t>((duplicate * 9) / 1000));

    const int64_t nearExhaustion = std::numeric_limits<int64_t>::max() - 50;
    QCOMPARE(nextMonotonicVideoTransportPts(0, nearExhaustion),
             std::numeric_limits<int64_t>::max());
    QCOMPARE(nextMonotonicVideoTransportPts(0, std::numeric_limits<int64_t>::max()),
             std::numeric_limits<int64_t>::max());
}

void TestAlphaFramePairer::testLatePreResetSourceRejectedEvenWithNewTransportPts() {
    constexpr int64_t sourceAtLastRtpTickBeforeWrap =
        ((static_cast<int64_t>(std::numeric_limits<uint32_t>::max()) * 1000) + 8) / 9;
    versus::app::ExactAlphaFramePairer pairer;
    // Leave an old alpha half pending, then complete a newer source pair and
    // reserve that source timestamp as the reset/capability cutoff.
    QVERIFY(!pairer.submitAlpha(makePacket(10, 17, 0xA1, true, 640, 360, 100)).has_value());
    QVERIFY(!pairer.submitPrimary(
        makePacket(20, 17, 0x21, true, 640, 360, sourceAtLastRtpTickBeforeWrap)).has_value());
    const auto newer = pairer.submitAlpha(
        makePacket(30, 17, 0xA2, true, 640, 360, sourceAtLastRtpTickBeforeWrap));
    QVERIFY(newer.has_value());
    QCOMPARE(newer->transportPts, sourceAtLastRtpTickBeforeWrap);

    // Completing the old pair later forces its transport clock forward. The
    // source cutoff must still reject it: transport monotonicity alone cannot
    // turn pre-reset captured content into a post-reset frame.
    const auto lateOld = pairer.submitPrimary(makePacket(40, 17, 0x22, true, 640, 360, 100));
    QVERIFY(lateOld.has_value());
    QCOMPARE(lateOld->primary.packet.sourceTimestamp, 100);
    QCOMPARE(lateOld->transportPts, sourceAtLastRtpTickBeforeWrap + 112);
    QVERIFY(lateOld->transportPts > newer->transportPts);
    const uint32_t newerRtpTimestamp =
        static_cast<uint32_t>((newer->transportPts * 9) / 1000);
    const uint32_t lateOldRtpTimestamp =
        static_cast<uint32_t>((lateOld->transportPts * 9) / 1000);
    QCOMPARE(newerRtpTimestamp, std::numeric_limits<uint32_t>::max());
    QCOMPARE(lateOldRtpTimestamp, uint32_t{0});
    QVERIFY(lateOldRtpTimestamp != newerRtpTimestamp);
    QVERIFY(!versus::app::isAlphaPairNewerThan(
        *lateOld,
        newer->transportPts - 1,
        newer->primary.sourceAdmissionSequence));
}

void TestAlphaFramePairer::testPausedPreTransitionAdmissionCannotReachNewTransport() {
    using namespace std::chrono_literals;
    versus::app::AlphaFrameAdmissionTracker tracker;
    versus::app::ExactAlphaFramePairer pairer;
    std::recursive_mutex operationMutex;
    std::mutex pauseMutex;
    std::condition_variable pauseCv;
    bool admitted = false;
    bool completeEncode = false;
    std::optional<versus::app::ExactAlphaFramePair> preTransitionPair;

    std::thread encoder([&]() {
        const auto admission = tracker.admit(5000, 9);
        {
            std::lock_guard<std::mutex> lock(pauseMutex);
            admitted = admission.valid();
        }
        pauseCv.notify_all();
        {
            std::unique_lock<std::mutex> lock(pauseMutex);
            pauseCv.wait_for(lock, 2s, [&]() { return completeEncode; });
        }
        const auto primaryAdmission = tracker.resolvePrimary(admission.sourceTimestamp);
        const auto alphaAdmission = tracker.resolveAlpha(admission.sourceTimestamp);
        if (!primaryAdmission || !alphaAdmission) {
            return;
        }
        pairer.submitPrimary(makePacket(
            1,
            primaryAdmission->pipelineGeneration,
            0x31,
            true,
            640,
            360,
            primaryAdmission->sourceTimestamp,
            primaryAdmission->sequence));
        preTransitionPair = pairer.submitAlpha(makePacket(
            2,
            alphaAdmission->pipelineGeneration,
            0xA1,
            true,
            640,
            360,
            alphaAdmission->sourceTimestamp,
            alphaAdmission->sequence));
    });

    {
        std::unique_lock<std::mutex> lock(pauseMutex);
        QVERIFY(pauseCv.wait_for(lock, 2s, [&]() { return admitted; }));
    }
    // A reset/capability transition reserves all admitted work, including the
    // frame currently paused inside an encoder and not yet present in either
    // completed-packet queue.
    const auto cutoff = tracker.latestAdmission();
    QVERIFY(cutoff.valid());
    {
        std::lock_guard<std::mutex> lock(pauseMutex);
        completeEncode = true;
    }
    pauseCv.notify_all();
    encoder.join();
    QVERIFY(preTransitionPair.has_value());

    int preTransitionSends = 0;
    const auto rejected = versus::app::dispatchExactAlphaFramePair(
        *preTransitionPair,
        operationMutex,
        [&]() {
            return versus::app::isAlphaPairNewerThan(
                *preTransitionPair,
                std::numeric_limits<int64_t>::min(),
                cutoff.sequence);
        },
        [&](const versus::video::EncodedPacket &) {
            ++preTransitionSends;
            return true;
        },
        [&](const versus::video::EncodedPacket &) {
            ++preTransitionSends;
            return true;
        });
    QVERIFY(!rejected.admitted);
    QCOMPARE(preTransitionSends, 0);

    const auto postAdmission = tracker.admit(5000, 9);
    QVERIFY(postAdmission.valid());
    QVERIFY(postAdmission.sequence > cutoff.sequence);
    const auto postPrimary = tracker.resolvePrimary(postAdmission.sourceTimestamp);
    const auto postAlpha = tracker.resolveAlpha(postAdmission.sourceTimestamp);
    QVERIFY(postPrimary.has_value());
    QVERIFY(postAlpha.has_value());
    QVERIFY(!pairer.submitAlpha(makePacket(
        3,
        postAlpha->pipelineGeneration,
        0xA2,
        true,
        640,
        360,
        postAlpha->sourceTimestamp,
        postAlpha->sequence)).has_value());
    const auto postTransitionPair = pairer.submitPrimary(makePacket(
        4,
        postPrimary->pipelineGeneration,
        0x32,
        true,
        640,
        360,
        postPrimary->sourceTimestamp,
        postPrimary->sequence));
    QVERIFY(postTransitionPair.has_value());

    std::vector<std::string> order;
    const auto sent = versus::app::dispatchExactAlphaFramePair(
        *postTransitionPair,
        operationMutex,
        [&]() {
            return versus::app::isAlphaPairNewerThan(
                       *postTransitionPair,
                       preTransitionPair->transportPts,
                       cutoff.sequence) &&
                versus::app::canStartAlphaTransportWithPair(*postTransitionPair);
        },
        [&](const versus::video::EncodedPacket &) {
            order.emplace_back("alpha");
            return true;
        },
        [&](const versus::video::EncodedPacket &) {
            order.emplace_back("primary");
            return true;
        });
    QVERIFY(sent.alphaSent);
    QVERIFY(sent.primarySent);
    QCOMPARE(order.size(), std::size_t{2});
    QCOMPARE(order[0], std::string("alpha"));
    QCOMPARE(order[1], std::string("primary"));
}

void TestAlphaFramePairer::testCompletedIdentityCannotReplayAfterHistoryEviction() {
    versus::app::ExactAlphaFramePairer pairer(1);
    for (uint64_t sequence = 1; sequence <= 24; ++sequence) {
        const int64_t sourceTimestamp = 1000 + static_cast<int64_t>(sequence);
        QVERIFY(!pairer.submitPrimary(makePacket(
            static_cast<int64_t>(sequence),
            3,
            0x41,
            true,
            640,
            360,
            sourceTimestamp,
            sequence)).has_value());
        QVERIFY(pairer.submitAlpha(makePacket(
            static_cast<int64_t>(sequence + 100),
            3,
            0xA4,
            true,
            640,
            360,
            sourceTimestamp,
            sequence)).has_value());
    }

    // Sequence 1 is no longer in the bounded completed-identity deque, but the
    // retired watermark must still prevent it from becoming sendable again.
    QVERIFY(!pairer.submitPrimary(
        makePacket(1, 3, 0x51, true, 640, 360, 1001, 1)).has_value());
    QVERIFY(!pairer.submitAlpha(
        makePacket(101, 3, 0xA5, true, 640, 360, 1001, 1)).has_value());
    QCOMPARE(pairer.pendingPrimaryCount(), std::size_t{0});
    QCOMPARE(pairer.pendingAlphaCount(), std::size_t{0});
    QVERIFY(pairer.droppedHalfCount() >= uint64_t{2});
}

void TestAlphaFramePairer::testStartupRequiresExactDualKeyframePair() {
    versus::app::ExactAlphaFramePairer pairer;
    std::recursive_mutex operationMutex;
    bool waitingForKeyframe = true;
    std::vector<std::string> order;

    QVERIFY(!pairer.submitPrimary(makePacket(1100, 18, 0x51, true)).has_value());
    const auto halfKeyframePair = pairer.submitAlpha(makePacket(1100, 18, 0xA5, false));
    QVERIFY(halfKeyframePair.has_value());
    const auto rejected = versus::app::dispatchExactAlphaFramePair(
        *halfKeyframePair,
        operationMutex,
        [&]() {
            return !waitingForKeyframe ||
                versus::app::canStartAlphaTransportWithPair(*halfKeyframePair);
        },
        [&](const versus::video::EncodedPacket &) {
            order.emplace_back("alpha");
            return true;
        },
        [&](const versus::video::EncodedPacket &) {
            order.emplace_back("primary");
            return true;
        });
    QVERIFY(!rejected.admitted);
    QVERIFY(order.empty());
    QVERIFY(waitingForKeyframe);

    QVERIFY(!pairer.submitAlpha(makePacket(1200, 18, 0xA6, true)).has_value());
    const auto dualKeyframePair = pairer.submitPrimary(makePacket(1200, 18, 0x52, true));
    QVERIFY(dualKeyframePair.has_value());
    const auto sent = versus::app::dispatchExactAlphaFramePair(
        *dualKeyframePair,
        operationMutex,
        [&]() {
            return !waitingForKeyframe ||
                versus::app::canStartAlphaTransportWithPair(*dualKeyframePair);
        },
        [&](const versus::video::EncodedPacket &) {
            order.emplace_back("alpha");
            return true;
        },
        [&](const versus::video::EncodedPacket &) {
            order.emplace_back("primary");
            return true;
        });
    QVERIFY(sent.alphaSent);
    QVERIFY(sent.primarySent);
    if (sent.primarySent && versus::app::canStartAlphaTransportWithPair(*dualKeyframePair)) {
        waitingForKeyframe = false;
    }
    QVERIFY(!waitingForKeyframe);
    QCOMPARE(order.size(), std::size_t{2});
    QCOMPARE(order[0], std::string("alpha"));
    QCOMPARE(order[1], std::string("primary"));
}

void TestAlphaFramePairer::testProtectedVp9OptionsCannotWeakenAlphaContract() {
    const std::vector<std::string> customArgs = {
        "-threads", "6",
        "-g", "30",
        "-keyint_min=30",
        "-lag-in-frames", "4",
        "-auto-alt-ref", "1",
        "-c:v", "libvpx-vp9",
        "-g:v:0=90",
        "-deadline", "realtime",
    };
    const auto policy = versus::video::detail::appendProtectedVp9Options(
        {"ffmpeg", "-hide_banner"},
        customArgs);

    QCOMPARE(policy.rejectedOptions.size(), std::size_t{6});
    QVERIFY(std::find(policy.args.begin(), policy.args.end(), "-threads") != policy.args.end());
    QVERIFY(std::find(policy.args.begin(), policy.args.end(), "6") != policy.args.end());
    QVERIFY(std::find(policy.args.begin(), policy.args.end(), "-deadline") != policy.args.end());
    QVERIFY(std::find(policy.args.begin(), policy.args.end(), "realtime") != policy.args.end());
    QVERIFY(std::find(policy.args.begin(), policy.args.end(), "30") == policy.args.end());
    QCOMPARE(std::count(policy.args.begin(), policy.args.end(), "libvpx-vp9"), 1);

    const std::vector<std::string> mandatory = {
        "-lag-in-frames", "0",
        "-auto-alt-ref", "0",
        "-g", "1",
        "-keyint_min", "1",
    };
    QVERIFY(policy.args.size() >= mandatory.size());
    QVERIFY(std::equal(
        mandatory.begin(),
        mandatory.end(),
        policy.args.end() - static_cast<std::ptrdiff_t>(mandatory.size())));
}

void TestAlphaFramePairer::testProtectedVp9OptionsRejectTimingCardinalityAndRateAliases() {
    const std::vector<std::string> customArgs = {
        "-vf:v:0=fps=15",
        "-filter:v", "setpts=2*PTS",
        "-r:v:0", "24",
        "-fps_mode=vfr",
        "-vsync", "drop",
        "-frames:v=12",
        "-vframes", "9",
        "-copyts",
        "-start_at_zero",
        "-enc_time_base:v:0", "1/30",
        "-b:v:0=250k",
        "-maxrate:v", "300k",
        "-bufsize:v:0=600k",
        "-crf:v", "48",
        "-drop-threshold=80",
        "-threads", "4",
    };

    const auto policy = versus::video::detail::appendProtectedVp9Options(
        {"ffmpeg", "-hide_banner"},
        customArgs);

    const std::vector<std::string> allowed = {"-threads", "4"};
    for (const auto &token : allowed) {
        QVERIFY2(std::find(policy.args.begin(), policy.args.end(), token) != policy.args.end(),
                 qPrintable(QString("Expected safe option '%1' to remain")
                                .arg(QString::fromStdString(token))));
    }

    const std::vector<std::string> forbiddenTokens = {
        "-vf:v:0=fps=15", "-filter:v", "setpts=2*PTS", "-r:v:0", "24",
        "-fps_mode=vfr", "-vsync", "drop", "-frames:v=12", "-vframes", "9",
        "-copyts", "-start_at_zero", "-enc_time_base:v:0", "1/30",
        "-b:v:0=250k", "-maxrate:v", "300k", "-bufsize:v:0=600k",
        "-crf:v", "48", "-drop-threshold=80",
    };
    for (const auto &token : forbiddenTokens) {
        const bool leaked =
            std::find(policy.args.begin(), policy.args.end(), token) != policy.args.end();
        QVERIFY2(!leaked,
                 qPrintable(QString("Protected option token '%1' leaked into FFmpeg args")
                                .arg(QString::fromStdString(token))));
    }

    QVERIFY2(policy.rejectedOptions.size() >= 15,
             "Every protected alias/specifier form must be reported as rejected");
}

void TestAlphaFramePairer::testProtectedVp9OptionsRejectNormalizedTopologyAndFileAliases() {
    struct PolicyCase {
        const char *name;
        std::vector<std::string> customArgs;
    };
    const std::vector<PolicyCase> blockedCases = {
        {"fpsmax-stream-inline", {"-fpsmax:v:0=1"}},
        {"fpsmax-double-dash", {"--fpsmax:v:0", "17"}},
        {"legacy-filter-script", {"-filter_script:v:0", "graph.txt"}},
        {"file-filter", {"-/filter:v:0", "graph.txt"}},
        {"file-filter-inline", {"-/filter:v:0=graph.txt"}},
        {"global-lavfi", {"-lavfi", "fps=1"}},
        {"map-topology", {"-map:v:0", "0:v:0"}},
        {"extra-input", {"-i", "second-input.y4m"}},
        {"codec-alias", {"--codec:v:0=vp9_qsv"}},
        {"stream-cardinality", {"-frames:v:0", "2"}},
        {"output-size", {"-s:v:0=32x32"}},
        {"pixel-format", {"-pix_fmt:v:0", "yuva420p"}},
        {"two-pass", {"-pass:v:0=1"}},
        {"quality-alias", {"-q:v:0", "50"}},
        {"rate-control-alias", {"--bitrate:v:0=1k"}},
        {"gop-file-option", {"-/g:v:0", "gop.txt"}},
        {"positional-output", {"second-output.ivf"}},
    };

    for (const auto &blocked : blockedCases) {
        const auto policy = versus::video::detail::appendProtectedVp9Options(
            {"ffmpeg", "-hide_banner"},
            blocked.customArgs);
        for (const auto &token : blocked.customArgs) {
            const bool leaked =
                std::find(policy.args.begin(), policy.args.end(), token) != policy.args.end();
            QVERIFY2(!leaked,
                     qPrintable(QString("Case '%1' leaked token '%2' into the protected command")
                                    .arg(blocked.name, QString::fromStdString(token))));
        }
        QCOMPARE(policy.rejectedOptions.size(), std::size_t{1});
    }

    const std::vector<std::string> safeCustom = {
        "--threads:v:0=2",
        "-deadline", "realtime",
        "-cpu-used:v:0", "7",
        "-row-mt=1",
        "-tile-columns:v:0", "1",
    };
    const auto safePolicy = versus::video::detail::appendProtectedVp9Options(
        {"ffmpeg", "-hide_banner"},
        safeCustom);
    QVERIFY2(safePolicy.rejectedOptions.empty(),
             "Demonstrably timing-neutral libvpx tuning options must remain available");
    const auto canonicalThreads = std::find(
        safePolicy.args.begin(),
        safePolicy.args.end(),
        "-threads:v:0");
    QVERIFY(canonicalThreads != safePolicy.args.end());
    QVERIFY(std::next(canonicalThreads) != safePolicy.args.end());
    QCOMPARE(*std::next(canonicalThreads), std::string("2"));
    QVERIFY(std::find(
                safePolicy.args.begin(),
                safePolicy.args.end(),
                "--threads:v:0=2") == safePolicy.args.end());
}

void TestAlphaFramePairer::testMediaFoundationWarmupLifecycleFailsClosedAndClearsIdentity() {
    std::vector<std::string> events;
    int activationCount = 1;  // The warmed transform was the first activation.
    std::deque<int64_t> sourceIdentities = {-777};  // Warm-up probe sentinel.

    const bool failedShutdownWasAccepted =
        versus::video::detail::prepareFreshMediaFoundationEncoderAfterWarmup({
            [&]() { events.emplace_back("release-warmed"); },
            [&]() {
                events.emplace_back("shutdown-failed");
                return false;
            },
            [&]() {
                events.emplace_back("activate-fresh");
                ++activationCount;
                return true;
            },
            [&]() {
                events.emplace_back("configure-fresh");
                return true;
            },
            [&]() {
                events.emplace_back("clear-identity");
                sourceIdentities.clear();
            },
        });
    QVERIFY2(!failedShutdownWasAccepted,
             "A failed IMFActivate::ShutdownObject must fail closed");
    QCOMPARE(activationCount, 1);
    QCOMPARE(events, std::vector<std::string>({"release-warmed", "shutdown-failed"}));

    events.clear();
    activationCount = 1;
    sourceIdentities = {-777};
    const bool freshReady =
        versus::video::detail::prepareFreshMediaFoundationEncoderAfterWarmup({
            [&]() { events.emplace_back("release-warmed"); },
            [&]() {
                events.emplace_back("shutdown-ok");
                return true;
            },
            [&]() {
                events.emplace_back("activate-fresh");
                ++activationCount;
                return true;
            },
            [&]() {
                events.emplace_back("configure-fresh");
                return true;
            },
            [&]() {
                events.emplace_back("clear-identity");
                sourceIdentities.clear();
            },
        });
    QVERIFY(freshReady);
    QCOMPARE(activationCount, 2);
    QVERIFY(sourceIdentities.empty());
    QCOMPARE(events,
             std::vector<std::string>({
                 "release-warmed",
                 "shutdown-ok",
                 "activate-fresh",
                 "configure-fresh",
                 "clear-identity",
             }));
}

void TestAlphaFramePairer::testH264AccessUnitKeyframeTruthAndAlphaStartup() {
    using versus::video::detail::H264BitstreamFormat;
    using versus::video::detail::h264AccessUnitIsKeyframe;

    const std::vector<uint8_t> annexBSpsPps = {
        0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f,
        0, 0, 1, 0x68, 0xee, 0x3c, 0x80,
    };
    const std::vector<uint8_t> annexBSpsAndDelta = {
        0, 0, 1, 0x67, 0x64,
        0, 0, 0, 1, 0x41, 0x9a,
    };
    const std::vector<uint8_t> annexBIdr3 = {0, 0, 1, 0x65, 0x88};
    const std::vector<uint8_t> annexBIdr4 = {0, 0, 0, 1, 0x65, 0x99};
    const std::vector<uint8_t> avccSpsAndDelta = {
        0, 0, 0, 2, 0x67, 0x64,
        0, 0, 0, 2, 0x41, 0x9a,
    };
    const std::vector<uint8_t> avccIdr = {0, 0, 0, 2, 0x65, 0x88};
    std::vector<uint8_t> avccLongDelta(4 + 261, 0);
    avccLongDelta[0] = 0;
    avccLongDelta[1] = 0;
    avccLongDelta[2] = 1;
    avccLongDelta[3] = 5;  // 261-byte length, not an Annex-B start code + IDR.
    avccLongDelta[4] = 0x41;

    QVERIFY2(!h264AccessUnitIsKeyframe(annexBSpsPps, H264BitstreamFormat::AnnexB),
             "SPS/PPS-only configuration is not an H.264 random-access picture");
    QVERIFY(!h264AccessUnitIsKeyframe(annexBSpsAndDelta));
    QVERIFY(h264AccessUnitIsKeyframe(annexBIdr3));
    QVERIFY(h264AccessUnitIsKeyframe(annexBIdr4));
    QVERIFY(!h264AccessUnitIsKeyframe(avccSpsAndDelta, H264BitstreamFormat::Avcc));
    QVERIFY(h264AccessUnitIsKeyframe(avccIdr, H264BitstreamFormat::Avcc));
    QVERIFY2(!h264AccessUnitIsKeyframe(avccLongDelta),
             "A long AVCC delta NAL length must not impersonate an Annex-B IDR header");

    versus::app::ExactAlphaFramePair pair;
    pair.primary = makePacket(6100, 21, 0x61, false);
    pair.primary.packet.codec = versus::video::VideoCodec::H264;
    pair.primary.packet.data = annexBSpsAndDelta;
    pair.primary.packet.isKeyframe = h264AccessUnitIsKeyframe(pair.primary.packet.data);
    pair.alpha = makePacket(6100, 21, 0xA6, true);
    pair.transportPts = 6100;
    QVERIFY(versus::app::isExactAlphaFramePair(pair));
    QVERIFY2(!versus::app::canStartAlphaTransportWithPair(pair),
             "SPS followed by a delta picture cannot start an alpha transport");

    pair.primary.packet.data = annexBIdr4;
    pair.primary.packet.isKeyframe = h264AccessUnitIsKeyframe(pair.primary.packet.data);
    QVERIFY(versus::app::canStartAlphaTransportWithPair(pair));

    bool waitingForKeyframe = false;
    pair.primary.packet.data = annexBSpsAndDelta;
    pair.primary.packet.isKeyframe = h264AccessUnitIsKeyframe(pair.primary.packet.data);
    QVERIFY2(versus::app::satisfiesProtectedAlphaKeyframeContract(pair),
             "Ordinary H.264 delta pictures remain valid after startup");
    std::recursive_mutex operationMutex;
    const auto dispatched = versus::app::dispatchExactAlphaFramePair(
        pair,
        operationMutex,
        [&]() {
            return !waitingForKeyframe ||
                versus::app::canStartAlphaTransportWithPair(pair);
        },
        [](const versus::video::EncodedPacket &) { return true; },
        [](const versus::video::EncodedPacket &) { return true; });
    QVERIFY(dispatched.primarySent);
}

void TestAlphaFramePairer::testExternalSourceIdentityQueueIsBoundedAndFifo() {
    versus::video::detail::BoundedSourceTimestampQueue queue(3);
    QCOMPARE(queue.capacity(), std::size_t{3});
    QVERIFY(queue.tryPush(0));
    QVERIFY(queue.tryPush(17));
    QVERIFY(queue.tryPush(-4));
    QVERIFY2(!queue.tryPush(99),
             "A stalled FFmpeg output path accepted an unbounded source identity");
    QCOMPARE(queue.size(), std::size_t{3});

    int64_t timestamp = 123;
    QVERIFY(queue.tryPop(timestamp));
    QCOMPARE(timestamp, int64_t{0});
    QVERIFY(queue.tryPop(timestamp));
    QCOMPARE(timestamp, int64_t{17});
    QVERIFY(queue.tryPop(timestamp));
    QCOMPARE(timestamp, int64_t{-4});
    QVERIFY(!queue.tryPop(timestamp));

    QVERIFY(queue.tryPush(std::numeric_limits<int64_t>::max()));
    queue.clear();
    QCOMPARE(queue.size(), std::size_t{0});
}

void TestAlphaFramePairer::testProtectedKeyframeGuaranteeUsesLiveRuntimeState() {
    using versus::video::VideoCodec;
    const auto healthy = [](bool initialized,
                            bool required,
                            VideoCodec codec,
                            const std::string &encoder,
                            bool packetHealthy) {
        return versus::video::detail::protectedVp9RuntimeContractHealthy(
            initialized,
            required,
            codec,
            encoder,
            packetHealthy);
    };

    QVERIFY(healthy(true, true, VideoCodec::VP9, "FFmpeg libvpx-vp9", true));
    QVERIFY(!healthy(false, true, VideoCodec::VP9, "FFmpeg libvpx-vp9", true));
    QVERIFY(!healthy(true, false, VideoCodec::VP9, "FFmpeg libvpx-vp9", true));
    QVERIFY2(!healthy(true, true, VideoCodec::H264, "FFmpeg libvpx-vp9", true),
             "Configured VP9 intent must not hide a wrong live codec");
    QVERIFY2(!healthy(true, true, VideoCodec::VP9, "FFmpeg vp9_qsv", true),
             "A live encoder without the protected libvpx contract must fail closed");
    QVERIFY2(!healthy(true, true, VideoCodec::VP9, "FFmpeg libvpx-vp9", false),
             "An observed protected-packet violation must make the runtime contract unhealthy");
}

void TestAlphaFramePairer::testVp9PayloadKeyframeDetectionIsTruthful() {
    const std::vector<uint8_t> keyframe = {0x82, 0x49, 0x83, 0x42};
    const std::vector<uint8_t> deltaFrame = {0x86, 0x49, 0x83, 0x42};
    const std::vector<uint8_t> showExistingFrame = {0x88};
    const std::vector<uint8_t> invalidSync = {0x82, 0x49, 0x83, 0x43};

    QVERIFY(versus::video::detail::vp9FrameIsKeyframe(keyframe));
    QVERIFY(!versus::video::detail::vp9FrameIsKeyframe(deltaFrame));
    QVERIFY(!versus::video::detail::vp9FrameIsKeyframe(showExistingFrame));
    QVERIFY(!versus::video::detail::vp9FrameIsKeyframe(invalidSync));
    QVERIFY(versus::video::detail::ivfFrameIsKeyframe(
        versus::video::VideoCodec::VP9,
        keyframe));
    QVERIFY(!versus::video::detail::ivfFrameIsKeyframe(
        versus::video::VideoCodec::VP9,
        deltaFrame));

    versus::app::ExactAlphaFramePair parsedPair;
    parsedPair.primary = makePacket(7000, 5, 0x61, true);
    parsedPair.alpha = makePacket(7000, 5, 0xA6, true);
    parsedPair.primary.packet.isKeyframe =
        versus::video::detail::vp9FrameIsKeyframe(deltaFrame);
    parsedPair.alpha.packet.isKeyframe =
        versus::video::detail::vp9FrameIsKeyframe(keyframe);
    parsedPair.transportPts = 7000;
    QVERIFY(versus::app::isExactAlphaFramePair(parsedPair));
    QVERIFY(!versus::app::satisfiesProtectedAlphaKeyframeContract(parsedPair));
    QVERIFY(!versus::app::canStartAlphaTransportWithPair(parsedPair));

    parsedPair.primary.packet.codec = versus::video::VideoCodec::H264;
    QVERIFY(versus::app::satisfiesProtectedAlphaKeyframeContract(parsedPair));
    QVERIFY(!versus::app::canStartAlphaTransportWithPair(parsedPair));
}

void TestAlphaFramePairer::testProtectedAlphaContractReturnsStructuredRejections() {
    using Rejection = versus::app::ProtectedAlphaContractRejection;
    versus::app::ExactAlphaFramePair pair;
    pair.primary = makePacket(8000, 9, 0x61, true);
    pair.alpha = makePacket(8000, 9, 0xA6, true);
    pair.transportPts = 8000;

    QVERIFY(versus::app::validateProtectedAlphaKeyframeContract(pair).valid());

    pair.primary.packet.isKeyframe = false;
    QCOMPARE(versus::app::validateProtectedAlphaKeyframeContract(pair).rejection,
             Rejection::PrimaryVp9NotKeyframe);

    pair.primary.packet.codec = versus::video::VideoCodec::H264;
    QVERIFY2(versus::app::validateProtectedAlphaKeyframeContract(pair).valid(),
             "H.264 primary delta + VP9 alpha keyframe is a valid protected pair");

    pair.alpha.packet.isKeyframe = false;
    QCOMPARE(versus::app::validateProtectedAlphaKeyframeContract(pair).rejection,
             Rejection::AlphaNotKeyframe);

    pair.alpha.packet.isKeyframe = true;
    pair.alpha.packet.codec = versus::video::VideoCodec::H264;
    QCOMPARE(versus::app::validateProtectedAlphaKeyframeContract(pair).rejection,
             Rejection::AlphaCodecNotVp9);

    pair.alpha.packet.codec = versus::video::VideoCodec::VP9;
    pair.primary.packet.codec = versus::video::VideoCodec::AV1;
    QCOMPARE(versus::app::validateProtectedAlphaKeyframeContract(pair).rejection,
             Rejection::PrimaryCodecUnsupported);

    pair.primary.packet.codec = versus::video::VideoCodec::VP9;
    pair.primary.packet.isKeyframe = true;
    pair.alpha.packet.sourceTimestamp += 1;
    QCOMPARE(versus::app::validateProtectedAlphaKeyframeContract(pair).rejection,
             Rejection::PairIdentityInvalid);
}

void TestAlphaFramePairer::testPairLevelContractRecoveryIsOnceAndCooldownBounded() {
    using Rejection = versus::app::ProtectedAlphaContractRejection;
    versus::app::AlphaContractRecoveryController recovery(500);
    versus::app::ExactAlphaFramePair badPair;
    badPair.primary = makePacket(9000, 10, 0x61, false);
    badPair.alpha = makePacket(9000, 10, 0xA6, true);
    badPair.transportPts = 9000;

    int alphaSends = 0;
    int primarySends = 0;
    const auto first = recovery.observe(badPair, 1000);
    QVERIFY(!first.validation.valid());
    QCOMPARE(first.validation.rejection, Rejection::PrimaryVp9NotKeyframe);
    QVERIFY(first.recoveryScheduled);

    // App preflight happens once before the peer loop. Invalid pairs dispatch
    // to zero peers and the controller counter cannot multiply by viewer count.
    for (int peer = 0; peer < 4; ++peer) {
        if (first.validation.valid()) {
            ++alphaSends;
            ++primarySends;
        }
    }
    QCOMPARE(alphaSends, 0);
    QCOMPARE(primarySends, 0);
    QCOMPARE(recovery.rejectedPairCount(), uint64_t{1});

    QVERIFY(!recovery.observe(badPair, 1100).recoveryScheduled);
    QVERIFY(!recovery.observe(badPair, 1499).recoveryScheduled);
    QVERIFY(recovery.observe(badPair, 1500).recoveryScheduled);
    QCOMPARE(recovery.rejectedPairCount(), uint64_t{4});
    QCOMPARE(recovery.recoveryAttemptCount(), uint64_t{2});
    QVERIFY(recovery.recoveryActive());

    versus::app::ExactAlphaFramePair validPair;
    validPair.primary = makePacket(9500, 10, 0x62, true);
    validPair.alpha = makePacket(9500, 10, 0xA7, true);
    validPair.transportPts = 9500;
    const auto valid = recovery.observe(validPair, 1510);
    QVERIFY(valid.validation.valid());
    QVERIFY(valid.recovered);
    QVERIFY(!recovery.recoveryActive());
    QCOMPARE(recovery.recoverySuccessCount(), uint64_t{1});

    std::recursive_mutex operationMutex;
    std::vector<std::string> sendOrder;
    const auto sent = versus::app::dispatchExactAlphaFramePair(
        validPair,
        operationMutex,
        []() { return true; },
        [&](const versus::video::EncodedPacket &) {
            sendOrder.emplace_back("alpha");
            return true;
        },
        [&](const versus::video::EncodedPacket &) {
            sendOrder.emplace_back("primary");
            return true;
        });
    QVERIFY(sent.alphaSent && sent.primarySent);
    QCOMPARE(sendOrder, std::vector<std::string>({"alpha", "primary"}));
}

void TestAlphaFramePairer::testAlphaFailureSuppressesPrimary() {
    versus::app::ExactAlphaFramePair pair;
    pair.primary = makePacket(900, 15, 0x51);
    pair.alpha = makePacket(900, 15, 0xA5);
    pair.transportPts = 900;
    std::recursive_mutex operationMutex;
    int primaryCalls = 0;

    const auto result = versus::app::dispatchExactAlphaFramePair(
        pair,
        operationMutex,
        []() { return true; },
        [](const versus::video::EncodedPacket &) { return false; },
        [&primaryCalls](const versus::video::EncodedPacket &) {
            ++primaryCalls;
            return true;
        });
    QVERIFY(result.admitted);
    QVERIFY(!result.alphaSent);
    QVERIFY(!result.primarySent);
    QCOMPARE(primaryCalls, 0);
}

void TestAlphaFramePairer::testDispatchIsAlphaFirstAndAtomicAgainstReset() {
    using namespace std::chrono_literals;
    versus::app::ExactAlphaFramePair pair;
    pair.primary = makePacket(1000, 16, 0x61);
    pair.alpha = makePacket(1000, 16, 0xA6);
    pair.transportPts = 1000;

    std::recursive_mutex operationMutex;
    std::mutex stateMutex;
    std::condition_variable stateCv;
    bool alphaEntered = false;
    bool releaseAlpha = false;
    std::atomic<bool> resetAttempted{false};
    std::atomic<bool> resetAcquired{false};
    std::vector<std::string> order;
    versus::app::ExactAlphaDispatchResult result;

    std::thread dispatchThread([&]() {
        result = versus::app::dispatchExactAlphaFramePair(
            pair,
            operationMutex,
            []() { return true; },
            [&](const versus::video::EncodedPacket &) {
                std::unique_lock<std::mutex> lock(stateMutex);
                order.emplace_back("alpha");
                alphaEntered = true;
                stateCv.notify_all();
                return stateCv.wait_for(lock, 2s, [&]() { return releaseAlpha; });
            },
            [&](const versus::video::EncodedPacket &) {
                std::lock_guard<std::mutex> lock(stateMutex);
                order.emplace_back("primary");
                return true;
            });
    });

    {
        std::unique_lock<std::mutex> lock(stateMutex);
        stateCv.wait_for(lock, 2s, [&]() { return alphaEntered; });
    }
    std::thread resetThread([&]() {
        resetAttempted.store(true, std::memory_order_release);
        stateCv.notify_all();
        std::lock_guard<std::recursive_mutex> resetLock(operationMutex);
        resetAcquired.store(true, std::memory_order_release);
        std::lock_guard<std::mutex> lock(stateMutex);
        order.emplace_back("reset");
    });

    {
        std::unique_lock<std::mutex> lock(stateMutex);
        stateCv.wait_for(lock, 2s, [&]() { return resetAttempted.load(std::memory_order_acquire); });
    }
    const bool resetSplitThePair = resetAcquired.load(std::memory_order_acquire);
    {
        std::lock_guard<std::mutex> lock(stateMutex);
        releaseAlpha = true;
    }
    stateCv.notify_all();
    dispatchThread.join();
    resetThread.join();

    QVERIFY(!resetSplitThePair);
    QVERIFY(result.alphaSent);
    QVERIFY(result.primarySent);
    QCOMPARE(order.size(), std::size_t{3});
    QCOMPARE(order[0], std::string("alpha"));
    QCOMPARE(order[1], std::string("primary"));
    QCOMPARE(order[2], std::string("reset"));
}

QTEST_MAIN(TestAlphaFramePairer)
#include "test_alpha_frame_pairer.moc"
