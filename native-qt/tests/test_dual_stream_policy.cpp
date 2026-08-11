#include <QtTest/QtTest>

#include "versus/app/dual_stream_policy.h"

class TestDualStreamPolicy : public QObject {
    Q_OBJECT

  private slots:
    void testParsePeerRole();
    void testRoomQualityDecision();
    void testAssignStreamTier();
    void testEffectiveTierNeverMixesLqH264IntoAnotherCodec();
    void testHqPolicyTierCannotBeDemotedByPeerBitrate();
    void testCanSendVideoRequiresRoomInit();
    void testCanSendAudioHonorsFlags();
};

void TestDualStreamPolicy::testParsePeerRole() {
    using versus::app::PeerRole;
    using versus::app::parsePeerRole;

    QCOMPARE(parsePeerRole("scene"), PeerRole::Scene);
    QCOMPARE(parsePeerRole("DIRECTOR"), PeerRole::Director);
    QCOMPARE(parsePeerRole("Guest"), PeerRole::Guest);
    QCOMPARE(parsePeerRole("viewer"), PeerRole::Viewer);
    QCOMPARE(parsePeerRole(""), PeerRole::Unknown);
    QCOMPARE(parsePeerRole("host"), PeerRole::Unknown);
}

void TestDualStreamPolicy::testRoomQualityDecision() {
    using versus::app::RoomQualityReason;
    using versus::app::resolveRoomQualityDecision;
    using versus::app::roomQualityReasonName;

    const auto enabled = resolveRoomQualityDecision(true, true, true);
    QVERIFY(enabled.requested);
    QVERIFY(enabled.effective);
    QCOMPARE(enabled.reason, RoomQualityReason::Enabled);
    QCOMPARE(QString::fromLatin1(roomQualityReasonName(enabled.reason)), QStringLiteral("enabled"));

    const auto notInRoom = resolveRoomQualityDecision(false, true, true);
    QVERIFY(notInRoom.requested);
    QVERIFY(!notInRoom.effective);
    QCOMPARE(QString::fromLatin1(roomQualityReasonName(notInRoom.reason)), QStringLiteral("not-in-room"));

    const auto notRequested = resolveRoomQualityDecision(true, false, true);
    QVERIFY(!notRequested.requested);
    QVERIFY(!notRequested.effective);
    QCOMPARE(QString::fromLatin1(roomQualityReasonName(notRequested.reason)), QStringLiteral("not-requested"));

    const auto incompatible = resolveRoomQualityDecision(true, true, false);
    QVERIFY(incompatible.requested);
    QVERIFY(!incompatible.effective);
    QCOMPARE(QString::fromLatin1(roomQualityReasonName(incompatible.reason)), QStringLiteral("codec-not-h264"));
}

void TestDualStreamPolicy::testAssignStreamTier() {
    using versus::app::PeerRole;
    using versus::app::StreamTier;
    using versus::app::assignStreamTier;

    QCOMPARE(assignStreamTier(false, true, false, PeerRole::Unknown), StreamTier::HQ);
    QCOMPARE(assignStreamTier(false, true, true, PeerRole::Scene), StreamTier::HQ);
    QCOMPARE(assignStreamTier(true, true, true, PeerRole::Scene), StreamTier::HQ);
    QCOMPARE(assignStreamTier(true, true, true, PeerRole::Director), StreamTier::LQ);
    QCOMPARE(assignStreamTier(true, true, true, PeerRole::Guest), StreamTier::LQ);
    QCOMPARE(assignStreamTier(true, true, true, PeerRole::Viewer), StreamTier::LQ);
    QCOMPARE(assignStreamTier(true, false, true, PeerRole::Director), StreamTier::HQ);
    QCOMPARE(assignStreamTier(true, false, true, PeerRole::Viewer), StreamTier::HQ);
    QCOMPARE(assignStreamTier(true, true, false, PeerRole::Unknown), StreamTier::None);
}

