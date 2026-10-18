#include "versus/platform/app_paths.h"
#include <QDir>
#include <QStandardPaths>
namespace versus::platform {
QString logDirectory() {
    auto base = qEnvironmentVariable("XDG_STATE_HOME");
    if (!QDir::isAbsolutePath(base)) base = QDir::home().filePath(".local/state");
    const auto path = QDir(base).filePath("GameCapture/logs");
    QDir().mkpath(path);
    return path;
}
QString dataDirectory() {
    const auto path = QDir(QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation)).filePath("GameCapture");
    QDir().mkpath(path);
    return path;
}
}
