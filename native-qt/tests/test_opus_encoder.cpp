#include <QtTest/QtTest>

#include <vector>
#include <cmath>
#include <opus.h>

#include "versus/audio/opus_encoder.h"
#include "versus/audio/pcm_encoder.h"
#include "versus/audio/red_packet.h"

class TestOpusEncoder : public QObject {
    Q_OBJECT

  private slots:
    void testPtsIsMonotonicIn100nsUnits();
    void testRemainderCarriesIntoNextEncodeCall();
    void testFormatMismatchRejected();
    void testRuntimeBitrateUpdate();
    void testEncodedChannelsAndBitrate_data();
    void testEncodedChannelsAndBitrate();
    void testInvalidEncodingConfig();
    void testPcmNetworkOrderAndChunkContinuity();
    void testPcmResamplingRejectsAliasing();
    void testPcmResumesAtCaptureTimestamp();
    void testRedHeadersAndMtu();
    void testRedBitrateLimitsDecode();
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

void TestOpusEncoder::testEncodedChannelsAndBitrate_data() {
    QTest::addColumn<int>("channels");
    QTest::addColumn<int>("bitrate");
    QTest::newRow("mono-low") << 1 << 6;
    QTest::newRow("mono") << 1 << 64;
    QTest::newRow("stereo") << 2 << 192;
    QTest::newRow("stereo-high") << 2 << 510;
}

void TestOpusEncoder::testEncodedChannelsAndBitrate() {
    QFETCH(int, channels);
    QFETCH(int, bitrate);
    versus::audio::OpusEncoder encoder;
    versus::audio::AudioEncoderConfig config;
    config.bitrate = bitrate;
    config.outputChannels = channels;
    QVERIFY(encoder.initialize(config));
    std::vector<float> pcm(48000 * 2);
    for (int frame = 0; frame < 48000; ++frame) {
        pcm[frame * 2] = 0.2f * std::sin(frame * 440.0 * 6.283185307 / 48000);
        pcm[frame * 2 + 1] = 0.2f * std::sin(frame * 880.0 * 6.283185307 / 48000);
    }
    int packets = 0, bytes = 0, error = 0;
    auto *decoder = opus_decoder_create(48000, 2, &error);
    QVERIFY(decoder != nullptr);
    encoder.setPacketCallback([&](const versus::audio::EncodedAudioPacket &packet) {
        ++packets;
        bytes += static_cast<int>(packet.data.size());
        QCOMPARE(opus_packet_get_nb_channels(packet.data.data()), channels);
        QCOMPARE(packet.channels, channels);
        std::vector<float> decoded(960);
        QCOMPARE(opus_decode_float(decoder, packet.data.data(), static_cast<int>(packet.data.size()),
                                   decoded.data(), 480, 0), 480);
        if (channels == 1) {
            for (int frame = 0; frame < 480; ++frame) {
                QCOMPARE(decoded[frame * 2], decoded[frame * 2 + 1]);
            }
        }
    });
    QVERIFY(encoder.encode(pcm, 48000, 2, 0));
    opus_decoder_destroy(decoder);
    QCOMPARE(packets, 100);
    // Constant bitrate is rounded to a whole byte per 10 ms packet.
    QVERIFY(std::abs(bytes * 8.0 / 1000.0 - bitrate) <= 0.8);
}

void TestOpusEncoder::testInvalidEncodingConfig() {
    versus::audio::OpusEncoder encoder;
    versus::audio::AudioEncoderConfig config;
    config.outputChannels = 6;
    QVERIFY(!encoder.initialize(config));
    config.outputChannels = 1;
    config.bitrate = 0;
    QVERIFY(!encoder.initialize(config));
    config.bitrate = 511;
    QVERIFY(!encoder.initialize(config));
}

void TestOpusEncoder::testPcmNetworkOrderAndChunkContinuity() {
    versus::audio::PcmEncoder encoder;
    encoder.reset(1);
    std::vector<versus::audio::EncodedAudioPacket> packets;
    auto receive = [&](const auto &packet) { packets.push_back(packet); };
    // Stereo -> mono averages both channels and preserves arbitrary chunk remainders.
    std::vector<float> first(226, .5f), second(734, .5f);
    encoder.encode(first, 1000000, receive);
    QVERIFY(packets.empty());
    encoder.encode(second, 1023541, receive);
    QCOMPARE(packets.size(), size_t(2));
    QCOMPARE(packets[0].pts, int64_t(1000000));
    QCOMPARE(packets[1].pts, int64_t(1050000));
    for (const auto &p : packets) {
        QCOMPARE(p.sampleRate, 48000);
        QCOMPARE(p.channels, 1);
        QCOMPARE(p.data.size(), size_t(480));
        for (size_t i = 0; i < p.data.size(); i += 2) {
            QCOMPARE(p.data[i], uint8_t(0x40));
            QCOMPARE(p.data[i + 1], uint8_t(0));
        }
    }
}

void TestOpusEncoder::testPcmResamplingRejectsAliasing() {
    auto encode = [](int hz, int chunkFrames) {
        versus::audio::PcmEncoder encoder;
        encoder.reset(2);
        std::vector<uint8_t> bytes;
        for (int start = 0; start < 48000; start += chunkFrames) {
            std::vector<float> samples;
            for (int f = start; f < std::min(48000, start + chunkFrames); ++f) {
                samples.push_back(.3f * std::sin(f * hz * 6.283185307179586 / 48000));
                samples.push_back(0);
            }
            encoder.encode(samples, int64_t(start) * 10000000 / 48000, [&](const auto &p) {
                bytes.insert(bytes.end(), p.data.begin(), p.data.end());
            });
        }
        return bytes;
    };
    const auto signal = encode(1000, 137);
    QCOMPARE(signal, encode(1000, 480));
    QCOMPARE(signal.size(), size_t(32000 * 2 * 2));
    auto energy = [](const auto &bytes) {
        double sum = 0;
        for (size_t i = 400; i < bytes.size(); i += 4) {
            const auto sample = static_cast<int16_t>((bytes[i] << 8) | bytes[i + 1]);
            sum += double(sample) * sample;
        }
        return sum;
    };
    QVERIFY(energy(encode(22000, 137)) < energy(signal) * .001);
    for (size_t i = 2; i < signal.size(); i += 4) {
        QCOMPARE(signal[i], uint8_t(0));
        QCOMPARE(signal[i + 1], uint8_t(0));
    }
}

void TestOpusEncoder::testPcmResumesAtCaptureTimestamp() {
    for (int channels : {1, 2}) {
        versus::audio::PcmEncoder encoder;
        encoder.reset(channels);
        std::vector<versus::audio::EncodedAudioPacket> packets;
        auto receive = [&](const auto &packet) { packets.push_back(packet); };
        // Leave a partial packet, then simulate an interval with no viewers.
        encoder.encode(std::vector<float>(144 * 2, .5f), 0, receive);
        QVERIFY(packets.empty());
        encoder.encode(std::vector<float>(480 * 2, 0), 10000000, receive);
        QCOMPARE(packets.size(), size_t(2));
        QCOMPARE(packets[0].pts, int64_t(10000000));
        QCOMPARE(packets[1].pts, int64_t(10050000));
        for (const auto &packet : packets) {
            for (uint8_t byte : packet.data) QCOMPARE(byte, uint8_t(0));
        }
    }
}

void TestOpusEncoder::testRedHeadersAndMtu() {
    const std::vector<uint8_t> current{1, 2, 3}, previous{4, 5};
    const auto red = versus::audio::makeRedPacket(current, previous, 240, 111);
    QCOMPARE(red, (std::vector<uint8_t>{239, 3, 192, 2, 111, 4, 5, 1, 2, 3}));
    QCOMPARE(versus::audio::makeRedPacket(current, previous, 0, 111),
             (std::vector<uint8_t>{111, 1, 2, 3}));
    versus::audio::OpusEncoder encoder;
    versus::audio::AudioEncoderConfig config;
    config.bitrate = 510;
    config.packetDurationMs = 5;
    QVERIFY(encoder.initialize(config));
    std::vector<uint8_t> last;
    int packets = 0;
    encoder.setPacketCallback([&](const auto &p) {
        const auto wire = versus::audio::makeRedPacket(p.data, last, 240, 111);
        QVERIFY(wire.size() <= 1200);
        if (!last.empty()) QVERIFY((wire[0] & 0x80) != 0);
        last = p.data;
        ++packets;
    });
    QVERIFY(encoder.encode(std::vector<float>(960, .1f), 48000, 2, 0));
    QCOMPARE(packets, 2);
}

void TestOpusEncoder::testRedBitrateLimitsDecode() {
    for (int channels : {1, 2}) for (int bitrate : {6, 510}) {
        versus::audio::OpusEncoder encoder;
        versus::audio::AudioEncoderConfig config;
        config.bitrate = bitrate;
        config.outputChannels = channels;
        config.packetDurationMs = 5;
        QVERIFY(encoder.initialize(config));
        int error = 0;
        auto *decoder = opus_decoder_create(48000, 2, &error);
        QVERIFY(decoder);
        double energy = 0;
        int packets = 0;
        encoder.setPacketCallback([&](const auto &packet) {
            QCOMPARE(opus_packet_get_nb_channels(packet.data.data()), channels);
            float decoded[480] = {};
            QCOMPARE(opus_decode_float(decoder, packet.data.data(), static_cast<int>(packet.data.size()),
                                       decoded, 240, 0), 240);
            for (float sample : decoded) {
                QVERIFY(std::isfinite(sample));
                energy += double(sample) * sample;
            }
            ++packets;
        });
        std::vector<float> samples(48000 * 2);
        for (int frame = 0; frame < 48000; ++frame) {
            samples[frame * 2] = .1f * std::sin(frame * 440.0 * 6.283185307 / 48000);
            samples[frame * 2 + 1] = .1f * std::sin(frame * 880.0 * 6.283185307 / 48000);
        }
        QVERIFY(encoder.encode(samples, 48000, 2, 0));
        opus_decoder_destroy(decoder);
        QCOMPARE(packets, 200);
        qInfo() << "RED bitrate boundary" << bitrate << channels << "decoded energy" << energy;
        QVERIFY(energy > 1);
    }
}

QTEST_MAIN(TestOpusEncoder)
#include "test_opus_encoder.moc"
