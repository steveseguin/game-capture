#include <QtTest/QtTest>

#include <spdlog/sinks/ostream_sink.h>
#include <spdlog/spdlog.h>

#include <limits>
#include <sstream>
#include <vector>

#include "versus/app/versus_app.h"
#include "versus/signaling/vdo_signaling.h"

namespace versus::signaling {

class VdoSignalingTestAccess {
  public:
    struct OfferAttempt {
        uint64_t sequence = 0;
        std::string uuid;
        std::string session;
        std::string sdpSha256;
        std::size_t sdpBytes = 0;
    };

    static std::vector<OfferAttempt> offerAttempts(
        const VdoSignaling &signaling) {
        const auto observations = signaling.offerAttemptsForTesting();
        std::vector<OfferAttempt> result;
        result.reserve(observations.size());
        for (const auto &observation : observations) {
            result.push_back({
                observation.sequence,
                observation.uuid,
                observation.session,
                observation.sdpSha256,
                observation.sdpBytes,
            });
        }
        return result;
    }

    static bool dispatchInboundPayload(VdoSignaling &signaling,
                                       const std::string &payload) {
        return signaling.dispatchInboundPayloadForTesting(payload);
    }

    static void forceEncryptionFailure(VdoSignaling &signaling,
                                       bool forceFailure) {
        signaling.forceEncryptionFailureForTesting(forceFailure);
    }

    static uint64_t outboundSendAttempts(const VdoSignaling &signaling) {
        return signaling.outboundSendAttemptsForTesting();
    }
};

}  // namespace versus::signaling

class TestVdoSignaling : public QObject {
    Q_OBJECT

  private slots:
    void testViewUrlEncodesPasswordAndRoom();
    void testViewUrlKeepsPasswordFalseLiteral();
    void testDisconnectedSignalSendsFail();
    void testEncryptionFailureRefusesPlaintextForEverySignalKind();
    void testOfferAttemptObservationsAreCompleteBoundedAndHashed();
    void testSignalingLogsMetadataWithoutRawPrivatePayload();
    void testParsesOfficialRoomListingAliases();
    void testParsesOfferRequestAliases();
    void testParsesCleanupAndIceRestartControls();
    void testParsesServerAlertAliases();
    void testRejectsEmptyCandidatePayloads();
    void testParserTorturePayloads();
    void testAnswerIdentityIgnoresFingerprintAndCandidateNoise();
    void testAnswerIdentityPreservesGenerationDiscriminators();
    void testCandidateUfragMatchesOnlyItsAnswerIdentity();
};

void TestVdoSignaling::testSignalingLogsMetadataWithoutRawPrivatePayload() {
    std::ostringstream captured;
    const auto previousLogger = spdlog::default_logger();
    auto sink = std::make_shared<spdlog::sinks::ostream_sink_mt>(captured);
    auto logger = std::make_shared<spdlog::logger>("signaling-privacy-test", sink);
    logger->set_pattern("%v");
    logger->set_level(spdlog::level::info);
    spdlog::set_default_logger(logger);

    versus::signaling::VdoSignaling signaling;
    const std::string payload = R"({
        "UUID":"private-peer-identity",
        "session":"private-wire-session",
        "description":{
            "type":"answer",
            "sdp":"v=0\r\na=ice-ufrag:private-ufrag\r\na=candidate:1 1 UDP 1 192.0.2.55 50000 typ host\r\n"
        }
    })";
    const bool dispatched =
        versus::signaling::VdoSignalingTestAccess::dispatchInboundPayload(
            signaling, payload);
    const bool published = signaling.publish(
        "private-stream-identity", "private-publisher-label");
    logger->flush();
    spdlog::set_default_logger(previousLogger);

    const QString output = QString::fromStdString(captured.str());
    QVERIFY(dispatched);
    QVERIFY(!published);
    QVERIFY(!output.contains(QStringLiteral("private-peer-identity")));
    QVERIFY(!output.contains(QStringLiteral("private-wire-session")));
    QVERIFY(!output.contains(QStringLiteral("private-ufrag")));
    QVERIFY(!output.contains(QStringLiteral("192.0.2.55")));
    QVERIFY(!output.contains(QStringLiteral("candidate:1")));
    QVERIFY(!output.contains(QStringLiteral("private-stream-identity")));
    QVERIFY(!output.contains(QStringLiteral("private_stream_identity")));
    QVERIFY(!output.contains(QStringLiteral("private-publisher-label")));
    QVERIFY(output.contains(QStringLiteral(
        "[Signaling] Received message kind=answer bytes=")));
}

