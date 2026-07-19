#include <QtTest/QtTest>
#include <QApplication>
#include <QPushButton>
#include <QLabel>
#include <QLineEdit>
#include <QComboBox>
#include <QSpinBox>
#include <QCheckBox>
#include <QDir>
#include <QProgressBar>
#include <QSettings>
#include <QSystemTrayIcon>
#include <QWheelEvent>

#include "versus/ui/main_window.h"
#include "versus/ui/window_list_widget.h"
#include "versus/ui/stats_panel.h"

class TestMainWindow : public QObject {
    Q_OBJECT

private slots:
    void initTestCase();
    void cleanupTestCase();
    void init();
    void cleanup();

    void testInitialState();
    void testDarkThemeApplied();
    void testGoLiveButtonDisabledInitially();
    void testGoLiveButtonEnabledAfterSelection();
    void testStatusLabelUpdates();
    void testSystemTrayExists();
    void testStatsPanelHiddenInitially();
    void testInputFieldsExist();
    void testPasswordInputDefaults();
    void testClosedComboBoxesIgnoreWheel();
    void testParseStreamTargetInput();
    void testAdvancedPanelAndViewerLimit();
    void testAdvancedPanelResizesWindowWhenClosed();
    void testRemoteControlControls();
    void testResolutionOptions();
    void testVideoSourceModeControl();
    void testPersistedSpoutModeUsesNoAudio();
    void testSpoutSelectionPreviewMessaging();
    void testIceModeOptions();
    void testAudioSourceOptions();
    void testAudioMixControls();
    void testRoomModeQualityToggle();
    void testBitrateOptions();
    void testCustomBitrateControl();
    void testAudioMeterExists();
    void testAudioSourceMetersExist();
    void testConnectionHealthPanelExists();
    void testEncoderStatusLabelExists();
    void testShareLinkButtonsExist();
    void testFfmpegAdvancedControls();
    void testCodecControls();
    void testAlphaBackgroundControls();
    void testFfmpegAlphaStatusMessaging();
    void testAlphaWorkflowMessaging();

private:
    versus::ui::MainWindow *window_ = nullptr;
};

void TestMainWindow::initTestCase() {
    QSettings::setDefaultFormat(QSettings::IniFormat);
    const QString settingsRoot = QDir::temp().filePath("game-capture-test-settings");
    QDir(settingsRoot).removeRecursively();
    QDir().mkpath(settingsRoot);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsRoot);
}

void TestMainWindow::cleanupTestCase() {
    // Called once after all tests
}

void TestMainWindow::init() {
    QSettings settings("VDO.Ninja", "Game Capture");
    settings.clear();
    settings.sync();

    // Pass nullptr for core since we're just testing UI
    window_ = new versus::ui::MainWindow(nullptr);
}

void TestMainWindow::cleanup() {
    delete window_;
    window_ = nullptr;
}

void TestMainWindow::testInitialState() {
    QVERIFY(window_ != nullptr);
    QCOMPARE(window_->windowTitle(), QString("Game Capture - Powered by VDO.Ninja"));
    QVERIFY(window_->width() >= 900);
    QVERIFY(window_->height() <= 760);
}

void TestMainWindow::testDarkThemeApplied() {
    // Check that the application has a stylesheet applied
    QString stylesheet = qApp->styleSheet();
    QVERIFY(!stylesheet.isEmpty());

    // Check for dark theme colors
    QVERIFY(stylesheet.contains("#0b1016"));  // Background color
    QVERIFY(stylesheet.contains("#00c2ff"));  // Accent color
}

void TestMainWindow::testGoLiveButtonDisabledInitially() {
    auto buttons = window_->findChildren<QPushButton*>();
    QPushButton *goLiveButton = nullptr;

    for (auto *button : buttons) {
        if (button->text() == "GO LIVE") {
            goLiveButton = button;
            break;
        }
    }

    QVERIFY(goLiveButton != nullptr);
    QVERIFY(!goLiveButton->isEnabled());  // Should be disabled initially
}

