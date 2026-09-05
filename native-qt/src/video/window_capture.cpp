#include "versus/video/window_capture.h"
#include "versus/video/aspect_fit.h"

#include <algorithm>
#include <atomic>
#include <exception>
#include <chrono>
#include <future>
#include <mutex>
#include <thread>

#include <QImage>
#include <QGuiApplication>
#include <QScreen>
#include <spdlog/spdlog.h>

#ifdef _WIN32
#include <windows.h>
#include <appmodel.h>
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
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>
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

namespace detail {

CaptureFramePacer::CaptureFramePacer(int targetFps) {
    reset(targetFps);
}

void CaptureFramePacer::reset(int targetFps) {
    scheduled_ = false;
    nextDue_ = {};
    interval_ = targetFps > 0
        ? std::chrono::nanoseconds(1000000000LL / std::max(1, targetFps))
        : std::chrono::steady_clock::duration::zero();
}

bool CaptureFramePacer::shouldAdmit(std::chrono::steady_clock::time_point now) {
    if (interval_ <= std::chrono::steady_clock::duration::zero()) {
        return true;
    }
    if (!scheduled_) {
        nextDue_ = now + interval_;
        scheduled_ = true;
        return true;
    }
    // Callback jitter must not discard slightly early frames from a source
    // already running at the requested rate. Keep the deadline phase and skip
    // missed slots, so this allowance cannot accumulate into catch-up bursts.
    const auto tolerance = std::min(
        interval_ / 4,
        std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::milliseconds(2)));
    const auto admissionTime = now + tolerance;
    if (admissionTime < nextDue_) {
        return false;
    }

    const auto overdue = admissionTime - nextDue_;
    const auto intervalsElapsed = (overdue / interval_) + 1;
    nextDue_ += interval_ * intervalsElapsed;
    return true;
}

bool frameAdmissionAllowed(const std::function<bool()> &admissionCallback) {
    return !admissionCallback || admissionCallback();
}

}  // namespace detail

namespace {

std::string toLowerCopy(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

std::string executableStem(std::string executableName) {
    executableName = toLowerCopy(std::move(executableName));
    const size_t lastSlash = executableName.find_last_of("/\\");
    if (lastSlash != std::string::npos) {
        executableName.erase(0, lastSlash + 1);
    }
    if (executableName.size() > 4 && executableName.ends_with(".exe")) {
        executableName.resize(executableName.size() - 4);
    }
    return executableName;
}

int windowMatchScore(const WindowInfo &window, const std::string &filterLower) {
    if (filterLower.empty()) {
        return 0;
    }

    const std::string titleLower = toLowerCopy(window.name);
    const std::string exeLower = toLowerCopy(window.executableName);
    const std::string exeStemLower = executableStem(window.executableName);

    int score = 0;
    const auto titlePos = titleLower.find(filterLower);
    if (titleLower == filterLower) {
        score = std::max(score, 1000);
    } else if (titlePos != std::string::npos) {
        score = std::max(score, 850);
        if (titlePos == 0) {
            score = std::max(score, 900);
        }
        if (titlePos + filterLower.size() == titleLower.size()) {
            score = std::max(score, 920);
        }
        if (titleLower.find(" - " + filterLower) != std::string::npos ||
            titleLower.find(filterLower + " - ") != std::string::npos) {
            score = std::max(score, 950);
        }
    }

    if (exeStemLower == filterLower) {
        score = std::max(score, 700);
    } else if (exeLower == filterLower || exeLower == filterLower + ".exe") {
        score = std::max(score, 680);
    } else if (exeStemLower.find(filterLower) != std::string::npos) {
        score = std::max(score, 620);
    } else if (exeLower.find(filterLower) != std::string::npos) {
        score = std::max(score, 600);
    }

    if (score == 0) {
        return 0;
    }

    if (titlePos != std::string::npos) {
        score += 50;
    }

    if (window.width > 0 && window.height > 0) {
        const int areaBonus = std::min(40, (window.width * window.height) / 500000);
        score += areaBonus;
    }

    if (titlePos == std::string::npos && titleLower.size() <= 16) {
        score -= 25;
    }

    return score;
}

}  // namespace

const WindowInfo *findBestWindowMatch(const std::vector<WindowInfo> &windows, const std::string &filter) {
    if (windows.empty()) {
        return nullptr;
    }

    if (filter.empty()) {
        return &windows.front();
    }

    const std::string filterLower = toLowerCopy(filter);
    const WindowInfo *best = nullptr;
    int bestScore = 0;
    int bestArea = -1;

    for (const auto &window : windows) {
        const int score = windowMatchScore(window, filterLower);
        if (score <= 0) {
            continue;
        }

        const int area = std::max(0, window.width) * std::max(0, window.height);
        if (!best || score > bestScore || (score == bestScore && area > bestArea)) {
            best = &window;
            bestScore = score;
            bestArea = area;
        }
    }

    return best;
}

#ifdef _WIN32

namespace {

constexpr int kFramePoolBufferCount = 4;

struct ScopedOutputDuplicationFrame {
    IDXGIOutputDuplication *duplication = nullptr;
    bool active = false;

    ~ScopedOutputDuplicationFrame() {
        if (active && duplication) {
            duplication->ReleaseFrame();
        }
    }

    void dismiss() { active = false; }
};

struct ScopedD3DTextureMap {
    ID3D11DeviceContext *context = nullptr;
    ID3D11Texture2D *texture = nullptr;
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    bool active = false;

