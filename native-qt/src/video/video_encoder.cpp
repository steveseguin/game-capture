#include "versus/video/video_encoder.h"
#include "versus/video/window_capture.h"

#include <spdlog/spdlog.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef VERSUS_HAS_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}
#else
// Windows Media Foundation H264 encoder fallback
#ifdef _WIN32
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>
#include <codecapi.h>
#include <mferror.h>
#include <d3d11.h>
#include <strmif.h>  // For ICodecAPI
#include <wrl/client.h>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "d3d11.lib")
#endif
#endif

namespace versus::video {

namespace {

const char *videoCodecName(VideoCodec codec) {
    switch (codec) {
        case VideoCodec::H264:
            return "H.264";
        case VideoCodec::H265:
            return "H.265";
        case VideoCodec::VP8:
            return "VP8";
        case VideoCodec::VP9:
            return "VP9";
        case VideoCodec::AV1:
            return "AV1";
        default:
            return "Unknown";
    }
}

struct AspectFitRect {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

AspectFitRect computeAspectFitRect(int srcW, int srcH, int dstW, int dstH) {
    AspectFitRect rect;
    if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) {
        return rect;
    }

    const int64_t widthFromHeight = static_cast<int64_t>(srcW) * dstH / srcH;
    const int64_t heightFromWidth = static_cast<int64_t>(srcH) * dstW / srcW;

    if (widthFromHeight <= dstW) {
        rect.width = static_cast<int>(std::max<int64_t>(1, widthFromHeight));
        rect.height = dstH;
    } else {
        rect.width = dstW;
        rect.height = static_cast<int>(std::max<int64_t>(1, heightFromWidth));
    }

    rect.x = (dstW - rect.width) / 2;
    rect.y = (dstH - rect.height) / 2;
    return rect;
}

void blitBgraAspectFit(const uint8_t *src, int srcW, int srcH, int srcStride,
                       uint8_t *dst, int dstW, int dstH, int dstStride) {
    if (!src || !dst || srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0 || srcStride <= 0 || dstStride <= 0) {
        return;
    }

    const size_t dstSize = static_cast<size_t>(dstStride) * static_cast<size_t>(dstH);
    std::fill(dst, dst + dstSize, 0);
    for (int y = 0; y < dstH; ++y) {
        uint8_t *row = dst + static_cast<size_t>(y) * dstStride;
        for (int x = 0; x < dstW; ++x) {
            row[x * 4 + 3] = 255;
        }
    }

    const AspectFitRect fit = computeAspectFitRect(srcW, srcH, dstW, dstH);
    if (fit.width <= 0 || fit.height <= 0) {
        return;
    }

    for (int y = 0; y < fit.height; ++y) {
        const int srcY = std::clamp((y * srcH) / fit.height, 0, srcH - 1);
        const uint8_t *srcRow = src + static_cast<size_t>(srcY) * srcStride;
        uint8_t *dstRow = dst + static_cast<size_t>(fit.y + y) * dstStride + fit.x * 4;
        for (int x = 0; x < fit.width; ++x) {
            const int srcX = std::clamp((x * srcW) / fit.width, 0, srcW - 1);
            const uint8_t *srcPixel = srcRow + srcX * 4;
            uint8_t *dstPixel = dstRow + x * 4;
            dstPixel[0] = srcPixel[0];
            dstPixel[1] = srcPixel[1];
            dstPixel[2] = srcPixel[2];
            dstPixel[3] = srcPixel[3];
        }
    }
}

}  // namespace

#ifdef VERSUS_HAS_FFMPEG

class VideoEncoder::Impl {
  public:
    bool initialize(const EncoderConfig &config) {
        config_ = config;
        return tryInitEncoder(config_.preferredHardware);
    }

    void shutdown() {
        std::lock_guard<std::mutex> lock(mutex_);
        if (codecCtx_) {
            avcodec_free_context(&codecCtx_);
        }
        if (hwDeviceCtx_) {
            av_buffer_unref(&hwDeviceCtx_);
        }
        if (hwFrameCtx_) {
            av_buffer_unref(&hwFrameCtx_);
        }
        if (swsCtx_) {
            sws_freeContext(swsCtx_);
            swsCtx_ = nullptr;
        }
        if (frame_) {
            av_frame_free(&frame_);
        }
        if (hwFrame_) {
            av_frame_free(&hwFrame_);
        }
        if (packet_) {
            av_packet_free(&packet_);
        }
        initialized_ = false;
        activeEncoderName_.clear();
        activeCodec_ = VideoCodec::H264;
    }

    bool encode(const CapturedFrame &input, EncodedPacket &output) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!initialized_) {
            return false;
        }
        if (!prepareFrame(input)) {
            return false;
        }
        int ret = avcodec_send_frame(codecCtx_, useHardware_ ? hwFrame_ : frame_);
        if (ret < 0 && ret != AVERROR(EAGAIN)) {
            return false;
        }
        ret = avcodec_receive_packet(codecCtx_, packet_);
        if (ret < 0) {
            return false;
        }
        output.data.assign(packet_->data, packet_->data + packet_->size);
        output.pts = packet_->pts;
        output.dts = packet_->dts;
        output.isKeyframe = (packet_->flags & AV_PKT_FLAG_KEY) != 0;
        output.codec = config_.codec;
        av_packet_unref(packet_);
        return true;
    }

    void setBitrate(int kbps) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (codecCtx_) {
            codecCtx_->bit_rate = kbps * 1000;
        }
        config_.bitrate = kbps;
    }

    void requestKeyframe() { forceKeyframe_ = true; }
    std::string activeEncoderName() const { return activeEncoderName_; }
    VideoCodec activeCodec() const { return activeCodec_; }
    std::string activeCodecName() const { return videoCodecName(activeCodec_); }
    bool isHardwareEncoder() const { return useHardware_; }

  private:
    bool tryInitEncoder(HardwareEncoder hardware) {
        const char *encoderName = "h264_nvenc";
        AVHWDeviceType hwType = AV_HWDEVICE_TYPE_CUDA;

        if (config_.codec == VideoCodec::H265) {
            encoderName = "hevc_nvenc";
        }

        if (hardware == HardwareEncoder::QuickSync) {
            encoderName = (config_.codec == VideoCodec::H265) ? "hevc_qsv" : "h264_qsv";
            hwType = AV_HWDEVICE_TYPE_QSV;
        } else if (hardware == HardwareEncoder::AMF) {
            encoderName = (config_.codec == VideoCodec::H265) ? "hevc_amf" : "h264_amf";
            hwType = AV_HWDEVICE_TYPE_D3D11VA;
        }
        activeEncoderName_ = encoderName;

        const AVCodec *codec = avcodec_find_encoder_by_name(encoderName);
        if (!codec) {
            return false;
        }

        codecCtx_ = avcodec_alloc_context3(codec);
        if (!codecCtx_) {
            return false;
        }

        codecCtx_->width = config_.width;
        codecCtx_->height = config_.height;
        codecCtx_->time_base = {1, config_.frameRate};
        codecCtx_->framerate = {config_.frameRate, 1};
        codecCtx_->bit_rate = config_.bitrate * 1000;
        codecCtx_->gop_size = config_.gopSize;
        codecCtx_->max_b_frames = config_.bFrames;

        useHardware_ = (hardware != HardwareEncoder::None);
        if (useHardware_) {
            if (av_hwdevice_ctx_create(&hwDeviceCtx_, hwType, nullptr, nullptr, 0) < 0) {
                return false;
            }
            codecCtx_->hw_device_ctx = av_buffer_ref(hwDeviceCtx_);
            codecCtx_->pix_fmt = (hwType == AV_HWDEVICE_TYPE_QSV) ? AV_PIX_FMT_QSV : AV_PIX_FMT_NV12;

            hwFrameCtx_ = av_hwframe_ctx_alloc(hwDeviceCtx_);
            if (!hwFrameCtx_) {
                return false;
            }
            auto *framesCtx = reinterpret_cast<AVHWFramesContext *>(hwFrameCtx_->data);
            framesCtx->format = codecCtx_->pix_fmt;
            framesCtx->sw_format = AV_PIX_FMT_NV12;
            framesCtx->width = config_.width;
            framesCtx->height = config_.height;
            framesCtx->initial_pool_size = 4;
            if (av_hwframe_ctx_init(hwFrameCtx_) < 0) {
                return false;
            }
            codecCtx_->hw_frames_ctx = av_buffer_ref(hwFrameCtx_);
        } else {
            codecCtx_->pix_fmt = AV_PIX_FMT_YUV420P;
        }

        if (avcodec_open2(codecCtx_, codec, nullptr) < 0) {
            return false;
        }

        frame_ = av_frame_alloc();
        frame_->format = useHardware_ ? AV_PIX_FMT_NV12 : AV_PIX_FMT_YUV420P;
        frame_->width = config_.width;
        frame_->height = config_.height;
        av_frame_get_buffer(frame_, 0);

        if (useHardware_) {
            hwFrame_ = av_frame_alloc();
            av_hwframe_get_buffer(codecCtx_->hw_frames_ctx, hwFrame_, 0);
        }

        packet_ = av_packet_alloc();
        initialized_ = true;
        activeCodec_ = config_.codec;
        return true;
    }

    bool prepareFrame(const CapturedFrame &input) {
        if (input.format != CapturedFrame::Format::BGRA || input.data.empty()) {
            return false;
        }

        const int swsSrcW = std::max(1, config_.width);
        const int swsSrcH = std::max(1, config_.height);
        const size_t paddedSize = static_cast<size_t>(swsSrcW) * static_cast<size_t>(swsSrcH) * 4;
        if (aspectFitInputBuffer_.size() != paddedSize) {
            aspectFitInputBuffer_.resize(paddedSize);
        }
        blitBgraAspectFit(input.data.data(), input.width, input.height, input.stride,
                          aspectFitInputBuffer_.data(), swsSrcW, swsSrcH, swsSrcW * 4);

        if (!swsCtx_ || lastWidth_ != swsSrcW || lastHeight_ != swsSrcH) {
            if (swsCtx_) {
                sws_freeContext(swsCtx_);
            }
            AVPixelFormat dstFmt = useHardware_ ? AV_PIX_FMT_NV12 : AV_PIX_FMT_YUV420P;
            swsCtx_ = sws_getContext(
                swsSrcW, swsSrcH, AV_PIX_FMT_BGRA,
                config_.width, config_.height, dstFmt,
                SWS_BILINEAR, nullptr, nullptr, nullptr);
            if (!swsCtx_) {
                return false;
            }
            lastWidth_ = swsSrcW;
            lastHeight_ = swsSrcH;
        }

        const uint8_t *srcSlice[1] = {aspectFitInputBuffer_.data()};
        int srcStride[1] = {swsSrcW * 4};
        sws_scale(swsCtx_, srcSlice, srcStride, 0, swsSrcH, frame_->data, frame_->linesize);
        frame_->pts = frameCount_++;
        if (forceKeyframe_) {
            frame_->pict_type = AV_PICTURE_TYPE_I;
            forceKeyframe_ = false;
        } else {
            frame_->pict_type = AV_PICTURE_TYPE_NONE;
        }

        if (useHardware_) {
            if (av_hwframe_transfer_data(hwFrame_, frame_, 0) < 0) {
                return false;
            }
            hwFrame_->pts = frame_->pts;
        }
        return true;
    }

    EncoderConfig config_{};
    std::mutex mutex_;
    AVCodecContext *codecCtx_ = nullptr;
    AVBufferRef *hwDeviceCtx_ = nullptr;
    AVBufferRef *hwFrameCtx_ = nullptr;
    SwsContext *swsCtx_ = nullptr;
    AVFrame *frame_ = nullptr;
    AVFrame *hwFrame_ = nullptr;
    AVPacket *packet_ = nullptr;
    bool initialized_ = false;
    bool useHardware_ = false;
    bool forceKeyframe_ = false;
    int64_t frameCount_ = 0;
    int lastWidth_ = 0;
    int lastHeight_ = 0;
    std::vector<uint8_t> aspectFitInputBuffer_;
    std::string activeEncoderName_;
    VideoCodec activeCodec_ = VideoCodec::H264;
};

