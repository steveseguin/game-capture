# macOS 0.2.65 Beta 3: bounded VT bitrate

**Experimental Apple Silicon Beta 3 prerelease; public download qualification passed.**
Windows remains the production release. This report does not establish full
Mac production readiness.

## Change and reason

Beta 2 reconnected with “WHIP media send failed” when a held synthetic source
transitioned to complex motion, in both landscape and portrait. Its VT H.264
path requested an average bitrate without a burst limit. Short encoded-output
samples reached roughly 8.8–11.1 Mbps at a 3 Mbps target. Burst/pacer interaction
is plausible, but the exact internal failure has not been instrumented separately.

Beta 3 retains average rate control and adds a half-second VT DataRateLimits
budget at 1.5 times the requested bitrate. Startup and existing live bitrate
updates use the same policy. At 4 Mbps that budget is 375,000 bytes / 0.5 s.
It is not a total-network hard ceiling. Simple images can use less bandwidth.

The runtime diff from Beta 2 is confined to
`native-qt/src/platform/macos/video_encoder.cpp`. HEVC, x264, pixel conversion,
Windows runtime, Auto → VT → x264 and the 720p60 / 4 Mbps window defaults are
unchanged. H.264 retains Constrained Baseline, real-time mode, no B-frames and
one-second keyframes. Only existing VDO.Ninja `targetBitrate` and `remote` fields
are used for live control.

