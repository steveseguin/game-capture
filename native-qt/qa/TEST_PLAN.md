# Test Execution Plan

Last updated: 2026-02-23

## Goal

Provide repeatable proof that reconnect, encoder stability, control-channel handling, and key UI lifecycle behavior are correct before release.

## Execution Order

1. Build tests in release mode.
- `cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -D<BUILD_TESTS_OPTION>=ON ...`
- `cmake --build .`

2. Run deterministic fast gate.
- `ctest -C Release --output-on-failure`
- Confirm `VdoSignalingTest` is included and passing.

3. Run integration gate.
- `npm run e2e:matrix`
- `npm run e2e:refresh`
- `npm run e2e:collision`
- `npm run e2e:control`
- `npm run e2e:bitrate`
- `npm run e2e:viewer-churn`

4. Run QSV profile gate (stability parity with default fast gate profile).
- `powershell -ExecutionPolicy Bypass -File native-qt/qa/run-fast-gate.ps1 -BuildDir <dir> -Configuration Release -RefreshVideoEncoder qsv`

5. Run release-readiness gate (includes soak by default).
- `.\qa\run-release-readiness.ps1 -BuildDir <dir> -Configuration Release`

5a. When dual-stream mode is enabled, confirm the dedicated requirements gate passes.
- `npm run e2e:dual-quality-requirements`

6. Run UI regression check for advanced panel collapse behavior.
- `ctest --test-dir <build-dir> -C Release --output-on-failure`
- Confirm `MainWindowTest` includes advanced panel expand/collapse resize assertion.

7. Archive evidence for sign-off.
- Keep the generated `qa/reports/release-readiness-*.md`.
- Keep the generated `qa/reports/soak-*.md` when soak is enabled.

## Sign-Off Checklist

- [x] CTest passed with zero failures in `Release`.
- [x] `VdoSignalingTest` passed.
- [x] All E2E gate commands passed.
- [x] `e2e:control` validated positive control ack handling.
- [x] QSV profile fast gate passed.
- [x] Release-readiness report shows overall `PASS`.
- [x] Soak report is present or skip risk is explicitly accepted.
- [x] `MainWindowTest` covers advanced panel close/shrink behavior.

## Locked Next Workstream

Dual-stream room quality rollout is now locked and tracked in:

- `native-qt/qa/DUAL_STREAM_PLAN.md`
- `native-qt/qa/DUAL_STREAM_TEST_REQUIREMENTS.md`

These are feature-specific implementation and validation gates, separate from the current baseline release checklist above.

## Latest Validation Evidence (2026-02-23)

- Release readiness report (QSV profile): `native-qt/qa/reports/release-readiness-20260223-074531.md` (`Overall: PASS`).
- Soak report (QSV profile): `native-qt/qa/reports/soak-2026-02-23T13-51-42-842Z.md` (`Result: PASS`).
- Fast gate report (QSV profile): `native-qt/qa/reports/release-readiness-20260223-085308.md` (`Overall: PASS`).
- Viewer churn report (QSV profile): `native-qt/qa/reports/viewer-churn-2026-02-23T13-59-04-301Z.md` (`Result: PASS`).
- Bitrate smoke report (QSV profile): `native-qt/qa/reports/bitrate-smoke-2026-02-23T13-58-12-728Z.md` (`Result: PASS`).
- Dual requirements report: `native-qt/qa/reports/dual-quality-requirements-2026-02-23T13-57-02-018Z.md` (`Result: PASS`).
- Dual soak report: `native-qt/qa/reports/dual-quality-soak-2026-02-23T13-21-39-795Z.md` (`Result: PASS`).
