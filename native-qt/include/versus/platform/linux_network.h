#pragma once
#include "versus/webrtc/ice_config.h"
#include <string>
namespace versus::platform {
std::string linuxSystemCaCertificatesPem();
webrtc::TurnRegistryHttpResponse linuxFetchTurnRegistry(const webrtc::TurnRegistryRequest &);
}
