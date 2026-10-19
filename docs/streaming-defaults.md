# Streaming defaults

These first-run defaults ship in **Game Capture 0.2.65** and **Desktop Studio 0.9.3** for Windows. Existing saved choices remain unchanged; explicit CLI and advanced FFmpeg options take precedence.

| Setting | Game Capture | Desktop Studio |
|---|---|---|
| Window/program output | 1280 x 720, **60 fps** | 1280 x 720, **30 fps** |
| Video target / ceiling | **4,000 kbps** | **3,000 kbps** |
| Encoder | Auto: available hardware H.264, software fallback | Same |
| Native H.264 profile | Baseline, 8-bit 4:2:0 SDR | Same |
| B-frames / lookahead | 0 / disabled on the configured FFmpeg paths | Same |
| Keyframes | Approximately every second at the chosen frame rate | Same |
| Streaming audio | 48 kHz stereo; Opus 128 kbps for WebRTC, AAC 128 kbps for other network outputs | Same |
| Microphone | Off until selected | Off until selected |

Auto is vendor neutral. Explicit NVIDIA, AMD, Intel or software selections remain strict: a failed selection is reported, not replaced silently. Camera capture retains its separate 1080p30 preference. Hardware capability, driver behavior and the actual receiver still matter. H.264 remains the interoperable default; choosing AV1/HEVC/VP9 is an advanced, destination-dependent decision.

## Encoder policies

| Backend | Default policy |
|---|---|
| Windows Media Foundation H.264 | Baseline, CBR, low-latency mode, explicit request for zero B-frames; software complexity 0 and 1-4 workers, at most half the logical CPUs |
| FFmpeg NVIDIA | P4, low-latency tune, CBR, single pass, lookahead and adaptive quantization off; H.264 output queue delay 0 |
| FFmpeg AMD | Balanced quality, low-latency usage, CBR/HRD, async depth 1; H.264 zero B-frames, repeating headers and forced IDRs |
| FFmpeg Intel | Veryfast, async depth 1, zero B-frames; H.264 lookahead off; retain dynamic D3D11 upload to avoid the previously observed memory growth |
| User-supplied x264 | Veryfast + zerolatency, zero B-frames, 1-4 workers; filter workers 1 |
| User-supplied x265 | Veryfast + zerolatency, bounded worker pool, one frame thread, zero B-frames/lookahead |
| FFmpeg libaom AV1 | Realtime, cpu-used 8, no lag, row multithreading, 1-4 workers |
| libvpx VP9 | Existing realtime cpu-used 8, bounded workers, zero lag; all-keyframes by default. Protected dual-track alpha keeps its mandatory all-keyframe synchronization contract |

Worker caps limit parallelism, not total CPU use. Software AV1/HEVC and dual-track alpha can still be too expensive for a busy gaming PC. These options do not make unsupported codecs work with RTMP/WHIP destinations. On Windows, bundled FFmpeg remains LGPL; x264/x265 require a suitable user-supplied build. The Mac experimental package includes its native x264 backend. Driver controls may be unsupported; warnings and the actual negotiated/encoded stream are authoritative.

## macOS experimental defaults

The Apple Silicon **0.2.65 Beta 3** uses the same window defaults: **1280 x 720,
60 fps, 4,000 kbps**, H.264 and 128 kbps Opus. Camera capture retains its separate
**1920 x 1080 / 30 fps** preference and the selected video bitrate. Saved choices
are preserved; switching resolution does not change the bitrate automatically.

| Backend | Mac policy |
|---|---|
| Auto | Try Apple VideoToolbox hardware first, then x264 for H.264 |
| Apple VideoToolbox | Require actual hardware; Constrained Baseline H.264, real-time mode, no frame reordering, at most one-second keyframes in low-latency mode |
| x264 | Veryfast + zerolatency, Baseline H.264, zero B-frames, at most one-second keyframes, 1-4 workers capped at half the logical CPUs |

