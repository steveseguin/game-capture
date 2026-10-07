# Game Capture 0.2.59 Windows validation

The frozen release package passed the complete
[release-readiness workflow in CI](https://github.com/steveseguin/game-capture/actions/runs/37584155023),
including the desktop, update-check, browser, OBS, encoder, and both 30-minute
soak workflows. Installer construction and package identity gates also passed.

## Shipped behavior

The existing version footer uses the build's `APP_VERSION` and checks this
project's public GitHub latest-release API asynchronously, about once per day.
Successful checks show **You're up to date** or **New version available: vX.Y.Z**
with a **Releases** link to `https://github.com/steveseguin/game-capture/releases`.
Unknown results show **Update check unavailable**.

Drafts, GitHub prereleases, and prerelease tags marked stable are rejected.
Numeric semantic-version comparisons ignore build metadata and do not recommend
an older stable release to a development build with a newer version core.

Attempts and minimal valid release metadata persist in
`%LOCALAPPDATA%\GameCapture\update-check.ini`. A failed refresh retains valid
metadata but does not present it as proof of being current. Cached metadata is
reevaluated against the installed version after an upgrade. Cache writes use a
private temporary INI and atomic replacement to avoid blocking on a shared
QSettings lock; reads are bounded to 16 KiB.

The HTTP client has a 10-second connection/TLS deadline, a 15-second total
deadline, a 1 MiB response limit, and cancellation on exit. Redirects, cookies,
and credential reuse are disabled; authentication requests are aborted. HTTPS
certificate verification stays enabled. There are no update popups, sounds,
downloads, or installation. Requests contain no settings, credentials, or media.

Game Capture is a standalone Qt application. The shipped package's
`tls/qschannelbackend.dll` was loaded and used successfully for real GitHub HTTPS;
the OBS Qt HTTPS-backend limitation does not apply to this runtime.

## Exact package identity

| Item | SHA-256 / commit |
| --- | --- |
| Packaged source commit | `d51bb5f808e1fe14a69c8370569d48d7a7ffe72b` |
| Packaged game-capture.exe | `2118f31581a03d216e30029e8d32091262bf1c1ee3497c43f723de2e2a9d5ebd` |
| Release artifact manifest | `47fe8a0e65790b7a32f00b70662ebade4df2690c4da37fa126ad964776bbec94` |
| Native source snapshot, 218 files | `c4e93d3825709e88c6151a715a567aa04369e7c7818722d14f380b6881e8ab59` |

`native-qt/qa/build-release.ps1` produced the package. Later CI-workflow and
documentation commits leave this native source snapshot unchanged. Full CI uses
this frozen package directly, verifying its independently recorded manifest hash.
The manifest's dirty flag records the pre-existing untracked v0.2.57 document
outside `native-qt`; that unrelated file is preserved and excluded from the release.

The installer, portable executable, ZIP, FFmpeg source-info archive, and their
fixed-name aliases pass the package identity gates. The EXEs carry the existing
project signing certificate and a DigiCert timestamp. Windows reports the
project's self-signed root as untrusted; this is not a publicly trusted-signature
or reproducible-build claim. VirusTotal submission was skipped because no key
was available.

## Packaged application testing

The final executable passed all **592 update-workflow assertions** and all
**5,680 window-responsiveness samples**, with no sound requests or accessibility
Alert events. The workflow verifies the actual loaded executable and Schannel
module paths, reads the visible footer, clicks its real Releases link, and checks
the default browser's address. Settings and the original update cache are restored.

Real GitHub requests run without an endpoint override. Fault cases redirect only
the update URL in the validation process to actual socket, HTTP, and TLS fixtures
using Frida. The production app has no configurable update endpoint, and the
workflow does not mock QNetworkReply or disable certificate verification.
The fixture certificate is never trusted, and machine-wide networking is unchanged.

Coverage includes:

- DNS lookup failure, connection refusal, malformed TLS, and an untrusted certificate.
- HTTP 401/403/404/407/429/503, an empty response, and rejected redirects.
- Malformed JSON, incorrect field types, invalid tags, drafts, both forms of
  prerelease exclusion, matching versions, and older releases.
- Oversized declared, streamed, and compressed responses; truncated responses;
  stalled TLS; stalled bodies; and a slow trickling body.
- Quit before the first request, quit during connection and body transfer,
  forced termination, and suppression of repeated requests on restart.
- Cached success and failure, expired-success refresh failure, preservation of
  last-valid metadata, later network recovery, daily timer expiry, clock
  correction, corrupt and oversized caches, held cache locks, unwritable caches,
  and recovery after writes become possible again.

Measured connection timeout: **10.01 seconds**. Measured total timeout:
**15.08 seconds** for a stalled body and **15.03 seconds** for a trickling body.

The final package also passed **22 desktop-workflow assertions**, including real
H.264/VP9 browser decoding, source selection/removal, FFmpeg timeout recovery,
responsiveness, tray behavior, and clean exit during a probe.

Playback, reconnect, stream-ID collision, data-channel controls, ICE modes and
settings, signaling, and Control Center negotiation passed. Browser coverage is
Edge, Playwright Firefox, and installed Firefox. Dual-quality roles, churn,
initialization fuzzing, and requirements passed. OBS room-alpha and opaque/half-
transparent output workflows passed with artifact hashes stable throughout.
Bitrate presets and Auto, software, NVIDIA, and Intel encoder policies passed.
AMD hardware was unavailable. The dual-quality soak passed all four runs and
311 viewer join/decode cycles over 1,825 seconds. The separate playback soak
passed five runs and 101 viewer iterations over 1,804 seconds. Neither soak
needed a retry.

## Upgrade and publication checks

The final package passed 33 assertions covering metadata saved by an older
comparison build, a fresh real GitHub check, and a cached restart. On upgrade it
displayed **You're up to date** without a new request. The older comparison builds
contain this checker with build versions 0.2.57 and 0.2.58; they are validation
artifacts, not the previously published binaries, which predate this feature.

Earlier live verification used the 0.2.57 comparison build to detect GitHub's
stable v0.2.58 and open the actual Releases overview. The 0.2.58 comparison build
then reevaluated that same cache as current without a request. A final published-
release/download verification will follow publication of v0.2.59.

All 21 CTest groups and the source-lifetime, QA-entrypoint, artifact-identity, and
analyzer contracts pass. These are gates, not end-to-end testing. The checker
gates cover numeric ordering, development builds, build metadata, persistence,
clock correction, timeouts, cancellation, and held/oversized cache files.

## Issues found and corrected

Expanded packaged testing exposed a real UI stall while another process held
Qt's shared INI lock: 104 of 179 responsiveness samples failed before the request
even started. Private serialization plus atomic replacement fixes that stall.
The final locked- and unwritable-cache workflows remain responsive and recover.

An earlier desktop harness could select an off-screen source row or race a Qt
dropdown. It now scrolls to the actual row and waits for the visible menu option.
The corrected workflow passes on the final package.

Preparing CI exposed three environment issues: interactive Windows crash
reporting delayed a deliberate-abort gate; Node 20 discovered only a nonexistent
localhost DNS server; and a Windows PowerShell child inherited PowerShell 7's
incompatible module path. CI now uses noninteractive CTest, Node 22, and Windows
PowerShell for the QA entrypoint. Failed and superseded reports are retained;
their results have not been rewritten as passes.

## Evidence

- [Full release-readiness CI](https://github.com/steveseguin/game-capture/actions/runs/37584155023), including its uploaded reports.
- `native-qt/qa/reports/update-check-final-release/results.json` and UI screenshots.
- `native-qt/qa/reports/desktop-ui-final-release/results.json`.
- `native-qt/qa/reports/update-check-final-hardened-upgrade/results.json`.
- `native-qt/qa/reports/update-check-busy-cache-baseline/results.json` and `update-check-busy-cache-fixed/results.json`.
- `native-qt/qa/reports/ci-node20-dns-failure/` and `ci-powershell-module-failure/`.
- `native-qt/build-update-final-hardened-package.log` and `build-update-frozen-release-ci.log`.
- `native-qt/qa/reports/release-0.2.59/local-assets.json` and `native-qt/dist/SHA256SUMS.txt`.
