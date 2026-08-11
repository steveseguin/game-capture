#include <QtTest/QtTest>
#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QStringList>
#include <QTemporaryDir>

#include "versus/video/spout_capture.h"
#include "versus/video/video_encoder.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <limits>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr int kWidth = 160;
constexpr int kHeight = 90;
constexpr int kResizeWidth = 224;
constexpr int kResizeHeight = 126;
constexpr int kFps = 30;

bool hasSender(versus::video::SpoutCapture &capture, const std::string &name) {
    const auto senders = capture.getSenders();
    return std::any_of(senders.begin(), senders.end(), [&name](const auto &sender) {
        return sender.id == name;
    });
}

class SenderProcess {
  public:
    explicit SenderProcess(std::string name, QStringList extraArgs = {})
        : name_(std::move(name)),
          extraArgs_(std::move(extraArgs)) {}

    ~SenderProcess() {
        stop();
    }

    bool start() {
        const QString exePath =
            QDir(QCoreApplication::applicationDirPath()).filePath("spout_test_sender.exe");
        if (!QFileInfo::exists(exePath)) {
            output_ = "spout_test_sender.exe was not found next to the test binary";
            return false;
        }

        process_.setProgram(exePath);
        QStringList arguments{
            QString("--name=%1").arg(QString::fromStdString(name_)),
            QString("--width=%1").arg(kWidth),
            QString("--height=%1").arg(kHeight),
            QString("--fps=%1").arg(kFps),
            QString("--duration-ms=%1").arg(10000),
        };
        arguments.append(extraArgs_);
        process_.setArguments(arguments);
        process_.setProcessChannelMode(QProcess::MergedChannels);
        process_.start();
        if (!process_.waitForStarted(3000)) {
            output_ = process_.errorString().toUtf8();
            return false;
        }

        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (std::chrono::steady_clock::now() < deadline) {
            process_.waitForReadyRead(100);
            output_ += process_.readAll();
            if (output_.contains("SPOUT_TEST_SENDER_READY")) {
                return true;
            }
            if (process_.state() == QProcess::NotRunning) {
                output_ += process_.readAll();
                return false;
            }
        }
        return false;
    }

    void stop() {
        if (process_.state() == QProcess::NotRunning) {
            return;
        }
        process_.terminate();
        if (!process_.waitForFinished(2000)) {
            process_.kill();
            process_.waitForFinished(2000);
        }
        output_ += process_.readAll();
    }

    QByteArray output() const {
        return output_;
    }

  private:
    std::string name_;
    QStringList extraArgs_;
    QProcess process_;
    QByteArray output_;
};

class ScopedEnvironmentValue {
  public:
    ScopedEnvironmentValue(const char *name, const QByteArray &value)
        : name_(name),
          wasSet_(qEnvironmentVariableIsSet(name)),
          previous_(qgetenv(name)) {
        qputenv(name_, value);
    }

    ~ScopedEnvironmentValue() {
        if (wasSet_) {
            qputenv(name_, previous_);
        } else {
            qunsetenv(name_);
        }
    }

  private:
    QByteArray name_;
    bool wasSet_ = false;
    QByteArray previous_;
};

int readLaunchCount(const QString &path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        return -1;
    }
    bool parsed = false;
    const int count = file.readAll().trimmed().toInt(&parsed);
    return parsed ? count : -1;
}

}  // namespace

class TestSpoutCapture : public QObject {
    Q_OBJECT

  private slots:
    void testFfmpegProbeIsBoundedAndCached();
    void testMediaFoundationWarmupCannotLeakProbeIdentity();
    void testBundledFfmpegHelpSurfaceIsCoveredByProtectedPolicy();
    void testProtectedVp9RuntimeContractUsesLivePackets();
    void testExternalFfmpegStallRestartsOnceAndDropsPreRestartIdentity();
    void testReceivesBgraAlphaFrames();
    void testContinuesAfterSenderResize();
    void testContinuesAfterSenderRestartWithSameName();
};

