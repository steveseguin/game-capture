#pragma once

#include <QWidget>
#include <QListWidget>
#include <QPushButton>
#include <QTimer>
#include <QMap>
#include <QLabel>
#include <QPixmap>
#ifdef __APPLE__
#include <QLineEdit>
#endif

#include "versus/video/window_capture.h"

namespace versus::ui {

class WindowListWidget : public QWidget {
    Q_OBJECT

  public:
    explicit WindowListWidget(QWidget *parent = nullptr);

    void setWindowList(const std::vector<versus::video::WindowInfo> &windows);
    QString selectedWindowId() const;
    QString selectedWindowName() const;
    void setAutoRefreshEnabled(bool enabled);
    void requestThumbnailRefresh();
    void setHeaderText(const QString &text);
    void setEmptyText(const QString &text);
    void setSpoutModeEnabled(bool enabled);
#ifdef __APPLE__
    void setSyphonModeEnabled(bool enabled);
#endif
    void setCameraModeEnabled(bool enabled);
    void clearSelection();

  signals:
    void windowSelected(const QString &windowId);
    void refreshRequested();
    void autoRefreshRequested();

  private slots:
    void onSelectionChanged();
    void onRefreshClicked();
    void onAutoRefresh();

  private:
    void applyThumbnail(QLabel *thumbnailLabel, const versus::video::WindowInfo &window, bool forceRefresh = false);
    QString secondaryTextFor(const versus::video::WindowInfo &window) const;
    QWidget* createItemWidget(const versus::video::WindowInfo &window);
    void updateItemWidget(QWidget *widget, const versus::video::WindowInfo &window, bool forceThumbnailRefresh);
    void updateSelectionVisuals();

    QListWidget *listWidget_ = nullptr;
#ifdef __APPLE__
    QLineEdit *sourceFilter_ = nullptr;
    void applySourceFilter();
#endif
    QLabel *headerLabel_ = nullptr;
    QPushButton *refreshButton_ = nullptr;
    QTimer *autoRefreshTimer_ = nullptr;
    QString selectedWindowId_;
    QMap<QString, QListWidgetItem*> windowItems_;  // Track items by window ID
    QMap<QString, QPixmap> thumbnailCache_;
    QString emptyText_ = "No windows detected. Launch a game and click Refresh.";
    bool forceThumbnailRefreshOnNextSet_ = false;
    bool spoutModeEnabled_ = false;
#ifdef __APPLE__
    bool syphonModeEnabled_ = false;
#endif
    bool cameraModeEnabled_ = false;
};

}  // namespace versus::ui
