#pragma once

#include <chrono>
#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace rtc {

using binary = std::vector<std::byte>;
using message_variant = std::variant<binary, std::string>;

namespace signaling_lifecycle_detail {
struct WebSocketState;
}

class WebSocket {
  public:
    using Binary = binary;
    using Message = message_variant;

    struct Configuration {
        std::chrono::milliseconds connectionTimeout{0};
        std::chrono::milliseconds pingInterval{0};
        bool disableTlsVerification = false;
    };

    explicit WebSocket(const Configuration &configuration = {});
    ~WebSocket();

    WebSocket(const WebSocket &) = delete;
    WebSocket &operator=(const WebSocket &) = delete;

    void onOpen(std::function<void()> callback);
    void onClosed(std::function<void()> callback);
    void onError(std::function<void(std::string)> callback);

    template <typename Callback>
    void onMessage(Callback &&callback) {
        setMessageCallback(
            [fn = std::forward<Callback>(callback)](Message message) mutable {
                fn(std::move(message));
            });
    }

    void open(const std::string &url);
    void close();
    [[nodiscard]] bool isOpen() const;
    bool send(std::string message);
    [[nodiscard]] std::size_t bufferedAmount() const;

  private:
    void setMessageCallback(std::function<void(Message)> callback);

    std::shared_ptr<signaling_lifecycle_detail::WebSocketState> state_;
};

}  // namespace rtc