void TestSpoutCapture::testFfmpegProbeIsBoundedAndCached() {
    const QString helperPath =
        QDir(QCoreApplication::applicationDirPath()).filePath("ffmpeg_probe_hang_helper.exe");
    QVERIFY2(QFileInfo::exists(helperPath), qPrintable(helperPath));

    QElapsedTimer timer;
    timer.start();
    const auto firstProbe = versus::video::VideoEncoder::probeFfmpeg(helperPath.toStdString());
    const qint64 firstElapsedMs = timer.elapsed();
    QVERIFY(firstProbe.error.find("timed out") != std::string::npos);
    QVERIFY2(firstElapsedMs >= 2500 && firstElapsedMs < 6000,
             qPrintable(QString("First probe took %1 ms").arg(firstElapsedMs)));

    timer.restart();
    const auto cachedProbe = versus::video::VideoEncoder::probeFfmpeg(helperPath.toStdString());
    const qint64 cachedElapsedMs = timer.elapsed();
    QCOMPARE(cachedProbe.error, firstProbe.error);
    QVERIFY2(cachedElapsedMs < 500,
             qPrintable(QString("Cached probe took %1 ms").arg(cachedElapsedMs)));
}

void TestSpoutCapture::testMediaFoundationWarmupCannotLeakProbeIdentity() {
    versus::video::VideoEncoder encoder;
    versus::video::EncoderConfig config;
    config.width = 64;
    config.height = 64;
    config.frameRate = 30;
    config.bitrate = 500;
    config.minBitrate = 250;
    config.maxBitrate = 1000;
    config.codec = versus::video::VideoCodec::H264;
    config.preferredHardware = versus::video::HardwareEncoder::NVENC;
    config.forceFfmpegNvenc = false;
    if (!encoder.initialize(config)) {
        QSKIP("No Media Foundation H.264 encoder was available for the warm-up regression gate");
    }

    versus::video::CapturedFrame frame;
    frame.width = config.width;
    frame.height = config.height;
    frame.stride = config.width * 4;
    frame.timestamp = 9000000;
    frame.format = versus::video::CapturedFrame::Format::BGRA;
    frame.data.assign(static_cast<size_t>(frame.stride) * frame.height, 0x7F);
    for (size_t index = 3; index < frame.data.size(); index += 4) {
        frame.data[index] = 0xFF;
    }

    constexpr int64_t kLiveIdentity = 0x123456789LL;
    versus::video::EncodedPacket packet;
    bool produced = false;
    for (int attempt = 0; attempt < 24 && !produced; ++attempt) {
        frame.timestamp += 333333;
        produced = encoder.encodeWithSourceTimestamp(frame, packet, kLiveIdentity + attempt);
    }
    encoder.shutdown();

    QVERIFY2(produced, "Media Foundation produced no live packet after a successful warm-up");
    QVERIFY2(packet.sourceTimestamp >= kLiveIdentity &&
                 packet.sourceTimestamp < kLiveIdentity + 24,
             qPrintable(QString("Warm-up probe identity leaked into first live packet: %1")
                            .arg(packet.sourceTimestamp)));
    QCOMPARE(packet.isKeyframe,
             versus::video::detail::h264AccessUnitIsKeyframe(packet.data));
    QVERIFY2(packet.isKeyframe,
             "A freshly activated Media Foundation encoder did not begin with an IDR access unit");
}

