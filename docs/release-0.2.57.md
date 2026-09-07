## Game Capture 0.2.57

Maintenance release following the native OBS encoder/settings review. Application media behavior is unchanged from 0.2.56; this release updates version metadata and includes improved validation tooling and documentation.

- Add a reproducible 24-case native OBS settings/capability matrix, including Spout transparency, room playback, audio recordings, high frame rates, and codec compatibility.
- Correct startup transparency sampling, resolution-dependent motion analysis, audio fixture startup, and restoration of the original OBS recording directory after multiple recordings.
- Preserve OBS application logs and executable identities with the recorded evidence.

Known limitations from the 0.2.56 review remain: explicit NVENC/QSV can fall below 30 FPS at 4K; Auto/H.264 passed 4K30 on the reviewed host. OBS plugin v1.1.68's native receiver supports H.264 and VP9, not HEVC/AV1. These are not claimed fixed in 0.2.57.

Windows downloads include the installer, portable executable, ZIP package, and FFmpeg source/build information, with stable download aliases.

The exact Windows package passed end-to-end browser playback, recovery, controls, native OBS room alpha, and Spout opaque/50% transparency workflows with OBS plugin v1.1.68. Two 30-minute soaks passed: 307 room cycles and 100 browser iterations, all on their first attempt. AMD hardware was unavailable. The prior 24-case encoder/settings review used v0.2.56; it was not repeated in full for this maintenance release.
