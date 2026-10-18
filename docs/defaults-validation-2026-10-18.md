# Packaged defaults validation ? 2026-10-18 UTC

Unreleased Windows candidates based on Game Capture 0.2.64 and Desktop Studio 0.9.2. This validates the new defaults; it does not publish a new app release. See [the default policy](streaming-defaults.md).

## What actually ran

- Real packaged Game Capture window/process-audio capture to a private MPEG-TS/UDP receiver: Auto, Windows software, NVIDIA, Intel and AMD at the untouched CLI defaults, **720p60 / 4 Mbps**. Auto and AMD also published WHIP to a private MediaMTX receiver, with Chrome playback and an independently recorded relay output.
- Real visible Studio: a moving stereo media source, UI Start/Stop, **720p30 / 3 Mbps**, Auto/software/NVIDIA/Intel/AMD; Auto and AMD also recorded independently. A separate AMD **720 ? 1280 portrait** publishing + recording run passed.
- Studio headless window capture to UDP and WHIP without resolution, FPS, video bitrate or audio bitrate flags. Actual configuration was **720p30 / 3 Mbps**.
- Visible first-run controls and restart/save workflows in both apps: new defaults appeared; explicit **60 fps / 6 Mbps / 192 kbps audio** survived a restart. Original registry preferences were restored and compared by value. Studio's API used **200 ms SRT latency** when omitted and honored an explicit **450 ms** override.
- Opt-in **software AV1 at 720p30** in both packaged apps: actual VDO.Ninja/Chrome playback with decoded audio. Both selected `FFmpeg libaom-av1`, without hardware fallback; Game rendered 29.70 fps and Studio 29.95 fps. This simple source does not qualify demanding-game AV1 performance.

The build, UI configuration/persistence, Opus and WebRTC unit checks also passed in both repos. These are supporting gates, separate from the packaged workflows above. One stale Studio reset assertion still expected 60 fps; it was corrected to 30 fps.

## Measurements

Core Ultra 7 265K, 20 logical CPUs; NVIDIA TITAN RTX, AMD Radeon RX 9060 XT, Intel Graphics. Publisher process-tree CPU is shown as a percentage of the whole machine; **5% equals one logical CPU's occupancy**, not guaranteed gaming headroom. Runs were sequential, within affinity CPUs 0?9, after the ongoing research job completed. The research controller was held at that boundary. Decode/analysis ran after publisher measurements.

CPU includes the app, capture/render, encoder, audio and owned workers. It excludes the source browser and independent receiver. UI/composition/recording costs differ between workflows, so these are not isolated encoder comparisons. RSS sums processes and may count shared pages more than once.

| App / workflow | Received fps | Video kbps | CPU % | RSS MiB | Strict decoded-output check |
|---|---:|---:|---:|---:|---|
| Game Capture / UDP auto | 59.98 | 3989 | 3.11 | 197 | Pass |
| Game Capture / UDP software | 59.94 | 3958 | 2.24 | 174 | Pass |
| Game Capture / UDP nvenc | 59.78 | 3986 | 1.61 | 299 | Pass |
| Game Capture / UDP qsv | 59.39 | 4014 | 1.85 | 295 | Pass |
| Game Capture / WHIP auto | 60.25 | 4010 | 2.54 | 175 | Startup timestamp exception below |
| Game Capture / UDP amf | 59.74 | 3954 | 1.91 | 196 | Pass |
| Game Capture / WHIP amf | 60.00 | 4016 | 2.17 | 175 | Pass |
| Desktop Studio headless capture / UDP auto | 30.00 | 3006 | 1.60 | 270 | Pass |
| Desktop Studio headless capture / WHIP amf | 30.13 | 3006 | 1.08 | 222 | Startup timestamp exception below |
| Desktop Studio / amf-720p30-record | 29.80 | 2957 | 4.25 | 510 | Pass |
| Desktop Studio / amf-portrait-720p30-record | 29.80 | 2935 | 4.52 | 516 | Pass |
| Desktop Studio / auto-720p30-record | 30.00 | 2978 | 4.38 | 535 | Pass |
| Desktop Studio / nvenc-720p30 | 29.90 | 2991 | 2.85 | 459 | Pass |
| Desktop Studio / qsv-720p30 | 29.80 | 3107 | 3.29 | 433 | Pass |
| Desktop Studio / software-720p30 | 30.00 | 2982 | 3.45 | 318 | Pass |

