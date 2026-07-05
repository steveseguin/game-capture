#include <QtTest/QtTest>
#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QStringList>

#include "versus/video/spout_capture.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <string>
#include <utility>

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

}  // namespace

class TestSpoutCapture : public QObject {
    Q_OBJECT

  private slots:
    void testReceivesBgraAlphaFrames();
    void testContinuesAfterSenderResize();
};

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
    capture.setFrameCallback([&frameCount](const versus::video::CapturedFrame &) {
        frameCount.fetch_add(1, std::memory_order_relaxed);
    });

    QVERIFY(capture.startCapture(senderName, kWidth, kHeight, kFps));
    QTRY_VERIFY_WITH_TIMEOUT(frameCount.load(std::memory_order_relaxed) >= 2, 5000);

    versus::video::CapturedFrame frame;
    QVERIFY(capture.getLatestFrame(frame));
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
    capture.setFrameCallback([&initialFrames, &resizedFrames](const versus::video::CapturedFrame &frame) {
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
    QVERIFY(capture.getLatestFrame(frame));
    QCOMPARE(frame.width, kResizeWidth);
    QCOMPARE(frame.height, kResizeHeight);
    QCOMPARE(frame.stride, kResizeWidth * 4);
    QCOMPARE(frame.data.size(), static_cast<size_t>(kResizeWidth) * kResizeHeight * 4);

    capture.stopCapture();
    sender.stop();
}

QTEST_MAIN(TestSpoutCapture)
#include "test_spout_capture.moc"
