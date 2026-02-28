# Phase 2 Testing Requirements

Last updated: 2026-02-22

## Scope

Phase 2 expands beyond reconnect/keepalive validation and covers real operator behavior under long-running and unstable conditions.

## Mandatory Requirements

`P2-REQ-001` Window lifecycle resiliency.
- If the captured window closes/disappears, the app must not crash.
- When the window reappears (or a replacement is selected), streaming must resume without process restart.

`P2-REQ-002` Window resize and resolution change handling.
- Dynamic window size changes must not deadlock capture or encoder paths.
- Viewer decode must continue after size transitions.

`P2-REQ-003` Audio track interruption and recovery.
- Temporary audio loss (mute/device interruption/source silence) must not break the media session.
- Audio must recover without restarting the app.

`P2-REQ-004` Multi-viewer join/leave churn.
- Repeated viewer join/leave cycles with multiple concurrent viewers must keep publisher stable.
- No crash, deadlock, or persistent no-video state is allowed.

`P2-REQ-005` Publisher restarts and republish continuity.
- Restarting the publisher process with the same stream settings must recover cleanly.
- Stream-ID collision handling must remain explicit and non-silent.

`P2-REQ-006` WebSocket disconnect/reconnect chaos.
- Forced signaling drops during live publish must trigger reconnect and republish.
- Keepalive thread lifecycle must remain bounded (no stale ping loops after disconnect).

`P2-REQ-007` Stream-ID in-use user feedback path.
- Collision errors from signaling must surface an operator-visible failure.
- Alternate stream ID publish path must remain functional after collision.

`P2-REQ-008` Extended soak stability.
- Soak with churn must run for at least 60 minutes with no fatal runtime events.
- Memory/handle growth must remain bounded and non-divergent.

`P2-REQ-009` CI lane enforcement.
- Fast gate must run automatically on pull requests.
- Nightly soak lane must run automatically and retain reports for investigation.

`P2-REQ-010` Evidence artifacts.
- Each Phase 2 run must produce timestamped markdown evidence in `native-qt/qa/reports/`.
- Failures must include actionable context (stage, logs, screenshots where applicable).

## Exit Policy

Phase 2 is complete only when all `P2-REQ-*` checks pass and evidence is archived for sign-off.
