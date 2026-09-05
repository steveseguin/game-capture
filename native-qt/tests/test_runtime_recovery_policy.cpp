#include <QtTest/QtTest>

#include "versus/app/encoder_recovery_policy.h"
#include "versus/app/remote_control_policy.h"

class TestRuntimeRecoveryPolicy : public QObject {
    Q_OBJECT

  private slots:
    void testTemporarySoftwareEncoderPressureRemainsRetryable();
    void testBoundedOutputStallFallsBackImmediately();
    void testHardSoftwareEncoderFailuresUseCountedRecovery();
    void testOutputPacerTargetsSixtyFpsWithoutCatchupBursts();
    void testOutputPacerToleratesEncodeJitterButSkipsLongStalls();
    void testAnonymousViewerResolutionHintIsSilent();
    void testExplicitResolutionControlGetsAuthorizationFeedback();
};

void TestRuntimeRecoveryPolicy::testTemporarySoftwareEncoderPressureRemainsRetryable() {
    using versus::app::SoftwareEncoderFailureDisposition;
    using versus::app::classifySoftwareEncoderFailure;
    using versus::video::EncodeFailureKind;

    QCOMPARE(
        classifySoftwareEncoderFailure(EncodeFailureKind::Timeout),
        SoftwareEncoderFailureDisposition::Transient);
    QCOMPARE(
        classifySoftwareEncoderFailure(EncodeFailureKind::Backpressure),
        SoftwareEncoderFailureDisposition::Transient);
}

void TestRuntimeRecoveryPolicy::testBoundedOutputStallFallsBackImmediately() {
    QCOMPARE(
        versus::app::classifySoftwareEncoderFailure(
            versus::video::EncodeFailureKind::OutputStalled),
        versus::app::SoftwareEncoderFailureDisposition::ImmediateFallback);
}

void TestRuntimeRecoveryPolicy::testHardSoftwareEncoderFailuresUseCountedRecovery() {
    using versus::app::SoftwareEncoderFailureDisposition;
    using versus::app::classifySoftwareEncoderFailure;
    using versus::video::EncodeFailureKind;

    QCOMPARE(
        classifySoftwareEncoderFailure(EncodeFailureKind::ProcessExited),
        SoftwareEncoderFailureDisposition::CountedFailure);
    QCOMPARE(
        classifySoftwareEncoderFailure(EncodeFailureKind::IoFailure),
        SoftwareEncoderFailureDisposition::CountedFailure);
    QCOMPARE(
        classifySoftwareEncoderFailure(EncodeFailureKind::InvalidInput),
        SoftwareEncoderFailureDisposition::CountedFailure);
}

void TestRuntimeRecoveryPolicy::testOutputPacerTargetsSixtyFpsWithoutCatchupBursts() {
    using Clock = std::chrono::steady_clock;
    using versus::app::advanceOutputFrameDeadline;
    using versus::app::outputFrameInterval;
    using versus::app::outputFrameTimestamp100ns;

    const auto interval = outputFrameInterval(60);
    QCOMPARE(interval.count(), int64_t{16666666});

    const Clock::time_point first{};
    const auto second = advanceOutputFrameDeadline(first, first, interval);
    QCOMPARE(second - first, interval);
    QCOMPARE(outputFrameTimestamp100ns(second) - outputFrameTimestamp100ns(first),
             int64_t{166666});

    const auto delayedNow = first + (interval * 3) + std::chrono::milliseconds(1);
    const auto afterDelay = advanceOutputFrameDeadline(second, delayedNow, interval);
    QVERIFY(afterDelay > delayedNow);
    QVERIFY(afterDelay <= delayedNow + interval);
}

void TestRuntimeRecoveryPolicy::testOutputPacerToleratesEncodeJitterButSkipsLongStalls() {
    using Clock = std::chrono::steady_clock;
    using versus::app::outputFrameDeadlineAfterEncode;
    const auto interval = versus::app::outputFrameInterval(60);
    const Clock::time_point start{};

    QCOMPARE(outputFrameDeadlineAfterEncode(start, start + std::chrono::milliseconds(17), interval),
             start + interval);
    const auto stalled = start + std::chrono::milliseconds(800);
    const auto recovered = outputFrameDeadlineAfterEncode(start, stalled, interval);
    QVERIFY(recovered > stalled);
    QVERIFY(recovered <= stalled + interval);

    auto due = start;
    auto now = start;
    for (int i = 0; i < 600; ++i) {
        now = std::max(now, due) + std::chrono::milliseconds(17);
        due = outputFrameDeadlineAfterEncode(due, now, interval);
    }
    // 17-ms work cannot reach 60 FPS, but skipping every overrun would reduce
    // it to 30 FPS. Bounded recovery should stay close to its actual capacity.
    QVERIFY(now - start < std::chrono::seconds(11));
    QVERIFY(now - start >= std::chrono::milliseconds(10200));
}

void TestRuntimeRecoveryPolicy::testAnonymousViewerResolutionHintIsSilent() {
    QVERIFY(!versus::app::shouldReportUnauthorizedResolutionControl(false, false));
}

void TestRuntimeRecoveryPolicy::testExplicitResolutionControlGetsAuthorizationFeedback() {
    QVERIFY(versus::app::shouldReportUnauthorizedResolutionControl(true, false));
    QVERIFY(versus::app::shouldReportUnauthorizedResolutionControl(false, true));
    QVERIFY(versus::app::shouldReportUnauthorizedResolutionControl(true, true));
}

QTEST_MAIN(TestRuntimeRecoveryPolicy)
#include "test_runtime_recovery_policy.moc"
