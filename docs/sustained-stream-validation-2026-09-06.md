# Sustained streaming, recovery, and memory review

Follow-up: [QSV runtime isolation and native OBS loss/opacity validation](qsv-runtime-native-loss-validation-2026-09-06.md).

The completed browser workload comprises three sequential 20-minute sessions: QSV H.264,
NVENC H.264, and VP9. Each uses a real browser playing the numbered animation
fixture, the packaged publisher, and two persistent VDO.Ninja viewers. This
extends the short recordings in
[the browser identity report](browser-frame-identity-validation-2026-09-06.md).

## Workload and evidence

Package: `native-qt/dist/browser-cadence-trace/game-capture.exe`.
SHA256: `d06a09b0fb99075283aa7fb754b176e212b6ea6690ec116ea57297628cdafe2f`.
The application binary is the previously validated release package. This
review changes its E2E harness and artifact-analysis tooling.

Host: Intel Core Ultra 7 265K (20 cores), Intel Graphics driver
`32.0.101.6881`, and NVIDIA TITAN RTX driver `32.0.16.1047`. These are
observations on this machine and package, not cross-device performance guarantees.

Browser run: `native-qt/qa/reports/sustained-browser/2125c4cd-56dd-435e-bdb4-2e6eada56c1e`.
Each case writes an incremental `*-sustained.json` plus five actual receiver
recordings. `analyze-sustained-review.js` summarizes those files separately
from the harness's overall workflow outcome.

- Both viewers are measured in concurrent approximately 30-second windows.
- First-viewer recordings occur at the start and around 5, 10, 15, and 20 minutes.
  They require readable frame IDs, 98–102% decoder-counter coverage, and at
  least 57 distinct changes/sec for a 60 FPS request.
- The five-minute checkpoint introduces 5% WebRTC packet loss for 12 seconds.
  Loss must be observed in receiver counters; recovery is measured afterward.
- Later checkpoints rebuild the publisher's transports, interrupt signaling
  for five seconds, and reload the first viewer while the second stays open.
- Audio RMS is checked in every normal window. Recovery checkpoints also
  verify the expected 440 Hz tone and absence of clipping.
- Publisher and child-encoder private memory, working set, handles, and thread
  counts are sampled. Trends exclude the first two minutes of warm-up.
- Latency observations include receiver processing/jitter-buffer/decode delay
  and the publisher's last-sent encoder-input age, calculated from its shared
  steady-clock timestamps. Retired peers are excluded. These are component
  timing measurements, not a direct glass-to-glass latency measurement.
  Diagnostics timestamps the start of collection and reads peer counters
  later, so age estimates can be understated. The analyzer reports and
  excludes negative ages caused by non-atomic collection; raw evidence is retained.

