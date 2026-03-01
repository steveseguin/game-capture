#include "versus/signaling/vdo_signaling.h"

#include <nlohmann/json.hpp>
#include <rtc/rtc.hpp>
#include <spdlog/spdlog.h>

#include <mbedtls/aes.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/entropy.h>
#include <mbedtls/md.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <mutex>
#include <queue>
#include <random>
#include <sstream>
#include <thread>


namespace versus::signaling {
namespace {

using json = nlohmann::json;

std::string toHex(const std::vector<uint8_t> &bytes) {
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (uint8_t byte : bytes) {
        oss << std::setw(2) << static_cast<int>(byte);
    }
    return oss.str();
}

std::vector<uint8_t> fromHex(const std::string &hex) {
    std::vector<uint8_t> out;
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        std::string byteString = hex.substr(i, 2);
        uint8_t byte = static_cast<uint8_t>(std::strtoul(byteString.c_str(), nullptr, 16));
        out.push_back(byte);
    }
    return out;
}

std::string sanitizeId(const std::string &value, size_t maxLen) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
        return "";
    }
    const auto last = value.find_last_not_of(" \t\r\n");
    std::string trimmed = value.substr(first, last - first + 1);

    std::string out;
    out.reserve(trimmed.size());
    for (char c : trimmed) {
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '_') {
            out.push_back(c);
        } else {
            out.push_back('_');
        }
    }

    if (out.size() > maxLen) {
        out.resize(maxLen);
    }
    return out;
}

std::string generateUuid() {
    std::random_device rd;
    std::mt19937 gen(rd());
    std::uniform_int_distribution<> dis(0, 15);
    std::uniform_int_distribution<> dis2(8, 11);

    std::stringstream ss;
    ss << std::hex;

    for (int i = 0; i < 8; i++) ss << dis(gen);
    ss << "-";
    for (int i = 0; i < 4; i++) ss << dis(gen);
    ss << "-4";
    for (int i = 0; i < 3; i++) ss << dis(gen);
    ss << "-";
    ss << dis2(gen);
    for (int i = 0; i < 3; i++) ss << dis(gen);
    ss << "-";
    for (int i = 0; i < 12; i++) ss << dis(gen);

    return ss.str();
}

std::string generateStreamId() {
    auto now = std::chrono::system_clock::now().time_since_epoch().count();
    std::stringstream ss;
    ss << "gamecapture_" << std::hex << now;
    return ss.str();
}

std::chrono::milliseconds clientPingInterval() {
    constexpr int kDefaultIntervalMs = 5000;
    constexpr long kMinIntervalMs = 50;
    constexpr long kMaxIntervalMs = 60000;

    if (const char *env = std::getenv("VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS")) {
        char *end = nullptr;
        const long parsed = std::strtol(env, &end, 10);
        if (end != env && *end == '\0' && parsed > 0) {
            const long clamped = std::clamp(parsed, kMinIntervalMs, kMaxIntervalMs);
            if (clamped != parsed) {
                spdlog::warn("[Signaling] Clamped VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS={} to {}ms",
                             parsed, clamped);
            }
            return std::chrono::milliseconds(clamped);
        }
        spdlog::warn("[Signaling] Ignoring invalid VERSUS_SIGNALING_CLIENT_PING_INTERVAL_MS='{}'", env);
    }

    return std::chrono::milliseconds(kDefaultIntervalMs);
}

std::vector<uint8_t> sha256Bytes(const std::string &input) {
    std::vector<uint8_t> digest(32, 0);
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (!info) {
        return digest;
    }

    if (mbedtls_md_setup(&ctx, info, 0) != 0) {
        mbedtls_md_free(&ctx);
        return digest;
    }

    mbedtls_md_starts(&ctx);
    mbedtls_md_update(&ctx, reinterpret_cast<const unsigned char *>(input.data()), input.size());
    mbedtls_md_finish(&ctx, digest.data());
    mbedtls_md_free(&ctx);
    return digest;
}

std::string hashHex(const std::string &input, size_t hexLength) {
    auto digest = sha256Bytes(input);
    size_t bytes = std::min(digest.size(), hexLength / 2);
    digest.resize(bytes);
    return toHex(digest);
}

