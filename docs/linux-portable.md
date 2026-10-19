# Experimental portable Linux package

The portable archive reuses the Linux application and backends. It bundles Qt,
FFmpeg and their application libraries, builds on the Ubuntu 22.04 / glibc 2.35
baseline, and runs with the host's desktop, audio services and GPU drivers. It
does not install packages, require FUSE, or replace system libraries. Extract
the entire `*-portable.tar.gz` archive and run `./AppRun` inside its directory.
Keep all files together; copying just the executable is not supported.

[Portable evidence and retained failures](../native-qt/qa/linux-portable.json)
are recorded separately from the existing Linux and ARM64 DEB ledgers.

The archive is an additional development artifact; the existing Ubuntu 24.04
DEB remains distribution-dependent. `VERSUS_LINUX_PORTABLE` defaults to `OFF`,
so ordinary Linux, Windows and Mac builds retain their update policy. Portable
builds accept only matching-architecture portable archives. DEB builds accept
only matching-architecture DEBs. Neither accepts a source archive as an update.
The application opens the existing Releases page; it does not install updates.

## Verified ARM64 development archive

The same archive passed packaged GUI/media and update workflows in both rows:

| Environment | Media workflow | Update/cache workflow |
| --- | --- | --- |
| Ubuntu 22.04.5 Jetson host, relocated into a path containing spaces | Passed all four phases | Passed all ten cases |
| Ubuntu 24.04.5 ARM64 userland on the same CPU/kernel | Passed all four phases | Passed all ten cases |

Artifact: `game-capture-0.2.65~linux.2-arm64-fbe38782f547-0f4c374ec4e1-portable.tar.gz`
in `native-qt/dist/`. Extract the archive and run `./AppRun`.

- Archive SHA-256: `bd067965acb79c73b76a9a0bbdf53d378d2080e340070a688a9554a810dd797c`
- Manifest SHA-256: `e4b791f35b6fb6746d5d5b7c6e39430589a97c69d6ea09805a812cb66d844ae6`
- Source commit: `c2c635d1533c885c6487bb29a4d90963d9cf7061`
- Required host ABI: glibc 2.35 and GLIBCXX 3.4.30 or newer.

The media profile was software H.264, 960x540 at 30 fps / 4000 kbps, with
128 kbps stereo AAC over loopback UDP/MPEG-TS. An independent system FFmpeg
decoded moving window video and verified system/microphone mixing,
mute/unmute, stereo separation and clipping checks across four five-second
received samples, including Stop/restart. Saved settings, idle relaunch,
File-menu Quit and helper/audio cleanup passed. The observer also verified
loaded bundled Qt, media and audio libraries and the bundled FFmpeg helper.
All 204 ELF files passed separate integrity/linkage gates in both environments.

The update workflows exercised cache migration/relaunch, matching and foreign
architectures, wrong package format, untrusted URLs, public GitHub HTTPS,
warm cache, failed refresh and recovery of the cached failure state. Future
release metadata was seeded only into private settings; no update was installed.

These runs used owned Xvfb/xfwm4 desktops and virtual PulseAudio sources on the
Jetson. They establish compatibility across these two userlands, not across
different hardware, kernels or physical desktop/device combinations. The
ledger links exact reports, decoded-media hashes and preserved preview failures.
Its final results were committed after packaging; the archive contains the
earlier ledger snapshot from the source commit above. Production source files
match the packaged source archive; only this document and the evidence ledger
were updated afterward.

## Build on Ubuntu 22.04

Build natively on the desired architecture (`arm64` or `amd64`). Use an isolated
Ubuntu 22.04 VM/container or a dedicated build machine. Building on a newer
distribution and bundling its libraries does not lower the glibc requirement.