    ~ScopedD3DTextureMap() {
        if (active && context && texture) {
            context->Unmap(texture, 0);
        }
    }
};

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

struct ThumbnailPixels {
    int width = 0;
    int height = 0;
    std::vector<uint8_t> pixels;
};

struct GdiThumbnailSurface {
    HDC screen = nullptr;
    HDC memory = nullptr;
    HBITMAP bitmap = nullptr;
    HGDIOBJ previous = nullptr;
    ~GdiThumbnailSurface() {
        if (previous && previous != HGDI_ERROR) { SelectObject(memory, previous); }
        if (bitmap) { DeleteObject(bitmap); }
        if (memory) { DeleteDC(memory); }
        if (screen) { ReleaseDC(nullptr, screen); }
    }
};

ThumbnailPixels captureNativeThumbnail(HWND hwnd) {
    // Get window dimensions
    RECT rect;
    if (!GetWindowRect(hwnd, &rect)) {
        return {};
    }

    int width = rect.right - rect.left;
    int height = rect.bottom - rect.top;

    if (width <= 0 || height <= 0) {
        return {};
    }

    // Create compatible DC and bitmap
    GdiThumbnailSurface surface;
    surface.screen = GetDC(nullptr);
    if (!surface.screen) { return {}; }
    surface.memory = CreateCompatibleDC(surface.screen);
    surface.bitmap = CreateCompatibleBitmap(surface.screen, width, height);
    if (!surface.memory || !surface.bitmap) { return {}; }
    surface.previous = SelectObject(surface.memory, surface.bitmap);
    if (!surface.previous || surface.previous == HGDI_ERROR) { return {}; }
    HDC hdcMem = surface.memory;

    // This can block indefinitely in the source process. Only call on the
    // single background worker, which owns every GDI object it passes in.
    BOOL captured = PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT);

    if (!captured) {
        // Fall back to BitBlt from window DC
        HDC hdcWindow = GetWindowDC(hwnd);
        if (hdcWindow) {
            captured = BitBlt(hdcMem, 0, 0, width, height, hdcWindow, 0, 0, SRCCOPY);
            ReleaseDC(hwnd, hdcWindow);
        }
    }

    if (!captured) {
        return {};
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

    std::vector<uint8_t> bits(static_cast<size_t>(width) * static_cast<size_t>(height) * 4);
    // GetDIBits requires the bitmap to be deselected from its device context.
    SelectObject(hdcMem, surface.previous);
    surface.previous = nullptr;
    const int copiedScanlines = GetDIBits(hdcMem, surface.bitmap, 0, height, bits.data(),
                                          reinterpret_cast<BITMAPINFO *>(&bi), DIB_RGB_COLORS);

    if (copiedScanlines != height) {
        return {};
    }

    return {width, height, std::move(bits)};
}

// A hung PrintWindow must not accumulate workers on each refresh. The worker
// captures no application objects and owns its resources until Windows returns;
// shutdown does not wait on a foreign window's message loop.
std::mutex thumbnailWorkerMutex;
std::shared_future<ThumbnailPixels> thumbnailWorkerResult;

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

#ifdef VERSUS_USE_GRAPHICS_CAPTURE

const char *appCapabilityAccessStatusToString(
    winrt::Windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus status) {
    using Status = winrt::Windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
    switch (status) {
        case Status::DeniedBySystem:
            return "DeniedBySystem";
        case Status::NotDeclaredByApp:
            return "NotDeclaredByApp";
        case Status::DeniedByUser:
            return "DeniedByUser";
        case Status::UserPromptRequired:
            return "UserPromptRequired";
        case Status::Allowed:
            return "Allowed";
    }
    return "Unknown";
}

bool hasPackageIdentity() {
    UINT32 packageNameLength = 0;
    return GetCurrentPackageFullName(&packageNameLength, nullptr) == ERROR_INSUFFICIENT_BUFFER;
}

#endif

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

