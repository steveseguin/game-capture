#pragma once
#include <QByteArray>
#include <QString>

namespace versus::platform {
// Settings contain only an opaque reference. Complete destination profiles,
// including URLs with credentials, live in the user's native secret store.
struct OutputProfileResult {
    QByteArray value;
    QString error;
    bool ok() const { return error.isEmpty(); }
};
OutputProfileResult loadOutputProfiles(const QByteArray &reference);
OutputProfileResult saveOutputProfiles(const QByteArray &data, const QByteArray &reference);
OutputProfileResult deleteOutputProfiles(const QByteArray &reference);
}
