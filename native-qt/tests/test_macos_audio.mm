#include <QtTest>
#include <atomic>
#include <QProcess>
#include "versus/platform/macos_audio_input.h"
#import <CoreAudio/CoreAudio.h>
#import <AVFoundation/AVFoundation.h>
#include <cmath>
#include "versus/audio/window_audio_capture_core.h"
#include "versus/webrtc/media_clock.h"

class MacAudioGate : public QObject {
    Q_OBJECT
    AVAudioEngine *engine = nil;
    static unsigned tapCount() {
        AudioObjectPropertyAddress key{kAudioHardwarePropertyTapList, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
        UInt32 size = 0;
        if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &key, 0, nullptr, &size)) return 0;
        return size / sizeof(AudioObjectID);
    }
private slots:
    void initTestCase() {
        engine = [AVAudioEngine new];
        auto format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:2];
        __block double phase = 0;
        auto tone = [[AVAudioSourceNode alloc] initWithFormat:format renderBlock:
            ^OSStatus(BOOL *, const AudioTimeStamp *, AVAudioFrameCount frames, AudioBufferList *output) {
                for (unsigned frame = 0; frame < frames; ++frame) {
                    const float value = .002f * std::sin(phase);
                    phase = std::fmod(phase + 2 * 3.141592653589793 * 440 / 48000, 2 * 3.141592653589793);
                    for (unsigned channel = 0; channel < output->mNumberBuffers; ++channel)
                        static_cast<float *>(output->mBuffers[channel].mData)[frame] = value;
                }
                return noErr;
            }];
        [engine attachNode:tone];
        [engine connect:tone to:engine.mainMixerNode format:format];
        NSError *error = nil;
        QVERIFY2([engine startAndReturnError:&error], error.localizedDescription.UTF8String);
    }
    void cleanupTestCase() { [engine stop]; engine = nil; }
    void invalidSelectionDoesNotBecomeSystemCapture() {
        versus::audio::WindowAudioCaptureCore capture;
        QVERIFY(!capture.StartCapture(0).success);
        QVERIFY(!capture.StartCapture(UINT32_MAX).success);
        QVERIFY(!capture.IsCapturing());
        QVERIFY(!capture.StartDefaultEndpointCapture(versus::audio::DefaultAudioEndpoint::CommunicationsOutput).success);
    }
    void sourceRestartsWithoutStaleCallbacksOrTapLeaks() {
        const auto baseline = tapCount();
        for (int generation = 0; generation < 3; ++generation) {
            std::atomic<unsigned> callbacks{0};
            std::atomic<bool> valid{true};
            versus::audio::WindowAudioCaptureCore capture;
            const auto result = capture.StartStreamCapture(getpid(), [&](versus::audio::StreamChunk &&chunk) {
                const auto age = versus::webrtc::mediaTime100ns() - chunk.captureTime100ns;
                if (chunk.channels != 2 || chunk.sampleRate < 8000 || chunk.samples.empty() ||
                    chunk.samples.size() % 2 || chunk.captureTime100ns <= 0 || age < -1000000 || age > 10000000)
                    valid = false;
                ++callbacks;
            });
            QVERIFY2(result.success, result.error.c_str());
            QVERIFY(capture.IsCapturing());
            QTRY_VERIFY_WITH_TIMEOUT(callbacks.load() > 2, 3000);
            capture.StopCapture();
            const auto stopped = callbacks.load();
            QTest::qWait(150);
            QCOMPARE(callbacks.load(), stopped);
            QVERIFY(valid.load());
            QVERIFY(!capture.IsCapturing());
            QCOMPARE(tapCount(), baseline);
        }
    }
    void selectedInputDoesNotSubstituteMissingDevice() {
        versus::audio::WindowAudioCaptureCore capture;
        const auto permission = versus::platform::microphonePermissionStatus();
        const auto result = capture.StartInputDeviceStreamCapture("game-capture-nonexistent-input", {});
        QVERIFY(!result.success);
        QVERIFY(!capture.IsCapturing());
        QCOMPARE(versus::platform::microphonePermissionStatus(), permission);
    }
    void selectedVirtualInputDeliversOwnedPcmAndStops() {
        versus::audio::WindowAudioCaptureCore discovery;
        std::string selected;
        for (const auto &device : discovery.GetInputDevices())
            if (device.name == "BlackHole 2ch") selected = device.id;
        if (selected.empty() || versus::platform::microphonePermissionStatus() != "granted")
            QSKIP("Requires an existing BlackHole input and already granted microphone permission.");
        QProcess fixture;
        fixture.start(QCoreApplication::applicationDirPath() + "/macos-audio-tone", {QString::fromStdString(selected), "440", "880"});
        QVERIFY(fixture.waitForStarted(3000));
        QVERIFY(fixture.waitForReadyRead(3000));
        QVERIFY(fixture.readAllStandardOutput().contains("READY"));
        for (unsigned generation = 0; generation < 3; ++generation) {
            std::atomic<unsigned> callbacks{0};
            std::atomic<bool> valid{true}, audible{false};
            versus::audio::WindowAudioCaptureCore capture;
            const auto result = capture.StartInputDeviceStreamCapture(selected, [&](versus::audio::StreamChunk &&chunk) {
                const auto age = versus::webrtc::mediaTime100ns() - chunk.captureTime100ns;
                if (chunk.sampleRate != 48000 || chunk.channels != 2 || chunk.samples.empty() ||
                    chunk.captureTime100ns <= 0 || age < -1000000 || age > 10000000) valid = false;
                for (float sample : chunk.samples) if (std::abs(sample) > .001f) audible = true;
                ++callbacks;
            });
            QVERIFY2(result.success, result.error.c_str());
            QTRY_VERIFY_WITH_TIMEOUT(callbacks.load() > 3 && audible.load(), 3000);
            capture.StopCapture();
            const auto stopped = callbacks.load();
            QTest::qWait(100);
            QCOMPARE(callbacks.load(), stopped);
            QVERIFY(valid.load());
            QVERIFY(!capture.IsCapturing());
        }
        fixture.write("quit\n"); QVERIFY(fixture.waitForFinished(3000)); QCOMPARE(fixture.exitCode(), 0);
    }

};
QTEST_MAIN(MacAudioGate)
#include "test_macos_audio.moc"
