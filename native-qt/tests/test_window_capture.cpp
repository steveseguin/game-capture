#include <QtTest/QtTest>
#include <future>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#endif

#include "versus/video/window_capture.h"

class TestWindowCapture : public QObject {
    Q_OBJECT

  private slots:
    void testFindBestWindowMatchPrefersTitleMatchOverExecutableOnly();
    void testFindBestWindowMatchUsesLargestExecutableOnlyCandidate();
    void testInvalidWindowIdRejected();
    void testInvalidWindowIdThumbnailReturnsNull();
    void testGdiThumbnailIsOpaque();
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

void TestWindowCapture::testGdiThumbnailIsOpaque() {
#ifdef _WIN32
    std::promise<HWND> created;
    auto ready = created.get_future();
    std::thread source([&created]() {
        WNDCLASSW windowClass{};
        windowClass.hInstance = GetModuleHandleW(nullptr);
        windowClass.hbrBackground = static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH));
        windowClass.lpszClassName = L"ThumbnailGateFixture";
        windowClass.lpfnWndProc = [](HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) -> LRESULT {
            if (message == WM_PRINT || message == WM_PRINTCLIENT) {
                RECT rect{};
                GetClientRect(hwnd, &rect);
                FillRect(reinterpret_cast<HDC>(wparam), &rect,
                         static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH)));
                return 0;
            }
            return DefWindowProcW(hwnd, message, wparam, lparam);
        };
        RegisterClassW(&windowClass);
        HWND window = CreateWindowExW(0, windowClass.lpszClassName, L"Thumbnail gate fixture",
                                  WS_POPUP | WS_VISIBLE,
                                  20, 20, 160, 120, nullptr, nullptr,
                                  GetModuleHandleW(nullptr), nullptr);
        if (window) UpdateWindow(window);
        created.set_value(window);
        MSG message{};
        while (window && IsWindow(window) && GetMessageW(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        UnregisterClassW(windowClass.lpszClassName, windowClass.hInstance);
    });
    HWND window = ready.get();
    const auto cleanup = qScopeGuard([window, &source]() {
        if (window) PostMessageW(window, WM_CLOSE, 0, 0);
        source.join();
    });
    QVERIFY(window != nullptr);
    QTest::qWait(250); // Allow the compositor to present the fixture before capture.
    const auto thumbnail = versus::video::WindowCapture::captureWindowThumbnail(
        std::to_string(reinterpret_cast<uintptr_t>(window)), 160, 120);
    QVERIFY(!thumbnail.isNull());
    const QColor center = thumbnail.toImage().pixelColor(thumbnail.width() / 2, thumbnail.height() / 2);
    QCOMPARE(center.alpha(), 255);
    QCOMPARE(center.red(), 255);
    QCOMPARE(center.green(), 255);
    QCOMPARE(center.blue(), 255);
#else
    QSKIP("Windows GDI thumbnail workflow");
#endif
}

QTEST_MAIN(TestWindowCapture)
#include "test_window_capture.moc"