void TestVdoSignaling::testViewUrlEncodesPasswordAndRoom() {
    versus::signaling::VdoSignaling signaling;

    versus::signaling::RoomConfig roomConfig;
    roomConfig.room = "room name";
    roomConfig.password = "A&B#! %";

    QVERIFY(signaling.joinRoom(roomConfig) == false);
    QVERIFY(signaling.publish("stream_name", "label") == false);

    QCOMPARE(QString::fromStdString(signaling.getViewUrl()),
             QString("https://vdo.ninja/?view=stream_name&room=room_name&solo&password=A%26B%23%21%20%25"));
}

void TestVdoSignaling::testViewUrlKeepsPasswordFalseLiteral() {
    versus::signaling::VdoSignaling signaling;

    versus::signaling::RoomConfig roomConfig;
    roomConfig.room = "room_name";
    roomConfig.password = "false";

    QVERIFY(signaling.joinRoom(roomConfig) == false);
    signaling.disableEncryption();
    QVERIFY(signaling.publish("stream_name", "label") == false);

    QCOMPARE(QString::fromStdString(signaling.getViewUrl()),
             QString("https://vdo.ninja/?view=stream_name&room=room_name&solo&password=false"));
}

void TestVdoSignaling::testDisconnectedSignalSendsFail() {
    versus::signaling::VdoSignaling signaling;

    versus::signaling::SignalOffer offer;
    offer.uuid = "viewer";
    offer.session = "default";
    offer.streamId = "stream_name";
    offer.sdp = "v=0\r\n";
    QVERIFY(signaling.sendOffer(offer) == false);

    versus::signaling::SignalAnswer answer;
    answer.uuid = "viewer";
    answer.session = "default";
    answer.streamId = "stream_name";
    answer.sdp = "v=0\r\n";
    QVERIFY(signaling.sendAnswer(answer) == false);

    versus::signaling::SignalCandidate candidate;
    candidate.uuid = "viewer";
    candidate.session = "default";
    candidate.candidate = "candidate:1 1 UDP 1 127.0.0.1 9 typ host";
    candidate.mid = "0";
    candidate.mlineIndex = 0;
    QVERIFY(signaling.sendCandidate(candidate) == false);
}

void TestVdoSignaling::testEncryptionFailureRefusesPlaintextForEverySignalKind() {
    versus::signaling::VdoSignaling signaling;
    signaling.setPassword("private-room-password");
    versus::signaling::VdoSignalingTestAccess::forceEncryptionFailure(
        signaling, true);

    int encryptionErrors = 0;
    signaling.onError([&encryptionErrors](const std::string &) {
        ++encryptionErrors;
    });

    versus::signaling::SignalOffer offer;
    offer.uuid = "viewer";
    offer.session = "offer-session";
    offer.streamId = "private-stream";
    offer.sdp = "v=0\r\na=ice-pwd:private-offer-secret\r\n";
    QVERIFY(!signaling.sendOffer(offer));

    versus::signaling::SignalAnswer answer;
    answer.uuid = "viewer";
    answer.session = "answer-session";
    answer.streamId = "private-stream";
    answer.sdp = "v=0\r\na=ice-pwd:private-answer-secret\r\n";
    QVERIFY(!signaling.sendAnswer(answer));

    versus::signaling::SignalCandidate candidate;
    candidate.uuid = "viewer";
    candidate.session = "candidate-session";
    candidate.candidate =
        "candidate:1 1 UDP 1 192.0.2.55 50000 typ host";
    candidate.mid = "0";
    candidate.mlineIndex = 0;
    QVERIFY(!signaling.sendCandidate(candidate));

    const auto sendAttempts =
        versus::signaling::VdoSignalingTestAccess::outboundSendAttempts(
            signaling);
    qInfo().noquote()
        << QStringLiteral(
               "ENCRYPTION_FAILURE_BRANCH forced=1 offer=1 answer=1 candidate=1 transport_attempts=%1 errors=%2")
               .arg(sendAttempts)
               .arg(encryptionErrors);

    QCOMPARE(sendAttempts, uint64_t{0});
    QCOMPARE(encryptionErrors, 3);
}

