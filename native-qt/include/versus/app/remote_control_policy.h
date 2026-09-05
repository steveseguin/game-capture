#pragma once

namespace versus::app {

// VDO.Ninja viewers routinely send resolution hints while establishing a
// receive-only view. They must never mutate the shared publisher, but replying
// with a control rejection makes hosted VDO.Ninja show a misleading director
// error. Explicit control surfaces still receive authorization feedback.
inline bool shouldReportUnauthorizedResolutionControl(
    bool roomDirector,
    bool suppliedControlToken) {
    return roomDirector || suppliedControlToken;
}

}  // namespace versus::app
