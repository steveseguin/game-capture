#include "versus/platform/linux_encoder.h"
#include "versus/platform/posix_ffmpeg_encoder.h"
#include "versus/video/window_capture.h"
#include "versus/video/aspect_fit.h"
#include <QImage>
#include <QPainter>
#include <algorithm>
#include <atomic>
#include <map>
#include <mutex>
#include <thread>
#include <spdlog/spdlog.h>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

namespace versus::platform {
using namespace video;
struct LinuxVideoEncoder::State {
    mutable std::mutex mutex;
    EncoderConfig config;
    std::unique_ptr<PosixFfmpegEncoder> external;
    AVCodecContext *context = nullptr;
    AVFrame *frame = nullptr;
    AVPacket *packet = nullptr;
    SwsContext *conversion = nullptr;
    std::string name;
    std::atomic<EncodeFailureKind> failure{EncodeFailureKind::None};
    bool keyframe = true;
    bool hardware = false;
    int64_t origin = -1, lastPts = -1;
    struct Identity { int64_t source, capture; };
    std::map<int64_t, Identity> pending;

    void close() {
        external.reset();
        avcodec_free_context(&context);
        av_frame_free(&frame);
        av_packet_free(&packet);
        sws_freeContext(conversion); conversion = nullptr;
        pending.clear(); name.clear(); origin = lastPts = -1; keyframe = true;
        hardware = false;
    }
    ~State() { close(); }

