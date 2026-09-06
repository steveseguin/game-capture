# Browser distinct-frame follow-up

This follows the browser-cadence limitation in
[the OBS cadence report](obs-source-cadence-validation-2026-09-06.md).
Decoded FPS, display callbacks, and distinct recorded images are now measured
separately. No capture scheduling or codec policy has been changed in this
follow-up: the confirmed defects were in the measurement harness.

## Confirmed harness defects and fixes

The headed Chromium source used a fixed Playwright viewport that could exceed
its physical client area. Windows capture then saw a clipped page, including
an entirely missing barcode. The retained failure screenshot shows the
clipping in `browser-identity-recording/9dc7bafc-4a44-4b47-b15c-b22e6e1a2ac6`.
The fixture now requests a window size and uses `viewport: null`, allowing the
video layout to follow the real client area. Actual window, viewport, display,
and video bounds are saved with the results.

Local-file playback was sufficient for display but Chromium rejected
`captureStream()` as cross-origin media. The fixture now uses a loopback HTTP
server exposing only its HTML and video resources, with byte-range support
for seek/replay. Browser security is unchanged. The rejected local-file
recording attempt is retained in
`browser-identity-physical-window/e9abed8f-c076-4af2-abf7-72a47e078c60`.

The first receiver counter window included serialization and transfer of the
recording back to Node. Decoding continued during that transfer, adding about
20 frames to a 10-second denominator. Counters are now captured inside the
page immediately around recording, before blob serialization. The harness
requires the recording frame count to cover 98–102% of that decoder window.

## Measurement and API contracts

The source clip embeds a 12-bit frame ID and its complement in each image.
The receiver's WebRTC video track is cloned for a 10-second VP8 recording;
the original playback track is preserved. A separate recording observes the
source element's `captureStream()` output. Tracks owned by these probes are
stopped afterward. FFmpeg decodes every recorded frame with timestamp
passthrough, without an FPS filter that could synthesize duplicates. A
low-resolution strip preserves the barcode while avoiding full-frame RGB
buffering. Unreadable IDs and incomplete decoding fail the workflow.

`analyze-browser-cadence.js` aligns capture, encoder input, packet, and send
identities to the receiver recording's wall-clock window. It also searches
for an exact contiguous match between the complete recording ID sequence and
sent frame IDs. That comparison distinguishes actual repeated output from
missed display callbacks or recording drops. Frame counts at the two wall
boundaries may differ slightly because the pipeline has latency.
The analyzer also requires distinct changes to reach at least 95% of the
lower of the requested output and fixture frame rates. This is separate from
its recording-completeness check, so a 60 FPS container full of repeats fails.

The application adds opt-in `capture-arrival` and `capture-rejected` timestamp
stages to the existing bounded frame trace, before admission and GPU readback.
Arrival here means a frame selected from the Windows frame pool for processing;
the existing skipped-before-readback counter also covers deliberate queue
draining. Neither trace stage reads pixels from rejected frames.

The relevant contracts were checked against the primary specifications:

- [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/): recording
  consumes media tracks and returns recorded chunks.
