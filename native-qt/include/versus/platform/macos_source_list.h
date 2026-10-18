#pragma once

#include <QListWidget>
#include <QWidget>

namespace versus::platform {

// Distinct metaobjects keep these interfaces separate from Qt's synthesized
// Cocoa table cells, whose identities can be retired during row refreshes.
class MacSourceList final : public QListWidget {
    Q_OBJECT
public:
    using QListWidget::QListWidget;
};

class MacSourceRow final : public QWidget {
    Q_OBJECT
public:
    MacSourceRow(QListWidget *list, QString sourceId);
    void selectSource();
    bool sourceHasFocus() const;
private:
    QListWidget *list_;
    QString sourceId_;
};

QListWidget *createMacSourceList(QWidget *parent);
void notifyMacSourceSelection(QWidget *row);

} // namespace versus::platform
