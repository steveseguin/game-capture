#include <QtTest/QtTest>

#include <rtc/rtc.hpp>
#include <rtc/websocketserver.hpp>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "versus/signaling/vdo_signaling.h"

namespace {

bool waitUntil(const std::function<bool()> &condition, int timeoutMs, int pollMs = 10) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (condition()) {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(pollMs));
    }
    return condition();
}

struct LocalWebSocketServer {
    LocalWebSocketServer() : server(makeConfig()) {
        server.onClient([this](std::shared_ptr<rtc::WebSocket> client) {
            const int connectionNumber = acceptedConnections.fetch_add(1) + 1;
            {
                std::lock_guard<std::mutex> lock(clientsMutex);
                clients.push_back(client);
            }

            client->onOpen([this]() {
                openConnections.fetch_add(1);
            });

            client->onClosed([this]() {
                closedConnections.fetch_add(1);
            });

            client->onMessage([this, client, connectionNumber](auto message) {
                if (!std::holds_alternative<std::string>(message)) {
                    return;
                }
                const std::string payload = std::get<std::string>(message);
                if (payload.find("\"ping\"") == std::string::npos) {
                    return;
                }

                keepalivePings.fetch_add(1);
                if (closeFirstConnectionAfterPing.load() &&
                    connectionNumber == 1 &&
                    !firstConnectionCloseScheduled.exchange(true)) {
                    std::thread([client]() {
                        std::this_thread::sleep_for(std::chrono::milliseconds(25));
                        if (client->isOpen()) {
                            client->close();
                        }
                    }).detach();
                }
            });
        });
    }

    ~LocalWebSocketServer() {
        std::vector<std::shared_ptr<rtc::WebSocket>> snapshot;
        {
            std::lock_guard<std::mutex> lock(clientsMutex);
            snapshot = clients;
        }
        for (const auto &client : snapshot) {
            if (client && client->isOpen()) {
                client->close();
            }
        }
        server.stop();
    }

    std::string url() const {
        return "ws://127.0.0.1:" + std::to_string(server.port());
    }

    static rtc::WebSocketServer::Configuration makeConfig() {
        rtc::WebSocketServer::Configuration config;
        config.port = 0;
        config.bindAddress = std::string("127.0.0.1");
        return config;
    }

    rtc::WebSocketServer server;
    std::mutex clientsMutex;
    std::vector<std::shared_ptr<rtc::WebSocket>> clients;
    std::atomic<int> acceptedConnections{0};
    std::atomic<int> openConnections{0};
    std::atomic<int> closedConnections{0};
    std::atomic<int> keepalivePings{0};
    std::atomic<bool> closeFirstConnectionAfterPing{false};
    std::atomic<bool> firstConnectionCloseScheduled{false};
};

bool hasEnvVar(const char *name) {
    return std::getenv(name) != nullptr;
}

QByteArray getEnvVar(const char *name) {
    const char *value = std::getenv(name);
    return value ? QByteArray(value) : QByteArray();
}

void setEnvVar(const char *name, const QByteArray &value) {
#ifdef _WIN32
    _putenv_s(name, value.constData());
#else
    qputenv(name, value);
#endif
}

void unsetEnvVar(const char *name) {
#ifdef _WIN32
    _putenv_s(name, "");
#else
    qunsetenv(name);
#endif
}

}  // namespace

class TestVdoSignaling : public QObject {
    Q_OBJECT

  private slots:
    void initTestCase();
    void cleanupTestCase();
    void testReconnectAfterRemoteCloseWithoutExplicitDisconnect();
    void testDisconnectStopsKeepaliveTraffic();

  private:
    bool hadOriginalPingInterval_ = false;
    QByteArray originalPingInterval_;
    bool hadOriginalClientPing_ = false;
    QByteArray originalClientPing_;
};

void TestVdoSignaling::initTestCase() {
    rtc::InitLogger(rtc::LogLevel::Warning);

    hadOriginalPingInterval_ = hasEnvVar("VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS");
    if (hadOriginalPingInterval_) {
        originalPingInterval_ = getEnvVar("VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS");
    }

    hadOriginalClientPing_ = hasEnvVar("VERSUS_SIGNALING_CLIENT_PING");
    if (hadOriginalClientPing_) {
        originalClientPing_ = getEnvVar("VERSUS_SIGNALING_CLIENT_PING");
    }

    setEnvVar("VERSUS_SIGNALING_CLIENT_PING", "1");
    setEnvVar("VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS", "120");
    QVERIFY2(hasEnvVar("VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS"),
             "Failed to set keepalive interval override for test process");
}

void TestVdoSignaling::cleanupTestCase() {
    if (hadOriginalClientPing_) {
        setEnvVar("VERSUS_SIGNALING_CLIENT_PING", originalClientPing_);
    } else {
        unsetEnvVar("VERSUS_SIGNALING_CLIENT_PING");
    }

    if (hadOriginalPingInterval_) {
        setEnvVar("VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS", originalPingInterval_);
    } else {
        unsetEnvVar("VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS");
    }
}

void TestVdoSignaling::testReconnectAfterRemoteCloseWithoutExplicitDisconnect() {
    LocalWebSocketServer localServer;
    localServer.closeFirstConnectionAfterPing.store(true);

    versus::signaling::VdoSignaling signaling;
    std::atomic<int> disconnectEvents{0};
    signaling.onDisconnected([&disconnectEvents]() {
        disconnectEvents.fetch_add(1);
    });

    QVERIFY2(signaling.connect(localServer.url()), "Initial signaling connect failed");
    QVERIFY2(waitUntil([&localServer]() { return localServer.keepalivePings.load() >= 1; }, 4000),
             "Did not observe a keepalive ping from first connection");
    QVERIFY2(waitUntil([&disconnectEvents]() { return disconnectEvents.load() >= 1; }, 4000),
             "Server-induced close did not trigger onDisconnected");
    QVERIFY2(waitUntil([&signaling]() { return !signaling.isConnected(); }, 1000),
             "Signaling connection stayed marked as connected after remote close");

    const int pingCountAfterClose = localServer.keepalivePings.load();
    QVERIFY2(signaling.connect(localServer.url()),
             "Reconnect after remote close failed without explicit disconnect");
    QVERIFY2(waitUntil([&localServer]() { return localServer.openConnections.load() >= 2; }, 2000),
             "Second signaling session never reached WebSocket open state");
    QVERIFY2(waitUntil([&localServer, pingCountAfterClose]() {
                 return localServer.keepalivePings.load() > pingCountAfterClose;
             }, 4000),
             "Reconnect path did not produce keepalive ping traffic");

    signaling.disconnect();
}

void TestVdoSignaling::testDisconnectStopsKeepaliveTraffic() {
    LocalWebSocketServer localServer;

    versus::signaling::VdoSignaling signaling;
    QVERIFY2(signaling.connect(localServer.url()), "Signaling connect failed");
    QVERIFY2(waitUntil([&localServer]() { return localServer.keepalivePings.load() >= 2; }, 4000),
             "Expected keepalive ping traffic before disconnect");

    signaling.disconnect();
    QVERIFY2(waitUntil([&signaling]() { return !signaling.isConnected(); }, 1000),
             "Signaling remained connected after disconnect");

    const int pingCountAfterDisconnect = localServer.keepalivePings.load();
    std::this_thread::sleep_for(std::chrono::milliseconds(450));
    QCOMPARE(localServer.keepalivePings.load(), pingCountAfterDisconnect);
}

QTEST_MAIN(TestVdoSignaling)
#include "test_vdo_signaling.moc"
