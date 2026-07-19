#include "versus/control/local_control_server.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRandomGenerator>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>
#include <QUrl>
#include <QUrlQuery>

#include <algorithm>
#include <utility>

#include <spdlog/spdlog.h>

namespace versus::control {

namespace {

constexpr qsizetype kMaxRequestBytes = 1024 * 1024;
constexpr int kDefaultLogLines = 250;

QByteArray reasonPhrase(int status) {
    switch (status) {
        case 200:
            return "OK";
        case 201:
            return "Created";
        case 400:
            return "Bad Request";
        case 401:
            return "Unauthorized";
        case 404:
            return "Not Found";
        case 500:
            return "Internal Server Error";
        default:
            return "Error";
    }
}

QString appDataPath(const QString &leaf) {
#ifdef _WIN32
    const QString base = qEnvironmentVariable("LOCALAPPDATA");
    QDir dir(base.isEmpty() ? QDir::currentPath() : base);
#else
    QDir dir(QDir::homePath());
#endif
    if (!dir.exists("GameCapture")) {
        dir.mkpath("GameCapture");
    }
    dir.cd("GameCapture");
    return dir.filePath(leaf);
}

bool ensureParentDir(const QString &path) {
    const QFileInfo info(path);
    const QDir parent = info.dir();
    return parent.exists() || QDir().mkpath(parent.absolutePath());
}

QJsonDocument jsonDocumentFromBytes(const QByteArray &bytes) {
    QJsonParseError error{};
    const QJsonDocument doc = QJsonDocument::fromJson(bytes, &error);
    if (error.error != QJsonParseError::NoError) {
        return {};
    }
    return doc;
}

QByteArray bearerValue(const QByteArray &value) {
    const QByteArray prefix = "Bearer ";
    if (value.size() >= prefix.size() &&
        value.left(prefix.size()).compare(prefix, Qt::CaseInsensitive) == 0) {
        return value.mid(prefix.size()).trimmed();
    }
    return {};
}

QString timestampForFile() {
    return QDateTime::currentDateTimeUtc().toString("yyyyMMdd-HHmmss-zzz");
}

QJsonArray readLogTail(const QString &path, int maxLines) {
    QJsonArray lines;
    if (path.isEmpty() || maxLines <= 0) {
        return lines;
    }
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        return lines;
    }

    constexpr qint64 kReadChunkBytes = 64 * 1024;
    constexpr qint64 kMaximumTailBytes = 2 * 1024 * 1024;
    QByteArray tail;
    qint64 position = file.size();
    qsizetype newlineCount = 0;
    while (position > 0 && newlineCount <= maxLines && tail.size() < kMaximumTailBytes) {
        const qint64 remainingCapacity = kMaximumTailBytes - tail.size();
        const qint64 bytesToRead = std::min({position, kReadChunkBytes, remainingCapacity});
        position -= bytesToRead;
        if (!file.seek(position)) {
            return {};
        }
        const QByteArray chunk = file.read(bytesToRead);
        if (chunk.size() != bytesToRead) {
            return {};
        }
        newlineCount += chunk.count('\n');
        tail.prepend(chunk);
    }

    if (position > 0) {
        const qsizetype firstCompleteLine = tail.indexOf('\n');
        if (firstCompleteLine < 0) {
            return lines;
        }
        tail.remove(0, firstCompleteLine + 1);
    }

    QStringList tailLines = QString::fromUtf8(tail).split('\n');
    if (!tailLines.isEmpty() && tailLines.constLast().isEmpty()) {
        tailLines.removeLast();
    }
    const qsizetype firstLine = std::max<qsizetype>(0, tailLines.size() - maxLines);
    for (qsizetype i = firstLine; i < tailLines.size(); ++i) {
        QString line = tailLines.at(i);
        if (line.endsWith('\r')) {
            line.chop(1);
        }
        lines.append(line);
    }
    return lines;
}

}  // namespace

LocalControlServer::LocalControlServer(QObject *parent)
    : QObject(parent),
      server_(new QTcpServer(this)) {
    connect(server_, &QTcpServer::newConnection, this, [this]() {
        while (server_->hasPendingConnections()) {
            QTcpSocket *socket = server_->nextPendingConnection();
            buffers_.insert(socket, {});
            connect(socket, &QTcpSocket::readyRead, this, [this, socket]() {
                handleReadyRead(socket);
            });
            connect(socket, &QTcpSocket::disconnected, this, [this, socket]() {
                buffers_.remove(socket);
                socket->deleteLater();
            });
        }
    });
}

