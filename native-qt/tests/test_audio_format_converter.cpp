#include <QtTest/QtTest>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <vector>

#include "versus/audio/audio_format_converter.h"

class TestAudioFormatConverter : public QObject {
    Q_OBJECT

  private slots:
    void testPcm16Conversion();
    void testPackedPcm24Conversion();
    void testPcm24In32BitContainerConversion();
    void testPcm32Conversion();
    void testFloat32ConversionAndSanitization();
    void testCommonMicrophoneRatesAndChannelLayouts_data();
    void testCommonMicrophoneRatesAndChannelLayouts();
    void testOptInPhysicalInputLifecycleStress();
    void testInvalidFormatsRejected();
};

namespace {

template <typename Sample>
std::vector<uint8_t> bytesFor(const std::vector<Sample> &samples) {
    std::vector<uint8_t> bytes(samples.size() * sizeof(Sample));
    std::memcpy(bytes.data(), samples.data(), bytes.size());
    return bytes;
}

void verifyNear(float actual, float expected, float tolerance = 0.00001f) {
    QVERIFY2(
        std::abs(actual - expected) <= tolerance,
        qPrintable(QString("Expected %1, got %2")
            .arg(expected, 0, 'f', 7)
            .arg(actual, 0, 'f', 7)));
}

}  // namespace

void TestAudioFormatConverter::testPcm16Conversion() {
    const auto bytes = bytesFor<int16_t>({std::numeric_limits<int16_t>::min(), 0, 16384, 32767});
    std::vector<float> converted;
    const versus::audio::AudioSampleFormat format{
        versus::audio::AudioSampleEncoding::PcmSigned, 16, 16};
    QVERIFY(versus::audio::convertInterleavedAudioToFloat(
        bytes.data(), 4, format, converted));
    QCOMPARE(converted.size(), size_t(4));
    verifyNear(converted[0], -1.0f);
    verifyNear(converted[1], 0.0f);
    verifyNear(converted[2], 0.5f);
    verifyNear(converted[3], 32767.0f / 32768.0f);
}

void TestAudioFormatConverter::testPackedPcm24Conversion() {
    const std::vector<uint8_t> bytes = {
        0x00, 0x00, 0x80,
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x40,
        0xFF, 0xFF, 0x7F};
    std::vector<float> converted;
    const versus::audio::AudioSampleFormat format{
        versus::audio::AudioSampleEncoding::PcmSigned, 24, 24};
    QVERIFY(versus::audio::convertInterleavedAudioToFloat(
        bytes.data(), 4, format, converted));
    verifyNear(converted[0], -1.0f);
    verifyNear(converted[1], 0.0f);
    verifyNear(converted[2], 0.5f);
    verifyNear(converted[3], 8388607.0f / 8388608.0f);
}

void TestAudioFormatConverter::testPcm24In32BitContainerConversion() {
    const auto bytes = bytesFor<int32_t>({
        std::numeric_limits<int32_t>::min(),
        0,
        0x40000000,
        0x7FFFFF00});
    std::vector<float> converted;
    const versus::audio::AudioSampleFormat format{
        versus::audio::AudioSampleEncoding::PcmSigned, 32, 24};
    QVERIFY(versus::audio::convertInterleavedAudioToFloat(
        bytes.data(), 4, format, converted));
    verifyNear(converted[0], -1.0f);
    verifyNear(converted[1], 0.0f);
    verifyNear(converted[2], 0.5f);
    verifyNear(converted[3], 0x7FFFFF00 / 2147483648.0f);
}

