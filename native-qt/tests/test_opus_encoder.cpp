#include <QtTest/QtTest>

#include <vector>

#include "versus/audio/opus_encoder.h"

class TestOpusEncoder : public QObject {
    Q_OBJECT

  private slots:
    void testPtsIsMonotonicIn100nsUnits();
    void testFormatMismatchRejected();
};

void TestOpusEncoder::testPtsIsMonotonicIn100nsUnits() {
    versus::audio::OpusEncoder encoder;
    versus::audio::AudioEncoderConfig config;
    config.sampleRate = 48000;
    config.channels = 2;
    config.bitrate = 128;

    QVERIFY(encoder.initialize(config));

    std::vector<int64_t> packetPts;
    encoder.setPacketCallback([&packetPts](const versus::audio::EncodedAudioPacket &packet) {
        packetPts.push_back(packet.pts);
    });

    // 30ms of stereo PCM float @48kHz => exactly three 10ms Opus frames.
    std::vector<float> samples(480 * 2 * 3, 0.1f);
    QVERIFY(encoder.encode(samples, 48000, 2, 1000000));

    QCOMPARE(static_cast<int>(packetPts.size()), 3);
    QCOMPARE(packetPts[0], static_cast<int64_t>(1000000));
    QCOMPARE(packetPts[1], static_cast<int64_t>(1100000));
    QCOMPARE(packetPts[2], static_cast<int64_t>(1200000));
    QCOMPARE(packetPts[1] - packetPts[0], static_cast<int64_t>(100000));
    QCOMPARE(packetPts[2] - packetPts[1], static_cast<int64_t>(100000));
}

void TestOpusEncoder::testFormatMismatchRejected() {
    versus::audio::OpusEncoder encoder;
    versus::audio::AudioEncoderConfig config;
    config.sampleRate = 48000;
    config.channels = 2;

    QVERIFY(encoder.initialize(config));

    int callbackCount = 0;
    encoder.setPacketCallback([&callbackCount](const versus::audio::EncodedAudioPacket &) { callbackCount++; });

    std::vector<float> samples(480 * 2, 0.0f);
    QVERIFY(!encoder.encode(samples, 44100, 2, 0));
    QCOMPARE(callbackCount, 0);
}

QTEST_MAIN(TestOpusEncoder)
#include "test_opus_encoder.moc"
