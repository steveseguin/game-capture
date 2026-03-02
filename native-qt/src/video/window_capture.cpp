#include "versus/video/window_capture.h"

#include <algorithm>
#include <mutex>
#include <thread>

#include <QImage>
#include <QGuiApplication>
#include <QScreen>
#include <spdlog/spdlog.h>

#ifdef _WIN32
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <Psapi.h>

#ifdef VERSUS_USE_GRAPHICS_CAPTURE
// Windows Graphics Capture API (WinRT-based)
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#pragma comment(lib, "windowsapp.lib")
using namespace winrt;
#else
// Use WRL ComPtr for static builds without WinRT
#include <wrl/client.h>
template<typename T>
using com_ptr = Microsoft::WRL::ComPtr<T>;
#endif

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

#endif

namespace versus::video {

#ifdef _WIN32

namespace {

constexpr int kFramePoolBufferCount = 4;

bool tryParseWindowHandle(const std::string &windowId, HWND &outHwnd) {
    if (windowId.empty()) {
        return false;
    }

    size_t parsedChars = 0;
    unsigned long long rawValue = 0;
    try {
        rawValue = std::stoull(windowId, &parsedChars, 0);
    } catch (...) {
        return false;
    }

    if (parsedChars != windowId.size() || rawValue == 0) {
        return false;
    }

    outHwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(rawValue));
    return outHwnd != nullptr;
}

QPixmap captureViaScreenGrab(HWND hwnd, int maxWidth, int maxHeight) {
    auto *screen = QGuiApplication::primaryScreen();
    if (!screen) {
        return QPixmap();
    }

    const WId winId = static_cast<WId>(reinterpret_cast<quintptr>(hwnd));
    QPixmap grabbed = screen->grabWindow(winId);
    if (grabbed.isNull()) {
        return QPixmap();
    }
    return grabbed.scaled(maxWidth, maxHeight, Qt::KeepAspectRatio, Qt::SmoothTransformation);
}

}  // namespace

class WindowCapture::Impl {
  public:
    bool initialize() {
        D3D_FEATURE_LEVEL featureLevels[] = {
            D3D_FEATURE_LEVEL_11_1,
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0
        };

        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#ifdef _DEBUG
        flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif

        HRESULT hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            device_.put(),
            nullptr,
            context_.put());

        if (FAILED(hr)) {
            spdlog::warn("[Capture::Impl] D3D11CreateDevice failed hr=0x{:08x}", static_cast<unsigned int>(hr));
            return false;
        }

