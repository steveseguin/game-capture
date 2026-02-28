# Dual-Stream Test Requirements

Last updated: 2026-02-23
Status: LOCKED (required before enabling by default)
Related spec: `native-qt/qa/DUAL_STREAM_PLAN.md`

## Scope

These requirements validate that HQ/LQ role-based routing is real, complete, and stable under churn/reconnect conditions.

## Unit and Component Requirements

`DS-REQ-001` Role parsing and tier mapping must be deterministic.
- Test role values: `scene`, `director`, `guest`, `viewer`, unknown.
- Verify room vs direct behavior matrix exactly matches plan.

`DS-REQ-002` No more than two tier encoders can be active.
- Validate encoder lifecycle under join/leave churn.
- Assert no unexpected third encode path starts.

`DS-REQ-003` Room peer media must be gated on init.
- No audio/video packets before init arrives.
- Missing init triggers timeout disconnect.

`DS-REQ-004` Peer media flags must be honored.
- `video=false` blocks video packets.
- `audio=false` blocks audio packets.

`DS-REQ-005` Max-viewer limit must remain enforced with dual-stream enabled.
- New connections above configured limit are rejected.

`DS-REQ-006` Direct mode remains HQ-only.
- LQ encoder never starts in direct non-room mode.

## End-to-End Requirements

`DS-REQ-007` Mixed-role room scenario must pass.
- At least one `scene` and one `guest/director`.
- Scene receives HQ stream characteristics.
- Guest/director receives LQ 640x360@30 at approximately 2000 kbps target.

`DS-REQ-008` Room churn with mixed roles must pass.
- Multiple viewers join/leave repeatedly.
- No crashes, deadlocks, or stuck encoders.
- Tier counts and routing recover correctly.

`DS-REQ-009` Reconnect behavior must pass.
- Force signaling disconnect/reconnect.
- Existing session returns to consistent tier routing after re-init.

`DS-REQ-010` Window/source changes during dual-stream must pass.
- Capture target switch.
- Window resize/fullscreen changes.
- Streams continue with valid frames in assigned tiers.

`DS-REQ-011` Audio drop/recovery behavior must pass.
- Audio source interruption and recovery.
- Per-peer audio flags remain respected.

`DS-REQ-012` Stream ID in-use alert handling must remain correct.
- Collision still produces fatal runtime event and stops publish path.

## Fuzz and Soak Requirements

`DS-REQ-013` Data-channel init fuzzing must pass.
- Malformed JSON.
- Missing fields.
- Unknown roles.
- Repeated init updates.
- Expected result: no crash, no undefined tier state.

`DS-REQ-014` Long soak with mixed room roles must pass.
- Minimum 30 minutes.
- Stable memory trend.
- No encoder thread leaks.
- No unrecovered peer-state corruption.

## Evidence Requirements

`DS-REQ-015` Automated artifacts are mandatory.
- Unit test output (`ctest` log).
- E2E report(s) for dual-quality scenarios.
- Soak report for mixed-role room scenario.
- Publisher logs with tier assignment and init gating markers.

`DS-REQ-016` Release gate script must include dual-stream checks.
- `run-fast-gate.ps1` or release-readiness flow must call new dual-stream E2E command(s).
- Dual-stream tests are blocking for release once feature flag is enabled by default.

## Pass Criteria

Feature can be marked production-ready only when:

- All `DS-REQ-*` items pass.
- Zero critical failures in unit/E2E/soak runs.
- Evidence files are archived under `native-qt/qa/reports`.

## Suggested Command Additions

Add new npm scripts once implemented:

- `npm run e2e:dual-quality`
- `npm run e2e:dual-quality-churn`
- `npm run e2e:dual-quality-soak`
- `npm run e2e:dual-quality-requirements`

Add one release gate entry:

- `powershell -ExecutionPolicy Bypass -File native-qt/qa/run-fast-gate.ps1 ... -IncludeDualStream`

## Latest Validation Record (2026-02-23)

- Release readiness report: `native-qt/qa/reports/release-readiness-20260223-074531.md` (`Overall: PASS`).
- Dual requirements report: `native-qt/qa/reports/dual-quality-requirements-2026-02-23T13-57-02-018Z.md` (`Result: PASS`).
- Dual soak report: `native-qt/qa/reports/dual-quality-soak-2026-02-23T13-21-39-795Z.md` (`Result: PASS`).

- `DS-REQ-001`: PASS
- Evidence: `DualStreamPolicyTest` (`native-qt/tests/test_dual_stream_policy.cpp`).

- `DS-REQ-002`: PASS
- Evidence: `npm run e2e:dual-quality-requirements` confirms only `hq/lq` routing in mixed-role runtime and no LQ path in direct mode (`direct_hq_only` case).

- `DS-REQ-003`: PASS
- Evidence:
  - Unit route gating in `DualStreamPolicyTest`.
  - `room_init_timeout` case in `npm run e2e:dual-quality-requirements`.

- `DS-REQ-004`: PASS
- Evidence:
  - Unit media flag checks in `DualStreamPolicyTest`.
  - `reconnect_control_media` case validates `peer_audio_enabled` toggle false->true with active stream.

- `DS-REQ-005`: PASS
- Evidence: `room_max_viewers` case in `npm run e2e:dual-quality-requirements`.

- `DS-REQ-006`: PASS
- Evidence: `direct_hq_only` case in `npm run e2e:dual-quality-requirements`.

- `DS-REQ-007`: PASS
- Evidence: `npm run e2e:dual-quality`.

- `DS-REQ-008`: PASS
- Evidence: `npm run e2e:dual-quality-churn`.

- `DS-REQ-009`: PASS
- Evidence:
  - Signaling lifecycle reconnect coverage in `VdoSignalingTest`.
  - Room re-init reconnect coverage in `reconnect_control_media` case.

- `DS-REQ-010`: PASS
- Evidence: `reconnect_control_media` case applies runtime resolution/bitrate control while HQ+LQ viewers remain stable.

- `DS-REQ-011`: PASS
- Evidence: `reconnect_control_media` case validates audio flag drop/recovery (`peer_audio_enabled` false->true) without stream loss.

- `DS-REQ-012`: PASS
- Evidence: `npm run e2e:collision` (included by release-readiness gate).

- `DS-REQ-013`: PASS
- Evidence: `npm run e2e:dual-quality-init-fuzz`.

- `DS-REQ-014`: PASS
- Evidence: `npm run e2e:dual-quality-soak -- --duration-min=30`.

- `DS-REQ-015`: PASS
- Evidence: reports under `native-qt/qa/reports` for unit/E2E/dual-soak/release-readiness.

- `DS-REQ-016`: PASS
- Evidence: `native-qt/qa/run-release-readiness.ps1` executes:
  - `e2e:dual-quality`
  - `e2e:dual-quality-churn`
  - `e2e:dual-quality-init-fuzz`
  - `e2e:dual-quality-requirements`
  - `e2e:dual-quality-soak` (when soak enabled)
