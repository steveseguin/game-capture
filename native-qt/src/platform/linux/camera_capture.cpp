#include "versus/video/camera_capture.h"
#include "versus/webrtc/media_clock.h"
#include <QDir>
#include <QFileInfo>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <condition_variable>
#include <cstring>
#include <limits>
#include <mutex>
#include <set>
#include <thread>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <spdlog/spdlog.h>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

namespace versus::video {
namespace {
int control(int fd, unsigned long request, void *value) {
    int result;
    do { result = ioctl(fd, request, value); } while (result < 0 && errno == EINTR);
    return result;
}
uint32_t deviceCapabilities(const v4l2_capability &cap) {
    return cap.capabilities & V4L2_CAP_DEVICE_CAPS ? cap.device_caps : cap.capabilities;
}
bool supportedDevice(const v4l2_capability &cap) {
    const auto flags = deviceCapabilities(cap);
    return (flags & V4L2_CAP_VIDEO_CAPTURE) && (flags & V4L2_CAP_STREAMING);
}
AVPixelFormat pixelFormat(uint32_t code) {
    switch (code) {
    case V4L2_PIX_FMT_YUYV: return AV_PIX_FMT_YUYV422;
    case V4L2_PIX_FMT_UYVY: return AV_PIX_FMT_UYVY422;
    case V4L2_PIX_FMT_NV12: return AV_PIX_FMT_NV12;
    case V4L2_PIX_FMT_NV21: return AV_PIX_FMT_NV21;
    case V4L2_PIX_FMT_YUV420: case V4L2_PIX_FMT_YVU420: return AV_PIX_FMT_YUV420P;
    case V4L2_PIX_FMT_RGB24: return AV_PIX_FMT_RGB24;
    case V4L2_PIX_FMT_BGR24: return AV_PIX_FMT_BGR24;
    default: return AV_PIX_FMT_NONE;
    }
}
bool jpeg(uint32_t code) { return code == V4L2_PIX_FMT_MJPEG || code == V4L2_PIX_FMT_JPEG; }
bool validSize(uint32_t width, uint32_t height) { return width && height && width <= 8192 && height <= 8192; }

// Resources belong exclusively to the capture worker. Stop requests never close
// an fd underneath an ioctl or a frame callback.
struct Session {
    int fd = -1;
    bool streaming = false;
    struct Mapping { void *data; size_t size; };
    std::vector<Mapping> mappings;
    AVCodecContext *decoder = nullptr;
    AVFrame *decoded = nullptr;
    AVPacket *packet = nullptr;
    SwsContext *conversion = nullptr;
    ~Session() {
        if (streaming) { int type = V4L2_BUF_TYPE_VIDEO_CAPTURE; control(fd, VIDIOC_STREAMOFF, &type); }
        for (const auto &map : mappings) munmap(map.data, map.size);
        if (fd >= 0) close(fd);
        avcodec_free_context(&decoder); av_frame_free(&decoded); av_packet_free(&packet);
        sws_freeContext(conversion);
    }
};
}

struct CameraCapture::Impl {
    std::atomic<bool> running{false};
    std::thread worker;
    mutable std::mutex mutex;
    std::condition_variable ready;
    bool firstFrame = false;
    std::string error;
    ~Impl() { stop(); }
    void fail(std::string message) {
        { std::lock_guard lock(mutex); error = std::move(message); spdlog::warn("[V4L2] {}", error); }
        running = false; ready.notify_all();
    }
    void deviceError(const char *operation) {
        const int code = errno;
        fail(std::string(operation) + ": " + std::strerror(code) +
            ". Check camera permissions, connection, and whether another app is using it.");
    }
    void stop() {
        running = false; ready.notify_all();
        if (worker.joinable()) worker.join();
    }

