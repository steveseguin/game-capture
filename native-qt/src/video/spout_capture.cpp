#include "versus/video/spout_capture.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <thread>

#include <spdlog/spdlog.h>

#ifdef _WIN32
#ifdef VERSUS_USE_SPOUT
#include <SpoutLibrary.h>
#endif
#endif

namespace versus::video {

namespace {

int64_t steadyTimestamp100ns() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
               .count() /
           100;
}

#if defined(_WIN32) && defined(VERSUS_USE_SPOUT)
WindowInfo makeSenderInfo(SPOUTLIBRARY *spout, const char *name) {
    WindowInfo info;
    if (!name || !*name) {
        return info;
    }

    unsigned int width = 0;
    unsigned int height = 0;
    HANDLE shareHandle = nullptr;
    DWORD format = 0;
    if (spout && spout->GetSenderInfo(name, width, height, shareHandle, format)) {
        info.width = static_cast<int>(width);
        info.height = static_cast<int>(height);
    }
    info.id = name;
    info.name = name;
    info.executableName = "Spout2 sender";
    info.processId = 0;
    return info;
}
#endif

}  // namespace

struct SpoutCapture::Impl {
#if defined(_WIN32) && defined(VERSUS_USE_SPOUT)
    std::thread captureThread;
    std::mutex frameMutex;
    std::mutex initMutex;
    std::condition_variable initCV;
    CapturedFrame latestFrame;
    std::vector<uint8_t> pixelBuffer;
    std::string activeSenderName;
    unsigned int senderWidth = 0;
    unsigned int senderHeight = 0;
    DWORD senderFormat = 0;
    int targetFps = 60;
    bool initDone = false;
    bool initSucceeded = false;
#endif
};

SpoutCapture::SpoutCapture()
    : impl_(std::make_unique<Impl>()) {}

SpoutCapture::~SpoutCapture() {
    stopCapture();
}

std::vector<WindowInfo> SpoutCapture::getSenders() {
    std::vector<WindowInfo> senders;
#if defined(_WIN32) && defined(VERSUS_USE_SPOUT)
    SPOUTLIBRARY *spout = GetSpout();
    if (!spout) {
        return senders;
    }

    const int count = std::max(0, spout->GetSenderCount());
    senders.reserve(static_cast<size_t>(count));
    for (int i = 0; i < count; ++i) {
        char name[256]{};
        if (!spout->GetSender(i, name, static_cast<int>(sizeof(name)))) {
            continue;
        }
        WindowInfo info = makeSenderInfo(spout, name);
        if (!info.id.empty()) {
            senders.push_back(std::move(info));
        }
    }
    spout->Release();
#endif
    return senders;
}

