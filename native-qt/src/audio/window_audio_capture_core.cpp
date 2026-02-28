#include "versus/audio/window_audio_capture_core.h"

#include <algorithm>
#include <memory>
#include <utility>

#ifdef _WIN32
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <ksmedia.h>
#include <psapi.h>
#include <propvarutil.h>
#include <roapi.h>
#include <shlwapi.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <wrl/wrappers/corewrappers.h>

using Microsoft::WRL::ComPtr;

namespace {
constexpr DWORD kDefaultSampleRate = 48000;
constexpr WORD kDefaultChannelCount = 2;
constexpr REFERENCE_TIME kDefaultBufferDuration = 100000;
constexpr wchar_t kProcessLoopbackDevice[] = L"VAD\\Process_Loopback";
constexpr wchar_t kProcessLoopbackLegacyId[] = L"{B8EC8EE7-E1B3-48BB-B91C-A93EE8AC6274}";

using ActivateAudioInterfaceAsyncFn = HRESULT (WINAPI *)(LPCWSTR, REFIID, PROPVARIANT *,
    IActivateAudioInterfaceCompletionHandler *, IActivateAudioInterfaceAsyncOperation **);

ActivateAudioInterfaceAsyncFn LoadActivateAudioInterfaceAsync() {
    static ActivateAudioInterfaceAsyncFn fn = []() -> ActivateAudioInterfaceAsyncFn {
        HMODULE module = LoadLibraryW(L"Mmdevapi.dll");
        if (!module) {
            return nullptr;
        }
        return reinterpret_cast<ActivateAudioInterfaceAsyncFn>(GetProcAddress(module, "ActivateAudioInterfaceAsync"));
    }();
    return fn;
}

struct ScopedPropVariant {
    ScopedPropVariant() { PropVariantInit(&value); }
    ~ScopedPropVariant() { PropVariantClear(&value); }
    PROPVARIANT *get() { return &value; }
    PROPVARIANT value;
};

std::string WideToUtf8(const std::wstring &str) {
    if (str.empty()) {
        return std::string();
    }
    int required = WideCharToMultiByte(CP_UTF8, 0, str.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (required <= 0) {
        return std::string();
    }
    std::string utf8(static_cast<size_t>(required), '\0');
    if (WideCharToMultiByte(CP_UTF8, 0, str.c_str(), -1, &utf8[0], required, nullptr, nullptr) <= 0) {
        return std::string();
    }
    if (!utf8.empty() && utf8.back() == '\0') {
        utf8.pop_back();
    }
    return utf8;
}

std::string GetProcessExecutableName(DWORD processId) {
    std::string result;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, processId);
    if (!process) {
        return result;
    }
    wchar_t buffer[MAX_PATH] = {0};
    DWORD size = MAX_PATH;
    if (QueryFullProcessImageNameW(process, 0, buffer, &size)) {
        std::wstring path(buffer, size);
        result = WideToUtf8(PathFindFileNameW(path.c_str()));
    }
    CloseHandle(process);
    return result;
}

BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lparam) {
    if (!IsWindowVisible(hwnd)) {
        return TRUE;
    }
    int length = GetWindowTextLengthW(hwnd);
    if (length <= 0) {
        return TRUE;
    }
    std::wstring title(static_cast<size_t>(length + 1), L'\0');
    GetWindowTextW(hwnd, &title[0], length + 1);
    title.resize(static_cast<size_t>(length));
    DWORD processId = 0;
    GetWindowThreadProcessId(hwnd, &processId);

    auto windows = reinterpret_cast<std::vector<versus::audio::WindowInfo> *>(lparam);
    versus::audio::WindowInfo info;
    info.id = reinterpret_cast<uint64_t>(hwnd);
    info.processId = processId;
    info.title = WideToUtf8(title);
    info.executableName = GetProcessExecutableName(processId);
    windows->push_back(std::move(info));
    return TRUE;
}

std::vector<versus::audio::WindowInfo> EnumerateWindows() {
    std::vector<versus::audio::WindowInfo> windows;
    EnumWindows(EnumWindowsProc, reinterpret_cast<LPARAM>(&windows));
    return windows;
}

