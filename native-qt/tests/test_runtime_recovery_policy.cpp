#include <QtTest/QtTest>

#include "versus/app/encoder_recovery_policy.h"
#include "versus/app/remote_control_policy.h"

class TestRuntimeRecoveryPolicy : public QObject {
    Q_OBJECT

  private slots:
    void testTemporarySoftwareEncoderPressureRemainsRetryable();
    void testBoundedOutputStallFallsBackImmediately();
    void testHardSoftwareEncoderFailuresUseCountedRecovery();
    void testCapturePipelineAllowsOneFrameToWaitBehindEncoder();
    void testOutputPacerTargetsSixtyFpsWithoutCatchupBursts();
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

void TestRuntimeRecoveryPolicy::testCapturePipelineAllowsOneFrameToWaitBehindEncoder() {
    using versus::app::shouldAdmitCapturedFrame;

    QVERIFY(shouldAdmitCapturedFrame(false, false, false, false));
    QVERIFY(shouldAdmitCapturedFrame(true, true, false, true));
    QVERIFY(!shouldAdmitCapturedFrame(true, true, true, true));
    QVERIFY(shouldAdmitCapturedFrame(true, true, true, false));
    QVERIFY(!shouldAdmitCapturedFrame(true, false, false, false));
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
