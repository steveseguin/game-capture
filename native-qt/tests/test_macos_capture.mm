#include <QtTest>
#include <QPainter>
#include <QWidget>
#include <algorithm>
#include <mutex>
#include "versus/platform/macos_capture.h"
#include "versus/video/window_capture.h"
#include "versus/webrtc/media_clock.h"
#import <AppKit/AppKit.h>

class CaptureFixture : public QWidget {
public:
    bool black = false;
private:
    void paintEvent(QPaintEvent *) override {
        QPainter painter(this);
        if (black) { painter.fillRect(rect(), Qt::black); return; }
        painter.fillRect(0, 0, width(), height() / 2, Qt::red);
        painter.fillRect(0, height() / 2, width(), height() - height() / 2, Qt::blue);
    }
};

class MacCaptureGate : public QObject {
    Q_OBJECT
private slots:
    void hiddenContentRetainsImageAndVisibleBlackIsDelivered() {
        if (!versus::platform::screenCapturePermissionGranted())
            QSKIP("An existing Screen Recording grant is required; this gate does not prompt.");
        CaptureFixture fixture;
        fixture.setWindowFlags(Qt::Window | Qt::FramelessWindowHint);
        fixture.resize(640,360); fixture.show();
        QVERIFY(QTest::qWaitForWindowExposed(&fixture));
        NSView *view = (__bridge NSView *)reinterpret_cast<void *>(fixture.winId());
        versus::video::WindowCapture capture;
        std::mutex mutex;
        versus::video::CapturedFrame last;
        std::atomic<int> delivered{0}, unexpectedFade{0};
        std::atomic<bool> expectColors{true};
        capture.setFrameCallback([&](auto frame) {
            std::lock_guard lock(mutex);
            QImage image(frame.data.data(),frame.width,frame.height,frame.stride,QImage::Format_ARGB32);
            const auto pixel=image.pixelColor(image.width()/2,image.height()/4);
            if(expectColors && (pixel.red()<200 || pixel.alpha()<250))++unexpectedFade;
            last=std::move(frame);++delivered;
        });
        auto receivedBlack=[&] {
            std::lock_guard lock(mutex);
            if(last.data.empty())return false;
            QImage image(last.data.data(),last.width,last.height,last.stride,QImage::Format_ARGB32);
            const auto pixel=image.pixelColor(image.width()/2,image.height()/4);
            return pixel.red()<5 && pixel.green()<5 && pixel.blue()<5 && pixel.alpha()>250;
        };
        QVERIFY(capture.startCapture(std::to_string(view.window.windowNumber),960,540,30,true));
        QTRY_VERIFY_WITH_TIMEOUT(delivered>=3,3000);
        for(bool minimize : {true,false}) {
            if(minimize)[view.window miniaturize:nil];else [view.window orderOut:nil];
            QTRY_VERIFY_WITH_TIMEOUT(capture.isSuspended(),3000);
            QTest::qWait(100);
            const int held=delivered;
            QTest::qWait(300);
            QCOMPARE(delivered.load(),held);
            QCOMPARE(unexpectedFade.load(),0);
            if(minimize)[view.window deminiaturize:nil];
            [view.window orderFrontRegardless];
            fixture.update();
            QTRY_VERIFY_WITH_TIMEOUT(!capture.isSuspended()&&delivered>held+2,3000);
        }
        // An intentional stable window-opacity setting remains capturable.
        expectColors=false;
        view.window.alphaValue=0.5; fixture.update();
        auto halfOpacity=[&] {
            std::lock_guard lock(mutex);
            const auto *pixel=last.data.data()+(last.height/4)*last.stride+(last.width/2)*4;
            return pixel[2]>200 && std::abs(int(pixel[3])-128)<=2;
        };
        QTRY_VERIFY_WITH_TIMEOUT(halfOpacity()&&!capture.isSuspended(),3000);
        view.window.alphaValue=1.0;
        fixture.black=true; fixture.update();
        QTRY_VERIFY_WITH_TIMEOUT(receivedBlack(),3000);
        QVERIFY(!capture.isSuspended());
        capture.stopCapture();QVERIFY(!capture.isCapturing());
    }
    void transparentPixelsAndResize() {
        if (!versus::platform::screenCapturePermissionGranted())
            QSKIP("An existing Screen Recording grant is required; this gate does not prompt.");
        class TransparentFixture : public QWidget {
        public:
            bool clear = false;
        private:
            void paintEvent(QPaintEvent *) override {
                QPainter painter(this); painter.setCompositionMode(QPainter::CompositionMode_Source);
                if(clear){painter.fillRect(rect(),Qt::transparent);return;}
                for (int stripe=0; stripe<4; ++stripe)
                    painter.fillRect(stripe*width()/4,0,width()/4,height(),QColor(240,60,30,stripe*85));
            }
        } fixture;
        fixture.setWindowFlags(Qt::Window | Qt::FramelessWindowHint);
        fixture.setAttribute(Qt::WA_TranslucentBackground);
        fixture.resize(320,200); fixture.setWindowTitle("Game Capture owned alpha fixture"); fixture.show();
        QVERIFY(QTest::qWaitForWindowExposed(&fixture));
        NSView *view = (__bridge NSView *)reinterpret_cast<void *>(fixture.winId());
        view.window.colorSpace = NSColorSpace.sRGBColorSpace;
        fixture.update(); QTest::qWait(100);
        versus::video::WindowCapture capture;
        std::mutex mutex; versus::video::CapturedFrame last;
        capture.setFrameCallback([&](auto frame) { std::lock_guard lock(mutex); last=std::move(frame); });
        QTRY_VERIFY_WITH_TIMEOUT(capture.startCapture(std::to_string(view.window.windowNumber),320,200,30,true),3000);
        auto hasSize=[&](int width,int height) { std::lock_guard lock(mutex); return last.width==width && last.height==height; };
        QTRY_VERIFY_WITH_TIMEOUT(hasSize(320,200),3000);
        for (int size : {320,640}) {
            if (size==640) { QVERIFY(capture.ensureFrameSize(640,400)); QTRY_VERIFY_WITH_TIMEOUT(hasSize(640,400),3000); }
            std::lock_guard lock(mutex);
            for(int stripe=0;stripe<4;++stripe) {
                const auto *pixel=last.data.data()+(last.height/2)*last.stride+(stripe*last.width/4+last.width/8)*4;
                qInfo("Alpha capture width=%d stripe=%d BGRA=%d,%d,%d,%d",last.width,stripe,pixel[0],pixel[1],pixel[2],pixel[3]);
            }
            for(int stripe=0;stripe<4;++stripe) {
                const auto *pixel=last.data.data()+(last.height/2)*last.stride+(stripe*last.width/4+last.width/8)*4;
                QVERIFY(std::abs(int(pixel[3])-stripe*85)<=2);
                if(stripe) {
                    QVERIFY(std::abs(int(pixel[2])-240)<=5);
                    QVERIFY(std::abs(int(pixel[1])-60)<=5);
                    QVERIFY(std::abs(int(pixel[0])-30)<=5);
                }
            }
        }
        fixture.clear=true;fixture.update();
        auto transparent=[&] {
            std::lock_guard lock(mutex);
            for(int stripe=0;stripe<4;++stripe) {
                const auto *pixel=last.data.data()+(last.height/2)*last.stride+(stripe*last.width/4+last.width/8)*4;
                if(pixel[3]!=0)return false;
            }
            return true;
        };
        QTRY_VERIFY_WITH_TIMEOUT(transparent(),3000);
        QVERIFY(!capture.isSuspended());
        capture.stopCapture(); QVERIFY(!capture.isCapturing());
    }
    void ownedPixelsPreviewAndStop() {
        if (!versus::platform::screenCapturePermissionGranted())
            QSKIP("A logged-in Mac with Screen Recording permission is required; no prompt is issued by this gate.");
        CaptureFixture fixture;
        fixture.setWindowFlags(Qt::Window | Qt::FramelessWindowHint);
        fixture.resize(320, 200);
        fixture.setWindowTitle("Game Capture owned contract fixture");
        fixture.show();
        QVERIFY(QTest::qWaitForWindowExposed(&fixture));
        NSView *view = (__bridge NSView *)reinterpret_cast<void *>(fixture.winId());
        const auto id = std::to_string(view.window.windowNumber);
        QPixmap preview;
        QTRY_VERIFY_WITH_TIMEOUT(!(preview = versus::video::WindowCapture::captureWindowThumbnail(id, 320, 200)).isNull(), 5000);
        auto assertColors = [](const QImage &image) {
            const auto top = image.pixelColor(image.width() / 2, image.height() / 4);
            const auto bottom = image.pixelColor(image.width() / 2, image.height() * 3 / 4);
            return top.red() > 200 && top.blue() < 50 && bottom.blue() > 200 && bottom.red() < 50;
        };
        QVERIFY2(assertColors(preview.toImage()), "Preview must retain color and vertical orientation");

        versus::video::WindowCapture capture;
        std::atomic<int> delivered{0};
        std::atomic<bool> admit{false};
        std::mutex mutex;
        versus::video::CapturedFrame last;
        capture.setFrameAdmissionCallback([&] { return admit.load(); });
        capture.setFrameCallback([&](auto frame) {
            std::lock_guard lock(mutex);
            last = std::move(frame);
            ++delivered;
        });
        for (int generation = 0; generation < 3; ++generation) {
            delivered = 0; admit = false;
            QVERIFY(capture.startCapture(id, 320, 200, 30));
            QTRY_VERIFY_WITH_TIMEOUT(capture.framesSkippedBeforeReadback() > 0, 3000);
            QCOMPARE(delivered.load(), 0);
            admit = true;
            QTRY_VERIFY_WITH_TIMEOUT(delivered.load() >= 3, 3000);
            if (generation == 0) {
                auto receivedSize = [&](int width, int height) {
                    std::lock_guard lock(mutex);
                    return last.width == width && last.height == height;
                };
                QVERIFY(!capture.ensureFrameSize(0, 400));
                QVERIFY(capture.isCapturing());
                QVERIFY(capture.ensureFrameSize(640, 400));
                QTRY_VERIFY_WITH_TIMEOUT(receivedSize(640, 400), 3000);
                // A portrait source inside the same landscape surface must
                // reach the encoder without the surface's letterboxing.
                fixture.resize(200, 320);
                QTRY_VERIFY_WITH_TIMEOUT(receivedSize(250, 400), 3000);
                QVERIFY(capture.ensureFrameSize(960, 600));
                QTRY_VERIFY_WITH_TIMEOUT(receivedSize(375, 600), 3000);
                QVERIFY(capture.ensureFrameSize(320, 200));
                QTest::qWait(100);
                QVERIFY(receivedSize(375, 600)); // Smaller output retains detail.
                {
                    std::lock_guard lock(mutex);
                    QImage pixels(last.data.data(), last.width, last.height, last.stride, QImage::Format_ARGB32);
                    QVERIFY(assertColors(pixels));
                }
                fixture.resize(320, 200);
                QTRY_VERIFY_WITH_TIMEOUT(receivedSize(960, 600), 3000);
            }
            capture.stopCapture();
            QVERIFY(!capture.isCapturing());
            QVERIFY(!capture.ensureFrameSize(640, 400));
            const auto stoppedCount = delivered.load();
            QTest::qWait(200);
            QCOMPARE(delivered.load(), stoppedCount);
            std::lock_guard lock(mutex);
            QCOMPARE(last.width, generation == 0 ? 960 : 320);
            QCOMPARE(last.height, generation == 0 ? 600 : 200);
            QCOMPARE(last.data.size(), size_t(last.stride * last.height));
            QImage pixels(last.data.data(), last.width, last.height, last.stride, QImage::Format_ARGB32);
            QVERIFY(assertColors(pixels));
            const auto age = versus::webrtc::mediaTime100ns() - last.timestamp;
            QVERIFY2(age >= 0 && age < 20000000, "Capture timestamp must use the shared steady-clock domain");
        }
    }
};
QTEST_MAIN(MacCaptureGate)
#include "test_macos_capture.moc"
