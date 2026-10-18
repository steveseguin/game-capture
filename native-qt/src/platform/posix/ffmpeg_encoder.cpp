#include "versus/platform/posix_ffmpeg_encoder.h"
#include "versus/platform/posix_ffmpeg.h"
#include "versus/video/window_capture.h"
#include "versus/video/aspect_fit.h"
#include <QImage>
#include <QPainter>
#include <QProcess>
#include <QElapsedTimer>
#include <QtEndian>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstring>
#include <mutex>
#include <thread>
#include <unistd.h>
#include <spdlog/spdlog.h>

namespace versus::platform {
using namespace video;
namespace {
constexpr qsizetype MaxPacket = 64 * 1024 * 1024;
constexpr int FrameDeadlineMs = 1500;

QStringList arguments(const EncoderConfig &c) {
    const int rate = std::max(250, c.bitrate);
    std::string colorFilter = c.enableAlpha ? "scale=in_range=pc:out_range=pc"
        : "scale=in_range=pc:out_range=tv:out_color_matrix=bt601";
    if (c.codec == VideoCodec::AV1) {
        // libaom takes color description from filtered frame properties. Codec
        // options alone leave primaries/transfer unspecified for raw BGRA.
        colorFilter += ",setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=smpte170m:range=limited";
    }
    const int threads = std::clamp(int(std::max(1u, std::thread::hardware_concurrency()) / 2), 1,
        c.codec == VideoCodec::AV1 || c.width * int64_t(c.height) <= 1280 * 720 ? 4 : 8);
    std::vector<std::string> args = {"-hide_banner", "-loglevel", "error", "-nostats", "-nostdin",
        "-filter_threads", "1", "-f", "rawvideo", "-pix_fmt", c.enableAlpha ? "gray" : "bgra",
        "-video_size", std::to_string(c.width) + "x" + std::to_string(c.height),
        "-framerate", std::to_string(c.frameRate), "-i", "pipe:0", "-an"};
    if (c.codec == VideoCodec::AV1) {
        args.insert(args.end(), {"-c:v", "libaom-av1", "-b:v", std::to_string(rate) + "k",
            "-minrate", std::to_string(rate) + "k", "-maxrate", std::to_string(rate) + "k",
            "-bufsize", std::to_string(rate * 2) + "k", "-usage", "realtime", "-cpu-used", "8",
            "-threads", std::to_string(threads), "-row-mt", "1", "-lag-in-frames", "0", "-auto-alt-ref", "0",
            "-g", std::to_string(c.lowLatency ? std::max(1, std::min(c.gopSize, c.frameRate))
                                             : std::max(1, c.gopSize)), "-pix_fmt", "yuv420p"});
        if (c.alphaBackgroundMode != AlphaBackgroundMode::None) {
            // Composited window backgrounds have sharp flat-color boundaries.
            // Screen-content tuning plus a quality floor limits motion-edge
            // smearing; retain the realtime CPU setting for capture cadence.
            args.insert(args.end(), {"-aom-params", "tune-content=screen", "-qmax", "32"});
        }
    } else args.insert(args.end(), {
        "-c:v", "libvpx-vp9", "-b:v", std::to_string(rate) + "k",
        "-minrate", std::to_string(rate) + "k", "-maxrate", std::to_string(rate) + "k",
        "-bufsize", std::to_string(rate * 2) + "k", "-deadline", "realtime", "-cpu-used", "8",
        "-threads", std::to_string(threads), "-row-mt", "1", "-tile-columns", "2", "-tile-rows", "1",
        "-frame-parallel", "1", "-lag-in-frames", "0", "-auto-alt-ref", "0",
        "-g", "1", "-keyint_min", "1", "-max-intra-rate", "100", "-pix_fmt", "yuv420p"});
    args.insert(args.end(), {
        "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-colorspace", "smpte170m",
        "-color_range", c.enableAlpha ? "pc" : "tv",
        "-vf", colorFilter});
    std::vector<std::string> custom;
    for (const auto &arg : QProcess::splitCommand(QString::fromStdString(c.ffmpegOptions))) custom.push_back(arg.toStdString());
    if (c.requireEveryFrameKeyframe) {
        auto protectedOptions = detail::appendProtectedVp9Options(std::move(args), custom);
        args = std::move(protectedOptions.args);
        if (!protectedOptions.rejectedOptions.empty())
            spdlog::warn("[FFmpegEncoder] Ignored {} options that conflict with protected VP9 alpha", protectedOptions.rejectedOptions.size());
    } else args.insert(args.end(), custom.begin(), custom.end());
    // Raw input retains its first analyzed frame; never use nobuffer here.
    args.insert(args.end(), {"-fps_mode", "passthrough", "-flush_packets", "1", "-f", "ivf", "pipe:1"});
    QStringList result;
    for (const auto &arg : args) result.append(QString::fromStdString(arg));
    return result;
}

QByteArray prepare(const CapturedFrame &frame, const EncoderConfig &c) {
    const bool gray = c.enableAlpha;
    const int channels = gray ? 1 : 4;
    if (frame.format != (gray ? CapturedFrame::Format::Gray : CapturedFrame::Format::BGRA) ||
        frame.width < 1 || frame.height < 1 || frame.width > 8192 || frame.height > 8192 ||
        frame.stride < frame.width * channels || frame.data.size() < size_t(frame.stride) * frame.height) return {};
    QByteArray bytes(qsizetype(c.width) * c.height * channels, Qt::Uninitialized);
    if (gray) {
        // The shared alpha pipeline already supplies a grayscale mask. Respect
        // its stride and keep the mask's full 0..255 range when scaling.
        for (int y = 0; y < c.height; ++y)
            for (int x = 0; x < c.width; ++x)
                bytes[y * c.width + x] = char(frame.data[size_t(y * frame.height / c.height) * frame.stride + x * frame.width / c.width]);
    } else {
        // RGB32 ignores source alpha: color and alpha are separate tracks. Do
        // not composite partially transparent color against black a second time.
        QImage source(frame.data.data(), frame.width, frame.height, frame.stride, QImage::Format_RGB32);
        QImage fitted(reinterpret_cast<uchar *>(bytes.data()), c.width, c.height, c.width * 4, QImage::Format_RGB32);
        fitted.fill(Qt::black);
        const auto fit = computeAspectFitRect(frame.width, frame.height, c.width, c.height);
        QPainter painter(&fitted);
        painter.drawImage(QRect(fit.x, fit.y, fit.width, fit.height), source);
    }
    return bytes;
}
}

struct PosixFfmpegEncoder::State {
    EncoderConfig config;
    std::string executable;
    std::thread thread;
    std::mutex mutex;
    std::condition_variable wake;
    bool stop = false, ready = false, started = false, job = false, completed = false, restart = false, busy = false;
    std::atomic<bool> healthy{false};
    std::atomic<EncodeFailureKind> failure{EncodeFailureKind::None};
    CapturedFrame input;
    int64_t identity = 0;
    EncodedPacket output;

