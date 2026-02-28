#include <QtTest/QtTest>

#include "versus/video/window_capture.h"

class TestWindowCapture : public QObject {
    Q_OBJECT

  private slots:
    void testInvalidWindowIdRejected();
    void testInvalidWindowIdThumbnailReturnsNull();
};

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
