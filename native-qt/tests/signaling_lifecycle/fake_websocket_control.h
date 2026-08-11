#pragma once

#include <cstddef>
#include <string>

namespace rtc::signaling_lifecycle_test {

void reset();
void joinCallbacks();
void holdNextTextBeforeDispatch();
[[nodiscard]] bool waitForHeldText(std::size_t timeoutMs);
void releaseHeldText();
void failNextSend();
void throwNextSend();

[[nodiscard]] std::size_t socketCount();
[[nodiscard]] std::size_t sentMessageCount();
[[nodiscard]] bool socketIsOpen(std::size_t index);
[[nodiscard]] bool latestSocketIsOpen();

bool emitText(std::size_t index, const std::string &message);
bool emitTextOnLatest(const std::string &message);
bool emitClosed(std::size_t index);

}  // namespace rtc::signaling_lifecycle_test