void TestMainWindow::testGoLiveButtonEnabledAfterSelection() {
    // Find the WindowListWidget
    auto *windowList = window_->findChild<versus::ui::WindowListWidget*>();
    QVERIFY(windowList != nullptr);

    // Create a fake window list
    std::vector<versus::video::WindowInfo> windows;
    versus::video::WindowInfo win;
    win.id = "test_hwnd";
    win.name = "Test Window";
    win.executableName = "test.exe";
    windows.push_back(win);

    windowList->setWindowList(windows);

    // Simulate window selection
    auto *listWidget = windowList->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);
    emit listWidget->itemClicked(listWidget->item(0));

    // Find GO LIVE button and check if enabled
    auto buttons = window_->findChildren<QPushButton*>();
    QPushButton *goLiveButton = nullptr;

    for (auto *button : buttons) {
        if (button->text() == "GO LIVE") {
            goLiveButton = button;
            break;
        }
    }

    QVERIFY(goLiveButton != nullptr);
    QVERIFY(goLiveButton->isEnabled());  // Should be enabled after selection
}

void TestMainWindow::testStatusLabelUpdates() {
    auto labels = window_->findChildren<QLabel*>();
    QLabel *statusLabel = nullptr;

    for (auto *label : labels) {
        if (label->text() == "Select a window to capture") {
            statusLabel = label;
            break;
        }
    }

    QVERIFY(statusLabel != nullptr);
}

void TestMainWindow::testSystemTrayExists() {
    // System tray might not be available in test environment
    if (!QSystemTrayIcon::isSystemTrayAvailable()) {
        QSKIP("System tray not available");
    }

    auto *trayIcon = window_->findChild<QSystemTrayIcon*>();
    QVERIFY(trayIcon != nullptr);
    QVERIFY(trayIcon->isVisible());
    QCOMPARE(trayIcon->toolTip(), QString("Game Capture - Idle"));
}

void TestMainWindow::testStatsPanelHiddenInitially() {
    auto *statsPanel = window_->findChild<versus::ui::StatsPanel*>();
    QVERIFY(statsPanel != nullptr);
    QVERIFY(!statsPanel->isVisible());
}

void TestMainWindow::testInputFieldsExist() {
    auto lineEdits = window_->findChildren<QLineEdit*>();

    // Should have room, password, and label inputs
    QVERIFY(lineEdits.size() >= 3);

    bool hasRoomPlaceholder = false;
    bool hasPasswordPlaceholder = false;
    bool hasLabelPlaceholder = false;

    for (auto *lineEdit : lineEdits) {
        QString placeholder = lineEdit->placeholderText();
        if (placeholder.contains("Room")) hasRoomPlaceholder = true;
        if (placeholder.contains("Password")) hasPasswordPlaceholder = true;
        if (placeholder.contains("label", Qt::CaseInsensitive)) hasLabelPlaceholder = true;
    }

    QVERIFY2(hasRoomPlaceholder, "Room input not found");
    QVERIFY2(hasPasswordPlaceholder, "Password input not found");
    QVERIFY2(hasLabelPlaceholder, "Label input not found");
}

void TestMainWindow::testResolutionOptions() {
    auto comboBoxes = window_->findChildren<QComboBox*>();

    QComboBox *resolutionCombo = nullptr;
    for (auto *combo : comboBoxes) {
        for (int i = 0; i < combo->count(); i++) {
            if (combo->itemText(i).contains("1920x1080")) {
                resolutionCombo = combo;
                break;
            }
        }
        if (resolutionCombo) break;
    }

    QVERIFY(resolutionCombo != nullptr);
    QVERIFY(resolutionCombo->count() >= 3);  // Should have at least 3 options

    // Check for expected resolutions
    QStringList expectedResolutions = {"1920x1080", "1280x720", "960x540"};
    for (const QString &res : expectedResolutions) {
        bool found = false;
        for (int i = 0; i < resolutionCombo->count(); i++) {
            if (resolutionCombo->itemText(i).contains(res)) {
                found = true;
                break;
            }
        }
        QVERIFY2(found, qPrintable(QString("Resolution %1 not found").arg(res)));
    }
}

void TestMainWindow::testBitrateOptions() {
    auto comboBoxes = window_->findChildren<QComboBox*>();

    QComboBox *bitrateCombo = nullptr;
    for (auto *combo : comboBoxes) {
        for (int i = 0; i < combo->count(); i++) {
            if (combo->itemText(i).contains("kbps")) {
                bitrateCombo = combo;
                break;
            }
        }
        if (bitrateCombo) break;
    }

    QVERIFY(bitrateCombo != nullptr);
    QVERIFY(bitrateCombo->count() >= 4);  // Should have at least 4 options

    // Check for expected bitrate values
    QStringList expectedBitrates = {"20000", "12000", "6000", "3000"};
    for (const QString &bitrate : expectedBitrates) {
        bool found = false;
        for (int i = 0; i < bitrateCombo->count(); i++) {
            if (bitrateCombo->itemText(i).contains(bitrate)) {
                found = true;
                break;
            }
        }
        QVERIFY2(found, qPrintable(QString("Bitrate %1 not found").arg(bitrate)));
    }

    // Check that High (12000) is selected by default
    QVERIFY(bitrateCombo->currentText().contains("12000"));
}