The [Chrome DevTools Network specification](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
documents packet-loss percentages and application of empty-pattern conditions
to P2P connections. The harness installs a zero-loss profile before connection
creation and retains it for later fault injection. This affected the selected
browser receiver; native OBS packet loss is not implied by this mechanism.

The source and tone helpers previously had fixed 30-minute lifetimes shared
across every case. Their lifetime now covers the aggregate case budget, so
multi-case long runs do not lose their fixtures partway through. The new soak
uses wall-clock checkpoints and saves intermediate evidence before asserting
success, preserving useful results when a later check fails.

## Completed QSV workload

QSV completed **20.47 minutes** with five complete recordings and all recovery
checkpoints. Recorded distinct rates were **59.35, 59.36, 59.74, 57.17, and
59.16 changes/sec**. The lowest still meets the explicit 95% cadence floor;
these results do not claim every output image was fresh.

Across 41 normal/recovered measurement windows, the two viewers had zero
reported video drops, freezes, video packet loss, or concealed audio samples.
The intentionally impaired window is excluded from those totals: it reported
8 unrecovered video packets, 55 audio packets lost, and 26,356 concealed audio
samples at the affected viewer. The other viewer reported no packet loss.

Publisher last-sent input age stayed between **85.31 and 101.96 ms**, starting
at 94.29 and ending at 97.34 ms. Receiver processing delay was bounded: the
affected viewer ranged from 17.40 to 48.76 ms after the earlier loss exposure,
and the second viewer from 9.13 to 9.44 ms. The data does not show progressive
queue-delay growth.

Publisher private memory stayed around **100–102 MiB**. However, the same QSV
FFmpeg process grew from about **165 to 323 MiB** across the run. Its post-warm-up
linear trend was **7.88 MiB/minute**. One encoder process remained throughout,
and shutdown completed in 333 ms with exit zero and no remaining encoder
children. Passing the playback/recovery checks does **not** clear this memory
growth concern.

The observed runtime modules are saved in
`native-qt/qa/reports/sustained-browser/qsv-runtime-modules.json`. They include
Intel driver `32.0.101.6881`, `libmfx64-gen.dll` version `25.04.25.d24cd8b9`,
and `libmfxhw64.dll` version `23.06.21.8762a262`.

## Completed NVENC workload

NVENC completed **20.48 minutes**. Its five recordings measured **59.46,
59.66, 59.46, 59.66, and 59.76 distinct changes/sec**, with 99.83–100%
decoder-counter coverage. Both viewers had zero drops, freezes, video packet
loss, or concealed audio samples in the 41 normal/recovered windows. The
affected viewer's deliberately impaired window reported 10 video packets
lost, 58 audio packets lost, and 27,680 concealed samples.

Publisher last-sent input age was **20.39–41.03 ms**. Receiver processing
delay was 18.98–48.60 ms for the loss-exposed viewer and 8.94–9.65 ms for
the second viewer. All five audio probes found 439.45 Hz and no clipping.

Publisher private memory remained around **100–104 MiB**. Encoder private
memory was about **327–328 MiB**, with temporary peaks up to 331 MiB and a
post-warm-up trend of **0.008 MiB/minute**. Handles and threads did not
accumulate. Shutdown took 321 ms, exited successfully, and left no encoders.

## Completed VP9 workload

VP9 completed **20.47 minutes**. Its five recordings measured **59.86,
59.76, 59.86, 59.66, and 59.46 distinct changes/sec**, with 99.83–100%
decoder-counter coverage. The 41 normal/recovered windows reported no video
drops, freezes, video packet loss, or concealed audio samples on either viewer.
The deliberate loss interval reduced the affected viewer to 55.72 FPS, with
13 dropped frames, 26 video packets lost, 71 audio packets lost, and 33,482
concealed audio samples. The unaffected viewer maintained 60.05 FPS.

All five recovered audio probes measured 439.45 Hz with no clipping. Receiver
processing delay was **7.94–8.94 ms** and **8.96–9.55 ms**. Forty valid
publisher last-sent input age estimates ranged from 4.13 to 20.10 ms; one
negative value (−110.57 ms) was excluded because diagnostics reads the
collection-start clock before the independently changing peer counters.

Publisher private memory stayed around **98–102 MiB**. Encoder private
memory rose from 132 to 134 MiB, then plateaued: the final twelve readings
were 134.094–134.098 MiB. Shutdown took 322 ms, exited successfully, and
left no encoders.

## QSV memory isolation: unresolved

Four standalone experiments each encoded 18,000 generated NV12 frames with
the bundled FFmpeg, without the publisher, browser, network, or stdin writer.
They run faster than real time and are isolation experiments, not substitutes
for the packaged application testing above. Measurements exclude the first
2,000 frames because startup allocation temporarily inflates private memory.

| Configuration | Private-memory growth per encoded frame | Artifact directory under `qa/reports/encoder-memory-isolation` |
| --- | ---: | --- |
| Publisher's QSV codec/bitrate/color/bitstream settings | 2,234 bytes | `45c8370e-1175-4a97-a654-8fe8bf7158cd` |
| H.264 bitstream filters removed | 2,192 bytes | `9da93346-e31f-43cf-b974-a609877ce1ab` |
| Explicit `low_power=1` | 2,157 bytes | `297a16a1-2c6d-4c15-ae26-ea57dec13afa` |
| Explicit `low_power=0` | 2,316 bytes | `65794028-37cb-4519-af94-a13b31293bea` |

The curves reproduce the application's approximately 7.88 MiB/minute trend
at 60 FPS. They narrow the problem to the bundled QSV encoding stack, but
do **not** establish ownership inside FFmpeg versus the Intel runtime/driver.
Removing bitstream filters and toggling low-power mode are not fixes.

An additional explicit Intel D3D11/QSV hardware-upload experiment failed
before encoding with `Could not create the texture (80070057)`; it provides
no validated workaround. Its final command/log are retained in
`e5579a64-0387-45bb-aeb3-b069f82492bb`. Device derivation and vendor selection
were checked against [FFmpeg's hardware-device documentation](https://ffmpeg.org/ffmpeg.html#Advanced-Video-options),
and frame uploads against [the hwupload documentation](https://ffmpeg.org/ffmpeg-filters.html#hwupload).

The exact bundled [FFmpeg QSV encoder source](https://github.com/FFmpeg/FFmpeg/blob/9b6c8969e0/libavcodec/qsvenc.c)
was reviewed alongside current upstream. The old aligned-frame-reference
leak is already addressed with `av_frame_replace`; it does not justify an
application patch here. No speculative driver update or encoder-restart
workaround was applied. QSV memory growth remains an open concern; the
completed NVENC and VP9 sessions provide validated alternatives on this host.

## Recovery-check defect found during native OBS testing

The initial alpha run (`qa/reports/sustained-alpha-recovery/62e55e60-1037-4849-beac-572b8cb0378a`)
stopped QSV at its packet-loss assertion. The 12-second interval actually
recorded **101 video NACKs**, 51 lost audio packets, and 24,526 concealed audio
samples. Video recovery left the net `packetsLost` delta at zero, which the
harness incorrectly interpreted as no injection. The run remains recorded
as failed; its later recovery steps were not executed.

The [WebRTC Statistics specification](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-nackcount)
defines receiver `nackCount` as sent negative acknowledgements, while
`packetsLost` is an estimate affected by packets subsequently received.
Both the ordinary and sustained loss checks now accept a positive video
NACK delta or positive video-loss delta. Playback/audio recovery assertions
remain required afterward. The earlier completed browser sessions already
had positive video-loss deltas and are unaffected by this correction.

## Completed native OBS alpha and audio workflows

NVENC and VP9 completed in the initial alpha run above. QSV then completed
with the corrected harness in
`qa/reports/sustained-alpha-recovery-fixed/ac1d2815-4a0d-4c3c-bd1f-bae96b8ca6b1`.
Its new loss interval reported 101 video NACKs and two net lost video packets,
followed by successful full-rate video/audio recovery. The original zero-loss
counter failure remains preserved as the regression evidence.

Each successful workflow used the packaged publisher and an isolated portable
OBS with native plugin SHA256
`396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47`.
It changed 1280×720/60 to 640×360/30 and back, changed bitrate, restarted the
Spout source while using the lower format, rebuilt transports with both
receivers present, interrupted signaling, restarted the source again, and
measured a further two minutes after recovery.

All **11 alpha checkpoints per encoder** passed, each requiring ten useful
moving composite screenshots with correct opaque foreground and transparent
background regions. This moving-edge fixture does not validate half-opacity
blending. Recordings were taken after transport recovery and again after the
later source restart. The harness now retains both recordings rather than
overwriting the first recording's analysis.

| Encoder | OBS recording 1: distinct changes/sec | OBS recording 2: distinct changes/sec | OBS render/output frames skipped |
| --- | ---: | ---: | ---: |
| QSV H.264 | 59.88 | 59.88 | 0 / 0 |
| NVENC H.264 | 59.88 | 59.88 | 0 / 0 |
| VP9 | 59.25 | 59.88 | 0 / 0 |

All six recordings also passed decoded-audio analysis: **439.89–440.09 Hz**,
no clipped samples, and no silent 100 ms windows in the analyzed portion.
The analyzer trims 0.5 seconds from each recording end, leaving roughly seven
seconds per clip; it does not claim continuous recorded audio coverage of
every outage. Browser audio counters/probes cover the other measured windows.
The isolated OBS scene configuration contained no WASAPI desktop/microphone
capture, so these recordings checked the received stream's audio.

Each publisher exited normally in 435–437 ms with no remaining encoders.
The successful results are summarized in
`qa/reports/sustained-alpha-recovery-summary.json`. Native OBS packet loss was
not injected: CDP affected the browser viewer. Native OBS evidence covers
format, transport, signaling, source recovery, and alpha/audio output.

## Validation limits and changes

Testing used real packaged applications, live viewers, and recorded output:
three 20-minute browser sessions, 15 periodic receiver recordings, and the
three successful native OBS workflows with six recordings. JavaScript syntax
and `git diff --check` were separate gates. The failed initial QSV alpha run
and failed hardware-upload experiments are retained and are not counted as
successful workflows.

Changes fix the long-run fixture lifetime and false packet-loss assertion,
retain repeated OBS recording evidence, and add sustained resource/cadence
and recorded-audio analysis. No production encoder setting was changed:
QSV's memory growth is reproduced but remains unresolved. This host's
successful NVENC/VP9 runs do not establish cross-driver reliability, and
component timing estimates are not glass-to-glass latency measurements.

## Reproduction

Set `NODE_PATH` to the existing Playwright runtime at
`native-qt/qa/reports/receiver-runtime/node_modules`. Run performance workflows
sequentially. The 100,000-row frame trace is intentionally omitted for these
long sessions; periodic recordings and diagnostics remain bounded evidence.

```powershell
node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/browser-cadence-trace/game-capture.exe --window-video=native-qt/qa/reports/browser-reference-60.mp4 --reports=native-qt/qa/reports/sustained-browser --width=1280 --height=720 --fps=60 --cases=qsv:h264,nvenc:h264,auto:vp9 --frame-identity=1 --identity-recording=1 --require-codec=1 --sustained=1 --soak-ms=1200000 --packet-loss=5 --faults=1

node native-qt/e2e/analyze-sustained-review.js <case-sustained.json>

node native-qt/e2e/ffmpeg-memory-review.js --ffmpeg=native-qt/dist/browser-cadence-trace/ffmpeg/bin/ffmpeg.exe --encoder=h264_qsv --frames=18000 --reports=native-qt/qa/reports/encoder-memory-isolation

node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/browser-cadence-trace/game-capture.exe --sender=native-qt/build-review2/bin/spout_test_sender.exe --reports=native-qt/qa/reports/sustained-alpha-recovery --width=1280 --height=720 --fps=60 --cases=qsv:h264,nvenc:h264,auto:vp9 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --combined-video-controls=1 --control-source-restart=1 --require-codec=1 --obs-plugin-repo=native-qt/qa/reports/fresh-phase-obs-runtime --expected-plugin-sha256=396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47 --obs-cadence=1 --packet-loss=5 --faults=1 --soak-ms=120000

node native-qt/e2e/analyze-recorded-tone.js native-qt/dist/browser-cadence-trace/ffmpeg/bin/ffmpeg.exe "<OBS recording.mp4>"
```
