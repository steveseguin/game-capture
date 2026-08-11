#include <QtTest/QtTest>
#include <QtTest/qtestwheel.h>
#include <QAccessible>
#include <QApplication>
#include <QAbstractItemView>
#include <QPushButton>
#include <QLabel>
#include <QLineEdit>
#include <QComboBox>
#include <QSpinBox>
#include <QCheckBox>
#include <QDir>
#include <QProgressBar>
#include <QScrollArea>
#include <QScrollBar>
#include <QSettings>
#include <QSignalBlocker>
#include <QStringList>
#include <QSystemTrayIcon>

#include <algorithm>

#include "versus/ui/main_window.h"
#include "versus/ui/window_list_widget.h"
#include "versus/ui/stats_panel.h"

namespace versus::ui {

class MainWindowTestAccess {
  public:
    static versus::video::EncoderConfig buildEncoderConfigFromUi(
        const MainWindow &window,
        int width,
        int height,
        int fps,
        int bitrate) {
        return window.buildEncoderConfigFromUi(width, height, fps, bitrate);
    }

    static versus::app::StartOptions buildStartOptionsFromUi(
        const MainWindow &window) {
        return window.buildStartOptionsFromUi();
    }

    static void setConfigControlsEnabled(MainWindow &window, bool enabled) {
        window.setConfigControlsEnabled(enabled);
    }

    static void syncCodecUiState(MainWindow &window) {
        window.syncCodecUiState();
    }

    static QCheckBox *advancedToggle(MainWindow &window) {
        return window.advancedToggle_;
    }

    static QSpinBox *wheelContractSpinBox(
        MainWindow &window,
        const QString &objectName) {
        if (objectName == QStringLiteral("customBitrateSpin")) {
            return window.customBitrateSpin_;
        }
        return window.findChild<QSpinBox *>(objectName);
    }
};

}  // namespace versus::ui

namespace {

const QString kRoomQualityUnavailableText = QStringLiteral(
    "Room Quality is unavailable with this codec. Select H.264 to use it.");
const QString kRoomQualityUnavailableAccessibleName = QStringLiteral(
    "Room Quality unavailable. H.264 is required.");
const QString kRoomQualityUnavailableAccessibleDescription = QStringLiteral(
    "Your saved Room Quality preference will be restored when H.264 is selected.");

void addSpinBoxWheelContractRows() {
    QTest::addColumn<QString>("objectName");
    QTest::addColumn<int>("initialValue");

    QTest::newRow("custom-bitrate")
        << QStringLiteral("customBitrateSpin") << 12000;
    QTest::newRow("max-viewers")
        << QStringLiteral("viewerLimitSpin") << 10;
    QTest::newRow("game-audio-gain")
        << QStringLiteral("primaryAudioGainSpin") << 100;
    QTest::newRow("microphone-gain")
        << QStringLiteral("microphoneAudioGainSpin") << 100;
}

bool sendWheelEvent(QWidget *target, int angleDeltaY) {
    QWindow *targetWindow = target->window()->windowHandle();
    if (!targetWindow) {
        return false;
    }

    const QPoint localCenter = target->rect().center();
    const QPoint windowPosition = target->mapTo(target->window(), localCenter);
    QTest::wheelEvent(
        targetWindow,
        QPointF(windowPosition),
        QPoint(0, angleDeltaY));
    return true;
}

bool sendFocusedSpinWheelEvent(QSpinBox *target, int angleDeltaY) {
    if (!target || !target->hasFocus()) {
        return false;
    }

    const QPoint localCenter = target->rect().center();
    QWheelEvent event(
        QPointF(localCenter),
        QPointF(target->mapToGlobal(localCenter)),
        QPoint(),
        QPoint(0, angleDeltaY),
        Qt::NoButton,
        Qt::NoModifier,
        Qt::NoScrollPhase,
        false);
    const bool delivered = QApplication::sendEvent(target, &event);
    QCoreApplication::processEvents();
    return delivered;
}

bool probeUnfocusedSpinWheelGuard(
    QSpinBox *target,
    int angleDeltaY,
    bool *eventAcceptedOut) {
    if (!target || target->hasFocus() || !eventAcceptedOut) {
        return false;
    }

    const QPoint localCenter = target->rect().center();
    QWheelEvent event(
        QPointF(localCenter),
        QPointF(target->mapToGlobal(localCenter)),
        QPoint(),
        QPoint(0, angleDeltaY),
        Qt::NoButton,
        Qt::NoModifier,
        Qt::NoScrollPhase,
        false);
    const bool delivered = QApplication::sendEvent(target, &event);
    *eventAcceptedOut = event.isAccepted();
    QCoreApplication::processEvents();
    return delivered;
}

bool widgetIsOrDescendsFrom(const QWidget *widget, const QWidget *ancestor) {
    for (auto *current = widget; current; current = current->parentWidget()) {
        if (current == ancestor) {
            return true;
        }
    }
    return false;
}

bool positionWheelTarget(QScrollArea *scrollArea, QWidget *target) {
    if (!scrollArea || !target || !scrollArea->widget() || !scrollArea->viewport()) {
        return false;
    }

    auto *scrollBar = scrollArea->verticalScrollBar();
    if (!scrollBar || scrollBar->maximum() <= scrollBar->minimum()) {
        return false;
    }

    const int movementMargin = std::max(24, scrollBar->pageStep() / 8);
    const int lower = scrollBar->minimum() + movementMargin;
    const int upper = scrollBar->maximum() - movementMargin;
    if (lower >= upper) {
        return false;
    }

    const QPoint targetInContent = target->mapTo(
        scrollArea->widget(),
        target->rect().center());
    const int desired = std::clamp(
        targetInContent.y() - (scrollArea->viewport()->height() / 2),
        lower,
        upper);
    scrollBar->setValue(desired);
    QCoreApplication::processEvents();

    const QPoint globalCenter = target->mapToGlobal(target->rect().center());
    const QRect viewportGlobalRect(
        scrollArea->viewport()->mapToGlobal(QPoint(0, 0)),
        scrollArea->viewport()->size());
    return viewportGlobalRect.adjusted(2, 2, -2, -2).contains(globalCenter) &&
        widgetIsOrDescendsFrom(QApplication::widgetAt(globalCenter), target);
}

}  // namespace

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
    void testClosedSpinBoxesIgnoreWheel_data();
    void testClosedSpinBoxesIgnoreWheel();
    void testSpinBoxWheelTargetsHaveStableNames_data();
    void testSpinBoxWheelTargetsHaveStableNames();
    void testFocusedSpinBoxesUseNativeWheel_data();
    void testFocusedSpinBoxesUseNativeWheel();
    void testDisabledSpinBoxesPassWheelToPage_data();
    void testDisabledSpinBoxesPassWheelToPage();
    void testParseStreamTargetInput();
    void testAdvancedPanelAndViewerLimit();
    void testAdvancedPanelResizesWindowWhenClosed();
    void testRemoteControlControls();
    void testResolutionOptions();
    void testVideoSourceModeControl();
    void testCameraBasicOptions();
    void testPersistedCameraOptions();
    void testPersistedSpoutModeUsesNoAudio();
    void testPersistedCameraModeUsesMicrophone();
    void testSpoutSelectionPreviewMessaging();
    void testCameraSelectionPreviewMessaging();
    void testIceModeOptions();
    void testIceModeMapping_data();
    void testIceModeMapping();
    void testAudioSourceOptions();
    void testAudioMixControls();
    void testRoomModeQualityToggle();
    void testRoomQualityAvailabilityExplanationInitialState();
    void testRoomQualityUnavailableUi_data();
    void testRoomQualityUnavailableUi();
    void testRoomQualityLatentPreferenceSurvivesRestart();
    void testRoomQualityFalsePreferenceRemainsFalse();
    void testRoomQualityCodecSyncDoesNotToggleAlpha();
    void testRoomQualityStartUsesLatentPreference_data();
    void testRoomQualityStartUsesLatentPreference();
    void testRoomQualityConfigLockWinsCodecSync();
    void testRoomQualityUnavailableStartupPersistence_data();
    void testRoomQualityUnavailableStartupPersistence();
    void testRoomQualityCodecSyncPreservesAlphaAndEncoder_data();
    void testRoomQualityCodecSyncPreservesAlphaAndEncoder();
    void testRoomQualityH265LatentAlphaEffectiveUi_data();
    void testRoomQualityH265LatentAlphaEffectiveUi();
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
    auto *statusLabel = window_->findChild<QLabel*>("statusLabel");
    QVERIFY(statusLabel != nullptr);
    QCOMPARE(statusLabel->text(), QString("Select a window to capture"));
    QVERIFY(statusLabel->wordWrap());
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
    QVERIFY(sourceCombo->findData("camera") >= 0);
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

    const int cameraIndex = sourceCombo->findData("camera");
    QVERIFY(cameraIndex >= 0);
    QVERIFY(sourceCombo->itemText(cameraIndex).contains("webcam", Qt::CaseInsensitive));
    sourceCombo->setCurrentIndex(cameraIndex);
    QCOMPARE(sourceCombo->currentData().toString(), QString("camera"));
    QCOMPARE(audioCombo->currentData().toString(), QString("default-microphone"));

    const int windowIndex = sourceCombo->findData("window");
    QVERIFY(windowIndex >= 0);
    sourceCombo->setCurrentIndex(windowIndex);
    QCOMPARE(sourceCombo->currentData().toString(), QString("window"));
    QCOMPARE(audioCombo->currentData().toString(), QString("selected-window"));

    const int defaultOutputIndex = audioCombo->findData("default-output");
    QVERIFY(defaultOutputIndex >= 0);
    audioCombo->setCurrentIndex(defaultOutputIndex);
    sourceCombo->setCurrentIndex(cameraIndex);
    sourceCombo->setCurrentIndex(windowIndex);
    QCOMPARE(audioCombo->currentData().toString(), QString("default-output"));
}

