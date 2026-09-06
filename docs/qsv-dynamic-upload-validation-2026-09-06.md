# QSV dynamic hardware upload validation

Follow-up to the [runtime and native loss review](qsv-runtime-native-loss-validation-2026-09-06.md).
The application now copies raw input into FFmpeg's software frame buffer pool
before uploading default H.264 QSV input through a dynamic D3D11 hardware pool.
Dynamic hardware upload alone did not resolve memory growth in the application.
Explicit custom video filters,
hardware devices, pixel formats, or codec arguments retain their existing path.
Other codecs are unchanged.

## Diagnosis and API verification

The host remains on Intel Graphics driver `32.0.101.6881`, with a Core Ultra 7
265K and TITAN RTX. No driver was installed or replaced.

The [official Intel graphics package](https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html)
`32.0.101.8992`, dated September 2, was downloaded only for extraction.
Its 914,703,256-byte executable matched Intel's published SHA256:
`f772287365421b33f91492694fbe25235b4520f146d433af7a0d1049685ea5dc`.
Only `Graphics/libmfx64-gen.dll` was extracted. Its version is
`26.07.09.07132e60`, SHA256
`90ce4754cbc33dea58bdbcf0540dd72933d6658f3e4a9fa2724c7ce87fbf40a5`,
with a valid Intel Corporation Authenticode signature. It was selected only
through a child-process environment override; it is not shipped in the package.

A CDB breakpoint on `MFXVideoENCODE_EncodeFrameAsync` hit the extracted module's
address, confirming selection beyond merely seeing it loaded by enumeration.
A separate allocation breakpoint captured a 2,080-byte allocation through
`d3d11!CContext::VideoProcessorBlt`, `igd11dxva64`, and
`igdgmm64!GmmLib::GmmClientContext::CreateResInfoObject`. The lower driver DLLs
were still the installed versions. This identifies an allocation route consistent
with the previous heap growth; it is not complete allocation/free ownership
tracing. Large offsets from Intel exports are nearest-symbol labels, not verified
internal function names. The debugger run was interrupted after evidence capture
and is excluded from throughput and memory trend comparisons.

