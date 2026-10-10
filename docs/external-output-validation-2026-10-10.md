# External output validation — 2026-10-10

Version 0.2.62 adds a collapsed advanced destination selector for VDO.Ninja,
WHIP, SRT caller, and RTMP/RTMPS. VDO.Ninja remains the default. External
outputs use H.264 plus 48 kHz Opus (WHIP) or AAC (RTMP/SRT); audio may be
mono, stereo, or disabled. Windows encrypts saved destination profiles,
including URLs and credentials, with DPAPI.

The preceding quality release, 0.2.61, was committed and pushed separately
as `13e5c7b686cf7a12097e5ec3d49e7506640fcb64`. Its measured capture, audio,
sync, leak, and quiet-tray results are in
[the audio quality report](audio-quality-validation-2026-10-10.md).

## Method and evidence

These are actual signed, packaged application workflows. A real headed
Chrome window supplies changing video, a millisecond barcode, separate
440/880 Hz channels, 1 kHz sync pulses, and deliberate silence. MediaMTX
1.21.2 receives the output. Independent FFmpeg recordings and actual
Chrome/OBS playback verify delivered media. OBS uses a disposable portable
profile, with direct source capture and received output on separate audio
tracks in one recording clock. No normal OBS profile is modified.

Local evidence is under `native-qt/qa/reports/output-20261010/` (`O` below).
It includes original failures, recordings, screenshots, diagnostics,
resource samples, and process identities. Session logs can contain local
connection details; raw evidence is not committed.

Environment: Windows 11 Pro 25H2, Core Ultra 7 265K (20 logical processors),
64 GiB RAM, Intel Graphics/NVIDIA TITAN RTX, Chrome for Testing
143.0.7499.4, OBS 32.2.2, bundled FFmpeg
`n8.1.2-34-g9b6c8969e0-20260731`. The executable loaded from the complete
portable release directory is identified by SHA-256 in each result.

The final packaged executable is
`21e8632c75ae58f25046b71b2bf55c9ac863b823d18bab766ed29c384cc4c072`.
Its source snapshot is
`ffac4ef92d0bef602a6d458112e10291e76ee2baf2c02b4b560b84c34fe0704f`
(255 files); release manifest SHA-256 is
`9e629134a8adb65056985d9c4802834273b02482e60e60b8a470cc400cea66de`.
`native-qt/package-output-escaping.log` records ZIP, portable EXE, NSIS and
source-information packaging. It uses the existing Social Stream Ninja
signing certificate and DigiCert timestamp; Windows reports its private
publisher root as untrusted, identically to 0.2.61. No trust store was
modified and no VirusTotal or public release upload was performed.

All 21 compiled regression gates passed in 90.58 seconds after rebuilding
the final production changes. Syntax and diff checks also passed. These
are gates, distinct from the packaged workflows below.

Earlier candidate `c44ccee14b31f8ef89ef46851e34f1fcd8f122c83edd3367ef99b186c4019bdf`
supplied the longer media and 24-cycle evidence. Candidate
`d4a4aa275b794c106210c69d5c22f8312591bf074f1f08ad618e63d6715c0890`
added accurate video-only status and broader WHIP Link parsing. The final
candidate changes only SRT query encoding relative to that candidate;
the encoding, capture and media-clock paths are unchanged. Each workflow
retains its actual executable identity rather than relabelling earlier
runs as runs of the final binary.

## Defects found and corrected during implementation

- FFmpeg output initially reached the server but the worker did not pump
  child stdout without a Qt event loop. This caused false stalled-output
  reconnects. The worker now explicitly reads progress and requires an
  advancing frame/time counter.
- Raw H.264 and PCM input pipes would create separate media clocks. The
  output now supplies timestamped streaming Matroska to FFmpeg, retaining
  common capture PTS through H.264 copy and AAC encoding.
- Queues and progress/HTTP responses are bounded. Congestion reconnects
  with fresh media and a keyframe. Stop waits for owned processes and
  deletes WHIP resources, including resources created with malformed or
  oversized answers.
- A compact-layout screenshot exposed clipped credential “Show” text;
  button padding was corrected. Video-only publishing now displays “No
  audio” and does not label zero audio bitrate as an AAC target.
- A later encrypted-SRT workflow with literal `+`, `%2B`, `?`, `&`, `=`
  and a space exposed credential corruption in URL construction. The
  receiving server rejected the old package with “invalid passphrase”.
  SRT query values now receive explicit percent encoding, including
  values reconstructed from a complete URL. The original failure is
  preserved in `O/srt-escaping-before`.

## HTTP and credential workflows

`O/http-candidate` exercised eight packaged workflows on executable
`c44ccee14b31f8ef89ef46851e34f1fcd8f122c83edd3367ef99b186c4019bdf`:
authenticated WHIP, cross-origin 307 redirect, HTTP 401, malformed SDP,
oversized SDP, invalid HTTPS certificate, cancelling a hung POST, and an
invalid RTMPS certificate. All met their expected outcomes. Successful
WHIP cases used real MediaMTX negotiation and Chrome playback. Redirects
withheld the bearer token from the different origin; session DELETE ran
on stop and invalid 201 responses. Permanent WHIP failures exited with
code 3. Invalid RTMPS certificates transmitted no application data.
Cancellation and normal stop completed in roughly 250–320 ms in these
cases. Credentials were absent from application logs and diagnostics.

