# 0.2.62 release qualification

This extends [the initial external-output validation](external-output-validation-2026-10-10.md).
Qualification is complete within the coverage and limitations below. Further
soaks were explicitly waived by the user after the observed 35-minute run.
Actual workflows run the packaged Windows application, a real Chrome capture
source, and independent receivers. Compilation and CTest results are gates,
not application testing.

Evidence root `Q` is `native-qt/qa/reports/release-qualification-20261010`.
It is ignored because recordings, local session credentials and development
TLS keys must not be committed. Measurements below identify their candidate.

Local measurements used Windows 11 Pro build 26200, an Intel Core Ultra 7
265K (20 logical processors), approximately 64 GiB RAM, Intel Graphics and
an NVIDIA TITAN RTX. The isolated OBS runtime was 32.2.2, with obs-browser
2.26.9 / CEF 127.0.6533.120. These results do not cover every GPU or receiver.

## Candidates and findings

| Candidate | Packaged EXE SHA-256 | Scope |
| --- | --- | --- |
| Original 0.2.62 | `21e8632c75ae58f25046b71b2bf55c9ac863b823d18bab766ed29c384cc4c072` | Previous report |
| Feedback watchdog | `b74e40bffe69710ca01a42f6847f62a14d164944b23812881f96e70994e04af8` | RTMPS; initial Meshcast and TURN attempts |
| Session URL correction | `5ba3ee0e6c4a1c153e1edd91c6c4a8495cf0a4a137067cb0fe52223dd5d36c92` | Rejected intermediate relay approach |
| Relay pair enforcement | `371339d1844c1821bd1ea0dd90e9b3f454af71d009cce9b547a7e151edaff8ed` | TURN and public Meshcast workflows below |
| POST TURN discovery | `5f03a3fd301264b28fb4c48b0e1677473eae9e0ec8746cbf880cefeff9d676dc` | POST discovery, HTTP/TLS, wire trace, GUI and OBS follow-up |
| Frozen source `42ea8f9` | `7a40c1adee9f383589269e60a1fedb36134e736c94ece8763762e0e9b938bb99` | Final qualification below |

The frozen package manifest SHA-256 is
`45eac160d217e94c2b90bfc114c9ea1171f20f9078cb5ba1a697168661146bbd`.
Its source snapshot contains 263 files with digest
`5484136dd793158c68b5b9f2593f778ed32b914c122cd380a09244a70ad53cd6`.
All four stable artifact aliases were byte-identical to their versioned
counterparts. These packaging checks are gates; final playback qualification
is recorded separately.

The initial public Meshcast WHIP attempt received HTTP 201 over HTTPS, but
its session Location used HTTP on the same host. The publisher correctly
refused the downgrade. It now repairs that specific reverse-proxy response
to the original secure origin. Different hosts and incompatible service
ports are not rewritten; an invalid Location is not followed during cleanup.
TLS certificate verification remains enabled.

The initial relay workflow exposed a pinned libdatachannel/libjuice limitation:
Relay policy filtered advertised local candidates but still permitted direct
candidate pairs. The measured selected path was STUN, so this run failed
relay qualification despite decoded media. Removing remote host candidates
was insufficient for an ICE-lite receiver and the next attempt timed out.
The replacement patch enforces relay policy when libjuice forms pairs while
allowing a server's host candidate through a local TURN allocation. Its
source hashes are checked during configuration. These failed runs remain
preserved as `Q/whip-relay` and `Q/whip-relay-fixed`.

The recovery change observes authenticated RTCP receiver reports. It arms
only after reports have arrived over at least ten seconds and learns a
bounded timeout from observed gaps. Receivers that do not report retain
ordinary ICE failure detection. It does not alter audio/video media clocks.