void TestMainWindow::testCameraBasicOptions() {
    auto *sourceCombo = window_->findChild<QComboBox*>("sourceModeSelect");
    auto *cameraPanel = window_->findChild<QWidget*>("cameraOptionsPanel");
    auto *resolution = window_->findChild<QComboBox*>("cameraResolutionSelect");
    auto *frameRate = window_->findChild<QComboBox*>("cameraFpsSelect");
    QVERIFY(sourceCombo != nullptr);
    QVERIFY(cameraPanel != nullptr);
    QVERIFY(resolution != nullptr);
    QVERIFY(frameRate != nullptr);
    QVERIFY(cameraPanel->isHidden());

    sourceCombo->setCurrentIndex(sourceCombo->findData("camera"));
    QVERIFY(!cameraPanel->isHidden());
    QVERIFY(resolution->findData("1920x1080") >= 0);
    QVERIFY(resolution->findData("1280x720") >= 0);
    QVERIFY(resolution->findData("640x480") >= 0);
    QVERIFY(frameRate->findData(60) >= 0);
    QVERIFY(frameRate->findData(30) >= 0);
    QVERIFY(frameRate->findData(24) >= 0);
    QCOMPARE(frameRate->currentData().toInt(), 30);
    QVERIFY(resolution->toolTip().contains("closest supported", Qt::CaseInsensitive));

    sourceCombo->setCurrentIndex(sourceCombo->findData("window"));
    QVERIFY(cameraPanel->isHidden());
}

