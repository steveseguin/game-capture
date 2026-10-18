# Apple M1 load/recovery investigation — 2026-10-18 UTC

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

## Mac warning improvement

A separate Developer ID signed local candidate, runtime `b565e51c31676f7f4979999d4df576b51b6c1448` / executable `3c3de83c06314e1c0027777b5a4d9aa2cfa59c7ce2f4345b8bc58a0ec56e9f53`, changes only the Mac overload hint to recommend lower resolution/FPS or Apple VideoToolbox. The Windows NVENC/QSV wording is preserved behind the platform condition. The real packaged workflow emitted the new hint 4 times and no Windows hint. This checks the emitted application event/log, not its GUI presentation.

The candidate reused 38 hash-verified unchanged application objects, rebuilt the changed unit, linked against verified dependencies and passed signature gates. Its three-cycle run is the final table row. It is **not notarized or published**, and does not replace the notarized defaults draft. Existing Windows packaged results remain bound to their earlier source/artifact; Windows was not rerun for this Mac-only wording change.

## Evidence and remaining work

[Measurements](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/measurements.json), [manifest](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/evidence-manifest.json), [binding validation](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/validation.json), [IDR header trace](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/first-idr-headers.json), [commands](https://github.com/steveseguin/video-encoder-testing/blob/main/knowledge/2026-10-18-apple-m1-load-recovery/commands.json), plus the reusable capture/replay scripts in the benchmark directory. The manifest binds 92 local files; SHA-256 `d2dc32846b2243cfe94570445d6aacc981fafd252bbafd82d3ae5224170a3ab5`. Exports use explicit field/file allowlists; raw control credentials, preferences and unrestricted signaling logs remain local.

The app still needs acceptable load/quality limits and full-picture validation, current-artifact endurance and independent gameplay, physical minimum-OS/privacy/device/accessibility coverage, sleep/wake and display/audio-route changes, broader Windows qualification, and resolution of the earlier recorder-clock and abrupt-close findings. These short generated-source workflows do not establish production readiness.
