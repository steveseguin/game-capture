#include "versus/ui/update_checker.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSettings>
#include <QSslConfiguration>
#include <QSslSocket>
#include <QTemporaryDir>
#include <array>
#include <optional>

namespace versus::ui {
namespace {
constexpr qint64 CheckInterval = 24 * 60 * 60;
constexpr qsizetype MaxResponseBytes = 1024 * 1024;
constexpr qsizetype MaxCacheBytes = 16 * 1024;

class QtReleaseRequest final : public ReleaseRequest {
  public:
    explicit QtReleaseRequest(QObject *parent) : ReleaseRequest(parent) {
        connectionTimeout_.setSingleShot(true);
        connectionTimeout_.setTimerType(Qt::PreciseTimer);
        connect(&connectionTimeout_, &QTimer::timeout, this, [this] {
            cancel();
            emit finished(0, {});
        });
        connect(&manager_, &QNetworkAccessManager::authenticationRequired, this, [this] {
            cancel();
            emit finished(0, {});
        });
        connect(&manager_, &QNetworkAccessManager::proxyAuthenticationRequired, this, [this] {
            cancel();
            emit finished(0, {});
        });
    }
    ~QtReleaseRequest() override { cancel(); }

    void start(const QString &installedVersion) override {
        cancel();
        body_.clear();
        if (!QSslSocket::supportsSsl()) {
            emit finished(0, {});
            return;
        }
        // A dedicated manager shares neither cookies nor authentication with app traffic.
        // Clear connections so each request gets its own bounded TLS handshake.
        manager_.clearConnectionCache();
        QNetworkRequest request{QUrl(QString::fromLatin1(LatestReleaseApi))};
        request.setRawHeader("Accept", "application/vnd.github+json");
        request.setRawHeader("X-GitHub-Api-Version", "2022-11-28");
        request.setRawHeader("User-Agent", "game-capture/" + installedVersion.toUtf8());
        request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
        request.setAttribute(QNetworkRequest::CookieLoadControlAttribute, QNetworkRequest::Manual);
        request.setAttribute(QNetworkRequest::CookieSaveControlAttribute, QNetworkRequest::Manual);
        request.setAttribute(QNetworkRequest::AuthenticationReuseAttribute, QNetworkRequest::Manual);
        request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
        auto ssl = QSslConfiguration::defaultConfiguration();
        ssl.setPeerVerifyMode(QSslSocket::VerifyPeer);
        request.setSslConfiguration(ssl);
        reply_ = manager_.get(request);
        reply_->setReadBufferSize(64 * 1024);
        connectionTimeout_.start(10000);
        connect(reply_, &QNetworkReply::encrypted, this, [this] { connectionTimeout_.stop(); });
        connect(reply_, &QNetworkReply::metaDataChanged, this, [this] {
            connectionTimeout_.stop();
            if (reply_->header(QNetworkRequest::ContentLengthHeader).toLongLong() > MaxResponseBytes) {
                cancel();
                emit finished(0, {});
            }
        });
        connect(reply_, &QIODevice::readyRead, this, [this] { receive(); });
        connect(reply_, &QNetworkReply::finished, this, [this] {
            if (!receive()) return;
            const int status = reply_->error() == QNetworkReply::NoError
                ? reply_->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() : 0;
            cancel();
            emit finished(status, body_);
        });
    }

    void cancel() override {
        connectionTimeout_.stop();
        if (reply_) {
            auto *reply = reply_;
            reply_ = nullptr;
            disconnect(reply, nullptr, this, nullptr);
            reply->abort();
            reply->deleteLater();
        }
    }

