#include "versus/audio/opus_encoder.h"

#include <opus.h>
#include <opus_multistream.h>
#include <spdlog/spdlog.h>

#include <type_traits>

#include <algorithm>
#include <cstdlib>
#include <vector>

namespace versus::audio {

struct OpusEncoder::Impl {
    ::OpusEncoder *encoder = nullptr;
    ::OpusMSEncoder *multistream = nullptr;
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
    shutdown();
    if (config.bitrate < 6 || config.bitrate > 510 ||
        (config.channels != 1 && config.channels != 2 && config.channels != 6) ||
        config.outputChannels < 0 || config.outputChannels > config.channels ||
        (config.channels == 6 && config.outputChannels != 0 && config.outputChannels != 6) ||
        (config.packetDurationMs != 5 && config.packetDurationMs != 10)) {
        return false;
    }
    config_ = config;

    int error = 0;
    if (config.channels == 6) {
        // Match VDO.Ninja multiopus. Use the same mapping at each end to retain
        // device channel order, without applying surround/LFE filtering.
        constexpr unsigned char mapping[] = {0, 4, 1, 2, 3, 5};
        impl_->multistream = opus_multistream_encoder_create(config.sampleRate, 6, 4, 2,
            mapping, OPUS_APPLICATION_AUDIO, &error);
        if (!impl_->multistream || error != OPUS_OK ||
            opus_multistream_encoder_ctl(impl_->multistream, OPUS_SET_BITRATE(config.bitrate * 1000)) != OPUS_OK ||
            opus_multistream_encoder_ctl(impl_->multistream, OPUS_SET_VBR(0)) != OPUS_OK) {
            spdlog::error("Failed to initialize six-channel Opus encoder: {}", opus_strerror(error));
            shutdown();
            return false;
        }
        impl_->sampleRate = config.sampleRate;
        impl_->channels = config.channels;
        initialized_ = true;
        return true;
    }
    impl_->encoder = opus_encoder_create(config.sampleRate, config.channels, OPUS_APPLICATION_AUDIO, &error);
    if (!impl_->encoder || error != OPUS_OK) {
        spdlog::error("Failed to init Opus encoder: {}", opus_strerror(error));
        return false;
    }

    const int bitrateResult = opus_encoder_ctl(impl_->encoder, OPUS_SET_BITRATE(config.bitrate * 1000));
    const int vbrResult = opus_encoder_ctl(impl_->encoder, OPUS_SET_VBR(0));
    const int channelsResult = opus_encoder_ctl(
        impl_->encoder, OPUS_SET_FORCE_CHANNELS(config.outputChannels == 0 ? OPUS_AUTO : config.outputChannels));
    if (bitrateResult != OPUS_OK || vbrResult != OPUS_OK || channelsResult != OPUS_OK) {
        spdlog::error("Failed to configure Opus encoder: bitrate={}, vbr={}, channels={}",
                      bitrateResult, vbrResult, channelsResult);
        shutdown();
        return false;
    }
    impl_->sampleRate = config.sampleRate;
    impl_->channels = config.channels;
    impl_->pendingSamples.clear();
    impl_->pendingPts = 0;
    initialized_ = true;
    return true;
}

bool OpusEncoder::setBitrate(int kbps) {
    if (!initialized_ || (!impl_->encoder && !impl_->multistream)) {
        return false;
    }

    const int clamped = std::clamp(kbps, 6, 510);
    const int result = impl_->multistream
        ? opus_multistream_encoder_ctl(impl_->multistream, OPUS_SET_BITRATE(clamped * 1000))
        : opus_encoder_ctl(impl_->encoder, OPUS_SET_BITRATE(clamped * 1000));
    if (result != OPUS_OK) {
        spdlog::error("Failed to set Opus bitrate to {} kbps: {}", clamped, opus_strerror(result));
        return false;
    }
    config_.bitrate = clamped;
    return true;
}

void OpusEncoder::shutdown() {
    if (impl_ && impl_->multistream) {
        opus_multistream_encoder_destroy(impl_->multistream);
        impl_->multistream = nullptr;
    }
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
    if (!initialized_ || (!impl_->encoder && !impl_->multistream) || !packetCallback_) {
        return false;
    }

    if (sampleRate != impl_->sampleRate || channels != impl_->channels || samples.size() % channels != 0) {
        spdlog::warn("Opus encoder format mismatch: {}Hz {}ch", sampleRate, channels);
        return false;
    }

    const int64_t pendingEnd = impl_->pendingPts +
        static_cast<int64_t>(impl_->pendingSamples.size() / channels) * 10000000LL / sampleRate;
    if (!impl_->pendingSamples.empty() && std::abs(pts - pendingEnd) > 10000) {
        // Do not append samples captured after a pause to an old partial packet.
        impl_->pendingSamples.clear();
        if (impl_->multistream) opus_multistream_encoder_ctl(impl_->multistream, OPUS_RESET_STATE);
        else opus_encoder_ctl(impl_->encoder, OPUS_RESET_STATE);
    }
    if (impl_->pendingSamples.empty()) {
        impl_->pendingPts = pts;
    }
    impl_->pendingSamples.insert(impl_->pendingSamples.end(), samples.begin(), samples.end());

    const int frameSize = sampleRate * config_.packetDurationMs / 1000;
    const size_t frameSamples = static_cast<size_t>(frameSize) * static_cast<size_t>(channels);
    size_t offset = 0;

    while (impl_->pendingSamples.size() - offset >= frameSamples) {
        const float *framePtr = impl_->pendingSamples.data() + offset;
        std::vector<uint8_t> encoded(4000);
        int bytes = impl_->multistream
            ? opus_multistream_encode_float(impl_->multistream, framePtr, frameSize, encoded.data(), static_cast<int>(encoded.size()))
            : opus_encode_float(impl_->encoder, framePtr, frameSize, encoded.data(), static_cast<int>(encoded.size()));
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
        packet.channels = impl_->multistream ? 6 : opus_packet_get_nb_channels(packet.data.data());
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