void TestMainWindow::testVideoSourceModeControl() {
    auto *sourceCombo = window_->findChild<QComboBox*>("sourceModeSelect");
    auto *audioCombo = window_->findChild<QComboBox*>("audioSourceSelect");
    QVERIFY(sourceCombo != nullptr);
    QVERIFY(audioCombo != nullptr);
    QVERIFY(sourceCombo->findData("window") >= 0);
    QVERIFY(sourceCombo->findData("spout") >= 0);
    QCOMPARE(sourceCombo->currentData().toString(), QString("window"));

    const int selectedWindowAudioIndex = audioCombo->findData("selected-window");
    QVERIFY(selectedWindowAudioIndex >= 0);
    audioCombo->setCurrentIndex(selectedWindowAudioIndex);
    QCOMPARE(audioCombo->currentData().toString(), QString("selected-window"));

    const int spoutIndex = sourceCombo->findData("spout");
    QVERIFY(spoutIndex >= 0);
    QVERIFY(sourceCombo->itemText(spoutIndex).contains("avatar", Qt::CaseInsensitive));
    QVERIFY(sourceCombo->toolTip().contains("VTube Studio"));
    QVERIFY(sourceCombo->toolTip().contains("Warudo"));
    QVERIFY(sourceCombo->toolTip().contains("same GPU", Qt::CaseInsensitive));
    sourceCombo->setCurrentIndex(spoutIndex);
    QCOMPARE(sourceCombo->currentData().toString(), QString("spout"));
    QCOMPARE(audioCombo->currentData().toString(), QString("none"));
}

void TestMainWindow::testPersistedSpoutModeUsesNoAudio() {
    delete window_;
    window_ = nullptr;

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.setValue("video/sourceMode", "spout");
    settings.setValue("audio/source", "selected-window");
    settings.sync();

    window_ = new versus::ui::MainWindow(nullptr);

    auto *sourceCombo = window_->findChild<QComboBox*>("sourceModeSelect");
    auto *audioCombo = window_->findChild<QComboBox*>("audioSourceSelect");
    QVERIFY(sourceCombo != nullptr);
    QVERIFY(audioCombo != nullptr);
    QCOMPARE(sourceCombo->currentData().toString(), QString("spout"));
    QCOMPARE(audioCombo->currentData().toString(), QString("none"));
}

void TestMainWindow::testSpoutSelectionPreviewMessaging() {
    auto *sourceCombo = window_->findChild<QComboBox*>("sourceModeSelect");
    auto *windowList = window_->findChild<versus::ui::WindowListWidget*>();
    auto *preview = window_->findChild<QLabel*>("selectedPreview");
    QVERIFY(sourceCombo != nullptr);
    QVERIFY(windowList != nullptr);
    QVERIFY(preview != nullptr);

    const int spoutIndex = sourceCombo->findData("spout");
    QVERIFY(spoutIndex >= 0);
    sourceCombo->setCurrentIndex(spoutIndex);

    std::vector<versus::video::WindowInfo> senders;
    versus::video::WindowInfo sender;
    sender.id = "VTubeStudioSpout";
    sender.name = "VTubeStudioSpout";
    sender.executableName = "Spout2 sender";
    sender.width = 1920;
    sender.height = 1080;
    senders.push_back(sender);
    windowList->setWindowList(senders);

    auto *listWidget = windowList->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);
    QCOMPARE(listWidget->count(), 1);
    emit listWidget->itemClicked(listWidget->item(0));

    QVERIFY(preview->text().contains("Spout2 sender selected"));
    QVERIFY(preview->text().contains("VTubeStudioSpout"));
    QVERIFY(preview->text().contains("For transparency: VP9 alpha or chroma background"));
    QVERIFY(preview->text().contains("Video only"));
    QVERIFY(preview->text().contains("selected stream resolution"));
}

void TestMainWindow::testIceModeOptions() {
    auto *iceModeCombo = window_->findChild<QComboBox*>("iceModeSelect");
    QVERIFY(iceModeCombo != nullptr);
    QCOMPARE(iceModeCombo->count(), 4);
    QCOMPARE(iceModeCombo->currentData().toString(), QString("stun-only"));
    QVERIFY(iceModeCombo->findData("all") >= 0);
    QVERIFY(iceModeCombo->findData("relay") >= 0);
}

