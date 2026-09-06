# Fresh-frame scheduling and VP9 rate control

Follow-up to [paced output validation](paced-output-validation-2026-09-05.md).

## Confirmed defects

The embedded source IDs now have a native trace at capture admission, encoder
submission, and encoded packet completion. Packets are joined to submissions by
their exact output timestamp. Capture delivered distinct images at about 59.9/s,
but the original output worker submitted only 55.5–55.8 distinct images/s in the
QSV baseline. This localizes real repeats before the encoder; the lower browser
callback count alone could not do that.

The worker now waits at most one quarter of a frame interval, capped at 4 ms,
when no fresh image is ready. After a successful wait it aligns its next output
slot to that capture phase. A fixed wait without phase alignment helped one run
but still submitted only 55.6–56.8 distinct images/s in another QSV run, including
about 25/s at a 30-FPS setting. That intermediate version was not retained.
Timeouts do not move the clock, preserving full-rate cached output when paused.

Reconfiguration could hold the encoder mutex while a selected frame and output
timestamp aged by 660–1,904 ms. The worker now discards a scheduled slot that is
two frame intervals late after acquiring the mutex, before consuming a keyframe
request or admitting an alpha pair. Its next iteration selects the latest image.
Unscheduled callers may use a different source-clock epoch and bypass this check.
Encoder restart interruptions themselves remain; this change removes obsolete
work after the interruption.