void TestMainWindow::testPersistedCameraOptions() {
    delete window_;
    window_ = nullptr;

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.setValue("video/sourceMode", "camera");
    settings.setValue("camera/resolution", "1280x720");
    settings.setValue("camera/fps", 24);
    settings.sync();

    window_ = new versus::ui::MainWindow(nullptr);
    auto *cameraPanel = window_->findChild<QWidget*>("cameraOptionsPanel");
    auto *resolution = window_->findChild<QComboBox*>("cameraResolutionSelect");
    auto *frameRate = window_->findChild<QComboBox*>("cameraFpsSelect");
    QVERIFY(cameraPanel != nullptr);
    QVERIFY(resolution != nullptr);
    QVERIFY(frameRate != nullptr);
    QVERIFY(!cameraPanel->isHidden());
    QCOMPARE(resolution->currentData().toString(), QString("1280x720"));
    QCOMPARE(frameRate->currentData().toInt(), 24);
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

void TestMainWindow::testPersistedCameraModeUsesMicrophone() {
    delete window_;
    window_ = nullptr;

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.setValue("video/sourceMode", "camera");
    settings.setValue("audio/source", "selected-window");
    settings.sync();

    window_ = new versus::ui::MainWindow(nullptr);

    auto *sourceCombo = window_->findChild<QComboBox*>("sourceModeSelect");
    auto *audioCombo = window_->findChild<QComboBox*>("audioSourceSelect");
    auto *microphoneCombo = window_->findChild<QComboBox*>("microphoneDeviceSelect");
    QVERIFY(sourceCombo != nullptr);
    QVERIFY(audioCombo != nullptr);
    QVERIFY(microphoneCombo != nullptr);
    QCOMPARE(sourceCombo->currentData().toString(), QString("camera"));
    QCOMPARE(audioCombo->currentData().toString(), QString("default-microphone"));
    QVERIFY(microphoneCombo->toolTip().contains("Camera mode", Qt::CaseInsensitive));
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

void TestMainWindow::testCameraSelectionPreviewMessaging() {
    auto *sourceCombo = window_->findChild<QComboBox*>("sourceModeSelect");
    auto *audioCombo = window_->findChild<QComboBox*>("audioSourceSelect");
    auto *windowList = window_->findChild<versus::ui::WindowListWidget*>();
    auto *preview = window_->findChild<QLabel*>("selectedPreview");
    QVERIFY(sourceCombo != nullptr);
    QVERIFY(audioCombo != nullptr);
    QVERIFY(windowList != nullptr);
    QVERIFY(preview != nullptr);

    const int cameraIndex = sourceCombo->findData("camera");
    QVERIFY(cameraIndex >= 0);
    sourceCombo->setCurrentIndex(cameraIndex);
    QCOMPARE(audioCombo->currentData().toString(), QString("default-microphone"));

    std::vector<versus::video::WindowInfo> cameras;
    versus::video::WindowInfo camera;
    camera.id = "camera-device-id";
    camera.name = "Test Webcam";
    camera.executableName = "Video input device";
    cameras.push_back(camera);
    windowList->setWindowList(cameras);

    auto *listWidget = windowList->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);
    QCOMPARE(listWidget->count(), 1);
    emit listWidget->itemClicked(listWidget->item(0));

    QVERIFY(preview->text().contains("Camera selected"));
    QVERIFY(preview->text().contains("Test Webcam"));
    QVERIFY(preview->text().contains("Microphone:"));
    QVERIFY(preview->text().contains("primary audio"));
    QVERIFY(preview->text().contains("opens when streaming starts"));
}

void TestMainWindow::testIceModeOptions() {
    auto *iceModeCombo = window_->findChild<QComboBox*>("iceModeSelect");
    QVERIFY(iceModeCombo != nullptr);
    QCOMPARE(iceModeCombo->count(), 4);
    QCOMPARE(iceModeCombo->currentData().toString(), QString("stun-only"));
    QVERIFY(iceModeCombo->findData("all") >= 0);
    QVERIFY(iceModeCombo->findData("relay") >= 0);
}

void TestMainWindow::testIceModeMapping_data() {
    QTest::addColumn<QString>("uiValue");
    QTest::addColumn<int>("expectedMode");

    QTest::newRow("auto-with-turn-fallback") << QString("all")
                                                << static_cast<int>(versus::webrtc::IceMode::All);
    QTest::newRow("direct-stun") << QString("stun-only")
                                  << static_cast<int>(versus::webrtc::IceMode::StunOnly);
    QTest::newRow("relay-only") << QString("relay")
                                 << static_cast<int>(versus::webrtc::IceMode::Relay);
    QTest::newRow("host-only") << QString("host-only")
                                << static_cast<int>(versus::webrtc::IceMode::HostOnly);
}

void TestMainWindow::testIceModeMapping() {
    QFETCH(QString, uiValue);
    QFETCH(int, expectedMode);

    QCOMPARE(static_cast<int>(versus::ui::MainWindow::iceModeFromUiValue(uiValue)), expectedMode);
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

void TestMainWindow::testRoomQualityAvailabilityExplanationInitialState() {
    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    auto *explanation =
        window_->findChild<QLabel *>("roomModeLqAvailabilityLabel");

    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QCOMPARE(codec->currentData().toString(), QStringLiteral("h264"));
    QVERIFY(roomQuality->isEnabled());
    QVERIFY(roomQuality->isChecked());
    QVERIFY2(explanation != nullptr,
             "Room Quality needs a dedicated inline availability explanation");
    QVERIFY2(explanation->isHidden(),
             "The H.264 availability explanation must be explicitly hidden so its layout row collapses");
    QVERIFY(!explanation->isVisible());
    QCOMPARE(explanation->buddy(), roomQuality);
    QCOMPARE(explanation->text(), kRoomQualityUnavailableText);
    QCOMPARE(explanation->accessibleName(), kRoomQualityUnavailableAccessibleName);
    QCOMPARE(explanation->accessibleDescription(),
             kRoomQualityUnavailableAccessibleDescription);

    QAccessibleInterface *accessible =
        QAccessible::queryAccessibleInterface(explanation);
    QVERIFY(accessible != nullptr);
    QCOMPARE(accessible->text(QAccessible::Name),
             kRoomQualityUnavailableAccessibleName);
    QCOMPARE(accessible->text(QAccessible::Description),
             kRoomQualityUnavailableAccessibleDescription);
}

void TestMainWindow::testRoomQualityUnavailableUi_data() {
    QTest::addColumn<QString>("codecValue");

    QTest::newRow("vp9") << QStringLiteral("vp9");
    QTest::newRow("h265") << QStringLiteral("h265");
    QTest::newRow("av1") << QStringLiteral("av1");
}

void TestMainWindow::testRoomQualityUnavailableUi() {
    QFETCH(QString, codecValue);

    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(roomQuality->isEnabled());
    QVERIFY(roomQuality->isChecked());

    QSignalSpy roomQualityToggles(roomQuality, &QCheckBox::toggled);
    const int codecIndex = codec->findData(codecValue);
    QVERIFY(codecIndex >= 0);
    codec->setCurrentIndex(codecIndex);
    QCoreApplication::processEvents();

    QVERIFY2(!roomQuality->isEnabled(),
             "Room Quality must be disabled for a selected non-H.264 codec");
    QVERIFY2(!roomQuality->isChecked(),
             "Unavailable Room Quality must be visually unchecked");
    QCOMPARE(roomQualityToggles.count(), 0);

    auto *explanation =
        window_->findChild<QLabel *>("roomModeLqAvailabilityLabel");
    QVERIFY2(explanation != nullptr,
             "Room Quality needs a dedicated inline availability explanation");
    QVERIFY2(!explanation->isHidden(),
             "The inline Room Quality explanation must be shown while unavailable");
    QCOMPARE(explanation->buddy(), roomQuality);
    QCOMPARE(explanation->text(), kRoomQualityUnavailableText);
    QCOMPARE(explanation->accessibleName(), kRoomQualityUnavailableAccessibleName);
    QCOMPARE(explanation->accessibleDescription(),
             kRoomQualityUnavailableAccessibleDescription);

    QAccessibleInterface *accessible =
        QAccessible::queryAccessibleInterface(explanation);
    QVERIFY(accessible != nullptr);
    QCOMPARE(accessible->text(QAccessible::Name),
             kRoomQualityUnavailableAccessibleName);
    QCOMPARE(accessible->text(QAccessible::Description),
             kRoomQualityUnavailableAccessibleDescription);

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.sync();
    QCOMPARE(settings.value("stream/roomModeLqEnabled").toBool(), true);

    codec->setCurrentIndex(codec->findData(QStringLiteral("h264")));
    QCoreApplication::processEvents();
    QVERIFY(roomQuality->isEnabled());
    QVERIFY(roomQuality->isChecked());
    QCOMPARE(roomQualityToggles.count(), 0);
    QVERIFY(explanation->isHidden());
}

void TestMainWindow::testRoomQualityLatentPreferenceSurvivesRestart() {
    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(roomQuality->isChecked());

    QSignalSpy roomQualityToggles(roomQuality, &QCheckBox::toggled);
    codec->setCurrentIndex(codec->findData(QStringLiteral("vp9")));
    QCoreApplication::processEvents();
    QCOMPARE(roomQualityToggles.count(), 0);

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.sync();
    QCOMPARE(settings.value("video/codec").toString(), QStringLiteral("vp9"));
    QCOMPARE(settings.value("stream/roomModeLqEnabled").toBool(), true);

    delete window_;
    window_ = new versus::ui::MainWindow(nullptr);
    roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    codec = window_->findChild<QComboBox *>("codecSelect");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QCOMPARE(codec->currentData().toString(), QStringLiteral("vp9"));
    QVERIFY(!roomQuality->isEnabled());
    QVERIFY(!roomQuality->isChecked());

    settings.sync();
    QCOMPARE(settings.value("stream/roomModeLqEnabled").toBool(), true);
    codec->setCurrentIndex(codec->findData(QStringLiteral("h264")));
    QCoreApplication::processEvents();
    QVERIFY(roomQuality->isEnabled());
    QVERIFY(roomQuality->isChecked());
}

void TestMainWindow::testRoomQualityFalsePreferenceRemainsFalse() {
    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);

    roomQuality->setChecked(false);
    QSignalSpy roomQualityToggles(roomQuality, &QCheckBox::toggled);
    codec->setCurrentIndex(codec->findData(QStringLiteral("vp9")));
    QCoreApplication::processEvents();
    QVERIFY(!roomQuality->isEnabled());
    QVERIFY(!roomQuality->isChecked());
    codec->setCurrentIndex(codec->findData(QStringLiteral("h264")));
    QCoreApplication::processEvents();
    QVERIFY(roomQuality->isEnabled());
    QVERIFY(!roomQuality->isChecked());
    QCOMPARE(roomQualityToggles.count(), 0);

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.sync();
    QCOMPARE(settings.value("stream/roomModeLqEnabled").toBool(), false);
}

void TestMainWindow::testRoomQualityCodecSyncDoesNotToggleAlpha() {
    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    auto *alpha = window_->findChild<QCheckBox *>("alphaWorkflowCheck");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(alpha != nullptr);

    alpha->setChecked(true);
    QVERIFY(alpha->isChecked());
    QSignalSpy alphaToggles(alpha, &QCheckBox::toggled);
    QSignalSpy roomQualityToggles(roomQuality, &QCheckBox::toggled);
    codec->setCurrentIndex(codec->findData(QStringLiteral("vp9")));
    QCoreApplication::processEvents();

    QVERIFY(alpha->isChecked());
    QCOMPARE(alphaToggles.count(), 0);
    QVERIFY(!roomQuality->isEnabled());
    QVERIFY(!roomQuality->isChecked());
    QCOMPARE(roomQualityToggles.count(), 0);
}

void TestMainWindow::testRoomQualityStartUsesLatentPreference_data() {
    QTest::addColumn<bool>("requested");

    QTest::newRow("latent-true") << true;
    QTest::newRow("latent-false") << false;
}

void TestMainWindow::testRoomQualityStartUsesLatentPreference() {
    QFETCH(bool, requested);

    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    auto *alpha = window_->findChild<QCheckBox *>("alphaWorkflowCheck");
    auto *encoder = window_->findChild<QComboBox *>("encoderSelect");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(alpha != nullptr);
    QVERIFY(encoder != nullptr);

    if (roomQuality->isChecked() != requested) {
        roomQuality->click();
    }
    alpha->setChecked(true);
    encoder->setCurrentIndex(encoder->findData(QStringLiteral("software")));
    QCoreApplication::processEvents();

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.sync();
    QCOMPARE(settings.value("stream/roomModeLqEnabled").toBool(), requested);

    QSignalSpy roomQualityToggles(roomQuality, &QCheckBox::toggled);
    QSignalSpy alphaToggles(alpha, &QCheckBox::toggled);
    codec->setCurrentIndex(codec->findData(QStringLiteral("vp9")));
    QCoreApplication::processEvents();

    // Model the required unavailable visual projection while this test isolates
    // the production StartOptions path from the separate availability renderer.
    if (roomQuality->isChecked()) {
        QSignalBlocker blocker(roomQuality);
        roomQuality->setChecked(false);
    }
    QVERIFY(!roomQuality->isChecked());
    QVERIFY(!roomQuality->signalsBlocked());
    QCOMPARE(roomQualityToggles.count(), 0);
    QVERIFY(alpha->isChecked());
    QCOMPARE(alphaToggles.count(), 0);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));

    const versus::app::StartOptions options =
        versus::ui::MainWindowTestAccess::buildStartOptionsFromUi(*window_);
    QCOMPARE(options.roomModeLqEnabled, requested);

    codec->setCurrentIndex(codec->findData(QStringLiteral("h264")));
    QCoreApplication::processEvents();
    QVERIFY(roomQuality->isEnabled());
    QCOMPARE(roomQuality->isChecked(), requested);
    QCOMPARE(roomQualityToggles.count(), 0);
    QVERIFY(!roomQuality->signalsBlocked());
    QVERIFY(alpha->isChecked());
    QCOMPARE(alphaToggles.count(), 0);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));

    roomQuality->click();
    QCoreApplication::processEvents();
    QCOMPARE(roomQualityToggles.count(), 1);
    QCOMPARE(roomQuality->isChecked(), !requested);
    QVERIFY(!roomQuality->signalsBlocked());
    settings.sync();
    QCOMPARE(settings.value("stream/roomModeLqEnabled").toBool(), !requested);
}

