# Phase 2 Test Execution Plan

Last updated: 2026-02-22

## Goal

Validate real-world runtime stability for operator workflows: window churn, audio churn, viewer churn, publisher restarts, and signaling instability.

## Workstreams

1. `WS-001` CI lanes.
- Fast PR gate: deterministic release checks without soak.
- Nightly soak gate: full release-readiness with soak enabled and reports uploaded.

2. `WS-002` Scenario automation expansion.
- Add `e2e/viewer-churn-e2e.js` for multi-viewer join/leave stress.
- Add `e2e/restart-republish-e2e.js` for repeated publisher restart cycles.
- Add `e2e/signaling-chaos-e2e.js` for forced signaling disconnect/reconnect events.
- Add `e2e/window-lifecycle-e2e.js` for window close/reopen/resize behavior.
- Add `e2e/audio-recovery-e2e.js` for audio drop/recovery behavior.

3. `WS-003` Observability and thresholds.
- Define and enforce pass/fail thresholds for reconnect time, crash count, and runtime errors.
- Capture memory/handle snapshots before/after soak and compare drift.

## Execution Order

1. Enable CI fast gate on pull requests.
- Run `native-qt/qa/run-fast-gate.ps1`.

2. Enable nightly soak lane.
- Run `native-qt/qa/run-nightly-soak.ps1` with soak enabled.

3. Implement and land new Phase 2 E2E scripts in this order:
- `viewer-churn`
- `restart-republish`
- `signaling-chaos`
- `window-lifecycle`
- `audio-recovery`

4. Promote each script into QA gate only after two consecutive stable runs.

5. Run consolidated Phase 2 readiness:
- One full nightly soak plus all Phase 2 scenarios with fresh reports.

## Sign-Off Checklist

- [ ] Fast PR gate is active in CI and passing.
- [ ] Nightly soak lane is active in CI and producing reports.
- [ ] `P2-REQ-001` window lifecycle evidence is present.
- [ ] `P2-REQ-002` resize/resolution evidence is present.
- [ ] `P2-REQ-003` audio interruption/recovery evidence is present.
- [ ] `P2-REQ-004` multi-viewer churn evidence is present.
- [ ] `P2-REQ-005` restart/republish evidence is present.
- [ ] `P2-REQ-006` signaling chaos evidence is present.
- [ ] `P2-REQ-007` stream-ID collision feedback evidence is present.
- [ ] `P2-REQ-008` extended soak evidence is present.
- [ ] `P2-REQ-009` CI enforcement evidence is present.
- [ ] `P2-REQ-010` all required artifacts are archived.
