# Apple M1 streaming-defaults integration — 2026-10-18 UTC

The experimental Mac port now incorporates the current Windows/shared streaming defaults. Packaged GUI migration, VT/x264 live streams, AV1 playback, local WHIP and UDP/AAC output workflows passed on the signed candidate below. The same source passed the hosted Windows packaged workflows. At this measurement checkpoint the candidate was not yet notarized. The [delivery follow-up](macos-defaults-delivery-2026-10-18.md) now records notarization and fresh-host workflows; production qualification remains open. Public Mac Beta 2 and Windows stable are unchanged.

## Candidate and behavior

Runtime source: `c459d7ada325c02945e460378d4f4acab8f1b755`. Developer ID executable SHA-256: `ca2ecda2b36551dcb0eee8bd86c5dc8860782b9c6c04d6813438a18885ee68de`. All 39 application units were rebuilt. Later commits change QA/documentation only. The previous lifecycle candidate's notarization and thirty-minute results for earlier binaries do not qualify these new bytes.

The branch merges upstream `e4b2006`: shared 720p60 / 4,000 kbps video, 128 kbps streaming audio and a 1,200-byte maximum RTP codec fragment. Mac VT/x264 and AV1 now cap the low-latency keyframe interval at the configured frame rate; an explicit longer GOP remains available outside low-latency mode. Direct x264 and AV1 use at most half the logical CPUs, bounded to 1–4 workers. VP9's higher-resolution worker policy and protected alpha all-keyframe contract remain unchanged. No VDO.Ninja API or signaling command was introduced.

These are worker caps, not whole-machine CPU limits. The host is an 8-logical-CPU Apple M1 with 8 GiB RAM, macOS 26.4.1. macOS CPU affinity was unavailable; browser, VT and OS workers were not globally capped. Encoders ran sequentially. Host CPU samples include other work and must not be interpreted as process-specific encoder efficiency.

## Packaged GUI and live media

Four visible GUI launches passed using isolated preferences. A fresh profile showed 1280×720, 60 fps, 4 Mbps, Auto hardware/software selection and 128 kbps Opus. GUI changes to 1080p30, 6 Mbps, software encoding and 192 kbps Opus survived relaunch. The same explicit values created by the previous packaged app survived migration to this candidate. All four instances quit normally and removed their control discovery files; no publishing started during these configuration workflows.

The following generated-window H.264 runs requested 4 Mbps and selected-window stereo audio. Live runs supplied explicit video settings; their Opus bitrate argument was omitted. Diagnostics confirmed the new 128 kbps configured audio target. Targets are not measured network payload rates; RED and transport overhead add traffic.

| Encoder | Output / fps | Timed observation | Passing intervals | Distinct received images/s range | Passing PCM windows | Captured source size |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| videotoolbox | 1280×720 / 60 | 60 s | 6/6 | 59.79–60.00 | 607 | 1154×720 |
| x264 | 1280×720 / 60 | 60 s | 6/6 | 59.89–59.99 | 607 | 1154×720 |
| videotoolbox | 1920×1080 / 60 | 60 s | 6/6 | 59.79–60.00 | 610 | 1920×930 |
| x264 | 1920×1080 / 60 | 300 s | 30/30 | 59.59–60.00 | 3,055 | 1920×930 |

All 4,879 continuous stereo windows passed the existing gap, silence, channel-isolation, clipping and validity checks. Each interval met the existing source-rate, delivery-ratio, media-gap, output-dimension and encoder-error criteria. The 100 ms audio windows are receiver PCM observations, not physical lip-sync measurements.

All four complete workflows also passed moving picture, silence/resume, 30/60 fps controls, static content, resize, late joining and expected cleanup. VT quit with exit 0; x264 deliberately lost its owned source and reported capture-failure exit 3, with discovery removed. A separate 640×360/30 software AV1 workflow passed moving/static/resize/late-viewer and stereo/silence behavior; it is functional coverage, not sustained AV1 performance qualification.

Sender and Chromium 145.0.7632.6 receiver shared this Mac. The source window was fitted to the output; the captured dimensions above preserve that distinction. These short landscape runs are not demanding-game, native full-frame 1080p, portrait, WAN, thermal or thirty-minute endurance qualification. They are not a matched OBS/FFmpeg/WHIP picture-quality comparison, and provide no VMAF/PSNR/SSIM or normalized efficiency score.

## Local WHIP and AAC outputs

Both VT and x264 passed packaged WHIP publishing to an owned local MediaMTX instance: moving picture, stereo, silence/static content, a late viewer and session deletion on Quit. VT additionally recovered after the owned server restarted. Only the existing virtual camera and BlackHole fixture input were used; this does not qualify physical devices or public service endpoints.

Both encoders also passed UDP/MPEG-TS to an independent FFmpeg receiver with the AAC bitrate CLI argument omitted. Diagnostics confirmed the 128 kbps AAC default. All 6 received recordings decoded with Baseline/Constrained Baseline H.264, zero B-frames, stereo 48 kHz AAC, correct moving/static identities, expected sound/silence and monotonically increasing steady-state timestamps. The largest observed decoded keyframe gap was 30 frames. Each app and its bundled mux helper shut down. Configured AAC bitrate is not an assertion that every received packet stream averages exactly 128 kbps.

## Windows regression coverage and supporting gates

[Windows run 39085997354](https://github.com/steveseguin/game-capture/actions/runs/39085997354) passed **70/70 GUI assertions**: repeated ordinary snapshot replacement, persistent-lock preservation, normal exit and discovery removal. Concurrent readers parsed 140,201 snapshots with zero incomplete JSON. Actual Windows Graphics Capture/software H.264 MFT playback passed moving/static content, resize, late joining and the expected source-loss exit 3. Encoder failures/timeouts were zero. This is an extracted package on an interactive Windows Server 2022 VM; physical GPU/audio/output, consumer-host and installer coverage remains separate.

Windows executable: `216e2c64ee73555e0de417bdb53d2200c74a9302c68a99f7d5bd0a75982864cd`. ZIP: `32fbee4b746599dfd4b0ad660e0e36980c9c0f1f59361b9475ef5fd9ada6f307`. Both are bound to the same runtime source as the Mac candidate.

The native gates independently decoded six keyframe-policy cases (VT, x264 and AV1, low-latency versus explicit longer GOP) and six codec/color/restart cases (VT H.264/HEVC, x264, VP9 and two AV1 configurations). All final rows passed. The first attempt pointed to the wrong bundled FFmpeg directory and failed three codec initializations; that harness failure is retained. Build, signature and native gates are separate from the packaged application testing above.

## Evidence and remaining qualification

[Measurements](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-defaults/measurements.json), [Windows evidence](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-defaults/windows-results.json), [manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-defaults/evidence-manifest.json), [binding validation](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-defaults/validation.json). The manifest binds 105 local files and has SHA-256 `6a096b803950288502b88abc62192fe5d4cb17497dbf976a81f3b3d6f6268348`. Exports use explicit field allowlists; raw control credentials, private preferences and signaling logs stay local. Individual JSON files retain intervals, dimensions, observations and artifact hashes.

Keep the port experimental. The new binary still needs its own distribution/notarization and fresh-host workflows, longer independent gameplay/thermal coverage, physical minimum-version Mac/privacy/devices, sleep/wake and display/audio-route changes, broader accessibility and Windows qualification. Earlier recorder-clock and abrupt-tab-close findings remain open; these runs do not erase them. The [previous candidate's delivery report](macos-lifecycle-delivery-2026-10-17.md) remains historical evidence for that artifact only.
