# Runtime controls, hardware pressure, and alpha interoperability

## Confirmed issues and fixes

Rapid complete video-setting snapshots previously queued every intermediate
state. A 12-command NVENC burst produced 12 encoder replacements over roughly
14 seconds. Adjacent queued complete snapshots now supersede one another for
the same peer, generation, and remote-control scope. Partial controls, extra
fields, request IDs, other peers, and intervening ordinary operations remain
ordering barriers. Work already running is allowed to finish. Superseded
completion callbacks still run, and diagnostics count coalesced ordinary work.

The moving-alpha workflow also exposed a browser playback bug that decoder
counters alone missed. The publisher advertised a sendonly alpha track before
the receiver opted in. The public VDO.Ninja viewer attached that silent video
track: its video element was paused with zero dimensions, although the color
track continued decoding. Reserving the alpha section is intentional because
it preserves SDP media-section ordering across transport resets. Advertising
it as active to non-alpha viewers is not necessary for that design.

The reserved section is now inactive until opt-in. Capability changes rebuild
that peer's transport through the existing generation/session guards; ordinary
browser viewers keep an inactive alpha section. An intermediate attempt to
activate the track within the original transport restored browser playback
but did not deliver alpha to the native OBS receiver, so that approach was not
accepted. Repeated identical capabilities do not trigger another rebuild.

