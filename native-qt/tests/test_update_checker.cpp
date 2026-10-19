#include "versus/ui/update_checker.h"
#include <QDateTime>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLockFile>
#include <QNetworkProxy>
#include <QSettings>
#include <QScopeGuard>
#include <QSignalSpy>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QtTest>

using namespace versus::ui;

static QByteArray release(const QString &tag, bool pre = false, bool draft = false) {
    return QJsonDocument(QJsonObject{{"tag_name", tag}, {"prerelease", pre}, {"draft", draft}})
        .toJson(QJsonDocument::Compact);
}

static QJsonObject macAsset() {
    return {{"name", "game-capture-macos-arm64-0.2.59.dmg"}, {"state", "uploaded"}, {"size", 1000},
            {"browser_download_url", "https://github.com/steveseguin/Game-capture/releases/download/v0.2.59/game-capture-macos-arm64-0.2.59.dmg"}};
}

static QByteArray macRelease(const QJsonObject &asset) {
    auto metadata = QJsonDocument::fromJson(release("v0.2.59")).object();
    metadata["assets"] = QJsonArray{asset};
    return QJsonDocument(metadata).toJson(QJsonDocument::Compact);
}

class FakeRequest : public ReleaseRequest {
  public:
    int requests = 0;
    bool canceled = false;
    void start(const QString &) override { ++requests; canceled = false; }
    void cancel() override { canceled = true; }
    void finish(int status, const QByteArray &body) { emit finished(status, body); }
};