void TestVdoSignaling::testOfferAttemptObservationsAreCompleteBoundedAndHashed() {
    versus::signaling::VdoSignaling signaling;
    for (int index = 1; index <= 65; ++index) {
        versus::signaling::SignalOffer offer;
        offer.uuid = "viewer-" + std::to_string(index);
        offer.session = "session-" + std::to_string(index);
        offer.streamId = "stream-name";
        offer.sdp = "v=0\r\na=x-attempt:" + std::to_string(index) + "\r\n";
        QVERIFY(!signaling.sendOffer(offer));
    }

    const auto attempts =
        versus::signaling::VdoSignalingTestAccess::offerAttempts(signaling);
    QCOMPARE(attempts.size(), std::size_t{60});
    QCOMPARE(attempts.front().sequence, uint64_t{6});
    QCOMPARE(attempts.back().sequence, uint64_t{65});
    QCOMPARE(QString::fromStdString(attempts.front().uuid),
             QStringLiteral("viewer-6"));
    QCOMPARE(QString::fromStdString(attempts.back().session),
             QStringLiteral("session-65"));
    QCOMPARE(attempts.back().sdpBytes,
             std::string("v=0\r\na=x-attempt:65\r\n").size());
    QCOMPARE(attempts.back().sdpSha256.size(), std::size_t{64});
    QCOMPARE(QString::fromStdString(attempts.back().sdpSha256),
             QStringLiteral(
                 "7a7896f3545440bb29ae3dd52ac94c4d9590de65899a832b611828b36e03ca07"));
}

void TestVdoSignaling::testParsesOfficialRoomListingAliases() {
    versus::signaling::VdoSignaling signaling;
    versus::signaling::ParsedSignalMessage parsed;

    QVERIFY(signaling.tryParseSignalPayload(R"({
        "request":"transferred",
        "list":[
            {"UUID":"peer-1","streamID":"cam_1","label":"Camera 1","publisher":true},
            {"UUID":"peer-2","streamId":"cam_2","name":"Camera 2"}
        ]
    })",
                                           parsed));
    QVERIFY(parsed.hasListing);
    QCOMPARE(static_cast<int>(parsed.listing.size()), 2);
    QCOMPARE(QString::fromStdString(parsed.listing[0].uuid), QString("peer-1"));
    QCOMPARE(QString::fromStdString(parsed.listing[0].streamId), QString("cam_1"));
    QCOMPARE(QString::fromStdString(parsed.listing[0].label), QString("Camera 1"));
    QVERIFY(parsed.listing[0].isPublisher);
    QCOMPARE(QString::fromStdString(parsed.listing[1].uuid), QString("peer-2"));
    QCOMPARE(QString::fromStdString(parsed.listing[1].streamId), QString("cam_2"));
    QCOMPARE(QString::fromStdString(parsed.listing[1].label), QString("Camera 2"));

    QVERIFY(signaling.tryParseSignalPayload(R"({"listing":["cam_3"]})", parsed));
    QVERIFY(parsed.hasListing);
    QCOMPARE(static_cast<int>(parsed.listing.size()), 1);
    QCOMPARE(QString::fromStdString(parsed.listing[0].streamId), QString("cam_3"));
}

