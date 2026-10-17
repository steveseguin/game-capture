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

This is an early port with incomplete feature parity. Minimum-OS and clean-machine compatibility remain unverified; packaged workflows were tested on an M1 running macOS 26.4.1. See the [Mac testing status and open findings](docs/macos-beta2-validation-2026-10-17.md) before using it. [Unreleased candidate results](docs/macos-frame-timer-2026-10-17.md) track ongoing improvements.

## Help and development

- [Website](https://steveseguin.github.io/game-capture/gamecapture.html) · [Screenshots & demos](media-assets/README.md) · [Setup guide](https://docs.vdo.ninja/guides/using-game-capture-with-vdo.ninja)
- [Report an issue](https://github.com/steveseguin/game-capture/issues) — include your OS, source, encoder, and logs from **Help → Open Log Folder**. Remove credentials before sharing logs.
- [Local control API](docs/local-control-api.md) · [AI / MCP automation](docs/ai-control.md)
- [Build & validation guide](docs/developer-guide.md) · [Release playbook](docs/RELEASES.md) · [Local security guards](docs/development-security.md)
- [Contributing](CONTRIBUTING.md) — includes contributor license terms.

Free and open source under [AGPL-3.0](LICENSE).
