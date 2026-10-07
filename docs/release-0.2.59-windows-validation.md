# Game Capture 0.2.59 Windows validation

The first candidate's completed validation is recorded below. Additional edge-case
testing on October 7 found a UI stall when another process holds the update-cache
lock. A correction and an expanded packaged workflow are being validated before
publication. The original readiness report retains its desktop-harness failure;
that workflow passed on rerun after the correction described below.

## Change

The existing installed-version footer now checks the public GitHub latest-release
API asynchronously. The checker requires explicit stable/non-draft metadata and a
stable semantic-version tag. It caches attempts, last-success metadata, and whether
the latest attempt succeeded in `%LOCALAPPDATA%\GameCapture\update-check.ini`.
An unsuccessful refresh preserves the last valid metadata but displays unavailable.
Cached metadata is reevaluated against the build's `APP_VERSION` on every launch.

The request has a 10-second connection/TLS deadline, a 15-second total deadline,
and a 1 MiB response limit. Redirects, cookies, and credential reuse are disabled;
authentication requests are aborted. Certificate verification remains enabled.
Shutdown cancels the request and disconnects callbacks. The Windows package must
include `tls/qschannelbackend.dll`.

## Validation approach

The new packaged workflow runs the actual GUI, reads its footer through Windows
accessibility, clicks Releases, checks the default browser's address, records the
loaded executable and TLS-backend paths, and observes Windows sound/Alert requests.
It samples window responsiveness and verifies normal process exit during a request.
Settings and the update cache are restored after each run.

Real GitHub HTTPS runs without a URL override. Fault cases redirect only the
update URL inside the validation process to local socket/HTTP/TLS fixtures using
Frida. The production binary has no endpoint override. These fixtures exercise
actual refused connections, malformed TLS, an untrusted certificate, stalled TLS,
stalled response bodies, HTTP errors, and oversized responses. HTTPS certificate
verification is never disabled, and the fixture certificate is never trusted.
Synthetic release metadata checks draft/prerelease handling and the available UI.

The older comparison packages contain the new checker with build versions 0.2.57
and 0.2.58. They are validation artifacts, not the previously published binaries,
which predate this feature.

## Completed update-check workflows

The final v0.2.59 package passed all 195 assertions in the packaged update workflow,
including the actual browser address, loaded package/TLS module paths, drafts,
both forms of prerelease exclusion, rate limits, malformed and oversized bodies,
refused connections, broken TLS, and certificate rejection. All 2,391 window
responsiveness samples passed. There were no sound requests or accessibility
Alert events. Connection and total deadlines measured 10.10 and 15.08 seconds.
Clean exit during an active connection and suppression of a new request after
restart both passed. Settings and the original update cache were restored.

Live GitHub verification used the older comparison build v0.2.57 to detect the
actual current stable release v0.2.58, click Releases, and confirm the browser
address `https://github.com/steveseguin/game-capture/releases`. The v0.2.58 comparison
build then reused that same cached metadata without a request and displayed
**You're up to date**. Separately, v0.2.59 reevaluated metadata saved by the v0.2.58
comparison build and displayed **You're up to date** without a new request.
This final upgrade/live/cache run passed all 29 assertions against the exact
signed executable identified below.

## Candidate identity

| Item | SHA-256 / commit |
| --- | --- |
| Source commit | `6b0ef1ea4ab90a3179306db2860ef03c55127042` |
| Packaged game-capture.exe | `ab3530de5c9c282351621538544805e5d86d6344953ee525dd3e676d396253e1` |
| Release artifact manifest | `da8589289dc60463f5151e2f79ebf63e65d7ebba1c3900724952f1379e1a7393` |
| Native source snapshot, 218 files | `cc60c5787357447312e014a70ea3b96ddfdb3af32c0ea3a51100e2ed17098f76` |

The package was created by `native-qt/qa/build-release.ps1`. Its dirty flag records
the pre-existing untracked v0.2.57 documentation file outside `native-qt`.
The signed installer, portable executable, ZIP, FFmpeg source-info archive, and
their stable aliases passed the package identity gates. This is not a
reproducible-build claim.

## Gates and publication

The initial fresh build, all 21 CTest groups, and QA entrypoint contracts passed.
These are gates, not end-to-end testing. The checker gates cover numeric version
ordering, development builds, prerelease identifiers, build metadata, cache
expiry/clock correction, persistence, timeouts, and cancellation. Installer
construction and versioned/stable package identity gates also passed.

