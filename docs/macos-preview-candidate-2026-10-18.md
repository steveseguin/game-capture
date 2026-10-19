# Mac cursor and preview candidate — October 18, 2026

**Subsequent delivery:** this report records pre-release qualification. The same executable is now notarized and published as [experimental 0.2.65 Beta 2](macos-0265-beta2-validation-2026-10-18.md).

This signed Apple Silicon candidate fixes system-cursor capture, oversaturated previews and missing source thumbnails. **It is experimental and has not been notarized or released.** The public Mac 0.2.65 Beta 1 and production Windows release are unchanged.

Runtime source: `ea1c552c6c833fecc16914e18710a589a6bb2db1`. Executable SHA-256: `2a6354f12b92ac1d8ef2a415c76316ea8452b040503087c1b8ec716be69ad1b0`.

## Changes

- Mac window capture excludes the system cursor, matching Windows. The same ScreenCaptureKit configuration serves startup, live capture enlargement and screenshot previews.
- The Mac UI explicitly uses an sRGB surface. Previously, Cocoa inherited the display profile and interpreted sRGB preview pixels in a wider gamut. The bundled Qt 6.9.3 Cocoa implementation reads the surface color space during view initialization; [Qt's surface-format API](https://doc.qt.io/qt-6/qsurfaceformat.html#setColorSpace) supplies that preference.
- The asynchronous screenshot cache retains a completed image while requesting its replacement. Previously, small thumbnails expired after ten seconds, before the source list's twelve-second retry, so the fallback initial could persist indefinitely.

Only `main.cpp` additions guarded by `__APPLE__` and `platform/macos/window_capture.mm` change runtime behavior. Windows implementation, encoder settings and signaling remain unchanged. The resize workflow uses existing authenticated VDO.Ninja `requestVideoHack` width/height requests, validated against local `lib.js` and `webrtc.js`; no protocol command was invented.

## Packaged application testing

On this Apple M1 / 8 GiB / macOS 26.4.1 host, the signed bundles run actual source-selection and media-publishing workflows. Builds, signatures and offline evidence checks are separate gates.

The GUI comparison uses the preceding cursor-only candidate as a positive control for the two preview defects. Both bundles select an owned transparent source, wait for the ordinary thumbnail retry without pressing Refresh, and capture their own windows at three controlled system-pointer positions. An sRGB canvas compares the screenshots with direct native source-window captures.

| Check | Preceding candidate | Corrected candidate |
| --- | --- | --- |
| Reference red, native source | RGB 240/60/29 | RGB 240/60/29 |
| Selected preview red | RGB 255/26/0 — mismatch | RGB 240/60/29 — match |
| Source-list thumbnail | Fallback icon in all three phases | Actual source image in all three phases |
| Selected-preview cursor probes | Clean | Clean |

This verifies the sampled flat-color regions; it is not a general color-calibration or perceptual-quality claim. Cached-thumbnail cursor positions are outside this check.

Both H.264 encoders pass initial 640×360, live enlargement to 960×540 and restoration to 640×360, with parked, transparent-region and opaque-region cursor positions at each size. The native capture-enlargement log, configured dimensions and received dimensions agree. Native-resolution probes use 40×40 or 60×60 pixels without downsampling.

| Encoder | Received observations | Probe pixels | Unexpected probe pixels |
| --- | ---: | ---: | ---: |
| Apple VideoToolbox | 1,621 | 7,347,200 | 0 |
| x264 | 1,620 | 7,344,000 | 0 |

Both pass frame progression, actual encoder selection, normal shutdown and pointer restoration. The released Beta 1 positive control previously showed 159–164 cursor pixels under the pointer; the new cursor-only and preview candidates exclude them. Earlier failed custom-cursor fixture attempts remain retained.

Both encoders also pass native OBS 32.2.2/plugin reception of H.264 color plus a VP9 alpha mask through 640×360 → 720×960 → 960×480 → 640×360 source sizes, fitted into a fixed 640×360 output. Black and white scene composition pass all eight stable phases and three transitions per encoder: **1,317 VT frames and 1,319 x264 frames**, with no invalid sampled geometry/color/alpha frames. The OBS frontend is excluded. This controlled pass does not resolve the original four unexplained VFR alpha pixels.

## Limits and delivery status

All 39 application units were rebuilt from the recorded Git snapshot and the Developer ID signature verifies. The executable has not been notarized, packaged into a new public release, or exercised through a fresh public download. The released Beta 1 thirty-minute VT/x264 results remain bound to its earlier executable; they are not claimed for this candidate.

Keep Mac experimental. Physical minimum-OS/permission/device coverage, sleep/wake, display/audio-route changes, VoiceOver, broader Windows GPU/audio/installer coverage and matched OBS/FFmpeg/WHIP/gameplay quality remain open. Earlier unexplained VFR alpha pixels, hosted-motion, recorder-clock and abrupt-viewer-close findings remain recorded; these passes do not establish their causes.

[Numeric results](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-preview-candidate/results.json) · [GUI before](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-preview-candidate/gui/baseline/opaque.png) / [after](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-preview-candidate/gui/candidate/opaque.png) · [Export audit](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-preview-candidate/export-audit.json) · [Evidence manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-preview-candidate/evidence-manifest.json).

The export omits publisher/session logs and local-control credentials. Its bounded privacy gate passed with zero locally available known private values and no private tool configuration; it is not a comprehensive secret-detection claim.

Detailed numeric artifacts are in the private benchmark repository and require access. The Mac runtime changes are available on [macos-main-integration](https://github.com/steveseguin/game-capture/commit/ea1c552c6c833fecc16914e18710a589a6bb2db1).