        useGraphicsCapture_ = false;
#ifdef VERSUS_USE_GRAPHICS_CAPTURE
        try {
            useGraphicsCapture_ = winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported();
        } catch (const winrt::hresult_error &e) {
            spdlog::warn("[Capture::Impl] GraphicsCapture support probe failed hr=0x{:08x} msg={}",
                         static_cast<unsigned int>(e.code()),
                         winrt::to_string(e.message()));
            useGraphicsCapture_ = false;
        } catch (const std::exception &e) {
            spdlog::warn("[Capture::Impl] GraphicsCapture support probe threw std::exception: {}", e.what());
            useGraphicsCapture_ = false;
        } catch (...) {
            spdlog::warn("[Capture::Impl] GraphicsCapture support probe failed with unknown exception");
            useGraphicsCapture_ = false;
        }
#endif
        return true;
    }

    std::vector<WindowInfo> enumerateWindows() {
        std::vector<WindowInfo> windows;
        EnumWindows([](HWND hwnd, LPARAM lParam) -> BOOL {
            auto *list = reinterpret_cast<std::vector<WindowInfo> *>(lParam);
            if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) {
                return TRUE;
            }

            int titleLen = GetWindowTextLengthW(hwnd);
            if (titleLen == 0) {
                return TRUE;
            }

            std::wstring titleW(titleLen + 1, L'\0');
            GetWindowTextW(hwnd, titleW.data(), titleLen + 1);
            titleW.resize(titleLen);

            int size = WideCharToMultiByte(CP_UTF8, 0, titleW.c_str(), -1, nullptr, 0, nullptr, nullptr);
            std::string title(size - 1, '\0');
            WideCharToMultiByte(CP_UTF8, 0, titleW.c_str(), -1, title.data(), size, nullptr, nullptr);

            DWORD processId = 0;
            GetWindowThreadProcessId(hwnd, &processId);

            HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
            std::string executableName;
            if (hProcess) {
                wchar_t exePath[MAX_PATH];
                DWORD pathSize = MAX_PATH;
                if (QueryFullProcessImageNameW(hProcess, 0, exePath, &pathSize)) {
                    std::wstring pathW(exePath);
                    auto pos = pathW.find_last_of(L'\\');
                    if (pos != std::wstring::npos) {
                        std::wstring nameW = pathW.substr(pos + 1);
                        int nameSize = WideCharToMultiByte(CP_UTF8, 0, nameW.c_str(), -1, nullptr, 0, nullptr, nullptr);
                        executableName.resize(nameSize - 1);
                        WideCharToMultiByte(CP_UTF8, 0, nameW.c_str(), -1, executableName.data(), nameSize, nullptr, nullptr);
                    }
                }
                CloseHandle(hProcess);
            }

            RECT rect;
            GetWindowRect(hwnd, &rect);
            int width = rect.right - rect.left;
            int height = rect.bottom - rect.top;
            if (width < 100 || height < 100) {
                return TRUE;
            }

            WindowInfo info;
            info.id = std::to_string(reinterpret_cast<uintptr_t>(hwnd));
            info.name = title;
            info.executableName = executableName;
            info.processId = processId;
            info.width = width;
            info.height = height;
            list->push_back(std::move(info));
            return TRUE;
        }, reinterpret_cast<LPARAM>(&windows));
        return windows;
    }

    bool startCapture(HWND hwnd, int width, int height, int fps) {
        spdlog::info("[Capture::Impl] startCapture hwnd={} {}x{} @{}fps", (void*)hwnd, width, height, fps);
        if (capturing_) {
            spdlog::info("[Capture::Impl] Already capturing, stopping first");
            stopCapture();
        }
        targetHwnd_ = hwnd;
        targetWidth_ = width;
        targetHeight_ = height;
        targetFps_ = fps;

        if (useGraphicsCapture_) {
            spdlog::info("[Capture::Impl] Using Windows Graphics Capture API");
            return startGraphicsCapture(hwnd);
        }
        spdlog::info("[Capture::Impl] Using Desktop Duplication fallback");
        return startDesktopDuplication();
    }

    void stopCapture() {
        capturing_ = false;
        if (captureThread_.joinable()) {
            captureThread_.join();
        }
        if (framePool_) {
            framePool_.Close();
            framePool_ = nullptr;
        }
        if (captureSession_) {
            captureSession_.Close();
            captureSession_ = nullptr;
        }
        captureItem_ = nullptr;
        graphicsDevice_ = nullptr;
        lastContentWidth_ = 0;
        lastContentHeight_ = 0;
    }

    bool getLatestFrame(CapturedFrame &outFrame) {
        std::lock_guard<std::mutex> lock(frameMutex_);
        if (latestFrame_.data.empty()) {
            return false;
        }
        outFrame = latestFrame_;
        return true;
    }

    void setFrameCallback(FrameCallback callback) {
        frameCallback_ = std::move(callback);
    }

    bool isCapturing() const { return capturing_; }

  private:
    bool startGraphicsCapture(HWND hwnd) {
        try {
            spdlog::info("[Capture::Impl] startGraphicsCapture for hwnd={}", (void*)hwnd);
            auto interop = winrt::get_activation_factory<winrt::Windows::Graphics::Capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
            winrt::com_ptr<IUnknown> itemUnk;
            HRESULT hr = interop->CreateForWindow(
                hwnd,
                winrt::guid_of<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem>(),
                itemUnk.put_void());
            if (FAILED(hr)) {
                spdlog::error("[Capture::Impl] CreateForWindow failed with hr=0x{:08x}", (unsigned int)hr);
                return false;
            }
            spdlog::info("[Capture::Impl] CreateForWindow succeeded");

            captureItem_ = itemUnk.as<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>();

            winrt::com_ptr<IDXGIDevice> dxgiDevice;
            device_->QueryInterface(dxgiDevice.put());

            winrt::com_ptr<::IInspectable> inspectable;
            hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put());
            if (FAILED(hr)) {
                spdlog::error("[Capture::Impl] CreateDirect3D11DeviceFromDXGIDevice failed hr=0x{:08x}", (unsigned int)hr);
                return false;
            }

            auto d3dDevice = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
            auto size = captureItem_.Size();
            if (size.Width <= 0 || size.Height <= 0) {
                spdlog::error("[Capture::Impl] Invalid capture item size {}x{}", size.Width, size.Height);
                return false;
            }
            graphicsDevice_ = d3dDevice;
            lastContentWidth_ = size.Width;
            lastContentHeight_ = size.Height;
            spdlog::info("[Capture::Impl] Creating frame pool, size={}x{}", size.Width, size.Height);
            framePool_ = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
                d3dDevice,
                winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
                kFramePoolBufferCount,
                size);

            framePool_.FrameArrived([this](auto const &sender, auto const &) { onFrameArrived(sender); });
            captureSession_ = framePool_.CreateCaptureSession(captureItem_);
            captureSession_.IsCursorCaptureEnabled(false);
            captureSession_.StartCapture();
            capturing_ = true;
            spdlog::info("[Capture::Impl] Graphics capture started successfully");
            return true;
        } catch (const winrt::hresult_error& e) {
            spdlog::error("[Capture::Impl] WinRT exception: hr=0x{:08x} msg={}", (unsigned int)e.code(), winrt::to_string(e.message()));
            return false;
        } catch (const std::exception& e) {
            spdlog::error("[Capture::Impl] Exception: {}", e.what());
            return false;
        } catch (...) {
            spdlog::error("[Capture::Impl] Unknown exception in startGraphicsCapture");
            return false;
        }
    }

    bool startDesktopDuplication() {
        winrt::com_ptr<IDXGIDevice> dxgiDevice;
        device_->QueryInterface(dxgiDevice.put());
        winrt::com_ptr<IDXGIAdapter> adapter;
        dxgiDevice->GetAdapter(adapter.put());
        winrt::com_ptr<IDXGIOutput> output;
        adapter->EnumOutputs(0, output.put());
        winrt::com_ptr<IDXGIOutput1> output1;
        output->QueryInterface(output1.put());
        HRESULT hr = output1->DuplicateOutput(device_.get(), outputDuplication_.put());
        if (FAILED(hr)) {
            return false;
        }
        capturing_ = true;
        captureThread_ = std::thread([this]() { captureLoop(); });
        return true;
    }

    void onFrameArrived(winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const &sender) {
        auto frame = sender.TryGetNextFrame();
        if (!frame) {
            return;
        }

        const auto contentSize = frame.ContentSize();
        const int contentWidth = contentSize.Width;
        const int contentHeight = contentSize.Height;
        if (contentWidth <= 0 || contentHeight <= 0) {
            return;
        }

        if ((contentWidth != lastContentWidth_) || (contentHeight != lastContentHeight_)) {
            lastContentWidth_ = contentWidth;
            lastContentHeight_ = contentHeight;
            if (framePool_ && graphicsDevice_) {
                try {
                    framePool_.Recreate(
                        graphicsDevice_,
                        winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
                        kFramePoolBufferCount,
                        contentSize);
                    spdlog::info("[Capture::Impl] Capture content resized, recreated frame pool: {}x{}",
                                 contentWidth,
                                 contentHeight);
                } catch (const winrt::hresult_error &e) {
                    spdlog::warn("[Capture::Impl] Frame pool recreate failed hr=0x{:08x} msg={}",
                                 static_cast<unsigned int>(e.code()),
                                 winrt::to_string(e.message()));
                } catch (...) {
                    spdlog::warn("[Capture::Impl] Frame pool recreate failed with unknown exception");
                }
            }
            return;
        }

        auto surface = frame.Surface();
        auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        winrt::com_ptr<ID3D11Texture2D> texture;
        winrt::check_hresult(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), texture.put_void()));
        int64_t timestamp = frame.SystemRelativeTime().count();
        processFrame(texture.get(), timestamp, contentWidth, contentHeight);
    }

    void captureLoop() {
        while (capturing_) {
            winrt::com_ptr<IDXGIResource> resource;
            DXGI_OUTDUPL_FRAME_INFO frameInfo;
            HRESULT hr = outputDuplication_->AcquireNextFrame(100, &frameInfo, resource.put());
            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                continue;
            }
            if (FAILED(hr)) {
                break;
            }
            winrt::com_ptr<ID3D11Texture2D> texture;
            resource->QueryInterface(texture.put());
            D3D11_TEXTURE2D_DESC desc;
            texture->GetDesc(&desc);
            processFrame(texture.get(),
                         frameInfo.LastPresentTime.QuadPart,
                         static_cast<int>(desc.Width),
                         static_cast<int>(desc.Height));
            outputDuplication_->ReleaseFrame();
        }
    }

    void processFrame(ID3D11Texture2D *texture, int64_t timestamp, int contentWidth, int contentHeight) {
        D3D11_TEXTURE2D_DESC desc;
        texture->GetDesc(&desc);

        if (!stagingTexture_ || stagingWidth_ != desc.Width || stagingHeight_ != desc.Height) {
            D3D11_TEXTURE2D_DESC stagingDesc = desc;
            stagingDesc.Usage = D3D11_USAGE_STAGING;
            stagingDesc.BindFlags = 0;
            stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            stagingDesc.MiscFlags = 0;
            if (FAILED(device_->CreateTexture2D(&stagingDesc, nullptr, stagingTexture_.put()))) {
                return;
            }
            stagingWidth_ = desc.Width;
            stagingHeight_ = desc.Height;
        }

        context_->CopyResource(stagingTexture_.get(), texture);
        D3D11_MAPPED_SUBRESOURCE mapped;
        if (FAILED(context_->Map(stagingTexture_.get(), 0, D3D11_MAP_READ, 0, &mapped))) {
            return;
        }

        CapturedFrame frame;
        frame.width = std::max(1, std::min<int>(contentWidth, static_cast<int>(desc.Width)));
        frame.height = std::max(1, std::min<int>(contentHeight, static_cast<int>(desc.Height)));
        frame.stride = mapped.RowPitch;
        frame.timestamp = timestamp;
        frame.format = CapturedFrame::Format::BGRA;
        size_t dataSize = static_cast<size_t>(mapped.RowPitch) * static_cast<size_t>(frame.height);
        frame.data.resize(dataSize);
        std::memcpy(frame.data.data(), mapped.pData, dataSize);
        context_->Unmap(stagingTexture_.get(), 0);

        {
            std::lock_guard<std::mutex> lock(frameMutex_);
            latestFrame_ = std::move(frame);
        }
        if (frameCallback_) {
            frameCallback_(latestFrame_);
        }
    }

    winrt::com_ptr<ID3D11Device> device_;
    winrt::com_ptr<ID3D11DeviceContext> context_;
    winrt::com_ptr<ID3D11Texture2D> stagingTexture_;
    winrt::com_ptr<IDXGIOutputDuplication> outputDuplication_;

    bool useGraphicsCapture_ = false;
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem captureItem_{nullptr};
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool framePool_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession captureSession_{nullptr};
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice graphicsDevice_{nullptr};

    HWND targetHwnd_ = nullptr;
    int targetWidth_ = 0;
    int targetHeight_ = 0;
    int targetFps_ = 60;
    bool capturing_ = false;

    UINT stagingWidth_ = 0;
    UINT stagingHeight_ = 0;
    int lastContentWidth_ = 0;
    int lastContentHeight_ = 0;

    std::mutex frameMutex_;
    CapturedFrame latestFrame_;
    FrameCallback frameCallback_;
    std::thread captureThread_;
};

