#include "versus/audio/opus_encoder.h"

#include <opus.h>
#include <spdlog/spdlog.h>

#include <type_traits>

#include <algorithm>
#include <vector>

namespace versus::audio {

struct OpusEncoder::Impl {
    ::OpusEncoder *encoder = nullptr;
    int sampleRate = 48000;
    int channels = 2;
};

using OpusEncoderPtr = ::OpusEncoder;
static_assert(std::is_same_v<OpusEncoderPtr, ::OpusEncoder>, "Opus encoder alias");

OpusEncoder::OpusEncoder() : impl_(std::make_unique<Impl>()) {}
OpusEncoder::~OpusEncoder() { shutdown(); }

bool OpusEncoder::initialize(const AudioEncoderConfig &config) {
    config_ = config;

    int error = 0;
    impl_->encoder = opus_encoder_create(config.sampleRate, config.channels, OPUS_APPLICATION_AUDIO, &error);
    if (!impl_->encoder || error != OPUS_OK) {
        spdlog::error("Failed to init Opus encoder: {}", opus_strerror(error));
        return false;
    }

    opus_encoder_ctl(impl_->encoder, OPUS_SET_BITRATE(config.bitrate * 1000));
    opus_encoder_ctl(impl_->encoder, OPUS_SET_VBR(0));
    impl_->sampleRate = config.sampleRate;
    impl_->channels = config.channels;
    initialized_ = true;
    return true;
}

void OpusEncoder::shutdown() {
    if (impl_ && impl_->encoder) {
        opus_encoder_destroy(impl_->encoder);
        impl_->encoder = nullptr;
    }
    initialized_ = false;
}

bool OpusEncoder::encode(const std::vector<float> &samples, int sampleRate, int channels, int64_t pts) {
    if (!initialized_ || !impl_->encoder || !packetCallback_) {
        return false;
    }

    if (sampleRate != impl_->sampleRate || channels != impl_->channels) {
        spdlog::warn("Opus encoder format mismatch: {}Hz {}ch", sampleRate, channels);
        return false;
    }

    int frameSize = sampleRate / 100; // 10ms
    int totalSamples = static_cast<int>(samples.size()) / channels;
    int offset = 0;

    while (offset + frameSize <= totalSamples) {
        const float *framePtr = samples.data() + offset * channels;
        std::vector<uint8_t> encoded(4000);
        int bytes = opus_encode_float(impl_->encoder, framePtr, frameSize, encoded.data(), static_cast<int>(encoded.size()));
        if (bytes < 0) {
            spdlog::error("Opus encode error: {}", opus_strerror(bytes));
            return false;
        }
        encoded.resize(bytes);
        EncodedAudioPacket packet;
        packet.data = std::move(encoded);
        packet.pts = pts + static_cast<int64_t>(offset) * 10000000LL / static_cast<int64_t>(sampleRate);
        packet.sampleRate = sampleRate;
        packet.channels = channels;
        packetCallback_(packet);
        offset += frameSize;
    }

    return true;
}

}  // namespace versus::audio
