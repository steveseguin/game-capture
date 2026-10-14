# Encoding defaults: packaged validation, 2026-10-14

Both Game Capture and Desktop Studio now default to **4,000 kbps video**, with **2,500 kbps Economy** available. Fresh window capture is **1280x720 at 60 fps**, hardware-first Auto. Camera format remains independently **1920x1080 at 30 fps**; a new Studio show remains **1280x720 at 30 fps**. Saved preferences are retained: an existing saved 12 Mbps setting must be changed to Standard manually.

## Encoding policy

- Windows Software H.264 uses **Media Foundation**, not x264. It requests lowest complexity (`AVEncCommonQualityVsSpeed=0`), between one and four workers, limited to half the logical processors. Both controls were accepted on this host.
- Native H.264 explicitly requests CBR with a one-second encoder reservoir. The maximum follows the selected target; it does not add 4 Mbps. Unsupported CBR requests are logged.
- Hardware-first Auto remains the default. Explicit FFmpeg NVENC/QSV/AMF retain their existing low-latency settings.
- The optional external FFmpeg libx264 path already specifies `veryfast` and `zerolatency`. The bundled LGPL FFmpeg has no libx264/libx265; this round did **not** benchmark x264 presets. Advanced software AV1/VP9 were not profiled this round.
- Rate control is not an upload cap or network pacer. AAC, transport headers, retransmissions, extra viewers and guest returns consume additional bandwidth. Independent recording retains its separate 12/24 Mbps quality settings and adds CPU/GPU work.

