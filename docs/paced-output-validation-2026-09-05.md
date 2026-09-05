# Paced output and receiver follow-up

This follows the QSV drops and unique-frame measurement gaps in the
[capture/color review](capture-color-validation-2026-09-05.md).

## Confirmed issues and changes

The maintenance timer could encode a cached image independently of the paced
encode worker. Both paths serialized on the encoder mutex, but they assigned
output timestamps before acquiring it. Maintenance could therefore insert an
extra frame between output slots or compete with a worker waiting through
reconfiguration. This is redundant with the current worker, which already
repeats cached images at the configured output cadence. Maintenance now requests
a keyframe from that worker. Its peer recovery and periodic information work
remain in place.

The worker previously advanced its deadline before encoding, so a long encode
or reconfiguration wait could be followed immediately by a stale scheduled
frame. It now checks the deadline after encoding too. One late slot is allowed;
a longer backlog is skipped. A candidate that skipped every elapsed slot was
rejected after packaged VP9 delivered only 45–47 FPS and paused NVIDIA output
fell to 55.76 FPS. The final policy avoids imposing another whole frame interval
on work that only slightly exceeds its budget. Regression gates cover sustained
17-ms work at a 60-FPS request and recovery from an 800-ms stall.

The E2E harness now records counters across control transitions, verifies actual
transport-generation changes, repeats resolution/FPS controls and reconnections,
and checks that a paused source continues delivering encoded video. Rebuilding
a transport deliberately rotates its wire-session ID; the check follows UUID
and peer creation time instead. A lower-FPS control must reach both the lower
and upper receiver FPS bounds before the next control is sent.

## Measurement interpretation

The instrumented source is a 20-second lossless VP9 browser clip with a 12-bit
frame ID embedded in its pixels. Complement bits reject damaged readings and a
black border prevents locator colors from merging with the scene. An early
browser-overlay experiment was replaced because independently painted overlays
are unsuitable for identifying the video's own frames.