void TestSpoutCapture::testBundledFfmpegHelpSurfaceIsCoveredByProtectedPolicy() {
    const QString ffmpegPath = QString::fromStdString(
        versus::video::VideoEncoder::resolveFfmpegPath());
    if (ffmpegPath.isEmpty() || !QFileInfo::exists(ffmpegPath)) {
        QSKIP("Bundled FFmpeg was unavailable for the option-surface gate");
    }

    QProcess help;
    help.setProgram(ffmpegPath);
    help.setArguments({"-hide_banner", "-h", "full"});
    help.setProcessChannelMode(QProcess::MergedChannels);
    help.start();
    QVERIFY2(help.waitForStarted(3000), qPrintable(help.errorString()));
    QVERIFY2(help.waitForFinished(15000), "Bundled FFmpeg -h full did not finish");
    QCOMPARE(help.exitCode(), 0);
    const QByteArray surface = help.readAll();

    struct SurfaceCase {
        const char *helpNeedle;
        std::vector<std::string> customArgs;
    };
    const std::vector<SurfaceCase> currentAliases = {
        {"-fpsmax[:<stream_spec>]", {"-fpsmax:v:0", "17"}},
        {"-filter_script[:<stream_spec>]", {"-filter_script:v:0", "graph.txt"}},
        {"use -/filter", {"-/filter:v:0", "graph.txt"}},
        {"-lavfi <graph_description>", {"-lavfi", "fps=1"}},
        {"-map <", {"-map", "0:v:0"}},
        {"-codec[:<stream_spec>]", {"-codec:v:0", "vp9_qsv"}},
    };
    for (const auto &current : currentAliases) {
        QVERIFY2(surface.contains(current.helpNeedle),
                 qPrintable(QString("Bundled FFmpeg help did not expose expected surface '%1'")
                                .arg(current.helpNeedle)));
        const auto policy = versus::video::detail::appendProtectedVp9Options(
            {"ffmpeg", "-hide_banner"},
            current.customArgs);
        QCOMPARE(policy.rejectedOptions.size(), std::size_t{1});
        for (const auto &token : current.customArgs) {
            QVERIFY(std::find(policy.args.begin(), policy.args.end(), token) ==
                    policy.args.end());
        }
    }
}

void TestSpoutCapture::testProtectedVp9RuntimeContractUsesLivePackets() {
    const std::string ffmpegPath = versus::video::VideoEncoder::resolveFfmpegPath();
    const auto probe = versus::video::VideoEncoder::probeFfmpeg(ffmpegPath);
    if (!probe.resolved || !probe.hasLibvpxVp9) {
        QSKIP("Bundled FFmpeg with libvpx-vp9 was unavailable for the protected runtime gate");
    }

    versus::video::VideoEncoder encoder;
    versus::video::EncoderConfig config;
    config.width = 64;
    config.height = 64;
    config.frameRate = 30;
    config.bitrate = 500;
    config.minBitrate = 250;
    config.maxBitrate = 1000;
    config.codec = versus::video::VideoCodec::VP9;
    config.preferredHardware = versus::video::HardwareEncoder::None;
    config.ffmpegPath = ffmpegPath;
    config.requireEveryFrameKeyframe = true;
    // Exercise the production option parser and the real bundled FFmpeg
    // command, including aliases/file-option forms exposed by this bundle.
    // Only the timing-neutral threads option may reach the child process.
    config.ffmpegOptions =
        "--threads:v:0=2 -fpsmax:v:0=1 -/filter:v:0 graph.txt "
        "-lavfi fps=1 -map 0:v:0 -codec:v:0 vp9_qsv -g 90";
    QVERIFY2(encoder.initialize(config), "Protected libvpx-vp9 encoder failed to initialize");
    QCOMPARE(encoder.activeCodec(), versus::video::VideoCodec::VP9);
    QVERIFY(encoder.activeEncoderName().find("libvpx-vp9") != std::string::npos);
    QVERIFY2(encoder.guaranteesEveryFrameKeyframe(),
             "Protected guarantee was not established by the selected live encoder");

    versus::video::CapturedFrame frame;
    frame.width = config.width;
    frame.height = config.height;
    frame.stride = config.width * 4;
    frame.timestamp = 10000000;
    frame.format = versus::video::CapturedFrame::Format::BGRA;
    frame.data.assign(static_cast<size_t>(frame.stride) * frame.height, 0x33);
    for (size_t index = 3; index < frame.data.size(); index += 4) {
        frame.data[index] = 0xFF;
    }

    constexpr int64_t kFirstIdentity = 0x234567890LL;
    int produced = 0;
    int64_t lastSourceIdentity = std::numeric_limits<int64_t>::min();
    for (int attempt = 0; attempt < 12 && produced < 3; ++attempt) {
        frame.timestamp += 333333;
        versus::video::EncodedPacket packet;
        if (!encoder.encodeWithSourceTimestamp(
                frame,
                packet,
                kFirstIdentity + attempt)) {
            continue;
        }
        ++produced;
        QCOMPARE(packet.codec, versus::video::VideoCodec::VP9);
        QVERIFY2(packet.isKeyframe,
                 "Protected live encoder emitted a non-keyframe VP9 packet");
        QVERIFY(packet.sourceTimestamp >= kFirstIdentity);
        QVERIFY(packet.sourceTimestamp < kFirstIdentity + 12);
        QVERIFY(packet.sourceTimestamp > lastSourceIdentity);
        lastSourceIdentity = packet.sourceTimestamp;
        QVERIFY2(encoder.guaranteesEveryFrameKeyframe(),
                 "Runtime guarantee did not reflect the inspected live packet");
    }
    encoder.shutdown();
    QVERIFY2(produced >= 3,
             qPrintable(QString("Protected encoder produced only %1 live packets").arg(produced)));
    QVERIFY(!encoder.guaranteesEveryFrameKeyframe());
}