void TestMainWindow::testAudioSourceOptions() {
    auto *audioSourceCombo = window_->findChild<QComboBox*>("audioSourceSelect");
    QVERIFY(audioSourceCombo != nullptr);
    QCOMPARE(audioSourceCombo->currentData().toString(), QString("selected-window"));
    QVERIFY(audioSourceCombo->findData("communications-output") >= 0);
    QVERIFY(audioSourceCombo->findData("default-microphone") >= 0);

    auto *includeMicCheck = window_->findChild<QCheckBox*>("includeMicrophoneCheck");
    QVERIFY(includeMicCheck != nullptr);
    QVERIFY(!includeMicCheck->isChecked());
    auto *microphoneCombo = window_->findChild<QComboBox*>("microphoneDeviceSelect");
    QVERIFY(microphoneCombo != nullptr);
    QVERIFY(microphoneCombo->count() >= 1);
    QCOMPARE(microphoneCombo->itemData(0).toString(), QString());
}

void TestMainWindow::testAudioMixControls() {
    auto *primaryGain = window_->findChild<QSpinBox*>("primaryAudioGainSpin");
    auto *micGain = window_->findChild<QSpinBox*>("microphoneAudioGainSpin");
    auto *limiter = window_->findChild<QCheckBox*>("audioLimiterCheck");

    QVERIFY(primaryGain != nullptr);
    QVERIFY(micGain != nullptr);
    QVERIFY(limiter != nullptr);
    QCOMPARE(primaryGain->minimum(), 0);
    QCOMPARE(primaryGain->maximum(), 200);
    QCOMPARE(primaryGain->value(), 100);
    QCOMPARE(micGain->minimum(), 0);
    QCOMPARE(micGain->maximum(), 200);
    QCOMPARE(micGain->value(), 100);
    QVERIFY(limiter->isChecked());
}

void TestMainWindow::testRoomModeQualityToggle() {
    auto *roomModeLqCheck = window_->findChild<QCheckBox*>("roomModeLqCheck");
    QVERIFY(roomModeLqCheck != nullptr);
    QVERIFY(roomModeLqCheck->isChecked());
    QVERIFY(roomModeLqCheck->text().contains("640x360"));
}

void TestMainWindow::testPasswordInputDefaults() {
    auto *passwordInput = window_->findChild<QLineEdit*>("passwordInput");
    QVERIFY(passwordInput != nullptr);
    QVERIFY(passwordInput->text().isEmpty());
    QVERIFY(passwordInput->placeholderText().contains("leave blank", Qt::CaseInsensitive));
    QVERIFY(passwordInput->placeholderText().contains("false", Qt::CaseInsensitive));
    QCOMPARE(passwordInput->echoMode(), QLineEdit::Password);

    auto *passwordReveal = window_->findChild<QPushButton*>("passwordRevealButton");
    QVERIFY(passwordReveal != nullptr);
    QVERIFY(passwordReveal->isEnabled());
    QCOMPARE(passwordReveal->text(), QString("Show"));

    passwordReveal->setChecked(true);
    QCOMPARE(passwordInput->echoMode(), QLineEdit::Normal);
    QCOMPARE(passwordReveal->text(), QString("Hide"));

    passwordReveal->setChecked(false);
    QCOMPARE(passwordInput->echoMode(), QLineEdit::Password);
    QCOMPARE(passwordReveal->text(), QString("Show"));

    auto *tokenInput = window_->findChild<QLineEdit*>("remoteControlTokenInput");
    auto *tokenReveal = window_->findChild<QPushButton*>("remoteControlTokenRevealButton");
    QVERIFY(tokenInput != nullptr);
    QVERIFY(tokenReveal != nullptr);
    QCOMPARE(tokenInput->echoMode(), QLineEdit::Password);
    QVERIFY(!tokenReveal->isEnabled());
}

