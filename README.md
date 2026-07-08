# Game Capture (Windows)

Game Capture is a native Windows app for publishing gameplay to VDO.Ninja with low friction and production-friendly defaults.

## Why Teams Use It

- Window audio capture without virtual audio cables.
- Hardware-accelerated encoding and bitrate presets for game feeds.
- Dual-stream routing (HQ/LQ) for room roles and monitor paths.
- Multiple viewers from a single HD encode workflow.
- Native app (no Electron), lower memory footprint.
- Simple OBS alternative for guest-side feed publishing.
- VDO.Ninja-compatible links and room workflows.

## Quick Start

1. Download the installer from the latest release.
2. Launch Game Capture and pick your game window.
3. Enter a stream ID (or paste a full VDO.Ninja URL) and go live.
4. Use the generated view links in OBS.

While streaming, capture/encoder settings are intentionally locked to prevent mid-stream drift between UI and runtime state. Stop first to change advanced settings.
Logs are available via `Help -> Open Log Folder` (`%LOCALAPPDATA%\GameCapture\logs`).

## Local Control

For same-user automation and local issue collection, the compiled app can expose an opt-in loopback JSON API with `--local-control`. It provides diagnostics, recent logs, source discovery, issue-report export, stop, and quit commands. See `docs/local-control-api.md`.

## Logs and Crash Reports

- Runtime logs are written to `%LOCALAPPDATA%\GameCapture\logs\game-capture-debug.log`.
- On Windows, hard crashes write best-effort reports to `%LOCALAPPDATA%\GameCapture\crashes`.
- A crash report includes a small `.json` summary and a `.dmp` minidump. If startup or Go Live fails, attach the latest log and crash report when filing an issue.

## Alpha Workflow

- For transparent playback in OBS, choose `VP9 (OBS Alpha Preview)` and enable the alpha workflow.
- VP9 alpha requires `ffmpeg.exe` with libvpx/VP9 support. Windows releases include a pinned LGPL FFmpeg bundle under `ffmpeg/bin/ffmpeg.exe`; advanced users can override it with `--ffmpeg-path` or the FFmpeg Path setting.
- Transparent playback in OBS requires the [VDO.Ninja OBS plugin](https://github.com/steveseguin/ninja-obs-plugin) with its native receiver path enabled. OBS Browser Sources and normal browser viewers do not composite the alpha track.
- Compatible OBS VDO.Ninja native receivers automatically upgrade that stream to dual-track VP9 transparency.
- Browser viewers remain compatible, but they stay standard color video.
- For hardware encoding compatibility, leave VP9 alpha disabled and use `Alpha Background -> Chroma background`. Game Capture composites transparent Spout2/window pixels over the selected color before H.264/NVENC encode, so the receiver can chroma-key the feed.
- If you need the broadest viewer compatibility, leave alpha disabled.
- AV1 alpha-preserving encode remains experimental and is not the current OBS transparency path.

VP9 alpha is CPU-encoded and software-heavy because Game Capture encodes both the color video and a second alpha video track. The default VP9 settings already use libvpx realtime mode with the fastest `-cpu-used 8` setting. If the encoder overloads, lower output resolution/FPS first; `1080p30` or `720p60` are safer starting points than `1080p60`. Advanced users can use `FFmpeg Options` to override output options; for example, `-g 30 -keyint_min 30` can reduce all-keyframe cost, but recovery after packet loss or late joins may be slower.

Web landing/download page:
- `docs/gamecapture.html`

## Downloads

Latest release:
- https://github.com/steveseguin/game-capture/releases/latest

Stable direct-download asset names (safe for website links):
- `game-capture-setup.exe`
- `game-capture-portable.exe`
- `game-capture-win64.zip`

Versioned assets are also published each release:
- `game-capture-<version>-setup.exe`
- `game-capture-<version>-portable.exe`
- `game-capture-<version>-win64.zip`

## Build (Windows)

Prerequisites:
- Visual Studio 2022 (C++)
- CMake 3.24+
- Qt6

```powershell
cd native-qt
mkdir build
cd build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
ninja
```

## Testing

Primary QA plans and gates live in `native-qt/qa/`.

Fast gate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-fast-gate.ps1 -BuildDir build-review2 -Configuration Release
```

Release readiness:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-release-readiness.ps1 -BuildDir build-review2 -Configuration Release
```

## Releases

Use `docs/RELEASES.md` for the exact release checklist, including fixed asset names, signing commands, VirusTotal commands, and troubleshooting.

## Contributing

Read `CONTRIBUTING.md` before opening PRs. Contributor terms include CLA/license grant requirements for this repository.

## Repository Scope

This repo is focused on the native Windows app (`native-qt`) and supporting release/docs flow.

## License

Free and open source (AGPL-3.0). See `LICENSE`.