`O/cli-validation` ran 14 invalid configurations through that packaged
executable. All exited with code 2, including bad schemes, unsupported
codecs, absent SRT ports, listener mode, invalid passphrase/stream-ID
lengths, token newline injection, and missing output selection.

`O/http-final` repeats these workflows on the `d4a4` candidate and adds
two successful ICE-discovery cases: unquoted `rel=ice-server`, and a
quoted relation list containing `ice-server`. An actual local STUN
responder received the binding request in each case, followed by real
MediaMTX publishing and Chrome playback. All ten cases passed. This
corrected an interoperability gap in the initial quoted-only Link parser.

## Measurement corrections retained in the evidence

The first SRT recording was received through RTSP; FFmpeg corrected a
first-packet DTS and produced two equal initial timestamps. Native SRT
reception is measured separately. Raw fixture A/V offset is not identical
to added publisher skew: direct Windows process audio arrives ahead of
the fixture's simulated audible-time drawing. The simultaneous OBS
comparison is therefore required before attributing that offset to the
publisher.

The first OBS WHIP page was silent because MediaMTX's viewer defaults to
muted playback. The receiver URL now explicitly enables audio. The first
OBS comparison used 30 fps and nearest repeated pulses, which cannot
measure transport delay over one second without ambiguity. The follow-up
uses 60 fps and barcode IDs to match the same source pulse across both
halves. Earlier measurements remain in `O/paired-obs`.

## Native receiver and GUI results

`O/native-inputs` contains six 65-second delivered recordings: RTMP stereo,
SRT stereo, RTMP mono, SRT mono, WHIP mono, and encrypted SRT stereo. RTMP
and SRT were received using their native protocols; WHIP also played in
Chrome. The encrypted SRT passphrase deliberately contained a space and
punctuation. All six published without reconnects, stopped normally in
238–338 ms, and decoded to 59.80–59.95 distinct source frames per second.
Video timestamp gaps had a 17 ms 95th percentile and 19–25 ms maxima.
Both native protocols retained strictly increasing video timestamps.
Separate-channel and mono downmix checks passed. There were zero detected
unexpected low-energy blocks, clipped samples, or high-frequency click
indicators. Raw uncalibrated sync offsets remain recorded separately.

After the first ten resource samples, publisher private-memory medians
were 186.5–186.9 MiB for RTMP/SRT and 192.7 MiB for WHIP. First-versus-last
ten-sample medians were stable. Median publisher CPU was 1.96–2.42% of
this 20-logical-processor machine. Owned FFmpeg muxers peaked
at 22.6–26.0 MiB RSS; WHIP needed no FFmpeg child. No observed publisher
sound API calls occurred.

`O/gui-cycles-candidate` completed 24 real GUI publish/stop cycles across
two application launches. Each received video was independently decoded
and checked for changing frames, and no-audio outputs contained no audio
track. Every stop left zero child processes, zero app-owned event handles,
and the same two shared app mutexes. With handle/accessibility observation
attached, private memory ranged 191.4–233.2 MiB in the first launch and
182.9–214.2 MiB in the second. Total Windows handle counts varied
772–825 and 760–814 respectively; these totals include framework/driver
caches and are not a claim that every system handle is reclaimed per stop.
The existing default-output long cycle results provide the comparison in
the preceding quality report.

The GUI run verified encrypted profile persistence across restart, masked
credentials, disabled destination changes while live, preservation of
VDO.Ninja's VP9/alpha/PCM choices, collapsed advanced defaults, a visible
destination summary while collapsed, and absence of requested system
sounds. Screenshots at 800×600 and 1280×900 show readable fields and
credential buttons; shorter windows use the existing vertical scroll.
The original user settings were restored after the run.

## Final package verification

`O/srt-escaping-fixed` verifies the final executable against an SRT server
requiring the exact passphrase `qa:+%2B?&= pass2026`. Both the dedicated
passphrase field and an encoded complete URL published successfully.
Independent recordings passed continuity and channel checks, delivered
59.78 and 59.71 distinct frames per second, and had no detected clipping
or high-frequency click indicators. Normal shutdown took 328 and 272 ms.

`O/gui-final` repeated six actual publish/stop cycles on the final package,
across two application launches. All passed, including independent video
decoding, video-only audio-track absence, correct “No audio” status and
diagnostics, encrypted profile persistence, disabled live destination
controls, restored VDO.Ninja codec choices, and collapsed audio settings.
Final WHIP and SRT audio-panel screenshots were inspected for readable
controls and the correct Opus/AAC labels. User settings were restored;
each stop left no child processes or app-owned event handles.

