#include <QtTest/QtTest>

#include "versus/video/window_capture.h"

class TestWindowCapture : public QObject {
    Q_OBJECT

  private slots:
    void testFindBestWindowMatchPrefersTitleMatchOverExecutableOnly();
    void testFindBestWindowMatchUsesLargestExecutableOnlyCandidate();
    void testInvalidWindowIdRejected();
    void testInvalidWindowIdThumbnailReturnsNull();
    void testFramePacerAdmitsAtRequestedCadence();
    void testFramePacerDoesNotBurstAfterDelay();
    void testFrameAdmissionCallbackCanRejectBeforeReadback();
};

void TestWindowCapture::testFindBestWindowMatchPrefersTitleMatchOverExecutableOnly() {
    const std::vector<versus::video::WindowInfo> windows = {
        {"1", "Find", "notepad++.exe", 101, 640, 480},
        {"2", R"(C:\Users\steve\Code\social_stream\manifest.json - Notepad++)", "notepad++.exe", 101, 1920, 1080}
    };

    const auto *selected = versus::video::findBestWindowMatch(windows, "notepad++");
    QVERIFY(selected != nullptr);
    QCOMPARE(QString::fromStdString(selected->id), QString("2"));
}

void TestWindowCapture::testFindBestWindowMatchUsesLargestExecutableOnlyCandidate() {
    const std::vector<versus::video::WindowInfo> windows = {
        {"1", "Find", "sample-app.exe", 202, 640, 480},
        {"2", "Preferences", "sample-app.exe", 202, 1600, 900}
    };

    const auto *selected = versus::video::findBestWindowMatch(windows, "sample-app");
    QVERIFY(selected != nullptr);
    QCOMPARE(QString::fromStdString(selected->id), QString("2"));
}

void TestWindowCapture::testInvalidWindowIdRejected() {
    versus::video::WindowCapture capture;
    QVERIFY(!capture.startCapture("not_a_numeric_window_id", 1920, 1080, 60));
    QVERIFY(!capture.isCapturing());
}

void TestWindowCapture::testInvalidWindowIdThumbnailReturnsNull() {
    QPixmap thumbnail = versus::video::WindowCapture::captureWindowThumbnail("bad_window_id");
    QVERIFY(thumbnail.isNull());
}

void TestWindowCapture::testFramePacerAdmitsAtRequestedCadence() {
    versus::video::detail::CaptureFramePacer pacer(60);
    const auto start = std::chrono::steady_clock::time_point{};

    QVERIFY(pacer.shouldAdmit(start));
    QVERIFY(!pacer.shouldAdmit(start + std::chrono::milliseconds(10)));
    QVERIFY(pacer.shouldAdmit(start + std::chrono::milliseconds(17)));
    QVERIFY(!pacer.shouldAdmit(start + std::chrono::milliseconds(25)));
    QVERIFY(pacer.shouldAdmit(start + std::chrono::milliseconds(34)));
}

void TestWindowCapture::testFramePacerDoesNotBurstAfterDelay() {
    versus::video::detail::CaptureFramePacer pacer(30);
    const auto start = std::chrono::steady_clock::time_point{};

    QVERIFY(pacer.shouldAdmit(start));
    QVERIFY(pacer.shouldAdmit(start + std::chrono::milliseconds(200)));
    QVERIFY(!pacer.shouldAdmit(start + std::chrono::milliseconds(201)));
    QVERIFY(pacer.shouldAdmit(start + std::chrono::milliseconds(234)));
}

void TestWindowCapture::testFrameAdmissionCallbackCanRejectBeforeReadback() {
    int calls = 0;
    const std::function<bool()> reject = [&calls]() {
        ++calls;
        return false;
    };

    QVERIFY(!versus::video::detail::frameAdmissionAllowed(reject));
    QCOMPARE(calls, 1);
    QVERIFY(versus::video::detail::frameAdmissionAllowed({}));
}

QTEST_MAIN(TestWindowCapture)
#include "test_window_capture.moc"
