#include <QtTest/QtTest>

#include <QElapsedTimer>
#include <QSet>
#include <QString>

#include <algorithm>
#include <atomic>
#include <iterator>

#include "versus/video/camera_capture.h"

class TestCameraCapture : public QObject {
    Q_OBJECT

  private slots:
    void testCameraEnumerationReturnsUniqueUsableIds();
    void testInvalidCameraIdRejected();
    void testOptInCameraLifecycleStress();
};

void TestCameraCapture::testCameraEnumerationReturnsUniqueUsableIds() {
    versus::video::CameraCapture capture;
    const auto cameras = capture.getCameras();

    QSet<QString> ids;
    for (const auto &camera : cameras) {
        const QString id = QString::fromStdString(camera.id);
        const QString name = QString::fromStdString(camera.name);
        QVERIFY2(!id.isEmpty(), "Camera identifier must not be empty");
        QVERIFY2(!name.isEmpty(), "Camera name must not be empty");
        QVERIFY2(!ids.contains(id), "Camera identifiers must be unique");
        ids.insert(id);
    }
}

void TestCameraCapture::testInvalidCameraIdRejected() {
    versus::video::CameraCapture capture;
    QVERIFY(!capture.startCapture("camera-device-that-does-not-exist", 1280, 720, 30));
    QVERIFY(!capture.isCapturing());
    QVERIFY(!capture.lastError().empty());
}

void TestCameraCapture::testOptInCameraLifecycleStress() {
    const QString activeFilter =
        qEnvironmentVariable("GAME_CAPTURE_STRESS_CAMERA").trimmed();
    if (activeFilter.isEmpty()) {
        QSKIP("Set GAME_CAPTURE_STRESS_CAMERA to run the physical camera lifecycle stress gate");
    }

    versus::video::CameraCapture capture;
    const auto cameras = capture.getCameras();
    const auto activeIt = std::find_if(cameras.begin(), cameras.end(), [&activeFilter](const auto &camera) {
        return QString::fromStdString(camera.name).contains(activeFilter, Qt::CaseInsensitive);
    });
    QVERIFY2(
        activeIt != cameras.end(),
        qPrintable(QString("No camera matched GAME_CAPTURE_STRESS_CAMERA=%1").arg(activeFilter)));

    bool cycleCountOk = false;
    const int requestedCycles =
        qEnvironmentVariableIntValue("GAME_CAPTURE_STRESS_CYCLES", &cycleCountOk);
    const int cycles = cycleCountOk ? std::clamp(requestedCycles, 1, 50) : 10;
    const struct {
        int width;
        int height;
        int fps;
    } modes[] = {
        {1920, 1080, 60},
        {1280, 720, 30},
        {960, 540, 24},
        {640, 480, 60},
    };

    std::atomic<uint64_t> frameCount{0};
    capture.setFrameCallback([&frameCount](versus::video::CapturedFrame frame) {
        if (!frame.data.empty() && frame.width > 0 && frame.height > 0) {
            frameCount.fetch_add(1, std::memory_order_relaxed);
        }
    });

    for (int cycle = 0; cycle < cycles; ++cycle) {
        const auto &mode = modes[cycle % std::size(modes)];
        const uint64_t framesBefore = frameCount.load(std::memory_order_relaxed);
        QElapsedTimer startTimer;
        startTimer.start();
        QVERIFY2(
            capture.startCapture(activeIt->id, mode.width, mode.height, mode.fps),
            qPrintable(QString("Cycle %1 failed: %2")
                .arg(cycle + 1)
                .arg(QString::fromStdString(capture.lastError()))));
        QVERIFY(capture.isCapturing());
        QVERIFY2(startTimer.elapsed() < 5000, "Active camera startup exceeded five seconds");
        QTRY_VERIFY_WITH_TIMEOUT(
            frameCount.load(std::memory_order_relaxed) > framesBefore,
            1500);

        QElapsedTimer stopTimer;
        stopTimer.start();
        capture.stopCapture();
        QVERIFY(!capture.isCapturing());
        QVERIFY2(stopTimer.elapsed() < 2000, "Camera shutdown exceeded two seconds");
        capture.stopCapture();
        QVERIFY(!capture.isCapturing());
    }

    const QString inactiveFilter =
        qEnvironmentVariable("GAME_CAPTURE_INACTIVE_CAMERA").trimmed();
    if (!inactiveFilter.isEmpty()) {
        const auto inactiveIt = std::find_if(
            cameras.begin(), cameras.end(), [&inactiveFilter](const auto &camera) {
                return QString::fromStdString(camera.name).contains(
                    inactiveFilter, Qt::CaseInsensitive);
            });
        QVERIFY2(
            inactiveIt != cameras.end(),
            qPrintable(QString("No camera matched GAME_CAPTURE_INACTIVE_CAMERA=%1")
                .arg(inactiveFilter)));

        QElapsedTimer inactiveTimer;
        inactiveTimer.start();
        QVERIFY(!capture.startCapture(inactiveIt->id, 1280, 720, 30));
        QVERIFY2(inactiveTimer.elapsed() < 12000, "Inactive camera cancellation exceeded twelve seconds");
        QVERIFY(!capture.isCapturing());
        QVERIFY(QString::fromStdString(capture.lastError()).contains(
            "inactive", Qt::CaseInsensitive));

        const uint64_t framesBeforeRecovery =
            frameCount.load(std::memory_order_relaxed);
        QVERIFY(capture.startCapture(activeIt->id, 1280, 720, 30));
        QTRY_VERIFY_WITH_TIMEOUT(
            frameCount.load(std::memory_order_relaxed) > framesBeforeRecovery,
            1500);
        capture.stopCapture();
        QVERIFY(!capture.isCapturing());
    }
}

QTEST_MAIN(TestCameraCapture)
#include "test_camera_capture.moc"
