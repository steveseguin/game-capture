#pragma once
#include <nlohmann/json.hpp>
#include <string>

namespace versus::app {
// Only complete, standalone desired-state messages may supersede one another.
// Partial controls, replies/IDs, and messages carrying other actions are barriers.
inline std::string videoControlSnapshotKey(const nlohmann::json &message) {
    if (!message.is_object() || message.size() != 4 ||
        message.value("action", nlohmann::json{}) != "requestResolution" ||
        !message.contains("remote") || !message["remote"].is_string() ||
        !message.contains("value") || !message["value"].is_object() ||
        message["value"].size() != 3 || !message.contains("targetBitrate")) {
        return {};
    }
    const auto bounded = [](const nlohmann::json &value, int low, int high) {
        return value.is_number_integer() && value >= low && value <= high;
    };
    const auto &value = message["value"];
    if (!value.contains("w") || !value.contains("h") || !value.contains("f") ||
        !bounded(value["w"], 2, 7680) || !bounded(value["h"], 2, 4320) ||
        !bounded(value["f"], 10, 120) || !bounded(message["targetBitrate"], 250, 100000)) {
        return {};
    }
    return "video-snapshot:" + message["remote"].get<std::string>();
}
} // namespace versus::app
