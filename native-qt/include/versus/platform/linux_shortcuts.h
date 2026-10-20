#pragma once
#include <QObject>
#include <QDBusObjectPath>
#include <QVariantMap>
#include <memory>

namespace versus::platform {
// Owns only this application's grabs/portal session. All operations run on the
// GUI thread; teardown releases push-to-talk before closing the session.
class LinuxShortcuts : public QObject {
    Q_OBJECT
public:
    explicit LinuxShortcuts(QObject *parent = nullptr);
    ~LinuxShortcuts() override;
    void setEnabled(bool enabled);
signals:
    void activated(int action, bool pressed); // 0 live toggle, 1 mute, 2 hold-to-talk
    void statusChanged(const QString &message);
private slots:
    void response(uint code, const QVariantMap &results);
    void portalPressed(const QDBusObjectPath &, const QString &, qulonglong, const QVariantMap &);
    void portalReleased(const QDBusObjectPath &, const QString &, qulonglong, const QVariantMap &);
    void sessionClosed();
private:
    struct State;
    std::unique_ptr<State> state_;
    void close();
    void request(const QString &method, QVariantList arguments, QVariantMap options);
    void fail(const QString &message);
};
}
