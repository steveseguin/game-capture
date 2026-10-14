# RTSP output and shared output improvements

Unreleased development builds, based on Game Capture 0.2.62 and Desktop Studio
0.9.0. Exercised on Windows with the packaged applications and a private loopback
MediaMTX 1.21.2 receiver. No public broadcast destination was used.

## Implementation

Both applications add RTSP/TCP (the default, also accepting the RTSPT spelling)
and RTSP/UDP destinations. RTMP/RTMPS already existed; RTMP was exercised again.
The GUI, capture CLI and Studio API/MCP expose the new destinations. Saved GUI
profiles are encrypted through the existing Windows user protection. Credentials
and URL paths stay out of diagnostics. Invalid URL schemes, missing stream paths,
RTSPT/UDP conflicts, unsupported credential fields and invalid AAC rates are
rejected rather than silently changing the requested output.

The FFmpeg child copies the existing H.264 video and encodes AAC audio. No extra
video encoder or server engine is bundled. TCP and UDP are explicit transport
choices, not automatic fallbacks. RTSP publishing still requires a server;
[the setup guide](rtsp-vrchat-output.md) explains publishing versus viewing URLs.

Three shared Studio improvements were ported to Game Capture:

- Pump FFmpeg progress without a timed wait on every media packet. The queue
  condition variable still sleeps when there is no work; this is not busy polling.
- Refresh an SRT connection once when its first progress arrives with stale
  startup media. The immediate fresh retry is bounded; ordinary failures retain
  the existing reconnect backoff.
- Detect a video encoder that stops producing frames even when audio continues.

Scene composition caches, browser workers and mixer-specific optimizations were
not copied into Game Capture. This change does not port Studio's newer WHIP
RTX/RED/pacing controls.

## Packaged application workflows

Game Capture's animated browser fixture provided moving video, stereo channel
identification tones and synchronized pulses. Actual selected-window capture
and application audio were published and received into MKV files.

| Output case | Decoded fps | Distinct source frames/s | Result |
| --- | ---: | ---: | --- |
| RTMP stereo | 59.991 | 59.834 | Passed |
| RTSP/TCP stereo | 60.036 | 60.036 | Passed |
| RTSP/TCP after receiver restart | 60.052 | 60.052 | Passed |
| RTSP/UDP stereo | 60.016 | 60.016 | Passed |
| RTSPT alias, mono | 60.015 | 59.913 | Passed |
| RTSP without audio | 59.984 | 59.679 | Passed |
| SRT stereo | 59.993 | 59.941 | Passed |
| SRT after receiver restart | 60.003 | 59.900 | Passed |

Each receiver segment was 20 seconds. Frame-gap p95 was 17 ms. Audio cases had
no unexpected low-energy windows or clipped samples, and channel checks passed.
Raw pulse offsets were about -43 to -77 ms. These are not calibrated independent
lip-sync measurements: process-loopback capture precedes the fixture's audible
drawing. RTSP and SRT recovered after a three-second receiver outage. This run
does not re-establish the earlier Studio measurement of SRT playout latency after
a long UDP outage.

Game Capture's focused GUI run also passed TCP and UDP publishing before and
after a full application restart. Both profiles restored their correct URLs.
The receiver decoded moving video in all four cycles, output controls locked
while live and recovered after stop, and no output children remained. Original
VDO.Ninja codec choices and the user's registry settings were preserved.
Screenshots include the RTSP controls and the compact window layouts. Evidence:
`gui-rtsp-final/results.json` (four successful cycles, settings restored).

Desktop Studio passed both headless automation and a complete GUI workflow:

- Select RTSP/TCP and enter an RTSPT URL through the output interface; start and
  stop through the Studio buttons. Screenshots were inspected.
- Receive and fully decode moving H.264/AAC with a continuous 731 Hz audio tone.
- Verify the receiver's negotiated publisher transport is TCP or UDP as selected.
- Kill the owned publishing FFmpeg process and restart the receiver. Publishing
  recovered; the main application and independent recording continued.
- Publish with RTSP username/password authentication. Reject a wrong password,
  stop the retrying output, then publish successfully with the correct password.
  Neither password appeared in application state or diagnostics.
- Publish RTMP and the RTSPT CLI/API alias. Reject invalid API configurations.
- Finish and fully decode the concurrent recording; quit without owned child
  processes remaining.