VP9 requested CBR by setting `minrate` to its bitrate, but retained a much higher
general `maxrate` ceiling. [FFmpeg's libvpx documentation](https://www.ffmpeg.org/ffmpeg-codecs.html#libvpx)
requires minimum, maximum, and target rates to match for CBR. They now match, and
the buffer size follows that target. The intentional all-keyframe default and
protected dual-track alpha contract are preserved. Advanced FFmpeg options still
apply afterward under the existing override policy.

Actual packet-loss testing exposed another issue: VP9's manual RTP paths had no
NACK responder, although H.264 had one. Losing one fragment could therefore lose
an entire VP9 frame despite the receiver requesting retransmission. Both VP9
color and alpha tracks now use the library's bounded 512-packet NACK cache without
repacketizing their RTP. This was checked against the pinned libdatachannel
[`RtcpNackResponder`](https://github.com/paullouisageneau/libdatachannel/blob/8a495c3523c4ecd52cd4ae4796ab9718b83bb0cb/src/rtcpnackresponder.cpp)
and track send implementation. The cache belongs to each transport's track, so
rebuilding a transport does not retain obsolete packets from its predecessor.

## Trace and measurement limits

`--frame-identity=1 --frame-trace=1` enables a buffered, mutex-protected trace,
bounded to 100,000 rows, via `VERSUS_FRAME_TRACE`. Ordinary runs do not scan pixels
or write the trace. `e2e/frame-trace-report.js` summarizes distinct capture,
submission, and packet IDs, invalid/missing IDs, expired slots, and local latency.
The trace is specific to the embedded-ID fixture, not a general frame hash.

The source compositor timestamp can precede its planned presentation. Local
capture-to-submission delay therefore uses the capture callback's steady clock.
Output-slot-to-packet delay includes encoder buffering. Neither is an end-to-end
display-latency or A/V synchronization measurement.

Receiver [`requestVideoFrameCallback`](https://wicg.github.io/video-rvfc/)
observations remain a lower bound: missed callbacks and repeated IDs are separate
counts. Native distinct packet IDs do not prove that every packet was displayed.
Receiver `framesDecoded`, `framesDropped`, loss, freezes, and callback gaps must
be considered together.

## Packaged application testing

The complete local Release scheduling review package is
`native-qt/dist/fresh-phase-review/game-capture.exe`, SHA256
`3303358090e2b545f502227718b027df080ef7a093368986e0a37d2f5cdab867`.
It includes the Qt and FFmpeg runtime and is not a published release.

The final package adds VP9 retransmission:
`native-qt/dist/fresh-recovery-final/game-capture.exe`, SHA256
`fe6e635e2e86e76f6ba68702e70a1c251dd8b5b5c92b542455b2ec2b42418e58`.

Testing uses actual Chromium source windows and public VDO.Ninja receivers,
Windows loopback audio, and the native Spout fixture. The host is the same Intel
Graphics/NVIDIA TITAN RTX, Windows build 26200 system described in the preceding
report; Chromium is 145.0.7632.6. One phase-aligned browser run overlapped an
unrelated four-core CPU workload. A host-load sample is retained with that run.

### Baseline and intermediate evidence

Artifacts below are relative to ignored `native-qt/qa/reports/`:

- `frame-trace-baseline/2a5a84b3-6a19-4f7f-ad1d-056c985ccd0d`: instrumented baseline, SHA256 `170efad00bce4772b1b08612141c1f762cd8e1cd6b52b00b9f57c388e1b86079`.
- `frame-trace-grace/538a3a96-6acd-4d1a-84f9-ee7e817a15df`: fixed-wait experiment, initially 59.85 distinct submissions/s; its later variability motivated phase alignment.
- `fresh-cbr-review/789d4a13-8ac5-4474-a9f7-ed980b990c81`: fixed wait plus CBR. VP9 received about 4.83 Mbps at 4 Mbps, 1.20 Mbps at 1 Mbps, and 9.65 Mbps at 8 Mbps. This is a major reduction from the previous 26.97-Mbps paused measurement, but still about 20% above target, not a hard ceiling.

The intermediate run also exercised two viewers and two owned FFmpeg-process
terminations for both VP9 and QSV. Video and audio recovered. VP9 retained its
codec after the first termination, then intentionally fell back to H.264 after
the second failure within the existing 15-second failure window. QSV retained
H.264/QSV after both. Codec preservation is recorded separately from delivery;
`--require-codec=1` can require it in workflows that should not fall back.

### Packet-loss harness validation

Scheduling package artifacts:
`fresh-phase-final/a354158a-9934-47b8-92bb-1834f6eaa3bf/results.json` and
`native-summary.json`. All three cases passed. Each covered pause/seek/resume,
viewer reload, transport rebuild, two 720p60 → 360p30 → 720p60 cycles with 1/8-Mbps
controls, 12 seconds of 5% emulated packet loss, loss removal, signaling outage,
and shutdown while the source was paused.

| Encoder | Regular decoded FPS | Native distinct submissions/s at 60 FPS | Transition drops | Quit |
|---|---|---|---|---|
| QSV H.264 | 59.32–59.88 | 57.01–58.58 | 0 | 329 ms |
| VP9 | 59.27–59.83 | 56.86–58.20 | 0 | 211 ms |
| NVENC H.264 | 59.67–59.89 | 57.25–58.04 | 0 | 1,526 ms |

Each complete format-plus-bitrate change still produced two freezes while the
encoders restarted. Each publisher exited with code zero and no orphan encoder.
Native capture itself sometimes delivered less than 60 distinct frames/s under
the concurrent transcription workload. These results improve the repeat problem
but do not establish 60 distinct displayed frames/s. The first phase-aligned run,
`fresh-phase-review/2ba7f066-b9a5-4ad5-b0e5-97b217e20c52`, also had zero QSV/VP9
transition drops, but NVENC had three drops on each return to 60. That run failed
its loss-injection check, as explained below. Intermittent transition drops are
therefore reduced in the retained runs, not proven eliminated across hardware.

QSV's successful loss probe recorded 661 NACKs, 12 unrecovered lost video packets,
and 56.21 decoded FPS. After loss removal it delivered 59.95 FPS with zero new
drops/loss/freezes. Before adding the NACK cache, VP9 recorded 607 NACKs, 620 lost
video packets, and only 23.73 FPS during loss; it recovered to 59.80 FPS afterward
with zero new drops/freezes. These measurements motivated the retransmission fix.
No PLI was observed in these loss probes; they do not validate a PLI-driven restart.

Final VP9 retransmission artifacts:
`fresh-recovery-final/9f7d8449-fbdd-4c44-91bd-4d942b837c95/results.json`.
This final package passed the same browser workflows with one format/FPS cycle.
During 5% loss it received 662 NACKs, recorded 72 unrecovered lost video packets,
and decoded 54.00 FPS with zero freezes. All 649 decoded frames were keyframes.
This compares with 23.73 FPS and 620 unrecovered packets before the cache, although
the random-loss runs are not identical network traces. After removing loss it
delivered 59.74 FPS with zero drops/loss/freezes. Regular/reconnect windows were
59.52–59.90 FPS. Paused delivery was 59.94 FPS at 4.78 Mbps for the 4-Mbps setting.
The codec remained VP9; exit was clean in 317 ms with no orphan encoder.

The final package also passed real portable OBS/ninja-plugin workflows for
opaque and half-transparent Spout output. Manifest:
`fresh-recovery-alpha/manifest.json`. Both workflows verified the loaded binaries,
active dual-track composition, and four useful composited-pixel samples after
startup. Maximum sample-start gap was 95 ms; no dark-fill failure occurred.
These were static transparency fixtures, not moving-edge or alpha packet-loss
benchmarks. The isolated runtime lives under `fresh-phase-obs-runtime/`; the
plugin SHA256 is `396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47`.

Final software H.264 artifacts:
`fresh-recovery-software-color/7e86f121-a581-4e90-ad6e-70ccab709745/results.json`.
The packaged 1080p60 Spout workflow passed viewer reload, transport rebuild,
signaling outage, source loss/restart, and shutdown during a stalled handshake.
Maximum RGB patch error remained 2/255 initially and finally. Regular/recovery
windows delivered 59.64–60.05 FPS. Shutdown took 434 ms with exit code zero and
no orphan encoder. The active encoder remained `H264 Encoder MFT`.

The harness uses [CDP's documented WebRTC packet-loss conditions](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-emulateNetworkConditionsByRule).
It requires a positive receiver video-loss counter before claiming injection
worked, then verifies full-rate moving video and audible audio after removal.
It records NACK, PLI, decoded keyframes, jitter-buffer delay, and processing delay.

The first experiment attached CDP after WebRTC socket creation. The command
succeeded but produced no loss, and the harness marked those runs unsuccessful.
[Chromium's UDP socket implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/services/network/p2p/socket_udp.cc)
binds its interceptor in the socket constructor. Setup now installs a zero-loss,
1-ms-latency profile before the viewer creates its connection, then changes loss
on that existing profile. Failure to observe actual loss remains a failed check.

Release builds, runtime-policy/room-quality/WebRTC regression checks, JavaScript syntax,
and whitespace checks are gates. The application workflows and measured outputs
are the testing. WAN conditions, AMD/older Windows, long game sessions, and
perceptual game-quality/A/V-sync benchmarks remain outside this validation.

Reproduce from `native-qt/` with harness dependencies on `NODE_PATH`:

```powershell
node e2e/encoder-receiver-review.js --publisher=dist/fresh-phase-review/game-capture.exe --window-video=qa/reports/browser-reference-60.mp4 --reports=qa/reports/fresh-phase-final --width=1280 --height=720 --fps=60 --cases=qsv:h264,auto:vp9,nvenc:h264 --video-controls=1 --control-width=640 --control-height=360 --control-fps=30 --control-cycles=2 --frame-identity=1 --frame-trace=1 --packet-loss=5 --require-codec=1 --faults=1 --shutdown-window-paused=1
node e2e/frame-trace-report.js qa/reports/fresh-phase-final/<run-id>/results.json
```