std::vector<versus::audio::AudioSessionInfo> EnumerateAudioSessions() {
    std::vector<versus::audio::AudioSessionInfo> sessions;

    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                               IID_PPV_ARGS(&enumerator)))) {
        return sessions;
    }

    ComPtr<IMMDevice> device;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device))) {
        return sessions;
    }

    ComPtr<IAudioSessionManager2> manager;
    if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                reinterpret_cast<void **>(manager.GetAddressOf())))) {
        return sessions;
    }

    ComPtr<IAudioSessionEnumerator> sessionEnumerator;
    if (FAILED(manager->GetSessionEnumerator(&sessionEnumerator))) {
        return sessions;
    }

    int count = 0;
    if (FAILED(sessionEnumerator->GetCount(&count))) {
        return sessions;
    }

    for (int i = 0; i < count; ++i) {
        ComPtr<IAudioSessionControl> control;
        if (FAILED(sessionEnumerator->GetSession(i, &control))) {
            continue;
        }

        ComPtr<IAudioSessionControl2> control2;
        if (FAILED(control->QueryInterface(IID_PPV_ARGS(&control2)))) {
            continue;
        }

        DWORD processId = 0;
        if (FAILED(control2->GetProcessId(&processId))) {
            continue;
        }

        AudioSessionState state = AudioSessionStateInactive;
        control2->GetState(&state);

        versus::audio::AudioSessionInfo info;
        info.sessionId = static_cast<uint32_t>(i);
        info.processId = processId;
        info.active = (state == AudioSessionStateActive);
        info.executableName = GetProcessExecutableName(processId);

        LPWSTR displayName = nullptr;
        if (SUCCEEDED(control->GetDisplayName(&displayName)) && displayName) {
            info.displayName = WideToUtf8(displayName);
            CoTaskMemFree(displayName);
        }

        HRESULT systemSoundsHr = control2->IsSystemSoundsSession();
        if (SUCCEEDED(systemSoundsHr)) {
            info.isSystemSounds = (systemSoundsHr == S_OK);
        }

        sessions.push_back(std::move(info));
    }

    return sessions;
}

class ActivateAudioInterfaceHandler
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
  public:
    ActivateAudioInterfaceHandler() { event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr); }

    HRESULT GetActivateResult(IAudioClient **client, DWORD timeoutMs = 5000) {
        if (!event_) {
            return E_FAIL;
        }
        DWORD wait = WaitForSingleObject(event_, timeoutMs);
        if (wait != WAIT_OBJECT_0) {
            return HRESULT_FROM_WIN32(wait == WAIT_TIMEOUT ? WAIT_TIMEOUT : ERROR_GEN_FAILURE);
        }
        if (FAILED(result_)) {
            return result_;
        }
        if (!unknown_) {
            return E_FAIL;
        }
        return unknown_->QueryInterface(IID_PPV_ARGS(client));
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation *operation) override {
        HRESULT hr = E_FAIL;
        if (operation) {
            hr = operation->GetActivateResult(&result_, &unknown_);
        }
        SetEvent(event_);
        return hr;
    }

  private:
    ComPtr<IUnknown> unknown_;
    HRESULT result_ = E_FAIL;
    HANDLE event_ = nullptr;
};

}  // namespace

namespace versus::audio {

WindowAudioCaptureCore::WindowAudioCaptureCore() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (SUCCEEDED(hr)) {
        coInitialized_ = true;
    }
    hr = RoInitialize(RO_INIT_MULTITHREADED);
    if (SUCCEEDED(hr)) {
        roInitialized_ = true;
    }
}

WindowAudioCaptureCore::~WindowAudioCaptureCore() {
    StopCapture();
    if (roInitialized_) {
        RoUninitialize();
    }
    if (coInitialized_) {
        CoUninitialize();
    }
}

std::vector<WindowInfo> WindowAudioCaptureCore::GetWindowList() {
    return EnumerateWindows();
}

std::vector<AudioSessionInfo> WindowAudioCaptureCore::GetAudioSessions() {
    return EnumerateAudioSessions();
}

CaptureResult WindowAudioCaptureCore::StartCapture(uint32_t processId) {
    StopCapture();
    return StartProcessLoopback(processId);
}

