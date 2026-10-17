#include "versus/platform/macos_encoder.h"
#include "versus/platform/macos_ffmpeg_encoder.h"
#include "versus/video/window_capture.h"
#include "versus/video/aspect_fit.h"

#include <VideoToolbox/VideoToolbox.h>
#include <CoreMedia/CoreMedia.h>
extern "C" {
#include <x264.h>
}
#include <QImage>
#include <QPainter>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <spdlog/spdlog.h>

namespace versus::platform {
using namespace video;
namespace {
bool setInteger(VTCompressionSessionRef session, CFStringRef property, int value, bool required = true) {
    CFNumberRef number = CFNumberCreate(nullptr, kCFNumberIntType, &value);
    const auto result = VTSessionSetProperty(session, property, number);
    CFRelease(number);
    if (result != noErr && required) spdlog::warn("[VideoToolbox] Integer property failed (status={})", result);
    return result == noErr;
}
bool setProperty(VTCompressionSessionRef session, CFStringRef property, CFTypeRef value) {
    const auto result = VTSessionSetProperty(session, property, value);
    if (result != noErr) spdlog::warn("[VideoToolbox] Property failed (status={})", result);
    return result == noErr;
}
uint8_t clip(int value) { return static_cast<uint8_t>(std::clamp(value, 0, 255)); }

bool toI420(const CapturedFrame &frame, int width, int height, std::vector<uint8_t> &pixels) {
    if (frame.format != CapturedFrame::Format::BGRA || frame.width <= 0 || frame.height <= 0 ||
        frame.width > 8192 || frame.height > 8192 || frame.stride < frame.width * 4 ||
        frame.data.size() < static_cast<size_t>(frame.stride) * frame.height) return false;
    // Capture supplies straight BGRA. Color and alpha are separate tracks;
    // never multiply the color by alpha before the receiver composites them.
    QImage input(frame.data.data(), frame.width, frame.height, frame.stride, QImage::Format_RGB32);
    QImage fitted(width, height, QImage::Format_RGB32);
    if (fitted.isNull()) return false;
    fitted.fill(Qt::black);
    const auto fit = computeAspectFitRect(frame.width, frame.height, width, height);
    {
        QPainter painter(&fitted);
        painter.drawImage(QRect(fit.x, fit.y, fit.width, fit.height), input);
    }
    const size_t area = static_cast<size_t>(width) * height;
    pixels.resize(area * 3 / 2);
    auto *yPlane = pixels.data(), *uPlane = pixels.data() + area, *vPlane = pixels.data() + area * 5 / 4;
    for (int y = 0; y < height; y += 2) {
        for (int x = 0; x < width; x += 2) {
            int r = 0, g = 0, b = 0;
            for (int dy = 0; dy < 2; ++dy) {
                const auto *row = fitted.constScanLine(y + dy);
                for (int dx = 0; dx < 2; ++dx) {
                    const auto *pixel = row + (x + dx) * 4;
                    const int pb = pixel[0], pg = pixel[1], pr = pixel[2];
                    // Match the app's established SDR sRGB -> limited BT.601
                    // contract. Metadata below describes the actual matrix.
                    yPlane[(y + dy) * width + x + dx] = clip(((66 * pr + 129 * pg + 25 * pb + 128) >> 8) + 16);
                    r += pr; g += pg; b += pb;
                }
            }
            r = (r + 2) / 4; g = (g + 2) / 4; b = (b + 2) / 4;
            const size_t chroma = static_cast<size_t>(y / 2) * (width / 2) + x / 2;
            uPlane[chroma] = clip(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
            vPlane[chroma] = clip(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
        }
    }
    return true;
}

bool normalizeSample(CMSampleBufferRef sample, VideoCodec codec, EncodedPacket &packet) {
    if (!sample || !CMSampleBufferDataIsReady(sample)) return false;
    auto format = CMSampleBufferGetFormatDescription(sample);
    const bool hevc = codec == VideoCodec::H265;
    if (!format || CMFormatDescriptionGetMediaSubType(format) !=
        (hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264)) return false;
    const auto parameterSet = hevc ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex
                                   : CMVideoFormatDescriptionGetH264ParameterSetAtIndex;
    const auto attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    const auto first = attachments && CFArrayGetCount(attachments)
        ? static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0)) : nullptr;
    packet.isKeyframe = !first || CFDictionaryGetValue(first, kCMSampleAttachmentKey_NotSync) != kCFBooleanTrue;
    const uint8_t *parameter = nullptr;
    size_t length = 0, count = 0;
    int prefixLength = 0;
    if (parameterSet(format, 0, &parameter, &length, &count, &prefixLength) != noErr ||
        prefixLength < 1 || prefixLength > 4) return false;
    auto append = [&packet](const uint8_t *bytes, size_t size) {
        packet.data.insert(packet.data.end(), {0, 0, 0, 1});
        packet.data.insert(packet.data.end(), bytes, bytes + size);
    };
    if (packet.isKeyframe) {
        for (size_t index = 0; index < count; ++index) {
            if (parameterSet(format, index, &parameter, &length, nullptr, nullptr) != noErr) return false;
            append(parameter, length);
        }
    }
    const auto block = CMSampleBufferGetDataBuffer(sample);
    if (!block) return false;
    const size_t size = CMBlockBufferGetDataLength(block);
    if (!size || size > 64 * 1024 * 1024) return false;
    std::vector<uint8_t> avcc(size);
    if (CMBlockBufferCopyDataBytes(block, 0, size, avcc.data()) != noErr) return false;
    size_t offset = 0;
    while (offset < size) {
        if (size - offset < static_cast<size_t>(prefixLength)) return false;
        uint32_t nalSize = 0;
        for (int i = 0; i < prefixLength; ++i) nalSize = (nalSize << 8) | avcc[offset++];
        if (!nalSize || nalSize > size - offset) return false;
        append(avcc.data() + offset, nalSize);
        offset += nalSize;
    }
    packet.codec = codec;
    return !packet.data.empty();
}
} // namespace

struct MacVideoEncoder::State {
    EncoderConfig config;
    VTCompressionSessionRef session = nullptr;
    x264_t *software = nullptr;
    std::unique_ptr<MacFfmpegEncoder> ffmpeg;
    std::atomic<bool> initialized{false}, hardware{false};
    std::atomic<VideoCodec> codec{VideoCodec::H264};
    std::atomic<EncodeFailureKind> failure{EncodeFailureKind::None};
    bool forceKeyframe = true;
    int64_t softwareSequence = 0;
    std::vector<uint8_t> i420;
    std::mutex mutex;
    std::condition_variable ready;
    bool completed = false, abandoned = false;
    int64_t pendingPts = 0, pendingIdentity = 0;
    EncodedPacket output;

