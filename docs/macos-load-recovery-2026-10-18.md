# Apple M1 load/recovery investigation — 2026-10-18 UTC

Follow-up: [direct NV12 conversion, sequential previous-build controls and the retained x264 failure](macos-nv12-conversion-2026-10-18.md).

**Keep the Mac version experimental.** Packaged VT/x264 streams recovered after repeated 4K load, but x264 at 4 Mbps produced severe visible distortion. An independent FFmpeg decoder reproduced it from the received H.264 stream. A passing frame-rate check does not qualify picture quality.

Most runs used the notarized [defaults candidate](macos-defaults-delivery-2026-10-18.md): runtime `c459d7ada325c02945e460378d4f4acab8f1b755`, executable `ca2ecda2b36551dcb0eee8bd86c5dc8860782b9c6c04d6813438a18885ee68de`. Public Mac Beta 2 and Windows stable remain unchanged.

## Actual application workflows

Each complete run used three live 1280×720/60 → 3840×2160/60 → 1280×720/60 cycles, with 15 seconds at 4K and 10 seconds after each return. The generated moving window and received stereo audio ran continuously through existing authenticated VDO.Ninja width/height controls. No signaling or VDO.Ninja API was added. Subsequent moving/static, silence/resume, FPS controls, resize, late viewing and shutdown workflows also completed in the five runs below.

| Packaged run | 4K distinct images/s | Recovered 720p images/s | Passing 100 ms PCM windows |
| --- | ---: | ---: | ---: |
| x264, 4 Mbps, initial probe | 22.19–25.66 | 60.10–60.19 | 819 |
| x264, 12 Mbps | 18.99–20.72 | 59.29–59.90 | 853 |
| Apple VT, 4 Mbps | 22.53–23.72 | 60.07–60.19 | 824 |
| x264, 4 Mbps, corrected reader | 19.86–21.53 | 59.79–60.00 | 830 |
| x264, 4 Mbps, warning candidate | 19.99–22.20 | 60.09–60.19 | 852 |

The workload requested 60 fps at both sizes. The low 4K rates are measured limitations, not passes at 4K60. Controls stayed responsive; the measurements retain each control duration and diagnostics latency. Captured source dimensions were fitted to the configured output, so this is not native full-frame 4K source qualification.

Host: Apple M1, 8 logical CPUs, 8 GiB, macOS 26.4.1; source and receiver Chromium 145.0.7632.6 shared the Mac. x264 used four codec workers; VT/browser/OS work was not globally capped and macOS CPU affinity was unavailable. Encoders ran sequentially. Short independent decoder investigations overlapped portions of the 12 Mbps/VT workflows, so these are observed functional recovery measurements under host load, not controlled CPU-budget or encoder-efficiency comparisons. No OBS/FFmpeg/WHIP comparison, VMAF, PSNR or SSIM score is claimed.

## Failure and measurement correction

The original 4 Mbps run stopped in its second 4K phase after three unreadable decoded identities. Receiver counters showed zero lost packets, NACKs, PLIs and dropped decoded frames. Sender encode-failure, timeout and send-failure counters stayed unchanged. The first recovery had reached approximately 60 fps; the later recoveries were not reached in that original attempt.

The next run's old automated checks passed, but retained pictures showed damaged bands. [Browser frame 1754](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/browser-identity-1754.png) and the independently decoded [same identity](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/ffmpeg-identity-1754.png) show the same damage. The retained [41-frame GOP](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/distorted-gop.h264) decodes without an FFmpeg bitstream error; its first IDR has slice QP 51 in all four slices. That supports severe compression as an explanation, rather than proving malformed H.264 or a transport defect. The exact cause and acceptable operating limits remain open.

![Independently decoded fixture frame showing gray bands and lost detail](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/ffmpeg-identity-1754.png)

The identity reader had silently omitted frames when all three barcode anchors disappeared. It now counts those frames as failures. [Independent replay](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/independent-replay.json) rejects six of the 41 retained frames; cursor-obscured frames still require two agreeing rows. The original automated results are preserved, including their false-positive limitation. The corrected live repeat completed its three cycles but still retained partial row disagreements; that is not a visual-quality clearance. The 12 Mbps and VT runs had no recorded barcode disagreements with the earlier reader, which did not count complete anchor loss. They are useful follow-ups, not proof of a fix.

