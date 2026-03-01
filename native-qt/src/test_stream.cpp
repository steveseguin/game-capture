// Minimal streaming test - no GUI required
#include <rtc/rtc.hpp>
#include <nlohmann/json.hpp>
#include <iostream>
#include <thread>
#include <chrono>
#include <atomic>

using json = nlohmann::json;

std::atomic<bool> connected{false};
std::atomic<bool> gotOfferRequest{false};
std::atomic<bool> gotAnswer{false};
std::shared_ptr<rtc::WebSocket> ws;
std::shared_ptr<rtc::PeerConnection> pc;
std::string peerUuid;

void sendMessage(const json& msg) {
    if (ws && ws->isOpen()) {
        std::string payload = msg.dump();
        std::cout << "[SEND] " << payload.substr(0, 100) << "...\n";
        ws->send(payload);
    }
}

int main(int argc, char* argv[]) {
    std::string streamId = argc > 1 ? argv[1] : "test_game_capture_app";

    std::cout << "=== VDO.Ninja Stream Test ===\n";
    std::cout << "Stream ID: " << streamId << "\n";
    std::cout << "View URL: https://vdo.ninja/?view=" << streamId << "&password=false\n\n";

    rtc::InitLogger(rtc::LogLevel::Warning);

    // Create WebSocket
    rtc::WebSocket::Configuration wsConfig;
    wsConfig.disableTlsVerification = true;
    ws = std::make_shared<rtc::WebSocket>(wsConfig);

    ws->onOpen([&]() {
        std::cout << "[WS] Connected!\n";
        connected = true;

        // Send seed request (no encryption, no hash)
        json msg;
        msg["request"] = "seed";
        msg["streamID"] = streamId;
        sendMessage(msg);
    });

    ws->onClosed([]() {
        std::cout << "[WS] Closed\n";
        connected = false;
    });

    ws->onError([](std::string err) {
        std::cout << "[WS] Error: " << err << "\n";
    });

    ws->onMessage([&](auto message) {
        if (!std::holds_alternative<std::string>(message)) return;

        std::string payload = std::get<std::string>(message);
        std::cout << "[RECV] " << payload.substr(0, 150) << "\n";

        json msg = json::parse(payload, nullptr, false);
        if (msg.is_discarded()) return;

        std::string request = msg.value("request", "");

        if (request == "offerSDP") {
            gotOfferRequest = true;
            peerUuid = msg.value("UUID", "");
            std::cout << "\n*** Got offerSDP request from " << peerUuid << " ***\n";

            // Create PeerConnection and offer
            rtc::Configuration rtcConfig;
            rtcConfig.iceServers.emplace_back("stun:stun.l.google.com:19302");
            pc = std::make_shared<rtc::PeerConnection>(rtcConfig);

            pc->onStateChange([](rtc::PeerConnection::State state) {
                std::cout << "[PC] State: " << (int)state << "\n";
            });

            pc->onLocalCandidate([&](rtc::Candidate cand) {
                json candMsg;
                candMsg["UUID"] = peerUuid;
                candMsg["candidate"] = {
                    {"candidate", std::string(cand.candidate())},
                    {"sdpMid", std::string(cand.mid())},
                    {"sdpMLineIndex", 0}
                };
                sendMessage(candMsg);
            });

            // Add a dummy video track
            rtc::Description::Video video("video", rtc::Description::Direction::SendOnly);
            video.addH264Codec(96);
            video.addSSRC(12345, "test-video");
            auto track = pc->addTrack(video);

            std::cout << "[PC] Track added, waiting for gather...\n";

            pc->onGatheringStateChange([&](rtc::PeerConnection::GatheringState state) {
                std::cout << "[PC] Gathering state: " << (int)state << "\n";
                if (state == rtc::PeerConnection::GatheringState::Complete) {
                    auto desc = pc->localDescription();
                    if (desc) {
                        json offerMsg;
                        offerMsg["UUID"] = peerUuid;
                        offerMsg["description"] = {
                            {"type", "offer"},
                            {"sdp", std::string(*desc)}
                        };
                        std::cout << "[PC] Sending offer (gathering complete)...\n";
                        sendMessage(offerMsg);
                    }
                }
            });

            pc->setLocalDescription(rtc::Description::Type::Offer);
            std::cout << "[PC] Set local description\n";

        }
        else if (msg.contains("description")) {
            auto descVal = msg["description"];
            if (descVal.is_object()) {
                std::string type = descVal.value("type", "");
                if (type == "answer") {
                    gotAnswer = true;
                    std::cout << "\n*** GOT ANSWER! WebRTC handshake complete! ***\n";
                    std::string sdp = descVal.value("sdp", "");
                    if (pc) {
                        pc->setRemoteDescription(rtc::Description(sdp, rtc::Description::Type::Answer));
                    }
                }
            }
        }
        else if (msg.contains("candidate")) {
            auto candVal = msg["candidate"];
            if (candVal.is_object() && pc) {
                std::string cand = candVal.value("candidate", "");
                std::string mid = candVal.value("sdpMid", "video");
                if (!cand.empty()) {
                    pc->addRemoteCandidate(rtc::Candidate(cand, mid));
                }
            }
        }
    });

    std::cout << "Connecting to wss://wss.vdo.ninja:443...\n";
    ws->open("wss://wss.vdo.ninja:443");

    // Wait for connection
    for (int i = 0; i < 100 && !connected; i++) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    if (!connected) {
        std::cout << "Connection timeout!\n";
        return 1;
    }

    std::cout << "\nWaiting for viewer (60 seconds)...\n";
    std::cout << "Open: https://vdo.ninja/?view=" << streamId << "&password=false\n\n";

    // Wait for answer
    auto start = std::chrono::steady_clock::now();
    while (!gotAnswer && ws->isOpen()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - start).count();
        if (elapsed > 60) break;
        if (elapsed % 10 == 0) {
            static int lastPrint = -1;
            if (lastPrint != elapsed) {
                std::cout << "  " << elapsed << "s... (offerRequest=" << gotOfferRequest
                          << ", answer=" << gotAnswer << ")\n";
                lastPrint = elapsed;
            }
        }
    }

    if (gotAnswer) {
        std::cout << "\n=== SUCCESS: WebRTC connection established! ===\n";
        std::cout << "Keeping connection open for 10 seconds...\n";
        std::this_thread::sleep_for(std::chrono::seconds(10));
    } else {
        std::cout << "\n=== FAILED: No answer received ===\n";
    }

    if (pc) pc->close();
    ws->close();
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    return gotAnswer ? 0 : 1;
}

