#include "versus/platform/linux_network.h"
#include <QEventLoop>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSslCertificate>
#include <QSslConfiguration>
#include <QTimer>
#include <algorithm>

namespace versus::platform {
std::string linuxSystemCaCertificatesPem() {
    static const std::string roots = [] {
        QByteArray pem;
        for (const auto &certificate : QSslConfiguration::systemCaCertificates()) pem += certificate.toPem();
        return pem.toStdString();
    }();
    return roots;
}
webrtc::TurnRegistryHttpResponse linuxFetchTurnRegistry(const webrtc::TurnRegistryRequest &input) {
    webrtc::TurnRegistryHttpResponse result;
    const QUrl url(QString::fromStdString(input.url));
    if (url.scheme() != "https" || url.host() != "turnservers.vdo.ninja" || !url.userInfo().isEmpty()) return result;
    QNetworkAccessManager manager;
    QNetworkRequest request(url);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    const int timeoutMs = std::clamp(input.timeoutMs, 100, 10000);
    request.setTransferTimeout(timeoutMs);
    auto *reply = manager.get(request);
    reply->setReadBufferSize(1024 * 1024 + 1);
    QEventLoop loop;
    QTimer timeout; timeout.setSingleShot(true);
    QByteArray body;
    bool oversized = false, expired = false;
    QObject::connect(reply, &QNetworkReply::readyRead, &loop, [&] {
        body += reply->readAll();
        if (body.size() > 1024 * 1024) { oversized = true; reply->abort(); }
    });
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timeout, &QTimer::timeout, &loop, [&] { expired = true; reply->abort(); loop.quit(); });
    timeout.start(timeoutMs);
    if (!reply->isFinished()) loop.exec();
    body += reply->readAll();
    if (!oversized && !expired && body.size() <= 1024 * 1024 && reply->error() == QNetworkReply::NoError) {
        result.transportSucceeded = true;
        result.httpStatus = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        result.body = body.toStdString();
    }
    delete reply;
    return result;
}
}