bool SpoutCapture::startCapture(const std::string &senderName, int, int, int fps) {
#if !defined(_WIN32) || !defined(VERSUS_USE_SPOUT)
    (void)senderName;
    (void)fps;
    spdlog::warn("[SpoutCapture] Spout2 support is not available in this build");
    return false;
#else
    if (senderName.empty()) {
        spdlog::warn("[SpoutCapture] Cannot start without a sender name");
        return false;
    }

    if (capturing_.load(std::memory_order_acquire)) {
        stopCapture();
    }

    SPOUTLIBRARY *probe = GetSpout();
    if (!probe) {
        spdlog::warn("[SpoutCapture] GetSpout failed");
        return false;
    }

    unsigned int width = 0;
    unsigned int height = 0;
    HANDLE shareHandle = nullptr;
    DWORD format = 0;
    const bool foundSender = probe->GetSenderInfo(senderName.c_str(), width, height, shareHandle, format);
    probe->Release();
    if (!foundSender ||
        width == 0 ||
        height == 0) {
        spdlog::warn("[SpoutCapture] Sender '{}' was not found", senderName);
        return false;
    }

    impl_->activeSenderName = senderName;
    impl_->senderWidth = width;
    impl_->senderHeight = height;
    impl_->senderFormat = format;
    impl_->targetFps = std::clamp(fps > 0 ? fps : 60, 1, 120);
    impl_->pixelBuffer.assign(static_cast<size_t>(width) * static_cast<size_t>(height) * 4, 0);
    {
        std::lock_guard<std::mutex> lock(impl_->initMutex);
        impl_->initDone = false;
        impl_->initSucceeded = false;
    }

    {
        std::lock_guard<std::mutex> lock(impl_->frameMutex);
        impl_->latestFrame = CapturedFrame{};
    }

    capturing_.store(true, std::memory_order_release);
    impl_->captureThread = std::thread([this]() {
        SPOUTLIBRARY *receiver = GetSpout();
        bool initSucceeded = false;
        if (!receiver) {
            spdlog::warn("[SpoutCapture] GetSpout failed on capture thread");
        } else if (!receiver->CreateOpenGL(nullptr)) {
            spdlog::warn("[SpoutCapture] CreateOpenGL failed");
        } else {
            receiver->SetReceiverName(impl_->activeSenderName.c_str());
            initSucceeded = true;
        }

        {
            std::lock_guard<std::mutex> lock(impl_->initMutex);
            impl_->initSucceeded = initSucceeded;
            impl_->initDone = true;
        }
        impl_->initCV.notify_one();

        if (!initSucceeded) {
            if (receiver) {
                receiver->Release();
            }
            capturing_.store(false, std::memory_order_release);
            return;
        }

        spdlog::info("[SpoutCapture] Started sender='{}' {}x{} format={}",
                     impl_->activeSenderName,
                     impl_->senderWidth,
                     impl_->senderHeight,
                     impl_->senderFormat);

        const auto frameInterval = std::chrono::milliseconds(
            std::max(1, 1000 / std::max(1, impl_->targetFps)));

        while (capturing_.load(std::memory_order_acquire)) {
            if (receiver->IsUpdated()) {
                impl_->activeSenderName = receiver->GetSenderName()
                    ? receiver->GetSenderName()
                    : impl_->activeSenderName;
                impl_->senderWidth = receiver->GetSenderWidth();
                impl_->senderHeight = receiver->GetSenderHeight();
                impl_->senderFormat = receiver->GetSenderFormat();
                if (impl_->senderWidth == 0 || impl_->senderHeight == 0) {
                    std::this_thread::sleep_for(frameInterval);
                    continue;
                }
                impl_->pixelBuffer.assign(
                    static_cast<size_t>(impl_->senderWidth) *
                        static_cast<size_t>(impl_->senderHeight) * 4,
                    0);
                spdlog::info("[SpoutCapture] Sender updated sender='{}' {}x{} format={}",
                             impl_->activeSenderName,
                             impl_->senderWidth,
                             impl_->senderHeight,
                             impl_->senderFormat);
                std::this_thread::sleep_for(frameInterval);
                continue;
            }

            if (impl_->senderWidth == 0 || impl_->senderHeight == 0 || impl_->pixelBuffer.empty()) {
                std::this_thread::sleep_for(frameInterval);
                continue;
            }

            const bool received = receiver &&
                receiver->ReceiveImage(impl_->pixelBuffer.data(), GL_BGRA, false);
            if (!received) {
                std::this_thread::sleep_for(frameInterval);
                continue;
            }

            CapturedFrame frame;
            frame.width = static_cast<int>(impl_->senderWidth);
            frame.height = static_cast<int>(impl_->senderHeight);
            frame.stride = frame.width * 4;
            frame.timestamp = steadyTimestamp100ns();
            frame.format = CapturedFrame::Format::BGRA;
            frame.data = impl_->pixelBuffer;

            {
                std::lock_guard<std::mutex> lock(impl_->frameMutex);
                impl_->latestFrame = frame;
            }
            if (frameCallback_) {
                frameCallback_(frame);
            }

            receiver->HoldFps(impl_->targetFps);
        }

        receiver->ReleaseReceiver();
        receiver->CloseOpenGL();
        receiver->Release();
        spdlog::info("[SpoutCapture] Stopped");
    });

    bool initSucceeded = false;
    {
        std::unique_lock<std::mutex> lock(impl_->initMutex);
        if (!impl_->initCV.wait_for(lock, std::chrono::seconds(5), [this]() {
                return impl_->initDone;
            })) {
            spdlog::warn("[SpoutCapture] Timed out waiting for Spout receiver initialization");
        }
        initSucceeded = impl_->initSucceeded;
    }
    if (!initSucceeded) {
        capturing_.store(false, std::memory_order_release);
        if (impl_->captureThread.joinable()) {
            impl_->captureThread.join();
        }
        return false;
    }

    return true;
#endif
}

void SpoutCapture::stopCapture() {
    const bool wasCapturing = capturing_.exchange(false, std::memory_order_acq_rel);
#if !defined(_WIN32) || !defined(VERSUS_USE_SPOUT)
    (void)wasCapturing;
    return;
#else
    if (!wasCapturing && !impl_->captureThread.joinable()) {
        return;
    }

    if (impl_->captureThread.joinable()) {
        impl_->captureThread.join();
    }
    impl_->pixelBuffer.clear();
    impl_->activeSenderName.clear();
    impl_->senderWidth = 0;
    impl_->senderHeight = 0;
    impl_->senderFormat = 0;
    {
        std::lock_guard<std::mutex> lock(impl_->frameMutex);
        impl_->latestFrame = CapturedFrame{};
    }
#endif
}

bool SpoutCapture::isCapturing() const {
    return capturing_.load(std::memory_order_acquire);
}

void SpoutCapture::setFrameCallback(FrameCallback cb) {
    frameCallback_ = std::move(cb);
}

bool SpoutCapture::getLatestFrame(CapturedFrame &outFrame) {
#if defined(_WIN32) && defined(VERSUS_USE_SPOUT)
    std::lock_guard<std::mutex> lock(impl_->frameMutex);
    if (impl_->latestFrame.data.empty()) {
        return false;
    }
    outFrame = impl_->latestFrame;
    return true;
#else
    (void)outFrame;
    return false;
#endif
}

}  // namespace versus::video
