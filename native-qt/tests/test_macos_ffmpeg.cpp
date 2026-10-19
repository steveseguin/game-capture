#include <QtTest>
#include <QFile>
#include <QTemporaryDir>
#include <QDir>
#include <QElapsedTimer>
#include <csignal>
#include <cerrno>
#include "versus/platform/macos_ffmpeg.h"
#include "versus/video/video_encoder.h"
#include "versus/video/ffmpeg_bundle_policy.h"

class MacFfmpegGate : public QObject {
    Q_OBJECT
    QString script(QTemporaryDir &directory, const QString &name, const QByteArray &body) {
        const auto path = directory.filePath(name);
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly)) return {};
        file.write("#!/bin/sh\n" + body); file.close();
        file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
        return path;
    }
private slots:
    void bundledDistributionPolicy_data() {
        QTest::addColumn<bool>("bundled");
        QTest::addColumn<bool>("gpl");
        QTest::addColumn<bool>("nonfree");
        QTest::addColumn<bool>("rejected");
        QTest::newRow("plain-bundle") << true << false << false << false;
        QTest::newRow("nonfree-bundle") << true << false << true << true;
        QTest::newRow("gpl-nonfree-bundle") << true << true << true << true;
        QTest::newRow("external-gpl") << false << true << false << false;
        QTest::newRow("external-nonfree") << false << false << true << false;
        QTest::newRow("external-gpl-nonfree") << false << true << true << false;
#if defined(__linux__) && defined(VERSUS_LINUX_PORTABLE)
        QTest::newRow("portable-gpl-bundle") << true << true << false << false;
#else
        QTest::newRow("legacy-gpl-bundle") << true << true << false << true;
#endif
    }
    void bundledDistributionPolicy() {
        QFETCH(bool, bundled); QFETCH(bool, gpl); QFETCH(bool, nonfree); QFETCH(bool, rejected);
        QCOMPARE(versus::video::rejectBundledFfmpeg(bundled, gpl, nonfree), rejected);
    }
    void explicitPathsAndArgumentsAreLiteral() {
        QTemporaryDir directory(QDir::tempPath() + "/game-capture-probe space-XXXXXX");
        QVERIFY(directory.isValid());
        const auto path = script(directory, "ffmpeg", "printf '%s\\n' \"$1\"\n");
        QVERIFY(!path.isEmpty());
        QCOMPARE(versus::platform::resolveMacFfmpeg(directory.path().toStdString()).string(), path.toStdString());
        QVERIFY(versus::platform::resolveMacFfmpeg(directory.filePath("absent").toStdString()).empty());
        const auto marker = directory.filePath("unexpected-shell-output");
        const std::string argument = "$(touch '" + marker.toStdString() + "'); literal";
        const auto capture = versus::platform::runMacFfmpegProbe(path.toStdString(), {argument});
        QVERIFY(capture.started); QVERIFY(!capture.timedOut); QCOMPARE(capture.exitCode, 0);
        QCOMPARE(capture.output, argument + "\n"); QVERIFY(!QFile::exists(marker));
        QVERIFY(versus::platform::isMacFfmpegOverride(path.toStdString(), path.toStdString()));
        QVERIFY(!versus::platform::isBundledMacFfmpeg(path.toStdString()));
    }
    void versionMetadataUsesNativeProbe() {
        QTemporaryDir directory;
        const auto path = script(directory, "ffmpeg", "case \"$2\" in\n-version) printf 'ffmpeg version controlled\\nconfiguration: --enable-version3\\n';;\n-encoders) printf ' A..... aac\\n';;\nesac\n");
        const auto result = versus::video::VideoEncoder::probeFfmpeg(path.toStdString());
        QVERIFY2(result.error.empty(), result.error.c_str());
        QVERIFY(result.resolved); QVERIFY(result.userOverride); QVERIFY(!result.bundled);
        QCOMPARE(result.version, std::string("ffmpeg version controlled"));
        QVERIFY(!result.gplEnabled); QVERIFY(!result.nonfreeEnabled);
    }
    void stalledProbeRetiresOwnedChildren() {
        QTemporaryDir directory;
        const auto path = script(directory, "ffmpeg", "/bin/sleep 60 &\necho $!\nwait\n");
        QElapsedTimer timer; timer.start();
        const auto result = versus::platform::runMacFfmpegProbe(path.toStdString(), {});
        QVERIFY(result.started); QVERIFY(result.timedOut); QVERIFY(timer.elapsed() < 5000);
        const auto pid = QByteArray::fromStdString(result.output).trimmed().toLongLong();
        QVERIFY(pid > 1);
        QTRY_VERIFY_WITH_TIMEOUT(::kill(static_cast<pid_t>(pid), 0) == -1 && errno == ESRCH, 2000);
    }
    void oversizedProbeIsRejected() {
        QTemporaryDir directory;
        const auto path = script(directory, "ffmpeg", "exec /usr/bin/yes oversized\n");
        QElapsedTimer timer; timer.start();
        const auto result = versus::platform::runMacFfmpegProbe(path.toStdString(), {});
        QVERIFY(result.started); QCOMPARE(result.exitCode, -1);
        QVERIFY(result.output.size() <= 2 * 1024 * 1024); QVERIFY(timer.elapsed() < 5000);
    }
};
QTEST_GUILESS_MAIN(MacFfmpegGate)
#include "test_macos_ffmpeg.moc"
