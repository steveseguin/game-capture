#include <QtTest/QtTest>
#include <QApplication>
#include <QPushButton>
#include <QLabel>
#include <QLineEdit>
#include <QComboBox>
#include <QSpinBox>
#include <QCheckBox>
#include <QProgressBar>
#include <QSystemTrayIcon>

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
    void testParseStreamTargetInput();
    void testAdvancedPanelAndViewerLimit();
    void testAdvancedPanelResizesWindowWhenClosed();
    void testRemoteControlControls();
    void testResolutionOptions();
    void testBitrateOptions();
    void testCustomBitrateControl();
    void testAudioMeterExists();
    void testEncoderStatusLabelExists();
    void testShareLinkButtonsExist();
    void testFfmpegAdvancedControls();
    void testCodecControls();

private:
    versus::ui::MainWindow *window_ = nullptr;
};

void TestMainWindow::initTestCase() {
    // Called once before all tests
}

void TestMainWindow::cleanupTestCase() {
    // Called once after all tests
}

void TestMainWindow::init() {
    // Pass nullptr for core since we're just testing UI
    window_ = new versus::ui::MainWindow(nullptr);
}

void TestMainWindow::cleanup() {
    delete window_;
    window_ = nullptr;
}

void TestMainWindow::testInitialState() {
    QVERIFY(window_ != nullptr);
    QCOMPARE(window_->windowTitle(), QString("Versus Native (Qt)"));
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
    QCOMPARE(trayIcon->toolTip(), QString("Versus - Idle"));
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

void TestMainWindow::testPasswordInputDefaults() {
    auto lineEdits = window_->findChildren<QLineEdit*>();
    QLineEdit *passwordInput = nullptr;
    for (auto *lineEdit : lineEdits) {
        if (lineEdit->placeholderText().contains("Password", Qt::CaseInsensitive)) {
            passwordInput = lineEdit;
            break;
        }
    }

    QVERIFY(passwordInput != nullptr);
    QVERIFY(passwordInput->text().isEmpty());
    QVERIFY(passwordInput->placeholderText().contains("leave blank", Qt::CaseInsensitive));
    QVERIFY(passwordInput->placeholderText().contains("false", Qt::CaseInsensitive));
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

    window_->show();
    QVERIFY(window_->isVisible());
    QCoreApplication::processEvents();

    advancedToggle->setChecked(false);
    QCoreApplication::processEvents();

    advancedToggle->setChecked(true);
    QTRY_VERIFY_WITH_TIMEOUT(advancedToggle->isChecked(), 1000);
    QCoreApplication::processEvents();

    const int forcedHeight = window_->height() + 140;
    window_->resize(window_->width(), forcedHeight);
    QTRY_VERIFY_WITH_TIMEOUT(window_->height() >= (forcedHeight - 2), 1000);

    advancedToggle->setChecked(false);
    QTRY_VERIFY_WITH_TIMEOUT(!advancedToggle->isChecked(), 1000);
    QTRY_VERIFY_WITH_TIMEOUT(window_->height() <= (forcedHeight - 20), 1000);
}

void TestMainWindow::testRemoteControlControls() {
    auto *remoteCheck = window_->findChild<QCheckBox*>("remoteControlCheck");
    QVERIFY(remoteCheck != nullptr);
    QVERIFY(!remoteCheck->isChecked());

    auto *tokenInput = window_->findChild<QLineEdit*>("remoteControlTokenInput");
    QVERIFY(tokenInput != nullptr);
    QVERIFY(!tokenInput->isEnabled());

    remoteCheck->setChecked(true);
    QVERIFY(tokenInput->isEnabled());
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
    QVERIFY(codecCombo != nullptr);
    QVERIFY(codecCombo->count() >= 4);

    auto *alphaCheck = window_->findChild<QCheckBox*>("alphaWorkflowCheck");
    QVERIFY(alphaCheck != nullptr);
    QVERIFY(!alphaCheck->isEnabled());

    const int av1Index = codecCombo->findData("av1");
    QVERIFY(av1Index >= 0);
    codecCombo->setCurrentIndex(av1Index);
    QVERIFY(alphaCheck->isEnabled());
}

QTEST_MAIN(TestMainWindow)
#include "test_main_window.moc"