#else

class WindowCapture::Impl {
  public:
    bool initialize() { return false; }
    std::vector<WindowInfo> enumerateWindows() { return {}; }
    bool startCapture(void *, int, int, int) { return false; }
    void stopCapture() {}
    bool getLatestFrame(CapturedFrame &) { return false; }
    void setFrameCallback(FrameCallback) {}
    bool isCapturing() const { return false; }
};

#endif

WindowCapture::WindowCapture() : impl_(std::make_unique<Impl>()) {
#ifdef _WIN32
    impl_->initialize();
#endif
}

WindowCapture::~WindowCapture() { stopCapture(); }

std::vector<WindowInfo> WindowCapture::getWindows() {
    return impl_->enumerateWindows();
}

WindowInfo *WindowCapture::findWindowByName(const std::string &partialName) {
    static std::vector<WindowInfo> cached;
    cached = getWindows();
    std::string lowerPartial = partialName;
    std::transform(lowerPartial.begin(), lowerPartial.end(), lowerPartial.begin(), ::tolower);
    for (auto &window : cached) {
        std::string lowerName = window.name;
        std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), ::tolower);
        std::string lowerExe = window.executableName;
        std::transform(lowerExe.begin(), lowerExe.end(), lowerExe.begin(), ::tolower);
        if (lowerName.find(lowerPartial) != std::string::npos || lowerExe.find(lowerPartial) != std::string::npos) {
            return &window;
        }
    }
    return nullptr;
}