void TestAudioFormatConverter::testPcm32Conversion() {
    const auto bytes = bytesFor<int32_t>({
        std::numeric_limits<int32_t>::min(),
        0,
        1073741824,
        std::numeric_limits<int32_t>::max()});
    std::vector<float> converted;
    const versus::audio::AudioSampleFormat format{
        versus::audio::AudioSampleEncoding::PcmSigned, 32, 32};
    QVERIFY(versus::audio::convertInterleavedAudioToFloat(
        bytes.data(), 4, format, converted));
    verifyNear(converted[0], -1.0f);
    verifyNear(converted[1], 0.0f);
    verifyNear(converted[2], 0.5f);
    verifyNear(converted[3], 2147483647.0f / 2147483648.0f);
}

void TestAudioFormatConverter::testFloat32ConversionAndSanitization() {
    const auto bytes = bytesFor<float>({
        -1.0f,
        0.25f,
        1.5f,
        std::numeric_limits<float>::quiet_NaN()});
    std::vector<float> converted;
    const versus::audio::AudioSampleFormat format{
        versus::audio::AudioSampleEncoding::Float, 32, 32};
    QVERIFY(versus::audio::convertInterleavedAudioToFloat(
        bytes.data(), 4, format, converted));
    verifyNear(converted[0], -1.0f);
    verifyNear(converted[1], 0.25f);
    verifyNear(converted[2], 1.5f);
    verifyNear(converted[3], 0.0f);
}

void TestAudioFormatConverter::testCommonMicrophoneRatesAndChannelLayouts_data() {
    QTest::addColumn<uint>("sampleRate");
    QTest::addColumn<uint>("channels");

    QTest::newRow("44.1-kHz-mono") << 44100u << 1u;
    QTest::newRow("44.1-kHz-stereo") << 44100u << 2u;
    QTest::newRow("48-kHz-mono") << 48000u << 1u;
    QTest::newRow("48-kHz-stereo") << 48000u << 2u;
    QTest::newRow("96-kHz-mono") << 96000u << 1u;
    QTest::newRow("96-kHz-stereo") << 96000u << 2u;
    QTest::newRow("192-kHz-mono") << 192000u << 1u;
    QTest::newRow("192-kHz-stereo") << 192000u << 2u;
}

void TestAudioFormatConverter::testCommonMicrophoneRatesAndChannelLayouts() {
    QFETCH(uint, sampleRate);
    QFETCH(uint, channels);

    constexpr size_t kDurationMs = 10;
    const size_t inputFrames =
        static_cast<size_t>(sampleRate) * kDurationMs / 1000;
    versus::audio::StreamChunk chunk;
    chunk.sampleRate = sampleRate;
    chunk.channels = channels;
    chunk.samples.resize(inputFrames * channels);
    for (size_t frame = 0; frame < inputFrames; ++frame) {
        const float value = static_cast<float>(frame) /
            static_cast<float>(std::max<size_t>(1, inputFrames - 1));
        for (uint channel = 0; channel < channels; ++channel) {
            chunk.samples[(frame * channels) + channel] =
                channel == 0 ? value : -value;
        }
    }

    const auto normalized = versus::audio::normalizeAudioForOpus(chunk);
    QCOMPARE(normalized.size(), size_t(480 * 2));
    verifyNear(normalized[0], 0.0f);
    verifyNear(normalized[1], 0.0f);
    if (channels == 1) {
        verifyNear(normalized[normalized.size() - 2], normalized.back());
    } else {
        verifyNear(
            normalized[normalized.size() - 2],
            -normalized.back(),
            0.0001f);
    }
}