The packaged playback matrix, viewer refresh/reconnect, stream-ID collision,
data-channel control, ICE modes/settings, signaling regressions, and Control
Center negotiation passed. Browser coverage includes Edge, Playwright Firefox,
and installed Firefox. Dual-quality roles, churn, initialization fuzzing, and
requirements passed. OBS room-alpha, opaque/half-transparent workflows, bitrate
presets, and the installed NVIDIA/Intel encoder policies passed. AMD hardware was
unavailable. The 30-minute dual-quality soak passed all four runs and 310 viewer
join/decode cycles (1,821 seconds). The separate playback soak passed five runs
and 101 viewer cycles (1,809 seconds). Neither soak needed a retry.

The first desktop workflow failed before capture because its Qt accessibility
lookup could not find the fixture below the visible source-list rows. A harness
correction scrolls the actual list to the fixture and checks that the click point
is within the viewport. Follow-up runs exposed dropdown-focus timing; the script
now waits for and clicks the actual source-mode option. The complete desktop
rerun passed all 22 assertions, including real H.264/VP9 browser decoding,
FFmpeg timeout recovery, UI responsiveness, source removal, sound/alert behavior,
tray behavior, and clean exit during a probe. Settings were restored.
These corrections change validation code only; the packaged executable remains
the exact artifact identified above. Failed reports are retained, including the
original readiness report's FAIL result; the successful desktop rerun closes
its only failed workflow.

GitHub currently reports zero registered self-hosted runners for this repository.
The QA Fast Gate workflow requires a self-hosted Windows X64 runner, so CI has not
been verified for this change. The [requested CI run](https://github.com/steveseguin/game-capture/actions/runs/37565028196)
is queued as of October 7, 2026. No v0.2.59 tag or GitHub release has been created.
The feature commit is available on branch `quiet-update-checks-0.2.59`; remote
`main` remains unchanged while CI is unavailable.

The unrelated local `docs/release-0.2.57-installer-closeout-2026-09-07.md` file is
preserved and excluded from this change.

## Local evidence

- `native-qt/build-update-final-package.log` and `build-update-readiness.log`.
- `native-qt/qa/reports/update-check-20261006-230206/results.json`.
- `native-qt/qa/reports/update-check-older-live/results.json` and `live-cache.ini`.
- `native-qt/qa/reports/update-check-live-upgrade/results.json`.
- `native-qt/qa/reports/update-check-0.2.59-final-upgrade/results.json`.
- `native-qt/qa/reports/desktop-ui-0.2.59-final/e5a48008-1299-44ac-9f2f-c38fe56d8f30/results.json`.
- `native-qt/qa/reports/release-readiness-20261006-230206.md`.
- `native-qt/qa/reports/dual-quality-soak-2026-10-07T04-03-53-136Z.md`.
- `native-qt/qa/reports/soak-2026-10-07T04-34-02-750Z.md`.
- `native-qt/qa/reports/release-0.2.59/local-assets.json` and `native-qt/dist/SHA256SUMS.txt`.

Earlier diagnostic attempts are retained. They exposed browser first-run overlays,
an off-screen footer, and a timestamp-unit error in the observer. The completed
final update workflow includes the corrections; it does not rely on the earlier
timeout assertions. Generated evidence and fixture certificates remain local.

## Additional network and cache validation

The expanded first-candidate run passed 473 assertions and all 4,921 UI
responsiveness samples. It adds actual DNS failure, HTTP 401/403/404/407/503,
redirect rejection, truncated and compressed oversized responses, a slow
trickling response, shutdown during a body download, forced process termination,
cached failed-refresh behavior, network recovery, clock correction, and a corrupt
cache. Evidence: `native-qt/qa/reports/update-check-extended-baseline/results.json`.

A separate busy-cache workflow reproduced an interface stall before the request
started: 104 of 179 responsiveness samples failed while another process held
Qt's INI lock. Evidence: `native-qt/qa/reports/update-check-busy-cache-baseline/results.json`.
Cache serialization now uses a private temporary INI file and atomic replacement,
preserving the cache format without waiting on the shared QSettings lock.
The final candidate will repeat the expanded workflows, busy/unwritable-cache
recovery, scheduled expiry, and immediate exit.

A single-use Windows CI runner is being prepared with a unique dispatch label.
The workflow also prepares the pinned FFmpeg bundle required by a fresh checkout.
