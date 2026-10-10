#pragma once

#include "versus/audio/opus_encoder.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <deque>

namespace versus::audio {

// L16 uses signed 16-bit samples in network byte order (RFC 3551).
// Input is the app's 48 kHz stereo mix. Match VDO.Ninja's PCM negotiation:
// 48 kHz mono or 32 kHz stereo. Five-millisecond packets stay below the MTU.
class PcmEncoder {
  public:
    void reset(int channels) {
        channels_ = channels;
        frames_ = nextOutputTwice_ = outputFrames_ = 0;
        history_.clear();
        pending_.clear();
    }
    int sampleRate() const { return channels_ == 1 ? 48000 : 32000; }
    void encode(const std::vector<float> &samples, int64_t pts,
                const OpusEncoder::PacketCallback &callback) {
        if (samples.size() < 2) return;
        // Encoding pauses while there are no audio viewers, but the app's
        // capture clock keeps advancing. Do not bridge an old partial packet
        // or reuse its timestamp when viewers return.
        if (frames_ && (pts > expectedInputPts_ + 10000 || pts < expectedInputPts_ - 10000)) {
            reset(channels_);
        }
        if (!frames_) startPts_ = pts;
        expectedInputPts_ = pts + static_cast<int64_t>(samples.size() / 2) * 10000000LL / 48000;
        for (size_t i = 0; i + 1 < samples.size(); i += 2) {
            history_.push_front({samples[i], samples[i + 1]});
            if (history_.size() > 34) history_.pop_back();
            if (nextOutputTwice_ / 2 == frames_) {
                if (channels_ == 1) {
                    append((samples[i] + samples[i + 1]) * 0.5f);
                } else {
                    // Windowed-sinc low-pass filtering before 48 -> 32 kHz
                    // conversion prevents frequencies above 16 kHz aliasing.
                    const double fraction = (nextOutputTwice_ % 2) * 0.5;
                    double sum[2] = {}, weight = 0;
                    for (size_t tap = 0; tap < 34; ++tap) {
                        const double x = static_cast<double>(tap) - 16.0 + fraction;
                        if (std::abs(x) >= 17.0) continue;
                        constexpr double pi = 3.14159265358979323846;
                        const double z = x * (2.0 / 3.0);
                        const double w = (std::abs(z) < 1e-9 ? 1.0 : std::sin(pi * z) / (pi * z)) *
                                         (0.5 + 0.5 * std::cos(pi * x / 17.0));
                        weight += w;
                        if (tap < history_.size()) {
                            sum[0] += history_[tap][0] * w;
                            sum[1] += history_[tap][1] * w;
                        }
                    }
                    append(static_cast<float>(sum[0] / weight));
                    append(static_cast<float>(sum[1] / weight));
                }
                nextOutputTwice_ += channels_ == 1 ? 2 : 3;
                ++outputFrames_;
                if (pending_.size() == static_cast<size_t>(sampleRate() / 200 * channels_ * 2)) {
                    EncodedAudioPacket packet;
                    packet.data.swap(pending_);
                    packet.sampleRate = sampleRate();
                    packet.channels = channels_;
                    packet.pts = startPts_ + static_cast<int64_t>(outputFrames_ - sampleRate() / 200) *
                                             10000000LL / sampleRate();
                    callback(packet);
                }
            }
            ++frames_;
        }
    }
  private:
    void append(float sample) {
        if (!std::isfinite(sample)) sample = 0;
        const auto value = static_cast<uint16_t>(static_cast<int16_t>(
            std::clamp(std::lround(std::clamp(sample, -1.0f, 1.0f) * 32768.0f), -32768L, 32767L)));
        pending_.push_back(static_cast<uint8_t>(value >> 8));
        pending_.push_back(static_cast<uint8_t>(value));
    }
    int channels_ = 2;
    uint64_t frames_ = 0, nextOutputTwice_ = 0, outputFrames_ = 0;
    int64_t startPts_ = 0, expectedInputPts_ = 0;
    std::deque<std::array<float, 2>> history_;
    std::vector<uint8_t> pending_;
};
} // namespace versus::audio
