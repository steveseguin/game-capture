# Building and validating Game Capture

These commands cover Windows development and packaged application workflows. For the Mac beta, use the matching source archive and build instructions on the [Mac 0.2.64 Beta 2 release page](https://github.com/steveseguin/game-capture/releases/tag/macos-v0.2.64-beta.2), plus the [Mac guide](macos-guide.html). Read [CONTRIBUTING.md](../CONTRIBUTING.md) before contributing.

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

## Hosted Windows build gate

The Mac integration branch includes an isolated [Windows Build Gate](https://github.com/steveseguin/game-capture/blob/macos-main-integration/.github/workflows/windows-build-gate.yml). Relevant source changes on that branch trigger a GitHub-hosted Windows 2022 job with pinned Qt 6.9.3 and two build workers. It compiles the application, verifies the selected Windows backend files and NVENC/Graphics Capture/Spout definitions, and runs the compiled platform-capability gate. Logs, dependency revisions, compilation commands and the executable hash are retained for seven days; no release binary is published.

[Run 39061206387](https://github.com/steveseguin/game-capture/actions/runs/39061206387) passed on source `be0dfea6b60f2e00c3bd1a431432440375d7304c`, using MSVC 14.44.35207, Windows SDK 10.0.26100.0 and Qt 6.9.3. All 28 application compilation units linked, the six expected Windows backend files were selected, and no Mac implementation entered the compilation graph. One platform-capability gate executed and passed; missing registration fails the job.

These are build and unit gates. Packaged Windows application testing—including real capture, hardware encoders, delivered media, controls and recovery—remains required before merging the wider Mac port or changing the stable Windows release. The prepared self-hosted workflow below remains the route for those application workflows.

## Testing

Primary QA plans and gates live in `native-qt/qa/`.

Release readiness also runs the packaged Windows desktop workflow, checking
unwanted sound requests, source selection/removal, FFmpeg failure responsiveness,
local diagnostics, H.264/VP9 GUI streaming with browser playback, and tray reminders.
It requires Node.js/Playwright and installed Google Chrome, an interactive Windows desktop,
and 64-bit Python 3 with Tk support. Its runner installs pinned observer dependencies
into `native-qt/.cache/desktop-ui-python` on first use. Close existing Game Capture
sessions before running it; the workflow restores application preferences afterward.

Audio encoding playback can be checked with `native-qt/e2e/audio-settings-packaged-e2e.js`
against a complete package and `spout_test_sender.exe`; `--only=boundaries` exercises
the bitrate limits and `--only=simultaneous` verifies experimental and Opus fallback
receivers connected to the same publisher. `audio-settings-desktop-e2e.py` covers saved preferences, collapsed
controls, restart, and actual Chrome playback, with `--codec=pcm` or `--red`.
For decoded audio, delay, frame counters, reconnects, and sustained resource measurements:

```powershell
node native-qt/e2e/audio-quality-packaged-e2e.js --publisher=C:\path\to\packaged\game-capture.exe --output=native-qt/qa/reports/audio-quality --cases=opus,pcm,red --soak-seconds=600 --cycles=10 --gpu=true --reconnect=true
python native-qt/e2e/audio-quality-analyze.py native-qt/qa/reports/audio-quality
```

Run capture workflows sequentially: competing fixtures can contaminate audio and
performance measurements. The analyzer requires NumPy/SciPy and writes decoded WAV
files plus waveform and memory measurements. Its independent Web Audio track timing
does not establish HTML video lip sync or physical speaker/display latency.
Use `--record=true` for a separate recorded-frame identity check; recording adds load
and should be kept separate from performance comparisons.
The desktop workflow's optional `--record-system-audio` records Windows output
during UI actions and requires SoundCard and NumPy in its Python environment.
For repeated GUI starts/stops, use `quality-gui-cycles.py --publisher=... --output=...`
with `--mode=opus --cycles=24 --idle-seconds=120`; add `--baseline` for a published
package without the audio controls. `analyze-gui-cycles.py` summarizes the resulting
resource measurements and captured synchronization signaling. These GUI runs attach
sound observers, whose overhead must be considered when assessing memory retention.

See the [packaged audio/video quality report](audio-quality-validation-2026-10-10.md)
for measured results, screenshots, and remaining compatibility and performance limits.

The desktop workflow can also exercise Windows 10's missing optional borderless
capture interface in the real app. Frame capture, H.264/VP9 encoding, and browser
playback still run normally:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\e2e\run-desktop-ui-e2e.ps1 `
  -PublisherPath C:\path\to\packaged\game-capture.exe `
  -ProbeHelperPath .\native-qt\build-review2\bin\ffmpeg_probe_hang_helper.exe `
  -DenyBorderlessInterface
```

On Windows 11, use `-ObserveCaptureCompatibility` instead to verify the supported
borderless API path. Fault injection covers the missing-interface condition; it
does not replace execution on a Windows 10 host.

Fast gate:

```powershell
$firefox = (Resolve-Path (Join-Path $env:ProgramFiles "Mozilla Firefox\firefox.exe")).Path
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-fast-gate.ps1 -BuildDir build-review2 -Configuration Release -FirefoxPath $firefox
```

Release readiness:

```powershell
$package = (Resolve-Path .\native-qt\dist\game-capture-0.2.64-win64).Path
$publisher = Join-Path $package "game-capture.exe"
$manifest = Join-Path $package "release-artifact-manifest.json"
$manifestSha256 = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
$firefox = (Resolve-Path (Join-Path $env:ProgramFiles "Mozilla Firefox\firefox.exe")).Path
$pluginRepo = (Resolve-Path ..\ninja-plugin).Path
$spoutSender = (Resolve-Path .\native-qt\build-review2\bin\spout_test_sender.exe).Path
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\qa\run-release-readiness.ps1 `
  -BuildDir build-review2 -Configuration Release -PublisherPath $publisher `
  -ArtifactManifestPath $manifest -ArtifactManifestSha256 $manifestSha256 -FirefoxPath $firefox `
  -RoomAlphaPluginRepo $pluginRepo -RoomAlphaPublisherPath $publisher -RoomAlphaSpoutSenderPath $spoutSender
```

The transparency workflows require the sibling `ninja-plugin` checkout's staged
plugin and portable OBS. They use the same signed package as the other workflows.

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

Use the [release playbook](RELEASES.md) for the exact release checklist, including fixed asset names, signing commands, VirusTotal commands, and troubleshooting.

## Developer security and QA cost controls

[Install the local commit/push secret guards](development-security.md) in each clone.
GitHub QA workflows are manual-only on self-hosted Windows runners, with optional
one-day artifact uploads. Routine changes do not start hosted QA jobs or nightly soaks.