        // Video-processor scaling keeps large window textures on the GPU until
        // they have been reduced to the configured output size. Capture still
        // works without these optional interfaces; processFrameUnsafe falls
        // back to the original full-size readback path in that case.
        hr = device_->QueryInterface(videoDevice_.put());
        if (FAILED(hr) || !videoDevice_) {
            spdlog::warn("[Capture::Impl] ID3D11VideoDevice unavailable; GPU capture scaling disabled hr=0x{:08x}",
                         static_cast<unsigned int>(hr));
        }
        hr = context_->QueryInterface(videoContext_.put());
        if (FAILED(hr) || !videoContext_) {
            videoDevice_ = nullptr;
            spdlog::warn("[Capture::Impl] ID3D11VideoContext unavailable; GPU capture scaling disabled hr=0x{:08x}",
                         static_cast<unsigned int>(hr));
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

    bool startCapture(HWND hwnd, int width, int height, int fps, bool preserveAlpha) {
        spdlog::info("[Capture::Impl] startCapture hwnd={} {}x{} @{}fps preserveAlpha={}",
                     (void*)hwnd,
                     width,
                     height,
                     fps,
                     preserveAlpha);
        if (capturing_.load(std::memory_order_acquire)) {
            spdlog::info("[Capture::Impl] Already capturing, stopping first");
            stopCapture();
        }
        targetHwnd_ = hwnd;
        targetWidth_ = width;
        targetHeight_ = height;
        targetFps_ = fps;
        requestedFps_.store(fps, std::memory_order_relaxed);
        preserveAlpha_ = preserveAlpha;
        framePacer_.reset(fps);
        framesSkippedBeforeReadback_.store(0, std::memory_order_relaxed);

        if (useGraphicsCapture_) {
            spdlog::info("[Capture::Impl] Using Windows Graphics Capture API");
            return startGraphicsCapture(hwnd);
        }
        spdlog::info("[Capture::Impl] Using Desktop Duplication fallback");
        return startDesktopDuplication();
    }

    void stopCapture() {
        capturing_.store(false, std::memory_order_release);
        if (captureThread_.joinable()) {
            captureThread_.join();
        }
        // Retire the frame pool before releasing resources used by its callbacks.
        if (framePool_) {
            framePool_.Close();
            framePool_ = nullptr;
        }
        outputDuplication_ = nullptr;
        stagingTexture_ = nullptr;
        scaledTexture_ = nullptr;
        scaledOutputView_ = nullptr;
        videoProcessor_ = nullptr;
        videoProcessorEnumerator_ = nullptr;
        scalerSourceWidth_ = 0;
        scalerSourceHeight_ = 0;
        scalerTargetWidth_ = 0;
        scalerTargetHeight_ = 0;
        stagingWidth_ = 0;
        stagingHeight_ = 0;
        if (captureSession_) {
            captureSession_.Close();
            captureSession_ = nullptr;
        }
#ifdef VERSUS_USE_GRAPHICS_CAPTURE
        if (captureItemClosedTokenSet_ && captureItem_) {
            try {
                captureItem_.Closed(captureItemClosedToken_);
            } catch (...) {
            }
            captureItemClosedTokenSet_ = false;
        }
#endif
        captureItem_ = nullptr;
        graphicsDevice_ = nullptr;
        lastContentWidth_ = 0;
        lastContentHeight_ = 0;
        const uint64_t skipped = framesSkippedBeforeReadback_.load(std::memory_order_relaxed);
        if (skipped > 0) {
            spdlog::info("[Capture::Impl] Skipped {} frame(s) before GPU readback", skipped);
        }
    }

    void setFrameCallback(FrameCallback callback) {
        frameCallback_ = std::move(callback);
    }

    void setFrameRate(int fps) {
        requestedFps_.store(std::clamp(fps, 1, 120), std::memory_order_relaxed);
    }

    void setFrameAdmissionCallback(FrameAdmissionCallback callback) {
        frameAdmissionCallback_ = std::move(callback);
    }

    uint64_t framesSkippedBeforeReadback() const {
        return framesSkippedBeforeReadback_.load(std::memory_order_relaxed);
    }

    bool isCapturing() const { return capturing_.load(std::memory_order_acquire); }

  private:
#ifdef VERSUS_USE_GRAPHICS_CAPTURE
    void requestBorderlessCaptureAccess() {
        if (borderlessAccessRequested_) {
            return;
        }
        borderlessAccessRequested_ = true;

        if (!hasPackageIdentity()) {
            spdlog::info("[Capture::Impl] No package identity detected; Windows may refuse graphicsCaptureWithoutBorder "
                         "for unpackaged builds");
        }

        try {
            using winrt::Windows::Graphics::Capture::GraphicsCaptureAccess;
            using winrt::Windows::Graphics::Capture::GraphicsCaptureAccessKind;
            const auto status = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless).get();
            spdlog::info("[Capture::Impl] Borderless capture access request completed with status={}",
                         appCapabilityAccessStatusToString(status));
        } catch (const winrt::hresult_error &e) {
            spdlog::warn("[Capture::Impl] Borderless capture access request failed hr=0x{:08x} msg={}",
                         static_cast<unsigned int>(e.code()),
                         winrt::to_string(e.message()));
        } catch (const std::exception &e) {
            spdlog::warn("[Capture::Impl] Borderless capture access request threw std::exception: {}", e.what());
        } catch (...) {
            spdlog::warn("[Capture::Impl] Borderless capture access request failed with unknown exception");
        }
    }

    void applyBorderlessCapturePreference() {
        try {
            captureSession_.IsBorderRequired(false);
            spdlog::info("[Capture::Impl] Requested borderless graphics capture session");
        } catch (const winrt::hresult_error &e) {
            spdlog::warn("[Capture::Impl] Failed to disable graphics capture border hr=0x{:08x} msg={}",
                         static_cast<unsigned int>(e.code()),
                         winrt::to_string(e.message()));
        } catch (const std::exception &e) {
            spdlog::warn("[Capture::Impl] Failed to disable graphics capture border: {}", e.what());
        } catch (...) {
            spdlog::warn("[Capture::Impl] Failed to disable graphics capture border with unknown exception");
        }
    }
#endif

