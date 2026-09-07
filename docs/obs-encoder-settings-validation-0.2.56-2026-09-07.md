# Game Capture 0.2.56 → native OBS encoder/settings validation

Date: 2026-09-07. Actual end-to-end runs used the published Windows package, portable OBS 32.2.2, and the exact OBS plugin v1.1.68 DLL. The supported H.264/VP9 baseline passed. **This is not an all-settings pass: explicit NVENC/QSV had a reproducible 4K30 throughput shortfall, and native OBS cannot receive HEVC/AV1.**

## Artifact and host identity

| Artifact | SHA-256 |
| --- | --- |
| Published `game-capture-0.2.56-win64/game-capture.exe` | `1e1abb1a14c792de8e06b54e057a4113e0fb7171863431280f630aad4c81b821` |
| Loaded `obs-vdoninja.dll`, v1.1.68 | `09975b30d4d4e917dd911dc8d971e19dbe08684a795dcb2668845da4f983f5cb` |
| Portable `obs64.exe`, 32.2.2 | `e79066670cd8e8b95662f4cd417c4fa6f5b0c77e856a7b41c7de0e00059ba6f2` |
| Moving Spout fixture | `cfaf610a3498f4ac0aad4df25e1721b78b3f1fbd93c71a7ae89c4e5da44746ab` |

Host: Intel Core Ultra 7 265K, Intel Graphics driver 32.0.101.6881, NVIDIA TITAN RTX driver 32.0.16.1047. No AMD GPU. FFmpeg is the package's n8.1.2-34-g9b6c8969e0-20260731 build. Browser observer: Chromium 145.0.7632.6.

The isolated OBS runtime is `native-qt/qa/reports/obs-0.2.56-runtime`. Each workflow verifies the actual loaded plugin module's path and hash. Its source checker matches the release validation checker (`fbab0045ff89dc06f2b1958fa683fc1103b8a31c581657a7a132ae7277ced32f`). Existing ninja-plugin working-tree changes were preserved.

## Baseline: seven encoders, controls, transparency, and recovery

Each case ran the packaged publisher → native OBS workflow with a simultaneous ordinary browser viewer, 1280×720 at 60 FPS, and alpha enabled. The run lasted 28m51s in total, approximately four minutes per case.

| Requested mode / codec | Actual encoder / category | Result | OBS distinct frame changes/s |
| --- | --- | --- | ---: |
| Auto / H.264 | H264 Encoder MFT / Hardware | Pass | 59.88 |
| NVENC / H.264 | FFmpeg h264_nvenc / NVIDIA | Pass | 59.88 |
| FFmpeg NVENC / H.264 | FFmpeg h264_nvenc / NVIDIA | Pass | 59.88 |
| QSV / H.264 | FFmpeg h264_qsv / Intel | Pass | 59.88 |
| Software / H.264 | H264 Encoder MFT / Software | Pass | 59.88 |
| Auto / VP9 | FFmpeg libvpx-vp9 / Software | Pass | 59.88 |
| Software / VP9 | FFmpeg libvpx-vp9 / Software | Pass | 59.88 |

- Live controls changed 720p60/4 Mbps → 360p30/1 Mbps → 720p60/8 Mbps. Requested settings and actual receiving dimensions/rates were verified.
- Browser reload, transport rebuild, native OBS transport rebuild, signaling interruption, and Spout source restart recovered.
- A relay dropped 5% of actual native-bound RTP packets: 385, 745, 750, 205, 390, 165, and 165 packets respectively. Native composition and recorded playback recovered afterward.
- 50% alpha composition passed before and after transport rebuild. Maximum per-channel pixel error was **1/255** in all fourteen half-opacity images.
- **21 OBS recordings** covered post-rebuild, post-packet-loss, and post-source-restart playback. All consecutive frames changed moving-edge identity; OBS reported zero rendering/encoding skips during these recording windows. The 59.88 figure excludes the first frame from a roughly eight-second 60 FPS recording; it represents full cadence.
- Recorded 440 Hz audio measured 439.89–440.09 Hz, with no clipped samples and no silent 100 ms analysis windows after trimming 0.5 seconds at each end.
- Browser video counters measured 59.83–60.23 FPS across steady/recovery checkpoints. Publisher fresh-capture counters were approximately 60 FPS.
- All seven publisher shutdowns completed normally in 419–439 ms, with no remaining child encoders.

## Additional settings and native-only playback

The native receiver was the first and only viewer in these cases. Every passing entry includes actual OBS composition/motion, an approximately eight-second OBS recording, audio analysis, requested-setting verification, and normal publisher shutdown.

Across 24 distinct settings/capability cases, 15 configurations passed playback, three failed the 4K30 performance requirement, and six confirmed unsupported selections. Fresh reruns are recorded separately rather than replacing failed evidence.

