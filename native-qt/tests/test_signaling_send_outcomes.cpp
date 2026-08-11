#include <QtTest/QtTest>

#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "versus/app/versus_app.h"

namespace versus::signaling {

class VdoSignalingTestAccess {
  public:
    static void forceEncryptionFailure(VdoSignaling &signaling, bool forceFailure) {
        signaling.forceEncryptionFailureForTesting(forceFailure);
    }

    static uint64_t outboundSendAttempts(const VdoSignaling &signaling) {
        return signaling.outboundSendAttemptsForTesting();
    }
};

}  // namespace versus::signaling

namespace versus::app {

class VersusAppTestAccess {
  public:
    using OpaquePeer = std::shared_ptr<void>;

    static OpaquePeer createPeer() {
        auto peer = std::make_shared<VersusApp::PeerSession>();
        peer->uuid = "candidate-outcome-peer";
        peer->session = "logical-owner-session";
        peer->activeWireSession = "wire-session";
        peer->streamId = "candidate-outcome-stream";
        return std::static_pointer_cast<void>(peer);
    }

    static signaling::VdoSignaling &signaling(VersusApp &app) {
        return app.signaling_;
    }

    static bool dispatchCandidate(VersusApp &app,
                                  const OpaquePeer &opaque,
                                  const signaling::SignalCandidate &candidate,
                                  bool relayCandidate) {
        const auto peer = cast(opaque);
        if (!peer) {
            return false;
        }
        std::lock_guard<std::mutex> signalingLock(app.signalingOpsMutex_);
        return app.dispatchPeerCandidateToSignaling(peer, candidate, relayCandidate);
    }

    static int sentCount(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer ? peer->localCandidatesSent.load(std::memory_order_relaxed) : -1;
    }

    static int failureCount(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        return peer
            ? peer->localCandidateSendFailures.load(std::memory_order_relaxed)
            : -1;
    }

    static std::vector<std::string> timeline(const OpaquePeer &opaque) {
        const auto peer = cast(opaque);
        if (!peer) {
            return {};
        }
        std::lock_guard<std::mutex> diagnosticsLock(peer->diagnosticsMutex);
        return {peer->timeline.begin(), peer->timeline.end()};
    }

  private:
    static std::shared_ptr<VersusApp::PeerSession> cast(const OpaquePeer &opaque) {
        return std::static_pointer_cast<VersusApp::PeerSession>(opaque);
    }
};

}  // namespace versus::app

class TestSignalingSendOutcomes : public QObject {
    Q_OBJECT

  private slots:
    void testEncryptedCandidateFailureIsNotReportedAsSent();
    void testDisconnectedCandidateFailureIsNotReportedAsSent();
};

void TestSignalingSendOutcomes::testEncryptedCandidateFailureIsNotReportedAsSent() {
    versus::app::VersusApp app;
    const auto peer = versus::app::VersusAppTestAccess::createPeer();
    QVERIFY(peer);

    auto &signaling = versus::app::VersusAppTestAccess::signaling(app);
    versus::signaling::VdoSignalingTestAccess::forceEncryptionFailure(signaling, true);

    versus::signaling::SignalCandidate candidate;
    candidate.uuid = "candidate-outcome-peer";
    candidate.session = "wire-session";
    candidate.type = "local";
    candidate.mid = "0";
    candidate.mlineIndex = 0;
    candidate.candidate = "candidate:fixture-redacted typ relay";

    QVERIFY(!versus::app::VersusAppTestAccess::dispatchCandidate(
        app, peer, candidate, true));
    QCOMPARE(versus::app::VersusAppTestAccess::sentCount(peer), 0);
    QCOMPARE(versus::app::VersusAppTestAccess::failureCount(peer), 1);
    QCOMPARE(
        versus::signaling::VdoSignalingTestAccess::outboundSendAttempts(signaling),
        uint64_t{0});

    const auto timeline = versus::app::VersusAppTestAccess::timeline(peer);
    QCOMPARE(timeline.size(), std::size_t{1});
    QVERIFY(QString::fromStdString(timeline.front())
                .contains(QStringLiteral("local-candidate-send-failed relay")));

    qInfo().noquote()
        << "CANDIDATE_SEND_FAILURE_BRANCH encryption_forced=1 sent=0 failures=1 transport_attempts=0 timeline=failed-relay";
}

void TestSignalingSendOutcomes::testDisconnectedCandidateFailureIsNotReportedAsSent() {
    versus::app::VersusApp app;
    const auto peer = versus::app::VersusAppTestAccess::createPeer();
    QVERIFY(peer);

    auto &signaling = versus::app::VersusAppTestAccess::signaling(app);
    signaling.disableEncryption();

    versus::signaling::SignalCandidate candidate;
    candidate.uuid = "candidate-outcome-peer";
    candidate.session = "wire-session";
    candidate.type = "local";
    candidate.mid = "0";
    candidate.mlineIndex = 0;
    candidate.candidate = "candidate:fixture-redacted typ host";

    QVERIFY(!versus::app::VersusAppTestAccess::dispatchCandidate(
        app, peer, candidate, false));
    QCOMPARE(versus::app::VersusAppTestAccess::sentCount(peer), 0);
    QCOMPARE(versus::app::VersusAppTestAccess::failureCount(peer), 1);
    QCOMPARE(
        versus::signaling::VdoSignalingTestAccess::outboundSendAttempts(signaling),
        uint64_t{1});

    const auto timeline = versus::app::VersusAppTestAccess::timeline(peer);
    QCOMPARE(timeline.size(), std::size_t{1});
    QVERIFY(QString::fromStdString(timeline.front())
                .contains(QStringLiteral("local-candidate-send-failed")));
    QVERIFY(!QString::fromStdString(timeline.front())
                 .contains(QStringLiteral("failed relay")));

    qInfo().noquote()
        << "CANDIDATE_SEND_FAILURE_BRANCH encryption_forced=0 socket_open=0 sent=0 failures=1 transport_attempts=1 timeline=failed-direct";
}

QTEST_GUILESS_MAIN(TestSignalingSendOutcomes)
#include "test_signaling_send_outcomes.moc"
