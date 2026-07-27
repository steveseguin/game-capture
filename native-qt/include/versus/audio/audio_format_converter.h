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

std::vector<float> normalizeAudioForOpus(const StreamChunk &chunk);

}  // namespace versus::audio