bool aesEncryptCbc(const std::string &plain, const std::string &phrase, std::string &outHex, std::string &outVector) {
    std::vector<uint8_t> iv(16);
    mbedtls_ctr_drbg_context rng;
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_init(&rng);
    mbedtls_entropy_init(&entropy);

    const char *pers = "gamecapture-vdo";
    if (mbedtls_ctr_drbg_seed(&rng, mbedtls_entropy_func, &entropy,
                              reinterpret_cast<const unsigned char *>(pers), std::strlen(pers)) != 0) {
        mbedtls_ctr_drbg_free(&rng);
        mbedtls_entropy_free(&entropy);
        return false;
    }

    if (mbedtls_ctr_drbg_random(&rng, iv.data(), iv.size()) != 0) {
        mbedtls_ctr_drbg_free(&rng);
        mbedtls_entropy_free(&entropy);
        return false;
    }

    auto keyBytes = sha256Bytes(phrase);
    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    if (mbedtls_aes_setkey_enc(&aes, keyBytes.data(), 256) != 0) {
        mbedtls_aes_free(&aes);
        mbedtls_ctr_drbg_free(&rng);
        mbedtls_entropy_free(&entropy);
        return false;
    }

    std::vector<uint8_t> input(plain.begin(), plain.end());
    size_t padding = 16 - (input.size() % 16);
    input.insert(input.end(), padding, static_cast<uint8_t>(padding));
    std::vector<uint8_t> output(input.size(), 0);

    // mbedtls updates IV in-place during CBC; preserve the original IV for signaling.
    auto workingIv = iv;
    if (mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, input.size(), workingIv.data(), input.data(), output.data()) != 0) {
        mbedtls_aes_free(&aes);
        mbedtls_ctr_drbg_free(&rng);
        mbedtls_entropy_free(&entropy);
        return false;
    }

    outHex = toHex(output);
    outVector = toHex(iv);

    mbedtls_aes_free(&aes);
    mbedtls_ctr_drbg_free(&rng);
    mbedtls_entropy_free(&entropy);
    return true;
}

bool aesDecryptCbc(const std::string &cipherHex, const std::string &vectorHex, const std::string &phrase, std::string &outPlain) {
    auto cipherBytes = fromHex(cipherHex);
    auto iv = fromHex(vectorHex);
    if (iv.size() != 16) {
        return false;
    }

    auto keyBytes = sha256Bytes(phrase);
    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    if (mbedtls_aes_setkey_dec(&aes, keyBytes.data(), 256) != 0) {
        mbedtls_aes_free(&aes);
        return false;
    }

    std::vector<uint8_t> output(cipherBytes.size(), 0);
    if (mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_DECRYPT, cipherBytes.size(), iv.data(), cipherBytes.data(), output.data()) != 0) {
        mbedtls_aes_free(&aes);
        return false;
    }

    if (output.empty()) {
        mbedtls_aes_free(&aes);
        return false;
    }

    uint8_t padding = output.back();
    if (padding == 0 || padding > 16 || padding > output.size()) {
        mbedtls_aes_free(&aes);
        return false;
    }
    output.resize(output.size() - padding);

    outPlain.assign(output.begin(), output.end());
    mbedtls_aes_free(&aes);
    return true;
}

std::string effectivePassword(const std::string &password, bool encryptionDisabled) {
    if (encryptionDisabled) {
        return "";
    }
    if (password.empty()) {
        return "someEncryptionKey123";
    }
    return password;
}

}  // namespace

struct VdoSignaling::Impl {
    std::shared_ptr<rtc::WebSocket> socket;
    std::mutex mutex;
    std::string uuid;
    std::string roomId;
    std::string streamId;
    std::string label;
    std::string password;
    std::string salt = "vdo.ninja";
    std::string candidateType = "local";
    bool encryptionDisabled = false;
    std::atomic<bool> connected{false};
    std::atomic<bool> connectionFailed{false};
    std::atomic<bool> published{false};
    std::thread keepaliveThread;
    std::atomic<bool> keepaliveRunning{false};
    ConnectedCallback onConnected;
    DisconnectedCallback onDisconnected;
    ErrorCallback onError;
    AlertCallback onAlert;
    OfferCallback onOffer;
    AnswerCallback onAnswer;
    CandidateCallback onCandidate;
    OfferRequestCallback onOfferRequest;
    ListingCallback onListing;
    std::map<std::string, PeerInfo> peers;

