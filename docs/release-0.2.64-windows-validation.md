# Game Capture 0.2.64 Windows qualification

Auto encoding now tries AMD AMF before software when Windows cannot provide a
usable hardware Media Foundation encoder and an AMD GPU is present. Existing
working hardware encoders retain their priority. Explicit Software remains
software, and failed AMF startup falls back safely in Auto. The streaming
default remains 4 Mbps.

## Frozen package

The application was built from `5a434bf349c176391df7aceb86628d2e0db52917`.
Later test-runner and documentation commits do not change the application.

| Artifact | SHA-256 |
| --- | --- |
| Signed application | `67de007fa66e004c31f23b1aa91aa723332b4dde3121e450bed7f862ed0d3c29` |
| Setup installer | `626aa7c743b0edac26bd510009960a773a8f6c716863b7d95e7fe12a31959183` |
| Portable launcher | `680b51972d819f5103686d514e28701867632fdce5610cdcb06b580dd73fee18` |
| Portable ZIP | `5e5cfeb5db8d81c2a5395cbb78c5a2173385d221c20ae3f958847554d545205b` |
| Artifact manifest | `1ccce97bbf6db7645262da549868c9d9bcfedffffb8393e2071d6595c9bf3df9` |

Stable download aliases match their versioned files byte for byte. The ZIP
contains the signed executable used in the application workflows. Release
downloads include SHA256SUMS and FFmpeg source/build information.

## AMD application workflows

On RX 9060 XT, driver 32.0.22042.14002, Windows 11:

- H.264 and AV1 used real AMD AMF encoders. VP9 used the software encoder.
  Each streamed a moving captured window and stereo audio at 720p30, 4 Mbps.
  Initial playback, viewer reload and transport restart all passed in Edge.
  The nine measurement windows reported 29.97-30.06 fps, zero dropped frames
  and zero freezes. These are local measurements, not a guarantee for every
  destination or network.
- Hiding hardware MFT discovery only inside the owned test process made Auto
  select real AMF and deliver playable video/audio. Denying AMF process creation
  as well made Auto recover to software with playable video/audio. Installed
  devices and drivers were not changed.
- Supplemental bundled-FFmpeg driver checks produced and fully decoded 300
  H.264, HEVC and AV1 frames each, with increasing timestamps and at most
  34 ms between frames. These checks are separate from application testing.

See [codec results and receiver limitations](radeon-codecs-2026-10-16.md) and
[Auto encoder validation](radeon-rx9060xt-validation-2026-10-16.md).

## Other application workflows

- Packaged desktop source selection, start/stop and shutdown, H.264/VP9
  playback, delayed encoder probes and missing optional capture APIs passed.
- Malformed local-control input, MCP controls, transport recovery, device
  monitoring and normal process cleanup passed.
- Update checks handled bad metadata, offline/TLS/network failures, malformed
  and oversized caches, unwritable storage, restart and recovered cache writes.
- Browser playback, viewer reload, stream-ID collision, data-channel controls,
  direct/STUN/TURN connectivity and saved ICE settings passed.
- Edge, Playwright Firefox and the separate official Firefox build passed
  signaling recovery with real media. Removing/rejoining one viewer left the
  other playing, and active audio/video/alpha shut down cleanly.
- Director controls passed in all three browser variants. Official Firefox
  passed 58 checks in each of two focused reruns, including video off/on,
  audio mute, bitrate controls, keyframe requests and continuing playback.
- Dual-quality role assignment, join/leave churn and initialization fuzzing
  passed. OBS receiver output passed the room-quality transparency workflow
  and opaque/half-transparent steady-state cases. Pixel evidence and executable,
  plugin and Spout fixture identities were verified; screenshots were inspected.

The dual-stream endurance run passed **319 viewer join/decode cycles over
1,814 seconds** (30 minutes 14 seconds), across four batches. The separate
reconnect run passed **101 iterations over 1,805 seconds** (30 minutes
5 seconds), across five batches, with 15 seconds of playback per iteration.
Every batch passed on its first attempt. These are repeated workflow batches,
not a claim of one uninterrupted publisher process or overnight endurance.

### Initial failures and focused reruns

The original aggregate readiness run is retained, including its failures. It
is not relabeled as a wholly passing invocation:

- A documentation gate still looked for commands in README after they moved
  to the developer guide. The gate now reads the guide, and the guide supplies
  all required workflow arguments. The corrected gate passed separately.
- The official Firefox director initially timed out observing its video-off
  control. The unchanged signed application passed two subsequent full director
  workflows. The first added evidence of the trusted click and actual target;
  the second also used a hardened BiDi adapter that waits for stable,
  unobstructed controls. A separate adapter gate proved it waits for moving or
  temporarily covered controls and refuses permanently covered controls. The
  exact cause of the first missed operation was not established; this is not a
  claim that an application-side defect was fixed.
- The first invocation omitted `-RoomAlphaPublisherPath`, blocking both alpha
  workflows and their dependent installer build gate before execution. Both
  alpha workflows and the installer build gate passed separately using explicit
  frozen package/fixture identities. The corrected command is documented.
- An obsolete report label said seven transparency cases. The current runner
  exercises two steady-state cases plus the separate room-quality workflow;
  report labels now describe that coverage accurately. Signaling lifecycle
  coverage is separate.

The focused Firefox and alpha workflows overlapped part of the first
dual-stream endurance batch. These are functional stability results, not
isolated CPU/GPU benchmarks. Build, CTest, syntax, signing and artifact identity
checks are gates, separate from application testing.

The original readiness report is `release-readiness-20261016-104400.md`;
the passing endurance reports are `dual-quality-soak-2026-10-16T15-50-08-226Z.md`
and `soak-2026-10-16T16-20-13-897Z.md`. Evidence remains in
`native-qt/qa/reports/` for readiness and endurance, and
`native-qt/e2e/reports/release-0.2.64/` for codec, Auto fallback, director and
transparency workflows. Raw logs, temporary stream credentials and local
recordings are not published.

## Limits

HEVC starts on the AMD driver, but the tested native OBS Ninja receiver
supports H.264/VP9 and rejected HEVC. Use H.264 with that receiver. AV1 and
HEVC remain experimental VDO.Ninja options; external RTMP/SRT/WHIP/RTSP/UDP/RIST
outputs remain H.264. Existing WHIP loss/jitter and receiver startup-timestamp
limitations are not fixed by this release.

This host also has Intel and NVIDIA GPUs. AMD-only machines, other driver
versions, HDR/10-bit, demanding games competing for GPU time, clean-machine
setup and overnight endurance need separate coverage. The Windows installer
requires elevation, so installation/upgrade and firewall changes were not
repeated in this non-administrator session. Building an installer is a gate,
not an installation workflow.

Application/setup signatures identify Social Stream Ninja. This host reports
an untrusted certificate root; signing does not establish SmartScreen
reputation. The macOS beta is unchanged.