[FFmpeg documents hardware upload and device selection](https://ffmpeg.org/ffmpeg-filters.html#hwupload).
Its [QSV frame implementation](https://github.com/FFmpeg/FFmpeg/blob/9b6c8969e0/libavutil/hwcontext_qsv.c)
supports a dynamic pool when the initial size is zero and transfers through the
child hardware context when no internal upload session is used. The
[D3D11 transfer implementation](https://github.com/FFmpeg/FFmpeg/blob/9b6c8969e0/libavutil/hwcontext_d3d11va.c)
maps a staging texture and copies to the destination resource. This supports
using plain `hwupload` with a derived QSV device. On this host, fixed pools with
`extra_hw_frames=1` or `8` failed texture creation with `E_INVALIDARG`; the
dynamic pool succeeded. The application preserves its existing limited-range
NV12 color metadata through `setparams` before upload.

However, the source of the software frames matters. An initial packaged run with
only dynamic upload still grew approximately 8 MiB/min. A matching raw NV12
input diagnostic reproduced the growth, unlike the synthetic `lavfi` input.
Adding FFmpeg's [`copy` filter](https://github.com/FFmpeg/FFmpeg/blob/9b6c8969e0/libavfilter/vf_copy.c)
before upload removed that trend in the raw-input diagnostic. This filter obtains
a software frame from the filter buffer pool and copies both pixels and frame
properties. The final application filter is `copy,setparams=...,hwupload`.
This isolates a buffer-source-dependent behavior; it does not establish the
driver's internal ownership defect.

The initial clean diagnostics encoded 18,000 synthetic 1280x720 frames. Fitted private
memory trends exclude frames before 2,000. These are encoder isolation
experiments, not packaged application testing or browser frame-rate measurements.

| Runtime / input path | Private bytes per frame | Outcome |
| --- | ---: | --- |
| Installed runtime, system-memory input, previous control | 2,309 | Continuing growth |
| New extracted runtime, system-memory input | 2,312 | Continuing growth |
| Installed runtime, dynamic hardware upload | 44 | Plateau at 181.65–183.74 MiB |

The table above used synthetic filter input and a 2,000-frame warm-up. Follow-up
18,000-frame comparisons below use raw 1280x720 NV12 input and exclude the
first 4,000 frames because the initial allocation pool was still settling:

| Installed runtime / raw input | Private bytes per frame | Post-warm-up memory |
| --- | ---: | --- |
| Dynamic upload | 2,319 | 199.86–227.39 MiB, continuing growth |
| Software `copy` then dynamic upload | -97 | 179.45–181.66 MiB, plateau |

Matching output color flags with synthetic input did not reproduce the raw-input
growth (54 bytes/frame). A separate 7,200-frame real-time synthetic run remained
within 178.64–182.12 MiB after frame 4,000. This is why a synthetic-source result
alone is insufficient to claim the application issue fixed.

The diagnostic helper now uses a dynamic pool for `--hw-upload=1` and accepts
`--hw-pool=8` to reproduce the previous fixed-pool experiment. It also accepts
`--raw-input=<file>` (looped complete 1280x720 NV12 frames), `--realtime=1`,
`--output-color=1`, and `--copy-input=1` to distinguish the actual input path.

Diagnostic artifacts below `native-qt/qa/reports/qsv-new-runtime`:

- New runtime: `isolation/10e31a6a-8cc9-4fa2-8cbe-071b06dd11d9`.
- Dynamic upload: `dynamic-upload/3a455915-e34f-42df-822b-9e157cee035d`.
- Debugger evidence: `runtime-selected.txt`, `runtime-exports.txt`, and `allocation-stack.txt`.
- Raw upload: `upload-raw/13d44a80-b6a0-48e4-b16d-df35b0c5adba`.
- Raw copy/upload: `upload-raw-copy/145d5525-bc50-4379-9669-11f2755962a2`.
- Output metadata: `upload-output-color/f57d8361-ac15-487a-9f23-64ac3796097d`.
- Real-time synthetic input: `upload-realtime/2466a2d2-a6f5-4447-bb05-bfdb91135b47`.

## Packaged application testing

Final candidate: `native-qt/dist/qsv-pooled-upload/game-capture.exe`, SHA256
`b7ae24f9ef6c1e8c86b1a33cca5aba704212b0cd994bd04959a585bb3ed1838f`.
It contains the rebuilt Release executable and the baseline package dependencies.
Bundled FFmpeg remains `n8.1.2-34-g9b6c8969e0-20260731`, SHA256
`cfa7457eab838db74cb8888ccaf46549a931a2913312e8dede423a26ddac33d5`.
All application workflows below clear `ONEVPL_PRIORITY_PATH` and use the
installed runtime, without the previous older-runtime workaround.

### Initial candidate: rejected as a memory fix

The checks in this subsection used dynamic upload without `copy`, package
`native-qt/dist/qsv-dynamic-upload/game-capture.exe`, SHA256
`fe6a44623412a0ff87208963250a36a2cec58b6540984f2779273e514aa3aad1`.

The native OBS workflow passed 1280x720 at 60 FPS, combined resolution/bitrate/FPS
changes to 640x360 at 30 FPS and back, viewer reload, transport refresh,
signaling loss, source restart, and 5% native RTP loss. The relay dropped
108 color, 62 audio, and 35 alpha packets. Both color and alpha encoder logs
confirmed dynamic hardware upload. Three actual OBS recordings measured
59.88 distinct frames/s, approximately 440 Hz audio, no clipped samples, and
no silent 100 ms windows in the analyzed interiors. Both half-opacity screenshots
measured RGB `(143,48,254)` against `(143,48,255)`: maximum error 1/255.
Shutdown completed in 437 ms without force or remaining encoders.

Native artifacts:
`native-qt/qa/reports/qsv-upload-native/36afa501-4fed-43e6-a3f9-86c8fca757d7`,
including `results.json` and `native-loss-analysis.json`.

A separate Spout color-chart to browser workflow passed before and after viewer
reload and transport refresh. Maximum RGB patch error was 2/255, below its 4/255
limit; receiver windows measured 60.02–60.04 FPS. Shutdown took 428 ms.
Artifacts:
`native-qt/qa/reports/qsv-upload-color/c53d78af-d6dd-4f02-8ae9-7c15fc9f0637`.

Its sustained browser run was deliberately stopped after approximately four
minutes because encoder private memory still grew. This is **not** a completed
20-minute validation. The same encoder PID 20612 grew from 184.29 MiB at the
0.42-minute sample to 206.76 MiB at approximately 3.6 minutes. The run's final
video failure followed the explicit quit command and is recorded alongside
`interruption-reason.txt`. Artifacts:
`native-qt/qa/reports/qsv-upload-sustained/6e73db0a-4b85-455c-8fda-497b350522d2`.

### Final candidate: software copy and dynamic upload

The final package passed the complete **20.47-minute** sustained browser workflow
with two viewers. This included verified packet loss, transport refresh, a
signaling outage, and viewer reload. Before the sustained section it also passed
browser pause/seek/resume and combined resolution/bitrate/FPS changes to 640x360
at 30 FPS and back. Source frame IDs never moved backward during encoder handover.

| Measurement | Previous default QSV | Final pooled upload |
| --- | ---: | ---: |
| Encoder private memory, post-warm-up | 182.46–322.82 MiB | 161.57–166.73 MiB |
| Fitted encoder private-memory trend | 7.876 MiB/min | 0.0208 MiB/min |
| Publisher private-memory trend | See previous report | 0.0042 MiB/min |
| Publisher last-sent input age | 85.31–101.96 ms | 34.65–51.34 ms |
| Encoder processes during measured run | One | One, PID 24728 |

The memory trend excludes the first two minutes. The final median encoder
private memory was 162.30 MiB. The 41 resource samples all contained the same
encoder PID, so process recycling did not mask growth. Loaded-module evidence
confirms installed runtime `25.04.25.d24cd8b9` and driver `32.0.101.6881`.
The input-age median was 43.99 ms. This uses the publisher's steady-clock input
timestamp and last transport submission; it is **not glass-to-glass latency**.

Five actual receiver recordings measured **59.76, 59.76, 59.17, 59.65, and
59.56 distinct frames/s**, with no invalid frame identities and 99.83–100%
coverage of receiver-decoded frames. Both viewers' 41 post-recovery measurement
windows passed full-rate video and audio; those windows reported no freezes,
dropped frames, or concealed audio samples. Fault intervals are recorded
separately and are not included in that zero-loss statement. All five audio
checkpoints measured 439.45 Hz with no clipping. Shutdown took 425 ms, exited
normally, and left no encoder processes.

Final sustained artifacts:
`native-qt/qa/reports/qsv-pooled-sustained/814746a0-d909-41d0-8975-06b763fd96f6`,
including `results.json`, `qsv-h264-sustained.json`, `sustained-analysis.json`,
five receiver recordings, and `encoder-runtime-modules.json`.

The final package also passed the native OBS workflow, including combined
resolution/bitrate/FPS changes, half opacity, viewer and transport refresh,
signaling interruption, source restart, and 5% native RTP loss. The relay dropped
106 color, 66 audio, and 38 alpha packets. Three OBS recordings contained
59.38, 59.88, and 59.88 distinct frames/s. Their audio measured approximately
440 Hz with no clipped samples and no silent 100 ms windows after trimming
0.5 seconds from each recording end. Both half-opacity checkpoints remained
RGB `(143,48,254)` versus `(143,48,255)`, maximum error 1/255. Shutdown took
437 ms without force or leftover encoders.
Artifacts:
`native-qt/qa/reports/qsv-pooled-native/5fd55438-36d2-48c9-8a95-2532a3f6ab14`,
including `native-loss-analysis.json` and the actual OBS recordings.

The final default-filter color-chart workflow passed before and after viewer
reload and transport refresh: maximum patch error 2/255, receiver windows
58.24–60.01 FPS, and normal shutdown in 444 ms. Artifacts:
`native-qt/qa/reports/qsv-pooled-color/9dc3dcea-1753-4163-b5b3-5b37666a9d17`.

An explicit `--ffmpeg-options="-vf null"` also passed the packaged color-chart,
reload, and transport-refresh workflow at 59.93–59.98 receiver FPS, with maximum
patch error 2/255 and normal shutdown in 441 ms. The captured encoder command
contained the custom `-vf null` and no automatic hardware-device/upload arguments.
This verifies that an explicit filter retains control of its pipeline; it does
not claim that the custom path has the default path's memory fix. Artifacts:
`native-qt/qa/reports/qsv-pooled-custom-filter/ae578687-ac3c-4a24-a640-8714922e6bc7`.

## Reproduction

Run sequentially on an otherwise idle capture host. The raw diagnostic fixture
contains 60 NV12 frames (82,944,000 bytes), SHA256
`c8b2934a159fc50f6e8df5c9fd4cef8b22e0014e8b517ff25731d78869db61b4`.

```powershell
$env:ONEVPL_PRIORITY_PATH = $null
& native-qt/dist/qsv-pooled-upload/ffmpeg/bin/ffmpeg.exe -v error `
  -f lavfi -i 'testsrc2=size=1280x720:rate=60,format=nv12' -frames:v 60 `
  -f rawvideo -y native-qt/qa/reports/qsv-new-runtime/input-nv12.raw
node native-qt/e2e/ffmpeg-memory-review.js `
  --ffmpeg=native-qt/dist/qsv-pooled-upload/ffmpeg/bin/ffmpeg.exe `
  --reports=native-qt/qa/reports/qsv-raw-reproduction `
  --hw-upload=1 --output-color=1 --copy-input=1 --frames=18000 `
  --raw-input=native-qt/qa/reports/qsv-new-runtime/input-nv12.raw
```

Omit `--copy-input=1` for the growing raw-input control. Add `--realtime=1`
for paced input; the helper allows the requested duration plus a shutdown margin.

```powershell
$env:NODE_PATH = (Resolve-Path native-qt/qa/reports/receiver-runtime/node_modules).Path
$env:ONEVPL_PRIORITY_PATH = $null
node native-qt/e2e/encoder-receiver-review.js `
  --publisher=native-qt/dist/qsv-pooled-upload/game-capture.exe `
  --window-video=native-qt/qa/reports/browser-reference-60.mp4 `
  --reports=native-qt/qa/reports/qsv-pooled-sustained `
  --width=1280 --height=720 --fps=60 --cases=qsv:h264 `
  --frame-identity=1 --identity-recording=1 --require-codec=1 `
  --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 `
  --combined-video-controls=1 --handover-identity=1 `
  --sustained=1 --soak-ms=1200000 --packet-loss=5 --faults=1
node native-qt/e2e/analyze-sustained-review.js `
  native-qt/qa/reports/qsv-pooled-sustained/814746a0-d909-41d0-8975-06b763fd96f6/qsv-h264-sustained.json `
  --max-encoder-growth=1
```

## Scope

`analyze-sustained-review.js` accepts `--max-encoder-growth=1` to reject more
than 1 MiB/min of fitted encoder growth after the two-minute warm-up. When this
limit is requested it also requires a stable set of encoder processes, avoiding
a false plateau caused by encoder replacement. It reports all observed encoder
PIDs. Analysis of the prior completed E2E artifacts rejected the 7.88 MiB/min
default-runtime run and accepted the 0.023 MiB/min older-runtime run.

Release compilation, JavaScript syntax, and whitespace checks are gates only.
The workflows and analyzed recordings above are the actual testing evidence.
Results cover this Windows host and bundled FFmpeg. Other Intel generations,
alternate FFmpeg builds, cross-machine transport, and TURN are not established
by this review. Custom video pipelines intentionally opt out of automatic upload
and can therefore retain the earlier memory-growth behavior.