    static void encoded(void *context, void *, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
        auto &self = *static_cast<State *>(context);
        std::lock_guard lock(self.mutex);
        if (self.abandoned) return;
        try {
            self.output = {};
            if (status != noErr || (flags & kVTEncodeInfo_FrameDropped) || !normalizeSample(sample, self.codec, self.output)) {
                self.failure = EncodeFailureKind::IoFailure;
            } else {
                const auto pts = CMTimeConvertScale(CMSampleBufferGetPresentationTimeStamp(sample), 10000000, kCMTimeRoundingMethod_Default);
                if (!CMTIME_IS_NUMERIC(pts) || pts.value != self.pendingPts) {
                    self.failure = EncodeFailureKind::InvalidInput;
                    self.output = {};
                } else {
                    self.output.pts = self.output.dts = self.pendingPts;
                    self.output.sourceTimestamp = self.pendingIdentity;
                    self.failure = EncodeFailureKind::None;
                }
            }
        } catch (...) {
            self.output = {};
            self.failure = EncodeFailureKind::IoFailure;
        }
        self.completed = true;
        self.ready.notify_all();
    }

    bool startHardware() {
        const void *keys[] = {kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder};
        const void *values[] = {kCFBooleanTrue};
        CFDictionaryRef specification = CFDictionaryCreate(nullptr, keys, values, 1,
            &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        const bool hevc = config.codec == VideoCodec::H265;
        const auto status = VTCompressionSessionCreate(nullptr, config.width, config.height,
            hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
            specification, nullptr, nullptr, encoded, this, &session);
        CFRelease(specification);
        if (status != noErr) { spdlog::warn("[VideoToolbox] Create failed (status={})", status); return false; }
        bool configured =
            setProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue) &&
            setProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse) &&
            setProperty(session, kVTCompressionPropertyKey_ProfileLevel,
                hevc ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel) &&
            setInteger(session, kVTCompressionPropertyKey_ExpectedFrameRate, config.frameRate) &&
            setInteger(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, std::max(1, config.gopSize)) &&
            setInteger(session, kVTCompressionPropertyKey_AverageBitRate, config.bitrate * 1000) &&
            setProperty(session, kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2) &&
            setProperty(session, kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_sRGB) &&
            setProperty(session, kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_601_4);
        // No reordering/lookahead: encode() waits for at most one native frame.
        // Some Apple hardware encoders do not expose this optional property.
        // Reordering remains disabled and the output wait is bounded regardless.
        if (configured) setInteger(session, kVTCompressionPropertyKey_MaxFrameDelayCount, 0, false);
        CFTypeRef actualHardware = nullptr;
        if (configured) configured = VTCompressionSessionPrepareToEncodeFrames(session) == noErr &&
            VTSessionCopyProperty(session, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, nullptr, &actualHardware) == noErr &&
            actualHardware == kCFBooleanTrue;
        if (actualHardware) CFRelease(actualHardware);
        if (!configured) {
            VTCompressionSessionInvalidate(session); CFRelease(session); session = nullptr;
        }
        return configured;
    }