    void stopKeepaliveThread() {
        keepaliveRunning.store(false);
        if (!keepaliveThread.joinable()) {
            return;
        }
        if (keepaliveThread.get_id() == std::this_thread::get_id()) {
            spdlog::warn("[Signaling] stopKeepaliveThread called from keepalive thread; deferring join");
            return;
        }
        keepaliveThread.join();
    }

    void handleMessage(const std::string &payload) {
        json msg;
        try {
            msg = json::parse(payload);
        } catch (const std::exception &e) {
            spdlog::warn("Signaling parse error: {}", e.what());
            return;
        }

        // Debug: log incoming messages (truncate large payloads)
        std::string logPayload = payload.length() > 200 ? payload.substr(0, 200) + "..." : payload;
        spdlog::info("[Signaling] Received: {}", logPayload);

        if (msg.contains("id") && uuid.empty()) {
            uuid = msg.value("id", "");
        }

        if (msg.contains("ping")) {
            json pong;
            pong["pong"] = msg["ping"];
            sendMessage(pong);
            return;
        }

        const std::string request = msg.value("request", "");
        if (request == "alert") {
            const std::string message = msg.value("message", "");
            spdlog::warn("[Signaling] Alert: {}", message.empty() ? "(empty)" : message);
            if (onAlert) {
                onAlert(message);
            }
            return;
        }

        if (request == "listing") {
            std::vector<PeerInfo> list;
            if (msg.contains("list") && msg["list"].is_array()) {
                for (const auto &item : msg["list"]) {
                    PeerInfo info;
                    info.uuid = item.value("UUID", "");
                    info.streamId = item.value("streamID", "");
                    info.label = item.value("label", "");
                    info.isPublisher = item.value("publisher", false);
                    list.push_back(info);
                }
            }
            if (onListing) {
                onListing(list);
            }
            return;
        }

        if (request == "offerSDP") {
            if (onOfferRequest) {
                onOfferRequest(msg.value("UUID", ""), msg.value("session", ""), msg.value("streamID", ""));
            }
            return;
        }

        if (msg.contains("description")) {
            std::string description;
            if (msg["description"].is_string() && msg.contains("vector")) {
                auto pass = effectivePassword(password, encryptionDisabled);
                std::string decrypted;
                if (!aesDecryptCbc(msg["description"].get<std::string>(), msg["vector"].get<std::string>(), pass + salt, decrypted)) {
                    spdlog::warn("Failed to decrypt SDP");
                    return;
                }
                description = decrypted;
            } else if (msg["description"].is_object()) {
                description = msg["description"].dump();
            } else if (msg["description"].is_string()) {
                description = msg["description"].get<std::string>();
            }

            if (!description.empty()) {
                json descJson = json::parse(description, nullptr, false);
                if (!descJson.is_discarded()) {
                    description = descJson.value("sdp", "");
                    std::string type = descJson.value("type", "");
                    if (type == "offer") {
                        if (onOffer) {
                            SignalOffer offer{msg.value("UUID", ""), description, msg.value("session", ""), msg.value("streamID", "")};
                            onOffer(offer);
                        }
                    } else if (type == "answer") {
                        if (onAnswer) {
                            SignalAnswer answer{msg.value("UUID", ""), description, msg.value("session", ""), msg.value("streamID", "")};
                            onAnswer(answer);
                        }
                    }
                }
            }
            return;
        }

        if (msg.contains("candidate")) {
            std::string candidate;
            if (msg["candidate"].is_string() && msg.contains("vector")) {
                auto pass = effectivePassword(password, encryptionDisabled);
                std::string decrypted;
                if (!aesDecryptCbc(msg["candidate"].get<std::string>(), msg["vector"].get<std::string>(), pass + salt, decrypted)) {
                    spdlog::warn("Failed to decrypt ICE candidate");
                    return;
                }
                candidate = decrypted;
            } else if (msg["candidate"].is_object()) {
                candidate = msg["candidate"].dump();
            } else if (msg["candidate"].is_string()) {
                candidate = msg["candidate"].get<std::string>();
            }

            json candJson = json::parse(candidate, nullptr, false);
            if (candJson.is_discarded()) {
                return;
            }
            SignalCandidate cand;
            cand.uuid = msg.value("UUID", "");
            cand.candidate = candJson.value("candidate", "");
            cand.mid = candJson.value("sdpMid", "");
            cand.mlineIndex = candJson.value("sdpMLineIndex", 0);
            cand.session = msg.value("session", "");
            cand.type = msg.value("type", "");
            if (onCandidate) {
                onCandidate(cand);
            }
            return;
        }

        if (msg.contains("candidates")) {
            std::string candidatePayload;
            if (msg["candidates"].is_string() && msg.contains("vector")) {
                auto pass = effectivePassword(password, encryptionDisabled);
                std::string decrypted;
                if (!aesDecryptCbc(msg["candidates"].get<std::string>(), msg["vector"].get<std::string>(), pass + salt, decrypted)) {
                    spdlog::warn("Failed to decrypt ICE bundle");
                    return;
                }
                candidatePayload = decrypted;
            } else if (msg["candidates"].is_array()) {
                candidatePayload = msg["candidates"].dump();
            } else if (msg["candidates"].is_string()) {
                candidatePayload = msg["candidates"].get<std::string>();
            }

            json candArray = json::parse(candidatePayload, nullptr, false);
            if (!candArray.is_array()) {
                return;
            }
            for (const auto &candItem : candArray) {
                SignalCandidate cand;
                cand.uuid = msg.value("UUID", "");
                cand.candidate = candItem.value("candidate", "");
                cand.mid = candItem.value("sdpMid", "");
                cand.mlineIndex = candItem.value("sdpMLineIndex", 0);
                cand.session = msg.value("session", "");
                cand.type = msg.value("type", "");
                if (onCandidate) {
                    onCandidate(cand);
                }
            }
            return;
        }
    }