bool WindowCapture::startCapture(const std::string &windowId, int width, int height, int fps) {
#ifdef _WIN32
    spdlog::info("[Capture] startCapture called with windowId={}", windowId);
    HWND hwnd = nullptr;
    if (!tryParseWindowHandle(windowId, hwnd)) {
        spdlog::warn("[Capture] Invalid windowId format: {}", windowId);
        return false;
    }
    if (!IsWindow(hwnd)) {
        spdlog::error("[Capture] Invalid window handle for windowId={}", windowId);
        return false;
    }
    spdlog::info("[Capture] Window handle valid, calling impl->startCapture");
    capturing_ = impl_->startCapture(hwnd, width, height, fps);
    spdlog::info("[Capture] impl->startCapture returned {}", capturing_);
    return capturing_;
#else
    return false;
#endif
}

void WindowCapture::stopCapture() {
    impl_->stopCapture();
    capturing_ = false;
}

bool WindowCapture::isCapturing() const {
    return capturing_;
}

void WindowCapture::setFrameCallback(FrameCallback cb) {
    frameCallback_ = std::move(cb);
    impl_->setFrameCallback(frameCallback_);
}

bool WindowCapture::getLatestFrame(CapturedFrame &outFrame) {
    return impl_->getLatestFrame(outFrame);
}