The [independent follow-up](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/replay-controls/results.json) replays all three retained 4K segments per control through the corrected reader: **935/935 x264 frames at 12 Mbps and 1,098/1,098 VT frames at 4 Mbps**, with no missing identities or row disagreements. Each replay begins at the first 4K IDR and includes the rest of that retained segment. All six encoded/decoded frame counts match. This closes the complete-anchor-loss observation gap for those retained segments, not general visual-quality qualification. The replay pipe-buffer optimization preserves every observation and verdict for both the 41-frame damaged clip and a 329-frame control [comparison](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/replay-controls/parser-parity.json).

[Application byte accounting](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/replay-controls/payload-accounting.json) adds a useful distinction: during 4K load, configured 4 Mbps x264 accounted for **1.52–1.76 Mbps** of video data; configured 12 Mbps x264 accounted for **3.43–3.58 Mbps**; VT at configured 4 Mbps accounted for **3.95–4.03 Mbps**. These are encoded bytes accepted for sending to one viewer over the diagnostics interval, not wire bitrate. Counts and elapsed times are retained for recomputation.

The [linked x264 source review](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/replay-controls/linked-x264-source-review.json) identifies a plausible contributor. The Mac encoder supplies fixed-rate frame-number timestamps, and x264's ABR time budget then advances by encoded frame count/configured FPS. Dropping frames before encoding can therefore leave bitrate unused. This is an inference consistent with the measurements, not proof of every distortion's cause. A variable-rate change needs architectural work: the linked x264 implementation adds one buffered frame, while this app currently requires immediate output and matching source identity. See the pinned [rate-control implementation](https://github.com/mirror/x264/blob/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/encoder/ratecontrol.c#L2589) and [buffering behavior](https://github.com/mirror/x264/blob/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/encoder/encoder.c#L1612). No speculative rate-control change was shipped.

## Mac warning improvement

A separate Developer ID signed local candidate, runtime `b565e51c31676f7f4979999d4df576b51b6c1448` / executable `3c3de83c06314e1c0027777b5a4d9aa2cfa59c7ce2f4345b8bc58a0ec56e9f53`, changes only the Mac overload hint to recommend lower resolution/FPS or Apple VideoToolbox. The Windows NVENC/QSV wording is preserved behind the platform condition. The real packaged workflow emitted the new hint 4 times and no Windows hint. This checks the emitted application event/log, not its GUI presentation.

The candidate reused 38 hash-verified unchanged application objects, rebuilt the changed unit, linked against verified dependencies and passed signature gates. Its three-cycle run is the final table row. It is **not notarized or published**, and does not replace the notarized defaults draft. Existing Windows packaged results remain bound to their earlier source/artifact; Windows was not rerun for this Mac-only wording change.

[Windows build run 39089737636](https://github.com/steveseguin/game-capture/actions/runs/39089737636) passed compile/link, backend-selection and isolated capability gates at source `4467835a5c94288502017ef132f8c62e2a569232`, which has the same runtime as `b565e51`. This is a build gate, **not Windows application testing**. [Gate record](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/replay-controls/windows-build-gate.json).

## Evidence and remaining work

[Measurements](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/measurements.json), [manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/evidence-manifest.json), [binding validation](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/validation.json), [IDR header trace](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/first-idr-headers.json), [commands](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/commands.json), plus the reusable capture/replay scripts in the benchmark directory. The manifest binds 92 local files; SHA-256 `d2dc32846b2243cfe94570445d6aacc981fafd252bbafd82d3ae5224170a3ab5`. Exports use explicit field/file allowlists; raw control credentials, preferences and unrestricted signaling logs remain local.

The app still needs acceptable load/quality limits and full-picture validation, current-artifact endurance and independent gameplay, physical minimum-OS/privacy/device/accessibility coverage, sleep/wake and display/audio-route changes, broader Windows qualification, and resolution of the earlier recorder-clock and abrupt-close findings. These short generated-source workflows do not establish production readiness.
