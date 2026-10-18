#include "versus/platform/macos_source_list.h"

#include <QAccessible>
#include <QAccessibleWidget>
#include <QItemSelectionModel>
#include <mutex>

namespace versus::platform {
namespace {
class SourceRowAccessible final : public QAccessibleWidget {
public:
    explicit SourceRowAccessible(MacSourceRow *row)
        : QAccessibleWidget(row, QAccessible::RadioButton) {}
    int childCount() const override { return 0; }
    QAccessibleInterface *child(int) const override { return nullptr; }
    QAccessibleInterface *childAt(int, int) const override { return nullptr; }
    QAccessible::State state() const override {
        auto result = QAccessibleWidget::state();
        result.checkable = true;
        result.checked = widget()->property("selectedSource").toBool();
        result.selected = result.checked;
        result.focusable = true;
        result.focused = result.checked && static_cast<MacSourceRow *>(widget())->sourceHasFocus();
        return result;
    }
    QStringList actionNames() const override { return {toggleAction()}; }
    void doAction(const QString &action) override {
        if (action == toggleAction() || action == pressAction())
            static_cast<MacSourceRow *>(widget())->selectSource();
    }
};

class SourceListAccessible final : public QAccessibleWidget {
public:
    explicit SourceListAccessible(MacSourceList *list)
        : QAccessibleWidget(list, QAccessible::List) {}
    QList<QWidget *> rows() const {
        QList<QWidget *> result;
        auto *list = static_cast<MacSourceList *>(widget());
        for (int index = 0; index < list->count(); ++index) {
            auto *item = list->item(index);
            // Keep model indices stable for Qt focus/selection events. Hidden
            // row widgets report an invisible state and Cocoa omits them.
            if (auto *row = list->itemWidget(item)) result.append(row);
        }
        return result;
    }
    int childCount() const override { return rows().size(); }
    QString text(QAccessible::Text kind) const override {
        if (kind == QAccessible::Description) {
            auto *list = static_cast<MacSourceList *>(widget());
            for (int index = 0; index < list->count(); ++index)
                if (!list->item(index)->isHidden() && list->itemWidget(list->item(index)))
                    return QAccessibleWidget::text(kind);
            if (list->count() == 1 && !list->itemWidget(list->item(0)))
                return list->item(0)->text();
            return QStringLiteral("No capture sources match the filter.");
        }
        return QAccessibleWidget::text(kind);
    }
    QAccessibleInterface *child(int index) const override {
        const auto visible = rows();
        return index >= 0 && index < visible.size()
            ? QAccessible::queryAccessibleInterface(visible[index]) : nullptr;
    }
    int indexOfChild(const QAccessibleInterface *child) const override {
        return child ? rows().indexOf(qobject_cast<QWidget *>(child->object())) : -1;
    }
    QAccessibleInterface *childAt(int x, int y) const override {
        for (int index = 0; index < childCount(); ++index)
            if (auto *row = child(index); row && row->rect().contains(x, y)) return row;
        return nullptr;
    }
    QAccessibleInterface *focusChild() const override {
        for (int index = 0; index < childCount(); ++index)
            if (auto *row = child(index); row && row->state().checked) return row;
        return nullptr;
    }
};

QAccessibleInterface *factory(const QString &, QObject *object) {
    if (auto *list = qobject_cast<MacSourceList *>(object)) return new SourceListAccessible(list);
    if (auto *row = qobject_cast<MacSourceRow *>(object)) return new SourceRowAccessible(row);
    return nullptr;
}
} // namespace

QListWidget *createMacSourceList(QWidget *parent) {
    static std::once_flag installed;
    std::call_once(installed, [] { QAccessible::installFactory(factory); });
    return new MacSourceList(parent);
}

MacSourceRow::MacSourceRow(QListWidget *list, QString sourceId)
    : list_(list), sourceId_(std::move(sourceId)) {}

bool MacSourceRow::sourceHasFocus() const { return list_->hasFocus(); }

void MacSourceRow::selectSource() {
    if (!isEnabled() || !list_->isEnabled()) return;
    for (int index = 0; index < list_->count(); ++index) {
        auto *item = list_->item(index);
        if (!item->isHidden() && item->data(Qt::UserRole).toString() == sourceId_) {
            // Source selection is idempotent, including an already selected row.
            list_->setCurrentItem(item, QItemSelectionModel::ClearAndSelect);
            list_->scrollToItem(item);
            list_->setFocus(Qt::OtherFocusReason);
            return;
        }
    }
}

void notifyMacSourceSelection(QWidget *row) {
    QAccessible::State changed;
    changed.checked = true;
    QAccessibleStateChangeEvent event(row, changed);
    QAccessible::updateAccessibility(&event);
}
} // namespace versus::platform
