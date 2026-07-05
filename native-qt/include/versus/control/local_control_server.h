#pragma once

#include <QByteArray>
#include <QHash>
#include <QJsonArray>
#include <QObject>
#include <QString>

#include <functional>

class QTcpServer;
class QTcpSocket;

namespace versus::control {

struct LocalControlServerConfig {
    quint16 port = 0;
    QString token;
    QString discoveryPath;
    QString logPath;
    QString reportDir;
};

class LocalControlServer : public QObject {
    Q_OBJECT

  public:
    using DiagnosticsProvider = std::function<QByteArray()>;
    using SourcesProvider = std::function<QJsonArray()>;
    using StopCallback = std::function<void()>;
    using QuitCallback = std::function<void()>;

    explicit LocalControlServer(QObject *parent = nullptr);
    ~LocalControlServer() override;

    bool start(const LocalControlServerConfig &config);
    void stop();

    bool isRunning() const;
    quint16 port() const;
    QString token() const;
    QString discoveryPath() const;

    void setDiagnosticsProvider(DiagnosticsProvider provider);
    void setWindowSourcesProvider(SourcesProvider provider);
    void setSpoutSourcesProvider(SourcesProvider provider);
    void setAudioInputSourcesProvider(SourcesProvider provider);
    void setStopCallback(StopCallback callback);
    void setQuitCallback(QuitCallback callback);

    static QString defaultDiscoveryPath();
    static QString defaultReportDir();
    static QString generateToken();

  private:
    struct HttpRequest {
        QByteArray method;
        QString path;
        QHash<QByteArray, QByteArray> headers;
        QByteArray body;
    };

    void handleReadyRead(QTcpSocket *socket);
    bool tryParseRequest(QTcpSocket *socket, HttpRequest &request);
    void routeRequest(QTcpSocket *socket, const HttpRequest &request);
    bool isAuthorized(const HttpRequest &request) const;
    void sendJson(QTcpSocket *socket, int status, const QByteArray &body);
    void sendError(QTcpSocket *socket, int status, const QString &message);
    QByteArray healthJson() const;
    QByteArray schemaJson() const;
    QByteArray sourcesJson(const SourcesProvider &provider) const;
    QByteArray recentLogJson(int maxLines) const;
    QByteArray issueReportJson(const QByteArray &requestBody);
    bool writeDiscoveryFile();
    void removeDiscoveryFile();

    QTcpServer *server_ = nullptr;
    LocalControlServerConfig config_;
    DiagnosticsProvider diagnosticsProvider_;
    SourcesProvider windowSourcesProvider_;
    SourcesProvider spoutSourcesProvider_;
    SourcesProvider audioInputSourcesProvider_;
    StopCallback stopCallback_;
    QuitCallback quitCallback_;
    QHash<QTcpSocket*, QByteArray> buffers_;
    bool discoveryFileWritten_ = false;
};

}  // namespace versus::control
