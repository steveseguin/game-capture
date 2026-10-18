# Game Capture

A free, open-source app for streaming games, app windows, and webcams to **VDO.Ninja and OBS**. Native Qt, hardware encoding, window audio capture, and shareable viewer links.

**Windows is stable. macOS is available as an experimental Apple Silicon beta.**

## Downloads

| Platform | Download | Status |
| --- | --- | --- |
| **Windows 64-bit** | [Installer](https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-setup.exe) · [Portable](https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-portable.exe) · [ZIP](https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-win64.zip) | Stable / production |
| **macOS — Apple Silicon** | [Download Mac ZIP](https://github.com/steveseguin/game-capture/releases/download/macos-v0.2.64-beta.2/game-capture-macos-arm64-0.2.64-beta.2.zip) | **0.2.64 Beta 2 — Experimental** |

[Windows release notes](https://github.com/steveseguin/game-capture/releases/latest) · [Mac release notes, source & checksums](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.64-beta.2)

[![Game Capture on macOS with a demo window selected and Go Live controls](docs/macos-app-screenshot.png)](https://steveseguin.github.io/game-capture/macos-guide.html)

*macOS experimental beta shown.*

## Quick start

1. Download the version for your computer. On Mac, extract the ZIP and move **Game Capture.app** to Applications.
2. Open the app, select a window or camera, and choose audio if needed. Grant capture permissions when prompted.
3. Enter a stream ID or paste a VDO.Ninja URL, then click **Go Live**.
4. Share the generated viewer link or open it in OBS.

### Windows

The production version supports Windows hardware encoders, Spout2 sources, optional OBS transparency, and additional output destinations including WHIP, SRT, and RTMP. See the [Windows guide](docs/windows-guide.md) for audio, output settings, and troubleshooting.

### macOS beta

Apple Silicon (M-series) only, built for **macOS 14.2+**. Uses **Apple VideoToolbox** hardware H.264 or **x264** software H.264. The app is Developer ID signed and notarized. See the [Mac setup guide](https://steveseguin.github.io/game-capture/macos-guide.html) for installation, permissions, audio, and troubleshooting.

This is an early port with incomplete feature parity. Minimum-OS and clean-machine compatibility remain unverified; packaged workflows were tested on an M1 running macOS 26.4.1. See the [Mac testing status and open findings](docs/macos-beta2-validation-2026-10-17.md) before using it. [Unreleased candidate results](docs/macos-independent-receiver-2026-10-17.md) track ongoing improvements.

### Linux development

The Linux port targets Ubuntu 24.04 on x86-64 and is still under development. It uses the shared application core with Linux window, camera, audio and encoder backends. Local development DEBs and their exact workflow evidence are tracked in the [Linux parity ledger](native-qt/qa/linux-parity.json); there is no qualified Linux release yet. Hardware encoding, full output/recovery coverage, clean installation and Windows/macOS regression qualification remain open.

For application audio, choose **Selected window/app audio**. X11 can use the selected window's process automatically; on Wayland, choose a running **Audio app** explicitly. **Refresh audio apps** updates the list after an app starts playing sound. The selection covers that process and its children, and is cleared when Game Capture is relaunched. If the app closes, select its new instance before restarting the stream. The CLI equivalent is `--audio-source=selected-window --audio-process=<PID>`; omit `--audio-process` for automatic X11 selection. System audio and microphone/input selection remain separate choices.

For voice-chat output, choose **Communications output (selected device)** and select the output used by your voice-chat app. Configure that app to play through the same output; Game Capture shares all sound on that output. The choice is saved. If the output disappears, its capture stops without switching devices; refresh the output list and restart streaming to capture it again. The CLI equivalent is `--audio-source=communications-output --communications-output-device=pulse-output:<sink-name>`; `pactl list short sinks` lists output names. This explicit Linux selection replaces the Windows communications-device role.

For software video, leave **FFmpeg Path** and **FFmpeg Options** empty to use the native Linux encoder. VP9 and AV1 also support an external FFmpeg helper: enter a path, custom options, or both. Options alone use the distribution FFmpeg (`/usr/bin/ffmpeg` when installed). Explicit paths and environment overrides take precedence over that default. The CLI equivalents are `--ffmpeg-path=/path/to/ffmpeg` and `--ffmpeg-options="-threads 2"`. H.264 and HEVC use the native encoder; HEVC receiver compatibility is still unqualified.

Saved output destinations use your desktop's Secret Service password store, such as GNOME Keyring. Keep its default collection unlocked while editing destinations. URLs and credentials are stored together there; the settings file holds only a reference. If storage fails, a message appears beside the output settings and those changes remain session-only. Repair or unlock the store and restart Game Capture to restore saved profiles. **File → Reset to Defaults** also removes the saved destination entry. Linux builds require `libsecret-1-dev` in addition to the media dependencies.

## Help and development

- [Website](https://steveseguin.github.io/game-capture/gamecapture.html) · [Screenshots & demos](media-assets/README.md) · [Setup guide](https://docs.vdo.ninja/guides/using-game-capture-with-vdo.ninja)
- [Report an issue](https://github.com/steveseguin/game-capture/issues) — include your OS, source, encoder, and logs from **Help → Open Log Folder**. Remove credentials before sharing logs.
- [Local control API](docs/local-control-api.md) · [AI / MCP automation](docs/ai-control.md)
- [Build & validation guide](docs/developer-guide.md) · [Release playbook](docs/RELEASES.md) · [Local security guards](docs/development-security.md)
- [Contributing](CONTRIBUTING.md) — includes contributor license terms.

Free and open source under [AGPL-3.0](LICENSE).

Encoding: **[Illustrated settings guide: resolution, bitrate, WHIP and CPU/GPU costs](https://steveseguin.github.io/game-capture/encoder-guide/)** · [Default policy](docs/streaming-defaults.md).
