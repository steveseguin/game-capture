# FFmpeg Bundle

Game Capture uses FFmpeg as an external process for VP9 alpha encoding. Windows release artifacts should include a pinned LGPL-compatible FFmpeg bundle under:

```text
native-qt/third_party/ffmpeg-win64/
```

That staged directory is generated and intentionally ignored by git.

## Refresh The Bundle

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native-qt\tools\fetch-ffmpeg-lgpl.ps1 -Force
```

The script downloads the pinned BtbN Windows `lgpl-shared` FFmpeg build, verifies the expected SHA256, verifies the upstream checksum listing, rejects GPL/nonfree configure flags, verifies `libvpx-vp9`, and writes:

- `bundle-manifest.json`
- `BUILDINFO.txt`
- `SOURCES.txt`
- `SHA256SUMS.txt`
- copied license/readme files when present

## Policy

- Do not commit the generated `ffmpeg-win64` binary directory.
- Do not add FFmpeg to PATH.
- Do not switch the pinned build to a GPL or nonfree artifact.
- Do not include libx264/libx265 software encoders in the bundled FFmpeg.
- Release packaging must fail if the bundle is missing or invalid.

Game Capture may still allow a user-supplied `--ffmpeg-path`, but that custom binary is not certified or redistributed by this project.