Explicit VideoToolbox and software selections remain strict. H.264 stays the
default; HEVC is an explicit hardware/destination-dependent choice. The native
VT path uses [**AverageBitRate**](https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_averagebitrate), including live bitrate updates. Beta 3 also sets H.264
[**DataRateLimits**](https://developer.apple.com/documentation/videotoolbox/kvtcompressionpropertykey_dataratelimits)
to half a second at 1.5 times the requested bitrate. This limits short encoder
bursts while allowing simple scenes to use less bandwidth. The 4,000 kbps
setting remains an average target, **not a hard total-network bandwidth ceiling**. Native x264 uses ABR with
VBV maxrate and a half-second buffer. Neither is the identical rate-control setup
used by the standalone OBS/FFmpeg quality measurements.

The October 18 upstream review found the shared resolution/bitrate policy and
Mac keyframe/worker alignment already present. A subsequent native-app comparison
reproduced a Beta 2 WHIP reconnect when a still image changed to complex motion.
The Beta 3 bounded-average candidate completed all six full 60-second reference
runs and live bitrate-control/GUI receiver workflows without that failure. A
constant-bitrate alternative also passed, with slightly higher synthetic quality
scores but larger short bursts and more bandwidth on simple scenes. A tighter
average limit underused the requested bitrate. These observations support the
bounded-average change while retaining VT first and the existing defaults.

The [native comparison and limits](macos-0265-beta3-validation-2026-10-18.md)
cover this change. The earlier
[OBS quality comparison](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-18-apple-m1-obs-h264)
uses High profile, CBR and a different source/color pipeline; its scores are not
a direct ranking against native Game Capture. Native pixel conversion and color
metadata remain paired and unchanged. Mac remains experimental, with qualification
separate from the Windows release.

Six actual released-app GUI launches also verified fresh defaults, persistence of
explicit software/VideoToolbox/Auto choices, and Beta 1-to-Beta 2 preferences
migration. The initial failed foreground-activation attempt remains recorded;
the accepted PID-scoped preference workflow does not qualify activation or add
new live-media coverage. [Review evidence and retained attempt](https://github.com/steveseguin/video-encoder-testing/tree/main/knowledge/2026-10-18-apple-m1-beta2-defaults-review).

## Resolution and bandwidth choices

The bitrate selector stays explicit: changing resolution does **not** silently increase upload bandwidth. Portrait and landscape with the same pixel count use the same starting budget.

| Output | Suggested H.264 video target | Use |
|---|---:|---|
| 960 x 540 / 30 | 1,500-2,000 kbps | Weak upload or low-power machine |
| 960 x 540 / 60 | 2,500 kbps | Keep motion smooth with fewer pixels |
| 1280 x 720 or 720 x 1280 / 30 | 3,000 kbps | Studio/talking/interview default |
| 1280 x 720 or 720 x 1280 / 60 | 4,000 kbps | Gaming default |
| 1920 x 1080 or 1080 x 1920 / 30 | 4,500 kbps | More detail, when the receiver preserves it |
| 1920 x 1080 or 1080 x 1920 / 60 | 6,000 kbps | Hardware encode and sufficient sustained upload |

These higher-resolution values are recommendations, not claims that every game/receiver has been qualified. Audio, encryption, retransmissions, guest returns and additional viewers add traffic. A native peer-to-peer feed can require another upload per viewer. If the game or encoder falls behind, reduce resolution/frame rate before selecting a slower preset. Keep software users able to select 720p30 or 540p; do not silently override an explicit 60 fps choice.

## Packetization and recovery

- WebRTC/WHIP: **1,200-byte maximum codec fragment**, not a 1,200-byte IP packet. RTP extensions, RTX, SRTP, UDP and IP add overhead. This leaves more headroom than the library's previous 1,220-byte fragment default; it is not a universal WAN MTU guarantee.
- MPEG-TS over SRT/UDP/RIST: retain **1,316-byte** packet payloads. RTSP retains **1,200-byte** muxer packet size; RTSP uses TCP unless UDP is explicitly selected. RTMP has no analogous UDP MTU setting.
- SRT/RIST: **200 ms** initial recovery buffer. Increase for high RTT or burst loss. The Studio API now agrees with the GUI/core default.
- WHIP: retain **1,500 ms sender repair history** and the existing **500 ms playback smoothing hint**. A receiver may ignore this hint. Studio exposes advanced overrides, including 0 for receiver-selected timing.
- NACK/RTX/PLI follow negotiated support. Audio RED is offered where implemented, with negotiation fallback. No new Opus in-band FEC or video FEC is claimed. Larger history cannot add receiver support that was not negotiated.
- Avoid B-frames in these live paths: elementary encoder output is matched to input timestamps in order. Advanced overrides need receiver and timestamp validation.

## Recording and operating systems

Desktop Studio's independent recording keeps **12 Mbps**, or **24 Mbps for 1080-class 60 fps**, and **192 kbps AAC**. It does not inherit the reduced upload budget. Guest-return video stays 30 fps / 2.5 Mbps, with its maximum now equal to that target rather than 4 Mbps.

The Windows release and experimental Mac package have separate qualification. The Mac policy above applies to its native VT/x264 backends; Windows FFmpeg and hardware controls do not automatically apply to them. There is no new Linux support claim. For OBS/FFmpeg on other systems, use the [research field guide](https://github.com/steveseguin/video-encoder-testing/tree/main/docs/streaming-settings), with hardware availability and endpoint validation.

Validation and limitations for this change: [packaged defaults review](defaults-validation-2026-10-18.md).

Final signed Windows 0.2.65 qualification: [release validation](release-0.2.65-windows-validation.md).