LocalControlServer::~LocalControlServer() {
    stop();
}

bool LocalControlServer::start(const LocalControlServerConfig &config) {
    if (server_->isListening()) {
        return true;
    }

    config_ = config;
    if (config_.token.isEmpty()) {
        config_.token = generateToken();
    }
    if (config_.discoveryPath.isEmpty()) {
        config_.discoveryPath = defaultDiscoveryPath();
    }
    if (config_.reportDir.isEmpty()) {
        config_.reportDir = defaultReportDir();
    }

    if (!server_->listen(QHostAddress::LocalHost, config_.port)) {
        spdlog::warn("[LocalControl] Failed to listen on 127.0.0.1:{} ({})",
                     config_.port,
                     server_->errorString().toStdString());
        return false;
    }

    discoveryFileWritten_ = writeDiscoveryFile();
    if (!discoveryFileWritten_) {
        spdlog::warn("[LocalControl] Started but failed to write discovery file");
    }
    spdlog::info("[LocalControl] Listening on http://127.0.0.1:{} discovery={}",
                 port(),
                 config_.discoveryPath.toStdString());
    return true;
}

void LocalControlServer::stop() {
    if (!server_) {
        return;
    }
    if (server_->isListening()) {
        server_->close();
    }
    const auto sockets = buffers_.keys();
    for (QTcpSocket *socket : sockets) {
        if (socket) {
            socket->disconnectFromHost();
        }
    }
    buffers_.clear();
    removeDiscoveryFile();
}

bool LocalControlServer::isRunning() const {
    return server_ && server_->isListening();
}

quint16 LocalControlServer::port() const {
    return server_ ? server_->serverPort() : 0;
}

QString LocalControlServer::token() const {
    return config_.token;
}

QString LocalControlServer::discoveryPath() const {
    return config_.discoveryPath;
}

void LocalControlServer::setDiagnosticsProvider(DiagnosticsProvider provider) {
    diagnosticsProvider_ = std::move(provider);
}

void LocalControlServer::setWindowSourcesProvider(SourcesProvider provider) {
    windowSourcesProvider_ = std::move(provider);
}

void LocalControlServer::setSpoutSourcesProvider(SourcesProvider provider) {
    spoutSourcesProvider_ = std::move(provider);
}

void LocalControlServer::setAudioInputSourcesProvider(SourcesProvider provider) {
    audioInputSourcesProvider_ = std::move(provider);
}

void LocalControlServer::setStopCallback(StopCallback callback) {
    stopCallback_ = std::move(callback);
}

void LocalControlServer::setQuitCallback(QuitCallback callback) {
    quitCallback_ = std::move(callback);
}

QString LocalControlServer::defaultDiscoveryPath() {
    return appDataPath("control.json");
}

QString LocalControlServer::defaultReportDir() {
    return appDataPath("reports");
}

QString LocalControlServer::generateToken() {
    QByteArray bytes;
    bytes.reserve(32);
    for (int i = 0; i < 4; ++i) {
        const quint64 value = QRandomGenerator::global()->generate64();
        bytes.append(QByteArray::number(static_cast<qulonglong>(value), 16).rightJustified(16, '0'));
    }
    return QString::fromLatin1(bytes);
}

void LocalControlServer::handleReadyRead(QTcpSocket *socket) {
    if (!socket) {
        return;
    }
    buffers_[socket].append(socket->readAll());
    if (buffers_[socket].size() > kMaxRequestBytes) {
        sendError(socket, 400, "Request too large");
        return;
    }

    HttpRequest request;
    if (!tryParseRequest(socket, request)) {
        return;
    }
    routeRequest(socket, request);
}

