# Mac ARM conversion candidate — October 17, 2026

An **unreleased, Developer ID signed candidate** passed the focused workflows below after optimizing Mac pixel conversion. The downloadable Mac Beta 2 remains experimental and unchanged; its [earlier five-minute x264 failure](macos-beta2-validation-2026-10-17.md#five-minute-1080p60-workload--october-17-follow-up) remains valid evidence. Windows stable v0.2.64 is unchanged.

Runtime revision [`af9ce7b`](https://github.com/steveseguin/game-capture/commit/af9ce7b525b9d430551f3780e55ebf9d48ee732c); signed executable SHA-256 `54b61a56b5d1b8c0bbff624c456914c11ab38d412d0921231dbe665c6414c353`. All 39 application compilation units were rebuilt from a frozen source archive. This separate candidate was signed and signature-verified, but has not been notarized or published as a download.

## Change and correctness gates

Two stack samples of signed Beta 2 showed substantial work in scalar BGRA-to-I420 conversion and repeated Qt scanline calls. The Mac converter now processes sixteen pixels per row with ARM NEON, retaining a scalar tail for other even widths. At 1920×1080, scanline lookups fall from 1,036,800 to 1,080 per frame. Aspect fitting, black padding, alpha separation, limited-range BT.601 coefficients, RGB averaging/rounding, encoder presets and bitrate settings stay the same. No VDO.Ninja messages changed.

The new arithmetic gate compared **80,072,704 pixels byte-for-byte** against the original conversion, including every solid RGB triplet, random/extreme 2×2 colors, alpha variation, unaligned rows, guarded output and widths from 2 to 8192. Address and undefined-behavior sanitizers passed. Build, arithmetic, signature and evidence verification are gates; the application testing is listed separately below.

The runtime change is confined to the Mac encoder and a private ARM conversion header. Its CMake gate is inside the Apple-only block. No Windows runtime source changed in this optimization; that source review does not replace the still-required Windows application testing for the wider Mac integration branch.

## Completed packaged application testing

Both encoders ran sequentially for five minutes at requested H.264 1920×1080/60, 8 Mbps, with the moving-tile source and selected-application stereo audio. Captured source size was **1920×930**, aspect-fitted into 1080p output. Source and receiver shared this M1/8 GiB Mac on macOS 26.4.1, using Chromium 145.0.7632.6; the remote-desktop session remained active.

| Encoder | Ten-second cadence intervals | Received fps range | Continuous 100 ms audio windows | Publisher RSS MiB |
| --- | --- | --- | --- | --- |
| x264 software | 30/30 passed | 59.768–60.098 | 3,056, all passed | 176.5–178.6 |
| VideoToolbox hardware | 30/30 passed | 59.793–60.094 | 3,056, all passed | 143.0–148.5 |

Both complete workflows also passed live frame-rate controls, static/silent/resumed content, source resizing, late-viewer video/audio and shutdown behavior. x264 deliberately lost its owned source and correctly returned application exit 3; the harness passed. VT quit normally. Audio checks measure received PCM content, not physical playback or calibrated A/V synchronization.

Both encoders also passed paired-alpha publication through the native OBS 32.2.2 receiver and frozen VDO.Ninja plugin 1.1.74. Eight black/white composition phases and three source-aspect transitions per encoder checked color, alpha, padding and moving identities: x264: 1,009 stable and 309 transition frames; videotoolbox: 1,008 stable and 311 transition frames, with zero invalid frames. Source geometry changed from 640×360 to 720×960 to 960×480 and back, while output stayed 640×360. This is OBS reception/composition, not OBS encoding or portrait-output qualification.

Two follow-up stack samples show fewer conversion samples. These profiles perturb execution and are not calibrated CPU-efficiency measurements. The diagnostic Beta 2 run failed one cadence interval while both candidate diagnostic samples completed within a passing workflow; all four complete five-minute/OBS workflows above ran without profiling. Host load varied substantially: x264 host CPU samples ranged 73.1–93.2%, VT 62.5–97.3%. Do not infer an isolated CPU reduction or cross-encoder efficiency ranking from these runs.

## Evidence and remaining qualification

The [benchmark repository](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-17-apple-m1-i420) contains the measurements and a scrubbed evidence index. Local freeze: `macos-i420-evidence/14cecc57-0bf2-46ae-9c72-57104d342670/evidence-manifest.json`, SHA-256 `734ad8514ee710166dcd5af0a7e5ae432e91a22a559fdd84166e9dcc188b4145`; 203 files indexed. Raw observations, commands, recordings, source archive and signing records remain local. Earlier frozen evidence is unchanged.

Reproduce with the `macos-production-readiness` branch's `macos-window-publish.js`, the exact candidate bundle, a fresh report directory and `--performance-seconds=300 --width=1920 --height=1080 --fps=60 --bitrate-kbps=8000 --motion-pattern=tiles --audio=selected-window --continuous-audio=true --compact-performance-report=true --collect-performance-failures=true`. Select each encoder sequentially and provide the owned-source UI helper. The manifest binds the exact harnesses and commands; `macos-alpha-aspect.js` supplies the separate native OBS workflow.

This is a focused candidate pass, not production qualification or proof that all sustained x264 failures are resolved. Repeat under representative gameplay/thermal load and with an independent receiver. Full-height capture, another/minimum-version Mac, physical devices/privacy/sleep/wake, trusted remote RTMPS, broader current-artifact regressions and the integrated Windows package remain required. Matched OBS/FFmpeg Apple quality comparisons, VMAF/SSIM/PSNR, shared frozen references, randomized repeats and verified aggregate CPU caps are not established here.