#else

// Windows Media Foundation H264 encoder fallback
#ifdef _WIN32
using Microsoft::WRL::ComPtr;

class VideoEncoder::Impl {
  public:
    std::string activeEncoderName() const { return activeEncoderName_; }
    VideoCodec activeCodec() const { return activeCodec_; }
    std::string activeCodecName() const { return videoCodecName(activeCodec_); }
    bool isHardwareEncoder() const { return usingHardware_; }

    bool initialize(const EncoderConfig &config) {
        config_ = config;
        spdlog::info("[VideoEncoder] Initializing MF encoder {}x{} @{}kbps", config.width, config.height, config.bitrate);
        frameCount_ = 0;
        activeCodec_ = VideoCodec::H264;

        const bool requireExternalFfmpeg =
            config_.forceFfmpegNvenc || config_.codec != VideoCodec::H264;
        if (requireExternalFfmpeg && initializeExternalFfmpegNvenc()) {
            initialized_ = true;
            usingHardware_ = externalUsingHardware_;
            activeEncoderName_ = externalEncoderName_;
            activeCodec_ = config_.codec;
            if (!runWarmupProbe()) {
                bool recovered = false;
                if (config_.codec != VideoCodec::H264 &&
                    config_.preferredHardware != HardwareEncoder::None) {
                    spdlog::warn("[VideoEncoder] {} hardware path failed warm-up; trying software fallback",
                                 videoCodecName(config_.codec));
                    shutdownExternalFfmpegNvenc();
                    config_.preferredHardware = HardwareEncoder::None;
                    if (initializeExternalFfmpegNvenc()) {
                        initialized_ = true;
                        usingHardware_ = externalUsingHardware_;
                        activeEncoderName_ = externalEncoderName_;
                        activeCodec_ = config_.codec;
                        recovered = runWarmupProbe();
                    }
                }
                if (!recovered) {
                    spdlog::warn("[VideoEncoder] FFmpeg warm-up probe failed; falling back to Media Foundation");
                    shutdownExternalFfmpegNvenc();
                    initialized_ = false;
                    usingHardware_ = false;
                    activeEncoderName_.clear();
                    activeCodec_ = VideoCodec::H264;
                } else {
                    frameCount_ = 0;
                }
            } else {
                frameCount_ = 0;
            }
        }
        if (initialized_) {
            spdlog::info("[VideoEncoder] Using {} encoder: {} codec={}",
                         usingHardware_ ? "hardware" : "software",
                         activeEncoderName_,
                         videoCodecName(activeCodec_));
            return true;
        }
        if (requireExternalFfmpeg) {
            spdlog::error("[VideoEncoder] External FFmpeg pipeline is required for codec={} but initialization failed",
                          videoCodecName(config_.codec));
            return false;
        }

        if (!ensureComInitialized()) {
            return false;
        }

        HRESULT hr = MFStartup(MF_VERSION);
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] MFStartup failed hr=0x{:08x}", (unsigned)hr);
            releaseCom();
            return false;
        }
        mfStarted_ = true;

        const auto candidates = orderedEncoderCandidates();
        if (candidates.empty()) {
            spdlog::error("[VideoEncoder] No H264 encoder found");
            shutdownMf();
            releaseCom();
            return false;
        }

        HRESULT lastHr = E_FAIL;
        for (const auto &candidate : candidates) {
            resetCurrentTransform();
            spdlog::info("[VideoEncoder] Trying {} encoder: {}",
                         candidate.hardware ? "hardware" : "software", candidate.name);

            hr = candidate.activate->ActivateObject(IID_PPV_ARGS(transform_.ReleaseAndGetAddressOf()));
            if (FAILED(hr)) {
                lastHr = hr;
                spdlog::warn("[VideoEncoder] Failed to activate {} encoder '{}' hr=0x{:08x}",
                             candidate.hardware ? "hardware" : "software",
                             candidate.name,
                             static_cast<unsigned>(hr));
                continue;
            }

            activeEncoderName_ = candidate.name;
            usingHardware_ = candidate.hardware;
            if (configureTransform()) {
                initialized_ = true;
                if (!runWarmupProbe()) {
                    spdlog::warn("[VideoEncoder] Encoder '{}' failed warm-up probe; trying next candidate", candidate.name);
                    initialized_ = false;
                    resetCurrentTransform();
                    continue;
                }

                if (!config_.forceFfmpegNvenc &&
                    config_.preferredHardware == HardwareEncoder::NVENC &&
                    !matchesPreferredHardware(activeEncoderName_, HardwareEncoder::NVENC)) {
                    spdlog::warn("[VideoEncoder] Requested NVENC but active encoder is '{}'; trying FFmpeg NVENC fallback",
                                 activeEncoderName_);
                    if (initializeExternalFfmpegNvenc()) {
                        if (runWarmupProbe()) {
                            resetCurrentTransform();
                            shutdownMf();
                            releaseCom();
                            initialized_ = true;
                            usingHardware_ = externalUsingHardware_;
                            activeEncoderName_ = externalEncoderName_;
                            activeCodec_ = config_.codec;
                            frameCount_ = 0;
                            spdlog::info("[VideoEncoder] Using hardware encoder: {}", activeEncoderName_);
                            return true;
                        }
                        spdlog::warn("[VideoEncoder] FFmpeg NVENC fallback failed warm-up; keeping '{}'",
                                     candidate.name);
                        shutdownExternalFfmpegNvenc();
                    } else {
                        spdlog::warn("[VideoEncoder] FFmpeg NVENC fallback unavailable; keeping '{}'",
                                     candidate.name);
                    }
                }

                frameCount_ = 0;
                activeCodec_ = VideoCodec::H264;
                spdlog::info("[VideoEncoder] Using {} encoder: {}",
                             usingHardware_ ? "hardware" : "software", activeEncoderName_);
                return true;
            }

            spdlog::warn("[VideoEncoder] Encoder '{}' did not accept the configured media types; trying next candidate",
                         candidate.name);
            lastHr = E_FAIL;
        }

        spdlog::error("[VideoEncoder] Failed to initialize any encoder candidate (last hr=0x{:08x})",
                      static_cast<unsigned>(lastHr));
        resetCurrentTransform();
        activeEncoderName_.clear();
        usingHardware_ = false;
        activeCodec_ = VideoCodec::H264;
        shutdownMf();
        releaseCom();
        return false;
    }

    void shutdown() {
        shutdownExternalFfmpegNvenc();
        resetCurrentTransform();
        shutdownMf();
        releaseCom();
        initialized_ = false;
        usingHardware_ = false;
        activeEncoderName_.clear();
        activeCodec_ = VideoCodec::H264;
        frameCount_ = 0;
        inputSubtype_ = MFVideoFormat_NV12;
    }

    bool encode(const CapturedFrame &input, EncodedPacket &output) {
        if (usingExternalFfmpeg_) {
            return encodeExternalFfmpegNvenc(input, output);
        }

        if (!initialized_ || !transform_) {
            return false;
        }

        std::vector<uint8_t> inputData;
        if (!prepareInputBuffer(input, inputData)) {
            return false;
        }

        // Create input sample
        ComPtr<IMFSample> inputSample;
        ComPtr<IMFMediaBuffer> inputBuffer;

        HRESULT hr = MFCreateMemoryBuffer(static_cast<DWORD>(inputData.size()), &inputBuffer);
        if (FAILED(hr)) return false;

        BYTE* bufferData = nullptr;
        hr = inputBuffer->Lock(&bufferData, nullptr, nullptr);
        if (FAILED(hr)) return false;

        std::memcpy(bufferData, inputData.data(), inputData.size());
        inputBuffer->Unlock();
        inputBuffer->SetCurrentLength(static_cast<DWORD>(inputData.size()));

        hr = MFCreateSample(&inputSample);
        if (FAILED(hr)) return false;

        inputSample->AddBuffer(inputBuffer.Get());

        LONGLONG timestamp = frameCount_ * 10000000LL / config_.frameRate;
        inputSample->SetSampleTime(timestamp);
        inputSample->SetSampleDuration(10000000LL / config_.frameRate);

        auto pullOutput = [&](EncodedPacket &packet, bool &produced) -> HRESULT {
            produced = false;
            MFT_OUTPUT_DATA_BUFFER outputDataBuffer = {};
            DWORD status = 0;

            MFT_OUTPUT_STREAM_INFO streamInfo = {};
            HRESULT localHr = transform_->GetOutputStreamInfo(0, &streamInfo);

            static bool loggedStreamInfo = false;
            if (!loggedStreamInfo && SUCCEEDED(localHr)) {
                spdlog::info("[MFEncoder] Output stream info: flags=0x{:x}, cbSize={}",
                             streamInfo.dwFlags, streamInfo.cbSize);
                loggedStreamInfo = true;
            }

            ComPtr<IMFSample> outputSample;
            ComPtr<IMFMediaBuffer> outputBuffer;

            if (SUCCEEDED(localHr) && !(streamInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
                const DWORD bufferSize = (streamInfo.cbSize > 0) ? streamInfo.cbSize : (4 * 1024 * 1024);
                localHr = MFCreateMemoryBuffer(bufferSize, &outputBuffer);
                if (FAILED(localHr)) {
                    return localHr;
                }
                localHr = MFCreateSample(&outputSample);
                if (FAILED(localHr)) {
                    return localHr;
                }
                outputSample->AddBuffer(outputBuffer.Get());
                outputDataBuffer.pSample = outputSample.Get();
            }

            localHr = transform_->ProcessOutput(0, 1, &outputDataBuffer, &status);
            if (localHr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
                return localHr;
            }
            if (localHr == MF_E_TRANSFORM_STREAM_CHANGE) {
                spdlog::info("[MFEncoder] Stream format change, retrieving new output type");
                ComPtr<IMFMediaType> newOutputType;
                HRESULT hr2 = transform_->GetOutputAvailableType(0, 0, &newOutputType);
                if (SUCCEEDED(hr2)) {
                    hr2 = transform_->SetOutputType(0, newOutputType.Get(), 0);
                    if (SUCCEEDED(hr2)) {
                        spdlog::info("[MFEncoder] Successfully set new output type");
                    }
                }
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return localHr;
            }
            if (FAILED(localHr)) {
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return localHr;
            }

            ComPtr<IMFSample> resultSample = outputSample;
            if (outputDataBuffer.pSample && outputDataBuffer.pSample != outputSample.Get()) {
                resultSample.Attach(outputDataBuffer.pSample);
            }
            if (!resultSample) {
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return E_FAIL;
            }

            ComPtr<IMFMediaBuffer> encodedBuffer;
            localHr = resultSample->GetBufferByIndex(0, &encodedBuffer);
            if (FAILED(localHr) || !encodedBuffer) {
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return E_FAIL;
            }

            BYTE *encodedData = nullptr;
            DWORD encodedSize = 0;
            localHr = encodedBuffer->Lock(&encodedData, nullptr, &encodedSize);
            if (FAILED(localHr)) {
                if (outputDataBuffer.pEvents) {
                    outputDataBuffer.pEvents->Release();
                }
                return localHr;
            }

            packet.data.assign(encodedData, encodedData + encodedSize);
            const LONGLONG outTimestamp = frameCount_ * 10000000LL / config_.frameRate;
            packet.pts = outTimestamp;
            packet.dts = outTimestamp;
            packet.isKeyframe = false;

            static int nalLogCount = 0;
            for (DWORD i = 0; i + 4 < encodedSize; i++) {
                if ((encodedData[i] == 0 && encodedData[i+1] == 0 && encodedData[i+2] == 0 && encodedData[i+3] == 1) ||
                    (encodedData[i] == 0 && encodedData[i+1] == 0 && encodedData[i+2] == 1)) {
                    const int offset = (encodedData[i+2] == 1) ? 3 : 4;
                    const uint8_t nalType = encodedData[i + offset] & 0x1F;
                    if (nalLogCount < 40 && (nalType == 5 || nalType == 7 || nalType == 1)) {
                        spdlog::debug("[MFEncoder] NAL type {} at offset {} (frame {})", nalType, i, frameCount_);
                        nalLogCount++;
                    }
                    if (nalType == 5 || nalType == 7) {
                        packet.isKeyframe = true;
                        break;
                    }
                }
            }
            packet.codec = activeCodec_;

            encodedBuffer->Unlock();
            if (outputDataBuffer.pEvents) {
                outputDataBuffer.pEvents->Release();
            }
            produced = true;

            static bool firstEncoded = true;
            if (firstEncoded) {
                std::string hexDump;
                for (DWORD i = 0; i < std::min(encodedSize, DWORD(32)); i++) {
                    char buf[4];
                    snprintf(buf, sizeof(buf), "%02x ", encodedData[i]);
                    hexDump += buf;
                }
                spdlog::info("[MFEncoder] First frame encoded successfully, size={}", encodedSize);
                spdlog::info("[MFEncoder] First bytes: {}", hexDump);
                firstEncoded = false;
            }
            return S_OK;
        };

        if (asyncMft_) {
            pumpAsyncEvents();

            bool produced = false;
            if (pendingHaveOutputEvents_ > 0) {
                hr = pullOutput(output, produced);
                if (SUCCEEDED(hr) && produced) {
                    pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                    return true;
                }
                if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
                    pendingHaveOutputEvents_ = 0;
                } else {
                    pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                }
                if (FAILED(hr) && hr != MF_E_TRANSFORM_STREAM_CHANGE) {
                    static int asyncOutputFailCount = 0;
                    if (++asyncOutputFailCount % 100 == 1) {
                        spdlog::warn("[MFEncoder] Async ProcessOutput failed hr=0x{:08x} (count={})",
                                     static_cast<unsigned>(hr), asyncOutputFailCount);
                    }
                }
            }

            if (pendingNeedInputEvents_ <= 0) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
                pumpAsyncEvents();
                if (pendingNeedInputEvents_ <= 0) {
                    return false;
                }
            }

            hr = transform_->ProcessInput(0, inputSample.Get(), 0);
            if (hr == MF_E_NOTACCEPTING) {
                pendingNeedInputEvents_ = 0;
                pumpAsyncEvents();
                if (pendingHaveOutputEvents_ > 0) {
                    hr = pullOutput(output, produced);
                    if (SUCCEEDED(hr) && produced) {
                        pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                        return true;
                    }
                }
                return false;
            }
            if (FAILED(hr)) {
                static int asyncInputFailCount = 0;
                if (++asyncInputFailCount % 100 == 1) {
                    spdlog::warn("[MFEncoder] Async ProcessInput failed hr=0x{:08x} (count={})",
                                 static_cast<unsigned>(hr), asyncInputFailCount);
                }
                return false;
            }
            pendingNeedInputEvents_ = std::max(0, pendingNeedInputEvents_ - 1);
            frameCount_++;

            pumpAsyncEvents();
            if (pendingHaveOutputEvents_ > 0) {
                hr = pullOutput(output, produced);
                if (SUCCEEDED(hr) && produced) {
                    pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                    return true;
                }
                if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
                    pendingHaveOutputEvents_ = 0;
                } else {
                    pendingHaveOutputEvents_ = std::max(0, pendingHaveOutputEvents_ - 1);
                }
            }
            return false;
        }

        hr = transform_->ProcessInput(0, inputSample.Get(), 0);
        if (hr == MF_E_NOTACCEPTING) {
            bool drained = false;
            const HRESULT drainHr = pullOutput(output, drained);
            if (SUCCEEDED(drainHr) && drained) {
                frameCount_++;
                return true;
            }
            hr = transform_->ProcessInput(0, inputSample.Get(), 0);
        }
        if (FAILED(hr)) {
            static int inputFailCount = 0;
            if (++inputFailCount % 100 == 1) {
                spdlog::warn("[MFEncoder] ProcessInput failed hr=0x{:08x} (count={})",
                             static_cast<unsigned>(hr), inputFailCount);
            }
            return false;
        }

        bool produced = false;
        hr = pullOutput(output, produced);
        if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
            frameCount_++;
            static int needMoreCount = 0;
            if (++needMoreCount % 100 == 1) {
                spdlog::info("[MFEncoder] Need more input (count={})", needMoreCount);
            }
            return false;
        }
        if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
            frameCount_++;
            return false;
        }
        if (FAILED(hr)) {
            static int outputFailCount = 0;
            if (++outputFailCount % 100 == 1) {
                spdlog::warn("[MFEncoder] ProcessOutput failed hr=0x{:08x} (count={})",
                             static_cast<unsigned>(hr), outputFailCount);
            }
            return false;
        }
        if (produced) {
            frameCount_++;
        }
        return produced;
    }

    void setBitrate(int kbps) {
        config_.bitrate = kbps;
        if (usingExternalFfmpeg_) {
            restartExternalFfmpegNvenc();
            return;
        }
        if (!codecApi_) {
            return;
        }
        setCodecApiUi4(CODECAPI_AVEncCommonMeanBitRate,
                       static_cast<ULONG>(std::max(1, kbps) * 1000),
                       "Updated mean bitrate (kbps):");
        const int maxKbps = std::max(config_.maxBitrate, kbps);
        setCodecApiUi4(CODECAPI_AVEncCommonMaxBitRate,
                       static_cast<ULONG>(std::max(1, maxKbps) * 1000),
                       "Updated max bitrate (kbps):");
    }

    void requestKeyframe() {
        if (usingExternalFfmpeg_) {
            externalForceKeyframeRequested_ = true;
            return;
        }
        if (!codecApi_) {
            spdlog::warn("[VideoEncoder] requestKeyframe: no ICodecAPI available");
            return;
        }
        VARIANT forceKeyframe;
        VariantInit(&forceKeyframe);
        forceKeyframe.vt = VT_UI4;
        forceKeyframe.ulVal = 1;  // Request keyframe
        HRESULT hr = codecApi_->SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &forceKeyframe);
        VariantClear(&forceKeyframe);
        if (SUCCEEDED(hr)) {
            spdlog::info("[VideoEncoder] Keyframe requested");
        } else {
            spdlog::warn("[VideoEncoder] Failed to request keyframe hr=0x{:08x}", (unsigned)hr);
        }
    }

    static std::string trimCopy(const std::string &value) {
        size_t begin = 0;
        while (begin < value.size() && std::isspace(static_cast<unsigned char>(value[begin])) != 0) {
            ++begin;
        }
        size_t end = value.size();
        while (end > begin && std::isspace(static_cast<unsigned char>(value[end - 1])) != 0) {
            --end;
        }
        return value.substr(begin, end - begin);
    }

    static std::wstring utf8ToWide(const std::string &value) {
        if (value.empty()) {
            return {};
        }
        int length = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
        UINT codePage = CP_UTF8;
        if (length <= 0) {
            codePage = CP_ACP;
            length = MultiByteToWideChar(codePage, 0, value.c_str(), -1, nullptr, 0);
        }
        if (length <= 0) {
            return {};
        }
        std::wstring result(static_cast<size_t>(length), L'\0');
        MultiByteToWideChar(codePage, 0, value.c_str(), -1, result.data(), length);
        if (!result.empty() && result.back() == L'\0') {
            result.pop_back();
        }
        return result;
    }

    static std::wstring quoteCommandArg(const std::wstring &arg) {
        if (arg.empty()) {
            return L"\"\"";
        }
        if (arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
            return arg;
        }
        std::wstring quoted;
        quoted.push_back(L'"');
        int backslashes = 0;
        for (wchar_t ch : arg) {
            if (ch == L'\\') {
                ++backslashes;
                continue;
            }
            if (ch == L'"') {
                quoted.append(static_cast<size_t>(backslashes * 2 + 1), L'\\');
                quoted.push_back(L'"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0) {
                quoted.append(static_cast<size_t>(backslashes), L'\\');
                backslashes = 0;
            }
            quoted.push_back(ch);
        }
        if (backslashes > 0) {
            quoted.append(static_cast<size_t>(backslashes * 2), L'\\');
        }
        quoted.push_back(L'"');
        return quoted;
    }

    static std::vector<std::string> splitCommandArgs(const std::string &value) {
        std::vector<std::string> args;
        std::string current;
        bool inQuotes = false;
        char quoteChar = '\0';
        for (char ch : value) {
            if (inQuotes) {
                if (ch == quoteChar) {
                    inQuotes = false;
                } else {
                    current.push_back(ch);
                }
                continue;
            }

            if (ch == '"' || ch == '\'') {
                inQuotes = true;
                quoteChar = ch;
                continue;
            }
            if (std::isspace(static_cast<unsigned char>(ch)) != 0) {
                if (!current.empty()) {
                    args.push_back(current);
                    current.clear();
                }
                continue;
            }
            current.push_back(ch);
        }
        if (!current.empty()) {
            args.push_back(current);
        }
        return args;
    }

    std::filesystem::path resolveExternalFfmpegPath() const {
        std::vector<std::filesystem::path> candidates;
        std::vector<std::string> seen;

        auto normalizeKey = [](const std::filesystem::path &path) {
            std::string key = path.lexically_normal().string();
            std::transform(key.begin(), key.end(), key.begin(), [](unsigned char ch) {
                return static_cast<char>(std::tolower(ch));
            });
            return key;
        };

        auto pushCandidate = [&](std::filesystem::path candidate) {
            if (candidate.empty()) {
                return;
            }
            std::error_code ec;
            if (std::filesystem::is_directory(candidate, ec)) {
                candidate /= "ffmpeg.exe";
            }
            if (!candidate.has_extension() &&
                candidate.filename().string() == "ffmpeg") {
                candidate += ".exe";
            }
            if (!candidate.is_absolute()) {
                candidate = std::filesystem::absolute(candidate, ec);
            }
            if (candidate.empty()) {
                return;
            }
            const std::string key = normalizeKey(candidate);
            if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
                return;
            }
            seen.push_back(key);
            candidates.push_back(candidate);
        };

        const std::string configuredPath = trimCopy(config_.ffmpegPath);
        if (!configuredPath.empty()) {
            pushCandidate(configuredPath);
        }

        const char *envPath = std::getenv("VERSUS_FFMPEG_PATH");
        if (envPath && *envPath) {
            pushCandidate(envPath);
        }
        envPath = std::getenv("FFMPEG_PATH");
        if (envPath && *envPath) {
            pushCandidate(envPath);
        }
        envPath = std::getenv("FFMPEG_EXE");
        if (envPath && *envPath) {
            pushCandidate(envPath);
        }

        wchar_t modulePathWide[MAX_PATH] = {};
        const DWORD modulePathLen = GetModuleFileNameW(nullptr, modulePathWide, MAX_PATH);
        if (modulePathLen > 0 && modulePathLen < MAX_PATH) {
            const std::filesystem::path modulePath(modulePathWide);
            const std::filesystem::path moduleDir = modulePath.parent_path();
            pushCandidate(moduleDir / "ffmpeg.exe");
            pushCandidate(moduleDir / "ffmpeg" / "ffmpeg.exe");
            pushCandidate(moduleDir.parent_path() / "ffmpeg.exe");
            pushCandidate(moduleDir.parent_path().parent_path() / "ffmpeg.exe");
            pushCandidate(moduleDir.parent_path() / "tools" / "ffmpeg.exe");
        }

        std::error_code ec;
        pushCandidate(std::filesystem::current_path(ec) / "ffmpeg.exe");
        pushCandidate(std::filesystem::current_path(ec) / "tools" / "ffmpeg.exe");

        const char *userProfile = std::getenv("USERPROFILE");
        if (userProfile && *userProfile) {
            const std::filesystem::path userCodeDir = std::filesystem::path(userProfile) / "code";
            pushCandidate(userCodeDir / "obs-studio" / ".deps" / "obs-deps-2025-08-23-x64" / "bin" / "ffmpeg.exe");
            pushCandidate(userCodeDir / "ninjasdk" / "ffmpeg.exe");
        }

        wchar_t searchResult[MAX_PATH] = {};
        const DWORD searchLen = SearchPathW(nullptr, L"ffmpeg.exe", nullptr, MAX_PATH, searchResult, nullptr);
        if (searchLen > 0 && searchLen < MAX_PATH) {
            pushCandidate(std::filesystem::path(searchResult));
        }

        for (const auto &candidate : candidates) {
            if (std::filesystem::exists(candidate, ec) &&
                std::filesystem::is_regular_file(candidate, ec)) {
                return candidate;
            }
        }

        return {};
    }

    bool initializeExternalFfmpegNvenc() {
        shutdownExternalFfmpegNvenc();
        externalFfmpegPath_ = resolveExternalFfmpegPath();
        if (externalFfmpegPath_.empty()) {
            spdlog::warn("[FFmpegEncoder] ffmpeg.exe not found (set --ffmpeg-path or VERSUS_FFMPEG_PATH)");
            return false;
        }
        if (config_.codec == VideoCodec::VP8 || config_.codec == VideoCodec::VP9) {
            spdlog::warn("[FFmpegEncoder] Codec {} is not supported in current RTP transport path",
                         videoCodecName(config_.codec));
            return false;
        }

        const int width = std::max(1, config_.width);
        const int height = std::max(1, config_.height);
        const int frameRate = std::max(1, config_.frameRate);
        const int bitrate = std::max(250, config_.bitrate);
        const int maxBitrate = std::max(bitrate, std::max(250, config_.maxBitrate));
        const int gop = config_.lowLatency
            ? std::max(1, std::min(std::max(1, config_.gopSize), frameRate))
            : std::max(1, config_.gopSize);
        const int bFrames = std::max(0, config_.bFrames);
        const int bufferSize = std::max(maxBitrate, bitrate) * 2;

        std::string encoderName;
        auto chooseEncoder = [&](const char *nvenc,
                                 const char *qsv,
                                 const char *amf,
                                 const char *software) {
            switch (config_.preferredHardware) {
                case HardwareEncoder::QuickSync:
                    encoderName = qsv;
                    break;
                case HardwareEncoder::AMF:
                    encoderName = amf;
                    break;
                case HardwareEncoder::None:
                    encoderName = software;
                    break;
                case HardwareEncoder::NVENC:
                default:
                    encoderName = nvenc;
                    break;
            }
        };
        switch (config_.codec) {
            case VideoCodec::H265:
                chooseEncoder("hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265");
                externalOutputFormat_ = ExternalOutputFormat::AnnexB;
                break;
            case VideoCodec::AV1:
                chooseEncoder("av1_nvenc", "av1_qsv", "av1_amf", "libaom-av1");
                externalOutputFormat_ = ExternalOutputFormat::Ivf;
                break;
            case VideoCodec::H264:
            default:
                chooseEncoder("h264_nvenc", "h264_qsv", "h264_amf", "libx264");
                externalOutputFormat_ = ExternalOutputFormat::AnnexB;
                break;
        }
        externalUsingHardware_ = encoderName.find("_nvenc") != std::string::npos ||
                                 encoderName.find("_qsv") != std::string::npos ||
                                 encoderName.find("_amf") != std::string::npos;
        externalEncoderName_ = "FFmpeg " + encoderName;
        externalIvfHeaderParsed_ = false;

        std::vector<std::string> args = {
            "-hide_banner",
            "-loglevel", "error",
            "-nostats",
            "-fflags", "+nobuffer",
            "-f", "rawvideo",
            "-pix_fmt", "bgra",
            "-video_size", std::to_string(width) + "x" + std::to_string(height),
            "-framerate", std::to_string(frameRate),
            "-i", "-",
            "-an",
            "-c:v", encoderName,
            "-b:v", std::to_string(bitrate) + "k",
            "-maxrate", std::to_string(maxBitrate) + "k",
            "-bufsize", std::to_string(bufferSize) + "k",
            "-g", std::to_string(gop),
            "-force_key_frames", "expr:gte(t,n_forced*2.5)",
        };
        if (encoderName.find("_nvenc") != std::string::npos) {
            args.push_back("-preset");
            args.push_back("llhq");
            args.push_back("-tune");
            args.push_back("ll");
            args.push_back("-zerolatency");
            args.push_back("1");
            args.push_back("-rc");
            args.push_back("cbr");
            args.push_back("-strict_gop");
            args.push_back("1");
            args.push_back("-rc-lookahead");
            args.push_back("0");
            args.push_back("-bf");
            args.push_back(std::to_string(bFrames));
            if (config_.codec == VideoCodec::H264 || config_.codec == VideoCodec::H265) {
                args.push_back("-forced-idr");
                args.push_back("1");
                args.push_back("-aud");
                args.push_back("1");
            }
        } else if (encoderName == "libx264") {
            args.push_back("-preset");
            args.push_back("veryfast");
            args.push_back("-tune");
            args.push_back("zerolatency");
        } else if (encoderName == "libx265") {
            args.push_back("-preset");
            args.push_back("fast");
            args.push_back("-tune");
            args.push_back("zerolatency");
        } else if (encoderName == "libaom-av1") {
            args.push_back("-cpu-used");
            args.push_back("6");
            args.push_back("-row-mt");
            args.push_back("1");
            args.push_back("-lag-in-frames");
            args.push_back("0");
        }

        if (config_.codec == VideoCodec::AV1) {
            if (config_.enableAlpha && !externalUsingHardware_) {
                args.push_back("-pix_fmt");
                args.push_back("yuva420p");
            } else {
                if (config_.enableAlpha && externalUsingHardware_) {
                    spdlog::warn("[FFmpegEncoder] Alpha workflow requested but AV1 hardware encoders do not preserve alpha");
                }
                args.push_back("-pix_fmt");
                args.push_back("yuv420p");
            }
        } else {
            args.push_back("-pix_fmt");
            args.push_back("nv12");
        }

        const auto extraArgs = splitCommandArgs(config_.ffmpegOptions);
        args.insert(args.end(), extraArgs.begin(), extraArgs.end());
        if (config_.codec == VideoCodec::H264) {
            args.push_back("-bsf:v");
            args.push_back("h264_metadata=aud=insert,dump_extra=freq=keyframe");
            args.push_back("-f");
            args.push_back("h264");
        } else if (config_.codec == VideoCodec::H265) {
            args.push_back("-bsf:v");
            args.push_back("hevc_metadata=aud=insert");
            args.push_back("-f");
            args.push_back("hevc");
        } else if (config_.codec == VideoCodec::AV1) {
            args.push_back("-f");
            args.push_back("ivf");
        }
        args.push_back("-");

        std::wstring command = quoteCommandArg(externalFfmpegPath_.wstring());
        for (const auto &arg : args) {
            command.push_back(L' ');
            command += quoteCommandArg(utf8ToWide(arg));
        }

        SECURITY_ATTRIBUTES sa = {};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;

        HANDLE childStdInRead = nullptr;
        HANDLE childStdInWrite = nullptr;
        HANDLE childStdOutRead = nullptr;
        HANDLE childStdOutWrite = nullptr;
        HANDLE childStdErr = nullptr;

        if (!CreatePipe(&childStdInRead, &childStdInWrite, &sa, 0) ||
            !SetHandleInformation(childStdInWrite, HANDLE_FLAG_INHERIT, 0)) {
            if (childStdInRead) CloseHandle(childStdInRead);
            if (childStdInWrite) CloseHandle(childStdInWrite);
            spdlog::warn("[FFmpegEncoder] Failed to create stdin pipe");
            return false;
        }

        if (!CreatePipe(&childStdOutRead, &childStdOutWrite, &sa, 0) ||
            !SetHandleInformation(childStdOutRead, HANDLE_FLAG_INHERIT, 0)) {
            CloseHandle(childStdInRead);
            CloseHandle(childStdInWrite);
            if (childStdOutRead) CloseHandle(childStdOutRead);
            if (childStdOutWrite) CloseHandle(childStdOutWrite);
            spdlog::warn("[FFmpegEncoder] Failed to create stdout pipe");
            return false;
        }

        childStdErr = CreateFileW(L"NUL",
                                  FILE_GENERIC_WRITE,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE,
                                  &sa,
                                  OPEN_EXISTING,
                                  FILE_ATTRIBUTE_NORMAL,
                                  nullptr);
        if (childStdErr == INVALID_HANDLE_VALUE) {
            childStdErr = nullptr;
        }

        STARTUPINFOW startupInfo = {};
        startupInfo.cb = sizeof(startupInfo);
        startupInfo.dwFlags = STARTF_USESTDHANDLES;
        startupInfo.hStdInput = childStdInRead;
        startupInfo.hStdOutput = childStdOutWrite;
        startupInfo.hStdError = childStdErr ? childStdErr : childStdOutWrite;

        PROCESS_INFORMATION processInfo = {};
        std::vector<wchar_t> mutableCommand(command.begin(), command.end());
        mutableCommand.push_back(L'\0');
        const BOOL spawned = CreateProcessW(
            externalFfmpegPath_.wstring().c_str(),
            mutableCommand.data(),
            nullptr,
            nullptr,
            TRUE,
            CREATE_NO_WINDOW,
            nullptr,
            nullptr,
            &startupInfo,
            &processInfo);

        CloseHandle(childStdInRead);
        CloseHandle(childStdOutWrite);
        if (childStdErr) {
            CloseHandle(childStdErr);
        }

        if (!spawned) {
            CloseHandle(childStdInWrite);
            CloseHandle(childStdOutRead);
            spdlog::warn("[FFmpegEncoder] CreateProcess failed for '{}'", externalFfmpegPath_.string());
            return false;
        }

        externalStdInWrite_ = childStdInWrite;
        externalStdOutRead_ = childStdOutRead;
        externalProcess_ = processInfo.hProcess;
        externalThread_ = processInfo.hThread;
        externalFfmpegArgs_ = args;
        externalOutputBuffer_.clear();
        externalInputBuffer_.clear();
        externalFramesSubmitted_ = 0;
        externalPacketCount_ = 0;
        externalFirstPacketLogged_ = false;
        externalForceKeyframeRequested_ = false;
        usingExternalFfmpeg_ = true;

        const DWORD waitResult = WaitForSingleObject(externalProcess_, 25);
        if (waitResult == WAIT_OBJECT_0) {
            DWORD exitCode = 0;
            GetExitCodeProcess(externalProcess_, &exitCode);
            spdlog::warn("[FFmpegEncoder] ffmpeg exited immediately (code={})", exitCode);
            shutdownExternalFfmpegNvenc();
            return false;
        }

        spdlog::info("[FFmpegEncoder] Started FFmpeg pipeline: {} codec={} encoder={}",
                     externalFfmpegPath_.string(),
                     videoCodecName(config_.codec),
                     encoderName);
        return true;
    }

    void shutdownExternalFfmpegNvenc() {
        if (externalStdInWrite_) {
            CloseHandle(externalStdInWrite_);
            externalStdInWrite_ = nullptr;
        }

        if (externalProcess_) {
            DWORD waitResult = WaitForSingleObject(externalProcess_, 1200);
            if (waitResult == WAIT_TIMEOUT) {
                TerminateProcess(externalProcess_, 1);
                WaitForSingleObject(externalProcess_, 500);
            }
        }

        if (externalStdOutRead_) {
            CloseHandle(externalStdOutRead_);
            externalStdOutRead_ = nullptr;
        }
        if (externalThread_) {
            CloseHandle(externalThread_);
            externalThread_ = nullptr;
        }
        if (externalProcess_) {
            CloseHandle(externalProcess_);
            externalProcess_ = nullptr;
        }

        externalOutputBuffer_.clear();
        externalInputBuffer_.clear();
        externalFfmpegArgs_.clear();
        externalFramesSubmitted_ = 0;
        externalPacketCount_ = 0;
        externalFirstPacketLogged_ = false;
        externalForceKeyframeRequested_ = false;
        externalIvfHeaderParsed_ = false;
        externalEncoderName_.clear();
        externalUsingHardware_ = false;
        usingExternalFfmpeg_ = false;
    }

    void restartExternalFfmpegNvenc() {
        if (!usingExternalFfmpeg_) {
            return;
        }
        spdlog::info("[FFmpegEncoder] Restarting FFmpeg pipeline");
        shutdownExternalFfmpegNvenc();
        if (!initializeExternalFfmpegNvenc()) {
            spdlog::warn("[FFmpegEncoder] Failed to restart FFmpeg pipeline");
        }
    }

    bool prepareExternalInputFrame(const CapturedFrame &input) {
        if (input.format != CapturedFrame::Format::BGRA) {
            spdlog::warn("[FFmpegEncoder] Unsupported input pixel format {}", static_cast<int>(input.format));
            return false;
        }
        const int dstW = std::max(1, config_.width);
        const int dstH = std::max(1, config_.height);
        const size_t frameSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH) * 4;
        externalInputBuffer_.resize(frameSize);

        if (input.width == dstW &&
            input.height == dstH &&
            input.stride == dstW * 4 &&
            input.data.size() >= frameSize) {
            std::memcpy(externalInputBuffer_.data(), input.data.data(), frameSize);
            return true;
        }

        if (input.data.empty()) {
            return false;
        }
        convertBGRAtoRGB32(input.data.data(),
                           input.width,
                           input.height,
                           input.stride,
                           externalInputBuffer_.data(),
                           dstW,
                           dstH);
        return true;
    }

    bool readExternalOutputChunk() {
        if (!externalStdOutRead_) {
            return false;
        }
        DWORD available = 0;
        if (!PeekNamedPipe(externalStdOutRead_, nullptr, 0, nullptr, &available, nullptr) || available == 0) {
            return false;
        }

        std::array<uint8_t, 65536> chunk = {};
        const DWORD toRead = std::min<DWORD>(available, static_cast<DWORD>(chunk.size()));
        DWORD bytesRead = 0;
        if (!ReadFile(externalStdOutRead_, chunk.data(), toRead, &bytesRead, nullptr) || bytesRead == 0) {
            return false;
        }
        externalOutputBuffer_.insert(externalOutputBuffer_.end(), chunk.begin(), chunk.begin() + bytesRead);
        return true;
    }

    static size_t findAnnexBStartCode(const std::vector<uint8_t> &data, size_t from, size_t &prefixLength) {
        prefixLength = 0;
        if (data.size() < 4) {
            return std::string::npos;
        }
        for (size_t i = from; i + 3 < data.size(); ++i) {
            if (data[i] == 0 && data[i + 1] == 0) {
                if (data[i + 2] == 1) {
                    prefixLength = 3;
                    return i;
                }
                if (data[i + 2] == 0 && data[i + 3] == 1) {
                    prefixLength = 4;
                    return i;
                }
            }
        }
        return std::string::npos;
    }

    static uint8_t annexBNalType(const std::vector<uint8_t> &packet,
                                 size_t pos,
                                 size_t prefixLength,
                                 VideoCodec codec) {
        if (pos + prefixLength >= packet.size()) {
            return 0;
        }
        if (codec == VideoCodec::H265) {
            return static_cast<uint8_t>((packet[pos + prefixLength] >> 1) & 0x3F);
        }
        return static_cast<uint8_t>(packet[pos + prefixLength] & 0x1F);
    }

    static bool packetContainsKeyframe(const std::vector<uint8_t> &packet, VideoCodec codec) {
        size_t pos = 0;
        size_t prefixLength = 0;
        while ((pos = findAnnexBStartCode(packet, pos, prefixLength)) != std::string::npos) {
            if (pos + prefixLength >= packet.size()) {
                break;
            }
            const uint8_t nalType = annexBNalType(packet, pos, prefixLength, codec);
            if (codec == VideoCodec::H265) {
                if (nalType >= 16 && nalType <= 23) {
                    return true;
                }
            } else {
                if (nalType == 5) {
                    return true;
                }
            }
            pos += prefixLength;
        }
        return false;
    }

    static bool packetContainsVcl(const std::vector<uint8_t> &packet, VideoCodec codec) {
        size_t pos = 0;
        size_t prefixLength = 0;
        while ((pos = findAnnexBStartCode(packet, pos, prefixLength)) != std::string::npos) {
            if (pos + prefixLength >= packet.size()) {
                break;
            }
            const uint8_t nalType = annexBNalType(packet, pos, prefixLength, codec);
            if (codec == VideoCodec::H265) {
                if (nalType <= 31) {
                    return true;
                }
            } else {
                if (nalType == 1 || nalType == 5) {
                    return true;
                }
            }
            pos += prefixLength;
        }
        return false;
    }

    static bool isAnnexBAud(VideoCodec codec, uint8_t nalType) {
        if (codec == VideoCodec::H265) {
            return nalType == 35;
        }
        return nalType == 9;
    }

    bool popExternalAnnexBPacket(EncodedPacket &output) {
        while (!externalOutputBuffer_.empty()) {
            size_t firstAud = std::string::npos;
            size_t secondAud = std::string::npos;
            size_t pos = 0;
            size_t prefixLength = 0;
            while ((pos = findAnnexBStartCode(externalOutputBuffer_, pos, prefixLength)) != std::string::npos) {
                if (pos + prefixLength >= externalOutputBuffer_.size()) {
                    break;
                }
                const uint8_t nalType = annexBNalType(externalOutputBuffer_, pos, prefixLength, config_.codec);
                if (isAnnexBAud(config_.codec, nalType)) {
                    if (firstAud == std::string::npos) {
                        firstAud = pos;
                    } else {
                        secondAud = pos;
                        break;
                    }
                }
                pos += prefixLength;
            }

            size_t packetEnd = std::string::npos;
            if (secondAud != std::string::npos) {
                packetEnd = secondAud;
            } else if (firstAud == std::string::npos && externalOutputBuffer_.size() >= 4096) {
                // Fallback path for builds that do not emit AUD NAL units.
                packetEnd = externalOutputBuffer_.size();
            } else {
                return false;
            }

            if (packetEnd == 0 || packetEnd > externalOutputBuffer_.size()) {
                return false;
            }

            std::vector<uint8_t> candidate(externalOutputBuffer_.begin(),
                                           externalOutputBuffer_.begin() + packetEnd);
            externalOutputBuffer_.erase(externalOutputBuffer_.begin(), externalOutputBuffer_.begin() + packetEnd);
            if (candidate.empty()) {
                continue;
            }

            if (!packetContainsVcl(candidate, config_.codec)) {
                continue;
            }

            output.data = std::move(candidate);
            const int64_t pts = (externalPacketCount_ * 10000000LL) / std::max(1, config_.frameRate);
            output.pts = pts;
            output.dts = pts;
            output.codec = config_.codec;
            output.isKeyframe = packetContainsKeyframe(output.data, config_.codec);
            externalPacketCount_++;

            if (!externalFirstPacketLogged_) {
                spdlog::info("[FFmpegEncoder] First packet encoded successfully, size={}", output.data.size());
                externalFirstPacketLogged_ = true;
            }
            return true;
        }
        return false;
    }

    static uint32_t readLe32(const uint8_t *data) {
        return static_cast<uint32_t>(data[0]) |
               (static_cast<uint32_t>(data[1]) << 8) |
               (static_cast<uint32_t>(data[2]) << 16) |
               (static_cast<uint32_t>(data[3]) << 24);
    }

    bool popExternalIvfPacket(EncodedPacket &output) {
        if (!externalIvfHeaderParsed_) {
            if (externalOutputBuffer_.size() < 32) {
                return false;
            }
            if (!(externalOutputBuffer_[0] == 'D' &&
                  externalOutputBuffer_[1] == 'K' &&
                  externalOutputBuffer_[2] == 'I' &&
                  externalOutputBuffer_[3] == 'F')) {
                spdlog::warn("[FFmpegEncoder] Unexpected IVF stream header");
                return false;
            }
            externalOutputBuffer_.erase(externalOutputBuffer_.begin(), externalOutputBuffer_.begin() + 32);
            externalIvfHeaderParsed_ = true;
        }

        if (externalOutputBuffer_.size() < 12) {
            return false;
        }
        const uint32_t frameSize = readLe32(externalOutputBuffer_.data());
        if (frameSize == 0) {
            externalOutputBuffer_.erase(externalOutputBuffer_.begin(), externalOutputBuffer_.begin() + 12);
            return false;
        }
        if (externalOutputBuffer_.size() < static_cast<size_t>(12 + frameSize)) {
            return false;
        }

        output.data.assign(externalOutputBuffer_.begin() + 12,
                           externalOutputBuffer_.begin() + 12 + frameSize);
        externalOutputBuffer_.erase(externalOutputBuffer_.begin(),
                                    externalOutputBuffer_.begin() + 12 + frameSize);
        output.pts = (externalPacketCount_ * 10000000LL) / std::max(1, config_.frameRate);
        output.dts = output.pts;
        output.codec = config_.codec;
        output.isKeyframe = true;
        externalPacketCount_++;

        if (!externalFirstPacketLogged_) {
            spdlog::info("[FFmpegEncoder] First packet encoded successfully, size={}", output.data.size());
            externalFirstPacketLogged_ = true;
        }
        return true;
    }

    bool popExternalPacket(EncodedPacket &output) {
        if (externalOutputFormat_ == ExternalOutputFormat::Ivf) {
            return popExternalIvfPacket(output);
        }
        return popExternalAnnexBPacket(output);
    }

    bool encodeExternalFfmpegNvenc(const CapturedFrame &input, EncodedPacket &output) {
        if (!usingExternalFfmpeg_ || !externalStdInWrite_ || !externalStdOutRead_ || !externalProcess_) {
            return false;
        }

        if (externalForceKeyframeRequested_) {
            externalForceKeyframeRequested_ = false;
            restartExternalFfmpegNvenc();
            if (!usingExternalFfmpeg_) {
                return false;
            }
        }

        if (WaitForSingleObject(externalProcess_, 0) == WAIT_OBJECT_0) {
            DWORD exitCode = 0;
            GetExitCodeProcess(externalProcess_, &exitCode);
            spdlog::warn("[FFmpegEncoder] ffmpeg process exited unexpectedly (code={})", exitCode);
            shutdownExternalFfmpegNvenc();
            return false;
        }

        if (!prepareExternalInputFrame(input)) {
            return false;
        }

        DWORD bytesWritten = 0;
        const DWORD frameBytes = static_cast<DWORD>(externalInputBuffer_.size());
        const BOOL writeOk = WriteFile(externalStdInWrite_,
                                       externalInputBuffer_.data(),
                                       frameBytes,
                                       &bytesWritten,
                                       nullptr);
        if (!writeOk || bytesWritten != frameBytes) {
            spdlog::warn("[FFmpegEncoder] Failed to write frame to ffmpeg stdin");
            restartExternalFfmpegNvenc();
            return false;
        }
        externalFramesSubmitted_++;

        const int waitBudgetMs = std::max(8, (2000 / std::max(1, config_.frameRate)));
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(waitBudgetMs);
        while (std::chrono::steady_clock::now() < deadline) {
            bool readAny = false;
            while (readExternalOutputChunk()) {
                readAny = true;
            }
            if (popExternalPacket(output)) {
                return true;
            }
            if (!readAny) {
                if (WaitForSingleObject(externalProcess_, 0) == WAIT_OBJECT_0) {
                    break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
        }

        while (readExternalOutputChunk()) {
        }
        return popExternalPacket(output);
    }

  private:
    struct EncoderCandidate {
        ComPtr<IMFActivate> activate;
        std::string name;
        bool hardware = false;
    };

    enum class InputPacking {
        NV12,
        I420,
        YV12,
        RGB32,
        Unsupported
    };

    enum class ExternalOutputFormat {
        AnnexB,
        Ivf
    };

    static std::string toLowerCopy(std::string value) {
        std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        return value;
    }

    static std::string subtypeName(const GUID &subtype) {
        if (subtype == MFVideoFormat_NV12) return "NV12";
        if (subtype == MFVideoFormat_IYUV) return "IYUV";
        if (subtype == MFVideoFormat_YV12) return "YV12";
        if (subtype == MFVideoFormat_YUY2) return "YUY2";
        if (subtype == MFVideoFormat_UYVY) return "UYVY";
        if (subtype == MFVideoFormat_RGB32) return "RGB32";
        if (subtype == MFVideoFormat_ARGB32) return "ARGB32";
        char buffer[64];
        std::snprintf(buffer, sizeof(buffer), "{%08lx-%04x-%04x}",
                      static_cast<unsigned long>(subtype.Data1),
                      subtype.Data2,
                      subtype.Data3);
        return buffer;
    }

    static int inputPriority(const GUID &subtype) {
        if (subtype == MFVideoFormat_NV12) return 0;
        if (subtype == MFVideoFormat_IYUV) return 1;
        if (subtype == MFVideoFormat_YV12) return 2;
        if (subtype == MFVideoFormat_ARGB32 || subtype == MFVideoFormat_RGB32) return 3;
        if (subtype == MFVideoFormat_YUY2 || subtype == MFVideoFormat_UYVY) return 4;
        return 100;
    }

    static InputPacking inputPackingFromSubtype(const GUID &subtype) {
        if (subtype == MFVideoFormat_NV12) return InputPacking::NV12;
        if (subtype == MFVideoFormat_IYUV) return InputPacking::I420;
        if (subtype == MFVideoFormat_YV12) return InputPacking::YV12;
        if (subtype == MFVideoFormat_ARGB32 || subtype == MFVideoFormat_RGB32) return InputPacking::RGB32;
        return InputPacking::Unsupported;
    }

    DWORD sampleSizeForSubtype(const GUID &subtype) const {
        const DWORD width = static_cast<DWORD>(std::max(1, config_.width));
        const DWORD height = static_cast<DWORD>(std::max(1, config_.height));
        if (subtype == MFVideoFormat_NV12 || subtype == MFVideoFormat_IYUV || subtype == MFVideoFormat_YV12) {
            return width * height * 3 / 2;
        }
        if (subtype == MFVideoFormat_ARGB32 || subtype == MFVideoFormat_RGB32) {
            return width * height * 4;
        }
        return width * height * 3 / 2;
    }

    void setCommonFrameAttributes(IMFMediaType *type) {
        if (!type) {
            return;
        }
        MFSetAttributeSize(type, MF_MT_FRAME_SIZE, std::max(1, config_.width), std::max(1, config_.height));
        MFSetAttributeRatio(type, MF_MT_FRAME_RATE, std::max(1, config_.frameRate), 1);
        MFSetAttributeRatio(type, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    }

    void configureOutputType(IMFMediaType *type) {
        if (!type) {
            return;
        }
        type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        setCommonFrameAttributes(type);
        type->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(std::max(1, config_.bitrate) * 1000));
        if (!usingHardware_) {
            type->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base);
        }
    }

    void configureInputType(IMFMediaType *type, const GUID &subtype) {
        if (!type) {
            return;
        }
        type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        type->SetGUID(MF_MT_SUBTYPE, subtype);
        setCommonFrameAttributes(type);
        type->SetUINT32(MF_MT_SAMPLE_SIZE, sampleSizeForSubtype(subtype));
        type->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
        type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);

        LONG stride = 0;
        if (SUCCEEDED(MFGetStrideForBitmapInfoHeader(subtype.Data1, std::max(1, config_.width), &stride))) {
            type->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(stride));
        }
    }

    bool chooseOutputType(ComPtr<IMFMediaType> &outType) {
        HRESULT hr = S_OK;
        for (DWORD i = 0; i < 64; ++i) {
            ComPtr<IMFMediaType> available;
            hr = transform_->GetOutputAvailableType(0, i, &available);
            if (hr == MF_E_NO_MORE_TYPES) {
                break;
            }
            if (FAILED(hr) || !available) {
                continue;
            }

            GUID subtype = {};
            if (FAILED(available->GetGUID(MF_MT_SUBTYPE, &subtype)) || subtype != MFVideoFormat_H264) {
                continue;
            }

            ComPtr<IMFMediaType> candidate;
            if (FAILED(MFCreateMediaType(&candidate))) {
                continue;
            }
            available->CopyAllItems(candidate.Get());
            configureOutputType(candidate.Get());

            hr = transform_->SetOutputType(0, candidate.Get(), MFT_SET_TYPE_TEST_ONLY);
            if (SUCCEEDED(hr)) {
                outType = candidate;
                spdlog::info("[VideoEncoder] Using output type index {} subtype={}", i, subtypeName(subtype));
                return true;
            }
        }

        ComPtr<IMFMediaType> fallback;
        if (FAILED(MFCreateMediaType(&fallback))) {
            return false;
        }
        configureOutputType(fallback.Get());
        hr = transform_->SetOutputType(0, fallback.Get(), MFT_SET_TYPE_TEST_ONLY);
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] No compatible H264 output type (hr=0x{:08x})", static_cast<unsigned>(hr));
            return false;
        }
        outType = fallback;
        return true;
    }

    bool chooseInputType(ComPtr<IMFMediaType> &outType, GUID &outSubtype) {
        HRESULT hr = S_OK;
        int bestPriority = 999;

        for (DWORD i = 0; i < 64; ++i) {
            ComPtr<IMFMediaType> available;
            hr = transform_->GetInputAvailableType(0, i, &available);
            if (hr == MF_E_NO_MORE_TYPES) {
                break;
            }
            if (FAILED(hr)) {
                spdlog::warn("[VideoEncoder] GetInputAvailableType {} failed hr=0x{:08x}",
                             i, static_cast<unsigned>(hr));
                continue;
            }
            if (!available) {
                continue;
            }

            GUID subtype = {};
            if (FAILED(available->GetGUID(MF_MT_SUBTYPE, &subtype))) {
                continue;
            }

            ComPtr<IMFMediaType> candidate;
            if (FAILED(MFCreateMediaType(&candidate))) {
                continue;
            }
            available->CopyAllItems(candidate.Get());
            configureInputType(candidate.Get(), subtype);

            hr = transform_->SetInputType(0, candidate.Get(), MFT_SET_TYPE_TEST_ONLY);
            if (FAILED(hr)) {
                spdlog::warn("[VideoEncoder] Reject input type idx={} subtype={} hr=0x{:08x}",
                             i, subtypeName(subtype), static_cast<unsigned>(hr));
                continue;
            }

            const int priority = inputPriority(subtype);
            spdlog::info("[VideoEncoder] Accept input type idx={} subtype={} priority={}",
                         i, subtypeName(subtype), priority);
            if (priority < bestPriority) {
                bestPriority = priority;
                outSubtype = subtype;
                outType = candidate;
            }
        }

        if (outType) {
            return true;
        }

        const std::array<GUID, 5> manualTypes = {
            MFVideoFormat_NV12,
            MFVideoFormat_IYUV,
            MFVideoFormat_YV12,
            MFVideoFormat_ARGB32,
            MFVideoFormat_RGB32
        };

        for (const GUID &subtype : manualTypes) {
            ComPtr<IMFMediaType> candidate;
            if (FAILED(MFCreateMediaType(&candidate))) {
                continue;
            }
            configureInputType(candidate.Get(), subtype);
            hr = transform_->SetInputType(0, candidate.Get(), MFT_SET_TYPE_TEST_ONLY);
            if (SUCCEEDED(hr)) {
                outSubtype = subtype;
                outType = candidate;
                spdlog::info("[VideoEncoder] Manual input fallback accepted subtype={}", subtypeName(subtype));
                return true;
            }
            spdlog::warn("[VideoEncoder] Manual input fallback rejected subtype={} hr=0x{:08x}",
                         subtypeName(subtype), static_cast<unsigned>(hr));
        }

        return false;
    }

    bool setCodecApiUi4(const GUID &api, ULONG value, const char *label = nullptr) {
        if (!codecApi_) {
            return false;
        }
        VARIANT v;
        VariantInit(&v);
        v.vt = VT_UI4;
        v.ulVal = value;
        const HRESULT hr = codecApi_->SetValue(&api, &v);
        VariantClear(&v);
        if (SUCCEEDED(hr)) {
            if (label) {
                spdlog::info("[VideoEncoder] {} {}", label, value / 1000);
            }
            return true;
        }
        return false;
    }

    void configureCodecApi() {
        if (codecApi_) {
            codecApi_->Release();
            codecApi_ = nullptr;
        }
        if (!transform_) {
            return;
        }

        ICodecAPI *codecApi = nullptr;
        HRESULT hr = transform_->QueryInterface(IID_PPV_ARGS(&codecApi));
        if (FAILED(hr) || !codecApi) {
            spdlog::warn("[VideoEncoder] Could not get ICodecAPI interface");
            return;
        }

        codecApi_ = codecApi;
        const ULONG gopSize = static_cast<ULONG>(std::max(1, config_.gopSize));
        if (!setCodecApiUi4(CODECAPI_AVEncMPVGOPSize, gopSize)) {
            spdlog::warn("[VideoEncoder] Failed to set GOP size");
        }

        VARIANT lowLatency;
        VariantInit(&lowLatency);
        lowLatency.vt = VT_BOOL;
        lowLatency.boolVal = config_.lowLatency ? VARIANT_TRUE : VARIANT_FALSE;
        hr = codecApi_->SetValue(&CODECAPI_AVLowLatencyMode, &lowLatency);
        VariantClear(&lowLatency);
        if (FAILED(hr)) {
            spdlog::debug("[VideoEncoder] AVLowLatencyMode unsupported hr=0x{:08x}", static_cast<unsigned>(hr));
        }

        setCodecApiUi4(CODECAPI_AVEncCommonMeanBitRate, static_cast<ULONG>(std::max(1, config_.bitrate) * 1000));
        const int maxKbps = std::max(config_.maxBitrate, config_.bitrate);
        setCodecApiUi4(CODECAPI_AVEncCommonMaxBitRate, static_cast<ULONG>(std::max(1, maxKbps) * 1000));
    }

    bool configureTransform() {
        if (!transform_) {
            return false;
        }

        unlockAsyncMft();
        if (usingHardware_) {
            attachDxgiDeviceManager();
        }
        detectAsyncMode();
        configureCodecApi();

        ComPtr<IMFMediaType> outputType;
        if (!chooseOutputType(outputType)) {
            return false;
        }

        HRESULT hr = transform_->SetOutputType(0, outputType.Get(), 0);
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] SetOutputType failed hr=0x{:08x}", static_cast<unsigned>(hr));
            return false;
        }
        spdlog::info("[VideoEncoder] Output type set successfully");

        ComPtr<IMFMediaType> inputType;
        GUID selectedSubtype = MFVideoFormat_NV12;
        if (!chooseInputType(inputType, selectedSubtype)) {
            spdlog::error("[VideoEncoder] No compatible input type found");
            return false;
        }

        hr = transform_->SetInputType(0, inputType.Get(), 0);
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] SetInputType failed hr=0x{:08x}", static_cast<unsigned>(hr));
            return false;
        }

        inputSubtype_ = selectedSubtype;
        spdlog::info("[VideoEncoder] Input type set: {}", subtypeName(inputSubtype_));

        hr = transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] BEGIN_STREAMING message failed hr=0x{:08x}", static_cast<unsigned>(hr));
        }
        hr = transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] START_OF_STREAM message failed hr=0x{:08x}", static_cast<unsigned>(hr));
        }
        streamStarted_ = true;
        if (asyncMft_) {
            pumpAsyncEvents();
        }
        return true;
    }

    bool runWarmupProbe() {
        CapturedFrame probeFrame;
        probeFrame.width = std::max(1, config_.width);
        probeFrame.height = std::max(1, config_.height);
        probeFrame.stride = probeFrame.width * 4;
        probeFrame.timestamp = 0;
        probeFrame.format = CapturedFrame::Format::BGRA;
        probeFrame.data.assign(static_cast<size_t>(probeFrame.stride) * probeFrame.height, 0);

        EncodedPacket probePacket;
        constexpr int kMaxProbeFrames = 18;
        for (int i = 0; i < kMaxProbeFrames; ++i) {
            if (encode(probeFrame, probePacket) && !probePacket.data.empty()) {
                spdlog::info("[VideoEncoder] Warm-up probe produced encoded data on frame {}", i + 1);
                return true;
            }
        }
        spdlog::warn("[VideoEncoder] Warm-up probe produced no encoded output");
        return false;
    }

    bool ensureComInitialized() {
        if (comInitialized_) {
            return true;
        }
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (hr == RPC_E_CHANGED_MODE) {
            hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        }
        if (FAILED(hr)) {
            spdlog::error("[VideoEncoder] CoInitializeEx failed hr=0x{:08x}", static_cast<unsigned>(hr));
            return false;
        }
        comInitialized_ = true;
        return true;
    }

    void releaseCom() {
        if (!comInitialized_) {
            return;
        }
        CoUninitialize();
        comInitialized_ = false;
    }

    void shutdownMf() {
        dxgiDeviceManager_.Reset();
        d3dContext_.Reset();
        d3dDevice_.Reset();
        dxgiResetToken_ = 0;
        if (mfStarted_) {
            MFShutdown();
            mfStarted_ = false;
        }
    }

    void unlockAsyncMft() {
        if (!transform_) {
            return;
        }
        ComPtr<IMFAttributes> attrs;
        HRESULT hr = transform_->GetAttributes(attrs.ReleaseAndGetAddressOf());
        if (FAILED(hr) || !attrs) {
            return;
        }

        UINT32 isAsync = 0;
        hr = attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync);
        if (FAILED(hr) || !isAsync) {
            return;
        }

        hr = attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
        if (SUCCEEDED(hr)) {
            spdlog::info("[VideoEncoder] Enabled async unlock for '{}'", activeEncoderName_);
        } else {
            spdlog::warn("[VideoEncoder] Failed to unlock async transform '{}' hr=0x{:08x}",
                         activeEncoderName_,
                         static_cast<unsigned>(hr));
        }
    }

    bool ensureDxgiDeviceManager() {
        if (dxgiDeviceManager_) {
            return true;
        }

        D3D_FEATURE_LEVEL featureLevels[] = {
            D3D_FEATURE_LEVEL_11_1,
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0
        };
        D3D_FEATURE_LEVEL createdFeature = D3D_FEATURE_LEVEL_11_0;
        const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;

        HRESULT hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            d3dDevice_.ReleaseAndGetAddressOf(),
            &createdFeature,
            d3dContext_.ReleaseAndGetAddressOf());
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] D3D11CreateDevice(HARDWARE) failed hr=0x{:08x}", static_cast<unsigned>(hr));
            hr = D3D11CreateDevice(
                nullptr,
                D3D_DRIVER_TYPE_WARP,
                nullptr,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                featureLevels,
                ARRAYSIZE(featureLevels),
                D3D11_SDK_VERSION,
                d3dDevice_.ReleaseAndGetAddressOf(),
                &createdFeature,
                d3dContext_.ReleaseAndGetAddressOf());
        }
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] Failed to create D3D11 device for MFT hr=0x{:08x}", static_cast<unsigned>(hr));
            return false;
        }

        hr = MFCreateDXGIDeviceManager(&dxgiResetToken_, dxgiDeviceManager_.ReleaseAndGetAddressOf());
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] MFCreateDXGIDeviceManager failed hr=0x{:08x}", static_cast<unsigned>(hr));
            dxgiDeviceManager_.Reset();
            d3dContext_.Reset();
            d3dDevice_.Reset();
            dxgiResetToken_ = 0;
            return false;
        }

        hr = dxgiDeviceManager_->ResetDevice(d3dDevice_.Get(), dxgiResetToken_);
        if (FAILED(hr)) {
            spdlog::warn("[VideoEncoder] IMFDXGIDeviceManager::ResetDevice failed hr=0x{:08x}", static_cast<unsigned>(hr));
            dxgiDeviceManager_.Reset();
            d3dContext_.Reset();
            d3dDevice_.Reset();
            dxgiResetToken_ = 0;
            return false;
        }

        spdlog::info("[VideoEncoder] DXGI device manager ready (D3D feature level=0x{:x})",
                     static_cast<unsigned>(createdFeature));
        return true;
    }

    void attachDxgiDeviceManager() {
        if (!transform_ || !usingHardware_) {
            return;
        }
        if (!ensureDxgiDeviceManager()) {
            return;
        }
        const HRESULT hr = transform_->ProcessMessage(
            MFT_MESSAGE_SET_D3D_MANAGER,
            reinterpret_cast<ULONG_PTR>(dxgiDeviceManager_.Get()));
        if (SUCCEEDED(hr)) {
            spdlog::info("[VideoEncoder] Attached DXGI manager to '{}'", activeEncoderName_);
        } else {
            spdlog::warn("[VideoEncoder] Failed to attach DXGI manager to '{}' hr=0x{:08x}",
                         activeEncoderName_,
                         static_cast<unsigned>(hr));
        }
    }

    void detectAsyncMode() {
        asyncMft_ = false;
        pendingNeedInputEvents_ = 0;
        pendingHaveOutputEvents_ = 0;
        eventGenerator_.Reset();

        if (!transform_) {
            return;
        }
        ComPtr<IMFAttributes> attrs;
        HRESULT hr = transform_->GetAttributes(attrs.ReleaseAndGetAddressOf());
        if (FAILED(hr) || !attrs) {
            return;
        }

        UINT32 isAsync = 0;
        hr = attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync);
        if (FAILED(hr) || !isAsync) {
            return;
        }

        // Intel Quick Sync async MFT can stall under repeated connect/disconnect churn.
        // Prefer synchronous ProcessInput/ProcessOutput mode for stability.
        const std::string encoderLower = toLowerCopy(activeEncoderName_);
        if (encoderLower.find("quick sync") != std::string::npos) {
            spdlog::info("[VideoEncoder] Forcing synchronous MFT mode for '{}'", activeEncoderName_);
            return;
        }

        hr = transform_->QueryInterface(IID_PPV_ARGS(eventGenerator_.ReleaseAndGetAddressOf()));
        if (FAILED(hr) || !eventGenerator_) {
            spdlog::warn("[VideoEncoder] Async MFT detected but IMFMediaEventGenerator unavailable hr=0x{:08x}",
                         static_cast<unsigned>(hr));
            return;
        }

        asyncMft_ = true;
        spdlog::info("[VideoEncoder] Async MFT mode enabled for '{}'", activeEncoderName_);
    }

    void pumpAsyncEvents() {
        if (!asyncMft_ || !eventGenerator_) {
            return;
        }

        for (;;) {
            ComPtr<IMFMediaEvent> event;
            const HRESULT hr = eventGenerator_->GetEvent(MF_EVENT_FLAG_NO_WAIT, event.ReleaseAndGetAddressOf());
            if (hr == MF_E_NO_EVENTS_AVAILABLE) {
                return;
            }
            if (FAILED(hr) || !event) {
                return;
            }

            MediaEventType type = MEUnknown;
            event->GetType(&type);
            HRESULT status = S_OK;
            event->GetStatus(&status);
            if (FAILED(status)) {
                spdlog::warn("[VideoEncoder] Async event status failure type={} hr=0x{:08x}",
                             static_cast<unsigned>(type), static_cast<unsigned>(status));
            }

            if (type == METransformNeedInput) {
                pendingNeedInputEvents_++;
            } else if (type == METransformHaveOutput) {
                pendingHaveOutputEvents_++;
            } else if (type == MEError) {
                spdlog::warn("[VideoEncoder] Async MFT error event hr=0x{:08x}", static_cast<unsigned>(status));
            }
        }
    }

    void resetCurrentTransform() {
        if (codecApi_) {
            codecApi_->Release();
            codecApi_ = nullptr;
        }
        asyncMft_ = false;
        pendingNeedInputEvents_ = 0;
        pendingHaveOutputEvents_ = 0;
        eventGenerator_.Reset();
        if (transform_) {
            if (streamStarted_) {
                transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                transform_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
                transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
            transform_.Reset();
        }
        streamStarted_ = false;
    }

    bool prepareInputBuffer(const CapturedFrame &input, std::vector<uint8_t> &out) {
        const int dstW = std::max(1, config_.width);
        const int dstH = std::max(1, config_.height);
        const InputPacking packing = inputPackingFromSubtype(inputSubtype_);

        if (input.format == CapturedFrame::Format::BGRA) {
            if (packing == InputPacking::NV12) {
                out.resize(static_cast<size_t>(dstW) * dstH * 3 / 2);
                convertBGRAtoNV12(input.data.data(), input.width, input.height, input.stride,
                                  out.data(), dstW, dstH);
                return true;
            }
            if (packing == InputPacking::I420 || packing == InputPacking::YV12) {
                out.resize(static_cast<size_t>(dstW) * dstH * 3 / 2);
                uint8_t *yPlane = out.data();
                uint8_t *uPlane = yPlane + (dstW * dstH);
                uint8_t *vPlane = uPlane + (dstW * dstH) / 4;
                if (packing == InputPacking::YV12) {
                    std::swap(uPlane, vPlane);
                }
                convertBGRAtoI420(input.data.data(), input.width, input.height, input.stride,
                                  yPlane, uPlane, vPlane, dstW, dstH);
                return true;
            }
            if (packing == InputPacking::RGB32) {
                out.resize(static_cast<size_t>(dstW) * dstH * 4);
                convertBGRAtoRGB32(input.data.data(), input.width, input.height, input.stride,
                                   out.data(), dstW, dstH);
                return true;
            }
        } else if (input.format == CapturedFrame::Format::NV12 && packing == InputPacking::NV12) {
            out = input.data;
            return true;
        } else if (input.format == CapturedFrame::Format::I420 &&
                   (packing == InputPacking::I420 || packing == InputPacking::YV12)) {
            out = input.data;
            if (packing == InputPacking::YV12 && out.size() >= static_cast<size_t>(dstW) * dstH * 3 / 2) {
                const size_t planeSize = static_cast<size_t>(dstW) * dstH / 4;
                uint8_t *uPlane = out.data() + (static_cast<size_t>(dstW) * dstH);
                uint8_t *vPlane = uPlane + planeSize;
                for (size_t i = 0; i < planeSize; ++i) {
                    std::swap(uPlane[i], vPlane[i]);
                }
            }
            return true;
        }

        spdlog::error("[VideoEncoder] Unsupported input conversion path frameFormat={} subtype={}",
                      static_cast<int>(input.format), subtypeName(inputSubtype_));
        return false;
    }

    static bool matchesPreferredHardware(const std::string &encoderName, HardwareEncoder preferred) {
        const std::string lower = toLowerCopy(encoderName);
        switch (preferred) {
            case HardwareEncoder::NVENC:
                return lower.find("nvidia") != std::string::npos ||
                       lower.find("nvenc") != std::string::npos ||
                       lower.find("geforce") != std::string::npos;
            case HardwareEncoder::QuickSync:
                return lower.find("intel") != std::string::npos ||
                       lower.find("quick sync") != std::string::npos ||
                       lower.find("qsv") != std::string::npos;
            case HardwareEncoder::AMF:
                return lower.find("amd") != std::string::npos ||
                       lower.find("radeon") != std::string::npos ||
                       lower.find("amf") != std::string::npos;
            case HardwareEncoder::None:
            default:
                return false;
        }
    }

    static std::vector<EncoderCandidate> enumerateEncoders(DWORD flags, bool hardware,
                                                           const MFT_REGISTER_TYPE_INFO *inputType,
                                                           const MFT_REGISTER_TYPE_INFO *outputType) {
        IMFActivate **activates = nullptr;
        UINT32 count = 0;
        HRESULT hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags,
                               const_cast<MFT_REGISTER_TYPE_INFO *>(inputType),
                               const_cast<MFT_REGISTER_TYPE_INFO *>(outputType),
                               &activates, &count);
        if (FAILED(hr) || count == 0) {
            return {};
        }

        std::vector<EncoderCandidate> encoders;
        encoders.reserve(count);
        for (UINT32 i = 0; i < count; ++i) {
            EncoderCandidate candidate;
            candidate.hardware = hardware;
            candidate.activate = activates[i];

            UINT32 nameLen = 0;
            if (SUCCEEDED(activates[i]->GetStringLength(MFT_FRIENDLY_NAME_Attribute, &nameLen)) && nameLen > 0) {
                std::wstring wideName(nameLen + 1, L'\0');
                if (SUCCEEDED(activates[i]->GetString(MFT_FRIENDLY_NAME_Attribute, wideName.data(), nameLen + 1, nullptr))) {
                    if (!wideName.empty() && wideName.back() == L'\0') {
                        wideName.pop_back();
                    }
                    candidate.name.assign(wideName.begin(), wideName.end());
                }
            }
            if (candidate.name.empty()) {
                candidate.name = hardware ? "Hardware H264 Encoder" : "Software H264 Encoder";
            }
            encoders.push_back(std::move(candidate));
        }

        for (UINT32 i = 0; i < count; ++i) {
            activates[i]->Release();
        }
        CoTaskMemFree(activates);
        return encoders;
    }

    std::vector<EncoderCandidate> orderedEncoderCandidates() {
        MFT_REGISTER_TYPE_INFO outputType = {MFMediaType_Video, MFVideoFormat_H264};

        const DWORD hardwareFlags = MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_HARDWARE;
        const DWORD softwareFlags = MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER;

        std::vector<EncoderCandidate> hardwareEncoders = enumerateEncoders(hardwareFlags, true, nullptr, &outputType);
        std::vector<EncoderCandidate> softwareEncoders = enumerateEncoders(softwareFlags, false, nullptr, &outputType);

        spdlog::info("[VideoEncoder] Encoder candidates: hardware={}, software={}",
                     hardwareEncoders.size(), softwareEncoders.size());
        for (const auto &candidate : hardwareEncoders) {
            spdlog::info("[VideoEncoder] Hardware candidate: {}", candidate.name);
        }
        for (const auto &candidate : softwareEncoders) {
            spdlog::info("[VideoEncoder] Software candidate: {}", candidate.name);
        }

        const HardwareEncoder preferred = config_.preferredHardware;
        std::vector<EncoderCandidate> ordered;
        ordered.reserve(hardwareEncoders.size() + softwareEncoders.size());

        auto appendMatching = [&](const std::vector<EncoderCandidate> &src, auto predicate) {
            for (const auto &candidate : src) {
                if (predicate(candidate)) {
                    ordered.push_back(candidate);
                }
            }
        };

        if (preferred == HardwareEncoder::None) {
            appendMatching(softwareEncoders, [](const EncoderCandidate &) { return true; });
            appendMatching(hardwareEncoders, [](const EncoderCandidate &) { return true; });
        } else {
            // Try preferred hardware first, then any other hardware, then software fallback.
            appendMatching(hardwareEncoders, [&](const EncoderCandidate &candidate) {
                return matchesPreferredHardware(candidate.name, preferred);
            });
            appendMatching(hardwareEncoders, [&](const EncoderCandidate &candidate) {
                return !matchesPreferredHardware(candidate.name, preferred);
            });
            appendMatching(softwareEncoders, [](const EncoderCandidate &) { return true; });
        }

        return ordered;
    }

    void convertBGRAtoNV12(const uint8_t* bgra, int srcW, int srcH, int srcStride,
                          uint8_t* nv12, int dstW, int dstH) {
        const size_t scratchSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH) * 4;
        if (conversionScratchBgra_.size() != scratchSize) {
            conversionScratchBgra_.resize(scratchSize);
        }
        blitBgraAspectFit(bgra, srcW, srcH, srcStride,
                          conversionScratchBgra_.data(), dstW, dstH, dstW * 4);

        uint8_t* yPlane = nv12;
        uint8_t* uvPlane = nv12 + dstW * dstH;
        std::fill(yPlane, yPlane + (dstW * dstH), static_cast<uint8_t>(16));
        std::fill(uvPlane, uvPlane + (dstW * dstH / 2), static_cast<uint8_t>(128));

        for (int y = 0; y < dstH; y++) {
            for (int x = 0; x < dstW; x++) {
                const uint8_t* pixel = conversionScratchBgra_.data() +
                                       (static_cast<size_t>(y) * dstW + x) * 4;
                uint8_t b = pixel[0];
                uint8_t g = pixel[1];
                uint8_t r = pixel[2];

                // BT.601 conversion
                int yVal = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                yPlane[y * dstW + x] = (uint8_t)std::clamp(yVal, 0, 255);
            }
        }

        for (int y = 0; y + 1 < dstH; y += 2) {
            for (int x = 0; x + 1 < dstW; x += 2) {
                const uint8_t* pixel = conversionScratchBgra_.data() +
                                       (static_cast<size_t>(y) * dstW + x) * 4;
                const int b = pixel[0];
                const int g = pixel[1];
                const int r = pixel[2];
                const int u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                const int v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                const int uvIndex = (y / 2) * dstW + x;
                uvPlane[uvIndex] = static_cast<uint8_t>(std::clamp(u, 0, 255));
                uvPlane[uvIndex + 1] = static_cast<uint8_t>(std::clamp(v, 0, 255));
            }
        }
    }

    void convertBGRAtoI420(const uint8_t *bgra, int srcW, int srcH, int srcStride,
                           uint8_t *yPlane, uint8_t *uPlane, uint8_t *vPlane,
                           int dstW, int dstH) {
        const size_t scratchSize = static_cast<size_t>(dstW) * static_cast<size_t>(dstH) * 4;
        if (conversionScratchBgra_.size() != scratchSize) {
            conversionScratchBgra_.resize(scratchSize);
        }
        blitBgraAspectFit(bgra, srcW, srcH, srcStride,
                          conversionScratchBgra_.data(), dstW, dstH, dstW * 4);

        std::fill(yPlane, yPlane + (dstW * dstH), static_cast<uint8_t>(16));
        std::fill(uPlane, uPlane + (dstW * dstH / 4), static_cast<uint8_t>(128));
        std::fill(vPlane, vPlane + (dstW * dstH / 4), static_cast<uint8_t>(128));

        for (int y = 0; y < dstH; ++y) {
            for (int x = 0; x < dstW; ++x) {
                const uint8_t *pixel = conversionScratchBgra_.data() +
                                       (static_cast<size_t>(y) * dstW + x) * 4;
                const int b = pixel[0];
                const int g = pixel[1];
                const int r = pixel[2];
                const int yVal = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                yPlane[y * dstW + x] = static_cast<uint8_t>(std::clamp(yVal, 0, 255));
            }
        }

        for (int y = 0; y + 1 < dstH; y += 2) {
            for (int x = 0; x + 1 < dstW; x += 2) {
                const uint8_t *pixel = conversionScratchBgra_.data() +
                                       (static_cast<size_t>(y) * dstW + x) * 4;
                const int b = pixel[0];
                const int g = pixel[1];
                const int r = pixel[2];

                const int u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                const int v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                const int chromaIndex = (y / 2) * (dstW / 2) + (x / 2);
                uPlane[chromaIndex] = static_cast<uint8_t>(std::clamp(u, 0, 255));
                vPlane[chromaIndex] = static_cast<uint8_t>(std::clamp(v, 0, 255));
            }
        }
    }

    void convertBGRAtoRGB32(const uint8_t *bgra, int srcW, int srcH, int srcStride,
                            uint8_t *dst, int dstW, int dstH) {
        blitBgraAspectFit(bgra, srcW, srcH, srcStride, dst, dstW, dstH, dstW * 4);
    }

    EncoderConfig config_{};
    ComPtr<IMFTransform> transform_;
    ComPtr<ID3D11Device> d3dDevice_;
    ComPtr<ID3D11DeviceContext> d3dContext_;
    ComPtr<IMFDXGIDeviceManager> dxgiDeviceManager_;
    ComPtr<IMFMediaEventGenerator> eventGenerator_;
    ICodecAPI* codecApi_ = nullptr;
    GUID inputSubtype_ = MFVideoFormat_NV12;
    UINT dxgiResetToken_ = 0;
    bool comInitialized_ = false;
    bool asyncMft_ = false;
    bool mfStarted_ = false;
    bool initialized_ = false;
    bool usingHardware_ = false;
    bool streamStarted_ = false;
    bool usingExternalFfmpeg_ = false;
    bool externalForceKeyframeRequested_ = false;
    bool externalFirstPacketLogged_ = false;
    bool externalIvfHeaderParsed_ = false;
    int pendingNeedInputEvents_ = 0;
    int pendingHaveOutputEvents_ = 0;
    int64_t frameCount_ = 0;
    int64_t externalFramesSubmitted_ = 0;
    int64_t externalPacketCount_ = 0;
    ExternalOutputFormat externalOutputFormat_ = ExternalOutputFormat::AnnexB;
    bool externalUsingHardware_ = false;
    std::filesystem::path externalFfmpegPath_;
    std::vector<std::string> externalFfmpegArgs_;
    std::vector<uint8_t> externalInputBuffer_;
    std::vector<uint8_t> externalOutputBuffer_;
    std::vector<uint8_t> conversionScratchBgra_;
    HANDLE externalStdInWrite_ = nullptr;
    HANDLE externalStdOutRead_ = nullptr;
    HANDLE externalProcess_ = nullptr;
    HANDLE externalThread_ = nullptr;
    std::string externalEncoderName_;
    std::string activeEncoderName_;
    VideoCodec activeCodec_ = VideoCodec::H264;
};

