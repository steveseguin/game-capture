#pragma once

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace versus::video::detail {

// The software MF encoder is configured for Baseline H.264, but does not
// serialize the color attributes describing our limited-range BT.601 input.
// Patch only SPS color metadata; preserve every coded slice and other VUI field.
inline bool tagSoftwareH264Sps(std::vector<uint8_t> &nal) {
    if (nal.size() < 5 || nal.size() > 65536 || (nal[0] & 0x9f) != 7) return false;
    std::vector<uint8_t> bits;
    unsigned zeros = 0;
    for (size_t i = 1; i < nal.size(); ++i) {
        const auto byte = nal[i];
        if (zeros == 2 && byte == 3) {
            if (i + 1 == nal.size() || nal[i + 1] > 3) return false;
            zeros = 0;
            continue;
        }
        for (int b = 7; b >= 0; --b) bits.push_back((byte >> b) & 1);
        zeros = byte == 0 ? zeros + 1 : 0;
    }
    while (!bits.empty() && bits.back() == 0) bits.pop_back();
    if (bits.empty()) return false;
    const size_t payloadEnd = bits.size() - 1; // rbsp_stop_one_bit
    size_t pos = 0;
    auto read = [&](unsigned n) {
        if (n > 32 || pos + n > payloadEnd) throw std::out_of_range("SPS");
        uint32_t value = 0;
        while (n--) value = (value << 1) | bits[pos++];
        return value;
    };
    auto ue = [&]() {
        unsigned n = 0;
        while (read(1) == 0) if (++n > 31) throw std::out_of_range("SPS ue");
        return ((uint32_t{1} << n) - 1) + read(n);
    };
    try {
        const auto profile = read(8);
        // High profiles carry additional syntax. Leave unsupported streams intact.
        if (profile != 66 && profile != 77 && profile != 88) return false;
        read(16); ue(); // constraints, level, seq_parameter_set_id
        ue(); // log2_max_frame_num_minus4
        const auto order = ue();
        if (order == 0) ue();
        else if (order == 1) {
            read(1); ue(); ue(); // signed Golomb offsets have identical lengths
            const auto cycle = ue();
            if (cycle > 255) return false;
            for (uint32_t i = 0; i < cycle; ++i) ue();
        } else if (order != 2) return false;
        ue(); read(1); ue(); ue(); // references, gaps, width, height
        if (!read(1)) read(1); // frame_mbs_only_flag / adaptive fields
        read(1); // direct_8x8_inference_flag
        if (read(1)) { ue(); ue(); ue(); ue(); } // crop
        const size_t vuiFlag = pos;
        const bool hasVui = read(1) != 0;
        size_t replaceStart = vuiFlag;
        uint32_t videoFormat = 5;
        if (hasVui) {
            if (read(1) && read(8) == 255) { read(16); read(16); }
            if (read(1)) read(1); // overscan
            replaceStart = pos;
            if (read(1)) {
                videoFormat = read(3); read(1);
                if (read(1)) { read(8); read(8); read(8); }
            }
        } else if (pos != payloadEnd) return false;
        const size_t replaceEnd = pos;
        // Validate the retained VUI suffix too: never repair a truncated SPS.
        if (hasVui) {
            if (read(1)) { ue(); ue(); } // chroma location
            if (read(1)) { read(32); read(32); read(1); } // timing
            auto hrd = [&]() {
                const auto count = ue();
                if (count > 31) throw std::out_of_range("SPS HRD");
                read(4); read(4);
                for (uint32_t i = 0; i <= count; ++i) { ue(); ue(); read(1); }
                read(5); read(5); read(5); read(5);
            };
            const bool nalHrd = read(1) != 0;
            if (nalHrd) hrd();
            const bool vclHrd = read(1) != 0;
            if (vclHrd) hrd();
            if (nalHrd || vclHrd) read(1);
            read(1); // pic_struct_present_flag
            if (read(1)) { read(1); ue(); ue(); ue(); ue(); ue(); ue(); }
            if (pos != payloadEnd) return false;
        }
        std::vector<uint8_t> updated(bits.begin(), bits.begin() + replaceStart);
        auto put = [&](uint32_t value, unsigned n) {
            while (n--) updated.push_back((value >> n) & 1);
        };
        if (!hasVui) { put(1, 1); put(0, 1); put(0, 1); }
        put(1, 1); // video_signal_type_present_flag
        put(videoFormat, 3);
        put(0, 1); // limited range
        put(1, 1); // colour_description_present_flag
        put(1, 8); put(13, 8); put(6, 8); // BT.709 primaries, sRGB, BT.601 matrix
        if (!hasVui) put(0, 6); // chroma location, timing, HRD, pic_struct, restriction
        updated.insert(updated.end(), bits.begin() + replaceEnd, bits.end());
        while (updated.size() % 8) updated.push_back(0);
        std::vector<uint8_t> encoded{nal[0]};
        zeros = 0;
        for (size_t i = 0; i < updated.size(); i += 8) {
            uint8_t byte = 0;
            for (unsigned b = 0; b < 8; ++b) byte = (byte << 1) | updated[i + b];
            if (zeros == 2 && byte <= 3) { encoded.push_back(3); zeros = 0; }
            encoded.push_back(byte);
            zeros = byte == 0 ? zeros + 1 : 0;
        }
        nal.swap(encoded);
        return true;
    } catch (const std::out_of_range &) {
        return false;
    }
}

inline void tagSoftwareH264Color(std::vector<uint8_t> &accessUnit) {
    auto prefixSize = [&](size_t p) -> size_t {
        if (p + 3 <= accessUnit.size() && accessUnit[p] == 0 && accessUnit[p + 1] == 0) {
            if (accessUnit[p + 2] == 1) return 3;
            if (p + 4 <= accessUnit.size() && accessUnit[p + 2] == 0 && accessUnit[p + 3] == 1) return 4;
        }
        return 0;
    };
    // This entry point accepts Annex B only, not length-prefixed samples.
    size_t first = 0;
    while (first < accessUnit.size() && !prefixSize(first)) {
        if (accessUnit[first++] != 0) return;
    }
    std::vector<uint8_t> result;
    size_t copied = 0;
    for (size_t p = 0; p < accessUnit.size();) {
        const size_t prefix = prefixSize(p);
        if (!prefix) { ++p; continue; }
        const size_t start = p + prefix;
        size_t end = start;
        while (end < accessUnit.size() && !prefixSize(end)) ++end;
        if (start < end && (accessUnit[start] & 31) == 7) {
            std::vector<uint8_t> nal(accessUnit.begin() + start, accessUnit.begin() + end);
            if (tagSoftwareH264Sps(nal)) {
                result.insert(result.end(), accessUnit.begin() + copied, accessUnit.begin() + start);
                result.insert(result.end(), nal.begin(), nal.end());
                copied = end;
            }
        }
        p = end;
    }
    if (copied) {
        result.insert(result.end(), accessUnit.begin() + copied, accessUnit.end());
        accessUnit.swap(result);
    }
}

} // namespace versus::video::detail
