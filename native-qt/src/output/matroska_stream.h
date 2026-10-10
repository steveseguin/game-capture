#pragma once

#include <QByteArray>
#include <QtEndian>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace versus::output::detail {

// Streaming Matroska preserves capture PTS through FFmpeg's video-copy/AAC
// path. Independent raw H.264 and PCM pipes would invent unrelated clocks.
class MatroskaStream {
  public:
    static std::vector<QByteArray> nals(const std::vector<uint8_t> &data) {
        std::vector<QByteArray> result;
        auto prefix = [&](size_t p) -> size_t {
            if (p + 3 <= data.size() && data[p] == 0 && data[p + 1] == 0) {
                if (data[p + 2] == 1) return 3;
                if (p + 4 <= data.size() && data[p + 2] == 0 && data[p + 3] == 1) return 4;
            }
            return 0;
        };
        for (size_t pos = 0; pos < data.size();) {
            const size_t lead = prefix(pos);
            if (!lead) { ++pos; continue; }
            const size_t begin = pos + lead;
            pos = begin;
            while (pos < data.size() && !prefix(pos)) ++pos;
            size_t end = pos;
            while (end > begin && data[end - 1] == 0) --end;
            if (end > begin) result.emplace_back(reinterpret_cast<const char *>(data.data() + begin), end - begin);
        }
        if (result.empty()) throw std::runtime_error("Encoder did not produce Annex B H.264");
        return result;
    }

    static QByteArray codecPrivate(const std::vector<QByteArray> &units) {
        QByteArray sps, pps;
        for (const auto &nal : units) {
            if ((uint8_t(nal[0]) & 31) == 7) sps = nal;
            if ((uint8_t(nal[0]) & 31) == 8) pps = nal;
        }
        if (sps.size() < 4 || pps.isEmpty() || sps.size() > 65535 || pps.size() > 65535) return {};
        QByteArray out;
        out.append(char(1)).append(sps.mid(1, 3)).append(char(0xff)).append(char(0xe1));
        appendBig(out, uint64_t(sps.size()), 2); out += sps;
        out.append(char(1)); appendBig(out, uint64_t(pps.size()), 2); out += pps;
        return out;
    }

    QByteArray header(const QByteArray &avcc, int width, int height, int fps, int channels, bool audio) {
        QByteArray ebml = integer(0x4286, 1) + integer(0x42f7, 1) + integer(0x42f2, 4) + integer(0x42f3, 8)
            + element(0x4282, "matroska") + integer(0x4287, 4) + integer(0x4285, 2);
        QByteArray out = element(0x1a45dfa3, ebml);
        appendBig(out, 0x18538067, 4);
        out += QByteArray::fromHex("01ffffffffffffff"); // Unknown-length Segment.
        out += element(0x1549a966, integer(0x2ad7b1, 1000000) + element(0x4d80, "Game Capture") + element(0x5741, "Game Capture"));
        QByteArray video = integer(0xd7, 1) + integer(0x73c5, 1) + integer(0x83, 1) + integer(0x9c, 0)
            + element(0x86, "V_MPEG4/ISO/AVC") + element(0x63a2, avcc)
            + integer(0x23e383, 1000000000ULL / std::max(1, fps))
            + element(0xe0, integer(0xb0, width) + integer(0xba, height));
        QByteArray tracks = element(0xae, video);
        if (audio) {
            const double sampleRate = 48000.0;
            uint64_t bits; std::memcpy(&bits, &sampleRate, sizeof(bits));
            QByteArray rate; appendBig(rate, bits, 8);
            tracks += element(0xae, integer(0xd7, 2) + integer(0x73c5, 2) + integer(0x83, 2) + integer(0x9c, 0)
                + element(0x86, "A_PCM/FLOAT/IEEE")
                + element(0xe1, element(0xb5, rate) + integer(0x9f, channels) + integer(0x6264, 32)));
        }
        out += element(0x1654ae6b, tracks);
        lastClusterMs_ = 0;
        return out;
    }

    QByteArray video(const std::vector<QByteArray> &units, int64_t relativePts100ns, bool keyframe) {
        QByteArray payload;
        for (const auto &nal : units) { appendBig(payload, uint64_t(nal.size()), 4); payload += nal; }
        return block(1, relativePts100ns, keyframe, payload);
    }
    QByteArray audio(const QByteArray &pcm, int64_t relativePts100ns) { return block(2, relativePts100ns, true, pcm); }

  private:
    static void appendBig(QByteArray &out, uint64_t value, int bytes) {
        for (int i = bytes - 1; i >= 0; --i) out.append(char(value >> (i * 8)));
    }
    static QByteArray element(uint32_t id, const QByteArray &payload) {
        QByteArray out;
        const int idBytes = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
        appendBig(out, id, idBytes);
        int sizeBytes = 1;
        while (uint64_t(payload.size()) >= ((uint64_t(1) << (7 * sizeBytes)) - 1)) ++sizeBytes;
        appendBig(out, uint64_t(payload.size()) | (uint64_t(1) << (7 * sizeBytes)), sizeBytes);
        out += payload;
        return out;
    }
    static QByteArray integer(uint32_t id, uint64_t value) {
        QByteArray bytes; int count = 1;
        while (count < 8 && value >= (uint64_t(1) << (count * 8))) ++count;
        appendBig(bytes, value, count);
        return element(id, bytes);
    }
    QByteArray block(int track, int64_t pts100ns, bool keyframe, const QByteArray &payload) {
        const int64_t ptsMs = pts100ns / 10000;
        if (ptsMs < 0) return {};
        const int64_t clusterMs = std::max(lastClusterMs_, ptsMs);
        const int64_t relativeMs = ptsMs - clusterMs;
        if (relativeMs < -32768) throw std::runtime_error("Output media exceeded the interleave bound");
        lastClusterMs_ = clusterMs;
        QByteArray data;
        data.append(char(0x80 | track)); appendBig(data, uint16_t(relativeMs), 2);
        data.append(char(keyframe ? 0x80 : 0)); data += payload;
        return element(0x1f43b675, integer(0xe7, clusterMs) + element(0xa3, data));
    }
    int64_t lastClusterMs_ = 0;
};
} // namespace versus::output::detail