bool LocalControlServer::tryParseRequest(QTcpSocket *socket, HttpRequest &request) {
    QByteArray &buffer = buffers_[socket];
    const qsizetype headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
        return false;
    }

    const QByteArray headerBytes = buffer.left(headerEnd);
    const QList<QByteArray> lines = headerBytes.split('\n');
    if (lines.empty()) {
        sendError(socket, 400, "Malformed HTTP request");
        return false;
    }

    const QList<QByteArray> requestLine = lines[0].trimmed().split(' ');
    if (requestLine.size() < 2) {
        sendError(socket, 400, "Malformed HTTP request line");
        return false;
    }

    request.method = requestLine[0].trimmed().toUpper();
    request.path = QString::fromUtf8(requestLine[1].trimmed());
    for (int i = 1; i < lines.size(); ++i) {
        const QByteArray line = lines[i].trimmed();
        const qsizetype colon = line.indexOf(':');
        if (colon <= 0) {
            continue;
        }
        request.headers.insert(line.left(colon).trimmed().toLower(), line.mid(colon + 1).trimmed());
    }

    const int contentLength = request.headers.value("content-length").toInt();
    const qsizetype totalNeeded = headerEnd + 4 + std::max(0, contentLength);
    if (buffer.size() < totalNeeded) {
        return false;
    }
    request.body = buffer.mid(headerEnd + 4, std::max(0, contentLength));
    buffer.remove(0, totalNeeded);
    return true;
}

void LocalControlServer::routeRequest(QTcpSocket *socket, const HttpRequest &request) {
    const QUrl url(request.path);
    const QString path = url.path();

    if (request.method == "GET" && path == "/health") {
        sendJson(socket, 200, healthJson());
        return;
    }

    if (!isAuthorized(request)) {
        sendError(socket, 401, "Missing or invalid local control token");
        return;
    }

    if (request.method == "GET" && path == "/diagnostics") {
        if (!diagnosticsProvider_) {
            sendError(socket, 500, "Diagnostics provider unavailable");
            return;
        }
        sendJson(socket, 200, diagnosticsProvider_());
        return;
    }

    if (request.method == "GET" && path == "/schema") {
        sendJson(socket, 200, schemaJson());
        return;
    }

    if (request.method == "GET" && path == "/sources/windows") {
        sendJson(socket, 200, sourcesJson(windowSourcesProvider_));
        return;
    }
    if (request.method == "GET" && path == "/sources/spout") {
        sendJson(socket, 200, sourcesJson(spoutSourcesProvider_));
        return;
    }
    if (request.method == "GET" && path == "/sources/audio-inputs") {
        sendJson(socket, 200, sourcesJson(audioInputSourcesProvider_));
        return;
    }
    if (request.method == "GET" && path == "/logs/recent") {
        const int lines = std::clamp(url.query().contains("lines=")
                                         ? QUrlQuery(url).queryItemValue("lines").toInt()
                                         : kDefaultLogLines,
                                     1,
                                     2000);
        sendJson(socket, 200, recentLogJson(lines));
        return;
    }
    if (request.method == "POST" && path == "/commands") {
        const QJsonDocument doc = jsonDocumentFromBytes(request.body);
        if (!doc.isObject()) {
            sendError(socket, 400, "Expected JSON object command body");
            return;
        }
        const QJsonObject body = doc.object();
        const QString command = body.value("command").toString().trimmed();
        if (command == "stop") {
            if (stopCallback_) {
                stopCallback_();
            }
            sendJson(socket, 200, R"({"ok":true,"command":"stop"})");
            return;
        }
        if (command == "quit") {
            sendJson(socket, 200, R"({"ok":true,"command":"quit"})");
            QTimer::singleShot(100, this, [this]() {
                if (quitCallback_) {
                    quitCallback_();
                } else {
                    QCoreApplication::quit();
                }
            });
            return;
        }
        if (command == "export_diagnostics") {
            if (!diagnosticsProvider_) {
                sendError(socket, 500, "Diagnostics provider unavailable");
                return;
            }
            QString pathOut = body.value("path").toString();
            if (pathOut.isEmpty()) {
                QDir().mkpath(config_.reportDir);
                pathOut = QDir(config_.reportDir).filePath(QString("diagnostics-%1.json").arg(timestampForFile()));
            }
            if (!ensureParentDir(pathOut)) {
                sendError(socket, 500, "Could not create diagnostics output directory");
                return;
            }
            QFile file(pathOut);
            if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
                sendError(socket, 500, "Could not write diagnostics file");
                return;
            }
            file.write(diagnosticsProvider_());
            file.write("\n");
            QJsonObject response{{"ok", true}, {"command", command}, {"path", pathOut}};
            sendJson(socket, 200, QJsonDocument(response).toJson(QJsonDocument::Compact));
            return;
        }
        if (command == "issue_report") {
            const QByteArray response = issueReportJson(request.body);
            const QJsonDocument responseDoc = jsonDocumentFromBytes(response);
            const bool created = responseDoc.isObject() && responseDoc.object().value("ok").toBool();
            sendJson(socket, created ? 201 : 500, response);
            return;
        }
        sendError(socket, 400, "Unknown command");
        return;
    }

    sendError(socket, 404, "Unknown local control endpoint");
}

