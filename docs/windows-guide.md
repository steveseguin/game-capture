# Windows user guide

Detailed setup and troubleshooting for the stable Windows app. For downloads and the experimental Mac version, see the [project README](../README.md).

## Quick Start

1. [Download the Windows installer](https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-setup.exe), or choose the portable version from the release page.
2. Launch Game Capture and pick a game window, camera/webcam, or Spout2 sender.
3. Enter a stream ID (or paste a full VDO.Ninja URL) and go live.
4. Open a generated viewer link in a browser or OBS. For transparent playback, follow the [alpha workflow](#alpha-workflow).

While streaming, capture/encoder settings are intentionally locked to prevent mid-stream drift between UI and runtime state. Stop first to change advanced settings.
Logs are available via `Help -> Open Log Folder` (`%LOCALAPPDATA%\GameCapture\logs`).

The footer shows the installed version and quietly checks GitHub for a newer stable
release about once a day. It shows **You're up to date** after a successful check,
or **New version available: vX.Y.Z** with a **Releases** link that opens the project's
release overview in your default browser. Prereleases and drafts are excluded.
Failed checks show **Update check unavailable**. Check attempts and release metadata
are remembered across restarts; checks send no settings, credentials, or media.
Updates are never downloaded or installed automatically.

## Camera / Webcam Sources

1. Set `Video Source` to `Camera / Webcam`.
2. Choose the camera, resolution, frame rate, and `Microphone / Input` device.
3. Paste a Stream ID or VDO.Ninja URL, then go live.

Camera mode starts with **No microphone**. Select an input in the main microphone dropdown to add it; **Mute / Unmute** works while live without silencing game/app audio. Returning to **No microphone** disables microphone capture on the next session. Explicit saved microphone choices are retained. Once live, `Selected Source Preview` shows the local camera feed seen by the publisher. Microphone inputs from 8–384 kHz, mono through multichannel, and 16/24/32-bit PCM or 32-bit float are converted to 48 kHz for mixing and Opus encoding. Advanced settings can switch to system output, disable audio, or mix the microphone with another audio source. Windows can list installed virtual cameras even when their sender is inactive; Game Capture waits for a real first frame and stops startup with an actionable error instead of publishing a blank source. The same bounded error path handles disconnected cameras and cameras already owned by another app. If a device is missing, enable desktop camera or microphone access in Windows Privacy & security settings and click Refresh.

**Show advanced settings → Audio encoding** expands the optional audio controls. Audio encoding starts collapsed each time the app opens. Fresh VDO.Ninja settings use **Opus, 48 kHz, stereo, 192 kbps**, with **RED packet-loss protection enabled**. Saved choices, including RED off, are retained. Encoding changes apply on the next stream, and the controls lock while live.

- **Opus bitrate:** 6–510 kbps across both channels, excluding network overhead. Very low bitrates severely reduce fidelity and stereo separation. An authorized director can temporarily override the bitrate; releasing that override restores your selection.
- **PCM (experimental):** uncompressed signed 16-bit audio, 48 kHz mono (768 kbps) or 32 kHz stereo (1,024 kbps), excluding overhead. Stereo is filtered and resampled from the 48 kHz mix to match VDO.Ninja's PCM viewer negotiation. Bitrate is fixed by the format. Use the generated viewer link in Chrome; receivers that select Opus receive an Opus fallback. Select Opus for Firefox: the PCM viewer link is not supported there. A remote bitrate override affects that fallback only.
- **RED (experimental, Opus only):** sends the preceding audio packet alongside the current packet when the receiver selects RED. This roughly doubles audio bandwidth and can recover isolated packet loss. It does not repair clipping, capture glitches, or long outages. Receivers that decline RED get plain Opus. PCM+RED is not enabled because the current VDO.Ninja PCM viewer path does not negotiate it.
- **Channels:** mono or stereo. Multichannel inputs still mix down; surround output is not currently offered.

For headless publishing, use `--audio-bitrate-kbps=128 --audio-channels=mono` (or `stereo`), or `--audio-codec=pcm`. VDO.Ninja Opus enables RED by default; `--no-audio-red` disables it and `--audio-red` explicitly enables it. Combining PCM or an external output with explicit `--audio-red` is rejected. External outputs do not enable RED automatically. GUI publishing uses saved settings.

Use the app's generated share link to preserve the selected channel mode in browser playback. Its `stereo` parameter configures the receiver; `ab=510` allows the receiver to accept the supported bitrate range, while the publisher sends at your selected bitrate. Older links may play stereo streams as mono.

## Additional output destinations

**Show advanced settings → Output** selects one destination. VDO.Ninja remains the default; other output settings appear only when selected. The active external destination stays visible when advanced settings are collapsed. Each protocol remembers its own settings, and Windows protects the saved destination profiles, including URLs and credentials, with the current user's encryption key.

| Output | Destination | Media |
| --- | --- | --- |
| VDO.Ninja | Existing stream ID / room workflow | Existing codec choices, including experimental PCM / RED |
| WHIP | Complete HTTP(S) publishing endpoint; optional bearer token | H.264 + 48 kHz Opus, mono or stereo |
| SRT | `srt://host:port`, optional stream ID and passphrase | H.264 + 48 kHz AAC in MPEG-TS; caller mode |
| RTMP / RTMPS | Server URL and optional stream key, or a complete publishing URL | H.264 + 48 kHz AAC in FLV |
| UDP / MPEG-TS (LAN) | `udp://receiver:5000` | H.264 + 48 kHz AAC in MPEG-TS; no server needed |
| RIST | `rist://receiver:8194` | H.264 + 48 kHz AAC in MPEG-TS; Main profile with packet recovery |
| RTSP / VRChat (TCP), RTSP (UDP) | RTSP publishing URL; TCP also accepts `rtspt://` | H.264 + 48 kHz AAC over RTP |

For VRChat, see the [RTSP publishing and viewing guide](rtsp-vrchat-output.md). A server is required; its viewing URL can differ from its publishing URL. RTSP uses the same bounded FFmpeg output path as RTMP/SRT, preserving capture timestamps and reconnecting with fresh media.

WHIP, SRT, RTMP and RTSP require a receiving endpoint/server; UDP and RIST can go directly to a listening receiver. They use H.264 without an alpha track; returning to VDO.Ninja restores your existing codec selections. Expand **Audio encoding** for Opus bitrate or AAC bitrate (32–320 kbps, default 192), and mono/stereo. AAC bitrate is displayed as a target. SRT latency defaults to 200 ms and can be adjusted from 20–8,000 ms. Higher latency gives SRT more time to recover lost packets. An optional SRT encryption passphrase needs 10–79 bytes.

RTMP/SRT use the bundled FFmpeg for audio encoding and output. Audio and video keep their capture timestamps through the output path. A lost connection retries automatically with fresh media and a keyframe; changing the encoded dimensions restarts an RTMP/SRT session. WHIP supports endpoint-provided ICE servers, bearer authentication, HTTP 307/308 redirects, complete ICE offers and session deletion on stop. Credentials are withheld from redirects to a different origin, and HTTPS cannot redirect to HTTP. HTTPS/RTMPS certificate validation remains enabled. Room controls and VDO.Ninja viewer links apply to VDO.Ninja output.

WHIP also exposes **ICE Mode** in advanced settings. **Relay Only** requires the endpoint to advertise a TURN server and prevents a direct publishing connection. Leave it on **Auto** for ordinary use. Recovery from an abrupt outage takes time: receivers that send regular feedback are monitored for a learned 15–60 second timeout; other receivers use normal ICE failure detection.

Headless examples (add your normal source, resolution and audio-source arguments):

```powershell
game-capture.exe --headless --output=whip --output-url=https://server.example/live/whip --output-token=TOKEN
game-capture.exe --headless --output=srt --output-url=srt://server.example:8890 --srt-stream-id=publish:my-stream --srt-latency-ms=200 --aac-bitrate-kbps=192
game-capture.exe --headless --output=rtmp --output-url=rtmps://server.example/live --output-key=STREAM_KEY --audio-channels=stereo
game-capture.exe --headless --output=rtsp --output-url=rtsp://server.example:8554/live --aac-bitrate-kbps=192
```

Use `--srt-passphrase=...` when the SRT receiver requires encryption. Command-line credentials can be visible in the local process command line; the GUI stores credentials in encrypted profiles. External outputs reject PCM, RED and non-H.264 CLI selections. Authentication or negotiation errors from WHIP stop headless publishing with exit code 3; transient network failures retry until stopped.

Playback delay and synchronization also depend on the receiving server and player. WHIP recovery uses receiver feedback when available, otherwise ICE failure detection; abrupt outages can take tens of seconds to recover. See the [packaged output validation report](external-output-validation-2026-10-10.md) and [release qualification](release-qualification-0.2.62-2026-10-10.md) for measurements and coverage limits.

For OBS, a native **Media Source** using your receiving server's RTSP playback URL is a tested option. Our OBS 32.2.2 browser source produced an audio discontinuity when returning from silence, including with audio generated directly inside OBS without Game Capture. The native media receiver passed the recorded audio checks. Browser-source A/V alignment may also need a measured OBS Render Delay filter; it does not fix the audio discontinuity. Measure your own receiver delay and synchronization before a live production.

## Spout2 / VTuber Sources

Game Capture can publish a local Spout2 sender from VTube Studio, Warudo, VSeeFace, VNyan, and other Windows avatar or graphics apps. This avoids capturing the app's controls and preserves transparent pixels for the alpha or chroma workflow.

1. Enable Spout or Spout2 output in the source app and keep it running.
2. In Game Capture, set `Video Source` to `Spout2 (avatar apps)`.
3. Select the sender, enter the VDO.Ninja stream or room details, and go live.
4. Use H.264 for normal video, `VP9 (OBS Alpha Preview)` for true transparency, or `Alpha Background -> Chroma background` for a hardware-encoded chroma-key feed.

Spout2 carries video only. Game Capture defaults Spout2 sources to no audio, so choose an output mix or microphone separately when needed. If the sender is missing, enable its Spout output and refresh the list. If it appears but renders black, configure Game Capture and the sender app to use the same GPU in Windows Graphics settings.

See the [Game Capture and Spout2 setup guide](https://docs.vdo.ninja/guides/using-game-capture-with-vdo.ninja) for the receiver choices and troubleshooting steps.

## Local Control

For same-user automation and local issue collection, the compiled app can expose an opt-in loopback JSON API with `--local-control`. It provides diagnostics, recent logs, source discovery, issue-report export, stop, and quit commands. See the [local control API reference](local-control-api.md).

An optional [MCP bridge for AI assistants](ai-control.md) adds structured launch, status, monitoring, source discovery, recovery, and firewall inspection tools. It works with the packaged app and avoids screen scraping for routine control and diagnosis.

The Windows installer adds an inbound UDP firewall rule for its installed executable. Portable copies do not add a rule; see [firewall verification](ai-control.md#windows-firewall) when diagnosing direct-connection problems.

## Logs and Crash Reports

- Runtime logs are written to `%LOCALAPPDATA%\GameCapture\logs\game-capture-debug.log`.
- On Windows, hard crashes write best-effort reports to `%LOCALAPPDATA%\GameCapture\crashes`.
- A crash report includes a small `.json` summary and a `.dmp` minidump. If startup or Go Live fails, attach the latest log and crash report when filing an issue.

## Alpha Workflow

- For transparent playback in OBS, choose `VP9 (OBS Alpha Preview)` and enable the alpha workflow.
- VP9 alpha requires `ffmpeg.exe` with libvpx/VP9 support. Windows releases include a pinned LGPL FFmpeg bundle under `ffmpeg/bin/ffmpeg.exe`; advanced users can override it with `--ffmpeg-path` or the FFmpeg Path setting.
- Transparent playback in OBS requires the [VDO.Ninja OBS plugin](https://github.com/steveseguin/ninja-obs-plugin) with `Use Native Receiver (Experimental)` enabled. OBS Browser Sources and normal browser viewers do not composite the alpha track.
- Compatible OBS VDO.Ninja native receivers automatically upgrade that stream to dual-track VP9 transparency.
- Browser viewers remain compatible, but they stay standard color video.
- For hardware encoding compatibility, leave VP9 alpha disabled and use `Alpha Background -> Chroma background`. Game Capture composites transparent Spout2/window pixels over the selected color before H.264/NVENC encode, so the receiver can chroma-key the feed.
- If you need the broadest viewer compatibility, leave alpha disabled.
- AV1 alpha-preserving encode remains experimental and is not the current OBS transparency path.

### Codec compatibility and performance

The OBS plugin v1.1.68 native receiver supports H.264 and VP9. HEVC/AV1 encoding availability does not imply that this receiver can play them. Hardware codec support depends on the GPU and driver; check the selected encoder and runtime log instead of assuming a hardware path is active.

Explicit NVENC/QSV can fall below 30 FPS at 4K on the reviewed host. Auto/H.264 passed 4K30 there, but that result is not a guarantee for other hardware. See the [encoder/settings review](obs-encoder-settings-validation-0.2.56-2026-09-07.md) for measured results and the [v0.2.60 packaged validation](release-0.2.60-windows-validation.md) for the latest release coverage.

VP9 alpha is CPU-encoded and software-heavy because Game Capture encodes both the color video and a second alpha video track. The default VP9 settings already use libvpx realtime mode with the fastest `-cpu-used 8` setting. If the encoder overloads, lower output resolution/FPS first; `1080p30` or `720p60` are safer starting points than `1080p60`. Advanced users can use `FFmpeg Options` to override output options; for example, `-g 30 -keyint_min 30` can reduce all-keyframe cost, but recovery after packet loss or late joins may be slower.

## Streaming defaults, direct receivers and microphones

New streaming sessions default to **4,000 kbps video**. The encoder ceiling follows the selected target instead of allowing an extra 4,000 kbps. Saved bitrate choices and explicit CLI/API overrides are retained. This is a video encoding target, not a total upload cap: audio, transport headers, retransmissions and extra VDO.Ninja viewers add traffic. Independent Studio recording keeps its separate quality settings. Higher streaming bitrates remain in advanced settings.

**UDP / MPEG-TS (LAN)** and **RIST** are under advanced Output settings. Both carry H.264 video and AAC audio using the bundled FFmpeg worker. They also accept `--output=udp` / `--output=rist` and `--output-url=...` in headless capture. Start a receiver first, for example:

```powershell
# Sender URL: udp://RECEIVER-IP:5000
ffplay -i "udp://0.0.0.0:5000?fifo_size=8192&overrun_nonfatal=1"
# Sender URL: rist://RECEIVER-IP:8194; use matching 200 ms buffers
ffplay -buffer_size 200 -i "rist://@0.0.0.0:8194"
```

OBS Media Source and VLC can receive the MPEG-TS UDP stream. UDP provides no loss recovery or delivery acknowledgement; a Live status means the sender is transmitting. RIST uses Main profile and a configurable recovery buffer (20–8,000 ms, 200 ms UI default). Match the receiving buffer to the sender. This RIST integration does not configure encryption; use a trusted link/VPN or choose SRT with a passphrase. See the [FFmpeg protocol documentation](https://ffmpeg.org/ffmpeg-protocols.html#rist) for receiver options. The receiving application can add startup buffering of its own.

Standalone capture starts with **No microphone**, including when switching to Camera. Choosing a microphone enables it; the adjacent **Mute / Unmute** button stays usable while live and preserves the selected gain. Muting gates microphone samples before primary/additional routing, so it covers microphone-only audio and a microphone mixed with game audio. It does not stop the device; choose **No microphone** before the next capture to avoid opening it. Microphone selection and mute state are saved. Studio mixer microphones remain explicit sources with their existing per-track Mute buttons; the standalone microphone controls are disabled for Mixer program.

**AMD AMF** explicitly uses FFmpeg's AMD encoder instead of requiring an AMD Media Foundation encoder registration. Its defaults select low-latency CBR, balanced quality and a single queued frame; H.264 disables B-frame reordering and forces true IDR keyframes at the requested GOP interval (at most one second in low-latency mode). The H.264 pipeline preserves AMD's live headers without injecting stale initialization headers that caused RTMP/RTSP/SRT reconnect loops. Settings follow [AMD's AMF guide](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/wiki/AMF-Encoder-Settings-and-Tuning-in-FFmpeg) and the [FFmpeg AMF implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/amfenc_h264.c). Explicit AMD selection fails visibly when unavailable. See the [Radeon 780M playback and profiling results](amd-streaming-validation-2026-10-14.md), including capture-cadence and packet-loss limits.

Process audio capture prefers the default output device's sample rate when Windows does not report a process-loopback format. Missing or invalid device information uses 48 kHz. Rates such as 22.05 kHz that require fractional frames in a 10 ms capture buffer also use 48 kHz, avoiding periodic silent buffers observed with Windows process capture. If Windows rejects another rate, capture retries once at 48 kHz with a fresh audio client. Native microphone formats keep their normal conversion path. Mixed/output audio remains 48 kHz; no Windows device setting is changed.

Software H.264 on Windows uses Media Foundation, rather than x264. Its default now favors low encoding complexity and uses at most four encoder workers (at most half the logical processors, minimum one). Native H.264 explicitly requests CBR with a one-second encoder buffer; hardware-specific FFmpeg encoders keep their low-latency settings. Encoder rate control is not a network pacer or a total upload limit.

Fresh window-capture settings use **1280x720 at 60 fps** with hardware-first Auto encoding. Camera capture retains its separate **1080p30** default; Desktop Studio's new-show canvas remains **720p30**. Higher resolutions/frame rates and custom bitrates remain under Advanced; saved selections are preserved, including previously saved 12 Mbps values. **Standard (4000 kbps)** is the new streaming default, with **Economy (2500 kbps)** retained for smaller upload budgets. Software encoding cannot guarantee spare CPU during a demanding game; 720p30 is the lighter manual option. Independent local recording and guest-return streams add their own encoding work.

In **Advanced → Resolution**, select 1440p, 4K or portrait presets, or type a custom size such as `3440x1440`. Width must be an even number from 160 to 3840; height must be even and from 90 to 2160. Valid custom sizes survive restart. Incomplete or invalid edits preserve the last valid saved size and cannot start a stream. Camera capture retains its separate device-mode selector.

Native WHIP publishing now uses negotiated video RTX/NACK/PLI, bounded repair history and paced video packets. Its repair bandwidth allowance replenishes continuously, avoiding one-second repair blackouts after reordered-packet bursts. Ordinary VDO.Ninja calls retain their existing transport policy. The local diagnostics API exposes negotiated recovery capabilities and retransmission/cache-miss counts. See [validation and receiver limitations](amd-streaming-validation-2026-10-14.md).

Packaged measurements, CPU contention results and remaining hardware limits: [encoding defaults validation](encoding-defaults-validation-2026-10-14.md).

Auto also tries AMD AMF before software when an AMD adapter is present but no usable hardware Media Foundation encoder is available. Select **AMD AMF** in Advanced to choose AMD specifically on a mixed-GPU system. See the [RX 9060 XT application and fallback validation](radeon-rx9060xt-validation-2026-10-16.md).
