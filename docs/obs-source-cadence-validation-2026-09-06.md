# Spout source cadence and native OBS recordings

## Confirmed causes

The previous OBS recording had 60 output frames/sec but about 53 substantial
image changes/sec. The new moving-edge trace found repetition before encoding:
the publisher produced about 60 capture callbacks/sec with only 52 distinct
fixture positions/sec. Those repeated identities continued through encoder
submission, encoded packets, and successful browser sends. This localizes
most of the cadence deficit upstream of the OBS receiver.

The sender fixture itself used ordinary Windows sleeps. Its actual upload
trace had a 15.86 ms median interval, 29.78 ms 95th percentile, and 33.53 ms
maximum despite averaging 60 uploads/sec. Replacing that wait with a
high-resolution timer reduced the 95th percentile to 18.01 ms. With only the
fixture corrected, the old publisher recorded **57.88 distinct images/sec**.
Most of the original 51–53 FPS observation was therefore a fixture timing
artifact, not an OBS decoder throughput ceiling.

Spout's `ReceiveImage` return value reports connection success. Its
[`ReadGLDXpixels` implementation](https://github.com/leadedge/Spout2/blob/master/SPOUTSDK/SpoutGL/SpoutGL.cpp)
can return without copying pixels when `GetNewFrame` finds no new sender frame.
The application previously stamped those unchanged reads as fresh captures.
It then called `HoldFps`, which uses an integer-millisecond sleep and resets
the clock after each iteration. The
[`SpoutFrameCount` implementation](https://github.com/leadedge/Spout2/blob/master/SPOUTSDK/SpoutGL/SpoutFrameCount.cpp)
confirms both frame-count behavior and that pacing policy. The bundled SDK
source was inspected as well as upstream source.

The corrected loop skips known unchanged sender counts and retries after 1 ms,
instead of waiting another complete frame period. Successful captures advance
an absolute frame deadline; a slow/stopped source cannot accumulate a burst of
catch-up callbacks. Sender metadata polling and stale-source recovery use
elapsed time so faster retries do not prematurely trigger reconnects. Senders
without usable frame counts retain paced capture. Identical pixels with an
advancing sender count remain valid fresh frames.

The first absolute-clock prototype still used ordinary sleeps and showed
15.6 ms wakeup quantization. The final wait uses a thread-owned, automatically
closed timer with Microsoft's documented
[`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createwaitabletimerexw)
flag. It converts the remaining steady-clock interval to a negative relative
100-ns due time using
[`SetWaitableTimer`](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-setwaitabletimer).
Unsupported/failed timer creation falls back to ordinary sleep. No global
timer-resolution or Spout registry setting is changed.

Spout frame counting is disabled on this machine. The unchanged-count branch
therefore does not explain improvements in these runs; they validate the
pacing fallback for sources without usable counts. A slow-source gate initially
expected count-aware behavior under this unsupported precondition and failed.
It now explicitly skips when frame counting is disabled rather than changing
the user's global Spout settings. The limitation remains visible in gate logs.

Capture timing alone did not fix the whole path. With a precisely paced
fixture and capture worker, an aligned eight-second interval had 481 distinct
captures but 19 repeated encoder inputs. The encode worker's timed condition
variable wait still woke unevenly. It now uses the same precise deadline wait,
retaining the existing four-millisecond maximum fresh-frame grace and cached
output for paused sources. Frame publication and consumption also update the
pending image and readiness flag under the same lock order; the previous split
handoff could leave readiness set for an image already consumed. Grace polling
releases the lock and waits in at most one-millisecond timer slices, without
busy-spinning. Stop waits at most the current output slot rather than relying
on a condition variable notification.

That change produced 481 distinct captures, inputs, and packets in an aligned
8.015-second interval. Only 476 exact alpha pairs reached OBS, however. The
alpha worker used a single completed-packet slot: a second finished mask
overwrote the first before the primary worker consumed it. Completed masks
now use a FIFO bounded to 16 packets, matching the existing pairer's bound;
the primary worker drains all available completions. Generation changes and
shutdown clear the queue as before.

The H.264 comparison exposed why these omissions also matter for correctness.
An earlier run sent 62 predictive frames after one or more encoded primary
packets had been omitted from the alpha receiver. Recorded screenshots showed
black regions inside the moving blue rectangle. H.264 inter frames remain
supported, but each pair now carries its primary packet's actual encode-order
sequence. A peer can continue prediction only from the immediately preceding
packet it successfully received, or from a keyframe. A missing dependency
requests a fresh keyframe and withholds dependent frames. This also covers
bounded-queue overflow instead of assuming exact timestamp pairing alone
guarantees a valid H.264 prediction chain.

## Measurement

The existing moving-alpha fixture advances a blue rectangle by nine source
pixels per frame. `VERSUS_FRAME_TRACE_PATTERN=alpha-moving-edge` reads its
left edge directly from capture pixels; encoder input timestamps link those
identities to packets and sends. The trace now includes wall-clock time to
align observations with the OBS recording interval. Tracing is opt-in and
bounded; ordinary application runs do not perform this analysis.

The OBS harness compares VP9 and H.264 with `--obs-alpha=0` or alpha enabled.
It verifies the loaded native receiver DLL hash, records real 720p60 output,
waits for the recording to finish, then decodes every recorded frame. In
addition to whole-image differences, a full-resolution scanline measures
rectangle-edge changes independently of small compression differences.
`e2e/analyze-obs-cadence.js` reports capture, encode, send, and recorded cadence.
Legacy traces without wall time are explicitly labeled as a comparison of
their final eight seconds, rather than a precisely matched recording window.
New `alpha-pair` and `alpha-sent` stages specifically trace completed pairs and
successful native-receiver delivery, separately from ordinary browser sends.
The analyzer rejects predictive gaps in the delivered H.264 sequence.
The OBS cadence requirement is now 95% of requested FPS for both substantial
image changes and full-resolution edge changes (57 distinct images/sec at
60 FPS), configurable with `--obs-cadence-min`. The old 80% floor could accept
the very deficit this investigation was intended to measure.

The opaque startup check initially sampled before OBS finished connecting.
It now allows up to twenty seconds to obtain moving images, consistent with
the alpha startup check. The failed attempts remain as evidence and are not
counted as application failures.

## Baseline artifacts

Evidence paths are relative to `native-qt/qa/reports/`. The diagnostic baseline
package is `native-qt/dist/obs-cadence-trace`; production capture behavior is
unchanged from the previously validated `continuous-handover` package.
The native OBS DLL remains SHA256
`396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47`.

- Alpha VP9: `obs-cadence-alpha-baseline/822f6e6c-3d68-408d-9f53-ad9cc71c1268`.
  The final trace window had 60 capture callbacks/sec, 52.25 image changes/sec,
  and 61 repeated capture identities. Packet/send changes were 52.13/sec.
  OBS recorded 51.41 changes/sec, with zero render/output skips. The first
  browser stage ran about 51 FPS; subsequent completed workflows restored
  about 60 FPS, so this baseline is not a full-rate pass for every stage.
- Opaque comparison, corrected startup wait:
  `obs-cadence-opaque-baseline-ready/479fcdc6-962d-4d01-a270-628f4392ca68`.
  VP9 recorded 53.14 changes/sec by both image and edge measurements. The
  final capture trace had 52.75 changes/sec despite 59.88 callbacks/sec.
  H.264 recorded 52.67 changes/sec, also with zero render/output skips.
- Premature opaque startup checks:
  `obs-cadence-opaque-baseline/97f3791d-48f1-4454-baba-b1e3a67cd809`.
- Ordinary-sleep prototype:
  `obs-cadence-alpha-after/669ced4a-fe7f-4b7f-b770-1996e732fde2`.
- High-resolution capture, original coarse sender:
  `obs-cadence-precise-alpha/20f15d3b-0012-4884-862f-63ede694f705`.
  The aligned interval had 54.21 capture changes/sec, 52.09 packet changes/sec,
  and 50.91 OBS changes/sec. This exposed the sender's uneven upload timing.
- Corrected sender, old publisher:
  `obs-precise-source-old-publisher/da5c4a0b-2a14-465b-9cb3-d25bc5620660`.
  OBS recorded 57.88 changes/sec, with zero render/output skips.
- Precise capture, corrected fixture, coarse encode wait:
  `obs-cadence-final-alpha/1a924ed2-7548-4f7f-9a5d-2e29934d5940`.
  VP9 recorded 56.39 distinct images/sec; H.264 failed composition after a
  format change. The trace exposed repeated inputs and missing alpha pairs.
- Precise capture and encode, single alpha completion slot:
  `obs-paced-video-alpha/1695daf2-9fcc-44ec-b469-8dbb88b8a023`.
  VP9 recorded 59.25 distinct images/sec; H.264 still failed composition.

## Gates and testing scope

Build, syntax, and Qt checks are gates, not packaged end-to-end testing.
The existing Spout gates passed alpha geometry, resizing, and same-name sender
restart (`spout-cadence-gates.log`, six passing cases including setup/cleanup).
The new slow-sender gate checks that a 10 FPS static sender does not produce
60 supposedly fresh capture callbacks/sec. It also checks that advancing
sender frames with identical pixels are still accepted.

## Final packaged alpha results

Package: `native-qt/dist/obs-cadence-reliable/game-capture.exe`, SHA256
`abf681e9a033ada1ccefa24825d0d55c9eb00a23fc5441c7530a77938e70aafb`.
Fixture SHA256:
`cfaf610a3498f4ac0aad4df25e1721b78b3f1fbd93c71a7ae89c4e5da44746ab`.
No OBS plugin code or binary was changed.

`obs-cadence-reliable-alpha/b147d86a-46a6-44a9-adfb-78a4dbd1ed6b`
passed NVENC H.264 and VP9 alpha workflows: initial composition, 360p30 and
720p60 changes, same-name sender restart between changes, browser reload,
and transport refresh. Every composition checkpoint passed, including the
first non-background image. Browser delivery after completed workflows was
59.87–60.08 FPS. Shutdown took 0.318–0.433 seconds with exit code zero and no
remaining encoder children.

Both OBS recordings contained **482 frames, with all 481 consecutive-frame
comparisons changing**. Both image-difference and full-resolution edge methods
measured **59.88 changes/sec**, with zero held comparisons and zero OBS
render/output skips. The aligned publisher traces had no repeated capture or
encoder input identities, and no missing alpha completions relative to
encoded primary packets. No H.264 predictive gap was delivered anywhere in
the completed run.

Recording SHA256s:

- H.264: `a00135c77f64c73f15d0c450ad0b91099bc9e5810115a3fdd72a0aa907df5e26`
- VP9: `83a885b1c1a5f08f0166bae3cc2df06cf9b3a42cc2ce74cfe31d5bafa6a98cde`

Final policy gates: `obs-cadence-alpha-gates.log` (34 passing cases) and
`obs-cadence-route-gates.log` (5 including setup/cleanup). They cover exact
pairing, reset/ordering, H.264 missing-dependency recovery, and existing
handover/alpha-route contracts. `spout-cadence-final-gates.log` had six passes
and one explicitly skipped frame-count-dependent case. These are separate
from the packaged OBS/browser testing above.

## Final opaque comparison

`obs-cadence-reliable-opaque/15a4a748-5972-487d-b8bc-3c0b65c297f8`
passed VP9 and NVENC H.264 with alpha disabled, using the same package and
precisely paced source. Both recordings again had 482 frames and 481 changing
comparisons: **59.88 distinct image changes/sec**, zero held comparisons, and
zero OBS render/output skips. The aligned capture and encoder traces had no
repeated identities. Browser delivery after completed workflows was
59.90–60.09 FPS. Shutdown took 0.421–0.527 seconds with no encoder children.

| Codec | Alpha | OBS distinct changes/sec | OBS render/output skips |
| --- | --- | ---: | ---: |
| H.264 NVENC | Enabled | 59.88 | 0 / 0 |
| VP9 | Enabled | 59.88 | 0 / 0 |
| H.264 NVENC | Disabled | 59.88 | 0 / 0 |
| VP9 | Disabled | 59.88 | 0 / 0 |

The change-rate metric counts transitions between images, so 481 changes
across 482 fully distinct frames is slightly below the recording's 60 FPS.
These are bounded local runs, not a guarantee of perfect cadence under every
source, load, network condition, or platform. A missing H.264 dependency under
overload now waits for a new keyframe, which favors correct video over
displaying a broken prediction chain.

## Final browser recovery and handover regression

`cadence-browser-regression/d2762ed9-66ab-4050-b167-efd00dd211d8`
passed both QSV and NVENC H.264 using the final packaged executable and a
browser window playing the frame-identity fixture. Completed 60 FPS stages
measured 59.95–60.09 decoded FPS for QSV and 59.91–60.08 for NVENC.
Both passed pause/seek/resume, reload, transport refresh, 360p30/720p60
changes, rapid controls, failed replacement preparation, two viewers, two
forced encoder crashes, and shutdown during preparation. Shutdown took
1.733 seconds for QSV and 0.421 seconds for NVENC, with exit code zero and no
remaining encoder children.

The two normal resolution/FPS transitions had maximum observed presentation
gaps of 82.7/83.0 ms for QSV and 67.5/100.3 ms for NVENC. Both had zero
reported dropped frames, freezes, lost packets, concealed audio samples,
and backward media timestamps across those transitions. These measurements
remain approximately within the previous 68–100 ms handover baseline;
they do not establish a strict sub-100 ms guarantee.

All four observed QSV commits and seven observed NVENC streaming commits
preserved source ordering and admitted the first live source after commit.
The full NVENC trace also includes a final replacement committed at
03:02:56.958, followed by unpublish at 03:02:56.965 and worker shutdown.
There is no subsequent packet, so the strict analyzer correctly rejects that
full trace as incomplete. `nvenc-h264-before-shutdown-frames.csv` explicitly
retains only the prefix before the final preparation marker at
`12644549106925`; its corresponding analysis JSON covers the seven streaming
commits. The terminal commit's delivery is unobserved, not counted as passing.

Browser callback-based pixel observations miss some presented frames and
also include repeated observed identities. Consequently, decoded FPS and
these ordering checks do not prove 60 distinct browser-capture images/sec.
The fully distinct image result above is specifically established by the
actual OBS recordings of the precisely paced Spout source.

## Reproduction

Set `NODE_PATH` to the existing Playwright runtime at
`native-qt/qa/reports/receiver-runtime/node_modules`. Run performance workflows
sequentially. Use `--source-precise-pacing=0` only to reproduce the old fixture's
coarse timing. Baseline traces without wall times are intentionally marked as
approximate windows by the analyzer.

```powershell
node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/obs-cadence-reliable/game-capture.exe --sender=native-qt/build-review2/bin/spout_test_sender.exe --reports=native-qt/qa/reports/obs-cadence-reliable-alpha --width=1280 --height=720 --fps=60 --cases=nvenc:h264,auto:vp9 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --combined-video-controls=1 --require-codec=1 --obs-plugin-repo=native-qt/qa/reports/fresh-phase-obs-runtime --expected-plugin-sha256=396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47 --obs-cadence=1 --frame-trace=1 --control-source-restart=1

node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/obs-cadence-reliable/game-capture.exe --sender=native-qt/build-review2/bin/spout_test_sender.exe --reports=native-qt/qa/reports/obs-cadence-reliable-opaque --width=1280 --height=720 --fps=60 --cases=auto:vp9,nvenc:h264 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --combined-video-controls=1 --require-codec=1 --obs-plugin-repo=native-qt/qa/reports/fresh-phase-obs-runtime --expected-plugin-sha256=396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47 --obs-cadence=1 --frame-trace=1 --obs-alpha=0 --presentation-trace=1

node native-qt/e2e/analyze-obs-cadence.js <case-frames.csv> <case-obs/obs-runtime-results.json> <source-frames.csv>

node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/obs-cadence-reliable/game-capture.exe --window-video=native-qt/qa/reports/browser-reference-60.mp4 --reports=native-qt/qa/reports/cadence-browser-regression --width=1280 --height=720 --fps=60 --cases=qsv:h264,nvenc:h264 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --combined-video-controls=1 --presentation-trace=1 --frame-trace=1 --frame-identity=1 --handover-identity=1 --rapid-controls=1 --replacement-failure=1 --stress=1 --shutdown-preparation=1 --require-codec=1
```
