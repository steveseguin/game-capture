# Apple M1 direct NV12 conversion — October 18, 2026 UTC

The Mac candidate removes redundant full-frame copies before encoding. Its packaged VT workload delivered **31.98–32.20 distinct images/s** during requested 4K60, compared with **22.66–23.59** from the previous signed build under the same sequential workflow. Both returned to about 60 images/s at 720p. This is a useful improvement, **not 4K60 or production qualification**.

The candidate's x264 run still fails picture integrity at 4K / 4 Mbps: 11 unreadable decoded frame identities and 17 row disagreements. The [earlier retained failure](macos-load-recovery-2026-10-18.md) remains open. The previous-build x264 control passed in this repeat, whereas the candidate failed; earlier previous-build failures are also retained. This comparison does not establish freedom from quality regressions under overload. Faster conversion does not solve that rate/quality limitation.

## What changed

Previously, both Mac encoders drew capture bytes into a filled BGRA image and converted that image to planar I420. VT then copied Y and rearranged U/V into a second NV12 buffer. The new Mac path:

- Reads capture rows directly when they already match the output.
- Uses only two scratch BGRA rows when an unscaled image needs letterbox borders, preserving odd border positions and chroma averaging.
- Retains the existing Qt scaling path when the source needs resizing.
- Writes Y and interleaved UV directly into VT's native NV12 planes. x264 continues receiving planar I420 from the same row visitor.

Color coefficients, limited range, alpha-independent color, frame identities, packet timestamps, keyframe requests and encoder rate-control settings are unchanged. No VDO.Ninja API or signaling command was added. Runtime edits are confined to Mac encoder code/headers; the CMake addition registers a Mac-only supporting gate.

The preceding packaged VT profile found 198 sampled stacks in Qt image drawing/copying, 52 in image fill and 146 in planar conversion, alongside 733 waiting for VT's callback. Sampling was limited to the owned publisher for five seconds. These counts guided the change; they are not CPU-utilization percentages or an encoder-efficiency benchmark. That profiled run is separate from the comparison below.

## Actual packaged application workflows

Developer ID signed candidate: source `71137c77dd14de5e8f62d3c9ae3b0d0c0035c74a`, executable `9308120369c88bda0b26882d142177cbdc289685174858d6209e27cae74ad565`. It is **not notarized or released**. The previous signed comparison executable is `3c3de83c06314e1c0027777b5a4d9aa2cfa59c7ce2f4345b8bc58a0ec56e9f53` at source `b565e51c31676f7f4979999d4df576b51b6c1448`. Public Windows stable, Mac Beta 2 and existing draft assets remain unchanged.

Each load run requests three 720p60 → 4K60 → 720p60 cycles with 15 seconds at 4K and 10 seconds after each return, continuous stereo, existing authenticated resolution controls and the corrected frame reader. The table's identity columns count 4K observations; row disagreements include cases where two rows still agree. A passed load workflow means recovery/control/audio criteria passed, not that 4K60 or general picture quality passed.

| Packaged run | 4K distinct images/s | Recovered 720p images/s | Unreadable / disagreeing frames | Full workflow |
| --- | ---: | ---: | ---: | --- |
| candidate / videotoolbox | 31.98–32.20 | 59.97–59.99 | 0 / 0 | Pass |
| candidate / x264 | 23.33–25.92 | 59.88–59.99 | 11 / 17 | FAIL |
| baseline-control / videotoolbox | 22.66–23.59 | 59.99–60.09 | 0 / 0 | Pass |
| baseline-control / x264 | 19.93–20.73 | 59.59–60.09 | 0 / 0 | Pass |

Failed load runs retain every cycle and recovery, then stop before subsequent static/resize/late-viewer checks. Passing full runs also complete moving/static, silence/resume, FPS changes, resizing, late viewing and the expected shutdown status (x264 source-close exit 3; VT controlled-stop exit 0). Per-phase audio counts, control latency, source cadence, sender/receiver cadence, error counters and encoded payload accounting are in [measurements](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/measurements.json), with [reproduction arguments](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/commands.json). Partial and failed observations are retained.

