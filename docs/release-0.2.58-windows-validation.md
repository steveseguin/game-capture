# Game Capture 0.2.58 Windows release validation

The packaged v0.2.58 application passed the complete release-readiness run on
September 25, 2026, including both 30-minute soaks.
[v0.2.58 is published](https://github.com/steveseguin/game-capture/releases/tag/v0.2.58)
and verified as the latest stable release.

## Changes and coverage gap

Routine status changes used `QAccessible::Alert`, which invokes the Windows
system sound. Earlier coverage checked label state and media output without
observing the desktop's Windows sound requests. The packaged baseline reproduced
five sound requests during source selection/removal. See the
[investigation](windows-alert-sound-investigation-2026-09-24.md).

This release uses accessibility announcements, moves FFmpeg settings/startup
validation off the UI thread, reports probe errors, rejects stale results,
keeps diagnostics from waiting for a probe, and limits the tray reminder to once
per app session. Packaged desktop validation is now required by release readiness.

## Artifact identity

| Item | SHA-256 / commit |
| --- | --- |
| Release source | `da951d5ae832e294665cf3fd1ddd1c73ff66f2e2` |
| Packaged game-capture.exe | `ab31a920d568198129f442c4d718d0c2a5b5f724c33506567b3e7ed448e52544` |
| Release artifact manifest | `0f10f79775115ba22c08767eacea943af88eab5d79fcb56ed2ba4fc311f733db` |
| Native source snapshot, 214 files | `0a6d024729bfb75ac6df5b87e45424c45ae51655d9cccba5e62b914d02130bed` |

The manifest's dirty flag records a pre-existing untracked v0.2.57 documentation
file outside `native-qt`, which was preserved. The native source snapshot is
bound to the package; this is not a reproducible-build claim.

## Completed packaged-application workflows

- Desktop source selection, refresh, background source disappearance, and
  accessibility announcements: all 22 desktop checks passed, with zero sound
  requests, zero Alert events, 16 Announcement events, and all 247 UI
  responsiveness samples passing.
- Slow FFmpeg settings validation, diagnostics during validation, startup
  waiting on a fresh probe, timeout feedback, stale settings results, and quit
  during an in-flight probe. GUI Start/Stop and browser playback passed for
  H.264 and VP9. The desktop workflow restored saved application preferences.
- Local MCP automation: discovery, sources, reporting, H.264/VP9 playback,
  transport recovery, stop, export, quit, and owned/attached process cleanup.
- Browser playback/password/room matrix, two-viewer refresh, stream-ID
  collision handling, and data-channel controls.
- ICE Auto, host-only, STUN-only, and relay-only connectivity, plus packaged
  settings defaults and preservation.
- Signaling, recovery, and strict Control Center workflows in Edge, Playwright
  Firefox, and a separately extracted official Firefox executable.
- Dual-quality roles, churn, initialization, and requirements workflows.
- Native OBS room alpha and the opaque/50% transparency cases. The readiness
  script's historical "seven-case" heading does not mean seven cases ran.
- Bitrate presets and Auto/software/NVIDIA/Intel selection. The NVIDIA and Intel
  runs used `FFmpeg h264_nvenc` and `FFmpeg h264_qsv`; the unsupported explicit
  codec case failed visibly as required.

## Validation issues corrected

The startup responsiveness check now uses a fresh helper path and starts while
settings validation is in progress, avoiding a cached timeout that would hide a
blocking preflight.

An initial ICE settings run missed a startup log record because the old check
used the previous file length after the logger truncated and rewrote that file.
Each application launch now has its own log directory. All three actual settings
cases passed after that correction and in the complete rerun.

Control Center mute acknowledgements arrived correctly, but queued capability
warnings blocked the next assertion. The workflow now verifies and dismisses
the specific unsupported per-peer quality warning, waits for its queue to clear,
and requires fresh mute/unmute replies plus advancing video. Unrelated modal
text still fails. All three browser workflows passed after that correction.
Per-peer Low/High quality selection remains unsupported; the hosted director
can reapply that setting during other controls and display its warning.

## Sustained workflows

| Workflow | Actual duration | Completed work | Result |
| --- | --- | --- | --- |
| Dual-quality room soak | 1,825 seconds | 308 cycles across four publisher sessions | PASS; all attempt 1 |
| Browser playback soak | 1,804 seconds | 101 playback iterations across five publisher sessions | PASS; all attempt 1 |

## Publication verification

The release tag identifies `da951d5ae832e294665cf3fd1ddd1c73ff66f2e2`, matching
the package's source commit. The code and completed validation documentation
were pushed to `main` before publication.

All eight versioned/stable release assets and `SHA256SUMS.txt` matched their
local SHA-256 hashes after upload, before the draft was published. All four
stable `releases/latest/download/` links returned HTTP 200 after publication.
The release is public, is not a prerelease, and is GitHub's latest release.

## Validation dependency follow-up

After the initial push, GitHub reported 18 dependency advisories for the new
desktop workflow's Pillow 11.3.0 pin. The validation requirements on `main` now
use [Pillow 12.3.0](https://pypi.org/project/pillow/12.3.0/), the patched version
identified by those advisories. The complete 22-check desktop workflow passed
again against the published executable, including H.264/VP9 playback, zero
routine sound requests, responsiveness, tray behavior, and clean quit. Saved
application preferences were restored.

Pillow and the Python validation environment are absent from the Windows
package. This follow-up changes the validation tooling on `main`; the release
tag and published application assets retain the identities recorded above.
Use current `main` when setting up the desktop validation tools.

## Gates and limitations

The fresh Release build, 20 CTest groups, QA contracts, artifact bindings,
versioned/stable alias comparisons, and installer construction passed as gates.
Application workflows above provide end-to-end testing. The complete readiness
report returned Overall PASS.

Artifacts use the existing project signing certificate. This Windows host
reports an untrusted root for that certificate, as it did for v0.2.57.
The optional VirusTotal submission was skipped because no API key was configured;
this release report does not claim a VirusTotal scan.

No new claim is made for AMD hardware, clean Windows installation, installer
upgrade/uninstall, screen-reader speech, the older-Qt accessibility fallback,
HDR, game image quality, or lip sync. Sound checks observe Windows API requests;
they are not a microphone recording. The prior 4K encoder-performance limits
remain documented in the v0.2.56 encoder/settings review.

## Local evidence

- `native-qt/qa/reports/release-0.2.58/readiness.log` and `mcp.log`.
- `native-qt/qa/reports/release-readiness-20260924-225518.md`.
- `native-qt/qa/reports/desktop-ui-20260924-225518/`.
- `native-qt/qa/reports/release-room-alpha-20260924-225518/manifest.json`.
- `native-qt/qa/reports/release-full-alpha-20260924-225518/manifest.json`.
- `native-qt/qa/reports/dual-quality-soak-2026-09-25T03-54-07-407Z.md`.
- `native-qt/qa/reports/soak-2026-09-25T04-24-12-150Z.md`.
- `native-qt/qa/reports/release-0.2.58/runtime-process-samples.csv`.
- `native-qt/qa/reports/release-0.2.58/uploaded-asset-verification.json` and
  `stable-download-verification.json`.
- `native-qt/qa/reports/release-0.2.58/desktop-pillow-12.3.0/9de41132-e23b-4928-8a1c-7dce591ccf7e/results.json`.
- Earlier failed runs and isolated correction checks are retained under
  `native-qt/qa/reports/release-0.2.58/`.

Generated evidence and private local-control discovery files remain local.
