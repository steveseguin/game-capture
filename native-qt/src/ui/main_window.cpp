#include "versus/ui/main_window.h"

#include <QApplication>
#include <QClipboard>
#include <QDesktopServices>
#include <QFormLayout>
#include <QFontDatabase>
#include <QFrame>
#include <QGuiApplication>
#include <QHBoxLayout>
#include <QIcon>
#include <QMenuBar>
#include <QMetaObject>
#include <QPainter>
#include <QSignalBlocker>
#include <QSplitter>
#include <QStyle>
#include <QUrlQuery>
#include <QUrl>
#include <QVBoxLayout>

#include <spdlog/spdlog.h>

#include <algorithm>
#include <cmath>

namespace versus::ui {

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

bool codecRequiresFfmpegPath(versus::video::VideoCodec codec) {
    return codec != versus::video::VideoCodec::H264;
}

bool codecSupportsAlphaWorkflow(versus::video::VideoCodec codec) {
    return codec == versus::video::VideoCodec::AV1 || codec == versus::video::VideoCodec::VP9;
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
    setupTrayIcon();

    // Stats timer (update every second when live)
    statsTimer_ = new QTimer(this);
    statsTimer_->setInterval(1000);
    connect(statsTimer_, &QTimer::timeout, this, &MainWindow::onStatsTimer);

    // Preview timer for selected window thumbnail
    previewTimer_ = new QTimer(this);
    previewTimer_->setInterval(1500);
    connect(previewTimer_, &QTimer::timeout, this, &MainWindow::refreshSelectedWindowPreview);
    previewTimer_->start();

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

                updateStatus(status, "error");
                if (trayIcon_ && trayIcon_->supportsMessages()) {
                    trayIcon_->showMessage(APP_BRAND, status, QSystemTrayIcon::Warning, 5000);
                }

                if (!fatal) {
                    return;
                }

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
                if (audioMeter_) {
                    audioMeter_->setValue(0);
                }
                if (audioLevelLabel_) {
                    audioLevelLabel_->setText("-inf dB");
                }
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
                refreshSelectedWindowPreview();
                updateGoLiveButton();
            }, Qt::QueuedConnection);
        });
    }
}

MainWindow::~MainWindow() {
    if (core_) {
        core_->onRuntimeEvent(nullptr);
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
        quitRequested_ = true;
        qApp->quit();
    });

    auto *viewMenu = menuBar()->addMenu("&View");
    auto *refreshAction = viewMenu->addAction("Refresh Windows");
    connect(refreshAction, &QAction::triggered, this, &MainWindow::onRefreshWindows);

    minimizeToTrayOnCloseAction_ = viewMenu->addAction("Minimize To Tray On Close");
    minimizeToTrayOnCloseAction_->setCheckable(true);
    minimizeToTrayOnCloseAction_->setChecked(minimizeToTrayOnClose_);
    connect(minimizeToTrayOnCloseAction_, &QAction::toggled, this, [this](bool checked) {
        minimizeToTrayOnClose_ = checked;
    });

    auto *helpMenu = menuBar()->addMenu("&Help");
    auto *openVdoAction = helpMenu->addAction("Open VDO.Ninja");
    connect(openVdoAction, &QAction::triggered, this, []() {
        QDesktopServices::openUrl(QUrl("https://vdo.ninja/"));
    });
}

