#include "versus/platform/app_paths.h"

#include <QDir>
#include <QStandardPaths>

namespace versus::platform {

QString logDirectory() {
    const auto path = QDir(QDir::homePath()).filePath("Library/Logs/GameCapture");
    QDir().mkpath(path);
    return path;
}

QString dataDirectory() {
    const auto base = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
    const auto path = QDir(base).filePath("GameCapture");
    QDir().mkpath(path);
    return path;
}

} // namespace versus::platform
