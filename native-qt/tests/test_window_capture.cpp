#include <QtTest/QtTest>

#include "versus/video/window_capture.h"

class TestWindowCapture : public QObject {
    Q_OBJECT

  private slots:
    void testFindBestWindowMatchPrefersTitleMatchOverExecutableOnly();
    void testFindBestWindowMatchUsesLargestExecutableOnlyCandidate();
    void testInvalidWindowIdRejected();
    void testInvalidWindowIdThumbnailReturnsNull();
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

QTEST_MAIN(TestWindowCapture)
#include "test_window_capture.moc"