void TestMainWindow::testRoomQualityConfigLockWinsCodecSync() {
    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    auto *alpha = window_->findChild<QCheckBox *>("alphaWorkflowCheck");
    auto *encoder = window_->findChild<QComboBox *>("encoderSelect");
    auto *explanation =
        window_->findChild<QLabel *>("roomModeLqAvailabilityLabel");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(alpha != nullptr);
    QVERIFY(encoder != nullptr);

    alpha->setChecked(true);
    encoder->setCurrentIndex(encoder->findData(QStringLiteral("software")));
    QCoreApplication::processEvents();
    QSignalSpy roomQualityToggles(roomQuality, &QCheckBox::toggled);
    QSignalSpy alphaToggles(alpha, &QCheckBox::toggled);

    const bool initialH264ExplanationHidden = explanation && explanation->isHidden();
    versus::ui::MainWindowTestAccess::setConfigControlsEnabled(*window_, false);
    codec->setCurrentIndex(codec->findData(QStringLiteral("vp9")));
    QCoreApplication::processEvents();
    const bool lockedNonH264Disabled = !roomQuality->isEnabled();
    const bool lockedNonH264ExplanationVisible = explanation && !explanation->isHidden();

    codec->setCurrentIndex(codec->findData(QStringLiteral("h264")));
    QCoreApplication::processEvents();
    const bool lockedH264Disabled = !roomQuality->isEnabled();
    const bool lockedH264ExplanationHidden = explanation && explanation->isHidden();

    versus::ui::MainWindowTestAccess::setConfigControlsEnabled(*window_, true);
    const bool unlockedH264Enabled = roomQuality->isEnabled();
    codec->setCurrentIndex(codec->findData(QStringLiteral("vp9")));
    QCoreApplication::processEvents();
    const bool unlockedNonH264Disabled = !roomQuality->isEnabled();
    const bool unlockedNonH264ExplanationVisible = explanation && !explanation->isHidden();

    versus::ui::MainWindowTestAccess::setConfigControlsEnabled(*window_, false);
    versus::ui::MainWindowTestAccess::setConfigControlsEnabled(*window_, true);
    const bool relockedThenUnlockedNonH264Disabled = !roomQuality->isEnabled();
    const bool relockedNonH264ExplanationVisible = explanation && !explanation->isHidden();

    codec->setCurrentIndex(codec->findData(QStringLiteral("h264")));
    QCoreApplication::processEvents();
    const bool finalH264Enabled = roomQuality->isEnabled();
    const bool finalH264ExplanationHidden = explanation && explanation->isHidden();

    QVERIFY(lockedNonH264Disabled);
    QVERIFY(lockedH264Disabled);
    QVERIFY(unlockedH264Enabled);
    QVERIFY2(unlockedNonH264Disabled,
             "Unlocking config controls must not enable Room Quality for a non-H.264 codec");
    QVERIFY2(relockedThenUnlockedNonH264Disabled,
             "Repeated global lock rendering must keep unavailable Room Quality disabled");
    QVERIFY(finalH264Enabled);
    QVERIFY2(explanation != nullptr,
             "Room Quality needs a dedicated inline availability explanation");
    QVERIFY(initialH264ExplanationHidden);
    QVERIFY(lockedNonH264ExplanationVisible);
    QVERIFY(lockedH264ExplanationHidden);
    QVERIFY(unlockedNonH264ExplanationVisible);
    QVERIFY(relockedNonH264ExplanationVisible);
    QVERIFY(finalH264ExplanationHidden);
    QCOMPARE(roomQualityToggles.count(), 0);
    QVERIFY(!roomQuality->signalsBlocked());
    QVERIFY(alpha->isChecked());
    QCOMPARE(alphaToggles.count(), 0);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
}

void TestMainWindow::testRoomQualityUnavailableStartupPersistence_data() {
    QTest::addColumn<QString>("codecValue");
    QTest::addColumn<bool>("requested");

    QTest::newRow("vp9-latent-true") << QStringLiteral("vp9") << true;
    QTest::newRow("vp9-latent-false") << QStringLiteral("vp9") << false;
    QTest::newRow("h265-latent-true") << QStringLiteral("h265") << true;
    QTest::newRow("h265-latent-false") << QStringLiteral("h265") << false;
    QTest::newRow("av1-latent-true") << QStringLiteral("av1") << true;
    QTest::newRow("av1-latent-false") << QStringLiteral("av1") << false;
}

