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

## Linux packaged input workflows

Build and package with `cmake --build native-qt/build-linux --target game-capture`
and `python3 native-qt/qa/package-linux.py --build native-qt/build-linux`. Use the
payload path and manifest SHA-256 printed by that packaging invocation. Each
workflow checks the entire payload and retains its own harness snapshot. Build,
syntax and compiled logic checks are gates; application testing requires these
real capture/publish/receive workflows.

The owned desktop fixtures need the Ubuntu desktop/accessibility tools already
used by the Linux workflows. Additional dependencies for the input matrix are
`bubblewrap`, `python3-numpy`, `python3-gi-cairo` and, for JACK, `pipewire-jack`.
They use private session buses and audio servers. The Wayland fixture defaults
to verified Mesa software rendering: its mount namespace hides DRM devices,
while NVIDIA CUDA/NVENC devices remain accessible. `--renderer=auto` exercises
the host-selected headless renderer and has a different qualification scope.

`native-qt/e2e/linux-input-publish.py` takes `--publisher`,
`--manifest-sha256`, `--reports`, `--backend=x11|wayland` and optionally
`--encoder=nvenc`. It drives the actual GUI and independently decodes local
UDP/MPEG-TS. Its native GTK source covers moving/static pictures, resize,
late reception and Stop/restart. Add `--camera-id=v4l2:/dev/videoN` and the exact
`--camera-label` for a camera workflow with a real preview. Camera recordings
and screenshots stay in the private ignored report directory; uncontrolled
camera scenes do not establish frame cadence or optical motion fidelity.

Add `--restart-cycles=10` to repeat GUI Go live, fresh portal selection where
needed, independently decoded reception and Stop ten times in one publisher
process. The harness retains stopped-process RSS, thread and file-descriptor
counts after each cycle. This is a bounded lifecycle observation; uncontrolled
camera images still do not qualify optical frame cadence.
Use `--max-stopped-rss-growth-mib=32` to require that peak stopped RSS stays
within 32 MiB of the first restart after the initial workflow has warmed up.
Each cycle also retains a hashed `/proc` memory-accounting snapshot. This bound
checks the measured restart scenario; it is not a general memory-leak proof.