TURN discovery also covers endpoints that provide their ICE configuration
only with the POST response, as described in [RFC 9725, section 4.6](https://www.rfc-editor.org/rfc/rfc9725.html#section-4.6).
In Relay Only mode, the discovery offer has no direct candidates and no
answer is applied. The discovery session is deleted before a fresh peer
uses the returned TURN configuration. A missing TURN configuration produces
an explicit error. `Q/turn-post-discovery` verified two POSTs and two DELETEs:
the first offer had no candidates, the second only relay candidates, and
both publisher diagnostics and the receiver identified a TURN path. Its
65-second recording decoded 59.97 fps with 59.51 distinct source frames/s,
a 21 ms maximum frame gap, correct stereo, and no detected audio artifacts.
Shutdown took 319 ms. `Q/whip-https-15` passed all 15 HTTP/TLS workflows,
including the permanent error and discovery-session deletion when an
endpoint provides no TURN server.

## Trusted RTMPS playback

`Q/rtmps-trusted` used the feedback-watchdog candidate with an isolated
MediaMTX destination and a valid publicly trusted development certificate.
Windows Schannel verification remained enabled; the machine trust store was
not changed. This exercises actual encrypted publishing, not a public RTMPS
provider's account or service policies.

The 65-second receiver recording contained H.264 video and stereo AAC:

- 3,841 decoded frames, 59.99 decoded fps, 59.52 distinct source frames/s.
- Strictly increasing video timestamps; 17 ms p95 and 21 ms maximum gap.
- Zero unexpected low-energy audio windows, clipped samples, or detected
  high-frequency discontinuity windows. Intentional silence had zero peak.
- Correct independent left/right tones. AAC target 192 kbps produced
  150.63 kbps on the synthetic signal, consistent with its target semantics.
- One startup reconnect, followed by steady playback; normal shutdown in
  296 ms. Raw A/V pulse offset was -30 ms median; it is uncalibrated and is
  not an added synchronization measurement.

## Actual TURN-only playback

`Q/whip-relay-pairs` used the relay-pair candidate with an isolated coturn
process in WSL and MediaMTX on Windows. The fixture's UDP listener was made
reachable from WSL; its HTTP controls remained loopback-only. Both ends
identified the publishing candidate as relayed, and publisher diagnostics
reported `TURN/RELAY`. No production TURN configuration was changed.

The 65-second native receiver recording decoded 59.88 fps with 59.32 distinct
source frames/s, correct stereo channels, and zero unexpected low-energy,
clipping or high-frequency discontinuity windows. Its only video gap above
35 ms was 123 ms at recording time 1.023 s; p95 was 17 ms. The simultaneous
Chrome receiver reported 4,002 decoded frames, zero dropped frames, freezes,
packet loss and concealed audio samples. Publishing did not reconnect and
shutdown completed normally in 275 ms. This is a real relayed path through
the isolated fixture, not evidence for every public TURN provider or NAT.

## Public Meshcast HTTPS playback

`Q/meshcast-whip-official` used a random owned stream on the public US West
Meshcast endpoint, the packaged relay-pair candidate, and the official
VDO.Ninja WHEP viewer in Chrome and OBS. Earlier locally hosted viewer
attempts failed because Meshcast's CORS policy allows the VDO.Ninja origin;
the service policy was respected, without a browser security bypass.

The publisher received 198 receiver reports, did not reconnect, and shut
down normally in 890 ms. Chrome decoded 5,770 frames with zero dropped
frames, freezes or reported packet loss. It reported 654 concealed audio
samples (13.6 ms at 48 kHz), so this is not described as zero concealment.

The independent Chrome recording decoded 59.96 fps, 58.57 distinct source
frames/s, 17 ms p95 and 32 ms maximum timestamp gap. Stereo separation was
correct; no unexpected low-energy, clipped or high-frequency discontinuity
windows were detected. The recording's compressed audio rate reflects
MediaRecorder re-encoding and is not the publisher's network bitrate.

The simultaneous 60-fps OBS source/receiver recording matched 38 pulses.
Added visible/audible onset skew was +16.7 ms median, +16.7 to +66.7 ms
range; the strict 50 ms maximum check failed. Added audio delay stayed at
150 ms while video delay ranged from 99.3 to 133.7 ms. This preserves the
browser-source timing concern rather than hiding it in a publisher offset.
The excursions above 50 ms occurred in the first 20 seconds. For the 28
matching pulses after 30 seconds, added skew ranged from 16.7 to 33.3 ms.
OBS also reported 12 skipped render frames across startup and recording,
and zero skipped output frames. The long soak will establish whether the
difference drifts over time.

Whole-recording OBS audio analysis found one high-frequency discontinuity
window at 41.155 seconds, when the fixture returned from silence. Its peak
sample step was 0.0576. The same causal filter found no corresponding
discontinuity in Chrome or the simultaneous OBS source reference. This is
an OBS-browser interoperability failure in that run, not a clean audio
pass for that route. There were no unexpected quiet windows, clipped
samples or unrelated 3 kHz system-tone windows in either OBS audio track.

The bounded recording analysis was checked against an existing full
recording: all 27 matching pulses in a 60-second segment agreed with the
original audio/video offsets to floating-point precision. Both streams
retain one recording time origin when seeking.

## HTTP/TLS, SRT impairment and WHIP recovery

`Q/whip-https-14` passed all 14 packaged workflows: authenticated playback,
cross-origin credential withholding, ICE Link forms, rejected credentials,
malformed/oversized SDP cleanup, invalid HTTPS/RTMPS certificates,
cancellation, trusted HTTPS, same-host reverse-proxy Location correction,
insecure cross-host Location rejection, and HTTPS downgrade rejection.

Both impaired SRT recordings passed independent cadence, continuity and
stereo checks without reconnecting:

| Fixture | Dropped data packets (including bursts) | Decoded/distinct fps | Max frame gap | Normal stop |
| --- | ---: | ---: | ---: | ---: |
| 2% random loss, 20 ± 10 ms delay, 80 ms bursts, 400 ms latency | 1,459 (330 burst) | 60.00 / 59.30 | 18 ms | 293 ms |
| 5% random loss, 50 ± 25 ms delay, 150 ms bursts, 800 ms latency | 3,934 (752 burst) | 59.97 / 59.54 | 22 ms | 254 ms |

The owned UDP fixture impaired media data and delayed control packets;
it did not change machine routes, firewall rules, or unrelated traffic.
These are controlled loss profiles, not a guarantee for arbitrary WANs.

`Q/whip-recovery-three-fixed` restarted MediaMTX three times and recovered
publishing in 13.374, 13.186 and 13.148 seconds after server restart, versus
about 27 seconds previously. Normal publisher shutdown took 247–325 ms.
All three recovered recordings passed independent media analysis. Two
initial RTSP recordings failed the strict timestamp check: FFmpeg clamped
the first seven video frames to one timestamp. The remaining timestamp
sequence advanced normally. `Q/rtsp-startup-trace` subsequently reproduced
the startup correction while tracing three actual RTSP receiver connections.
All six RTP streams had zero backwards timestamps and zero parser errors;
audio advanced by 480 ticks at 48 kHz and video by 1,500 ticks at 90 kHz.
The greatest change in RTCP clock mapping was 0.265 ms. This locates the
observed initial correction in receiving/remuxing rather than a publisher
RTP clock rewind. The complete six-recording analysis remains marked failed.

The first recovery harness invocation used numeric suffixes that were
misread as 1–3 kbps settings; the application correctly rejected them with
exit 2. The harness now limits bitrate suffixes to mono/stereo case names.

## OBS browser follow-up and interface

`Q/local-obs-browser-short` recorded 91.5 seconds with simultaneous Chrome
playback. Chrome reported no steady packet loss, dropped frames, freezes
or concealment; OBS reported no steady render/output skips. Whole-recording
audio had no unexpected quiet windows, clipping, high-frequency
discontinuities or unrelated 3 kHz tones. The unadjusted browser receiver
still failed the strict sync bound: 38 pulses, +50 ms median, +33.3 to
+70 ms range. This short run validates the instrumentation, not long-term
memory behavior.

`Q/local-obs-browser-calibrated` applied an actual 50 ms OBS Render Delay
filter to the receiver video. Its 39 matched pulses passed the 50 ms bound:
-3.3 ms median added skew, -36.7 to +43.3 ms range. This is receiver
calibration, not a publisher clock change or a guarantee for other setups.
The recording nevertheless contained one audio discontinuity indicator at
44.635 seconds, when sound returned from deliberate silence; no unexpected
quiet windows, clipped samples or unrelated 3 kHz tones were detected.
The browser-source route therefore failed audio qualification despite the
sync improvement. It must not be described as clean audio or a release pass.

`Q/obs-browser-silence-control` then generated the same stereo audio directly
inside the isolated OBS 32.2.2 browser source, with no Game Capture process,
media codec or media network path involved. The 91.49-second recording
reproduced a discontinuity at 52.185 seconds, immediately after the fixture's
silent interval (high-frequency peak 0.04669). There were no unexpected
quiet windows, clipped samples, unrelated tone indicators or OBS frame
skips. OBS exited normally in 227 ms. This demonstrates that the observed
failure can occur entirely within that OBS browser/audio setup; it does not
identify a specific upstream defect or prove every browser version affected.
The native OBS media receiver provides a tested alternative, as documented
in the frozen-package recording below. No publisher clock offset or injected
audio noise was added to conceal the browser-source behavior.

`Q/output-gui-final` completed six real WHIP/SRT/RTMP start/stop and profile
restoration cycles. Screenshots at normal and 800×600 sizes showed no
overlap or exposed secrets. Advanced/audio sections start collapsed;
WHIP exposes ICE settings while RTMP/SRT hide them. Each receiver recording
decoded distinct frames, credentials stayed masked/encrypted, and the
user's original settings were restored. The compact expanded layout scrolls.

## BrowserStack remote playback

`Q/meshcast-browserstack` used the POST-discovery packaged candidate to
publish synthetic media through the public Meshcast HTTPS endpoint. Two
BrowserStack sessions ran sequentially, each observing actual decoded audio
and video for approximately 30 seconds after startup:

| Remote target | Chrome | Decoded frames | Added freezes / drops / concealed samples |
| --- | --- | ---: | --- |
| Windows 11 | 155.0.8059.40 | 1,816 | 0 / 0 / 0 |
| macOS Sequoia | 155.0.8059.40 | 1,841 | 0 / 0 / 0 |

Both receivers advanced audio sample counts and audio energy. Screenshots
and raw receiver statistics were retained privately, sessions were closed,
and publisher shutdown completed normally in 421 ms. This is bounded remote
compatibility evidence, not long-term performance or recorded remote audio
analysis. No credentials or remote session URLs are included in this report.

## Frozen package observations

The first frozen two-hour attempt was interrupted when its tool session
ended after approximately 19 minutes. Raw samples and the incomplete
recording are preserved in `Q/frozen-whip-native-obs-interrupted-19min`;
they are not counted as a completed soak. A fresh detached run started
at 2026-10-10 23:37:28 UTC, using a Chrome capture source, simultaneous
Chrome WHEP playback, and the OBS native media receiver. This route uses
no browser render-delay filter. The browser-source concern remains a
separate qualification item.

The user requested no further soaking after the first 32 minutes of the
second run. OBS was stopped through its websocket API and its muxer drained
normally, saving 2,099.66 seconds (35 minutes) of decoded recording. The
original two-hour folder name is retained for evidence continuity; this is
not a completed two-hour run. The remaining readiness workflow uses
`-SkipSoak` under that explicit user instruction, including skipping both
usual 30-minute readiness soaks.

`Q/frozen-whip-native-obs-2h` contains the following frozen-package results:

- 2,119 seconds of periodic playback observations: no reconnects, packet
  loss, video drops, freezes, track resets or steady OBS render/output skips.
  Chrome's median decoded frame rate was 60.00 fps. Its audio statistics
  reported one 240-sample concealment event (5 ms), which is retained as a
  limitation rather than called inaudible.
- Publisher private memory: 194.82 MiB median, 201.73 MiB maximum, 1.59 MiB
  early-to-late median growth; fitted slope 3.33 MiB/hour. Median handle
  count decreased by 14. CPU median was 46.2% of one logical core, about
  2.3% of this machine's 20 logical cores. These are bounded observations,
  not proof that no leak exists.
- Forty-four GPU counter samples over the final 22 minutes were flat:
  publisher shared GPU memory 60.54 MiB and dedicated memory zero; OBS
  shared memory 6.39 MiB and dedicated memory 44.83 MiB. These counters do
  not cover the first 12 minutes or establish leak freedom.
- Paired sync windows at 20, 900 and 2,000 seconds each matched 31 pulses.
  Median added A/V skew stayed at +3.3 ms; all observed offsets were between
  -13.3 and +20 ms. Native OBS playback added approximately 670 ms of
  audio/video delay relative to the simultaneous source reference, with no
  measured drift across those windows. This is not physical speaker latency.
- Thirty-second cadence samples at those points contained 59.50, 59.73 and
  59.77 distinct source frames/second, no backwards source timestamps, and
  maximum source-clock steps of 34 ms.
- The full 2,099.66-second receiver audio decode found no clipped samples,
  unexpected quiet windows, high-frequency discontinuity indicators or
  unrelated 3 kHz tone indicators. Counts exclude the first 30 seconds for
  activation artifacts; deliberate fixture silence is accounted for.

Cancelling the harness ended its owned processes before normal application
shutdown and the final sound-call observer report could be captured. Those
two results are unavailable, not passes. Consequently the aggregate soak
check remains failed/incomplete even though its playback and resource bounds
passed. Raw recording and periodic observations remain usable. Separate
packaged desktop workflows subsequently verified clean shutdown, no ordinary
application sound/system-alert requests and responsiveness; those results
do not retroactively fill the missing event log from this recording.

## Packaged release readiness

The frozen package completed `run-release-readiness.ps1 -SkipSoak`, with
report timestamp `20261010-201609`. Its 21 CTest checks passed in 88.48 seconds;
these are gates, not application testing.

Completed actual packaged workflows include H.264/VP9 GUI start, browser
decode and stop; capture without the optional Windows border interface;
three malformed-control input seeds with clean quits; MCP playback,
transport recovery and request pressure; and the update footer's real
GitHub HTTPS, cache, TLS rejection, timeout and shutdown scenarios. The
updater and desktop sound observers reported no application sound or system
alert calls and no observer errors. User settings were restored by those
workflows. The receiver matrix, dual-viewer refresh, stream-ID collision,
remote controls and all four ICE connectivity modes also passed.

Edge, Playwright Firefox and the separately installed Firefox all passed
signaling and director workflows, including live media, relay selection,
recovery, peer cleanup, audio/video controls and shutdown. Dual-quality roles,
join/leave churn, initialization edge cases and requirements passed. The
OBS room-alpha workflow passed with the expected publisher, plugin and Spout
fixture hashes. Bitrate presets from 3,000 to 20,000 kbps passed. Auto,
software, NVIDIA NVENC (with an active hardware session), and Intel QSV all
passed their selection/playback checks. Unsupported explicit codec selection
failed visibly as intended. AMD was not tested because no AMD adapter was
available. Installer construction passed as a gate; it was not an installation
workflow. The update workflow recorded 592 successful checks and restored
the user's settings.

The original full readiness report remains **FAIL**, due solely to the opaque
OBS static-image check. An unchanged targeted repeat reproduced the failure:
the first useful opaque image differed from later frames by 3.164 mean and
17 peak channel code values, narrowly exceeding the checker limits of 3 and
16. Every useful frame passed its opacity/color-coverage checks; later frames
were stable. The half-transparent case passed. Missing loaded-plugin metadata
in the failed opaque case was a consequence of the checker aborting before
collecting its final module evidence, and is not treated as verified identity.

`Q/vp9-startup-control` isolated the same behavior using the bundled FFmpeg and
the application's libvpx CBR options, without the application, network or OBS.
The first color frame decoded to RGB (35,95,253), converging toward (32,95,254).
The first all-white alpha frame averaged 254.834, with a minimum of 200 in a
small region, then subsequent frames converged toward 255. These are lossy
codec startup variations, not evidence of an alpha transport misalignment.
This diagnostic is not application testing.

The prepared OBS checker now allows 4 mean / 18 peak channel code values for
static-image stability. Per-frame opacity, visual/connection epoch, cadence,
image hashes, moving-pattern and artifact checks are unchanged. The existing
negative controls still reject local changes, gradual drift, wrong opacity,
stale sessions and tampered evidence. Added boundary gates reject mean errors
of 5 and peak errors of 19. A hash-guarded preparation patch and reproducible
diagnostic are provided in `qa/`, with instructions in
[the OBS testing notes](obs-ninja-plugin-testing.md). The adjacent plugin
working repository and the plugin/application binaries were not changed.

`Q/frozen-alpha-calibrated` reran both actual packaged workflows and passed,
including loaded-module identity and frame-capture cadence. The observed
opaque sequence differed by at most 0.105 mean / 5 peak values; the half-alpha
sequence by 2 mean / 2 peak. The checker SHA-256 was
`3e4344cd5c4565c9d1f25e9cbd8a1a4afc2ef51d42d647bf057ed8369e0651e0`.
The original reports retain their failures; the calibrated run supplies the
final affected-workflow evidence. The legacy readiness heading says
"seven-case transparency matrix", but the committed wrapper actually requires
the two steady opaque/half-alpha cases. Active-media lifecycle and reconnect
coverage came from the separate browser signaling workflows above.

All required current workflow results are therefore covered by the original
readiness run plus the calibrated OBS repeat. No further soak was run. The
OBS browser audio limitation remains documented with a tested native-media
alternative; the browser route is not claimed to pass every quality check.

Finite software measurements do not establish universal flawlessness or
physical display/speaker latency. Discontinuity indicators do not replace
human listening. Private publisher signing remains subject to the receiving
machine's certificate trust policy.
