# Experimental Linux ARM64 development

ARM64 support is integrated into `linux-parity`; its initial branch was
`linux-arm64`. It reuses the Qt/POSIX core,
X11/PipeWire capture, Pulse audio, V4L2 camera and FFmpeg encoder implementations.
There is no separate ARM application. The first target is **Ubuntu 24.04 arm64**
with software H.264. This is a development package, not a qualified release.

[ARM evidence and remaining work](../native-qt/qa/linux-arm64.json) are recorded
separately from the unchanged [Linux x86 ledger](../native-qt/qa/linux-parity.json).
Existing desktop/portal failures and unqualified parity requirements still apply.

The final Jetson bring-up package passed the real Qt GUI workflow under owned Xvfb:
960x540/30 software H.264, independently decoded moving video and mixed stereo
AAC, microphone mute/unmute, Stop/restart, saved settings, idle relaunch and two
clean File-menu Quits. The ARM ledger retains the exact package/source/observer
hashes and the three earlier observer failures. This bounded result does not
qualify physical desktops, devices, WebRTC or Raspberry Pi performance.

## Native build and package

On Ubuntu 24.04 arm64, install these dependencies:

```sh
sudo apt-get install build-essential cmake ninja-build git pkg-config dpkg-dev \
  qt6-base-dev qt6-wayland libavcodec-dev libavutil-dev libswscale-dev \
  libpipewire-0.3-dev libspa-0.2-dev libpulse-dev libsecret-1-dev \
  libxcb-composite0-dev libxcb-damage0-dev ffmpeg ca-certificates
cmake -S native-qt -B native-qt/build-linux-arm64 -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DVERSUS_BUILD_TESTS=ON
cmake --build native-qt/build-linux-arm64 --target game-capture test_update_checker -j 2
ctest --test-dir native-qt/build-linux-arm64 -R '^UpdateCheckerTest$' --output-on-failure
python3 native-qt/qa/package-linux-gate.py
python3 native-qt/qa/package-linux.py --build native-qt/build-linux-arm64
```

The build and isolated checks above are **gates, not application testing**. Start
with two build jobs on an 8 GB machine. The packager derives `arm64` or `amd64`
from the native Debian environment and checks the executable's ELF architecture
before using that environment's dependency resolver. It rejects cross-built or
mislabelled payloads. The DEB, extracted payload, source archive and SHA-256
manifest are written to `native-qt/dist`; existing payloads are never overwritten.

Install the resulting DEB with `sudo apt install ./path/to/package.deb`. The
package uses distribution libraries and requires FFmpeg 6.1 or newer. It is not
a portable bundle for Ubuntu 22.04/JetPack or arbitrary Raspberry Pi OS releases.
Use a 64-bit Ubuntu 24.04 userland on a Pi for this initial target.

For the additional extract-and-run archive built against Ubuntu 22.04, see
[portable Linux packaging](linux-portable.md). Its separate package-format and
distribution evidence does not replace or broaden the DEB results below.

The first development host is a Jetson Orin Nano on Ubuntu 22.04. Its CMake
3.22.1 fails the existing 3.24 minimum, Qt development libraries are absent, and
its FFmpeg 4.4 is older than the package requirement. Bring-up uses a user-owned
Ubuntu 24.04 ARM64 filesystem through Bubblewrap on the native Jetson CPU.
Host drivers and desktop/audio services are not replaced. The build path there
is `native-qt/build-linux-arm64-noble`.

## Packaged GUI/media workflow

Install the observer packages listed in
`native-qt/qa/linux-installed-desktop-packages.txt`, plus `pulseaudio`,
`pulseaudio-utils`, `ffmpeg`, and `python3-numpy`. Run as an ordinary user:

```sh
xvfb-run -a -s '-screen 0 1600x1000x24' \
  python3 native-qt/e2e/linux-private-desktop.py \
  --reports=native-qt/qa/reports/arm64-desktop --window-manager -- \
  python3 native-qt/e2e/linux-arm64-bringup.py \
  --publisher=/absolute/extracted/payload/usr/bin/game-capture \
  --manifest-sha256=EXACT_MANIFEST_SHA256 \
  --reports=native-qt/qa/reports/arm64-media
```

