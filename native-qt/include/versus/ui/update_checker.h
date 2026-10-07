#pragma once

#include <QObject>
#include <QTimer>

namespace versus::ui {

inline constexpr const char *ReleasesUrl = "https://github.com/steveseguin/game-capture/releases";
inline constexpr const char *LatestReleaseApi =
    "https://api.github.com/repos/steveseguin/game-capture/releases/latest";

enum class UpdateStatus { Checking, UpToDate, Available, Unavailable };
struct UpdateResult {
    UpdateStatus status = UpdateStatus::Unavailable;
    QString version;
};

UpdateResult evaluateRelease(const QByteArray &json, const QString &installedVersion);

// Injectable transport for deterministic gates; production always uses the fixed HTTPS API.
class ReleaseRequest : public QObject {
    Q_OBJECT
  public:
    using QObject::QObject;
    virtual void start(const QString &installedVersion) = 0;
    virtual void cancel() = 0;
  signals:
    void finished(int httpStatus, const QByteArray &body);
};

class UpdateChecker final : public QObject {
    Q_OBJECT
  public:
    UpdateChecker(const QString &installedVersion, const QString &cachePath,
                  QObject *parent = nullptr, ReleaseRequest *request = nullptr);
    ~UpdateChecker() override;
    const UpdateResult &result() const { return result_; }
    void checkForUpdates();
    void shutdown();
  signals:
    void statusChanged();
  private:
    void finishCheck(int httpStatus, const QByteArray &body);
    void saveCache();
    QString installedVersion_;
    QString cachePath_;
    ReleaseRequest *request_;
    QTimer timer_;
    QTimer deadline_;
    qint64 lastAttempt_ = 0;
    qint64 lastSuccess_ = 0;
    QByteArray release_;
    bool lastAttemptSucceeded_ = false;
    bool pending_ = false;
    bool stopped_ = false;
    UpdateResult result_;
};

} // namespace versus::ui
