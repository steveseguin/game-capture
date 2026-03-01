#pragma once

#include <QWidget>
#include <QListWidget>
#include <QPushButton>
#include <QTimer>
#include <QMap>
#include <QLabel>
#include <QPixmap>

#include "versus/video/window_capture.h"

namespace versus::ui {

class WindowListWidget : public QWidget {
    Q_OBJECT

  public:
    explicit WindowListWidget(QWidget *parent = nullptr);

    void setWindowList(const std::vector<versus::video::WindowInfo> &windows);
    QString selectedWindowId() const;
    void setAutoRefreshEnabled(bool enabled);
    void requestThumbnailRefresh();

  signals:
    void windowSelected(const QString &windowId);
    void refreshRequested();
    void autoRefreshRequested();

  private slots:
    void onItemClicked(QListWidgetItem *item);
    void onRefreshClicked();
    void onAutoRefresh();

  private:
    void applyThumbnail(QLabel *thumbnailLabel, const versus::video::WindowInfo &window, bool forceRefresh = false);
    QWidget* createItemWidget(const versus::video::WindowInfo &window);
    void updateItemWidget(QWidget *widget, const versus::video::WindowInfo &window, bool forceThumbnailRefresh);

    QListWidget *listWidget_ = nullptr;
    QPushButton *refreshButton_ = nullptr;
    QTimer *autoRefreshTimer_ = nullptr;
    QString selectedWindowId_;
    QMap<QString, QListWidgetItem*> windowItems_;  // Track items by window ID
    QMap<QString, QPixmap> thumbnailCache_;
    bool forceThumbnailRefreshOnNextSet_ = false;
};

}  // namespace versus::ui
