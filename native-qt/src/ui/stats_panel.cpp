#include "versus/ui/stats_panel.h"

#include <QVBoxLayout>

namespace versus::ui {

StatsPanel::StatsPanel(QWidget *parent)
    : QWidget(parent) {
    setupUI();
}

void StatsPanel::setupUI() {
    auto *mainLayout = new QVBoxLayout(this);
    mainLayout->setContentsMargins(0, 0, 0, 0);

    auto *titleLabel = new QLabel("Live Statistics:", this);
    QFont titleFont = titleLabel->font();
    titleFont.setBold(true);
    titleLabel->setFont(titleFont);
    mainLayout->addWidget(titleLabel);

    auto *gridLayout = new QGridLayout();
    gridLayout->setColumnStretch(0, 1);
    gridLayout->setColumnStretch(1, 1);
    gridLayout->setSpacing(4);

    auto createLabel = [this](const QString &text) {
        auto *label = new QLabel(text, this);
        label->setStyleSheet("color: #888888;");
        return label;
    };

    auto createValue = [this]() {
        auto *label = new QLabel("-", this);
        return label;
    };

    int row = 0;

    // Video Bitrate
    gridLayout->addWidget(createLabel("Video Bitrate:"), row, 0);
    videoBitrateValue_ = createValue();
    gridLayout->addWidget(videoBitrateValue_, row++, 1);

    // Audio Bitrate
    gridLayout->addWidget(createLabel("Audio Bitrate:"), row, 0);
    audioBitrateValue_ = createValue();
    gridLayout->addWidget(audioBitrateValue_, row++, 1);

    // Frame Rate
    gridLayout->addWidget(createLabel("Frame Rate:"), row, 0);
    frameRateValue_ = createValue();
    gridLayout->addWidget(frameRateValue_, row++, 1);

    // Resolution
    gridLayout->addWidget(createLabel("Resolution:"), row, 0);
    resolutionValue_ = createValue();
    gridLayout->addWidget(resolutionValue_, row++, 1);

    // Codec
    gridLayout->addWidget(createLabel("Codec:"), row, 0);
    codecValue_ = createValue();
    gridLayout->addWidget(codecValue_, row++, 1);

    // Encoder
    gridLayout->addWidget(createLabel("Encoder:"), row, 0);
    encoderValue_ = createValue();
    gridLayout->addWidget(encoderValue_, row++, 1);

    // RTT
    gridLayout->addWidget(createLabel("RTT:"), row, 0);
    rttValue_ = createValue();
    gridLayout->addWidget(rttValue_, row++, 1);

    mainLayout->addLayout(gridLayout);
}

void StatsPanel::updateStats(const StreamStats &stats) {
    videoBitrateValue_->setText(QString::number(static_cast<int>(stats.videoBitrate)) + " kbps");
    audioBitrateValue_->setText(QString::number(static_cast<int>(stats.audioBitrate)) + " kbps");
    frameRateValue_->setText(QString::number(stats.frameRate, 'f', 1) + " fps");
    resolutionValue_->setText(QString::number(stats.width) + "x" + QString::number(stats.height));
    codecValue_->setText(QString::fromStdString(stats.codec));
    encoderValue_->setText(QString::fromStdString(stats.encoder));
    rttValue_->setText(QString::number(static_cast<int>(stats.rtt)) + " ms");

    updateRttColor(stats.rtt);
}

void StatsPanel::clear() {
    videoBitrateValue_->setText("-");
    audioBitrateValue_->setText("-");
    frameRateValue_->setText("-");
    resolutionValue_->setText("-");
    codecValue_->setText("-");
    encoderValue_->setText("-");
    rttValue_->setText("-");
    rttValue_->setStyleSheet("");
}

void StatsPanel::updateRttColor(double rtt) {
    QString color;
    if (rtt > 200) {
        color = "#e63333";  // Red
    } else if (rtt > 100) {
        color = "#e6cc33";  // Yellow
    } else {
        color = "#00ba6a";  // Green
    }
    rttValue_->setStyleSheet(QString("color: %1;").arg(color));
}

}  // namespace versus::ui
