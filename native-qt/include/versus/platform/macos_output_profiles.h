#pragma once
#include <QByteArray>
#include <QString>

namespace versus::platform {
// The settings file contains only an opaque reference. The complete profile,
// including URLs that may embed credentials, lives in the user's Keychain.
struct OutputProfileResult {
    QByteArray value;
    QString error;
    bool ok() const { return error.isEmpty(); }
};
OutputProfileResult loadOutputProfiles(const QByteArray &reference);
OutputProfileResult saveOutputProfiles(const QByteArray &data, const QByteArray &reference);
OutputProfileResult deleteOutputProfiles(const QByteArray &reference);
}
