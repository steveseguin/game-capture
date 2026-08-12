# Game Capture (Windows)

Game Capture is a native Windows app for publishing gameplay to VDO.Ninja with low friction and production-friendly defaults.

## Why Teams Use It

- Window audio capture without virtual audio cables.
- Camera/webcam video with selectable microphone or other Windows input devices.
- Hardware-accelerated encoding and bitrate presets for game feeds.
- Dual-stream routing (HQ/LQ) for room roles and monitor paths.
- Multiple viewers from a single HD encode workflow.
- Native app (no Electron), lower memory footprint.
- Simple OBS alternative for guest-side feed publishing.
- VDO.Ninja-compatible links and room workflows.

## Quick Start

1. Download the installer from the latest release.
2. Launch Game Capture and pick a game window, camera/webcam, or Spout2 sender.
3. Enter a stream ID (or paste a full VDO.Ninja URL) and go live.
4. Use the generated view links in OBS.

While streaming, capture/encoder settings are intentionally locked to prevent mid-stream drift between UI and runtime state. Stop first to change advanced settings.
Logs are available via `Help -> Open Log Folder` (`%LOCALAPPDATA%\GameCapture\logs`).

## Camera / Webcam Sources

1. Set `Video Source` to `Camera / Webcam`.
2. Choose the camera, resolution, frame rate, and `Microphone / Input` device.
3. Paste a Stream ID or VDO.Ninja URL, then go live.

Camera mode selects the chosen microphone/input as the primary audio source by default. Once live, `Selected Source Preview` shows the local camera feed seen by the publisher. Microphone inputs from 8–384 kHz, mono through multichannel, and 16/24/32-bit PCM or 32-bit float are converted to the 48 kHz stereo format used for WebRTC. Advanced settings can switch to system output, disable audio, or mix the microphone with another audio source. Windows can list installed virtual cameras even when their sender is inactive; Game Capture waits for a real first frame and stops startup with an actionable error instead of publishing a blank source. The same bounded error path handles disconnected cameras and cameras already owned by another app. If a device is missing, enable desktop camera or microphone access in Windows Privacy & security settings and click Refresh.

## Spout2 / VTuber Sources

Game Capture can publish a local Spout2 sender from VTube Studio, Warudo, VSeeFace, VNyan, and other Windows avatar or graphics apps. This avoids capturing the app's controls and preserves transparent pixels for the alpha or chroma workflow.

1. Enable Spout or Spout2 output in the source app and keep it running.
2. In Game Capture, set `Video Source` to `Spout2 (avatar apps)`.
3. Select the sender, enter the VDO.Ninja stream or room details, and go live.
4. Use H.264 for normal video, `VP9 (OBS Alpha Preview)` for true transparency, or `Alpha Background -> Chroma background` for a hardware-encoded chroma-key feed.

Spout2 carries video only. Game Capture defaults Spout2 sources to no audio, so choose an output mix or microphone separately when needed. If the sender is missing, enable its Spout output and refresh the list. If it appears but renders black, configure Game Capture and the sender app to use the same GPU in Windows Graphics settings.

See the [Game Capture and Spout2 setup guide](https://docs.vdo.ninja/guides/using-game-capture-with-vdo.ninja) for the receiver choices and troubleshooting steps.

## Local Control

For same-user automation and local issue collection, the compiled app can expose an opt-in loopback JSON API with `--local-control`. It provides diagnostics, recent logs, source discovery, issue-report export, stop, and quit commands. See `docs/local-control-api.md`.

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

### NVIDIA AV1 Compatibility

On the tested machine, the installed NVIDIA driver exposes NVENC API 12.2, while the bundled FFmpeg AV1 encoder requires NVENC API 13.0 and reports NVIDIA driver 570.0 or newer as the minimum. Game Capture therefore falls back to software AV1 encoding on this configuration. H.264 hardware encoding works reliably; select H.264 or update the NVIDIA driver if AV1 falls back to software.

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

Packaged signaling and interoperability workflows:

```powershell
cd native-qt
npm run e2e:signaling-regressions
npm run e2e:control-center:edge
npm run e2e:control-center:firefox
npm run e2e:ninja-plugin-alpha
```

The signaling regression workflow runs a staged `dist/game-capture-*-win64/game-capture.exe`
against a local VDO-compatible WebSocket server and a real Edge/Firefox WebRTC peer. It covers
initial-offer timing, duplicate offer requests, stale answers, data-channel setup, stable first-offer
VP9 alpha reservation and capability activation, and failed-peer ICE restart recovery. The Control Center workflows use the real
VDO.Ninja director page. The ninja-plugin alpha workflow uses packaged Game Capture, a synthetic
Spout RGBA sender, portable OBS, and pixel-level transparency validation.
The signaling command resolves the package matching the version in `CMakeLists.txt`, verifies its
release manifest, and binds the single built `spout_test_sender.exe`. If more than one build contains
that fixture, pass `-- --build-dir=<directory>` to select it explicitly.
The Firefox Control Center workflow selects VP9 and disables the H.264-only room LQ tier because
Playwright's Firefox runtime does not expose platform H.264; the Edge workflow covers default H.264.

## Releases

Use `docs/RELEASES.md` for the exact release checklist, including fixed asset names, signing commands, VirusTotal commands, and troubleshooting.

## Contributing

Read `CONTRIBUTING.md` before opening PRs. Contributor terms include CLA/license grant requirements for this repository.

## Repository Scope

This repo is focused on the native Windows app (`native-qt`) and supporting release/docs flow.

## License

Free and open source (AGPL-3.0). See `LICENSE`.