The workflow verifies the extracted package hashes, opens the real Qt GUI,
selects a moving window, explicitly chooses software H.264 at 960x540/30 and
mixes two stereo tone sources through a private PulseAudio server. A separate
FFmpeg process receives loopback UDP/MPEG-TS; decoded frame identities and audio
frequencies verify movement, channel mapping, microphone mute/unmute and restart.
It also checks saved settings, idle relaunch, File-menu Quit and resource cleanup.
Cleanup uses process parent/start identities (Tegra may omit `/proc` thread
children files) and requires Pulse capture streams to return to the fixture's
recorded baseline, including its remapped microphone monitor.
It uses the existing desktop/accessibility/source helpers and changes no global
defaults or existing acceptance thresholds. The fixture also accepts amd64.

Xvfb, virtual audio and loopback output do not qualify physical desktops/devices,
Wayland portal behavior, VDO.Ninja/WebRTC, performance or endurance. Camera and
GPU enumeration alone do not establish working capture or hardware encoding.

## Architecture boundaries

- Linux ARM64 update checks require an uploaded `arm64` DEB with the expected
  version/name/URL contract. amd64 checks still require `amd64`; caches from the
  other architecture are rejected. Windows and Mac selection policies are retained.
- Packaging and update sanity gates exercise both architectures. The existing
  packaged update fixtures now derive compatible/foreign names from the manifest.
- Browser workflows accept `--browser` where supported. Supply an ARM64 browser;
  the historical `/usr/bin/google-chrome` default and any amd64-only QA downloads
  are not ARM qualification. The initial workflow avoids browser downloads.
- Hardware encoding is deferred until an installed API/driver successfully
  encodes media that an independent receiver decodes. No NEON or default-profile
  changes are introduced.

The initial ARM64 and portable-package work was merged into `linux-parity`.
Full ARM parity, physical desktop/device coverage, Raspberry Pi measurements
and other-platform regressions remain work for subsequent milestones.

## Live fuzz and comparative performance workflows

The packaged WebRTC workflow also accepts `--fuzz-seed=2601019` and
`--performance-seconds=45`. Supply `--webrtc`, an ARM Chromium executable with
`--browser`, and Node with `--node`; Playwright must be available on `NODE_PATH`.
Use `--resolution=1280x720 --source-size=1280x720` for the recorded comparison.
These options extend the ordinary-user private-desktop command above and launch
the portable package through its verified `AppRun` launcher.

Fuzzing reuses the existing seeded Mac local-control corpus and Windows framing,
capacity, deadline and recovery cases. Three consecutive seeds generate 384
fragmented malformed/authentication/health requests. Additional cases cover
invalid lengths and headers, a pipelined Quit that must never execute, 48 held
connections against the 32-connection limit, trickled requests against the
absolute ten-second deadline, and 128 requests in batches of eight. Traffic is
restricted to this run's owned loopback publisher. It records seeds, corpus
source hashes and request outcomes without tokens or response bodies.

The independent browser decodes moving identities and mixed audio during the
stress, then the GUI exercises microphone mute/unmute, viewer reconnection,
Stop/restart, persisted settings and Quit. This is bounded application testing;
the corpus is not a coverage-guided fuzzer or proof of parser safety. Syntax,
build and isolated corpus checks remain gates only.

Performance observation uses `MediaStreamTrackProcessor` decoded frames and
publisher `/proc` CPU/RSS samples. One fully occupied core is 100% CPU. Compare
the same profile, source size, userland and observation duration, without
concurrent builds or other workflows. Preserve the baseline package and repeat
it after the candidate to check run-order effects. The simple 30 fps barcode,
owned Xvfb display and same-host browser do not establish game throughput,
physical-display latency, calibrated A/V sync or a 60 fps qualification.

Exact artifacts, measurements, failures and a requirement-by-requirement Windows
comparison are in the [fuzz/performance/parity ledger](../native-qt/qa/linux-arm-fuzz-performance.json).
On this Jetson, two 45-second observations per package in baseline/candidate/
baseline/candidate order reduced mean publisher CPU from 169.0% to 147.0%
(13.0%) by caching the writable X11 image-row pointer once per row. Decoded
rates were 29.75 fps for the baseline and 29.55–29.71 fps for the candidate;
the corpus and GUI/media workflows passed. These are scoped measurements, not
a new acceptance threshold. The ledger separately identifies the final package
that also preserves upstream Stop-time allocator trimming and its ARM reruns.
The observer records publisher RSS before and after each GUI Stop.