void TestMainWindow::testClosedComboBoxesIgnoreWheel() {
    auto *iceModeCombo = window_->findChild<QComboBox*>("iceModeSelect");
    QVERIFY(iceModeCombo != nullptr);
    QVERIFY(iceModeCombo->count() > 1);

    iceModeCombo->setCurrentIndex(1);
    const int expectedIndex = iceModeCombo->currentIndex();
    const QPoint localCenter = iceModeCombo->rect().center();
    QWheelEvent wheelEvent(
        QPointF(localCenter),
        QPointF(iceModeCombo->mapToGlobal(localCenter)),
        QPoint(),
        QPoint(0, 120),
        Qt::NoButton,
        Qt::NoModifier,
        Qt::NoScrollPhase,
        false);

    QCoreApplication::sendEvent(iceModeCombo, &wheelEvent);
    QCOMPARE(iceModeCombo->currentIndex(), expectedIndex);
}

void TestMainWindow::testParseStreamTargetInput() {
    {
        const auto parsed = versus::ui::MainWindow::parseStreamTargetInput("my_stream_123");
        QVERIFY(parsed.valid);
        QCOMPARE(parsed.streamId, QString("my_stream_123"));
        QVERIFY(parsed.room.isEmpty());
        QVERIFY(parsed.password.isEmpty());
        QVERIFY(!parsed.isUrl);
    }

    {
        const auto parsed = versus::ui::MainWindow::parseStreamTargetInput(
            "https://vdo.ninja/?push=abc123&room=room9&password=secret");
        QVERIFY(parsed.valid);
        QCOMPARE(parsed.streamId, QString("abc123"));
        QCOMPARE(parsed.room, QString("room9"));
        QCOMPARE(parsed.password, QString("secret"));
        QVERIFY(parsed.isUrl);
    }

    {
        const auto parsed = versus::ui::MainWindow::parseStreamTargetInput("https://vdo.ninja/?view=xyz456");
        QVERIFY(parsed.valid);
        QCOMPARE(parsed.streamId, QString("xyz456"));
        QVERIFY(parsed.isUrl);
    }

    {
        const auto parsed = versus::ui::MainWindow::parseStreamTargetInput("https://vdo.ninja/?room=no-stream");
        QVERIFY(!parsed.valid);
    }
}

void TestMainWindow::testAdvancedPanelAndViewerLimit() {
    auto *viewerLimit = window_->findChild<QSpinBox*>("viewerLimitSpin");
    QVERIFY(viewerLimit != nullptr);
    QCOMPARE(viewerLimit->value(), 10);

    auto toggles = window_->findChildren<QCheckBox*>();
    QCheckBox *advancedToggle = nullptr;
    for (auto *toggle : toggles) {
        if (toggle->text().contains("advanced", Qt::CaseInsensitive)) {
            advancedToggle = toggle;
            break;
        }
    }
    QVERIFY(advancedToggle != nullptr);
    QVERIFY(!advancedToggle->isChecked());

    advancedToggle->setChecked(true);
    QVERIFY(advancedToggle->isChecked());
}

void TestMainWindow::testAdvancedPanelResizesWindowWhenClosed() {
    auto toggles = window_->findChildren<QCheckBox*>();
    QCheckBox *advancedToggle = nullptr;
    for (auto *toggle : toggles) {
        if (toggle->text().contains("advanced", Qt::CaseInsensitive)) {
            advancedToggle = toggle;
            break;
        }
    }
    QVERIFY(advancedToggle != nullptr);

    auto *viewerLimit = window_->findChild<QSpinBox*>("viewerLimitSpin");
    QVERIFY(viewerLimit != nullptr);

    window_->show();
    QTRY_VERIFY_WITH_TIMEOUT(window_->isVisible(), 1000);
    QCoreApplication::processEvents();

    // Advanced controls are hidden by default.
    QVERIFY(!advancedToggle->isChecked());
    QVERIFY(!viewerLimit->isVisible());

    // Toggling advanced settings should show/hide advanced controls.
    advancedToggle->setChecked(true);
    QTRY_VERIFY_WITH_TIMEOUT(advancedToggle->isChecked(), 1000);
    QTRY_VERIFY_WITH_TIMEOUT(viewerLimit->isVisible(), 1000);

    advancedToggle->setChecked(false);
    QTRY_VERIFY_WITH_TIMEOUT(!advancedToggle->isChecked(), 1000);
    QTRY_VERIFY_WITH_TIMEOUT(!viewerLimit->isVisible(), 1000);
}