void TestDualStreamPolicy::testEffectiveTierNeverMixesLqH264IntoAnotherCodec() {
    using versus::app::StreamTier;
    using versus::app::selectEffectiveStreamTier;

    QCOMPARE(selectEffectiveStreamTier(StreamTier::HQ, false), StreamTier::HQ);
    QCOMPARE(selectEffectiveStreamTier(StreamTier::LQ, false), StreamTier::LQ);
    QCOMPARE(selectEffectiveStreamTier(StreamTier::LQ, true), StreamTier::HQ);
    QCOMPARE(selectEffectiveStreamTier(StreamTier::None, true), StreamTier::None);
}

void TestDualStreamPolicy::testHqPolicyTierCannotBeDemotedByPeerBitrate() {
    using versus::app::PeerRole;
    using versus::app::StreamTier;
    using versus::app::assignStreamTier;
    using versus::app::selectEffectiveStreamTier;

    const auto effectiveTier = [&](bool roomMode,
                                   bool roomQualityRequested,
                                   PeerRole role) {
        const StreamTier policyTier = assignStreamTier(
            roomMode,
            roomQualityRequested,
            true,
            role);
        return selectEffectiveStreamTier(policyTier, false);
    };

    QCOMPARE(effectiveTier(false, true, PeerRole::Viewer), StreamTier::HQ);
    QCOMPARE(effectiveTier(true, false, PeerRole::Viewer), StreamTier::HQ);
    QCOMPARE(effectiveTier(true, true, PeerRole::Scene), StreamTier::HQ);
    QCOMPARE(effectiveTier(true, true, PeerRole::Viewer), StreamTier::LQ);
}

void TestDualStreamPolicy::testCanSendVideoRequiresRoomInit() {
    using versus::app::PeerRole;
    using versus::app::PeerRouteState;
    using versus::app::canSendVideo;

    PeerRouteState direct;
    direct.roomMode = false;
    direct.roomQualityEffective = false;
    direct.initReceived = false;
    direct.roleValid = false;
    direct.role = PeerRole::Unknown;
    direct.videoEnabled = true;
    QVERIFY(canSendVideo(direct));

    PeerRouteState roomPending;
    roomPending.roomMode = true;
    roomPending.roomQualityEffective = true;
    roomPending.initReceived = false;
    roomPending.roleValid = false;
    roomPending.role = PeerRole::Unknown;
    roomPending.videoEnabled = true;
    QVERIFY(!canSendVideo(roomPending));

    PeerRouteState roomScene = roomPending;
    roomScene.initReceived = true;
    roomScene.roleValid = true;
    roomScene.role = PeerRole::Scene;
    QVERIFY(canSendVideo(roomScene));

    PeerRouteState roomGuestNoVideo = roomScene;
    roomGuestNoVideo.role = PeerRole::Guest;
    roomGuestNoVideo.videoEnabled = false;
    QVERIFY(!canSendVideo(roomGuestNoVideo));
}

void TestDualStreamPolicy::testCanSendAudioHonorsFlags() {
    using versus::app::PeerRole;
    using versus::app::PeerRouteState;
    using versus::app::canSendAudio;

    PeerRouteState roomViewer;
    roomViewer.roomMode = true;
    roomViewer.roomQualityEffective = true;
    roomViewer.initReceived = true;
    roomViewer.roleValid = true;
    roomViewer.role = PeerRole::Viewer;
    roomViewer.audioEnabled = true;
    QVERIFY(canSendAudio(roomViewer));

    roomViewer.audioEnabled = false;
    QVERIFY(!canSendAudio(roomViewer));

    PeerRouteState roomNoInit = roomViewer;
    roomNoInit.audioEnabled = true;
    roomNoInit.initReceived = false;
    QVERIFY(!canSendAudio(roomNoInit));
}

QTEST_MAIN(TestDualStreamPolicy)
#include "test_dual_stream_policy.moc"