class UpdateCheckerTest : public QObject {
    Q_OBJECT
  private slots:
    void platformDownloads() {
        QCOMPARE(evaluateRelease(release("v0.2.59"), "0.2.58", UpdatePlatform::VersionOnly).status,
                 UpdateStatus::Available);
        QCOMPARE(evaluateRelease(release("v0.2.59"), "0.2.58", UpdatePlatform::MacArm64).status,
                 UpdateStatus::NoCompatibleDownload);
        for (const char *extension : {"dmg", "zip"}) {
            auto asset = macAsset();
            const auto name = QString("game-capture-macos-arm64-0.2.59.%1").arg(extension);
            asset["name"] = name;
            asset["browser_download_url"] = "https://github.com/steveseguin/Game-capture/releases/download/v0.2.59/" + name;
            QCOMPARE(evaluateRelease(macRelease(asset), "0.2.58", UpdatePlatform::MacArm64).status,
                     UpdateStatus::Available);
            QCOMPARE(evaluateRelease(macRelease(asset), "0.2.59", UpdatePlatform::MacArm64).status,
                     UpdateStatus::UpToDate);
        }
        const QList<QPair<QString, QJsonValue>> invalid{
            {"name", "game-capture-macos-x64-0.2.59.dmg"},
            {"name", "game-capture-windows-arm64-0.2.59.zip"},
            {"name", "game-capture-macos-arm64-0.2.59-source.zip"},
            {"name", "game-capture-macos-arm64-0.2.58.dmg"},
            {"size", 0}, {"size", "1000"}, {"state", "starter"},
            {"browser_download_url", "https://example.com/game-capture-macos-arm64-0.2.59.dmg"},
            {"browser_download_url", "http://github.com/steveseguin/Game-capture/releases/download/v0.2.59/game-capture-macos-arm64-0.2.59.dmg"},
            {"browser_download_url", "https://github.com/steveseguin/other/releases/download/v0.2.59/game-capture-macos-arm64-0.2.59.dmg"},
            {"browser_download_url", "https://github.com/steveseguin/Game-capture/releases/download/v0.2.58/game-capture-macos-arm64-0.2.59.dmg"},
            {"browser_download_url", macAsset()["browser_download_url"].toString() + "?other=1"},
            {"browser_download_url", macAsset()["browser_download_url"].toString() + "#other"},
            {"browser_download_url", QJsonValue{}}
        };
        for (const auto &[key, value] : invalid) {
            auto asset = macAsset(); asset[key] = value;
            QCOMPARE(evaluateRelease(macRelease(asset), "0.2.58", UpdatePlatform::MacArm64).status,
                     UpdateStatus::NoCompatibleDownload);
        }
#if defined(__APPLE__) || defined(__linux__)
        QCOMPARE(evaluateRelease(release("v0.2.59"), "0.2.58").status, UpdateStatus::NoCompatibleDownload);
#else
        QCOMPARE(evaluateRelease(release("v0.2.59"), "0.2.58").status, UpdateStatus::Available);
#endif
    }
    void linuxDownloadsAndCache_data() {
        QTest::addColumn<QString>("architecture");
        QTest::newRow("amd64") << QStringLiteral("amd64");
        QTest::newRow("arm64") << QStringLiteral("arm64");
    }
    void linuxDownloadsAndCache() {
        QFETCH(QString, architecture);
        const auto platform = architecture == "arm64" ? UpdatePlatform::LinuxArm64 : UpdatePlatform::LinuxAmd64;
        const auto otherPlatform = architecture == "arm64" ? UpdatePlatform::LinuxAmd64 : UpdatePlatform::LinuxArm64;
        const auto otherArchitecture = architecture == "arm64" ? "amd64" : "arm64";
        const QString name = "game-capture-0.2.59~linux.2-" + architecture + "-0123456789ab-abcdef012345.deb";
        const auto url = "https://github.com/steveseguin/game-capture/releases/download/v0.2.59/" + name;
        const QJsonObject asset{{"name", name}, {"state", "uploaded"}, {"size", 1000},
                               {"browser_download_url", url}};
        QCOMPARE(evaluateRelease(macRelease(asset), "0.2.58", platform).status, UpdateStatus::Available);
        QCOMPARE(evaluateRelease(macRelease(asset), "0.2.59", platform).status, UpdateStatus::UpToDate);
        QCOMPARE(evaluateRelease(macRelease(asset), "0.2.58", otherPlatform).status,
                 UpdateStatus::NoCompatibleDownload);
        QCOMPARE(evaluateRelease(macRelease(asset), "0.2.58", UpdatePlatform::LinuxUnsupported).status,
                 UpdateStatus::NoCompatibleDownload);
        QCOMPARE(evaluateRelease(macRelease(macAsset()), "0.2.58", platform).status,
                 UpdateStatus::NoCompatibleDownload);
        const QList<QPair<QString, QJsonValue>> invalid{
            {"name", QString(name).replace(architecture, otherArchitecture)},
            {"name", QString(name).replace("0.2.59", "0.2.58")},
            {"name", QString(name).replace("linux.2", "linux.0")},
            {"name", QString(name).replace("0123456789ab", "unknown")},
            {"name", name + "-source.tar.gz"}, {"name", name + "\n"},
            {"size", 0}, {"size", "1000"}, {"state", "starter"},
            {"browser_download_url", QString(url).replace("https:", "http:")},
            {"browser_download_url", QString(url).replace("github.com", "example.com")},
            {"browser_download_url", QString(url).replace("/v0.2.59/", "/v0.2.58/")},
            {"browser_download_url", url + "?download=1"},
            {"browser_download_url", url + "#fragment"},
            {"browser_download_url", QString(url).replace("github.com", "user@github.com")},
            {"browser_download_url", QString(url).replace("github.com", "github.com:444")}
        };
        for (const auto &[key, value] : invalid) {
            auto altered = asset; altered[key] = value;
            QCOMPARE(evaluateRelease(macRelease(altered), "0.2.58", platform).status,
                     UpdateStatus::NoCompatibleDownload);
        }
        for (bool hasDownload : {false, true}) {
            QTemporaryDir dir;
            const auto path = dir.filePath("update.ini");
            FakeRequest network;
            const auto expected = hasDownload ? UpdateStatus::Available : UpdateStatus::NoCompatibleDownload;
            {
                UpdateChecker checker("0.2.58", path, nullptr, &network, platform);
                checker.checkForUpdates();
                network.finish(200, hasDownload ? macRelease(asset) : release("v0.2.59"));
                QCOMPARE(checker.result().status, expected);
                QVERIFY(QFileInfo(path).size() < 16 * 1024);
            }
            UpdateChecker warm("0.2.58", path, nullptr, &network, platform);
            QCOMPARE(warm.result().status, expected);
            warm.checkForUpdates();
            QCOMPARE(network.requests, 1);
            // A cache copied from another architecture must never advertise
            // that architecture's package, even before its next refresh.
            UpdateChecker foreign("0.2.58", path, nullptr, &network, otherPlatform);
            QCOMPARE(foreign.result().status, UpdateStatus::NoCompatibleDownload);
        }
        // Existing Linux caches were version-only. Never keep advertising a
        // download without asset evidence while waiting for the next refresh.
        QTemporaryDir dir;
        const auto path = dir.filePath("update.ini");
        FakeRequest network;
        {
            UpdateChecker previous("0.2.58", path, nullptr, &network, UpdatePlatform::VersionOnly);
            previous.checkForUpdates(); network.finish(200, release("v0.2.59"));
        }
        UpdateChecker migrated("0.2.58", path, nullptr, &network, platform);
        QCOMPARE(migrated.result().status, UpdateStatus::NoCompatibleDownload);
        migrated.checkForUpdates();
        QCOMPARE(network.requests, 1);
    }
    void nativeLinuxArchitecture() {
#if defined(__linux__) && defined(__aarch64__)
        QCOMPARE(NativeUpdatePlatform, UpdatePlatform::LinuxArm64);
#elif defined(__linux__) && defined(__x86_64__)
        QCOMPARE(NativeUpdatePlatform, UpdatePlatform::LinuxAmd64);
#endif
    }
    void macCacheAndPlatformMigration() {
        for (bool hasDownload : {false, true}) {
            QTemporaryDir dir;
            const auto path = dir.filePath("update.ini");
            const auto expected = hasDownload ? UpdateStatus::Available : UpdateStatus::NoCompatibleDownload;
            FakeRequest network;
            {
                UpdateChecker checker("0.2.58", path, nullptr, &network, UpdatePlatform::MacArm64);
                checker.checkForUpdates();
                network.finish(200, hasDownload ? macRelease(macAsset()) : release("v0.2.59"));
                QCOMPARE(checker.result().status, expected);
                QCOMPARE(QSettings(path, QSettings::IniFormat).value("LastAttemptSucceeded").toBool(), true);
                QVERIFY(QFileInfo(path).size() < 16 * 1024);
            }
            {
                UpdateChecker checker("0.2.58", path, nullptr, &network, UpdatePlatform::MacArm64);
                QCOMPARE(checker.result().status, expected);
                checker.checkForUpdates();
                QCOMPARE(network.requests, 1);
            }
            if (hasDownload) {
                UpdateChecker upgraded("0.2.59", path, nullptr, &network, UpdatePlatform::MacArm64);
                QCOMPARE(upgraded.result().status, UpdateStatus::UpToDate);
            }
            // The Windows policy still compares versions, including a cache
            // produced by Mac when the release has no matching download.
            {
                UpdateChecker checker("0.2.58", path, nullptr, &network, UpdatePlatform::VersionOnly);
                QCOMPARE(checker.result().status, UpdateStatus::Available);
            }
        }
        QTemporaryDir dir;
        const auto path = dir.filePath("update.ini");
        FakeRequest network;
        {
            UpdateChecker previous("0.2.58", path, nullptr, &network, UpdatePlatform::VersionOnly);
            previous.checkForUpdates(); network.finish(200, release("v0.2.59"));
        }
        UpdateChecker migrated("0.2.58", path, nullptr, &network, UpdatePlatform::MacArm64);
        QCOMPARE(migrated.result().status, UpdateStatus::NoCompatibleDownload);
        migrated.checkForUpdates();
        QCOMPARE(network.requests, 1);
    }
    void versions_data() {
        QTest::addColumn<QString>("installed");
        QTest::addColumn<QString>("tag");
        QTest::addColumn<int>("expected");
        auto row = [](const char *name, const char *installed, const char *tag, UpdateStatus status) {
            QTest::newRow(name) << QString(installed) << QString(tag) << int(status);
        };
        row("numeric patch", "0.2.9", "v0.2.10", UpdateStatus::Available);
        row("numeric minor", "0.9.99", "v0.10.0", UpdateStatus::Available);
        row("numeric major", "9.99.99", "v10.0.0", UpdateStatus::Available);
        row("equal", "0.2.59", "v0.2.59", UpdateStatus::UpToDate);
        row("older", "0.2.59", "v0.2.58", UpdateStatus::UpToDate);
        row("development ahead", "0.3.0-dev.42", "v0.2.59", UpdateStatus::UpToDate);
        row("stable replaces rc", "0.2.59-rc.2", "v0.2.59", UpdateStatus::Available);
        row("build ignored", "0.2.59+local.2", "0.2.59+build.3", UpdateStatus::UpToDate);
        row("large numeric", "99999999999999999999.0.0", "100000000000000000000.0.0", UpdateStatus::Available);
        for (const char *tag : {"v9.0.0-alpha", "v9.0.0-beta.1", "v9.0.0-rc.1", "v9.0.0-test+build",
                                "latest", "v1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", "1.2.3\n",
                                " 1.2.3", "1.2.3+", "1.2.3-rc..1", "1.2.3+<b>"}) {
            row(tag, "0.2.59", tag, UpdateStatus::Unavailable);
        }
        row("invalid installed", "dev", "1.0.0", UpdateStatus::Unavailable);
        row("invalid numeric prerelease", "1.0.0-01", "1.0.0", UpdateStatus::Unavailable);
    }
    void versions() {
        QFETCH(QString, installed);
        QFETCH(QString, tag);
        QFETCH(int, expected);
        QCOMPARE(int(evaluateRelease(release(tag), installed, UpdatePlatform::VersionOnly).status), expected);
    }
    void untrustedMetadata() {
        for (const auto &body : {release("9.0.0", true), release("9.0.0", false, true),
                                 QByteArray("{}"), QByteArray("[]"), QByteArray("null"), QByteArray("broken"),
                                 QByteArray(R"({"tag_name":"9.0.0","prerelease":"false","draft":false})"),
                                 QByteArray(R"({"tag_name":900,"prerelease":false,"draft":false})"),
                                 QByteArray(R"({"tag_name":"9.0.0","draft":false})"),
                                 QByteArray(1024 * 1024 + 1, ' ')}) {
            QCOMPARE(evaluateRelease(body, "0.2.59", UpdatePlatform::VersionOnly).status, UpdateStatus::Unavailable);
        }
    }
    void cacheAndUpgrade() {
        QTemporaryDir dir;
        const auto path = dir.filePath("update.ini");
        FakeRequest network;
        {
            UpdateChecker checker("0.2.58", path, nullptr, &network, UpdatePlatform::VersionOnly);
            QCOMPARE(network.requests, 0);
            checker.checkForUpdates();
            QCOMPARE(QSettings(path, QSettings::IniFormat).value("LastAttemptSucceeded").toBool(), false);
            QVERIFY(QSettings(path, QSettings::IniFormat).value("LastAttempt").toLongLong() > 0);
            checker.checkForUpdates();
            QCOMPARE(network.requests, 1);
            network.finish(200, release("v0.2.59"));
            QCOMPARE(checker.result().status, UpdateStatus::Available);
            checker.checkForUpdates();
            QCOMPARE(network.requests, 1);
        }
        for (const char *version : {"0.2.58", "0.2.59", "0.3.0-dev.1"}) {
            UpdateChecker checker(version, path, nullptr, &network, UpdatePlatform::VersionOnly);
            checker.checkForUpdates();
            QCOMPARE(checker.result().status, QString(version) == "0.2.58" ? UpdateStatus::Available : UpdateStatus::UpToDate);
            QCOMPARE(network.requests, 1);
        }
        // Refresh failure preserves metadata, but no stale "up to date" claim survives restart.
        {
            QSettings cache(path, QSettings::IniFormat);
            cache.setValue("LastAttempt", QDateTime::currentSecsSinceEpoch() - 86401);
        }
        {
            UpdateChecker checker("0.2.59", path, nullptr, &network, UpdatePlatform::VersionOnly);
            checker.checkForUpdates();
            network.finish(429, release("v0.2.59"));
            QCOMPARE(checker.result().status, UpdateStatus::Unavailable);
        }
        UpdateChecker restarted("0.2.59", path, nullptr, &network, UpdatePlatform::VersionOnly);
        restarted.checkForUpdates();
        QCOMPARE(restarted.result().status, UpdateStatus::Unavailable);
        QCOMPARE(network.requests, 2);
        QVERIFY(!QSettings(path, QSettings::IniFormat).value("Release").toByteArray().isEmpty());
    }
    void errorsAndShutdown() {
        for (int status : {0, 301, 403, 404, 429, 500}) {
            FakeRequest network;
            UpdateChecker checker("0.2.59", {}, nullptr, &network, UpdatePlatform::VersionOnly);
            checker.checkForUpdates();
            network.finish(status, release("v0.2.59"));
            QCOMPARE(checker.result().status, UpdateStatus::Unavailable);
        }
        FakeRequest network;
        UpdateChecker checker("0.2.59", {}, nullptr, &network, UpdatePlatform::VersionOnly);
        checker.checkForUpdates();
        QSignalSpy changes(&checker, &UpdateChecker::statusChanged);
        checker.shutdown();
        QVERIFY(network.canceled);
        network.finish(200, release("v9.0.0"));
        checker.checkForUpdates();
        QCOMPARE(network.requests, 1);
        QCOMPARE(changes.count(), 0);
    }
    void busyAndOversizedCache() {
        QTemporaryDir dir;
        const auto path = dir.filePath("update.ini");
        QLockFile lock(path + ".lock");
        QVERIFY(lock.tryLock());
        {
            QFile oversized(path);
            QVERIFY(oversized.open(QIODevice::WriteOnly));
            oversized.write(QByteArray(1024 * 1024, 'x'));
        }
        FakeRequest network;
        UpdateChecker checker("0.2.59", path, nullptr, &network, UpdatePlatform::VersionOnly);
        QElapsedTimer elapsed;
        elapsed.start();
        checker.checkForUpdates();
        QCOMPARE(network.requests, 1);
        network.finish(200, release("v0.2.59"));
        QVERIFY(elapsed.elapsed() < 1000);
        QVERIFY(QFileInfo(path).size() < 16 * 1024);
        QCOMPARE(checker.result().status, UpdateStatus::UpToDate);
        UpdateChecker restarted("0.2.59", path, nullptr, &network, UpdatePlatform::VersionOnly);
        QCOMPARE(restarted.result().status, UpdateStatus::UpToDate);
        restarted.checkForUpdates();
        QCOMPARE(network.requests, 1);
    }
    void schedulingAndClockCorrection() {
        QTemporaryDir dir;
        const auto path = dir.filePath("update.ini");
        FakeRequest network;
        {
            QSettings cache(path, QSettings::IniFormat);
            cache.setValue("LastAttempt", QDateTime::currentSecsSinceEpoch() + 86400);
        }
        {
            UpdateChecker checker("0.2.59", path, nullptr, &network, UpdatePlatform::VersionOnly);
            checker.checkForUpdates();
            QCOMPARE(network.requests, 1);
        }
        {
            QSettings cache(path, QSettings::IniFormat);
            cache.setValue("LastAttempt", QDateTime::currentSecsSinceEpoch() - 86399);
        }
        UpdateChecker checker("0.2.59", path, nullptr, &network, UpdatePlatform::VersionOnly);
        QCOMPARE(network.requests, 1);
        QTRY_COMPARE_WITH_TIMEOUT(network.requests, 2, 7500);
    }
    void absoluteTimeout() {
        FakeRequest network;
        UpdateChecker checker("0.2.59", {}, nullptr, &network, UpdatePlatform::VersionOnly);
        QElapsedTimer elapsed;
        elapsed.start();
        checker.checkForUpdates();
        QTRY_COMPARE_WITH_TIMEOUT(checker.result().status, UpdateStatus::Unavailable, 16500);
        QVERIFY(network.canceled);
        QVERIFY(elapsed.elapsed() >= 14500 && elapsed.elapsed() < 16500);
    }
    void realNetworkFailures_data() {
        QTest::addColumn<int>("mode");
        QTest::newRow("refused") << 0;
        QTest::newRow("proxy failure") << 1;
        QTest::newRow("broken TLS") << 2;
        QTest::newRow("connection timeout") << 3;
        QTest::newRow("shutdown while connecting") << 4;
    }
    void realNetworkFailures() {
        QFETCH(int, mode);
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        const auto previous = QNetworkProxy::applicationProxy();
        QNetworkProxy::setApplicationProxy(QNetworkProxy(QNetworkProxy::HttpProxy, "127.0.0.1", server.serverPort()));
        auto restore = qScopeGuard([&] { QNetworkProxy::setApplicationProxy(previous); });
        QByteArray received;
        connect(&server, &QTcpServer::newConnection, &server, [&] {
            auto *socket = server.nextPendingConnection();
            connect(socket, &QTcpSocket::readyRead, socket, [&, socket] {
                received += socket->readAll();
                if (!received.contains("\r\n\r\n")) return;
                if (mode == 1) socket->write("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");
                if (mode == 2) socket->write("HTTP/1.1 200 Connection established\r\n\r\nNot TLS");
                if (mode == 1 || mode == 2) socket->disconnectFromHost();
            });
        });
        if (mode == 0) server.close();
        UpdateChecker checker("0.2.59", {}, nullptr, nullptr, UpdatePlatform::VersionOnly);
        QElapsedTimer elapsed;
        elapsed.start();
        int heartbeats = 0;
        QTimer heartbeat;
        connect(&heartbeat, &QTimer::timeout, [&] { ++heartbeats; });
        heartbeat.start(50);
        checker.checkForUpdates();
        if (mode == 4) {
            QTRY_VERIFY_WITH_TIMEOUT(!received.isEmpty(), 3000);
            elapsed.restart();
            checker.shutdown();
            QVERIFY(elapsed.elapsed() < 500);
        } else {
            QTRY_COMPARE_WITH_TIMEOUT(checker.result().status, UpdateStatus::Unavailable, 12000);
            if (mode == 3) {
                QVERIFY(elapsed.elapsed() >= 9500 && elapsed.elapsed() < 11500);
                QVERIFY(heartbeats > 100);
            }
        }
        if (mode != 0) QVERIFY(received.startsWith("CONNECT api.github.com:443 HTTP/1.1"));
    }
};

QTEST_GUILESS_MAIN(UpdateCheckerTest)
#include "test_update_checker.moc"
