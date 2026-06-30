#include <QtTest/QtTest>

#include "versus/webrtc/webrtc_client.h"

class TestWebRtcClient : public QObject {
    Q_OBJECT

  private slots:
    void testRemoteCandidateQueuesBeforeRemoteDescription();
};

void TestWebRtcClient::testRemoteCandidateQueuesBeforeRemoteDescription() {
    versus::webrtc::WebRtcClient client;
    versus::webrtc::PeerConfig config;
    config.enableDataChannel = true;

    QVERIFY(client.initialize(config));
    QVERIFY(client.addRemoteCandidate(
        "candidate:1 1 UDP 2113937151 192.0.2.10 50000 typ host",
        "0",
        0));

    client.shutdown();
}

QTEST_MAIN(TestWebRtcClient)
#include "test_webrtc_client.moc"