    bool startGraphicsCapture(HWND hwnd) {
        try {
            spdlog::info("[Capture::Impl] startGraphicsCapture for hwnd={}", (void*)hwnd);
            requestBorderlessCaptureAccess();
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
            captureItemClosedToken_ = captureItem_.Closed([this](auto const &, auto const &) {
                spdlog::warn("[Capture::Impl] Graphics capture item closed");
                capturing_.store(false, std::memory_order_release);
            });
            captureItemClosedTokenSet_ = true;

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
            applyCaptureUpdateInterval(targetFps_);
            applyBorderlessCapturePreference();
            captureSession_.StartCapture();
            capturing_.store(true, std::memory_order_release);
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

    void applyCaptureUpdateInterval(int fps) {
        // Windows 11 24H2 defaults to an OS-side 60-Hz minimum interval.
        // Compositor jitter can undershoot that rate before our own limiter
        // sees a frame. Leave half an interval of headroom and keep our
        // readback limiter authoritative. Older Windows has no session5.
        // https://github.com/robmikh/Win32CaptureSample/issues/92
        if (!captureSession_) return;
        try {
            if (auto timing = captureSession_.try_as<winrt::Windows::Graphics::Capture::IGraphicsCaptureSession5>()) {
                const auto interval = winrt::Windows::Foundation::TimeSpan{
                    5000000LL / std::max(1, fps)};
                timing.MinUpdateInterval(interval);
                spdlog::info("[Capture::Impl] OS capture update interval set to {}us for {} FPS", interval.count() / 10, fps);
            }
        } catch (const winrt::hresult_error &e) {
            spdlog::debug("[Capture::Impl] Optional capture update interval unavailable hr=0x{:08x}",
                          static_cast<unsigned int>(e.code()));
        }
    }

    bool startDesktopDuplication() {
        winrt::com_ptr<IDXGIDevice> dxgiDevice;
        HRESULT hr = device_->QueryInterface(dxgiDevice.put());
        if (FAILED(hr) || !dxgiDevice) {
            spdlog::warn("[Capture::Impl] QueryInterface(IDXGIDevice) failed hr=0x{:08x}",
                         static_cast<unsigned int>(hr));
            return false;
        }
        winrt::com_ptr<IDXGIAdapter> adapter;
        hr = dxgiDevice->GetAdapter(adapter.put());
        if (FAILED(hr) || !adapter) {
            spdlog::warn("[Capture::Impl] IDXGIDevice::GetAdapter failed hr=0x{:08x}",
                         static_cast<unsigned int>(hr));
            return false;
        }
        winrt::com_ptr<IDXGIOutput> output;
        hr = adapter->EnumOutputs(0, output.put());
        if (FAILED(hr) || !output) {
            spdlog::warn("[Capture::Impl] IDXGIAdapter::EnumOutputs failed hr=0x{:08x}",
                         static_cast<unsigned int>(hr));
            return false;
        }
        DXGI_OUTPUT_DESC outputDesc = {};
        if (SUCCEEDED(output->GetDesc(&outputDesc))) {
            desktopLeft_ = outputDesc.DesktopCoordinates.left;
            desktopTop_ = outputDesc.DesktopCoordinates.top;
            desktopRight_ = outputDesc.DesktopCoordinates.right;
            desktopBottom_ = outputDesc.DesktopCoordinates.bottom;
        } else {
            desktopLeft_ = 0;
            desktopTop_ = 0;
            desktopRight_ = 0;
            desktopBottom_ = 0;
        }
        winrt::com_ptr<IDXGIOutput1> output1;
        hr = output->QueryInterface(output1.put());
        if (FAILED(hr) || !output1) {
            spdlog::warn("[Capture::Impl] QueryInterface(IDXGIOutput1) failed hr=0x{:08x}",
                         static_cast<unsigned int>(hr));
            return false;
        }
        outputDuplication_ = nullptr;
        desktopCropWarningLogged_ = false;
        hr = output1->DuplicateOutput(device_.get(), outputDuplication_.put());
        if (FAILED(hr)) {
            spdlog::warn("[Capture::Impl] DuplicateOutput failed hr=0x{:08x}", static_cast<unsigned int>(hr));
            return false;
        }
        capturing_.store(true, std::memory_order_release);
        captureThread_ = std::thread([this]() { captureLoop(); });
        return true;
    }

    void onFrameArrived(winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const &sender) {
        try {
            onFrameArrivedUnsafe(sender);
        } catch (const winrt::hresult_error &e) {
            spdlog::warn("[Capture::Impl] Frame-arrived processing failed hr=0x{:08x} msg={}",
                         static_cast<unsigned int>(e.code()),
                         winrt::to_string(e.message()));
        } catch (const std::exception &e) {
            spdlog::warn("[Capture::Impl] Frame-arrived processing failed: {}", e.what());
        } catch (...) {
            spdlog::warn("[Capture::Impl] Frame-arrived processing failed with unknown exception");
        }
    }

    void onFrameArrivedUnsafe(winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const &sender) {
        if (!capturing_.load(std::memory_order_acquire)) {
            return;
        }
        auto frame = sender.TryGetNextFrame();
        if (!frame) {
            return;
        }
        // If callbacks coalesced during a stall, read back the newest image
        // instead of chasing old pool entries in a catch-up burst.
        for (int i = 1; i < kFramePoolBufferCount; ++i) {
            auto next = sender.TryGetNextFrame();
            if (!next) break;
            frame.Close();
            frame = std::move(next);
            framesSkippedBeforeReadback_.fetch_add(1, std::memory_order_relaxed);
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
        const HRESULT hr = access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), texture.put_void());
        if (FAILED(hr) || !texture) {
            spdlog::warn("[Capture::Impl] Failed to query capture frame texture hr=0x{:08x}",
                         static_cast<unsigned int>(hr));
            return;
        }
        int64_t timestamp = frame.SystemRelativeTime().count();
        processFrame(texture.get(), timestamp, contentWidth, contentHeight, 0, 0);
    }

    void captureLoop() {
        while (capturing_.load(std::memory_order_acquire)) {
            winrt::com_ptr<IDXGIResource> resource;
            DXGI_OUTDUPL_FRAME_INFO frameInfo;
            HRESULT hr = outputDuplication_->AcquireNextFrame(100, &frameInfo, resource.put());
            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                continue;
            }
            if (FAILED(hr)) {
                spdlog::warn("[Capture::Impl] Desktop duplication frame acquisition failed hr=0x{:08x}",
                             static_cast<unsigned int>(hr));
                capturing_.store(false, std::memory_order_release);
                break;
            }
            ScopedOutputDuplicationFrame releaseFrame{outputDuplication_.get(), true};
            winrt::com_ptr<ID3D11Texture2D> texture;
            hr = resource->QueryInterface(texture.put());
            if (FAILED(hr) || !texture) {
                spdlog::warn("[Capture::Impl] Desktop duplication frame was not a texture hr=0x{:08x}",
                             static_cast<unsigned int>(hr));
                continue;
            }
            D3D11_TEXTURE2D_DESC desc;
            texture->GetDesc(&desc);
            int sourceX = 0;
            int sourceY = 0;
            int contentWidth = static_cast<int>(desc.Width);
            int contentHeight = static_cast<int>(desc.Height);
            if (targetHwnd_) {
                RECT windowRect = {};
                if (!IsWindow(targetHwnd_) || !GetWindowRect(targetHwnd_, &windowRect)) {
                    spdlog::warn("[Capture::Impl] Target window closed during desktop duplication capture");
                    capturing_.store(false, std::memory_order_release);
                    break;
                }

                const LONG desktopLeft = desktopRight_ > desktopLeft_ ? desktopLeft_ : 0;
                const LONG desktopTop = desktopBottom_ > desktopTop_ ? desktopTop_ : 0;
                const LONG desktopRight = desktopRight_ > desktopLeft_ ? desktopRight_ : static_cast<LONG>(desc.Width);
                const LONG desktopBottom = desktopBottom_ > desktopTop_ ? desktopBottom_ : static_cast<LONG>(desc.Height);
                const LONG cropLeft = std::max(windowRect.left, desktopLeft);
                const LONG cropTop = std::max(windowRect.top, desktopTop);
                const LONG cropRight = std::min(windowRect.right, desktopRight);
                const LONG cropBottom = std::min(windowRect.bottom, desktopBottom);
                if (cropRight <= cropLeft || cropBottom <= cropTop) {
                    if (!desktopCropWarningLogged_) {
                        spdlog::warn("[Capture::Impl] Target window is outside duplicated output; waiting for it to return");
                        desktopCropWarningLogged_ = true;
                    }
                    continue;
                }
                desktopCropWarningLogged_ = false;
                sourceX = static_cast<int>(cropLeft - desktopLeft);
                sourceY = static_cast<int>(cropTop - desktopTop);
                contentWidth = static_cast<int>(cropRight - cropLeft);
                contentHeight = static_cast<int>(cropBottom - cropTop);
            }
            processFrame(texture.get(),
                         frameInfo.LastPresentTime.QuadPart,
                         contentWidth,
                         contentHeight,
                         sourceX,
                         sourceY);
        }
    }