- [Media Capture from DOM Elements](https://www.w3.org/TR/mediacapture-fromelement/):
  `captureStream()` captures rendered media and preserves origin restrictions.

The DOM source recording is a separate capture path, not an exact count of
Windows compositor images. In these runs it sometimes contained more repeats
than Windows capture. It must not be used alone to attribute loss to source
rendering. Likewise, callback-based pixel observations remain best-effort
samples rather than an exhaustive frame inventory.

## Initial packaged comparison

Artifact root for all relative run paths in this report:
`native-qt/qa/reports/`.

`browser-identity-localhost/e0fa5ce4-7171-44be-ae86-31a89d672344` used the
previously validated package `dist/obs-cadence-reliable`, executable SHA256
`abf681e9a033ada1ccefa24825d0d55c9eb00a23fc5441c7530a77938e70aafb`.

| Codec | Capture image changes/sec | Receiver recorded changes/sec | Recording matches consecutive sent IDs |
| --- | ---: | ---: | --- |
| QSV H.264 | 58.51 | 58.41 | Yes |
| VP9 | 59.66 | 59.66 | Yes |
| NVENC H.264 | 58.45 | 58.35 | Yes |

All three passed real playback, pause/seek/resume, viewer reload, transport
refresh, 360p30/720p60 changes, and clean shutdown. QSV's presentation gaps
were 83.1/82.3 ms. VP9's were 116.8/184.6 ms, consistent with its separate
cold-reconfiguration behavior.

These runs predate the counter-window fix: the strict cadence analyzer rejects
their 96.8–97.1% counter coverage. Their exact recorded-to-sent identity match
is useful diagnostic evidence, but they are not counted as passing the final
measurement-completeness requirement.

## Packaged admission diagnostic

Executable: `native-qt/dist/browser-cadence-trace/game-capture.exe`.
SHA256: `d06a09b0fb99075283aa7fb754b176e212b6ea6690ec116ea57297628cdafe2f`.
This uses the existing complete release package with the rebuilt executable;
its only application change is the opt-in timestamp tracing described above.

`browser-cadence-admission/76153074-6a25-4e45-b70a-a6f21539905c`
passed QSV H.264 recording completeness, pause/seek/resume, reload, transport
refresh, and shutdown. Receiver decoding measured 59.94–59.98 FPS in the regular
workflow windows. The recording contained 600 readable frames and three
repeats: **59.55 distinct changes/sec**, with 99.83% decoder-counter coverage,
zero decoder drops, and an exact match to consecutive sent IDs.

The aligned capture trace contained 597 distinct images over 10.008 seconds;
encoder input contained 600 images with three repeats. There were **zero
capture-admission rejections and zero skipped-before-readback frames in the
entire run**. Thus the small remaining deficit in this run was already present
in frame delivery from Windows; neither the limiter nor queue draining
discarded the missing images. Replaying the cached image keeps output cadence
when a fresh image has not arrived. Changing that policy without stronger
evidence would risk latency and paused-source behavior.
The trace contains three approximately 33.33 ms compositor-timestamp gaps,
matching the three recorded repeats. Readback through publication took a
median 4.36 ms, p95 5.81 ms, and maximum 7.66 ms in that window.

The earlier callback probe observed only 56.90 distinct images/sec and missed
25 callbacks. This demonstrates why that observation rate cannot substitute
for recorded-image analysis. This is a bounded result, not a guarantee of 60
fresh browser images every second under all compositor/load conditions.

Build and component gates passed separately: `browser-cadence-window-gates.txt`
contains 11 passing cases. The first gate launch lacked the Qt platform plugin
path; it was rerun successfully using the packaged platform plugins. Those
gates are separate from the packaged application testing above.

## Final codec, resize, handover, and color results

`browser-cadence-final/f20fb8f9-f03c-40fe-8a6d-0dab80922276` passed VP9 and
NVENC H.264 with the diagnostic package. Both passed recording completeness
and the distinct-cadence requirement, playback pause/seek/resume, physical
window resize/restore, viewer reload, transport refresh, 360p30/720p60 changes,
and clean shutdown. Regular decoded-video windows measured 59.93–60.02 FPS
for VP9 and 60.01–60.04 for NVENC.

| Codec | Recorded frames | Repeats | Distinct changes/sec | Decoder-counter coverage | Matches consecutive sent IDs |
| --- | ---: | ---: | ---: | ---: | --- |
| QSV H.264 (admission run) | 600 | 3 | 59.55 | 99.83% | Yes |
| VP9 | 600 | 2 | 59.65 | 99.83% | Yes |
| NVENC H.264 | 600 | 1 | 59.76 | 99.83% | Yes |

Every recorded ID was readable, and all three recording windows had zero
decoder drops and zero capture-admission rejections. VP9 and NVENC had two
and one approximately 33.33 ms capture-arrival timestamp gaps respectively,
matching their recorded repeats. Their maximum measured readback/publication
times were 9.27 and 7.22 ms. The resulting evidence does not identify an
encoder or receiver bottleneck; the remaining shortfalls occur before fresh
images reach the paced encoder. These runs do not establish perfectly uniform
60-image/sec compositor delivery, nor a universal cause for every Windows
delivery gap under different loads.

NVENC's two presentation gaps were **67.4/100.2 ms**, with zero reported
transition drops, freezes, packet loss, or concealed audio samples. Both
handover trace commits preserved source ordering and admitted the first live
image after commit. This preserves the approximate hardware-handover baseline;
it is not a strict sub-100 ms promise. VP9's presentation gaps were
133.8/150.0 ms, with the same zero transition counters. Shutdown took 326 ms
for VP9 and 320 ms for NVENC, both exit zero with no encoder children.

`browser-cadence-color/bd4a26e1-c526-43ee-9a73-f1fff2d71c3f` passed the same
package's software H.264 workflow at 1280×720/60, including reload and transport
refresh. Maximum RGB patch error remained **2/255** initially and after recovery,
using the software `H264 Encoder MFT`. Regular delivery measured 60.02–60.12 FPS;
shutdown took 315 ms with exit zero and no remaining encoder children.

The received NVENC image was also inspected visually: the full source content
and barcode remain visible. The application's Spout/OBS behavior is unchanged;
its previous 59.88-change/sec alpha/opaque recordings remain the baseline in
the linked OBS report. OBS was not rerun in this browser-specific follow-up.

## Reproduction

Set `NODE_PATH` to `native-qt/qa/reports/receiver-runtime/node_modules` on this
machine. Run performance workflows sequentially.

```powershell
node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/browser-cadence-trace/game-capture.exe --window-video=native-qt/qa/reports/browser-reference-60.mp4 --reports=native-qt/qa/reports/browser-cadence-admission --width=1280 --height=720 --fps=60 --cases=qsv:h264 --frame-trace=1 --frame-identity=1 --identity-recording=1 --require-codec=1

node native-qt/e2e/analyze-browser-cadence.js <case-frames.csv> <results.json> <case-name>

node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/browser-cadence-trace/game-capture.exe --window-video=native-qt/qa/reports/browser-reference-60.mp4 --reports=native-qt/qa/reports/browser-cadence-final --width=1280 --height=720 --fps=60 --cases=auto:vp9,nvenc:h264 --frame-trace=1 --frame-identity=1 --identity-recording=1 --require-codec=1 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --combined-video-controls=1 --presentation-trace=1 --handover-identity=1 --window-resize=1

node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/browser-cadence-trace/game-capture.exe --sender=native-qt/build-review2/bin/spout_test_sender.exe --reports=native-qt/qa/reports/browser-cadence-color --width=1280 --height=720 --fps=60 --cases=software:h264 --color-check=1 --require-codec=1
```