Microsoft documents [the H.264 encoder's rate control and complexity ranges](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder) and [worker-thread control](https://learn.microsoft.com/en-us/windows/win32/medfound/codecapi-avencnumworkerthreads). These are Media Foundation controls, not x264 preset equivalents.

## Method and limits

Actual portable packages captured a full-screen 1920x1080 Chrome source with moving textured detail, frame identities and stereo audio. Streams went to a private local UDP receiver and were saved, then decoded strictly (`ffmpeg -xerror`) after profiling. Studio ran visibly with a real looping H.264/AAC file, UI Start/Stop buttons and isolated show settings. The C920 camera/microphone workflow also used actual interface controls. No public broadcast was started.

Host: Core Ultra 7 265K, 20 logical processors, TITAN RTX and Intel Graphics. CPU is the publisher process tree's CPU time divided by 20, expressed as whole-machine occupancy. It includes owned encoding/media workers, excludes the receiver/source browser and is not a promise of headroom on another CPU. RSS sums process working sets and may double-count shared pages. Results exclude the first five and last three resource samples. Normal clips are 20 seconds; stress/Studio clips are 30 seconds. This is comparative testing, not a long soak or a real demanding game's frame-time benchmark.

Profiling, media analysis, compilation and archive creation were serialized. Two fixture problems were corrected before the final results: an initially narrow capture window, and a UDP meter receive buffer that dropped an opening keyframe burst. The final meter has 4 MiB socket buffers. Earlier exploratory recordings are not the validated dataset.

## Game Capture results

| Configuration | Mean CPU | CPU p95 | Tree RSS MiB | UDP+IPv4 Mbps | Distinct frames/s |
|---|---:|---:|---:|---:|---:|
| Software 1080p60 / 4 Mbps | 5.26% | 5.96% | 230 | 4.38 | 59.93 |
| Software 720p60 / 4 Mbps (new default size) | 2.48% | 3.09% | 175 | 4.50 | 60.00 |
| Auto 720p60 / 4 Mbps | 3.25% | 4.02% | 198 | 4.50 | 59.80 |
| Software 720p60 / 2.5 Mbps | 3.15% | 3.62% | 177 | 2.94 | 60.00 |
| Software 720p30 / 4 Mbps | 1.74% | 2.12% | 174 | 4.36 | 30.00 |
| Intel QSV 1080p60 / 4 Mbps | 3.20% | 3.59% | 351 | 4.52 | 59.20 |
| Advanced FFmpeg NVENC 1080p60 / 4 Mbps | 3.25% | 3.76% | 348 | 4.35 | 58.65 |

All seven final streams decoded cleanly, retained stereo audio and passed continuity checks. The default software output had 17 ms p95 frame spacing and approximately 4.58 Mbps one-second peak UDP traffic. Native Auto also maintained approximately 60 fps. Decoded stills and the actual settings/Studio windows were visually reviewed: text and color bars remained legible, while Economy showed softer moving texture. This is a qualitative inspection, not a calibrated image-quality score.

The earlier package at an explicit **1080p60 / 12 Mbps** reference setting used **6.48% CPU**, **235 MiB** process-tree RSS and **12.86 Mbps** UDP+IPv4 traffic with software encoding. The new **720p60 / 4 Mbps** software configuration used **2.48% CPU**, **175 MiB** RSS and **4.50 Mbps** traffic. This comparison changes resolution and bitrate together; it does not attribute the entire improvement to the encoder complexity knob.

At matching 4 Mbps, old/new software CPU was 5.47/5.26% at 1080p60 and 2.52/2.48% at 720p60. These small differences are within short-run variation. Lower resolution/frame rate delivered the clearest CPU saving. Economy reduced upload to 2.94 Mbps but did not reliably reduce CPU.

### CPU contention and timing

Sixteen bounded CPU workers at 90% duty produced 90.7% average total-system CPU during the software run and 88.9% during Auto. Software retained **59.87 distinct fps**, Auto **59.86**, both approximately 60 decoded fps with 17 ms p95 spacing, clean decode, no unexpected 10 ms audio-silence windows and no capture queue drops. Publisher CPU was 2.88/2.53% respectively. This is synthetic CPU competition, not GPU saturation or a demanding game.

Separate frame traces at the new default measured software/Auto median encoder-output waits of 3.73/3.25 ms; p95 was 4.08/3.57 ms. Median capture readback was about 5 ms and includes GPU waiting; these wall times are not CPU execution time. Queue medians were 23.94/17.70 ms. Audio/video pulse offsets in the browser fixture are uncalibrated; no new absolute lip-sync accuracy claim is made.

### Remaining hardware-path observations

Explicit QSV has startup queue drops while its FFmpeg worker warms up (about 59.2 fps over the complete 20-second clip, 100 ms maximum gap). The advanced FFmpeg NVENC 1080p60 path averaged **58.65 fps**, with occasional gaps up to 67 ms, despite clean decode. These paths should receive further pacing/startup work; their results are not described as locked 60 fps. Native default Auto did not show that behavior.

## Desktop Studio results

All cases publish at the new 4 Mbps target. The media source itself decodes a detailed 720p60 file, including when the canvas outputs 30 fps.

| Configuration | Mean CPU | Tree RSS MiB | Distinct frames/s | Control API p95 |
|---|---:|---:|---:|---:|
| software-720p30 | 3.52% | 339 | 30.00 | 26.0 ms |
| software-1080p60 | 8.08% | 406 | 59.96 | 30.4 ms |
| auto-720p30-record | 5.11% | 570 | 30.00 | 26.5 ms |
| qsv-720p60 | 4.60% | 472 | 59.53 | 26.0 ms |

All four received files plus the independent local recording decoded cleanly. Program recording continued while publishing; output stopped and recording finalized normally. Every steady 10 ms audio window in these five files remained above RMS 0.026, with both expected stereo tones. Canvas 30/60 fps outputs had 34/17 ms p95 frame spacing. QSV's startup still lowers its whole-clip average slightly. Control API response time does not substitute for a measured game frame-time or UI input latency.

## Fixes found through actual use

- Capture shutdown now retires a shared callback guard and waits for in-flight resource access before freeing D3D textures. Late WinRT callbacks see a retired owner. An earlier QSV shutdown crashed in `d3d11.dll`; eight packaged QSV publish/quit repetitions after the change all exited normally. This is evidence for the hardening, not proof that every driver crash is prevented.
- Studio's media loop preserved neither the original presentation clock nor AAC priming semantics. Tests found 30?40 ms of loop silence. Automatic loops now keep a continuous clock, trim codec padding to file duration, and discard the first AAC priming block when Windows exposes it at the same timestamp as the real first block. Manual seeks still reset the clock. A separate PCM WAV loop/publish run also retained continuous stereo audio, and video-only seeking/EOF/restart passed. The rebuilt publishing/recording matrix had no detected loop silence. Paused seeking, held position, changed cue pictures, non-looping EOF, restart and a near-end looping seek all passed.
- The physical Logitech C920 interface workflow passed: 4 Mbps Standard and 2.5 Mbps Economy selection; window defaults 720p60; independent camera output 1080p30; no microphone; mute/unmute on primary and additional routes; saved settings restored. Explicit AMF fails clearly on this non-AMD host. Actual AMD encoding and OBS playback remain unverified.

## Evidence and reproduction

Local reports are in `native-qt/e2e/reports/encoder-defaults-2026-10-14/` in the respective checkout. Game's primary directories are `verified-baseline`, `verified-fullscreen`, `verified-stress`, `high-rate-reference`, `verified-ui-camera`, `final-shutdown` and `final-profile`. Studio's primary directories are `verified-final`, `transport-final`, `audio-only-final` and `video-only-final`. Earlier `verified`/`verified-loop` failures are retained as diagnostic evidence and superseded by the final pass.

Game package executable SHA-256: `8815933a6ece16de48bde4de9c34f198121b3a02e9701589263ce381ae4687b2`.
Studio package executable SHA-256: `f1412973f8d75109b7943bd98e2df7810e73f9b33349534328052116e4c2f8a0`.

The Game driver accepts a matrix such as:

```json
[{"id":"udp-software-default","resolution":"1280x720","fps":60,"video-encoder":"software"},
 {"id":"udp-auto-default","resolution":"1280x720","fps":60,"video-encoder":"auto"}]
```

From Game Capture's `native-qt`, using the existing local QA prerequisites:

```powershell
node e2e/external-output-packaged.js --publisher=dist/game-capture-encoder-final/game-capture.exe --output=e2e/reports/my-run --matrix=matrix.json --motion=true --fullscreen=true --wire-meter=true --seconds=30
# Add --load-workers=16 for bounded CPU contention. Analyze after the run ends.
.cache/desktop-ui-python/Scripts/python.exe e2e/summarize-encoder-defaults.py e2e/reports/my-run --ffmpeg dist/game-capture-encoder-final/ffmpeg/bin/ffmpeg.exe
```

Studio uses `e2e/mixer-encoder-defaults-e2e.py --package dist/desktop-studio-encoder-final --report e2e/reports/my-run`; `--transport-only` exercises seeks/EOF/restart. The helper uses the sibling Game Capture QA environment/resource sampler. Both UI gates passed 93 checks with one platform-specific skip; these are gates, separate from the packaged workflows above.

Not covered by this round: low-core-count hardware, a demanding game's own frame-time impact, GPU/VRAM saturation, AMD hardware, alternate external x264 builds/presets, long-duration memory growth, or an exhaustive rerun of every network protocol and loss-recovery mode. A clean-machine run remains deferred. Existing preferences and user shows were restored; no GitHub release or installer was published.

## Extended validation later on October 14

This follow-up used the same complete portable packages above, private local receivers and isolated shows. Profiling and decoding remained sequential. Reports are under `native-qt/e2e/reports/extended-validation-2026-10-14/` in each checkout.

### Ten-minute Studio recording and software publishing

The visible Studio published 720p30 / 4 Mbps software video while independently recording Program. A looping 12-second H.264/AAC source exercised about 50 loop boundaries. Sixteen bounded CPU workers ran for 90 seconds partway through the session.

- Received video: 29.99997 fps over 599.9 seconds; 34 ms p95 and maximum frame spacing. Local recording: 29.99588 fps over 601.8 seconds, 34 ms p95 and one maximum interval of 116 ms.
- Total-system CPU averaged 88.0% during contention. Studio's process tree averaged 4.85% before, 4.70% during and 4.98% after contention.
- Recording drops remained at the startup count of 14. All nine child PIDs remained unchanged. Both complete files decoded cleanly; the minimum 10 ms audio RMS stayed above 0.027, including loop boundaries.
- Main-process private memory grew 4.32 MiB between early and recovered windows; process-tree RSS grew 8.56 MiB. Median main-process handles decreased by 12. These are finite observations, not proof of no leaks.
- Control API p95 was 24.0 ms, maximum 28.7 ms. An actual application screenshot during 89% system CPU showed publishing, recording and active audio meters; the screenshot API returned in 40 ms.

Evidence: `software-recording-soak/results.json`, `soak-analysis.json` and `active-load.png`. The driver now supports `--soak-seconds 600 --load-workers 16`; run `e2e/analyze-studio-encoder-soak.py REPORT --ffmpeg FFMPEG` only after the app exits.

### Fault isolation, sync, recoverable recordings and logs

The headless fault workflow ran healthy frame-identified video and matching audio pulses alongside a browser source and RTMP publishing. It injected browser CPU overload, browser process termination/hang, 35 seconds of network starvation followed by recovery without closing sockets, publishing worker termination, and simultaneous browser/publisher faults.

The healthy media worker never restarted. Recording drops stayed at their startup count of nine. Browser audio was detected before and after recovery. Local and received files decoded cleanly. Local A/V offset p95 was 26 ms; received p95 was 24–30 ms. Post-recovery received pictures were about 0.20–0.23 seconds behind the live source. API p95/max were 28/38 ms. Five bounded worker-failure log entries were recorded.

Separate tests verified:

- A real app access violation (`0xC0000005`) during MKV recording produced a playable, fully decodable recording, crash JSON, minidump and log snapshot. Owned workers exited. Relaunch restored the source without automatically restarting recording or publishing, and a new recording decoded cleanly.
- Five sessions of log rotation retained at most four log files and preserved the crash snapshot. A synthetic private key was absent from logs and the generated issue report. Making the logging directory unavailable did not prevent launching or recording.
- Killing the Program recording writer did not stop four independent source recordings. Their files remained decodable; off-screen recording, mute/private-break routing, and black/silent output after removing a source passed.

Evidence: `fault-quality/fault-quality.json`, `crash-recovery/diagnostics-fault.json`, `recording-isolation/recording-isolation.json`.

### Headless frame-timing fix

The fault test exposed uneven headless frame timing: approximately 30 fps on average, but 47 ms p95 intervals and phase-dependent duplicate/skip pairs. A controlled 60-second recording changed Windows timer handling midway through the same owned app process; p95 intervals fell from 47 to 35 ms.

Windows can ignore timer-resolution requests for invisible/inaudible windows. Headless Studio now requests a 1 ms clock and explicitly keeps that request honored. The change is limited to `--studio-headless`, leaves process priority and CPU execution-speed policy alone, and balances the timer request on normal teardown. Older Windows can still use the timer request when the newer policy is unavailable. See Microsoft's [timer-resolution documentation](https://learn.microsoft.com/en-us/windows/win32/api/timeapi/nf-timeapi-timebeginperiod) and [process policy documentation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation).

A complete rebuilt package, `dist/desktop-studio-timing-review`, passed a fresh 60-second recording without instrumentation: 30 fps, 34–35 ms p95 intervals, 36 ms maximum interval and no duplicate pictures in the two measured 23-second windows. Process-tree CPU averaged 2.45% for this simpler media-plus-recording workload. This CPU number is not comparable to the multi-output soak.

Executable SHA-256: `f921fdc70011315b213af8f544bc33d9a62a6886c59266ab9d18eb098caf2880`. Evidence: `headless-timer-probe/cadence.json`, `headless-timing-fixed/cadence.json`. Reproduce with `e2e/mixer-headless-cadence-e2e.py --package PACKAGE --report REPORT --fixture FRAME_CLOCK_MP4`; the optional `--timer-experiment` is diagnostic only.

The full failure sequence also passed on this rebuilt package (`fault-timing-fixed/fault-quality.json`): 30.00 fps over 6,689 frames, 34 ms p95 and 45 ms maximum frame interval, eight duplicate/skip pairs, local A/V offset p95/max 22 ms, and received A/V p95 6–11.5 ms. Recording drops stayed at nine, healthy source restarts stayed at zero, and browser audio returned after recovery. API p95/max were 26/41 ms. The visible app's paused seeking, held position, EOF, restart and loop-boundary cue checks also passed (`visible-timing-fixed/results.json`).

### Longer Game Capture encoder/protocol runs

All cases used fresh 4 Mbps defaults, a moving full-screen source and real stereo audio. All seven received files decoded cleanly and passed audio-continuity checks. CPU percentages are whole-machine process-tree occupancy on this 20-logical-processor host.

| Selection / output | Recorded duration | Mean CPU | Distinct fps | Capture queue drops |
|---|---:|---:|---:|---:|
| FFmpeg NVENC 1080p60 / UDP | 90 s | 3.19% | 58.28 | 158 |
| Explicit NVENC 1080p60 / UDP | 60 s | 3.02% | 58.75 | 77 |
| Auto 1080p60 / UDP | 90 s | 5.17% | 60.00 | 0 |
| Software 720p60 / UDP | 90 s | 2.56% | 60.00 | 0 |
| Auto 720p60 / WHIP | 30 s | 3.25% | 60.00 | 0 |
| Auto 720p60 / SRT | 20 s before + 20 s after receiver restart | 2.17% | 60.00 | 0 |

SRT returned to publishing 3.8 seconds after the receiver restart; this is reconnect time, not steady playback latency. UDP+IPv4 traffic averaged 4.35–4.48 Mbps, with one-second peaks no higher than 4.79 Mbps. Both explicit NVENC and the advanced FFmpeg choice selected FFmpeg `h264_nvenc` on this host; the below-60-fps limitation therefore affects both selections. Auto selected a hardware Media Foundation encoder and held 60 fps.

Evidence: Game's `encoder-and-protocols/results.json`, `summary.json` and `analysis.json`. The matrix accepts per-case `seconds` to mix long encoder runs and shorter reconnect cases.

Remaining coverage: actual AMD hardware/OBS, weaker CPUs, demanding-game frame times, GPU/VRAM saturation, overnight memory growth, and a clean machine. This round did not repeat every protocol's packet-loss/FEC matrix or claim calibrated absolute lip sync from the browser-generated Game fixture. Explicit NVENC pacing remains unresolved. No release or installer was published by this follow-up.

## Additional resilience and fuzz validation on October 14

Both repositories were pulled with `git pull --ff-only` before this round; both were already current (Game Capture `b1967aaa`, Desktop Studio `4a36a65b`). Real workflows used complete portable packages, isolated settings/shows, and private localhost receivers. Resource runs, compilation and post-run decoding were serialized.

### Fixes found by the workflows

- **First launch at high display scaling:** both initial windows could extend beyond the usable desktop at 150–300% scaling. They now start maximized when their initial size does not fit the screen's work area. Existing scroll areas keep controls accessible without shrinking text or changing the theme.
- **Unavailable explicitly selected microphone:** the native Capture output path used to substitute the Windows default microphone. Both apps now report the unavailable selection and leave that input off. Explicitly choosing the Windows default still works as before; healthy game audio continues independently.
- **Publishing with no incoming audio:** removing that microphone fallback exposed FFmpeg waiting indefinitely for a declared audio track. The mux worker now supplies 48 kHz silence after 250 ms without PCM, only while video advances. It first drains queued real audio, bounds catch-up to one second, and trims any overlap when real audio resumes. Studio tracks this separately for each recording track. This changes the FFmpeg mux path, not WHIP's Opus transport or microphone selection. It cannot keep an absent video encoder alive.

### Actual packaged workflows

- **Display/UI:** opened both apps at 100%, 150%, 200%, 250% and 300% process-local Qt scaling; checked initial/maximized bounds, used the tabs/advanced toggle and scrollbars, and reviewed screenshots. All ten initial-window containment checks passed after the fix. Reports: Game checkout `game-display-fixed/` and `studio-display-fixed/`.
- **Large capture surfaces and reduced CPU availability:** Game Capture handled 4K, 8K, 5120×1440 and odd 641×479 windows, 24 rapid resizes, hiding/restoring the source and closing it. The 8K surface was GPU-scaled to 720p before readback. Capture stayed approximately 29.85–30.04 fps; the 8K phase had one queue drop. Restricting the app and owned children to two logical CPUs held 30.01 fps without additional capture drops. Source closure produced the documented clean headless exit, not an OS crash.
- **Studio isolation under large sources:** simultaneous local recording and software UDP publishing survived 4K/8K/portrait/odd surfaces, an 8192×4096 image, a truncated image, 20 rapid resizes, two-CPU affinity, killing the window worker, hanging the audio worker and destroying the captured window. Healthy media never restarted; recording drops remained 11→11. Both full files decoded cleanly with continuous healthy audio. Main-process private memory peaked at 299 MiB for the 8K image and returned to 37 MiB. API response maximum was 121 ms during source closure, otherwise at most 32 ms.
- **Unusual audio files in Studio:** 8/11.025/22.05/44.1/96/192 kHz, PCM 8/16/24/32-bit, float32, and mono/stereo/3/6/8 channels. Recorded Program and a separate source track; verified expected tones, finite samples and complete decoding. Float64 was rejected with an understandable unsupported-track error. NaN/infinity float input did not contaminate the recording. Empty, truncated, zero-rate, zero-channel and random files, plus unavailable camera/microphone/window identifiers, left the healthy source running. Program's minimum 10 ms RMS stayed above 0.0267; per-format API responses stayed below 28 ms.
- **Unavailable native devices in both apps:** nonexistent camera and Spout selections failed normally; an unavailable optional microphone preserved the source's 440/880 Hz stereo audio; an unavailable primary microphone published playable video with silent audio. Neither microphone case selected another device.
- **Fourteen-second audio-delivery fault in both apps:** paused only the owned native WASAPI capture thread while video continued to the real UDP receiver. Both outputs stayed live with zero reconnects, delivered approximately 14 seconds of silence, and restored the expected stereo tones. Complete files decoded cleanly. Video timestamp spacing p95 was 34 ms; maximum was 37 ms for Game Capture and 36 ms for Studio's native Capture output path.
- **Control API fuzzing in both apps:** malformed authentication/HTTP framing, oversized requests, 256 seeded invalid JSON commands, slow incomplete connections, connection limits, pipelining and 128 concurrent mixed valid/invalid requests. Health and schema still worked afterward; normal quit removed discovery files. Studio's driver now explicitly uses a disposable show.

- **Final Studio combined-fault regression:** the package with all fixes passed browser CPU overload/crash/hang, 35-second network starvation, publisher termination, and simultaneous browser/publisher failure. The 6,701-frame local recording averaged 30.00 fps, with 34 ms p95 / 45 ms maximum spacing and four duplicate/skip pairs. Local A/V offset stayed within 13 ms; received p95 offsets were 2–9.5 ms. Recording drops stayed 9→9, healthy sources never restarted, and browser audio returned. All recordings decoded cleanly. API p95/max were 25/31 ms; recovered pictures were 0.13–0.20 seconds behind the live source. Evidence: Studio `fault-quality-final/fault-quality.json`.

- **Game Capture mux regression after the fix:** software 720p30 / 4 Mbps SRT before and after receiver restart, RTSP over TCP, and mono UDP all passed. All four received recordings strictly decoded without errors, held approximately 30 fps / 34 ms p95 frame spacing, and had zero unexpected low-energy audio windows. SRT returned to publishing 3.82 seconds after receiver restart. Whole-machine process-tree CPU averaged 1.50–1.62% on this 20-logical-processor host. Evidence: Game `mux-regression/results.json`, `analysis.json`, and per-case resource samples.

Additional cadence analysis of Studio's large-source fault run found steady received output (30.00 fps; p95/max frame spacing 34 ms). Local recording averaged 29.95 fps with 34 ms p95 spacing, but had three isolated gaps over 70 ms: 105, 85 and 162 ms. Recording queue-drop counters did not increase. This remaining local-recording pacing limitation under source/load faults is not claimed fixed; see Studio `source-baseline/cadence.json`.

Large-surface runs used the intermediate packages containing the display fix; the audio-format, missing-device, audio-stall and Studio API-fuzz runs above used the final packages with all three fixes. Reports include executable hashes, measurements and failure logs under `native-qt/e2e/reports/resilience-2026-10-14/` in the corresponding checkout.

Final complete review packages:

- Game Capture: `native-qt/dist/game-capture-resilience-review/`; executable SHA-256 `e0b9a5fbbc13ef735f38c9ff016a5f37bdd307f3c7f7ee6a322762c872a36179`.
- Desktop Studio: `native-qt/dist/desktop-studio-resilience-review/`; executable SHA-256 `855f90263695304d7d893223c04db34fba155a9c95fbcca4ff8d463df8d4d244`.

Reproduction drivers are Game's `display-scaling-packaged.py` (`--studio` for Studio), `capture-resilience-packaged.py`, `device-failure-packaged.py`, and `audio-stall-packaged.py`; Studio's `mixer-audio-format-resilience-e2e.py` and `mixer-source-resilience-e2e.py`; and each repository's `local-control-fuzz-packaged.py`. The Studio source driver uses the sibling Game QA fixture. Audio-stall injection uses Frida only in the owned test process and makes no Windows device configuration changes.

Coverage limits: file decoding is not proof of support for every physical audio driver's format. Two-CPU affinity on this Core Ultra host is not an older laptop, and a large window surface is not a real 8K/HDR/mixed-DPI monitor configuration. No physical unplug/replug, AMD/OBS, GPU removal, real weak-machine/game-impact or overnight soak was performed in this round. Clean-machine testing remains deferred. Explicit NVENC pacing noted above remains unresolved. These are local review builds; no GitHub release or installer was published.

## Code review and additional protocol/state fuzzing on October 14

This follow-up reviewed native Capture audio liveness, show import validation, local control handling and publishing failure paths in both apps. It used rebuilt complete portable packages, disposable Studio shows, and private localhost receivers. Media runs, builds and decoding were serialized. Compilation and syntax checks were gates; the results below came from running the packaged applications.

### Confirmed findings and fixes

- **P1, Studio show replacement:** Qt's `toArray()` converted malformed `sources` values such as `null` into an empty list. An otherwise valid file was accepted and replaced the current show, potentially persisting the empty result. A packaged baseline reproduced HTTP 200 for this invalid import. Loading now requires an object root and actual source/scene arrays; a present scene `layers` field must also be an array. Validation runs before replacing the current show. Omitted layers remain supported.
- **P2, misleading Capture audio meters in both apps:** a stopped audio callback left its last nonzero RMS/peak visible indefinitely even while the receiver heard silence. The native primary, additional and mixed meter readings now expire after 250 ms without valid PCM. Diagnostics and the UI use the same getters. Freshness timestamps reset on capture start/stop; invalid/empty primary PCM no longer marks that input active. This affects the native Capture path, not Studio's separate per-source mixer meters.

### Packaged results

- **Control HTTP/API fuzzing, both apps:** all 291 checks passed per app, including 256 seeded invalid commands, malformed authorization/framing, oversized input, fragmented Unicode, incomplete-connection deadlines, bounded connections, ignored pipelined commands and a burst of 128 concurrent valid/invalid requests. Health/schema still responded, normal quit removed discovery files, and saved settings were restored.
- **Studio stateful fuzzing:** two seeds each rejected 51 malformed imports without changing the current show, then rejected 180 invalid commands while accepting 360 scene/layer edits during simultaneous local recording and software UDP publishing. Inputs included wrong JSON types, excessive nesting/size, duplicate scene IDs, missing sources, invalid audio/geometry ranges, nonfinite JSON numbers and blocked browser URL schemes. The final seed also saved and reopened a valid show, verified its configuration and waited for video/audio to return. The healthy media worker did not restart. In the final run, API maximum was 25.6 ms and recording drops stayed 10 to 10. Both complete recordings decoded cleanly; minimum 10 ms audio RMS was 0.0257 locally and 0.0259 at the receiver. Program and WHIP receiver screenshots were inspected.
- **Repeated native audio interruptions, both apps:** eight pauses of the owned capture thread (120, 220, 260, 550, 1300, 5000, 300 and 2000 ms) left video publishing live with zero reconnects. Samples during the longer stalls verified that primary/mixed meters cleared; meters and expected 440/880 Hz stereo tones returned afterward. Full received files decoded cleanly. Game delivered 1,200 video frames and Studio 1,199, with 34 ms p95/maximum frame spacing. The longest silent intervals were 4.93 and 4.96 seconds.
- **WHIP/RTMPS negotiation, both apps:** all 11 cases passed: authenticated browser playback, cross-origin redirect credential handling, two ICE Link formats verified by STUN traffic, authentication rejection, malformed/oversized SDP cleanup, untrusted TLS rejection, cancellation during a pending POST, RTMPS certificate rejection and relay-only failure without TURN. Synthetic credentials were checked against diagnostics/logs. The harness now reads the fixture's actual window title (fixing a stale Studio title) and accepts an explicit MediaMTX path.

Reports are under `native-qt/e2e/reports/review-fuzz-2026-10-14/`: `control-game/` or `control-studio/`, `audio-interruptions-game/audio-stall.json` or `audio-interruptions-studio/audio-stall.json`, and `whip-http-game/results.json` or `whip-http-studio-final/results.json`. Studio also has `stateful-baseline/stateful-fuzz.json` (the reproduced import failure), `stateful-fixed/stateful-fuzz.json` and `stateful-final/stateful-fuzz.json` (passing seeds 2601015/2601016).

Reproduce with Game's `audio-stall-packaged.py --fuzz --publisher EXE --report REPORT`, each repo's `local-control-fuzz-packaged.py` and `whip-http-packaged.js`, and Studio's `mixer-stateful-fuzz-e2e.py --package PACKAGE --report REPORT --fixture MP4 --seed 2601016`. The stateful fixture is the 12-second 720p60/stereo file from `encoder-defaults-2026-10-14/verified-loop/source.mp4`. Studio's Node harness can use the sibling Game `node_modules` through `NODE_PATH` and `--mediamtx=PATH` when its own QA dependencies are absent.

Complete candidate packages:

- Game Capture: `native-qt/dist/game-capture-fuzz-review/`; executable SHA-256 `f2ff511576e907b2fa1791809ec1f1e19423e22f3ecd6f2dbe6666263eebf816`.
- Desktop Studio: `native-qt/dist/desktop-studio-fuzz-review/`; executable SHA-256 `81fa31565b89d5f5d482741611d745bc39807e892545d633fb48c61d94be3ce2`.

Limits: these are bounded, seeded workflows, not exhaustive proof of safety. This round did not repeat physical device unplug/replug, AMD/OBS, weak-machine/game-impact, overnight resource growth, trusted-HTTPS certificate cases or every protocol's loss/FEC matrix. Previously observed explicit NVENC pacing and isolated Studio local-recording gaps under large-source faults remain unresolved. Clean-machine testing remains deferred. No release or installer was published by this follow-up.
