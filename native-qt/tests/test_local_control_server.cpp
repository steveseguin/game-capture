#include <QtTest/QtTest>
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QTcpSocket>
#include <QThread>

#include "versus/control/local_control_server.h"

namespace {

QByteArray httpRequest(quint16 port, const QByteArray &request) {
    QTcpSocket socket;
    socket.connectToHost(QHostAddress::LocalHost, port);
    if (!socket.waitForConnected(1000)) {
        return {};
    }
    socket.write(request);
    socket.flush();

    QByteArray response;
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < 3000) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
        response += socket.readAll();
        if (socket.state() == QAbstractSocket::UnconnectedState && !response.isEmpty()) {
            break;
        }
        QThread::msleep(10);
    }
    response += socket.readAll();
    return response;
}

int statusCode(const QByteArray &response) {
    const QList<QByteArray> parts = response.left(response.indexOf("\r\n")).split(' ');
    return parts.size() >= 2 ? parts[1].toInt() : 0;
}

QByteArray responseBody(const QByteArray &response) {
    const qsizetype bodyStart = response.indexOf("\r\n\r\n");
    return bodyStart >= 0 ? response.mid(bodyStart + 4) : QByteArray{};
}

QJsonObject responseObject(const QByteArray &response) {
    return QJsonDocument::fromJson(responseBody(response)).object();
}

QByteArray authGet(const QString &path) {
    return QByteArray("GET ") + path.toUtf8() + " HTTP/1.1\r\n"
        "Host: 127.0.0.1\r\n"
        "Authorization: Bearer test-token\r\n"
        "\r\n";
}

QByteArray authPost(const QString &path, const QByteArray &body) {
    return QByteArray("POST ") + path.toUtf8() + " HTTP/1.1\r\n"
        "Host: 127.0.0.1\r\n"
        "Authorization: Bearer test-token\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: " + QByteArray::number(body.size()) + "\r\n"
        "\r\n" + body;
}

}  // namespace

class TestLocalControlServer : public QObject {
    Q_OBJECT

  private slots:
    void testHealthAndDiscovery();
    void testAuthAndDiagnostics();
    void testSourcesAndIssueReport();
    void testRecentLogTailReadsFromEnd();
    void testIssueReportFailureReturnsServerError();
    void testStopCommand();
    void testFailedStartDoesNotRemoveDiscovery();
};

void TestLocalControlServer::testHealthAndDiscovery() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());

    versus::control::LocalControlServer server;
    versus::control::LocalControlServerConfig config;
    config.token = "test-token";
    config.discoveryPath = dir.filePath("control.json");
    QVERIFY(server.start(config));

    const QByteArray response = httpRequest(server.port(), "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    QCOMPARE(statusCode(response), 200);
    const QJsonObject health = responseObject(response);
    QCOMPARE(health.value("schema").toString(), QString("game-capture-local-control-v1"));
    QCOMPARE(health.value("port").toInt(), static_cast<int>(server.port()));

    QFile discovery(config.discoveryPath);
    QVERIFY(discovery.open(QIODevice::ReadOnly));
    const QJsonObject discovered = QJsonDocument::fromJson(discovery.readAll()).object();
    QCOMPARE(discovered.value("token").toString(), QString("test-token"));
    QCOMPARE(discovered.value("port").toInt(), static_cast<int>(server.port()));
}

void TestLocalControlServer::testAuthAndDiagnostics() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());

    versus::control::LocalControlServer server;
    server.setDiagnosticsProvider([]() {
        return QByteArray(R"({"ok":true,"answer":42})");
    });

    versus::control::LocalControlServerConfig config;
    config.token = "test-token";
    config.discoveryPath = dir.filePath("control.json");
    QVERIFY(server.start(config));

    const QByteArray rejected = httpRequest(server.port(), "GET /diagnostics HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    QCOMPARE(statusCode(rejected), 401);

    const QByteArray accepted = httpRequest(server.port(), authGet("/diagnostics"));
    QCOMPARE(statusCode(accepted), 200);
    QCOMPARE(responseObject(accepted).value("answer").toInt(), 42);
}