void TestMainWindow::testRemoteControlControls() {
    auto *remoteCheck = window_->findChild<QCheckBox*>("remoteControlCheck");
    QVERIFY(remoteCheck != nullptr);
    QVERIFY(!remoteCheck->isChecked());

    auto *tokenInput = window_->findChild<QLineEdit*>("remoteControlTokenInput");
    QVERIFY(tokenInput != nullptr);
    QVERIFY(!tokenInput->isEnabled());

    auto *tokenReveal = window_->findChild<QPushButton*>("remoteControlTokenRevealButton");
    QVERIFY(tokenReveal != nullptr);
    QVERIFY(!tokenReveal->isEnabled());

    remoteCheck->setChecked(true);
    QVERIFY(tokenInput->isEnabled());
    QVERIFY(tokenReveal->isEnabled());

    tokenReveal->setChecked(true);
    QCOMPARE(tokenInput->echoMode(), QLineEdit::Normal);
}

void TestMainWindow::testCustomBitrateControl() {
    auto comboBoxes = window_->findChildren<QComboBox*>();
    QComboBox *bitrateCombo = nullptr;
    for (auto *combo : comboBoxes) {
        if (combo->findText("Custom", Qt::MatchContains) >= 0) {
            bitrateCombo = combo;
            break;
        }
    }
    QVERIFY(bitrateCombo != nullptr);

    auto spinBoxes = window_->findChildren<QSpinBox*>();
    QSpinBox *customBitrate = nullptr;
    for (auto *spin : spinBoxes) {
        if (spin->suffix().contains("kbps", Qt::CaseInsensitive)) {
            customBitrate = spin;
            break;
        }
    }
    QVERIFY(customBitrate != nullptr);

    // Custom bitrate control should be disabled for default preset.
    QVERIFY(!customBitrate->isEnabled());

    const int customIndex = bitrateCombo->findText("Custom", Qt::MatchContains);
    QVERIFY(customIndex >= 0);
    bitrateCombo->setCurrentIndex(customIndex);

    QVERIFY(customBitrate->isEnabled());
    QVERIFY(customBitrate->value() >= 500);
}

void TestMainWindow::testAudioMeterExists() {
    auto *meter = window_->findChild<QProgressBar*>("audioMeter");
    QVERIFY(meter != nullptr);
    QCOMPARE(meter->minimum(), 0);
    QCOMPARE(meter->maximum(), 100);
}

void TestMainWindow::testAudioSourceMetersExist() {
    auto *primarySource = window_->findChild<QLabel*>("primaryAudioSourceLabel");
    auto *primaryMeter = window_->findChild<QProgressBar*>("primaryAudioMeter");
    auto *primaryLevel = window_->findChild<QLabel*>("primaryAudioLevelLabel");
    auto *micSource = window_->findChild<QLabel*>("microphoneAudioSourceLabel");
    auto *micMeter = window_->findChild<QProgressBar*>("microphoneAudioMeter");
    auto *micLevel = window_->findChild<QLabel*>("microphoneAudioLevelLabel");

    QVERIFY(primarySource != nullptr);
    QVERIFY(primaryMeter != nullptr);
    QVERIFY(primaryLevel != nullptr);
    QVERIFY(micSource != nullptr);
    QVERIFY(micMeter != nullptr);
    QVERIFY(micLevel != nullptr);
    QCOMPARE(primaryMeter->minimum(), 0);
    QCOMPARE(primaryMeter->maximum(), 100);
    QCOMPARE(micMeter->minimum(), 0);
    QCOMPARE(micMeter->maximum(), 100);
    QVERIFY(primarySource->text().contains("Primary"));
    QVERIFY(micSource->text().contains("Mic/input"));
}

void TestMainWindow::testConnectionHealthPanelExists() {
    auto *healthLabel = window_->findChild<QLabel*>("connectionHealthLabel");
    auto *mediaLabel = window_->findChild<QLabel*>("connectionMediaLabel");
    auto *systemLabel = window_->findChild<QLabel*>("systemResourceLabel");
    auto *issueLabel = window_->findChild<QLabel*>("connectionIssueLabel");

    QVERIFY(healthLabel != nullptr);
    QVERIFY(mediaLabel != nullptr);
    QVERIFY(systemLabel != nullptr);
    QVERIFY(issueLabel != nullptr);
    QVERIFY(healthLabel->text().contains("ICE"));
    QVERIFY(healthLabel->text().contains("Candidates"));
    QVERIFY(mediaLabel->text().contains("Codec"));
    QVERIFY(systemLabel->text().contains("System"));
    QVERIFY(systemLabel->text().contains("CPU"));
    QVERIFY(systemLabel->text().contains("RAM"));
    QVERIFY(issueLabel->text().contains("Drops/encode/video/audio send"));
}

