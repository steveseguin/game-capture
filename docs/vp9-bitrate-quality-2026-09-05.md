# VP9 bitrate accuracy and quality

Follow-up to [fresh-frame and recovery validation](fresh-frame-validation-2026-09-05.md).

## Cause and change

Matching libvpx's minimum, maximum, and target rates selected CBR, but the
intentional all-keyframe stream still received a repeated intra-frame boost.
The bundled encoder reproduced roughly 22–24% overshoot without involving the
network. Setting `overshoot-pct=0` produced identical bitrate and SSIM, so that
option was rejected as ineffective for this case.

The VP9 defaults now include `-max-intra-rate 100`. Libvpx's
[`vp9_rc_clamp_iframe_target_size`](https://chromium.googlesource.com/webm/libvpx/+/refs/heads/main/vp9/encoder/vp9_ratectrl.c)
limits the intra-frame target to this percentage of the average frame budget.
This stops every frame receiving an exceptional keyframe budget. It limits the
encoder's target, not the exact size of each resulting packet. Small overshoot
and transport/retransmission overhead remain possible.

[FFmpeg documents the option](https://www.ffmpeg.org/ffmpeg-codecs.html#libvpx)
as an intra-frame bitrate percentage. The option is placed before advanced
overrides, allowing an explicit `-max-intra-rate` override. The existing
all-keyframe and dual-track alpha contracts remain in force.

## Encoder quality characterization (gate)

`native-qt/e2e/vp9-rate-quality.py` runs the packaged FFmpeg with identical source
frames and the production VP9 defaults, with and without the intra budget. It
retains IVF streams, checks that all expected frames exist, sums encoded payload
bytes separately from container overhead, and measures SSIM against the source
with the same scaling/FPS conversion. These isolated encoder runs are a
characterization gate, not application E2E testing.

The source is the existing moving color/detail reference clip, SHA256
`a6f0f318adce19a02cc3d8df5577dd0668056d82a776c203eb4f51f7036a3fb6`.
Each measurement covers eight seconds. Artifacts:
`native-qt/qa/reports/vp9-rate-quality-reproduced/results.json`.

| Setting | Baseline Mbps | New Mbps | Baseline SSIM | New SSIM | Largest frame, before → after |
|---|---|---|---|---|---|
| 360p30, 1 Mbps | 1.241 | 1.015 | 0.97285 | 0.96270 | 20,645 → 4,457 bytes |
| 720p60, 4 Mbps | 4.913 | 4.068 | 0.96818 | 0.96167 | 59,047 → 8,862 bytes |
| 720p60, 8 Mbps | 9.751 | 8.130 | 0.98941 | 0.98564 | 63,717 → 18,004 bytes |

Spending fewer bits reduces quality slightly; this change does not promise
identical image quality at the lower actual bitrate. SSIM is a source-specific
similarity measure, not proof of imperceptible loss. The 1-Mbps case has the
largest measured quality reduction. Real-game perceptual quality and more
complex motion/text sources remain additional coverage opportunities.

## Packaged application testing

Complete local Release package:
`native-qt/dist/vp9-intra-budget/game-capture.exe`, SHA256
`6a7805cae75ef565a4ecb50421c65aa5c8b4ced6e2cfb661a133f56bbd8b1b59`.
It includes Qt and FFmpeg runtime dependencies; it is not a published release.

Browser workflow artifacts:
`native-qt/qa/reports/vp9-intra-budget/d6b80d64-97c3-4304-a6f6-fa4609248948/results.json`.
The actual Chromium source window and public VDO.Ninja receiver passed playback
pause/seek/resume, viewer reload, verified transport rebuild, 720p60 → 360p30 →
720p60 changes with bitrate controls, 5% packet loss/removal, signaling outage,
and clean shutdown with the source paused. The codec stayed VP9 throughout.

| Receiver window | Target Mbps | Received Mbps | Decoded FPS |
|---|---|---|---|
| Moving startup | 4 | 4.055 | 59.71 |
| Paused source | 4 | 4.035 | 59.95 |
| 360p30 control | 1 | 1.012 | 29.96 |
| Restored 720p60 | 8 | 8.116 | 60.09 |

Those windows had zero video drops, packet loss, or freezes. Regular/reconnect
windows delivered 59.54–60.06 FPS. During emulated loss, video delivered 55.23 FPS
with 57 unrecovered packets and zero freezes; after removal it delivered 59.94
FPS with no new drops/loss/freezes. Shutdown took 212 ms, exit code zero, with
no orphan encoder. Embedded frame IDs stayed readable. Their observed distinct
rate is not a guarantee of 60 unique displayed images; callback gaps remain.

The E2E harness now accepts `--bitrate-ceiling-ratio=1.1` to require measured
startup, paused, and settled-control receiver bitrate to remain within 10% of
the applicable target. It is opt-in because other codecs and deliberate advanced
rate-control overrides have different contracts. This checks window averages,
not individual packet bursts or total IP-layer bandwidth.

The packaged 720p60 Spout color-bar workflow ran with that ceiling enabled and
passed: `native-qt/qa/reports/vp9-intra-color/80a76955-f46e-4ffb-a98f-ce8c276a84ff/results.json`.
Initial and final maximum RGB patch error were 2/255. Viewer reload, transport
rebuild, signaling outage, source loss/restart, and clean shutdown all passed.
Regular/recovery windows delivered 59.82–59.98 FPS. Shutdown took 428 ms with no
orphan encoder. This verifies actual received color patches, while the SSIM
comparison above characterizes the separately encoded moving reference clip.

The same package passed opaque and half-transparent Spout composition in the
real portable OBS/ninja-plugin workflow:
`native-qt/qa/reports/vp9-intra-alpha/manifest.json`. Both workflows verified the
loaded artifact hashes and four useful composited-pixel samples. These are
static transparency checks; moving-edge alpha under packet loss is not covered.

Release build, JavaScript/Python syntax, whitespace, and the isolated encoder
comparison are gates. The browser/Spout/OBS workflows above are the application
testing. No claim of a hard per-packet bandwidth cap or unchanged perceptual
quality is made.

## Reproduce

From `native-qt/`, with the browser harness dependencies on `NODE_PATH`:

```powershell
python e2e/vp9-rate-quality.py --ffmpeg dist/vp9-intra-budget/ffmpeg/bin/ffmpeg.exe --source qa/reports/browser-reference-60.mp4 --output qa/reports/new-vp9-quality-run
node e2e/encoder-receiver-review.js --publisher=dist/vp9-intra-budget/game-capture.exe --window-video=qa/reports/browser-reference-60.mp4 --reports=qa/reports/new-vp9-browser-run --width=1280 --height=720 --fps=60 --cases=auto:vp9 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --frame-identity=1 --packet-loss=5 --require-codec=1 --faults=1 --shutdown-window-paused=1 --bitrate-ceiling-ratio=1.1
```