`O/vdo-final` verifies that the final package still publishes Opus, RED
and stereo PCM to actual Chrome playback. Each 30-second steady phase
decoded approximately 60 fps with zero receiver-reported RTP packet loss,
dropped frames, freezes or concealed audio samples. Channel separation
was correct and no clipped samples were detected. The callback observer
sampled only about 48 video frames per second despite 60 decoded frames;
one Opus 10 ms zero-energy block occurred at the recording tail, outside
the steady phase. These observations were retained and checked using
independent recordings rather than treated as delivered-media failures.

`O/vdo-independent-final` records the received Opus audio track separately
with MediaRecorder and decodes it with FFmpeg. Both the steady phase and
the phase with an unrelated 3 kHz system tone had zero unexpected
low-energy blocks or clipped samples, correct stereo separation, and no
pickup of that unrelated tone. Deliberate source silence produced zero
output peak. Its independent 10.003-second video recording contained all
598 receiver-decoded frames (100% coverage), no invalid barcodes or
repeated frames, and 59.78 recorded frames per second. All five workflow
acceptance checks passed and the publisher exited normally. These are
digital media checks; the Web Audio timing observer bypasses the HTML
player's audio/video synchronization and is not a lip-sync measurement.

After these runs, no owned publisher, FFmpeg, OBS or MediaMTX processes
remained. The final native source snapshot still matched the packaged
artifact.

## Synchronized playback and delay

The 60-fps paired recordings match the same pulse by its embedded source
barcode. The acceptance check compares actual visible flash and audible
pulse onsets against simultaneous direct OBS source capture. An additional
source-clock extrapolation is retained as a diagnostic, not substituted
for the visible onset. Audio onset uses 10 ms windows, so these are finite
software measurements, not physical display/speaker latency.

| Route | Matched pulses | Added onset skew, median (range) | Added audio/video delay, median |
| --- | ---: | --- | --- |
| RTMP → MediaMTX → OBS native media source | 39 | −40 ms (−40 to −23 ms) | 710 / 750 ms |
| SRT → MediaMTX → OBS native media source | 39 | −40 ms (−40 to −23 ms) | 1710 / 1750 ms |
| WHIP → MediaMTX → OBS native media source | 39 | +7 ms (+7 to +23 ms) | 690 / 683 ms |
| WHIP → MediaMTX WHEP → OBS browser source | 37 | +47 ms (+13 to +70 ms) | 80 / 50 ms |

Negative skew means the received audio leads relative to the simultaneous
reference. RTMP/SRT evidence is in `O/paired-obs-60`; `d4a4` native
WHIP evidence is in `O/whip-native-final`. The three native paths met the
50 ms added-onset target. The WHIP browser route did **not** meet that
maximum on every pulse. Its largest audio-delay excursion was 120 ms
versus the usual 80 ms. This route remains a receiver-buffering/sync
limitation; no arbitrary publisher audio offset was introduced to make
one receiver pass. SRT's diagnostic source-clock extrapolation also had
one −56 ms sample, illustrating the video-frame measurement uncertainty.

The native WHIP run included a simultaneous actual Chrome receiver:
9,338 audio packets and 5,597 decoded video frames, zero packet loss,
zero concealed audio samples, zero dropped frames, and zero freezes.
Different receiver buffering explains why the native OBS media-source
route has much more delay than browser playback; SRT's configured recovery
latency is not a promise of total playback delay.

The original raw 80 ms fixture-offset rule rejected even direct source
capture (which reached −105 ms). It is retained as an informational field
in the native recording analysis, rather than being used to label
publisher synchronization. Decoded continuity/cadence/channel checks and
paired synchronization checks have separate scopes. Earlier failing
results and the source-clock diagnostic results remain in the evidence.

## Recovery and configured bitrate

`O/reconnect-final` on candidate `d4a4` deliberately killed and restarted
MediaMTX separately for RTMP, SRT and WHIP. All three recovered and
produced an additional 30-second decoded recording; the six before/after
recordings passed cadence, audio-continuity and channel checks. RTMP
needed two connection attempts, SRT and WHIP one reconnect. Normal
publisher shutdown took 320–334 ms. WHIP republished about 27 seconds
after the server restarted, because abrupt UDP loss must first trigger
ICE failure detection; this is documented and is not instant recovery.

`O/bitrates-final` delivered RTMP mono at a 64 kbps AAC target, SRT stereo
at a 320 kbps AAC target, and WHIP mono at 64 kbps Opus. All three
30-second decoded recordings passed cadence, continuity and channel
checks. Measured compressed audio rates were 66.9, 139.0 and 64.0 kbps
respectively. AAC is a target: simple tones and deliberate silence can
use much less than the requested rate, so the UI explicitly says
“target” rather than claiming measured network audio bitrate.

## Scope limits

Finite local workflows cannot establish universal flawlessness. Public
service-specific authentication, positive public HTTPS/RTMPS publishing,
TURN-only/NAT-restricted networks, lossy WAN SRT tuning, every hardware
encoder, multi-hour operation, and physical speaker/display latency need
separate coverage. Numerical discontinuity checks do not substitute for
human listening. Multichannel audio beyond stereo remains unsupported;
PCM and RED remain VDO.Ninja-only experimental choices. The separate
native Ninja OBS receiver's arrival-clock limitation is documented in the
0.2.61 report and was not changed in another repository.