void TestVdoSignaling::testParsesOfferRequestAliases() {
    versus::signaling::VdoSignaling signaling;

    const std::vector<std::string> messages = {
        R"({"request":"offerSDP","UUID":"viewer-1","session":"sess-1","streamID":"stream-1"})",
        R"({"request":"sendoffer","UUID":"viewer-2","session":"sess-2","streamID":"stream-2"})",
        R"({"request":"play","UUID":"viewer-3","session":"sess-3","streamID":"stream-3"})",
        R"({"request":"joinroom","UUID":"viewer-4","session":"sess-4","streamID":"stream-4"})",
    };

    for (size_t i = 0; i < messages.size(); ++i) {
        versus::signaling::ParsedSignalMessage parsed;
        QVERIFY(signaling.tryParseSignalPayload(messages[i], parsed));
        QVERIFY(parsed.hasOfferRequest);
        QCOMPARE(QString::fromStdString(parsed.uuid), QString("viewer-%1").arg(i + 1));
        QCOMPARE(QString::fromStdString(parsed.session), QString("sess-%1").arg(i + 1));
        QCOMPARE(QString::fromStdString(parsed.streamId), QString("stream-%1").arg(i + 1));
    }

    versus::signaling::ParsedSignalMessage parsed;
    QVERIFY(!signaling.tryParseSignalPayload(R"({"request":"joinroom","roomid":"room"})", parsed));
}

void TestVdoSignaling::testParsesCleanupAndIceRestartControls() {
    versus::signaling::VdoSignaling signaling;
    versus::signaling::ParsedSignalMessage parsed;

    QVERIFY(signaling.tryParseSignalPayload(R"({"request":"cleanup","UUID":"viewer-1","session":"sess-1"})", parsed));
    QVERIFY(parsed.hasPeerCleanup);
    QCOMPARE(QString::fromStdString(parsed.uuid), QString("viewer-1"));
    QCOMPARE(QString::fromStdString(parsed.session), QString("sess-1"));

    QVERIFY(signaling.tryParseSignalPayload(R"({"bye":1,"UUID":"viewer-2","session":"sess-2"})", parsed));
    QVERIFY(parsed.hasPeerCleanup);
    QCOMPARE(QString::fromStdString(parsed.uuid), QString("viewer-2"));
    QCOMPARE(QString::fromStdString(parsed.session), QString("sess-2"));

    QVERIFY(signaling.tryParseSignalPayload(R"({"iceRestartRequest":"true","UUID":"viewer-3","session":"sess-3","streamID":"stream-3"})",
                                           parsed));
    QVERIFY(parsed.hasIceRestartRequest);
    QCOMPARE(QString::fromStdString(parsed.uuid), QString("viewer-3"));
    QCOMPARE(QString::fromStdString(parsed.session), QString("sess-3"));
    QCOMPARE(QString::fromStdString(parsed.streamId), QString("stream-3"));
}

void TestVdoSignaling::testParsesServerAlertAliases() {
    versus::signaling::VdoSignaling signaling;
    versus::signaling::ParsedSignalMessage parsed;

    QVERIFY(signaling.tryParseSignalPayload(R"({"request":"error","error":"Room is full"})", parsed));
    QVERIFY(parsed.hasAlert);
    QCOMPARE(QString::fromStdString(parsed.alertMessage), QString("Room is full"));

    QVERIFY(signaling.tryParseSignalPayload(R"({"alert":"Stream ID is already in use."})", parsed));
    QVERIFY(parsed.hasAlert);
    QCOMPARE(QString::fromStdString(parsed.alertMessage), QString("Stream ID is already in use."));
}

