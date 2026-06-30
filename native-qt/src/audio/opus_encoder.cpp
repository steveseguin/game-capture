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
    // Samples that did not fill a whole Opus frame yet, carried into the next
    // encode call so arbitrarily-sized capture chunks do not drop audio.
    std::vector<float> pendingSamples;
    int64_t pendingPts = 0;
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
    impl_->pendingSamples.clear();
    impl_->pendingPts = 0;
    initialized_ = true;
    return true;
}

bool OpusEncoder::setBitrate(int kbps) {
    if (!initialized_ || !impl_->encoder) {
        return false;
    }

    const int clamped = std::clamp(kbps, 6, 510);
    const int result = opus_encoder_ctl(impl_->encoder, OPUS_SET_BITRATE(clamped * 1000));
    if (result != OPUS_OK) {
        spdlog::error("Failed to set Opus bitrate to {} kbps: {}", clamped, opus_strerror(result));
        return false;
    }
    config_.bitrate = clamped;
    return true;
}

void OpusEncoder::shutdown() {
    if (impl_ && impl_->encoder) {
        opus_encoder_destroy(impl_->encoder);
        impl_->encoder = nullptr;
    }
    if (impl_) {
        impl_->pendingSamples.clear();
        impl_->pendingPts = 0;
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

    if (impl_->pendingSamples.empty()) {
        impl_->pendingPts = pts;
    }
    impl_->pendingSamples.insert(impl_->pendingSamples.end(), samples.begin(), samples.end());

    const int frameSize = sampleRate / 100;  // 10ms
    const size_t frameSamples = static_cast<size_t>(frameSize) * static_cast<size_t>(channels);
    size_t offset = 0;

    while (impl_->pendingSamples.size() - offset >= frameSamples) {
        const float *framePtr = impl_->pendingSamples.data() + offset;
        std::vector<uint8_t> encoded(4000);
        int bytes = opus_encode_float(impl_->encoder, framePtr, frameSize, encoded.data(), static_cast<int>(encoded.size()));
        if (bytes < 0) {
            spdlog::error("Opus encode error: {}", opus_strerror(bytes));
            impl_->pendingSamples.clear();
            return false;
        }
        encoded.resize(bytes);
        EncodedAudioPacket packet;
        packet.data = std::move(encoded);
        packet.pts = impl_->pendingPts;
        packet.sampleRate = sampleRate;
        packet.channels = channels;
        packetCallback_(packet);
        offset += frameSamples;
        impl_->pendingPts += static_cast<int64_t>(frameSize) * 10000000LL / static_cast<int64_t>(sampleRate);
    }

    if (offset > 0) {
        impl_->pendingSamples.erase(impl_->pendingSamples.begin(),
                                    impl_->pendingSamples.begin() + static_cast<std::ptrdiff_t>(offset));
    }
    return true;
}

}  // namespace versus::audio