#else
// Non-Windows stub
class VideoEncoder::Impl {
  public:
    bool initialize(const EncoderConfig &) { return false; }
    void shutdown() {}
    bool encode(const CapturedFrame &, EncodedPacket &) { return false; }
    void setBitrate(int) {}
    void requestKeyframe() {}
    VideoCodec activeCodec() const { return VideoCodec::H264; }
    std::string activeCodecName() const { return "H.264"; }
    std::string activeEncoderName() const { return "unavailable"; }
    bool isHardwareEncoder() const { return false; }
};
#endif

#endif

VideoEncoder::VideoEncoder() : impl_(std::make_unique<Impl>()) {}
VideoEncoder::~VideoEncoder() { shutdown(); }

bool VideoEncoder::initialize(const EncoderConfig &config) {
    config_ = config;
    initialized_ = impl_->initialize(config);
    return initialized_;
}

void VideoEncoder::shutdown() {
    impl_->shutdown();
    initialized_ = false;
}

bool VideoEncoder::encode(const CapturedFrame &frame, EncodedPacket &packet) {
    if (!initialized_) {
        return false;
    }
    bool ok = impl_->encode(frame, packet);
    if (ok && packetCallback_) {
        packetCallback_(packet);
    }
    return ok;
}

void VideoEncoder::setBitrate(int kbps) {
    impl_->setBitrate(kbps);
    config_.bitrate = kbps;
}

void VideoEncoder::requestKeyframe() {
    impl_->requestKeyframe();
}

VideoCodec VideoEncoder::activeCodec() const {
    return impl_->activeCodec();
}

std::string VideoEncoder::activeCodecName() const {
    return impl_->activeCodecName();
}

std::string VideoEncoder::activeEncoderName() const {
    return impl_->activeEncoderName();
}

bool VideoEncoder::isHardwareEncoderActive() const {
    return impl_->isHardwareEncoder();
}

}  // namespace versus::video
