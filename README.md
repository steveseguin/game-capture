# Game Capture (Windows)

Game Capture is a free, open-source Windows app for streaming games, app windows, webcams, and Spout2 video to VDO.Ninja and OBS. It supports hardware encoding, window audio capture, and optional transparency through the OBS native receiver.

[Download for Windows](https://github.com/steveseguin/game-capture/releases/latest) | [Website](https://steveseguin.github.io/game-capture/gamecapture.html) | [Setup guide](https://docs.vdo.ninja/guides/using-game-capture-with-vdo.ninja) | [Report an issue](https://github.com/steveseguin/game-capture/issues)

## Why Teams Use It

- Window audio capture without virtual audio cables.
- Camera/webcam video with selectable microphone or other Windows input devices.
- Hardware-accelerated encoding and bitrate presets for game feeds.
- Dual-stream routing (HQ/LQ) for room roles and monitor paths.
- Multiple viewers from a single HD encode workflow.
- Native Qt app without an Electron runtime.
- Simple OBS alternative for guest-side feed publishing.
- VDO.Ninja-compatible links and room workflows.

## Quick Start

1. [Download the Windows installer](https://github.com/steveseguin/game-capture/releases/latest/download/game-capture-setup.exe), or choose the portable version from the release page.
2. Launch Game Capture and pick a game window, camera/webcam, or Spout2 sender.
3. Enter a stream ID (or paste a full VDO.Ninja URL) and go live.
4. Open a generated viewer link in a browser or OBS. For transparent playback, follow the [alpha workflow](#alpha-workflow).

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

For same-user automation and local issue collection, the compiled app can expose an opt-in loopback JSON API with `--local-control`. It provides diagnostics, recent logs, source discovery, issue-report export, stop, and quit commands. See the [local control API reference](docs/local-control-api.md).

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

Explicit NVENC/QSV can fall below 30 FPS at 4K on the reviewed host. Auto/H.264 passed 4K30 there, but that result is not a guarantee for other hardware. See the [encoder/settings review](docs/obs-encoder-settings-validation-0.2.56-2026-09-07.md) for measured results and the [v0.2.57 packaged validation](docs/release-0.2.57-windows-validation.md) for the latest release coverage.

VP9 alpha is CPU-encoded and software-heavy because Game Capture encodes both the color video and a second alpha video track. The default VP9 settings already use libvpx realtime mode with the fastest `-cpu-used 8` setting. If the encoder overloads, lower output resolution/FPS first; `1080p30` or `720p60` are safer starting points than `1080p60`. Advanced users can use `FFmpeg Options` to override output options; for example, `-g 30 -keyint_min 30` can reduce all-keyframe cost, but recovery after packet loss or late joins may be slower.

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
$firefox = (Resolve-Path (Join-Path $env:ProgramFiles "Mozilla Firefox\firefox.exe")).Path
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-fast-gate.ps1 -BuildDir build-review2 -Configuration Release -FirefoxPath $firefox
```

Release readiness:

```powershell
$package = (Resolve-Path .\native-qt\dist\game-capture-0.2.57-win64).Path
$publisher = Join-Path $package "game-capture.exe"
$manifest = Join-Path $package "release-artifact-manifest.json"
$manifestSha256 = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
$firefox = (Resolve-Path (Join-Path $env:ProgramFiles "Mozilla Firefox\firefox.exe")).Path
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-release-readiness.ps1 `
  -BuildDir build-review2 -Configuration Release -PublisherPath $publisher `
  -ArtifactManifestPath $manifest -ArtifactManifestSha256 $manifestSha256 -FirefoxPath $firefox
```

Packaged signaling and interoperability workflows:

```powershell
cd native-qt
npm run e2e:signaling-regressions
npm run e2e:signaling-regressions:negotiation:edge
npm run e2e:signaling-regressions:lifecycle:edge
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
The signaling and Control Center commands resolve the package matching the version in `CMakeLists.txt`, verify its
release manifest, and bind `spout_test_sender.exe` from the build directory recorded in that
manifest. Pass `-- --build-dir=<directory>` only to override that binding explicitly.
The named Edge negotiation and lifecycle commands are host-contained subsets that pin the scenario
in the npm script; use them when external TURN-registry coverage is not intended.
The Firefox Control Center workflow selects VP9 and disables the H.264-only room LQ tier because
Playwright's Firefox runtime does not expose platform H.264; the Edge workflow covers default H.264.

## Releases

Use the [release playbook](docs/RELEASES.md) for the exact release checklist, including fixed asset names, signing commands, VirusTotal commands, and troubleshooting.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening PRs. Contributor terms include CLA/license grant requirements for this repository.

## Repository Scope

This repo is focused on the native Windows app (`native-qt`) and supporting release/docs flow.

## License

Free and open source (AGPL-3.0). See [LICENSE](LICENSE).
