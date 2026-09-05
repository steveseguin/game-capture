#include "versus/audio/audio_format_converter.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

namespace versus::audio {

namespace {

template <typename Sample>
Sample readUnalignedSample(const uint8_t *data) {
    Sample value{};
    std::memcpy(&value, data, sizeof(value));
    return value;
}

float sanitizeFloat(float value) {
    return std::isfinite(value) ? value : 0.0f;
}

}  // namespace

bool isSupportedAudioSampleFormat(const AudioSampleFormat &format) {
    if (format.validBits == 0 || format.validBits > format.containerBits) {
        return false;
    }
    if (format.encoding == AudioSampleEncoding::Float) {
        return format.containerBits == 32 && format.validBits == 32;
    }
    return format.containerBits == 16 ||
           format.containerBits == 24 ||
           format.containerBits == 32;
}

bool convertInterleavedAudioToFloat(const uint8_t *data,
                                    size_t sampleCount,
                                    const AudioSampleFormat &format,
                                    std::vector<float> &converted) {
    converted.clear();
    if (sampleCount == 0) {
        return true;
    }
    if (!data || !isSupportedAudioSampleFormat(format)) {
        return false;
    }

    converted.resize(sampleCount);
    if (format.encoding == AudioSampleEncoding::Float) {
        for (size_t index = 0; index < sampleCount; ++index) {
            const float value = readUnalignedSample<float>(
                data + (index * sizeof(float)));
            converted[index] = sanitizeFloat(value);
        }
        return true;
    }

    if (format.containerBits == 16) {
        constexpr float kScale = 1.0f / 32768.0f;
        for (size_t index = 0; index < sampleCount; ++index) {
            const int16_t value = readUnalignedSample<int16_t>(
                data + (index * sizeof(int16_t)));
            converted[index] = static_cast<float>(value) * kScale;
        }
        return true;
    }

    if (format.containerBits == 24) {
        constexpr float kScale = 1.0f / 8388608.0f;
        const uint8_t *sample = data;
        for (size_t index = 0; index < sampleCount; ++index) {
            int32_t value =
                static_cast<int32_t>(sample[0]) |
                (static_cast<int32_t>(sample[1]) << 8) |
                (static_cast<int32_t>(sample[2]) << 16);
            if ((value & 0x00800000) != 0) {
                value |= static_cast<int32_t>(0xFF000000);
            }
            converted[index] = static_cast<float>(value) * kScale;
            sample += 3;
        }
        return true;
    }

    constexpr double kScale = 1.0 / 2147483648.0;
    for (size_t index = 0; index < sampleCount; ++index) {
        const int32_t value = readUnalignedSample<int32_t>(
            data + (index * sizeof(int32_t)));
        converted[index] = static_cast<float>(
            static_cast<double>(value) * kScale);
    }
    return true;
}

std::vector<float> normalizeAudioForOpus(const StreamChunk &chunk, AudioResamplerState *state) {
    constexpr uint32_t kOpusSampleRate = 48000;
    constexpr uint32_t kOpusChannels = 2;

    if (chunk.channels == 0 || chunk.sampleRate == 0) {
        return {};
    }

    const uint32_t inputChannels = chunk.channels;
    const uint32_t inputSampleRate = chunk.sampleRate;
    const size_t inputFrames = chunk.samples.size() / inputChannels;
    if (inputFrames == 0) {
        return {};
    }

    std::vector<float> stereo(inputFrames * kOpusChannels);
    for (size_t frame = 0; frame < inputFrames; ++frame) {
        const size_t sourceOffset = frame * inputChannels;
        float left = 0.0f;
        float right = 0.0f;
        if (inputChannels == 1) {
            left = sanitizeFloat(chunk.samples[sourceOffset]);
            right = left;
        } else if (inputChannels == 2) {
            left = sanitizeFloat(chunk.samples[sourceOffset]);
            right = sanitizeFloat(chunk.samples[sourceOffset + 1]);
        } else {
            uint32_t leftCount = 0;
            uint32_t rightCount = 0;
            for (uint32_t channel = 0; channel < inputChannels; ++channel) {
                const float sample = sanitizeFloat(
                    chunk.samples[sourceOffset + channel]);
                if ((channel % 2) == 0) {
                    left += sample;
                    leftCount++;
                } else {
                    right += sample;
                    rightCount++;
                }
            }
            left /= static_cast<float>(std::max<uint32_t>(1, leftCount));
            right /= static_cast<float>(std::max<uint32_t>(1, rightCount));
        }
        stereo[frame * kOpusChannels] = left;
        stereo[(frame * kOpusChannels) + 1] = right;
    }

    if (inputSampleRate == kOpusSampleRate) {
        if (state) *state = {};
        return stereo;
    }

    if (state) {
        if (state->sampleRate != inputSampleRate || state->channels != inputChannels) {
            *state = {};
            state->sampleRate = inputSampleRate;
            state->channels = inputChannels;
        }
        const uint64_t start = state->framesSeen;
        const uint64_t end = start + inputFrames;
        std::vector<float> output;
        output.reserve(static_cast<size_t>(inputFrames * uint64_t(kOpusSampleRate) / inputSampleRate + 2) * 2);
        while (true) {
            const uint64_t source = state->nextOutputNumerator / kOpusSampleRate;
            const uint64_t remainder = state->nextOutputNumerator % kOpusSampleRate;
            // Fractional positions need the next sample. Defer across chunks
            // instead of duplicating the final sample or resetting the phase.
            if (source >= end || (remainder != 0 && source + 1 >= end)) break;
            for (size_t channel = 0; channel < 2; ++channel) {
                const float first = source < start
                    ? (channel == 0 ? state->previousLeft : state->previousRight)
                    : stereo[(source - start) * 2 + channel];
                const float second = remainder == 0 ? first : stereo[(source + 1 - start) * 2 + channel];
                output.push_back(first + (second - first) * (static_cast<float>(remainder) / kOpusSampleRate));
            }
            state->nextOutputNumerator += inputSampleRate;
        }
        state->framesSeen = end;
        state->previousLeft = stereo[stereo.size() - 2];
        state->previousRight = stereo.back();
        return output;
    }

    const double exactOutputFrames =
        (static_cast<double>(inputFrames) * static_cast<double>(kOpusSampleRate)) /
        static_cast<double>(inputSampleRate);
    const size_t outputFrames = std::max<size_t>(
        1,
        static_cast<size_t>(std::llround(exactOutputFrames)));
    std::vector<float> resampled(outputFrames * kOpusChannels);

    const double step =
        static_cast<double>(inputSampleRate) / static_cast<double>(kOpusSampleRate);
    for (size_t frame = 0; frame < outputFrames; ++frame) {
        const double sourcePosition = static_cast<double>(frame) * step;
        const size_t sourceFrame = std::min<size_t>(
            static_cast<size_t>(sourcePosition),
            inputFrames - 1);
        const size_t nextFrame = std::min<size_t>(
            sourceFrame + 1,
            inputFrames - 1);
        const float blend = static_cast<float>(
            sourcePosition - static_cast<double>(sourceFrame));
        for (size_t channel = 0; channel < kOpusChannels; ++channel) {
            const float first = stereo[(sourceFrame * kOpusChannels) + channel];
            const float second = stereo[(nextFrame * kOpusChannels) + channel];
            resampled[(frame * kOpusChannels) + channel] =
                first + ((second - first) * blend);
        }
    }

    return resampled;
}

}  // namespace versus::audio
