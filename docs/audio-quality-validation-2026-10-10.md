# Packaged audio and video quality validation — 2026-10-10

This pass exercised actual packaged Game Capture applications, real Chrome and
Firefox receivers, and recorded OBS output. It is not a build or unit-check
report. The experimental audio review is not an unconditional compatibility or
release sign-off: generated PCM links were silent in Firefox, and native OBS
sync needs follow-up. Other retained findings include an existing capture
cadence limit, a first-close Windows tray chime, low-bitrate stereo quality
failures, and resources retained after repeated full stream restarts. Default
Opus playback did not show a new regression in the measured comparisons.

Local raw evidence is under
`native-qt/qa/reports/quality-20261010/` (called `Q` below). It includes decoded
audio, RTP statistics, muxed OBS recordings, process measurements, screenshots,
and failed attempts. Raw session logs contain temporary connection details and
are not intended for public publication.

## Artifact and environment identity

| Artifact | SHA-256 of loaded executable/module |
| --- | --- |
| Published Game Capture v0.2.60 | `96de368122a1cae932c3b2f3e174e63941dc08efd05ab0ff5f1a1e2a374da572` |
| Original `game-capture-audio-experiments-review.zip` executable | `74a3ab2663ee61a3d7975ca4d5abfafc3a28a2a7e6c1432f3fccb00113eecbc9` |
| Rebuilt `game-capture-audio-quality-review.zip` executable | `1355dd95a59be6da83eae0a198ba180213fc920ed7e1261cf7faaf626f65c6f3` |
| Published Ninja 1.1.74 module loaded in isolated OBS | `8dc00681094a9b024b1e8b929a33289e62873dfc365715703f9f7b6fd0be7834` |

The original review was extracted to `Q/review-package`. The rebuild was loaded
from `native-qt/qa/reports/audio-quality-delivered-package/game-capture.exe`.
Its ZIP SHA-256 is
`3a0a070b9620a4180584de3eee48b5f3586a6bce4b7d4b8412c26690a54ab571`.
Both review executables identify as 0.2.60; hashes distinguish them.

Windows 11 Pro 25H2, Intel Core Ultra 7 265K (20 logical processors), 64 GiB RAM,
Intel Graphics and NVIDIA TITAN RTX. Receivers: Chrome for Testing
143.0.7499.4, Playwright Firefox 146.0.1, OBS 32.2.2 / Qt 6.11.1 / Browser CEF
127.0.6533.120. OBS ran from an isolated portable copy at
`Q/obs-portable/bin/64bit/obs64.exe`; enumerated loaded modules confirm
`Q/obs-portable/obs-plugins/64bit/obs-vdoninja.dll`.
`obs-native-current/obs-recordings/obs-identity.json` preserves this evidence.
Normal OBS installations were not modified.

## Clean playback, audio artifacts, and delay

`Q/media-matrix2` compares five 70-second Chrome playback runs using the
published baseline and original review: Opus, Opus+RED, PCM stereo and PCM mono.
The source supplies distinct 440/880 Hz left/right tones, synchronized 1 kHz
pulses and visual flashes, a changing visual time barcode, and intentional
silence. The review runs all decoded approximately 30 fps with no receiver
video drops or lost packets. Decoded review waveforms had zero unexpected
low-energy 10 ms blocks and zero clipped samples. The sine-residual diagnostic
found no blocks above its quarter-tone-amplitude threshold. This is measured
signal analysis, not a subjective listening verdict.

Stereo channels remained distinct. PCM mono contained the expected downmix.
The baseline's generated viewer link produced mono; the review link's stereo
preference produced stereo. Baseline had one low-energy 10 ms block per channel;
it is not described as flawless.

Approximate clean audio payload rates were 192 kbps Opus, 392 kbps Opus+RED,
1024 kbps PCM stereo at 32 kHz, and 768 kbps PCM mono at 48 kHz. These exclude
transport overhead. Estimated median visual delay was 133 ms for review Opus
and about 150 ms for baseline, RED and PCM stereo on this machine.