| Configuration | Requested bitrate | Result / recorded motion |
| --- | ---: | --- |
| NVENC H.264, 1080p60, alpha off | 12 Mbps | Pass, 59.88 changes/s |
| QSV H.264, 1080p60, alpha on | 12 Mbps | Pass, 59.88 changes/s |
| Software H.264, 1080p60, alpha off | 12 Mbps | Pass, 59.88 changes/s |
| Software VP9, 1080p60, alpha on | 12 Mbps | Pass, 59.88 changes/s |
| NVENC H.264, 720p120, alpha off | 12 Mbps | Pass, 119.88 changes/s |
| Software H.264, 360p15 | 0.5 Mbps | Pass, 14.88 changes/s |
| QSV H.264, 720p30, green chroma fill | 4 Mbps | Pass, 29.88 changes/s |
| Software H.264, 720p30, opaque `#204060` fill | 4 Mbps | Pass, 29.88 changes/s |
| Software VP9, 720p30 alpha, custom `-g 120 -lag-in-frames 10 -threads 4` | 4 Mbps | Pass, 29.88 changes/s; protected dual-track settings remain enforced |
| QSV H.264, 720p30, custom `-vf null` | 4 Mbps | Pass, 29.88 changes/s |
| QSV H.264, 720p60 alpha, room mode | 8 Mbps | Pass, 59.88 changes/s |
| Software VP9, 720p60 alpha, room mode | 8 Mbps | Pass, 59.88 changes/s |
| Auto H.264, 2160p30, alpha off | 25 Mbps | Pass, 29.88 changes/s |
| NVENC H.264, 2160p15, alpha off | 12 Mbps | Pass, 14.88 changes/s |
| QSV H.264, 2160p15, alpha off | 12 Mbps | Pass, 14.87 changes/s |

Solid fixture-interior RGB error was **1–2/255**, including **2/255 for software H.264**. Both requested background colors were within 2/255. This does not reproduce the historical 19/255 software-H.264 error in these samples; it is not a full-gamut or natural-content quality measurement.

The separate exact-package room-quality workflow also passed: native OBS alpha composition and advancing browser color/alpha tracks. VP9 preserves its documented HQ-only behavior when room quality is requested. Both artifact identity and room-quality contracts passed.

## Confirmed remaining performance concern: external encoders at 4K30

| Requested path | Bitrate | OBS distinct frame changes/s | Outcome |
| --- | ---: | ---: | --- |
| NVENC H.264 → FFmpeg h264_nvenc | 25 Mbps | 18.72, then 21.25 on repeat | Fail |
| NVENC H.264 → FFmpeg h264_nvenc | 8 Mbps | 24.42 | Fail |
| QSV H.264 → FFmpeg h264_qsv | 25 Mbps | 17.38 | Fail |
| Auto H.264 → hardware H264 Encoder MFT | 25 Mbps | 29.88 | Pass |

Source capture continued near 30 FPS and OBS reported no render/output skips. Publisher sent-frame deltas tracked the reduced delivered rate. This establishes a publisher external-encoder-path throughput problem in this setup; it does not establish a decoder/compositor failure or prove a particular root cause. Lowering NVENC bitrate did not restore full cadence.

Auto/H.264 4K30 passed a second fresh run. Explicit NVENC/QSV both passed at 4K15, providing a verified lower-rate configuration.