    bool startSoftware() {
        // x264 cannot encode HEVC. Auto codec fallback belongs to the shared
        // application policy, which records the resulting codec explicitly.
        if (config.codec != VideoCodec::H264) return false;
        x264_param_t param;
        if (x264_param_default_preset(&param, "veryfast", "zerolatency") < 0) return false;
        param.i_width = config.width; param.i_height = config.height;
        param.i_csp = X264_CSP_I420;
        param.i_fps_num = config.frameRate; param.i_fps_den = 1;
        param.i_timebase_num = 1; param.i_timebase_den = 10000000;
        param.b_vfr_input = 0;
        param.i_bframe = 0;
        param.i_keyint_max = std::max(1, config.gopSize);
        param.i_keyint_min = 1;
        param.b_repeat_headers = 1; param.b_annexb = 1;
        param.rc.i_rc_method = X264_RC_ABR;
        param.rc.i_bitrate = config.bitrate;
        param.rc.i_vbv_max_bitrate = std::max(config.bitrate, config.maxBitrate);
        param.rc.i_vbv_buffer_size = std::max(1, param.rc.i_vbv_max_bitrate / 2);
        param.vui.b_fullrange = 0;
        param.vui.i_colorprim = 1; param.vui.i_transfer = 13; param.vui.i_colmatrix = 6;
        param.i_log_level = X264_LOG_WARNING;
        if (x264_param_apply_profile(&param, "baseline") < 0) return false;
        software = x264_encoder_open(&param);
        return software != nullptr;
    }
};