QPixmap WindowCapture::captureWindowThumbnail(const std::string &windowId, int maxWidth, int maxHeight) {
#ifdef _WIN32
    HWND hwnd = nullptr;
    if (!tryParseWindowHandle(windowId, hwnd)) {
        return QPixmap();
    }

    // Check if window is valid
    if (!IsWindow(hwnd)) {
        return QPixmap();
    }

    // Get window dimensions
    RECT rect;
    if (!GetWindowRect(hwnd, &rect)) {
        return QPixmap();
    }

    int width = rect.right - rect.left;
    int height = rect.bottom - rect.top;

    if (width <= 0 || height <= 0) {
        return QPixmap();
    }

    // Create compatible DC and bitmap
    HDC hdcScreen = GetDC(nullptr);
    HDC hdcMem = CreateCompatibleDC(hdcScreen);
    HBITMAP hBitmap = CreateCompatibleBitmap(hdcScreen, width, height);
    HGDIOBJ hOld = SelectObject(hdcMem, hBitmap);

    // Try PrintWindow first (works for partially occluded windows)
    BOOL captured = PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT);

    if (!captured) {
        // Fall back to BitBlt from window DC
        HDC hdcWindow = GetWindowDC(hwnd);
        if (hdcWindow) {
            BitBlt(hdcMem, 0, 0, width, height, hdcWindow, 0, 0, SRCCOPY);
            ReleaseDC(hwnd, hdcWindow);
            captured = TRUE;
        }
    }

    if (!captured) {
        SelectObject(hdcMem, hOld);
        DeleteObject(hBitmap);
        DeleteDC(hdcMem);
        ReleaseDC(nullptr, hdcScreen);
        return captureViaScreenGrab(hwnd, maxWidth, maxHeight);
    }

    // Get bitmap bits
    BITMAPINFOHEADER bi;
    bi.biSize = sizeof(BITMAPINFOHEADER);
    bi.biWidth = width;
    bi.biHeight = -height;  // Top-down DIB
    bi.biPlanes = 1;
    bi.biBitCount = 32;
    bi.biCompression = BI_RGB;
    bi.biSizeImage = 0;
    bi.biXPelsPerMeter = 0;
    bi.biYPelsPerMeter = 0;
    bi.biClrUsed = 0;
    bi.biClrImportant = 0;

    std::vector<uint8_t> bits(width * height * 4);
    const int copiedScanlines = GetDIBits(hdcMem, hBitmap, 0, height, bits.data(),
                                          reinterpret_cast<BITMAPINFO *>(&bi), DIB_RGB_COLORS);

    // Clean up GDI resources
    SelectObject(hdcMem, hOld);
    DeleteObject(hBitmap);
    DeleteDC(hdcMem);
    ReleaseDC(nullptr, hdcScreen);

    if (copiedScanlines <= 0) {
        return captureViaScreenGrab(hwnd, maxWidth, maxHeight);
    }

    // Create QImage from the captured bits (BGRA format)
    QImage image(bits.data(), width, height, width * 4, QImage::Format_ARGB32);

    // Scale to thumbnail size maintaining aspect ratio
    QPixmap pixmap = QPixmap::fromImage(image.copy());  // copy() to detach from bits buffer
    return pixmap.scaled(maxWidth, maxHeight, Qt::KeepAspectRatio, Qt::SmoothTransformation);
#else
    Q_UNUSED(windowId)
    Q_UNUSED(maxWidth)
    Q_UNUSED(maxHeight)
    return QPixmap();
#endif
}

}  // namespace versus::video
