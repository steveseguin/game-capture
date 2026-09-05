# Encoder receiver validation

Explicit Intel Quick Sync selection uses bundled FFmpeg QSV in the Windows
Media Foundation build. The Intel asynchronous MFT failed warmup on the reviewed
machine; treating it as synchronous is incompatible with Microsoft's
[asynchronous MFT contract](https://learn.microsoft.com/en-us/windows/win32/medfound/asynchronous-mfts).
The external path preserves the requested Intel category and requires ffmpeg.exe;
the UI exposes its path and checks the dependency before starting.

QSV uses `-bf 0 -async_depth 1`, with `-forced_idr 1` for H.264/H.265. The raw
elementary stream reader associates encoded access units with input timestamps in
FIFO order, so reordered pictures cannot be timestamped correctly. FFmpeg's
[QSV H.264 implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/qsvenc_h264.c)
permits automatic B-frame selection; its defaults must not be used here.
Advanced FFmpeg options can override these defaults and should not enable frame
reordering. Check the bundled binary's `-h encoder=h264_qsv` for available options.

`native-qt/e2e/encoder-receiver-review.js` runs a complete local publisher package,
an animated Spout fixture and a Windows loopback tone, then connects a Chromium
viewer through public VDO.Ninja. It requires Node, Playwright with Chromium, and
the `ws` package. These can be installed in an ignored QA directory and exposed
with `NODE_PATH`. Example from the repository root:

```powershell
node native-qt/e2e/encoder-receiver-review.js --publisher=native-qt/dist/encoder-review/game-capture.exe --sender=native-qt/build-review2/bin/spout_test_sender.exe --reports=native-qt/qa/reports/encoder-review --cases=qsv:h264,nvenc:h264,auto:vp9,auto:av1 --width=1920 --height=1080 --fps=60 --faults=1
```

The harness measures actual receiver decoded FPS, dimensions, loss, dropped frames,
freezes, audio energy/concealment, and the received tone spectrum. It saves receiver
images and publisher diagnostics, including actual encoder/codec and binary hash.
It also tracks the fixture's blue box to distinguish moving content from repeated
frames, both initially and after source restart when fault mode is enabled.
Each case covers viewer reload and transport refresh. Fault mode additionally
blocks publisher signaling for five seconds and restarts the Spout source.
Measurement windows after recovery verify continued delivery; zero freezes within
those windows does not mean disruptions themselves were seamless. Run cases
sequentially to avoid encoding contention.

For browser sources, `--frame-identity=1` generates a 20-second lossless VP9
fixture from `--window-video`, with a binary frame ID baked into each image.
The marker has complementary bits and a black border to reject corrupt readings
and prevent its locator colors from merging with the scene. Fixture generation
finishes before the publisher starts. Source and receiver callback gaps are
recorded separately from unreadable markers and repeated IDs. The receiver's
`uniqueObservedFps` is an observation count, not a guarantee of physical display
rate: [`requestVideoFrameCallback`](https://wicg.github.io/video-rvfc/) is best
effort and can skip callbacks. Compare its rows and `missedCallbacks` with the
separately sampled WebRTC decoded/drop counters.

Use `--control-cycles=3` to repeat the lower-rate/restore controls; optional
`--control-width=640 --control-height=360` also changes output dimensions.
Each control records receiver counters before the request and after recovery,
including the disruption itself. [`framesDropped`](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-framesdropped)
includes frames dropped before decode and frames missing their display deadline;
it is not exclusively an encoder-error counter. `--soak-ms=180000` adds that
much receiver measurement time in 30-second windows, with additional motion and
optional identity probes. `--soak-reconnect=1` alternates viewer reloads and
transport refreshes before those windows. The soak requires continuing motion,
at least 95% decoded FPS, audio energy, and reliable marker readings when enabled.
Drop/loss/freeze counts remain visible in the report even when delivery passes.
See the [paced-output follow-up](paced-output-validation-2026-09-05.md) for
packaged results, measured repeated content, and unresolved post-control drops.

This is short-duration delivery/recovery testing with a simple animated pattern,
not a high-motion game quality benchmark, A/V synchronization measurement, WAN
loss simulation, or long-duration reliability guarantee. Record codec fallback
explicitly: receiving H.264 when H.265 was requested does not validate HEVC.
Unavailable hardware categories must be reported separately from regressions.

## Additional failure and lifecycle coverage

Use `--stress=1` to add a second simultaneous viewer, measure both receivers,
close the second viewer, then terminate the publisher's FFmpeg child twice.
The crash injection checks the parent process ID and refuses to terminate anything
unless exactly one FFmpeg child belongs to the harness-owned publisher. Each crash
must recover moving content and measurable video/audio delivery. Use external
encoder cases for this mode; Media Foundation has no FFmpeg child to terminate.
Delivery success requires at least 80% of requested FPS in every measurement
window, the expected output dimensions, moving fixture content, and audio. The
separate `fullRate` result requires at least 95% of requested FPS in every window.
`receivedCodecs` and `codecPreserved` distinguish recovery through codec fallback
from recovery in the requested codec. Use `--observe=1` to add a 30-second final
recovery measurement.

Every case now requires the publisher to exit with code zero within ten seconds
after `quit`, while its receiver remains connected. A timeout/forced termination
or a remaining FFmpeg child fails the case. The recorded `shutdown` result is
separate from delivery measurements. Use `--shutdown-source-loss=1` to terminate
the fixture just before quitting. With `--faults=1`, additionally use
`--shutdown-signaling-loss=1` to block signaling just before quitting, exercising
shutdown while reconnect work is pending.

Signaling recovery connection waits observe the application's stop/live state;
an immediate socket close also fails the attempt promptly. Quitting must not
wait out the full connection timeout after a failed or cancelled reconnect.

With `--faults=1`, `--shutdown-handshake-stall=1` adds a TCP front end that accepts
the reconnect and reads the HTTP upgrade request without responding. The result
must record `handshakeStallObserved=true` before the quit check. This exercises a
real pending WebSocket handshake, separately from immediately closing a socket.

Use `--color-check=1` to add eight fixed SDR RGB patches above the moving fixture.
Receiver canvas samples are compared with the known source values; `colorMaxError`
reports the largest channel difference across initial and final samples, and
`colorAccurate` uses a four-level tolerance. `finalColors` checks the output after
the requested recovery workflows. A requested color check now fails the overall
workflow when `colorAccurate` is false. The test is a basic
flat-color check, not a high-motion or perceptual video quality metric.

External NV12 H.264/H.265/AV1/VP9 output declares the matrix/range produced by the
converter (limited-range BT.601), with BT.709 primaries and sRGB transfer. These
are separate properties; untagged HD output must not imply a BT.709 conversion
matrix when its input was converted using BT.601. VP9's gray alpha input keeps
full range and does not receive the primary NV12 color metadata.

The earlier 1080p SDR patch comparison exposed a color shift in
Media Foundation Auto/Software H.264 (maximum channel error 19/255). Setting
matching input/output Media Foundation color attributes did not change the
received pixels on the review machine, so that ineffective change was removed.
The separate codec color properties also returned E_NOTIMPL on this machine.
Software H.264 now tags its Baseline SPS color metadata explicitly; see the
[follow-up results](capture-color-validation-2026-09-05.md). Media Foundation must
not be reported as passing the four-level tolerance merely because delivery
passes. VP9 initially measured 8/255; matching its
metadata to the converter reduced this to 2/255, including after signaling loss
and source restart. External QSV/NVIDIA H.264 and QSV AV1 also measured 2/255.
The FFmpeg option names are documented in the
[official codec options reference](https://ffmpeg.org/ffmpeg-codecs.html).

External encoder warm-up uses a three-second window with paced retries. The
former 18-attempt limit could expire in about 440 ms as a full input queue
returned immediately, rejecting a still-starting Quick Sync process. Media
Foundation retains its existing frame-count probe. A retired external process
ends the probe early; the window does not trigger recursive recovery.

Use `--resize=1` with a single case and a 1920x1080 fixture to change the live source
to 1280x960 after 20 seconds. Capture diagnostics must observe the resize while
receiver dimensions remain at the explicitly configured output dimensions. This
exercises Spout texture replacement and the encoder's input scaling path.

Use `--audio-controls=1` for two receiver audio-route mute/unmute cycles. Muting
must stop inbound audio packets, and unmuting must restore the 440 Hz fixture.
The harness then terminates its tone source, verifies silence, and restarts it
at 880 Hz to detect stale audio or failed recovery. This covers loopback source
interruption, not physical audio-device unplug/replug or non-48 kHz capture.

Use `--video-controls=1` with a 1080p60 fixture to request 720p30/1000 kbps,
then restore the original dimensions/FPS at 8000 kbps over the live data channel.
This option enables remote control only on the harness-owned publisher and sends
its session token. The receiver must observe the requested dimensions and FPS,
moving content and continued audio; diagnostics must confirm each bitrate.
`videoControls` retains the intermediate measurements. Its FPS check has an upper
bound as well as a lower bound, so 60 FPS cannot pass a 30 FPS request. The simple
fixture does not prove bitrate saturation or high-motion quality at either rate.

The encode thread uses the current configured FPS to schedule output slots. It
selects the newest pending image or repeats the cached image when capture supplies
no new image. Encoded output therefore can reach the requested FPS even when fresh
capture is slower. Use `--capture-cadence=1` during runtime control workflows with
a sufficiently fast source to check the captured-frame counter as well as receiver
FPS, including startup. Set `--capture-cadence-min=0.95` to require at least 95%
of the requested capture rate (the legacy default is 80%). `initialCapture` and
each runtime entry retain diagnostics before and after measurement. Browser
runtime entries also record source playback counters. These count acquisitions
separately from encoded repeats; they do not count pixel-level unique frames.

To check increases above the startup capture rate, use `--fps=30 --source-fps=60
--control-fps=60 --video-controls=1`. The fixture remains at 60 FPS while the
publisher starts at 30, requests 720p60, then returns to 1080p30. Add
`--control-source-restart=1` to restart the fixture while the higher runtime rate
is active and verify moving video, dimensions, FPS and audio after recovery.
Spout's capture thread now reads an atomic runtime FPS target for its receive
limit, retry intervals and frame-count timeouts. The target changes only after
the application's encoder reconfiguration succeeds. Window capture likewise
updates an atomic runtime target after successful reconfiguration; its capture
callback resets the limiter under the frame-processing lock. Camera rate
increases still require their own validation.

Window capture can replace the single pending image while encoding is busy.
Readback remains rate-limited, and the application never queues more than one
pending image. Admission no longer depends on encoder activity or notification
phase. On Windows supporting `IGraphicsCaptureSession5`, the OS capture interval
is set to half the requested frame period to avoid undershooting at the default
60-Hz boundary. Runtime FPS changes update both capture limiters. WGC admission
uses the compositor's frame timestamp rather than callback arrival time, and
coalesced pool entries are drained to the newest image after a stall.

The application retains separate resampling phase/history for primary and
additional audio capture. Non-48 kHz streaming chunks must share an
`AudioResamplerState`; standalone buffer conversion may omit it. State resets
when capture stops or the input format changes. Interpolation can retain the
final source frame until the following chunk arrives; it must not round every
chunk independently, which changes duration with packet size.

Further useful coverage requires distinct workflows: high-motion game footage with
reference recordings for quality comparisons; audio impulses plus visible timing
markers for A/V synchronization; actual media packet loss/jitter and relay-only
connectivity; long-session resource monitoring; microphone unplug/replug; mixed
browser receivers; and native OBS alpha transitions/HEVC reception. Passing the short local
receiver workflows above does not establish those behaviors.

The VP9 color follow-up also ran `ninja-plugin-alpha-e2e.ps1` against an isolated
copy of the local portable OBS/plugin runtime. Both opaque and half-transparent
fixtures passed real pixel composition checks, with loaded plugin, publisher and
sender hashes verified. This establishes steady alpha composition for that
package/runtime pair; screenshot request cadence is not a decoded FPS measurement.
Moving alpha edges, receiver recreation and publisher restart need their own runs.

For actual Windows window capture, pass `--window-video=<absolute local MP4>`
instead of `--sender`. The harness opens a separate visible Chromium window with
a unique title and captures only that window. Use a moving reference clip; the
receiver check compares pixel changes, then pauses the browser's video, verifies
the remote image becomes still, seeks and resumes playback, and verifies motion
returns. It also saves the source and receiver images. The regular viewer reload,
transport refresh, and `--faults=1` signaling outage workflows still apply. Spout
source-restart, resize and color-patch options are rejected in this mode. The
browser source remains alive throughout signaling recovery; this does not test
reopening a closed window. Audio uses the independent controlled loopback tone.

Maintenance replays now use the same steady output clock as scheduled encoding
and leave the cached preview image/timestamp unchanged. Reusing the old timestamp
for each new encoding reduced a multi-second source outage to a few RTP ticks;
the transport's monotonic clamp cannot represent elapsed time by itself. This
follows the sampling-clock requirement in
[RFC 3550 section 5.1](https://www.rfc-editor.org/rfc/rfc3550#section-5.1).
The source-loss workflow records receiver metrics during the outage as well as
after restart. A repeated cached image during source loss is intentional and is
not evidence that live capture has recovered.

Add `--window-resize=1` with `--window-video` to resize and restore the owned
browser window. The harness uses the documented
[Chrome window bounds API](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds)
and verifies the actual bounds, moving decoded output, output dimensions and FPS.
This exercises Windows Graphics Capture while the real application's window
changes size; it does not establish recovery after closing and reopening a window.

Add `--shutdown-window-paused=1` to pause the owned browser source before quitting
the publisher and check idle-capture shutdown. The source resumes before the next
encoder case. See the [capture cadence and color follow-up](capture-color-validation-2026-09-05.md)
for the Windows interval fix, software H.264 metadata fix, and package results.