void TestLocalControlServer::testSourcesAndIssueReport() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString logPath = dir.filePath("game-capture-debug.log");
    {
        QFile log(logPath);
        QVERIFY(log.open(QIODevice::WriteOnly | QIODevice::Text));
        log.write("first\nsecond\n");
    }

    versus::control::LocalControlServer server;
    server.setDiagnosticsProvider([]() {
        return QByteArray(R"({"schema":"diagnostics","app":{"live":false}})");
    });
    server.setSpoutSourcesProvider([]() {
        QJsonArray sources;
        sources.append(QJsonObject{{"id", "spout-a"}, {"name", "Spout A"}});
        return sources;
    });
    server.setAudioInputSourcesProvider([]() {
        QJsonArray sources;
        sources.append(QJsonObject{{"id", "mic-default"}, {"name", "Default Microphone"}, {"isDefault", true}});
        return sources;
    });

    versus::control::LocalControlServerConfig config;
    config.token = "test-token";
    config.discoveryPath = dir.filePath("control.json");
    config.reportDir = dir.filePath("reports");
    config.logPath = logPath;
    QVERIFY(server.start(config));

    const QByteArray sourcesResponse = httpRequest(server.port(), authGet("/sources/spout"));
    QCOMPARE(statusCode(sourcesResponse), 200);
    QCOMPARE(responseObject(sourcesResponse).value("sources").toArray().first().toObject().value("id").toString(),
             QString("spout-a"));

    const QByteArray audioSourcesResponse = httpRequest(server.port(), authGet("/sources/audio-inputs"));
    QCOMPARE(statusCode(audioSourcesResponse), 200);
    QCOMPARE(responseObject(audioSourcesResponse).value("sources").toArray().first().toObject().value("id").toString(),
             QString("mic-default"));

    const QByteArray schemaResponse = httpRequest(server.port(), authGet("/schema"));
    QCOMPARE(statusCode(schemaResponse), 200);
    QVERIFY(!responseObject(schemaResponse).value("commands").toArray().isEmpty());

    const QByteArray reportResponse = httpRequest(
        server.port(),
        authPost("/commands", R"({"command":"issue_report","notes":"local control test"})"));
    QCOMPARE(statusCode(reportResponse), 201);
    const QString reportPath = responseObject(reportResponse).value("path").toString();
    QVERIFY(QFile::exists(reportPath));

    QFile report(reportPath);
    QVERIFY(report.open(QIODevice::ReadOnly));
    const QJsonObject reportJson = QJsonDocument::fromJson(report.readAll()).object();
    QCOMPARE(reportJson.value("notes").toString(), QString("local control test"));
    QCOMPARE(reportJson.value("diagnostics").toObject().value("schema").toString(), QString("diagnostics"));
    QCOMPARE(reportJson.value("log_tail").toArray().last().toString(), QString("second"));
}

void TestLocalControlServer::testRecentLogTailReadsFromEnd() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString logPath = dir.filePath("large.log");
    QFile log(logPath);
    QVERIFY(log.open(QIODevice::WriteOnly));
    for (int i = 0; i < 10000; ++i) {
        const QByteArray line = QByteArray("line-") + QByteArray::number(i).rightJustified(5, '0') + "\n";
        QCOMPARE(log.write(line), line.size());
    }
    log.close();

    versus::control::LocalControlServer server;
    versus::control::LocalControlServerConfig config;
    config.token = "test-token";
    config.discoveryPath = dir.filePath("control.json");
    config.logPath = logPath;
    QVERIFY(server.start(config));

    const QByteArray response = httpRequest(server.port(), authGet("/logs/recent?lines=2"));
    QCOMPARE(statusCode(response), 200);
    const QJsonArray lines = responseObject(response).value("lines").toArray();
    QCOMPARE(lines.size(), 2);
    QCOMPARE(lines.at(0).toString(), QString("line-09998"));
    QCOMPARE(lines.at(1).toString(), QString("line-09999"));
}

void TestLocalControlServer::testIssueReportFailureReturnsServerError() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString blockedPath = dir.filePath("not-a-directory");
    QFile blocker(blockedPath);
    QVERIFY(blocker.open(QIODevice::WriteOnly));
    blocker.write("blocked");
    blocker.close();

    versus::control::LocalControlServer server;
    versus::control::LocalControlServerConfig config;
    config.token = "test-token";
    config.discoveryPath = dir.filePath("control.json");
    config.reportDir = blockedPath;
    QVERIFY(server.start(config));

    const QByteArray response = httpRequest(
        server.port(),
        authPost("/commands", R"({"command":"issue_report"})"));
    QCOMPARE(statusCode(response), 500);
    QVERIFY(!responseObject(response).value("ok").toBool());
}

void TestLocalControlServer::testStopCommand() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());

    bool stopped = false;
    bool quit = false;
    versus::control::LocalControlServer server;
    server.setStopCallback([&stopped]() {
        stopped = true;
    });
    server.setQuitCallback([&quit]() {
        quit = true;
    });

    versus::control::LocalControlServerConfig config;
    config.token = "test-token";
    config.discoveryPath = dir.filePath("control.json");
    QVERIFY(server.start(config));

    const QByteArray response = httpRequest(server.port(), authPost("/commands", R"({"command":"stop"})"));
    QCOMPARE(statusCode(response), 200);
    QVERIFY(responseObject(response).value("ok").toBool());
    QVERIFY(stopped);

    const QByteArray quitResponse = httpRequest(server.port(), authPost("/commands", R"({"command":"quit"})"));
    QCOMPARE(statusCode(quitResponse), 200);
    QVERIFY(responseObject(quitResponse).value("ok").toBool());
    QTRY_VERIFY_WITH_TIMEOUT(quit, 1000);
}

void TestLocalControlServer::testFailedStartDoesNotRemoveDiscovery() {
    QTemporaryDir dir;
    QVERIFY(dir.isValid());

    const QString discoveryPath = dir.filePath("control.json");
    versus::control::LocalControlServer first;
    versus::control::LocalControlServerConfig firstConfig;
    firstConfig.token = "test-token";
    firstConfig.discoveryPath = discoveryPath;
    QVERIFY(first.start(firstConfig));
    QVERIFY(QFile::exists(discoveryPath));

    {
        versus::control::LocalControlServer second;
        versus::control::LocalControlServerConfig secondConfig;
        secondConfig.token = "other-token";
        secondConfig.port = first.port();
        secondConfig.discoveryPath = discoveryPath;
        QVERIFY(!second.start(secondConfig));
    }

    QVERIFY(QFile::exists(discoveryPath));
}

QTEST_MAIN(TestLocalControlServer)
#include "test_local_control_server.moc"