bool LocalControlServer::isAuthorized(const HttpRequest &request) const {
    if (config_.token.isEmpty()) {
        return false;
    }
    const QByteArray authToken = bearerValue(request.headers.value("authorization"));
    if (QString::fromUtf8(authToken) == config_.token) {
        return true;
    }
    return QString::fromUtf8(request.headers.value("x-game-capture-token")) == config_.token;
}

void LocalControlServer::sendJson(QTcpSocket *socket, int status, const QByteArray &body) {
    const QByteArray response =
        "HTTP/1.1 " + QByteArray::number(status) + " " + reasonPhrase(status) + "\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n"
        "Content-Length: " + QByteArray::number(body.size()) + "\r\n\r\n" +
        body;
    socket->write(response);
    socket->disconnectFromHost();
}

void LocalControlServer::sendError(QTcpSocket *socket, int status, const QString &message) {
    QJsonObject error{{"ok", false}, {"error", message}};
    sendJson(socket, status, QJsonDocument(error).toJson(QJsonDocument::Compact));
}

QByteArray LocalControlServer::healthJson() const {
    QJsonObject health{
        {"ok", true},
        {"schema", "game-capture-local-control-v1"},
        {"pid", QCoreApplication::applicationPid()},
        {"version", QString(APP_VERSION)},
        {"port", static_cast<int>(port())},
        {"auth", "bearer"},
    };
    return QJsonDocument(health).toJson(QJsonDocument::Compact);
}

QByteArray LocalControlServer::schemaJson() const {
    QJsonObject root;
    root["ok"] = true;
    root["schema"] = "game-capture-local-control-v1";
    root["transport"] = "http-json-loopback";
    root["auth"] = "Authorization: Bearer <token>";
    root["notes"] = "Local control is opt-in, bound to 127.0.0.1, and intended for same-user automation.";
    root["endpoints"] = QJsonArray{
        QJsonObject{{"method", "GET"}, {"path", "/health"}, {"auth_required", false}},
        QJsonObject{{"method", "GET"}, {"path", "/schema"}, {"auth_required", true}},
        QJsonObject{{"method", "GET"}, {"path", "/diagnostics"}, {"auth_required", true}},
        QJsonObject{{"method", "GET"}, {"path", "/sources/windows"}, {"auth_required", true}},
        QJsonObject{{"method", "GET"}, {"path", "/sources/spout"}, {"auth_required", true}},
        QJsonObject{{"method", "GET"}, {"path", "/sources/audio-inputs"}, {"auth_required", true}},
        QJsonObject{{"method", "GET"}, {"path", "/logs/recent?lines=250"}, {"auth_required", true}},
        QJsonObject{{"method", "POST"}, {"path", "/commands"}, {"auth_required", true}},
    };
    root["commands"] = QJsonArray{
        QJsonObject{
            {"command", "stop"},
            {"description", "Stop the active stream and capture without closing the app."},
            {"body", QJsonObject{{"command", "stop"}}},
        },
        QJsonObject{
            {"command", "quit"},
            {"description", "Stop capture/stream state through the app callback, then quit the process."},
            {"body", QJsonObject{{"command", "quit"}}},
        },
        QJsonObject{
            {"command", "export_diagnostics"},
            {"description", "Write the current diagnostics JSON to the provided path or the default reports folder."},
            {"body", QJsonObject{{"command", "export_diagnostics"}, {"path", "<optional-path>"}}},
        },
        QJsonObject{
            {"command", "issue_report"},
            {"description", "Write diagnostics, recent logs, and optional notes to a report JSON file."},
            {"body", QJsonObject{{"command", "issue_report"}, {"notes", "<optional-notes>"}}},
        },
    };
    return QJsonDocument(root).toJson(QJsonDocument::Compact);
}

