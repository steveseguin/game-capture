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
