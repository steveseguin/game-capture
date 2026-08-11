#include <QtTest/QtTest>

#include "versus/app/keyframe_request_policy.h"

class TestKeyframeRequestPolicy : public QObject {
    Q_OBJECT

  private slots:
    void dispatchEncoderRequest_data();
    void dispatchEncoderRequest();
    void rearmAfterPacket_data();
    void rearmAfterPacket();
    void rearmAfterEncodeFailure_data();
    void rearmAfterEncodeFailure();
};

void TestKeyframeRequestPolicy::dispatchEncoderRequest_data() {
    QTest::addColumn<bool>("requested");
    QTest::addColumn<bool>("externalEncoder");
    QTest::addColumn<bool>("guaranteesEveryFrameKeyframe");
    QTest::addColumn<bool>("expected");

    for (int requested = 0; requested <= 1; ++requested) {
        for (int external = 0; external <= 1; ++external) {
            for (int guaranteed = 0; guaranteed <= 1; ++guaranteed) {
                const bool expected = requested && !external && !guaranteed;
                const QByteArray row = QByteArray("requested=") + QByteArray::number(requested) +
                    ",external=" + QByteArray::number(external) +
                    ",guaranteed=" + QByteArray::number(guaranteed);
                QTest::newRow(row.constData())
                    << static_cast<bool>(requested)
                    << static_cast<bool>(external)
                    << static_cast<bool>(guaranteed)
                    << expected;
            }
        }
    }
}

void TestKeyframeRequestPolicy::dispatchEncoderRequest() {
    QFETCH(bool, requested);
    QFETCH(bool, externalEncoder);
    QFETCH(bool, guaranteesEveryFrameKeyframe);
    QFETCH(bool, expected);

    QCOMPARE(
        versus::app::keyframe_policy::shouldDispatchEncoderRequest(
            requested,
            externalEncoder,
            guaranteesEveryFrameKeyframe),
        expected);
}

void TestKeyframeRequestPolicy::rearmAfterPacket_data() {
    QTest::addColumn<bool>("requested");
    QTest::addColumn<bool>("packetIsKeyframe");
    QTest::addColumn<bool>("externalEncoder");
    QTest::addColumn<bool>("expected");

    for (int requested = 0; requested <= 1; ++requested) {
        for (int keyframe = 0; keyframe <= 1; ++keyframe) {
            for (int external = 0; external <= 1; ++external) {
                const bool expected = requested && !keyframe && !external;
                const QByteArray row = QByteArray("requested=") + QByteArray::number(requested) +
                    ",keyframe=" + QByteArray::number(keyframe) +
                    ",external=" + QByteArray::number(external);
                QTest::newRow(row.constData())
                    << static_cast<bool>(requested)
                    << static_cast<bool>(keyframe)
                    << static_cast<bool>(external)
                    << expected;
            }
        }
    }
}

void TestKeyframeRequestPolicy::rearmAfterPacket() {
    QFETCH(bool, requested);
    QFETCH(bool, packetIsKeyframe);
    QFETCH(bool, externalEncoder);
    QFETCH(bool, expected);

    QCOMPARE(
        versus::app::keyframe_policy::shouldRearmAfterPacket(
            requested,
            packetIsKeyframe,
            externalEncoder),
        expected);
}

void TestKeyframeRequestPolicy::rearmAfterEncodeFailure_data() {
    QTest::addColumn<bool>("requested");
    QTest::addColumn<bool>("externalEncoder");
    QTest::addColumn<bool>("expected");

    for (int requested = 0; requested <= 1; ++requested) {
        for (int external = 0; external <= 1; ++external) {
            const bool expected = requested && !external;
            const QByteArray row = QByteArray("requested=") + QByteArray::number(requested) +
                ",external=" + QByteArray::number(external);
            QTest::newRow(row.constData())
                << static_cast<bool>(requested)
                << static_cast<bool>(external)
                << expected;
        }
    }
}

void TestKeyframeRequestPolicy::rearmAfterEncodeFailure() {
    QFETCH(bool, requested);
    QFETCH(bool, externalEncoder);
    QFETCH(bool, expected);

    QCOMPARE(
        versus::app::keyframe_policy::shouldRearmAfterEncodeFailure(
            requested,
            externalEncoder),
        expected);
}

QTEST_MAIN(TestKeyframeRequestPolicy)
#include "test_keyframe_request_policy.moc"
