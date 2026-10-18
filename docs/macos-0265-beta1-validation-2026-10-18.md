# macOS 0.2.65 Beta 1 qualification — October 18, 2026 UTC

This experimental Apple Silicon beta incorporates the Windows 0.2.65 baseline and the Mac persistent microphone warning. The app is Developer ID signed, notarized and stapled, with complete matching source/build materials. **This is not a production-readiness or matched OBS/FFmpeg quality result.**

Runtime source: `de8a9410dc6f4ad9a7e65dd5ad5593e8ced74b15`. Executable SHA-256: `301dacfd38a6a4321ea548a68c674c499c7350fe651616968d020046a8f190aa`.

## Actual packaged application testing

On an Apple M1 with 8 GiB RAM and macOS 26.4.1:

- Both VT and x264 pass microphone loss with continued video/silence and a persistent warning, Stop/reselection/restart with recovered stereo, live mute/unmute, and restart with “No microphone” without a false warning. All eight GUI phases pass; owned inputs are removed and default devices stay unchanged. [GUI results](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/gui-workflows.json).
- The browser-downloaded, quarantined archive passes GUI settings/replacement/relaunch and upgrading the preceding 0.2.64 candidate to 0.2.65. [Delivery results](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/delivery.json).
- Upgrading the **public 0.2.64 Beta 2** preserves settings. Both encoders then load a private WHIP profile saved by Beta 2 without re-entering credentials, deliver authenticated video/stereo, and recover after a local server restart. The same Keychain reference survives and each owned QA entry is removed afterward. Archive replacement and the two-app-path credential migration are separate workflows. [Upgrade and saved-WHIP results](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/upgrade.json).

Separate delivered-app 60-second generated-window workflows requested **1280×720, 60 fps, 4 Mbps H.264**, with selected-window stereo:

| Encoder | Distinct received images/s, ten-second interval range | Timed intervals | Stereo checks |
| --- | ---: | ---: | --- |
| Apple VideoToolbox hardware | 59.79–60.00 | 6/6 pass | Pass |
| x264 software | 59.80–60.00 | 6/6 pass | Pass |

Both subsequently pass frame-rate changes, static content, resize and late viewing. VT quits normally; x264 deliberately loses its source and returns expected capture-failure exit 3. [Delivery evidence](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/delivery.json) includes twelve downloadable numeric frame/audio interval files, original report hashes and the exact browser/encoder binding. Source, app and receiver share one Mac; these short synthetic observations do not establish thermal limits, physical latency or perceptual quality.

## Fresh hosted Mac and Windows workflows

The same app/source archives pass fresh **macOS 14.8.9 ARM64 VM** [startup](https://github.com/steveseguin/game-capture/actions/runs/39111844483) and [x264 media](https://github.com/steveseguin/game-capture/actions/runs/39111846893) runs. Startup covers two deployed-app launch/diagnostics/refusal/quit workflows. The 640×360/30 fps/no-audio media run receives 140 moving, 61 resized and 52 late-viewer identities, with zero identity-read failures or row disagreements, then exits 3 after deliberate source loss. Those phases deliver 23.29, 15.24 and 17.28 distinct images/s; **this does not establish sustained 30 fps**. [Startup evidence](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/hosted-startup.json), [media observations](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/hosted-media.json).

[Windows packaged run 39111558348](https://github.com/steveseguin/game-capture/actions/runs/39111558348) passes 70 GUI/shutdown assertions, 250,328 complete concurrent snapshot reads with no incomplete JSON, and actual Windows Graphics Capture/software-H.264 moving/static/resize/late-viewer/source-loss workflows. It uses a Windows Server VM with Microsoft Hyper-V Video. Physical Windows GPU encoders, audio and consumer installers remain outside this coverage. [Windows evidence](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/windows-packaged.json).

The [initial Windows attempt](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/windows-initial-packaging-gate.json) stopped before application testing because the QA runner requested 0.2.64 after building 0.2.65. The package gate correctly rejected the mismatch. QA revision `d34f79e` now reads the CMake project version for both packaging and archive selection; it leaves runtime code unchanged.

## Source and distribution gates

The microphone GUI workflows ran before notarization; subsequent downloaded-app and hosted workflows use the stapled archive with the same executable hash. All 39 Mac application units were rebuilt. Relative to the preceding warning runtime `aac5547b`, capture, encoder, audio, UI, signaling, build-helper and resource trees match; the CMake project version changes from 0.2.64 to 0.2.65. [Source comparison](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/integration-source-gates.json). No VDO.Ninja API or signaling command was added.

Apple accepted notarization `e37ba14b-e6b2-4af7-afc6-882ed6589cc4`; stapling, strict signatures and Gatekeeper pass. Source packaging verifies 10,652 payloads, 12 native repositories, eight upstream archives and all 16 bundled binaries. Uploaded app/source/checksum assets were downloaded and matched their hashes. These are gates, separate from application testing. [Release integrity](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/release-integrity.json).

## Publication and remaining limits

Published as [macOS 0.2.65 Beta 1 — Experimental](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.65-beta.1). A real browser downloaded the public GitHub asset with its expected SHA-256 and original quarantine preserved. The extracted app passed GUI settings/replacement/relaunch, then separate sixty-second VT/x264 video/stereo workflows and their subsequent control/static/resize/late-viewer checks. [Public-download outcomes](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/public-delivery.json) and [publication receipt](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/publication.json). Windows 0.2.65 remains the latest stable release; earlier Mac releases and their assets are preserved.

Keep this release experimental. Physical macOS 14.2, fresh permission transitions, physical camera/microphone/USB/Bluetooth behavior, sleep/wake, display/audio-route changes and VoiceOver remain unqualified. The hosted Mac result excludes hardware VT and audio. Matched independent OBS/FFmpeg/gameplay quality, physical A/V latency and broader sustained load are not established here.

Earlier artifacts' endurance/latency results remain bound to their binaries. The [preceding VFR report](https://github.com/steveseguin/game-capture/blob/main/docs/macos-x264-vfr-2026-10-18.md) retains unresolved hosted-motion, alpha-pixel, recorder-clock and abrupt-viewer-close findings; the current short passes do not erase them. [Evidence manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta1/evidence-manifest.json).