void TestMainWindow::testRoomQualityUnavailableStartupPersistence() {
    QFETCH(QString, codecValue);
    QFETCH(bool, requested);

    delete window_;
    window_ = nullptr;
    QSettings settings("VDO.Ninja", "Game Capture");
    settings.clear();
    settings.setValue("video/codec", codecValue);
    settings.setValue("video/encoderMode", QStringLiteral("software"));
    settings.setValue("video/alphaWorkflow", false);
    settings.setValue("stream/roomModeLqEnabled", requested);
    settings.setValue("stream/label", QStringLiteral("before-unrelated-save"));
    settings.sync();

    window_ = new versus::ui::MainWindow(nullptr);
    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    auto *alpha = window_->findChild<QCheckBox *>("alphaWorkflowCheck");
    auto *encoder = window_->findChild<QComboBox *>("encoderSelect");
    QLineEdit *label = nullptr;
    for (auto *candidate : window_->findChildren<QLineEdit *>()) {
        if (candidate->placeholderText() == QStringLiteral("Stream label (optional)")) {
            label = candidate;
            break;
        }
    }
    auto *explanation =
        window_->findChild<QLabel *>("roomModeLqAvailabilityLabel");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(alpha != nullptr);
    QVERIFY(encoder != nullptr);
    QVERIFY(label != nullptr);
    QCOMPARE(codec->currentData().toString(), codecValue);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
    QVERIFY(!alpha->isChecked());

    QSignalSpy roomQualityToggles(roomQuality, &QCheckBox::toggled);
    QSignalSpy alphaToggles(alpha, &QCheckBox::toggled);
    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    QCoreApplication::processEvents();
    const bool unavailableAtStartup =
        !roomQuality->isEnabled() && !roomQuality->isChecked();
    const bool explanationVisibleAtStartup = explanation && !explanation->isHidden();

    // Keep the unavailable visual projection fixed so this row isolates whether
    // an unrelated save overwrites the latent preference.
    if (roomQuality->isChecked()) {
        QSignalBlocker blocker(roomQuality);
        roomQuality->setChecked(false);
    }
    QVERIFY(!roomQuality->signalsBlocked());
    QCOMPARE(roomQualityToggles.count(), 0);
    QCOMPARE(alphaToggles.count(), 0);

    label->setText(QStringLiteral("unrelated-save-%1-%2")
                       .arg(codecValue, requested ? QStringLiteral("true")
                                                  : QStringLiteral("false")));
    QCoreApplication::processEvents();
    settings.sync();
    QCOMPARE(settings.value("stream/roomModeLqEnabled").toBool(), requested);
    QCOMPARE(settings.value("video/codec").toString(), codecValue);
    QCOMPARE(settings.value("video/encoderMode").toString(), QStringLiteral("software"));
    QCOMPARE(settings.value("video/alphaWorkflow").toBool(), false);

    delete window_;
    window_ = new versus::ui::MainWindow(nullptr);
    roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    codec = window_->findChild<QComboBox *>("codecSelect");
    alpha = window_->findChild<QCheckBox *>("alphaWorkflowCheck");
    encoder = window_->findChild<QComboBox *>("encoderSelect");
    explanation = window_->findChild<QLabel *>("roomModeLqAvailabilityLabel");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(alpha != nullptr);
    QVERIFY(encoder != nullptr);
    QCOMPARE(codec->currentData().toString(), codecValue);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
    QVERIFY(!alpha->isChecked());
    const bool unavailableAfterRestart =
        !roomQuality->isEnabled() && !roomQuality->isChecked();
    const bool explanationVisibleAfterRestart = explanation && !explanation->isHidden();

    QSignalSpy restartRoomQualityToggles(roomQuality, &QCheckBox::toggled);
    QSignalSpy restartAlphaToggles(alpha, &QCheckBox::toggled);
    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    QCoreApplication::processEvents();
    QCOMPARE(restartRoomQualityToggles.count(), 0);
    QCOMPARE(restartAlphaToggles.count(), 0);

    if (roomQuality->isChecked()) {
        QSignalBlocker blocker(roomQuality);
        roomQuality->setChecked(false);
    }
    QVERIFY(!roomQuality->signalsBlocked());
    codec->setCurrentIndex(codec->findData(QStringLiteral("h264")));
    QCoreApplication::processEvents();
    QVERIFY(roomQuality->isEnabled());
    QCOMPARE(roomQuality->isChecked(), requested);
    QCOMPARE(restartRoomQualityToggles.count(), 0);
    QVERIFY(!roomQuality->signalsBlocked());
    QVERIFY(!alpha->isChecked());
    QCOMPARE(restartAlphaToggles.count(), 0);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
    QVERIFY(!explanation || explanation->isHidden());

    const versus::app::StartOptions options =
        versus::ui::MainWindowTestAccess::buildStartOptionsFromUi(*window_);
    QCOMPARE(options.roomModeLqEnabled, requested);
    settings.sync();
    QCOMPARE(settings.value("stream/roomModeLqEnabled").toBool(), requested);

    QVERIFY2(unavailableAtStartup,
             "A persisted non-H.264 codec must project Room Quality as unavailable during initial load");
    QVERIFY2(unavailableAfterRestart,
             "A persisted non-H.264 codec must project Room Quality as unavailable after restart");
    QVERIFY(explanation != nullptr);
    QVERIFY(explanationVisibleAtStartup);
    QVERIFY(explanationVisibleAfterRestart);
}

void TestMainWindow::testRoomQualityCodecSyncPreservesAlphaAndEncoder_data() {
    QTest::addColumn<QString>("codecValue");
    QTest::addColumn<bool>("alphaEnabled");

    QTest::newRow("vp9-alpha-true") << QStringLiteral("vp9") << true;
    QTest::newRow("vp9-alpha-false") << QStringLiteral("vp9") << false;
    QTest::newRow("h265-alpha-true") << QStringLiteral("h265") << true;
    QTest::newRow("h265-alpha-false") << QStringLiteral("h265") << false;
    QTest::newRow("av1-alpha-true") << QStringLiteral("av1") << true;
    QTest::newRow("av1-alpha-false") << QStringLiteral("av1") << false;
}

void TestMainWindow::testRoomQualityCodecSyncPreservesAlphaAndEncoder() {
    QFETCH(QString, codecValue);
    QFETCH(bool, alphaEnabled);

    auto *roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    auto *alpha = window_->findChild<QCheckBox *>("alphaWorkflowCheck");
    auto *encoder = window_->findChild<QComboBox *>("encoderSelect");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(alpha != nullptr);
    QVERIFY(encoder != nullptr);

    encoder->setCurrentIndex(encoder->findData(QStringLiteral("software")));
    alpha->setChecked(alphaEnabled);
    QCoreApplication::processEvents();
    QCOMPARE(alpha->isChecked(), alphaEnabled);

    QSignalSpy roomQualityToggles(roomQuality, &QCheckBox::toggled);
    QSignalSpy alphaToggles(alpha, &QCheckBox::toggled);
    codec->setCurrentIndex(codec->findData(codecValue));
    QCoreApplication::processEvents();
    QCOMPARE(codec->currentData().toString(), codecValue);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
    QCOMPARE(alpha->isChecked(), alphaEnabled);
    QCOMPARE(alphaToggles.count(), 0);
    QCOMPARE(roomQualityToggles.count(), 0);
    QVERIFY(!roomQuality->signalsBlocked());
    QVERIFY(!alpha->signalsBlocked());

    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    QCoreApplication::processEvents();
    QCOMPARE(codec->currentData().toString(), codecValue);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
    QCOMPARE(alpha->isChecked(), alphaEnabled);
    QCOMPARE(alphaToggles.count(), 0);
    QCOMPARE(roomQualityToggles.count(), 0);
    const bool unavailableBeforeRestart =
        !roomQuality->isEnabled() && !roomQuality->isChecked();

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.sync();
    QCOMPARE(settings.value("video/codec").toString(), codecValue);
    QCOMPARE(settings.value("video/encoderMode").toString(), QStringLiteral("software"));
    QCOMPARE(settings.value("video/alphaWorkflow").toBool(), alphaEnabled);

    delete window_;
    window_ = new versus::ui::MainWindow(nullptr);
    roomQuality = window_->findChild<QCheckBox *>("roomModeLqCheck");
    codec = window_->findChild<QComboBox *>("codecSelect");
    alpha = window_->findChild<QCheckBox *>("alphaWorkflowCheck");
    encoder = window_->findChild<QComboBox *>("encoderSelect");
    QVERIFY(roomQuality != nullptr);
    QVERIFY(codec != nullptr);
    QVERIFY(alpha != nullptr);
    QVERIFY(encoder != nullptr);
    QCOMPARE(codec->currentData().toString(), codecValue);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
    QCOMPARE(alpha->isChecked(), alphaEnabled);

    QSignalSpy restartRoomQualityToggles(roomQuality, &QCheckBox::toggled);
    QSignalSpy restartAlphaToggles(alpha, &QCheckBox::toggled);
    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    QCoreApplication::processEvents();
    QCOMPARE(codec->currentData().toString(), codecValue);
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
    QCOMPARE(alpha->isChecked(), alphaEnabled);
    QCOMPARE(restartAlphaToggles.count(), 0);
    QCOMPARE(restartRoomQualityToggles.count(), 0);
    QVERIFY(!roomQuality->signalsBlocked());
    QVERIFY(!alpha->signalsBlocked());
    const bool unavailableAfterRestart =
        !roomQuality->isEnabled() && !roomQuality->isChecked();

    QVERIFY2(unavailableBeforeRestart,
             "Every selected non-H.264 codec must project Room Quality as unavailable");
    QVERIFY2(unavailableAfterRestart,
             "Every persisted non-H.264 codec must keep Room Quality unavailable after restart");
}

