# Testing Requirements

Last updated: 2026-02-23

## Scope

These requirements define the minimum evidence needed to claim signaling reconnect/keepalive changes are real and complete.

## Mandatory Checks

`REQ-001` Deterministic signaling lifecycle coverage is required in CTest.
- `VdoSignalingTest` must run and pass.
- It must cover reconnect after remote close without an explicit `disconnect()`.
- It must cover that `disconnect()` stops keepalive ping traffic.

`REQ-002` CTest must run against the release configuration.
- Command: `ctest --test-dir <build-dir> -C Release --output-on-failure`.
- Zero failed tests is required.

`REQ-003` Integration E2E gate must pass.
- `npm run e2e:matrix`
- `npm run e2e:refresh`
- `npm run e2e:collision`
- `npm run e2e:control`
- `npm run e2e:bitrate`
- `npm run e2e:viewer-churn`

`REQ-004` Soak is a default release gate.
- `run-release-readiness.ps1` must run soak unless explicitly skipped with `-SkipSoak`.
- If soak is skipped, release notes must include explicit risk acceptance.

`REQ-005` Evidence artifacts are required.
- `qa/reports/release-readiness-*.md` must be produced for each release candidate.
- `qa/reports/soak-*.md` must exist when soak is enabled.

`REQ-006` Control message validation must include a positive control ack.
- `e2e:control` must observe an `ack: "control"` response with `ok: true`.
- Bitrate/resize control outcomes must remain visible in either ack payload or publisher runtime log.

`REQ-007` QSV profile gate must pass.
- `run-fast-gate.ps1` with `-RefreshVideoEncoder qsv` must pass.
- Required scenarios include matrix, refresh, collision, control, bitrate smoke, and viewer churn.

`REQ-008` UI advanced panel collapse regression must be covered.
- `MainWindowTest` must verify that collapsing the advanced panel restores the window height.
- Regression must pass in release CTest runs.

## Release Policy

Any failed requirement blocks release.

## Locked Upcoming Feature Requirements

Dual-stream room quality requirements are locked in a dedicated checklist:

- `native-qt/qa/DUAL_STREAM_PLAN.md`
- `native-qt/qa/DUAL_STREAM_TEST_REQUIREMENTS.md`

Those `DS-REQ-*` gates become release-blocking when dual-stream is enabled by default.

## Latest Validation Record (2026-02-23)

- `REQ-001`: PASS
- Evidence: `ctest --test-dir native-qt/build-review2 -C Release --output-on-failure` passed with `VdoSignalingTest` included.

- `REQ-002`: PASS
- Evidence: release `ctest` run reported `100% tests passed, 0 tests failed out of 7`.

- `REQ-003`: PASS
- Evidence: release-readiness integration gates passed in `native-qt/qa/reports/release-readiness-20260223-074531.md`.

- `REQ-004`: PASS
- Evidence: soak-enabled release gate passed in `native-qt/qa/reports/release-readiness-20260223-074531.md`.

- `REQ-005`: PASS
- Evidence:
  - `native-qt/qa/reports/release-readiness-20260223-074531.md`
  - `native-qt/qa/reports/soak-2026-02-23T13-51-42-842Z.md`
  - `native-qt/qa/reports/bitrate-smoke-2026-02-23T12-51-13-039Z.md`
  - `native-qt/qa/reports/dual-quality-requirements-2026-02-23T12-49-21-711Z.md`

- `REQ-006`: PASS
- Evidence: `E2E Data Channel Control` passed in `native-qt/qa/reports/release-readiness-20260223-074531.md` with `ack="control"` and `ok=true`.

- `REQ-007`: PASS
- Evidence: `powershell -ExecutionPolicy Bypass -File native-qt/qa/run-fast-gate.ps1 -BuildDir build-review2 -Configuration Release -RefreshVideoEncoder qsv` passed.
- Report: `native-qt/qa/reports/release-readiness-20260223-085308.md`

- `REQ-008`: PASS
- Evidence: `MainWindowTest` includes advanced panel close/shrink regression check and release `ctest` run passed with `0` failures.