void TestMainWindow::testEncoderStatusLabelExists() {
    auto *label = window_->findChild<QLabel*>("encoderStatusLabel");
    QVERIFY(label != nullptr);
    QVERIFY(label->text().contains("Active Encoder"));
}

void TestMainWindow::testShareLinkButtonsExist() {
    auto *copyButton = window_->findChild<QPushButton*>("shareCopyButton");
    auto *openButton = window_->findChild<QPushButton*>("shareOpenButton");
    QVERIFY(copyButton != nullptr);
    QVERIFY(openButton != nullptr);
    QVERIFY(!copyButton->isEnabled());
    QVERIFY(!openButton->isEnabled());
}

void TestMainWindow::testFfmpegAdvancedControls() {
    auto *pathInput = window_->findChild<QLineEdit*>("ffmpegPathInput");
    auto *optionsInput = window_->findChild<QLineEdit*>("ffmpegOptionsInput");
    QVERIFY(pathInput != nullptr);
    QVERIFY(optionsInput != nullptr);
    QVERIFY(!pathInput->isEnabled());
    QVERIFY(!optionsInput->isEnabled());

    auto combos = window_->findChildren<QComboBox*>();
    QComboBox *encoderCombo = nullptr;
    int ffmpegIndex = -1;
    for (auto *combo : combos) {
        for (int i = 0; i < combo->count(); ++i) {
            if (combo->itemData(i).toString() == "ffmpeg_nvenc") {
                encoderCombo = combo;
                ffmpegIndex = i;
                break;
            }
        }
        if (encoderCombo) {
            break;
        }
    }

    QVERIFY(encoderCombo != nullptr);
    QVERIFY(ffmpegIndex >= 0);
    encoderCombo->setCurrentIndex(ffmpegIndex);
    QVERIFY(pathInput->isEnabled());
    QVERIFY(optionsInput->isEnabled());
}

void TestMainWindow::testCodecControls() {
    auto *codecCombo = window_->findChild<QComboBox*>("codecSelect");
    auto *encoderCombo = window_->findChild<QComboBox*>("encoderSelect");
    auto *ffmpegPathInput = window_->findChild<QLineEdit*>("ffmpegPathInput");
    QVERIFY(codecCombo != nullptr);
    QVERIFY(encoderCombo != nullptr);
    QVERIFY(ffmpegPathInput != nullptr);
    QVERIFY(codecCombo->count() >= 4);
    QCOMPARE(codecCombo->currentData().toString(), QString("h264"));

    auto *alphaCheck = window_->findChild<QCheckBox*>("alphaWorkflowCheck");
    QVERIFY(alphaCheck != nullptr);
    QVERIFY(alphaCheck->isEnabled());
    QVERIFY(alphaCheck->text().contains("H.264"));

    const int qsvIndex = encoderCombo->findData("qsv");
    QVERIFY(qsvIndex >= 0);
    encoderCombo->setCurrentIndex(qsvIndex);

    const int av1Index = codecCombo->findData("av1");
    QVERIFY(av1Index >= 0);
    codecCombo->setCurrentIndex(av1Index);
    QCOMPARE(encoderCombo->currentData().toString(), QString("qsv"));
    QVERIFY(ffmpegPathInput->isEnabled());
    QVERIFY(alphaCheck->isEnabled());
}

void TestMainWindow::testAlphaBackgroundControls() {
    auto *codecCombo = window_->findChild<QComboBox*>("codecSelect");
    auto *alphaCheck = window_->findChild<QCheckBox*>("alphaWorkflowCheck");
    auto *modeCombo = window_->findChild<QComboBox*>("alphaBackgroundModeSelect");
    auto *colorButton = window_->findChild<QPushButton*>("alphaBackgroundColorButton");
    QVERIFY(codecCombo != nullptr);
    QVERIFY(alphaCheck != nullptr);
    QVERIFY(modeCombo != nullptr);
    QVERIFY(colorButton != nullptr);

    QVERIFY(modeCombo->findData("none") >= 0);
    QVERIFY(modeCombo->findData("chroma") >= 0);
    QVERIFY(modeCombo->findData("opaque") >= 0);
    QCOMPARE(modeCombo->currentData().toString(), QString("none"));
    QVERIFY(!colorButton->isEnabled());

    const int chromaIndex = modeCombo->findData("chroma");
    QVERIFY(chromaIndex >= 0);
    modeCombo->setCurrentIndex(chromaIndex);
    QVERIFY(colorButton->isEnabled());
    QVERIFY(colorButton->text().contains("#00FF00"));

    const int vp9Index = codecCombo->findData("vp9");
    QVERIFY(vp9Index >= 0);
    codecCombo->setCurrentIndex(vp9Index);
    alphaCheck->setChecked(true);
    QVERIFY(!modeCombo->isEnabled());
}