The API check used the installed libdatachannel headers and implementation,
plus its upstream [Track API](https://github.com/paullouisageneau/libdatachannel/blob/master/include/rtc/track.hpp)
and [media description API](https://github.com/paullouisageneau/libdatachannel/blob/master/include/rtc/description.hpp).
Inactive media direction is defined in [RFC 3264](https://www.rfc-editor.org/rfc/rfc3264).

## Packaged end-to-end evidence

All paths below are under `native-qt/qa/reports/`. These are real packaged
publisher runs through the public VDO.Ninja browser viewer, with actual moving
capture and a 440 Hz audio source. OBS cases additionally load the real native
plugin and examine screenshots of its composited output.

| Run | Evidence directory | Result |
| --- | --- | --- |
| Original rapid controls and preparation shutdown | `handover-lifecycle/9e9758f7-02d5-4676-90d2-ce2aa56819a7` | Both encoders exited cleanly during preparation; NVENC executed all 12 settings. |
| Coalesced rapid controls and preparation shutdown | `handover-lifecycle-fixed/5be111a3-b302-4686-aa31-fc2cdb8dbd46` | QSV coalesced 9 commands, NVENC 10. Post-burst delivery was 59.95/59.91 FPS. Both exited cleanly with no encoder children remaining. |
| Real NVENC resource pressure, recovery, and preparation shutdown | `handover-session-pressure-valid/8d84b551-81b6-4053-a5d6-6d5a585c21d0` | Passed; details below. |
| Browser playback trace with active reserved alpha | `moving-alpha-playback-trace/fc8558c4-eeb9-4537-acde-781bbf78e5ea` | Reproduced silent video-track attachment; OBS moving alpha passed initially and after the first downshift. |
| Inactive alpha with in-place activation | `moving-alpha-inactive/0f0ffce7-9522-46fc-8008-f5b3a93cb379` | Browser playback restored; native alpha failed. This intermediate package is not the final candidate. |
| Final alpha opt-in and dual-viewer workflow | `moving-alpha-opt-in/1b565240-18c1-40d5-a99b-da00a698f5f1` | Passed browser playback and OBS moving alpha, both live format changes, browser reload, and transport refresh with both viewers present. |
| Final-package QSV and NVENC regression | `handover-final-hardware/ed0764da-7b86-4d41-af84-27dfcd011c0f` | Both passed moving browser capture, pause/seek/resume, viewer reload, transport refresh, rapid settings, and shutdown during preparation. Post-burst delivery was 60.05/59.90 FPS; clean exits took 0.990/1.629 seconds with no encoder children remaining. |

The rapid-control-only candidate SHA256 was
`e0186134df7b04369a5756a4e5e345fe415d9c102f4efe396d51be30b530070b`.
The final candidate is `native-qt/dist/alpha-opt-in-settings/game-capture.exe`,
SHA256 `09c72cb4ca46a29be1bf71ef2cf29030d9b32cd6c8d944a2e96d4b8d383844de`.

The final OBS run verified ten unique decoded composites and ten unique PNGs
at each of four checkpoints: initial connection, 640x360@30 / 1 Mbps,
1280x720@60 / 8 Mbps, and transport refresh. Browser delivery at the two
requested formats was 30.00 and 59.94 FPS, with no dropped frames or concealed
audio samples across either settings transition. Those VP9 transitions still
registered freezes of 0.211 and 0.256 seconds. Browser steady/reload/recovery
delivery ranged from 59.72 to 60.01 FPS. Audio remained present without
restarting the tone source. Publisher shutdown completed in 0.435 seconds.
These screenshot samples prove moving, correctly composited alpha at the
checkpoints; they do not measure every OBS output frame or establish OBS's
full-frame-rate presentation quality.

The loaded native OBS DLL SHA256 was
`396cf33a6ee31de7cecb82d3e343b10dd741d3fe367c43b51a3086cfd0210f47`;
the integrated screenshot checker SHA256 was
`36f533d820967a2ea97f938e5254419beabbbf13851badbc82206f995551cde3`.
This turn did not change the OBS plugin repository or DLL.

The resource-pressure run started 11 successful harness-owned NVENC helpers;
the twelfth was refused by `OpenEncodeSessionEx`. A publisher bitrate change
then failed preparation and retained the old configuration and moving image.
After releasing all helpers, a different bitrate was applied successfully.
Delivery was 56.23 FPS under pressure and 57.34 FPS during the subsequent
eight-second recovery measurement, versus about 59.8–60 FPS before pressure.
This demonstrates continuity and recovery, not full 60 FPS under exhaustion.
Shutdown during replacement preparation took 1.728 seconds, exited with code
zero, and left no publisher encoder children. The helper bound is a fixture
limit, not a claim about the GPU's universal session limit.

The first pressure attempt used 128x128 input, which this driver rejected
before session exhaustion. It is excluded from successful evidence. Helpers
now use validated 640x360 input at 10 FPS. The baseline rapid-control harness
also initially mistook an intermediate matching configuration for settlement;
it now requires the operation queue to drain. Its earlier 47 FPS observation
is not evidence of poor steady-state encoding performance.

## Validation scope and remaining work

The browser harness now requires a playing video element as well as advancing
decoder counters. It records actual image motion, audio energy, decoded
dimensions/FPS, transition drops/freezes, queue settlement, and clean shutdown.
The OBS extension verifies the loaded DLL hash and requires ten unique moving
composites at each checkpoint, with alpha and color checks from the integrated
native receiver checker. It restores the isolated OBS configuration and scene
and stops only harness-owned processes.

Build, syntax, snapshot classification/ordering, and targeted WebRTC/executor
checks are gates, not end-to-end testing. The selected Qt gate run passed
20 cases including setup/cleanup, exact alpha capability matching, inactive
reservation/activation/reset, media-section ordering, executor lifecycle,
superseded completions, fairness, and overflow behavior. Logs are in
`latest-settings-regression-gates.log`.

Reproduction uses `e2e/encoder-receiver-review.js` with a complete package and
Playwright available through `NODE_PATH`. The final hardware run uses
`--width=1280 --height=720 --fps=60 --cases=qsv:h264,nvenc:h264
--rapid-controls=1 --shutdown-preparation=1 --require-codec=1`, with
`--window-video=native-qt/qa/reports/browser-reference-60.mp4`.
The bounded pressure case uses `--cases=nvenc:h264 --session-pressure=1`.
For the OBS case, replace the window source with `--sender` pointing to
`build-review2/bin/spout_test_sender.exe`, and use `--cases=auto:vp9
--video-controls=1 --control-width=640 --control-height=360 --control-fps=30
--combined-video-controls=1`, `--obs-plugin-repo` pointing to the isolated
`fresh-phase-obs-runtime` checkout, and `--expected-plugin-sha256` matching the
DLL hash above. Each run also requires explicit `--publisher` and `--reports`
paths. The OBS runtime must be idle before the run.

No replacement priming change is included. A primed first keyframe would
represent an older capture while the previous encoder continues delivering
newer images. Transport timestamps are already made monotonic, but that does
not prevent a visual rewind or compressed timing. The external FFmpeg path
cannot request a fresh H.264 IDR without restarting its process. A safe primed
handover needs an explicit frame-order and buffering policy or an encoder
control interface. The previously measured single-change freezes of roughly
0.29–0.95 seconds therefore remain an open performance concern.
