#include <QtTest/QtTest>

#include "versus/app/encoder_recovery_policy.h"
#include "versus/app/remote_control_policy.h"

class TestRuntimeRecoveryPolicy : public QObject {
    Q_OBJECT

  private slots:
    void testTemporarySoftwareEncoderPressureRemainsRetryable();
    void testBoundedOutputStallFallsBackImmediately();
    void testHardSoftwareEncoderFailuresUseCountedRecovery();
    void testCapturePipelineAllowsBoundedFramesBehindEncoder();
    void testEncoderWaitsForFreshFramesInsteadOfTimerTicks();
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

void TestRuntimeRecoveryPolicy::testCapturePipelineAllowsBoundedFramesBehindEncoder() {
    using versus::app::shouldAdmitCapturedFrame;

    QVERIFY(shouldAdmitCapturedFrame(false, false, 2, 2));
    QVERIFY(shouldAdmitCapturedFrame(true, true, 0, 2));
    QVERIFY(shouldAdmitCapturedFrame(true, true, 1, 2));
    QVERIFY(!shouldAdmitCapturedFrame(true, true, 2, 2));
    QVERIFY(!shouldAdmitCapturedFrame(true, false, 0, 2));
}

void TestRuntimeRecoveryPolicy::testEncoderWaitsForFreshFramesInsteadOfTimerTicks() {
    using versus::app::freshFrameWaitComplete;

    QVERIFY(!freshFrameWaitComplete(true, false));
    QVERIFY(freshFrameWaitComplete(true, true));
    QVERIFY(freshFrameWaitComplete(false, false));
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