void TestMainWindow::testFfmpegAlphaStatusMessaging() {
    auto *codecCombo = window_->findChild<QComboBox*>("codecSelect");
    auto *alphaCheck = window_->findChild<QCheckBox*>("alphaWorkflowCheck");
    auto *statusLabel = window_->findChild<QLabel*>("ffmpegStatusLabel");
    QVERIFY(codecCombo != nullptr);
    QVERIFY(alphaCheck != nullptr);
    QVERIFY(statusLabel != nullptr);

    const int vp9Index = codecCombo->findData("vp9");
    QVERIFY(vp9Index >= 0);
    codecCombo->setCurrentIndex(vp9Index);
    alphaCheck->setChecked(true);

    QVERIFY(statusLabel->text().contains("ffmpeg.exe", Qt::CaseInsensitive));
    QVERIFY(statusLabel->text().contains("VP9 alpha", Qt::CaseInsensitive) ||
            statusLabel->text().contains("alpha mask", Qt::CaseInsensitive));
    QVERIFY(statusLabel->text().contains("FFmpeg/libvpx", Qt::CaseInsensitive) ||
            statusLabel->text().contains("using", Qt::CaseInsensitive));

    const int h264Index = codecCombo->findData("h264");
    QVERIFY(h264Index >= 0);
    codecCombo->setCurrentIndex(h264Index);
    alphaCheck->setChecked(true);
    QCoreApplication::processEvents();

    QVERIFY(!statusLabel->text().contains("Only needed", Qt::CaseInsensitive));
    QVERIFY(statusLabel->text().contains("VP9 alpha", Qt::CaseInsensitive) ||
            statusLabel->text().contains("libvpx-vp9", Qt::CaseInsensitive) ||
            statusLabel->text().contains("alpha mask", Qt::CaseInsensitive));

    const int av1Index = codecCombo->findData("av1");
    QVERIFY(av1Index >= 0);
    codecCombo->setCurrentIndex(av1Index);
    alphaCheck->setChecked(true);
    QCoreApplication::processEvents();
    QVERIFY(!statusLabel->text().contains("libvpx-vp9", Qt::CaseInsensitive));
    QVERIFY(!statusLabel->text().contains("alpha mask", Qt::CaseInsensitive));
}

void TestMainWindow::testAlphaWorkflowMessaging() {
    auto *codecCombo = window_->findChild<QComboBox*>("codecSelect");
    auto *alphaCheck = window_->findChild<QCheckBox*>("alphaWorkflowCheck");
    QVERIFY(codecCombo != nullptr);
    QVERIFY(alphaCheck != nullptr);

    const int vp9Index = codecCombo->findData("vp9");
    QVERIFY(vp9Index >= 0);
    QVERIFY(codecCombo->itemText(vp9Index).contains("OBS Alpha"));

    codecCombo->setCurrentIndex(vp9Index);
    QVERIFY(alphaCheck->isEnabled());
    QVERIFY(alphaCheck->text().contains("OBS alpha"));
    QVERIFY(alphaCheck->toolTip().contains("VDO.Ninja OBS plugin"));
    QVERIFY(alphaCheck->toolTip().contains("Native Receiver"));
    QVERIFY(alphaCheck->toolTip().contains("Browser viewers", Qt::CaseInsensitive));
    QVERIFY(codecCombo->toolTip().contains("transparency", Qt::CaseInsensitive));

    const int h264Index = codecCombo->findData("h264");
    QVERIFY(h264Index >= 0);
    codecCombo->setCurrentIndex(h264Index);
    QVERIFY(alphaCheck->isEnabled());
    QVERIFY(alphaCheck->text().contains("H.264"));
    QVERIFY(alphaCheck->toolTip().contains("VP9 alpha mask"));

    const int av1Index = codecCombo->findData("av1");
    QVERIFY(av1Index >= 0);
    codecCombo->setCurrentIndex(av1Index);
    QVERIFY(alphaCheck->text().contains("alpha-preserving"));
    QVERIFY(alphaCheck->toolTip().contains("use VP9"));
}

QTEST_MAIN(TestMainWindow)
#include "test_main_window.moc"
