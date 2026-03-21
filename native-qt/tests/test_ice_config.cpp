#include <QtTest/QtTest>

#include "versus/webrtc/ice_config.h"

class TestIceConfig : public QObject {
    Q_OBJECT

  private slots:
    void testResolveIceConfigIncludesDefaultStunServers();
    void testResolveIceConfigHostOnlyUsesNoServers();
    void testResolveIceConfigLimitsTurnSelection();
    void testFilterSessionDescriptionForHostOnly();
    void testFilterSessionDescriptionForStunOnly();
    void testCandidateAllowedForMode();
};

void TestIceConfig::testResolveIceConfigIncludesDefaultStunServers() {
    const auto resolved = versus::webrtc::resolveIceConfig(versus::webrtc::IceMode::All, 1);
    QVERIFY(resolved.servers.size() >= 2);
    QCOMPARE(QString::fromStdString(resolved.servers[0].url),
             QString("stun:stun.l.google.com:19302"));
    QCOMPARE(QString::fromStdString(resolved.servers[1].url),
             QString("stun:stun.cloudflare.com:3478"));
}

void TestIceConfig::testResolveIceConfigHostOnlyUsesNoServers() {
    const auto resolved = versus::webrtc::resolveIceConfig(versus::webrtc::IceMode::HostOnly, 1);
    QVERIFY(resolved.servers.empty());
    QVERIFY(!resolved.fetchedTurnList);
    QVERIFY(!resolved.usedFallbackTurnList);
}

void TestIceConfig::testResolveIceConfigLimitsTurnSelection() {
    const auto resolved = versus::webrtc::resolveIceConfig(versus::webrtc::IceMode::Relay, 1);

    int turnCount = 0;
    int udpTurns = 0;
    int tcpTurns = 0;
    for (const auto &server : resolved.servers) {
        const QString url = QString::fromStdString(server.url).toLower();
        if (!url.startsWith("turn:") && !url.startsWith("turns:")) {
            continue;
        }
        ++turnCount;
        if (server.udp) {
            ++udpTurns;
        } else {
            ++tcpTurns;
        }
    }

    QVERIFY(turnCount >= 1);
    QVERIFY(turnCount <= 3);
    QVERIFY(udpTurns <= 2);
    QVERIFY(tcpTurns <= 1);
}

void TestIceConfig::testFilterSessionDescriptionForHostOnly() {
    const std::string input =
        "v=0\r\n"
        "m=video 50596 UDP/TLS/RTP/SAVPF 96\r\n"
        "c=IN IP4 10.0.0.9\r\n"
        "a=candidate:1 1 UDP 2114977535 10.0.0.9 50596 typ host\r\n"
        "a=candidate:2 1 UDP 1678769151 99.246.137.16 50596 typ srflx raddr 0.0.0.0 rport 0\r\n"
        "a=candidate:3 1 UDP 12345 55.66.77.88 3478 typ relay raddr 0.0.0.0 rport 0\r\n";

    const std::string filtered =
        versus::webrtc::filterSessionDescriptionForMode(input, versus::webrtc::IceMode::HostOnly);

    QVERIFY(filtered.find(" typ srflx") == std::string::npos);
    QVERIFY(filtered.find(" typ relay") == std::string::npos);
    QVERIFY(filtered.find("10.0.0.9") != std::string::npos);
    QVERIFY(filtered.find("c=IN IP4 10.0.0.9") != std::string::npos);
}

void TestIceConfig::testFilterSessionDescriptionForStunOnly() {
    const std::string input =
        "v=0\r\n"
        "m=video 50596 UDP/TLS/RTP/SAVPF 96\r\n"
        "c=IN IP4 10.0.0.9\r\n"
        "a=candidate:1 1 UDP 2114977535 10.0.0.9 50596 typ host\r\n"
        "a=candidate:2 1 UDP 1678769151 99.246.137.16 50596 typ srflx raddr 0.0.0.0 rport 0\r\n"
        "a=candidate:3 1 UDP 12345 55.66.77.88 3478 typ relay raddr 0.0.0.0 rport 0\r\n";

    const std::string filtered =
        versus::webrtc::filterSessionDescriptionForMode(input, versus::webrtc::IceMode::StunOnly);

    QVERIFY(filtered.find(" typ host") == std::string::npos);
    QVERIFY(filtered.find(" typ relay") == std::string::npos);
    QVERIFY(filtered.find("99.246.137.16") != std::string::npos);
    QVERIFY(filtered.find("c=IN IP4 99.246.137.16") != std::string::npos);
}

void TestIceConfig::testCandidateAllowedForMode() {
    const std::string hostCandidate =
        "candidate:1 1 UDP 2114977535 10.0.0.9 50596 typ host";
    const std::string stunCandidate =
        "candidate:2 1 UDP 1678769151 99.246.137.16 50596 typ srflx raddr 0.0.0.0 rport 0";
    const std::string relayCandidate =
        "candidate:3 1 UDP 12345 55.66.77.88 3478 typ relay raddr 0.0.0.0 rport 0";

    QVERIFY(versus::webrtc::candidateAllowedForMode(hostCandidate, versus::webrtc::IceMode::HostOnly));
    QVERIFY(!versus::webrtc::candidateAllowedForMode(stunCandidate, versus::webrtc::IceMode::HostOnly));
    QVERIFY(!versus::webrtc::candidateAllowedForMode(relayCandidate, versus::webrtc::IceMode::HostOnly));

    QVERIFY(!versus::webrtc::candidateAllowedForMode(hostCandidate, versus::webrtc::IceMode::StunOnly));
    QVERIFY(versus::webrtc::candidateAllowedForMode(stunCandidate, versus::webrtc::IceMode::StunOnly));
    QVERIFY(!versus::webrtc::candidateAllowedForMode(relayCandidate, versus::webrtc::IceMode::StunOnly));

    QVERIFY(!versus::webrtc::candidateAllowedForMode(hostCandidate, versus::webrtc::IceMode::Relay));
    QVERIFY(!versus::webrtc::candidateAllowedForMode(stunCandidate, versus::webrtc::IceMode::Relay));
    QVERIFY(versus::webrtc::candidateAllowedForMode(relayCandidate, versus::webrtc::IceMode::Relay));
}

QTEST_MAIN(TestIceConfig)
#include "test_ice_config.moc"
