#include "versus/ui/main_window.h"

#include <QAbstractItemView>
#include <QApplication>
#include <QClipboard>
#include <QColorDialog>
#include <QCoreApplication>
#include <QDesktopServices>
#include <QDir>
#include <QCursor>
#include <QEvent>
#include <QFileInfo>
#include <QFormLayout>
#include <QFontDatabase>
#include <QFrame>
#include <QGuiApplication>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QIcon>
#include <QMenuBar>
#include <QMetaObject>
#include <QMessageBox>
#include <QPainter>
#include <QPointer>
#include <QProcess>
#include <QSettings>
#include <QToolTip>
#include <QScrollArea>
#include <QSignalBlocker>
#include <QSplitter>
#include <QStandardPaths>
#include <QStyle>
#include <QStringList>
#include <QUrlQuery>
#include <QUrl>
#include <QVBoxLayout>
#include <QtConcurrent/QtConcurrentRun>

#include <spdlog/spdlog.h>

#include <algorithm>
#include <cmath>
#include <exception>

namespace versus::ui {

#ifndef APP_VERSION
#define APP_VERSION "dev"
#endif

// Dark theme colors
static const QString COLOR_BG = "#0b1016";
static const QString COLOR_INPUT = "#101b27";
static const QString COLOR_ACCENT = "#00c2ff";
static const QString COLOR_ACCENT_HOVER = "#3dd8ff";
static const QString COLOR_TEXT = "#eaf4ff";
static const QString COLOR_TEXT_DIM = "#89a2ba";
static const QString COLOR_RED = "#ff4d5a";
static const QString COLOR_YELLOW = "#f0b84d";
static const QString APP_WINDOW_TITLE = "Game Capture - Powered by VDO.Ninja";
static const QString APP_BRAND = "Game Capture";
static const QString APP_TRAY_IDLE = "Game Capture - Idle";
static const QString APP_TRAY_LIVE = "Game Capture - LIVE";
static const QString APP_VERSION_TEXT = QStringLiteral(APP_VERSION);
static const QString APP_SETTINGS_ORG = "VDO.Ninja";
static const QString APP_SETTINGS_NAME = "Game Capture";

QString percentText(double value) {
    if (value < 0.0) {
        return QStringLiteral("-");
    }
    return QString("%1%").arg(std::clamp(value, 0.0, 100.0), 0, 'f', 0);
}

QString systemResourceColor(double cpuPercent, double memoryPercent) {
    const double highestUsage = std::max(cpuPercent, memoryPercent);
    if (highestUsage >= 90.0) {
        return COLOR_RED;
    }
    if (highestUsage >= 75.0) {
        return COLOR_YELLOW;
    }
    return COLOR_TEXT_DIM;
}

versus::video::VideoCodec codecFromUiValue(const QString &value) {
    if (value == "h265") {
        return versus::video::VideoCodec::H265;
    }
    if (value == "av1") {
        return versus::video::VideoCodec::AV1;
    }
    if (value == "vp9") {
        return versus::video::VideoCodec::VP9;
    }
    if (value == "vp8") {
        return versus::video::VideoCodec::VP8;
    }
    return versus::video::VideoCodec::H264;
}

bool codecUsesExternalFfmpeg(versus::video::VideoCodec codec) {
    return codec != versus::video::VideoCodec::H264;
}

bool codecSupportsAlphaWorkflow(versus::video::VideoCodec codec) {
    return codec == versus::video::VideoCodec::H264 ||
           codec == versus::video::VideoCodec::AV1 ||
           codec == versus::video::VideoCodec::VP9;
}

QString codecTooltipFor(versus::video::VideoCodec codec) {
    if (codec == versus::video::VideoCodec::H265) {
        return "H.265 is experimental and may not decode in Chromium-based viewers. Game Capture will fall back to "
               "H.264 if startup or encode stability fails.";
    }
    if (codec == versus::video::VideoCodec::AV1) {
        return "AV1 publish is experimental. Game Capture will try the selected encoder preference and fall back to "
               "H.264 if startup or encode stability fails. Alpha-preserving AV1 paths vary by viewer; the current "
               "OBS VDO.Ninja transparency workflow uses VP9 instead.";
    }
    if (codec == versus::video::VideoCodec::VP9) {
        return "VP9 publish is experimental and software-heavy. Game Capture will fall back to H.264 if startup or "
               "encode stability fails. Transparency in OBS requires the VDO.Ninja OBS plugin native receiver; "
               "browser viewers stay standard color video.";
    }
    if (codec == versus::video::VideoCodec::H264) {
        return "H.264 supports hardware encoding. With alpha workflow enabled, Game Capture sends H.264 color plus a "
               "separate CPU-encoded VP9 alpha mask for the OBS native receiver.";
    }
    return QString();
}

QString alphaWorkflowTextFor(versus::video::VideoCodec codec) {
    if (codec == versus::video::VideoCodec::H264) {
        return "Enable OBS alpha workflow (H.264 + VP9 mask)";
    }
    if (codec == versus::video::VideoCodec::VP9) {
        return "Enable OBS alpha workflow (preview)";
    }
    if (codec == versus::video::VideoCodec::AV1) {
        return "Enable alpha-preserving encode (experimental)";
    }
    return "Enable alpha workflow (experimental)";
}

QString alphaWorkflowTooltipFor(versus::video::VideoCodec codec) {
    if (codec == versus::video::VideoCodec::H264) {
        return "Requires the VDO.Ninja OBS plugin with Native Receiver enabled. Color uses the selected H.264 encoder "
               "and transparency uses a separate CPU-encoded VP9 alpha mask, so bundled FFmpeg/libvpx is still required.";
    }
    if (codec == versus::video::VideoCodec::VP9) {
        return "Requires the VDO.Ninja OBS plugin with Native Receiver enabled. Browser Sources and normal browser "
               "viewers do not composite this alpha track. VP9 alpha uses software libvpx in realtime mode with the "
               "fastest cpu-used setting; lower resolution/FPS if CPU load is high.";
    }
    if (codec == versus::video::VideoCodec::AV1) {
        return "AV1 alpha is experimental and viewer support varies. For the current OBS VDO.Ninja transparency "
               "workflow, use VP9 with alpha enabled.";
    }
    return "Alpha workflow is only available with codecs that preserve alpha data.";
}

versus::video::AlphaBackgroundMode alphaBackgroundModeFromUiValue(const QString &value) {
    if (value == "chroma") {
        return versus::video::AlphaBackgroundMode::Chroma;
    }
    if (value == "opaque") {
        return versus::video::AlphaBackgroundMode::Opaque;
    }
    return versus::video::AlphaBackgroundMode::None;
}

QString colorToHex(const QColor &color) {
    return color.isValid()
        ? color.name(QColor::HexRgb).toUpper()
        : QStringLiteral("#00FF00");
}

versus::webrtc::IceMode iceModeFromUiValue(const QString &value) {
    if (value == "host-only") {
        return versus::webrtc::IceMode::HostOnly;
    }
    if (value == "relay") {
        return versus::webrtc::IceMode::Relay;
    }
    if (value == "stun-only") {
        return versus::webrtc::IceMode::StunOnly;
    }
    return versus::webrtc::IceMode::StunOnly;
}

versus::app::AudioSourceMode audioSourceModeFromUiValue(const QString &value) {
    if (value == "default-output") {
        return versus::app::AudioSourceMode::DefaultOutput;
    }
    if (value == "communications-output") {
        return versus::app::AudioSourceMode::CommunicationsOutput;
    }
    if (value == "default-microphone") {
        return versus::app::AudioSourceMode::DefaultMicrophone;
    }
    if (value == "none") {
        return versus::app::AudioSourceMode::None;
    }
    return versus::app::AudioSourceMode::SelectedWindow;
}

versus::app::VideoSourceMode videoSourceModeFromUiValue(const QString &value) {
    if (value == "spout") {
        return versus::app::VideoSourceMode::Spout;
    }
    return versus::app::VideoSourceMode::Window;
}

QSettings makeUiSettings() {
    return QSettings(APP_SETTINGS_ORG, APP_SETTINGS_NAME);
}

class ComboWheelGuard final : public QObject {
  public:
    explicit ComboWheelGuard(QObject *parent) : QObject(parent) {}