void TestMainWindow::testRoomQualityH265LatentAlphaEffectiveUi_data() {
    QTest::addColumn<QString>("backgroundValue");
    QTest::addColumn<bool>("expectedColorEnabled");
    QTest::addColumn<int>("expectedBackgroundMode");

    QTest::newRow("none")
        << QStringLiteral("none")
        << false
        << static_cast<int>(versus::video::AlphaBackgroundMode::None);
    QTest::newRow("chroma")
        << QStringLiteral("chroma")
        << true
        << static_cast<int>(versus::video::AlphaBackgroundMode::Chroma);
    QTest::newRow("opaque")
        << QStringLiteral("opaque")
        << true
        << static_cast<int>(versus::video::AlphaBackgroundMode::Opaque);
}

void TestMainWindow::testRoomQualityH265LatentAlphaEffectiveUi() {
    QFETCH(QString, backgroundValue);
    QFETCH(bool, expectedColorEnabled);
    QFETCH(int, expectedBackgroundMode);

    auto *codec = window_->findChild<QComboBox *>("codecSelect");
    auto *encoder = window_->findChild<QComboBox *>("encoderSelect");
    auto *alpha = window_->findChild<QCheckBox *>("alphaWorkflowCheck");
    auto *backgroundMode =
        window_->findChild<QComboBox *>("alphaBackgroundModeSelect");
    auto *backgroundColor =
        window_->findChild<QPushButton *>("alphaBackgroundColorButton");
    auto *ffmpegPath = window_->findChild<QLineEdit *>("ffmpegPathInput");
    auto *ffmpegOptions = window_->findChild<QLineEdit *>("ffmpegOptionsInput");
    auto *ffmpegStatus = window_->findChild<QLabel *>("ffmpegStatusLabel");
    auto *sourceMode = window_->findChild<QComboBox *>("sourceModeSelect");
    auto *windowList = window_->findChild<versus::ui::WindowListWidget *>();
    auto *preview = window_->findChild<QLabel *>("selectedPreview");
    QVERIFY(codec != nullptr);
    QVERIFY(encoder != nullptr);
    QVERIFY(alpha != nullptr);
    QVERIFY(backgroundMode != nullptr);
    QVERIFY(backgroundColor != nullptr);
    QVERIFY(ffmpegPath != nullptr);
    QVERIFY(ffmpegOptions != nullptr);
    QVERIFY(ffmpegStatus != nullptr);
    QVERIFY(sourceMode != nullptr);
    QVERIFY(windowList != nullptr);
    QVERIFY(preview != nullptr);

    const int backgroundIndex = backgroundMode->findData(backgroundValue);
    const int softwareIndex = encoder->findData(QStringLiteral("software"));
    const int h265Index = codec->findData(QStringLiteral("h265"));
    QVERIFY(backgroundIndex >= 0);
    QVERIFY(softwareIndex >= 0);
    QVERIFY(h265Index >= 0);
    backgroundMode->setCurrentIndex(backgroundIndex);
    encoder->setCurrentIndex(softwareIndex);
    alpha->setChecked(true);
    QCoreApplication::processEvents();

    QSignalSpy alphaToggles(alpha, &QCheckBox::toggled);
    codec->setCurrentIndex(h265Index);
    QCoreApplication::processEvents();
    QCOMPARE(codec->currentData().toString(), QStringLiteral("h265"));
    QCOMPARE(encoder->currentData().toString(), QStringLiteral("software"));
    QVERIFY(alpha->isChecked());
    QVERIFY(!alpha->isEnabled());
    QCOMPARE(alphaToggles.count(), 0);
    QVERIFY(!alpha->signalsBlocked());

    const versus::video::EncoderConfig config =
        versus::ui::MainWindowTestAccess::buildEncoderConfigFromUi(
            *window_, 1920, 1080, 60, 12000);
    QCOMPARE(static_cast<int>(config.codec),
             static_cast<int>(versus::video::VideoCodec::H265));
    QVERIFY(!config.enableAlpha);
    QCOMPARE(static_cast<int>(config.alphaBackgroundMode), expectedBackgroundMode);
    QCOMPARE(static_cast<int>(config.preferredHardware),
             static_cast<int>(versus::video::HardwareEncoder::None));
    QVERIFY(!config.forceFfmpegNvenc);

    const bool unlockedBackgroundEnabled = backgroundMode->isEnabled();
    const bool unlockedColorEnabled = backgroundColor->isEnabled();
    const QString unlockedBackgroundTooltip = backgroundMode->toolTip();
    const bool unlockedFfmpegPathEnabled = ffmpegPath->isEnabled();
    const bool unlockedFfmpegOptionsEnabled = ffmpegOptions->isEnabled();
    const QString unlockedFfmpegStatus = ffmpegStatus->text();

    versus::ui::MainWindowTestAccess::setConfigControlsEnabled(*window_, false);
    const bool lockDisablesBackground = !backgroundMode->isEnabled();
    const bool lockDisablesColor = !backgroundColor->isEnabled();
    const bool lockDisablesFfmpegPath = !ffmpegPath->isEnabled();
    const bool lockDisablesFfmpegOptions = !ffmpegOptions->isEnabled();
    codec->setCurrentIndex(codec->findData(QStringLiteral("h264")));
    codec->setCurrentIndex(h265Index);
    versus::ui::MainWindowTestAccess::syncCodecUiState(*window_);
    QCoreApplication::processEvents();
    const bool lockedSyncKeepsBackgroundDisabled = !backgroundMode->isEnabled();
    const bool lockedSyncKeepsColorDisabled = !backgroundColor->isEnabled();
    const bool lockedSyncKeepsFfmpegPathDisabled = !ffmpegPath->isEnabled();
    const bool lockedSyncKeepsFfmpegOptionsDisabled = !ffmpegOptions->isEnabled();

    versus::ui::MainWindowTestAccess::setConfigControlsEnabled(*window_, true);
    QCoreApplication::processEvents();
    const bool restoredBackgroundEnabled = backgroundMode->isEnabled();
    const bool restoredColorEnabled = backgroundColor->isEnabled();
    const QString restoredBackgroundTooltip = backgroundMode->toolTip();
    const bool restoredFfmpegPathEnabled = ffmpegPath->isEnabled();
    const bool restoredFfmpegOptionsEnabled = ffmpegOptions->isEnabled();

    const int spoutIndex = sourceMode->findData(QStringLiteral("spout"));
    QVERIFY(spoutIndex >= 0);
    sourceMode->setCurrentIndex(spoutIndex);
    std::vector<versus::video::WindowInfo> senders;
    versus::video::WindowInfo sender;
    sender.id = "H265LatentAlphaSpout";
    sender.name = "H265LatentAlphaSpout";
    sender.executableName = "Spout2 sender";
    sender.width = 1920;
    sender.height = 1080;
    senders.push_back(sender);
    windowList->setWindowList(senders);
    auto *listWidget = windowList->findChild<QListWidget *>();
    QVERIFY(listWidget != nullptr);
    QCOMPARE(listWidget->count(), 1);
    emit listWidget->itemClicked(listWidget->item(0));
    QCoreApplication::processEvents();
    const QString previewText = preview->text();

    QSettings settings("VDO.Ninja", "Game Capture");
    settings.sync();
    QCOMPARE(settings.value("video/codec").toString(), QStringLiteral("h265"));
    QCOMPARE(settings.value("video/encoderMode").toString(), QStringLiteral("software"));
    QCOMPARE(settings.value("video/alphaWorkflow").toBool(), true);
    QCOMPARE(settings.value("video/alphaBackgroundMode").toString(), backgroundValue);
    QCOMPARE(alphaToggles.count(), 0);
    QVERIFY(alpha->isChecked());
    QVERIFY(!alpha->isEnabled());
    QVERIFY(!alpha->signalsBlocked());

    QVERIFY2(unlockedBackgroundEnabled,
             "Latent H.265 alpha preference must not disable effective background compositing controls");
    QCOMPARE(unlockedColorEnabled, expectedColorEnabled);
    QVERIFY(unlockedBackgroundTooltip.contains("Composites transparent", Qt::CaseInsensitive));
    QVERIFY(!unlockedBackgroundTooltip.contains("Alpha-preserving encode is enabled", Qt::CaseInsensitive));
    QVERIFY(unlockedFfmpegPathEnabled);
    QVERIFY(unlockedFfmpegOptionsEnabled);
    QVERIFY(!unlockedFfmpegStatus.contains("libvpx", Qt::CaseInsensitive));
    QVERIFY(!unlockedFfmpegStatus.contains("VP9 alpha", Qt::CaseInsensitive));
    QVERIFY(!unlockedFfmpegStatus.contains("alpha mask", Qt::CaseInsensitive));

    QVERIFY(lockDisablesBackground);
    QVERIFY(lockDisablesColor);
    QVERIFY(lockDisablesFfmpegPath);
    QVERIFY(lockDisablesFfmpegOptions);
    QVERIFY(lockedSyncKeepsBackgroundDisabled);
    QVERIFY(lockedSyncKeepsColorDisabled);
    QVERIFY(lockedSyncKeepsFfmpegPathDisabled);
    QVERIFY(lockedSyncKeepsFfmpegOptionsDisabled);
    QVERIFY(restoredBackgroundEnabled);
    QCOMPARE(restoredColorEnabled, expectedColorEnabled);
    QVERIFY(restoredBackgroundTooltip.contains("Composites transparent", Qt::CaseInsensitive));
    QVERIFY(!restoredBackgroundTooltip.contains("Alpha-preserving encode is enabled", Qt::CaseInsensitive));
    QVERIFY(restoredFfmpegPathEnabled);
    QVERIFY(restoredFfmpegOptionsEnabled);
    QVERIFY(!previewText.contains("True alpha", Qt::CaseInsensitive));
    if (backgroundValue == QStringLiteral("chroma")) {
        QVERIFY(previewText.contains("Chroma output over #00FF00", Qt::CaseInsensitive));
    } else {
        QVERIFY(previewText.contains("For transparency: VP9 alpha or chroma background",
                                     Qt::CaseInsensitive));
    }
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
    auto *focusAnchor = window_->findChild<QLineEdit *>("passwordInput");
    auto *advancedToggle = versus::ui::MainWindowTestAccess::advancedToggle(*window_);
    QVERIFY(iceModeCombo != nullptr);
    QVERIFY(focusAnchor != nullptr);
    QVERIFY(advancedToggle != nullptr);
    QVERIFY(iceModeCombo->count() > 1);

    advancedToggle->setChecked(true);
    window_->resize(window_->minimumSize());
    window_->show();
    QCoreApplication::processEvents();

    auto *scrollArea = window_->findChild<QScrollArea *>();
    QVERIFY(scrollArea != nullptr);
    auto *scrollBar = scrollArea->verticalScrollBar();
    QVERIFY(scrollBar != nullptr);
    QVERIFY2(scrollBar->maximum() > scrollBar->minimum(),
             "The advanced form must overflow so closed-combo wheel propagation is observable");

    iceModeCombo->setCurrentIndex(1);
    const int expectedIndex = iceModeCombo->currentIndex();
    QVERIFY(iceModeCombo->view() != nullptr);
    QVERIFY(!iceModeCombo->view()->isVisible());

    const int middleScrollPosition =
        scrollBar->minimum() + ((scrollBar->maximum() - scrollBar->minimum()) / 2);
    QVERIFY(middleScrollPosition > scrollBar->minimum());
    QVERIFY(middleScrollPosition < scrollBar->maximum());

    QStringList contractFailures;
    const auto observeDirection = [&](int angleDeltaY, const QString &direction) {
        iceModeCombo->setCurrentIndex(expectedIndex);
        iceModeCombo->clearFocus();
        focusAnchor->setFocus(Qt::MouseFocusReason);
        scrollBar->setValue(middleScrollPosition);
        QCoreApplication::processEvents();

        if (!focusAnchor->hasFocus() || iceModeCombo->hasFocus()) {
            contractFailures.append(
                QString("%1 setup could not place focus on the prior input").arg(direction));
        }

        for (int eventIndex = 0; eventIndex < 2; ++eventIndex) {
            const int previousScrollPosition = scrollBar->value();
            if (!sendWheelEvent(iceModeCombo, angleDeltaY)) {
                contractFailures.append(
                    QString("%1 event %2 could not be delivered")
                        .arg(direction)
                        .arg(eventIndex + 1));
                continue;
            }

            if (iceModeCombo->currentIndex() != expectedIndex) {
                contractFailures.append(
                    QString("%1 event %2 changed selection from %3 to %4")
                        .arg(direction)
                        .arg(eventIndex + 1)
                        .arg(expectedIndex)
                        .arg(iceModeCombo->currentIndex()));
            }
            if (!focusAnchor->hasFocus() || iceModeCombo->hasFocus()) {
                contractFailures.append(
                    QString("%1 event %2 stole prior input focus")
                        .arg(direction)
                        .arg(eventIndex + 1));
            }

            const bool pageMoved = angleDeltaY < 0
                ? scrollBar->value() > previousScrollPosition
                : scrollBar->value() < previousScrollPosition;
            if (!pageMoved) {
                contractFailures.append(
                    QString("%1 event %2 did not scroll the containing page")
                        .arg(direction)
                        .arg(eventIndex + 1));
            }
        }
    };

    observeDirection(-120, QStringLiteral("down-wheel"));
    observeDirection(120, QStringLiteral("up-wheel"));

    QVERIFY2(contractFailures.isEmpty(),
             qPrintable(QString("Closed ICE Mode combo wheel contract failures: %1")
                            .arg(contractFailures.join("; "))));
}