The final GUI receiver clips averaged 29.61–30.02 fps. After the first second,
the maximum frame gap was 34–35 ms. Some receiver joins had an initial gap up to
118 ms in the final GUI run (134 ms in an earlier run), with clean decoding.
The report keeps startup and steady cadence separate. Receiver restart recovered
in about 1.03 seconds in that GUI run. Its 70,823,964-byte independent recording
decoded cleanly, with no silent half-second windows in the analysed interior.

## Performance sample

For Game Capture RTMP at 1280x720/60, a short before/after sample using the same
fixture and encoder settings measured main-process CPU at 41.84% versus 35.56%
of one logical core. Working set was 172.41 versus 173.13 MiB. Five initial and
three final samples were excluded. The baseline capture was 25 seconds and the
candidate capture 20 seconds; this is preliminary evidence, not a repeatable
percentage speedup claim or an isolated attribution to a single change.

Application diagnostics reported the Hardware H.264 Encoder MFT path with NV12
input and zero video encode failures/drops in the RTMP capture. This run did not
add GPU utilization profiling or a new NVENC/QSV/AMF hardware matrix.

## Evidence and limits

Game Capture executable SHA256:
`bbb2cbdfe56f343d218b91f5e0824eedf61aa95430f13e3c6d6629dc1bb8daff`.
Desktop Studio executable SHA256:
`86529245ffd61a0ea13f9c1c1e6ae001d77a8fa6e790540c69a8c22283710e62`.

Ignored reports reside under each repository's
`native-qt/e2e/reports/rtsp-vrchat/`. Game Capture's `candidate/analysis.json`
contains the media analysis, and Studio's `studio-headless2/rtsp-results.json`
and `studio-gui-complete/rtsp-results.json` contain complete workflow results.
Ten negative capture-CLI validation cases passed. Builds, syntax checks and
whitespace checks are gates, separate from application testing above.

Earlier GUI-driver attempts were interrupted by a locked desktop or missed
checkbox clicks in a wide Qt layout. The driver now uses accessible checkbox
actions and waits for the controls to appear. A broader Game Capture GUI run
also preserved a short RTMP-to-RTSP join capture with only two distinct source
frames; the 20-second direct RTMP cadence/audio run passed. This short receiver
startup case remains a limitation, not a claim that every RTMP join is smooth.

Not verified here: playback inside VRChat/Quest, a particular hosted streaming
service, internet/NAT connectivity, encrypted RTSPS, or RTSP-over-HTTP tunnels.
No GitHub release was published for these development artifacts.


## Follow-up: UDP/RIST, streaming defaults and microphone control

Packaged follow-up builds were exercised on the same Windows desktop. Local validation artifacts are under `native-qt/e2e/reports/output-defaults/` (ignored by Git).

- Game Capture executable SHA-256: `052ec0d39eb098356ee6ac442d2c1a5a09136886c7da79ac5795e83c9046f97a`.
- Desktop Studio executable SHA-256: `46de76561cdbdb3733c4c6db7fdb267ad74fa8884ca49db9446aeaeb1ce03553`.
- Game Capture: the real camera/UDP GUI workflow produced video without an audio track when No microphone was selected; live mute produced digital silence, and unmute restored captured input audio. Both additional-microphone and primary-microphone routing were exercised. Settings survived restart and the original user settings were restored afterward.
- Desktop Studio: actual GUI selection of UDP and RIST, decoded moving video and 731 Hz audio, forced output-worker termination and recovery for both protocols, and concurrent independent recording. All received clips and the complete recording decoded cleanly. The user show was unchanged and owned workers exited on shutdown.
- Default streaming configuration was 2500 kbps. Explicit API bitrate selection still selected Custom. Malformed UDP/RIST endpoints and unsupported credentials were rejected.
- Earlier in this follow-up, Game Capture's animated-window UDP, RIST, RTMP and SRT streams each passed decoded cadence and stereo continuity checks at approximately 60 fps (`transports/analysis.json`).
- Explicit AMD selection reached `h264_amf`, then failed cleanly with the absent AMD runtime on this non-AMD machine. AMD GPU encoding and playback in OBS remain unverified; no AMD success claim is made.
- Unit/build gates are separate from the above application testing: each app's UI gate completed 93 checks with no failures; one system-tray check was skipped by the offscreen platform. The normal Windows unit harness could not position wheel targets reliably; the packaged GUI workflows used the real Windows interface.

New safeguards disable a missing saved microphone when the dropdown resolves to No microphone, gate microphone samples before audio routing, and preserve gain across mute/unmute. RIST recovery-buffer and camera-audio labels were checked visually. No GitHub release or clean-machine installation was performed for this follow-up.