Source: [`c7104c5`](https://github.com/steveseguin/game-capture/commit/c7104c5cccce2878ded041489bf1285e409e9723).
App ZIP SHA-256: `aae737d3f63490280feea6054f0c2e345b08ef51b676d6bda4d1cc736e5b537b`.
Corresponding source SHA-256: `7e9abd43808431540f3f5eeaf1567319f623c3e497a89bf0f710dab9671f9544`.
Executable SHA-256:
`c0f3612991c1fb5bad48cd2ce999c889faf8c31acd0f9528dfed77beacda6c7a`.

## Actual packaged-application testing

All work here uses one Apple M1 MacBook Air with 8 GB RAM and macOS 26.4.1.
The signed candidate completed:

- Six 60-second camera → native app → WHIP → MediaMTX → RTSP recordings:
  1280×720 and 720×1280, 30 fps, 3 Mbps, three repeats each. All 1,800 source
  frames were retained contiguously in each run, without reconnect.
- Five live bitrate changes using a high-detail 1080p30 virtual-camera source.
  Requested 4,000 / 2,500 / 6,000 / 3,000 / reset-to-2,000 kbps produced roughly
  3,865 / 2,500 / 6,014 / 3,085 / 2,016 kbps received video payload. Each paired
  ten-second window delivered 29.89–30.00 decoded images/s, with no new native
  frame drops, encode failures/timeouts or send failures. Invalid-token control
  was rejected. Stereo, silence, held image, late viewer and expected camera-stall
  shutdown also passed.
- An actual GUI WHIP workflow: profile save/quit/relaunch with the same Keychain
  reference, five paired ten-second 1080p30 windows, stereo/silence, held image,
  late viewer, receiver-server restart/recovery and Quit/profile cleanup.

The exact notarized ZIP also passed browser download with quarantine preserved,
GUI settings/relaunch, 30-minute VT streaming at 720p60 / 4 Mbps with continuous
stereo, a separate one-minute x264 media workflow, and Beta 2 manual replacement
with preferences retained. All 180 VT and six x264 ten-second observation windows
met their cadence and audio targets. The VT windows contain 107,995 decoded observations and 107,991 distinct
identities summed within windows, at 59.89–60.10 distinct images/s; these are windowed observations, not a
continuous video recording. Native encode/send failure counters stayed zero.
The native dropped-frame counter was 4 at the first endurance sample and stayed
4 throughout; startup is not claimed drop-free. VT RSS was about 104 MiB
at the beginning and 60 MiB at the end (peak 104 MiB). Final controls included frame-rate changes,
held image, audio silence/resume, resize, a late viewer and shutdown.

Independent audits reproduce the frame, cadence and continuous PCM results from
retained observations and validate the sanitized export. These audits are gates;
the app workflows above constitute testing.

The public [Beta 3 ZIP](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.65-beta.3)
then passed a real GitHub browser download with its expected hash and quarantine
preserved, GUI settings/relaunch, and separate one-minute VT/x264 720p60 video
and stereo workflows including final controls and shutdown. Windows v0.2.65
remains the latest stable release; its payload and the previous Mac release were
verified unchanged. [Delivered-package evidence](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-18-apple-m1-0265-beta3)
requires benchmark-repository access.
Fresh macOS 14.8.9 ARM64 VM startup/diagnostics workflows pass on the exact ZIP:
authentication, diagnostics export without credentials, native resource reporting,
graceful Quit and explicit invalid-source/camera/settings refusal, across two
launches. This is startup coverage, not hosted VT or physical-device media testing.
[Hosted run](https://github.com/steveseguin/game-capture/actions/runs/39164648994).

## Quality comparison

The constant-bitrate alternative also completed six full recordings. Values
below are means of three 60-second runs per cell; burst sizes are maxima across
those runs. These are synthetic native-input sample-domain measurements.

| Orientation | VT policy | Actual kbps | VMAF | PSNR dB | Largest 15-frame payload |
| --- | --- | ---: | ---: | ---: | ---: |
| Landscape | Bounded average | 3004.1 | 96.046 | 41.910 | 253,730 bytes |
| Landscape | Constant | 3026.2 | 96.144 | 41.988 | 321,564 bytes |
| Portrait | Bounded average | 3003.9 | 93.078 | 40.409 | 246,207 bytes |
| Portrait | Constant | 3024.9 | 93.411 | 40.567 | 380,294 bytes |

Constant bitrate scores slightly higher here. Bounded average is selected for
smaller bursts and lower simple-scene bandwidth, not a claimed quality gain.
A tighter preliminary half-second limit delivered about 2.11 Mbps at a 3 Mbps
target and was not selected. Fifteen-frame windows exclude network overhead and
are not arbitrary wall-clock bandwidth ceilings. GOP phase varies by startup
and is retained in the results.

Scoring uses exact contiguous source identities, the native BGRA→I420 reference,
VMAF v0.6.1, PSNR and SSIM with identical explicit metadata and automatic color
conversion disabled. Independent pixel checks and shifted-reference controls
validate the analysis. Earlier OBS High/CBR scores use a different sample domain
and profile and must not be ranked directly against these native scores.

## Gates, retained findings and limits

Developer ID signing, accepted notarization, stapling, Gatekeeper, source archive
completeness, hashes and numeric analysis are gates, separate from application
testing. The initial source-packaging gate rejected a sparse checkout before
creating an archive; the isolated checkout was completed without changing the
candidate revision, then packaging passed.

The first quality analysis wrongly applied reference GOP spacing to adjacent
startup IDRs. The corrected gate covers the measured segment and its leading GOP;
negative controls reject extra/missing measured IDRs. Original recordings were
unchanged. The initial collector's shutdown failures and the released reconnect
attempts remain retained separately. GUI bitrate editing is intentionally locked
while live; an earlier harness assumption was corrected to use existing authorized
VDO.Ninja live controls instead.

The 1080p30 Chrome WHIP lane reports
`level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`.
It proves playback in that receiver, not compatibility with every strict
level-limited receiver. The separate 720p30 quality bitstreams were independently
verified as Constrained Baseline level 3.1. Broader receiver negotiation remains
part of production qualification.

Physical macOS 14.2/privacy transitions, USB camera/mic disconnect, sleep/wake,
real display/audio-route changes, VoiceOver, another Mac, gameplay/thermal and
broader physical Windows GPU/installer qualification remain open. Synthetic
fixtures and a fresh VM cannot substitute for those. Earlier VFR alpha,
hosted-motion, recorder-clock and abrupt-viewer-close findings remain recorded.

[Full benchmark evidence](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-18-apple-m1-native-vt-h264)
and [original recordings/references](https://github.com/steveseguin/video-encoder-testing/releases/tag/apple-m1-native-vt-h264-2026-10-18)
require benchmark-repository access. Every archived media asset was downloaded
in full and hashed before local copies were removed to recover space.
[Previous Beta 2 results](macos-0265-beta2-validation-2026-10-18.md) remain separate.