    bool sendMessage(const json &msg) {
        std::shared_ptr<rtc::WebSocket> socketRef;
        {
            std::lock_guard<std::mutex> lock(mutex);
            socketRef = socket;
        }
        if (!socketRef || !connected.load() || !socketRef->isOpen()) {
            return false;
        }
        std::string payload = msg.dump();
        std::string logPayload = payload.length() > 200 ? payload.substr(0, 200) + "..." : payload;
        spdlog::info("[Signaling] Sending: {}", logPayload);
        socketRef->send(payload);
        return true;
    }

    std::string hashedRoom(const std::string &room) const {
        if (encryptionDisabled) {
            return room;
        }
        auto pass = effectivePassword(password, encryptionDisabled);
        return hashHex(room + pass + salt, 16);
    }

    std::string hashedStreamId(const std::string &streamId) {
        if (encryptionDisabled) {
            return streamId;
        }
        auto pass = effectivePassword(password, encryptionDisabled);
        if (pass.empty()) {
            return streamId;
        }
        std::string hashSuffix = hashHex(pass + salt, 6);
        return streamId + hashSuffix;
    }
};

VdoSignaling::VdoSignaling() : impl_(std::make_unique<Impl>()) {
    impl_->uuid = generateUuid();
}

VdoSignaling::~VdoSignaling() {
    disconnect();
}