For a glibc allocator investigation, build the optional helper with
`cc -shared -fPIC -O2 -Wall -Wextra -Werror -pthread native-qt/qa/linux-allocator-probe.c -o /tmp/linux-allocator-probe.so`
and pass `--allocator-probe=/tmp/linux-allocator-probe.so` to the GUI workflow.
It preloads only into the owned publisher and samples allocator accounting after
capture stops. `--allocator-trim` additionally requests one `malloc_trim(0)`
after the final stopped cycle and records before/after RSS and allocator fields.
The harness marks these runs `diagnosticOnly`; an extra observer thread and
explicit heap trimming are not ordinary release behavior. The helper is never
linked into or shipped with the application. Field meanings follow the
[glibc allocator statistics documentation](https://sourceware.org/glibc/manual/latest/html_node/Statistics-of-Malloc.html).

`linux-av-sync.js` accepts `--encoder=software|nvenc` (default software),
`--seconds=60 --hold-seconds=480` for ten minutes of 720p60 capture, and optional
`--control-pressure-seed=20261019`. Run it inside the private X11 desktop and
private audio wrappers above. It verifies the selected active H.264 encoder,
decoded identities/cadence, continuous stereo PCM, and paired source/receiver
A/V recordings. Each interval records publisher CPU time from `/proc`, RSS,
threads and file descriptors. CPU 100% means one logical CPU; browser,
compositor and device memory are outside these process measurements.

The 2026-10-19 x86-64 packaged comparison passed both ten-minute workflows
and their live pressure phases at 1280x720/60, H.264 4 Mbps and stereo Opus.
Publisher median CPU was 1.20 logical cores for x264 and 0.94 for the GTX 750 Ti's
NVENC; peak RSS was 125.4 MiB and 187.3 MiB respectively. All 240 five-second
intervals passed, with minimum source-identity delivery above 99.66%, clean
continuous PCM and passing paired-recording A/V analysis. Thread and descriptor
counts stayed constant. These are sequential same-host X11 fixture measurements,
not isolated encoder efficiency or a demanding-game benchmark. Exact artifacts,
resource ranges and timing evidence are bound in
`native-qt/qa/linux-parity.json` under `linux_performance_validation_checkpoint`.
Ten minutes does not qualify the analyzer's thirty-minute drift requirement.

Repeated GUI capture exposed a separate teardown issue: after twenty restarts,
stopped RSS reached 329.3 MiB with NVENC and 288.1 MiB with software. An opt-in
allocator diagnostic found mostly freed arena memory; a single trim returned
90.4 MiB resident memory in 9.15 ms. Linux/glibc now calls `malloc_trim(0)` after
capture workers, encoders and frame queues retire. It never trims in the frame
or resize path. Other libc implementations omit this call.

The new uninstrumented DEB passed twenty restarts per encoder, including native
Wayland portal selection, decoded moving/static/resized/late/restarted output,
Stop and Quit. Final stopped RSS was 171.7 MiB for NVENC and 181.9 MiB for
software; peak growth above the first restart was 13.5 and 27.3 MiB, both within
the explicit 32 MiB scenario limit. This reduces retained-memory growth; it is
not proof against every leak, longer run, different compositor or ARM runtime.
Baseline and corrected-package evidence remain separate in the ledger.

Corrected-package validation also retains two unresolved audio failures. The
first NVENC A/V run failed one 100 ms received PCM channel-separation window;
video, native counters and paired-recording A/V timing passed. Saved PCM shows
a tone-phase discontinuity without an increase in receiver loss/concealment
counters. The native PipeWire GUI route workflow stalled on output move 13:
source-writer progress froze, and independent owned-output recordings lacked
the selected tones both before and after publisher Quit. Unrelated playback
continued. Owned-server cleanup retired all processes despite the fixture's
blocked-writer error. These findings do not identify the initiating cause, and
successful video/memory workflows do not waive either audio failure.
The exact-package NVENC repeat passed all 36 five-second intervals and its A/V
analysis with unchanged thresholds; both attempts remain recorded. Fresh
three-minute software and NVENC-repeat runs used median publisher CPU of 1.22
and 0.92 logical cores, with peak RSS of 125.6 and 183.4 MiB. Both passed live
control pressure. These shorter corrected-package runs do not replace longer
endurance or resolve the retained audio failures.

The optional pressure phase reuses the Mac loopback control helpers: three
128-request seeded batches, invalid HTTP framing, incomplete-client deadlines,
48 simultaneous connections and pipeline/recovery checks. Audio/video are
observed continuously during that separate thirty-second phase; normal API
polling resumes after pressure ends. The performance baseline then starts a
fresh audio observer. Thresholds remain unchanged. This bounded fuzz campaign
does not establish exhaustive parser safety, physical latency, gameplay
performance, other compositors or ARM behavior.

For the owned Wayland window workflow, `--expected-cursor=excluded` adds a
controlled native cursor and a desktop screenshot that proves it is present.
Decoded video must omit that cursor during moving/static pictures, late
reception and Stop/restart. This mode keeps the source maximized and does not
qualify resizing. `--expected-cursor=included` is the positive control for an
older package that requests an embedded cursor.

For X11, run it under `xvfb-run -a -s '-screen 0 1600x1000x24'`, then
`linux-private-desktop.py --window-manager --reports=... --`. For Wayland,
nest `linux-owned-wayland-desktop.py --reports=... --`, then
`linux-wayland-desktop.py --reports=... --`. All scripts are in `native-qt/e2e`.

The existing `linux-audio-publish.js` additionally accepts
`--app-playback-backend=pipewire --matrix=apps` for native playback children,
stream recreation, routing and exclusion; `--matrix=apps-gui` covers discovery,
explicit selection and stale-instance reselection. Use
`--app-playback-backend=jack --matrix=routes --case=system` for actual JACK API
playback through PipeWire into system-output capture. Direct JACK DSP application
capture remains unsupported. Nest `linux-private-audio.py --reports=... --`
inside the X11 desktop wrapper to avoid host audio changes. Audio diagnostics
can be retained with `--capture-audio-diagnostics=true`; timing metadata does
not qualify endurance or calibrated A/V timing. Explicit app workflows accept
`--app-output-moves=20` to alternate the selected playback between two owned
outputs twenty times, checking decoded stereo and unrelated-app exclusion after
each move. This exercises route recovery independently of the continuous-audio
diagnostic.

On a failed native GUI output move, audio diagnostics also retain the owned
PipeWire graph, source-writer progress and separate two-second recordings of
the owned destination before and after Game Capture exits. Recording runs
asynchronously so unrelated fixture playback keeps running. Add
`--capture-native-source=true` to retain the native client's stream-state log
and verbose buffer/clock diagnostics. This compares source-output audio with
the app's monitor input and checks whether stopping capture restores playback.
These private recordings do not establish continuous timing or physical audio
quality; a failed receiver check still fails the workflow.

`linux-pipewire-route-diagnostic.py --reports=...` runs native playback and
twenty output moves without Game Capture under the private desktop/audio
wrappers. It checks independent owned-output PCM and retains a graph snapshot
on failure. Add `--direct-monitor` for a standalone `parec` stream-specific
monitor alongside playback. `--busy-outputs` adds unrelated 2 kHz playback on
both owned sinks and a virtual input; the independent recording checks the
native source's distinct 440/880 Hz tones. These are source/audio-graph diagnostics, not
application testing; a passing diagnostic does not waive an application failure.

For browser visibility comparisons, `linux-window-publish.js` accepts
`--foreground-source=true --capture-diagnostics=true` inside the owned Wayland
GUI wrapper. `--source-browser=/path/to/chrome` changes only the source browser.
Add `--occlusion-diagnostic=true` to maximize the owned app over the source,
check received identities after twenty seconds of coverage, uncover it and
check recovery. Native accessibility state, window bounds and screenshots
verify coverage; browser `document.hasFocus()` alone is insufficient under
automation. A failed covered phase remains a failure even if recovery, resize
and restart subsequently pass.

The evidence ledger retains failures, including the reproduced Chrome/Wayland
covered-window freeze and intermittent native PipeWire output-move silence.
A passing native GTK or foreground-browser workflow does not establish that
covered browser capture is fixed. Chromium's
[Wayland tab-capture change](https://github.com/chromium/chromium/commit/de4b707490acca3612e077adaa35679231ee4b35)
documents a related frame-callback throttling mechanism; it is an investigation
lead, not a confirmed fix for external portal capture.

## Releases

Use the [release playbook](RELEASES.md) for the exact release checklist, including fixed asset names, signing commands, VirusTotal commands, and troubleshooting.

## Developer security and QA cost controls

[Install the local commit/push secret guards](development-security.md) in each clone.
GitHub QA workflows are manual-only on self-hosted Windows runners, with optional
one-day artifact uploads. Routine changes do not start hosted QA jobs or nightly soaks.
