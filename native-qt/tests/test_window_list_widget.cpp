#include <QtTest/QtTest>
#include <QApplication>
#include <QListWidget>
#include <QPushButton>
#include <QSignalSpy>
#include <QLabel>

#include "versus/ui/window_list_widget.h"

class TestWindowListWidget : public QObject {
    Q_OBJECT

private slots:
    void initTestCase();
    void cleanupTestCase();
    void init();
    void cleanup();

    void testInitialState();
    void testSetEmptyWindowList();
    void testSetWindowList();
    void testWindowSelection();
    void testRefreshSignal();
    void testAutoRefreshTimer();
    void testSelectionPersistence();
    void testSelectionClearsWhenWindowMissing();
    void testItemHasThumbnailWidget();

private:
    versus::ui::WindowListWidget *widget_ = nullptr;
};

void TestWindowListWidget::initTestCase() {
    // Called once before all tests
}

void TestWindowListWidget::cleanupTestCase() {
    // Called once after all tests
}

void TestWindowListWidget::init() {
    widget_ = new versus::ui::WindowListWidget();
}

void TestWindowListWidget::cleanup() {
    delete widget_;
    widget_ = nullptr;
}

void TestWindowListWidget::testInitialState() {
    QVERIFY(widget_ != nullptr);
    QVERIFY(widget_->selectedWindowId().isEmpty());

    // Find the refresh button
    auto *refreshButton = widget_->findChild<QPushButton*>();
    QVERIFY(refreshButton != nullptr);
    QCOMPARE(refreshButton->text(), QString("Refresh"));

    // Find the list widget
    auto *listWidget = widget_->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);
}

void TestWindowListWidget::testSetEmptyWindowList() {
    std::vector<versus::video::WindowInfo> emptyList;
    widget_->setWindowList(emptyList);

    auto *listWidget = widget_->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);
    QCOMPARE(listWidget->count(), 1);  // Should have placeholder message

    // Placeholder should not be selectable
    auto *item = listWidget->item(0);
    QVERIFY(item != nullptr);
    QVERIFY(!(item->flags() & Qt::ItemIsSelectable));
}

void TestWindowListWidget::testSetWindowList() {
    std::vector<versus::video::WindowInfo> windows;

    versus::video::WindowInfo win1;
    win1.id = "hwnd_123";
    win1.name = "Game Window 1";
    win1.executableName = "game1.exe";
    win1.processId = 1234;
    windows.push_back(win1);

    versus::video::WindowInfo win2;
    win2.id = "hwnd_456";
    win2.name = "Game Window 2";
    win2.executableName = "game2.exe";
    win2.processId = 5678;
    windows.push_back(win2);

    widget_->setWindowList(windows);

    auto *listWidget = widget_->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);
    QCOMPARE(listWidget->count(), 2);

    // Check first item data
    auto *item1 = listWidget->item(0);
    QCOMPARE(item1->data(Qt::UserRole).toString(), QString("hwnd_123"));

    // Check second item data
    auto *item2 = listWidget->item(1);
    QCOMPARE(item2->data(Qt::UserRole).toString(), QString("hwnd_456"));
}

void TestWindowListWidget::testWindowSelection() {
    std::vector<versus::video::WindowInfo> windows;

    versus::video::WindowInfo win1;
    win1.id = "hwnd_123";
    win1.name = "Game Window 1";
    win1.executableName = "game1.exe";
    windows.push_back(win1);

    widget_->setWindowList(windows);

    QSignalSpy spy(widget_, &versus::ui::WindowListWidget::windowSelected);
    QVERIFY(spy.isValid());

    auto *listWidget = widget_->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);

    // Simulate click on first item
    auto *item = listWidget->item(0);
    emit listWidget->itemClicked(item);

    QCOMPARE(spy.count(), 1);
    QList<QVariant> arguments = spy.takeFirst();
    QCOMPARE(arguments.at(0).toString(), QString("hwnd_123"));
    QCOMPARE(widget_->selectedWindowId(), QString("hwnd_123"));
}

