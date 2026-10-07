#include "versus/ui/update_checker.h"
#include <QDateTime>
#include <QElapsedTimer>
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
        QCOMPARE(int(evaluateRelease(release(tag), installed).status), expected);
    }
    void untrustedMetadata() {
        for (const auto &body : {release("9.0.0", true), release("9.0.0", false, true),
                                 QByteArray("{}"), QByteArray("[]"), QByteArray("null"), QByteArray("broken"),
                                 QByteArray(R"({"tag_name":"9.0.0","prerelease":"false","draft":false})"),
                                 QByteArray(R"({"tag_name":900,"prerelease":false,"draft":false})"),
                                 QByteArray(R"({"tag_name":"9.0.0","draft":false})"),
                                 QByteArray(1024 * 1024 + 1, ' ')}) {
            QCOMPARE(evaluateRelease(body, "0.2.59").status, UpdateStatus::Unavailable);
        }
    }
    void cacheAndUpgrade() {
        QTemporaryDir dir;
        const auto path = dir.filePath("update.ini");
        FakeRequest network;
        {
            UpdateChecker checker("0.2.58", path, nullptr, &network);
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
            UpdateChecker checker(version, path, nullptr, &network);
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
            UpdateChecker checker("0.2.59", path, nullptr, &network);
            checker.checkForUpdates();
            network.finish(429, release("v0.2.59"));
            QCOMPARE(checker.result().status, UpdateStatus::Unavailable);
        }
        UpdateChecker restarted("0.2.59", path, nullptr, &network);
        restarted.checkForUpdates();
        QCOMPARE(restarted.result().status, UpdateStatus::Unavailable);
        QCOMPARE(network.requests, 2);
        QVERIFY(!QSettings(path, QSettings::IniFormat).value("Release").toByteArray().isEmpty());
    }
    void errorsAndShutdown() {
        for (int status : {0, 301, 403, 404, 429, 500}) {
            FakeRequest network;
            UpdateChecker checker("0.2.59", {}, nullptr, &network);
            checker.checkForUpdates();
            network.finish(status, release("v0.2.59"));
            QCOMPARE(checker.result().status, UpdateStatus::Unavailable);
        }
        FakeRequest network;
        UpdateChecker checker("0.2.59", {}, nullptr, &network);
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
        UpdateChecker checker("0.2.59", path, nullptr, &network);
        QElapsedTimer elapsed;
        elapsed.start();
        checker.checkForUpdates();
        QCOMPARE(network.requests, 1);
        network.finish(200, release("v0.2.59"));
        QVERIFY(elapsed.elapsed() < 1000);
        QVERIFY(QFileInfo(path).size() < 16 * 1024);
        QCOMPARE(checker.result().status, UpdateStatus::UpToDate);
        UpdateChecker restarted("0.2.59", path, nullptr, &network);
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
            UpdateChecker checker("0.2.59", path, nullptr, &network);
            checker.checkForUpdates();
            QCOMPARE(network.requests, 1);
        }
        {
            QSettings cache(path, QSettings::IniFormat);
            cache.setValue("LastAttempt", QDateTime::currentSecsSinceEpoch() - 86399);
        }
        UpdateChecker checker("0.2.59", path, nullptr, &network);
        QCOMPARE(network.requests, 1);
        QTRY_COMPARE_WITH_TIMEOUT(network.requests, 2, 7500);
    }
    void absoluteTimeout() {
        FakeRequest network;
        UpdateChecker checker("0.2.59", {}, nullptr, &network);
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
        UpdateChecker checker("0.2.59", {});
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
