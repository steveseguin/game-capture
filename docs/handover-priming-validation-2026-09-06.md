# Hardware handover: frame order, presentation gaps, and OBS cadence

## Findings and changes

The investigation separated encoder output from actual delivery. The original
QSV package produced its first replacement packet about 0.4 seconds after the
swap. Browser presentation gaps reached 884/482 ms in the down/up transitions;
NVENC reached 433/700 ms. Source capture continued during the transitions.

There were three avoidable contributors:

1. `targetBitrate` marked the requesting peer as waiting for a keyframe before
   preparing a replacement. This suppressed valid old-encoder packets even
   though its prediction chain was intact. Shared encoder changes now preserve
   the current route during preparation. Route changes retain their separate
   keyframe gates, and an already-waiting peer is not prematurely released.
2. FFmpeg's NVENC asynchronous output queue remained enabled despite
   `-zerolatency`. Low-latency H.264 with zero B-frames now also uses `-delay 0`.
   [FFmpeg's NVENC implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/nvenc.c)
   distinguishes `zeroReorderDelay` from the `async_depth` output-ready check;
   the bundled encoder help also exposes the separate `-delay` option.
3. A clean replacement was first fed after the swap. Eligible QSV/NVENC H.264
   replacements now prepare with eight copies of a cached real frame while the
   old encoder continues. Every preparation input has a reserved non-live
   identity and is discarded, including delayed output. Initialization succeeds
   only after all eight inputs are written and a preparation keyframe has been
   observed, within a three-second bound. The first fresh input after swap is
   forced to IDR, and a non-keyframe is refused at that boundary.

The handover prefix itself is the health probe; this path no longer starts a
synthetic-probe process and then a second cold process. Normal initialization,
custom FFmpeg options, B-frame configurations, and other codecs retain the
existing initialization path. Revision/configuration/capture checks still
guard commit. Failed or stale preparations are discarded without replacing the
current encoder. The public initialization call cannot return success before
the preparation checks finish.

The boundary keyframe uses FFmpeg's documented zero-based frame-number
expression, [force_key_frames](https://ffmpeg.org/ffmpeg.html#Advanced-Video-options),
with the existing forced-IDR and repeated-header settings. No old preparation
image is used as the first live frame. The first live encode call also avoids
waiting for an Annex-B delimiter that requires the next input frame. General
output waits now sleep until the buffered byte count changes instead of
spinning on an incomplete, nonempty packet.

## Measurement method

`--presentation-trace=1` records browser compositor submission time, receive
time, media time, RTP timestamp, dimensions, and missed callbacks around each
control. `--handover-identity=1 --frame-identity=1` additionally reads source IDs
baked into video pixels across the transition and rejects backward movement,
accounting for the known 20-second fixture loop. Source IDs are observations,
not a substitute for decoded/dropped-frame counters.

The [requestVideoFrameCallback specification](https://wicg.github.io/video-rvfc/)
defines these timestamps and explicitly permits missed callbacks. Consequently,
observed-ID rates below 60 are not reported as decoder drops. The publisher's
opt-in CSV records capture, submission, packet production, successful sends,
preparation, and commit. `e2e/analyze-handover-trace.js` checks the source order
at each committed handover and separates packet-production and send gaps.

## Artifacts and intermediate evidence

All evidence directories below are under `native-qt/qa/reports/`.

| Stage | Directory | Observation |
| --- | --- | --- |
| Baseline, QSV then NVENC | `handover-gap-baseline/88edacda-cef4-447d-8cfd-4ce5aeb9892c` | QSV presentation gaps 884/482 ms; NVENC 433/700 ms. |
| First priming prototype | `handover-gap-primed/e126effb-3c0c-4951-b1bc-d8381fe9cc8f` | QSV improved to 618/183 ms; NVENC preparation rejected safely because the prototype expected more drained packets than its asynchronous queue released. |
| Real-prefix probe and NVENC delay correction | `handover-gap-final/2a8ecff7-ccc8-429e-b844-284e7766b28e` | Eight transitions passed with no backward observed source IDs, dropped frames, or concealed audio samples. NVENC gaps 316–368 ms; QSV 567–684 ms. These measurements exposed the premature peer keyframe gate and first-live delimiter wait, which were then fixed. |

The final packaged candidate is
`native-qt/dist/continuous-handover/game-capture.exe`, SHA256
`b1b3232448aa4973311ccd7770ddb195326fcf73c34d7e2522380c82a69b8dae`.

Final hardware evidence is in
`handover-continuity-final/87062b26-8d9b-43d5-8ac4-4500ca50da55`.
NVENC's down/up presentation gaps were **67.7/99.5 ms**, versus **432.6/700.0
ms** in the baseline. Chrome reported zero transition freezes, dropped frames,
or concealed audio samples; observed pixel IDs did not move backward. The
publisher trace confirms that every committed handover admitted its first live
source after commit and advanced source time, including the rapid-control burst.
The two main handovers took 64/95 ms from commit to successful send; preparation
took about 200 ms while the existing route remained active.

NVENC also passed viewer reload, transport refresh, two simultaneous viewers,
rapid settings, a killed preparation process with the original PID preserved,
two forced encoder crashes, and shutdown during preparation. Delivery after
each completed workflow was 59.71–60.11 FPS. Shutdown took 0.444 seconds,
exited with code zero, and left no encoder children. These are bounded runs on
this machine, not a universal maximum-gap guarantee.

QSV's down/up presentation gaps were **99.5/82.2 ms**, versus **883.7/482.2
ms** in the baseline. Both transitions had zero reported freezes, dropped
frames, concealed audio samples, and backward observed IDs. Preparation took
447/425 ms while delivery continued; commit-to-send took 77/66 ms. All committed
handover traces preserved source order. QSV passed the same failure, two-viewer,
crash recovery, and rapid-control workflows as NVENC, delivering 59.69–60.00 FPS
afterward. Shutdown during preparation took 1.851 seconds, exited with code
zero, and left no encoder children.

The final package also passed real NVENC session exhaustion in
`handover-pressure-final/c6e34fec-fa16-4c2b-b0cc-1bd54348ff85`. Eleven extra
hardware encoders started; the twelfth failed `OpenEncodeSessionEx`. A requested
publisher replacement then failed preparation while the original configuration
and moving video remained active at **59.76 FPS**. Releasing the helpers allowed
another bitrate change to succeed, followed by **59.81 FPS** delivery. Shutdown
during another preparation took 0.326 seconds, exited with code zero, and left
no encoder children. The harness stopped only its own helper processes.

## Gates

Build and syntax checks are gates, not application testing. The final gate
logs are `handover-route-gates.log` (5 passing cases including setup/cleanup),
`handover-encoder-gates.log` (5), and `handover-alpha-gates.log` (33).
They cover shared-bitrate route continuity, inactive alpha reservation/reset,
Media Foundation probe isolation, protected VP9 behavior, bounded external
encoder stall recovery, timestamp ordering, and alpha pairing contracts.

## OBS measurement scope

The previous isolated OBS profile rendered at 30 FPS. The new
`--obs-cadence=1` workflow explicitly configures 720p60, records real OBS output,
and measures render/output skip counters and decoded recording frames. It
uses the [OBS WebSocket protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)
for video settings, recording directory, record start/stop, and statistics.
The previous video settings and recording directory are restored afterward.
The recording analysis distinguishes substantial image changes from tiny
compression differences, retaining per-frame differences and the recording.
This measures composited output rather than assuming ten moving screenshots
prove full-rate rendering.

The first recording attempt exposed a harness race: `StopRecord` acknowledges
the request before the encoder and muxer finish. Reading immediately saw only
six seconds of complete MP4 fragments from an eight-second run. The harness
now waits for `GetRecordStatus.outputActive` to become false before decoding
or restoring settings. The asynchronous behavior is confirmed by the
[OBS request implementation](https://github.com/obsproject/obs-websocket/blob/master/src/requesthandler/RequestHandler_Record.cpp).
The failed evidence remains in
`obs-recorded-cadence/64feba7a-5573-450b-afdd-067361e79bb6`.

The corrected packaged run passed in
`obs-recorded-cadence-final/63a87747-c66a-4b06-aec8-6e23976b517c`.
The native OBS VP9 alpha receiver passed initial composition, 360p30 and
720p60 format changes, and transport refresh. The browser alongside it decoded
59.85–59.97 FPS after the completed workflows. OBS recorded **483 frames over
8.05 seconds (60 FPS)**, rendered 60.00 FPS, and reported **zero render/output
skips**. Substantial image changes occurred **53.17 times per second**; the
longest run of repeated-frame comparisons was 33.3 ms. Thus a 60 FPS output
container and zero OBS skips do **not** establish 60 distinct source images per
second. Receiver scheduling/composition cadence remains a separate follow-up;
this run does not isolate its cause. The recording's SHA256 is
`77a06b8deba6705d46cf847f6de0a2e281dd385be0af3bcc98d6e77d1fa340b4`.

## Reproduction

Use the packaged executable above, the existing 60 FPS numbered browser
fixture, and the isolated OBS runtime with its verified native DLL. The
receiver harness requires Playwright via `NODE_PATH` pointing to
`native-qt/qa/reports/receiver-runtime/node_modules` on this machine. Run the
workflows sequentially so recording and pressure helpers do not compete with
other performance measurements.

```powershell
node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/continuous-handover/game-capture.exe --window-video=native-qt/qa/reports/browser-reference-60.mp4 --reports=native-qt/qa/reports/handover-continuity-final --width=1280 --height=720 --fps=60 --cases=nvenc:h264,qsv:h264 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --combined-video-controls=1 --presentation-trace=1 --frame-trace=1 --frame-identity=1 --handover-identity=1 --rapid-controls=1 --replacement-failure=1 --stress=1 --shutdown-preparation=1 --require-codec=1

node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/continuous-handover/game-capture.exe --sender=native-qt/build-review2/bin/spout_test_sender.exe --reports=native-qt/qa/reports/obs-recorded-cadence-final --width=1280 --height=720 --fps=60 --cases=auto:vp9 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --combined-video-controls=1 --require-codec=1 --obs-plugin-repo=native-qt/qa/reports/fresh-phase-obs-runtime --expected-plugin-sha256=396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47 --obs-cadence=1

node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/continuous-handover/game-capture.exe --window-video=native-qt/qa/reports/browser-reference-60.mp4 --reports=native-qt/qa/reports/handover-pressure-final --width=1280 --height=720 --fps=60 --cases=nvenc:h264 --session-pressure=1 --shutdown-preparation=1 --require-codec=1
```
