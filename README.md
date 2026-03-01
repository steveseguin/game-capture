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
