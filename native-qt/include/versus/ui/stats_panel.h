#pragma once

#include <QWidget>
#include <QLabel>
#include <QGridLayout>

namespace versus::ui {

struct StreamStats {
    double videoBitrate = 0.0;   // kbps
    double audioBitrate = 0.0;   // kbps
    double frameRate = 0.0;      // fps
    int width = 0;
    int height = 0;
    std::string codec;
    std::string encoder;
    double rtt = 0.0;            // ms
    int packetsLost = 0;
};

class StatsPanel : public QWidget {
    Q_OBJECT

  public:
    explicit StatsPanel(QWidget *parent = nullptr);

    void updateStats(const StreamStats &stats);
    void clear();

  private:
    void setupUI();
    void updateRttColor(double rtt);

    QLabel *videoBitrateValue_ = nullptr;
    QLabel *audioBitrateValue_ = nullptr;
    QLabel *frameRateValue_ = nullptr;
    QLabel *resolutionValue_ = nullptr;
    QLabel *codecValue_ = nullptr;
    QLabel *encoderValue_ = nullptr;
    QLabel *rttValue_ = nullptr;
};

}  // namespace versus::ui