void TestMainWindow::testClosedSpinBoxesIgnoreWheel_data() {
    addSpinBoxWheelContractRows();
}

void TestMainWindow::testClosedSpinBoxesIgnoreWheel() {
    QFETCH(QString, objectName);
    QFETCH(int, initialValue);

    auto *advancedToggle = versus::ui::MainWindowTestAccess::advancedToggle(*window_);
    auto *focusAnchor = window_->findChild<QLineEdit *>("passwordInput");
    QVERIFY(advancedToggle != nullptr);
    QVERIFY(focusAnchor != nullptr);
    advancedToggle->setChecked(true);

    window_->resize(window_->minimumSize());
    window_->show();
    QCoreApplication::processEvents();

    auto *scrollArea = window_->findChild<QScrollArea *>();
    QVERIFY(scrollArea != nullptr);
    auto *scrollBar = scrollArea->verticalScrollBar();
    QVERIFY(scrollBar != nullptr);
    QVERIFY2(scrollBar->maximum() > scrollBar->minimum(),
             "The advanced form must overflow so wheel propagation is observable");

    auto *spin = versus::ui::MainWindowTestAccess::wheelContractSpinBox(
        *window_, objectName);
    QVERIFY2(spin != nullptr,
             qPrintable(QString("Missing spin box %1").arg(objectName)));

    // Custom Bitrate is disabled for a preset bitrate. Enable the control so
    // this exercises the same user-facing wheel path as the Custom preset.
    spin->setEnabled(true);

    QStringList contractFailures;
    const auto observeDirection = [&](int angleDeltaY, const QString &direction) {
        spin->setValue(initialValue);
        spin->clearFocus();
        focusAnchor->setFocus(Qt::MouseFocusReason);
        if (!positionWheelTarget(scrollArea, spin)) {
            contractFailures.append(
                QString("%1 setup could not position %2 under the wheel coordinate")
                    .arg(direction, objectName));
            return;
        }

        if (!focusAnchor->hasFocus() || spin->hasFocus()) {
            contractFailures.append(
                QString("%1 setup could not place focus on the prior input").arg(direction));
        }

        const int branchValueBefore = spin->value();
        const QWidget *branchFocusBefore = QApplication::focusWidget();
        bool branchEventAccepted = true;
        const bool branchEventDelivered = probeUnfocusedSpinWheelGuard(
            spin,
            angleDeltaY,
            &branchEventAccepted);
        const bool guardBranchObserved = branchEventDelivered &&
            !branchEventAccepted &&
            spin->value() == branchValueBefore &&
            QApplication::focusWidget() == branchFocusBefore &&
            focusAnchor->hasFocus() &&
            !spin->hasFocus();
        if (!guardBranchObserved) {
            contractFailures.append(
                QString("%1 unfocused SpinWheelGuard branch was not observed")
                    .arg(direction));
        }

        spin->setValue(initialValue);
        spin->clearFocus();
        focusAnchor->setFocus(Qt::MouseFocusReason);
        if (!positionWheelTarget(scrollArea, spin)) {
            contractFailures.append(
                QString("%1 setup could not restore %2 under the wheel coordinate")
                    .arg(direction, objectName));
            return;
        }

        for (int eventIndex = 0; eventIndex < 2; ++eventIndex) {
            const int previousScrollPosition = scrollBar->value();
            if (!sendWheelEvent(spin, angleDeltaY)) {
                contractFailures.append(
                    QString("%1 event %2 could not be delivered")
                        .arg(direction)
                        .arg(eventIndex + 1));
                continue;
            }

            if (spin->value() != initialValue) {
                contractFailures.append(
                    QString("%1 event %2 changed value from %3 to %4")
                        .arg(direction)
                        .arg(eventIndex + 1)
                        .arg(initialValue)
                        .arg(spin->value()));
            }
            if (!focusAnchor->hasFocus() || spin->hasFocus()) {
                contractFailures.append(
                    QString("%1 event %2 stole prior input focus")
                        .arg(direction)
                        .arg(eventIndex + 1));
            }

            const bool pageMoved = angleDeltaY < 0
                ? scrollBar->value() > previousScrollPosition
                : scrollBar->value() < previousScrollPosition;
            if (!pageMoved) {
                contractFailures.append(
                    QString("%1 event %2 did not scroll the containing page")
                        .arg(direction)
                        .arg(eventIndex + 1));
            }
        }
    };

    observeDirection(-120, QStringLiteral("down-wheel"));
    observeDirection(120, QStringLiteral("up-wheel"));

    QVERIFY2(contractFailures.isEmpty(),
             qPrintable(QString("Unfocused wheel contract failures for %1: %2")
                            .arg(objectName, contractFailures.join("; "))));
}