    void capture(std::string path, int width, int height, int fps, FrameCallback callback) {
        Session session;
        session.fd = open(path.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
        if (session.fd < 0) { deviceError("Could not open the selected camera"); return; }
        const int fd = session.fd;
        v4l2_capability cap{};
        if (control(fd, VIDIOC_QUERYCAP, &cap) < 0 || !supportedDevice(cap)) {
            fail("The selected device does not support single-plane V4L2 streaming capture."); return;
        }
        // UVC TRY_FMT sends USB probe controls without acquiring the driver's
        // exclusive handle. On Cam Link this interrupts an existing stream.
        // S_FMT checks ownership first; reapplying the current format acquires
        // that handle before probing candidates. Enumeration never does either.
        // See Linux drivers/media/usb/uvc/uvc_v4l2.c (uvc_acquire_privileges).
        v4l2_format current{}; current.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        if (control(fd, VIDIOC_G_FMT, &current) < 0 || control(fd, VIDIOC_S_FMT, &current) < 0) {
            deviceError("Could not acquire the selected camera"); return;
        }
        v4l2_format selected{};
        int64_t best = std::numeric_limits<int64_t>::max();
        for (uint32_t index = 0; running; ++index) {
            v4l2_fmtdesc description{}; description.type = V4L2_BUF_TYPE_VIDEO_CAPTURE; description.index = index;
            if (control(fd, VIDIOC_ENUM_FMT, &description) < 0) break;
            if (pixelFormat(description.pixelformat) == AV_PIX_FMT_NONE && !jpeg(description.pixelformat)) continue;
            v4l2_format candidate{}; candidate.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
            candidate.fmt.pix.width = width; candidate.fmt.pix.height = height;
            candidate.fmt.pix.pixelformat = description.pixelformat; candidate.fmt.pix.field = V4L2_FIELD_NONE;
            if (control(fd, VIDIOC_TRY_FMT, &candidate) < 0 || !validSize(candidate.fmt.pix.width, candidate.fmt.pix.height)) continue;
            if (pixelFormat(candidate.fmt.pix.pixelformat) == AV_PIX_FMT_NONE && !jpeg(candidate.fmt.pix.pixelformat)) continue;
            if (candidate.fmt.pix.field != V4L2_FIELD_NONE) continue;
            const int64_t score = (std::abs(int64_t(candidate.fmt.pix.width) - width) +
                                   std::abs(int64_t(candidate.fmt.pix.height) - height)) * 100 +
                                   (jpeg(candidate.fmt.pix.pixelformat) ? 10 : 0);
            if (score < best) { best = score; selected = candidate; }
        }
        if (!selected.type) { fail("No supported progressive RGB, YUV, or MJPEG camera format is available."); return; }
        if (control(fd, VIDIOC_S_FMT, &selected) < 0) { deviceError("Could not set the camera format"); return; }
        auto &pix = selected.fmt.pix;
        if (!validSize(pix.width, pix.height) || pix.field != V4L2_FIELD_NONE ||
            (pixelFormat(pix.pixelformat) == AV_PIX_FMT_NONE && !jpeg(pix.pixelformat))) {
            fail("The camera returned an unsupported format."); return;
        }
        v4l2_streamparm parameters{}; parameters.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        parameters.parm.capture.timeperframe = {1, uint32_t(fps)};
        // Fixed-rate devices may reject S_PARM. Always report the actual rate.
        control(fd, VIDIOC_S_PARM, &parameters);
        control(fd, VIDIOC_G_PARM, &parameters);
        const auto interval = parameters.parm.capture.timeperframe;
        const std::string fourcc{char(pix.pixelformat), char(pix.pixelformat >> 8), char(pix.pixelformat >> 16), char(pix.pixelformat >> 24)};
        spdlog::info("[V4L2] Negotiated {} {}x{}, interval {}/{}, colorspace {}, YCbCr {}, range {}",
            fourcc, pix.width, pix.height, interval.numerator, interval.denominator, pix.colorspace, pix.ycbcr_enc, pix.quantization);
        if (jpeg(pix.pixelformat)) {
            const auto *codec = avcodec_find_decoder(AV_CODEC_ID_MJPEG);
            session.decoder = codec ? avcodec_alloc_context3(codec) : nullptr;
            session.decoded = av_frame_alloc(); session.packet = av_packet_alloc();
            if (!session.decoder || !session.decoded || !session.packet || avcodec_open2(session.decoder, codec, nullptr) < 0) {
                fail("The MJPEG camera decoder is unavailable."); return;
            }
        }
        v4l2_requestbuffers request{}; request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        request.memory = V4L2_MEMORY_MMAP; request.count = 4;
        if (control(fd, VIDIOC_REQBUFS, &request) < 0) { deviceError("Could not allocate camera buffers"); return; }
        if (!request.count || request.count > 32) { fail("Camera returned an invalid buffer count."); return; }
        for (uint32_t i = 0; i < request.count; ++i) {
            v4l2_buffer buffer{}; buffer.type = request.type; buffer.memory = request.memory; buffer.index = i;
            if (control(fd, VIDIOC_QUERYBUF, &buffer) < 0) { deviceError("Could not query a camera buffer"); return; }
            if (!buffer.length || buffer.length > 256u * 1024 * 1024) { fail("Invalid camera buffer size."); return; }
            void *data = mmap(nullptr, buffer.length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, buffer.m.offset);
            if (data == MAP_FAILED) { deviceError("Could not map a camera buffer"); return; }
            session.mappings.push_back({data, buffer.length});
            if (control(fd, VIDIOC_QBUF, &buffer) < 0) { deviceError("Could not queue a camera buffer"); return; }
        }
        int type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        if (!running) return;
        if (control(fd, VIDIOC_STREAMON, &type) < 0) { deviceError("Could not start the camera"); return; }
        session.streaming = true;
        detail::CaptureFramePacer pacer(fps);
        auto lastFrame = std::chrono::steady_clock::now();
        bool delivered = false;
        int64_t lastTimestamp = 0;
        while (running) {
            pollfd descriptor{fd, POLLIN, 0};
            const int status = poll(&descriptor, 1, 100);
            if (status < 0 && errno == EINTR) continue;
            if (status < 0) { deviceError("Could not wait for a camera frame"); break; }
            if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) { fail("Camera disconnected or stopped producing frames."); break; }
            const auto now = std::chrono::steady_clock::now();
            if (now - lastFrame > std::chrono::seconds(delivered ? 3 : 8)) { fail("Camera timed out without a usable frame. Check the camera or HDMI input."); break; }
            if (!(descriptor.revents & POLLIN)) continue;
            v4l2_buffer buffer{}; buffer.type = request.type; buffer.memory = request.memory;
            if (control(fd, VIDIOC_DQBUF, &buffer) < 0) {
                if (errno == EAGAIN) continue;
                deviceError("Could not read a camera frame"); break;
            }
            if (buffer.index >= session.mappings.size() || buffer.bytesused > session.mappings[buffer.index].size) {
                fail("Camera returned an invalid frame buffer."); break;
            }
            if (!(buffer.flags & V4L2_BUF_FLAG_ERROR) && buffer.bytesused && pacer.shouldAdmit(now)) {
                CapturedFrame frame;
                if (convert(session, pix, static_cast<uint8_t *>(session.mappings[buffer.index].data), buffer.bytesused, frame)) {
                    frame.timestamp = webrtc::mediaTime100ns();
                    if ((buffer.flags & V4L2_BUF_FLAG_TIMESTAMP_MASK) == V4L2_BUF_FLAG_TIMESTAMP_MONOTONIC) {
                        const auto timestamp = int64_t(buffer.timestamp.tv_sec) * 10000000 + buffer.timestamp.tv_usec * 10;
                        if (timestamp > lastTimestamp && timestamp <= frame.timestamp && frame.timestamp - timestamp < 100000000)
                            frame.timestamp = timestamp;
                    }
                    frame.timestamp = std::max(frame.timestamp, lastTimestamp + 1); lastTimestamp = frame.timestamp;
                    if (callback && running) callback(std::move(frame));
                    lastFrame = now; delivered = true;
                    { std::lock_guard lock(mutex); firstFrame = true; }
                    ready.notify_all();
                }
            }
            if (control(fd, VIDIOC_QBUF, &buffer) < 0) { deviceError("Could not return a camera buffer"); break; }
        }
    }