    bool open(const char *encoder, bool hw) {
        close();
        const AVCodec *codec = avcodec_find_encoder_by_name(encoder);
        if (!codec) return false;
        context = avcodec_alloc_context3(codec);
        if (!context) return false;
        context->width = config.width; context->height = config.height;
        context->time_base = {1, 10000000};
        context->framerate = {config.frameRate, 1};
        context->pix_fmt = AV_PIX_FMT_YUV420P;
        context->bit_rate = int64_t(config.bitrate) * 1000;
        context->rc_max_rate = int64_t(std::max(config.bitrate, config.maxBitrate)) * 1000;
        context->rc_buffer_size = int(context->rc_max_rate / 2);
        context->max_b_frames = 0;
        context->gop_size = config.requireEveryFrameKeyframe ? 1 :
            std::max(1, config.lowLatency ? std::min(config.gopSize, config.frameRate) : config.gopSize);
        context->thread_count = int(std::clamp(std::thread::hardware_concurrency() / 2, 1u, 4u));
        context->color_range = config.enableAlpha ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
        context->color_primaries = AVCOL_PRI_BT709;
        context->color_trc = AVCOL_TRC_IEC61966_2_1;
        context->colorspace = AVCOL_SPC_SMPTE170M;
        AVDictionary *options = nullptr;
        if (std::string(encoder) == "libx264") {
            av_dict_set(&options, "preset", "veryfast", 0);
            av_dict_set(&options, "tune", "zerolatency", 0);
            av_dict_set(&options, "profile", "baseline", 0);
            av_dict_set(&options, "x264-params", "repeat-headers=1:annexb=1:scenecut=0", 0);
        } else if (std::string(encoder) == "libx265") {
            av_dict_set(&options, "preset", "veryfast", 0);
            av_dict_set(&options, "tune", "zerolatency", 0);
            av_dict_set(&options, "x265-params", "repeat-headers=1:pools=4:frame-threads=1:log-level=error", 0);
        } else if (hw) {
            av_dict_set(&options, "preset", "p4", 0);
            av_dict_set(&options, "tune", "ll", 0);
            av_dict_set(&options, "rc", "cbr", 0);
            av_dict_set(&options, "delay", "0", 0);
            av_dict_set(&options, "forced-idr", "1", 0);
        } else {
            // Match the shared FFmpeg helper's realtime rate control. Merely
            // setting a maximum leaves libvpx/libaom in one-pass VBR, which can
            // substantially overshoot a low live-stream target.
            context->rc_min_rate = context->rc_max_rate = context->bit_rate;
            av_dict_set(&options, "cpu-used", "8", 0);
            av_dict_set(&options, "lag-in-frames", "0", 0);
            av_dict_set(&options, "auto-alt-ref", "0", 0);
            if (config.codec == VideoCodec::AV1) {
                av_dict_set(&options, "usage", "realtime", 0);
                av_dict_set(&options, "row-mt", "1", 0);
            } else {
                av_dict_set(&options, "deadline", "realtime", 0);
                if (config.codec == VideoCodec::VP9) av_dict_set(&options, "row-mt", "1", 0);
            }
        }
        const int result = avcodec_open2(context, codec, &options);
        av_dict_free(&options);
        if (result < 0) { close(); return false; }
        frame = av_frame_alloc(); packet = av_packet_alloc();
        if (!frame || !packet) { close(); return false; }
        frame->format = context->pix_fmt;
        frame->width = config.width; frame->height = config.height;
        frame->color_range = context->color_range;
        frame->color_primaries = context->color_primaries;
        frame->color_trc = context->color_trc; frame->colorspace = context->colorspace;
        if (av_frame_get_buffer(frame, 32) < 0) { close(); return false; }
        name = encoder; hardware = hw;
        spdlog::info("[LinuxEncoder] {} {}x{} at {} fps", name, config.width, config.height, config.frameRate);
        return true;
    }
};

LinuxVideoEncoder::LinuxVideoEncoder() : state_(std::make_unique<State>()) {}
LinuxVideoEncoder::~LinuxVideoEncoder() = default;
void LinuxVideoEncoder::shutdown() { std::lock_guard lock(state_->mutex); state_->close(); }
bool LinuxVideoEncoder::initialize(const EncoderConfig &config, bool handover) {
    std::lock_guard lock(state_->mutex);
    auto &s = *state_; s.close(); s.config = config; s.failure = EncodeFailureKind::Unsupported;
    if (handover || config.width < 2 || config.height < 2 || config.width > 3840 ||
        config.height > 2160 || (config.width & 1) || (config.height & 1) || config.frameRate < 1)
        return false;
    // Reuse the Mac subprocess contract when the operator explicitly selects
    // a VP9/AV1 helper or options. Ordinary Linux encoding stays in libavcodec.
    if ((config.codec == VideoCodec::VP9 || config.codec == VideoCodec::AV1) &&
        (!config.ffmpegPath.empty() || !config.ffmpegOptions.empty())) {
        s.external = std::make_unique<PosixFfmpegEncoder>();
        if (!s.external->initialize(config)) { s.failure = s.external->lastFailure(); s.external.reset(); return false; }
        s.name = config.codec == VideoCodec::VP9 ? "FFmpeg libvpx-vp9" : "FFmpeg libaom-av1";
        s.failure = EncodeFailureKind::None;
        spdlog::info("[LinuxEncoder] {} {}x{} at {} fps (explicit helper/options)", s.name, config.width, config.height, config.frameRate);
        return true;
    }
    if (!config.ffmpegOptions.empty()) {
        spdlog::error("[LinuxEncoder] Custom FFmpeg arguments require an external encoder backend");
        return false;
    }
    const char *software = nullptr, *nvidia = nullptr;
    switch (config.codec) {
    case VideoCodec::H264: software = "libx264"; nvidia = "h264_nvenc"; break;
    case VideoCodec::H265: software = "libx265"; nvidia = "hevc_nvenc"; break;
    case VideoCodec::VP8: software = "libvpx"; break;
    case VideoCodec::VP9: software = "libvpx-vp9"; break;
    case VideoCodec::AV1: software = "libaom-av1"; nvidia = "av1_nvenc"; break;
    }
    bool ok = false;
    if (config.preferredHardware == HardwareEncoder::NVENC && nvidia) ok = s.open(nvidia, true);
    if (!ok && (!config.explicitEncoderSelection || config.preferredHardware == HardwareEncoder::None))
        ok = s.open(software, false);
    if (ok) s.failure = EncodeFailureKind::None;
    return ok;
}

bool LinuxVideoEncoder::encode(const CapturedFrame &input, EncodedPacket &output,
                               int64_t sourceTimestamp, int64_t presentationTimestamp) {
    std::lock_guard lock(state_->mutex);
    auto &s = *state_;
    if (s.external) {
        const bool ok = s.external->encode(input, output, sourceTimestamp);
        s.failure = s.external->lastFailure();
        return ok;
    }
    s.failure = EncodeFailureKind::InvalidInput;
    const bool gray = s.config.enableAlpha;
    const int channels = gray ? 1 : 4;
    if (!s.context || input.width < 1 || input.height < 1 || input.width > 8192 || input.height > 8192 ||
        input.format != (gray ? CapturedFrame::Format::Gray : CapturedFrame::Format::BGRA) ||
        input.stride < input.width * channels || input.data.size() < size_t(input.stride) * input.height ||
        presentationTimestamp < 0) return false;
    if (s.origin < 0) s.origin = presentationTimestamp;
    const int64_t pts = presentationTimestamp - s.origin;
    if (pts <= s.lastPts) return false;
    if (av_frame_make_writable(s.frame) < 0) { s.failure = EncodeFailureKind::IoFailure; return false; }

    QImage source(input.data.data(), input.width, input.height, input.stride,
                  gray ? QImage::Format_Grayscale8 : QImage::Format_ARGB32);
    QImage fitted(s.config.width, s.config.height, QImage::Format_ARGB32);
    const auto &c = s.config;
    fitted.fill(c.alphaBackgroundMode == AlphaBackgroundMode::None ? Qt::black :
                QColor(c.alphaBackgroundRed, c.alphaBackgroundGreen, c.alphaBackgroundBlue));
    {
        QPainter painter(&fitted);
        painter.setRenderHint(QPainter::SmoothPixmapTransform);
        const auto fit = computeAspectFitRect(input.width, input.height, c.width, c.height);
        painter.drawImage(QRect(fit.x, fit.y, fit.width, fit.height), source);
    }
    s.conversion = sws_getCachedContext(s.conversion, c.width, c.height, AV_PIX_FMT_BGRA,
        c.width, c.height, AV_PIX_FMT_YUV420P, SWS_BILINEAR, nullptr, nullptr, nullptr);
    if (!s.conversion) { s.failure = EncodeFailureKind::IoFailure; return false; }
    const auto *coefficients = sws_getCoefficients(SWS_CS_ITU601);
    sws_setColorspaceDetails(s.conversion, coefficients, 1, coefficients, gray ? 1 : 0, 0, 1 << 16, 1 << 16);
    const uint8_t *data[] = {fitted.constBits(), nullptr, nullptr, nullptr};
    const int strides[] = {int(fitted.bytesPerLine()), 0, 0, 0};
    if (sws_scale(s.conversion, data, strides, 0, c.height, s.frame->data, s.frame->linesize) != c.height)
        return false;
    s.frame->pts = pts;
    s.frame->pict_type = s.keyframe || c.requireEveryFrameKeyframe ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    int result = avcodec_send_frame(s.context, s.frame);
    if (result < 0) { s.failure = EncodeFailureKind::IoFailure; return false; }
    s.keyframe = false; s.lastPts = pts;
    s.pending.emplace(pts, State::Identity{sourceTimestamp, input.timestamp});
    if (s.pending.size() > 8) { s.failure = EncodeFailureKind::OutputStalled; return false; }
    result = avcodec_receive_packet(s.context, s.packet);
    if (result < 0) {
        s.failure = result == AVERROR(EAGAIN) ? EncodeFailureKind::Backpressure : EncodeFailureKind::IoFailure;
        return false;
    }
    const auto identity = s.pending.find(s.packet->pts);
    if (identity == s.pending.end()) { av_packet_unref(s.packet); s.failure = EncodeFailureKind::IoFailure; return false; }
    output.data.assign(s.packet->data, s.packet->data + s.packet->size);
    output.sourceTimestamp = identity->second.source;
    output.pts = output.dts = identity->second.capture;
    output.codec = c.codec;
    output.isKeyframe = c.codec == VideoCodec::H264 ? detail::h264AccessUnitIsKeyframe(output.data) :
        (s.packet->flags & AV_PKT_FLAG_KEY) != 0;
    s.pending.erase(identity); av_packet_unref(s.packet);
    s.failure = EncodeFailureKind::None;
    return true;
}
void LinuxVideoEncoder::setBitrate(int kbps) {
    std::lock_guard lock(state_->mutex);
    if (kbps <= 0) return;
    state_->config.bitrate = kbps;
    if (state_->external) { state_->external->setBitrate(kbps); return; }
    if (state_->context) {
        state_->context->bit_rate = int64_t(kbps) * 1000;
        state_->context->rc_max_rate = int64_t(kbps) * 1000;
        state_->context->rc_buffer_size = kbps * 500;
    }
}
void LinuxVideoEncoder::requestKeyframe() {
    std::lock_guard lock(state_->mutex);
    if (state_->external) state_->external->requestKeyframe();
    else state_->keyframe = true;
}
VideoCodec LinuxVideoEncoder::activeCodec() const { std::lock_guard lock(state_->mutex); return state_->config.codec; }
std::string LinuxVideoEncoder::activeCodecName() const {
    switch (activeCodec()) {
    case VideoCodec::H264: return "H.264"; case VideoCodec::H265: return "H.265";
    case VideoCodec::VP8: return "VP8"; case VideoCodec::VP9: return "VP9"; case VideoCodec::AV1: return "AV1";
    } return "unknown";
}
std::string LinuxVideoEncoder::activeEncoderName() const { std::lock_guard lock(state_->mutex); return state_->name; }
std::string LinuxVideoEncoder::activeInputFormatName() const { return "YUV420P"; }
bool LinuxVideoEncoder::isHardwareEncoder() const { std::lock_guard lock(state_->mutex); return state_->hardware; }
EncodeFailureKind LinuxVideoEncoder::lastEncodeFailureKind() const { return state_->failure.load(); }
}