MacVideoEncoder::MacVideoEncoder() : state_(std::make_unique<State>()) {}
MacVideoEncoder::~MacVideoEncoder() { shutdown(); }
bool MacVideoEncoder::initialize(const EncoderConfig &config, bool handover) {
    shutdown();
    if (!handover && (config.codec == VideoCodec::VP9 || config.codec == VideoCodec::AV1)) {
        state_->config = config;
        state_->codec = config.codec;
        state_->ffmpeg = std::make_unique<MacFfmpegEncoder>();
        state_->initialized = state_->ffmpeg->initialize(config);
        state_->failure = state_->initialized ? EncodeFailureKind::None : EncodeFailureKind::Unsupported;
        return state_->initialized;
    }
    if (handover || (config.codec != VideoCodec::H264 && config.codec != VideoCodec::H265) ||
        config.enableAlpha || config.bFrames != 0 ||
        config.forceFfmpegNvenc || !config.ffmpegOptions.empty() || config.width < 2 || config.height < 2 ||
        config.width > 8192 || config.height > 8192 || (config.width & 1) || (config.height & 1) ||
        config.frameRate < 1 || config.frameRate > 120 || config.bitrate < 1 || config.bitrate > 200000 ||
        (config.explicitEncoderSelection && config.preferredHardware != HardwareEncoder::None &&
         config.preferredHardware != HardwareEncoder::VideoToolbox)) {
        state_->failure = EncodeFailureKind::Unsupported;
        return false;
    }
    state_->config = config;
    state_->codec = config.codec;
    state_->forceKeyframe = true;
    state_->softwareSequence = 0;
    state_->abandoned = false;
    if (config.preferredHardware != HardwareEncoder::None) state_->hardware = state_->startHardware();
    if (!state_->hardware && (!config.explicitEncoderSelection || config.preferredHardware == HardwareEncoder::None))
        state_->initialized = state_->startSoftware();
    else state_->initialized = state_->hardware.load();
    state_->failure = state_->initialized ? EncodeFailureKind::None : EncodeFailureKind::Unsupported;
    if (state_->initialized) spdlog::info("[MacEncoder] {} {}x{} {}fps", activeEncoderName(), config.width, config.height, config.frameRate);
    return state_->initialized;
}
void MacVideoEncoder::shutdown() {
    state_->initialized = false;
    state_->ffmpeg.reset();
    { std::lock_guard lock(state_->mutex); state_->abandoned = true; }
    // Invalidation ends native callbacks before their context can be released.
    if (state_->session) {
        VTCompressionSessionInvalidate(state_->session);
        CFRelease(state_->session); state_->session = nullptr;
    }
    if (state_->software) { x264_encoder_close(state_->software); state_->software = nullptr; }
    state_->hardware = false;
    state_->output = {};
    state_->i420.clear();
}
bool MacVideoEncoder::encode(const CapturedFrame &frame, EncodedPacket &packet, int64_t sourceTimestamp) {
    packet = {};
    if (!state_->initialized) return false;
    if (state_->ffmpeg) return state_->ffmpeg->encode(frame, packet, sourceTimestamp);
    const auto &config = state_->config;
    if (!toI420(frame, config.width, config.height, state_->i420)) {
        state_->failure = EncodeFailureKind::InvalidInput; return false;
    }
    const size_t area = static_cast<size_t>(config.width) * config.height;
    if (state_->software) {
        x264_picture_t input, output;
        x264_picture_init(&input); x264_picture_init(&output);
        input.img.i_csp = X264_CSP_I420; input.img.i_plane = 3;
        input.img.plane[0] = state_->i420.data();
        input.img.plane[1] = input.img.plane[0] + area;
        input.img.plane[2] = input.img.plane[1] + area / 4;
        input.img.i_stride[0] = config.width;
        input.img.i_stride[1] = input.img.i_stride[2] = config.width / 2;
        input.i_pts = state_->softwareSequence++;
        input.i_type = state_->forceKeyframe ? X264_TYPE_IDR : X264_TYPE_AUTO;
        x264_nal_t *nals = nullptr; int count = 0;
        const int bytes = x264_encoder_encode(state_->software, &nals, &count, &input, &output);
        if (bytes <= 0 || output.i_pts != input.i_pts) {
            state_->failure = EncodeFailureKind::OutputStalled; return false;
        }
        for (int i = 0; i < count; ++i) packet.data.insert(packet.data.end(), nals[i].p_payload, nals[i].p_payload + nals[i].i_payload);
        packet.pts = packet.dts = frame.timestamp;
        packet.sourceTimestamp = sourceTimestamp; packet.isKeyframe = output.b_keyframe;
        packet.codec = VideoCodec::H264;
        state_->forceKeyframe = false;
        state_->failure = EncodeFailureKind::None;
        return true;
    }
    {
        std::lock_guard lock(state_->mutex);
        if (state_->abandoned) { state_->failure = EncodeFailureKind::OutputStalled; return false; }
        state_->completed = false; state_->output = {};
        state_->pendingPts = frame.timestamp; state_->pendingIdentity = sourceTimestamp;
    }
    CVPixelBufferRef buffer = nullptr;
    if (CVPixelBufferCreate(nullptr, config.width, config.height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        nullptr, &buffer) != kCVReturnSuccess) { state_->failure = EncodeFailureKind::IoFailure; return false; }
    if (CVPixelBufferLockBaseAddress(buffer, 0) != kCVReturnSuccess) {
        CFRelease(buffer); state_->failure = EncodeFailureKind::IoFailure; return false;
    }
    auto *yPlane = static_cast<uint8_t *>(CVPixelBufferGetBaseAddressOfPlane(buffer, 0));
    auto *uvPlane = static_cast<uint8_t *>(CVPixelBufferGetBaseAddressOfPlane(buffer, 1));
    for (int y = 0; y < config.height; ++y)
        std::memcpy(yPlane + y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 0), state_->i420.data() + y * config.width, config.width);
    for (int y = 0; y < config.height / 2; ++y) {
        auto *row = uvPlane + y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 1);
        for (int x = 0; x < config.width / 2; ++x) {
            const size_t offset = static_cast<size_t>(y) * config.width / 2 + x;
            row[x * 2] = state_->i420[area + offset]; row[x * 2 + 1] = state_->i420[area * 5 / 4 + offset];
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_sRGB, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_601_4, kCVAttachmentMode_ShouldPropagate);
    CFDictionaryRef properties = nullptr;
    if (state_->forceKeyframe) {
        const void *key = kVTEncodeFrameOptionKey_ForceKeyFrame, *value = kCFBooleanTrue;
        properties = CFDictionaryCreate(nullptr, &key, &value, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    }
    const auto status = VTCompressionSessionEncodeFrame(state_->session, buffer, CMTimeMake(frame.timestamp, 10000000),
        CMTimeMake(1, config.frameRate), properties, nullptr, nullptr);
    if (properties) CFRelease(properties);
    CFRelease(buffer);
    if (status != noErr) {
        std::lock_guard lock(state_->mutex);
        state_->abandoned = true;
        state_->failure = EncodeFailureKind::IoFailure;
        return false;
    }
    std::unique_lock lock(state_->mutex);
    if (!state_->ready.wait_for(lock, std::chrono::milliseconds(500), [&] { return state_->completed; })) {
        // Quarantine this session after timeout. A late callback may never be
        // attributed to a subsequent frame, nor can pending work grow unbounded.
        state_->abandoned = true; state_->failure = EncodeFailureKind::Timeout; return false;
    }
    if (state_->failure != EncodeFailureKind::None) return false;
    packet = std::move(state_->output);
    state_->forceKeyframe = false;
    return true;
}
void MacVideoEncoder::setBitrate(int kbps) {
    if (!state_->initialized || kbps < 1 || kbps > 200000) return;
    if (state_->ffmpeg) { state_->ffmpeg->setBitrate(kbps); state_->config.bitrate = kbps; return; }
    bool ok = false;
    if (state_->session) ok = setInteger(state_->session, kVTCompressionPropertyKey_AverageBitRate, kbps * 1000);
    else if (state_->software) {
        x264_param_t param;
        x264_encoder_parameters(state_->software, &param);
        param.rc.i_bitrate = param.rc.i_vbv_max_bitrate = kbps;
        param.rc.i_vbv_buffer_size = std::max(1, kbps / 2);
        ok = x264_encoder_reconfig(state_->software, &param) == 0;
    }
    if (ok) state_->config.bitrate = kbps;
    else spdlog::warn("[MacEncoder] Bitrate update to {} kbps failed", kbps);
}
void MacVideoEncoder::requestKeyframe() {
    if (state_->ffmpeg) state_->ffmpeg->requestKeyframe();
    else state_->forceKeyframe = true;
}
std::string MacVideoEncoder::activeEncoderName() const {
    if (!state_->initialized) return "unavailable";
    if (state_->ffmpeg) return activeCodec() == VideoCodec::AV1
        ? "FFmpeg libaom-av1 (software)" : "FFmpeg libvpx-vp9 (software)";
    return state_->hardware ? "Apple VideoToolbox " + activeCodecName() + " (hardware)" : "x264 H.264 (software)";
}
VideoCodec MacVideoEncoder::activeCodec() const { return state_->codec.load(); }
std::string MacVideoEncoder::activeCodecName() const {
    if (activeCodec() == VideoCodec::VP9) return "VP9";
    if (activeCodec() == VideoCodec::AV1) return "AV1";
    return activeCodec() == VideoCodec::H265 ? "H.265" : "H.264";
}
std::string MacVideoEncoder::activeInputFormatName() const {
    return state_->config.enableAlpha ? "Gray -> full-range YUV420" : "BGRA -> BT.601 limited YUV420 (sRGB)";
}
bool MacVideoEncoder::isHardwareEncoder() const { return state_->initialized && state_->hardware; }
EncodeFailureKind MacVideoEncoder::lastEncodeFailureKind() const {
    return state_->ffmpeg ? state_->ffmpeg->lastFailure() : state_->failure.load();
}
} // namespace versus::platform