bool VdoSignaling::connect(const std::string &server) {
    // Ensure no stale keepalive thread is left joinable after prior disconnects.
    impl_->stopKeepaliveThread();

    if (impl_->connected.load()) {
        disconnect();
    }
    impl_->connectionFailed.store(false);

    // Configure WebSocket with proper timeout
    rtc::WebSocket::Configuration wsConfig;
    wsConfig.connectionTimeout = std::chrono::seconds(60);
    wsConfig.disableTlsVerification = false;

    std::shared_ptr<rtc::WebSocket> socket;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        socket = std::make_shared<rtc::WebSocket>(wsConfig);
        impl_->socket = socket;
    }

    std::weak_ptr<rtc::WebSocket> socketWeak = socket;
    auto isActiveSocket = [this, socketWeak]() {
        auto callbackSocket = socketWeak.lock();
        if (!callbackSocket) {
            return false;
        }

        std::lock_guard<std::mutex> lock(impl_->mutex);
        return impl_->socket == callbackSocket;
    };

    socket->onOpen([this, isActiveSocket]() {
        if (!isActiveSocket()) {
            spdlog::debug("[Signaling] Ignoring stale onOpen callback");
            return;
        }
        spdlog::info("[Signaling] WebSocket onOpen callback triggered");
        impl_->connected.store(true);
        impl_->connectionFailed.store(false);
        if (impl_->onConnected) {
            impl_->onConnected();
        }
    });
    socket->onClosed([this, isActiveSocket]() {
        if (!isActiveSocket()) {
            spdlog::debug("[Signaling] Ignoring stale onClosed callback");
            return;
        }
        spdlog::info("[Signaling] WebSocket onClosed callback triggered");
        impl_->connected.store(false);
        impl_->keepaliveRunning.store(false);  // Stop keepalive thread
        if (impl_->onDisconnected) {
            impl_->onDisconnected();
        }
    });
    socket->onError([this, isActiveSocket](std::string error) {
        if (!isActiveSocket()) {
            spdlog::debug("[Signaling] Ignoring stale onError callback: {}", error);
            return;
        }
        spdlog::error("[Signaling] WebSocket onError: {}", error);
        impl_->connectionFailed.store(true);
        if (impl_->onError) {
            impl_->onError(error);
        }
    });
    socket->onMessage([this, isActiveSocket](auto message) {
        if (!isActiveSocket()) {
            return;
        }
        spdlog::info("[Signaling] onMessage callback triggered");
        if (std::holds_alternative<std::string>(message)) {
            impl_->handleMessage(std::get<std::string>(message));
        } else {
            spdlog::info("[Signaling] Received non-string message");
        }
    });

    socket->open(server);
    auto start = std::chrono::steady_clock::now();
    while (!impl_->connected.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (impl_->connectionFailed.load()) {
            disconnect();
            return false;
        }
        if (std::chrono::steady_clock::now() - start > std::chrono::seconds(10)) {
            spdlog::error("[Signaling] Connection timeout to {}", server);
            disconnect();
            return false;
        }
    }

    // Keepalive pings are required on many VDO.Ninja deployments to prevent idle socket closure.
    // Enabled by default; can be disabled via VERSUS_SIGNALING_CLIENT_PING=0.
    bool enableClientPing = true;
    if (const char *env = std::getenv("VERSUS_SIGNALING_CLIENT_PING")) {
        std::string value(env);
        std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        if (value == "0" || value == "false" || value == "no" || value == "off") {
            enableClientPing = false;
        } else if (value == "1" || value == "true" || value == "yes" || value == "on") {
            enableClientPing = true;
        }
    }

    if (enableClientPing) {
        const auto pingInterval = clientPingInterval();
        impl_->keepaliveRunning.store(true);
        impl_->keepaliveThread = std::thread([this, pingInterval]() {
            spdlog::info("[Signaling] Keepalive thread started (interval={}ms)", pingInterval.count());
            while (impl_->keepaliveRunning.load() && impl_->connected.load()) {
                std::this_thread::sleep_for(pingInterval);
                if (impl_->keepaliveRunning.load() && impl_->connected.load()) {
                    json ping;
                    ping["ping"] = std::chrono::system_clock::now().time_since_epoch().count();
                    impl_->sendMessage(ping);
                    spdlog::debug("[Signaling] Sent keepalive ping");
                }
            }
            spdlog::info("[Signaling] Keepalive thread stopped");
        });
    } else {
        impl_->keepaliveRunning.store(false);
        spdlog::info("[Signaling] Client keepalive ping disabled");
    }

    return true;
}