    void processFrame(ID3D11Texture2D *texture,
                      int64_t timestamp,
                      int contentWidth,
                      int contentHeight,
                      int sourceX,
                      int sourceY) {
        try {
            processFrameUnsafe(texture, timestamp, contentWidth, contentHeight, sourceX, sourceY);
        } catch (const std::exception &e) {
            spdlog::warn("[Capture::Impl] Frame copy failed: {}", e.what());
        } catch (...) {
            spdlog::warn("[Capture::Impl] Frame copy failed with unknown exception");
        }
    }

    bool ensureGpuScaler(const D3D11_TEXTURE2D_DESC &sourceDesc,
                         int targetWidth,
                         int targetHeight) {
        if (!videoDevice_ || !videoContext_ ||
            targetWidth <= 0 || targetHeight <= 0 ||
            sourceDesc.Width == 0 || sourceDesc.Height == 0) {
            return false;
        }

        if (videoProcessor_ && videoProcessorEnumerator_ && scaledTexture_ && scaledOutputView_ &&
            scalerSourceWidth_ == sourceDesc.Width &&
            scalerSourceHeight_ == sourceDesc.Height &&
            scalerSourceFormat_ == sourceDesc.Format &&
            scalerTargetWidth_ == static_cast<UINT>(targetWidth) &&
            scalerTargetHeight_ == static_cast<UINT>(targetHeight)) {
            return true;
        }

        videoProcessor_ = nullptr;
        videoProcessorEnumerator_ = nullptr;
        scaledOutputView_ = nullptr;
        scaledTexture_ = nullptr;

        D3D11_VIDEO_PROCESSOR_CONTENT_DESC contentDesc = {};
        contentDesc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
        contentDesc.InputFrameRate.Numerator = static_cast<UINT>(std::max(1, targetFps_));
        contentDesc.InputFrameRate.Denominator = 1;
        contentDesc.InputWidth = sourceDesc.Width;
        contentDesc.InputHeight = sourceDesc.Height;
        contentDesc.OutputFrameRate = contentDesc.InputFrameRate;
        contentDesc.OutputWidth = static_cast<UINT>(targetWidth);
        contentDesc.OutputHeight = static_cast<UINT>(targetHeight);
        contentDesc.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;

        HRESULT hr = videoDevice_->CreateVideoProcessorEnumerator(
            &contentDesc,
            videoProcessorEnumerator_.put());
        if (FAILED(hr) || !videoProcessorEnumerator_) {
            if (!gpuScaleFailureLogged_) {
                spdlog::warn("[Capture::Impl] Failed to create GPU scaler enumerator hr=0x{:08x}",
                             static_cast<unsigned int>(hr));
                gpuScaleFailureLogged_ = true;
            }
            return false;
        }

        UINT sourceSupport = 0;
        UINT targetSupport = 0;
        hr = videoProcessorEnumerator_->CheckVideoProcessorFormat(sourceDesc.Format, &sourceSupport);
        if (FAILED(hr) || (sourceSupport & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) == 0) {
            if (!gpuScaleFailureLogged_) {
                spdlog::warn("[Capture::Impl] GPU scaler does not support capture format {} as input hr=0x{:08x}",
                             static_cast<unsigned int>(sourceDesc.Format),
                             static_cast<unsigned int>(hr));
                gpuScaleFailureLogged_ = true;
            }
            videoProcessorEnumerator_ = nullptr;
            return false;
        }
        hr = videoProcessorEnumerator_->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &targetSupport);
        if (FAILED(hr) || (targetSupport & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT) == 0) {
            if (!gpuScaleFailureLogged_) {
                spdlog::warn("[Capture::Impl] GPU scaler does not support BGRA output hr=0x{:08x}",
                             static_cast<unsigned int>(hr));
                gpuScaleFailureLogged_ = true;
            }
            videoProcessorEnumerator_ = nullptr;
            return false;
        }

        hr = videoDevice_->CreateVideoProcessor(
            videoProcessorEnumerator_.get(),
            0,
            videoProcessor_.put());
        if (FAILED(hr) || !videoProcessor_) {
            if (!gpuScaleFailureLogged_) {
                spdlog::warn("[Capture::Impl] Failed to create GPU scaler hr=0x{:08x}",
                             static_cast<unsigned int>(hr));
                gpuScaleFailureLogged_ = true;
            }
            videoProcessorEnumerator_ = nullptr;
            return false;
        }

