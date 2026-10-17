// Isolated Qt object-lifetime gate. This is not packaged application testing.
#include "versus/platform/macos_audio_choices.h"
#include <QAbstractItemView>
#include <QAccessible>
#include <QApplication>
#include <QComboBox>
#include <QCoreApplication>
#include <QEvent>
#include <QPointer>
#include <QStandardItemModel>
#include <cstdio>
#include <cstdlib>

static void require(bool value, const char *message) {
    if (!value) { std::fprintf(stderr, "%s\n", message); std::abort(); }
}
static QAccessibleInterface *row(QComboBox &combo, int index) {
    auto *view = QAccessible::queryAccessibleInterface(combo.view());
    require(view != nullptr, "Missing accessible view");
    return view->child(index);
}
static void press(QAccessibleInterface *item) {
    require(item && item->actionInterface(), "Missing row action");
    item->actionInterface()->doAction(QAccessibleActionInterface::pressAction());
}
int main(int argc, char **argv) {
    QApplication application(argc, argv);
    QComboBox combo;
    versus::platform::configureMacComboChoices(&combo);
    combo.addItems({"first", "second", "third"});
    combo.show();
    combo.showPopup();
    application.processEvents();
    auto *old = row(combo, 1);
    require(old && old->isValid(), "Initial row invalid");
    const auto oldId = QAccessible::uniqueId(old);
    QPointer<QObject> oldObject = old->object();
    require(oldObject, "Row must have an owned object");
    combo.clear();
    combo.addItems({"replacement-first", "replacement-second"});
    require(!old->isValid(), "Removed row remains valid");
    press(old);
    require(combo.currentIndex() == 0, "Stale action selected a replacement row");
    require(row(combo, 1)->isValid(), "Replacement row missing");
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    require(!oldObject, "Invalid row object retained after deferred deletion");
    require(!QAccessible::accessibleInterface(oldId), "Deleted row remains in accessibility cache");
    for (int iteration = 0; iteration < 100; ++iteration) {
        combo.clear();
        combo.addItems({"a", "b", "c"});
        require(row(combo, 2)->isValid(), "Refreshed row missing");
        QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
        require(combo.view()->findChildren<QObject *>(QString(), Qt::FindDirectChildrenOnly).size() < 16,
                "Invalid rows accumulate across refreshes");
    }
    QStandardItemModel replacement;
    replacement.appendRow(new QStandardItem("new-model-first"));
    replacement.appendRow(new QStandardItem("new-model-second"));
    auto *beforeModelChange = row(combo, 1);
    QPointer<QObject> beforeModelObject = beforeModelChange->object();
    combo.setModel(&replacement);
    require(!beforeModelChange->isValid(), "Old model row remains valid");
    press(beforeModelChange);
    require(combo.currentIndex() == 0, "Old model action changed the replacement model");
    require(row(combo, 1)->isValid(), "New model row missing");
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    require(!beforeModelObject, "Old model row was not retired");
    combo.showPopup();
    application.processEvents();
    replacement.item(1)->setFlags(Qt::ItemIsEnabled);
    press(row(combo, 1));
    require(combo.currentIndex() == 0, "Non-selectable item was selected");
    replacement.item(1)->setFlags(Qt::ItemIsEnabled | Qt::ItemIsSelectable);
    press(row(combo, 1));
    require(combo.currentIndex() == 1, "Enabled row did not commit");
    // Emitting selection signals can replace the view and destroy its row.
    auto *victim = new QComboBox;
    versus::platform::configureMacComboChoices(victim);
    victim->addItems({"keep", "destroy"});
    victim->show();
    victim->showPopup();
    application.processEvents();
    auto *destroyRow = row(*victim, 1);
    QPointer<QObject> destroyedObject = destroyRow->object();
    bool replaced = false;
    QObject::connect(victim, &QComboBox::currentIndexChanged, &application,
                     [victim, &replaced](int) {
        if (!replaced) {
            replaced = true;
            versus::platform::configureMacComboChoices(victim);
        }
    });
    press(destroyRow);
    require(replaced && !destroyedObject, "Selection did not replace the view and retire its row");
    require(victim->currentIndex() == 1, "Reentrant view replacement changed the selection");
    delete victim;
    std::puts("Passed: stale rows, 100 model resets, model replacement, flags and reentrant view replacement gates");
}