void TestWindowListWidget::testRefreshSignal() {
    QSignalSpy spy(widget_, &versus::ui::WindowListWidget::refreshRequested);
    QVERIFY(spy.isValid());

    auto *refreshButton = widget_->findChild<QPushButton*>();
    QVERIFY(refreshButton != nullptr);

    QTest::mouseClick(refreshButton, Qt::LeftButton);

    QCOMPARE(spy.count(), 1);
}

void TestWindowListWidget::testAutoRefreshTimer() {
    QSignalSpy spy(widget_, &versus::ui::WindowListWidget::autoRefreshRequested);
    QVERIFY(spy.isValid());

    // Auto-refresh is enabled by default with 3 second interval
    // Wait for one tick
    QTest::qWait(3100);

    QVERIFY(spy.count() >= 1);
}

void TestWindowListWidget::testSelectionPersistence() {
    std::vector<versus::video::WindowInfo> windows;

    versus::video::WindowInfo win1;
    win1.id = "hwnd_123";
    win1.name = "Game Window 1";
    win1.executableName = "game1.exe";
    windows.push_back(win1);

    versus::video::WindowInfo win2;
    win2.id = "hwnd_456";
    win2.name = "Game Window 2";
    win2.executableName = "game2.exe";
    windows.push_back(win2);

    widget_->setWindowList(windows);

    // Select the first window
    auto *listWidget = widget_->findChild<QListWidget*>();
    emit listWidget->itemClicked(listWidget->item(0));
    QCOMPARE(widget_->selectedWindowId(), QString("hwnd_123"));

    // Refresh the list (simulating auto-refresh)
    widget_->setWindowList(windows);

    // Selection should be preserved
    QCOMPARE(widget_->selectedWindowId(), QString("hwnd_123"));
}

void TestWindowListWidget::testSelectionClearsWhenWindowMissing() {
    std::vector<versus::video::WindowInfo> windows;
    versus::video::WindowInfo win1;
    win1.id = "hwnd_123";
    win1.name = "Game Window 1";
    win1.executableName = "game1.exe";
    windows.push_back(win1);

    widget_->setWindowList(windows);

    auto *listWidget = widget_->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);
    emit listWidget->itemClicked(listWidget->item(0));
    QCOMPARE(widget_->selectedWindowId(), QString("hwnd_123"));

    std::vector<versus::video::WindowInfo> differentWindows;
    versus::video::WindowInfo win2;
    win2.id = "hwnd_999";
    win2.name = "Different Window";
    win2.executableName = "other.exe";
    differentWindows.push_back(win2);

    widget_->setWindowList(differentWindows);
    QVERIFY(widget_->selectedWindowId().isEmpty());
}

void TestWindowListWidget::testItemHasThumbnailWidget() {
    std::vector<versus::video::WindowInfo> windows;
    versus::video::WindowInfo win1;
    win1.id = "invalid_hwnd";
    win1.name = "Thumbnail Test Window";
    win1.executableName = "thumb.exe";
    windows.push_back(win1);

    widget_->setWindowList(windows);

    auto *listWidget = widget_->findChild<QListWidget*>();
    QVERIFY(listWidget != nullptr);
    QCOMPARE(listWidget->count(), 1);

    QWidget *itemWidget = listWidget->itemWidget(listWidget->item(0));
    QVERIFY(itemWidget != nullptr);

    auto *thumbnail = itemWidget->findChild<QLabel*>("thumbnail");
    QVERIFY(thumbnail != nullptr);
    QVERIFY(!thumbnail->pixmap().isNull());
    QCOMPARE(thumbnail->property("hasThumbnail").toBool(), false);
}

QTEST_MAIN(TestWindowListWidget)
#include "test_window_list_widget.moc"