QByteArray LocalControlServer::sourcesJson(const SourcesProvider &provider) const {
    QJsonObject root{{"ok", true}, {"sources", provider ? provider() : QJsonArray{}}};
    return QJsonDocument(root).toJson(QJsonDocument::Compact);
}

QByteArray LocalControlServer::recentLogJson(int maxLines) const {
    QJsonObject root{
        {"ok", true},
        {"path", config_.logPath},
        {"lines", readLogTail(config_.logPath, maxLines)},
    };
    return QJsonDocument(root).toJson(QJsonDocument::Compact);
}

QByteArray LocalControlServer::issueReportJson(const QByteArray &requestBody) {
    const QJsonDocument commandDoc = jsonDocumentFromBytes(requestBody);
    const QJsonObject command = commandDoc.isObject() ? commandDoc.object() : QJsonObject{};
    if (!QDir(config_.reportDir).exists() && !QDir().mkpath(config_.reportDir)) {
        QJsonObject error{{"ok", false}, {"error", "Could not create issue report directory"}, {"path", config_.reportDir}};
        return QJsonDocument(error).toJson(QJsonDocument::Compact);
    }
    const QString reportPath = QDir(config_.reportDir).filePath(QString("issue-report-%1.json").arg(timestampForFile()));

    QJsonObject report;
    report["schema"] = "game-capture-issue-report-v1";
    report["generated_utc"] = QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs);
    report["notes"] = command.value("notes").toString();
    report["log_path"] = config_.logPath;
    report["log_tail"] = readLogTail(config_.logPath, kDefaultLogLines);

    if (diagnosticsProvider_) {
        const QJsonDocument diagnosticsDoc = jsonDocumentFromBytes(diagnosticsProvider_());
        report["diagnostics"] = diagnosticsDoc.isObject() ? diagnosticsDoc.object() : QJsonObject{};
    }

    QFile file(reportPath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        QJsonObject error{{"ok", false}, {"error", "Could not write issue report"}, {"path", reportPath}};
        return QJsonDocument(error).toJson(QJsonDocument::Compact);
    }
    const QByteArray reportBytes = QJsonDocument(report).toJson(QJsonDocument::Indented);
    if (file.write(reportBytes) != reportBytes.size() ||
        file.write("\n") != 1 ||
        !file.flush()) {
        file.close();
        QFile::remove(reportPath);
        QJsonObject error{{"ok", false}, {"error", "Could not write issue report"}, {"path", reportPath}};
        return QJsonDocument(error).toJson(QJsonDocument::Compact);
    }

    QJsonObject response{{"ok", true}, {"command", "issue_report"}, {"path", reportPath}};
    return QJsonDocument(response).toJson(QJsonDocument::Compact);
}

bool LocalControlServer::writeDiscoveryFile() {
    if (config_.discoveryPath.isEmpty() || !ensureParentDir(config_.discoveryPath)) {
        return false;
    }
    QJsonObject root{
        {"schema", "game-capture-local-control-v1"},
        {"pid", QCoreApplication::applicationPid()},
        {"version", QString(APP_VERSION)},
        {"host", "127.0.0.1"},
        {"port", static_cast<int>(port())},
        {"base_url", QString("http://127.0.0.1:%1").arg(port())},
        {"token", config_.token},
        {"auth_header", "Authorization: Bearer <token>"},
        {"created_utc", QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)},
        {"endpoints", QJsonArray{
            "/health",
            "/diagnostics",
            "/schema",
            "/sources/windows",
            "/sources/spout",
            "/sources/audio-inputs",
            "/logs/recent",
            "/commands",
        }},
        {"commands", QJsonArray{"stop", "quit", "export_diagnostics", "issue_report"}},
    };
    QFile file(config_.discoveryPath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        return false;
    }
    file.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
    file.write("\n");
    return true;
}

void LocalControlServer::removeDiscoveryFile() {
    if (config_.discoveryPath.isEmpty() || !discoveryFileWritten_) {
        return;
    }
    QFile::remove(config_.discoveryPath);
    discoveryFileWritten_ = false;
}

}  // namespace versus::control