## Windows feature alignment

The audit compares the native Qt implementation with the Windows code in
`origin/main`, the Windows guide and all 23 required Linux parity rows. An
ancestor check establishes shared source history; it does not establish runtime
parity. Linux implementation evidence and ARM workflow evidence are separate.

| Area | Linux/ARM difference or remaining work |
| --- | --- |
| Window and camera capture | Linux reuses X11/PipeWire and V4L2. ARM has owned-X11 moving-media evidence; physical Wayland and moving HDMI input remain unqualified. |
| Spout2 and transparency | Spout2 is Windows-only. Linux desktop capture is opaque; a transparent Linux producer and an independently verified OBS alpha receiver remain missing. |
| Hardware encoding | Windows offers NVENC, Quick Sync and AMF. Linux exposes NVENC and software; QSV/AMF/VAAPI/V4L2 hardware paths are not implemented here. amd64 NVENC evidence does not qualify Jetson or Pi encoding. |
| Audio | Shared mixing, mute and codec controls exist. Linux application audio uses playback-stream monitors; native-client route-move stalls, a received PCM continuity failure and physical ARM devices remain open. Per-JACK-client isolation is unqualified. |
| Rooms and outputs | Shared VDO.Ninja rooms, director controls, WHIP and mux outputs exist. ARM has bounded direct WebRTC and UDP evidence; amd64 evidence for other protocols does not qualify ARM. |
| Settings and lifecycle | ARM exercises persistence, idle relaunch, Stop/restart and Quit. Earlier intermittent first-save external URL loss remains unresolved. Windows/macOS regression workflows still require those systems. |
| Packaging and updates | ARM/amd64 assets are separated. Portable Ubuntu 22.04/24.04 userland results share one Jetson kernel; Pi and other distributions need qualification. |
| Crash diagnostics | Windows has minidumps. Linux has bounded logs and issue export, without equivalent in-app crash dump collection. |

The Windows guide also mentions Desktop Studio, mixer and independent recording.
Those controls are absent from the audited native Qt source on both this branch
and its Windows/main baseline. They are a documentation/scope discrepancy, not
evidence of implemented ARM functionality. The guide's 192 kbps audio default
also differs from the shared source's 128 kbps default on both platforms; it is
not an ARM-only setting change. No parity requirement is waived and
no overall percentage is inferred from the number of shared source files.

## Physical USB capture on ARM64

[Camera evidence](../native-qt/qa/linux-arm-camera.json) records the separate
physical-device milestone and retains failures. The connected MacroSilicon
534d:2109 adapter supplies MJPEG at 1080p/30, but raw YUYV at that size is limited
to 5 fps (720p YUYV is limited to 10 fps). The previous format preference chose
raw video and the packaged app captured only about 5 fps, even though its
encoded stream advertised 30 fps.