void TestMainWindow::testSpinBoxWheelTargetsHaveStableNames_data() {
    addSpinBoxWheelContractRows();
}

void TestMainWindow::testSpinBoxWheelTargetsHaveStableNames() {
    QFETCH(QString, objectName);
    QFETCH(int, initialValue);
    Q_UNUSED(initialValue);

    auto *spin = versus::ui::MainWindowTestAccess::wheelContractSpinBox(
        *window_, objectName);
    QVERIFY2(spin != nullptr,
             qPrintable(QString("Missing spin box %1").arg(objectName)));
    QCOMPARE(spin->objectName(), objectName);
}

void TestMainWindow::testFocusedSpinBoxesUseNativeWheel_data() {
    addSpinBoxWheelContractRows();
}

void TestMainWindow::testFocusedSpinBoxesUseNativeWheel() {
    QFETCH(QString, objectName);
    QFETCH(int, initialValue);

    auto *advancedToggle = versus::ui::MainWindowTestAccess::advancedToggle(*window_);
    QVERIFY(advancedToggle != nullptr);
    advancedToggle->setChecked(true);

    window_->resize(window_->minimumSize());
    window_->show();
    QCoreApplication::processEvents();

    auto *scrollArea = window_->findChild<QScrollArea *>();
    QVERIFY(scrollArea != nullptr);
    auto *scrollBar = scrollArea->verticalScrollBar();
    QVERIFY(scrollBar != nullptr);
    QVERIFY2(scrollBar->maximum() > scrollBar->minimum(),
             "The advanced form must overflow so wheel ownership is observable");

    auto *spin = versus::ui::MainWindowTestAccess::wheelContractSpinBox(
        *window_, objectName);
    QVERIFY2(spin != nullptr,
             qPrintable(QString("Missing spin box %1").arg(objectName)));

    spin->setEnabled(true);
    spin->setValue(initialValue);
    spin->setFocus(Qt::MouseFocusReason);
    QCoreApplication::processEvents();
    QVERIFY2(spin->hasFocus(),
             qPrintable(QString("Could not deliberately focus %1").arg(objectName)));

    QVERIFY2(positionWheelTarget(scrollArea, spin),
             qPrintable(QString("Could not position focused %1 under the wheel coordinate")
                            .arg(objectName)));
    const int initialScrollPosition = scrollBar->value();
    QVERIFY(initialScrollPosition > scrollBar->minimum());
    QVERIFY(initialScrollPosition < scrollBar->maximum());

    QVERIFY(sendFocusedSpinWheelEvent(spin, 120));
    const int valueAfterUpWheel = spin->value();
    QVERIFY2(valueAfterUpWheel > initialValue,
             qPrintable(QString("Focused %1 did not preserve native up-wheel editing")
                            .arg(objectName)));
    QCOMPARE(scrollBar->value(), initialScrollPosition);

    QVERIFY(sendFocusedSpinWheelEvent(spin, -120));
    QVERIFY2(spin->value() < valueAfterUpWheel,
             qPrintable(QString("Focused %1 did not preserve native down-wheel editing")
                            .arg(objectName)));
    QCOMPARE(scrollBar->value(), initialScrollPosition);
}

void TestMainWindow::testDisabledSpinBoxesPassWheelToPage_data() {
    addSpinBoxWheelContractRows();
}

void TestMainWindow::testDisabledSpinBoxesPassWheelToPage() {
    QFETCH(QString, objectName);
    QFETCH(int, initialValue);

    auto *advancedToggle = versus::ui::MainWindowTestAccess::advancedToggle(*window_);
    QVERIFY(advancedToggle != nullptr);
    advancedToggle->setChecked(true);

    window_->resize(window_->minimumSize());
    window_->show();
    QCoreApplication::processEvents();

    auto *scrollArea = window_->findChild<QScrollArea *>();
    QVERIFY(scrollArea != nullptr);
    auto *scrollBar = scrollArea->verticalScrollBar();
    QVERIFY(scrollBar != nullptr);
    QVERIFY2(scrollBar->maximum() > scrollBar->minimum(),
             "The advanced form must overflow so disabled-control propagation is observable");

    auto *spin = versus::ui::MainWindowTestAccess::wheelContractSpinBox(
        *window_, objectName);
    QVERIFY2(spin != nullptr,
             qPrintable(QString("Missing spin box %1").arg(objectName)));

    spin->setEnabled(true);
    spin->setValue(initialValue);
    QVERIFY2(positionWheelTarget(scrollArea, spin),
             qPrintable(QString("Could not position disabled %1 under the wheel coordinate")
                            .arg(objectName)));
    spin->clearFocus();
    spin->setEnabled(false);
    window_->setFocus();
    QVERIFY(!spin->isEnabled());

    const int middleScrollPosition = scrollBar->value();
    QVERIFY(middleScrollPosition > scrollBar->minimum());
    QVERIFY(middleScrollPosition < scrollBar->maximum());
    for (int eventIndex = 0; eventIndex < 2; ++eventIndex) {
        const int previousScrollPosition = scrollBar->value();
        QVERIFY(sendWheelEvent(spin, -120));
        QCOMPARE(spin->value(), initialValue);
        QVERIFY2(scrollBar->value() > previousScrollPosition,
                 qPrintable(QString("Down-wheel event %1 over disabled %2 did not scroll the containing page")
                                .arg(eventIndex + 1)
                                .arg(objectName)));
    }

    scrollBar->setValue(middleScrollPosition);
    for (int eventIndex = 0; eventIndex < 2; ++eventIndex) {
        const int previousScrollPosition = scrollBar->value();
        QVERIFY(sendWheelEvent(spin, 120));
        QCOMPARE(spin->value(), initialValue);
        QVERIFY2(scrollBar->value() < previousScrollPosition,
                 qPrintable(QString("Up-wheel event %1 over disabled %2 did not scroll the containing page")
                                .arg(eventIndex + 1)
                                .arg(objectName)));
    }
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