void MainWindow::setupUI() {
    auto *central = new QWidget(this);
    auto *layout = new QVBoxLayout(central);
    layout->setSpacing(12);
    layout->setContentsMargins(16, 16, 16, 16);

    auto *captureSplitter = new QSplitter(Qt::Horizontal, this);
    captureSplitter->setChildrenCollapsible(false);

    // Window list widget
    windowListWidget_ = new WindowListWidget(this);
    windowListWidget_->setMinimumWidth(300);
    connect(windowListWidget_, &WindowListWidget::windowSelected, this, &MainWindow::onWindowSelected);
    connect(windowListWidget_, &WindowListWidget::refreshRequested, this, &MainWindow::onRefreshWindows);
    captureSplitter->addWidget(windowListWidget_);

    // Selected window preview
    auto *previewFrame = new QFrame(this);
    previewFrame->setObjectName("previewFrame");
    previewFrame->setMinimumWidth(280);
    auto *previewLayout = new QVBoxLayout(previewFrame);
    previewLayout->setContentsMargins(8, 8, 8, 8);
    previewLayout->setSpacing(4);
    auto *previewTitle = new QLabel("Selected Window Preview", this);
    previewTitle->setStyleSheet(QString("color: %1; font-weight: bold;").arg(COLOR_TEXT_DIM));
    previewLayout->addWidget(previewTitle);

    previewLabel_ = new QLabel("Select a window to see live preview", this);
    previewLabel_->setObjectName("selectedPreview");
    previewLabel_->setAlignment(Qt::AlignCenter);
    previewLabel_->setMinimumHeight(150);
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
    passwordInput_->setPlaceholderText("Password (leave blank for default, 'false' to disable)");
    basicForm->addRow("Password", passwordInput_);
    layout->addLayout(basicForm);

    auto *urlHint = new QLabel("Tip: paste a full VDO URL and Game Capture auto-uses stream/room/password.", this);
    urlHint->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
    urlHint->setWordWrap(true);
    layout->addWidget(urlHint);

    advancedToggle_ = new QCheckBox("Show advanced settings", this);
    advancedToggle_->setChecked(false);
    layout->addWidget(advancedToggle_);

    advancedPanel_ = new QWidget(this);
    auto *advancedForm = new QFormLayout(advancedPanel_);
    advancedForm->setSpacing(8);
    layout->addWidget(advancedPanel_);
    advancedPanel_->setVisible(false);
    connect(advancedToggle_, &QCheckBox::toggled, this, &MainWindow::onAdvancedToggleChanged);

    roomInput_ = new QLineEdit(this);
    roomInput_->setPlaceholderText("Room ID (optional)");
    advancedForm->addRow("Room", roomInput_);

    labelInput_ = new QLineEdit(this);
    labelInput_->setPlaceholderText("Stream label (optional)");
    advancedForm->addRow("Label", labelInput_);

    resolutionSelect_ = new QComboBox(this);
    resolutionSelect_->addItem("1920x1080", QVariant("1920x1080"));
    resolutionSelect_->addItem("1280x720", QVariant("1280x720"));
    resolutionSelect_->addItem("960x540", QVariant("960x540"));
    advancedForm->addRow("Resolution", resolutionSelect_);

    fpsSelect_ = new QComboBox(this);
    fpsSelect_->addItem("60", QVariant(60));
    fpsSelect_->addItem("30", QVariant(30));
    advancedForm->addRow("FPS", fpsSelect_);

    bitrateSelect_ = new QComboBox(this);
    bitrateSelect_->addItem("Ultra (20000 kbps)", QVariant(20000));
    bitrateSelect_->addItem("High (12000 kbps)", QVariant(12000));
    bitrateSelect_->addItem("Medium (6000 kbps)", QVariant(6000));
    bitrateSelect_->addItem("Low (3000 kbps)", QVariant(3000));
    bitrateSelect_->addItem("Custom", QVariant(-1));
    bitrateSelect_->setCurrentIndex(1);
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

    remoteControlCheck_ = new QCheckBox("Enable director control via data channel", this);
    remoteControlCheck_->setObjectName("remoteControlCheck");
    remoteControlCheck_->setChecked(false);
    advancedForm->addRow("Remote Control", remoteControlCheck_);

    remoteControlTokenInput_ = new QLineEdit(this);
    remoteControlTokenInput_->setObjectName("remoteControlTokenInput");
    remoteControlTokenInput_->setPlaceholderText("Optional token (defaults to password or stream ID)");
    remoteControlTokenInput_->setEnabled(false);
    advancedForm->addRow("Control Token", remoteControlTokenInput_);

    connect(remoteControlCheck_, &QCheckBox::toggled, this, [this](bool checked) {
        if (remoteControlTokenInput_) {
            remoteControlTokenInput_->setEnabled(checked);
        }
    });

    encoderSelect_ = new QComboBox(this);
    encoderSelect_->addItem("Auto (Prefer NVIDIA)", QVariant("auto"));
    encoderSelect_->addItem("NVIDIA NVENC", QVariant("nvenc"));
    encoderSelect_->addItem("FFmpeg NVENC (Advanced)", QVariant("ffmpeg_nvenc"));
    encoderSelect_->addItem("Intel Quick Sync", QVariant("qsv"));
    encoderSelect_->addItem("AMD AMF", QVariant("amf"));
    encoderSelect_->addItem("Software", QVariant("software"));
    advancedForm->addRow("Encoder", encoderSelect_);

    codecSelect_ = new QComboBox(this);
    codecSelect_->setObjectName("codecSelect");
    codecSelect_->addItem("H.264 (Compatibility)", QVariant("h264"));
    codecSelect_->addItem("H.265 / HEVC (Experimental)", QVariant("h265"));
    codecSelect_->addItem("AV1 (Experimental)", QVariant("av1"));
    codecSelect_->addItem("VP9 + Alpha (Preview)", QVariant("vp9"));
    advancedForm->addRow("Video Codec", codecSelect_);

    alphaWorkflowCheck_ = new QCheckBox("Enable alpha-transparency workflow (experimental)", this);
    alphaWorkflowCheck_->setObjectName("alphaWorkflowCheck");
    alphaWorkflowCheck_->setChecked(false);
    alphaWorkflowCheck_->setEnabled(false);
    advancedForm->addRow("Alpha", alphaWorkflowCheck_);

    ffmpegPathInput_ = new QLineEdit(this);
    ffmpegPathInput_->setObjectName("ffmpegPathInput");
    ffmpegPathInput_->setPlaceholderText("Optional ffmpeg path (auto-discovered if empty)");
    ffmpegPathInput_->setEnabled(false);
    advancedForm->addRow("FFmpeg Path", ffmpegPathInput_);

    ffmpegOptionsInput_ = new QLineEdit(this);
    ffmpegOptionsInput_->setObjectName("ffmpegOptionsInput");
    ffmpegOptionsInput_->setPlaceholderText("Optional ffmpeg options (e.g. -preset llhq -rc cbr)");
    ffmpegOptionsInput_->setEnabled(false);
    advancedForm->addRow("FFmpeg Options", ffmpegOptionsInput_);

    connect(encoderSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int) {
        syncCodecUiState();
    });
    connect(codecSelect_, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int) {
        syncCodecUiState();
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

    // Audio input meter
    auto *audioLayout = new QHBoxLayout();
    auto *audioTitle = new QLabel("Audio Input", this);
    audioTitle->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    audioLayout->addWidget(audioTitle);

    audioMeter_ = new QProgressBar(this);
    audioMeter_->setObjectName("audioMeter");
    audioMeter_->setRange(0, 100);
    audioMeter_->setValue(0);
    audioMeter_->setTextVisible(false);
    audioMeter_->setFixedHeight(10);
    audioMeter_->setStyleSheet(QString(
        "QProgressBar { border: 1px solid #2f4254; border-radius: 4px; background: #0d1620; }"
        "QProgressBar::chunk { background-color: %1; border-radius: 3px; }").arg(COLOR_ACCENT));
    audioLayout->addWidget(audioMeter_, 1);

    audioLevelLabel_ = new QLabel("-inf dB", this);
    audioLevelLabel_->setStyleSheet(QString("color: %1;").arg(COLOR_TEXT_DIM));
    audioLevelLabel_->setMinimumWidth(70);
    audioLevelLabel_->setAlignment(Qt::AlignRight | Qt::AlignVCenter);
    audioLayout->addWidget(audioLevelLabel_);
    layout->addLayout(audioLayout);

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

    layout->addStretch();

    setCentralWidget(central);
    resize(980, 720);
}

