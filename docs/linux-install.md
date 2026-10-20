# Installing and using Game Capture on Linux

Linux packages are development builds. Use `arm64` for a 64-bit ARM system
(`uname -m` reports `aarch64`) or `amd64` for an Intel/AMD 64-bit system
(`x86_64`). An ARM package does not imply hardware encoding support.

## Choose a package

| Package | Intended environment | Installation |
| --- | --- | --- |
| Ubuntu DEB | Ubuntu 24.04, matching architecture and distribution libraries | `sudo apt install ./game-capture-*.deb` using the exact downloaded filename |
| Portable archive | glibc 2.35 / GLIBCXX 3.4.30 or newer; matching architecture | Extract the complete archive and run its `AppRun` |

The portable ARM package has bounded X11 GUI/media evidence on Ubuntu 22.04
Jetson and Ubuntu 24.04 userland on that same machine. Other distributions,
physical Wayland desktops, Raspberry Pi and GPU drivers need their own
qualification. Alpine/musl and 32-bit ARM are outside this package contract.
See [recorded evidence](linux-arm64.md), rather than assuming that a compatible
libc means every desktop/device workflow has passed.

For a portable upgrade, quit the app, extract the new archive into a separate
directory, then run the new `AppRun`. Keep the old directory for rollback.
For a DEB upgrade, quit and install the new DEB with `apt install`. To remove it,
use `sudo apt remove game-capture`. Preferences and password-store entries are
retained; use File → Reset to Defaults to explicitly clear them first.
Updates open the Releases page. Choose the same architecture and package type.
No package upgrades drivers or restarts the desktop/audio service.

## Capture controls

Select **Window / Desktop**, then a window, monitor or **Entire desktop**.
On Wayland, select the window or monitor entry and complete the desktop chooser.
Preview uses the same permission session as Go Live. Stop releases capture.

Advanced settings provide **Show cursor**, four **Crop** margins in source
pixels, and **Remember Wayland source**. Crop is applied before output scaling;
a crop that removes the source is rejected. Camera capture is unaffected.
Remembering is optional, requires desktop support and may still prompt when a
source or permission changes. Turn it off to forget saved restore tokens.

**Enable global shortcuts** registers Ctrl+Shift+F8 for Start/Stop,
Ctrl+Shift+F9 for microphone mute, and Ctrl+Shift+F10 for hold-to-talk.
Releasing hold-to-talk mutes the microphone. X11 reports conflicting grabs;
Wayland asks the desktop to bind the actions and displays the actual granted
shortcuts. Denial or an unavailable portal leaves ordinary GUI controls usable.

Choose **Reconnect selected audio** to reopen the configured audio inputs while
video stays live. Reconnect the device first. Explicit devices stay selected;
when a default device was selected, this action opens the current default.
Changing to a different source still requires Stop and selecting it explicitly.
Selected-app audio monitors are recreated when that playback stream moves to
another output. A stalled app or audio service may still require repair outside
Game Capture; it is reported instead of being treated as healthy capture.

## Encoders and troubleshooting

Start with Software H.264. VAAPI (Intel/AMD) and V4L2 M2M are experimental,
explicit selections: a missing driver/device fails instead of silently using
software. VAAPI supports H.264/HEVC; V4L2 M2M currently supports H.264.
`GAME_CAPTURE_VAAPI_DEVICE=/dev/dri/renderD129` selects a particular render node.
The CLI accepts `--video-encoder=vaapi` or `--video-encoder=v4l2`.
An FFmpeg encoder listing or successful initialization is not proof that a GPU
can publish usable media; verify the received stream on the target machine.

For Wayland, the desktop must provide its ScreenCast portal and PipeWire.
Audio requires a PulseAudio-compatible service, including PipeWire-Pulse.
Destination persistence uses an unlocked Secret Service password store.
If saving fails, the app shows a warning and preserves the prior saved entry.
Use Help → Open Log Folder when reporting a problem, together with the exact
package, distro, desktop/session, source and encoder. Remove private information
before sharing logs. A covered window can still stop producing frames on some
compositors; try monitor capture and retain the original failure in any report.

[Build portable packages](linux-portable.md) · [Build native ARM64 packages](linux-arm64.md)
