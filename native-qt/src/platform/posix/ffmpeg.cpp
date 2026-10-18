#include "versus/platform/posix_ffmpeg.h"
#include <QCoreApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QProcess>
#include <QStandardPaths>
#include <csignal>
#include <unistd.h>

namespace versus::platform {
namespace {
std::filesystem::path candidate(const QString &value) {
    if (value.trimmed().isEmpty()) return {};
    QFileInfo info(value.trimmed());
    if (info.isDir()) info.setFile(QDir(info.absoluteFilePath()).filePath("ffmpeg"));
    if (!info.isFile() || !info.isExecutable()) return {};
    return std::filesystem::path(info.absoluteFilePath().toStdString()).lexically_normal();
}
QString bundledPath() {
#ifdef __APPLE__
    return QDir(QCoreApplication::applicationDirPath()).absoluteFilePath("../Helpers/ffmpeg");
#else
    return QDir(QCoreApplication::applicationDirPath()).absoluteFilePath("../lib/game-capture/ffmpeg");
#endif
}
bool allowSystem() {
    const auto value = qEnvironmentVariable("VERSUS_ALLOW_SYSTEM_FFMPEG").trimmed().toLower();
    return value == "1" || value == "true" || value == "yes" || value == "on";
}
}
std::filesystem::path resolvePosixFfmpeg(const std::string &configured) {
    const auto value = QString::fromStdString(configured).trimmed();
    if (!value.isEmpty()) return candidate(value); // Explicit invalid paths never fall back.
    if (auto bundled = candidate(bundledPath()); !bundled.empty()) return bundled;
    if (auto override = qEnvironmentVariable("VERSUS_FFMPEG_PATH"); !override.isEmpty()) return candidate(override);
#ifdef __APPLE__
    if (!allowSystem()) return {};
#endif
    // Linux packages declare a versioned distribution FFmpeg dependency.
    for (auto name : {"FFMPEG_PATH", "FFMPEG_EXE"})
        if (auto override = qEnvironmentVariable(name); !override.isEmpty()) return candidate(override);
    return candidate(QStandardPaths::findExecutable("ffmpeg"));
}
bool isBundledPosixFfmpeg(const std::filesystem::path &path) {
    return !path.empty() && path.lexically_normal() == std::filesystem::path(bundledPath().toStdString()).lexically_normal();
}
bool isPosixFfmpegOverride(const std::string &configured, const std::filesystem::path &resolved) {
    return !QString::fromStdString(configured).trimmed().isEmpty() ||
        (!isBundledPosixFfmpeg(resolved) && (!qEnvironmentVariableIsEmpty("VERSUS_FFMPEG_PATH") || allowSystem()));
}
FfmpegCommandResult runPosixFfmpegProbe(const std::filesystem::path &executable, const std::vector<std::string> &arguments) {
    FfmpegCommandResult result;
    QProcess child;
    child.setProcessChannelMode(QProcess::MergedChannels);
    child.setStandardInputFile(QProcess::nullDevice());
    // A probe override may spawn descendants. Retire only this owned session,
    // including its children, if it stalls or exceeds the output budget.
    child.setChildProcessModifier([] { ::setsid(); });
    QStringList args;
    for (const auto &arg : arguments) args.append(QString::fromStdString(arg));
    QElapsedTimer timer; timer.start();
    child.start(QString::fromStdString(executable.string()), args, QIODevice::ReadOnly);
    if (!child.waitForStarted(1000)) return result;
    result.started = true;
    const qint64 pid = child.processId();
    constexpr qsizetype maxOutput = 2 * 1024 * 1024;
    QByteArray output;
    bool overflow = false;
    while (true) {
        child.waitForReadyRead(25);
        const auto bytes = child.readAll();
        if (bytes.size() > maxOutput - output.size()) { overflow = true; break; }
        output += bytes;
        if (child.state() == QProcess::NotRunning) break;
        if (timer.elapsed() >= 3000) { result.timedOut = true; break; }
    }
    if (overflow || result.timedOut) {
        if (pid > 1) ::kill(-static_cast<pid_t>(pid), SIGKILL);
        child.kill(); child.waitForFinished(1000);
    }
    result.output.assign(output.constData(), output.size());
    if (!overflow && !result.timedOut && child.exitStatus() == QProcess::NormalExit) result.exitCode = child.exitCode();
    return result;
}
}
