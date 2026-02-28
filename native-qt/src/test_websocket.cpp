// WebSocket test for VDO.Ninja with proper coordination
#include <rtc/rtc.hpp>
#include <iostream>
#include <thread>
#include <chrono>
#include <atomic>

std::atomic<bool> messageReceived{false};
std::atomic<bool> connected{false};
std::atomic<bool> gotOfferSDP{false};

int main() {
    std::cout << "WebSocket Test for VDO.Ninja\n";
    std::cout << "============================\n\n";

    // Enable libdatachannel debug logging
    rtc::InitLogger(rtc::LogLevel::Debug);

    rtc::WebSocket::Configuration config;
    config.disableTlsVerification = true;
    config.connectionTimeout = std::chrono::seconds(30);

    auto ws = std::make_shared<rtc::WebSocket>(config);

    ws->onOpen([&]() {
        std::cout << "\n[OPEN] WebSocket connected!\n";
        connected = true;
    });

    ws->onClosed([&]() {
        std::cout << "\n[CLOSED] WebSocket closed\n";
    });

    ws->onError([&](std::string error) {
        std::cout << "\n[ERROR] " << error << "\n";
    });

    ws->onMessage([&](auto message) {
        messageReceived = true;
        if (std::holds_alternative<std::string>(message)) {
            std::string str = std::get<std::string>(message);
            std::cout << "\n[MESSAGE] Received: " << str.substr(0, 300) << "\n";
            if (str.find("offerSDP") != std::string::npos) {
                gotOfferSDP = true;
                std::cout << "\n*** SUCCESS: Received offerSDP! ***\n";
            }
        } else {
            std::cout << "\n[MESSAGE] Binary message, size=" << std::get<rtc::binary>(message).size() << "\n";
        }
    });

    std::cout << "Connecting to wss://wss.vdo.ninja:443...\n";
    ws->open("wss://wss.vdo.ninja:443");

    // Wait for connection
    auto start = std::chrono::steady_clock::now();
    while (!connected) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (std::chrono::steady_clock::now() - start > std::chrono::seconds(10)) {
            std::cout << "Connection timeout!\n";
            return 1;
        }
    }

    // Send seed request
    std::string seedMsg = R"({"request":"seed","streamID":"libdc_final_test"})";
    std::cout << "\nSending: " << seedMsg << "\n";
    ws->send(seedMsg);

    std::cout << "\n========================================================\n";
    std::cout << "OPEN THIS URL IN BROWSER NOW:\n";
    std::cout << "https://vdo.ninja/?view=libdc_final_test&password=false\n";
    std::cout << "========================================================\n\n";
    std::cout << "Waiting for offerSDP (60 seconds max)...\n";

    start = std::chrono::steady_clock::now();
    while (!gotOfferSDP && ws->isOpen()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - start).count();

        if (elapsed % 5 == 0) {
            static int lastPrint = -1;
            if (lastPrint != elapsed) {
                std::cout << "  Waiting... " << elapsed << "s (isOpen=" << ws->isOpen() << ")\n";
                lastPrint = elapsed;
            }
        }

        if (elapsed > 60) {
            std::cout << "\nTimeout after 60 seconds.\n";
            break;
        }
    }

    if (gotOfferSDP) {
        std::cout << "\n=== TEST PASSED: Received offerSDP from VDO.Ninja! ===\n";
    } else if (messageReceived) {
        std::cout << "\n=== Received some messages but not offerSDP ===\n";
    } else {
        std::cout << "\n=== TEST FAILED: No messages received ===\n";
    }

    ws->close();
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    return gotOfferSDP ? 0 : 1;
}