void TestSpoutCapture::testExternalFfmpegStallRestartsOnceAndDropsPreRestartIdentity() {
    const QString helperPath =
        QDir(QCoreApplication::applicationDirPath()).filePath("ffmpeg_encoder_stall_helper.exe");
    QVERIFY2(QFileInfo::exists(helperPath), qPrintable(helperPath));
    QTemporaryDir stateDirectory;
    QVERIFY(stateDirectory.isValid());
    const QString statePath = stateDirectory.filePath("launch-count.txt");
    ScopedEnvironmentValue stateEnvironment(
        "VERSUS_FFMPEG_STALL_STATE_PATH",
        statePath.toUtf8());

    versus::video::VideoEncoder encoder;
    versus::video::EncoderConfig config;
    config.width = 64;
    config.height = 64;
    config.frameRate = 60;
    config.bitrate = 500;
    config.minBitrate = 250;
    config.maxBitrate = 1000;
    config.codec = versus::video::VideoCodec::VP9;
    config.preferredHardware = versus::video::HardwareEncoder::None;
    config.ffmpegPath = helperPath.toStdString();
    config.requireEveryFrameKeyframe = true;
    config.ffmpegOptions = "-threads 1";
    QVERIFY2(encoder.initialize(config),
             "Deterministic FFmpeg boundary helper failed production initialization");
    QCOMPARE(readLaunchCount(statePath), 2);  // probe pipeline + clean live pipeline

    versus::video::CapturedFrame frame;
    frame.width = config.width;
    frame.height = config.height;
    frame.stride = config.width * 4;
    frame.timestamp = 10000000;
    frame.format = versus::video::CapturedFrame::Format::BGRA;
    frame.data.assign(static_cast<size_t>(frame.stride) * frame.height, 0x55);
    for (size_t index = 3; index < frame.data.size(); index += 4) {
        frame.data[index] = 0xFF;
    }

    constexpr int64_t kPreRestartIdentity = 0x41000000LL;
    for (int index = 0; index < 16; ++index) {
        versus::video::EncodedPacket parkedPacket;
        frame.timestamp += 166667;
        QVERIFY2(!encoder.encodeWithSourceTimestamp(
                     frame,
                     parkedPacket,
                     kPreRestartIdentity + index),
                 "The parked helper unexpectedly emitted a pre-restart packet");
        QCOMPARE(encoder.lastEncodeFailureKind(), versus::video::EncodeFailureKind::Timeout);
    }
    QCOMPARE(readLaunchCount(statePath), 2);

    versus::video::EncodedPacket rejectedPacket;
    frame.timestamp += 166667;
    QVERIFY2(!encoder.encodeWithSourceTimestamp(
                 frame,
                 rejectedPacket,
                 kPreRestartIdentity + 16),
             "The full identity pipeline did not reject the next admission");
    QCOMPARE(encoder.lastEncodeFailureKind(), versus::video::EncodeFailureKind::Backpressure);
    QCOMPARE(readLaunchCount(statePath), 4);  // one bounded recovery: warm-up + clean

    constexpr int64_t kPostRestartIdentity = 0x52000000LL;
    versus::video::EncodedPacket recoveredPacket;
    frame.timestamp += 166667;
    QVERIFY2(encoder.encodeWithSourceTimestamp(
                 frame,
                 recoveredPacket,
                 kPostRestartIdentity),
             "Clean post-restart FFmpeg process emitted no packet");
    QCOMPARE(recoveredPacket.sourceTimestamp, kPostRestartIdentity);
    QVERIFY(recoveredPacket.sourceTimestamp < kPreRestartIdentity ||
            recoveredPacket.sourceTimestamp >= kPostRestartIdentity);
    QCOMPARE(readLaunchCount(statePath), 4);
    encoder.shutdown();
}