CaptureResult WindowAudioCaptureCore::StartStreamCapture(uint32_t processId, StreamCallback callback) {
    StopCapture();

    {
        std::lock_guard<std::mutex> lock(callbackMutex_);
        streamCallback_ = std::move(callback);
    }
    streaming_.store(true);

    CaptureResult result = StartProcessLoopback(processId);
    if (!result.success) {
        std::lock_guard<std::mutex> lock(callbackMutex_);
        streamCallback_ = nullptr;
        streaming_.store(false);
    }
    return result;
}

void WindowAudioCaptureCore::StopCapture() {
    std::thread threadToJoin;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (capturing_.exchange(false)) {
            if (stopEvent_) {
                SetEvent(static_cast<HANDLE>(stopEvent_));
            }
            if (audioClient_) {
                static_cast<IAudioClient *>(audioClient_)->Stop();
            }
        }
        if (captureThread_.joinable()) {
            threadToJoin = std::move(captureThread_);
        }
    }

    if (threadToJoin.joinable()) {
        threadToJoin.join();
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (sampleReadyEvent_) {
            CloseHandle(static_cast<HANDLE>(sampleReadyEvent_));
            sampleReadyEvent_ = nullptr;
        }
        if (stopEvent_) {
            CloseHandle(static_cast<HANDLE>(stopEvent_));
            stopEvent_ = nullptr;
        }
        captureClient_ = nullptr;
        audioClient_ = nullptr;
        audioBuffer_.clear();
        usingProcessLoopback_.store(false);
        sampleRate_ = kDefaultSampleRate;
        channels_ = kDefaultChannelCount;
        bitsPerSample_ = 32;
        isFloatFormat_ = true;
    }

    {
        std::lock_guard<std::mutex> lock(callbackMutex_);
        streamCallback_ = nullptr;
        streaming_.store(false);
    }
}

std::vector<float> WindowAudioCaptureCore::DrainAudioBuffer() {
    std::vector<float> local;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!audioBuffer_.empty()) {
            local.swap(audioBuffer_);
        }
    }
    return local;
}

bool WindowAudioCaptureCore::IsCapturing() const {
    return capturing_.load();
}

