# Live encoder reconfiguration and first-frame preservation

## Confirmed defect

The external FFmpeg rawvideo input used `-fflags +nobuffer`. During initial
stream analysis, FFmpeg consumes an input packet. With this flag it does not
retain that packet for encoding. The bundled encoder reproduced loss of the
first captured frame. The application waits for output before sending another
frame, so this also adds a startup delay, especially with VP9's initial
500-ms output wait. Reconfiguration starts a warm-up encoder and then a clean
live encoder, exposing both to this delay.

[FFmpeg's format documentation](https://ffmpeg.org/ffmpeg-formats.html)
describes the flag as reducing buffering during input analysis.
[Its demux implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/demux.c)
in `avformat_find_stream_info` retains analysis packets only when
`AVFMT_FLAG_NOBUFFER` is absent. The production change removes this flag from
the external rawvideo input. It preserves the intentional warm-up/fallback
checks and the clean pipeline replacement that prevents probe-frame leakage.

Discarding an input also shifts the application's FIFO association between
input timestamps and encoded packets. Earlier native packet/frame-ID traces
therefore cannot establish exact image-to-packet identity for those pipelines.
Their capture counts and receiver measurements remain separate observations.

## Characterization gate

`native-qt/e2e/ffmpeg-first-frame.py` feeds two distinctly shaded NV12 frames
to the packaged VP9 encoder. It waits for a complete first IVF packet before
sending the second input, then decodes the retained stream to verify count and
order. This is an encoder gate, not application E2E testing.

Artifacts: `native-qt/qa/reports/retained-first-frame-gate-2/results.json`.
With `nobuffer`, no packet arrived before the second input and only the second
frame survived (decoded gray mean 191/255). Without it, a complete packet
arrived in 47 ms and both frames survived in order (means 75 and 191/255).
The initial invocation used an incorrect FFmpeg path and produced no stream;
the recorded successful run uses the package's `ffmpeg/bin/ffmpeg.exe`.

## Packaged application workflow

Baseline: `native-qt/dist/vp9-intra-budget/game-capture.exe`, SHA256
`6a7805cae75ef565a4ecb50421c65aa5c8b4ced6e2cfb661a133f56bbd8b1b59`.
Candidate: `native-qt/dist/retained-first-frame/game-capture.exe`, SHA256
`91eb4ef40f373b430bf5dc3eb91507a124c8f5d2f5fa103a9bf637482a72aef2`.
Both are complete local Release packages with runtime dependencies, not
published releases.

The workflow captures a real Chromium window playing the moving reference
clip and receives video and loopback audio through public VDO.Ninja. It checks
source pause/seek/resume, viewer reload, transport rebuild, live settings,
moving decoded output, active audio, and shutdown with the source paused.
Settings alternate between 720p60 and 360p30, with 8- and 1-Mbps targets.

Separate commands change resolution/FPS first and bitrate after the receiver
sees the new format. The candidate also exercises the already-supported
combined command:

```json
{"action":"requestResolution","remote":"<stream>","value":{"w":640,"h":360,"f":30},"targetBitrate":1000}
```

This uses the shared authorized `targetBitrate` field and applies one runtime
configuration. No production control API or debounce behavior changed.
The harness's `--combined-video-controls=alternate --control-cycles=2` runs
one cycle of separate controls followed by one combined cycle. It records
receiver counter deltas over each full transition window, including settling
and the subsequent output measurement. Freeze duration is Chromium's
`totalFreezesDuration`, not a measurement of command processing alone.

Baseline artifacts:
`native-qt/qa/reports/reconfigure-baseline/f477b3c3-f259-4124-9312-0f2c7a9ec7e5/results.json`.
Candidate artifacts:
`native-qt/qa/reports/reconfigure-candidate/5542cb5f-1fd4-4391-9516-46c8a7993d48/results.json`.

| Encoder / destination | Baseline separate freeze seconds | Candidate separate | Candidate combined | Candidate combined dropped frames |
|---|---:|---:|---:|---:|
| QSV / 360p30 | 2.877 | 2.641 | 1.274 | 0 |
| QSV / 720p60 | 2.744 | 2.436 | 1.224 | 7 |
| NVENC / 360p30 | 5.027 | 4.405 | 2.266 | 0 |
| NVENC / 720p60 | 1.526 | 1.191 | 0.746 | 0 |
| VP9 / 360p30 | 2.532 | 0.306 | 0 | 0 |
| VP9 / 720p60 | 2.395 | 0.196 | 0 | 0 |

All three candidate workflows passed. Baseline separate transitions each
recorded two freezes; candidate separate transitions recorded two for hardware
encoders and one for VP9. Combined hardware transitions recorded one freeze
each; combined VP9 recorded none. Zero reported freezes does not prove a
gapless transition: Chromium applies its own freeze threshold. These are
single-run observations on a shared workstation, not statistical performance
bounds. There was no baseline combined run, so the combined column must not
be attributed entirely to the production change.

Candidate separate transitions dropped no receiver frames. The baseline
NVENC upshift dropped three. The candidate QSV combined upshift dropped seven,
so this coverage does not establish universally lossless transitions. All
12 candidate transition windows had zero concealed audio samples and active
audio after the change. This is counter-based continuity evidence, not a
listening assessment or proof of A/V synchronization.

After changes, measured candidate decode rates were 29.74-30.08 FPS at 30 FPS
and 59.03-59.91 at 60 FPS. VP9 received approximately 1.012 Mbps at the 1-Mbps
target and 7.989-8.076 Mbps at 8 Mbps. VP9 warm-up logs consistently produced
output on frame one, versus frame two in the baseline. Logs confirm combined
commands applied the requested bitrate alongside resolution/FPS in one
reconfigure; separate commands applied a later bitrate update.

All three recovered through viewer reload and explicit transport refresh,
retained their requested codec, and exited without forced termination or
orphaned encoder processes. This run does not repeat packet-loss, encoder
crash, or signaling-outage coverage from earlier reports.

## OBS transparency regression: strict workflow failed

The candidate ran through real OBS with the native VDO.Ninja plugin and the
Spout opaque/50%-alpha fixtures. The existing strict wrapper failed both cases.
A subsequent baseline run passed both cases using the same isolated OBS
runtime and plugin. Reports are respectively:

- `native-qt/qa/reports/reconfigure-alpha/manifest.json`
- `native-qt/qa/reports/reconfigure-alpha-baseline/manifest.json`

Investigation of the retained screenshots found four useful composites per
candidate case. Every useful frame passed the existing expected-color,
alpha-composition, and visual-epoch pixel checks. The sequence check rejected
four distinct decoded pixel hashes because it requires exactly one for a
static fixture. Lossy VP9 can vary reconstructed pixels while encoding the
same static source, so exact decoded-image identity is stronger than source
stability. Earlier background-only captures were correctly classified as
waiting samples. The checker abort also left plugin-binding metadata incomplete;
the strict report must not be represented as an overall pass.

`native-qt/qa/reports/reconfigure-alpha/pixel-investigation.json` retains the
separate screenshot analysis. Opaque frames had at most 1.964/255 mean absolute
error in any channel against the expected color; 50%-alpha frames had at most
1.0/255. Maximum individual-channel variation relative to the first useful
frame was 13/255 for opaque and 8/255 for half alpha. These are small startup
reconstruction differences, not bit-identical output. The timing change is
consistent with the candidate exposing early encoder convergence that the
baseline's extra wait avoids; no claim of a definitive internal rate-control
cause is made.

This establishes correct sampled composites but leaves the strict transparency
workflow failing. Its static-identity criterion needs a separately reviewed
lossy-image tolerance while retaining stale-frame, wrong-color, and incorrect
alpha rejection. The external plugin harness was not modified in this change.
Moving alpha, live alpha reconfiguration, and subjective audio/video quality
were not validated by these static fixtures.

## Gates and remaining scope

The Release build, JavaScript syntax, diff whitespace, and first-frame encoder
characterization gates passed. They supplement the actual packaged application
testing above. Hardware encoder replacement still freezes video, and one QSV
transition dropped frames. Eliminating those interruptions would require a
larger encoder handover or live-update design with separate lifecycle and
resource-overlap validation; this change does not remove intentional warm-up
or fallback checks to hide that cost.
