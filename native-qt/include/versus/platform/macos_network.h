#pragma once
#include "versus/webrtc/ice_config.h"
#include <string>

namespace versus::platform {
std::string macSystemCaCertificatesPem();
webrtc::TurnRegistryHttpResponse macFetchTurnRegistry(const webrtc::TurnRegistryRequest &request);
} // namespace versus::platform
