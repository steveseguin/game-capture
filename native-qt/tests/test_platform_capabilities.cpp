#include <QtTest>
#include <QDir>
#include <QJsonDocument>
#include <QJsonObject>
#include <QComboBox>
#include <QPushButton>
#include <thread>

#include "versus/app/versus_app.h"
#include "versus/platform/capabilities.h"
#include "versus/ui/main_window.h"
#ifdef __APPLE__
#include "versus/platform/app_paths.h"
#endif

class PlatformCapabilitiesGate : public QObject {
    Q_OBJECT
private slots:
    void atomicOwnerRetainsReadersDuringConcurrentStop() {
        struct Value { int sequence; int check; };
        versus::platform::AtomicSharedPtr<Value> owner;
        auto first = std::make_shared<Value>(Value{1, 2});
        std::weak_ptr<Value> lifetime = first;
        owner.store(std::move(first));
        auto reader = owner.load();
        owner.exchange({}).reset();
        QVERIFY(!lifetime.expired());
        QCOMPARE(reader->check, 2);
        reader.reset();
        QVERIFY(lifetime.expired());

        std::atomic<bool> done{false};
        std::atomic<bool> consistent{true};
        std::thread consumer([&] {
            while (!done.load()) {
                if (auto value = owner.load(); value && value->check != value->sequence * 2)
                    consistent.store(false);
            }
        });
        for (int sequence = 0; sequence < 2000; ++sequence) {
            owner.store(std::make_shared<Value>(Value{sequence, sequence * 2}));
            if (sequence % 3 == 0) owner.exchange({});
        }
        done.store(true);
        consumer.join();
        QVERIFY(consistent.load());
    }

    void diagnosticsDescribeCompiledBackends() {
        versus::app::VersusApp app;
        const auto document = QJsonDocument::fromJson(
            QByteArray::fromStdString(app.buildDiagnosticsJson()));
        QVERIFY(document.isObject());
        const auto published = document.object()["platform_capabilities"].toObject();
        const auto &available = versus::platform::capabilities();
        QCOMPARE(published["platform"].toString(), QString::fromUtf8(available.name));
        QCOMPARE(published["can_publish"].toBool(), available.canPublish());
        QCOMPARE(published["video_encoding"].toBool(), available.videoEncoding);
        QCOMPARE(published["window_capture"].toBool(), available.windowCapture);
    }

    void unavailablePublisherFailsBeforeSourceLookup() {
        if (versus::platform::capabilities().canPublish()) {
            QSKIP("This platform has publishing backends; no physical source is opened by this gate.");
        }
        versus::app::VersusApp app;
        QVERIFY(!app.startCapture("nonexistent-source"));
        QCOMPARE(QString::fromStdString(app.lastCaptureError()),
                 QString::fromUtf8(versus::platform::capabilities().unavailableReason));
        // Repeated failure and stop must leave the instance usable for diagnosis.
        app.stopCapture();
        QVERIFY(!app.startCapture("nonexistent-source"));
        QVERIFY(QJsonDocument::fromJson(QByteArray::fromStdString(app.buildDiagnosticsJson())).isObject());
    }

    void unavailableBackendsCannotBeSelectedInUi() {
        if (versus::platform::capabilities().canPublish()) {
            QSKIP("Unavailable-backend UI applies only to platforms without publishing backends.");
        }
        versus::app::VersusApp app;
        versus::ui::MainWindow window(&app, {false, false});
        for (const auto *name : {"encoderSelect", "codecSelect", "microphoneDeviceSelect", "outputSelect"}) {
            auto *select = window.findChild<QComboBox *>(name);
            QVERIFY2(select, name);
            QVERIFY2(!select->isEnabled(), name);
        }
        const auto *encoder = window.findChild<QComboBox *>("encoderSelect");
        QCOMPARE(encoder->findData("nvenc"), -1);
        QCOMPARE(encoder->findData("qsv"), -1);
        QCOMPARE(encoder->findData("amf"), -1);
        const auto *goLive = window.findChild<QPushButton *>("goLiveButton");
        QVERIFY(goLive);
        QVERIFY(!goLive->isEnabled());
    }

#ifdef __APPLE__
    void macUiAdvertisesOnlyImplementedMedia() {
        versus::app::VersusApp app;
        versus::ui::MainWindow window(&app, {false, false});
        const auto *sources = window.findChild<QComboBox *>("sourceModeSelect");
        QVERIFY(sources);
        QCOMPARE(sources->count(), 3);
        QVERIFY(sources->findData("syphon") >= 0);
        QCOMPARE(sources->findData("spout"), -1);
        QVERIFY(sources->findData("camera") >= 0);
        QCOMPARE(sources->currentData().toString(), QString("window"));
        const auto *encoders = window.findChild<QComboBox *>("encoderSelect");
        QVERIFY(encoders);
        QVERIFY(encoders->findData("videotoolbox") >= 0);
        QVERIFY(encoders->findData("software") >= 0);
        QCOMPARE(encoders->findData("nvenc"), -1);
        const auto *codecs = window.findChild<QComboBox *>("codecSelect");
        QVERIFY(codecs);
        QCOMPARE(codecs->count(), 4);
        QCOMPARE(codecs->currentData().toString(), QString("h264"));
        QVERIFY(window.findChild<QPushButton *>("screenRecordingPermissionButton"));
        const auto *audio = window.findChild<QComboBox *>("audioSourceSelect");
        QVERIFY(audio);
        QCOMPARE(audio->currentData().toString(), QString("selected-window"));
        QVERIFY(audio->isEnabled());
        QVERIFY(audio->findData("default-output") >= 0);
        QVERIFY(audio->findData("default-microphone") >= 0);
        QCOMPARE(audio->findData("communications-output"), -1);
        QVERIFY(window.findChild<QComboBox *>("microphoneDeviceSelect")->isEnabled());
    }
    void macPathsDoNotDependOnWorkingDirectory() {
        const auto logs = versus::platform::logDirectory();
        const auto data = versus::platform::dataDirectory();
        const auto previous = QDir::currentPath();
        QVERIFY(QDir::setCurrent(QDir::tempPath()));
        const auto otherLogs = versus::platform::logDirectory();
        const auto otherData = versus::platform::dataDirectory();
        const bool restored = QDir::setCurrent(previous);
        QVERIFY(restored);
        QVERIFY(QDir::isAbsolutePath(logs));
        QVERIFY(QDir::isAbsolutePath(data));
        QCOMPARE(logs, otherLogs);
        QCOMPARE(data, otherData);
        QVERIFY(logs != data);
    }
#endif
};

QTEST_MAIN(PlatformCapabilitiesGate)
#include "test_platform_capabilities.moc"