  private:
    bool receive() {
        if (!reply_) return false;
        body_ += reply_->read(MaxResponseBytes + 1 - body_.size());
        if (body_.size() <= MaxResponseBytes) return true;
        cancel();
        emit finished(0, {});
        return false;
    }
    QNetworkAccessManager manager_;
    QNetworkReply *reply_ = nullptr;
    QTimer connectionTimeout_;
    QByteArray body_;
};

struct Version {
    std::array<QString, 3> parts;
    bool prerelease = false;
};

std::optional<Version> parseVersion(const QString &text) {
    static const QRegularExpression pattern(
        R"(^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$)");
    const auto match = pattern.match(text);
    if (!match.hasMatch() || match.capturedLength() != text.size()) return std::nullopt;
    Version version;
    for (int i = 0; i < 3; ++i) version.parts[i] = match.captured(i + 1);
    version.prerelease = !match.captured(4).isEmpty();
    for (const auto &identifier : match.captured(4).split('.')) {
        if (identifier.size() > 1 && identifier.startsWith('0') &&
            identifier.indexOf(QRegularExpression("[^0-9]")) == -1) return std::nullopt;
    }
    return version;
}

int compareCore(const Version &a, const Version &b) {
    // Compare numeric identifiers without integer overflow, including large valid SemVer values.
    for (size_t i = 0; i < a.parts.size(); ++i) {
        if (a.parts[i].size() != b.parts[i].size()) return a.parts[i].size() > b.parts[i].size() ? 1 : -1;
        const int order = QString::compare(a.parts[i], b.parts[i]);
        if (order) return order;
    }
    return 0;
}

qint64 secondsUntilCheck(qint64 lastAttempt) {
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    if (lastAttempt <= 0 || lastAttempt > now || now - lastAttempt >= CheckInterval) return 0;
    return CheckInterval - (now - lastAttempt);
}
} // namespace

UpdateResult evaluateRelease(const QByteArray &json, const QString &installedVersion) {
    if (json.size() > MaxResponseBytes) return {};
    const auto document = QJsonDocument::fromJson(json);
    if (!document.isObject()) return {};
    const auto release = document.object();
    if (!release["draft"].isBool() || release["draft"].toBool() ||
        !release["prerelease"].isBool() || release["prerelease"].toBool() ||
        !release["tag_name"].isString()) return {};
    const auto tag = release["tag_name"].toString();
    if (tag.size() > 256 || installedVersion.size() > 256) return {};
    const auto latest = parseVersion(tag);
    const auto installed = parseVersion(installedVersion);
    // Flags alone are insufficient: a prerelease tag must never be recommended.
    if (!latest || latest->prerelease || !installed) return {};
    const int order = compareCore(*latest, *installed);
    const bool newer = order > 0 || (order == 0 && installed->prerelease);
    return {newer ? UpdateStatus::Available : UpdateStatus::UpToDate, tag.startsWith('v') ? tag.mid(1) : tag};
}

UpdateChecker::UpdateChecker(const QString &installedVersion, const QString &cachePath,
                             QObject *parent, ReleaseRequest *request)
    : QObject(parent), installedVersion_(installedVersion), cachePath_(cachePath),
      request_(request ? request : new QtReleaseRequest(this)) {
    // Bound local cache reads as well as network responses.
    if (!cachePath_.isEmpty() && QFileInfo(cachePath_).size() <= MaxCacheBytes) {
        QSettings cache(cachePath_, QSettings::IniFormat);
        lastAttempt_ = cache.value("LastAttempt", 0).toLongLong();
        lastSuccess_ = cache.value("LastSuccess", 0).toLongLong();
        lastAttemptSucceeded_ = cache.value("LastAttemptSucceeded", false).toBool();
        release_ = cache.value("Release").toByteArray();
        if (lastAttemptSucceeded_ && lastSuccess_ >= lastAttempt_ &&
            secondsUntilCheck(lastAttempt_) > 0 && secondsUntilCheck(lastSuccess_) > 0) {
            result_ = evaluateRelease(release_, installedVersion_);
        }
    }
    timer_.setSingleShot(true);
    connect(&timer_, &QTimer::timeout, this, &UpdateChecker::checkForUpdates);
    deadline_.setSingleShot(true);
    deadline_.setTimerType(Qt::PreciseTimer);
    connect(&deadline_, &QTimer::timeout, this, [this] {
        request_->cancel();
        finishCheck(0, {});
    });
    connect(request_, &ReleaseRequest::finished, this, &UpdateChecker::finishCheck);
    connect(qApp, &QCoreApplication::aboutToQuit, this, &UpdateChecker::shutdown);
    timer_.start(static_cast<int>(secondsUntilCheck(lastAttempt_) * 1000 + 5000));
}

UpdateChecker::~UpdateChecker() { shutdown(); }

void UpdateChecker::checkForUpdates() {
    if (stopped_ || pending_) return;
    const auto remaining = secondsUntilCheck(lastAttempt_);
    if (remaining > 0) {
        timer_.start(static_cast<int>(remaining * 1000));
        return;
    }
    lastAttempt_ = QDateTime::currentSecsSinceEpoch();
    lastAttemptSucceeded_ = false;
    // Persist before starting: crashes, offline restarts and rate limits cannot cause a request loop.
    saveCache();
    pending_ = true;
    result_ = {UpdateStatus::Checking, {}};
    emit statusChanged();
    deadline_.start(15000);
    request_->start(installedVersion_);
}

void UpdateChecker::finishCheck(int httpStatus, const QByteArray &body) {
    if (stopped_ || !pending_) return;
    pending_ = false;
    deadline_.stop();
    result_ = httpStatus == 200 ? evaluateRelease(body, installedVersion_) : UpdateResult{};
    lastAttemptSucceeded_ = result_.status != UpdateStatus::Unavailable;
    if (lastAttemptSucceeded_) {
        lastSuccess_ = QDateTime::currentSecsSinceEpoch();
        release_ = QJsonDocument(QJsonObject{{"tag_name", result_.version}, {"draft", false}, {"prerelease", false}})
                       .toJson(QJsonDocument::Compact);
    }
    // Keep the last valid metadata, but never present a failed refresh as proof of being current.
    saveCache();
    timer_.start(static_cast<int>(secondsUntilCheck(lastAttempt_) * 1000));
    emit statusChanged();
}

void UpdateChecker::saveCache() {
    if (cachePath_.isEmpty() || !QDir().mkpath(QFileInfo(cachePath_).absolutePath())) return;
    // QSettings::sync on a shared INI can wait 30 seconds for another process's
    // lock, blocking the UI before even starting the network deadline. Serialize
    // through a private file, then replace this best-effort cache atomically.
    // This also avoids reading an oversized/corrupt old cache while saving.
    QTemporaryDir temporary(QFileInfo(cachePath_).absolutePath() + "/update-check-XXXXXX");
    if (!temporary.isValid()) return;
    const auto temporaryPath = temporary.filePath("cache.ini");
    {
        QSettings cache(temporaryPath, QSettings::IniFormat);
        cache.setValue("LastAttempt", lastAttempt_);
        cache.setValue("LastSuccess", lastSuccess_);
        cache.setValue("LastAttemptSucceeded", lastAttemptSucceeded_);
        cache.setValue("Release", release_);
        cache.sync();
        if (cache.status() != QSettings::NoError) return;
    }
    QFile input(temporaryPath);
    if (!input.open(QIODevice::ReadOnly)) return;
    const auto serialized = input.read(MaxCacheBytes + 1);
    if (serialized.size() > MaxCacheBytes) return;
    QSaveFile output(cachePath_);
    if (!output.open(QIODevice::WriteOnly)) return;
    if (output.write(serialized) == serialized.size()) output.commit();
}

void UpdateChecker::shutdown() {
    stopped_ = true;
    timer_.stop();
    deadline_.stop();
    pending_ = false;
    request_->cancel();
}

} // namespace versus::ui