A separate diagnostic benchmark fed identical 4K NV12 frames to the bundled NVENC encoder through Windows anonymous pipes. It achieved 78.65–84.88 FPS with default, 64 KiB, and 1 MiB capacities, without a meaningful repeatable benefit from enlarging the buffer. This excludes a simple raw-pipe-capacity explanation in that benchmark, but omits capture, conversion, application scheduling, and OBS; **it is not end-to-end testing**. The parameter semantics were checked against Microsoft's [CreatePipe documentation](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createpipe) and Python's [subprocess documentation](https://docs.python.org/3/library/subprocess.html).

Next corrective investigation: profile input preparation, enqueue/write completion, packet assembly, and encode-wait time during the reproduced packaged 4K workflow. Keep Auto/H.264 4K30 as the working control. No speculative production change was made from this evidence.

## Intentional compatibility limits confirmed by running the package

| Selection | Actual behavior | Disposition |
| --- | --- | --- |
| AMF / H.264 | No AMD encoder; publisher exits with code 3 and explicitly refuses a different category | Expected on this host; AMD playback remains untested |
| NVENC / VP9 | Publisher explicitly refuses software-category fallback; exit 3 | Expected category mismatch |
| Auto / HEVC | FFmpeg hevc_nvenc starts; native OBS rejects the video offer | Unsupported native codec |
| Auto / AV1 | FFmpeg av1_qsv starts; native OBS rejects the video offer | Unsupported native codec |
| QSV / AV1 | FFmpeg av1_qsv starts; native OBS rejects the video offer | Unsupported native codec |
| Software / AV1 | FFmpeg libaom-av1 starts; native OBS rejects the video offer | Unsupported native codec |

The OBS logs explicitly report that these offers contain neither VP9 nor H.264. This agrees with `ninja-plugin/src/vdoninja-peer-manager.cpp`'s native offer handling. Experimental codec startup fallback does not imply receiver-compatibility fallback. These negative probes intentionally report failed playback; they must not be counted as passing media workflows.

## Harness corrections and validation limits

- The initial settings helper omitted PowerShell's process-scoped execution-policy argument. A direct reproduction returned “running scripts is disabled”; the publisher saw no audio chunks and OBS recorded silence. The corrected helper logs the tone process and detects early exit. All three affected 1080p cases were rerun with actual recorded audio.
- The alpha startup sampler initially stopped at ten non-background samples, even when the first valid frame appeared twice. It now collects ten distinct decoded/PNG frames within the original 20-second deadline, retaining repeats and invalid samples for analysis. The three affected cases passed fresh application runs and full recording cadence afterward.
- Reduced-image differences shrink as the fixed nine-source-pixel movement is downscaled from a wider canvas. The difference threshold now scales with width; the independent full-resolution moving-edge requirement stays at 95% of requested FPS. The actual 4K failures remained failures after this correction.
- The helper now supports room IDs, preserves each OBS application log before portable log rotation, binds OBS executable identity, and drains process output before closing log streams.
- Repeated recordings used to overwrite the saved original recording directory with the first recording's output directory. The helper now saves the original once and checks the restored directory through OBS WebSocket after cleanup. A fresh packaged alpha workflow passed two consecutive 30 FPS recordings and confirmed restoration.
- No release executable or production source was changed. JavaScript syntax and diff checks are gates only.
- These runs use real shipped applications with deterministic Spout motion and audio fixtures. They do not establish natural-gameplay quality, HDR/10-bit quality, end-to-end latency or lip sync, WAN behavior, AMD behavior, every arbitrary FFmpeg option, or GUI installation/upgrade behavior. The 4K performance issue remains open.

## Evidence and reproduction

Local ignored evidence beneath `native-qt/qa/reports/`:

- `obs-0.2.56-encoders/b84cc346-c2bf-47c1-b9dc-e8427f1f5a24/results.json` and `native-loss-analysis.json`: seven baseline workflows, recordings, screenshots, audio, faults, and shutdown.
- `obs-0.2.56-settings/8d89fc8f-9c35-4f69-ae35-8b8207941446/results.json`: initial settings and compatibility matrix; original failures preserved.
- `obs-0.2.56-settings-followup/fe4fd128-9ef2-4f56-88aa-156c0d021415/results.json`: corrected workflows and 4K comparisons.
- `obs-0.2.56-settings-final/b82e7e7d-5bf3-491a-924c-38630298b62c/results.json`: repeated Auto 4K30 and passing NVENC/QSV 4K15, including final log-drain behavior.
- `obs-0.2.56-room-quality/manifest.json`: passing native/browser room-quality workflow.
- `obs-0.2.56-settings/coverage.json`: mapping of all 24 settings cases to their latest recorded evidence.
- `obs-0.2.56-cleanup/a183be3f-f253-45fd-93e0-945872ffc33c/results.json`: two real recordings and successful directory restoration using the final helper.
- `obs-0.2.56-settings/pipe-throughput.py` and `pipe-throughput.json`: diagnostic benchmark and results.

Run the settings matrix with `node native-qt/e2e/obs-settings-review.js`, passing `--publisher`, `--expected-publisher-sha256`, `--sender`, `--cases=native-qt/e2e/obs-settings-cases.json`, `--reports`, `--obs-plugin-repo`, and `--expected-plugin-sha256`. The plugin-repo argument must point to an isolated portable OBS runtime with its checker dependencies installed. The JSON case list deliberately includes unsupported probes and performance boundaries; a nonzero exit requires classifying the saved evidence, not automatically declaring a regression.

The baseline uses `encoder-receiver-review.js` with `--cases=auto:h264,nvenc:h264,ffmpeg_nvenc:h264,qsv:h264,software:h264,auto:vp9,software:vp9`, `--width=1280 --height=720 --fps=60 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --combined-video-controls=1 --require-codec=1 --obs-cadence=1 --native-loss=5 --obs-half-opacity=1 --faults=1 --soak-ms=30000`, plus the artifact/runtime paths above. Analyze its completed recordings with `analyze-native-loss-review.js <results.json>`.

Final cleanup found no remaining publisher, OBS, FFmpeg, Spout fixture, or tone processes from these runs. The publisher and OBS executable hashes still matched the identities above.