void TestSpoutCapture::testReceivesBgraAlphaFrames() {
    const std::string senderName =
        "GameCaptureSpoutGate-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    SenderProcess sender(senderName);
    if (!sender.start()) {
        const QByteArray message =
            QByteArray("Spout sender process could not start: ") + sender.output();
        QSKIP(message.constData());
    }

    versus::video::SpoutCapture capture;
    QTRY_VERIFY_WITH_TIMEOUT(hasSender(capture, senderName), 3000);

    std::atomic<int> frameCount{0};
    std::mutex frameMutex;
    versus::video::CapturedFrame latestFrame;
    capture.setFrameCallback([&](const versus::video::CapturedFrame &frame) {
        {
            std::lock_guard<std::mutex> lock(frameMutex);
            latestFrame = frame;
        }
        frameCount.fetch_add(1, std::memory_order_relaxed);
    });

    QVERIFY(capture.startCapture(senderName, kWidth, kHeight, kFps));
    QTRY_VERIFY_WITH_TIMEOUT(frameCount.load(std::memory_order_relaxed) >= 2, 5000);

    versus::video::CapturedFrame frame;
    {
        std::lock_guard<std::mutex> lock(frameMutex);
        frame = latestFrame;
    }
    QVERIFY(!frame.data.empty());
    QCOMPARE(frame.width, kWidth);
    QCOMPARE(frame.height, kHeight);
    QCOMPARE(frame.stride, kWidth * 4);
    QVERIFY(frame.format == versus::video::CapturedFrame::Format::BGRA);
    QCOMPARE(frame.data.size(), static_cast<size_t>(kWidth) * kHeight * 4);

    bool hasTransparent = false;
    bool hasOpaque = false;
    for (size_t i = 3; i < frame.data.size(); i += 4) {
        hasTransparent = hasTransparent || frame.data[i] <= 8;
        hasOpaque = hasOpaque || frame.data[i] >= 248;
    }

    QVERIFY(hasTransparent);
    QVERIFY(hasOpaque);

    capture.stopCapture();
    sender.stop();
}

