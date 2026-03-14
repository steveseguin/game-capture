#include <QtTest/QtTest>

#include "versus/signaling/vdo_signaling.h"

class TestVdoSignaling : public QObject {
    Q_OBJECT

  private slots:
    void testViewUrlEncodesPasswordAndRoom();
    void testViewUrlKeepsPasswordFalseLiteral();
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

QTEST_MAIN(TestVdoSignaling)
#include "test_vdo_signaling.moc"