void MainWindow::setupTrayIcon() {
    if (!QSystemTrayIcon::isSystemTrayAvailable()) {
        return;
    }

    trayIcon_ = new QSystemTrayIcon(this);
    trayBaseIcon_ = QIcon(":/icons/vdoninja.ico");
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
        quitRequested_ = true;
        qApp->quit();
    });

    trayIcon_->setContextMenu(trayMenu_);
    connect(trayIcon_, &QSystemTrayIcon::activated, this, &MainWindow::onTrayIconActivated);
    trayIcon_->show();
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
        QCheckBox::indicator {
            width: 14px;
            height: 14px;
        }
        QCheckBox::indicator:unchecked {
            border: 1px solid #4a6076;
            background-color: #0d1620;
        }
        QCheckBox::indicator:checked {
            border: 1px solid %4;
            background-color: %4;
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
        updateStatus("Ready to go live", "ready");
    }
}

void MainWindow::onRefreshWindows() {
    refreshWindowList();
    refreshSelectedWindowPreview();
}

void MainWindow::refreshWindowList() {
    if (core_) {
        auto windows = core_->listWindows();
        windowListWidget_->setWindowList(windows);
    }
}

void MainWindow::onGoLiveClicked() {
    if (!core_) {
        return;
    }

    if (isLive_) {
        core_->stopLive();
        core_->stopCapture();

        isLive_ = false;
        statsTimer_->stop();
        if (previewTimer_) {
            previewTimer_->start();
        }

        updateStatus("Stopped", "idle");
        shareLabel_->clear();
        if (copyShareLinkButton_) {
            copyShareLinkButton_->setEnabled(false);
        }
        if (openShareLinkButton_) {
            openShareLinkButton_->setEnabled(false);
        }
        statsPanel_->setVisible(false);
        statsPanel_->clear();
        audioMeter_->setValue(0);
        audioLevelLabel_->setText("-inf dB");
        encoderStatusLabel_->setText("Active Encoder: (not streaming)");
        encoderStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));

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

        windowListWidget_->setAutoRefreshEnabled(true);
        refreshSelectedWindowPreview();
    } else {
        updateStatus("Connecting...", "connecting");

        const QString resolutionText = resolutionSelect_->currentData().toString();
        const QStringList parts = resolutionText.split('x');
        const int width = parts.size() > 0 ? parts[0].toInt() : 1920;
        const int height = parts.size() > 1 ? parts[1].toInt() : 1080;
        const int fps = fpsSelect_->currentData().toInt();
        const int bitrate = selectedBitrateKbps();

        core_->setSelectedWindow(selectedWindowId_.toStdString());

        versus::video::EncoderConfig config;
        config.codec = codecFromUiValue(codecSelect_ ? codecSelect_->currentData().toString() : QString("h264"));
        config.enableAlpha = alphaWorkflowCheck_ ? alphaWorkflowCheck_->isChecked() : false;
        config.width = width;
        config.height = height;
        config.frameRate = fps > 0 ? fps : 60;
        config.bitrate = bitrate > 0 ? bitrate : 12000;
        config.minBitrate = std::max(500, config.bitrate / 2);
        config.maxBitrate = config.bitrate + 2000;
        config.ffmpegPath = ffmpegPathInput_ ? ffmpegPathInput_->text().trimmed().toStdString() : std::string();
        config.ffmpegOptions = ffmpegOptionsInput_ ? ffmpegOptionsInput_->text().toStdString() : std::string();

        if (config.codec == versus::video::VideoCodec::VP9) {
            updateStatus("VP9 transport is preview-only; use AV1 or H.264 for live publish", "error");
            return;
        }
        if (config.enableAlpha && !codecSupportsAlphaWorkflow(config.codec)) {
            config.enableAlpha = false;
        }

        const QString encoderMode = encoderSelect_->currentData().toString();
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
        if (codecRequiresFfmpegPath(config.codec)) {
            config.forceFfmpegNvenc = true;
        }

        spdlog::info("[UI] Applying encoder config: {}x{} @{}fps {}kbps mode={} codec={} alpha={}",
                     config.width,
                     config.height,
                     config.frameRate,
                     config.bitrate,
                     encoderMode.toStdString(),
                     codecSelect_ ? codecSelect_->currentData().toString().toStdString() : std::string("h264"),
                     config.enableAlpha);
        core_->setVideoConfig(config);

        if (!core_->startCapture(selectedWindowId_.toStdString())) {
            updateStatus("Failed to start capture", "error");
            return;
        }

        versus::app::StartOptions options;
        const QString streamTargetRaw = streamIdInput_->text().trimmed();
        const ParsedStreamTarget parsedTarget = parseStreamTargetInput(streamTargetRaw);
        if (!streamTargetRaw.isEmpty() && !parsedTarget.valid) {
            updateStatus("Invalid stream target URL", "error");
            core_->stopCapture();
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

        if (!core_->goLive(options)) {
            updateStatus("Failed to connect", "error");
            core_->stopCapture();
            return;
        }

        isLive_ = true;
        statsTimer_->start();
        if (previewTimer_) {
            previewTimer_->stop();
        }

        updateStatus("LIVE", "live");

        const QString shareLink = QString::fromStdString(core_->getShareLink());
        if (shareLink.isEmpty()) {
            shareLabel_->clear();
        } else {
            const QString escapedLink = shareLink.toHtmlEscaped();
            shareLabel_->setText(QString("<a href=\"%1\" style=\"color: %2; text-decoration: underline;\">%1</a>")
                                     .arg(escapedLink, COLOR_ACCENT));
        }
        shareLabel_->setTextFormat(Qt::RichText);
        shareLabel_->setTextInteractionFlags(Qt::TextBrowserInteraction);
        shareLabel_->setOpenExternalLinks(true);
        if (copyShareLinkButton_) {
            copyShareLinkButton_->setEnabled(!shareLink.isEmpty());
        }
        if (openShareLinkButton_) {
            openShareLinkButton_->setEnabled(!shareLink.isEmpty());
        }
        if (copyShareLinkAction_) {
            copyShareLinkAction_->setEnabled(!shareLink.isEmpty());
        }
        if (copyShareLinkTrayAction_) {
            copyShareLinkTrayAction_->setEnabled(!shareLink.isEmpty());
        }
        if (openShareLinkAction_) {
            openShareLinkAction_->setEnabled(!shareLink.isEmpty());
        }
        if (openShareLinkTrayAction_) {
            openShareLinkTrayAction_->setEnabled(!shareLink.isEmpty());
        }

        statsPanel_->setVisible(true);

        if (trayIcon_) {
            updateTrayLiveIndicator(true);
        }

        const QString activeEncoder = QString::fromStdString(core_->getVideoEncoderName());
        const bool hardwareEncoder = core_->isHardwareVideoEncoder();
        const QString activeText = activeEncoder.isEmpty() ? "Unknown" : activeEncoder;
        encoderStatusLabel_->setText(QString("Active Encoder: %1 (%2)")
            .arg(activeText, hardwareEncoder ? "hardware" : "software"));

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

        if (fallbackActive) {
            encoderStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px; font-weight: bold;").arg(COLOR_YELLOW));
            updateStatus("LIVE (fallback encoder)", "live");
        } else {
            encoderStatusLabel_->setStyleSheet(QString("color: %1; font-size: 11px;").arg(COLOR_TEXT_DIM));
        }

        windowListWidget_->setAutoRefreshEnabled(false);
    }

    updateGoLiveButton();
}