  protected:
    bool eventFilter(QObject *watched, QEvent *event) override {
        if (event->type() != QEvent::Wheel) {
            return QObject::eventFilter(watched, event);
        }

        auto *combo = qobject_cast<QComboBox *>(watched);
        if (!combo) {
            return QObject::eventFilter(watched, event);
        }

        if (combo->view() && combo->view()->isVisible()) {
            return QObject::eventFilter(watched, event);
        }

        event->ignore();
        return true;
    }
};

void restoreComboByData(QComboBox *combo, const QVariant &data) {
    if (!combo || !data.isValid()) {
        return;
    }
    const int index = combo->findData(data);
    if (index >= 0) {
        combo->setCurrentIndex(index);
    }
}

void installComboWheelGuard(QComboBox *combo) {
    if (!combo) {
        return;
    }
    combo->installEventFilter(new ComboWheelGuard(combo));
}

void setSensitiveFieldVisible(QLineEdit *input, QPushButton *toggle, bool visible, const QString &label) {
    if (!input || !toggle) {
        return;
    }

    input->setEchoMode(visible ? QLineEdit::Normal : QLineEdit::Password);
    toggle->setText(visible ? "Hide" : "Show");
    toggle->setToolTip(QString("%1 %2").arg(visible ? "Hide" : "Show", label));
}

void setSensitiveRevealEnabled(QLineEdit *input, QPushButton *toggle, bool enabled, const QString &label) {
    if (!input || !toggle) {
        return;
    }

    toggle->setEnabled(enabled);
    if (!enabled && toggle->isChecked()) {
        QSignalBlocker blocker(toggle);
        toggle->setChecked(false);
        setSensitiveFieldVisible(input, toggle, false, label);
    }
}

QWidget *wrapSensitiveLineEdit(QLineEdit *input,
                               QPushButton **toggleOut,
                               const QString &label,
                               QWidget *parent) {
    if (!input) {
        return nullptr;
    }

    input->setEchoMode(QLineEdit::Password);

    auto *wrapper = new QWidget(parent);
    auto *layout = new QHBoxLayout(wrapper);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(6);
    layout->addWidget(input, 1);

    auto *toggle = new QPushButton("Show", wrapper);
    toggle->setCheckable(true);
    toggle->setFixedWidth(58);
    toggle->setCursor(Qt::PointingHandCursor);
    toggle->setToolTip(QString("Show %1").arg(label));
    QObject::connect(toggle, &QPushButton::toggled, input, [input, toggle, label](bool checked) {
        setSensitiveFieldVisible(input, toggle, checked, label);
    });

    layout->addWidget(toggle);
    if (toggleOut) {
        *toggleOut = toggle;
    }
    return wrapper;
}

QString audioDeviceLabel(const versus::audio::AudioDeviceInfo &device) {
    QString label = QString::fromStdString(device.name.empty() ? std::string("Microphone/input device") : device.name);
    if (device.isDefault) {
        label += " (Default)";
    }
    if (device.sampleRate > 0 && device.channels > 0) {
        label += QString(" - %1 kHz, %2 ch")
            .arg(device.sampleRate / 1000.0, 0, 'f', device.sampleRate % 1000 == 0 ? 0 : 1)
            .arg(device.channels);
    }
    return label;
}

QIcon makeTrayLiveIcon(const QIcon &baseIcon, bool live) {
    if (baseIcon.isNull() || !live) {
        return baseIcon;
    }

    const QSize iconSize(32, 32);
    QPixmap pixmap = baseIcon.pixmap(iconSize);
    if (pixmap.isNull()) {
        return baseIcon;
    }

    QPainter painter(&pixmap);
    painter.setRenderHint(QPainter::Antialiasing, true);

    const int diameter = std::max(8, iconSize.width() / 3);
    const int margin = 2;
    const QRect dotRect(iconSize.width() - diameter - margin, margin, diameter, diameter);

    painter.setPen(QPen(QColor("#ffffff"), 1));
    painter.setBrush(QColor("#ff3b30"));
    painter.drawEllipse(dotRect);
    painter.end();

    return QIcon(pixmap);
}

QIcon makeBrandTrayFallbackIcon() {
    const QSize iconSize(64, 64);
    QPixmap pixmap(iconSize);
    pixmap.fill(Qt::transparent);

    QPainter painter(&pixmap);
    painter.setRenderHint(QPainter::Antialiasing, true);
    painter.setPen(Qt::NoPen);
    painter.setBrush(QColor("#ff2f5d"));
    painter.drawRoundedRect(QRectF(2.0, 2.0, 60.0, 60.0), 14.0, 14.0);

    QFont markFont("Bahnschrift SemiBold", 34);
    if (!QFontDatabase().families().contains(markFont.family())) {
        markFont = QFont("Segoe UI", 32, QFont::Bold);
    }
    painter.setFont(markFont);
    painter.setPen(Qt::white);
    painter.drawText(pixmap.rect(), Qt::AlignCenter, "N");
    painter.end();

    return QIcon(pixmap);
}

QString defaultLogFolderPath() {
    QString localAppData = qEnvironmentVariable("LOCALAPPDATA");
    if (localAppData.isEmpty()) {
        localAppData = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    } else {
        localAppData = QDir(localAppData).filePath("GameCapture/logs");
    }
    if (localAppData.isEmpty()) {
        localAppData = QDir::currentPath();
    }
    QDir().mkpath(localAppData);
    return QDir(localAppData).absolutePath();
}

#ifdef _WIN32
struct FirewallRuleState {
    bool present = false;
    bool programMatchesCurrentExe = false;
    QString programPath;
    QString details;
};

QString normalizedAbsolutePath(const QString &path) {
    const QFileInfo info(path);
    const QString resolved = info.canonicalFilePath().isEmpty()
        ? info.absoluteFilePath()
        : info.canonicalFilePath();
    return QDir::toNativeSeparators(resolved).toLower();
}

bool currentExecutableLooksInstalled(const QString &exePath) {
    const QString normalizedExe = normalizedAbsolutePath(exePath);
    const QStringList roots = {
        qEnvironmentVariable("ProgramFiles"),
        qEnvironmentVariable("ProgramFiles(x86)")
    };

    for (const QString &root : roots) {
        if (root.isEmpty()) {
            continue;
        }
        const QString installedRoot = normalizedAbsolutePath(QDir(root).filePath("Game Capture"));
        if (!installedRoot.isEmpty() && normalizedExe.startsWith(installedRoot + "\\")) {
            return true;
        }
    }
    return false;
}

bool envFlagEnabled(const char *name) {
    const QString value = qEnvironmentVariable(name).trimmed().toLower();
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

bool suppressFirewallWarningUi(const QString &exePath) {
    if (envFlagEnabled("GAME_CAPTURE_SUPPRESS_FIREWALL_WARNING")) {
        return true;
    }
    return QFileInfo(exePath).baseName().startsWith("test_", Qt::CaseInsensitive);
}

FirewallRuleState queryFirewallRuleForCurrentExe() {
    FirewallRuleState state;
    const QString currentExe = normalizedAbsolutePath(QCoreApplication::applicationFilePath());

    QProcess netsh;
    netsh.start(
        "netsh",
        QStringList{
            "advfirewall",
            "firewall",
            "show",
            "rule",
            "name=Game Capture WebRTC UDP",
            "verbose"
        });
    if (!netsh.waitForFinished(2500)) {
        netsh.kill();
        netsh.waitForFinished(500);
        state.details = "netsh timed out";
        return state;
    }

    const QString output = QString::fromLocal8Bit(netsh.readAllStandardOutput()) +
                           QString::fromLocal8Bit(netsh.readAllStandardError());
    state.details = output.trimmed();
    state.present = netsh.exitStatus() == QProcess::NormalExit && netsh.exitCode() == 0 &&
                    output.contains("Rule Name:", Qt::CaseInsensitive);

    const QStringList lines = output.split('\n');
    for (QString line : lines) {
        line = line.trimmed();
        if (!line.startsWith("Program:", Qt::CaseInsensitive)) {
            continue;
        }
        const int separator = line.indexOf(':');
        if (separator >= 0) {
            state.programPath = line.mid(separator + 1).trimmed();
            state.programMatchesCurrentExe = normalizedAbsolutePath(state.programPath) == currentExe;
        }
        break;
    }

    return state;
}
#endif

MainWindow::ParsedStreamTarget MainWindow::parseStreamTargetInput(const QString &input) {
    ParsedStreamTarget parsed;
    const QString trimmed = input.trimmed();
    if (trimmed.isEmpty()) {
        return parsed;
    }

    const bool looksLikeUrl = trimmed.startsWith("http://", Qt::CaseInsensitive) ||
                              trimmed.startsWith("https://", Qt::CaseInsensitive) ||
                              trimmed.contains("vdo.ninja/", Qt::CaseInsensitive);
    if (!looksLikeUrl) {
        parsed.streamId = trimmed;
        parsed.valid = true;
        return parsed;
    }

    QUrl url(trimmed);
    if (!url.isValid()) {
        return parsed;
    }

    parsed.isUrl = true;
    QUrlQuery query(url);
    parsed.streamId = query.queryItemValue("push").trimmed();
    if (parsed.streamId.isEmpty()) {
        parsed.streamId = query.queryItemValue("view").trimmed();
    }
    if (parsed.streamId.isEmpty()) {
        parsed.streamId = query.queryItemValue("streamid").trimmed();
    }
    parsed.room = query.queryItemValue("room").trimmed();
    parsed.password = query.queryItemValue("password").trimmed();
    parsed.valid = !parsed.streamId.isEmpty();
    return parsed;
}

MainWindow::MainWindow(versus::app::VersusApp *core, QWidget *parent)
    : QMainWindow(parent)
    , core_(core) {
    setWindowTitle(APP_WINDOW_TITLE);

    setupMenuBar();
    applyDarkTheme();
    setupUI();
    loadPersistedSettings();
    connectPersistedSettingSignals();
    setupTrayIcon();
    QTimer::singleShot(0, this, &MainWindow::showFirewallWarningIfNeeded);

    // Stats timer (update every second when live)
    statsTimer_ = new QTimer(this);
    statsTimer_->setInterval(1000);
    connect(statsTimer_, &QTimer::timeout, this, &MainWindow::onStatsTimer);

    // Preview timer for selected window thumbnail
    previewTimer_ = new QTimer(this);
    previewTimer_->setInterval(1500);
    connect(previewTimer_, &QTimer::timeout, this, &MainWindow::refreshSelectedWindowPreview);
    previewTimer_->start();

    stopWatchdogTimer_ = new QTimer(this);
    stopWatchdogTimer_->setSingleShot(true);
    stopWatchdogTimer_->setInterval(12000);
    connect(stopWatchdogTimer_, &QTimer::timeout, this, [this]() {
        const bool stopPending = stopFuture_.isValid() && !stopFuture_.isFinished();
        if (!stopPending) {
            return;
        }
        forceQuitEnabled_ = true;
        updateStatus("Stop is taking longer than expected. Choose Quit to force close the app.", "error");
        updateGoLiveButton();
    });

    // Initial window list
    refreshWindowList();
    refreshSelectedWindowPreview();

    if (core_) {
        core_->onRuntimeEvent([this](const std::string &message, bool fatal) {
            const QString status = QString::fromStdString(message);
            QMetaObject::invokeMethod(this, [this, status, fatal]() {
                if (status.isEmpty()) {
                    return;
                }

                const QString lower = status.toLower();
                const bool reconnectingMsg = lower.contains("attempting to reconnect") ||
                                             lower.contains("still reconnecting");
                const bool reconnectedMsg = lower.contains("reconnected to signaling server");
                const bool disconnectedMsg = lower.contains("connection dropped");
                const bool remoteHangupMsg = lower.contains("remote vdo.ninja hangup");

                QString statusClass = "ready";
                if (fatal && remoteHangupMsg) {
                    statusClass = "idle";
                } else if (fatal) {
                    statusClass = "error";
                } else if (reconnectingMsg || disconnectedMsg) {
                    statusClass = "connecting";
                } else if (isLive_) {
                    statusClass = "live";
                }
                updateStatus(status, statusClass);

                if (trayIcon_ && trayIcon_->supportsMessages()) {
                    if (fatal && remoteHangupMsg) {
                        trayIcon_->showMessage(APP_BRAND, status, QSystemTrayIcon::Information, 3000);
                    } else if (fatal) {
                        trayIcon_->showMessage(APP_BRAND, status, QSystemTrayIcon::Warning, 5000);
                    } else if ((reconnectingMsg || disconnectedMsg) && !isVisible() && !reconnectNoticeActive_) {
                        trayIcon_->showMessage(
                            APP_BRAND,
                            "Connection dropped. Attempting to reconnect...",
                            QSystemTrayIcon::Information,
                            4000);
                        reconnectNoticeActive_ = true;
                    } else if (reconnectedMsg && reconnectNoticeActive_ && !isVisible()) {
                        trayIcon_->showMessage(
                            APP_BRAND,
                            "Reconnected to signaling server.",
                            QSystemTrayIcon::Information,
                            3000);
                        reconnectNoticeActive_ = false;
                    } else if (reconnectedMsg) {
                        reconnectNoticeActive_ = false;
                    }
                } else if (reconnectedMsg) {
                    reconnectNoticeActive_ = false;
                }

                if (!fatal) {
                    return;
                }

                reconnectNoticeActive_ = false;

                if (core_ && isLive_) {
                    core_->stopLive();
                    core_->stopCapture();
                }
                isLive_ = false;
                if (statsTimer_) {
                    statsTimer_->stop();
                }
                if (previewTimer_) {
                    previewTimer_->start();
                }

                shareLabel_->clear();
                if (copyShareLinkButton_) {
                    copyShareLinkButton_->setEnabled(false);
                }
                if (openShareLinkButton_) {
                    openShareLinkButton_->setEnabled(false);
                }
                if (statsPanel_) {
                    statsPanel_->setVisible(false);
                    statsPanel_->clear();
                }
                resetOperatorHealthUi();
                if (encoderStatusLabel_) {
                    encoderStatusLabel_->setText("Active Encoder: (not streaming)");
                    encoderStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
                }

                if (trayIcon_) {
                    updateTrayLiveIndicator(false);
                }
                if (copyShareLinkAction_) {
                    copyShareLinkAction_->setEnabled(false);
                }
                if (copyShareLinkTrayAction_) {
                    copyShareLinkTrayAction_->setEnabled(false);
                }
                if (openShareLinkAction_) {
                    openShareLinkAction_->setEnabled(false);
                }
                if (openShareLinkTrayAction_) {
                    openShareLinkTrayAction_->setEnabled(false);
                }

                if (windowListWidget_) {
                    windowListWidget_->setAutoRefreshEnabled(true);
                }
                setConfigControlsEnabled(true);
                refreshSelectedWindowPreview();
                updateGoLiveButton();
            }, Qt::QueuedConnection);
        });
    }
}

void MainWindow::showFirewallWarningIfNeeded() {
#ifndef _WIN32
    return;
#else
    const QString currentExe = QCoreApplication::applicationFilePath();
    if (suppressFirewallWarningUi(currentExe)) {
        return;
    }

    const FirewallRuleState firewall = queryFirewallRuleForCurrentExe();
    if (firewall.present && firewall.programMatchesCurrentExe) {
        return;
    }

    QSettings settings = makeUiSettings();
    const QString dismissedPath = settings.value("network/firewallWarningDismissedForPath").toString();
    if (normalizedAbsolutePath(dismissedPath) == normalizedAbsolutePath(currentExe)) {
        return;
    }

    const bool installedPath = currentExecutableLooksInstalled(currentExe);
    const QString issue = firewall.present
        ? QString("The existing Windows Firewall rule points to:\n%1").arg(firewall.programPath)
        : QString("Windows Firewall does not have the Game Capture WebRTC UDP rule.");
    const QString guidance = installedPath
        ? "Re-run the Game Capture setup installer or add an inbound UDP allow rule for this executable."
        : "Portable and ZIP copies cannot add this rule automatically. Use the Game Capture setup installer or add an inbound UDP allow rule for this executable.";

    spdlog::warn("[UI] Windows Firewall rule is missing or does not match current executable: exe='{}' rulePresent={} ruleProgram='{}'",
                 currentExe.toStdString(),
                 firewall.present,
                 firewall.programPath.toStdString());

    settings.setValue("network/firewallWarningDismissedForPath", currentExe);
    QMessageBox::warning(
        this,
        "Windows Firewall May Block Direct Connections",
        QString("%1\n\n%2\n\nWithout this rule, WebRTC may fall back to relay servers or fail to connect directly.")
            .arg(issue, guidance));
#endif
}

MainWindow::~MainWindow() {
    if (core_) {
        core_->onRuntimeEvent(nullptr);
    }
    if (!forceQuitRequested_ && startFuture_.isValid()) {
        startFuture_.waitForFinished();
    }
    if (!forceQuitRequested_ && stopFuture_.isValid()) {
        stopFuture_.waitForFinished();
    }
}

bool MainWindow::hasPendingAsyncOperation() const {
    const bool startPending = startFuture_.isValid() && !startFuture_.isFinished();
    const bool stopPending = stopFuture_.isValid() && !stopFuture_.isFinished();
    return startPending || stopPending;
}

void MainWindow::maybeQuitAfterPendingOperations() {
    if (!quitRequested_ || !quitAfterPendingOps_ || hasPendingAsyncOperation()) {
        return;
    }

    quitAfterPendingOps_ = false;
    QMetaObject::invokeMethod(qApp, []() { QApplication::quit(); }, Qt::QueuedConnection);
}

void MainWindow::requestQuit() {
    quitRequested_ = true;
    if (hasPendingAsyncOperation()) {
        if (forceQuitEnabled_ || quitAfterPendingOps_) {
            forceQuitRequested_ = true;
            qApp->setProperty("force_exit_without_shutdown", true);
            qApp->quit();
            return;
        }
        quitAfterPendingOps_ = true;
        updateStatus("Waiting for the current stream operation to finish. Choose Quit again to force close.", "connecting");
        return;
    }

    quitAfterPendingOps_ = false;
    qApp->quit();
}

void MainWindow::loadPersistedSettings() {
    loadingPersistedSettings_ = true;

    QSettings settings = makeUiSettings();
    const QByteArray geometry = settings.value("window/geometry").toByteArray();
    if (!geometry.isEmpty()) {
        restoreGeometry(geometry);
    }

    if (streamIdInput_) {
        streamIdInput_->setText(settings.value("stream/target").toString());
    }
    if (roomInput_) {
        roomInput_->setText(settings.value("stream/room").toString());
    }
    if (passwordInput_) {
        passwordInput_->setText(settings.value("stream/password").toString());
    }
    if (labelInput_) {
        labelInput_->setText(settings.value("stream/label").toString());
    }
    if (advancedToggle_) {
        advancedToggle_->setChecked(settings.value("ui/advancedVisible", false).toBool());
    }
    if (customBitrateSpin_) {
        customBitrateSpin_->setValue(settings.value("video/customBitrateKbps", 12000).toInt());
    }
    if (viewerLimitSpin_) {
        viewerLimitSpin_->setValue(settings.value("stream/maxViewers", 10).toInt());
    }
    if (roomModeLqCheck_) {
        roomModeLqCheck_->setChecked(settings.value("stream/roomModeLqEnabled", true).toBool());
    }
    if (remoteControlTokenInput_) {
        remoteControlTokenInput_->setText(settings.value("control/token").toString());
    }
    if (ffmpegPathInput_) {
        ffmpegPathInput_->setText(settings.value("video/ffmpegPath").toString());
    }
    if (ffmpegOptionsInput_) {
        ffmpegOptionsInput_->setText(settings.value("video/ffmpegOptions").toString());
    }
    if (includeMicrophoneCheck_) {
        includeMicrophoneCheck_->setChecked(settings.value("audio/includeMicrophone", false).toBool());
    }
    if (primaryAudioGainSpin_) {
        primaryAudioGainSpin_->setValue(settings.value("audio/primaryGainPercent", 100).toInt());
    }
    if (microphoneAudioGainSpin_) {
        microphoneAudioGainSpin_->setValue(settings.value("audio/microphoneGainPercent", 100).toInt());
    }
    if (audioLimiterCheck_) {
        audioLimiterCheck_->setChecked(settings.value("audio/limiterEnabled", true).toBool());
    }

    restoreComboByData(resolutionSelect_, settings.value("video/resolution", "1920x1080"));
    restoreComboByData(fpsSelect_, settings.value("video/fps", 60));
    restoreComboByData(bitrateSelect_, settings.value("video/bitratePresetKbps", 12000));
    restoreComboByData(iceModeSelect_, settings.value("network/iceMode", "stun-only"));
    restoreComboByData(encoderSelect_, settings.value("video/encoderMode", "auto"));
    restoreComboByData(codecSelect_, settings.value("video/codec", "h264"));
    restoreComboByData(sourceModeSelect_, settings.value("video/sourceMode", "window"));
    restoreComboByData(audioSourceSelect_, settings.value("audio/source", "selected-window"));
    if (sourceModeSelect_ &&
        sourceModeSelect_->currentData().toString() == "spout" &&
        audioSourceSelect_ &&
        audioSourceSelect_->currentData().toString() == "selected-window") {
        restoreComboByData(audioSourceSelect_, QString("none"));
    }
    refreshMicrophoneDevices(settings.value("audio/microphoneDeviceId").toString());

    if (remoteControlCheck_) {
        remoteControlCheck_->setChecked(settings.value("control/enabled", false).toBool());
    }
    if (alphaWorkflowCheck_) {
        alphaWorkflowCheck_->setChecked(settings.value("video/alphaWorkflow", false).toBool());
    }
    if (alphaBackgroundModeSelect_) {
        restoreComboByData(alphaBackgroundModeSelect_, settings.value("video/alphaBackgroundMode", "none"));
    }
    alphaBackgroundColor_ = QColor(settings.value("video/alphaBackgroundColor", "#00FF00").toString());
    if (!alphaBackgroundColor_.isValid()) {
        alphaBackgroundColor_ = QColor(0, 255, 0);
    }
    updateAlphaBackgroundColorButton();

    minimizeToTrayOnClose_ = settings.value("ui/minimizeToTrayOnClose", true).toBool();
    if (minimizeToTrayOnCloseAction_) {
        minimizeToTrayOnCloseAction_->setChecked(minimizeToTrayOnClose_);
    }

    onBitratePresetChanged(bitrateSelect_ ? bitrateSelect_->currentIndex() : 0);
    syncCodecUiState();
    loadingPersistedSettings_ = false;
}

void MainWindow::savePersistedSettings() {
    if (loadingPersistedSettings_) {
        return;
    }

    QSettings settings = makeUiSettings();
    settings.setValue("window/geometry", saveGeometry());
    settings.setValue("stream/target", streamIdInput_ ? streamIdInput_->text().trimmed() : QString());
    settings.setValue("stream/room", roomInput_ ? roomInput_->text().trimmed() : QString());
    settings.setValue("stream/password", passwordInput_ ? passwordInput_->text() : QString());
    settings.setValue("stream/label", labelInput_ ? labelInput_->text() : QString());
    settings.setValue("stream/maxViewers", viewerLimitSpin_ ? viewerLimitSpin_->value() : 10);
    settings.setValue("stream/roomModeLqEnabled", roomModeLqCheck_ ? roomModeLqCheck_->isChecked() : true);
    settings.setValue("ui/advancedVisible", advancedToggle_ ? advancedToggle_->isChecked() : false);
    settings.setValue("ui/minimizeToTrayOnClose", minimizeToTrayOnClose_);
    settings.setValue("video/resolution", resolutionSelect_ ? resolutionSelect_->currentData().toString() : QString("1920x1080"));
    settings.setValue("video/fps", fpsSelect_ ? fpsSelect_->currentData().toInt() : 60);
    settings.setValue("video/bitratePresetKbps", bitrateSelect_ ? bitrateSelect_->currentData().toInt() : 12000);
    settings.setValue("video/customBitrateKbps", customBitrateSpin_ ? customBitrateSpin_->value() : 12000);
    settings.setValue("video/sourceMode", sourceModeSelect_ ? sourceModeSelect_->currentData().toString() : QString("window"));
    settings.setValue("video/encoderMode", encoderSelect_ ? encoderSelect_->currentData().toString() : QString("auto"));
    settings.setValue("video/codec", codecSelect_ ? codecSelect_->currentData().toString() : QString("h264"));
    settings.setValue("video/alphaWorkflow", alphaWorkflowCheck_ ? alphaWorkflowCheck_->isChecked() : false);
    settings.setValue("video/alphaBackgroundMode", alphaBackgroundModeSelect_ ? alphaBackgroundModeSelect_->currentData().toString() : QString("none"));
    settings.setValue("video/alphaBackgroundColor", colorToHex(alphaBackgroundColor_));
    settings.setValue("video/ffmpegPath", ffmpegPathInput_ ? ffmpegPathInput_->text().trimmed() : QString());
    settings.setValue("video/ffmpegOptions", ffmpegOptionsInput_ ? ffmpegOptionsInput_->text() : QString());
    settings.setValue("network/iceMode", iceModeSelect_ ? iceModeSelect_->currentData().toString() : QString("stun-only"));
    settings.setValue("audio/source", audioSourceSelect_ ? audioSourceSelect_->currentData().toString() : QString("selected-window"));
    settings.setValue("audio/includeMicrophone", includeMicrophoneCheck_ ? includeMicrophoneCheck_->isChecked() : false);
    settings.setValue("audio/microphoneDeviceId", microphoneDeviceSelect_ ? microphoneDeviceSelect_->currentData().toString() : QString());
    settings.setValue("audio/primaryGainPercent", primaryAudioGainSpin_ ? primaryAudioGainSpin_->value() : 100);
    settings.setValue("audio/microphoneGainPercent", microphoneAudioGainSpin_ ? microphoneAudioGainSpin_->value() : 100);
    settings.setValue("audio/limiterEnabled", audioLimiterCheck_ ? audioLimiterCheck_->isChecked() : true);
    settings.setValue("control/enabled", remoteControlCheck_ ? remoteControlCheck_->isChecked() : false);
    settings.setValue("control/token", remoteControlTokenInput_ ? remoteControlTokenInput_->text().trimmed() : QString());
    settings.sync();
}

void MainWindow::connectPersistedSettingSignals() {
    auto saveNow = [this]() {
        savePersistedSettings();
    };

    if (streamIdInput_) {
        connect(streamIdInput_, &QLineEdit::textChanged, this, saveNow);
    }
    if (roomInput_) {
        connect(roomInput_, &QLineEdit::textChanged, this, saveNow);
    }
    if (passwordInput_) {
        connect(passwordInput_, &QLineEdit::textChanged, this, saveNow);
    }
    if (labelInput_) {
        connect(labelInput_, &QLineEdit::textChanged, this, saveNow);
    }
    if (advancedToggle_) {
        connect(advancedToggle_, &QCheckBox::toggled, this, saveNow);
    }
    if (resolutionSelect_) {
        connect(resolutionSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (fpsSelect_) {
        connect(fpsSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (bitrateSelect_) {
        connect(bitrateSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (sourceModeSelect_) {
        connect(sourceModeSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (customBitrateSpin_) {
        connect(customBitrateSpin_, QOverload<int>::of(&QSpinBox::valueChanged), this, saveNow);
    }
    if (viewerLimitSpin_) {
        connect(viewerLimitSpin_, QOverload<int>::of(&QSpinBox::valueChanged), this, saveNow);
    }
    if (roomModeLqCheck_) {
        connect(roomModeLqCheck_, &QCheckBox::toggled, this, saveNow);
    }
    if (iceModeSelect_) {
        connect(iceModeSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (audioSourceSelect_) {
        connect(audioSourceSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (includeMicrophoneCheck_) {
        connect(includeMicrophoneCheck_, &QCheckBox::toggled, this, saveNow);
    }
    if (microphoneDeviceSelect_) {
        connect(microphoneDeviceSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (primaryAudioGainSpin_) {
        connect(primaryAudioGainSpin_, QOverload<int>::of(&QSpinBox::valueChanged), this, saveNow);
    }
    if (microphoneAudioGainSpin_) {
        connect(microphoneAudioGainSpin_, QOverload<int>::of(&QSpinBox::valueChanged), this, saveNow);
    }
    if (audioLimiterCheck_) {
        connect(audioLimiterCheck_, &QCheckBox::toggled, this, saveNow);
    }
    if (remoteControlCheck_) {
        connect(remoteControlCheck_, &QCheckBox::toggled, this, saveNow);
    }
    if (remoteControlTokenInput_) {
        connect(remoteControlTokenInput_, &QLineEdit::textChanged, this, saveNow);
    }
    if (encoderSelect_) {
        connect(encoderSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (codecSelect_) {
        connect(codecSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (alphaWorkflowCheck_) {
        connect(alphaWorkflowCheck_, &QCheckBox::toggled, this, saveNow);
    }
    if (alphaBackgroundModeSelect_) {
        connect(alphaBackgroundModeSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, saveNow);
    }
    if (ffmpegPathInput_) {
        connect(ffmpegPathInput_, &QLineEdit::textChanged, this, saveNow);
    }
    if (ffmpegOptionsInput_) {
        connect(ffmpegOptionsInput_, &QLineEdit::textChanged, this, saveNow);
    }
    if (minimizeToTrayOnCloseAction_) {
        connect(minimizeToTrayOnCloseAction_, &QAction::toggled, this, saveNow);
    }
}

void MainWindow::setupMenuBar() {
    auto *fileMenu = menuBar()->addMenu("&File");
    goLiveMenuAction_ = fileMenu->addAction("Go Live");
    goLiveMenuAction_->setEnabled(false);
    connect(goLiveMenuAction_, &QAction::triggered, this, &MainWindow::onGoLiveClicked);

    copyShareLinkAction_ = fileMenu->addAction("Copy Share Link");
    copyShareLinkAction_->setEnabled(false);
    connect(copyShareLinkAction_, &QAction::triggered, this, [this]() {
        if (!core_) {
            return;
        }
        const QString shareLink = QString::fromStdString(core_->getShareLink());
        if (shareLink.isEmpty()) {
            return;
        }
        QGuiApplication::clipboard()->setText(shareLink);
        updateStatus("Share link copied to clipboard", "ready");
    });

    openShareLinkAction_ = fileMenu->addAction("Open Share Link");
    openShareLinkAction_->setEnabled(false);
    connect(openShareLinkAction_, &QAction::triggered, this, [this]() {
        if (!core_) {
            return;
        }
        const QString shareLink = QString::fromStdString(core_->getShareLink());
        if (shareLink.isEmpty()) {
            return;
        }
        QDesktopServices::openUrl(QUrl(shareLink));
    });

    fileMenu->addSeparator();
    auto *quitAction = fileMenu->addAction("Quit");
    connect(quitAction, &QAction::triggered, this, [this]() {
        requestQuit();
    });

    auto *viewMenu = menuBar()->addMenu("&View");
    auto *refreshAction = viewMenu->addAction("Refresh Windows");
    connect(refreshAction, &QAction::triggered, this, [this]() {
        onRefreshWindows();
    });

    minimizeToTrayOnCloseAction_ = viewMenu->addAction("Minimize To Tray On Close");
    minimizeToTrayOnCloseAction_->setCheckable(true);
    minimizeToTrayOnCloseAction_->setChecked(minimizeToTrayOnClose_);
    connect(minimizeToTrayOnCloseAction_, &QAction::toggled, this, [this](bool checked) {
        minimizeToTrayOnClose_ = checked;
    });

    auto *helpMenu = menuBar()->addMenu("&Help");
    auto *aboutAction = helpMenu->addAction("About Game Capture");
    connect(aboutAction, &QAction::triggered, this, [this]() {
        QMessageBox::about(
            this,
            "About Game Capture",
            QString("%1\nVersion %2\nPowered by VDO.Ninja")
                .arg(APP_BRAND, APP_VERSION_TEXT));
    });
    helpMenu->addSeparator();
    auto *openLogsAction = helpMenu->addAction("Open Log Folder");
    connect(openLogsAction, &QAction::triggered, this, []() {
        QDesktopServices::openUrl(QUrl::fromLocalFile(defaultLogFolderPath()));
    });
    helpMenu->addSeparator();
    auto *openVdoAction = helpMenu->addAction("Open VDO.Ninja");
    connect(openVdoAction, &QAction::triggered, this, []() {
        QDesktopServices::openUrl(QUrl("https://vdo.ninja/"));
    });
}

void MainWindow::setupUI() {
    auto *content = new QWidget(this);
    auto *layout = new QVBoxLayout(content);
    layout->setSpacing(12);
    layout->setContentsMargins(16, 16, 16, 16);

    auto *sourceLayout = new QHBoxLayout();
    auto *sourceLabel = new QLabel("Video Source", this);
    sourceLabel->setStyleSheet(QString("color: %1; font-weight: 600;").arg(COLOR_TEXT_DIM));
    sourceModeSelect_ = new QComboBox(this);
    sourceModeSelect_->setObjectName("sourceModeSelect");
    sourceModeSelect_->addItem("Window", QVariant("window"));
    sourceModeSelect_->addItem("Spout2 (avatar apps)", QVariant("spout"));
    sourceModeSelect_->setToolTip(
        "Window captures visible app/game windows. Spout2 is for local avatar/alpha senders such as VTube Studio, "
        "Warudo, VSeeFace, and VNyan. Start or enable Spout output in that app first. For transparency, use VP9 "
        "with OBS alpha workflow. If frames are black, run both apps on the same GPU.");
    installComboWheelGuard(sourceModeSelect_);
    connect(sourceModeSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int) {
        if (sourceModeSelect_ &&
            sourceModeSelect_->currentData().toString() == "spout" &&
            audioSourceSelect_ &&
            audioSourceSelect_->currentData().toString() == "selected-window") {
            const int noAudioIndex = audioSourceSelect_->findData("none");
            if (noAudioIndex >= 0) {
                audioSourceSelect_->setCurrentIndex(noAudioIndex);
            }
        }
        selectedWindowId_.clear();
        if (windowListWidget_) {
            windowListWidget_->requestThumbnailRefresh();
        }
        updateStatus(sourceModeSelect_ && sourceModeSelect_->currentData().toString() == "spout"
            ? "Select a Spout2 sender"
            : "Select a window to capture",
            "idle");
        refreshWindowList();
        refreshSelectedWindowPreview();
        updateGoLiveButton();
        savePersistedSettings();
    });
    sourceLayout->addWidget(sourceLabel);
    sourceLayout->addWidget(sourceModeSelect_, 1);
    layout->addLayout(sourceLayout);

    auto *captureSplitter = new QSplitter(Qt::Horizontal, this);
    captureSplitter->setChildrenCollapsible(false);

    // Window list widget
    windowListWidget_ = new WindowListWidget(this);
    windowListWidget_->setMinimumWidth(300);
    connect(windowListWidget_, &WindowListWidget::windowSelected, this, &MainWindow::onWindowSelected);
    connect(windowListWidget_, &WindowListWidget::refreshRequested, this, &MainWindow::onRefreshWindows);
    connect(windowListWidget_, &WindowListWidget::autoRefreshRequested, this, &MainWindow::onAutoRefreshWindows);
    captureSplitter->addWidget(windowListWidget_);

    // Selected window preview
    auto *previewFrame = new QFrame(this);
    previewFrame->setObjectName("previewFrame");
    previewFrame->setMinimumWidth(280);
    auto *previewLayout = new QVBoxLayout(previewFrame);
    previewLayout->setContentsMargins(8, 8, 8, 8);
    previewLayout->setSpacing(4);
    auto *previewTitle = new QLabel("Selected Source Preview", this);
    previewTitle->setStyleSheet(QString("color: %1; font-weight: bold;").arg(COLOR_TEXT_DIM));
    previewLayout->addWidget(previewTitle);

    previewLabel_ = new QLabel("Select a window to see live preview", this);
    previewLabel_->setObjectName("selectedPreview");
    previewLabel_->setAlignment(Qt::AlignCenter);
    previewLabel_->setMinimumHeight(150);
    previewLabel_->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Preferred);
    previewLabel_->setStyleSheet("background-color: #0a141e; border: 1px solid #263443; border-radius: 6px;");
    previewLayout->addWidget(previewLabel_);
    captureSplitter->addWidget(previewFrame);

    captureSplitter->setStretchFactor(0, 5);
    captureSplitter->setStretchFactor(1, 4);
    captureSplitter->setSizes({540, 420});
    layout->addWidget(captureSplitter);

    // Separator
    auto *sep1 = new QFrame(this);
    sep1->setFrameShape(QFrame::HLine);
    sep1->setStyleSheet("background-color: #333;");
    layout->addWidget(sep1);

    auto *heroTitle = new QLabel("Game Capture Live", this);
    heroTitle->setStyleSheet(QString("color: %1; font-size: 18px; font-weight: 700;").arg(COLOR_TEXT));
    layout->addWidget(heroTitle);

    auto *heroSubTitle = new QLabel("Select a window, paste a Stream ID or VDO URL, then go live.", this);
    heroSubTitle->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    heroSubTitle->setWordWrap(true);
    layout->addWidget(heroSubTitle);

    // Basic settings form
    auto *basicForm = new QFormLayout();
    basicForm->setSpacing(8);

    streamIdInput_ = new QLineEdit(this);
    streamIdInput_->setPlaceholderText("Stream ID or VDO.Ninja URL (push/view)");
    basicForm->addRow("Stream / URL", streamIdInput_);

    passwordInput_ = new QLineEdit(this);
    passwordInput_->setObjectName("passwordInput");
    passwordInput_->setPlaceholderText("Password (leave blank for default, 'false' to disable)");
    if (auto *passwordRow = wrapSensitiveLineEdit(passwordInput_, &passwordRevealButton_, "password", this)) {
        if (passwordRevealButton_) {
            passwordRevealButton_->setObjectName("passwordRevealButton");
        }
        basicForm->addRow("Password", passwordRow);
    } else {
        basicForm->addRow("Password", passwordInput_);
    }
    layout->addLayout(basicForm);

    auto *urlHint = new QLabel("Tip: paste a full VDO URL and Game Capture auto-uses stream/room/password.", this);
    urlHint->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
    urlHint->setWordWrap(true);
    layout->addWidget(urlHint);

    advancedToggle_ = new QCheckBox("Show advanced settings", this);
    advancedToggle_->setChecked(false);
    advancedToggle_->setProperty("locked", false);
    advancedToggle_->setCursor(Qt::PointingHandCursor);
    layout->addWidget(advancedToggle_);

    advancedPanel_ = new QWidget(this);
    auto *advancedForm = new QFormLayout(advancedPanel_);
    advancedForm->setSpacing(8);
    layout->addWidget(advancedPanel_);
    advancedPanel_->setVisible(false);
    connect(advancedToggle_, &QCheckBox::toggled, this, &MainWindow::onAdvancedToggleChanged);
    connect(advancedToggle_, &QCheckBox::clicked, this, [this](bool) {
        if (!advancedToggle_ || !advancedToggle_->property("locked").toBool()) {
            return;
        }
        QToolTip::showText(
            QCursor::pos(),
            "Cannot change settings while live. Stop stream first.",
            advancedToggle_);
        updateStatus("Stop stream before changing advanced settings", "connecting");
    });

    roomInput_ = new QLineEdit(this);
    roomInput_->setPlaceholderText("Room ID (optional)");
    roomInput_->setToolTip(
        "Room mode can route non-scene viewers to a lower-quality tier for bandwidth compatibility. Use the room-quality toggle below to disable that behavior.");
    advancedForm->addRow("Room", roomInput_);

    labelInput_ = new QLineEdit(this);
    labelInput_->setPlaceholderText("Stream label (optional)");
    advancedForm->addRow("Label", labelInput_);

    resolutionSelect_ = new QComboBox(this);
    resolutionSelect_->addItem("1920x1080", QVariant("1920x1080"));
    resolutionSelect_->addItem("1280x720", QVariant("1280x720"));
    resolutionSelect_->addItem("960x540", QVariant("960x540"));
    installComboWheelGuard(resolutionSelect_);
    advancedForm->addRow("Resolution", resolutionSelect_);

    fpsSelect_ = new QComboBox(this);
    fpsSelect_->addItem("60", QVariant(60));
    fpsSelect_->addItem("30", QVariant(30));
    installComboWheelGuard(fpsSelect_);
    advancedForm->addRow("FPS", fpsSelect_);

    bitrateSelect_ = new QComboBox(this);
    bitrateSelect_->addItem("Ultra (20000 kbps)", QVariant(20000));
    bitrateSelect_->addItem("High (12000 kbps)", QVariant(12000));
    bitrateSelect_->addItem("Medium (6000 kbps)", QVariant(6000));
    bitrateSelect_->addItem("Low (3000 kbps)", QVariant(3000));
    bitrateSelect_->addItem("Custom", QVariant(-1));
    bitrateSelect_->setCurrentIndex(1);
    installComboWheelGuard(bitrateSelect_);
    connect(bitrateSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &MainWindow::onBitratePresetChanged);
    advancedForm->addRow("Bitrate Preset", bitrateSelect_);

    customBitrateSpin_ = new QSpinBox(this);
    customBitrateSpin_->setRange(500, 50000);
    customBitrateSpin_->setValue(12000);
    customBitrateSpin_->setSuffix(" kbps");
    customBitrateSpin_->setEnabled(false);
    advancedForm->addRow("Custom Bitrate", customBitrateSpin_);

    viewerLimitSpin_ = new QSpinBox(this);
    viewerLimitSpin_->setObjectName("viewerLimitSpin");
    viewerLimitSpin_->setRange(1, 50);
    viewerLimitSpin_->setValue(10);
    viewerLimitSpin_->setSuffix(" viewers");
    advancedForm->addRow("Max Viewers", viewerLimitSpin_);

    roomModeLqCheck_ = new QCheckBox("Use 640x360 for room guests/directors/viewers", this);
    roomModeLqCheck_->setObjectName("roomModeLqCheck");
    roomModeLqCheck_->setChecked(true);
    roomModeLqCheck_->setToolTip(
        "Enabled: non-scene room peers use the low-quality 640x360 tier. Disabled: room peers stay on the full-resolution HQ path.");
    advancedForm->addRow("Room Quality", roomModeLqCheck_);

    iceModeSelect_ = new QComboBox(this);
    iceModeSelect_->setObjectName("iceModeSelect");
    iceModeSelect_->addItem("Direct STUN (Recommended)", QVariant("stun-only"));
    iceModeSelect_->addItem("Auto with TURN fallback", QVariant("all"));
    iceModeSelect_->addItem("Relay Only", QVariant("relay"));
    iceModeSelect_->addItem("Host Only (LAN)", QVariant("host-only"));
    iceModeSelect_->setToolTip(
        "Direct STUN avoids slower TURN relays. Use Auto or Relay Only only when restrictive networks block direct UDP.");
    installComboWheelGuard(iceModeSelect_);
    advancedForm->addRow("ICE Mode", iceModeSelect_);

    audioSourceSelect_ = new QComboBox(this);
    audioSourceSelect_->setObjectName("audioSourceSelect");
    audioSourceSelect_->addItem("Selected window/app audio", QVariant("selected-window"));
    audioSourceSelect_->addItem("Default output mix", QVariant("default-output"));
    audioSourceSelect_->addItem("Communications output (VOIP)", QVariant("communications-output"));
    audioSourceSelect_->addItem("Default microphone/input", QVariant("default-microphone"));
    audioSourceSelect_->addItem("No audio", QVariant("none"));
    audioSourceSelect_->setToolTip(
        "Use Communications output for VOIP-style games, or Default microphone/input when voice chat is captured through an input device.");
    installComboWheelGuard(audioSourceSelect_);
    advancedForm->addRow("Audio Source", audioSourceSelect_);

    includeMicrophoneCheck_ = new QCheckBox("Also add microphone/input", this);
    includeMicrophoneCheck_->setObjectName("includeMicrophoneCheck");
    includeMicrophoneCheck_->setChecked(false);
    includeMicrophoneCheck_->setToolTip(
        "Mixes the selected microphone/input into the selected audio source so game/app audio and the on-screen player's mic are sent together.");
    advancedForm->addRow("Additional Audio", includeMicrophoneCheck_);

    microphoneDeviceSelect_ = new QComboBox(this);
    microphoneDeviceSelect_->setObjectName("microphoneDeviceSelect");
    microphoneDeviceSelect_->setToolTip(
        "Choose a microphone/input to mix in. If the selected device is unavailable, capture falls back to the Windows default input.");
    refreshMicrophoneDevices();
    installComboWheelGuard(microphoneDeviceSelect_);
    advancedForm->addRow("Microphone", microphoneDeviceSelect_);

    primaryAudioGainSpin_ = new QSpinBox(this);
    primaryAudioGainSpin_->setObjectName("primaryAudioGainSpin");
    primaryAudioGainSpin_->setRange(0, 200);
    primaryAudioGainSpin_->setValue(100);
    primaryAudioGainSpin_->setSuffix("%");
    primaryAudioGainSpin_->setToolTip("Applies gain to the selected game/app audio before mixing.");
    advancedForm->addRow("Game Audio Gain", primaryAudioGainSpin_);

    microphoneAudioGainSpin_ = new QSpinBox(this);
    microphoneAudioGainSpin_->setObjectName("microphoneAudioGainSpin");
    microphoneAudioGainSpin_->setRange(0, 200);
    microphoneAudioGainSpin_->setValue(100);
    microphoneAudioGainSpin_->setSuffix("%");
    microphoneAudioGainSpin_->setToolTip("Applies gain to the added microphone/input before mixing.");
    advancedForm->addRow("Mic Gain", microphoneAudioGainSpin_);

    audioLimiterCheck_ = new QCheckBox("Limit mixed output", this);
    audioLimiterCheck_->setObjectName("audioLimiterCheck");
    audioLimiterCheck_->setChecked(true);
    audioLimiterCheck_->setToolTip("Soft-limits combined game/app and microphone audio before Opus encoding.");
    advancedForm->addRow("Audio Limiter", audioLimiterCheck_);

    remoteControlCheck_ = new QCheckBox("Enable director control via data channel", this);
    remoteControlCheck_->setObjectName("remoteControlCheck");
    remoteControlCheck_->setChecked(false);
    remoteControlCheck_->setToolTip(
        "Allows a trusted VDO.Ninja director to request bitrate or resolution changes over the data channel while you are live.");
    advancedForm->addRow("Remote Control", remoteControlCheck_);

    remoteControlTokenInput_ = new QLineEdit(this);
    remoteControlTokenInput_->setObjectName("remoteControlTokenInput");
    remoteControlTokenInput_->setPlaceholderText("Optional token (defaults to password or stream ID)");
    remoteControlTokenInput_->setEnabled(false);
    if (auto *remoteTokenRow = wrapSensitiveLineEdit(remoteControlTokenInput_, &remoteControlTokenRevealButton_, "control token", this)) {
        if (remoteControlTokenRevealButton_) {
            remoteControlTokenRevealButton_->setObjectName("remoteControlTokenRevealButton");
            remoteControlTokenRevealButton_->setEnabled(false);
        }
        advancedForm->addRow("Control Token", remoteTokenRow);
    } else {
        advancedForm->addRow("Control Token", remoteControlTokenInput_);
    }

    connect(remoteControlCheck_, &QCheckBox::toggled, this, [this](bool checked) {
        if (remoteControlTokenInput_) {
            remoteControlTokenInput_->setEnabled(checked);
        }
        setSensitiveRevealEnabled(remoteControlTokenInput_, remoteControlTokenRevealButton_, checked, "control token");
    });

    encoderSelect_ = new QComboBox(this);
    encoderSelect_->setObjectName("encoderSelect");
    encoderSelect_->addItem("Auto (Prefer NVIDIA)", QVariant("auto"));
    encoderSelect_->addItem("NVIDIA NVENC", QVariant("nvenc"));
    encoderSelect_->addItem("FFmpeg NVENC (Advanced)", QVariant("ffmpeg_nvenc"));
    encoderSelect_->addItem("Intel Quick Sync", QVariant("qsv"));
    encoderSelect_->addItem("AMD AMF", QVariant("amf"));
    encoderSelect_->addItem("Software", QVariant("software"));
    installComboWheelGuard(encoderSelect_);
    advancedForm->addRow("Encoder", encoderSelect_);

    codecSelect_ = new QComboBox(this);
    codecSelect_->setObjectName("codecSelect");
    codecSelect_->addItem("H.264 (Compatibility)", QVariant("h264"));
    codecSelect_->addItem("H.265 / HEVC (Experimental, auto fallback)", QVariant("h265"));
    codecSelect_->addItem("AV1 (Experimental, auto fallback)", QVariant("av1"));
    codecSelect_->addItem("VP9 (OBS Alpha Preview, auto fallback)", QVariant("vp9"));
    installComboWheelGuard(codecSelect_);
    advancedForm->addRow("Video Codec", codecSelect_);

    alphaWorkflowCheck_ = new QCheckBox("Enable alpha workflow (experimental)", this);
    alphaWorkflowCheck_->setObjectName("alphaWorkflowCheck");
    alphaWorkflowCheck_->setChecked(false);
    alphaWorkflowCheck_->setEnabled(false);
    advancedForm->addRow("Alpha", alphaWorkflowCheck_);

    alphaBackgroundModeSelect_ = new QComboBox(this);
    alphaBackgroundModeSelect_->setObjectName("alphaBackgroundModeSelect");
    alphaBackgroundModeSelect_->addItem("No background fill", QVariant("none"));
    alphaBackgroundModeSelect_->addItem("Chroma background", QVariant("chroma"));
    alphaBackgroundModeSelect_->addItem("Opaque background", QVariant("opaque"));
    alphaBackgroundModeSelect_->setToolTip(
        "Composites transparent BGRA/Spout2 pixels over a solid color before encoding. "
        "Use chroma background with H.264/NVENC when true VP9 alpha is too CPU-heavy.");
    installComboWheelGuard(alphaBackgroundModeSelect_);
    advancedForm->addRow("Alpha Background", alphaBackgroundModeSelect_);

    alphaBackgroundColorButton_ = new QPushButton(this);
    alphaBackgroundColorButton_->setObjectName("alphaBackgroundColorButton");
    alphaBackgroundColorButton_->setToolTip("Choose the solid background color used for chroma or opaque alpha background mode.");
    alphaBackgroundColorButton_->setMinimumHeight(34);
    updateAlphaBackgroundColorButton();
    connect(alphaBackgroundColorButton_, &QPushButton::clicked, this, &MainWindow::chooseAlphaBackgroundColor);
    advancedForm->addRow("Background Color", alphaBackgroundColorButton_);

    ffmpegPathInput_ = new QLineEdit(this);
    ffmpegPathInput_->setObjectName("ffmpegPathInput");
    ffmpegPathInput_->setPlaceholderText("Optional ffmpeg path (auto-discovered if empty)");
    ffmpegPathInput_->setEnabled(false);
    advancedForm->addRow("FFmpeg Path", ffmpegPathInput_);

    ffmpegStatusLabel_ = new QLabel(this);
    ffmpegStatusLabel_->setObjectName("ffmpegStatusLabel");
    ffmpegStatusLabel_->setWordWrap(true);
    ffmpegStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
    advancedForm->addRow("FFmpeg Status", ffmpegStatusLabel_);

    ffmpegOptionsInput_ = new QLineEdit(this);
    ffmpegOptionsInput_->setObjectName("ffmpegOptionsInput");
    ffmpegOptionsInput_->setPlaceholderText("Optional ffmpeg options (VP9: -g 30 -keyint_min 30; NVENC: -preset llhq -rc cbr)");
    ffmpegOptionsInput_->setToolTip(
        "Advanced FFmpeg output options are appended after Game Capture defaults. VP9 already uses "
        "-deadline realtime -cpu-used 8. For slow CPUs, lower resolution/FPS first; advanced VP9 users can try "
        "-g 30 -keyint_min 30 to reduce all-keyframe cost at the expense of slower recovery after packet loss or late joins.");
    ffmpegOptionsInput_->setEnabled(false);
    advancedForm->addRow("FFmpeg Options", ffmpegOptionsInput_);

    connect(encoderSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int) {
        syncCodecUiState();
    });
    connect(codecSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int) {
        syncCodecUiState();
    });
    connect(alphaBackgroundModeSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int) {
        syncCodecUiState();
    });
    connect(alphaWorkflowCheck_, &QCheckBox::toggled, this, [this](bool) {
        syncCodecUiState();
    });
    connect(ffmpegPathInput_, &QLineEdit::textChanged, this, [this]() {
        refreshFfmpegStatus();
    });
    syncCodecUiState();

    encoderStatusLabel_ = new QLabel("Active Encoder: (not streaming)", this);
    encoderStatusLabel_->setObjectName("encoderStatusLabel");
    encoderStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
    layout->addWidget(encoderStatusLabel_);

    // GO LIVE button
    auto *buttonLayout = new QHBoxLayout();
    buttonLayout->addStretch();

    goLiveButton_ = new QPushButton("GO LIVE", this);
    goLiveButton_->setFixedSize(200, 50);
    goLiveButton_->setEnabled(false);
    updateGoLiveButton();
    connect(goLiveButton_, &QPushButton::clicked, this, &MainWindow::onGoLiveClicked);
    buttonLayout->addWidget(goLiveButton_);

    buttonLayout->addStretch();
    layout->addLayout(buttonLayout);

    // Status label
    statusLabel_ = new QLabel("Select a window to capture", this);
    statusLabel_->setAlignment(Qt::AlignCenter);
    statusLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    layout->addWidget(statusLabel_);

    // Operator-facing connection health
    auto *healthLayout = new QGridLayout();
    healthLayout->setHorizontalSpacing(12);
    healthLayout->setVerticalSpacing(4);
    auto *healthTitle = new QLabel("Connection Health", this);
    healthTitle->setStyleSheet(QString("color: %1; font-weight: 600;").arg(COLOR_TEXT));
    healthLayout->addWidget(healthTitle, 0, 0, 1, 2);

    connectionHealthLabel_ = new QLabel("ICE: - | Candidates: - | Peers: 0", this);
    connectionHealthLabel_->setObjectName("connectionHealthLabel");
    connectionHealthLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    connectionHealthLabel_->setWordWrap(true);
    healthLayout->addWidget(connectionHealthLabel_, 1, 0, 1, 2);

    connectionMediaLabel_ = new QLabel("Codec: - | FPS: - | Resolution: - | Bitrate: -", this);
    connectionMediaLabel_->setObjectName("connectionMediaLabel");
    connectionMediaLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    connectionMediaLabel_->setWordWrap(true);
    healthLayout->addWidget(connectionMediaLabel_, 2, 0, 1, 2);

    systemResourceLabel_ = new QLabel("System: CPU - | RAM -", this);
    systemResourceLabel_->setObjectName("systemResourceLabel");
    systemResourceLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    systemResourceLabel_->setWordWrap(true);
    healthLayout->addWidget(systemResourceLabel_, 3, 0, 1, 2);

    connectionIssueLabel_ = new QLabel("Drops/encode/video/audio send: 0/0/0/0 | Last disconnect: none", this);
    connectionIssueLabel_->setObjectName("connectionIssueLabel");
    connectionIssueLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    connectionIssueLabel_->setWordWrap(true);
    healthLayout->addWidget(connectionIssueLabel_, 4, 0, 1, 2);
    layout->addLayout(healthLayout);

    // Audio source meters
    auto *audioGrid = new QGridLayout();
    audioGrid->setHorizontalSpacing(10);
    audioGrid->setVerticalSpacing(5);
    auto *audioTitle = new QLabel("Audio Sources", this);
    audioTitle->setStyleSheet(QString("color: %1; font-weight: 600;").arg(COLOR_TEXT));
    audioGrid->addWidget(audioTitle, 0, 0, 1, 3);

    auto makeAudioMeter = [this](const QString &objectName) {
        auto *meter = new QProgressBar(this);
        meter->setObjectName(objectName);
        meter->setRange(0, 100);
        meter->setValue(0);
        meter->setTextVisible(false);
        meter->setFixedHeight(10);
        meter->setStyleSheet(QString(
            "QProgressBar { border: 1px solid #2f4254; border-radius: 4px; background: #0d1620; }"
            "QProgressBar::chunk { background-color: %1; border-radius: 3px; }").arg(COLOR_ACCENT));
        return meter;
    };

    auto makeLevelLabel = [this](const QString &objectName) {
        auto *label = new QLabel("-inf dB", this);
        label->setObjectName(objectName);
        label->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
        label->setMinimumWidth(70);
        label->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
        return label;
    };

    auto *mixedAudioLabel = new QLabel("Mixed output", this);
    mixedAudioLabel->setObjectName("mixedAudioSourceLabel");
    mixedAudioLabel->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    audioGrid->addWidget(mixedAudioLabel, 1, 0);

    audioMeter_ = makeAudioMeter("audioMeter");
    audioGrid->addWidget(audioMeter_, 1, 1);

    audioLevelLabel_ = makeLevelLabel("audioLevelLabel");
    audioGrid->addWidget(audioLevelLabel_, 1, 2);

    primaryAudioSourceLabel_ = new QLabel("Primary: -", this);
    primaryAudioSourceLabel_->setObjectName("primaryAudioSourceLabel");
    primaryAudioSourceLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    audioGrid->addWidget(primaryAudioSourceLabel_, 2, 0);

    primaryAudioMeter_ = makeAudioMeter("primaryAudioMeter");
    audioGrid->addWidget(primaryAudioMeter_, 2, 1);

    primaryAudioLevelLabel_ = makeLevelLabel("primaryAudioLevelLabel");
    audioGrid->addWidget(primaryAudioLevelLabel_, 2, 2);

    microphoneAudioSourceLabel_ = new QLabel("Mic/input: Off", this);
    microphoneAudioSourceLabel_->setObjectName("microphoneAudioSourceLabel");
    microphoneAudioSourceLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    audioGrid->addWidget(microphoneAudioSourceLabel_, 3, 0);

    microphoneAudioMeter_ = makeAudioMeter("microphoneAudioMeter");
    audioGrid->addWidget(microphoneAudioMeter_, 3, 1);

    microphoneAudioLevelLabel_ = makeLevelLabel("microphoneAudioLevelLabel");
    audioGrid->addWidget(microphoneAudioLevelLabel_, 3, 2);

    audioGrid->setColumnStretch(1, 1);
    layout->addLayout(audioGrid);

    // Share link
    shareLabel_ = new QLabel("", this);
    shareLabel_->setAlignment(Qt::AlignCenter);
    shareLabel_->setTextInteractionFlags(Qt::TextBrowserInteraction);
    shareLabel_->setWordWrap(true);
    shareLabel_->setOpenExternalLinks(true);
    shareLabel_->setCursor(Qt::PointingHandCursor);
    layout->addWidget(shareLabel_);

    auto *shareActionsLayout = new QHBoxLayout();
    shareActionsLayout->addStretch();

    copyShareLinkButton_ = new QPushButton("Copy Link", this);
    copyShareLinkButton_->setObjectName("shareCopyButton");
    copyShareLinkButton_->setEnabled(false);
    connect(copyShareLinkButton_, &QPushButton::clicked, this, [this]() {
        if (copyShareLinkAction_) {
            copyShareLinkAction_->trigger();
        }
    });
    shareActionsLayout->addWidget(copyShareLinkButton_);

    openShareLinkButton_ = new QPushButton("Open Link", this);
    openShareLinkButton_->setObjectName("shareOpenButton");
    openShareLinkButton_->setEnabled(false);
    connect(openShareLinkButton_, &QPushButton::clicked, this, [this]() {
        if (openShareLinkAction_) {
            openShareLinkAction_->trigger();
        }
    });
    shareActionsLayout->addWidget(openShareLinkButton_);
    shareActionsLayout->addStretch();
    layout->addLayout(shareActionsLayout);

    // Stats panel (hidden initially)
    statsPanel_ = new StatsPanel(this);
    statsPanel_->setVisible(false);
    layout->addWidget(statsPanel_);
    resetOperatorHealthUi();

    auto *footerLayout = new QHBoxLayout();
    footerLayout->addStretch();
    auto *versionLabel = new QLabel(QString("Version %1").arg(APP_VERSION_TEXT), this);
    versionLabel->setObjectName("versionLabel");
    versionLabel->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
    footerLayout->addWidget(versionLabel);
    layout->addLayout(footerLayout);

    layout->addStretch();

    auto *scrollArea = new QScrollArea(this);
    scrollArea->setWidgetResizable(true);
    scrollArea->setFrameShape(QFrame::NoFrame);
    scrollArea->setWidget(content);
    setCentralWidget(scrollArea);
    resize(980, 720);
    setMinimumSize(760, 520);

    // Keep desktop UX consistent: buttons should show a hand cursor on hover.
    for (auto *button : findChildren<QPushButton *>()) {
        button->setCursor(Qt::PointingHandCursor);
    }
}

void MainWindow::setupTrayIcon() {
    if (!QSystemTrayIcon::isSystemTrayAvailable()) {
        spdlog::warn("[UI] System tray unavailable; disabling Minimize To Tray On Close");
        minimizeToTrayOnClose_ = false;
        if (minimizeToTrayOnCloseAction_) {
            QSignalBlocker blocker(minimizeToTrayOnCloseAction_);
            minimizeToTrayOnCloseAction_->setChecked(false);
            minimizeToTrayOnCloseAction_->setEnabled(false);
            minimizeToTrayOnCloseAction_->setToolTip("System tray is unavailable on this system");
        }
        return;
    }

    trayIcon_ = new QSystemTrayIcon(this);
    trayBaseIcon_ = QIcon(":/icons/logo.png");
    if (trayBaseIcon_.isNull()) {
        trayBaseIcon_ = QIcon(":/icons/vdoninja.ico");
    }
    if (trayBaseIcon_.isNull()) {
        trayBaseIcon_ = windowIcon();
    }
    if (trayBaseIcon_.isNull()) {
        trayBaseIcon_ = qApp->windowIcon();
    }
    if (trayBaseIcon_.isNull()) {
        trayBaseIcon_ = makeBrandTrayFallbackIcon();
    }
    trayIcon_->setIcon(trayBaseIcon_);
    trayIcon_->setToolTip(APP_TRAY_IDLE);

    trayMenu_ = new QMenu(this);

    showHideAction_ = trayMenu_->addAction("Hide");
    connect(showHideAction_, &QAction::triggered, this, [this]() {
        if (isVisible()) {
            hide();
            showHideAction_->setText("Show");
        } else {
            show();
            raise();
            activateWindow();
            showHideAction_->setText("Hide");
        }
    });

    trayMenu_->addSeparator();

    goLiveAction_ = trayMenu_->addAction("Go Live");
    goLiveAction_->setEnabled(false);
    connect(goLiveAction_, &QAction::triggered, this, &MainWindow::onGoLiveClicked);

    copyShareLinkTrayAction_ = trayMenu_->addAction("Copy Share Link");
    copyShareLinkTrayAction_->setEnabled(false);
    connect(copyShareLinkTrayAction_, &QAction::triggered, this, [this]() {
        if (!core_) {
            return;
        }
        const QString shareLink = QString::fromStdString(core_->getShareLink());
        if (shareLink.isEmpty()) {
            return;
        }
        QGuiApplication::clipboard()->setText(shareLink);
        updateStatus("Share link copied to clipboard", "ready");
    });

    openShareLinkTrayAction_ = trayMenu_->addAction("Open Share Link");
    openShareLinkTrayAction_->setEnabled(false);
    connect(openShareLinkTrayAction_, &QAction::triggered, this, [this]() {
        if (!core_) {
            return;
        }
        const QString shareLink = QString::fromStdString(core_->getShareLink());
        if (shareLink.isEmpty()) {
            return;
        }
        QDesktopServices::openUrl(QUrl(shareLink));
    });

    trayMenu_->addSeparator();

    auto *quitAction = trayMenu_->addAction("Quit");
    connect(quitAction, &QAction::triggered, this, [this]() {
        requestQuit();
    });

    trayIcon_->setContextMenu(trayMenu_);
    connect(trayIcon_, &QSystemTrayIcon::activated, this, &MainWindow::onTrayIconActivated);
    trayIcon_->show();
    if (!trayIcon_->isVisible()) {
        spdlog::warn("[UI] Tray icon failed to become visible after setup");
    }
    updateTrayLiveIndicator(false);
}

void MainWindow::applyDarkTheme() {
    QFont uiFont("Bahnschrift", 10);
    if (!QFontDatabase().families().contains(uiFont.family())) {
        uiFont = QFont("Segoe UI", 10);
    }
    qApp->setFont(uiFont);

    QString styleSheet = QString(R"(
        QMainWindow, QWidget {
            background-color: %1;
            color: %2;
        }
        QLineEdit, QComboBox, QSpinBox {
            background-color: %3;
            color: %2;
            border: 1px solid #263443;
            border-radius: 4px;
            padding: 6px 8px;
            min-height: 20px;
        }
        QLineEdit:focus, QComboBox:focus, QSpinBox:focus {
            border-color: %4;
        }
        QCheckBox {
            color: %2;
            spacing: 8px;
        }
        QCheckBox:disabled {
            color: #5f7285;
        }
        QCheckBox[locked="true"] {
            color: #5f7285;
        }
        QCheckBox::indicator {
            width: 14px;
            height: 14px;
        }
        QCheckBox::indicator:unchecked {
            border: 1px solid #4a6076;
            background-color: #0d1620;
        }
        QCheckBox::indicator:disabled,
        QCheckBox[locked="true"]::indicator {
            border: 1px solid #3b4f62;
            background-color: #0b1520;
        }
        QCheckBox::indicator:checked {
            border: 1px solid %4;
            background-color: %4;
        }
        QCheckBox[locked="true"]::indicator:checked {
            border: 1px solid #3b4f62;
            background-color: #1d2f42;
        }
        QComboBox::drop-down {
            border: none;
            width: 20px;
        }
        QComboBox::down-arrow {
            image: none;
            border-left: 5px solid transparent;
            border-right: 5px solid transparent;
            border-top: 5px solid %2;
            margin-right: 5px;
        }
        QComboBox QAbstractItemView {
            background-color: %3;
            color: %2;
            selection-background-color: %4;
        }
        QListWidget {
            background-color: %3;
            color: %2;
            border: 1px solid #263443;
            border-radius: 4px;
        }
        QListWidget::item {
            padding: 4px;
            border-radius: 4px;
        }
        QListWidget::item:selected {
            background-color: %4;
        }
        QListWidget::item:hover {
            background-color: #162634;
        }
        QPushButton {
            background-color: %4;
            color: white;
            border: none;
            border-radius: 4px;
            padding: 8px 16px;
            font-weight: bold;
        }
        QPushButton:hover {
            background-color: %5;
        }
        QPushButton:disabled {
            background-color: #2b3a48;
            color: #7891aa;
        }
        QPushButton#goLiveButton {
            font-size: 14px;
        }
        QFrame#previewFrame {
            border: 1px solid #263443;
            border-radius: 8px;
            background-color: #0e1822;
        }
        QLabel {
            color: %2;
        }
        QScrollBar:vertical {
            background-color: %3;
            width: 12px;
            border-radius: 6px;
        }
        QScrollBar::handle:vertical {
            background-color: #444;
            border-radius: 6px;
            min-height: 20px;
        }
        QScrollBar::handle:vertical:hover {
            background-color: #555;
        }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
            height: 0px;
        }
        QMenu {
            background-color: %3;
            color: %2;
            border: 1px solid #263443;
        }
        QMenu::item:selected {
            background-color: %4;
        }
        QMenuBar {
            background-color: #0d151f;
        }
        QMenuBar::item:selected {
            background-color: #162634;
        }
    )").arg(COLOR_BG, COLOR_TEXT, COLOR_INPUT, COLOR_ACCENT, COLOR_ACCENT_HOVER);

    qApp->setStyleSheet(styleSheet);
}

void MainWindow::onWindowSelected(const QString &windowId) {
    selectedWindowId_ = windowId;
    const bool hasSelection = !windowId.isEmpty();
    goLiveButton_->setEnabled(hasSelection);
    if (goLiveAction_) {
        goLiveAction_->setEnabled(hasSelection);
    }
    if (goLiveMenuAction_) {
        goLiveMenuAction_->setEnabled(hasSelection);
    }

    refreshSelectedWindowPreview();
    if (hasSelection) {
        const QString sourceMode = sourceModeSelect_ ? sourceModeSelect_->currentData().toString() : QString("window");
        updateStatus(sourceMode == "spout" ? "Ready to capture Spout2 sender" : "Ready to go live", "ready");
    }
}

void MainWindow::onRefreshWindows() {
    if (windowListWidget_) {
        windowListWidget_->requestThumbnailRefresh();
    }
    refreshWindowList();
    refreshMicrophoneDevices();
    refreshSelectedWindowPreview();
}

void MainWindow::onAutoRefreshWindows() {
    refreshWindowList();
}

void MainWindow::refreshWindowList() {
    if (core_) {
        const QString sourceMode = sourceModeSelect_ ? sourceModeSelect_->currentData().toString() : QString("window");
        if (sourceMode == "spout") {
            windowListWidget_->setSpoutModeEnabled(true);
            windowListWidget_->setHeaderText("Select Spout2 Sender:");
            windowListWidget_->setEmptyText(
                "No Spout2 senders detected. Enable Spout output in the avatar app, keep it running, then Refresh.");
            auto senders = core_->listSpoutSenders();
            windowListWidget_->setWindowList(senders);
            if (selectedWindowId_.isEmpty()) {
                updateStatus(senders.empty() ? "Waiting for Spout2 sender" : "Select a Spout2 sender", "idle");
            }
        } else {
            windowListWidget_->setSpoutModeEnabled(false);
            windowListWidget_->setHeaderText("Select Game/Window:");
            windowListWidget_->setEmptyText("No windows detected. Launch a game and click Refresh.");
            auto windows = core_->listWindows();
            windowListWidget_->setWindowList(windows);
            if (selectedWindowId_.isEmpty()) {
                updateStatus(windows.empty() ? "Waiting for window" : "Select a window to capture", "idle");
            }
        }
    }
}

void MainWindow::refreshMicrophoneDevices(const QString &preferredDeviceId) {
    if (!microphoneDeviceSelect_) {
        return;
    }

    const QString preferred = preferredDeviceId.isNull()
        ? microphoneDeviceSelect_->currentData().toString()
        : preferredDeviceId;
    QSignalBlocker blocker(microphoneDeviceSelect_);
    microphoneDeviceSelect_->clear();
    microphoneDeviceSelect_->addItem("Windows default microphone/input", QVariant(QString()));
    microphoneDeviceSelect_->setItemData(
        0,
        "Uses the current Windows default input device at the moment capture starts.",
        Qt::ToolTipRole);

    if (core_) {
        const auto devices = core_->listAudioInputDevices();
        for (const auto &device : devices) {
            const int index = microphoneDeviceSelect_->count();
            microphoneDeviceSelect_->addItem(audioDeviceLabel(device), QVariant(QString::fromStdString(device.id)));
            QString tooltip = QString::fromStdString(device.name);
            if (device.sampleRate > 0 && device.channels > 0) {
                tooltip += QString("\nNative format: %1 Hz, %2 channel(s).")
                    .arg(device.sampleRate)
                    .arg(device.channels);
                if (device.sampleRate != 48000 || device.channels != 2) {
                    tooltip += "\nGame Capture will convert this input to 48 kHz stereo for WebRTC.";
                }
            }
            microphoneDeviceSelect_->setItemData(index, tooltip, Qt::ToolTipRole);
        }
    }

    const int preferredIndex = preferred.isEmpty() ? 0 : microphoneDeviceSelect_->findData(preferred);
    microphoneDeviceSelect_->setCurrentIndex(preferredIndex >= 0 ? preferredIndex : 0);
}

void MainWindow::onGoLiveClicked() {
    if (!core_) {
        return;
    }

    const bool startPending = startFuture_.isValid() && !startFuture_.isFinished();
    const bool stopPending = stopFuture_.isValid() && !stopFuture_.isFinished();
    if (startInProgress_ || stopInProgress_ || startPending || stopPending) {
        return;
    }

    if (isLive_) {
        stopInProgress_ = true;
        forceQuitEnabled_ = false;
        const quint64 stopOpId = ++stopOpId_;
        reconnectNoticeActive_ = false;
        updateStatus("Stopping...", "connecting");
        if (goLiveButton_) {
            goLiveButton_->setEnabled(false);
        }
        updateGoLiveButton();
        if (stopWatchdogTimer_) {
            stopWatchdogTimer_->start();
        }

        QPointer<MainWindow> self(this);
        auto *core = core_;
        stopFuture_ = QtConcurrent::run([self, core, stopOpId]() {
            core->stopLive();
            core->stopCapture();

            if (!self) {
                return;
            }
            QMetaObject::invokeMethod(self, [self, stopOpId]() {
                if (!self) {
                    return;
                }
                if (stopOpId != self->stopOpId_) {
                    return;
                }
                if (self->stopWatchdogTimer_) {
                    self->stopWatchdogTimer_->stop();
                }

                self->isLive_ = false;
                self->stopInProgress_ = false;
                self->forceQuitEnabled_ = false;
                if (self->statsTimer_) {
                    self->statsTimer_->stop();
                }
                if (self->previewTimer_) {
                    self->previewTimer_->start();
                }

                self->updateStatus("Stopped", "idle");
                if (self->shareLabel_) {
                    self->shareLabel_->clear();
                }
                if (self->copyShareLinkButton_) {
                    self->copyShareLinkButton_->setEnabled(false);
                }
                if (self->openShareLinkButton_) {
                    self->openShareLinkButton_->setEnabled(false);
                }
                if (self->statsPanel_) {
                    self->statsPanel_->setVisible(false);
                    self->statsPanel_->clear();
                }
                self->resetOperatorHealthUi();
                if (self->encoderStatusLabel_) {
                    self->encoderStatusLabel_->setText("Active Encoder: (not streaming)");
                    self->encoderStatusLabel_->setStyleSheet(
                        QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
                }

                if (self->trayIcon_) {
                    self->updateTrayLiveIndicator(false);
                }
                if (self->copyShareLinkAction_) {
                    self->copyShareLinkAction_->setEnabled(false);
                }
                if (self->copyShareLinkTrayAction_) {
                    self->copyShareLinkTrayAction_->setEnabled(false);
                }
                if (self->openShareLinkAction_) {
                    self->openShareLinkAction_->setEnabled(false);
                }
                if (self->openShareLinkTrayAction_) {
                    self->openShareLinkTrayAction_->setEnabled(false);
                }

                if (self->windowListWidget_) {
                    self->windowListWidget_->setAutoRefreshEnabled(true);
                }
                self->setConfigControlsEnabled(true);
                self->refreshSelectedWindowPreview();
                if (self->goLiveButton_) {
                    self->goLiveButton_->setEnabled(!self->selectedWindowId_.isEmpty());
                }
                self->updateGoLiveButton();
                self->maybeQuitAfterPendingOperations();
            }, Qt::QueuedConnection);
        });
    } else {
        const QString resolutionText = resolutionSelect_->currentData().toString();
        const QStringList parts = resolutionText.split('x');
        const int width = parts.size() > 0 ? parts[0].toInt() : 1920;
        const int height = parts.size() > 1 ? parts[1].toInt() : 1080;
        const int fps = fpsSelect_->currentData().toInt();
        const int bitrate = selectedBitrateKbps();

        versus::video::EncoderConfig config;
        config.codec = codecFromUiValue(codecSelect_ ? codecSelect_->currentData().toString() : QString("h264"));
        config.enableAlpha = alphaWorkflowCheck_ ? alphaWorkflowCheck_->isChecked() : false;
        config.width = width;
        config.height = height;
        config.frameRate = fps > 0 ? fps : 60;
        config.bitrate = bitrate > 0 ? bitrate : 12000;
        config.minBitrate = std::max(500, config.bitrate / 2);
        config.maxBitrate = std::max(config.bitrate + 4000, (config.bitrate * 3) / 2);
        config.ffmpegPath = ffmpegPathInput_ ? ffmpegPathInput_->text().trimmed().toStdString() : std::string();
        config.ffmpegOptions = ffmpegOptionsInput_ ? ffmpegOptionsInput_->text().toStdString() : std::string();
        config.alphaBackgroundMode = alphaBackgroundModeFromUiValue(
            alphaBackgroundModeSelect_ ? alphaBackgroundModeSelect_->currentData().toString() : QString("none"));
        config.alphaBackgroundRed = static_cast<uint8_t>(std::clamp(alphaBackgroundColor_.red(), 0, 255));
        config.alphaBackgroundGreen = static_cast<uint8_t>(std::clamp(alphaBackgroundColor_.green(), 0, 255));
        config.alphaBackgroundBlue = static_cast<uint8_t>(std::clamp(alphaBackgroundColor_.blue(), 0, 255));

        if (config.enableAlpha && !codecSupportsAlphaWorkflow(config.codec)) {
            config.enableAlpha = false;
        }
        if (config.enableAlpha) {
            config.alphaBackgroundMode = versus::video::AlphaBackgroundMode::None;
        } else if (config.alphaBackgroundMode != versus::video::AlphaBackgroundMode::None &&
                   config.codec == versus::video::VideoCodec::VP9) {
            spdlog::info("[UI] VP9 selected with alpha background mode; true alpha track is disabled");
        }

        const QString encoderMode = encoderSelect_->currentData().toString();
        const QString codecValue = codecSelect_ ? codecSelect_->currentData().toString() : QString("h264");
        const QString audioSourceValue = audioSourceSelect_
            ? audioSourceSelect_->currentData().toString()
            : QString("selected-window");
        const QString sourceModeValue = sourceModeSelect_
            ? sourceModeSelect_->currentData().toString()
            : QString("window");
        const bool includeMicrophone = includeMicrophoneCheck_ ? includeMicrophoneCheck_->isChecked() : false;
        const QString microphoneDeviceId = microphoneDeviceSelect_
            ? microphoneDeviceSelect_->currentData().toString()
            : QString();
        const float primaryAudioGain =
            static_cast<float>(primaryAudioGainSpin_ ? primaryAudioGainSpin_->value() : 100) / 100.0f;
        const float microphoneAudioGain =
            static_cast<float>(microphoneAudioGainSpin_ ? microphoneAudioGainSpin_->value() : 100) / 100.0f;
        const bool audioLimiterEnabled = audioLimiterCheck_ ? audioLimiterCheck_->isChecked() : true;
        const std::string selectedWindowId = selectedWindowId_.toStdString();
        if (encoderMode == "nvenc") {
            config.preferredHardware = versus::video::HardwareEncoder::NVENC;
        } else if (encoderMode == "ffmpeg_nvenc") {
            config.preferredHardware = versus::video::HardwareEncoder::NVENC;
            config.forceFfmpegNvenc = true;
        } else if (encoderMode == "qsv") {
            config.preferredHardware = versus::video::HardwareEncoder::QuickSync;
        } else if (encoderMode == "amf") {
            config.preferredHardware = versus::video::HardwareEncoder::AMF;
        } else if (encoderMode == "software") {
            config.preferredHardware = versus::video::HardwareEncoder::None;
        } else {
            config.preferredHardware = versus::video::HardwareEncoder::NVENC;
        }
        spdlog::info("[UI] Applying encoder config: {}x{} @{}fps {}kbps mode={} codec={} alpha={} alphaBackground={}",
                     config.width,
                     config.height,
                     config.frameRate,
                     config.bitrate,
                     encoderMode.toStdString(),
                     codecValue.toStdString(),
                     config.enableAlpha,
                     static_cast<int>(config.alphaBackgroundMode));

        const bool requiresFfmpeg =
            codecUsesExternalFfmpeg(config.codec) || config.forceFfmpegNvenc || config.enableAlpha;
        const versus::video::FfmpegProbeInfo ffmpegInfo =
            versus::video::VideoEncoder::probeFfmpeg(config.ffmpegPath);
        if (requiresFfmpeg && !ffmpegInfo.resolved) {
            updateStatus("ffmpeg.exe not found", "error");
            QMessageBox::warning(
                this,
                "FFmpeg Required",
                "VP9/AV1/H.265, FFmpeg NVENC, and the OBS alpha workflow require ffmpeg.exe. Use a bundled release, repair/reinstall Game Capture, or choose a custom FFmpeg path.");
            refreshFfmpegStatus();
            return;
        }
        if (requiresFfmpeg && ffmpegInfo.bundled && (ffmpegInfo.gplEnabled || ffmpegInfo.nonfreeEnabled)) {
            updateStatus("Bundled FFmpeg rejected", "error");
            QMessageBox::warning(
                this,
                "FFmpeg Rejected",
                "The bundled FFmpeg reports GPL or nonfree configure flags. This release package should be rebuilt with the pinned LGPL bundle.");
            refreshFfmpegStatus();
            return;
        }
        if ((config.codec == versus::video::VideoCodec::VP9 || config.enableAlpha) && !ffmpegInfo.hasLibvpxVp9) {
            updateStatus("FFmpeg lacks libvpx-vp9", "error");
            QMessageBox::warning(
                this,
                "FFmpeg VP9 Encoder Missing",
                "The OBS alpha workflow requires FFmpeg with libvpx-vp9. Use the bundled release FFmpeg or choose a compatible custom FFmpeg path.");
            refreshFfmpegStatus();
            return;
        }

        versus::app::StartOptions options;
        const QString streamTargetRaw = streamIdInput_->text().trimmed();
        const ParsedStreamTarget parsedTarget = parseStreamTargetInput(streamTargetRaw);
        if (!streamTargetRaw.isEmpty() && !parsedTarget.valid) {
            updateStatus("Invalid stream target URL", "error");
            return;
        }

        QString resolvedStreamId = parsedTarget.streamId;
        if (resolvedStreamId.isEmpty()) {
            resolvedStreamId = streamTargetRaw;
        }

        const QString roomText = roomInput_ ? roomInput_->text().trimmed() : QString();
        const QString passwordText = passwordInput_ ? passwordInput_->text().trimmed() : QString();

        options.streamId = resolvedStreamId.toStdString();
        options.room = roomText.isEmpty() ? parsedTarget.room.toStdString() : roomText.toStdString();
        options.password = passwordText.isEmpty() ? parsedTarget.password.toStdString() : passwordText.toStdString();
        options.label = labelInput_ ? labelInput_->text().toStdString() : std::string();
        options.maxViewers = viewerLimitSpin_ ? viewerLimitSpin_->value() : 10;
        options.roomModeLqEnabled = roomModeLqCheck_ ? roomModeLqCheck_->isChecked() : true;
        options.iceMode = iceModeFromUiValue(
            iceModeSelect_ ? iceModeSelect_->currentData().toString() : QString("stun-only"));
        options.remoteControlEnabled = remoteControlCheck_ ? remoteControlCheck_->isChecked() : false;
        options.remoteControlToken = remoteControlTokenInput_
            ? remoteControlTokenInput_->text().trimmed().toStdString()
            : std::string();

        if (parsedTarget.isUrl) {
            streamIdInput_->setText(resolvedStreamId);
            if (roomInput_ && roomInput_->text().trimmed().isEmpty() && !parsedTarget.room.isEmpty()) {
                roomInput_->setText(parsedTarget.room);
            }
            if (passwordInput_ && passwordInput_->text().trimmed().isEmpty() && !parsedTarget.password.isEmpty()) {
                passwordInput_->setText(parsedTarget.password);
            }
        }

        reconnectNoticeActive_ = false;
        startInProgress_ = true;
        forceQuitEnabled_ = false;
        const quint64 startOpId = ++startOpId_;
        updateStatus("Starting...", "connecting");
        setConfigControlsEnabled(false);
        if (previewTimer_) {
            previewTimer_->stop();
        }
        if (goLiveButton_) {
            goLiveButton_->setEnabled(false);
        }
        updateGoLiveButton();

        QPointer<MainWindow> self(this);
        auto *core = core_;
        startFuture_ = QtConcurrent::run([self,
                                           core,
                                           startOpId,
                                           selectedWindowId,
                                           sourceModeValue,
                                           config,
                                           options,
                                           encoderMode,
                                           audioSourceValue,
                                           includeMicrophone,
                                           microphoneDeviceId,
                                           primaryAudioGain,
                                           microphoneAudioGain,
                                           audioLimiterEnabled]() {
            bool started = false;
            QString failureStatus;
            const auto cleanupFailedStartup = [core]() {
                try {
                    core->stopLive();
                    core->stopCapture();
                } catch (const std::exception &cleanupError) {
                    spdlog::warn("[UI] Go Live failure cleanup failed: {}", cleanupError.what());
                } catch (...) {
                    spdlog::warn("[UI] Go Live failure cleanup failed with unknown exception");
                }
            };

            try {
                const auto sourceMode = videoSourceModeFromUiValue(sourceModeValue);
                core->setSelectedWindow(selectedWindowId);
                core->setVideoSourceMode(sourceMode);
                core->setVideoConfig(config);
                core->setAudioSourceMode(audioSourceModeFromUiValue(audioSourceValue));
                core->setIncludeMicrophone(includeMicrophone);
                core->setMicrophoneDeviceId(microphoneDeviceId.toStdString());
                core->setAudioMixConfig(primaryAudioGain, microphoneAudioGain, audioLimiterEnabled);

                if (!core->startCapture(sourceMode, selectedWindowId)) {
                    failureStatus = "Failed to start capture";
                } else {
                    if (!core->goLive(options)) {
                        failureStatus = "Failed to connect";
                        cleanupFailedStartup();
                    } else {
                        started = true;
                    }
                }
            } catch (const std::exception &e) {
                spdlog::error("[UI] Go Live startup failed with exception: {}", e.what());
                failureStatus = "Startup failed; see log";
                cleanupFailedStartup();
            } catch (...) {
                spdlog::error("[UI] Go Live startup failed with unknown exception");
                failureStatus = "Startup failed; see log";
                cleanupFailedStartup();
            }

            if (!self) {
                return;
            }
            QMetaObject::invokeMethod(self, [self, startOpId, started, failureStatus, encoderMode]() {
                if (!self) {
                    return;
                }
                if (startOpId != self->startOpId_) {
                    return;
                }

                self->startInProgress_ = false;
                self->forceQuitEnabled_ = false;
                if (!started) {
                    self->isLive_ = false;
                    self->updateStatus(failureStatus.isEmpty() ? "Failed to start stream" : failureStatus, "error");
                    self->setConfigControlsEnabled(true);
                    if (self->previewTimer_) {
                        self->previewTimer_->start();
                    }
                    if (self->windowListWidget_) {
                        self->windowListWidget_->setAutoRefreshEnabled(true);
                    }
                    self->refreshSelectedWindowPreview();
                    self->updateGoLiveButton();
                    self->maybeQuitAfterPendingOperations();
                    return;
                }

                self->isLive_ = true;
                self->reconnectNoticeActive_ = false;
                if (self->statsTimer_) {
                    self->statsTimer_->start();
                }
                if (self->previewTimer_) {
                    self->previewTimer_->stop();
                }
                self->setConfigControlsEnabled(false);

                self->updateStatus("LIVE", "live");

                const QString shareLink = QString::fromStdString(self->core_->getShareLink());
                if (self->shareLabel_) {
                    if (shareLink.isEmpty()) {
                        self->shareLabel_->clear();
                    } else {
                        const QString escapedLink = shareLink.toHtmlEscaped();
                        self->shareLabel_->setText(
                            QString("<a href=\"%1\" style=\"color: %2; text-decoration: underline;\">%1</a>")
                                .arg(escapedLink, COLOR_ACCENT));
                    }
                    self->shareLabel_->setTextFormat(Qt::RichText);
                    self->shareLabel_->setTextInteractionFlags(Qt::TextBrowserInteraction);
                    self->shareLabel_->setOpenExternalLinks(true);
                }
                if (self->copyShareLinkButton_) {
                    self->copyShareLinkButton_->setEnabled(!shareLink.isEmpty());
                }
                if (self->openShareLinkButton_) {
                    self->openShareLinkButton_->setEnabled(!shareLink.isEmpty());
                }
                if (self->copyShareLinkAction_) {
                    self->copyShareLinkAction_->setEnabled(!shareLink.isEmpty());
                }
                if (self->copyShareLinkTrayAction_) {
                    self->copyShareLinkTrayAction_->setEnabled(!shareLink.isEmpty());
                }
                if (self->openShareLinkAction_) {
                    self->openShareLinkAction_->setEnabled(!shareLink.isEmpty());
                }
                if (self->openShareLinkTrayAction_) {
                    self->openShareLinkTrayAction_->setEnabled(!shareLink.isEmpty());
                }

                if (self->statsPanel_) {
                    self->statsPanel_->setVisible(true);
                }

                if (self->trayIcon_) {
                    self->updateTrayLiveIndicator(true);
                }

                const QString activeEncoder = QString::fromStdString(self->core_->getVideoEncoderName());
                const bool hardwareEncoder = self->core_->isHardwareVideoEncoder();
                const QString activeText = activeEncoder.isEmpty() ? "Unknown" : activeEncoder;
                if (self->encoderStatusLabel_) {
                    self->encoderStatusLabel_->setText(QString("Active Encoder: %1 (%2)")
                        .arg(activeText, hardwareEncoder ? "hardware" : "software"));
                }

                bool fallbackActive = false;
                if (encoderMode == "nvenc" || encoderMode == "ffmpeg_nvenc") {
                    fallbackActive = !activeText.contains("nvidia", Qt::CaseInsensitive);
                } else if (encoderMode == "qsv") {
                    fallbackActive = !activeText.contains("intel", Qt::CaseInsensitive) &&
                                     !activeText.contains("quick sync", Qt::CaseInsensitive) &&
                                     !activeText.contains("qsv", Qt::CaseInsensitive);
                } else if (encoderMode == "amf") {
                    fallbackActive = !activeText.contains("amd", Qt::CaseInsensitive) &&
                                     !activeText.contains("radeon", Qt::CaseInsensitive) &&
                                     !activeText.contains("amf", Qt::CaseInsensitive);
                } else if (encoderMode == "software") {
                    fallbackActive = hardwareEncoder;
                }

                if (self->encoderStatusLabel_) {
                    if (fallbackActive) {
                        self->encoderStatusLabel_->setStyleSheet(
                            QString("color: %1; font-size: 11px; font-weight: bold;").arg(COLOR_YELLOW));
                        self->updateStatus("LIVE (fallback encoder)", "live");
                    } else {
                        self->encoderStatusLabel_->setStyleSheet(
                            QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
                    }
                }

                if (self->windowListWidget_) {
                    self->windowListWidget_->setAutoRefreshEnabled(false);
                }
                self->updateGoLiveButton();
                self->maybeQuitAfterPendingOperations();
            }, Qt::QueuedConnection);
        });
    }

    updateGoLiveButton();
}

void MainWindow::updateGoLiveButton() {
    if (!goLiveButton_) {
        return;
    }

    if (startInProgress_) {
        goLiveButton_->setText("STARTING...");
        goLiveButton_->setEnabled(false);
        goLiveButton_->setStyleSheet(QString(
            "QPushButton { background-color: %1; color: white; font-size: 14px; font-weight: bold; }")
            .arg(COLOR_YELLOW));
        if (goLiveAction_) {
            goLiveAction_->setText("Starting...");
            goLiveAction_->setEnabled(false);
        }
        if (goLiveMenuAction_) {
            goLiveMenuAction_->setText("Starting...");
            goLiveMenuAction_->setEnabled(false);
        }
        return;
    }

    if (stopInProgress_) {
        goLiveButton_->setText("STOPPING...");
        goLiveButton_->setEnabled(false);
        goLiveButton_->setStyleSheet(QString(
            "QPushButton { background-color: %1; color: white; font-size: 14px; font-weight: bold; }")
            .arg(COLOR_YELLOW));
        if (goLiveAction_) {
            goLiveAction_->setText("Stopping...");
            goLiveAction_->setEnabled(false);
        }
        if (goLiveMenuAction_) {
            goLiveMenuAction_->setText("Stopping...");
            goLiveMenuAction_->setEnabled(false);
        }
        return;
    }

    if (isLive_) {
        goLiveButton_->setText("STOP");
        goLiveButton_->setEnabled(true);
        goLiveButton_->setStyleSheet(QString(
            "QPushButton { background-color: %1; color: white; font-size: 14px; font-weight: bold; }"
            "QPushButton:hover { background-color: #ff4444; }"
        ).arg(COLOR_RED));
        if (goLiveAction_) {
            goLiveAction_->setText("Stop");
            goLiveAction_->setEnabled(true);
        }
        if (goLiveMenuAction_) {
            goLiveMenuAction_->setText("Stop");
            goLiveMenuAction_->setEnabled(true);
        }
    } else {
        goLiveButton_->setText("GO LIVE");
        goLiveButton_->setEnabled(!selectedWindowId_.isEmpty());
        goLiveButton_->setStyleSheet(QString(
            "QPushButton { background-color: %1; color: white; font-size: 14px; font-weight: bold; }"
            "QPushButton:hover { background-color: %2; }"
        ).arg(COLOR_ACCENT, COLOR_ACCENT_HOVER));
        if (goLiveAction_) {
            goLiveAction_->setText("Go Live");
            goLiveAction_->setEnabled(!selectedWindowId_.isEmpty());
        }
        if (goLiveMenuAction_) {
            goLiveMenuAction_->setText("Go Live");
            goLiveMenuAction_->setEnabled(!selectedWindowId_.isEmpty());
        }
    }
}

void MainWindow::updateStatus(const QString &text, const QString &statusClass) {
    statusLabel_->setText(text);

    QString color;
    if (statusClass == "live") {
        color = COLOR_ACCENT;
    } else if (statusClass == "error") {
        color = COLOR_RED;
    } else if (statusClass == "connecting") {
        color = COLOR_YELLOW;
    } else {
        color = COLOR_TEXT_DIM;
    }

    statusLabel_->setStyleSheet(QString("color: %1; font-weight: %2;")
        .arg(color, statusClass == "live" ? "bold" : "normal"));
}

void MainWindow::updateStats(const StreamStats &stats) {
    statsPanel_->updateStats(stats);
}

void MainWindow::onTrayIconActivated(QSystemTrayIcon::ActivationReason reason) {
    if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) {
        if (isVisible()) {
            hide();
            if (showHideAction_) {
                showHideAction_->setText("Show");
            }
        } else {
            show();
            raise();
            activateWindow();
            if (showHideAction_) {
                showHideAction_->setText("Hide");
            }
        }
    }
}

void MainWindow::onStatsTimer() {
    if (core_ && isLive_) {
        StreamStats stats;
        const auto metrics = core_->getStreamMetrics();
        const auto health = core_->getConnectionHealth();
        stats.videoBitrate = metrics.videoBitrateKbps > 0.0 ? metrics.videoBitrateKbps : selectedBitrateKbps();
        stats.audioBitrate = metrics.audioBitrateKbps > 0.0 ? metrics.audioBitrateKbps : 0.0;
        stats.frameRate = metrics.frameRate > 0.0 ? metrics.frameRate : fpsSelect_->currentData().toInt();
        stats.width = metrics.width;
        stats.height = metrics.height;

        std::string activeCodec = metrics.codec;
        if (activeCodec.empty()) {
            activeCodec = "H.264";
        }
        stats.codec = activeCodec;
        std::string encoderName = metrics.encoder;
        if (encoderName.empty()) {
            stats.encoder = core_->isHardwareVideoEncoder() ? "Hardware" : "Software";
        } else {
            stats.encoder = encoderName;
        }
        stats.rtt = 0;

        updateStats(stats);
        updateOperatorHealthUi(health);
        if (primaryAudioSourceLabel_) {
            primaryAudioSourceLabel_->setText(audioSourceSummaryText());
        }
        if (microphoneAudioSourceLabel_) {
            microphoneAudioSourceLabel_->setText(microphoneSourceSummaryText());
        }

        updateAudioMeter(audioMeter_, audioLevelLabel_, core_->getAudioLevelRms(), core_->getAudioPeak());
        updateAudioMeter(
            primaryAudioMeter_,
            primaryAudioLevelLabel_,
            core_->getPrimaryAudioLevelRms(),
            core_->getPrimaryAudioPeak());
        const bool showAdditionalMicLevel =
            includeMicrophoneCheck_ &&
            includeMicrophoneCheck_->isChecked() &&
            (!audioSourceSelect_ || audioSourceSelect_->currentData().toString() != QStringLiteral("default-microphone"));
        updateAudioMeter(
            microphoneAudioMeter_,
            microphoneAudioLevelLabel_,
            showAdditionalMicLevel ? core_->getAdditionalAudioLevelRms() : 0.0f,
            showAdditionalMicLevel ? core_->getAdditionalAudioPeak() : 0.0f);
    } else {
        resetOperatorHealthUi();
    }
}

void MainWindow::onBitratePresetChanged(int) {
    const bool custom = bitrateSelect_->currentData().toInt() <= 0;
    customBitrateSpin_->setEnabled(custom);
}

void MainWindow::onAdvancedToggleChanged(bool checked) {
    if (!advancedPanel_) {
        return;
    }
    advancedPanel_->setVisible(checked);
}

void MainWindow::syncCodecUiState() {
    if (!encoderSelect_ || !codecSelect_) {
        return;
    }

    const versus::video::VideoCodec selectedCodec = codecFromUiValue(codecSelect_->currentData().toString());
    const bool usesExternalFfmpeg = codecUsesExternalFfmpeg(selectedCodec);
    const QString mode = encoderSelect_->currentData().toString();
    const bool alphaWorkflowSelected = alphaWorkflowCheck_ && alphaWorkflowCheck_->isChecked();
    const bool enableFfmpegFields = mode == "ffmpeg_nvenc" || usesExternalFfmpeg || alphaWorkflowSelected;
    if (ffmpegPathInput_) {
        ffmpegPathInput_->setEnabled(enableFfmpegFields);
    }
    if (ffmpegOptionsInput_) {
        ffmpegOptionsInput_->setEnabled(enableFfmpegFields);
    }

    const bool supportsAlpha = codecSupportsAlphaWorkflow(selectedCodec);
    if (alphaWorkflowCheck_) {
        if (!supportsAlpha && alphaWorkflowCheck_->isChecked()) {
            alphaWorkflowCheck_->setChecked(false);
        }
        alphaWorkflowCheck_->setEnabled(supportsAlpha);
        alphaWorkflowCheck_->setText(alphaWorkflowTextFor(selectedCodec));
        alphaWorkflowCheck_->setToolTip(alphaWorkflowTooltipFor(selectedCodec));
    }
    const bool alphaWorkflowEnabled =
        alphaWorkflowCheck_ &&
        alphaWorkflowCheck_->isChecked();
    if (alphaBackgroundModeSelect_) {
        alphaBackgroundModeSelect_->setEnabled(!alphaWorkflowEnabled);
        alphaBackgroundModeSelect_->setToolTip(alphaWorkflowEnabled
            ? "Alpha-preserving encode is enabled, so Game Capture keeps the source alpha instead of compositing a background."
            : "Composites transparent BGRA/Spout2 pixels over a solid color before encoding. Use chroma background with H.264/NVENC when true VP9 alpha is too CPU-heavy.");
    }
    if (alphaBackgroundColorButton_) {
        const bool backgroundEnabled = alphaBackgroundModeSelect_ &&
            alphaBackgroundModeSelect_->currentData().toString() != "none" &&
            !alphaWorkflowEnabled;
        alphaBackgroundColorButton_->setEnabled(backgroundEnabled);
    }

    if (codecSelect_) {
        codecSelect_->setToolTip(codecTooltipFor(selectedCodec));
    }
    refreshFfmpegStatus();
}

void MainWindow::updateAlphaBackgroundColorButton() {
    if (!alphaBackgroundColorButton_) {
        return;
    }
    const QString hex = colorToHex(alphaBackgroundColor_);
    alphaBackgroundColorButton_->setText(hex);
    alphaBackgroundColorButton_->setStyleSheet(QString(
        "QPushButton { background-color: %1; color: %2; border: 1px solid #2a4158; border-radius: 6px; font-weight: 700; }"
        "QPushButton:disabled { background-color: #172330; color: #6f849a; }")
        .arg(hex, alphaBackgroundColor_.lightness() > 140 ? "#07111b" : "#ffffff"));
}

void MainWindow::chooseAlphaBackgroundColor() {
    const QColor chosen = QColorDialog::getColor(alphaBackgroundColor_, this, "Choose Alpha Background Color");
    if (!chosen.isValid()) {
        return;
    }
    alphaBackgroundColor_ = chosen;
    updateAlphaBackgroundColorButton();
    savePersistedSettings();
}

void MainWindow::refreshFfmpegStatus() {
    if (!ffmpegStatusLabel_) {
        return;
    }
    const QString configuredPath = ffmpegPathInput_ ? ffmpegPathInput_->text().trimmed() : QString();
    const versus::video::FfmpegProbeInfo info =
        versus::video::VideoEncoder::probeFfmpeg(configuredPath.toStdString());
    const bool alphaWorkflowSelected = alphaWorkflowCheck_ && alphaWorkflowCheck_->isChecked();
    const bool needsFfmpeg =
        codecSelect_ &&
        (codecUsesExternalFfmpeg(codecFromUiValue(codecSelect_->currentData().toString())) ||
         (encoderSelect_ && encoderSelect_->currentData().toString() == "ffmpeg_nvenc") ||
         alphaWorkflowSelected);
    if (!needsFfmpeg) {
        ffmpegStatusLabel_->setText("Only needed for VP9/AV1/H.265 or FFmpeg NVENC.");
        ffmpegStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
        return;
    }
    if (!info.resolved) {
        ffmpegStatusLabel_->setText("ffmpeg.exe not found. VP9 alpha requires the bundled FFmpeg/libvpx or a compatible custom path.");
        ffmpegStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px; font-weight: 600;").arg(COLOR_YELLOW));
        return;
    }
    const bool selectedVp9 = codecSelect_ &&
        codecFromUiValue(codecSelect_->currentData().toString()) == versus::video::VideoCodec::VP9;
    const bool needsLibvpxVp9 = selectedVp9 || alphaWorkflowSelected;
    const QString source = info.userOverride
        ? QStringLiteral("custom")
        : (info.bundled ? QStringLiteral("bundled") : QStringLiteral("development"));
    QString status = QString("Using %1 FFmpeg: %2").arg(source, QString::fromStdString(info.path));
    if (!info.version.empty()) {
        status += QString("\n%1").arg(QString::fromStdString(info.version));
    }
    if (info.gplEnabled || info.nonfreeEnabled) {
        status += "\nWarning: GPL/nonfree flags detected.";
        ffmpegStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px; font-weight: 600;").arg(COLOR_YELLOW));
        ffmpegStatusLabel_->setText(status);
        return;
    }
    if (needsLibvpxVp9 && !info.hasLibvpxVp9) {
        status += "\nMissing libvpx-vp9; VP9 alpha will not start.";
        ffmpegStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px; font-weight: 600;").arg(COLOR_YELLOW));
        ffmpegStatusLabel_->setText(status);
        return;
    }
    if (needsLibvpxVp9) {
        status += "\nlibvpx-vp9 available; VP9 alpha is CPU encoded.";
    }
    ffmpegStatusLabel_->setText(status);
    ffmpegStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
}

int MainWindow::selectedBitrateKbps() const {
    const int presetValue = bitrateSelect_->currentData().toInt();
    if (presetValue > 0) {
        return presetValue;
    }
    return customBitrateSpin_->value();
}

QString MainWindow::audioSourceSummaryText() const {
    if (!audioSourceSelect_) {
        return QStringLiteral("Primary: -");
    }
    const QString text = audioSourceSelect_->currentText().trimmed();
    const int gain = primaryAudioGainSpin_ ? primaryAudioGainSpin_->value() : 100;
    return QStringLiteral("Primary: %1 (%2%)").arg(text.isEmpty() ? QStringLiteral("-") : text).arg(gain);
}

QString MainWindow::microphoneSourceSummaryText() const {
    const QString primarySource = audioSourceSelect_ ? audioSourceSelect_->currentData().toString() : QString();
    if (primarySource == QStringLiteral("default-microphone")) {
        return QStringLiteral("Mic/input: Primary source");
    }
    if (!includeMicrophoneCheck_ || !includeMicrophoneCheck_->isChecked()) {
        return QStringLiteral("Mic/input: Off");
    }
    const QString text = microphoneDeviceSelect_ ? microphoneDeviceSelect_->currentText().trimmed() : QString();
    const int gain = microphoneAudioGainSpin_ ? microphoneAudioGainSpin_->value() : 100;
    return QStringLiteral("Mic/input: %1 (%2%)")
        .arg(text.isEmpty() ? QStringLiteral("Windows default") : text)
        .arg(gain);
}

void MainWindow::updateAudioMeter(QProgressBar *meter, QLabel *label, float rms, float peak) {
    if (!meter || !label) {
        return;
    }

    double db = (rms > 1.0e-6f) ? (20.0 * std::log10(static_cast<double>(rms))) : -90.0;
    db = std::clamp(db, -90.0, 0.0);
    int meterPct = static_cast<int>(std::round(((db + 60.0) / 60.0) * 100.0));
    meterPct = std::clamp(meterPct, 0, 100);
    meterPct = std::max(meterPct, static_cast<int>(std::round(std::clamp(peak, 0.0f, 1.0f) * 100.0f)));
    meter->setValue(meterPct);

    if (db <= -89.0) {
        label->setText("-inf dB");
    } else {
        label->setText(QString("%1 dB").arg(db, 0, 'f', 1));
    }

    QString meterColor = COLOR_ACCENT;
    if (meterPct >= 85) {
        meterColor = COLOR_RED;
    } else if (meterPct >= 65) {
        meterColor = COLOR_YELLOW;
    }
    meter->setStyleSheet(QString(
        "QProgressBar { border: 1px solid #2f4254; border-radius: 4px; background: #0d1620; }"
        "QProgressBar::chunk { background-color: %1; border-radius: 3px; }").arg(meterColor));
}

void MainWindow::resetOperatorHealthUi() {
    if (connectionHealthLabel_) {
        connectionHealthLabel_->setText("ICE: - | Candidates: - | Peers: 0");
        connectionHealthLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    }
    if (connectionMediaLabel_) {
        connectionMediaLabel_->setText("Codec: - | FPS: - | Resolution: - | Bitrate: -");
        connectionMediaLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    }
    if (systemResourceLabel_) {
        systemResourceLabel_->setText("System: CPU - | RAM -");
        systemResourceLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    }
    if (connectionIssueLabel_) {
        connectionIssueLabel_->setText("Drops/encode/video/audio send: 0/0/0/0 | Last disconnect: none");
        connectionIssueLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    }

    if (primaryAudioSourceLabel_) {
        primaryAudioSourceLabel_->setText(audioSourceSummaryText());
    }
    if (microphoneAudioSourceLabel_) {
        microphoneAudioSourceLabel_->setText(microphoneSourceSummaryText());
    }

    updateAudioMeter(audioMeter_, audioLevelLabel_, 0.0f, 0.0f);
    updateAudioMeter(primaryAudioMeter_, primaryAudioLevelLabel_, 0.0f, 0.0f);
    updateAudioMeter(microphoneAudioMeter_, microphoneAudioLevelLabel_, 0.0f, 0.0f);
}

void MainWindow::updateOperatorHealthUi(const versus::app::ConnectionHealth &health) {
    const QString iceMode = QString::fromStdString(health.iceMode.empty() ? std::string("-") : health.iceMode);
    const QString candidatePath = QString::fromStdString(
        health.candidatePath.empty() ? std::string("-") : health.candidatePath);

    if (connectionHealthLabel_) {
        connectionHealthLabel_->setText(QString("ICE: %1 | Candidates: %2 | Peers: %3 (%4 HQ / %5 LQ, V%6/A%7)")
            .arg(iceMode)
            .arg(candidatePath)
            .arg(health.peerCount)
            .arg(health.hqPeerCount)
            .arg(health.lqPeerCount)
            .arg(health.activeVideoPeers)
            .arg(health.activeAudioPeers));
        const bool relayPath = candidatePath.contains("Relay", Qt::CaseInsensitive);
        connectionHealthLabel_->setStyleSheet(QString("color: %1;").arg(relayPath ? COLOR_YELLOW : COLOR_TEXT_DIM));
    }

    if (connectionMediaLabel_) {
        const QString codec = QString::fromStdString(health.codec.empty() ? std::string("-") : health.codec);
        const QString resolution = (health.width > 0 && health.height > 0)
            ? QString("%1x%2").arg(health.width).arg(health.height)
            : QStringLiteral("-");
        connectionMediaLabel_->setText(QString("Codec: %1 | FPS: %2 | Sent: %3 | Bitrate: %4 kbps video / %5 kbps audio")
            .arg(codec)
            .arg(health.frameRate, 0, 'f', 1)
            .arg(resolution)
            .arg(health.videoBitrateKbps, 0, 'f', 0)
            .arg(health.audioBitrateKbps, 0, 'f', 0));
        connectionMediaLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    }

    if (systemResourceLabel_) {
        systemResourceLabel_->setText(QString("System: CPU %1 | RAM %2")
            .arg(percentText(health.systemCpuPercent))
            .arg(percentText(health.systemMemoryPercent)));
        systemResourceLabel_->setStyleSheet(
            QString("color: %1;").arg(systemResourceColor(health.systemCpuPercent, health.systemMemoryPercent)));
    }

    if (connectionIssueLabel_) {
        const QString lastDisconnect = health.lastPeerDisconnectReason.empty()
            ? QStringLiteral("none")
            : QString::fromStdString(health.lastPeerDisconnectReason);
        connectionIssueLabel_->setText(QString("Drops/encode/video/audio send: %1 (%2/s) / %3 / %4 / %5 | Last disconnect: %6")
            .arg(static_cast<qulonglong>(health.videoFramesDropped))
            .arg(health.droppedFrameRate, 0, 'f', 1)
            .arg(static_cast<qulonglong>(health.videoEncodeFailures + health.videoEncodeTimeouts))
            .arg(static_cast<qulonglong>(health.videoSendFailures))
            .arg(static_cast<qulonglong>(health.audioSendFailures))
            .arg(lastDisconnect));
        const bool hasFailures = health.videoFramesDropped > 0 ||
                                 health.videoEncodeFailures > 0 ||
                                 health.videoEncodeTimeouts > 0 ||
                                 health.videoSendFailures > 0 ||
                                 health.audioSendFailures > 0;
        connectionIssueLabel_->setStyleSheet(QString("color: %1;").arg(hasFailures ? COLOR_YELLOW : COLOR_TEXT_DIM));
    }
}

void MainWindow::setConfigControlsEnabled(bool enabled) {
    if (windowListWidget_) {
        windowListWidget_->setEnabled(enabled);
    }
    if (sourceModeSelect_) {
        sourceModeSelect_->setEnabled(enabled);
    }
    if (streamIdInput_) {
        streamIdInput_->setEnabled(enabled);
    }
    if (passwordInput_) {
        passwordInput_->setEnabled(enabled);
    }
    setSensitiveRevealEnabled(passwordInput_, passwordRevealButton_, enabled, "password");
    if (advancedToggle_) {
        const bool locked = !enabled;
        advancedToggle_->setEnabled(true);
        advancedToggle_->setCheckable(!locked);
        advancedToggle_->setProperty("locked", locked);
        advancedToggle_->setCursor(locked ? Qt::ForbiddenCursor : Qt::PointingHandCursor);
        advancedToggle_->setToolTip(locked
            ? QStringLiteral("Cannot change settings while live. Stop stream first.")
            : QString());
        advancedToggle_->style()->unpolish(advancedToggle_);
        advancedToggle_->style()->polish(advancedToggle_);
        advancedToggle_->update();
    }

    if (roomInput_) {
        roomInput_->setEnabled(enabled);
    }
    if (labelInput_) {
        labelInput_->setEnabled(enabled);
    }
    if (resolutionSelect_) {
        resolutionSelect_->setEnabled(enabled);
    }
    if (fpsSelect_) {
        fpsSelect_->setEnabled(enabled);
    }
    if (bitrateSelect_) {
        bitrateSelect_->setEnabled(enabled);
    }
    if (customBitrateSpin_) {
        const bool customBitrateSelected = bitrateSelect_ && bitrateSelect_->currentData().toInt() <= 0;
        customBitrateSpin_->setEnabled(enabled && customBitrateSelected);
    }
    if (viewerLimitSpin_) {
        viewerLimitSpin_->setEnabled(enabled);
    }
    if (roomModeLqCheck_) {
        roomModeLqCheck_->setEnabled(enabled);
    }
    if (iceModeSelect_) {
        iceModeSelect_->setEnabled(enabled);
    }
    if (audioSourceSelect_) {
        audioSourceSelect_->setEnabled(enabled);
    }
    if (includeMicrophoneCheck_) {
        includeMicrophoneCheck_->setEnabled(enabled);
    }
    if (microphoneDeviceSelect_) {
        microphoneDeviceSelect_->setEnabled(enabled);
    }
    if (primaryAudioGainSpin_) {
        primaryAudioGainSpin_->setEnabled(enabled);
    }
    if (microphoneAudioGainSpin_) {
        microphoneAudioGainSpin_->setEnabled(enabled);
    }
    if (audioLimiterCheck_) {
        audioLimiterCheck_->setEnabled(enabled);
    }
    if (remoteControlCheck_) {
        remoteControlCheck_->setEnabled(enabled);
    }
    if (remoteControlTokenInput_) {
        const bool remoteControlEnabled = remoteControlCheck_ && remoteControlCheck_->isChecked();
        remoteControlTokenInput_->setEnabled(enabled && remoteControlEnabled);
        setSensitiveRevealEnabled(
            remoteControlTokenInput_,
            remoteControlTokenRevealButton_,
            enabled && remoteControlEnabled,
            "control token");
    }
    if (encoderSelect_) {
        encoderSelect_->setEnabled(enabled);
    }
    if (codecSelect_) {
        codecSelect_->setEnabled(enabled);
    }
    if (alphaWorkflowCheck_) {
        alphaWorkflowCheck_->setEnabled(enabled && codecSupportsAlphaWorkflow(
            codecFromUiValue(codecSelect_ ? codecSelect_->currentData().toString() : QString("h264"))));
    }
    if (alphaBackgroundModeSelect_) {
        const bool alphaWorkflowEnabled = alphaWorkflowCheck_ && alphaWorkflowCheck_->isChecked();
        alphaBackgroundModeSelect_->setEnabled(enabled && !alphaWorkflowEnabled);
    }
    if (alphaBackgroundColorButton_) {
        const bool backgroundSelected = alphaBackgroundModeSelect_ &&
            alphaBackgroundModeSelect_->currentData().toString() != "none";
        const bool alphaWorkflowEnabled = alphaWorkflowCheck_ && alphaWorkflowCheck_->isChecked();
        alphaBackgroundColorButton_->setEnabled(enabled && backgroundSelected && !alphaWorkflowEnabled);
    }
    if (ffmpegPathInput_) {
        ffmpegPathInput_->setEnabled(enabled);
    }
    if (ffmpegOptionsInput_) {
        ffmpegOptionsInput_->setEnabled(enabled);
    }

    if (enabled) {
        onBitratePresetChanged(bitrateSelect_ ? bitrateSelect_->currentIndex() : 0);
        syncCodecUiState();
    }
}

void MainWindow::updateTrayLiveIndicator(bool live) {
    if (!trayIcon_) {
        return;
    }

    trayIcon_->setToolTip(live ? APP_TRAY_LIVE : APP_TRAY_IDLE);
    trayIcon_->setIcon(makeTrayLiveIcon(trayBaseIcon_, live));
}

void MainWindow::refreshSelectedWindowPreview() {
    if (!previewLabel_) {
        return;
    }

    const QString sourceMode = sourceModeSelect_ ? sourceModeSelect_->currentData().toString() : QString("window");
    if (selectedWindowId_.isEmpty()) {
        previewLabel_->setPixmap(QPixmap());
        previewLabel_->setText(sourceMode == "spout"
            ? "Select a Spout2 sender"
            : "Select a window to see live preview");
        return;
    }

    if (sourceMode == "spout") {
        previewLabel_->setPixmap(QPixmap());
        QStringList lines;
        lines << "Spout2 sender selected" << selectedWindowId_;
        if (core_) {
            const auto senders = core_->listSpoutSenders();
            const auto match = std::find_if(senders.begin(), senders.end(), [this](const auto &sender) {
                return QString::fromStdString(sender.id) == selectedWindowId_;
            });
            if (match != senders.end() && match->width > 0 && match->height > 0) {
                lines << QString("%1x%2").arg(match->width).arg(match->height);
            }
            const auto sourceHealth = core_->getSourceHealth();
            if (sourceHealth.mode == versus::app::VideoSourceMode::Spout &&
                QString::fromStdString(sourceHealth.sourceId) == selectedWindowId_ &&
                sourceHealth.hasFrame) {
                if (sourceHealth.alphaDetected) {
                    lines << "Transparency detected";
                } else if (sourceHealth.greenBackgroundLikely) {
                    lines << "Green background detected";
                } else if (sourceHealth.bgra) {
                    lines << "No transparency detected";
                } else {
                    lines << "Source format does not expose alpha";
                }
                if (sourceHealth.largeSource) {
                    lines << "Large source may lower FPS";
                }
                if (sourceHealth.resizeCount > 0) {
                    lines << QString("Sender resized %1 time%2")
                        .arg(static_cast<qulonglong>(sourceHealth.resizeCount))
                        .arg(sourceHealth.resizeCount == 1 ? "" : "s");
                }
            } else if (isLive_) {
                lines << "Checking source alpha...";
            }
        }

        const bool vp9Selected = codecSelect_ && codecSelect_->currentData().toString() == "vp9";
        const bool alphaEnabled = alphaWorkflowCheck_ && alphaWorkflowCheck_->isChecked();
        const bool chromaBackground =
            alphaBackgroundModeSelect_ &&
            alphaBackgroundModeSelect_->currentData().toString() == "chroma" &&
            !alphaEnabled;
        lines << (vp9Selected && alphaEnabled
            ? "True alpha requires VDO.Ninja OBS plugin"
            : (chromaBackground
                ? QString("Chroma output over %1").arg(colorToHex(alphaBackgroundColor_))
                : "For transparency: VP9 alpha or chroma background"));
        lines << "Video only; choose audio separately";
        lines << "Output uses selected stream resolution";
        previewLabel_->setText(lines.join('\n'));
        return;
    }

    QPixmap preview = versus::video::WindowCapture::captureWindowThumbnail(
        selectedWindowId_.toStdString(), 420, 220);
    if (preview.isNull()) {
        previewLabel_->setPixmap(QPixmap());
        previewLabel_->setText("Preview unavailable for this window");
        return;
    }

    previewLabel_->setText(QString());
    QSize targetSize = previewLabel_->contentsRect().size();
    if (!targetSize.isValid() || targetSize.isEmpty()) {
        targetSize = previewLabel_->size();
    }
    if (!targetSize.isValid() || targetSize.isEmpty()) {
        targetSize = QSize(420, 220);
    }
    previewLabel_->setPixmap(preview.scaled(
        targetSize,
        Qt::KeepAspectRatio,
        Qt::SmoothTransformation));
}

void MainWindow::closeEvent(QCloseEvent *event) {
    savePersistedSettings();

    if (!quitRequested_ && minimizeToTrayOnClose_) {
        if (!trayIcon_ && QSystemTrayIcon::isSystemTrayAvailable()) {
            setupTrayIcon();
        }

        if (trayIcon_ && !trayIcon_->isVisible()) {
            trayIcon_->show();
        }

        if (!trayIcon_ || !trayIcon_->isVisible()) {
            event->ignore();
            show();
            raise();
            activateWindow();
            updateStatus("System tray unavailable. App remains open.", "error");
            spdlog::warn("[UI] Close-to-tray requested but tray icon is unavailable; keeping window visible");
            return;
        }

        event->ignore();
        hide();
        if (showHideAction_) {
            showHideAction_->setText("Show");
        }
        if (trayIcon_->supportsMessages()) {
            trayIcon_->showMessage(
                APP_BRAND,
                "Still running in system tray (next to the clock)",
                QSystemTrayIcon::Information,
                3000);
        }
        return;
    }

    if (hasPendingAsyncOperation() && !forceQuitRequested_) {
        quitRequested_ = true;
        if (forceQuitEnabled_ || quitAfterPendingOps_) {
            forceQuitRequested_ = true;
            qApp->setProperty("force_exit_without_shutdown", true);
        } else {
            quitAfterPendingOps_ = true;
            event->ignore();
            updateStatus("Waiting for the current stream operation to finish. Close again to force quit.", "connecting");
            return;
        }
    }

    QMainWindow::closeEvent(event);
}

}  // namespace versus::ui
