#include "versus/ui/window_list_widget.h"

#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QFont>
#include <QSet>
#include <QPainter>
#include <QLinearGradient>

#include "versus/video/window_capture.h"

namespace versus::ui {

WindowListWidget::WindowListWidget(QWidget *parent)
    : QWidget(parent) {
    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);

    // Header with label and refresh button
    auto *headerLayout = new QHBoxLayout();
    auto *label = new QLabel("Select Game/Window:", this);
    refreshButton_ = new QPushButton("Refresh", this);
    refreshButton_->setFixedWidth(80);

    headerLayout->addWidget(label);
    headerLayout->addStretch();
    headerLayout->addWidget(refreshButton_);
    layout->addLayout(headerLayout);

    // Window list
    listWidget_ = new QListWidget(this);
    listWidget_->setMinimumHeight(200);
    listWidget_->setSpacing(4);
    layout->addWidget(listWidget_);

    // Auto-refresh timer (3 seconds)
    autoRefreshTimer_ = new QTimer(this);
    autoRefreshTimer_->setInterval(3000);

    // Connections
    connect(listWidget_, &QListWidget::itemClicked, this, &WindowListWidget::onItemClicked);
    connect(refreshButton_, &QPushButton::clicked, this, &WindowListWidget::onRefreshClicked);
    connect(autoRefreshTimer_, &QTimer::timeout, this, &WindowListWidget::onAutoRefresh);

    // Start auto-refresh
    autoRefreshTimer_->start();
}

void WindowListWidget::applyThumbnail(QLabel *thumbnailLabel,
                                      const versus::video::WindowInfo &window,
                                      bool forceRefresh) {
    if (!thumbnailLabel) {
        return;
    }

    const QString windowId = QString::fromStdString(window.id);
    if (!forceRefresh) {
        const auto cached = thumbnailCache_.constFind(windowId);
        if (cached != thumbnailCache_.constEnd() && !cached.value().isNull()) {
            thumbnailLabel->setPixmap(cached.value());
            thumbnailLabel->setText(QString());
            thumbnailLabel->setProperty("hasThumbnail", true);
            thumbnailLabel->setProperty("thumbnailRetryCount", 0);
            return;
        }
    }

    QPixmap thumb = versus::video::WindowCapture::captureWindowThumbnail(window.id);
    if (!thumb.isNull()) {
        thumbnailLabel->setPixmap(thumb);
        thumbnailLabel->setText(QString());
        thumbnailLabel->setProperty("hasThumbnail", true);
        thumbnailLabel->setProperty("thumbnailRetryCount", 0);
        thumbnailCache_[windowId] = thumb;
        return;
    }

    QPixmap fallback(thumbnailLabel->size());
    fallback.fill(Qt::transparent);
    QPainter painter(&fallback);
    painter.setRenderHint(QPainter::Antialiasing, true);

    QLinearGradient gradient(0, 0, fallback.width(), fallback.height());
    gradient.setColorAt(0.0, QColor("#1b1b31"));
    gradient.setColorAt(1.0, QColor("#0f1020"));
    painter.setBrush(gradient);
    painter.setPen(Qt::NoPen);
    painter.drawRoundedRect(fallback.rect(), 6, 6);

    QString initials;
    const QString exe = QString::fromStdString(window.executableName).trimmed();
    if (!exe.isEmpty()) {
        initials = exe.left(1).toUpper();
    } else {
        const QString title = QString::fromStdString(window.name).trimmed();
        initials = title.isEmpty() ? "?" : title.left(1).toUpper();
    }

    painter.setPen(QColor("#96a3ff"));
    QFont font = painter.font();
    font.setBold(true);
    font.setPointSize(18);
    painter.setFont(font);
    painter.drawText(fallback.rect(), Qt::AlignCenter, initials);

    thumbnailLabel->setPixmap(fallback);
    thumbnailLabel->setText(QString());
    thumbnailLabel->setProperty("hasThumbnail", false);
    thumbnailLabel->setProperty("thumbnailRetryCount", 0);
}

QWidget* WindowListWidget::createItemWidget(const versus::video::WindowInfo &window) {
    auto *widget = new QWidget();
    widget->setObjectName("itemWidget");
    auto *itemLayout = new QHBoxLayout(widget);
    itemLayout->setContentsMargins(4, 4, 4, 4);
    itemLayout->setSpacing(8);

    // Thumbnail label
    auto *thumbnailLabel = new QLabel();
    thumbnailLabel->setObjectName("thumbnail");
    thumbnailLabel->setFixedSize(120, 68);
    thumbnailLabel->setStyleSheet("background-color: #0a0a14; border-radius: 4px;");
    thumbnailLabel->setAlignment(Qt::AlignCenter);
    applyThumbnail(thumbnailLabel, window);
    itemLayout->addWidget(thumbnailLabel);

    // Text container
    auto *textLayout = new QVBoxLayout();
    textLayout->setContentsMargins(0, 0, 0, 0);
    textLayout->setSpacing(2);

    auto *titleLabel = new QLabel(QString::fromStdString(window.name));
    titleLabel->setObjectName("title");
    QFont titleFont = titleLabel->font();
    titleFont.setPointSize(10);
    titleLabel->setFont(titleFont);
    titleLabel->setWordWrap(true);

    auto *exeLabel = new QLabel(QString::fromStdString(window.executableName));
    exeLabel->setObjectName("exe");
    QFont exeFont = exeLabel->font();
    exeFont.setPointSize(8);
    exeLabel->setFont(exeFont);
    exeLabel->setStyleSheet("color: #888888;");

    textLayout->addWidget(titleLabel);
    textLayout->addWidget(exeLabel);
    textLayout->addStretch();
    itemLayout->addLayout(textLayout, 1);

    return widget;
}

