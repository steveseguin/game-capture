# macOS 0.2.65 Beta 2 — October 18, 2026

[Download the experimental Apple Silicon release](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.65-beta.2). **Windows remains stable/production; Mac remains experimental.** Beta 2 fixes system-cursor inclusion in window capture, oversaturated previews and source thumbnails stuck on fallback icons.

Runtime source: `ea1c552c6c833fecc16914e18710a589a6bb2db1`. Executable SHA-256: `2a6354f12b92ac1d8ef2a415c76316ea8452b040503087c1b8ec716be69ad1b0`. The app is Developer ID signed, notarized and stapled. Its application version remains **0.2.65**: stop streaming, quit and replace Beta 1 manually.

## Actual packaged application testing

On Apple M1 / 8 GiB / macOS 26.4.1, both the locally delivered archive and a subsequent public GitHub browser download pass GUI launch, settings changes and relaunch. Original quarantine is preserved. A separate same-version replacement workflow verifies that preferences survive replacing released 0.2.65 Beta 1 with this executable. This is an existing, permission-granted Mac, not fresh privacy-prompt qualification. [Local delivery](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta2/delivery.json), [public delivery](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta2/public-delivery.json).

The public-downloaded app passes separate sixty-second **1280×720 output, 60 fps, 4 Mbps H.264** workflows with selected-application stereo:

| Encoder | Distinct received images/s, ten-second interval range | Intervals | Stereo/continuous PCM |
| --- | ---: | ---: | --- |
| Apple VideoToolbox | 59.80–59.99 | 6/6 | Pass |
| x264 | 59.79–60.00 | 6/6 | Pass |

The generated source is captured at 1154×720 and fitted into 1280×720 output. Source, publisher and receiver share one Mac. Both encoders also pass subsequent live controls, static content, resizing and late viewing. VT quits normally; x264 reports the expected capture-failure exit 3 after deliberate source loss. These short workflows do not establish thermal endurance, physical A/V latency or matched perceptual quality. Numeric observations for all 24 local/public intervals are exported.

Before distribution, the same executable passed the [cursor/preview qualification](https://github.com/steveseguin/game-capture/blob/main/docs/macos-preview-candidate-2026-10-18.md): before/after GUI checks reproduce and correct the color and missing-thumbnail defects; VT/x264 deliver 3,241 frames through live output enlargement/restoration with 14,691,200 clean cursor-probe pixels. Native OBS 32.2.2/plugin H.264 color plus VP9 alpha composition passes 2,636 frames across landscape, portrait, wide and restored sources. The OBS frontend and arbitrary-image color calibration are excluded.

Fresh macOS 14.8.9 ARM64 VM [startup](https://github.com/steveseguin/game-capture/actions/runs/39125410902) and [x264 media](https://github.com/steveseguin/game-capture/actions/runs/39125413234) workflows pass with the exact uploaded app/source archives. The media workflow delivers **20.14 / 11.24 / 16.61 distinct images/s** in moving/resized/late-viewer phases, with no unreadable identities or row disagreement, then expected source-loss exit 3. This establishes functional VM coverage, **not sustained 30 fps**, hardware VT or audio. [Startup evidence](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta2/hosted-startup.json), [media observations](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta2/hosted-media.json).

## Distribution and compatibility gates

Apple accepted notarization `d103076b-608b-41ba-b980-46c867cc93f1`. The complete corresponding-source archive verifies **10,662 payloads, 12 native repositories, eight upstream archives and all 16 bundled binaries**. Uploaded app/source/checksum files were downloaded and hash-verified. Build, signature, notarization, source and hash checks are gates, separate from application testing. [Publication receipt](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta2/publication.json).

The runtime delta from Beta 1 consists of the Mac capture implementation and `__APPLE__`-guarded additions in `main.cpp`. Windows runtime behavior is unchanged by source inspection; its application workflows were not rerun for these Mac-only changes. The earlier [Windows packaged regression](https://github.com/steveseguin/game-capture/actions/runs/39111558348) remains bound to its earlier artifact. Windows 0.2.65 is still the latest stable release, and all earlier Mac release assets remain preserved.

No VDO.Ninja API or signaling command was added. The resize workflow uses the existing authenticated `requestVideoHack` width/height messages; fixture stdin commands are private QA controls.

## Live control pressure follow-up

The same public-downloaded Beta 2 executable passes **816 bounded HTTP requests**
while VT and x264 publish 720p60/4 Mbps window video and selected-application stereo.
Malformed/authentication/framing requests returned their expected statuses. Idle,
trickled-header and incomplete-body clients closed after 9.86–10.01 seconds; each
48-client burst admitted 32 and rejected 16. Authenticated control recovered, and
a pipelined quit was not executed.

All ten five-second media intervals pass: **1,498 decoded frames and 25.1 seconds
of continuous stereo PCM per encoder**, with no encoder failures/timeouts and
maximum decoded arrival gaps of 64.7 ms (VT) / 64.5 ms (x264). Subsequent audio
silence/resume, static, resize, late-viewer and shutdown/source-loss workflows pass.
This adds bounded local-control resilience coverage, not quality or endurance.
No application runtime or VDO.Ninja API changed.

[Artifact-bound report and raw numeric evidence](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-18-apple-m1-beta2-control-pressure)
require access to the private benchmark repository.

## Remaining qualification

Keep Mac experimental. Physical minimum-OS/privacy/device/VoiceOver, sleep/wake, display/audio-route changes, broader Windows hardware/audio/installer coverage and matched OBS/FFmpeg/WHIP/gameplay quality remain open. Earlier unexplained VFR alpha pixels, hosted-motion, recorder-clock and abrupt-viewer-close findings remain recorded. The [released Beta 1 thirty-minute endurance](https://github.com/steveseguin/game-capture/blob/main/docs/macos-0265-beta1-validation-2026-10-18.md) belongs to its earlier executable and is not claimed for Beta 2.

[Evidence manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-0265-beta2/evidence-manifest.json). Detailed numeric artifacts are in the private benchmark repository and require access.