        D3D11_TEXTURE2D_DESC outputDesc = {};
        outputDesc.Width = static_cast<UINT>(targetWidth);
        outputDesc.Height = static_cast<UINT>(targetHeight);
        outputDesc.MipLevels = 1;
        outputDesc.ArraySize = 1;
        outputDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        outputDesc.SampleDesc.Count = 1;
        outputDesc.Usage = D3D11_USAGE_DEFAULT;
        outputDesc.BindFlags = D3D11_BIND_RENDER_TARGET;
        hr = device_->CreateTexture2D(&outputDesc, nullptr, scaledTexture_.put());
        if (FAILED(hr) || !scaledTexture_) {
            if (!gpuScaleFailureLogged_) {
                spdlog::warn("[Capture::Impl] Failed to create GPU-scaled capture texture hr=0x{:08x}",
                             static_cast<unsigned int>(hr));
                gpuScaleFailureLogged_ = true;
            }
            videoProcessor_ = nullptr;
            videoProcessorEnumerator_ = nullptr;
            return false;
        }

        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outputViewDesc = {};
        outputViewDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
        outputViewDesc.Texture2D.MipSlice = 0;
        hr = videoDevice_->CreateVideoProcessorOutputView(
            scaledTexture_.get(),
            videoProcessorEnumerator_.get(),
            &outputViewDesc,
            scaledOutputView_.put());
        if (FAILED(hr) || !scaledOutputView_) {
            if (!gpuScaleFailureLogged_) {
                spdlog::warn("[Capture::Impl] Failed to create GPU scaler output view hr=0x{:08x}",
                             static_cast<unsigned int>(hr));
                gpuScaleFailureLogged_ = true;
            }
            scaledTexture_ = nullptr;
            videoProcessor_ = nullptr;
            videoProcessorEnumerator_ = nullptr;
            return false;
        }

        scalerSourceWidth_ = sourceDesc.Width;
        scalerSourceHeight_ = sourceDesc.Height;
        scalerSourceFormat_ = sourceDesc.Format;
        scalerTargetWidth_ = static_cast<UINT>(targetWidth);
        scalerTargetHeight_ = static_cast<UINT>(targetHeight);
        gpuScaleFailureLogged_ = false;
        spdlog::info("[Capture::Impl] GPU capture scaler ready: {}x{} -> {}x{}",
                     sourceDesc.Width,
                     sourceDesc.Height,
                     targetWidth,
                     targetHeight);
        return true;
    }