The rebuilt package's boundary matrix in
`native-qt/qa/reports/audio-quality-boundaries-complete` retained two failures:
6 kbps stereo lost the required channel separation, both with and without RED.
Both modes still decoded audio and delivered the configured payload rate.
6 kbps mono, 6 kbps mono with RED, and 510 kbps stereo passed tone, bitrate,
video and authorized-override/restore checks. These low-rate passes establish
functionality, not high fidelity. The complete matrix exits unsuccessfully
because of the stereo failures; they were not relaxed into passes. The README
explicitly notes that very low bitrates degrade fidelity and stereo separation.

The browser audio observer uses an independent MediaStreamAudioSource. It
bypasses the HTML video element's A/V synchronization. Its reported audio/video
offset is **not browser lip sync**. Clock estimates are not physical
screen-to-camera or speaker-to-microphone measurements.

## Actual packet loss, delay, outage and recovery

`Q/network-loss-fixed` uses the rebuilt ZIP. Chrome P2P network impairment was
installed before connection creation, and actual inbound lost-packet counters
verified it took effect. Each codec ran clean playback, 25 seconds at 10% loss,
20 seconds at 30% loss plus 100 ms latency, a four-second total outage, and
25 seconds of recovery.

| Mode | Concealed samples at 10% loss | At 30% loss + 100 ms | Recovery video fps |
| --- | ---: | ---: | ---: |
| Opus | 8.535% | 26.044% | 29.94 |
| Opus+RED | 1.095% | 11.384% | 29.89 |
| PCM stereo | 17.636% | 38.140% | 29.82 |

All three actually stopped receiving video during the outage and resumed
decoded audio/video afterward. Recovery had no new lost packets; its first
statistics window includes the end of the outage and must not be described as
zero concealment or zero freezes. Severe impairment produces audible gaps and
video freezes; PCM was substantially less resilient than Opus+RED. RED roughly
doubles payload bandwidth at the selected bitrate.

## Firefox and OBS compatibility

`Q/firefox-vp9-fixed` has successful 35-second baseline Opus, review Opus and
review RED-selected playback. Firefox negotiated Opus fallback for RED, with
approximately 30 decoded fps and no unexpected decoded audio gaps. VP9 was
used because this automation Firefox build rejected the H.264 video section
for both baseline and review; those H.264 attempts are retained as failures,
not counted as playback passes.

The generated PCM URL (`audiocodec=pcm`) produced video but no inbound audio
or decoded audio blocks in Firefox, despite its answer advertising L16 and
the publisher selecting PCM. In `Q/firefox-pcm-fallback`, removing that URL
preference allowed genuine Opus fallback: 35 seconds of audio/video at
29.99 fps and 192 kbps with no lost packets. Generated PCM URLs therefore
cannot be advertised as universally falling back safely. The UI already
directs users to Chrome; retaining the experimental designation matters.

`Q/obs-native-current` contains five actual native Ninja 1.1.74 OBS recordings
using the published baseline and original review. All decoded video and audio
with zero OBS render/output skips. The native receiver negotiated Opus for
PCM/RED-selected publishers. This establishes fallback playback, not native
OBS PCM or RED support.

`Q/obs-browser-calibration-fixed` records the rebuilt ZIP using OBS Browser
Source, plus direct OBS Window Capture/WASAPI and the published baseline.
Recordings retain input startup and at least 30 seconds of steady playback.
All four streamed cases produced audio/video with zero OBS render/output
skips. Publisher negotiation logs confirm actual PCM and Opus+RED in Browser
Source. Direct calibration had six startup render skips and zero output skips.

Pixel samples from all eight color-bar interiors in the actual OBS output
screenshots matched the expected RGB colors within one 8-bit channel value
for Browser Source and two values for native Ninja, identically for baseline
and review. Direct capture matched exactly. This checks channel/range mistakes
in these SDR patches; it is not an HDR, motion-compression or full-image
quality metric. Evidence: `Q/obs-color-bar-analysis.json`.