void TestVdoSignaling::testRejectsEmptyCandidatePayloads() {
    versus::signaling::VdoSignaling signaling;
    versus::signaling::ParsedSignalMessage parsed;

    QVERIFY(!signaling.tryParseSignalPayload(
        R"({"UUID":"viewer","session":"default","candidate":{"sdpMid":"0","sdpMLineIndex":0}})",
        parsed));
    QVERIFY(!parsed.candidates.size());

    QVERIFY(signaling.tryParseSignalPayload(
        R"({"UUID":"viewer","session":"default","candidates":[
            "not-a-candidate-object",
            {"sdpMid":"0","sdpMLineIndex":0},
            {"candidate":"candidate:1 1 UDP 1 127.0.0.1 9 typ host","sdpMid":"0","sdpMLineIndex":0}
        ]})",
        parsed));
    QCOMPARE(static_cast<int>(parsed.candidates.size()), 1);
    QCOMPARE(QString::fromStdString(parsed.candidates[0].candidate),
             QString("candidate:1 1 UDP 1 127.0.0.1 9 typ host"));
}

void TestVdoSignaling::testParserTorturePayloads() {
    versus::signaling::VdoSignaling signaling;
    versus::signaling::ParsedSignalMessage parsed;

    QVERIFY(!signaling.tryParseSignalPayload("{not-json", parsed));
    QVERIFY(!signaling.tryParseSignalPayload(R"(["not","an","object"])", parsed));
    QVERIFY(!signaling.tryParseSignalPayload(
        R"({"UUID":"viewer","description":{"type":"answer","sdp":123}})",
        parsed));

    QVERIFY(signaling.tryParseSignalPayload(
        R"({"UUID":"viewer","session":"default","type":"remote","candidate":{
            "candidate":"candidate:1 1 UDP 1 127.0.0.1 9 typ host",
            "mid":"video",
            "sdpMLineIndex":999999999999
        }})",
        parsed));
    QCOMPARE(static_cast<int>(parsed.candidates.size()), 1);
    QCOMPARE(parsed.candidates[0].mlineIndex, std::numeric_limits<int>::max());

    QVERIFY(signaling.tryParseSignalPayload(
        R"({"UUID":"viewer","session":"default","type":"remote","candidate":{
            "candidate":"candidate:1 1 UDP 1 127.0.0.1 9 typ host",
            "smid":"audio",
            "sdpMLineIndex":-999999999999
        }})",
        parsed));
    QCOMPARE(parsed.candidates[0].mlineIndex, std::numeric_limits<int>::min());

    QVERIFY(signaling.tryParseSignalPayload(
        R"({"iceRestartRequest":false,"UUID":"viewer","session":"default","streamID":"stream"})",
        parsed));
    QVERIFY(parsed.hasIceRestartRequest);
}

void TestVdoSignaling::testAnswerIdentityIgnoresFingerprintAndCandidateNoise() {
    const std::string answerA =
        "v=0\r\n"
        "o=- 1491456385890009412 2 IN IP4 127.0.0.1\r\n"
        "a=ice-ufrag:3Ci0\r\n"
        "a=ice-pwd:answer-a-password\r\n"
        "a=fingerprint:sha-256 00:00:00:00\r\n"
        "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
        "a=mid:video\r\n"
        "a=candidate:1 1 udp 1 10.0.0.1 5000 typ host ufrag 3Ci0\r\n"
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
        "a=mid:0\r\n";
    const std::string fingerprintOnlyRepair =
        "v=0\n"
        "o=-   1491456385890009412   2 IN IP4 127.0.0.1\n"
        "a=ice-ufrag:3Ci0\n"
        "a=ice-pwd:answer-a-password\n"
        "a=fingerprint:sha-256 AA:BB:CC:DD\n"
        "m=video 9 UDP/TLS/RTP/SAVPF 96\n"
        "a=mid:video\n"
        "a=candidate:99 1 udp 2 10.0.0.2 6000 typ host ufrag 3Ci0\n"
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\n"
        "a=mid:0\n";

    QCOMPARE(QString::fromStdString(versus::app::detail::normalizeAnswerIdentity(answerA)),
             QString::fromStdString(versus::app::detail::normalizeAnswerIdentity(fingerprintOnlyRepair)));
}

