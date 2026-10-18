#include "versus/platform/macos_audio_choices.h"

#include <QAccessibleObject>
#include <QAccessibleWidget>
#include <QComboBox>
#include <QListView>
#include <QPersistentModelIndex>
#include <QPointer>
#include <mutex>

namespace versus::platform {

class AudioChoice final : public QObject {
    Q_OBJECT
public:
    AudioChoice(QListView *view, QComboBox *combo, QModelIndex index)
        : QObject(view), view(view), combo(combo), index(index) {}
    QPointer<QListView> view;
    QPointer<QComboBox> combo;
    QPersistentModelIndex index;
};

class AudioChoiceView final : public QListView {
    Q_OBJECT
public:
    explicit AudioChoiceView(QComboBox *combo) : QListView(combo), combo_(combo) {}
    QList<AudioChoice *> choices() {
        // Model resets/removals invalidate persistent indices. Retire their
        // owned objects outside the current AX query, rather than accumulating
        // stale rows as device lists refresh. Old references remain inert.
        for (auto it = choices_.begin(); it != choices_.end();) {
            const auto &index = (*it)->index;
            if (!index.isValid() || index.model() != model() ||
                index.parent() != rootIndex() || index.column() != modelColumn()) {
                (*it)->deleteLater();
                it = choices_.erase(it);
            } else {
                ++it;
            }
        }
        if (model()) {
            for (int row = 0; row < model()->rowCount(rootIndex()); ++row) {
                const auto index = model()->index(row, modelColumn(), rootIndex());
                bool found = false;
                for (auto *choice : choices_) if (choice->index == index) found = true;
                if (!found) choices_.append(new AudioChoice(this, combo_, index));
            }
        }
        QList<AudioChoice *> valid;
        for (auto *choice : choices_) if (choice->index.isValid()) valid.append(choice);
        return valid;
    }
private:
    QComboBox *combo_;
    QList<AudioChoice *> choices_;
};

class AudioChoiceAccessible final : public QAccessibleObject, public QAccessibleActionInterface {
public:
    explicit AudioChoiceAccessible(AudioChoice *choice) : QAccessibleObject(choice) {}
    AudioChoice *choice() const { return static_cast<AudioChoice *>(object()); }
    bool isValid() const override {
        const auto *c = choice();
        return c && c->view && c->combo && c->index.isValid()
            && c->index.model() == c->view->model()
            && c->index.parent() == c->view->rootIndex()
            && c->index.column() == c->view->modelColumn();
    }
    QAccessibleInterface *parent() const override {
        return isValid() ? QAccessible::queryAccessibleInterface(choice()->view) : nullptr;
    }
    int childCount() const override { return 0; }
    QAccessibleInterface *child(int) const override { return nullptr; }
    int indexOfChild(const QAccessibleInterface *) const override { return -1; }
    QAccessible::Role role() const override { return QAccessible::ListItem; }
    QString text(QAccessible::Text kind) const override {
        return isValid() && kind == QAccessible::Name ? choice()->index.data().toString() : QString();
    }
    QRect rect() const override {
        if (!isValid()) return {};
        const auto *c = choice();
        auto rect = c->view->visualRect(c->index);
        rect.translate(c->view->viewport()->mapToGlobal(QPoint()));
        return rect;
    }
    QAccessible::State state() const override {
        QAccessible::State result;
        result.invalid = !isValid();
        if (result.invalid) return result;
        const auto *c = choice();
        result.disabled = !c->combo->isEnabled() || !(c->index.flags() & Qt::ItemIsEnabled)
            || !(c->index.flags() & Qt::ItemIsSelectable);
        result.invisible = !c->view->isVisible();
        result.offscreen = !c->view->viewport()->rect().intersects(c->view->visualRect(c->index));
        result.selectable = !result.disabled;
        result.focusable = !result.disabled;
        result.selected = c->combo->currentIndex() == c->index.row();
        result.focused = c->view->hasFocus() && c->view->currentIndex() == c->index;
        return result;
    }
    void *interface_cast(QAccessible::InterfaceType type) override {
        if (type == QAccessible::ActionInterface) return static_cast<QAccessibleActionInterface *>(this);
        return QAccessibleObject::interface_cast(type);
    }
    QStringList actionNames() const override { return {toggleAction()}; }
    QStringList keyBindingsForAction(const QString &) const override { return {}; }
    void doAction(const QString &action) override {
        if ((action != toggleAction() && action != pressAction()) || !isValid()) return;
        const auto current = state();
        if (current.disabled || current.invisible) return;
        const auto *c = choice();
        const QPointer<QComboBox> combo = c->combo;
        const int row = c->index.row();
        // Selection signals may refresh the model or destroy the row/view.
        // Do not read this interface or its row after emitting those signals.
        combo->setCurrentIndex(row);
        if (combo) combo->hidePopup();
        if (combo) combo->setFocus(Qt::OtherFocusReason);
    }
};

class AudioChoiceViewAccessible final : public QAccessibleWidget {
public:
    explicit AudioChoiceViewAccessible(AudioChoiceView *view) : QAccessibleWidget(view, QAccessible::List) {}
    QList<AudioChoice *> choices() const { return static_cast<AudioChoiceView *>(widget())->choices(); }
    int childCount() const override { return choices().size(); }
    QAccessibleInterface *child(int index) const override {
        const auto rows = choices();
        return index >= 0 && index < rows.size() ? QAccessible::queryAccessibleInterface(rows[index]) : nullptr;
    }
    int indexOfChild(const QAccessibleInterface *child) const override {
        return child ? choices().indexOf(qobject_cast<AudioChoice *>(child->object())) : -1;
    }
    QAccessibleInterface *childAt(int x, int y) const override {
        for (int i = 0; i < childCount(); ++i)
            if (auto *row = child(i); row && row->rect().contains(x, y)) return row;
        return nullptr;
    }
    QAccessibleInterface *focusChild() const override {
        for (int i = 0; i < childCount(); ++i)
            if (auto *row = child(i); row && row->state().focused) return row;
        return nullptr;
    }
};

void configureMacComboChoices(QComboBox *combo) {
    static std::once_flag installed;
    std::call_once(installed, [] {
        QAccessible::installFactory([](const QString &, QObject *object) -> QAccessibleInterface * {
            if (auto *view = qobject_cast<AudioChoiceView *>(object)) return new AudioChoiceViewAccessible(view);
            if (auto *choice = qobject_cast<AudioChoice *>(object)) return new AudioChoiceAccessible(choice);
            return nullptr;
        });
    });
    combo->setView(new AudioChoiceView(combo));
}

} // namespace versus::platform

#include "audio_choices.moc"
