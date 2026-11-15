#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "versus/audio/window_audio_capture_core.h"

namespace versus::audio {

enum class AudioSampleEncoding {
    PcmSigned,
    Float
};

struct AudioSampleFormat {
    AudioSampleEncoding encoding = AudioSampleEncoding::Float;
    uint16_t containerBits = 32;
    uint16_t validBits = 32;
};

bool isSupportedAudioSampleFormat(const AudioSampleFormat &format);

bool convertInterleavedAudioToFloat(const uint8_t *data,
                                    size_t sampleCount,
                                    const AudioSampleFormat &format,
                                    std::vector<float> &converted);

// One state per capture stream. Retains interpolation phase across packet boundaries.
struct AudioResamplerState {
    uint32_t sampleRate = 0;
    uint32_t channels = 0;
    uint64_t framesSeen = 0;
    uint64_t nextOutputNumerator = 0;
    uint32_t outputChannels = 2;
    std::vector<float> previousFrame;
};

// Output is 48 kHz stereo, or the first six input channel slots with zero padding.
// Mono duplicates into the first two slots. Streaming callers must supply state.
std::vector<float> normalizeAudioForOpus(const StreamChunk &chunk,
                                        AudioResamplerState *state = nullptr,
                                        uint32_t outputChannels = 2);

}  // namespace versus::audio