void MainWindow::updateGoLiveButton() {
    if (isLive_) {
        goLiveButton_->setText("STOP");
        goLiveButton_->setStyleSheet(QString(
            "QPushButton { background-color: %1; color: white; font-size: 14px; font-weight: bold; }"
            "QPushButton:hover { background-color: #ff4444; }"
        ).arg(COLOR_RED));
        if (goLiveAction_) {
            goLiveAction_->setText("Stop");
        }
        if (goLiveMenuAction_) {
            goLiveMenuAction_->setText("Stop");
        }
    } else {
        goLiveButton_->setText("GO LIVE");
        goLiveButton_->setStyleSheet(QString(
            "QPushButton { background-color: %1; color: white; font-size: 14px; font-weight: bold; }"
            "QPushButton:hover { background-color: %2; }"
        ).arg(COLOR_ACCENT, COLOR_ACCENT_HOVER));
        if (goLiveAction_) {
            goLiveAction_->setText("Go Live");
        }
        if (goLiveMenuAction_) {
            goLiveMenuAction_->setText("Go Live");
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
        stats.videoBitrate = selectedBitrateKbps();
        stats.audioBitrate = 192;
        stats.frameRate = fpsSelect_->currentData().toInt();

        const QString resolutionText = resolutionSelect_->currentData().toString();
        const QStringList parts = resolutionText.split('x');
        stats.width = parts.size() > 0 ? parts[0].toInt() : 1920;
        stats.height = parts.size() > 1 ? parts[1].toInt() : 1080;

        std::string activeCodec = core_->getVideoCodecName();
        if (activeCodec.empty()) {
            activeCodec = "H.264";
        }
        stats.codec = activeCodec;
        std::string encoderName = core_->getVideoEncoderName();
        if (encoderName.empty()) {
            stats.encoder = core_->isHardwareVideoEncoder() ? "Hardware" : "Software";
        } else {
            stats.encoder = encoderName;
        }
        stats.rtt = 0;

        updateStats(stats);

        const float rms = core_->getAudioLevelRms();
        const float peak = core_->getAudioPeak();
        double db = (rms > 1.0e-6f) ? (20.0 * std::log10(static_cast<double>(rms))) : -90.0;
        db = std::clamp(db, -90.0, 0.0);
        int meterPct = static_cast<int>(std::round(((db + 60.0) / 60.0) * 100.0));
        meterPct = std::clamp(meterPct, 0, 100);
        meterPct = std::max(meterPct, static_cast<int>(std::round(peak * 100.0f)));
        audioMeter_->setValue(meterPct);

        if (db <= -89.0) {
            audioLevelLabel_->setText("-inf dB");
        } else {
            audioLevelLabel_->setText(QString("%1 dB").arg(db, 0, 'f', 1));
        }

        QString meterColor = COLOR_ACCENT;
        if (meterPct >= 85) {
            meterColor = COLOR_RED;
        } else if (meterPct >= 65) {
            meterColor = COLOR_YELLOW;
        }
        audioMeter_->setStyleSheet(QString(
            "QProgressBar { border: 1px solid #2f2f47; border-radius: 4px; background: #0d0d16; }"
            "QProgressBar::chunk { background-color: %1; border-radius: 3px; }").arg(meterColor));
    } else {
        audioMeter_->setValue(0);
        audioLevelLabel_->setText("-inf dB");
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
    QTimer::singleShot(0, this, [this, checked]() {
        if (!isVisible()) {
            return;
        }

        const int currentWidth = width();
        const int targetHeight = std::max(minimumSizeHint().height(), sizeHint().height());
        if (checked) {
            resize(currentWidth, std::max(height(), targetHeight));
        } else {
            resize(currentWidth, targetHeight);
        }
    });
}

void MainWindow::syncCodecUiState() {
    if (!encoderSelect_ || !codecSelect_) {
        return;
    }

    const versus::video::VideoCodec selectedCodec = codecFromUiValue(codecSelect_->currentData().toString());
    const bool requiresFfmpeg = codecRequiresFfmpegPath(selectedCodec);
    if (requiresFfmpeg && encoderSelect_->currentData().toString() != "ffmpeg_nvenc") {
        const int ffmpegIndex = encoderSelect_->findData("ffmpeg_nvenc");
        if (ffmpegIndex >= 0) {
            QSignalBlocker blocker(encoderSelect_);
            encoderSelect_->setCurrentIndex(ffmpegIndex);
        }
    }

    const QString mode = encoderSelect_->currentData().toString();
    const bool enableFfmpegFields = mode == "ffmpeg_nvenc" || requiresFfmpeg;
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
    }

    if (codecSelect_) {
        if (selectedCodec == versus::video::VideoCodec::H265) {
            codecSelect_->setToolTip("H.265 is experimental and may not decode in Chromium-based viewers.");
        } else if (selectedCodec == versus::video::VideoCodec::VP9) {
            codecSelect_->setToolTip("VP9 RTP transport is preview-only in this build.");
        } else {
            codecSelect_->setToolTip(QString());
        }
    }
}

int MainWindow::selectedBitrateKbps() const {
    const int presetValue = bitrateSelect_->currentData().toInt();
    if (presetValue > 0) {
        return presetValue;
    }
    return customBitrateSpin_->value();
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

    if (selectedWindowId_.isEmpty()) {
        previewLabel_->setPixmap(QPixmap());
        previewLabel_->setText("Select a window to see live preview");
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
    previewLabel_->setPixmap(preview.scaled(
        previewLabel_->size(),
        Qt::KeepAspectRatio,
        Qt::SmoothTransformation));
}

void MainWindow::closeEvent(QCloseEvent *event) {
    if (!quitRequested_ && trayIcon_ && minimizeToTrayOnClose_) {
        event->ignore();
        hide();
        if (showHideAction_) {
            showHideAction_->setText("Show");
        }
        if (trayIcon_->supportsMessages()) {
            trayIcon_->showMessage(
                APP_BRAND,
                "Still running in system tray",
                QSystemTrayIcon::Information,
                3000);
        }
        return;
    }

    QMainWindow::closeEvent(event);
}

}  // namespace versus::ui