The analyzer probes actual first audio/video PTS and aligns both decoded
streams to the same recording clock. Negative values below mean audio leads.
Thirty-fps video and 10 ms audio windows limit onset precision.

| Source | Median audio minus video |
| --- | ---: |
| Direct OBS source calibration | -112 ms |
| OBS Browser: published Opus | -108 ms |
| OBS Browser: rebuilt Opus | -112 ms |
| OBS Browser: rebuilt RED | -128 ms |
| OBS Browser: rebuilt PCM stereo | -122 ms |
| Native Ninja: published Opus | -248 ms |
| Native Ninja: original review Opus | -215 ms |
| Native Ninja: original review RED selection | -205 ms |
| Native Ninja: original review PCM stereo selection | -182 ms |
| Native Ninja: original review PCM mono selection | -145 ms |

Direct capture already has substantial lead, so assigning the entire measured
offset to Game Capture would be incorrect. Browser Source closely matches
that calibration; native Ninja adds lead, also on the published baseline.
These sequential runs do not prove a codec-dependent native sync improvement.
No arbitrary global audio-delay change was made. Further native receiver sync
investigation is warranted.

After waiting for OBS's asynchronous recording stop to finish, a final rebuilt
PCM Browser playback/record/exit run (`Q/obs-shutdown-final`) exited OBS normally
with code 0 in 318 ms. Its loaded module path was recorded. An earlier helper
closed OBS while its muxer was draining and could trigger the active-output
confirmation; that is not counted as a successful graceful shutdown.
The final OBS log reports `Number of memory leaks: 0`; this is OBS's own
allocation counter, not proof that every loaded library is leak-free.

## Reconnects, performance and memory

`Q/pcm-1080p60-churn-fixed` ran one rebuilt packaged process through 16 separate
25-second PCM stereo viewers, five-second gaps, then 110 seconds for peer
retirement. Every viewer decoded audio/video. Per-round decoded video was
59.91–60.03 fps, with zero receiver video drops, zero lost audio packets,
zero unexpected audio gaps and zero clipping. Process exit was normal, code 0,
273 ms. The feature implementation separately fixed PCM input timestamp
resynchronization across periods with no encoding; this pass uses that rebuild.

The separate Chrome selected-window workflow reproduced that timestamp defect
against the original review in `native-qt/qa/reports/audio-quality-pcm-clock-before`.
Across a 12,130 ms viewer reconnect interval, the PCM RTP clock advanced only
3,100 ms. In `native-qt/qa/reports/audio-quality-pcm-final`, the rebuilt package's
clock advanced 12,110 ms over 12,120 ms of elapsed time, a 10 ms difference.
This verifies RTP timeline continuity, not a physical lip-sync measurement.
The earlier probe's derived wall-clock calculation was corrected for Chrome's
epoch timestamps; its original raw timestamps and initial calculation remain
in the evidence.

That final selected-window PCM run also covered a 120-second soak, four more
viewer reconnects, explicit transport refresh, unrelated 3 kHz Windows output,
intentional source silence, 5% packet loss and recovery. Silent-source output
was exactly zero, and the unrelated tone did not appear as a sustained tone
in the selected-window stream. A separate default-output positive control in
`native-qt/qa/reports/audio-quality-system-positive` recorded the injected tone
at approximately 0.12 amplitude, confirming that the sound fixture was real.

Steady PCM, post-idle, post-soak, post-churn and post-transport-refresh waveform
windows had no clipping or discontinuity flags. The sine-predictor diagnostic
did flag two left-channel windows during the unrelated-system-tone phase,
five left/three right during packet loss, and two right-channel windows after
network recovery. Their causes were not isolated; this is not a click-free
claim. The 5% loss phase recorded 123 lost audio packets. The recovery window
had zero lost packets, zero concealed samples, zero unexpected silent windows
and 60.04 decoded video fps. Independent-track timing remains subject to the
lip-sync limitation above.

