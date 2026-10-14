# AMD streaming validation — 2026-10-14

This review runs the complete Windows application package, captures moving
images and stereo audio, and verifies independent receivers. Build and syntax
checks are gates, not application testing. Evidence is under the ignored
`native-qt/qa/reports/amd-streaming-20261014/` directory; local control credentials,
recordings, and public-stream session details are not committed.

**Outcome:** the AMD H.264 reconnect failure is fixed, and final-package playback
works across the exercised transports/codecs. Full quality sign-off is **not**
achieved: audio continuity and strict maximum sync checks still have failures.
The later follow-up reproduced 60-fps window capture and verified WebRTC playback
on the supplied Meshcast stream, but its RTMP/HLS pulls failed. Repeated Windows
kernel crashes now block further capture qualification. See the follow-up below;
the successful runs do not supersede the remaining failures.

The later [completion on the Intel/NVIDIA host](#completion-on-the-intelnvidia-host) hardens and exercises the audio fallback and ports the encoder corrections to Desktop Studio. It does not establish the cause of the AMD host's kernel crashes or certify its remaining audio/sync failures.

## Follow-up and host crash interruption

Evidence for this follow-up is under the ignored
`native-qt/qa/reports/amd-followup-20261014/` directory. Publishing credentials,
raw event records and recordings remain local. The observations below distinguish
completed application workflows from changes that have only passed build gates.

### Actual Meshcast stream

Using the supplied WHIP publishing credentials, the complete final package above
published AMD H.264 and selected-window audio to the requested Meshcast stream.
Its supplied embed watch page played real video and audio in Chrome for the
90-second observation. Steady-window receiver counter deltas were:

| Measurement | Result |
| --- | --- |
| Decoded video frames | 5,497 |
| Receiver video drops / lost video packets | 17 / 0 |
| Receiver freezes | 2, totaling 0.405 seconds |
| Lost audio packets | 8 |
| Concealed audio samples | 71,200 / 4,421,760 (1.61%) |
| Publisher shutdown | Normal, exit 0, 938 ms |

The simultaneous RTMP pull failed with an I/O error and HLS returned HTTP 503.
The overall run therefore failed, despite working WebRTC playback. The pulls
started immediately; startup delay or service-side output availability remains
an unproven explanation. Delayed retries were subsequently added to the public
runner, but have not yet been exercised end to end. Actual RTMP publishing with
the supplied publishing key remains unverified. Evidence: `meshcast-exact/`.

### Window cadence and capture audio

The later 90-second AMD RTMP run with moving window content decoded 5,342 frames
over 89.017 seconds: 60.00 distinct source frames/second, strictly increasing
video timestamps and no duplicate video timestamps. It still contained three
unexpected low-energy 10-ms audio windows at recording offsets 22.445, 48.525
and 74.595 seconds, so audio quality failed. This used a complete local Release
package with opt-in capture tracing, executable SHA-256
`fd54d8bab9c190e431e2484db6fb7c5ea22197de7f03ef983230a62f7813a0c2`.
Evidence: `audio-motion/` and `audio-motion-analysis.log`.

A separate owned-process timer probe measured approximately 60 fps before,
during and after a temporary 1-ms timer request. The original timer/power policy
was restored. That experiment did not demonstrate a timer-related improvement;
the earlier 43–45 fps limitation was not reproduced in these later runs. The
host/session difference responsible is unknown. No timer policy change was
added to the application. Evidence: `timer-probe-data.json`.

The opt-in WASAPI trace recorded 9,430 buffers, each 488 frames at 48 kHz, all
with flags zero. Isolated all-zero input buffers occurred roughly every 26
seconds before encoding, apart from the fixture's deliberate silence. The
physical render endpoint used 44.1 kHz. Rounded conversion between the render
period and capture rate is a hypothesis, not an established cause.

Commit `1c579f6` includes a fallback that queries the default render endpoint's
sample rate when the virtual process-loopback client cannot provide its mix
format. The existing stateful converter then normalizes capture to 48 kHz.
The fallback change passed a Release build gate before interruption, but has
**not** been tested through an application workflow. Neither the trace-only
recording nor the earlier final package validates this change. Validation must
cover both 44.1-kHz and 48-kHz endpoints, unavailable/default-device changes, and
audio continuity and sync over multiple 26-second intervals.

### Windows crashes: qualification remains incomplete

After two user reports that the computer froze, read-only event inspection found
the following System event 1001 bugcheck reports on October 14. Times are report
times in local EDT, not necessarily the instant of the failure:

| Report time | Bugcheck |
| --- | --- |
| 00:57:54 | `0x0000000a` |
| 11:16:12 | `0x00000133` |
| 12:03:14 | `0x00000139` |
| 14:51:46 | `0x0000013a` |
| 14:54:12 | `0x0000000a` |
| 15:07:23 | `0x0000003b` |
| 15:18:57 | `0x0000003b` |

The last report records exception `0xc0000005` and dump
`C:\Windows\Minidump\101426-10421-01.dmp`. Microsoft documents
[`0x3B` as SYSTEM_SERVICE_EXCEPTION](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/bug-check-0x3b--system-service-exception)
and recommends dump analysis to identify the faulting code. The event records
alone do not establish an AMD-driver, application, memory or storage root cause.
Windows denied this session access to both the minidump directory and the
individual WER report directories; no access controls were changed.

At the 15:54 inspection, Game Capture, FFmpeg, OBS, MediaMTX and Node were not
running. This does not establish what was running at the time of each crash.
The AMD driver remained 32.0.21030.2001. Earlier events also contained disk
controller errors for disk indices 1 and 2; the current disk query exposed only
disk 0. Those events do not establish the cause of either the crashes or the
repository damage described next. No WHEA or display-driver errors were found
in the reviewed one-day warning/error event subset.

The local Git remote-tracking file for `origin/main` contained 41 zero bytes.
It was backed up under `crash-review/`, removed, and reconstructed by fetching
the verified remote branch. Git connectivity checks then passed with one
dangling commit and no missing-object errors. No working-tree files or local
commits were discarded. The relationship between this damage and the crashes
is unknown.

No capture workload, driver update, reboot or stress run was started during this
crash-review continuation. The next requirement is a readable local copy of the
crash dumps for diagnosis, followed by stable-host packaged verification of the
audio-rate fallback, public RTMP/HLS outputs, and remaining sync/loss checks.
**Testing is incomplete; this report does not certify freeze-free, loss-free
or synchronized operation.**

## Machine and package

Ryzen 7 7840HS (8 cores, 16 logical processors), Radeon 780M, AMD driver
32.0.21030.2001, Windows 11 build 26200, approximately 12.8 GiB usable RAM.
The desktop is 1920×1200 at 60 Hz. Remote desktop software was active throughout;
these measurements do not represent an otherwise idle dedicated gaming PC.

The starting installed AMD package executable SHA-256 was
`26a5149f2fff32bf56be1a2cddee88166d5d453b867c9c239ac0435fdff35564`.
The first corrected local Release candidate is
`29b1fdea39fe187d6f350a3581aa534b23d342c5b59fed00a7ad676942df1ffc`.
It includes the complete installed runtime and bundled LGPL FFmpeg, with the
rebuilt executable. It is a local candidate, not a newly published GitHub release.
The final candidate, including the IDR and RED defaults below, is
`88488d2e87b92d64217db38278cbe33ff2219a6494ca35ddc956092d4ccf5987`.

## Reproduced AMD output failure and correction

The original AMD H.264 package repeatedly disconnected RTMP, RTSP/TCP,
RTSP/UDP and SRT receivers. RTMP/SRT reported missing video dimensions; RTSP
could record audio without video before EOF. Software H.264 RTMP succeeded.
Direct AMD WHIP playback also succeeded, which narrowed the failure to the
external muxer's handling of the encoded stream.

Failure diagnostics identified `Video configuration changed; reconnecting
output.` Actual received H.264 contained alternating SPS values: AMF's initial
extradata lacked metadata present in its live SPS. `dump_extra` inserted the
initial headers before the access-unit delimiter. The pipe parser consequently
associated these headers with the preceding frame, and the muxer restarted.

AMD already emits live SPS/PPS through `header_spacing=1`. Its H.264 path now
uses `h264_metadata=aud=insert` without the redundant `dump_extra` filter.
The configuration-change guard remains active. Non-AMD encoder settings are
unchanged by this fix.

The corrected package completed six 65-second receiver-recording workflows:
RTMP, WHIP, RTSP, the RTSP/TCP URL alias, RTSP/UDP, and SRT. All had zero
publisher reconnects and normal exits in 294–398 ms. WHIP's simultaneous Chrome
receiver reported zero lost packets, dropped video frames, freezes and concealed
audio samples. These are transport results; recording quality and capture
cadence must also be assessed before claiming smooth, synchronized playback.

The final candidate repeated RTMP, RTSP/UDP and SRT at 720p30 for 65 seconds
each: zero reconnects, normal 376–399 ms exits, 29.56–29.97 fresh source fps,
monotonic video timestamps and error-free strict decoding. RTMP's 65 decoded
keyframes were 1.000 seconds apart at the median, with a 1.008-second maximum.
All three recording-quality verdicts still failed audio continuity: RTMP and
RTSP/UDP each had two unexpected quiet windows; SRT had one quiet window and
two high-frequency discontinuity indicators. Stereo separation passed and no
clipping was detected.

At the default 200 ms SRT latency, a separate 65-second 720p30 run injected 2%
random data-packet loss, 20±10 ms delay and 80 ms bursts every ten seconds.
The proxy dropped 1,363 packets, including 372 during bursts. Publication did
not reconnect, strict decoding succeeded, timestamps were monotonic and fresh
source cadence was 29.80 fps. The audio analysis still found two unexpected
quiet windows, so this is a transport-recovery pass, not a clean-audio pass.

## Capture cadence investigation

At requested 720p60, this machine delivered approximately 43–45 Windows Graphics
Capture callbacks per second with both hardware and software encoders. The
publisher filled the requested output cadence with repeats. Browser decoded FPS
therefore does not establish 60 distinct source frames per second.

A timestamp trace of AMD's run, excluding startup, contained 932 capture
arrivals and 932 accepted captures: the application's readback limiter was not
discarding those frames. Readback took 2.64 ms median, 3.48 ms p95 and 4.30 ms
maximum. Arrival gaps were 18.01 ms median and 36.48 ms p95. Requested 1080p30
and 720p30 supplied approximately 30 callbacks per second.

The existing 1 ms Windows capture interval is retained. The Windows capture
sample maintainer describes compositor-driven delivery and the nonzero interval
workaround in [Win32CaptureSample issue 92](https://github.com/robmikh/Win32CaptureSample/issues/92).
This does not establish the cause of this host's remaining delivery limit.
No claim of lossless 60-fps window capture is made for this environment.

A second, independent source used the packaged Spout sender at 1280×720/60.
Over 40 seconds, the final AMD package captured 59.99 fps and its independent
WHIP browser receiver decoded 60.01 fps with zero dropped frames. This video-only
run demonstrates the encoder's capacity; it does not certify game hooking,
all window types, or audio synchronization.

## Resource and bandwidth measurements

Five serialized 25-second UDP receiver recordings used moving window content,
selected-process stereo audio and 4,000 kbps video. Resource sampling includes
the publisher's child encoder/muxer processes; startup and teardown are excluded
from the CPU means. These measurements used the first corrected candidate.

| Encoder / capture setting | Machine CPU mean / p95 | Tree RAM | UDP+IPv4 mean / peak | Fresh source fps |
| --- | --- | --- | --- | --- |
| AMD 720p60 | 4.36 / 5.08% | 174 MiB | 4.50 / 5.06 Mbps | 42.77 |
| Auto 720p60, hardware MFT | 8.00 / 10.09% | 160 MiB | 4.47 / 4.58 Mbps | 43.97 |
| Software 720p60, MFT | 7.28 / 8.97% | 148 MiB | 4.51 / 4.70 Mbps | 45.54 |
| AMD 1080p30 | 4.65 / 5.31% | 202 MiB | 4.42 / 4.84 Mbps | 29.71 |
| AMD 720p30 | 2.35 / 3.09% | 176 MiB | 4.47 / 4.75 Mbps | 29.76 |

All five recordings decoded without errors. Both 30-fps recordings passed the
fresh-frame/audio/channel criteria. The 60-fps recordings failed the fresh-frame
criterion. AMD lifetime diagnostics included 6–7 dropped frames and 2–3 encoder
timeouts across startup and capture; native MFT reported none. These counters
are not hidden by the receiver's repeated output frames. Total system CPU was
approximately 19–24%, so CPU saturation did not explain the cadence limit.
A separate five-sample check during final AMD 720p30 RTSP/UDP playback measured
7.11% mean / 7.27% peak on the owned encoder's GPU video-codec engine and
2.86% mean on the publisher's 3D engine. This short sample is not a GPU stress
qualification. The host's Wi-Fi negotiated 1.2 Gbps; that is a local link rate,
not measured Internet upload capacity.

The existing 720p60/4 Mbps/Auto defaults are retained. This host supports them
without excessive CPU/RAM use, but a 4 Mbps video setting is not a total upload
cap. Audio, packet headers, retransmissions and additional peer viewers add
traffic. RED adds about 0.2 Mbps at the default audio bitrate. Upload capacity
must exceed observed peaks with headroom; these measurements do not establish
capacity on an arbitrary user's connection. 720p30 is a measured lower-load
option on this machine. AMD's measured input-to-output delay includes buffering
in its FFmpeg pipeline; `async_depth=1` does not imply one-frame total latency.

## Loss protection and codec playback

AMD H.264 now forces true IDRs at the configured GOP interval, at most one second
in low-latency mode, replacing the fixed 2.5-second forced-IDR schedule. This
bounds the normal wait for an independently decodable frame when retransmission
cannot repair damage. H.264 and VP9 retain NACK retransmission support.

Fresh VDO.Ninja Opus settings now enable RED. Existing saved choices are preserved;
`--no-audio-red` opts out. External outputs retain their protocol-specific audio
behavior. This change follows actual decoded-audio measurements, not merely SDP
advertising `useinbandfec`.

Controlled receiver impairment compared plain Opus with negotiated RED, using
35 seconds clean, 25 seconds at 2% loss, 20 seconds at 5% loss plus 100 ms delay,
a four-second outage and 25 seconds recovery:

| Audio mode | Concealed samples at 2% loss | At 5% loss + delay |
| --- | --- | --- |
| Plain Opus, first candidate | 2.18% | 5.18% |
| RED, first candidate | 0.316% | 1.146% |
| RED default, final candidate | 0.239% | 1.06% |

These are separate randomized runs, not identical packet-loss traces. The final
candidate's clean phase decoded 2,110 video frames with zero receiver drops or
freezes. At 2% loss it had one dropped frame and a 1.023-second freeze; at 5% plus
delay it had 15 freezes totaling 3.207 seconds. Playback resumed after the outage.
The recovery counter's 4.651-second freeze includes the preceding outage. Even
clean local VDO.Ninja playback had some concealed audio samples, so zero audio
loss is not claimed. RED helps isolated loss; it cannot make outages invisible.

The final package also completed 65 seconds of VP9 VDO.Ninja playback: 3,904
decoded frames, zero browser video drops, lost video packets or freezes, normal
335 ms shutdown. Publisher-tree CPU averaged approximately 9.81% of the machine.
Audio RED payload was approximately 393 kbps, video approximately 4.05 Mbps.
This is a VP9 software path, not AMD VP9 hardware encoding.
VP9's decoded barcode estimated 135 ms median / 164 ms p95 visual delay on this
machine. That is a software clock estimate, not a physical end-to-end latency
measurement, and the window source still had repeated frames.

Additional 25-second 720p30 compatibility runs confirmed `hevc_amf` and
`av1_amf` hardware encoding and actual Chrome VDO.Ninja playback. Each decoded
753 frames with zero video drops, packet loss or freezes. Audio concealment
was nonzero (2,393 / 3,900 samples respectively). These short runs do not
qualify HEVC/AV1 loss recovery, long-run synchronization or every receiver.

## Public Meshcast playback

The final package successfully published WHIP to Meshcast's public `usw2`
endpoint and played it through VDO.Ninja's WHEP receiver for 75 seconds. Steady
receiver statistics showed 4,575 decoded video frames, zero video drops, lost
packets or freezes, zero publisher reconnects and normal 577 ms shutdown.
Audio reported 22,722 concealed samples (approximately 473 ms in total), so
this run is not a zero-concealment audio pass. The synthetic stream was cleaned
up afterward.

The supplied `ovh-use1` watch/pull URLs did **not** produce successful playback.
RTMP accepted a connection, but independent RTMP pull failed and HLS returned
404. The embed page attempted a differently ordered WHEP route from the supplied
WHEP URL; trying the supplied URL directly also failed. These observations do
not identify the service-side cause. The actual publishing URL/key is still
needed to validate that specific stream; playback URLs alone are insufficient
to establish its ingest configuration.

## Recording quality limits

The first candidate's six 65-second recordings showed correct stereo separation,
no clipping and no high-frequency discontinuity windows above the analyzer's
threshold. They also showed 2–3 unexpected low-energy 10 ms windows per run.
Those continuity checks failed and must not be represented as clean audio.
RTSP/UDP also requires examination of its duplicate startup recording timestamps.
Raw pulse offsets from independent recordings are not calibrated lip-sync
measurements. Physical display/speaker latency and human listening are outside
the automated measurements.

The final package also ran a five-minute WHIP publication with simultaneous
Chrome playback and an OBS 32.2.2 paired recording. OBS recorded the original
window/process audio and MediaMTX's native RTSP receiver on separate tracks.
Analysis uses the same recording clock, 60-fps video and 10-ms audio windows:

| Analysis window | Matched pulses | Added audio-minus-video skew | Added audio / video delay |
| --- | --- | --- | --- |
| 20–85 seconds | 26 | −70 ms median, −160 to −33 ms | 1,230 / 1,291 ms median |
| 240–305 seconds | 25 | −67 ms median, −137 to −17 ms | 1,250 / 1,317 ms median |

Both windows **failed** the 50-ms maximum added-skew criterion. The median
changed little, but that does not establish synchronization or the absence of
all drift. This measures the entire publisher/server/native-OBS path, not just
the encoder. OBS had zero encoding skips and nine rendering skips during the
recording. Its reference capture also showed variable onset timing. No global
publisher offset was added to compensate for one receiver's buffering.

A separate 75-second WHIP→WHEP OBS browser-source run had 37 matching pulses:
−17 ms median added skew, −107 to +30 ms range, and 80 / 117 ms median added
audio / video delay. It also failed the strict 50-ms maximum. The much smaller
browser delay compared with native RTSP demonstrates why a single publisher
offset would be inappropriate for these different receivers.

Further audio inspection decoded the RTMP recording without timestamp-driven
resampling. Its short quiet windows remained at 23.24 and 49.31 seconds, so
they were not silence inserted by the analyzer's resampler. The five-minute
OBS reference track independently contained similar approximately 10-ms quiet
windows at roughly 26-second intervals. The received track had a similar
cadence with a different phase. This points beyond an encoder-only explanation;
the exact source/capture cause is unresolved. The RTMP recording also contained
duplicate audio timestamps near 62.165 seconds; audio timing is not certified.

## Desktop workflow and final gates

The final package passed two actual GUI Go Live→independent browser playback→
Stop cycles using AMD H.264 at 960×540/30. Each receiver advanced 90 frames in
three measured seconds. The fresh audio RED checkbox and its saved value were
both verified enabled. The user's original registry preferences were restored.
Initial automation attempts failed source selection, discovery-file timing and
an incorrect assumption that untouched defaults were already persisted; those
were corrected before the successful workflow.

The Release build, JavaScript/Python syntax gates and `git diff --check` passed.
Those are gates, separate from the application/receiver workflows above. No
new GitHub release, installer upgrade, real-game hook, HDR workflow or physical
display/speaker latency qualification is claimed.

## Reproduction

The external-output runner supports a matrix of objects containing `id`,
`video-encoder`, `resolution` and `fps`. Protocol IDs select real local MediaMTX
receivers; `--wire-meter=1` measures owned UDP traffic, and `--trace=1` records
capture/encoder timing. Profiling includes publisher child processes and is
serialized with recording analysis. CPU occupancy divides process-tree CPU time
by the machine's 16 logical processors.

The public-output runner accepts explicitly authorized `--publish-url`,
`--protocol`, `--whep`/`--viewer`, and optional `--rtmp-pull`/`--hls-pull` URLs.
The media-quality runner accepts `--packet-loss` and `--severe-loss` and requires
receiver evidence that impairment actually occurred. Native external OBS
receivers can run in an isolated portable OBS without the VDO.Ninja plugin.

Examples, with `PACKAGE` pointing at a complete Windows package and separate
output directories for every run:

```powershell
node native-qt/e2e/external-output-packaged.js --publisher=PACKAGE/game-capture.exe --output=REPORT/protocols --cases=rtmp-amf,whip-amf,rtsp-amf,rtspt-amf,rtsp-udp-amf,srt-amf --video-encoder=amf --seconds=65
node native-qt/e2e/media-quality-packaged.js --publisher=PACKAGE/game-capture.exe --output=REPORT/loss --cases=review-opus,review-red --video-encoder=amf --fps=60 --seconds=35 --loss=true --packet-loss=2 --severe-loss=5
node native-qt/e2e/media-quality-packaged.js --publisher=PACKAGE/game-capture.exe --output=REPORT/default-loss --cases=review-opus --video-encoder=amf --fps=60 --seconds=35 --loss=true --packet-loss=2 --severe-loss=5 --default-protection=true
```

Run decoding/quality analysis after capture, separately from resource profiling.
The runners' successful playback exit status does not replace the quality
analyzers or certify the absence of the limitations listed above.

## Completion on the Intel/NVIDIA host

The remote changes through `36d2c98` were integrated with the local pacing/audio-meter fixes without discarding either set of work. This host has Intel Graphics and a TITAN RTX; it cannot execute AMD hardware encoding. The application changes here are:

- **Bounded audio-rate fallback:** when the virtual process-loopback client cannot report its format, query the default render endpoint's rate. Missing/invalid information falls back to 48 kHz. If a different rate fails with `AUDCLNT_E_UNSUPPORTED_FORMAT` or `E_INVALIDARG`, activate a fresh process-loopback client and try 48 kHz once. Device invalidation and other errors are not treated as format rejection. Failure logs include rate and HRESULT. This follows Microsoft's [IAudioClient initialization contract](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-initialize); a rejected initialization can require a new client. No Windows endpoint setting or global timer policy changes.
- **Studio parity:** port Game Capture's AMD H.264 live-header fix and periodic true-IDR policy, plus the AMD HEVC metadata-filter workaround, to Desktop Studio. Preserve Studio's encoder isolation and optimized pixel conversion. Port the audio fallback and opt-in capture trace while retaining Studio's COM lifetime and device-failure supervision.
- **Useful failure evidence:** the optional `VERSUS_AUDIO_CAPTURE_TRACE` writes bounded timing/rate/energy CSVs, not PCM recordings. It stays disabled unless requested. The public-service QA runner now keeps separate recordings/logs for each delayed RTMP/HLS attempt, handles child launch errors, cancels pending attempts when the viewer fails, clears timeout timers, and stops its in-memory browser recording before waiting for potentially slow pull retries.

The rate preference is a compatibility measure, not a demonstrated explanation for the AMD machine's approximately 26-second dropouts. No arbitrary publisher-wide A/V offset or fake replacement audio was added to hide those failures.

### Packaged audio negotiation results

Both complete packages passed eight scenarios each: 44.1 kHz and 48 kHz capture, rejection of the 44.1 kHz hint followed by a successful 48 kHz retry, unavailable default-render metadata, zero and out-of-range rate hints, rejection of both format attempts, and device invalidation at initialization. The last two deliberately left audio unavailable; video kept publishing with silence and no publisher reconnect. A format rejection caused exactly two initialization attempts; device invalidation caused one. No unrelated device or microphone was selected.

Each normal-rate run lasted 90 seconds, spanning more than three of the previously reported 26-second intervals. All four complete receiver recordings strictly decoded with continuous stereo tones and zero unexpected low-energy 10 ms windows:

| App / negotiated capture rate | Minimum 10 ms audio RMS |
| --- | ---: |
| Game Capture / 44.1 kHz | 0.02470 |
| Game Capture / 48 kHz | 0.02706 |
| Desktop Studio / 44.1 kHz | 0.02242 |
| Desktop Studio / 48 kHz | 0.02706 |

The trace contained 441-frame or 480-frame input buffers respectively, with zero-energy input only during the first approximately 30 ms of startup. Windows performed actual process capture and the app performed actual conversion, encoding and publishing. Frida changed only the owned app's endpoint-format hint or selected initialization return codes; the physical render endpoint stayed at 48 kHz. Therefore these results validate negotiation and conversion on this host, **not** the physical 44.1 kHz AMD endpoint or its kernel driver.

Evidence: each checkout's `native-qt/e2e/reports/amd-completion-2026-10-14/audio-*/`; Game's first successful 44.1 kHz report is `audio-44100-v2/`. The initial `audio-44100/` attempt stopped on a runner startup-diagnostics assumption, which was corrected before the complete run. `audio-suite.json` lists the other fifteen serialized runs. `process-audio-format-packaged.py` and `process-audio-format-fault.js` in Game's `native-qt/e2e/` drive either executable. For example:

```powershell
python native-qt/e2e/process-audio-format-packaged.py --publisher PACKAGE/game-capture.exe --report REPORT --rate 44100 --seconds 90
python native-qt/e2e/process-audio-format-packaged.py --publisher PACKAGE/game-capture.exe --report REPORT --rate 44100 --fault reject-rate --seconds 12
```

### Private compatibility receivers

The delayed-output runner now requires both an audio and a video track to decode completely after publishing/profiling ends. This caught a weakness in the earlier check: MediaMTX could return H.264-only RTMP from a WHIP H.264/Opus stream, and a nonempty video-only file satisfied the old assertion. The private fixture now models a compatibility rendition by copying video and converting Opus to AAC in a separate FFmpeg service process; this is fixture behavior, not a new transcoder bundled into the app.

With that rendition, both RTMP and HLS failed their first deliberately rejected attempt, succeeded on the second, and produced strictly decodable audio/video recordings. Simultaneous WebRTC playback also received both tracks. Publisher shutdown was normal in 273 ms. A separate refused-viewer run cancelled both delayed pulls before either started, completed in about seven seconds and shut the publisher down normally in 308 ms. Evidence: `private-retries-av/` and `private-cancellation-final/`. The older `private-retries/` result is retained as the insufficient video-only check; it is not an audio/video pass. Reproduce using `public-output-local-e2e.py --publisher EXE --report REPORT`, adding `--viewer-failure` for cancellation. This is a private localhost fixture, **not** verification of Meshcast's supplied public URLs.

### Encoder selection, timing and final scope

Explicit AMD H.264 and HEVC selections were exercised in both packages on the non-AMD host. Each failed normally with exit 3 in about 1.5-1.6 seconds, explained that the requested AMD encoder could not start, and left no encoder child running. The owned FFmpeg command lines verified H.264's live-header/IDR options and HEVC's absence of the incompatible metadata filter. This is startup/failure-path and argument validation, **not hardware encoding**. Evidence: Game `amd-unavailable-final/`, Studio `amd-unavailable/`, and both `amd-hevc-unavailable/`; reproduce with `amd-unavailable-packaged.py --publisher EXE --report REPORT [--codec h265]` on a host without AMF.

All sixteen audio-scenario recordings also had strictly increasing decoded audio/video timestamps. Maximum audio frame spacing was 21.334 ms and maximum video spacing was 38 ms. Analysis uses separate audio/video decoder invocations: an initial combined `showinfo`/`ashowinfo` pass interleaved log lines and falsely appeared to omit frames. Its summary is retained as `audio-quality-summary-interleaved-log.json`; the corrected `audio-quality-summary.json` is the result used here. This measures file cadence, not calibrated end-to-end A/V synchronization.

Studio's complete package additionally passed visible 1080p60 NVENC streaming plus independent recording, and simultaneous software publishing/recording through large sources, 45 seconds limited to two logical CPUs and source-worker failures. Those results are detailed in Studio's encoding-defaults validation document.

Complete local packages:

- Game Capture: `native-qt/dist/game-capture-amd-completion-review/`; executable SHA-256 `866c5203f1cb1d1a0fda8ffa0ea78fb787c288e6a8608b2e08ba6d98819f8617`.
- Desktop Studio: `native-qt/dist/desktop-studio-amd-completion-review/`; executable SHA-256 `0b5cfe34634213f47526244290c711bae302b3fb28d40343a6b702ecc0ea81b8`.

Release compilation, JavaScript/Python parsing and whitespace checks passed as gates. Actual workflows used the complete packages and private receivers; builds, media runs and post-run decoding were serialized. The AMD machine's physical 44.1 kHz endpoint, live default-device changes, AMD/OBS receiver sync/loss behavior, public Meshcast URLs and kernel-crash cause still need qualification on a stable AMD host. No AMD-driver fix, clean-machine certification, installer or GitHub release is claimed by this continuation.