    ID3D11Texture2D *scaleFrameOnGpu(ID3D11Texture2D *texture,
                                     const D3D11_TEXTURE2D_DESC &sourceDesc,
                                     int sourceX,
                                     int sourceY,
                                     int contentWidth,
                                     int contentHeight) {
        // Video-processor drivers are optimized for opaque video and need not
        // retain the source texture's per-pixel alpha. Transparent and chroma
        // workflows keep the established alpha-preserving CPU path.
        if (preserveAlpha_) {
            return nullptr;
        }

        const int targetWidth = std::max(1, targetWidth_);
        const int targetHeight = std::max(1, targetHeight_);
        if (!ensureGpuScaler(sourceDesc, targetWidth, targetHeight)) {
            return nullptr;
        }

        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inputViewDesc = {};
        inputViewDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        inputViewDesc.Texture2D.MipSlice = 0;
        inputViewDesc.Texture2D.ArraySlice = 0;
        winrt::com_ptr<ID3D11VideoProcessorInputView> inputView;
        HRESULT hr = videoDevice_->CreateVideoProcessorInputView(
            texture,
            videoProcessorEnumerator_.get(),
            &inputViewDesc,
            inputView.put());
        if (FAILED(hr) || !inputView) {
            if (!gpuScaleFailureLogged_) {
                spdlog::warn("[Capture::Impl] Failed to create GPU scaler input view hr=0x{:08x}",
                             static_cast<unsigned int>(hr));
                gpuScaleFailureLogged_ = true;
            }
            return nullptr;
        }

        const RECT sourceRect = {
            sourceX,
            sourceY,
            sourceX + contentWidth,
            sourceY + contentHeight};
        const AspectFitRect fit = computeAspectFitRect(
            contentWidth,
            contentHeight,
            targetWidth,
            targetHeight);
        if (fit.width <= 0 || fit.height <= 0) {
            return nullptr;
        }
        const RECT destinationRect = {
            fit.x,
            fit.y,
            fit.x + fit.width,
            fit.y + fit.height};
        const RECT outputRect = {0, 0, targetWidth, targetHeight};
        D3D11_VIDEO_COLOR background = {};
        background.RGBA.A = 1.0f;

        videoContext_->VideoProcessorSetOutputTargetRect(videoProcessor_.get(), TRUE, &outputRect);
        videoContext_->VideoProcessorSetOutputBackgroundColor(videoProcessor_.get(), FALSE, &background);
        videoContext_->VideoProcessorSetStreamFrameFormat(
            videoProcessor_.get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        videoContext_->VideoProcessorSetStreamSourceRect(videoProcessor_.get(), 0, TRUE, &sourceRect);
        videoContext_->VideoProcessorSetStreamDestRect(videoProcessor_.get(), 0, TRUE, &destinationRect);

        D3D11_VIDEO_PROCESSOR_STREAM stream = {};
        stream.Enable = TRUE;
        stream.OutputIndex = 0;
        stream.InputFrameOrField = 0;
        stream.pInputSurface = inputView.get();
        hr = videoContext_->VideoProcessorBlt(
            videoProcessor_.get(),
            scaledOutputView_.get(),
            0,
            1,
            &stream);
        if (FAILED(hr)) {
            if (!gpuScaleFailureLogged_) {
                spdlog::warn("[Capture::Impl] GPU capture scaling failed hr=0x{:08x}; using CPU fallback",
                             static_cast<unsigned int>(hr));
                gpuScaleFailureLogged_ = true;
            }
            return nullptr;
        }
        return scaledTexture_.get();
    }

    void processFrameUnsafe(ID3D11Texture2D *texture,
                            int64_t timestamp,
                            int contentWidth,
                            int contentHeight,
                            int sourceX,
                            int sourceY) {
        if (!texture) {
            return;
        }
        std::lock_guard<std::mutex> processLock(processFrameMutex_);
        // Reset the limiter on its owning capture thread. Runtime controls must
        // not leave fresh image capture capped at the startup frame rate while
        // the output thread fills the higher requested cadence with repeats.
        const int requestedFps = requestedFps_.load(std::memory_order_relaxed);
        if (requestedFps != targetFps_) {
            targetFps_ = requestedFps;
            framePacer_.reset(targetFps_);
            applyCaptureUpdateInterval(targetFps_);
        }
        // WGC SystemRelativeTime is the compositor's QPC timestamp in 100-ns
        // units. Callback/lock scheduling jitter must not discard source frames
        // around a deadline. Desktop duplication retains its wall-clock limiter.
        const auto frameTime = useGraphicsCapture_
            ? std::chrono::steady_clock::time_point(
                std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                    std::chrono::duration<int64_t, std::ratio<1, 10000000>>(timestamp)))
            : std::chrono::steady_clock::now();
        if (!detail::frameAdmissionAllowed(frameAdmissionCallback_) ||
            !framePacer_.shouldAdmit(frameTime)) {
            framesSkippedBeforeReadback_.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        D3D11_TEXTURE2D_DESC desc;
        texture->GetDesc(&desc);
        if (desc.Width == 0 || desc.Height == 0) {
            return;
        }

        const int maxSourceX = std::max(0, static_cast<int>(desc.Width) - 1);
        const int maxSourceY = std::max(0, static_cast<int>(desc.Height) - 1);
        sourceX = std::clamp(sourceX, 0, maxSourceX);
        sourceY = std::clamp(sourceY, 0, maxSourceY);
        contentWidth = std::max(1, std::min<int>(contentWidth, static_cast<int>(desc.Width) - sourceX));
        contentHeight = std::max(1, std::min<int>(contentHeight, static_cast<int>(desc.Height) - sourceY));

        ID3D11Texture2D *readbackSource = scaleFrameOnGpu(
            texture,
            desc,
            sourceX,
            sourceY,
            contentWidth,
            contentHeight);
        const bool gpuScaled = readbackSource != nullptr;
        if (!gpuScaled) {
            readbackSource = texture;
        }

        D3D11_TEXTURE2D_DESC readbackDesc;
        readbackSource->GetDesc(&readbackDesc);
        if (!stagingTexture_ || stagingWidth_ != readbackDesc.Width || stagingHeight_ != readbackDesc.Height) {
            D3D11_TEXTURE2D_DESC stagingDesc = readbackDesc;
            stagingDesc.Usage = D3D11_USAGE_STAGING;
            stagingDesc.BindFlags = 0;
            stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            stagingDesc.MiscFlags = 0;
            if (FAILED(device_->CreateTexture2D(&stagingDesc, nullptr, stagingTexture_.put()))) {
                return;
            }
            stagingWidth_ = readbackDesc.Width;
            stagingHeight_ = readbackDesc.Height;
        }

        context_->CopyResource(stagingTexture_.get(), readbackSource);
        ScopedD3DTextureMap mapped{context_.get(), stagingTexture_.get()};
        const HRESULT mapHr = context_->Map(stagingTexture_.get(), 0, D3D11_MAP_READ, 0, &mapped.mapped);
        if (FAILED(mapHr)) {
            spdlog::warn("[Capture::Impl] Failed to map staging texture hr=0x{:08x}",
                         static_cast<unsigned int>(mapHr));
            return;
        }
        mapped.active = true;

        CapturedFrame frame;
        frame.width = gpuScaled ? static_cast<int>(readbackDesc.Width) : contentWidth;
        frame.height = gpuScaled ? static_cast<int>(readbackDesc.Height) : contentHeight;
        frame.stride = frame.width * 4;
        frame.timestamp = timestamp;
        frame.format = CapturedFrame::Format::BGRA;
        size_t dataSize = static_cast<size_t>(frame.stride) * static_cast<size_t>(frame.height);
        frame.data.resize(dataSize);
        const auto *mappedBytes = static_cast<const uint8_t *>(mapped.mapped.pData);
        for (int y = 0; y < frame.height; ++y) {
            const int readbackX = gpuScaled ? 0 : sourceX;
            const int readbackY = gpuScaled ? y : sourceY + y;
            const uint8_t *srcRow = mappedBytes + static_cast<size_t>(readbackY) * mapped.mapped.RowPitch +
                                    static_cast<size_t>(readbackX) * 4;
            uint8_t *dstRow = frame.data.data() + static_cast<size_t>(y) * frame.stride;
            std::memcpy(dstRow, srcRow, static_cast<size_t>(frame.stride));
        }

        if (frameCallback_) {
            frameCallback_(std::move(frame));
        }
    }

    winrt::com_ptr<ID3D11Device> device_;
    winrt::com_ptr<ID3D11DeviceContext> context_;
    winrt::com_ptr<ID3D11VideoDevice> videoDevice_;
    winrt::com_ptr<ID3D11VideoContext> videoContext_;
    winrt::com_ptr<ID3D11VideoProcessorEnumerator> videoProcessorEnumerator_;
    winrt::com_ptr<ID3D11VideoProcessor> videoProcessor_;
    winrt::com_ptr<ID3D11Texture2D> scaledTexture_;
    winrt::com_ptr<ID3D11VideoProcessorOutputView> scaledOutputView_;
    winrt::com_ptr<ID3D11Texture2D> stagingTexture_;
    winrt::com_ptr<IDXGIOutputDuplication> outputDuplication_;

    bool useGraphicsCapture_ = false;
#ifdef VERSUS_USE_GRAPHICS_CAPTURE
    bool borderlessAccessRequested_ = false;
    winrt::event_token captureItemClosedToken_{};
    bool captureItemClosedTokenSet_ = false;
#endif
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem captureItem_{nullptr};
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool framePool_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession captureSession_{nullptr};
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice graphicsDevice_{nullptr};

    HWND targetHwnd_ = nullptr;
    int targetWidth_ = 0;
    int targetHeight_ = 0;
    int targetFps_ = 60;
    std::atomic<int> requestedFps_{60};
    bool preserveAlpha_ = false;
    detail::CaptureFramePacer framePacer_{60};
    std::atomic<bool> capturing_{false};
    std::atomic<uint64_t> framesSkippedBeforeReadback_{0};

    UINT stagingWidth_ = 0;
    UINT stagingHeight_ = 0;
    UINT scalerSourceWidth_ = 0;
    UINT scalerSourceHeight_ = 0;
    DXGI_FORMAT scalerSourceFormat_ = DXGI_FORMAT_UNKNOWN;
    UINT scalerTargetWidth_ = 0;
    UINT scalerTargetHeight_ = 0;
    bool gpuScaleFailureLogged_ = false;
    int lastContentWidth_ = 0;
    int lastContentHeight_ = 0;
    LONG desktopLeft_ = 0;
    LONG desktopTop_ = 0;
    LONG desktopRight_ = 0;
    LONG desktopBottom_ = 0;
    bool desktopCropWarningLogged_ = false;

    std::mutex processFrameMutex_;
    FrameCallback frameCallback_;
    FrameAdmissionCallback frameAdmissionCallback_;
    std::thread captureThread_;
};

#else

class WindowCapture::Impl {
  public:
    bool initialize() { return false; }
    std::vector<WindowInfo> enumerateWindows() { return {}; }
    bool startCapture(void *, int, int, int, bool) { return false; }
    void stopCapture() {}
    void setFrameCallback(FrameCallback) {}
    void setFrameAdmissionCallback(FrameAdmissionCallback) {}
    void setFrameRate(int) {}
    uint64_t framesSkippedBeforeReadback() const { return 0; }
    bool isCapturing() const { return false; }
};

#endif

WindowCapture::WindowCapture() : impl_(std::make_unique<Impl>()) {
#ifdef _WIN32
    impl_->initialize();
#endif
}

WindowCapture::~WindowCapture() { stopCapture(); }

void WindowCapture::setFrameRate(int fps) {
    impl_->setFrameRate(fps);
}

std::vector<WindowInfo> WindowCapture::getWindows() {
    return impl_->enumerateWindows();
}

WindowInfo *WindowCapture::findWindowByName(const std::string &partialName) {
    static std::vector<WindowInfo> cached;
    cached = getWindows();
    return const_cast<WindowInfo *>(findBestWindowMatch(cached, partialName));
}

bool WindowCapture::startCapture(const std::string &windowId,
                                 int width,
                                 int height,
                                 int fps,
                                 bool preserveAlpha) {
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
    capturing_.store(
        impl_->startCapture(hwnd, width, height, fps, preserveAlpha),
        std::memory_order_release);
    spdlog::info("[Capture] impl->startCapture returned {}", capturing_.load(std::memory_order_acquire));
    return capturing_.load(std::memory_order_acquire);
#else
    return false;
#endif
}

void WindowCapture::stopCapture() {
    impl_->stopCapture();
    capturing_.store(false, std::memory_order_release);
}

bool WindowCapture::isCapturing() const {
    return impl_->isCapturing();
}

void WindowCapture::setFrameCallback(FrameCallback cb) {
    frameCallback_ = std::move(cb);
    impl_->setFrameCallback(frameCallback_);
}

void WindowCapture::setFrameAdmissionCallback(FrameAdmissionCallback cb) {
    frameAdmissionCallback_ = std::move(cb);
    impl_->setFrameAdmissionCallback(frameAdmissionCallback_);
}

uint64_t WindowCapture::framesSkippedBeforeReadback() const {
    return impl_->framesSkippedBeforeReadback();
}

QPixmap WindowCapture::captureWindowThumbnail(const std::string &windowId, int maxWidth, int maxHeight) {
#ifdef _WIN32
    HWND hwnd = nullptr;
    if (!tryParseWindowHandle(windowId, hwnd) || !IsWindow(hwnd) || maxWidth <= 0 || maxHeight <= 0) {
        return {};
    }

    std::shared_future<ThumbnailPixels> result;
    try {
        {
            std::lock_guard<std::mutex> lock(thumbnailWorkerMutex);
            if (!thumbnailWorkerResult.valid() ||
                thumbnailWorkerResult.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready) {
                auto task = std::make_shared<std::packaged_task<ThumbnailPixels()>>(
                    [hwnd]() { return captureNativeThumbnail(hwnd); });
                thumbnailWorkerResult = task->get_future().share();
                std::thread([task]() { (*task)(); }).detach();
                result = thumbnailWorkerResult;
            }
        }
        // While a source is stalled, use the existing non-PrintWindow fallback
        // for subsequent requests without launching another worker or waiting.
        if (result.valid() && result.wait_for(std::chrono::milliseconds(100)) == std::future_status::ready) {
            const auto &native = result.get();
            if (!native.pixels.empty()) {
                QImage image(native.pixels.data(), native.width, native.height,
                             native.width * 4, QImage::Format_ARGB32);
                return QPixmap::fromImage(image.copy()).scaled(
                    maxWidth, maxHeight, Qt::KeepAspectRatio, Qt::SmoothTransformation);
            }
        }
    } catch (const std::exception &error) {
        spdlog::warn("[WindowCapture] Thumbnail capture failed: {}", error.what());
    }
    return captureViaScreenGrab(hwnd, maxWidth, maxHeight);
#else
    Q_UNUSED(windowId)
    Q_UNUSED(maxWidth)
    Q_UNUSED(maxHeight)
    return {};
#endif
}

}  // namespace versus::video
