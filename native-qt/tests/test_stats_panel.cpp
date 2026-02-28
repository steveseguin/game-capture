#include <QtTest/QtTest>
#include <QApplication>
#include <QLabel>

#include "versus/ui/stats_panel.h"

class TestStatsPanel : public QObject {
    Q_OBJECT

private slots:
    void initTestCase();
    void cleanupTestCase();
    void init();
    void cleanup();

    void testInitialState();
    void testUpdateStats();
    void testClear();
    void testRttColorGreen();
    void testRttColorYellow();
    void testRttColorRed();

private:
    versus::ui::StatsPanel *panel_ = nullptr;
    QLabel *findLabelByText(const QString &partialText);
    QLabel *findValueLabel(int index);
};

void TestStatsPanel::initTestCase() {
    // Called once before all tests
}

void TestStatsPanel::cleanupTestCase() {
    // Called once after all tests
}

void TestStatsPanel::init() {
    panel_ = new versus::ui::StatsPanel();
}

void TestStatsPanel::cleanup() {
    delete panel_;
    panel_ = nullptr;
}

QLabel *TestStatsPanel::findLabelByText(const QString &partialText) {
    auto labels = panel_->findChildren<QLabel*>();
    for (auto *label : labels) {
        if (label->text().contains(partialText)) {
            return label;
        }
    }
    return nullptr;
}

QLabel *TestStatsPanel::findValueLabel(int index) {
    auto labels = panel_->findChildren<QLabel*>();
    // Skip title label, then get every second label (values are at odd indices in the grid)
    int valueIndex = 0;
    for (int i = 1; i < labels.size(); i += 2) {
        if (valueIndex == index) {
            return labels[i + 1];  // +1 because first label is title
        }
        valueIndex++;
    }
    return nullptr;
}

void TestStatsPanel::testInitialState() {
    QVERIFY(panel_ != nullptr);

    // Check that title label exists
    auto *titleLabel = findLabelByText("Live Statistics");
    QVERIFY(titleLabel != nullptr);
}

void TestStatsPanel::testUpdateStats() {
    versus::ui::StreamStats stats;
    stats.videoBitrate = 12000;
    stats.audioBitrate = 192;
    stats.frameRate = 60.0;
    stats.width = 1920;
    stats.height = 1080;
    stats.codec = "H.264";
    stats.encoder = "NVENC";
    stats.rtt = 45;

    panel_->updateStats(stats);

    // Find and verify video bitrate value
    auto labels = panel_->findChildren<QLabel*>();
    bool foundVideoBitrate = false;
    bool foundAudioBitrate = false;
    bool foundFrameRate = false;
    bool foundResolution = false;
    bool foundCodec = false;
    bool foundEncoder = false;
    bool foundRtt = false;

    for (auto *label : labels) {
        QString text = label->text();
        if (text.contains("12000 kbps")) foundVideoBitrate = true;
        if (text.contains("192 kbps")) foundAudioBitrate = true;
        if (text.contains("60.0 fps")) foundFrameRate = true;
        if (text.contains("1920x1080")) foundResolution = true;
        if (text == "H.264") foundCodec = true;
        if (text == "NVENC") foundEncoder = true;
        if (text.contains("45 ms")) foundRtt = true;
    }

    QVERIFY2(foundVideoBitrate, "Video bitrate not found");
    QVERIFY2(foundAudioBitrate, "Audio bitrate not found");
    QVERIFY2(foundFrameRate, "Frame rate not found");
    QVERIFY2(foundResolution, "Resolution not found");
    QVERIFY2(foundCodec, "Codec not found");
    QVERIFY2(foundEncoder, "Encoder not found");
    QVERIFY2(foundRtt, "RTT not found");
}

void TestStatsPanel::testClear() {
    // First set some stats
    versus::ui::StreamStats stats;
    stats.videoBitrate = 12000;
    stats.audioBitrate = 192;
    stats.frameRate = 60.0;
    stats.width = 1920;
    stats.height = 1080;
    stats.codec = "H.264";
    stats.encoder = "NVENC";
    stats.rtt = 45;

    panel_->updateStats(stats);

    // Now clear
    panel_->clear();

    // Check that values are reset to "-"
    auto labels = panel_->findChildren<QLabel*>();
    int dashCount = 0;
    for (auto *label : labels) {
        if (label->text() == "-") {
            dashCount++;
        }
    }

    // Should have 7 dash values (one for each stat field)
    QCOMPARE(dashCount, 7);
}

void TestStatsPanel::testRttColorGreen() {
    versus::ui::StreamStats stats;
    stats.rtt = 50;  // < 100ms should be green

    panel_->updateStats(stats);

    // Find RTT label and check its style
    auto labels = panel_->findChildren<QLabel*>();
    for (auto *label : labels) {
        if (label->text().contains("50 ms")) {
            QString style = label->styleSheet();
            QVERIFY2(style.contains("#00ba6a"), "RTT should be green for < 100ms");
            return;
        }
    }
    QFAIL("RTT label not found");
}

void TestStatsPanel::testRttColorYellow() {
    versus::ui::StreamStats stats;
    stats.rtt = 150;  // 100-200ms should be yellow

    panel_->updateStats(stats);

    // Find RTT label and check its style
    auto labels = panel_->findChildren<QLabel*>();
    for (auto *label : labels) {
        if (label->text().contains("150 ms")) {
            QString style = label->styleSheet();
            QVERIFY2(style.contains("#e6cc33"), "RTT should be yellow for 100-200ms");
            return;
        }
    }
    QFAIL("RTT label not found");
}

void TestStatsPanel::testRttColorRed() {
    versus::ui::StreamStats stats;
    stats.rtt = 250;  // > 200ms should be red

    panel_->updateStats(stats);

    // Find RTT label and check its style
    auto labels = panel_->findChildren<QLabel*>();
    for (auto *label : labels) {
        if (label->text().contains("250 ms")) {
            QString style = label->styleSheet();
            QVERIFY2(style.contains("#e63333"), "RTT should be red for > 200ms");
            return;
        }
    }
    QFAIL("RTT label not found");
}

QTEST_MAIN(TestStatsPanel)
#include "test_stats_panel.moc"