All 15 H.264 recordings contained **zero B-frames**, Baseline/Constrained Baseline video, stereo 48 kHz audio and audible decoded samples. Thirteen passed the strict clean-decode and monotonically increasing timestamp check. Observed maximum keyframe gaps were about **1.00?1.25 seconds**, not a guarantee of an exact one-second wall-clock interval.

Streaming AAC targeted 128 kbps; actual rates varied with content (~103?129 kbps). WHIP Opus was ~128 kbps. Studio's three independent recording workflows decoded cleanly, with continuous stereo tones and **zero reported recording queue drops**; their video and 192 kbps AAC settings remained independent of the upload defaults.

Per-process GPU counters were captured, retaining adapter LUID and engine identity. Examples: Game NVIDIA VideoEncode **18.4%**, AMD Video Codec Engine **11.8%**, Intel's encoder-associated driver counter named VideoDecode **10.5%**. Studio's corresponding publishing engines were approximately **8.8%, 5.8%, 5.5%** at 30 fps. These are distinct physical engine counters, not summed total GPU load. MF Auto did not expose an attributable codec-engine reading in every run; missing/zero attribution is not evidence of zero GPU work. Raw records also retain system-wide engines and CPU.

Software AV1 rendered at ~30 fps with ~2.79% Game / ~3.07% Studio process-tree CPU and ~188 / ~212 MiB RSS. Its existing media-quality harness uses instrumented monitoring; do not treat it as a controlled comparison against the H.264 runs.

## Findings retained, including the exception

**Two WHIP ? MediaMTX ? RTSP recordings repeated timestamps near startup:** Studio AMD 720p30 repeated three; the final Game Auto 720p60 run repeated six. Both strict file checks failed. Their simultaneous Chrome WebRTC viewers reported **30 / 60 fps, zero dropped frames, zero freezes and zero packet loss**. Received video was Constrained Baseline with no B-frames. This does not establish the cause or make the relay recordings clean. Keep this timestamp path open; the defaults do not claim to fix every previously observed WHIP/relay problem.

The initial hardware Media Foundation runs emitted Main profile despite the Baseline WebRTC offer. Hardware output now requests Baseline explicitly, matching the software path. All four affected Auto workflows were rebuilt and repeated; their received streams were verified as Constrained Baseline.

The first AMD candidate used FFmpeg's generic `baseline` profile spelling. The packaged run caught that AMF requires `constrained_baseline`; both apps were corrected, rebuilt and rerun successfully. The failed attempts remain in the evidence. Early GUI automation attempts also exposed harness issues (Qt accessible labels vs selected values, popup selection, mnemonic-stripped tab labels and registry enumeration order); those were corrected and the final visible restart workflows passed.

No WAN loss/MTU guarantee, physical lip-sync qualification, demanding-game/thermal benchmark, clean-machine check, macOS/Linux qualification, HDR qualification, or software HEVC receiver qualification is claimed here. Audio RED/FEC support is unchanged. Independent recording quality budgets remain separate; no new perceptual quality score was measured for these app candidates.

## Reproduction and evidence

The research repo holds the complete measurements and the reusable observer/analyzer/UI harness:

- [Defaults review and measurements](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-18-app-defaults)
- [Updated HTML/PDF field guide](https://github.com/steveseguin/video-encoder-testing/tree/main/docs/streaming-settings)

Game uses `native-qt/e2e/external-output-packaged.js --defaults=true` with a private receiver matrix. Studio uses `native-qt/e2e/mixer-encoder-defaults-e2e.py` and the research `app_defaults_gui_review.py` wrapper to restore the full registry tree. The raw artifacts retain exact launcher commands, per-frame/receiver evidence, failures and CPU/GPU samples. Candidate SHA-256 hashes are recorded per case because the initial and corrected AMD builds differ. No GitHub Actions were invoked.