CaptureResult WindowAudioCaptureCore::StartProcessLoopback(uint32_t processId) {
    CaptureResult result;

    usingProcessLoopback_.store(false);
    sampleRate_ = kDefaultSampleRate;
    channels_ = kDefaultChannelCount;
    bitsPerSample_ = 32;
    isFloatFormat_ = true;
    maxBufferSamples_ = static_cast<size_t>(kDefaultSampleRate) * kDefaultChannelCount * 15;

    ComPtr<IAudioClient> client;
    auto activateFn = LoadActivateAudioInterfaceAsync();
    if (!activateFn) {
        result.error = "ActivateAudioInterfaceAsync not available";
        return result;
    }

    AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
    activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId = processId;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    ScopedPropVariant prop;
    prop.value.vt = VT_BLOB;
    prop.value.blob.cbSize = sizeof(activationParams);
    prop.value.blob.pBlobData = reinterpret_cast<BYTE *>(&activationParams);

    auto clearActivationBlob = [&]() {
        prop.value.blob.pBlobData = nullptr;
        prop.value.blob.cbSize = 0;
        prop.value.vt = VT_EMPTY;
    };

    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    ComPtr<ActivateAudioInterfaceHandler> handler = Microsoft::WRL::Make<ActivateAudioInterfaceHandler>();
    HRESULT hr = activateFn(kProcessLoopbackDevice, __uuidof(IAudioClient), prop.get(), handler.Get(), &operation);
    if (FAILED(hr)) {
        hr = activateFn(kProcessLoopbackLegacyId, __uuidof(IAudioClient), prop.get(), handler.Get(), &operation);
    }
    if (FAILED(hr)) {
        clearActivationBlob();
        result.error = "Process loopback activation failed";
        return result;
    }

    hr = handler->GetActivateResult(client.GetAddressOf(), 10000);
    clearActivationBlob();
    if (FAILED(hr)) {
        result.error = "Process loopback activation failed";
        return result;
    }

    usingProcessLoopback_.store(true);

    WAVEFORMATEX *mixFormatRaw = nullptr;
    hr = client->GetMixFormat(&mixFormatRaw);
    std::unique_ptr<WAVEFORMATEX, decltype(&CoTaskMemFree)> mixFormat(nullptr, CoTaskMemFree);
    WAVEFORMATEXTENSIBLE fallbackFormat = {};
    WAVEFORMATEX *format = nullptr;

    if (FAILED(hr) || !mixFormatRaw) {
        fallbackFormat.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
        fallbackFormat.Format.nChannels = kDefaultChannelCount;
        fallbackFormat.Format.nSamplesPerSec = kDefaultSampleRate;
        fallbackFormat.Format.wBitsPerSample = 32;
        fallbackFormat.Format.nBlockAlign = (fallbackFormat.Format.nChannels * fallbackFormat.Format.wBitsPerSample) / 8;
        fallbackFormat.Format.nAvgBytesPerSec = fallbackFormat.Format.nSamplesPerSec * fallbackFormat.Format.nBlockAlign;
        fallbackFormat.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
        fallbackFormat.Samples.wValidBitsPerSample = fallbackFormat.Format.wBitsPerSample;
        fallbackFormat.dwChannelMask = KSAUDIO_SPEAKER_STEREO;
        fallbackFormat.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
        format = reinterpret_cast<WAVEFORMATEX *>(&fallbackFormat);
        sampleRate_ = fallbackFormat.Format.nSamplesPerSec;
        channels_ = fallbackFormat.Format.nChannels;
        bitsPerSample_ = fallbackFormat.Format.wBitsPerSample;
        isFloatFormat_ = true;
        hr = S_OK;
    } else {
        mixFormat.reset(mixFormatRaw);
        format = mixFormat.get();
        sampleRate_ = format->nSamplesPerSec;
        channels_ = format->nChannels;
        bitsPerSample_ = format->wBitsPerSample;
        isFloatFormat_ = (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);

        if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            auto *ext = reinterpret_cast<WAVEFORMATEXTENSIBLE *>(format);
            bitsPerSample_ = ext->Format.wBitsPerSample;
            sampleRate_ = ext->Format.nSamplesPerSec;
            channels_ = ext->Format.nChannels;
            if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) {
                isFloatFormat_ = true;
            } else if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) {
                isFloatFormat_ = false;
            }
        }
    }

    if (!format) {
        result.error = "GetMixFormat failed";
        return result;
    }

    maxBufferSamples_ = std::max<size_t>(maxBufferSamples_, static_cast<size_t>(sampleRate_) * channels_ * 4);

    hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_LOOPBACK,
        kDefaultBufferDuration,
        0,
        format,
        nullptr);
    if (FAILED(hr)) {
        result.error = "IAudioClient::Initialize failed";
        return result;
    }

    sampleReadyEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    stopEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!sampleReadyEvent_ || !stopEvent_) {
        result.error = "Failed to create wait events";
        return result;
    }

    hr = client->SetEventHandle(static_cast<HANDLE>(sampleReadyEvent_));
    if (FAILED(hr)) {
        result.error = "SetEventHandle failed";
        return result;
    }

    hr = client->GetService(IID_PPV_ARGS(reinterpret_cast<IAudioCaptureClient **>(&captureClient_)));
    if (FAILED(hr)) {
        result.error = "GetService(IAudioCaptureClient) failed";
        return result;
    }

    UINT32 bufferFrames = 0;
    if (SUCCEEDED(client->GetBufferSize(&bufferFrames)) && bufferFrames > 0) {
        maxBufferSamples_ = std::max<size_t>(maxBufferSamples_, static_cast<size_t>(bufferFrames) * channels_ * 4);
    }

    hr = client->Start();
    if (FAILED(hr)) {
        result.error = "IAudioClient::Start failed";
        return result;
    }

    audioClient_ = client.Detach();
    capturing_.store(true);
    captureThread_ = std::thread([this]() { CaptureLoop(); });

    result.success = true;
    result.sampleRate = sampleRate_;
    result.channels = channels_;
    result.usingProcessLoopback = usingProcessLoopback_.load();
    return result;
}