    bool convert(Session &session, const v4l2_pix_format &pix, uint8_t *source, int size, CapturedFrame &frame) {
        uint8_t *planes[4]{}; int strides[4]{};
        AVPixelFormat format = pixelFormat(pix.pixelformat);
        int width = pix.width, height = pix.height;
        int colorspace = pix.ycbcr_enc == V4L2_YCBCR_ENC_DEFAULT ? V4L2_MAP_YCBCR_ENC_DEFAULT(pix.colorspace) : pix.ycbcr_enc;
        int matrix;
        switch (colorspace) {
        case V4L2_YCBCR_ENC_601: case V4L2_YCBCR_ENC_XV601: case V4L2_YCBCR_ENC_SYCC: matrix = SWS_CS_ITU601; break;
        case V4L2_YCBCR_ENC_709: case V4L2_YCBCR_ENC_XV709: matrix = SWS_CS_ITU709; break;
        case V4L2_YCBCR_ENC_BT2020: matrix = SWS_CS_BT2020; break;
        case V4L2_YCBCR_ENC_SMPTE240M: matrix = SWS_CS_SMPTE240M; break;
        default: return false;
        }
        const bool rgb = format == AV_PIX_FMT_RGB24 || format == AV_PIX_FMT_BGR24;
        const auto quantization = pix.quantization == V4L2_QUANTIZATION_DEFAULT ?
            V4L2_MAP_QUANTIZATION_DEFAULT(rgb, pix.colorspace, colorspace) : pix.quantization;
        int fullRange = quantization == V4L2_QUANTIZATION_FULL_RANGE;
        if (jpeg(pix.pixelformat)) {
            av_packet_unref(session.packet);
            // The decoder may read padding beyond the packet; mmap bytes are
            // not padded, so copy into an owned FFmpeg packet.
            if (av_new_packet(session.packet, size) < 0) return false;
            std::memcpy(session.packet->data, source, size);
            if (avcodec_send_packet(session.decoder, session.packet) < 0 || avcodec_receive_frame(session.decoder, session.decoded) < 0) return false;
            auto *decoded = session.decoded;
            if (!validSize(decoded->width, decoded->height)) return false;
            width = decoded->width; height = decoded->height; format = AVPixelFormat(decoded->format);
            for (int i = 0; i < 4; ++i) { planes[i] = decoded->data[i]; strides[i] = decoded->linesize[i]; }
            fullRange = decoded->color_range != AVCOL_RANGE_MPEG;
            if (decoded->colorspace == AVCOL_SPC_BT709) matrix = SWS_CS_ITU709;
        } else {
            if (av_image_fill_linesizes(strides, format, width) < 0 || pix.bytesperline > INT32_MAX) return false;
            const int stride = pix.bytesperline ? pix.bytesperline : strides[0];
            if (stride < strides[0]) return false;
            strides[0] = stride;
            if (format == AV_PIX_FMT_YUV420P) {
                if (stride & 1) return false;
                strides[1] = strides[2] = stride / 2;
            } else if (format == AV_PIX_FMT_NV12 || format == AV_PIX_FMT_NV21) strides[1] = stride;
            const int required = av_image_fill_pointers(planes, format, height, source, strides);
            if (required < 0 || required > size) return false;
            if (pix.pixelformat == V4L2_PIX_FMT_YVU420) std::swap(planes[1], planes[2]);
        }
        session.conversion = sws_getCachedContext(session.conversion, width, height, format,
            width, height, AV_PIX_FMT_BGRA, SWS_BILINEAR, nullptr, nullptr, nullptr);
        if (!session.conversion) return false;
        const auto *coefficients = sws_getCoefficients(matrix);
        if (sws_setColorspaceDetails(session.conversion, coefficients, fullRange, coefficients, 1, 0, 1 << 16, 1 << 16) < 0) return false;
        frame.width = width; frame.height = height; frame.stride = width * 4;
        frame.data.resize(size_t(frame.stride) * height);
        uint8_t *destinations[]{frame.data.data(), nullptr, nullptr, nullptr}; int destinationStrides[]{frame.stride, 0, 0, 0};
        return sws_scale(session.conversion, planes, strides, 0, height, destinations, destinationStrides) == height;
    }
};

CameraCapture::CameraCapture() : impl_(std::make_unique<Impl>()) {}
CameraCapture::~CameraCapture() = default;
std::vector<WindowInfo> CameraCapture::getCameras() {
    std::vector<WindowInfo> result;
    std::set<QString> visited;
    for (const QString &directory : {QString("/dev/v4l/by-id"), QString("/dev/v4l/by-path"), QString("/dev")}) {
        const auto files = QDir(directory).entryInfoList(directory == "/dev" ? QStringList{"video*"} : QStringList{"*"}, QDir::System | QDir::Files | QDir::NoDotAndDotDot, QDir::Name);
        for (const auto &file : files) {
            const auto canonical = file.canonicalFilePath();
            if (canonical.isEmpty() || !visited.insert(canonical).second) continue;
            const int fd = open(file.absoluteFilePath().toUtf8().constData(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
            if (fd < 0) continue;
            v4l2_capability cap{};
            if (control(fd, VIDIOC_QUERYCAP, &cap) == 0 && supportedDevice(cap)) {
                WindowInfo info;
                info.id = "v4l2:" + file.absoluteFilePath().toStdString();
                info.name.assign(reinterpret_cast<char *>(cap.card), strnlen(reinterpret_cast<char *>(cap.card), sizeof(cap.card)));
                info.executableName = "V4L2";
                v4l2_format format{}; format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
                if (control(fd, VIDIOC_G_FMT, &format) == 0) { info.width = format.fmt.pix.width; info.height = format.fmt.pix.height; }
                result.push_back(std::move(info));
            }
            close(fd);
        }
    }
    return result;
}
bool CameraCapture::startCapture(const std::string &id, int width, int height, int fps) {
    stopCapture();
    { std::lock_guard lock(impl_->mutex); impl_->error.clear(); impl_->firstFrame = false; }
    if (!id.starts_with("v4l2:/dev/") || !validSize(width, height) || fps < 1 || fps > 240) {
        impl_->fail("Invalid camera device or capture dimensions."); return false;
    }
    impl_->running = true;
    impl_->worker = std::thread([this, path = id.substr(5), width, height, fps, callback = frameCallback_] {
        try { impl_->capture(path, width, height, fps, callback); }
        catch (const std::exception &error) { impl_->fail(std::string("Camera capture failed: ") + error.what()); }
        catch (...) { impl_->fail("Camera capture failed unexpectedly."); }
        impl_->running = false; impl_->ready.notify_all();
    });
    std::unique_lock lock(impl_->mutex);
    const bool initialized = impl_->ready.wait_for(lock, std::chrono::seconds(10), [&] { return impl_->firstFrame || !impl_->running; }) && impl_->firstFrame && impl_->running;
    if (!initialized && impl_->error.empty()) impl_->error = "Camera startup cancelled or timed out.";
    lock.unlock();
    if (!initialized) impl_->stop();
    return initialized;
}
void CameraCapture::stopCapture() { impl_->stop(); }
bool CameraCapture::isCapturing() const { return impl_->running; }
std::string CameraCapture::lastError() const { std::lock_guard lock(impl_->mutex); return impl_->error; }
void CameraCapture::setFrameCallback(FrameCallback cb) { frameCallback_ = std::move(cb); }
} // namespace versus::video