void VdoSignaling::disconnect() {
    // Stop keepalive thread
    impl_->stopKeepaliveThread();

    std::shared_ptr<rtc::WebSocket> socketRef;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        socketRef = std::move(impl_->socket);
    }
    if (socketRef && socketRef->isOpen()) {
        socketRef->close();
    }
    impl_->connected.store(false);
    impl_->connectionFailed.store(false);
    impl_->published.store(false);
    impl_->roomId.clear();
    impl_->streamId.clear();
}

bool VdoSignaling::isConnected() const {
    return impl_->connected.load();
}

bool VdoSignaling::joinRoom(const RoomConfig &config) {
    impl_->roomId = sanitizeId(config.room, 30);
    if (impl_->roomId.empty()) {
        return false;
    }
    impl_->salt = config.salt.empty() ? "vdo.ninja" : config.salt;
    impl_->label = config.label;
    impl_->password = config.password;
    impl_->encryptionDisabled = (config.password == "false" || config.password == "0" || config.password == "off");

    json msg;
    msg["request"] = "joinroom";
    msg["roomid"] = impl_->hashedRoom(impl_->roomId);
    return impl_->sendMessage(msg);
}

void VdoSignaling::leaveRoom() {
    json msg;
    msg["leave"] = true;
    impl_->sendMessage(msg);
    impl_->roomId.clear();
}

bool VdoSignaling::publish(const std::string &streamId, const std::string &label) {
    impl_->streamId = sanitizeId(streamId.empty() ? generateStreamId() : streamId, 64);
    if (impl_->streamId.empty()) {
        impl_->streamId = generateStreamId();
    }
    impl_->label = label;

    std::string hashedId = impl_->hashedStreamId(impl_->streamId);
    spdlog::info("[Signaling] Publishing: original='{}', hashed='{}', encryptionDisabled={}",
                 impl_->streamId, hashedId, impl_->encryptionDisabled);

    json msg;
    msg["request"] = "seed";
    msg["streamID"] = hashedId;
    if (!impl_->sendMessage(msg)) {
        return false;
    }
    impl_->published.store(true);

    // Check WebSocket state after publish
    std::shared_ptr<rtc::WebSocket> socketRef;
    {
        std::lock_guard<std::mutex> lock(impl_->mutex);
        socketRef = impl_->socket;
    }
    if (socketRef) {
        spdlog::info("[Signaling] After publish: socket isOpen={}, bufferedAmount={}",
                     socketRef->isOpen(), socketRef->bufferedAmount());
    }
    return true;
}

void VdoSignaling::unpublish() {
    json msg;
    msg["unpublish"] = true;
    impl_->sendMessage(msg);
    impl_->published.store(false);
}

bool VdoSignaling::sendOffer(const SignalOffer &offer) {
    json desc;
    desc["type"] = "offer";
    desc["sdp"] = offer.sdp;

    std::string streamIdToSend = offer.streamId.empty() ? impl_->streamId : offer.streamId;
    if (!impl_->encryptionDisabled) {
        streamIdToSend = impl_->hashedStreamId(streamIdToSend);
    }

    json msg;
    msg["UUID"] = offer.uuid;
    msg["session"] = offer.session;
    msg["streamID"] = streamIdToSend;
    if (impl_->encryptionDisabled) {
        spdlog::info("[Signaling] Sending offer WITHOUT encryption");
        msg["description"] = desc;
    } else {
        std::string encrypted;
        std::string vector;
        auto pass = effectivePassword(impl_->password, impl_->encryptionDisabled);
        spdlog::info("[Signaling] Encrypting offer with key derived from: pass='{}' + salt='{}'",
                     pass.empty() ? "(empty)" : "(set)", impl_->salt);
        if (aesEncryptCbc(desc.dump(), pass + impl_->salt, encrypted, vector)) {
            msg["description"] = encrypted;
            msg["vector"] = vector;
            spdlog::info("[Signaling] Sending encrypted offer, vector={}", vector);
        } else {
            spdlog::warn("[Signaling] Encryption failed, sending unencrypted offer");
            msg["description"] = desc;
        }
    }
    impl_->sendMessage(msg);
    return true;
}

