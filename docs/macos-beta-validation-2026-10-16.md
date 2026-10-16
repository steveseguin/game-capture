# Mac beta qualification — October 16, 2026

The Apple Silicon release remains **experimental**. This work resolves the earlier missing-RTMP-audio finding and extends real packaged application coverage. It does not establish full production readiness or Windows feature parity.

## Artifact and environment

- Release: [macOS 0.2.62 Beta 1](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.62-beta.1).
- Signed ZIP SHA-256: `2e51db7ef109e01d7d14b6787fd8d7a6b8bd14e05e725d7185e0cf0fbdec306b`.
- Extracted executable SHA-256: `25b4b113702c82a46056095350bbb01c3567c50998fecc066b49407335220c43`.
- Apple M1, 8 GiB RAM, macOS 26.4.1. No application binary, bundled dependency, signing identity or release asset changed.
- External-output workflows use an owned OBS virtual-camera fixture, BlackHole stereo input, a local MediaMTX 1.21.2 server, and independent FFmpeg receivers. They do not exercise physical cameras/microphones or remote production services.

## RTMP finding resolved

The original receiver recording declared an AAC stream but contained no audio packets. A simultaneous comparison isolated the failure to FFmpeg 7.1.1's RTSP stream-copy recorder:

| Receiver path, same signed publisher | Recorded AAC packets in 12 seconds | Decoded stereo |
| --- | ---: | --- |
| FFmpeg 7.1.1 RTSP, original recording options | 0 | Unavailable |
| FFmpeg 7.1.1 direct RTMP | 563 | Correct |
| FFmpeg 9.0.2 RTSP | 563 | Correct |
| FFmpeg 7.1.1 RTSP, audio-only `-copyinkf:a` | 563 | Correct |