void WindowListWidget::updateItemWidget(QWidget *widget,
                                        const versus::video::WindowInfo &window,
                                        bool forceThumbnailRefresh) {
    if (auto *titleLabel = widget->findChild<QLabel*>("title")) {
        titleLabel->setText(QString::fromStdString(window.name));
    }
    if (auto *exeLabel = widget->findChild<QLabel*>("exe")) {
        exeLabel->setText(QString::fromStdString(window.executableName));
    }
    if (auto *thumbnailLabel = widget->findChild<QLabel*>("thumbnail")) {
        if (forceThumbnailRefresh) {
            applyThumbnail(thumbnailLabel, window, true);
            return;
        }

        if (thumbnailLabel->property("hasThumbnail").toBool()) {
            return;
        }

        const int retryCount = thumbnailLabel->property("thumbnailRetryCount").toInt() + 1;
        thumbnailLabel->setProperty("thumbnailRetryCount", retryCount);
        if (retryCount % 4 == 0) {
            applyThumbnail(thumbnailLabel, window);
        }
    }
}

void WindowListWidget::setWindowList(const std::vector<versus::video::WindowInfo> &windows) {
    const bool forceThumbnailRefresh = forceThumbnailRefreshOnNextSet_;
    forceThumbnailRefreshOnNextSet_ = false;
    if (forceThumbnailRefresh) {
        thumbnailCache_.clear();
    }

    // Build set of incoming window IDs
    QSet<QString> incomingIds;
    for (const auto &window : windows) {
        QString id = QString::fromStdString(window.id);
        incomingIds.insert(id);
    }

    // Handle empty state: remove placeholder if windows arrived, or add if empty
    if (windows.empty()) {
        // Clear all and show placeholder
        if (windowItems_.isEmpty() && listWidget_->count() == 1) {
            // Already showing placeholder
            return;
        }
        listWidget_->clear();
        windowItems_.clear();
        thumbnailCache_.clear();
        if (!selectedWindowId_.isEmpty()) {
            selectedWindowId_.clear();
            emit windowSelected(selectedWindowId_);
        }
        auto *item = new QListWidgetItem("No windows detected. Launch a game and click Refresh.");
        item->setFlags(item->flags() & ~Qt::ItemIsSelectable);
        item->setForeground(QColor(136, 136, 136));
        listWidget_->addItem(item);
        return;
    }

    // Remove placeholder if it exists (check if we have no tracked windows but list has an item)
    if (windowItems_.isEmpty() && listWidget_->count() > 0) {
        listWidget_->clear();
    }

    // Remove windows that no longer exist
    QList<QString> toRemove;
    for (auto it = windowItems_.begin(); it != windowItems_.end(); ++it) {
        if (!incomingIds.contains(it.key())) {
            toRemove.append(it.key());
        }
    }
    for (const QString &id : toRemove) {
        if (QListWidgetItem *item = windowItems_.value(id)) {
            int row = listWidget_->row(item);
            if (row >= 0) {
                delete listWidget_->takeItem(row);
            }
            windowItems_.remove(id);
            thumbnailCache_.remove(id);
        }
    }

    if (!selectedWindowId_.isEmpty() && !incomingIds.contains(selectedWindowId_)) {
        selectedWindowId_.clear();
        emit windowSelected(selectedWindowId_);
    }

    // Add new windows and update existing ones
    for (const auto &window : windows) {
        QString id = QString::fromStdString(window.id);

        if (windowItems_.contains(id)) {
            // Update existing item
            QListWidgetItem *item = windowItems_[id];
            if (QWidget *widget = listWidget_->itemWidget(item)) {
                updateItemWidget(widget, window, forceThumbnailRefresh);
            }
        } else {
            // Add new item
            auto *item = new QListWidgetItem();
            item->setData(Qt::UserRole, id);
            item->setSizeHint(QSize(0, 84));

            QWidget *widget = createItemWidget(window);

            listWidget_->addItem(item);
            listWidget_->setItemWidget(item, widget);
            windowItems_[id] = item;
        }
    }

    // Restore selection if it still exists
    if (!selectedWindowId_.isEmpty() && windowItems_.contains(selectedWindowId_)) {
        windowItems_[selectedWindowId_]->setSelected(true);
    }
}

QString WindowListWidget::selectedWindowId() const {
    return selectedWindowId_;
}

void WindowListWidget::setAutoRefreshEnabled(bool enabled) {
    if (enabled) {
        autoRefreshTimer_->start();
    } else {
        autoRefreshTimer_->stop();
    }
}

void WindowListWidget::requestThumbnailRefresh() {
    forceThumbnailRefreshOnNextSet_ = true;
}

void WindowListWidget::onItemClicked(QListWidgetItem *item) {
    if (!item || !(item->flags() & Qt::ItemIsSelectable)) {
        return;
    }

    selectedWindowId_ = item->data(Qt::UserRole).toString();
    emit windowSelected(selectedWindowId_);
}

void WindowListWidget::onRefreshClicked() {
    requestThumbnailRefresh();
    emit refreshRequested();
}

void WindowListWidget::onAutoRefresh() {
    emit autoRefreshRequested();
}

}  // namespace versus::ui
