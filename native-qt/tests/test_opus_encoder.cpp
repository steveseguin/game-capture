#include <QtTest/QtTest>

#include <vector>

#include "versus/audio/opus_encoder.h"

class TestOpusEncoder : public QObject {
    Q_OBJECT

  private slots:
    void testPtsIsMonotonicIn100nsUnits();
    void testRemainderCarriesIntoNextEncodeCall();
    void testFormatMismatchRejected();
    void testRuntimeBitrateUpdate();
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

void TestOpusEncoder::testRemainderCarriesIntoNextEncodeCall() {
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

    // 5 ms + 5 ms must produce one 10 ms Opus packet, not drop the first half.
    std::vector<float> fiveMs(240 * 2, 0.1f);
    QVERIFY(encoder.encode(fiveMs, 48000, 2, 500000));
    QCOMPARE(static_cast<int>(packetPts.size()), 0);
    QVERIFY(encoder.encode(fiveMs, 48000, 2, 550000));
    QCOMPARE(static_cast<int>(packetPts.size()), 1);
    QCOMPARE(packetPts[0], static_cast<int64_t>(500000));

    // A 15 ms chunk emits one frame and carries 5 ms into the next call.
    std::vector<float> fifteenMs(720 * 2, 0.1f);
    QVERIFY(encoder.encode(fifteenMs, 48000, 2, 600000));
    QCOMPARE(static_cast<int>(packetPts.size()), 2);
    QCOMPARE(packetPts[1], static_cast<int64_t>(600000));
    QVERIFY(encoder.encode(fiveMs, 48000, 2, 750000));
    QCOMPARE(static_cast<int>(packetPts.size()), 3);
    QCOMPARE(packetPts[2], static_cast<int64_t>(700000));
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

void TestOpusEncoder::testRuntimeBitrateUpdate() {
    versus::audio::OpusEncoder encoder;
    versus::audio::AudioEncoderConfig config;
    config.sampleRate = 48000;
    config.channels = 2;
    config.bitrate = 128;

    QVERIFY(!encoder.setBitrate(64));
    QVERIFY(encoder.initialize(config));
    QVERIFY(encoder.setBitrate(64));
    QVERIFY(encoder.setBitrate(2));

    int callbackCount = 0;
    encoder.setPacketCallback([&callbackCount](const versus::audio::EncodedAudioPacket &) { callbackCount++; });

    std::vector<float> samples(480 * 2, 0.1f);
    QVERIFY(encoder.encode(samples, 48000, 2, 0));
    QCOMPARE(callbackCount, 1);

    encoder.shutdown();
    QVERIFY(!encoder.setBitrate(64));
}

QTEST_MAIN(TestOpusEncoder)
#include "test_opus_encoder.moc"