bool VdoSignaling::sendAnswer(const SignalAnswer &answer) {
    json desc;
    desc["type"] = "answer";
    desc["sdp"] = answer.sdp;

    std::string streamIdToSend = answer.streamId.empty() ? impl_->streamId : answer.streamId;
    if (!impl_->encryptionDisabled) {
        streamIdToSend = impl_->hashedStreamId(streamIdToSend);
    }

    json msg;
    msg["UUID"] = answer.uuid;
    msg["session"] = answer.session;
    msg["streamID"] = streamIdToSend;
    if (impl_->encryptionDisabled) {
        msg["description"] = desc;
    } else {
        std::string encrypted;
        std::string vector;
        auto pass = effectivePassword(impl_->password, impl_->encryptionDisabled);
        if (aesEncryptCbc(desc.dump(), pass + impl_->salt, encrypted, vector)) {
            msg["description"] = encrypted;
            msg["vector"] = vector;
        } else {
            msg["description"] = desc;
        }
    }
    impl_->sendMessage(msg);
    return true;
}

bool VdoSignaling::sendCandidate(const SignalCandidate &candidate) {
    json candidatePayload;
    candidatePayload["candidate"] = candidate.candidate;
    candidatePayload["sdpMid"] = candidate.mid;
    candidatePayload["sdpMLineIndex"] = candidate.mlineIndex;

    json msg;
    msg["UUID"] = candidate.uuid;
    msg["session"] = candidate.session;
    msg["type"] = candidate.type.empty() ? impl_->candidateType : candidate.type;
    msg["candidate"] = candidatePayload;
    if (!impl_->encryptionDisabled) {
        std::string encrypted;
        std::string vector;
        auto pass = effectivePassword(impl_->password, impl_->encryptionDisabled);
        if (aesEncryptCbc(candidatePayload.dump(), pass + impl_->salt, encrypted, vector)) {
            msg["candidate"] = encrypted;
            msg["vector"] = vector;
        }
    }
    impl_->sendMessage(msg);
    return true;
}

void VdoSignaling::setCandidateType(const std::string &type) {
    impl_->candidateType = type;
}

void VdoSignaling::setPassword(const std::string &password) {
    impl_->password = password;
    impl_->encryptionDisabled = false;
}

void VdoSignaling::disableEncryption() {
    impl_->encryptionDisabled = true;
}

std::string VdoSignaling::getViewUrl() const {
    if (impl_->streamId.empty()) {
        return "";
    }
    std::string url = "https://vdo.ninja/?view=" + impl_->streamId;
    if (!impl_->roomId.empty()) {
        url += "&room=" + impl_->roomId + "&solo";
    }
    if (impl_->encryptionDisabled) {
        url += "&password=false";
    } else if (!impl_->password.empty()) {
        url += "&password=" + impl_->password;
    }
    return url;
}

std::string VdoSignaling::getStreamId() const {
    return impl_->streamId;
}

std::string VdoSignaling::getRoomId() const {
    return impl_->roomId;
}

void VdoSignaling::onConnected(ConnectedCallback cb) { impl_->onConnected = std::move(cb); }
void VdoSignaling::onDisconnected(DisconnectedCallback cb) { impl_->onDisconnected = std::move(cb); }
void VdoSignaling::onError(ErrorCallback cb) { impl_->onError = std::move(cb); }
void VdoSignaling::onAlert(AlertCallback cb) { impl_->onAlert = std::move(cb); }
void VdoSignaling::onOffer(OfferCallback cb) { impl_->onOffer = std::move(cb); }
void VdoSignaling::onAnswer(AnswerCallback cb) { impl_->onAnswer = std::move(cb); }
void VdoSignaling::onCandidate(CandidateCallback cb) { impl_->onCandidate = std::move(cb); }
void VdoSignaling::onOfferRequest(OfferRequestCallback cb) { impl_->onOfferRequest = std::move(cb); }
void VdoSignaling::onListing(ListingCallback cb) { impl_->onListing = std::move(cb); }

}  // namespace versus::signaling