void TestAudioFormatConverter::testOptInPhysicalInputLifecycleStress() {
    if (!qEnvironmentVariableIsSet("GAME_CAPTURE_STRESS_AUDIO_INPUTS")) {
        QSKIP("Set GAME_CAPTURE_STRESS_AUDIO_INPUTS=1 to run the physical input-device lifecycle stress gate");
    }

    bool cycleCountOk = false;
    const int configuredCycles =
        qEnvironmentVariableIntValue("GAME_CAPTURE_STRESS_AUDIO_CYCLES", &cycleCountOk);
    const int cycles = cycleCountOk ? std::clamp(configuredCycles, 1, 20) : 2;

    versus::audio::WindowAudioCaptureCore capture;
    const auto devices = capture.GetInputDevices();
    QVERIFY2(!devices.empty(), "No active Windows microphone/input endpoints were found");

    for (const auto &device : devices) {
        for (int cycle = 0; cycle < cycles; ++cycle) {
            std::atomic<size_t> chunkCount{0};
            std::atomic<bool> invalidChunk{false};
            const auto callback = [&](versus::audio::StreamChunk &&chunk) {
                if (chunk.sampleRate < 8000 ||
                    chunk.sampleRate > 384000 ||
                    chunk.channels == 0 ||
                    chunk.channels > 32 ||
                    (chunk.samples.size() % chunk.channels) != 0 ||
                    !std::all_of(chunk.samples.begin(), chunk.samples.end(), [](float sample) {
                        return std::isfinite(sample);
                    })) {
                    invalidChunk.store(true, std::memory_order_relaxed);
                }
                chunkCount.fetch_add(1, std::memory_order_relaxed);
            };

            const auto startTime = std::chrono::steady_clock::now();
            const auto result = capture.StartInputDeviceStreamCapture(device.id, callback);
            const auto startElapsed = std::chrono::steady_clock::now() - startTime;
            QVERIFY2(
                result.success,
                qPrintable(QString("Could not open input '%1': %2")
                    .arg(QString::fromStdString(device.name))
                    .arg(QString::fromStdString(result.error))));
            QVERIFY(result.sampleRate >= 8000);
            QVERIFY(result.sampleRate <= 384000);
            QVERIFY(result.channels >= 1);
            QVERIFY(result.channels <= 32);
            QVERIFY(startElapsed < std::chrono::seconds(3));

            QTest::qWait(300);
            const auto stopTime = std::chrono::steady_clock::now();
            capture.StopCapture();
            const auto stopElapsed = std::chrono::steady_clock::now() - stopTime;
            QVERIFY2(
                stopElapsed < std::chrono::seconds(2),
                qPrintable(QString("Stopping input '%1' took too long")
                    .arg(QString::fromStdString(device.name))));
            QVERIFY2(
                !invalidChunk.load(std::memory_order_relaxed),
                qPrintable(QString("Input '%1' delivered an invalid audio chunk")
                    .arg(QString::fromStdString(device.name))));

            qInfo().noquote()
                << QString("input=%1 rate=%2 channels=%3 cycle=%4 chunks=%5")
                       .arg(QString::fromStdString(device.name))
                       .arg(result.sampleRate)
                       .arg(result.channels)
                       .arg(cycle + 1)
                       .arg(static_cast<qulonglong>(
                           chunkCount.load(std::memory_order_relaxed)));

            // A second stop must remain safe after rapid source changes.
            capture.StopCapture();
        }
    }
}

void TestAudioFormatConverter::testInvalidFormatsRejected() {
    std::vector<float> converted;
    const uint8_t data[8] = {};
    QVERIFY(!versus::audio::convertInterleavedAudioToFloat(
        data,
        1,
        {versus::audio::AudioSampleEncoding::Float, 64, 64},
        converted));
    QVERIFY(!versus::audio::convertInterleavedAudioToFloat(
        data,
        1,
        {versus::audio::AudioSampleEncoding::PcmSigned, 32, 40},
        converted));
    QVERIFY(!versus::audio::convertInterleavedAudioToFloat(
        nullptr,
        1,
        {versus::audio::AudioSampleEncoding::PcmSigned, 16, 16},
        converted));

    versus::audio::StreamChunk invalid;
    invalid.sampleRate = 0;
    invalid.channels = 1;
    invalid.samples = {0.1f};
    QVERIFY(versus::audio::normalizeAudioForOpus(invalid).empty());
}

QTEST_MAIN(TestAudioFormatConverter)
#include "test_audio_format_converter.moc"
