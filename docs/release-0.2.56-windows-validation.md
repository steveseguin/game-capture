# Game Capture 0.2.56 Windows release validation

Date: 2026-09-06. **Published:** [Game Capture v0.2.56](https://github.com/steveseguin/game-capture/releases/tag/v0.2.56). The supported release pipeline completed successfully.

## Production fix found during release validation

The exact OBS plugin v1.1.68 reproduced a room-mode ordering failure: its combined viewer-preferences message advertises `alpha_receive` before the publisher processes viewer initialization. The publisher subsequently enabled the reserved alpha section through the media-plan path without rebuilding the transport. OBS retained an inactive track and buffered color while waiting for matching alpha.

Commit `ece9fbd` makes alpha direction changes and track additions request a fresh transport from that media-plan path, including queued transitions. This covers capability-before-init as well as the existing init-before-capability path. The focused WebRTC gate checks direction-change reporting and idempotent repeated activation. The packaged room workflow then passed actual native OBS composition and browser decoding of advancing color and alpha.

## Review workflow corrections

- Bitrate unlock accepts a committed encoder replacement, with evidence scoped to the request. Preparing, superseded, failed, or stale replacements do not count.
- Signaling fixtures answer alpha activation on its current wire session, preserve the logical peer, and create a new browser peer connection when the publisher replaces its transport. They still require canonical media ordering and advancing color/alpha frames.
- Room browser probes attach to replacement data channels and wait for the current capability acknowledgment.
- NVIDIA validation observes a decoding browser and binds the GPU process sample to the publisher or its direct child, rather than sampling only a short startup encoder probe.
- The isolated OBS harness follows the observed pre-action connection during initial alpha activation; explicit transition evidence still defines the before/after boundary.
- Restored the missing staged v1.1.68 plugin payload in the isolated test installation and verified the loaded DLL hash.

The OBS screenshot-binding correction is local in `../ninja-plugin/scripts/obs-websocket-vdoninja-source-check.cjs` and copied into the isolated runtime. Other existing ninja-plugin working-tree changes were preserved; they are not part of the Game Capture release commits.

## Artifact identity

- Source commit: `0faccfb`.
- Packaged publisher SHA-256: `1e1abb1a14c792de8e06b54e057a4113e0fb7171863431280f630aad4c81b821`.
- Release manifest SHA-256: `609b094f64f248cc54a6edb4921cc0633499a150300b8b8964272bad1da0d706`.
- OBS plugin v1.1.68 SHA-256: `09975b30d4d4e917dd911dc8d971e19dbe08684a795dcb2668845da4f983f5cb`.
- Spout fixture SHA-256: `cfaf610a3498f4ac0aad4df25e1721b78b3f1fbd93c71a7ae89c4e5da44746ab`.

## Evidence

Reports are local, ignored artifacts under `native-qt/qa/reports/release-0.2.56/`.

- `release-first-pass.log`: failures that led to the review workflow corrections; interrupted before soaks because the release could not pass.
- `release-second-pass.log`: rebuilt production fix, all 20 CTest groups passed; interrupted to bind the final browser-probe correction into a fresh manifest.
- `release-third-pass.log`: supported final build/package/readiness/publish pipeline.
- `preflight-room/manifest.json`: passing exact-package room-alpha workflow with browser and native OBS evidence.
- `preflight-alpha/manifest.json`: passing opaque and 50% alpha native OBS workflows; loaded module identity and pixel evidence verified.
- `targeted-firefox-2/`, `targeted-lifecycle/`, `targeted-room-quality/`, `targeted-control/`, and `targeted-nvenc-2/`: focused workflow evidence while preparing the final package. These earlier executables are not the final artifact identity above.

## Final-package results

- All 20 CTest gate groups passed.
- Browser playback/password/room matrix, dual-viewer reloads, stream-ID collision, and data-channel controls passed.
- Auto, host-only, STUN-only, and TURN connectivity passed.
- Signaling and strict Control Center workflows passed in Edge, bundled Firefox, and the official Firefox binary.
- Room roles, churn, initialization fuzz, quality/codec requirements, native OBS room alpha, and opaque/50% alpha composition passed.
- Bitrate and encoder policy gates passed, including a decoding browser and publisher-owned NVIDIA process evidence.
- Room soak: **PASS**, 1,828 seconds, 309 cycles across four publisher runs, each passing on its first attempt. Report: `native-qt/qa/reports/dual-quality-soak-2026-09-07T02-57-40-897Z.md`.
- Browser soak: **PASS**, 1,801 seconds, 100 viewer iterations across five publisher runs, each passing on its first attempt. Report: `native-qt/qa/reports/soak-2026-09-07T03-27-42-657Z.md`.
- Overall release readiness: **PASS**, including the installer build gate. Report: `native-qt/qa/reports/release-readiness-20260906-220050.md`. This installer gate compiles the installer; it does not exercise a GUI upgrade.
- All four stable/versioned asset pairs passed byte-identity validation.
- GitHub's published SHA-256 digests and sizes match all eight validated local release assets. The checksum asset was also verified, the release is public/latest, and tag `v0.2.56` points to the validated source commit `0faccfb`. API evidence: `published-release.json` in the release report directory.
- VirusTotal submission was skipped because no API key was configured.
- `soak-process-samples.csv` records publisher private memory, working set, and handles. These samples provide resource observations, not a general proof against leaks.

The readiness script's legacy label says "seven-case transparency matrix", but its current wrapper runs `opaque-steady` and `half-steady`. Do not interpret that label as seven distinct cases. Earlier moving-alpha, fault-injection, reconnect, and ten-minute 1080p60 results are documented separately in `windows-followup-validation-2026-09-06.md`.

The intermittent local RTC fixture timeout remains unexplained; no retry or timeout increase was added to connection logic.
