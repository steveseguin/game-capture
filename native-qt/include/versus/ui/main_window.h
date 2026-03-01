#pragma once

#include <QMainWindow>
#include <QLabel>
#include <QPushButton>
#include <QLineEdit>
#include <QComboBox>
#include <QSpinBox>
#include <QProgressBar>
#include <QCheckBox>
#include <QSystemTrayIcon>
#include <QMenu>
#include <QTimer>
#include <QCloseEvent>
#include <QIcon>

#include "versus/app/versus_app.h"
#include "versus/ui/window_list_widget.h"
#include "versus/ui/stats_panel.h"

namespace versus::ui {

class MainWindow : public QMainWindow {
    Q_OBJECT

  public:
    struct ParsedStreamTarget {
        QString streamId;
        QString room;
        QString password;
        bool valid = false;
        bool isUrl = false;
    };

    explicit MainWindow(versus::app::VersusApp *core, QWidget *parent = nullptr);
    ~MainWindow() override;
    static ParsedStreamTarget parseStreamTargetInput(const QString &input);

  public slots:
    void updateStats(const StreamStats &stats);

  private slots:
    void onWindowSelected(const QString &windowId);
    void onRefreshWindows();
    void onGoLiveClicked();
    void onTrayIconActivated(QSystemTrayIcon::ActivationReason reason);
    void onStatsTimer();
    void onBitratePresetChanged(int index);
    void onAdvancedToggleChanged(bool checked);

  private:
    void setupUI();
    void setupMenuBar();
    void setupTrayIcon();
    void applyDarkTheme();
    void updateStatus(const QString &text, const QString &statusClass);
    void updateGoLiveButton();
    void refreshWindowList();
    void refreshSelectedWindowPreview();
    void syncCodecUiState();
    int selectedBitrateKbps() const;
    void updateTrayLiveIndicator(bool live);
    void closeEvent(QCloseEvent *event) override;

    versus::app::VersusApp *core_ = nullptr;

    // UI Components
    WindowListWidget *windowListWidget_ = nullptr;
    QLineEdit *streamIdInput_ = nullptr;
    QLineEdit *roomInput_ = nullptr;
    QLineEdit *passwordInput_ = nullptr;
    QLineEdit *labelInput_ = nullptr;
    QCheckBox *advancedToggle_ = nullptr;
    QWidget *advancedPanel_ = nullptr;
    QComboBox *resolutionSelect_ = nullptr;
    QComboBox *fpsSelect_ = nullptr;
    QComboBox *bitrateSelect_ = nullptr;
    QSpinBox *customBitrateSpin_ = nullptr;
    QSpinBox *viewerLimitSpin_ = nullptr;
    QCheckBox *remoteControlCheck_ = nullptr;
    QLineEdit *remoteControlTokenInput_ = nullptr;
    QComboBox *encoderSelect_ = nullptr;
    QComboBox *codecSelect_ = nullptr;
    QCheckBox *alphaWorkflowCheck_ = nullptr;
    QLineEdit *ffmpegPathInput_ = nullptr;
    QLineEdit *ffmpegOptionsInput_ = nullptr;
    QLabel *statusLabel_ = nullptr;
    QLabel *shareLabel_ = nullptr;
    QPushButton *copyShareLinkButton_ = nullptr;
    QPushButton *openShareLinkButton_ = nullptr;
    QLabel *previewLabel_ = nullptr;
    QLabel *audioLevelLabel_ = nullptr;
    QProgressBar *audioMeter_ = nullptr;
    QLabel *encoderStatusLabel_ = nullptr;
    QPushButton *goLiveButton_ = nullptr;
    StatsPanel *statsPanel_ = nullptr;

    // System tray
    QSystemTrayIcon *trayIcon_ = nullptr;
    QIcon trayBaseIcon_;
    QMenu *trayMenu_ = nullptr;
    QAction *showHideAction_ = nullptr;
    QAction *goLiveAction_ = nullptr;
    QAction *goLiveMenuAction_ = nullptr;
    QAction *copyShareLinkAction_ = nullptr;
    QAction *copyShareLinkTrayAction_ = nullptr;
    QAction *openShareLinkAction_ = nullptr;
    QAction *openShareLinkTrayAction_ = nullptr;
    QAction *minimizeToTrayOnCloseAction_ = nullptr;

    // Stats timer
    QTimer *statsTimer_ = nullptr;
    QTimer *previewTimer_ = nullptr;

    // State
    bool isLive_ = false;
    bool stopInProgress_ = false;
    bool reconnectNoticeActive_ = false;
    bool quitRequested_ = false;
    bool minimizeToTrayOnClose_ = true;
    QString selectedWindowId_;
};

}  // namespace versus::ui
