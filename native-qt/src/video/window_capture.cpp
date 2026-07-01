#include "versus/video/window_capture.h"

#include <algorithm>
#include <atomic>
#include <exception>
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
        if (capturing_.load(std::memory_order_acquire)) {
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
        capturing_.store(false, std::memory_order_release);
        if (captureThread_.joinable()) {
            captureThread_.join();
        }
        outputDuplication_ = nullptr;
        stagingTexture_ = nullptr;
        if (framePool_) {
            framePool_.Close();
            framePool_ = nullptr;
        }
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
        D3D11_TEXTURE2D_DESC desc;
        texture->GetDesc(&desc);
        if (desc.Width == 0 || desc.Height == 0) {
            return;
        }

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
        ScopedD3DTextureMap mapped{context_.get(), stagingTexture_.get()};
        const HRESULT mapHr = context_->Map(stagingTexture_.get(), 0, D3D11_MAP_READ, 0, &mapped.mapped);
        if (FAILED(mapHr)) {
            spdlog::warn("[Capture::Impl] Failed to map staging texture hr=0x{:08x}",
                         static_cast<unsigned int>(mapHr));
            return;
        }
        mapped.active = true;

        const int maxSourceX = std::max(0, static_cast<int>(desc.Width) - 1);
        const int maxSourceY = std::max(0, static_cast<int>(desc.Height) - 1);
        sourceX = std::clamp(sourceX, 0, maxSourceX);
        sourceY = std::clamp(sourceY, 0, maxSourceY);

        CapturedFrame frame;
        frame.width = std::max(1, std::min<int>(contentWidth, static_cast<int>(desc.Width) - sourceX));
        frame.height = std::max(1, std::min<int>(contentHeight, static_cast<int>(desc.Height) - sourceY));
        frame.stride = frame.width * 4;
        frame.timestamp = timestamp;
        frame.format = CapturedFrame::Format::BGRA;
        size_t dataSize = static_cast<size_t>(frame.stride) * static_cast<size_t>(frame.height);
        frame.data.resize(dataSize);
        const auto *mappedBytes = static_cast<const uint8_t *>(mapped.mapped.pData);
        for (int y = 0; y < frame.height; ++y) {
            const uint8_t *srcRow = mappedBytes + static_cast<size_t>(sourceY + y) * mapped.mapped.RowPitch +
                                    static_cast<size_t>(sourceX) * 4;
            uint8_t *dstRow = frame.data.data() + static_cast<size_t>(y) * frame.stride;
            std::memcpy(dstRow, srcRow, static_cast<size_t>(frame.stride));
        }

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
    std::atomic<bool> capturing_{false};

    UINT stagingWidth_ = 0;
    UINT stagingHeight_ = 0;
    int lastContentWidth_ = 0;
    int lastContentHeight_ = 0;
    LONG desktopLeft_ = 0;
    LONG desktopTop_ = 0;
    LONG desktopRight_ = 0;
    LONG desktopBottom_ = 0;
    bool desktopCropWarningLogged_ = false;

    std::mutex processFrameMutex_;
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
    return const_cast<WindowInfo *>(findBestWindowMatch(cached, partialName));
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
    capturing_.store(impl_->startCapture(hwnd, width, height, fps), std::memory_order_release);
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
