# Hardware encoder handover and OBS image validation

## Change and API investigation

QSV/NVENC runtime changes previously shut down and initialized FFmpeg while
holding the video output mutex. This blocked capture output through encoder
warm-up, clean-process creation, and old-process termination.

Hardware APIs can reconfigure an existing encoder:
[NVIDIA documents encoder reconfiguration](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html),
and [FFmpeg's QSV implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/qsvenc.c)
updates bitrate through its codec context and encoder reset. Game Capture's
external FFmpeg integration supplies raw pixels through stdin and receives
encoded bytes through stdout. It has no command channel that updates that
codec context. Implementing direct live bitrate control would require changing
this integration; the current change does not claim a restart-free bitrate API.

For active external QSV/NVENC H.264 pipelines, runtime resolution/FPS and
bitrate changes now prepare a replacement outside the video mutex. The old
pipeline keeps encoding during preparation. Preparations are serialized to
bound concurrent hardware sessions. The replacement retains the normal health
probe, clean-live-process isolation, and explicit encoder-selection checks.

Commit takes the video mutex, checks that capture is active, the complete
configuration is unchanged, and the encoder configuration revision still
matches. Failed or superseded preparations leave the current pipeline intact.
Successful commit swaps backend/configuration state, requests a keyframe, and
publishes the new settings. Packet callbacks stay attached to their public
encoder objects. The retired process is destroyed after releasing the mutex.
Encoder initialization, shutdown, bitrate changes, and swaps advance revisions.

The new live process still needs its first real frames after commit, so this
does not promise gapless switching. VP9/dual-track alpha and Media Foundation
runtime control paths retain their previous behavior. Resource-constrained
hardware may reject a concurrent session; preserving the working stream is
preferred to destroying it to make room for an unvalidated replacement.

## Packaged application testing

Complete local Release package:
`native-qt/dist/prepared-hardware/game-capture.exe`, SHA256
`64c15df3975a818b79f75abef89a3f18da21d0278d2be929fa2cdce8d9079c87`.
The package includes Qt and FFmpeg dependencies and is not a published release.

Browser workflow artifacts:
`native-qt/qa/reports/prepared-hardware/6b6cd4da-b057-46a3-933b-7edd5fb85a1e/results.json`.
The real Chromium source window and VDO.Ninja receiver exercise 720p60 to
360p30 and back, 1-/8-Mbps bitrate targets, separate and combined controls,
source pause/seek/resume, viewer reload, explicit transport rebuild, two
simultaneous viewers, two forced encoder crashes, and shutdown with a paused
source. Freeze values are receiver counter deltas over complete transitions,
not pure command-processing time. Comparisons use the immediately preceding
[first-frame-preservation package](reconfigure-validation-2026-09-05.md).

| Encoder / destination | Previous separate freeze seconds | Prepared separate | Previous combined | Prepared combined |
|---|---:|---:|---:|---:|
| QSV / 360p30 | 2.641 | 0.795 | 1.274 | 0.833 |
| QSV / 720p60 | 2.436 | 0.693 | 1.224 | 0.932 |
| NVENC / 360p30 | 4.405 | 0.926 | 2.266 | 0.946 |
| NVENC / 720p60 | 1.191 | 0.462 | 0.746 | 0.288 |

Both workflows passed. All eight settings transitions had zero receiver dropped
frames and zero concealed audio samples. After settling, measured decoded FPS
was 29.85-29.97 at 30 FPS and 59.84-60.05 at 60 FPS. Received bitrate was
945-988 kbps at the 1-Mbps target and 7,963-8,165 kbps at 8 Mbps. Both encoders
recovered moving video after two intentionally killed encoder processes and
supported two viewers. Shutdown was clean with no leftover encoder children.

These are single-run observations on a shared workstation, not performance
guarantees. Every separate transition recorded two freezes. Combined changes
recorded one each except the QSV upshift, which recorded two. Audio continuity
uses receiver counters and signal analysis, not a subjective listening or
A/V synchronization assessment. Decoded FPS does not count unique source images.

### Failed preparation

`--replacement-failure=1` enables authorized remote controls, records the
currently running FFmpeg PID, sends a bitrate change, and kills only new
FFmpeg children of that harness-owned publisher for six seconds. It requires
an actual killed child, then verifies the original PID and bitrate remain,
moving output returns, and normal video/audio continue afterward.

Both QSV and NVENC passed. Each preparing process was killed while the original
encoder survived at 4 Mbps. Subsequent decode rates were 60.07 and 59.91 FPS,
respectively, and shutdown left no encoder children. Logs explicitly recorded
failed preparation and retention of the current pipeline. Artifacts:
`native-qt/qa/reports/prepared-hardware-failure-fixed/e762a40d-9a1b-4f8d-991f-1ac5d5e88c7b/results.json`.

The first fault run failed to exercise preparation because its harness omitted
`--remote-control`; the app correctly rejected the unauthorized request. That
setup bug was fixed and both cases rerun. Failed-attempt artifacts remain under
`native-qt/qa/reports/prepared-hardware-failure/2f0a3f72-a56c-4a3c-9b44-b37e6e6716a7`.
This fault coverage does not measure frame continuity throughout preparation,
simulate an actual hardware session-limit error, or cover shutdown/configuration
changes racing preparation. The latter paths have explicit stale-state checks
but no dedicated E2E race injection in this run.

## OBS analyzer correction

The checker resides in the companion `ninja-plugin` repository at
`scripts/obs-websocket-vdoninja-source-check.cjs`
([companion change e499cf6](https://github.com/steveseguin/ninja-obs-plugin/commit/e499cf6)). A static source need not have
bit-identical decoded images after lossy VP9 encoding. Different decoded hashes
now trigger comparison against the first useful frame, with limits of 3/255
mean absolute error in every channel and 16/255 for any individual channel.
Comparison to the first frame prevents cumulative drift. Dimensions must match.
PNG-byte and decoded-pixel hashes bind the comparison to retained evidence.

Per-frame expected-color/alpha coverage checks, visual and connection epochs,
moving-frame requirements, cadence checks, and evidence requirements remain
active. The tolerance is a bounded static-fixture allowance, not a perceptual
quality score or a relaxation of wrong-alpha detection.

The Game Capture analyzer gate adds real PNG fixtures for small quantization
variation, gradual drift, a localized color change, a stale connection epoch,
and mismatched decoded-pixel evidence. Existing wrong-alpha, missing-foreground,
frozen-motion, and evidence controls also run. These are gates; the OBS workflow
below provides application testing.

The analyzer gate passed all 53 negative controls; its result is retained at
`native-qt/qa/reports/hardware-handover-alpha-gate.json`. Reanalysis of the
previously failing candidate screenshots also passed: opaque images differed
from the first by at most 1.964/255 mean channel error and 13/255 maximum
channel delta, and half-alpha images by 1.0/255 and 8/255. Offline screenshot
reanalysis is a gate, not a new OBS workflow.

The revised checker SHA256 is
`44607dd549bb7b78696c1fd1e083b2fdeff9d92ded1ae9c64720edf5c735a20a`.

### Real OBS workflow

The updated checker and packaged application passed opaque and 50%-alpha
workflows in isolated portable OBS with the native receiver plugin. Both cases
retained four useful composites; opaque had four distinct decoded images and
half alpha had three, so the new tolerance was exercised in the actual app.
Maximum observed channel differences from the first useful frame were:

| Fixture | Maximum mean channel error | Maximum individual channel delta | Maximum capture-start gap |
|---|---:|---:|---:|
| Opaque | 1.964/255 | 13/255 | 94 ms |
| 50% alpha | 1.000/255 | 6/255 | 95 ms |

The strict workflow passed composite/epoch checks, capture cadence, evidence
binding, loaded plugin identity, and stable artifact hashes. Manifest:
`native-qt/qa/reports/prepared-hardware-alpha/manifest.json`.
The plugin DLL remained SHA256
`396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47`;
only its JavaScript checker changed. Moving alpha and alpha reconfiguration
were not part of these static OBS workflows.

The companion remote advanced before push. The checker-only change was
cherry-picked onto current remote main in an isolated checkout, preserving
the original checkout's unrelated package edits. Upstream had also changed
the checker's OBS authentication/audio-wait paths. The integrated checker
(SHA256 `36f533d820967a2ea97f938e5254419beabbbf13851badbc82206f995551cde3`)
passed the same 53-negative-control gate and both real OBS workflows again.
Final integration artifacts:
`native-qt/qa/reports/hardware-handover-alpha-integrated-gate.json` and
`native-qt/qa/reports/prepared-hardware-alpha-integrated/manifest.json`.
The packaged publisher and plugin DLL hashes remained unchanged.

## Final gates

Release compilation/linking, JavaScript syntax, whitespace checks, and the
53-negative-control analyzer gate passed. Packaged browser and OBS E2E testing
is recorded separately above. The application still restarts external encoders,
and remaining handover freezes measured 0.29-0.95 seconds for combined controls.
This is an improvement, not a claim of seamless transitions or native live
bitrate reconfiguration.