The failing receiver actually read 565 AAC packets. A separate packet probe found 188 audio packets without the key flag. [FFmpeg 7.1.1's stream-copy startup code](https://github.com/FFmpeg/FFmpeg/blob/n7.1.1/fftools/ffmpeg_mux.c) rejects initial packets without that flag unless initial non-key packets are allowed. Applying the documented [`-copyinkf`](https://ffmpeg.org/ffmpeg.html#Advanced-Video-options) option to **audio only** preserves these valid AAC packets while retaining the video keyframe requirement.

Both Mac mux recording harnesses now use that audio-only option. Packet presence, timestamp, decoded-frame, channel separation, silence and lifecycle assertions are unchanged. The publishing harness also supports direct RTMP reception with `--protocols=rtmp --receiver-protocol=rtmp`, and records the receiver version and probe hash.

This was a recording-path failure, not evidence that the app stopped sending RTMP audio. The original failed runs are retained. The release notes and website warning were corrected without replacing the beta download.

## Completed packaged workflows

| Workflow | Encoders | Result |
| --- | --- | --- |
| RTMP publication → direct RTMP reception | VT, x264 | Passed |
| RTMP publication → RTSP reception | VT, x264 | Passed |
| Encrypted SRT publication → RTSP reception | VT, x264 | Passed |
| RTSP TCP and RTSP UDP publication → RTSP reception | VT, x264 | Passed |
| Direct UDP and RIST publication/reception | VT, x264 | Passed |
| Window suspension/restoration with existing and late receivers | RTMP/VT, SRT/x264 | Passed |
| 720p60 window/application-audio, new per-interval audio observer | VT, x264; 30 seconds each plus controls | Passed |

The fourteen camera/input publishing cases check moving H.264 video and stereo AAC, static video and silence, resumption, VT server-restart recovery where applicable or late reception, and clean publisher/helper shutdown. The window-suspension cases additionally verify decoded background/image content and audio during hide/restore: approximately 29 seconds of existing-viewer audio and 13 seconds of late-viewer audio, with no silent 100 ms blocks or clipped samples.

The window endurance harness now samples three seconds of decoded audio during **every ten-second video interval**, checking stereo, expected source tones and exclusion of unrelated application audio. Raw observations remain hash-bound in compressed evidence. This extends the earlier end-only audio check; it is not continuous audio monitoring or calibrated lip-sync measurement.

### Endurance finding remains open

The thirty-minute VT/application-audio attempt failed during its 72nd ten-second interval, after 710 seconds of completed observations. The receiver rejected a reversed/corrupt fixture identity or excessive identity gap. All 71 completed intervals had passed video cadence and sampled stereo/isolation checks, but **the complete workflow failed** and did not reach its subsequent controls. Encoder failures, timeouts and send failures remained zero; that does not explain or waive the received-output failure.

The original runner did not retain the rejected interval's pixels. It now saves rejected frame images and scanlines, source identities, presentation observations, audio, and before/after diagnostics in a hash-bound compressed failure artifact before exiting. Acceptance thresholds are unchanged. An optional `--fixture-start-id` allows replaying a selected identity range.

A three-minute replay starting at identity 42000 passed all eighteen intervals and the subsequent functional controls. That result does not reproduce or resolve the original failure. A separate fifteen-minute reproduction then passed all ninety intervals and subsequent functional controls: 59.595–60.091 distinct decoded fps, 17 ms worst interval p95 frame gap, and zero encode failures/timeouts/send failures. All 2,700 sampled audio spectra were retained, and the compressed payload hashes and summary values were independently checked. Publisher RSS ranged from 87.2 to 117.0 MiB. **The original failure remains unresolved**, despite these later passes; this is not a completed thirty-minute audio qualification.

The failure recorder was then exercised with an explicitly modified diagnostic fixture that reverses its source identity once. The signed app delivered that reversal, the runner rejected `848 → 649` at the intended threshold, and the saved 1280×720 image visibly shows fixture 649. Source identities, scanline, audio and diagnostics were retained and their hashes checked. This is an expected negative control, not another application defect or a passing endurance run.

## Evidence identifiers

Raw recordings, logs, private local-control files and interval payloads remain in local `native-qt/qa/reports/`; they are not published wholesale. The principal report identifiers are:

- Receiver comparison: `macos-rtmp-investigation-2026-10-16/92641233-5cbc-48d6-9af9-16b636801738`.
- RTMP via RTSP: `macos-rtmp-corrected-recorder/62976911-b577-4f9d-8d00-3689c78dde77`.
- Direct RTMP: `macos-rtmp-direct-reception/2ac8ad5e-5a94-4687-a148-87494b1cf92a`.
- Other mux outputs: `macos-signed-mux-qualification/a0049c74-56ce-4135-9256-d8705a68bacb`.
- Window suspension: `macos-signed-mux-audio-suspension/7ea5e627-cf6c-4ae2-b7de-641ee106c73c` and `858dc112-cabf-4c22-a33f-2eed2730ad0d`.
- Per-interval audio validation: `macos-signed-audio-intervals/1f4c0e9f-9aef-43fc-8244-0e4938668d00`.
- Failed long VT/audio run: `macos-signed-vt-audio-endurance/e33f0a5b-8b15-414e-b9bf-e7c903887817`.
- Three-minute identity replay: `macos-signed-identity-replay/abd735ac-1a59-40fe-9726-2988cb9cd645`.
- Fifteen-minute reproduction: `macos-signed-vt-audio-reproduction/07f4dfc6-0abb-465f-a2da-940ed9abaa08`.
- Expected diagnostic rejection: `macos-observer-negative-control/003f3da2-e843-4432-b5c6-8434912ebbd7`.

## Reproduction

The [QA changes](https://github.com/steveseguin/game-capture/commit/24b700dbcf5fb40bd4e723efdc114ee2b0f4b30d) are on `macos-production-readiness`, based on the beta tag; the Mac runtime remains separate from Windows production. Use that branch, the signed, extracted beta app and compiled fixture helpers; choose a fresh report category for each attempt. Reports receive a unique identifier automatically. For the window/audio endurance workflow on this machine:

```sh
node native-qt/e2e/macos-window-publish.js \
  '--app=/path/to/Game Capture.app' \
  --reports=native-qt/qa/reports/macos-window-audio-repeat \
  --encoder=videotoolbox --performance-seconds=1800 \
  --audio=selected-window --compact-performance-report=true \
  --source-ui-helper=native-qt/build-macos-arm64/bin/macos-ui-control
```

Use `--encoder=x264` for software encoding. A targeted identity replay additionally accepts `--fixture-start-id=42000`; shortening that replay is diagnostic only. The source helper explicitly activates the owned fixture browser. Keep other capture workflows stopped during performance observation.

## Remaining production work

- Diagnose the rejected identity in the first VT/audio endurance attempt; complete the intended thirty-minute signed VT and x264 runs with audio. The later fifteen-minute VT pass does not close that finding.
- Fresh-machine browser download, quarantine/Finder launch, permissions and upgrade/replace workflows; execution on the minimum advertised macOS and another Apple Silicon Mac.
- Physical device hotplug/busy recovery, permission denial/revocation, sleep/wake and display/audio-device changes.
- Calibrated A/V synchronization and long-run drift; broader sustained gameplay, resolutions, room load and receiver/network coverage.
- Remote services and trusted RTMPS, plus remaining advanced-feature qualification. Local protocol success is not a production-service interoperability claim.
- Packaged Windows regression of the port's shared-code changes before those changes enter a future Windows release. Existing Windows v0.2.63 production binaries are unchanged.

Syntax, source/hash checks, signing verification and secret scans are separate gates. The media workflows above run the shipped app and verify actual received output.