void WindowAudioCaptureCore::CaptureLoop() {
    HANDLE waitHandles[2] = {static_cast<HANDLE>(sampleReadyEvent_), static_cast<HANDLE>(stopEvent_)};

    while (true) {
        DWORD wait = WaitForMultipleObjects(2, waitHandles, FALSE, INFINITE);
        if (wait == WAIT_OBJECT_0 + 1) {
            break;
        }
        if (wait != WAIT_OBJECT_0) {
            break;
        }

        while (capturing_.load()) {
            UINT32 nextPacket = 0;
            auto *captureClient = static_cast<IAudioCaptureClient *>(captureClient_);
            HRESULT hr = captureClient->GetNextPacketSize(&nextPacket);
            if (FAILED(hr) || nextPacket == 0) {
                break;
            }

            BYTE *data = nullptr;
            UINT32 frameCount = 0;
            DWORD flags = 0;
            hr = captureClient->GetBuffer(&data, &frameCount, &flags, nullptr, nullptr);
            if (FAILED(hr)) {
                break;
            }

            size_t sampleCount = static_cast<size_t>(frameCount) * channels_;
            std::vector<float> converted(sampleCount, 0.0f);

            if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data && sampleCount > 0) {
                if (isFloatFormat_) {
                    const float *src = reinterpret_cast<const float *>(data);
                    std::copy(src, src + sampleCount, converted.begin());
                } else if (bitsPerSample_ == 16) {
                    const int16_t *src = reinterpret_cast<const int16_t *>(data);
                    for (size_t i = 0; i < sampleCount; ++i) {
                        converted[i] = static_cast<float>(src[i]) / 32768.0f;
                    }
                } else if (bitsPerSample_ == 24) {
                    const uint8_t *src = reinterpret_cast<const uint8_t *>(data);
                    for (size_t i = 0; i < sampleCount; ++i) {
                        int32_t value = src[0] | (src[1] << 8) | (src[2] << 16);
                        if (value & 0x800000) {
                            value |= ~0xFFFFFF;
                        }
                        converted[i] = static_cast<float>(value) / 8388608.0f;
                        src += 3;
                    }
                } else if (bitsPerSample_ == 32) {
                    const int32_t *src = reinterpret_cast<const int32_t *>(data);
                    for (size_t i = 0; i < sampleCount; ++i) {
                        converted[i] = static_cast<float>(src[i]) / 2147483648.0f;
                    }
                }
            }

            AppendSamples(converted.data(), converted.size());
            captureClient->ReleaseBuffer(frameCount);
        }
    }

    capturing_.store(false);
}

void WindowAudioCaptureCore::AppendSamples(const float *samples, size_t count) {
    if (!samples || count == 0) {
        return;
    }

    std::vector<float> streamCopy;
    if (streaming_.load()) {
        streamCopy.assign(samples, samples + count);
    }

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (audioBuffer_.size() + count > maxBufferSamples_) {
            size_t excess = audioBuffer_.size() + count - maxBufferSamples_;
            if (excess >= audioBuffer_.size()) {
                audioBuffer_.clear();
            } else {
                audioBuffer_.erase(audioBuffer_.begin(), audioBuffer_.begin() + excess);
            }
        }
        audioBuffer_.insert(audioBuffer_.end(), samples, samples + count);
    }

    if (!streamCopy.empty()) {
        StreamCallback callback;
        {
            std::lock_guard<std::mutex> lock(callbackMutex_);
            callback = streamCallback_;
        }
        if (callback) {
            StreamChunk chunk;
            chunk.samples = std::move(streamCopy);
            chunk.sampleRate = sampleRate_;
            chunk.channels = channels_;
            callback(std::move(chunk));
        }
    }
}

}  // namespace versus::audio

#else

namespace versus::audio {

WindowAudioCaptureCore::WindowAudioCaptureCore() = default;
WindowAudioCaptureCore::~WindowAudioCaptureCore() = default;

std::vector<WindowInfo> WindowAudioCaptureCore::GetWindowList() {
    return {};
}

std::vector<AudioSessionInfo> WindowAudioCaptureCore::GetAudioSessions() {
    return {};
}

CaptureResult WindowAudioCaptureCore::StartCapture(uint32_t) {
    return {false, false, 0, 0, "Audio capture is only supported on Windows"};
}

CaptureResult WindowAudioCaptureCore::StartStreamCapture(uint32_t, StreamCallback) {
    return {false, false, 0, 0, "Audio capture is only supported on Windows"};
}

void WindowAudioCaptureCore::StopCapture() {}

std::vector<float> WindowAudioCaptureCore::DrainAudioBuffer() {
    return {};
}

bool WindowAudioCaptureCore::IsCapturing() const {
    return false;
}

}  // namespace versus::audio

#endif