Receiver IDs are sampled with
[`requestVideoFrameCallback`](https://wicg.github.io/video-rvfc/). Its callbacks
are best effort: missed callbacks and repeated IDs are recorded separately.
`uniqueObservedFps` is a lower observation count, not an exact physical display
measurement. Fresh capture and decoded frame counters do not establish unique
content delivery. The paced worker deliberately repeats its latest cached image
when a fresh one is unavailable; the capture and output clocks are independent.

[`framesDropped`](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-framesdropped)
includes pre-decode drops and frames missing a display deadline, so it does not
alone identify an encoder fault. Baseline package `4d725875…` reproduced nine
transient drops during one of two returns to 60 FPS; its settled windows had
none. The first candidate's nine-minute QSV workflow still had six transient
drops during one of three returns, despite zero drops/loss/freezes in every
regular and sustained window. Removing the competing send path is therefore
not evidence that all reconfiguration interruptions are eliminated. Encoder
restarts still interrupt output during live format/bitrate changes.

## Environment and limits

Testing uses complete local Release review packages, actual Chromium source
windows, public VDO.Ninja viewers, and Windows loopback audio. These are local
review packages, not published releases. The host has Windows build 26200,
Intel Graphics driver 32.0.101.6881 driving a 60-Hz display, and NVIDIA TITAN RTX
driver 32.0.16.1047. Older Windows, AMD hardware, WAN packet loss, long gaming
sessions, and perceptual game-quality/A/V-sync benchmarks are not covered.

The reference input SHA256 is
`a6f0f318adce19a02cc3d8df5577dd0668056d82a776c203eb4f51f7036a3fb6`.
Generated fixture hashes, source/receiver counters, images, and complete publisher
logs are retained with each run under ignored `native-qt/qa/reports/`.

## Final browser package results

Package: `native-qt/dist/paced-maintenance-bounded/game-capture.exe`.

SHA256: `587b2551e027d8990afe4f03f1e824d36279b2300aed779e20b8f39102a02c6e`.

Each encoder ran for approximately five minutes, sequentially. Each workflow
covered pause/seek/resume, two 720p60 → 360p30 → 720p60 cycles, bitrate changes,
viewer reloads, verified transport rebuilds, a five-second signaling outage,
two sustained 30-second receiver windows, and shutdown with the source paused.
All retained the requested codec and hardware/software encoder category.

| Encoder | Fresh capture at startup/restored 60 FPS | Decoded FPS in steady/reconnect/soak windows | Drops across format/bitrate transitions | Quit |
|---|---|---|---|---|
| VP9 / libvpx | 59.87–60.04 | 59.95–60.11 | 0 | 327 ms |
| H.264 / NVIDIA NVENC | 59.47–60.02 | 59.87–60.03 | 5 during the second return to 60 | 1536 ms |
| H.264 / Intel QSV | 59.83–60.03 | 59.98–60.04 | 5 during the second return to 60 | 314 ms |

All standard and sustained windows recorded zero video drops, packet loss, and
freezes. Settled-control windows were also clean for VP9 and NVENC. QSV's five
drops occurred in the first eight-second measurement after its second return
to 60 FPS: 59.52 decoded FPS, zero packet loss, and zero freezes in that window.
This reproduces the original post-control concern; it is not fixed. Each
complete format-plus-bitrate transition recorded two freezes, including encoder
restart time. Transient drops also occurred on NVENC, although earlier in its
transition. All three publishers exited with code zero
and no orphan encoder process. Paused-source delivery remained approximately
60 FPS. Receiver audio retained the 439.45-Hz FFT bin for the 440-Hz source tone,
with no clipped samples, and continued through every measured recovery window.

At the 60-FPS setting, observed unique IDs ranged from 49.79–51.70/s for VP9,
54.49–56.69/s for NVENC, and 50.89–53.89/s for QSV. Those 10-second probes missed
16–55 receiver callbacks each; every marker that was sampled was readable.
At 360p30, one VP9 probe saw 299 callbacks, zero missed callbacks, 250 distinct
IDs, and 49 repeated IDs. This directly confirms repeated content despite the
full decoded rate. No change here claims to guarantee 60 unique displayed
images/s. Further localization should correlate source IDs at capture admission
and encode submission before changing the latency/pacing policy.

VP9's intentional all-keyframe default also remains bandwidth-heavy: paused
delivery measured 26.97 Mbps at a nominal 4-Mbps setting on this fixture.
Configuration-application checks do not establish a hard bitrate ceiling.
Changing that default requires inter-frame loss/PLI recovery coverage, including
the separate protected alpha contract.

Browser artifacts:
`paced-final-browser/1c53827d-8d3c-41e0-9650-233b89ac4cef/results.json`.
Chromium: `145.0.7632.6`. Embedded-ID fixture SHA256:
`f6a8795d0bee8309419b38dfb840ac1b74f20cb0f460c96512ef27a06225c7bc`.

The same package also passed a 1080p60 software H.264 workflow using the native
Spout color fixture and `H264 Encoder MFT`. Maximum RGB patch error remained
2/255 both initially and after source/signaling recovery. Regular receiver
windows measured 59.93–60.01 FPS with zero video drops, packet loss, or freezes.
Cached output continued at 59.89 FPS through the six-second source outage.
Shutdown during an observed stalled WebSocket handshake took 531 ms, with exit
code zero and no orphan encoder. Artifact:
`paced-final-software-color/9e9f05d4-1aa6-413e-b755-d0751163645e/results.json`.

Baseline and rejected-candidate evidence:

- `transition-baseline/da4535dd-1109-4c51-bb6d-df85cdfeaad9/results.json`: original package, two QSV FPS cycles, nine transient drops.
- `paced-qsv-long/bec02079-5053-43c1-9afc-fd25ee756eae/results.json`: first candidate's longer QSV run, six transient drops.
- `paced-other-encoders/2f535d3a-d3dc-4138-b083-0451e8f12e4e/results.json`: rejected over-aggressive pacing candidate, VP9/NVENC paused-rate failures.

The Release build, `RuntimeRecoveryPolicyTest`, JavaScript syntax, and whitespace
checks are gates. The packaged application workflows above are the testing.

Reproduce from `native-qt/`, with the harness dependencies on `NODE_PATH`:

```powershell
node e2e/encoder-receiver-review.js --publisher=dist/paced-maintenance-bounded/game-capture.exe --window-video=qa/reports/browser-reference-60.mp4 --reports=qa/reports/paced-final-browser --width=1280 --height=720 --fps=60 --cases=auto:vp9,nvenc:h264,qsv:h264 --video-controls=1 --control-cycles=2 --control-fps=30 --control-width=640 --control-height=360 --frame-identity=1 --faults=1 --soak-ms=60000 --soak-reconnect=1 --capture-cadence=1 --capture-cadence-min=0.95 --shutdown-window-paused=1
node e2e/encoder-receiver-review.js --publisher=dist/paced-maintenance-bounded/game-capture.exe --sender=build-review2/bin/spout_test_sender.exe --reports=qa/reports/paced-final-software-color --width=1920 --height=1080 --fps=60 --cases=software:h264 --color-check=1 --faults=1 --shutdown-handshake-stall=1
```