Linux format selection now checks the driver's frame intervals for each format
at the negotiated size. It preserves the closest resolution, prefers modes
that meet the requested frame rate, and retains raw video for equal or
unknown-rate ties. Fractional 29.97 fps counts as meeting a 30 fps
request. MJPEG is considered only when its decoder is available; the actual
negotiated interval is logged and known shortfalls produce a warning. This
reuses the V4L2 backend on both ARM and amd64. Windows and Mac are unaffected.
See the [V4L2 interval contract](https://docs.kernel.org/userspace-api/media/v4l/vidioc-enum-frameintervals.html).

The packaged physical-device observer is `e2e/linux-camera-device.py`. Run it
under `e2e/linux-private-desktop.py` with the package executable and exact
manifest hash, plus `--camera-label='UVC Camera'` and optionally
`--audio-label='2109 Analog Stereo'`. `--camera-resolution=1280x720` selects a
smaller camera profile; the default exercises the app's 1920x1080/30 camera
settings. It independently receives/decodes software H.264 and AAC, measures
actual captured frames, checks rejection while an owned FFmpeg process uses
the camera, verifies that owner's continued reception, then retries, restarts,
quits and relaunches with saved settings. It also verifies camera FD and output
helper retirement. The existing empty-camera observer accepts portable archives.

The current physical HDMI input is black and silent. Successful transport,
capture cadence and lifecycle results do not qualify moving HDMI content,
color accuracy, audible input, A/V synchronization or sustained performance.
The separate moving-window and mixed-tone workflow remains the content oracle;
it accepts `--resolution=1280x720` to exercise the ARM first-run window profile.

The first camera milestone artifact is
`game-capture-0.2.65~linux.2-arm64-8769adb956b6-d16a9b442b76-portable.tar.gz`
in `native-qt/dist/`, built from commit
`230ab696d2d78eef61c18898f35da58d143b09e0`. Its SHA-256 is
`b4ecc75941472bc328acf53b79fcbfd79c942796ca023423adecbb4521436caf`.
Extract it and run `./AppRun`.

The final archive passed physical-camera GUI/lifecycle workflows at 1080p/30
on the Ubuntu 22.04 Jetson host and at 720p/30 in Ubuntu 24.04 userland on the
same CPU/kernel. Actual captured cadence was about 30 fps in all six received
phases. A separate owner continued decoding during rejected busy-camera starts;
explicit retry, Stop/restart, saved settings, Quit, camera FD and output helper
retirement passed. The no-camera workflow also passed with nodes masked only
inside the application's owned namespace.

The same archive also passed the 1280x720/30 moving-window workflow on both
userlands: mixed, muted, unmuted and restarted media were independently decoded,
with source identities and stereo tone frequencies checked. Settings, idle
relaunch, File-menu Quit, capture/audio/helper cleanup and bundled-library use
passed. This establishes bounded regression coverage alongside the physical
adapter's black/silent-input results.

One earlier same-archive run lost its saved output URL on relaunch; the cause
remains unexplained and the failure is retained. The subsequent camera run,
all 15 output-profile storage scenarios (including locked, missing, corrupt,
unavailable and stalled stores), and three additional fresh-settings save/
relaunch cycles passed. These later passes do not erase the initial failure.
The observer now preserves application logs before relaunch, and counts decoded
frames from the independent camera owner instead of parsing FFmpeg's
version-dependent console progress. Production sources still match the archive;
later commits update observers, documentation and evidence only.

## Linux recovery and diagnostics

The next development package preserves Linux diagnostic logs across restarts:
`game-capture-debug.log` rotates on launch or at 5 MiB, with up to three backups
(`game-capture-debug.1.log` through `.3.log`). The existing per-publisher lock
still separates concurrent instances. Windows and Mac logging are unchanged.
Password-store failures log fixed operation, stage and reason categories,
without destination URLs, credentials, item references or server error text.
Storage deadlines and preservation rules remain unchanged. This improves
diagnosis of the unresolved intermittent first-save failure; it does not claim
to fix its cause.

Add `--failure-recovery --resolution=1280x720` to the packaged moving-window
workflow to exercise an abruptly killed output helper, Stop with a frozen
helper, source-window loss and explicit replacement. Each recovered stream
is independently received and decoded for moving video and mixed audio.
The physical-camera workflow also accepts `--camera-resolution=640x480` to
exercise this adapter's raw YUYV mode at 30 fps.

Run `e2e/linux-output-profiles.py` with `--expect-failure-diagnostics` to verify
actual GUI saves/relaunches, preserved log history, classified storage errors
and credential exclusion using a private GNOME keyring. Clearing its default
alias still permits saving through the provider's collection lookup; that
scenario does not simulate an absent collection. The portable packager now
hashes the copied source snapshot, so edits during packaging cannot make the
source archive disagree with its recorded tree hash.

Exact package hashes, workflow results and retained failures are recorded in
[the ARM recovery ledger](../native-qt/qa/linux-arm-robustness.json). These bounded
X11/private-audio workflows do not qualify physical Wayland, other keyrings,
live HDMI content, other boards or sustained performance.

The combined development artifact is
`game-capture-0.2.65~linux.2-arm64-f43f75191068-1c549f92f9bf-portable.tar.gz`
in `native-qt/dist/`; extract it and run `./AppRun`. SHA-256:
`b7ff6be60824f01840c5873c41d6fd0d5caa425178f58519fdec4dab8b51be0d`.
It includes the intervening `linux-parity` native PipeWire audio change from
`f761c66`, whose existing Linux evidence is preserved. The source archive records
the exact production and observer sources; the later evidence ledger and final
documentation are in the repository.

## ARM browser reception and sustained operation

The same packaged moving-window workflow can receive VDO.Ninja WebRTC in a
native ARM Chromium browser. It uses the shipped `AppRun`, real GUI controls,
an isolated X11 desktop/keyring, a private PulseAudio server, the existing
moving barcode source and the shared browser media observer. The receiver has
its own private output sink to prevent audio feedback into the captured system
output. No host desktop or audio service is replaced or restarted.

Install Node and Playwright in a user-owned tools directory. The recorded
receiver uses Node 22.23.3, Playwright 1.64.1 and its native ARM64 Chromium
156.0.8078.4. For example, with Node on `PATH`:

```bash
npm install --prefix .tools/webrtc --save-exact playwright@1.64.1
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tools/webrtc/browsers" \
  node .tools/webrtc/node_modules/playwright/cli.js install chromium
```

Set `bundle` to the extracted portable package and obtain `manifest_sha256`
from the independently recorded package metadata. Run as an ordinary user
with Xvfb, xfwm4, GNOME keyring, Python GI/AT-SPI/Tk/Pillow/NumPy, PulseAudio,
FFmpeg and the browser's system libraries available:

```bash
NODE_PATH="$PWD/.tools/webrtc/node_modules" \
  xvfb-run -a -s '-screen 0 1600x1000x24' \
  python3 native-qt/e2e/linux-private-desktop.py \
    --reports=native-qt/qa/reports/arm-webrtc-desktop --window-manager -- \
  python3 native-qt/e2e/linux-arm64-bringup.py \
    --publisher="$bundle/usr/bin/game-capture" \
    --manifest-sha256="$manifest_sha256" \
    --reports=native-qt/qa/reports/arm-webrtc \
    --webrtc --browser="$PWD/.tools/webrtc/browsers/chromium-1248/chrome-linux-arm64/chrome" \
    --endurance-seconds=1800
```

An explicit `--node=/path/to/node` is supported. Omit `--endurance-seconds`
for a bounded workflow before a long run. The default remains loopback
UDP/MPEG-TS when `--webrtc` is absent. WebRTC and `--failure-recovery` are
separate workflows because the latter exercises an external-output helper.

The WebRTC workflow checks decoded moving H.264 identities, left/right system
tones, the microphone tone, microphone mute/unmute, a fresh viewer connection,
GUI Stop/restart, saved settings and idle relaunch/quit. A sustained run also
records receiver statistics and publisher memory every five seconds, watches
presentation progress continuously, and checks decoded content/audio about
once per minute. Its 960x540/30 software profile is explicit and changes no
application defaults or existing acceptance thresholds. Constant tones do not
establish calibrated A/V synchronization, and sampled content checks do not
qualify every frame's identity or high-motion performance.

Exact artifact and observer hashes, completed workflows, memory/reception
measurements and retained fixture failures are recorded in
[the ARM WebRTC ledger](../native-qt/qa/linux-arm-webrtc.json). The thirty-minute
run uses the combined development artifact above; later packages have their
own explicitly recorded coverage. Browser
reconnection here means closing and reopening the receiving page; recovery of
an existing viewer across publisher restart and actual network outages remain
separate qualification work.

On the Jetson, the combined `f43f75191068-1c549f92f9bf` artifact completed
1,808 seconds of sustained WebRTC reception: 27 decoded-content/audio checks,
53,095 received H.264 frames, and zero browser-reported lost packets, dropped
video frames, freezes or concealed audio samples. App RSS rose from 138.2 to
147.3 MiB, then stayed at 147.3 MiB for the final eighteen minutes. GUI
Stop/restart, saved settings, idle relaunch and cleanup passed afterward.
These measurements establish this bounded run, not leak-free operation or
calibrated A/V synchronization. Its Ubuntu 24.04 bounded WebRTC workflow and
Ubuntu 22.04 UDP regression also passed.

The newer local development archive is
`game-capture-0.2.65~linux.2-arm64-e714e839d693-113aa0211add-portable.tar.gz`
in `native-qt/dist/`. Extract it and run `./AppRun`. SHA-256:
`4c75e785b985a7b9ae3993c1c5367ea0ccb76c763dd65c6c36c141129ecadae6`.
It preserves upstream work through `e22b0b7`, including the Wayland cursor
exclusion change. This exact archive passed all five bounded WebRTC media
phases, saved-settings relaunch and cleanup on both Ubuntu userlands. The
thirty-minute run was not repeated on this successor; native Wayland remains
unqualified on this ARM machine. The source archive contains its exact build
sources and observers; final documentation and evidence are recorded afterward.