void TestSpoutCapture::testContinuesAfterSenderResize() {
    const std::string senderName =
        "GameCaptureSpoutResizeGate-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    SenderProcess sender(senderName, {
        QString("--resize-after-ms=%1").arg(1500),
        QString("--resize-width=%1").arg(kResizeWidth),
        QString("--resize-height=%1").arg(kResizeHeight),
    });
    if (!sender.start()) {
        const QByteArray message =
            QByteArray("Spout sender process could not start: ") + sender.output();
        QSKIP(message.constData());
    }

    versus::video::SpoutCapture capture;
    QTRY_VERIFY_WITH_TIMEOUT(hasSender(capture, senderName), 3000);

    std::atomic<int> initialFrames{0};
    std::atomic<int> resizedFrames{0};
    std::mutex frameMutex;
    versus::video::CapturedFrame latestFrame;
    capture.setFrameCallback([&](const versus::video::CapturedFrame &frame) {
        {
            std::lock_guard<std::mutex> lock(frameMutex);
            latestFrame = frame;
        }
        if (frame.width == kWidth && frame.height == kHeight) {
            initialFrames.fetch_add(1, std::memory_order_relaxed);
        }
        if (frame.width == kResizeWidth && frame.height == kResizeHeight) {
            resizedFrames.fetch_add(1, std::memory_order_relaxed);
        }
    });

    QVERIFY(capture.startCapture(senderName, kWidth, kHeight, kFps));
    QTRY_VERIFY_WITH_TIMEOUT(initialFrames.load(std::memory_order_relaxed) >= 2, 3000);
    QTRY_VERIFY_WITH_TIMEOUT(resizedFrames.load(std::memory_order_relaxed) >= 2, 7000);

    versus::video::CapturedFrame frame;
    {
        std::lock_guard<std::mutex> lock(frameMutex);
        frame = latestFrame;
    }
    QVERIFY(!frame.data.empty());
    QCOMPARE(frame.width, kResizeWidth);
    QCOMPARE(frame.height, kResizeHeight);
    QCOMPARE(frame.stride, kResizeWidth * 4);
    QCOMPARE(frame.data.size(), static_cast<size_t>(kResizeWidth) * kResizeHeight * 4);

    capture.stopCapture();
    sender.stop();
}

void TestSpoutCapture::testContinuesAfterSenderRestartWithSameName() {
    const std::string senderName =
        "GameCaptureSpoutRestartGate-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    SenderProcess firstSender(senderName);
    if (!firstSender.start()) {
        const QByteArray message =
            QByteArray("Spout sender process could not start: ") + firstSender.output();
        QSKIP(message.constData());
    }

    versus::video::SpoutCapture capture;
    QTRY_VERIFY_WITH_TIMEOUT(hasSender(capture, senderName), 3000);

    std::atomic<int> initialFrames{0};
    std::atomic<int> restartedFrames{0};
    std::mutex frameMutex;
    versus::video::CapturedFrame latestFrame;
    capture.setFrameCallback([&](const versus::video::CapturedFrame &frame) {
        {
            std::lock_guard<std::mutex> lock(frameMutex);
            latestFrame = frame;
        }
        if (frame.width == kWidth && frame.height == kHeight) {
            initialFrames.fetch_add(1, std::memory_order_relaxed);
        }
        if (frame.width == kResizeWidth && frame.height == kResizeHeight) {
            restartedFrames.fetch_add(1, std::memory_order_relaxed);
        }
    });

    QVERIFY(capture.startCapture(senderName, kWidth, kHeight, kFps));
    QTRY_VERIFY_WITH_TIMEOUT(initialFrames.load(std::memory_order_relaxed) >= 2, 3000);
    firstSender.stop();
    QTest::qWait(500);

    SenderProcess restartedSender(senderName, {
        QString("--width=%1").arg(kResizeWidth),
        QString("--height=%1").arg(kResizeHeight),
        QString("--duration-ms=%1").arg(7000),
    });
    if (!restartedSender.start()) {
        const QByteArray message =
            QByteArray("Replacement Spout sender process could not start: ") + restartedSender.output();
        QSKIP(message.constData());
    }

    QTRY_VERIFY_WITH_TIMEOUT(restartedFrames.load(std::memory_order_relaxed) >= 2, 7000);

    versus::video::CapturedFrame frame;
    {
        std::lock_guard<std::mutex> lock(frameMutex);
        frame = latestFrame;
    }
    QVERIFY(!frame.data.empty());
    QCOMPARE(frame.width, kResizeWidth);
    QCOMPARE(frame.height, kResizeHeight);
    QCOMPARE(frame.stride, kResizeWidth * 4);
    QCOMPARE(frame.data.size(), static_cast<size_t>(kResizeWidth) * kResizeHeight * 4);

    capture.stopCapture();
    restartedSender.stop();
}

QTEST_MAIN(TestSpoutCapture)
#include "test_spout_capture.moc"
