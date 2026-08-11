#include <rtc/rtc.hpp>

#include "fake_websocket_control.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace rtc {
namespace signaling_lifecycle_detail {

template <typename... Args>
class CallbackSlot {
  public:
    void set(std::function<void(Args...)> callback) {
        std::lock_guard<std::recursive_mutex> lock(mutex_);
        callback_ = std::move(callback);
    }

    void invoke(Args... args) {
        std::lock_guard<std::recursive_mutex> lock(mutex_);
        if (callback_) {
            callback_(std::move(args)...);
        }
    }

    template <typename BeforeDispatch>
    void invokeAfter(BeforeDispatch &&beforeDispatch, Args... args) {
        std::lock_guard<std::recursive_mutex> lock(mutex_);
        if (callback_) {
            beforeDispatch();
            callback_(std::move(args)...);
        }
    }

    void reset() {
        std::lock_guard<std::recursive_mutex> lock(mutex_);
        callback_ = {};
    }

  private:
    std::recursive_mutex mutex_;
    std::function<void(Args...)> callback_;
};

struct WebSocketState {
    enum class SendOutcome {
        Success,
        ReturnFalse,
        Throw
    };

    std::atomic<bool> open{false};
    CallbackSlot<> onOpen;
    CallbackSlot<> onClosed;
    CallbackSlot<std::string> onError;
    CallbackSlot<message_variant> onMessage;
    std::mutex sentMutex;
    std::vector<std::string> sentMessages;
    SendOutcome nextSendOutcome = SendOutcome::Success;

    void resetCallbacks() {
        onOpen.reset();
        onClosed.reset();
        onError.reset();
        onMessage.reset();
    }
};

struct Harness {
    std::mutex mutex;
    std::vector<std::shared_ptr<WebSocketState>> sockets;
    std::vector<std::thread> callbackThreads;
    std::mutex textHoldMutex;
    std::condition_variable textHoldCv;
    bool holdNextText = false;
    bool textHeld = false;
    bool releaseText = false;
};

Harness &harness() {
    // Child processes intentionally exercise non-returning paths. Leaking this
    // process-local holder avoids std::thread destruction obscuring the
    // supervisor's timeout classification in those expendable children.
    static Harness *instance = new Harness();
    return *instance;
}

std::shared_ptr<WebSocketState> socketAt(std::size_t index) {
    auto &instance = harness();
    std::lock_guard<std::mutex> lock(instance.mutex);
    if (index >= instance.sockets.size()) {
        return {};
    }
    return instance.sockets[index];
}

std::shared_ptr<WebSocketState> latestSocket() {
    auto &instance = harness();
    std::lock_guard<std::mutex> lock(instance.mutex);
    if (instance.sockets.empty()) {
        return {};
    }
    return instance.sockets.back();
}

template <typename Callback>
void launchCallback(Callback &&callback) {
    auto &instance = harness();
    std::lock_guard<std::mutex> lock(instance.mutex);
    instance.callbackThreads.emplace_back(std::forward<Callback>(callback));
}

}  // namespace signaling_lifecycle_detail

WebSocket::WebSocket(const Configuration & /*configuration*/)
    : state_(std::make_shared<signaling_lifecycle_detail::WebSocketState>()) {
    auto &instance = signaling_lifecycle_detail::harness();
    std::lock_guard<std::mutex> lock(instance.mutex);
    instance.sockets.push_back(state_);
}

WebSocket::~WebSocket() {
    if (!state_) {
        return;
    }
    state_->open.store(false, std::memory_order_release);
    // Match libdatachannel's synchronized callback contract: reset blocks
    // another thread while a callback is running, but is recursive when the
    // callback itself destroys the public WebSocket wrapper.
    state_->resetCallbacks();
}

void WebSocket::onOpen(std::function<void()> callback) {
    state_->onOpen.set(std::move(callback));
}

void WebSocket::onClosed(std::function<void()> callback) {
    state_->onClosed.set(std::move(callback));
}

void WebSocket::onError(std::function<void(std::string)> callback) {
    state_->onError.set(std::move(callback));
}

void WebSocket::setMessageCallback(std::function<void(Message)> callback) {
    state_->onMessage.set(std::move(callback));
}

void WebSocket::open(const std::string & /*url*/) {
    state_->open.store(true, std::memory_order_release);
    const auto state = state_;
    signaling_lifecycle_detail::launchCallback([state]() {
        state->onOpen.invoke();
    });
}

void WebSocket::close() {
    if (!state_->open.exchange(false, std::memory_order_acq_rel)) {
        return;
    }
    // A synchronous close notification is permitted by the real transport and
    // proves that retirement occurs before callbacks are delivered.
    state_->onClosed.invoke();
}

bool WebSocket::isOpen() const {
    return state_->open.load(std::memory_order_acquire);
}