A separate candidate x264 default-settings workflow at **720p60 / 4 Mbps** passed: 6 ten-second intervals over one minute, **59.88–59.99** received images/s, followed by static/FPS/resize/late-join/source-close checks. Its scope is default-settings playback, not clearance of the failed 4K case.

Host: Apple M1, 8 logical CPUs, 8 GiB, macOS 26.4.1. Source and receiver browsers share this Mac. Requested 4K output is fitted from the captured window; consult `captureSize` in the measurements for the actual input dimensions. All runs use the same capture/receiver harness hashes. Order was candidate VT, candidate x264, previous VT, previous x264, then candidate default x264. No profiler or separate decoder ran during these comparison workflows. The order was not randomized, thermal conditions and whole-machine CPU budget were not controlled, and this is a generated fixture rather than an independent gameplay source. No matched OBS/FFmpeg/WHIP quality score, VMAF, PSNR, SSIM or isolated CPU/GPU efficiency is claimed.

## Supporting gates and x264 timing investigation

The [gates](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/gates.json) record **80,072,704 scalar-reference pixel comparisons** for I420/NV12 and **214 image layouts** against the old Qt preparation path, under AddressSanitizer and UndefinedBehaviorSanitizer. Coverage includes tiny/odd source dimensions, non-multiple-of-16 tails, unaligned inputs, unequal output strides, border placement, random alpha and scaling. [All 16 native encoder gate rows](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/native-encoder-rows.json) passed, covering GOPs, independent decoding, color metadata, transparent color, restart, invalid input and encoder selection. These are gates, **not application testing**.

The signed candidate rebuilds the changed Mac encoder unit, reuses 38 unchanged application objects and verified dependency libraries, and preserves 344 other bundle payloads. Its source and executable hashes bind the actual application results above. [Windows build run 39091725857](https://github.com/steveseguin/game-capture/actions/runs/39091725857) passed compilation, backend selection and isolated capability gates at the exact candidate source; [gate record](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/windows-build-gate.json). Windows application testing has not been rerun for this candidate.

A separate [native x264 timing experiment](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/x264-timing/analysis.json) links the app's pinned x264 and supplies identical 420-frame inputs on a 60 → 20 → 60 fps presentation timeline. CFR encoded 1.54 Mbps during the slow phase; VFR raised it to 2.04 Mbps but introduced one delayed frame and reached 6.61 Mbps during recovery. Neither result establishes a complete fix for the live picture failure. Source detail advances per submitted frame, not as a replay of the live browser fixture. [Source](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/x264-timing/gate.cpp), [packet accounting](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/x264-timing/cfr-packets.csv), [VFR packet accounting](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/x264-timing/vfr-packets.csv) and [library binding](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/x264-timing/gate-results.json) are retained. Independent FFmpeg decoding accounted for [420/420 frames in each bitstream](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/x264-timing/independent-decode.json) without decoder errors.

Changing x264 to variable timing therefore needs explicit delayed-output handling, stable association between returned packets and their source identities, a distinct output clock, and reset/reconfiguration/late-join coverage. Source identity is an opaque token and must not be repurposed as a presentation clock. No VFR runtime change is included here.

## Evidence and limits

[Manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/evidence-manifest.json) binds 81 local files, SHA-256 `26e21e294fb29ed117a626825af1b15c1130e1da6f178729a35ad054e42ca342`; [binding validation](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-nv12/validation.json). Published fields are explicitly selected. Raw control credentials, settings and unrestricted logs remain local.

Keep the Mac build experimental. Open work includes the x264 low-bitrate picture failure and acceptable load limits, current-artifact endurance/distribution, independent gameplay and physical minimum-OS/device/privacy/accessibility coverage, sleep/wake and route changes, broader Windows qualification, and the earlier recorder-clock/abrupt-close findings. Earlier artifacts' passes do not automatically qualify this binary.
