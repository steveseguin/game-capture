#include <QtTest>
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QProcess>
#include <algorithm>
#include <atomic>
#include <mutex>
#include "versus/video/camera_capture.h"
#include "versus/platform/macos_camera.h"
#include "versus/webrtc/media_clock.h"

class MacCameraGate : public QObject {
    Q_OBJECT
private slots:
    void discoveryAndMissingDeviceDoNotPromptOrSubstitute() {
        const auto permission = versus::platform::cameraPermissionStatus();
        versus::video::CameraCapture capture;
        capture.getCameras();
        QVERIFY(!capture.startCapture("game-capture-missing-camera", 1280, 720, 30));
        QVERIFY(!capture.isCapturing());
        QVERIFY(capture.lastError().find("No replacement") != std::string::npos);
        QCOMPARE(versus::platform::cameraPermissionStatus(), permission);
    }
    void controlledVirtualCameraFramesAndRestart() {
        if (versus::platform::cameraPermissionStatus() != "granted")
            QSKIP("Existing camera authorization is required; this gate never requests it");
        versus::video::CameraCapture capture;
        const auto cameras = capture.getCameras();
        const auto found = std::find_if(cameras.begin(), cameras.end(), [](const auto &camera) { return camera.name == "OBS Virtual Camera"; });
        if (found == cameras.end()) QSKIP("An existing OBS Camera Extension is required");
        QProcess fixture;
        fixture.start(QCoreApplication::applicationDirPath() + "/macos-camera-fixture", {QString::fromStdString(found->id)});
        QVERIFY(fixture.waitForStarted(5000));
        QByteArray startup;
        QElapsedTimer startupTimer; startupTimer.start();
        while (!startup.contains("READY") && fixture.state() != QProcess::NotRunning && startupTimer.elapsed() < 5000) {
            fixture.waitForReadyRead(100); startup += fixture.readAllStandardOutput();
        }
        QVERIFY2(startup.contains("READY"), fixture.readAllStandardError().constData());
        std::atomic<int> delivered{0}, controlled{0};
        std::atomic<bool> valid{true};
        std::mutex heldMutex;
        versus::video::CapturedFrame held;
        struct StopBeforeCallbackStateDestruction {
            versus::video::CameraCapture &capture;
            ~StopBeforeCallbackStateDestruction() { capture.stopCapture(); }
        } stopGuard{capture};
        capture.setFrameCallback([&](versus::video::CapturedFrame frame) {
            ++delivered;
            if (frame.format != versus::video::CapturedFrame::Format::BGRA || frame.width != 1920 || frame.height != 1080 ||
                frame.stride != frame.width * 4 || frame.data.size() != static_cast<size_t>(frame.stride * frame.height) ||
                std::abs(versus::webrtc::mediaTime100ns() - frame.timestamp) > 20000000) { valid = false; return; }
            const auto *top = frame.data.data() + frame.stride * (frame.height / 16) + frame.width / 20 * 4;
            const auto *bottom = frame.data.data() + frame.stride * (frame.height * 15 / 16) + frame.width / 20 * 4;
            if (top[2] > 180 && top[1] < 60 && bottom[1] > 180 && bottom[2] < 60) {
                ++controlled;
                std::lock_guard lock(heldMutex);
                if (held.data.empty()) held = std::move(frame);
            }
        });
        for (int fps : {30, 24, 60}) {
            const int before = controlled;
            QElapsedTimer timer; timer.start();
            QVERIFY2(capture.startCapture(found->id, 1280, 720, fps), capture.lastError().c_str());
            QVERIFY(timer.elapsed() < 5000);
            QVERIFY(capture.isCapturing());
            QTRY_VERIFY_WITH_TIMEOUT(controlled >= before + 5, 3000);
            QVERIFY(valid.load());
            QByteArray snapshot;
            { std::lock_guard lock(heldMutex); snapshot = QCryptographicHash::hash(QByteArrayView(reinterpret_cast<const char *>(held.data.data()), held.data.size()), QCryptographicHash::Sha256); }
            QTest::qWait(150);
            { std::lock_guard lock(heldMutex); QCOMPARE(QCryptographicHash::hash(QByteArrayView(reinterpret_cast<const char *>(held.data.data()), held.data.size()), QCryptographicHash::Sha256), snapshot); }
            timer.restart(); capture.stopCapture(); QVERIFY(timer.elapsed() < 2000);
            QVERIFY(!capture.isCapturing());
            const int stopped = delivered; QTest::qWait(120); QCOMPARE(delivered.load(), stopped);
            capture.stopCapture();
        }
        fixture.write("stall\n"); QVERIFY(fixture.waitForBytesWritten(1000)); QTest::qWait(300);
        QElapsedTimer inactiveTimer; inactiveTimer.start();
        QVERIFY(!capture.startCapture(found->id, 1280, 720, 30));
        QVERIFY(inactiveTimer.elapsed() < 6000);
        QVERIFY(capture.lastError().find("No first frame") != std::string::npos);
        QVERIFY(!capture.isCapturing());
        fixture.write("flow\n"); QVERIFY(fixture.waitForBytesWritten(1000));
        const int beforeRecovery = controlled;
        QVERIFY2(capture.startCapture(found->id, 1280, 720, 30), capture.lastError().c_str());
        QTRY_VERIFY_WITH_TIMEOUT(controlled >= beforeRecovery + 5, 3000);
        fixture.write("stall\n"); QVERIFY(fixture.waitForBytesWritten(1000));
        QTRY_VERIFY_WITH_TIMEOUT(!capture.isCapturing(), 7000);
        QVERIFY(!capture.lastError().empty());
        capture.stopCapture();
        fixture.write("quit\n"); QVERIFY(fixture.waitForFinished(5000)); QCOMPARE(fixture.exitCode(), 0);
    }
};
QTEST_MAIN(MacCameraGate)
#include "test_macos_camera.moc"
