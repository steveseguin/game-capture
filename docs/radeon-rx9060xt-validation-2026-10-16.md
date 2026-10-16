# Radeon RX 9060 XT: Windows encoding and Auto fallback

The RX 9060 XT was detected with AMD driver **32.0.22042.14002**, device status
OK, on Windows 11 build 26200. No driver installation, device disabling, or
reboot was needed. Intel Graphics and NVIDIA TITAN RTX are also installed:
these results do not represent a machine with only an AMD display adapter.

## Change

Game Capture already exposes **AMD AMF** under advanced encoder settings. Actual
H.264 publishing selected `FFmpeg h264_amf` on this card.

Auto previously exhausted Media Foundation's hardware candidates and moved
straight to software. AMD's AMF encoder can exist without a usable hardware
Media Foundation transform, leaving available hardware unused.

Auto now retains working hardware MFTs, then checks for a physical AMD adapter
and tries AMF before software. It searches all DXGI adapters, including adapters
that do not own the primary display. AMF must pass the existing warm-up and
fresh-process initialization. Failed startup continues to software; explicit
Software and explicit vendor selections retain their existing behavior.
The public selection remains Auto when its active encoder is AMD.

This is not a preference for AMD over another working hardware encoder. To
choose this Radeon specifically on a mixed-GPU computer, select **AMD AMF**.
The 4,000 kbps streaming default is unchanged; saved user settings are preserved.

The adapter check follows Microsoft's
[DXGI adapter descriptor](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ns-dxgi-dxgi_adapter_desc1).
AMD documents the hardware and codec dependencies of
[FFmpeg AMF encoding](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/wiki/FFmpeg-and-AMF-HW-Acceleration).

## Packages and actual application coverage

Complete portable review packages retain the released runtime dependencies and
replace the application executable with the rebuilt Release binary:

| App | Review executable SHA-256 |
| --- | --- |
| Game Capture | `905af4ade003232ac0bca81f59f7dd4f6295971de8ff7a8dcc09da89ab4e6221` |

Build, syntax and whitespace checks are gates. The workflows below run packaged
applications and verify actual encoded media. Receivers and test destinations
are private and local.

- **Auto fallback, review package:** hide only the owned process's hardware
  MFT discovery. The original Game Capture release used software in this case;
  the updated app uses real AMD AMF, with playable video and continuous stereo
  audio. When AMF process creation is also deliberately denied, it recovers to
  software and produces clean recordings. No installed drivers/settings change.
- **Game Capture interface, review package:** select AMD AMF, publish RTMP and
  RTSP/TCP, stop, restart the app, and repeat. All four receiver clips decode
  changing pictures. No audio was intentionally selected. Settings restore
  exactly, and no encoder/output children remain after stopping.
- **Released Game Capture 0.2.63 baseline:** explicit AMD already produces
  1080p60 RTMP and 720p60 SRT. Initial and post-receiver-restart recordings have
  increasing timestamps, continuous stereo audio and approximately 60 fps.
  Maximum frame intervals are 17–21 ms across those four files.

The baseline's mean process-tree CPU was 4.77% of this 20-logical-CPU machine
for 1080p60 RTMP, and 2.29% for 720p60 SRT. Mean summed working sets were
approximately 228 / 199 MiB. These include capture and output workers, not
just the AMD encoder; shared pages can be counted more than once. Short
synthetic runs are not demanding-game or older-machine benchmarks.

## Limits and retained failures

The initial protocol exploration also requested HEVC/AV1 over external UDP.
The app rejected those unsupported combinations normally with exit code 2:
external outputs currently require H.264. This is not an AMD initialization
failure or a claim to have tested HEVC/AV1 through a compatible VDO receiver.

WHIP played in Chromium, but the MediaMTX-to-FFmpeg recording contained six
duplicate startup video timestamps. Its quality result remains failed,
consistent with the previously documented receiver/remux limitation. This pass
does not resolve WHIP loss/jitter qualification.

The first Auto fault runner stalled with its original child-gating implementation;
its incomplete evidence is retained. Restricting child gating to Studio and
dispatching child instrumentation outside the Frida callback resolved the
runner problem; the completed cases above were then repeated.

The first OBS attempt reached its WebSocket before OBS was ready. The runner
now retries its initial GetVersion request within the existing bounded startup
wait. A repeated OBS run played clean media, but its short sample did not
contain the required 20 corresponding sync pulses; that insufficient-sample
result is retained separately.

The longer OBS 32.2.2 runs use 720p60 AMD H.264, a simultaneous direct source
reference and separate audio tracks. Both paths decode cleanly. The
RTMP-to-MediaMTX-to-RTSP-to-OBS run fails the unchanged 50 ms relative sync
target: 26 matched pulses have a maximum additional offset of 53.33 ms
(source-clock estimate up to 63.67 ms). The direct RTMP consumer repeat passes:
26 matched pulses, median additional offset 33.33 ms, maximum 50 ms. These
separate runs suggest receiver-path/startup sensitivity; they do not prove a
root cause or erase the failed RTSP result. No artificial timestamp/audio
offset or relaxed threshold was introduced. This is recorded-media timing,
not physical display/speaker latency. OBS and the publisher exit normally.

This pass does not diagnose the older Radeon 780M host's kernel crashes, qualify
other AMD drivers, or cover overnight sessions, AMD as the only/display-owning
GPU, HDR, or gaming under GPU/VRAM saturation.

## Reproduction and evidence

Ignored evidence is under `native-qt/e2e/reports/rx9060xt-2026-10-16/`.
Raw logs, private control credentials, test profiles and recordings are
not committed.

- Game `e2e/amd-auto-packaged.py --publisher EXE --report NEW_DIRECTORY --expect amf`.
  Add `--deny-amf --expect software` for failed-AMF recovery.
- Game `e2e/external-output-packaged.js` with `e2e/amd-output-matrix.json`;
  use `analyze-external-output.py` afterward to check media independently.
- Game `e2e/external-output-gui.py --encoder amf --protocols rtmp,rtsp`.
- The external-output runner accepts `--obs=ISOLATED_QA_OBS_DIRECTORY` and
  `--obs-direct-rtmp=true` for the direct RTMP comparison. Use a 70-second case,
  then run `analyze-obs-quality.py` for left/audio 0 and right/audio 1, followed
  by `analyze-obs-sync-pair.py`, all with `--start-seconds 20` and 60 fps for
  the two media analyses. Retain both passing and failing path results.

These are local review builds. Published installers/releases were not replaced.