bool WebSocket::send(std::string message) {
    if (!isOpen()) {
        return false;
    }
    std::lock_guard<std::mutex> lock(state_->sentMutex);
    const auto outcome = std::exchange(
        state_->nextSendOutcome,
        signaling_lifecycle_detail::WebSocketState::SendOutcome::Success);
    if (outcome == signaling_lifecycle_detail::WebSocketState::SendOutcome::ReturnFalse) {
        return false;
    }
    if (outcome == signaling_lifecycle_detail::WebSocketState::SendOutcome::Throw) {
        throw std::runtime_error("deterministic websocket send failure");
    }
    state_->sentMessages.push_back(std::move(message));
    return true;
}

std::size_t WebSocket::bufferedAmount() const {
    return 0;
}

namespace signaling_lifecycle_test {

void joinCallbacks() {
    auto &instance = signaling_lifecycle_detail::harness();
    for (;;) {
        std::vector<std::thread> callbacks;
        {
            std::lock_guard<std::mutex> lock(instance.mutex);
            callbacks.swap(instance.callbackThreads);
        }
        if (callbacks.empty()) {
            return;
        }
        for (auto &callback : callbacks) {
            if (callback.joinable()) {
                callback.join();
            }
        }
    }
}

void reset() {
    joinCallbacks();
    auto &instance = signaling_lifecycle_detail::harness();
    {
        std::lock_guard<std::mutex> lock(instance.mutex);
        instance.sockets.clear();
    }
    {
        std::lock_guard<std::mutex> lock(instance.textHoldMutex);
        instance.holdNextText = false;
        instance.textHeld = false;
        instance.releaseText = false;
    }
}

void holdNextTextBeforeDispatch() {
    auto &instance = signaling_lifecycle_detail::harness();
    std::lock_guard<std::mutex> lock(instance.textHoldMutex);
    instance.holdNextText = true;
    instance.textHeld = false;
    instance.releaseText = false;
}

bool waitForHeldText(std::size_t timeoutMs) {
    auto &instance = signaling_lifecycle_detail::harness();
    std::unique_lock<std::mutex> lock(instance.textHoldMutex);
    return instance.textHoldCv.wait_for(
        lock,
        std::chrono::milliseconds(timeoutMs),
        [&]() { return instance.textHeld; });
}

void releaseHeldText() {
    auto &instance = signaling_lifecycle_detail::harness();
    {
        std::lock_guard<std::mutex> lock(instance.textHoldMutex);
        instance.releaseText = true;
    }
    instance.textHoldCv.notify_all();
}

void failNextSend() {
    const auto state = signaling_lifecycle_detail::latestSocket();
    if (!state) {
        return;
    }
    std::lock_guard<std::mutex> lock(state->sentMutex);
    state->nextSendOutcome =
        signaling_lifecycle_detail::WebSocketState::SendOutcome::ReturnFalse;
}

void throwNextSend() {
    const auto state = signaling_lifecycle_detail::latestSocket();
    if (!state) {
        return;
    }
    std::lock_guard<std::mutex> lock(state->sentMutex);
    state->nextSendOutcome =
        signaling_lifecycle_detail::WebSocketState::SendOutcome::Throw;
}

std::size_t socketCount() {
    auto &instance = signaling_lifecycle_detail::harness();
    std::lock_guard<std::mutex> lock(instance.mutex);
    return instance.sockets.size();
}

std::size_t sentMessageCount() {
    const auto state = signaling_lifecycle_detail::latestSocket();
    if (!state) {
        return 0;
    }
    std::lock_guard<std::mutex> lock(state->sentMutex);
    return state->sentMessages.size();
}

bool socketIsOpen(std::size_t index) {
    const auto state = signaling_lifecycle_detail::socketAt(index);
    return state && state->open.load(std::memory_order_acquire);
}

bool latestSocketIsOpen() {
    const auto state = signaling_lifecycle_detail::latestSocket();
    return state && state->open.load(std::memory_order_acquire);
}

bool emitText(std::size_t index, const std::string &message) {
    const auto state = signaling_lifecycle_detail::socketAt(index);
    if (!state) {
        return false;
    }
    signaling_lifecycle_detail::launchCallback([state, message]() {
        auto &instance = signaling_lifecycle_detail::harness();
        state->onMessage.invokeAfter([&]() {
            std::unique_lock<std::mutex> lock(instance.textHoldMutex);
            if (!instance.holdNextText) {
                return;
            }
            instance.holdNextText = false;
            instance.textHeld = true;
            instance.textHoldCv.notify_all();
            instance.textHoldCv.wait(lock, [&]() { return instance.releaseText; });
        }, message_variant{message});
    });
    return true;
}

bool emitTextOnLatest(const std::string &message) {
    const std::size_t count = socketCount();
    return count != 0 && emitText(count - 1, message);
}

bool emitClosed(std::size_t index) {
    const auto state = signaling_lifecycle_detail::socketAt(index);
    if (!state) {
        return false;
    }
    state->open.store(false, std::memory_order_release);
    signaling_lifecycle_detail::launchCallback([state]() {
        state->onClosed.invoke();
    });
    return true;
}

}  // namespace signaling_lifecycle_test
}  // namespace rtc