void TestVdoSignaling::testAnswerIdentityPreservesGenerationDiscriminators() {
    const std::string answerA =
        "o=- 100 2 IN IP4 127.0.0.1\r\n"
        "a=ice-ufrag:oldUfrag\r\n"
        "a=ice-pwd:oldPassword\r\n"
        "a=mid:video\r\n"
        "a=mid:0\r\n";
    const std::string nextOriginVersion =
        "o=- 100 3 IN IP4 127.0.0.1\r\n"
        "a=ice-ufrag:oldUfrag\r\n"
        "a=ice-pwd:oldPassword\r\n"
        "a=mid:video\r\n"
        "a=mid:0\r\n";
    const std::string nextIceGeneration =
        "o=- 200 2 IN IP4 127.0.0.1\r\n"
        "a=ice-ufrag:newUfrag\r\n"
        "a=ice-pwd:newPassword\r\n"
        "a=mid:video\r\n"
        "a=mid:0\r\n";
    const std::string alphaRenegotiation =
        "o=- 100 3 IN IP4 127.0.0.1\r\n"
        "a=ice-ufrag:oldUfrag\r\n"
        "a=ice-pwd:oldPassword\r\n"
        "a=mid:video\r\n"
        "a=mid:0\r\n"
        "a=mid:video-alpha\r\n";

    const auto identityA = versus::app::detail::normalizeAnswerIdentity(answerA);
    QVERIFY(identityA != versus::app::detail::normalizeAnswerIdentity(nextOriginVersion));
    QVERIFY(identityA != versus::app::detail::normalizeAnswerIdentity(nextIceGeneration));
    QVERIFY(identityA != versus::app::detail::normalizeAnswerIdentity(alphaRenegotiation));
}

void TestVdoSignaling::testCandidateUfragMatchesOnlyItsAnswerIdentity() {
    const std::string answer =
        "o=- 100 2 IN IP4 127.0.0.1\r\n"
        "a=ice-ufrag:CTHH\r\n"
        "a=ice-pwd:currentPassword\r\n"
        "a=mid:video\r\n";
    const auto identity = versus::app::detail::normalizeAnswerIdentity(answer);
    const std::string sameTransportAlphaAnswer =
        "o=- 100 3 IN IP4 127.0.0.1\r\n"
        "a=ice-ufrag:CTHH\r\n"
        "a=ice-pwd:currentPassword\r\n"
        "a=mid:video\r\n"
        "a=mid:video-alpha\r\n";
    const auto alphaIdentity =
        versus::app::detail::normalizeAnswerIdentity(sameTransportAlphaAnswer);
    const std::string currentTransportCandidate =
        "candidate:1 1 udp 1 10.0.0.1 5000 typ host ufrag CTHH";

    QVERIFY(versus::app::detail::answerIdentityMatchesCandidate(
        identity,
        currentTransportCandidate));
    QVERIFY(versus::app::detail::answerIdentityMatchesCandidate(
        alphaIdentity,
        currentTransportCandidate));
    QVERIFY(!versus::app::detail::answerIdentityMatchesCandidate(
        identity,
        "candidate:2 1 udp 1 10.0.0.2 5001 typ host ufrag 3Ci0"));
    QVERIFY(versus::app::detail::answerIdentityMatchesCandidate(
        identity,
        "candidate:3 1 udp 1 10.0.0.3 5002 typ host"));
}

QTEST_MAIN(TestVdoSignaling)
#include "test_vdo_signaling.moc"