Across 272 seconds of resource observations, this 720p60 traced run used
193.7–203.7 MiB private memory; its soak generally stayed near 197 MiB and
finished the entire reconnect/loss sequence at 203.0 MiB. Median CPU was
63.3% of one logical core (3.17% of this machine). Handles fell from 867 to 837,
threads from 60 to 52, and sampled shared GPU memory fell from 75.1 to 60.7 MiB.
The bounded result supports resource stability during this sequence, not a
general absence of leaks. `analysis.json` retains all waveform/resource values.

Decoded 60 fps is not proof of 60 new source frames. The initial canvas/barcode
observer saw only about 34–36 distinct source updates per second at 1080p60.
A subsequent packaged Chrome run using encoded reference-video identity
confirmed a capture cadence finding at 1280x720/60: the receiver recording
contained 59.96 decoded frames/s but only 43.67 distinct identities/s. Capture
trace analysis found 59.76 callback arrivals/s, 15.89 rejected callbacks/s, and 43.87
accepted captures/s, with a contiguous send-to-receiver sequence and zero
receiver drops. Source and receiver recording coverage was checked, so this
cannot be dismissed solely as a canvas callback sampling limitation.

Evidence is
`native-qt/qa/reports/audio-quality-chrome-video/25c45474-2cb9-40a9-b280-51f7b93070f0/`:
`results.json`, the source/receiver WebM recordings, and `auto-h264-frames.csv`.
It used rebuilt executable SHA `1355dd95...6f3` above. The matching published
baseline recording contained 42.67 distinct identities/s versus review
43.67/s; source recordings contained 56.64 and 55.56 distinct identities/s,
respectively. This comparison does not implicate the new audio feature.
The baseline evidence is
`native-qt/qa/reports/audio-quality-chrome-video-baseline/ac55b269-03b5-4731-b2f0-603a173f453e/`.

The trace's rejection marker covers both capture admission and frame pacing,
and rejected callbacks include repeated WGC timestamps. Those callbacks
cannot all be called valid new frames. This evidence establishes the existing
cadence limitation, not its root cause. Full 60-fps content fidelity has
**not** passed.

About 610 seconds of process observations showed private-memory medians of
284.3, 284.9 and 285.1 MiB over successive warm intervals, then 285.1 MiB after
retirement. Peak was about 300 MiB. Handles fell from a warm median of 878 to
860; threads settled to 58–59. There was no per-reconnect unbounded growth
in this run. This duration does not establish absence of all memory leaks.

At 720p30, median publisher CPU was 24.0% of one logical core for baseline,
29.2% Opus, 27.7% RED and 28.1% PCM stereo. During active 1080p60 churn,
warm medians were 83–97% of one logical core (approximately 4–5% of the whole
20-processor machine). After viewers retired, CPU settled near 18.5% of one
core. Three GPU snapshots showed about 70 MiB shared GPU memory and roughly
8% engine utilization; three snapshots cannot establish GPU leak freedom.

## Desktop UI, clicks and system sounds

`Q/gui-pcm-run2` passed the real GUI configure/save/exit/restart/go-live/browser
playback/stop workflow with original review PCM. It verified collapsed audio
encoding on restart, restored mono settings, disabled fixed PCM bitrate/RED
controls, locked live encoding settings, and successful decoded playback.
Original registry settings were restored afterward.

PlaySoundA/W, MessageBeep and Beep hooks recorded zero calls. Windows default
output loopback recorded 22.6 seconds: a separate 6.6-second pre-tone segment
was exactly silent; steady-tone residual analysis found zero unexpected
blocks above -60 dBFS. Tone onset/ending was excluded. Hooks attach shortly
after process launch, so this does not cover every possible early-startup or
OS-originated sound.

The rebuilt package also completed all 23 desktop workflow checks in
`native-qt/qa/reports/audio-quality-desktop-complete/c12742bf-27c5-41c6-8476-45b93a6e25a8/`:
actual Chrome H.264 and VP9 playback, failed FFmpeg startup and recovery,
stale-probe handling, source removal, close-to-tray, and exit during a probe.
Settings were restored. The Windows loopback recording spans all workflow
phases (56.5 seconds of samples over 56.44 seconds of wall time).

