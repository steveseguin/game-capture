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

[Run 39064131632](https://github.com/steveseguin/game-capture/actions/runs/39064131632) passed on source `2a5e9a0914315912a73dc87a15791a7a1dc47f40`, using MSVC 14.44.35207, Windows SDK 10.0.26100.0 and Qt 6.9.3. All 28 application compilation units linked, the six expected Windows backend files were selected, and no Mac implementation entered the compilation graph. One platform-capability gate executed and passed; missing registration fails the job.

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
controls, restart, and actual Chrome playback, with `--codec=pcm` or `--red`. `six-channel-desktop-e2e.py` covers the
experimental six-channel selection: PCM and RED lock-out, restart persistence, and a live `stereo=4` share link
(`--no-live` skips the hosted stream).
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
$package = (Resolve-Path .\native-qt\dist\game-capture-0.2.65-win64).Path
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

## Browser alpha transport

`--browser-alpha` selects H.264 side-by-side packing (`[straight RGB | grayscale alpha]`), separate from `--alpha-workflow` and its native VP9 mask. EncoderConfig dimensions stay logical; VideoEncoder doubles only the backend width and packs each HQ/LQ input independently. The preview keeps the original BGRA. The initial coded envelope is 3840x1080 at 60 fps (1920x1080 visible), advertised as H.264 Level 5.1 so later size/HQ/LQ changes stay within the offer. The level selector uses rounded macroblock dimensions and frame rate from H.264 Annex A instead of a pixel-count shortcut. Custom FFmpeg options are rejected so they cannot change the layout or color conversion.

This offer describes the sender's envelope, not a guarantee of receiver performance. Chrome and Firefox can answer with Level 3.1 even while decoding these larger frames; this integration leaves browser answers unchanged and does not implement automatic downscaling from their declared level. Qualify the actual decoder at the desired output size/rate. The WebGL renderer checks the decoded frame against `MAX_TEXTURE_SIZE` and `MAX_VIEWPORT_DIMS`, rather than imposing a 720p ceiling. Older Chromium and mobile Safari require separate runtime qualification.

For local playback, serve the modified VDO.Ninja checkout on localhost. In Game Capture's generated viewer link, replace `https://vdo.ninja/` with the local frontend address, preserve the query parameters, and append `&salt=vdo.ninja` when using Game Capture's default signaling salt. The public frontend must also be updated before its normal share links can reconstruct browser alpha.

The canonical extension is documented in VDO.Ninja's `examples/packed-alpha.md`. The sender announces top-level `{alpha_send:"packed-sbs-v1",alpha_mid:"<negotiated MID>"}` over the existing data channel. After binding that MID's receiver track, preparing WebGL and mounting its output, VDO.Ninja acknowledges top-level `{alpha_receive:"packed-sbs-v1",alpha_mid:"<negotiated MID>"}`. Preparation failure or withdrawal uses `alpha_receive:""` with the same MID; this stops packed video and never permits ordinary frames on that track. Neither command uses `info` or `miniInfo`. Both HQ and LQ dispatch require acknowledgment of the current client transport generation and start with a keyframe. Replacement transports clear acknowledgment. This does not add an SDP attribute or another transceiver.

The existing connection health panel and diagnostics (`metrics.packed_alpha_waiting_peers`) count connected video-requesting peers with an open data channel but no readiness acknowledgment after five seconds. This derives from existing peer state; it adds no signaling messages or timers and is disabled for ordinary video. Muted/video-off routes are excluded, and readiness or disconnect clears the warning.

The layout is immutable for a connection. Source changes must continue packing, including opaque sources. A packed/ordinary change requires stopping capture and going offline first. `replaceTrack` does not identify a pixel-format change to the receiver; neither MID nor track ID can detect a sender silently changing this contract. VDO.Ninja owns renderer state separately from replaceable `stats.info`, checks the selected receiver track before drawing, and releases its canvas on track replacement or teardown. Partial info updates and alternate screen-stream messages do not reset it. Audio track changes do not recreate the renderer; video removal or mute withdraws readiness until playback is prepared again. The mask uses the same video-range conversion as RGB; WebGL samples the decoded grayscale and premultiplies the output once.

Packing preserves timestamps and the existing shared audio/video clock, CNAME and MediaStream identity. Audio remains on the source video element; only the picture is drawn through WebGL. The browser controls WebRTC playout synchronization, but the extra canvas presentation step can add visual latency. Qualify sync using simultaneous source/receiver recordings, including audio capture interruptions; packet counters alone do not establish lip sync. Ordinary streams retain their existing H.264 level selection and do not create a packed-alpha renderer.

`PackedAlphaGate` checks layout, stride, transparent padding, filtering and input bounds. It is a gate, not application testing. End-to-end qualification requires packaged Game Capture, a Spout source, and real browser/OBS playback, including reload, unsupported viewers, source replacement and connection replacement. Keep VDO.Ninja development fixtures and evidence outside its release checkout.

Run the packaged browser-alpha workflow from `native-qt`:

```powershell
npm run e2e:browser-alpha -- --publisher=<package>/game-capture.exe --sender=build-review2/bin/spout_test_sender.exe --output=qa/reports/browser-alpha
```

It uses the deployed `https://vdo.ninja/alpha/` frontend by default; override it with `--frontend=<URL>`. This changes only the QA viewer URL. Generated application links stay on the normal production site, which must receive the packed-alpha frontend update before deployment. The workflow checks opaque, half-transparent, checkerboard and moving Spout content, source replacement/resizing, browser reload, replacement-transport acknowledgment, WebGL context loss and reconnection, and unsupported-viewer refusal. Pixel checks verify straight RGB as well as alpha, and a separate draw counter confirms that normal canvas playback advances between snapshots. Screenshots, receiver statistics, publisher diagnostics and executable hashes are saved under the specified fresh output directory.

Defaults are installed Chrome, NVIDIA encoding and 1280x720 at 60 fps. Use `--browser=msedge --encoder=software --width=640 --height=360 --fps=30` for the software path, or `--width=1920 --height=1080 --fps=60` for the maximum supported packed frame. Run `e2e:ninja-plugin-alpha` and `e2e:room-alpha-ninja-plugin` separately for the native VP9-mask protocol; browser packed-alpha results do not qualify that path.

## Window compatibility capture validation

`WindowCapture` tries `PrintWindow` only after `CreateForWindow` returns `E_INVALIDARG` or the resulting item has no surface. Other WGC failures retain their original behavior. Compatibility capture is opaque, capped at 30 FPS, and restricted to the selected visible, unprotected top-level window. Child windows are rejected at startup, and reparenting stops an existing stream: full-content PrintWindow can include parent pixels, while legacy printing loses hardware-rendered video. Streaming never uses the thumbnail helper's BitBlt fallback.

One outstanding worker owns its GDI resources independently of the capture session. A stalled source cannot hold up shutdown or create an unbounded worker queue. Rendering has a one-second timeout. The capture thread checks window identity and capture exclusion before and after obtaining pixels. See Microsoft's [PrintWindow behavior](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow).

Run the complete packaged GUI on an interactive Windows desktop with Python `pywinauto`, `pywin32`, `psutil`, and `frida`, plus the project's Playwright dependency and Chrome:

```powershell
python native-qt/e2e/window-compatibility-packaged.py --publisher <released-package>/game-capture.exe --output native-qt/qa/reports/compatibility-baseline --inject-wgc-rejection --expect-failure
python native-qt/e2e/window-compatibility-packaged.py --publisher <candidate-package>/game-capture.exe --output native-qt/qa/reports/compatibility-candidate --inject-wgc-rejection
python native-qt/e2e/window-compatibility-packaged.py --publisher <candidate-package>/game-capture.exe --output native-qt/qa/reports/compatibility-child --expect-failure
```

Each output directory must be new. Injected mode changes only `CreateForWindow`'s result for the selected top-level HWND to the reported `E_INVALIDARG`. Source rendering, PrintWindow frames, encoding, WebRTC, and Chrome playback remain real. This verifies recovery from that error, without reproducing its cause on the reporter's computer. Without injection, the fixture becomes a child after selection, producing an actual Windows rejection (a zero-sized item on the reviewed host), which must fail without streaming.

The positive workflow checks moving source pixels in VDO.Ninja, resizing, prompt stop with a stalled source, restart, capture exclusion, reparenting and source closure. The restart after reparenting uses a real mouse click at the recorded Go Live position because Qt's accessibility provider can disconnect after this artificial transition. Registry settings are restored on exit. Hosted playback requires network access and receives only the selected synthetic source.

For the official extracted DVBViewer demo, append `--dvbviewer <DVBViewerDemo.exe> --media <synthetic-video.mpg>`. Use a disposable demo configuration with EVR Custom selected. Replace `--inject-wgc-rejection` with `--normal-window` to check ordinary WGC. For another prepared player, use `--player-hwnd <HWND>` instead; this restores its style and bounds and leaves it running. Receiver pixel checks require the actual moving video pattern, not merely moving player controls. These workflows do not qualify physical tuners or TV audio synchronization.

DVB Dream 3.7.2 Trial's File device needed a bitrate of `6000` for the synthetic 6 Mbps transport, instead of its default `27500`. Read-only DirectShow inspection then showed EVR rendering approximately 25 FPS without drops, but direct VMR9 and EVR window capture still failed the video-pixel checks. The player's own snapshot also contained decoded video. Direct DVB Dream capture remains unresolved; a generic capture-start fix does not guarantee access to every player's video surface.

A video relay from **DVB Dream LAN Streaming through loopback UDP, VLC, Game Capture and VDO.Ninja Chrome** passed during investigation. The [Windows guide](windows-guide.md#dvb-dream-verified-local-player-workaround) records the exact settings. It used a 1316-byte UDP buffer; the prior `18432` value did not produce usable VLC playback in that run. VLC audio was disabled, so this establishes video only. Testing a clean candidate must repeat that workflow on the candidate's actual packaged executable.

## Releases

Use the [release playbook](RELEASES.md) for the exact release checklist, including fixed asset names, signing commands, VirusTotal commands, and troubleshooting.

## Developer security and QA cost controls

[Install the local commit/push secret guards](development-security.md) in each clone.
GitHub QA workflows are manual-only on self-hosted Windows runners, with optional
one-day artifact uploads. Routine changes do not start hosted QA jobs or nightly soaks.
