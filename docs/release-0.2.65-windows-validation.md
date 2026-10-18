# Game Capture 0.2.65 Windows qualification

Fresh Windows settings now select 1280 x 720 at 60 fps, 4,000 kbps video,
128 kbps streaming audio, Auto hardware-first H.264, and no microphone.
Saved choices are preserved. See the [encoder guide](https://steveseguin.github.io/game-capture/encoder-guide/) and
[default policy](streaming-defaults.md) for other resolutions and encoder details.

## Frozen package

Built from `ff9ac2e6320f67700740f9403085b05b8788861b`. Subsequent QA and
documentation changes do not change this signed payload. Concurrent macOS
documentation is preserved; the separate macOS beta is unchanged.

| Artifact | SHA-256 |
| --- | --- |
| Signed application | `82879f4501c32bb8a55a5f5ffc2d5b99100286667e8560a00eb591be045b84dc` |
| Setup installer | `66b21638838e28078a13752afd91e0531a2c7fbaffd58bf97759fd99e2606abc` |
| Portable launcher | `56a2d4ffb9cb75f67f83aeba7e9a3ef6fcb6465e1315ed72c713d8b21fd47f0b` |
| Portable ZIP | `2e7415db654b0bae3f01798024828674ab0a845762b7c6ed873eeb83e9269db3` |
| Artifact manifest | `aa6f9b264579fe88540c0479a3411575f405d8fe53bffd38bf3bbf1a045e281d` |

All 97 ZIP files match the frozen staging directory. The executable extracted
from setup and the portable launcher matches the application above. Stable
aliases are byte-identical to their versioned assets. Developer helper
executables and Qt6Test.dll are excluded. Checksums and FFmpeg license/source
information accompany the release.

## Host and scope

Windows 11 Pro 10.0.26200; Intel Core Ultra 7 265K, 20 logical CPUs and
63.5 GiB RAM. GPUs: RX 9060 XT (32.0.22042.14002), TITAN RTX
(32.0.16.1047), and Intel Graphics (32.0.101.6881). Qualification work uses
CPU affinity 0-9. This is one mixed-GPU host, not an AMD-only or clean machine.

The earlier [defaults measurements](defaults-validation-2026-10-18.md) remain
candidate evidence with their original hashes. They are not relabeled as
measurements of this signed version.

## Packaged application workflows

- Local-control malformed-input workflows and MCP playback, controls,
  transport recovery, HTTP pressure, ownership and cleanup passed.
- Focused desktop and capture-compatibility workflows passed, including
  H.264/VP9 browser playback, start/stop, failed or delayed encoder probes and
  absent optional capture APIs. App/playback screenshots were inspected.
- The focused update workflow passed real browser-link launch, offline/TLS
  errors, malformed responses/caches, interrupted requests, restart and cache
  recovery with the packaged application.
- Fresh GUI defaults and saved-setting persistence passed. A chosen 60 fps,
  6 Mbps video and 192 kbps audio configuration survived restart; user settings
  were restored afterward. The fresh-settings screenshot was inspected.
- Data-channel controls passed after correcting the fixture's old audio-default
  expectation. Both focused Edge relay runs passed actual media/data delivery.
- Room/password combinations, viewer refresh, stream-ID collision,
  Auto/host/STUN/TURN connectivity and saved ICE settings passed.
- Both Firefox variants passed 107 signaling checks, including real media.
  Director/Control Center workflows passed in Edge and both Firefox variants.
- Dual-quality role assignment, join/leave churn, initialization fuzz and
  requirements passed. OBS room-quality alpha and both opaque/half-transparent
  steady-state output cases passed with frozen package/plugin/Spout identities.
- The 30-minute dual-quality soak passed **319 viewer join/decode cycles over
  1,819 seconds**, in four batches, each on its first attempt. This is repeated
  workflow endurance, not one uninterrupted publisher or an overnight run.
- The separate reconnect soak passed **101 iterations over 1,806 seconds**,
  across five first-attempt batches, with 15 seconds of playback per iteration.

All seven output-default application workflows delivered media: Auto, software,
NVIDIA, Intel and AMD over UDP, plus Auto and AMD over WHIP, at 720p60 / 4 Mbps
with a 128 kbps audio target. Actual encoder diagnostics confirmed the requested backend.
The subsequent received-file audit passed six cases and retained one known
WHIP relay-file timestamp exception:

| Workflow | Received fps | Mean CPU cores | Mean RSS MiB | Strict output check |
| --- | ---: | ---: | ---: | --- |
| `udp-default-auto` | 59.97 | 0.47 | 197 | Passed |
| `udp-default-software` | 60.00 | 0.41 | 174 | Passed |
| `udp-default-nvenc` | 59.80 | 0.30 | 298 | Passed |
| `udp-default-qsv` | 59.35 | 0.30 | 286 | Passed |
| `udp-default-amf` | 59.75 | 0.40 | 196 | Passed |
| `whip-default-auto` | 60.26 | 0.60 | 175 | Startup timestamp exception |
| `whip-default-amf` | 59.99 | 0.46 | 174 | Passed |

The strict check requires a full decode without errors, Baseline/Constrained
Baseline H.264, zero B-frames, increasing timestamps, frame rate within 1 fps
of target, and nonzero decoded stereo audio. Auto WHIP's RTSP-remuxed file had
six duplicate timestamps at 0.917 seconds and no backward timestamps. The
actual Chrome WHIP receiver played video; this does not turn the file's strict
timestamp failure into a pass. This limitation was also present in the earlier
candidate measurements.

These are short workflow observations, not a repeated encoder ranking. CPU
means include publisher children; one core is 5% of this 20-logical-CPU host.
[Full numeric measurements](release-0.2.65-windows-metrics.json) include separate
process GPU engines, whole-system CPU, memory, actual audio/video bitrate,
frame timing and decoder observations. GPU engines must not be summed into a
single GPU utilization percentage.

AMD H.264/AV1 and software VP9 also passed the actual GUI codec-selection,
moving-window/stereo-audio playback, viewer-reload and transport-restart
workflows. Their explicit 720p30 / 4 Mbps codec setting is separate from the
60 fps default-output matrix above.

Evidence identifiers: `release-readiness-20261017-214429.md`,
`dual-quality-soak-2026-10-18T02-47-15-023Z.md`,
`soak-2026-10-18T03-17-21-304Z.md`, and focused artifacts under
`native-qt/e2e/reports/release-0.2.65/`. Private measurement evidence is under
the research workspace's `private/app-releases-20261018/`.


## Initial failures and follow-up

The original aggregate readiness invocation remains a failed invocation;
focused reruns do not rewrite its history.

- A QA documentation gate referenced the previous package version. The guide
  example was updated and the focused gate passed.
- Desktop source selection and capture-compatibility clicks failed while a
  Windows Security prompt from a concurrent research OBS process obstructed
  the interface. The update-footer browser-launch workflow also failed.
  The prompt was closed without changing firewall permissions. Both desktop
  workflows and the complete update workflow passed focused reruns after
  research was paused. The signed application was unchanged.
- The data-channel fixture expected the old 192 kbps audio value on unlock.
  It now expects the new 128 kbps default; the complete focused control workflow
  passed against the unchanged signed application.
- Edge's relay-only case timed out without publisher candidates reaching the
  viewer. Other TURN workflows and both Firefox relay cases passed. The cause
  is not established. Two separate Edge relay-only reruns each passed all five
  checks, including actual relay-pair selection, media and data delivery. The
  first failure remains retained; this is not a claim of an application fix.

An earlier research pause had suspended only its Windows launcher. The actual
controller was subsequently suspended and its active child allowed to finish
before endurance measurements. Nine overlapping research attempts are marked
invalid for isolated timing/performance comparisons and queued for separate
serialized reruns. No raw observations were deleted or converted to passes.

Build, 21 CTest checks, syntax, signing, archive identity and installer
construction are gates, separate from the application workflows above.

## Limits

Existing WHIP-to-RTSP receiver startup timestamp duplication remains a known
limitation; browser playback and strict relay-file timestamps are separate
checks. AV1/HEVC receiver support varies. External RTMP/SRT/WHIP/RTSP/UDP/RIST
output remains H.264. Clean-machine setup, AMD-only systems, other drivers,
HDR/10-bit, demanding games competing for GPU resources, and overnight
endurance are not qualified by this run. Game Capture's elevated installer
installation/upgrade is not repeated in this non-administrator session.

Application and installer signatures identify Social Stream Ninja and include
timestamps. This host reports an untrusted certificate root; signing does not
establish SmartScreen reputation. Builds and qualification run locally, with
no requested GitHub Actions build.
