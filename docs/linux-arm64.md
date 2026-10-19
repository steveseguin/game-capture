# Experimental Linux ARM64 development

The `linux-arm64` branch starts from `linux-parity` and reuses its Qt/POSIX core,
X11/PipeWire capture, Pulse audio, V4L2 camera and FFmpeg encoder implementations.
There is no separate ARM application. The first target is **Ubuntu 24.04 arm64**
with software H.264. This is a development package, not a qualified release.

[ARM evidence and remaining work](../native-qt/qa/linux-arm64.json) are recorded
separately from the unchanged [Linux x86 ledger](../native-qt/qa/linux-parity.json).
Existing desktop/portal failures and unqualified parity requirements still apply.

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

Changes should be reviewed in a draft PR into `linux-parity`. Do not merge or
publish releases as part of bring-up. Full ARM parity, physical desktop/device
coverage, Raspberry Pi measurements and other-platform regressions remain work
for subsequent milestones.
