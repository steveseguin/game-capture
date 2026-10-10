# 0.2.62 release qualification

This extends [the initial external-output validation](external-output-validation-2026-10-10.md).
Qualification is in progress; this document does not yet authorize publication.
Actual workflows run the packaged Windows application, a real Chrome capture
source, and independent receivers. Compilation and CTest results are gates,
not application testing.

Evidence root `Q` is `native-qt/qa/reports/release-qualification-20261010`.
It is ignored because recordings, local session credentials and development
TLS keys must not be committed. Measurements below identify their candidate.

## Candidates and findings

| Candidate | Packaged EXE SHA-256 | Scope |
| --- | --- | --- |
| Original 0.2.62 | `21e8632c75ae58f25046b71b2bf55c9ac863b823d18bab766ed29c384cc4c072` | Previous report |
| Feedback watchdog | `b74e40bffe69710ca01a42f6847f62a14d164944b23812881f96e70994e04af8` | RTMPS; initial Meshcast and TURN attempts |
| Session URL correction | `5ba3ee0e6c4a1c153e1edd91c6c4a8495cf0a4a137067cb0fe52223dd5d36c92` | Rejected intermediate relay approach |
| Relay pair enforcement | `371339d1844c1821bd1ea0dd90e9b3f454af71d009cce9b547a7e151edaff8ed` | TURN and public Meshcast workflows below |
| POST TURN discovery | `5f03a3fd301264b28fb4c48b0e1677473eae9e0ec8746cbf880cefeff9d676dc` | POST discovery, HTTP/TLS, wire trace, GUI and OBS follow-up |

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
an unresolved OBS-browser interoperability observation, not a clean audio
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
The browser-source route therefore remains unresolved despite the sync
improvement. It must not be described as clean audio or a release pass.

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

## Remaining qualification

The long soak, complete packaged release-readiness workflow and final frozen
artifact identity remain to be recorded before publication. The OBS browser
audio observation remains unresolved; publication must not imply that this
route passed all quality requirements.

Finite software measurements do not establish universal flawlessness or
physical display/speaker latency. Discontinuity indicators do not replace
human listening. Private publisher signing remains subject to the receiving
machine's certificate trust policy.