    bool stopping() { std::lock_guard lock(mutex); return stop; }
    void run() {
        QProcess process;
        process.setChildProcessModifier([] { ::setsid(); });
        process.setProcessChannelMode(QProcess::SeparateChannels);
        qint64 pid = 0;
        QByteArray bytes;
        bool header = false;
        uint64_t sequence = 0;
        auto retire = [&] {
            if (pid > 1) ::kill(-static_cast<pid_t>(pid), SIGKILL);
            if (process.state() != QProcess::NotRunning) { process.kill(); process.waitForFinished(1000); }
            pid = 0; bytes.clear(); header = false; sequence = 0;
        };
        auto launch = [&](const EncoderConfig &c) {
            retire();
            process.start(QString::fromStdString(executable), arguments(c));
            if (!process.waitForStarted(1000)) return false;
            pid = process.processId();
            return true;
        };
        EncoderConfig current = config;
        {
            const bool ok = launch(current);
            std::lock_guard lock(mutex);
            started = ok; healthy = ok; ready = true;
            failure = ok ? EncodeFailureKind::None : EncodeFailureKind::ProcessExited;
            wake.notify_all();
        }
        while (healthy) {
            CapturedFrame frame;
            int64_t sourceIdentity;
            bool reconfigure;
            {
                std::unique_lock lock(mutex);
                wake.wait(lock, [&] { return stop || job; });
                if (stop) break;
                frame = std::move(input); sourceIdentity = identity; current = config;
                reconfigure = restart; restart = false; job = false;
            }
            EncodedPacket packet;
            EncodeFailureKind error = EncodeFailureKind::None;
            if (reconfigure && !launch(current)) error = EncodeFailureKind::ProcessExited;
            const QByteArray raw = error == EncodeFailureKind::None ? prepare(frame, current) : QByteArray{};
            if (error == EncodeFailureKind::None && raw.isEmpty()) error = EncodeFailureKind::InvalidInput;
            if (error == EncodeFailureKind::None && process.write(raw) != raw.size()) error = EncodeFailureKind::IoFailure;
            QElapsedTimer timer; timer.start();
            while (error == EncodeFailureKind::None && packet.data.empty()) {
                if (stopping()) { error = EncodeFailureKind::ProcessExited; break; }
                if (process.bytesToWrite()) process.waitForBytesWritten(5);
                process.waitForReadyRead(5);
                const auto received = process.readAllStandardOutput();
                const auto diagnostics = process.readAllStandardError();
                if (received.size() > MaxPacket + 44 - bytes.size() || diagnostics.size() > 64 * 1024) {
                    error = EncodeFailureKind::IoFailure; break;
                }
                bytes += received;
                if (!header && bytes.size() >= 32) {
                    const auto *p = reinterpret_cast<const uchar *>(bytes.constData());
                    if (bytes.first(4) != "DKIF" || qFromLittleEndian<quint16>(p + 4) != 0 ||
                        qFromLittleEndian<quint16>(p + 6) != 32 || bytes.mid(8,4) != (current.codec == VideoCodec::AV1 ? "AV01" : "VP90") ||
                        qFromLittleEndian<quint16>(p + 12) != current.width || qFromLittleEndian<quint16>(p + 14) != current.height ||
                        qFromLittleEndian<quint32>(p + 16) != current.frameRate || qFromLittleEndian<quint32>(p + 20) != 1) {
                        error = EncodeFailureKind::InvalidInput; break;
                    }
                    bytes.remove(0,32); header = true;
                }
                if (header && bytes.size() >= 12) {
                    const auto *p = reinterpret_cast<const uchar *>(bytes.constData());
                    const quint32 size = qFromLittleEndian<quint32>(p);
                    if (!size || size > MaxPacket || qFromLittleEndian<quint64>(p + 4) != sequence) {
                        error = EncodeFailureKind::InvalidInput; break;
                    }
                    if (bytes.size() >= qsizetype(size) + 12) {
                        packet.data.assign(p + 12, p + 12 + size); bytes.remove(0, qsizetype(size) + 12);
                        packet.codec = current.codec; packet.pts = packet.dts = frame.timestamp;
                        packet.sourceTimestamp = sourceIdentity; packet.isKeyframe = detail::ivfFrameIsKeyframe(current.codec, packet.data);
                        ++sequence;
                        if (!bytes.isEmpty() || (current.requireEveryFrameKeyframe && !packet.isKeyframe)) {
                            packet = {}; error = EncodeFailureKind::InvalidInput;
                        }
                    }
                }
                if (process.state() == QProcess::NotRunning && packet.data.empty()) error = EncodeFailureKind::ProcessExited;
                if (timer.elapsed() >= FrameDeadlineMs && packet.data.empty()) error = EncodeFailureKind::Timeout;
            }
            if (error != EncodeFailureKind::None) {
                spdlog::warn("[FFmpegEncoder] Encoder generation retired (failure={})", int(error));
                healthy = false; retire();
            }
            {
                std::lock_guard lock(mutex);
                output = std::move(packet); failure = error; completed = true; wake.notify_all();
            }
        }
        retire();
        healthy = false;
    }
};

PosixFfmpegEncoder::PosixFfmpegEncoder() : state_(std::make_unique<State>()) {}
PosixFfmpegEncoder::~PosixFfmpegEncoder() { shutdown(); }
bool PosixFfmpegEncoder::initialize(const EncoderConfig &config) {
    shutdown();
    state_->failure = EncodeFailureKind::Unsupported;
    if ((config.codec != VideoCodec::VP9 && config.codec != VideoCodec::AV1) ||
        (config.codec == VideoCodec::AV1 && (config.enableAlpha || config.requireEveryFrameKeyframe)) ||
        config.width < 2 || config.height < 2 ||
        config.width > 8192 || config.height > 8192 || (config.width & 1) || (config.height & 1) ||
        config.frameRate < 1 || config.frameRate > 120 || config.bitrate < 1 || config.bitrate > 200000 ||
        config.bFrames || config.forceFfmpegNvenc ||
        (config.explicitEncoderSelection && config.preferredHardware != HardwareEncoder::None)) return false;
    const auto probe = VideoEncoder::probeFfmpeg(config.ffmpegPath);
    if (!probe.resolved || !probe.error.empty() ||
        (config.codec == VideoCodec::AV1 ? !probe.hasLibaomAv1 : !probe.hasLibvpxVp9) ||
        (probe.bundled && (probe.gplEnabled || probe.nonfreeEnabled))) return false;
    state_->config = config;
    state_->executable = resolvePosixFfmpeg(config.ffmpegPath).string();
    state_->stop = state_->ready = state_->job = state_->completed = state_->restart = state_->busy = false;
    state_->thread = std::thread([this] { state_->run(); });
    std::unique_lock lock(state_->mutex);
    const bool ready = state_->wake.wait_for(lock, std::chrono::seconds(3), [&] { return state_->ready; });
    const bool ok = ready && state_->started;
    lock.unlock(); if (!ok) shutdown(); return ok;
}
void PosixFfmpegEncoder::shutdown() {
    { std::lock_guard lock(state_->mutex); state_->stop = true; state_->wake.notify_all(); }
    if (state_->thread.joinable()) state_->thread.join();
    state_->input = {}; state_->output = {}; state_->healthy = false;
}
bool PosixFfmpegEncoder::encode(const CapturedFrame &frame, EncodedPacket &packet, int64_t identity) {
    packet = {};
    std::unique_lock lock(state_->mutex);
    if (!state_->healthy || state_->stop || state_->busy) return false;
    state_->busy = true;
    state_->input = frame; state_->identity = identity; state_->completed = false; state_->job = true; state_->wake.notify_all();
    if (!state_->wake.wait_for(lock, std::chrono::seconds(4), [&] { return state_->completed || state_->stop; })) {
        state_->busy = false; state_->stop = true; state_->failure = EncodeFailureKind::Timeout; state_->wake.notify_all(); return false;
    }
    state_->busy = false;
    if (state_->stop || state_->failure != EncodeFailureKind::None) return false;
    packet = std::move(state_->output); return !packet.data.empty();
}
void PosixFfmpegEncoder::setBitrate(int kbps) {
    if (kbps < 1 || kbps > 200000) return;
    std::lock_guard lock(state_->mutex); state_->config.bitrate = kbps; state_->restart = true;
}
void PosixFfmpegEncoder::requestKeyframe() {
    std::lock_guard lock(state_->mutex);
    if (!state_->config.requireEveryFrameKeyframe) state_->restart = true;
}
EncodeFailureKind PosixFfmpegEncoder::lastFailure() const { return state_->failure.load(); }
}