**The app is not silent for every action.** First close-to-tray produced one
Windows notification chime, peaking at 0.324 amplitude (about -9.8 dBFS) and
decaying over roughly 1.4 seconds. The matching notification is the existing
"Still running in system tray" reminder, with native flags `0x24`. Startup,
failed starts, streaming, and source-removal phases were exactly silent in
this recording. App sound hooks still reported zero calls because Windows
plays the tray sound. Three WASAPI discontinuity warnings occurred around
stream transitions; the recording is retained, but it cannot establish
sample-perfect continuity across those warnings.

Qt's Windows tray implementation does not expose the native `NIIF_NOSOUND`
flag through `QSystemTrayIcon::showMessage`. Changing the icon type alone
would not suppress this sound. No native tray implementation change was
included in the audio encoding feature. See the
[Qt Windows implementation](https://raw.githubusercontent.com/qt/qtbase/6.10/src/plugins/platforms/windows/qwindowssystemtrayicon.cpp)
and Microsoft's [notification flag documentation](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyicondataw).
Default-output capture can include this OS sound; selected-window audio
isolation was verified separately above. An earlier desktop attempt stopped
its sound recorder after the probe phase; it is retained as incomplete
coverage and is not the basis for the full-workflow result.

`Q/gui-cycles-final3` completed 12 actual GUI start/playback/stop cycles in
one rebuilt packaged process, alternating Opus, PCM, RED, mono and stereo.
All 12 decoded the expected audio. Measured click-to-live transitions were
497–736 ms; click-to-stopped transitions were 149–232 ms. Exit code was 0,
original settings were restored, and sound-call hooks recorded zero calls.
The final report preserves per-cycle live diagnostics and stopped resources.

Stopped private memory rose from 137.9 MiB after the first cycle to 172.3 MiB
after the twelfth; cycles 8–12 varied between 165.0 and 174.2 MiB. Handles rose
from 891 to 950 (late cycles 936–950), while threads settled to 56. These were
measured three seconds after each stop, without a final long idle interval.
This is retained-resource evidence, not proof of a leak or of leak freedom.
A longer same-workflow baseline comparison is still warranted; it should not
be conflated with the stable viewer-only reconnect result above.

The final GUI run saved 18 screenshots at 800x600, 1024x768, 1280x900 and
maximized live states. Inspected screenshots include collapsed settings,
expanded audio controls at 800x600, active PCM audio meters, and actual OBS
native/Browser output. Compact controls are scrollable; no overlapping audio
labels were observed. The live primary-meter label correctly identifies the
default output mix. Failed GUI attempts were retained:
an OBS Browser firewall prompt overlaid the desktop and intercepted physical
input. Its actual Cancel button was clicked and its disappearance verified;
no broad firewall allowance was added.

`native-qt/qa/reports/audio-quality-ui-minimum-settings` additionally verified
PCM selection, disabled fixed-bitrate/RED controls, mono selection and persisted
settings at 760x520. Both collapsed and expanded screenshots were inspected;
labels did not overlap and the form remained scrollable. The subsequent
go-live/Chrome playback/stop portion used a maximized window and passed, with
settings restored afterward. Earlier attempts to navigate capture sources
entirely at 760x520 failed in the automation's nested-scroll handling. They
are retained; this is not a claim that every capture action was verified at
the minimum size.

## Extended validation after c3b87b2

The follow-up uses the same rebuilt package (`1355dd95...6f3`) and published
baseline above. No production code changed. Additional evidence is under
`native-qt/qa/reports/audio-quality-extended/` (called `E` here). Capture
workflows ran sequentially.

### Repeated full stream restarts against the published baseline

`E/baseline-opus-24` and `E/review-opus-24` each completed 24 real GUI
start/Chrome decoded playback/stop cycles, followed by 120 seconds stopped.
All 48 playback checks passed; both processes exited normally with code 0 and
restored application preferences. Each receiver verified video advancement,
192 kbps audio, and separate 440/880 Hz stereo tones. The baseline URL was
explicitly given `stereo=1&ab=510` to match the review's receiver preferences.

| Measurement | Published baseline | Audio review |
| --- | ---: | ---: |
| Workflow duration, including final idle | 460 s | 671 s |
| Start latency, median / maximum | 524 / 998 ms | 608 / 2,255 ms |
| Stop latency, median / maximum | 163 / 194 ms | 182 / 211 ms |
| Private memory after first stop | 133.4 MiB | 138.9 MiB |
| Private memory after stop 24 | 201.9 MiB | 218.7 MiB |
| Private memory, median of final 30 idle seconds | 183.3 MiB | 198.1 MiB |
| Peak sampled private memory | 236.8 MiB | 245.6 MiB |
| Handles after first / last stop | 1,133 / 1,218 | 1,169 / 1,256 |
| Handles at the final snapshot | 1,160 | 1,189 |
| Threads at the final snapshot | 52 | 50 |

Both builds retain memory after repeated restarts and release some during
idle. The review retained about 15 MiB more in the late idle comparison.
There is a similar allocation step around cycle 15 in both runs; neither
returned to its initial process footprint. This does not isolate a leak,
establish leak freedom, or attribute the difference to the new encoder.
Frida sound observers were attached in both runs, and the review also
exercised its audio settings between cycles. Their overhead and the different
elapsed durations prevent treating this as a controlled allocator benchmark.
The two packages' Qt Core and Widgets DLL hashes matched.

The 2.25-second review start outlier occurred after encoder setup while
waiting for signaling connection; playback then succeeded. Median sampled
live CPU was 9.2% of one logical core for baseline and 6.9% for review, but
these windows include connection startup. The simple Tk fixture changes at
10 Hz, so this is lifecycle/resource evidence, not a new 30/60-fps content
fidelity result. Sound hooks recorded zero app sound requests; no Windows
loopback recording was made in these two runs, so the prior tray-chime finding
remains. `analysis.json` and per-second `resources.jsonl` retain the values.
Additional compact and live-state screenshots were inspected, including the
800x600 audio controls and cycle 24. No new overlapping controls were observed;
the expanded form still requires vertical scrolling at compact sizes.

### Simultaneous experimental and fallback viewers

`E/simultaneous-codecs` ran four publishers with two real Chrome receivers
connected concurrently: PCM stereo plus Opus fallback, PCM mono plus Opus
fallback, RED stereo plus plain Opus, and RED mono plus plain Opus. All eight
receivers negotiated their expected payload type and passed decoded-tone,
channel-mode, payload-rate and video-advancement checks. The paired measurement
windows overlapped by 3.53 seconds, so these were simultaneous consumers,
not sequential fallback checks.

Measured preferred/fallback payload rates were 1,024.5/192.2 kbps for PCM
stereo, 768.9/192.2 for PCM mono, 392.4/192.2 for RED stereo, and 136.3/64.1
for RED mono. All eight measurement windows had zero lost audio packets,
zero concealed samples, and zero reported playout sample insertion/removal.
No director bitrate override was issued during this comparison; competing
overrides would make a shared-encoder bitrate measurement ambiguous.

### Longer recorded output and sync drift

`E/obs-long-sync` recorded 180 seconds of steady output plus startup for each
of direct OBS Window Capture/WASAPI calibration, published Opus via Browser
Source, and rebuilt PCM stereo via Browser Source. All three recordings
contain approximately 196.5 seconds of video, decoded tones and repeated
visual/audio sync pulses. All had zero OBS render/output skips. Publisher
logs confirm actual PCM negotiation. Publishers exited normally in 249-350 ms;
OBS exited normally in 497 ms, with no forced termination.

| Recording | Median audio minus video | Fitted steady offset slope |
| --- | ---: | ---: |
| Direct source calibration | -131.7 ms | +8.3 ms/min |
| Published Opus, OBS Browser | -105.0 ms | -7.9 ms/min |
| Audio review PCM, OBS Browser | -121.7 ms | +4.1 ms/min |

The PCM median was -121.7 ms in each minute bucket, including the final partial
minute. There was no observed accumulation of multiple frames of skew in this
run. The fitted slopes include discrete onset changes and outliers; with
30-fps video and 10-ms audio windows they should not be treated as precise
device-clock drift estimates. Direct calibration itself moved from roughly
-132 to -112 ms. Sequential source/receiver runs therefore do not isolate a
small publisher-induced offset or establish physical speaker/display sync.
The analyzer preserves every paired pulse and its recording timestamp in
`pulsePairs`, alongside first-PTS alignment and per-minute measurements.

### PCM playout adjustment and recovery follow-up

`E/pcm-playout-recovery` repeats the selected-window Chrome workflow with raw
before/after RTP statistics, including playout sample insertion/removal. This
is a short diagnostic run (one second in its named soak phase), not another
long-duration soak. It includes unrelated 3 kHz system audio, source silence,
an idle reconnect, a viewer reconnect, transport refresh, actual 5% loss,
and a 12-second clean recovery measurement.

All workflow assertions passed and the publisher exited with code 0. The
reconnect RTP clock advanced exactly 12,220 ms over 12,220 ms elapsed. Source
silence decoded to exact zeros, and the unrelated tone remained excluded.
Steady playback and every clean/recovered waveform window had zero clipping
and zero sine-predictor discontinuity flags; the earlier unrelated-tone and
post-recovery anomalies did not reproduce in this run. This does not erase
the earlier evidence or constitute a subjective click-free listening result.

Actual loss produced 136 lost audio packets, 31,200 concealed samples and
8,240 samples removed for playout acceleration. The waveform detector flagged
five left-channel and three right-channel windows during that phase, with
no clipping. Recovery had zero lost/concealed samples and zero waveform flags,
although Chrome still removed 240 samples for acceleration. Thus playout
adjustment is observable, but its counters alone do not prove an audible click
or identify the cause of each earlier anomaly.

Video dropped 22 decoder frames during impairment and recovered to 59.98
decoded fps with zero further decoder drops. Its measured software visual
delay remained about 217 ms versus 134 ms before loss, and mean video jitter
buffer delay was about 85 ms versus 13 ms. Successful recovery did not restore
the original latency within this 12-second window. The browser observer's
audio timing remains an independent Web Audio path, not HTML video lip sync;
decoded fps also does not resolve the previously measured fresh-frame limit.

### Synchronization signaling review

The SDP captured from actual Chrome playback in both packages advertises
`gamecapture-audio` and `gamecapture-video` as different RTCP CNAMEs. The
analyzer now records this as `syncSignaling.singleCname: false`, separately
from successful decoded playback. WebRTC requires a single CNAME within a
PeerConnection's synchronization context. This is an existing conformance
issue, and a concrete item to investigate before extending publishing
transports. See [RFC 8834, CNAME requirements](https://www.rfc-editor.org/rfc/rfc8834.html#section-4.9)
and [media synchronization](https://www.rfc-editor.org/rfc/rfc8834.html#section-12.2.3).

The publisher also uses the separate names in its sender-report configuration.
This finding does **not** prove that changing the names alone would correct
the measured native OBS offset: sender-report clock correlation, capture
timing and receiver behavior must be checked together. No speculative global
audio delay or synchronization change was applied during this validation.

## Scope and follow-up

This change adds collapsed advanced audio controls, per-peer codec negotiation,
experimental PCM and Opus redundancy, and reusable packaged quality fixtures.
The PCM timestamp correction is included in the rebuilt review package.
GUI settings were restored after each workflow. The review ZIP is a local
validation artifact; no public release was published as part of this pass.

Unresolved coverage includes physical speaker/display latency and subjective
listening, multiple real games and capture APIs, longer multi-hour leak runs,
other GPU/driver/OS combinations, Firefox generated PCM-link compatibility,
native Ninja A/V sync, full-rate capture cadence, and silent tray reminders.
Results from earlier release/update/network-failure
validation remain documented in `release-0.2.60-windows-validation.md`; they
were not silently counted as reruns in this pass.
