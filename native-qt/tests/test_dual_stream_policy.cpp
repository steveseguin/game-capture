#include <QtTest/QtTest>

#include "versus/app/dual_stream_policy.h"

class TestDualStreamPolicy : public QObject {
    Q_OBJECT

  private slots:
    void testParsePeerRole();
    void testAssignStreamTier();
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

void TestDualStreamPolicy::testAssignStreamTier() {
    using versus::app::PeerRole;
    using versus::app::StreamTier;
    using versus::app::assignStreamTier;

    QCOMPARE(assignStreamTier(false, false, PeerRole::Unknown), StreamTier::HQ);
    QCOMPARE(assignStreamTier(false, true, PeerRole::Scene), StreamTier::HQ);
    QCOMPARE(assignStreamTier(true, true, PeerRole::Scene), StreamTier::HQ);
    QCOMPARE(assignStreamTier(true, true, PeerRole::Director), StreamTier::LQ);
    QCOMPARE(assignStreamTier(true, true, PeerRole::Guest), StreamTier::LQ);
    QCOMPARE(assignStreamTier(true, true, PeerRole::Viewer), StreamTier::LQ);
    QCOMPARE(assignStreamTier(true, false, PeerRole::Unknown), StreamTier::None);
}

void TestDualStreamPolicy::testCanSendVideoRequiresRoomInit() {
    using versus::app::PeerRole;
    using versus::app::PeerRouteState;
    using versus::app::canSendVideo;

    PeerRouteState direct;
    direct.roomMode = false;
    direct.initReceived = false;
    direct.roleValid = false;
    direct.role = PeerRole::Unknown;
    direct.videoEnabled = true;
    QVERIFY(canSendVideo(direct));

    PeerRouteState roomPending;
    roomPending.roomMode = true;
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