```sh
sed '/^#/d; /^$/d' native-qt/tools/linux-portable-build-packages.txt |
  xargs sudo apt-get install --no-install-recommends -y
python3 -m venv .tools/portable-cmake
.tools/portable-cmake/bin/pip install cmake==3.28.4
sh native-qt/tools/build-portable-ffmpeg.sh "$PWD/.tools/portable-ffmpeg" 2
PKG_CONFIG_PATH="$PWD/.tools/portable-ffmpeg/lib/pkgconfig" \
  .tools/portable-cmake/bin/cmake -S native-qt -B native-qt/build-linux-portable \
  -G Ninja -DCMAKE_BUILD_TYPE=Release -DVERSUS_BUILD_TESTS=ON \
  -DVERSUS_LINUX_PORTABLE=ON
.tools/portable-cmake/bin/cmake --build native-qt/build-linux-portable \
  --target game-capture test_update_checker test_platform_capabilities \
  test_audio_sample_clock test_posix_ffmpeg -j 2
python3 native-qt/qa/package-linux-portable.py \
  --build native-qt/build-linux-portable \
  --ffmpeg-prefix "$PWD/.tools/portable-ffmpeg"
```

The CMake environment is local to this checkout. FFmpeg 6.1.6 is compiled from a
SHA-256-pinned upstream archive. RIST reuses the Mac dependency pin for librist
0.2.20, since Jammy has no `librist-dev`. Their sources ship inside the archive.
Qt and the other distribution libraries retain Ubuntu package/source versions
and copyright notices in the manifest and `usr/share/doc/game-capture`.
Portable Linux explicitly permits its bundled GPL-enabled FFmpeg/libx264 build;
nonfree bundled builds are rejected by both packaging and application preflight.
The existing DEB, Windows and Mac bundle policies are retained.
The application source archive and bundled static-dependency revision records
are emitted beside the portable archive. Public release corresponding-source
assembly remains part of release preparation, as for the existing Linux DEB.

The packager checks native ELF architecture, portable build configuration, all
resolved library dependencies, and symbol-version requirements. It rejects a
glibc requirement above 2.35 or a GLIBCXX requirement above 3.4.30. It leaves the
loader, libc, libstdc++, libgcc and graphics driver stack on the host. Private
RPATHs and `qt.conf` locate bundled libraries and plugins without exporting an
application library path into host browsers launched from the UI. `AppRun`
selects the bundled PipeWire client modules/configuration and reports a clear
error for a different CPU architecture or an unsupported libc baseline.

## Qualification boundaries

Build, syntax and unit checks are **gates, not application testing**. Run the
same extracted archive through the packaged GUI workflow on each target:

```sh
xvfb-run -a -s '-screen 0 1600x1000x24' \
  python3 native-qt/e2e/linux-private-desktop.py \
  --reports=native-qt/qa/reports/portable-desktop --window-manager -- \
  python3 native-qt/e2e/linux-arm64-bringup.py \
  --publisher=/absolute/extracted/package/usr/bin/game-capture \
  --manifest-sha256=EXACT_MANIFEST_SHA256 \
  --reports=native-qt/qa/reports/portable-media
```

The observer verifies package hashes and invokes the manifest's `AppRun`, then
operates the real Qt GUI. An independent host FFmpeg receives and decodes
moving H.264 video and stereo audio. The workflow covers mixing, microphone
mute/unmute, Stop/restart, saved settings, Quit and capture/helper cleanup.
`linux-update-network.py` uses the same arguments for packaged update/cache
workflows, including foreign-architecture and wrong-package-format rejection.
Use observer packages from `native-qt/qa/linux-installed-desktop-packages.txt`,
plus FFmpeg, PulseAudio utilities/server and Python NumPy.

Qt 6.2 uses a small widget/label visibility fallback for the form-row API added
in Qt 6.4. The GUI workflow expands Audio encoding and verifies that switching
from VDO.Ninja to UDP hides the Opus row and reveals the AAC row. Older PipeWire
headers use the existing metadata IDs from `spa/param/param.h`; no capture
algorithm or backend is replaced.

X11 needs a working display and the host graphics libraries used by Qt.
Wayland window capture needs a functioning ScreenCast portal and PipeWire
service. Audio needs PulseAudio or PipeWire's PulseAudio service. Password-store
access uses the host Secret Service. Bundling clients does not supply these
desktop services. Existing backend capability handling and diagnostics remain
in use; unavailable desktop/device combinations must not be called qualified.

Raspberry Pi OS, Debian, physical Wayland/X11 sessions, hardware encoding,
WebRTC, endurance and amd64 portable execution require their own packaged
workflow evidence. A codec or protocol listed by FFmpeg is not proof of working
streaming. No global streaming defaults or acceptance thresholds are lowered.
