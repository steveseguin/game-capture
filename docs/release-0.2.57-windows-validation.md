# Game Capture 0.2.57 Windows release validation

Published September 7, 2026: https://github.com/steveseguin/game-capture/releases/tag/v0.2.57

This is a maintenance release containing version metadata, validation tooling, and documentation changes. Production media behavior is unchanged from 0.2.56. The release pipeline completed successfully against the exact packaged Windows executable, then published the installer, portable executable, ZIP package, FFmpeg source/build information, and four stable aliases.

## Artifact identity

| Item | SHA-256 / commit |
| --- | --- |
| Release source (clean checkout) | `874ce4e7150f96f859c7d5d3777451cbc13c85a5` |
| Packaged game-capture.exe | `ffe317a2a0a1234d6af7c920b64509c90300c631898f10da29964aeb88575166` |
| Release artifact manifest | `b94b48dbfe4eb3184030d2510ac97fb720da151dd1361836d368c13e8075d1fe` |
| OBS plugin v1.1.68 | `09975b30d4d4e917dd911dc8d971e19dbe08684a795dcb2668845da4f983f5cb` |
| OBS 32.2.2 | `e79066670cd8e8b95662f4cd417c4fa6f5b0c77e856a7b41c7de0e00059ba6f2` |
| Spout fixture | `cfaf610a3498f4ac0aad4df25e1721b78b3f1fbd93c71a7ae89c4e5da44746ab` |

Host adapters: NVIDIA TITAN RTX (driver 32.0.16.1047) and Intel Graphics (32.0.101.6881). AMD hardware was unavailable. OBS ran in an isolated portable installation.

## Actual packaged-application workflows

- Browser playback/password/room matrix, dual-viewer refresh, stream-ID collision handling, and data-channel controls passed.
- ICE Auto, host-only, STUN-only, and relay-only connectivity passed; packaged ICE setting preservation passed.
- Signaling/recovery and strict Control Center room workflows passed in Edge, bundled Firefox, and the separately extracted official Firefox binary. Signaling coverage included transport recovery, viewer removal/re-addition, and natural publisher timeout with media active.
- Dual-quality mixed roles, churn, initialization, and requirements workflows passed.
- Spout input to native OBS passed opaque and 50% transparency output checks. Native OBS room-alpha and browser-alpha workflows passed with executable/plugin identity binding.
- Encoder policy checks passed for Auto, software, NVIDIA, and Intel on the available adapters; unsupported explicit codec handling passed.

The readiness report retains an outdated “seven-case” alpha heading. Its manifest actually requires two steady cases, `opaque-steady` and `half-steady`; this release does not claim seven transparency cases were rerun. Room-alpha coverage is recorded separately.

## Sustained workflows

| Workflow | Actual duration | Completed work | Result |
| --- | --- | --- | --- |
| Dual-quality room soak | 1,825 seconds | 307 cycles across four publisher sessions | PASS; all attempt 1 |
| Browser playback soak | 1,806 seconds | 100 iterations across five publisher sessions | PASS; all attempt 1 |

Browser batches contained 24, 24, 24, 24, and 4 iterations. The soak report's “Run retries: 1” is the configured retry allowance; its attempt table confirms no retry was used. Likewise, its top-level “Iterations: 0” represents the duration-driven configuration, not completed iterations.

## Gates and publication verification

Fresh Release build, all 20 CTest groups, QA/static contracts, artifact bindings, installer construction, and four versioned/stable alias byte-identity comparisons passed. These are gates, separate from the application workflows above. An initial run stopped after the QA documentation contract found an outdated README package path; the path was corrected, committed, and the complete pipeline was rerun successfully.

After publication, all eight uploaded binaries/archives matched local SHA-256 hashes and sizes using GitHub's asset digests. Uploaded `SHA256SUMS.txt` was also hash-verified. The public stable tag resolves to the source commit above and is the latest release. VirusTotal submission was skipped because no API key was configured.

## Scope and remaining limitations

The [prior 24-case encoder/settings review](obs-encoder-settings-validation-0.2.56-2026-09-07.md) used v0.2.56; the entire matrix was not rerun for this metadata/tooling release. Explicit NVENC/QSV 4K30 performance remains unresolved. Native OBS plugin v1.1.68 supports H.264/VP9 rather than HEVC/AV1. No new claim is made for AMD encoding, third-party Spout producers, HDR, natural-game image quality, lip sync, or interactive installer upgrade behavior.

## Local evidence

Paths below are relative to the repository; generated reports remain local rather than being bundled with source:

- `native-qt/qa/reports/release-0.2.57/release.log` and `first-pass.log`.
- `native-qt/qa/reports/release-readiness-20260907-105356.md`.
- `native-qt/qa/reports/release-room-alpha-20260907-105356/manifest.json`.
- `native-qt/qa/reports/release-full-alpha-20260907-105356/manifest.json`.
- `native-qt/qa/reports/dual-quality-soak-2026-09-07T15-50-43-560Z.md`.
- `native-qt/qa/reports/soak-2026-09-07T16-20-49-963Z.md`.
- `native-qt/qa/reports/release-0.2.57/soak-process-samples.csv`.
- `native-qt/qa/reports/release-0.2.57/uploaded-asset-verification.json`, `published-release.json`, and `SHA256SUMS.txt`.
