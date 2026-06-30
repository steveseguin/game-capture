#include <QtTest/QtTest>

#include "versus/signaling/vdo_signaling.h"

class TestVdoSignaling : public QObject {
    Q_OBJECT

  private slots:
    void testViewUrlEncodesPasswordAndRoom();
    void testViewUrlKeepsPasswordFalseLiteral();
    void testDisconnectedSignalSendsFail();
    void testParsesOfficialRoomListingAliases();
    void testParsesOfferRequestAliases();
    void testParsesCleanupAndIceRestartControls();
    void testParsesServerAlertAliases();
};

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

QTEST_MAIN(TestVdoSignaling)
#include "test_vdo_signaling.moc"
